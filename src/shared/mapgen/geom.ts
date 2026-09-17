// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/engines/default/engine/utils.lua:2358-2361 (line.new)
//   and game/engines/default/engine/utils.lua:2178-2199 (core.fov.circle_grids)
//   and game/engines/default/engine/Module.lua:915-918 (the "circle" vision shape);
//   and the C core, which the reference tree does not ship: lua_line_init and
//   lua_line_step (the `bresenham` library) in src/core_lua.c, lua_fov_get_distance
//   and calc_circle in src/fov.c, and fov_circle's GET_HEIGHT in src/fov/fov.c
//   (all at T-Engine4 tag tome-1.6.0, commit 0d95bc38; unchanged through tome-1.7.6)
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE ENGINE'S GEOMETRY, AS THE LEVEL GENERATORS CALL IT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Three native calls the generators lean on: `line.new` (RoomsLoader's
 * `makePod`, Forest's `addPond`), `core.fov.distance` (both, to stop a line)
 * and `core.fov.circle_grids` (events, spot searches). All three are C. Each
 * answer below is the C's, including where it is not the textbook's:
 *
 *   - the line NEVER yields its start, ALWAYS yields its end last, and yields
 *     nothing at all when start and end are the same cell;
 *   - the distance ROUNDS the Euclidean length half-up to an integer;
 *   - the circle is every offset with `dx^2 + dy^2 <= r^2 + r`, which is the
 *     same set as "distance <= r".
 *
 * ToME's vision shape is "circle" (`engine/Module.lua:918`), the C's
 * `FOV_SHAPE_CIRCLE_ROUND`, and that shape is the only one ported.
 */

import type { TileXY } from '../coords.ts';
import { cInt } from './lua.ts';

/** `stepx`/`stepy`: the sign of a delta, 0 for none. */
function step(delta: number): number {
  return delta > 0 ? 1 : delta < 0 ? -1 : 0;
}

/**
 * `line.new(sx, sy, tx, ty)` (`engine/utils.lua:2358-2361`), which on a square
 * grid is `bresenham.new` — libtcod's Bresenham line (C core: `lua_line_init`
 * and `lua_line_step`, src/core_lua.c). Every cell the Lua iterator yields, in
 * order.
 *
 * - COORDINATES TRUNCATE toward zero (`int xFrom = luaL_checknumber(...)`).
 *   `makePod` passes a float radius, so this matters.
 * - THE START IS NEVER YIELDED; the first cell is one step along.
 * - THE END IS ALWAYS YIELDED, and it is the last cell. A zero-length line
 *   yields NOTHING.
 * - THE MAJOR AXIS IS x ONLY WHEN `|dx| > |dy|` STRICTLY. On a tie y leads,
 *   which draws the same cells for a true diagonal.
 * - Each cell advances one step on the major axis. The minor axis after `k`
 *   steps sits at `k * minor / major` rounded to the nearest integer, with a
 *   TIE ROUNDED TOWARD THE START: `(0,0)` to `(4,2)` is `1,0 2,1 3,1 4,2`.
 */
export function line(x1: number, y1: number, x2: number, y2: number): TileXY[] {
  let origx = cInt(x1);
  let origy = cInt(y1);
  const destx = cInt(x2);
  const desty = cInt(y2);
  let deltax = destx - origx;
  let deltay = desty - origy;
  const stepx = step(deltax);
  const stepy = step(deltay);
  let e = stepx * deltax > stepy * deltay ? stepx * deltax : stepy * deltay;
  deltax *= 2;
  deltay *= 2;
  const xMajor = stepx * deltax > stepy * deltay;

  const cells: TileXY[] = [];
  for (;;) {
    if (xMajor) {
      if (origx === destx) break;
      origx += stepx;
      e -= stepy * deltay;
      if (e < 0) {
        origy += stepy;
        e += stepx * deltax;
      }
    } else {
      if (origy === desty) break;
      origy += stepy;
      e -= stepx * deltax;
      if (e < 0) {
        origx += stepx;
        e += stepy * deltay;
      }
    }
    cells.push({ x: origx, y: origy });
  }
  return cells;
}

/**
 * `core.fov.distance(x1, y1, x2, y2)` under ToME's circle shape (C core:
 * `lua_fov_get_distance`, src/fov.c, `FOV_SHAPE_CIRCLE_ROUND`):
 * `(int)(sqrt(dx*dx + dy*dy) + 0.5)`, the Euclidean length ROUNDED HALF-UP.
 *
 * So `(0,0)` to `(1,1)` is 1 and `(0,0)` to `(2,2)` is 3. The coordinates are
 * doubles and are NOT truncated first.
 */
export function fovDistance(x1: number, y1: number, x2: number, y2: number): number {
  const dx = Math.abs(x2 - x1);
  const dy = Math.abs(y2 - y1);
  return Math.floor(Math.sqrt(dx * dx + dy * dy) + 0.5);
}

/** Where a circle may reach: the level's size, or a test of one cell. */
export type CircleBounds =
  { readonly w: number; readonly h: number } | ((x: number, y: number) => boolean);

/**
 * `core.fov.circle_grids(x, y, radius)` with no blocking terrain
 * (`engine/utils.lua:2178-2199`) — every cell `calc_circle` reaches, plus the
 * origin.
 *
 * - THE DISC IS `dx^2 + dy^2 <= r^2 + r`: `fov_circle`'s row height is
 *   `(int)sqrt(r*r + r - dx*dx)`, the same set as `fovDistance <= r`. At radius
 *   1 that is the whole 3x3 block; at radius 2 it is the 5x5 without its corners.
 * - x, y and the radius TRUNCATE (`int` in `calc_circle`). A radius under 1
 *   reaches nothing but the origin.
 * - CELLS OUTSIDE THE BOUNDS ARE SKIPPED (`map_seen`), and the edge does not
 *   shade any cell inside it. THE ORIGIN IS ALWAYS INCLUDED — the Lua adds it
 *   after the C returns, bounds or no bounds.
 *
 * Upstream hands back a `grids[x][y]` table, which has no order. This lists x
 * ascending, then y ascending, so a caller that draws once per cell draws the
 * same numbers every run.
 *
 * NOT PORTED: a `block` function. With one, `calc_circle` shadowcasts, and that
 * is `fov.c`'s LARGE_ASS algorithm rather than this arithmetic.
 */
export function circleGrids(x: number, y: number, radius: number, bounds: CircleBounds): TileXY[] {
  const cx = cInt(x);
  const cy = cInt(y);
  const r = cInt(radius);
  const inBounds =
    typeof bounds === 'function'
      ? bounds
      : (px: number, py: number): boolean => px >= 0 && py >= 0 && px < bounds.w && py < bounds.h;
  const reach = r > 0 ? r * r + r : 0;
  const cells: TileXY[] = [];
  const span = Math.max(r, 0);
  for (let dx = -span; dx <= span; dx += 1) {
    for (let dy = -span; dy <= span; dy += 1) {
      const px = cx + dx;
      const py = cy + dy;
      const isOrigin = dx === 0 && dy === 0;
      if (isOrigin || (dx * dx + dy * dy <= reach && inBounds(px, py))) {
        cells.push({ x: px, y: py });
      }
    }
  }
  return cells;
}
