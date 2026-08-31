// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/engines/default/engine/ai/simple.lua:27-38 (move_simple),
//             :68-104 (flee_simple, INCLUDING the hard sides at :84-90),
//             :135-152 (move_astar), :153-181 (move_blocked_astar),
//             :199-247 (move_complex), :251-268 (target_simple)
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
 * entire point of it. That is ToME's `move_blocked_astar` (simple.lua:153-181),
 * and it is opt-in per creature there too.
 *
 * ===========================================================================
 * TWO METRICS, AND WHICH PROFILE USES WHICH
 * ===========================================================================
 *
 * ToME measures MOVEMENT in Chebyshev (Astar.lua — a diagonal step costs what an
 * orthogonal one does) and RANGE in Euclidean (`core.fov.distance`; see the
 * header of engine/combat.ts). This file keeps both, and the split is not
 * arbitrary:
 *
 *   MOVEMENT — `approach`, `backAway` and the flanking sides are all Chebyshev
 *            steps, because a diagonal step costs what an orthogonal one does.
 *   RANGE  — every "may I attack from here?" goes through `rangeRefusal`, which
 *            is the reach-and-dead-zone half of `canAttack` itself, exported
 *            from engine/combat.ts for exactly this call.
 *
 * ═══ THE AI MUST ASK THE QUESTION THE LEGALITY CHECK WILL ASK ═══
 * `chase` used to test `chebyshev(self, target) <= self.attackRange` while
 * `canAttack` refused on EUCLIDEAN. For the current roster the two agree — a
 * husk's `attackRange` 1 against `combat.range` 1.5, and the wraith's
 * `preferredRange` 4 gates long before its `attackRange` 6 — so nothing was
 * visibly wrong. But a creature whose AI band is one tile WIDER than its reach
 * submits an attack that is refused every single turn: the intent costs the
 * turn (a monster does not get refunded), and the sweep shows a `blocked` step,
 * forever. From outside that is an AI freeze, not a range bug, and nothing fails
 * anywhere. Asking one function removes the class of bug rather than the
 * instance.
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
 *   - `visibleEnemies` is ordered by distance and then by ID, so a tie between
 *     two equidistant players resolves the same way every time rather than by
 *     whoever happens to sit earlier in a hash table. The elite's isolation
 *     scan re-sorts that list without ever consulting the stream.
 *   - Every random draw goes through the world's seeded PCG32 with a LABEL.
 *     There are exactly four, all ported: the 90% target-keep at
 *     simple.lua:253, the two coin flips that order the flanking sidesteps at
 *     simple.lua:79 and :85, and the 1-in-`talent_in` fire roll at
 *     ai/talented.lua:122. The fourth is CONDITIONAL on the creature declaring a
 *     `talentIn` at all, so a monster that does not (every melee creature in the
 *     roster) consumes the stream exactly as it did before that draw existed.
 *
 * SYNCHRONOUS — src/server/ai/** carries the engine's six anti-async selectors
 * and the bans on `Date.now`/`Math.random`.
 */

import { DIR_ORDER, DIR_VECTORS } from '../../shared/coords.ts';
import { findPath } from '../../shared/path.ts';
import { AiProfile, HOLD_INTENT, IntentKind, countAdjacentKin } from '../engine/actor.ts';
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
   * (aggro range plus line of sight) is the caller's to define, because it
   * becomes real FOV at M3 and nothing in this file should change when it does.
   *
   * A visible target is therefore also a target with a clear sight line, which
   * is why `kite` never re-checks LOS before shooting.
   */
  readonly visibleEnemies: (self: MonsterActor) => readonly EngineActor[];
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
};

