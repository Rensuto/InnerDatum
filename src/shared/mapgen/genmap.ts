// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/engines/default/engine/Generator.lua:31-77 (room_map, resolve)
//   and game/engines/default/engine/Map.lua:559-577, :797-806, :958-961 (call, checkEntity, isBound)
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE MAP A GENERATOR WORKS ON: TERRAIN, PLUS THE ROOM MAP BESIDE IT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Upstream's generators write two layers. Terrain is what the player gets.
 * `map.room_map[x][y]` is the generator's own scratch — which room owns a cell,
 * whether a tunnel may open it, whether it is part of a vault — and it is what
 * makes a tunnel walk AROUND a room's corner instead of through it. Nothing
 * outside generation reads it, so it never reaches `AuthoredMap`.
 *
 * ═══ THE FLAGS ARE LUA VALUES, AND SOME HAVE THREE STATES ═══
 * `can_open` is true, false or nil, and `tunnel` tests all three: `false`
 * refuses a crossing, `true` carves and records a door, `nil` is plain rock
 * (`engine/generator/map/RoomsLoader.lua:868-882`). So the fields below keep
 * `null` for nil and `false` for false, and a reader must go through
 * `truthy` (`mapgen/lua.ts`) rather than `if (cell.x)`.
 *
 * NO CODE UPSTREAM EVER CLEARS ONE. They are only set or overwritten, which is
 * why a later room laid over an earlier room's wall inherits its stale
 * `can_open = false`, and why that matters to the tunnels.
 */

import type { TileXY } from '../coords.ts';
import { isWalkable } from '../protocol.ts';
import type { TileCode } from '../protocol.ts';
import type { Rng } from '../rng.ts';
import { range } from './lua.ts';
import type { Room, RoomFn } from './rooms-loader.ts';

/** Terrain nobody has written: upstream's `nil` in `map.map[i][TERRAIN]`. */
export const NIL_TERRAIN = -1;

/**
 * What a grid key resolves through (`engine/Generator.lua:59-77`): one code, a
 * table drawn from on EVERY resolve, or a function.
 */
export type GridValue = TileCode | readonly TileCode[] | ((rng: Rng) => TileCode);

/**
 * A zone's grid keys — `'.'`, `'#'`, `door`, `up`, `down`, `'+'` — as its
 * `generator.map` table spells them. A key that is absent resolves to `null`,
 * and writing `null` is a no-op, which is how a zone with no `up` key gets a
 * stair mark and no stair terrain.
 */
export type GridKeys = Readonly<Record<string, GridValue>>;

/** `map.room_map[x][y]` (`engine/Generator.lua:38-46`). `null` is Lua's nil. */
export type RoomCell = {
  /** The room id that owns the cell, or `false` where a vault said so. */
  room: number | false | null;
  /** THREE STATES — see the file note. */
  canOpen: boolean | null;
  /**
   * `true` for vault and pit cells, `'exit'` under a stair, `'pond'` under a
   * Forest pond (`engine/generator/map/Forest.lua:131`).
   */
  special: true | 'exit' | 'pond' | false | null;
  /** The id of the room whose clearance ring this is. Placement only. */
  border: number | null;
  /** The id of the tunnel that marked the cell. */
  tunnel: number | null;
  /** Written and never read by Roomer, kept for parity with `markTunnel`. */
  realTunnel: number | true | null;
};

/** One entry of `room_map.rooms` (`engine/generator/map/RoomsLoader.lua:668`). */
export type PlacedRoom = {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  /** Where tunnels aim: the room's centre unless its generator said otherwise. */
  readonly cx: number;
  readonly cy: number;
  readonly room: Room;
};

/**
 * A level spot (`engine/generator/map/Roomer.lua:244-246`, `rooms/lesser_vault.lua:117`).
 * `checkConnectivity` names what `Zone:newLevel` must reach from here; `false`
 * is upstream's own value for a `no_tunnels` vault and means "nothing".
 */
export type Spot = {
  readonly x: number;
  readonly y: number;
  readonly type: string;
  readonly subtype: string;
  readonly checkConnectivity?: 'entrance' | 'exit' | TileXY | false;
};

