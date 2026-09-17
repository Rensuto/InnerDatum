import { describe, expect, it } from 'vitest';

import { BSP_MAX_DEPTH, partition } from '../../src/shared/bsp.ts';
import { range } from '../../src/shared/mapgen/lua.ts';
import { createRng } from '../../src/shared/rng.ts';
import type { BspNode, BspRange } from '../../src/shared/bsp.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * BINARY SPACE PARTITIONING — `engine/BSP.lua:33-80`.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ```lua
 * if store.w >= self.min_w * 2 then split_hor = true end
 * if store.h >= self.min_h * 2 then split_vert = true end
 * ...
 * if split_vert and not split_hor then
 *   local s = rng.range(self.min_h, store.h - self.min_h)
 * ```
 *
 * A pure function of (size, minimums, seed), which is the whole reason it lives
 * in `shared/` — it can be checked against arithmetic rather than against a
 * picture of a floor.
 *
 * ═══ THE INVARIANTS ARE WHAT MATTER, NOT THE TREE ═══
 * Every assertion below is a property that must hold for EVERY seed, walked
 * over many. A test naming one expected tree would pin an implementation and
 * would have to be rewritten the day the draw order changed for a good reason —
 * and the draw order is exactly the thing these are protecting.
 */

const SEEDS = Array.from({ length: 40 }, (_, i) => `bsp-${String(i)}`);

/** Every leaf, and every node, of one tree. */
function walk(node: BspNode, out: BspNode[] = []): BspNode[] {
  out.push(node);
  if (node.children !== null) {
    walk(node.children[0], out);
    walk(node.children[1], out);
  }
  return out;
}

describe('the partition tiles its rectangle exactly', () => {
  it('covers every cell once — no gap, no overlap', () => {
    /**
     * THE ONE PROPERTY THE WHOLE THING EXISTS FOR. A generator whose rooms
     * overlap produces walls inside rooms; one that leaves a gap produces rock
     * nobody can explain. Both are invisible on a single screenshot and obvious
     * over forty seeds.
     *
     * Counted by AREA and by COVERAGE together, because area alone passes for a
     * tree that double-counts one cell and misses another.
     */
    for (const seed of SEEDS) {
      const tree = partition(32, 28, 7, 7, createRng(seed), 'bsp');
      const covered = new Set<string>();
      let area = 0;
      for (const leaf of tree.leaves) {
        area += leaf.w * leaf.h;
        for (let y = leaf.y; y < leaf.y + leaf.h; y += 1) {
          for (let x = leaf.x; x < leaf.x + leaf.w; x += 1)
            covered.add(`${String(x)},${String(y)}`);
        }
      }
      expect(area, `${seed}: the leaves do not add up to the rectangle`).toBe(32 * 28);
      expect(covered.size, `${seed}: a cell is covered twice or not at all`).toBe(32 * 28);
    }
  });

  it('never cuts a piece below the minimum', () => {
    // `store.w >= self.min_w * 2` is the guard, and the point of it: a piece
    // only splits when BOTH halves could still hold a room. Which is why the
    // minimum is a ROOM size and not a half-width — the easiest thing to get
    // backwards here, and it would halve every room.
    for (const seed of SEEDS) {
      const tree = partition(32, 28, 7, 5, createRng(seed), 'bsp');
      for (const leaf of tree.leaves) {
        expect(leaf.w, `${seed}: a leaf came out narrower than min_w`).toBeGreaterThanOrEqual(7);
        expect(leaf.h, `${seed}: a leaf came out shorter than min_h`).toBeGreaterThanOrEqual(5);
      }
    }
  });

  it('splits the WIDTH on a horizontal cut, which is upstream’s naming trap', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * `split_hor` TESTS `store.w`. READ IT TWICE.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * Upstream names the cut by the ORIENTATION OF THE LINE, not by the axis it
     * divides. Swapping the two still tiles the rectangle — every assertion
     * above stays green — while enforcing each minimum on the wrong axis.
     *
     * A rectangle that is WIDE and SHORT can only ever be cut one way: 32 wide
     * against a minimum of 7 splits, 6 tall against a minimum of 5 cannot. So
     * every leaf must be full height, and a swapped implementation produces the
     * opposite and fails here.
     */
    for (const seed of SEEDS) {
      const tree = partition(32, 6, 7, 5, createRng(seed), 'bsp');
      expect(tree.leaves.length, `${seed}: a wide short strip was never cut`).toBeGreaterThan(1);
      for (const leaf of tree.leaves) {
        expect(leaf.h, `${seed}: the height was split when only the width could be`).toBe(6);
      }
    }
  });

  it('refuses to cut anything below twice the minimum', () => {
    // Exactly at the boundary: 13 against a minimum of 7 cannot split (13 < 14),
    // and 14 can. Asserting the pair is what makes this the RULE rather than a
    // fact about one number.
    const tight = partition(13, 13, 7, 7, createRng('tight'), 'bsp');
    expect(tight.leaves).toHaveLength(1);
    expect(tight.root.children).toBeNull();

    const loose = partition(14, 14, 7, 7, createRng('loose'), 'bsp');
    expect(loose.leaves.length).toBeGreaterThan(1);
  });

  it('stops at max_depth however much room is left', () => {
    /**
     * `if store.depth > self.max_depth then split_vert, split_hor = false, false end`
     *
     * Driven with a minimum of ONE, so the size guard can never be what stops
     * the recursion and only the depth cap can. Without the cap this partitions
     * a 64x64 down to single cells.
     */
    const shallow = partition(64, 64, 1, 1, createRng('deep'), 'bsp', 2);
    for (const node of walk(shallow.root)) {
      expect(node.depth, 'a node was cut past max_depth').toBeLessThanOrEqual(3);
    }
    // AND THE CAP IS REACHABLE, or the assertion above is true of a tree that
    // simply never got deep.
    expect(shallow.leaves.length).toBeGreaterThan(2);
  });

  it('is the same tree from the same seed, and a different one otherwise', () => {
    const shape = (seed: string): string =>
      JSON.stringify(
        partition(32, 28, 7, 7, createRng(seed), 'bsp').leaves.map((l) => [l.x, l.y, l.w, l.h]),
      );
    expect(shape('same')).toBe(shape('same'));
    expect(shape('same')).not.toBe(shape('other'));
  });

  it('has a default depth cap of eight, as `max_depth or 8` says', () => {
    expect(BSP_MAX_DEPTH).toBe(8);
  });
});

describe('the cut is drawn by the range the caller hands in', () => {
  it('spends no draw on a cut with one position through the C core`s range, and one by default', () => {
    /**
     * `rng.range(8, 16 - 8)` is `rand_div(1)`, which returns before it touches
     * the generator (C core: `rng_range`, src/core_lua.c, T-Engine4 tag
     * tome-1.6.0). 16 wide against a minimum of 8 can only be cut at 8, and 7
     * tall against 5 cannot be cut at all, so there is no coin either: the
     * whole tree is that one cut. Turned a quarter, the same for the height.
     */
    const draws = (w: number, h: number, cut?: BspRange): number => {
      const rng = createRng('one-cut');
      const tree = partition(w, h, w > h ? 8 : 5, w > h ? 5 : 8, rng, 'bsp', BSP_MAX_DEPTH, cut);
      expect(tree.leaves.map((l) => [l.x, l.y, l.w, l.h])).toEqual(
        w > h
          ? [
              [0, 0, 8, 7],
              [8, 0, 8, 7],
            ]
          : [
              [0, 0, 7, 8],
              [0, 8, 7, 8],
            ],
      );
      return rng.getState().count;
    };
    expect(draws(16, 7, range)).toBe(0);
    expect(draws(7, 16, range)).toBe(0);
    // The default is the draw `partition` has always made.
    expect(draws(16, 7)).toBe(1);
    expect(draws(7, 16)).toBe(1);
  });

  it('asks that range for every cut, with the node`s label and bounds, and cuts where it answers', () => {
    // A range that always answers its lower bound cuts every piece at the minimum.
    const asked: [string, number, number][] = [];
    const lowest: BspRange = (_rng, label, lo, hi) => {
      asked.push([label, lo, hi]);
      return lo;
    };
    const tree = partition(30, 6, 8, 5, createRng('lowest'), 'bsp', BSP_MAX_DEPTH, lowest);
    // 30 is cut at 8; the 22 left is cut at 8; the 14 left is under 16 and stays.
    expect(tree.leaves.map((l) => [l.x, l.w])).toEqual([
      [0, 8],
      [8, 8],
      [16, 14],
    ]);
    expect(asked).toEqual([
      ['bsp.cut.0', 8, 22],
      ['bsp.cut.2', 8, 14],
    ]);
  });
});
