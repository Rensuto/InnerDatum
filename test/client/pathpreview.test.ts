/// <reference lib="dom" />

import { describe, expect, it } from 'vitest';

import { pathCellOrigin } from '../../src/client/render/canvas.ts';
import { TILE_PX } from '../../src/shared/version.ts';
import type { TileXY } from '../../src/shared/coords.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE ONE PIECE OF THE TRAVEL PREVIEW THAT CAN BE CHECKED WITHOUT A CANVAS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * NOTHING BELOW IS DRAWN. vitest.config.ts sets the environment to `node` with
 * deliberately no jsdom, which is the same ground test/client/turncards.test.ts
 * and test/client/tooltip.test.ts stand on: the claim under test is a DECISION
 * the painter makes, never a pixel it puts down.
 *
 * THE `/// <reference lib="dom" />` ABOVE IS DELIBERATE AND HAS A COST, and it
 * is the identical line and identical trade turncards.test.ts documents. Tests
 * compile under tsconfig.server.json, whose `lib` is ES2024 with no DOM, and
 * render/canvas.ts names `HTMLCanvasElement` and `CanvasRenderingContext2D` in
 * its types — so importing anything at all from it does not compile without the
 * reference. The cost is that the DOM lib is then in that whole program, so a
 * stray `document` in src/server/ would stop being a compile error. Referencing
 * the lib resolves TYPES; it conjures no canvas, and `createRenderer` is never
 * called here (it would reach for `document.createElement` on its first line).
 *
 * WHY THIS FUNCTION IS THE ONE WORTH TESTING. The travel preview is two
 * painters, one below the y-sorted tokens and one above them, and the only
 * arithmetic they share is tile -> backbuffer pixel. Everything else about the
 * preview is a colour and a rectangle; this is the part with an off-by-32 in it.
 * It is also the only part reachable from outside — `draw` writes
 * `lastCamX`/`lastCamY` at the very end of a frame and `tileAtClient` alone
 * reads them, so there is no other way to sample the camera transform.
 */

/**
 * The camera the renderer computes for one axis, restated here rather than
 * exported: `cameraAxis` is module-private in render/canvas.ts and should stay
 * that way. This mirrors it exactly, including the branch that matters below —
 * a map smaller than the viewport is CENTRED, which yields a negative camera.
 */
function cameraAxis(worldPx: number, viewPx: number, focusPx: number): number {
  if (worldPx <= viewPx) return -Math.floor((viewPx - worldPx) / 2);
  return Math.min(Math.max(Math.floor(focusPx - viewPx / 2), 0), worldPx - viewPx);
}

describe('pathCellOrigin — tile to backbuffer pixel', () => {
  it('offsets a tile by the camera, mid-map', () => {
    // 12 * 32 = 384, less a camera of 224. 9 * 32 = 288, less 160.
    expect(pathCellOrigin({ x: 12, y: 9 }, 224, 160)).toEqual({ x: 160, y: 128 });
  });

  it('is the identity at the origin with a zero camera', () => {
    expect(pathCellOrigin({ x: 0, y: 0 }, 0, 0)).toEqual({ x: 0, y: 0 });
    // And one tile along is exactly one tile of pixels along — the whole of the
    // scale factor, stated once so a changed TILE_PX shows up here first.
    expect(pathCellOrigin({ x: 1, y: 0 }, 0, 0)).toEqual({ x: TILE_PX, y: 0 });
  });

  /**
   * THE CASE A NAIVE CONVERTER GETS WRONG, and the reason this file exists.
   *
   * `cameraAxis` returns a NEGATIVE camera whenever the whole map is smaller
   * than the viewport: it centres the map rather than pinning it to the
   * top-left corner, which would look like a bug. Subtracting a negative camera
   * ADDS, so every origin on a small map is pushed right and down by the
   * letterbox of floor around it. Anything written assuming `camX >= 0` — a
   * clamp to zero, an unsigned cast, a `Math.abs` — is wrong here, and it is
   * wrong ONLY on small maps and ONLY at the edges, which is where it will
   * survive playtesting and then land in a real session.
   */
  it('handles the negative camera a small map produces', () => {
    const mapW = 10;
    const mapH = 8;
    const viewW = 640;
    const viewH = 480;
    // The focus is ignored on this branch, so any tile does.
    const camX = cameraAxis(mapW * TILE_PX, viewW, 5 * TILE_PX);
    const camY = cameraAxis(mapH * TILE_PX, viewH, 4 * TILE_PX);
    expect(camX).toBe(-160);
    expect(camY).toBe(-112);

    // The top-left tile of the map is NOT at backbuffer 0,0 — it is inset by
    // half the leftover viewport.
    expect(pathCellOrigin({ x: 0, y: 0 }, camX, camY)).toEqual({ x: 160, y: 112 });
    // And the bottom-right tile sits well inside the buffer, not off its edge.
    expect(pathCellOrigin({ x: mapW - 1, y: mapH - 1 }, camX, camY)).toEqual({ x: 448, y: 336 });
  });

  /**
   * THE REGRESSION TEST FOR THE OFF-BY-32 CLASS OF BUG.
   *
   * `tileAtClient` inverts this transform with `Math.floor((point + cam) /
   * TILE_PX)`, where `point` is a LOGICAL BACKBUFFER coordinate. The two spaces
   * are one multiplication apart and both are plain `{x, y}` numbers, so passing
   * a backbuffer point where a tile was expected — or the reverse — type-checks
   * perfectly and lands 32 times too far out. Composing the two here pins them
   * together: any change to either that is not made to both breaks this.
   */
  it('round-trips a tile through the inverse tileAtClient uses', () => {
    const cases: readonly { readonly cam: TileXY; readonly tile: TileXY }[] = [
      { cam: { x: 0, y: 0 }, tile: { x: 0, y: 0 } },
      { cam: { x: 0, y: 0 }, tile: { x: 19, y: 14 } },
      { cam: { x: 224, y: 160 }, tile: { x: 7, y: 5 } },
      { cam: { x: 224, y: 160 }, tile: { x: 39, y: 31 } },
      // The small-map camera again, this time through the full round trip.
      { cam: { x: -160, y: -112 }, tile: { x: 0, y: 0 } },
      { cam: { x: -160, y: -112 }, tile: { x: 9, y: 7 } },
    ];

    for (const { cam, tile } of cases) {
      const origin = pathCellOrigin(tile, cam.x, cam.y);
      // Sampled at the cell's first pixel, its middle and its LAST pixel: the
      // far edge is where a `<=` written for a `<` shows up as a click that
      // lands one tile over.
      for (const inset of [0, TILE_PX / 2, TILE_PX - 1]) {
        const tx = Math.floor((origin.x + inset + cam.x) / TILE_PX);
        const ty = Math.floor((origin.y + inset + cam.y) / TILE_PX);
        expect({ x: tx, y: ty }).toEqual(tile);
      }
    }
  });

  it('is a pixel origin, not a tile — feeding it back in lands 32x out', () => {
    // Stated as an assertion rather than as a comment because it is the exact
    // mistake the round trip above is guarding: a backbuffer point handed to
    // something expecting a tile is silently accepted and is 32 times too far.
    const origin = pathCellOrigin({ x: 3, y: 2 }, 0, 0);
    expect(origin).toEqual({ x: 96, y: 64 });
    expect(pathCellOrigin({ x: origin.x, y: origin.y }, 0, 0)).toEqual({ x: 3072, y: 2048 });
  });
});
