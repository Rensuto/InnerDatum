// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/engines/default/engine/generator/map/Octopus.lua:28-109
//   and game/engines/default/engine/generator/map/Roomer.lua:28-39 (the defaults Octopus inherits)
//   and game/modules/tome/data/zones/heart-gloom/zone.lua:23-73 (OCTOPUS_HEART_GLOOM)
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * OCTOPUS: ONE BIG ROUND CAVE, AND ARMS OF SMALLER ONES AROUND IT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ToME's Heart of the Gloom, the middle level of the Sludgenest, and the
 * Infinite Dungeon's "subsided area". The whole algorithm:
 *
 *   1. fill the map with `'#'`
 *   2. a NEW room list replaces the map's; a pod (`makePod`,
 *      `mapgen/rooms-loader.ts`) at the map's centre, its radius
 *      `main_radius` of the mean half-side
 *   3. `nb_rooms` arms at equal angles round the centre, each a pod
 *      `arms_range` of the way to the edge, each tunnelled straight back to
 *      the centre with the Roomer tunnel
 *   4. the stairs: on two map edges, each tunnelled to a random pod (Roomer's
 *      `makeStairsSides`), or inside on any open cell (Octopus's own)
 *
 * ═══ WHAT JOINS IT UP IS THE TUNNELS ═══
 * A pod is joined to its own centre by construction — every cell is on an
 * unbroken line from it, and the spur prune that could cut one does not run on
 * a fractional radius (`makePod`). Each arm's tunnel starts on its centre and
 * walks through any pod on the way without carving it. So the level is one
 * piece whenever every arm's tunnel reaches the centre within its 2,000 steps.
 * When one does not, `Zone:newLevel`'s check (`mapgen/level.ts`) refuses the
 * level only if that cuts a stair off: it asks whether up reaches down, and a
 * pod's spot asks for nothing.
 *
 * ═══ NOTHING HERE IS LIT, AND NO DOOR IS HUNG ═══
 * `Roomer:init` defaults `lite_room_chance` to 25 and `door_chance` to 50, and
 * Octopus reads neither: a pod rolls no light and no tunnel it digs meets a
 * `can_open` cell. Light is the zone's `all_lited`.
 *
 * ═══ WHAT IS NOT UPSTREAM'S, EACH NOTED WHERE IT HAPPENS ═══
 * - A pod's id is a negative number where upstream's is a string
 *   (`podRoomId`, `mapgen/rooms-loader.ts`) — the same tunnel either way.
 * - Stair searches are capped; upstream loops forever.
 * - `math.cos` and `math.sin` are the C library's upstream and V8's here, and
 *   two libraries may disagree in the last bit. That moves an arm only when
 *   `floor` sees its centre land exactly on a whole cell, a zero-width target
 *   for a `rng.float` range.
 */

import type { TileXY } from '../coords.ts';
import { TileCode } from '../protocol.ts';
import type { Rng } from '../rng.ts';
import type { GenMap, Spot } from './genmap.ts';
import type { LevelSpec } from './level.ts';
import { float, range, truthy } from './lua.ts';
import { makeStairsSides } from './roomer.ts';
import type { RoomerResult } from './roomer.ts';
import { makePod, roomsLoaderInit, tunnel } from './rooms-loader.ts';
import type { PodData, PodNoise, RoomerData, RoomsGen } from './rooms-loader.ts';

/**
 * A zone's `generator.map` table for Octopus. Absent values take the defaults
 * `Octopus:init` writes (`engine/generator/map/Octopus.lua:33-43`), then
 * Roomer's (`engine/generator/map/Roomer.lua:31-34`). Grid keys are `'#'`,
 * `'.'`, `up`, `down`, and `'='` for tunnels if the zone has one.
 *
 * `rooms` is loaded, as `RoomsLoader.init` loads it, and never placed.
 */
export type OctopusData = Omit<RoomerData, 'nbRooms'> & {
  /**
   * `nb_rooms = {min, max}`: how many arms, drawn once with `rng.range`. A RANGE
   * here, where Roomer's `nb_rooms` is `util.getval`'d. Default `{5, 10}`.
   */
  readonly nbRooms?: readonly [number, number];
  /** The fraction of a pod's radius every line reaches. Default 0.4. */
  readonly baseBreakpoint?: number;
  /** How far out an arm stands, as a fraction of the half-width and half-height. Default `{0.5, 0.7}`. */
  readonly armsRange?: readonly [number, number];
  /** An arm pod's radius, as a fraction of the mean half-side. Default `{0.2, 0.3}`. */
  readonly armsRadius?: readonly [number, number];
  /** The centre pod's radius, the same way. Default `{0.3, 0.5}`. */
  readonly mainRadius?: readonly [number, number];
  /** Default `'fbm_perlin'`. */
  readonly noise?: PodNoise;
  /** Default 5. */
  readonly zoom?: number;
  /** Passed to the noise, which ignores it. Default nil. */
  readonly hurst?: number;
  /** Default nil: libtcod's 2. */
  readonly lacunarity?: number;
  /** Default 4. */
  readonly octave?: number;
};

/** `OctopusData` once `Roomer:init` has written its defaults in. */
export type OctopusSettings = OctopusData & {
  readonly tunnelChange: number;
  readonly tunnelRandom: number;
  readonly doorChance: number;
  readonly liteRoomChance: number;
};

/**
 * The generator instance: `RoomsLoader`'s `self` plus Octopus's own fields —
 * which are exactly what `makePod` reads, because Octopus hands it `self` as
 * its `data`.
 */
export type OctopusGen = Omit<RoomsGen, 'data'> &
  PodData & {
    readonly data: OctopusSettings;
    readonly nbRooms: readonly [number, number];
    readonly armsRange: readonly [number, number];
    readonly armsRadius: readonly [number, number];
    readonly mainRadius: readonly [number, number];
  };

/** What `generate` returns: upstream's `ux, uy, dx, dy, spots`. */
export type OctopusResult = RoomerResult;

/** A `generator.map` table naming `engine.generator.map.Octopus`. */
export type OctopusMapSpec = { readonly class: 'Octopus' } & OctopusData;

/** The part of a zone table an Octopus level is built from. */
export type OctopusLevelSpec = Omit<LevelSpec, 'map'> & { readonly map: OctopusMapSpec };

/**
 * How many random cells a stair search tries, per map cell, before it gives up.
 * UPSTREAM LOOPS FOREVER (`engine/generator/map/Octopus.lua:87-94`, `:99-106`);
 * see `mapgen/roomer.ts`'s cap of the same name, which this matches.
 */
const STAIR_TRIES_PER_CELL = 20;

/** Lua's `math.rad(x)` is `x` times this: the double nearest pi/180. */
const RADIANS_PER_DEGREE = Math.PI / 180;

/**
 * `Octopus:init(zone, map, level, data)` (`engine/generator/map/Octopus.lua:28-44`):
 * `Roomer.init` first — its defaults written into the data, the room files
 * loaded (`engine/generator/map/Roomer.lua:28-39`) — then an empty spot list and
 * Octopus's own fields. Nothing draws.
 */
export function createOctopus(
  map: GenMap,
  data: OctopusData,
  rng: Rng,
  zone: { readonly maxLevel: number },
  level: { forceRecreate: string | null },
): OctopusGen {
  const settings: OctopusSettings = {
    ...data,
    tunnelChange: data.tunnelChange ?? 30,
    tunnelRandom: data.tunnelRandom ?? 10,
    doorChance: data.doorChance ?? 50,
    liteRoomChance: data.liteRoomChance ?? 25,
  };
  const { rooms, requiredRooms } = roomsLoaderInit(settings);
  // `self.spots = {}`: the list `generate` fills and returns.
  map.spots = [];
  return {
    map,
    rng,
    data: settings,
    zone,
    level,
    rooms,
    requiredRooms,
    nbRooms: data.nbRooms ?? [5, 10],
    baseBreakpoint: data.baseBreakpoint ?? 0.4,
    armsRange: data.armsRange ?? [0.5, 0.7],
    armsRadius: data.armsRadius ?? [0.2, 0.3],
    mainRadius: data.mainRadius ?? [0.3, 0.5],
    noise: data.noise ?? 'fbm_perlin',
    zoom: data.zoom ?? 5,
    hurst: data.hurst ?? null,
    lacunarity: data.lacunarity ?? null,
    octave: data.octave ?? 4,
  };
}

/**
 * `Octopus:generate(lev, old_lev)` (`engine/generator/map/Octopus.lua:46-80`).
 *
 * ═══ THE DRAWS, IN ORDER ═══
 * One `'#'` resolve per cell, x outer. The centre pod's radius float, then the
 * pod. The arm count. Then per arm: its range float, its radius float — an
 * argument to `makePod`, so rolled before the pod's own draws — the pod, and
 * the tunnel. Then the stairs.
 *
 * ═══ AN ARM'S CENTRE ═══
 * Arm `i` of `n` stands at `i * 360 / n` degrees, measured from +x toward +y
 * (down the map): `floor(cx + cos(angle) * w/2 * range)` and
 * `floor(cy + sin(angle) * h/2 * range)`, so on a map that is not square the
 * arms lie on an ellipse. Arm 0 is due east of the centre.
 *
 * A CARDINAL ARM IS NOT ON THE CENTRE LINE, upstream either: `cos(270°)` in
 * double is -1.8e-16, not 0, and `floor` takes the centre's column minus that
 * to the column before it, so on a 50x50 map with four arms the arm up the map
 * stands at x 24 and the one down it at x 25. `floor` also puts the arms up and
 * left a cell farther from the centre than those down and right: 18 and 17 at
 * range 0.7.
 */
export function generate(gen: OctopusGen, lev: number, oldLev: number): OctopusResult {
  const { map, rng, data } = gen;

  for (let i = 0; i < map.w; i += 1) {
    for (let j = 0; j < map.h; j += 1) map.set(i, j, map.resolve('#'));
  }

  const spots = map.spots;
  // `self.map.room_map.rooms = rooms`: a NEW list replaces whatever was there.
  const rooms = map.rooms;
  rooms.splice(0, rooms.length);

  const cx = Math.floor(map.w / 2);
  const cy = Math.floor(map.h / 2);
  /** `((self.map.w / 2) + (self.map.h / 2))`: twice the mean half-side. */
  const halves = map.w / 2 + map.h / 2;

  const mainRadius = float(rng, 'mapgen.octopus.main_radius', gen.mainRadius[0], gen.mainRadius[1]);
  rooms.push(makePod(gen, cx, cy, (mainRadius * halves) / 2, 1, gen));
  spots.push({ x: cx, y: cy, type: 'room', subtype: 'main' });

  const nbRooms = range(rng, 'mapgen.octopus.nb_rooms', gen.nbRooms[0], gen.nbRooms[1]);
  for (let i = 0; i <= nbRooms - 1; i += 1) {
    const angle = ((i * 360) / nbRooms) * RADIANS_PER_DEGREE;
    const armRange = float(rng, 'mapgen.octopus.arms_range', gen.armsRange[0], gen.armsRange[1]);
    const rx = Math.floor(cx + ((Math.cos(angle) * map.w) / 2) * armRange);
    const ry = Math.floor(cy + ((Math.sin(angle) * map.h) / 2) * armRange);
    const armRadius = float(
      rng,
      'mapgen.octopus.arms_radius',
      gen.armsRadius[0],
      gen.armsRadius[1],
    );
    rooms.push(makePod(gen, rx, ry, (armRadius * halves) / 2, 2 + i, gen));
    spots.push({ x: rx, y: ry, type: 'room', subtype: 'side' });

    tunnel(gen, rx, ry, cx, cy, 2 + i);
  }

  return data.edgeEntrances !== undefined
    ? makeStairsSides(gen, lev, oldLev, data.edgeEntrances, rooms, spots)
    : makeStairsInside(gen, lev, oldLev, spots);
}

/**
 * One stair inside the level: random cells in `1..w-1` by `1..h-1`, x drawn
 * first, until one neither blocks movement nor is `special`. It becomes the
 * key's terrain and `special = "exit"`. The capped form of upstream's
 * `while true`.
 */
function placeStairInside(gen: OctopusGen, key: 'up' | 'down'): TileXY | null {
  const { map, rng } = gen;
  const limit = map.w * map.h * STAIR_TRIES_PER_CELL;
  for (let tries = 0; tries < limit; tries += 1) {
    const x = range(rng, `mapgen.octopus.stairs.${key}.x`, 1, map.w - 1);
    const y = range(rng, `mapgen.octopus.stairs.${key}.y`, 1, map.h - 1);
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
 * `Octopus:makeStairsInside(lev, old_lev, spots)` (`engine/generator/map/Octopus.lua:83-109`):
 * the down stair first — only below the zone's last level, unless
 * `force_last_stair` — then the up stair. Unlike Roomer's, it has no forced
 * stair positions to honour.
 */
export function makeStairsInside(
  gen: OctopusGen,
  lev: number,
  _oldLev: number,
  spots: readonly Spot[],
): OctopusResult {
  let down: TileXY | null = null;
  if (lev < gen.zone.maxLevel || gen.data.forceLastStair === true) {
    down = placeStairInside(gen, 'down');
    if (down === null) return { up: null, down: null, spots };
  }
  return { up: placeStairInside(gen, 'up'), down, spots };
}

// ═══════════════════════════════════════════════════════════════════════════
// ZONES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE HEART OF THE GLOOM — a tier-one cave of pods
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `data/zones/heart-gloom/zone.lua:23-73`: 50x50, three levels, `all_lited`
 * (`:34`), and Octopus with a centre pod of 0.3-0.4 and arms of 0.1-0.2 of the
 * mean half-side — radii of 7.5-10 and 2.5-5 cells — standing 0.7-0.8 of the
 * way out, five to nine of them. Everything else is Octopus's default.
 *
 * THE GRIDS ARE TABLES, AND A TABLE DRAWS ON EVERY RESOLVE: `'#'` is twelve
 * entries (one TREE, eleven UNDERGROUND_TREE) and `'.'` eight (seven
 * UNDERGROUND_FLOOR, one UNDERGROUND_CREEP). They stay twelve and eight here so
 * every resolve draws as upstream's does. UNDERGROUND_TREE is WALL and
 * UNDERGROUND_FLOOR is FLOOR, as for the breeding pits; TREE is TREES; creep
 * has no code yet and is FLOOR. The ladders are the floor a stair marker stands
 * on, and `door` is the zone's floor, as upstream's is.
 *
 * `levels[1]` changes only the up ladder's grid, which is a marker here.
 *
 * ═══ MEASURED ═══
 * Over 2,000 levels at this table no stair search gave up, the stairs were
 * joined every time, and so was every open cell — about 430 of the 2,500, in six
 * to ten pods. About 1.4 ms a level, p95 1.8 ms.
 *
 * `all_lited` is a zone field, not a generator one: the zone that builds this
 * table says so (`ZoneLevel.lighting`, `mapgen/zones.ts`), or the Gloom is as
 * dark as a cave.
 *
 * ONE CHANGE, ABOUT WHERE THIS RUNS: `forceLastStair`. Upstream's `max_level =
 * 3` (`:27`) decides which floor has no ladder down; here the realm decides, so
 * the generator always places one (as `ROOMER_RUINS_KOR_PUL` does).
 */
export const OCTOPUS_HEART_GLOOM: OctopusLevelSpec = {
  width: 50,
  height: 50,
  map: {
    class: 'Octopus',
    mainRadius: [0.3, 0.4],
    armsRadius: [0.1, 0.2],
    armsRange: [0.7, 0.8],
    nbRooms: [5, 9],
    forceLastStair: true,
    grid: {
      '#': [
        TileCode.TREES,
        TileCode.WALL,
        TileCode.WALL,
        TileCode.WALL,
        TileCode.WALL,
        TileCode.WALL,
        TileCode.WALL,
        TileCode.WALL,
        TileCode.WALL,
        TileCode.WALL,
        TileCode.WALL,
        TileCode.WALL,
      ],
      '.': [
        TileCode.FLOOR,
        TileCode.FLOOR,
        TileCode.FLOOR,
        TileCode.FLOOR,
        TileCode.FLOOR,
        TileCode.FLOOR,
        TileCode.FLOOR,
        TileCode.FLOOR,
      ],
      up: TileCode.FLOOR,
      down: TileCode.FLOOR,
      door: TileCode.FLOOR,
    },
  },
};
