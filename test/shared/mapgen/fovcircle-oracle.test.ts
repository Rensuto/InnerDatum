// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// An independent oracle for src/shared/mapgen/fovcircle.ts. It is a SECOND transcription, written from
// the C without reading the port: libfov's fov_circle under FOV_ALGO_LARGE_ASS (src/fov/fov.c,
// src/fov/fov.h) and lua_fov_calc_circle with its map_opaque / map_seen callbacks (src/fov.c), in the
// configuration engine/Module.lua:915-918 sets through the wrappers at engine/utils.lua:2286-2307.
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license
//
// The C exists only in git: `git -C reference/t-engine4 show HEAD:src/fov/fov.c` (and fov.h, and
// src/fov.c). Every name below is the C name, so the two can be read side by side.

import { describe, expect, it } from 'vitest';

import {
  calcCircle,
  circleCells,
  freshRing,
  largeAssFovCircle,
} from '../../../src/shared/mapgen/fovcircle.ts';
import {
  FOV_BUFFER_SIZE as PORT_FOV_BUFFER_SIZE,
  GRID_EPSILON as PORT_GRID_EPSILON,
  tomeFovSettings,
} from '../../../src/shared/mapgen/fovline.ts';
import { createRng } from '../../../src/shared/rng.ts';
import type { Rng } from '../../../src/shared/rng.ts';

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// THE ORACLE
// ═══════════════════════════════════════════════════════════════════════════════════════════════

/**
 * Float arithmetic. Every `float OP float` in the C rounds to float32 (FLT_EVAL_METHOD 0: SSE, no
 * -ffast-math in premake4.lua). Doing the op in double and rounding once is exact for + - * /, since
 * 53 >= 2*24 + 2, so `f(a + b)` IS the float sum. Division by zero gives the same IEEE infinities.
 */
let f: (v: number) => number = Math.fround;
const add = (a: number, b: number): number => f(a + b);
const sub = (a: number, b: number): number => f(a - b);
const mul = (a: number, b: number): number => f(a * b);
const div = (a: number, b: number): number => f(a / b);
/** `(int)` of a float: truncation toward zero. `| 0` folds -0 to 0; every value here is small. */
const toInt = (v: number): number => Math.trunc(v) | 0;

/**
 * Runs `fn` with every float operation above done in DOUBLE instead (the buffer, a Float32Array,
 * still rounds what it stores). Not the C: it exists only to show which fixtures the floats decide.
 */
function inDoubles<T>(fn: () => T): T {
  f = (v: number): number => v;
  try {
    return fn();
  } finally {
    f = Math.fround;
  }
}

/** `GRID_EPSILON` (src/fov/fov.h): `1.0e-5f`. */
const GRID_EPSILON = Math.fround(1.0e-5);
/** `FOV_BUFFER_SIZE` (src/fov/fov.h). */
const FOV_BUFFER_SIZE = 2048;
/** "Conveniences for code clarity" (src/fov/fov.c). */
const X = 0;
const Y = 1;
const K = 2;
/** A `float *` that is NULL. Pointers into the buffer are indices into it. */
const NULL = -1;

/** `heights_tables[FOV_SHAPE_CIRCLE_ROUND]` (src/fov/fov.c), verbatim: `sqrt(r^2 + r - x^2)`. */
// prettier-ignore
const HEIGHTS_CIRCLE_ROUND: readonly number[] = [
   1,
   2,  1,
   3,  2,  1,
   4,  4,  3,  2,
   5,  5,  4,  3,  2,
   6,  6,  5,  5,  4,  2,
   7,  7,  6,  6,  5,  4,  2,
   8,  8,  7,  7,  6,  6,  4,  2,
   9,  9,  9,  8,  8,  7,  6,  5,  3,
  10, 10, 10,  9,  9,  8,  7,  6,  5,  3,
  11, 11, 11, 10, 10,  9,  9,  8,  7,  5,  3,
  12, 12, 12, 11, 11, 10, 10,  9,  8,  7,  5,  3,
  13, 13, 13, 12, 12, 12, 11, 10, 10,  9,  7,  6,  3,
  14, 14, 14, 13, 13, 13, 12, 12, 11, 10,  9,  8,  6,  3,
  15, 15, 15, 14, 14, 14, 13, 13, 12, 11, 10,  9,  8,  6,  3,
  16, 16, 16, 16, 15, 15, 14, 14, 13, 13, 12, 11, 10,  8,  6,  4,
  17, 17, 17, 17, 16, 16, 16, 15, 15, 14, 13, 12, 11, 10,  9,  7,  4,
  18, 18, 18, 18, 17, 17, 17, 16, 16, 15, 14, 14, 13, 12, 10,  9,  7,  4,
  19, 19, 19, 19, 18, 18, 18, 17, 17, 16, 16, 15, 14, 13, 12, 11,  9,  7,  4,
  20, 20, 20, 20, 19, 19, 19, 18, 18, 17, 17, 16, 15, 14, 13, 12, 11,  9,  7,  4,
  21, 21, 21, 21, 20, 20, 20, 19, 19, 19, 18, 17, 17, 16, 15, 14, 13, 11, 10,  7,  4,
  22, 22, 22, 22, 21, 21, 21, 21, 20, 20, 19, 19, 18, 17, 16, 15, 14, 13, 12, 10,  8,  4,
  23, 23, 23, 23, 22, 22, 22, 22, 21, 21, 20, 20, 19, 18, 18, 17, 16, 15, 13, 12, 10,  8,  4,
  24, 24, 24, 24, 23, 23, 23, 23, 22, 22, 21, 21, 20, 20, 19, 18, 17, 16, 15, 14, 12, 10,  8,  4,
  25, 25, 25, 25, 25, 24, 24, 24, 23, 23, 23, 22, 21, 21, 20, 19, 19, 18, 17, 15, 14, 12, 11,  8,  5,
  26, 26, 26, 26, 26, 25, 25, 25, 24, 24, 24, 23, 23, 22, 21, 21, 20, 19, 18, 17, 16, 14, 13, 11,  8,  5,
  27, 27, 27, 27, 27, 26, 26, 26, 25, 25, 25, 24, 24, 23, 23, 22, 21, 20, 19, 18, 17, 16, 15, 13, 11,  8,  5,
  28, 28, 28, 28, 28, 27, 27, 27, 27, 26, 26, 25, 25, 24, 24, 23, 22, 22, 21, 20, 19, 18, 16, 15, 13, 11,  9,  5,
  29, 29, 29, 29, 29, 28, 28, 28, 28, 27, 27, 26, 26, 25, 25, 24, 24, 23, 22, 21, 20, 19, 18, 17, 15, 13, 11,  9,  5,
  30, 30, 30, 30, 30, 29, 29, 29, 29, 28, 28, 28, 27, 27, 26, 25, 25, 24, 23, 23, 22, 21, 20, 18, 17, 15, 14, 12,  9,  5,
  31, 31, 31, 31, 31, 30, 30, 30, 30, 29, 29, 29, 28, 28, 27, 27, 26, 25, 25, 24, 23, 22, 21, 20, 19, 17, 16, 14, 12,  9,  5,
  32, 32, 32, 32, 32, 31, 31, 31, 31, 30, 30, 30, 29, 29, 28, 28, 27, 27, 26, 25, 24, 23, 22, 21, 20, 19, 18, 16, 14, 12,  9,  5,
];

