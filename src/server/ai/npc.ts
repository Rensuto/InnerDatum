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
 *   `chase`  asks a MOVEMENT question — "can I touch it from here?" — so it uses
 *            CHEBYSHEV against `attackRange`. Chebyshev 1 IS the Moore
 *            neighbourhood, which is what makes bump-attack work on a diagonal,
 *            and it is what the scheduler's own legality check uses today.
 *   `kite`   asks a RANGE question — "am I in my band?" — so it uses
 *            `combatDistance`, the same Euclidean function `canAttack` refuses
 *            on. Importing it rather than re-deriving it is the point: a second
 *            copy of a distance rule is how you get a monster that walks to a
 *            tile it then refuses to shoot from.
 *
 * Because Euclidean >= Chebyshev everywhere, a kiter that thinks it is in range
 * is in range under BOTH checks. The AI is conservative in the only direction
 * that never produces a refused intent.
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

import { DIR_ORDER, DIR_VECTORS, chebyshev } from '../../shared/coords.ts';
import { findPath } from '../../shared/path.ts';
import { AiProfile, HOLD_INTENT, IntentKind } from '../engine/actor.ts';
import { combatDistance } from '../engine/combat.ts';
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
export function decideNpcAction(self: MonsterActor, ctx: AiCtx): Intent {
  const target = acquireTarget(self, ctx);
  if (target === undefined) {
    // Nothing to be blocked BY. Losing the target has to clear both counters, or
    // an elite banks blocked turns while it stands in an empty room and then
    // shoulders through the first ally it meets on the next contact — and
    // resumes a flank around a body that is no longer there.
    self.ai.blockedTurns = 0;
    self.ai.shoulderTurns = 0;
    return HOLD_INTENT;
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
  self.ai.targetId = chosen?.id ?? null;
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

/** How many of this actor's own living kin are standing next to it. */
function supportOf(actor: EngineActor, ctx: AiCtx): number {
  let count = 0;
  for (const dir of DIR_ORDER) {
    const vector = DIR_VECTORS[dir];
    const neighbour = ctx.actorAt(actor.x + vector.dx, actor.y + vector.dy);
    // `actorAt` is living-bodies-only, so a corpse next to you is not support —
    // which is correct, and grim, and exactly what the elite should think.
    if (neighbour !== undefined && neighbour.kind === actor.kind) count += 1;
  }
  return count;
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
 * CHEBYSHEV, deliberately: see the two-metrics note in the file header. Reach 1
 * is the eight-neighbourhood, and bump-attack is a movement rule.
 */
function chase(self: MonsterActor, target: EngineActor, ctx: AiCtx): Intent {
  if (chebyshev(self, target) <= self.attackRange) {
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

  if (distance <= self.attackRange) {
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
  target: EngineActor,
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
  target: EngineActor,
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
