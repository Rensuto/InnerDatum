// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// The function under test is ported from t-engine4 game/modules/tome/data/zones/infinite-dungeon/zone.lua:100-259.
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

import { describe, expect, it } from 'vitest';

import type { TileXY } from '../../../src/shared/coords.ts';
import type { AuthoredMap } from '../../../src/shared/level.ts';
import { ID_GRID_SETS } from '../../../src/shared/mapgen/gridsets.ts';
import {
  TOWER_LAYOUTS,
  TOWER_VAULTS,
  alterLevelData,
} from '../../../src/shared/mapgen/infinite.ts';
import type { TowerEntry, TowerFloor } from '../../../src/shared/mapgen/infinite.ts';
import { keepTrying } from '../../../src/shared/mapgen/level.ts';
import type { LevelSpec } from '../../../src/shared/mapgen/level.ts';
import { isWalkable } from '../../../src/shared/protocol.ts';
import { createRng } from '../../../src/shared/rng.ts';
import type { Rng } from '../../../src/shared/rng.ts';
import { isClosedDoorCode } from '../../../src/shared/terrain.ts';

/** The Infinite Dungeon's `max_level` (`zone.lua:27`). */
const MAX_LEVEL = 1000000000;

/** `size`, written out again (`zone.lua:103`), so the port cannot certify its own. */
function sizeOf(lev: number): number {
  return 60 + Math.floor((30 * lev) / (lev + 50));
}

/** A generator whose `tower.alter.vx` draw is a fixed raw 32-bit number. */
function withVx(u32: number, seed = 'vx'): Rng {
  const base = createRng(seed);
  return {
    ...base,
    nextU32: (label) => (label === 'tower.alter.vx' ? u32 : base.nextU32(label)),
  };
}

/** Half of 2^32: `rng.float(0.6, 1.4)` lands a hair under 1, so the map is `size` by `size`. */
const MIDDLE = 2147483647;

/** Every top-level call on a generator, with its label and, for `int`, its bounds. */
function recorder(seed: string): { readonly rng: Rng; readonly draws: string[] } {
  const base = createRng(seed);
  const draws: string[] = [];
  const rng: Rng = {
    ...base,
    nextU32: (label) => {
      draws.push(`u32 ${label}`);
      return base.nextU32(label);
    },
    nextFloat: (label) => {
      draws.push(`float ${label}`);
      return base.nextFloat(label);
    },
    int: (label, lo, hi) => {
      draws.push(`int ${label} ${String(lo)}..${String(hi)}`);
      return base.int(label, lo, hi);
    },
    pick: () => {
      throw new Error('alter_level_data has no pick');
    },
    shuffle: () => {
      throw new Error('alter_level_data has no shuffle');
    },
  };
  return { rng, draws };
}

/** A generator whose exit draws are scripted and everything else is real. */
function scriptedExits(ints: readonly number[]): Rng {
  const base = createRng('exits');
  const queue = [...ints];
  return {
    ...base,
    int: (label, lo, hi) => {
      if (!label.startsWith('tower.alter.exit')) return base.int(label, lo, hi);
      const v = queue.shift();
      if (v === undefined) throw new Error('script ran out');
      if (v < lo || v > hi)
        throw new Error(`scripted ${String(v)} outside ${String(lo)}..${String(hi)}`);
      return v;
    },
  };
}

/**
 * Upstream's check, written again here: 8 neighbours, a shut door passes, the
 * start is not tested (`engine/Zone.lua:1131-1158`, `engine/Astar.lua:150-188`).
 */
function reaches(map: AuthoredMap, from: TileXY, to: TileXY): boolean {
  const { w, h, tiles } = map.view;
  const seen = new Uint8Array(w * h);
  const queue: TileXY[] = [from];
  seen[from.y * w + from.x] = 1;
  for (let head = 0; head < queue.length; head += 1) {
    const at = queue[head];
    if (at === undefined) break;
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        const x = at.x + dx;
        const y = at.y + dy;
        if (x < 0 || y < 0 || x >= w || y >= h || seen[y * w + x] === 1) continue;
        const code = tiles[y * w + x] ?? -1;
        if (!isWalkable(code) && !isClosedDoorCode(code)) continue;
        seen[y * w + x] = 1;
        queue.push({ x, y });
      }
    }
  }
  return seen[to.y * w + to.x] === 1;
}

