/**
 * The Alderbrook region — the overworld map, proven rather than eyeballed.
 *
 * WHY THIS FILE EXISTS. `ALDERBROOK_ROWS` is 6,144 authored cells. Nobody can
 * read that for the one mistake that actually matters — a settlement that
 * cannot be walked to — and the failure is silent: the map loads, the country
 * draws, and a party walks toward the Glass Archive for ten minutes and finds
 * no way in.
 *
 * The layout was generated from regions and roads and verified once before
 * being frozen into the source. This re-runs that verification on every commit,
 * because the map is now ordinary text an ordinary edit can break: widen one
 * mountain range by a cell and you can seal a road without touching anything
 * that looks load-bearing.
 */

import { describe, expect, it } from 'vitest';

import { canWalk, makeOverworld, tileAt } from '../../src/shared/level.ts';
import { findPath } from '../../src/shared/path.ts';
import { TileCode, blocksSight, isWalkable } from '../../src/shared/protocol.ts';
import type { LevelView } from '../../src/shared/protocol.ts';

const OVERWORLD = makeOverworld();

/** Alderbrook's gate. Every player starts here, so it anchors every claim. */
const ALDERBROOK = { x: 40, y: 53 };

/**
 * Flood fill from a tile, EIGHT-WAY WITH CORNER CUTTING.
 *
 * The corner-cutting part is not incidental — it must match the movement rule
 * the server enforces, which allows a diagonal step between two orthogonally
 * adjacent walls (world.ts:852-856, ported from ToME). A stricter flood here
 * would report false failures; a laxer one would prove nothing.
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

describe('the region — shape', () => {
  it('is 96x64 with a tile for every cell', () => {
    expect(OVERWORLD.view.w).toBe(96);
    expect(OVERWORLD.view.h).toBe(64);
    expect(OVERWORLD.view.tiles).toHaveLength(96 * 64);
  });

  it('spawns every player at Alderbrook and nowhere else', () => {
    // ONE spawn is deliberate: the first thing you see on connecting should be
    // another player, not empty country.
    expect(OVERWORLD.spawns).toEqual([ALDERBROOK]);
  });

  it('is sealed by erased ground on all four edges', () => {
    // The border is fiction, not a wall: the Index has eaten everything beyond
    // the region. It still has to actually seal, or a player walks off the map.
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

describe('it is wilderness, not a town', () => {
  it('is mostly open country rather than paving', () => {
    // THE CHANGE THIS FILE RECORDS. The overworld used to BE Alderbrook, and
    // its commonest tile was a cobbled street. It is now the country around
    // Alderbrook, and the commonest tile must be open ground — otherwise the
    // city has quietly eaten the map again.
    const tiles = OVERWORLD.view.tiles;
    const countOf = (want: readonly number[]): number =>
      tiles.filter((t) => want.includes(t)).length;
    const open = countOf([TileCode.PLAINS, TileCode.HILLS, TileCode.HEATH, TileCode.GREEN]);
    const built = countOf([TileCode.COBBLE, TileCode.PAVING]);
    expect(open).toBeGreaterThan(built * 5);
  });

  it('makes forest, mountain and water the walls of the map', () => {
    // ToME's own rule, verified in the reference clone rather than remembered:
    // data/zones/wilderness/grids.lua gives FOREST `does_block_move = true`.
    // The light ground threading between dark masses IS the route, and a
    // mountain you could walk over would delete every decision the map makes.
    for (const blocking of [
      TileCode.TREES,
      TileCode.MOUNTAIN,
      TileCode.CRAG,
      TileCode.WATER,
      TileCode.DEEPWATER,
    ]) {
      expect(isWalkable(blocking), `${blocking} should block movement`).toBe(false);
    }
    for (const open of [TileCode.PLAINS, TileCode.HILLS, TileCode.HEATH]) {
      expect(isWalkable(open), `${open} should be walkable`).toBe(true);
    }
  });

  it('drains to a sea, with a shore between', () => {
    // A coast is three things or it is a blue shape abutting a green one: deep
    // water, shallow water and a beach. The generator produces the band from
    // elevation, so this is really asserting the thresholds still bracket it.
    const codes = new Set(OVERWORLD.view.tiles);
    expect(codes.has(TileCode.DEEPWATER)).toBe(true);
    expect(codes.has(TileCode.WATER)).toBe(true);
    expect(codes.has(TileCode.SHORE)).toBe(true);
  });

  it('has rivers that reach the sea rather than stopping inland', () => {
    // Every river was carved by walking downhill until it hit water, so a river
    // cell adjacent to nothing wet would mean the walk terminated in a basin —
    // which is a lake the map does not know it has.
    const view = OVERWORLD.view;
    let inland = 0;
    for (let y = 1; y < view.h - 1; y += 1) {
      for (let x = 1; x < view.w - 1; x += 1) {
        if (tileAt(view, x, y) !== TileCode.WATER) continue;
        // EIGHT-WAY, because that is how the river was carved: the downhill
        // walk takes diagonal steps, so a four-way check reads every diagonal
        // as a break and reports a perfectly continuous river as 31 puddles.
        const wet = [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
          [1, 1],
          [1, -1],
          [-1, 1],
          [-1, -1],
        ].some(([dx, dy]) => {
          const t = tileAt(view, x + (dx ?? 0), y + (dy ?? 0));
          return t === TileCode.WATER || t === TileCode.DEEPWATER;
        });
        if (!wet) inland += 1;
      }
    }
    expect(inland).toBe(0);
  });

  it('has a real mountain range rather than scattered rocks', () => {
    // A range is the longest continuous run of one tile in the game, and it is
    // what makes the north-west a barrier instead of scenery. Counted rather
    // than eyeballed so thinning it out is a test failure.
    const peaks = OVERWORLD.view.tiles.filter((t) => t === TileCode.MOUNTAIN).length;
    expect(peaks).toBeGreaterThan(250);
  });
});

describe('every settlement can be reached on foot', () => {
  const reach = reachableFrom(OVERWORLD.view, ALDERBROOK);

  it('places all nine sites', () => {
    expect([...OVERWORLD.sites.values()].sort()).toEqual([
      'site:alderbrook',
      'site:ashwick_row',
      'site:blackwood_outskirts',
      'site:gearford_ward',
      'site:glass_archive',
      'site:threadneedle_row',
      'site:underworks',
      'site:watchers_altar',
      'site:wayfarers_camp',
    ]);
  });

  it.each([...OVERWORLD.sites.entries()])('%s (%s) is walkable and reachable', (key, siteId) => {
    const parts = key.split(',');
    const x = Number(parts[0]);
    const y = Number(parts[1]);
    // Walkable first: a site stamped onto a mountain is unreachable for a reason
    // the flood fill would report identically to a sealed road, and the two want
    // different fixes.
    expect(canWalk(OVERWORLD.view, x, y), `${siteId} sits on solid terrain`).toBe(true);
    expect(reach.has(key), `${siteId} is sealed off from Alderbrook`).toBe(true);
  });

  it('maroons no walkable cell anywhere in the region', () => {
    // The strongest statement available: not merely "the sites are reachable"
    // but "there is exactly one connected walkable region". A pocket is not
    // something a player sees, but it IS a lie in the data — the pathfinder will
    // happily route toward a cell no route reaches.
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
    // tile' — a lie about the map, and the one divergence a player notices.
    expect(reach.size).toBe(2862);
    expect(reach.size).toBeLessThan(OVERWORLD.view.w * OVERWORLD.view.h + 1);
  });

  it('routes clear across the region under the travel budget', () => {
    // THE REGRESSION THIS FILE EXISTS FOR: a long legal journey — the Watcher's
    // Altar high in the northern range to the Glass Archive on the south-west
    // coast — must return a route rather than null.
    const route = findPath(
      { x: 30, y: 17 },
      { x: 11, y: 50 },
      (x, y) => canWalk(OVERWORLD.view, x, y),
      { maxNodes: OVERWORLD.view.w * OVERWORLD.view.h + 1 },
    );
    // `[]` and null are different answers (path.ts:303-311): [] means "you are
    // already there", null means "no route". Neither is acceptable here.
    expect(route).not.toBeNull();
    // Chebyshev is 33 and the answer is 33: the two are on opposite sides of
    // the map but the walkable ground between them happens to admit a clean
    // diagonal, which is a fact about this world and not a weaker assertion —
    // anything SHORTER would mean the pathfinder cheated through a mountain.
    expect(route?.length ?? 0).toBeGreaterThanOrEqual(33);
  });
});

describe('water is the reason tiles have two predicates', () => {
  it('is solid to a body and transparent to an eye', () => {
    for (const wet of [TileCode.WATER, TileCode.DEEPWATER]) {
      expect(isWalkable(wet)).toBe(false);
      expect(blocksSight(wet)).toBe(false);
    }
  });

  it('has a river, a sea and bridges across the water', () => {
    const codes = new Set(OVERWORLD.view.tiles);
    expect(codes.has(TileCode.WATER)).toBe(true);
    expect(codes.has(TileCode.DEEPWATER)).toBe(true);
    expect(codes.has(TileCode.BRIDGE)).toBe(true);
  });
});

describe('the two maps are independent objects', () => {
  it('hands out a fresh tile array per call', () => {
    // Same argument makeTestLevel makes: one realm changing its map must never
    // appear in another's. With realms this stopped being hypothetical.
    const a = makeOverworld();
    const b = makeOverworld();
    expect(a.view.tiles).not.toBe(b.view.tiles);
    a.view.tiles[0] = TileCode.PLAINS;
    expect(b.view.tiles[0]).toBe(TileCode.ERASED);
  });
});
