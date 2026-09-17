// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// The geometry under test ports t-engine4's bresenham, core.fov.distance and calc_circle
// (src/core_lua.c, src/fov.c, tag tome-1.6.0) and engine/utils.lua:2178-2199, :2358-2361.
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

import { describe, expect, it } from 'vitest';

import { circleGrids, fovDistance, line } from '../../../src/shared/mapgen/geom.ts';

const cells = (list: readonly (readonly [number, number])[]) => list.map(([x, y]) => ({ x, y }));

describe('line.new — libtcod`s Bresenham', () => {
  it('draws the worked examples', () => {
    expect(line(0, 0, 4, 2)).toEqual(
      cells([
        [1, 0],
        [2, 1],
        [3, 1],
        [4, 2],
      ]),
    );
    expect(line(0, 0, 5, 1)).toEqual(
      cells([
        [1, 0],
        [2, 0],
        [3, 1],
        [4, 1],
        [5, 1],
      ]),
    );
    expect(line(0, 0, 2, 4)).toEqual(
      cells([
        [0, 1],
        [1, 2],
        [1, 3],
        [2, 4],
      ]),
    );
  });

  it('yields nothing for a zero-length line', () => {
    expect(line(3, 7, 3, 7)).toEqual([]);
    expect(line(3.9, 7.2, 3.1, 7.8)).toEqual([]);
  });

  it('truncates coordinates toward zero', () => {
    expect(line(0.9, -0.9, 4.7, 2.2)).toEqual(line(0, 0, 4, 2));
    expect(line(-1.5, 0, -4.9, 0)).toEqual(
      cells([
        [-2, 0],
        [-3, 0],
        [-4, 0],
      ]),
    );
    // Truncation never produces a negative zero.
    for (const c of line(-0.5, -0.5, 3, 3)) {
      expect(Object.is(c.x, -0) || Object.is(c.y, -0)).toBe(false);
    }
  });

  it('on every line within 7 cells: never the start, the end last, one major step per cell, ties toward the start', () => {
    let lines = 0;
    let ties = 0;
    for (let ax = -7; ax <= 7; ax += 1) {
      for (let ay = -7; ay <= 7; ay += 1) {
        const got = line(10, 20, 10 + ax, 20 + ay);
        if (ax === 0 && ay === 0) {
          expect(got).toEqual([]);
          continue;
        }
        lines += 1;
        // |dx| > |dy| strictly for x to lead; a tie goes to y.
        const xMajor = Math.abs(ax) > Math.abs(ay);
        const major = xMajor ? Math.abs(ax) : Math.abs(ay);
        const minor = xMajor ? Math.abs(ay) : Math.abs(ax);
        expect(got).toHaveLength(major);
        expect(got.at(-1)).toEqual({ x: 10 + ax, y: 20 + ay });
        got.forEach((c, i) => {
          const k = i + 1;
          // round(k * minor / major) with a half rounded DOWN, toward the start.
          const offset = Math.max(0, Math.ceil((2 * k * minor - major) / (2 * major)));
          if ((2 * k * minor) % (2 * major) === major) ties += 1;
          const along = k * Math.sign(xMajor ? ax : ay);
          const across = offset * Math.sign(xMajor ? ay : ax);
          expect(c).toEqual(
            xMajor ? { x: 10 + along, y: 20 + across } : { x: 10 + across, y: 20 + along },
          );
        });
      }
    }
    expect(lines).toBe(224);
    // Enough exact halves that rounding them the other way would fail here.
    expect(ties).toBeGreaterThan(50);
  });
});

describe('core.fov.distance — the circle shape', () => {
  it('rounds the Euclidean length half-up', () => {
    expect(fovDistance(0, 0, 3, 4)).toBe(5);
    expect(fovDistance(0, 0, 1, 1)).toBe(1); // 1.41
    expect(fovDistance(0, 0, 2, 2)).toBe(3); // 2.83
    expect(fovDistance(0, 0, 1, 2)).toBe(2); // 2.24
    expect(fovDistance(0, 0, 1.5, 2)).toBe(3); // exactly 2.5, rounded up
    expect(fovDistance(5, 5, 5, 5)).toBe(0);
    expect(fovDistance(7, 1, 4, 5)).toBe(5);
  });

  it('does not truncate its inputs', () => {
    expect(fovDistance(0, 0, 0.3, 0)).toBe(0);
    expect(fovDistance(0, 0, 0.6, 0)).toBe(1);
  });
});

describe('core.fov.circle_grids — no blocking terrain', () => {
  const open = { w: 100, h: 100 };
  const key = (c: { x: number; y: number }) => `${String(c.x)},${String(c.y)}`;

  it('is exactly the offsets with dx^2 + dy^2 <= r^2 + r, which is fovDistance <= r', () => {
    for (let r = 0; r <= 9; r += 1) {
      const got = circleGrids(50, 50, r, open);
      const want: string[] = [];
      for (let dx = -12; dx <= 12; dx += 1) {
        for (let dy = -12; dy <= 12; dy += 1) {
          if (dx * dx + dy * dy <= r * r + r) want.push(`${String(50 + dx)},${String(50 + dy)}`);
          expect(dx * dx + dy * dy <= r * r + r).toBe(fovDistance(0, 0, dx, dy) <= r);
        }
      }
      expect(got.map(key).sort()).toEqual(want.sort());
      expect(new Set(got.map(key)).size).toBe(got.length);
    }
  });

  it('is the whole 3x3 at radius 1 and the 5x5 less its corners at radius 2', () => {
    expect(circleGrids(5, 5, 1, open)).toHaveLength(9);
    const two = circleGrids(5, 5, 2, open).map(key);
    expect(two).toHaveLength(21);
    for (const corner of ['3,3', '7,3', '3,7', '7,7']) expect(two).not.toContain(corner);
  });

  it('truncates the radius, and reaches only the origin under 1', () => {
    expect(circleGrids(5, 5, 2.9, open)).toEqual(circleGrids(5, 5, 2, open));
    for (const r of [0, 0.9, -3]) expect(circleGrids(5, 5, r, open)).toEqual([{ x: 5, y: 5 }]);
  });

  it('skips cells outside the bounds, by size or by test, and always keeps the origin', () => {
    expect(circleGrids(0, 0, 1, { w: 5, h: 5 }).map(key).sort()).toEqual(
      ['0,0', '0,1', '1,0', '1,1'].sort(),
    );
    const leftHalf = (x: number) => x <= 5;
    expect(circleGrids(5, 5, 1, leftHalf).every((c) => c.x <= 5)).toBe(true);
    expect(circleGrids(5, 5, 1, leftHalf)).toHaveLength(6);
    // The Lua adds the origin after the C returns, whatever the bounds say.
    expect(circleGrids(-2, -2, 1, { w: 5, h: 5 })).toEqual([{ x: -2, y: -2 }]);
    // The far edges are exclusive: on a 5x5 map, x = 5 and y = 5 are off it.
    expect(circleGrids(4, 4, 1, { w: 5, h: 5 }).map(key).sort()).toEqual(
      ['3,3', '3,4', '4,3', '4,4'].sort(),
    );
  });

  it('lists x ascending, then y ascending', () => {
    const got = circleGrids(10, 10, 3, open);
    const sorted = [...got].sort((a, b) => a.x - b.x || a.y - b.y);
    expect(got).toEqual(sorted);
  });
});
