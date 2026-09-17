// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// The generator under test is ported from t-engine4 game/engines/default/engine/generator/map/Hexacle.lua:27-280,
// and its table emulation from LuaJIT 2.0.2's lj_tab.c as T-Engine4 vendors it (tag tome-1.6.0).
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

import { describe, expect, it } from 'vitest';

import type { TileXY } from '../../../src/shared/coords.ts';
import { reachable } from '../../../src/shared/mapgen/connectivity.ts';
import { blockSight, fovLine, lineCells } from '../../../src/shared/mapgen/fovline.ts';
import { createGenMap } from '../../../src/shared/mapgen/genmap.ts';
import type { GenMap, GridKeys } from '../../../src/shared/mapgen/genmap.ts';
import {
  HEXACLE_INFINITE_DUNGEON,
  HEXACLE_MAX_REBUILDS,
  checkNetwork,
  connectGroups,
  createHexacle,
  digTunnels,
  generate,
  groupSegments,
  luaGet,
  luaLength,
  luaPairs,
  luaSet,
  luaTable,
  makeStairsInside,
  markSegments,
  paintSegments,
  rescueOrphans,
  rollSegments,
} from '../../../src/shared/mapgen/hexacle.ts';
import type {
  HexacleData,
  HexacleGen,
  HexacleGroup,
  HexacleLayer,
  HexacleResult,
  HexacleSegment,
  LuaIntTable,
} from '../../../src/shared/mapgen/hexacle.ts';
import { TileCode } from '../../../src/shared/protocol.ts';
import { percent, range, table, tableSampleIterator } from '../../../src/shared/mapgen/lua.ts';
import { createRng } from '../../../src/shared/rng.ts';
import type { Rng } from '../../../src/shared/rng.ts';

const GRID: GridKeys = {
  '.': TileCode.FLOOR,
  '#': TileCode.WALL,
  up: TileCode.FLOOR,
  down: TileCode.FLOOR,
};

const ID: HexacleData = { ...HEXACLE_INFINITE_DUNGEON.map, grid: GRID };

const RAD = Math.PI / 180;

