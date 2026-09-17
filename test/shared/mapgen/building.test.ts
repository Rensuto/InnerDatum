// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// The generator under test is ported from t-engine4 game/engines/default/engine/generator/map/Building.lua:33-326
//   and the layout roll from game/modules/tome/data/zones/infinite-dungeon/zone.lua:153-162.
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

import { describe, expect, it } from 'vitest';

import type { TileXY } from '../../../src/shared/coords.ts';
import {
  BUILDING_INFINITE_DUNGEON,
  addWall,
  add_check,
  block,
  building,
  createBuilding,
  doorOnWall,
  generate,
  infiniteDungeonBuilding,
  infiniteDungeonSize,
  makeStairsInside,
  makeStairsSides,
} from '../../../src/shared/mapgen/building.ts';
import type {
  BuildingData,
  BuildingGen,
  BuildingResult,
  Wall,
} from '../../../src/shared/mapgen/building.ts';
import { reachable } from '../../../src/shared/mapgen/connectivity.ts';
import { createGenMap } from '../../../src/shared/mapgen/genmap.ts';
import type { GenMap, GridKeys, Spot } from '../../../src/shared/mapgen/genmap.ts';
import { mathRandom } from '../../../src/shared/mapgen/lua.ts';
import type { AsciiRoom, LoadedRoom } from '../../../src/shared/mapgen/rooms-loader.ts';
import { TileCode } from '../../../src/shared/protocol.ts';
import { createRng } from '../../../src/shared/rng.ts';
import type { Rng } from '../../../src/shared/rng.ts';
import { VAULTS_BY_SHAPE } from '../../../src/shared/vaults.ts';

/** Distinct codes for every key, so a cell says which key wrote it. */
const GRID: GridKeys = {
  floor: TileCode.FLOOR,
  wall: TileCode.WALL,
  door: TileCode.DOOR,
  up: TileCode.FLOOR,
  down: TileCode.FLOOR,
  external_floor: TileCode.GREEN,
  outside_floor: TileCode.YARD,
  '.': TileCode.FLOOR,
  '#': TileCode.WALL,
};

const GLYPH = new Map<TileCode, string>([
  [TileCode.FLOOR, '.'],
  [TileCode.WALL, '#'],
  [TileCode.DOOR, '+'],
  [TileCode.GREEN, ','],
  [TileCode.YARD, '~'],
]);
const CODE = new Map<string, TileCode>([...GLYPH].map(([code, glyph]) => [glyph, code]));

function rows(map: GenMap): string[] {
  const out: string[] = [];
  for (let y = 0; y < map.h; y += 1) {
    let row = '';
    for (let x = 0; x < map.w; x += 1) {
      const code = map.get(x, y);
      row += code === null ? '?' : (GLYPH.get(code) ?? '?');
    }
    out.push(row);
  }
  return out;
}

function paint(map: GenMap, drawing: readonly string[]): void {
  drawing.forEach((row, y) => {
    for (let x = 0; x < row.length; x += 1) map.set(x, y, CODE.get(row.charAt(x)) ?? null);
  });
}

type Setup = { gen: BuildingGen; map: GenMap; level: { forceRecreate: string | null } };

function setup(
  data: Partial<BuildingData>,
  opts: { w?: number; h?: number; seed?: string; rng?: Rng; maxLevel?: number } = {},
): Setup {
  const rng = opts.rng ?? createRng(opts.seed ?? 'building');
  const grid = data.grid ?? GRID;
  const map = createGenMap(opts.w ?? 20, opts.h ?? 20, grid, rng);
  const level = { forceRecreate: null as string | null };
  const gen = createBuilding(map, { ...data, grid }, rng, { maxLevel: opts.maxLevel ?? 3 }, level);
  return { gen, map, level };
}

function run(
  data: Partial<BuildingData>,
  opts: {
    w?: number;
    h?: number;
    seed?: string;
    rng?: Rng;
    level?: number;
    maxLevel?: number;
  } = {},
): Setup & { result: BuildingResult | null } {
  const s = setup(data, opts);
  return { ...s, result: generate(s.gen, opts.level ?? 1, 0) };
}

type Draw = { label: string; lo?: number; hi?: number };

/** An Rng that records every draw: its label, and its bounds for `int`. */
function recording(seed: string): { rng: Rng; draws: Draw[] } {
  const inner = createRng(seed);
  const draws: Draw[] = [];
  const rng: Rng = {
    ...inner,
    nextU32: (label) => {
      draws.push({ label });
      return inner.nextU32(label);
    },
    nextFloat: (label) => {
      draws.push({ label });
      return inner.nextFloat(label);
    },
    int: (label, lo, hi) => {
      draws.push({ label, lo, hi });
      return inner.int(label, lo, hi);
    },
  };
  return { rng, draws };
}

/** A grid whose every key is a function that logs its own name. */
function loggingGrid(log: string[], codes: Readonly<Record<string, TileCode>>): GridKeys {
  return Object.fromEntries(
    Object.entries(codes).map(([key, code]) => [
      key,
      () => {
        log.push(key);
        return code;
      },
    ]),
  );
}

/** A plain ASCII room, for the room tests: walls round a floor. */
function asciiRoom(w: number, h: number, extra: Partial<AsciiRoom> = {}): AsciiRoom {
  const rowsOf: string[] = [];
  for (let j = 0; j < h; j += 1) {
    rowsOf.push(j === 0 || j === h - 1 ? '#'.repeat(w) : `#${'.'.repeat(w - 2)}#`);
  }
  return { name: `ascii${String(w)}x${String(h)}`, w, h, rows: rowsOf, ...extra };
}

/** The Infinite Dungeon's layout for one floor, rolled as the zone table would. */
function gearford(seed: string, lev: number): BuildingData {
  const layout = infiniteDungeonBuilding(
    createRng(`${seed}:layout`),
    infiniteDungeonSize(lev),
    BUILDING_INFINITE_DUNGEON.width,
    BUILDING_INFINITE_DUNGEON.height,
    lev,
  );
  return { ...BUILDING_INFINITE_DUNGEON.map, ...layout };
}

