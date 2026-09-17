// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// The generator under test is ported from t-engine4 game/engines/default/engine/generator/map/Maze.lua:27-112
//   and the zone from game/modules/tome/data/zones/maze/zone.lua:133-189.
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

import { describe, expect, it } from 'vitest';

import type { TileXY } from '../../../src/shared/coords.ts';
import { reachable, reachableSet } from '../../../src/shared/mapgen/connectivity.ts';
import { NIL_TERRAIN, createGenMap } from '../../../src/shared/mapgen/genmap.ts';
import type { GenMap, GridKeys } from '../../../src/shared/mapgen/genmap.ts';
import { toAuthoredMap } from '../../../src/shared/mapgen/level.ts';
import { MAZE_THE_MAZE, createMaze, generate } from '../../../src/shared/mapgen/maze.ts';
import type { MazeData, MazeGen, MazeResult } from '../../../src/shared/mapgen/maze.ts';
import { TileCode, isWalkable } from '../../../src/shared/protocol.ts';
import { createRng } from '../../../src/shared/rng.ts';
import type { Rng } from '../../../src/shared/rng.ts';

const GRID: GridKeys = {
  floor: TileCode.FLOOR,
  wall: TileCode.WALL,
  up: TileCode.FLOOR,
  down: TileCode.FLOOR,
};

type Opts = { w?: number; h?: number; level?: number; maxLevel?: number };

function run(
  seed: string,
  data: MazeData = { grid: GRID },
  opts: Opts = {},
): { gen: MazeGen; map: GenMap; result: MazeResult } {
  const rng = createRng(seed);
  const map = createGenMap(opts.w ?? 41, opts.h ?? 41, data.grid, rng);
  const gen = createMaze(map, data, rng, { maxLevel: opts.maxLevel ?? 2 }, { forceRecreate: null });
  return { gen, map, result: generate(gen, opts.level ?? 1, 0) };
}

/** The zone table, exactly as a level of it is built. */
function zoneLevel(seed: string): { gen: MazeGen; map: GenMap; result: MazeResult } {
  return run(seed, MAZE_THE_MAZE.map, { w: MAZE_THE_MAZE.width, h: MAZE_THE_MAZE.height });
}

const open = (map: GenMap, x: number, y: number): boolean => {
  const code = map.get(x, y);
  return code !== null && isWalkable(code);
};

/**
 * The shapes the tests sweep: the Maze zone's, a `widen` 1 maze, the Dreams'
 * `widen` 3 at 48x48 (`data/zones/dreams/zone.lua:42-53`), and two with unequal
 * widths and a map that is not a multiple of them.
 */
const SHAPES = [
  { name: 'maze zone 60x60 w2', w: 60, h: 60, widenW: 2, widenH: 2 },
  { name: '41x41 w1', w: 41, h: 41, widenW: 1, widenH: 1 },
  { name: 'dreams 48x48 w3', w: 48, h: 48, widenW: 3, widenH: 3 },
  { name: '45x37 w1x2', w: 45, h: 37, widenW: 1, widenH: 2 },
  { name: '61x47 w2x3', w: 61, h: 47, widenW: 2, widenH: 3 },
] as const;

/**
 * Maze cell `(i, j)` is carved: its BOTTOM-RIGHT map cell is open. No stair
 * ever stands there unless `widen` is 1, and every stair code here is walkable.
 */
const carved = (map: GenMap, ww: number, wh: number, i: number, j: number): boolean =>
  open(map, i * ww + ww - 1, j * wh + wh - 1);

/**
 * The step lattice, computed from the rule and not from the port: odd maze
 * coordinates above 0, inside the maze (`floor(map / widen)` cells) and below
 * `map - 1` on the same axis.
 */
function lattice(mapLen: number, widen: number): number[] {
  const out: number[] = [];
  const cells = Math.floor(mapLen / widen);
  for (let i = 1; i < cells && i < mapLen - 1; i += 2) out.push(i);
  return out;
}