function hexacle(
  rng: Rng,
  data: HexacleData = ID,
  opts: { w?: number; h?: number; maxLevel?: number } = {},
): { gen: HexacleGen; map: GenMap; level: { forceRecreate: string | null } } {
  const map = createGenMap(opts.w ?? 60, opts.h ?? 60, data.grid, rng);
  const level = { forceRecreate: null as string | null };
  const gen = createHexacle(map, data, rng, { maxLevel: opts.maxLevel ?? 5 }, level);
  return { gen, map, level };
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

/** An Rng whose every `int` is answered by the script, and that refuses anything else. */
function scripted(answer: (label: string, lo: number, hi: number) => number): Rng {
  const refuse = (): never => {
    throw new Error('an unscripted draw');
  };
  return {
    nextU32: refuse,
    nextFloat: refuse,
    int: (label, lo, hi) => answer(label, lo, hi),
    pick: refuse,
    shuffle: refuse,
    fork: refuse,
    getState: refuse,
    setState: refuse,
  };
}

/** Sample in table order (`j = i`), and answer each drop roll from `rolls` in turn. */
function rolled(rolls: readonly number[]): Rng {
  let next = 0;
  return scripted((label, lo) => {
    if (label === 'mapgen.hexacle.segments.order') return lo;
    if (label === 'mapgen.hexacle.segments.miss') {
      const roll = rolls[next];
      next += 1;
      if (roll === undefined) throw new Error('out of rolls');
      return roll;
    }
    throw new Error(`unexpected draw ${label}`);
  });
}

const keysOf = (t: LuaIntTable<unknown>): number[] => luaPairs(t).map(([k]) => k);
const kept = (t: LuaIntTable<unknown>): number[] => keysOf(t).sort((a, b) => a - b);
const at = (x: number, y: number): string => `${String(x)},${String(y)}`;

// ═══════════════════════════════════════════════════════════════════════════

describe('LuaJIT`s # and pairs on a sparse table — pinned to the compiled lj_tab.c', () => {
  // Each row: the keys in the order written, then what `#` and `next` gave in
  // LuaJIT 2.0.2's own table code compiled from the vendored source.
  const PINS: readonly [readonly number[], number, readonly number[]][] = [
    [[], 0, []],
    [[1], 1, [1]],
    [[1, 4], 4, [1, 4]],
    [[4, 1], 1, [1, 4]],
    [[1, 2, 4, 5], 5, [1, 2, 4, 5]],
    [[1, 5, 2, 4], 2, [1, 2, 5, 4]],
    [[1, 2, 3, 6], 3, [1, 2, 3, 6]],
    [[1, 6, 2, 3], 6, [1, 2, 3, 6]],
    [[1, 6, 2, 7], 2, [1, 2, 7, 6]],
    [[1, 2, 3, 4, 5, 6, 8], 8, [1, 2, 3, 4, 5, 6, 8]],
    [[8, 6, 4, 2], 8, [2, 4, 6, 8]],
    [[7, 5, 2], 2, [2, 5, 7]],
    [[1, 3, 5, 7, 8], 8, [1, 3, 5, 7, 8]],
    [[32, 37, 3, 28, 7, 13, 36, 18], 0, [18, 32, 36, 3, 28, 13, 7, 37]],
    [[14, 11, 3, 12, 19, 10, 23, 4], 0, [14, 19, 23, 12, 11, 4, 10, 3]],
    [[34, 49, 4, 45, 38, 41, 35, 29, 30, 42], 0, [34, 49, 29, 45, 4, 35, 30, 42, 41, 38]],
  ];

  it('gives the C`s # and the C`s next order for every pinned insertion order', () => {
    for (const [keys, len, order] of PINS) {
      const t = luaTable<number>();
      for (const k of keys) luaSet(t, k, k * 10);
      expect({ keys, len: luaLength(t), order: keysOf(t) }).toEqual({ keys, len, order });
      for (const k of keys) expect(luaGet(t, k)).toBe(k * 10);
    }
  });

  it('always returns a border, and pairs visits every key once', () => {
    const rng = createRng('luajit.border');
    for (let c = 0; c < 2000; c += 1) {
      const n = rng.int('n', 1, 40);
      const keys = rng.shuffle(
        'keys',
        Array.from({ length: n }, (_, i) => i + 1),
      );
      const count = rng.int('count', 0, n);
      const t = luaTable<true>();
      for (const k of keys.slice(0, count)) luaSet(t, k, true);
      const len = luaLength(t);
      if (len > 0) expect(luaGet(t, len)).toBe(true);
      expect(luaGet(t, len + 1)).toBeUndefined();
      expect(kept(t)).toEqual(keys.slice(0, count).sort((a, b) => a - b));
    }
  });

  it('refuses a key it does not lay out', () => {
    expect(() => luaSet(luaTable(), 1.5, true)).toThrow(RangeError);
    expect(() => luaSet(luaTable(), -1, true)).toThrow(RangeError);
  });
});

// ═══════════════════════════════════════════════════════════════════════════

describe('Hexacle:init and the Infinite Dungeon', () => {
  it('writes upstream`s defaults for every field a zone leaves out', () => {
    const { gen } = hexacle(createRng('init'), { grid: GRID });
    expect({ ...gen.data, layers: undefined }).toEqual({
      segmentWideChance: 70,
      nbSegments: 8,
      aStep: 45,
      nbLayers: 4,
      segmentMissPercent: 10,
      layers: undefined,
      forceLastStair: false,
    });
    // floor(60 / 4.5) = 13, times (L - i + 1) / 2, not floored again.
    expect(gen.data.layers).toEqual([
      { rad: 26, id: 1 },
      { rad: 19.5, id: 2 },
      { rad: 13, id: 3 },
      { rad: 6.5, id: 4 },
    ]);
  });

  it('takes the radii from the WIDTH alone', () => {
    const { gen } = hexacle(createRng('init'), { grid: GRID, nbLayers: 3 }, { w: 45, h: 90 });
    // floor(45 / 3.5) = 12
    expect(gen.data.layers.map((l) => l.rad)).toEqual([18, 12, 6]);
  });

  it('keeps a zone`s own layers and numbers them, and leaves the zone`s table alone', () => {
    const data: HexacleData = { grid: GRID, nbLayers: 2, layers: [{ rad: 9 }, { rad: 3 }] };
    const before = JSON.stringify(data);
    const { gen } = hexacle(createRng('init'), data);
    expect(gen.data.layers).toEqual([
      { rad: 9, id: 1 },
      { rad: 3, id: 2 },
    ]);
    expect(JSON.stringify(data)).toBe(before);
  });

  it('refuses side and ring counts that are not positive integers', () => {
    expect(() => hexacle(createRng('x'), { grid: GRID, nbSegments: 0 })).toThrow(RangeError);
    expect(() => hexacle(createRng('x'), { grid: GRID, nbSegments: 2.5 })).toThrow(RangeError);
    expect(() => hexacle(createRng('x'), { grid: GRID, nbLayers: 0 })).toThrow(RangeError);
  });

  it('pins the hexa layout to `data/zones/infinite-dungeon/zone.lua:171-179`', () => {
    expect(HEXACLE_INFINITE_DUNGEON.width).toBe(60);
    expect(HEXACLE_INFINITE_DUNGEON.height).toBe(60);
    expect(HEXACLE_INFINITE_DUNGEON.map).toMatchObject({
      class: 'Hexacle',
      segmentWideChance: 70,
      nbSegments: 8,
      nbLayers: 6,
      segmentMissPercent: 10,
      forceSquareSize: true,
      forceLastStair: true,
    });
    const { gen } = hexacle(createRng('id'), HEXACLE_INFINITE_DUNGEON.map);
    expect(gen.data.layers.map((l) => l.rad)).toEqual([27, 22.5, 18, 13.5, 9, 4.5]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════

describe('rollSegments — the doubling drop chance', () => {
  const layerOf = (gen: HexacleGen): HexacleLayer => gen.data.layers[0] as HexacleLayer;

  it('makes nb_segments sides, side id centred on (id - 1) * a_step, each ending where the last began', () => {
    const { gen } = hexacle(rolled(Array.from({ length: 8 }, () => 0)), {
      grid: GRID,
      segmentMissPercent: 0,
    });
    const s = rollSegments(gen, layerOf(gen));
    expect(kept(s)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    for (let id = 1; id <= 8; id += 1) {
      const side = luaGet(s, id) as HexacleSegment;
      expect(side.a).toBe((id - 0.5) * 45 * RAD);
      expect(side.pa).toBe(id === 1 ? -(22.5 * RAD) : (id - 1.5) * 45 * RAD);
      expect(side.layer).toBe(layerOf(gen));
    }
    for (const n of [3, 5, 7, 12]) {
      const other = hexacle(rolled(Array.from({ length: n }, () => 0)), {
        grid: GRID,
        nbSegments: n,
        segmentMissPercent: 0,
      }).gen;
      const t = rollSegments(other, layerOf(other));
      expect(kept(t)).toEqual(Array.from({ length: n }, (_, i) => i + 1));
      expect((luaGet(t, n) as HexacleSegment).a).toBeCloseTo((n - 0.5) * (360 / n) * RAD, 12);
    }
  });

  it('KEEPS a side when the roll misses, and doubles the drop chance after each keep', () => {
    // 15 misses 10 and hits 20: keep, drop, keep, drop...
    const alternate = hexacle(rolled(Array.from({ length: 8 }, () => 15))).gen;
    expect(kept(rollSegments(alternate, layerOf(alternate)))).toEqual([1, 3, 5, 7]);
    // 39 misses 10 and 20 and hits 40.
    const twos = hexacle(rolled(Array.from({ length: 8 }, () => 39))).gen;
    expect(kept(rollSegments(twos, layerOf(twos)))).toEqual([1, 2, 4, 5, 7, 8]);
    // 99 misses 10, 20, 40 and 80, and the fifth roll, at 160, cannot miss.
    const fours = hexacle(rolled(Array.from({ length: 8 }, () => 99))).gen;
    expect(kept(rollSegments(fours, layerOf(fours)))).toEqual([1, 2, 3, 4, 6, 7, 8]);
  });

  it('truncates the chance: 0.9 is 0, and doubled, 1', () => {
    const { gen } = hexacle(rolled(Array.from({ length: 8 }, () => 0)), {
      grid: GRID,
      segmentMissPercent: 0.9,
    });
    expect(kept(rollSegments(gen, layerOf(gen)))).toEqual([1, 3, 5, 7]);
  });

  it('rolls in tableSampleIterator order, a sample draw before each roll, none before the last', () => {
    // Every sample draw answered with its top: the order is 8, 1, 2, ..., 7.
    let rolls = 0;
    const rng = scripted((label, _lo, hi) => {
      if (label === 'mapgen.hexacle.segments.order') return hi;
      rolls += 1;
      return 15;
    });
    const { gen } = hexacle(rng);
    const s = rollSegments(gen, layerOf(gen));
    expect(rolls).toBe(8);
    // keep 8, drop 1, keep 2, drop 3, keep 4, drop 5, keep 6, drop 7
    expect(kept(s)).toEqual([2, 4, 6, 8]);
    // ...and they were written in that order, which is what `#` and pairs see.
    expect(keysOf(s)).toEqual(keysOf(tableOf([8, 2, 4, 6])));

    const { rng: rec, labels } = recording('order');
    const g2 = hexacle(rec).gen;
    rollSegments(g2, layerOf(g2));
    const O = 'mapgen.hexacle.segments.order';
    const M = 'mapgen.hexacle.segments.miss';
    expect(labels).toEqual([O, M, O, M, O, M, O, M, O, M, O, M, O, M, M]);
  });
});

function tableOf(keys: readonly number[]): LuaIntTable<HexacleSegment> {
  const t = luaTable<HexacleSegment>();
  const layer = { rad: 5, id: 1 };
  for (const id of keys) luaSet(t, id, { a: 0, pa: 0, layer, id, centerX: null, centerY: null });
  return t;
}

// ═══════════════════════════════════════════════════════════════════════════

describe('groupSegments — runs of kept sides, and where the scan starts', () => {
  function groupsFor(keys: readonly number[], n = 8): { ids: number[][]; gen: HexacleGen } {
    const { gen } = hexacle(createRng('groups'), { grid: GRID, nbSegments: n }, { w: 10, h: 10 });
    const groups = groupSegments(gen, 1, tableOf(keys), new Set(), 0);
    return { ids: groups.map((g) => [...g.ids]), gen };
  }

  it('starts where LuaJIT`s # puts it: the same sides written in another order group in another order', () => {
    expect(groupsFor([1, 4]).ids).toEqual([[1], [4]]);
    expect(groupsFor([4, 1]).ids).toEqual([[4], [1]]);
    expect(groupsFor([1, 2, 4, 5]).ids).toEqual([
      [1, 2],
      [4, 5],
    ]);
    expect(groupsFor([1, 5, 2, 4]).ids).toEqual([
      [4, 5],
      [1, 2],
    ]);
    expect(groupsFor([1, 2, 3, 6]).ids).toEqual([[6], [1, 2, 3]]);
    expect(groupsFor([1, 6, 2, 3]).ids).toEqual([[1, 2, 3], [6]]);
  });

  it('when # is a multiple of nb_segments and side 1 is kept, starts at the first gap after side 1', () => {
    // # = 8 here, so first_hole is 0; side 1 is kept, so the scan moves on to
    // the gap at 2 and the run 7, 8, 1 stays whole.
    expect(groupsFor([1, 3, 5, 7, 8]).ids).toEqual([[3], [5], [7, 8, 1]]);
    // # = 8 with side 1 dropped: first_hole 0 is side 1, a gap already.
    expect(groupsFor([8, 6, 4, 2]).ids).toEqual([[2], [4], [6], [8]]);
  });

  it('puts every kept side in exactly one maximal run, bounded by gaps, for every ring of 8 not kept whole', () => {
    const rng = createRng('groups.all');
    for (let mask = 0; mask < 255; mask += 1) {
      const keys = Array.from({ length: 8 }, (_, i) => i + 1).filter(
        (id) => (mask & (1 << (id - 1))) !== 0,
      );
      for (const order of [keys, [...keys].reverse(), rng.shuffle('order', keys)]) {
        const { ids, gen } = groupsFor(order);
        expect(ids.flat().sort((a, b) => a - b)).toEqual(keys);
        const has = (id: number): boolean => keys.includes(((id - 1 + 8) % 8) + 1);
        for (const run of ids) {
          const first = run[0] as number;
          const last = run[run.length - 1] as number;
          expect(has(first - 1)).toBe(false);
          expect(has(last + 1)).toBe(false);
          run.forEach((id, k) => expect(id).toBe(((first - 1 + k) % 8) + 1));
          for (const id of run) expect(gen.idsToGroups.get(1)?.get(id)?.ids).toEqual(run);
        }
      }
    }
  });

  it('makes no group at all from a ring kept whole', () => {
    const { ids, gen } = groupsFor([3, 1, 2, 8, 4, 6, 5, 7]);
    expect(ids).toEqual([]);
    expect(gen.idsToGroups.has(1)).toBe(false);
  });

  it('adds each group to the set it is given, tagged with its pass', () => {
    const { gen } = hexacle(createRng('groups'));
    const all = new Set<HexacleGroup>();
    const groups = groupSegments(gen, 3, tableOf([2, 3, 6]), all, 4);
    expect([...all]).toEqual(groups);
    expect(groups.map((g) => [g.pass, g.dead, g.connected])).toEqual([
      [4, false, null],
      [4, false, null],
    ]);
    expect(gen.idsToGroups.get(3)?.get(6)).toBe(groups.find((g) => g.ids.includes(6)));
    expect(gen.idsToGroups.get(3)?.get(2)).toBe(gen.idsToGroups.get(3)?.get(3));
  });
});

// ═══════════════════════════════════════════════════════════════════════════

/** A pass up to the marks, by hand: fill, rings, groups. */
function setUpRings(gen: HexacleGen): LuaIntTable<LuaIntTable<HexacleSegment>> {
  const { map } = gen;
  for (let i = 0; i < map.w; i += 1)
    for (let j = 0; j < map.h; j += 1) map.set(i, j, map.resolve('#'));
  const segments = luaTable<LuaIntTable<HexacleSegment>>();
  for (const layer of gen.data.layers) luaSet(segments, layer.id, rollSegments(gen, layer));
  const all = new Set<HexacleGroup>();
  for (const layer of gen.data.layers) {
    groupSegments(gen, layer.id, luaGet(segments, layer.id) as LuaIntTable<HexacleSegment>, all, 0);
  }
  return segments;
}

describe('markSegments — each side is a line of sight through rock', () => {
  it('marks every kept side`s cells from its a vertex to its pa vertex, and stores its middle', () => {
    for (const seed of ['mark.1', 'mark.2', 'mark.3']) {
      const { gen, map } = hexacle(createRng(seed));
      const segments = setUpRings(gen);
      expect(markSegments(gen, segments)).toBe(true);

      const expectedGroup = new Map<string, HexacleGroup>();
      for (const [layerId, ring] of luaPairs(segments)) {
        for (const [id, side] of luaPairs(ring)) {
          const rad = side.layer.rad;
          const sx = 30 + Math.floor(rad * Math.cos((id - 0.5) * 45 * RAD));
          const sy = 30 + Math.floor(rad * Math.sin((id - 0.5) * 45 * RAD));
          const ex = 30 + Math.floor(rad * Math.cos(side.pa));
          const ey = 30 + Math.floor(rad * Math.sin(side.pa));
          expect([side.centerX, side.centerY]).toEqual([
            Math.floor((sx + ex) / 2),
            Math.floor((sy + ey) / 2),
          ]);
          const group = gen.idsToGroups.get(layerId)?.get(id) as HexacleGroup;
          for (const c of lineCells(fovLine(map, sx, sy, ex, ey, () => true)))
            expectedGroup.set(at(c.x, c.y), group);
        }
      }
      let marks = 0;
      for (let y = 0; y < map.h; y += 1) {
        for (let x = 0; x < map.w; x += 1) {
          const i = y * map.w + x;
          const want = expectedGroup.get(at(x, y));
          expect(gen.segment[i]).toBe(want === undefined ? null : '.');
          expect(gen.segmentGroup[i]).toBe(want ?? null);
          if (want !== undefined) marks += 1;
        }
      }
      expect(marks).toBeGreaterThan(0);
      // Nothing is dug yet.
      expect(map.tiles.every((code) => code === TileCode.WALL)).toBe(true);
    }
  });

  it('stops at the first side of a ring kept whole — "big whoops" — with every earlier ring already marked', () => {
    // Two rings of four. Ring 1 drops its first side and keeps three; ring 2
    // keeps all four (99 misses 10, 20, 40 and 80).
    const rng = rolled([0, 99, 99, 99, 99, 99, 99, 99]);
    const { gen } = hexacle(rng, { grid: GRID, nbSegments: 4, nbLayers: 2 }, { w: 30, h: 30 });
    const segments = setUpRings(gen);
    expect(kept(luaGet(segments, 1) as LuaIntTable<HexacleSegment>)).toEqual([2, 3, 4]);
    expect(kept(luaGet(segments, 2) as LuaIntTable<HexacleSegment>)).toEqual([1, 2, 3, 4]);
    expect(markSegments(gen, segments)).toBe('whoops');
    const groups = new Set(gen.segmentGroup.filter((g) => g !== null));
    expect([...groups].map((g) => [...g.ids])).toEqual([[2, 3, 4]]);
    for (const side of luaPairs(luaGet(segments, 2) as LuaIntTable<HexacleSegment>)) {
      expect(side[1].centerX).toBeNull();
    }
  });

  it('refuses a ring that runs off the map, where upstream indexes a nil room-map row', () => {
    const { gen, level } = hexacle(createRng('offmap'), ID, { w: 60, h: 30 });
    expect(generate(gen, 1, 0)).toBeNull();
    expect(level.forceRecreate).toBe('Hexacle: a ring runs off the map');
  });
});

// ═══════════════════════════════════════════════════════════════════════════

describe('connectGroups — a spoke dug through the map as it stands', () => {
  function twoRings(rng: Rng): {
    gen: HexacleGen;
    map: GenMap;
    side: (layer: HexacleLayer, id: number, cx: number, cy: number) => HexacleSegment;
    groupOf: (layer: HexacleLayer, id: number) => HexacleGroup;
    inner: HexacleLayer;
    outer: HexacleLayer;
  } {
    const { gen, map } = hexacle(rng, { ...ID, nbLayers: 2 }, { w: 40, h: 40 });
    for (let i = 0; i < 40; i += 1) for (let j = 0; j < 40; j += 1) map.set(i, j, TileCode.WALL);
    const [outer, inner] = gen.data.layers as [HexacleLayer, HexacleLayer];
    const groupOf = (layer: HexacleLayer, id: number): HexacleGroup => {
      let byId = gen.idsToGroups.get(layer.id);
      if (byId === undefined) {
        byId = new Map();
        gen.idsToGroups.set(layer.id, byId);
      }
      let group = byId.get(id);
      if (group === undefined) {
        group = { ids: [id], connected: null, dead: false, pass: 0 };
        byId.set(id, group);
      }
      return group;
    };
    const side = (layer: HexacleLayer, id: number, cx: number, cy: number): HexacleSegment => {
      groupOf(layer, id);
      return { a: 0, pa: 0, layer, id, centerX: cx, centerY: cy };
    };
    return { gen, map, side, groupOf, inner, outer };
  }

  it('bends a later spoke along an earlier one, because the line is made against the live map', () => {
    const { gen, map, side, groupOf, inner, outer } = twoRings(createRng('spokes'));
    const floor = (c: string): boolean => {
      const [x, y] = c.split(',').map(Number);
      return map.get(x ?? -1, y ?? -1) === TileCode.FLOOR;
    };
    const first = lineCells(fovLine(map, 2, 9, 20, 20, () => true)).map((c) => at(c.x, c.y));
    connectGroups(gen, groupOf(outer, 1), side(outer, 1, 2, 9), side(inner, 1, 20, 20));
    expect(first.every(floor)).toBe(true);

    const live = lineCells(fovLine(map, 2, 10, 22, 16, blockSight(map))).map((c) => at(c.x, c.y));
    const rock = lineCells(fovLine(map, 2, 10, 22, 16, () => true)).map((c) => at(c.x, c.y));
    expect(live).toEqual(
      ['3,10', '4,10', '5,11', '6,11', '7,11', '8,12', '9,12', '10,12', '11,13', '12,13'].concat([
        '13,13',
        '14,13',
        '15,14',
        '16,14',
        '17,14',
        '18,15',
        '19,15',
        '20,15',
        '21,16',
        '22,16',
      ]),
    );
    expect(live).not.toEqual(rock);

    connectGroups(gen, groupOf(outer, 2), side(outer, 2, 2, 10), side(inner, 2, 22, 16));
    expect(live.every(floor)).toBe(true);
    const rockOnly = rock.filter((c) => !live.includes(c) && !first.includes(c));
    expect(rockOnly.length).toBeGreaterThan(0);
    expect(rockOnly.some(floor)).toBe(false);
    // The start cell is not dug.
    expect(floor('2,10')).toBe(false);
  });

  it('joins the two groups both ways, each filed under the other`s ring', () => {
    const { gen, side, groupOf, inner, outer } = twoRings(createRng('join'));
    const g1 = groupOf(outer, 3);
    const g2 = groupOf(inner, 3);
    connectGroups(gen, g1, side(outer, 3, 10, 10), side(inner, 3, 14, 12));
    expect([...(g1.connected?.keys() ?? [])]).toEqual([inner.id]);
    expect([...(g1.connected?.get(inner.id) ?? [])]).toEqual([g2]);
    expect([...(g2.connected?.keys() ?? [])]).toEqual([outer.id]);
    expect([...(g2.connected?.get(outer.id) ?? [])]).toEqual([g1]);
  });

  it('resolves `.` once per dug cell, so a table grid draws once per cell', () => {
    const { rng, labels } = recording('resolve');
    const { gen, side, groupOf, inner, outer } = twoRings(rng);
    const tableGrid = createGenMap(40, 40, { ...GRID, '.': [TileCode.FLOOR, TileCode.FLOOR] }, rng);
    for (let i = 0; i < 40; i += 1)
      for (let j = 0; j < 40; j += 1) tableGrid.set(i, j, TileCode.WALL);
    const withTable: HexacleGen = { ...gen, map: tableGrid };
    labels.length = 0;
    connectGroups(withTable, groupOf(outer, 4), side(outer, 4, 5, 5), side(inner, 4, 17, 9));
    expect(labels).toEqual(Array.from({ length: 12 }, () => 'mapgen.resolve..'));
  });
});

// ═══════════════════════════════════════════════════════════════════════════

describe('paintSegments — every mark whose group lives, and its four neighbours on a roll', () => {
  function marked(wide: number, rng: Rng = createRng('paint')) {
    const { gen, map } = hexacle(rng, { ...ID, segmentWideChance: wide }, { w: 12, h: 12 });
    for (let i = 0; i < 12; i += 1) for (let j = 0; j < 12; j += 1) map.set(i, j, TileCode.WALL);
    const writes: string[] = [];
    const spied: GenMap = {
      ...map,
      set: (x, y, code) => {
        writes.push(at(x, y));
        map.set(x, y, code);
      },
    };
    const mark = (x: number, y: number, group: HexacleGroup): void => {
      gen.segment[y * 12 + x] = '.';
      gen.segmentGroup[y * 12 + x] = group;
    };
    const painted: HexacleGen = { ...gen, map: spied };
    return { gen: painted, map, writes, mark };
  }
  const alive = (): HexacleGroup => ({ ids: [1], connected: null, dead: false, pass: 0 });

  it('digs the mark, then east, west, south, north, column by column', () => {
    const { gen, writes, mark } = marked(100);
    mark(5, 7, alive());
    mark(2, 9, alive());
    paintSegments(gen);
    expect(writes).toEqual(['2,9', '3,9', '1,9', '2,10', '2,8', '5,7', '6,7', '4,7', '5,8', '5,6']);
  });

  it('skips a dead group`s marks, drawing nothing for them', () => {
    const { rng, labels } = recording('dead');
    const { gen, map, mark } = marked(70, rng);
    const dead = alive();
    dead.dead = true;
    mark(3, 3, dead);
    mark(8, 8, alive());
    labels.length = 0;
    paintSegments(gen);
    expect(map.get(3, 3)).toBe(TileCode.WALL);
    expect(map.get(8, 8)).toBe(TileCode.FLOOR);
    expect(labels.filter((l) => l === 'mapgen.hexacle.wide')).toHaveLength(4);
  });

  it('rolls before it resolves, resolves only on a hit, and resolves for a neighbour off the map', () => {
    const { rng, labels } = recording('edge');
    const tables: GridKeys = { ...GRID, '.': [TileCode.FLOOR, TileCode.FLOOR] };
    const map = createGenMap(12, 12, tables, rng);
    const level = { forceRecreate: null as string | null };
    const gen = createHexacle(
      map,
      { ...ID, grid: tables, segmentWideChance: 100 },
      rng,
      { maxLevel: 2 },
      level,
    );
    gen.segment[0] = '.';
    gen.segmentGroup[0] = alive();
    labels.length = 0;
    paintSegments(gen);
    const R = 'mapgen.resolve..';
    const W = 'mapgen.hexacle.wide';
    expect(labels).toEqual([R, W, R, W, R, W, R, W, R]);

    const { rng: rng0, labels: labels0 } = recording('edge0');
    const map0 = createGenMap(12, 12, tables, rng0);
    const gen0 = createHexacle(
      map0,
      { ...ID, grid: tables, segmentWideChance: 0 },
      rng0,
      { maxLevel: 2 },
      level,
    );
    gen0.segment[0] = '.';
    gen0.segmentGroup[0] = alive();
    labels0.length = 0;
    paintSegments(gen0);
    expect(labels0).toEqual([R, W, W, W, W]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════

/** The groups one pass made, joined or not, from the marks it left. */
function groupsOfPass(gen: HexacleGen, pass: number): Set<HexacleGroup> {
  const out = new Set<HexacleGroup>();
  for (const byId of gen.idsToGroups.values())
    for (const g of byId.values()) if (g.pass === pass) out.add(g);
  return out;
}

describe('digTunnels, rescueOrphans and checkNetwork', () => {
  /** One pass by hand up to the spokes; `null` when the marks start over or leave the map. */
  function upToSpokes(
    rng: Rng,
    data: HexacleData,
    w: number,
  ): {
    gen: HexacleGen;
    segments: LuaIntTable<LuaIntTable<HexacleSegment>>;
    layerGroups: HexacleGroup[][];
    all: Set<HexacleGroup>;
  } | null {
    const { gen } = hexacle(rng, data, { w, h: w });
    const segments = setUpRings(gen);
    const all = new Set<HexacleGroup>();
    gen.idsToGroups = new Map();
    const layerGroups = gen.data.layers.map((layer) =>
      groupSegments(
        gen,
        layer.id,
        luaGet(segments, layer.id) as LuaIntTable<HexacleSegment>,
        all,
        0,
      ),
    );
    if (markSegments(gen, segments) !== true) return null;
    return { gen, segments, layerGroups, all };
  }
  const shares = (
    segments: LuaIntTable<LuaIntTable<HexacleSegment>>,
    layerId: number,
    id: number,
  ): boolean => luaGet(luaGet(segments, layerId) as LuaIntTable<HexacleSegment>, id) !== undefined;
  const joined = (g: HexacleGroup): boolean => g.connected !== null && g.connected.size > 0;

  it('joins every group with a side number an inner ring kept — so an orphan`s candidates are always joined', () => {
    let orphansWithCandidates = 0;
    let orphansWithout = 0;
    let passes = 0;
    for (const n of [3, 4, 5, 8, 12]) {
      for (const layers of [2, 3, 6, 7]) {
        for (const miss of [0, 5, 10, 40]) {
          for (let s = 0; s < 4; s += 1) {
            const pass = upToSpokes(
              createRng(`premise.${String(n)}.${String(layers)}.${String(miss)}.${String(s)}`),
              { grid: GRID, nbSegments: n, nbLayers: layers, segmentMissPercent: miss },
              50,
            );
            if (pass === null) continue;
            passes += 1;
            const { gen, segments, layerGroups } = pass;
            digTunnels(gen, segments, layerGroups);
            for (const [k, groups] of layerGroups.entries()) {
              const ring = k + 1;
              for (const g of groups) {
                const inward = g.ids.some((id) =>
                  gen.data.layers.some((l) => l.id > ring && shares(segments, l.id, id)),
                );
                // The premise: a side shared with an inner ring means a spoke.
                if (inward) expect(joined(g)).toBe(true);
                if (joined(g)) continue;
                // An orphan: every group on another ring that shares one of its
                // sides is already joined.
                let candidates = 0;
                for (const id of g.ids) {
                  for (const l of gen.data.layers) {
                    if (l.id === ring || !shares(segments, l.id, id)) continue;
                    candidates += 1;
                    expect(joined(gen.idsToGroups.get(l.id)?.get(id) as HexacleGroup)).toBe(true);
                  }
                }
                if (candidates > 0) orphansWithCandidates += 1;
                else orphansWithout += 1;
              }
            }
            // And the orphan loop: rescued where it has a candidate, dead where not.
            const orphans = layerGroups.flat().filter((g) => !joined(g));
            rescueOrphans(gen, segments, layerGroups);
            for (const g of orphans) expect(g.dead).toBe(!joined(g));
          }
        }
      }
    }
    // The sweep reached both kinds of orphan.
    expect(passes).toBeGreaterThan(100);
    expect(orphansWithCandidates).toBeGreaterThan(0);
    expect(orphansWithout).toBeGreaterThan(0);
  });

  it('takes a lone ring as unjoined forever: its groups have nowhere to dig', () => {
    const { gen, level } = hexacle(
      createRng('lone'),
      { grid: GRID, nbLayers: 1 },
      { w: 30, h: 30 },
    );
    expect(generate(gen, 1, 0)).toBeNull();
    expect(gen.restarts).toHaveLength(HEXACLE_MAX_REBUILDS + 1);
    expect(gen.restarts.every((r) => r === 'unconnected')).toBe(true);
    expect(level.forceRecreate).toBe(
      `Hexacle: ${String(HEXACLE_MAX_REBUILDS + 1)} passes and no single network`,
    );
  });

  it('checkNetwork: one network is true; an unjoined first group, a dead group or two networks are not', () => {
    const group = (id: number): HexacleGroup => ({
      ids: [id],
      connected: null,
      dead: false,
      pass: 0,
    });
    const link = (a: HexacleGroup, b: HexacleGroup): void => {
      a.connected ??= new Map();
      b.connected ??= new Map();
      a.connected.set(2, new Set([...(a.connected.get(2) ?? []), b]));
      b.connected.set(1, new Set([...(b.connected.get(1) ?? []), a]));
    };
    const [a, b, c, d] = [group(1), group(2), group(3), group(4)];
    link(a, b);
    link(b, c);
    expect(checkNetwork([[a], [b, c]], new Set([a, b, c]))).toBe(true);
    // A lone first group is not taken out even though it is the only one.
    const alone = group(5);
    expect(checkNetwork([[alone]], new Set([alone]))).toBe('unconnected');
    // A group nothing reaches.
    expect(checkNetwork([[a], [b, c, d]], new Set([a, b, c, d]))).toBe('unconnected');
    expect(checkNetwork([[], [a]], new Set([a]))).toBe('no-first-group');
  });
});

describe('generate — the restarts, and the room map they do not clear (critic A4)', () => {
  it('ends on a pass whose groups are all alive and one network', () => {
    for (let s = 0; s < 30; s += 1) {
      const { gen, level } = hexacle(createRng(`network.${String(s)}`));
      expect(generate(gen, 1, 0)).not.toBeNull();
      expect(level.forceRecreate).toBeNull();
      const groups = groupsOfPass(gen, gen.restarts.length);
      expect(groups.size).toBeGreaterThan(0);
      for (const g of groups) expect(g.dead).toBe(false);
      const first = [...groups][0] as HexacleGroup;
      const seen = new Set<HexacleGroup>([first]);
      const stack = [first];
      while (stack.length > 0) {
        for (const set of (stack.pop() as HexacleGroup).connected?.values() ?? []) {
          for (const g of set) {
            if (!seen.has(g)) {
              seen.add(g);
              stack.push(g);
            }
          }
        }
      }
      expect(seen.size).toBe(groups.size);
    }
  });

  it('starts over when a group dies, and paints the failed pass`s surviving marks too', () => {
    let checked = 0;
    for (let s = 0; s < 40 && checked < 5; s += 1) {
      const { rng, labels } = recording(`stale.${String(s)}`);
      const { gen, map } = hexacle(rng);
      const result = generate(gen, 1, 0) as HexacleResult;
      if (gen.restarts.length === 0) continue;
      checked += 1;
      expect(gen.restarts.every((r) => r === 'unconnected')).toBe(true);

      const final = gen.restarts.length;
      let stale = 0;
      let painted = 0;
      gen.segmentGroup.forEach((group, i) => {
        if (group === null) return;
        if (group.pass < final && !group.dead) stale += 1;
        if (!group.dead) {
          painted += 1;
          const x = i % map.w;
          const y = (i - x) / map.w;
          expect(map.get(x, y)).toBe(TileCode.FLOOR);
        }
      });
      // The room map was NOT cleared: marks from an earlier pass survive, and are dug.
      expect(stale).toBeGreaterThan(0);
      // Four rolls per mark painted — stale marks included, dead groups' not.
      expect(labels.filter((l) => l === 'mapgen.hexacle.wide')).toHaveLength(4 * painted);
      expect(result.up).not.toBeNull();
    }
    expect(checked).toBe(5);
  });

  it('starts over at "big whoops" when a ring keeps every side, and paints the rings it had marked', () => {
    let checked = 0;
    for (let s = 0; s < 60 && checked < 3; s += 1) {
      const { gen, map } = hexacle(
        createRng(`whoops.${String(s)}`),
        { grid: GRID, nbSegments: 4 },
        { w: 40, h: 40 },
      );
      expect(generate(gen, 1, 0)).not.toBeNull();
      const whoops = gen.restarts.indexOf('whoops');
      if (whoops < 0) continue;
      const stale = gen.segmentGroup.filter((g) => g !== null && g.pass === whoops);
      if (stale.length === 0) continue;
      checked += 1;
      gen.segmentGroup.forEach((g, i) => {
        if (g !== null && g.pass === whoops) {
          // A whoops pass never reaches the orphan loop: none of its groups is dead.
          expect(g.dead).toBe(false);
          expect(map.tiles[i]).toBe(TileCode.FLOOR);
        }
      });
    }
    expect(checked).toBe(3);
  });

  it('gives up after HEXACLE_MAX_REBUILDS restarts, where upstream recurses forever', () => {
    const { gen, level } = hexacle(
      createRng('forever'),
      { grid: GRID, segmentMissPercent: 0 },
      { w: 30, h: 30 },
    );
    expect(generate(gen, 1, 0)).toBeNull();
    expect(gen.restarts).toHaveLength(HEXACLE_MAX_REBUILDS + 1);
    expect(gen.restarts.every((r) => r === 'whoops')).toBe(true);
    expect(level.forceRecreate).toBe(
      `Hexacle: ${String(HEXACLE_MAX_REBUILDS + 1)} passes and no single network`,
    );
  });

  it('refuses a first ring with no side, where upstream indexes nil', () => {
    const { gen, level } = hexacle(
      createRng('empty'),
      { grid: GRID, segmentMissPercent: 100 },
      { w: 30, h: 30 },
    );
    expect(generate(gen, 1, 0)).toBeNull();
    expect(level.forceRecreate).toBe('Hexacle: ring 1 kept no side');
  });

  it('draws in upstream`s order: the fill, then each ring`s sample and rolls, then spokes, the paint, the stairs', () => {
    const tables: GridKeys = { ...GRID, '#': [TileCode.WALL, TileCode.WALL] };
    let restarted = 0;
    for (let s = 0; s < 12; s += 1) {
      const { rng, labels } = recording(`draws.${String(s)}`);
      const { gen } = hexacle(rng, { ...ID, grid: tables });
      generate(gen, 1, 0);
      const passes = gen.restarts.length + 1;
      if (passes > 1) restarted += 1;
      // Every pass fills the whole map and rolls six rings of eight.
      expect(labels.filter((l) => l === 'mapgen.resolve.#')).toHaveLength(3600 * passes);
      expect(labels.filter((l) => l === 'mapgen.hexacle.segments.miss')).toHaveLength(48 * passes);

      // The last pass: from its fill to the stairs, nothing painted before it.
      const begin = labels.lastIndexOf('mapgen.resolve.#') - 3599;
      expect(labels.slice(0, begin).some((l) => l === 'mapgen.hexacle.wide')).toBe(false);
      const pass = labels.slice(begin);
      expect(pass.slice(0, 3600).every((l) => l === 'mapgen.resolve.#')).toBe(true);
      expect(pass[3600]).toBe('mapgen.hexacle.segments.order');
      const lastRoll = pass.lastIndexOf('mapgen.hexacle.segments.miss');
      const spokes = pass.findIndex(
        (l) => l === 'mapgen.hexacle.tunnel' || l === 'mapgen.hexacle.orphan',
      );
      const firstWide = pass.indexOf('mapgen.hexacle.wide');
      const firstStair = pass.indexOf('mapgen.hexacle.stairs.down.x');
      if (spokes >= 0) {
        expect(lastRoll).toBeLessThan(spokes);
        expect(pass.lastIndexOf('mapgen.hexacle.tunnel')).toBeLessThan(firstWide);
      }
      expect(lastRoll).toBeLessThan(firstWide);
      expect(pass.lastIndexOf('mapgen.hexacle.wide')).toBeLessThan(firstStair);
    }
    expect(restarted).toBeGreaterThan(0);
  });

  it('is the same level for the same seed, and a different one for another', () => {
    const tiles = (seed: string): number[] => {
      const { gen, map } = hexacle(createRng(seed));
      generate(gen, 1, 0);
      return Array.from(map.tiles);
    };
    expect(tiles('same')).toEqual(tiles('same'));
    expect(tiles('same')).not.toEqual(tiles('other'));
  });
});

// ═══════════════════════════════════════════════════════════════════════════

/** A Lua group: the id list, with the two fields upstream hangs on the same table. */
type LuaGroup = number[] & { connected?: Map<number, Set<LuaGroup>>; dead?: boolean };
type LuaSide = {
  a: number;
  pa: number;
  layer: { rad: number; id: number };
  id: number;
  center_x?: number;
  center_y?: number;
};

/**
 * `engine/generator/map/Hexacle.lua:27-280` again, from the Lua and not from the
 * port: one `generate` that calls itself, `room_map` as a table of cells that
 * nothing clears, groups as the id lists themselves, and upstream's loops line
 * for line. What it shares with the port is only what is pinned elsewhere:
 * LuaJIT's table layout (above, against the C), the LOS line (`fovline.test.ts`,
 * against the C), and the RNG shims (`lua.test.ts`).
 */
function luaHexacle(
  rng: Rng,
  w: number,
  h: number,
  data: HexacleData,
  maxLevel: number,
  lev: number,
): { map: GenMap; up: TileXY | null; down: TileXY | null; generations: number } {
  const map = createGenMap(w, h, data.grid, rng);
  const wide = data.segmentWideChance ?? 70;
  const N = data.nbSegments ?? 8;
  const a_step = 360 / N;
  const L = data.nbLayers ?? 4;
  const miss0 = data.segmentMissPercent ?? 10;
  const layers: { rad: number; id: number }[] = [];
  for (let i = 1; i <= L; i += 1) {
    layers[i] = { rad: (Math.floor(w / (L + 0.5)) * (L - i + 1)) / 2, id: i };
  }
  const room_map = new Map<string, { segment?: string; segment_group?: LuaGroup }>();
  const rm = (x: number, y: number): { segment?: string; segment_group?: LuaGroup } => {
    if (x < 0 || y < 0 || x >= w || y >= h) throw new TypeError('attempt to index a nil value');
    let cell = room_map.get(at(x, y));
    if (cell === undefined) {
      cell = {};
      room_map.set(at(x, y), cell);
    }
    return cell;
  };
  let ids_to_groups = new Map<number, Map<number, LuaGroup>>();
  let generations = 0;

  const connectGroups = (group: LuaGroup, a: LuaSide, a2: LuaSide): void => {
    const l = fovLine(
      map,
      a.center_x ?? NaN,
      a.center_y ?? NaN,
      a2.center_x ?? NaN,
      a2.center_y ?? NaN,
      blockSight(map),
    );
    let st = l.step();
    while (st !== null) {
      map.set(st.x, st.y, map.resolve('.'));
      st = l.step();
    }
    const group2 = ids_to_groups.get(a2.layer.id)?.get(a2.id) as LuaGroup;
    group.connected ??= new Map();
    if (!group.connected.has(a2.layer.id)) group.connected.set(a2.layer.id, new Set());
    group.connected.get(a2.layer.id)?.add(group2);
    group2.connected ??= new Map();
    if (!group2.connected.has(a.layer.id)) group2.connected.set(a.layer.id, new Set());
    group2.connected.get(a.layer.id)?.add(group);
  };

  const generate = (): { up: TileXY | null; down: TileXY | null } => {
    generations += 1;
    for (let i = 0; i <= w - 1; i += 1) {
      for (let j = 0; j <= h - 1; j += 1) map.set(i, j, map.resolve('#'));
    }
    const cx = Math.floor(w / 2);
    const cy = Math.floor(h / 2);
    const segments = luaTable<LuaIntTable<LuaSide>>();
    for (let i = 1; i <= L; i += 1) {
      const layer = layers[i] as { rad: number; id: number };
      let segment_miss_percent = miss0;
      luaSet(segments, i, luaTable<LuaSide>());
      const angles: LuaSide[] = [];
      let pa = -((a_step / 2) * RAD);
      let id = 1;
      for (let ad = a_step / 2; ad <= 360; ad += a_step) {
        const a = ad * RAD;
        angles[angles.length] = { a, pa, layer, id };
        pa = a;
        id = id + 1;
      }
      for (const a of tableSampleIterator(rng, 'mapgen.hexacle.segments.order', angles)) {
        if (!percent(rng, 'mapgen.hexacle.segments.miss', segment_miss_percent)) {
          luaSet(luaGet(segments, i) as LuaIntTable<LuaSide>, a.id, a);
          segment_miss_percent = segment_miss_percent * 2;
        } else {
          segment_miss_percent = miss0;
        }
      }
    }

    const layer_groups: LuaGroup[][] = [];
    ids_to_groups = new Map();
    const all_groups = new Set<LuaGroup>();
    for (let i = 1; i <= L; i += 1) {
      const s = luaGet(segments, i) as LuaIntTable<LuaSide>;
      let cur_group: LuaGroup = [];
      const groups: LuaGroup[] = [];
      let first_hole = luaLength(s) % N;
      if (first_hole === 0 && luaGet(s, 1) !== undefined) {
        let test = 2;
        while (luaGet(s, test) !== undefined && test <= N) test = test + 1;
        first_hole = test - 1;
      }
      for (let z0 = first_hole; z0 <= first_hole + N; z0 += 1) {
        let z = z0 % N;
        z = z + 1;
        if (luaGet(s, z) === undefined) {
          if (cur_group.length > 0) {
            groups[groups.length] = cur_group;
            all_groups.add(cur_group);
            if (!ids_to_groups.has(i)) ids_to_groups.set(i, new Map());
            for (const gid of cur_group) ids_to_groups.get(i)?.set(gid, cur_group);
          }
          cur_group = [];
        } else {
          cur_group[cur_group.length] = z;
        }
      }
      layer_groups[i] = groups;
    }

    for (const [, layer_segments] of luaPairs(segments)) {
      for (const [, a] of luaPairs(layer_segments)) {
        // big whoops
        if (!ids_to_groups.has(a.layer.id) || !ids_to_groups.get(a.layer.id)?.has(a.id)) {
          return generate();
        }
        const rad = a.layer.rad;
        const sx = cx + Math.floor(rad * Math.cos(a.a));
        const sy = cy + Math.floor(rad * Math.sin(a.a));
        const ex = cx + Math.floor(rad * Math.cos(a.pa));
        const ey = cy + Math.floor(rad * Math.sin(a.pa));
        a.center_x = Math.floor((sx + ex) / 2);
        a.center_y = Math.floor((sy + ey) / 2);
        const l = fovLine(map, sx, sy, ex, ey, blockSight(map));
        let st = l.step();
        while (st !== null) {
          rm(st.x, st.y).segment = '.';
          rm(st.x, st.y).segment_group = ids_to_groups.get(a.layer.id)?.get(a.id);
          st = l.step();
        }
      }
    }

    for (let i = 1; layer_groups[i] !== undefined; i += 1) {
      const s = luaGet(segments, i) as LuaIntTable<LuaSide>;
      for (const group of layer_groups[i] as LuaGroup[]) {
        const possible_tunnels: { a: LuaSide; a2: LuaSide }[] = [];
        for (const id of group) {
          const a = luaGet(s, id) as LuaSide;
          for (let j = i + 1; j <= L; j += 1) {
            const s2 = luaGet(segments, j) as LuaIntTable<LuaSide>;
            const a2 = luaGet(s2, id);
            if (a2 !== undefined) {
              possible_tunnels[possible_tunnels.length] = { a, a2 };
              break;
            }
          }
        }
        if (possible_tunnels.length > 0) {
          const t = table(rng, 'mapgen.hexacle.tunnel', possible_tunnels)?.value as {
            a: LuaSide;
            a2: LuaSide;
          };
          connectGroups(group, t.a, t.a2);
        }
      }
    }

    for (let i = 1; layer_groups[i] !== undefined; i += 1) {
      const s = luaGet(segments, i) as LuaIntTable<LuaSide>;
      for (const group of layer_groups[i] as LuaGroup[]) {
        if (group.connected === undefined || group.connected.size === 0) {
          const possible_tunnels: { a: LuaSide; a2: LuaSide }[] = [];
          for (const id of group) {
            const a = luaGet(s, id) as LuaSide;
            for (let j = 1; j <= L; j += 1) {
              if (i !== j) {
                const s2 = luaGet(segments, j) as LuaIntTable<LuaSide>;
                const a2 = luaGet(s2, id);
                if (a2 !== undefined) {
                  const group2 = ids_to_groups.get(a2.layer.id)?.get(a2.id) as LuaGroup;
                  if (group2.connected !== undefined && group2.connected.size > 0) {
                    possible_tunnels[possible_tunnels.length] = { a, a2 };
                    break;
                  }
                }
              }
            }
          }
          if (possible_tunnels.length > 0) {
            const t = table(rng, 'mapgen.hexacle.orphan', possible_tunnels)?.value as {
              a: LuaSide;
              a2: LuaSide;
            };
            connectGroups(group, t.a, t.a2);
          } else {
            group.dead = true;
          }
        }
      }
    }

    const check_all = (group: LuaGroup): void => {
      if (group.connected === undefined || group.connected.size === 0) return;
      if (!all_groups.has(group)) return;
      all_groups.delete(group);
      for (const [, groups] of group.connected) for (const group2 of groups) check_all(group2);
    };
    check_all((layer_groups[1] as LuaGroup[])[0] as LuaGroup);
    if (all_groups.size > 0) return generate();

    for (let i = 0; i <= w - 1; i += 1) {
      for (let j = 0; j <= h - 1; j += 1) {
        const cell = room_map.get(at(i, j));
        if (cell?.segment !== undefined && cell.segment_group?.dead !== true) {
          const seg = cell.segment;
          map.set(i, j, map.resolve(seg));
          if (percent(rng, 'mapgen.hexacle.wide', wide)) map.set(i + 1, j, map.resolve(seg));
          if (percent(rng, 'mapgen.hexacle.wide', wide)) map.set(i - 1, j, map.resolve(seg));
          if (percent(rng, 'mapgen.hexacle.wide', wide)) map.set(i, j + 1, map.resolve(seg));
          if (percent(rng, 'mapgen.hexacle.wide', wide)) map.set(i, j - 1, map.resolve(seg));
        }
      }
    }

    let down: TileXY | null = null;
    if (lev < maxLevel || data.forceLastStair === true) {
      for (;;) {
        const dx = range(rng, 'mapgen.hexacle.stairs.down.x', 1, w - 1);
        const dy = range(rng, 'mapgen.hexacle.stairs.down.y', 1, h - 1);
        if (!map.blockMove(dx, dy) && map.cell(dx, dy).special === null) {
          map.set(dx, dy, map.resolve('down'));
          map.cell(dx, dy).special = 'exit';
          down = { x: dx, y: dy };
          break;
        }
      }
    }
    for (;;) {
      const ux = range(rng, 'mapgen.hexacle.stairs.up.x', 1, w - 1);
      const uy = range(rng, 'mapgen.hexacle.stairs.up.y', 1, h - 1);
      if (!map.blockMove(ux, uy) && map.cell(ux, uy).special === null) {
        map.set(ux, uy, map.resolve('up'));
        map.cell(ux, uy).special = 'exit';
        return { up: { x: ux, y: uy }, down };
      }
    }
  };

  const { up, down } = generate();
  return { map, up, down, generations };
}

describe('Hexacle:generate — against the Lua', () => {
  it('builds the same level, cell for cell and draw for draw, restarts and stale marks included', () => {
    const tables: GridKeys = {
      '.': [TileCode.FLOOR, TileCode.FLOOR, TileCode.FLOOR],
      '#': [TileCode.WALL, TileCode.WALL],
      up: TileCode.FLOOR,
      down: TileCode.FLOOR,
    };
    const variants: readonly { data: HexacleData; w: number; h: number; lev: number }[] = [
      { data: ID, w: 60, h: 60, lev: 1 },
      { data: { ...ID, grid: tables }, w: 60, h: 60, lev: 1 },
      { data: { grid: GRID }, w: 50, h: 50, lev: 5 },
      { data: { grid: GRID, nbSegments: 4 }, w: 40, h: 40, lev: 2 },
      {
        data: {
          grid: GRID,
          nbSegments: 5,
          nbLayers: 3,
          segmentMissPercent: 25,
          segmentWideChance: 30,
        },
        w: 44,
        h: 50,
        lev: 1,
      },
      {
        data: { grid: GRID, nbSegments: 12, nbLayers: 5, segmentMissPercent: 3 },
        w: 70,
        h: 70,
        lev: 1,
      },
    ];
    let restarts = 0;
    let whoops = 0;
    for (const [v, variant] of variants.entries()) {
      for (let s = 0; s < 8; s += 1) {
        const seed = `against.${String(v)}.${String(s)}`;
        const mine = recording(seed);
        const theirs = recording(seed);
        const { gen, map } = hexacle(mine.rng, variant.data, {
          w: variant.w,
          h: variant.h,
          maxLevel: 3,
        });
        const result = generate(gen, variant.lev, variant.lev - 1);
        const lua = luaHexacle(theirs.rng, variant.w, variant.h, variant.data, 3, variant.lev);
        expect(Array.from(map.tiles)).toEqual(Array.from(lua.map.tiles));
        expect([result?.up, result?.down]).toEqual([lua.up, lua.down]);
        expect(gen.restarts.length).toBe(lua.generations - 1);
        expect(mine.labels).toEqual(theirs.labels);
        restarts += gen.restarts.length;
        whoops += gen.restarts.filter((r) => r === 'whoops').length;
      }
    }
    // The comparison reached both kinds of restart.
    expect(restarts).toBeGreaterThan(whoops);
    expect(whoops).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════

describe('makeStairsInside', () => {
  it('stands the down stair, then the up stair, on open cells that are not special, in 1..w-1', () => {
    for (let s = 0; s < 20; s += 1) {
      const { rng, labels } = recording(`stairs.${String(s)}`);
      const { gen, map } = hexacle(rng, ID, { maxLevel: 5 });
      const result = generate(gen, 1, 0) as HexacleResult;
      const { up, down } = result as { up: TileXY; down: TileXY };
      for (const p of [up, down]) {
        expect(p.x).toBeGreaterThanOrEqual(1);
        expect(p.y).toBeGreaterThanOrEqual(1);
        expect(map.get(p.x, p.y)).toBe(TileCode.FLOOR);
        expect(map.cell(p.x, p.y).special).toBe('exit');
      }
      expect(up).not.toEqual(down);
      const stairs = labels.filter((l) => l.startsWith('mapgen.hexacle.stairs.'));
      expect(stairs.slice(0, 2)).toEqual([
        'mapgen.hexacle.stairs.down.x',
        'mapgen.hexacle.stairs.down.y',
      ]);
      expect(stairs.slice(-2)).toEqual([
        'mapgen.hexacle.stairs.up.x',
        'mapgen.hexacle.stairs.up.y',
      ]);
      expect(result.spots).toEqual([]);
    }
  });

  it('never stands a stair on wall or on a special cell', () => {
    const { gen, map } = hexacle(createRng('stairs.rule'), ID, { w: 12, h: 12, maxLevel: 5 });
    for (let i = 0; i < 12; i += 1) for (let j = 0; j < 12; j += 1) map.set(i, j, TileCode.WALL);
    map.set(3, 4, TileCode.FLOOR);
    map.set(9, 2, TileCode.FLOOR);
    map.set(6, 6, TileCode.FLOOR);
    map.cell(6, 6).special = true;
    const result = makeStairsInside(gen, 1, 0, []);
    const placed = [result.down, result.up].map((p) => at(p?.x ?? -1, p?.y ?? -1)).sort();
    expect(placed).toEqual(['3,4', '9,2']);
  });

  it('places no down stair on the zone`s last level unless forced', () => {
    const last = hexacle(createRng('last'), { grid: GRID }, { w: 12, h: 12, maxLevel: 3 });
    for (let i = 0; i < 12; i += 1)
      for (let j = 0; j < 12; j += 1) last.map.set(i, j, TileCode.WALL);
    const r = makeStairsInside(last.gen, 3, 2, []);
    // Nothing is dug, so the up stair cannot be placed either — but the down
    // stair was never looked for.
    expect(r.down).toBeNull();
    expect(last.level.forceRecreate).toBe('makeStairsInside: no cell for the up stair');

    const forced = hexacle(
      createRng('last'),
      { grid: GRID, forceLastStair: true },
      { w: 12, h: 12, maxLevel: 3 },
    );
    for (let i = 0; i < 12; i += 1)
      for (let j = 0; j < 12; j += 1) forced.map.set(i, j, TileCode.FLOOR);
    const f = makeStairsInside(forced.gen, 3, 2, []);
    expect(f.down).not.toBeNull();
    expect(f.up).not.toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════

describe('HEXACLE_INFINITE_DUNGEON — forty levels', () => {
  /**
   * `Zone:newLevel`'s loop as `mapgen/level.ts` runs it for every other
   * generator: attempt n is the seed `${seed}#${n}`, refused on
   * `force_recreate` or when the up stair cannot reach the down stair
   * eight ways with doors passable.
   */
  function certify(
    seed: string,
  ): { attempts: number; map: GenMap; up: TileXY; down: TileXY } | null {
    for (let attempt = 1; attempt <= 50; attempt += 1) {
      const rng = createRng(`${seed}#${String(attempt)}`);
      const { gen, map, level } = hexacle(rng, HEXACLE_INFINITE_DUNGEON.map, { maxLevel: 1 });
      const result = generate(gen, 1, 0);
      if (
        result === null ||
        level.forceRecreate !== null ||
        result.up === null ||
        result.down === null
      ) {
        continue;
      }
      if (reachable(map, result.up, result.down)) {
        return { attempts: attempt, map, up: result.up, down: result.down };
      }
    }
    return null;
  }

  it('joins the up stair to the down stair on every one, 8-way with doors passable, within newLevel`s attempts', () => {
    for (let s = 0; s < 40; s += 1) {
      const level = certify(`hexacle.id.${String(s)}`);
      expect(level).not.toBeNull();
      if (level === null) continue;
      expect(reachable(level.map, level.up, level.down)).toBe(true);
      expect(level.up).not.toEqual(level.down);
      expect(level.map.tiles.every((c) => c === TileCode.FLOOR || c === TileCode.WALL)).toBe(true);
    }
  });
});
