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
export function makeSiteMap(seed: string, shape: SiteShape): AuthoredMap {
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

  // The threshold is always floor, whatever the shape did to it — you arrive
  // here, and `leaveRealm` treats it as the door.
  put(g, spawn.x, spawn.y, TileCode.FLOOR);
  connect(g, spawn);

  return {
    view: { w: W, h: H, tiles: g },
    spawns: [spawn],
    /** A floor is somewhere you are, not somewhere you leave from. */
    sites: new Map<string, string>(),
  };
}

/** Exposed so a test can assert against the shape the generator was given. */
export const SITE_MAP_SIZE = { w: W, h: H };
