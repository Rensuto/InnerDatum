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
import { TileCode, blocksSight, isWalkable, isKnownTile } from './protocol.ts';
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
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * WHICH DRAWN ROOMS WERE STAMPED INTO THIS FLOOR, AND WHERE.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Absent for a map with no generator behind it — an authored fixture, the
   * arena — which is why it is optional rather than an empty array: "this map
   * has no vault system" and "this floor rolled no room" are different facts.
   *
   * ═══ IT EXISTS BECAUSE THE TILES ARE NOT A HONEST WITNESS ═══
   * The first test of the vault system asked whether a room's exact pattern
   * appeared in the finished map, which is a proxy and a bad one. Measured over
   * forty seeds a shape: the smallest room matched 40/40 in every shape because
   * eight wall cells in an L is a thing procedural noise produces by accident,
   * while the largest matched 3/40 in a works and the middle one 0/40 — because
   * `connect` tunnels through a room it cannot otherwise reach and destroys the
   * pattern, which is CORRECT behaviour and indistinguishable from never having
   * stamped it.
   *
   * So the generator records what it did. This is server-side only: `RealmMsg`
   * carries a `LevelView`, never an `AuthoredMap`.
   */
  readonly vaults?: readonly {
    readonly id: string;
    readonly at: TileXY;
    readonly turn: string;
    /**
     * The footprint AFTER the turn, so a reader never has to re-derive it. A
     * quarter turn swaps width and height, and a consumer that looked the room
     * up by id and forgot that would be testing the wrong rectangle — silently,
     * and only for two of the six orientations.
     */
    readonly w: number;
    readonly h: number;
  }[];
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * WHAT THE COUNTRY ON THIS MAP IS CALLED.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * The gateway sent `ALDERBROOK_REGIONS` for EVERY overworld, hard-coded — the
   * same shape as the world map's `'THE ALDERBROOK REGION'` title, and correct
   * for the same accidental reason: `REDACTION_REGIONS` happens to be the very
   * same array, because the dark territory is a transformation of this map and
   * deliberately keeps its names.
   *
   * Correct by coincidence is not correct. `redaction.ts` exported
   * `REDACTION_REGIONS` for the gateway to use and the gateway never imported
   * it, so the one value that was supposed to make this general was DEAD CODE
   * while a literal did its job. The day a third map has its own names, a client
   * would draw this map's captions over it.
   *
   * OPTIONAL, because most maps have none: a delve is one room and a town is one
   * street grid, and neither has country in it to name.
   */
  readonly regions?: readonly Region[];
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
   * it genuinely cannot name. protocol.ts is the authority on what is known,
   * which is what keeps the vocabulary in one file.
   *
   * ═══ AND THE QUESTION IS ASKED ONCE, THERE, RATHER THAN REBUILT HERE ═══
   * This read `isWalkable(raw) || blocksSight(raw) || raw === TileCode.WATER`,
   * which looks complete and is not: those two sets cover every tile except one
   * that is unwalkable AND transparent, and `WATER` is bolted on for exactly
   * that case. `DEEPWATER` is the same shape, was added later, and this clause
   * never learned it — so 716 cells of open sea came out of here as `WALL`. The
   * renderer drew them as rock (its own deep-sea colour, written so *"a
   * shoreline is legible"*, was unreachable) and `blocksSightAt` said an eye
   * cannot cross the water while `blocksSight` said it can.
   *
   * `isKnownTile` is derived from `TileCode` itself, so the next tile that is
   * solid and see-through works on the day somebody adds it.
   */
  if (isKnownTile(raw)) {
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
  'XXWWWWiiiiiiiiiissssTTTTTTTTTTTTTTTTTTTTTTTTTTTffffffffffnnnsssiiiiiiiWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWXX',
  'XXWWWiiiiiiiiiissshTTTTTTTTTTTTTTTTTTTTTTTTTTTfffffffffffnnnnnsssiiiiiiiWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWXX',
  'XXWWiiiisssiisssshhTTTTTTTTTTTTTTTTTTTTTTTTffffffffffffffnnnnnnnssiiiiiiiWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWXX',
  'XXiiiiisssssssshhhhhTTTTTTTTTTTTTTTTTTTTTTTTffffffffffffffnnnnnnnsssiiiiiiiWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWXX',
  'XXiiiissppssshhhhhhhTTTTTTTTTTTTTTTTTTTTTTTTffffffffffffffnnnnnnneessiiiiiiiiWWWWWWWWWWWWWiiiiiiiiiiiiiiiiiiiiiiiWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWXX',
  'XXiiissppssshhhhhhhhhTTTTTTTTTTTTTTTTTTTTTTTTffffffffffffffnnnnnnneessiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWXX',
  'XXiiisspsBhhhhhhhhhhhhTTTTTTTTTTTTTTTTTTTTTTTTfffffffffffffffnnnnnnnnssiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWXX',
  'XXiiisssseeeeeeehhhhhhhTTTTTTTTTTTTTTTTTTTTTTTTfffffffffffffffnnnnnnnnsssiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWXX',
  'XXiiiissshhhhhheeeehhhhTTTTTTTTTTTTTTTTTTTTTTTTfffffffffffffffnnnnnnnnnsssiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWXX',
  'XXiiissshhhhhhhhhhehhhhhTTTTTTTTTTTTTTTTTTTTTTTTfffffffffffffffnnnnnnnneessiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiisssiiiiiiWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWXX',
  'XXiiisshhhhhhhhhhhehhhhhhTThhTTTTTTTTTTTTTThTTTTTfffffffffffffffnnnnnnneeessssssssssssssssssiiiiiiiiiiiiiiiiiiiiiiiisssssiiiiiiWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWXX',
  'XXiissshhhhhhhhhhheehhhhhhhhhhhTTTTTTTTTTTeheTTTTfffffffffffffffnnnnnnnneeesssssssssssssssssssssssiiiiiiiiiiiiiiiiisspppssiiiiiiiWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWXX',
  'XXiisshhhhhhhhhhhhheeehhhhhhhhhhhhTTTTTTTTeheTTTTTffffffffffffffnnnnnnnneeeeeeeeeeeeeeeennnnnssssssssssssssiiiiiiisspppppssiiiiiiiiWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWXX',
  'XXwsshhhhhhhhhhhhhhhhehhhhhhhhhhhhhhhhTTTTeheTTTTTTfffffffffffffnnnnnnnnneeeeeeehhhheeeennnnnneeessssssssssssssswwss..G.psswwwwwwwwwWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWXX',
  'XXwsshhhhhhhhhhhhhhhheeeeehhhhhhhhhhhhhhhTeheTTTTTTfffffffffffffnnnnnnnnneeeehhhhhhhhhennnnnnneeeeennnsssssss........pp.psswwwwwwwwwwwWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWXX',
  'XXsshhhhhhhhhhhhhhhhhhhhheeeeeeeeeeeeeeeeeeeeeTTTTTTfffffffffffnnnnnnnnnnnhhhhhhcccc.....nnnnn......nnnn......ssssssssp.sswwwwwwwwwwwwwwWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWXX',
  'XXsshhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhheheTTTTTTTffffffffffnnnnnnnnhhhhhhccccccc.chhhhhhhheeeeeeenneeeeeeeeeeesssss.swwwwwwwwwwwwwwwwwwWWWWWWWWWWWWWWWWWWWWWWWWWWWWWXX',
  'XXshhhhhhhhhhhhhhhhhhhhhhhhhhhhhcccccchhhhheheTTTTTTTffffffffffnnnnnnhhhhhcccccccccc.ccccchhhhhhhhheeeeeeeeeeeeeeeeeess..sswwwwwwwwwwwwwwwwwWWWWWWWWWWWWWWWWWWWWWWWWWWWWXX',
  'XXshhhhhhhhhhhhhhhhhhhhhhhhhhhccccccccccccceheTTThTTTTffffffffnnnnhhhhhhcccccccccMMcFcccccccccchhhhhhhhheeeeehhhhhhhhhhs..ssswwwwwwwwwwwwwwwwwWWWWWWWWWWWWWWWWWWWWWWWWWWXX',
  'XXshhhhhhhhhhhhhhhhhhhhhhhcccccccccccccccccehhhhhhhhhTTfffffffnhhhhhhcccccccccMMMMMMMMMccccccccccccchhhhhhhhhhhhhhhhhhccc...sswwwwwwwwwwwwwwwwwWWWWWWWWWWWWWWWWWWWWWWWWWXX',
  'XXshhhhhhhhhhhhhhhhhhhhcccccccccccMMMMcccccehhhhhchhhhhhffffnhhhhhccccccccccMMMMMMMMMMMMMMMMcccccccccccchhhhhccccccccccccch..sswwwwwwwwwwwwwwwwwWWWWWWWWWWWWWWWWWWWWWWWWXX',
  'XXshhhhhhhhhhhhhhhhccccccccccccMMMMMMMMMMMMeehhhhcccchhhhhhhhhhccccccccccMMMMMMMMMMMMMMMMMMMMMMcccccccccccccccccccccccccccch....swwwwwwwwwwwwwwwwwwwwwwwwWWWWWWWWWWWWWWWXX',
  'XXshhhhhhhhhhhhhcccccccccccMMMMMMMMMMMMMMMMMehhhccccccccchhhccccccccccMMMMMwMMMMMMMMMMMMMMMMMMMMMMccccccccccccccccccccMMMMMMMss.sswwwwwwwwwwwwwwwwwwwwwwwwwwWWWWWWWWWWWWXX',
  'XXshhhhhhhhhhccccccccccMMMMMMMMMMMMMMMMMMMMMehhhcMccccccccccccccccMMMMMMMMMwMMMMMMMMMMMMMMMMMMMMMMMMMMcccccccccMMMMMMMMMMMMMMMM....wwwwwwwwwwyyeyywwwwwwwwwwwwWWWWWWWWWWXX',
  'XXshhhhhhhhccccccccMMMMMMMMMMMMMMMMMMMMMMMMMehhhcMMMMMcccccccccMMMMMMMMMMMMwwMMMMMMMMMMMMMMMMMMMMMMMMMMMMccMMMMMMMMMMMMMMMMMMMMMss.swwwwwwwyeyyyeyyywwwwwwwwwwwWWWWWWWWWXX',
  'XXsshhhhhccccccccMMMMMMMMMMMMMMMMMMMMwMMMMMMeeehMMMMMMMMMMccMMMMMMMMMMMMMMMMwMMMMMccMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMwwMMMMMMMccccs.sswwwwwwyttyyyeyywwwwwwwwwwwwWWWWWWWWXX',
  'XXsshhhcccccccMMMMMMMMMMMMMMMMMMMMMMMwMMMMMMMhehMMMMMMMMMMMMMMMMMMMMMMMMMMMMwMMMccccccccMMMMMMMMMMMMMMMMMMMMMMMMMMMMMwMMMMMccccccc....swwweytteyyyeyywwwwwwwwwwwwWWWWWWWXX',
  'XXssshccccccMMMMMMMMMMMMMMMMMMMMMMMMwwMMMMMMMhehMMMMMMMMMMMMMMMMMMMMMMMMMMMMwMMcccccccccccMMMMMMMMMMMMMMMMMMMMMMMMMMMwwMcccccccchhhss..........SyyyeywwwwwwwwwwwwwwWWWWWXX',
  'XXwsscccccMMMMMMMMMMMMMMMMMMMMMMMMMMwMMMMMMMMhehMMMMMMMMMMMMMMMMMMMMMMMMMMMMwcccccccccccccccccMMMMMMMMMMMMMMMMMMMMMMMcwccccccchhhhhhssssssyyeyy.eyyyewwwwwwwwwwwwwwwWWWWXX',
  'XXwsssccMMMMMMMMMMMMMMMMMMMMMMMMMMMMwMMMMMMMMhNeeMMMMMMMMMMMMMMMMMMMMMMMMMMMwwccchhhhhhcccccccccccMMMMMMMMMMMMMMccccccwwcccchhhhhTTThsshhchyye..yeyyswwwwwwwwwwwwwwwwWWWXX',
  'XXwwssccMMMMMMMMMMMMMMMMMMMMMMMMMMMcwMMMMMMMchhheMMMMMMMMMMMMMMMMMMMMMMMMMcccwcchhhhhhhhhhhcccccccccccMMMMMMMccccccccccwwchhhhhhhhTTTTThhhTyy..yyyeyssswwwwwwwwwwwwwwwWWXX',
  'XXwwwssMMMMMMMMMMMMMMMMMMMMMMMMMccccwccccMMMchhheMMMMMMMMMMMMMMMMMMMMMMMMccccwhhhhnnnnnhhhhhhcccccccccccccccccccccccccchwhhhhhhhhhhTTTTTThTTT.yeyycsssssswwwwwwwwwwwwwwWXX',
  'XXwwwsssMMMMMMMMMMMMMMMMMMMMMMcccccwwcccccccchhheMMMMMMMMMMMMMMMMMMMMMcccccccwhhpnnnnhhhhhhhhhhhhcccccccccccccccccchhhhhwweeehhhhheeTTTTTTTTT.hhcccccsssssswwwwwwwwwwwwwXX',
  'XXwwwwssMMMMMMMMMMMMMMMMMMMMMccccccwccccccccchhheeMMMMMMMMMMMMMMMMMMccccccchhwpppppThhhhhhhhhhhhhhhhhccccccccchhhhhhhhhhewweeeeeeeeeTTTTTTTTT.hhhhcccccsssssswwwwwwwwwwwXX',
  'XXwwwwwssMMMMMMMMMMMMMMMMMMccccccchwhhhcccccchhhheccMMMMMMMMMMMMMcccccccchhhhwwppppThhhhhhhhhhhhhhhhhhhhhchhhhhhhhheeeeeeeweeeeeeeeeeTTTTTTTT.hehhhccccccssssswwwwwwwwwwXX',
  'XXwwwwwsssMMMMMMMMMMMMMMMccccccchhhwhhhhhhcchhhhheccccccMMMMMMcccccccchhhhppppwppppTThhhhhhhhhhheeeeehhhhhhhhheeeeeeeeeeeewweeeeeeeeeeTTTTTee.eeehhhhccccccsssswwwwwwwwwXX',
  'XXwwwwwwssMMMMMMMMMMMMMccccccchhhhwwhhhhhhhhhhhhheccccccccccccccccchhhhhppppppwpppppphhhhhhhhhhheeeeeeeeeeeeeeeeeeeeeeeeeeeweeeeeeeeeeeeeeeee.eeeeehhhccccccsssswwwwwwwwXX',
  'XXwwwwwwssMMMMMMMMMMcccccccchhhheewhhhhhhhhhhhhhheecccccccccccccchhhhpppppppppwwpppppphhhhhhhheeeeeeeeeeeeeeeeeeepppppeeeeewweeeeeeeeeeeeeeee.eeeeeehhhhcccccssswwwwwwwwXX',
  'XXwwwwwwssMMMMMMMMccccccccchhheeeewhhhhhhhhhhhhhhehhhccccccccchhhhhppppppppppppwpppppphhhhhhhheeeeeeeeeeeeeeeeeepppppppeeeeewweeeeeeeeeeeeeee.eeeeeeehhhhcccccssswwwwwwwXX',
  'XXwwwwwssMMMMMMMccccccccchhheeeeeewehhhhhhhhheeeeehhhhhhhhhhhhhhpppppppppppppppwwpppppphhhhhheeeeeeeeeeeeeeeeeeeppppppppeeeeeweeeeeeeeeeeeeee.eeeeeeeeehhhhhhhhssswwwwwwXX',
  'XXwwwwwscccccccccccccchhhhheeeeeewweeeeeeeeeeeeeeeeephhhhhhhhpppppppppppppppppppwwppppphhhhheeeeeeeeeeeeeeeeeeeeppppppppeeeeewweeeeeeeeeeeeee.eeeeeeeeeehhhhhhhhsssswwwwXX',
  'XXwwwwsscccccccccccchhhheeeeeeeeeweeeeeeeeeeeeeeeepeeeeeeeeeeeeeeApppppppppppppppwpppppphhheeeeeeeeeeeeeeeeeeeeepppppppppeeeeeweeeeeeeeeeeeee.eeeeeeeeeeeehhhhheeessswwwXX',
  'XXwwwwsccccccccccchhhheeeeeeeeeewweeeeeeeeeeeeeeeppppppppppppepppppppppppppppppppwwppppphheeeeUeeeeeeeeeeeeeeeeeppppppppppeeeewweeeeeeeeeeeee.eeeeeeeeeeeeeeeeeeeeessswwXX',
  'XXwwwsshhccccccchhhheeeeeeeeeeeeweeeeeeeeeeeeeeee;;;;;pppppppeppppppppppppppppTpppwwppppeeeeee.eeeeeeeeeeeeeeeeeeppppppppppeeeeweeeeeeeeeeeee.eeeeeeeeeeeeeeeeeeeeeessswXX',
  'XXwwwsehhhhhhhhhhhheeeeeeeeeeeewweeeeeeeeeeeeeee;;;;;;;;;;;;pepppppppppppppppTTTpppwppppppeeee.eeeeeeeeeeeeeeeeeeeeeppppppppeeewweeeeeeeeeeee.eeeeeeeeeeeeeeeeeeeeeeesssXX',
  'XXwwsseeehhhhhhhheeeeeeeeeeeeeeweeeeeeeeeeeeeee;;;;;;;;;;;;;pepppppppppppppppTTTTppwwppppppppp.eeeeeeeeeeeeeeeeeeeeeepppppppeeeeweeeeeeeeeeee.eeeeeeeeeeeeeeeeeeeeeeeessXX',
  'XXwsseeeeeeeeeeeeeeeeeeeeeeeeeeweeeeeeeeeeeeeee;;;;;;;;;;;;;;epppppppppppppppTTTTTppwwpppppppp.....eeeeeeeeeeeeeeeeeepppppppeeeewweeeeeeeeeee.eeeeeeeeeeeeeeeeeeeeeeeeesXX',
  'XXwseeeeeeeeeeeeeeeeeeeeeeeeeewweeeeeeeeeeeeee;;;;;;;;;;;;;;;epppppppppppppppTTTTTpppwpppppppjjjrj.jjjjeeeeeeeeeeeeeeeppppppeeeeeweeeeeeeeeee.eeeeeeeeeeeeeeeeeeeeeeeeesXX',
  'XXEs;;;;;eeeeeeeeeeeeeeeeeeeeeweeeeeeeeeeeeeee;;;;;;;;;;;;;;peppppppppppppppTTTTTppppwwppppppjjjrr.......jjeeeeeeeeeeeeeppppppeeewweeeeeeeeee.eeeeeeeeeeeeeeeeeeeeeeeeeeXX',
  'XXss;;;;;;;;;;;eeeeeeeeeeeeeewweeeeeeeeeeeeee;;;;;;;;;;;;;;;peppppppppppppppTTTTTpppppwwppppjjjjjrr..jjj..jppppjeeeeeeeeeeeepeeeeeweeeeeeeeee.eeeeeeeeeeeeeeeeeeeeeeeeeeXX',
  'XXss;;;;;;;;;;;;;;;;;eeeeeeehweeeeeeeeeeeeeee;;;;;;;;;;;;;;ppepppppppppppppTTTTTpppppppwwpppjjjjjjrj...jj.jppppjjjjjeeeeeeeepeeeeewwjjjjjjjjj.jjeeeeeeeeeeeeeeeeeeeeeeeeXX',
  'XXs;;;;;;;;;aaaaaaaaa;;;;;;ewweeeeeeeeeeeeee;;;;;;;;;;;;;;;ppepppppppppppTTTTTTTppppppppwwwjjjjjjjrjjj.jj.........jjjjjjeeeeeeeeeeewjjjjjjjjj.jjeeeeeeeeeeeeeeeeeeeeeeeeXX',
  'XXs;;;;;;;aaaaaaaaaaaaa;;;;;w;;;;;eeeeeeeeee;;;;;;;;;;;;;;pppepppppppppppTTTTTTTppppppppppwwjjjjjjrjjj..jjjpppjjj.........jjeeeeeeewwyyyttyy..jjeeeeeeeeeeeeeeeeeeeeeeeeXX',
  'XXs;;;;;aaaaaaaaaaaaaaaaa;;;w;;;;;;;;wwweee;;;;;;;;;;;;;;;pppepppppppppppppTTTTTpppppppppppwwjjjjjrjjjj.jjjppjjjjjjjjjjjj...eeeeeeejwytttt...yjjeeeeeeeeeeeeeeeeeeeeeeeeXX',
  'XXs;;;;;aaaaaaaaaaaaaaaaa;;ww;;;;;;;;;;;;;;;;;;;;;;;;;;K;;pppepppppppppppppppppppppppppppppjwwjjjjrjjjj.jjjjjjjjjjjjjjjjjjj.........wwtty...ttjjeeeeeeeeeeeeeeeeeeeeeeeeXX',
  'XXs;;;;aaaaaaaaaaaaaaaaaaa;w;;;;;;;;;;;;;;;;;;;;;;;;;;;e;;;ppepppppppppppppppppppppppppppppjjwwjjjrjjjj.jjjjjjjjjjjjjjjjjjjjjeeeeee..b...R...yjjeeeeeeeeeeeeeeeeeeeeeeeeXX',
  'XXs;;;aaaaaaaXXXXXXXaaaaaaaw;;;;;;;;;;;;;;;;;;;;;;;;;;;e;;;ppepppppppppppppppppppppppppppppjjjwwwjrjjjj.jjjjjjjjjjjjjjjjjjjjjeeeeeejjwwy......jjeeeeeeeeeeeeeeeeeeeeeeeeXX',
  'XXss;;aaaaaaXXXXXXXXXaaaaaaw;;;;;;;;;;;;;;;;;;;;;;;;;;;e;;;;peppppppppppppppppppppppppppppjjjjjjwwrrjjj.jjjjjjjjjjjjjjjjjjjjjeeeeeejj.b....tt.jjeeeeeeeeeeeeeeeeeeeeeeeeXX',
  'XXss;;aaaaaaXXXXXXXXXaaaaaww;;;;;;;;;;;;;;;;;p;;;;;;;;;ep;;;eeppppppppppppppppppppppppppppjjjjjjjwwrrrr...............................ww...tt..jeeeeeeeeeeeeeeeeeeeeeeeeXX',
  'XXss;;aaaaaaXXXXIaaaaaaaaaw;;;;;;;;;;;;;;;;;;ppp;;;ppeeeeeeeepppppppppppppppppppppppppppppjjjjjjjjwkkkk.ykkyyjjjjjjjjjjjjjjjjjeeeeejjjjwjjjjjj..eeeeeeeeeeeeeeeeeeeeeeeeXX',
  'XXsss;aaaaaaXXXXXXXXXaaaaaw;;;;;;;;;;;;;;;;;;;ppppeeeeeppppppppppppppppppppppppppppppppppjjjjjjjjwwkkooooo.yyjjjjjjjjjjjjjjjjssseeejjjjwwjjjjjj.eeeeeeeeeeeeeeeeeeeeeeeeXX',
  'XXwss;aaaaaaXXXXXXXXXaaaaww;;;;;;;;;;;;;;;;;;;ppppeppepppppppppppppppppppppppppppppppppppjjjjjjjjwykkooooo.kkjjjjjjjjjjjjjjjjsssssseeeeeweeeeee...eeeeeeeeeeeeeeeeeeeeeeXX',
  'XXwsssaaaaaaaXXXXXXXaaaaawa;;;;;;;;;;;;;;;;;;;;pppeppeppppppppppppppppppppppppppppppppppjjjjjjjjwwykkooOoo.kkjjjjjjjjjjjjjjjsssssssssssewweeeeeee.eeeeeeeeeeeeeeeeeeeeesXX',
  'XXwwss;aaaaaaaaaaaaaaaaaaw;;;;;;;;;;;;;;;;;;;;;peeeppepppppppppppppp............................b....ooooo.rrjjjjjjjjjjjjjjssssssssssssssweeeeeee.eeeeeeeeeeeeeeeeeeeeesXX',
  'XXwwsss;aaaaaaaaaaaaaaaaaw;;;;;;;;;;;;;;;;;;;;;;eppppeppppppppp......ppppppTTTTTTTTpppjjjjjjjjjwwjyykkooko.yrjjjjjjjjjjjjjjsssssssssssssswwssssee.eeeeeeeeeeeeeeeeeeeeesXX',
  'XXwwwss;aaaaaaaaaaaaaaaaww;;;;;;;;;;;;;;;eee;;;;e...............ppppTTTTTTTTTTTTTTTpppjjjjjjjjjwpppppp..k.....jjjjjjjjjjjjsssssssssssssssswwsssss.ssseeeeeeeeeeeeeeeeessXX',
  'XXwwwwss;;aaaaaaaaaaaaaebeeeeeeeeeeeeeeeeeeeeeeeeppppppppppppTTTTTTTTTTTTTTTTTTTTTTTpjjjjjjjjjwwpjLLLyyyyyLLL....jjjjjjjjsssssssssssssssssswwssss.ssseeeeeeessssssssssssXX',
  'XXwwwwwss;;;aaaaaaaaa;;;w;;;;;;;;;;;;;;eeeeepe;;;ppppeTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTjjjjjjjjjwppjjjjjjjjjjjjjrr.rrrrrrrrrrrrrrrrrrrrrrrrrrrwwsss.sssseeeeesssssssssssswXX',
  'XXwwwwwss;;;;;;;;;;;;;;ww;;;;;;;;;;;;;eeeePeeee;;TTTpTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTjjjjjjjwwppjjjjjjjjjjjjjjj.jjjjjjjsssssssssssssssseeerrwwss.jjjjjjjjjjjjsssssssswwXX',
  'XXwwwwwwss;;;;;;;;;;;;;w;;;;;;;;;;;;;;;eeyeeee;;;TTTpTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTjjjjjjjwpppppppjjjjppppppj..jjjjjssssssssssssssss.......b.....jjjjjjjjjjsssssssswwXX',
  'XXwwwwwwsss;;;;;;;;;;;;w;;;;;;;;;;;;;;;eyeeeey;;TTTTpTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTjjjjjwwpppppppjjjppppppppp....jssssssssssseessse.eeeeeewwerr....ttyyyjjssssssswwwXX',
  'XXwwwwwwwss;;;;;;;;;;;ww;;;;;;;;;;;;;;;;;eee;;;;TTTTpTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTjjwwwppppppppppppppppppppppp..sssssssseeeeeeeee.eeeeeeewwjjttr.ttyttjjsssssswwwwXX',
  'XXWwwwwwwwss;;;;;;;;;;w;;;;;;;;;;;;;;;;;;;;;;;;;TTTTpTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTjwwjppppppppppppppppppppppppp.ssseeeeeeeeeeeeee.eeeeeeeewwwwyy....ttjjssssswwwwwXX',
  'XXWwwwwwwwsss;;;;;;;;;w;;;;;;;;;;;;;;;;;;;;;;;;TTTTTpTTTTTTTTTTTTTTTTTTTpppppppppTTTTTTwwwjjppppppppppppppppppppppppe.eeeeeeeeeeeeeeee..eeeeeeeeewwwwy.H...yjjessswwwwwwXX',
  'XXWWwwwwwwwsss;;;;;;www;;;;;;;;;;;;;;;;;;;;;;;;TTTTTpTTTTTTTTTTTTTTTTTppppppppppppTTTTwwTTjpppppppppppppppppppppppppe.eee..............eeeeeeeeeswwwww.....yjjsswwwwwwwwXX',
  'XXWWWwwwwwwwsss;;;;wwww;;;;;;;;;;;;;;;;;;;;;;;TTTTTTpTTTTTTTTTTTTTTTTppppppppppppppTwwwTTTTppppppppppppppppppppppppeeD....eeeeeeeeeeeeeeeeeeeeeeswwwwww..ttyjjswwwwwwwwwXX',
  'XXWWWwwwwwwwwsss;;;wwww;;;;;;;;;;;;;;;;;;;;;;;TTTTTTpTTTTTTTTTTTTTTTTpppppppppppppwwwTTTTTTpppppppppppppppppppppppeeeeeeeeeeeeeesssseeeeeeeeeeessjwwwwww.ttywwwwwwwwwwwwXX',
  'XXWWWWwwwwwwwwsss;;wwww;;;;;;;;;;;;;;;;;;;;;;TTTTTTTpTTTTTTTTTTTTTTTTppppppppppppbwTTTTTTTTTpppppppppppppppppppppeeeeeeeeeeeeesssssssssssseeeeessjjwwwwwwwwwwwwwwwwwwwWWXX',
  'XXWWWWWwwwwwwwwssswwww;;;;;;;;;;;;;;;;;;;;;;;TTTTTTTpTTTTTTTTTTTTTTTTppppppppppwwwpTTTTTTTTTTppppppppppppppppppppeeeeeeeeeeeesssswwwwssssssssssssjjjwwwwwwwwwwwwwwwwwWWWXX',
  'XXWWWWWWwwwwwwwwwswwww;;;;;;;;;;;;;;;;;;;;;;;TTTTTTTpTTTTTTTTTTTTTTTTpppppppppwwpppppTTTTTTTTpppppppppppppppppppeeeeeeeeeeesssswwwwwwwwwwwwssswwwwwwwwwwwwwwwwwwwwwWWWWWXX',
  'XXWWWWWWWwwwwwwwwwwwwwss;;;;;;;;;;;;;;;;;;;;TTTTTTTTpTTTTTTTTTTTTTTTTTTTpwwwwwwppppppppTTTTTTTjjpppppppppppppppeeeeeeeeeessssswwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwWWWWWWWXX',
  'XXWWWWWWWWwwwwwwwwwwwssss;;;;;;;;;;;;;;;;;;;TTTTTTTTpTTTTTTTTTTTTTTTTTTwwwwwwpVppppppppppTTTTTTjppppppppppppppeeeeeesssssssswwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwWWWWWWWWWXX',
  'XXWWWWWWWWWwwwwwwwwwwwwsss;;;;;;;;;;;;;;;;;TTTTTTTTTpTTTTTTTTTTTTTTTwwwwwwwwwppppppppppppppTTTTTpjppppppppppppeesssssssssswwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwWWWWWWWWWWXX',
  'XXWWWWWWWWWWWwwwwwwwwwwwss;;;;;;;;;;;;;;;;;TTTTTTTTTpTTTTTTTTTTTTTwwwwwwwwwwpppppppppppppppppppppjjppppppppppesssssssswwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwWWWWWWWWWWWWXX',
  'XXWWWWWWWWWWWWwwwwwwwwwwss;;;;;;;;;;;;;;;;;TTTTTTTTTpTTTTTTTTTTwwwwwwwwwwwpppppppppppppppppppppTTjjpppppppppsssssswwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwWWWWWWWWWWWWWWWWWWWXX',
  'XXWWWWWWWWWWWWWwwwwwwwwwsss;;;;;;;;;;;;;;;TTTTTTTTTepTTTTTTTTwwwwwwwwwwTTpppppppppppppppppppppppTTjppppppppssssswwwwwwwwwwwwwwwwwwwwwwwWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWXX',
  'XXWWWWWWWWWWWWWWWwwwwwwwwss;;;;;;;;;;;;;;;TTTTTTTTTTpTTTTTwwwwwwwwwwwTTTTppppppppppppppp;;;pppppTTTppppppssssswwwwwwwwwwwwwwwwwwwwwwwwWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWXX',
  'XXWWWWWWWWWWWWWWWWwwwwwwwss;;;;;;;;;;;;;;TTTTTTTTTTTpTTTwwwwwwwwwwTTTTTTppppppppppppppp;;;;;;ppppTTpssssssssswwwwwwwwwwwwwwwwwwwwwwwWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWXX',
  'XXWWWWWWWWWWWWWWWWWwwwwwwwss;TT;;;;;;;;;;TTTTTTTTTTTZTwwwwwwwwwwTTTTTTTTppppppppppppppp;;;;;;pppssssssssssswwwwwwwwwwwwwwwwwwwwwwwWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWXX',
  'XXWWWWWWWWWWWWWWWWWWwwwwwwwssTT;;;;;;;;;;TTTTTTTTTTTwwwwwwwwwTTTTTTTTTTTTppppppppppppp;;;;;;;sssssssssssswwwwwwwwwwwwwwwwwwwwwwwWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWXX',
  'XXWWWWWWWWWWWWWWWWWWwwwwwwwwsss;;;;;;;;;TTTTTTTTTTTwwwwwwwwTTTTTTTTTTTTTTppppppppppppp;;;;;;ssssssssswwwwwwwwwwwwwwwwwwwwwwwWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWXX',
  'XXWWWWWWWWWWWWWWWWWWWwwwwwwwwsss;;;;;;;;TTTTTTTTTTwwwwwwwTTTTTTTTTTTTTTTTTppppppppppppp;;ppssswwwwwwwwwwwwwwwwwwwwwwwwwWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWXX',
  'XXWWWWWWWWWWWWWWWWWWWWwwwwwwwwwsss;;;;;TTTTTTTTTwwwwwwwTTTTTTTTTTTTTTTTTTTTppppppppppppppsssswwwwwwwwwwwwwwwwwwwwwwWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWXX',
  'XXWWWWWWWWWWWWWWWWWWWWWwwwwwwwwwwsss;;;TTTTTTTTTwwwwwwTTTTTTTTTTTTTTTTTTTTTTpppppppppppsssswwwwwwwwwwwwwwwwwwwwwWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWXX',
  'XXWWWWWWWWWWWWWWWWWWWWWWwwwwwwwwwwwssssssTTTTTTTwwwwwTTTTTTTTTTTTTTTTTTTTTTTppppppppssssswwwwwwwwwwwwwwwwwwwwwWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWXX',
  'XXWWWWWWWWWWWWWWWWWWWWWWWWwwwwwwwwwwwwsssssTTTTTwwwTTTTTTTTTTTTTTTTTTTTTTTTTppppppsssswwwwwwwwwwwwwwwwwwwwwwWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWXX',
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
  // ═══ v2 ONLY: the railway and its bridges ═══
  // The redesigned moor runs a line east from Gearford and crosses three rivers.
  // v1 had one bridge cell and no rail at all, so neither had a glyph.
  r: { tile: TileCode.RAIL },
  b: { tile: TileCode.BRIDGE },
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
   * ═══════════════════════════════════════════════════════════════════════════
   * THE COLD NORTH AND THE BURNT SCAR.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `n`ow, `i`ce, cold `f`orest, `a`sh. Four glyphs for country the redesign
   * authored and this build had no code for: the import resolved 1,107 cells to
   * the nearest existing tile, so the frozen sea drew as canal, the snowfield as
   * plains, the cold forest as ordinary trees and the charred scar as heath.
   *
   * EACH ONE IS WALKABLE EXACTLY WHERE ITS FALLBACK WAS, which is what keeps
   * this a repaint rather than a redesign — see `TileCode.SNOWFIELD`.
   */
  n: { tile: TileCode.SNOWFIELD },
  i: { tile: TileCode.FROZEN_WATER },
  f: { tile: TileCode.COLD_FOREST },
  a: { tile: TileCode.CHARRED },
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
    // THE OTHER CALL SITE. `makeRedaction` was given this first and shipping
    // only that half would have handed Alderbrook's realm an empty array —
    // every region caption on the map players actually start on, gone, to fix a
    // hard-coded constant that was producing exactly the right answer for it.
    regions: ALDERBROOK_REGIONS,
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
  /**
   * A FROZEN SEA IS STILL A SEA TO A FIGHT. `Ground.Fen` is defined by the one
   * property this shares exactly — "WATER STOPS A BODY AND NOT AN EYE" — and
   * `FROZEN_WATER` is solid and transparent for the same reason open water is.
   * Left out, the frozen coast fought like open moor.
   */
  TileCode.FROZEN_WATER,
]);

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * EVERY KIND OF FOREST, AS A SET — BECAUSE IT WAS AN EQUALITY.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `groundAt` counted wood with `code === TileCode.TREES`, which was complete
 * exactly as long as there was one forest. The cold north added a second, and
 * 257 cells of it classified as open grass: an ambush among the frozen pines
 * played like one in a field, and `makeArena` builds the room you fight in FROM
 * this answer.
 *
 * The same shape as `HAUNTS` missing the new codes and `blocksSight`'s
 * hand-written water chain, both of which fired in the commit that added them.
 * A single equality is a set with one member and no room to grow.
 */
