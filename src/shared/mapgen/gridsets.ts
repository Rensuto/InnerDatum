// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/modules/tome/data/zones/infinite-dungeon/zone.lua:185-203 (the grid sets)
//   and game/modules/tome/data/zones/infinite-dungeon/grids.lua:36-229 (what each rock door opens into)
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE INFINITE DUNGEON'S SEVENTEEN GRID SETS, AS TILE CODES
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Every level of upstream's Infinite Dungeon is one layout drawn in one of
 * these sets (`data/zones/infinite-dungeon/zone.lua:185-203`): a floor, a wall,
 * a door and a down stair. `alter_level_data` picks one by index
 * (`zone.vgridN`, `:208`) and writes it into the generator table — `floor` and
 * `'.'`, `external_floor` and `outside_floor` unless the set or layout names
 * its own, `wall` and `'#'`, the up stair as the floor, `door` and `"'"`
 * (`:237-248`). This file is the table. Picking and writing are the Tower's.
 *
 * ORDER IS THE DATA. The set is chosen by position, and the two exits roll the
 * next position with `rng.normal(vgridN + 1, 2)` (`:222`), so two entries
 * swapped is a different dungeon per seed.
 *
 * ═══ A ROCK DOOR OPENS INTO THE SET'S FLOOR ═══
 * Twelve sets shut their rooms with a "huge loose rock" or a passage whose
 * `door_opened` is a floor grid, not an open door
 * (`data/zones/infinite-dungeon/grids.lua:45` GRASS_ROCK into GRASS, and kin).
 * They are ROCK_DOOR, and a map drawn in any set sets
 * `AuthoredMap.rockFloor` to that set's `floor`. That is exact for all twelve,
 * including SNOWY_DOOR, which opens into SNOWY_GRASS rather than the set's
 * SNOWY_GRASS_2 (`data/zones/infinite-dungeon/grids.lua:227`): both are
 * SNOWFIELD here.
 *
 * Four sets shut theirs with a door that opens into an open door, and it is
 * DOOR: DOOR itself in two (`data/general/grids/basic.lua:227`), SLIME_DOOR
 * (`data/general/grids/slime.lua:91`) and WATER_DOOR_FAKE
 * (`data/zones/infinite-dungeon/grids.lua:313`). The void has no door at all:
 * its `door` is VOID, the floor.
 *
 * ═══ THE CRYSTAL WALL IS TWENTY ENTRIES OF ONE CODE ═══
 * Upstream's crystal wall is a table of twenty grids (`:189`), and a table key
 * draws `rng.range(1, #t)` on every resolve (`engine/Generator.lua:63-64`).
 * One code serves all twenty, and the array keeps its length so every wall
 * cell still spends the draw it spends upstream.
 *
 * ═══ NOTHING HERE IS A HAZARD ═══
 * The water and lava sets are upstream's `_FAKE` grids, which carry no
 * `air_level` and no `on_stand` (`data/zones/infinite-dungeon/grids.lua:262-268`,
 * `:345-353`). Their walls are the same codes as the real walls, because a
 * wall's air is not ported (`shared/terrain.ts`).
 *
 * ═══ `down` IS A NAME ONLY ═══
 * A stair here is a marker on the floor, so a set has no down code. Upstream
 * draws the down stair from the DESTINATION's set, not the level's own
 * (`:246`); the name is kept for whoever ports that.
 *
 * ═══ `substitutes`: EVERY GRID THE CODES DO NOT SPELL ═══
 * Present exactly when one of the set's floor, wall or door grids is drawn by
 * a code with another name, a trailing variant number aside (CRYSTAL_WALL20 is
 * CRYSTAL_WALL, SPACETIME_RIFT2 is SPACETIME_RIFT). It names each such grid and
 * the code that draws it, so the words and the codes cannot drift apart
 * unnoticed (`test/shared/mapgen/gridsets.test.ts`).
 */

import { TileCode } from '../protocol.ts';

/** The grid names a set gives upstream, verbatim, typos included. */
export type GridSetNames = {
  readonly floor: string;
  /** A table of grids where upstream's is one: the crystal wall. */
  readonly wall: string | readonly string[];
  readonly door: string;
  readonly down: string;
};

