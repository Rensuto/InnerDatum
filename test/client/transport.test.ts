import { describe, expect, it } from 'vitest';

import {
  RAIL_BY_MASK,
  ROAD_BY_MASK,
  isMadeGround,
  tileVariant,
  transportMask,
} from '../../src/client/render/canvas.ts';
import { TileCode } from '../../src/shared/protocol.ts';
import type { LevelView } from '../../src/shared/protocol.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A ROAD IS A LINE, AND WHICH LINE IS FOUR BITS THAT MUST NOT ROTATE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The redesigned moor lays 584 road cells and 89 of continuous rail, and both
 * drew as a flat fill — a smear of cobble with no junction, no corner and no
 * end. The art ships as overlays keyed by a cardinal connection mask, and the
 * handoff states the contract: **N=1, E=2, S=4, W=8**.
 *
 * Getting that wrong is silent and total. Every corner in the game draws
 * rotated, every T points the wrong way, and nothing fails — the map simply
 * looks subtly wrong in a way nobody can name. So the bits are pinned
 * individually rather than as a shape.
 *
 * THE MASK IS DERIVED RATHER THAN IMPORTED, and that is measured rather than
 * hoped: against the handoff's own per-cell masks, over every cell both call
 * road, it is **95.2% identical**. The remainder are one shape — 167
 * `trail_danger` cells the compatibility layout draws as HEATH — so a paved road
 * meeting a moorland track draws the paving ending, which is the honest picture.
 */

/** A 3x3 level with a chosen centre and neighbours, for one mask question. */
function cross(centre: TileCode, n: TileCode, e: TileCode, s: TileCode, w: TileCode): LevelView {
  const fill = TileCode.PLAINS;
  const tiles = [fill, n, fill, w, centre, e, fill, s, fill];
  return { w: 3, h: 3, tiles };
}

describe('which way a road runs', () => {
  it('reads north as 1, east as 2, south as 4 and west as 8', () => {
    const { PLAINS, COBBLE } = TileCode;
    expect(transportMask(cross(COBBLE, COBBLE, PLAINS, PLAINS, PLAINS), 1, 1, isMadeGround)).toBe(
      1,
    );
    expect(transportMask(cross(COBBLE, PLAINS, COBBLE, PLAINS, PLAINS), 1, 1, isMadeGround)).toBe(
      2,
    );
    expect(transportMask(cross(COBBLE, PLAINS, PLAINS, COBBLE, PLAINS), 1, 1, isMadeGround)).toBe(
      4,
    );
    expect(transportMask(cross(COBBLE, PLAINS, PLAINS, PLAINS, COBBLE), 1, 1, isMadeGround)).toBe(
      8,
    );
  });

  it('adds them, so a crossroads is fifteen and a dead end is zero', () => {
    const { PLAINS, COBBLE } = TileCode;
    expect(transportMask(cross(COBBLE, COBBLE, COBBLE, COBBLE, COBBLE), 1, 1, isMadeGround)).toBe(
      15,
    );
    expect(transportMask(cross(COBBLE, PLAINS, PLAINS, PLAINS, PLAINS), 1, 1, isMadeGround)).toBe(
      0,
    );
    // A corner: north and east only.
    expect(transportMask(cross(COBBLE, COBBLE, COBBLE, PLAINS, PLAINS), 1, 1, isMadeGround)).toBe(
      3,
    );
  });

  it('ignores diagonals, because you cannot walk a corner', () => {
    /**
     * CARDINAL ONLY is the handoff's contract and it is also the right picture:
     * two road cells touching at a corner are not a junction, and drawing them
     * as one would put a road through the rock between them.
     */
    const { PLAINS, COBBLE } = TileCode;
    const diagonal: LevelView = {
      w: 3,
      h: 3,
      tiles: [COBBLE, PLAINS, COBBLE, PLAINS, COBBLE, PLAINS, COBBLE, PLAINS, COBBLE],
    };
    expect(transportMask(diagonal, 1, 1, isMadeGround)).toBe(0);
  });

  it('counts paving and bridges as the same network as cobble', () => {
    /**
     * A road does not stop being a road where it is better paved or where it
     * crosses a river. `isMadeGround` is what keeps a bridge from reading as a
     * gap in the line it is part of.
     */
    const { PLAINS, COBBLE, PAVING, BRIDGE } = TileCode;
    expect(transportMask(cross(COBBLE, PAVING, BRIDGE, PLAINS, PLAINS), 1, 1, isMadeGround)).toBe(
      3,
    );
    // ...and rail is a different network: it must not join the road's line.
    expect(
      transportMask(cross(COBBLE, TileCode.RAIL, PLAINS, PLAINS, PLAINS), 1, 1, isMadeGround),
    ).toBe(0);
  });
});

