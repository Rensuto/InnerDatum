/**
 * The floor behind a door — a different shape for every kind of place.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS
 * ═══════════════════════════════════════════════════════════════════════════
 * All thirteen sites opened onto `makeTestMap` — the same hand-authored 30x30
 * room, every time. Walk into a city, a mine, a drowned chapel or an industrial
 * ward and you got the identical floor plan, which makes the region's thirteen
 * destinations one destination with thirteen doors. Reported from play as the
 * points of interest all being the same.
 *
 * A place's IDENTITY at this scale is its SHAPE. Long straight galleries read
 * as a mine before a single sprite is drawn; an open plaza with blocks in it
 * reads as a town; scattered fragments read as a ruin. So each site kind gets a
 * generator, and the generator is the identity.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * FLOOR AND WALL, AND NOTHING ELSE
 * ═══════════════════════════════════════════════════════════════════════════
 * `TILE_SPRITES` in the renderer deliberately has no entry for either, so every
 * room this produces draws correctly the day it is written — the flat-interior
 * rule paying for itself a second time. Four new layouts cost zero assets.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * CONNECTIVITY IS PROVEN, NOT HOPED FOR
 * ═══════════════════════════════════════════════════════════════════════════
 * Every generator here finishes by carving from the spawn to anything it
 * stranded, so "can the player reach the far side" is a property of the
 * algorithm. A sealed pocket in a hand-authored map is a bug somebody notices;
 * in a generated one it is a bug that appears one run in fifty and cannot be
 * reproduced from a description.
 *
 * PURE, and seeded from shared/rng.ts with labelled draws, so a floor is
 * reproducible from the realm that opened it.
 */

import { tileIndex } from './coords.ts';
import { createRng } from './rng.ts';
import { TileCode } from './protocol.ts';
import { placeVault, stampVault } from './vault.ts';
import { VAULTS_BY_SHAPE } from './vaults.ts';
import type { TileXY } from './coords.ts';
import type { Rng } from './rng.ts';
import type { AuthoredMap } from './level.ts';

/**
 * The shapes a place can take. A site names one; the generator does the rest.
 *
 * Deliberately few. Four distinguishable silhouettes across thirteen sites is
 * variety; thirteen bespoke generators would be thirteen things to keep working
 * and would still be read as "some rooms" by a player walking through them.
 */
export const SiteShape = {
  /** An open plaza with building blocks in it. Towns, markets, settlements. */
  Town: 'town',
  /** Winding galleries. Mines, the Underworks, anything dug. */
  Cave: 'cave',
  /** Mostly open, with broken fragments of wall. Chapels, altars, wreckage. */
  Ruin: 'ruin',
  /** A regular grid of blocks and corridors. Works, archives, anything built. */
  Works: 'works',
} as const;
export type SiteShape = (typeof SiteShape)[keyof typeof SiteShape];

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * HOW FAR FROM THE DOOR ANYTHING IS ALLOWED TO BE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * LARGER THAN THE AMBUSH'S FOUR, deliberately. An ambush is something that
 * happened TO you and opening at four tiles is the point; a delve is somewhere
 * you chose to walk into, and the first thing it owes you is a look at the room
 * before anything is in reach.
 *
 * ═══ IT LIVED IN `server/content/delve.ts` AND ONLY HALF THE CODE KNEW IT ═══
 * The populator dropped every candidate tile within this radius, and the vault
 * placer — which knows exactly where the door is — excluded ONE CELL. So a
 * drawn room could land four tiles from the arrival tile, entirely inside the
 * ring the populator was about to discard, and the room's guard and its share
 * of the litter both fell through to the rest of the floor.
 *
 * Measured over 400 floors a shape before this moved: 206/400 caves and
 * 151/400 works rolled a room that could hold nothing at all, mean footprint
 * centre 5.5 and 7.5 tiles from the door. Half the delves in the game had a
 * hand-drawn chamber in them that paid nothing and defended nothing.
 *
 * `src/shared/` is the only module the map generator and the server's populator
 * can both import, which is what one definition of this requires.
 */
export const DOOR_CLEARANCE = 8;

const W = 34;
const H = 30;
const MARGIN = 1;

type Grid = number[];

function blank(): Grid {
  return new Array<number>(W * H).fill(TileCode.WALL);
}

function put(g: Grid, x: number, y: number, code: number): void {
  if (x < MARGIN || y < MARGIN || x >= W - MARGIN || y >= H - MARGIN) return;
  g[tileIndex(x, y, W)] = code;
}

