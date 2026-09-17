// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/engines/default/engine/generator/map/Town.lua:29-260
//   and game/engines/default/engine/Generator.lua:123-181 (Gridlist)
//   and game/modules/tome/data/zones/halfling-ruins/zone.lua:20-80 (TOWN_HALFLING_RUINS),
//   game/modules/tome/data/zones/rhaloren-camp/zone.lua:91-152 (TOWN_RHALOREN_CAMP)
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * TOWN: A BUILDING IN EVERY CELL OF A BSP, AND STREET WHEREVER ONE IS NOT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ToME's settled ground — the first floor of the halfling ruins, the Rhaloren
 * camp above ground, the orc prides. The order is the algorithm, and every step
 * draws from the one level RNG:
 *
 *   1. fill the whole map with `external_floor`
 *   2. required rooms, then up to `nb_rooms * 1.5` tries at random rooms
 *   3. cut the map with BSP into leaves no smaller than `max_building_w` by
 *      `max_building_h` — the names say MAX and BSP reads them as the minimum,
 *      so a leaf is at least that and under twice it
 *   4. each leaf rolls `building_chance`; a building is inset from each side of
 *      its leaf, walled, floored, maybe split into an L, and given one door
 *   5. the stairs — on two map edges, or inside
 *
 * ═══ EVERY GAP IS STREET ═══
 * A building is inset at least 2 from its leaf on every side, and two
 * neighbouring leaves share their boundary column (`[rx, rx + w]` is read
 * inclusive), so two buildings always have three cells of street between them.
 * Round the map the street is TWO wide on the left and top but ONE on the right
 * and bottom: `x1 = rx + 2` at least, `x2 = rx + w - 2` at most, and the last
 * leaf's `rx + w` is the map's width itself. What a street can hold is a room —
 * or, where `external_floor` is a table, whatever it draws: the Rhaloren
 * camp's is one tree in sixteen.
 *
 * NOTHING HERE GUARANTEES A WAY THROUGH. The door goes on a random wall cell,
 * and trees on a one-wide street can cut a stair off; `Zone:newLevel` refuses
 * the level where the stairs or a vault entrance do not reach each other, and
 * generates another (`mapgen/level.ts`). Measured on the two zones below over
 * 3,000 seeds each: every halfling ruin joined (its street is all floor), and
 * 40 Rhaloren camps did not, every one of those certified at its second attempt.
 *
 * ═══ UPSTREAM'S QUIRKS THAT SHAPE THE OUTPUT, KEPT ═══
 * - `double_lshape_chance` is read at init and NEVER USED (`:37`).
 * - `building` rolls all four insets BEFORE it looks for a room in its leaf and
 *   gives up (`:89-98`), so a leaf a room took still spends those draws.
 * - That room test reads the leaf INCLUSIVE, `[rx, rx + w]` by `[ry, ry + h]`,
 *   so a room on the first column of the NEXT leaf also clears this one.
 * - `Lshape` removes the building's door candidates one step OUTSIDE the
 *   building (`x2+1`, `x1-1`, `y2+1`, `y1-1`, `:58-59`, `:64-65`, `:70-71`,
 *   `:76-77`), where there are none, so it removes nothing: the two cells where
 *   the new wall meets the old one stay candidates for the building's door.
 * - The yard `Lshape` knocks out runs to the outer walls INCLUSIVE, so a yard
 *   takes that stretch of the building's wall with it, and those cells stay
 *   door candidates too: a building's door can stand in its own yard.
 * - `room_map.is_building` is written for every building cell and read by
 *   nothing, upstream or here.
 *
 * ═══ WHAT IS NOT UPSTREAM'S, EACH NOTED WHERE IT HAPPENS ═══
 * - `Gridlist:toList` walks `pairs`, whose order LuaJIT leaves to its hash
 *   layout; `makeGridList` names one. The list's only reader is a uniform
 *   `rng.table`, so the order decides which draw names which cell and never
 *   how likely a cell is.
 * - Stair searches are capped; upstream loops forever.
 * - A building with no door candidate gets no door, where upstream indexes nil.
 * - Town lights nothing: only a placed room rolls `lite_room_chance`
 *   (`engine/generator/map/RoomsLoader.lua:625`). Both zones below are
 *   `all_lited`, which is the zone's field, not the generator's.
 */

