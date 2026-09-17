// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/modules/tome/data/zones/infinite-dungeon/zone.lua:100-259 (alter_level_data)
//   and game/engines/default/engine/utils.lua:33-38 (math.round, through mapgen/lua.ts)
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE INFINITY TOWER'S FLOOR TABLE: UPSTREAM'S `alter_level_data`, DRAW FOR DRAW
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Every level of ToME's Infinite Dungeon is rolled afresh before it is built
 * (`data/zones/infinite-dungeon/zone.lua:100-259`): a size, one of eight
 * layouts drawn in one of seventeen grid sets, and two ways on, each naming the
 * layout and set of the level it leads to. `alterLevelData` is that function,
 * and what it returns is the table `newLevel` builds (`mapgen/level.ts`) plus
 * the facts a realm needs about it.
 *
 * ═══ THE DRAWS, IN ORDER — ALL OF THEM, ON EVERY LEVEL ═══
 * The eight layout tables are one Lua table constructor (`:109-180`), and a
 * constructor evaluates its fields in source order. So every level rolls EVERY
 * layout's parameters, whichever layout it then uses:
 *
 *   :104  vx                     rng.float(0.6, 1.4)           one draw
 *   :121  forest edge_entrances  rng.table of 4                rng.range(1, 4)
 *   :122  forest zoom            rng.range(2, 6)
 *   :123  forest sqrt_percent    rng.range(30, 50)             drawn, then overwritten
 *   :124  forest sqrt_percent    rng.range(5, 10)              the duplicate key wins
 *   :126  forest nb_rooms        math.random(1, ceil(vx*vy/2000))
 *   :134  cavern zoom            math.random(12, 20)
 *   :135  cavern min_floor       floor(rng.range(vx*vy*0.2, vx*vy*0.4))
 *   :140  maze widen_w           bound(rng.normal(2, 2), 1, 7)  two draws
 *   :141  maze widen_h           bound(rng.normal(2, 2), 1, 7)  two draws
 *   :146  town building_chance   math.random(50, 90)
 *   :147  town max_building_w/h  math.random(6, 11) each
 *   :149  town nb_rooms          math.random(1, 2)
 *   :156  building nb_rooms      math.random(0, ceil(vx*vy/2000))
 *   :158  building lite chance   rng.range(0, 100)
 *   :159  building max_block_w/h rng.range(7, 20) each
 *   :160  building max_building  rng.range(4, size/6) each    (`infiniteDungeonBuilding`)
 *   :221  exit 1 layout          rng.normal(layoutN + 1, 2)   two draws
 *   :222  exit 1 grids           rng.normal(vgridN + 1, 2)    two draws
 *   :221  exit 2 layout          the same, from EXIT 1's result
 *   :222  exit 2 grids           the same, from exit 1's result
 *
 * Octopus and Hexa draw nothing, and neither does picking the layout. None of
 * those calls can skip its draw at any level: every `rng.range` above has two
 * different truncated bounds, a four-entry `rng.table` always rolls, and
 * `rng.normal` at a spread of 2 always rolls twice (`mapgen/lua.ts`). The test
 * pins the labelled sequence for floors 1, 3 and 30.
 *
 * ═══ `math.random` IS NOT `rng` ═══
 * Upstream's `math.random` is LuaJIT's own generator, seeded from the clock
 * (`mathRandom`, `mapgen/lua.ts`). Here it is one draw from the same labelled
 * stream, in its place in the order, with LuaJIT's formula: the distribution
 * is upstream's and the numbers are this seed's.
 *
 * ═══ EXITS CHAIN, AND `%` IS FLOORED ═══
 * `layoutN = rng.normal(layoutN + 1, 2) % #layouts + 1` (`:221`) — Lua's `%`
 * takes the divisor's sign, so a normal of -3 is layout 6, not -2 (`mod`). The
 * second exit starts from the FIRST exit's numbers, not the level's: the loop
 * reassigns the same locals (`:220-225`).
 *
 * ═══ AFTER THE PICK ═══
 * - A MAZE rounds both sides to its corridor width, `math.round`, halves away
 *   from zero (`:228-231`), so the maze fills its map.
 * - HEXA squares the map to its larger side (`:232-235`).
 * - Enemies: the layout's own `enemy_count`, rolled from the size BEFORE either
 *   change (forest `:129`, building `:161`, and neither changes it), else
 *   `ceil(vx*vy*34/4900)` on the size after (`:255`). Upstream's `nb_npc` is
 *   that count plus or minus 5 (`:256`); the populator reads `enemyCount`.
 *
 * ═══ THE GRIDS ARE THE LEVEL'S SET, AND THE WAY DOWN LOOKS LIKE WHERE IT GOES ═══
 * `:237-249` writes one set into the layout's table: `floor` and `'.'`,
 * `external_floor` and `outside_floor` (no set or layout names its own, so
 * both are the floor), `wall` and `'#'`, `door` and `"'"`, and `up` as the
 * floor itself — no stair is drawn where a party arrives. `down` is the FIRST
 * EXIT'S set's down grid (`:246`). A stair here is a marker standing on a floor
 * code, and a set has no stair code (`mapgen/gridsets.ts`), so `down` is the
 * destination set's FLOOR: the exit is a patch of the ground it leads to. `+`
 * is never written, upstream or here, so a pit's door resolves to nothing and
 * the pit stays sealed, as upstream's does (`pit`, `mapgen/rooms-loader.ts`).
 *
 * ═══ WHAT IS NOT UPSTREAM'S, EACH NOTED WHERE IT HAPPENS ═══
 * - `greater_vault` is played by `lesser_vault`: the Static vault loader is not
 *   ported, and `rooms/greater_vault.lua` is `rooms/lesser_vault.lua` but for
 *   its list (see `infiniteDungeonBuilding`, `mapgen/building.ts`). Upstream
 *   names no vault list, so it draws every auto vault; the pool here is the
 *   works rooms, as the Gearford building floors use (`TOWER_VAULTS`).
 * - `pit` and a clearing's pit are geometry, with no monsters in them.
 * - The `items-vault` addon is not in the reference tree: no `I` key and no
 *   `!items-vault` room (`:214`, `:249`).
 * - `InfiniteDungeon:getLayouts` and `:getGrids` (`:182`, `:204`) are hooks
 *   nothing in the tome tree binds, so there is nothing to call.
 * - `infiniteDungeonChallenge` (`:258`) is not ported. It is the last thing
 *   upstream rolls, `rng.percent` from level 3 (`tome/class/GameState.lua:2561-2589`),
 *   so leaving it out moves no draw above it.
 * - `forceLastStair` on every table. Upstream's `max_level` is a billion
 *   (`:27`), so every level has a way down anyway; this keeps it so whatever
 *   `maxLevel` a caller passes.
 */

