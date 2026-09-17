// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/engines/default/engine/generator/map/RoomsLoader.lua:28-53, :377-424, :427-488, :560-929
//   and game/modules/tome/data/rooms/random_room.lua:28-34, rooms/simple.lua:20-37,
//   rooms/money_vault.lua:20-48, rooms/pit.lua:20-65, rooms/lesser_vault.lua:39-125,
//   rooms/forest_clearing.lua:20-126, rooms/rocky_snowy_trees.lua:20-44
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ROOMS AND TUNNELS: HOW A ROOMER LEVEL IS BUILT, CELL BY CELL
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `RoomsLoader` is the engine mixin every room-using generator shares: load a
 * room file, find it a place, stamp it, and dig tunnels that respect what the
 * stamping wrote into the room map. `mapgen/roomer.ts` is the level loop on top.
 * Function names are upstream's, so a reader can hold the Lua beside this.
 *
 * ═══ WHAT A TUNNEL MAY DO TO A CELL (`engine/generator/map/RoomsLoader.lua:848-895`) ═══
 *   special, can_open     walk through, carve nothing
 *   special               refuse, unless it is the target: step on, record nothing
 *   room, can_open ~= false   walk through, carve nothing
 *   room, can_open false  refuse
 *   can_open true         CARVE, record a door candidate, and shut every
 *                         neighbour's can_open so no opening is two wide
 *   can_open false        refuse
 *   tunnel (same id)      refuse until 15 tries without a move
 *   anything else         carve
 * So a tunnel NEVER carves inside a room or a vault. A room it cannot enter
 * stays unconnected, and the level-wide reachability check in `mapgen/level.ts`
 * is the only thing that notices — upstream's design, kept.
 *
 * ═══ DELIBERATE DIVERGENCES, EACH ALSO NOTED WHERE IT HAPPENS ═══
 * - `money_vault` and `pit` place no entities and make none of the draws that
 *   choose them: no gold item exists to drop per cell, and pit population is a
 *   later phase. Their geometry, flags and door draw are upstream's.
 * - `lesser_vault` stamps OUR drawn rooms (`shared/vaults.ts`) where upstream
 *   loads Static vault maps, each laid in the ring of floor upstream's own
 *   walk-through vaults draw; the room function around them is upstream's.
 * - A `forest_clearing` that rolls a pit spawns no actors; it records itself as
 *   a vault, as `pit` does, and makes every draw that decides it is one.
 * - TMX rooms, zone-local `!room` files and `roomFrom`/`roomParse` have no
 *   content that needs them yet and are not ported.
 * - A pod's id is a number, where upstream's is the string `"podroom"..id`;
 *   see `podRoomId` for why that is the same tunnel.
 */

import type { TileXY } from '../coords.ts';
import { DEFAULT_HURST, DEFAULT_LACUNARITY, createNoise1 } from '../noise.ts';
import type { Noise1 } from '../noise.ts';
import { TileCode } from '../protocol.ts';
import type { Rng } from '../rng.ts';
import { VaultTurn, turnVault } from '../vault.ts';
import type { Vault } from '../vault.ts';
import { ALL_VAULTS } from '../vaults.ts';
import {
  PRIMARY_DIRS,
  adjacentCoords,
  coordToDir,
  dirSides,
  dirToCoord,
  opposedDir,
} from './dirs.ts';
import type { KeypadDir } from './dirs.ts';
import type { GenMap, GridKeys, PlacedRoom } from './genmap.ts';
import { fovDistance, line } from './geom.ts';
import {
  HEIGHTMAP_MAX,
  HEIGHTMAP_MIN,
  createHeightmap,
  generate as generateHeightmap,
  heightAt,
} from './heightmap.ts';
import type { Heightmap } from './heightmap.ts';
import { bound, normal, percent, range, table, truthy } from './lua.ts';
import { ASCII_ROOMS, RANDOM_ROOM_LIST } from './rooms.ts';
import { tableSort } from './sort.ts';

/**
 * What a placed room contributes to `AuthoredMap.vaults`: a room that "holds
 * something", which `populateDelve` guards. Only vault-like rooms carry one.
 */
export type VaultRecord = {
  readonly id: string;
  readonly turn: string;
  /** The drawing's size, which is the room's unless `inset` says otherwise. */
  readonly w: number;
  readonly h: number;
  /**
   * How far the drawing sits inside the room on every side: a lesser vault's
   * apron. Absent is 0, where the record is the whole room.
   */
  readonly inset?: number;
};

/** The fields `loadRoom` copies onto a room (`engine/generator/map/RoomsLoader.lua:406`). */
type RoomProps = {
  readonly name: string;
  readonly w: number;
  readonly h: number;
  /** Two rooms with the same tag never share a level (`roomCheck`). */
  readonly unique?: string;
  /** Clear tiles kept around the room; 0 when absent. */
  readonly border?: number;
  /** Kept out of the tunnel chain and the edge-stair tunnels. */
  readonly noTunnels?: boolean;
  /** Where placement should cluster (`engine/generator/map/RoomsLoader.lua:702-711`). */
  readonly preferLocation?: (map: GenMap) => TileXY;
  readonly vault?: VaultRecord;
  /**
   * The room's generator never reads `is_lit`, so a lit roll lights none of it
   * (`rooms/lesser_vault.lua:90`). Every other room lights itself whole on a hit.
   */
  readonly ignoresLite?: boolean;
};

/** An ASCII room: `rows[j][i]` is upstream's `t[i+1][j+1]`. */
export type AsciiRoom = RoomProps & { readonly rows: readonly string[] };

/**
 * The table a room FUNCTION returns (`rooms/simple.lua:23`). `generator` stamps
 * it at `(x, y)` and may name the cell tunnels should aim at; `null` means the
 * rectangle's centre.
 */
export type GeneratedRoom = RoomProps & {
  readonly generator: (x: number, y: number, isLit: boolean) => TileXY | null;
};

export type Room = AsciiRoom | GeneratedRoom;

/** Upstream's `return nil, "reason"`. */
export type RoomFailure = { readonly failure: string };

export type RoomFn = (
  gen: RoomsGen,
  id: number,
  lev: number,
  oldLev: number,
) => Room | RoomFailure | null;

/** What `loadRoom` returns: a cached ASCII room or a room function. */
export type RoomDef = AsciiRoom | RoomFn;

/** A `rooms` entry after loading: a room, or `{room, chance_room}` (`engine/generator/map/RoomsLoader.lua:34-42`). */
export type LoadedRoom = RoomDef | { readonly def: RoomDef; readonly chanceRoom: number };

/** A `rooms` entry as a zone writes it: `"file"` or `{"file", chance}`. */
export type RoomEntry = string | readonly [string, number];

/** A map edge, as a keypad direction. */
export type EdgeSide = 2 | 4 | 6 | 8;

/** A `force_tunnels` entry. Any string endpoint means "a random room's centre". */
export type ForceTunnel = {
  readonly from: TileXY | string;
  readonly to: TileXY | string;
  readonly id?: number;
};

/**
 * An actor filter as a zone's `rooms_config` writes one (`{type="insect", subtype="ant"}`).
 * Room functions only DRAW one, with `rng.table`; which actors it names is
 * population, and population is `populateDelve`'s.
 *
 * A field can be a FUNCTION: the infinite dungeon's clearings filter with
 * `special=function(e) ... end` (`data/zones/infinite-dungeon/zone.lua:128`,
 * `:151`), so a predicate is a value this type holds too.
 */
export type ActorFilter = Readonly<
  Record<string, string | number | boolean | ((entity: unknown) => boolean)>
>;