import type { TileXY } from '../coords.ts';
import { BSP_MAX_DEPTH, partition } from '../bsp.ts';
import type { BspNode } from '../bsp.ts';
import { TileCode } from '../protocol.ts';
import type { Rng } from '../rng.ts';
import { VAULTS_BY_SHAPE } from '../vaults.ts';
import type { GenMap, GridKeys, Spot } from './genmap.ts';
import type { LevelSpec } from './level.ts';
import { getval, percent, range, table, tableRemove, truthy } from './lua.ts';
import { roomAlloc, roomsLoaderInit } from './rooms-loader.ts';
import type {
  EdgeSide,
  LoadedRoom,
  RoomDef,
  RoomEntry,
  RoomsConfig,
  RoomsGen,
} from './rooms-loader.ts';

/**
 * A zone's `generator.map` table for Town, field for field. Absent values take
 * `Town:init`'s defaults (`engine/generator/map/Town.lua:29-41`).
 */
export type TownData = {
  /** The BSP's MINIMUM leaf width, whatever the name says. Default 12. */
  readonly maxBuildingW?: number;
  /** The BSP's minimum leaf height. Default 12. */
  readonly maxBuildingH?: number;
  /** Percent per leaf that it holds a building. Default 85. */
  readonly buildingChance?: number;
  /** Percent per building that it is split into an L. Default 50. */
  readonly lshapeChance?: number;
  /** Default 40, and never read — see the file note. */
  readonly doubleLshapeChance?: number;
  /** Percent per L that its cut-off corner is open ground. Default 30. */
  readonly yardChance?: number;
  /**
   * `nb_rooms`: a number, or a table drawn from once (`util.getval`). Default 0,
   * and a zone's `false` is the same 0 (`nb_rooms or 0`).
   */
  readonly nbRooms?: number | readonly number[];
  readonly rooms?: readonly RoomEntry[];
  readonly requiredRooms?: readonly RoomEntry[];
  /** Read by `roomPlace` only. Default 100 (`engine/generator/map/RoomsLoader.lua:625`). */
  readonly liteRoomChance?: number;
  /** Default 30 (`engine/generator/map/RoomsLoader.lua:31`); Town digs no tunnel. */
  readonly tunnelChange?: number;
  /** Default 10 (`engine/generator/map/RoomsLoader.lua:32`); Town digs no tunnel. */
  readonly tunnelRandom?: number;
  /** `{up_side, down_side}`: both stairs on those map edges instead of inside. */
  readonly edgeEntrances?: readonly [EdgeSide, EdgeSide];
  /** Place a down stair on the zone's last level too. */
  readonly forceLastStair?: boolean;
  readonly randomRoomsList?: readonly string[];
  /** Vault ids from `shared/vaults.ts`. Default: every drawn room. */
  readonly lesserVaultsList?: readonly string[];
  readonly roomsConfig?: RoomsConfig;
  /**
   * `external_floor`, `floor`, `wall`, `door`, `up`, `down` — Town's own names —
   * and `'.'`, `'#'`, `'+'` for the rooms.
   */
  readonly grid: GridKeys;
};

/** A `generator.map` table naming `engine.generator.map.Town`. */
export type TownMapSpec = { readonly class: 'Town' } & TownData;

/** The part of a zone table a Town level is built from (`mapgen/level.ts`). */
export type TownLevelSpec = LevelSpec<TownMapSpec>;