/** `fov_buffer_type` (src/fov/fov.h). A static global in the C, so it persists across calls. */
type FovBuffer = {
  index: number;
  prevLen: number;
  readonly buffer: Float32Array;
  allocated: number;
};

const newFovBuffer = (): FovBuffer => ({
  index: 0,
  prevLen: 0,
  buffer: new Float32Array(FOV_BUFFER_SIZE),
  allocated: 0,
});

/** `GET_BUFFER(target, buffer_data, len)` (src/fov/fov.c): returns `target`, an index into `buffer`. */
function GET_BUFFER(buffer_data: FovBuffer, len: number): number {
  if (len >= FOV_BUFFER_SIZE) throw new Error(`GET_BUFFER len ${String(len)}`);
  const overrun = (buffer_data.index + buffer_data.prevLen + len) & (FOV_BUFFER_SIZE - 1);
  buffer_data.index = (buffer_data.index + buffer_data.prevLen) & (FOV_BUFFER_SIZE - 1);
  if (overrun < buffer_data.index) buffer_data.index = 0;
  buffer_data.prevLen = len;
  buffer_data.allocated += len; // instrumentation, not C
  return buffer_data.index;
}

/** `fov_settings_type` (src/fov/fov.h), the fields calc_circle reads. */
type FovSettings = {
  opaque: (map: FovMap, x: number, y: number) => boolean;
  apply: (map: FovMap, x: number, y: number, dx: number, dy: number, radius: number) => void;
  permissiveness: number;
  actor_vision_size: number;
  buffer_data: FovBuffer;
};

/** `fov_private_data_type` (src/fov/fov.c). `heights` is the table offset `heights[0]` sits at, or null. */
type FovPrivateData = {
  settings: FovSettings;
  map: FovMap;
  heights: number | null;
  source_x: number;
  source_y: number;
  radius: number;
};

/** `struct lua_fov` (src/fov.c), plus the Lua callbacks, plus recorders. */
type FovMap = {
  w: number;
  h: number;
  isWall: (x: number, y: number) => boolean;
  /** Every `settings->apply` call libfov makes, out-of-bounds ones included, then the source. */
  applyCalls: [number, number][];
  /** What reaches the Lua apply callback: `map_seen` after its bounds check. */
  seen: [number, number][];
  /** Every `settings->opaque` query, in order, out-of-bounds ones included. */
  opaqueCalls: [number, number][];
};

/**
 * Per-frame `int x, y`. The macro's `rx = ...; ry = ...;` lines write these; they are locals of each
 * octant call, so a recursive call must not see (or clobber) its caller's.
 */
type XY = { x: number; y: number };

/**
 * The octant-specific text of LARGE_ASS_FOV_DEFINE_OCTANT and LARGE_ASS_FOV_DEFINE_OCTANT_ZERO
 * (src/fov/fov.c), expanded by hand for each of the eight invocations. The macro body uses its
 * (signx, signy, rx, ry) parameters in exactly three places and those are all here:
 *   `rx = data->source_##rx signx dx;`          -> setRx
 *   `ry = data->source_##ry signy dy;`          -> setRy (also `(dy0-1)` / `(dy1+1)` in the
 *                                                  non-large-ass octant, unused by LARGE_ASS)
 *   `rx = data->source_##rx; ry = data->source_##ry signy 1;`  -> setZero (the _zero_ variant)
 * and `nx##ny##nf` is only the name the octant recurses into, which is itself.
 */
type Octant = {
  readonly name: string;
  setRx: (c: XY, data: FovPrivateData, dx: number) => void;
  setRy: (c: XY, data: FovPrivateData, dy: number) => void;
  setZero: (c: XY, data: FovPrivateData) => void;
};

