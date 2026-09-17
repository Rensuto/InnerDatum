// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// The line under test ports t-engine4's core.fov.line (engine/utils.lua:2257-2277) and libfov's
// fov_create_los_line and lua_fov_line_step (src/fov/fov.c, src/fov.c, tag tome-1.6.0).
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

import { describe, expect, it } from 'vitest';

import {
  GRID_EPSILON,
  TOME_ACTOR_VISION_SIZE,
  TOME_PERMISSIVENESS,
  blockSight,
  createLosLine,
  eachStep,
  fovLine,
  lineCells,
  stepLine,
  tomeFovSettings,
} from '../../../src/shared/mapgen/fovline.ts';
import type { FovLine, LosStep } from '../../../src/shared/mapgen/fovline.ts';
import { createGenMap } from '../../../src/shared/mapgen/genmap.ts';
import { TileCode } from '../../../src/shared/protocol.ts';
import { createRng } from '../../../src/shared/rng.ts';

const allWall = (): boolean => true;
const allOpen = (): boolean => false;

/** `%.9g`, near enough: nine significant digits, which a float carries. */
const g9 = (v: number): number => Number(v.toPrecision(9));

/** Every `l:step()` to the end, as `x,y` or `x,y[cX,Y]` when a corner is reported. */
function stepped(l: FovLine): string[] {
  const out: string[] = [];
  for (let s = l.step(); s !== null; s = l.step()) {
    out.push(
      s.cornerX === null
        ? `${String(s.x)},${String(s.y)}`
        : `${String(s.x)},${String(s.y)}[c${String(s.cornerX)},${String(s.cornerY)}]`,
    );
  }
  return out;
}

/** `n` more `l:step(true)` past the end. */
function past(l: FovLine, n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const s = l.step(true);
    out.push(s === null ? 'stop' : `${String(s.x)},${String(s.y)}`);
  }
  return out;
}

describe('core.fov.line — the worked examples, from the compiled C', () => {
  // Hexacle's own call: the default block on an all-wall 40x40 map. Every
  // value here is what an x86-64 build of libfov printed.
  it('(0,0)->(5,2): a bent ray, blocked at 1, and one corner', () => {
    const l = fovLine({ w: 40, h: 40 }, 0, 0, 5, 2, allWall);
    expect([g9(l.line.step.x), g9(l.line.step.y)]).toEqual([1, 0.341863811]);
    expect([g9(l.line.start.x), g9(l.line.start.y)]).toEqual([0.5, 0.828384876]);
    expect([l.line.eps.x, l.line.eps.y]).toEqual([0, Math.fround(-2e-5)]);
    expect([l.line.destT, l.line.isBlocked, l.line.blockT]).toEqual([5, true, 1]);
    expect(stepped(l)).toEqual(['1,1', '2,1', '3,1', '4,2[c3,2]', '5,2']);
    expect(past(l, 4)).toEqual(['6,2', '7,3', '8,3', '9,3']);
  });

  it('(0,0)->(3,3): a diagonal snaps to a clean one', () => {
    const l = fovLine({ w: 40, h: 40 }, 0, 0, 3, 3, allWall);
    expect([l.line.step.x, l.line.step.y, l.line.start.x, l.line.start.y]).toEqual([
      1, 1, 0.5, 0.5,
    ]);
    expect([l.line.eps.x, l.line.eps.y]).toEqual([0, 0]);
    expect([l.line.destT, l.line.isBlocked, l.line.blockT]).toEqual([3, true, 1]);
    expect(stepped(l)).toEqual(['1,1', '2,2', '3,3']);
    expect(past(l, 4)).toEqual(['4,4', '5,5', '6,6', '7,7']);
  });

  it('(10,10)->(4,12): a negative major axis', () => {
    const l = fovLine({ w: 40, h: 40 }, 10, 10, 4, 12, allWall);
    expect([g9(l.line.step.x), g9(l.line.step.y)]).toEqual([-1, 0.278971493]);
    expect([g9(l.line.start.x), g9(l.line.start.y)]).toEqual([0.5, 0.859966159]);
    expect([l.line.eps.x, l.line.eps.y]).toEqual([0, Math.fround(-2e-5)]);
    expect([l.line.destT, l.line.isBlocked, l.line.blockT]).toEqual([6, true, 1]);
    expect(stepped(l)).toEqual(['9,11', '8,11', '7,11', '6,11', '5,12[c6,12]', '4,12']);
    expect(past(l, 4)).toEqual(['3,12', '2,13', '1,13', '0,13']);
  });

  it('(0,0)->(0,4): a straight run, which walls only mark as blocked', () => {
    const l = fovLine({ w: 40, h: 40 }, 0, 0, 0, 4, allWall);
    expect([l.line.step.x, l.line.step.y, l.line.start.x, l.line.start.y]).toEqual([
      0, 1, 0.5, 0.5,
    ]);
    expect([l.line.eps.x, l.line.eps.y]).toEqual([0, 0]);
    expect([l.line.destT, l.line.isBlocked, l.line.blockT]).toEqual([4, true, 1]);
    expect(stepped(l)).toEqual(['0,1', '0,2', '0,3', '0,4']);
    expect(past(l, 4)).toEqual(['0,5', '0,6', '0,7', '0,8']);
  });

  it('draws Bresenham`s cells on an open map, and not on a walled one', () => {
    expect(lineCells(fovLine({ w: 40, h: 40 }, 0, 0, 5, 2, allOpen))).toEqual(
      [
        [1, 0],
        [2, 1],
        [3, 1],
        [4, 2],
        [5, 2],
      ].map(([x, y]) => ({ x, y })),
    );
  });
});