/** A zone's `rooms_config`: per-room settings the room functions read. */
export type RoomsConfig = {
  /**
   * `rooms_config.forest_clearing` (`zones/old-forest/zone.lua:48`): the percent
   * chance a clearing is a pit, and the filters one is drawn from.
   */
  readonly forestClearing?: {
    readonly pitChance: number;
    readonly filters: readonly ActorFilter[];
  };
};

/**
 * A zone's `generator.map` table for Roomer, field for field. Absent numbers
 * take the defaults `Roomer:init` writes (`engine/generator/map/Roomer.lua:31-34`).
 */
export type RoomerData = {
  /** `nb_rooms`: a number, or a table drawn from once (`util.getval`). Default 10. */
  readonly nbRooms?: number | readonly number[];
  readonly rooms?: readonly RoomEntry[];
  readonly requiredRooms?: readonly RoomEntry[];
  /** Default 25. */
  readonly liteRoomChance?: number;
  /** Percent per step that a tunnel reconsiders its heading. Default 30. */
  readonly tunnelChange?: number;
  /** Percent of those reconsiderations that pick a random heading. Default 10. */
  readonly tunnelRandom?: number;
  /** Percent per door candidate that a door is hung. Default 50. */
  readonly doorChance?: number;
  /**
   * `{up_side, down_side}`: stairs on that edge of the map, each tunnelled to a
   * random room. Only the four primary sides mean anything upstream
   * (`engine/generator/map/Roomer.lua:88-91`).
   */
  readonly edgeEntrances?: readonly [EdgeSide, EdgeSide];
  readonly noTunnels?: boolean;
  readonly forceTunnels?: readonly ForceTunnel[];
  /** Place a down stair on the zone's last level too. */
  readonly forceLastStair?: boolean;
  readonly randomRoomsList?: readonly string[];
  /** Vault ids from `shared/vaults.ts`. Default: every drawn room. */
  readonly lesserVaultsList?: readonly string[];
  /** `rooms_config`. Absent, a `forest_clearing` never rolls for a pit. */
  readonly roomsConfig?: RoomsConfig;
  /** `'.'`, `'#'`, `door`, `up`, `down`, `'+'`, `'='`, and `'T'` for `rocky_snowy_trees`. */
  readonly grid: GridKeys;
};

/** `RoomerData` once `Roomer:init` has written its defaults in. */
export type RoomerSettings = RoomerData & {
  readonly tunnelChange: number;
  readonly tunnelRandom: number;
  readonly doorChance: number;
  readonly liteRoomChance: number;
};

/** The generator instance — upstream's `self` in both Roomer and RoomsLoader. */
export type RoomsGen = {
  readonly map: GenMap;
  readonly rng: Rng;
  readonly data: RoomerSettings;
  readonly zone: { readonly maxLevel: number };
  /** `level.force_recreate`: set to a reason and `newLevel` starts over. */
  readonly level: { forceRecreate: string | null };
  readonly rooms: readonly LoadedRoom[];
  readonly requiredRooms: readonly LoadedRoom[];
};

// ═══════════════════════════════════════════════════════════════════════════
// LOADING
// ═══════════════════════════════════════════════════════════════════════════

/**
 * `RoomsLoader:init` (`engine/generator/map/RoomsLoader.lua:28-53`): every
 * `rooms` and `required_rooms` entry loaded, chance entries wrapped.
 *
 * ONE GUARD UPSTREAM LACKS: a list whose every entry carries a chance of 0 or
 * less makes `generate`'s pick loop spin forever, so it throws here instead.
 */
export function roomsLoaderInit(data: RoomerData): {
  readonly rooms: readonly LoadedRoom[];
  readonly requiredRooms: readonly LoadedRoom[];
} {
  const load = (entry: RoomEntry): LoadedRoom =>
    typeof entry === 'string' ? loadRoom(entry) : { def: loadRoom(entry[0]), chanceRoom: entry[1] };
  const rooms = (data.rooms ?? []).map(load);
  if (
    rooms.length > 0 &&
    rooms.every((r) => typeof r === 'object' && 'chanceRoom' in r && Math.trunc(r.chanceRoom) <= 0)
  ) {
    throw new Error('RoomsLoader: every room entry has chance 0, so no room could ever be picked');
  }
  return { rooms, requiredRooms: (data.requiredRooms ?? []).map(load) };
}

const asciiCache = new Map<string, AsciiRoom>();

/**
 * `RoomsLoader:loadRoom(file)` (`engine/generator/map/RoomsLoader.lua:377-424`).
 * A room function comes back as itself; an ASCII room is sized from its first
 * row and its row count and cached, so every placement shares one table as
 * upstream's `rooms_cache` does. An unknown file throws, as `loadfile` does.
 */
export function loadRoom(file: string): RoomDef {
  const fn = ROOM_FUNCTIONS.get(file);
  if (fn !== undefined) return fn;
  const cached = asciiCache.get(file);
  if (cached !== undefined) return cached;
  const def = ASCII_ROOMS.get(file);
  if (def === undefined) throw new Error(`loadRoom: no room file '${file}'`);
  const room: AsciiRoom = {
    name: file,
    w: def.rows[0]?.length ?? 0,
    h: def.rows.length,
    rows: def.rows,
  };
  asciiCache.set(file, room);
  return room;
}

// ═══════════════════════════════════════════════════════════════════════════
// PLACEMENT
// ═══════════════════════════════════════════════════════════════════════════

/**
 * `RoomsLoader:roomCheck(room)` (`engine/generator/map/RoomsLoader.lua:560-586`):
 * `null` when the room may be placed, else the failure reason. Only `unique`
 * is checked; no room here carries a `roomcheck` function.
 */
export function roomCheck(gen: RoomsGen, room: { readonly unique?: string }): string | null {
  if (room.unique !== undefined) {
    for (const placed of gen.map.rooms) {
      if (placed.room.unique === room.unique) return `unique:${room.unique}`;
    }
  }
  return null;
}

/**
 * `RoomsLoader:roomGen(room, id, lev, old_lev)` (`engine/generator/map/RoomsLoader.lua:594-615`):
 * run a room function, then refuse a room too big for the map (`w + 2*border`
 * must leave two tiles) or one `roomCheck` rejects. Anything that is not a
 * function is taken as the room itself, as upstream's `type(room)` test does.
 */
export function roomGen(
  gen: RoomsGen,
  def: Room | RoomFn | null,
  id: number,
  lev: number,
  oldLev: number,
): Room | null {
  let room: Room | null = null;
  let failure: string | undefined;
  if (typeof def === 'function') {
    const made = def(gen, id, lev, oldLev);
    if (made !== null && 'failure' in made) failure = made.failure;
    else room = made;
  } else {
    room = def;
  }
  const { map } = gen;
  if (room === null) {
    map.roomsFailed.push({ room: def, failure: failure ?? 'generation' });
    return null;
  }
  const border = room.border ?? 0;
  if (map.w - room.w - border * 2 < 2 || map.h - room.h - border * 2 < 2) {
    map.roomsFailed.push({ room, failure: 'placement' });
    return null;
  }
  const refused = roomCheck(gen, room);
  if (refused !== null) {
    map.roomsFailed.push({ room, failure: refused });
    return null;
  }
  return room;
}

/**
 * `RoomsLoader:roomAlloc(room, id, lev, old_lev, add_check)`
 * (`engine/generator/map/RoomsLoader.lua:686-742`): generate the room, then
 * 101 tries at a random position — x drawn before y — each refused if any
 * cell of the footprint plus its border ring is a room.
 *
 * ═══ THE OVERLAP TEST'S BUG IS KEPT ═══
 * A `border` cell blocks only inside the room's own footprint, which is what
 * `i >= x and i < x+room.w and j >= y and j < j+room.h` means to say. The last
 * clause compares `j` with itself plus a positive height and is always true, so
 * a border cell in the row BELOW the footprint blocks too. Fixing it would move
 * rooms, so it stays (`engine/generator/map/RoomsLoader.lua:722`).
 *
 * Only `room` cells block otherwise: a function room's wall ring, an ASCII
 * `!` and an edge `#` all have `room = nil`, so a later room may be laid over
 * an earlier room's walls and inherit their stale flags.
 */