describe('Building:init', () => {
  it('writes upstream`s defaults for every field a zone leaves out', () => {
    const { gen } = setup({}, { w: 31, h: 21 });
    expect([gen.maxBlockW, gen.maxBlockH, gen.maxBuildingW, gen.maxBuildingH]).toEqual([
      20, 20, 7, 7,
    ]);
    expect([gen.marginW, gen.marginH]).toEqual([0, 0]);
    // `(map.w - 2*margin_w)/2 - 1`, left a float on an odd map.
    expect([gen.maxRoomW, gen.maxRoomH]).toEqual([14.5, 9.5]);
    // A building's light is `or 70`, a room's `or 100`.
    expect([gen.buildingLiteChance, gen.data.liteRoomChance]).toEqual([70, 100]);
    expect([gen.data.tunnelChange, gen.data.tunnelRandom]).toEqual([30, 10]);
  });

  it('counts the margins in the room limit, and keeps a zero chance as zero', () => {
    const { gen } = setup({ marginW: 3, marginH: 2, liteRoomChance: 0 }, { w: 31, h: 21 });
    expect([gen.maxRoomW, gen.maxRoomH]).toEqual([11.5, 7.5]);
    // 0 is a value in Lua, not nil: neither default replaces it.
    expect([gen.buildingLiteChance, gen.data.liteRoomChance]).toEqual([0, 0]);
  });
});

describe('add_check — Building.lua:172-181', () => {
  it('limits the width WITH the border and the height WITHOUT it, as written', () => {
    const { gen } = setup({ maxRoomW: 10, maxRoomH: 10 }, { w: 40, h: 40 });
    const room = (w: number, h: number): AsciiRoom => asciiRoom(w, h, { border: 1 });
    // w + 2*border > max_room_w
    expect(add_check(gen, room(8, 3), 5, 5)).toBe(true);
    expect(add_check(gen, room(9, 3), 5, 5)).toBe(false);
    // h > max_room_h + 2*border: four cells taller than the width may be.
    expect(add_check(gen, room(3, 12), 5, 5)).toBe(true);
    expect(add_check(gen, room(3, 13), 5, 5)).toBe(false);
  });

  it('keeps a room strictly inside the margins, its border counted on both sides', () => {
    const { gen } = setup({ marginW: 2, marginH: 3 }, { w: 40, h: 30 });
    const room = asciiRoom(5, 4, { border: 1 });
    // x > margin_w + border, and x + w + border < map.w - margin_w
    expect([3, 4, 31, 32].map((x) => add_check(gen, room, x, 10))).toEqual([
      false,
      true,
      true,
      false,
    ]);
    // y > margin_h + border, and y + h + border < map.h - margin_h
    expect([4, 5, 21, 22].map((y) => add_check(gen, room, 10, y))).toEqual([
      false,
      true,
      true,
      false,
    ]);
    // No border is 0.
    const bare = asciiRoom(5, 4);
    expect([2, 3, 32, 33].map((x) => add_check(gen, bare, x, 10))).toEqual([
      false,
      true,
      true,
      false,
    ]);
  });
});

describe('addWall — Building.lua:65-97', () => {
  const wallOf = (drawing: readonly string[]): Setup => {
    const s = setup({}, { w: drawing[0]?.length ?? 0, h: drawing.length });
    paint(s.map, drawing);
    return s;
  };
  const walledRow = (s: Setup, y: number): number[] =>
    Array.from({ length: s.map.w }, (_, x) => s.gen.walled[y * s.map.w + x] ?? -1);

  it('keeps a wall cell that blocks on exactly two sides, drops the ends, and walls every cell', () => {
    const s = wallOf([',,,,,', '#####', ',,,,,']);
    const wall = addWall(s.gen, false, 1, 0, 4);
    expect(wall).toEqual({ vert: false, base: 1, ps: [1, 2, 3], doored: false });
    expect(s.gen.walls).toEqual([wall]);
    expect(walledRow(s, 1)).toEqual([1, 1, 1, 1, 1]);
    // The ends are the line's, not the drawing's.
    expect(addWall(s.gen, false, 1, 1, 3).ps).toEqual([2]);
  });

  it('drops an open cell even with walls on two sides, and a junction', () => {
    const open = wallOf([',,,,,', '##,##', ',,,,,']);
    expect(addWall(open.gen, false, 1, 0, 4).ps).toEqual([]);
    expect(walledRow(open, 1)).toEqual([1, 1, 1, 1, 1]);

    const junction = wallOf([',,#,,,', '######', ',,,,#,']);
    expect(addWall(junction.gen, false, 1, 0, 5).ps).toEqual([1, 3]);
  });

  it('counts blocking sides, not a straight line: two sides at a corner qualify', () => {
    // (2,1) blocks north and west only.
    const s = wallOf([',,#,', '###,', ',,,,']);
    expect(addWall(s.gen, false, 1, 0, 3).ps).toEqual([1, 2]);
  });

  it('skips a special cell and a closed room cell without walling them; an open room cell is a wall cell', () => {
    const s = wallOf([',,,,,,,', '#######', ',,,,,,,']);
    s.map.cell(2, 1).special = true;
    s.map.cell(4, 1).room = 5;
    s.map.cell(5, 1).room = 5;
    s.map.cell(5, 1).canOpen = true;
    expect(addWall(s.gen, false, 1, 0, 6).ps).toEqual([1, 3, 5]);
    expect(walledRow(s, 1)).toEqual([1, 1, 0, 1, 0, 1, 1]);
  });

  it('reads a column as (base, z)', () => {
    const s = wallOf([',#,', ',#,', ',#,', ',#,', ',#,']);
    expect(addWall(s.gen, true, 1, 0, 4).ps).toEqual([1, 2, 3]);
    expect([0, 1, 2, 3, 4].map((y) => s.gen.walled[y * 3 + 1])).toEqual([1, 1, 1, 1, 1]);
    expect(s.gen.walled[0]).toBe(0);
  });

  it('strikes from each older wall on the same line only the cells the newer wall kept', () => {
    const s = wallOf([',,,,,,,', '#######', ',,,,,,,']);
    const older = addWall(s.gen, false, 1, 0, 6);
    expect(older.ps).toEqual([1, 2, 3, 4, 5]);
    // 2 and 4 are the newer wall's ends and it drops them, so the older keeps them.
    const newer = addWall(s.gen, false, 1, 2, 4);
    expect(newer.ps).toEqual([3]);
    expect(older.ps).toEqual([1, 2, 4, 5]);
    // A COLUMN at x = 1 shares the base number and not the line.
    const column = addWall(s.gen, true, 1, 0, 2);
    expect(column.ps).toEqual([1]);
    expect(older.ps).toEqual([1, 2, 4, 5]);
    expect(s.gen.walls).toEqual([older, newer, column]);
  });
});

