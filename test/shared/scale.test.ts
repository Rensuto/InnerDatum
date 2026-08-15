import { describe, expect, it } from 'vitest';

import {
  FLAT_RESIST_INTERVAL,
  RESCALE_INTERVAL,
  bound,
  combatScale,
  combatTalentLimit,
  combatTalentScale,
  combatTalentWeaponDamage,
  getTierDiff,
  rescaleCombatStats,
  rescaleDamage,
} from '../../src/shared/scale.ts';

/**
 * ===========================================================================
 * rescale(71) === 43 IS THE POINT OF THIS FILE.
 * ===========================================================================
 *
 * The te4 wiki and most third-party documentation quote 43.67. Combat.lua:1459
 * ends the function in `math.floor(result)` and returns 43. Every derived stat
 * in the game passes through here exactly once, so a missing floor makes every
 * accuracy, defence, power and save in the game a fraction of a point high —
 * which never crashes, never fails a plumbing test, and quietly shifts every
 * to-hit roll by up to 2.5 percentage points.
 */
describe('rescaleCombatStats — Combat.lua:1444-1462', () => {
  it('returns 43 for 71, not 43.67 — the floor at Combat.lua:1459 is real', () => {
    // Trace: 71 -> 45.5 -> 43.667 -> (47.75 is not smaller, stop) -> floor = 43
    expect(rescaleCombatStats(71)).toBe(43);
  });

  it('matches the documented vectors', () => {
    // The first tier is 1:1 — Combat.lua:1443, "the first twenty ranks cost 1 point each"
    expect(rescaleCombatStats(17)).toBe(17);
    expect(rescaleCombatStats(20)).toBe(20);
    // The second tier costs two raw points each
    expect(rescaleCombatStats(50)).toBe(35);
    expect(rescaleCombatStats(60)).toBe(40);
  });

  /**
   * THE GOLDEN TABLE.
   *
   * Every row is the Lua loop at Combat.lua:1444-1462 run by hand. `result`
   * starts at `x` and is replaced by `tier + (x - base) / shift` for as long as
   * that is smaller; the tiers are the straight lines
   *
   *     T1: x                T2: 20 + (x-20)/2     T3: 40 + (x-60)/3
   *     T4: 60 + (x-120)/4   T5: 80 + (x-200)/5
   *
   * and the answer is `math.floor` of the smallest one reached (:1459). Each
   * trace below names the winning line, so a failing row says WHICH tier the
   * implementation lost rather than only that a number moved.
   */
  it('reproduces the whole curve, tier by hand-worked tier — Combat.lua:1444-1462', () => {
    const VECTORS: readonly (readonly [raw: number, rescaled: number, trace: string])[] = [
      [0, 0, 'T2 = 10 is not smaller than 0, so T1 wins immediately'],
      [1, 1, 'T2 = 10.5 > 1 — inside the first tier nothing is ever cheaper'],
      [10, 10, 'T1, identity'],
      [17, 17, 'T1, identity'],
      [19, 19, 'T2 = 19.5 is NOT smaller than 19 — the last identity point'],
      [20, 20, 'T1 = T2 = 20 exactly; ties keep T1 (`<`, not `<=`)'],
      [21, 20, 'T2 = 20.5, floored to 20 — one raw point past the tier buys nothing'],
      [22, 21, 'T2 = 21.0'],
      [30, 25, 'T2 = 25, T3 = 30 is worse'],
      [40, 30, 'T2 = 30, T3 = 33.33 is worse'],
      [45, 32, 'T2 = 32.5 floored — half a rescaled point is simply lost'],
      [50, 35, 'T2 = 35, T3 = 36.67 is worse'],
      [60, 40, 'T2 = T3 = 40; the second breakpoint'],
      [71, 43, 'T2 = 45.5 then T3 = 43.667, floored to 43 — THE headline case'],
      [80, 46, 'T3 = 46.67 floored; T4 = 50 is worse'],
      [94, 51, 'T3 = 51.33 floored'],
      [100, 53, 'T3 = 53.33 floored'],
      [110, 56, 'T3 = 56.67 floored'],
      [120, 60, 'T3 = T4 = 60; the third breakpoint, and it is exact'],
      [200, 80, 'T4 = T5 = 80; the fourth breakpoint'],
    ];

    for (const [raw, rescaled, trace] of VECTORS) {
      expect({ raw, out: rescaleCombatStats(raw), trace }).toEqual({ raw, out: rescaled, trace });
    }
  });

  it('is the IDENTITY below the first tier boundary — Combat.lua:1443', () => {
    // "the first twenty ranks cost 1 point each". Every point of the first
    // twenty is worth exactly one, which is what makes an early item legible.
    for (let raw = 0; raw <= RESCALE_INTERVAL; raw += 1) {
      expect(rescaleCombatStats(raw)).toBe(raw);
    }
  });

  it('COMPRESSES above it, and the compression widens without bound', () => {
    // The other half of the design: past the boundary a raw point is worth
    // strictly less than a rescaled one, and the shortfall grows with every
    // tier. If a "fix" ever makes this linear again, gear stacks forever.
    let shortfall = 0;
    for (let raw = RESCALE_INTERVAL + 2; raw <= 300; raw += 1) {
      const out = rescaleCombatStats(raw);
      expect(out).toBeLessThan(raw);
      const gap = raw - out;
      expect(gap).toBeGreaterThanOrEqual(shortfall);
      shortfall = gap;
    }
    // 300 raw is worth 100 rescaled: two thirds of the sheet has evaporated.
    expect(rescaleCombatStats(300)).toBe(100);
  });

  it('is MONOTONIC on both intervals — never rewards a point with a loss', () => {
    // Monotonicity is separate from concavity and is the property a caller
    // actually relies on: `+1 raw` must never mean `-1 defence`. Both curves,
    // because flat damage armour runs on the 40 (Combat.lua:2216).
    for (const interval of [RESCALE_INTERVAL, FLAT_RESIST_INTERVAL]) {
      for (let raw = -20; raw < 400; raw += 1) {
        expect(rescaleCombatStats(raw + 1, interval)).toBeGreaterThanOrEqual(
          rescaleCombatStats(raw, interval),
        );
      }
    }
  });

  it('floors, so the tier boundary is visible', () => {
    // 21 raw -> 20.5 rescaled -> 20. One raw point past the first tier buys
    // nothing at all until the second one arrives.
    expect(rescaleCombatStats(21)).toBe(20);
    expect(rescaleCombatStats(22)).toBe(21);
  });

  it('compresses hard at the top', () => {
    expect(rescaleCombatStats(94)).toBe(51);
    expect(rescaleCombatStats(100)).toBe(53);
    expect(rescaleCombatStats(110)).toBe(56);
  });

  it('passes zero and negatives straight through', () => {
    expect(rescaleCombatStats(0)).toBe(0);
    // A stat driven negative by debuffs is floored by its GETTER, not here.
    expect(rescaleCombatStats(-5)).toBe(-5);
  });

  it('is concave — a raw point is never worth more than a rescaled point', () => {
    // This is the whole design: +5 gear matters at level 3 and not at level 30.
    for (let x = 0; x < 300; x += 1) {
      const here = rescaleCombatStats(x);
      const next = rescaleCombatStats(x + 1);
      expect(next).toBeGreaterThanOrEqual(here);
      expect(next - here).toBeLessThanOrEqual(1);
    }
  });

  it('honours the interval-40 curve flat damage armour uses — Combat.lua:2216', () => {
    expect(FLAT_RESIST_INTERVAL).toBe(40);
    // Same input, two curves. Dropping the 40 back to the default 20 costs a
    // flat-armour actor ten points of reduction and nothing else changes.
    expect(rescaleCombatStats(50, FLAT_RESIST_INTERVAL)).toBe(45);
    expect(rescaleCombatStats(50)).toBe(35);
  });

  it('terminates on the degenerate inputs rather than spinning', () => {
    // No iteration guard exists in the Lua and none is needed: every one of
    // these fails `nextresult < result` on the first pass.
    expect(rescaleCombatStats(Number.POSITIVE_INFINITY)).toBe(Number.POSITIVE_INFINITY);
    expect(rescaleCombatStats(Number.NEGATIVE_INFINITY)).toBe(Number.NEGATIVE_INFINITY);
    expect(Number.isNaN(rescaleCombatStats(Number.NaN))).toBe(true);
  });

  it('is NOT distributive — rescale per source destroys the design', () => {
    // The trap this whole file exists to prevent: rescaling each item's bonus
    // separately restores linear stacking, and every unit test still passes.
    expect(rescaleCombatStats(40) + rescaleCombatStats(40)).not.toBe(rescaleCombatStats(80));
    expect(rescaleCombatStats(40) + rescaleCombatStats(40)).toBeGreaterThan(rescaleCombatStats(80));
  });
});