export function roomAlloc(
  gen: RoomsGen,
  def: Room | RoomFn | null,
  id: number,
  lev: number,
  oldLev: number,
  addCheck?: (room: Room, x: number, y: number) => boolean,
): PlacedRoom | null {
  const room = roomGen(gen, def, id, lev, oldLev);
  if (room === null) return null;
  const { map, rng } = gen;
  const border = room.border ?? 0;
  const edge = Math.max(1, border);
  const preferred = room.preferLocation?.(map) ?? null;

  for (let tries = 0; tries <= 100; tries += 1) {
    let x: number;
    let y: number;
    if (preferred !== null) {
      // Tries spread outward from the preferred spot as `sig` grows.
      const sig = tries / 100;
      x = bound(
        normal(rng, 'mapgen.roomer.alloc.x', preferred.x, sig * map.w * 2),
        edge,
        map.w - room.w - edge,
      );
      y = bound(
        normal(rng, 'mapgen.roomer.alloc.y', preferred.y, sig * map.h * 2),
        edge,
        map.h - room.h - edge,
      );
    } else {
      x = range(rng, 'mapgen.roomer.alloc.x', edge, map.w - room.w - edge);
      y = range(rng, 'mapgen.roomer.alloc.y', edge, map.h - room.h - edge);
    }

    let ok = true;
    for (
      let i = Math.max(0, x - border);
      i <= Math.min(map.w - 1, x + room.w - 1 + border);
      i += 1
    ) {
      for (
        let j = Math.max(0, y - border);
        j <= Math.min(map.h - 1, y + room.h - 1 + border);
        j += 1
      ) {
        const cell = map.cell(i, j);
        if (truthy(cell.room)) {
          ok = false;
          break;
        } else if (
          truthy(cell.border) &&
          i >= x &&
          i < x + room.w &&
          j >= y &&
          // UPSTREAM'S BUG, KEPT: see the doc comment. Always true.
          j < j + room.h
        ) {
          ok = false;
          break;
        }
      }
      if (!ok) break;
    }
    if (ok && (addCheck === undefined || addCheck(room, x, y))) {
      return roomPlace(gen, room, id, x, y);
    }
  }
  map.roomsFailed.push({ room, failure: 'placement' });
  // `room:removed(x, y)` would run here. No room ported so far has one: the
  // only upstream users are vaults undoing their queued uniques, and ours queue
  // nothing.
  return null;
}

/**
 * `RoomsLoader:roomPlace(room, id, x, y)` (`engine/generator/map/RoomsLoader.lua:624-676`).
 *
 * `is_lit` IS DRAWN FIRST, for every room, whether or not anything reads it
 * (`engine/generator/map/RoomsLoader.lua:625`). This port lights rooms later,
 * from `AuthoredMap.rooms` with the same one-percent-per-room roll
 * (`shared/light.ts`), so the value is handed on and otherwise unused — but
 * the draw stays, because every number after it depends on it being there. A
 * room whose generator ignores the value (`ignoresLite`) is left out of that
 * list, so it stays as dark as upstream leaves it.
 */
export function roomPlace(gen: RoomsGen, room: Room, id: number, x: number, y: number): PlacedRoom {
  const { map, rng } = gen;
  const isLit = percent(rng, 'mapgen.roomer.place.lit', gen.data.liteRoomChance);

  let aim: TileXY | null = null;
  if ('generator' in room) {
    aim = room.generator(x, y, isLit);
  } else {
    for (let i = 1; i <= room.w; i += 1) {
      for (let j = 1; j <= room.h; j += 1) {
        const cell = map.cell(i - 1 + x, j - 1 + y);
        cell.room = id;
        const c = room.rows[j - 1]?.charAt(i - 1) ?? '';
        if (c === '!') {
          // A wall a tunnel may open.
          cell.room = null;
          cell.canOpen = true;
          map.set(i - 1 + x, j - 1 + y, map.resolve('#') ?? map.resolve('wall'));
        } else {
          if (c === '#' && (i === 1 || i === room.w || j === 1 || j === room.h)) {
            // "forces tunnelling around edge walls"
            cell.room = null;
            cell.canOpen = false;
          }
          // Upstream's last resort is `Grid.new{name="undefined grid"}`, a grid
          // with no properties: it blocks nothing, which FLOOR is the code for.
          map.set(
            i - 1 + x,
            j - 1 + y,
            map.resolve(c) ?? map.resolve('.') ?? map.resolve('floor') ?? TileCode.FLOOR,
          );
        }
      }
    }
  }

  const border = room.border ?? 0;
  if (border > 0) {
    for (
      let i = Math.max(0, x - border);
      i <= Math.min(map.w - 1, x + room.w - 1 + border);
      i += 1
    ) {
      for (
        let j = Math.max(0, y - border);
        j <= Math.min(map.h - 1, y + room.h - 1 + border);
        j += 1
      ) {
        if (i < x || i >= x + room.w || j < y || j >= y + room.h) map.cell(i, j).border = id;
      }
    }
  }

  const placed: PlacedRoom = {
    id,
    x,
    y,
    cx: aim?.x ?? Math.floor(x + (room.w - 1) / 2),
    cy: aim?.y ?? Math.floor(y + (room.h - 1) / 2),
    room,
  };
  map.rooms.push(placed);
  return placed;
}

// ═══════════════════════════════════════════════════════════════════════════
// TUNNELS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * `RoomsLoader:randDir()` (`engine/generator/map/RoomsLoader.lua:745-748`): one
 * of the four primary headings. Upstream calls it as `randDir(x1, x2)`, an
 * argument slip that is harmless on a square grid.
 */
export function randDir(gen: RoomsGen): readonly [number, number] {
  const dir =
    PRIMARY_DIRS[range(gen.rng, 'mapgen.roomer.tunnel.randdir', 1, PRIMARY_DIRS.length) - 1];
  return dirToCoord(dir ?? 2);
}

/**
 * `RoomsLoader:tunnelDir(x1, y1, x2, y2)` (`engine/generator/map/RoomsLoader.lua:751-761`):
 * a unit step toward the target along ONE axis. It draws only when both axes
 * differ, and a hit moves vertically.
 */
export function tunnelDir(
  gen: RoomsGen,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): readonly [number, number] {
  let xdir = x1 === x2 ? 0 : x1 < x2 ? 1 : -1;
  let ydir = y1 === y2 ? 0 : y1 < y2 ? 1 : -1;
  if (xdir !== 0 && ydir !== 0) {
    if (percent(gen.rng, 'mapgen.roomer.tunnel.axis', 50)) xdir = 0;
    else ydir = 0;
  }
  return [xdir, ydir];
}

/**
 * `RoomsLoader:markTunnel(x, y, xdir, ydir, id)` (`engine/generator/map/RoomsLoader.lua:764-778`):
 * from the cell the tunnel just LEFT, mark it and the three cells ahead of it
 * — straight on and both forward diagonals — with the tunnel id, unless
 * already marked. This is what makes a tunnel shy of running alongside itself.
 *
 * A nil id (a `force_tunnels` entry without one) writes nil, which marks
 * nothing, and `real_tunnel` becomes `true`.
 */
