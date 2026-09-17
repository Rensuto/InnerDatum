// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/engines/default/engine/generator/map/Maze.lua:27-112
//   and game/modules/tome/data/zones/maze/zone.lua:133-189 (MAZE_THE_MAZE)
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * MAZE: A GROWING TREE OF CORRIDORS, CUT IN BLOCKS OF `widen` CELLS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `engine.generator.map.Maze` is ToME's Maze zone, the first level of the
 * Dreams, and one of the Infinite Dungeon's layouts. The whole algorithm:
 *
 *   1. the map is cut into maze cells of `widen_w` by `widen_h` map cells, and
 *      every maze cell is walled, one `resolve('wall')` per map cell
 *   2. `pickp` is rolled once, 1 to 4
 *   3. a growing tree from maze cell (1, 1): pick an entry of `moves` —
 *      `pickp` 1 picks uniformly, higher favours the newest — and step two
 *      maze cells in a random direction whose target is still walled,
 *      carving the target and the cell between; a pick with nowhere to go
 *      leaves the list
 *   4. the up stair at the top-left map cell of maze cell (1, 1), the down
 *      stair at the top-left map cell of (`lastx`, `lasty`)
 *
 * No rooms, no doors, no spots, no light: a maze is as dark as its zone.
 *
 * ═══ THE MAZE IS CONNECTED, BY CONSTRUCTION, AND HAS AT MOST ONE LOOP ═══
 * Every carve joins a walled maze cell to one already reached, and the cells
 * a step may target — odd x and odd y, inside the bounds below — form a
 * rectangle the tree covers completely. So both stairs stand in one region,
 * and `Zone:newLevel`'s check (`mapgen/level.ts`) never refuses a maze.
 *
 * THE START CELL IS NOT MARKED CARVED when the walk begins
 * (`engine/generator/map/Maze.lua:55-57`), so it is carved LATER, by whichever
 * of its two neighbours steps back into it first. The first child would, since
 * it stays in `moves` until it has nowhere left to go and (1, 1) is somewhere;
 * when it does, the step re-cuts the corridor it came along and nothing
 * changes. When the OTHER neighbour, reached the long way round the maze, gets
 * there first, a second corridor opens into (1, 1): the maze's one possible
 * loop. `MAZE_THE_MAZE` has the numbers.
 *
 * ═══ `maze_wall` IS IN MAZE COORDINATES; THE BOUNDS ARE THE MAP'S ═══
 * `do_tile` writes `room_map[i][j].maze_wall` at the MAZE cell's (i, j), in
 * a room map the size of the MAP (`engine/generator/map/Maze.lua:44`), and a
 * step is allowed when the target's `maze_wall` is true and `0 < x+2 < map.w-1`
 * (`:64-75`) — map width, maze coordinate. Two consequences, both kept:
 *
 * - At `widen` 1 the bound is the real edge: the outermost ring stays wall.
 * - At `widen` 2 or more the bound never binds; what stops a step is
 *   `maze_wall` being nil past the maze's last cell. So the last maze column
 *   is carved whenever its index is odd, and THE MAZE RUNS OUT TO ITS OWN
 *   EAST AND SOUTH EDGE — the map's edge, when the map is a multiple of
 *   `widen`. The Maze zone's 60x60 at `widen` 2 has thirty maze cells a side,
 *   the last one index 29, map columns 58 and 59: its east and south edges
 *   are corridor, its west and north edges two cells of wall. A 62-wide map
 *   has 31, the last index 30, and keeps a wall there.
 *
 * ═══ A MAP THAT IS NOT A MULTIPLE OF `widen` KEEPS NIL TERRAIN ═══
 * `data.w` is `floor(map.w / widen_w)` (`engine/generator/map/Maze.lua:32-33`),
 * and `do_tile` writes only whole maze cells, so the last `map.w % widen_w`
 * columns (and rows) are never written. Upstream leaves them nil, which its
 * `checkEntity` calls open ground; only the Infinite Dungeon rounds its size to
 * a multiple first (`data/zones/infinite-dungeon/zone.lua:228-231`). Here they
 * stay `NIL_TERRAIN` in the `GenMap`, and `toAuthoredMap` (`mapgen/level.ts`)
 * ships nil as the wall key's code — `'#'` if the zone has one, else `wall`,
 * its first code if that is a table — so the strip is solid wall in the game.
 * `mapgen/connectivity.ts` treats nil as blocking where upstream's A* walks
 * through it, and here that changes no verdict: the maze joins its stairs
 * without them.
 *
 * ═══ `init` WRITES INTO THE ZONE'S TABLE UPSTREAM, AND NOT HERE ═══
 * `Maze:init` assigns `widen_w`, `widen_h`, `w` and `h` into the zone's own
 * `generator.map` table (`engine/generator/map/Maze.lua:30-33`), which
 * `Zone:newLevel` passes unchanged to every retry. The values depend only on
 * the table and the map size, which a retry repeats, so writing them into a
 * copy per attempt (`MazeGen.data`) is the same level.
 */

