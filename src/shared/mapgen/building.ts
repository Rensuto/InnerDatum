// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/engines/default/engine/generator/map/Building.lua:33-326
//   and game/engines/default/engine/utils.lua:158-171, :289-293 (table.genrange,
//   table.minus_keys, table.keys) and game/modules/tome/data/zones/infinite-dungeon/zone.lua:153-162
//   (infiniteDungeonBuilding, BUILDING_INFINITE_DUNGEON)
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * BUILDING: CITY BLOCKS, CUT INTO BUILDINGS THAT SHARE THEIR WALLS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `engine.generator.map.Building` is the Infinite Dungeon's "constructed area"
 * and the second level of the Dreams. The order is the algorithm, and every
 * step draws from the one level RNG:
 *
 *   1. fill with `external_floor` — `outside_floor` in the margins
 *   2. required rooms, then up to `nb_rooms * 1.5` random rooms, each held
 *      inside the margins and under a size limit by `add_check`
 *   3. each placed room's four edges become walls a door may go in
 *   4. a BSP cuts the map into BLOCKS no smaller than `max_block`; a block's
 *      rim is street, and a second BSP cuts its inside into BUILDINGS no
 *      smaller than `max_building`, neighbours sharing a wall
 *   5. one door on every wall that has a candidate cell
 *   6. the stairs — inside the margins, or on two map edges
 *
 * ═══ WHY IT IS USUALLY CONNECTED, AND WHY NOT ALWAYS ═══
 * Every block's rim is street, and the rims of neighbouring blocks are the same
 * cells, so the streets are one network. A building on a block's rim has a wall
 * on the street; one in the middle of a block reaches it only through its
 * neighbours' doors. A door goes only on a wall cell that was, when its wall was
 * added, not an end of it and blocking on exactly two of its four sides — not a
 * junction THEN; a wall added later beside it can make it one, and the door
 * still goes there (4% of doors, measured over 300 Infinite Dungeon levels). A
 * building whose walls offer no such cell is sealed. `Zone:newLevel` throws the
 * level away when a stair lands in one (`mapgen/level.ts`).
 *
 * ═══ UPSTREAM'S QUIRKS THAT SHAPE THE OUTPUT, KEPT ═══
 * - `add_check`'s size test is ASYMMETRIC: `w + 2*border > max_room_w` but
 *   `h > max_room_h + 2*border` (`engine/generator/map/Building.lua:174`).
 * - A wall's candidates are judged ONCE, when it is added, against the terrain
 *   of that moment. A later neighbour's wall can make one a junction, and the
 *   door still goes there.
 * - A newer wall on the same line strikes from the older walls only the
 *   candidates IT kept, so a shared wall can get two doors
 *   (`engine/generator/map/Building.lua:87-92`).
 * - `addWall` marks every cell it keeps walled BEFORE testing it as a
 *   candidate, the ends and the rejected cells included.
 * - A block's street rim overwrites a room's wall — `block` tests `special` and
 *   `room`, never `walled` — while a building's walls and floor do not
 *   (`engine/generator/map/Building.lua:139` against `:109-115`).
 * - `doorOnWall` resolves `door` even when the wall has no candidate, and its
 *   `rng.table` of the empty list still draws.
 * - `lite_room_chance` defaults to 70 for a building (`:104`) and to 100 for a
 *   room (`engine/generator/map/RoomsLoader.lua:625`).
 * - The stairs honour the margins; the side stairs test `special` only, not
 *   `block_move`.
 *
 * ═══ WHAT IS NOT UPSTREAM'S, EACH NOTED WHERE IT HAPPENS ═══
 * - The order of `pairs` over a wall's candidates is ascending here.
 * - Stair searches are capped; upstream loops forever.
 * - A building's record is kept on the generator (`gen.buildings`) rather than
 *   appended to the room pool `self.rooms`, which nothing reads after the rooms
 *   are placed.
 */

import { BSP_MAX_DEPTH, partition } from '../bsp.ts';
import type { TileXY } from '../coords.ts';
import { TileCode } from '../protocol.ts';
import type { Rng } from '../rng.ts';
import { VAULTS_BY_SHAPE } from '../vaults.ts';
import type { GenMap, Spot } from './genmap.ts';
import type { BuildingMapSpec, LevelSpec } from './level.ts';
import { getval, mathRandom, percent, range, table, truthy } from './lua.ts';
import type { RoomerResult } from './roomer.ts';
import { roomAlloc, roomsLoaderInit } from './rooms-loader.ts';
import type {
  EdgeSide,
  LoadedRoom,
  Room,
  RoomDef,
  RoomEntry,
  RoomerData,
  RoomsGen,
} from './rooms-loader.ts';

