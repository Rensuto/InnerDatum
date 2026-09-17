// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// The generator under test is ported from t-engine4 game/engines/default/engine/generator/map/Octopus.lua:28-109
//   and game/engines/default/engine/generator/map/RoomsLoader.lua:427-488 (makePod),
//   and the zone from game/modules/tome/data/zones/heart-gloom/zone.lua:23-73.
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

import { describe, expect, it } from 'vitest';

import type { TileXY } from '../../../src/shared/coords.ts';
import { reachable, reachableSet } from '../../../src/shared/mapgen/connectivity.ts';
import { createGenMap } from '../../../src/shared/mapgen/genmap.ts';
import type {
  GenMap,
  GridKeys,
  PlacedRoom,
  RoomCell,
  Spot,
} from '../../../src/shared/mapgen/genmap.ts';
import { fovDistance, line } from '../../../src/shared/mapgen/geom.ts';
import { toAuthoredMap } from '../../../src/shared/mapgen/level.ts';
import { float, range, truthy } from '../../../src/shared/mapgen/lua.ts';
import {
  OCTOPUS_HEART_GLOOM,
  createOctopus,
  generate,
  makeStairsInside,
} from '../../../src/shared/mapgen/octopus.ts';
import type { OctopusData, OctopusGen, OctopusResult } from '../../../src/shared/mapgen/octopus.ts';
import { makeStairsSides } from '../../../src/shared/mapgen/roomer.ts';
import { makePod, podRoomId, tunnel } from '../../../src/shared/mapgen/rooms-loader.ts';
import type { PodData } from '../../../src/shared/mapgen/rooms-loader.ts';
import { createNoise1 } from '../../../src/shared/noise.ts';
import { TileCode, isWalkable } from '../../../src/shared/protocol.ts';
import { createRng } from '../../../src/shared/rng.ts';
import type { Rng } from '../../../src/shared/rng.ts';

/** Single codes: a resolve draws nothing. */
const PLAIN: GridKeys = {
  '#': TileCode.WALL,
  '.': TileCode.FLOOR,
  up: TileCode.FLOOR,
  down: TileCode.FLOOR,
};

/** Table keys: EVERY resolve draws, so the order cells are written in shows. */
const TABLES: GridKeys = {
  '#': [TileCode.WALL, TileCode.CRAG, TileCode.TREES],
  '.': [TileCode.FLOOR, TileCode.SOOT],
  up: TileCode.FLOOR,
  down: TileCode.FLOOR,
};

/** `Octopus:init`'s defaults, as `makePod` reads them. */
const POD: PodData = {
  hurst: null,
  lacunarity: null,
  noise: 'fbm_perlin',
  zoom: 5,
  octave: 4,
  baseBreakpoint: 0.4,
};

const GLOOM: OctopusData = OCTOPUS_HEART_GLOOM.map;

function octopus(
  seed: string | Rng,
  data: OctopusData,
  opts: { w?: number; h?: number; maxLevel?: number } = {},
): { gen: OctopusGen; map: GenMap; level: { forceRecreate: string | null } } {
  const rng = typeof seed === 'string' ? createRng(seed) : seed;
  const map = createGenMap(opts.w ?? 50, opts.h ?? 50, data.grid, rng);
  const level = { forceRecreate: null as string | null };
  const gen = createOctopus(map, data, rng, { maxLevel: opts.maxLevel ?? 3 }, level);
  return { gen, map, level };
}

function run(
  seed: string | Rng,
  data: OctopusData = GLOOM,
  opts: { w?: number; h?: number; level?: number; maxLevel?: number } = {},
): { gen: OctopusGen; map: GenMap; result: OctopusResult; forceRecreate: string | null } {
  const { gen, map, level } = octopus(seed, data, opts);
  const result = generate(gen, opts.level ?? 1, 0);
  return { gen, map, result, forceRecreate: level.forceRecreate };
}

type Draw = { readonly label: string; readonly value: number };

/** An Rng that records every draw: raw 32-bit ones and `int`s, with what they returned. */
function recording(seed: string): { rng: Rng; draws: Draw[] } {
  const inner = createRng(seed);
  const draws: Draw[] = [];
  const rng: Rng = {
    ...inner,
    nextU32: (label) => {
      const value = inner.nextU32(label);
      draws.push({ label, value });
      return value;
    },
    int: (label, lo, hi) => {
      const value = inner.int(label, lo, hi);
      draws.push({ label, value });
      return value;
    },
  };
  return { rng, draws };
}

/**
 * `RoomsLoader:makePod` again, from the Lua and not from the port
 * (`engine/generator/map/RoomsLoader.lua:427-488`), statement for statement.
 *
 * `room_map` is NESTED JS ARRAYS here, not `GenMap.cell`: a JS array read at a
 * fractional, negative or too-large index is `undefined`, exactly as a Lua
 * table holding integer keys reads nil, so the float-radius lookups miss by the
 * same mechanism upstream's do rather than by a rule the port also wrote.
 * `line.new` and `core.fov.distance` are `mapgen/geom.ts`, pinned to the C in
 * `geom.test.ts`. Returns how many cells the spur prune walled.
 */
