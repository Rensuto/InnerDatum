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
  'XXwwwwwwwss;;;;;;;;...............;;w;;TTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTwws.........................wwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwWWWWWWWWWWWWWWWXX',
  'XXwwTTTTTw##,,,##TT.TTTTTTTTTTTT##,,,##TTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTCC,,,CCTTTTTTTTTTTTTTTTTTTT.TTTT##,,,##TTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTwwwwwwwwwwwwwwwwwwWWXX',
  'XXwwThhhhh##,,,##...cccccccccccc##,,,##hcccccccccccccccccccccccccccccccccchhhhCC,,,CChhhhcccchhhhhhhhhhhh.hhhh##,,,##TTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTT;;;;;;sssswwwWWXX',
  'XXwwThhhhh,w,B,,,.hccccccccccccc,,,F,,whccccccccccccccccccccccccccccccccccchhh,w,G,,,ccccccccchhhhhhhhhhh.....,,,S,,,TTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTT;;;;ssswwwWWXX',
  'XXwTThhhhhw,,,,,,hcccccccccccccc,,,,,w,ccccccccccccccMMMMMMMcccccccccccccccchhw,,,,,,cccccccccccccchhhhhhh.hhh,,,,,,,TTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTssswwWWXX',
  'XXwTThhhhhw,,,,,,ccccccccccccccc,,,,w,,ccccccccccccMMMMMMMMMcccccccccccccccccw,,,,,,,ccccccccccccccccchhhh.hhh,,,,,,,TTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTT;swwwWWXX',
  'XXwTTccchwhhhhhcccccccccccccccccccc.wcccccccccccccMMMMMMMMMMMccccccccccccccccwccccccccccccccccccccccccchhh.hhhhhT.TTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTT;swwwWWXX',
  'XXTTTccccwccccccccccccccccccccccccc.wccccccccccMMMMMMMMMMMMMMMMccccccccccccccwcccccccccccccccccccccccccchh.hhhhhT.TTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTsswwWWXX',
  'XXTTTcccccwcccccccccccccccccccccccc.wcccccccccMMMMMMMMMMMMMMMMMMccccccccccccwcccccccccccccccccccccccccccch.hhhhhT.TTpppTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTsswwWWXX',
  'XXTTTcccccwcccccccccccccccccccccccc.wcccccccMMMMMMMMMMMMMMMMMMMMMcccccccccccwcccccMMMMMMMcccccMMMMccccccch.hhhhhp.pppppppppppppppppppppppppppppppppppTTTTTTTTTTTTTsswwWWXX',
  'XXTTcccccccwccccccccccccccccccccccc.wccccccMMMMMMMMMMMMMMMMMMMMMMMMcccMMMcccwccccMMMMMMMMMMMMMMMMMMccccccc.hhhhhp..pppppppppppppppppppppppppppppppppppppppppTTTTTT;swwWWXX',
  'XXTTccccccccwccccccccMMMMMMMMMMcccc=cccccMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMccwccMMMMMMMMMMMMMMMMMMMMccccccc.hhhhhpp.pppppppppppppppppppppppppppppppppppppppppTTTTTT;swwWWXX',
  'XXTTccccccccwcccccccMMMMMMMMMMMMMMc.wMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMccwcMMMMMMMMMMMMMMMMMMMMMccccccc.hhhhhpp.pppppppppppppppppppppppppppppppppppppppppTTTTTT;swwWWXX',
  'XXTTcMMMMMccwccccccMMMMMMMMMMMMMMMM.MwMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMcwMMMMMMMMMMMMMMMMMMMMMMccccccc.hhhhhpp.ppppppppppppppppppppppppppppppppppppppppppTTTTTTsswWWXX',
  'XXTTcMMMMMMMwccMMMMMMMMMMMMMMMMMMMM.MMwMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMwMMMMMMMMMMMMMMMMMMMMcccccccc.hhhhhpp.ppppppppppppppppppppppppppppppppppppppppppTTTTTTsswWWXX',
  'XXTTcMMMMMMwMMMMMMMMMMMMMMMMMMMMMMM.MMMwMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMwMMMMMMMMMMMMMMMcccccccccccc.hhhhppp.pppppppppppppppppppppppppppppppppppppp##,,,##TTTsswWWXX',
  'XXTTcMMMMMwMMMMMMMMMMMMMMMMMMMMMMMM.MMMMwMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMwMMMMMMMMMMMMcccccccccccccc.hhhhppp.pppppppppppppppppppppppppppppppppppppp##,,,##TTssswWWXX',
  'XXTTcMMMMwMMMMMMMMMMMMMccccccMMMMMM.MMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMccMMMMMMMMMMMMMMMMMMMMMMcccccccccccccch.hhhhppp.pppppppppppppppppppppppppppppppppppppp,,,R,,,TTssswWWXX',
  'XXTTcMMMwMMMMMMMMMMMccccccccccccccc.cMMMMMMMMMMMMMMMMMMMMMMMMMMMMccccccccccMMMMMMMMMMMMMMMccccccccccccccch.hhhhppp.pppppppppppppppppppppppppppppppppppppp,,,,,,,sssswwWWXX',
  'XXTTcMMMMMMMMMMMMcccccccccccccccccc.ccMMMMMMMMMcccccccccccMMMMMMcccccccccccccMMMMMMMMMMMMcccccccccccccccch.hhhhppp.pppppppppppppppppppppppppppppppppppppp,,,,,,,sssswwWWXX',
  'XXTTcMMMMMMMMMMcccccccccccccccccccc.cccccccccccccccccccccccMMMMccccccccccccccccMMMMMMMMcccccccccccccccccch.hhhhppp.pppppppppppppppppppppppppppppppppppppp.TTTTTTsswwwwWWXX',
  'XXTTcMMMMMMMMcccccccccccccccccccccc.ccccccccccccccccccccccccMMcccccccccccccccccccMMMcccccccccccccccccccchh.hhhpppp.pppppppppppppppppppppppppppppppppppppp.TTTTTTsswwwwWWXX',
  'XXTTcMMMMMMMccccccccccccccccccccccc.ccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccchhh.hhhpppp.pppppppppppppppppppppppppppppppppppppp.TTTTTTsswwwwWWXX',
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
  'XXwTThhhhhh..ppphhhhhhhhhhhhhhhhhhhhhhhhhhhppeeeeeeeeeeeeeee....hhhhhheeeeepppppppppeeeeeeeeeeehhhe.....eeeeeeeeeee.eeeeeeeeeeeeeeeeeeeeeeeeepppppppppp...pppTTTTTT;;wwWXX',
  'XXwTThhhhh..pppphhhhhhhhhhhhhhhhhhhhhhhhhpppeeeeeeeeeeeeeeeeeee.....................................eeeeeeeeeeeeeee.eeeeeeeeeeeeeeeeeeeeeeeeepppppppppp.pppppTTTTTT;;wwWXX',
  'XXwTThhhhh.hppphhhhhhhhhhhhhhhhhhhheeepppppeeeeeeeeeeeeeeeeeeeeeehhhhheeeeeeepppppeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee.eeeeeeeeeeeeeeeeeeeeeeeeepppppppp...pppppTTTTTT;;wwWXX',
  'XXwTThhhhh.hhhhhhhhhhhhhhhhhhhhhhhheeeepppeeeeeeeeeeeeeeeeeeeeeeeehhhheeeeeeeepppeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeehU......eeeeeeeeeeeeeeeeeeepppppppp.pppppppTTTTTTT;wwWXX',
  'XXwTThhhhh.hhhhhhhhhhhhhhhhhhhhhhhheeeeepeeeeeeeeeeeeeeeeeeeeeeeehhhheeeeeeeeeepeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeehhhheeee..eeeeeeeeeeeeeeeeeepppppppp.pppppppTTTTTTTTwwWXX',
  'XXwTThhhh..hhhhhhhhhhhhhhhhhhhhhhhheeeeeeeeeeeeeeeeeeeeeeeeeeeeeehhheeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeehhhhhhheehhe..eeeeeeeeeeeeeeeeepppppppp.pppppppTTTTTTTTwwWXX',
  'XXwTTh....hhhhhhhhhhhhhhhhhhhhhhhheeeeeeeeeeeeeeeeeeeeeeeeeeeeeehhhheeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeehhhhhhhehhhhe.......eeeeeeeeeeeppppp....pppppppTTTTTTTTwwWXX',
  'XXwTTh.hhhhhhhhhhhhhhhhhhhhhhhhhheeeeeeeeeeeeeeeeeeeeeeeeeeeeeehhhhheeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeehhhhhhhhhhhheeeeee.eeeeeeeeeeepppp..ppppppppppTTTTTTTTwwWXX',
  'XXwTTh.hhhhhhhhhhhhhhhhhhhhhhhhheeeeeeeeeeeeeeeeeeeeeeeeeeeeeehhhhhheeeeheeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeehhhhhhhhhhhhheeeee.eeeeeeeeeeeepp..ppppppppppppTTTTTTTwwWXX',
  'XXwTTh.hhhhhhhhhhhhhhhhhhhhhhhhheeeeeeeeeeeeeeeeeeeeeeeeeeeeeehhhhhheeehheeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeehhhhhhhhhhhhheeeee.eeeeeeeeeeeepp.pppppppppppppTTTTTTTwwWXX',
  'XXwTTh.hhhhhhhhhhhhhhhhhhhhhhhhhheeeeeeeeeeeeeeeeeeeeeeeeeeeehhhhhhhheeeheeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeehhhhhhhhhhhhheeeee.eeeeeeeeeeeep..pppppppppppppTTTTTTTwwWXX',
  'XXw##,,,##hhhhhhhhhhhhhhhhhhhhhhhheeeeeeeeeeeeeeeeeeeeeeeeeehheeeeeehhheeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeehhhhhhhhhhheeeeeee.eeeeeeeeee....ppppppppppppppTTTTTTTwwWXX',
  'XXw##,,,##hhhhhhhhhhhhhhhhhhhhhhhhheeeeeeeeeeeeeeeeeeeeeeeeehheeeeeehhhheeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeehhhhhhhhheeeeeeeee..eeeee.....eppppppppppppppppTTTTTTTwwWXX',
  'XXw,,,P,,,.hhhhhhhhhhhhhhhhhhhhhhhhheeheeeeeeeeeeeeeeeeeeeeehheeeeeehhhhhhhheeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeehhheeeeeeeeeeee.eee...eeeeeppppppppppppppppTTTTTTTwwWXX',
  'XXw,,,,,,,.hhhhhhhhhhhhhhhhhhhhhhhhhhhheeeeeeeeeeeeeeeeeeeehhhhheeeehhhhhhhhheeeehheeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee...e.eeeeeeeppppppppppppppppTTTTTTTwwWXX',
  'XXww,,,,,,...hhhhhhhhhhhhhhhhhhhhhhhhhheeeeeeeeeeeeeeeeeeehhhhhhheehhhhhhhhhhhehhhhheeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeppeeee.e.eeeeeeeppppppppppppppppTTTTTTTwwWXX',
  'XXwwTTTTThhh.hhhhhhhhhhhhhhhhhhhhhhhhhhheeeeeeeeeeeeeeehhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhheeeeeeeeeeeehhheeeeeeeeeeeeeeeeeeeeeeeppppe..D..eeeeeeeppppppppppppppppTTTTTTTwwWXX',
  'XXwwTTTThhhh.hhhhppphhhhhhhhhhhhhhhhhhhhhheeeeeeeeeeeehhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhheeeeeeeeeeehhhhheeeeeeeeeeeeeeeeeeeeeppppp..eeeeeeeeeeeppppppppppppppppTTTTTTTwwWXX',
  'XXwwTTTThhhh.hhhhppphhhhhhhhhhhhhhhhhhhheeeeeeeeeeeeehhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhheeeeeeeeeeeeeeeeeeeepppppp.peeeeeeeeeeeppppppppppppppppTTTTTTTwwWXX',
  'XXwwTTTTThhh.hhhhpppphhhhhhhheeehhhhhhheeeeeeeeeeeeeehhhhhheehhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhheeeeeeeeeeeeeeeeeeepppppp..pppeeeeeeeeppppppppppppppppTTTTTTTTwwWXX',
  'XXwwTTTTTThh.hhhppppphhhhhhheeeeehhhhhheeeeeeeeeeeeeehhhheeeeehhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhheeeeeeeeeeeeeeeeeeppppppp.pppppeeeeeeeppppppppppppppppTTTTTTTTwwWXX',
  'XXWwTTTTTTTT.hhhpppppphhhhhpeeeeehhhhheeeeeeeeeeeeeeehhhheeeeehhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhheeeeeeeeeeeeeeeeepppppppp.ppppppeeeeeeppppppppppppppppTTTTTT;;wwWXX',
  'XXWwTTTTTTTT..ppppppppppppppeeeeeehhhhppeeeeeeeeeeeeehhhheeeeehhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhheeeeeeeeeeeeeeeeppppppppp.pppppppeeeeeppppppppppppppppTTTTTT;;wwWXX',
  'XXWwTTTTTTTTp.ppppppppppppppeeeeepphhhppppeeeeeeeeeeeehhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhheeeeeeeeeeeeeeepppppppppp.ppppppppeeeeppppppppppppppppTTTTTT;;wwWXX',
  'XXWwTTTTTTTTp..pppppppppppppeeppppphhhppppppeeeeeeehhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhepppeeepeeeeeeppppppppppp.pppppppppeeeppppppppppppppppTTTTTT;;wwWXX',
  'XXWwTTTTTTTTpp.pppppppppppppeppppppphpppppppppeeephhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhphhhhhhhhhhhhhhhhhhpppppppppeeeepppppppppppp.ppppppppppeeppppppppppppppppTTTTTT;;wWWXX',
  'XXWwTTTTTTTTpp..pppppppppppppppppppppppppppppppppphhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhppphhhhhhhhhhhhhhhhhppppppppppeeppppppppppppp.pppppppppppeppppppppppppppppTTTTTT;;wWWXX',
  'XXWwTTTTTTTTppp...pppppppppppppppppppppppppppppppphhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhppphhhhhhhhhhhhhhhhhhpppppppppppppppppppppppp.ppppppppppppppppppppppppppppTTTTTT;;wWWXX',
  'XXWwTTTTTTTTppppp.pppppppppppppppppppppppppppppppphhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhppppphhhhhhhhhhhhhhhhhppppppppppppppppppppppp..pppppppppppppppppppppppppppTTTTTT;;swWWXX',
  'XXWwTTTTTTTTppppp.....ppppppppppppppppppppppppppppphhhhhhhhhhhhhhhphhhhhhhhhhhhhhppppppphhhhhhhhhhhhhhhppppppppppppppppppppp....pppppppppppppppppppppppppppTTTTTTsswwwWWXX',
  'XXWwTTTTTTTTppppppppp..pppppppppppppppppppppppppppppphhhhhhhhhhhhpppphhhhhpphhhhppppppppppphhhhhhhhhhhhppppppppppppppppppppp.........pppppppppppppppppppppTTTTTT;swwwwWWXX',
  'XXWwTTTTTTTTpppppppppp........pppppppppppppppppppppppphhhhhhhhhhhpppppphhpppphhppppppppppppppphhhhhhhhpppppppppppppppppppp....TTpppp..........pppppppppppTTTTTT;swwwwwWWXX',
  'XXWwTTTTTTTTppppppppppppppppp.pppppppppppppppppppppppphhhhhhhhhppppppppppppppppppppppppppppppphhhhhhhhpppppppppppppppppCC,,,CCTTTpppppppppppp.ppppppppppTTTTTT;swwwwwwWWXX',
  'XXWwTTTTTTTTppppppppppppppppp.CC,,,CCppppppppppppppppphhhhhhhhhpppppppppppppppppppppppppppppppphhhhhhppppppppppppppppppCC,,,CCTTTTppppppppppp.pppppppppTTTTTT;swwwwwwwWWXX',
  'XXWwTTTTTTTTppppppppppppppppppCC,,,CCpppppppppppppppppppppphhhpppppppppppppppppppppppppppppppppphhppppppppppppppppppppp,,,O,,,TTTTTpppppppppp.......pppTTTTTT;swwwwwwwWWXX',
  'XXWwTTTTTTTTpppppppppppppppppp,,,I,,,ppppppppppppppppppppppphpppppppppppppppppppppppppppppppppppppppppppppppppppppppppp,,,,,,,TTTTTTTpppppppppppppp.pppTTTTTTsswwwwwwwWWXX',
  'XXWwTTTTTTTTpppppppppppppppppp,,,,,,,pppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppp,,,,,,,TTTTTTTTppppppppppppp.pppTTTTTTsswwwwwwwWWXX',
  'XXWwTTTTTTTTpppppppppppppppppp,,,,,,,pppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppTssssT;sTTTTTTTppppppppppp##,,,##TTTssswwwwwwwWWXX',
  'XXWwTTTTTTTTpppppppppppppppppppppppTTTTTpppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppsssssssssssTTTTTTpppppppppp##,,,##TTTsswwwwwwwwWWXX',
  'XXWwwTTTTTTTTppppppppppppppppppppTTTTTTTTTppppppppppppTTTTTpppppppppppppppppppppppTTTTTpppppppppppppppppppppppppppppppsssssssswwssTTTTTTTppppppppp,,,H,,,TTTsswwwwwwwwWWXX',
  'XXWwwTTTTTTTTpppppppppppppppppTTTTTTTTTTTTTTpppppppppTTTTTTTTTTTpppppppppppppppppTTTTTTTTTppppppppppppppTTTpppTpppppppTssssssswwsssTTTTTTTpppppppp,,,,,,,TssswwwwwwwwwWWXX',
  'XXWwwTTTTTTTTppppppppppppppppTTTTTTTTTTTTTTTTTpppTTTTTTTTTTTTTTTTTTTTTTTTTTpppTTTTTTTTTTTTTTppTTTTTTTTTTTTTTTTTTppppppTTsssssswwsssssTTTTTTppppppp,,,,,,,ssswwwwwwwwwWWWXX',
  'XXWWwTTTTTTTTpppppppppppppppTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTpppppTTTTTTsswwssssssTTTTTTpppppppTTTTTssswwwwwwwwwwWWWXX',
  'XXWWw;TTTTTTTTpppppppppppppTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTppppTTTTTTsssssswwssTTTTTTpppppTTTTTTsswwwwwwwwwwwWWWXX',
  'XXWWw;;TTTTTTTTTpTTTTTTTTTTTTTTTTTT;;ss;TTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTppTTTTTTTssswwwwssTTTTTTppppTTTTTTT;swwwwwwwwwwwWWWXX',
  'XXWWw;;TTTTTTTTTTTTTTTTTTTTTTTTTT;sssssss;TTTTTTTTTTTT;;ss;TTTTTTTTTTTTTTTTTTTTTTT;;;;;sTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTT;swwwwwwssTTTTTTpTTTTTTTTT;swwwwwwwwwwwWWWXX',
  'XXWWw;;TTTTTTTTTTTTTTTTTTTTTTT;sssswwwwwss;;TTTTTTTTT;sssssssss;TTTTTTTTTTTTTTTTT;sssssss;TTTTTTTTTTTTTT;;;TTT;TTTTTTTTTTTTTTssswwwwwwssssTTTTTTTTTTT;;ssswwwwwwwwwwwWWWXX',
  'XXWWw;;TTTTTTTTTTTTTTTTsssTTTsssswwwwwwwwwss;;TTT;;;sswwwwwsssssss;;;;;;;;;TTT;ssswwwwwsssssTT;sssssss;sssssssssTTTTTTTTTTTTTsswwwwwwwwsssTTTTTTTTTT;ssswwwwwwwwwwwwwWWWXX',
  'XXWWw;;TTTTTsTTTTTTTTTsssssssswwwwwwwwwwwwwwss;;ssssswwwwwwwwwwwssssssssss;;;sssswwwwwwwwwsssssssssssssswwwssswssTTTTTTTTTTTsswwwwwwwwwssssTTTTTTTTsswwwwwwwwwwwwwwwwWWWXX',
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
  X: { tile: TileCode.ERASED },
  /**
   * Alderbrook. The hub, the only spawn, and "the one fixed point the Index
   * cannot overwrite" (docs/game-design.md s1). Every player starts at its gate,
   * so the first thing you see on connecting is another player rather than
   * empty country. The generator SCORED this spot rather than being told it.
   */
  O: { tile: TileCode.PAVING, spawn: true, site: 'site:alderbrook' },
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