import type { SiteLighting } from '../light.ts';
import type { Rng } from '../rng.ts';
import { VAULTS_BY_SHAPE } from '../vaults.ts';
import { infiniteDungeonBuilding, infiniteDungeonSize } from './building.ts';
import type { GridKeys } from './genmap.ts';
import { ID_GRID_SETS } from './gridsets.ts';
import type { GridSet } from './gridsets.ts';
import { HEXACLE_INFINITE_DUNGEON } from './hexacle.ts';
import type { LevelSpec, MapGeneratorSpec } from './level.ts';
import { bound, float, mathRandom, mathRound, mod, normal, range, table } from './lua.ts';
import type { EdgeSide, RoomsConfig } from './rooms-loader.ts';

/** `id_layout_name`, verbatim (`data/zones/infinite-dungeon/zone.lua:110-171`). */
export type TowerLayoutId =
  'default' | 'forest' | 'cavern' | 'maze' | 'town' | 'building' | 'octopus' | 'hexa';

/** One entry of `local layouts` (`data/zones/infinite-dungeon/zone.lua:109-180`), without its rolls. */
export type TowerLayout = {
  /** `id_layout_name`, verbatim. */
  readonly id: TowerLayoutId;
  /** `desc`, verbatim, its leading space or comma included: it follows a set's desc. */
  readonly desc: string;
  /** The generator the layout's `class` names. */
  readonly generator: MapGeneratorSpec['class'];
};

