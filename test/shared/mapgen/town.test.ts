// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// The generator under test is ported from t-engine4 game/engines/default/engine/generator/map/Town.lua:29-260
//   and the zones from game/modules/tome/data/zones/{halfling-ruins,rhaloren-camp}/zone.lua.
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

import { describe, expect, it } from 'vitest';

import { BSP_MAX_DEPTH, partition } from '../../../src/shared/bsp.ts';
import type { TileXY } from '../../../src/shared/coords.ts';
import { reachable } from '../../../src/shared/mapgen/connectivity.ts';
import { createGenMap } from '../../../src/shared/mapgen/genmap.ts';
import type { GenMap, GridKeys, Spot } from '../../../src/shared/mapgen/genmap.ts';
import { range } from '../../../src/shared/mapgen/lua.ts';
import {
  Lshape,
  TOWN_HALFLING_RUINS,
  TOWN_RHALOREN_CAMP,
  building,
  createTown,
  generate,
  makeGridList,
  makeStairsInside,
  makeStairsSides,
} from '../../../src/shared/mapgen/town.ts';
import type {
  GridList,
  TownData,
  TownGen,
  TownLevelSpec,
  TownResult,
} from '../../../src/shared/mapgen/town.ts';
import { TileCode } from '../../../src/shared/protocol.ts';
import { createRng, rngFromState } from '../../../src/shared/rng.ts';
import type { Rng } from '../../../src/shared/rng.ts';

/**
 * Every key a Town level reads, each its own code: the street is GREEN so it
 * cannot be mistaken for a building's FLOOR, and the stairs are PAVING and
 * COBBLE so each can be found by its terrain.
 */
const GRID: GridKeys = {
  external_floor: TileCode.GREEN,
  floor: TileCode.FLOOR,
  wall: TileCode.WALL,
  door: TileCode.DOOR,
  up: TileCode.PAVING,
  down: TileCode.COBBLE,
  '.': TileCode.FLOOR,
  '#': TileCode.WALL,
  '+': TileCode.DOOR,
};

type Opts = { w?: number; h?: number; level?: number; maxLevel?: number };

function town(
  seed: string | Rng,
  data: Partial<TownData> = {},
  opts: Opts = {},
): { gen: TownGen; map: GenMap; level: { forceRecreate: string | null } } {
  const rng = typeof seed === 'string' ? createRng(seed) : seed;
  const grid = data.grid ?? GRID;
  const map = createGenMap(opts.w ?? 50, opts.h ?? 50, grid, rng);
  const level = { forceRecreate: null as string | null };
  const gen = createTown(map, { ...data, grid }, rng, { maxLevel: opts.maxLevel ?? 3 }, level);
  return { gen, map, level };
}

function run(
  seed: string | Rng,
  data: Partial<TownData> = {},
  opts: Opts = {},
): { gen: TownGen; map: GenMap; result: TownResult | null; forceRecreate: string | null } {
  const { gen, map, level } = town(seed, data, opts);
  const result = generate(gen, opts.level ?? 1, 0);
  return { gen, map, result, forceRecreate: level.forceRecreate };
}

/** An Rng that records the label of every draw it makes. */
function recording(seed: string): { rng: Rng; labels: string[] } {
  const inner = createRng(seed);
  const labels: string[] = [];
  const rng: Rng = {
    ...inner,
    nextU32: (label) => {
      labels.push(label);
      return inner.nextU32(label);
    },
    int: (label, lo, hi) => {
      labels.push(label);
      return inner.int(label, lo, hi);
    },
  };
  return { rng, labels };
}

type Draw = {
  readonly label: string;
  readonly lo?: number;
  readonly hi?: number;
  readonly value?: number;
};

/**
 * An Rng that records every draw with its bounds and value, and answers the
 * labels in `force` with the value given instead of drawing.
 */
function bounded(
  seed: string,
  force: Readonly<Record<string, number>> = {},
): { rng: Rng; draws: Draw[] } {
  const inner = createRng(seed);
  const draws: Draw[] = [];
  const rng: Rng = {
    ...inner,
    nextU32: (label) => {
      draws.push({ label });
      return inner.nextU32(label);
    },
    int: (label, lo, hi) => {
      const value = force[label] ?? inner.int(label, lo, hi);
      draws.push({ label, lo, hi, value });
      return value;
    },
  };
  return { rng, draws };
}

const key = (x: number, y: number): string => `${String(x)},${String(y)}`;

/** The cells holding `code`, as `x,y` keys. */
function cellsOf(map: GenMap, code: number): Set<string> {
  const out = new Set<string>();
  for (let y = 0; y < map.h; y += 1) {
    for (let x = 0; x < map.w; x += 1) if (map.get(x, y) === code) out.add(key(x, y));
  }
  return out;
}

/**
 * A building's rectangle stamped by hand, as `Town.lua:100-113` writes one:
 * walls on the edge, floor inside. Returns the door candidates (every edge
 * cell but the corners) as a real `Gridlist`, for `Lshape` to be handed.
 */
function stamp(map: GenMap, x1: number, x2: number, y1: number, y2: number): GridList {
  const bdoor = makeGridList();
  for (let i = x1; i <= x2; i += 1) {
    for (let j = y1; j <= y2; j += 1) {
      const edge = i === x1 || i === x2 || j === y1 || j === y2;
      map.set(i, j, edge ? TileCode.WALL : TileCode.FLOOR);
      const corner = (i === x1 || i === x2) && (j === y1 || j === y2);
      if (edge && !corner) bdoor.add(i, j);
    }
  }
  return bdoor;
}