/** One entry of `vgrids`. */
export type GridSet = {
  /** `id_grids_name`, verbatim. */
  readonly id: string;
  /** `desc`, verbatim: "arrid" and "slimey" are upstream's spelling. */
  readonly desc: string;
  readonly floor: TileCode;
  /** One code, or a table drawn on every resolve. */
  readonly wall: TileCode | readonly TileCode[];
  /** DOOR, ROCK_DOOR (opening into `floor`), or the floor itself. */
  readonly door: TileCode;
  readonly upstream: GridSetNames;
  /** What the codes do not spell, in words. */
  readonly substitutes?: string;
};

/** Upstream's twenty crystal walls, `CRYSTAL_WALL` then `CRYSTAL_WALL2` .. `CRYSTAL_WALL20`. */
const CRYSTAL_WALL_NAMES: readonly string[] = Object.freeze(
  Array.from({ length: 20 }, (_, i) => (i === 0 ? 'CRYSTAL_WALL' : `CRYSTAL_WALL${String(i + 1)}`)),
);

/** `local vgrids`, `data/zones/infinite-dungeon/zone.lua:185-203`, in its order. */
const SETS: readonly GridSet[] = [
  // data/zones/infinite-dungeon/zone.lua:186
  {
    id: 'default',
    desc: 'hewn',
    floor: TileCode.FLOOR,
    wall: TileCode.WALL,
    door: TileCode.DOOR,
    upstream: { floor: 'FLOOR', wall: 'WALL', door: 'DOOR', down: 'DOWN' },
  },
  // data/zones/infinite-dungeon/zone.lua:187
  {
    id: 'tree',
    desc: 'sylvan',
    floor: TileCode.GREEN,
    wall: TileCode.TREES,
    door: TileCode.ROCK_DOOR,
    upstream: { floor: 'GRASS', wall: 'TREE', door: 'GRASS_ROCK', down: 'GRASS_DOWN2' },
    substitutes: 'GRASS draws as GREEN, TREE as TREES, and GRASS_ROCK as ROCK_DOOR.',
  },
  // data/zones/infinite-dungeon/zone.lua:188
  {
    id: 'underground',
    desc: 'subterranean',
    floor: TileCode.UNDERGROUND_FLOOR,
    wall: TileCode.UNDERGROUND_TREE,
    door: TileCode.ROCK_DOOR,
    upstream: {
      floor: 'UNDERGROUND_FLOOR',
      wall: 'UNDERGROUND_TREE',
      door: 'UNDERGROUND_ROCK',
      down: 'UNDERGROUND_LADDER_DOWN',
    },
    substitutes: 'UNDERGROUND_ROCK draws as ROCK_DOOR.',
  },
  // data/zones/infinite-dungeon/zone.lua:189
  {
    id: 'crystals',
    desc: 'crystalline',
    floor: TileCode.CRYSTAL_FLOOR,
    wall: Object.freeze(CRYSTAL_WALL_NAMES.map(() => TileCode.CRYSTAL_WALL)),
    door: TileCode.ROCK_DOOR,
    upstream: {
      floor: 'CRYSTAL_FLOOR',
      wall: CRYSTAL_WALL_NAMES,
      door: 'CRYSTAL_ROCK',
      down: 'CRYSTAL_LADDER_DOWN',
    },
    substitutes:
      'CRYSTAL_ROCK draws as ROCK_DOOR. CRYSTAL_WALL through CRYSTAL_WALL20 are one code, CRYSTAL_WALL, twenty entries long.',
  },
  // data/zones/infinite-dungeon/zone.lua:190
  {
    id: 'sand',
    desc: 'sandy',
    floor: TileCode.SHORE,
    wall: TileCode.SANDWALL,
    door: TileCode.ROCK_DOOR,
    upstream: {
      floor: 'UNDERGROUND_SAND',
      wall: 'SANDWALL',
      door: 'SAND_ROCK',
      down: 'SAND_LADDER_DOWN',
    },
    substitutes: 'UNDERGROUND_SAND draws as SHORE, as SAND does, and SAND_ROCK as ROCK_DOOR.',
  },
  // data/zones/infinite-dungeon/zone.lua:191
  {
    id: 'desert',
    desc: 'arrid',
    floor: TileCode.SHORE,
    wall: TileCode.TREES,
    door: TileCode.ROCK_DOOR,
    upstream: { floor: 'SAND', wall: 'PALMTREE', door: 'DESERT_ROCK', down: 'SAND_DOWN2' },
    substitutes: 'SAND draws as SHORE, PALMTREE as TREES, and DESERT_ROCK as ROCK_DOOR.',
  },
  // data/zones/infinite-dungeon/zone.lua:192
  {
    id: 'slime',
    desc: 'slimey',
    floor: TileCode.SLIME_FLOOR,
    wall: TileCode.SLIME_WALL,
    door: TileCode.DOOR,
    upstream: { floor: 'SLIME_FLOOR', wall: 'SLIME_WALL', door: 'SLIME_DOOR', down: 'SLIME_DOWN' },
    substitutes:
      'SLIME_DOOR draws as DOOR, which opens into DOOR_OPEN as SLIME_DOOR opens into SLIME_DOOR_OPEN.',
  },
  // data/zones/infinite-dungeon/zone.lua:193
  {
    id: 'jungle',
    desc: 'humid, tropical',
    floor: TileCode.MIRE,
    wall: TileCode.TREES,
    door: TileCode.ROCK_DOOR,
    upstream: {
      floor: 'JUNGLE_GRASS',
      wall: 'JUNGLE_TREE',
      door: 'JUNGLE_ROCK',
      down: 'JUNGLE_GRASS_DOWN2',
    },
    substitutes: 'JUNGLE_GRASS draws as MIRE, JUNGLE_TREE as TREES, and JUNGLE_ROCK as ROCK_DOOR.',
  },
  // data/zones/infinite-dungeon/zone.lua:194
  {
    id: 'cave',
    desc: 'unhewn',
    floor: TileCode.SOOT,
    wall: TileCode.CRAG,
    door: TileCode.ROCK_DOOR,
    upstream: {
      floor: 'CAVEFLOOR',
      wall: 'CAVEWALL',
      door: 'CAVE_ROCK',
      down: 'CAVE_LADDER_DOWN',
    },
    substitutes: 'CAVEFLOOR draws as SOOT, CAVEWALL as CRAG, and CAVE_ROCK as ROCK_DOOR.',
  },
  // data/zones/infinite-dungeon/zone.lua:195
  {
    id: 'burntland',
    desc: 'burned',
    floor: TileCode.CHARRED,
    wall: TileCode.BURNT_TREE,
    door: TileCode.ROCK_DOOR,
    upstream: {
      floor: 'BURNT_GROUND',
      wall: 'BURNT_TREE',
      door: 'BURNT_DOOR',
      down: 'BURNT_DOWN6',
    },
    substitutes:
      'BURNT_GROUND draws as CHARRED, and BURNT_DOOR as ROCK_DOOR: it opens into the burnt ground, not into an open door.',
  },
  // data/zones/infinite-dungeon/zone.lua:196
  {
    id: 'mountain',
    desc: 'mountainous',
    floor: TileCode.HILLS,
    wall: TileCode.MOUNTAIN,
    door: TileCode.DOOR,
    upstream: { floor: 'ROCKY_GROUND', wall: 'MOUNTAIN_WALL', door: 'DOOR', down: 'ROCKY_DOWN2' },
    substitutes: 'ROCKY_GROUND draws as HILLS and MOUNTAIN_WALL as MOUNTAIN.',
  },
  // data/zones/infinite-dungeon/zone.lua:197
  {
    id: 'mountain_forest',
    desc: 'alpine',
    floor: TileCode.HILLS,
    wall: TileCode.COLD_FOREST,
    door: TileCode.ROCK_DOOR,
    upstream: {
      floor: 'ROCKY_GROUND',
      wall: 'ROCKY_SNOWY_TREE',
      door: 'ROCKY_SNOWY_DOOR',
      down: 'ROCKY_DOWN2',
    },
    substitutes:
      'ROCKY_GROUND draws as HILLS, ROCKY_SNOWY_TREE as COLD_FOREST, and ROCKY_SNOWY_DOOR as ROCK_DOOR.',
  },
  // data/zones/infinite-dungeon/zone.lua:198
  {
    id: 'snowy_forest',
    desc: 'cold, wooded',
    floor: TileCode.SNOWFIELD,
    wall: TileCode.COLD_FOREST,
    door: TileCode.ROCK_DOOR,
    upstream: {
      floor: 'SNOWY_GRASS_2',
      wall: 'SNOWY_TREE_2',
      door: 'SNOWY_DOOR',
      down: 'snowy_DOWN2',
    },
    substitutes:
      'SNOWY_GRASS_2 draws as SNOWFIELD, SNOWY_TREE_2 as COLD_FOREST, and SNOWY_DOOR as ROCK_DOOR. SNOWY_DOOR opens into SNOWY_GRASS, not SNOWY_GRASS_2; both are SNOWFIELD.',
  },
  // data/zones/infinite-dungeon/zone.lua:199. SPACETIME_RIFT is this set's
  // SPACETIME_RIFT2, which blocks sight (data/zones/infinite-dungeon/grids.lua:254);
  // the void grids' own rift does not (data/general/grids/void.lua:44-53).
  {
    id: 'temporal_void',
    desc: 'empty',
    floor: TileCode.VOID,
    wall: TileCode.SPACETIME_RIFT,
    door: TileCode.VOID,
    upstream: { floor: 'VOID', wall: 'SPACETIME_RIFT2', door: 'VOID', down: 'RIFT2' },
  },
  // data/zones/infinite-dungeon/zone.lua:200
  {
    id: 'water',
    desc: 'flooded',
    floor: TileCode.WATER_FLOOR_FAKE,
    wall: TileCode.WATER_WALL,
    door: TileCode.DOOR,
    upstream: {
      floor: 'WATER_FLOOR_FAKE',
      wall: 'WATER_WALL_FAKE',
      door: 'WATER_DOOR_FAKE',
      down: 'WATER_DOWN_FAKE',
    },
    substitutes:
      'WATER_WALL_FAKE draws as WATER_WALL, one code for the real wall and the fake, and WATER_DOOR_FAKE as DOOR.',
  },
  // data/zones/infinite-dungeon/zone.lua:201
  {
    id: 'lava',
    desc: 'molten',
    floor: TileCode.LAVA_FLOOR_FAKE,
    wall: TileCode.LAVA_WALL,
    door: TileCode.ROCK_DOOR,
    upstream: {
      floor: 'LAVA_FLOOR_FAKE',
      wall: 'LAVA_WALL_FAKE',
      door: 'LAVA_ROCK',
      down: 'LAVA_DOWN_FAKE',
    },
    substitutes:
      'LAVA_WALL_FAKE draws as LAVA_WALL, one code for the real wall and the fake, and LAVA_ROCK as ROCK_DOOR.',
  },
  // data/zones/infinite-dungeon/zone.lua:202
  {
    id: 'autumn_forest',
    desc: 'temperate',
    floor: TileCode.PLAINS,
    wall: TileCode.TREES,
    door: TileCode.ROCK_DOOR,
    upstream: {
      floor: 'AUTUMN_GRASS',
      wall: 'AUTUMN_TREE',
      door: 'AUTUMN_ROCK',
      down: 'AUTUMN_GRASS_DOWN2',
    },
    substitutes:
      'AUTUMN_GRASS draws as PLAINS, AUTUMN_TREE as TREES, and AUTUMN_ROCK as ROCK_DOOR.',
  },
];

/** The seventeen sets, in upstream's order. Frozen: the order is the data. */
export const ID_GRID_SETS: readonly GridSet[] = Object.freeze(
  SETS.map((set) => Object.freeze({ ...set, upstream: Object.freeze({ ...set.upstream }) })),
);