/* LARGE_ASS_FOV_DEFINE_OCTANT(+,+,x,y,p,p,n) */
const ppn: Octant = {
  name: 'ppn',
  setRx: (c, data, dx) => {
    c.x = data.source_x + dx;
  },
  setRy: (c, data, dy) => {
    c.y = data.source_y + dy;
  },
  setZero: (c, data) => {
    c.x = data.source_x;
    c.y = data.source_y + 1;
  },
};
/* LARGE_ASS_FOV_DEFINE_OCTANT(+,+,y,x,p,p,y) */
const ppy: Octant = {
  name: 'ppy',
  setRx: (c, data, dx) => {
    c.y = data.source_y + dx;
  },
  setRy: (c, data, dy) => {
    c.x = data.source_x + dy;
  },
  setZero: (c, data) => {
    c.y = data.source_y;
    c.x = data.source_x + 1;
  },
};
/* LARGE_ASS_FOV_DEFINE_OCTANT(+,-,x,y,p,m,n) */
const pmn: Octant = {
  name: 'pmn',
  setRx: (c, data, dx) => {
    c.x = data.source_x + dx;
  },
  setRy: (c, data, dy) => {
    c.y = data.source_y - dy;
  },
  setZero: (c, data) => {
    c.x = data.source_x;
    c.y = data.source_y - 1;
  },
};
/* LARGE_ASS_FOV_DEFINE_OCTANT(+,-,y,x,p,m,y) */
const pmy: Octant = {
  name: 'pmy',
  setRx: (c, data, dx) => {
    c.y = data.source_y + dx;
  },
  setRy: (c, data, dy) => {
    c.x = data.source_x - dy;
  },
  setZero: (c, data) => {
    c.y = data.source_y;
    c.x = data.source_x - 1;
  },
};
/* LARGE_ASS_FOV_DEFINE_OCTANT(-,+,x,y,m,p,n) */
const mpn: Octant = {
  name: 'mpn',
  setRx: (c, data, dx) => {
    c.x = data.source_x - dx;
  },
  setRy: (c, data, dy) => {
    c.y = data.source_y + dy;
  },
  setZero: (c, data) => {
    c.x = data.source_x;
    c.y = data.source_y + 1;
  },
};
/* LARGE_ASS_FOV_DEFINE_OCTANT(-,+,y,x,m,p,y) */
const mpy: Octant = {
  name: 'mpy',
  setRx: (c, data, dx) => {
    c.y = data.source_y - dx;
  },
  setRy: (c, data, dy) => {
    c.x = data.source_x + dy;
  },
  setZero: (c, data) => {
    c.y = data.source_y;
    c.x = data.source_x + 1;
  },
};
/* LARGE_ASS_FOV_DEFINE_OCTANT(-,-,x,y,m,m,n) */
const mmn: Octant = {
  name: 'mmn',
  setRx: (c, data, dx) => {
    c.x = data.source_x - dx;
  },
  setRy: (c, data, dy) => {
    c.y = data.source_y - dy;
  },
  setZero: (c, data) => {
    c.x = data.source_x;
    c.y = data.source_y - 1;
  },
};
/* LARGE_ASS_FOV_DEFINE_OCTANT(-,-,y,x,m,m,y) */
const mmy: Octant = {
  name: 'mmy',
  setRx: (c, data, dx) => {
    c.y = data.source_y - dx;
  },
  setRy: (c, data, dy) => {
    c.x = data.source_x - dy;
  },
  setZero: (c, data) => {
    c.y = data.source_y;
    c.x = data.source_x - 1;
  },
};

/** `GET_HEIGHT(h, dx, data, settings)` (src/fov/fov.c), FOV_SHAPE_CIRCLE_ROUND. */
function GET_HEIGHT(dx: number, data: FovPrivateData): number {
  if (data.heights !== null) {
    const h = HEIGHTS_CIRCLE_ROUND[data.heights + dx];
    if (h === undefined) throw new Error('heights table overrun');
    return h;
  }
  // `(int)(sqrt((data->radius)*(data->radius) + data->radius - dx*dx))`: int maths, double sqrt.
  return Math.trunc(Math.sqrt(data.radius * data.radius + data.radius - dx * dx));
}

/**
 * `LARGE_ASS_FOV_DEFINE_OCTANT(signx, signy, rx, ry, nx, ny, nf)` (src/fov/fov.c), the body. The
 * three expansions of `GET_NEXT_LARGE_ASS_DATA` are inner closures so they read and write this frame's
 * locals exactly as the macro text does. `goto skip_recurse_below` is `break skip_recurse_below`.
 */
