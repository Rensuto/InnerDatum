// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// The noise under test ports libtcod 1.5.0's noise_c.c as t-engine4 vendors it
// (src/libtcod_import/noise_c.c and src/noise.c, tag tome-1.6.0).
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_HURST,
  DEFAULT_LACUNARITY,
  createNoise1,
  createNoise2,
} from '../../src/shared/noise.ts';
import { createRng } from '../../src/shared/rng.ts';

/** `CLAMP(-0.99999f, 0.99999f, x)`: the bound is the float the literal denotes. */
const LIMIT = Math.fround(0.99999);

const POINTS = [
  [0.3, 0.7],
  [4.2, 9.9],
  [17.5, 2.25],
  [-3.6, 5.1],
  [123.456, 0.001],
] as const;

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE C, TRANSCRIBED A SECOND TIME, SO THE PORT IS NOT CHECKED AGAINST ITSELF.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Written straight from `TCOD_noise_new`, `lattice`, `TCOD_noise_perlin` and
 * `TCOD_noise_simplex` in the vendored `noise_c.c`, in the most literal form:
 * arrays of rows, a destructuring swap, `Math.hypot`. What it pins that no
 * black-box property can: the gradient draws come BEFORE the permutation draws,
 * the permutation swaps each `i` from 255 down with ANY index (not
 * Fisher-Yates), the hash runs x then y, and every simplex constant.
 */
function reference(seed: string, ndim: 1 | 2) {
  const rng = createRng(seed);
  const map: number[] = [];
  const buffer: number[][] = [];
  for (let i = 0; i < 256; i += 1) {
    map.push(i);
    const row: number[] = [];
    for (let j = 0; j < ndim; j += 1) row.push(rng.nextU32('g') * (1 / 4294967295) - 0.5);
    const length = Math.hypot(...row);
    buffer.push(row.map((v) => v / length));
  }
  for (let i = 255; i >= 1; i -= 1) {
    const j = rng.int('m', 0, 255);
    [map[i], map[j]] = [map[j] ?? 0, map[i] ?? 0];
  }
  const m = (k: number): number => map[k] ?? 0;
  const b = (row: number, col: number): number => buffer[row]?.[col] ?? 0;
  const FLOOR = (a: number): number => (a > 0 ? Math.trunc(a) : Math.trunc(a) - 1);
  const CUBIC = (a: number): number => a * a * (3 - 2 * a);
  const LERP = (a: number, c: number, x: number): number => a + x * (c - a);
  const CLAMP = (x: number): number => (x < -LIMIT ? -LIMIT : x > LIMIT ? LIMIT : x);

  const perlin1 = (x: number): number => {
    const n = FLOOR(x);
    const r = x - n;
    const lattice = (ix: number, fx: number): number => b(m(ix & 0xff), 0) * fx;
    return CLAMP(LERP(lattice(n, r), lattice(n + 1, r - 1), CUBIC(r)));
  };
  const perlin2 = (x: number, y: number): number => {
    const n0 = FLOOR(x);
    const n1 = FLOOR(y);
    const r0 = x - n0;
    const r1 = y - n1;
    const lattice = (ix: number, fx: number, iy: number, fy: number): number => {
      const k = m((m(ix & 0xff) + iy) & 0xff);
      return b(k, 0) * fx + b(k, 1) * fy;
    };
    return CLAMP(
      LERP(
        LERP(lattice(n0, r0, n1, r1), lattice(n0 + 1, r0 - 1, n1, r1), CUBIC(r0)),
        LERP(lattice(n0, r0, n1 + 1, r1 - 1), lattice(n0 + 1, r0 - 1, n1 + 1, r1 - 1), CUBIC(r0)),
        CUBIC(r1),
      ),
    );
  };
  const simplex1 = (x: number): number => {
    const grad = (hash: number, d: number): number => {
      const h = hash & 0xf;
      return (h & 8 ? -(1 + (h & 7)) : 1 + (h & 7)) * d;
    };
    const i0 = Math.trunc(x * 0.5 > 0 ? Math.trunc(x) * 0.5 : Math.trunc(x) * 0.5 - 1);
    const x0 = x * 0.5 - i0;
    const x1 = x0 - 1;
    const t0 = (1 - x0 * x0) ** 2;
    const t1 = (1 - x1 * x1) ** 2;
    return 0.25 * (grad(m(i0 & 0xff), x0) * t0 * t0 + grad(m((i0 + 1) & 0xff), x1) * t1 * t1);
  };
  const simplex2 = (x: number, y: number): number => {
    const F2 = Math.fround(0.366025403);
    const G2 = Math.fround(0.211324865);
    const grad = (hash: number, dx: number, dy: number): number => {
      const h = hash & 7;
      const [u, v] = h < 4 ? [dx, 2 * dy] : [dy, 2 * dx];
      return (h & 1 ? -u : u) + (h & 2 ? -v : v);
    };
    const s = (x + y) * F2 * 0.5;
    const i = FLOOR(x * 0.5 + s);
    const j = FLOOR(y * 0.5 + s);
    const t = (i + j) * G2;
    const x0 = x * 0.5 - (i - t);
    const y0 = y * 0.5 - (j - t);
    const [i1, j1] = x0 > y0 ? [1, 0] : [0, 1];
    const corners = [
      [x0, y0, (i % 256) + m(j % 256)],
      [x0 - i1 + G2, y0 - j1 + G2, (i % 256) + i1 + m((j + j1) & 0xff)],
      [x0 - 1 + 2 * G2, y0 - 1 + 2 * G2, (i % 256) + 1 + m((j + 1) & 0xff)],
    ] as const;
    let sum = 0;
    for (const [dx, dy, hash] of corners) {
      const k = 0.5 - dx * dx - dy * dy;
      if (k < 0) continue;
      sum += grad(m(hash & 0xff), dx, dy) * k ** 4;
    }
    return 40 * sum;
  };
  return { perlin1, perlin2, simplex1, simplex2 };
}

