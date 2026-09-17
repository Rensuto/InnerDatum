// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// The generator under test is ported from t-engine4 game/engines/default/engine/generator/map/Cavern.lua:28-246.
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

import { describe, expect, it } from 'vitest';

import type { TileXY } from '../../../src/shared/coords.ts';
import type { AuthoredMap } from '../../../src/shared/level.ts';
import {
  CAVERN_MAX_REBUILDS,
  addDoors,
  createCavern,
  fillCavern,
  generate,
  makeStairsInside,
  tableShuffle,
} from '../../../src/shared/mapgen/cavern.ts';
import type { CavernData, CavernGen, CavernResult } from '../../../src/shared/mapgen/cavern.ts';
import { createGenMap } from '../../../src/shared/mapgen/genmap.ts';
import type { GenMap } from '../../../src/shared/mapgen/genmap.ts';
import {
  CAVERN_ORC_BREEDING_PIT,
  newLevel,
  toAuthoredMap,
} from '../../../src/shared/mapgen/level.ts';
import { tableSort } from '../../../src/shared/mapgen/sort.ts';
import { createNoise2 } from '../../../src/shared/noise.ts';
import { TileCode, isWalkable } from '../../../src/shared/protocol.ts';
import { createRng, rngFromState } from '../../../src/shared/rng.ts';
import type { Rng } from '../../../src/shared/rng.ts';

const GRID = {
  floor: TileCode.FLOOR,
  wall: TileCode.WALL,
  up: TileCode.FLOOR,
  down: TileCode.FLOOR,
  door: TileCode.DOOR,
} as const;

const PIT: CavernData = { ...CAVERN_ORC_BREEDING_PIT.map, grid: GRID };

function cavern(
  seed: string,
  data: CavernData = PIT,
  opts: { w?: number; h?: number; level?: number; maxLevel?: number } = {},
): { gen: CavernGen; map: GenMap; level: { forceRecreate: string | null } } {
  const rng = createRng(seed);
  const map = createGenMap(opts.w ?? 50, opts.h ?? 50, data.grid, rng);
  const level = { forceRecreate: null as string | null };
  const gen = createCavern(map, data, rng, { maxLevel: opts.maxLevel ?? 3 }, level);
  return { gen, map, level };
}

function run(
  seed: string,
  data: CavernData = PIT,
  opts: { w?: number; h?: number; level?: number; maxLevel?: number } = {},
): { gen: CavernGen; map: GenMap; result: CavernResult | null; forceRecreate: string | null } {
  const { gen, map, level } = cavern(seed, data, opts);
  const result = generate(gen, opts.level ?? 1, 0);
  return { gen, map, result, forceRecreate: level.forceRecreate };
}

const key = (x: number, y: number): number => y * 1000 + x;

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

/**
 * `engine/generator/map/Cavern.lua:46-107` again, from the Lua and not from the
 * port: 1-based `list` with nil holes, `next` as the lowest slot still set, a
 * queue taken from the front with `table.remove(q, 1)`, groups sorted with
 * LuaJIT's sort (`mapgen/sort.ts`, pinned to the C in `sort.test.ts`), and every
 * resolve of a TABLE key a `rng.range(1, #t)`. Returns the tiles, row-major, or
 * null where the Lua would call `generate` again.
 */