/** The generator instance: `RoomsLoader`'s `self` plus Town's own fields. */
export type TownGen = RoomsGen & {
  readonly maxBuildingW: number;
  readonly maxBuildingH: number;
  readonly buildingChance: number;
  readonly lshapeChance: number;
  /** `self.double_lshape_chance`: kept, and read by nothing, as upstream's is. */
  readonly doubleLshapeChance: number;
  readonly yardChance: number;
  /** `room_map[x][y].is_building`, row-major: 1 on every building cell. Never read. */
  readonly isBuilding: Uint8Array;
};

/** What `generate` returns: upstream's `ux, uy, dx, dy, spots`. */
export type TownResult = {
  readonly up: TileXY | null;
  readonly down: TileXY | null;
  readonly spots: readonly Spot[];
};

/** The part of a BSP leaf a building reads: `rx`, `ry` (here `x`, `y`), `w`, `h`. */
export type TownLeaf = Pick<BspNode, 'x' | 'y' | 'w' | 'h'>;

/**
 * How many random cells a stair search tries, per map cell, before it gives up.
 * UPSTREAM LOOPS FOREVER (`engine/generator/map/Town.lua:199-206`, `:228-240`);
 * see `mapgen/roomer.ts`'s cap of the same name, which this matches.
 */
const STAIR_TRIES_PER_CELL = 20;

/**
 * `Town:init(zone, map, level, data)` (`engine/generator/map/Town.lua:29-41`):
 * the defaults, then `RoomsLoader.init`, which writes the tunnel defaults into
 * the data and loads the room files (`engine/generator/map/RoomsLoader.lua:28-53`).
 *
 * `RoomsGen.data.doorChance` is Roomer's field and nothing Town calls reads it,
 * so the data carries 0.
 */
export function createTown(
  map: GenMap,
  data: TownData,
  rng: Rng,
  zone: { readonly maxLevel: number },
  level: { forceRecreate: string | null },
): TownGen {
  const settings = {
    ...data,
    tunnelChange: data.tunnelChange ?? 30,
    tunnelRandom: data.tunnelRandom ?? 10,
    liteRoomChance: data.liteRoomChance ?? 100,
    doorChance: 0,
  };
  const { rooms, requiredRooms } = roomsLoaderInit(settings);
  return {
    map,
    rng,
    data: settings,
    zone,
    level,
    rooms,
    requiredRooms,
    maxBuildingW: data.maxBuildingW ?? 12,
    maxBuildingH: data.maxBuildingH ?? 12,
    buildingChance: data.buildingChance ?? 85,
    lshapeChance: data.lshapeChance ?? 50,
    doubleLshapeChance: data.doubleLshapeChance ?? 40,
    yardChance: data.yardChance ?? 30,
    isBuilding: new Uint8Array(map.w * map.h),
  };
}

/**
 * `Gridlist` (`engine/Generator.lua:123-181`): a set of cells, `list[x][y] = true`.
 * Adding a cell twice keeps one; removing a cell that is not there does nothing.
 */
export type GridList = {
  add(x: number, y: number): void;
  remove(x: number, y: number): void;
  count(): number;
  /**
   * Every cell, COLUMN BY COLUMN from the left and each column from the top.
   * Upstream's is `pairs` order over `list[x][y]` — whatever LuaJIT's hash
   * layout gives for those keys. See the file note: the only reader draws
   * uniformly, so no cell's chance depends on it.
   */
  toList(): TileXY[];
};

/** `Generator:makeGridList()` (`engine/Generator.lua:127-129`). */
export function makeGridList(): GridList {
  const list = new Map<number, Set<number>>();
  return {
    add: (x, y) => {
      const column = list.get(x) ?? new Set<number>();
      column.add(y);
      list.set(x, column);
    },
    remove: (x, y) => {
      const column = list.get(x);
      if (column === undefined) return;
      column.delete(y);
      if (column.size === 0) list.delete(x);
    },
    count: () => {
      let nb = 0;
      for (const column of list.values()) nb += column.size;
      return nb;
    },
    toList: () =>
      [...list.keys()]
        .sort((a, b) => a - b)
        .flatMap((x) => [...(list.get(x) ?? [])].sort((a, b) => a - b).map((y) => ({ x, y }))),
  };
}

