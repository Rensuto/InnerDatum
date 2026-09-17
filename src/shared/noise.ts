// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from the T-Engine4 C core, which the reference tree does not ship: TCOD_noise_new,
//   normalize, lattice, TCOD_noise_perlin, TCOD_noise_simplex and TCOD_noise_fbm_int in
//   src/libtcod_import/noise_c.c (libtcod 1.5.0 as T-Engine4 vendors it) and noise_new in
//   src/noise.c, at T-Engine4 tag tome-1.6.0 (commit 0d95bc38; unchanged through tome-1.7.6)
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

/*
 * The libtcod code this file translates carries this notice, retained as its
 * licence requires:
 *
 * libtcod 1.5.0
 * Copyright (c) 2008,2009,2010 Jice
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *     * Redistributions of source code must retain the above copyright
 *       notice, this list of conditions and the following disclaimer.
 *     * Redistributions in binary form must reproduce the above copyright
 *       notice, this list of conditions and the following disclaimer in the
 *       documentation and/or other materials provided with the distribution.
 *     * The name of Jice may not be used to endorse or promote products
 *       derived from this software without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY Jice ``AS IS'' AND ANY
 * EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL Jice BE LIABLE FOR ANY
 * DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
 * (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
 * LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND
 * ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
 * (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
 * SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * NOISE — upstream's `core.noise`, which its caves and outdoor levels are made of.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `Forest.lua:147-150` builds every outdoor level from one call:
 *
 * ```lua
 * local noise = core.noise.new(2, self.hurst, self.lacunarity)
 * local v = math.floor((noise[self.noise](noise, self.zoom * i / self.map.w, self.zoom * j / self.map.h, self.octave) / 2 + 0.5) * self.max_percent)
 * ```
 *
 * `core.noise` is libtcod 1.5.0's noise module, vendored into the engine with
 * ONE change: its randomness comes from the game's own generator. This is that
 * C, method for method, with `shared/rng.ts` in the generator's place.
 *
 * ═══ WHAT IS EASY TO GET WRONG, BECAUSE THE TEXTBOOK SAYS OTHERWISE ═══
 * - HURST DOES NOTHING. `TCOD_noise_new` has `//exponent[i] = powf(f, -H);`
 *   commented out above `exponent[i] = 1.0f / f`, so octave weights are
 *   `1, 1/lac, 1/lac^2, ...` — 1, 1/2, 1/4, 1/8 at the default lacunarity —
 *   whatever hurst is. It is still accepted, because the Lua passes it.
 * - PERLIN INTERPOLATES WITH A CUBIC, `r*r*(3-2r)`, not the quintic of "improved"
 *   Perlin noise.
 * - FBM IS NOT NORMALISED. Four octaves at lacunarity 2 can sum towards 1.875
 *   before the clamp to +-0.99999 catches them; the plain `perlin` is clamped
 *   too, `simplex` is not.
 * - A FRACTIONAL OCTAVE COUNT adds the fraction of one more octave, but only
 *   when that fraction is above 1e-6.
 * - SIMPLEX HALVES ITS INPUT (`SIMPLEX_SCALE` 0.5) before skewing, uses a
 *   nonstandard eight-way gradient `(+-u +- 2v)`, and scales the 2D sum by 40 and
 *   the 1D sum by 0.25. It takes no octave argument.
 * - `FLOOR` IS A MACRO, `a > 0 ? (int)a : (int)a - 1`, which is `floor` except
 *   at zero and the negative integers. It is reproduced, quirks included.
 *
 * ═══ THE DRAWS, WHICH ARE THE LEVEL'S OWN ═══
 * Creating a noise object spends the generator: 256 rows of `ndim` gradient
 * components, each `genrand_real(-0.5, 0.5)` and each row normalised, then 255
 * swaps of the permutation `map`, `map[i]` with `map[rand_div(256)]` for `i`
 * from 255 down to 1 — any index, not Fisher-Yates. So a noise object made
 * mid-generation moves every number after it, as upstream's does. Labels are
 * `${label}.gradient` and `${label}.map`.
 *
 * ═══ PRECISION: CONSTANTS ARE C FLOATS, ARITHMETIC IS DOUBLE ═══
 * libtcod computes in single precision throughout. Here each C float LITERAL is
 * the value C actually holds (`Math.fround(0.99999)` is 0.99998998...), so a
 * clamp or a skew factor is exactly upstream's, while the arithmetic between
 * them runs in double and the inputs are not narrowed. The seeds are not
 * upstream's either, so no value here is bit-comparable anyway; what matters is
 * the field's shape. MEASURED against a float32 model of the same C (every
 * operation through `Math.fround`), 50,000 samples over twenty seeds: at most
 * 6.5e-7 apart for `perlin`, 5.9e-6 for `simplex`, 1.8e-6 for a four-octave
 * `fbmPerlin`; and Forest's `floor((v / 2 + 0.5) * 80)` came out different on
 * ONE sample in the 50,000. That is not a distribution, so double it stays.
 *
 * ═══ NOT PORTED ═══
 * 3D and 4D noise, wavelet noise and turbulence: no level generator uses them.
 */