/** An Rng that records the label of every top-level draw. */
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
 * `engine/generator/map/Maze.lua:27-112` again, shaped like the Lua and not
 * like the port: `room_map` as a table of tables that exists only for map
 * cells (so an index off the map reads nil), a 1-based `moves` list, `rng.range`
 * with the C's no-draw rule for equal bounds, and a TABLE for every grid key so
 * each resolve draws. Returns the terrain (-1 for nil) and the four return values.
 */
function luaMaze(
  rng: Rng,
  W: number,
  H: number,
  data: { widen_w: number; widen_h: number },
  grid: { wall: number[]; floor: number[]; up: number[]; down: number[] },
  lev: number,
  maxLevel: number,
  forceLastStair: boolean,
): { terrain: number[]; ux: number; uy: number; dx: number; dy: number } {
  const rngRange = (a: number, b: number): number =>
    a === b ? a : rng.int('lua', Math.min(a, b), Math.max(a, b));
  const resolve = (t: number[]): number => t[rngRange(1, t.length) - 1] ?? -99;
  const terrain: number[] = Array.from({ length: W * H }, () => -1);
  const mapCall = (x: number, y: number, e: number): void => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    terrain[y * W + x] = e;
  };
  const roomMap = new Map<string, { maze_wall?: boolean; special?: string }>();
  for (let i = 0; i <= W - 1; i += 1) {
    for (let j = 0; j <= H - 1; j += 1) roomMap.set(`${String(i)},${String(j)}`, {});
  }
  const rm = (i: number, j: number): { maze_wall?: boolean; special?: string } | undefined =>
    roomMap.get(`${String(i)},${String(j)}`);

  const dataW = Math.floor(W / data.widen_w);
  const dataH = Math.floor(H / data.widen_h);
  let lastx = 0;
  let lasty = 0;
  const doTile = (i: number, j: number, wall: boolean): void => {
    for (let ii = 0; ii <= data.widen_w - 1; ii += 1) {
      for (let jj = 0; jj <= data.widen_h - 1; jj += 1) {
        mapCall(
          i * data.widen_w + ii,
          j * data.widen_h + jj,
          resolve(wall ? grid.wall : grid.floor),
        );
      }
    }
    const cell = rm(i, j);
    if (cell === undefined) throw new Error('attempt to index a nil value');
    cell.maze_wall = wall;
    if (!wall) {
      lastx = Math.max(lastx, i);
      lasty = Math.max(lasty, j);
    }
  };
  for (let i = 0; i <= dataW - 1; i += 1) {
    for (let j = 0; j <= dataH - 1; j += 1) doTile(i, j, true);
  }
  let xpos = 1;
  let ypos = 1;
  const moves: number[][] = [[xpos, ypos]];
  const pickp = rngRange(1, 4);
  while (moves.length > 0) {
    const pickn = moves.length - Math.floor((rngRange(1, 100000) / 100001) ** pickp * moves.length);
    const pick = moves[pickn - 1] ?? [];
    xpos = pick[0] ?? -1;
    ypos = pick[1] ?? -1;
    const dir: number[] = [];
    if (rm(xpos + 2, ypos)?.maze_wall === true && xpos + 2 > 0 && xpos + 2 < W - 1) dir.push(6);
    if (rm(xpos - 2, ypos)?.maze_wall === true && xpos - 2 > 0 && xpos - 2 < W - 1) dir.push(4);
    if (rm(xpos, ypos - 2)?.maze_wall === true && ypos - 2 > 0 && ypos - 2 < H - 1) dir.push(8);
    if (rm(xpos, ypos + 2)?.maze_wall === true && ypos + 2 > 0 && ypos + 2 < H - 1) dir.push(2);
    if (dir.length > 0) {
      const d = dir[rngRange(1, dir.length) - 1];
      if (d === 4) {
        doTile(xpos - 2, ypos, false);
        doTile(xpos - 1, ypos, false);
        xpos -= 2;
      } else if (d === 6) {
        doTile(xpos + 2, ypos, false);
        doTile(xpos + 1, ypos, false);
        xpos += 2;
      } else if (d === 8) {
        doTile(xpos, ypos - 2, false);
        doTile(xpos, ypos - 1, false);
        ypos -= 2;
      } else if (d === 2) {
        doTile(xpos, ypos + 2, false);
        doTile(xpos, ypos + 1, false);
        ypos += 2;
      }
      moves.push([xpos, ypos]);
    } else {
      moves.splice(pickn - 1, 1);
    }
  }
  const ux = 1 * data.widen_w;
  const uy = 1 * data.widen_h;
  const dx = lastx * data.widen_w;
  const dy = lasty * data.widen_h;
  mapCall(ux, uy, resolve(grid.up));
  if (lev < maxLevel || forceLastStair) mapCall(dx, dy, resolve(grid.down));
  return { terrain, ux, uy, dx, dy };
}