function isChanceEntry(
  entry: LoadedRoom,
): entry is { readonly def: RoomDef; readonly chanceRoom: number } {
  return typeof entry === 'object' && 'chanceRoom' in entry;
}

/**
 * The random-room pick (`engine/generator/map/Town.lua:158-167`): uniform over
 * `rooms`, re-picked until a chance entry passes its roll. An empty list reads
 * nil after its draw, as `rng.range(1, 0)` does, and `roomAlloc` refuses it.
 */
function pickRoom(gen: TownGen): RoomDef | null {
  for (;;) {
    const entry = gen.rooms[range(gen.rng, 'mapgen.town.room.pick', 1, gen.rooms.length) - 1];
    if (entry === undefined) return null;
    if (!isChanceEntry(entry)) return entry;
    if (percent(gen.rng, 'mapgen.town.room.chance', entry.chanceRoom)) return entry.def;
  }
}

/**
 * `Town:generate(lev, old_lev)` (`engine/generator/map/Town.lua:127-192`).
 *
 * Returns `null` exactly where upstream returns nothing — a required room could
 * not be placed — and `gen.level.forceRecreate` says so. A capped stair search
 * that gave up returns its stairs as `null` and sets it too.
 */
export function generate(gen: TownGen, lev: number, oldLev: number): TownResult | null {
  const { map, rng } = gen;

  // x outer, y inner, one resolve per cell.
  for (let i = 0; i < map.w; i += 1) {
    for (let j = 0; j < map.h; j += 1) map.set(i, j, map.resolve('external_floor'));
  }

  // `self.spots = spots`: a vault room pushes its spot onto the same list.
  const spots: Spot[] = [];
  map.spots = spots;

  let nbRoom = getval(rng, 'mapgen.town.nb_rooms', gen.data.nbRooms ?? 0);
  const rooms = map.rooms;

  for (const entry of gen.requiredRooms) {
    let def: RoomDef | null = null;
    let ok = false;
    if (isChanceEntry(entry)) {
      if (percent(rng, 'mapgen.town.required.chance', entry.chanceRoom)) {
        def = entry.def;
        ok = true;
      }
    } else {
      def = entry;
      ok = true;
    }
    if (ok) {
      if (roomAlloc(gen, def, rooms.length + 1, lev, oldLev) !== null) nbRoom -= 1;
      else {
        gen.level.forceRecreate = `required_room ${typeof def === 'function' ? def.name : String(def?.name)}`;
        return null;
      }
    }
  }

  // A FLOAT, counted down by one while positive: ceil(nb_room * 1.5) attempts,
  // spent whether or not each one places (`engine/generator/map/Town.lua:156-172`).
  for (let tries = nbRoom * 1.5; tries > 0 && nbRoom > 0; tries -= 1) {
    if (roomAlloc(gen, pickRoom(gen), rooms.length + 1, lev, oldLev) !== null) nbRoom -= 1;
  }

  // `BSP.new(w, h, max_building_w, max_building_h)` and `bsp:partition()`: the
  // default store, the whole map from (0, 0), cut with the C core's `range`
  // (see `BspRange`, `shared/bsp.ts`).
  const bsp = partition(
    map.w,
    map.h,
    gen.maxBuildingW,
    gen.maxBuildingH,
    rng,
    'mapgen.town.bsp',
    BSP_MAX_DEPTH,
    range,
  );
  for (const leaf of bsp.leaves) {
    if (percent(rng, 'mapgen.town.building', gen.buildingChance)) building(gen, leaf, spots);
  }

  return gen.data.edgeEntrances !== undefined
    ? makeStairsSides(gen, lev, oldLev, gen.data.edgeEntrances, spots)
    : makeStairsInside(gen, lev, oldLev, spots);
}