import { genrandReal } from './mapgen/lua.ts';
import type { Rng } from './rng.ts';

/** `TCOD_NOISE_DEFAULT_HURST`. Stored upstream and never read — see the file note. */
export const DEFAULT_HURST = 0.5;
/** `TCOD_NOISE_DEFAULT_LACUNARITY`: how much finer each octave is. */
export const DEFAULT_LACUNARITY = 2;
/** `TCOD_NOISE_MAX_OCTAVES`: the length of the exponent table. */
const MAX_OCTAVES = 128;
/** The clamp on `perlin` and every `fbm`, as the float literal `0.99999f`. */
const LIMIT = Math.fround(0.99999);
/** `DELTA`, `1e-6f`: the smallest fraction of an octave that counts. */
const DELTA = Math.fround(1e-6);
/** `SIMPLEX_SCALE`: simplex noise samples at half the coordinate. */
const SIMPLEX_SCALE = 0.5;
/** The 2D skew factors as their float literals, `0.366025403f` and `0.211324865f`. */
const F2 = Math.fround(0.366025403);
const G2 = Math.fround(0.211324865);
/** The final scale of 2D and of 1D simplex noise. */
const SIMPLEX_2D_SCALE = 40;
const SIMPLEX_1D_SCALE = 0.25;
/** The permutation and gradient table size, and the mask that wraps into it. */
const TABLE = 256;
const MASK = 0xff;

export type Noise2 = {
  /** `perlin(x, y)`: gradient noise, clamped to +-0.99999. */
  readonly perlin: (x: number, y: number) => number;
  /** `fbm_perlin(x, y, octaves)`: summed octaves of `perlin`, clamped. */
  readonly fbmPerlin: (x: number, y: number, octaves: number) => number;
  /** `simplex(x, y)`: 2D simplex noise, NOT clamped. Takes no octaves. */
  readonly simplex: (x: number, y: number) => number;
  /** `fbm_simplex(x, y, octaves)`: summed octaves of `simplex`, clamped. */
  readonly fbmSimplex: (x: number, y: number, octaves: number) => number;
};

export type Noise1 = {
  /** `perlin(x)`: gradient noise, clamped to +-0.99999. */
  readonly perlin: (x: number) => number;
  /** `fbm_perlin(x, octaves)`: summed octaves of `perlin`, clamped. */
  readonly fbmPerlin: (x: number, octaves: number) => number;
  /** `simplex(x)`: 1D simplex noise, NOT clamped. Takes no octaves. */
  readonly simplex: (x: number) => number;
  /** `fbm_simplex(x, octaves)`: summed octaves of `simplex`, clamped. */
  readonly fbmSimplex: (x: number, octaves: number) => number;
};

/** `perlin_data_t`, less what nothing reads (`H`, the wavelet tile). */
type NoiseData = {
  readonly ndim: number;
  /** "Randomized map of indexes into buffer". */
  readonly map: Uint8Array;
  /** 256 rows of `ndim` unit-gradient components, row-major. */
  readonly buffer: Float64Array;
  readonly lacunarity: number;
  /** `exponent[i] = 1 / lacunarity^i`. */
  readonly exponent: Float64Array;
};

