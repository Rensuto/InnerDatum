/**
 * The ambush arena — a small, generated room to be jumped in.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY GENERATED WHEN EVERY OTHER MAP IN THIS PROJECT IS AUTHORED
 * ═══════════════════════════════════════════════════════════════════════════
 * The city is authored because a world you cannot learn is not a world, and the
 * inner-worlds are authored because a bad transition must not also be a
 * generation bug. An ambush is the opposite of both: it is somewhere you have
 * never been and will never return to, and its whole job is to be UNFAMILIAR.
 * Reusing one hand-made floor made every ambush the same room, entered at the
 * same corner, with the exit two steps behind you.
 *
 * ToME does exactly this and for the same reason — `GameState.lua` builds a
 * fresh `Zone.new("ambush", …)` per encounter, `width = enc.width or 20`, from
 * a Forest generator rather than a static map.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * IT COSTS NO ART, WHICH IS WHY THE FLAT-INTERIOR RULE WAS WORTH WRITING DOWN
 * ═══════════════════════════════════════════════════════════════════════════
 * FLOOR and WALL are the entire vocabulary, and `TILE_SPRITES` in the renderer
 * deliberately has no entry for either, so every room this produces draws
 * correctly the day it is generated. A tiling terrain set would have made each
 * change to this file an art commission — the argument test/client/assets.test.ts
 * pins, arriving at the moment it pays for itself.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * A DRUNKARD'S WALK, AND THE CHOICE IS ABOUT CONNECTIVITY
 * ═══════════════════════════════════════════════════════════════════════════
 * Cellular automata make prettier caves and need a flood fill afterwards to
 * find and discard the pockets they strand. A walk carves a single connected
 * region BY CONSTRUCTION — every cell it opens, it opened by standing on it —
 * so "can the player reach the monsters" is answered by the algorithm rather
 * than by a repair pass. On a room this small, prettier is worth less than
 * provably-connected.
 *
 * PURE, and seeded from `shared/rng.ts` with labelled draws, so an ambush is
 * reproducible from the realm that caused it. `src/shared/` bans `Math.random`
 * outright (CLAUDE.md § 3); this file could not cheat if it wanted to.
 */

import { inBounds, tileIndex } from './coords.ts';
import { createRng } from './rng.ts';
import { TileCode } from './protocol.ts';
import type { TileXY } from './coords.ts';
import type { AuthoredMap } from './level.ts';

/**
 * Big enough to manoeuvre, small enough to read as one room.
 *
 * The viewport is about twenty tiles wide at the smallest size this game ships
 * (canvas.ts `MAX_TILES_*` caps it at 48x32), so 24x24 is a room you can nearly
 * see the whole of — which is the point of an arena, as against a floor you
 * explore. ToME's ambush is 20x20 for the same reason.
 */
const ARENA_W = 24;
const ARENA_H = 24;

/**
 * Fraction of the interior the walk opens before it stops.
 *
 * Below about a third the room is a corridor system and a ranged monster can
 * never be reached; above about a half it is an empty box and the walls stop
 * meaning anything. 0.42 leaves cover without leaving mazes.
 */
const OPEN_FRACTION = 0.42;

/** One cell of margin stays solid, so the arena is always sealed. */
const MARGIN = 1;

/**
 * The eight steps, in a fixed order.
 *
 * ORDER IS PART OF THE SEED CONTRACT: the walk picks an index, so reordering
 * this array changes every arena ever generated from every seed. Same rule
 * `DIR_ORDER` states in coords.ts and for the same reason.
 */
const STEPS: readonly TileXY[] = Object.freeze([
  { x: 1, y: 0 },
  { x: -1, y: 0 },
  { x: 0, y: 1 },
  { x: 0, y: -1 },
  { x: 1, y: 1 },
  { x: 1, y: -1 },
  { x: -1, y: 1 },
  { x: -1, y: -1 },
]);

/**
 * Build one arena.
 *
 * `seed` should name the realm this belongs to, so two parties ambushed at the
 * same moment get two different rooms and the same party re-entering the same
 * realm gets the same one back.
 */