/** The eight layouts, in upstream's order. Frozen: an exit names one by position. */
export const TOWER_LAYOUTS: readonly TowerLayout[] = Object.freeze([
  // data/zones/infinite-dungeon/zone.lua:110-112
  { id: 'default', desc: ', carefully excavated area', generator: 'Roomer' },
  // data/zones/infinite-dungeon/zone.lua:118-120
  { id: 'forest', desc: ' wilderness', generator: 'Forest' },
  // data/zones/infinite-dungeon/zone.lua:131-133
  { id: 'cavern', desc: ' cavern', generator: 'Cavern' },
  // data/zones/infinite-dungeon/zone.lua:137-139
  { id: 'maze', desc: ' network of corridors', generator: 'Maze' },
  // data/zones/infinite-dungeon/zone.lua:143-145
  { id: 'town', desc: ', settled area', generator: 'Town' },
  // data/zones/infinite-dungeon/zone.lua:153-155
  { id: 'building', desc: ', constructed area', generator: 'Building' },
  // data/zones/infinite-dungeon/zone.lua:163-165
  { id: 'octopus', desc: ', subsided area', generator: 'Octopus' },
  // data/zones/infinite-dungeon/zone.lua:171-173
  { id: 'hexa', desc: ', geometrically ordered area', generator: 'Hexacle' },
] as const);

/**
 * Which layout and grid set a floor is built in, 1-based as upstream's
 * `zone.layoutN` and `zone.vgridN` are. Any integer: it is wrapped (`:207-208`).
 */
export type TowerEntry = { readonly layoutN: number; readonly vgridN: number };

/** A way on: where it leads, and the words upstream shows for it — "sylvan wilderness". */
export type TowerExit = TowerEntry & {
  /** `grids.desc .. layout.desc` (`:312`), verbatim. */
  readonly desc: string;
};

/** One floor's rolled table. */
export type TowerFloor = {
  /** `data.width`, after a maze's rounding or hexa's squaring (`:251`). */
  readonly width: number;
  /** `data.height`. */
  readonly height: number;
  /** What `newLevel` builds: the chosen layout's table in the floor's grid set. */
  readonly spec: LevelSpec;
  /** `data.alternate_exit`: exit 1 is the down stair, exit 2 a second way on (`:219-225`). */
  readonly exits: readonly [TowerExit, TowerExit];
  /** `enemy_count` (`:255`): upstream places `enemyCount - 5` to `enemyCount + 5`. */
  readonly enemyCount: number;
  /** How the floor is lit before anybody brings a light: see `TowerRoll.lighting`. */
  readonly lighting: SiteLighting;
  /** The layout's `id_layout_name`. */
  readonly layoutName: TowerLayoutId;
  /** The grid set's `id_grids_name`. */
  readonly gridsName: string;
};

/**
 * The lesser vault pool every Tower layout draws from, `greater_vault` included:
 * the works rooms, as `BUILDING_INFINITE_DUNGEON` and the Gearford floors have
 * it (`mapgen/building.ts`, `mapgen/zones.ts`).
 */
export const TOWER_VAULTS: readonly string[] = Object.freeze(
  (VAULTS_BY_SHAPE['works'] ?? []).map((v) => v.id),
);

/** `rng.table{{2,8}, {4,6}, {6,4}, {8,2}}` (`:121`): up side, down side. */
const FOREST_EDGES: readonly (readonly [EdgeSide, EdgeSide])[] = [
  [2, 8],
  [4, 6],
  [6, 4],
  [8, 2],
];

/**
 * `rooms_config = {forest_clearing = {pit_chance = util.bound(lev, 10, 50),
 * filters = {{special = function(e) return e.rank <= 3 end}}}}` (`:128`, `:151`).
 * One filter, so a clearing's filter pick draws nothing. The predicate is kept
 * for whoever ports pit population; nothing calls it here.
 */
function clearingConfig(lev: number): RoomsConfig {
  return {
    forestClearing: {
      pitChance: bound(lev, 10, 50),
      filters: [
        {
          special: (entity: unknown): boolean =>
            typeof entity === 'object' &&
            entity !== null &&
            'rank' in entity &&
            typeof entity.rank === 'number' &&
            entity.rank <= 3,
        },
      ],
    },
  };
}

/** One layout's table as its constructor rolled it, waiting for the grid set. */
type TowerRoll = {
  /** The generator table, once the set's keys are known. */
  readonly map: (grid: GridKeys) => MapGeneratorSpec;
  /** The layout's own `enemy_count`, where it has one. */
  readonly enemyCount?: number;
  /** A maze's `widen_w` and `widen_h`, which the map size is rounded to. */
  readonly widen?: { readonly w: number; readonly h: number };
  /** `force_square_size`. */
  readonly forceSquareSize?: boolean;
  /**
   * How a room is lit: the chance each room the generator places rolls, as that
   * generator reads it. The Tower is not `all_lited` (`:31`), so nothing else is.
   *
   * - Roomer: the layout's `lite_room_chance = 50` (`:116`).
   * - Forest, Town, Cavern: `RoomsLoader`'s `lite_room_chance or 100`
   *   (`engine/generator/map/RoomsLoader.lua:625`), as no table sets one. A
   *   clearing lights itself on a hit (`rooms/forest_clearing.lua:119`); a vault
   *   never does (`toAuthoredMap`, `mapgen/level.ts`). Cavern places no room.
   * - Building: the roll, for its buildings and its rooms alike (`:158`).
   * - Maze, Octopus and Hexacle roll no light for anything, so they carry none:
   *   an Octopus pod is a room that never rolls one (`makePod`).
   */
  readonly lighting: SiteLighting;
};