/**
 * `Town:building(leaf, spots)` (`engine/generator/map/Town.lua:88-125`).
 *
 * THE FOUR INSETS COME FIRST, each `rng.range(2, max(2, floor(size/2 - 3)))` —
 * left, right, top, bottom — so the walls stand 2 or more in from the leaf.
 * Only then is the leaf searched for a room, and a room anywhere in it,
 * boundary included, ends the building with those four draws spent.
 *
 * The rectangle is walled on its edge and floored inside. Every edge cell but
 * the four corners is a door candidate, and every floor cell at least 2 in from
 * the walls may become the corner of an L. The door is drawn AFTER the L, from
 * the candidates as they stand.
 */
export function building(gen: TownGen, leaf: TownLeaf, spots: Spot[]): void {
  const { map, rng } = gen;
  const inset = (label: string, size: number): number =>
    range(rng, label, 2, Math.max(2, Math.floor(size / 2 - 3)));
  // Lua evaluates `local x1, x2 = a, b` left to right: x1's draw, then x2's.
  const x1 = leaf.x + inset('mapgen.town.building.x1', leaf.w);
  const x2 = leaf.x + leaf.w - inset('mapgen.town.building.x2', leaf.w);
  const y1 = leaf.y + inset('mapgen.town.building.y1', leaf.h);
  const y2 = leaf.y + leaf.h - inset('mapgen.town.building.y2', leaf.h);
  const ix1 = x1 + 2;
  const ix2 = x2 - 2;
  const iy1 = y1 + 2;
  const iy2 = y2 - 2;
  const innerGrids: TileXY[] = [];
  const doorGrids = makeGridList();

  // "Abort if there is something already" — AFTER the draws, and inclusive.
  for (let i = leaf.x; i <= leaf.x + leaf.w; i += 1) {
    for (let j = leaf.y; j <= leaf.y + leaf.h; j += 1) {
      if (map.isBound(i, j) && truthy(map.cell(i, j).room)) return;
    }
  }

  for (let i = x1; i <= x2; i += 1) {
    for (let j = y1; j <= y2; j += 1) {
      gen.isBuilding[j * map.w + i] = 1;
      if (i === x1 || i === x2 || j === y1 || j === y2) {
        map.set(i, j, map.resolve('wall'));
        const corner = (i === x1 || i === x2) && (j === y1 || j === y2);
        if (!corner) doorGrids.add(i, j);
      } else {
        map.set(i, j, map.resolve('floor'));
        if (i >= ix1 && i <= ix2 && j >= iy1 && j <= iy2) innerGrids.push({ x: i, y: j });
      }
    }
  }

  if (percent(rng, 'mapgen.town.lshape', gen.lshapeChance)) {
    Lshape(gen, doorGrids, innerGrids, x1, x2, y1, y2, ix1, ix2, iy1, iy2);
  }

  // GUARD: with no candidate, `rng.table` draws and returns nil, and upstream
  // indexes it. Only a building two cells or less on both sides has none — a
  // leaf under 6 both ways, so a `max_building` or a map that small — and this
  // one simply gets no door.
  const door = table(rng, 'mapgen.town.building.door', doorGrids.toList());
  if (door !== null) map.set(door.value.x, door.value.y, map.resolve('door'));

  spots.push({
    x: Math.floor((x1 + x2) / 2),
    y: Math.floor((y1 + y2) / 2),
    type: 'building',
    subtype: 'building',
  });
}

/**
 * `Town:Lshape(bdoor_grids, inner_grids, x1, x2, y1, y2, ix1, ix2, iy1, iy2)`
 * (`engine/generator/map/Town.lua:43-86`): a wall from a random inner point to
 * the two FAR outer walls, cutting the building into an L and a corner room.
 *
 * DRAWS, IN ORDER: the yard roll, the point (removed from `inner_grids`), then a
 * coin for each axis on which the point is exactly central. "Far" is judged by
 * distance from the inner bounds `ix`/`iy`; the coin breaks a tie by adding
 * one to one side, so exactly one of the four cases always runs.
 *
 * On a yard roll the corner room becomes `external_floor` — its far outer
 * walls included — and the new wall is its fence. The new wall gets one door of
 * its own, anywhere along it but the point itself.
 *
 * `bdoor_grids:remove` is called as upstream calls it, one step outside the
 * building, and removes nothing: see the file note.
 */
