// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/engines/default/engine/ai/simple.lua:27-38 (move_simple),
//             :68-104 (flee_simple, INCLUDING the hard sides at :84-90),
//             :135-152 (move_astar), :153-181 (move_blocked_astar),
//             :199-247 (move_complex), :251-268 (target_simple)
//             and game/modules/tome/data/resources.lua:48-61 (the air resource's AI),
//             game/modules/tome/class/interface/ActorAI.lua:669-690 (aiGridDamage),
//             :699-704 (aiGridHazard), :726-801 (aiFindSafeGrid)
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" — https://te4.org/license

/**
 * Monster behaviour: two profiles, both of which decide ONE INTENT and return.
 *
 * `decideNpcAction` does not move anything, does not roll damage and does not
 * touch the world. It answers "what would this monster like to do", and the
 * scheduler resolves that through the SAME legality checks a player's intent
 * goes through. One resolution path means a monster cannot walk through a wall
 * by taking a code path a player never takes, and it means the refund rule and
 * the movement rules are written down exactly once.
 *
 * ===========================================================================
 * PATHING IS TERRAIN-ONLY, AND THAT IS WHAT MAKES BUMP-ATTACK WORK
 * ===========================================================================
 *
 * ToME's A* tests `Map.TERRAIN` for `block_move` and never looks at actors
 * (Astar.lua:150, :156). So a monster paths straight THROUGH the tile its
 * target is standing on, walks the path, finds a body in the way, and attacks
 * it. Route planning and collision are separate questions asked at separate
 * times. Hand `findPath` an actor-aware predicate and monsters politely path
 * around their victims and never land a blow; hand it `canWalk` and bump-attack
 * falls out for free. `ctx.isPassable` is terrain-only for exactly that reason.
 *
 * The ONE exception is the elite's shoulder manoeuvre below, which deliberately
 * hands A* an actor-aware predicate because routing AROUND its own swarm is the
 * entire point of it. That is ToME's `move_blocked_astar` (ai/simple.lua:153-181),
 * and it is opt-in per creature there too.
 *
 * ===========================================================================
 * TWO METRICS, AND WHICH PROFILE USES WHICH
 * ===========================================================================
 *
 * ToME measures MOVEMENT in Chebyshev (Astar.lua — a diagonal step costs what an
 * orthogonal one does) and RANGE in `core.fov.distance`, the straight-line
 * length rounded half-up (`combatDistance`; see the header of engine/combat.ts).
 * This file keeps both, and the split is not arbitrary:
 *
 *   MOVEMENT — `approach`, `backAway` and the flanking sides are all Chebyshev
 *            steps, because a diagonal step costs what an orthogonal one does.
 *   RANGE  — every "may I attack from here?" goes through `rangeRefusal`, which
 *            is the reach-and-dead-zone half of `canAttack` itself, exported
 *            from engine/combat.ts for exactly this call. The kite band and the
 *            dead-zone step test read `combatDistance`, the same body.
 *
 * AND ONE THIRD LENGTH, WHICH IS NOT A RANGE: `canRetreat` asks whether a step
 * took a fleeing body FURTHER from its threat, and asks it of the unrounded
 * length (`euclidDistance`). Its own note says why the rounded one cannot.
 *
 * ═══ THE AI MUST ASK THE QUESTION THE LEGALITY CHECK WILL ASK ═══
 * `chase` used to test `chebyshev(self, target) <= self.attackRange` while
 * `canAttack` refused on the straight line. For the roster of the day the two
 * agreed — a husk's `attackRange` 1 against `combat.range` 1.5, and the
 * wraith's `preferredRange` 4 gating long before its `attackRange` 6 — so
 * nothing was visibly wrong. But a creature whose AI band is one tile WIDER than
 * its reach submits an attack that is refused every single turn: the intent
 * costs the turn (a monster does not get refunded), and the sweep shows a
 * `blocked` step, forever. From outside that is an AI freeze, not a range bug,
 * and nothing fails anywhere. Asking one function removes the class of bug
 * rather than the instance — and it is why the metric changed in
 * `combatDistance`'s body and not at the callers, where one missed site is that
 * freeze again.
 *
 * ===========================================================================
 * DETERMINISM
 * ===========================================================================
 *
 * Same world state plus same RNG state gives the same decisions, on any machine,
 * months later — that is what makes a save reload into the same fight.
 *
 *   - `findPath` is deterministic by construction (see its header: a total
 *     order on the open set, and no Map or Set is ever iterated).
 *   - `visibleEnemies` is ordered by `tileDistance` and then by ID, so a tie
 *     between two equidistant players resolves the same way every time rather
 *     than by whoever happens to sit earlier in a hash table. The elite's
 *     isolation scan re-sorts that list without ever consulting the stream.
 *   - Every random draw goes through the world's seeded PCG32 with a LABEL.
 *     Four are ported from upstream's AI files: the 90% target-keep (the
 *     module's `target_simple`, which replaces engine/ai/simple.lua:253 — see
 *     `acquireTarget`), the two coin flips that order the flanking sidesteps at
 *     engine/ai/simple.lua:79 and :85, and the 1-in-`talent_in` fire roll at
 *     engine/ai/talented.lua:122. The fourth is CONDITIONAL on the creature declaring a
 *     `talentIn` at all, so a monster that does not (every melee creature in the
 *     roster) consumes the stream exactly as it did before that draw existed.
 *     A fifth, `ai.air.seek` (tome/data/resources.lua:58), is conditional the
 *     same way: only a body losing air to the ground it stands on takes it, so a
 *     world without deep water draws exactly what it drew before.
 *
 * SYNCHRONOUS — src/server/ai/** carries the engine's six anti-async selectors
 * and the bans on `Date.now`/`Math.random`.
 */

import { DIR_ORDER, DIR_VECTORS, chebyshev } from '../../shared/coords.ts';
import { euclidDistance } from '../../shared/distance.ts';
import { circleGrids, fovDistance } from '../../shared/mapgen/geom.ts';
import { percent } from '../../shared/mapgen/lua.ts';
import { findPath, findPathAvoiding } from '../../shared/path.ts';
import { isWalkable } from '../../shared/protocol.ts';
import { airOf, breathes, isHazardFor } from '../../shared/terrain.ts';
import {
  AiProfile,
  HOLD_INTENT,
  IntentKind,
  countAdjacentKin,
  isHostile,
} from '../engine/actor.ts';
import { combatDistance, rangeRefusal } from '../engine/combat.ts';
import type { Dir, TileXY } from '../../shared/coords.ts';
import type { PassableFn } from '../../shared/path.ts';
import type { Rng } from '../../shared/rng.ts';
import type { EngineActor, Intent, MonsterActor } from '../engine/actor.ts';

/**
 * Everything the AI is allowed to know about the world.
 *
 * A narrow injected context rather than the `World` itself, so that ai/ imports
 * nothing from world/ and every profile below can be tested against a hand-drawn
 * five-tile map with two object literals in it.
 */
/** One talent a creature could use on a target this turn, and where to aim it. */
export type MonsterCast = {
  readonly talentId: string;
  /** The tile it is aimed at. Self-shaped talents name the caster's own. */
  readonly target: TileXY;
  /**
   * IS THIS THE CREATURE'S WAY OF CLOSING? `Talent.closesIn`, forwarded.
   *
   * ═══ ON THE OPTION RATHER THAN ASKED OF THE REGISTRY ═══
   * This file's header is explicit that the AI must not hold a `TalentEngine`:
   * that would put the registry, the sheet and the cost rules inside a module
   * whose whole value is that it can be tested against two object literals and
   * a five-tile map. `castable` already reads the registry to build these
   * options, so it carries the one bit down rather than handing over the door.
   *
   * ABSENT READS AS FALSE, which is every talent in the game but one.
   */
  readonly closesIn?: boolean;
};

