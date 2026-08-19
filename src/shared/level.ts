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
import { TileCode, blocksSight, isWalkable } from './protocol.ts';
import type { TileXY } from './coords.ts';
import type { LevelView } from './protocol.ts';

const WALL_CHAR = '#';
const SPAWN_CHAR = '@';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A PARSED MAP: THE GRID, PLUS THE THINGS THE GRID CANNOT SAY
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `LevelView` is the wire shape and stays exactly what it was — dimensions and
 * a flat tile array. It deliberately carries no spawn list and no site table,
 * because neither is the client's business: spawns are where the SERVER places
 * a body, and a site's destination is a fact a player earns by walking onto it.
 *
 * So the authored-map layer returns both, and only the `view` half crosses the
 * network. That split is why `makeTestLevel()` below still returns a bare
 * `LevelView` and every one of its ~60 existing call sites is untouched.
 */
export type AuthoredMap = {
  readonly view: LevelView;
  /** Where the server places joining bodies, in row-major order. */
  readonly spawns: readonly TileXY[];
  /** Cells that open an inner-world. Keyed by `"x,y"`. */
  readonly sites: ReadonlyMap<string, string>;
};

/** The legend entry for one authored character. */
type Glyph = {
  readonly tile: TileCode;
  /** True if this character also records a spawn point. */
  readonly spawn?: boolean;
  /** The site id this cell opens, if any. */
  readonly site?: string;
};

/**
 * Parse an authored ASCII map against a legend.
 *
 * A RAGGED ROW THROWS HERE — at import, before a socket exists — rather than
 * producing a subtly skewed grid where every tile below the bad row is off by a
 * column. So does an unknown character: a typo in a 3,072-cell map is otherwise
 * a single silent wall in the middle of a district.
 */
function parseMap(rows: readonly string[], legend: Readonly<Record<string, Glyph>>): AuthoredMap {
  const h = rows.length;
  const w = rows[0]?.length ?? 0;
  if (w === 0 || h === 0) {
    throw new Error('parseMap: the authored map is empty');
  }

  const tiles: number[] = [];
  const spawns: TileXY[] = [];
  const sites = new Map<string, string>();

  for (let y = 0; y < h; y += 1) {
    const row = rows[y];
    if (row === undefined || row.length !== w) {
      throw new Error(`parseMap: row ${y} is ${row?.length ?? 0} wide, expected ${w}`);
    }
    for (let x = 0; x < w; x += 1) {
      // charAt, not [x]: it returns a definite string, so noUncheckedIndexedAccess
      // needs no guard on the hottest line in this file.
      const glyph = legend[row.charAt(x)];
      if (glyph === undefined) {
        throw new Error(`parseMap: row ${y} column ${x} is '${row.charAt(x)}', not in the legend`);
      }
      tiles.push(glyph.tile);
      if (glyph.spawn === true) spawns.push({ x, y });
      if (glyph.site !== undefined) sites.set(`${x},${y}`, glyph.site);
    }
  }

  return { view: { w, h, tiles }, spawns, sites };
}

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

/**
 * The M1 legend. Three characters, and the mapping is exactly what `parseRows`
 * hard-coded before there was more than one map: `#` is wall, `@` is a floor
 * that also records a spawn, everything else is floor.
 *
 * "Everything else is floor" is preserved as an explicit entry for `.` plus the
 * two below, rather than as a default, because a default is what let a typo in
 * a 3,072-cell map become one silent floor tile in the middle of a wall.
 */
const M1_LEGEND: Readonly<Record<string, Glyph>> = {
  [WALL_CHAR]: { tile: TileCode.WALL },
  [SPAWN_CHAR]: { tile: TileCode.FLOOR, spawn: true },
  '.': { tile: TileCode.FLOOR },
};

const TEST_LEVEL = parseMap(TEST_LEVEL_ROWS, M1_LEGEND);

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
  return {
    w: TEST_LEVEL.view.w,
    h: TEST_LEVEL.view.h,
    tiles: TEST_LEVEL.view.tiles.slice(),
  };
}

/** The M1 test level as an authored map — the inner-world behind a site. */
export function makeTestMap(): AuthoredMap {
  return { view: makeTestLevel(), spawns: TEST_LEVEL.spawns, sites: TEST_LEVEL.sites };
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
  if (raw === undefined) return TileCode.WALL;
  /**
   * ═════════════════════════════════════════════════════════════════════════
   * THIS USED TO COLLAPSE EVERY NON-ZERO CODE TO `WALL`, AND THAT WAS RIGHT
   * FOR EXACTLY AS LONG AS THERE WERE TWO CODES.
   * ═════════════════════════════════════════════════════════════════════════
   *
   * `return raw === FLOOR ? FLOOR : WALL` is a two-value funnel, and it sits
   * UPSTREAM of everything: the renderer, `canWalk`, the FOV trace, the
   * pathfinder and the client's left-click intent all read the map through it.
   * Send a map made of COBBLE (2) through that line and the whole city comes
   * back as solid rock — unwalkable, unpaintable, and unroutable — with no
   * error anywhere, because collapsing to WALL is the fail-closed answer and
   * fail-closed looks exactly like working when the input is wrong.
   *
   * So: pass a code THIS BUILD KNOWS through unchanged, and collapse only what
   * it genuinely cannot name. `isWalkable`/`blocksSight` in protocol.ts are the
   * authority on what is known, which is what keeps the vocabulary in one file.
   */
  if (isWalkable(raw) || blocksSight(raw) || raw === TileCode.WATER) {
    return raw as TileCode;
  }
  return TileCode.WALL;
}

/**
 * Terrain-only sight blocking, the twin of `canWalk`.
 *
 * SEPARATE FROM WALKABILITY SINCE THE CANAL EXISTED. `hasLineOfSight` used to
 * trace with `canWalk`, which silently asserted that everything solid is also
 * opaque; a canal is solid and transparent, and a bridge is walkable across
 * water you can see over. Out of bounds is WALL, so the edge of the world is
 * opaque as well as solid.
 */
export function blocksSightAt(level: LevelView, x: number, y: number): boolean {
  return blocksSight(tileAt(level, x, y));
}

/**
 * Terrain-only walkability. Actors are not consulted — whether a body blocks a
 * tile is a rule the server's movement code owns, and baking it in here would
 * put half of that decision in the client bundle.
 */
export function canWalk(level: LevelView, x: number, y: number): boolean {
  return isWalkable(tileAt(level, x, y));
}

// ===========================================================================
// THE ALDERBROOK REGION — THE OVERWORLD
// ===========================================================================

