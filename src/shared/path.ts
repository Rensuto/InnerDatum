// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/engines/default/engine/Astar.lua:43-193
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" — https://te4.org/license

/**
 * A*, ported from T-Engine4's `engine.Astar`.
 *
 * WHAT CAME ACROSS VERBATIM
 *   - Chebyshev base heuristic (Astar.lua:49). Diagonals cost the same as
 *     orthogonals in this game, so `max(|dx|, |dy|)` is the true remaining
 *     distance over open ground.
 *   - Uniform step cost of 1, diagonal included (Astar.lua:135, 157, with its
 *     own comment: "we can adjust here for difficult passable terrain").
 *   - The straight-line tie-breaker (Astar.lua:52-57), which nudges A* towards
 *     paths that look deliberate rather than staircased.
 *   - Closed nodes are never reopened (Astar.lua:134, 156).
 *   - The destination is rejected up front when it is impassable
 *     (Astar.lua:150-153).
 *   - The returned path EXCLUDES the start tile and INCLUDES the target
 *     (Astar.lua:90-100), so `path[0]` is always the next step to take.
 *
 * WHAT DID NOT, AND WHY
 *   - `open` is a binary heap, not a Lua table scanned linearly with `next()`
 *     (Astar.lua:173-180). That scan's result depends on hash iteration order,
 *     which is exactly the kind of thing that makes two runs of the same seed
 *     disagree. See DETERMINISM below.
 *   - Terrain lookups go through a caller-supplied predicate instead of
 *     `map:checkEntity` and the native FOV path cache.
 *   - `from === to` returns an empty path rather than ToME's `nil`
 *     (Astar.lua:91). "You have arrived" and "there is no route" are different
 *     answers and callers act on them differently.
 *
 * ===========================================================================
 * DETERMINISM — TWO RUNS WITH THE SAME INPUTS RETURN THE SAME PATH
 * ===========================================================================
 *
 * Not a nicety. The server is authoritative and every client renders what it
 * is told, so a monster that takes a different route on a replay means a save
 * that loads into a different fight.
 *
 * TIES ARE BROKEN, IN ORDER, BY:
 *   1. lowest `f` (= g + h) — ordinary A*;
 *   2. then lowest `h`, which prefers the node nearer the goal and stops a
 *      plateau of equal-`f` nodes from being explored in an arbitrary order;
 *   3. then lowest NODE KEY, which is `(y, x)` lexicographic — a total order
 *      over the grid.
 *
 * Because no two distinct tiles share a key, rule 3 never ties, so the
 * comparator is a strict total order and the pop sequence is fixed no matter
 * what order nodes were pushed in. Neighbours are additionally visited in the
 * fixed `DIR_ORDER` (n, ne, e, se, s, sw, w, nw), and a parent is recorded
 * only on a STRICT improvement (Astar.lua:138), so the first parent to reach a
 * tile at a given cost keeps it.
 *
 * `Map` and `Set` are used as dictionaries only — `get`/`set`/`has`. Nothing
 * here iterates one, so insertion order can never leak into the result. There
 * is no randomness: this module could not reach `Math.random` if it wanted to,
 * because ESLint bans it across src/shared/.
 *
 * ===========================================================================
 * PATHING IS TERRAIN-ONLY, AND THAT IS WHAT MAKES BUMP-ATTACK WORK
 * ===========================================================================
 *
 * ToME's A* tests `Map.TERRAIN` for `block_move` and never looks at actors
 * (Astar.lua:150, 156). So a monster paths straight through the tile its
 * target is standing on, walks the path, finds a body in the way, and attacks
 * it. Route planning and collision are separate questions asked at separate
 * times. Pass a terrain-only predicate (`canWalk` from level.ts is exactly
 * that) and bump-attack falls out for free; pass an actor-aware one and
 * monsters will politely path around their victims.
 */

import { DIR_ORDER, DIR_VECTORS } from './coords.ts';
import type { Dir, TileXY } from './coords.ts';

/**
 * Terrain test. Loose coordinates rather than a `TileXY` because this is the
 * innermost loop — up to eight calls per expanded node — and an object per
 * probe would be pure allocation.
 *
 * MUST FAIL CLOSED off-grid: A* probes coordinates outside the map as a matter
 * of course. `canWalk` in level.ts already answers `false` for out of bounds,
 * which is why this signature carries no width and height.
 */
export type PassableFn = (x: number, y: number) => boolean;

