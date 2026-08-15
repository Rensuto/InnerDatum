import { describe, expect, it } from 'vitest';

import { chebyshev } from '../../src/shared/coords.ts';
import { canWalk, makeTestLevel } from '../../src/shared/level.ts';
import { PathHeuristic, findPath } from '../../src/shared/path.ts';
import type { TileXY } from '../../src/shared/coords.ts';
import type { PassableFn } from '../../src/shared/path.ts';

/**
 * A*, ported from Astar.lua:43-193.
 *
 * Two things about the CONTRACT are easy to get wrong and expensive to discover
 * late, so both are pinned here rather than assumed:
 *
 *   1. THE RETURNED PATH EXCLUDES THE START AND INCLUDES THE TARGET
 *      (Astar.lua:90-100), so `path[0]` is the very next step and
 *      `path.length === chebyshev(from, to)` over open ground. Counting the
 *      start tile as well gives the familiar "chebyshev + 1 tiles walked".
 *      A caller that slices off path[0] "because the first tile is where I am"
 *      makes every monster in the game one step slower, silently.
 *
 *   2. `[]` AND `null` ARE DIFFERENT ANSWERS. `[]` is "you have arrived",
 *      `null` is "there is no route, or I gave up". ToME returns nil for both
 *      (Astar.lua:91); we do not, because a chasing monster acts differently on
 *      each and conflating them makes it attack the tile it is standing on.
 *
 * DETERMINISM is the third: the server is authoritative and every client renders
 * what it is told, so a monster that takes a different route on a replay means a
 * save that loads into a different fight.
 */

const LEVEL = makeTestLevel();

/** Terrain-only passability, exactly what the AI hands A* — see path.ts's header. */
const walkable: PassableFn = (x, y) => canWalk(LEVEL, x, y);

/** A passability predicate over a hand-drawn map. `.` walks, anything else does not. */
function gridPassable(rows: readonly string[]): PassableFn {
  return (x, y) => {
    const row = rows[y];
    if (row === undefined || x < 0 || x >= row.length) return false;
    return row.charAt(x) === '.';
  };
}

/**
 * Every structural property a returned path must have, asserted in one place:
 * it starts one step from `from`, ends exactly on `to`, every tile is passable,
 * and every consecutive pair is one chebyshev step apart. A route that teleports
 * over a wall fails here rather than in whatever the caller does with it.
 */
function expectWalkable(
  path: readonly TileXY[],
  from: TileXY,
  to: TileXY,
  isPassable: PassableFn,
): void {
  expect(path.length).toBeGreaterThan(0);
  expect(path[path.length - 1]).toEqual(to);

  let previous = from;
  for (const tile of path) {
    expect({ tile, step: chebyshev(previous, tile) }).toEqual({ tile, step: 1 });
    expect({ tile, passable: isPassable(tile.x, tile.y) }).toEqual({ tile, passable: true });
    previous = tile;
  }
}

