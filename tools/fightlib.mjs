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
// PLAIN .mjs AND NOT IN THE TS BUILD, like everything else in tools/.

/**
 * Every single-target attack a class owns that actually reaches, longest first.
 *
 * `single` only: an area talent wants a different question about where to aim
 * it, and these are difficulty probes rather than an AI.
 */
export function rangedAttacks(cls) {
  return (cls.loadout ?? [])
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
function reachable(attack, self, foes) {
  return foes
    .map((f) => ({ f, d: Math.max(Math.abs(f.x - self.x), Math.abs(f.y - self.y)) }))
    .filter((c) => c.d >= attack.minRange && c.d <= attack.range)
    .sort((a, b) => a.d - b.d)[0];
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
export async function bestShot(attacks, self, foes, tryShot) {
  let gap = null;
  for (const attack of attacks) {
    const shootable = reachable(attack, self, foes);
    if (shootable === undefined) continue;
    gap = shootable.d;
    if (await tryShot(attack.id, { x: shootable.f.x, y: shootable.f.y })) {
      return { fired: true, gap };
    }
  }
  return { fired: false, gap };
}

export function takeShot(engine, actorId, attacks, self, foes, onRefusal) {
  let gap = null;
  for (const attack of attacks) {
    const shootable = reachable(attack, self, foes);
    if (shootable === undefined) continue;
    gap = shootable.d;
    const shot = engine.submitTalent(actorId, attack.id, { x: shootable.f.x, y: shootable.f.y });
    if (shot?.ok !== false) return { fired: true, gap };
    if (onRefusal !== undefined) onRefusal(attack.id, shot);
  }
  return { fired: false, gap };
}