/**
 * A zone's `generator.map` table for Building, field for field. Absent values
 * take `Building:init`'s defaults (`engine/generator/map/Building.lua:33-48`).
 * Grid keys are `floor`, `wall`, `door`, `up`, `down`, `external_floor` and
 * `outside_floor`, and `'.'`/`'#'` for a lesser vault's own materials.
 */
export type BuildingData = RoomerData & {
  /**
   * `max_block_w`: despite the name, the BSP's MINIMUM — a block is split
   * while it is at least twice this wide, so blocks come out between this and
   * twice it. Default 20.
   */
  readonly maxBlockW?: number;
  /** Default 20. */
  readonly maxBlockH?: number;
  /** `max_building_w`: the same kind of minimum, for a block's buildings. Default 7. */
  readonly maxBuildingW?: number;
  /** Default 7. */
  readonly maxBuildingH?: number;
  /** Columns on each side left as `outside_floor`. Default 0. */
  readonly marginW?: number;
  /** Default 0. */
  readonly marginH?: number;
  /** The widest room `add_check` accepts. Default `(w - 2*margin_w)/2 - 1`, a float on an odd map. */
  readonly maxRoomW?: number;
  /** Default `(h - 2*margin_h)/2 - 1`. */
  readonly maxRoomH?: number;
};

/** `BuildingData` once `Building:init` and `RoomsLoader.init` have written their defaults. */
export type BuildingSettings = BuildingData & {
  readonly tunnelChange: number;
  readonly tunnelRandom: number;
  readonly doorChance: number;
  /** What a ROOM rolls: `lite_room_chance or 100`. A building rolls `buildingLiteChance`. */
  readonly liteRoomChance: number;
};

/**
 * One entry of `self.walls` (`engine/generator/map/Building.lua:94`): a row
 * (`vert` false, `base` its y) or a column (`vert` true, `base` its x), and the
 * coordinates along it where a door may still go.
 */
export type Wall = {
  readonly vert: boolean;
  readonly base: number;
  /** `ps`, ascending. REASSIGNED, never edited, when a newer wall strikes cells from it. */
  ps: readonly number[];
  /** `wall.doored`: written by `doorOnWall`, read by nothing upstream. */
  doored: boolean;
};

/** A leaf as `block` and `building` read it: `rx`, `ry`, `w`, `h`, the far edge INCLUSIVE at `rx + w`. */
export type BuildingLeaf = {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
};

/** What `building` appends to `self.rooms` (`engine/generator/map/Building.lua:126`), plus its rectangle. */
export type BuildingRecord = {
  /** `#self.rooms` before the append: the room pool's length plus the buildings before this one. */
  readonly id: number;
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
  readonly cx: number;
  readonly cy: number;
  /**
   * The `lite_room_chance` roll: upstream lights every floor cell this building
   * wrote. Kept as the record of the draw; the level's light rolls the
   * building again, on its own stream, and lights `floored` on a hit
   * (`toAuthoredMap`, `mapgen/level.ts`).
   */
  readonly isLit: boolean;
  /**
   * The cells, row-major, this building wrote `floor` on: the ones
   * `self.map.lites` lights when `is_lit` (`engine/generator/map/Building.lua:114-116`).
   * Not a `special` cell, not a room's closed cell, not a `walled` one: a vault
   * standing inside a building stays dark however the building rolls.
   */
  readonly floored: readonly number[];
  readonly walls: {
    readonly up: Wall;
    readonly down: Wall;
    readonly left: Wall;
    readonly right: Wall;
  };
};

/** The generator instance: a `RoomsGen` whose data is a Building's, plus Building's own fields. */
export type BuildingGen = Omit<RoomsGen, 'data'> & {
  readonly data: BuildingSettings;
  readonly maxBlockW: number;
  readonly maxBlockH: number;
  readonly maxBuildingW: number;
  readonly maxBuildingH: number;
  readonly marginW: number;
  readonly marginH: number;
  readonly maxRoomW: number;
  readonly maxRoomH: number;
  /** `self.data.lite_room_chance or 70` (`engine/generator/map/Building.lua:104`). */
  readonly buildingLiteChance: number;
  /**
   * `self.walls`, in the order they were added. Upstream empties it at the top
   * of `generate` (`engine/generator/map/Building.lua:165`); here it starts empty
   * with the generator, which `newLevel` makes afresh for every attempt.
   */
  readonly walls: Wall[];
  readonly buildings: BuildingRecord[];
  /**
   * `room_map[x][y].walled`, row-major, 1 for true. Only Building reads or
   * writes it, so it lives on the generator rather than on every `RoomCell`.
   * Like upstream's, nothing ever clears it.
   */
  readonly walled: Uint8Array;
};