import type { TileXY } from '../coords.ts';
import { TileCode } from '../protocol.ts';
import type { Rng } from '../rng.ts';
import type { GenMap, GridKeys, Spot } from './genmap.ts';
import type { LevelSpec, MazeMapSpec } from './level.ts';
import { range, truthy } from './lua.ts';

/**
 * A zone's `generator.map` table for Maze, field for field. Absent values take
 * the defaults `Maze:init` writes (`engine/generator/map/Maze.lua:30-33`).
 */
export type MazeData = {
  /** Map columns per maze cell. Default 1. */
  readonly widenW?: number;
  /** Map rows per maze cell. Default 1. */
  readonly widenH?: number;
  /** Maze cells across. Default `floor(map.w / widen_w)`. No ToME zone sets it. */
  readonly w?: number;
  /** Maze cells down. Default `floor(map.h / widen_h)`. No ToME zone sets it. */
  readonly h?: number;
  /** Place the down stair on the zone's last level too. */
  readonly forceLastStair?: boolean;
  /** `wall`, `floor`, `up`, `down` — the only keys Maze resolves. */
  readonly grid: GridKeys;
};

/** `MazeData` once `Maze:init` has written its defaults. */
export type MazeSettings = MazeData & {
  readonly widenW: number;
  readonly widenH: number;
  readonly w: number;
  readonly h: number;
};

/** The generator instance: `Generator.init`'s fields and Maze's data. */
export type MazeGen = {
  readonly map: GenMap;
  readonly rng: Rng;
  readonly data: MazeSettings;
  readonly zone: { readonly maxLevel: number };
  /** `level.force_recreate`. Maze never sets it; kept for the calling convention. */
  readonly level: { forceRecreate: string | null };
  /**
   * `room_map[i][j].maze_wall`, row-major over the MAP's size and indexed by
   * MAZE coordinates, as upstream stores it (see the file note). `null` is
   * nil: a room-map cell `do_tile` never wrote. Nothing but this generator
   * reads it, so it lives here rather than on `GenMap.cells`.
   */
  readonly mazeWall: (boolean | null)[];
};

/** What `generate` returns: upstream's `ux, uy, dx, dy`, and no spots. */
export type MazeResult = {
  readonly up: TileXY;
  /** Returned whether or not a down stair was placed, as upstream's `dx, dy` are. */
  readonly down: TileXY;
  readonly spots: readonly Spot[];
};

/**
 * `Maze:init(zone, map, level, data)` (`engine/generator/map/Maze.lua:27-35`):
 * the widths default to 1 and the maze's size to as many whole maze cells as
 * the map holds.
 *
 * THROWS for a `widen` that is not a whole number of at least 1. Upstream's
 * `floor(map.w / 0)` is infinite and the fill runs off the room map on its
 * first column past the edge — a crash mid-generation, refused here up front.
 */