describe('every connection has a picture', () => {
  it('answers all sixteen masks for road and for rail', () => {
    /**
     * SIXTEEN, NOT "THE ONES THE MAP USES". The map uses all sixteen for road
     * today and six for rail, and the day somebody lays one more sleeper the
     * missing entry would be a hole in the line rather than a failure.
     */
    expect(ROAD_BY_MASK).toHaveLength(16);
    expect(RAIL_BY_MASK).toHaveLength(16);
    for (let mask = 1; mask < 16; mask += 1) {
      expect(ROAD_BY_MASK[mask], `road mask ${String(mask)} has no sprite`).toBeTruthy();
      expect(RAIL_BY_MASK[mask], `rail mask ${String(mask)} has no sprite`).toBeTruthy();
    }
  });

  it('draws nothing over an unconnected cell', () => {
    /**
     * Mask 0 is deliberately null on both. A lone cobble cell is a paving stone,
     * not a road stub — the tile under it is already the whole picture, and an
     * overlay there would draw a road going nowhere in the middle of a yard.
     */
    expect(ROAD_BY_MASK[0]).toBeNull();
    expect(RAIL_BY_MASK[0]).toBeNull();
  });
});

describe('the ground does not draw itself as a chequerboard', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * A PLAYER SENT A SCREENSHOT, AND THE HASH WAS THE REASON.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * The moor drew as a regular light/dark chequer and was, in the report's own
   * words, "hard to tell what is what". The variant picker was
   * `((tx * 73) ^ (ty * 151)) % n`, whose comment claimed two odd multipliers
   * stopped a diagonal run landing on one variant.
   *
   * They do not. `tx * 73` under `% 6` is LINEAR IN X, and a linear function
   * modulo n is a repeating stripe — its first row is literally `012345012345`.
   * XOR of two stripes is a stripe crossed with a stripe, which is a chequer.
   *
   * SO THE TEST IS STATISTICAL, because the bug was: nothing here can look at
   * the screen, and every other test in the suite passed happily while the map
   * was patterned. What is asserted is that a cell's variant does not predict
   * its neighbours' — at one tile, two tiles, and diagonally, since the old hash
   * failed all three at roughly twice chance.
   */
  const N = 120;
  const VARIANTS = 6;

  const agreementAt = (dx: number, dy: number): number => {
    let same = 0;
    for (let y = 0; y < N; y += 1) {
      for (let x = 0; x < N; x += 1) {
        if (tileVariant(x, y, VARIANTS) === tileVariant(x + dx, y + dy, VARIANTS)) same += 1;
      }
    }
    return same / (N * N);
  };

  it('does not let a cell predict its neighbours', () => {
    const chance = 1 / VARIANTS;
    // A GENEROUS BAND. The claim is "no visible structure", not "cryptographic":
    // the old hash sat at 33.9% against a 16.7% chance and would fail this by a
    // mile, while an honest mix lands within a point of it.
    const offsets: readonly (readonly [number, number])[] = [
      [1, 0],
      [2, 0],
      [0, 1],
      [0, 2],
      [1, 1],
      [3, 1],
    ];
    for (const [dx, dy] of offsets) {
      const seen = agreementAt(dx, dy);
      expect(
        seen,
        `offset ${String(dx)},${String(dy)} agrees ${(seen * 100).toFixed(1)}%`,
      ).toBeLessThan(chance * 1.35);
    }
  });

  it('uses every variant it is given, roughly evenly', () => {
    // The other way this fails silently: a hash that is beautifully unpredictable
    // and never returns variant 4 wastes art nobody will ever see.
    const counts = new Array<number>(VARIANTS).fill(0);
    for (let y = 0; y < N; y += 1) {
      for (let x = 0; x < N; x += 1) {
        const v = tileVariant(x, y, VARIANTS);
        counts[v] = (counts[v] ?? 0) + 1;
      }
    }
    for (const [i, n] of counts.entries()) {
      const share = n / (N * N);
      expect(share, `variant ${String(i)} is ${(share * 100).toFixed(1)}%`).toBeGreaterThan(0.13);
      expect(share, `variant ${String(i)} is ${(share * 100).toFixed(1)}%`).toBeLessThan(0.2);
    }
  });

  it('is deterministic, because the world is not sent', () => {
    // Same cell, same tile, every frame and every client. The variety is free
    // precisely because nobody has to agree about it over the wire.
    expect(tileVariant(41, 77, 6)).toBe(tileVariant(41, 77, 6));
    expect(tileVariant(0, 0, 1)).toBe(0);
  });
});