/** What `generate` returns: upstream's `ux, uy, dx, dy, spots`. */
export type BuildingResult = RoomerResult;

/**
 * How many random cells a stair search tries, per map cell, before it gives up.
 * UPSTREAM LOOPS FOREVER (`engine/generator/map/Building.lua:264`, `:294`); see
 * `mapgen/roomer.ts`'s cap of the same name, which this matches.
 */
const STAIR_TRIES_PER_CELL = 20;

/**
 * `Building:init(zone, map, level, data)` (`engine/generator/map/Building.lua:33-48`):
 * the defaults, `outside_floor` falling back to `external_floor` (resolved in
 * `generate`, since the keys are the map's), then `RoomsLoader.init`'s
 * `tunnel_change` 30 and `tunnel_random` 10 and the room files loaded.
 *
 * `door_chance` is never read: Building hangs its doors on walls, not tunnels.
 */
export function createBuilding(
  map: GenMap,
  data: BuildingData,
  rng: Rng,
  zone: { readonly maxLevel: number },
  level: { forceRecreate: string | null },
): BuildingGen {
  const marginW = data.marginW ?? 0;
  const marginH = data.marginH ?? 0;
  const settings: BuildingSettings = {
    ...data,
    tunnelChange: data.tunnelChange ?? 30,
    tunnelRandom: data.tunnelRandom ?? 10,
    doorChance: data.doorChance ?? 0,
    liteRoomChance: data.liteRoomChance ?? 100,
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
    maxBlockW: data.maxBlockW ?? 20,
    maxBlockH: data.maxBlockH ?? 20,
    maxBuildingW: data.maxBuildingW ?? 7,
    maxBuildingH: data.maxBuildingH ?? 7,
    marginW,
    marginH,
    maxRoomW: data.maxRoomW ?? (map.w - 2 * marginW) / 2 - 1,
    maxRoomH: data.maxRoomH ?? (map.h - 2 * marginH) / 2 - 1,
    buildingLiteChance: data.liteRoomChance ?? 70,
    walls: [],
    buildings: [],
    walled: new Uint8Array(map.w * map.h),
  };
}

function isChanceEntry(
  entry: LoadedRoom,
): entry is { readonly def: RoomDef; readonly chanceRoom: number } {
  return typeof entry === 'object' && 'chanceRoom' in entry;
}

/**
 * The random-room pick (`engine/generator/map/Building.lua:204-213`): uniform,
 * re-picked until a chance entry passes its roll. An empty list draws once and
 * yields nothing, which `roomAlloc` records as a failure.
 */
function pickRoom(gen: BuildingGen): RoomDef | null {
  for (;;) {
    const entry = gen.rooms[range(gen.rng, 'mapgen.building.room.pick', 1, gen.rooms.length) - 1];
    if (entry === undefined) return null;
    if (!isChanceEntry(entry)) return entry;
    if (percent(gen.rng, 'mapgen.building.room.chance', entry.chanceRoom)) return entry.def;
  }
}

/**
 * `add_check(room, x, y)` (`engine/generator/map/Building.lua:172-181`): a room
 * must fit the size limit and stand clear inside the margins.
 *
 * ═══ THE SIZE TEST IS ASYMMETRIC, AS WRITTEN ═══
 * The width counts the border against the limit, `w + 2*border > max_room_w`;
 * the height counts it FOR the room, `h > max_room_h + 2*border`. With a border
 * a room may be `4*border` taller than it may be wide. Kept.
 *
 * The position test is strict on both sides: `x` must be past
 * `margin_w + border`, and `x + w + border` short of `map.w - margin_w`.
 */
export function add_check(gen: BuildingGen, room: Room, x: number, y: number): boolean {
  const border = room.border ?? 0;
  if (room.w + 2 * border > gen.maxRoomW || room.h > gen.maxRoomH + 2 * border) return false;
  const { map } = gen;
  if (
    x <= gen.marginW + border ||
    x + room.w + border >= map.w - gen.marginW ||
    y <= gen.marginH + border ||
    y + room.h + border >= map.h - gen.marginH
  ) {
    return false;
  }
  return true;
}

