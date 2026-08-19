import { describe, expect, it } from 'vitest';

import {
  RAIL_BY_MASK,
  ROAD_BY_MASK,
  isMadeGround,
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