function luaMakePod(
  map: GenMap,
  rng: Rng,
  x: number,
  y: number,
  radius: number,
  roomId: number,
  data: PodData,
  floor = '.',
  wall = '#',
): number {
  const roomMap: RoomCell[][] = Array.from({ length: map.w }, (_, i) =>
    Array.from({ length: map.h }, (__, j) => map.cell(i, j)),
  );
  /** `Map:call` (`engine/Map.lua:559-577`): out of bounds or nil does nothing. */
  const call = (cx: number, cy: number, e: number | null): void => {
    if (cx < 0 || cy < 0 || cx >= map.w || cy >= map.h || e === null) return;
    map.set(cx, cy, e as TileCode);
  };
  /** `Map:isBound` (`engine/Map.lua:958-961`). */
  const isBound = (bx: number, by: number): boolean =>
    !(bx < 0 || bx >= map.w || by < 0 || by >= map.h);
  const cellAt = (i: number, j: number): RoomCell => {
    const c = roomMap[i]?.[j];
    if (c === undefined) throw new TypeError(`attempt to index nil at ${String(i)},${String(j)}`);
    return c;
  };

  call(x, y, map.resolve(floor));
  cellAt(x, y).room = roomId;

  const lowest = { x, y };

  const noise = createNoise1(rng, 'lua.noise', data.hurst ?? 0.5, data.lacunarity ?? 2);
  const method = {
    fbm_perlin: (v: number, o: number) => noise.fbmPerlin(v, o),
    perlin: (v: number) => noise.perlin(v),
    simplex: (v: number) => noise.simplex(v),
    fbm_simplex: (v: number, o: number) => noise.fbmSimplex(v, o),
  }[data.noise];

  let idx = 0;
  const quadrant = (i: number, j: number): void => {
    let breakdist = radius;
    let n = method((data.zoom * idx) / (radius * 4), data.octave);
    n = (n + 1) / 2;
    breakdist = data.baseBreakpoint * breakdist + (1 - data.baseBreakpoint) * breakdist * n;
    idx = idx + 1;

    const l = line(lowest.x, lowest.y, i, j);
    for (let k = 0; k < l.length; k += 1) {
      const at = l[k] as TileXY;
      if (fovDistance(lowest.x, lowest.y, at.x, at.y) >= breakdist) break;
      if (isBound(at.x, at.y)) {
        call(at.x, at.y, map.resolve(floor));
        cellAt(at.x, at.y).room = roomId;
      }
    }
  };
  for (let i = -radius + x; i <= radius + x; i += 1) quadrant(i, -radius + y);
  for (let i = -radius + y; i <= radius + y; i += 1) quadrant(radius + x, i);
  for (let i = -radius + x; i <= radius + x; i += 1) quadrant(i, radius + y);
  for (let i = -radius + y; i <= radius + y; i += 1) quadrant(-radius + x, i);

  let walled = 0;
  for (let i = -radius + x; i <= radius + x; i += 1) {
    for (let j = -radius + y; j <= radius + y; j += 1) {
      if (isBound(i, j)) {
        const g2 = roomMap[i]?.[j + 1]?.room === roomId;
        const g4 = roomMap[i - 1]?.[j]?.room === roomId;
        const g6 = roomMap[i + 1]?.[j]?.room === roomId;
        const g8 = roomMap[i]?.[j - 1]?.room === roomId;
        if (
          (!g8 && !g4 && !g6 && g2) ||
          (!g2 && !g4 && !g6 && g8) ||
          (!g6 && !g2 && !g8 && g4) ||
          (!g4 && !g2 && !g8 && g6)
        ) {
          call(i, j, map.resolve(wall));
          cellAt(i, j).room = null;
          walled += 1;
        }
      }
    }
  }
  return walled;
}

/** Fills the whole map with `'#'`, x outer, as `generate` does. */
function fill(map: GenMap): void {
  for (let i = 0; i < map.w; i += 1) {
    for (let j = 0; j < map.h; j += 1) map.set(i, j, map.resolve('#'));
  }
}

/**
 * Scatters cells that already belong to room 3 and to room 7, off a separate
 * stream, so a whole-radius prune has spurs to cut, other pods to wall and
 * earlier writes to trip over.
 */
function scatter(seed: string): (map: GenMap) => void {
  return (map) => {
    const rng = createRng(`scatter:${seed}`);
    for (let i = 0; i < map.w; i += 1) {
      for (let j = 0; j < map.h; j += 1) {
        const roll = rng.int('scatter', 0, 99);
        if (roll < 22) {
          map.cell(i, j).room = 3;
          map.set(i, j, TileCode.FLOOR);
        } else if (roll < 27) {
          map.cell(i, j).room = 7;
        }
      }
    }
  };
}

const rooms = (map: GenMap): (number | false | null)[] => map.cells.map((c) => c.room);

