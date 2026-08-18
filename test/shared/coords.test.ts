import { describe, expect, it } from 'vitest';

import {
  bearingWord,
  DIR_ORDER,
  DIR_VECTORS,
  bresenham,
  chebyshev,
  dirVector,
  inBounds,
  manhattan,
  sameTile,
  step,
  tileIndex,
} from '../../src/shared/coords.ts';
import type { TileXY } from '../../src/shared/coords.ts';

/**
 * Tile geometry is shared by the server's turn loop, the client's renderer and
 * (later) the replay harness. A bug here is not a crash — it is the server and
 * the client disagreeing about which tiles a bolt passed through, or an archer
 * who can shoot through a corner you cannot shoot back through. All of that is
 * silent until somebody notices the game is subtly unfair.
 */

/** Stable string form of a tile, so a whole path compares in one assertion. */
function key(tile: TileXY | undefined): string {
  return tile === undefined ? 'none' : `${tile.x},${tile.y}`;
}

function pathKey(tiles: readonly TileXY[]): string {
  return tiles.map((tile) => key(tile)).join(' ');
}

/** Every tile in a 7x7 block around the origin — all eight octants, plus the
 *  horizontal, vertical, diagonal and zero-length degenerate cases. */
const SWEEP_TILES: TileXY[] = [];
for (let x = -3; x <= 3; x += 1) {
  for (let y = -3; y <= 3; y += 1) {
    SWEEP_TILES.push({ x, y });
  }
}

describe('directions', () => {
  it('lists all eight directions once, clockwise from north', () => {
    expect(DIR_ORDER).toHaveLength(8);
    expect(new Set(DIR_ORDER).size).toBe(8);
    expect(Object.keys(DIR_VECTORS).sort()).toEqual([...DIR_ORDER].sort());
  });

  it('gives every direction a distinct unit step', () => {
    // "Unit" in the roguelike metric: a diagonal is one step, not 1.41 steps.
    // A vector with a component of 2 would let a keypress skip a tile — and skip
    // the wall check on the tile it skipped.
    const origin: TileXY = { x: 0, y: 0 };
    const vectors = new Set<string>();

    for (const dir of DIR_ORDER) {
      const v = dirVector(dir);
      expect([-1, 0, 1]).toContain(v.dx);
      expect([-1, 0, 1]).toContain(v.dy);
      expect(chebyshev(origin, { x: v.dx, y: v.dy })).toBe(1);
      vectors.add(`${v.dx},${v.dy}`);
    }

    expect(vectors.size).toBe(8);
  });

  it('pairs each direction with its exact opposite four places along', () => {
    // DIR_ORDER is the row order of every directional sprite sheet, so this is
    // what makes `sheetRow = DIR_ORDER.indexOf(dir)` the entire facing lookup.
    // Reordering the list to something that is not clockwise breaks the art, not
    // the code, which is the hardest kind of break to trace.
    expect(DIR_ORDER.length % 2).toBe(0);

    for (let i = 0; i < DIR_ORDER.length; i += 1) {
      const dir = DIR_ORDER[i];
      const opposite = DIR_ORDER[(i + 4) % DIR_ORDER.length];
      if (dir === undefined || opposite === undefined) continue;
      const a = dirVector(dir);
      const b = dirVector(opposite);
      expect({ dx: a.dx + b.dx, dy: a.dy + b.dy }).toEqual({ dx: 0, dy: 0 });
    }
  });

  it('applies exactly the direction vector when stepping, and +y is south', () => {
    const from: TileXY = { x: 10, y: 10 };
    for (const dir of DIR_ORDER) {
      const v = dirVector(dir);
      expect(step(from, dir)).toEqual({ x: from.x + v.dx, y: from.y + v.dy });
    }
    // Screen order, not maths order: the canvas, the flat tile array and every
    // sprite sheet are row-major top-down, so north must DECREASE y.
    expect(step(from, 'n').y).toBeLessThan(from.y);
    expect(step(from, 's').y).toBeGreaterThan(from.y);
    expect(sameTile(step(step(from, 'n'), 's'), from)).toBe(true);
  });
});