export function Lshape(
  gen: TownGen,
  bdoorGrids: GridList,
  innerGrids: TileXY[],
  x1: number,
  x2: number,
  y1: number,
  y2: number,
  ix1: number,
  ix2: number,
  iy1: number,
  iy2: number,
): void {
  if (innerGrids.length === 0) return;
  const { map, rng } = gen;
  const doorGrids = makeGridList();
  const yard = percent(rng, 'mapgen.town.lshape.yard', gen.yardChance);
  const point = tableRemove(rng, 'mapgen.town.lshape.point', innerGrids);
  if (point === undefined) return; // not empty, so never: the type cannot see it
  let dx1 = Math.abs(point.x - ix1);
  let dx2 = Math.abs(point.x - ix2);
  let dy1 = Math.abs(point.y - iy1);
  let dy2 = Math.abs(point.y - iy2);
  if (dx1 === dx2) {
    if (percent(rng, 'mapgen.town.lshape.tie.x', 50)) dx1 += 1;
    else dx2 += 1;
  }
  if (dy1 === dy2) {
    if (percent(rng, 'mapgen.town.lshape.tie.y', 50)) dy1 += 1;
    else dy2 += 1;
  }

  /** One cell of the new wall: a door candidate, then `wall`, per cell. */
  const wall = (i: number, j: number): void => {
    doorGrids.add(i, j);
    map.set(i, j, map.resolve('wall'));
  };
  /** The corner room's cells, rewritten — and each resolved — only on a yard roll. */
  const clear = (fromX: number, toX: number, fromY: number, toY: number): void => {
    for (let i = fromX; i <= toX; i += 1) {
      for (let j = fromY; j <= toY; j += 1) {
        if (yard) map.set(i, j, map.resolve('external_floor'));
      }
    }
  };

  if (dx2 > dx1 && dy2 > dy1) {
    for (let i = point.x; i <= x2; i += 1) wall(i, point.y);
    for (let j = point.y; j <= y2; j += 1) wall(point.x, j);
    clear(point.x + 1, x2, point.y + 1, y2);
    bdoorGrids.remove(x2 + 1, point.y);
    bdoorGrids.remove(point.x, y2 + 1);
  } else if (dx1 > dx2 && dy2 > dy1) {
    for (let i = x1; i <= point.x; i += 1) wall(i, point.y);
    for (let j = point.y; j <= y2; j += 1) wall(point.x, j);
    clear(x1, point.x - 1, point.y + 1, y2);
    bdoorGrids.remove(x1 - 1, point.y);
    bdoorGrids.remove(point.x, y2 + 1);
  } else if (dx1 > dx2 && dy1 > dy2) {
    for (let i = x1; i <= point.x; i += 1) wall(i, point.y);
    for (let j = y1; j <= point.y; j += 1) wall(point.x, j);
    clear(x1, point.x - 1, y1, point.y - 1);
    bdoorGrids.remove(x1 - 1, point.y);
    bdoorGrids.remove(point.x, y1 - 1);
  } else if (dx2 > dx1 && dy1 > dy2) {
    for (let i = point.x; i <= x2; i += 1) wall(i, point.y);
    for (let j = y1; j <= point.y; j += 1) wall(point.x, j);
    clear(point.x + 1, x2, y1, point.y - 1);
    bdoorGrids.remove(x2 + 1, point.y);
    bdoorGrids.remove(point.x, y1 - 1);
  }
  doorGrids.remove(point.x, point.y);

  if (doorGrids.count() > 0) {
    const door = table(rng, 'mapgen.town.lshape.door', doorGrids.toList());
    if (door !== null) map.set(door.value.x, door.value.y, map.resolve('door'));
  }
}