describe('TOWER_LAYOUTS', () => {
  it('is upstream`s eight, in order, with their names and descs verbatim (zone.lua:110-179)', () => {
    expect(TOWER_LAYOUTS.map((l) => [l.id, l.desc, l.generator])).toEqual([
      ['default', ', carefully excavated area', 'Roomer'],
      ['forest', ' wilderness', 'Forest'],
      ['cavern', ' cavern', 'Cavern'],
      ['maze', ' network of corridors', 'Maze'],
      ['town', ', settled area', 'Town'],
      ['building', ', constructed area', 'Building'],
      ['octopus', ', subsided area', 'Octopus'],
      ['hexa', ', geometrically ordered area', 'Hexacle'],
    ]);
  });

  it('builds the layout an entry names, with that generator', () => {
    for (let n = 1; n <= 8; n += 1) {
      const floor = alterLevelData(3, { layoutN: n, vgridN: 1 }, createRng(`class:${String(n)}`));
      expect(floor.layoutName).toBe(TOWER_LAYOUTS[n - 1]?.id);
      expect(floor.spec.map.class).toBe(TOWER_LAYOUTS[n - 1]?.generator);
    }
  });
});

describe('the size (zone.lua:103-105)', () => {
  it('is 60, 61, 70 and 75 at levels 1, 2, 25 and 50, and short of 90 however deep', () => {
    // The comment at :103 says "70 @ level 25, 75 @ level 50". Level 2 is
    // 60 + floor(60/52) = 61.
    expect([1, 2, 25, 50].map(sizeOf)).toEqual([60, 61, 70, 75]);
    expect(sizeOf(MAX_LEVEL)).toBe(89);
    // A draw in the middle of rng.float(0.6, 1.4) is a hair under 1: the map is size by size.
    expect(
      [1, 2, 25, 50].map((lev) => {
        const floor = alterLevelData(lev, undefined, withVx(MIDDLE));
        return [floor.width, floor.height];
      }),
    ).toEqual([
      [60, 60],
      [61, 61],
      [70, 70],
      [75, 75],
    ]);
  });

  it('narrows 0.6 and 1.4 to C floats, so the extremes are 37 and 125', () => {
    // fround(0.6) * 60 is 36.0000014 and ceils to 37; fround(1.4) * 89 is 124.9999979.
    const low = alterLevelData(1, undefined, withVx(0));
    expect([low.width, low.height]).toEqual([37, Math.ceil(3600 / 37)]);
    const high = alterLevelData(MAX_LEVEL, undefined, withVx(0xffffffff));
    expect([high.width, high.height]).toEqual([125, Math.ceil((89 * 89) / 125)]);
    expect(alterLevelData(50, undefined, withVx(0)).height).toBe(123);
  });

  it('keeps vx within the 36 to 126 the comment gives, and vy = ceil(size^2 / vx)', () => {
    for (const lev of [1, 2, 3, 25, 50, 1000]) {
      for (let s = 0; s < 60; s += 1) {
        const floor = alterLevelData(lev, undefined, createRng(`vx:${String(lev)}:${String(s)}`));
        expect(floor.width).toBeGreaterThanOrEqual(36);
        expect(floor.width).toBeLessThanOrEqual(126);
        expect(floor.height).toBe(Math.ceil((sizeOf(lev) * sizeOf(lev)) / floor.width));
        expect([floor.spec.width, floor.spec.height]).toEqual([floor.width, floor.height]);
      }
    }
  });
});