function large_ass_fov_octant(
  o: Octant,
  data: FovPrivateData,
  dx: number,
  lower_blen: number,
  upper_blen: number,
  lower_slope: number /* >= 0 */,
  upper_slope: number /* <= 2 */,
  lower_start_y: number,
  upper_start_y: number,
  y_min: number /* store in data? */,
  y_max: number /* store in data? */,
  lower_boundaries: number,
  upper_boundaries: number,
  apply_edge: boolean,
  apply_diag: boolean,
): void {
  const c: XY = { x: 0, y: 0 };
  // `int h, x, y, dy, dy0, dy1, cy0, cy1`: dy0, cy0 and h are assigned once, so const, below.
  let dy: number, dy1: number, cy1: number;
  let next_blen = 0;
  let prev_blocked = -1;
  const settings = data.settings;
  let fdy = 0,
    next_slope = 0,
    prev_slope = 0,
    slope = 0,
    next_start_y = 0;
  let fdx = f(dx);
  const pms = settings.permissiveness;
  let boundary = NULL,
    next_boundaries = NULL,
    prev_boundary = NULL,
    ptr_end = NULL;
  const buffer_data = settings.buffer_data;
  const B = buffer_data.buffer;
  let is_first = true;

  /** `GET_NEXT_LARGE_ASS_DATA(min, max, low, upp, , true)`, the one at the opaque-after-open tile. */
  const GET_NEXT_LARGE_ASS_DATA_min_max_low_upp_plus_true = (): void => {
    /* if (do_command) */ next_blen = 3;
    next_slope = div(sub(fdy, y_min), fdx);
    /* if (do_command) */ next_start_y = y_min;
    /* we may revise blen upper later, but request max possible anyway */
    next_boundaries = GET_BUFFER(buffer_data, upper_blen + 3);
    boundary = next_boundaries;

    /* set next_boundaries */
    if (upper_blen === 0) {
      B[boundary + X] = fdx;
      B[boundary + Y] = fdy;
      B[boundary + K] = div(sub(fdy, y_max), fdx);
    } else {
      prev_boundary = upper_boundaries;
      ptr_end = upper_boundaries + upper_blen;
      is_first = true;
      do {
        prev_slope = is_first
          ? div(sub(B[prev_boundary + Y]!, y_max), B[prev_boundary + X]!)
          : div(
              sub(B[prev_boundary + Y]!, B[boundary + Y - 3]!),
              sub(B[prev_boundary + X]!, B[boundary + X - 3]!),
            );
        slope = div(sub(fdy, B[prev_boundary + Y]!), sub(fdx, B[prev_boundary + X]!));
        if (
          sub(slope, prev_slope) > GRID_EPSILON /* (2) */ &&
          sub(sub(B[prev_boundary + Y]!, mul(slope, B[prev_boundary + X]!)), y_max) <
            GRID_EPSILON /* (3) */
        ) {
          B[boundary + X] = B[prev_boundary + X]!;
          B[boundary + Y] = B[prev_boundary + Y]!;
          B[boundary + K] = prev_slope;
          boundary += 3;
          /* if (do_command) */ next_blen += 3;
          is_first = false;
        }
        prev_boundary += 3;
      } while (prev_boundary !== ptr_end);

      /* now add the current opaque tile */
      B[boundary + X] = fdx;
      B[boundary + Y] = fdy;
      /* it's possible nothing was set */
      B[boundary + K] = is_first
        ? div(sub(B[boundary + Y]!, y_max), B[boundary + X]!)
        : div(
            sub(B[boundary + Y]!, B[boundary + Y - 3]!),
            sub(B[boundary + X]!, B[boundary + X - 3]!),
          );
    }

    /* set next_slope, checking lower_boundaries */
    if (lower_blen > 0) {
      prev_boundary = lower_boundaries;
      ptr_end = lower_boundaries + lower_blen;
      while (prev_boundary !== ptr_end) {
        if (sub(B[prev_boundary + K]!, next_slope) > GRID_EPSILON) {
          next_slope = div(
            sub(B[boundary + Y]!, B[prev_boundary + Y]!),
            sub(B[boundary + X]!, B[prev_boundary + X]!),
          );
          prev_boundary += 3;
        } else {
          break;
        }
      }
      /* if (do_command) */ next_start_y = sub(B[boundary + Y]!, mul(next_slope, B[boundary + X]!));
    }

    if (sub(upper_slope, next_slope) < GRID_EPSILON) {
      next_slope = upper_slope;
      /* if (do_command) */ next_start_y = sub(B[boundary + Y]!, mul(next_slope, B[boundary + X]!));
    }
    /* clean up noisy calculations to avoid precision errors */
    /* if (do_command) */ if (sub(next_start_y, y_min) < GRID_EPSILON) next_start_y = y_min;
  };

  /**
   * `GET_NEXT_LARGE_ASS_DATA(max, min, upp, low, -, do_command)`: `false` at the opaque-after-opaque
   * tile, `true` at the open-after-opaque tile. The closing clean-up names `y_min` literally, not
   * `y_##min`, so it is `y_min` here too.
   */
  const GET_NEXT_LARGE_ASS_DATA_max_min_upp_low_minus = (do_command: boolean): void => {
    if (do_command) next_blen = 3;
    next_slope = div(sub(fdy, y_max), fdx);
    if (do_command) next_start_y = y_max;
    /* we may revise blen upper later, but request max possible anyway */
    next_boundaries = GET_BUFFER(buffer_data, lower_blen + 3);
    boundary = next_boundaries;

    /* set next_boundaries */
    if (lower_blen === 0) {
      B[boundary + X] = fdx;
      B[boundary + Y] = fdy;
      B[boundary + K] = div(sub(fdy, y_min), fdx);
    } else {
      prev_boundary = lower_boundaries;
      ptr_end = lower_boundaries + lower_blen;
      is_first = true;
      do {
        prev_slope = is_first
          ? div(sub(B[prev_boundary + Y]!, y_min), B[prev_boundary + X]!)
          : div(
              sub(B[prev_boundary + Y]!, B[boundary + Y - 3]!),
              sub(B[prev_boundary + X]!, B[boundary + X - 3]!),
            );
        slope = div(sub(fdy, B[prev_boundary + Y]!), sub(fdx, B[prev_boundary + X]!));
        if (
          -sub(slope, prev_slope) > GRID_EPSILON /* (2) */ &&
          -sub(sub(B[prev_boundary + Y]!, mul(slope, B[prev_boundary + X]!)), y_min) <
            GRID_EPSILON /* (3) */
        ) {
          B[boundary + X] = B[prev_boundary + X]!;
          B[boundary + Y] = B[prev_boundary + Y]!;
          B[boundary + K] = prev_slope;
          boundary += 3;
          if (do_command) next_blen += 3;
          is_first = false;
        }
        prev_boundary += 3;
      } while (prev_boundary !== ptr_end);

      /* now add the current opaque tile */
      B[boundary + X] = fdx;
      B[boundary + Y] = fdy;
      /* it's possible nothing was set */
      B[boundary + K] = is_first
        ? div(sub(B[boundary + Y]!, y_min), B[boundary + X]!)
        : div(
            sub(B[boundary + Y]!, B[boundary + Y - 3]!),
            sub(B[boundary + X]!, B[boundary + X - 3]!),
          );
    }

    /* set next_slope, checking upper_boundaries */
    if (upper_blen > 0) {
      prev_boundary = upper_boundaries;
      ptr_end = upper_boundaries + upper_blen;
      while (prev_boundary !== ptr_end) {
        if (-sub(B[prev_boundary + K]!, next_slope) > GRID_EPSILON) {
          next_slope = div(
            sub(B[boundary + Y]!, B[prev_boundary + Y]!),
            sub(B[boundary + X]!, B[prev_boundary + X]!),
          );
          prev_boundary += 3;
        } else {
          break;
        }
      }
      if (do_command) next_start_y = sub(B[boundary + Y]!, mul(next_slope, B[boundary + X]!));
    }

    if (-sub(lower_slope, next_slope) < GRID_EPSILON) {
      next_slope = lower_slope;
      if (do_command) next_start_y = sub(B[boundary + Y]!, mul(next_slope, B[boundary + X]!));
    }
    /* clean up noisy calculations to avoid precision errors */
    if (do_command) {
      if (sub(next_start_y, y_min) < GRID_EPSILON) next_start_y = y_min;
    }
  };

  const seenIfCentred = (): void => {
    /* don't double-apply edges or diags, apply only if seen (cy0 < dy < cy1) */
    if ((apply_edge || dy > 0) && (apply_diag || dy !== dx) && dy > cy0 && dy < cy1) {
      settings.apply(data.map, c.x, c.y, c.x - data.source_x, c.y - data.source_y, data.radius);
    }
  };

  if (dx > data.radius) {
    return;
  }

  o.setRx(c, data, dx); /* rx = data->source_##rx signx dx; */

  const dy0 = toInt(
    add(add(lower_start_y, mul(sub(fdx, pms), lower_slope)), GRID_EPSILON),
  ); /* lower left */
  dy1 = toInt(
    sub(add(upper_start_y, mul(add(fdx, pms), upper_slope)), GRID_EPSILON),
  ); /* upper right */
  const cy0 =
    toInt(add(add(lower_start_y, mul(fdx, lower_slope)), GRID_EPSILON)) - 1; /* lower center */
  cy1 = toInt(sub(add(upper_start_y, mul(fdx, upper_slope)), GRID_EPSILON)) + 1; /* upper center */
  if (dy1 > dx + 1) dy1 = dx + 1;
  if (cy1 > dx + 1) cy1 = dx + 1;

  const h = GET_HEIGHT(dx, data);

  if (dy1 > h) {
    dy1 = h;
  }

  for (dy = dy0; dy <= dy1; ++dy) {
    o.setRy(c, data, dy); /* ry = data->source_##ry signy dy; */
    /* if blocked, then shadowcast below the blocked tile if necessary */
    if (settings.opaque(data.map, c.x, c.y)) {
      fdy = f(dy);
      skip_recurse_below: {
        if (prev_blocked === 0) {
          fdx = add(f(dx), pms);
          seenIfCentred();
          /* if lower line blocked by tile, then no recursive call is needed */
          if (sub(sub(fdy, lower_start_y), mul(fdx, lower_slope)) < GRID_EPSILON) {
            break skip_recurse_below;
          }

          GET_NEXT_LARGE_ASS_DATA_min_max_low_upp_plus_true();

          // prettier-ignore
          large_ass_fov_octant(
            o, data, dx + 1,
            lower_blen, next_blen,
            lower_slope, next_slope,
            lower_start_y, next_start_y,
            y_min, y_max,
            lower_boundaries, next_boundaries,
            apply_edge, apply_diag,
          );
        } else {
          /* prev_blocked != 0 */
          /* We need to calculate slopes to see if the tile is visible. */
          /* Recall that the previous tile and current tile are blocked, so the */
          /* previous tile may block the current tile. */
          fdx = sub(f(dx), pms);

          /* if upper line is blocked by previous tile, then we are done */
          if (sub(sub(fdy, upper_start_y), mul(fdx, upper_slope)) > GRID_EPSILON) {
            break skip_recurse_below;
          }
          if (sub(add(lower_start_y, mul(fdx, lower_slope)), fdy) < GRID_EPSILON) {
            GET_NEXT_LARGE_ASS_DATA_max_min_upp_low_minus(false);

            if (sub(upper_slope, next_slope) < GRID_EPSILON) {
              break skip_recurse_below;
            }
          }
          seenIfCentred();
        }
      }
      prev_blocked = 1;
    } else {
      /* not opaque */
      if (prev_blocked === 1) {
        fdy = f(dy);
        fdx = sub(f(dx), pms);

        /* if upper line is blocked by previous tile, then we are done */
        if (sub(sub(fdy, upper_start_y), mul(fdx, upper_slope)) > GRID_EPSILON) {
          return;
        }

        GET_NEXT_LARGE_ASS_DATA_max_min_upp_low_minus(true);

        if (sub(upper_slope, next_slope) < GRID_EPSILON) {
          return;
        }
        lower_blen = next_blen;
        lower_slope = next_slope;
        lower_start_y = next_start_y;
        lower_boundaries = next_boundaries;
      } /* end prev_blocked */
      seenIfCentred();
      prev_blocked = 0;
    } /* end if not opaque */
  } /* end for */

  if (prev_blocked === 0) {
    // prettier-ignore
    large_ass_fov_octant(
      o, data, dx + 1,
      lower_blen, upper_blen,
      lower_slope, upper_slope,
      lower_start_y, upper_start_y,
      y_min, y_max,
      lower_boundaries, upper_boundaries,
      apply_edge, apply_diag,
    );
  }
} /* DONE! */