describe('makePod — against the Lua', () => {
  it('paints, owns, prunes and draws exactly as the Lua does, fractional radius or whole', () => {
    const variants: readonly PodData[] = [
      POD,
      { ...POD, noise: 'perlin' },
      { ...POD, noise: 'simplex', zoom: 9 },
      { ...POD, noise: 'fbm_simplex', octave: 2.5 },
      { ...POD, hurst: 0.9, lacunarity: 3.3 },
      { ...POD, baseBreakpoint: 0.8, zoom: 11 },
    ];
    // Centres in the middle, on the edges and in the corners, so lines run off
    // the map and perimeter points go negative.
    const centres: readonly TileXY[] = [
      { x: 15, y: 12 },
      { x: 1, y: 1 },
      { x: 28, y: 23 },
      { x: 0, y: 12 },
      { x: 15, y: 0 },
    ];
    const radii = [2.5, 3, 4.37, 5, 7.8125, 8, 9.99];
    let wholeWalls = 0;
    let fractionalWalls = 0;
    let cases = 0;
    for (const [v, data] of variants.entries()) {
      for (const c of centres) {
        for (const radius of radii) {
          for (const prep of [null, scatter(`${String(v)}:${String(radius)}`)]) {
            const seed = `pod:${String(v)}:${String(c.x)},${String(c.y)}:${String(radius)}:${String(prep !== null)}`;
            const rngA = createRng(seed);
            const port = createGenMap(30, 25, TABLES, rngA);
            prep?.(port);
            const placed = makePod({ map: port, rng: rngA }, c.x, c.y, radius, 3, data);

            const rngB = createRng(seed);
            const lua = createGenMap(30, 25, TABLES, rngB);
            prep?.(lua);
            const walled = luaMakePod(lua, rngB, c.x, c.y, radius, 3, data);

            expect(Array.from(port.tiles), seed).toEqual(Array.from(lua.tiles));
            expect(rooms(port), seed).toEqual(rooms(lua));
            expect(rngA.getState().count, seed).toBe(rngB.getState().count);
            expect(rngA.nextU32('next'), seed).toBe(rngB.nextU32('next'));
            expect(placed).toMatchObject({ x: c.x, y: c.y, cx: c.x, cy: c.y });
            if (Number.isInteger(radius)) wholeWalls += walled;
            else fractionalWalls += walled;
            cases += 1;
          }
        }
      }
    }
    expect(cases).toBe(420);
    expect(
      wholeWalls,
      'no whole-radius prune walled anything, so the prune went unchecked',
    ).toBeGreaterThan(200);
    expect(fractionalWalls).toBe(0);
  });
});