describe('doorOnWall — Building.lua:51-62', () => {
  /** An Rng whose `int` always answers its upper bound, recording the call. */
  const topRng = (draws: Draw[]): Rng => ({
    ...createRng('door'),
    int: (label, lo, hi) => {
      draws.push({ label, lo, hi });
      return hi;
    },
  });

  it('hangs `door` on the candidate `rng.table` picks, row or column', () => {
    const draws: Draw[] = [];
    const s = setup({}, { w: 9, h: 9, rng: topRng(draws) });
    const row: Wall = { vert: false, base: 3, ps: [2, 5, 7], doored: false };
    doorOnWall(s.gen, row);
    expect(draws).toEqual([{ label: 'mapgen.building.door', lo: 1, hi: 3 }]);
    expect(s.map.get(7, 3)).toBe(TileCode.DOOR);
    expect(row.doored).toBe(true);

    const column: Wall = { vert: true, base: 3, ps: [2, 5], doored: false };
    doorOnWall(s.gen, column);
    expect(s.map.get(3, 5)).toBe(TileCode.DOOR);
    expect(s.map.tiles.filter((t) => t === TileCode.DOOR)).toHaveLength(2);
  });

  it('draws for an empty wall and resolves the door, and writes nothing', () => {
    const draws: Draw[] = [];
    const log: string[] = [];
    const rng = topRng(draws);
    const map = createGenMap(5, 5, loggingGrid(log, { door: TileCode.DOOR }), rng);
    const gen = createBuilding(
      map,
      { grid: loggingGrid(log, { door: TileCode.DOOR }) },
      rng,
      { maxLevel: 3 },
      { forceRecreate: null },
    );
    const empty: Wall = { vert: false, base: 1, ps: [], doored: false };
    doorOnWall(gen, empty);
    // `rng.range(1, 0)` swaps to 0..1 and draws.
    expect(draws).toEqual([{ label: 'mapgen.building.door', lo: 0, hi: 1 }]);
    expect(log).toEqual(['door']);
    expect(Array.from(map.tiles).every((t) => t === -1)).toBe(true);
    expect(empty.doored).toBe(true);
  });

  it('spends no draw on a one-candidate wall', () => {
    const draws: Draw[] = [];
    const s = setup({}, { w: 5, h: 5, rng: topRng(draws) });
    doorOnWall(s.gen, { vert: true, base: 2, ps: [3], doored: false });
    expect(draws).toEqual([]);
    expect(s.map.get(2, 3)).toBe(TileCode.DOOR);
  });
});

