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
// ALDERBROOK — THE OVERWORLD
// ===========================================================================

/**
 * The city, 64x48, hand-authored and machine-verified.
 *
 * WHY 64x48 AND NOT LARGER. The camera shows at most 48x32 cells (canvas.ts
 * MAX_TILES_*), so this is a bit over one screen in each direction: big enough
 * that Alderbrook is a place you cross, small enough that six people in a voice
 * channel keep running into each other. That second property is the entire
 * point of a shared overworld and it is the first thing a bigger map costs.
 *
 * WHY IT IS AUTHORED DATA RATHER THAN GENERATED AT BOOT. The same argument
 * TEST_LEVEL_ROWS makes, for a stronger reason: a generator underneath the
 * overworld would put a second unproven system beneath the realm plumbing being
 * proven, and "the party ended up in the canal" would be indistinguishable from
 * a generation bug. Procedural INNER-worlds are still the plan; the city is not
 * one of them, because a city you cannot learn is not a city.
 *
 * HOW IT WAS VERIFIED. 3,072 cells is well past what anyone can eyeball for the
 * one mistake that matters — a district that cannot be walked to. The layout was
 * built from districts and streets and then flood-filled from the office with
 * corner-cutting enabled (which is what world.ts:852-856 allows), proving all
 * 8 sites reachable and 0 of 1,784 walkable cells marooned. That check is
 * test/shared/overworld.test.ts, which re-runs it on every commit rather than
 * asking anyone to trust this comment.
 */
const ALDERBROOK_ROWS: readonly string[] = [
  'XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
  'XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
  'XXTTTTTTTT..;TT;;;....................................XXXXXXXXXX',
  'XXTTTTTTT;..TT;;;T........................####.####...XXXXXXXXXX',
  'XXTTTTTT;;..T;;;TT........................####.####...XX""""XXXX',
  'XX......................................................"A""..XX',
  'XX;;TT;;;;..;;TT;;........................####.####...XX""""XXXX',
  'XX;TT;;;;B..;TT;;;......,,,,,,,..,,,,,,,..............XXX.XXXXXX',
  'XXTT;;;;;;..;T;;;T......,,,,,,,..,,,,,,,..####.####...XXX.XXXXXX',
  'XXT;;;;;;;..;;;;TT......,,,,,,,..,,,,,,,..####.####...##..###.XX',
  'XX;;;TT;;;..;;;TT;......,,,CCCC..,CCCC,,..####.####...##.####.XX',
  'XX;;TT;;;T..;;TTTT......,,,CCCC..,CCCC,,..####.####...##.####.XX',
  'XX;TT;;;TT..;TTTTT......,,,CCCC..,CCCC,,......................XX',
  'XXTT;;;TT;..TTTTTT......,,,,,,,..,,,,,,,..####.R###...##.####.XX',
  'XXT;;;TT;;..T;TTTT......,,,,,,,""",,,,,,..####.####...##.####.XX',
  'XX............................."O"............................XX',
  'XX.####.##...####.####..,,,,,,,""",,,,,,..####.####...##.####.XX',
  'XX.####.##...####.####..,,,CCCC..,CCCC,,......................XX',
  'XX.####.##..H####.####..,,,CCCC..,CCCC,,..####.####...##.####.XX',
  'XX.####.##...####.####..,,,CCCC..,CCCC,,..####.####...##.####.XX',
  'XX......................,,,,,,,..,,,,,,,..####.####...##.####.XX',
  'XX.####.##...####.####..,,,,,,,..,,,,,,,..####.####...##.####.XX',
  'XX.####.##...####.####..,,,,,,,..,,,,,,,......................XX',
  'XX.####.##...####.####....................####.####...##.####.XX',
  'XX............................................................XX',
  'XX........................................####.####...##.####.XX',
  'XXwwwwwwww==wwwwwwwwwwwwwwwwwww==wwwwwwwwwwwwwwwwwww==wwwwwwwwXX',
  'XXwwwwwwww==wwwwwwwwwwwwwwwwwww==wwwwwwwwwwwwwwwwwww==wwwwwwwwXX',
  'XXwwwwwwww==wwwwwwwwwwwwwwwwwww==wwwwwwwwwwwwwwwwwww==wwwwwwwwXX',
  'XXwwwwwwww==wwwwwwwwwwwwwwwwwww==wwwwwwwwwwwwwwwwwww==wwwwwwwwXX',
  'XX...............................~~~~~~~~~~~~~~~~~~~.~~~~~~~~~XX',
  'XX...............................~~KKKK~~KKKK~~KKKK~.KKKK~~KKKXX',
  'XX...............................~~KKKK~~KKKK~~KKKK~.KKKK~~KKKXX',
  'XX............................................................XX',
  'XX...,,,,,.,,,,,,,,,,,,,,,,......~~~~~~~~~~~~F~~~~~~.~~~~~~~~~XX',
  'XX...,,,,,.,,,,,,,,,,,,,,,,......~~~~~~~~~~~~~~~~~~~.~~~~~~~~~XX',
  'XX...,,,CC.CC,,,,,CCCCC,,,,......~~KKKK~~KKKK~~KKKK~.KKKK~~KKKXX',
  'XX...,,,CC.CC,,,,,CCCCC,,,,......~~KKKK~~KKKK~~KKKK~.KKKK~~KKKXX',
  'XX...,,,CC.CC,,,,,CCCCC,,,,......+++++++++++++++++++.+++++++++XX',
  'XX...,,,CC.CC,,,,,CCCCC,,,,......+++++++++++++++++++.+++++++++XX',
  'XX...,,,,,.,,,,G,,,,,,,,,,,......~~~~~~~~~~~~~~~~~~~.~~~~~~~~~XX',
  'XX............................................................XX',
  'XX...,,,CC.CC,,,,,CCCCC,,,,......~~KKKK~~KKKK~~KKKK~.KKKK~~KKKXX',
  'XX...,,,CC.CC,,,,,CCCCC,,,,......~~KKKK~~KKKK~~KKUK~.KKKK~~KKKXX',
  'XX...,,,CC.CC,,,,,CCCCC,,,,......~~~~~~~~~~~~~~~~~~~.~~~~~~~~~XX',
  'XX............................................................XX',
  'XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
  'XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
];