describe('Town — init and the zone tables', () => {
  it('writes Town:init`s defaults for every field a zone leaves out', () => {
    // `engine/generator/map/Town.lua:33-38`, RoomsLoader's tunnel defaults, and
    // `lite_room_chance`'s `or 100` (`engine/generator/map/RoomsLoader.lua:625`).
    const { gen, map } = town('defaults', {}, { w: 20, h: 16 });
    expect(gen).toMatchObject({
      maxBuildingW: 12,
      maxBuildingH: 12,
      buildingChance: 85,
      lshapeChance: 50,
      doubleLshapeChance: 40,
      yardChance: 30,
    });
    expect(gen.data).toMatchObject({ tunnelChange: 30, tunnelRandom: 10, liteRoomChance: 100 });
    expect(gen.data.nbRooms).toBeUndefined();
    expect(gen.rooms).toEqual([]);
    expect(gen.isBuilding).toHaveLength(map.w * map.h);
    expect(gen.isBuilding.every((v) => v === 0)).toBe(true);
  });

  it('pins the halfling ruins` level 1 and the overground Rhaloren camp to upstream`s tables', () => {
    expect(TOWN_HALFLING_RUINS).toMatchObject({
      width: 50,
      height: 50,
      map: {
        class: 'Town',
        buildingChance: 70,
        maxBuildingW: 8,
        maxBuildingH: 8,
        edgeEntrances: [6, 4],
        forceLastStair: true,
        grid: {
          floor: TileCode.FLOOR,
          external_floor: TileCode.FLOOR,
          wall: TileCode.WALL,
          door: TileCode.DOOR,
          up: TileCode.FLOOR,
          down: TileCode.FLOOR,
        },
      },
    });
    // `nb_rooms = false, rooms = false` overwrite the zone's ten rooms.
    expect(TOWN_HALFLING_RUINS.map.nbRooms).toBeUndefined();
    expect(TOWN_HALFLING_RUINS.map.rooms).toBeUndefined();

    expect(TOWN_RHALOREN_CAMP).toMatchObject({
      width: 50,
      height: 50,
      map: {
        class: 'Town',
        buildingChance: 80,
        maxBuildingW: 10,
        maxBuildingH: 10,
        edgeEntrances: [4, 6],
        nbRooms: [0, 1, 1, 2],
        rooms: ['lesser_vault'],
        liteRoomChance: 100,
        forceLastStair: true,
        grid: {
          floor: TileCode.FLOOR,
          wall: TileCode.WALL,
          door: TileCode.DOOR,
          up: TileCode.GREEN,
          down: TileCode.GREEN,
          '#': TileCode.WALL,
          '.': TileCode.FLOOR,
          '+': TileCode.DOOR,
        },
      },
    });
    // Fifteen GRASS and one TREE: a table, drawn from on every resolve.
    expect(TOWN_RHALOREN_CAMP.map.grid['external_floor']).toEqual([
      ...Array.from({ length: 15 }, () => TileCode.GREEN),
      TileCode.TREES,
    ]);
    expect(TOWN_RHALOREN_CAMP.map.lesserVaultsList?.length).toBeGreaterThan(0);
  });
});

describe('Gridlist', () => {
  it('holds a cell once, removes only what it holds, and lists column by column from the top', () => {
    // `engine/Generator.lua:140-181`.
    const list = makeGridList();
    list.add(5, 2);
    list.add(1, 9);
    list.add(5, 0);
    list.add(1, 9);
    list.add(3, 4);
    expect(list.count()).toBe(4);
    list.remove(7, 7); // no such column
    list.remove(5, 1); // a column, but not that cell
    expect(list.count()).toBe(4);
    expect(list.toList()).toEqual([
      { x: 1, y: 9 },
      { x: 3, y: 4 },
      { x: 5, y: 0 },
      { x: 5, y: 2 },
    ]);
    list.remove(3, 4);
    list.remove(5, 0);
    expect(list.toList()).toEqual([
      { x: 1, y: 9 },
      { x: 5, y: 2 },
    ]);
    expect(list.count()).toBe(2);
  });
});

