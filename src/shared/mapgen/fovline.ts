// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/engines/default/engine/utils.lua:2257-2277 (core.fov.line)
//   and game/engines/default/engine/utils.lua:2286-2307 (the permissiveness and vision-size wrappers)
//   and game/engines/default/engine/Module.lua:915-918 (the settings ToME boots with);
//   and the C core, which the reference tree does not ship: lua_fov_line_init,
//   lua_fov_line_step, map_opaque, lua_fov_set_permissiveness and
//   lua_fov_set_actor_vision_size in src/fov.c, and fov_settings_init,
//   fov_create_los_line, LARGE_ASS_LOS_DEFINE_OCTANT, LARGE_ASS_LOS_FINISH,
//   GET_NEXT_LARGE_ASS_DATA and GET_BUFFER in src/fov/fov.c
//   (all at T-Engine4 tag tome-1.6.0, commit 0d95bc38; unchanged through tome-1.7.6)
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * `core.fov.line`: THE ENGINE'S LINE OF SIGHT, NOT BRESENHAM'S LINE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `line.new` (`mapgen/geom.ts`) is libtcod's Bresenham. `core.fov.line` is a
 * different machine, and Hexacle digs with it: libfov's "large actor recursive
 * shadowcasting" LOS line, `FOV_ALGO_LARGE_ASS`, which ToME selects before any
 * module code runs (`engine/Module.lua:915`).
 *
 * ═══ THE TERRAIN IS READ ONCE, WHEN THE LINE IS MADE ═══
 * `fov_create_los_line` casts through the map with the opacity callback and
 * picks ONE real-valued ray — a start, a step and an epsilon per axis — that
 * slips between the opaque tiles if it can, and otherwise "the smartest line
 * that goes the farthest before becoming blocked". Stepping then samples that
 * fixed ray once per major-axis cell. So:
 *
 *   - WALLS BEND THE LINE BUT NEVER STOP IT. On an all-wall map every cell to
 *     the target is still yielded; the walls only change WHICH cells, and set
 *     `isBlocked` and `blockT`.
 *   - TERRAIN WRITTEN WHILE STEPPING DOES NOT MOVE THE CURRENT LINE. It moves
 *     the NEXT line made across it, which is why Hexacle's second tunnel can
 *     run along its first one.
 *
 * ═══ WHAT `step` YIELDS ═══
 * - NEVER THE START. The first cell is one step along.
 * - EXACTLY `max(|dx|, |dy|)` CELLS, and THE LAST IS ALWAYS THE TARGET. Then
 *   nothing, every time it is asked again, unless `dontStopAtEnd`, which walks
 *   the same ray on past the target with no bounds at all.
 * - A ZERO-LENGTH LINE YIELDS NOTHING, even past its end.
 * - Consecutive cells are eight-adjacent.
 * - THE LINE IS NOT SYMMETRIC: through walls, `a -> b` and `b -> a` differ for
 *   most offsets, so a caller's argument order is part of the port.
 *
 * ═══ THE FLOATS ARE C `float`s ═══
 * Every ray field and every intermediate is single precision in the C, and a
 * tie in a truncation is decided in the last bit, so every operation here goes
 * through `Math.fround`, left to right as the C associates it, and every
 * `(int)` is `Math.trunc`. This matches an x86-64 SSE build of the C on 120,000
 * random cases, cells, corners and ray fields alike. An x87 build of the same C
 * disagrees in the ray fields often and in the cells about five times in
 * 100,000; which one the shipped ToME binary is was not determined.
 *
 * ═══ ONE CHANGE: THE SCRATCH BUFFER IS THE LINE'S OWN ═══
 * libfov carves its slope lists out of ONE static 2,048-float ring shared by
 * every FOV and LOS call in the process (`global_buffer_data`). A module-level
 * ring here would make a line depend on every line made before it, anywhere in
 * the server, which `src/shared/` does not allow. Each line gets a fresh ring
 * starting at 0 instead. The ring's position is not observable unless one
 * line's live slope lists outgrow 2,048 floats, which the C's own comment
 * calls "large enough to prevent any overwriting"; forcing the C's ring to
 * start near its end changed nothing in 100,000 cases.
 *
 * NOT PORTED: `FOV_ALGO_RECURSIVE_SHADOW`'s branch of `fov_create_los_line`
 * (ToME never selects it), and `hex_line_base` (ToME's grid is square,
 * `engine/utils.lua:1856`).
 */

import type { TileXY } from '../coords.ts';
import { blocksSight } from '../protocol.ts';
import type { GenMap } from './genmap.ts';
import { cInt } from './lua.ts';

const f = Math.fround;