/** `LARGE_ASS_FOV_DEFINE_OCTANT_ZERO(signx, signy, rx, ry, nx, ny, nf)` (src/fov/fov.c). */
function large_ass_fov_octant_zero(
  o: Octant,
  data: FovPrivateData,
  lower_slope: number /* >= 0 */,
  upper_slope: number /* <= 2 */,
  apply_edge: boolean,
  apply_diag: boolean,
): void {
  const c: XY = { x: 0, y: 0 };
  const settings = data.settings;
  let slope: number, upper_start_y: number;
  let upper_boundaries: number;
  const pms = settings.permissiveness;
  const y_min = sub(f(0.5), settings.actor_vision_size);
  const y_max = add(f(0.5), settings.actor_vision_size);

  if (sub(add(y_max, mul(upper_slope, pms)), f(1.0)) > GRID_EPSILON) {
    o.setZero(c, data); /* rx = data->source_##rx; ry = data->source_##ry signy 1; */
    if (settings.opaque(data.map, c.x, c.y)) {
      slope = div(sub(f(1.0), y_min), pms);
      if (sub(slope, upper_slope) < GRID_EPSILON) {
        upper_slope = slope;
      }
      upper_boundaries = GET_BUFFER(settings.buffer_data, 3);
      const B = settings.buffer_data.buffer;
      B[upper_boundaries + X] = pms;
      B[upper_boundaries + Y] = f(1.0);
      B[upper_boundaries + K] = div(sub(f(1.0), y_max), pms);
      upper_start_y = sub(f(1.0), mul(upper_slope, pms));
      // prettier-ignore
      large_ass_fov_octant(
        o, data, 1,
        0, 3,
        lower_slope, upper_slope,
        y_min, upper_start_y,
        y_min, y_max,
        NULL, upper_boundaries,
        apply_edge, apply_diag,
      );
      return;
    }
  }
  // prettier-ignore
  large_ass_fov_octant(
    o, data, 1,
    0, 0,
    lower_slope, upper_slope,
    y_min, y_max,
    y_min, y_max,
    NULL, NULL,
    apply_edge, apply_diag,
  );
}

/** `_large_ass_fov_circle` (src/fov/fov.c). The order is the C's, and it is the visit order. */
function _large_ass_fov_circle(data: FovPrivateData): void {
  large_ass_fov_octant_zero(ppn, data, f(0.0), f(2.0), true, true);
  large_ass_fov_octant_zero(ppy, data, f(0.0), f(2.0), true, false);
  large_ass_fov_octant_zero(pmy, data, f(0.0), f(2.0), false, true);
  large_ass_fov_octant_zero(mpn, data, f(0.0), f(2.0), true, false);
  large_ass_fov_octant_zero(mmn, data, f(0.0), f(2.0), false, true);
  large_ass_fov_octant_zero(mmy, data, f(0.0), f(2.0), true, false);
  large_ass_fov_octant_zero(mpy, data, f(0.0), f(2.0), false, true);
  large_ass_fov_octant_zero(pmn, data, f(0.0), f(2.0), false, false);
}

