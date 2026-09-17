// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// The generator under test is ported from t-engine4 game/engines/default/engine/generator/map/Forest.lua:30-541
//   and the zones from game/modules/tome/data/zones/{trollmire,old-forest,golem-graveyard}/zone.lua.
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

import { describe, expect, it } from 'vitest';

import type { TileXY } from '../../../src/shared/coords.ts';
import type { AuthoredMap } from '../../../src/shared/level.ts';
import {
  FOREST_GOLEM_GRAVEYARD,
  FOREST_TROLLMIRE,
  ROOMER_OLD_FOREST,
  addPond,
  checkValid,
  createForest,
  generate,
  makeRoad,
  makeStairsInside,
  makeStairsSides,
  roadWaypoints,
} from '../../../src/shared/mapgen/forest.ts';
import type { ForestData, ForestGen, ForestResult } from '../../../src/shared/mapgen/forest.ts';
import { createGenMap } from '../../../src/shared/mapgen/genmap.ts';
import type { GenMap, GridKeys, Spot } from '../../../src/shared/mapgen/genmap.ts';
import { line } from '../../../src/shared/mapgen/geom.ts';
import { newLevel } from '../../../src/shared/mapgen/level.ts';
import type { LevelSpec } from '../../../src/shared/mapgen/level.ts';
import { tableSort } from '../../../src/shared/mapgen/sort.ts';
import { createNoise2 } from '../../../src/shared/noise.ts';
import { TileCode, isWalkable } from '../../../src/shared/protocol.ts';
import { createRng, rngFromState } from '../../../src/shared/rng.ts';
import type { Rng } from '../../../src/shared/rng.ts';

/** No `up`/`down` keys: a stair marks its cell `exit` and leaves the terrain as rolled. */
const PLAIN: GridKeys = {
  floor: TileCode.FLOOR,
  floor2: TileCode.GREEN,
  wall: TileCode.WALL,
};

const WOODS: GridKeys = {
  floor: TileCode.GREEN,
  wall: TileCode.TREES,
  up: TileCode.GREEN,
  down: TileCode.GREEN,
  road: TileCode.YARD,
  '.': TileCode.GREEN,
  '#': TileCode.TREES,
};

/** Every cell a tree: `v` is at least 5000 and `sqrt_percent` 0 rolls `percent(v)`. */
const ALL_TREES = { maxPercent: 1e9, sqrtPercent: 0 } as const;
/** No tree: `v` is 0 and rolls `percent(sqrt(0))`. */
const NO_TREES = { maxPercent: 0 } as const;

type Run = {
  gen: ForestGen;
  map: GenMap;
  result: ForestResult | null;
  forceRecreate: string | null;
};

function run(
  seed: string | Rng,
  data: Partial<ForestData>,
  opts: { w?: number; h?: number; level?: number; maxLevel?: number } = {},
): Run {
  const rng = typeof seed === 'string' ? createRng(seed) : seed;
  const grid = data.grid ?? PLAIN;
  const map = createGenMap(opts.w ?? 40, opts.h ?? 30, grid, rng);
  const level = { forceRecreate: null as string | null };
  const gen = createForest(map, { ...data, grid }, rng, { maxLevel: opts.maxLevel ?? 3 }, level);
  const result = generate(gen, opts.level ?? 1, 0);
  return { gen, map, result, forceRecreate: level.forceRecreate };
}

/** An Rng that records the label of every draw it makes. */
function recording(seed: string): { rng: Rng; labels: string[] } {
  const inner = createRng(seed);
  const labels: string[] = [];
  const rng: Rng = {
    ...inner,
    nextU32: (label) => {
      labels.push(label);
      return inner.nextU32(label);
    },
    int: (label, lo, hi) => {
      labels.push(label);
      return inner.int(label, lo, hi);
    },
  };
  return { rng, labels };
}

const key = (x: number, y: number): string => `${String(x)},${String(y)}`;

/** Cells reachable from `from` over `open`, 4-way or 8-way. */
function reach(
  w: number,
  h: number,
  from: TileXY,
  open: (x: number, y: number) => boolean,
  diagonals: boolean,
): Set<string> {
  const seen = new Set([key(from.x, from.y)]);
  const queue: TileXY[] = [from];
  for (let head = 0; head < queue.length; head += 1) {
    const at = queue[head] as TileXY;
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        if (!diagonals && dx !== 0 && dy !== 0) continue;
        const x = at.x + dx;
        const y = at.y + dy;
        if (x < 0 || y < 0 || x >= w || y >= h || seen.has(key(x, y)) || !open(x, y)) continue;
        seen.add(key(x, y));
        queue.push({ x, y });
      }
    }
  }
  return seen;
}

/**
 * Forest.lua:141-167 again, from the Lua: the noise is the first thing drawn
 * when the floor key draws nothing, then one `rand_div(100)` per cell, x outer.
 */
function rollLayer(
  seed: string,
  w: number,
  h: number,
  d: {
    zoom: number;
    maxPercent: number;
    sqrtPercent: number;
    sqrtPercent2?: number;
    octave: number;
  },
): { tiles: number[]; candidates: Set<string> } {
  const rng = createRng(seed);
  const noise = createNoise2(rng, 'noise');
  const tiles: number[] = Array.from({ length: w * h }, () => TileCode.FLOOR);
  const candidates = new Set<string>();
  for (let i = 1; i <= w; i += 1) {
    for (let j = 1; j <= h; j += 1) {
      const n = noise.fbmPerlin((d.zoom * i) / w, (d.zoom * j) / h, d.octave);
      const v = Math.floor((n / 2 + 0.5) * d.maxPercent);
      const below = v >= d.sqrtPercent ? v : Math.trunc(Math.sqrt(v));
      const tree = rng.int('roll', 0, 99) < below;
      const floor2 = d.sqrtPercent2 !== undefined && v >= d.sqrtPercent2;
      tiles[(j - 1) * w + (i - 1)] = tree
        ? TileCode.WALL
        : floor2
          ? TileCode.GREEN
          : TileCode.FLOOR;
      if (!tree && v >= d.sqrtPercent) candidates.add(key(i - 1, j - 1));
    }
  }
  return { tiles, candidates };
}