const WOOD: ReadonlySet<number> = new Set<number>([TileCode.TREES, TileCode.COLD_FOREST]);

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
      else if (WOOD.has(code)) wood += 1;
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
  /**
   * WHERE THE LABEL GOES, and it is an anchor rather than a box.
   *
   * v1 modelled country as twelve rectangles that had to TILE, and the note that
   * used to sit here explained at length why bands were safer than a bag of
   * boxes: a gap between two rectangles is a nameless strip that announces
   * itself over and over on one border where nobody is looking.
   *
   * The redesigned moor is not rectangular. Its regions are drawn per cell —
   * *"irregular per-cell regions; seed is label anchor, not a rectangle"* — and
   * the bounding boxes overlap so heavily that one spans x 5 to 157 and another
   * fills 17% of its own box. Rectangles would name the wrong country across
   * most of the map, which is worse than the seam they were protecting against.
   *
   * So the SHAPE lives in `ALDERBROOK_REGION_ROWS`, one character per cell, and
   * this is only the point a label is drawn at. A gap is now unrepresentable for
   * a better reason than before: every cell holds exactly one index, because
   * there is nowhere else for it to hold anything.
   */
  readonly x: number;
  readonly y: number;
};

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHICH COUNTRY EACH CELL IS IN. ONE CHARACTER PER CELL, LIKE THE TILES.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `0` is unregioned — the open sea and the eroded border, which are not
 * anywhere. `1`-`c` index `REGION_NAMES`.
 *
 * Generated by `tools/import-overworld-v2.mjs` from the redesign's own region
 * layer, in the same row form the tiles use, so the two can be read against each
 * other by eye.
 */