describe('building — Building.lua:100-129', () => {
  const lawn = (w: number, h: number, data: Partial<BuildingData> = {}): Setup => {
    const s = setup(data, { w, h });
    for (let i = 0; i < w * h; i += 1) s.map.tiles[i] = TileCode.GREEN;
    return s;
  };

  it('walls the edge of [rx, rx+w] x [ry, ry+h] INCLUSIVE, floors the inside, then its four walls and a spot', () => {
    // Two room files loaded: upstream's `#self.rooms` counts them before any building.
    const s = lawn(9, 7, { rooms: ['simple', 'pit'] });
    building(s.gen, { x: 1, y: 1, w: 5, h: 4 }, s.map.spots);
    expect(rows(s.map)).toEqual([
      ',,,,,,,,,',
      ',######,,',
      ',#....#,,',
      ',#....#,,',
      ',#....#,,',
      ',######,,',
      ',,,,,,,,,',
    ]);
    const record = s.gen.buildings[0];
    expect(record).toMatchObject({ id: 2, x1: 1, y1: 1, x2: 6, y2: 5, cx: 3, cy: 3 });
    // up, down, left, right — in that order, and in `self.walls` too.
    expect([record?.walls.up, record?.walls.down, record?.walls.left, record?.walls.right]).toEqual(
      [
        { vert: false, base: 1, ps: [2, 3, 4, 5], doored: false },
        { vert: false, base: 5, ps: [2, 3, 4, 5], doored: false },
        { vert: true, base: 1, ps: [2, 3, 4], doored: false },
        { vert: true, base: 6, ps: [2, 3, 4], doored: false },
      ],
    );
    expect(s.gen.walls).toEqual([
      record?.walls.up,
      record?.walls.down,
      record?.walls.left,
      record?.walls.right,
    ]);
    expect(s.map.spots).toEqual([{ x: 3, y: 3, type: 'building', subtype: 'building' }]);
    // Every edge cell may now be opened.
    expect(s.map.cell(1, 3).canOpen).toBe(true);
    expect(s.map.cell(3, 3).canOpen).toBeNull();
  });

  it('rolls `lite_room_chance or 70` FIRST, before any terrain is resolved', () => {
    for (const seed of ['lit-a', 'lit-b', 'lit-c', 'lit-d']) {
      const { rng, draws } = recording(seed);
      // Resolves land in the same list as draws, so their order is visible.
      const logged = (key: string, code: TileCode) => (): TileCode => {
        draws.push({ label: key });
        return code;
      };
      const grid: GridKeys = {
        wall: logged('wall', TileCode.WALL),
        floor: logged('floor', TileCode.FLOOR),
      };
      const gen = createBuilding(
        createGenMap(9, 7, grid, rng),
        { grid, liteRoomChance: 30 },
        rng,
        { maxLevel: 3 },
        { forceRecreate: null },
      );
      building(gen, { x: 1, y: 1, w: 5, h: 4 }, []);
      expect(draws[0]).toEqual({ label: 'mapgen.building.lit', lo: 0, hi: 99 });
      // 6 by 5 cells: an 18-cell edge and a 12-cell inside, each resolved once,
      // and no other draw.
      const rest = draws.slice(1).map((d) => d.label);
      expect(rest.filter((k) => k === 'wall')).toHaveLength(18);
      expect(rest.filter((k) => k === 'floor')).toHaveLength(12);
      expect(rest).toHaveLength(30);
      // The roll is `rand_div(100) < 30`.
      const roll = createRng(seed).int('replay', 0, 99);
      expect(gen.buildings[0]?.isLit).toBe(roll < 30);
    }
    // Unset, a building rolls against 70 — not the 100 a room would.
    const lit: boolean[] = [];
    const rolls: number[] = [];
    for (let n = 0; n < 40; n += 1) {
      const s = setup({}, { w: 9, h: 7, seed: `seventy-${String(n)}` });
      building(s.gen, { x: 1, y: 1, w: 5, h: 4 }, []);
      lit.push(s.gen.buildings[0]?.isLit ?? false);
      rolls.push(createRng(`seventy-${String(n)}`).int('replay', 0, 99));
    }
    expect(lit).toEqual(rolls.map((r) => r < 70));
    expect(rolls.some((r) => r >= 70)).toBe(true);
  });

  it('leaves a walled cell`s terrain alone, edge or inside, and still opens a walled edge', () => {
    const s = lawn(9, 7);
    s.gen.walled[1 * 9 + 3] = 1;
    s.gen.walled[3 * 9 + 3] = 1;
    building(s.gen, { x: 1, y: 1, w: 5, h: 4 }, []);
    expect(s.map.get(3, 1)).toBe(TileCode.GREEN);
    expect(s.map.cell(3, 1).canOpen).toBe(true);
    expect(s.map.get(3, 3)).toBe(TileCode.GREEN);
  });

  it('records as `floored` the inside cells it floored, and not a special, closed-room or walled one', () => {
    // Building.lua:114-116: `self.map.lites(i, j, true)` beside the floor it
    // writes, and nowhere else. Inside is x 2..5 by y 2..4.
    const s = lawn(9, 7);
    s.map.cell(3, 3).special = true;
    s.map.cell(2, 2).room = 9;
    s.map.cell(4, 2).room = 9;
    s.map.cell(4, 2).canOpen = true;
    s.gen.walled[4 * 9 + 5] = 1;
    building(s.gen, { x: 1, y: 1, w: 5, h: 4 }, []);
    const at = (x: number, y: number): number => y * 9 + x;
    // x outer, y inner, as the loop writes them.
    expect(s.gen.buildings[0]?.floored).toEqual([
      at(2, 3),
      at(2, 4),
      at(3, 2),
      at(3, 4),
      at(4, 2),
      at(4, 3),
      at(4, 4),
      at(5, 2),
      at(5, 3),
    ]);
    for (const cell of s.gen.buildings[0]?.floored ?? []) {
      expect(s.map.tiles[cell]).toBe(TileCode.FLOOR);
    }
  });

  it('puts its spot at the floor of the middle on both axes', () => {
    // Building.lua:126-128: `math.floor((x1+x2)/2)`, here on an odd sum each way:
    // 1..6 and 2..7.
    const s = lawn(12, 12);
    const spots: Spot[] = [];
    building(s.gen, { x: 1, y: 2, w: 5, h: 5 }, spots);
    expect(spots).toEqual([{ x: 3, y: 4, type: 'building', subtype: 'building' }]);
    expect(s.gen.buildings[0]).toMatchObject({ cx: 3, cy: 4 });
  });

  it('leaves special cells and closed room cells untouched, and builds over an open room cell', () => {
    const s = lawn(9, 7);
    s.map.cell(4, 5).special = true;
    s.map.cell(2, 2).room = 9;
    s.map.cell(4, 2).room = 9;
    s.map.cell(4, 2).canOpen = true;
    s.map.cell(1, 4).room = 9;
    building(s.gen, { x: 1, y: 1, w: 5, h: 4 }, []);
    expect(s.map.get(4, 5)).toBe(TileCode.GREEN);
    expect(s.map.cell(4, 5).canOpen).toBeNull();
    expect(s.gen.walled[5 * 9 + 4]).toBe(0);
    expect(s.map.get(2, 2)).toBe(TileCode.GREEN);
    expect(s.map.get(4, 2)).toBe(TileCode.FLOOR);
    expect(s.map.get(1, 4)).toBe(TileCode.GREEN);
    expect(s.map.cell(1, 4).canOpen).toBeNull();
  });
});

describe('block — Building.lua:132-153', () => {
  const rock = (w: number, h: number, data: Partial<BuildingData> = {}, seed = 'block'): Setup => {
    const s = setup(data, { w, h, seed });
    for (let i = 0; i < w * h; i += 1) s.map.tiles[i] = TileCode.WALL;
    return s;
  };

  it('paves the rim of [rx, rx+w] x [ry, ry+h] and builds on the inside, one cell in', () => {
    const s = rock(12, 10, { maxBuildingW: 20, maxBuildingH: 20 });
    block(s.gen, { x: 1, y: 1, w: 9, h: 7 }, s.map.spots);
    expect(rows(s.map)).toEqual([
      '############',
      '#,,,,,,,,,,#',
      '#,########,#',
      '#,#......#,#',
      '#,#......#,#',
      '#,#......#,#',
      '#,#......#,#',
      '#,########,#',
      '#,,,,,,,,,,#',
      '############',
    ]);
    expect(s.gen.buildings.map((b) => [b.x1, b.y1, b.x2, b.y2])).toEqual([[2, 2, 9, 7]]);
  });

  it('paves over a walled room edge, and not over a special cell or a closed room cell', () => {
    const s = rock(12, 10, { maxBuildingW: 20, maxBuildingH: 20 });
    s.map.cell(5, 1).special = true;
    s.map.cell(6, 8).room = 3;
    s.map.cell(7, 8).room = 3;
    s.map.cell(7, 8).canOpen = true;
    s.gen.walled[4 * 12 + 1] = 1;
    block(s.gen, { x: 1, y: 1, w: 9, h: 7 }, []);
    expect(s.map.get(5, 1)).toBe(TileCode.WALL);
    expect(s.map.get(6, 8)).toBe(TileCode.WALL);
    expect(s.map.get(7, 8)).toBe(TileCode.GREEN);
    expect(s.map.get(1, 4)).toBe(TileCode.GREEN);
  });

  it('falls back to `floor` for a zone without `external_floor`', () => {
    const grid: GridKeys = { floor: TileCode.FLOOR, wall: TileCode.WALL };
    const s = rock(12, 10, { grid, maxBuildingW: 20, maxBuildingH: 20 });
    block(s.gen, { x: 1, y: 1, w: 9, h: 7 }, []);
    expect(rows(s.map)[1]).toBe('#..........#');
  });

  it('cuts with `rng.range`: one legal cut draws nothing, and a fractional minimum truncates', () => {
    for (const maxBuildingW of [3, 3.5]) {
      const { rng, draws } = recording(`cut-${String(maxBuildingW)}`);
      const s = setup({ maxBuildingW, maxBuildingH: 20 }, { w: 12, h: 10, rng });
      // Inside 6 wide at a minimum of 3, or 7 wide at 3.5: `range(3, 3)` either way.
      block(s.gen, { x: 1, y: 1, w: maxBuildingW === 3 ? 8 : 9, h: 7 }, []);
      expect(draws.map((d) => d.label)).toEqual(['mapgen.building.lit', 'mapgen.building.lit']);
      expect(s.gen.buildings.map((b) => [b.x1, b.x2])).toEqual(
        maxBuildingW === 3
          ? [
              [2, 5],
              [5, 8],
            ]
          : [
              [2, 5],
              [5, 9],
            ],
      );
    }
  });

  it('cuts the inside into buildings no smaller than max_building, sharing their walls', () => {
    for (let n = 0; n < 20; n += 1) {
      const s = rock(12, 10, { maxBuildingW: 3, maxBuildingH: 20 }, `split-${String(n)}`);
      block(s.gen, { x: 1, y: 1, w: 9, h: 7 }, s.map.spots);
      // The inside is 7 wide: one cut at 3 or 4.
      const spans = s.gen.buildings.map((b) => [b.x1, b.x2]);
      expect(spans).toHaveLength(2);
      const [first, second] = spans as [[number, number], [number, number]];
      expect(first[0]).toBe(2);
      expect(second[1]).toBe(9);
      expect(first[1]).toBe(second[0]);
      expect([5, 6]).toContain(first[1]);
      expect(s.map.spots).toHaveLength(2);
    }
  });
});