describe('Town — building', () => {
  it('insets each wall 2 to max(2, floor(size/2 - 3)) from its leaf — left, right, top, then bottom', () => {
    // `engine/generator/map/Town.lua:89-90`. 14 wide allows 2..4, 12 tall 2..3.
    const leaf = { x: 3, y: 4, w: 14, h: 12 };
    const insets = new Set<string>();
    for (let s = 0; s < 80; s += 1) {
      const { gen, map } = town(`building:${String(s)}`, { lshapeChance: 0 }, { w: 30, h: 30 });
      const twin = createRng(`building:${String(s)}`);
      const a = twin.int('x1', 2, 4);
      const b = twin.int('x2', 2, 4);
      const c = twin.int('y1', 2, 3);
      const d = twin.int('y2', 2, 3);
      insets.add(`${String(a)}${String(b)}${String(c)}${String(d)}`);
      const x1 = leaf.x + a;
      const x2 = leaf.x + leaf.w - b;
      const y1 = leaf.y + c;
      const y2 = leaf.y + leaf.h - d;

      const spots: Spot[] = [];
      building(gen, leaf, spots);

      const doors: string[] = [];
      const wrong: string[] = [];
      for (let x = 0; x < 30; x += 1) {
        for (let y = 0; y < 30; y += 1) {
          const inside = x >= x1 && x <= x2 && y >= y1 && y <= y2;
          const edge = inside && (x === x1 || x === x2 || y === y1 || y === y2);
          const code = map.get(x, y);
          if (gen.isBuilding[y * 30 + x] !== (inside ? 1 : 0))
            wrong.push(`is_building ${key(x, y)}`);
          if (!inside) {
            if (code !== null) wrong.push(`outside ${key(x, y)}`);
          } else if (!edge) {
            if (code !== TileCode.FLOOR) wrong.push(`floor ${key(x, y)}`);
          } else if (code === TileCode.DOOR) {
            doors.push(key(x, y));
          } else if (code !== TileCode.WALL) {
            wrong.push(`wall ${key(x, y)}`);
          }
        }
      }
      expect(wrong, `seed ${String(s)}`).toEqual([]);
      // One door, on the wall and never on a corner.
      expect(doors, `seed ${String(s)}`).toHaveLength(1);
      const [dx, dy] = (doors[0] ?? '').split(',').map(Number);
      expect((dx === x1 || dx === x2) && (dy === y1 || dy === y2)).toBe(false);
      expect(spots).toEqual([
        {
          x: Math.floor((x1 + x2) / 2),
          y: Math.floor((y1 + y2) / 2),
          type: 'building',
          subtype: 'building',
        },
      ]);
    }
    // Every inset each draw allows turns up.
    expect(insets.size).toBeGreaterThan(20);
  });

  it('draws no inset where the leaf leaves only 2, and stands the walls 2 in', () => {
    // 8 wide and 9 tall: `floor(4 - 3)` and `floor(4.5 - 3)` are both 1, so `range(2, 2)`.
    const { rng, labels } = recording('narrow');
    const { gen, map } = town(rng, { lshapeChance: 0 }, { w: 20, h: 20 });
    building(gen, { x: 5, y: 1, w: 8, h: 9 }, []);
    expect(labels[0]).toBe('mapgen.town.lshape');
    expect(map.get(7, 3)).toBe(TileCode.WALL);
    expect(map.get(11, 8)).toBe(TileCode.WALL);
    expect(map.get(6, 3)).toBeNull();
    expect(map.get(12, 8)).toBeNull();
    expect(map.get(11, 9)).toBeNull();
  });

  it('gives a building with no door candidate no door, after the draw upstream makes before it fails', () => {
    // A 5x5 leaf stands a 2x2 building: four corners and nothing else.
    const { rng, labels } = recording('doorless');
    const { gen, map } = town(rng, { lshapeChance: 0 }, { w: 8, h: 8 });
    const spots: Spot[] = [];
    building(gen, { x: 0, y: 0, w: 5, h: 5 }, spots);
    expect(labels).toEqual(['mapgen.town.lshape', 'mapgen.town.building.door']);
    expect(cellsOf(map, TileCode.WALL)).toEqual(new Set(['2,2', '3,2', '2,3', '3,3']));
    expect(cellsOf(map, TileCode.DOOR).size).toBe(0);
    expect(spots).toEqual([{ x: 2, y: 2, type: 'building', subtype: 'building' }]);
  });

  it('rolls all four insets before it looks for a room, and a room anywhere in its leaf — its far edge included — stops it', () => {
    // `engine/generator/map/Town.lua:89-98`: the draws, THEN "Abort if there is
    // something already" over `rx..rx+w` by `ry..ry+h`, inclusive.
    const leaf = { x: 3, y: 4, w: 14, h: 12 };
    const cases: [TileXY, boolean][] = [
      [{ x: 3, y: 4 }, true],
      [{ x: 10, y: 10 }, true],
      [{ x: 17, y: 16 }, true],
      [{ x: 17, y: 4 }, true],
      [{ x: 18, y: 16 }, false],
      [{ x: 17, y: 17 }, false],
      [{ x: 2, y: 10 }, false],
    ];
    for (const [room, stops] of cases) {
      const { rng, labels } = recording('abort');
      const { gen, map } = town(rng, { lshapeChance: 0 }, { w: 30, h: 30 });
      map.cell(room.x, room.y).room = 7;
      const spots: Spot[] = [];
      building(gen, leaf, spots);
      expect(labels.slice(0, 4)).toEqual([
        'mapgen.town.building.x1',
        'mapgen.town.building.x2',
        'mapgen.town.building.y1',
        'mapgen.town.building.y2',
      ]);
      const where = `room at ${key(room.x, room.y)}`;
      if (stops) {
        expect(labels, where).toHaveLength(4);
        expect(spots, where).toEqual([]);
        expect(Array.from(map.tiles).every((t) => t === -1)).toBe(true);
        expect(gen.isBuilding.every((v) => v === 0)).toBe(true);
      } else {
        expect(spots, where).toHaveLength(1);
      }
    }

    // A vault's `room = false` is Lua's false, and does not stop it.
    const { gen, map } = town('abort', { lshapeChance: 0 }, { w: 30, h: 30 });
    map.cell(10, 10).room = false;
    const spots: Spot[] = [];
    building(gen, leaf, spots);
    expect(spots).toHaveLength(1);
  });

  it('offers the L every floor cell at least 2 in from its walls, those included, and no other', () => {
    // `engine/generator/map/Town.lua:109`: `x1 + 2 .. x2 - 2` by `y1 + 2 .. y2 - 2`,
    // both ends in — read back off the insets drawn and the size of the list the
    // point is taken from.
    for (let s = 0; s < 30; s += 1) {
      const { rng, draws } = bounded(`inner:${String(s)}`);
      const { gen } = town(rng, { lshapeChance: 100 }, { w: 30, h: 30 });
      building(gen, { x: 0, y: 0, w: 22, h: 20 }, []);
      const drawn = (label: string): number => draws.find((d) => d.label === label)?.value ?? NaN;
      const x1 = drawn('mapgen.town.building.x1');
      const x2 = 22 - drawn('mapgen.town.building.x2');
      const y1 = drawn('mapgen.town.building.y1');
      const y2 = 20 - drawn('mapgen.town.building.y2');
      const inner = (x2 - 2 - (x1 + 2) + 1) * (y2 - 2 - (y1 + 2) + 1);
      const point = draws.find((d) => d.label === 'mapgen.town.lshape.point');
      expect(point?.hi, `seed ${String(s)}`).toBe(inner);
    }
  });

  it('draws the building`s door AFTER the L, from its walls as they stand', () => {
    // `engine/generator/map/Town.lua:115-122`.
    for (let s = 0; s < 20; s += 1) {
      const { rng, labels } = recording(`door-order:${String(s)}`);
      const { gen } = town(rng, { lshapeChance: 100 }, { w: 30, h: 30 });
      building(gen, { x: 0, y: 0, w: 22, h: 20 }, []);
      expect(labels.slice(4, 7)).toEqual([
        'mapgen.town.lshape',
        'mapgen.town.lshape.yard',
        'mapgen.town.lshape.point',
      ]);
      expect(labels.at(-2)).toBe('mapgen.town.lshape.door');
      expect(labels.at(-1)).toBe('mapgen.town.building.door');
    }
  });
});