export const PathHeuristic = {
  /**
   * ToME's default (Astar.lua:43-58): Chebyshev distance plus a small
   * cross-product term that penalises drifting off the straight line from
   * start to goal. Produces noticeably straighter, more purposeful-looking
   * routes.
   *
   * It is NOT admissible — the penalty can exceed the true remaining cost — so
   * the path is "good and straight", not provably shortest. That is ToME's
   * long-standing trade and it looks better in motion.
   */
  CloserPath: 'closerPath',
  /**
   * Bare Chebyshev. Admissible, so the result is a genuine shortest path.
   * Ties are then far more common, which is precisely why the tie-break rules
   * above are a total order.
   */
  Chebyshev: 'chebyshev',
} as const;
export type PathHeuristic = (typeof PathHeuristic)[keyof typeof PathHeuristic];

export type FindPathOpts = {
  /**
   * Hard ceiling on nodes EXPANDED (popped and closed). On reaching it,
   * `findPath` gives up and returns null.
   *
   * Bounded rather than exhaustive because this runs inside a synchronous turn
   * resolution: an unreachable target on a large map must cost a wasted
   * millisecond, not a wedged server. A 40x40 level has 1600 tiles, so the
   * default explores every one of them several times over before quitting.
   */
  readonly maxNodes?: number;
  /** Eight-way movement. False restricts to n/e/s/w. Astar.lua's `forbid_diagonals`. */
  readonly allowDiagonals?: boolean;
  /** Which heuristic. Defaults to ToME's `heuristicCloserPath`. */
  readonly heuristic?: PathHeuristic;
  /**
   * Treat the goal tile as passable even when the predicate says otherwise —
   * the "walk up to the closed door / the boulder / the tile a friendly is
   * standing on and interact with it" case. Only the goal is exempted; the
   * route to it still obeys the predicate.
   */
  readonly allowBlockedTarget?: boolean;
};

const DEFAULT_MAX_NODES = 4096;

/**
 * Tiles are packed into one number so the open/closed/came-from dictionaries
 * key on a primitive: `(y + BIAS) * SPAN + (x + BIAS)`.
 *
 * This is ToME's `toSingle` (Astar.lua:75-77) with the map width replaced by a
 * fixed span, because this module never sees a map. Row-major, matching the
 * Lua's `x + y * w`, so key order is `(y, x)` lexicographic — that ordering is
 * the final tie-break, so it is part of the contract, not an implementation
 * detail.
 *
 * The span supports coordinates in [-32768, 32767]; the largest key is
 * 2^32 - 1, exactly representable as a double. Levels are capped at 40x40, so
 * the headroom is absurd on purpose: an out-of-range coordinate is a bug, and
 * a bug should hit a guard rather than a silent key collision.
 */
const KEY_BIAS = 32768;
const KEY_SPAN = 65536;
const COORD_MIN = -KEY_BIAS;
const COORD_MAX = KEY_BIAS - 1;

function nodeKey(x: number, y: number): number {
  return (y + KEY_BIAS) * KEY_SPAN + (x + KEY_BIAS);
}

function keyX(key: number): number {
  return (key % KEY_SPAN) - KEY_BIAS;
}

function keyY(key: number): number {
  return Math.floor(key / KEY_SPAN) - KEY_BIAS;
}

function inKeyRange(x: number, y: number): boolean {
  return x >= COORD_MIN && x <= COORD_MAX && y >= COORD_MIN && y <= COORD_MAX;
}

/** n, e, s, w — `DIR_ORDER` minus the diagonals, same relative order. */
const ORTHOGONAL_DIRS = ['n', 'e', 's', 'w'] as const satisfies readonly Dir[];

// ---------------------------------------------------------------------------
// Heuristics — Astar.lua:43-58
// ---------------------------------------------------------------------------

/**
 * Ported from Astar.lua:43-58 (`heuristicCloserPath`), argument names kept.
 *
 * `h` is Chebyshev distance from the current tile to the target (Astar.lua:49).
 * The added term is the magnitude of the 2D cross product of (current -> target)
 * and (start -> target): zero when the current tile sits on the straight line
 * between start and goal, growing with lateral drift. Scaled by 0.01 so it only
 * ever decides between otherwise-equal candidates... mostly. On a long, wide
 * detour it can dominate, which is how ToME buys straight-looking paths.
 *
 * NOTE ON THE UPSTREAM CALL SITES: Astar.lua:121-122 seeds the scores with
 * `heur(self, sx, sy, sx, sy, tx, ty)`, matching this signature, but
 * Astar.lua:144 and :166 call it as `heur(self, sx, sy, tx, ty, nx, ny)` —
 * current and target swapped. The Chebyshev half is symmetric and unaffected;
 * the tie-breaker half is not, and the swapped form measures something subtly
 * different. We call it in the order the function declares, which is what its
 * own comment describes.
 */