/** `fov_circle` (src/fov/fov.c), the non-hex, FOV_ALGO_LARGE_ASS branch. */
function fov_circle(
  settings: FovSettings,
  map: FovMap,
  source_x: number,
  source_y: number,
  radius: number,
): void {
  const data: FovPrivateData = {
    settings,
    map,
    source_x,
    source_y,
    radius,
    // `(radius < 33) ? heights_tables[settings->shape] + (radius*(radius-1) / 2 - 1) : NULL`
    heights: radius < 33 ? Math.trunc((radius * (radius - 1)) / 2) - 1 : null,
  };
  _large_ass_fov_circle(data);
}

/**
 * What engine/Module.lua:915-918 leaves in libfov's globals, computed the way the chain computes it:
 * engine/utils.lua:2286-2297 halves and bounds the permissiveness, then lua_fov_set_permissiveness
 * (src/fov.c) converts to float, clamps, and stores `0.5f - val`; engine/utils.lua:2303-2307 halves
 * and bounds the vision size and lua_fov_set_actor_vision_size stores it as a float.
 */
function tomeGlobals(): { permissiveness: number; actor_vision_size: number } {
  const bound = (i: number, min: number, max: number): number => Math.min(Math.max(i, min), max);
  let pval = f(bound(0.5 * 0.01, 0.0, 0.5)); // float val = luaL_checknumber(L, 1);
  if (pval < f(0.0)) pval = f(0.0);
  else if (pval > f(0.5)) pval = f(0.5);
  pval = sub(f(0.5), pval);
  let aval = f(bound(0.5 * 1, 0.0, 0.5));
  if (aval < f(0.0)) aval = f(0.0);
  else if (aval > f(0.5)) aval = f(0.5);
  return { permissiveness: pval, actor_vision_size: aval };
}

const TOME = tomeGlobals();

/** `static fov_buffer_type global_buffer_data` (src/fov/fov.c): ONE buffer for the process. */
const globalBufferData = newFovBuffer();

/**
 * `lua_fov_calc_circle` (src/fov.c) with `map_opaque` and `map_seen`: libfov's fov_circle, then
 * `map_seen(&fov, x, y, 0, 0, radius, NULL)` for the source. Out-of-bounds is opaque and unseen.
 */
function oracleCalcCircle(
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number,
  isWall: (x: number, y: number) => boolean,
  buffer: FovBuffer = globalBufferData,
): FovMap {
  const map: FovMap = { w, h, isWall, applyCalls: [], seen: [], opaqueCalls: [] };
  const map_seen = (m: FovMap, mx: number, my: number): void => {
    m.applyCalls.push([mx, my]);
    if (mx < 0 || my < 0 || mx >= m.w || my >= m.h) return;
    m.seen.push([mx, my]);
  };
  const map_opaque = (m: FovMap, mx: number, my: number): boolean => {
    m.opaqueCalls.push([mx, my]);
    if (mx < 0 || my < 0 || mx >= m.w || my >= m.h) return true;
    return m.isWall(mx, my);
  };
  const settings: FovSettings = {
    opaque: map_opaque,
    apply: map_seen,
    permissiveness: TOME.permissiveness,
    actor_vision_size: TOME.actor_vision_size,
    buffer_data: buffer,
  };
  fov_circle(settings, map, x, y, radius);
  map_seen(map, x, y);
  return map;
}

/** The oracle's cells, deduplicated, row-major (`y * w + x` ascending). */
function oracleCells(m: FovMap): number[] {
  return [...new Set(m.seen.map(([x, y]) => y * m.w + x))].sort((a, b) => a - b);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// THE CORPUS
// ═══════════════════════════════════════════════════════════════════════════════════════════════

type Case = {
  readonly id: number;
  readonly w: number;
  readonly h: number;
  readonly density: number;
  readonly walls: Uint8Array;
  readonly ox: number;
  readonly oy: number;
  readonly radius: number;
};

/** One map: 5..25 a side, 0..60% walls, radius 0..10, the origin forced to floor. */
function makeCase(rng: Rng, id: number): Case {
  const w = rng.int('fovoracle.w', 5, 25);
  const h = rng.int('fovoracle.h', 5, 25);
  const density = rng.int('fovoracle.density', 0, 60);
  const walls = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i += 1) walls[i] = rng.int('fovoracle.cell', 0, 99) < density ? 1 : 0;
  const ox = rng.int('fovoracle.ox', 0, w - 1);
  const oy = rng.int('fovoracle.oy', 0, h - 1);
  walls[oy * w + ox] = 0;
  const radius = rng.int('fovoracle.radius', 0, 10);
  return { id, w, h, density, walls, ox, oy, radius };
}

const wallFn =
  (c: Case) =>
  (x: number, y: number): boolean =>
    c.walls[y * c.w + x] === 1;

/** A minimal ASCII picture: `#` wall, `.` floor, `@` origin, `*` in one set only (marked by caller). */
function ascii(c: Case, mark: (x: number, y: number) => string | null = () => null): string {
  const rows: string[] = [];
  for (let y = 0; y < c.h; y += 1) {
    let row = '';
    for (let x = 0; x < c.w; x += 1) {
      const m = mark(x, y);
      row += m ?? (x === c.ox && y === c.oy ? '@' : c.walls[y * c.w + x] === 1 ? '#' : '.');
    }
    rows.push(row);
  }
  return rows.join('\n');
}

const CORPUS_SIZE = 4000;
const corpus: Case[] = (() => {
  const rng = createRng('fovcircle-oracle');
  const out: Case[] = [];
  for (let i = 0; i < CORPUS_SIZE; i += 1) out.push(makeCase(rng, i));
  return out;
})();

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// THE ORACLE AGAINST WHAT libfov SAYS OF ITSELF
// ═══════════════════════════════════════════════════════════════════════════════════════════════

