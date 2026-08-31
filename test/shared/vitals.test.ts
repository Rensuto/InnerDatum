// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { HP_LOW, isLowLife, lifeFraction } from '../../src/shared/vitals.ts';

describe('when a body is in trouble', () => {
  it('is one third, and the boundary belongs to the low side', () => {
    // `<=`, not `<`. Every surface that carried its own copy used `<=`, and a
    // boundary that changed hands between surfaces is the disagreement this
    // constant exists to prevent.
    expect(HP_LOW).toBe(1 / 3);
    expect(isLowLife(1, 3), 'exactly a third is not yet trouble').toBe(true);
    expect(isLowLife(34, 100)).toBe(false);
    expect(isLowLife(33, 100)).toBe(true);
  });

  it('cannot be fooled by a body with no maximum', () => {
    /**
     * A `maxHp` of 0 is a fixture that got away. Dividing by it gives Infinity
     * or NaN, and `NaN <= HP_LOW` is FALSE — which would paint a corpse as
     * healthy, in the one readout a player checks when deciding whether to run.
     */
    expect(lifeFraction(0, 0)).toBe(0);
    expect(isLowLife(0, 0)).toBe(true);
    expect(lifeFraction(Number.NaN, 10)).toBe(0);
    expect(isLowLife(Number.NaN, 10)).toBe(true);
  });

  it('clamps, so a heal past full is still full', () => {
    expect(lifeFraction(120, 100)).toBe(1);
    expect(lifeFraction(-5, 100)).toBe(0);
  });
});

describe('every life readout asks the same question', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE RULE WAS WRITTEN DOWN THREE TIMES.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `ui/life.ts` argues that two health readouts disagreeing about when a body
   * is in trouble would be worse than one — and `HP_LOW = 1 / 3` then appeared
   * in `ui/life.ts`, `ui/partypanel.ts` and `ui/turncards.ts`, three copies of
   * a number that must never differ.
   *
   * Nothing had drifted. That is the point: three copies of an agreed number is
   * a bug that has not happened yet, and this is what stops it happening after
   * somebody tunes one surface.
   */
  it('has exactly one definition of the threshold in the whole client', () => {
    const files = [
      'src/client/ui/life.ts',
      'src/client/ui/partypanel.ts',
      'src/client/ui/turncards.ts',
      'src/client/render/canvas.ts',
    ];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      expect(source, `${file} declares its own copy of the threshold`).not.toMatch(
        /(const|let)\s+HP_LOW\s*=/,
      );
    }
    const home = readFileSync('src/shared/vitals.ts', 'utf8');
    expect(home).toMatch(/export const HP_LOW = 1 \/ 3;/);
  });
});