/**
 * The country around Alderbrook, 170x100, MODELLED rather than drawn.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE SIZE IS ToME'S, DELIBERATELY
 * ═══════════════════════════════════════════════════════════════════════════
 * `data/zones/wilderness/zone.lua` in the reference clone reads
 * `width = 170, height = 100`, and this is that. 17,000 cells against the
 * camera's 48x32, so the region is roughly four screens across and three down:
 * crossing it is a journey with decisions in it rather than a walk.
 *
 * It grew from 96x64 for one reason — that map was a diagram of a region and
 * this is a region. The generator is unchanged; only its inputs are.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * GENERATED IN THE ORDER THE REAL THING HAPPENS
 * ═══════════════════════════════════════════════════════════════════════════
 * Elevation from a mountain spine plus four octaves of value noise, pulled down
 * toward the south and east so the land ends in a sea. Rivers that begin on the
 * highest ground and walk DOWNHILL to the coast, carving as they go. Moisture
 * as breadth-first distance from fresh water. Then biomes from (elevation,
 * moisture) and nothing hand-placed: forest along the rivers, marsh in the wet
 * hollows, heath where no water reaches, plains the rest. Settlements SCORED
 * rather than sited — flat, low, near water, far apart. Roads by A* over a real
 * cost field, so one hugs a valley and takes a pass rather than a cliff.
 *
 * ═══ TWO THINGS THAT DO NOT SURVIVE A CHANGE OF SCALE, AND BOTH BIT ═══
 * ELEVATION THRESHOLDS ARE PERCENTILES. Absolute cut-offs produced a region
 * 70% highland with nine cells of sea, because after a ridge is added and the
 * field renormalised the distribution is not something you can predict.
 * MOISTURE BANDS ARE FRACTIONS OF THE MAP. They are DISTANCES, so the values
 * tuned at 96x64 put almost every cell in the driest bucket here and heath went
 * from a tenth of the land to two fifths. Both are now expressed against the
 * map's own size, which is what makes 170x100 the same world as 96x64 rather
 * than a differently-broken one.
 *
 * ═══ THE WALKABLE GROUND IS THE MAP, AND THE REST IS WALLS ═══
 * Forest, mountain, crag and water BLOCK MOVEMENT — ToME's own rule
 * (`grids.lua` gives FOREST `does_block_move = true`). The light ground
 * threading between dark masses IS the route.
 *
 * ═══ AUTHORED DATA, NOT A GENERATOR THE GAME RUNS ═══
 * The generator ran once, offline (tools/worldgen.py), and its output is frozen
 * below. A world that reshuffled on restart is a world nobody can learn, and
 * knowing the map is most of what an overworld is for.
 *
 * ═══ VERIFIED ═══
 * 17,000 cells. Flood-filled from Alderbrook with corner-cutting enabled
 * (world.ts:852-856): 13 sites reachable, 0 of 9,114 walkable cells marooned.
 * test/shared/overworld.test.ts re-runs it on every commit.
 */
