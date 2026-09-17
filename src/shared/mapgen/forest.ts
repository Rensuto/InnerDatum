// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/engines/default/engine/generator/map/Forest.lua:30-541
//   and game/engines/default/engine/Astar.lua:113-193 (the road's route, through shared/path.ts)
//   and game/engines/default/engine/DirectPath.lua:43-56 (the road's fallback)
//   and game/modules/tome/data/zones/trollmire/zone.lua:151-193 (FOREST_TROLLMIRE),
//   game/modules/tome/data/zones/old-forest/zone.lua:23-55 (ROOMER_OLD_FOREST),
//   game/modules/tome/data/zones/golem-graveyard/zone.lua:20-46 (FOREST_GOLEM_GRAVEYARD)
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * FOREST: A NOISE FIELD OF TREES, WITH PONDS, CLEARINGS AND A ROAD THROUGH IT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `engine.generator.map.Forest` is ToME's outdoor level — the Trollmire, the
 * Slazish Fens, the Golem Graveyard. The order is the algorithm, and every
 * step draws from the one level RNG:
 *
 *   1. fill with `floor`
 *   2. one noise field; per cell, ONE percent roll against the field's value
 *      says tree or not, and a floor cell becomes `floor2` above
 *      `sqrt_percent2`, and a "clearing" spot candidate above `sqrt_percent`
 *   3. `nb_spots` clearing spots drawn out of the candidates
 *   4. ponds, each its own noise field cut into water along lines from its
 *      lowest point
 *   5. rooms: the end-of-road room, the required rooms, the random rooms
 *   6. the stairs — on two map edges, or inside
 *   7. the ring of tunnels between rooms
 *   8. the road: up stair, waypoints that make progress, down stair
 *
 * NOTHING HERE GUARANTEES A WAY THROUGH. Trees are walls; the road usually
 * joins the stairs, and `Zone:newLevel` throws away the levels where it does
 * not (`mapgen/level.ts`).
 *
 * ═══ UPSTREAM'S BUGS THAT SHAPE THE OUTPUT, KEPT ═══
 * - `addPond` passes the pond's WIDTH AS HURST and its HEIGHT AS LACUNARITY
 *   (`engine/generator/map/Forest.lua:60`). Hurst is ignored by the noise;
 *   lacunarity 25 makes every octave past the first all but weightless.
 * - `edge_entrances` of 2 or 8 sets `direction` so the end-of-road room must be
 *   NEAR the up stair's edge, not far from it (`:197-205`).
 * - `checkValid` negates `progess`, a typo for `progress`, so on a road running
 *   toward x = 0 or y = 0 almost no waypoint is accepted (`:435`).
 * - The road's `start` and `finish` for edges 2 and 8 are the far edge and the
 *   near one, the reverse of where `makeStairsSides` puts the up stair
 *   (`:325-341` against `:526-529`). With the typo, measured on a 65x40 map:
 *   edge 4 accepts waypoints, edge 6 none, edge 8 only in its first two rows,
 *   and edge 2 NONE AT ALL, whatever the typo does. No ported zone uses 2 or 8.
 * - Every pond is dry at its own lowest point: the lines that cut the water
 *   start there, and a line never yields its start (`mapgen/geom.ts`), so that
 *   one cell is never painted, and smoothing only ever removes water. Measured,
 *   294 ponds of 294, and 149 of those a one-cell island.
 *
 * ═══ WHAT IS NOT UPSTREAM'S, EACH NOTED WHERE IT HAPPENS ═══
 * - The road's A* breaks ties by `shared/path.ts`'s total order; upstream's
 *   depends on Lua hash iteration.
 * - Stair searches are capped; upstream loops forever.
 * - `forced_up`/`forced_down` are not read: only TMX rooms set them
 *   (`engine/generator/map/RoomsLoader.lua:274-283`), and none is ported.
 */

import type { TileXY } from '../coords.ts';
import { DEFAULT_HURST, DEFAULT_LACUNARITY, createNoise2 } from '../noise.ts';
import type { Noise2 } from '../noise.ts';
import { PathHeuristic, findPath } from '../path.ts';
import { TileCode } from '../protocol.ts';
import type { Rng } from '../rng.ts';
import { VAULTS_BY_SHAPE } from '../vaults.ts';
import { passable } from './connectivity.ts';
import type { GenMap, PlacedRoom, Spot } from './genmap.ts';
import { line } from './geom.ts';
import type { ForestMapSpec, LevelSpec, RoomerMapSpec } from './level.ts';
import { chance, getval, mod, percent, range, tableRemove, truthy } from './lua.ts';
import type { RoomerResult } from './roomer.ts';
import { loadRoom, roomAlloc, roomsLoaderInit, tunnel } from './rooms-loader.ts';
import type { EdgeSide, LoadedRoom, RoomDef, RoomerData, RoomsGen } from './rooms-loader.ts';
import { tableSort } from './sort.ts';

/** The `core.noise` method a Forest samples (`engine/generator/map/Forest.lua:34`). */
export type ForestNoise = 'fbm_perlin' | 'perlin' | 'simplex' | 'fbm_simplex';