describe('Maze:init', () => {
  it('defaults widen to 1 and the maze to as many WHOLE maze cells as the map holds', () => {
    const plain = run('init', { grid: GRID }, { w: 23, h: 17 });
    expect(plain.gen.data).toMatchObject({ widenW: 1, widenH: 1, w: 23, h: 17 });
    // 61 / 2 = 30.5 and 47 / 3 = 15.67: floored, not rounded.
    const wide = run('init', { grid: GRID, widenW: 2, widenH: 3 }, { w: 61, h: 47 });
    expect(wide.gen.data).toMatchObject({ widenW: 2, widenH: 3, w: 30, h: 15 });
    // A zone's own `w`/`h` wins, and the zone's table is not written to.
    const data: MazeData = { grid: GRID, widenW: 2, widenH: 2, w: 10, h: 12 };
    const own = run('init', data, { w: 60, h: 60 });
    expect(own.gen.data).toMatchObject({ w: 10, h: 12 });
    expect(data).toEqual({ grid: GRID, widenW: 2, widenH: 2, w: 10, h: 12 });
  });

  it('refuses a widen that is not a whole number of at least one cell', () => {
    for (const widen of [0, -2, 1.5]) {
      const rng = createRng('widen');
      const map = createGenMap(20, 20, GRID, rng);
      expect(() =>
        createMaze(
          map,
          { grid: GRID, widenW: widen },
          rng,
          { maxLevel: 2 },
          { forceRecreate: null },
        ),
      ).toThrow(RangeError);
      expect(() =>
        createMaze(
          map,
          { grid: GRID, widenH: widen },
          rng,
          { maxLevel: 2 },
          { forceRecreate: null },
        ),
      ).toThrow(RangeError);
    }
  });
});