describe('makePod — the rules, from first principles', () => {
  it('owns and floors the centre, draws one resolve for it, then one 1D noise, and paints nothing when every line breaks at once', () => {
    // radius 0.9, base_breakpoint 1: breakdist is 0.9 and the first cell of any
    // line is at distance 1. A `'.'` of two codes draws on every resolve; a 1D
    // noise is 256 gradients and 255 swaps, and no draw here ever rejects.
    const rng = createRng('centre-only');
    const map = createGenMap(9, 9, TABLES, rng);
    makePod({ map, rng }, 4, 4, 0.9, 5, { ...POD, baseBreakpoint: 1 });
    expect(rng.getState().count).toBe(1 + 256 + 255);
    for (let x = 0; x < 9; x += 1) {
      for (let y = 0; y < 9; y += 1) {
        const centre = x === 4 && y === 4;
        expect(map.get(x, y) !== null, `${String(x)},${String(y)}`).toBe(centre);
        expect(map.cell(x, y).room, `${String(x)},${String(y)}`).toBe(centre ? 5 : null);
      }
    }
  });

  it('resolves the centre BEFORE it makes the noise, and makes a fresh noise per pod', () => {
    const { rng, draws } = recording('draw-order');
    const map = createGenMap(20, 20, TABLES, rng);
    makePod({ map, rng }, 10, 10, 3.5, 1, POD);
    makePod({ map, rng }, 5, 5, 2.5, 2, POD);
    const labels = draws.map((d) => d.label);
    expect(labels[0]).toBe('mapgen.resolve..');
    expect(labels.slice(1, 257).every((l) => l === 'mapgen.pod.noise.gradient')).toBe(true);
    expect(labels.slice(257, 512).every((l) => l === 'mapgen.pod.noise.map')).toBe(true);
    const runs = labels.filter((l, i) => l !== labels[i - 1]);
    expect(runs.filter((l) => l === 'mapgen.pod.noise.gradient')).toHaveLength(2);
  });

  it('stops a line at the first cell whose ROUNDED distance reaches breakdist', () => {
    // base_breakpoint 1: breakdist is the radius whatever the noise. (2, 1) is
    // 2.236 away, which rounds to 2 < 2.2 and is painted; a true distance
    // would stop there. (2, 2) is 2.83, which rounds to 3, and is not.
    const rng = createRng('rounded');
    const map = createGenMap(21, 21, PLAIN, rng);
    makePod({ map, rng }, 10, 10, 2.2, 1, { ...POD, baseBreakpoint: 1 });
    expect(map.cell(12, 11).room).toBe(1);
    expect(map.get(12, 11)).toBe(TileCode.FLOOR);
    expect(map.cell(12, 12).room).toBeNull();
    expect(map.get(12, 12)).toBeNull();
  });

  it('stops a line AT breakdist: a cell exactly that far is not the room`s', () => {
    // `fovDistance` is a whole number, so `>=` and `>` part only where breakdist
    // is whole too — base_breakpoint 1 and a whole radius, 3 here. Nothing at
    // distance 3 may be the room's; (12, 10) at 2 is, and (13, 10) at 3 is not.
    const rng = createRng('at-breakdist');
    const map = createGenMap(21, 21, PLAIN, rng);
    makePod({ map, rng }, 10, 10, 3, 1, { ...POD, baseBreakpoint: 1 });
    expect(map.cell(12, 10).room).toBe(1);
    expect(map.cell(13, 10).room).toBeNull();
    let owned = 0;
    for (let x = 0; x < 21; x += 1) {
      for (let y = 0; y < 21; y += 1) {
        if (map.cell(x, y).room !== 1) continue;
        owned += 1;
        expect(fovDistance(10, 10, x, y), `${String(x)},${String(y)}`).toBeLessThan(3);
      }
    }
    expect(owned).toBeGreaterThan(12);
  });

  /**
   * The prune's layout, round a radius-5 pod at (10, 10). Lines break before a
   * cell whose rounded distance is 5 or more, so every cell named here, and
   * every neighbour it has inside the square, is untouched by the lines: all
   * the prune sees of them is what was set up.
   */
  function pruneLayout(radius: number): GenMap {
    const rng = createRng('prune');
    const map = createGenMap(21, 21, PLAIN, rng);
    const mark = (x: number, y: number, room: number | null): void => {
      map.set(x, y, TileCode.FLOOR);
      map.cell(x, y).room = room;
    };
    mark(14, 5, 1); // P, scanned before Q
    mark(15, 5, 1); // Q
    mark(5, 15, 7); // C, another pod's cell
    mark(6, 15, 1); // E
    mark(14, 15, null); // R, plain ground
    mark(15, 15, 1); // S
    mark(5, 5, null); // K
    mark(6, 5, 7); // L, another pod's cell
    for (const [x, y] of [
      [14, 5],
      [15, 5],
      [5, 15],
      [6, 15],
      [14, 15],
      [15, 15],
      [5, 5],
      [6, 5],
    ] as const) {
      expect(fovDistance(10, 10, x, y)).toBeGreaterThanOrEqual(6);
    }
    makePod({ map, rng }, 10, 10, radius, 1, POD);
    return map;
  }

  const at = (map: GenMap, x: number, y: number): [number | null, number | false | null] => [
    map.get(x, y),
    map.cell(x, y).room,
  ];

  it('prunes a whole radius in scan order, against its own id only, walling ground and other pods alike', () => {
    const map = pruneLayout(5);
    // P has one side (Q) and is walled first; Q, scanned after, has none left.
    expect(at(map, 14, 5)).toEqual([TileCode.WALL, null]);
    expect(at(map, 15, 5)).toEqual([TileCode.FLOOR, 1]);
    // Another pod's cell with one side in this pod is walled and leaves its pod.
    expect(at(map, 5, 15)).toEqual([TileCode.WALL, null]);
    expect(at(map, 6, 15)).toEqual([TileCode.FLOOR, 1]);
    // Plain ground with one side is walled too.
    expect(at(map, 14, 15)).toEqual([TileCode.WALL, null]);
    expect(at(map, 15, 15)).toEqual([TileCode.FLOOR, 1]);
    // A side in ANOTHER pod is no side.
    expect(at(map, 5, 5)).toEqual([TileCode.FLOOR, null]);
    expect(at(map, 6, 5)).toEqual([TileCode.FLOOR, 7]);
  });

  it('prunes nothing when the radius is fractional: every lookup lands between cells', () => {
    const map = pruneLayout(5.5);
    expect(at(map, 14, 5)).toEqual([TileCode.FLOOR, 1]);
    expect(at(map, 15, 5)).toEqual([TileCode.FLOOR, 1]);
    expect(at(map, 5, 15)).toEqual([TileCode.FLOOR, 7]);
    expect(at(map, 6, 15)).toEqual([TileCode.FLOOR, 1]);
    expect(at(map, 14, 15)).toEqual([TileCode.FLOOR, null]);
    expect(at(map, 15, 15)).toEqual([TileCode.FLOOR, 1]);
    expect(at(map, 5, 5)).toEqual([TileCode.FLOOR, null]);
    expect(at(map, 6, 5)).toEqual([TileCode.FLOOR, 7]);
    expect(Array.from(map.tiles).includes(TileCode.WALL)).toBe(false);
  });

  it('passes nil hurst and lacunarity as libtcod`s defaults; hurst changes nothing and lacunarity does', () => {
    let lacunarityMoved = 0;
    for (let s = 0; s < 12; s += 1) {
      const pod = (data: PodData): number[] => {
        const rng = createRng(`noise-params:${String(s)}`);
        const map = createGenMap(30, 30, PLAIN, rng);
        makePod({ map, rng }, 15, 15, 9.3, 1, data);
        return Array.from(map.tiles);
      };
      const nil = pod(POD);
      expect(pod({ ...POD, hurst: 0.5, lacunarity: 2 })).toEqual(nil);
      expect(pod({ ...POD, hurst: 0.05 })).toEqual(nil);
      if (pod({ ...POD, lacunarity: 5 }).join() !== nil.join()) lacunarityMoved += 1;
    }
    expect(lacunarityMoved).toBeGreaterThan(6);
  });

  it('hands the octave only to an fbm method', () => {
    let fbmMoved = 0;
    for (let s = 0; s < 12; s += 1) {
      const pod = (data: PodData): number[] => {
        const rng = createRng(`octave:${String(s)}`);
        const map = createGenMap(30, 30, PLAIN, rng);
        makePod({ map, rng }, 15, 15, 9.3, 1, data);
        return Array.from(map.tiles);
      };
      for (const noise of ['perlin', 'simplex'] as const) {
        expect(pod({ ...POD, noise, octave: 1 })).toEqual(pod({ ...POD, noise, octave: 7 }));
      }
      if (pod({ ...POD, octave: 1 }).join() !== pod({ ...POD, octave: 7 }).join()) fbmMoved += 1;
    }
    expect(fbmMoved).toBeGreaterThan(6);
  });

  it('returns the pod`s entry without placing it, under an id no numeric tunnel carries', () => {
    const rng = createRng('entry');
    const map = createGenMap(20, 20, PLAIN, rng);
    const placed = makePod({ map, rng }, 7, 9, 3.5, 4, POD);
    expect(placed).toEqual({
      id: podRoomId(4),
      x: 7,
      y: 9,
      cx: 7,
      cy: 9,
      room: { name: 'podroom4', w: 0, h: 0, rows: [], ignoresLite: true },
    });
    expect(podRoomId(4)).toBeLessThan(1);
    expect(map.rooms).toEqual([]);
  });

  it('throws for a centre off the map, where upstream indexes a nil row', () => {
    const rng = createRng('off');
    const map = createGenMap(10, 10, PLAIN, rng);
    expect(() => makePod({ map, rng }, 10, 3, 2.5, 1, POD)).toThrow(RangeError);
  });
});