/**
 * The `FLOOR` macro: `(a) > 0 ? (int)a : (int)a - 1`. Not `Math.floor` at zero and
 * the negative integers — and yet the NOISE is the same there, because a lattice
 * offset of 1 with weight 1 lands on the same corner as an offset of 0 with
 * weight 0. Measured: 329,650 samples on every integer and half-integer in
 * -40..40, `Math.floor` in its place, at most 1.1e-16 apart (the LERP's
 * rounding). Kept as the macro reads anyway.
 */
function cFloor(a: number): number {
  const t = Math.trunc(a);
  return a > 0 ? t : t - 1;
}

/** The `CUBIC` macro: `a * a * (3 - 2*a)`. */
function cubic(a: number): number {
  return a * a * (3 - 2 * a);
}

/** libtcod's `LERP(a, b, x)`: `a + x * (b - a)`. */
function lerp(a: number, b: number, x: number): number {
  return a + x * (b - a);
}

/** libtcod's `CLAMP(-0.99999f, 0.99999f, x)`. NaN passes through, as it does in C. */
function clamp(v: number): number {
  return v < -LIMIT ? -LIMIT : v > LIMIT ? LIMIT : v;
}

/**
 * `TCOD_noise_new(ndim, hurst, lacunarity)`, T-Engine4's copy: gradients drawn
 * and normalised a row at a time, then the 255 permutation swaps, then the
 * exponent table. `hurst` is not a parameter because it is never read.
 */
function noiseNew(ndim: number, rng: Rng, label: string, lacunarity: number): NoiseData {
  const map = new Uint8Array(TABLE);
  const buffer = new Float64Array(TABLE * ndim);
  for (let i = 0; i < TABLE; i += 1) {
    map[i] = i;
    // `normalize`: the row divided by its length.
    let magnitude = 0;
    for (let j = 0; j < ndim; j += 1) {
      const v = genrandReal(rng, `${label}.gradient`, -0.5, 0.5);
      buffer[i * ndim + j] = v;
      magnitude += v * v;
    }
    magnitude = 1 / Math.sqrt(magnitude);
    for (let j = 0; j < ndim; j += 1)
      buffer[i * ndim + j] = (buffer[i * ndim + j] ?? 0) * magnitude;
  }

  // `while(--i)`: i from 255 down to 1, each swapped with ANY index.
  for (let i = TABLE - 1; i > 0; i -= 1) {
    const j = rng.int(`${label}.map`, 0, TABLE - 1);
    const tmp = map[i] ?? 0;
    map[i] = map[j] ?? 0;
    map[j] = tmp;
  }

  const exponent = new Float64Array(MAX_OCTAVES);
  let f = 1;
  for (let i = 0; i < MAX_OCTAVES; i += 1) {
    exponent[i] = 1 / f;
    f *= lacunarity;
  }
  return { ndim, map, buffer, lacunarity, exponent };
}

/**
 * `TCOD_noise_fbm_int`: `trunc(octaves)` whole octaves, each at `exponent[i]`
 * with the coordinates multiplied by the lacunarity after it, then the fraction
 * of one more when it is above `DELTA`, and the clamp.
 *
 * GUARD: past 128 whole octaves the C reads beyond its exponent table, which is
 * undefined; here the sum stops at 128.
 */
function fbm(
  data: NoiseData,
  point: readonly number[],
  octaves: number,
  func: (p: readonly number[]) => number,
): number {
  const tf = [...point];
  let value = 0;
  const whole = Math.trunc(octaves);
  let i = 0;
  for (; i < Math.min(whole, MAX_OCTAVES); i += 1) {
    value += func(tf) * (data.exponent[i] ?? 0);
    for (let j = 0; j < tf.length; j += 1) tf[j] = (tf[j] ?? 0) * data.lacunarity;
  }
  const fraction = octaves - whole;
  if (fraction > DELTA && i < MAX_OCTAVES) value += fraction * func(tf) * (data.exponent[i] ?? 0);
  return clamp(value);
}

/** `lattice` for one dimension: the gradient at `ix`, dotted with the offset `fx`. */
function lattice1(data: NoiseData, ix: number, fx: number): number {
  const n = data.map[ix & MASK] ?? 0;
  return (data.buffer[n] ?? 0) * fx;
}