function luaFill(
  rng: Rng,
  w: number,
  h: number,
  zoom: number,
  minFloor: number,
  floor: readonly number[],
  wall: readonly number[],
): number[] | null {
  const pick = (t: readonly number[]): number => t[rng.int('resolve', 1, t.length) - 1] ?? -1;
  const noise = createNoise2(rng, 'noise', 0.2, 4);
  const tiles: number[] = Array.from({ length: w * h }, () => -1);
  const opens = new Map<string, number>();
  const list: ({ x: number; y: number } | undefined)[] = [];
  for (let i = 0; i <= w - 1; i += 1) {
    for (let j = 0; j <= h - 1; j += 1) {
      if (noise.simplex((zoom * i) / w, (zoom * j) / h) > 0) {
        tiles[j * w + i] = pick(floor);
        opens.set(`${String(i)},${String(j)}`, list.length + 1);
        list[list.length] = { x: i, y: j };
      } else {
        tiles[j * w + i] = pick(wall);
      }
    }
  }
  const floodFill = (x: number, y: number): { x: number; y: number }[] => {
    const q = [{ x, y }];
    const closed: { x: number; y: number }[] = [];
    while (q.length > 0) {
      const n = q.shift() as { x: number; y: number };
      const slot = opens.get(`${String(n.x)},${String(n.y)}`);
      if (slot === undefined) continue;
      closed.push(n);
      list[slot - 1] = undefined;
      opens.delete(`${String(n.x)},${String(n.y)}`);
      q.push({ x: n.x - 1, y: n.y }, { x: n.x, y: n.y + 1 }, { x: n.x + 1, y: n.y });
      q.push({ x: n.x, y: n.y - 1 }, { x: n.x + 1, y: n.y - 1 }, { x: n.x + 1, y: n.y + 1 });
      q.push({ x: n.x - 1, y: n.y - 1 }, { x: n.x - 1, y: n.y + 1 });
    }
    return closed;
  };
  const groups: { x: number; y: number }[][] = [];
  for (;;) {
    const l = list.find((entry) => entry !== undefined);
    if (l === undefined) break;
    groups.push(floodFill(l.x, l.y));
  }
  if (groups.length === 0) return null;
  tableSort(groups, (a, b) => a.length < b.length);
  if ((groups[groups.length - 1]?.length ?? 0) < minFloor) return null;
  for (let i = 1; i <= groups.length - 1; i += 1) {
    for (const jn of groups[i - 1] ?? []) tiles[jn.y * w + jn.x] = pick(wall);
  }
  return tiles;
}

/**
 * The regions of an open-cell predicate, eight-connected, written again here
 * rather than taken from `fillCavern` so the rule cannot certify itself.
 */
function regions(w: number, h: number, open: (x: number, y: number) => boolean): Set<number>[] {
  const seen = new Set<number>();
  const out: Set<number>[] = [];
  for (let x = 0; x < w; x += 1) {
    for (let y = 0; y < h; y += 1) {
      if (!open(x, y) || seen.has(key(x, y))) continue;
      const region = new Set<number>([key(x, y)]);
      seen.add(key(x, y));
      const stack: TileXY[] = [{ x, y }];
      for (let at = stack.pop(); at !== undefined; at = stack.pop()) {
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            const nx = at.x + dx;
            const ny = at.y + dy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            if (!open(nx, ny) || seen.has(key(nx, ny))) continue;
            seen.add(key(nx, ny));
            region.add(key(nx, ny));
            stack.push({ x: nx, y: ny });
          }
        }
      }
      out.push(region);
    }
  }
  return out;
}

/** The cells a body reaches from `from`, eight ways or four. */
function reach(map: AuthoredMap, from: TileXY, eight: boolean): Set<number> {
  const { w, h, tiles } = map.view;
  const seen = new Set<number>([from.y * w + from.x]);
  const queue = [from.y * w + from.x];
  for (let head = 0; head < queue.length; head += 1) {
    const at = queue[head] ?? 0;
    const x = at % w;
    const y = (at - x) / w;
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        if (!eight && dx !== 0 && dy !== 0) continue;
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h || seen.has(ny * w + nx)) continue;
        if (!isWalkable(tiles[ny * w + nx] ?? TileCode.WALL)) continue;
        seen.add(ny * w + nx);
        queue.push(ny * w + nx);
      }
    }
  }
  return seen;
}

