// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from the C core, which the reference tree does not ship:
//   `lua_fov_get_distance` in src/fov.c (`core.fov.distance`), and `calc_circle`
//   in src/fov.c with fov_circle's row height in src/fov/fov.c (the disc with no
//   block function) -- the tag and commit are recorded in src/shared/mapgen/geom.ts;
//   and t-engine4 game/engines/default/engine/Module.lua:915-918, which sets the
//   "circle" vision shape (`FOV_SHAPE_CIRCLE_ROUND`) that selects the rounding.
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * HOW FAR ONE TILE IS FROM ANOTHER, THE WAY ToME MEASURES IT.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ToME asks one question for every range, radius and targeting ring:
 * `core.fov.distance(x1, y1, x2, y2)`. It is C, and under the vision shape the
 * module sets (`engine/Module.lua:918`, `set_vision_shape("circle")`, which is
 * `FOV_SHAPE_CIRCLE_ROUND`) `lua_fov_get_distance` returns
 *
 *     (int)(sqrt(dx*dx + dy*dy) + 0.5)
 *
 * — the straight-line length ROUNDED HALF-UP to a whole number of tiles. So a
 * diagonal neighbour is 1, not 1.41, and two diagonal steps are 3, not 2.83.
 *
 * ═══ AND THE DISC IS THE SAME SET, WRITTEN THE WAY THE C WRITES IT ═══
 * `calc_circle` with no blocking terrain reaches every offset with
 * `dx^2 + dy^2 <= r^2 + r` (fov_circle's row height is
 * `(int)sqrt(r*r + r - dx*dx)`), the radius truncated to an integer. That is
 * exactly "`core.fov.distance <= r`", and not by coincidence: for a whole
 * `r` and whole offsets,
 *
 *     floor(sqrt(d2) + 0.5) <= r  <=>  sqrt(d2) < r + 0.5
 *                                 <=>  d2 < r^2 + r + 0.25
 *                                 <=>  d2 <= r^2 + r        (d2 is an integer)
 *
 * so `discTiles(c, r)` and `{ t : tileDistance(c, t) <= r }` are one set, and
 * test/shared/distance.test.ts holds them to it out to r = 12. Radius 1 is the
 * whole 3x3 block; radius 2 is the 5x5 less its four corners.
 *
 * ═══ WHY EXACT EUCLID IS KEPT, UNDER A NAME THAT SAYS WHAT IT IS NOT ═══
 * `euclidDistance` is the unrounded length, and it is NOT a ToME metric. It is
 * here for two jobs the rounded one cannot do:
 *
 *   - A MONOTONE "FURTHER AWAY" TEST. Rounding is flat across a step: (1,0) to
 *     (1,1) is 1 to 1, and (2,0) to (2,1) is 2 to 2. A "did this step take me
 *     further from the threat" test on the rounded value cannot see a step that
 *     did, and a retreating body that asks it holds still when it could have
 *     moved. Every real step away strictly increases the exact length.
 *   - OUR OWN TIE-BREAK SORTS, where two tiles the rounded metric calls equal
 *     still need a deterministic, sensible order.
 *
 * Anything that decides whether a talent, a shot or a ball REACHES must use
 * `tileDistance` (or `discTiles`), because that is the question ToME asks.
 *
 * ═══ A LEAF, SO BOTH SIDES AND THE LEVEL GENERATORS SHARE ONE BODY ═══
 * The only import is a type. The client bundle can take this file (it imports
 * nothing from shared/mapgen), and shared/mapgen/geom.ts re-exports
 * `fovDistance` from here rather than keeping its own copy — one body, so the
 * generators, the server and the aim preview cannot drift apart.
 *
 * PURE (src/shared/): no clock, no entropy, no host global.
 */

import type { TileXY } from './coords.ts';

/**
 * `core.fov.distance` under ToME's circle shape (`FOV_SHAPE_CIRCLE_ROUND`,
 * `ret_float` false): `(int)(sqrt(dx*dx + dy*dy) + 0.5)`, the Euclidean length
 * ROUNDED HALF-UP.
 *
 * `(0,0)` to `(1,1)` is 1 and `(0,0)` to `(2,2)` is 3. The coordinates are
 * doubles and are NOT truncated first, as the C's are not
 * (test/shared/mapgen/geom.test.ts pins 0.3 and 0.6).
 *
 * `Math.floor`, not the C's `(int)`: the argument is never negative, and for a
 * non-negative number the two are the same. `Math.round` is NOT the same
 * function — at 0.49999999999999994 it gives 0 where `floor(x + 0.5)` gives 1,
 * as the C does — but for a whole-number offset the square root never comes
 * within 6e-5 of a half (n <= 4e6), so on a grid the two agree and a
 * `Math.round` mutant survives every test. The `+ 0.5` is the C's, and it
 * stays.
 */
export function fovDistance(x1: number, y1: number, x2: number, y2: number): number {
  const dx = Math.abs(x2 - x1);
  const dy = Math.abs(y2 - y1);
  return Math.floor(Math.sqrt(dx * dx + dy * dy) + 0.5);
}

/** `fovDistance` between two tiles — the distance every range and radius is measured in. */
export function tileDistance(a: TileXY, b: TileXY): number {
  return fovDistance(a.x, a.y, b.x, b.y);
}

/**
 * The straight-line length, UNROUNDED. NOT a ToME metric: for monotone "further
 * away" tests and our own tie-break sorts only — see the header for why a
 * rounded length cannot answer either.
 */
export function euclidDistance(a: TileXY, b: TileXY): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * The tiles `calc_circle` reaches around `centre` with no blocking terrain:
 * every offset with `dx^2 + dy^2 <= r^2 + r`, `r = Math.trunc(radius)`.
 *
 * - A RADIUS UNDER 1 IS THE CENTRE ALONE. ToME projects a ball only when
 *   `typ.ball > 0` and always adds the stop tile itself
 *   (`engine/interface/ActorProject.lua:118-134`), and `circle_grids` always
 *   adds its origin.
 * - NO BOUNDS AND NO WALLS. The caller filters: `calc_circle`'s block function
 *   is a shadowcaster, not arithmetic, and it is not ported here.
 * - EVERY TILE IS A FRESH OBJECT, the centre included. Callers pass live bodies
 *   as the centre (`ballTiles(self, ...)`), and a list that held the body itself
 *   would move when the body did.
 *
 * ═══ ROW-MAJOR — `dy` OUTER, `dx` INNER — AND THE ORDER IS LOAD-BEARING ═══
 * Anything applied to this list draws in its order, so the order is part of the
 * replay. It is the order `ballTiles` always had. That ballTiles cut the EXACT
 * disc, `dx^2 + dy^2 <= r^2`, which for a whole `r` is a subset of this one, so
 * its list is this list with tiles removed and nothing reordered: a body on a
 * tile both discs share is met in the same place in the walk. Only a body on an
 * added tile changes what happens. Upstream's own table (`circle_grids`) has
 * no order at all, and geom.ts's `circleGrids` lists x-major — swapping to that
 * order WOULD move every draw, which is why this does not share its loop.
 */
export function discTiles(centre: TileXY, radius: number): TileXY[] {
  const r = Math.trunc(radius);
  if (r <= 0) return [{ x: centre.x, y: centre.y }];
  const reach = r * r + r;
  const tiles: TileXY[] = [];
  for (let dy = -r; dy <= r; dy += 1) {
    for (let dx = -r; dx <= r; dx += 1) {
      if (dx * dx + dy * dy <= reach) tiles.push({ x: centre.x + dx, y: centre.y + dy });
    }
  }
  return tiles;
}
