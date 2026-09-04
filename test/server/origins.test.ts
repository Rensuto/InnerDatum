import { describe, expect, it } from 'vitest';

import { WATCHMAN } from '../../src/server/content/classes.ts';
import {
  BASELINE_LIFE_RATING,
  CITYBORN,
  DEFAULT_ORIGIN,
  INDEXED,
  ORIGINS,
  combatWithOrigin,
  originLifeDelta,
  originOf,
} from '../../src/server/content/origins.ts';
import { PLAYER_RANK, maxLifeFor } from '../../src/shared/leveling.ts';
import { expChart, gainExp } from '../../src/shared/progression.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ORIGINS — human.lua's two subraces, and the ten that was already here.
 * ═══════════════════════════════════════════════════════════════════════════
 */

describe('the baseline origin changes nothing, which is the whole compatibility claim', () => {
  /**
   * ═══ THE ONE ASSERTION THAT MATTERS FOR EVERY EXISTING CHARACTER ═══
   * `ClassDef.lifeRating` has always carried the baseline origin's ten inside it
   * (Watchman 16 = Bulwark 6 + Cornac 10). So the baseline contributes a delta of
   * ZERO, and a body that never chose an origin is sized exactly as it was
   * before origins existed. If this fails, everybody's hit points moved.
   */
  it('contributes no life at all', () => {
    expect(originLifeDelta(CITYBORN)).toBe(0);
  });

  it('is what a body with no origin recorded gets', () => {
    expect(originOf(undefined)).toBe(CITYBORN);
    expect(DEFAULT_ORIGIN).toBe(CITYBORN);
  });

  /** An origin this build no longer ships is the baseline, never a crash. */
  it('is what an unknown origin falls back to', () => {
    expect(originOf('origin_from_a_later_build')).toBe(CITYBORN);
  });

  /**
   * BY IDENTITY, NOT BY VALUE. `world.ts` keeps "the class was applied WHOLESALE,
   * never blended" assertable with `toBe`, and Cityborn declares no modifiers, so
   * that assertion has to go on holding for the origin every character has.
   */
  it('hands the class sheet straight back, the same object', () => {
    expect(combatWithOrigin(WATCHMAN.combat, CITYBORN)).toBe(WATCHMAN.combat);
  });

  /** `experience = 1.0` (human.lua:127) — no penalty, so the chart is untouched. */
  it('leaves the experience chart exactly where it was', () => {
    for (const level of [2, 5, 10, 20, 50]) {
      expect(expChart(level, CITYBORN.experienceMult)).toBe(expChart(level));
    }
  });
});

describe('the Indexed pay for what they get', () => {
  /**
   * `inc_stats = { str=1, mag=1, dex=1, wil=1 }` (human.lua:96) — FOUR, and the
   * two it leaves out are the point: Constitution and Cunning are untouched, so
   * this is not simply a better body.
   */
  it('raises four stats and not the other two', () => {
    const before = WATCHMAN.combat.stats ?? {};
    const after = combatWithOrigin(WATCHMAN.combat, INDEXED).stats ?? {};

    expect(after.str).toBe((before.str ?? 0) + 1);
    expect(after.dex).toBe((before.dex ?? 0) + 1);
    expect(after.mag).toBe((before.mag ?? 0) + 1);
    expect(after.wil).toBe((before.wil ?? 0) + 1);
    // …AND LEAVES THESE ALONE.
    expect(after.con).toBe(before.con);
    expect(after.cun).toBe(before.cun);
  });

  /** ADDED, never replacing — and never mutating the shared class sheet. */
  it('does not touch the class sheet every body of that class shares', () => {
    const before = WATCHMAN.combat.stats?.str;
    combatWithOrigin(WATCHMAN.combat, INDEXED);
    expect(WATCHMAN.combat.stats?.str).toBe(before);
  });

  /**
   * `life_rating = 11` (human.lua:106) against the baseline's 10 — ONE per
   * level, compounding, which is what a life rating is. Measured as hit points
   * at 20 rather than as the delta, so this fails if the composition stops
   * reaching `maxLifeFor` at all.
   */
  it('is worth real hit points by level 20', () => {
    const base = maxLifeFor(WATCHMAN.maxHp, WATCHMAN.lifeRating, 20, PLAYER_RANK, 0);
    const indexed = maxLifeFor(
      WATCHMAN.maxHp,
      WATCHMAN.lifeRating + originLifeDelta(INDEXED),
      20,
      PLAYER_RANK,
      0,
    );
    expect(originLifeDelta(INDEXED)).toBe(1);
    expect(indexed).toBeGreaterThan(base);
  });

  /**
   * ═══ THE COUNTERWEIGHT ═══
   * `experience = 1.15` (human.lua:97) through `engine/Birther.lua:419`, which scales
   * the chart `getExpChart` compares against — so every level costs 15% more.
   * THE PENALTY IS ON THE THRESHOLD, NOT ON THE AWARD, which is the distinction
   * worth pinning: a kill is worth the same to everybody.
   */
  it('needs fifteen per cent more experience for every level', () => {
    for (const level of [2, 10, 30, 50]) {
      expect(expChart(level, INDEXED.experienceMult)).toBeGreaterThan(expChart(level));
    }
    expect(INDEXED.experienceMult).toBeCloseTo(1.15, 5);
  });

  /**
   * AND IT ACTUALLY BITES. An award that levels a Cityborn must not level an
   * Indexed — the chart being higher is worth nothing if `gainExp` never reads
   * it, which is exactly the shape of the join bugs this codebase keeps finding.
   */
  it('levels slower on the identical kill', () => {
    const award = expChart(2);
    expect(gainExp(1, 0, award, CITYBORN.experienceMult).levelsGained).toBe(1);
    expect(gainExp(1, 0, award, INDEXED.experienceMult).levelsGained).toBe(0);
  });
});

describe('the roster', () => {
  it('is authored order and every id is distinct', () => {
    expect(ORIGINS.map((origin) => origin.id)).toEqual(['origin_cityborn', 'origin_indexed']);
    expect(new Set(ORIGINS.map((origin) => origin.id)).size).toBe(ORIGINS.length);
  });

  /** Cornac's `life_rating = 10` (human.lua:137) is the number the classes hide. */
  it('keeps the baseline where the class definitions assume it', () => {
    expect(CITYBORN.lifeRating).toBe(BASELINE_LIFE_RATING);
    expect(BASELINE_LIFE_RATING).toBe(10);
  });

  /** Every origin must be describable on a card, or the chooser has a hole. */
  it('gives every origin a name and a description', () => {
    for (const origin of ORIGINS) {
      expect(origin.name.length, origin.id).toBeGreaterThan(0);
      expect(origin.description.length, origin.id).toBeGreaterThan(40);
    }
  });
});
