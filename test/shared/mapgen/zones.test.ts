// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// The tables under test are ported from t-engine4 game/modules/tome/data/zones/*/zone.lua,
//   each cited on its pin below, and merged per level as game/engines/default/engine/Zone.lua:833-843 does.
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

import { describe, expect, it } from 'vitest';

import type { TileXY } from '../../../src/shared/coords.ts';
import type { AuthoredMap } from '../../../src/shared/level.ts';
import { infiniteDungeonBuilding } from '../../../src/shared/mapgen/building.ts';
import { passable, sealUnreachable, sealedShare } from '../../../src/shared/mapgen/connectivity.ts';
import { keepTrying } from '../../../src/shared/mapgen/level.ts';
import { chance, percent } from '../../../src/shared/mapgen/lua.ts';
import {
  MAX_SEALED_SHARE,
  ZONES,
  siteLighting,
  zoneFloor,
  zoneLevel,
  zoneTable,
} from '../../../src/shared/mapgen/zones.ts';
import type { ZoneDef } from '../../../src/shared/mapgen/zones.ts';
import { TileCode, isWalkable } from '../../../src/shared/protocol.ts';
import { createRng } from '../../../src/shared/rng.ts';
import type { Rng } from '../../../src/shared/rng.ts';

/** Stands in for a grid key that is a function: compared by being one. */
const FN = '<function>';

/** `value` with every function replaced by `FN`, so a table can be compared whole. */
function plain(value: unknown): unknown {
  if (typeof value === 'function') return FN;
  if (Array.isArray(value)) return value.map(plain);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plain(v)]));
  }
  return value;
}

/** Every floor of a zone as data: its level, its light and its merged table. */
function pinned(def: ZoneDef): unknown {
  return {
    name: def.name,
    palette: def.palette,
    floors: def.floors.map((l) => ({
      zone: l.zone,
      level: l.level,
      maxLevel: l.maxLevel,
      lighting: l.lighting,
      rolled: l.alter !== undefined,
      table: plain(l.table(def.palette)),
    })),
  };
}

const RUIN_VAULTS = [
  'vault:half_partition',
  'vault:filing_chamber',
  'vault:collapsed_gallery',
  'vault:clerks_box',
];
const WORKS_VAULTS = [
  'vault:filing_chamber',
  'vault:half_partition',
  'vault:sealed_shaft',
  'vault:shelving_run',
  'vault:clerks_box',
];

const { SHORE, TERRACE, SOOT, CRAG, GREEN, TREES, HEATH, WORKS, PLAINS, MOUNTAIN, PAVING } =
  TileCode;
const { ERASED, CIVIC, DOOR } = TileCode;

