/**
 * The M1 test level: one hand-authored 30x30 map, plus the two lookups every
 * consumer of a level needs.
 *
 * WHY HAND-AUTHORED. M1's job is to prove that two people move tokens on the
 * same map and that walls stop them. A generator would put a second unproven
 * system (and its seed plumbing) underneath the thing being proven, and a
 * collision bug would then be indistinguishable from a generation bug. Real
 * procedural floors arrive in M4 and will take an `Rng` from src/shared/rng.ts;
 * `makeTestLevel` takes no parameters because a fixed map has nothing to vary.
 *
 * WHY IT LIVES IN src/shared/. The server owns the authoritative level and the
 * client renders it, but both must agree on what "walkable" means, and this is
 * also the fixture every movement test builds on. It is pure: the ASCII below is
 * the entire input.
 *
 * ART SEAM: tiles are `TileCode` values, not sprite ids. M1's renderer paints
 * FLOOR and WALL as flat 32px palette cells; swapping in the atlas is a change
 * in the renderer's code -> cell mapping and touches nothing here.
 */

import { inBounds, tileIndex } from './coords.ts';
import { TileCode, isWalkable } from './protocol.ts';
import type { TileXY } from './coords.ts';
import type { LevelView } from './protocol.ts';

const WALL_CHAR = '#';
const SPAWN_CHAR = '@';

/**
 * The map. `#` wall, `.` floor, `@` a spawn tile (floor that also records a
 * start position, so a spawn point can never be authored inside a wall).
 *
 * Laid out to exercise the things M1 claims to have working:
 *   - a solid border, so every edge blocks and no coordinate escapes the grid;
 *   - two solid 4x4 blocks (rows 4-7), the plainest possible collision target;
 *   - a walled room (rows 9-15) with a two-tile doorway, so "walk around the
 *     wall to get in" is a real path rather than a straight line;
 *   - a pillar row (row 20) of single tiles with one-tile gaps, which is where
 *     diagonal movement bugs show up first;
 *   - an L-shaped wall (rows 23-26) for a concave corner.
 * Spawns are a 3x2 cluster near the top-left, so two players see each other on
 * their first frame instead of hunting across a 30x30 field.
 */
const TEST_LEVEL_ROWS: readonly string[] = [
  '##############################',
  '#............................#',
  '#..@@@.......................#',
  '#..@@@.......................#',
  '#....####.......####.........#',
  '#....####.......####.........#',
  '#....####.......####.........#',
  '#....####.......####.........#',
  '#............................#',
  '#.........##########.........#',
  '#.........#........#.........#',
  '#.........#........#.........#',
  '#.........#...##...#.........#',
  '#.........#...##...#.........#',
  '#.........#........#.........#',
  '#.........####..####.........#',
  '#............................#',
  '#............................#',
  '#............................#',
  '#............................#',
  '#....#.#.#.#.#.#.#.#.#.#.....#',
  '#............................#',
  '#............................#',
  '#.....#......................#',
  '#.....#......................#',
  '#.....#......................#',
  '#.....#######................#',
  '#............................#',
  '#............................#',
  '##############################',
];

type ParsedLevel = {
  readonly w: number;
  readonly h: number;
  readonly tiles: readonly number[];
  readonly spawns: readonly TileXY[];
};

/**
 * Parsed once at module load. A ragged row throws HERE — at import, before a
 * socket exists — rather than producing a subtly skewed grid where every tile
 * below the bad row is off by a column.
 */
function parseRows(rows: readonly string[]): ParsedLevel {
  const h = rows.length;
  const w = rows[0]?.length ?? 0;
  if (w === 0 || h === 0) {
    throw new Error('makeTestLevel: the authored map is empty');
  }

  const tiles: number[] = [];
  const spawns: TileXY[] = [];

  for (let y = 0; y < h; y += 1) {
    const row = rows[y];
    if (row === undefined || row.length !== w) {
      throw new Error(`makeTestLevel: row ${y} is ${row?.length ?? 0} wide, expected ${w}`);
    }
    for (let x = 0; x < w; x += 1) {
      // charAt, not [x]: it returns a definite string, so noUncheckedIndexedAccess
      // needs no guard on the hottest line in this file.
      const ch = row.charAt(x);
      if (ch === WALL_CHAR) {
        tiles.push(TileCode.WALL);
      } else {
        tiles.push(TileCode.FLOOR);
        if (ch === SPAWN_CHAR) {
          spawns.push({ x, y });
        }
      }
    }
  }

  return { w, h, tiles, spawns };
}

const TEST_LEVEL = parseRows(TEST_LEVEL_ROWS);

/**
 * Player start tiles, in row-major order, guaranteed floor by construction.
 *
 * The server hands them out in order as people connect and wraps if it runs out
 * (there are six, one per playable class). Exported so nobody hard-codes a
 * coordinate that a later edit to the map turns into a wall.
 */
export const TEST_LEVEL_SPAWNS: readonly TileXY[] = TEST_LEVEL.spawns;

/**
 * A fresh, MUTABLE level view. The tile array is copied on every call: the
 * server owns its level and will eventually dig doors into it, and a shared
 * array would let one session's changes appear in another's.
 */
export function makeTestLevel(): LevelView {
  return { w: TEST_LEVEL.w, h: TEST_LEVEL.h, tiles: TEST_LEVEL.tiles.slice() };
}

/**
 * The tile at (x, y). Out of bounds is WALL, and so is any code this build does
 * not recognise.
 *
 * Fail-closed by design, and it is why nothing downstream ever handles an
 * `undefined` tile: FOV, pathfinding and the neighbour walk all probe off-grid
 * coordinates as a matter of course, and "the edge of the world is solid rock"
 * is both the correct answer and the safe one.
 */
export function tileAt(level: LevelView, x: number, y: number): TileCode {
  if (!inBounds(x, y, level.w, level.h)) return TileCode.WALL;
  const raw = level.tiles[tileIndex(x, y, level.w)];
  return raw === TileCode.FLOOR ? TileCode.FLOOR : TileCode.WALL;
}

/**
 * Terrain-only walkability. Actors are not consulted — whether a body blocks a
 * tile is a rule the server's movement code owns, and baking it in here would
 * put half of that decision in the client bundle.
 */
export function canWalk(level: LevelView, x: number, y: number): boolean {
  return isWalkable(tileAt(level, x, y));
}
