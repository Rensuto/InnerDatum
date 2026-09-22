// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/engines/default/engine/utils.lua:2178-2199 (core.fov.circle_grids, the origin)
//   and game/engines/default/engine/Module.lua:915-918 (the settings ToME boots with);
//   and the C core, which the reference tree does not ship: lua_fov_calc_circle,
//   map_seen and map_opaque in src/fov.c, and fov_circle, _large_ass_fov_circle,
//   LARGE_ASS_FOV_DEFINE_OCTANT_ZERO, LARGE_ASS_FOV_DEFINE_OCTANT,
//   GET_NEXT_LARGE_ASS_DATA, GET_BUFFER and GET_HEIGHT in src/fov/fov.c
//   (line numbers below are the reference checkout's HEAD, commit 304327e0)
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * `core.fov.calc_circle` WITH A BLOCK FUNCTION: THE SHADOWCAST DISC
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `discTiles` (shared/distance.ts) and `circleGrids` (geom.ts) are the disc
 * with nothing in the way, and that is arithmetic. Give `calc_circle` a block
 * function and it shadowcasts instead: libfov's "large actor recursive
 * shadowcasting", `FOV_ALGO_LARGE_ASS`, one octant at a time. ToME's balls,
 * lingering clouds and monster sight all come through it. Nothing called this
 * when it landed; `shared/ball.ts` lays every ball in the game through it now.
 *
 * ═══ THE CONFIGURATION: ToME's, AND ONLY ToME's ═══
 * `engine/Module.lua:915-918` sets these before any module code runs:
 *   - algorithm "large_ass" (`FOV_ALGO_LARGE_ASS`);
 *   - permissiveness 0.01, which the C holds as `0.5f - 0.005f`, the float
 *     nearest 0.495 (`TOME_PERMISSIVENESS`, fovline.ts);
 *   - actor vision size 1, held as 0.5f, so the source is the whole tile:
 *     `y_min` is 0 and `y_max` is 1;
 *   - vision shape "circle" (`FOV_SHAPE_CIRCLE_ROUND`): column dx reaches
 *     `(int)sqrt(r*r + r - dx*dx)` rows, so the open disc is every offset with
 *     `dx^2 + dy^2 <= r^2 + r`, the same set as `discTiles`.
 *
 * ═══ WHAT IT REACHES ═══
 * - A WALL FACE THE SOURCE CAN SEE IS REACHED. An opaque cell is applied like
 *   an open one; the cells it hides are not.
 * - RADIUS 1 IS ALWAYS THE WHOLE IN-BOUNDS 3x3, whatever blocks. Every
 *   octant's first column scans rows 0 and 1, and no exit can fire before
 *   row 1 has been applied.
 * - OFF-MAP IS OPAQUE, and `block` is never asked about it (`map_opaque`). An
 *   off-map cell is never applied (`map_seen`).
 * - THE ORIGIN IS APPLIED LAST, by `lua_fov_calc_circle` itself: bounds-checked,
 *   and its own opacity never asked. `circle_grids` adds it again in Lua,
 *   bounds or no bounds (`engine/utils.lua:2194-2196`), and so does
 *   `circleCells`.
 * - `block` IS ASKED EVEN AT RADIUS 0. Each octant's `_ZERO` probes the cell
 *   beside the source before the radius cut, so the four orthogonal neighbours
 *   are asked twice each and nothing but the origin is applied.
 *
 * ═══ THE ORDER ═══
 * `calcCircle` calls `apply` in the C's order: octants ppn, ppy, pmy, mpn, mmn,
 * mmy, mpy, pmn; inside one, column by column outward with dy ascending, and
 * the region below each blocker run to its end BEFORE the column continues;
 * the origin last. ToME throws that order away (`grids[x][y]`, then `pairs`),
 * so `circleCells` returns the set ROW-MAJOR, dy outer and dx inner: the order
 * `discTiles` and `ballTiles` walk. Swapping one for the other reorders
 * nothing; only a tile added or removed can move a draw.
 *
 * ═══ THE FLOATS ARE C `float`s ═══
 * Every slope, start and boundary is single precision in the C, the column
 * extents are `(int)` of float sums, and the exits compare float differences
 * against `GRID_EPSILON` (`1.0e-5f`). So every float operation here goes
 * through `Math.fround`, left to right as C associates it, every `(int)` is
 * `Math.trunc`, and the boundary lists live in a `Float32Array`. The distance
 * handed to `apply` is DOUBLE arithmetic in the C (`lua_fov_get_distance`
 * takes doubles), so it is `fovDistance`, with only the `(float)` casts of
 * its coordinates kept.
 *
 * WHAT IT WAS CHECKED AGAINST: libfov's own C, compiled for x86-64 with SSE
 * floats (MSVC), which this matched trace for trace, every `block` call and
 * every `apply` in order, on 46,000 random maps. The tests' header says how.
 * THE FLOATS DO DECIDE CELLS, rarely. A fully double copy of this file agreed
 * with it on all 43,120 random maps it was first run on, but the independent
 * oracle (test/shared/mapgen/fovcircle-oracle.test.ts) pins a minimised map
 * where (12,7) is seen in doubles and hidden in the C's floats — and hidden
 * here. A copy that dropped only this file's `fround` also changed the trace
 * on the tests' wide maps. They are kept because they are the C's.
 *
 * ═══ ONE CHANGE: THE RING IS THE CIRCLE'S OWN ═══
 * libfov carves its slope lists out of ONE static 2,048-float ring shared by
 * every FOV and LOS call in the process (`fov_settings_init` points every
 * settings struct at `global_buffer_data`). `src/shared/` may not keep state
 * between calls, so each circle gets a fresh ring starting at 0, exactly as
 * each LOS line does (fovline.ts). The ring's position is not observable
 * unless one circle's live lists outgrow 2,048 floats; `largeAssFovCircle`
 * takes a ring so the tests can start it anywhere and carry it across calls.
 *
 * ═══ THE C, BY LINE (reference HEAD 304327e0, read with `git show`) ═══
 * These files are not in the sparse checkout, so tools/check-citations.mjs
 * cannot resolve them; the ranges are prose, not `file:line` citations.
 *   src/fov/fov.c
 *     lines 427-458   GET_HEIGHT, the CIRCLE_ROUND case     -> `circleHeight`
 *     lines 578-587   GET_BUFFER                            -> fovline.ts `getBuffer`
 *     lines 598-687   GET_NEXT_LARGE_ASS_DATA               -> `getNext`, a private copy
 *     lines 690-827   LARGE_ASS_FOV_DEFINE_OCTANT           -> `largeAssFovOctant`
 *     lines 829-836   its eight instantiations              -> `OCTANTS`
 *     lines 839-885   LARGE_ASS_FOV_DEFINE_OCTANT_ZERO      -> `largeAssFovOctantZero`
 *     lines 1299-1308 _large_ass_fov_circle                 -> `OCTANTS`, `largeAssFovCircle`
 *     lines 1339-1368 fov_circle, square-grid branch        -> `largeAssFovCircle`
 *   src/fov/fov.h
 *     line 56         GRID_EPSILON                          -> fovline.ts
 *     line 101        FOV_BUFFER_SIZE                       -> fovline.ts
 *   src/fov.c
 *     lines 113-176   lua_fov_get_distance, CIRCLE_ROUND    -> distance.ts `fovDistance`
 *     lines 178-197   map_seen                              -> `calcCircle`
 *     lines 199-221   map_opaque, with no cache             -> `calcCircle`
 *     lines 223-260   lua_fov_calc_circle                   -> `calcCircle`
 *
 * ═══ WHERE THE PORT IS NOT A TRANSCRIPTION ═══
 * - GET_HEIGHT reads a 528-entry table for radius < 33 and the formula above
 *   it. Only the formula is here; the tests compare it with every table entry.
 * - `apply_edge` and `apply_diag` are octant arguments passed unchanged down
 *   every recursion; they live in the octant's record instead.
 * - NULL boundary pointers are `NO_LIST`. The C reads a list only while its
 *   length is non-zero, and NULL is only ever passed with a length of 0.
 *
 * NOT PORTED: the eighth argument, a `fov{cache}` userdata, which makes
 * `map_opaque` read a precomputed grid instead of calling `block` (a caller
 * that wants it passes a `block` that reads the same grid); every other
 * vision shape and `FOV_ALGO_RECURSIVE_SHADOW` (ToME sets neither); the hex
 * grid (ToME's is square, `engine/utils.lua:1856`); beams (`calc_beam`); and
 * the C's `int` overflow of `r*r + r` past a radius of 46,340.
 */

import type { TileXY } from '../coords.ts';
import { fovDistance } from '../distance.ts';
import {
  FOV_BUFFER_SIZE,
  GRID_EPSILON,
  K,
  X,
  Y,
  getBuffer,
  sgn,
  sum,
  tomeFovSettings,
} from './fovline.ts';
import type { Axes, Axis, FovSettings, MapBounds, Opaque, Ring } from './fovline.ts';
import { cInt } from './lua.ts';

const f = Math.fround;

/** A NULL boundary list. Never read: the C passes NULL only with a length of 0. */
const NO_LIST = -1;

/** `settings->apply(map, x, y, dx, dy, radius, src)`: a cell, and its offset from the source. */
export type FovApply = (x: number, y: number, dx: number, dy: number) => void;

/** The Lua `apply(_, x, y, dx, dy, sqdist)` that `calc_circle` calls (`map_seen`). */
export type CircleApply = (x: number, y: number, dx: number, dy: number, sqdist: number) => void;

/**
 * One `LARGE_ASS_FOV_DEFINE_OCTANT(signx, signy, rx, ry, nx, ny, nf)`
 * instantiation, with the `apply_edge`/`apply_diag` pair
 * `_large_ass_fov_circle` hands it.
 *
 * `rx` is the PRIMARY axis and `signx` its direction; `ry` and `signy` the
 * secondary. The naming trap is the macro's own: in the `y` octants `signx`
 * applies to y, so `pmy` walks +y and spreads toward -x.
 */
type Octant = {
  readonly name: string;
  readonly signx: 1 | -1;
  readonly signy: 1 | -1;
  readonly rx: Axis;
  readonly ry: Axis;
  readonly applyEdge: boolean;
  readonly applyDiag: boolean;
};

/**
 * `_large_ass_fov_circle`'s eight calls, in its order. Each axis and each
 * diagonal has exactly one owner: the edge (dy = 0) is applied only where
 * `applyEdge` is set, the diagonal (dy = dx) only where `applyDiag` is.
 */
const OCTANTS: readonly Octant[] = [
  { name: 'ppn', signx: 1, signy: 1, rx: 'x', ry: 'y', applyEdge: true, applyDiag: true },
  { name: 'ppy', signx: 1, signy: 1, rx: 'y', ry: 'x', applyEdge: true, applyDiag: false },
  { name: 'pmy', signx: 1, signy: -1, rx: 'y', ry: 'x', applyEdge: false, applyDiag: true },
  { name: 'mpn', signx: -1, signy: 1, rx: 'x', ry: 'y', applyEdge: true, applyDiag: false },
  { name: 'mmn', signx: -1, signy: -1, rx: 'x', ry: 'y', applyEdge: false, applyDiag: true },
  { name: 'mmy', signx: -1, signy: -1, rx: 'y', ry: 'x', applyEdge: true, applyDiag: false },
  { name: 'mpy', signx: -1, signy: 1, rx: 'y', ry: 'x', applyEdge: false, applyDiag: true },
  { name: 'pmn', signx: 1, signy: -1, rx: 'x', ry: 'y', applyEdge: false, applyDiag: false },
];

/** `fov_private_data_type`, the fields one circle shares across its octants. */
type CircleData = {
  readonly settings: FovSettings;
  readonly ring: Ring;
  readonly source: Readonly<Axes>;
  readonly radius: number;
  readonly apply: FovApply;
};

/**
 * `GET_HEIGHT(h, dx, data, settings)` under `FOV_SHAPE_CIRCLE_ROUND`: how many
 * rows column `dx` reaches, `(int)sqrt(r*r + r - dx*dx)`. The C reads a table
 * for radius < 33 (`heights_tables`, src/fov/fov.c) and this formula above it;
 * the tests hold the formula to every entry of the table. Only called with
 * `1 <= dx <= radius`.
 */
export function circleHeight(radius: number, dx: number): number {
  return Math.trunc(Math.sqrt(radius * radius + radius - dx * dx));
}

/**
 * `large_ass_fov_octant_##nx##ny##nf` (`LARGE_ASS_FOV_DEFINE_OCTANT`, C core:
 * src/fov/fov.c): one column `dx` of one octant, then the columns beyond it.
 *
 * The column is scanned dy ascending between a LOWER and an UPPER constraint,
 * each a start, a slope and a convex list of boundary points. An opaque cell
 * met after an open one is applied, and the region below it recursed into at
 * once with a tightened upper constraint; an open cell met after an opaque one
 * tightens the lower constraint for the rest of the column, or ends this
 * frame's wedge if nothing is left between the two (a recursive frame returns
 * to its parent, whose column goes on). If the last cell scanned
 * was open, the next column continues above.
 *
 * Transcribed branch for branch; variable names are the macro's. `apply` is
 * called only for `cy0 < dy < cy1`, so the scan row `dy = dx + 1` is read for
 * opacity and never applied.
 */
function largeAssFovOctant(
  data: CircleData,
  o: Octant,
  dx: number,
  lowerBlenIn: number,
  upperBlen: number,
  lowerSlopeIn: number,
  upperSlope: number,
  lowerStartYIn: number,
  upperStartY: number,
  yMin: number,
  yMax: number,
  lowerBoundariesIn: number,
  upperBoundaries: number,
): void {
  // The C reassigns these four arguments mid-column (the open-after-opaque branch).
  let lowerBlen = lowerBlenIn;
  let lowerSlope = lowerSlopeIn;
  let lowerStartY = lowerStartYIn;
  let lowerBoundaries = lowerBoundariesIn;

  let nextBlen = 0;
  let prevBlocked = -1;
  const settings = data.settings;
  let fdy = 0;
  let nextSlope = 0;
  let prevSlope = 0;
  let slope = 0;
  let nextStartY = 0;
  let fdx = f(dx);
  const pms = settings.permissiveness;
  let boundary = 0;
  let nextBoundaries = 0;
  let prevBoundary = 0;
  let ptrEnd = 0;
  const ring = data.ring;
  const buf = ring.buffer;
  const at = (i: number): number => buf[i] ?? 0;
  /** The cell under test, in map coordinates; `x` and `y` in the macro. */
  const c: Axes = { x: 0, y: 0 };

  /**
   * `GET_NEXT_LARGE_ASS_DATA(min, max, low, upp, , do_command)` for the upper
   * constraint; `lowerVariant` is `(max, min, upp, low, -, do_command)`.
   *
   * A private copy of fovline.ts's, which is a closure over the LOS octant and
   * is left untouched. Two differences: it reads this octant's constraints,
   * and it keeps `do_command`, which the C passes false exactly once (the
   * opaque-after-opaque test). With it false the macro skips `next_blen` and
   * `next_start_y`, and nothing reads either before the next true call
   * rewrites them, so passing true there changes no output; it is kept
   * because it is the C.
   *
   * The macro's last clamp reads `y_min` itself, not `y_##min`, so both
   * variants clamp against the lower edge. Kept.
   */
  const getNext = (lowerVariant: boolean, doCommand: boolean): void => {
    const yA = lowerVariant ? yMax : yMin;
    const yB = lowerVariant ? yMin : yMax;
    const sg = lowerVariant ? -1 : 1;
    const uppBlen = lowerVariant ? lowerBlen : upperBlen;
    const uppBounds = lowerVariant ? lowerBoundaries : upperBoundaries;
    const lowBlen = lowerVariant ? upperBlen : lowerBlen;
    const lowBounds = lowerVariant ? upperBoundaries : lowerBoundaries;
    const uppSlope = lowerVariant ? lowerSlope : upperSlope;
    if (doCommand) nextBlen = 3;
    nextSlope = f(f(fdy - yA) / fdx);
    if (doCommand) nextStartY = yA;
    nextBoundaries = getBuffer(ring, uppBlen + 3);
    boundary = nextBoundaries;
    if (uppBlen === 0) {
      buf[boundary + X] = fdx;
      buf[boundary + Y] = fdy;
      buf[boundary + K] = f(f(fdy - yB) / fdx);
    } else {
      prevBoundary = uppBounds;
      ptrEnd = uppBounds + uppBlen;
      let isFirst = true;
      do {
        prevSlope = isFirst
          ? f(f(at(prevBoundary + Y) - yB) / at(prevBoundary + X))
          : f(
              f(at(prevBoundary + Y) - at(boundary + Y - 3)) /
                f(at(prevBoundary + X) - at(boundary + X - 3)),
            );
        slope = f(f(fdy - at(prevBoundary + Y)) / f(fdx - at(prevBoundary + X)));
        if (
          sg * f(slope - prevSlope) > GRID_EPSILON &&
          sg * sum(at(prevBoundary + Y), -f(slope * at(prevBoundary + X)), -yB) < GRID_EPSILON
        ) {
          buf[boundary + X] = at(prevBoundary + X);
          buf[boundary + Y] = at(prevBoundary + Y);
          buf[boundary + K] = prevSlope;
          boundary += 3;
          if (doCommand) nextBlen += 3;
          isFirst = false;
        }
        prevBoundary += 3;
      } while (prevBoundary !== ptrEnd);
      buf[boundary + X] = fdx;
      buf[boundary + Y] = fdy;
      buf[boundary + K] = isFirst
        ? f(f(at(boundary + Y) - yB) / at(boundary + X))
        : f(
            f(at(boundary + Y) - at(boundary + Y - 3)) / f(at(boundary + X) - at(boundary + X - 3)),
          );
    }
    if (lowBlen > 0) {
      prevBoundary = lowBounds;
      ptrEnd = lowBounds + lowBlen;
      while (prevBoundary !== ptrEnd) {
        if (sg * f(at(prevBoundary + K) - nextSlope) > GRID_EPSILON) {
          nextSlope = f(
            f(at(boundary + Y) - at(prevBoundary + Y)) / f(at(boundary + X) - at(prevBoundary + X)),
          );
          prevBoundary += 3;
        } else {
          break;
        }
      }
      if (doCommand) nextStartY = f(at(boundary + Y) - f(nextSlope * at(boundary + X)));
    }
    if (sg * f(uppSlope - nextSlope) < GRID_EPSILON) {
      nextSlope = uppSlope;
      if (doCommand) nextStartY = f(at(boundary + Y) - f(nextSlope * at(boundary + X)));
    }
    if (doCommand) {
      if (f(nextStartY - yMin) < GRID_EPSILON) nextStartY = yMin;
    }
  };

  if (dx > data.radius) return;

  c[o.rx] = data.source[o.rx] + sgn(o.signx, dx);

  const dy0 = Math.trunc(sum(lowerStartY, f(f(fdx - pms) * lowerSlope), GRID_EPSILON)); // lower left
  let dy1 = Math.trunc(sum(upperStartY, f(f(fdx + pms) * upperSlope), -GRID_EPSILON)); // upper right
  const cy0 = Math.trunc(sum(lowerStartY, f(fdx * lowerSlope), GRID_EPSILON)) - 1; // lower centre
  let cy1 = Math.trunc(sum(upperStartY, f(fdx * upperSlope), -GRID_EPSILON)) + 1; // upper centre
  if (dy1 > dx + 1) dy1 = dx + 1;
  if (cy1 > dx + 1) cy1 = dx + 1;

  const h = circleHeight(data.radius, dx);
  if (dy1 > h) dy1 = h;

  /** "don't double-apply edges or diags, apply only if seen (cy0 < dy < cy1)" */
  const applyIfSeen = (dy: number): void => {
    if ((o.applyEdge || dy > 0) && (o.applyDiag || dy !== dx) && dy > cy0 && dy < cy1) {
      data.apply(c.x, c.y, c.x - data.source.x, c.y - data.source.y);
    }
  };

  for (let dy = dy0; dy <= dy1; dy += 1) {
    c[o.ry] = data.source[o.ry] + sgn(o.signy, dy);
    // "if blocked, then shadowcast below the blocked tile if necessary"
    if (settings.opaque(c.x, c.y)) {
      fdy = f(dy);
      skipRecurseBelow: {
        if (prevBlocked === 0) {
          fdx = f(f(dx) + pms);
          applyIfSeen(dy);
          // "if lower line blocked by tile, then no recursive call is needed"
          if (sum(fdy, -lowerStartY, -f(fdx * lowerSlope)) < GRID_EPSILON) break skipRecurseBelow;
          getNext(false, true);
          largeAssFovOctant(
            data,
            o,
            dx + 1,
            lowerBlen,
            nextBlen,
            lowerSlope,
            nextSlope,
            lowerStartY,
            nextStartY,
            yMin,
            yMax,
            lowerBoundaries,
            nextBoundaries,
          );
        } else {
          // "the previous tile may block the current tile"
          fdx = f(f(dx) - pms);
          // "if upper line is blocked by previous tile, then we are done"
          if (sum(fdy, -upperStartY, -f(fdx * upperSlope)) > GRID_EPSILON) break skipRecurseBelow;
          if (sum(lowerStartY, f(fdx * lowerSlope), -fdy) < GRID_EPSILON) {
            getNext(true, false);
            if (f(upperSlope - nextSlope) < GRID_EPSILON) break skipRecurseBelow;
          }
          applyIfSeen(dy);
        }
      }
      prevBlocked = 1;
    } else {
      if (prevBlocked === 1) {
        fdy = f(dy);
        fdx = f(f(dx) - pms);
        // "if upper line is blocked by previous tile, then we are done"
        if (sum(fdy, -upperStartY, -f(fdx * upperSlope)) > GRID_EPSILON) return;
        getNext(true, true);
        if (f(upperSlope - nextSlope) < GRID_EPSILON) return;
        lowerBlen = nextBlen;
        lowerSlope = nextSlope;
        lowerStartY = nextStartY;
        lowerBoundaries = nextBoundaries;
      }
      applyIfSeen(dy);
      prevBlocked = 0;
    }
  }

  if (prevBlocked === 0) {
    largeAssFovOctant(
      data,
      o,
      dx + 1,
      lowerBlen,
      upperBlen,
      lowerSlope,
      upperSlope,
      lowerStartY,
      upperStartY,
      yMin,
      yMax,
      lowerBoundaries,
      upperBoundaries,
    );
  }
}

/**
 * `large_ass_fov_octant_zero_##nx##ny##nf` (`LARGE_ASS_FOV_DEFINE_OCTANT_ZERO`,
 * C core: src/fov/fov.c): column 0 of an octant, which is only the source.
 *
 * It asks about the cell beside the source on the octant's secondary axis,
 * BEFORE any radius test: `y_max + upper_slope*pms - 1` is 0.99 under ToME's
 * settings, so it always asks. If that cell is opaque, the upper constraint
 * starts at its corner, `1 - 2*pms` (0.00999999f), and the slope 1/pms
 * (2.0202) never tightens the initial 2. Then column 1.
 */
function largeAssFovOctantZero(
  data: CircleData,
  o: Octant,
  lowerSlope: number,
  upperSlopeIn: number,
): void {
  const settings = data.settings;
  let upperSlope = upperSlopeIn;
  const pms = settings.permissiveness;
  const yMin = f(f(0.5) - settings.actorVisionSize);
  const yMax = f(f(0.5) + settings.actorVisionSize);

  if (sum(yMax, f(upperSlope * pms), -1) > GRID_EPSILON) {
    const c: Axes = { x: 0, y: 0 };
    c[o.rx] = data.source[o.rx];
    c[o.ry] = data.source[o.ry] + sgn(o.signy, 1);
    if (settings.opaque(c.x, c.y)) {
      const slope = f(f(f(1) - yMin) / pms);
      if (f(slope - upperSlope) < GRID_EPSILON) upperSlope = slope;
      const upperBoundaries = getBuffer(data.ring, 3);
      const buf = data.ring.buffer;
      buf[upperBoundaries + X] = pms;
      buf[upperBoundaries + Y] = 1;
      buf[upperBoundaries + K] = f(f(f(1) - yMax) / pms);
      const upperStartY = f(f(1) - f(upperSlope * pms));
      largeAssFovOctant(
        data,
        o,
        1,
        0,
        3,
        lowerSlope,
        upperSlope,
        yMin,
        upperStartY,
        yMin,
        yMax,
        NO_LIST,
        upperBoundaries,
      );
      return;
    }
  }
  largeAssFovOctant(
    data,
    o,
    1,
    0,
    0,
    lowerSlope,
    upperSlope,
    yMin,
    yMax,
    yMin,
    yMax,
    NO_LIST,
    NO_LIST,
  );
}

/** A slope-list ring as `global_buffer_data` starts: empty, at `index`. */
export function freshRing(index = 0): Ring {
  return { index, prevLen: 0, buffer: new Float32Array(FOV_BUFFER_SIZE) };
}

/**
 * `fov_circle(settings, map, source, sx, sy, radius)` (C core: src/fov/fov.c)
 * on a square grid under `FOV_ALGO_LARGE_ASS`: `_large_ass_fov_circle`'s eight
 * octants, each from slope 0 to slope 2.
 *
 * NO BOUNDS AND NEVER THE SOURCE: `settings.opaque` is asked about any cell,
 * and `apply` gets every cell reached except the origin, in the C's order.
 * `calcCircle` is the call ToME makes; this is the machine under it. `ring`
 * is the C's `settings->buffer_data`; leave it out for a fresh one.
 */
export function largeAssFovCircle(
  settings: FovSettings,
  sx: number,
  sy: number,
  radius: number,
  apply: FovApply,
  ring: Ring = freshRing(),
): void {
  const data: CircleData = { settings, ring, source: { x: sx, y: sy }, radius, apply };
  for (const o of OCTANTS) largeAssFovOctantZero(data, o, f(0), f(2));
}

/**
 * `core.fov.calc_circle(x, y, w, h, radius, block, apply, nil)` (C core:
 * `lua_fov_calc_circle`, `map_seen` and `map_opaque`, src/fov.c), under ToME's
 * settings.
 *
 * - EVERY NUMBER TRUNCATES to a C `int`: the source, the map size, the radius.
 * - OFF-MAP IS OPAQUE, and `block` is never asked about it. `block` IS ASKED
 *   LIVE, each time the C wants a cell: no cache.
 * - `apply(x, y, dx, dy, sqdist)` for every on-map cell reached, in the C's
 *   order (see the file note), then THE ORIGIN LAST with `(0, 0, 0)`. `dx` and
 *   `dy` are the offset from the source; `sqdist` is `core.fov.distance`
 *   (rounded half-up) SQUARED, not the squared Euclidean length: (1,1) gives 1
 *   and (2,1) gives 4.
 * - NOT DEDUPLICATED. No duplicate has been seen (the tests count them), and
 *   ToME's callers write into `grids[x][y]` anyway; `circleCells` is the set.
 */
export function calcCircle(
  bounds: MapBounds,
  x: number,
  y: number,
  radius: number,
  block: Opaque,
  apply: CircleApply,
): void {
  const sx = cInt(x);
  const sy = cInt(y);
  const w = cInt(bounds.w);
  const h = cInt(bounds.h);
  const offMap = (px: number, py: number): boolean => px < 0 || py < 0 || px >= w || py >= h;
  const mapSeen: FovApply = (px, py, dx, dy) => {
    if (offMap(px, py)) return;
    const dist = fovDistance(f(px - dx), f(py - dy), f(px), f(py));
    apply(px, py, dx, dy, dist * dist);
  };
  const settings = tomeFovSettings((px, py) => offMap(px, py) || block(px, py));
  largeAssFovCircle(settings, sx, sy, cInt(radius), mapSeen);
  mapSeen(sx, sy, 0, 0);
}

/**
 * The cells a ToME ball or `circle_grids(x, y, radius, block)` covers:
 * `calcCircle`'s cells, deduplicated, plus the origin even when it is off the
 * map (the Lua adds it after the C returns), listed ROW-MAJOR: y ascending,
 * then x ascending, which is `discTiles`'s order. On an open map it is
 * `discTiles` clipped to the map, origin kept.
 *
 * `circle_grids` skips the C entirely at radius 0; the set is the same, the
 * origin alone, and `block` is still asked here (see the file note).
 */
export function circleCells(
  bounds: MapBounds,
  x: number,
  y: number,
  radius: number,
  block: Opaque,
): TileXY[] {
  const sx = cInt(x);
  const sy = cInt(y);
  const r = Math.max(cInt(radius), 0);
  const side = 2 * r + 1;
  const hit = new Uint8Array(side * side);
  hit[r * side + r] = 1;
  calcCircle(bounds, sx, sy, radius, block, (_px, _py, dx, dy) => {
    if (Math.abs(dx) > r || Math.abs(dy) > r) {
      throw new Error(
        `calcCircle reached (${String(dx)},${String(dy)}) outside radius ${String(r)}`,
      );
    }
    hit[(dy + r) * side + (dx + r)] = 1;
  });
  const cells: TileXY[] = [];
  for (let dy = -r; dy <= r; dy += 1) {
    for (let dx = -r; dx <= r; dx += 1) {
      if (hit[(dy + r) * side + (dx + r)] === 1) cells.push({ x: sx + dx, y: sy + dy });
    }
  }
  return cells;
}