/**
 * `alter_level_data(zone, lev, data)` (`data/zones/infinite-dungeon/zone.lua:100-259`):
 * floor `lev`'s table, entered through `entry` — the exit taken to get there,
 * or nothing, which is layout 1 in set 1 (`zone.layoutN or 1`, `:207`): hewn
 * Roomer.
 *
 * Every draw is on `rng`, in upstream's order (see the file note). Call it once
 * per level change and let every attempt at that level share the result, as
 * upstream does (`engine/Zone.lua:1060`, `:1138`): `keepTrying` takes it as a
 * function of the round's seed.
 *
 * THROWS for a level that is not a whole number of at least 1, before any draw:
 * `floor(40/lev)` has no meaning below it.
 */
export function alterLevelData(lev: number, entry: TowerEntry | undefined, rng: Rng): TowerFloor {
  if (!Number.isInteger(lev) || lev < 1) {
    throw new RangeError(`alterLevelData: level ${String(lev)} is not a level`);
  }

  // :103-105. `rng.float` narrows 0.6 and 1.4 to C floats, so the widest
  // extremes are 37 and 125, inside the 36 and 126 the comment at :104 gives.
  const size = infiniteDungeonSize(lev);
  let vx = Math.ceil(float(rng, 'tower.alter.vx', 0.6, 1.4) * size);
  let vy = Math.ceil((size * size) / vx);

  // :109-180, in source order: the draws happen HERE, for all eight.
  const rolls: readonly TowerRoll[] = [
    rollDefault(vx, vy),
    rollForest(rng, lev, vx, vy),
    rollCavern(rng, vx, vy),
    rollMaze(rng),
    rollTown(rng, lev),
    rollBuilding(rng, lev, size, vx, vy),
    rollOctopus(),
    rollHexa(),
  ];

  // :207-210, with Lua's floored `%`.
  const layoutN = mod((entry?.layoutN ?? 1) - 1, TOWER_LAYOUTS.length) + 1;
  const vgridN = mod((entry?.vgridN ?? 1) - 1, ID_GRID_SETS.length) + 1;

  // :219-225: the second exit's rolls start from the first exit's numbers.
  const exit1 = rollExit(rng, 'tower.alter.exit1', { layoutN, vgridN });
  const exit2 = rollExit(rng, 'tower.alter.exit2', exit1);

  const roll = at(rolls, layoutN);
  const layout = at(TOWER_LAYOUTS, layoutN);
  const set = at(ID_GRID_SETS, vgridN);

  // :228-235.
  if (roll.widen !== undefined) {
    vx = mathRound(vx, roll.widen.w);
    vy = mathRound(vy, roll.widen.h);
  }
  if (roll.forceSquareSize === true) {
    vx = Math.max(vx, vy);
    vy = vx;
  }

  // :237-249.
  const grid: GridKeys = {
    floor: set.floor,
    '.': set.floor,
    external_floor: set.floor,
    outside_floor: set.floor,
    wall: set.wall,
    '#': set.wall,
    up: set.floor,
    down: at(ID_GRID_SETS, exit1.vgridN).floor,
    door: set.door,
    "'": set.door,
  };

  return {
    width: vx,
    height: vy,
    spec: { width: vx, height: vy, map: roll.map(grid) },
    exits: [exit1, exit2],
    // :255.
    enemyCount: roll.enemyCount ?? Math.ceil((vx * vy * 34) / 4900),
    lighting: roll.lighting,
    layoutName: layout.id,
    gridsName: set.id,
  };
}

/** `list[n]`, 1-based, for an `n` already wrapped into range. */
function at<T>(list: readonly T[], n: number): T {
  const value = list[n - 1];
  if (value === undefined) throw new RangeError(`no entry ${String(n)} of ${String(list.length)}`);
  return value;
}

