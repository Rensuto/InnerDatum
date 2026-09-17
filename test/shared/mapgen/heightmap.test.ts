// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// The generator under test is ported from t-engine4 game/engines/default/engine/Heightmap.lua:27-101.
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

import { describe, expect, it } from 'vitest';

import {
  HEIGHTMAP_MAX,
  createHeightmap,
  generate,
  heightAt,
} from '../../../src/shared/mapgen/heightmap.ts';
import type { HeightmapStart } from '../../../src/shared/mapgen/heightmap.ts';
import { createRng } from '../../../src/shared/rng.ts';
import type { Rng } from '../../../src/shared/rng.ts';

/** An Rng whose `int` answers from a script and records every call. */
function scripted(values: readonly number[]): { rng: Rng; calls: [string, number, number][] } {
  const queue = [...values];
  const calls: [string, number, number][] = [];
  const base = createRng('unused');
  const rng: Rng = {
    ...base,
    nextU32: () => {
      throw new Error('the heightmap draws only integers');
    },
    int: (label, lo, hi) => {
      calls.push([label, lo, hi]);
      const v = queue.shift();
      if (v === undefined) throw new Error(`draw ${String(calls.length)} was not scripted`);
      return v;
    },
  };
  return { rng, calls };
}

const BOWL: HeightmapStart = {
  middle: 0,
  upLeft: HEIGHTMAP_MAX,
  downLeft: HEIGHTMAP_MAX,
  upRight: HEIGHTMAP_MAX,
  downRight: HEIGHTMAP_MAX,
};

/**
 * `Heightmap:generate` again, written from the Lua with nested 1-based tables
 * and `table.remove(rects, 1)`, so a port that changed the queue order, a
 * midpoint or the displacement disagrees with it.
 */
function literal(
  w: number,
  h: number,
  roughness: number,
  start: HeightmapStart,
  rng: Rng,
): number[][] {
  const max = 100000;
  const or = (v: number | false | null | undefined): number =>
    v === undefined || v === null || v === false ? rng.int('corner', 0, max) : v;
  const hmap: number[][] = [];
  for (let i = 1; i <= w; i += 1) {
    hmap[i] = [];
    for (let j = 1; j <= h; j += 1) (hmap[i] as number[])[j] = 0;
  }
  const H = (i: number): number[] => hmap[i] as number[];
  H(1)[1] = or(start.upLeft);
  H(1)[h] = or(start.downLeft);
  H(w)[1] = or(start.upRight);
  H(w)[h] = or(start.downRight);
  const rects: { r: [number, number, number, number]; force?: number | false | null }[] = [
    { r: [1, 1, w, h], force: start.middle },
  ];
  while (rects.length > 0) {
    const { r, force } = rects.shift() as (typeof rects)[number];
    const [r1, r2, r3, r4] = r;
    const rw = r3 - r1;
    const rh = r4 - r2;
    if (rw > 1 || rh > 1) {
      const nw = Math.floor(rw / 2);
      const nh = Math.floor(rh / 2);
      let d = ((rw + rh) / (w + h)) * roughness;
      d = (rng.int('d', 0, max) - max / 2) * d;
      H(r1 + nw)[r2] = ((H(r1)[r2] as number) + (H(r3)[r2] as number)) / 2;
      H(r1 + nw)[r4] = ((H(r1)[r4] as number) + (H(r3)[r4] as number)) / 2;
      H(r1)[r2 + nh] = ((H(r1)[r2] as number) + (H(r1)[r4] as number)) / 2;
      H(r3)[r2 + nh] = ((H(r3)[r2] as number) + (H(r3)[r4] as number)) / 2;
      if (force !== undefined && force !== null && force !== false) {
        H(r1 + nw)[r2 + nh] = force;
      } else {
        H(r1 + nw)[r2 + nh] =
          ((H(r1)[r2] as number) +
            (H(r1)[r4] as number) +
            (H(r3)[r2] as number) +
            (H(r3)[r4] as number)) /
            4 +
          d;
      }
      if (nw > 1 || nh > 1) rects.push({ r: [r1, r2, r1 + nw, r2 + nh] });
      if (r3 - r1 - nw > 1 || nh > 1) rects.push({ r: [r1 + nw, r2, r3, r2 + nh] });
      if (nw > 1 || r4 - r2 - nh > 1) rects.push({ r: [r1, r2 + nh, r1 + nw, r4] });
      if (r3 - r1 - nw > 1 || r4 - r2 - nh > 1) rects.push({ r: [r1 + nw, r2 + nh, r3, r4] });
    }
  }
  return hmap;
}

