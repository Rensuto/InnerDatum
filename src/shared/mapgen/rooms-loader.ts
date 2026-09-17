// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/engines/default/engine/generator/map/RoomsLoader.lua:28-53, :377-424, :560-929
//   and game/modules/tome/data/rooms/random_room.lua:28-34, rooms/simple.lua:20-37,
//   rooms/money_vault.lua:20-48, rooms/pit.lua:20-65, rooms/lesser_vault.lua:39-125
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
 * - TMX rooms, zone-local `!room` files, `roomFrom`/`roomParse` and `makePod`
 *   have no content that needs them yet and are not ported.
 */

import type { TileXY } from '../coords.ts';
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
import { bound, normal, percent, range, table, truthy } from './lua.ts';
import { ASCII_ROOMS, RANDOM_ROOM_LIST } from './rooms.ts';

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
  /** `'.'`, `'#'`, `door`, `up`, `down`, `'+'`, `'='`. */
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
]);
