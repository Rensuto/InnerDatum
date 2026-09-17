// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/engines/default/engine/Heightmap.lua:27-101
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE ENGINE'S FRACTAL HEIGHTMAP: MIDPOINT DISPLACEMENT OVER A RECT QUEUE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `engine.Heightmap` is what shapes ToME's organic rooms: `forest_clearing`
 * and `rocky_snowy_trees` each build one over their rectangle and cut it at a
 * height (`rooms/forest_clearing.lua:27`, `rooms/rocky_snowy_trees.lua:27`).
 *
 *   1. Every cell starts at 0. The four corners are set from `start`, or drawn.
 *   2. A queue holds the whole map as one rect. Taken FIRST IN, FIRST OUT, each
 *      rect wider or taller than one step writes the four midpoints of its
 *      edges as the averages of their two corners, and its centre as the
 *      average of all four plus a displacement that shrinks with the rect —
 *      then queues its four quarters.
 *
 * ═══ LUA TRUTHINESS DECIDES WHAT `start` MEANS ═══
 * Upstream reads `self.start.up_left or rng.range(...)` and
 * `force_middle = self.start.middle`. In Lua 0 IS TRUE, so the rooms'
 * `middle = Heightmap.min`, which is 0, FORCES the centre to 0 — the clearing
 * always has a low point in the middle. JavaScript's `||` would read it as
 * absent and displace the centre instead. Only `nil` and `false` mean "draw".
 *
 * ═══ THE DRAWS ═══
 * - A corner draws `rng.range(0, 100000)` only when `start` leaves it unset,
 *   in the order up_left, down_left, up_right, down_right.
 * - EVERY rect that subdivides draws one displacement, INCLUDING the first rect
 *   when its middle is forced and the draw is thrown away.
 *
 * ═══ OVERLAPS ARE UPSTREAM'S ═══
 * Neighbouring rects share an edge, so a later rect rewrites the midpoints an
 * earlier one wrote, and a rect one step wide rewrites its own corners with
 * averages (`nw` is 0 there). Nothing is protected — a forced centre can be
 * overwritten by a later rect that has it as a corner — and nothing here tries
 * to.
 */

import type { Rng } from '../rng.ts';
import { range, truthy } from './lua.ts';

/** `Heightmap.max` (`engine/Heightmap.lua:27`). */
export const HEIGHTMAP_MAX = 100000;
/** `Heightmap.min` (`engine/Heightmap.lua:28`). */
export const HEIGHTMAP_MIN = 0;

/** Upstream's default roughness (`engine/Heightmap.lua:38`). */
const DEFAULT_ROUGHNESS = 1.2;

/** A start value as Lua holds it: `null`, `undefined` and `false` are nil or false and draw. */
type StartValue = number | false | null | undefined;

/** `start` (`engine/Heightmap.lua:34`). Every field is read for its Lua truthiness. */
export type HeightmapStart = {
  readonly upLeft?: StartValue;
  readonly downLeft?: StartValue;
  readonly upRight?: StartValue;
  readonly downRight?: StartValue;
  /** Forces the FIRST rect's centre. `0` forces it to 0. */
  readonly middle?: StartValue;
};

/** A heightmap: upstream's `self` after `init`. */
export type Heightmap = {
  readonly w: number;
  readonly h: number;
  readonly roughness: number;
  readonly start: HeightmapStart;
  /** Upstream's 1-based `hmap[i][j]`, stored column `i-1`, row `j-1`, row-major. */
  readonly hmap: Float64Array;
};

/** `hmap[i][j]`, 1-based as upstream indexes it. */
export function heightAt(hm: Heightmap, i: number, j: number): number {
  if (i < 1 || j < 1 || i > hm.w || j > hm.h) {
    throw new RangeError(
      `hmap[${String(i)}][${String(j)}] is outside ${String(hm.w)}x${String(hm.h)}`,
    );
  }
  return hm.hmap[(j - 1) * hm.w + (i - 1)] ?? 0;
}

function setHeight(hm: Heightmap, i: number, j: number, v: number): void {
  if (i < 1 || j < 1 || i > hm.w || j > hm.h) {
    throw new RangeError(
      `hmap[${String(i)}][${String(j)}] is outside ${String(hm.w)}x${String(hm.h)}`,
    );
  }
  hm.hmap[(j - 1) * hm.w + (i - 1)] = v;
}

/**
 * `Heightmap.new(w, h, roughness, start)` → `_M:init` (`engine/Heightmap.lua:35-51`):
 * every cell 0, nothing drawn. `roughness` nil is 1.2.
 */