/** `GRID_EPSILON` (`src/fov/fov.h`): `1.0e-5f`, the float and not the double. */
export const GRID_EPSILON = f(1.0e-5);

/** `FOV_BUFFER_SIZE` (`src/fov/fov.h`). A power of two: `GET_BUFFER` masks with it. */
const FOV_BUFFER_SIZE = 2048;

/** A boundary is three floats: where it is, and the slope that reached it. */
const X = 0;
const Y = 1;
const K = 2;

/** Is this cell opaque? The C's `settings->opaque(map, x, y)`. */
export type Opaque = (x: number, y: number) => boolean;

/** `fov_settings_type`, the three fields a LOS line reads. */
export type FovSettings = {
  readonly opaque: Opaque;
  /** Already turned by `lua_fov_set_permissiveness`: `0.5f - val`. */
  readonly permissiveness: number;
  readonly actorVisionSize: number;
};

/**
 * ToME's permissiveness, as the C holds it. `core.fov.set_permissiveness(0.01)`
 * (`engine/Module.lua:916`) halves it in Lua (`engine/utils.lua:2291`), the C
 * narrows 0.005 to a float and stores `0.5f - val`: the float nearest 0.495.
 */
export const TOME_PERMISSIVENESS = f(f(0.5) - f(0.5 * 0.01));

/**
 * ToME's actor vision size. `core.fov.set_actor_vision_size(1)`
 * (`engine/Module.lua:917`) is halved in Lua (`engine/utils.lua:2304`): 0.5, the
 * size that makes the large-actor algorithm symmetric for FOV. (The LOS LINE is
 * still not symmetric; see the file note.)
 */
export const TOME_ACTOR_VISION_SIZE = f(0.5);

/** The settings every `core.fov.line` in ToME is made with (`fov_settings_init`). */
export function tomeFovSettings(opaque: Opaque): FovSettings {
  return {
    opaque,
    permissiveness: TOME_PERMISSIVENESS,
    actorVisionSize: TOME_ACTOR_VISION_SIZE,
  };
}

type Axis = 'x' | 'y';
type Axes = { x: number; y: number };

/**
 * `fov_line_data` (`src/fov/fov.h`): a source, a ray, and a cursor.
 *
 * A cell is `source + trunc(start + n*step + eps)` on each axis for the n-th
 * yield — mirrored through zero when the offset is negative. The major axis
 * always starts at the centre with a whole step; the minor axis is where the
 * walls show.
 */
export type LosLine = {
  readonly source: Readonly<Axes>;
  readonly start: Axes;
  readonly step: Axes;
  readonly eps: Axes;
  /** How many cells have been yielded. */
  t: number;
  /** `max(|dx|, |dy|)`: how many cells the line has. */
  destT: number;
  /** The yield at which the ray first meets an opaque cell, when `isBlocked`. */
  blockT: number;
  /** True when an opaque cell cuts the ray short of the target. An opaque target alone does not. */
  isBlocked: boolean;
  readonly startAtEnd: boolean;
};

/** One `step`: the cell, and the corner the ray squeezed past if that corner is opaque. */
export type LosStep = {
  readonly x: number;
  readonly y: number;
  readonly cornerX: number | null;
  readonly cornerY: number | null;
};

/** `fov_buffer_type`: the slope-list ring. One per line; see the file note. */
type Ring = { index: number; prevLen: number; readonly buffer: Float32Array };

/** `GET_BUFFER(target, buffer_data, len)`: the offset of `len` fresh floats. */
function getBuffer(ring: Ring, len: number): number {
  const overrun = (ring.index + ring.prevLen + len) & (FOV_BUFFER_SIZE - 1);
  ring.index = (ring.index + ring.prevLen) & (FOV_BUFFER_SIZE - 1);
  if (overrun < ring.index) ring.index = 0;
  ring.prevLen = len;
  return ring.index;
}

/** A float sum, left to right, as C adds `a + b + c`. `a - b` is passed as `a + -b`, which is exact. */
function sum(...terms: number[]): number {
  let r = terms[0] ?? 0;
  for (let i = 1; i < terms.length; i += 1) r = f(r + (terms[i] ?? 0));
  return r;
}

/** `signx v` in the macros: `-` or nothing. */
function sgn(sign: 1 | -1, v: number): number {
  return sign < 0 ? -v : v;
}

/**
 * `LARGE_ASS_LOS_DEFINE_OCTANT(signx, signy, rx, ry, ...)` (C core: src/fov/fov.c).
 * `rx` is the major axis and `signx` its direction; `ry` and `signy` the minor.
 *
 * The walk from the source keeps a LOWER and an UPPER constraint — a slope and
 * a start, and a convex list of boundary points — and every opaque cell met
 * tightens one of them. It ends when the corridor between them closes
 * (blocked) or the target column is reached, and `finish` then picks the ray
 * between the two constraints nearest the centres of source and target.
 *
 * Transcribed branch for branch. Variable names are the macro's.
 */