/**
 * The BSP both levels of the plan are cut with: `BSP.new(w, h, min_w, min_h)`
 * then `partition(store)` (`engine/BSP.lua:33-80`), whose leaves carry the
 * store's `rx`/`ry` forward — here, the `(x, y)` offset added to each, which is
 * the same sum.
 *
 * THE CUTS ARE `rng.range`'s (`mapgen/lua.ts`), as `BspRange` in `shared/bsp.ts`
 * explains: a piece exactly twice the minimum is cut down the middle without a
 * draw, and a fractional minimum truncates.
 */
function bspLeaves(
  gen: BuildingGen,
  store: BuildingLeaf,
  minW: number,
  minH: number,
  label: string,
): BuildingLeaf[] {
  return partition(store.w, store.h, minW, minH, gen.rng, label, BSP_MAX_DEPTH, range).leaves.map(
    (leaf) => ({ x: leaf.x + store.x, y: leaf.y + store.y, w: leaf.w, h: leaf.h }),
  );
}

/**
 * `Building:generate(lev, old_lev)` (`engine/generator/map/Building.lua:155-256`).
 *
 * Returns `null` where upstream returns nothing: a required room could not be
 * placed. A capped stair search that gave up returns its stair as `null`.
 * Either way `gen.level.forceRecreate` says why.
 */
export function generate(gen: BuildingGen, lev: number, oldLev: number): BuildingResult | null {
  const { map, rng, data } = gen;
  const { marginW, marginH } = gen;

  // `self.data.outside_floor = self.data.outside_floor or self.data.external_floor`
  // (`:43`): the key that resolves is whichever the zone gave.
  const outside = data.grid['outside_floor'] !== undefined ? 'outside_floor' : 'external_floor';
  // x outer, y inner; one resolve per cell, and a second where `external_floor` is nil.
  for (let i = 0; i < map.w; i += 1) {
    for (let j = 0; j < map.h; j += 1) {
      if (i <= marginW - 1 || i >= map.w - marginW || j <= marginH - 1 || j >= map.h - marginH) {
        map.set(i, j, map.resolve(outside));
      } else {
        map.set(i, j, map.resolve('external_floor') ?? map.resolve('floor'));
      }
    }
  }
  const spots: Spot[] = [];
  map.spots = spots;

  let nbRoom = getval(rng, 'mapgen.building.nb_rooms', data.nbRooms ?? 0);
  const rooms = map.rooms;
  const check = (room: Room, x: number, y: number): boolean => add_check(gen, room, x, y);

  for (const entry of gen.requiredRooms) {
    let def: RoomDef | null = null;
    let ok = false;
    if (isChanceEntry(entry)) {
      if (percent(rng, 'mapgen.building.required.chance', entry.chanceRoom)) {
        def = entry.def;
        ok = true;
      }
    } else {
      def = entry;
      ok = true;
    }
    if (ok) {
      if (roomAlloc(gen, def, rooms.length + 1, lev, oldLev, check) !== null) nbRoom -= 1;
      else {
        gen.level.forceRecreate = `required_room ${typeof def === 'function' ? def.name : String(def?.name)}`;
        return null;
      }
    }
  }

  // A FLOAT, counted down by one while positive: ceil(nb_room * 1.5) attempts
  // (`engine/generator/map/Building.lua:202-218`).
  for (let tries = nbRoom * 1.5; tries > 0 && nbRoom > 0; tries -= 1) {
    if (roomAlloc(gen, pickRoom(gen), rooms.length + 1, lev, oldLev, check) !== null) nbRoom -= 1;
  }

  // Every placed room's edges become walls, unless it asked for no tunnels
  // (`engine/generator/map/Building.lua:221-230`). A lesser vault's cells are all
  // `special`, so its four walls come out empty — and each still draws for its door.
  for (const r of rooms) {
    if (r.room.noTunnels === true) continue;
    addWall(gen, false, r.y, r.x, r.x + r.room.w - 1);
    addWall(gen, false, r.y + r.room.h - 1, r.x, r.x + r.room.w - 1);
    addWall(gen, true, r.x, r.y, r.y + r.room.h - 1);
    addWall(gen, true, r.x + r.room.w - 1, r.y, r.y + r.room.h - 1);
  }

  // The store is ONE SHORT of the building area on each axis, because a leaf's
  // far edge is inclusive: the root block spans `margin .. map.w - margin - 1`.
  const blocks = bspLeaves(
    gen,
    { x: marginW, y: marginH, w: map.w - 2 * marginW - 1, h: map.h - 2 * marginH - 1 },
    gen.maxBlockW,
    gen.maxBlockH,
    'mapgen.building.bsp.block',
  );
  for (const leaf of blocks) block(gen, leaf, spots);

  // Every wall added so far, in order — room walls first, then each building's.
  for (const wall of gen.walls) doorOnWall(gen, wall);

  return data.edgeEntrances !== undefined
    ? makeStairsSides(gen, lev, oldLev, data.edgeEntrances, spots)
    : makeStairsInside(gen, lev, oldLev, spots);
}

