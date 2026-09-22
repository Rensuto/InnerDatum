// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// The metric under test ports t-engine4's core.fov.distance and calc_circle (src/fov.c, the
// C core the reference tree does not ship) under engine/Module.lua:918's "circle" shape.
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

import { describe, expect, it } from 'vitest';

import * as distance from '../../src/shared/distance.ts';
import { discTiles, euclidDistance, fovDistance, tileDistance } from '../../src/shared/distance.ts';
import * as geom from '../../src/shared/mapgen/geom.ts';
import type { TileXY } from '../../src/shared/coords.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ONE METRIC, ONE DISC, AND THE ORDER THE DISC IS WALKED IN.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Three things are pinned here and the third is the one that is easy to lose:
 *
 *   1. `core.fov.distance` ROUNDS — a diagonal is 1 and two diagonals are 3.
 *   2. The disc is `dx^2 + dy^2 <= r^2 + r`, which is exactly the tiles whose
 *      rounded distance is at most r.
 *   3. The disc is listed ROW-MAJOR, and the exact-Euclid disc `ballTiles` used
 *      to cut is an order-preserving subsequence of it. Anything applied to the
 *      list draws in its order, so that subsequence is the whole argument that
 *      widening a ball moves an outcome only where a body stands on an added
 *      tile.
 */

const O = { x: 0, y: 0 } as const;
const at = (x: number, y: number): TileXY => ({ x, y });
const key = (t: TileXY): string => `${String(t.x)},${String(t.y)}`;

/**
 * WHAT `ballTiles` WAS, frozen here as the reference the seed argument is about.
 * engine/talents.ts's body read `combatDistance(centre, tile) <= radius` over
 * this same row-major loop, and `combatDistance` is the unrounded length. It is
 * written out rather than imported because the production function no longer
 * cuts this disc, and the claim is about the list it used to produce.
 */
function exactBall(centre: TileXY, radius: number): TileXY[] {
  const tiles: TileXY[] = [];
  const span = Math.floor(radius);
  for (let dy = -span; dy <= span; dy += 1) {
    for (let dx = -span; dx <= span; dx += 1) {
      const tile = at(centre.x + dx, centre.y + dy);
      if (euclidDistance(centre, tile) <= radius) tiles.push(tile);
    }
  }
  return tiles;
}

describe('core.fov.distance — the rounded length', () => {
  it('rounds half-up, so a diagonal is 1 and two diagonals are 3', () => {
    const pins: readonly (readonly [number, number, number])[] = [
      [1, 1, 1], // 1.41
      [2, 2, 3], // 2.83
      [5, 2, 5], // 5.39
      [2, 1, 2], // 2.24
      [7, 7, 10], // 9.90
      [10, 5, 11], // 11.18
      [0, 0, 0],
    ];
    for (const [dx, dy, want] of pins) {
      expect(tileDistance(O, at(dx, dy)), `(${String(dx)},${String(dy)})`).toBe(want);
      expect(fovDistance(0, 0, dx, dy)).toBe(want);
      // Symmetric, and blind to the sign of either offset.
      expect(tileDistance(at(dx, dy), O)).toBe(want);
      expect(tileDistance(O, at(-dx, dy))).toBe(want);
      expect(tileDistance(O, at(dx, -dy))).toBe(want);
    }
  });

  it('is the one body geom.ts hands the level generators', () => {
    // A re-export, not a second copy: the generators, the talents and the
    // client measure with the same function object.
    expect(geom.fovDistance).toBe(distance.fovDistance);
  });

  it('keeps the exact length separately, and that one is not flat across a step', () => {
    expect(euclidDistance(O, at(3, 4))).toBe(5);
    expect(euclidDistance(O, at(1, 1))).toBe(Math.SQRT2);
    // THE REASON IT EXISTS. Rounding calls (1,0) and (1,1) the same distance,
    // and (2,0) and (2,1); a "did this step take me further" test needs the
    // strict increase the exact length gives.
    expect(tileDistance(O, at(1, 1))).toBe(tileDistance(O, at(1, 0)));
    expect(tileDistance(O, at(2, 1))).toBe(tileDistance(O, at(2, 0)));
    expect(euclidDistance(O, at(1, 1))).toBeGreaterThan(euclidDistance(O, at(1, 0)));
    expect(euclidDistance(O, at(2, 1))).toBeGreaterThan(euclidDistance(O, at(2, 0)));
  });
});