/** `lattice` for two dimensions: the hash runs x then y through `map`. */
function lattice2(data: NoiseData, ix: number, fx: number, iy: number, fy: number): number {
  let n = data.map[ix & MASK] ?? 0;
  n = data.map[(n + iy) & MASK] ?? 0;
  return (data.buffer[n * 2] ?? 0) * fx + (data.buffer[n * 2 + 1] ?? 0) * fy;
}

/** `TCOD_noise_perlin`, `case 1`. */
function perlin1(data: NoiseData, x: number): number {
  const n = cFloor(x);
  const r = x - n;
  return clamp(lerp(lattice1(data, n, r), lattice1(data, n + 1, r - 1), cubic(r)));
}

/** `TCOD_noise_perlin`, `case 2`. */
function perlin2(data: NoiseData, x: number, y: number): number {
  const nx = cFloor(x);
  const ny = cFloor(y);
  const rx = x - nx;
  const ry = y - ny;
  const wx = cubic(rx);
  const wy = cubic(ry);
  return clamp(
    lerp(
      lerp(lattice2(data, nx, rx, ny, ry), lattice2(data, nx + 1, rx - 1, ny, ry), wx),
      lerp(
        lattice2(data, nx, rx, ny + 1, ry - 1),
        lattice2(data, nx + 1, rx - 1, ny + 1, ry - 1),
        wx,
      ),
      wy,
    ),
  );
}

/** `TCOD_NOISE_SIMPLEX_GRADIENT_1D`: `+-(1 + (h & 7))` times the offset. */
function gradient1(hash: number, x: number): number {
  const h = hash & 0xf;
  const grad = 1 + (h & 7);
  return ((h & 8) !== 0 ? -grad : grad) * x;
}

/** `TCOD_NOISE_SIMPLEX_GRADIENT_2D`: `(+-u +- v)` with `(u, v)` either `(x, 2y)` or `(y, 2x)`. */
function gradient2(hash: number, x: number, y: number): number {
  const h = hash & 0x7;
  const u = h < 4 ? x : y;
  const v = h < 4 ? 2 * y : 2 * x;
  return ((h & 1) !== 0 ? -u : u) + ((h & 2) !== 0 ? -v : v);
}

/**
 * `TCOD_noise_simplex`, `case 1`.
 *
 * `(int)FLOOR(f[0]*SIMPLEX_SCALE)` EXPANDS, because the macro does not bracket
 * its argument inside the cast, to a test on `f*0.5` with a body of
 * `(int)f * 0.5` — the truncation happens BEFORE the halving. The result is
 * `floor(f/2)` everywhere except zero and the negative even integers, where it
 * is one lower and the noise is 0 either way. Reproduced as written.
 */
function simplex1(data: NoiseData, x: number): number {
  const halfTrunc = Math.trunc(x) * SIMPLEX_SCALE;
  const i0 = Math.trunc(x * SIMPLEX_SCALE > 0 ? halfTrunc : halfTrunc - 1);
  const i1 = i0 + 1;
  const x0 = x * SIMPLEX_SCALE - i0;
  const x1 = x0 - 1;
  let t0 = 1 - x0 * x0;
  let t1 = 1 - x1 * x1;
  t0 *= t0;
  t1 *= t1;
  const n0 = gradient1(data.map[i0 & MASK] ?? 0, x0) * t0 * t0;
  const n1 = gradient1(data.map[i1 & MASK] ?? 0, x1) * t1 * t1;
  return SIMPLEX_1D_SCALE * (n0 + n1);
}

/**
 * `TCOD_noise_simplex`, `case 2`.
 *
 * GUARD: the first corner reads `map[jj]` with `jj = j % 256` UNMASKED, and C's
 * `%` keeps the sign, so a negative `j` reads before the table — undefined
 * behaviour. No generator samples negative coordinates (and at the origin that
 * corner's kernel is negative, so it is never read); here the index wraps with
 * `& 0xff` as every other lookup in the function does.
 */