describe('Maze:generate — against the Lua, draw for draw', () => {
  it('writes the same terrain from the same stream, with every grid key a table', () => {
    const tables = {
      wall: [TileCode.WALL, TileCode.CRAG, TileCode.TREES],
      floor: [TileCode.FLOOR, TileCode.SOOT],
      up: [TileCode.PAVING, TileCode.COBBLE],
      down: [TileCode.YARD, TileCode.GREEN],
    };
    const cases = [
      ...SHAPES.map((s) => ({ ...s, level: 1, maxLevel: 2, force: false })),
      {
        name: 'last level',
        w: 30,
        h: 30,
        widenW: 1,
        widenH: 1,
        level: 2,
        maxLevel: 2,
        force: false,
      },
      {
        name: 'last, forced',
        w: 30,
        h: 30,
        widenW: 2,
        widenH: 2,
        level: 2,
        maxLevel: 2,
        force: true,
      },
    ];
    for (const c of cases) {
      for (let s = 0; s < 4; s += 1) {
        const seed = `lua:${c.name}:${String(s)}`;
        const data: MazeData = {
          grid: tables,
          widenW: c.widenW,
          widenH: c.widenH,
          forceLastStair: c.force,
        };
        const { gen, map, result } = run(seed, data, c);
        const twin = createRng(seed);
        const want = luaMaze(
          twin,
          c.w,
          c.h,
          { widen_w: c.widenW, widen_h: c.widenH },
          tables,
          c.level,
          c.maxLevel,
          c.force,
        );
        expect(Array.from(map.tiles), seed).toEqual(want.terrain);
        expect(result.up, seed).toEqual({ x: want.ux, y: want.uy });
        expect(result.down, seed).toEqual({ x: want.dx, y: want.dy });
        expect(gen.rng.getState().count, seed).toBe(twin.getState().count);
      }
    }
  });

  it('fills first, one resolve per map cell, then rolls pickp, then walks', () => {
    const { rng, labels } = recording('order');
    const grid = { ...GRID, wall: [TileCode.WALL, TileCode.CRAG] };
    const map = createGenMap(21, 16, grid, rng);
    const gen = createMaze(
      map,
      { grid, widenW: 2, widenH: 3 },
      rng,
      { maxLevel: 2 },
      { forceRecreate: null },
    );
    generate(gen, 1, 0);
    // 10 x 5 maze cells of 2 x 3 map cells: the trailing column and row are not filled.
    const fill = 10 * 5 * 2 * 3;
    expect(labels.slice(0, fill).every((l) => l === 'mapgen.resolve.wall')).toBe(true);
    expect(labels[fill]).toBe('mapgen.maze.pickp');
    expect(labels[fill + 1]).toBe('mapgen.maze.pick');
    expect(labels.filter((l) => l === 'mapgen.maze.pickp')).toHaveLength(1);
    // The fill is the only wall resolve: carving never writes a wall.
    expect(labels.filter((l) => l === 'mapgen.resolve.wall')).toHaveLength(fill);
  });

  it('draws a direction only where a pick has a choice: once, along a corridor', () => {
    // A maze one cell tall: every step is east, except that maze cell (3, 1)
    // may also step back WEST into the start, which is still walled when (3, 1)
    // is first picked. That is the only pick with two ways to go, so the only
    // draw; every other `rng.range(1, 1)` draws nothing.
    const { rng, labels } = recording('corridor');
    const map = createGenMap(21, 3, GRID, rng);
    const gen = createMaze(map, { grid: GRID }, rng, { maxLevel: 2 }, { forceRecreate: null });
    generate(gen, 1, 0);
    expect(labels.filter((l) => l === 'mapgen.maze.dir')).toHaveLength(1);
    for (let x = 1; x <= 19; x += 1) expect(open(map, x, 1), String(x)).toBe(true);
  });
});