describe('Octopus:generate — against the Lua', () => {
  /**
   * `engine/generator/map/Octopus.lua:46-109` again, with `luaMakePod` for the
   * pods. `tunnel` and Roomer's `makeStairsSides` are the ports, pinned by their
   * own tests; the generator instance is only their `self`.
   */
  function luaOctopus(
    seed: string,
    data: OctopusData,
    w: number,
    h: number,
    lev: number,
    maxLevel: number,
  ): { map: GenMap; up: TileXY | null; down: TileXY | null; spots: Spot[]; rng: Rng } {
    const { gen, map } = octopus(seed, data, { w, h, maxLevel });
    const { rng } = gen;
    fill(map);

    const spots: Spot[] = [];
    const list: PlacedRoom[] = [];
    const pod = (x: number, y: number, id: number): PlacedRoom => ({
      id: -id,
      x,
      y,
      cx: x,
      cy: y,
      room: { name: '', w: 0, h: 0, rows: [] },
    });
    const cx = Math.floor(w / 2);
    const cy = Math.floor(h / 2);
    luaMakePod(
      map,
      rng,
      cx,
      cy,
      (float(rng, 'lua.main', gen.mainRadius[0], gen.mainRadius[1]) * (w / 2 + h / 2)) / 2,
      1,
      gen,
    );
    list.push(pod(cx, cy, 1));
    spots.push({ x: cx, y: cy, type: 'room', subtype: 'main' });

    const nb = range(rng, 'lua.nb', gen.nbRooms[0], gen.nbRooms[1]);
    for (let i = 0; i <= nb - 1; i += 1) {
      const angle = ((i * 360) / nb) * (Math.PI / 180);
      const r = float(rng, 'lua.range', gen.armsRange[0], gen.armsRange[1]);
      const rx = Math.floor(cx + ((Math.cos(angle) * w) / 2) * r);
      const ry = Math.floor(cy + ((Math.sin(angle) * h) / 2) * r);
      luaMakePod(
        map,
        rng,
        rx,
        ry,
        (float(rng, 'lua.radius', gen.armsRadius[0], gen.armsRadius[1]) * (w / 2 + h / 2)) / 2,
        2 + i,
        gen,
      );
      list.push(pod(rx, ry, 2 + i));
      spots.push({ x: rx, y: ry, type: 'room', subtype: 'side' });
      tunnel(gen, rx, ry, cx, cy, 2 + i);
    }

    if (data.edgeEntrances !== undefined) {
      const { up, down } = makeStairsSides(gen, lev, 0, data.edgeEntrances, list, spots);
      return { map, up, down, spots, rng };
    }
    const stair = (key: 'up' | 'down'): TileXY => {
      for (;;) {
        const x = range(rng, 'lua.x', 1, w - 1);
        const y = range(rng, 'lua.y', 1, h - 1);
        const code = map.get(x, y);
        if ((code === null || isWalkable(code)) && !truthy(map.cell(x, y).special)) {
          map.set(x, y, map.resolve(key));
          map.cell(x, y).special = 'exit';
          return { x, y };
        }
      }
    };
    const down = lev < maxLevel || data.forceLastStair === true ? stair('down') : null;
    return { map, up: stair('up'), down, spots, rng };
  }

  it('builds the same level, cell for cell and draw for draw, inside stairs or edge ones', () => {
    const cases: { data: OctopusData; w: number; h: number; lev: number }[] = [
      { data: GLOOM, w: 50, h: 50, lev: 1 },
      { data: { ...GLOOM, grid: TABLES }, w: 60, h: 40, lev: 3 },
      { data: { grid: TABLES }, w: 44, h: 52, lev: 2 },
      { data: GLOOM, w: 45, h: 51, lev: 1 },
      { data: { ...GLOOM, edgeEntrances: [4, 6] }, w: 50, h: 50, lev: 1 },
      { data: { ...GLOOM, grid: TABLES, edgeEntrances: [8, 2] }, w: 48, h: 36, lev: 1 },
    ];
    for (const [k, c] of cases.entries()) {
      for (let s = 0; s < 6; s += 1) {
        const seed = `lua-octopus:${String(k)}:${String(s)}`;
        const port = run(seed, c.data, { w: c.w, h: c.h, level: c.lev, maxLevel: 3 });
        const lua = luaOctopus(seed, c.data, c.w, c.h, c.lev, 3);
        expect(Array.from(port.map.tiles), seed).toEqual(Array.from(lua.map.tiles));
        expect(rooms(port.map), seed).toEqual(rooms(lua.map));
        expect(
          port.map.cells.map((cell) => cell.tunnel),
          seed,
        ).toEqual(lua.map.cells.map((cell) => cell.tunnel));
        expect(port.result.up, seed).toEqual(lua.up);
        expect(port.result.down, seed).toEqual(lua.down);
        expect(port.result.spots, seed).toEqual(lua.spots);
        expect(port.gen.rng.getState().count, seed).toBe(lua.rng.getState().count);
      }
    }
  });
});