function largeAssLosOctant(
  settings: FovSettings,
  line: LosLine,
  dest: Readonly<Axes>,
  signx: 1 | -1,
  signy: 1 | -1,
  rx: Axis,
  ry: Axis,
): void {
  const ring: Ring = { index: 0, prevLen: 0, buffer: new Float32Array(FOV_BUFFER_SIZE) };
  const buf = ring.buffer;
  const opaque = settings.opaque;
  /** The cell under test, in map coordinates; `rx`/`ry` in the macro. */
  const c: Axes = { x: 0, y: 0 };
  const at = (i: number): number => buf[i] ?? 0;

  // `ly0` and `uy0` are the macro's too, and `finish` reuses them as list lengths.
  let ly0 = 0;
  let uy0 = 0;
  let nextBlen = 0;
  let dx = 0;
  let lowerBlen = 0;
  let upperBlen = 0;
  let delta = sgn(signx, dest[rx] - line.source[rx]);
  const deltaY = sgn(signy, dest[ry] - line.source[ry]);
  let nextSlope = 0;
  let prevSlope = 0;
  let slope = 0;
  let nextStartY = 0;
  const yMin = f(f(0.5) - settings.actorVisionSize);
  const yMax = f(f(0.5) + settings.actorVisionSize);
  let fdx = sgn(signx, f(dest[rx] - line.source[rx]));
  let fdy = sgn(signy, f(dest[ry] - line.source[ry]));
  let fdt = f(delta);
  let lowerStartY = yMin;
  let upperStartY = yMax;
  const pms = settings.permissiveness;
  let lowerSlope = f(0);
  let upperSlope = f(2);
  const slopeMin = f(f(fdy - yMin) / fdx);
  const slopeMax = f(sum(fdy, 1, -yMax) / fdx);
  let boundary = 0;
  let lowerBoundaries = 0;
  let upperBoundaries = 0;
  let nextBoundaries = 0;
  let prevBoundary = 0;
  let ptrEnd = 0;

  /**
   * `GET_NEXT_LARGE_ASS_DATA(min, max, low, upp, sign, true)` for the upper
   * constraint; `lowerVariant` is the macro's `(max, min, upp, low, -, true)`.
   * One quirk of the macro is kept: the last clamp reads `y_min` itself, not
   * `y_##min`, so both variants clamp against the lower edge.
   */
  const getNext = (lowerVariant: boolean): void => {
    const yA = lowerVariant ? yMax : yMin;
    const yB = lowerVariant ? yMin : yMax;
    const sg = lowerVariant ? -1 : 1;
    const uppBlen = lowerVariant ? lowerBlen : upperBlen;
    const uppBounds = lowerVariant ? lowerBoundaries : upperBoundaries;
    const lowBlen = lowerVariant ? upperBlen : lowerBlen;
    const lowBounds = lowerVariant ? upperBoundaries : lowerBoundaries;
    const uppSlope = lowerVariant ? lowerSlope : upperSlope;
    nextBlen = 3;
    nextSlope = f(f(fdy - yA) / fdx);
    nextStartY = yA;
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
          nextBlen += 3;
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
      nextStartY = f(at(boundary + Y) - f(nextSlope * at(boundary + X)));
    }
    if (sg * f(uppSlope - nextSlope) < GRID_EPSILON) {
      nextSlope = uppSlope;
      nextStartY = f(at(boundary + Y) - f(nextSlope * at(boundary + X)));
    }
    if (f(nextStartY - yMin) < GRID_EPSILON) {
      nextStartY = yMin;
    }
  };

  /** `LARGE_ASS_LOS_FINISH(do_blocked, signy, rx, ry)`: choose the ray. */
  const finish = (doBlocked: boolean): void => {
    fdx = f(line.destT);
    fdy = f(deltaY);
    c[rx] = dest[rx];
    ly0 = lowerBlen;
    uy0 = upperBlen;
    if (Math.trunc(sum(lowerStartY, f(fdx * lowerSlope), GRID_EPSILON)) < deltaY) {
      c[ry] = dest[ry];
      getNext(true);
      ly0 = nextBlen - 3;
      lowerBlen = nextBlen;
      lowerSlope = nextSlope;
      lowerStartY = nextStartY;
      lowerBoundaries = nextBoundaries;
    }
    if (Math.trunc(sum(upperStartY, f(fdx * upperSlope), -GRID_EPSILON)) > deltaY) {
      c[ry] = dest[ry] + sgn(signy, 1);
      fdy = f(deltaY + 1);
      getNext(false);
      uy0 = nextBlen - 3;
      upperSlope = nextSlope;
      upperStartY = nextStartY;
      fdy = f(deltaY);
    }

    // The weight between the two constraints that minimises the squared
    // distance to the source's and the target's centres, clamped to [0.1, 0.9].
    slope = f(upperStartY + f(fdx * upperSlope));
    nextSlope = f(lowerStartY + f(fdx * lowerSlope));
    nextStartY = f(
      f(
        f(f(-2) * fdx) *
          sum(
            f(upperStartY * lowerSlope),
            f(lowerStartY * upperSlope),
            f(f(fdx * lowerSlope) * upperSlope),
          ),
      ) - f(f(f(4) * lowerStartY) * upperStartY),
    );
    slope = f(f(upperStartY * upperStartY) + f(slope * slope));
    prevSlope = sum(lowerStartY, -upperStartY, f(fdx * lowerSlope), -f(fdx * upperSlope));
    nextSlope = sum(slope, nextStartY, f(nextSlope * nextSlope), f(lowerStartY * lowerStartY));
    prevSlope = sum(
      f(f(2) * slope),
      nextStartY,
      f(f(f(2) * fdy) * prevSlope),
      prevSlope,
      lowerStartY,
      -upperStartY,
    );

    if (nextSlope > GRID_EPSILON || nextSlope < -GRID_EPSILON) {
      slope = f(f(f(0.5) * prevSlope) / nextSlope);
      if (slope < f(0.1)) slope = f(0.1);
      else if (slope > f(0.9)) slope = f(0.9);
      line.step[ry] = sgn(signy, f(f(slope * lowerSlope) + f(f(f(1) - slope) * upperSlope)));
      line.start[ry] = f(f(slope * lowerStartY) + f(f(f(1) - slope) * upperStartY));
    } else {
      line.step[ry] = sgn(signy, f(f(0.5) * f(lowerSlope + upperSlope)));
      line.start[ry] = f(f(0.5) * f(lowerStartY + upperStartY));
    }
    if (line.start[ry] > yMax) line.start[ry] = yMax;

    const upperScan = (): void => {
      boundary = upperBoundaries;
      ptrEnd = upperBoundaries + uy0;
      do {
        if (sum(at(boundary + Y), -line.start[ry], -f(slope * at(boundary + X))) < GRID_EPSILON) {
          fdt = at(boundary + X);
          break;
        }
        boundary += 3;
      } while (boundary !== ptrEnd);
    };
    const lowerScan = (): void => {
      boundary = lowerBoundaries;
      ptrEnd = lowerBoundaries + ly0;
      do {
        if (f(at(boundary + X) - fdt) > GRID_EPSILON) break;
        if (sum(line.start[ry], f(slope * at(boundary + X)), -at(boundary + Y)) < GRID_EPSILON) {
          line.eps[ry] = sgn(signy, f(f(2) * GRID_EPSILON));
          break;
        }
        boundary += 3;
      } while (boundary !== ptrEnd);
    };

    if (doBlocked) {
      line.isBlocked = true;
      line.blockT = line.destT - delta;
      if (ly0 > 0) {
        if (uy0 > 0) {
          slope = f(Math.abs(f(line.step[ry] / line.step[rx])));
          upperScan();
          lowerScan();
        } else {
          line.eps[ry] = sgn(signy, f(f(2) * GRID_EPSILON));
        }
      }
    } else if (ly0 > 0) {
      line.eps[ry] = sgn(signy, f(f(-0.5) * GRID_EPSILON));
      slope = f(Math.abs(f(line.step[ry] / line.step[rx])));
      if (uy0 > 0) upperScan();
      lowerScan();
    }

    if (f(sgn(signy, line.step[ry]) - f(1)) > GRID_EPSILON) {
      // An unblocked diagonal snaps to a clean one.
      line.start[ry] = f(0.5);
      line.step[ry] = sgn(signy, f(1));
      line.eps[ry] = f(0);
    } else if (
      Math.trunc(sum(line.start[ry], sgn(signy, f(fdx * line.step[ry])), -GRID_EPSILON)) < deltaY
    ) {
      // "is this still necessary?" — upstream's own comment. No random case
      // of 220,000 reached this branch; it is transcribed by reading alone.
      line.eps[ry] = sgn(signy, f(f(0.5) * GRID_EPSILON));
    }
  };

  c[rx] = line.source[rx];
  line.step[rx] = sgn(signx, f(1));
  line.start[rx] = f(0.5);
  line.eps[rx] = f(0);
  line.eps[ry] = sgn(signy, f(f(-2) * GRID_EPSILON));
  line.destT = delta;

  // "check upper when dx == 0": a wall directly beside the source.
  if (sum(yMax, f(upperSlope * pms), -1) > GRID_EPSILON) {
    c[ry] = line.source[ry] + sgn(signy, 1);
    if (opaque(c.x, c.y)) {
      slope = f(f(f(1) - yMin) / pms);
      if (f(slope - upperSlope) < GRID_EPSILON) upperSlope = slope;
      upperBoundaries = getBuffer(ring, 3);
      buf[upperBoundaries + X] = pms;
      buf[upperBoundaries + Y] = 1;
      buf[upperBoundaries + K] = f(f(f(1) - yMax) / pms);
      upperStartY = f(f(1) - f(upperSlope * pms));
      upperBlen = 3;
    }
  }

  for (;;) {
    delta -= 1;
    if (delta < 0) {
      finish(false);
      return;
    }
    dx += 1;
    c[rx] = c[rx] + sgn(signx, 1);
    fdx = f(dx);

    ly0 = Math.trunc(sum(lowerStartY, f(f(fdx - pms) * lowerSlope), GRID_EPSILON));
    const lc0 = Math.trunc(sum(yMin, f(f(fdx - pms) * slopeMin), GRID_EPSILON));
    let ly1 = Math.trunc(sum(lowerStartY, f(f(fdx + pms) * lowerSlope), GRID_EPSILON));
    const lc1 = Math.trunc(sum(yMin, f(f(fdx + pms) * slopeMin), GRID_EPSILON));

    uy0 = Math.trunc(sum(upperStartY, f(f(fdx - pms) * upperSlope), -GRID_EPSILON));
    const uc0 = Math.trunc(sum(yMax, f(f(fdx - pms) * slopeMax), -GRID_EPSILON));
    let uy1 = Math.trunc(sum(upperStartY, f(f(fdx + pms) * upperSlope), -GRID_EPSILON));
    const uc1 = Math.trunc(sum(yMax, f(f(fdx + pms) * slopeMax), -GRID_EPSILON));

    if (ly0 < lc0) ly0 = lc0;
    if (ly1 < lc1) ly1 = lc1;
    if (uy0 > uc0) uy0 = uc0;
    if (uy1 > uc1) uy1 = uc1;

    c[ry] = line.source[ry] + sgn(signy, ly0);
    if (opaque(c.x, c.y)) {
      if (
        ly0 === uy0 &&
        (upperBlen === 0 || sum(fdx, -at(upperBoundaries + upperBlen - 3 + X), -0.5) > GRID_EPSILON)
      ) {
        // BLOCKED
        finish(delta !== 0 || ly0 !== deltaY);
        return;
      }
      // CALC LOWER SLOPE
      fdy = f(ly0 + 1);
      fdx = f(fdx - pms);
      getNext(true);
      if (
        Math.trunc(sum(nextStartY, f(fdt * nextSlope), GRID_EPSILON)) > deltaY ||
        f(upperSlope - nextSlope) < GRID_EPSILON
      ) {
        finish(true);
        return;
      }
      lowerBlen = nextBlen;
      lowerSlope = nextSlope;
      lowerStartY = nextStartY;
      lowerBoundaries = nextBoundaries;

      c[ry] = line.source[ry] + sgn(signy, uy0);
      if (ly0 !== uy0 && opaque(c.x, c.y)) {
        finish(delta !== 0);
        return;
      }
      c[ry] = line.source[ry] + sgn(signy, uy1);
      if (delta !== 0 && uy0 !== uy1 && opaque(c.x, c.y)) {
        // CALC UPPER SLOPE
        fdy = f(uy1);
        fdx = f(fdx + f(f(2) * pms));
        getNext(false);
        if (
          Math.trunc(sum(nextStartY, f(fdt * nextSlope), -GRID_EPSILON)) < deltaY ||
          f(nextSlope - lowerSlope) < GRID_EPSILON
        ) {
          finish(true);
          return;
        }
        upperSlope = nextSlope;
        upperStartY = nextStartY;
        upperBoundaries = nextBoundaries;
        upperBlen = nextBlen;
      }
      continue;
    }
    c[ry] = line.source[ry] + sgn(signy, uy1);
    if (ly0 !== uy1 && opaque(c.x, c.y)) {
      c[ry] = line.source[ry] + sgn(signy, ly1);
      if (uy1 === ly1 || (ly0 !== ly1 && opaque(c.x, c.y))) {
        finish(delta !== 0);
        return;
      } else if (delta !== 0) {
        fdy = f(uy1);
        fdx = f(fdx + pms);
        getNext(false);
        if (Math.trunc(sum(nextStartY, f(fdt * nextSlope), -GRID_EPSILON)) < deltaY) {
          finish(true);
          return;
        }
        upperSlope = nextSlope;
        upperStartY = nextStartY;
        upperBoundaries = nextBoundaries;
        upperBlen = nextBlen;
      }
      continue;
    }
    c[ry] = line.source[ry] + sgn(signy, ly0 + 1);
    if (ly0 + 2 === uy1 && opaque(c.x, c.y)) {
      finish(delta !== 0);
      return;
    }
  }
}