const ALDERBROOK_ROWS: readonly string[] = [
  'XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
  'XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
  'XXwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwWWWwwwwwWWWWWWWWWWWWWWWWWWWWWWWWWWWWWXX',
  'XXwwwwsswyyyyyyyyyj............yyyyywyyyjjTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTT;jjkkkkyyykkkk...................wwwwwwwwwwyyswwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwWWWWWWWWWWWWWWWXX',
  'XXwwTTTjjtttyyytttj.TTTTTTTTTjjtttyyytttjjhhhhhhhhhhhhhhhhhhhhhhhhhhhTTTTTjjkkkkyyykkkkjjTTTTTTTTTTTTTTTT.TjjtttyyytttjjTTTTTTTTTTTTTTTTTTTTTTTTTTTTwwwwwwwwwwwwwwwwwwWWXX',
  'XXwwThhjjtttyyyttt..ccccccccccctttyyytttccccccccccccccccccccccccccccccccccjjkkkkyyykkkkjjcccchhhhhhhhhhhh.hjjtttyyytttjjTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTT;;;;;;sssswwwWWXX',
  'XXwwThhjjyywyByyyyjccccccccccccyyyyFyywycccccccccccccccccccccccccccccccccccjyyywyGyyyyyccccccchhhhhhhhhhh....yyyySyyyyjjTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTT;;;;ssswwwWWXX',
  'XXwTThhjjywyyyyyyycccccccccccccyyyyyywyycccccccccccccMMMMMMMccccccccccccccccyywyyyyyyyycccccccccccchhhhhhh.jjyyyyyyyyyjjTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTssswwWWXX',
  'XXwTThhjjywyyyyyyycccccccccccccyyyyywyyycccccccccccMMMMMMMMMccccccccccccccccywyyyyyyyyyccccccccccccccchhhh.jjyyyyyyyyyjjTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTT;swwwWWXX',
  'XXwTTcccjwyyyyyyyycccccccccccccyyyyywyyyccccccccccMMMMMMMMMMMcccccccccccccccywyyyyyyyyycccccccccccccccchhh.jjyyyyyyyyyjjTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTT;swwwWWXX',
  'XXTTTccccwccccccccccccccccccccccccc.wccccccccccMMMMMMMMMMMMMMMMcccccccccccccLwLLLyLLLLLccccccccccccccccchh.jjjjjj.jjjjjjTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTsswwWWXX',
  'XXTTTcccccwcccccccccccccccccccccccc.wcccccccccMMMMMMMMMMMMMMMMMMccccccccccccwcccccccccccccccccccccccccccch.jjjjjj.jjjjjjTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTsswwWWXX',
  'XXTTTcccccwcccccccccccccccccccccccc.wcccccccMMMMMMMMMMMMMMMMMMMMMcccccccccccwcccccMMMMMMMcccccMMMMccccccch.hhhhhp.pppppppppppppppppppppppppppppppppppTTTTTTTTTTTTTsswwWWXX',
  'XXTTcccccccwccccccccccccccccccccccc.wccccccMMMMMMMMMMMMMMMMMMMMMMMMcccMMMcccwccccMMMMMMMMMMMMMMMMMMccccccc.hhhhhp..pppppppppppppppppppppppppppppppppppppppppTTTTTT;swwWWXX',
  'XXTTccccccccwccccccccMMMMMMMMMMcccc=cccccMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMccwccMMMMMMMMMMMMMMMMMMMMccccccc.hhhhhpp.pppppppppppppppppppppppppppppppppppppppppTTTTTT;swwWWXX',
  'XXTTccccccccwcccccccMMMMMMMMMMMMMMc.wMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMccwcMMMMMMMMMMMMMMMMMMMMMccccccc.hhhhhpp.pppppppppppppppppppppppppppppppppppjjjjjjjjjjjjjswwWWXX',
  'XXTTcMMMMMccwccccccMMMMMMMMMMMMMMMM.MwMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMcwMMMMMMMMMMMMMMMMMMMMMMccccccc.hhhhhpp.pppppppppppppppppppppppppppppppppppjjjjjjjjjjjjjsswWWXX',
  'XXTTcMMMMMMMwccMMMMMMMMMMMMMMMMMMMM.MMwMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMwMMMMMMMMMMMMMMMMMMMMcccccccc.hhhhhpp.pppppppppppppppppppppppppppppppppppjjyyyyyyyyyjjsswWWXX',
  'XXTTcMMMMMMwMMMMMMMMMMMMMMMMMMMMMMM.MMMwMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMwMMMMMMMMMMMMMMMcccccccccccc.hhhhppp.pppppppppppppppppppppppppppppppppppjjtttyyytttjjsswWWXX',
  'XXTTcMMMMMwMMMMMMMMMMMMMMMMMMMMMMMM.MMMMwMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMwMMMMMMMMMMMMcccccccccccccc.hhhhppp.pppppppppppppppppppppppppppppppppppjjtttyyytttjssswWWXX',
  'XXTTcMMMMwMMMMMMMMMMMMMccccccMMMMMM.MMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMccMMMMMMMMMMMMMMMMMMMMMMcccccccccccccch.hhhhppp.pppppppppppppppppppppppppppppppppppjjyyyyRyyyyjssswWWXX',
  'XXTTcMMMwMMMMMMMMMMMccccccccccccccc.cMMMMMMMMMMMMMMMMMMMMMMMMMMMMccccccccccMMMMMMMMMMMMMMMccccccccccccccch.hhhhppp.pppppppppppppppppppppppppppppppppppjjyyyyyyyyyssswwWWXX',
  'XXTTcMMMMMMMMMMMMcccccccccccccccccc.ccMMMMMMMMMcccccccccccMMMMMMcccccccccccccMMMMMMMMMMMMcccccccccccccccch.hhhhppp.pppppppppppppppppppppppppppppppppppjjyyyyyyyyyssswwWWXX',
  'XXTTcMMMMMMMMMMcccccccccccccccccccc.cccccccccccccccccccccccMMMMccccccccccccccccMMMMMMMMcccccccccccccccccch.hhhhppp.pppppppppppppppppppppppppppppppppppjjyyyyyyyyyswwwwWWXX',
  'XXTTcMMMMMMMMcccccccccccccccccccccc.ccccccccccccccccccccccccMMcccccccccccccccccccMMMcccccccccccccccccccchh.hhhpppp.pppppppppppppppppppppppppppppppppppjjj.jjjjjjsswwwwWWXX',
  'XXTTcMMMMMMMccccccccccccccccccccccc.ccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccchhh.hhhpppp.pppppppppppppppppppppppppppppppppppjjj.jjjjjjsswwwwWWXX',
  'XXTTcMMMMMMcccccccccccccccccccccccc.ccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccchhhhh.hhhpppp..ppppppppppppppppppppppppppppppppppppp.pTTTTTssswwwWWXX',
  'XXTTcMMMMccccccccccccccchhcchhhhccc.ccccccccccccccccccccccccccccccccccchcccccccccccccccccccccccccccchhhhhh.hhpppppp.eeepppppppppppppppppppppppppppppppppp.ppTTTTTsssswWWXX',
  'XXTTcMccccccccccccccccchhhhhhhhhhhh.cccccccccccccccccccccccccccccchhhhhhhhcccccccccccccccccchhccchhhhhhhhh.hheeeeee.eeeeeeeeeeeeeeeeeeeeeeeeepppppppppppp.pppTTTTTssswWWXX',
  'XXTTccccccccccccchhhhhhhhhhhhhhhhhh.hccccccccccccccccccccccccccchhhhhhhhhhccccccccccccccchhhhhhhhhhhhhhhhh.hheeeeee.eeeeeeeeeeeeeeeeeeeeeeeeepppppppppppp.pppTTTTTTsswWWXX',
  'XXTTccccccccccchhhhhhhhhhhhhhhhh..N.hhccccccccccccccccccccccccchhhhhhhhhhhhccccccccccccchhhhhhhhhhhhhhhhhh.hheeeeee.eeeeeeeeeeeeeeeeeeeeeeeeepppppppppppp.pppTTTTTTsswWWXX',
  'XXTTcccccccccchhhhhhhhhhhhhhhhhh.hh.hhhcccccccccch.A.hhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhh.heeeeeee.eeeeeeeeeeeeeeeeeeeeeeeeepppppppppppp.pppTTTTTT;swWWXX',
  'XXTTccccccccchhhhhhhhhhhhhhhhhhh.hh.hhhhhccccch....h.hhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhh..eeeeeeee.eeeeeeeeeeeeeeeeeeeeeeeeepppppppppppp.pppTTTTTT;swWWXX',
  'XXTTcccccchhhhhhhhhhhhhhhhhhhhhh.hh.............hhhh.hhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhh..eeeeeeeee.eeeeeeeeeeeeeeeeeeeeeeeeepppppppppppp.pppTTTTTT;;wWWXX',
  'XXTTccccchhhhhhhhhhhhhhhhhhhhhh..hhhhhhhhhhhhhhhhhhh.hhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhee.eeeeeeeeee.eeeeeeeeeeeeeeeeeeeeeeeeepppppppppppp.pppTTTTTT;;wWWXX',
  'XXTTcccchhhhhhhhhh..............hhhhhhhhhhhhhhhhhhhh...eeeeehhhhhhhhhhhhhhhhhhhhhpppppppeehhhhhhhhhhheee.eeeeeeeeee.eeeeeeeeeeeeeeeeeeeeeeeeepppppppppppp.pppTTTTTss;wWWXX',
  'XXTTccchhhhhhhhhhh.hhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhee.eeeeeeehhhhhhhhhhhhhhhhpppppppppeeeehhhhhhhhhheee.eeeeeeeeee.eeeeeeeeeeeeeeeeeeeeeeeeepppppppppppp.pppTTTTTs;;wWWXX',
  'XXwTTchhhhhhhphhhh.hhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhheee.eeeeeeeehhhhhhhheehhhhpppppppppeeeeeeehhhhhhheee..eeeeeeeeee.eeeeeeeeeeeeeeeeeeeeeeeeepppppppppppp.pppTTTTTT;;wWWXX',
  'XXwTThhhhhhp.......hhhhhhhhhhhhhhhhhhhhhhhhhhpehhheeee.......eeehhhhhhheeephpppppppppeeeeeeeeehhhhheeee.eeeeeeeeeee.eeeeeeeeeeeeeeeeeeeeeeeeepppppppppppp.pppTTTTTT;;wwWXX',
  'XXw;Thhhhhh..ppphhhhhhhhhhhhhhhhhhhhhhhhhhhppeeeeeeeeeeeeeee....hhhhhheeeeepppppppppeeeeeeeeeeehhhe.....eeeeeeeeeee.eeeeeeeeeeeeeeeeeeeeeeeeepppppppppp...pppTTTTTT;;wwWXX',
  'XXw;Thhhhh..pppphhhhhhhhhhhhhhhhhhhhhhhhhpppeeeeeeeeeeeeeeeeeee.....................................eeeeeeeeeeeeeee.eeeeeeeeeeeeeeeeeeeeeeeeepppppppppp.pppppTTTTTT;;wwWXX',
  'XXw;Thhhhh.hppphhhhhhhhhhhhhhhhhhhheeepppppeeeeeeeeeeeeeeeeeeeeeehhhhheeeeeeepppppeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee.eeeeeeeeeeeeeeeeeeeeeeeeepppppppp...pppppTTTTTT;;wwWXX',
  'XXw;Thhhhh.hhhhhhhhhhhhhhhhhhhhhhhheeeepppeeeeeeeeeeeeeeeeeeeeeeeehhhheeeeeeeepppeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeehU......eeeeeeeeeeeeeeeeeeepppppppp.pppppppTTTTTTT;wwWXX',
  'XXw;Thhhhh.hhhhhhhhhhhhhhhhhhhhhhhheeeeepeeeeeeeeeeeeeeeeeeeeeeeehhhheeeeeeeeeepeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeehhhheeee..eeeeeeeeeeeeeeeeeepppppppp.pppppppTTTTTTTTwwWXX',
  'XXw;Thhhh..hhhhhhhhhhhhhhhhhhhhhhhheeeeeeeeeeeeeeeeeeeeeeeeeeeeeehhheeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeehhhhhhheehhe..eeeeeeeeeeeeeeeeepppppppp.pppppppTTTTTTTTwwWXX',
  'XXw;Th....hhhhhhhhhhhhhhhhhhhhhhhheeeeeeeeeeeeeeeeeeeeeeeeeeeeeehhhheeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeehhhhhhhehhhhe.......eeeeeeeeeeeppppp....pppppppTTTTTTTTwwWXX',
  'XXw;Th.hhhhhhhhhhhhhhhhhhhhhhhhhheeeeeeeeeeeeeeeeeeeeeeeeeeeeeehhhhheeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeehhhhhhhhhhhheeeeee.eeeeeeeeeeepppp..ppppppppppTTTTTTTTwwWXX',
  'XXw;Th.hhhhhhhhhhhhhhhhhhhhhhhhheeeeeeeeeeeeeeeeeeeeeeeeeeeeeehhhhhheeeeheeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeehhhhhhhhhhhhheeeee.eeeeeeeeeeeepp..ppppppppppppTTTTTTTwwWXX',
  'XXwsTh.hhhhhhhhhhhhhhhhhhhhhhhhheeeeeeeeeeeeeeeeeeeeeeeeeeeeeehhhhhheeehheeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeehhhhhhhhhhhhheeeee.eeeeeeeeeeeepp.pppppppppppppTTTTTTTwwWXX',
  'XXwsjj.jjjjhhhhhhhhhhhhhhhhhhhhhheeeeeeeeeeeeeeeeeeeeeeeeeeeehhhhhhhheeeheeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeehhhhhhhhhhhhheeeee.eeeeeeeeeeeep..pppppppppppppTTTTTTTwwWXX',
  'XXwyyyyyyyjhhhhhhhhhhhhhhhhhhhhhhheeeeeeeeeeeeeeeeeeeeeeeeeehheeeeeehhheeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeehhhhhhhhhhheeeeeee.eeeeeeeeee....ppppppppppppppTTTTTTTwwWXX',
  'XXwvvyyyvvjhhhhhhhhhhhhhhhhhhhhhhhheeeeeeeeeeeeeeeeeeeeeeeeehheeeeeehhhheeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeehhhhhhhhheeeeeeeee..eeeee.....eppppppppppppppppTTTTTTTwwWXX',
  'XXwyyyPyyy.hhhhhhhhhhhhhhhhhhhhhhhhheeheeeeeeeeeeeeeeeeeeeeehheeeeeehhhhhhhheeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeehhheeeeeeeeeeee.eee...eeeeeppppppppppppppppTTTTTTTwwWXX',
  'XXwyyyyyyy.hhhhhhhhhhhhhhhhhhhhhhhhhhhheeeeeeeeeeeeeeeeeeeehhhhheeeehhhhhhhhheeeehheeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee...e.eeeeeeeppppppppppppppppTTTTTTTwwWXX',
  'XXwwyyyyyy...hhhhhhhhhhhhhhhhhhhhhhhhhheeeeeeeeeeeeeeeeeeehhhhhhheehhhhhhhhhhhehhhhheeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeppeeee.e.eeeeeeeppppppppppppppppTTTTTTTwwWXX',
  'XXwwjjjjjjjh.hhhhhhhhhhhhhhhhhhhhhhhhhhheeeeeeeeeeeeeeehhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhheeeeeeeeeeeehhheeeeeeeeeeeeeeeeeeeeeeeppppe..D..eeeeeeeppppppppppppppppTTTTTTTwwWXX',
  'XXwwTTTThhhh.hhhhppphhhhhhhhhhhhhhhhhhhhhheeeeeeeeeeeehhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhheeeeeeeeeeehhhhheeeeeeeeeeeeeeeeeeeeeppppp..eeeeeeeeeeeppppppppppppppppTTTTTTTwwWXX',
  'XXwwTTTThhhh.hhhhppphhhhhhhhhhhhhhhhhhhheeeeeeeeeeeeehhhhhhKhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhheeeeeeeeeeeeeeeeeeeepppppp.peeeeeeeeeeeppppppppppppppppTTTTTTTwwWXX',
  'XXwwTTTTThhh.hhhhpppphhhhhhhheeehhhhhhheeeeeeeeeeeeeehhhhhheehhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhheeeeeeeeeeeeeeeeeeepppppp..pppeeeeeeeeppppppppppppppppTTTTTTTTwwWXX',
  'XXwwTTTTTThh.hhhppppphhhhhhheeeeehhhhhheeeeeeeeeeeeeehhhheeeeehhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhheeeeeeeeeeeeeeeeeeppppppp.pppppeeeeeeeppppppppppppppppTTTTTTTTwwWXX',
  'XXWwTTTTTTTT.hhhppppppEhhhhpeeeeehhhhheeeeeeeeeeeeeeehhhheeeeehhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhheeeeeeeeeeeeeeeeepppppppp.ppppppeeeeeeppppppppppppppppTTTTTT;;wwWXX',
  'XXWwTTTTTTTT..ppppppppppppppeeeeeehhhhppeeeeeeeeeeeeehhhheeeeehhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhheeeeeeeeeeeeeeeeppppppppp.pppppppeeeeeppppppppppppppppTTTTTT;;wwWXX',
  'XXWwTTTTTTTTp.ppppppppppppppeeeeepphhhppppeeeeeeeeeeeehhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhheeeeeeeeeeeeeeepppppppppp.ppppppppeeeeppppppppppppppppTTTTTT;;wwWXX',
  'XXWwTTTTTTTTp..pppppppppppppeeppppphhhppppppeeeeeeehhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhepppeeepeeeeeeppppppppppp.pppppppppeeeppppppppppppppppTTTTTT;;wwWXX',
  'XXWwTTTTTTTTpp.pppppppppppppeppppppphpppppppppeeephhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhphhhhhhhhhhhhhhhhhhpppppppppeeeepppppppppppp.ppppppppppeeppppppppppppppppTTTTTT;;wWWXX',
  'XXWwTTTTTTTTpp..pppppppppppppppppppppppppppppppppphhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhppphhhhhhhhhhhhhhhhhppppppppppeeppppppppppppp.pppppppppppeppppppppppppppppTTTTTT;;wWWXX',
  'XXWwTTTTTTTTppp...pppppppppppppppppppppppppppppppphhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhppphhhhhhhhhhhhhhhhhhpppppppppppppppppppppppp.ppppppppppppppppppppppppppppTTTTTT;;wWWXX',
  'XXWwTTTTTTTTppppp.pppppppppppppppppppppppppppppppphhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhppppphhhhhhhhhhhhhhhhhpppppppppppjjjjjjjjjjjj..jppppppppppppppppppppppppppTTTTTT;;swWWXX',
  'XXWwTTTTTTTTppppp.....ppppjjjjjjjjjjjjjjjpppppppppphhhhhhhhhhhhhhhphhhhhhhhhhhhhhppppppphhhhhhhhhhhhhhhppppppppppppjjjjjjjjj....jjpppppppppppppppppppppppppTTTTTTsswwwWWXX',
  'XXWwTTTTTTTTppppppppp..pppjjjjjjjjjjjjjjjpppppppppppphhhhhhhhhhhhpppphhhhhpphhhhppppppppppphhhhhhhhhhhhppppppppppppjjyyyyyyyyyyy.....pppppppppppppppppppppTTTTTT;swwwwWWXX',
  'XXWwTTTTTTTTpppppppppp......yyyyyyyyyyyjjppppppppppppphhhhhhhhhhhpppppphhpppphhppppppppppppppphhhhhhhhpppppppppppppjjkkkkyyykkkkjjpp..........pppppppppppTTTTTT;swwwwwWWXX',
  'XXWwTTTTTTTTppppppppppppppjjkkkkyyykkkkjjppppppppppppphhhhhhhhhppppppppppppppppppppppppppppppphhhhhhhhpppppppppppppjjkkkkyyykkkkjjppppppppppp.ppppppppppTTTTTT;swwwwwwWWXX',
  'XXWwTTTTTTTTppppppppppppppjjkkkkyyykkkkjjppppppppppppphhhhhhhhhpppppppppppppppppppppppppppppppphhhhhhppppppppppppppjjkkkkoookkkkjjppppppppppp.pppppppppTTTTTT;swwwwwwwWWXX',
  'XXWwTTTTTTTTppppppppppppppjjkkkkyyykkkkjjpppppppppppppppppphhhpppppppppppppppppppppppppppppppppphhpppppppppppppppppjjyyyooOooyyyjjTpppppppppp.......jjjjjjjjT;swwwwwwwWWXX',
  'XXWwTTTTTTTTppppppppppppppjjyyyyyIyyyyyjjppppppppppppppppppphppppppppppppppppppppppppppppppppppppppppppppppppppppppjjyyyyoooyyyyjjTTTppppppppppjjjj.jjjjjjjjTsswwwwwwwWWXX',
  'XXWwTTTTTTTTppppppppppppppjjyyyyyyyyyyyjjppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppjjyyyyyyyyyyyjjTTTTpppppppppjjyyyyyyyyyjjTsswwwwwwwWWXX',
  'XXWwTTTTTTTTppppppppppppppjjyyyyyyyyyyyjjppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppjjyyyyyyyyyyyjjTTTTTppppppppjjtttyyytttjjssswwwwwwwWWXX',
  'XXWwTTTTTTTTppppppppppppppjjyyyyyyyyyyyjjppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppjjLLLLLyLLLLLssTTTTTTpppppppjjtttyyytttjjsswwwwwwwwWWXX',
  'XXWwwTTTTTTTTpppppppppppppjjLLLLLyLLLLLjjTppppppppppppTTTTTpppppppppppppppVpppppppTTTTTppppppppppppppppppppppppppppjjjsssssssswwssTTTTTTTppppppjjyyyyHyyyyjjsswwwwwwwwWWXX',
  'XXWwwTTTTTTTTpppppppppppppjjjjjjjjjjjjjjjTTTpppppppppTTTTTTTTTTTpppppppppppppppppTTTTTTTTTppppppppppppppTTTpppTppppjjjjssssssswwsssTTTTTTTpppppjjyyyyyyyyyssswwwwwwwwwWWXX',
  'XXWwwTTTTTTTTpppppppppppppjjjjjjjjjjjjjjjTTTTTpppTTTTTTTTTTTTTTTTTTTTTTTTTTpppTTTTTTTTTTTTTTppTTTTTTTTTTTTTTTTTTppppppTTsssssswwsssssTTTTTTppppjjyyyyyyyyysswwwwwwwwwWWWXX',
  'XXWWwTTTTTTTTpppppppppppppppTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTpppppTTTTTTsswwssssssTTTTTTpppjjyyyyyyyyyswwwwwwwwwwWWWXX',
  'XXWWw;TTTTTTTTpppppppppppppTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTppppTTTTTTsssssswwssTTTTTTppjjjjjjjjjsswwwwwwwwwwwWWWXX',
  'XXWWw;;TTTTTTTTTpTTTTTTTTTTTTTTTTTT;;ss;TTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTppTTTTTTTssswwwwssTTTTTTppjjjjjjjjjjswwwwwwwwwwwWWWXX',
  'XXWWw;;TTTTTTTTTTTTTTTTTTTTTTTTTT;sssssss;TTTTTTTTTTTT;;ss;TTTTTTTTTTTTTTTTTTTTTTT;;;;;sTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTT;swwwwwwssTTTTTTpTTTTTTTTT;swwwwwwwwwwwWWWXX',
  'XXWWw;;TTTTTTTTTTTTTTTTTTTTTTT;sssswwwwwss;;TTTTTTTTT;sssssssss;TTTTTTTTTTTTTTTTT;sssssss;TTTTTTTTTTTTTT;;;TTT;TTTTTTTTTTTTTTssswwwwwwssssTTTTTTTTTTT;;ssswwwwwwwwwwwWWWXX',
  'XXWWw;;TTTTTTTTTTTTTTTTsssTTTsssswwwwwwwwwss;;TTT;;;sswwwwwsssssss;;;;;;;;;TTT;ssswwwwwsssssTT;sssssss;sssssssssTTTTTTTTTTTTTsswwwwwwwwsssTTTTTTTTTT;ssswwwwwwwwwwwwwWWWXX',
  'XXWWw;;TTTTTsTTTTTTTTTsssssssswwwwwwwwwwwwwwss;;ssssswwwwwwwwwwwssssssssss;;;ZssswwwwwwwwwsssssssssssssswwwssswssTTTTTTTTTTTsswwwwwwwwwssssTTTTTTTTsswwwwwwwwwwwwwwwwWWWXX',
  'XXWWw;;TTTTsssTTTTTsssssssssswwwwwwwwwwwwwwwwwssswwwwwwwwwwwwwwwwwwwwwwwwwwssswwwwwwwwwwwwwwsswwwwwwwwwwwwwwwwwwss;TTTTTsssssswwwwwwwwwssssTTTTTTT;swwwwwwwwwwwwwwwwwWWWXX',
  'XXWWws;TTssssssssssssssssssswwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwssssssssssssswwwwwwwwwsssssTTTTTTsswwwwwwwwwwwwwwwwwWWWXX',
  'XXWWws;;ssswwwsssssssssssssswwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwsssssssssssswwwwwwwwsssssssT;;;sswwwwwwwwwwwwwwwwwWWWXX',
  'XXWWwsssswwwwwwwswwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwsswwwwwwwwwwwwwwwwwsssssssssswwwwwwwwwwwwwwwwwwwWWWXX',
  'XXWWwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwsssswwwwwwwwwwwwwwwwwwwwwwWWWXX',
  'XXWWwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwWWWXX',
  'XXWWwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwWWWXX',
  'XXWWwwwwwwwwWwwwwwwwwwwwWWWWWWWWWwwwWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWwwwwwWWWWWWwwwwwwwwwwwwwwwwwwwwwwWWWWWWWWWWWWWWWWWWWWWWXX',
  'XXWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWXX',
  'XXWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWXX',
  'XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
  'XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
];