describe('rescaleDamage — Combat.lua:1437-1441', () => {
  it('raises positive damage by the 1.04 power', () => {
    expect(rescaleDamage(100)).toBeCloseTo(120.2264, 4);
    expect(rescaleDamage(1)).toBeCloseTo(1, 10);
  });

  it('leaves zero and negatives alone — Combat.lua:1438', () => {
    expect(rescaleDamage(0)).toBe(0);
    expect(rescaleDamage(-7)).toBe(-7);
  });
});

describe('combatTalentScale — Combat.lua:1515-1536', () => {
  it('hits `low` at talent level 1 and `high` at talent level 5', () => {
    expect(combatTalentScale(1, 10, 50)).toBeCloseTo(10, 10);
    expect(combatTalentScale(5, 10, 50)).toBeCloseTo(50, 10);
  });

  it('EXTRAPOLATES past 5 and is never clamped there', () => {
    // ActorTalents.lua:826 multiplies raw points by category mastery, so 5.2 is
    // a legal talent level. Clamping at 5 deletes the entire reward for mastery.
    expect(combatTalentScale(10, 10, 50)).toBeGreaterThan(50);
    expect(combatTalentScale(5.2, 10, 50)).toBeGreaterThan(combatTalentScale(5, 10, 50));
  });

  it('treats a non-positive talent level as 0.1 and floors the result at 0', () => {
    // Combat.lua:1517 and :1533. An unlearned talent yields 0, never a negative.
    expect(combatTalentScale(0, 10, 50)).toBe(0);
    expect(combatTalentScale(-3, 10, 50)).toBe(0);
  });

  it('supports the log10 variant at Combat.lua:1521-1523', () => {
    expect(combatTalentScale(1, 10, 50, 'log')).toBeCloseTo(10, 10);
    expect(combatTalentScale(5, 10, 50, 'log')).toBeCloseTo(50, 10);
  });
});

