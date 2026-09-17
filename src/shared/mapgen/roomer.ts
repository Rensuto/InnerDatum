// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/engines/default/engine/generator/map/Roomer.lua:28-253
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ROOMER: A LEVEL OF ROOMS JOINED BY TUNNELS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ToME's plain dungeon floor — Kor'Pul, the Rhaloren camp, Dreadfell. The
 * order is the whole algorithm:
 *
 *   1. fill the map with `'#'`
 *   2. place the required rooms, each one using up a room from `nb_rooms`
 *   3. up to `nb_rooms * 1.5` attempts at random rooms, picked by weight
 *   4. tunnel room 1 to room 2, 2 to 3, ... and the last back to 1
 *   5. any forced tunnels
 *   6. roll a door onto each place a tunnel broke through a wall
 *   7. a spot per room, then the stairs — inside, or on two map edges
 *
 * NOTHING HERE GUARANTEES THE STAIRS ARE CONNECTED. Tunnels never carve inside
 * a room, and a room whose walls refuse every approach simply stays shut.
 * Upstream's answer is to throw the level away and generate another
 * (`engine/Zone.lua:1131-1158`), and so is ours: `mapgen/level.ts`.
 */

import type { TileXY } from '../coords.ts';
import type { Rng } from '../rng.ts';
import type { GenMap, PlacedRoom, Spot } from './genmap.ts';
import { getval, mod, percent, range, truthy } from './lua.ts';
import { placeDoors, roomAlloc, roomsLoaderInit, tunnel } from './rooms-loader.ts';
import type { EdgeSide, LoadedRoom, RoomDef, RoomerData, RoomsGen } from './rooms-loader.ts';

/** What `generate` returns: upstream's `ux, uy, dx, dy, spots`. */
export type RoomerResult = {
  readonly up: TileXY | null;
  readonly down: TileXY | null;
  readonly spots: readonly Spot[];
};

/**
 * How many random cells a stair search tries, per map cell, before it gives up.
 *
 * UPSTREAM LOOPS FOREVER (`engine/generator/map/Roomer.lua:49-56`), which on a
 * level with no open floor is a hang in the middle of a server turn. At twenty
 * per cell a search that has not found one of even a handful of floor cells is
 * astronomically unlikely, so the cap changes nothing a real level does; when
 * it does trip, the level is marked for recreation instead.
 */
const STAIR_TRIES_PER_CELL = 20;

/**
 * `Roomer:init(zone, map, level, data)` (`engine/generator/map/Roomer.lua:28-39`):
 * the defaults written into the data, then the room files loaded.
 */
export function createRoomer(
  map: GenMap,
  data: RoomerData,
  rng: Rng,
  zone: { readonly maxLevel: number },
  level: { forceRecreate: string | null },
): RoomsGen {
  const settings = {
    ...data,
    tunnelChange: data.tunnelChange ?? 30,
    tunnelRandom: data.tunnelRandom ?? 10,
    doorChance: data.doorChance ?? 50,
    liteRoomChance: data.liteRoomChance ?? 25,
  };
  const { rooms, requiredRooms } = roomsLoaderInit(settings);
  return { map, rng, data: settings, zone, level, rooms, requiredRooms };
}

function isChanceEntry(
  entry: LoadedRoom,
): entry is { readonly def: RoomDef; readonly chanceRoom: number } {
  return typeof entry === 'object' && 'chanceRoom' in entry;
}

/**
 * One uniform pick from `rooms`, re-picked until a chance entry passes its roll
 * (`engine/generator/map/Roomer.lua:186-193`). So an entry `{file, c}` comes up
 * with weight `c/100` against 1 for a plain entry.
 */
function pickRoom(gen: RoomsGen): RoomDef | null {
  for (;;) {
    // An empty list reads index 0 or 1 of nothing, as `rng.range(1, 0)` does.
    const entry = gen.rooms[range(gen.rng, 'mapgen.roomer.room.pick', 1, gen.rooms.length) - 1];
    if (entry === undefined) return null;
    if (!isChanceEntry(entry)) return entry;
    if (percent(gen.rng, 'mapgen.roomer.room.chance', entry.chanceRoom)) return entry.def;
  }
}

/**
 * `Roomer:generate(lev, old_lev)` (`engine/generator/map/Roomer.lua:152-253`).
 *
 * Returns `null` exactly where upstream returns nothing: a required room could
 * not be placed, and `gen.level.forceRecreate` says so.
 */