describe('findPath over open ground', () => {
  it('walks a straight line whose length is the chebyshev distance', () => {
    // Row 17 of the test map is unobstructed floor from x=1 to x=28, so the
    // shortest route is the straight one and nothing about the heuristic can
    // make it longer.
    const from: TileXY = { x: 2, y: 17 };
    const to: TileXY = { x: 12, y: 17 };
    const path = findPath(from, to, walkable);
    if (path === null) throw new Error('expected a path across the open row');

    expect(path).toHaveLength(chebyshev(from, to));
    // The same fact stated the other way round: counting the tile you are
    // standing on, the walk is chebyshev + 1 tiles long.
    expect([from, ...path]).toHaveLength(chebyshev(from, to) + 1);
    expectWalkable(path, from, to, walkable);

    // `path[0]` is the NEXT STEP, not the current tile. Callers depend on this.
    expect(path[0]).toEqual({ x: 3, y: 17 });
  });

  it('counts a diagonal as one step, exactly like an orthogonal one', () => {
    // Astar.lua:135 uses a uniform cost of 1 including diagonals, which is why
    // chebyshev is the right metric here and manhattan is not. A six-by-six
    // diagonal is six steps, not twelve.
    const from: TileXY = { x: 2, y: 16 };
    const to: TileXY = { x: 8, y: 22 };
    const path = findPath(from, to, walkable);
    if (path === null) throw new Error('expected a diagonal path');

    expect(path).toHaveLength(6);
    expect(path).toHaveLength(chebyshev(from, to));
    expectWalkable(path, from, to, walkable);
  });

  it('answers "already there" with an empty path, never with null', () => {
    // The distinction ToME does not draw (Astar.lua:91). A monster that reads
    // `[]` as "unreachable" freezes on top of its own target.
    const here: TileXY = { x: 2, y: 17 };
    expect(findPath(here, here, walkable)).toEqual([]);
    expect(findPath(here, here, walkable)).not.toBeNull();
  });

  it('restricts itself to n/e/s/w when diagonals are forbidden', () => {
    const from: TileXY = { x: 2, y: 17 };
    const to: TileXY = { x: 6, y: 21 };
    const path = findPath(from, to, walkable, { allowDiagonals: false });
    if (path === null) throw new Error('expected an orthogonal path');

    expect(path).toHaveLength(8);
    for (let i = 0; i < path.length; i += 1) {
      const previous = i === 0 ? from : path[i - 1];
      const tile = path[i];
      if (previous === undefined || tile === undefined) throw new Error('ragged path');
      // Exactly one axis moves per step.
      expect(Math.abs(tile.x - previous.x) + Math.abs(tile.y - previous.y)).toBe(1);
    }
  });
});

describe('findPath around obstacles', () => {
  it('routes around a solid block rather than through it', () => {
    // The 4x4 block at rows 4-7, columns 5-8. A straight line from (4,5) to
    // (9,6) crosses it, so a correct path is strictly longer than the chebyshev
    // distance and every tile on it is floor.
    const from: TileXY = { x: 4, y: 5 };
    const to: TileXY = { x: 9, y: 6 };
    const path = findPath(from, to, walkable);
    if (path === null) throw new Error('expected a route around the block');

    expect(path.length).toBeGreaterThan(chebyshev(from, to));
    // ...but still a route a person would take, not a tour of the level.
    expect(path.length).toBeLessThanOrEqual(2 * chebyshev(from, to));
    expectWalkable(path, from, to, walkable);

    // Named explicitly: the detour exists because the direct line is blocked.
    expect(walkable(6, 5)).toBe(false);
    expect(path.some((tile) => tile.x >= 5 && tile.x <= 8 && tile.y >= 4 && tile.y <= 7)).toBe(
      false,
    );
  });

  it('walks the doorway into a walled room instead of stepping over the wall', () => {
    // Rows 9-15 enclose a room whose only opening is the two-tile doorway in row
    // 15. "Walk around the wall to get in" has to be a real path, not a straight
    // line, or the map's whole point is lost.
    const from: TileXY = { x: 5, y: 17 };
    const to: TileXY = { x: 15, y: 11 };
    const path = findPath(from, to, walkable);
    if (path === null) throw new Error('expected a route through the doorway');

    expectWalkable(path, from, to, walkable);
    expect(path.length).toBeGreaterThan(chebyshev(from, to));
  });

  it('refuses an impassable destination up front', () => {
    // Astar.lua:150-153 rejects a blocked target before searching at all, which
    // is what stops a monster spending its whole node budget proving it cannot
    // stand inside a wall.
    expect(findPath({ x: 2, y: 17 }, { x: 0, y: 0 }, walkable)).toBeNull();

    // ...unless the caller says the goal is the thing it wants to reach, which
    // is the "walk up to the closed door" case. The ROUTE still obeys terrain.
    const from: TileXY = { x: 2, y: 17 };
    const to: TileXY = { x: 0, y: 17 };
    const path = findPath(from, to, walkable, { allowBlockedTarget: true });
    if (path === null) throw new Error('expected a path up to the blocked goal');
    expect(path[path.length - 1]).toEqual(to);
    expect(path.slice(0, -1).every((tile) => walkable(tile.x, tile.y))).toBe(true);
  });
});