export function createMaze(
  map: GenMap,
  data: MazeData,
  rng: Rng,
  zone: { readonly maxLevel: number },
  level: { forceRecreate: string | null },
): MazeGen {
  const widenW = data.widenW ?? 1;
  const widenH = data.widenH ?? 1;
  if (!Number.isInteger(widenW) || !Number.isInteger(widenH) || widenW < 1 || widenH < 1) {
    throw new RangeError(
      `Maze: widen ${String(widenW)}x${String(widenH)} is not a whole number of cells`,
    );
  }
  const settings: MazeSettings = {
    ...data,
    widenW,
    widenH,
    w: data.w ?? Math.floor(map.w / widenW),
    h: data.h ?? Math.floor(map.h / widenH),
  };
  const mazeWall: (boolean | null)[] = new Array<boolean | null>(map.w * map.h).fill(null);
  return { map, rng, data: settings, zone, level, mazeWall };
}

/**
 * `Maze:generate(lev, old_lev)` (`engine/generator/map/Maze.lua:37-112`).
 *
 * ═══ THE DRAWS, IN ORDER ═══
 * 1. The fill: maze cell by maze cell, x outer and y inner, and inside each
 *    the map cells `ii` outer and `jj` inner, one `resolve('wall')` apiece —
 *    which draws only when `wall` is a table.
 * 2. `pickp = rng.range(1, 4)`.
 * 3. Per turn of the walk: `rng.range(1, 100000)` for the pick; then, if the
 *    pick has somewhere to go, `rng.range(1, #dir)` — NO draw when there is
 *    one direction (`mapgen/lua.ts`) — and `widen_w * widen_h` resolves of
 *    `floor` for the target, the same again for the cell between.
 * 4. `resolve('up')`, then `resolve('down')` if the down stair is placed.
 *
 * ═══ THE PICK ═══
 * `pickn = #moves - floor((rng.range(1,100000)/100001)^pickp * #moves)`
 * (`engine/generator/map/Maze.lua:59`). The fraction is in (0, 1), so `pickn`
 * is 1..#moves, and raising it to a higher power pulls it toward 0 and the
 * pick toward the NEWEST entry: of `n` entries, one of the newest `k` with
 * chance `(k/n)^(1/pickp)`. `pickp` 1 is a uniform pick, a maze of short dead
 * ends. At 4 the newest alone is picked with chance `n^(-1/4)` — 37% of the
 * picks on the Maze zone's 60x60, where the list averages 72 long — and one of
 * the newest tenth more than half the time: longer corridors, not a
 * depth-first walk. The arithmetic is in double, as LuaJIT's is.
 *
 * ═══ `lastx` AND `lasty` ARE SEPARATE MAXIMA ═══
 * Each is the largest index any carved maze cell had on its own axis
 * (`engine/generator/map/Maze.lua:45-48`), not the coordinates of one cell.
 * Kept as written, though on this walk the two maxima always name one carved
 * cell, the far corner of the step lattice: the walk covers that rectangle, a
 * cell between two steps is never past the step it leads to, and the corner is
 * both maxima at once. So the down stair is always on that corner — and when
 * nothing is carved at all, on (0, 0). The tests pin both.
 */