function heuristicCloserPath(
  sx: number,
  sy: number,
  cx: number,
  cy: number,
  tx: number,
  ty: number,
): number {
  // Chebyshev — the same metric as `chebyshev()` in coords.ts, written out
  // here on loose coordinates to avoid allocating a TileXY per probe.
  const h = Math.max(Math.abs(tx - cx), Math.abs(ty - cy));
  const dx1 = cx - tx;
  const dy1 = cy - ty;
  const dx2 = sx - tx;
  const dy2 = sy - ty;
  return h + 0.01 * Math.abs(dx1 * dy2 - dx2 * dy1);
}

function heuristicChebyshev(
  _sx: number,
  _sy: number,
  cx: number,
  cy: number,
  tx: number,
  ty: number,
): number {
  return Math.max(Math.abs(tx - cx), Math.abs(ty - cy));
}

// ---------------------------------------------------------------------------
// The open set: a deterministic binary min-heap
// ---------------------------------------------------------------------------

type OpenEntry = {
  readonly key: number;
  readonly g: number;
  readonly h: number;
  readonly f: number;
};

/**
 * The total order described in the header. `h` is a pure function of the tile,
 * so for a fixed key an equal `f` implies an equal `g`: two entries can only
 * compare equal when they are the same node at the same cost, and one of them
 * is stale.
 */
function less(a: OpenEntry, b: OpenEntry): boolean {
  if (a.f !== b.f) return a.f < b.f;
  if (a.h !== b.h) return a.h < b.h;
  return a.key < b.key;
}

function heapPush(heap: OpenEntry[], entry: OpenEntry): void {
  heap.push(entry);
  let i = heap.length - 1;
  while (i > 0) {
    const parent = (i - 1) >> 1;
    const child = heap[i];
    const above = heap[parent];
    // Both indices are in range by construction; the guards exist because
    // noUncheckedIndexedAccess cannot prove it and `!` is banned here.
    if (child === undefined || above === undefined || !less(child, above)) break;
    heap[i] = above;
    heap[parent] = child;
    i = parent;
  }
}

function heapPop(heap: OpenEntry[]): OpenEntry | undefined {
  const top = heap[0];
  if (top === undefined) return undefined;
  const last = heap.pop();
  if (last === undefined || heap.length === 0) return top;
  heap[0] = last;

  let i = 0;
  for (;;) {
    const current = heap[i];
    if (current === undefined) break;
    let bestIndex = i;
    let best = current;

    const left = 2 * i + 1;
    const leftChild = heap[left];
    if (leftChild !== undefined && less(leftChild, best)) {
      bestIndex = left;
      best = leftChild;
    }
    const right = left + 1;
    const rightChild = heap[right];
    if (rightChild !== undefined && less(rightChild, best)) {
      bestIndex = right;
      best = rightChild;
    }

    if (bestIndex === i) break;
    heap[i] = best;
    heap[bestIndex] = current;
    i = bestIndex;
  }
  return top;
}

// ---------------------------------------------------------------------------
// findPath — Astar.lua:113-193 (`calc`)
// ---------------------------------------------------------------------------

/**
 * Shortest-ish route from `from` to `to`, or null when there is none.
 *
 * @returns tiles in walk order, EXCLUDING `from` and INCLUDING `to`, so
 * `path[0]` is the very next step. An EMPTY array means "already there"; NULL
 * means unreachable, blocked, over budget, or off the addressable grid. Do not
 * conflate them — `[]` and `null` are the two answers a chasing monster must
 * tell apart.
 *
 * Coordinates are truncated towards zero, matching `bresenham` in coords.ts.
 */