/**
 * One pass of `for i = 1, 2` (`:221-223`): the layout, THEN the grid set, each
 * `rng.normal(n + 1, 2) % count + 1` with the floored `%`.
 */
function rollExit(rng: Rng, label: string, from: TowerEntry): TowerExit {
  const layoutN =
    mod(normal(rng, `${label}.layout`, from.layoutN + 1, 2), TOWER_LAYOUTS.length) + 1;
  const vgridN = mod(normal(rng, `${label}.grids`, from.vgridN + 1, 2), ID_GRID_SETS.length) + 1;
  const layout = at(TOWER_LAYOUTS, layoutN);
  const set: GridSet = at(ID_GRID_SETS, vgridN);
  return { layoutN, vgridN, desc: `${set.desc}${layout.desc}` };
}

/**
 * `id_layout_name = "default"` (`:110-117`): Roomer, `4 + ceil(vx*vy*10/4900)`
 * rooms of `random_room`, a 3-weighted `pit` and a 7-weighted `greater_vault`
 * (played by `lesser_vault`), half of them lit. No draws. `rooms_config.pit`'s
 * empty filter list is not carried: `pit` draws no filter here.
 */
function rollDefault(vx: number, vy: number): TowerRoll {
  const nbRooms = 4 + Math.ceil((vx * vy * 10) / 4900);
  return {
    map: (grid) => ({
      class: 'Roomer',
      nbRooms,
      rooms: ['random_room', ['pit', 3], ['lesser_vault', 7]],
      lesserVaultsList: TOWER_VAULTS,
      liteRoomChance: 50,
      forceLastStair: true,
      grid,
    }),
    lighting: { litRoomChance: 50 },
  };
}

/**
 * `id_layout_name = "forest"` (`:118-130`): Forest on 4-octave Perlin, stairs on
 * a random pair of opposite edges, no road and no ponds, and `forest_clearing`,
 * a lesser vault weighted `floor(40/lev)` and a `greater_vault`.
 *
 * `sqrt_percent` IS WRITTEN TWICE (`:123-124`). Both calls draw, and the second
 * value is the table's. So a tree roll takes the square-root branch only below
 * 5 to 10, and a forest level is dense.
 *
 * A WEIGHT OF 0 IS A ROOM NEVER CHOSEN. Past level 40 `floor(40/lev)` is 0: the
 * pick rolls `rng.percent(0)`, which misses, and picks again
 * (`engine/generator/map/Forest.lua:254-261`). Every list here also has an
 * entry with no weight, so the pick always ends — `roomsLoaderInit` refuses
 * only a list with nothing else (`mapgen/rooms-loader.ts`).
 */
function rollForest(rng: Rng, lev: number, vx: number, vy: number): TowerRoll {
  const edges = table(rng, 'tower.alter.forest.edge', FOREST_EDGES);
  if (edges === null) throw new Error('rng.table of four entries picked nothing');
  const zoom = range(rng, 'tower.alter.forest.zoom', 2, 6);
  range(rng, 'tower.alter.forest.sqrt_percent', 30, 50);
  const sqrtPercent = range(rng, 'tower.alter.forest.sqrt_percent', 5, 10);
  const nbRooms = mathRandom(rng, 'tower.alter.forest.nb_rooms', 1, Math.ceil((vx * vy) / 2000));
  const enemyCount = Math.ceil((vx * vy * 40) / 4900);
  const edgeEntrances = edges.value;
  return {
    map: (grid) => ({
      class: 'Forest',
      edgeEntrances,
      zoom,
      sqrtPercent,
      noise: 'fbm_perlin',
      nbRooms,
      rooms: ['forest_clearing', ['lesser_vault', Math.floor(40 / lev)], 'lesser_vault'],
      roomsConfig: clearingConfig(lev),
      lesserVaultsList: TOWER_VAULTS,
      forceLastStair: true,
      grid,
    }),
    enemyCount,
    lighting: { litRoomChance: 100 },
  };
}

/**
 * `id_layout_name = "cavern"` (`:131-136`): Cavern at `zoom` 12 to 20, whose
 * biggest region must hold a fifth to two fifths of the map. `rng.range`
 * truncates the fractional bounds, and `math.floor` of its integer changes
 * nothing. Simplex noise, no rooms, no doors: Cavern's defaults.
 */
