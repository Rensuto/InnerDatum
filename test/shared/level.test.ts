import { describe, expect, it } from 'vitest';

import { TEST_LEVEL_SPAWNS, canWalk, makeTestLevel, tileAt } from '../../src/shared/level.ts';
import { TileCode, isWalkable } from '../../src/shared/protocol.ts';

/**
 * The M1 map is a fixture that three other systems trust blindly: the server's
 * movement rules, the client's renderer, and every movement test in this repo.
 * The invariants below are the ones those systems skip a check because of — a
 * solid border means nothing has to guard the grid edge, and `tileAt` failing
 * closed means nothing downstream ever handles an `undefined` tile.
 */

const level = makeTestLevel();

describe('makeTestLevel', () => {
  it('is a 30x30 grid whose flat tile array matches its dimensions', () => {
    // The array is flat and row-major; if length and w*h ever disagree, every
    // read below the discrepancy silently shifts by a column.
    expect(level.w).toBe(30);
    expect(level.h).toBe(30);
    expect(level.tiles).toHaveLength(level.w * level.h);
  });

  it('is walled the whole way round', () => {
    // This is why no caller bounds-checks before stepping: an actor physically
    // cannot reach a coordinate from which the next step leaves the grid.
    const openEdges: string[] = [];

    const bottom = level.h - 1;
    const right = level.w - 1;

    for (let x = 0; x < level.w; x += 1) {
      if (tileAt(level, x, 0) !== TileCode.WALL) openEdges.push(`top ${x},0`);
      if (tileAt(level, x, bottom) !== TileCode.WALL) openEdges.push(`bottom ${x},${bottom}`);
    }
    for (let y = 0; y < level.h; y += 1) {
      if (tileAt(level, 0, y) !== TileCode.WALL) openEdges.push(`left 0,${y}`);
      if (tileAt(level, right, y) !== TileCode.WALL) openEdges.push(`right ${right},${y}`);
    }

    expect(openEdges).toEqual([]);
  });

  it('has interior walls and interior floor, so collision has something to hit', () => {
    // A map that is all floor inside the border would pass every other test in
    // this file and prove nothing about walls blocking movement.
    let interiorWalls = 0;
    let interiorFloor = 0;

    for (let y = 1; y < level.h - 1; y += 1) {
      for (let x = 1; x < level.w - 1; x += 1) {
        if (tileAt(level, x, y) === TileCode.WALL) interiorWalls += 1;
        else interiorFloor += 1;
      }
    }

    expect(interiorWalls).toBeGreaterThan(0);
    expect(interiorFloor).toBeGreaterThan(0);
  });

  it('contains only tile codes this build recognises', () => {
    // An unrecognised code is not a rendering glitch: `isWalkable` fails closed
    // on it, so a stray value turns a room into solid rock for everyone.
    const codes = new Set(level.tiles);
    expect([...codes].sort((a, b) => a - b)).toEqual([TileCode.FLOOR, TileCode.WALL]);
  });

  it('hands out an independent tile array on every call', () => {
    // The server owns its level and M4 will dig doors into it. A shared array
    // would leak one session's edits into another's map.
    const a = makeTestLevel();
    const b = makeTestLevel();
    expect(a.tiles).not.toBe(b.tiles);

    a.tiles[0] = TileCode.FLOOR;
    expect(b.tiles[0]).toBe(TileCode.WALL);
    expect(makeTestLevel().tiles[0]).toBe(TileCode.WALL);
  });
});

describe('tileAt', () => {
  it('reports solid rock past every edge of the map', () => {
    // Fail-closed off-grid is the invariant that lets FOV, A* and the
    // eight-neighbour walk probe freely without a bounds check apiece.
    expect(tileAt(level, -1, 5)).toBe(TileCode.WALL);
    expect(tileAt(level, level.w, 5)).toBe(TileCode.WALL);
    expect(tileAt(level, 5, -1)).toBe(TileCode.WALL);
    expect(tileAt(level, 5, level.h)).toBe(TileCode.WALL);

    expect(tileAt(level, -999, -999)).toBe(TileCode.WALL);
    expect(tileAt(level, 9999, 9999)).toBe(TileCode.WALL);
  });

  it('never returns undefined, whatever coordinate it is handed', () => {
    // The reason the return type is TileCode and not TileCode | undefined.
    // A fractional or non-finite coordinate misses the flat array entirely, and
    // the answer still has to be a tile.
    expect(tileAt(level, 1.5, 1.5)).toBe(TileCode.WALL);
    expect(tileAt(level, Number.NaN, 4)).toBe(TileCode.WALL);
    expect(tileAt(level, 4, Number.POSITIVE_INFINITY)).toBe(TileCode.WALL);
  });

  it('reads row-major, so x and y are not transposed', () => {
    // The map is square and its border is symmetric, so a transposed read still
    // returns a plausible-looking map — which is precisely why this needs an
    // assertion rather than a glance at the ASCII. The expectation below indexes
    // `y * w + x` by hand, independently of tileIndex.
    const mismatches: string[] = [];

    for (let y = 0; y < level.h; y += 1) {
      for (let x = 0; x < level.w; x += 1) {
        const raw = level.tiles[y * level.w + x];
        const expected = raw === TileCode.FLOOR ? TileCode.FLOOR : TileCode.WALL;
        if (tileAt(level, x, y) !== expected) mismatches.push(`${x},${y}`);
      }
    }

    expect(mismatches).toEqual([]);

    // A concrete asymmetric pair, so a swap of the axes fails loudly and here
    // rather than as a wall the player can walk through three systems away.
    expect(tileAt(level, 5, 4)).toBe(TileCode.WALL);
    expect(tileAt(level, 4, 5)).toBe(TileCode.FLOOR);
  });
});

describe('canWalk', () => {
  it('agrees with tileAt and isWalkable on every coordinate, on-grid and off', () => {
    // Terrain walkability has exactly one definition. If these three ever
    // disagree, the client paints a floor the server treats as rock and the
    // player's token snaps back on every keypress.
    const disagreements: string[] = [];

    for (let y = -2; y <= level.h + 1; y += 1) {
      for (let x = -2; x <= level.w + 1; x += 1) {
        if (canWalk(level, x, y) !== isWalkable(tileAt(level, x, y))) {
          disagreements.push(`${x},${y}`);
        }
      }
    }

    expect(disagreements).toEqual([]);
    expect(canWalk(level, 0, 0)).toBe(false);
    expect(canWalk(level, -1, -1)).toBe(false);
  });

  it('treats floor as walkable and wall as not', () => {
    expect(isWalkable(TileCode.FLOOR)).toBe(true);
    expect(isWalkable(TileCode.WALL)).toBe(false);
    // An unknown code means a client older than the map it was sent. Walking
    // into unknown terrain is the worse of the two failures.
    expect(isWalkable(99)).toBe(false);
  });
});

describe('TEST_LEVEL_SPAWNS', () => {
  it('names distinct, in-bounds, walkable start tiles', () => {
    // world.ts hands these out without re-checking them. A spawn authored inside
    // a wall would put a player somewhere they can never move out of.
    expect(TEST_LEVEL_SPAWNS.length).toBeGreaterThan(0);

    const seen = new Set<string>();
    const bad: string[] = [];
    for (const spawn of TEST_LEVEL_SPAWNS) {
      if (!canWalk(level, spawn.x, spawn.y)) bad.push(`${spawn.x},${spawn.y} is not walkable`);
      seen.add(`${spawn.x},${spawn.y}`);
    }

    expect(bad).toEqual([]);
    expect(seen.size).toBe(TEST_LEVEL_SPAWNS.length);
  });
});