function at(g: Grid, x: number, y: number): number {
  if (x < 0 || y < 0 || x >= W || y >= H) return TileCode.WALL;
  return g[tileIndex(x, y, W)] ?? TileCode.WALL;
}

function room(g: Grid, x0: number, y0: number, x1: number, y1: number, code: number): void {
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) put(g, x, y, code);
  }
}

/** A straight corridor. The only thing every shape below has in common. */
function corridor(g: Grid, a: TileXY, b: TileXY): void {
  let { x, y } = a;
  while (x !== b.x) {
    put(g, x, y, TileCode.FLOOR);
    x += x < b.x ? 1 : -1;
  }
  while (y !== b.y) {
    put(g, x, y, TileCode.FLOOR);
    y += y < b.y ? 1 : -1;
  }
  put(g, b.x, b.y, TileCode.FLOOR);
}

// ---------------------------------------------------------------------------
// The four shapes
// ---------------------------------------------------------------------------

/**
 * A TOWN: one open plaza, blocks of building standing in it.
 *
 * The blocks are placed on a loose grid and then SHRUNK at random, which is
 * what stops it reading as a chessboard — a settlement is regular enough to
 * have streets and irregular enough that no two are the same.
 */
function town(g: Grid, rng: Rng): TileXY {
  room(g, MARGIN, MARGIN, W - MARGIN - 1, H - MARGIN - 1, TileCode.FLOOR);
  for (let by = 3; by < H - 5; by += 6) {
    for (let bx = 3; bx < W - 5; bx += 7) {
      const w = rng.int('site.town.w', 2, 4);
      const h = rng.int('site.town.h', 2, 3);
      // A gap in the row now and then, so the streets are not a grid.
      if (rng.int('site.town.gap', 0, 9) < 2) continue;
      room(g, bx, by, bx + w, by + h, TileCode.WALL);
    }
  }
  return { x: Math.floor(W / 2), y: H - 3 };
}

/**
 * A CAVE: a walk that wanders and is pulled back, the same shape the ambush
 * arena uses and for the same reason — a walk opens only cells it stood on, so
 * one connected region is a property of the algorithm.
 */
function cave(g: Grid, rng: Rng): TileXY {
  const start: TileXY = { x: Math.floor(W / 2), y: Math.floor(H / 2) };
  let x = start.x;
  let y = start.y;
  const target = Math.floor((W - 2) * (H - 2) * 0.38);
  let open = 0;
  const steps: readonly (readonly [number, number])[] = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];
  for (let i = 0; i < W * H * 30 && open < target; i += 1) {
    // Pulled back to the middle periodically, or the walk drifts into one
    // corner and hollows it out — the exact failure the arena had.
    if (i % 90 === 0) {
      x = start.x;
      y = start.y;
    }
    const step = steps[rng.int('site.cave.step', 0, steps.length - 1)];
    if (step === undefined) continue;
    const nx = x + step[0];
    const ny = y + step[1];
    if (nx < MARGIN || ny < MARGIN || nx >= W - MARGIN || ny >= H - MARGIN) continue;
    x = nx;
    y = ny;
    if (at(g, x, y) !== TileCode.FLOOR) {
      put(g, x, y, TileCode.FLOOR);
      open += 1;
    }
  }
  return start;
}

/**
 * A RUIN: open ground with fragments of wall standing in it.
 *
 * Fragments rather than rooms — short runs, one cell thick, at right angles.
 * A ruin is a building that has mostly stopped being one, and the read comes
 * from the gaps rather than from the walls.
 */
function ruin(g: Grid, rng: Rng): TileXY {
  room(g, MARGIN, MARGIN, W - MARGIN - 1, H - MARGIN - 1, TileCode.FLOOR);
  const fragments = rng.int('site.ruin.count', 14, 22);
  for (let i = 0; i < fragments; i += 1) {
    const x = rng.int('site.ruin.x', 2, W - 3);
    const y = rng.int('site.ruin.y', 2, H - 3);
    const len = rng.int('site.ruin.len', 2, 6);
    const horizontal = rng.int('site.ruin.dir', 0, 1) === 0;
    for (let n = 0; n < len; n += 1) {
      put(g, horizontal ? x + n : x, horizontal ? y : y + n, TileCode.WALL);
    }
  }
  return { x: 2, y: Math.floor(H / 2) };
}