/**
 * `Building:block(leaf, spots)` (`engine/generator/map/Building.lua:132-153`):
 * the rim of `[rx, rx+w] x [ry, ry+h]` becomes street, then the inside —
 * `w-2` by `h-2`, one cell in — is cut into buildings.
 *
 * The rim skips `special` cells and cells a room owns without `can_open`, and
 * nothing else: a room wall that is only `walled` is paved over.
 */
export function block(gen: BuildingGen, leaf: BuildingLeaf, spots: Spot[]): void {
  const { map } = gen;
  const x1 = leaf.x;
  const x2 = leaf.x + leaf.w;
  const y1 = leaf.y;
  const y2 = leaf.y + leaf.h;
  for (let i = x1; i <= x2; i += 1) {
    for (let j = y1; j <= y2; j += 1) {
      if (i !== x1 && i !== x2 && j !== y1 && j !== y2) continue;
      const cell = map.cell(i, j);
      if (truthy(cell.special) || (truthy(cell.room) && !truthy(cell.canOpen))) continue;
      map.set(i, j, map.resolve('external_floor') ?? map.resolve('floor'));
    }
  }

  const inside = bspLeaves(
    gen,
    { x: leaf.x + 1, y: leaf.y + 1, w: leaf.w - 2, h: leaf.h - 2 },
    gen.maxBuildingW,
    gen.maxBuildingH,
    'mapgen.building.bsp.building',
  );
  for (const sleaf of inside) building(gen, sleaf, spots);
}

/**
 * `Building:building(leaf, spots)` (`engine/generator/map/Building.lua:100-129`):
 * `[rx, rx+w] x [ry, ry+h]`, its edge wall and its inside floor.
 *
 * - `is_lit` is rolled FIRST, `lite_room_chance or 70`.
 * - A `special` cell, and a cell a room owns without `can_open`, is left alone.
 * - An edge cell becomes `wall` unless already `walled`; either way it is then
 *   `walled` and `can_open`. So the wall a neighbour already built is not
 *   written twice, and does not draw twice.
 * - An inside cell becomes `floor` unless `walled`, and is recorded in
 *   `floored`: the cells a lit building lights.
 * - Then the four walls — up, down, left, right — and a `building` spot at the
 *   centre.
 *
 * `ix1, ix2, iy1, iy2` are computed upstream and never read; not ported.
 */
export function building(gen: BuildingGen, leaf: BuildingLeaf, spots: Spot[]): void {
  const { map, rng, walled } = gen;
  const x1 = leaf.x;
  const x2 = leaf.x + leaf.w;
  const y1 = leaf.y;
  const y2 = leaf.y + leaf.h;
  const isLit = percent(rng, 'mapgen.building.lit', gen.buildingLiteChance);
  const floored: number[] = [];

  for (let i = x1; i <= x2; i += 1) {
    for (let j = y1; j <= y2; j += 1) {
      const cell = map.cell(i, j);
      if (truthy(cell.special) || (truthy(cell.room) && !truthy(cell.canOpen))) continue;
      const at = j * map.w + i;
      if (i === x1 || i === x2 || j === y1 || j === y2) {
        if (walled[at] !== 1) map.set(i, j, map.resolve('wall'));
        walled[at] = 1;
        cell.canOpen = true;
      } else if (walled[at] !== 1) {
        // Upstream also lights the cell when `is_lit`: see `BuildingRecord.floored`.
        map.set(i, j, map.resolve('floor'));
        floored.push(at);
      }
    }
  }

  const walls = {
    up: addWall(gen, false, y1, x1, x2),
    down: addWall(gen, false, y2, x1, x2),
    left: addWall(gen, true, x1, y1, y2),
    right: addWall(gen, true, x2, y1, y2),
  };
  const cx = Math.floor((x1 + x2) / 2);
  const cy = Math.floor((y1 + y2) / 2);
  gen.buildings.push({
    id: gen.rooms.length + gen.buildings.length,
    x1,
    y1,
    x2,
    y2,
    cx,
    cy,
    isLit,
    floored,
    walls,
  });
  spots.push({ x: cx, y: cy, type: 'building', subtype: 'building' });
}