/** `do_ponds` (`engine/generator/map/Forest.lua:43`, `:49-54`). */
export type ForestPonds = {
  /** `nb = {min, max}`: how many ponds, drawn once. */
  readonly nb: readonly [number, number];
  /** `size = {w, h}`: each pond's noise field, and its placement margin. */
  readonly size: { readonly w: number; readonly h: number };
  /**
   * `pond = {{frac, grid}, ...}`: a cell below `split * frac` becomes that
   * grid, the first entry that matches winning. Upstream names a grid and
   * resolves it with `force`, so no key and no draw is involved; here it is the
   * code itself.
   */
  readonly pond: readonly (readonly [number, TileCode])[];
  /** Default 5. */
  readonly zoom?: number;
  /** Default 5. */
  readonly octave?: number;
};

/**
 * A zone's `generator.map` table for Forest. Absent values take
 * `Forest:init`'s defaults (`engine/generator/map/Forest.lua:30-57`). Grid keys
 * are `floor`, `floor2`, `wall`, `up`, `down`, `road`, and for rooms and
 * tunnels `'.'`, `'#'` and `door`.
 */
export type ForestData = RoomerData & {
  /** Default `'fbm_perlin'`. */
  readonly noise?: ForestNoise;
  /** Default 5. */
  readonly zoom?: number;
  /** Default 80. */
  readonly maxPercent?: number;
  /** Default 30. */
  readonly sqrtPercent?: number;
  /** Unset: no `floor2`. */
  readonly sqrtPercent2?: number;
  /** Passed to the noise and ignored by it. */
  readonly hurst?: number;
  readonly lacunarity?: number;
  /** Default 4. */
  readonly octave?: number;
  /** Default 10. */
  readonly nbSpots?: number;
  readonly doPonds?: ForestPonds;
  /** Requires `edgeEntrances` — upstream indexes it unguarded. */
  readonly addRoad?: boolean;
  /** The road stops at the end room (or its last waypoint) instead of the down stair. */
  readonly endRoad?: boolean;
  /** A room file that must be placed at the far end of the level. */
  readonly endRoadRoom?: string;
  /**
   * The codes whose upstream grid carries `air_level` — the only terrain the
   * road's A* refuses (`engine/generator/map/Forest.lua:394-400`). ToME's
   * `DEEP_WATER` does (`data/general/grids/water.lua:136-140`), trees do not.
   */
  readonly airLevel?: readonly TileCode[];
};

/** `ForestData` once `Forest:init` and `RoomsLoader.init` have written their defaults. */
export type ForestSettings = ForestData & {
  readonly noise: ForestNoise;
  readonly zoom: number;
  readonly maxPercent: number;
  readonly sqrtPercent: number;
  readonly octave: number;
  readonly nbSpots: number;
  readonly addRoad: boolean;
  readonly endRoad: boolean;
  readonly tunnelChange: number;
  readonly tunnelRandom: number;
  readonly doorChance: number;
  readonly liteRoomChance: number;
};

/** The generator instance: a `RoomsGen` whose data is a Forest's. */
export type ForestGen = Omit<RoomsGen, 'data'> & { readonly data: ForestSettings };

/** What `generate` returns: upstream's `ux, uy, dx, dy, spots`. */
export type ForestResult = RoomerResult;

/**
 * How many random cells a stair search tries, per map cell, before it gives up.
 * UPSTREAM LOOPS FOREVER (`engine/generator/map/Forest.lua:467`, `:504`); see
 * `mapgen/roomer.ts`'s cap of the same name, which this matches.
 */
const STAIR_TRIES_PER_CELL = 20;

/** `possible_waypoints`: how many random points a road considers (`engine/generator/map/Forest.lua:316`). */
const ROAD_WAYPOINTS = 30;

/**
 * `Forest:init(zone, map, level, data)` (`engine/generator/map/Forest.lua:30-57`):
 * the defaults written in, then `RoomsLoader.init`'s — `tunnel_change` 30,
 * `tunnel_random` 10 (`engine/generator/map/RoomsLoader.lua:31-32`) — and the
 * room files loaded.
 *
 * `lite_room_chance` is read as `or 100` at placement
 * (`engine/generator/map/RoomsLoader.lua:625`); Forest writes no default of its
 * own, unlike Roomer's 25. `door_chance` is never read: Forest hangs no doors.
 *
 * THROWS for `addRoad` without `edgeEntrances`, a table upstream accepts and
 * then crashes on halfway through generating (`:325`).
 */
export function createForest(
  map: GenMap,
  data: ForestData,
  rng: Rng,
  zone: { readonly maxLevel: number },
  level: { forceRecreate: string | null },
): ForestGen {
  if (data.addRoad === true && data.edgeEntrances === undefined) {
    throw new Error('Forest: add_road needs edge_entrances (upstream indexes it unguarded)');
  }
  const settings: ForestSettings = {
    ...data,
    noise: data.noise ?? 'fbm_perlin',
    zoom: data.zoom ?? 5,
    maxPercent: data.maxPercent ?? 80,
    sqrtPercent: data.sqrtPercent ?? 30,
    octave: data.octave ?? 4,
    nbSpots: data.nbSpots ?? 10,
    addRoad: data.addRoad ?? false,
    endRoad: data.endRoad ?? false,
    tunnelChange: data.tunnelChange ?? 30,
    tunnelRandom: data.tunnelRandom ?? 10,
    doorChance: data.doorChance ?? 0,
    liteRoomChance: data.liteRoomChance ?? 100,
  };
  const { rooms, requiredRooms } = roomsLoaderInit(settings);
  return { map, rng, data: settings, zone, level, rooms, requiredRooms };
}