/**
 * `Town:makeStairsInside(lev, old_lev, spots)` (`engine/generator/map/Town.lua:195-221`):
 * the down stair first — below the zone's last level, or with `force_last_stair`
 * — then the up stair, each on a random cell in `1..w-1` by `1..h-1` (x drawn
 * first) that neither blocks movement nor is `special`, which becomes the key's
 * terrain and `special = 'exit'`. No forced stair positions, unlike Roomer's.
 */
export function makeStairsInside(
  gen: TownGen,
  lev: number,
  _oldLev: number,
  spots: readonly Spot[],
): TownResult {
  const place = (key: 'up' | 'down'): TileXY | null => {
    const { map, rng } = gen;
    const limit = map.w * map.h * STAIR_TRIES_PER_CELL;
    for (let tries = 0; tries < limit; tries += 1) {
      const x = range(rng, `mapgen.town.stairs.${key}.x`, 1, map.w - 1);
      const y = range(rng, `mapgen.town.stairs.${key}.y`, 1, map.h - 1);
      if (!map.blockMove(x, y) && !truthy(map.cell(x, y).special)) {
        map.set(x, y, map.resolve(key));
        map.cell(x, y).special = 'exit';
        return { x, y };
      }
    }
    gen.level.forceRecreate = `makeStairsInside: no cell for the ${key} stair`;
    return null;
  };
  let down: TileXY | null = null;
  if (lev < gen.zone.maxLevel || gen.data.forceLastStair === true) {
    down = place('down');
    if (down === null) return { up: null, down: null, spots };
  }
  return { up: place('up'), down, spots };
}

/**
 * `Town:makeStairsSides(lev, old_lev, sides, spots)` (`engine/generator/map/Town.lua:224-260`):
 * `sides` is `{up_side, down_side}`; down first, then up, each on a random cell
 * of its edge — `0..len-1`, corners included — that is not `special`.
 *
 * NO `block_move` TEST, NO TUNNEL AND NO FORCED STAIRS: Forest's side stairs
 * without `forced_up`/`forced_down`. The edge is always street (see the file
 * note), so nothing needs digging to.
 */
export function makeStairsSides(
  gen: TownGen,
  lev: number,
  _oldLev: number,
  sides: readonly [EdgeSide, EdgeSide],
  spots: readonly Spot[],
): TownResult {
  const place = (side: EdgeSide, key: 'up' | 'down'): TileXY | null => {
    const { map, rng } = gen;
    const label = `mapgen.town.stairs.${key}.side`;
    const limit = map.w * map.h * STAIR_TRIES_PER_CELL;
    for (let tries = 0; tries < limit; tries += 1) {
      let at: TileXY;
      switch (side) {
        case 4:
          at = { x: 0, y: range(rng, label, 0, map.h - 1) };
          break;
        case 6:
          at = { x: map.w - 1, y: range(rng, label, 0, map.h - 1) };
          break;
        case 8:
          at = { x: range(rng, label, 0, map.w - 1), y: 0 };
          break;
        case 2:
          at = { x: range(rng, label, 0, map.w - 1), y: map.h - 1 };
          break;
      }
      if (!truthy(map.cell(at.x, at.y).special)) {
        map.set(at.x, at.y, map.resolve(key));
        map.cell(at.x, at.y).special = 'exit';
        return at;
      }
    }
    gen.level.forceRecreate = `makeStairsSides: no cell for the ${key} stair`;
    return null;
  };
  let down: TileXY | null = null;
  if (lev < gen.zone.maxLevel || gen.data.forceLastStair === true) {
    down = place(sides[1], 'down');
    if (down === null) return { up: null, down: null, spots };
  }
  return { up: place(sides[0], 'up'), down, spots };
}