/** `n` of `code`. */
function times(code: number, n: number): number[] {
  return Array.from({ length: n }, () => code);
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE TABLE, WRITTEN OUT AGAIN FROM EACH zone.lua — NOT READ BACK FROM zones.ts
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Every number, list and edge is the Lua's, cited at the line it is on. The
 * grids are the site's palette with the substitutions `shared/mapgen/zones.ts`
 * states, in the SHAPE the Lua gives them: a table stays its length.
 */
const EXPECTED: Readonly<Record<string, unknown>> = {
  // halfling-ruins/zone.lua: max_level :24, 50x50 :27, all_lited :30, Roomer :34-47,
  // level 1 Town :63-79 merged over it; level 4 static :81-95.
  'site:drowned_chapel': {
    name: 'Ruined halfling complex',
    palette: { floor: SHORE, wall: TERRACE },
    floors: [
      {
        zone: 'halfling-ruins',
        level: 1,
        maxLevel: 4,
        lighting: 'all_lited',
        rolled: false,
        table: {
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
              floor: SHORE,
              external_floor: SHORE,
              up: SHORE,
              wall: TERRACE,
              down: SHORE,
              door: DOOR,
              '.': SHORE,
              '#': TERRACE,
            },
          },
        },
      },
      ...[2, 3].map((level) => ({
        zone: 'halfling-ruins',
        level,
        maxLevel: 4,
        lighting: 'all_lited',
        rolled: false,
        table: {
          width: 50,
          height: 50,
          map: {
            class: 'Roomer',
            nbRooms: 10,
            rooms: ['random_room', ['money_vault', 5], ['lesser_vault', 8]],
            lesserVaultsList: RUIN_VAULTS,
            liteRoomChance: 100,
            forceLastStair: true,
            grid: { '.': SHORE, '#': TERRACE, up: SHORE, down: SHORE, door: DOOR },
          },
        },
      })),
    ],
  },
  // orc-breeding-pit/zone.lua: max_level :24, 50x50 :27, all_lited commented :30,
  // Cavern zoom 23 min_floor 900 :35-44; level 1 static :75-82, level 3 15x15 :83.
  'site:underworks': {
    name: 'Orc breeding pits',
    palette: { floor: SOOT, wall: CRAG },
    floors: [
      {
        zone: 'orc-breeding-pit',
        level: 2,
        maxLevel: 3,
        lighting: { litRoomChance: 100 },
        rolled: false,
        table: {
          width: 50,
          height: 50,
          map: {
            class: 'Cavern',
            zoom: 23,
            minFloor: 900,
            forceLastStair: true,
            grid: { floor: SOOT, wall: CRAG, up: SOOT, down: SOOT, door: SOOT },
          },
        },
      },
    ],
  },
  // old-forest/zone.lua: max_level :27, 50x50 :30, all_lited :32, Roomer :43-54;
  // level 4 edge_entrances {4,2} :79-85.
  'site:barrow_end': {
    name: 'Old Forest',
    palette: { floor: GREEN, wall: TREES },
    floors: [1, 2, 3, 4].map((level) => ({
      zone: 'old-forest',
      level,
      maxLevel: 4,
      lighting: 'all_lited',
      rolled: false,
      table: {
        width: 50,
        height: 50,
        map: {
          class: 'Roomer',
          nbRooms: 11,
          edgeEntrances: level === 4 ? [4, 2] : [4, 6],
          rooms: ['forest_clearing', ['lesser_vault', 8]],
          roomsConfig: {
            forestClearing: {
              pitChance: 5,
              filters: [
                { type: 'insect', subtype: 'ant' },
                { type: 'insect' },
                { type: 'animal', subtype: 'snake' },
                { type: 'animal', subtype: 'canine' },
              ],
            },
          },
          lesserVaultsList: RUIN_VAULTS,
          forceLastStair: true,
          grid: { '.': GREEN, '#': TREES, up: GREEN, down: GREEN, door: GREEN },
        },
      },
    })),
  },
  // heart-gloom/zone.lua: max_level :27, 50x50 :30, all_lited :34, Octopus :40-73.
  'site:cairnfoot': {
    name: 'Heart of the Gloom',
    palette: { floor: HEATH, wall: CRAG },
    floors: [1, 2, 3].map((level) => ({
      zone: 'heart-gloom',
      level,
      maxLevel: 3,
      lighting: 'all_lited',
      rolled: false,
      table: {
        width: 50,
        height: 50,
        map: {
          class: 'Octopus',
          mainRadius: [0.3, 0.4],
          armsRadius: [0.1, 0.2],
          armsRange: [0.7, 0.8],
          nbRooms: [5, 9],
          forceLastStair: true,
          grid: {
            '#': [TREES, ...times(CRAG, 11)],
            '.': times(HEATH, 8),
            up: HEATH,
            down: HEATH,
            door: HEATH,
          },
        },
      },
    })),
  },
  // lake-nur/zone.lua: max_level :27, 50x50 :30, all_lited commented :32, Roomer :41-50;
  // level 1 static :67-85, level 3's grids by layout :95-118.
  'site:the_weir': {
    name: 'Lake of Nur',
    palette: { floor: SHORE, wall: WORKS },
    floors: [
      {
        zone: 'lake-nur',
        level: 2,
        maxLevel: 3,
        lighting: { litRoomChance: 0 },
        rolled: false,
        table: {
          width: 50,
          height: 50,
          map: {
            class: 'Roomer',
            nbRooms: 10,
            rooms: ['random_room'],
            liteRoomChance: 0,
            forceLastStair: true,
            grid: { '.': times(SHORE, 11), '#': WORKS, up: SHORE, down: SHORE, door: DOOR },
          },
        },
      },
    ],
  },
  // rhaloren-camp/zone.lua OVERGROUND: max_level :98, 50x50 :101, all_lited :104, Town :112-130;
  // DEFAULT: all_lited commented :34, Roomer :39-49; both levels 3 static (:72-82, :153-163).
  'site:watchers_altar': {
    name: 'Rhaloren Camp',
    palette: { floor: PLAINS, wall: CRAG },
    floors: [
      ...[1, 2].map((level) => ({
        zone: 'rhaloren-camp OVERGROUND',
        level,
        maxLevel: 3,
        lighting: 'all_lited',
        rolled: false,
        table: {
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
            lesserVaultsList: RUIN_VAULTS,
            liteRoomChance: 100,
            forceLastStair: true,
            grid: {
              floor: PLAINS,
              external_floor: [...times(PLAINS, 15), TREES],
              wall: CRAG,
              up: PLAINS,
              down: PLAINS,
              door: DOOR,
              '#': CRAG,
              '.': PLAINS,
              '+': DOOR,
            },
          },
        },
      })),
      {
        zone: 'rhaloren-camp DEFAULT',
        level: 2,
        maxLevel: 3,
        lighting: { litRoomChance: 100 },
        rolled: false,
        table: {
          width: 50,
          height: 50,
          map: {
            class: 'Roomer',
            nbRooms: 10,
            rooms: ['random_room', ['money_vault', 5], ['lesser_vault', 8]],
            lesserVaultsList: RUIN_VAULTS,
            liteRoomChance: 100,
            forceLastStair: true,
            grid: { '.': PLAINS, '#': CRAG, up: PLAINS, down: PLAINS, door: DOOR },
          },
        },
      },
    ],
  },
  // ardhungol/zone.lua: max_level :24, 60x60 :27, all_lited commented :29, Cavern :38-47;
  // level 2 40x40 min_floor 600 :69, level 3 20x20 :70.
  'site:hollow_mine': {
    name: 'Ardhungol',
    palette: { floor: SOOT, wall: MOUNTAIN },
    floors: [
      [1, 60, 1100],
      [2, 40, 600],
    ].map(([level, side, minFloor]) => ({
      zone: 'ardhungol',
      level,
      maxLevel: 3,
      lighting: { litRoomChance: 100 },
      rolled: false,
      table: {
        width: side,
        height: side,
        map: {
          class: 'Cavern',
          zoom: 16,
          minFloor,
          forceLastStair: true,
          grid: { floor: FN, wall: MOUNTAIN, up: SOOT, down: SOOT, door: SOOT },
        },
      },
    })),
  },
  // maze/zone.lua DEFAULT: max_level :139, 60x60 :142, all_lited commented :144,
  // Maze widen 2 :150-156; level 2 20x20 :180-188.
  'site:outer_index': {
    name: 'The Maze',
    palette: { floor: PAVING, wall: ERASED },
    floors: [
      {
        zone: 'maze DEFAULT',
        level: 1,
        maxLevel: 2,
        lighting: {},
        rolled: false,
        table: {
          width: 60,
          height: 60,
          map: {
            class: 'Maze',
            widenW: 2,
            widenH: 2,
            forceLastStair: true,
            grid: { floor: PAVING, wall: ERASED, up: PAVING, down: PAVING },
          },
        },
      },
    ],
  },
  // scintillating-caves/zone.lua TWISTED: max_level :27, 30x30 :30, all_lited :34, Roomer :40-49.
  'site:glass_archive': {
    name: 'Scintillating Caves',
    palette: { floor: PAVING, wall: CIVIC },
    floors: [1, 2, 3, 4].map((level) => ({
      zone: 'scintillating-caves TWISTED',
      level,
      maxLevel: 5,
      lighting: 'all_lited',
      rolled: false,
      table: {
        width: 30,
        height: 30,
        map: {
          class: 'Roomer',
          nbRooms: 5,
          rooms: ['random_room', ['money_vault', 5]],
          liteRoomChance: 20,
          forceLastStair: true,
          grid: { '.': PAVING, '#': times(CIVIC, 20), up: PAVING, down: PAVING, door: PAVING },
        },
      },
    })),
  },
  // infinite-dungeon/zone.lua: max_level :27, all_lited commented :31, building layout
  // :153-162 rolled by alter_level_data, default grid set :186 written in :237-249.
  'site:gearford_ward': {
    name: 'Infinite Dungeon',
    palette: { floor: SOOT, wall: WORKS },
    floors: [1, 2, 3, 4].map((level) => ({
      zone: 'infinite-dungeon building',
      level,
      maxLevel: 1000000000,
      lighting: 'rolled',
      rolled: true,
      table: {
        width: 50,
        height: 50,
        map: {
          class: 'Building',
          lesserVaultsList: WORKS_VAULTS,
          forceLastStair: true,
          grid: {
            floor: SOOT,
            '.': SOOT,
            external_floor: SOOT,
            outside_floor: SOOT,
            wall: WORKS,
            '#': WORKS,
            door: DOOR,
            up: SOOT,
            down: SOOT,
          },
        },
      },
    })),
  },
  // trollmire/zone.lua DEFAULT: max_level :157, 65x40 :160, all_lited :162, Forest :171-193
  // (ponds :184-188 not dug); level 3's Prox room :220-228, level 4 static :230-241.
  'site:blackwood_outskirts': {
    name: 'Trollmire',
    palette: { floor: HEATH, wall: TREES },
    floors: [1, 2].map((level) => ({
      zone: 'trollmire DEFAULT',
      level,
      maxLevel: 3,
      lighting: 'all_lited',
      rolled: false,
      table: {
        width: 65,
        height: 40,
        map: {
          class: 'Forest',
          edgeEntrances: [4, 6],
          zoom: 4,
          sqrtPercent: 30,
          noise: 'fbm_perlin',
          addRoad: true,
          nbRooms: [0, 0, 0, 1],
          rooms: ['lesser_vault'],
          lesserVaultsList: RUIN_VAULTS,
          liteRoomChance: 100,
          forceLastStair: true,
          grid: {
            floor: FN,
            wall: TREES,
            up: HEATH,
            down: HEATH,
            door: HEATH,
            road: HEATH,
            '.': FN,
            '#': TREES,
          },
        },
      },
    })),
  },
};