describe('libtcod noise, as T-Engine4 vendors it', () => {
  it('is the C, sample for sample, in two dimensions', () => {
    for (const seed of ['ref-a', 'ref-b', 'ref-c']) {
      const port = createNoise2(createRng(seed), 'field');
      const ref = reference(seed, 2);
      for (let i = 0; i < 400; i += 1) {
        const x = (i * 7.31) % 61.7;
        const y = (i * 3.17) % 43.3;
        expect(port.perlin(x - 20, y - 11)).toBeCloseTo(ref.perlin2(x - 20, y - 11), 12);
        // Simplex samples non-negative coordinates only: a negative `j` reads
        // outside the C table (see `simplex2` in noise.ts).
        expect(port.simplex(x, y)).toBeCloseTo(ref.simplex2(x, y), 12);
      }
    }
  });

  it('is the C, sample for sample, in one dimension', () => {
    for (const seed of ['ref-a', 'ref-b', 'ref-c']) {
      const port = createNoise1(createRng(seed), 'line');
      const ref = reference(seed, 1);
      for (let i = 0; i < 400; i += 1) {
        const x = ((i * 7.31) % 61.7) - 20;
        expect(port.perlin(x)).toBeCloseTo(ref.perlin1(x), 12);
        expect(port.simplex(x)).toBeCloseTo(ref.simplex1(x), 12);
      }
    }
  });

  it('spends 256 gradient draws per dimension, then 255 permutation draws', () => {
    for (const [ndim, make] of [
      [2, (rng: ReturnType<typeof createRng>) => createNoise2(rng, 'field')],
      [1, (rng: ReturnType<typeof createRng>) => createNoise1(rng, 'field')],
    ] as const) {
      const rng = createRng('draws');
      make(rng);
      expect(rng.getState().count).toBe(256 * ndim + 255);
      expect(rng.getState().lastLabel).toBe('field.map');
    }
  });

  it('is the same field for the same seed, and another field for another seed', () => {
    const a = createNoise2(createRng('noise-a'), 'field');
    const b = createNoise2(createRng('noise-a'), 'field');
    const c = createNoise2(createRng('noise-b'), 'field');
    for (const [x, y] of POINTS) expect(a.fbmPerlin(x, y, 4)).toBe(b.fbmPerlin(x, y, 4));
    expect(POINTS.some(([x, y]) => a.fbmPerlin(x, y, 4) !== c.fbmPerlin(x, y, 4))).toBe(true);
  });
});

