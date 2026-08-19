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
export function takeShot(engine, actorId, attacks, self, foes, onRefusal) {
  let gap = null;
  for (const attack of attacks) {
    const shootable = foes
      .map((f) => ({ f, d: Math.max(Math.abs(f.x - self.x), Math.abs(f.y - self.y)) }))
      .filter((c) => c.d >= attack.minRange && c.d <= attack.range)
      .sort((a, b) => a.d - b.d)[0];
    if (shootable === undefined) continue;
    gap = shootable.d;
    const shot = engine.submitTalent(actorId, attack.id, { x: shootable.f.x, y: shootable.f.y });
    if (shot?.ok !== false) return { fired: true, gap };
    if (onRefusal !== undefined) onRefusal(attack.id, shot);
  }
  return { fired: false, gap };
}