describe('Building:generate — Building.lua:155-256', () => {
  it('fills x outer, y inner: `outside_floor` in the margins, `external_floor` inside', () => {
    const log: string[] = [];
    const grid = loggingGrid(log, {
      outside_floor: TileCode.YARD,
      external_floor: TileCode.GREEN,
      floor: TileCode.FLOOR,
      wall: TileCode.WALL,
      door: TileCode.DOOR,
    });
    const { map, level } = run(
      { grid, marginW: 1, marginH: 2, maxBlockW: 40, maxBlockH: 40, forceLastStair: true },
      { w: 8, h: 9 },
    );
    const expected: string[] = [];
    for (let i = 0; i < 8; i += 1) {
      for (let j = 0; j < 9; j += 1) {
        expected.push(i <= 0 || i >= 7 || j <= 1 || j >= 7 ? 'outside_floor' : 'external_floor');
      }
    }
    expect(log.slice(0, 72)).toEqual(expected);
    // Nothing else ever touches the margins.
    for (let i = 0; i < 8; i += 1) {
      for (let j = 0; j < 9; j += 1) {
        if (i === 0 || i === 7 || j <= 1 || j === 8) expect(map.get(i, j)).toBe(TileCode.YARD);
      }
    }
    expect(log.filter((k) => k === 'outside_floor')).toHaveLength(72 - 30);
    expect(level.forceRecreate).toBeNull();
  });

  it('paves the margins with `external_floor` when the zone has no `outside_floor`', () => {
    const grid: GridKeys = {
      external_floor: TileCode.GREEN,
      floor: TileCode.FLOOR,
      wall: TileCode.WALL,
    };
    const { map } = run({ grid, marginW: 2, marginH: 2 }, { w: 12, h: 12 });
    expect(rows(map)[0]).toBe(',,,,,,,,,,,,');
    expect(rows(map)[5]?.slice(0, 2)).toBe(',,');
  });

  it('lays the block BSP one short of the building area, so its rim is the area`s edge', () => {
    for (let n = 0; n < 10; n += 1) {
      // No up or down key: a stair marks its cell and writes nothing.
      const grid: GridKeys = {
        external_floor: TileCode.GREEN,
        outside_floor: TileCode.YARD,
        floor: TileCode.FLOOR,
        wall: TileCode.WALL,
        door: TileCode.DOOR,
      };
      const { map } = run(
        { grid, marginW: 3, marginH: 2, maxBlockW: 9, maxBlockH: 7 },
        { w: 40, h: 30, seed: `store-${String(n)}` },
      );
      const drawn = rows(map);
      expect(drawn[2]).toBe(`~~~${','.repeat(34)}~~~`);
      expect(drawn[27]).toBe(`~~~${','.repeat(34)}~~~`);
      for (let y = 2; y <= 27; y += 1) {
        expect(drawn[y]?.charAt(3)).toBe(',');
        expect(drawn[y]?.charAt(36)).toBe(',');
      }
    }
  });

  it('places rooms only where add_check allows, and a required room that cannot be placed recreates', () => {
    const required = run(
      { requiredRooms: ['lesser_vault'], maxRoomW: 1 },
      { w: 40, h: 40, seed: 'required' },
    );
    expect(required.result).toBeNull();
    expect(required.level.forceRecreate).toBe('required_room lesser_vault');

    const random = run(
      { nbRooms: 2, rooms: ['lesser_vault'], maxRoomW: 1 },
      { w: 40, h: 40, seed: 'random' },
    );
    expect(random.map.rooms).toEqual([]);
    // `nb_room * 1.5` tries: three for two rooms.
    expect(random.map.roomsFailed.filter((f) => f.failure === 'placement')).toHaveLength(3);

    // `nb_rooms or 0`: no rooms, and no attempt at one.
    const none = run({ rooms: ['lesser_vault'] }, { w: 40, h: 40, seed: 'random' });
    expect([none.map.rooms, none.map.roomsFailed]).toEqual([[], []]);

    const fits = run({ nbRooms: 2, rooms: ['lesser_vault'] }, { w: 40, h: 40, seed: 'random' });
    expect(fits.map.rooms).toHaveLength(2);
    for (const r of fits.map.rooms) expect(add_check(fits.gen, r.room, r.x, r.y)).toBe(true);
  });

  it('spends one of nb_rooms on a placed required room, before any random pick', () => {
    // Building.lua:192-199: `nb_room = nb_room - 1` for a required room placed.
    const { rng, draws } = recording('required-spent');
    const { map } = run(
      { nbRooms: 1, requiredRooms: ['lesser_vault'], rooms: ['lesser_vault'] },
      { w: 50, h: 50, rng },
    );
    expect(map.rooms).toHaveLength(1);
    expect(draws.map((d) => d.label)).not.toContain('mapgen.building.room.pick');
  });

  it('re-picks a chance entry until its roll passes: a chance of 0 is never placed', () => {
    for (let n = 0; n < 10; n += 1) {
      const { map } = run(
        { nbRooms: 3, rooms: [['lesser_vault', 0], 'simple'] },
        { w: 50, h: 50, seed: `chance-${String(n)}` },
      );
      expect(map.rooms.length).toBeGreaterThan(0);
      for (const r of map.rooms) expect(r.room.name).toMatch(/^simple/);
    }
  });

  it('walls a placed room`s four edges before any building, unless the room has no tunnels', () => {
    for (const noTunnels of [false, true]) {
      const s = setup({ nbRooms: 1, maxBlockW: 40, maxBlockH: 40 }, { w: 40, h: 30, seed: 'room' });
      (s.gen.rooms as LoadedRoom[]).push(asciiRoom(7, 5, { noTunnels }));
      generate(s.gen, 1, 0);
      const r = s.map.rooms[0];
      expect(r).toBeDefined();
      if (r === undefined) continue;
      const first = s.gen.walls.slice(0, 4).map((w) => [w.vert, w.base]);
      const edges = [
        [false, r.y],
        [false, r.y + 4],
        [true, r.x],
        [true, r.x + 6],
      ];
      if (noTunnels) expect(first).not.toEqual(edges);
      else expect(first).toEqual(edges);
      expect(s.gen.walls).toHaveLength(s.gen.buildings.length * 4 + (noTunnels ? 0 : 4));
      if (noTunnels) continue;
      // CORNER TO CORNER (Building.lua:224-227): all four corners walled, and the
      // top wall's first candidate is the cell after its corner.
      for (const [x, y] of [
        [r.x, r.y],
        [r.x + 6, r.y],
        [r.x, r.y + 4],
        [r.x + 6, r.y + 4],
      ] as const) {
        expect(s.gen.walled[y * 40 + x], `${String(x)},${String(y)}`).toBe(1);
      }
      expect(s.gen.walls[0]?.ps[0]).toBe(r.x + 1);
    }
  });

  it('hangs exactly one door on every wall with a candidate left, and none on the others', () => {
    for (let n = 0; n < 12; n += 1) {
      const { gen, map } = run(gearford(`doors-${String(n)}`, 1 + (n % 4)), {
        w: 50,
        h: 50,
        seed: `doors-${String(n)}`,
        maxLevel: 4,
      });
      let doors = 0;
      for (const wall of gen.walls) {
        const on = wall.ps.filter(
          (z) => map.get(wall.vert ? wall.base : z, wall.vert ? z : wall.base) === TileCode.DOOR,
        );
        expect(on).toHaveLength(wall.ps.length > 0 ? 1 : 0);
        expect(wall.doored).toBe(true);
        doors += on.length;
      }
      // A vault's drawing brings its own doors; every other door is a wall's.
      const hung = Array.from(map.tiles).filter(
        (t, i) => t === TileCode.DOOR && map.cells[i]?.special !== true,
      );
      expect(hung).toHaveLength(doors);
    }
  });

  it('draws each wall`s door in the order the walls were added, room walls first', () => {
    // Building.lua:244-246: `for i = 1, #self.walls`. Each draw is `rng.table`'s
    // `range(1, #ps)`: one candidate draws nothing, none draws `range(1, 0)`.
    for (let n = 0; n < 4; n += 1) {
      const { rng, draws } = recording(`door-order-${String(n)}`);
      const { gen } = run(
        { ...gearford(`door-order-${String(n)}`, 1 + n), nbRooms: 1 },
        { w: 50, h: 50, rng, level: 1 + n, maxLevel: 4 },
      );
      const drawn = draws
        .filter((d) => d.label === 'mapgen.building.door')
        .map((d) => [d.lo, d.hi]);
      const walls = gen.walls
        .filter((w) => w.ps.length !== 1)
        .map((w) => (w.ps.length === 0 ? [0, 1] : [1, w.ps.length]));
      expect(drawn).toEqual(walls);
      // The order has to be able to show: the walls differ in length.
      expect(new Set(walls.map((w) => w[1])).size).toBeGreaterThan(2);
    }
  });

  it('draws in upstream`s order: rooms, blocks and buildings, then every door, then the stairs', () => {
    const { rng, draws } = recording('order');
    run({ ...gearford('order', 1), nbRooms: 1 }, { w: 50, h: 50, rng, maxLevel: 4 });
    const labels = draws.map((d) => d.label);
    const first = (l: string): number => labels.indexOf(l);
    const last = (l: string): number => labels.lastIndexOf(l);
    expect(first('mapgen.lesser_vault.pick')).toBeGreaterThanOrEqual(0);
    expect(last('mapgen.roomer.place.lit')).toBeLessThan(first('mapgen.building.lit'));
    expect(last('mapgen.building.lit')).toBeLessThan(first('mapgen.building.door'));
    expect(last('mapgen.building.door')).toBeLessThan(first('mapgen.building.stairs.down.x'));
    expect(labels.at(-1)).toBe('mapgen.building.stairs.up.y');
  });

  it('puts the stairs on the edges when the zone names edge entrances', () => {
    for (let n = 0; n < 8; n += 1) {
      const { result } = run(
        { edgeEntrances: [4, 6], forceLastStair: true },
        { w: 30, h: 30, seed: `edges-${String(n)}` },
      );
      expect(result?.up?.x).toBe(0);
      expect(result?.down?.x).toBe(29);
    }
  });

  it('is the same level from the same seed, and another from another', () => {
    const a = run(gearford('same', 2), { w: 50, h: 50, seed: 'same', maxLevel: 4 });
    const b = run(gearford('same', 2), { w: 50, h: 50, seed: 'same', maxLevel: 4 });
    const c = run(gearford('other', 2), { w: 50, h: 50, seed: 'other', maxLevel: 4 });
    expect(Array.from(a.map.tiles)).toEqual(Array.from(b.map.tiles));
    expect(a.result).toEqual(b.result);
    expect(Array.from(a.map.tiles)).not.toEqual(Array.from(c.map.tiles));
  });
});