describe('octaves', () => {
  it('ignores hurst entirely: the commented-out powf in TCOD_noise_new', () => {
    expect(DEFAULT_HURST).toBe(0.5);
    const plain = createNoise2(createRng('hurst'), 'field');
    for (const hurst of [0.1, 0.9, 7]) {
      const other = createNoise2(createRng('hurst'), 'field', hurst);
      for (const [x, y] of POINTS) {
        expect(other.fbmPerlin(x, y, 4)).toBe(plain.fbmPerlin(x, y, 4));
        expect(other.fbmSimplex(Math.abs(x), y, 3.5)).toBe(plain.fbmSimplex(Math.abs(x), y, 3.5));
      }
    }
  });

  it('weights octave i by 1/lacunarity^i and samples it lacunarity^i finer', () => {
    expect(DEFAULT_LACUNARITY).toBe(2);
    const n = createNoise2(createRng('octaves'), 'field');
    const coarse = createNoise2(createRng('octaves'), 'field', DEFAULT_HURST, 3);
    const line = createNoise1(createRng('octaves'), 'line');
    for (const [x, y] of POINTS) {
      expect(n.fbmPerlin(x, y, 1), 'one octave is the noise itself').toBeCloseTo(
        n.perlin(x, y),
        12,
      );
      expect(n.fbmPerlin(x, y, 2)).toBeCloseTo(n.perlin(x, y) + n.perlin(2 * x, 2 * y) / 2, 12);
      expect(n.fbmPerlin(x, y, 3)).toBeCloseTo(
        n.perlin(x, y) + n.perlin(2 * x, 2 * y) / 2 + n.perlin(4 * x, 4 * y) / 4,
        12,
      );
      expect(coarse.fbmPerlin(x, y, 2)).toBeCloseTo(
        coarse.perlin(x, y) + coarse.perlin(3 * x, 3 * y) / 3,
        12,
      );
      const ax = Math.abs(x);
      expect(n.fbmSimplex(ax, y + 6, 2)).toBeCloseTo(
        n.simplex(ax, y + 6) + n.simplex(2 * ax, 2 * (y + 6)) / 2,
        12,
      );
      expect(line.fbmPerlin(x, 2)).toBeCloseTo(line.perlin(x) + line.perlin(2 * x) / 2, 12);
      expect(line.fbmSimplex(x, 2)).toBeCloseTo(line.simplex(x) + line.simplex(2 * x) / 2, 12);
    }
  });

  it('adds a fraction of one more octave, but only a fraction above 1e-6', () => {
    const n = createNoise2(createRng('fraction'), 'field');
    for (const [x, y] of POINTS) {
      expect(n.fbmPerlin(x, y, 1.5)).toBeCloseTo(
        n.perlin(x, y) + (0.5 * n.perlin(2 * x, 2 * y)) / 2,
        12,
      );
      expect(n.fbmPerlin(x, y, 1 + 5e-7)).toBe(n.fbmPerlin(x, y, 1));
    }
    expect(POINTS.some(([x, y]) => n.fbmPerlin(x, y, 1 + 2e-6) !== n.fbmPerlin(x, y, 1))).toBe(
      true,
    );
    // No octaves at all is nothing at all. `(int)-1.5` is -1, so a negative
    // count runs no octave and leaves a fraction of -0.5, which is not above 1e-6.
    expect(n.fbmPerlin(4.2, 9.9, 0)).toBe(0);
    expect(n.fbmPerlin(4.2, 9.9, -1.5)).toBe(0);
  });

  it('does not normalise the sum, and clamps it at the float 0.99999', () => {
    // At lacunarity 1 every octave is the same sample at weight 1, so three
    // octaves are three times the noise — until the clamp.
    const n = createNoise2(createRng('clamp'), 'field', DEFAULT_HURST, 1);
    let clamped = 0;
    let free = 0;
    for (let i = 0; i < 400; i += 1) {
      const x = (i * 7.31) % 61.7;
      const y = (i * 3.17) % 43.3;
      const three = 3 * n.perlin(x, y);
      const v = n.fbmPerlin(x, y, 3);
      if (Math.abs(three) > LIMIT) {
        clamped += 1;
        expect(v).toBe(Math.sign(three) * LIMIT);
      } else {
        free += 1;
        expect(v).toBeCloseTo(three, 12);
      }
    }
    expect(clamped).toBeGreaterThan(20);
    expect(free).toBeGreaterThan(20);
  });
});