/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHICH COUNTRY A SENTENCE IS ABOUT, IF ANY. The other half of a rumour.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The townsfolk already name real places — every rumour in
 * `content/townsfolk.ts` points at a region that exists, which was checked
 * against this table rather than assumed. What was missing is that NAMING a
 * place did nothing: a player was told there is a stair out on the Bracken
 * Waste and had no more idea where the Bracken Waste is than before they asked.
 *
 * This is what lets the answer mark the map. ToME's town NPCs do exactly this
 * — you are told where the Trollmire is and then it is ON the map — and it is
 * the difference between flavour and a direction.
 *
 * ═══ LONGEST MATCH WINS, AND THAT IS NOT PEDANTRY ═══
 * `Alderbrook Common` contains `Alderbrook`, and a shortest-match rule would
 * send somebody asking about the Common to the town of the same name. Sorting
 * by length and taking the first hit is one line and removes the whole class.
 *
 * PURE, like everything here: a string in, a table lookup out, no state.
 */
export function regionNamedIn(text: string): Region | undefined {
  let best: Region | undefined;
  for (const region of ALDERBROOK_REGIONS) {
    if (!text.includes(region.name)) continue;
    if (best === undefined || region.name.length > best.name.length) best = region;
  }
  return best;
}

const ALDERBROOK_REGION_ROWS: readonly string[] = [
  'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
  'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
  'cccccccccccccccc55555555555555555555555555111111111111111111111ccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
  'ccccccccccccccc55555555555555555555555555511111111111111111111111ccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
  'cccccccc555cc55555555555555555555555555555511111111111111111111111cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
  'ccccccc5555555555555555555555555555555555555111111111111111111111111cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
  'cccccc555555555555555555555555555555555555551111111111111111111111111ccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
  'ccccc55555555555555555555555555555555555555551111111111111111111111111cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
  'ccccc555555555555555555555555555555555555555551111111111111111111111111ccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
  'ccccc55555555555555555555555555555555555555555511111111111111111111111111ccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
  'ccccc555555555555555555555555555555555555555555111111111111111111111111111cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
  'ccccc5555555555555555555555555555555555555555555111111111111111111111111111cccccccccccccccccccccccccccccccccccccccccc222cccccccccccccccccccccccccccccccccccccccccccccccccc',
  'ccccc555555555555555555555555555555555555555555551111111111111111111111111111111111111111111cccccccccccccccccccccccc22222ccccccccccccccccccccccccccccccccccccccccccccccccc',
  'cccc5555555555555555555555555555555555555555555551111111111111111111111111111111111111111111111111ccccccccccccccccc2222222cccccccccccccccccccccccccccccccccccccccccccccccc',
  'cccc5555555555555555555555555555555555555555555555111111111111111111111111111111111111111111111111111111111ccccccc442222222ccccccccccccccccccccccccccccccccccccccccccccccc',
  'ccc555555555555555555555555555555555555555555555555111111111111111111111111111111111111111111111111111111111444444444222222ccccccccccccccccccccccccccccccccccccccccccccccc',
  'ccc555555555555555555555555555555555555555555555555111111111111111111111111111111111111111111111111111111111444444444422222ccccccccccccccccccccccccccccccccccccccccccccccc',
  'cc555555555555555555555555555555555555555555555555551111111111111111111111111111333311111111111111111111111444444444444222cccccccccccccccccccccccccccccccccccccccccccccccc',
  'cc5555555555555555555555555555555555555555555555555551111111111111111111111113333333131111111111111111111144444444444444444ccccccccccccccccccccccccccccccccccccccccccccccc',
  'cc55555555555555555555555555555533333355555555555555511111111111111111111133333333333333331111111111111144444444444444444444cccccccccccccccccccccccccccccccccccccccccccccc',
  'cc555555555555555555555555555533333333333355555555555511111111111111111133333333333333333333333111111114444444444444444444444ccccccccccccccccccccccccccccccccccccccccccccc',
  'cc5555555555555555555555553333333333333333355555555555511111111111111333333333333333333333333333333311144444444444444433344444cccccccccccccccccccccccccccccccccccccccccccc',
  'cc555555555555555555555333333333333333333335555555555555111111111133333333333333333333333333333333333333444443333333333333444444cccccccccccccccccccccccccccccccccccccccccc',
  'cc55555555555555555333333333333333333333333555555333355511111113333333333333333333333333333333333333333333333333333333333334444444cccccccccccccccccccccccccccccccccccccccc',
  'cc55555555555555333333333333333333333333333355553333333331113333333333333333333333333333333333333333333333333333333333333333344444444ccccccccccccccccccccccccccccccccccccc',
  'cc5555555555533333333333333333333333333333335555333333333333333333333333333333333333333333333333333333333333333333333333333333344444444cccccc22222cccccccccccccccccccccccc',
  'cc555555555333333333333333333333333333333333555533333333333333333333333333333333333333333333333333333333333333333333333333333333444244444cc222222222cccccccccccccccccccccc',
  'cc55555553333333333333333333333333333333333355553333333333333333333333333333333333333333333333333333333333333333333333333333333334222444444c22222222cccccccccccccccccccccc',
  'cc555553333333333333333333333333333333333333355533333333333333333333333333333333333333333333333333333333333333333333333333333333322222244444444222222ccccccccccccccccccccc',
  'cc555533333333333333333333333333333333333333355533333333333333333333333333333333333333333333333333333333333333333333333333333333222222222444444422222ccccccccccccccccccccc',
  'ccc55533333333333333333333333333333333333333355533333333333333333333333333333333333333333333333333333333333333333333333333333344422222222444444442222ccccccccccccccccccccc',
  'ccc55533333333333333333333333333333333333333355553333333333333333333333333333333311111133333333333333333333333333333333333334444422222222244444442222ccccccccccccccccccccc',
  'cccc553333333333333333333333333333333333333335555333333333333333333333333333333311111111444333333333333333333333333333333344444444222222222444444422222ccccccccccccccccccc',
  'ccccc5533333333333333333333333333333333333333555533333333333333333333333333333661111111444444333333333333333333333333334444444444442222222222444443222222ccccccccccccccccc',
  'ccccc555333333333333333333333333333333333333355553333333333333333333333333333666611114444444444443333333333333333334444444444444444422222222244433333222222ccccccccccccccc',
  'cccccc5533333333333333333333333333333333333335555533333333333333333333333336666666664444444444444444433333333344444444444444444444442222222224442233333222277ccccccccccccc',
  'ccccccc5533333333333333333333333335555533333355555333333333333333333333336666666666644444444444444444444444444444444444444444444444442222222244427733333322777cccccccccccc',
  'ccccccc55533333333333333333333335555555555335555553333333333333333333366666666666666644444444444444444444444444444444444444444444444442222277444777773333337777ccccccccccc',
  'cccccccc55333333333333333333335555555555555555555533333333333333333666666666666666666444444444444444444444444444444444444444444444444477777774444777773333337777cccccccccc',
  'cccccccc55333333333333333333555555555555555555555553333333333333366666666666666666666644444444444444444444444444444444444444444444444777777777444777777733337777cccccccccc',
  'cccccccc553333333333333333355555555555555555555555566333333333666666666666666666666666444444444444444444444444444444444444444444444447777777774447777777733777777ccccccccc',
  'ccccccc55333333333333333355555555555555555555555555666666666666666666666666666666666666444444444444444444444444444444444444444444444777777777777777777777777777777cccccccc',
  'ccccccc5333333333333335555555555555555555555555555566666666666666666666666666666666666644444444444444444444444444444444444444444444777777777777777777777777777777777cccccc',
  'cccccc553333333333335555555555555555555555555555556666666666666666666666666666666666666644444444444444444444444444444444444444444447777777777777777777777777777777777ccccc',
  'cccccc5533333333335555555555555555555555555555555666666666666666666666666666666666666666444444444444444444444444444444444444444444777777777777777777777777777777777777cccc',
  'ccccc555533333335555555555555555555555555555555556666666666666666666666666666666666666664444444444444444444444444444444444444444477777777777777777777777777777777777777ccc',
  'ccccc5555555555555555555555555555555555555555555666666666666666666666666666666666666666669444444444444444444444444444444444444444777777777777777777777777777777777777777cc',
  'cccc55555555555555555555555555555555555555555556666666666666666666666666666666666666666699999994444444444444444444444444444444447777777777777777777777777777777777777777cc',
  'ccc555555555555555555555555555555555555555555556666666666666666666666666666666666666666699999999999444444444444444444444444444447777777777777777777777777777777777777777cc',
  'ccc555555555555555555555555555555555555555555566666666666666666666666666666666666666666999999999999999944444444444444444444444477777777777777777777777777777777777777777cc',
  'cc8888888555555555555555555555555555555555555566666666666666666666666666666666666666666999999999999999999994444444444444444444777777777777777777777777777777777777777777cc',
  'cc8888888888888888888888888855555555555555555666666666666666666666666666666666666666666999999999999999999999999944444444444447777777777777777777777777777777777777777777cc',
  'cc8888888888888888888888888885555555555555555666666666666666666666666666666666666666666999999999999999999999999999994444444447777777777777777777777777777777777777777777cc',
  'cc8888888888888888888888888888555555555555556666666666666666666666666666666666666666666999999999999999999999999999999999444477777777777777777777777777777777777777777777cc',
  'cc8888888888888888888888888888888855555555556666666666666666666666666666666666666666669999999999999999999999999999999999999977777777777777777777777777777777777777777777cc',
  'cc8888888888888888888888888888888888888855566666666666666666666666666666666666666666669999999999999999999999999999999999999977777777777777777777777777777777777777777777cc',
  'cc8888888888888888888888888888888888888888866666666666666666666666666666666666666666699999999999999999999999999999999999999977777777777777777777777777777777777777777777cc',
  'cc8888888888888888888888888888888888888888886666666666666666666666666666666666666666699999999999999999999999999999999999999997777777777777777777777777777777777777777777cc',
  'cc8888888888888888888888888888888888888888886666666666666666666666666666666666666666699999999999999999999999999999999999999997777777777777777777777777777777777777777777cc',
  'cc8888888888888888888888888888888888888888888666666666666666666666666666666666666666999999999999999999999999999999999999999997777777777777777777777777777777777777777777cc',
  'cc8888888888888888888888888888888888888888888666666666666666666666666666666666666666999999999999999999999999999999999999999997777777777777777777777777777777777777777777cc',
  'cc8888888888888888888888888888888888888888888666666666666666666666666666666666666669999999999999999999999999999999999999999999777777777777777777777777777777777777777777cc',
  'cc888888888888888888888888888888888888888888886666666666666666666666666666666666666999999999999999999999999999999999999999999bbb7777777777777777777777777777777777777777cc',
  'ccc88888888888888888888888888888888888888888886666666666666666666666666666666666666999999999999999999999999999999999999999999bbbbbb7777777777777777777777777777777777777cc',
  'ccc8888888888888888888888888888888888888888888866666666666666666666666666666666666999999999999999999999999999999999999999999bbbbbbbbbbbb77777777777777777777777777777777cc',
  'cccc88888888888888888888888888888888888888888886666666666666666666666666666666666699999999999999999999999999999999999999999bbbbbbbbbbbbbbb777777777777777777777777777777cc',
  'cccc88888888888888888888888888888888888888888888666666666666666666666666666aaaaaaaa9999999999999999999999999999999999999999bbbbbbbbbbbbbbbb77bb7777777777777777777777777cc',
  'ccccc888888888888888888888888888888888888888888866666666666666666666aaaaaaaaaaaaaaa999999999999999999999999999999999999999bbbbbbbbbbbbbbbbbbbbbbbbbbbbb77777777777777777cc',
  'cccccc8888888888888888888888888888888888888888888666666666666aaaaaaaaaaaaaaaaaaaaaaa9999999999999999999999999999999999999bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbcc',
  'ccccccc88888888888888888888888888888888888888888866666aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa999999999999999999999999999999999999bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbccc',
  'ccccccc888888888888888888888888888888888888888888aaa6aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa9999999999999999999999999999999999bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbcccc',
  'cccccccc88888888888888888888888888888888888888888aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa999999999999999999999999999999999bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbcccc',
  'cccccccc8888888888888888888888888888888888888888aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa9999999999999999999999999999999bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbccccc',
  'ccccccccc888888888888888888888888888888888888888aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa999999999999999999999999999999bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbcccccc',
  'cccccccccc88888888888888888888888888888888888888aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa99999999999999999999999999999bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbccccccc',
  'cccccccccc8888888888888888888888888888888888888aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa999999999999999999999999999bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbcccccccc',
  'ccccccccccc888888888888888888888888888888888888aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa99999999999999999999999999bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbcccccccccc',
  'cccccccccccc8888888888888888888888888888888888aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa999999999999999999999999bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbccccccccccc',
  'ccccccccccccc888888888888888888888888888888888aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa99999999999999999999999bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbcccccccccccccc',
  'cccccccccccccc8888888888888888888888888888888aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa999999999999999999999bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbccccccccccccccccc',
  'ccccccccccccccc888888888888888888888888888888aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa99999999999999999999bbbbbbbbbbbbbbbbccccbbbbbbbbbbbbbbbbccccccccccccccccccccc',
  'ccccccccccccccccc8888888888888888888888888888aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa9999999999999999999bbbbbbbbbbbbbbbccccccccccccbbbcccccccccccccccccccccccccccc',
  'ccccccccccccccccccc8888888888888888888888888aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa99999999999999999bbbbbbbbbbbbbbbcccccccccccccccccccccccccccccccccccccccccccc',
  'ccccccccccccccccccccc88888888888888888888888aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa999999999999999bbbbbbbbbbbbbbcccccccccccccccccccccccccccccccccccccccccccccc',
  'ccccccccccccccccccccccc88888888888888888888aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa99999999999999bbbbbbbbbbbbcccccccccccccccccccccccccccccccccccccccccccccccc',
  'cccccccccccccccccccccccc8888888888888888888aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa9999999999999bbbbbbbbbcccccccccccccccccccccccccccccccccccccccccccccccccccc',
  'cccccccccccccccccccccccc8888888888888888888aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa99999999999bbbbbbcccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
  'cccccccccccccccccccccccc888888888888888888aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa999999999bbbbbcccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
  'ccccccccccccccccccccccccc88888888888888888aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa9999999bbbbcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
  'ccccccccccccccccccccccccc8888888888888888aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa9999999bbbccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
  'cccccccccccccccccccccccccc888888888888888aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa999999bccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
  'ccccccccccccccccccccccccccc88888888888888aaaaaaaaaaacccccaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa9999ccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
  'cccccccccccccccccccccccccccc888888888888aaaaaaaaaaaccccccaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
  'ccccccccccccccccccccccccccccc88888888888aaaaaaaaaacccccccaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaacccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
  'ccccccccccccccccccccccccccccccc88888888aaaaaaaaaaccccccaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
  'ccccccccccccccccccccccccccccccccc888888aaaaaaaaaccccccaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
  'ccccccccccccccccccccccccccccccccccc8888aaaaaaaaaccccccaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
  'ccccccccccccccccccccccccccccccccccccccaaaaaaaaaccccccccaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaacccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
  'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
  'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
];