describe('Building:makeStairsInside — Building.lua:259-286', () => {
  const open = (w: number, h: number, data: Partial<BuildingData>, rng: Rng): Setup => {
    const s = setup(data, { w, h, rng });
    for (let i = 0; i < w * h; i += 1) s.map.tiles[i] = TileCode.FLOOR;
    return s;
  };

  it('draws x then y inside the margins, `margin+1 .. size-margin-1`, down first', () => {
    const { rng, draws } = recording('inside');
    const s = open(20, 16, { marginW: 2, marginH: 3 }, rng);
    const result = makeStairsInside(s.gen, 1, 0, []);
    expect(draws).toEqual([
      { label: 'mapgen.building.stairs.down.x', lo: 3, hi: 17 },
      { label: 'mapgen.building.stairs.down.y', lo: 4, hi: 12 },
      { label: 'mapgen.building.stairs.up.x', lo: 3, hi: 17 },
      { label: 'mapgen.building.stairs.up.y', lo: 4, hi: 12 },
    ]);
    for (const at of [result.down, result.up]) {
      expect(at).not.toBeNull();
      if (at !== null) expect(s.map.cell(at.x, at.y).special).toBe('exit');
    }
  });

  it('refuses a cell that blocks movement or is special, and gives up past the cap', () => {
    const s = setup({}, { w: 10, h: 10, seed: 'refuse' });
    for (let i = 0; i < 100; i += 1) s.map.tiles[i] = TileCode.WALL;
    s.map.set(5, 5, TileCode.FLOOR);
    s.map.cell(5, 5).special = true;
    s.map.set(7, 7, TileCode.FLOOR);
    const result = makeStairsInside(s.gen, 1, 0, []);
    expect(result.down).toEqual({ x: 7, y: 7 });
    expect(result.up).toBeNull();
    expect(s.level.forceRecreate).toBe('makeStairsInside: no cell for the up stair');
  });

  it('places no down stair on the zone`s last level unless forced', () => {
    const { rng, draws } = recording('last');
    const s = open(12, 12, {}, rng);
    const result = makeStairsInside(s.gen, 3, 2, []);
    expect(result.down).toBeNull();
    expect(result.up).not.toBeNull();
    expect(draws.map((d) => d.label)).toEqual([
      'mapgen.building.stairs.up.x',
      'mapgen.building.stairs.up.y',
    ]);
    const forced = open(12, 12, { forceLastStair: true }, createRng('last'));
    expect(makeStairsInside(forced.gen, 3, 2, []).down).not.toBeNull();
  });
});

