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
  STATS_PER_LEVEL,
  lifeGainForLevel,
  lifeGainedTo,
  maxLifeFor,
  rankLifeAdjust,
  rankStatAdjust,
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

  it('shrinks a body dragged below its class Constitution', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THIS ASSERTION USED TO SAY THE OPPOSITE, AND THE REVERSAL IS THE POINT.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * It read *"never lets a negative spend shrink a body"* and floored the
     * parameter at zero, which was right when the parameter meant POINTS SPENT:
     * a player cannot buy minus fifty points, so a negative was corrupt input.
     *
     * The parameter now means Constitution ABOVE THE CLASS'S OWN, and a negative
     * is an ordinary fact about a cursed body. Upstream runs the same
     * `+ 4 * v` for it (Actor.lua:3884-3885 via `onStatChange`), so the clamp
     * would now be a free immunity to any Constitution drain we ever author.
     */
    const level = maxLifeFor(72, 16, 10, PLAYER_RANK, 0);
    expect(maxLifeFor(72, 16, 10, PLAYER_RANK, -5)).toBe(level - 5 * LIFE_PER_CON);
  });

  it('leaves a live body even when the drain exceeds the pool', () => {
    // The one floor that survives: a readout of `-128/72` is a number nothing
    // in this game can draw, and a body at zero is a death the damage pipeline
    // is supposed to declare, not an arithmetic accident.
    expect(maxLifeFor(72, 16, 10, PLAYER_RANK, -5000)).toBe(1);
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

// ---------------------------------------------------------------------------
// rankStatAdjust — Actor.lua:1701-1712, value for value
// ---------------------------------------------------------------------------

describe('rankStatAdjust', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE LADDER IS UPSTREAM'S, INCLUDING THE NEGATIVE RUNGS.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * This function had no test and the wrong numbers, and its docblock described
   * upstream falsely ("returns 0 for ranks 1-3") while citing a different
   * function's line range. Upstream returns NEGATIVE adjustments for the two
   * weakest ranks, which is the half a "rises for the big ones" reading loses.
   */
  it('matches Actor.lua:1701-1712 at every listed rank', () => {
    expect(rankStatAdjust(1)).toBe(-1);
    expect(rankStatAdjust(2)).toBe(-0.5);
    expect(rankStatAdjust(3)).toBe(0);
    expect(rankStatAdjust(3.2)).toBe(0.5);
    expect(rankStatAdjust(3.5)).toBe(1);
    expect(rankStatAdjust(4)).toBe(1);
    expect(rankStatAdjust(5)).toBe(1);
    expect(rankStatAdjust(10)).toBe(2.5);
    expect(rankStatAdjust(12)).toBe(2.5);
  });

  it('falls through to zero for a rank upstream does not list', () => {
    // ═══ EQUALITY, NOT RANGES ═══
    // The previous version was a `<=` ladder, so 2.5 was swept up by the
    // nearest bound. Upstream tests equality and falls through, so an unlisted
    // rank gets nothing — which is what makes adding a rank safe.
    expect(rankStatAdjust(2.5)).toBe(0);
    expect(rankStatAdjust(6)).toBe(0);
    expect(rankStatAdjust(9.9)).toBe(0);
  });

  it('gives the three ranks this game ships upstream’s numbers', () => {
    // `RANK_VALUE` maps ours to upstream's 2 / 3.5 / 4, `PLAYER_RANK` is 3.
    // Normal was 3 stats a level and is 2.5; Boss was 5 and is 4.
    expect(STATS_PER_LEVEL + rankStatAdjust(RANK_VALUE[ActorRank.Normal])).toBe(2.5);
    expect(STATS_PER_LEVEL + rankStatAdjust(PLAYER_RANK)).toBe(3);
    expect(STATS_PER_LEVEL + rankStatAdjust(RANK_VALUE[ActorRank.Elite])).toBe(4);
    expect(STATS_PER_LEVEL + rankStatAdjust(RANK_VALUE[ActorRank.Boss])).toBe(4);
  });
});