/**
 * THE DARK TERRITORY'S SITE ID.
 *
 * DEFINED HERE RATHER THAN IN `redaction.ts`, WHICH IS THE FILE ABOUT IT. That
 * file imports this one — it is a transformation OF this map — so a constant
 * living there and read by the legend below would be a cycle, and under ESM the
 * glyph would quietly read `undefined` at module-eval time rather than failing
 * loudly. `redaction.ts` re-exports it, so it is still where a reader looks.
 */
export const REDACTION_SITE_ID = 'site:redaction';

/** The legend. Every character is a real TileCode; nothing defaults. */
const ALDERBROOK_LEGEND: Readonly<Record<string, Glyph>> = {
  '.': { tile: TileCode.COBBLE },
  ',': { tile: TileCode.PAVING },
  p: { tile: TileCode.PLAINS },
  h: { tile: TileCode.HILLS },
  e: { tile: TileCode.HEATH },
  s: { tile: TileCode.SHORE },
  ';': { tile: TileCode.MIRE },
  '=': { tile: TileCode.BRIDGE },
  w: { tile: TileCode.WATER },
  W: { tile: TileCode.DEEPWATER },
  T: { tile: TileCode.TREES },
  M: { tile: TileCode.MOUNTAIN },
  c: { tile: TileCode.CRAG },
  '#': { tile: TileCode.TERRACE },
  C: { tile: TileCode.CIVIC },
  /**
   * A SETTLEMENT IS A CLUSTER, IN THREE SIZE TIERS. `v`/`t`/`k` are its roofs
   * seen from four screens away — which is a different thing from TERRACE and
   * CIVIC, the same buildings seen from the street inside a town, and the
   * reason both sets exist. `y` is the ground between them, `j` the fields
   * around the edge, `L` a city wall with a gate left open at its centre.
   */
  v: { tile: TileCode.VILLAGE_ROOF },
  t: { tile: TileCode.TOWN_ROOF },
  k: { tile: TileCode.CITY_ROOF },
  L: { tile: TileCode.TOWN_WALL },
  y: { tile: TileCode.YARD },
  j: { tile: TileCode.FIELD },
  X: { tile: TileCode.ERASED },
  /**
   * Alderbrook. The hub, the only spawn, and "the one fixed point the Index
   * cannot overwrite" (docs/game-design.md s1). Every player starts at its gate,
   * so the first thing you see on connecting is another player rather than
   * empty country. The generator SCORED this spot rather than being told it.
   */
  O: { tile: TileCode.PAVING, spawn: true, site: 'site:alderbrook' },
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE REST OF THE GATE — ten more spawn tiles, and the game needed them badly.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `O` above was the ONLY tile on this 170x100 map carrying `spawn: true`. Its
   * own docblock states the intent — "Every player starts at its gate, so the
   * first thing you see on connecting is another player rather than empty
   * country" — and with a single tile that is true of exactly one player.
   *
   * `world.ts#findSpawn` walks the authored cluster and falls through to
   * `spawnRng.pick('world.spawn.overflow', free)` over EVERY free tile on the
   * level. Its comment says that draw is "the overflow path, for the seventh
   * player onwards", which was true of the 3x2 cluster on the TEST level — and
   * every test covering spawn adjacency runs on that level, which is why this
   * survived. On the shipped overworld the cluster is exhausted by player TWO,
   * so from the second person to open the Activity, everybody is dropped at a
   * uniformly random point up to a hundred tiles away, in fog, with no way to
   * find each other: the world map draws only `self`, `PartyMember` carries no
   * position, and `follow` refuses because they are already in the same realm.
   *
   * For a game whose entire premise is friends in a voice channel, that fires
   * on every multiplayer session, on the first frame.
   *
   * ═══ YARD, NOT PAVING, AND THAT IS THE POINT ═══
   * Identical tile to the `y` it replaces, so the map looks and walks exactly as
   * it did — this adds spawn points and changes nothing else. Paving would have
   * drawn a stone apron around the gate that nobody asked for, and a map edit
   * that is invisible is a map edit that cannot regress the map.
   */
  o: { tile: TileCode.YARD, spawn: true },
  R: { tile: TileCode.PAVING, site: 'site:threadneedle_row' },
  H: { tile: TileCode.PAVING, site: 'site:ashwick_row' },
  P: { tile: TileCode.PAVING, site: 'site:wayfarers_camp' },
  S: { tile: TileCode.PAVING, site: 'site:saints_rest' },
  B: { tile: TileCode.PAVING, site: 'site:blackwood_outskirts' },
  F: { tile: TileCode.PAVING, site: 'site:gearford_ward' },
  G: { tile: TileCode.PAVING, site: 'site:glass_archive' },
  U: { tile: TileCode.HILLS, site: 'site:underworks' },
  A: { tile: TileCode.HILLS, site: 'site:watchers_altar' },
  N: { tile: TileCode.HILLS, site: 'site:hollow_mine' },
  D: { tile: TileCode.HILLS, site: 'site:drowned_chapel' },
  I: { tile: TileCode.PAVING, site: 'site:outer_index' },

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THREE PLACES NOBODY IS TOLD ABOUT.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Thirteen markers are on your map from the first frame, so the overworld has
   * never once rewarded LOOKING. Everything worth walking to was handed over
   * before you took a step, and a map with no unknown on it is a list of
   * destinations rather than a place.
   *
   * These three are hidden until you have personally stood near them — see
   * `SiteDef.hidden` and the fog gate in the gateway. NOTHING EXISTING IS
   * HIDDEN: taking a marker away from a player who has been reading it for
   * weeks is a feature that makes the game smaller, and the whole point is to
   * add somewhere to find.
   *
   * ═══ EACH GLYPH MAPS TO THE SAME TileCode AS THE CHARACTER IT REPLACED ═══
   * `K` was `h` (HILLS), `V` was `p` (PLAINS), `Z` was `s` (SHORE). So no cell
   * changed walkability, no cell changed what an eye can see through, and
   * `overworld.test.ts`'s `reach.size === 9327` holds bit for bit. That is the
   * design constraint, and it is what makes a three-site addition a data change
   * rather than a re-survey of the map.
   *
   * ═══ THE THREE CELLS WERE MEASURED, NOT CHOSEN ═══
   * Ranked by distance from the NEAREST existing marker, because that is what
   * makes a place feel found rather than listed:
   *
   *   Cairnfoot   59,57   26 tiles from any marker, 62 steps out — the western
   *                       downs, high ground people cross rather than visit.
   *   Barrow End  74,78   41 tiles, 47 steps — a PLAINS pocket inside the
   *                       southern forest band, and the first thing on this map
   *                       that rewards walking INTO the trees.
   *   The Weir    77,87   44 tiles, 62 steps — the most isolated walkable ground
   *                       on the entire map: a beach behind the wood, on a coast
   *                       that had 273 cells and not one destination.
   */
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * AND ONE DOOR THAT DOES NOT OPEN ONTO A ROOM.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Every other site glyph here opens thirty tiles of somewhere, built when you
   * step on it and reaped when you leave. This one opens a SECOND MOOR: the
   * whole of this map again with a sixth of it taken out, shared, persistent,
   * and walkable back. See `shared/redaction.ts` — the transform, and the four
   * numbers that were measured before any of it was written.
   *
   * ═══ FOURTEEN TILES FROM ANYTHING, AND THAT IS THE MEASUREMENT ═══
   * A door to another world standing between two towns is a fast-travel node.
   * (22,60) is the furthest cell in the western low country from any marker
   * already drawn — so it is somewhere you went looking, which is the same
   * argument and the same measurement that placed the three hidden sites.
   *
   * `TileCode.HILLS` BECAUSE THAT IS WHAT WAS ALREADY THERE. Every site glyph
   * in this table keeps the tile of the character it replaced, so adding a
   * destination never changes the shape of the ground — and `test/shared`
   * holds the walkable count at 9327 so that stays true for the next door.
   */
  E: { tile: TileCode.HILLS, site: REDACTION_SITE_ID },
  K: { tile: TileCode.HILLS, site: 'site:cairnfoot' },
  V: { tile: TileCode.PLAINS, site: 'site:barrow_end' },
  Z: { tile: TileCode.SHORE, site: 'site:the_weir' },
};