describe('Maze:generate — the walk', () => {
  it('carves every cell of the step lattice, and nothing outside the maze', () => {
    for (const shape of SHAPES) {
      for (let s = 0; s < 6; s += 1) {
        const seed = `lattice:${shape.name}:${String(s)}`;
        const { map } = run(
          seed,
          { grid: GRID, widenW: shape.widenW, widenH: shape.widenH },
          shape,
        );
        const xs = lattice(shape.w, shape.widenW);
        const ys = lattice(shape.h, shape.widenH);
        for (const i of xs) {
          for (const j of ys) {
            expect(
              carved(map, shape.widenW, shape.widenH, i, j),
              `${seed}: ${String(i)},${String(j)}`,
            ).toBe(true);
          }
        }
        // Maze row and column 0, and every even-even cell, stay wall.
        const cellsW = Math.floor(shape.w / shape.widenW);
        const cellsH = Math.floor(shape.h / shape.widenH);
        for (let i = 0; i < cellsW; i += 1) {
          for (let j = 0; j < cellsH; j += 1) {
            if (i === 0 || j === 0 || (i % 2 === 0 && j % 2 === 0)) {
              expect(
                carved(map, shape.widenW, shape.widenH, i, j),
                `${seed}: ${String(i)},${String(j)}`,
              ).toBe(false);
            }
          }
        }
      }
    }
  });

  it('is a tree over the lattice plus at most ONE loop, and that loop runs through the start', () => {
    // A tree on N lattice cells has N - 1 corridor cells between them. The
    // start is carved late, by a neighbour stepping back into it, and that can
    // open a second corridor into it: never anywhere else.
    let loops = 0;
    let levels = 0;
    for (const shape of SHAPES) {
      for (let s = 0; s < 60; s += 1) {
        const seed = `tree:${shape.name}:${String(s)}`;
        const { map } = run(
          seed,
          { grid: GRID, widenW: shape.widenW, widenH: shape.widenH },
          shape,
        );
        const xs = lattice(shape.w, shape.widenW);
        const ys = lattice(shape.h, shape.widenH);
        const cellsW = Math.floor(shape.w / shape.widenW);
        const cellsH = Math.floor(shape.h / shape.widenH);
        let between = 0;
        for (let i = 0; i < cellsW; i += 1) {
          for (let j = 0; j < cellsH; j += 1) {
            if ((i + j) % 2 === 1 && carved(map, shape.widenW, shape.widenH, i, j)) between += 1;
          }
        }
        const n = xs.length * ys.length;
        expect([n - 1, n], seed).toContain(between);
        levels += 1;
        if (between === n) {
          loops += 1;
          expect(carved(map, shape.widenW, shape.widenH, 2, 1), seed).toBe(true);
          expect(carved(map, shape.widenW, shape.widenH, 1, 2), seed).toBe(true);
        }
      }
    }
    expect(loops, 'no maze closed the loop at its start').toBeGreaterThan(levels / 40);
    expect(loops).toBeLessThan(levels / 2);
  });

  it('has carved the start cell by the end of the walk, the up stair`s cell and its three others', () => {
    for (let s = 0; s < 40; s += 1) {
      const { gen, map } = zoneLevel(`start:${String(s)}`);
      // The up stair stands on (2, 2); the other three map cells of maze cell
      // (1, 1) are only floor if `do_tile(1, 1, false)` ran.
      expect(open(map, 3, 2) && open(map, 2, 3) && open(map, 3, 3)).toBe(true);
      expect(gen.mazeWall[1 * map.w + 1]).toBe(false);
    }
  });

  it('keeps maze_wall in MAZE coordinates, in a room map the size of the MAP', () => {
    const { gen, map } = zoneLevel('room-map');
    expect(gen.mazeWall).toHaveLength(60 * 60);
    for (let i = 0; i < 60; i += 1) {
      for (let j = 0; j < 60; j += 1) {
        const value = gen.mazeWall[j * 60 + i];
        if (i >= 30 || j >= 30) {
          expect(value, `${String(i)},${String(j)} is past the 30x30 maze`).toBeNull();
        } else {
          expect(value, `${String(i)},${String(j)}`).toBe(!carved(map, 2, 2, i, j));
        }
      }
    }
  });

  it('picks newer entries more often as pickp rises: longer ways from stair to stair', () => {
    // `pickp` is the first draw of a level whose keys are plain codes, so a seed
    // can be sorted by it. pickp 1 picks uniformly (short, bushy ways); 4 is all
    // but depth-first (long, winding ones). Measured on 41x41, 200 seeds: the
    // 4-way distance from up to down averaged 79 at pickp 1 (sd 3) and 98 at 4
    // (sd 13).
    const lengths = new Map<number, number[]>([
      [1, []],
      [2, []],
      [3, []],
      [4, []],
    ]);
    for (let s = 0; s < 200; s += 1) {
      const seed = `pickp:${String(s)}`;
      const pickp = createRng(seed).int('pickp', 1, 4);
      const { map, result } = run(seed);
      lengths.get(pickp)?.push(distance(map, result.up, result.down));
    }
    const mean = (p: number): number => {
      const list = lengths.get(p) ?? [];
      expect(list.length, `pickp ${String(p)} never came up`).toBeGreaterThan(20);
      return list.reduce((a, b) => a + b, 0) / list.length;
    };
    expect(mean(4) - mean(1)).toBeGreaterThan(8);
    expect(mean(3) - mean(1)).toBeGreaterThan(5);
    // Manhattan from (1, 1) to (39, 39) is 76; a uniform pick stays near it.
    expect(mean(1)).toBeLessThan(86);
  });
});