describe('Octopus:generate — the rules', () => {
  it('draws in upstream`s order: fill, centre radius and pod, arm count, then per arm range, radius, pod, tunnel; then stairs', () => {
    const { rng, draws } = recording('order');
    run(rng, GLOOM);
    const token = (label: string): string | null => {
      if (label === 'mapgen.resolve.#') return '#';
      if (label.startsWith('mapgen.pod.noise.')) return 'noise';
      if (label.startsWith('mapgen.roomer.tunnel.')) return 'tunnel';
      if (label.startsWith('mapgen.octopus.stairs.down')) return 'down';
      if (label.startsWith('mapgen.octopus.stairs.up')) return 'up';
      const own = /^mapgen\.octopus\.(\w+)$/.exec(label);
      return own?.[1] ?? null;
    };
    const tokens = draws.map((d) => token(d.label)).filter((t): t is string => t !== null);
    const runs = tokens.filter((t, i) => t !== tokens[i - 1]);
    const nb = draws.find((d) => d.label === 'mapgen.octopus.nb_rooms')?.value ?? -1;
    expect(nb).toBeGreaterThanOrEqual(5);
    expect(runs).toEqual([
      '#',
      'main_radius',
      'noise',
      'nb_rooms',
      ...Array.from({ length: nb }, () => ['arms_range', 'arms_radius', 'noise', 'tunnel']).flat(),
      'down',
      'up',
    ]);
  });

  it('stands arm i at i*360/n degrees, floor(c + cos*w/2*range) and floor(c + sin*h/2*range), on a map that is not square', () => {
    let arms = 0;
    for (let s = 0; s < 20; s += 1) {
      const { rng, draws } = recording(`arms:${String(s)}`);
      const data: OctopusData = { ...GLOOM, armsRange: [0.3, 0.95] };
      const { result } = run(rng, data, { w: 70, h: 40 });
      const n = draws.find((d) => d.label === 'mapgen.octopus.nb_rooms')?.value ?? -1;
      const ranges = draws.filter((d) => d.label === 'mapgen.octopus.arms_range');
      expect(ranges).toHaveLength(n);
      expect(result.spots[0]).toEqual({ x: 35, y: 20, type: 'room', subtype: 'main' });
      expect(result.spots).toHaveLength(n + 1);
      for (let i = 0; i < n; i += 1) {
        // `rng.float(0.3, 0.95)`: one raw draw, scaled between the C floats.
        const lo = Math.fround(0.3);
        const hi = Math.fround(0.95);
        const r = (ranges[i]?.value ?? 0) * ((hi - lo) / 4294967295) + lo;
        // `math.rad(i * 360 / nb_rooms)`.
        const angle = ((i * 360) / n) * (Math.PI / 180);
        const want = {
          x: Math.floor(35 + Math.cos(angle) * 35 * r),
          y: Math.floor(20 + Math.sin(angle) * 20 * r),
        };
        expect(result.spots[i + 1], `seed ${String(s)} arm ${String(i)}`).toEqual({
          ...want,
          type: 'room',
          subtype: 'side',
        });
        arms += 1;
      }
      // Arm 0 is due east.
      expect(result.spots[1]?.y).toBe(20);
      expect(result.spots[1]?.x).toBeGreaterThan(35);
    }
    expect(arms).toBeGreaterThan(100);
  });

  it('replaces the room list with its pods, centre first, and starts and returns a fresh spot list', () => {
    const rng = createRng('replace');
    const map = createGenMap(50, 50, GLOOM.grid, rng);
    const stale: PlacedRoom = {
      id: 99,
      x: 1,
      y: 1,
      cx: 2,
      cy: 2,
      room: { name: 'stale', w: 3, h: 3, rows: ['...', '...', '...'] },
    };
    map.rooms.push(stale);
    map.spots.push({ x: 2, y: 2, type: 'room', subtype: 'stale' });
    const gen = createOctopus(map, GLOOM, rng, { maxLevel: 3 }, { forceRecreate: null });
    const result = generate(gen, 1, 0);
    expect(map.rooms.includes(stale)).toBe(false);
    // `self.spots = {}` at init: the spot list starts empty too.
    expect(result.spots.map((s) => s.subtype)).toEqual([
      'main',
      ...Array.from({ length: map.rooms.length - 1 }, () => 'side'),
    ]);
    expect(map.rooms.map((r) => r.id)).toEqual(
      Array.from({ length: map.rooms.length }, (_, i) => podRoomId(i + 1)),
    );
    expect(map.rooms.map((r) => ({ x: r.cx, y: r.cy }))).toEqual(
      result.spots.map((s) => ({ x: s.x, y: s.y })),
    );
    expect(result.spots).toBe(map.spots);
  });

  it('lets a stair`s tunnel cross an arm`s trail at once: the pod`s id is not the arm`s', () => {
    // A two-row corridor. Pod 1's centre is at (8, 1); the cells from the left
    // edge to it carry tunnel id 1, as the arm to pod 1 would have left them.
    // With tunnel_change 0 the stair's tunnel walks straight there, one
    // `tunnel_change` roll per step — eight — unless it has to wait out fifteen
    // refusals on every marked cell, as it would under the arm's own id.
    const { rng, draws } = recording('corridor');
    const data: OctopusData = { grid: PLAIN, tunnelChange: 0, tunnelRandom: 0 };
    const { gen, map } = octopus(rng, data, { w: 12, h: 2, maxLevel: 1 });
    fill(map);
    const pod = makePod(gen, 8, 1, 0.5, 1, gen);
    for (let x = 1; x <= 7; x += 1) map.cell(x, 1).tunnel = 1;
    const before = draws.length;
    const { up } = makeStairsSides(gen, 1, 0, [4, 6], [pod], []);
    expect(up).toEqual({ x: 0, y: 1 });
    const steps = draws.slice(before).filter((d) => d.label === 'mapgen.roomer.tunnel.change');
    expect(steps).toHaveLength(8);
    for (let x = 1; x <= 8; x += 1) expect(map.get(x, 1)).toBe(TileCode.FLOOR);
  });

  it('hangs no door, rolls no light, and lists no lit room or vault', () => {
    for (let s = 0; s < 8; s += 1) {
      const { rng, draws } = recording(`unlit:${String(s)}`);
      const data: OctopusData = { ...GLOOM, grid: { ...GLOOM.grid, door: TileCode.DOOR } };
      const { map, result } = run(rng, data);
      expect(draws.some((d) => d.label.includes('lit') || d.label.includes('doors'))).toBe(false);
      expect(map.possibleDoors).toEqual([]);
      expect(Array.from(map.tiles).includes(TileCode.DOOR)).toBe(false);
      const authored = toAuthoredMap(map, result.up, result.down, data.grid);
      expect(authored.rooms).toEqual([]);
      expect(authored.vaults).toEqual([]);
    }
  });

  it('stands both stairs inside on open cells that are not special, down first, in 1..w-1', () => {
    for (let s = 0; s < 40; s += 1) {
      const { gen, map } = octopus(`stairs:${String(s)}`, { grid: PLAIN }, { w: 8, h: 8 });
      fill(map);
      // Open at the far corner, which `range(1, w-1)` reaches; on column 0 and
      // row 0, which it never does; and at two cells, one of them special.
      map.set(7, 7, TileCode.FLOOR);
      map.set(0, 3, TileCode.FLOOR);
      map.set(3, 0, TileCode.FLOOR);
      map.set(3, 4, TileCode.FLOOR);
      map.set(5, 2, TileCode.FLOOR);
      map.cell(5, 2).special = true;
      const { up, down } = makeStairsInside(gen, 1, 0, []);
      expect([down, up].map((c) => `${String(c?.x)},${String(c?.y)}`).sort()).toEqual([
        '3,4',
        '7,7',
      ]);
      expect(map.cell(3, 4).special).toBe('exit');
      expect(map.cell(7, 7).special).toBe('exit');
    }
  });

  it('places the DOWN stair first: it takes the first open cell the draws reach, and up the next', () => {
    let downOnTheLowerCell = 0;
    for (let s = 0; s < 40; s += 1) {
      const seed = `stair-order:${String(s)}`;
      const { gen, map } = octopus(seed, { grid: PLAIN }, { w: 8, h: 8 });
      map.set(7, 7, TileCode.FLOOR);
      map.set(3, 4, TileCode.FLOOR);
      for (let x = 0; x < 8; x += 1) {
        for (let y = 0; y < 8; y += 1) if (map.get(x, y) === null) map.set(x, y, TileCode.WALL);
      }
      const { up, down } = makeStairsInside(gen, 1, 0, []);
      const twin = createRng(seed);
      const open = new Set(['7,7', '3,4']);
      const next = (): string => {
        for (;;) {
          const x = twin.int('x', 1, 7);
          const cell = `${String(x)},${String(twin.int('y', 1, 7))}`;
          if (open.has(cell)) return cell;
        }
      };
      const first = next();
      open.delete(first);
      expect(`${String(down?.x)},${String(down?.y)}`, seed).toBe(first);
      expect(`${String(up?.x)},${String(up?.y)}`, seed).toBe(next());
      if (first === '3,4') downOnTheLowerCell += 1;
    }
    expect(downOnTheLowerCell).toBeGreaterThan(5);
    expect(downOnTheLowerCell).toBeLessThan(35);
  });

  it('places no down stair on the zone`s last level unless forced', () => {
    const plain: OctopusData = { ...GLOOM, forceLastStair: false };
    expect(run('last', plain, { level: 3, maxLevel: 3 }).result.down).toBeNull();
    expect(run('last', plain, { level: 3, maxLevel: 3 }).result.up).not.toBeNull();
    expect(run('last', plain, { level: 2, maxLevel: 3 }).result.down).not.toBeNull();
    expect(run('last', GLOOM, { level: 3, maxLevel: 3 }).result.down).not.toBeNull();
  });

  it('with edge_entrances, puts each stair on its edge and tunnels it into the level', () => {
    for (const sides of [
      [4, 6],
      [8, 2],
    ] as const) {
      for (let s = 0; s < 10; s += 1) {
        const { map, result } = run(`edges:${String(s)}`, { ...GLOOM, edgeEntrances: sides });
        const { up, down } = result;
        if (up === null || down === null) throw new Error('a stair is missing');
        if (sides[0] === 4) expect([up.x, down.x]).toEqual([0, 49]);
        else expect([up.y, down.y]).toEqual([0, 49]);
        expect(map.cell(up.x, up.y).special).toBe('exit');
        expect(reachable(map, up, down)).toBe(true);
      }
    }
  });
});