const ALDERBROOK = parseMap(ALDERBROOK_ROWS, ALDERBROOK_LEGEND);

/**
 * A fresh, MUTABLE region. Copied per call for the same reason
 * `makeTestLevel` is: one realm changing its map must not appear in another.
 */
export function makeOverworld(): AuthoredMap {
  return {
    view: { w: ALDERBROOK.view.w, h: ALDERBROOK.view.h, tiles: ALDERBROOK.view.tiles.slice() },
    spawns: ALDERBROOK.spawns,
    sites: ALDERBROOK.sites,
  };
}

// ---------------------------------------------------------------------------
// What kind of country you were standing on
// ---------------------------------------------------------------------------

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE GROUND A FIGHT INHERITS. Six answers, read off the map, no state.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The overworld has trees, mountains, a fen and a coastline, and until now every
 * one of them was scenery: whatever you were standing on when something caught
 * you, the room you woke up in was the same 24x24 walk through the same two tile
 * codes. So the map was a picture you crossed rather than ground you got caught
 * on, and the forest existed only as a shape you routed around.
 *
 * This is the classification that makes it matter, and it is the ONLY thing in
 * the terrain work that changes what a fight is. Everything else the design
 * considered — making terrain cost a turn, making it conditionally passable,
 * raising the reveal radius — was refuted by measurement and is a closed
 * question (see DECISIONS.md).
 *
 * ═══ WHY A NEIGHBOURHOOD AND NOT THE CELL ═══
 * One tile is noise. A single MIRE cell in open grass is a puddle, not a fen,
 * and a fight that turned into a swamp because of it would read as random. The
 * classifier asks what the surrounding 9x9 is mostly made of, so the answer
 * changes at the edge of a REGION rather than at the edge of a tile — which is
 * also the boundary the player perceives.
 *
 * ═══ ORDER IS THE PRIORITY, AND IT IS DELIBERATE ═══
 * Wet beats rock beats wood beats built. A cell can be several of these at once
 * on a map with a river running through a wood, and the first match wins: the
 * water is the thing that changes the fight most, so it is asked first.
 *
 * PURE, and it must stay pure — `shared/` may not read a clock, a random number
 * or a file. Two players ambushed on the same tile get the same ground, and a
 * test can assert the whole map's distribution without a server.
 */
