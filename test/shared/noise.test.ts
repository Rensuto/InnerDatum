// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

import { describe, expect, it } from 'vitest';

import { DEFAULT_HURST, DEFAULT_LACUNARITY, createNoise2 } from '../../src/shared/noise.ts';
import { createRng } from '../../src/shared/rng.ts';

const POINTS = [
  [0.3, 0.7],
  [4.2, 9.9],
  [17.5, 2.25],
  [-3.6, 5.1],
] as const;

describe('seeded noise', () => {
  it('is the same field for the same seed, and another field for another seed', () => {
    const a = createNoise2(createRng('noise-a'), 'field');
    const b = createNoise2(createRng('noise-a'), 'field');
    const c = createNoise2(createRng('noise-b'), 'field');
    for (const [x, y] of POINTS) expect(a.fbmPerlin(x, y, 4)).toBe(b.fbmPerlin(x, y, 4));
    expect(POINTS.some(([x, y]) => a.fbmPerlin(x, y, 4) !== c.fbmPerlin(x, y, 4))).toBe(true);
  });

  it('is zero on every lattice point, which is what makes it gradient noise', () => {
    const n = createNoise2(createRng('lattice'), 'field');
    for (let x = -3; x <= 3; x += 1) {
      for (let y = -3; y <= 3; y += 1) expect(Math.abs(n.perlin(x, y))).toBeLessThan(1e-12);
    }
  });

  it('weights each octave as libtcod does: finer by the lacunarity, fainter by the Hurst exponent', () => {
    expect(DEFAULT_HURST).toBe(0.5);
    expect(DEFAULT_LACUNARITY).toBe(2);
    const n = createNoise2(createRng('octaves'), 'field');
    const second = Math.pow(DEFAULT_LACUNARITY, -DEFAULT_HURST);
    for (const [x, y] of POINTS) {
      expect(n.fbmPerlin(x, y, 1), 'one octave is the noise itself').toBeCloseTo(
        n.perlin(x, y),
        12,
      );
      const two = n.perlin(x, y) + n.perlin(2 * x, 2 * y) * second;
      expect(n.fbmPerlin(x, y, 2)).toBeCloseTo(two, 12);
      // A FRACTION OF AN OCTAVE is added at that fraction of its weight.
      const oneAndAHalf = n.perlin(x, y) + 0.5 * n.perlin(2 * x, 2 * y) * second;
      expect(n.fbmPerlin(x, y, 1.5)).toBeCloseTo(oneAndAHalf, 12);
    }
  });

  it('is centred on zero with real contrast, and never leaves the unit interval', () => {
    /**
     * Measured over forty seeds at upstream's ambush sampling (zoom 10 across
     * 20 cells, four octaves): a pooled mean of 0.001, every value within
     * -0.68..0.70, and no seed's mean further from zero than 0.011.
     */
    let sum = 0;
    let count = 0;
    let lo = 1;
    let hi = -1;
    for (let s = 0; s < 40; s += 1) {
      const n = createNoise2(createRng(`spread-${String(s)}`), 'field');
      for (let i = 1; i <= 20; i += 1) {
        for (let j = 1; j <= 20; j += 1) {
          const v = n.fbmPerlin((10 * i) / 20, (10 * j) / 20, 4);
          sum += v;
          count += 1;
          lo = Math.min(lo, v);
          hi = Math.max(hi, v);
        }
      }
    }
    expect(Math.abs(sum / count), 'the field leans one way').toBeLessThan(0.03);
    expect(lo, 'no low ground at all').toBeLessThan(-0.5);
    expect(hi, 'no high ground at all').toBeGreaterThan(0.5);
    expect(lo).toBeGreaterThan(-1);
    expect(hi).toBeLessThan(1);
  });

  it('stops just inside the unit interval, as libtcod clamps it', () => {
    /**
     * Four octaves can sum past one. With the clamp taken out, 91 samples in
     * 500,000 did, peaking at 1.2, and the first was on this seed and grid. So
     * the peak here is the clamp itself.
     */
    const n = createNoise2(createRng('clamp-1'), 'field');
    let peak = 0;
    for (let i = 0; i < 50; i += 1) {
      for (let j = 0; j < 50; j += 1) {
        const v = n.fbmPerlin((10 * i) / 50 + 0.37, (10 * j) / 50 + 0.61, 4);
        peak = Math.max(peak, Math.abs(v));
      }
    }
    expect(peak).toBe(0.99999);
  });
});
