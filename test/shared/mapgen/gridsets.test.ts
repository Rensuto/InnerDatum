// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// The table under test is ported from t-engine4 game/modules/tome/data/zones/infinite-dungeon/zone.lua:185-203,
//   its doors from game/modules/tome/data/zones/infinite-dungeon/grids.lua:36-229, cited per row below.
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

import { existsSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { createGenMap } from '../../../src/shared/mapgen/genmap.ts';
import { ID_GRID_SETS } from '../../../src/shared/mapgen/gridsets.ts';
import type { GridSet } from '../../../src/shared/mapgen/gridsets.ts';
import { range } from '../../../src/shared/mapgen/lua.ts';
import {
  TileCode,
  alwaysRemembered,
  blocksSight,
  isWalkable,
} from '../../../src/shared/protocol.ts';
import { createRng } from '../../../src/shared/rng.ts';
import {
  ON_STAND,
  airOf,
  isClosedDoorCode,
  isHazardFor,
  openedFormOf,
} from '../../../src/shared/terrain.ts';

/** zone.lua:189's crystal wall, twenty grids. */
// prettier-ignore
const CRYSTAL_WALLS: readonly string[] = [
  'CRYSTAL_WALL', 'CRYSTAL_WALL2', 'CRYSTAL_WALL3', 'CRYSTAL_WALL4', 'CRYSTAL_WALL5',
  'CRYSTAL_WALL6', 'CRYSTAL_WALL7', 'CRYSTAL_WALL8', 'CRYSTAL_WALL9', 'CRYSTAL_WALL10',
  'CRYSTAL_WALL11', 'CRYSTAL_WALL12', 'CRYSTAL_WALL13', 'CRYSTAL_WALL14', 'CRYSTAL_WALL15',
  'CRYSTAL_WALL16', 'CRYSTAL_WALL17', 'CRYSTAL_WALL18', 'CRYSTAL_WALL19', 'CRYSTAL_WALL20',
];

/** `id_grids_name, floor, wall, door, down, desc`: one row of `vgrids`. */
type UpstreamRow = readonly [string, string, string | readonly string[], string, string, string];

/** zone.lua:186-202, as written. */
// prettier-ignore
const UPSTREAM_VGRIDS: readonly UpstreamRow[] = [
  ['default', 'FLOOR', 'WALL', 'DOOR', 'DOWN', 'hewn'],
  ['tree', 'GRASS', 'TREE', 'GRASS_ROCK', 'GRASS_DOWN2', 'sylvan'],
  ['underground', 'UNDERGROUND_FLOOR', 'UNDERGROUND_TREE', 'UNDERGROUND_ROCK', 'UNDERGROUND_LADDER_DOWN', 'subterranean'],
  ['crystals', 'CRYSTAL_FLOOR', CRYSTAL_WALLS, 'CRYSTAL_ROCK', 'CRYSTAL_LADDER_DOWN', 'crystalline'],
  ['sand', 'UNDERGROUND_SAND', 'SANDWALL', 'SAND_ROCK', 'SAND_LADDER_DOWN', 'sandy'],
  ['desert', 'SAND', 'PALMTREE', 'DESERT_ROCK', 'SAND_DOWN2', 'arrid'],
  ['slime', 'SLIME_FLOOR', 'SLIME_WALL', 'SLIME_DOOR', 'SLIME_DOWN', 'slimey'],
  ['jungle', 'JUNGLE_GRASS', 'JUNGLE_TREE', 'JUNGLE_ROCK', 'JUNGLE_GRASS_DOWN2', 'humid, tropical'],
  ['cave', 'CAVEFLOOR', 'CAVEWALL', 'CAVE_ROCK', 'CAVE_LADDER_DOWN', 'unhewn'],
  ['burntland', 'BURNT_GROUND', 'BURNT_TREE', 'BURNT_DOOR', 'BURNT_DOWN6', 'burned'],
  ['mountain', 'ROCKY_GROUND', 'MOUNTAIN_WALL', 'DOOR', 'ROCKY_DOWN2', 'mountainous'],
  ['mountain_forest', 'ROCKY_GROUND', 'ROCKY_SNOWY_TREE', 'ROCKY_SNOWY_DOOR', 'ROCKY_DOWN2', 'alpine'],
  ['snowy_forest', 'SNOWY_GRASS_2', 'SNOWY_TREE_2', 'SNOWY_DOOR', 'snowy_DOWN2', 'cold, wooded'],
  ['temporal_void', 'VOID', 'SPACETIME_RIFT2', 'VOID', 'RIFT2', 'empty'],
  ['water', 'WATER_FLOOR_FAKE', 'WATER_WALL_FAKE', 'WATER_DOOR_FAKE', 'WATER_DOWN_FAKE', 'flooded'],
  ['lava', 'LAVA_FLOOR_FAKE', 'LAVA_WALL_FAKE', 'LAVA_ROCK', 'LAVA_DOWN_FAKE', 'molten'],
  ['autumn_forest', 'AUTUMN_GRASS', 'AUTUMN_TREE', 'AUTUMN_ROCK', 'AUTUMN_GRASS_DOWN2', 'temperate'],
];

/** `id, floor, wall, door` in codes: the Phase 5 design's table (§5.8). */
// prettier-ignore
const CODES: readonly (readonly [string, TileCode, TileCode, TileCode])[] = [
  ['default', TileCode.FLOOR, TileCode.WALL, TileCode.DOOR],
  ['tree', TileCode.GREEN, TileCode.TREES, TileCode.ROCK_DOOR],
  ['underground', TileCode.UNDERGROUND_FLOOR, TileCode.UNDERGROUND_TREE, TileCode.ROCK_DOOR],
  ['crystals', TileCode.CRYSTAL_FLOOR, TileCode.CRYSTAL_WALL, TileCode.ROCK_DOOR],
  ['sand', TileCode.SHORE, TileCode.SANDWALL, TileCode.ROCK_DOOR],
  ['desert', TileCode.SHORE, TileCode.TREES, TileCode.ROCK_DOOR],
  ['slime', TileCode.SLIME_FLOOR, TileCode.SLIME_WALL, TileCode.DOOR],
  ['jungle', TileCode.MIRE, TileCode.TREES, TileCode.ROCK_DOOR],
  ['cave', TileCode.SOOT, TileCode.CRAG, TileCode.ROCK_DOOR],
  ['burntland', TileCode.CHARRED, TileCode.BURNT_TREE, TileCode.ROCK_DOOR],
  ['mountain', TileCode.HILLS, TileCode.MOUNTAIN, TileCode.DOOR],
  ['mountain_forest', TileCode.HILLS, TileCode.COLD_FOREST, TileCode.ROCK_DOOR],
  ['snowy_forest', TileCode.SNOWFIELD, TileCode.COLD_FOREST, TileCode.ROCK_DOOR],
  ['temporal_void', TileCode.VOID, TileCode.SPACETIME_RIFT, TileCode.VOID],
  ['water', TileCode.WATER_FLOOR_FAKE, TileCode.WATER_WALL, TileCode.DOOR],
  ['lava', TileCode.LAVA_FLOOR_FAKE, TileCode.LAVA_WALL, TileCode.ROCK_DOOR],
  ['autumn_forest', TileCode.PLAINS, TileCode.TREES, TileCode.ROCK_DOOR],
];

/**
 * Each door grid's `door_opened`, or undefined for a grid that is no door.
 *
 * DOOR `data/general/grids/basic.lua:227`; SLIME_DOOR `data/general/grids/slime.lua:91`;
 * VOID is a floor (`data/general/grids/void.lua:22-28`); the rest
 * `data/zones/infinite-dungeon/grids.lua`, at the line beside each.
 */
const DOOR_OPENED: Readonly<Record<string, string | undefined>> = {
  DOOR: 'DOOR_OPEN',
  GRASS_ROCK: 'GRASS', // :45
  UNDERGROUND_ROCK: 'UNDERGROUND_FLOOR', // :59
  CRYSTAL_ROCK: 'CRYSTAL_FLOOR', // :72
  DESERT_ROCK: 'SAND', // :85
  SAND_ROCK: 'UNDERGROUND_SAND', // :98
  CAVE_ROCK: 'CAVEFLOOR', // :111
  JUNGLE_ROCK: 'JUNGLE_GRASS', // :124
  AUTUMN_ROCK: 'AUTUMN_GRASS', // :137
  LAVA_ROCK: 'LAVA_FLOOR_FAKE', // :151
  BURNT_DOOR: 'BURNT_GROUND', // :164
  ROCKY_SNOWY_DOOR: 'ROCKY_GROUND', // :213
  SNOWY_DOOR: 'SNOWY_GRASS', // :227
  WATER_DOOR_FAKE: 'WATER_DOOR_OPEN_FAKE', // :313
  SLIME_DOOR: 'SLIME_DOOR_OPEN',
  VOID: undefined,
};

/** A grid name less its trailing variant number: CRYSTAL_WALL20 and SNOWY_GRASS_2 are variants. */
function variantless(name: string): string {
  return name.replace(/_?\d+$/, '');
}

/** The `TileCode` key a code is spelled with. */
function codeName(code: TileCode): string {
  const entry = Object.entries(TileCode).find(([, v]) => v === code);
  if (entry === undefined) throw new Error(`no TileCode ${String(code)}`);
  return entry[0];
}

function walls(set: GridSet): readonly TileCode[] {
  return typeof set.wall === 'number' ? [set.wall] : set.wall;
}

function wallNames(set: GridSet): readonly string[] {
  return typeof set.upstream.wall === 'string' ? [set.upstream.wall] : set.upstream.wall;
}

/** Every code a set can put on the map: floor, each wall, the door and what it opens into. */
function codesOf(set: GridSet): readonly TileCode[] {
  const out: TileCode[] = [set.floor, ...walls(set), set.door];
  if (isClosedDoorCode(set.door)) out.push(openedFormOf(set.door, set.floor));
  return out;
}

const REFERENCE_ID = new URL(
  '../../../reference/t-engine4/game/modules/tome/data/zones/infinite-dungeon/',
  import.meta.url,
);
const REFERENCE_GRIDS = new URL(
  '../../../reference/t-engine4/game/modules/tome/data/general/grids/',
  import.meta.url,
);
const HAVE_REFERENCE = existsSync(new URL('zone.lua', REFERENCE_ID));

describe('ID_GRID_SETS', () => {
  it('is the seventeen sets of zone.lua:185-203 in order, every name and desc verbatim', () => {
    expect(
      ID_GRID_SETS.map((s) => [
        s.id,
        s.upstream.floor,
        s.upstream.wall,
        s.upstream.door,
        s.upstream.down,
        s.desc,
      ]),
    ).toEqual(UPSTREAM_VGRIDS);
  });

  it.skipIf(!HAVE_REFERENCE)('matches `local vgrids` in reference/, where the clone has it', () => {
    const lua = readFileSync(new URL('zone.lua', REFERENCE_ID), 'utf8');
    const start = lua.indexOf('local vgrids = {');
    const block = lua.slice(start, lua.indexOf('InfiniteDungeon:getGrids', start));
    const rows = [
      ...block.matchAll(
        /\{id_grids_name="([^"]*)", floor="([^"]*)", wall=(\{[^}]*\}|"[^"]*"), door="([^"]*)", down="([^"]*)", desc="([^"]*)"\}/g,
      ),
    ].map((m) => {
      const wall = m[3] ?? '';
      const names = [...wall.matchAll(/"([^"]+)"/g)].map((w) => w[1]);
      return [m[1], m[2], wall.startsWith('{') ? names : names[0], m[4], m[5], m[6]];
    });
    expect(rows).toEqual(UPSTREAM_VGRIDS);
  });

  it('draws each set in the codes of the design table', () => {
    expect(ID_GRID_SETS.map((s) => [s.id, s.floor, walls(s)[0], s.door])).toEqual(CODES);
  });

  it('is frozen, because a set is picked by its position', () => {
    expect(Object.isFrozen(ID_GRID_SETS)).toBe(true);
    for (const set of ID_GRID_SETS) {
      expect(Object.isFrozen(set), set.id).toBe(true);
      expect(Object.isFrozen(set.upstream), `${set.id}.upstream`).toBe(true);
    }
  });

  it('walks on every floor, and no wall: each wall blocks sight and is remembered, as every upstream wall grid does', () => {
    for (const set of ID_GRID_SETS) {
      expect(isWalkable(set.floor), set.id).toBe(true);
      for (const wall of walls(set)) {
        expect(isWalkable(wall), set.id).toBe(false);
        expect(blocksSight(wall), set.id).toBe(true);
        expect(alwaysRemembered(wall), set.id).toBe(true);
      }
    }
  });

  it('shuts every room with a closed-door code that opens onto walkable ground, or leaves it the floor', () => {
    for (const set of ID_GRID_SETS) {
      if (set.door === set.floor) continue;
      expect(isClosedDoorCode(set.door), set.id).toBe(true);
      if (!isClosedDoorCode(set.door)) continue;
      expect(isWalkable(openedFormOf(set.door, set.floor)), set.id).toBe(true);
      expect(blocksSight(set.door), set.id).toBe(true);
      expect(alwaysRemembered(set.door), set.id).toBe(true);
    }
  });

  it('makes a door ROCK_DOOR exactly when its grid opens into the set`s own floor grid, and DOOR when into an open door', () => {
    for (const set of ID_GRID_SETS) {
      expect(Object.keys(DOOR_OPENED), set.id).toContain(set.upstream.door);
      const opened = DOOR_OPENED[set.upstream.door];
      if (opened === undefined) {
        expect(set.door, set.id).toBe(set.floor);
      } else if (opened.includes('_OPEN')) {
        expect(set.door, set.id).toBe(TileCode.DOOR);
      } else {
        expect(set.door, set.id).toBe(TileCode.ROCK_DOOR);
        // `rockFloor = floor` is exact: the grid it opens into IS the floor,
        // up to a variant number (SNOWY_DOOR opens into SNOWY_GRASS, the set's
        // floor is SNOWY_GRASS_2).
        expect(variantless(opened), set.id).toBe(variantless(set.upstream.floor));
      }
    }
  });

  it.skipIf(!HAVE_REFERENCE)('reads each door`s door_opened as reference/ writes it', () => {
    const files = [
      new URL('basic.lua', REFERENCE_GRIDS),
      new URL('slime.lua', REFERENCE_GRIDS),
      new URL('void.lua', REFERENCE_GRIDS),
      new URL('grids.lua', REFERENCE_ID),
    ].map((u) => readFileSync(u, 'utf8'));
    for (const name of Object.keys(DOOR_OPENED)) {
      const text = files.find((f) => f.includes(`define_as = "${name}"`));
      expect(text, name).toBeDefined();
      if (text === undefined) continue;
      const from = text.indexOf(`define_as = "${name}"`);
      const next = text.indexOf('newEntity', from);
      const entity = text.slice(from, next === -1 ? undefined : next);
      expect(/door_opened = "([^"]+)"/.exec(entity)?.[1], name).toBe(DOOR_OPENED[name]);
    }
  });

  it('holds no hazard: no air, no on_stand, and nothing that harms a body that breathes nothing', () => {
    // The water and lava sets are upstream's _FAKE grids, which carry neither
    // field (data/zones/infinite-dungeon/grids.lua:262-268, :345-353).
    for (const set of ID_GRID_SETS) {
      for (const code of codesOf(set)) {
        expect(airOf(code), `${set.id} ${codeName(code)}`).toBeUndefined();
        expect(ON_STAND[code], `${set.id} ${codeName(code)}`).toBeUndefined();
        expect(isHazardFor(code, {}), `${set.id} ${codeName(code)}`).toBe(false);
      }
    }
  });

  it('keeps the crystal wall twenty entries long, so each wall cell spends one range(1, 20) draw', () => {
    // A table key draws rng.range(1, #t) on every resolve (engine/Generator.lua:63-64).
    const crystals = ID_GRID_SETS.find((s) => s.id === 'crystals');
    expect(crystals).toBeDefined();
    if (crystals === undefined) return;
    expect(walls(crystals)).toEqual(CRYSTAL_WALLS.map(() => TileCode.CRYSTAL_WALL));
    const rng = createRng('crystal walls');
    const twin = createRng('crystal walls');
    const map = createGenMap(1, 1, { wall: crystals.wall }, rng);
    for (let i = 0; i < 40; i += 1) {
      expect(map.resolve('wall')).toBe(TileCode.CRYSTAL_WALL);
      range(twin, 'twin', 1, 20);
    }
    expect(rng.getState().count).toBeGreaterThanOrEqual(40);
    expect(rng.getState().state).toBe(twin.getState().state);
    expect(rng.getState().count).toBe(twin.getState().count);
  });

  it('gives every other set one wall code, which spends no draw', () => {
    for (const set of ID_GRID_SETS) {
      if (set.id === 'crystals') continue;
      expect(typeof set.wall, set.id).toBe('number');
      const rng = createRng(set.id);
      const map = createGenMap(1, 1, { wall: set.wall }, rng);
      map.resolve('wall');
      expect(rng.getState().count, set.id).toBe(0);
    }
  });

  it('writes `substitutes` exactly when a grid is drawn by a code of another name, naming both', () => {
    for (const set of ID_GRID_SETS) {
      expect(wallNames(set).length, set.id).toBe(walls(set).length);
      const pairs: [string, TileCode][] = [
        [set.upstream.floor, set.floor],
        [set.upstream.door, set.door],
      ];
      wallNames(set).forEach((name, i) => {
        const code = walls(set)[i];
        if (code !== undefined) pairs.push([name, code]);
      });
      const differ = pairs.filter(([name, code]) => variantless(name) !== codeName(code));
      if (differ.length === 0) {
        expect(set.substitutes, set.id).toBeUndefined();
        continue;
      }
      expect(set.substitutes, set.id).toBeDefined();
      for (const [name, code] of differ) {
        expect(set.substitutes, `${set.id}: ${name}`).toContain(name);
        expect(set.substitutes, `${set.id}: ${codeName(code)}`).toContain(codeName(code));
      }
    }
  });
});