export function createHeightmap(
  w: number,
  h: number,
  roughness?: number | null,
  start?: HeightmapStart | null,
): Heightmap {
  return {
    w,
    h,
    roughness: truthy(roughness) ? (roughness as number) : DEFAULT_ROUGHNESS,
    start: start ?? {},
    hmap: new Float64Array(w * h),
  };
}

/** One queued rect: `{x1, y1, x2, y2, force_middle}`, all 1-based and inclusive. */
type Rect = {
  readonly r1: number;
  readonly r2: number;
  readonly r3: number;
  readonly r4: number;
  readonly forceMiddle: StartValue;
};

/** `self.start.X or rng.range(self.min, self.max)`. */
function corner(rng: Rng, label: string, v: StartValue): number {
  return truthy(v) ? (v as number) : range(rng, label, HEIGHTMAP_MIN, HEIGHTMAP_MAX);
}

/**
 * `_M:generate()` (`engine/Heightmap.lua:55-101`): fills `hm.hmap` and returns
 * it. See the file note for the draws and the Lua truthiness of `start`.
 */
export function generate(hm: Heightmap, rng: Rng, label = 'mapgen.heightmap'): Float64Array {
  const { w, h, start } = hm;
  // Four statements, in upstream's order: each draws only if its start is unset.
  setHeight(hm, 1, 1, corner(rng, `${label}.corner`, start.upLeft));
  setHeight(hm, 1, h, corner(rng, `${label}.corner`, start.downLeft));
  setHeight(hm, w, 1, corner(rng, `${label}.corner`, start.upRight));
  setHeight(hm, w, h, corner(rng, `${label}.corner`, start.downRight));

  // `table.remove(rects, 1)`: first in, first out.
  const rects: Rect[] = [{ r1: 1, r2: 1, r3: w, r4: h, forceMiddle: start.middle }];
  for (let head = 0; head < rects.length; head += 1) {
    const r = rects[head];
    if (r === undefined) break;
    const rw = r.r3 - r.r1;
    const rh = r.r4 - r.r2;
    if (!(rw > 1 || rh > 1)) continue;
    const nw = Math.floor(rw / 2);
    const nh = Math.floor(rh / 2);

    // The displacement is drawn whether or not the middle is forced.
    let d = ((rw + rh) / (w + h)) * hm.roughness;
    d = (range(rng, `${label}.displace`, 0, HEIGHTMAP_MAX) - HEIGHTMAP_MAX / 2) * d;

    const at = (i: number, j: number): number => heightAt(hm, i, j);
    setHeight(hm, r.r1 + nw, r.r2, (at(r.r1, r.r2) + at(r.r3, r.r2)) / 2);
    setHeight(hm, r.r1 + nw, r.r4, (at(r.r1, r.r4) + at(r.r3, r.r4)) / 2);
    setHeight(hm, r.r1, r.r2 + nh, (at(r.r1, r.r2) + at(r.r1, r.r4)) / 2);
    setHeight(hm, r.r3, r.r2 + nh, (at(r.r3, r.r2) + at(r.r3, r.r4)) / 2);
    if (truthy(r.forceMiddle)) {
      setHeight(hm, r.r1 + nw, r.r2 + nh, r.forceMiddle as number);
    } else {
      setHeight(
        hm,
        r.r1 + nw,
        r.r2 + nh,
        (at(r.r1, r.r2) + at(r.r1, r.r4) + at(r.r3, r.r2) + at(r.r3, r.r4)) / 4 + d,
      );
    }

    // Only the first rect carries a forced middle; its quarters do not.
    if (nw > 1 || nh > 1) {
      rects.push({ r1: r.r1, r2: r.r2, r3: r.r1 + nw, r4: r.r2 + nh, forceMiddle: null });
    }
    if (r.r3 - r.r1 - nw > 1 || nh > 1) {
      rects.push({ r1: r.r1 + nw, r2: r.r2, r3: r.r3, r4: r.r2 + nh, forceMiddle: null });
    }
    if (nw > 1 || r.r4 - r.r2 - nh > 1) {
      rects.push({ r1: r.r1, r2: r.r2 + nh, r3: r.r1 + nw, r4: r.r4, forceMiddle: null });
    }
    if (r.r3 - r.r1 - nw > 1 || r.r4 - r.r2 - nh > 1) {
      rects.push({ r1: r.r1 + nw, r2: r.r2 + nh, r3: r.r3, r4: r.r4, forceMiddle: null });
    }
  }
  return hm.hmap;
}