/**
 * `fov_create_los_line(settings, map, source, line, sx, sy, dx, dy, start_at_end)`
 * (C core: src/fov/fov.c), `FOV_ALGO_LARGE_ASS` branch.
 *
 * - SAME COLUMN OR ROW: the straight run, `start = 0.5`, `eps = 0`, one whole
 *   step. Walls only set `isBlocked` and `blockT`, and the target itself never
 *   counts as blocking.
 * - OTHERWISE, ONE OF EIGHT OCTANTS. x is the major axis only when `|dx| > |dy|`
 *   STRICTLY; a true diagonal takes y.
 * - `startAtEnd` puts the cursor at the end, or at `blockT` when blocked.
 *
 * Coordinates are integers; `fovLine` truncates them as the binding does.
 */
export function createLosLine(
  settings: FovSettings,
  sx: number,
  sy: number,
  tx: number,
  ty: number,
  startAtEnd = false,
): LosLine {
  const line: LosLine = {
    source: { x: sx, y: sy },
    start: { x: f(0.5), y: f(0.5) },
    step: { x: 0, y: 0 },
    eps: { x: 0, y: 0 },
    t: 0,
    destT: 0,
    blockT: 0,
    isBlocked: false,
    startAtEnd,
  };
  const opaque = settings.opaque;
  if (sx === tx) {
    line.destT = Math.abs(ty - sy);
    if (sy === ty) return line;
    // "iterate through all y"
    const dy = ty < sy ? -1 : 1;
    let y = sy;
    do {
      y += dy;
      if (opaque(sx, y)) {
        line.isBlocked = y !== ty;
        line.blockT = dy * (y - sy);
        break;
      }
    } while (y !== ty);
    line.step.y = dy;
    if (startAtEnd) line.t = line.destT;
  } else if (sy === ty) {
    line.destT = Math.abs(tx - sx);
    const dx = tx < sx ? -1 : 1;
    let x = sx;
    do {
      x += dx;
      if (opaque(x, sy)) {
        line.isBlocked = x !== tx;
        line.blockT = dx * (x - sx);
        break;
      }
    } while (x !== tx);
    line.step.x = dx;
    if (startAtEnd) line.t = line.destT;
  } else {
    const dest = { x: tx, y: ty };
    if (tx > sx) {
      if (ty > sy) {
        if (tx - sx > ty - sy)
          largeAssLosOctant(settings, line, dest, 1, 1, 'x', 'y'); // ppn
        else largeAssLosOctant(settings, line, dest, 1, 1, 'y', 'x'); // ppy
      } else if (tx - sx > sy - ty) {
        largeAssLosOctant(settings, line, dest, 1, -1, 'x', 'y'); // pmn
      } else {
        largeAssLosOctant(settings, line, dest, -1, 1, 'y', 'x'); // mpy
      }
    } else if (ty > sy) {
      if (sx - tx > ty - sy)
        largeAssLosOctant(settings, line, dest, -1, 1, 'x', 'y'); // mpn
      else largeAssLosOctant(settings, line, dest, 1, -1, 'y', 'x'); // pmy
    } else if (sx - tx > sy - ty) {
      largeAssLosOctant(settings, line, dest, -1, -1, 'x', 'y'); // mmn
    } else {
      largeAssLosOctant(settings, line, dest, -1, -1, 'y', 'x'); // mmy
    }
    if (startAtEnd) line.t = line.destT;
  }
  if (startAtEnd && line.isBlocked) line.t = line.blockT;
  return line;
}

