// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// The rule under test is t-engine4 game/engines/default/engine/Astar.lua:113-193 read as reachability.
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

import { describe, expect, it } from 'vitest';

import type { AuthoredMap } from '../../../src/shared/level.ts';
import {
  passable,
  reachable,
  reachableSet,
  sealUnreachable,
  sealedShare,
} from '../../../src/shared/mapgen/connectivity.ts';
import { TileCode } from '../../../src/shared/protocol.ts';

/** `#` wall, `.` floor, `+` shut door, `~` nil terrain. */
function grid(rows: readonly string[]): { w: number; h: number; tiles: number[] } {
  const code: Record<string, number> = {
    '#': TileCode.WALL,
    '.': TileCode.FLOOR,
    '+': TileCode.DOOR,
    '~': -1,
  };
  return {
    w: rows[0]?.length ?? 0,
    h: rows.length,
    tiles: rows.flatMap((row) => [...row].map((c) => code[c] ?? TileCode.WALL)),
  };
}

describe('reachable — upstream`s A* as a yes or no', () => {
  it('goes diagonally: two cells touching only at a corner are joined', () => {
    const g = grid(['.#', '#.']);
    expect(reachable(g, { x: 0, y: 0 }, { x: 1, y: 1 })).toBe(true);
  });

  it('routes through a shut door, as the door-opening player does', () => {
    const g = grid(['.+.']);
    expect(reachable(g, { x: 0, y: 0 }, { x: 2, y: 0 })).toBe(true);
    expect(passable(TileCode.DOOR)).toBe(true);
  });

  it('refuses a wall between, and a target that is itself a wall', () => {
    expect(reachable(grid(['.#.']), { x: 0, y: 0 }, { x: 2, y: 0 })).toBe(false);
    // Adjacent, and still refused: the target must be passable.
    expect(reachable(grid(['.#']), { x: 0, y: 0 }, { x: 1, y: 0 })).toBe(false);
    // Even when it is also the start, which is the one cell a flood marks unasked.
    expect(reachable(grid(['#']), { x: 0, y: 0 }, { x: 0, y: 0 })).toBe(false);
  });

  it('never tests the start, so a spot on a wall still reaches open ground', () => {
    const g = grid(['#.', '..']);
    expect(reachable(g, { x: 0, y: 0 }, { x: 1, y: 1 })).toBe(true);
  });

  it('treats nil terrain as the wall it will ship as', () => {
    expect(reachable(grid(['.~.']), { x: 0, y: 0 }, { x: 2, y: 0 })).toBe(false);
    expect(passable(-1)).toBe(false);
  });

  it('refuses a target off the map', () => {
    expect(reachable(grid(['..']), { x: 0, y: 0 }, { x: 2, y: 0 })).toBe(false);
  });
});

describe('reachableSet', () => {
  it('marks the start and exactly the 8-connected passable region around it', () => {
    const g = grid(['#..#.', '#.###', '..#.#']);
    const seen = reachableSet(g, { x: 0, y: 0 });
    // Start marked though it is a wall; (4,0) and (3,2) are walled off.
    const marked = [...seen].flatMap((v, i) => (v === 1 ? [i] : []));
    expect(marked).toEqual([0, 1, 2, 6, 10, 11]);
  });
});

/** `rows` as a level whose up stair is `up`. */
function level(rows: readonly string[], up?: { x: number; y: number }): AuthoredMap {
  const g = grid(rows);
  return {
    view: { w: g.w, h: g.h, tiles: g.tiles },
    spawns: up === undefined ? [] : [up],
    sites: new Map(),
  };
}

describe('sealUnreachable — our rule, not upstream`s', () => {
  it('makes every floor and door its up stair cannot reach the wall, and nothing else', () => {
    // The right-hand room, door and all, is cut off by the wall column; nil stays nil.
    const map = level(['..#.+', '.+#..', '..#~.'], { x: 0, y: 0 });
    const { FLOOR: F, DOOR: D, WALL: W, CRAG: C } = TileCode;
    expect(sealUnreachable(map, C).view.tiles).toEqual([
      ...[F, F, W, C, C],
      ...[F, D, W, C, C],
      ...[F, F, W, -1, C],
    ]);
  });

  it('leaves a level with no up stair as it is', () => {
    const map = level(['.#.']);
    expect(sealUnreachable(map, TileCode.CRAG)).toBe(map);
  });
});

describe('sealedShare', () => {
  it('is the share of floor and doors the seal would take', () => {
    // Six passable cells, the two beyond the wall column cut off: a third.
    expect(sealedShare(level(['..#.', '.+#+'], { x: 0, y: 0 }))).toBeCloseTo(2 / 6, 12);
    expect(sealedShare(level(['...', '.+.'], { x: 0, y: 0 }))).toBe(0);
    // An up stair on a wall still reaches the ground beside it, and none past a wall.
    expect(sealedShare(level(['#.', '..'], { x: 0, y: 0 }))).toBe(0);
    expect(sealedShare(level(['##.'], { x: 0, y: 0 }))).toBe(1);
  });

  it('is 0 for a level with no up stair or no ground', () => {
    expect(sealedShare(level(['.#.']))).toBe(0);
    expect(sealedShare(level(['###'], { x: 0, y: 0 }))).toBe(0);
  });
});
