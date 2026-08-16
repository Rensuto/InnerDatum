/**
 * Alderbrook — the overworld map, proven rather than eyeballed.
 *
 * WHY THIS FILE EXISTS. `ALDERBROOK_ROWS` is 3,072 authored cells. Nobody can
 * read that for the one mistake that actually matters — a district that cannot
 * be walked to — and the failure is silent: the map loads, the city draws, and
 * a player walks to the Glass Archive for ten minutes and finds no way in.
 *
 * The layout was generated from districts and streets and verified once before
 * being frozen into the source. This re-runs that verification on every commit,
 * because the map is now ordinary text that an ordinary edit can break: widen
 * one terrace by a cell and you can seal a district without touching anything
 * that looks load-bearing.
 *
 * These tests are about the MAP, not the renderer and not the realm plumbing.
 */

import { describe, expect, it } from 'vitest';

import { canWalk, makeOverworld, tileAt } from '../../src/shared/level.ts';
import { findPath } from '../../src/shared/path.ts';
import { TileCode, blocksSight, isWalkable } from '../../src/shared/protocol.ts';
import type { LevelView } from '../../src/shared/protocol.ts';

const OVERWORLD = makeOverworld();

/** The office. Every player starts here, so it anchors every reachability claim. */
const OFFICE = { x: 32, y: 15 };

/**
 * Flood fill from a tile, EIGHT-WAY WITH CORNER CUTTING.
 *
 * The corner-cutting part is not incidental — it must match the movement rule
 * the server actually enforces, which allows a diagonal step between two
 * orthogonally adjacent walls (world.ts:852-856, ported from ToME). A stricter
 * flood here would report false failures; a laxer one would prove nothing.
 */
function reachableFrom(level: LevelView, from: { x: number; y: number }): Set<string> {
  const seen = new Set<string>([`${from.x},${from.y}`]);
  const stack = [from];
  while (stack.length > 0) {
    const cell = stack.pop();
    if (cell === undefined) break;
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
      [1, 1],
      [1, -1],
      [-1, 1],
      [-1, -1],
    ] as const) {
      const nx = cell.x + dx;
      const ny = cell.y + dy;
      const key = `${nx},${ny}`;
      if (seen.has(key)) continue;
      if (!canWalk(level, nx, ny)) continue;
      seen.add(key);
      stack.push({ x: nx, y: ny });
    }
  }
  return seen;
}

describe('Alderbrook — shape', () => {
  it('is 64x48 with a tile for every cell', () => {
    expect(OVERWORLD.view.w).toBe(64);
    expect(OVERWORLD.view.h).toBe(48);
    expect(OVERWORLD.view.tiles).toHaveLength(64 * 48);
  });

  it('spawns every player on the office and nowhere else', () => {
    // ONE spawn is deliberate: the first thing you see on connecting should be
    // another player, not an empty street. See ALDERBROOK_LEGEND's `O` entry.
    expect(OVERWORLD.spawns).toEqual([OFFICE]);
  });

  it('is sealed by erased ground on all four edges', () => {
    // The border is fiction, not a wall: the Index has eaten everything beyond
    // Alderbrook. It still has to actually seal, or a player walks off the map.
    for (let x = 0; x < OVERWORLD.view.w; x += 1) {
      expect(tileAt(OVERWORLD.view, x, 0)).toBe(TileCode.ERASED);
      expect(tileAt(OVERWORLD.view, x, OVERWORLD.view.h - 1)).toBe(TileCode.ERASED);
    }
    for (let y = 0; y < OVERWORLD.view.h; y += 1) {
      expect(tileAt(OVERWORLD.view, 0, y)).toBe(TileCode.ERASED);
      expect(tileAt(OVERWORLD.view, OVERWORLD.view.w - 1, y)).toBe(TileCode.ERASED);
    }
  });
});

