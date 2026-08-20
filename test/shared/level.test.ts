import { describe, expect, it } from 'vitest';
import type { LevelView } from '../../src/shared/protocol.ts';

import {
  TEST_LEVEL_SPAWNS,
  canWalk,
  makeTestLevel,
  tileAt,
  blocksSightAt,
  makeOverworld,
} from '../../src/shared/level.ts';
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

  it('hands back every code this build knows, unchanged', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * `DEEPWATER` CAME OUT OF HERE AS `WALL`, AND ONLY `DEEPWATER`.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * The recognition clause used to be written out by hand:
     *
     *     isWalkable(raw) || blocksSight(raw) || raw === TileCode.WATER
     *
     * which reads as complete and is not. Those two sets between them cover
     * every tile EXCEPT one that is unwalkable AND transparent — which is
     * exactly the water family, and exactly why `WATER` is bolted on the end.
     * `DEEPWATER` is the same shape, was added later, and the clause never
     * learned it.
     *
     * MEASURED on the overworld: 716 cells of open sea, the only code affected.
     * The renderer reads through `tileAt`, so the sea drew as rock — its own
     * deep-sea colour, written because *"two values of water is what makes a
     * shoreline legible"*, was unreachable — and `blocksSightAt` said an eye
     * cannot cross the water while `blocksSight`, correctly updated, said it can.
     *
     * ASSERTED OVER THE WHOLE VOCABULARY rather than over `DEEPWATER`, because
     * the bug is the class and not the instance: the next tile that is solid and
     * see-through would land in the same hole.
     */
    const lost: string[] = [];
    for (const [name, code] of Object.entries(TileCode)) {
      const one: LevelView = { w: 1, h: 1, tiles: [code] };
      if (tileAt(one, 0, 0) !== code) lost.push(`${name} (${String(code)})`);
    }
    expect(lost, 'codes this build defines and tileAt refuses to name').toEqual([]);
  });

  it('still collapses a code this build does not define', () => {
    /**
     * THE HALF THAT MUST NOT BE LOST, and the reason the fix derives from
     * `TileCode` rather than passing everything through.
     *
     * Fail-closed is the whole contract: a corrupt frame or a map from a newer
     * build must read as solid rock, because *"seeing an ambush through an
     * unknown wall"* is an information leak the server cannot take back.
     */
    const bogus: LevelView = { w: 1, h: 1, tiles: [254] };
    expect(tileAt(bogus, 0, 0)).toBe(TileCode.WALL);
  });

  it('lets an eye cross deep water, exactly as it crosses the canal', () => {
    /**
     * THE CONSEQUENCE THAT WAS VISIBLE IN PLAY. `blocksSight` names both water
     * codes as transparent — *"solid, and transparent"* is the canal's whole
     * design and the sea is the same — but `blocksSightAt` asks `tileAt` first,
     * so while the sea came back as `WALL` the answer was the opposite of the
     * one protocol.ts gives.
     *
     * Both are asserted together: fixing one and not the other is how the two
     * files disagreed in the first place.
     */
    for (const code of [TileCode.WATER, TileCode.DEEPWATER]) {
      const one: LevelView = { w: 1, h: 1, tiles: [code] };
      expect(blocksSightAt(one, 0, 0), `code ${String(code)} blocked sight`).toBe(false);
      // AND IS STILL NOT SOMETHING YOU CAN STAND ON. The fix must not have
      // turned the sea into ground.
      expect(canWalk(one, 0, 0), `code ${String(code)} became walkable`).toBe(false);
    }
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

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A BUILDING IS MORE THAN ONE TILE, OR IT IS NOT A BUILDING.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * MEASURED FIRST, and the measurement was the whole finding: every one of the
 * eighteen settlement roofs on this map was ISOLATED — no orthogonal roof
 * beside it, anywhere, in any of the three settlements. Rendered at 32px that
 * is a lone ornate square sitting on open ground, and it reads as a rug rather
 * than as a house. Eight of them in a lattice around the city gate is literally
 * a checkerboard, which is the word the bug report used.
 *
 * ═══ WHY THIS IS THE RIGHT TEST AND "COUNT THE ROOFS" IS NOT ═══
 * The map has plenty of roof tiles. What it did not have was any two of them
 * TOUCHING, and no count of roofs, settlements or glyph variety would have said
 * so. Adjacency is the property that separates a town from a scatter, so
 * adjacency is what is asserted.
 *
 * A roof may still sit at the end of a terrace with exactly one neighbour —
 * that is a row house and it is correct. What is refused is a roof with NONE.
 */
describe('a settlement reads as buildings, not as a scatter', () => {
  const ROOFS: ReadonlySet<number> = new Set<number>([
    TileCode.VILLAGE_ROOF,
    TileCode.TOWN_ROOF,
    TileCode.CITY_ROOF,
  ]);

  const map = makeOverworld();

  function mapTile(x: number, y: number): number | undefined {
    if (x < 0 || y < 0 || x >= map.view.w || y >= map.view.h) return undefined;
    return map.view.tiles[y * map.view.w + x];
  }

  /** Every roof on the map, with how many roofs it touches orthogonally. */
  function roofs(): { x: number; y: number; neighbours: number }[] {
    const out: { x: number; y: number; neighbours: number }[] = [];
    for (let y = 0; y < map.view.h; y += 1) {
      for (let x = 0; x < map.view.w; x += 1) {
        const tile = mapTile(x, y);
        if (tile === undefined || !ROOFS.has(tile)) continue;
        let neighbours = 0;
        for (const [dx, dy] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ] as const) {
          const near = mapTile(x + dx, y + dy);
          if (near !== undefined && ROOFS.has(near)) neighbours += 1;
        }
        out.push({ x, y, neighbours });
      }
    }
    return out;
  }

  it('has settlements at all', () => {
    // The guard on the guard: a map with no roofs would pass every assertion
    // below by vacuum.
    expect(roofs().length).toBeGreaterThan(12);
  });

  it('leaves no roof standing on its own', () => {
    const lone = roofs()
      .filter((roof) => roof.neighbours === 0)
      .map((roof) => `(${String(roof.x)},${String(roof.y)})`);
    expect(lone).toEqual([]);
  });

  it('builds at least one block two tiles deep, not just longer rows', () => {
    // A terrace one tile deep is a wall, not a town. At least one roof must have
    // a roof BOTH beside it and above or below it, which is the cheapest
    // statement of "this settlement has depth".
    const deep = roofs().filter((roof) => {
      const across =
        ROOFS.has(mapTile(roof.x + 1, roof.y) ?? -1) ||
        ROOFS.has(mapTile(roof.x - 1, roof.y) ?? -1);
      const down =
        ROOFS.has(mapTile(roof.x, roof.y + 1) ?? -1) ||
        ROOFS.has(mapTile(roof.x, roof.y - 1) ?? -1);
      return across && down;
    });
    expect(deep.length).toBeGreaterThan(0);
  });
});
