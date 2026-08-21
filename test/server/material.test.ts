// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported in shape from t-engine4's `material_level`, which is what lets a small
// object table carry a fifty-level game.
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" — https://te4.org/license

import { describe, expect, it } from 'vitest';

import { ITEMS } from '../../src/server/content/items.ts';
import { bandFor, materialFor, rollLoot } from '../../src/server/content/loot.ts';
import {
  MAX_MATERIAL,
  MIN_MATERIAL,
  atMaterial,
  formatItemId,
  parseItemId,
  resolveItem,
} from '../../src/server/content/resolve.ts';
import { createRng } from '../../src/shared/rng.ts';
import { MAX_CHARACTER_LEVEL } from '../../src/shared/progression.ts';

const COAT = 'item_watchmans_coat';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *   AN ITEM WAS ONE FIXED THING FOREVER.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A Watchman's Coat found at level 3 and one found at level 45 were
 * byte-identical: every number came off a frozen catalogue entry, so forty
 * levels of loot was twenty-three objects with a different chance of a prefix.
 */

describe('the grammar, and what it does to ids that already exist', () => {
  it('reads every old id as grade 1', () => {
    /**
     * ═══ THE PROPERTY THAT MADE THIS NEED NO MIGRATION ═══
     * Every id ever written to a save file has no `#` in it, and grade 1 is
     * exactly what those items were. If this ever fails, every character's bag
     * silently changes value on load.
     */
    expect(parseItemId(COAT)?.material).toBe(MIN_MATERIAL);
    expect(parseItemId(`${COAT}~rf2`)?.material).toBe(MIN_MATERIAL);
  });

  it('writes nothing for grade 1, so one item has one spelling', () => {
    /**
     * Ids are compared as strings for the bag's de-duplication, so `item_coat`
     * and `item_coat#1` must never both exist. The default is what enforces it.
     */
    expect(formatItemId(COAT, [])).toBe(COAT);
    expect(formatItemId(COAT, [], MIN_MATERIAL)).toBe(COAT);
    expect(formatItemId(COAT, [], 3)).toBe(`${COAT}#3`);
  });

  it('round-trips a graded id with egos', () => {
    const id = formatItemId(COAT, [{ code: 'rf', power: 2 }], 4);
    const back = parseItemId(id);
    expect(back?.base).toBe(COAT);
    expect(back?.material).toBe(4);
    expect(back?.egos).toEqual([{ code: 'rf', power: 2 }]);
  });

  it('refuses a grade that is not one', () => {
    /**
     * This runs on strings out of save files and off the wire. The one thing
     * worse than rejecting a malformed id is resolving a half-parsed one to an
     * item that is quietly stronger than it should be.
     */
    for (const bad of [
      `${COAT}#`,
      `${COAT}#0`,
      `${COAT}#9`,
      `${COAT}#x`,
      `${COAT}#01`,
      `${COAT}#2#3`,
    ]) {
      expect(parseItemId(bad), bad).toBeUndefined();
      expect(resolveItem(bad), bad).toBeUndefined();
    }
  });
});

describe('what a grade is worth', () => {
  it('doubles at the top and changes nothing at the bottom', () => {
    expect(atMaterial(10, MIN_MATERIAL)).toBe(10);
    expect(atMaterial(10, MAX_MATERIAL)).toBe(20);
  });

  it('never rounds a bonus away', () => {
    // `Math.round(0.4)` is 0, and an item whose one small bonus vanished at a
    // HIGHER grade would read as broken.
    expect(atMaterial(1, 2)).toBeGreaterThanOrEqual(1);
    for (let m = MIN_MATERIAL; m <= MAX_MATERIAL; m += 1) {
      expect(atMaterial(1, m), `grade ${String(m)}`).toBeGreaterThanOrEqual(1);
    }
  });

  it('makes a drawback worse rather than erasing it', () => {
    // A heavy coat's defence penalty is part of what the item was balanced
    // around; a grade that quietly deleted it would be a free upgrade.
    expect(atMaterial(-4, MAX_MATERIAL)).toBeLessThanOrEqual(-4);
    expect(atMaterial(-1, MAX_MATERIAL)).toBeLessThanOrEqual(-1);
  });

  it('leaves zero alone', () => {
    expect(atMaterial(0, MAX_MATERIAL)).toBe(0);
  });

  it('is monotonic across the grades', () => {
    let last = 0;
    for (let m = MIN_MATERIAL; m <= MAX_MATERIAL; m += 1) {
      const now = atMaterial(8, m);
      expect(now, `grade ${String(m)}`).toBeGreaterThanOrEqual(last);
      last = now;
    }
  });
});

