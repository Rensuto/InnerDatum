// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// The tables under test are ported from t-engine4 game/engines/default/engine/utils.lua:1592-1944.
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

import { describe, expect, it } from 'vitest';

import {
  PRIMARY_DIRS,
  adjacentCoords,
  coordToDir,
  dirSides,
  dirToCoord,
  opposedDir,
} from '../../../src/shared/mapgen/dirs.ts';
import type { KeypadDir } from '../../../src/shared/mapgen/dirs.ts';

const ALL: readonly KeypadDir[] = [1, 2, 3, 4, 5, 6, 7, 8, 9];

describe('keypad directions', () => {
  it('lay the keypad over the screen: 7 8 9 on top, +y south', () => {
    expect(ALL.map((d) => dirToCoord(d))).toEqual([
      [-1, 1],
      [0, 1],
      [1, 1],
      [-1, 0],
      [0, 0],
      [1, 0],
      [-1, -1],
      [0, -1],
      [1, -1],
    ]);
  });

  it('coordToDir inverts dirToCoord for all nine, and refuses a non-unit step', () => {
    for (const d of ALL) {
      const [dx, dy] = dirToCoord(d);
      expect(coordToDir(dx, dy)).toBe(d);
    }
    expect(() => coordToDir(2, 0)).toThrow(RangeError);
  });

  it('opposes every direction through the centre', () => {
    for (const d of ALL) {
      const [dx, dy] = dirToCoord(d);
      const [ox, oy] = dirToCoord(opposedDir(d));
      expect([ox + dx, oy + dy]).toEqual([0, 0]);
    }
  });

  it('lists the primary directions in upstream order', () => {
    expect(PRIMARY_DIRS).toEqual([2, 4, 6, 8]);
  });
});

describe('dirSides', () => {
  it('is upstream`s table for the four headings a tunnel or door uses', () => {
    // engine/utils.lua:1624-1630, verbatim.
    expect(dirSides(2)).toEqual({ hardLeft: 6, left: 3, right: 1, hardRight: 4 });
    expect(dirSides(4)).toEqual({ hardLeft: 2, left: 1, right: 7, hardRight: 8 });
    expect(dirSides(6)).toEqual({ hardLeft: 8, left: 9, right: 3, hardRight: 2 });
    expect(dirSides(8)).toEqual({ hardLeft: 4, left: 7, right: 9, hardRight: 6 });
  });

  it('puts left and right 45 degrees off the heading, left on the left hand, hard sides at 90', () => {
    // Against a unit step, a dot product of 1 is 45 degrees and 0 a right
    // angle. The cross product's sign says which hand: with +y south, the left
    // hand is the negative side (facing north, left is west).
    for (const d of ALL.filter((dir) => dir !== 5)) {
      const [hx, hy] = dirToCoord(d);
      const dot = (other: KeypadDir): number => {
        const [x, y] = dirToCoord(other);
        // `+ 0` folds the -0 a zero product can make into 0.
        return x * hx + y * hy + 0;
      };
      const cross = (other: KeypadDir): number => {
        const [x, y] = dirToCoord(other);
        return Math.sign(hx * y - hy * x);
      };
      const s = dirSides(d);
      expect([dot(s.left), dot(s.right), dot(s.hardLeft), dot(s.hardRight)]).toEqual([1, 1, 0, 0]);
      expect([cross(s.left), cross(s.hardLeft), cross(s.right), cross(s.hardRight)]).toEqual([
        -1, -1, 1, 1,
      ]);
      expect(s.hardLeft).toBe(opposedDir(s.hardRight));
    }
  });
});

describe('adjacentCoords', () => {
  it('gives the eight neighbours, keyed by the direction that reaches them, no centre', () => {
    const around = adjacentCoords(10, 20);
    expect(around).toHaveLength(8);
    expect(around.map((n) => n.dir)).toEqual([6, 4, 2, 8, 3, 9, 1, 7]);
    for (const n of around) {
      const [dx, dy] = dirToCoord(n.dir);
      expect([n.x, n.y]).toEqual([10 + dx, 20 + dy]);
    }
  });

  it('does no bounds check', () => {
    expect(adjacentCoords(0, 0).some((n) => n.x < 0 && n.y < 0)).toBe(true);
  });
});