export function makeArena(seed: string): AuthoredMap {
  const rng = createRng(seed);
  const tiles: number[] = new Array<number>(ARENA_W * ARENA_H).fill(TileCode.WALL);

  const centre: TileXY = { x: Math.floor(ARENA_W / 2), y: Math.floor(ARENA_H / 2) };
  const interior = (ARENA_W - MARGIN * 2) * (ARENA_H - MARGIN * 2);
  const target = Math.floor(interior * OPEN_FRACTION);

  let x = centre.x;
  let y = centre.y;
  let open = 0;

  const carve = (cx: number, cy: number): void => {
    const i = tileIndex(cx, cy, ARENA_W);
    if (tiles[i] === TileCode.FLOOR) return;
    tiles[i] = TileCode.FLOOR;
    open += 1;
  };

  carve(x, y);

  /**
   * ═════════════════════════════════════════════════════════════════════════
   * THE WALKER IS RETURNED TO THE CENTRE PERIODICALLY, AND WITHOUT THAT THIS
   * GENERATOR IS UNUSABLE.
   * ═════════════════════════════════════════════════════════════════════════
   * A plain random walk DRIFTS. Left alone it wanders into one region and
   * hollows it out, and the first arenas this produced opened the top-left
   * corner while the bottom third stayed solid rock — with the arrival tile
   * sitting on the EDGE of the open area, walls immediately to two sides.
   *
   * That is not merely ugly. The ambush places its monsters in an annulus
   * around the arrival tile, so a room open on one side only means every
   * monster comes from that side: the thing that makes an ambush an ambush,
   * quietly deleted by a property of the random walk.
   *
   * Restarting from the centre every so often turns one wandering excursion
   * into a dozen radial ones. Connectivity is untouched — the centre is open,
   * so every excursion begins on an already-connected tile — which is the whole
   * reason a walk was chosen over cellular automata.
   */
  const RESET_EVERY = Math.max(8, Math.floor(target / 10));

  /**
   * BOUNDED, and the bound is not decoration. A walk that keeps rejecting steps
   * near a wall can in principle take a long time to reach its target, and this
   * runs synchronously inside a player's move — the same rule the pathfinder's
   * `maxNodes` obeys. Generous enough to be unreachable in practice, small
   * enough that hitting it costs a millisecond and a slightly emptier room
   * rather than a wedged server.
   */
  const MAX_STEPS = interior * 40;
  for (let step = 0; step < MAX_STEPS && open < target; step += 1) {
    if (step % RESET_EVERY === 0) {
      x = centre.x;
      y = centre.y;
    }
    const dir = STEPS[rng.int('arena.step', 0, STEPS.length - 1)];
    if (dir === undefined) continue;
    const nx = x + dir.x;
    const ny = y + dir.y;
    // Stay off the border so the room is always sealed. A rejected step still
    // consumed its draw, which keeps the stream aligned with the step count.
    if (nx < MARGIN || ny < MARGIN || nx >= ARENA_W - MARGIN || ny >= ARENA_H - MARGIN) {
      continue;
    }
    x = nx;
    y = ny;
    carve(x, y);
  }

  return {
    view: { w: ARENA_W, h: ARENA_H, tiles },
    /**
     * YOU ARRIVE IN THE MIDDLE, which is the whole difference from the floor
     * this replaced. The walk starts here, so the centre is always floor and
     * always connected to everything it opened — and an ambush that surrounds
     * you needs room on every side, which a corner cannot give.
     */
    spawns: [centre],
    /** An arena is a fight, not a place. Nothing leads anywhere from here. */
    sites: new Map<string, string>(),
  };
}

/** Where the walk starts, exported so a test can assert against it. */
export function arenaCentre(): TileXY {
  return { x: Math.floor(ARENA_W / 2), y: Math.floor(ARENA_H / 2) };
}

/** True when `t` is a walkable arena tile. Used by tests and by the seeder. */
export function isArenaFloor(map: AuthoredMap, at: TileXY): boolean {
  if (!inBounds(at.x, at.y, map.view.w, map.view.h)) return false;
  return map.view.tiles[tileIndex(at.x, at.y, map.view.w)] === TileCode.FLOOR;
}