describe('Alderbrook — every site can be reached on foot', () => {
  const reach = reachableFrom(OVERWORLD.view, OFFICE);

  it('places all eight sites', () => {
    expect([...OVERWORLD.sites.values()].sort()).toEqual([
      'site:ashwick_row',
      'site:blackwood_outskirts',
      'site:gearford_ward',
      'site:glass_archive',
      'site:office',
      'site:threadneedle_row',
      'site:underworks',
      'site:watchers_altar',
    ]);
  });

  it.each([...OVERWORLD.sites.entries()])('%s (%s) is walkable and reachable', (key, siteId) => {
    const parts = key.split(',');
    const x = Number(parts[0]);
    const y = Number(parts[1]);
    // Walkable first: a site stamped onto a terrace block is unreachable for a
    // reason the flood fill would report identically to a sealed district, and
    // the two want different fixes.
    expect(canWalk(OVERWORLD.view, x, y), `${siteId} sits on solid terrain`).toBe(true);
    expect(reach.has(key), `${siteId} is sealed off from the office`).toBe(true);
  });

  it('maroons no walkable cell anywhere on the map', () => {
    // The strongest statement available: not merely "the sites are reachable"
    // but "there is exactly one connected walkable region". A pocket is not
    // something a player sees, but it IS a lie in the data — the pathfinder
    // will happily route toward a cell no route reaches.
    const marooned: string[] = [];
    for (let y = 0; y < OVERWORLD.view.h; y += 1) {
      for (let x = 0; x < OVERWORLD.view.w; x += 1) {
        if (canWalk(OVERWORLD.view, x, y) && !reach.has(`${x},${y}`)) {
          marooned.push(`${x},${y}`);
        }
      }
    }
    expect(marooned).toEqual([]);
  });

  it('stays inside the pathfinder budget', () => {
    // travel.ts caps A* at `w * h + 1` expansions. With a closed set, expansions
    // are bounded by the reachable cell count, so this is the number that
    // decides whether "walk to the Glass Archive" answers 'no route to that
    // tile' — a lie about the map, and the one divergence a player actually
    // notices. Pinned so growing the city cannot silently break travel.
    expect(reach.size).toBe(1784);
    expect(reach.size).toBeLessThan(OVERWORLD.view.w * OVERWORLD.view.h + 1);
  });

  it('routes clear across the city under the travel budget', () => {
    // THE REGRESSION THIS FILE EXISTS FOR, stated as the player would hit it:
    // the longest legal walk on the map — the Watcher's Altar in the far
    // north-east to the Glass Archive in the far south-west, opposite corners
    // across the canal — must return a route rather than null. Under the old
    // fixed 2048-node ceiling this survived by 264 cells; under `w * h` it
    // cannot fail on any map, and this proves the wiring rather than the maths.
    const altar = { x: 57, y: 5 };
    const archive = { x: 15, y: 40 };
    const route = findPath(altar, archive, (x, y) => canWalk(OVERWORLD.view, x, y), {
      maxNodes: OVERWORLD.view.w * OVERWORLD.view.h + 1,
    });
    // `[]` and null are different answers (path.ts:303-311): [] means "you are
    // already there", null means "no route". Neither is acceptable here.
    expect(route).not.toBeNull();
    // 50 steps for a Chebyshev distance of 42 — the eight extra are the detour
    // to a bridge, which is the geography doing its job. Pinned exactly because
    // the map is frozen authored data: if this number moves, either the city or
    // the pathfinder changed, and both are worth a second look.
    expect(route?.length).toBe(50);
  });
});

describe('Alderbrook — the canal is the reason tiles have two predicates', () => {
  it('is solid to a body and transparent to an eye', () => {
    expect(isWalkable(TileCode.WATER)).toBe(false);
    expect(blocksSight(TileCode.WATER)).toBe(false);
  });

  it('has water on the map, and bridges across it', () => {
    const codes = new Set(OVERWORLD.view.tiles);
    expect(codes.has(TileCode.WATER)).toBe(true);
    expect(codes.has(TileCode.BRIDGE)).toBe(true);
  });

  it('crosses the canal only on a bridge', () => {
    // Walk the canal band and assert every crossing column is a bridge. If a
    // stray walkable tile ever appears mid-canal the city gets a secret ford,
    // which breaks the district geography without breaking any other test.
    for (let y = 26; y <= 29; y += 1) {
      for (let x = 0; x < OVERWORLD.view.w; x += 1) {
        const t = tileAt(OVERWORLD.view, x, y);
        if (isWalkable(t)) expect(t).toBe(TileCode.BRIDGE);
      }
    }
  });
});

describe("the Watcher's Altar is gated on purpose", () => {
  it('is walled off by erased ground with a single approach', () => {
    // The altar is the boss site and it should be hard to reach. This pins the
    // geography that makes it so: erased ground on both sides of one corridor.
    const reach = reachableFrom(OVERWORLD.view, OFFICE);
    expect(reach.has('57,5')).toBe(true);
    expect(tileAt(OVERWORLD.view, 56, 8)).toBe(TileCode.ERASED);
    expect(tileAt(OVERWORLD.view, 58, 8)).toBe(TileCode.ERASED);
    expect(canWalk(OVERWORLD.view, 57, 8)).toBe(true);
  });
});

describe('the two maps are independent objects', () => {
  it('hands out a fresh tile array per call', () => {
    // Same argument makeTestLevel makes: one realm changing its map must never
    // appear in another's. With realms this stops being hypothetical.
    const a = makeOverworld();
    const b = makeOverworld();
    expect(a.view.tiles).not.toBe(b.view.tiles);
    a.view.tiles[0] = TileCode.COBBLE;
    expect(b.view.tiles[0]).toBe(TileCode.ERASED);
  });
});