describe('Town — Lshape', () => {
  // A building 2..12 by 3..11: the inner bounds are 4..10 by 5..9.
  const B = { x1: 2, x2: 12, y1: 3, y2: 11, ix1: 4, ix2: 10, iy1: 5, iy2: 9 };

  /**
   * The rule, written from `Town.lua:54-78` rather than taken from the port:
   * the new wall runs from the point to whichever outer wall is FARTHER on each
   * axis, measured from the inner bounds; the corner room lies between the
   * point and those far walls, the far walls included.
   */
  function expected(p: TileXY): { wall: Set<string>; corner: Set<string>; far: TileXY } {
    const farX = Math.abs(p.x - B.ix2) > Math.abs(p.x - B.ix1) ? B.x2 : B.x1;
    const farY = Math.abs(p.y - B.iy2) > Math.abs(p.y - B.iy1) ? B.y2 : B.y1;
    const wall = new Set<string>();
    for (let x = Math.min(p.x, farX); x <= Math.max(p.x, farX); x += 1) wall.add(key(x, p.y));
    for (let y = Math.min(p.y, farY); y <= Math.max(p.y, farY); y += 1) wall.add(key(p.x, y));
    const corner = new Set<string>();
    const xs = farX > p.x ? [p.x + 1, farX] : [farX, p.x - 1];
    const ys = farY > p.y ? [p.y + 1, farY] : [farY, p.y - 1];
    for (let x = xs[0] ?? 0; x <= (xs[1] ?? -1); x += 1) {
      for (let y = ys[0] ?? 0; y <= (ys[1] ?? -1); y += 1) corner.add(key(x, y));
    }
    return { wall, corner, far: { x: farX, y: farY } };
  }

  function lshape(
    seed: string | Rng,
    point: TileXY,
    data: Partial<TownData>,
  ): { map: GenMap; bdoor: GridList; before: number[] } {
    const { gen, map } = town(seed, data, { w: 16, h: 14 });
    for (let x = 0; x < 16; x += 1) for (let y = 0; y < 14; y += 1) map.set(x, y, TileCode.GREEN);
    const bdoor = stamp(map, B.x1, B.x2, B.y1, B.y2);
    const before = Array.from(map.tiles);
    Lshape(gen, bdoor, [point], B.x1, B.x2, B.y1, B.y2, B.ix1, B.ix2, B.iy1, B.iy2);
    return { map, bdoor, before };
  }

  // One point in each quarter: case 1 (far walls right and bottom) through 4.
  const POINTS: readonly TileXY[] = [
    { x: 5, y: 6 },
    { x: 9, y: 6 },
    { x: 9, y: 8 },
    { x: 5, y: 8 },
  ];

  it('does nothing, and draws nothing, when no inner cell is left', () => {
    const { rng, labels } = recording('empty');
    const { gen, map } = town(rng, {}, { w: 16, h: 14 });
    const bdoor = stamp(map, B.x1, B.x2, B.y1, B.y2);
    const before = Array.from(map.tiles);
    Lshape(gen, bdoor, [], B.x1, B.x2, B.y1, B.y2, B.ix1, B.ix2, B.iy1, B.iy2);
    expect(labels).toEqual([]);
    expect(Array.from(map.tiles)).toEqual(before);
  });

  it('rolls the yard, removes the point, and flips a coin for each axis the point is exactly central on', () => {
    // `engine/generator/map/Town.lua:46-51`. 2..8 by 2..8 has inner bounds 4..6,
    // so (5, 5) ties on both axes and (4, 5) only on y.
    const bounds = [2, 8, 2, 8, 4, 6, 4, 6] as const;
    const draws = (inner: TileXY[]): string[] => {
      const { rng, labels } = recording('ties');
      const { gen, map } = town(rng, {}, { w: 12, h: 12 });
      const bdoor = stamp(map, 2, 8, 2, 8);
      Lshape(gen, bdoor, inner, ...bounds);
      return labels;
    };
    // Two elements, so the removal draws; both central, so both coins do.
    expect(
      draws([
        { x: 5, y: 5 },
        { x: 5, y: 5 },
      ]),
    ).toEqual([
      'mapgen.town.lshape.yard',
      'mapgen.town.lshape.point',
      'mapgen.town.lshape.tie.x',
      'mapgen.town.lshape.tie.y',
      'mapgen.town.lshape.door',
    ]);
    // One element: `rng.tableRemove` of one draws nothing.
    expect(draws([{ x: 4, y: 5 }])).toEqual([
      'mapgen.town.lshape.yard',
      'mapgen.town.lshape.tie.y',
      'mapgen.town.lshape.door',
    ]);
    expect(draws([{ x: 4, y: 4 }])).toEqual(['mapgen.town.lshape.yard', 'mapgen.town.lshape.door']);
  });

  it('breaks a tie by adding one to a side, so a central point still finds exactly one pair of far walls', () => {
    // The coin's hit adds to dx1 and makes the LEFT wall the far one.
    const lefts = new Set<number>();
    for (let s = 0; s < 40; s += 1) {
      const { gen, map } = town(`tie:${String(s)}`, { yardChance: 0 }, { w: 12, h: 12 });
      const twin = rngFromState(gen.rng.getState());
      const bdoor = stamp(map, 2, 8, 2, 8);
      Lshape(gen, bdoor, [{ x: 5, y: 5 }], 2, 8, 2, 8, 4, 6, 4, 6);
      twin.int('yard', 0, 99);
      const leftFar = twin.int('tie.x', 0, 99) < 50;
      const topFar = twin.int('tie.y', 0, 99) < 50;
      const farX = leftFar ? 2 : 8;
      const farY = topFar ? 2 : 8;
      for (let x = Math.min(5, farX); x <= Math.max(5, farX); x += 1) {
        expect([TileCode.WALL, TileCode.DOOR]).toContain(map.get(x, 5));
      }
      for (let y = Math.min(5, farY); y <= Math.max(5, farY); y += 1) {
        expect([TileCode.WALL, TileCode.DOOR]).toContain(map.get(5, y));
      }
      // The near side stays open floor.
      expect(map.get(leftFar ? 6 : 4, 5)).toBe(TileCode.FLOOR);
      expect(map.get(5, topFar ? 6 : 4)).toBe(TileCode.FLOOR);
      lefts.add(farX);
    }
    expect(lefts).toEqual(new Set([2, 8]));
  });

  it('runs the new wall to the two FAR outer walls in every quarter, and leaves the corner room floor without a yard', () => {
    for (const p of POINTS) {
      const { wall, corner } = expected(p);
      const { map, before } = lshape(`quarter:${key(p.x, p.y)}`, p, { yardChance: 0 });
      const doors: string[] = [];
      for (let x = 0; x < 16; x += 1) {
        for (let y = 0; y < 14; y += 1) {
          const at = key(x, y);
          const code = map.get(x, y);
          if (wall.has(at)) {
            if (code === TileCode.DOOR) doors.push(at);
            else expect(code, `${key(p.x, p.y)}: the wall at ${at}`).toBe(TileCode.WALL);
          } else {
            expect(code, `${key(p.x, p.y)}: ${at} changed`).toBe(before[y * 16 + x]);
          }
        }
      }
      expect(doors, `point ${key(p.x, p.y)}`).toHaveLength(1);
      expect(corner.size).toBeGreaterThan(0);
    }
  });

  it('turns the corner room into street on a yard roll — the stretch of outer wall round it too', () => {
    for (const p of POINTS) {
      const { wall, corner, far } = expected(p);
      const { map, before } = lshape(`yard:${key(p.x, p.y)}`, p, { yardChance: 100 });
      for (let x = 0; x < 16; x += 1) {
        for (let y = 0; y < 14; y += 1) {
          const at = key(x, y);
          const code = map.get(x, y);
          if (wall.has(at)) expect([TileCode.WALL, TileCode.DOOR]).toContain(code);
          else if (corner.has(at))
            expect(code, `${key(p.x, p.y)}: yard at ${at}`).toBe(TileCode.GREEN);
          else expect(code, `${key(p.x, p.y)}: ${at} changed`).toBe(before[y * 16 + x]);
        }
      }
      // The outer wall's own cells went with it.
      expect(map.get(far.x, p.y + (far.y > p.y ? 1 : -1))).toBe(TileCode.GREEN);
      expect(map.get(p.x + (far.x > p.x ? 1 : -1), far.y)).toBe(TileCode.GREEN);
    }
  });

  it('removes none of the building`s door candidates: upstream names cells one step outside it (kept)', () => {
    // `engine/generator/map/Town.lua:58-59` and its three twins: `x2+1`, `x1-1`,
    // `y2+1`, `y1-1`. The cells meant — where the new wall meets the old — stay.
    for (const p of POINTS) {
      const { far } = expected(p);
      const { bdoor } = lshape(`bdoor:${key(p.x, p.y)}`, p, { yardChance: 0 });
      const listed = new Set(bdoor.toList().map((c) => key(c.x, c.y)));
      expect(bdoor.count()).toBe(2 * (B.x2 - B.x1 - 1) + 2 * (B.y2 - B.y1 - 1));
      expect(listed.has(key(far.x, p.y)), `joint on the x wall for ${key(p.x, p.y)}`).toBe(true);
      expect(listed.has(key(p.x, far.y)), `joint on the y wall for ${key(p.x, p.y)}`).toBe(true);
    }
  });

  it('hangs one door on the new wall, anywhere along it but the point itself, in every quarter', () => {
    for (const p of POINTS) {
      const { wall } = expected(p);
      const seen = new Set<string>();
      for (let s = 0; s < 300; s += 1) {
        const { map } = lshape(`lshape-door:${key(p.x, p.y)}:${String(s)}`, p, { yardChance: 0 });
        const doors = [...cellsOf(map, TileCode.DOOR)];
        expect(doors).toHaveLength(1);
        const door = doors[0] ?? '';
        expect(wall.has(door), key(p.x, p.y)).toBe(true);
        seen.add(door);
      }
      expect(seen.has(key(p.x, p.y))).toBe(false);
      expect(seen.size, key(p.x, p.y)).toBe(wall.size - 1);
    }
  });

  it('resolves external_floor over the corner room only on a yard roll', () => {
    // `engine/generator/map/Town.lua:57`: `if void then self.map(i, j, ..., self:resolve(...))`,
    // so with no yard the table is never drawn from. (5, 6)'s corner room is
    // 6..12 by 7..11: 35 cells.
    const p = { x: 5, y: 6 };
    const grid = { ...GRID, external_floor: [TileCode.GREEN, TileCode.HEATH] };
    for (const yardChance of [0, 100]) {
      const { rng, labels } = recording(`yard-resolve:${String(yardChance)}`);
      lshape(rng, p, { grid, yardChance });
      const resolves = labels.filter((l) => l === 'mapgen.resolve.external_floor');
      expect(resolves, `yard ${String(yardChance)}`).toHaveLength(yardChance === 0 ? 0 : 35);
    }
  });

  it('calls a tie coin of 0..49 heads, which makes the LEFT and TOP walls far, and 50..99 tails', () => {
    // `rng.percent(50)` is `rand_div(100) < 50` (`mapgen/lua.ts`). 2..8 square,
    // inner bounds 4..6, point (5, 5): central both ways.
    for (const [coin, heads] of [
      [49, true],
      [50, false],
    ] as const) {
      const { rng } = bounded('tie-coin', {
        'mapgen.town.lshape.tie.x': coin,
        'mapgen.town.lshape.tie.y': coin,
      });
      const { gen, map } = town(rng, { yardChance: 0 }, { w: 12, h: 12 });
      stamp(map, 2, 8, 2, 8);
      Lshape(gen, makeGridList(), [{ x: 5, y: 5 }], 2, 8, 2, 8, 4, 6, 4, 6);
      const walled = (x: number, y: number): boolean =>
        map.get(x, y) === TileCode.WALL || map.get(x, y) === TileCode.DOOR;
      expect([walled(3, 5), walled(5, 3)], `coin ${String(coin)}`).toEqual([heads, heads]);
      expect([walled(7, 5), walled(5, 7)], `coin ${String(coin)}`).toEqual([!heads, !heads]);
    }
  });
});