/**
 * `lua_fov_line_step` (C core: src/fov.c): the next cell, or `null` where the C
 * returns nothing — at the end, unless `dontStopAtEnd`, and always for a
 * zero-length line.
 *
 * The cell of yield `n = t + 1` is `trunc(start + (n*step + eps))` per axis,
 * mirrored when `n*step + eps` is negative. `useBlock` is whether the call came
 * through `core.fov.line`'s wrapper table — `l:step()` — which is the only way
 * the C sees a block function to test the corner the ray just squeezed past;
 * `l()` and `for x, y in l` never report one. A corner is reported only when it
 * is opaque, and the test never changes the cell.
 */
export function stepLine(
  settings: FovSettings,
  line: LosLine,
  useBlock: boolean,
  dontStopAtEnd = false,
): LosStep | null {
  if ((!dontStopAtEnd && line.destT === line.t) || line.destT === 0) return null;
  const pms = settings.permissiveness;
  let blocked = false;
  let cornerX = 0;
  let cornerY = 0;
  const stepX = line.step.x;
  const stepY = line.step.y;
  const epsX = line.eps.x;
  const epsY = line.eps.y;
  const fx = f(f(line.t) * stepX);
  const fy = f(f(line.t) * stepY);
  const fx2 = f(f(f(line.t + 1) * stepX) + epsX);
  const fy2 = f(f(f(line.t + 1) * stepY) + epsY);
  const x0 = line.start.x;
  const y0 = line.start.y;
  const sX = line.source.x;
  const sY = line.source.y;
  let x: number;
  let y: number;
  let xPrev: number;
  let yPrev: number;
  let dx: number;
  let dy: number;
  /** Set the corner, and test it only when the ray really crosses into it. */
  const corner = (cx: number, cy: number, cond: number): void => {
    cornerX = cx;
    cornerY = cy;
    if (cond > GRID_EPSILON && settings.opaque(cx, cy)) blocked = true;
  };

  // "*sighs*"
  if (fx2 < 0) {
    xPrev = -Math.trunc(sum(x0, -fx, -epsX));
    x = -Math.trunc(f(x0 - fx2));
    if (fy2 < 0) {
      yPrev = -Math.trunc(sum(y0, -fy, -epsY));
      y = -Math.trunc(f(y0 - fy2));
      if (x !== xPrev && y !== yPrev && useBlock) {
        if (fy2 < fx2) {
          dx = f(sum(x, -fx, x0) / stepX);
          dy = f(sum(y, -fy, y0, -0.5, pms) / stepY);
          if (dx > dy) corner(sX + xPrev, sY + y, sum(-x, fx, -x0, f(dy * stepX), epsX));
          else corner(sX + x, sY + yPrev, sum(-yPrev, 0.5, pms, fy, -y0, f(dx * stepY), epsY));
        } else {
          dx = f(sum(x, -fx, x0, -0.5, pms) / stepX);
          dy = f(sum(y, -fy, y0) / stepY);
          if (dx > dy)
            corner(sX + xPrev, sY + y, sum(-xPrev, 0.5, pms, fx, -x0, f(dy * stepX), epsX));
          else corner(sX + x, sY + yPrev, sum(-y, fy, -y0, f(dx * stepY), epsY));
        }
      }
    } else {
      yPrev = Math.trunc(sum(y0, fy, epsY));
      y = Math.trunc(f(y0 + fy2));
      if (x !== xPrev && y !== yPrev && useBlock) {
        if (-fy2 < fx2) {
          dx = f(sum(x, -fx, x0) / stepX);
          dy = f(sum(y, -fy, -y0, 0.5, -pms) / stepY);
          if (dx > dy) corner(sX + xPrev, sY + y, sum(-x, fx, -x0, f(dy * stepX), epsX));
          else corner(sX + x, sY + yPrev, sum(yPrev, 0.5, pms, -fy, -y0, -f(dx * stepY), -epsY));
        } else {
          dx = f(sum(x, -fx, x0, -0.5, pms) / stepX);
          dy = f(sum(y, -fy, -y0) / stepY);
          if (dx > dy)
            corner(sX + xPrev, sY + y, sum(-xPrev, 0.5, pms, fx, -x0, f(dy * stepX), epsX));
          else corner(sX + x, sY + yPrev, sum(y, -fy, -y0, -f(dx * stepY), -epsY));
        }
      }
    }
  } else {
    xPrev = Math.trunc(sum(x0, fx, epsX));
    x = Math.trunc(f(x0 + fx2));
    if (fy2 < 0) {
      yPrev = -Math.trunc(sum(y0, -fy, -epsY));
      y = -Math.trunc(f(y0 - fy2));
      if (x !== xPrev && y !== yPrev && useBlock) {
        if (-fy2 > fx2) {
          dx = f(sum(x, -fx, -x0) / stepX);
          dy = f(sum(y, -fy, y0, -0.5, pms) / stepY);
          if (dx > dy) corner(sX + xPrev, sY + y, sum(x, -fx, -x0, -f(dy * stepX), -epsX));
          else corner(sX + x, sY + yPrev, sum(-yPrev, 0.5, pms, fy, -y0, f(dx * stepY), epsY));
        } else {
          dx = f(sum(x, -fx, -x0, 0.5, -pms) / stepX);
          dy = f(sum(y, -fy, y0) / stepY);
          if (dx > dy)
            corner(sX + xPrev, sY + y, sum(xPrev, 0.5, pms, -fx, -x0, -f(dy * stepX), -epsX));
          else corner(sX + x, sY + yPrev, sum(-y, fy, -y0, f(dx * stepY), epsY));
        }
      }
    } else {
      yPrev = Math.trunc(sum(y0, fy, epsY));
      y = Math.trunc(f(y0 + fy2));
      if (x !== xPrev && y !== yPrev && useBlock) {
        if (fy2 > fx2) {
          dx = f(sum(x, -fx, -x0) / stepX);
          dy = f(sum(y, -fy, -y0, 0.5, -pms) / stepY);
          if (dx > dy) corner(sX + xPrev, sY + y, sum(x, -fx, -x0, -f(dy * stepX), -epsX));
          else corner(sX + x, sY + yPrev, sum(yPrev, 0.5, pms, -fy, -y0, -f(dx * stepY), -epsY));
        } else {
          dx = f(sum(x, -fx, -x0, 0.5, -pms) / stepX);
          dy = f(sum(y, -fy, -y0) / stepY);
          if (dx > dy)
            corner(sX + xPrev, sY + y, sum(xPrev, 0.5, pms, -fx, -x0, -f(dy * stepX), -epsX));
          else corner(sX + x, sY + yPrev, sum(y, -fy, -y0, -f(dx * stepY), -epsY));
        }
      }
    }
  }
  // "*weeps*"
  line.t += 1;
  return blocked
    ? { x: sX + x, y: sY + y, cornerX, cornerY }
    : { x: sX + x, y: sY + y, cornerX: null, cornerY: null };
}

