// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// The rooms under test are ported from t-engine4 game/modules/tome/data/rooms/forest_clearing.lua:20-126
//   and game/modules/tome/data/rooms/rocky_snowy_trees.lua:20-44.
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

import { describe, expect, it } from 'vitest';

import { createGenMap } from '../../../src/shared/mapgen/genmap.ts';
import type { GenMap, GridKeys } from '../../../src/shared/mapgen/genmap.ts';
import {
  HEIGHTMAP_MAX,
  createHeightmap,
  generate as generateHeightmap,
  heightAt,
} from '../../../src/shared/mapgen/heightmap.ts';
import type { Heightmap } from '../../../src/shared/mapgen/heightmap.ts';
import { createRoomer } from '../../../src/shared/mapgen/roomer.ts';
import {
  CLEARING_REBUILDS,
  loadRoom,
  make_hmap,
  roomAlloc,
  tunnel,
} from '../../../src/shared/mapgen/rooms-loader.ts';
import type {
  GeneratedRoom,
  RoomerData,
  RoomFn,
  RoomsGen,
} from '../../../src/shared/mapgen/rooms-loader.ts';
import { TileCode } from '../../../src/shared/protocol.ts';
import { createRng, rngFromState } from '../../../src/shared/rng.ts';
import type { Rng } from '../../../src/shared/rng.ts';

const KEYS: GridKeys = {
  '.': TileCode.FLOOR,
  '#': TileCode.WALL,
  T: TileCode.TREES,
  up: TileCode.FLOOR,
  down: TileCode.FLOOR,
};