describe('Town — generate', () => {
  it('fills every cell with external_floor first, x outer, one resolve each', () => {
    // `engine/generator/map/Town.lua:128-130`. No `up`/`down` keys and no
    // buildings, so the fill is exactly what is left.
    const floors = [TileCode.GREEN, TileCode.HEATH, TileCode.TREES];
    const grid: GridKeys = { external_floor: floors, wall: TileCode.WALL };
    const { rng, labels } = recording('fill');
    const { map } = run(rng, { grid, buildingChance: 0, edgeEntrances: [4, 6] }, { w: 20, h: 15 });
    expect(labels.slice(0, 300)).toEqual(
      Array.from({ length: 300 }, () => 'mapgen.resolve.external_floor'),
    );
    expect(labels[300]).not.toBe('mapgen.resolve.external_floor');
    const twin = createRng('fill');
    for (let i = 0; i < 20; i += 1) {
      for (let j = 0; j < 15; j += 1) {
        expect(map.get(i, j), key(i, j)).toBe(floors[twin.int('fill', 1, 3) - 1]);
      }
    }
  });

  it('cuts the whole map with BSP, spending the engine`s draws, and rolls building_chance once per leaf in order', () => {
    // `engine/generator/map/Town.lua:174-182`: `BSP.new(w, h, max_w, max_h)` on
    // the default store. Nothing before it draws here, so a second tree from the
    // same seed is the same tree — IF it cuts with the C core's `range`, which
    // spends nothing on a cut with one position.
    let oneCuts = 0;
    for (let s = 0; s < 20; s += 1) {
      const seed = `bsp:${String(s)}`;
      const { rng, labels } = recording(seed);
      const { result } = run(
        rng,
        { buildingChance: 100, lshapeChance: 0, maxBuildingW: 8, maxBuildingH: 14 },
        { w: 50, h: 40 },
      );
      const leaves = partition(50, 40, 8, 14, createRng(seed), 'twin', BSP_MAX_DEPTH, range).leaves;
      const withInt = partition(50, 40, 8, 14, createRng(seed), 'twin').leaves;
      if (JSON.stringify(withInt) !== JSON.stringify(leaves)) oneCuts += 1;
      const buildings = (result?.spots ?? []).filter((sp) => sp.type === 'building');
      expect(buildings, seed).toHaveLength(leaves.length);
      expect(labels.filter((l) => l === 'mapgen.town.building')).toHaveLength(leaves.length);
      buildings.forEach((b, k) => {
        const leaf = leaves[k];
        if (leaf === undefined) throw new Error('more buildings than leaves');
        expect(b.x).toBeGreaterThanOrEqual(leaf.x + 2);
        expect(b.x).toBeLessThanOrEqual(leaf.x + leaf.w - 2);
        expect(b.y).toBeGreaterThanOrEqual(leaf.y + 2);
        expect(b.y).toBeLessThanOrEqual(leaf.y + leaf.h - 2);
      });
    }
    // The seeds include trees where the two dice disagree, or this proves nothing.
    expect(oneCuts).toBeGreaterThan(0);

    const empty = run('bsp:0', { buildingChance: 0 }, { w: 50, h: 40 });
    expect(empty.result?.spots).toEqual([]);
    expect(cellsOf(empty.map, TileCode.WALL).size).toBe(0);
  });

  it('never reads double_lshape_chance', () => {
    const tiles = (chance: number): number[] =>
      Array.from(run('double', { doubleLshapeChance: chance, lshapeChance: 100 }).map.tiles);
    expect(tiles(0)).toEqual(tiles(100));
  });

  it('places rooms before any building, and builds nothing within two cells of one', () => {
    let placed = 0;
    let closest = Infinity;
    for (let s = 0; s < 20; s += 1) {
      const { rng, labels } = recording(`rooms-first:${String(s)}`);
      const { map, gen } = run(rng, {
        buildingChance: 100,
        maxBuildingW: 8,
        maxBuildingH: 8,
        nbRooms: 3,
        rooms: ['simple', 'lesser_vault'],
      });
      const firstBsp = labels.findIndex((l) => l.startsWith('mapgen.town.bsp'));
      const lastAlloc = labels.findLastIndex((l) => l.startsWith('mapgen.roomer.alloc'));
      expect(lastAlloc).toBeLessThan(firstBsp);
      placed += map.rooms.length;
      // A room cell is one `building` would have stopped for: `room` set.
      const roomCells: TileXY[] = [];
      for (let x = 0; x < map.w; x += 1) {
        for (let y = 0; y < map.h; y += 1)
          if (map.cell(x, y).room !== null) roomCells.push({ x, y });
      }
      let nearest = Infinity;
      for (let x = 0; x < map.w; x += 1) {
        for (let y = 0; y < map.h; y += 1) {
          if (gen.isBuilding[y * map.w + x] !== 1) continue;
          for (const r of roomCells) {
            nearest = Math.min(nearest, Math.max(Math.abs(r.x - x), Math.abs(r.y - y)));
          }
        }
      }
      // Inset 2 from a leaf that holds no room cell, boundary included: 3 or more.
      expect(nearest, `rooms-first:${String(s)}`).toBeGreaterThanOrEqual(3);
      closest = Math.min(closest, nearest);
    }
    expect(placed).toBeGreaterThan(20);
    // And the bound is met, or the leaf test could be looser and still pass.
    expect(closest).toBe(3);
  });

  it('asks for the level again when a required room cannot be placed, and builds nothing', () => {
    // A 6x6 map leaves `simple` (5 wide at least) under the two tiles it needs.
    const { rng, labels } = recording('required');
    const { result, forceRecreate } = run(rng, { requiredRooms: ['simple'] }, { w: 6, h: 6 });
    expect(result).toBeNull();
    expect(forceRecreate).toMatch(/^required_room /);
    expect(labels.some((l) => l.startsWith('mapgen.town.bsp'))).toBe(false);
  });

  it('tries random rooms nb_rooms * 1.5 times, counted as a float, and spends a placed required room', () => {
    // No room fits a 6x6 map, so every try fails and is counted.
    for (const [nb, tries] of [
      [1, 2],
      [2, 3],
      [3, 5],
      [4, 6],
    ] as const) {
      const { map } = run('tries', { nbRooms: nb, rooms: ['simple'] }, { w: 6, h: 6 });
      expect(map.roomsFailed, `nb_rooms ${String(nb)}`).toHaveLength(tries);
    }
    // A placed required room uses one up: none left to try at random.
    const { rng, labels } = recording('spent');
    const spent = run(rng, { nbRooms: 1, requiredRooms: ['simple'], rooms: ['simple'] });
    expect(spent.map.rooms).toHaveLength(1);
    expect(labels).not.toContain('mapgen.town.room.pick');
    // `nb_rooms` as a table is ONE draw.
    const { rng: tableRng, labels: tableLabels } = recording('nb-table');
    run(tableRng, { nbRooms: [0, 2], rooms: ['simple'] });
    expect(tableLabels.filter((l) => l === 'mapgen.town.nb_rooms')).toHaveLength(1);
  });

  it('re-picks a chance room until its roll passes: a chance of 0 is never placed', () => {
    // `engine/generator/map/Town.lua:158-167`.
    for (let n = 0; n < 6; n += 1) {
      const { map } = run(`chance-room:${String(n)}`, {
        nbRooms: 3,
        rooms: [['lesser_vault', 0], 'simple'],
      });
      expect(map.rooms.length).toBeGreaterThan(0);
      for (const r of map.rooms) expect(r.room.name).toMatch(/^simple/);
    }
  });

  it('pushes a vault`s entrance spot onto the level`s spots, beside the buildings', () => {
    const { result } = run('vault-spot', { nbRooms: 1, rooms: ['lesser_vault'] });
    const spots = result?.spots ?? [];
    expect(
      spots.filter((sp) => sp.type === 'vault' && sp.checkConnectivity === 'entrance'),
    ).toHaveLength(1);
    expect(spots.some((sp) => sp.type === 'building')).toBe(true);
  });
});