describe('calc_circle with no block — the disc', () => {
  it('holds 1, 9, 21, 37, 69, 97 and 137 tiles at radius 0 to 6', () => {
    const counts = [0, 1, 2, 3, 4, 5, 6].map((r) => discTiles(at(10, 10), r).length);
    expect(counts).toEqual([1, 9, 21, 37, 69, 97, 137]);
  });

  it('lists radius 1 as the whole 3x3, row by row', () => {
    expect(discTiles(at(5, 5), 1)).toEqual([
      at(4, 4),
      at(5, 4),
      at(6, 4),
      at(4, 5),
      at(5, 5),
      at(6, 5),
      at(4, 6),
      at(5, 6),
      at(6, 6),
    ]);
  });

  it('is exactly the tiles within that rounded distance, out to radius 12', () => {
    for (const centre of [at(0, 0), at(7, -3), at(-20, 41)]) {
      for (let r = 0; r <= 12; r += 1) {
        const got = discTiles(centre, r);
        const want: string[] = [];
        // A window two tiles wider than the disc, so a tile the disc wrongly
        // left out of its own bounding square is still looked at.
        for (let y = centre.y - r - 2; y <= centre.y + r + 2; y += 1) {
          for (let x = centre.x - r - 2; x <= centre.x + r + 2; x += 1) {
            if (tileDistance(centre, at(x, y)) <= r) want.push(key(at(x, y)));
          }
        }
        expect(got.map(key).sort(), `r=${String(r)} at ${key(centre)}`).toEqual(want.sort());
        expect(new Set(got.map(key)).size, 'a tile listed twice').toBe(got.length);
      }
    }
  });

  it('keeps every tile of the old exact disc, in the old order', () => {
    /**
     * THE SEED ARGUMENT, AS A PROPERTY. Filter the new list down to the tiles
     * the old exact disc held and the old list comes back, element for element.
     * So a walk over the new list meets every body the old walk met, in the
     * same relative order, and differs only by the bodies standing on the
     * added tiles. A list in any other order — x-major, as geom.ts's
     * `circleGrids` is — fails this.
     */
    for (const centre of [at(0, 0), at(9, 4), at(-3, -8)]) {
      for (let r = 0; r <= 12; r += 1) {
        const old = exactBall(centre, r);
        const kept = new Set(old.map(key));
        const filtered = discTiles(centre, r).filter((t) => kept.has(key(t)));
        expect(filtered, `r=${String(r)} at ${key(centre)}`).toEqual(old);
      }
    }
    // NOT VACUOUS: the two lists do differ, from radius 1 on.
    expect(exactBall(O, 1)).toHaveLength(5);
    expect(discTiles(O, 1)).toHaveLength(9);
  });

  it('truncates the radius, and is the centre alone under 1', () => {
    expect(discTiles(at(5, 5), 2.9)).toEqual(discTiles(at(5, 5), 2));
    for (const r of [0, 0.9, -3]) expect(discTiles(at(5, 5), r)).toEqual([at(5, 5)]);
  });

  it('hands back fresh tiles, never the body it was centred on', () => {
    // Callers centre balls on live actors. A list holding the actor itself
    // would move when the actor did.
    const body = { x: 3, y: 3, id: 'someone' };
    const [only] = discTiles(body, 0);
    expect(only).toEqual(at(3, 3));
    expect(only).not.toBe(body);
    expect(discTiles(body, 1)).not.toContain(body);
  });
});