describe('the zone table, pinned to each zone.lua', () => {
  it('builds exactly the eleven delves of the moor, and nothing else', () => {
    expect([...ZONES.keys()].toSorted()).toEqual(Object.keys(EXPECTED).toSorted());
  });

  for (const [site, expected] of Object.entries(EXPECTED)) {
    it(`builds ${site} as its zone's levels`, () => {
      const def = ZONES.get(site);
      if (def === undefined) throw new Error(`no zone for ${site}`);
      expect(pinned(def)).toEqual(expected);
    });
  }

  /** The draws `key` makes, as the number the stream is on after it. */
  function after(fn: (rng: Rng) => unknown): number {
    const rng = createRng('zones:draws');
    fn(rng);
    return rng.nextU32('probe');
  }

  it('keeps a function grid`s roll, whichever grid it now returns', () => {
    // ardhungol/zone.lua:42: `rng.percent(96)` CAVEFLOOR, else WORMHOLE.
    const mine = ZONES.get('site:hollow_mine');
    const wood = ZONES.get('site:blackwood_outskirts');
    if (mine === undefined || wood === undefined) throw new Error('no zones');
    for (const level of mine.floors) {
      const floor = level.table(mine.palette).map.grid['floor'];
      if (typeof floor !== 'function') throw new Error('ardhungol floor is not a function');
      expect(floor(createRng('x'))).toBe(SOOT);
      expect(after(floor)).toBe(after((rng) => percent(rng, 'x', 96)));
      expect(after(floor)).not.toBe(after(() => undefined));
    }
    // trollmire/zone.lua:177: `rng.chance(20)` FLOWER, else GRASS — for both keys.
    for (const level of wood.floors) {
      const { grid } = level.table(wood.palette).map;
      for (const key of ['floor', '.']) {
        const fn = grid[key];
        if (typeof fn !== 'function') throw new Error(`trollmire ${key} is not a function`);
        expect(fn(createRng('x'))).toBe(HEATH);
        expect(after(fn)).toBe(after((rng) => chance(rng, 'x', 20)));
        expect(after(fn)).not.toBe(after(() => undefined));
      }
    }
  });
});