describe('Cavern:generate — the noise and the biggest region', () => {
  it('opens a cell only where its noise sample, at zoom*i/w and zoom*j/h, is above zero', () => {
    // NOT SQUARE, so a w/h swap in the sample coordinates shows.
    const w = 44;
    const h = 31;
    let open = 0;
    let rock = 0;
    for (let s = 0; s < 6; s += 1) {
      const seed = `sign:${String(s)}`;
      const { gen, map } = cavern(seed, { ...PIT, minFloor: 0 }, { w, h });
      expect(fillCavern(gen)).toBe(true);
      // The same stream again: the noise object is the fill's first draw.
      const noise = createNoise2(createRng(seed), 'mapgen.cavern.noise', 0.2, 4);
      const positive = (x: number, y: number): boolean =>
        noise.simplex((23 * x) / w, (23 * y) / h) > 0;
      for (let x = 0; x < w; x += 1) {
        for (let y = 0; y < h; y += 1) {
          if (positive(x, y)) {
            open += 1;
          } else {
            rock += 1;
            expect(map.get(x, y), `${seed}: ${String(x)},${String(y)} sampled <= 0`).toBe(
              TileCode.WALL,
            );
          }
        }
      }
      // And the open cells kept are exactly the biggest region of the positive ones.
      const biggest = regions(w, h, positive).reduce((a, b) => (b.size > a.size ? b : a));
      for (let x = 0; x < w; x += 1) {
        for (let y = 0; y < h; y += 1) {
          expect(map.get(x, y), `${seed}: ${String(x)},${String(y)}`).toBe(
            biggest.has(key(x, y)) ? TileCode.FLOOR : TileCode.WALL,
          );
        }
      }
    }
    expect(open).toBeGreaterThan(1000);
    expect(rock).toBeGreaterThan(1000);
  });

  it('keeps one eight-connected region, the biggest, and walls in every other', () => {
    let dropped = 0;
    for (let s = 0; s < 20; s += 1) {
      const seed = `largest:${String(s)}`;
      const { gen, map } = cavern(seed, { ...PIT, minFloor: 0 });
      fillCavern(gen);
      const noise = createNoise2(createRng(seed), 'mapgen.cavern.noise', 0.2, 4);
      const found = regions(50, 50, (x, y) => noise.simplex((23 * x) / 50, (23 * y) / 50) > 0);
      const sizes = found.map((r) => r.size).sort((a, b) => b - a);
      dropped += found.length - 1;
      const kept = regions(50, 50, (x, y) => map.get(x, y) === TileCode.FLOOR);
      expect(kept).toHaveLength(1);
      expect(kept[0]?.size).toBe(sizes[0]);
    }
    expect(dropped, 'no field had a second region to wall in').toBeGreaterThan(20);
  });

  it('starts over from a fresh field on the same stream until the biggest region holds min_floor', () => {
    // Replayed from the stream: field k is the k-th noise object drawn, and the
    // level is the first whose biggest region reaches min_floor.
    let rebuilt = 0;
    for (let s = 0; s < 12; s += 1) {
      const seed = `rebuild:${String(s)}`;
      const minFloor = 1000;
      const { gen, map, result } = run(seed, { ...PIT, minFloor });
      expect(result).not.toBeNull();
      const rng = createRng(seed);
      const field = (): Set<number> => {
        const noise = createNoise2(rng, 'mapgen.cavern.noise', 0.2, 4);
        const found = regions(50, 50, (x, y) => noise.simplex((23 * x) / 50, (23 * y) / 50) > 0);
        return found.reduce((a, b) => (b.size > a.size ? b : a), new Set<number>());
      };
      let fields = 1;
      let biggest = field();
      while (biggest.size < minFloor) {
        fields += 1;
        biggest = field();
      }
      expect(gen.rebuilds, seed).toBe(fields - 1);
      rebuilt += gen.rebuilds;
      let floor = 0;
      for (let x = 0; x < 50; x += 1) {
        for (let y = 0; y < 50; y += 1) {
          if (!isWalkable(map.get(x, y) ?? TileCode.WALL)) continue;
          floor += 1;
          expect(biggest.has(key(x, y)), `${seed}: ${String(x)},${String(y)}`).toBe(true);
        }
      }
      expect(floor).toBe(biggest.size);
    }
    expect(rebuilt, 'no field fell short of min_floor, so no restart was tested').toBeGreaterThan(
      5,
    );
  });

  it('starts over when the field has no open cell at all, and gives up past the cap', () => {
    // Perlin noise is exactly 0 on the integer lattice, and zoom = w puts every
    // sample on it, so no cell is ever open and upstream would recurse forever.
    const { gen, result, forceRecreate } = run(
      'no-groups',
      { ...PIT, noise: 'perlin', zoom: 12, minFloor: 0 },
      { w: 12, h: 12 },
    );
    expect(result).toBeNull();
    expect(gen.rebuilds).toBe(CAVERN_MAX_REBUILDS + 1);
    expect(forceRecreate).toMatch(/^Cavern: /);
  });

  it('refuses a table whose min_floor its map cannot hold, and newLevel moves on', () => {
    const level = newLevel(
      { width: 8, height: 8, map: { ...CAVERN_ORC_BREEDING_PIT.map, minFloor: 65 } },
      'too-big',
      { level: 1, maxLevel: 1 },
    );
    expect(level.failed).toBe(true);
    expect(level.attempts).toBe(50);
  });

  it('refuses a min_floor above the map`s area before rolling a single field', () => {
    const over = run('over-area', { ...PIT, minFloor: 65 }, { w: 8, h: 8 });
    expect(over.result).toBeNull();
    expect(over.gen.rebuilds).toBe(0);
    expect(over.gen.rng.getState().count).toBe(0);
    expect(over.forceRecreate).toMatch(/min_floor 65 is more than the map's 64 cells/);
    // EXACTLY the area is not refused: a map all floor would meet it.
    expect(run('at-area', { ...PIT, minFloor: 64 }, { w: 8, h: 8 }).gen.rebuilds).toBeGreaterThan(
      0,
    );
  });

  it('keeps a field whose biggest region is EXACTLY min_floor, and rebuilds one a cell short', () => {
    // `#g.list >= self.min_floor` (`engine/generator/map/Cavern.lua:100`).
    let checked = 0;
    for (let s = 0; s < 8; s += 1) {
      const seed = `boundary:${String(s)}`;
      const noise = createNoise2(createRng(seed), 'mapgen.cavern.noise', 0.2, 4);
      const found = regions(50, 50, (x, y) => noise.simplex((23 * x) / 50, (23 * y) / 50) > 0);
      const biggest = Math.max(0, ...found.map((r) => r.size));
      if (biggest === 0) continue;
      checked += 1;
      expect(run(seed, { ...PIT, minFloor: biggest }).gen.rebuilds, seed).toBe(0);
      expect(run(seed, { ...PIT, minFloor: biggest + 1 }).gen.rebuilds, seed).toBeGreaterThan(0);
    }
    expect(checked).toBe(8);
  });

  it('resolves TABLE keys cell by cell as the Lua does: fill order, flood order, walling order', () => {
    // A key that names several codes draws on every resolve, so the ORDER cells
    // are written in shows in the tiles. The Scintillating Caves give twenty
    // walls (`data/zones/scintillating-caves/zone.lua:127`); three do here.
    const floor = [TileCode.FLOOR, TileCode.SOOT];
    const wall = [TileCode.WALL, TileCode.CRAG, TileCode.TREES];
    const cases = [
      { w: 50, h: 50, zoom: 23, minFloor: 900 },
      { w: 44, h: 31, zoom: 23, minFloor: 0 },
      { w: 30, h: 30, zoom: 8, minFloor: 150 },
    ];
    let walled = 0;
    for (const c of cases) {
      for (let s = 0; s < 6; s += 1) {
        const seed = `table-keys:${String(c.w)}:${String(s)}`;
        const grid = { ...GRID, floor, wall };
        const { gen, map } = cavern(seed, { ...PIT, zoom: c.zoom, minFloor: c.minFloor, grid }, c);
        const kept = fillCavern(gen);
        const want = luaFill(createRng(seed), c.w, c.h, c.zoom, c.minFloor, floor, wall);
        expect(kept, seed).toBe(want !== null);
        if (want === null) continue;
        expect(Array.from(map.tiles), seed).toEqual(want);
        walled += 1;
      }
    }
    expect(walled, 'no field was kept, so the walling order went unchecked').toBeGreaterThan(8);
  });
});

describe('Cavern:generate — rooms, doors and stairs', () => {
  it('places no room and no door on the breeding pits` table', () => {
    for (let s = 0; s < 10; s += 1) {
      const { map, result } = run(`bare:${String(s)}`);
      expect(result).not.toBeNull();
      expect(map.rooms).toEqual([]);
      expect(map.roomsFailed).toEqual([]);
      expect(Array.from(map.tiles).includes(TileCode.DOOR)).toBe(false);
    }
  });

  it('makes one try per random room and never replaces a failed one', () => {
    // A small map, big rooms: some fail to place, and each failure is final.
    let failed = 0;
    for (let s = 0; s < 20; s += 1) {
      const { map } = run(
        `rooms:${String(s)}`,
        { ...PIT, minFloor: 0, nbRooms: 3, rooms: ['simple'] },
        { w: 22, h: 22 },
      );
      expect(map.rooms.length + map.roomsFailed.length).toBe(3);
      failed += map.roomsFailed.length;
    }
    expect(failed, 'every room placed, so a retry would not have shown').toBeGreaterThan(0);
  });

  it('spends required rooms out of nb_rooms, and asks for a recreate when one will not place', () => {
    const { map } = run('required', {
      ...PIT,
      nbRooms: 2,
      rooms: ['simple'],
      requiredRooms: ['money_vault'],
    });
    expect(map.rooms.length + map.roomsFailed.length).toBe(2);
    expect(map.rooms[0]?.room.name).toBe('money_vault5x5');

    const refused = run('refused', {
      ...PIT,
      requiredRooms: ['lesser_vault'],
      lesserVaultsList: [],
    });
    expect(refused.result).toBeNull();
    expect(refused.forceRecreate).toBe('required_room lesser_vault');
  });

  it('hangs doors only across a one-cell gap, never two side by side, and only when asked', () => {
    let doors = 0;
    for (let s = 0; s < 10; s += 1) {
      const { map } = run(`doors:${String(s)}`, { ...PIT, doorChance: 100 });
      const blocked = (x: number, y: number): boolean =>
        map.get(x, y) !== null && !isWalkable(map.get(x, y) ?? TileCode.WALL);
      for (let x = 0; x < 50; x += 1) {
        for (let y = 0; y < 50; y += 1) {
          if (map.get(x, y) !== TileCode.DOOR) continue;
          doors += 1;
          expect(x > 0 && y > 0 && x < 49 && y < 49).toBe(true);
          const acrossEW = blocked(x - 1, y) && blocked(x + 1, y);
          const acrossNS = blocked(x, y - 1) && blocked(x, y + 1);
          const openNS = !blocked(x, y - 1) && !blocked(x, y + 1);
          const openEW = !blocked(x - 1, y) && !blocked(x + 1, y);
          expect((acrossEW && openNS) || (acrossNS && openEW), `${String(x)},${String(y)}`).toBe(
            true,
          );
        }
      }
    }
    expect(doors, 'door_chance 100 hung no door').toBeGreaterThan(50);
  });

  it('rolls for doors at door_chance 0, because 0 is true in Lua, and not at nil', () => {
    const nil = run('zero', PIT);
    const zero = run('zero', { ...PIT, doorChance: 0 });
    expect(Array.from(zero.map.tiles)).toEqual(Array.from(nil.map.tiles));
    expect(zero.gen.rng.getState().count).toBeGreaterThan(nil.gen.rng.getState().count);
  });

  it('hangs a door on every candidate it rolls, striking that door`s four neighbours', () => {
    // A corridor of doorway-shaped cells: rock above and below, open along it,
    // so x 1..7 are candidates. At 100% each door struck its neighbours, so no
    // two are side by side, and none is left without a door beside it.
    const rng = createRng('corridor');
    const map = createGenMap(9, 3, GRID, rng);
    for (let x = 0; x < 9; x += 1) {
      map.set(x, 0, TileCode.WALL);
      map.set(x, 1, TileCode.FLOOR);
      map.set(x, 2, TileCode.WALL);
    }
    const gen = createCavern(map, PIT, rng, { maxLevel: 1 }, { forceRecreate: null });
    addDoors(gen, 100);
    const row = Array.from({ length: 9 }, (_, x) => (map.get(x, 1) === TileCode.DOOR ? '+' : '.'));
    expect(row.join('')).not.toMatch(/\+\+/);
    expect(row[0]).toBe('.');
    expect(row[8]).toBe('.');
    for (let x = 1; x <= 7; x += 1) {
      if (row[x] === '+') continue;
      expect(row[x - 1] === '+' || row[x + 1] === '+', `${String(x)} was struck by nothing`).toBe(
        true,
      );
    }
  });

  it('stands both stairs on open cells that are not special, down first, in 1..w-1', () => {
    for (let s = 0; s < 40; s += 1) {
      const rng = createRng(`stairs:${String(s)}`);
      const map = createGenMap(8, 8, GRID, rng);
      for (let x = 0; x < 8; x += 1) for (let y = 0; y < 8; y += 1) map.set(x, y, TileCode.WALL);
      // Open at the far corner, which `range(1, w-1)` reaches; on column 0 and
      // row 0, which it never does; and at two cells, one of them special.
      map.set(7, 7, TileCode.FLOOR);
      map.set(0, 3, TileCode.FLOOR);
      map.set(3, 0, TileCode.FLOOR);
      map.set(3, 4, TileCode.FLOOR);
      map.set(5, 2, TileCode.FLOOR);
      map.cell(5, 2).special = true;
      const gen = createCavern(map, PIT, rng, { maxLevel: 3 }, { forceRecreate: null });
      const { up, down } = makeStairsInside(gen, 1, 0, []);
      const cells = [down, up].map((c) => `${String(c?.x)},${String(c?.y)}`).sort();
      expect(cells).toEqual(['3,4', '7,7']);
      expect(map.cell(3, 4).special).toBe('exit');
      expect(map.cell(7, 7).special).toBe('exit');
    }
  });

  it('places the DOWN stair first: it takes the first open cell the draws reach, and up the next', () => {
    // `engine/generator/map/Cavern.lua:220-246`: down, then up, each drawing x
    // then y until a cell is open and not special.
    let downOnTheLowerCell = 0;
    for (let s = 0; s < 40; s += 1) {
      const rng = createRng(`stair-order:${String(s)}`);
      const map = createGenMap(8, 8, GRID, rng);
      for (let x = 0; x < 8; x += 1) for (let y = 0; y < 8; y += 1) map.set(x, y, TileCode.WALL);
      map.set(7, 7, TileCode.FLOOR);
      map.set(3, 4, TileCode.FLOOR);
      const gen = createCavern(map, PIT, rng, { maxLevel: 3 }, { forceRecreate: null });
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

  it('rolls a chance room`s percent every time it is picked, required or random', () => {
    const { rng, labels } = recording('chance-rooms');
    const map = createGenMap(50, 50, GRID, rng);
    const level = { forceRecreate: null as string | null };
    const data: CavernData = {
      ...PIT,
      minFloor: 0,
      nbRooms: 3,
      rooms: [['simple', 50]],
      requiredRooms: [['simple', 100]],
    };
    generate(createCavern(map, data, rng, { maxLevel: 3 }, level), 1, 0);
    expect(labels.filter((l) => l === 'mapgen.cavern.required.chance')).toHaveLength(1);
    // Two random rooms left, each re-picked until its 50% roll passes.
    expect(labels.filter((l) => l === 'mapgen.cavern.room.chance').length).toBeGreaterThanOrEqual(
      2,
    );
  });

  it('shuffles the door candidates, then takes them from the END, as the Lua does', () => {
    // A plate of one-wide corridors, so there are many candidates and many
    // neighbours to strike; at 50% the order decides which become doors.
    let doors = 0;
    for (let s = 0; s < 12; s += 1) {
      const rng = createRng(`door-order:${String(s)}`);
      const map = createGenMap(9, 7, GRID, rng);
      for (let x = 0; x < 9; x += 1) {
        for (let y = 0; y < 7; y += 1) {
          map.set(x, y, y % 2 === 1 || x % 4 === 0 ? TileCode.FLOOR : TileCode.WALL);
        }
      }
      const blocked = (x: number, y: number): boolean => map.blockMove(x, y);
      const possible: { x: number; y: number }[] = [];
      for (let i = 1; i <= 7; i += 1) {
        for (let j = 1; j <= 5; j += 1) {
          const g4 = blocked(i - 1, j);
          const g6 = blocked(i + 1, j);
          const g2 = blocked(i, j + 1);
          const g8 = blocked(i, j - 1);
          if ((g4 && g6 && !g2 && !g8) || (!g4 && !g6 && g2 && g8)) possible.push({ x: i, y: j });
        }
      }
      const gen = createCavern(map, PIT, rng, { maxLevel: 1 }, { forceRecreate: null });
      const twin = rngFromState(rng.getState());
      addDoors(gen, 50);

      // `table.shuffle` (`engine/utils.lua:610-617`), then `table.remove` from the end.
      for (let i = possible.length; i >= 2; i -= 1) {
        const j = twin.int('shuffle', 1, i);
        const a = possible[i - 1] as { x: number; y: number };
        possible[i - 1] = possible[j - 1] as { x: number; y: number };
        possible[j - 1] = a;
      }
      const want = new Set<string>();
      const strike = (x: number, y: number): void => {
        const k = possible.findIndex((d) => d.x === x && d.y === y);
        if (k >= 0) possible.splice(k, 1);
      };
      for (let d = possible.pop(); d !== undefined; d = possible.pop()) {
        if (twin.int('door', 0, 99) < 50) {
          want.add(`${String(d.x)},${String(d.y)}`);
          strike(d.x - 1, d.y);
          strike(d.x + 1, d.y);
          strike(d.x, d.y - 1);
          strike(d.x, d.y + 1);
        }
      }
      const got = new Set<string>();
      for (let x = 0; x < 9; x += 1) {
        for (let y = 0; y < 7; y += 1) {
          if (map.get(x, y) === TileCode.DOOR) got.add(`${String(x)},${String(y)}`);
        }
      }
      expect(got, `seed ${String(s)}`).toEqual(want);
      doors += got.size;
    }
    expect(doors).toBeGreaterThan(12);
  });

  it('places no down stair on the zone`s last level unless forced', () => {
    const last = run('last', { ...PIT, forceLastStair: false }, { level: 3, maxLevel: 3 });
    expect(last.result?.down).toBeNull();
    expect(last.result?.up).not.toBeNull();
    const above = run('last', { ...PIT, forceLastStair: false }, { level: 2, maxLevel: 3 });
    expect(above.result?.down).not.toBeNull();
    const forced = run('last', PIT, { level: 3, maxLevel: 3 });
    expect(forced.result?.down).not.toBeNull();
  });
});

describe('Cavern:init and the breeding pits` table', () => {
  it('writes upstream`s defaults for every field a zone leaves out', () => {
    // `engine/generator/map/Cavern.lua:32-38`, and RoomsLoader's tunnel defaults.
    const { gen } = cavern('defaults', { grid: GRID });
    expect(gen).toMatchObject({
      zoom: 12,
      hurst: 0.2,
      lacunarity: 4,
      octave: 1,
      doorChance: null,
      minFloor: 900,
      noise: 'simplex',
    });
    expect(gen.data).toMatchObject({ tunnelChange: 30, tunnelRandom: 10, liteRoomChance: 100 });
  });

  it('pins the orc breeding pits to `data/zones/orc-breeding-pit/zone.lua:24-43`', () => {
    expect(CAVERN_ORC_BREEDING_PIT).toEqual({
      width: 50,
      height: 50,
      map: {
        class: 'Cavern',
        zoom: 23,
        minFloor: 900,
        forceLastStair: true,
        grid: {
          floor: TileCode.FLOOR,
          wall: TileCode.WALL,
          up: TileCode.FLOOR,
          down: TileCode.FLOOR,
          door: TileCode.FLOOR,
        },
      },
    });
  });
});

describe('the orc breeding pits, through newLevel', () => {
  const levels = Array.from({ length: 40 }, (_, s) =>
    newLevel(CAVERN_ORC_BREEDING_PIT, `pit:${String(s)}`, { level: 1, maxLevel: 1 }),
  );

  it('certifies first time, with both stairs on the floor', () => {
    for (const { map, attempts, failed } of levels) {
      expect(failed).toBe(false);
      expect(attempts).toBe(1);
      const { w, tiles } = map.view;
      const up = map.spawns[0];
      const { down } = map;
      if (up === undefined || down === undefined) throw new Error('a stair is missing');
      expect(tiles[up.y * w + up.x]).toBe(TileCode.FLOOR);
      expect(tiles[down.y * w + down.x]).toBe(TileCode.FLOOR);
      expect(map.rooms).toEqual([]);
      expect(map.vaults).toEqual([]);
    }
  });

  it('reaches every open cell from the up stair eight ways, and no fewer than min_floor of them', () => {
    let diagonalOnly = 0;
    for (const { map } of levels) {
      const up = map.spawns[0];
      if (up === undefined) throw new Error('no up stair');
      const walkable = map.view.tiles.filter((c) => isWalkable(c)).length;
      expect(walkable).toBeGreaterThanOrEqual(900);
      expect(reach(map, up, true).size).toBe(walkable);
      if (reach(map, up, false).size < walkable) diagonalOnly += 1;
    }
    // THE WIDENING IS NEEDED: floors joined only across a corner are common, so a
    // four-way rule would call them broken.
    expect(diagonalOnly).toBeGreaterThan(10);
  });
});

describe('toAuthoredMap on Cavern`s grid keys', () => {
  it('ships nil terrain as the `wall` key when there is no `#` key', () => {
    const keys = { floor: TileCode.SOOT, wall: TileCode.CRAG };
    const map = createGenMap(4, 3, keys, createRng('nil'));
    map.set(1, 1, TileCode.SOOT);
    const tiles = toAuthoredMap(map, null, null, keys).view.tiles;
    expect(tiles.filter((c) => c === TileCode.CRAG)).toHaveLength(11);
    expect(tiles[5]).toBe(TileCode.SOOT);
  });
});

describe('table.shuffle', () => {
  it('draws once per element after the first, and keeps every element', () => {
    for (const n of [0, 1, 2, 7, 30]) {
      const rng = createRng(`shuffle:${String(n)}`);
      const bounds: string[] = [];
      const counted = {
        ...rng,
        int: (label: string, lo: number, hi: number): number => {
          bounds.push(`${String(lo)}..${String(hi)}`);
          return rng.int(label, lo, hi);
        },
      };
      const list = Array.from({ length: n }, (_, i) => i);
      tableShuffle(counted, 'shuffle', list);
      // `rng.range(1, i)` for i = n down to 2.
      expect(bounds).toEqual(
        Array.from({ length: Math.max(0, n - 1) }, (_, k) => `1..${String(n - k)}`),
      );
      expect([...list].sort((a, b) => a - b)).toEqual(Array.from({ length: n }, (_, i) => i));
    }
  });

  it('swaps from the end down: the last slot is drawn from all n', () => {
    const last = new Set<number>();
    for (let s = 0; s < 200; s += 1) {
      const list = [0, 1, 2, 3, 4];
      tableShuffle(createRng(`end:${String(s)}`), 'shuffle', list);
      last.add(list[4] ?? -1);
    }
    expect([...last].sort()).toEqual([0, 1, 2, 3, 4]);
  });
});