/**
 * The legend. Every character is a real TileCode; nothing defaults to floor.
 *
 * The SITE glyphs are walkable ground that also opens an inner-world, and each
 * one carries the ground it sits on — an archway in a terrace row is still
 * cobble underfoot. So a site never punches a hole in the terrain layer, and a
 * build with no `tile_ow_site_*` art yet draws a perfectly ordinary street
 * rather than a violet box in the middle of the city.
 */
const ALDERBROOK_LEGEND: Readonly<Record<string, Glyph>> = {
  '.': { tile: TileCode.COBBLE },
  ',': { tile: TileCode.PAVING },
  '"': { tile: TileCode.GREEN },
  '=': { tile: TileCode.BRIDGE },
  '+': { tile: TileCode.RAIL },
  '~': { tile: TileCode.SOOT },
  ';': { tile: TileCode.MIRE },
  w: { tile: TileCode.WATER },
  '#': { tile: TileCode.TERRACE },
  C: { tile: TileCode.CIVIC },
  K: { tile: TileCode.WORKS },
  T: { tile: TileCode.TREES },
  X: { tile: TileCode.ERASED },
  /**
   * The office is the hub, the spawn, and "the one fixed point the Index cannot
   * overwrite" (docs/game-design.md s1). It is the ONLY spawn on the map, which
   * is deliberate: every player starts on the same tile, so the first thing you
   * see when you connect is another player rather than an empty street.
   */
  O: { tile: TileCode.PAVING, spawn: true, site: 'site:office' },
  R: { tile: TileCode.COBBLE, site: 'site:threadneedle_row' },
  H: { tile: TileCode.COBBLE, site: 'site:ashwick_row' },
  B: { tile: TileCode.MIRE, site: 'site:blackwood_outskirts' },
  F: { tile: TileCode.SOOT, site: 'site:gearford_ward' },
  U: { tile: TileCode.SOOT, site: 'site:underworks' },
  G: { tile: TileCode.PAVING, site: 'site:glass_archive' },
  A: { tile: TileCode.GREEN, site: 'site:watchers_altar' },
};

const ALDERBROOK = parseMap(ALDERBROOK_ROWS, ALDERBROOK_LEGEND);

/**
 * A fresh, MUTABLE Alderbrook. Copied per call for the same reason
 * `makeTestLevel` is: one realm changing its map must not appear in another.
 */
export function makeOverworld(): AuthoredMap {
  return {
    view: { w: ALDERBROOK.view.w, h: ALDERBROOK.view.h, tiles: ALDERBROOK.view.tiles.slice() },
    spawns: ALDERBROOK.spawns,
    sites: ALDERBROOK.sites,
  };
}