export type AiCtx = {
  /**
   * TERRAIN ONLY. Must answer false off-grid — `canWalk` already does, and A*
   * probes outside the map as a matter of course.
   */
  readonly isPassable: PassableFn;
  /** The LIVING body standing on a tile, if any. Corpses do not block. */
  readonly actorAt: (x: number, y: number) => EngineActor | undefined;
  /**
   * Hostiles this monster can see, NEAREST FIRST, ties broken by id. Visibility
   * is the caller's to define: the scheduler's is ToME's shadowcast field of
   * view out to `aggroRange` (`visibleEnemies`, engine/scheduler.ts).
   *
   * A VISIBLE TARGET IS NOT A SHOOTABLE ONE. This said it was, "which is why
   * `kite` never re-checks LOS before shooting", and it was true while sight
   * was a Chebyshev square plus the same Bresenham line `canAttack` walks. The
   * shadowcast sees from the whole tile, so it reaches cells that line cannot.
   * `lineClear` below is the other half, asked separately.
   */
  readonly visibleEnemies: (self: MonsterActor) => readonly EngineActor[];
  /**
   * THE BODY AN ID NAMES ON THIS FLOOR, IN SIGHT OR NOT. `World.getActor`.
   *
   * Undefined once the body has left the floor, which is upstream's
   * `game.level:hasEntity`. A corpse or a downed body still resolves, so the
   * caller reads `alive` itself.
   *
   * It exists for one question: may the keep roll in `acquireTarget` be taken?
   * Upstream asks it of the remembered target without asking whether it can be
   * seen, and `visibleEnemies` cannot answer it for a body out of view. Nothing
   * here reads the position of what it returns. Where an unseen target stands
   * is `lastSeen`'s business.
   *
   * REQUIRED, unlike the optional seams below. If a fixture left it out, the
   * keep roll would not be taken for an unseen target, so that fixture would
   * draw a different number of times from the game it stands in for.
   */
  readonly actorById: (id: string) => EngineActor | undefined;
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   *   IS THE LINE TO THAT BODY CLEAR FOR A SHOT? `World.lineClearFor`.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * The sight half of `canAttack` (engine/combat.ts), which refuses anything past
   * arm's length whose line is blocked. `rangeRefusal` is the band half. The AI
   * asks both, because a refused monster intent costs the turn and shows a
   * `blocked` step: from outside, a monster that stands there.
   *
   * ═══ WHY IT EXISTS: SIGHT STOPPED IMPLYING IT ═══
   * Monster sight is ToME's shadowcast (`visibleEnemies`, engine/scheduler.ts).
   * It sees from the whole tile, so a kiter standing beside a pillar sees a body
   * past it that its shot, one Bresenham line from its centre, cannot reach.
   * MEASURED on the delves, three players standing still for 120 turns on each
   * of three seeds: 433 kiter shots refused `no_los`, beside 10,191 blows struck
   * by everything on those floors. None while sight walked the shot's line.
   * Upstream's shape is the same: `dumb_talented` takes a talent only when
   * `canProject` says the shot gets there (`engine/ai/talented.lua:46-52`), and
   * otherwise the creature moves (`dumb_talented_simple`, :126-127).
   *
   * REQUIRED, for `actorById`'s reason: a fixture without it would shoot where
   * the game it stands in for steps.
   *
   * ═══ `from`: THE SAME LINE, ASKED FROM A TILE ONE STEP AWAY ═══
   * Omitted, the line runs from where `self` stands, which is the shot
   * `canAttack` will judge. Given, it runs from `from` as though `self` stood
   * there: the kite guard's sidestep asks it of each neighbouring tile before it
   * moves (`sidestep`). Nothing else about `self` changes the answer for a
   * monster, whose line is plain line of sight (`lineOfSightFor`,
   * server/view/eyesight.ts).
   */
  readonly lineClear: (self: MonsterActor, target: EngineActor, from?: TileXY) => boolean;
  /**
   * WOULD THIS MONSTER STILL SEE THAT BODY FROM `from`? The scheduler's own
   * shadowcast (`fieldOfView` out to `aggroRange`) asked from the tile.
   *
   * The sidestep's other question. A clear LINE from a neighbouring tile is not
   * enough: the review found a room where the only in-band tile with a clear
   * line put the target out of the kiter's sight, so it stepped there, lost the
   * target, walked back to `lastSeen` — the tile it had left — and did that
   * forever without firing. REQUIRED, for `actorById`'s reason.
   */
  readonly seesFrom: (self: MonsterActor, target: EngineActor, from: TileXY) => boolean;
  /** The world's seeded generator. Every draw takes a label. */
  readonly rng: Rng;
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   *   WHAT THIS CREATURE COULD CAST AT THAT BODY, RIGHT NOW. Empty for most.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * ═══ A QUESTION, NOT A HANDLE ═══
   * The obvious shape is to hand the AI the talent engine and let it work this
   * out. It is the wrong one for the reason every other field here is a
   * closure: this module knows about tiles, bodies and intents, and nothing
   * else. Giving it a `TalentEngine` would put the registry, the sheet and the
   * cooldown table into the AI's import graph to answer one question the caller
   * can already answer completely.
   *
   * ═══ IT ANSWERS ONLY WHAT WOULD ACTUALLY LAND ═══
   * Every option that comes back has passed `canUseTalent` against this target
   * on this turn — known, off cooldown, affordable, in range, in line of sight.
   * So the AI's job is WHETHER to cast rather than whether it can, and a
   * refusal can never reach the scheduler and cost the creature its turn.
   *
   * OPTIONAL, so every fixture that builds an `AiCtx` by hand keeps compiling
   * and reads as a creature that knows nothing — which is what nearly every
   * monster in the game is.
   */
  readonly castable?: (self: MonsterActor, target: EngineActor) => readonly MonsterCast[];
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   *   THE TERRAIN CODE UNDER A TILE — `shared/level.ts` `tileAt`, WALL off the grid.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * What the AI needs to know about hazards. Water that drowns this body and
   * ground that burns it are rules about the CODE and the BODY
   * (`shared/terrain.ts`), so the context hands over the code and this file asks
   * the rule with `self` in hand. That keeps the question per body without a
   * per-body context: `aiCtxFor`'s common case still allocates nothing.
   *
   * OPTIONAL, like `castable`, so a hand-drawn fixture reads as a creature that
   * knows no terrain rules: no hazard detour and no air trigger.
   */
  readonly terrainAt?: (x: number, y: number) => number;
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   *   `aiGridDamage`'S DAMAGE HALF — tome/class/interface/ActorAI.lua:681-686.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * What standing on this tile for a turn would do to this body, after its
   * resistance: `(maxdam + mindam) / 2 * (100 - resist - affinity) / 100`. The
   * numbers are the floor's resolved lava roll, which belongs to the burn
   * itself, not to the AI. So it is asked, not computed here.
   *
   * ABSENT READS AS ZERO, which is a fixture's answer: `makeAiCtx` (scheduler.ts)
   * always supplies it from `World.burnRange`.
   */
  readonly gridDamage?: (self: MonsterActor, x: number, y: number) => number;
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   *   WHERE THIS BODY'S PERSON IS — `Faction.Squad` ONLY, and nothing else.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `MonsterActor.anchorId` names the player a temporary companion is with;
   * this answers where that player is STANDING, which is the only thing the AI
   * needs and the only thing it may be trusted with. Upstream keeps the body
   * itself — `tome/class/Party.lua:68` sets `ai_state.tactic_leash_anchor` to
   * `game.player` — and ours keeps an id on the actor and resolves it here, for
   * `summonerId`'s stated reason: a held reference is a way to keep a dead
   * object alive.
   *
   * ═══ A TILE AND NOT A BODY, WHICH IS `approach`'s OWN LESSON ═══
   * That function was widened from `EngineActor` to `TileXY` when pursuit
   * arrived, because it only ever read `x`/`y`. The follow step wants the same
   * two numbers, and handing this module a live `PlayerActor` would put hp,
   * inventory and party membership inside a file whose whole value is that it
   * can be tested against two object literals and a five-tile map.
   *
   * ═══ UNDEFINED IS "NOBODY TO FOLLOW", AND IT HAS THREE CAUSES ═══
   * No anchor at all (every body in the game but a companion), an anchor who
   * has taken the stair, and an anchor who is DOWN. The third is deliberate:
   * a companion whose person is on the floor keeps swinging instead of walking
   * back to stand over them, which is the only useful thing it can do.
   *
   * OPTIONAL, like `castable`, so every hand-built fixture keeps compiling and
   * reads as a body with nobody to follow — which is what every monster in the
   * game is.
   */
  readonly anchorAt?: (self: MonsterActor) => TileXY | undefined;
};

/**
 * After a failed shoulder attempt, `ai.shoulderTurns` is driven this far
 * negative so the elite waits before re-running A* against the same wall.
 *
 * ai/simple.lua:176 — `self.ai_state.blocked_turns = -5`, upstream's own penalty
 * for an escalation that did not work. Without it a boxed-in elite pays for a
 * full actor-aware pathfind every single turn for the rest of the fight, which
 * is free with one elite on a 30x30 map and is not with eight on a 40x40 one.
 */
const SHOULDER_FAILURE_PENALTY = 5;

/**
 * Decide one monster's action.
 *
 * Never returns null: a monster with nothing useful to do HOLDS, which costs it
 * a turn. The scheduler is what decides whether that turn is actually spent —
 * out of combat it is not, and that fixed point is what lets the pump go idle
 * at ~0% CPU instead of spinning forever on monsters bracing at each other.
 */
/**
 * How often a creature that CAN cast actually does, as a percentage.
 *
 * Forty is high enough that a caster reads as a caster within a couple of
 * exchanges and low enough that it still walks, flanks and swings like the rest
 * of the bestiary. Upstream's equivalent is a weighted tactical pick rather
 * than a flat chance; a flat one is the honest version of that until there is
 * more than one talent on a creature to choose between.
 */
export const CAST_CHANCE = 40;

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * AND THE CADENCE DOES NOT APPLY TO CLOSING THE DISTANCE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `CAST_CHANCE` is the honest flat stand-in for upstream's weighted tactical
 * pick, and it is the right instrument for a talent a creature can use on ANY
 * turn of a fight: rolling for it spreads the casts out and leaves the creature
 * walking and swinging in between, which is the whole argument above.
 *
 * A CHARGE IS NOT THAT TALENT. Its window is `minRange` to `range` and both
 * bodies are closing through it, so it exists for one turn, maybe two, once per
 * fight. Measured on the Index Eidolon over eight seeded fights: Rush was legal
 * on SEVEN turns out of 287 turns of fighting. A 40% roll against a window that
 * narrow does not spread the casts out — it deletes two fights in eight.
 *
 * Upstream does not roll for it either. `CLOSEIN = 3` is three times the weight
 * of either attack term in Rush's own tactical table
 * (techniques/combat-techniques.lua:32) and `on_pre_use_ai` refuses the talent
 * outright while the target is adjacent (:41-45): the creature charges when
 * charging is what the situation is.
 *
 * ═══ 100, AND THE DRAW IS STILL TAKEN ═══
 * A threshold rather than an early return, so `ai.cast` is drawn on exactly the
 * turns it was drawn on before. Skipping the draw would have shifted the seeded
 * stream for every world containing a charger — the replay rule in CLAUDE.md is
 * about ADDING or REORDERING draws, and a threshold does neither.
 */
export const CLOSE_IN_CHANCE = 100;