describe('findPath failure modes', () => {
  it('returns null for an unreachable target instead of searching forever', () => {
    // Two sealed halves. The open set empties and A* answers null — the property
    // that matters is that it RETURNS, because this runs inside a synchronous
    // turn resolution where a non-terminating loop is a server that never
    // answers again, not a dropped frame.
    const sealed = gridPassable([
      '#########',
      '#...#...#',
      '#...#...#',
      '#...#...#',
      '#...#...#',
      '#...#...#',
      '#########',
    ]);

    expect(sealed(1, 3)).toBe(true);
    expect(sealed(7, 3)).toBe(true);
    expect(findPath({ x: 1, y: 3 }, { x: 7, y: 3 }, sealed)).toBeNull();
    // The reachable half still works, so the null above is about connectivity
    // and not about the predicate being broken.
    expect(findPath({ x: 1, y: 1 }, { x: 3, y: 5 }, sealed)).toHaveLength(4);
  });

  it('gives up when maxNodes runs out rather than exploring the whole level', () => {
    // Bounded on purpose. An unreachable target on a large map must cost a
    // wasted millisecond, never a wedged process.
    const from: TileXY = { x: 2, y: 17 };
    const to: TileXY = { x: 27, y: 3 };

    expect(findPath(from, to, walkable, { maxNodes: 5 })).toBeNull();
    expect(findPath(from, to, walkable, { maxNodes: 20 })).toBeNull();

    // The positive control: the identical query with the default budget
    // succeeds, so the nulls above are the budget talking and not an unroutable
    // map.
    const found = findPath(from, to, walkable);
    if (found === null) throw new Error('expected the unbudgeted query to succeed');
    expectWalkable(found, from, to, walkable);
    expect(found.length).toBeGreaterThanOrEqual(chebyshev(from, to));

    expect(() => findPath(from, to, walkable, { maxNodes: 0 })).toThrow(RangeError);
  });

  it('fails closed on coordinates that are not addressable', () => {
    expect(findPath({ x: 2, y: 17 }, { x: Number.NaN, y: 3 }, walkable)).toBeNull();
    expect(findPath({ x: 2, y: 17 }, { x: 1e9, y: 3 }, walkable)).toBeNull();
  });
});

describe('findPath determinism', () => {
  it('returns the identical path for the identical query, every time', () => {
    // The pop order of the open set is a strict total order — (f, then h, then
    // the (y,x) node key) — so it cannot depend on insertion order, and no Map
    // or Set in path.ts is ever iterated. If either of those ever stops being
    // true this is where it shows up.
    const from: TileXY = { x: 2, y: 17 };
    const to: TileXY = { x: 27, y: 3 };

    const first = findPath(from, to, walkable);
    if (first === null) throw new Error('expected a path across the level');

    for (let attempt = 0; attempt < 8; attempt += 1) {
      expect(findPath(from, to, walkable)).toEqual(first);
    }
  });

  it('stays deterministic under every option combination, and the options matter', () => {
    const from: TileXY = { x: 3, y: 17 };
    const to: TileXY = { x: 20, y: 8 };

    const closer = findPath(from, to, walkable, { heuristic: PathHeuristic.CloserPath });
    const chebyshevRoute = findPath(from, to, walkable, { heuristic: PathHeuristic.Chebyshev });
    if (closer === null || chebyshevRoute === null) throw new Error('expected both routes');

    expect(findPath(from, to, walkable, { heuristic: PathHeuristic.CloserPath })).toEqual(closer);
    expect(findPath(from, to, walkable, { heuristic: PathHeuristic.Chebyshev })).toEqual(
      chebyshevRoute,
    );

    // Bare chebyshev is admissible, so it finds a genuinely shortest route;
    // ToME's default trades that for a straighter-looking one, which can be a
    // step or two longer. Asserting the inequality rather than the lengths keeps
    // this honest without hard-coding either number.
    expect(chebyshevRoute.length).toBeLessThanOrEqual(closer.length);
    expect(chebyshevRoute.length).toBeGreaterThanOrEqual(chebyshev(from, to));
    expectWalkable(closer, from, to, walkable);
    expectWalkable(chebyshevRoute, from, to, walkable);
  });
});