function rollCavern(rng: Rng, vx: number, vy: number): TowerRoll {
  const zoom = mathRandom(rng, 'tower.alter.cavern.zoom', 12, 20);
  const minFloor = Math.floor(
    range(rng, 'tower.alter.cavern.min_floor', (vx * vy * 0.4) / 2, vx * vy * 0.4),
  );
  return {
    map: (grid) => ({ class: 'Cavern', zoom, minFloor, forceLastStair: true, grid }),
    lighting: { litRoomChance: 100 },
  };
}

/**
 * `id_layout_name = "maze"` (`:137-142`): corridors `widen_w` by `widen_h`,
 * each `util.bound(rng.normal(2, 2), 1, 7)` — a normal of spread 2, so 2 more
 * often than any other width, clamped. The map is rounded to them after the
 * pick (`:228-231`).
 */
function rollMaze(rng: Rng): TowerRoll {
  const w = bound(normal(rng, 'tower.alter.maze.widen_w', 2, 2), 1, 7);
  const h = bound(normal(rng, 'tower.alter.maze.widen_h', 2, 2), 1, 7);
  return {
    map: (grid) => ({ class: 'Maze', widenW: w, widenH: h, forceLastStair: true, grid }),
    widen: { w, h },
    lighting: {},
  };
}

/**
 * `id_layout_name = "town"` (`:143-152`): Town, entered on the right edge and
 * left by the left, one or two rooms of `forest_clearing`, a lesser vault
 * weighted `floor(40/lev)` and a `greater_vault` weighted `2*lev` — a percent
 * that always hits from level 50.
 */
function rollTown(rng: Rng, lev: number): TowerRoll {
  const buildingChance = mathRandom(rng, 'tower.alter.town.building_chance', 50, 90);
  const maxBuildingW = mathRandom(rng, 'tower.alter.town.max_building_w', 6, 11);
  const maxBuildingH = mathRandom(rng, 'tower.alter.town.max_building_h', 6, 11);
  const nbRooms = mathRandom(rng, 'tower.alter.town.nb_rooms', 1, 2);
  return {
    map: (grid) => ({
      class: 'Town',
      buildingChance,
      maxBuildingW,
      maxBuildingH,
      edgeEntrances: [6, 4],
      nbRooms,
      rooms: ['forest_clearing', ['lesser_vault', Math.floor(40 / lev)], ['lesser_vault', 2 * lev]],
      roomsConfig: clearingConfig(lev),
      lesserVaultsList: TOWER_VAULTS,
      forceLastStair: true,
      grid,
    }),
    lighting: { litRoomChance: 100 },
  };
}

/**
 * `id_layout_name = "building"` (`:153-162`): `infiniteDungeonBuilding`
 * (`mapgen/building.ts`) rolls it in its table's order, on this map's `vx` by
 * `vy`, and `enemy_count` is `ceil(vx*vy*60/4900)`.
 */
function rollBuilding(rng: Rng, lev: number, size: number, vx: number, vy: number): TowerRoll {
  const rolled = infiniteDungeonBuilding(rng, size, vx, vy, lev);
  const enemyCount = Math.ceil((vx * vy * 60) / 4900);
  return {
    map: (grid) => ({
      class: 'Building',
      ...rolled,
      lesserVaultsList: TOWER_VAULTS,
      forceLastStair: true,
      grid,
    }),
    enemyCount,
    lighting: { litRoomChance: rolled.liteRoomChance },
  };
}

/**
 * `id_layout_name = "octopus"` (`:163-170`): a centre pod of 0.25-0.35 of the
 * mean half-side, five to ten arms of 0.1-0.2 standing 0.7-0.8 of the way out.
 * No draws here: Octopus rolls them itself.
 */
function rollOctopus(): TowerRoll {
  return {
    map: (grid) => ({
      class: 'Octopus',
      mainRadius: [0.25, 0.35],
      armsRadius: [0.1, 0.2],
      armsRange: [0.7, 0.8],
      nbRooms: [5, 10],
      forceLastStair: true,
      grid,
    }),
    lighting: {},
  };
}

/**
 * `id_layout_name = "hexa"` (`:171-179`): `HEXACLE_INFINITE_DUNGEON`
 * (`mapgen/hexacle.ts`) in the floor's grid set, on a map squared after the
 * pick. No draws.
 */
function rollHexa(): TowerRoll {
  const { grid: _default, ...map } = HEXACLE_INFINITE_DUNGEON.map;
  return {
    map: (grid) => ({ ...map, grid }),
    forceSquareSize: map.forceSquareSize === true,
    lighting: {},
  };
}