/**
 * `Building:addWall(vert, base, p1, p2)` (`engine/generator/map/Building.lua:65-97`):
 * the line from `p1` to `p2` along row or column `base`, and the cells on it a
 * door may go in.
 *
 * Each cell, in turn:
 * - `special`, or owned by a room without `can_open`: dropped, and NOT walled.
 * - Otherwise WALLED, and then dropped unless it is not an end, it blocks
 *   movement, and exactly two of its four sides block movement.
 *
 * Then every older wall on the same line loses the cells THIS wall kept
 * (`table.minus_keys`), and this wall joins the list.
 *
 * ═══ `pairs` ORDER IS ASCENDING HERE ═══
 * `table.genrange(p1, p2, true)` has integer keys, and where LuaJIT keeps them
 * — array part or hash part — decides the order `pairs` and `table.keys` give.
 * The walk itself does not depend on it (no cell's test reads another's result),
 * and `doorOnWall`'s pick is uniform over the keys whatever their order, so the
 * choice changes which number picks which cell and nothing else.
 */
export function addWall(
  gen: BuildingGen,
  vert: boolean,
  base: number,
  p1: number,
  p2: number,
): Wall {
  const { map, walled } = gen;
  const bm = (x: number, y: number): number => (map.blockMove(x, y) ? 1 : 0);
  const ps: number[] = [];
  for (let z = p1; z <= p2; z += 1) {
    const x = vert ? base : z;
    const y = vert ? z : base;
    const cell = map.cell(x, y);
    if (truthy(cell.special) || (truthy(cell.room) && !truthy(cell.canOpen))) continue;
    walled[y * map.w + x] = 1;
    if (
      z === p1 ||
      z === p2 ||
      !map.blockMove(x, y) ||
      bm(x - 1, y) + bm(x + 1, y) + bm(x, y - 1) + bm(x, y + 1) !== 2
    ) {
      continue;
    }
    ps.push(z);
  }

  const kept = new Set(ps);
  for (const older of gen.walls) {
    if (older.vert === vert && older.base === base) {
      older.ps = older.ps.filter((z) => !kept.has(z));
    }
  }

  const wall: Wall = { vert, base, ps, doored: false };
  gen.walls.push(wall);
  return wall;
}

/**
 * `Building:doorOnWall(wall)` (`engine/generator/map/Building.lua:51-62`): a
 * `door` on one of the wall's candidates, picked with `rng.table`.
 *
 * A WALL WITH NO CANDIDATE STILL DRAWS AND STILL RESOLVES: `rng.table({})` rolls
 * `range(1, 0)` and returns nil, and the `door` argument is resolved before
 * `map()` sees the nil coordinate and returns without writing
 * (`engine/Map.lua:559-560`). A one-candidate wall draws nothing.
 */
export function doorOnWall(gen: BuildingGen, wall: Wall): void {
  const { map, rng } = gen;
  const picked = table(rng, 'mapgen.building.door', wall.ps);
  const door = map.resolve('door');
  if (picked !== null) {
    if (wall.vert) map.set(wall.base, picked.value, door);
    else map.set(picked.value, wall.base, door);
  }
  wall.doored = true;
}

/**
 * `Building:makeStairsInside(lev, old_lev, spots)` (`engine/generator/map/Building.lua:259-286`):
 * down first — only below the zone's last level, unless `force_last_stair` —
 * then up, each on a random cell in `margin+1 .. size-margin-1`, x drawn before
 * y, that neither blocks movement nor is `special`.
 */