export const Ground = {
  /** Grass and heath. Almost no cover; a ranged monster owns you until you close. */
  Open: 'open',
  /** Broken high ground. Knots of dead rock, and the fight the game already had. */
  Upland: 'upland',
  /** Inside the trees. Sightlines of a few tiles; you meet things at arm's length. */
  Wood: 'wood',
  /** Scree and crag. Corridors — you can fight them one at a time if you pick well. */
  Scree: 'scree',
  /** A yard or a street. Real corners, and the only ground with straight lines. */
  Walls: 'walls',
  /** Marsh and channel. WATER STOPS A BODY AND NOT AN EYE — see `makeArena`. */
  Fen: 'fen',
} as const;
export type Ground = (typeof Ground)[keyof typeof Ground];

/** How far out the neighbourhood reaches. 4 gives a 9x9, which is 81 cells. */
const GROUND_RADIUS = 4;

/**
 * How many of those 81 it takes to name the place.
 *
 * 8 is a tenth, which sounds low and is not: these are terrain families that
 * come in BANDS on this map — the forest is a belt, the range is a ridge — so a
 * cell genuinely inside one has thirty or forty of its neighbours, and a cell
 * with eight is on the edge, which is where the answer should change.
 */
const GROUND_ENOUGH = 8;

/** Built ground is dense where it exists at all, so it asks for twice as much. */
const GROUND_ENOUGH_BUILT = 16;