describe('Town — stairs', () => {
  it('puts each stair on its edge, corners included, marked exit, down first', () => {
    // `engine/generator/map/Town.lua:224-260`: `rng.range(0, len - 1)`.
    const sides = [
      [4, 6],
      [6, 4],
      [8, 2],
      [2, 8],
    ] as const;
    for (const [upSide, downSide] of sides) {
      const along = { up: new Set<number>(), down: new Set<number>() };
      for (let s = 0; s < 80; s += 1) {
        const { rng, labels } = recording(`edges:${String(upSide)}:${String(s)}`);
        const { map, result } = run(
          rng,
          { buildingChance: 0, edgeEntrances: [upSide, downSide] },
          { w: 7, h: 5 },
        );
        const { up, down } = result ?? { up: null, down: null };
        if (up === null || down === null) throw new Error('a stair is missing');
        const onEdge = (at: TileXY, side: number): boolean =>
          side === 4 ? at.x === 0 : side === 6 ? at.x === 6 : side === 8 ? at.y === 0 : at.y === 4;
        expect(onEdge(up, upSide)).toBe(true);
        expect(onEdge(down, downSide)).toBe(true);
        expect(map.get(up.x, up.y)).toBe(TileCode.PAVING);
        expect(map.get(down.x, down.y)).toBe(TileCode.COBBLE);
        expect(map.cell(up.x, up.y).special).toBe('exit');
        expect(map.cell(down.x, down.y).special).toBe('exit');
        expect(labels.find((l) => l.startsWith('mapgen.town.stairs'))).toBe(
          'mapgen.town.stairs.down.side',
        );
        along.up.add(upSide === 4 || upSide === 6 ? up.y : up.x);
        along.down.add(downSide === 4 || downSide === 6 ? down.y : down.x);
      }
      const len = upSide === 4 || upSide === 6 ? 5 : 7;
      const all = Array.from({ length: len }, (_, i) => i);
      expect([...along.up].sort((a, b) => a - b)).toEqual(all);
      expect([...along.down].sort((a, b) => a - b)).toEqual(all);
    }
  });

  it('skips a special cell on the edge, and stands on a wall without asking', () => {
    for (let s = 0; s < 20; s += 1) {
      const { gen, map } = town(`side-special:${String(s)}`, {}, { w: 8, h: 6 });
      for (let x = 0; x < 8; x += 1) for (let y = 0; y < 6; y += 1) map.set(x, y, TileCode.WALL);
      for (let y = 0; y < 6; y += 1) {
        if (y !== 3) map.cell(0, y).special = true;
        if (y !== 1) map.cell(7, y).special = 'pond';
      }
      const { up, down } = makeStairsSides(gen, 1, 0, [4, 6], []);
      expect(up).toEqual({ x: 0, y: 3 });
      expect(down).toEqual({ x: 7, y: 1 });
    }
  });

  it('places no down stair on the zone`s last level unless forced', () => {
    const last = run(
      'last',
      { buildingChance: 0, edgeEntrances: [4, 6] },
      { level: 3, maxLevel: 3 },
    );
    expect(last.result?.down).toBeNull();
    expect(last.result?.up).not.toBeNull();
    const forced = run(
      'last',
      { buildingChance: 0, edgeEntrances: [4, 6], forceLastStair: true },
      { level: 3, maxLevel: 3 },
    );
    expect(forced.result?.down).not.toBeNull();
    const inside = run('last', { buildingChance: 0 }, { level: 3, maxLevel: 3 });
    expect(inside.result?.down).toBeNull();
    const insideForced = run(
      'last',
      { buildingChance: 0, forceLastStair: true },
      { level: 3, maxLevel: 3 },
    );
    expect(insideForced.result?.down).not.toBeNull();
  });

  it('without edge_entrances, puts the down stair then the up on open cells in 1..w-1 by 1..h-1 that are not special', () => {
    // `engine/generator/map/Town.lua:195-221`.
    const used = new Set<string>();
    for (let s = 0; s < 60; s += 1) {
      const { gen, map } = town(`inside:${String(s)}`, {}, { w: 8, h: 8 });
      for (let x = 0; x < 8; x += 1) for (let y = 0; y < 8; y += 1) map.set(x, y, TileCode.WALL);
      // Open: the far corner, one inner cell, one on column 0 (never drawn), one special.
      for (const [x, y] of [
        [7, 7],
        [3, 4],
        [0, 2],
        [5, 5],
      ] as const) {
        map.set(x, y, TileCode.FLOOR);
      }
      map.cell(5, 5).special = true;
      const twin = rngFromState(gen.rng.getState());
      const { up, down } = makeStairsInside(gen, 1, 0, []);
      const open = new Set(['7,7', '3,4']);
      const next = (): string => {
        for (;;) {
          const x = twin.int('x', 1, 7);
          const at = key(x, twin.int('y', 1, 7));
          if (open.has(at)) return at;
        }
      };
      const first = next();
      open.delete(first);
      expect(key(down?.x ?? -1, down?.y ?? -1), `seed ${String(s)}`).toBe(first);
      expect(key(up?.x ?? -1, up?.y ?? -1), `seed ${String(s)}`).toBe(next());
      used.add(first);
    }
    expect(used).toEqual(new Set(['7,7', '3,4']));
  });

  it('gives up and asks for the level again when no cell will take a stair', () => {
    const { gen, map, level } = town('no-stair', {}, { w: 6, h: 6 });
    for (let x = 0; x < 6; x += 1) for (let y = 0; y < 6; y += 1) map.set(x, y, TileCode.WALL);
    const result = makeStairsInside(gen, 1, 0, []);
    expect(result.down).toBeNull();
    expect(result.up).toBeNull();
    expect(level.forceRecreate).toMatch(/no cell for the down stair/);
  });
});