describe('Building:makeStairsSides — Building.lua:289-326', () => {
  it('stands each stair on its edge AT THE MARGIN, drawn along it inside the margins', () => {
    const cases: [2 | 4 | 6 | 8, (at: TileXY) => number, number, number, number][] = [
      // side, the fixed coordinate, its value, the drawn range
      [4, (at) => at.x, 2, 3, 12],
      [6, (at) => at.x, 17, 3, 12],
      [8, (at) => at.y, 3, 2, 17],
      [2, (at) => at.y, 12, 2, 17],
    ];
    for (const [side, fixed, value, lo, hi] of cases) {
      const { rng, draws } = recording(`side-${String(side)}`);
      const s = setup({ marginW: 2, marginH: 3 }, { w: 20, h: 16, rng });
      const result = makeStairsSides(s.gen, 1, 0, [side, side === 4 ? 6 : 4], []);
      expect(draws[1]).toEqual({ label: 'mapgen.building.stairs.up.side', lo, hi });
      expect(result.up === null ? null : fixed(result.up)).toBe(value);
    }
  });

  it('places down on the second side first, and never tests block_move', () => {
    const { rng, draws } = recording('walls');
    const s = setup({}, { w: 10, h: 8, rng });
    for (let i = 0; i < 80; i += 1) s.map.tiles[i] = TileCode.WALL;
    const result = makeStairsSides(s.gen, 1, 0, [8, 2], []);
    expect(draws.map((d) => d.label)).toEqual([
      'mapgen.building.stairs.down.side',
      'mapgen.building.stairs.up.side',
    ]);
    expect(result.down?.y).toBe(7);
    expect(result.up?.y).toBe(0);
  });

  it('marks both stairs exit, and places down on the last level only when forced', () => {
    for (const force of [false, true]) {
      const s = setup({ forceLastStair: force }, { w: 10, h: 8, seed: 'sides-last' });
      const result = makeStairsSides(s.gen, 3, 2, [4, 6], []);
      expect(result.down === null, `forced ${String(force)}`).toBe(!force);
      for (const at of [result.up, result.down]) {
        if (at !== null) expect(s.map.cell(at.x, at.y).special).toBe('exit');
      }
      expect(result.up).not.toBeNull();
    }
  });

  it('skips a special cell on the edge', () => {
    const s = setup({}, { w: 10, h: 8, seed: 'special-edge' });
    for (let y = 0; y < 8; y += 1) if (y !== 5) s.map.cell(0, y).special = true;
    const result = makeStairsSides(s.gen, 3, 2, [4, 6], []);
    expect(result.up).toEqual({ x: 0, y: 5 });
    expect(result.down).toBeNull();
  });
});