export function markTunnel(
  gen: RoomsGen,
  x: number,
  y: number,
  xdir: number,
  ydir: number,
  id: number | null,
): void {
  const { map } = gen;
  const bx = x - xdir;
  const by = y - ydir;
  const dir = coordToDir(xdir, ydir);
  const sides = dirSides(dir);
  for (const d of [dir, sides.left, sides.right]) {
    const [xd, yd] = dirToCoord(d);
    if (map.isBound(bx + xd, by + yd)) {
      const cell = map.cell(bx + xd, by + yd);
      if (!truthy(cell.tunnel)) cell.tunnel = id;
    }
  }
  // GUARD: the cell behind is where the tunnel stood, so it is in bounds for
  // every start upstream uses; an out-of-bounds `force_tunnels` start would
  // index nil there and crash.
  if (!map.isBound(bx, by)) return;
  const behind = map.cell(bx, by);
  if (!truthy(behind.tunnel)) behind.tunnel = id;
  behind.realTunnel = id ?? true;
}

/**
 * `RoomsLoader:tunnel(x1, y1, x2, y2, id, virtual)` (`engine/generator/map/RoomsLoader.lua:818-919`).
 *
 * Up to 2000 steps. Each step may reconsider the heading (`tunnel_change`),
 * and a reconsideration is random (`tunnel_random`) or toward the target.
 * The cell ahead is judged by the table in this file's header; an accepted
 * step moves and marks, a refused one counts toward the 15 that let a tunnel
 * cross its own trail.
 *
 * THE PATH IS APPLIED AFTERWARDS, EVEN IF THE TARGET WAS NEVER REACHED: door
 * candidates recorded (only when the zone has a `door` key), then every cell
 * not flagged "don't carve" set to `'='`, else `'.'`, else `floor`. The start
 * cell never enters the path, so it is never carved.
 */