describe('a resolved item wears its grade', () => {
  it('is stronger than the plain one and says so in its name', () => {
    const plain = resolveItem(COAT);
    const best = resolveItem(`${COAT}#5`);
    expect(plain).toBeDefined();
    expect(best).toBeDefined();
    expect(best?.wielder.mods?.armour ?? 0).toBeGreaterThan(plain?.wielder.mods?.armour ?? 0);
    // A player with two rows both reading "Watchman's Coat", one worth dropping,
    // has to open both tooltips to find out which.
    expect(best?.name).not.toBe(plain?.name);
  });

  it('returns the shared frozen entry for the common case', () => {
    // Grade 1, no egos — every item in every save today. It must not build a
    // copy per lookup, and it must be the identical object.
    expect(resolveItem(COAT)).toBe(resolveItem(COAT));
  });

  it('scales the base and leaves the ego alone', () => {
    /**
     * A grade is a fact about the OBJECT and an ego is a fact about what
     * happened to it, which does not get better because the coat underneath
     * did. Scaling both would multiply four authored numbers by the same figure
     * and no player could work out where any of it came from.
     */
    const egoOnly = resolveItem(`${COAT}~rf2`);
    const both = resolveItem(`${COAT}#5~rf2`);
    const plain = resolveItem(COAT);
    const best = resolveItem(`${COAT}#5`);

    const armour = (id: ReturnType<typeof resolveItem>): number => id?.wielder.mods?.armour ?? 0;
    // The ego's contribution is the same at both grades.
    expect(armour(egoOnly) - armour(plain)).toBe(armour(both) - armour(best));
  });

  it('grades every authored item without producing a nonsense one', () => {
    // The whole catalogue, at every grade — a sweep rather than one coat,
    // because an item with an odd wielder table is exactly what a curve breaks.
    for (const item of ITEMS) {
      for (let m = MIN_MATERIAL; m <= MAX_MATERIAL; m += 1) {
        const resolved = resolveItem(formatItemId(item.id, [], m));
        expect(resolved, `${item.id} at grade ${String(m)}`).toBeDefined();
        for (const value of Object.values(resolved?.wielder.mods ?? {})) {
          expect(Number.isFinite(value), `${item.id} grade ${String(m)}`).toBe(true);
        }
      }
    }
  });
});

describe('the roll', () => {
  it('follows the band, one step either side', () => {
    for (const level of [1, 12, 25, 45, MAX_CHARACTER_LEVEL]) {
      const band = bandFor(level);
      for (let i = 0; i < 40; i += 1) {
        const m = materialFor(createRng(`probe:${String(level)}:${String(i)}`), level);
        expect(m, `level ${String(level)}`).toBeGreaterThanOrEqual(
          Math.max(MIN_MATERIAL, band - 1),
        );
        expect(m, `level ${String(level)}`).toBeLessThanOrEqual(Math.min(MAX_MATERIAL, band + 1));
      }
    }
  });

  it('never leaves the range at either end', () => {
    // A band-1 character cannot find a grade-0 anything; a band-5 one cannot
    // find a grade-6. The clamp is what makes the early game's floor real.
    for (const level of [1, MAX_CHARACTER_LEVEL]) {
      for (let i = 0; i < 60; i += 1) {
        const m = materialFor(createRng(`edge:${String(level)}:${String(i)}`), level);
        expect(m).toBeGreaterThanOrEqual(MIN_MATERIAL);
        expect(m).toBeLessThanOrEqual(MAX_MATERIAL);
      }
    }
  });

  it('actually produces better gear deep in than early on', () => {
    /**
     * ═══ THE ASSERTION THE WHOLE FEATURE EXISTS FOR ═══
     * Forty levels of loot used to be the same objects with a different chance
     * of a prefix. If this fails, it is again.
     */
    const gradesAt = (level: number): number[] =>
      Array.from({ length: 30 }, (_, i) => {
        const id = rollLoot(createRng(`deep:${String(i)}`), COAT, level);
        return parseItemId(id)?.material ?? MIN_MATERIAL;
      });

    const early = gradesAt(2);
    const late = gradesAt(MAX_CHARACTER_LEVEL);
    const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
    expect(mean(late)).toBeGreaterThan(mean(early) + 1);
  });
});
