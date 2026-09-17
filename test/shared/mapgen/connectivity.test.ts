// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// The rule under test is t-engine4 game/engines/default/engine/Astar.lua:113-193 read as reachability.
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

import { describe, expect, it } from 'vitest';

import { passable, reachable, reachableSet } from '../../../src/shared/mapgen/connectivity.ts';
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