const WET: ReadonlySet<number> = new Set<number>([
  TileCode.MIRE,
  TileCode.WATER,
  TileCode.DEEPWATER,
]);

const ROCK: ReadonlySet<number> = new Set<number>([TileCode.CRAG, TileCode.MOUNTAIN]);

const BUILT: ReadonlySet<number> = new Set<number>([
  TileCode.YARD,
  TileCode.FIELD,
  TileCode.COBBLE,
  TileCode.PAVING,
  TileCode.BRIDGE,
  TileCode.RAIL,
  TileCode.VILLAGE_ROOF,
  TileCode.TOWN_ROOF,
  TileCode.CITY_ROOF,
  TileCode.TOWN_WALL,
]);

/**
 * What kind of country surrounds this cell.
 *
 * Total: every cell of every map has an answer, and off the edge counts as
 * nothing rather than throwing — a tile outside the map contributes to no
 * family, so a coastal cell is classified by the land it actually has.
 */
export function groundAt(level: LevelView, x: number, y: number): Ground {
  let wet = 0;
  let rock = 0;
  let wood = 0;
  let built = 0;

  for (let dy = -GROUND_RADIUS; dy <= GROUND_RADIUS; dy += 1) {
    for (let dx = -GROUND_RADIUS; dx <= GROUND_RADIUS; dx += 1) {
      const cx = x + dx;
      const cy = y + dy;
      if (cx < 0 || cy < 0 || cx >= level.w || cy >= level.h) continue;
      const code = level.tiles[cy * level.w + cx] ?? TileCode.WALL;
      if (WET.has(code)) wet += 1;
      else if (ROCK.has(code)) rock += 1;
      else if (code === TileCode.TREES) wood += 1;
      else if (BUILT.has(code)) built += 1;
    }
  }

  // THE CELL ITSELF SHORT-CIRCUITS THE WET CASE. Standing IN the marsh is a fen
  // whatever the ring says, because the ground under your feet is the one fact
  // the player is certain of.
  const here = tileAt(level, x, y);
  if (here === TileCode.MIRE || wet >= GROUND_ENOUGH) return Ground.Fen;
  if (rock >= GROUND_ENOUGH) return Ground.Scree;
  if (wood >= GROUND_ENOUGH) return Ground.Wood;
  if (built >= GROUND_ENOUGH_BUILT) return Ground.Walls;
  // LAST, and only from the cell: hills are scattered rather than banded on this
  // map, so a neighbourhood test would almost never fire and the high ground
  // would never once be the ground you fought on.
  if (here === TileCode.HILLS) return Ground.Upland;
  return Ground.Open;
}