/** The line object `core.fov.line` returns (`engine/utils.lua:2265-2276`). */
export type FovLine = {
  readonly line: LosLine;
  readonly settings: FovSettings;
  /** `l:step(dont_stop_at_end)`: through the wrapper table, so corners are tested. */
  step(dontStopAtEnd?: boolean): LosStep | null;
  /** `l(dont_stop_at_end)`, and each turn of `for x, y in l`: the userdata alone, no corners. */
  call(dontStopAtEnd?: boolean): LosStep | null;
};

/** A map's size: all `lua_fov_line_init` keeps of it. */
export type MapBounds = { readonly w: number; readonly h: number };

/**
 * `core.fov.line(sx, sy, tx, ty, block, start_at_end)` (`engine/utils.lua:2257-2277`)
 * with a `block` function, over a map of `bounds`, then `lua_fov_line_init`
 * (C core: src/fov.c).
 *
 * - EVERY ARGUMENT TRUNCATES to a C `int`: the coordinates and the map size.
 * - OFF-MAP IS OPAQUE, and `block` is never asked about it (`map_opaque`).
 * - `block` IS ASKED LIVE: nothing is cached (`fov->cache = NULL`), so it sees
 *   the terrain as it is when the line is made — and, for a corner, when that
 *   step is taken.
 */