describe('core.fov.line — ToME`s settings', () => {
  it('holds permissiveness and vision size as the C floats', () => {
    expect(TOME_PERMISSIVENESS).toBe(Math.fround(0.495));
    expect(TOME_ACTOR_VISION_SIZE).toBe(0.5);
    expect(GRID_EPSILON).toBe(Math.fround(1e-5));
    const s = tomeFovSettings(allWall);
    expect([s.permissiveness, s.actorVisionSize]).toEqual([TOME_PERMISSIVENESS, 0.5]);
  });
});

describe('core.fov.line — what step yields', () => {
  it('never the start, exactly max(|dx|,|dy|) eight-adjacent cells inside the box, the target last, then nothing', () => {
    const rng = createRng('fovline.props');
    for (let c = 0; c < 1500; c += 1) {
      const w = rng.int('w', 1, 30);
      const h = rng.int('h', 1, 30);
      const density = rng.int('d', 0, 100);
      const grid = Array.from({ length: w * h }, () => rng.int('cell', 0, 99) < density);
      const block = (x: number, y: number): boolean => grid[y * w + x] === true;
      const sx = rng.int('sx', -3, w + 2);
      const sy = rng.int('sy', -3, h + 2);
      const tx = rng.int('tx', -3, w + 2);
      const ty = rng.int('ty', -3, h + 2);
      const l = fovLine({ w, h }, sx, sy, tx, ty, block);
      const cells = lineCells(l);
      expect(cells.length).toBe(Math.max(Math.abs(tx - sx), Math.abs(ty - sy)));
      let px = sx;
      let py = sy;
      for (const cell of cells) {
        expect(cell.x === sx && cell.y === sy).toBe(false);
        expect(Math.max(Math.abs(cell.x - px), Math.abs(cell.y - py))).toBe(1);
        expect(cell.x).toBeGreaterThanOrEqual(Math.min(sx, tx));
        expect(cell.x).toBeLessThanOrEqual(Math.max(sx, tx));
        expect(cell.y).toBeGreaterThanOrEqual(Math.min(sy, ty));
        expect(cell.y).toBeLessThanOrEqual(Math.max(sy, ty));
        px = cell.x;
        py = cell.y;
      }
      if (cells.length > 0) expect(cells[cells.length - 1]).toEqual({ x: tx, y: ty });
      expect(l.step()).toBeNull();
      expect(l.step()).toBeNull();
      expect(l.call()).toBeNull();
    }
  });

  it('yields nothing for a zero-length line, even past its end', () => {
    const l = fovLine({ w: 10, h: 10 }, 4, 4, 4, 4, allWall);
    expect(l.line.destT).toBe(0);
    expect(l.step()).toBeNull();
    expect(l.step(true)).toBeNull();
    expect(l.call(true)).toBeNull();
  });

  it('keeps walking the same ray past the end with dontStopAtEnd, off the map and all', () => {
    const l = fovLine({ w: 6, h: 6 }, 5, 5, 3, 4, allWall);
    // Through rock the first step off the axis is diagonal at once.
    expect(lineCells(l)).toEqual([
      { x: 4, y: 4 },
      { x: 3, y: 4 },
    ]);
    const beyond: LosStep[] = [];
    for (let i = 0; i < 8; i += 1) beyond.push(l.step(true) as LosStep);
    expect(beyond.at(-1)?.x).toBe(-5);
  });

  it('is not symmetric through walls', () => {
    const cells = (sx: number, sy: number, tx: number, ty: number): string[] =>
      lineCells(fovLine({ w: 40, h: 40 }, sx, sy, tx, ty, allWall)).map(
        (c) => `${String(c.x)},${String(c.y)}`,
      );
    // The cells strictly between the ends differ: 1,1 there, 1,0 back.
    expect(cells(0, 0, 5, 2)).toEqual(['1,1', '2,1', '3,1', '4,2', '5,2']);
    expect(cells(5, 2, 0, 0)).toEqual(['4,1', '3,1', '2,1', '1,0', '0,0']);
  });

  it('truncates coordinates and map size toward zero, as the C binding`s ints do', () => {
    const a = lineCells(fovLine({ w: 40.9, h: 40.2 }, 0.9, 0.2, 5.99, 2.5, allWall));
    const b = lineCells(fovLine({ w: 40, h: 40 }, 0, 0, 5, 2, allWall));
    expect(a).toEqual(b);
  });
});