export function tunnel(
  gen: RoomsGen,
  sx: number,
  sy: number,
  x2: number,
  y2: number,
  id: number | null,
  virtual = false,
): void {
  if (sx === x2 && sy === y2) return;
  const { map, rng, data } = gen;
  let x1 = sx;
  let y1 = sy;
  let [xdir, ydir] = tunnelDir(gen, x1, y1, x2, y2);

  const tun: { x: number; y: number; door: boolean; keep: boolean }[] = [];
  let noMoveTries = 0;
  for (let tries = 2000; tries > 0; tries -= 1) {
    if (percent(rng, 'mapgen.roomer.tunnel.change', data.tunnelChange)) {
      if (percent(rng, 'mapgen.roomer.tunnel.random', data.tunnelRandom))
        [xdir, ydir] = randDir(gen);
      else [xdir, ydir] = tunnelDir(gen, x1, y1, x2, y2);
    }

    let nx = x1 + xdir;
    let ny = y1 + ydir;
    // GUARD: with `tunnel_random` 0 and a target outside the map this re-roll
    // can never leave the edge, and upstream hangs. No zone does both.
    for (let rerolls = 0; !map.isBound(nx, ny); rerolls += 1) {
      if (rerolls > 10000) throw new Error('tunnel: stuck against the map edge');
      if (percent(rng, 'mapgen.roomer.tunnel.edge', data.tunnelRandom)) [xdir, ydir] = randDir(gen);
      else [xdir, ydir] = tunnelDir(gen, x1, y1, x2, y2);
      nx = x1 + xdir;
      ny = y1 + ydir;
    }

    const c = map.cell(nx, ny);
    if (truthy(c.special)) {
      if (truthy(c.canOpen)) {
        tun.push({ x: nx, y: ny, door: false, keep: true });
        x1 = nx;
        y1 = ny;
      } else if (nx === x2 && ny === y2) {
        // Step onto a special TARGET, recording nothing.
        x1 = nx;
        y1 = ny;
      }
    } else if (truthy(c.room)) {
      if (c.canOpen !== false) {
        tun.push({ x: nx, y: ny, door: false, keep: true });
        x1 = nx;
        y1 = ny;
      }
    } else if (c.canOpen !== null) {
      if (c.canOpen) {
        // No opening two wide: every neighbour that could be opened no longer can.
        for (const n of adjacentCoords(nx, ny)) {
          if (map.isBound(n.x, n.y)) {
            const neighbour = map.cell(n.x, n.y);
            if (truthy(neighbour.canOpen)) neighbour.canOpen = false;
          }
        }
        tun.push({ x: nx, y: ny, door: true, keep: false });
        x1 = nx;
        y1 = ny;
      }
    } else if (truthy(c.tunnel)) {
      if (c.tunnel !== id || noMoveTries >= 15) {
        tun.push({ x: nx, y: ny, door: false, keep: false });
        x1 = nx;
        y1 = ny;
      }
    } else {
      tun.push({ x: nx, y: ny, door: false, keep: false });
      x1 = nx;
      y1 = ny;
    }

    if (x1 === nx && y1 === ny) {
      markTunnel(gen, x1, y1, xdir, ydir, id);
      noMoveTries = 0;
    } else {
      noMoveTries += 1;
    }

    if (x1 === x2 && y1 === y2) break;
  }

  for (const t of tun) {
    if (t.door && data.grid.door !== undefined) map.possibleDoors.push({ x: t.x, y: t.y });
    if (!t.keep && !virtual) {
      map.set(t.x, t.y, map.resolve('=') ?? map.resolve('.') ?? map.resolve('floor'));
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// DOORS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * `RoomsLoader:canDoor(x, y)` (`engine/generator/map/RoomsLoader.lua:780-806`):
 * will a door here lead anywhere?
 *
 * For each primary heading: both it and its opposite are open, and the four
 * `dirSides` of the opposite — both perpendiculars and both diagonals on one
 * side — are all blocked. Checking all four headings covers both sides, so it
 * works out to: N and S open, W and E blocked, and NW+NE blocked OR SW+SE
 * blocked; or the same turned a quarter.
 *
 * "Open" is `not block_move`, so out of bounds and nil terrain are OPEN and a
 * shut door is blocked (`GenMap.blockMove`).
 */
export function canDoor(gen: RoomsGen, x: number, y: number): boolean {
  const open = new Map<KeypadDir, boolean>();
  for (const n of adjacentCoords(x, y)) open.set(n.dir, !gen.map.blockMove(n.x, n.y));
  for (const dir of PRIMARY_DIRS) {
    const opposed = opposedDir(dir);
    if (open.get(dir) === true && open.get(opposed) === true) {
      const sides = dirSides(opposed);
      const blocked = [sides.hardLeft, sides.left, sides.right, sides.hardRight].every(
        (d) => open.get(d) !== true,
      );
      if (blocked) return true;
    }
  }
  return false;
}

/**
 * `RoomsLoader:placeDoors(chance)` (`engine/generator/map/RoomsLoader.lua:921-929`):
 * each candidate, in the order tunnels recorded it, rolls its percent FIRST and
 * asks `canDoor` only on a hit. A door already hung counts as blocked for the
 * candidates after it.
 */
export function placeDoors(gen: RoomsGen, chance: number): void {
  const { map } = gen;
  for (const t of map.possibleDoors) {
    if (percent(gen.rng, 'mapgen.roomer.doors.chance', chance) && canDoor(gen, t.x, t.y)) {
      map.set(t.x, t.y, map.resolve('door'));
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// PODS — an irregular room, drawn outward from its centre
// ═══════════════════════════════════════════════════════════════════════════

/** The `core.noise` method a pod's outline is sampled with: `data.noise`. */
export type PodNoise = 'fbm_perlin' | 'perlin' | 'simplex' | 'fbm_simplex';

/**
 * What `makePod` reads from its `data` argument. Octopus passes ITSELF
 * (`engine/generator/map/Octopus.lua:56`), so these are the generator's own
 * fields, as `Octopus:init` defaults them (`engine/generator/map/Octopus.lua:34-43`).
 */
export type PodData = {
  /** Handed to `core.noise.new`, which ignores it. `null` is nil. */
  readonly hurst: number | null;
  /** `null` is nil, which `core.noise.new` reads as libtcod's 2. */
  readonly lacunarity: number | null;
  readonly noise: PodNoise;
  /** How fast the outline wanders as the lines go round. */
  readonly zoom: number;
  /** Read only by an `fbm_` method. */
  readonly octave: number;
  /** The fraction of the radius every line reaches, whatever the noise says. */
  readonly baseBreakpoint: number;
};

/**
 * A pod's id in `room_map.rooms`.
 *
 * ═══ UPSTREAM'S IS A STRING, AND THAT MAKES IT A DIFFERENT TUNNEL ═══
 * `makePod` returns `id = "podroom"..room_id`
 * (`engine/generator/map/RoomsLoader.lua:487`). Nothing reads it but a tunnel:
 * Roomer's edge stairs dig to a room under the ROOM's id
 * (`engine/generator/map/Roomer.lua:104`, `:137`), and a tunnel waits fifteen
 * tries before crossing a cell marked with its own id
 * (`engine/generator/map/RoomsLoader.lua:884`). The Octopus arm to pod 3 marks
 * its cells `3` (`engine/generator/map/Octopus.lua:72`); a stair tunnelling to
 * that pod carries `"podroom3"`, which is not `3`, so it crosses the arm's trail
 * at once.
 *
 * Ids here are numbers, so the pod's is its room id NEGATED. No room or tunnel
 * id upstream's generators make is below 1, so a negated one equals none of
 * them — and two stairs digging to the same pod still share one, as the two
 * `"podroom3"` strings do. (Room id 0 would negate to 0; nothing passes it.)
 */
export function podRoomId(roomId: number): number {
  return -roomId;
}

/** `noise[data.noise](noise, x, data.octave)`: only an `fbm_` method takes the octave. */
function podSampler(noise: Noise1, method: PodNoise, octave: number): (x: number) => number {
  switch (method) {
    case 'fbm_perlin':
      return (v) => noise.fbmPerlin(v, octave);
    case 'perlin':
      return (v) => noise.perlin(v);
    case 'simplex':
      return (v) => noise.simplex(v);
    case 'fbm_simplex':
      return (v) => noise.fbmSimplex(v, octave);
  }
}

/**
 * `RoomsLoader:makePod(x, y, radius, room_id, data, floor, wall)`
 * (`engine/generator/map/RoomsLoader.lua:427-488`): "an irregular shaped room".
 *
 *   1. the centre becomes `floor` and belongs to the room
 *   2. a FRESH 1D noise line (`core.noise.new(1, data.hurst, data.lacunarity)`)
 *   3. round the square of side `2 * radius`, a straight line from the centre
 *      to each perimeter point — top edge left to right, right edge top to
 *      bottom, bottom edge left to right, left edge top to bottom — painting
 *      floor until the cell's distance reaches that line's `breakdist`, which is
 *      `base_breakpoint` of the radius plus the rest of it scaled by the noise
 *   4. the spur prune: a cell of the square with EXACTLY ONE of its four sides
 *      in the room becomes `wall` and leaves the room
 *
 * It returns the room entry and PLACES NOTHING in `room_map.rooms` — the caller
 * does that. It draws no lit roll, hangs no door and sets no `can_open`, so a
 * tunnel walks through a pod without carving it (`tunnel`'s table above).
 *
 * ═══ THE RADIUS IS A FLOAT, AND EVERY LOOP STEPS OVER IT ═══
 * Octopus passes `rng.float(...) * (w/2 + h/2) / 2`, and Lua's numeric `for`
 * runs `-radius + x, -radius + x + 1, ...` while `<= radius + x` — so the
 * perimeter points are NOT CELLS. Each reaches `line.new`, which truncates them
 * toward zero (`mapgen/geom.ts`): a point at -0.4 above the top row aims at row
 * 0, not row -1.
 *
 * AND SO THE PRUNE IS A NO-OP, unless the radius is whole. It looks each side up
 * as `room_map[i-1][j]`; a Lua table holds its rows and cells at integer keys
 * only, so at `i = 17.3` every lookup is nil, no side counts, and nothing is
 * walled. A whole radius puts every point on a cell and the prune runs. Kept.
 *
 * ═══ THE PRUNE READS WHAT IT HAS ALREADY WRITTEN ═══
 * It walks x outer, y inner, and a cell walled early no longer counts as a side
 * for the cells after it. It compares only against THIS room's id, so a cell of
 * another pod — or plain rock — whose one room-side is this pod is walled too,
 * and each wall written is a `resolve`, which draws for a table key.
 *
 * ═══ `idx` IS THE FIRST ONE ═══
 * The closure counts with the `idx` declared above it (`:435`); the second
 * `local idx = 0` (`:454`) is a new variable nothing reads. So the noise is
 * sampled at `zoom * idx / (radius * 4)` with `idx` running on across all four
 * sides, and the outline is continuous all the way round.
 *
 * `x` and `y` are cells: upstream writes the centre with them unrounded, and a
 * centre off the map indexes a nil row and errors — `map.cell` throws here.
 */
export function makePod(
  gen: Pick<RoomsGen, 'map' | 'rng'>,
  x: number,
  y: number,
  radius: number,
  roomId: number,
  data: PodData,
  floor = '.',
  wall = '#',
): PlacedRoom {
  const { map, rng } = gen;
  map.set(x, y, map.resolve(floor));
  map.cell(x, y).room = roomId;

  const noise = createNoise1(
    rng,
    'mapgen.pod.noise',
    data.hurst ?? DEFAULT_HURST,
    data.lacunarity ?? DEFAULT_LACUNARITY,
  );
  const sample = podSampler(noise, data.noise, data.octave);

  let idx = 0;
  const quadrant = (i: number, j: number): void => {
    const n = (sample((data.zoom * idx) / (radius * 4)) + 1) / 2;
    const breakdist = data.baseBreakpoint * radius + (1 - data.baseBreakpoint) * radius * n;
    idx += 1;
    // `line.new(lowest.x, lowest.y, i, j)`: the start is never yielded.
    for (const c of line(x, y, i, j)) {
      if (fovDistance(x, y, c.x, c.y) >= breakdist) break;
      // Off the map: no write and NO RESOLVE, so a table key draws nothing.
      if (map.isBound(c.x, c.y)) {
        map.set(c.x, c.y, map.resolve(floor));
        map.cell(c.x, c.y).room = roomId;
      }
    }
  };
  for (let i = -radius + x; i <= radius + x; i += 1) quadrant(i, -radius + y);
  for (let i = -radius + y; i <= radius + y; i += 1) quadrant(radius + x, i);
  for (let i = -radius + x; i <= radius + x; i += 1) quadrant(i, radius + y);
  for (let i = -radius + y; i <= radius + y; i += 1) quadrant(-radius + x, i);

  /** `room_map[a] and room_map[a][b] and room_map[a][b].room == room_id`. */
  const inRoom = (a: number, b: number): boolean =>
    Number.isInteger(a) &&
    Number.isInteger(b) &&
    map.isBound(a, b) &&
    map.cell(a, b).room === roomId;
  for (let i = -radius + x; i <= radius + x; i += 1) {
    for (let j = -radius + y; j <= radius + y; j += 1) {
      if (!map.isBound(i, j)) continue;
      // Upstream also computes the four corners, g1 g3 g7 g9, and reads none.
      const sides =
        Number(inRoom(i, j + 1)) +
        Number(inRoom(i - 1, j)) +
        Number(inRoom(i + 1, j)) +
        Number(inRoom(i, j - 1));
      // Its four `elseif` branches are the four ways to have exactly one side,
      // and all four do the same thing. At a fractional `i` or `j` every lookup
      // misses, so the cell written is a cell — short of a coordinate within
      // rounding of a whole number, where upstream's write indexes nil and
      // errors, and `map.cell` throws.
      if (sides === 1) {
        map.set(i, j, map.resolve(wall));
        map.cell(i, j).room = null;
      }
    }
  }

  return {
    id: podRoomId(roomId),
    x,
    y,
    cx: x,
    cy: y,
    // `room = {}`: no size, no name, no flags. Upstream's has no name at all;
    // this one carries the id string for a reader of a map dump. `ignoresLite`
    // because nothing rolls a light for a pod, so `toAuthoredMap` lists none.
    room: { name: `podroom${String(roomId)}`, w: 0, h: 0, rows: [], ignoresLite: true },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// ROOM FUNCTIONS — modules/tome/data/rooms/*.lua that return a function
// ═══════════════════════════════════════════════════════════════════════════

/**
 * `random_room` (`rooms/random_room.lua:28-34`): one name from the zone's
 * `random_rooms_list`, or the 90-entry list (`simple` sixteen times, then every
 * ASCII room once), loaded and — if it is itself a function — run.
 */
function random_room(
  gen: RoomsGen,
  id: number,
  lev: number,
  oldLev: number,
): Room | RoomFailure | null {
  const picked = table(
    gen.rng,
    'mapgen.random_room.pick',
    gen.data.randomRoomsList ?? RANDOM_ROOM_LIST,
  );
  if (picked === null) return { failure: 'random_room: empty list' };
  const room = loadRoom(picked.value);
  return typeof room === 'function' ? room(gen, id, lev, oldLev) : room;
}

/**
 * A walled rectangle whose ring every cell may be opened by a tunnel and whose
 * inside belongs to the room — `simple`, `money_vault` and `pit` all start so.
 */
function stampWalledRect(
  gen: RoomsGen,
  id: number,
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  const { map } = gen;
  for (let i = 1; i <= w; i += 1) {
    for (let j = 1; j <= h; j += 1) {
      if (i === 1 || i === w || j === 1 || j === h) {
        map.cell(i - 1 + x, j - 1 + y).canOpen = true;
        map.set(i - 1 + x, j - 1 + y, map.resolve('#'));
      } else {
        map.cell(i - 1 + x, j - 1 + y).room = id;
        map.set(i - 1 + x, j - 1 + y, map.resolve('.'));
      }
    }
  }
}

/** `simple` (`rooms/simple.lua:20-37`): 5..12 by 5..12, width drawn first. */
function simple(gen: RoomsGen, id: number): Room {
  const w = range(gen.rng, 'mapgen.simple.w', 5, 12);
  const h = range(gen.rng, 'mapgen.simple.h', 5, 12);
  return {
    name: `simple${String(w)}x${String(h)}`,
    w,
    h,
    generator: (x, y) => {
      stampWalledRect(gen, id, x, y, w, h);
      return null;
    },
  };
}

/**
 * `money_vault` (`rooms/money_vault.lua:20-48`): a 5x5 room, 3x3 inside.
 *
 * DIVERGENCE: upstream queues a `money` object on each of the nine inside cells
 * and rolls `rng.percent(50)` for a guardian on each. Neither the gold item nor
 * the actor filter exists here, so none of those draws are made; the room is
 * recorded as a vault and `populateDelve` guards it and leaves it a find.
 */
function money_vault(gen: RoomsGen, id: number): Room {
  const w = 5;
  const h = 5;
  return {
    name: `money_vault${String(w)}x${String(h)}`,
    w,
    h,
    vault: { id: 'room:money_vault', turn: VaultTurn.None, w, h },
    generator: (x, y) => {
      stampWalledRect(gen, id, x, y, w, h);
      return null;
    },
  };
}

/**
 * `pit` (`rooms/pit.lua:20-65`): a walled room around an inner walled pit with
 * one door, and THE DOOR IS THE TUNNEL TARGET. The inner ring's corners are
 * door candidates too, so a door may be reachable only diagonally.
 *
 * DIVERGENCE: upstream first draws an actor filter from
 * `rooms_config.pit.filters` and fills the pit with vaulted monsters. There are
 * no filters to draw from yet, so that draw and the population are not made.
 */
function pit(gen: RoomsGen, id: number): Room {
  const w = range(gen.rng, 'mapgen.pit.w', 7, 12);
  const h = range(gen.rng, 'mapgen.pit.h', 7, 12);
  return {
    name: `pit${String(w)}x${String(h)}`,
    w,
    h,
    vault: { id: 'room:pit', turn: VaultTurn.None, w, h },
    generator: (x, y) => {
      const { map } = gen;
      stampWalledRect(gen, id, x, y, w, h);
      const doors: TileXY[] = [];
      for (let i = 3; i <= w - 2; i += 1) {
        for (let j = 3; j <= h - 2; j += 1) {
          if (i === 3 || i === w - 2 || j === 3 || j === h - 2) {
            map.cell(i - 1 + x, j - 1 + y).canOpen = false;
            map.set(i - 1 + x, j - 1 + y, map.resolve('#'));
            doors.push({ x: i - 1 + x, y: j - 1 + y });
          } else {
            map.cell(i - 1 + x, j - 1 + y).special = true;
          }
        }
      }
      const door = table(gen.rng, 'mapgen.pit.door', doors);
      if (door === null) return null;
      // `'+'`, not `door`: a zone without a `'+'` key leaves the pit sealed,
      // exactly as upstream's resolve to nil does.
      map.set(door.value.x, door.value.y, map.resolve('+'));
      map.cell(door.value.x, door.value.y).canOpen = true;
      return door.value;
    },
  };
}

const VAULT_BY_ID: ReadonlyMap<string, Vault> = new Map(ALL_VAULTS.map((v) => [v.id, v]));

/** The ring of floor a lesser vault is laid in. See `lesser_vault`. */
const VAULT_APRON = 1;

/**
 * Where a turned vault's entrance lands. Upstream's is the vault file's
 * `startx, starty`, defaulting to `floor(w/2), floor(h/2)`, and rotated with the
 * map (`engine/generator/map/Static.lua:517-539`). Ours is the drawing's first
 * `+`, else that same centre — carried through `turnVault` itself by turning a
 * copy whose cells are their own indices, so the two can never disagree about
 * which way a quarter turn goes.
 */
function vaultEntrance(vault: Vault, turn: VaultTurn): TileXY {
  let source = vault.tiles.indexOf(TileCode.DOOR);
  if (source < 0) source = Math.floor(vault.h / 2) * vault.w + Math.floor(vault.w / 2);
  const tagged = turnVault({ ...vault, tiles: vault.tiles.map((_, i) => i) }, turn);
  const at = tagged.tiles.indexOf(source);
  return { x: at % tagged.w, y: Math.floor(at / tagged.w) };
}

/**
 * A drawn cell in the zone's own materials.
 *
 * Upstream's vault legend names grids that are looked up in the ZONE's grid
 * list (`engine/generator/map/Static.lua:33`), and some glyphs take the zone's
 * `'.'` key outright (`maps/vaults/auto/lesser/circle.lua:23`), so a vault is
 * built of the level around it. Our drawings are stored as default codes, so
 * WALL, FLOOR and DOOR are read as the zone's `'#'`, `'.'` and `door` keys — a
 * works painted SOOT on WORKS gets a SOOT-and-WORKS vault — and a zone without
 * the key keeps the code as drawn.
 */
function drawnTerrain(map: GenMap, drawn: number): TileCode {
  const key =
    drawn === TileCode.WALL
      ? '#'
      : drawn === TileCode.FLOOR
        ? '.'
        : drawn === TileCode.DOOR
          ? 'door'
          : null;
  return (key === null ? null : map.resolve(key)) ?? (drawn as TileCode);
}

/**
 * `lesser_vault` (`rooms/lesser_vault.lua:39-125`) over OUR drawn rooms.
 *
 * UPSTREAM'S ROOM FUNCTION: up to five `rng.table` picks from the zone's list,
 * each loading the vault — which is when its rotation is drawn — and dropping it
 * from the list if `roomCheck` refuses it. The border defaults to 1.
 *
 * UPSTREAM'S STAMP, as the 18 vaults with `setStatusAll{room_map={can_open=true}}`
 * have it (`maps/vaults/auto/lesser/circle.lua:20`): `Map:import` REPLACES each
 * room-map cell (`engine/Map.lua:1003-1006`), so stale flags under the vault are
 * gone, and every cell ends `special`, `room = id`, `can_open` — tunnels walk
 * through a vault and carve none of it. A blank in our drawing is upstream's
 * undefined grid and resolves to `'.'` (`rooms/lesser_vault.lua:102-105`).
 *
 * ═══ AND THE APRON THOSE VAULTS DRAW ROUND THEMSELVES ═══
 * A tunnel that walks through a vault without carving has to come out on
 * floor, or it ends against a wall. Upstream's walk-through vaults see to that
 * in their own maps: all four vaults Kor'Pul lists draw a ring of floor round the
 * building and set `border = 0` (`maps/vaults/auto/lesser/circle.lua:21`,
 * `maps/vaults/amon-sul-crypt.lua:25`, `auto/lesser/rat-nest.lua:27`,
 * `auto/lesser/skeleton-mage-cabal.lua:27`). Our drawings were made for the cave
 * placer, which keeps their clearance as open ground outside the drawing
 * (`shared/vault.ts`), so most have walls on their edge. They get the same ring
 * here, as blank cells, and the room is the drawing plus it with no border.
 * Measured over 300 Kor'Pul levels, without the ring: 82 attempts refused for an
 * unreachable vault entrance, 111 dead-end corridors against a vault, and 148
 * vaults kept where the pick rate expects about 213.
 *
 * The spot it pushes asks `newLevel` to reach the entrance from the up stair,
 * and the entrance is where tunnels aim (`rooms/lesser_vault.lua:116-119`).
 *
 * The vault it records is the DRAWING, inset by the apron: that is the room a
 * party opens, and what `content/delve.ts` guards.
 */
function lesser_vault(gen: RoomsGen, id: number): Room | RoomFailure | null {
  const { rng } = gen;
  const list = [...(gen.data.lesserVaultsList ?? ALL_VAULTS.map((v) => v.id))];
  let chosen: { readonly vault: Vault; readonly turn: VaultTurn } | null = null;
  let tries = 5;
  do {
    const picked = table(rng, 'mapgen.lesser_vault.pick', list);
    if (picked === null) break;
    const vault = VAULT_BY_ID.get(picked.value);
    if (vault !== undefined) {
      // `rotates` is `util.getval`'d at load: a table draws, no list does not.
      const turns = vault.turns;
      const turn =
        turns.length === 0
          ? VaultTurn.None
          : (turns[range(rng, 'mapgen.lesser_vault.turn', 1, turns.length) - 1] ?? VaultTurn.None);
      // None of our drawn rooms is `unique`, so this always passes; the call
      // stays where upstream makes it so a unique room would be refused here.
      const refused = roomCheck(gen, {});
      if (refused === null) chosen = { vault, turn };
      else list.splice(picked.index, 1);
    } else {
      list.splice(picked.index, 1);
    }
    tries -= 1;
  } while (!(chosen !== null || list.length <= 0 || tries <= 0));
  if (chosen === null) return { failure: 'lesser_vault: no appropriate vaults found' };

  const { vault, turn } = chosen;
  const shape = turnVault(vault, turn);
  const w = shape.w + VAULT_APRON * 2;
  const h = shape.h + VAULT_APRON * 2;
  const drawnAt = vaultEntrance(vault, turn);
  const entrance = { x: drawnAt.x + VAULT_APRON, y: drawnAt.y + VAULT_APRON };
  /** The drawing's code at a room cell, or null on the apron and on a blank. */
  const drawnCell = (dx: number, dy: number): number | null => {
    const sx = dx - VAULT_APRON;
    const sy = dy - VAULT_APRON;
    if (sx < 0 || sy < 0 || sx >= shape.w || sy >= shape.h) return null;
    return shape.tiles[sy * shape.w + sx] ?? null;
  };
  return {
    name: `lesser_vault-${vault.id}-${String(w)}x${String(h)}`,
    w,
    h,
    border: 0,
    vault: { id: vault.id, turn, w: shape.w, h: shape.h, inset: VAULT_APRON },
    ignoresLite: true,
    generator: (x, y) => {
      const { map } = gen;
      for (let i = x; i <= x + w - 1; i += 1) {
        for (let j = y; j <= y + h - 1; j += 1) {
          const drawn = drawnCell(i - x, j - y);
          map.set(i, j, drawn === null ? map.resolve('.') : drawnTerrain(map, drawn));
          Object.assign(map.cell(i, j), {
            room: id,
            canOpen: true,
            special: true,
            border: null,
            tunnel: null,
            realTunnel: null,
          });
        }
      }
      const at = { x: entrance.x + x, y: entrance.y + y };
      map.spots.push({ ...at, checkConnectivity: 'entrance', type: 'vault', subtype: 'lesser' });
      return at;
    },
  };
}

/**
 * The heightmap both organic rooms start from (`rooms/forest_clearing.lua:27`,
 * `rooms/rocky_snowy_trees.lua:27`): roughness 2, every corner at the top and
 * the middle forced to the bottom — a bowl, deepest in the centre.
 */
function roomHeightmap(gen: RoomsGen, w: number, h: number, label: string): Heightmap {
  const hm = createHeightmap(w, h, 2, {
    middle: HEIGHTMAP_MIN,
    upLeft: HEIGHTMAP_MAX,
    downLeft: HEIGHTMAP_MAX,
    upRight: HEIGHTMAP_MAX,
    downRight: HEIGHTMAP_MAX,
  });
  generateHeightmap(hm, gen.rng, label);
  return hm;
}

/**
 * How many times `forest_clearing` rebuilds its heightmap before it keeps what
 * it has.
 *
 * UPSTREAM RECURSES WITHOUT LIMIT (`rooms/forest_clearing.lua:81`, `:95`). It
 * stops because the forced-low centre is nearly always open and nearly always
 * has an open neighbour. Past this many builds — which no measured seed comes
 * near — the last build is materialised as it stands, even if its largest
 * group is a single cell or there is none.
 */
export const CLEARING_REBUILDS = 1000;

/** What `make_hmap` settled on: the open cells kept, and whether it is a pit. */
export type Clearing = {
  /** `dmap`, column `i-1` row `j-1`, row-major: 1 where the clearing is open. */
  readonly open: Uint8Array;
  readonly pit: boolean;
};

/**
 * `make_hmap`, the search half (`rooms/forest_clearing.lua:25-96`): a heightmap,
 * the pit roll, then an 8-way flood fill that keeps only the largest open group.
 * With no group, or a largest group under two cells, ALL OF IT is done again —
 * heightmap draws and pit roll included. The painting half is the room's
 * generator, below.
 *
 * MEASURED, THE REBUILD NEVER HAPPENS: 200,000 heightmaps over every size, no
 * build without a group, none whose largest group is one cell, and no tie for
 * largest (a sixth have more than one group). The forced-low centre is always
 * open and always has open neighbours. So `heightmap` is a parameter: a test
 * hands in the maps the real one never makes, to see the rebuild happen.
 */
export function make_hmap(
  gen: RoomsGen,
  w: number,
  h: number,
  heightmap: (gen: RoomsGen, w: number, h: number) => Heightmap = (g, hw, hh) =>
    roomHeightmap(g, hw, hh, 'mapgen.forest_clearing.hmap'),
): Clearing {
  const { rng } = gen;
  const cut = (HEIGHTMAP_MAX * 5) / 6;
  const index = (i: number, j: number): number => (j - 1) * w + (i - 1);

  for (let build = 1; ; build += 1) {
    const hm = heightmap(gen, w, h);

    // `rooms_config and rooms_config.forest_clearing and rng.percent(...)`: no
    // config, no draw. A hit draws a filter, and an empty filter list is no pit.
    const config = gen.data.roomsConfig?.forestClearing;
    let pit = false;
    if (config !== undefined && percent(rng, 'mapgen.forest_clearing.pit', config.pitChance)) {
      pit = table(rng, 'mapgen.forest_clearing.pit.filter', config.filters) !== null;
    }

    // `opens[i][j]` is the cell's 1-based slot in `list`; 0 is nil.
    const open = new Uint8Array(w * h);
    const opens = new Int32Array(w * h);
    const list: ({ readonly x: number; readonly y: number } | null)[] = [];
    for (let i = 1; i <= w; i += 1) {
      for (let j = 1; j <= h; j += 1) {
        if (heightAt(hm, i, j) < cut) {
          open[index(i, j)] = 1;
          opens[index(i, j)] = list.length + 1;
          list.push({ x: i, y: j });
        }
      }
    }

    /** `floodFill` (`rooms/forest_clearing.lua:48-70`): a FIFO queue, eight pushes per cell. */
    const floodFill = (x: number, y: number): TileXY[] => {
      const q: TileXY[] = [{ x, y }];
      const closed: TileXY[] = [];
      for (let head = 0; head < q.length; head += 1) {
        const n = q[head];
        if (n === undefined) break;
        const inside = n.x >= 1 && n.x <= w && n.y >= 1 && n.y <= h;
        const slot = inside ? (opens[index(n.x, n.y)] ?? 0) : 0;
        if (slot === 0) continue;
        closed.push(n);
        list[slot - 1] = null;
        opens[index(n.x, n.y)] = 0;
        q.push(
          { x: n.x - 1, y: n.y },
          { x: n.x, y: n.y + 1 },
          { x: n.x + 1, y: n.y },
          { x: n.x, y: n.y - 1 },
          { x: n.x + 1, y: n.y - 1 },
          { x: n.x + 1, y: n.y + 1 },
          { x: n.x - 1, y: n.y - 1 },
          { x: n.x - 1, y: n.y + 1 },
        );
      }
      return closed;
    };

    // `while next(list)`: `list` was built by appending, so LuaJIT holds every
    // slot in the table's array part and `next` returns the lowest slot still
    // set — a forward scan (C core: `lj_tab_next`, src/luajit2/src/lj_tab.c).
    const groups: TileXY[][] = [];
    for (const l of list) {
      if (l !== null) groups.push(floodFill(l.x, l.y));
    }

    // Smallest first, so the largest is last; ties fall where Lua's unstable
    // sort leaves them. An empty list sorts to nothing, and the sort draws nothing.
    tableSort(groups, (a, b) => a.length < b.length);
    const largest = groups[groups.length - 1];
    if ((largest !== undefined && largest.length >= 2) || build >= CLEARING_REBUILDS) {
      for (const g of groups.slice(0, -1)) {
        for (const c of g) open[index(c.x, c.y)] = 0;
      }
      return { open, pit };
    }
  }
}

/** A room table whose fields its generator may still fill in. */
type OpenRoom = { -readonly [K in keyof GeneratedRoom]: GeneratedRoom[K] };

/**
 * `forest_clearing` (`rooms/forest_clearing.lua:22-126`): a 6..10 by 6..10
 * patch of heightmap, width drawn first, whose low ground is open and whose
 * high ground is `'#'`.
 *
 * ═══ ITS WALLS ARE PLAIN ROCK TO A TUNNEL ═══
 * Only open cells get `room = id`; a wall cell's room map is untouched
 * (`can_open = true` is commented out at `:102`), so a tunnel aiming at the
 * centre CARVES through the trees around it rather than walking round them.
 *
 * ═══ THE PIT ═══
 * With `rooms_config.forest_clearing`, each build rolls its `pit_chance` and a
 * hit draws a filter. Upstream then makes a vaulted actor on every open cell.
 * DIVERGENCE: no actor is made, and none of `makeEntity`'s draws; the clearing
 * is recorded as a vault (`room:forest_clearing`), exactly as `pit` is, so
 * `populateDelve` guards it.
 *
 * Returns nothing, so tunnels aim at the rectangle's centre — which is the
 * heightmap's forced-low middle.
 */
function forest_clearing(gen: RoomsGen, id: number): Room {
  const w = range(gen.rng, 'mapgen.forest_clearing.w', 6, 10);
  const h = range(gen.rng, 'mapgen.forest_clearing.h', 6, 10);
  const room: OpenRoom = {
    name: `forest_clearing${String(w)}x${String(h)}`,
    w,
    h,
    generator: (x, y) => {
      const { map } = gen;
      const clearing = make_hmap(gen, w, h);
      for (let i = 1; i <= w; i += 1) {
        for (let j = 1; j <= h; j += 1) {
          if (clearing.open[(j - 1) * w + (i - 1)] !== 1) {
            map.set(i - 1 + x, j - 1 + y, map.resolve('#'));
          } else {
            map.cell(i - 1 + x, j - 1 + y).room = id;
            map.set(i - 1 + x, j - 1 + y, map.resolve('.'));
          }
        }
      }
      if (clearing.pit) room.vault = { id: 'room:forest_clearing', turn: VaultTurn.None, w, h };
      return null;
    },
  };
  return room;
}

/**
 * `rocky_snowy_trees` (`rooms/rocky_snowy_trees.lua:22-44`): a 5..12 by 5..12
 * heightmap cut in three — at or above 5.4/6 of the range `'#'`, at or above
 * 4.3/6 `'T'`, and the rest open ground that belongs to the room. Neither `'#'` nor `'T'`
 * is flagged, so tunnels carve through both. No retries, no flood fill: a
 * pocket of open ground may be cut off.
 */
function rocky_snowy_trees(gen: RoomsGen, id: number): Room {
  const w = range(gen.rng, 'mapgen.rocky_snowy_trees.w', 5, 12);
  const h = range(gen.rng, 'mapgen.rocky_snowy_trees.h', 5, 12);
  return {
    name: `rocky_snowy_trees${String(w)}x${String(h)}`,
    w,
    h,
    generator: (x, y) => {
      const { map } = gen;
      const hm = roomHeightmap(gen, w, h, 'mapgen.rocky_snowy_trees.hmap');
      for (let i = 1; i <= w; i += 1) {
        for (let j = 1; j <= h; j += 1) {
          const v = heightAt(hm, i, j);
          if (v >= (HEIGHTMAP_MAX * 5.4) / 6) {
            map.set(i - 1 + x, j - 1 + y, map.resolve('#'));
          } else if (v >= (HEIGHTMAP_MAX * 4.3) / 6) {
            map.set(i - 1 + x, j - 1 + y, map.resolve('T'));
          } else {
            map.cell(i - 1 + x, j - 1 + y).room = id;
            map.set(i - 1 + x, j - 1 + y, map.resolve('.'));
          }
        }
      }
      return null;
    },
  };
}

/**
 * The room files that are functions, by the name a zone lists them under. A Map
 * rather than an object literal, so `loadRoom('toString')` is an unknown file
 * and not a method of Object.prototype.
 */
const ROOM_FUNCTIONS: ReadonlyMap<string, RoomFn> = new Map<string, RoomFn>([
  ['random_room', random_room],
  ['simple', simple],
  ['money_vault', money_vault],
  ['pit', pit],
  ['lesser_vault', lesser_vault],
  ['forest_clearing', forest_clearing],
  ['rocky_snowy_trees', rocky_snowy_trees],
]);