describe('the draw order (zone.lua:104-225)', () => {
  /** The labelled calls upstream's source order makes, for a raw `vx` by `vy` at `lev`. */
  function expected(lev: number, vx: number, vy: number): string[] {
    const t = Math.trunc;
    const normal = (label: string): string[] => [`int ${label} 0..32767`, `int ${label} 0..99`];
    const building = 'mapgen.infinite_dungeon.building';
    return [
      'u32 tower.alter.vx',
      'int tower.alter.forest.edge 1..4',
      'int tower.alter.forest.zoom 2..6',
      'int tower.alter.forest.sqrt_percent 30..50',
      'int tower.alter.forest.sqrt_percent 5..10',
      'float tower.alter.forest.nb_rooms',
      'float tower.alter.cavern.zoom',
      `int tower.alter.cavern.min_floor ${String(t((vx * vy * 0.4) / 2))}..${String(t(vx * vy * 0.4))}`,
      ...normal('tower.alter.maze.widen_w'),
      ...normal('tower.alter.maze.widen_h'),
      'float tower.alter.town.building_chance',
      'float tower.alter.town.max_building_w',
      'float tower.alter.town.max_building_h',
      'float tower.alter.town.nb_rooms',
      `float ${building}.nb_rooms`,
      `int ${building}.lite_room_chance 0..100`,
      `int ${building}.max_block_w 7..20`,
      `int ${building}.max_block_h 7..20`,
      `int ${building}.max_building_w 4..${String(t(sizeOf(lev) / 6))}`,
      `int ${building}.max_building_h 4..${String(t(sizeOf(lev) / 6))}`,
      ...normal('tower.alter.exit1.layout'),
      ...normal('tower.alter.exit1.grids'),
      ...normal('tower.alter.exit2.layout'),
      ...normal('tower.alter.exit2.grids'),
    ];
  }

  it.each([1, 3, 30])(
    'rolls every layout`s table on floor %i, whichever layout is built',
    (lev) => {
      for (let s = 0; s < 4; s += 1) {
        const seed = `order:${String(lev)}:${String(s)}`;
        const plain = recorder(seed);
        const raw = alterLevelData(lev, undefined, plain.rng);
        expect(plain.draws).toEqual(expected(lev, raw.width, raw.height));
        for (let n = 1; n <= 8; n += 1) {
          const other = recorder(seed);
          alterLevelData(lev, { layoutN: n, vgridN: (n * 5) % 17 }, other.rng);
          expect(other.draws, `layout ${String(n)}`).toEqual(plain.draws);
        }
      }
    },
  );

  it('throws for a level below 1 before it draws anything', () => {
    const { rng, draws } = recorder('no-level');
    expect(() => alterLevelData(0, undefined, rng)).toThrow(RangeError);
    expect(() => alterLevelData(1.5, undefined, rng)).toThrow(RangeError);
    expect(draws).toEqual([]);
  });

  it('is the same floor for the same seed', () => {
    const entry = { layoutN: 5, vgridN: 11 };
    const a = alterLevelData(12, entry, createRng('same'));
    const b = alterLevelData(12, entry, createRng('same'));
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    expect(JSON.stringify(alterLevelData(12, entry, createRng('other')))).not.toBe(
      JSON.stringify(a),
    );
  });
});

describe('the pick and the exits (zone.lua:207-225)', () => {
  it('starts on layout 1 in set 1, and wraps an entry with Lua`s floored %', () => {
    const at = (entry: TowerEntry | undefined): readonly [string, string] => {
      const floor = alterLevelData(4, entry, createRng('pick'));
      return [floor.layoutName, floor.gridsName];
    };
    expect(at(undefined)).toEqual(['default', 'default']);
    expect(at({ layoutN: 9, vgridN: 18 })).toEqual(['default', 'default']);
    expect(at({ layoutN: 0, vgridN: 0 })).toEqual(['hexa', 'autumn_forest']);
    expect(at({ layoutN: -1, vgridN: -16 })).toEqual(['octopus', 'default']);
  });

  it('rolls normal(n + 1, 2) for the layout, then the set, with a floored % on a negative draw', () => {
    // 32767 is the table's last index, an offset of floor(2*255/64) = 7, and a
    // sign roll under 50 subtracts it: normal(2, 2) = -5. Lua's -5 % 8 is 3, so
    // layout 4; -5 % 17 is 12, so set 13. JavaScript's % would give -4 and -4.
    // Exit 2 starts from exit 1's 4 and 13: a zero offset gives 5 % 8 + 1 = 6 and
    // 14 % 17 + 1 = 15. Had it started from the level's 1 and 1, it would be 3 and 3.
    const floor = alterLevelData(1, undefined, scriptedExits([32767, 0, 32767, 0, 0, 99, 0, 99]));
    expect(floor.exits).toEqual([
      { layoutN: 4, vgridN: 13, desc: 'cold, wooded network of corridors' },
      { layoutN: 6, vgridN: 15, desc: 'flooded, constructed area' },
    ]);
  });

  it('wraps past the last layout and the last set', () => {
    // From layout 8 and set 17, a zero offset is normal(9) and normal(18): 9 % 8 + 1
    // and 18 % 17 + 1 are 2 and 2. Exit 2 goes on from there, to 4 and 4.
    const floor = alterLevelData(
      1,
      { layoutN: 8, vgridN: 17 },
      scriptedExits([0, 99, 0, 99, 0, 99, 0, 99]),
    );
    expect(floor.exits).toEqual([
      { layoutN: 2, vgridN: 2, desc: 'sylvan wilderness' },
      { layoutN: 4, vgridN: 4, desc: 'crystalline network of corridors' },
    ]);
  });

  it('describes every exit as its set`s desc then its layout`s, verbatim', () => {
    for (let s = 0; s < 200; s += 1) {
      const floor = alterLevelData(7, undefined, createRng(`desc:${String(s)}`));
      for (const exit of floor.exits) {
        expect(exit.layoutN).toBeGreaterThanOrEqual(1);
        expect(exit.layoutN).toBeLessThanOrEqual(8);
        expect(exit.vgridN).toBeGreaterThanOrEqual(1);
        expect(exit.vgridN).toBeLessThanOrEqual(17);
        const set = ID_GRID_SETS[exit.vgridN - 1];
        const layout = TOWER_LAYOUTS[exit.layoutN - 1];
        expect(exit.desc).toBe(`${String(set?.desc)}${String(layout?.desc)}`);
      }
    }
  });
});