export function fovLine(
  bounds: MapBounds,
  sx: number,
  sy: number,
  tx: number,
  ty: number,
  block: Opaque,
  startAtEnd = false,
): FovLine {
  const w = cInt(bounds.w);
  const h = cInt(bounds.h);
  const settings = tomeFovSettings((x, y) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return true;
    return block(x, y);
  });
  const line = createLosLine(settings, cInt(sx), cInt(sy), cInt(tx), cInt(ty), startAtEnd);
  return {
    line,
    settings,
    step: (dontStopAtEnd = false) => stepLine(settings, line, true, dontStopAtEnd),
    call: (dontStopAtEnd = false) => stepLine(settings, line, false, dontStopAtEnd),
  };
}

/**
 * `block` left out of `core.fov.line`, on a map being generated:
 * `game.level.map:checkAllEntities(x, y, "block_sight")` (`engine/utils.lua:2259-2263`).
 * During generation terrain is the only entity on a cell, so this asks the
 * terrain; nil terrain has no entity to ask and does not block.
 */
export function blockSight(map: GenMap): Opaque {
  return (x, y) => {
    const code = map.get(x, y);
    return code !== null && blocksSight(code);
  };
}

/**
 * Every cell of `local lx, ly = l:step(); while lx and ly do ... end`, in order.
 * The callback runs before the next step, so a caller that writes terrain from
 * it is seen by the corner test of the steps after — never by the cells.
 */
export function eachStep(l: FovLine, visit: (x: number, y: number) => void): void {
  for (let s = l.step(); s !== null; s = l.step()) visit(s.x, s.y);
}

/** The cells `eachStep` visits, as a list. */
export function lineCells(l: FovLine): TileXY[] {
  const cells: TileXY[] = [];
  eachStep(l, (x, y) => cells.push({ x, y }));
  return cells;
}