describe('Octopus:init and the Heart of the Gloom', () => {
  it('writes upstream`s defaults for every field a zone leaves out', () => {
    // `engine/generator/map/Octopus.lua:33-43`, and Roomer's (`Roomer.lua:31-34`).
    const { gen, map } = octopus('defaults', { grid: PLAIN });
    expect(gen).toMatchObject({
      nbRooms: [5, 10],
      baseBreakpoint: 0.4,
      armsRange: [0.5, 0.7],
      armsRadius: [0.2, 0.3],
      mainRadius: [0.3, 0.5],
      noise: 'fbm_perlin',
      zoom: 5,
      hurst: null,
      lacunarity: null,
      octave: 4,
    });
    expect(gen.data).toMatchObject({
      tunnelChange: 30,
      tunnelRandom: 10,
      doorChance: 50,
      liteRoomChance: 25,
    });
    expect(map.spots).toEqual([]);
    expect(gen.rng.getState().count).toBe(0);
  });

  it('pins the Heart of the Gloom to `data/zones/heart-gloom/zone.lua:23-73`', () => {
    expect(OCTOPUS_HEART_GLOOM).toEqual({
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
          '#': [TileCode.TREES, ...Array.from({ length: 11 }, () => TileCode.WALL)],
          '.': Array.from({ length: 8 }, () => TileCode.FLOOR),
          up: TileCode.FLOOR,
          down: TileCode.FLOOR,
          door: TileCode.FLOOR,
        },
      },
    });
  });

  it('is the same level for the same seed, and a different one for another', () => {
    const a = run('same');
    const b = run('same');
    const c = run('other');
    expect(Array.from(a.map.tiles)).toEqual(Array.from(b.map.tiles));
    expect(a.result).toEqual(b.result);
    expect(Array.from(a.map.tiles)).not.toEqual(Array.from(c.map.tiles));
  });

  it('joins every open cell to both stairs on forty Heart of the Gloom levels', () => {
    let arms = 0;
    for (let s = 0; s < 40; s += 1) {
      const { map, result, forceRecreate } = run(`gloom:${String(s)}`);
      expect(forceRecreate).toBeNull();
      const { up, down } = result;
      if (up === null || down === null) throw new Error('a stair is missing');
      expect(reachable(map, up, down), `seed ${String(s)}`).toBe(true);
      const from = reachableSet(map, up);
      const cut = Array.from(map.tiles).filter((code, i) => isWalkable(code) && from[i] !== 1);
      expect(cut, `seed ${String(s)}`).toEqual([]);
      arms += map.rooms.length - 1;
    }
    // Five to nine arms a level.
    expect(arms).toBeGreaterThanOrEqual(40 * 5);
    expect(arms).toBeLessThanOrEqual(40 * 9);
  });
});