/** Index -> name. Index 0 is deliberately absent: unregioned ground has none. */
const REGION_NAMES: readonly string[] = [
  '',
  'the Cold Furrows',
  'the Saintswood',
  'the Kettle Range',
  'Kettleflat',
  'the Grey Downs',
  'the Bracken Waste',
  'Ashwick Reach',
  'the Sedge',
  'Alderbrook Common',
  'the Blackwater Wood',
  'the Long Strand',
  'the Drowned Coast',
];

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHICH MOOR THIS IS. A SAVE THAT WALKED A DIFFERENT ONE CANNOT KEEP ITS FOG.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Fog is a bitset indexed by CELL, and the redesigned moor is the same 170x100
 * with entirely different country in it. A v1 save loaded against it would paint
 * explored patches over places that player has never been and hide places they
 * have — the coordinates still resolve, which is precisely what makes it
 * dangerous. The art handoff says so in as many words: *"the world has the same
 * dimensions as v1, which makes coordinate reuse deceptively unsafe."*
 *
 * So the map carries its own identity and the save carries a copy. They disagree
 * exactly once per player, on the first load after a redesign, and the fog is
 * dropped rather than trusted.
 *
 * CHANGE THIS WHENEVER THE ROWS CHANGE. It is the one line standing between a
 * new world and every existing player seeing a map of the old one.
 */