export function decideNpcAction(self: MonsterActor, ctx: AiCtx): Intent {
  // DROWNING OUTRANKS THE FIGHT. See `seekAir`: above the target refresh, so a
  // turn spent heading for air draws nothing the fight would have drawn.
  const air = seekAir(self, ctx);
  if (air !== undefined) return air;

  const target = acquireTarget(self, ctx);
  if (target === undefined) {
    // No target in view — nothing seen, or a kept target out of sight (the
    // hunt below walks to it). Losing the target has to clear both counters, or
    // an elite banks blocked turns while it stands in an empty room and then
    // shoulders through the first ally it meets on the next contact — and
    // resumes a flank around a body that is no longer there.
    self.ai.blockedTurns = 0;
    self.ai.shoulderTurns = 0;
    return pursueLastSeen(self, ctx);
  }

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * IT CAN SEE YOU — REMEMBER WHERE. `engine/ActorAI.lua:130-135`.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Stamped on every turn the target is in view, which is upstream's own cadence
   * and the reason the memory is worth anything: the tile a monster walks to
   * after you break line of sight is the last one it actually saw you on, not
   * the one you were on when it first noticed you.
   */
  self.ai.lastSeen = { x: target.x, y: target.y };
  self.ai.unseenTurns = 0;

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * A TALENT FIRST, ON A CADENCE — AND ABOVE THE PROFILE, NOT INSIDE IT.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Both profiles want this and neither owns it: a husk that can throw
   * something and an eidolon that can are the same decision wearing different
   * movement. Putting it in `chase` and `kite` separately would be two copies
   * of the cadence, and the second one would drift.
   *
   * ═══ THE CADENCE IS WHAT STOPS THIS BEING A DIFFERENT GAME ═══
   * A creature that used a talent EVERY turn it could would be a creature that
   * never does anything else — upstream's own AI is a weighted pick over
   * talents and movement (`ai/tactical.lua`), not "cast if able", and a monster
   * that opens with its best thing on turn one and repeats it is both harder
   * and more boring than one that mixes.
   *
   * ONE DRAW, LABELLED, and taken ONLY when there is something to cast — this
   * is the one place a conditional draw is correct rather than dangerous,
   * because the alternative is a draw on every monster on every turn of every
   * fight in the game, which would move the stream for every world that has no
   * casters in it at all. The condition is a property of the CREATURE rather
   * than of the roll, so a given world's stream stays stable.
   */
  const options = ctx.castable?.(self, target) ?? [];
  /**
   * ═══ CLOSING BEATS THE CADENCE, AND ONLY WHILE THERE IS DISTANCE TO CLOSE ═══
   * `CLOSE_IN_CHANCE` carries the argument and the citation. The adjacency test
   * is upstream's `on_pre_use_ai` (combat-techniques.lua:41-45,
   * `distance > 1`) rather than a trust in `minRange`: the talent's own dead
   * zone already refuses a charge from touching distance, so this cannot fire
   * there — but a future closer authored WITHOUT a dead zone must not turn into
   * a guaranteed free swing at melee, and one line here is cheaper than
   * discovering that from a fight.
   */
  const closer =
    combatDistance(self, target) > 1
      ? options.find((option) => option.closesIn === true)
      : undefined;
  const chance = closer === undefined ? CAST_CHANCE : CLOSE_IN_CHANCE;
  if (options.length > 0 && ctx.rng.int('ai.cast', 0, 99) < chance) {
    // FIRST, NOT BEST — except for a closer, which is the one tactic this AI
    // knows by name. The template's order is otherwise the creature's own
    // preference, and `castable` preserves it, so an author orders the list and
    // the creature obeys it rather than the AI inventing a scoring function
    // that every future talent has to be tuned against.
    const pick = closer ?? options[0];
    if (pick !== undefined) {
      return { kind: IntentKind.Talent, talentId: pick.talentId, target: pick.target };
    }
  }

  switch (self.ai.profile) {
    case AiProfile.MeleeChaser:
      return chase(self, target, ctx);
    case AiProfile.RangedKiter:
      return kite(self, target, ctx);
  }
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * HOW FAR A COMPANION MAY BE FROM ITS PERSON BEFORE IT WALKS — AND WHY IT IS
 * THE SMALLEST NUMBER THAT IS NOT ZERO.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Two is "beside you, or one body over": a companion at 1 or 2 is standing in
 * the same doorway you are, and one at 3 has been left behind. It is the only
 * number in this pair that is OURS — `tome/class/Party.lua:69` states the
 * other one — and it is chosen against the thing it costs rather than against
 * a feeling.
 *
 * ═══ WHAT IT COSTS IS THE IDLE FIXED POINT, WHICH IS WHY IT IS BOUNDED ═══
 * `engine/scheduler.ts#actMonster` refuses every monster a turn while
 * `engagement <= 0`, and its own essay says what that buys: *"something has to
 * spend energy for the level to keep ticking, and then the server has a game
 * loop and a home PC has a fan."* A companion is the one body that has to move
 * out of a fight, or every escort is unwinnable — the party walks away and it
 * stands at the door where it was recruited.
 *
 * So the exception is bounded on BOTH sides, and both bounds are load-bearing:
 *
 *   WITHIN 2 IT SPENDS NOTHING. A party standing still with a companion beside
 *     it is a pump that returns `idle` — the fixed point, unchanged, with the
 *     companion inside it rather than exempted from it.
 *   BEYOND 2 IT TAKES ONE STEP PER PUMP. Not one per sweep: see `Run.followed`
 *     in the scheduler. The pump runs only when somebody acted, so a companion
 *     catches up while you walk and stands while you stand, and it cannot cost
 *     a tick a player did not already pay for.
 */
export const FOLLOW_LEASH = 2;

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * AND HOW FAR IT MAY BE DRAGGED BY A FIGHT — TEN, WHICH IS UPSTREAM'S.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `tome/class/Party.lua:69` is `actor.ai_state.tactic_leash = actor.ai_state.tactic_leash or 10`,
 * the default every summoned party member gets, and `shadows.lua:248` is the
 * same ten for a shadow's `summoner_range`. ToME's escort start overrides it to
 * 100 on acceptance; **we take the summon default and not the escort override**,
 * because a hundred-tile radius on a fifty-by-fifty floor is a companion in
 * another room, and the whole objective is that it is with you.
 *
 * WHAT IT DOES: a companion dragged past it by something it is chasing breaks
 * off and walks back. Without it a kiter can lead your companion across the
 * floor and the party arrives at the stair alone — the failure that reads as
 * the AI being stupid when it is the AI having no leash at all.
 */
export const COMPANION_LEASH = 10;

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A COMPANION'S TURN — the ordinary AI with two clauses around it.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `decideNpcAction` is not replaced and must not be: a companion fights with
 * the same target acquisition, the same talent cadence, the same profile and
 * the same seeded draws as anything else on the floor, because it IS one of
 * the bodies on the floor. Upstream's escortee is an ordinary NPC with an
 * `ai_state` on it, not a second AI (`tome/class/Party.lua:46-88`).
 *
 * The two clauses are both about the person it is with, and they are in this
 * order for one reason: THE LEASH OUTRANKS THE FIGHT. A body already ten tiles
 * past its person does not get to take one more swing first.
 *
 *   1. BEYOND THE LEASH → GO BACK, AND DO NOT STAY IN THE FIGHT IT IS IN. It
 *      breaks off whatever it was chasing and heads for its person; it does not
 *      walk THROUGH somebody. `approach` answers ATTACK for a hostile standing
 *      on the first node of the route home, and that is kept deliberately —
 *      MEASURED: filtering it to a move only makes the fall-through re-decide,
 *      and `decideNpcAction` swings at the same adjacent body anyway or, when
 *      it cannot see it, HOLDS. The filter buys nothing and costs a turn. The
 *      thing standing between a companion and its person is the route home, and
 *      hitting it is walking back.
 *
 *      `followStep` DOES filter, and the asymmetry is the whole reason both
 *      exist: that one runs OUT of combat, where a swing would open a fight
 *      nobody chose and spend a clock no player paid for. This one is only ever
 *      reached with `engagement > 0` — the fight is already running.
 *   2. NOTHING TO FIGHT (the AI only held) → close the distance instead of
 *      standing. Out of combat this function is not even reached — the idle
 *      gate calls `followStep` directly — so this is the IN-combat case: the
 *      party is fighting something the companion cannot see or cannot reach,
 *      and standing in the last room is not an answer.
 */
export function decideSquadAction(self: MonsterActor, ctx: AiCtx): Intent {
  const anchor = ctx.anchorAt?.(self);
  if (anchor !== undefined && combatDistance(self, anchor) > COMPANION_LEASH) {
    // `keepAway: 0` for `pursueLastSeen`'s reason: there is nothing here to
    // keep away from, and a kiter that refused to close on its own person
    // would never come back at all.
    const back = approach(self, anchor, ctx, { keepAway: 0 });
    if (back !== undefined) return back;
  }
  const intent = decideNpcAction(self, ctx);
  // HELD, WHICH IS THIS AI'S WORD FOR "NOTHING USEFUL". Asked as a kind rather
  // than by identity with `HOLD_INTENT`: `forget`, `advance` and `shoulder` all
  // return that one frozen object today, and a future hold built fresh would
  // silently stop matching.
  if (intent.kind !== IntentKind.Hold) return intent;
  return followStep(self, ctx) ?? intent;
}

/**
 * ONE STEP TOWARD THE PERSON THIS BODY IS WITH, or undefined when there is
 * nothing to do — which is most turns.
 *
 * ═══ UNDEFINED IS THE FIXED POINT AND IT HAS THREE CAUSES ═══
 * Nobody to follow, already within `FOLLOW_LEASH`, and no route. The third is
 * not a failure to report: a companion cut off by a closed door or a pack in a
 * corridor stands where it is, exactly as an ordinary monster that cannot
 * advance does, and `advance`'s own note applies — *"a monster that cannot
 * advance this turn is a chokepoint working as intended"*.
 *
 * ═══ A STEP, AND NEVER A SWING ═══
 * `approach` turns its first path node into `intentForStep`, which answers
 * ATTACK for a hostile standing on it. That is right in a fight and wrong here:
 * the idle caller's whole claim is that the level stays at its fixed point, and
 * a companion that opens a fight with something nobody had noticed spends the
 * floor's clock on a decision no player made. So anything but a move is
 * refused, and the body stands until somebody walks into an aggro radius the
 * ordinary way.
 */
export function followStep(self: MonsterActor, ctx: AiCtx): Intent | undefined {
  const anchor = ctx.anchorAt?.(self);
  if (anchor === undefined) return undefined;
  /**
   * ═══ CHEBYSHEV HERE AND `core.fov.distance` FOR THE COMBAT LEASH ═══
   * Movement is eight-way, so chebyshev IS the number of steps between two
   * tiles — and this number's whole meaning is *how many steps behind you are
   * they*. `COMPANION_LEASH` is upstream's `tactic_leash`, which upstream
   * measures with `core.fov.distance` (the `party_member` AI's leash test), and
   * `combatDistance` is that function — it was the unrounded length until the
   * range port, and this sentence said the two were one when they were not —
   * so that one keeps the metric it was chosen against. The same chebyshev is what `world/brief.ts`
   * asks at the destination — AT `FOLLOW_LEASH + 1`, and the extra tile is not
   * slack: the destination of a `leaves` escort is the way out, standing on it
   * IS leaving, so the closest a living party can hold is one tile off it and
   * this rule then holds the body one further. Read `arrivedEscort`'s header
   * before changing either number; they are one rule written in two places
   * because one of them is a position and the other is a decision.
   */
  if (chebyshev(self, anchor) <= FOLLOW_LEASH) return undefined;
  const step = approach(self, anchor, ctx, { keepAway: 0 });
  return step?.kind === IntentKind.Move ? step : undefined;
}

// ---------------------------------------------------------------------------
// Targeting — ToME's `target_simple`, tome/ai/target.lua (see `acquireTarget`)
// ---------------------------------------------------------------------------

/**
 * Pick who to attack, keeping the current target 90% of the time.
 *
 * The hysteresis is the whole point of the port and it is easy to mistake for
 * noise: without it a monster standing equidistant from two players re-picks
 * the nearest every turn, and a one-tile shuffle by either player makes it
 * oscillate on the spot instead of committing to anyone.
 *
 * ═══ WHICH UPSTREAM: THE MODULE'S, NOT THE ENGINE'S ═══
 * The engine's `target_simple` is engine/ai/simple.lua:251-268. ToME replaces
 * it by name: tome/load.lua:234-235 loads `/engine/ai/` and then `/mod/ai/`,
 * and `newAI` overwrites (engine/interface/ActorAI.lua:37-38). The live one is
 * tome/ai/target.lua lines 25-82. That file is in git but not in the sparse
 * checkout (`git -C reference/t-engine4 show HEAD:game/modules/tome/ai/target.lua`),
 * so its line numbers here are prose, not checked citations.
 *
 * ═══ THE KEEP ROLL DOES NOT ASK WHETHER THE TARGET CAN BE SEEN ═══
 * Neither version asks. The module keeps a remembered target that is not
 * dead, is still on the level, and is hostile, on `rng.percent(90)` (lines
 * 40-51). The engine's line 253 is the same test without the level check.
 * So the roll here is taken when the id resolves on this floor (`actorById`),
 * the body is `alive`, and it is `isHostile`. It is taken whether or not the
 * body is in `visibleEnemies`.
 *
 * `alive`, not a "dead" flag, because a downed detective is not a target
 * anywhere in this engine: `visibleEnemies` drops it, and it cannot be
 * damaged. ToME has no downed state: a body out of life there is dead.
 *
 * THIS USED TO REQUIRE THE TARGET TO BE IN SIGHT, and said that was Lua's
 * short-circuit. It was not. A monster whose target had stepped out of view
 * skipped a draw ToME takes, so on every such turn it drew a different number
 * of times from ToME.
 *
 * ═══ A KEPT TARGET OUT OF SIGHT IS KEPT, NOT SWAPPED ═══
 * Upstream returns it (line 49) and hunts where it thinks it is. Ours returns
 * undefined with the id left in place, and `decideNpcAction` walks to
 * `lastSeen`, as it does when nothing at all is in view. So a monster that
 * loses sight of its target does not turn on the nearest other body until the
 * roll lapses (one turn in ten) or the hunt ends — `PURSUIT_TURNS`, or
 * `forget` on arriving at the tile or finding no route to it.
 *
 * ═══ NOT PORTED ═══
 *   - The friendly arm. Line 47 keeps a target that is NOT hostile on
 *     `rng.percent(50)`. Here a non-hostile target takes no roll and is
 *     replaced. A monster only holds one after a body's faction changes under
 *     it: an escort that lands becomes Townsfolk (`world/brief.ts`).
 *   - The dead summon's summoner (lines 32-36): a monster whose target was a
 *     shadow does not turn on the shadow's caller when it dies.
 *   - `invulnerable` (line 49): nothing in this game grants it.
 *
 * WHICH target is chosen when the hysteresis lapses is the one thing an elite
 * changes, and it changes NO draws: `mostIsolated` is a pure scan of a list that
 * was already totally ordered. An elite and a husk consume the seeded stream
 * identically, so swapping one for the other in an encounter cannot shift a
 * replay.
 */
function acquireTarget(self: MonsterActor, ctx: AiCtx): EngineActor | undefined {
  const visible = ctx.visibleEnemies(self);

  const current = self.ai.targetId;
  if (current !== null) {
    const held = ctx.actorById(current);
    if (
      held !== undefined &&
      held.alive &&
      isHostile(self, held) &&
      ctx.rng.int('ai.target.keep', 1, 100) <= 90
    ) {
      // In sight: that body. Out of sight: undefined, with the id kept.
      return visible.find((actor) => actor.id === current);
    }
  }

  // `visible` is nearest-first, so the plain case is upstream's walk down
  // `fov.actors_dist` taking the closest live hostile (engine/ai/simple.lua:259-267;
  // the module's walk, tome/ai/target.lua lines 57-75, also asks what the
  // monster's senses reach).
  const chosen = self.ai.huntsIsolated ? mostIsolated(visible, ctx) : visible[0];

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * NOTHING IN SIGHT DOES NOT MEAN NOTHING TO CHASE.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * This used to write `chosen?.id ?? null` unconditionally, so the instant a
   * target stepped out of view the monster forgot WHO it had been fighting —
   * and `decideNpcAction` then had nothing left to pursue toward.
   *
   * Upstream never drops a hostile target for being out of view. A lapsed roll
   * with nobody in sight leaves it set: tome/ai/target.lua line 49 says "never
   * clear it", line 50 forgets only the local, so line 76 has nothing to clear.
   * The memory is bounded by `unseenTurns` instead. So an empty view leaves the
   * id alone and the caller decides whether to hunt or to give up.
   */
  if (chosen === undefined) return undefined;
  self.ai.targetId = chosen.id;
  return chosen;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ELITE BEHAVIOUR 1 — IT GOES FOR WHOEVER IS STANDING ALONE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * NOT A ToME PORT. ToME's targeting is strictly nearest-first
 * (engine/ai/simple.lua:259-267) because ToME is a single-player game and "nearest" and
 * "you" are the same actor. This is a four-humans-in-a-voice-channel game, and
 * the design is explicitly trying to manufacture the sentence "get over here"
 * (game-design.md § 10, and the co-op rationale in PLAN.md § M3).
 *
 * A monster that walks past the Watchman to reach the Alchemist who wandered
 * two rooms off produces that sentence for free, every time, with no UI. It is
 * also the single most legible thing an under-token ring can promise: the ring
 * means CLOSE RANKS.
 *
 * "Isolated" is measured as the count of the candidate's own living kin in the
 * eight adjacent tiles — the same adjacency the Watchman's Resolve is built on
 * ("builds when struck and when adjacent to an ally", game-design.md § 2), so a
 * player already has a reason to be thinking about it. Ties fall back to the
 * incoming order, which is nearest-then-id, so the whole function is a stable
 * scan with a total order and zero draws.
 */
function mostIsolated(candidates: readonly EngineActor[], ctx: AiCtx): EngineActor | undefined {
  let best: EngineActor | undefined;
  let bestSupport = Number.POSITIVE_INFINITY;

  for (const candidate of candidates) {
    const support = supportOf(candidate, ctx);
    // STRICTLY less: the first candidate at a given support level wins, and
    // `candidates` arrives nearest-first with ids breaking ties, so the fallback
    // ordering is the same total order the plain profile uses.
    if (support < bestSupport) {
      best = candidate;
      bestSupport = support;
    }
    // Nobody can be more alone than alone; stop scanning.
    if (bestSupport === 0) break;
  }

  return best;
}

/**
 * How many of this actor's own living kin are standing next to it.
 *
 * DELEGATED TO `countAdjacentKin` (engine/actor.ts) rather than written here,
 * because the Disgraced Inspector's talent asks the same question from the
 * talent layer. Two copies would eventually disagree, and the symptom would be
 * a creature that walks past one lone target to reach another it thinks is more
 * alone and then hits it for less.
 */
function supportOf(actor: EngineActor, ctx: AiCtx): number {
  return countAdjacentKin(actor, ctx.actorAt);
}

// ---------------------------------------------------------------------------
// melee_chaser
// ---------------------------------------------------------------------------

/**
 * Close the distance and hit it.
 *
 * A* first (ai/simple.lua:135-152 `move_astar`), then ToME's own fallback to
 * `move_simple` (ai/simple.lua:142) when there is no path — around a corner a
 * straight step is usually still progress, and a monster that freezes because
 * A* gave up looks broken in a way a monster that shuffles does not.
 *
 * `rangeRefusal` and not Chebyshev: see the two-metrics note in the file header.
 * For a melee creature it answers over a circle of radius `MELEE_REACH`, which
 * IS the eight-neighbourhood — so bump-attack on a diagonal is unchanged — but
 * it is the same function the scheduler will refuse on, which is the point.
 */
function chase(self: MonsterActor, target: EngineActor, ctx: AiCtx): Intent {
  if (rangeRefusal(self, target) === null) {
    self.ai.blockedTurns = 0;
    return { kind: IntentKind.Attack, targetId: target.id };
  }
  return advance(self, target, ctx, 0);
}

/**
 * WOULD `canAttack` REFUSE THIS SHOT FOR ITS LINE? Its own clause, asked here:
 * past `combatDistance` 1 the line must be clear (`AiCtx.lineClear`), and at
 * arm's length it is never asked.
 *
 * `from` asks it of the shot `self` would have from that tile instead of from
 * where it stands (`AiCtx.lineClear`'s `from`); `sidestep` is its one user.
 *
 * `kite` asks it and `chase` does not, because every chaser in the roster has
 * reach 1: a chaser whose `rangeRefusal` passes is at arm's length, where
 * `canAttack` asks no line, so the question would always answer false there.
 * A chaser authored with a longer reach needs this in `chase` too.
 */
function lineRefused(self: MonsterActor, target: EngineActor, ctx: AiCtx, from?: TileXY): boolean {
  return combatDistance(from ?? self, target) > 1 && !ctx.lineClear(self, target, from);
}

/**
 * Close the distance by one step, or say why not.
 *
 * SHARED BY BOTH PROFILES — the chaser passes `keepAway` 0 and the kiter passes
 * its dead zone — so an elite kiter, if content ever authors one, gets the
 * escalation below without walking into melee to use it.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ELITE BEHAVIOUR 2 — YOU CANNOT PLUG THE DOOR ON IT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Ported from ToME's `move_complex` escalation ladder (ai/simple.lua:199-247) plus
 * the `move_blocked_astar` it switches to (ai/simple.lua:153-181). The M2 header of
 * this file listed it as the known gap and said it was "worth having once there
 * are enough monsters per room for a queue to form". A room with an elite and
 * three husks in it is that room.
 *
 * The rule, verbatim from ai/simple.lua:222-228: a monster that could not advance
 * counts the turn, and after five such turns it re-runs A* with
 * `check_all_block_move` (:163-170) — a predicate under which the TARGET's tile
 * is passable and every other body is a wall. That produces a route AROUND its
 * own swarm rather than a queue behind it.
 *
 * WHY THIS EARNS A RING RATHER THAN JUST BEING NICE. A chokepoint is the party's
 * strongest and cheapest tactic: put the Watchman in the doorway and the melee
 * trash stacks up behind him doing nothing. That is correct for trash — the M2
 * comment on `intentForStep` calls it "a chokepoint working as intended". The
 * elite is the creature that answers it. The counterplay stays real (five turns
 * is a long time, and it needs somewhere to go), but the plan has to be watched
 * rather than set and forgotten, which is what an elite should cost.
 *
 * NOT PORTED from `move_complex`: the `damaged_turns` branch (:206-208), which
 * switches to A* when the monster was recently hurt. It needs a damage hook into
 * `ai_state` that does not exist here, and it is a pathing nicety rather than a
 * threat. The `move_wander` branch (:211) is out for the reason the scheduler
 * gives: wandering costs the idle fixed point.
 */
/**
 * ═══════════════════════════════════════════════════════════════════════════
 * HOW LONG A MONSTER HUNTS SOMETHING IT CANNOT SEE — `ai/simple.lua:210`.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Upstream's own number: past ten turns without a sighting it stops hunting the
 * remembered tile and wanders instead. We have no wander (see `actMonster`'s
 * idle fixed point, which this must not break), so ten turns is where the
 * memory is forgotten and the monster stands.
 *
 * ═══ `ENGAGEMENT_TURNS` USED TO BITE FIRST, AND THAT WAS A BUG WEARING A
 * DESIGN'S CLOTHES ═══
 * This note used to say engagement biting first was "the pleasant part of the
 * design rather than a redundancy". It was not pleasant and it was not the
 * design: engagement is level-wide, refreshes only when a monster can SEE a
 * player, and lasts three turns — so a monster hunting a remembered tile (which
 * then saw nobody; since the keep roll it may see a body that is not its
 * target) was frozen by `actMonster` after three, with seven
 * turns of this counter left. TEN WAS UNREACHABLE. Every fight could be ended
 * by stepping round a corner and waiting three turns.
 *
 * `stillHunting` (engine/scheduler.ts) is the fix: engagement no longer lapses
 * while any monster still holds a `lastSeen`. It extends combat and cannot start
 * it, exactly as the `stillAfflicted` clause beside it does, and the pump still
 * reaches idle because THIS counter bounds the hunt — which is what makes it
 * load-bearing rather than belt-and-braces.
 *
 * It also still does the job the old note credited it with: stopping a monster
 * resuming a stale hunt minutes later, when engagement has been raised again by
 * somebody else's fight on the far side of the floor.
 */
export const PURSUIT_TURNS = 10;

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * IT SAW YOU GO ROUND THE CORNER — `ai/simple.lua:27-38`, `move_simple`.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ═══ WHAT THIS COSTS WITHOUT IT ═══
 * Everything hunting you stopped dead the instant you broke line of sight, and
 * stayed stopped. A party at ten percent could step behind one wall, drop out of
 * contact, and rest to full while the thing mid-swing waited a tile away. There
 * were no fighting retreats, no kiting a pack down a corridor, and no being
 * HUNTED — every fight was opt-in and resettable at will, which is the single
 * largest gap between this and the game it ports.
 *
 * ═══ IT WALKS TO A TILE, NOT TO A BODY ═══
 * That is the whole mechanic and it is upstream's: `move_simple` prefers
 * `target_last_seen` over the target's real position, so a monster commits to
 * where you WERE and arrives to find you gone. Walking to where you actually are
 * would be omniscience wearing a chase's clothes.
 *
 * ═══ AND IT MUST TERMINATE, WHICH IS NOT OPTIONAL HERE ═══
 * `actMonster` documents an idle fixed point: a monster that spends energy at an
 * empty room re-accrues and does it again, and `pump` never returns idle — a
 * server that never sleeps and a home PC with a fan. Three things end this walk:
 * arriving at the tile, failing to find a route to it, and `PURSUIT_TURNS`. All
 * three clear the memory, so the next call falls straight through to HOLD.
 */
function pursueLastSeen(self: MonsterActor, ctx: AiCtx): Intent {
  const seen = self.ai.lastSeen;
  if (seen === null) return HOLD_INTENT;

  // ARRIVED, AND NOBODY IS HERE. The hunt is over whether or not the counter has
  // run out — standing on the remembered tile is the answer to the question the
  // walk was asking.
  if (self.x === seen.x && self.y === seen.y) return forget(self);

  self.ai.unseenTurns += 1;
  if (self.ai.unseenTurns > PURSUIT_TURNS) return forget(self);

  // `keepAway: 0` DELIBERATELY, even for a kiter. The dead zone exists to stop a
  // ranged monster walking into melee with something it can SEE; there is
  // nothing here to keep away from, and a kiter that refused to approach the
  // corner would never re-acquire.
  const step = approach(self, seen, ctx, { keepAway: 0 });
  return step ?? forget(self);
}

/** Give up: no target, no memory, and no turn spent. */
function forget(self: MonsterActor): Intent {
  self.ai.targetId = null;
  self.ai.lastSeen = null;
  self.ai.unseenTurns = 0;
  return HOLD_INTENT;
}

function advance(self: MonsterActor, target: EngineActor, ctx: AiCtx, keepAway: number): Intent {
  const ai = self.ai;

  // 1. A LIVE ESCALATION OWNS THE ROUTE. ai/simple.lua:153-161 — while
  //    `ai_move` is `move_blocked_astar` it is the only mover, and it counts
  //    itself down. The mode has to outlive the turn that armed it: a
  //    one-turn escalation walks the elite a tile sideways and straight back
  //    into the queue it just left.
  if (ai.shoulderTurns > 0) return shoulder(self, target, ctx, keepAway);

  // 2. ai/simple.lua:176's penalty ticking back toward zero. Captured BEFORE the
  //    increment so a monster that is still cooling down cannot re-arm on the
  //    very turn its counter reaches 0.
  const cooling = ai.shoulderTurns < 0;
  if (cooling) ai.shoulderTurns += 1;

  // 3. The ordinary TERRAIN-ONLY route, which is what makes bump-attack work.
  const step = approach(self, target, ctx, { keepAway });
  if (step !== undefined) {
    ai.blockedTurns = 0;
    return step;
  }

  // 4. Blocked. Count the turn (ai/simple.lua:224-227) and, if that was the fifth,
  //    arm the escalation and RUN IT NOW — upstream arms and runs in the same
  //    pass at :225-228 rather than wasting the turn that armed it.
  ai.blockedTurns += 1;
  if (!cooling && ai.shoulderAfter > 0 && ai.blockedTurns >= ai.shoulderAfter) {
    ai.blockedTurns = 0;
    ai.shoulderTurns = ai.shoulderAfter;
    return shoulder(self, target, ctx, keepAway);
  }

  // A monster that cannot advance this turn is a chokepoint working as intended.
  return HOLD_INTENT;
}

/** One turn of the shoulder manoeuvre. Only called while `shoulderTurns > 0`. */
function shoulder(self: MonsterActor, target: EngineActor, ctx: AiCtx, keepAway: number): Intent {
  const ai = self.ai;
  // ai/simple.lua:155-157 — the mode counts itself down and reverts at zero.
  ai.shoulderTurns -= 1;

  const flank = approach(self, target, ctx, { keepAway, route: aroundKin(ctx, target) });
  if (flank !== undefined) return flank;

  // ai/simple.lua:174-177 — A* did not work either, so take the penalty rather than
  // paying for an actor-aware pathfind every turn for the rest of the fight.
  ai.shoulderTurns = -SHOULDER_FAILURE_PENALTY;
  return HOLD_INTENT;
}

/**
 * `check_all_block_move` — ai/simple.lua:163-170.
 *
 * ```lua
 * local actor = game.level.map(nx, ny, engine.Map.ACTOR)
 * if actor and actor == self.ai_target.actor then return true
 * else return not game.level.map:checkAllEntities(nx, ny, "block_move", self) end
 * ```
 *
 * The target's own tile stays passable — otherwise the goal is unreachable by
 * construction and A* returns null every time. Everything else with a body in it
 * is a wall.
 */
function aroundKin(ctx: AiCtx, target: EngineActor): PassableFn {
  return (x, y) => {
    if (x === target.x && y === target.y) return true;
    if (!ctx.isPassable(x, y)) return false;
    return ctx.actorAt(x, y) === undefined;
  };
}

// ---------------------------------------------------------------------------
// ranged_kiter
// ---------------------------------------------------------------------------

/**
 * Hold a firing lane: close to the band, shoot, give ground when crowded.
 *
 * Composed from ToME's building blocks rather than ported from one AI — ToME
 * distributes this across `move_complex` plus talent tactics tables, which is
 * far more machinery than two behaviours need. The three-way test IS the
 * profile:
 *
 *   inside minRange       -> RETREAT (`flee_simple`), and never a point-blank shot
 *   beyond preferredRange -> approach, the same A* as the chaser but floored
 *   in the band           -> shoot, subject to `talentIn` (ai/talented.lua:122)
 *                            and then to a clear line; a blocked one sidesteps
 *
 * The `talentIn` gate on that last line is what stops a kiter being a metronome:
 * a creature that declares one fires on a 1-in-N and otherwise holds its aim.
 * `index_wraith` declares 2, from losgoroth.lua:43. A creature that declares
 * nothing fires every turn, which is what every profile did before the gate.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * IT MUST NOT WALK INTO MELEE, AND THAT IS THREE SEPARATE GUARANTEES
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 1. IT NEVER FIRES FROM INSIDE ITS OWN DEAD ZONE. The M2 version fell through
 *    to an attack when the retreat was blocked, on the reasoning that "shooting
 *    point-blank beats standing still". It does not: `canAttack` returns
 *    `AttackRefusal.MinRange` for exactly that shot (engine/combat.ts), so the
 *    intent is refused, the monster's turn is spent, and the log says nothing.
 *    A cornered kiter HOLDS. That is not a wasted turn, it is the payoff for
 *    walking it into a wall — pin the wraith and it stops working, which is the
 *    single clearest argument for having a Watchman in the party.
 *
 * 2. IT NEVER STEPS INTO THE DEAD ZONE WHILE APPROACHING. `approach` is called
 *    with `keepAway`, so a routed step that would land it inside `minRange` is
 *    rejected. That also suppresses bump-attack for free: a tile with the target
 *    standing on it is at distance 0, which is inside every non-zero dead zone.
 *    The sidestep off a blocked line (`sidestep`) refuses the same tiles.
 *
 * 3. IT NEVER SIDESTEPS TOWARD ITS TARGET WHILE FLEEING. See `backAway`.
 *
 * `minRange` is what makes the profile a genuinely different tactical problem
 * rather than a chaser with a longer arm: you close on it, and it gives ground.
 * That its speed is below the party's (index_wraith is `globalSpeed` 0.84) is
 * what stops it giving ground forever.
 */
function kite(self: MonsterActor, target: EngineActor, ctx: AiCtx): Intent {
  // `combatDistance` — the same body `canAttack` refuses on, whole tiles. See
  // the file header: this line and `rangeRefusal` below must never be asked on
  // two metrics, or a kiter holds in a band its every shot is refused from.
  const distance = combatDistance(self, target);

  if (distance < self.ai.minRange) {
    const retreat = backAway(self, target, ctx);
    if (retreat !== undefined) {
      self.ai.blockedTurns = 0;
      return retreat;
    }
    // CORNERED. Guarantee 1: hold rather than fire a shot that will be refused.
    // Deliberately NOT `advance` — the escalation exists to close distance, and
    // shouldering forward is the one thing a pinned kiter must never do.
    self.ai.blockedTurns += 1;
    return HOLD_INTENT;
  }

  if (distance > self.ai.preferredRange) {
    return advance(self, target, ctx, self.ai.minRange);
  }

  // THE SAME FUNCTION THE SCHEDULER WILL REFUSE ON. It re-tests the dead zone
  // as well as the reach, which is redundant with the branch above and
  // deliberately so: the two numbers (`ai.minRange` and `combat.minRange`) are
  // proved equal by `validateTemplate`, and this is the line that stays correct
  // if one of them ever drifts.
  if (rangeRefusal(self, target) === null) {
    // It is standing where it wants to stand, so it is not blocked by anything —
    // whether or not it chooses to shoot this turn. Reset before the gate below,
    // so "held fire" never accumulates toward an escalation the kiter must not
    // run anyway (see guarantee 1 above).
    self.ai.blockedTurns = 0;

    // ═══════════════════════════════════════════════════════════════════════
    // `ai_state.talent_in` — ONE IN N, DRAWN ONLY HERE
    // ═══════════════════════════════════════════════════════════════════════
    //
    // Ported from ai/talented.lua:117-132 (`dumb_talented_simple`), and the
    // whole gate is the one condition at :122:
    //
    // ```lua
    // -- One in "talent_in" chance of using a talent
    // if (not self.ai_state.no_talents ...) and rng.chance(self.ai_state.talent_in or 6)
    //    and self:reactionToward(self.ai_target.actor) < 0 then
    //     used_talent = self:runAI("dumb_talented")
    // end
    // ```
    //
    // `rng.chance(N)` is a 1-in-N CHANCE PER TURN, not a metronome — see the
    // long note on `MonsterTemplate.talentIn`. Upstream falls through to
    // `move_simple` when the roll fails (:126-128); ours HOLDS instead, because
    // this branch has already established that the monster is standing exactly
    // where it wants to stand. Moving would undo the positioning it spent the
    // previous turns achieving, and a kiter that shuffles on every failed roll
    // reads as indecision rather than as taking aim.
    //
    // ═══ THE DRAW'S POSITION IN THE STREAM IS LOAD-BEARING ═══
    // `ai.fire.chance` is taken ONLY inside this branch and ONLY when the
    // creature actually declares a `talentIn`. That is two guarantees, not one:
    //
    //   - A monster with no `talentIn` — every husk and every elite in the
    //     roster — takes ZERO draws here, so its consumption of the seeded
    //     stream is byte-identical to what it was before this gate existed and
    //     no replay from an older seed shifts.
    //   - A wraith that is out of its band, retreating, or cornered also takes
    //     zero draws, because those paths return above. Only a wraith with a
    //     shot lined up pays for the roll, which is exactly when upstream pays
    //     for it too.
    //
    // Losing either guarantee means the number of orbs, husks or corners on a
    // floor changes what every other actor rolls — the one failure mode
    // replay-from-seed cannot survive.
    if (self.talentIn !== undefined && ctx.rng.int('ai.fire.chance', 1, self.talentIn) !== 1) {
      return HOLD_INTENT;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // SEEN IS NOT SHOOTABLE: SIDESTEP TO A CLEAR LINE, ELSE ADVANCE, ELSE HOLD
    // ═══════════════════════════════════════════════════════════════════════
    //
    // `AiCtx.lineClear` has why a target in sight can have a blocked line.
    // Without this guard the kiter fired a shot the scheduler refused `no_los`
    // and spent its turn on the refusal.
    //
    // AFTER THE ROLL, IN UPSTREAM'S ORDER. `dumb_talented_simple` rolls
    // `talent_in` first (engine/ai/talented.lua:122). Only on a hit does
    // `dumb_talented` ask `canProject` of each talent (:46-52), and when none
    // can project, `energy.used` is still false and the creature runs its
    // `ai_move` (:126-127). So the `ai.fire.chance` draw above is taken
    // whether or not the line is clear, and a kiter that lost the roll held
    // before it ever asked.
    //
    // WHAT UPSTREAM'S MOVE IS: the losgoroth the wraith ports sets `ai_move`
    // to `move_complex` (tome/data/general/npcs/losgoroth.lua:43), which moves
    // it TOWARD the target — by A* when hurt, a wander after ten unseen turns,
    // otherwise the dmap or a plain step (engine/ai/simple.lua:199-247). None of
    // it keeps a dead zone, because the losgoroth has none.
    //
    // THE SIDESTEP IS OURS. A kiter standing at exactly `minRange` has no step
    // toward its target that keeps the dead zone, so `advance` alone HELD
    // there, every turn the target stood still: 231 of 247 guard fires over 8
    // delves x 3 seeds, measured in review with the party standing still. A
    // census of placements (every kiter on 8 delves x 3 seeds, a player on up
    // to four in-band tiles it saw past something) held on 90 of 628 first guard
    // fires with `advance` alone and on 6 with the sidestep, and none of the
    // moves either way ended inside `minRange`. `sidestep` has the rule and
    // what it borrows from upstream. Only when it finds no tile does `advance`
    // run, dead zone kept, and that HOLDs in turn when it cannot step.
    if (lineRefused(self, target, ctx)) {
      return sidestep(self, target, ctx) ?? advance(self, target, ctx, self.ai.minRange);
    }

    return { kind: IntentKind.Attack, targetId: target.id };
  }

  // Only reachable if a template set `preferredRange > attackRange`, which
  // `validateTemplate` rejects. Kept because content is data and data can be
  // wrong, and "it stood still" is a far better failure than "it charged".
  return HOLD_INTENT;
}

/**
 * `util.adjacentDirs()` (engine/utils.lua:1912-1914) on a square grid,
 * `{1, 2, 3, 4, 6, 7, 8, 9}`, each read through `dir_to_coord`
 * (engine/utils.lua:1592-1602): south-west, south, south-east, west, east,
 * north-west, north, north-east. Upstream's neighbour scans walk this order.
 */
const ADJACENT_DIRS: readonly Dir[] = ['sw', 's', 'se', 'w', 'e', 'nw', 'n', 'ne'];

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ONE STEP TO A TILE THE SHOT CLEARS FROM, STILL IN THE BAND. OURS.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A kiter that sees its target but whose line is blocked (`kite`'s guard)
 * looks at its eight neighbouring tiles, in `ADJACENT_DIRS` order, and keeps
 * those that
 *
 *   - it can walk onto and nobody stands on (`canRetreat`'s test), and that is
 *     not a hazard to it (`hazardsFor`, the set `approach` routes around);
 *   - keeps the target inside the band, `minRange <= combatDistance <=
 *     preferredRange`, so the step never lands in the dead zone and the shot
 *     from there passes `rangeRefusal` (`validateTemplate` holds
 *     `preferredRange <= attackRange`);
 *   - has a clear line to the target from there (`lineRefused` with `from`).
 *
 * Of those it prefers the tile whose distance is nearest `preferredRange`, the
 * largest in the band, and a tie goes to the earlier direction. NO DRAW: the
 * choice is a total order on eight fixed tiles, so a sidestep leaves the
 * seeded stream exactly as it found it.
 *
 * ═══ WHAT IS UPSTREAM'S AND WHAT IS NOT ═══
 * Upstream has no such step for this creature: `dumb_talented_simple` hands a
 * turn with nothing to project to `ai_move` (engine/ai/talented.lua:126-127),
 * a step toward the target. The shape of the scan is upstream's all the same.
 * `aiCanFleeDmapKeepLos` (tome/class/interface/ActorAI.lua:806-833) picks the
 * tile for `flee_dmap_keep_los` (tome/ai/special_movements.lua lines 83-97),
 * which the tactical AI runs when a `safe_range` creature has lost its line
 * (tome/ai/tactical.lua lines 489-490). Both are in git but not in the sparse
 * checkout: `git -C reference/t-engine4 show HEAD:game/modules/tome/ai/<file>`.
 * `aiCanFleeDmapKeepLos` walks the eight neighbours in `util.adjacentDirs`
 * order, keeps only those with a line to the target (`hasLOS(ax, ay, nil, nil,
 * sx, sy)`, tome/class/interface/ActorAI.lua:820) and draws nothing. It
 * ranks what is left on the target's distance map, which a fleeing body wants;
 * the band rank here is ours, because this body wants to stay where it can
 * shoot. So are the band and hazard filters, and the call site: upstream's
 * `dumb_talented_simple` never runs that scan.
 *
 * @returns undefined when no neighbour qualifies, and the caller advances.
 */
function sidestep(self: MonsterActor, target: EngineActor, ctx: AiCtx): Intent | undefined {
  const avoid = hazardsFor(self, ctx);
  let best: { readonly dir: Dir; readonly distance: number } | undefined;
  for (const dir of ADJACENT_DIRS) {
    const to = stepTile(self, dir);
    if (!ctx.isPassable(to.x, to.y) || ctx.actorAt(to.x, to.y) !== undefined) continue;
    if (avoid?.(to.x, to.y) === true) continue;
    const distance = combatDistance(to, target);
    if (distance < self.ai.minRange || distance > self.ai.preferredRange) continue;
    if (lineRefused(self, target, ctx, to)) continue;
    // AND STILL IN SIGHT FROM THERE, or the next turn walks it back (`seesFrom`).
    if (!ctx.seesFrom(self, target, to)) continue;
    if (best === undefined || distance > best.distance) best = { dir, distance };
  }
  return best === undefined ? undefined : { kind: IntentKind.Move, dir: best.dir };
}

/**
 * Ported from ai/simple.lua:68-104 (`flee_simple`), INCLUDING the hard sides.
 *
 * ```lua
 * local dir = util.opposedDir(util.getDir(ax, ay, self.x, self.y), self.x, self.y)
 * if not self:canMove(sx, sy) then
 *     local sides = util.dirSides(dir, self.x, self.y)
 *     if rng.percent(50) then insert "left", "right" else insert "right", "left" end
 *     if rng.percent(50) then insert "hard_left", "hard_right" else ... end
 *     for _, side in ipairs(check_order) do ... end
 * end
 * ```
 *
 * Straight away from the target; if that is blocked, the two 45-degree sides and
 * then the two 90-degree ones, each PAIR order-randomised by its own coin flip.
 * The M2 port had only the first pair and one draw, which left a kiter cornered
 * roughly twice as often as ToME's would be — and a cornered kiter is a kiter
 * that has stopped being a kiter.
 *
 * The randomisation is not decoration: a fixed preference makes every wraith in
 * the room peel the same way, which reads as a formation rather than as panic.
 *
 * ADDED, NOT PORTED: a step is only taken if it INCREASES the distance to the
 * target. ToME's flee has no such test because ToME's fleeing monster has no
 * dead zone to fall back into; ours does, and a "retreat" that ends up closer is
 * a retreat that hands the player a free turn. It is asked of the UNROUNDED
 * length — see `canRetreat`.
 *
 * @returns undefined when there is nowhere to go, so the caller can decide what
 * being cornered means for that profile.
 */
function backAway(self: MonsterActor, target: EngineActor, ctx: AiCtx): Intent | undefined {
  const away = dirToward(target, self);
  if (away === undefined) return undefined;

  const from = euclidDistance(self, target);
  if (canRetreat(self, away, ctx, target, from)) return { kind: IntentKind.Move, dir: away };

  const sides = sideDirs(away);
  const order = ctx.rng.int('ai.flee.side', 0, 1) === 0 ? [sides.left, sides.right] : [sides.right, sides.left]; // prettier-ignore
  const hard = ctx.rng.int('ai.flee.hardside', 0, 1) === 0 ? [sides.hardLeft, sides.hardRight] : [sides.hardRight, sides.hardLeft]; // prettier-ignore

  for (const dir of [...order, ...hard]) {
    if (dir === undefined) continue;
    if (canRetreat(self, dir, ctx, target, from)) return { kind: IntentKind.Move, dir };
  }
  return undefined;
}

/**
 * Walkable, unoccupied, AND further from the target than we are now.
 *
 * ═══ THE UNROUNDED LENGTH, AND IT IS THE ONLY ATTACK-SIDE READER THAT IS ═══
 * Every range in this file is `combatDistance` — `core.fov.distance`, whole
 * tiles — and this test is not a range. It asks whether ONE STEP moved the body
 * away, and the rounded length is flat across exactly the steps a cornered
 * kiter needs: from (1,0) off its target to (1,1) is 1 to 1, and (2,0) to
 * (2,1) is 2 to 2. Asked on that metric, the hard sidesteps out of a pocket are
 * never "further", and the kiter holds where it could have slipped away.
 * `euclidDistance` strictly increases on every step that really is away, so
 * this admits them.
 *
 * IT CANNOT CYCLE AGAINST THE ROUNDED BAND. Every step this admits strictly
 * increases the exact length, and the rounded length never falls when the
 * exact one rises, so a retreat never takes the body deeper into the dead zone
 * the band measures — and `approach` refuses any step that would END inside it
 * (`keepAway`, on `combatDistance`), so no pair of decisions walks it out and
 * back in. The two tests disagree only about whether a FLAT step counts as
 * away, never about which way is away. test/server/ai.test.ts runs a cycle
 * detector over every kiter in the roster.
 */
function canRetreat(
  self: MonsterActor,
  dir: Dir,
  ctx: AiCtx,
  target: EngineActor,
  from: number,
): boolean {
  const to = stepTile(self, dir);
  if (!ctx.isPassable(to.x, to.y)) return false;
  if (ctx.actorAt(to.x, to.y) !== undefined) return false;
  return euclidDistance(to, target) > from;
}

// ---------------------------------------------------------------------------
// Air and hazards: tome/data/resources.lua:48-61 and tome/class/interface/ActorAI.lua:669-801
// ---------------------------------------------------------------------------

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * IT IS DROWNING, SO IT GOES FOR AIR — tome/data/resources.lua:48-61.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ```lua
 * if actor.air >= actor.max_air then return end
 * local dam, air = actor:aiGridDamage()
 * local air_rate = air + actor.air_regen
 * if air_rate <= 0 then
 *   local air_time = (actor.min_air - actor.air)/math.min(-1, air_rate)
 *   if actor.ai_target.actor then
 *     if air_time > 20 then return else air_time = air_time*10 end
 *   end
 *   if actor.ai_state.safe_grid or rng.percent(100 - 100*air_time/(air_time + 50)) then
 *     return {ai="move_safe_grid", name = "move to air"}
 * ```
 *
 * `air_time` is the turns of breath left at this rate: a body at 40 air losing
 * 2 a turn has 20. Out of combat that is a 71% chance to leave; in combat the
 * number is multiplied by ten before the roll, so the same body only tries 20%
 * of the time, and one with more than 20 turns left does not try at all. It is
 * a creature that would rather keep fighting until it has to stop.
 *
 * ═══ ONE DRAW, `ai.air.seek`, AND ONLY WHILE THE GROUND TAKES AIR ═══
 * A full body, a body on dry ground, a `no_breath` body and one that breathes
 * the water never reach the roll: `aiGridDamage`'s air is 0 for all of them, and
 * regen 3 makes the rate positive. So a world with no water spends no draw here
 * and every seed stays the same. At 0 air `air_time` is 0 and the roll is
 * `percent(100)`, which is certain and still draws, as the C does.
 *
 * ═══ ABOVE THE TARGET REFRESH, AND "IN COMBAT" IS THE TARGET IT KEPT ═══
 * `ai_target.actor` is the target from the last turn at the moment this reads
 * it, and `ai.targetId` is ours. Running first means a turn spent heading for
 * air never takes `ai.target.keep` or `ai.cast`, and a turn that does not head
 * for air takes them exactly as it did.
 *
 * ═══ NOT PORTED: `ai_state.safe_grid`, AND `move_safe_grid` ITSELF ═══
 * Upstream skips the roll while `safe_grid` is set ("100% if already seeking
 * air"). Nothing in the reference tree sets or clears `safe_grid`, and nothing
 * in it defines the `move_safe_grid` AI both lines hand off to: they are in a
 * part of ToME the clone does not hold. Nothing here can say when upstream
 * clears it, so every turn rolls again. The chance still climbs
 * as the air falls, and at 0 it is certain.
 *
 * So the move is one step along the path `aiFindSafeGrid` found. When the search
 * finds nothing better than where the body stands, or kin stands on the first
 * step, the turn goes to the fight instead. The draw has already been taken.
 *
 * ═══ WHERE IT RUNS IS OURS, AND CANNOT BE CHECKED ═══
 * The formula is upstream's; the call site is not. Nothing in the reference
 * tree calls `aiResourceAction` (ActorAI.lua:601), which is what hands a
 * resource to this trigger: its callers are the ToME AI scripts the clone does
 * not hold. Running first on every turn, ahead of the target refresh, is this
 * port's choice.
 */
function seekAir(self: MonsterActor, ctx: AiCtx): Intent | undefined {
  const terrainAt = ctx.terrainAt;
  if (terrainAt === undefined) return undefined;
  if (self.air >= self.maxAir) return undefined;

  const airRate = aiGridDamage(self, self.x, self.y, terrainAt, ctx).air + self.airRegen;
  if (airRate > 0) return undefined;

  // `min_air` is the resource's floor, 0 (engines/default/engine/interface/ActorResource.lua:61).
  let airTime = (0 - self.air) / Math.min(-1, airRate);
  const inCombat = self.ai.targetId !== null;
  if (inCombat) {
    if (airTime > 20) return undefined;
    airTime *= 10;
  }
  if (!percent(ctx.rng, 'ai.air.seek', 100 - (100 * airTime) / (airTime + 50))) return undefined;

  const grid = aiFindSafeGrid(self, ctx, terrainAt, inCombat);
  const next = grid.path[0];
  if (next === undefined) return undefined;
  return intentForStep(self, next, ctx, grid, 0);
}

/**
 * The tiles THIS body should route around: `isHazardFor`, asked with `self`.
 * Undefined when the context knows no terrain, which is a fixture's answer.
 */
function hazardsFor(self: MonsterActor, ctx: AiCtx): PassableFn | undefined {
  const terrainAt = ctx.terrainAt;
  if (terrainAt === undefined) return undefined;
  return (x, y) => isHazardFor(terrainAt(x, y), self);
}

/**
 * `aiGridDamage` — tome/class/interface/ActorAI.lua:669-690. What a turn on this
 * tile costs this body: damage, and air as a NEGATIVE number (the grid's
 * `air_level`), 0 for ground it can breathe on.
 *
 * ```lua
 * if not self:attr("no_breath") then
 *   local air_level, air_condition = g:check("air_level", gx, gy), g:check("air_condition", gx, gy)
 *   if air_level and air_level < 0 and (not air_condition or not self.can_breath[air_condition] or self.can_breath[air_condition] <= 0) then
 *     air = air_level
 * ```
 *
 * `< 0`, so the bubble's +15 counts as no air cost. That matches the Lua here,
 * though `actBase` still calls the bubble suffocating (D5-6). The damage half is
 * `AiCtx.gridDamage`'s.
 */
function aiGridDamage(
  self: MonsterActor,
  x: number,
  y: number,
  terrainAt: (x: number, y: number) => number,
  ctx: AiCtx,
): { readonly dam: number; readonly air: number } {
  let air = 0;
  if (self.noBreath !== true) {
    const grid = airOf(terrainAt(x, y));
    if (grid !== undefined && grid.level < 0 && !breathes(self, grid)) air = grid.level;
  }
  return { dam: ctx.gridDamage?.(self, x, y) ?? 0, air };
}

/**
 * `aiGridHazard` — tome/class/interface/ActorAI.lua:699-704. Lower is safer, and
 * 0 or less is safe.
 *
 * ```lua
 * local val = math.max(0.1, dam_wt or 1)*dam*100/(self.life-self.die_at) - math.max(0.1,( air_wt or 1))*air*100/(self.air + 1)
 * ```
 *
 * Both weights are left at their default of 1, as `aiFindSafeGrid`'s only
 * caller leaves them. `life - die_at` is `hp`: nothing here dies below zero.
 * The air term grows as the lungs empty: at 10 air a tile of deep water scores
 * 45, and at 0 it scores 500.
 */
function aiGridHazard(
  self: MonsterActor,
  x: number,
  y: number,
  terrainAt: (x: number, y: number) => number,
  ctx: AiCtx,
): number {
  const { dam, air } = aiGridDamage(self, x, y, terrainAt, ctx);
  return (dam * 100) / self.hp - (air * 100) / (self.air + 1);
}

/** `aiFindSafeGrid`'s `radius or 10`, the only radius its caller passes. */
const SAFE_GRID_RADIUS = 10;

/** Where `aiFindSafeGrid` would go, its value, and the route. `path` is empty for "stay". */
type SafeGrid = {
  readonly x: number;
  readonly y: number;
  readonly val: number;
  readonly path: readonly TileXY[];
};

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE NEAREST GROUND THAT HURTS LESS — tome/class/interface/ActorAI.lua:726-801.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Every tile within 10 that a body could move onto is scored as
 * `hazard + path length * dist_weight (+ want_closer * distance to the target)`,
 * and the lowest score wins if it beats standing still.
 *
 * - :732's early answer for a start that is already safe is not here. The one
 *   caller asks only while the ground takes this body's air, and such a tile
 *   always scores above 0 unless standing on it also heals, which nothing does.
 *   Every other tile then has to beat that score, as it does upstream.
 * - `dist_weight` IS 1 IN COMBAT AND 0.1 OUT OF IT (:734), times the move cost,
 *   so a creature with nobody to fight will walk ten times further for air.
 * - `want_closer` IS 0.5 IN COMBAT (:740): among grids equally safe, the one
 *   nearer its target, so it comes up for air on the side it was fighting.
 * - A TILE IS SCORED ON THE STRAIGHT DISTANCE FIRST (:772-777), and only one
 *   that could beat the best so far pays for A* (:778). Its real score uses
 *   the path's length (:780-782), and only a STRICT improvement replaces the
 *   best (:783), so the first grid found at a value keeps it.
 * - `canMove(lx, ly)` (:771) is `engine/Actor.lua:302-309` without
 *   `terrain_only`: terrain that blocks a body, a shut door included, and any
 *   body standing there. The route is `isPassable`, the same A* the chase uses
 *   (:746, :778), so a door-opener's route may cross a door.
 *
 * ═══ WHAT IS NOT UPSTREAM'S, EACH ON PURPOSE ═══
 * - THE CIRCLE DOES NOT SHADOWCAST. Upstream's `calc_circle` takes a block
 *   function (:755-768) that hides tiles behind a wall or behind a tile that
 *   could not beat the best. This walks `circleGrids`, which has no block
 *   function (see its note in `shared/mapgen/geom.ts`), so every tile in the
 *   disc is scored, and one that is reachable but hidden behind a wall can win
 *   here where upstream would not look. The shadowcaster itself exists now
 *   (`calcCircle`, `shared/mapgen/fovcircle.ts`, which asks its block live and
 *   applies in the C's order, as a best-so-far block needs); this search has
 *   not been moved onto it.
 * - THE ORDER IS NEAREST FIRST, then by row and column, where upstream's is the
 *   FOV scan's. It only decides a tie, and it makes the first safe tile cheap to
 *   find, so later tiles are ruled out on distance before any A*.
 * - WHERE THE TARGET IS. `aiSeeTargetPos` guesses with a random spread when the
 *   target is out of sight (engine/interface/ActorAI.lua:218-275). Ours is the
 *   target itself when this body can see it and `ai.lastSeen` when it cannot,
 *   which is the stand-in `pursueLastSeen` already uses, and it draws nothing.
 * - MOVE COST. `combatMovementSpeed() / global_speed`, and movement speed is not
 *   ported, so it is `1 / globalSpeed`. `never_move` is not asked: a pinned
 *   body's move is refused at resolution like any other.
 */
function aiFindSafeGrid(
  self: MonsterActor,
  ctx: AiCtx,
  terrainAt: (x: number, y: number) => number,
  inCombat: boolean,
): SafeGrid {
  const hazard = aiGridHazard(self, self.x, self.y, terrainAt, ctx);
  const moveCost = 1 / self.globalSpeed;
  const distWeight = (inCombat ? 1 : 0.1) * moveCost;
  const aim = inCombat ? targetPosition(self, ctx) : undefined;
  const wantCloser = aim === undefined ? 0 : 0.5;
  const closerAt = (x: number, y: number): number =>
    aim === undefined ? 0 : wantCloser * fovDistance(aim.x, aim.y, x, y);

  let best: SafeGrid = {
    x: self.x,
    y: self.y,
    val: hazard + Math.max(0, closerAt(self.x, self.y)),
    path: [],
  };

  const cells = circleGrids(self.x, self.y, SAFE_GRID_RADIUS, () => true)
    .filter((cell) => cell.x !== self.x || cell.y !== self.y)
    .map((cell) => ({ cell, straight: fovDistance(self.x, self.y, cell.x, cell.y) }))
    .sort((a, b) => a.straight - b.straight || a.cell.y - b.cell.y || a.cell.x - b.cell.x);

  for (const { cell, straight } of cells) {
    if (!isWalkable(terrainAt(cell.x, cell.y))) continue;
    if (ctx.actorAt(cell.x, cell.y) !== undefined) continue;
    const cellHazard = aiGridHazard(self, cell.x, cell.y, terrainAt, ctx);
    const closer = closerAt(cell.x, cell.y);
    if (cellHazard + Math.max(0, straight * distWeight + closer) > best.val) continue;

    const path = findPath({ x: self.x, y: self.y }, cell, ctx.isPassable);
    if (path === null) continue;
    const val = cellHazard + Math.max(0, path.length * distWeight + closer);
    if (val < best.val) best = { x: cell.x, y: cell.y, val, path };
  }
  return best;
}

/**
 * Where this body believes its target is: in sight, where it stands; out of
 * sight, where it was last seen. Undefined when it holds neither.
 */
function targetPosition(self: MonsterActor, ctx: AiCtx): TileXY | undefined {
  const id = self.ai.targetId;
  if (id === null) return undefined;
  const seen = ctx.visibleEnemies(self).find((actor) => actor.id === id);
  if (seen !== undefined) return { x: seen.x, y: seen.y };
  return self.ai.lastSeen ?? undefined;
}

// ---------------------------------------------------------------------------
// Shared movement
// ---------------------------------------------------------------------------

/** Per-call overrides on how a monster is allowed to close the distance. */
type ApproachOpts = {
  /**
   * No step may END strictly inside this distance of the target, measured by
   * `combatDistance` — the same whole-tile `core.fov.distance` the kite band and
   * `rangeRefusal` read, so the tile a kiter steps onto is judged exactly as
   * the shot it will take from there.
   *
   * A kiter's dead zone. 0 (the default) means melee: walk right up to it, and
   * step onto it if it is standing in the way, which becomes a bump-attack.
   */
  readonly keepAway?: number;
  /**
   * The route predicate handed to A*. Defaults to `ctx.isPassable`, which is
   * TERRAIN ONLY and is what makes bump-attack work — see the file header. The
   * elite's shoulder manoeuvre is the one caller that overrides it.
   */
  readonly route?: PassableFn;
};

/**
 * One step along the A* route, with ToME's fallbacks.
 *
 * `allowBlockedTarget` is on because the goal is a tile with a body on it and
 * the default predicate is terrain-only anyway; it costs nothing here and it is
 * the honest expression of "walk up to the thing and interact with it".
 *
 * If the next tile turns out to hold a hostile, we BUMP IT — that is the whole
 * bump-attack mechanic, and it is why the path was allowed to run through
 * occupied tiles in the first place. If it holds an ally we try the straight
 * step instead (`move_simple`), and if that is blocked too we return undefined
 * and the caller decides: a normal monster braces, because a monster that cannot
 * advance this turn is a chokepoint working as intended, and an elite starts
 * counting.
 */
function approach(
  self: MonsterActor,
  /**
   * A PLACE, NOT A BODY. Widened from `EngineActor` when pursuit arrived: this
   * function only ever read `x`/`y` off it, and the remembered tile a monster
   * hunts has no actor standing on it — that is the point of remembering it.
   */
  target: TileXY,
  ctx: AiCtx,
  opts: ApproachOpts = {},
): Intent | undefined {
  const route = opts.route ?? ctx.isPassable;
  const keepAway = opts.keepAway ?? 0;

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * AROUND THE POND IF THERE IS A WAY AROUND, THROUGH IT IF THERE IS NOT.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Upstream's monster A* has no hazard term at all: it plans straight through
   * deep water, and only the air AI (`seekAir`) gets it out again. Upstream's
   * answer to the path itself is a WEIGHTED search, with hazards as extra cost
   * (`tome/class/interface/PlayerExplore.lua:1948-1971`, "slow terrain will be
   * avoided if at all possible"), and `findPath` has no costs. So this is the
   * two-search stand-in the player's mouse walk already uses
   * (`findPathAvoiding`): refuse every tile that would hurt THIS body, and fall
   * back to the plain route only when that finds nothing.
   *
   * THE GOAL IS EXEMPT (`allowBlockedTarget`), so a detective standing in the
   * water is still reached, from the dry side where there is one. The tile the
   * monster stands on is never asked, so one already in the water can leave it.
   *
   * On a floor with nothing to avoid, `findPathAvoiding` runs one search with
   * the same answers as before, so the route and the draws are unchanged.
   */
  const avoid = hazardsFor(self, ctx);
  const from = { x: self.x, y: self.y };
  const goal = { x: target.x, y: target.y };
  const path =
    avoid === undefined
      ? findPath(from, goal, route, { allowBlockedTarget: true })
      : findPathAvoiding(from, goal, route, avoid, { allowBlockedTarget: true });

  const next = path?.[0];
  if (next !== undefined) {
    const stepIntent = intentForStep(self, next, ctx, target, keepAway);
    if (stepIntent !== undefined) return stepIntent;
  }

  // ai/simple.lua:140-142 — no path, or the path's first node was unusable:
  // fall back to a straight step toward the target.
  const straight = dirToward(self, target);
  if (straight !== undefined) {
    const stepIntent = intentForStep(self, stepTile(self, straight), ctx, target, keepAway);
    if (stepIntent !== undefined) return stepIntent;
  }

  return undefined;
}

/**
 * Turn "I want to be on that tile" into a move, a bump-attack, or nothing.
 * `to` must be one step away; both callers guarantee it.
 */
function intentForStep(
  self: MonsterActor,
  to: TileXY,
  ctx: AiCtx,
  /** A place, not a body — see `approach`. Only the dead-zone test reads it. */
  target: TileXY,
  keepAway: number,
): Intent | undefined {
  // THE DEAD ZONE, CHECKED BEFORE ANYTHING ELSE. This is guarantee 2 in `kite`,
  // and putting it first is what makes it also suppress bump-attack: the
  // target's own tile is at distance 0 from the target, which is inside every
  // non-zero dead zone, so a kiter can never route itself into a melee swing.
  if (keepAway > 0 && combatDistance(to, target) < keepAway) return undefined;

  const dir = dirToward(self, to);
  if (dir === undefined) return undefined;

  const occupant = ctx.actorAt(to.x, to.y);
  if (occupant !== undefined) {
    /**
     * Terrain-only pathing walked us into somebody. If they are on the other
     * side, that is a bump-attack; if they are on ours, they are in the way.
     *
     * ═══ AND "THE OTHER SIDE" IS A RELATION, WHICH THIS ASKED AS A KIND ═══
     * `occupant.kind !== self.kind` is `areEnemies` with the factions taken
     * out, and the two disagree on exactly the bodies this game has added
     * since: a Redactor's own shadow and a `Faction.Squad` companion are both
     * Monsters and both enemies of every husk on the floor, and this read them
     * as ONE OF OURS IN THE WAY.
     *
     * ═══ IT IS BELT AND BRACES TODAY, AND IT IS WORTH THE LINE ANYWAY ═══
     * `acquireTarget` reaches such a body FIRST — an adjacent enemy is inside
     * `aggroRange`, and a field of view of radius 1 or more always holds the
     * whole 3x3, so it is what `visibleEnemies` returns nearest-first, and
     * `chase` attacks it before any step is proposed. That USED to make this
     * branch unreachable with a hostile occupant that was not already the
     * target. It is reachable now: a target
     * kept out of sight (`acquireTarget`, upstream's 90% keep) sends the
     * monster toward `lastSeen`, and that route can run into a visible hostile
     * that is not the target — which it then bump-attacks, close to ToME's own
     * bump, while `targetId` stays on the unseen one. Untested here.
     *
     * It stays stated correctly for the reason the Downed guard in
     * `scheduler.ts`'s swap block stays: the rule is one relation, written in
     * one predicate, and the day anything narrows what a monster can see —
     * a smaller `aggroRange`, a blindness that filters `visibleEnemies`, a
     * pursuit that steps past a body it never looked at — a `kind` comparison
     * here would silently become the bug `areEnemies` exists to have deleted.
     * A companion in a corridor is a body the party PUTS there, so it is the
     * case most likely to find it.
     */
    if (isHostile(self, occupant)) {
      return { kind: IntentKind.Attack, targetId: occupant.id };
    }
    return undefined;
  }

  if (!ctx.isPassable(to.x, to.y)) return undefined;
  return { kind: IntentKind.Move, dir };
}

function stepTile(from: TileXY, dir: Dir): TileXY {
  const vector = DIR_VECTORS[dir];
  return { x: from.x + vector.dx, y: from.y + vector.dy };
}

/**
 * The compass direction from `from` toward `to`, or undefined when they are the
 * same tile.
 *
 * Signs rather than the raw delta, so this answers both "which way is that
 * adjacent tile" and "roughly which way is that thing twelve tiles off" with
 * one function — which is exactly the two uses ToME's `util.getDir` has.
 */
function dirToward(from: TileXY, to: TileXY): Dir | undefined {
  const dx = Math.sign(to.x - from.x);
  const dy = Math.sign(to.y - from.y);
  if (dx === 0 && dy === 0) return undefined;
  return DIR_ORDER.find((dir) => {
    const vector = DIR_VECTORS[dir];
    return vector.dx === dx && vector.dy === dy;
  });
}

/** The four flanking directions — ToME's `util.dirSides` (ai/simple.lua:76). */
type DirSides = {
  /** 45 degrees counter-clockwise of `dir`. */
  readonly left: Dir | undefined;
  /** 45 degrees clockwise. */
  readonly right: Dir | undefined;
  /** 90 degrees counter-clockwise — perpendicular to the flight axis. */
  readonly hardLeft: Dir | undefined;
  /** 90 degrees clockwise. */
  readonly hardRight: Dir | undefined;
};

/**
 * The four directions flanking `dir`.
 *
 * DIR_ORDER is clockwise from north and has all eight compass points, so one
 * step along it is 45 degrees and two steps is 90 — which is exactly ToME's
 * left/right and hard_left/hard_right.
 */
function sideDirs(dir: Dir): DirSides {
  const index = DIR_ORDER.indexOf(dir);
  if (index < 0) {
    return { left: undefined, right: undefined, hardLeft: undefined, hardRight: undefined };
  }
  const count = DIR_ORDER.length;
  return {
    left: DIR_ORDER[(index + count - 1) % count],
    right: DIR_ORDER[(index + 1) % count],
    hardLeft: DIR_ORDER[(index + count - 2) % count],
    hardRight: DIR_ORDER[(index + 2) % count],
  };
}
