// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/engines/default/engine/BSP.lua:33-80 (init, partition)
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" — https://te4.org/license

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *        BINARY SPACE PARTITIONING — the shape of a building, as a tree.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Cut a rectangle in half, cut each half in half, stop when a piece is too
 * small to cut. What is left is a tiling of rooms that are all different sizes
 * and none of them overlap — which is the whole difficulty of laying out a
 * floor, solved in sixty lines.
 *
 * `docs/tome-port.md` has had this on the plan since M6 (`BSP.lua (80),
 * Generator.lua, generator/map/*`). It is the structural gap behind several
 * things this port has noticed from other directions: a delve is one open box
 * with a drawn room stamped into it, so the doors that shipped last week can
 * only ever appear in a vault, and `content/delve.ts` opens by admitting that
 * *"Every named destination on the map was a door onto nothing"*.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * `split_hor` SPLITS THE WIDTH. READ THAT TWICE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ```lua
 * if store.w >= self.min_w * 2 then split_hor = true end
 * if store.h >= self.min_h * 2 then split_vert = true end
 * ```
 *
 * Upstream's names describe the ORIENTATION OF THE CUT LINE, not the axis being
 * divided: a "horizontal" split tests the WIDTH and produces a left child and a
 * right child. Every instinct reads it the other way round, and getting it
 * backwards produces a generator that works — it still tiles the rectangle —
 * while respecting the wrong minimum on each axis, so rooms come out the wrong
 * shape and nothing ever fails.
 *
 * The names are kept verbatim anyway, because `grep -r split_vert
 * reference/t-engine4` has to keep working (CLAUDE.md's rule on ported names)
 * and because a comment can say what a rename cannot: this is the trap.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * PURE, AND THEREFORE IN `shared/`
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Takes a seeded `Rng` and returns a tree. No map, no tiles, no terrain — the
 * caller decides what a leaf means, which is exactly upstream's split between
 * `BSP.lua` and the generators that use it. That is what makes it testable
 * against nothing but numbers.
 */

import type { Rng } from './rng.ts';

/**
 * `max_depth or 8` — BSP.lua:34.
 *
 * A CEILING ON THE TREE, not on the room count. The minimum sizes usually stop
 * the recursion long before this does; it is the guard for a map big enough
 * that they would not.
 */
export const BSP_MAX_DEPTH = 8;

/** One node of the tree. A node with no children is a room. */
export type BspNode = {
  readonly id: number;
  readonly depth: number;
  /**
   * `rx`/`ry` upstream — the node's ABSOLUTE top-left on the map.
   *
   * Upstream carries `x`/`y` as well (the offset within the parent) and nothing
   * in `partition` ever reads them back: they are written, passed down and used
   * only to compute `rx`/`ry`. Carrying one pair rather than two is the port
   * dropping a field that upstream itself does not consult, which `check:inert`
   * would otherwise have to be told to ignore.
   */
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly children: readonly [BspNode, BspNode] | null;
};

export type BspTree = {
  readonly root: BspNode;
  /** Every childless node, in the order the recursion finished them. */
  readonly leaves: readonly BspNode[];
};

/**
 * Cut `w` x `h` into rooms no smaller than `minW` x `minH`.
 *
 * ═══ THE DRAW ORDER IS THE PORT AND IT IS DEPTH-FIRST ═══
 * Upstream flips the coin, then draws the split position, then recurses into
 * child 1 COMPLETELY before touching child 2. Any other order tiles the same
 * rectangle and produces a different floor from the same seed, so this is not
 * an implementation detail — it is the thing that makes "the same delve" mean
 * anything.
 *
 * Every draw carries the node's own id, so a label appears once per tree and a
 * reader can follow one node's decisions through a log.
 */
export function partition(
  w: number,
  h: number,
  minW: number,
  minH: number,
  rng: Rng,
  label: string,
  maxDepth: number = BSP_MAX_DEPTH,
): BspTree {
  const leaves: BspNode[] = [];
  let nextId = 1;

  const cut = (
    x: number,
    y: number,
    nw: number,
    nh: number,
    depth: number,
    id: number,
  ): BspNode => {
    // `store.w >= self.min_w * 2` — a piece only splits if BOTH halves could
    // still hold a room. This is why `minW` is a room size and not a half-width.
    let splitHor = nw >= minW * 2;
    let splitVert = nh >= minH * 2;

    /**
     * `local ok = rng.percent(50); split_vert, split_hor = ok, not ok`
     *
     * THE DRAW IS TAKEN ONLY WHEN BOTH ARE POSSIBLE, which is upstream's own
     * shape and matters to the stream: a node that can only be cut one way
     * costs no coin flip, so the number of draws depends on the geometry rather
     * than on the node count.
     */
    if (splitVert && splitHor) {
      const vertical = rng.int(`${label}.coin.${String(id)}`, 1, 100) <= 50;
      splitVert = vertical;
      splitHor = !vertical;
    }

    // `if store.depth > self.max_depth` — AFTER the flags are computed and the
    // coin is flipped, which is upstream's order. Moving it earlier would save
    // a draw and change every tree.
    if (depth > maxDepth) {
      splitVert = false;
      splitHor = false;
    }

    if (splitVert) {
      // A VERTICAL cut line divides the HEIGHT: a top child and a bottom one.
      const s = rng.int(`${label}.cut.${String(id)}`, minH, nh - minH);
      const a = cut(x, y, nw, s, depth + 1, nextId++);
      const b = cut(x, y + s, nw, nh - s, depth + 1, nextId++);
      return { id, depth, x, y, w: nw, h: nh, children: [a, b] };
    }

    if (splitHor) {
      // A HORIZONTAL cut line divides the WIDTH: a left child and a right one.
      const s = rng.int(`${label}.cut.${String(id)}`, minW, nw - minW);
      const a = cut(x, y, s, nh, depth + 1, nextId++);
      const b = cut(x + s, y, nw - s, nh, depth + 1, nextId++);
      return { id, depth, x, y, w: nw, h: nh, children: [a, b] };
    }

    const leaf: BspNode = { id, depth, x, y, w: nw, h: nh, children: null };
    leaves.push(leaf);
    return leaf;
  };

  // `self.bsp = {x=0, y=0, ... id=0, depth=0}` — the root is id ZERO and the
  // counter starts at one, so no child ever collides with it.
  const root = cut(0, 0, w, h, 0, 0);
  return { root, leaves };
}