export function makeStairsInside(
  gen: BuildingGen,
  lev: number,
  _oldLev: number,
  spots: readonly Spot[],
): BuildingResult {
  const { map, rng, marginW, marginH } = gen;
  const place = (key: 'up' | 'down'): TileXY | null => {
    const limit = map.w * map.h * STAIR_TRIES_PER_CELL;
    for (let tries = 0; tries < limit; tries += 1) {
      const x = range(rng, `mapgen.building.stairs.${key}.x`, marginW + 1, map.w - marginW - 1);
      const y = range(rng, `mapgen.building.stairs.${key}.y`, marginH + 1, map.h - marginH - 1);
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
 * `Building:makeStairsSides(lev, old_lev, sides, spots)` (`engine/generator/map/Building.lua:289-326`):
 * `sides` is `{up_side, down_side}`; down first, then up, each on a random cell
 * of its edge AT THE MARGIN — `x = margin_w` for side 4, `map.w - margin_w - 1`
 * for 6, and the same in y for 8 and 2 — drawn in `margin .. size-margin-1`,
 * that is not `special`.
 *
 * NO `block_move` TEST: a stair may stand on a wall.
 */
export function makeStairsSides(
  gen: BuildingGen,
  lev: number,
  _oldLev: number,
  sides: readonly [EdgeSide, EdgeSide],
  spots: readonly Spot[],
): BuildingResult {
  const { map, rng, marginW, marginH } = gen;
  const place = (side: EdgeSide, key: 'up' | 'down'): TileXY | null => {
    const label = `mapgen.building.stairs.${key}.side`;
    const limit = map.w * map.h * STAIR_TRIES_PER_CELL;
    for (let tries = 0; tries < limit; tries += 1) {
      let at: TileXY;
      switch (side) {
        case 4:
          at = { x: marginW, y: range(rng, label, marginH, map.h - marginH - 1) };
          break;
        case 6:
          at = { x: map.w - marginW - 1, y: range(rng, label, marginH, map.h - marginH - 1) };
          break;
        case 8:
          at = { x: range(rng, label, marginW, map.w - marginW - 1), y: marginH };
          break;
        case 2:
          at = { x: range(rng, label, marginW, map.w - marginW - 1), y: map.h - marginH - 1 };
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

/**
 * The Infinite Dungeon's "building" layout parameters, as `alter_level_data`
 * rolls them for one level (`data/zones/infinite-dungeon/zone.lua:153-162`).
 */
export type BuildingLayout = {
  readonly nbRooms: number;
  readonly rooms: readonly RoomEntry[];
  readonly liteRoomChance: number;
  readonly maxBlockW: number;
  readonly maxBlockH: number;
  readonly maxBuildingW: number;
  readonly maxBuildingH: number;
};

/**
 * `{id_layout_name = "building", ...}` (`data/zones/infinite-dungeon/zone.lua:153-162`),
 * rolled for level `lev` of a `w` x `h` map whose nominal size is `size`.
 *
 * In the table's own order, which is the draw order:
 *
 *   nb_rooms          math.random(0, ceil(w*h/2000))  — LuaJIT's generator
 *   rooms             {{"lesser_vault", floor(40/lev)}, "greater_vault"}
 *   lite_room_chance  rng.range(0, 100)
 *   max_block_w, _h   rng.range(7, 20) each
 *   max_building_w, _h  rng.range(4, size/6) each — a FLOAT bound, truncated
 *
 * ═══ TWO GENERATORS UPSTREAM, ONE HERE ═══
 * `math.random` is not `rng`: it is LuaJIT's own stream, seeded from the clock.
 * Both draw from `rng` here, in the table's order, by the rule in
 * `mathRandom` (`mapgen/lua.ts`): one draw, `floor(u*(n-m+1)) + m`, no
 * truncation. So `nb_rooms` is 0, 1 or 2 on a 50x50 map, each a third.
 *
 * ═══ `size/6` TRUNCATES ═══
 * `rng.range` takes C `int`s: at `size` 50 the bound is 8.33 and the range is
 * 4..8; at the Infinite Dungeon's smallest `size`, 60, it is 4..10. A `size`
 * under 24 puts the bound below 4 and the range swaps.
 *
 * ═══ `greater_vault` IS PLAYED BY `lesser_vault` ═══
 * `rooms/greater_vault.lua` is `rooms/lesser_vault.lua` line for line except the
 * list it reads, its name and its spot's subtype. Our vault pool is one set of
 * drawn rooms (`shared/vaults.ts`), so the plain entry is `lesser_vault`: every
 * pick is a vault of that pool, the chance entry still rolls, and a vault
 * placed through it reports subtype `lesser`.
 *
 * THROWS for `lev` below 1: `floor(40/0)` is infinite, which C's `int` makes
 * undefined in `rng.percent`, and no level upstream is numbered below 1.
 */
export function infiniteDungeonBuilding(
  rng: Rng,
  size: number,
  w: number,
  h: number,
  lev: number,
): BuildingLayout {
  if (!(lev >= 1)) throw new RangeError(`infiniteDungeonBuilding: level ${String(lev)} is below 1`);
  const label = 'mapgen.infinite_dungeon.building';
  const nbRooms = mathRandom(rng, `${label}.nb_rooms`, 0, Math.ceil((w * h) / 2000));
  const rooms: readonly RoomEntry[] = [['lesser_vault', Math.floor(40 / lev)], 'lesser_vault'];
  const liteRoomChance = range(rng, `${label}.lite_room_chance`, 0, 100);
  const maxBlockW = range(rng, `${label}.max_block_w`, 7, 20);
  const maxBlockH = range(rng, `${label}.max_block_h`, 7, 20);
  const maxBuildingW = range(rng, `${label}.max_building_w`, 4, size / 6);
  const maxBuildingH = range(rng, `${label}.max_building_h`, 4, size / 6);
  return { nbRooms, rooms, liteRoomChance, maxBlockW, maxBlockH, maxBuildingW, maxBuildingH };
}

/** A zone table whose `generator.map` names `engine.generator.map.Building` (`mapgen/level.ts`). */
export type BuildingLevelSpec = LevelSpec<BuildingMapSpec>;

/**
 * `size` for `infiniteDungeonBuilding` at level `lev`:
 * `60 + math.floor(30*lev/(lev + 50))` (`data/zones/infinite-dungeon/zone.lua:103`)
 * — 60 on the first level, 62 by the fourth, 70 at level 25, and short of 90
 * however deep. Upstream's map is then `vx` by `vy` around it (`:104-105`); the
 * map here is not (see `BUILDING_INFINITE_DUNGEON`), and `size` is still the
 * level's own, because `max_building_w` and `_h` are rolled from it.
 */
export function infiniteDungeonSize(lev: number): number {
  return 60 + Math.floor((30 * lev) / (lev + 50));
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE INFINITE DUNGEON'S CONSTRUCTED AREA — the only Building level ToME plays
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `data/zones/infinite-dungeon/zone.lua:153-162` is the one Building table a
 * player meets outside an event (the Dreams' second level is one), and it has
 * no fixed parameters: `alter_level_data` rolls them every level. So this is
 * the table WITHOUT them — Building's defaults stand in until a floor's roll is
 * spread over `map`:
 *
 *   map: { ...BUILDING_INFINITE_DUNGEON.map,
 *          ...infiniteDungeonBuilding(rng, infiniteDungeonSize(lev), 50, 50, lev) }
 *
 * rolled ONCE PER FLOOR and shared by all of `newLevel`'s attempts: upstream
 * runs `alter_level_data` in `getLevelData` (`engine/Zone.lua:833-843`), once
 * per level change (`:892`), and every retry reuses that data (`:1060`, `:1138`).
 * `keepTrying`'s next round is a new level change, and so a new roll.
 *
 * THE GRIDS are the default grid set, `vgrids[1]` (`:186`): FLOOR for `floor`,
 * `'.'`, `external_floor`, `outside_floor` and `up` (`:238-244`), WALL for `wall`
 * and `'#'`, DOOR for `door`. `down` is the next exit's stair there; a stair is
 * a SITES marker on floor here, so FLOOR.
 *
 * THE SIZE: upstream's map is `vx` by `vy`, rolled round a `size` of 60 to 90
 * and a new shape each level (`:103-105`); this is the 50x50 the delves are
 * built for. The BUILDINGS are not scaled down with it: `max_building_w` and
 * `_h` are rolled at the level's own `size` (`infiniteDungeonSize`), 4 to 10 on
 * the first levels, so a building is the size ToME builds and the smaller map
 * holds fewer of them. `nb_rooms` reads the map that is built, `w*h`, as
 * upstream's reads `vx*vy`.
 *
 * ADDITIONS, as for Kor'Pul: `lesserVaultsList` is the works rooms of
 * `shared/vaults.ts` standing in for the vault directories, and
 * `forceLastStair`, because the realm decides whether a floor below exists.
 *
 * NOT LIT: `all_lited` is commented out (`:31`). A building is lit on the
 * floor's `lite_room_chance` — `mapgen/level.ts` hands the floor each building
 * wrote to the level's light — and a vault lights nothing.
 */
export const BUILDING_INFINITE_DUNGEON: BuildingLevelSpec = {
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
};
