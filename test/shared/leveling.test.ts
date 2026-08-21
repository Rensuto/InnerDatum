// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/modules/tome/class/Actor.lua:1740-1752, :3818-3822, :3884-3885.
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" — https://te4.org/license

import { describe, expect, it } from 'vitest';

import { ALCHEMIST, INSPECTOR, WATCHMAN } from '../../src/server/content/classes.ts';
import {
  LIFE_PER_CON,
  PLAYER_RANK,
  RANK_VALUE,
  lifeGainForLevel,
  lifeGainedTo,
  maxLifeFor,
  rankLifeAdjust,
  spreadStatPoints,
  statPointsGainedTo,
} from '../../src/shared/leveling.ts';
import { MAX_CHARACTER_LEVEL } from '../../src/shared/progression.ts';
import { ActorRank } from '../../src/shared/protocol.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *   THE ONE NUMBER A LEVEL MOVES ON ITS OWN.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `maxHp` was an authored constant written into a body once at creation. A
 * level-50 Watchman had the seventy-two hit points he started with, while
 * upstream's nearest analogue is around 1,492 — the cap moved to 50 and nothing
 * about a character's durability moved with it.
 */

describe('the life curve', () => {
  it('matches upstream cumulative multipliers exactly', () => {
    /**
     * ═══ THE ASSERTION THAT PROVES THE PORT ═══
     * A rank-3 body's total gain is `life_rating × k`, and upstream's k is
     * 11.25 at level 10, 34.5 at 25, 85.75 at 50. Those three numbers are the
     * whole of the arithmetic: if the rank coefficient, the `1 + level/40` term
     * or the off-by-one on `level` were wrong, none of them would land.
     */
    expect(lifeGainedTo(1, 10, PLAYER_RANK)).toBeCloseTo(11.25, 6);
    expect(lifeGainedTo(1, 25, PLAYER_RANK)).toBeCloseTo(34.5, 6);
    expect(lifeGainedTo(1, 50, PLAYER_RANK)).toBeCloseTo(85.75, 6);
  });

  it('grants nothing for level 1, because nobody levelled up to it', () => {
    expect(lifeGainForLevel(16, 1, PLAYER_RANK)).toBe(0);
    expect(lifeGainedTo(16, 1, PLAYER_RANK)).toBe(0);
  });

  it('grows the per-level gain itself, not just the total', () => {
    /**
     * `1 + level/40` means a level is worth MORE the later it arrives. That is
     * what makes the back half of a career feel like progress rather than a
     * flattening curve, and it is easy to lose by hoisting the coefficient out.
     */
    const early = lifeGainForLevel(16, 2, PLAYER_RANK);
    const late = lifeGainForLevel(16, 50, PLAYER_RANK);
    expect(late).toBeGreaterThan(early);
    expect(late / early).toBeGreaterThan(1.5);
  });

  it('never grants less than one hit point', () => {
    // Upstream's `math.max(..., 1)`. Without it a rating of 0 gives a body that
    // levels for fifty levels and gets no tougher at all.
    expect(lifeGainForLevel(0, 2, RANK_VALUE[ActorRank.Normal])).toBe(1);
  });

  it('orders the ranks the way upstream does', () => {
    // A boss must out-grow an elite, and an elite a normal — at every level, not
    // just at the top. Our three words map onto upstream's numeric ladder and
    // this is the check that the mapping did not invert anything.
    for (const level of [2, 10, 25, 50]) {
      const normal = rankLifeAdjust(10, level, RANK_VALUE[ActorRank.Normal]);
      const player = rankLifeAdjust(10, level, PLAYER_RANK);
      const elite = rankLifeAdjust(10, level, RANK_VALUE[ActorRank.Elite]);
      const boss = rankLifeAdjust(10, level, RANK_VALUE[ActorRank.Boss]);
      expect(normal).toBeLessThan(player);
      expect(player).toBeLessThan(elite);
      expect(elite).toBeLessThan(boss);
    }
  });
});