/** The 4-way walking distance between two cells, or -1. */
function distance(map: GenMap, from: TileXY, to: TileXY): number {
  const dist = new Int32Array(map.w * map.h).fill(-1);
  const queue = [from.y * map.w + from.x];
  dist[from.y * map.w + from.x] = 0;
  for (let head = 0; head < queue.length; head += 1) {
    const at = queue[head] ?? 0;
    const x = at % map.w;
    const y = (at - x) / map.w;
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const nx = x + dx;
      const ny = y + dy;
      if (!open(map, nx, ny) || dist[ny * map.w + nx] !== -1) continue;
      dist[ny * map.w + nx] = (dist[at] ?? 0) + 1;
      queue.push(ny * map.w + nx);
    }
  }
  return dist[to.y * map.w + to.x] ?? -1;
}

describe('Maze:generate — the bounds are the map`s, the coordinates the maze`s', () => {
  it('at widen 1 keeps the edge: nothing open on the outer ring or past the last odd cell', () => {
    for (const size of [50, 51]) {
      for (let s = 0; s < 5; s += 1) {
        const { map } = run(
          `edge1:${String(size)}:${String(s)}`,
          { grid: GRID },
          { w: size, h: size },
        );
        // 50: the last step target is 47, so 48 and 49 are rock. 51: 49 is a
        // target and 50 the ring.
        const last = size === 50 ? 47 : 49;
        for (let k = 0; k < size; k += 1) {
          for (const edge of [0, last + 1, size - 1]) {
            expect(open(map, edge, k), `x ${String(edge)}, y ${String(k)}`).toBe(false);
            expect(open(map, k, edge), `x ${String(k)}, y ${String(edge)}`).toBe(false);
          }
        }
        expect(open(map, last, last)).toBe(true);
      }
    }
  });

  it('at widen 2 on the Maze zone`s 60x60, runs out onto the east and south edge of the map', () => {
    for (let s = 0; s < 10; s += 1) {
      const { map } = zoneLevel(`edge2:${String(s)}`);
      let east = 0;
      let south = 0;
      for (let k = 0; k < 60; k += 1) {
        if (open(map, 59, k)) east += 1;
        if (open(map, k, 59)) south += 1;
        // West and north: maze cell 0, two map cells of wall.
        for (const edge of [0, 1]) {
          expect(open(map, edge, k)).toBe(false);
          expect(open(map, k, edge)).toBe(false);
        }
      }
      // Every odd maze row of the last maze column, at least: 15 cells of 2.
      expect(east).toBeGreaterThanOrEqual(30);
      expect(south).toBeGreaterThanOrEqual(30);
    }
  });

  it('at widen 2 on a 62-wide map, stops a maze cell short: the 31st cell has an even index', () => {
    for (let s = 0; s < 5; s += 1) {
      const { map } = run(
        `edge62:${String(s)}`,
        { grid: GRID, widenW: 2, widenH: 2 },
        { w: 62, h: 62 },
      );
      for (let k = 0; k < 62; k += 1) {
        for (const edge of [60, 61]) {
          expect(open(map, edge, k)).toBe(false);
          expect(open(map, k, edge)).toBe(false);
        }
      }
      expect(open(map, 59, 59)).toBe(true);
    }
  });

  it('leaves the columns and rows past the last whole maze cell as nil terrain, shipped as the wall', () => {
    // 61x63 at widen 2: 30x31 maze cells, so map column 60 and row 62 are never written.
    const grid = {
      floor: TileCode.SOOT,
      wall: TileCode.CRAG,
      up: TileCode.SOOT,
      down: TileCode.SOOT,
    };
    const { map, result } = run('trailing', { grid, widenW: 2, widenH: 2 }, { w: 61, h: 63 });
    for (let y = 0; y < 63; y += 1) {
      expect(map.tiles[y * 61 + 60], `x 60, y ${String(y)}`).toBe(NIL_TERRAIN);
      if (y < 62) expect(map.tiles[y * 61 + 59], `x 59, y ${String(y)}`).not.toBe(NIL_TERRAIN);
    }
    for (let x = 0; x < 61; x += 1) {
      expect(map.tiles[62 * 61 + x], `x ${String(x)}, y 62`).toBe(NIL_TERRAIN);
      if (x < 60) expect(map.tiles[61 * 61 + x], `x ${String(x)}, y 61`).not.toBe(NIL_TERRAIN);
    }
    // `toAuthoredMap`: nil is the `wall` key's code, or `'#'`'s where there is one.
    const shipped = toAuthoredMap(map, result.up, result.down, grid).view.tiles;
    expect(shipped[5 * 61 + 60]).toBe(TileCode.CRAG);
    expect(shipped.includes(NIL_TERRAIN)).toBe(false);
    const hashed = toAuthoredMap(map, result.up, result.down, { ...grid, '#': TileCode.TREES });
    expect(hashed.view.tiles[62 * 61 + 7]).toBe(TileCode.TREES);
  });

  it('keeps a zone`s own maze size, and raises where upstream would index past the room map', () => {
    const { map, result } = run(
      'own-size',
      { grid: GRID, widenW: 2, widenH: 2, w: 10, h: 8 },
      { w: 60, h: 60 },
    );
    for (let x = 0; x < 60; x += 1) {
      for (let y = 0; y < 60; y += 1) {
        const inside = x < 20 && y < 16;
        expect(map.tiles[y * 60 + x] !== NIL_TERRAIN, `${String(x)},${String(y)}`).toBe(inside);
      }
    }
    expect(result.down).toEqual({ x: 18, y: 14 });
    expect(() => run('too-wide', { grid: GRID, w: 25 }, { w: 20, h: 20 })).toThrow(RangeError);
  });
});