/**
 * WORKS: a regular grid of solid blocks with corridors between them.
 *
 * The only shape here that is deliberately MECHANICAL. Everything built by
 * people who were not thinking about people looks like this, and against the
 * cave and the ruin it reads instantly as somewhere industrial.
 */
function works(g: Grid, rng: Rng): TileXY {
  room(g, MARGIN, MARGIN, W - MARGIN - 1, H - MARGIN - 1, TileCode.FLOOR);
  const cell = rng.int('site.works.pitch', 4, 5);
  for (let by = 2; by < H - 3; by += cell + 1) {
    for (let bx = 2; bx < W - 3; bx += cell + 1) {
      room(g, bx, by, bx + cell - 1, by + cell - 1, TileCode.WALL);
    }
  }
  // One gallery straight through, so the grid has a spine rather than being a
  // uniform lattice a player has to solve.
  const lane = Math.floor(H / 2);
  room(g, MARGIN, lane, W - MARGIN - 1, lane, TileCode.FLOOR);
  return { x: 2, y: lane };
}

/**
 * Carve from the spawn to anything the shape stranded.
 *
 * Flood from the spawn, then run a corridor to the nearest cell of each
 * unreached pocket, repeatedly, until everything walkable is connected. Cheap
 * on a 34x30 grid and it makes "the far side is reachable" true by construction
 * rather than by inspection.
 */
function connect(g: Grid, from: TileXY): void {
  for (let pass = 0; pass < 12; pass += 1) {
    const seen = new Set<number>();
    const stack = [tileIndex(from.x, from.y, W)];
    seen.add(stack[0] ?? 0);
    while (stack.length > 0) {
      const idx = stack.pop();
      if (idx === undefined) break;
      const x = idx % W;
      const y = Math.floor(idx / W);
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const nx = x + dx;
        const ny = y + dy;
        if (at(g, nx, ny) !== TileCode.FLOOR) continue;
        const nIdx = tileIndex(nx, ny, W);
        if (seen.has(nIdx)) continue;
        seen.add(nIdx);
        stack.push(nIdx);
      }
    }

    let orphan: TileXY | null = null;
    for (let y = MARGIN; y < H - MARGIN && orphan === null; y += 1) {
      for (let x = MARGIN; x < W - MARGIN; x += 1) {
        if (at(g, x, y) === TileCode.FLOOR && !seen.has(tileIndex(x, y, W))) {
          orphan = { x, y };
          break;
        }
      }
    }
    if (orphan === null) return;
    corridor(g, from, orphan);
  }
}

/**
 * Build the floor behind one door.
 *
 * `seed` should name the realm, so two parties in the same place get the same
 * floor and a re-entry finds the room it left.
 */
/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT A ROOM IS MADE OF. Two codes, and it is a SUBSTITUTION, not a generator.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Thirteen destinations were one destination with thirteen doors, then `shape`
 * made them four; they were still every one of them the same grey box, because
 * every interior in the game is built out of exactly two tile codes and the
 * player has been looking at those two codes since M1.
 *
 * The palette is applied as a POST-PASS over the finished grid rather than
 * threaded into the carvers, and that is the whole safety argument: the
 * generator runs unchanged, draws the same numbers off the same seeded stream in
 * the same order, and produces the same walkable cells bit for bit. Only the two
 * codes it wrote are renamed on the way out. A room cannot become unreachable by
 * being repainted, and `sitemap.test.ts` asserts exactly that — the walkable
 * index set is identical to the FLOOR/WALL build for every shape and palette.
 *
 * BOTH HALVES CARRY A REAL RULE, checked by that same test rather than trusted:
 * the floor must be `isWalkable` and the wall must not be, or a repaint would
 * quietly change where a body may stand.
 *
 * ═══ WATER WAS TRIED HERE AND MEASURED OUT. DO NOT ADD IT BACK BLIND. ═══
 * The Drowned Chapel is named for a tide — *"the tide took the nave and left the
 * arches"* — and has no water in it, which looks exactly like the broken
 * promises this game has spent a lot of effort fixing. So the fen arena's
 * channel logic was lifted in behind a `channels` palette field and measured
 * with `tools/delve-run.mjs`, solo, 8 runs:
 *
 *     dry (shipped)      8/8 cleared   166 turns   50% low-water
 *     one channel        7/8           206 turns   49%
 *     two channels       6/8           315 turns   48%
 *
 * IT IS NOT THE DAMAGE — the low-water mark barely moves. It is the CHASE. An
 * arena works with water because it is a short fight you are surrounded in; a
 * delve is a floor you have to CLEAR, so one kiting monster on the far bank is a
 * long walk to a ford and back, repeatedly. Removing the cairn and leaving the
 * water still gave 7/8 at 252 turns, so the ranged monster is not the variable
 * either — any kiter behind a cut does this.
 *
 * The Drowned Chapel is seventeen steps from the gate and the first marker most
 * players will ever walk to. Doubling its length and adding a one-in-eight
 * chance of a chase, to make a name literal, is a bad trade. The name stays
 * unfulfilled and that is the smaller cost.
 *
 * AND IT IS FREE. Every code any palette names already has a PNG on disk and a
 * `tileFill` colour — six of them (GREEN, SOOT, RAIL, WORKS, TERRACE, CIVIC) are
 * finished art that until now drew nothing anywhere in the game, because their
 * codes appear on no overworld row and in no interior.
 */