export const LAYOUT_REVISION = 'alderbrook-moor-art-v2.0.0';

const REGION_CHARS = '0123456789abc';

/**
 * The twelve names, each with the cell its label is drawn at.
 *
 * ORDERED BY INDEX, so `REGION_NAMES[i + 1]` and `ALDERBROOK_REGIONS[i]` are the
 * same country and a reader can check one against the other without a lookup.
 */
export const ALDERBROOK_REGIONS: readonly Region[] = [
  { name: 'the Cold Furrows', x: 84, y: 12 },
  { name: 'the Saintswood', x: 142, y: 25 },
  { name: 'the Kettle Range', x: 79, y: 27 },
  { name: 'Kettleflat', x: 111, y: 37 },
  { name: 'the Grey Downs', x: 30, y: 39 },
  { name: 'the Bracken Waste', x: 65, y: 53 },
  { name: 'Ashwick Reach', x: 146, y: 54 },
  { name: 'the Sedge', x: 24, y: 67 },
  { name: 'Alderbrook Common', x: 103, y: 63 },
  { name: 'the Blackwater Wood', x: 70, y: 81 },
  { name: 'the Long Strand', x: 139, y: 78 },
  { name: 'the Drowned Coast', x: 86, y: 97 },
];

/**
 * Every named region holds ground, and every label sits inside its own country.
 *
 * AT MODULE LOAD, for the reason the tiling check it replaces gave: the failure
 * is invisible in a screenshot of anything but the exact border it happens on.
 * The property is different now — a per-cell map cannot have gaps — so what is
 * checked is what CAN still go wrong: a name with no cells behind it, and a
 * label drawn over somebody else's country.
 */