// ═══════════════════════════════════════════════════════════════════════════
// ZONES
// ═══════════════════════════════════════════════════════════════════════════
//
// PLACEHOLDER TERRAIN, as `mapgen/forest.ts` has it: ToME's GRASS is GREEN,
// TREE is TREES, and a stair (`FLAT_UP_WILDERNESS`, `GRASS_UP4`, ...) is the
// ground it stands on, because a stair here is a SITES marker on a floor tile.

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE RUINED HALFLING COMPLEX, LEVEL 1 — walls standing in an open floor
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `data/zones/halfling-ruins/zone.lua:20-80`: 50x50, `all_lited`, `max_level`
 * 4. Its level 1 merges a Town table onto the zone's Roomer one
 * (`engine/Zone.lua:833-843`): `building_chance` 70, 8x8 leaves, entered on the
 * RIGHT edge and left by the LEFT (`edge_entrances = {6,4}`), and FLOOR both
 * inside and out, so a building is only its walls and its door.
 *
 * `nb_rooms = false` and `rooms = false` REPLACE the zone's ten rooms — a
 * `false` overwrites in `table.merge` (`engine/utils.lua:206-229`) — so this
 * level places none; here both are simply absent. What the merge leaves
 * standing and nothing reads without rooms (`lesser_vaults_list`,
 * `lite_room_chance`) is left out; `force_last_stair` is inherited, and is
 * this port's policy anyway: the realm decides whether a floor below exists.
 *
 * `all_lited = true` (`data/zones/halfling-ruins/zone.lua:30`) is a zone field,
 * not a generator one: the zone that builds this table says so
 * (`ZoneLevel.lighting`, `mapgen/zones.ts`), or the ruin is as dark as a cave.
 */
export const TOWN_HALFLING_RUINS: TownLevelSpec = {
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
      up: TileCode.FLOOR,
      wall: TileCode.WALL,
      down: TileCode.FLOOR,
      door: TileCode.DOOR,
      '.': TileCode.FLOOR,
      '#': TileCode.WALL,
    },
  },
};

/** The ruin rooms, standing in for the Rhaloren camp's four lesser vaults. */
const RUIN_VAULTS: readonly string[] = (VAULTS_BY_SHAPE['ruin'] ?? []).map((v) => v.id);

/** `external_floor`: fifteen GRASS and one TREE, a table drawn from on every resolve. */
const RHALOREN_EXTERNAL_FLOOR: readonly TileCode[] = [
  ...Array.from({ length: 15 }, () => TileCode.GREEN),
  TileCode.TREES,
];

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE RHALOREN CAMP, OVERGROUND — a camp in a wood, a vault or two among it
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `data/zones/rhaloren-camp/zone.lua:91-152`, the layout
 * `alternateZoneTier1` picks instead of the underground one (`:20`): 50x50,
 * `all_lited`, `max_level` 3, Town on levels 1 and 2 with `building_chance` 80,
 * 10x10 leaves, entered on the LEFT edge and left by the RIGHT, stone buildings
 * on grass where one cell in sixteen is a tree, and `nb_rooms = {0,1,1,2}` — one
 * draw — lesser vaults, lit.
 *
 * TWO CHANGES, both about where this runs:
 * - `lesser_vaults_list` names four upstream vaults; the pool here is
 *   `shared/vaults.ts`'s ruin rooms, as the forest zones use.
 * - `forceLastStair`, as for Kor'Pul: the realm decides whether a floor below
 *   exists.
 *
 * `all_lited = true` (`data/zones/rhaloren-camp/zone.lua:104`) is a zone field,
 * not a generator one: the zone that builds this table says so
 * (`ZoneLevel.lighting`, `mapgen/zones.ts`). The zone's green tint
 * (`color_shown`) is not ported.
 */
export const TOWN_RHALOREN_CAMP: TownLevelSpec = {
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
      floor: TileCode.FLOOR,
      external_floor: RHALOREN_EXTERNAL_FLOOR,
      wall: TileCode.WALL,
      up: TileCode.GREEN,
      down: TileCode.GREEN,
      door: TileCode.DOOR,
      '#': TileCode.WALL,
      '.': TileCode.FLOOR,
      '+': TileCode.DOOR,
    },
  },
};
