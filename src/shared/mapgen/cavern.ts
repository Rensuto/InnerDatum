// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/engines/default/engine/generator/map/Cavern.lua:28-246
//   and game/engines/default/engine/utils.lua:610-617 (table.shuffle);
//   and the C core, which the reference tree does not ship: lj_tab_next and the
//   array-part sizing in src/luajit2/src/lj_tab.c (LuaJIT's next), as T-Engine4
//   vendors it (T-Engine4 tag tome-1.6.0, commit 0d95bc38)
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * CAVERN: THE NOISE DECIDES THE ROCK, AND ONLY THE BIGGEST HOLE IS KEPT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ToME's cave floor — the orc breeding pits, Ardhungol, the Deep Bellow, the
 * Scintillating Caves. The whole algorithm:
 *
 *   1. a fresh 2D noise field; every cell whose sample is ABOVE ZERO is floor,
 *      every other cell is wall
 *   2. flood every floor region, eight neighbours at a time
 *   3. no region at all, or the biggest smaller than `min_floor`: start again
 *      from step 1 with a NEW noise field
 *   4. every region but the biggest becomes wall
 *   5. required rooms, then `nb_rooms` random rooms — none by default
 *   6. doors, only if the zone gave a `door_chance` (no ToME zone does)
 *   7. both stairs on random cells that are open and not special
 *
 * ═══ EVERY OPEN CELL IS REACHABLE, BY CONSTRUCTION ═══
 * Step 4 leaves exactly one eight-connected region, and the stairs stand in it.
 * Diagonal steps count: two floor cells that touch only at a corner are one
 * region, as they are to a body that moves eight ways. That is the whole
 * connectivity story when no rooms are placed; rooms laid afterwards are not
 * tunnelled to (step 5's `make_tunnel` is dead in ToME, see `generate`), and
 * `Zone:newLevel`'s check (`mapgen/level.ts`) is what refuses one the stairs
 * cannot reach.
 *
 * ═══ NOTHING HERE IS LIT ═══
 * Cavern never lights a cell. Only a placed room rolls `lite_room_chance`
 * (`engine/generator/map/RoomsLoader.lua:625`), and with no rooms a cave is as
 * dark as a zone without `all_lited` leaves it.
 *
 * ═══ TWO ORDERS LUA LEAVES TO ITS IMPLEMENTATION, AND THE ANSWERS HERE ═══
 * - `next(list)` (`engine/generator/map/Cavern.lua:89`) picks the region to
 *   flood next, and it is the lowest-numbered cell still unflooded, column by
 *   column (x outer, y inner, as the fill runs). `list` starts as a fresh `{}`
 *   and is only ever written by `list[#list+1] =`. A table with no hash part
 *   rehashes on every new key, and the rehash sizes the ARRAY part counting the
 *   key being added (C core: `rehashtab` and `bestasize`, src/luajit2/src/lj_tab.c),
 *   so every entry lands in the array part, which `lj_tab_next` walks in
 *   ascending index. Nothing sits in the hash part to walk in another order.
 * - `table.sort(groups, ...)` (`:98`) is LuaJIT's quicksort, which is NOT
 *   stable, and which of two equal-sized regions ends up "the biggest" is
 *   whatever its swaps leave last. `mapgen/sort.ts` is that C, swap for swap,
 *   so the tie goes where upstream's goes — and so does the order the other
 *   regions are walled in, which draws when the wall key is a table
 *   (`scintillating-caves/zone.lua:127` gives twenty).
 */

import type { TileXY } from '../coords.ts';
import { createNoise2 } from '../noise.ts';
import type { Noise2 } from '../noise.ts';
import type { Rng } from '../rng.ts';
import type { GenMap, GridKeys, Spot } from './genmap.ts';
import { getval, percent, range, truthy } from './lua.ts';
import { roomAlloc, roomsLoaderInit } from './rooms-loader.ts';
import type { LoadedRoom, RoomDef, RoomEntry, RoomsGen } from './rooms-loader.ts';
import { tableSort } from './sort.ts';

/**
 * `noise[self.noise]`: the `core.noise` method a zone names. Upstream accepts any
 * method name; these are the four `shared/noise.ts` ports. `simplex` and
 * `perlin` take NO octave argument (C core: `noise_simplex`, src/noise.c), so
 * Cavern's `octave` reaches only the `fbm_` two.
 */
export type CavernNoise = 'simplex' | 'perlin' | 'fbm_simplex' | 'fbm_perlin';

/**
 * A zone's `generator.map` table for Cavern, field for field. Absent values
 * take the defaults `Cavern:init` writes (`engine/generator/map/Cavern.lua:32-38`).
 */
export type CavernData = {
  /** "Periodicity rate for open spaces": lower is wider. Default 12. */
  readonly zoom?: number;
  /** Passed to `core.noise.new`, which ignores it. Default 0.2. */
  readonly hurst?: number;
  /** Default 4; only an `fbm_` noise reads it. */
  readonly lacunarity?: number;
  /** Default 1; only an `fbm_` noise reads it. */
  readonly octave?: number;
  /** Percent per doorway-shaped cell. Default nil: no doors at all. */
  readonly doorChance?: number;
  /** The fewest cells the biggest region may have. Default 900. */
  readonly minFloor?: number;
  /** Default `simplex`. */
  readonly noise?: CavernNoise;
  /** `nb_rooms`: a number, or a table drawn from once (`util.getval`). Default 0. */
  readonly nbRooms?: number | readonly number[];
  readonly rooms?: readonly RoomEntry[];
  readonly requiredRooms?: readonly RoomEntry[];
  /** Read by `roomPlace` only. Default 100 (`engine/generator/map/RoomsLoader.lua:625`). */
  readonly liteRoomChance?: number;
  /** Default 30 (`engine/generator/map/RoomsLoader.lua:31`). */
  readonly tunnelChange?: number;
  /** Default 10 (`engine/generator/map/RoomsLoader.lua:32`). */
  readonly tunnelRandom?: number;
  /** Place a down stair on the zone's last level too. */
  readonly forceLastStair?: boolean;
  readonly randomRoomsList?: readonly string[];
  readonly lesserVaultsList?: readonly string[];
  /** `floor`, `wall`, `door`, `up`, `down` — Cavern's own names for them. */
  readonly grid: GridKeys;
};

/** The generator instance: `RoomsLoader`'s `self` plus Cavern's own fields. */
export type CavernGen = RoomsGen & {
  readonly zoom: number;
  readonly hurst: number;
  readonly lacunarity: number;
  readonly octave: number;
  /** `self.door_chance`: `null` is upstream's nil, and skips `addDoors`. */
  readonly doorChance: number | null;
  readonly minFloor: number;
  readonly noise: CavernNoise;
  /** How many times this attempt started over from a fresh noise field. Diagnostics. */
  rebuilds: number;
};

/** What `generate` returns: upstream's `ux, uy, dx, dy, spots`. */
export type CavernResult = {
  readonly up: TileXY | null;
  readonly down: TileXY | null;
  readonly spots: readonly Spot[];
};

/**
 * How many times one attempt may start over before it gives up.
 *
 * UPSTREAM RECURSES WITHOUT LIMIT (`engine/generator/map/Cavern.lua:95`, `:109`),
 * which a table whose `min_floor` its map cannot hold turns into a stack overflow
 * mid-turn. Past this many fresh fields the attempt sets `force_recreate`, and
 * `newLevel` moves on to its next attempt, which is the recovery upstream would
 * have made had the recursion returned. Measured on the orc breeding pits'
 * table, 58% of fields fall short and an attempt starts over 1.45 times on
 * average, 16 at most in 5,000 (`CAVERN_ORC_BREEDING_PIT`, `mapgen/level.ts`):
 * reaching this cap there is a 0.58^200 event.
 */
export const CAVERN_MAX_REBUILDS = 200;

/**
 * How many random cells a stair search tries, per map cell, before it gives up.
 * Upstream loops forever (`engine/generator/map/Cavern.lua:224-231`); see the
 * same cap in `mapgen/roomer.ts`.
 */
const STAIR_TRIES_PER_CELL = 20;

/**
 * `Cavern:init(zone, map, level, data)` (`engine/generator/map/Cavern.lua:28-42`):
 * the defaults, an empty spot list, then `RoomsLoader.init`, which writes the
 * tunnel defaults into the data (`engine/generator/map/RoomsLoader.lua:28-53`).
 *
 * `RoomsGen.data.doorChance` is Roomer's field and nothing in `RoomsLoader`
 * reads it; Cavern's own `door_chance` can be nil, so it lives on the generator
 * as `doorChance` and the data carries 0, which nobody reads.
 */
export function createCavern(
  map: GenMap,
  data: CavernData,
  rng: Rng,
  zone: { readonly maxLevel: number },
  level: { forceRecreate: string | null },
): CavernGen {
  const settings = {
    ...data,
    tunnelChange: data.tunnelChange ?? 30,
    tunnelRandom: data.tunnelRandom ?? 10,
    liteRoomChance: data.liteRoomChance ?? 100,
    doorChance: 0,
  };
  const { rooms, requiredRooms } = roomsLoaderInit(settings);
  // `self.spots = {}`: rooms push their spots onto the level's list.
  map.spots = [];
  return {
    map,
    rng,
    data: settings,
    zone,
    level,
    rooms,
    requiredRooms,
    zoom: data.zoom ?? 12,
    hurst: data.hurst ?? 0.2,
    lacunarity: data.lacunarity ?? 4,
    octave: data.octave ?? 1,
    doorChance: data.doorChance ?? null,
    minFloor: data.minFloor ?? 900,
    noise: data.noise ?? 'simplex',
    rebuilds: 0,
  };
}

/** `noise[name](noise, x, y, octave)`: the octave reaches only an `fbm_` method. */
function sampler(
  noise: Noise2,
  name: CavernNoise,
  octave: number,
): (x: number, y: number) => number {
  switch (name) {
    case 'simplex':
      return noise.simplex;
    case 'perlin':
      return noise.perlin;
    case 'fbm_simplex':
      return (x, y) => noise.fbmSimplex(x, y, octave);
    case 'fbm_perlin':
      return (x, y) => noise.fbmPerlin(x, y, octave);
  }
}

/**
 * `table.shuffle(t)` (`engine/utils.lua:610-617`): from the last element down to
 * the second, swap with a uniform element at or before it. In place, and
 * returns `t`. One `rng.range(1, i)` per step, so a one-element list draws
 * nothing.
 */
export function tableShuffle<T>(rng: Rng, label: string, t: T[]): T[] {
  for (let i = t.length; i >= 2; i -= 1) {
    const j = range(rng, label, 1, i);
    const a = t[i - 1] as T;
    t[i - 1] = t[j - 1] as T;
    t[j - 1] = a;
  }
  return t;
}

/**
 * One pass of `generate`'s fill (`engine/generator/map/Cavern.lua:46-110`): a new
 * noise field, the floor and wall written, every region flooded, and every
 * region but the biggest walled in. False where upstream calls `generate` again:
 * no region, or the biggest below `min_floor` — and then the walls stay unwritten,
 * because the next pass overwrites every cell anyway.
 */
export function fillCavern(gen: CavernGen): boolean {
  const { map, rng } = gen;
  const { w, h } = map;
  const noise = createNoise2(rng, 'mapgen.cavern.noise', gen.hurst, gen.lacunarity);
  const sample = sampler(noise, gen.noise, gen.octave);

  // `opens[i][j]`: the cell's 1-based index into `list`, 0 for none.
  const opens = new Int32Array(w * h);
  const list: TileXY[] = [];
  for (let i = 0; i < w; i += 1) {
    for (let j = 0; j < h; j += 1) {
      // STRICTLY above zero, on 0-based coordinates.
      if (sample((gen.zoom * i) / w, (gen.zoom * j) / h) > 0) {
        map.set(i, j, map.resolve('floor'));
        list.push({ x: i, y: j });
        opens[j * w + i] = list.length;
      } else {
        map.set(i, j, map.resolve('wall'));
      }
    }
  }

  /** `list[k] ~= nil`, by 1-based index. */
  const listed = new Uint8Array(list.length + 1).fill(1);
  listed[0] = 0;

  /**
   * `floodFill(x, y)` (`engine/generator/map/Cavern.lua:63-85`): FIFO, and a cell
   * counts when it is DEQUEUED open, so the queue holds repeats and cells off
   * the map, which are skipped. Neighbours go on in upstream's order: the four
   * sides W, S, E, N, then the corners NE, SE, NW, SW.
   */
  const floodFill = (x: number, y: number): TileXY[] => {
    const q: TileXY[] = [{ x, y }];
    const closed: TileXY[] = [];
    for (let head = 0; head < q.length; head += 1) {
      const n = q[head] as TileXY;
      const k = n.x >= 0 && n.x < w && n.y >= 0 && n.y < h ? (opens[n.y * w + n.x] ?? 0) : 0;
      if (k === 0) continue;
      closed.push(n);
      listed[k] = 0;
      opens[n.y * w + n.x] = 0;
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

  // `while next(list)`: the lowest index still listed — see the file note.
  const groups: TileXY[][] = [];
  for (let cursor = 1; cursor <= list.length; cursor += 1) {
    if (listed[cursor] === 0) continue;
    const l = list[cursor - 1] as TileXY;
    groups.push(floodFill(l.x, l.y));
  }
  if (groups.length === 0) return false;

  tableSort(groups, (a, b) => a.length < b.length);
  const biggest = groups[groups.length - 1] as TileXY[];
  if (biggest.length < gen.minFloor) return false;
  for (let i = 0; i < groups.length - 1; i += 1) {
    for (const jn of groups[i] as TileXY[]) map.set(jn.x, jn.y, map.resolve('wall'));
  }
  return true;
}

function isChanceEntry(
  entry: LoadedRoom,
): entry is { readonly def: RoomDef; readonly chanceRoom: number } {
  return typeof entry === 'object' && 'chanceRoom' in entry;
}

/**
 * The random-room pick (`engine/generator/map/Cavern.lua:136-145`): uniform over
 * `rooms`, re-picked until a chance entry passes its roll. An empty list reads
 * nil after its draw, as `rng.range(1, 0)` does, and `roomAlloc` refuses it.
 */
function pickRoom(gen: CavernGen): RoomDef | null {
  for (;;) {
    const entry = gen.rooms[range(gen.rng, 'mapgen.cavern.room.pick', 1, gen.rooms.length) - 1];
    if (entry === undefined) return null;
    if (!isChanceEntry(entry)) return entry;
    if (percent(gen.rng, 'mapgen.cavern.room.chance', entry.chanceRoom)) return entry.def;
  }
}

/**
 * `Cavern:generate(lev, old_lev)` (`engine/generator/map/Cavern.lua:44-184`).
 *
 * Returns `null` exactly where upstream returns nothing — a required room could
 * not be placed — and where this port stops upstream's endless recursion
 * (`CAVERN_MAX_REBUILDS`, or a `min_floor` the map cannot hold at all).
 * `gen.level.forceRecreate` says which.
 *
 * ═══ THE RESTART IS A LOOP, ON THE SAME RNG ═══
 * Upstream's `return self:generate(lev, old_lev)` makes a new noise object from
 * the level's one generator, so a restart continues the attempt's number stream
 * rather than starting a new attempt. So does this.
 *
 * ═══ NOT PORTED: `make_tunnel` SPOTS (`engine/generator/map/Cavern.lua:150-177`) ═══
 * A room could push a spot asking to be tunnelled to the nearest open cell of a
 * beam or circle round it. No ToME room or zone sets `make_tunnel` or
 * `tunnel_dir` — grep the module — so the block never runs upstream, and `Spot`
 * here has no such field for a room to set. Porting it faithfully would also
 * need `calc_beam` and `calc_circle`'s exact visiting order, which a tie in its
 * distance sort depends on. It is left out rather than ported untested.
 */
export function generate(gen: CavernGen, lev: number, oldLev: number): CavernResult | null {
  const { map, rng } = gen;

  // GUARD: a `min_floor` above the map's area can never be met, and upstream
  // recurses until the stack gives out. Here it is refused before any field is
  // rolled: 201 fields an attempt, fifty attempts, ten rounds of `keepTrying`
  // is 44 seconds of a server doing nothing else (measured, 50x50).
  if (gen.minFloor > map.w * map.h) {
    gen.level.forceRecreate = `Cavern: min_floor ${String(gen.minFloor)} is more than the map's ${String(map.w * map.h)} cells`;
    return null;
  }

  while (!fillCavern(gen)) {
    gen.rebuilds += 1;
    if (gen.rebuilds > CAVERN_MAX_REBUILDS) {
      gen.level.forceRecreate = `Cavern: no region of ${String(gen.minFloor)} cells in ${String(CAVERN_MAX_REBUILDS + 1)} fields`;
      return null;
    }
  }

  let nbRoom = getval(rng, 'mapgen.cavern.nb_rooms', gen.data.nbRooms ?? 0);
  const rooms = map.rooms;

  for (const entry of gen.requiredRooms) {
    let def: RoomDef | null = null;
    let ok = false;
    if (isChanceEntry(entry)) {
      if (percent(rng, 'mapgen.cavern.required.chance', entry.chanceRoom)) {
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

  // "Will not attempt to replace failed random rooms": one try per room.
  while (nbRoom > 0) {
    roomAlloc(gen, pickRoom(gen), rooms.length + 1, lev, oldLev);
    nbRoom -= 1;
  }

  if (gen.doorChance !== null) addDoors(gen, gen.doorChance);

  return makeStairsInside(gen, lev, oldLev, map.spots);
}

/**
 * `Cavern:addDoors()` (`engine/generator/map/Cavern.lua:186-217`).
 *
 * A candidate is any inner cell blocked on both sides of one axis and open on
 * both sides of the other. THE CELL ITSELF IS NOT TESTED, so a wall cell between
 * two walls and two floors qualifies and becomes a door in the rock. The list
 * is shuffled, then taken from the END: each rolls `door_chance`, and a door
 * strikes its four orthogonal neighbours from the list — the first matching
 * entry of each, as `delspot` stops at one.
 *
 * `door_chance = 0` still runs this and draws, because 0 is true in Lua.
 */
export function addDoors(gen: CavernGen, chance: number): void {
  const { map, rng } = gen;
  const possible: { readonly x: number; readonly y: number; readonly dir: '46' | '82' }[] = [];
  for (let i = 1; i <= map.w - 2; i += 1) {
    for (let j = 1; j <= map.h - 2; j += 1) {
      const g4 = map.blockMove(i - 1, j);
      const g6 = map.blockMove(i + 1, j);
      const g2 = map.blockMove(i, j + 1);
      const g8 = map.blockMove(i, j - 1);
      if (g4 && g6 && !g2 && !g8) possible.push({ x: i, y: j, dir: '46' });
      else if (!g4 && !g6 && g2 && g8) possible.push({ x: i, y: j, dir: '82' });
    }
  }

  tableShuffle(rng, 'mapgen.cavern.doors.shuffle', possible);

  const delspot = (x: number, y: number): void => {
    const i = possible.findIndex((d) => d.x === x && d.y === y);
    if (i >= 0) possible.splice(i, 1);
  };

  for (let d = possible.pop(); d !== undefined; d = possible.pop()) {
    if (percent(rng, 'mapgen.cavern.doors.chance', chance)) {
      map.set(d.x, d.y, map.resolve('door'));
      delspot(d.x - 1, d.y);
      delspot(d.x + 1, d.y);
      delspot(d.x, d.y - 1);
      delspot(d.x, d.y + 1);
    }
  }
}

/**
 * One stair inside the level: random cells in `1..w-1` by `1..h-1` until one is
 * neither `block_move` nor `special`; it becomes the key's terrain and
 * `special = "exit"`. The capped form of upstream's `while true`.
 */
function placeStairInside(gen: CavernGen, key: 'up' | 'down'): TileXY | null {
  const { map, rng } = gen;
  const limit = map.w * map.h * STAIR_TRIES_PER_CELL;
  for (let tries = 0; tries < limit; tries += 1) {
    const x = range(rng, `mapgen.cavern.stairs.${key}.x`, 1, map.w - 1);
    const y = range(rng, `mapgen.cavern.stairs.${key}.y`, 1, map.h - 1);
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
 * `Cavern:makeStairsInside(lev, old_lev, spots)` (`engine/generator/map/Cavern.lua:220-246`):
 * the down stair first — only below the zone's last level, unless
 * `force_last_stair` — then the up stair. Unlike Roomer's, it has no forced
 * stair positions to honour.
 */
export function makeStairsInside(
  gen: CavernGen,
  lev: number,
  _oldLev: number,
  spots: readonly Spot[],
): CavernResult {
  let down: TileXY | null = null;
  if (lev < gen.zone.maxLevel || gen.data.forceLastStair === true) {
    down = placeStairInside(gen, 'down');
    if (down === null) return { up: null, down: null, spots };
  }
  return { up: placeStairInside(gen, 'up'), down, spots };
}