export function generate(gen: MazeGen, lev: number, _oldLev: number): MazeResult {
  const { map, rng, data, mazeWall } = gen;
  const { widenW, widenH } = data;
  let lastx = 0;
  let lasty = 0;

  /** `do_tile(i, j, wall)` (`engine/generator/map/Maze.lua:40-49`). */
  const doTile = (i: number, j: number, wall: boolean): void => {
    for (let ii = 0; ii <= widenW - 1; ii += 1) {
      for (let jj = 0; jj <= widenH - 1; jj += 1) {
        map.set(i * widenW + ii, j * widenH + jj, map.resolve(wall ? 'wall' : 'floor'));
      }
    }
    // GUARD: past the room map upstream indexes nil and raises. Only a zone's
    // own `w` or `h` larger than the map can get here.
    if (!map.isBound(i, j)) {
      throw new RangeError(
        `Maze: room_map[${String(i)}][${String(j)}] is outside ${String(map.w)}x${String(map.h)}`,
      );
    }
    mazeWall[j * map.w + i] = wall;
    if (!wall) {
      lastx = Math.max(lastx, i);
      lasty = Math.max(lasty, j);
    }
  };

  /** `room_map[x] and room_map[x][y] and room_map[x][y].maze_wall`: nil off the map. */
  const walled = (x: number, y: number): boolean =>
    map.isBound(x, y) && truthy(mazeWall[y * map.w + x] ?? null);

  for (let i = 0; i <= data.w - 1; i += 1) {
    for (let j = 0; j <= data.h - 1; j += 1) {
      doTile(i, j, true);
    }
  }

  // Maze cell (1, 1), and NOT carved — see the file note.
  const moves: [number, number][] = [[1, 1]];
  const pickp = range(rng, 'mapgen.maze.pickp', 1, 4);
  while (moves.length > 0) {
    const n = moves.length;
    const roll = range(rng, 'mapgen.maze.pick', 1, 100000);
    const pickn = n - Math.floor((roll / 100001) ** pickp * n);
    const pick = moves[pickn - 1] as [number, number];
    let xpos = pick[0];
    let ypos = pick[1];

    // East, west, north, south: this order is the order `dir[...]` indexes.
    const dir: number[] = [];
    if (walled(xpos + 2, ypos) && xpos + 2 > 0 && xpos + 2 < map.w - 1) dir.push(6);
    if (walled(xpos - 2, ypos) && xpos - 2 > 0 && xpos - 2 < map.w - 1) dir.push(4);
    if (walled(xpos, ypos - 2) && ypos - 2 > 0 && ypos - 2 < map.h - 1) dir.push(8);
    if (walled(xpos, ypos + 2) && ypos + 2 > 0 && ypos + 2 < map.h - 1) dir.push(2);

    if (dir.length > 0) {
      const d = dir[range(rng, 'mapgen.maze.dir', 1, dir.length) - 1];
      // The target first, then the cell between.
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
      // `table.remove(moves, pickn)`: the pick leaves, wherever it stood.
      moves.splice(pickn - 1, 1);
    }
  }

  // "Always starts at 1, 1" (`engine/generator/map/Maze.lua:101-103`).
  const up = { x: 1 * widenW, y: 1 * widenH };
  const down = { x: lastx * widenW, y: lasty * widenH };
  map.set(up.x, up.y, map.resolve('up'));
  map.cell(up.x, up.y).special = 'exit';
  if (lev < gen.zone.maxLevel || data.forceLastStair === true) {
    map.set(down.x, down.y, map.resolve('down'));
    map.cell(down.x, down.y).special = 'exit';
  }
  // Four return values: `spots` is nil, and `Zone:newLevel` reads `{}`
  // (`engine/Zone.lua:1063`).
  return { up, down, spots: [] };
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE MAZE, DEFAULT LAYOUT — the Minotaur's corridors
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `data/zones/maze/zone.lua:133-189`: 60x60, NOT lit (`all_lited` is commented
 * out, `:144`), and `engine.generator.map.Maze` at `widen_w = widen_h = 2` —
 * corridors two cells wide between walls two cells thick — with `OLD_WALL`,
 * `OLD_FLOOR` and the stairs (`:149-157`). `max_level` is 2; the second level
 * is 20x20 with a quick exit (`:180-188`), and levels under 30x30 are not
 * ported, so this is the table every floor uses. The COLLAPSED layout
 * (`:21-131`) is a different zone table and not ported.
 *
 * THE GRIDS: `floor` and `wall` are the default codes, and the stairs are the
 * floor a stair marker stands on, as for the orc breeding pits.
 *
 * ONE CHANGE, ABOUT WHERE THIS RUNS: `forceLastStair`. Upstream's `max_level`
 * decides which floor has no way down; here the realm decides, so the
 * generator always places one (as `ROOMER_RUINS_KOR_PUL` does).
 *
 * ═══ MEASURED ═══
 * 5,000 levels: every up stair reached its down stair, so every level would
 * certify on its first attempt (the maze is connected by construction).
 * `generate` took 0.25 ms a level, p95 0.29 ms; with the reachability check
 * and `toAuthoredMap`, 0.47 ms. The loop through the start formed on 250 of
 * 2,000.
 */
export const MAZE_THE_MAZE: LevelSpec<MazeMapSpec> = {
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
};