/** A generator over an all-`#` map, drawing from `rng`. */
function setup(
  rng: Rng,
  data: Partial<RoomerData> = {},
  w = 40,
  h = 40,
): { gen: RoomsGen; map: GenMap } {
  const map = createGenMap(w, h, KEYS, rng);
  for (let x = 0; x < w; x += 1) for (let y = 0; y < h; y += 1) map.set(x, y, TileCode.WALL);
  const gen = createRoomer(
    map,
    { ...data, grid: KEYS },
    rng,
    { maxLevel: 3 },
    { forceRecreate: null },
  );
  return { gen, map };
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

/** A heightmap with every cell high except the listed 1-based cells, which are 0. */
function drawn(w: number, h: number, open: readonly (readonly [number, number])[]): Heightmap {
  const hm = createHeightmap(w, h);
  hm.hmap.fill(HEIGHTMAP_MAX);
  for (const [i, j] of open) hm.hmap[(j - 1) * w + (i - 1)] = 0;
  return hm;
}

function openCells(open: Uint8Array, w: number): string[] {
  const out: string[] = [];
  open.forEach((v, k) => {
    if (v === 1) out.push(`${String((k % w) + 1)},${String(Math.floor(k / w) + 1)}`);
  });
  return out;
}

/** 8-connected groups of the cells `isOpen` accepts, in a rect. */
function groups(
  x0: number,
  y0: number,
  w: number,
  h: number,
  isOpen: (x: number, y: number) => boolean,
): number[] {
  const seen = new Set<string>();
  const sizes: number[] = [];
  for (let x = x0; x < x0 + w; x += 1) {
    for (let y = y0; y < y0 + h; y += 1) {
      if (!isOpen(x, y) || seen.has(`${String(x)},${String(y)}`)) continue;
      let size = 0;
      const stack = [[x, y] as const];
      seen.add(`${String(x)},${String(y)}`);
      while (stack.length > 0) {
        const [cx, cy] = stack.pop() ?? [0, 0];
        size += 1;
        for (let dx = -1; dx <= 1; dx += 1) {
          for (let dy = -1; dy <= 1; dy += 1) {
            const nx = cx + dx;
            const ny = cy + dy;
            const key = `${String(nx)},${String(ny)}`;
            if (nx < x0 || ny < y0 || nx >= x0 + w || ny >= y0 + h) continue;
            if (seen.has(key) || !isOpen(nx, ny)) continue;
            seen.add(key);
            stack.push([nx, ny]);
          }
        }
      }
      sizes.push(size);
    }
  }
  return sizes;
}

describe('forest_clearing', () => {
  it('is 6..10 by 6..10, one 8-connected group of open ground round its centre, walled in `#`', () => {
    const sizes = new Set<string>();
    for (let s = 0; s < 60; s += 1) {
      const { gen, map } = setup(createRng(`clearing:${String(s)}`));
      const placed = roomAlloc(gen, loadRoom('forest_clearing'), 1, 1, 0);
      if (placed === null) throw new Error('the clearing did not place');
      const { w, h } = placed.room;
      sizes.add(`${String(w)}x${String(h)}`);
      expect(w).toBeGreaterThanOrEqual(6);
      expect(w).toBeLessThanOrEqual(10);
      expect(h).toBeGreaterThanOrEqual(6);
      expect(h).toBeLessThanOrEqual(10);
      expect(placed.room.name).toBe(`forest_clearing${String(w)}x${String(h)}`);
      for (let x = placed.x; x < placed.x + w; x += 1) {
        for (let y = placed.y; y < placed.y + h; y += 1) {
          const cell = map.cell(x, y);
          // Open ground belongs to the room; its walls are left as plain rock.
          if (map.get(x, y) === TileCode.FLOOR) expect(cell.room).toBe(1);
          else {
            expect(map.get(x, y)).toBe(TileCode.WALL);
            expect(cell).toMatchObject({ room: null, canOpen: null, special: null });
          }
        }
      }
      expect(map.get(placed.cx, placed.cy)).toBe(TileCode.FLOOR);
      const open = groups(placed.x, placed.y, w, h, (x, y) => map.get(x, y) === TileCode.FLOOR);
      expect(open).toHaveLength(1);
      expect(open[0]).toBeGreaterThanOrEqual(2);
    }
    expect(sizes.size).toBeGreaterThan(10);
  });

  it('lets a tunnel carve through its trees to the centre', () => {
    const { gen, map } = setup(createRng('clearing:tunnel'), { tunnelChange: 0, tunnelRandom: 0 });
    const placed = roomAlloc(gen, loadRoom('forest_clearing'), 1, 1, 0);
    if (placed === null) throw new Error('the clearing did not place');
    // Its whole border is high ground, so the cell where the row enters is a wall.
    expect(map.get(placed.x, placed.cy)).toBe(TileCode.WALL);
    tunnel(gen, 0, placed.cy, placed.cx, placed.cy, 99);
    for (let x = 1; x <= placed.cx; x += 1) expect(map.get(x, placed.cy)).toBe(TileCode.FLOOR);
  });

  it('keeps only the largest group', () => {
    const { gen } = setup(createRng('largest'));
    const hm = drawn(9, 3, [
      [1, 1],
      [2, 1],
      [4, 1],
      [5, 1],
      [6, 2],
      [7, 3],
      [9, 3],
    ]);
    const kept = make_hmap(gen, 9, 3, () => hm);
    expect(openCells(kept.open, 9)).toEqual(['4,1', '5,1', '6,2', '7,3']);
  });

  it('opens ground strictly below five sixths of the heightmap`s range', () => {
    const { gen } = setup(createRng('cut'));
    const hm = drawn(5, 1, []);
    // 83333.33... is the cut: 83333 is under it, 83334 and the cut itself are not.
    hm.hmap.set([83333, 83333, (HEIGHTMAP_MAX * 5) / 6, 83334, 83333]);
    const kept = make_hmap(gen, 5, 1, () => hm);
    expect(openCells(kept.open, 5)).toEqual(['1,1', '2,1']);
  });

  it('breaks a tie for largest the way Lua`s unstable sort does', () => {
    // Groups found in x order: A (3), B (3), C (1). The C sort swaps C to the
    // front and leaves A last; a stable sort would keep B.
    const { gen } = setup(createRng('tie'));
    const hm = drawn(9, 1, [
      [1, 1],
      [2, 1],
      [3, 1],
      [5, 1],
      [6, 1],
      [7, 1],
      [9, 1],
    ]);
    const kept = make_hmap(gen, 9, 1, () => hm);
    expect(openCells(kept.open, 9)).toEqual(['1,1', '2,1', '3,1']);
  });

  it('floods groups in the order `next` finds them: of two equal groups, the one found SECOND is kept', () => {
    // Two groups of three. Found A then B, the sort of two compares B < A,
    // swaps nothing, and B is last. Found the other way round, A would be.
    const { gen } = setup(createRng('two-tie'));
    const hm = drawn(7, 1, [
      [1, 1],
      [2, 1],
      [3, 1],
      [5, 1],
      [6, 1],
      [7, 1],
    ]);
    const kept = make_hmap(gen, 7, 1, () => hm);
    expect(openCells(kept.open, 7)).toEqual(['5,1', '6,1', '7,1']);
  });

  it('draws its width, then its height, each 6..10', () => {
    const widths = new Set<number>();
    const heights = new Set<number>();
    for (let s = 0; s < 120; s += 1) {
      const rng = createRng(`clearing-size:${String(s)}`);
      const { gen } = setup(rng);
      const twin = rngFromState(rng.getState());
      const room = (loadRoom('forest_clearing') as RoomFn)(gen, 1, 1, 0) as GeneratedRoom;
      expect([room.w, room.h], `seed ${String(s)}`).toEqual([
        twin.int('w', 6, 10),
        twin.int('h', 6, 10),
      ]);
      widths.add(room.w);
      heights.add(room.h);
    }
    expect([...widths].sort((a, c) => a - c)).toEqual([6, 7, 8, 9, 10]);
    expect([...heights].sort((a, c) => a - c)).toEqual([6, 7, 8, 9, 10]);
  });

  it('rebuilds EVERYTHING — heightmap and pit roll — while there is no group or the largest is one cell', () => {
    const { rng, labels } = recording('rebuild');
    const { gen } = setup(rng, {
      roomsConfig: { forestClearing: { pitChance: 50, filters: [{}] } },
    });
    const maps = [
      drawn(4, 4, []),
      drawn(4, 4, [
        [1, 1],
        [3, 3],
      ]),
      drawn(4, 4, [
        [2, 2],
        [3, 3],
      ]),
    ];
    let calls = 0;
    const kept = make_hmap(gen, 4, 4, () => {
      calls += 1;
      return maps[calls - 1] ?? drawn(4, 4, []);
    });
    expect(calls).toBe(3);
    expect(openCells(kept.open, 4)).toEqual(['2,2', '3,3']);
    expect(labels.filter((l) => l === 'mapgen.forest_clearing.pit')).toHaveLength(3);
  });

  it('gives up rebuilding after CLEARING_REBUILDS and keeps what the last build had', () => {
    const { gen } = setup(createRng('give-up'));
    let calls = 0;
    const kept = make_hmap(gen, 4, 4, () => {
      calls += 1;
      return drawn(4, 4, [[2, 2]]);
    });
    expect(calls).toBe(CLEARING_REBUILDS);
    expect(openCells(kept.open, 4)).toEqual(['2,2']);
  });

  it('rolls for a pit only with rooms_config, and records a pit as a vault', () => {
    const pits = (data: Partial<RoomerData>): { vaults: number; rolls: number } => {
      let vaults = 0;
      let rolls = 0;
      for (let s = 0; s < 20; s += 1) {
        const { rng, labels } = recording(`pit:${String(s)}`);
        const { gen } = setup(rng, data);
        const placed = roomAlloc(gen, loadRoom('forest_clearing'), 1, 1, 0);
        if (placed?.room.vault !== undefined) {
          expect(placed.room.vault).toMatchObject({
            id: 'room:forest_clearing',
            w: placed.room.w,
            h: placed.room.h,
          });
          vaults += 1;
        }
        rolls += labels.filter((l) => l.startsWith('mapgen.forest_clearing.pit')).length;
      }
      return { vaults, rolls };
    };
    expect(pits({})).toEqual({ vaults: 0, rolls: 0 });
    expect(pits({ roomsConfig: {} })).toEqual({ vaults: 0, rolls: 0 });
    expect(pits({ roomsConfig: { forestClearing: { pitChance: 0, filters: [{}] } } })).toEqual({
      vaults: 0,
      rolls: 20,
    });
    // One filter: `rng.table` draws nothing for it.
    expect(pits({ roomsConfig: { forestClearing: { pitChance: 100, filters: [{}] } } })).toEqual({
      vaults: 20,
      rolls: 20,
    });
    // Two filters: a hit draws which.
    expect(
      pits({ roomsConfig: { forestClearing: { pitChance: 100, filters: [{}, { type: 'x' }] } } }),
    ).toEqual({ vaults: 20, rolls: 40 });
    // No filters: `rng.table` draws, finds nothing, and there is no pit.
    expect(pits({ roomsConfig: { forestClearing: { pitChance: 100, filters: [] } } })).toEqual({
      vaults: 0,
      rolls: 40,
    });
  });
});

describe('rocky_snowy_trees', () => {
  it('draws its width, then its height, each 5..12', () => {
    const widths = new Set<number>();
    const heights = new Set<number>();
    for (let s = 0; s < 160; s += 1) {
      const rng = createRng(`rocky-size:${String(s)}`);
      const { gen } = setup(rng);
      const twin = rngFromState(rng.getState());
      const room = (loadRoom('rocky_snowy_trees') as RoomFn)(gen, 1, 1, 0) as GeneratedRoom;
      expect([room.w, room.h], `seed ${String(s)}`).toEqual([
        twin.int('w', 5, 12),
        twin.int('h', 5, 12),
      ]);
      widths.add(room.w);
      heights.add(room.h);
    }
    expect([...widths].sort((a, c) => a - c)).toEqual([5, 6, 7, 8, 9, 10, 11, 12]);
    expect([...heights].sort((a, c) => a - c)).toEqual([5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it('cuts its heightmap at 5.4/6 into `#`, at 4.3/6 into `T`, and leaves the rest open room', () => {
    const seen = { wall: 0, tree: 0, open: 0 };
    for (let s = 0; s < 40; s += 1) {
      const rng = createRng(`rocky:${String(s)}`);
      const { gen, map } = setup(rng);
      const fn = loadRoom('rocky_snowy_trees') as RoomFn;
      const room = fn(gen, 7, 1, 0) as GeneratedRoom;
      expect(room.w).toBeGreaterThanOrEqual(5);
      expect(room.w).toBeLessThanOrEqual(12);
      expect(room.h).toBeGreaterThanOrEqual(5);
      expect(room.h).toBeLessThanOrEqual(12);
      expect(room.name).toBe(`rocky_snowy_trees${String(room.w)}x${String(room.h)}`);

      const before = rng.getState();
      expect(room.generator(3, 4, false)).toBeNull();
      const hm = createHeightmap(room.w, room.h, 2, {
        middle: 0,
        upLeft: HEIGHTMAP_MAX,
        downLeft: HEIGHTMAP_MAX,
        upRight: HEIGHTMAP_MAX,
        downRight: HEIGHTMAP_MAX,
      });
      generateHeightmap(hm, rngFromState(before));

      for (let i = 1; i <= room.w; i += 1) {
        for (let j = 1; j <= room.h; j += 1) {
          const v = heightAt(hm, i, j);
          const code = map.get(i + 2, j + 3);
          const cell = map.cell(i + 2, j + 3);
          if (v >= (100000 * 5.4) / 6) {
            expect(code).toBe(TileCode.WALL);
            expect(cell.room).toBeNull();
            seen.wall += 1;
          } else if (v >= (100000 * 4.3) / 6) {
            expect(code).toBe(TileCode.TREES);
            expect(cell.room).toBeNull();
            seen.tree += 1;
          } else {
            expect(code).toBe(TileCode.FLOOR);
            expect(cell.room).toBe(7);
            seen.open += 1;
          }
        }
      }
    }
    expect(Math.min(seen.wall, seen.tree, seen.open)).toBeGreaterThan(100);
  });
});