describe('Perlin', () => {
  it('is zero on every lattice point, in one dimension and two', () => {
    const n = createNoise2(createRng('lattice'), 'field');
    const line = createNoise1(createRng('lattice'), 'line');
    for (let x = -3; x <= 3; x += 1) {
      expect(Math.abs(line.perlin(x))).toBeLessThan(1e-12);
      for (let y = -3; y <= 3; y += 1) expect(Math.abs(n.perlin(x, y))).toBeLessThan(1e-12);
    }
  });

  it('interpolates with the CUBIC r*r*(3-2r), not the quintic', () => {
    // In one dimension every gradient is +-1, readable off the slope just past
    // each lattice point, so the value between two of them is fixed by the curve.
    const line = createNoise1(createRng('curve'), 'line');
    const eps = 1e-7;
    let quinticWouldDiffer = 0;
    for (let k = 1; k <= 40; k += 1) {
      const g0 = Math.sign(line.perlin(k + eps));
      const g1 = -Math.sign(line.perlin(k + 1 - eps));
      for (const r of [0.2, 0.35, 0.7]) {
        const a = g0 * r;
        const b = g1 * (r - 1);
        const cubic = a + r * r * (3 - 2 * r) * (b - a);
        const quintic = a + r * r * r * (r * (r * 6 - 15) + 10) * (b - a);
        expect(line.perlin(k + r)).toBeCloseTo(cubic, 12);
        if (Math.abs(cubic - quintic) > 1e-3) quinticWouldDiffer += 1;
      }
    }
    expect(quinticWouldDiffer).toBeGreaterThan(20);
  });

  it('has unit gradients in two dimensions: rows are normalised after they are drawn', () => {
    const n = createNoise2(createRng('unit'), 'field');
    const eps = 1e-6;
    for (let x = 1; x <= 12; x += 1) {
      for (let y = 1; y <= 12; y += 1) {
        const gx = n.perlin(x + eps, y) / eps;
        const gy = n.perlin(x, y + eps) / eps;
        expect(Math.hypot(gx, gy)).toBeCloseTo(1, 4);
      }
    }
  });

  it('stays inside the bound its unit gradients give: sqrt(2)/2 in 2D, 1/2 in 1D', () => {
    // The largest |sum of weighted corner offsets| over a cell is at its centre:
    // sqrt(2)/2 with four corners, 1/2 with two.
    let peak2 = 0;
    let peak1 = 0;
    for (let s = 0; s < 20; s += 1) {
      const n = createNoise2(createRng(`bound-${String(s)}`), 'field');
      const line = createNoise1(createRng(`bound-${String(s)}`), 'line');
      for (let i = 0; i < 60; i += 1) {
        peak1 = Math.max(peak1, Math.abs(line.perlin(i / 4 + 0.5)));
        for (let j = 0; j < 60; j += 1) {
          peak2 = Math.max(peak2, Math.abs(n.perlin(i / 4 + 0.125, j / 4 + 0.125)));
        }
      }
    }
    expect(peak2).toBeLessThanOrEqual(Math.SQRT1_2 + 1e-12);
    expect(peak2).toBeGreaterThan(0.5);
    expect(peak1).toBeLessThanOrEqual(0.5 + 1e-12);
    expect(peak1).toBeGreaterThan(0.45);
  });
});