describe('Heightmap', () => {
  it('works a 3x3 out by hand: corners, edge midpoints, and a displaced centre', () => {
    // Corners 0, 100000, 40000, 60000 in upstream's order (up_left, down_left,
    // up_right, down_right); displacement roll 80000, so d = 30000 * (4/6 * 2).
    const { rng, calls } = scripted([0, 100000, 40000, 60000, 80000]);
    const hm = createHeightmap(3, 3, 2, {});
    generate(hm, rng);
    expect(calls.map(([, lo, hi]) => [lo, hi])).toEqual(Array(5).fill([0, 100000]));
    const rows = [1, 2, 3].map((j) => [1, 2, 3].map((i) => heightAt(hm, i, j)));
    expect(rows).toEqual([
      [0, 20000, 40000],
      [50000, 90000, 50000],
      [100000, 80000, 60000],
    ]);
  });

  it('draws no corner that start gives, and forces a middle of 0 because 0 is true in Lua', () => {
    const { rng, calls } = scripted([80000]);
    const hm = createHeightmap(3, 3, 2, BOWL);
    generate(hm, rng);
    // One draw: the displacement, made and thrown away.
    expect(calls).toHaveLength(1);
    expect(heightAt(hm, 2, 2)).toBe(0);
    expect(heightAt(hm, 1, 1)).toBe(HEIGHTMAP_MAX);
  });

  it('draws a corner that start leaves nil or false', () => {
    const { rng, calls } = scripted([7, 8, 80000]);
    const hm = createHeightmap(3, 3, 2, {
      upLeft: null,
      downLeft: false,
      upRight: 5,
      downRight: 6,
    });
    generate(hm, rng);
    expect(calls).toHaveLength(3);
    expect([
      heightAt(hm, 1, 1),
      heightAt(hm, 1, 3),
      heightAt(hm, 3, 1),
      heightAt(hm, 3, 3),
    ]).toEqual([7, 8, 5, 6]);
  });

  it('draws one displacement per rect that subdivides, forced middle or not', () => {
    // 5x5: the whole map, then its four 3x3 quarters, and nothing smaller.
    for (const start of [BOWL, { ...BOWL, middle: null }]) {
      const { rng, calls } = scripted(Array(5).fill(50000));
      generate(createHeightmap(5, 5, 2, start), rng);
      expect(calls).toHaveLength(5);
    }
  });

  it('forces only the first rect`s middle', () => {
    const { rng } = scripted(Array(5).fill(100000));
    const hm = createHeightmap(5, 5, 2, BOWL);
    generate(hm, rng);
    expect(heightAt(hm, 3, 3)).toBe(0);
    // A quarter's centre is displaced by +50000 * (4/10 * 2) on its corners' mean.
    expect(heightAt(hm, 2, 2)).toBeGreaterThan(0);
  });

  it('defaults roughness to 1.2 when it is nil', () => {
    expect(createHeightmap(4, 4).roughness).toBe(1.2);
    expect(createHeightmap(4, 4, 0).roughness).toBe(0);
  });

  it('matches the Lua, queue order and all, on every room size', () => {
    for (let s = 0; s < 40; s += 1) {
      const w = 5 + (s % 8);
      const h = 5 + ((s * 3) % 8);
      const start = s % 2 === 0 ? BOWL : {};
      const hm = createHeightmap(w, h, 2, start);
      generate(hm, createRng(`hm:${String(s)}`));
      const want = literal(w, h, 2, start, createRng(`hm:${String(s)}`));
      for (let i = 1; i <= w; i += 1) {
        for (let j = 1; j <= h; j += 1) expect(heightAt(hm, i, j)).toBe(want[i]?.[j]);
      }
    }
  });
});