/**
 * After a failed shoulder attempt, `ai.shoulderTurns` is driven this far
 * negative so the elite waits before re-running A* against the same wall.
 *
 * simple.lua:176 — `self.ai_state.blocked_turns = -5`, upstream's own penalty
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

export function decideNpcAction(self: MonsterActor, ctx: AiCtx): Intent {
  const target = acquireTarget(self, ctx);
  if (target === undefined) {
    // Nothing to be blocked BY. Losing the target has to clear both counters, or
    // an elite banks blocked turns while it stands in an empty room and then
    // shoulders through the first ally it meets on the next contact — and
    // resumes a flank around a body that is no longer there.
    self.ai.blockedTurns = 0;
    self.ai.shoulderTurns = 0;
    return pursueLastSeen(self, ctx);
  }

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * IT CAN SEE YOU — REMEMBER WHERE. `ActorAI.lua:130-135`.
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
  if (options.length > 0 && ctx.rng.int('ai.cast', 0, 99) < CAST_CHANCE) {
    // FIRST, NOT BEST. The template's order is the creature's own preference,
    // and `castable` preserves it — so an author orders the list and the
    // creature obeys it, rather than the AI inventing a scoring function that
    // every future talent has to be tuned against.
    const pick = options[0];
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

// ---------------------------------------------------------------------------
// Targeting — ported from ai/simple.lua:251-268 (`target_simple`)
// ---------------------------------------------------------------------------

/**
 * Pick who to attack, keeping the current target 90% of the time.
 *
 * The hysteresis is the whole point of the port and it is easy to mistake for
 * noise: without it a monster standing equidistant from two players re-picks
 * the nearest every turn, and a one-tile shuffle by either player makes it
 * oscillate on the spot instead of committing to anyone. ToME writes this as
 * `rng.percent(90)` at simple.lua:253.
 *
 * The draw happens ONLY when there is still a live, visible, hostile target —
 * mirroring Lua's short-circuit at that line, so the number of draws per turn
 * is the same as ToME's and the stream does not shift.
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
    const kept = visible.find((actor) => actor.id === current);
    if (kept !== undefined && ctx.rng.int('ai.target.keep', 1, 100) <= 90) return kept;
  }

  // `visible` is nearest-first, so the plain case is ToME's walk down
  // `fov.actors_dist` (simple.lua:259-267) taking the closest live hostile.
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
   * Upstream keeps the target with no visibility test at all (`target_simple`,
   * ai/simple.lua:250-253); the memory is bounded by `unseenTurns` instead. So
   * an empty view leaves the id alone and the caller decides whether to hunt or
   * to give up.
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
 * (simple.lua:259-267) because ToME is a single-player game and "nearest" and
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
 * A* first (simple.lua:135-152 `move_astar`), then ToME's own fallback to
 * `move_simple` (simple.lua:142) when there is no path — around a corner a
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
 * Ported from ToME's `move_complex` escalation ladder (simple.lua:199-247) plus
 * the `move_blocked_astar` it switches to (simple.lua:153-181). The M2 header of
 * this file listed it as the known gap and said it was "worth having once there
 * are enough monsters per room for a queue to form". A room with an elite and
 * three husks in it is that room.
 *
 * The rule, verbatim from simple.lua:222-228: a monster that could not advance
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
 * IN PRACTICE `ENGAGEMENT_TURNS` USUALLY BITES FIRST, and that is the pleasant
 * part of the design rather than a redundancy. Engagement is level-wide and
 * lasts three turns past the last contact, so a monster that cannot re-find you
 * within three stops being asked to act at all and the pump idles. This counter
 * is what stops a monster resuming a stale hunt minutes later, when engagement
 * has been raised again by somebody else's fight on the far side of the floor.
 */
const PURSUIT_TURNS = 10;

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

  // 1. A LIVE ESCALATION OWNS THE ROUTE. simple.lua:153-161 — while
  //    `ai_move` is `move_blocked_astar` it is the only mover, and it counts
  //    itself down. The mode has to outlive the turn that armed it: a
  //    one-turn escalation walks the elite a tile sideways and straight back
  //    into the queue it just left.
  if (ai.shoulderTurns > 0) return shoulder(self, target, ctx, keepAway);

  // 2. simple.lua:176's penalty ticking back toward zero. Captured BEFORE the
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

  // 4. Blocked. Count the turn (simple.lua:224-227) and, if that was the fifth,
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
  // simple.lua:155-157 — the mode counts itself down and reverts at zero.
  ai.shoulderTurns -= 1;

  const flank = approach(self, target, ctx, { keepAway, route: aroundKin(ctx, target) });
  if (flank !== undefined) return flank;

  // simple.lua:174-177 — A* did not work either, so take the penalty rather than
  // paying for an actor-aware pathfind every turn for the rest of the fight.
  ai.shoulderTurns = -SHOULDER_FAILURE_PENALTY;
  return HOLD_INTENT;
}

/**
 * `check_all_block_move` — simple.lua:163-170.
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
 *
 * 3. IT NEVER SIDESTEPS TOWARD ITS TARGET WHILE FLEEING. See `backAway`.
 *
 * `minRange` is what makes the profile a genuinely different tactical problem
 * rather than a chaser with a longer arm: you close on it, and it gives ground.
 * That its speed is below the party's (index_wraith is `globalSpeed` 0.84) is
 * what stops it giving ground forever.
 */
function kite(self: MonsterActor, target: EngineActor, ctx: AiCtx): Intent {
  // EUCLIDEAN — the same metric `canAttack` refuses on. See the file header.
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

    return { kind: IntentKind.Attack, targetId: target.id };
  }

  // Only reachable if a template set `preferredRange > attackRange`, which
  // `validateTemplate` rejects. Kept because content is data and data can be
  // wrong, and "it stood still" is a far better failure than "it charged".
  return HOLD_INTENT;
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
 * a retreat that hands the player a free turn.
 *
 * @returns undefined when there is nowhere to go, so the caller can decide what
 * being cornered means for that profile.
 */
function backAway(self: MonsterActor, target: EngineActor, ctx: AiCtx): Intent | undefined {
  const away = dirToward(target, self);
  if (away === undefined) return undefined;

  const from = combatDistance(self, target);
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

/** Walkable, unoccupied, AND further from the target than we are now. */
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
  return combatDistance(to, target) > from;
}

// ---------------------------------------------------------------------------
// Shared movement
// ---------------------------------------------------------------------------

/** Per-call overrides on how a monster is allowed to close the distance. */
type ApproachOpts = {
  /**
   * No step may END strictly inside this EUCLIDEAN distance of the target.
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

  const path = findPath({ x: self.x, y: self.y }, { x: target.x, y: target.y }, route, {
    allowBlockedTarget: true,
  });

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
    // Terrain-only pathing walked us into somebody. If they are on the other
    // side, that is a bump-attack; if they are on ours, they are in the way.
    if (occupant.kind !== self.kind) {
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

/** The four flanking directions — ToME's `util.dirSides` (simple.lua:76). */
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
