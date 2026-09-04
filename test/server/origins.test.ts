import { describe, expect, it } from 'vitest';

import { CLASSES, WATCHMAN, sheetForClass } from '../../src/server/content/classes.ts';
import { BIRTH_INSCRIPTIONS } from '../../src/server/content/inscriptions.ts';
import { higherHeal } from '../../src/server/talents/higher_heal.ts';
import {
  BASELINE_LIFE_RATING,
  CITYBORN,
  DEFAULT_ORIGIN,
  INDEXED,
  ORIGINS,
  birthCategoryPoints,
  classPointBonus,
  combatWithOrigin,
  genericPointBonus,
  originLifeDelta,
  originOf,
} from '../../src/server/content/origins.ts';
import { PLAYER_RANK, maxLifeFor } from '../../src/shared/leveling.ts';
import {
  expChart,
  gainExp,
  pointsForLevel,
  totalCategoryPointsAtLevel,
  totalGenericPointsAtLevel,
  totalPointsAtLevel,
} from '../../src/shared/progression.ts';

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

describe('the adaptable origin is paid, and paid exactly once', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * Cornac's `copy_add` and `extra_talent_point_every` — human.lua:128-143.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * These read the TOTALS rather than the per-level grant, because the totals are
   * what `applyRestore` derives every purse from: a bonus that the per-level
   * function grants and the total does not know about is a point confiscated on
   * the next reload, silently, and only from the players who earned it.
   */
  it('hands over one of each at birth', () => {
    expect(totalPointsAtLevel(1, classPointBonus(CITYBORN))).toBe(1);
    expect(totalGenericPointsAtLevel(1, genericPointBonus(CITYBORN))).toBe(1);
    expect(totalCategoryPointsAtLevel(1, birthCategoryPoints(CITYBORN))).toBe(1);
  });

  /** …and the origin that pays in experience instead gets none of it. */
  it('hands the Indexed nothing at birth', () => {
    expect(totalPointsAtLevel(1, classPointBonus(INDEXED))).toBe(0);
    expect(totalGenericPointsAtLevel(1, genericPointBonus(INDEXED))).toBe(0);
    expect(totalCategoryPointsAtLevel(1, birthCategoryPoints(INDEXED))).toBe(0);
  });

  /**
   * ONE MORE OF EACH EVERY TEN LEVELS, and the gap is measured against the SAME
   * function with no bonus rather than against a spelled number — so this still
   * means "one more than everybody else" the day the base curve is retuned.
   */
  it('adds one class and one generic point every ten levels', () => {
    for (const level of [10, 20, 30, 40, 50]) {
      const plain = totalPointsAtLevel(level);
      const adaptable = totalPointsAtLevel(level, classPointBonus(CITYBORN));
      // birth 1, plus one per completed decade.
      expect(adaptable - plain, `class points at ${String(level)}`).toBe(1 + level / 10);

      const plainGen = totalGenericPointsAtLevel(level);
      const adaptableGen = totalGenericPointsAtLevel(level, genericPointBonus(CITYBORN));
      expect(adaptableGen - plainGen, `generic points at ${String(level)}`).toBe(1 + level / 10);
    }
  });

  /** Nothing at level 9, one at level 10 — the period is a period, not a rate. */
  it('pays on the tenth level and not before it', () => {
    expect(pointsForLevel(9, classPointBonus(CITYBORN))).toBe(pointsForLevel(9));
    expect(pointsForLevel(10, classPointBonus(CITYBORN))).toBe(pointsForLevel(10) + 1);
  });

  /**
   * ═══ AND NO EXTRA DISCIPLINES ON A CLOCK ═══
   * There is no `extra_category_point_every` upstream. The adaptable origin gets
   * ONE more category point for its whole career, at birth, and inventing a
   * periodic one would turn upstream's rarest currency into a drip.
   */
  it('never grants a second category point on a timer', () => {
    for (const level of [10, 20, 36, 50]) {
      expect(
        totalCategoryPointsAtLevel(level, birthCategoryPoints(CITYBORN)) -
          totalCategoryPointsAtLevel(level),
        `categories at ${String(level)}`,
      ).toBe(1);
    }
  });
});

describe('the Indexed carry a gift no class teaches', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * `talents = { [T_HIGHER_HEAL] = 1 }` — human.lua:99-101.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * RANK, NOT MEMBERSHIP. `membership-is-not-a-rank` was learned on the three
   * infusions, which shipped in `loadout` and not in `birth` and so sat at rank
   * 0 refusing every press. The assertion that would have caught it is this one,
   * so it is the first one written here.
   */
  it('grants it at a rank the engine will accept', () => {
    const sheet = sheetForClass(WATCHMAN, [], [], BIRTH_INSCRIPTIONS, INDEXED);
    expect(sheet.points.get(higherHeal.id)).toBe(1);
    expect(sheet.loadout).toContain(higherHeal.id);
  });

  /** …and the origin that pays in points instead does not get it at all. */
  it('is absent from a Cityborn body entirely', () => {
    const sheet = sheetForClass(WATCHMAN, [], [], BIRTH_INSCRIPTIONS, CITYBORN);
    expect(sheet.loadout).not.toContain(higherHeal.id);
    expect(sheet.points.has(higherHeal.id)).toBe(false);
  });

  /** Every class, because an origin is not a class and must not favour one. */
  it('reaches every class the same way', () => {
    for (const definition of CLASSES) {
      const sheet = sheetForClass(definition, [], [], BIRTH_INSCRIPTIONS, INDEXED);
      expect(sheet.points.get(higherHeal.id), definition.name).toBe(1);
    }
  });

  /**
   * ONE RANK ONLY. The `race/higher` tree that would raise it is not ported, so
   * the panel must not draw a live `+` over a rank no purse can buy — the same
   * point sink `talent-scaling.test.ts` caught on the healing infusion.
   */
  it('cannot be raised, because the tree that raises it is not here', () => {
    expect(higherHeal.maxLevel).toBe(1);
  });

  /** `no_energy = true` (races.lua:45) — the turn goes on around it. */
  it('costs no time at all', () => {
    expect(higherHeal.cost.ap).toBe(0);
  });
});