describe('distance metrics', () => {
  it('counts a diagonal as one step in chebyshev and two in manhattan', () => {
    // This is the difference that decides what "adjacent" and "in range" mean.
    // Using manhattan for range makes a diagonal neighbour cost two, so a melee
    // talent silently stops reaching the monster standing in the corner.
    for (const n of [1, 2, 3, 7]) {
      const a: TileXY = { x: 0, y: 0 };
      const b: TileXY = { x: n, y: n };
      expect(chebyshev(a, b)).toBe(n);
      expect(manhattan(a, b)).toBe(2 * n);
    }
  });

  it('agrees on orthogonal offsets and on the same tile', () => {
    const origin: TileXY = { x: 4, y: 9 };
    expect(chebyshev(origin, { x: 4 + 5, y: 9 })).toBe(5);
    expect(manhattan(origin, { x: 4 + 5, y: 9 })).toBe(5);
    expect(chebyshev(origin, origin)).toBe(0);
    expect(manhattan(origin, origin)).toBe(0);
  });

  it('takes the longer axis for chebyshev and the sum for manhattan', () => {
    const a: TileXY = { x: 0, y: 0 };
    const b: TileXY = { x: 3, y: -1 };
    expect(chebyshev(a, b)).toBe(3);
    expect(manhattan(a, b)).toBe(4);
    // Both metrics are symmetric — half of "can A see B" depends on it.
    expect(chebyshev(b, a)).toBe(chebyshev(a, b));
    expect(manhattan(b, a)).toBe(manhattan(a, b));
  });
});

describe('grid indexing', () => {
  it('bounds-checks by range only, so off-grid probes are a normal answer', () => {
    expect(inBounds(0, 0, 30, 30)).toBe(true);
    expect(inBounds(29, 29, 30, 30)).toBe(true);
    expect(inBounds(-1, 0, 30, 30)).toBe(false);
    expect(inBounds(0, -1, 30, 30)).toBe(false);
    expect(inBounds(30, 0, 30, 30)).toBe(false);
    expect(inBounds(0, 30, 30, 30)).toBe(false);
  });

  it('indexes row-major, matching the flat tiles array on the wire', () => {
    // Transposing this (x * h + y) still produces plausible-looking maps, which
    // is why it needs an assertion rather than a reading.
    expect(tileIndex(0, 0, 30)).toBe(0);
    expect(tileIndex(1, 0, 30)).toBe(1);
    expect(tileIndex(0, 1, 30)).toBe(30);
    expect(tileIndex(5, 3, 30)).toBe(95);
  });
});