function assertRegionsHoldGround(): void {
  const w = ALDERBROOK.view.w;
  const h = ALDERBROOK.view.h;
  if (ALDERBROOK_REGION_ROWS.length !== h) {
    throw new Error(
      `region rows: ${String(ALDERBROOK_REGION_ROWS.length)} rows for a map ${String(h)} tall`,
    );
  }
  const counts = new Array<number>(REGION_NAMES.length).fill(0);
  for (let y = 0; y < h; y += 1) {
    const row = ALDERBROOK_REGION_ROWS[y] ?? '';
    if (row.length !== w) {
      throw new Error(`region row ${String(y)} is ${String(row.length)} wide, want ${String(w)}`);
    }
    for (let x = 0; x < w; x += 1) {
      const i = REGION_CHARS.indexOf(row[x] ?? '0');
      if (i < 0)
        throw new Error(`region row ${String(y)} has an unknown character at ${String(x)}`);
      counts[i] = (counts[i] ?? 0) + 1;
    }
  }
  for (let i = 1; i < REGION_NAMES.length; i += 1) {
    if ((counts[i] ?? 0) > 0) continue;
    throw new Error(`region "${String(REGION_NAMES[i])}" has no ground behind its name`);
  }
  for (const region of ALDERBROOK_REGIONS) {
    if (regionAt(region.x, region.y) === region.name) continue;
    throw new Error(`the label for "${region.name}" sits on "${regionAt(region.x, region.y)}"`);
  }
}

/**
 * What this cell's country is called, or the moor when it has no name.
 *
 * ONE INDEX AND ONE STRING LOOKUP, where the rectangle model scanned a dozen
 * boxes. Off the map answers a name rather than crashing inside somebody's move,
 * which is the same answer it always gave.
 */
export function regionAt(x: number, y: number): string {
  const row = ALDERBROOK_REGION_ROWS[y];
  if (row === undefined) return 'the moor';
  const i = REGION_CHARS.indexOf(row[x] ?? '0');
  if (i <= 0) return 'the moor';
  return REGION_NAMES[i] ?? 'the moor';
}

assertRegionsHoldGround();
