// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
//
// ═══════════════════════════════════════════════════════════════════════════
// HOW A PROBE PLAYS A CHARACTER, IN ONE PLACE.
// ═══════════════════════════════════════════════════════════════════════════
//
// `first-fight.mjs` and `delve-run.mjs` both drive a body through a fight, and
// both got the same two things wrong for the same reasons. This is the shared
// answer, extracted rather than copied, because a hand-written rule in one file
// and a second copy in another is the shape this codebase has been bitten by
// repeatedly — most recently `HAUNTS`, which learned two new tile codes while a
// duplicate in a test did not.
//
// ═══ WHAT IT KNOWS THAT A NAIVE DRIVER DOES NOT ═══
//
//   THE 1.5 TRAP. Melee in this engine is range 1.5 — the diagonal-inclusive
//   adjacency — NOT 1. Selecting "a ranged talent" as `range > 1` picks up the
//   Watchman's Crude Blow and has him shooting people he is standing next to.
//   The same fact made the class picker print "1.5 tiles" for every melee
//   talent. It has produced a wrong answer three times; it is `>= 2` here, once.
//
//   COOLDOWNS. Picking the single longest-reaching talent looks reasonable and
//   makes The Inspector unplayable: its longest is Sniper's Mark, which has a
//   cooldown, so after one shot the driver has nothing and shuffles to the turn
//   cap. Revolver Shot — cooldown zero, the bread-and-butter attack — was never
//   tried. Measured before the fix: 0/40 against two foes. After: 26/40.
//
//   AIM AT WHO IS REACHABLE, not who is nearest. Backing away from the closest
//   monster walks you into the second one.
//
//   THE BAND IS EUCLIDEAN, AND THIS FILE USED TO SAY SO WHILE DOING OTHERWISE.
//   `reachable` measured Chebyshev — `max(|dx|, |dy|)` — and the engine measures
//   `combatDistance`, a straight line (engine/talents.ts#checkTargeting, whose
//   comment names the hazard exactly: *"A Chebyshev ring is a square that
//   reaches 7.07 tiles into its corners"*). So a probe offered shots the engine
//   then refused as `too far away`: 92 of them across one 96-fight sample, and
//   every one cost the driver a whole iteration.
//
//   The 1.5 note below was already Euclidean reasoning — a diagonal neighbour is
//   1.41, which is why 1.5 "admits a diagonal neighbour and nothing further".
//   Under Chebyshev a diagonal is 1 and that sentence is a coincidence. The
//   metric now comes from `sightDistance`, which is `core.fov.distance` itself,
//   so it cannot drift from the engine again.
//
//   AND THE BAND INCLUDES LINE OF SIGHT, because `checkTargeting` does. A foe at
//   a legal distance behind a wall is NOT a shot, and treating it as one is what
//   made The Inspector stall: see `firingSpot`.
//
// PLAIN .mjs AND NOT IN THE TS BUILD, like everything else in tools/.

import { hasLineOfSight, sightDistance } from '../src/shared/sight.ts';

/**
 * Every single-target attack a class owns that actually reaches, longest first.
 *
 * `single` only: an area talent wants a different question about where to aim
 * it, and these are difficulty probes rather than an AI.
 *
 * ═══ `known` IS THE DIFFERENCE BETWEEN A CLASS AND A CHARACTER ═══
 * `cls.loadout` is the whole hotbar the class will EVENTUALLY own. A body that
 * has spent no talent points owns four birth talents, and submitting the rest
 * earns `NotLearned` — 103 refusals in a single 200-iteration run, all of them
 * noise in the log.
 *
 * It also silently corrupted the dead-zone decision, which is the part that
 * mattered: `first-fight.mjs` reads `attacks[attacks.length - 1]` as "my
 * shortest-reaching gun" to decide whether to back away, and for The Inspector
 * that was `sigil` — a talent the level-1 body does not have. The two happen to
 * share `minRange: 3`, so the bug was invisible and would have surfaced the
 * first time a gun disagreed.
 *
 * Optional, so every existing caller keeps the list it had.
 */
export function rangedAttacks(cls, known) {
  return (cls.loadout ?? [])
    .filter((t) => known === undefined || known.has(t.id))
    .filter((t) => t.targeting?.shape === 'single' && (t.targeting.range ?? 0) >= 2)
    .map((t) => ({
      id: t.id,
      range: t.targeting.range ?? 1,
      minRange: t.targeting.minRange ?? 0,
    }))
    .sort((a, b) => b.range - a.range);
}

