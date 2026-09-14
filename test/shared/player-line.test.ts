// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

import { describe, expect, it } from 'vitest';

import { TileCode } from '../../src/shared/protocol.ts';
import { playerLineClear } from '../../src/shared/sight.ts';
import type { LevelView } from '../../src/shared/protocol.ts';

/** A 20x5 open floor. */
function floor(): LevelView {
  return { w: 20, h: 5, tiles: new Array<number>(20 * 5).fill(TileCode.FLOOR) };
}

const FROM = { x: 1, y: 2 };
const onlyAt =
  (...tiles: { x: number; y: number }[]) =>
  (x: number, y: number): boolean =>
    tiles.some((t) => t.x === x && t.y === y);
const along =
  (y: number, x0: number, x1: number) =>
  (x: number, yy: number): boolean =>
    yy === y && x >= x0 && x <= x1;
const nothing = (): boolean => false;

describe("upstream's player line", () => {
  it('reaches a target the player sees across ground they have never seen', () => {
    const to = { x: 6, y: 2 };
    expect(playerLineClear(floor(), FROM, to, 10, onlyAt(FROM, to), nothing)).toBe(true);
  });

  it('does not reach a target the player cannot see across ground they do not know', () => {
    expect(playerLineClear(floor(), FROM, { x: 6, y: 2 }, 10, onlyAt(FROM), nothing)).toBe(false);
  });

  it('reaches an unseen target across ground the player remembers', () => {
    expect(playerLineClear(floor(), FROM, { x: 6, y: 2 }, 10, onlyAt(FROM), along(2, 2, 5))).toBe(
      true,
    );
  });

  it('does not reach it across remembered ground that lies beyond sight', () => {
    // Remembered all the way, but the tiles past 3 are out of sight.
    expect(playerLineClear(floor(), FROM, { x: 8, y: 2 }, 3, onlyAt(FROM), along(2, 2, 7))).toBe(
      false,
    );
  });

  it('is stopped by a remembered wall', () => {
    const level = floor();
    level.tiles[2 * level.w + 3] = TileCode.WALL;
    expect(playerLineClear(level, FROM, { x: 6, y: 2 }, 10, onlyAt(FROM), along(2, 2, 5))).toBe(
      false,
    );
  });
});