describe('Forest — the trees', () => {
  const CASES = [
    { zoom: 5, maxPercent: 80, sqrtPercent: 30, octave: 4 },
    { zoom: 4, maxPercent: 80, sqrtPercent: 30, octave: 4 },
    { zoom: 4, maxPercent: 80, sqrtPercent: 70, octave: 4 },
    { zoom: 7, maxPercent: 80, sqrtPercent: 30, sqrtPercent2: 25, octave: 4 },
    { zoom: 3, maxPercent: 120, sqrtPercent: 45, sqrtPercent2: 60, octave: 2.5 },
  ];

  it('rolls each cell once against v, or against the truncated root of v below sqrt_percent, from 1-based noise', () => {
    let trees = 0;
    let open = 0;
    CASES.forEach((d, c) => {
      for (let s = 0; s < 6; s += 1) {
        const seed = `rolls:${String(c)}:${String(s)}`;
        const want = rollLayer(seed, 40, 30, d);
        const { map, result } = run(seed, { ...d, nbSpots: 100000 });
        expect(Array.from(map.tiles)).toEqual(want.tiles);
        trees += want.tiles.filter((t) => t === TileCode.WALL).length;
        open += want.tiles.filter((t) => t !== TileCode.WALL).length;
        // Every candidate, and only those, became a clearing spot.
        const spots = (result?.spots ?? []).filter((sp) => sp.type === 'clearing');
        expect(new Set(spots.map((sp) => key(sp.x, sp.y)))).toEqual(want.candidates);
      }
    });
    expect(Math.min(trees, open)).toBeGreaterThan(5000);
  });

  it('makes exactly one roll per cell, even where v is 0', () => {
    for (const d of [{}, NO_TREES, ALL_TREES, { sqrtPercent2: 10 }]) {
      const { rng, labels } = recording('one-roll');
      run(rng, d, { w: 23, h: 17 });
      expect(labels.filter((l) => l === 'mapgen.forest.tree')).toHaveLength(23 * 17);
    }
  });

  it('takes floor2 for every open cell when sqrt_percent2 is 0, because 0 is true in Lua', () => {
    const { map } = run('floor2-zero', { sqrtPercent2: 0 });
    const codes = new Set(map.tiles);
    expect(codes.has(TileCode.GREEN)).toBe(true);
    expect(codes.has(TileCode.FLOOR)).toBe(false);
  });

  it('resolves floor once per cell for the fill and AGAIN for every cell left open', () => {
    let floors = 0;
    let walls = 0;
    const grid: GridKeys = {
      floor: () => {
        floors += 1;
        return TileCode.FLOOR;
      },
      wall: () => {
        walls += 1;
        return TileCode.WALL;
      },
    };
    const { map } = run('resolves', { grid, nbSpots: 0 }, { w: 31, h: 19 });
    const open = Array.from(map.tiles).filter((t) => t === TileCode.FLOOR).length;
    expect(walls).toBe(31 * 19 - open);
    expect(floors).toBe(31 * 19 + open);
  });

  it('pins the zone tables to upstream`s', () => {
    expect(FOREST_TROLLMIRE).toMatchObject({
      width: 65,
      height: 40,
      map: {
        class: 'Forest',
        edgeEntrances: [4, 6],
        zoom: 4,
        sqrtPercent: 30,
        noise: 'fbm_perlin',
        addRoad: true,
        doPonds: { nb: [0, 2], size: { w: 25, h: 25 } },
        nbRooms: [0, 0, 0, 1],
        rooms: ['lesser_vault'],
        liteRoomChance: 100,
      },
    });
    expect(FOREST_TROLLMIRE.map.class === 'Forest' && FOREST_TROLLMIRE.map.doPonds?.pond).toEqual([
      [0.6, TileCode.DEEPWATER],
      [0.8, TileCode.DEEPWATER],
    ]);
    expect(FOREST_GOLEM_GRAVEYARD).toMatchObject({
      width: 30,
      height: 30,
      map: {
        class: 'Forest',
        edgeEntrances: [4, 6],
        zoom: 4,
        sqrtPercent: 70,
        noise: 'fbm_perlin',
      },
    });
    expect(ROOMER_OLD_FOREST).toMatchObject({
      width: 50,
      height: 50,
      map: {
        class: 'Roomer',
        nbRooms: 11,
        edgeEntrances: [4, 6],
        rooms: ['forest_clearing', ['lesser_vault', 8]],
        roomsConfig: { forestClearing: { pitChance: 5 } },
      },
    });
  });

  it('pins the zone tables` grid keys, air_level, filters and last stairs', () => {
    const troll = FOREST_TROLLMIRE.map;
    const golem = FOREST_GOLEM_GRAVEYARD.map;
    const old = ROOMER_OLD_FOREST.map;
    expect(troll).toMatchObject({
      airLevel: [TileCode.DEEPWATER],
      forceLastStair: true,
      grid: {
        wall: TileCode.TREES,
        up: TileCode.GREEN,
        down: TileCode.GREEN,
        door: TileCode.GREEN,
        road: TileCode.YARD,
        '#': TileCode.TREES,
      },
    });
    // `'.'` IS the floor function, so a tunnel cell draws as upstream's `floor` does.
    expect(troll.grid['.']).toBe(troll.grid['floor']);
    expect(golem).toMatchObject({
      forceLastStair: true,
      grid: { wall: TileCode.TREES, up: TileCode.GREEN, down: TileCode.GREEN },
    });
    expect(golem.grid['floor']).toBe(troll.grid['floor']);
    expect(old).toMatchObject({
      forceLastStair: true,
      grid: {
        '.': TileCode.GREEN,
        '#': TileCode.TREES,
        up: TileCode.GREEN,
        down: TileCode.GREEN,
        door: TileCode.GREEN,
      },
    });
    expect(old.class === 'Roomer' && old.roomsConfig?.forestClearing?.filters).toEqual([
      { type: 'insect', subtype: 'ant' },
      { type: 'insect' },
      { type: 'animal', subtype: 'snake' },
      { type: 'animal', subtype: 'canine' },
    ]);
  });

  it('floors the Trollmire in flowers one time in twenty: `rng.chance(20)`, not a percent', () => {
    // `data/zones/trollmire/zone.lua:177`: FLOWER on `rng.chance(20)`, else GRASS.
    const floor = FOREST_TROLLMIRE.map.grid['floor'];
    if (typeof floor !== 'function') throw new Error('the Trollmire floor is not a function');
    const rng = createRng('flowers');
    const twin = createRng('flowers');
    let flowers = 0;
    for (let n = 0; n < 400; n += 1) {
      const want = twin.int('chance', 0, 19) === 0 ? TileCode.HEATH : TileCode.GREEN;
      expect(floor(rng)).toBe(want);
      if (want === TileCode.HEATH) flowers += 1;
    }
    expect(flowers).toBeGreaterThan(5);
    expect(flowers).toBeLessThan(40);
  });

  it('writes Forest:init`s defaults for every field a zone leaves out', () => {
    // `engine/generator/map/Forest.lua:30-57`, RoomsLoader's tunnel defaults, and
    // `lite_room_chance`'s `or 100` (`engine/generator/map/RoomsLoader.lua:625`).
    const rng = createRng('defaults');
    const map = createGenMap(10, 10, PLAIN, rng);
    const gen = createForest(map, { grid: PLAIN }, rng, { maxLevel: 3 }, { forceRecreate: null });
    expect(gen.data).toMatchObject({
      noise: 'fbm_perlin',
      zoom: 5,
      maxPercent: 80,
      sqrtPercent: 30,
      octave: 4,
      nbSpots: 10,
      addRoad: false,
      endRoad: false,
      tunnelChange: 30,
      tunnelRandom: 10,
      liteRoomChance: 100,
    });
    expect(gen.data.sqrtPercent2).toBeUndefined();
  });

  it('draws nb_spots clearing spots out of the candidates, each once', () => {
    for (let s = 0; s < 10; s += 1) {
      const seed = `spots:${String(s)}`;
      const want = rollLayer(seed, 40, 30, { zoom: 5, maxPercent: 80, sqrtPercent: 30, octave: 4 });
      const { result } = run(seed, { nbSpots: 7 });
      const spots = (result?.spots ?? []).filter((sp) => sp.type === 'clearing');
      expect(spots).toHaveLength(7);
      expect(new Set(spots.map((sp) => key(sp.x, sp.y))).size).toBe(7);
      for (const sp of spots) expect(want.candidates.has(key(sp.x, sp.y))).toBe(true);
    }
  });

  it('is the same forest for the same seed and a different one for another', () => {
    const a = run('same', { ...FOREST_TROLLMIRE.map, grid: WOODS }, { w: 65, h: 40 });
    const b = run('same', { ...FOREST_TROLLMIRE.map, grid: WOODS }, { w: 65, h: 40 });
    const c = run('other', { ...FOREST_TROLLMIRE.map, grid: WOODS }, { w: 65, h: 40 });
    expect(Array.from(a.map.tiles)).toEqual(Array.from(b.map.tiles));
    expect(Array.from(a.map.tiles)).not.toEqual(Array.from(c.map.tiles));
  });
});