describe('Maze:generate — the stairs', () => {
  const STAIRS: GridKeys = { ...GRID, up: TileCode.PAVING, down: TileCode.YARD };

  it('stands up on the first map cell of maze cell (1, 1), down on the far corner of the lattice', () => {
    for (const shape of SHAPES) {
      for (let s = 0; s < 10; s += 1) {
        const seed = `stairs:${shape.name}:${String(s)}`;
        const { map, result } = run(
          seed,
          { grid: STAIRS, widenW: shape.widenW, widenH: shape.widenH },
          shape,
        );
        const up = { x: shape.widenW, y: shape.widenH };
        const xs = lattice(shape.w, shape.widenW);
        const ys = lattice(shape.h, shape.widenH);
        const down = {
          x: (xs[xs.length - 1] ?? 0) * shape.widenW,
          y: (ys[ys.length - 1] ?? 0) * shape.widenH,
        };
        expect(result.up, seed).toEqual(up);
        expect(result.down, seed).toEqual(down);
        expect(map.get(up.x, up.y)).toBe(TileCode.PAVING);
        expect(map.get(down.x, down.y)).toBe(TileCode.YARD);
        expect(map.cell(up.x, up.y).special).toBe('exit');
        expect(map.cell(down.x, down.y).special).toBe('exit');
        expect(result.spots).toEqual([]);
      }
    }
  });

  it('puts down on (0, 0) when nothing is carved: lastx and lasty start at 0', () => {
    // 4x4 at widen 1: (1, 1) is the only lattice cell, so the first pick has
    // nowhere to go and the walk ends having carved nothing.
    const { map, result } = run('nothing', { grid: STAIRS }, { w: 4, h: 4 });
    expect(result.up).toEqual({ x: 1, y: 1 });
    expect(result.down).toEqual({ x: 0, y: 0 });
    expect(map.get(0, 0)).toBe(TileCode.YARD);
    expect(map.get(1, 1)).toBe(TileCode.PAVING);
    expect(Array.from(map.tiles).filter((c) => c === TileCode.WALL)).toHaveLength(14);
  });

  it('places down only above the zone`s last level unless forced, and returns it either way', () => {
    const last = run('last', { grid: STAIRS }, { level: 2, maxLevel: 2 });
    expect(last.result.down).toEqual({ x: 39, y: 39 });
    expect(last.map.get(39, 39)).toBe(TileCode.FLOOR);
    expect(last.map.cell(39, 39).special).toBeNull();
    const above = run('last', { grid: STAIRS }, { level: 1, maxLevel: 2 });
    expect(above.map.get(39, 39)).toBe(TileCode.YARD);
    const forced = run('last', { grid: STAIRS, forceLastStair: true }, { level: 2, maxLevel: 2 });
    expect(forced.map.get(39, 39)).toBe(TileCode.YARD);
    expect(forced.map.cell(39, 39).special).toBe('exit');
  });

  it('marks a stair`s cell `exit` and leaves its terrain when the zone has no stair key', () => {
    const bare = { floor: TileCode.SOOT, wall: TileCode.CRAG };
    const { map, result } = run('bare', { grid: bare });
    expect(map.get(result.up.x, result.up.y)).toBe(TileCode.SOOT);
    expect(map.get(result.down.x, result.down.y)).toBe(TileCode.SOOT);
    expect(map.cell(result.up.x, result.up.y).special).toBe('exit');
    expect(map.cell(result.down.x, result.down.y).special).toBe('exit');
  });
});