describe('Constitution finally buys something', () => {
  it('pays four hit points a point', () => {
    // Actor.lua:3884-3885. Before this, CON fed one physical save and nothing
    // else — every point of it in a 157-point career was close to dead currency.
    const none = maxLifeFor(72, 16, 10, PLAYER_RANK, 0);
    const ten = maxLifeFor(72, 16, 10, PLAYER_RANK, 10);
    expect(ten - none).toBe(10 * LIFE_PER_CON);
  });

  it('never lets a negative spend shrink a body', () => {
    expect(maxLifeFor(72, 16, 10, PLAYER_RANK, -50)).toBe(maxLifeFor(72, 16, 10, PLAYER_RANK, 0));
  });
});

describe('the three classes, across a career', () => {
  it('starts every one of them at exactly its authored base', () => {
    /**
     * THE SAFETY PROPERTY OF THE WHOLE CHANGE. At level 1 with nothing spent,
     * every character is the body it was before any of this existed — so this
     * lands without silently re-tuning the early game that people are playing.
     */
    for (const c of [WATCHMAN, INSPECTOR, ALCHEMIST]) {
      expect(maxLifeFor(c.maxHp, c.lifeRating, 1, PLAYER_RANK, 0), c.name).toBe(c.maxHp);
    }
  });

  it('widens the gap between a front-liner and a mixer as they climb', () => {
    /**
     * A flat offset would keep the Watchman exactly eighteen hit points ahead
     * forever. Because the rating is multiplied by a coefficient that itself
     * grows, the SPREAD widens — which is what makes a front-liner feel like a
     * different kind of thing at 50 rather than merely ahead.
     */
    const gapAt = (level: number): number =>
      maxLifeFor(WATCHMAN.maxHp, WATCHMAN.lifeRating, level, PLAYER_RANK, 0) -
      maxLifeFor(ALCHEMIST.maxHp, ALCHEMIST.lifeRating, level, PLAYER_RANK, 0);

    expect(gapAt(MAX_CHARACTER_LEVEL)).toBeGreaterThan(gapAt(10));
    expect(gapAt(10)).toBeGreaterThan(gapAt(1));
  });

  it('keeps the class order intact at every level', () => {
    for (const level of [1, 10, 25, MAX_CHARACTER_LEVEL]) {
      const w = maxLifeFor(WATCHMAN.maxHp, WATCHMAN.lifeRating, level, PLAYER_RANK, 0);
      const i = maxLifeFor(INSPECTOR.maxHp, INSPECTOR.lifeRating, level, PLAYER_RANK, 0);
      const a = maxLifeFor(ALCHEMIST.maxHp, ALCHEMIST.lifeRating, level, PLAYER_RANK, 0);
      expect(w, `level ${String(level)}`).toBeGreaterThan(i);
      expect(i, `level ${String(level)}`).toBeGreaterThan(a);
    }
  });
});

describe('stat points, so a scaled body can still threaten anybody', () => {
  it('matches the player grant for a player-ranked body', () => {
    // 3 a level, and `getRankStatAdjust` is 0 at rank 3 — so a monster of the
    // player's rank accrues exactly what a player is handed to spend.
    expect(statPointsGainedTo(MAX_CHARACTER_LEVEL, PLAYER_RANK)).toBe(
      (MAX_CHARACTER_LEVEL - 1) * 3,
    );
  });

  it('gives the big ranks more, as upstream does', () => {
    expect(statPointsGainedTo(25, RANK_VALUE[ActorRank.Boss])).toBeGreaterThan(
      statPointsGainedTo(25, RANK_VALUE[ActorRank.Normal]),
    );
  });

  it('deals round-robin, so a body stays recognisably itself', () => {
    /**
     * All-in-one-stat would make a monster unhittable or harmless depending on
     * which stat you looked at. Upstream's own `auto_stats` tables name two or
     * three for the same reason.
     */
    const grown = spreadStatPoints({ str: 10, dex: 10, con: 10 }, ['str', 'con'], 10);
    expect(grown.str).toBe(15);
    expect(grown.con).toBe(15);
    expect(grown.dex, 'a stat it does not lead with was raised').toBe(10);
  });

  it('leaves a body with no priorities exactly as authored', () => {
    const same = spreadStatPoints({ str: 10 }, [], 999);
    expect(same).toEqual({ str: 10 });
  });
});