export function generate(gen: RoomsGen, lev: number, oldLev: number): RoomerResult | null {
  const { map, rng, data } = gen;

  // x outer, y inner, one resolve per cell.
  for (let i = 0; i < map.w; i += 1) {
    for (let j = 0; j < map.h; j += 1) map.set(i, j, map.resolve('#'));
  }

  let nbRoom = getval(rng, 'mapgen.roomer.nb_rooms', data.nbRooms ?? 10);
  const spots: Spot[] = [];
  map.spots = spots;
  const rooms = map.rooms;

  for (const entry of gen.requiredRooms) {
    let def: RoomDef | null = null;
    let ok = false;
    if (isChanceEntry(entry)) {
      if (percent(rng, 'mapgen.roomer.required.chance', entry.chanceRoom)) {
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
  // spent whether or not each one places (`engine/generator/map/Roomer.lua:183-197`).
  for (let tries = nbRoom * 1.5; tries > 0 && nbRoom > 0; tries -= 1) {
    if (roomAlloc(gen, pickRoom(gen), rooms.length + 1, lev, oldLev) !== null) nbRoom -= 1;
  }

  if (data.noTunnels !== true) chainTunnels(gen, rooms);

  for (const t of data.forceTunnels ?? []) {
    const start = forceTunnelEnd(gen, t.from, 'from');
    const end = forceTunnelEnd(gen, t.to, 'to');
    // GUARD: a random endpoint on a level with no rooms indexes nil upstream.
    if (start !== null && end !== null) tunnel(gen, start.x, start.y, end.x, end.y, t.id ?? null);
  }

  placeDoors(gen, data.doorChance);

  for (const r of rooms) spots.push({ x: r.cx, y: r.cy, type: 'room', subtype: r.room.name });

  return data.edgeEntrances !== undefined
    ? makeStairsSides(gen, lev, oldLev, data.edgeEntrances, rooms, spots)
    : makeStairsInside(gen, lev, oldLev, spots);
}

/**
 * The room chain (`engine/generator/map/Roomer.lua:200-219`): each tunnelable
 * room to the next, 1-based with wrap, the tunnel carrying the DESTINATION's id.
 *
 * THE LOOP CLOSES ONLY IF ROOM 1 CAN BE TUNNELLED TO: once the search for the
 * next room wraps, it stops at the first index at or before the current one,
 * tunnelable or not. Kept.
 */
function chainTunnels(gen: RoomsGen, rooms: readonly PlacedRoom[]): void {
  const at = (n: number): PlacedRoom => {
    const room = rooms[n - 1];
    if (room === undefined) throw new RangeError(`rooms[${String(n)}] of ${String(rooms.length)}`);
    return room;
  };
  let rs = 1;
  while (rs <= rooms.length) {
    if (at(rs).room.noTunnels === true) {
      rs += 1;
      continue;
    }
    let re = rs;
    do {
      re = mod(re, rooms.length) + 1;
    } while (!(at(re).room.noTunnels !== true || re <= rs));
    if (at(re).room.noTunnels !== true) {
      tunnel(gen, at(rs).cx, at(rs).cy, at(re).cx, at(re).cy, at(re).id);
    }
    if (re <= rs) break;
    rs = re;
  }
}

/** A `force_tunnels` endpoint: a coordinate, or any string for a random room's centre. */
function forceTunnelEnd(gen: RoomsGen, end: TileXY | string, which: string): TileXY | null {
  if (typeof end !== 'string') return end;
  const rooms = gen.map.rooms;
  const room = rooms[range(gen.rng, `mapgen.roomer.force.${which}`, 1, rooms.length) - 1];
  return room === undefined ? null : { x: room.cx, y: room.cy };
}

/**
 * One stair inside the level: random cells in `1..w-1` by `1..h-1` — the far
 * edge column and row included — until one neither blocks movement nor is
 * `special`. It becomes the key's terrain and `special = "exit"`.
 */
function placeStairInside(gen: RoomsGen, key: 'up' | 'down'): TileXY | null {
  const { map, rng } = gen;
  const limit = map.w * map.h * STAIR_TRIES_PER_CELL;
  for (let tries = 0; tries < limit; tries += 1) {
    const x = range(rng, `mapgen.roomer.stairs.${key}.x`, 1, map.w - 1);
    const y = range(rng, `mapgen.roomer.stairs.${key}.y`, 1, map.h - 1);
    if (!map.blockMove(x, y) && !truthy(map.cell(x, y).special)) {
      map.set(x, y, map.resolve(key));
      map.cell(x, y).special = 'exit';
      return { x, y };
    }
  }
  gen.level.forceRecreate = `makeStairsInside: no cell for the ${key} stair`;
  return null;
}

/**
 * `Roomer:makeStairsInside(lev, old_lev, spots)` (`engine/generator/map/Roomer.lua:42-76`):
 * the down stair first — only below the zone's last level, unless
 * `force_last_stair` — then the up stair.
 */
export function makeStairsInside(
  gen: RoomsGen,
  lev: number,
  _oldLev: number,
  spots: readonly Spot[],
): RoomerResult {
  let down: TileXY | null = null;
  if (lev < gen.zone.maxLevel || gen.data.forceLastStair === true) {
    down = placeStairInside(gen, 'down');
    if (down === null) return { up: null, down: null, spots };
  }
  return { up: placeStairInside(gen, 'up'), down, spots };
}

/** A random cell on one map edge (`engine/generator/map/Roomer.lua:88-91`). */
function sideCell(gen: RoomsGen, side: EdgeSide, key: 'up' | 'down'): TileXY {
  const { map, rng } = gen;
  const label = `mapgen.roomer.stairs.${key}.side`;
  switch (side) {
    case 4:
      return { x: 0, y: range(rng, label, 1, map.h - 1) };
    case 6:
      return { x: map.w - 1, y: range(rng, label, 1, map.h - 1) };
    case 8:
      return { x: range(rng, label, 1, map.w - 1), y: 0 };
    case 2:
      return { x: range(rng, label, 1, map.w - 1), y: map.h - 1 };
  }
}

/**
 * One edge stair: a random cell on the side that is not `special`, tunnelled to
 * a random room that is not `no_tunnels` — rooms that are get dropped from the
 * shared list for good — and only then given the stair terrain. No
 * `block_move` test: the stair is cut out of the wall.
 */
function placeStairSide(
  gen: RoomsGen,
  side: EdgeSide,
  key: 'up' | 'down',
  rooms: PlacedRoom[],
): TileXY | null {
  const { map, rng, data } = gen;
  const limit = map.w * map.h * STAIR_TRIES_PER_CELL;
  for (let tries = 0; tries < limit; tries += 1) {
    const at = sideCell(gen, side, key);
    if (truthy(map.cell(at.x, at.y).special)) continue;
    // GUARD: with no rooms left upstream indexes `rooms[rng.range(1, 0)]`, which
    // is nil, and errors. Here the stair is simply not tunnelled to anything.
    if (data.noTunnels !== true && rooms.length > 0) {
      do {
        const i = range(rng, `mapgen.roomer.stairs.${key}.room`, 1, rooms.length) - 1;
        const room = rooms[i];
        if (room === undefined) break;
        if (room.room.noTunnels === true) {
          rooms.splice(i, 1);
        } else {
          tunnel(gen, at.x, at.y, room.cx, room.cy, room.id);
          break;
        }
      } while (!(rooms.length <= 0));
    }
    map.set(at.x, at.y, map.resolve(key));
    map.cell(at.x, at.y).special = 'exit';
    return at;
  }
  gen.level.forceRecreate = `makeStairsSides: no cell for the ${key} stair`;
  return null;
}

/**
 * `Roomer:makeStairsSides(lev, old_lev, sides, rooms, spots)`
 * (`engine/generator/map/Roomer.lua:79-149`): `sides` is `{up_side, down_side}`.
 * The room list is copied once, so a `no_tunnels` room the down stair dropped
 * stays dropped for the up stair. These tunnels come after `placeDoors`, so
 * they never get doors.
 */
export function makeStairsSides(
  gen: RoomsGen,
  lev: number,
  _oldLev: number,
  sides: readonly [EdgeSide, EdgeSide],
  rooms: readonly PlacedRoom[],
  spots: readonly Spot[],
): RoomerResult {
  const list = [...rooms];
  let down: TileXY | null = null;
  if (lev < gen.zone.maxLevel || gen.data.forceLastStair === true) {
    down = placeStairSide(gen, sides[1], 'down', list);
    if (down === null) return { up: null, down: null, spots };
  }
  return { up: placeStairSide(gen, sides[0], 'up', list), down, spots };
}