export function findPath(
  from: TileXY,
  to: TileXY,
  isPassable: PassableFn,
  opts: FindPathOpts = {},
): TileXY[] | null {
  const sx = Math.trunc(from.x);
  const sy = Math.trunc(from.y);
  const tx = Math.trunc(to.x);
  const ty = Math.trunc(to.y);
  if (
    !Number.isFinite(sx) ||
    !Number.isFinite(sy) ||
    !Number.isFinite(tx) ||
    !Number.isFinite(ty)
  ) {
    return null;
  }
  if (!inKeyRange(sx, sy) || !inKeyRange(tx, ty)) return null;

  const maxNodes = opts.maxNodes ?? DEFAULT_MAX_NODES;
  if (!Number.isInteger(maxNodes) || maxNodes < 1) {
    throw new RangeError(`findPath: maxNodes must be a positive integer, got ${String(maxNodes)}`);
  }

  // ToME returns nil here (Astar.lua:91). We distinguish arrival from failure.
  if (sx === tx && sy === ty) return [];

  const allowBlockedTarget = opts.allowBlockedTarget ?? false;
  // Astar.lua:150-153 — reject an impassable destination before searching.
  if (!allowBlockedTarget && !isPassable(tx, ty)) return null;

  const heuristic =
    (opts.heuristic ?? PathHeuristic.CloserPath) === PathHeuristic.Chebyshev
      ? heuristicChebyshev
      : heuristicCloserPath;
  const dirs: readonly Dir[] = (opts.allowDiagonals ?? true) ? DIR_ORDER : ORTHOGONAL_DIRS;

  const start = nodeKey(sx, sy);
  const goal = nodeKey(tx, ty);

  // Dictionaries only. Nothing iterates these — see DETERMINISM in the header.
  const gScore = new Map<number, number>([[start, 0]]);
  const cameFrom = new Map<number, number>();
  const closed = new Set<number>();
  const open: OpenEntry[] = [];

  const startH = heuristic(sx, sy, sx, sy, tx, ty); // Astar.lua:121-122
  heapPush(open, { key: start, g: 0, h: startH, f: startH });

  let expanded = 0;

  for (;;) {
    const current = heapPop(open);
    if (current === undefined) return null; // open exhausted: no route exists

    // Lazy deletion. A node whose cost improved was pushed again rather than
    // sifted in place, so drop anything already closed or superseded.
    if (closed.has(current.key)) continue;
    const g = gScore.get(current.key);
    if (g === undefined || g !== current.g) continue;

    // Astar.lua:182 — the goal test happens on POP, not on push, so the first
    // time the goal surfaces it already carries its final cost.
    if (current.key === goal) return reconstruct(cameFrom, start, goal);

    closed.add(current.key); // Astar.lua:184-185
    expanded += 1;
    if (expanded > maxNodes) return null;

    const cx = keyX(current.key);
    const cy = keyY(current.key);

    // Astar.lua:189-191 — `util.adjacentCoords`, in our fixed DIR_ORDER.
    for (const dir of dirs) {
      const vec = DIR_VECTORS[dir];
      const nx = cx + vec.dx;
      const ny = cy + vec.dy;
      if (!inKeyRange(nx, ny)) continue;

      const neighbour = nodeKey(nx, ny);
      if (closed.has(neighbour)) continue; // Astar.lua:134 — never reopened
      if (!(allowBlockedTarget && neighbour === goal) && !isPassable(nx, ny)) continue;

      // Astar.lua:135 — uniform cost 1, diagonals included.
      const tentative = g + 1;
      const known = gScore.get(neighbour);
      // Astar.lua:137-139 — a STRICT improvement, so the first parent to reach
      // a tile at a given cost keeps it.
      if (known !== undefined && tentative >= known) continue;

      cameFrom.set(neighbour, current.key);
      gScore.set(neighbour, tentative);
      const h = heuristic(sx, sy, nx, ny, tx, ty);
      heapPush(open, { key: neighbour, g: tentative, h, f: tentative + h });
    }
  }
}

/**
 * Walk `cameFrom` back from the goal and reverse — Astar.lua:90-100
 * (`createPath`). The start tile is dropped: it is where the actor already
 * stands, and including it would make every caller slice it off.
 */
function reconstruct(cameFrom: Map<number, number>, start: number, goal: number): TileXY[] | null {
  const reversed: TileXY[] = [];
  let current = goal;
  // cameFrom holds one entry per reachable tile, so a correct chain cannot be
  // longer than that. The bound turns a corrupted chain into a null instead of
  // an infinite loop inside a synchronous turn.
  const limit = cameFrom.size + 1;

  while (current !== start) {
    reversed.push({ x: keyX(current), y: keyY(current) });
    const parent = cameFrom.get(current);
    if (parent === undefined) return null;
    current = parent;
    if (reversed.length > limit) return null;
  }

  reversed.reverse();
  return reversed;
}