/**
 * Take the best shot actually available this turn.
 *
 * Tries each attack longest-first and STOPS AT THE FIRST ONE THE ENGINE
 * ACCEPTS, which is what makes a cooldown fall through to the next weapon
 * instead of ending the character's turn.
 *
 * @returns `{ fired, gap }` — `fired` is whether a talent was accepted, `gap` is
 *   the distance to the foe it would have shot, or null when nothing was in any
 *   band (which is the only case where backing off is the whole answer).
 */
/**
 * The nearest foe this attack can actually reach, or undefined.
 *
 * ONE COPY, USED BY BOTH SHOOTERS. The band is `minRange <= d <= range` and the
 * pick is the NEAREST inside it — and the moment that arithmetic exists twice,
 * once for the in-process engine and once for the socket, is the moment the two
 * start disagreeing about what "in range" means. This file exists because a rule
 * written down twice is how this codebase gets bitten.
 */
function reachable(attack, self, foes, level) {
  return (
    foes
      .map((f) => ({ f, d: sightDistance(self, f) }))
      // THE THREE TERMS OF `checkTargeting`, IN ITS ORDER. `> range` then
      // `< minRange` then line of sight, and LoS only beyond distance 1 — the
      // engine skips the bresenham walk for a neighbour and so does this.
      .filter((c) => c.d <= attack.range && c.d >= attack.minRange)
      .filter((c) => level === undefined || c.d <= 1 || hasLineOfSight(level, self, c.f))
      .sort((a, b) => a.d - b.d)[0]
  );
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE NEAREST TILE THIS BODY COULD ACTUALLY SHOOT FROM, OR `null`.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * THIS EXISTS BECAUSE "CLOSE OR BACK OFF" IS NOT ENOUGH FOR A DEAD ZONE, and
 * the missing third option cost two of The Inspector's twenty-four fights.
 *
 * Measured before this function existed, seed `first-fight:inspector:11`, and
 * the log is a perfect two-cycle for all 200 iterations of the cap:
 *
 *     it  dist  action                  why
 *     ..  3.61  move nw (close)         revolver_shot refused: no line of sight
 *     ..  2.24  move se (BACK OFF)      nothing in band — 2.24 is inside minRange 3
 *     ..  3.61  move nw (close)         revolver_shot refused: no line of sight
 *
 * At 3.61 there was a wall on the line, so the shot was refused — but the foe
 * WAS in the distance band, so the driver's `gap === null` test for "back off"
 * stayed false and it closed instead. At 2.24 nothing was in band, so it backed
 * off. Two tiles, forever, against one monster that could not see it either.
 *
 * A player in that spot does neither: they STEP SIDEWAYS to clear the wall. So
 * the driver gets a real goal rather than a direction, which also makes it
 * terminate — it is walking to a named tile instead of pacing a gradient.
 *
 * DETERMINISTIC, because a probe that picks differently on two runs of the same
 * seed cannot be compared against itself. The scan order is fixed — `dy` then
 * `dx`, both ascending — and the first tile at the lowest step count wins, so a
 * tie breaks on that order and never on a draw.
 *
 * `steps` IS CHEBYSHEV, AND THAT IS NOT THE BUG THIS FUNCTION FIXES. "How far
 * away is that tile" is a question about MOVEMENT, which is eight-directional
 * here, so a diagonal is one step. Only the TARGETING band is Euclidean, and it
 * is Euclidean because `checkTargeting` is. Two questions, two metrics, on
 * purpose.
 */
export function firingSpot(attacks, self, foes, level, walkable, radius = 6) {
  let best = null;
  for (let dy = -radius; dy <= radius; dy += 1) {
    for (let dx = -radius; dx <= radius; dx += 1) {
      // NEVER THE TILE ALREADY STANDING ON, so this always means "somewhere
      // ELSE". A talent on COOLDOWN is still inside the distance band, so
      // without this the answer to "I could not shoot" is sometimes "stay here",
      // `firstStep` is asked to path a body to its own tile, answers null, and
      // the caller's `?? 'e'` walks east for no reason.
      if (dx === 0 && dy === 0) continue;
      const spot = { x: self.x + dx, y: self.y + dy };
      if (!walkable(spot.x, spot.y)) continue;
      // Somebody standing there is not a place you can stand.
      if (foes.some((f) => f.x === spot.x && f.y === spot.y)) continue;
      if (!attacks.some((attack) => reachable(attack, spot, foes, level) !== undefined)) continue;
      const steps = Math.max(Math.abs(dx), Math.abs(dy));
      if (best === null || steps < best.steps) best = { spot, steps };
    }
  }
  return best === null ? null : best.spot;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * EVERY SINGLE-TARGET ATTACK IN A `loadout` FRAME THAT REACHES, LONGEST FIRST.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `rangedAttacks` above reads a CLASS DEFINITION, where the numbers live under
 * `targeting`. The wire flattens them — `LoadoutTalent` carries `shape`, `range`
 * and `minRange` directly — so a socket driver needs its own reader.
 *
 * IT NEEDS THE SAME `>= 2`, AND THAT IS THE ONLY REASON THIS IS HERE RATHER THAN
 * INLINE IN A PROBE. Melee in this engine is range 1.5, so `range > 1` selects
 * the Watchman's Crude Blow and has him shooting people he is standing next to.
 * That mistake has been made three times in this repo; it is written once, here,
 * in both readers.
 */
export function loadoutAttacks(loadout) {
  return (loadout ?? [])
    .filter((t) => t.shape === 'single' && (t.range ?? 0) >= 2)
    .map((t) => ({ id: t.id, range: t.range ?? 1, minRange: t.minRange ?? 0 }))
    .sort((a, b) => b.range - a.range);
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * EVERY SINGLE-TARGET ATTACK, REACHING OR NOT — WHICH IS A DIFFERENT QUESTION.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `loadoutAttacks` answers "what can I hit from a distance", which is what a
 * KITING driver needs. This answers "what can I hit this thing with right now",
 * which is what a driver that just wants to win needs — and for a melee class
 * they are not the same list at all. Measured: The Watchman's entire kit is
 * range 1.5, so the reaching filter returns NOTHING and a driver built around
 * "shoot, then close" spends the whole game walking into people.
 *
 * THE 1.5 TRAP IS STILL HANDLED, and better: it lives in the BAND rather than in
 * a filter. `bestShot` asks whether the foe is within `range`, and 1.5 admits a
 * diagonal neighbour and nothing further — which is what melee range MEANS. The
 * three wrong answers this repo has produced all came from turning that number
 * into a category test (`> 1` is ranged) instead of leaving it as a distance.
 */
export function loadoutStrikes(loadout) {
  return (loadout ?? [])
    .filter((t) => t.shape === 'single')
    .map((t) => ({ id: t.id, range: t.range ?? 1, minRange: t.minRange ?? 0 }))
    .sort((a, b) => b.range - a.range);
}

/**
 * The self-buffs, which cost a turn and are worth it once.
 *
 * Fired at the top of a fight and never again while they are cooling. A driver
 * that ignores them is measuring a character playing with part of its kit
 * switched off, which is exactly the complaint this file was written about.
 */
export function loadoutBuffs(loadout) {
  return (loadout ?? []).filter((t) => t.shape === 'self').map((t) => ({ id: t.id }));
}

/**
 * Take the best shot available, over anything.
 *
 * The transport-agnostic twin of `takeShot`: it owns the ORDER (longest first)
 * and the BANDS (`reachable`), and hands the actual attempt to the caller, which
 * is the only part a socket and an engine genuinely differ on. `tryShot` returns
 * whether the attempt was ACCEPTED — over a socket that means "no refusal frame
 * came back", which is the wire's version of `shot?.ok !== false`.
 *
 * STOPS AT THE FIRST ACCEPTED ATTACK, never at the longest-reaching one. That is
 * the cooldown lesson this file was extracted for: The Inspector's longest talent
 * is Sniper's Mark, which cools down, so a driver that picks by reach alone fires
 * once and then shuffles to the turn cap with Revolver Shot untouched. Measured
 * before the fix: 0 of 40 against two foes. After: 26 of 40.
 */
export async function bestShot(attacks, self, foes, tryShot, level) {
  let gap = null;
  for (const attack of attacks) {
    const shootable = reachable(attack, self, foes, level);
    if (shootable === undefined) continue;
    gap = shootable.d;
    if (await tryShot(attack.id, { x: shootable.f.x, y: shootable.f.y })) {
      return { fired: true, gap };
    }
  }
  return { fired: false, gap };
}

export function takeShot(engine, actorId, attacks, self, foes, onRefusal, level) {
  let gap = null;
  for (const attack of attacks) {
    const shootable = reachable(attack, self, foes, level);
    if (shootable === undefined) continue;
    gap = shootable.d;
    const shot = engine.submitTalent(actorId, attack.id, { x: shootable.f.x, y: shootable.f.y });
    if (shot?.ok !== false) return { fired: true, gap };
    if (onRefusal !== undefined) onRefusal(attack.id, shot);
  }
  return { fired: false, gap };
}