/** `noise[self.noise](noise, x, y, self.octave)`: plain methods take no octave. */
function sampler(noise: Noise2, method: ForestNoise): (x: number, y: number, o: number) => number {
  switch (method) {
    case 'fbm_perlin':
      return (x, y, o) => noise.fbmPerlin(x, y, o);
    case 'perlin':
      return (x, y) => noise.perlin(x, y);
    case 'simplex':
      return (x, y) => noise.simplex(x, y);
    case 'fbm_simplex':
      return (x, y, o) => noise.fbmSimplex(x, y, o);
  }
}

function isChanceEntry(
  entry: LoadedRoom,
): entry is { readonly def: RoomDef; readonly chanceRoom: number } {
  return typeof entry === 'object' && 'chanceRoom' in entry;
}

/**
 * The random-room pick (`engine/generator/map/Forest.lua:254-261`): uniform,
 * re-picked until a chance entry passes its roll. An empty list draws once and
 * yields nothing, which `roomAlloc` records as a failure.
 */
function pickRoom(gen: ForestGen): RoomDef | null {
  for (;;) {
    const entry = gen.rooms[range(gen.rng, 'mapgen.forest.room.pick', 1, gen.rooms.length) - 1];
    if (entry === undefined) return null;
    if (!isChanceEntry(entry)) return entry;
    if (percent(gen.rng, 'mapgen.forest.room.chance', entry.chanceRoom)) return entry.def;
  }
}

/**
 * `Forest:generate(lev, old_lev)` (`engine/generator/map/Forest.lua:140-387`).
 *
 * Returns `null` where upstream returns nothing — the end room or a required
 * room could not be placed — and where a capped stair search gave up; either
 * way `gen.level.forceRecreate` says why.
 */