function simplex2(data: NoiseData, x: number, y: number): number {
  const s = (x + y) * F2 * SIMPLEX_SCALE;
  const xs = x * SIMPLEX_SCALE + s;
  const ys = y * SIMPLEX_SCALE + s;
  const i = cFloor(xs);
  const j = cFloor(ys);
  const t = (i + j) * G2;
  const xo = i - t;
  const yo = j - t;
  const x0 = x * SIMPLEX_SCALE - xo;
  const y0 = y * SIMPLEX_SCALE - yo;
  const ii = i % TABLE;
  const jj = j % TABLE;
  const i1 = x0 > y0 ? 1 : 0;
  const j1 = x0 > y0 ? 0 : 1;
  const x1 = x0 - i1 + G2;
  const y1 = y0 - j1 + G2;
  const x2 = x0 - 1 + 2 * G2;
  const y2 = y0 - 1 + 2 * G2;
  const { map } = data;

  let n0 = 0;
  let t0 = 0.5 - x0 * x0 - y0 * y0;
  if (!(t0 < 0)) {
    const idx = map[(ii + (map[jj & MASK] ?? 0)) & MASK] ?? 0;
    t0 *= t0;
    n0 = gradient2(idx, x0, y0) * t0 * t0;
  }
  let n1 = 0;
  let t1 = 0.5 - x1 * x1 - y1 * y1;
  if (!(t1 < 0)) {
    const idx = map[(ii + i1 + (map[(jj + j1) & MASK] ?? 0)) & MASK] ?? 0;
    t1 *= t1;
    n1 = gradient2(idx, x1, y1) * t1 * t1;
  }
  let n2 = 0;
  let t2 = 0.5 - x2 * x2 - y2 * y2;
  if (!(t2 < 0)) {
    const idx = map[(ii + 1 + (map[(jj + 1) & MASK] ?? 0)) & MASK] ?? 0;
    t2 *= t2;
    n2 = gradient2(idx, x2, y2) * t2 * t2;
  }
  return SIMPLEX_2D_SCALE * (n0 + n1 + n2);
}

/**
 * `core.noise.new(2, hurst, lacunarity)` (C core: `noise_new`, src/noise.c):
 * a 2D noise field. Nil hurst and lacunarity are libtcod's defaults, 0.5 and 2.
 *
 * `hurst` IS ACCEPTED AND IGNORED, exactly as upstream stores it and never
 * reads it. `Forest:addPond` passes a pond's width here and its height as the
 * lacunarity; only the height changes the field.
 */
export function createNoise2(
  rng: Rng,
  label: string,
  _hurst: number = DEFAULT_HURST,
  lacunarity: number = DEFAULT_LACUNARITY,
): Noise2 {
  const data = noiseNew(2, rng, label, lacunarity);
  const perlin = (p: readonly number[]): number => perlin2(data, p[0] ?? 0, p[1] ?? 0);
  const simplex = (p: readonly number[]): number => simplex2(data, p[0] ?? 0, p[1] ?? 0);
  return {
    perlin: (x, y) => perlin2(data, x, y),
    fbmPerlin: (x, y, octaves) => fbm(data, [x, y], octaves, perlin),
    simplex: (x, y) => simplex2(data, x, y),
    fbmSimplex: (x, y, octaves) => fbm(data, [x, y], octaves, simplex),
  };
}

/**
 * `core.noise.new(1, hurst, lacunarity)` (C core: `noise_new`, src/noise.c): a
 * 1D noise line, as `RoomsLoader:makePod` and `CavernousTunnel` make. Its
 * gradients are +-1, and 1D simplex reads only the permutation.
 *
 * `hurst` IS ACCEPTED AND IGNORED — see `createNoise2`.
 */
export function createNoise1(
  rng: Rng,
  label: string,
  _hurst: number = DEFAULT_HURST,
  lacunarity: number = DEFAULT_LACUNARITY,
): Noise1 {
  const data = noiseNew(1, rng, label, lacunarity);
  const perlin = (p: readonly number[]): number => perlin1(data, p[0] ?? 0);
  const simplex = (p: readonly number[]): number => simplex1(data, p[0] ?? 0);
  return {
    perlin: (x) => perlin1(data, x),
    fbmPerlin: (x, octaves) => fbm(data, [x], octaves, perlin),
    simplex: (x) => simplex1(data, x),
    fbmSimplex: (x, octaves) => fbm(data, [x], octaves, simplex),
  };
}