describe('bresenham', () => {
  it('returns a straight horizontal run, both endpoints included', () => {
    expect(bresenham({ x: 2, y: 2 }, { x: 7, y: 2 })).toEqual([
      { x: 2, y: 2 },
      { x: 3, y: 2 },
      { x: 4, y: 2 },
      { x: 5, y: 2 },
      { x: 6, y: 2 },
      { x: 7, y: 2 },
    ]);
  });

  it('returns a pure diagonal one tile at a time', () => {
    expect(bresenham({ x: 0, y: 0 }, { x: 4, y: 4 })).toEqual([
      { x: 0, y: 0 },
      { x: 1, y: 1 },
      { x: 2, y: 2 },
      { x: 3, y: 3 },
      { x: 4, y: 4 },
    ]);
  });

  it('walks a shallow slope without doubling back or skipping a column', () => {
    // Which tiles a shallow line picks is the algorithm's business; what is NOT
    // negotiable is that it advances one column at a time, stays inside the
    // corridor between the endpoints, and is as short as the metric allows.
    const from: TileXY = { x: 0, y: 0 };
    const to: TileXY = { x: 6, y: 2 };
    const path = bresenham(from, to);

    expect(path).toHaveLength(chebyshev(from, to) + 1);
    expect(key(path[0])).toBe(key(from));
    expect(key(path[path.length - 1])).toBe(key(to));
    expect(path.map((tile) => tile.x)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(path.every((tile) => tile.y >= from.y && tile.y <= to.y)).toBe(true);
  });

  it('returns the single tile for a zero-length line', () => {
    expect(bresenham({ x: 3, y: 3 }, { x: 3, y: 3 })).toEqual([{ x: 3, y: 3 }]);
  });

  it('returns an empty path for a non-finite endpoint rather than spinning', () => {
    // This runs inside a synchronous turn resolution, where a non-terminating
    // loop is not a slow frame — it is a wedged server process with every
    // player's socket still open.
    expect(bresenham({ x: Number.NaN, y: 0 }, { x: 3, y: 3 })).toEqual([]);
    expect(bresenham({ x: 0, y: 0 }, { x: Number.POSITIVE_INFINITY, y: 3 })).toEqual([]);
  });

  it('is contiguous, minimal and exactly reversible between any two tiles', () => {
    // Swept over all eight octants at once. Violations are collected rather than
    // asserted in the loop so a failure names every offending pair instead of
    // stopping at the first.
    //
    // The reversibility half is the one that matters most: raw Bresenham breaks
    // error ties in favour of whichever end it started from, which is the oldest
    // roguelike bug report there is — the archer shoots you through a corner you
    // cannot shoot back through. Mutual line of sight here is structural, not a
    // remembered double-check at each call site.
    const violations: string[] = [];

    for (const from of SWEEP_TILES) {
      for (const to of SWEEP_TILES) {
        const label = `${key(from)} -> ${key(to)}`;
        const path = bresenham(from, to);

        if (key(path[0]) !== key(from)) violations.push(`${label}: does not start at from`);
        if (key(path[path.length - 1]) !== key(to)) violations.push(`${label}: does not end at to`);
        if (path.length !== chebyshev(from, to) + 1) {
          violations.push(`${label}: length ${path.length}, expected ${chebyshev(from, to) + 1}`);
        }
        if (pathKey(path) !== pathKey([...bresenham(to, from)].reverse())) {
          violations.push(`${label}: not the exact reverse of the opposite walk`);
        }

        let previous: TileXY | undefined;
        for (const tile of path) {
          if (previous !== undefined && chebyshev(previous, tile) !== 1) {
            violations.push(`${label}: ${key(previous)} to ${key(tile)} is not one step`);
          }
          previous = tile;
        }
      }
    }

    expect(violations).toEqual([]);
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *   WHICH WAY IS THE TOWN. THE ANSWER A PLAYER WALKS ON.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * This is read once, in a sentence, and then somebody walks for forty tiles on
 * it. Getting it subtly wrong is worse than not saying it: a player who walks
 * north-east when the honest answer was east is wrong for the whole journey and
 * blames the map.
 */
describe('bearingWord', () => {
  it('names the four cardinals, with north being screen-up', () => {
    // `dy` is screen-down everywhere in this file, so north is NEGATIVE — the
    // one sign error that would send every player in the game backwards.
    expect(bearingWord(0, -5)).toBe('north');
    expect(bearingWord(0, 5)).toBe('south');
    expect(bearingWord(5, 0)).toBe('east');
    expect(bearingWord(-5, 0)).toBe('west');
  });

  it('names a diagonal only when the two axes are comparable', () => {
    expect(bearingWord(10, -10)).toBe('north-east');
    expect(bearingWord(-8, 8)).toBe('south-west');
    expect(bearingWord(-10, -12)).toBe('north-west');
  });

  it('COLLAPSES TO A CARDINAL when one axis dominates — the whole point', () => {
    // Forty east and four north is EAST. The naive version returns a diagonal
    // whenever both offsets are non-zero, and somebody walking north-east from
    // here is wrong for almost the entire journey.
    expect(bearingWord(40, -4)).toBe('east');
    expect(bearingWord(-40, 4)).toBe('west');
    expect(bearingWord(4, -40)).toBe('north');
    expect(bearingWord(-4, 40)).toBe('south');
  });

  it('holds the boundary at exactly twice, so the rule has one reading', () => {
    // 2:1 is still a diagonal; past 2:1 it is not. Stated as a test because
    // "more than twice" and "at least twice" are one character apart in the
    // source and produce different words for a real distance.
    expect(bearingWord(20, -10)).toBe('north-east');
    expect(bearingWord(21, -10)).toBe('east');
  });

  it('says `here` for no offset rather than an empty string', () => {
    // An empty string would render as `Alderbrook — , 0 tiles`, which looks
    // like a bug in the sentence rather than a place you are standing on.
    expect(bearingWord(0, 0)).toBe('here');
  });
});