export function generate(gen: ForestGen, lev: number, oldLev: number): ForestResult | null {
  const { map, rng, data } = gen;

  for (let i = 0; i < map.w; i += 1) {
    for (let j = 0; j < map.h; j += 1) map.set(i, j, map.resolve('floor'));
  }

  // `core.noise.new(2, self.hurst, self.lacunarity)`: nil is libtcod's default.
  const possibleSpots: Spot[] = [];
  const noise = createNoise2(
    rng,
    'mapgen.forest.noise',
    data.hurst ?? DEFAULT_HURST,
    data.lacunarity ?? DEFAULT_LACUNARITY,
  );
  const sample = sampler(noise, data.noise);
  // 1-BASED noise coordinates: column i samples zoom*i/w, so the field is
  // shifted one cell from the map it paints (`engine/generator/map/Forest.lua:148-152`).
  for (let i = 1; i <= map.w; i += 1) {
    for (let j = 1; j <= map.h; j += 1) {
      const v = Math.floor(
        (sample((data.zoom * i) / map.w, (data.zoom * j) / map.h, data.octave) / 2 + 0.5) *
          data.maxPercent,
      );
      // EXACTLY ONE ROLL: `(v >= sp and rng.percent(v)) or (v < sp and
      // rng.percent(math.sqrt(v)))` — the second clause is false without a roll
      // whenever the first was taken. `percent` truncates the root.
      const tree =
        v >= data.sqrtPercent
          ? percent(rng, 'mapgen.forest.tree', v)
          : percent(rng, 'mapgen.forest.tree', Math.sqrt(v));
      if (tree) {
        map.set(i - 1, j - 1, map.resolve('wall'));
      } else {
        // The floor is resolved AGAIN here, so a function floor draws twice for
        // an open cell: once in the fill, once now.
        const floor2 = truthy(data.sqrtPercent2) && v >= (data.sqrtPercent2 ?? 0);
        map.set(i - 1, j - 1, map.resolve(floor2 ? 'floor2' : 'floor'));
        if (v >= data.sqrtPercent) {
          possibleSpots.push({ x: i - 1, y: j - 1, type: 'clearing', subtype: 'clearing' });
        }
      }
    }
  }

  const spots: Spot[] = [];
  map.spots = spots;

  // `nb_spots` draws out of the candidates; an empty list still draws.
  for (let i = 1; i <= data.nbSpots; i += 1) {
    const s = tableRemove(rng, 'mapgen.forest.spots', possibleSpots);
    if (s !== undefined) spots.push(s);
  }

  if (data.doPonds !== undefined) {
    const ponds = data.doPonds;
    // The loop limit is drawn once; each pond draws x, then y.
    const nb = range(rng, 'mapgen.forest.ponds.nb', ponds.nb[0], ponds.nb[1]);
    for (let i = 1; i <= nb; i += 1) {
      const px = range(rng, 'mapgen.forest.ponds.x', ponds.size.w, map.w - ponds.size.w);
      const py = range(rng, 'mapgen.forest.ponds.y', ponds.size.h, map.h - ponds.size.h);
      addPond(gen, px, py, spots);
    }
  }

  let nbRoom = getval(rng, 'mapgen.forest.nb_rooms', data.nbRooms ?? 0);
  const rooms = map.rooms;
  let endRoom: PlacedRoom | null = null;

  // THE DIRECTION BUG, KEPT (`engine/generator/map/Forest.lua:197-205`): for an
  // up stair on edge 2 (the bottom) `direction` is +1, which asks for the end
  // room at the bottom too, beside it; for edge 8 (the top) it is -1 and asks
  // for the top. Edges 4 and 6 point away from the up stair, as meant.
  let axis: 'x' | 'y' = 'x';
  let direction = 1;
  if (data.edgeEntrances !== undefined) {
    const up = data.edgeEntrances[0];
    axis = up === 2 || up === 8 ? 'y' : 'x';
    direction = up === 2 || up === 4 ? 1 : -1;
  }

  if (data.endRoadRoom !== undefined) {
    const r = roomAlloc(
      gen,
      loadRoom(data.endRoadRoom),
      rooms.length + 1,
      lev,
      oldLev,
      // "must be at least 66% into the level", judged on the room's top-left.
      (_room, x, y) => {
        if (axis === 'x' && direction === 1) return x >= map.w * 0.66;
        if (axis === 'x' && direction === -1) return x <= map.w * 0.33;
        if (axis === 'y' && direction === 1) return y >= map.h * 0.66;
        return y <= map.h * 0.33;
      },
    );
    if (r === null) {
      gen.level.forceRecreate = `end_room ${data.endRoadRoom}`;
      return null;
    }
    endRoom = r;
  }

  for (const entry of gen.requiredRooms) {
    let def: RoomDef | null = null;
    let ok = false;
    if (isChanceEntry(entry)) {
      if (percent(rng, 'mapgen.forest.required.chance', entry.chanceRoom)) {
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

  // A FLOAT, counted down by one while positive: ceil(nb_room * 1.5) attempts
  // (`engine/generator/map/Forest.lua:251-266`).
  for (let tries = nbRoom * 1.5; tries > 0 && nbRoom > 0; tries -= 1) {
    if (roomAlloc(gen, pickRoom(gen), rooms.length + 1, lev, oldLev) !== null) nbRoom -= 1;
  }

  // The stairs come BEFORE the tunnels and the road, so both route around them.
  const stairs =
    data.edgeEntrances !== undefined
      ? makeStairsSides(gen, lev, oldLev, data.edgeEntrances, spots)
      : makeStairsInside(gen, lev, oldLev, spots);
  const { up, down } = stairs;
  if (up === null || gen.level.forceRecreate !== null) return null;

  if (data.noTunnels !== true) chainTunnels(gen, rooms);

  if (data.addRoad) addRoad(gen, up, down, axis, endRoom);

  return { up, down, spots };
}

/**
 * The room ring (`engine/generator/map/Forest.lua:278-296`), identical to
 * Roomer's: each tunnelable room to the next, 1-based with wrap, the tunnel
 * carrying the DESTINATION's id. The loop closes only if room 1 can be
 * tunnelled to.
 */
function chainTunnels(gen: ForestGen, rooms: readonly PlacedRoom[]): void {
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

/**
 * The road's waypoints (`engine/generator/map/Forest.lua:307-375`): the up
 * stair, then thirty random points sorted from the up edge toward the down edge
 * and taken in that order when `checkValid` says each makes progress on the
 * last one taken, then the down stair — or, for an ending road, the end room's
 * top-left.
 *
 * A candidate on a `special` or `border` cell is refused whatever `checkValid`
 * says. `start`/`finish` are the up and down edges' coordinates on the axis,
 * except that an ending road finishes at the end room.
 *
 * The sort is Lua's unstable one (`mapgen/sort.ts`), so two candidates in the
 * same column are judged in its order, and which of them is taken can change.
 */
export function roadWaypoints(
  gen: ForestGen,
  up: TileXY,
  down: TileXY | null,
  axis: 'x' | 'y',
  endRoom: PlacedRoom | null,
): TileXY[] {
  const { map, rng, data } = gen;
  const waypoints: TileXY[] = [{ x: up.x, y: up.y }];
  const edges = data.edgeEntrances;
  if (edges === undefined) return waypoints; // `createForest` refuses this table.
  const ending = data.endRoad;

  // x drawn before y, point by point.
  const candidates: TileXY[] = [];
  for (let i = 1; i <= ROAD_WAYPOINTS; i += 1) {
    const x = range(rng, 'mapgen.forest.road.x', 0, map.w - 1);
    const y = range(rng, 'mapgen.forest.road.y', 0, map.h - 1);
    candidates.push({ x, y });
  }

  let start = 0;
  let finish = 0;
  switch (edges[0]) {
    case 2:
      start = 0;
      finish = map.h;
      tableSort(candidates, (a, b) => b.y > a.y);
      break;
    case 4:
      start = 0;
      finish = map.w;
      tableSort(candidates, (a, b) => b.x > a.x);
      break;
    case 6:
      start = map.w;
      finish = 0;
      tableSort(candidates, (a, b) => b.x < a.x);
      break;
    case 8:
      start = map.h;
      finish = 0;
      tableSort(candidates, (a, b) => b.y < a.y);
      break;
  }

  if (ending && endRoom !== null) finish = axis === 'x' ? endRoom.x : endRoom.y;

  for (const s of candidates) {
    const last = waypoints[waypoints.length - 1] ?? up;
    const reason = checkValid(s, last, axis, start, finish);
    const cell = map.cell(s.x, s.y);
    if (!(truthy(cell.special) || truthy(cell.border)) && reason === true) {
      waypoints.push({ x: s.x, y: s.y });
    }
  }

  if (down !== null && !ending) waypoints.push({ x: down.x, y: down.y });
  if (ending && data.endRoadRoom !== undefined && endRoom !== null) {
    waypoints.push({ x: endRoom.x, y: endRoom.y });
  }
  return waypoints;
}

/**
 * The road (`engine/generator/map/Forest.lua:300-384`): its waypoints joined
 * leg by leg with `makeRoad`.
 */
function addRoad(
  gen: ForestGen,
  up: TileXY,
  down: TileXY | null,
  axis: 'x' | 'y',
  endRoom: PlacedRoom | null,
): void {
  const waypoints = roadWaypoints(gen, up, down, axis, endRoom);
  for (let i = 1; i < waypoints.length; i += 1) {
    const from = waypoints[i - 1];
    const to = waypoints[i];
    if (from !== undefined && to !== undefined) makeRoad(gen, from.x, from.y, to.x, to.y, 'road');
  }
}

/**
 * `Forest:makeRoad(x1, y1, x2, y2, id, terrain)` (`engine/generator/map/Forest.lua:389-414`):
 * a 4-way route, painted with `terrain` wherever the cell is not `special`.
 *
 * ═══ THE ROUTE IGNORES TREES ═══
 * Upstream's A* runs with `use_has_seen = true` on a map nobody has seen, and
 * `(use_has_seen and not has_seens(x, y)) or not block_move` is true for every
 * cell (`engine/Astar.lua:150`, `:156`), so the only refusal left is the
 * `add_check`: terrain with `air_level`. The road cuts straight through forest
 * and goes round deep water.
 *
 * ═══ ITS TIES ARE OURS ═══
 * `shared/path.ts` with `allowDiagonals: false` and the CloserPath heuristic
 * computes upstream's `f` scores exactly — upstream calls the heuristic with its
 * target and current cell swapped (`engine/Astar.lua:166`), and the tie-break
 * term is twice the triangle's area either way. Among equal `f`, upstream takes
 * the first in `next(open)` order, which is LuaJIT hash order over integer keys;
 * path.ts takes lowest `h`, then row-major. Same lengths, possibly other cells.
 *
 * ═══ NO ROUTE: A STRAIGHT LINE UNTIL SOMETHING BLOCKS ═══
 * `DirectPath:calc` (`engine/DirectPath.lua:43-56`) walks `line.new` and stops
 * at the first cell off the map or one that blocks a body that opens doors.
 * Upstream's "from == to" returns nil from the A* and nothing from the line;
 * here it is an empty route. Either way nothing is painted.
 *
 * AIR-LEVEL TERRAIN DOES NOT STOP THE LINE, though it stops a body here: ToME's
 * DEEP_WATER has `air_level` and no `block_move` (`data/general/grids/water.lua:136-140`),
 * so upstream's line runs on across a pond, painting nothing on its `special`
 * cells, and paints road beyond it up to the first tree. The codes in
 * `airLevel` are read as that walkable water here too.
 */
export function makeRoad(
  gen: ForestGen,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  terrain: string,
): void {
  const { map } = gen;
  const airLevel = new Set<number>(gen.data.airLevel ?? []);
  const open = (x: number, y: number): boolean => {
    if (!map.isBound(x, y)) return false;
    const code = map.get(x, y);
    return code === null || !airLevel.has(code);
  };
  let path = findPath({ x: x1, y: y1 }, { x: x2, y: y2 }, open, {
    allowDiagonals: false,
    heuristic: PathHeuristic.CloserPath,
    maxNodes: map.w * map.h,
  });
  if (path === null) {
    path = [];
    for (const c of line(x1, y1, x2, y2)) {
      const code = map.isBound(c.x, c.y) ? map.get(c.x, c.y) : null;
      const blocks = code !== null && !passable(code) && !airLevel.has(code);
      if (!map.isBound(c.x, c.y) || blocks) break;
      path.push(c);
    }
  }
  for (const node of path) {
    if (!truthy(map.cell(node.x, node.y).special)) map.set(node.x, node.y, map.resolve(terrain));
  }
}

/**
 * `Forest:checkValid(spot, lastspot, axis, start, finish)`
 * (`engine/generator/map/Forest.lua:416-457`): `true`, or why not.
 *
 * A waypoint must be more than 2 past the last one on the axis, more than 4
 * short of the finish, and within a fifth of the level's length of it on the
 * other axis.
 *
 * ═══ THE `progess` TYPO, KEPT ═══
 * When the road runs toward 0 (`finish < start`), upstream flips the sign of
 * the measure, the finish and the minimum distance — and writes the flipped
 * PROGRESS into a new global, `progess`. `progress` keeps its sign, so the test
 * becomes `-x > last - 2`: true only when `x + last < 2`. A road on edge 6
 * takes none and one on edge 8 takes them only from its first two rows, so both
 * run nearly straight to the stair. Edge 2 takes none either, for the other
 * reason in the file note: its `start` is the top edge and its up stair is on
 * the bottom one.
 */
export function checkValid(
  spot: TileXY,
  lastspot: TileXY,
  axis: 'x' | 'y',
  start: number,
  finish: number,
): true | string {
  let mindistance = 2;
  const progress = axis === 'x' ? lastspot.x : lastspot.y;
  let measure = axis === 'x' ? spot.x : spot.y;
  const invertMeasure = axis === 'x' ? spot.y : spot.x;
  const invertProgress = axis === 'x' ? lastspot.y : lastspot.x;
  let end = finish;

  if (end < start) {
    // `progess = progress * -1` — nothing reads `progess`.
    measure = -measure;
    end = -end;
    mindistance = -mindistance;
  }

  if (!(measure > progress + mindistance)) return 'not enough progress from previous waypoint';
  if (!(measure < end - mindistance * 2)) return 'measure too close to finish';
  if (!(Math.abs(invertProgress - invertMeasure) < Math.abs(start - end) * 0.2)) {
    return 'on non-progress axis, the measure was more than 20% different from previous';
  }
  return true;
}

/**
 * `Forest:addPond(x, y, spots)` (`engine/generator/map/Forest.lua:59-138`): a
 * `size.w` by `size.h` pond with its top-left at `(x, y)`.
 *
 * 1. A NEW noise field — `core.noise.new(2, size.w, size.h)`, the size in the
 *    hurst and lacunarity slots (the bug) — sampled with `fbm_simplex` at
 *    1-based `zoom*i/size.w`; the strictly-lowest sample is remembered.
 * 2. For every cell of the pond's border, in upstream's order (each column's
 *    top then bottom, then each row's left then right): walk `line.new` from
 *    the lowest point to it, find the highest sample on the way, and set
 *    `split = highest + lowest` (not halved). Walk the line again, painting each
 *    cell below `split * frac` with the first pond entry that matches, and stop
 *    at the first cell no entry matches.
 * 3. Drop every painted cell with fewer than four painted neighbours, IN PLACE:
 *    a cell dropped early counts as unpainted for the cells after it.
 * 4. Paint the survivors onto the map, `force`-resolved with no draw, and mark
 *    each in-bounds one `special = 'pond'`, which keeps stairs, the road and
 *    road waypoints off it. Cells past the map's edge are skipped.
 * 5. A `pond` spot at the TOP-LEFT corner, not the centre.
 *
 * With Trollmire's 25x25 ponds on a 40-high level, `range(25, 15)` swaps to
 * `range(15, 25)`, so a pond can hang up to ten rows off the bottom edge.
 */
export function addPond(gen: ForestGen, x: number, y: number, spots: Spot[]): void {
  const { map, rng, data } = gen;
  const ponds = data.doPonds;
  if (ponds === undefined) return;
  const sw = ponds.size.w;
  const sh = ponds.size.h;
  const zoom = ponds.zoom ?? 5;
  const octave = ponds.octave ?? 5;
  const index = (i: number, j: number): number => (j - 1) * sw + (i - 1);
  const inside = (i: number, j: number): boolean => i >= 1 && i <= sw && j >= 1 && j <= sh;

  // THE BUG: width as hurst, height as lacunarity (`engine/generator/map/Forest.lua:60`).
  const noise = createNoise2(rng, 'mapgen.forest.pond.noise', sw, sh);
  const nmap = new Float64Array(sw * sh);
  const pmap: (TileCode | null)[] = Array.from({ length: sw * sh }, () => null);
  let lowest = { v: 100, x: 0, y: 0 };
  for (let i = 1; i <= sw; i += 1) {
    for (let j = 1; j <= sh; j += 1) {
      const v = noise.fbmSimplex((zoom * i) / sw, (zoom * j) / sh, octave);
      nmap[index(i, j)] = v;
      if (v < lowest.v) lowest = { v, x: i, y: j };
    }
  }
  // GUARD: fbm is clamped to +-0.99999, so some sample is under 100 and
  // `lowest` is set; upstream would index `line.new(nil, ...)` otherwise.
  if (lowest.x === 0) return;
  const low = lowest;

  const quadrant = (i: number, j: number): void => {
    let highest = -100;
    for (const c of line(low.x, low.y, i, j)) {
      const v = inside(c.x, c.y) ? (nmap[index(c.x, c.y)] ?? 0) : null;
      if (v !== null && v > highest) highest = v;
    }
    const split = highest + low.v;
    for (const c of line(low.x, low.y, i, j)) {
      let stop = true;
      for (const [frac, grid] of ponds.pond) {
        if (inside(c.x, c.y) && (nmap[index(c.x, c.y)] ?? 0) < split * frac) {
          pmap[index(c.x, c.y)] = grid;
          stop = false;
          break;
        }
      }
      if (stop) break;
    }
  };
  for (let i = 1; i <= sw; i += 1) {
    quadrant(i, 1);
    quadrant(i, sh);
  }
  for (let i = 1; i <= sh; i += 1) {
    quadrant(1, i);
    quadrant(sw, i);
  }

  // "Smooth the pond", in place.
  const set = (i: number, j: number): number =>
    inside(i, j) && pmap[index(i, j)] !== null ? 1 : 0;
  for (let i = 1; i <= sw; i += 1) {
    for (let j = 1; j <= sh; j += 1) {
      const nb =
        set(i - 1, j + 1) +
        set(i, j + 1) +
        set(i + 1, j + 1) +
        set(i - 1, j) +
        set(i + 1, j) +
        set(i - 1, j - 1) +
        set(i, j - 1) +
        set(i + 1, j - 1);
      if (nb < 4) pmap[index(i, j)] = null;
    }
  }

  for (let i = 1; i <= sw; i += 1) {
    for (let j = 1; j <= sh; j += 1) {
      const grid = pmap[index(i, j)] ?? null;
      if (grid === null) continue;
      map.set(i - 1 + x, j - 1 + y, grid);
      if (map.isBound(i - 1 + x, j - 1 + y)) map.cell(i - 1 + x, j - 1 + y).special = 'pond';
    }
  }

  spots.push({ x, y, type: 'pond', subtype: 'pond' });
}

/**
 * `Forest:makeStairsInside(lev, old_lev, spots)` (`engine/generator/map/Forest.lua:460-494`):
 * the down stair first — below the zone's last level, or with
 * `force_last_stair` — then the up stair, each on a random cell in
 * `1..w-1` by `1..h-1` (x drawn first) that neither blocks movement nor is
 * `special`, which becomes the key's terrain and `special = 'exit'`.
 */
export function makeStairsInside(
  gen: ForestGen,
  lev: number,
  _oldLev: number,
  spots: readonly Spot[],
): ForestResult {
  const place = (key: 'up' | 'down'): TileXY | null => {
    const { map, rng } = gen;
    const limit = map.w * map.h * STAIR_TRIES_PER_CELL;
    for (let tries = 0; tries < limit; tries += 1) {
      const x = range(rng, `mapgen.forest.stairs.${key}.x`, 1, map.w - 1);
      const y = range(rng, `mapgen.forest.stairs.${key}.y`, 1, map.h - 1);
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
 * `Forest:makeStairsSides(lev, old_lev, sides, spots)` (`engine/generator/map/Forest.lua:497-541`):
 * `sides` is `{up_side, down_side}`; down first, then up, each on a random cell
 * of its edge — `0..len-1`, corners included, unlike Roomer's `1..len-1` —
 * that is not `special`.
 *
 * NO `block_move` TEST AND NO TUNNEL, unlike Roomer's: the stair is set on a
 * tree as readily as on grass, and only the road joins it to anything.
 */
export function makeStairsSides(
  gen: ForestGen,
  lev: number,
  _oldLev: number,
  sides: readonly [EdgeSide, EdgeSide],
  spots: readonly Spot[],
): ForestResult {
  const place = (side: EdgeSide, key: 'up' | 'down'): TileXY | null => {
    const { map, rng } = gen;
    const label = `mapgen.forest.stairs.${key}.side`;
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
// PLACEHOLDER TERRAIN. ToME's grass, flowers, trees, dirt road and deep water
// have no codes of their own yet (themed codes are a later phase), so each
// grid name maps to the nearest existing code:
//
//   GRASS -> GREEN      FLOWER -> HEATH      TREE -> TREES
//   GRASS_ROAD_DIRT -> YARD                  DEEP_WATER -> DEEPWATER
//   GRASS_UP4 / GRASS_DOWN6 -> GREEN (a stair is a SITES marker on floor)
//
// DEEPWATER IS SOLID HERE, and ToME's DEEP_WATER is walkable water you can
// drown in (`data/general/grids/water.lua:136-140`; research/terrain.md C.2).
// A pond therefore walls ground off where upstream's only makes it dangerous,
// and `newLevel` refuses more levels than upstream would.
//
// THE VAULT POOL is `shared/vaults.ts`'s ruin rooms: the zones list their own
// forest vaults (`forest-ruined-building1..3`, `honey_glade`, ...), which are
// not drawn here.

/** Trollmire's `floor`: `rng.chance(20)` FLOWER, else GRASS — a draw on every resolve. */
function trollmireFloor(rng: Rng): TileCode {
  return chance(rng, 'mapgen.resolve.floor', 20) ? TileCode.HEATH : TileCode.GREEN;
}

/** The ruin rooms, standing in for the forest vault lists. */
const FOREST_VAULTS: readonly string[] = (VAULTS_BY_SHAPE['ruin'] ?? []).map((v) => v.id);

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE TROLLMIRE, DEFAULT LAYOUT — ToME's first forest
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `data/zones/trollmire/zone.lua:151-193`: 65x40, entered on the left edge
 * and left by the right, zoom 4 and `sqrt_percent` 30 on 4-octave Perlin, up to
 * two 25x25 ponds of deep water, a dirt road from stair to stair, and
 * `nb_rooms = {0,0,0,1}` — one lesser vault on a quarter of levels, lit.
 * `max_level` is 3; the third level's `end_road_room` ("zones/prox") is not
 * ported, so this is the table for every floor.
 *
 * THREE ADDITIONS, all about where this runs:
 * - `'.'` and `'#'`: upstream's table has neither. Our `lesser_vault` builds
 *   its apron and drawing from them (upstream's vault maps name their own
 *   grids), and tunnels fall back through `'.'` before `floor` — so `'.'` IS
 *   the floor function, and a tunnel cell draws exactly as upstream's does.
 * - `airLevel`: DEEP_WATER's `air_level`, which the road's A* refuses.
 * - `forceLastStair`, as for Kor'Pul: the realm decides whether a floor below
 *   exists.
 *
 * `all_lited = true` (`data/zones/trollmire/zone.lua:162`) is a zone field, not
 * a generator one, and `LevelSpec` has nowhere to hold it: the zone that builds
 * this table says so (`ZoneLevel.lighting`, `mapgen/zones.ts`), or the forest
 * is as dark as a cave.
 */
export const FOREST_TROLLMIRE: LevelSpec<ForestMapSpec> = {
  width: 65,
  height: 40,
  map: {
    class: 'Forest',
    edgeEntrances: [4, 6],
    zoom: 4,
    sqrtPercent: 30,
    noise: 'fbm_perlin',
    addRoad: true,
    doPonds: {
      nb: [0, 2],
      size: { w: 25, h: 25 },
      pond: [
        [0.6, TileCode.DEEPWATER],
        [0.8, TileCode.DEEPWATER],
      ],
    },
    airLevel: [TileCode.DEEPWATER],
    nbRooms: [0, 0, 0, 1],
    rooms: ['lesser_vault'],
    lesserVaultsList: FOREST_VAULTS,
    liteRoomChance: 100,
    forceLastStair: true,
    grid: {
      floor: trollmireFloor,
      wall: TileCode.TREES,
      up: TileCode.GREEN,
      down: TileCode.GREEN,
      door: TileCode.GREEN,
      road: TileCode.YARD,
      '.': trollmireFloor,
      '#': TileCode.TREES,
    },
  },
};

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE OLD FOREST — a Roomer of clearings in solid trees
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `data/zones/old-forest/zone.lua:23-55`: 50x50, eleven rooms drawn from
 * `forest_clearing` and an 8-weighted `lesser_vault`, a 5% pit chance per
 * clearing, stairs on the left and right edges tunnelled to a random room,
 * and `door = "GRASS"`. That key is NEVER USED: a tunnel records a door only
 * where it crosses a cell with `can_open` (`engine/generator/map/RoomsLoader.lua:868-877`),
 * a clearing's walls never get one (the line that would set it is commented
 * out, `rooms/forest_clearing.lua:102`), and a lesser vault is walked through,
 * not carved. Measured, 200 levels hung no door, as upstream's hang none.
 * Roomer's own defaults otherwise (`lite_room_chance` 25). `max_level` is 4;
 * the fourth level's `{4,2}` edges are `mapgen/zones.ts`'s, and its lake exit
 * is a stair marker there.
 *
 * `all_lited = true` (`data/zones/old-forest/zone.lua:32`) is a zone field, not
 * a generator one, and `LevelSpec` has nowhere to hold it: the zone that builds
 * this table says so (`ZoneLevel.lighting`, `mapgen/zones.ts`), or the wood is
 * as dark as a cave.
 *
 * `forceLastStair` as for Kor'Pul.
 */
export const ROOMER_OLD_FOREST: LevelSpec<RoomerMapSpec> = {
  width: 50,
  height: 50,
  map: {
    class: 'Roomer',
    nbRooms: 11,
    edgeEntrances: [4, 6],
    rooms: ['forest_clearing', ['lesser_vault', 8]],
    roomsConfig: {
      forestClearing: {
        pitChance: 5,
        filters: [
          { type: 'insect', subtype: 'ant' },
          { type: 'insect' },
          { type: 'animal', subtype: 'snake' },
          { type: 'animal', subtype: 'canine' },
        ],
      },
    },
    lesserVaultsList: FOREST_VAULTS,
    forceLastStair: true,
    grid: {
      '.': TileCode.GREEN,
      '#': TileCode.TREES,
      up: TileCode.GREEN,
      down: TileCode.GREEN,
      door: TileCode.GREEN,
    },
  },
};

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE GOLEM GRAVEYARD — a small, open wood
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `data/zones/golem-graveyard/zone.lua:20-46`: 30x30, one level, edges left and
 * right, zoom 4 with `sqrt_percent` 70 — so most cells take the square-root roll
 * and the wood is thin — the Trollmire's grass-and-flower floor, no road, no
 * ponds, no rooms. Its `post_process` (the broken Atamathon and its
 * connectivity spot, `:56-73`) is content, and not ported.
 *
 * `forceLastStair`: upstream's single level has no down stair at all.
 *
 * `all_lited = true` (`data/zones/golem-graveyard/zone.lua:29`) is a zone field,
 * not a generator one: a zone that builds this table must say so
 * (`ZoneLevel.lighting`, `mapgen/zones.ts`), as the Trollmire's does.
 */
export const FOREST_GOLEM_GRAVEYARD: LevelSpec = {
  width: 30,
  height: 30,
  map: {
    class: 'Forest',
    edgeEntrances: [4, 6],
    zoom: 4,
    sqrtPercent: 70,
    noise: 'fbm_perlin',
    forceLastStair: true,
    grid: {
      floor: trollmireFloor,
      wall: TileCode.TREES,
      up: TileCode.GREEN,
      down: TileCode.GREEN,
    },
  },
};