describe('the Maze zone`s table', () => {
  it('pins `data/zones/maze/zone.lua:133-189`', () => {
    expect(MAZE_THE_MAZE).toEqual({
      width: 60,
      height: 60,
      map: {
        class: 'Maze',
        widenW: 2,
        widenH: 2,
        forceLastStair: true,
        grid: {
          floor: TileCode.FLOOR,
          wall: TileCode.WALL,
          up: TileCode.FLOOR,
          down: TileCode.FLOOR,
        },
      },
    });
  });

  it('is deterministic: one seed, one maze; different seeds, different mazes', () => {
    const a = zoneLevel('same');
    const b = zoneLevel('same');
    expect(Array.from(a.map.tiles)).toEqual(Array.from(b.map.tiles));
    expect(a.result).toEqual(b.result);
    const layouts = new Set<string>();
    for (let s = 0; s < 10; s += 1)
      layouts.add(Array.from(zoneLevel(`other:${String(s)}`).map.tiles).join(''));
    expect(layouts.size).toBe(10);
  });

  it('joins up to down on every seed, and every open cell to the up stair', () => {
    for (let s = 0; s < 40; s += 1) {
      const seed = `zone:${String(s)}`;
      const { map, result } = zoneLevel(seed);
      expect(result.up, seed).not.toEqual(result.down);
      expect(open(map, result.up.x, result.up.y), seed).toBe(true);
      expect(open(map, result.down.x, result.down.y), seed).toBe(true);
      expect(reachable(map, result.up, result.down), seed).toBe(true);
      // Nothing is sealed off: the maze is one region.
      const seen = reachableSet(map, result.up);
      for (let i = 0; i < map.w * map.h; i += 1) {
        const code = map.tiles[i] ?? NIL_TERRAIN;
        if (code !== NIL_TERRAIN && isWalkable(code))
          expect(seen[i], `${seed}: cell ${String(i)}`).toBe(1);
      }
    }
  });
});