export type SitePalette = {
  readonly floor: TileCode;
  readonly wall: TileCode;
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * WHAT A BLOCK IN THE MIDDLE OF TOWN IS MADE OF, AS OPPOSED TO THE EDGE.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Optional, and absent means "the same as `wall`" — which is what every site
   * did before and is still right for a cave, where the rock at the edge and the
   * rock in the middle are the same rock.
   *
   * IT IS NOT RIGHT FOR A TOWN. Measured on Alderbrook: 1,020 cells, exactly two
   * codes — PAVING 732 and CIVIC 288 — and the outer ring is the SAME CODE as
   * the building blocks inside it. The layout is a real town, streets and all,
   * and a player standing in it cannot tell a house from the edge of the map
   * because they are drawn identically. A player put it as "how hard it is to
   * tell the area im at is a town".
   *
   * Three codes give a town the three things it needs to read as one: a street,
   * a building, and a boundary. All the art already exists.
   */
  readonly roof?: TileCode;
};

/** What every site was, and what a caller that names no palette still gets. */
export const DEFAULT_SITE_PALETTE: SitePalette = {
  floor: TileCode.FLOOR,
  wall: TileCode.WALL,
};

export function makeSiteMap(
  seed: string,
  shape: SiteShape,
  palette: SitePalette = DEFAULT_SITE_PALETTE,
): AuthoredMap {
  const rng = createRng(seed);
  const g = blank();

  const spawn =
    shape === SiteShape.Town
      ? town(g, rng)
      : shape === SiteShape.Cave
        ? cave(g, rng)
        : shape === SiteShape.Ruin
          ? ruin(g, rng)
          : works(g, rng);

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * A ROOM SOMEBODY DREW, DROPPED INTO THE NOISE — see `shared/vault.ts`.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * BEFORE THE THRESHOLD AND BEFORE `connect`, and both halves of that matter.
   *
   * BEFORE `connect` because a vault writes WALLS, and walls can cut a floor in
   * two. `connect` already exists to find orphaned floor and dig a corridor to
   * it — twelve passes of it — so stamping first means the repair pass treats a
   * vault exactly as it treats a cave that generated two chambers. Stamping
   * after it would be the one arrangement that can seal a room permanently.
   *
   * BEFORE the threshold is written, so the arrival tile is restored on the line
   * below whatever the vault did to it. A vault cannot be placed ON the spawn —
   * `isOpen` is false for anything not already floor and the spawn is floor, so
   * it CAN — which is precisely why the threshold is re-asserted afterwards
   * rather than trusted.
   */
  /**
   * ═══ ONE ROOM, DRAWN FROM THE LIST — AND IT USED TO BE ALL OF THEM ═══
   * The first version stamped every vault the shape owned, which meant a works
   * always contained all three and every works was the same works. Upstream
   * rolls for its vaults per level; the variety is meant to be in WHICH room you
   * got, not only in where it landed.
   *
   * THE DRAW IS UNCONDITIONAL, like the two inside `placeVault`: a shape with an
   * empty list (a town) still consumes it, so adding a room to one shape cannot
   * shift the number stream of another.
   */
  const placed: {
    id: string;
    at: { x: number; y: number };
    turn: string;
    w: number;
    h: number;
  }[] = [];
  const forShape = VAULTS_BY_SHAPE[shape] ?? [];
  const pick = rng.int('vault.pick', 0, Math.max(0, forShape.length - 1));
  for (const vault of forShape.length === 0 ? [] : [forShape[pick] ?? forShape[0]]) {
    if (vault === undefined) continue;
    const spot = placeVault(
      vault,
      { w: W, h: H },
      /**
       * BOUNDS AND THE DOOR RING — never occupancy. See `placeVault`: a room may
       * land in rock, because `connect` below digs to any floor it cannot
       * otherwise reach. What it may not do is run off the map, or sit inside
       * `DOOR_CLEARANCE` of the arrival tile.
       *
       * THAT SECOND CLAUSE USED TO BE ONE CELL — `!(x === spawn.x && ...)` — and
       * a single cell is not a clearance. `roomFor` discards every candidate
       * within eight tiles of the door, so a room that landed inside that ring
       * could hold nothing: no guard, no litter, and both fell silently through
       * to the rest of the floor. Over half of caves rolled exactly that.
       */
      (x, y) =>
        x >= MARGIN &&
        y >= MARGIN &&
        x < W - MARGIN &&
        y < H - MARGIN &&
        Math.max(Math.abs(x - spawn.x), Math.abs(y - spawn.y)) >= DOOR_CLEARANCE,
      rng,
      /**
       * PREFER GROUND THAT IS ALREADY OPEN. A room made of walls, stamped into
       * rock, writes walls into walls and changes nothing anybody can see — and
       * measured over sixty floors a shape, a third of cave rooms landed exactly
       * there. This counts how much of the footprint is already floor and lets
       * the best spot win; every legal spot stays legal, so a works with no open
       * rectangle still gets its room rather than none.
       */
      (spot, shape) => {
        let open = 0;
        for (let y = 0; y < shape.h; y += 1) {
          for (let x = 0; x < shape.w; x += 1) {
            if (at(g, spot.x + x, spot.y + y) === TileCode.FLOOR) open += 1;
          }
        }
        return open;
      },
    );
    // NULL IS AN ORDINARY ANSWER. A floor with no open patch big enough simply
    // does not get the room; see `placeVault`.
    if (spot !== null) {
      placed.push({
        id: vault.id,
        at: spot.at,
        turn: spot.turn,
        w: spot.shape.w,
        h: spot.shape.h,
      });
    }
    if (spot !== null)
      stampVault(spot.shape, spot.at, (x, y, code) => {
        put(g, x, y, code);
      });
  }

  // The threshold is always floor, whatever the shape did to it — you arrive
  // here, and `leaveRealm` treats it as the door.
  put(g, spawn.x, spawn.y, TileCode.FLOOR);
  connect(g, spawn);

  /**
   * THE REPAINT, LAST, over the finished grid. Two codes in, two codes out —
   * `blank()` fills with WALL and `put` only ever writes FLOOR or WALL, so this
   * loop sees nothing else and a third code appearing here would be a bug in
   * the carvers rather than something for this line to guess about.
   *
   * Skipped entirely for the default palette: identity work on 900 cells per
   * realm is cheap, but a no-op that is visibly a no-op is easier to reason
   * about than one that has to be traced.
   */
  const roof = palette.roof ?? palette.wall;
  if (palette.floor !== TileCode.FLOOR || palette.wall !== TileCode.WALL || roof !== palette.wall) {
    for (let i = 0; i < g.length; i += 1) {
      if (g[i] === TileCode.FLOOR) {
        g[i] = palette.floor;
        continue;
      }
      /**
       * THE EDGE IS THE BOUNDARY; EVERYTHING ELSE SOLID IS A BUILDING.
       *
       * A border test rather than a flood fill, because the grid always has a
       * closed ring — `blank()` fills with WALL and no carver opens the rim, so
       * "on the edge" and "is the wall around this place" are the same set.
       * Anything solid further in was put there by a carver as a block.
       */
      const x = i % W;
      const y = (i - x) / W;
      const edge = x === 0 || y === 0 || x === W - 1 || y === H - 1;
      g[i] = edge ? palette.wall : roof;
    }
  }

  return {
    vaults: placed,
    view: { w: W, h: H, tiles: g },
    spawns: [spawn],
    /** A floor is somewhere you are, not somewhere you leave from. */
    sites: new Map<string, string>(),
  };
}

/** Exposed so a test can assert against the shape the generator was given. */
export const SITE_MAP_SIZE = { w: W, h: H };