describe('Town — the zones', () => {
  const zones: [string, TownLevelSpec, number][] = [
    ['halfling-ruins', TOWN_HALFLING_RUINS, 4],
    ['rhaloren-camp', TOWN_RHALOREN_CAMP, 3],
  ];

  const level = (spec: TownLevelSpec, seed: string, maxLevel: number): ReturnType<typeof run> =>
    run(seed, spec.map, { w: spec.width, h: spec.height, maxLevel });

  /**
   * `Zone:newLevel`'s refusal (`engine/Zone.lua:1131-1158`), as `mapgen/level.ts`
   * asks it — through the connectivity helper, on the generated map: the up
   * stair reaches the down stair, and every vault entrance reaches the up stair.
   */
  function certified(
    map: GenMap,
    result: TownResult | null,
    forceRecreate: string | null,
  ): boolean {
    if (result === null || forceRecreate !== null) return false;
    const { up, down, spots } = result;
    if (up === null || down === null || !reachable(map, up, down)) return false;
    return spots.every(
      (sp) =>
        sp.checkConnectivity !== 'entrance' ||
        (sp.x === up.x && sp.y === up.y) ||
        reachable(map, sp, up),
    );
  }

  /** `newLevel`'s loop: attempt `n` is the seed `${seed}#${n}`, fifty at most. */
  function attemptsToCertify(spec: TownLevelSpec, seed: string, maxLevel: number): number {
    for (let n = 1; n <= 50; n += 1) {
      const { map, result, forceRecreate } = level(spec, `${seed}#${String(n)}`, maxLevel);
      if (certified(map, result, forceRecreate)) return n;
    }
    return Infinity;
  }

  it('puts both stairs on the zone`s edges, and leaves a street two wide on the left and top and one wide on the right and bottom', () => {
    // `x1 = rx + range(2, ...)` but `x2 = rx + w - range(2, ...)`, and the last
    // leaf ends AT the map's width: so column w-2 can be wall, and column 1 never.
    for (const [name, spec, maxLevel] of zones) {
      const [upSide, downSide] = spec.map.edgeEntrances ?? [0, 0];
      const x = (side: number): number => (side === 4 ? 0 : spec.width - 1);
      const w = spec.width;
      const h = spec.height;
      let nearRight = 0;
      let nearBottom = 0;
      for (let s = 0; s < 40; s += 1) {
        const seed = `${name}:${String(s)}`;
        const { result, forceRecreate, gen } = level(spec, seed, maxLevel);
        expect(forceRecreate, seed).toBeNull();
        expect(result?.up?.x, seed).toBe(x(upSide));
        expect(result?.down?.x, seed).toBe(x(downSide));
        const built: string[] = [];
        for (let i = 0; i < w; i += 1) {
          for (let j = 0; j < h; j += 1) {
            if (gen.isBuilding[j * w + i] !== 1) continue;
            if (i <= 1 || j <= 1 || i === w - 1 || j === h - 1) built.push(key(i, j));
            if (i === w - 2) nearRight += 1;
            if (j === h - 2) nearBottom += 1;
          }
        }
        expect(built, seed).toEqual([]);
      }
      expect(nearRight, name).toBeGreaterThan(0);
      expect(nearBottom, name).toBeGreaterThan(0);
    }
  });

  it('halfling-ruins: joins the up stair to the down stair on every one of 40 seeds, because its outer ring is all floor', () => {
    // No tree and no room can stand in the ring, and both stairs are on it.
    for (let s = 0; s < 40; s += 1) {
      const seed = `halfling-ruins:${String(s)}`;
      const { map, result, forceRecreate } = level(TOWN_HALFLING_RUINS, seed, 4);
      expect(certified(map, result, forceRecreate), seed).toBe(true);
      const ring: string[] = [];
      for (let i = 0; i < 50; i += 1) {
        for (let j = 0; j < 50; j += 1) {
          const onRing = i === 0 || j === 0 || i === 49 || j === 49;
          if (onRing && map.get(i, j) !== TileCode.FLOOR) ring.push(key(i, j));
        }
      }
      expect(ring, seed).toEqual([]);
    }
  });

  it('rhaloren-camp: certifies every one of 40 seeds within newLevel`s attempts, nearly all on the first', () => {
    /**
     * NOT EVERY CAMP IS JOINED, AND UPSTREAM'S ARE NOT EITHER. Its street holds a
     * tree in sixteen cells, and on the right edge it can be one cell wide beside
     * a wall (the test above), so two trees can cut off the stretch a stair
     * stands in. Measured over 3,000 seeds, 40 first attempts (1.3%) were
     * refused, 39 of them for the down stair on that right edge, and every seed
     * certified by its second attempt.
     */
    let refused = 0;
    for (let s = 0; s < 40; s += 1) {
      const n = attemptsToCertify(TOWN_RHALOREN_CAMP, `rhaloren-camp:${String(s)}`, 3);
      expect(n, `rhaloren-camp:${String(s)}`).toBeLessThanOrEqual(3);
      if (n > 1) refused += 1;
    }
    expect(refused).toBeLessThanOrEqual(3);
  });

  it('is the same town for the same seed and a different one for another', () => {
    const tiles = (seed: string): string =>
      Array.from(level(TOWN_RHALOREN_CAMP, seed, 3).map.tiles).join(',');
    expect(tiles('same')).toBe(tiles('same'));
    expect(tiles('same')).not.toBe(tiles('other'));
  });

  it('the halfling ruins are walls standing in floor; the Rhaloren camp is stone in a wood, with a vault on most levels', () => {
    for (let s = 0; s < 10; s += 1) {
      const { map } = level(TOWN_HALFLING_RUINS, `ruins:${String(s)}`, 4);
      const codes = new Set(map.tiles);
      expect(codes).toEqual(new Set([TileCode.FLOOR, TileCode.WALL, TileCode.DOOR]));
      expect(map.rooms).toHaveLength(0);
    }
    let vaults = 0;
    let bare = 0;
    let trees = 0;
    let grass = 0;
    for (let s = 0; s < 40; s += 1) {
      const { map } = level(TOWN_RHALOREN_CAMP, `camp:${String(s)}`, 3);
      vaults += map.rooms.length;
      if (map.rooms.length === 0) bare += 1;
      trees += cellsOf(map, TileCode.TREES).size;
      grass += cellsOf(map, TileCode.GREEN).size;
    }
    // `nb_rooms = {0,1,1,2}`: one in four levels asks for none.
    expect(bare).toBeGreaterThan(3);
    expect(vaults).toBeGreaterThan(25);
    // One street cell in sixteen is a tree.
    expect(trees / (trees + grass)).toBeGreaterThan(0.04);
    expect(trees / (trees + grass)).toBeLessThan(0.09);
  });
});