describe('simplex', () => {
  it('samples at half the coordinate: 2D noise vanishes on the simplex grid scaled by 2', () => {
    // A vertex of the skewed grid in simplex space `(i, j)` unskews to
    // `(i - (i+j)G2, j - (i+j)G2)`. With SIMPLEX_SCALE 0.5 that point is
    // reached at TWICE those coordinates, where only its own corner is in range
    // and its offset is zero.
    const G2 = Math.fround(0.211324865);
    const n = createNoise2(createRng('simplex-grid'), 'field');
    let unscaledNonZero = 0;
    for (let i = 3; i <= 12; i += 1) {
      for (let j = 1; j <= 3; j += 1) {
        const ux = i - (i + j) * G2;
        const uy = j - (i + j) * G2;
        expect(Math.abs(n.simplex(2 * ux, 2 * uy))).toBeLessThan(1e-6);
        if (Math.abs(n.simplex(ux, uy)) > 1e-3) unscaledNonZero += 1;
      }
    }
    expect(unscaledNonZero).toBeGreaterThan(15);
  });

  it('1D: vanishes at even numbers, and its gradients are +-(1..8) at scale 0.25', () => {
    // Just past 2k the value is 0.25 * g * (eps/2), so g reads back as an integer.
    const line = createNoise1(createRng('simplex-line'), 'line');
    const eps = 1e-6;
    const seen = new Set<number>();
    for (let k = 0; k < 120; k += 1) {
      expect(Math.abs(line.simplex(2 * k))).toBeLessThan(1e-12);
      const g = line.simplex(2 * k + eps) / (0.25 * (eps / 2));
      expect(Math.abs(g - Math.round(g))).toBeLessThan(1e-3);
      seen.add(Math.round(g));
    }
    expect([...seen].every((g) => g !== 0 && Math.abs(g) <= 8)).toBe(true);
    expect(seen.has(8) || seen.has(-8)).toBe(true);
    expect(seen.has(1) || seen.has(-1)).toBe(true);
  });

  it('is bounded by its kernel, not by a clamp: 2D under 0.8844, 1D under 0.6329', () => {
    /**
     * libtcod clamps `perlin` and `fbm`, never `simplex`. The clamp would never
     * bite anyway: over a whole simplex cell, taking the largest of the eight
     * gradients independently at each corner, `40 * sum(t^4 * |grad . d|)`
     * peaks at 0.88436 (a 500x500 sweep); the 1D kernel `0.25 * 8 * x(1-x^2)^4`
     * summed over both ends peaks at 0.6328125. Measured over forty seeds here:
     * 0.8842 and 0.6328, so both bounds are reached.
     */
    let peak2 = 0;
    let peak1 = 0;
    for (let s = 0; s < 40; s += 1) {
      const n = createNoise2(createRng(`clamp-${String(s)}`), 'field');
      const line = createNoise1(createRng(`clamp-${String(s)}`), 'line');
      for (let i = 0; i < 50; i += 1) {
        for (let j = 0; j < 50; j += 1) {
          peak2 = Math.max(
            peak2,
            Math.abs(n.simplex(((10 * i) / 50 + 0.37) * 3, ((10 * j) / 50 + 0.61) * 3)),
          );
        }
      }
      for (let i = 0; i < 2000; i += 1) peak1 = Math.max(peak1, Math.abs(line.simplex(i * 0.173)));
    }
    expect(peak2).toBeLessThan(0.8844);
    expect(peak2).toBeGreaterThan(0.8);
    expect(peak1).toBeLessThanOrEqual(0.6328125);
    expect(peak1).toBeGreaterThan(0.6);
  });
});