describe('after the pick (zone.lua:228-256)', () => {
  it('rounds a maze to its corridor widths, halves up', () => {
    let halves = 0;
    for (const lev of [1, 50]) {
      for (let s = 0; s < 150; s += 1) {
        const seed = `maze:${String(lev)}:${String(s)}`;
        const raw = alterLevelData(lev, undefined, createRng(seed));
        const maze = alterLevelData(lev, { layoutN: 4, vgridN: 1 }, createRng(seed));
        if (maze.spec.map.class !== 'Maze') throw new Error('not a maze');
        const { widenW = 0, widenH = 0 } = maze.spec.map;
        for (const widen of [widenW, widenH]) {
          expect(widen).toBeGreaterThanOrEqual(1);
          expect(widen).toBeLessThanOrEqual(7);
        }
        expect(maze.width % widenW).toBe(0);
        expect(maze.height % widenH).toBe(0);
        // Nearest multiple, a half going up, written without mathRound.
        expect(maze.width).toBe(Math.floor(raw.width / widenW + 0.5) * widenW);
        expect(maze.height).toBe(Math.floor(raw.height / widenH + 0.5) * widenH);
        if ((raw.width % widenW) * 2 === widenW) halves += 1;
      }
    }
    expect(halves).toBeGreaterThan(10);
  });

  it('squares hexa to its larger side', () => {
    for (let s = 0; s < 60; s += 1) {
      const seed = `hexa:${String(s)}`;
      const raw = alterLevelData(20, undefined, createRng(seed));
      const hexa = alterLevelData(20, { layoutN: 8, vgridN: 9 }, createRng(seed));
      const side = Math.max(raw.width, raw.height);
      expect([hexa.width, hexa.height, hexa.spec.width, hexa.spec.height]).toEqual([
        side,
        side,
        side,
        side,
      ]);
    }
    // Every other layout keeps the rolled size.
    for (const n of [1, 2, 3, 5, 6, 7]) {
      const raw = alterLevelData(20, undefined, createRng('keep'));
      const other = alterLevelData(20, { layoutN: n, vgridN: 1 }, createRng('keep'));
      expect([other.width, other.height]).toEqual([raw.width, raw.height]);
    }
  });

  it('counts enemies by the layout`s own count, else by the final area, as upstream`s comments give', () => {
    // At 60x60: "25 @ 60x60" (:255), the forest's "30 @ 60x60" (:129), 12 rooms (:113).
    const floorAt = (n: number): TowerFloor =>
      alterLevelData(1, { layoutN: n, vgridN: 1 }, withVx(MIDDLE, 'enemies'));
    expect(floorAt(1).enemyCount).toBe(25);
    const roomer = floorAt(1).spec.map;
    expect(roomer.class === 'Roomer' ? roomer.nbRooms : null).toBe(12);
    expect(floorAt(2).enemyCount).toBe(30);
    expect(floorAt(6).enemyCount).toBe(Math.ceil((3600 * 60) / 4900));
    for (let s = 0; s < 40; s += 1) {
      const seed = `enemies:${String(s)}`;
      const raw = alterLevelData(9, undefined, createRng(seed));
      const area = raw.width * raw.height;
      const at = (n: number): TowerFloor =>
        alterLevelData(9, { layoutN: n, vgridN: 1 }, createRng(seed));
      expect(raw.enemyCount).toBe(Math.ceil((area * 34) / 4900));
      expect(at(2).enemyCount).toBe(Math.ceil((area * 40) / 4900));
      expect(at(6).enemyCount).toBe(Math.ceil((area * 60) / 4900));
      for (const n of [3, 4, 5, 7, 8]) {
        const floor = at(n);
        expect(floor.enemyCount).toBe(Math.ceil((floor.width * floor.height * 34) / 4900));
      }
    }
  });
});