/** Up to down, 8-way, a shut door passable: `Zone:newLevel`'s question, asked again here. */
function reach(map: AuthoredMap, from: TileXY): Uint8Array {
  const { w, h, tiles } = map.view;
  const seen = new Uint8Array(w * h);
  seen[from.y * w + from.x] = 1;
  const queue = [from.y * w + from.x];
  for (let head = 0; head < queue.length; head += 1) {
    const at = queue[head] ?? 0;
    const x = at % w;
    const y = (at - x) / w;
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h || seen[ny * w + nx] === 1) continue;
        const code = tiles[ny * w + nx] ?? TileCode.WALL;
        if (code !== TileCode.DOOR && !isWalkable(code)) continue;
        seen[ny * w + nx] = 1;
        queue.push(ny * w + nx);
      }
    }
  }
  return seen;
}

describe('zoneLevel', () => {
  it('builds every floor of every zone certified: up reaches down, and nothing else is ground', () => {
    for (const [site, def] of ZONES) {
      def.floors.forEach((level, i) => {
        const floor = i + 1;
        for (let s = 0; s < 3; s += 1) {
          const at = `${site} floor ${String(floor)} seed ${String(s)}`;
          const map = zoneLevel(site, `zones:${String(s)}`, floor);
          const table = level.table(def.palette);
          expect([map.view.w, map.view.h], at).toEqual([table.width, table.height]);
          const up = map.spawns[0];
          const down = map.down;
          if (up === undefined || down === undefined) throw new Error(`${at}: no stairs`);
          expect(isWalkable(map.view.tiles[up.y * map.view.w + up.x] ?? -1), at).toBe(true);
          const reached = reach(map, up);
          expect(reached[down.y * map.view.w + down.x], `${at}: down cut off`).toBe(1);
          // SEALED: every cell a body could stand in or open is reached.
          map.view.tiles.forEach((code, t) => {
            if (code === TileCode.DOOR || isWalkable(code)) {
              expect(reached[t], `${at}: ground at ${String(t)} nobody can reach`).toBe(1);
            }
          });
        }
      });
    }
  });

  it('makes rock of the ground its up stair cannot reach, in the palette`s wall, and of nothing else', () => {
    // The level `keepTrying` certified, before the seal: every cell the seal
    // changed was a cell a body could stand in or open, and is now the wall of
    // the palette the floor was drawn in — the zone's own, or one given.
    const other = { floor: TileCode.FLOOR, wall: TileCode.WALL };
    for (const painted of [false, true]) {
      let sealed = 0;
      for (const [site, def] of ZONES) {
        const palette = painted ? other : def.palette;
        def.floors.forEach((level, i) => {
          if (level.alter !== undefined) return;
          for (let s = 0; s < 3; s += 1) {
            const seed = `seal:${String(s)}`;
            const at = `${site} floor ${String(i + 1)} seed ${String(s)}`;
            const opts = { level: level.level, maxLevel: level.maxLevel };
            const certified = keepTrying(level.table(palette), seed, opts).map;
            // A level the seal would halve is refused and another built; not these.
            expect(sealedShare(certified), at).toBeLessThanOrEqual(MAX_SEALED_SHARE);
            const before = certified.view.tiles;
            const after = zoneLevel(site, seed, i + 1, painted ? other : undefined).view.tiles;
            after.forEach((code, t) => {
              const was = before[t] ?? -1;
              if (code === was) return;
              sealed += 1;
              expect(was === TileCode.DOOR || isWalkable(was), `${at}: sealed a solid cell`).toBe(
                true,
              );
              expect(code, at).toBe(palette.wall);
            });
          }
        });
      }
      // A wood's trees ring clearings nobody can walk into, so some ground is sealed.
      expect(sealed).toBeGreaterThan(0);
    }
  });

  it('refuses a level its seal would leave less than half of, and builds the next attempt', () => {
    // Two floors of the Redaction's Glass Archive as they shipped (found live,
    // 2026-09-17): both stairs in one room no tunnel joined, which upstream's
    // up-to-down check passes, sealed down to 21 cells with no monster in them
    // and to 61 with twelve bodies round the arrival. A seal that takes more
    // than HALF the ground is refused instead (`MAX_SEALED_SHARE`).
    expect(MAX_SEALED_SHARE).toBe(0.5);
    const def = ZONES.get('site:glass_archive');
    if (def === undefined) throw new Error('no Glass Archive zone');
    const ground = (m: AuthoredMap): number => m.view.tiles.filter((c) => passable(c)).length;
    for (const { seed, floor, shipped } of [
      { seed: 'live-zones:realm:site:redaction:glass_archive:18131', floor: 1, shipped: 21 },
      { seed: 'live-zones:realm:site:redaction:glass_archive:18442', floor: 2, shipped: 61 },
    ]) {
      const level = zoneFloor(def, floor);
      const opts = { level: level.level, maxLevel: level.maxLevel };
      const upstream = keepTrying(level.table(def.palette), seed, opts);
      expect(ground(sealUnreachable(upstream.map, def.palette.wall)), seed).toBe(shipped);
      expect(sealedShare(upstream.map), seed).toBeGreaterThan(0.5);

      const refused: string[] = [];
      const ours = keepTrying(level.table(def.palette), seed, {
        ...opts,
        refuse: (m) => {
          if (sealedShare(m) <= 0.5) return null;
          refused.push('sealed');
          return 'sealed';
        },
      });
      expect(refused.length, seed).toBeGreaterThan(0);
      expect(ours.attempts, seed).toBeGreaterThan(upstream.attempts);
      expect(sealedShare(ours.map), seed).toBeLessThanOrEqual(0.5);
      const map = zoneLevel('site:glass_archive', seed, floor);
      expect(map.view, seed).toEqual(sealUnreachable(ours.map, def.palette.wall).view);
      expect(ground(map), seed).toBeGreaterThanOrEqual(ground(ours.map) / 2);
    }
  });

  it('rolls a rolled table from the seed of the round asking, and hands a fixed table as it is', () => {
    // Each `keepTrying` round is a level change of its own, and upstream rolls
    // `alter_level_data` once per level change (`engine/Zone.lua:892`).
    const gearford = ZONES.get('site:gearford_ward');
    const chapel = ZONES.get('site:drowned_chapel');
    if (gearford === undefined || chapel === undefined) throw new Error('no zones');
    const level = zoneFloor(gearford, 3);
    const { alter } = level;
    const rolled = zoneTable(level, gearford.palette);
    if (typeof rolled !== 'function' || alter === undefined)
      throw new Error('Gearford rolls nothing');
    const tables = new Set<string>();
    for (const round of ['s', 's~1', 's~2', 's~3', 't', 't~1']) {
      const want = alter(gearford.palette, createRng(`${round}:alter_level_data`), 3);
      expect(rolled(round), round).toEqual(want);
      tables.add(JSON.stringify(plain(want)));
    }
    expect(tables.size, 'every round rolled the same table').toBeGreaterThan(3);
    const fixed = zoneFloor(chapel, 2);
    expect(zoneTable(fixed, chapel.palette)).toEqual(fixed.table(chapel.palette));
  });

  it('is the same floor for the same seed, and another for another', () => {
    for (const site of ZONES.keys()) {
      const a = zoneLevel(site, 'same', 1);
      expect(zoneLevel(site, 'same', 1), site).toEqual(a);
      expect(zoneLevel(site, 'other', 1).view.tiles, site).not.toEqual(a.view.tiles);
    }
  });

  it('builds a floor past the zone`s last as its last', () => {
    for (const [site, def] of ZONES) {
      const last = def.floors.length;
      expect(zoneLevel(site, 'deep', last + 3), site).toEqual(zoneLevel(site, 'deep', last));
      expect(zoneFloor(def, last + 3)).toBe(def.floors[last - 1]);
    }
  });

  it('builds each floor as its own level where the zone has several', () => {
    const chapel = ZONES.get('site:drowned_chapel');
    const mine = ZONES.get('site:hollow_mine');
    if (chapel === undefined || mine === undefined) throw new Error('no zones');
    expect(zoneFloor(chapel, 1).table(chapel.palette).map.class).toBe('Town');
    expect(zoneFloor(chapel, 2).table(chapel.palette).map.class).toBe('Roomer');
    expect(zoneLevel('site:hollow_mine', 'size', 1).view.w).toBe(60);
    expect(zoneLevel('site:hollow_mine', 'size', 2).view.w).toBe(40);
    expect(zoneLevel('site:hollow_mine', 'size', 4).view.w).toBe(40);
  });

  it('refuses a site with no zone and a floor that is not one', () => {
    expect(() => zoneLevel('site:alderbrook', 's', 1)).toThrow(/has no zone/);
    expect(() => zoneLevel('site:underworks', 's', 0)).toThrow(RangeError);
    expect(() => zoneLevel('site:underworks', 's', 1.5)).toThrow(RangeError);
  });

  it('draws the floor in the palette it is given, on the same cells', () => {
    // A substitution renames codes and spends no draw, so another walkable floor
    // and another solid wall lay the same ground.
    const other = { floor: TileCode.FLOOR, wall: TileCode.WALL };
    for (const [site, def] of ZONES) {
      const own = zoneLevel(site, 'palette', 1);
      const painted = zoneLevel(site, 'palette', 1, other);
      expect(own.spawns, site).toEqual(painted.spawns);
      const walk = (m: AuthoredMap): boolean[] => m.view.tiles.map((c) => isWalkable(c));
      expect(walk(painted), site).toEqual(walk(own));
      expect(new Set(painted.view.tiles).has(def.palette.floor), site).toBe(
        def.palette.floor === other.floor,
      );
      expect(painted.view.tiles, site).toContain(TileCode.FLOOR);
    }
  });

  it('lights each map as its level says', () => {
    for (const [site, def] of ZONES) {
      def.floors.forEach((level, i) => {
        const map = zoneLevel(site, 'light', i + 1);
        if (level.lighting === 'rolled') return;
        expect(map.lighting, `${site} floor ${String(i + 1)}`).toEqual(
          siteLighting(level.lighting),
        );
      });
    }
    expect(siteLighting('all_lited')).toEqual({ allLit: true });
    expect(siteLighting({ litRoomChance: 20 })).toEqual({ litRoomChance: 20 });
    expect(siteLighting({})).toEqual({});
  });

  it('rolls a Gearford floor`s table for its own level, and builds that table', () => {
    // `alter_level_data(zone, lev, data)`: the lesser vault's weight is
    // `math.floor(40/lev)` (infinite-dungeon/zone.lua:157), so the level a floor
    // is rolled at is in its table — and in the map that table builds.
    const def = ZONES.get('site:gearford_ward');
    if (def === undefined) throw new Error('no Gearford zone');
    let differs = 0;
    for (let s = 0; s < 9; s += 1) {
      const floor = 2 + (s % 3);
      const seed = `rolled-table:${String(s)}`;
      const { alter } = zoneFloor(def, floor);
      if (alter === undefined) throw new Error('Gearford rolls nothing');
      const rolledAt = (lev: number) =>
        alter(def.palette, createRng(`${seed}:alter_level_data`), lev);
      const table = rolledAt(floor);
      expect(table.map.class === 'Building' ? table.map.rooms : null, seed).toEqual([
        ['lesser_vault', Math.floor(40 / floor)],
        'lesser_vault',
      ]);
      // Round 0 certifies on every seed here, so one table built it.
      const opts = { level: floor, maxLevel: 1000000000 };
      const want = sealUnreachable(keepTrying(table, seed, opts).map, def.palette.wall);
      expect(zoneLevel('site:gearford_ward', seed, floor).view, seed).toEqual(want.view);
      const atOne = keepTrying(rolledAt(1), seed, opts).map;
      if (JSON.stringify(atOne.view) !== JSON.stringify(want.view)) differs += 1;
    }
    expect(differs, 'the level rolled at never changed a floor').toBeGreaterThan(0);
  });

  /**
   * `size = 60 + math.floor(30*lev/(lev + 50))` (infinite-dungeon/zone.lua:103)
   * for levels 1 to 4, worked out by hand: 30/51, 60/52, 90/53 and 120/54 floor
   * to 0, 1, 1 and 2. The map stays 50x50.
   */
  const GEARFORD_SIZE: Readonly<Record<number, number>> = { 1: 60, 2: 61, 3: 61, 4: 62 };

  it('rolls a Gearford floor`s layout as the Lua does: at the level`s own size, on the 50x50 map', () => {
    // `max_building_w = rng.range(4, size/6)` (:160): 4..10 at these levels.
    const def = ZONES.get('site:gearford_ward');
    if (def === undefined) throw new Error('no Gearford zone');
    for (const floor of [1, 2, 3, 4]) {
      const { alter } = zoneFloor(def, floor);
      if (alter === undefined) throw new Error('Gearford rolls nothing');
      for (let s = 0; s < 20; s += 1) {
        const seed = `gearford-size:${String(s)}`;
        const rolled = infiniteDungeonBuilding(
          createRng(seed),
          GEARFORD_SIZE[floor] ?? NaN,
          50,
          50,
          floor,
        );
        expect(alter(def.palette, createRng(seed), floor).map, seed).toMatchObject(rolled);
      }
    }
  });

  it('rolls a Gearford floor`s table from its own seed, and lights it on the chance it rolled', () => {
    const chances = new Set<number>();
    for (let s = 0; s < 12; s += 1) {
      const floor = 1 + (s % 4);
      const seed = `gearford:${String(s)}`;
      const map = zoneLevel('site:gearford_ward', seed, floor);
      // Round 0 is the seed itself, and every floor here certifies on it.
      const rolled = infiniteDungeonBuilding(
        createRng(`${seed}:alter_level_data`),
        GEARFORD_SIZE[floor] ?? NaN,
        50,
        50,
        floor,
      );
      expect(map.lighting, seed).toEqual({ litRoomChance: rolled.liteRoomChance });
      chances.add(rolled.liteRoomChance);
    }
    expect(chances.size).toBeGreaterThan(6);
  });
});