describe('the Infinite Dungeon`s building layout — infinite-dungeon/zone.lua:153-162', () => {
  it('rolls in the table`s order: nb_rooms by math.random, then five rng.range', () => {
    const { rng, draws } = recording('layout');
    const layout = infiniteDungeonBuilding(rng, 50, 50, 50, 1);
    expect(draws).toEqual([
      { label: 'mapgen.infinite_dungeon.building.nb_rooms' },
      { label: 'mapgen.infinite_dungeon.building.lite_room_chance', lo: 0, hi: 100 },
      { label: 'mapgen.infinite_dungeon.building.max_block_w', lo: 7, hi: 20 },
      { label: 'mapgen.infinite_dungeon.building.max_block_h', lo: 7, hi: 20 },
      // size/6 = 8.33, truncated.
      { label: 'mapgen.infinite_dungeon.building.max_building_w', lo: 4, hi: 8 },
      { label: 'mapgen.infinite_dungeon.building.max_building_h', lo: 4, hi: 8 },
    ]);
    const replay = createRng('layout');
    expect(layout).toEqual({
      nbRooms: Math.floor(replay.nextFloat('x') * 3),
      rooms: [['lesser_vault', 40], 'lesser_vault'],
      liteRoomChance: replay.int('x', 0, 100),
      maxBlockW: replay.int('x', 7, 20),
      maxBlockH: replay.int('x', 7, 20),
      maxBuildingW: replay.int('x', 4, 8),
      maxBuildingH: replay.int('x', 4, 8),
    });
  });

  it('truncates size/6, and swaps it below 4', () => {
    const at = (size: number): Draw | undefined => {
      const { rng, draws } = recording('size');
      infiniteDungeonBuilding(rng, size, 60, 60, 1);
      return draws[4];
    };
    expect(at(60)).toMatchObject({ lo: 4, hi: 10 });
    expect(at(65)).toMatchObject({ lo: 4, hi: 10 });
    expect(at(20)).toMatchObject({ lo: 3, hi: 4 });
  });

  it('takes nb_rooms from 0 to ceil(w*h/2000) inclusive', () => {
    const fixed = (u: number): Rng => ({ ...createRng('nb'), nextFloat: () => u });
    expect(infiniteDungeonBuilding(fixed(0), 50, 50, 50, 1).nbRooms).toBe(0);
    expect(infiniteDungeonBuilding(fixed(0.999999), 50, 50, 50, 1).nbRooms).toBe(2);
    expect(infiniteDungeonBuilding(fixed(0.999999), 70, 70, 70, 1).nbRooms).toBe(3);
    expect(infiniteDungeonBuilding(fixed(0.5), 70, 70, 70, 1).nbRooms).toBe(2);
  });

  it('weights the lesser vault entry by floor(40/lev), and refuses a level below 1', () => {
    const rooms = (lev: number): unknown =>
      infiniteDungeonBuilding(createRng('l'), 50, 50, 50, lev).rooms;
    expect(rooms(3)).toEqual([['lesser_vault', 13], 'lesser_vault']);
    expect(rooms(41)).toEqual([['lesser_vault', 0], 'lesser_vault']);
    expect(() => infiniteDungeonBuilding(createRng('l'), 50, 50, 50, 0)).toThrow(RangeError);
  });

  it('rolls size as 60 + floor(30*lev/(lev + 50)): 60, 70 at level 25, 75 at 50, never 90', () => {
    // infinite-dungeon/zone.lua:103, and its own comment's figures. 10 and 15
    // sit either side of a whole number: 300/60 is 5 exactly, 450/65 just under 7.
    expect([1, 2, 4, 10, 15, 25, 50, 1000000000].map(infiniteDungeonSize)).toEqual([
      60, 61, 62, 65, 66, 70, 75, 89,
    ]);
  });

  it('pins the zone table: 50x50, the default grid set, the works vaults', () => {
    expect(BUILDING_INFINITE_DUNGEON).toEqual({
      width: 50,
      height: 50,
      map: {
        class: 'Building',
        lesserVaultsList: (VAULTS_BY_SHAPE['works'] ?? []).map((v) => v.id),
        forceLastStair: true,
        grid: {
          floor: TileCode.FLOOR,
          '.': TileCode.FLOOR,
          external_floor: TileCode.FLOOR,
          outside_floor: TileCode.FLOOR,
          wall: TileCode.WALL,
          '#': TileCode.WALL,
          door: TileCode.DOOR,
          up: TileCode.FLOOR,
          down: TileCode.FLOOR,
        },
      },
    });
  });
});

describe('math.random — LuaJIT`s math_random, over the labelled rng', () => {
  const fixed = (u: number, draws: string[]): Rng => ({
    ...createRng('math'),
    nextFloat: (label) => {
      draws.push(label);
      return u;
    },
  });

  it('is floor(u * (n - m + 1)) + m, one draw, even when m equals n', () => {
    const draws: string[] = [];
    expect(mathRandom(fixed(0.5, draws), 'a', 0, 2)).toBe(1);
    expect(mathRandom(fixed(0.99, draws), 'b', 3, 3)).toBe(3);
    expect(mathRandom(fixed(0.75, draws), 'c', 10, 13)).toBe(13);
    expect(draws).toEqual(['a', 'b', 'c']);
  });

  it('neither truncates nor swaps its bounds', () => {
    const draws: string[] = [];
    // 0.9 * 3.5 = 3.15: a float bound reaches past its own value.
    expect(mathRandom(fixed(0.9, draws), 'f', 0, 2.5)).toBe(3);
    // Reversed: 0.1 * (3 - 5 + 1) = -0.1, floored to -1, plus 5. Swapped, it would be 3.
    expect(mathRandom(fixed(0.1, draws), 'r', 5, 3)).toBe(4);
  });
});

describe('the Gearford zone params, generated and checked as newLevel checks them', () => {
  /**
   * Forty floors at the Infinite Dungeon's building layout, 50x50, each floor's
   * parameters rolled once. Attempt 1 only: measured over 1,000 floors, every
   * first attempt reached the down stair from the up stair and every vault
   * entrance from the up stair, so a refusal here is a regression and not luck.
   */
  it('reaches down from up, and every vault entrance from up, eight ways with doors open', () => {
    let vaults = 0;
    for (let n = 0; n < 40; n += 1) {
      const seed = `gearford-${String(n)}`;
      const { map, result, level } = run(gearford(seed, 1 + (n % 4)), {
        w: 50,
        h: 50,
        seed: `${seed}#1`,
        level: 1 + (n % 4),
        maxLevel: 4,
      });
      expect(level.forceRecreate, seed).toBeNull();
      const up = result?.up ?? null;
      const down = result?.down ?? null;
      expect(up, seed).not.toBeNull();
      expect(down, seed).not.toBeNull();
      if (up === null || down === null) continue;
      expect(reachable(map, up, down), seed).toBe(true);
      for (const spot of result?.spots ?? []) {
        if (spot.checkConnectivity !== 'entrance') continue;
        vaults += 1;
        expect(reachable(map, spot, up), `${seed} vault`).toBe(true);
      }
    }
    // The vaults must actually be there for their check to mean anything.
    expect(vaults).toBeGreaterThan(20);
  });
});