describe('the oracle, before it judges anything', () => {
  it('takes the globals engine/Module.lua:915-918 leaves: 0.5f - 0.005f, and 0.5f', () => {
    expect(TOME.permissiveness).toBe(f(f(0.5) - f(0.005)));
    expect(TOME.permissiveness).toBe(0.4950000047683716);
    expect(TOME.actor_vision_size).toBe(0.5);
  });

  it('copies heights_tables[FOV_SHAPE_CIRCLE_ROUND] as fov.c comments it: (int)sqrt(r^2 + r - x^2)', () => {
    expect(HEIGHTS_CIRCLE_ROUND).toHaveLength(528);
    for (let r = 1; r <= 32; r += 1) {
      for (let dx = 1; dx <= r; dx += 1) {
        expect(HEIGHTS_CIRCLE_ROUND[(r * (r - 1)) / 2 - 1 + dx]).toBe(
          Math.trunc(Math.sqrt(r * r + r - dx * dx)),
        );
      }
    }
  });

  it('sees the fov.h disk x^2 + y^2 <= r^2 + r in an open field, each cell once, the source last', () => {
    for (let r = 0; r <= 12; r += 1) {
      const m = oracleCalcCircle(15, 15, 31, 31, r, () => false, newFovBuffer());
      const want: number[] = [];
      for (let y = 0; y < 31; y += 1) {
        for (let x = 0; x < 31; x += 1) {
          if ((x - 15) ** 2 + (y - 15) ** 2 <= r * r + r) want.push(y * 31 + x);
        }
      }
      expect(oracleCells(m)).toEqual(want);
      expect(m.seen).toHaveLength(want.length);
      expect(m.seen.at(-1)).toEqual([15, 15]);
    }
  });

  it('sees exactly the ring of eight walls around an enclosed source', () => {
    const ring = (x: number, y: number): boolean =>
      Math.max(Math.abs(x - 3), Math.abs(y - 3)) === 1;
    const m = oracleCalcCircle(3, 3, 7, 7, 5, ring, newFovBuffer());
    expect(oracleCells(m)).toEqual([16, 17, 18, 23, 24, 25, 30, 31, 32]);
  });

  // "val = 1.0 will result in symmetric vision and targeting (i.e., I can see you if and only if you
  // can see me) for applicable fov algorithms ("large_ass")" -- engine/utils.lua:2301-2302. A slip in
  // one octant's signs, or in one of the three GET_NEXT_LARGE_ASS_DATA expansions, breaks this.
  it('is symmetric between floor tiles, as engine/utils.lua:2301-2302 promises of large_ass', () => {
    let pairs = 0;
    const asymmetric: string[] = [];
    for (const c of corpus.slice(0, 400)) {
      const memo = new Map<number, Set<number>>();
      const fovAt = (x: number, y: number): Set<number> => {
        const k = y * c.w + x;
        let s = memo.get(k);
        if (!s) {
          s = new Set(oracleCells(oracleCalcCircle(x, y, c.w, c.h, c.radius, wallFn(c))));
          memo.set(k, s);
        }
        return s;
      };
      for (const k of fovAt(c.ox, c.oy)) {
        if (c.walls[k] === 1) continue;
        pairs += 1;
        const x = k % c.w;
        if (!fovAt(x, (k - x) / c.w).has(c.oy * c.w + c.ox))
          asymmetric.push(`${String(c.id)}:${String(k)}`);
      }
    }
    expect(pairs).toBeGreaterThan(10_000);
    expect(asymmetric).toEqual([]);
  });

  // GET_BUFFER is a ring of FOV_BUFFER_SIZE floats that never frees. It can only hand out a range a
  // live frame still reads if one call allocates most of the ring; this corpus never comes close, so
  // any allocation scheme in a port is equivalent to the C's here.
  it('never allocates enough in one call for GET_BUFFER to wrap onto live boundaries', () => {
    let most = 0;
    for (const c of corpus) {
      const buf = newFovBuffer();
      oracleCalcCircle(c.ox, c.oy, c.w, c.h, c.radius, wallFn(c), buf);
      most = Math.max(most, buf.allocated);
    }
    expect(most).toBeGreaterThan(0);
    expect(most).toBeLessThan(FOV_BUFFER_SIZE / 2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// THE PORT AGAINST THE ORACLE
// ═══════════════════════════════════════════════════════════════════════════════════════════════
//
// The transcription above was written from the C, and passed the tests above, before
// src/shared/mapgen/fovcircle.ts was opened. Since then it has gained only `inDoubles` and the
// imports; not one branch or operation of it has changed.

/** Wider maps, 20..90 a side, radius 0..40: deeper recursion, and past the table's radius-33 cut. */
function makeWideCase(rng: Rng, id: number): Case {
  const w = rng.int('fovoracle.wide.w', 20, 90);
  const h = rng.int('fovoracle.wide.h', 20, 90);
  const density = rng.int('fovoracle.wide.density', 0, 45);
  const walls = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i += 1) {
    walls[i] = rng.int('fovoracle.wide.cell', 0, 99) < density ? 1 : 0;
  }
  const ox = rng.int('fovoracle.wide.ox', 0, w - 1);
  const oy = rng.int('fovoracle.wide.oy', 0, h - 1);
  walls[oy * w + ox] = 0;
  const radius = rng.int('fovoracle.wide.radius', 0, 40);
  return { id, w, h, density, walls, ox, oy, radius };
}

const WIDE_SIZE = 1500;
const wideCorpus: Case[] = (() => {
  const rng = createRng('fovcircle-oracle-wide');
  const out: Case[] = [];
  for (let i = 0; i < WIDE_SIZE; i += 1) out.push(makeWideCase(rng, i));
  return out;
})();

const key = ([x, y]: readonly [number, number]): string => `${String(x)},${String(y)}`;

/** Where two ordered streams first part, or null. */
function firstSplit(a: readonly [number, number][], b: readonly [number, number][]): string | null {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    const p = a[i];
    const q = b[i];
    if (p === undefined || q === undefined || key(p) !== key(q)) {
      return `#${String(i)}: port ${p ? key(p) : 'end'}, oracle ${q ? key(q) : 'end'}`;
    }
  }
  return null;
}

/** The port's five observable outputs on one map, beside the oracle's. */
function judge(c: Case): {
  cells: string | null;
  seen: string | null;
  blocks: string | null;
  libfovApply: string | null;
  libfovOpaque: string | null;
} {
  const isWall = wallFn(c);
  const oracle = oracleCalcCircle(c.ox, c.oy, c.w, c.h, c.radius, isWall, newFovBuffer());
  const inBounds = ([x, y]: [number, number]): boolean => x >= 0 && y >= 0 && x < c.w && y < c.h;

  // 1. circleCells: the deduplicated set, row-major.
  const want = oracleCells(oracle);
  const got = circleCells({ w: c.w, h: c.h }, c.ox, c.oy, c.radius, isWall).map(
    (t) => t.y * c.w + t.x,
  );
  let cells: string | null = null;
  if (got.join() !== want.join()) {
    const g = new Set(got);
    const wset = new Set(want);
    cells = ascii(c, (x, y) => {
      const k = y * c.w + x;
      if (g.has(k) && !wset.has(k)) return 'P'; // the port only
      if (wset.has(k) && !g.has(k)) return 'O'; // the oracle only
      return null;
    });
  }

  // 2 and 3. calcCircle: what reaches Lua's apply (map_seen), and every block query, in order.
  const seen: [number, number][] = [];
  const blocks: [number, number][] = [];
  calcCircle(
    { w: c.w, h: c.h },
    c.ox,
    c.oy,
    c.radius,
    (x, y) => {
      blocks.push([x, y]);
      return isWall(x, y);
    },
    (x, y) => {
      seen.push([x, y]);
    },
  );

  // 4 and 5. largeAssFovCircle: libfov's own apply and opaque streams, off-map calls included.
  const libfovApply: [number, number][] = [];
  const libfovOpaque: [number, number][] = [];
  largeAssFovCircle(
    tomeFovSettings((x, y) => {
      libfovOpaque.push([x, y]);
      return x < 0 || y < 0 || x >= c.w || y >= c.h || isWall(x, y);
    }),
    c.ox,
    c.oy,
    c.radius,
    (x, y) => {
      libfovApply.push([x, y]);
    },
    freshRing(),
  );

  return {
    cells,
    seen: firstSplit(seen, oracle.seen),
    blocks: firstSplit(blocks, oracle.opaqueCalls.filter(inBounds)),
    // The oracle's last apply is lua_fov_calc_circle's own map_seen of the source.
    libfovApply: firstSplit(libfovApply, oracle.applyCalls.slice(0, -1)),
    libfovOpaque: firstSplit(libfovOpaque, oracle.opaqueCalls),
  };
}

/** Judge a corpus; every disagreement comes back with its map. */
function judgeAll(cases: readonly Case[]): {
  agree: Record<'cells' | 'seen' | 'blocks' | 'libfovApply' | 'libfovOpaque', number>;
  failures: string[];
} {
  const agree = { cells: 0, seen: 0, blocks: 0, libfovApply: 0, libfovOpaque: 0 };
  const failures: string[] = [];
  for (const c of cases) {
    const v = judge(c);
    const head = `map ${String(c.id)}: ${String(c.w)}x${String(c.h)}, origin (${String(c.ox)},${String(c.oy)}), radius ${String(c.radius)}`;
    for (const k of ['cells', 'seen', 'blocks', 'libfovApply', 'libfovOpaque'] as const) {
      const d = v[k];
      if (d === null) agree[k] += 1;
      else if (failures.length < 12) failures.push(`${head}, ${k}: ${d}\n${ascii(c)}`);
    }
  }
  return { agree, failures };
}

describe('circleCells and calcCircle against the oracle', () => {
  // The random corpus cannot see these two: measured on it, permissiveness anywhere in 0.47..0.495
  // changes no map (0.45 changes 4 of 4,000), and GRID_EPSILON = 0 changes none, here or on the wide
  // corpus. So they are pinned by value, not left to the maps.
  it('runs on the same constants: GRID_EPSILON, FOV_BUFFER_SIZE, 0.5f - 0.005f and 0.5f', () => {
    expect(PORT_GRID_EPSILON).toBe(GRID_EPSILON);
    expect(PORT_FOV_BUFFER_SIZE).toBe(FOV_BUFFER_SIZE);
    const s = tomeFovSettings(() => false);
    expect(s.permissiveness).toBe(TOME.permissiveness);
    expect(s.actorVisionSize).toBe(TOME.actor_vision_size);
  });

  it(`agrees on all ${String(CORPUS_SIZE)} random maps: the set, and all four raw streams in order`, () => {
    const { agree, failures } = judgeAll(corpus);
    expect(failures).toEqual([]);
    expect(agree).toEqual({
      cells: CORPUS_SIZE,
      seen: CORPUS_SIZE,
      blocks: CORPUS_SIZE,
      libfovApply: CORPUS_SIZE,
      libfovOpaque: CORPUS_SIZE,
    });
  });

  it(`agrees on all ${String(WIDE_SIZE)} wide maps, radius to 40, past the radius-33 table`, () => {
    expect(wideCorpus.some((c) => c.radius >= 33)).toBe(true);
    const { agree, failures } = judgeAll(wideCorpus);
    expect(failures).toEqual([]);
    expect(agree).toEqual({
      cells: WIDE_SIZE,
      seen: WIDE_SIZE,
      blocks: WIDE_SIZE,
      libfovApply: WIDE_SIZE,
      libfovOpaque: WIDE_SIZE,
    });
  });

  // Without this the wide test proves less than it looks: if doubles and floats never disagreed on
  // it, a port in doubles would pass. They disagree on 13 of the 1,500 (none of the small maps).
  it('the wide corpus is one the floats decide: done in doubles, the oracle changes some maps', () => {
    const cellsOf = (c: Case): string =>
      oracleCells(
        oracleCalcCircle(c.ox, c.oy, c.w, c.h, c.radius, wallFn(c), newFovBuffer()),
      ).join();
    const decided = wideCorpus.filter((c) => cellsOf(c) !== inDoubles(() => cellsOf(c)));
    expect(decided.length).toBeGreaterThan(0);
  });

  // Minimised from wide map 7. In doubles (12,7) is seen; in C floats it is not, and neither is it
  // in the port.
  //   @............
  //   .......#.....
  //   .............
  //   .......#.....
  //   .............
  //   ........#....
  //   .............
  //   ............X
  it('hides (12,7) behind three walls, as floats do and doubles do not', () => {
    const walls = new Set(['7,1', '7,3', '8,5']);
    const isWall = (x: number, y: number): boolean => walls.has(`${String(x)},${String(y)}`);
    const run = (): string[] =>
      oracleCells(oracleCalcCircle(0, 0, 13, 8, 14, isWall, newFovBuffer())).map(
        (k) => `${String(k % 13)},${String(Math.floor(k / 13))}`,
      );
    expect(run()).not.toContain('12,7');
    expect(inDoubles(run)).toContain('12,7');
    const port = circleCells({ w: 13, h: 8 }, 0, 0, 14, isWall).map(
      (t) => `${String(t.x)},${String(t.y)}`,
    );
    expect(port).toEqual(run());
  });
});