/**
 * Forest.lua:59-135 again, with 1-based nested tables whose holes are Lua's
 * nils. Returns `pmap`.
 */
function luaPond(
  rng: Rng,
  sw: number,
  sh: number,
  pond: readonly (readonly [number, number])[],
): (number | undefined)[][] {
  const zoom = 5;
  const octave = 5;
  const noise = createNoise2(rng, 'pond', sw, sh);
  const nmap: number[][] = [];
  const pmap: (number | undefined)[][] = [];
  const N = (i: number): number[] | undefined => nmap[i];
  const P = (i: number): (number | undefined)[] | undefined => pmap[i];
  const lowest = { v: 100, x: 0, y: 0 };
  for (let i = 1; i <= sw; i += 1) {
    nmap[i] = [];
    pmap[i] = [];
    for (let j = 1; j <= sh; j += 1) {
      const v = noise.fbmSimplex((zoom * i) / sw, (zoom * j) / sh, octave);
      (nmap[i] as number[])[j] = v;
      if (v < lowest.v) Object.assign(lowest, { v, x: i, y: j });
    }
  }
  const quadrant = (i: number, j: number): void => {
    const highest = { v: -100 };
    for (const { x, y } of line(lowest.x, lowest.y, i, j)) {
      const n = N(x)?.[y];
      if (n !== undefined && n > highest.v) highest.v = n;
    }
    const split = highest.v + lowest.v;
    for (const { x, y } of line(lowest.x, lowest.y, i, j)) {
      let stop = true;
      for (const [frac, grid] of pond) {
        const n = N(x)?.[y];
        if (n !== undefined && n < split * frac) {
          (pmap[x] as (number | undefined)[])[y] = grid;
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
  for (let i = 1; i <= sw; i += 1) {
    for (let j = 1; j <= sh; j += 1) {
      const g = [
        P(i - 1)?.[j + 1],
        P(i)?.[j + 1],
        P(i + 1)?.[j + 1],
        P(i - 1)?.[j],
        P(i + 1)?.[j],
        P(i - 1)?.[j - 1],
        P(i)?.[j - 1],
        P(i + 1)?.[j - 1],
      ];
      if (g.filter((v) => v !== undefined).length < 4)
        (pmap[i] as (number | undefined)[])[j] = undefined;
    }
  }
  return pmap;
}

describe('Forest — ponds', () => {
  // `split` is nearly always negative, so the LARGER fraction is the lower
  // threshold: ordered this way, both entries take cells and the first match wins.
  const POND = [
    [0.8, TileCode.DEEPWATER],
    [0.6, TileCode.WATER],
  ] as const;

  function pondGen(seed: string, w: number, h: number, size: { w: number; h: number }): ForestGen {
    const rng = createRng(seed);
    const map = createGenMap(w, h, WOODS, rng);
    for (let x = 0; x < w; x += 1) for (let y = 0; y < h; y += 1) map.set(x, y, TileCode.GREEN);
    return createForest(
      map,
      { grid: WOODS, doPonds: { nb: [1, 1], size, pond: POND } },
      rng,
      { maxLevel: 3 },
      { forceRecreate: null },
    );
  }

  it('cuts water along lines from the lowest point, first matching entry, smoothed in place — as the Lua does', () => {
    const water = { deep: 0, shallow: 0 };
    for (let s = 0; s < 30; s += 1) {
      const size = { w: 8 + (s % 18), h: 8 + ((s * 7) % 18) };
      const seed = `pond:${String(s)}`;
      const gen = pondGen(seed, 30, 32, size);
      const spots: Spot[] = [];
      addPond(gen, 3, 5, spots);
      const want = luaPond(createRng(seed), size.w, size.h, POND);
      const got: string[] = [];
      const expected: string[] = [];
      for (let x = 0; x < 30; x += 1) {
        for (let y = 0; y < 32; y += 1) {
          const grid = want[x - 3 + 1]?.[y - 5 + 1];
          if (grid === TileCode.DEEPWATER) water.deep += 1;
          if (grid === TileCode.WATER) water.shallow += 1;
          const cell = gen.map.cell(x, y);
          got.push(`${String(gen.map.get(x, y))}:${String(cell.special)}`);
          expected.push(
            grid === undefined ? `${String(TileCode.GREEN)}:null` : `${String(grid)}:pond`,
          );
        }
      }
      expect(got).toEqual(expected);
      expect(spots).toEqual([{ x: 3, y: 5, type: 'pond', subtype: 'pond' }]);
    }
    expect(Math.min(water.deep, water.shallow)).toBeGreaterThan(20);
  });

  it('paints only the part of a pond that lies on the map', () => {
    const gen = pondGen('pond-edge', 40, 30, { w: 25, h: 25 });
    addPond(gen, 10, 20, []);
    const want = luaPond(createRng('pond-edge'), 25, 25, POND);
    let off = 0;
    for (let i = 1; i <= 25; i += 1) {
      for (let j = 1; j <= 25; j += 1) {
        if (want[i]?.[j] === undefined) continue;
        if (j - 1 + 20 >= 30) off += 1;
        else expect(gen.map.cell(i - 1 + 10, j - 1 + 20).special).toBe('pond');
      }
    }
    expect(off).toBeGreaterThan(0);
  });

  it('draws the pond count once, then each pond`s x, its y, and its own noise, in that order', () => {
    for (const nb of [1, 2]) {
      const { rng, labels } = recording(`pond-draws:${String(nb)}`);
      run(
        rng,
        { grid: WOODS, doPonds: { nb: [nb, 2], size: { w: 12, h: 12 }, pond: POND } },
        { w: 50, h: 30 },
      );
      const seq = labels
        .filter((l) => l.startsWith('mapgen.forest.pond'))
        .filter((l, i, all) => l !== all[i - 1]);
      const pond = [
        'mapgen.forest.ponds.x',
        'mapgen.forest.ponds.y',
        'mapgen.forest.pond.noise.gradient',
        'mapgen.forest.pond.noise.map',
      ];
      // `range(2, 2)` draws nothing; `range(1, 2)` draws once.
      const count = labels.filter((l) => l === 'mapgen.forest.ponds.nb').length;
      expect(count).toBe(nb === 2 ? 0 : 1);
      const ponds = (seq.length - count) / pond.length;
      expect(seq).toEqual([
        ...(count === 1 ? ['mapgen.forest.ponds.nb'] : []),
        ...Array.from({ length: ponds }, () => pond).flat(),
      ]);
      expect(ponds).toBeGreaterThanOrEqual(nb);
    }
  });

  it('keeps ponds inside their placement margins, and marks every water cell', () => {
    // NOT SQUARE, so a margin taken from the wrong side shows: x in 12..38 from
    // the width, y in 8..22 from the height.
    const ys: number[] = [];
    for (let s = 0; s < 15; s += 1) {
      const { map, result } = run(
        `ponds:${String(s)}`,
        {
          grid: WOODS,
          doPonds: { nb: [0, 2], size: { w: 12, h: 8 }, pond: POND },
          edgeEntrances: [4, 6],
        },
        { w: 50, h: 30 },
      );
      const ponds = (result?.spots ?? []).filter((sp) => sp.type === 'pond');
      for (const p of ponds) {
        expect(p.x).toBeGreaterThanOrEqual(12);
        expect(p.x).toBeLessThanOrEqual(38);
        expect(p.y).toBeGreaterThanOrEqual(8);
        expect(p.y).toBeLessThanOrEqual(22);
        ys.push(p.y);
      }
      for (let x = 0; x < 50; x += 1) {
        for (let y = 0; y < 30; y += 1) {
          const code = map.get(x, y);
          if (code === TileCode.WATER || code === TileCode.DEEPWATER) {
            expect(map.cell(x, y).special).toBe('pond');
          }
        }
      }
    }
    expect(ys.length).toBeGreaterThan(8);
    expect(Math.min(...ys) < 12 || Math.max(...ys) > 18, 'y kept to the width`s margin').toBe(true);
  });
});

describe('Forest — stairs', () => {
  it('puts each stair on its edge, corners included, marked exit, on a tree as readily as grass', () => {
    const sides = [
      [4, 6],
      [6, 4],
      [8, 2],
      [2, 8],
    ] as const;
    for (const [upSide, downSide] of sides) {
      // Where along its edge each stair fell: `0..len-1`, both ends included.
      const along = { up: new Set<number>(), down: new Set<number>() };
      for (let s = 0; s < 60; s += 1) {
        const { map, result } = run(
          `edges:${String(upSide)}:${String(s)}`,
          { ...ALL_TREES, grid: WOODS, edgeEntrances: [upSide, downSide] },
          { w: 6, h: 5 },
        );
        const { up, down } = result ?? { up: null, down: null };
        if (up === null || down === null) throw new Error('a stair is missing');
        const onEdge = (at: TileXY, side: number): boolean =>
          side === 4 ? at.x === 0 : side === 6 ? at.x === 5 : side === 8 ? at.y === 0 : at.y === 4;
        expect(onEdge(up, upSide)).toBe(true);
        expect(onEdge(down, downSide)).toBe(true);
        for (const at of [up, down]) {
          expect(map.cell(at.x, at.y).special).toBe('exit');
          expect(map.get(at.x, at.y)).toBe(TileCode.GREEN);
        }
        along.up.add(upSide === 4 || upSide === 6 ? up.y : up.x);
        along.down.add(downSide === 4 || downSide === 6 ? down.y : down.x);
      }
      const len = upSide === 4 || upSide === 6 ? 5 : 6;
      expect([...along.up].sort()).toEqual(Array.from({ length: len }, (_, i) => i));
      expect([...along.down].sort()).toEqual(Array.from({ length: len }, (_, i) => i));
    }
  });

  it('places the DOWN stair first on its edge, then the up stair on its own', () => {
    // `engine/generator/map/Forest.lua:497-541`: down, then up.
    let differ = 0;
    for (let s = 0; s < 30; s += 1) {
      const rng = createRng(`side-order:${String(s)}`);
      const map = createGenMap(12, 9, WOODS, rng);
      for (let x = 0; x < 12; x += 1) for (let y = 0; y < 9; y += 1) map.set(x, y, TileCode.GREEN);
      const data = { grid: WOODS, edgeEntrances: [4, 6] as const };
      const gen = createForest(map, data, rng, { maxLevel: 3 }, { forceRecreate: null });
      const twin = rngFromState(rng.getState());
      const { up, down } = makeStairsSides(gen, 1, 0, [4, 6], []);
      const first = twin.int('down', 0, 8);
      const second = twin.int('up', 0, 8);
      expect(down, `seed ${String(s)}`).toEqual({ x: 11, y: first });
      expect(up, `seed ${String(s)}`).toEqual({ x: 0, y: second });
      if (first !== second) differ += 1;
    }
    expect(differ).toBeGreaterThan(10);
  });

  it('places the DOWN stair first inside too: the first open cell the draws reach', () => {
    // `engine/generator/map/Forest.lua:460-494`.
    let downOnTheLowerCell = 0;
    for (let s = 0; s < 40; s += 1) {
      const rng = createRng(`inside-order:${String(s)}`);
      const map = createGenMap(8, 8, PLAIN, rng);
      for (let x = 0; x < 8; x += 1) for (let y = 0; y < 8; y += 1) map.set(x, y, TileCode.WALL);
      map.set(7, 7, TileCode.FLOOR);
      map.set(3, 4, TileCode.FLOOR);
      const gen = createForest(map, { grid: PLAIN }, rng, { maxLevel: 3 }, { forceRecreate: null });
      const twin = rngFromState(rng.getState());
      const { up, down } = makeStairsInside(gen, 1, 0, []);
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
      expect(`${String(down?.x)},${String(down?.y)}`, `seed ${String(s)}`).toBe(first);
      expect(`${String(up?.x)},${String(up?.y)}`, `seed ${String(s)}`).toBe(next());
      if (first === '3,4') downOnTheLowerCell += 1;
    }
    expect(downOnTheLowerCell).toBeGreaterThan(5);
    expect(downOnTheLowerCell).toBeLessThan(35);
  });

  it('places no down stair on the zone`s last level unless forced', () => {
    const last = run('last', { edgeEntrances: [4, 6] }, { level: 3, maxLevel: 3 });
    expect(last.result?.down).toBeNull();
    expect(last.result?.up).not.toBeNull();
    const forced = run(
      'last',
      { edgeEntrances: [4, 6], forceLastStair: true },
      { level: 3, maxLevel: 3 },
    );
    expect(forced.result?.down).not.toBeNull();
  });

  it('without edge_entrances, puts both stairs inside on open cells, off the far-left column and top row', () => {
    let treeCells = 0;
    for (let s = 0; s < 30; s += 1) {
      // No `up`/`down` keys, so a stair cell keeps the terrain it was found on;
      // a dense wood, so a search that did not test `block_move` would land on trees.
      const dense = { grid: PLAIN, maxPercent: 140, sqrtPercent: 0 };
      const { map, result } = run(`inside:${String(s)}`, dense, { w: 12, h: 10 });
      treeCells += Array.from(map.tiles).filter((t) => t === TileCode.WALL).length;
      for (const at of [result?.up, result?.down]) {
        if (at === null || at === undefined) throw new Error('a stair is missing');
        expect(at.x).toBeGreaterThanOrEqual(1);
        expect(at.y).toBeGreaterThanOrEqual(1);
        expect(map.cell(at.x, at.y).special).toBe('exit');
        expect(map.get(at.x, at.y)).not.toBe(TileCode.WALL);
      }
    }
    expect(treeCells).toBeGreaterThan(30 * 12 * 10 * 0.5);
  });
});

describe('Forest — rooms', () => {
  it('places no room when nb_rooms is absent (Forest`s default is 0, not Roomer`s 10)', () => {
    const { map } = run('no-rooms', { ...NO_TREES, rooms: ['simple'] });
    expect(map.rooms).toEqual([]);
  });

  it('rings its rooms with tunnels, which cut through the trees', () => {
    for (let s = 0; s < 10; s += 1) {
      const woods = { ...ALL_TREES, grid: WOODS, rooms: ['simple'], nbRooms: 3 };
      const { map } = run(`ring:${String(s)}`, woods, { w: 50, h: 40 });
      expect(map.rooms.length).toBeGreaterThan(1);
      const first = map.rooms[0];
      if (first === undefined) throw new Error('no room');
      const open = (x: number, y: number): boolean => isWalkable(map.get(x, y) ?? TileCode.WALL);
      const seen = reach(50, 40, { x: first.cx, y: first.cy }, open, true);
      for (const r of map.rooms) expect(seen.has(key(r.cx, r.cy))).toBe(true);

      const shut = run(`ring:${String(s)}`, { ...woods, noTunnels: true }, { w: 50, h: 40 });
      const alone = reach(
        50,
        40,
        { x: first.cx, y: first.cy },
        (x, y) => isWalkable(shut.map.get(x, y) ?? TileCode.WALL),
        true,
      );
      expect(
        shut.map.rooms.every((r) => r === shut.map.rooms[0] || !alone.has(key(r.cx, r.cy))),
      ).toBe(true);
    }
  });

  it('spends a placed required room out of nb_rooms', () => {
    // One required money vault and `nb_rooms = 2` leave ONE random room, tried
    // at most `1 * 1.5` times: never a third room.
    let both = 0;
    for (let s = 0; s < 12; s += 1) {
      const { map } = run(
        `required-spends:${String(s)}`,
        { ...NO_TREES, nbRooms: 2, rooms: ['simple'], requiredRooms: ['money_vault'] },
        { w: 50, h: 40 },
      );
      expect(map.rooms[0]?.room.name).toBe('money_vault5x5');
      expect(map.rooms.length, `seed ${String(s)}`).toBeLessThanOrEqual(2);
      if (map.rooms.length === 2) both += 1;
    }
    expect(both).toBeGreaterThan(6);
  });

  it('tries random rooms nb_rooms * 1.5 times, counted as a float, and never spends a failed one', () => {
    // `engine/generator/map/Forest.lua:251-266`: `tries = nb_room * 1.5`, one
    // off per attempt, and `nb_room` only falls when a room places. So a level
    // that places fewer than asked made EXACTLY ceil(nb * 1.5) attempts.
    let short = 0;
    let replaced = 0;
    for (const nb of [3, 4]) {
      for (let s = 0; s < 30; s += 1) {
        const { map } = run(
          `tries:${String(nb)}:${String(s)}`,
          { ...NO_TREES, nbRooms: nb, rooms: ['simple'] },
          { w: 20, h: 20 },
        );
        const placed = map.rooms.length;
        const attempts = placed + map.roomsFailed.length;
        expect(placed).toBeLessThanOrEqual(nb);
        expect(attempts).toBeLessThanOrEqual(Math.ceil(nb * 1.5));
        if (placed < nb) {
          short += 1;
          expect(attempts, `nb ${String(nb)} seed ${String(s)}`).toBe(Math.ceil(nb * 1.5));
        } else if (map.roomsFailed.length > 0) {
          replaced += 1;
        }
      }
    }
    expect(short, 'every level placed every room, so the try count went unchecked').toBeGreaterThan(
      3,
    );
    expect(replaced, 'no failed room was ever made up for').toBeGreaterThan(3);
  });

  it('rolls a chance room`s percent every time it is picked', () => {
    const { rng, labels } = recording('forest-chance-rooms');
    run(rng, { ...NO_TREES, nbRooms: 2, rooms: [['simple', 50]] }, { w: 50, h: 40 });
    expect(labels.filter((l) => l === 'mapgen.forest.room.chance').length).toBeGreaterThanOrEqual(
      2,
    );
  });

  it('asks for the level again when a required room cannot be placed', () => {
    const { result, forceRecreate } = run('required', {
      requiredRooms: ['lesser_vault'],
      lesserVaultsList: [],
    });
    expect(result).toBeNull();
    expect(forceRecreate).toBe('required_room lesser_vault');
  });

  it('puts the end room far from the up stair on edges 4 and 6, and NEAR it on 2 and 8 (upstream`s bug)', () => {
    const rules = [
      { edges: [4, 6], far: (x: number) => x >= 40 * 0.66, axis: 'x' },
      { edges: [6, 4], far: (x: number) => x <= 40 * 0.33, axis: 'x' },
      // Up on the bottom edge, and the room must be at the bottom too.
      { edges: [2, 8], far: (y: number) => y >= 40 * 0.66, axis: 'y' },
      // Up on the top edge, and the room must be at the top too.
      { edges: [8, 2], far: (y: number) => y <= 40 * 0.33, axis: 'y' },
    ] as const;
    for (const rule of rules) {
      for (let s = 0; s < 8; s += 1) {
        const { map, result } = run(
          `end-room:${String(rule.edges[0])}:${String(s)}`,
          { ...NO_TREES, grid: WOODS, edgeEntrances: rule.edges, endRoadRoom: 'simple' },
          { w: 40, h: 40 },
        );
        expect(result).not.toBeNull();
        const room = map.rooms[0];
        if (room === undefined) throw new Error('no end room');
        expect(rule.far(rule.axis === 'x' ? room.x : room.y)).toBe(true);
      }
    }
  });

  it('asks for the level again when the end room cannot be placed far enough', () => {
    // A clearing is at least 6 wide, so on a 20-wide map its x is at most 13,
    // and 66% in is 13.2.
    const { result, forceRecreate } = run(
      'end-room-fails',
      { ...NO_TREES, edgeEntrances: [4, 6], endRoadRoom: 'forest_clearing' },
      { w: 20, h: 20 },
    );
    expect(result).toBeNull();
    expect(forceRecreate).toBe('end_room forest_clearing');
  });
});

describe('Forest — the road', () => {
  it('refuses add_road without edge_entrances, which upstream crashes on', () => {
    expect(() => run('no-edges', { addRoad: true })).toThrow(/edge_entrances/);
  });

  it('joins the stairs through solid forest on every pair of edges', () => {
    const sides = [
      [4, 6],
      [6, 4],
      [8, 2],
      [2, 8],
    ] as const;
    for (const edges of sides) {
      for (let s = 0; s < 10; s += 1) {
        const { map, result } = run(
          `road:${String(edges[0])}:${String(s)}`,
          { ...ALL_TREES, grid: WOODS, edgeEntrances: edges, addRoad: true },
          { w: 30, h: 20 },
        );
        const { up, down } = result ?? { up: null, down: null };
        if (up === null || down === null) throw new Error('a stair is missing');
        const codes = new Set(map.tiles);
        expect([...codes].sort()).toEqual([TileCode.GREEN, TileCode.TREES, TileCode.YARD].sort());
        // The stairs keep their own terrain: the road skips special cells.
        expect(map.get(up.x, up.y)).toBe(TileCode.GREEN);
        expect(map.get(down.x, down.y)).toBe(TileCode.GREEN);
        const open = (x: number, y: number): boolean => map.get(x, y) !== TileCode.TREES;
        expect(reach(30, 20, up, open, false).has(key(down.x, down.y))).toBe(true);
      }
    }
  });

  it('ends at the end room`s top-left when end_road is set, and not at the down stair', () => {
    for (let s = 0; s < 8; s += 1) {
      const { map, result } = run(
        `ending:${String(s)}`,
        {
          ...ALL_TREES,
          grid: WOODS,
          edgeEntrances: [4, 6],
          addRoad: true,
          endRoad: true,
          endRoadRoom: 'forest_clearing',
        },
        { w: 40, h: 30 },
      );
      const room = map.rooms[0];
      if (room === undefined || result === null) throw new Error('no end room');
      expect(map.get(room.x, room.y)).toBe(TileCode.YARD);
      for (let x = 0; x < 40; x += 1) {
        for (let y = 0; y < 30; y += 1) {
          if (map.get(x, y) === TileCode.YARD) expect(x).toBeLessThanOrEqual(room.x);
        }
      }
    }
  });

  it('takes waypoints in Lua`s sorted order, each judged against the last one taken, never on a special or border cell', () => {
    let taken = 0;
    let refusals = 0;
    const sides = [
      [4, 6],
      [6, 4],
      [8, 2],
      [2, 8],
    ] as const;
    for (const edges of sides) {
      for (let s = 0; s < 25; s += 1) {
        const w = 65;
        const h = 40;
        const { gen, result } = run(
          `waypoints:${String(edges[0])}:${String(s)}`,
          { ...NO_TREES, grid: WOODS, edgeEntrances: edges, rooms: ['simple'], nbRooms: 2 },
          { w, h },
        );
        const { up, down } = result ?? { up: null, down: null };
        if (up === null) throw new Error('no up stair');
        const axis = edges[0] === 2 || edges[0] === 8 ? 'y' : 'x';
        // Bands of flagged cells, so the refusal decides something.
        for (let x = 0; x < w; x += 1) {
          for (let y = 0; y < h; y += 1) {
            const cell = gen.map.cell(x, y);
            if (x % 5 === 2) cell.border = 1;
            if (y % 6 === 3 && cell.special === null) cell.special = true;
          }
        }
        const before = gen.rng.getState();
        const got = roadWaypoints(gen, up, down, axis, null);

        const rng = rngFromState(before);
        const points: TileXY[] = [];
        for (let i = 0; i < 30; i += 1) {
          const x = rng.int('x', 0, w - 1);
          points.push({ x, y: rng.int('y', 0, h - 1) });
        }
        const [start, finish, lt] =
          edges[0] === 2
            ? [0, h, (a: TileXY, b: TileXY) => b.y > a.y]
            : edges[0] === 4
              ? [0, w, (a: TileXY, b: TileXY) => b.x > a.x]
              : edges[0] === 6
                ? [w, 0, (a: TileXY, b: TileXY) => b.x < a.x]
                : [h, 0, (a: TileXY, b: TileXY) => b.y < a.y];
        tableSort(points, lt);
        const want: TileXY[] = [up];
        for (const p of points) {
          const cell = gen.map.cell(p.x, p.y);
          const refused = cell.special !== null || cell.border !== null;
          const valid = checkValid(p, want[want.length - 1] ?? up, axis, start, finish) === true;
          if (refused && valid) refusals += 1;
          if (!refused && valid) want.push(p);
        }
        if (down !== null) want.push(down);
        expect(got).toEqual(want);
        taken += want.length - 2;
      }
    }
    expect(taken).toBeGreaterThan(50);
    expect(refusals).toBeGreaterThan(20);
  });
});

describe('checkValid', () => {
  it('asks for more than 2 of progress, more than 4 short of the finish, and a fifth of the span sideways', () => {
    const last = { x: 0, y: 10 };
    expect(checkValid({ x: 2, y: 10 }, last, 'x', 0, 65)).toBe(
      'not enough progress from previous waypoint',
    );
    expect(checkValid({ x: 3, y: 10 }, last, 'x', 0, 65)).toBe(true);
    expect(checkValid({ x: 60, y: 10 }, last, 'x', 0, 65)).toBe(true);
    expect(checkValid({ x: 61, y: 10 }, last, 'x', 0, 65)).toBe('measure too close to finish');
    expect(checkValid({ x: 30, y: 22 }, last, 'x', 0, 65)).toBe(true);
    expect(checkValid({ x: 30, y: 23 }, last, 'x', 0, 65)).toBe(
      'on non-progress axis, the measure was more than 20% different from previous',
    );
    expect(checkValid({ x: 10, y: 5 }, { x: 10, y: 1 }, 'y', 0, 40)).toBe(true);
  });

  it('keeps the progess typo: toward 0, only a waypoint whose coordinate and the last one`s sum under 2 passes', () => {
    // Fixed, -10 > -64 - 2 would pass.
    expect(checkValid({ x: 10, y: 10 }, { x: 64, y: 10 }, 'x', 65, 0)).toBe(
      'not enough progress from previous waypoint',
    );
    expect(checkValid({ x: 0, y: 10 }, { x: 1, y: 10 }, 'x', 65, 0)).toBe(true);
    expect(checkValid({ x: 1, y: 10 }, { x: 1, y: 10 }, 'x', 65, 0)).toBe(
      'not enough progress from previous waypoint',
    );
  });

  it('measures the sideways span against the NEGATED finish', () => {
    // |10 - (-3)| * 0.2 = 2.6 allows 2 sideways; |10 - 3| * 0.2 = 1.4 would not.
    expect(checkValid({ x: 7, y: 0 }, { x: 5, y: 0 }, 'y', 10, 3)).toBe(true);
  });
});

describe('makeRoad', () => {
  function strip(seed: string): ForestGen {
    const rng = createRng(seed);
    const map = createGenMap(12, 7, WOODS, rng);
    for (let x = 0; x < 12; x += 1) for (let y = 0; y < 7; y += 1) map.set(x, y, TileCode.GREEN);
    return createForest(map, { grid: WOODS }, rng, { maxLevel: 3 }, { forceRecreate: null });
  }
  const withAir = (gen: ForestGen): ForestGen => ({
    ...gen,
    data: { ...gen.data, airLevel: [TileCode.DEEPWATER] },
  });

  it('routes 4-way round air_level terrain, through anything else, and paints no special cell', () => {
    const gen = withAir(strip('air'));
    for (let y = 0; y <= 5; y += 1) gen.map.set(5, y, TileCode.DEEPWATER);
    for (let y = 0; y <= 6; y += 1) gen.map.set(3, y, TileCode.TREES);
    gen.map.cell(8, 0).special = 'exit';
    makeRoad(gen, 0, 0, 11, 0, 'road');
    for (let y = 0; y <= 5; y += 1) expect(gen.map.get(5, y)).toBe(TileCode.DEEPWATER);
    expect(gen.map.get(5, 6)).toBe(TileCode.YARD);
    const road = (x: number, y: number): boolean =>
      gen.map.get(x, y) === TileCode.YARD ||
      (x === 0 && y === 0) ||
      gen.map.cell(x, y).special === 'exit';
    expect(reach(12, 7, { x: 0, y: 0 }, road, false).has(key(11, 0))).toBe(true);
    expect([0, 1, 2, 3, 4, 5, 6].some((y) => gen.map.get(3, y) === TileCode.YARD)).toBe(true);
  });

  it('crosses the same water when nothing is air_level', () => {
    const gen = strip('no-air');
    for (let y = 0; y <= 5; y += 1) gen.map.set(5, y, TileCode.DEEPWATER);
    makeRoad(gen, 0, 0, 11, 0, 'road');
    expect([0, 1, 2, 3, 4, 5].some((y) => gen.map.get(5, y) === TileCode.YARD)).toBe(true);
  });

  it('falls back to a straight line, through a door and across pond water, up to the first thing that blocks a body', () => {
    // The target is water, so the A* has no route. The line then walks on: a
    // door opens, ToME's deep water is walkable (`data/general/grids/water.lua:136-140`)
    // and its pond cell is special so it stays water, and a tree stops it.
    const gen = withAir(strip('direct'));
    gen.map.set(11, 3, TileCode.DEEPWATER);
    gen.map.set(4, 3, TileCode.DOOR);
    gen.map.set(6, 3, TileCode.DEEPWATER);
    gen.map.cell(6, 3).special = 'pond';
    gen.map.set(8, 3, TileCode.TREES);
    makeRoad(gen, 0, 3, 11, 3, 'road');
    const row = Array.from({ length: 12 }, (_, x) => gen.map.get(x, 3));
    expect(row).toEqual([
      TileCode.GREEN,
      TileCode.YARD,
      TileCode.YARD,
      TileCode.YARD,
      TileCode.YARD,
      TileCode.YARD,
      TileCode.DEEPWATER,
      TileCode.YARD,
      TileCode.TREES,
      TileCode.GREEN,
      TileCode.GREEN,
      TileCode.DEEPWATER,
    ]);
    for (const y of [0, 1, 2, 4, 5, 6]) {
      for (let x = 0; x < 12; x += 1) expect(gen.map.get(x, y)).toBe(TileCode.GREEN);
    }
  });
});

/** Up to down, 8-way, a shut door passable: `Zone:newLevel`'s own question, asked independently. */
function joined(m: AuthoredMap): boolean {
  const { w, h, tiles } = m.view;
  const up = m.spawns[0];
  if (up === undefined || m.down === undefined) return false;
  const open = (x: number, y: number): boolean => {
    const code = tiles[y * w + x] ?? TileCode.WALL;
    return code === TileCode.DOOR || isWalkable(code);
  };
  return reach(w, h, up, open, true).has(key(m.down.x, m.down.y));
}

describe('the forest zones through newLevel', () => {
  const zones: [string, LevelSpec, number][] = [
    ['trollmire', FOREST_TROLLMIRE, 3],
    ['golem-graveyard', FOREST_GOLEM_GRAVEYARD, 1],
    ['old-forest', ROOMER_OLD_FOREST, 4],
  ];

  for (const [name, spec, maxLevel] of zones) {
    it(`${name}: certifies every seed, stairs on the left and right edges, joined`, () => {
      for (let s = 0; s < 30; s += 1) {
        const level = newLevel(spec, `${name}:${String(s)}`, { level: 1, maxLevel });
        expect(level.failed).toBe(false);
        // The road goes round deep water, so no pond cuts it and no Trollmire
        // level needs a second attempt.
        if (name === 'trollmire') expect(level.attempts, `${name}:${String(s)}`).toBe(1);
        expect(level.map.view.w).toBe(spec.width);
        expect(level.map.spawns[0]?.x).toBe(0);
        expect(level.map.down?.x).toBe(spec.width - 1);
        expect(joined(level.map)).toBe(true);
      }
    });
  }

  it('the Trollmire has its road, and ponds and a vault on some levels', () => {
    let ponds = 0;
    let vaults = 0;
    for (let s = 0; s < 30; s += 1) {
      const { map } = newLevel(FOREST_TROLLMIRE, `trollmire:${String(s)}`, {
        level: 1,
        maxLevel: 3,
      });
      expect(map.view.tiles.includes(TileCode.YARD)).toBe(true);
      if (map.view.tiles.includes(TileCode.DEEPWATER)) ponds += 1;
      vaults += map.vaults?.length ?? 0;
    }
    expect(ponds).toBeGreaterThan(5);
    expect(vaults).toBeGreaterThan(0);
  });

  it('the Old Forest is clearings in trees', () => {
    for (let s = 0; s < 10; s += 1) {
      const { map } = newLevel(ROOMER_OLD_FOREST, `old-forest:${String(s)}`, {
        level: 1,
        maxLevel: 4,
      });
      const trees = map.view.tiles.filter((t) => t === TileCode.TREES).length;
      expect(trees / map.view.tiles.length).toBeGreaterThan(0.5);
    }
  });
});