// ---------------------------------------------------------------------------
// What the moor calls its own parts
// ---------------------------------------------------------------------------

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE GROUND HAS NAMES, AND THAT IS THE WHOLE FEATURE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Thirteen markers had names. The 9,327 tiles between them had one, and it was
 * "the overworld". So everything that happened out there was reported the same
 * way — you died on the overworld, you found it on the overworld, you got jumped
 * on the overworld — and six friends in a voice channel had no way to say WHERE
 * anything happened except by reading coordinates to each other.
 *
 * *"I got jumped in the Bracken Waste"* is a sentence. *"I got jumped at 94, 41"*
 * is a bug report. This game is played by people talking to each other, and the
 * evening's story is the product; a world whose parts cannot be named cannot be
 * talked about, and a place nobody can talk about is a place nobody remembers.
 *
 * ToME does this at `zone.lua`'s `zonename`, and for the same reason.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * BANDS, NOT A BAG OF RECTANGLES, BECAUSE A GAP FLICKERS
 * ═══════════════════════════════════════════════════════════════════════════
 * A list of hand-placed rectangles has to TILE — cover every cell, overlap
 * nowhere — or walking along a seam crosses in and out of a nameless strip and
 * announces itself over and over. One typo in one coordinate is enough, and the
 * symptom appears on one tile of one border where nobody is looking.
 *
 * So the regions are authored as horizontal BANDS, each cut into columns. Every
 * bound is an exclusive upper edge and the last of each list is the edge of the
 * map, which makes a gap unrepresentable rather than merely tested for.
 * `assertRegionsTile` runs at module load anyway, because the property is worth
 * two microseconds at boot.
 *
 * ═══ NAMED FOR THE COUNTRY, NEVER FOR THE SITE ═══
 * A marker already says "Threadneedle Row". A region that repeated it would tell
 * the player nothing they could not see, and the useful thing to name is the
 * ground BETWEEN the markers — which is precisely the part that had no name.
 */
export type Region = {
  readonly name: string;
  /** Inclusive. */
  readonly x0: number;
  readonly y0: number;
  /** Inclusive. */
  readonly x1: number;
  readonly y1: number;
};

/**
 * The moor, north to south, as it actually looks on the shipped map.
 *
 *   y 0-13    beyond the range: the cold strip where four doors sit
 *   y 14-31   the range itself, and the flat behind its eastern end
 *   y 32-57   downs in the west, heath in the middle, plains to the east
 *   y 58-77   the low country, which is where Alderbrook is
 *   y 78-87   the southern wood and the beach
 *   y 88-99   the water
 */
const BANDS: readonly { readonly y1: number; readonly cuts: readonly [number, string][] }[] = [
  // Beyond the mountains. Blackwood, Gearford, the Archive and Saint's Rest all
  // sit along here, which is why the walk to any of them is the long one.
  {
    y1: 13,
    cuts: [
      [104, 'the Cold Furrows'],
      [169, 'the Saintswood'],
    ],
  },
  // The range, and the open flat at its eastern end — the easy way round.
  {
    y1: 31,
    cuts: [
      [104, 'the Kettle Range'],
      [169, 'Kettleflat'],
    ],
  },
  // The middle of the map, and the most-crossed ground on it.
  {
    y1: 57,
    cuts: [
      [69, 'the Grey Downs'],
      [139, 'the Bracken Waste'],
      [169, 'Ashwick Reach'],
    ],
  },
  // Home. The spawn is at 121,72.
  {
    y1: 77,
    cuts: [
      [69, 'the Sedge'],
      [169, 'Alderbrook Common'],
    ],
  },
  // The wood along the south coast, and the beach east of it.
  {
    y1: 87,
    cuts: [
      [124, 'the Blackwater Wood'],
      [169, 'the Long Strand'],
    ],
  },
  // The sea, which you cannot walk on — named anyway, because the world map
  // draws it and a player pointing at it should have a word for it.
  { y1: 99, cuts: [[169, 'the Drowned Coast']] },
];

function buildRegions(): readonly Region[] {
  const out: Region[] = [];
  let y0 = 0;
  for (const band of BANDS) {
    let x0 = 0;
    for (const [x1, name] of band.cuts) {
      out.push({ name, x0, y0, x1, y1: band.y1 });
      x0 = x1 + 1;
    }
    y0 = band.y1 + 1;
  }
  return out;
}

export const ALDERBROOK_REGIONS: readonly Region[] = buildRegions();

/**
 * Every cell has exactly one name. Checked at module load rather than trusted,
 * for the reason the block above gives: a gap is a line that flickers on one
 * border, and the day somebody edits a bound is the day it appears.
 */
function assertRegionsTile(): void {
  const w = ALDERBROOK.view.w;
  const h = ALDERBROOK.view.h;
  const last = ALDERBROOK_REGIONS[ALDERBROOK_REGIONS.length - 1];
  if (last === undefined || last.x1 !== w - 1 || last.y1 !== h - 1) {
    throw new Error(
      `level: the region table stops at ${String(last?.x1)},${String(last?.y1)} but the map is ${String(w)}x${String(h)}`,
    );
  }
  for (const r of ALDERBROOK_REGIONS) {
    if (r.x0 > r.x1 || r.y0 > r.y1) {
      throw new Error(`level: region '${r.name}' has an inverted bound`);
    }
  }
}
assertRegionsTile();

/**
 * What this ground is called. Never undefined: the bands tile the map.
 *
 * A LINEAR SCAN over a dozen rectangles, run once per step and only when the
 * step actually landed. Building an index would be 17,000 strings held for the
 * life of the process to save a comparison nobody can measure.
 */
export function regionAt(x: number, y: number): string {
  for (const r of ALDERBROOK_REGIONS) {
    if (x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1) return r.name;
  }
  // Off the map. Reachable only from a caller that did not bounds-check, and a
  // name is a better answer than a crash inside somebody's move.
  return 'the moor';
}