describe('core.fov.line — the terrain it reads, and when', () => {
  it('reads the terrain when the line is MADE: opening every wall afterwards moves no cell', () => {
    const rng = createRng('fovline.creation');
    for (let c = 0; c < 300; c += 1) {
      const w = 24;
      const h = 24;
      const grid = Array.from({ length: w * h }, () => rng.int('cell', 0, 99) < 55);
      const block = (x: number, y: number): boolean => grid[y * w + x] === true;
      const sx = rng.int('sx', 0, w - 1);
      const sy = rng.int('sy', 0, h - 1);
      const tx = rng.int('tx', 0, w - 1);
      const ty = rng.int('ty', 0, h - 1);
      const expected = lineCells(fovLine({ w, h }, sx, sy, tx, ty, block));
      const live = fovLine({ w, h }, sx, sy, tx, ty, block);
      grid.fill(false);
      const cells = [];
      for (let s = live.step(); s !== null; s = live.step()) cells.push({ x: s.x, y: s.y });
      expect(cells).toEqual(expected);
    }
  });

  it('but tests a corner against the terrain as it is at THAT step', () => {
    const open = new Set<string>();
    const block = (x: number, y: number): boolean => !open.has(`${String(x)},${String(y)}`);
    const l = fovLine({ w: 40, h: 40 }, 0, 0, 5, 2, block);
    const steps: LosStep[] = [];
    for (let s = l.step(); s !== null; s = l.step()) {
      steps.push(s);
      if (s.x === 2) open.add('3,2');
    }
    expect(steps.map((s) => [s.x, s.y])).toEqual([
      [1, 1],
      [2, 1],
      [3, 1],
      [4, 2],
      [5, 2],
    ]);
    expect(steps.every((s) => s.cornerX === null)).toBe(true);
  });

  it('reports a corner only through l:step(), never through l()', () => {
    const viaCall = fovLine({ w: 40, h: 40 }, 0, 0, 5, 2, allWall);
    const calls: (LosStep | null)[] = [];
    for (let i = 0; i < 5; i += 1) calls.push(viaCall.call());
    expect(calls.map((s) => s?.cornerX ?? null)).toEqual([null, null, null, null, null]);
  });

  it('treats off-map as opaque without asking the block function', () => {
    const asked: string[] = [];
    const block = (x: number, y: number): boolean => {
      asked.push(`${String(x)},${String(y)}`);
      return false;
    };
    // A 3x3 map: every cell the line would test outside it is opaque, so the
    // line through it is the all-wall line from the same offset.
    const edge = fovLine({ w: 3, h: 3 }, 1, 1, 9, 5, block);
    for (const k of asked) {
      const [x, y] = k.split(',').map(Number);
      expect((x ?? -1) >= 0 && (x ?? 3) < 3 && (y ?? -1) >= 0 && (y ?? 3) < 3).toBe(true);
    }
    const walled = fovLine({ w: 3, h: 3 }, 1, 1, 9, 5, allWall);
    expect(lineCells(edge)).toEqual(lineCells(walled));
  });

  it('`blockSight`: terrain that blocks sight blocks the line; nil terrain does not', () => {
    const map = createGenMap(4, 1, {}, createRng('blocksight'));
    map.set(1, 0, TileCode.WALL);
    map.set(2, 0, TileCode.FLOOR);
    const block = blockSight(map);
    expect([block(0, 0), block(1, 0), block(2, 0)]).toEqual([false, true, false]);
  });

  it('eachStep visits each cell before the next step is taken', () => {
    const order: string[] = [];
    const l = fovLine({ w: 40, h: 40 }, 0, 0, 3, 3, (x, y) => {
      order.push(`ask ${String(x)},${String(y)}`);
      return true;
    });
    order.length = 0;
    eachStep(l, (x, y) => order.push(`visit ${String(x)},${String(y)}`));
    expect(order).toEqual(['visit 1,1', 'visit 2,2', 'visit 3,3']);
  });

  it('`createLosLine` with startAtEnd puts the cursor at the end, or at blockT when blocked', () => {
    const open = createLosLine(tomeFovSettings(allOpen), 0, 0, 6, 1, true);
    expect(open.t).toBe(open.destT);
    expect(stepLine(tomeFovSettings(allOpen), open, true)).toBeNull();
    const walled = createLosLine(tomeFovSettings(allWall), 0, 0, 6, 1, true);
    expect([walled.isBlocked, walled.t]).toEqual([true, walled.blockT]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// THE C, TRANSCRIBED A SECOND TIME
// ═══════════════════════════════════════════════════════════════════════════

/**
 * `fov_create_los_line` and `lua_fov_line_step` again, from the C and not from
 * the port: macro by macro, the fields named `step_x` and `start_y` and reached
 * by string as the macros paste them, and every float operation through
 * `fround`. This transcription matched an x86-64 build of the C on 120,000
 * random cases before it was copied here. What it pins that no property can:
 * every truncation, every epsilon, the ray chosen between the two constraints,
 * and every corner.
 */
const fr = Math.fround;
const EPS = fr(1.0e-5);
const BUF = 2048;

type RefLine = Record<string, number>;
type RefOpaque = (x: number, y: number) => boolean;
type RefSettings = { opaque: RefOpaque; permissiveness: number; actor_vision_size: number };

function refSum(...t: number[]): number {
  let r = t[0] ?? 0;
  for (let i = 1; i < t.length; i += 1) r = fr(r + (t[i] ?? 0));
  return r;
}

function refOctant(
  settings: RefSettings,
  line: RefLine,
  dest: Record<string, number>,
  signx: number,
  signy: number,
  rx: 'x' | 'y',
  ry: 'x' | 'y',
): void {
  const S = (sg: number, v: number): number => (sg < 0 ? -v : v);
  const bufData = { index: 0, prev_len: 0, buffer: new Float32Array(BUF) };
  const GET_BUFFER = (len: number): number => {
    const overrun = (bufData.index + bufData.prev_len + len) & (BUF - 1);
    bufData.index = (bufData.index + bufData.prev_len) & (BUF - 1);
    if (overrun < bufData.index) bufData.index = 0;
    bufData.prev_len = len;
    return bufData.index;
  };
  const buf = bufData.buffer;
  const B = (i: number): number => buf[i] ?? 0;
  const X = 0;
  const Y = 1;
  const K = 2;
  const opaque = settings.opaque;
  const c: Record<string, number> = { x: 0, y: 0 };
  const get = (k: string): number => line[k] ?? 0;
  let ly0 = 0;
  let ly1: number;
  let uy0 = 0;
  let uy1: number;
  let lc0: number;
  let lc1: number;
  let uc0: number;
  let uc1: number;
  let next_blen = 0;
  let dx = 0;
  let lower_blen = 0;
  let upper_blen = 0;
  let delta = S(signx, (dest[rx] ?? 0) - get('source_' + rx));
  const delta_y = S(signy, (dest[ry] ?? 0) - get('source_' + ry));
  let next_slope = 0;
  let prev_slope = 0;
  let slope = 0;
  let next_start_y = 0;
  const y_min = fr(fr(0.5) - settings.actor_vision_size);
  const y_max = fr(fr(0.5) + settings.actor_vision_size);
  let fdx = S(signx, fr((dest[rx] ?? 0) - get('source_' + rx)));
  let fdy = S(signy, fr((dest[ry] ?? 0) - get('source_' + ry)));
  let fdt = fr(delta);
  let lower_start_y = y_min;
  let upper_start_y = y_max;
  const pms = settings.permissiveness;
  let lower_slope = fr(0);
  let upper_slope = fr(2);
  const slope_min = fr(fr(fdy - y_min) / fdx);
  const slope_max = fr(refSum(fdy, 1, -y_max) / fdx);
  let boundary = 0;
  let lower_boundaries = 0;
  let upper_boundaries = 0;
  let next_boundaries = 0;
  let prev_boundary = 0;
  let ptr_end = 0;

  // GET_NEXT_LARGE_ASS_DATA(min,max,low,upp,,true); lower = (max,min,upp,low,-,true)
  const GET_NEXT = (lowerVariant: boolean): void => {
    const yA = lowerVariant ? y_max : y_min;
    const yB = lowerVariant ? y_min : y_max;
    const sg = lowerVariant ? -1 : 1;
    const uppBlen = lowerVariant ? lower_blen : upper_blen;
    const uppBounds = lowerVariant ? lower_boundaries : upper_boundaries;
    const lowBlen = lowerVariant ? upper_blen : lower_blen;
    const lowBounds = lowerVariant ? upper_boundaries : lower_boundaries;
    const uppSlope = lowerVariant ? lower_slope : upper_slope;
    next_blen = 3;
    next_slope = fr(fr(fdy - yA) / fdx);
    next_start_y = yA;
    next_boundaries = GET_BUFFER(uppBlen + 3);
    boundary = next_boundaries;
    if (uppBlen === 0) {
      buf[boundary + X] = fdx;
      buf[boundary + Y] = fdy;
      buf[boundary + K] = fr(fr(fdy - yB) / fdx);
    } else {
      prev_boundary = uppBounds;
      ptr_end = uppBounds + uppBlen;
      let is_first = true;
      do {
        prev_slope = is_first
          ? fr(fr(B(prev_boundary + Y) - yB) / B(prev_boundary + X))
          : fr(
              fr(B(prev_boundary + Y) - B(boundary + Y - 3)) /
                fr(B(prev_boundary + X) - B(boundary + X - 3)),
            );
        slope = fr(fr(fdy - B(prev_boundary + Y)) / fr(fdx - B(prev_boundary + X)));
        if (
          sg * fr(slope - prev_slope) > EPS &&
          sg * refSum(B(prev_boundary + Y), -fr(slope * B(prev_boundary + X)), -yB) < EPS
        ) {
          buf[boundary + X] = B(prev_boundary + X);
          buf[boundary + Y] = B(prev_boundary + Y);
          buf[boundary + K] = prev_slope;
          boundary += 3;
          next_blen += 3;
          is_first = false;
        }
        prev_boundary += 3;
      } while (prev_boundary !== ptr_end);
      buf[boundary + X] = fdx;
      buf[boundary + Y] = fdy;
      buf[boundary + K] = is_first
        ? fr(fr(B(boundary + Y) - yB) / B(boundary + X))
        : fr(fr(B(boundary + Y) - B(boundary + Y - 3)) / fr(B(boundary + X) - B(boundary + X - 3)));
    }
    if (lowBlen > 0) {
      prev_boundary = lowBounds;
      ptr_end = lowBounds + lowBlen;
      while (prev_boundary !== ptr_end) {
        if (sg * fr(B(prev_boundary + K) - next_slope) > EPS) {
          next_slope = fr(
            fr(B(boundary + Y) - B(prev_boundary + Y)) / fr(B(boundary + X) - B(prev_boundary + X)),
          );
          prev_boundary += 3;
        } else {
          break;
        }
      }
      next_start_y = fr(B(boundary + Y) - fr(next_slope * B(boundary + X)));
    }
    if (sg * fr(uppSlope - next_slope) < EPS) {
      next_slope = uppSlope;
      next_start_y = fr(B(boundary + Y) - fr(next_slope * B(boundary + X)));
    }
    if (fr(next_start_y - y_min) < EPS) next_start_y = y_min;
  };

  // LARGE_ASS_LOS_FINISH(do_blocked, signy, rx, ry)
  const FINISH = (do_blocked: boolean): void => {
    fdx = fr(get('dest_t'));
    fdy = fr(delta_y);
    c[rx] = dest[rx] ?? 0;
    ly0 = lower_blen;
    uy0 = upper_blen;
    if (Math.trunc(refSum(lower_start_y, fr(fdx * lower_slope), EPS)) < delta_y) {
      c[ry] = dest[ry] ?? 0;
      GET_NEXT(true);
      ly0 = next_blen - 3;
      lower_blen = next_blen;
      lower_slope = next_slope;
      lower_start_y = next_start_y;
      lower_boundaries = next_boundaries;
    }
    if (Math.trunc(refSum(upper_start_y, fr(fdx * upper_slope), -EPS)) > delta_y) {
      c[ry] = (dest[ry] ?? 0) + S(signy, 1);
      fdy = fr(delta_y + 1);
      GET_NEXT(false);
      uy0 = next_blen - 3;
      upper_slope = next_slope;
      upper_start_y = next_start_y;
      fdy = fr(delta_y);
    }
    slope = fr(upper_start_y + fr(fdx * upper_slope));
    next_slope = fr(lower_start_y + fr(fdx * lower_slope));
    next_start_y = fr(
      fr(
        fr(fr(-2) * fdx) *
          refSum(
            fr(upper_start_y * lower_slope),
            fr(lower_start_y * upper_slope),
            fr(fr(fdx * lower_slope) * upper_slope),
          ),
      ) - fr(fr(fr(4) * lower_start_y) * upper_start_y),
    );
    slope = fr(fr(upper_start_y * upper_start_y) + fr(slope * slope));
    prev_slope = refSum(
      lower_start_y,
      -upper_start_y,
      fr(fdx * lower_slope),
      -fr(fdx * upper_slope),
    );
    next_slope = refSum(
      slope,
      next_start_y,
      fr(next_slope * next_slope),
      fr(lower_start_y * lower_start_y),
    );
    prev_slope = refSum(
      fr(fr(2) * slope),
      next_start_y,
      fr(fr(fr(2) * fdy) * prev_slope),
      prev_slope,
      lower_start_y,
      -upper_start_y,
    );

    if (next_slope > EPS || next_slope < -EPS) {
      slope = fr(fr(fr(0.5) * prev_slope) / next_slope);
      if (slope < fr(0.1)) slope = fr(0.1);
      else if (slope > fr(0.9)) slope = fr(0.9);
      line['step_' + ry] = S(
        signy,
        fr(fr(slope * lower_slope) + fr(fr(fr(1) - slope) * upper_slope)),
      );
      line['start_' + ry] = fr(fr(slope * lower_start_y) + fr(fr(fr(1) - slope) * upper_start_y));
    } else {
      line['step_' + ry] = S(signy, fr(fr(0.5) * fr(lower_slope + upper_slope)));
      line['start_' + ry] = fr(fr(0.5) * fr(lower_start_y + upper_start_y));
    }
    if (get('start_' + ry) > y_max) line['start_' + ry] = y_max;

    const upperScan = (): void => {
      boundary = upper_boundaries;
      ptr_end = upper_boundaries + uy0;
      do {
        if (refSum(B(boundary + Y), -get('start_' + ry), -fr(slope * B(boundary + X))) < EPS) {
          fdt = B(boundary + X);
          break;
        }
        boundary += 3;
      } while (boundary !== ptr_end);
    };
    const lowerScan = (): void => {
      boundary = lower_boundaries;
      ptr_end = lower_boundaries + ly0;
      do {
        if (fr(B(boundary + X) - fdt) > EPS) break;
        if (refSum(get('start_' + ry), fr(slope * B(boundary + X)), -B(boundary + Y)) < EPS) {
          line['eps_' + ry] = S(signy, fr(fr(2) * EPS));
          break;
        }
        boundary += 3;
      } while (boundary !== ptr_end);
    };

    if (do_blocked) {
      line['is_blocked'] = 1;
      line['block_t'] = get('dest_t') - delta;
      if (ly0 > 0) {
        if (uy0 > 0) {
          slope = fr(Math.abs(fr(get('step_' + ry) / get('step_' + rx))));
          upperScan();
          lowerScan();
        } else {
          line['eps_' + ry] = S(signy, fr(fr(2) * EPS));
        }
      }
    } else if (ly0 > 0) {
      line['eps_' + ry] = S(signy, fr(fr(-0.5) * EPS));
      slope = fr(Math.abs(fr(get('step_' + ry) / get('step_' + rx))));
      if (uy0 > 0) upperScan();
      lowerScan();
    }

    if (fr(S(signy, get('step_' + ry)) - fr(1)) > EPS) {
      line['start_' + ry] = fr(0.5);
      line['step_' + ry] = S(signy, fr(1));
      line['eps_' + ry] = fr(0);
    } else if (
      Math.trunc(refSum(get('start_' + ry), S(signy, fr(fdx * get('step_' + ry))), -EPS)) < delta_y
    ) {
      line['eps_' + ry] = S(signy, fr(fr(0.5) * EPS));
    }
  };

  c[rx] = get('source_' + rx);
  line['step_' + rx] = S(signx, fr(1));
  line['start_' + rx] = fr(0.5);
  line['eps_' + rx] = fr(0);
  line['eps_' + ry] = S(signy, fr(fr(-2) * EPS));
  line['dest_t'] = delta;

  if (refSum(y_max, fr(upper_slope * pms), -1) > EPS) {
    c[ry] = get('source_' + ry) + S(signy, 1);
    if (opaque(c['x'] ?? 0, c['y'] ?? 0)) {
      slope = fr(fr(fr(1) - y_min) / pms);
      if (fr(slope - upper_slope) < EPS) upper_slope = slope;
      upper_boundaries = GET_BUFFER(3);
      buf[upper_boundaries + X] = pms;
      buf[upper_boundaries + Y] = 1;
      buf[upper_boundaries + K] = fr(fr(fr(1) - y_max) / pms);
      upper_start_y = fr(fr(1) - fr(upper_slope * pms));
      upper_blen = 3;
    }
  }

  const at = (): boolean => opaque(c['x'] ?? 0, c['y'] ?? 0);
  for (;;) {
    if (--delta < 0) {
      FINISH(false);
      return;
    }
    dx += 1;
    c[rx] = (c[rx] ?? 0) + S(signx, 1);
    fdx = fr(dx);
    ly0 = Math.trunc(refSum(lower_start_y, fr(fr(fdx - pms) * lower_slope), EPS));
    lc0 = Math.trunc(refSum(y_min, fr(fr(fdx - pms) * slope_min), EPS));
    ly1 = Math.trunc(refSum(lower_start_y, fr(fr(fdx + pms) * lower_slope), EPS));
    lc1 = Math.trunc(refSum(y_min, fr(fr(fdx + pms) * slope_min), EPS));
    uy0 = Math.trunc(refSum(upper_start_y, fr(fr(fdx - pms) * upper_slope), -EPS));
    uc0 = Math.trunc(refSum(y_max, fr(fr(fdx - pms) * slope_max), -EPS));
    uy1 = Math.trunc(refSum(upper_start_y, fr(fr(fdx + pms) * upper_slope), -EPS));
    uc1 = Math.trunc(refSum(y_max, fr(fr(fdx + pms) * slope_max), -EPS));
    if (ly0 < lc0) ly0 = lc0;
    if (ly1 < lc1) ly1 = lc1;
    if (uy0 > uc0) uy0 = uc0;
    if (uy1 > uc1) uy1 = uc1;

    c[ry] = get('source_' + ry) + S(signy, ly0);
    if (at()) {
      if (
        ly0 === uy0 &&
        (upper_blen === 0 || refSum(fdx, -B(upper_boundaries + upper_blen - 3 + X), -0.5) > EPS)
      ) {
        if (delta || ly0 !== delta_y) FINISH(true);
        else FINISH(false);
        return;
      }
      fdy = fr(ly0 + 1);
      fdx = fr(fdx - pms);
      GET_NEXT(true);
      if (
        Math.trunc(refSum(next_start_y, fr(fdt * next_slope), EPS)) > delta_y ||
        fr(upper_slope - next_slope) < EPS
      ) {
        FINISH(true);
        return;
      }
      lower_blen = next_blen;
      lower_slope = next_slope;
      lower_start_y = next_start_y;
      lower_boundaries = next_boundaries;
      c[ry] = get('source_' + ry) + S(signy, uy0);
      if (ly0 !== uy0 && at()) {
        if (delta) FINISH(true);
        else FINISH(false);
        return;
      }
      c[ry] = get('source_' + ry) + S(signy, uy1);
      if (delta && uy0 !== uy1 && at()) {
        fdy = fr(uy1);
        fdx = fr(fdx + fr(fr(2) * pms));
        GET_NEXT(false);
        if (
          Math.trunc(refSum(next_start_y, fr(fdt * next_slope), -EPS)) < delta_y ||
          fr(next_slope - lower_slope) < EPS
        ) {
          FINISH(true);
          return;
        }
        upper_slope = next_slope;
        upper_start_y = next_start_y;
        upper_boundaries = next_boundaries;
        upper_blen = next_blen;
      }
      continue;
    }
    c[ry] = get('source_' + ry) + S(signy, uy1);
    if (ly0 !== uy1 && at()) {
      c[ry] = get('source_' + ry) + S(signy, ly1);
      if (uy1 === ly1 || (ly0 !== ly1 && at())) {
        if (delta) FINISH(true);
        else FINISH(false);
        return;
      } else if (delta) {
        fdy = fr(uy1);
        fdx = fr(fdx + pms);
        GET_NEXT(false);
        if (Math.trunc(refSum(next_start_y, fr(fdt * next_slope), -EPS)) < delta_y) {
          FINISH(true);
          return;
        }
        upper_slope = next_slope;
        upper_start_y = next_start_y;
        upper_boundaries = next_boundaries;
        upper_blen = next_blen;
      }
      continue;
    }
    c[ry] = get('source_' + ry) + S(signy, ly0 + 1);
    if (ly0 + 2 === uy1 && at()) {
      if (delta) FINISH(true);
      else FINISH(false);
      return;
    }
  }
}

function refCreate(settings: RefSettings, sx: number, sy: number, tx: number, ty: number): RefLine {
  const line: RefLine = {
    start_x: fr(0.5),
    start_y: fr(0.5),
    source_x: sx,
    source_y: sy,
    t: 0,
    is_blocked: 0,
    block_t: 0,
    dest_t: 0,
    step_x: 0,
    step_y: 0,
    eps_x: 0,
    eps_y: 0,
  };
  const opaque = settings.opaque;
  if (sx === tx) {
    line['dest_t'] = Math.abs(ty - sy);
    if (sy === ty) return line;
    const dy = ty < sy ? -1 : 1;
    let y = sy;
    do {
      y += dy;
      if (opaque(sx, y)) {
        line['is_blocked'] = y !== ty ? 1 : 0;
        line['block_t'] = dy * (y - sy);
        break;
      }
    } while (y !== ty);
    line['step_x'] = 0;
    line['step_y'] = dy;
  } else if (sy === ty) {
    line['dest_t'] = Math.abs(tx - sx);
    const dx = tx < sx ? -1 : 1;
    let x = sx;
    do {
      x += dx;
      if (opaque(x, sy)) {
        line['is_blocked'] = x !== tx ? 1 : 0;
        line['block_t'] = dx * (x - sx);
        break;
      }
    } while (x !== tx);
    line['step_x'] = dx;
    line['step_y'] = 0;
  } else {
    const dest = { x: tx, y: ty };
    if (tx > sx) {
      if (ty > sy) {
        if (tx - sx > ty - sy) refOctant(settings, line, dest, +1, +1, 'x', 'y');
        else refOctant(settings, line, dest, +1, +1, 'y', 'x');
      } else if (tx - sx > sy - ty) refOctant(settings, line, dest, +1, -1, 'x', 'y');
      else refOctant(settings, line, dest, -1, +1, 'y', 'x');
    } else if (ty > sy) {
      if (sx - tx > ty - sy) refOctant(settings, line, dest, -1, +1, 'x', 'y');
      else refOctant(settings, line, dest, +1, -1, 'y', 'x');
    } else if (sx - tx > sy - ty) refOctant(settings, line, dest, -1, -1, 'x', 'y');
    else refOctant(settings, line, dest, -1, -1, 'y', 'x');
  }
  return line;
}

function refStep(
  settings: RefSettings,
  line: RefLine,
  useBlock: boolean,
  dont_stop_at_end: boolean,
): string {
  const get = (k: string): number => line[k] ?? 0;
  if ((!dont_stop_at_end && get('dest_t') === get('t')) || get('dest_t') === 0) return 'nil';
  const pms = settings.permissiveness;
  let blocked = false;
  let corner_x = 0;
  let corner_y = 0;
  const step_x = get('step_x');
  const step_y = get('step_y');
  const eps_x = get('eps_x');
  const eps_y = get('eps_y');
  const t = get('t');
  const fx = fr(fr(t) * step_x);
  const fy = fr(fr(t) * step_y);
  const fx2 = fr(fr(fr(t + 1) * step_x) + eps_x);
  const fy2 = fr(fr(fr(t + 1) * step_y) + eps_y);
  const x0 = get('start_x');
  const y0 = get('start_y');
  const sX = get('source_x');
  const sY = get('source_y');
  let x: number;
  let y: number;
  let x_prev: number;
  let y_prev: number;
  let dx: number;
  let dy: number;
  const corner = (cx: number, cy: number, cond: number): void => {
    corner_x = cx;
    corner_y = cy;
    if (cond > EPS && settings.opaque(cx, cy)) blocked = true;
  };
  const tr = Math.trunc;
  if (fx2 < 0) {
    x_prev = -tr(refSum(x0, -fx, -eps_x));
    x = -tr(fr(x0 - fx2));
    if (fy2 < 0) {
      y_prev = -tr(refSum(y0, -fy, -eps_y));
      y = -tr(fr(y0 - fy2));
      if (x !== x_prev && y !== y_prev && useBlock) {
        if (fy2 < fx2) {
          dx = fr(refSum(x, -fx, x0) / step_x);
          dy = fr(refSum(y, -fy, y0, -0.5, pms) / step_y);
          if (dx > dy) corner(sX + x_prev, sY + y, refSum(-x, fx, -x0, fr(dy * step_x), eps_x));
          else
            corner(sX + x, sY + y_prev, refSum(-y_prev, 0.5, pms, fy, -y0, fr(dx * step_y), eps_y));
        } else {
          dx = fr(refSum(x, -fx, x0, -0.5, pms) / step_x);
          dy = fr(refSum(y, -fy, y0) / step_y);
          if (dx > dy)
            corner(sX + x_prev, sY + y, refSum(-x_prev, 0.5, pms, fx, -x0, fr(dy * step_x), eps_x));
          else corner(sX + x, sY + y_prev, refSum(-y, fy, -y0, fr(dx * step_y), eps_y));
        }
      }
    } else {
      y_prev = tr(refSum(y0, fy, eps_y));
      y = tr(fr(y0 + fy2));
      if (x !== x_prev && y !== y_prev && useBlock) {
        if (-fy2 < fx2) {
          dx = fr(refSum(x, -fx, x0) / step_x);
          dy = fr(refSum(y, -fy, -y0, 0.5, -pms) / step_y);
          if (dx > dy) corner(sX + x_prev, sY + y, refSum(-x, fx, -x0, fr(dy * step_x), eps_x));
          else
            corner(
              sX + x,
              sY + y_prev,
              refSum(y_prev, 0.5, pms, -fy, -y0, -fr(dx * step_y), -eps_y),
            );
        } else {
          dx = fr(refSum(x, -fx, x0, -0.5, pms) / step_x);
          dy = fr(refSum(y, -fy, -y0) / step_y);
          if (dx > dy)
            corner(sX + x_prev, sY + y, refSum(-x_prev, 0.5, pms, fx, -x0, fr(dy * step_x), eps_x));
          else corner(sX + x, sY + y_prev, refSum(y, -fy, -y0, -fr(dx * step_y), -eps_y));
        }
      }
    }
  } else {
    x_prev = tr(refSum(x0, fx, eps_x));
    x = tr(fr(x0 + fx2));
    if (fy2 < 0) {
      y_prev = -tr(refSum(y0, -fy, -eps_y));
      y = -tr(fr(y0 - fy2));
      if (x !== x_prev && y !== y_prev && useBlock) {
        if (-fy2 > fx2) {
          dx = fr(refSum(x, -fx, -x0) / step_x);
          dy = fr(refSum(y, -fy, y0, -0.5, pms) / step_y);
          if (dx > dy) corner(sX + x_prev, sY + y, refSum(x, -fx, -x0, -fr(dy * step_x), -eps_x));
          else
            corner(sX + x, sY + y_prev, refSum(-y_prev, 0.5, pms, fy, -y0, fr(dx * step_y), eps_y));
        } else {
          dx = fr(refSum(x, -fx, -x0, 0.5, -pms) / step_x);
          dy = fr(refSum(y, -fy, y0) / step_y);
          if (dx > dy)
            corner(
              sX + x_prev,
              sY + y,
              refSum(x_prev, 0.5, pms, -fx, -x0, -fr(dy * step_x), -eps_x),
            );
          else corner(sX + x, sY + y_prev, refSum(-y, fy, -y0, fr(dx * step_y), eps_y));
        }
      }
    } else {
      y_prev = tr(refSum(y0, fy, eps_y));
      y = tr(fr(y0 + fy2));
      if (x !== x_prev && y !== y_prev && useBlock) {
        if (fy2 > fx2) {
          dx = fr(refSum(x, -fx, -x0) / step_x);
          dy = fr(refSum(y, -fy, -y0, 0.5, -pms) / step_y);
          if (dx > dy) corner(sX + x_prev, sY + y, refSum(x, -fx, -x0, -fr(dy * step_x), -eps_x));
          else
            corner(
              sX + x,
              sY + y_prev,
              refSum(y_prev, 0.5, pms, -fy, -y0, -fr(dx * step_y), -eps_y),
            );
        } else {
          dx = fr(refSum(x, -fx, -x0, 0.5, -pms) / step_x);
          dy = fr(refSum(y, -fy, -y0) / step_y);
          if (dx > dy)
            corner(
              sX + x_prev,
              sY + y,
              refSum(x_prev, 0.5, pms, -fx, -x0, -fr(dy * step_x), -eps_x),
            );
          else corner(sX + x, sY + y_prev, refSum(y, -fy, -y0, -fr(dx * step_y), -eps_y));
        }
      }
    }
  }
  line['t'] = t + 1;
  return blocked
    ? `${String(sX + x)},${String(sY + y)}[${String(corner_x)},${String(corner_y)}]`
    : `${String(sX + x)},${String(sY + y)}`;
}

describe('core.fov.line — against the C, transcribed a second time', () => {
  it('makes the same ray and steps the same cells and corners on 3,000 random maps', () => {
    const rng = createRng('fovline.against-c');
    for (let c = 0; c < 3000; c += 1) {
      const w = rng.int('w', 1, 40);
      const h = rng.int('h', 1, 40);
      const density = rng.int('density', 0, 100);
      const grid = Array.from({ length: w * h }, () => rng.int('cell', 0, 99) < density);
      const block = (x: number, y: number): boolean => grid[y * w + x] === true;
      const sx = rng.int('sx', -4, w + 3);
      const sy = rng.int('sy', -4, h + 3);
      const tx = rng.int('tx', -4, w + 3);
      const ty = rng.int('ty', -4, h + 3);
      const useBlock = rng.int('useBlock', 0, 1) === 1;
      const extra = rng.int('extra', 0, 6);

      const l = fovLine({ w, h }, sx, sy, tx, ty, block);
      const settings: RefSettings = {
        opaque: (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? true : block(x, y)),
        permissiveness: fr(fr(0.5) - fr(0.5 * 0.01)),
        actor_vision_size: fr(0.5),
      };
      const ref = refCreate(settings, sx, sy, tx, ty);

      const mine = [
        l.line.step.x,
        l.line.step.y,
        l.line.start.x,
        l.line.start.y,
        l.line.eps.x,
        l.line.eps.y,
        l.line.destT,
        l.line.isBlocked ? 1 : 0,
        l.line.isBlocked ? l.line.blockT : -1,
      ];
      const theirs = [
        ref['step_x'],
        ref['step_y'],
        ref['start_x'],
        ref['start_y'],
        ref['eps_x'],
        ref['eps_y'],
        ref['dest_t'],
        ref['is_blocked'],
        ref['is_blocked'] === 1 ? ref['block_t'] : -1,
      ];
      expect(mine).toEqual(theirs);

      const show = (s: LosStep | null): string =>
        s === null
          ? 'nil'
          : s.cornerX === null
            ? `${String(s.x)},${String(s.y)}`
            : `${String(s.x)},${String(s.y)}[${String(s.cornerX)},${String(s.cornerY)}]`;
      const a: string[] = [];
      const b: string[] = [];
      for (let i = 0; i <= l.line.destT + 1; i += 1) {
        a.push(show(useBlock ? l.step() : l.call()));
        b.push(refStep(settings, ref, useBlock, false));
      }
      for (let i = 0; i < extra; i += 1) {
        a.push(show(useBlock ? l.step(true) : l.call(true)));
        b.push(refStep(settings, ref, useBlock, true));
      }
      expect(a).toEqual(b);
    }
  });
});