describe('the grid keys (zone.lua:237-249)', () => {
  it('writes the set: up is the floor, and down is the first exit`s set`s floor', () => {
    for (let g = 1; g <= 17; g += 1) {
      const set = ID_GRID_SETS[g - 1];
      if (set === undefined) throw new Error(`no set ${String(g)}`);
      for (let n = 1; n <= 8; n += 1) {
        const floor = alterLevelData(5, { layoutN: n, vgridN: g }, createRng(`keys:${String(g)}`));
        const destination = ID_GRID_SETS[floor.exits[0].vgridN - 1];
        expect(floor.gridsName).toBe(set.id);
        expect(floor.spec.map.grid).toEqual({
          floor: set.floor,
          '.': set.floor,
          external_floor: set.floor,
          outside_floor: set.floor,
          wall: set.wall,
          '#': set.wall,
          up: set.floor,
          down: destination?.floor,
          door: set.door,
          "'": set.door,
        });
      }
    }
  });
});

describe('each layout`s table (zone.lua:110-179)', () => {
  it('rolls every parameter in upstream`s ranges, the second sqrt_percent the one kept', () => {
    const sqrt = new Set<number>();
    for (let s = 0; s < 300; s += 1) {
      const lev = 1 + (s % 60);
      const at = (n: number): TowerFloor =>
        alterLevelData(lev, { layoutN: n, vgridN: 1 }, createRng(`params:${String(s)}`));
      const area = at(1).width * at(1).height;
      const clearing = {
        forestClearing: { pitChance: Math.min(Math.max(lev, 10), 50), filters: [{}] },
      };

      const forest = at(2).spec.map;
      if (forest.class !== 'Forest') throw new Error('not a forest');
      expect([
        [2, 8],
        [4, 6],
        [6, 4],
        [8, 2],
      ]).toContainEqual(forest.edgeEntrances);
      expect(forest.zoom).toBeGreaterThanOrEqual(2);
      expect(forest.zoom).toBeLessThanOrEqual(6);
      sqrt.add(forest.sqrtPercent ?? -1);
      expect(forest.noise).toBe('fbm_perlin');
      expect(forest.nbRooms).toBeGreaterThanOrEqual(1);
      expect(forest.nbRooms).toBeLessThanOrEqual(Math.ceil(area / 2000));
      expect(forest.rooms).toEqual([
        'forest_clearing',
        ['lesser_vault', Math.floor(40 / lev)],
        'lesser_vault',
      ]);
      expect(JSON.parse(JSON.stringify(forest.roomsConfig))).toEqual(clearing);
      expect(forest.lesserVaultsList).toEqual(TOWER_VAULTS);

      const cavern = at(3).spec.map;
      if (cavern.class !== 'Cavern') throw new Error('not a cavern');
      expect(cavern.zoom).toBeGreaterThanOrEqual(12);
      expect(cavern.zoom).toBeLessThanOrEqual(20);
      expect(cavern.minFloor).toBeGreaterThanOrEqual(Math.trunc((area * 0.4) / 2));
      expect(cavern.minFloor).toBeLessThanOrEqual(Math.trunc(area * 0.4));

      const town = at(5).spec.map;
      if (town.class !== 'Town') throw new Error('not a town');
      expect(town.buildingChance).toBeGreaterThanOrEqual(50);
      expect(town.buildingChance).toBeLessThanOrEqual(90);
      for (const side of [town.maxBuildingW, town.maxBuildingH]) {
        expect(side).toBeGreaterThanOrEqual(6);
        expect(side).toBeLessThanOrEqual(11);
      }
      expect(town.edgeEntrances).toEqual([6, 4]);
      expect([1, 2]).toContain(town.nbRooms);
      expect(town.rooms).toEqual([
        'forest_clearing',
        ['lesser_vault', Math.floor(40 / lev)],
        ['lesser_vault', 2 * lev],
      ]);
      expect(JSON.parse(JSON.stringify(town.roomsConfig))).toEqual(clearing);

      const building = at(6).spec.map;
      if (building.class !== 'Building') throw new Error('not a building');
      expect(building.nbRooms).toBeGreaterThanOrEqual(0);
      expect(building.nbRooms).toBeLessThanOrEqual(Math.ceil(area / 2000));
      expect(building.rooms).toEqual([['lesser_vault', Math.floor(40 / lev)], 'lesser_vault']);
      expect(building.maxBuildingW).toBeLessThanOrEqual(Math.trunc(sizeOf(lev) / 6));

      const roomer = at(1).spec.map;
      expect(roomer).toMatchObject({
        rooms: ['random_room', ['pit', 3], ['lesser_vault', 7]],
        liteRoomChance: 50,
        nbRooms: 4 + Math.ceil((area * 10) / 4900),
      });
      expect(at(7).spec.map).toMatchObject({
        mainRadius: [0.25, 0.35],
        armsRadius: [0.1, 0.2],
        armsRange: [0.7, 0.8],
        nbRooms: [5, 10],
      });
      expect(at(8).spec.map).toMatchObject({
        segmentWideChance: 70,
        nbSegments: 8,
        nbLayers: 6,
        segmentMissPercent: 10,
      });
    }
    // Only the second call's 5..10 reaches the table; the first's 30..50 never does.
    expect([...sqrt].sort((a, b) => a - b)).toEqual([5, 6, 7, 8, 9, 10]);
  });

  it('lights each layout as its generator reads the chance', () => {
    const lights = TOWER_LAYOUTS.map((_, i) => {
      const floor = alterLevelData(6, { layoutN: i + 1, vgridN: 1 }, createRng('light'));
      return floor.lighting;
    });
    const building = alterLevelData(6, { layoutN: 6, vgridN: 1 }, createRng('light')).spec.map;
    expect(lights).toEqual([
      { litRoomChance: 50 },
      { litRoomChance: 100 },
      { litRoomChance: 100 },
      {},
      { litRoomChance: 100 },
      { litRoomChance: building.class === 'Building' ? building.liteRoomChance : null },
      {},
      {},
    ]);
  });

  it('carries a vault weight of 0 past level 40 beside an unweighted room, which the loader accepts', () => {
    for (const n of [2, 5, 6]) {
      const floor = alterLevelData(41, { layoutN: n, vgridN: 1 }, createRng('weight'));
      const map = floor.spec.map;
      const rooms = 'rooms' in map ? (map.rooms ?? []) : [];
      expect(rooms).toContainEqual(['lesser_vault', 0]);
      expect(rooms.some((r) => typeof r === 'string')).toBe(true);
    }
  });
});