describe('combatTalentLimit — Combat.lua:1576-1593', () => {
  it('fits both anchors and approaches the limit without reaching it', () => {
    expect(combatTalentLimit(1, 100, 20, 50)).toBeCloseTo(20, 8);
    expect(combatTalentLimit(5, 100, 20, 50)).toBeCloseTo(50, 8);
    expect(combatTalentLimit(1000, 100, 20, 50)).toBeLessThan(100);
    expect(combatTalentLimit(1000, 100, 20, 50)).toBeGreaterThan(99);
  });

  it('supports the two-point form when `low` is omitted — Combat.lua:1588-1591', () => {
    expect(combatTalentLimit(5, 100, undefined, 50)).toBeCloseTo(50, 8);
  });
});

describe('combatTalentWeaponDamage — Combat.lua:1782-1788', () => {
  it('reaches `max` exactly at talent level 5', () => {
    // Sniper's Mark ships as x1.65 (game-design.md § 2).
    expect(combatTalentWeaponDamage(5, 1, 1.65)).toBeCloseTo(1.65, 10);
    expect(combatTalentWeaponDamage(1, 1, 1.65)).toBeCloseTo(1.2907, 4);
  });

  it('counts the companion talent at half weight — Combat.lua:1783', () => {
    expect(combatTalentWeaponDamage(5, 1, 1.65, 2)).toBeGreaterThan(1.65);
  });
});

describe('getTierDiff — Combat.lua:325-329', () => {
  it('measures whole 20-point tiers only', () => {
    // The sample log in game-design.md § 11: "Off-guard (tier 2 > 1, 1 turn)".
    expect(getTierDiff(41, 33)).toBe(1);
    expect(getTierDiff(60, 10)).toBe(2);
  });

  it('never goes negative, and treats tier 0 as tier 1', () => {
    expect(getTierDiff(0, 0)).toBe(0);
    expect(getTierDiff(10, 90)).toBe(0);
    // max(ceil(atk/20), 1) — a 0-power attacker is still tier 1, not tier 0.
    expect(getTierDiff(0, 21)).toBe(0);
  });

  it('floors its inputs before tiering — Combat.lua:326-327', () => {
    expect(getTierDiff(40.9, 20)).toBe(getTierDiff(40, 20));
  });
});

describe('bound — engine/utils.lua:1957-1961', () => {
  it('clamps on either side and treats a missing bound as no bound', () => {
    expect(bound(5, 0, 3)).toBe(3);
    expect(bound(-5, 0, 3)).toBe(0);
    expect(bound(5, undefined, 3)).toBe(3);
    expect(bound(5, 0, undefined)).toBe(5);
    // Zero is a real bound. In Lua `if min then` is true for 0; `undefined` is
    // the faithful translation of `nil`, not `0`.
    expect(bound(-1, 0)).toBe(0);
  });
});

describe('combatScale — Combat.lua:1471-1477', () => {
  it('fits the two anchors it is given', () => {
    expect(combatScale(10, 5, 10, 25, 100)).toBeCloseTo(5, 8);
    expect(combatScale(100, 5, 10, 25, 100)).toBeCloseTo(25, 8);
  });
});