export type GenMap = {
  readonly w: number;
  readonly h: number;
  /** Row-major terrain codes; `NIL_TERRAIN` where nothing was written. */
  readonly tiles: Int32Array;
  /** Row-major `room_map` cells. */
  readonly cells: readonly RoomCell[];
  /** `room_map.rooms`, in placement order. */
  readonly rooms: PlacedRoom[];
  /** `room_map.rooms_failed`. Diagnostics only. */
  readonly roomsFailed: { readonly room: Room | RoomFn | null; readonly failure: string }[];
  /** `gen.spots`. Reset by `generate`, appended to by vault rooms. */
  spots: Spot[];
  /** `gen.possible_doors`: every can_open crossing a tunnel carved, duplicates included. */
  readonly possibleDoors: TileXY[];
  /** `map:isBound(x, y)` (`engine/Map.lua:958-961`). */
  isBound(x: number, y: number): boolean;
  /** The terrain code, or `null` for nil terrain or out of bounds. */
  get(x: number, y: number): TileCode | null;
  /**
   * `map(x, y, TERRAIN, e)` (`engine/Map.lua:559-577`). Out of bounds is
   * ignored, and `null` is upstream's nil entity: a GETTER call, so nothing is
   * written.
   */
  set(x: number, y: number, code: TileCode | null): void;
  /** `room_map[x][y]`. Throws out of bounds, where upstream indexes nil. */
  cell(x: number, y: number): RoomCell;
  /**
   * `map:checkEntity(x, y, TERRAIN, "block_move")` with no actor
   * (`engine/Map.lua:797-806`) — the question `canDoor` and the stair placers
   * ask. Out of bounds and nil terrain answer false, because `checkEntity`
   * returns nil there. A DOOR answers TRUE: ToME's `Grid:block_move` refuses a
   * `door_opened` grid to anything not planning a route
   * (`tome/class/Grid.lua:89-90`), and this caller is not. That needs no clause
   * of its own, because DOOR is not walkable (`shared/protocol.ts`); the test
   * pins it, so a door made walkable there fails here.
   */
  blockMove(x: number, y: number): boolean;
  /** `Generator:resolve(key)` (`engine/Generator.lua:59-77`). */
  resolve(key: string): TileCode | null;
};

function freshCell(): RoomCell {
  return { room: null, canOpen: null, special: null, border: null, tunnel: null, realTunnel: null };
}

/**
 * A blank map: nil terrain everywhere and an empty room map, which is the
 * state `Generator.init` hands a generator (`engine/Generator.lua:38-46`).
 *
 * `keys` and `rng` ride along because upstream's `resolve` reads the zone's
 * generator table and draws from the one level RNG; one map per attempt keeps
 * a retry from inheriting anything.
 */
export function createGenMap(w: number, h: number, keys: GridKeys, rng: Rng): GenMap {
  const tiles = new Int32Array(w * h).fill(NIL_TERRAIN);
  const cells: RoomCell[] = [];
  for (let i = 0; i < w * h; i += 1) cells.push(freshCell());

  const isBound = (x: number, y: number): boolean => x >= 0 && x < w && y >= 0 && y < h;

  const get = (x: number, y: number): TileCode | null => {
    if (!isBound(x, y)) return null;
    const code = tiles[y * w + x] ?? NIL_TERRAIN;
    return code === NIL_TERRAIN ? null : (code as TileCode);
  };

  return {
    w,
    h,
    tiles,
    cells,
    rooms: [],
    roomsFailed: [],
    spots: [],
    possibleDoors: [],
    isBound,
    get,
    set: (x, y, code) => {
      if (code === null || !isBound(x, y)) return;
      tiles[y * w + x] = code;
    },
    cell: (x, y) => {
      const cell = isBound(x, y) ? cells[y * w + x] : undefined;
      if (cell === undefined) {
        throw new RangeError(
          `room_map[${String(x)}][${String(y)}] is outside ${String(w)}x${String(h)}`,
        );
      }
      return cell;
    },
    blockMove: (x, y) => {
      const code = get(x, y);
      if (code === null) return false;
      return !isWalkable(code);
    },
    resolve: (key) => {
      const value = keys[key];
      if (value === undefined) return null;
      if (typeof value === 'function') return value(rng);
      if (typeof value === 'number') return value;
      // A TABLE DRAWS ON EVERY RESOLVE, including each cell of the full-map
      // `'#'` fill and each carved tunnel cell (`engine/Generator.lua:63-64`).
      return value[range(rng, `mapgen.resolve.${key}`, 1, value.length) - 1] ?? null;
    },
  };
}