describe('every layout in every grid set, built as newLevel builds it', () => {
  /**
   * `keepTrying` with the table rolled once a round from that round's own
   * stream, as a zone that rolls its table does (`mapgen/zones.ts` `zoneTable`),
   * and the floor that round rolled kept beside it.
   */
  function build(lev: number, entry: TowerEntry, seed: string) {
    const floors = new Map<LevelSpec, TowerFloor>();
    const level = keepTrying(
      (round) => {
        const floor = alterLevelData(lev, entry, createRng(`${round}:alter_level_data`));
        floors.set(floor.spec, floor);
        return floor.spec;
      },
      seed,
      { level: lev, maxLevel: MAX_LEVEL },
    );
    const floor = floors.get(level.spec);
    if (floor === undefined) throw new Error('keepTrying built a table nobody rolled');
    return { level, floor };
  }

  // Level 50 puts every weighted lesser vault at 0 (`floor(40/50)`) and the
  // town's greater vault at 100.
  it.each([1, 50])(
    'certifies every one at level %i, up joined to down, stairs drawn as upstream draws them',
    (lev) => {
      for (let n = 1; n <= 8; n += 1) {
        for (let g = 1; g <= 17; g += 1) {
          const seed = `tower:${String(lev)}:${String(n)}:${String(g)}`;
          const { level, floor } = build(lev, { layoutN: n, vgridN: g }, seed);
          const { map } = level;
          expect(level.failed, seed).toBe(false);
          expect([map.view.w, map.view.h], seed).toEqual([floor.width, floor.height]);
          const up = map.spawns[0];
          const { down } = map;
          if (up === undefined || down === undefined)
            throw new Error(`${seed}: a stair is missing`);
          expect(reaches(map, up, down), seed).toBe(true);
          const set = ID_GRID_SETS[g - 1];
          const destination = ID_GRID_SETS[floor.exits[0].vgridN - 1];
          expect(map.view.tiles[up.y * map.view.w + up.x], seed).toBe(set?.floor);
          expect(map.view.tiles[down.y * map.view.w + down.x], seed).toBe(destination?.floor);
        }
      }
    },
  );
});
