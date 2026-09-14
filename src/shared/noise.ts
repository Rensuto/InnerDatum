// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * NOISE — upstream's `core.noise`, which its outdoor levels are made of.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `Forest.lua:147-150` builds every outdoor level from one call:
 *
 * ```lua
 * local noise = core.noise.new(2, self.hurst, self.lacunarity)
 * local v = math.floor((noise[self.noise](noise, self.zoom * i / self.map.w, self.zoom * j / self.map.h, self.octave) / 2 + 0.5) * self.max_percent)
 * ```
 *
 * `core.noise` is libtcod's noise module, compiled into the engine. Its C is not
 * in the reference tree, so this is written from the algorithm rather than
 * copied: Perlin gradient noise over unit gradients, summed as fractal Brownian
 * motion with libtcod's default Hurst exponent and lacunarity, each octave
 * weighted `1 / lacunarity^(hurst * i)`, and clamped just inside the unit
 * interval. The numbers differ from upstream's, which draws from a different
 * generator; the distribution is what the port keeps, and
 * `test/shared/noise.test.ts` pins it.
 *
 * SEEDED FROM shared/rng.ts, so a level built from a realm's seed is the same
 * level every time.
 */
import type { Rng } from './rng.ts';

/** libtcod's default Hurst exponent: how fast each octave's weight falls. */
export const DEFAULT_HURST = 0.5;
/** libtcod's default lacunarity: how much finer each octave is. */
export const DEFAULT_LACUNARITY = 2;
/** The most octaves one sum takes. */
const MAX_OCTAVES = 128;
/** libtcod clamps every result just inside the unit interval. */
const LIMIT = 0.99999;

export type Noise2 = {
  /** Perlin gradient noise at a point. */
  readonly perlin: (x: number, y: number) => number;
  /** `octaves` of Perlin noise summed as fractal Brownian motion. */
  readonly fbmPerlin: (x: number, y: number, octaves: number) => number;
};

function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function clamp(v: number): number {
  return Math.max(-LIMIT, Math.min(LIMIT, v));
}

export function createNoise2(
  rng: Rng,
  label: string,
  hurst: number = DEFAULT_HURST,
  lacunarity: number = DEFAULT_LACUNARITY,
): Noise2 {
  const order = rng.shuffle(
    `${label}.order`,
    Array.from({ length: 256 }, (_, i) => i),
  );
  const gx: number[] = [];
  const gy: number[] = [];
  for (let i = 0; i < 256; i += 1) {
    const angle = rng.nextFloat(`${label}.gradient`) * Math.PI * 2;
    gx.push(Math.cos(angle));
    gy.push(Math.sin(angle));
  }

  const hash = (x: number, y: number): number => order[((order[x & 255] ?? 0) + y) & 255] ?? 0;
  const corner = (ix: number, iy: number, dx: number, dy: number): number => {
    const h = hash(ix, iy);
    return (gx[h] ?? 0) * dx + (gy[h] ?? 0) * dy;
  };

  const perlin = (x: number, y: number): number => {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const fx = x - ix;
    const fy = y - iy;
    const u = fade(fx);
    const v = fade(fy);
    const a = corner(ix, iy, fx, fy);
    const b = corner(ix + 1, iy, fx - 1, fy);
    const c = corner(ix, iy + 1, fx, fy - 1);
    const d = corner(ix + 1, iy + 1, fx - 1, fy - 1);
    const top = a + u * (b - a);
    const bottom = c + u * (d - c);
    return clamp(top + v * (bottom - top));
  };

  const exponent: number[] = [];
  let frequency = 1;
  for (let i = 0; i < MAX_OCTAVES; i += 1) {
    exponent.push(1 / Math.pow(frequency, hurst));
    frequency *= lacunarity;
  }

  const fbmPerlin = (x: number, y: number, octaves: number): number => {
    let value = 0;
    let px = x;
    let py = y;
    const whole = Math.min(MAX_OCTAVES - 1, Math.floor(octaves));
    for (let i = 0; i < whole; i += 1) {
      value += perlin(px, py) * (exponent[i] ?? 0);
      px *= lacunarity;
      py *= lacunarity;
    }
    // THE FRACTION OF AN OCTAVE, which libtcod adds at its own weight.
    const rest = octaves - Math.floor(octaves);
    if (rest > 0) value += rest * perlin(px, py) * (exponent[whole] ?? 0);
    return clamp(value);
  };

  return { perlin, fbmPerlin };
}
