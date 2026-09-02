/// <reference lib="dom" />

// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MarkerKind, createRenderer } from '../../src/client/render/canvas.ts';
import { TILE_PX } from '../../src/shared/version.ts';
import { installDom, removeDom, stubCanvas, stubSprites } from './canvasstub.ts';
import type { Blit } from './canvasstub.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A MARK ON A CELL IS THE CELL. IT WAS DRAWING AT WHATEVER SIZE THE ART WAS.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Reported with a screenshot the day the cell went to 64: *"the area boxes when
 * using abilities should be seamless and they are far apart now. the cells
 * should be bound to the art/cell size."*
 *
 * Every one of the thirteen marks in `ui/markers/` is authored 32x32 — the five
 * targeting markers, the five token rings, the downed and erased silhouettes,
 * the ping — and all of them went through `blitSprite`, which draws at the
 * sprite's NATURAL size with a bottom-centre anchor. That is right for a BODY:
 * a creature stands on a cell, may be bigger than one, and its feet say which
 * cell it occupies. It is wrong for everything that IS a cell. On a 64-pixel
 * grid every mark drew at quarter area in the middle of its own cell, so an
 * area-of-effect read as scattered confetti and a token ring was half the width
 * of the body standing in it.
 *
 * ═══ THE ART WAS ALSO REGENERATED AT 64, AND THAT IS NOT WHAT THIS TESTS ═══
 * These cases hand the renderer 32x32 art ON PURPOSE and demand a 64-pixel
 * blit. The rule has to be "a cell mark fills the cell" rather than "the art
 * happens to be the right size", because the second one is exactly what broke:
 * it was true for years and then a constant moved.
 */

const CELL_MARKS = [
  'ui_tile_marker_cursor',
  'ui_tile_marker_valid',
  'ui_tile_marker_invalid',
  'ui_tile_marker_aoe',
  'ui_tile_marker_minrange',
  'ui_token_ring_self',
  'ui_token_ring_hostile',
  'ui_token_ring_ally',
  'ui_token_ring_neutral',
  'ui_token_ring_elite',
  'ui_marker_point',
  'ui_marker_downed',
  'ui_marker_erased',
];

/** Art at HALF a cell, which is what shipped. */
const WRONG_SIZE = TILE_PX / 2;

/**
 * A map SMALLER than the viewport, deliberately.
 *
 * `cameraAxis` centres a small map instead of pinning it to the corner, so
 * every cell is on screen and a case can name one without doing the camera
 * arithmetic. The first version of this file used a 40x40 map and asserted
 * about cell (5,5), which the camera had parked 352 pixels off the left edge —
 * the painter culled it, nothing was drawn, and the test failed for a reason
 * that had nothing to do with what it was testing.
 */
function level(w: number, h: number) {
  return { w, h, tiles: new Array<number>(w * h).fill(1) };
}

const SMALL = level(12, 10);

function paint(scene: Record<string, unknown>): Blit[] {
  const visible = stubCanvas(1248, 860);
  const renderer = createRenderer({
    canvas: visible as unknown as HTMLCanvasElement,
    sprites: stubSprites(WRONG_SIZE, WRONG_SIZE),
  });
  renderer.resize();
  renderer.draw(scene as never);
  // The MAP buffer's blits. The visible canvas only ever receives the two
  // presented buffers, and the interface buffer is a different space entirely.
  return blitsOfMapBuffer(visible);
}

function blitsOfMapBuffer(visible: ReturnType<typeof stubCanvas>): Blit[] {
  // The map backbuffer is the first thing composited onto the visible canvas.
  const composited = visible.ctx?.blits ?? [];
  const back = composited[0]?.source;
  if (back === null || back === undefined || !('ctx' in back)) return [];
  return back.ctx?.blits ?? [];
}

describe('a mark on a cell fills the cell', () => {
  beforeEach(() => {
    installDom(1);
  });
  afterEach(() => {
    removeDom();
  });

  it('draws the targeting markers at the cell size, not the art size', () => {
    const blits = paint({
      level: SMALL,
      actors: [],
      selfId: null,
      targeting: [
        { x: 5, y: 5, marker: MarkerKind.Valid, shaded: false },
        { x: 6, y: 5, marker: MarkerKind.Aoe, shaded: false },
        { x: 7, y: 5, marker: MarkerKind.Cursor, shaded: false },
      ],
    });

    const marks = blits.filter((b) => b.dw === TILE_PX && b.dh === TILE_PX);
    expect(marks.length, 'no cell-sized blit happened at all').toBeGreaterThanOrEqual(3);
    // Nothing was drawn at the art's own size, which is the defect exactly.
    const halfSized = blits.filter((b) => b.dw === WRONG_SIZE || b.dh === WRONG_SIZE);
    expect(halfSized, 'a cell mark was drawn at the art size').toEqual([]);
  });

  it('and the area cells are adjacent, with no gap between them', () => {
    /**
     * THE PLAYER'S ACTUAL WORDS: the boxes "should be seamless". Asserted as
     * geometry rather than as a size, because two 64-pixel marks could still be
     * drawn 96 apart — the seam is a fact about the pair, not about either one.
     */
    const blits = paint({
      level: SMALL,
      actors: [],
      selfId: null,
      targeting: [
        { x: 5, y: 5, marker: MarkerKind.Aoe, shaded: false },
        { x: 6, y: 5, marker: MarkerKind.Aoe, shaded: false },
      ],
    });
    const marks = blits.filter((b) => b.dw === TILE_PX && b.dh === TILE_PX);
    expect(marks.length).toBeGreaterThanOrEqual(2);
    const a = marks[marks.length - 2];
    const b = marks[marks.length - 1];
    expect(b?.dx ?? 0, 'the two cells are not touching').toBe((a?.dx ?? 0) + TILE_PX);
    expect(b?.dy).toBe(a?.dy);
  });

  it('draws the tile overlays at the cell size too', () => {
    const blits = paint({
      level: SMALL,
      actors: [],
      selfId: null,
      overlays: [{ x: 4, y: 4, kind: MarkerKind.Aoe }],
    });
    expect(blits.some((b) => b.dw === TILE_PX && b.dh === TILE_PX)).toBe(true);
    expect(blits.some((b) => b.dw === WRONG_SIZE)).toBe(false);
  });

  it('puts the ring under a body at the cell size and the body at its own', () => {
    /**
     * BOTH HALVES, because the fix must not become "scale everything". A ring is
     * a cell; the creature standing in it is a body, is allowed to be bigger
     * than its cell, and is anchored by its feet.
     */
    const blits = paint({
      level: SMALL,
      selfId: 'a',
      actors: [
        {
          id: 'a',
          x: 5,
          y: 5,
          kind: 'player',
          sprite: 'chr_player_watchman_s',
          alive: true,
          hp: 10,
          maxHp: 10,
          name: 'Ren',
        },
      ],
    });
    // The ring: a cell-sized blit.
    expect(blits.some((b) => b.dw === TILE_PX && b.dh === TILE_PX)).toBe(true);
    // The token: drawn at the sprite's OWN size, which is what `blitSprite`
    // promises and what a body is entitled to. Here that is deliberately the
    // wrong size for a cell, and it stays that way.
    expect(blits.some((b) => b.dw === WRONG_SIZE && b.dh === WRONG_SIZE)).toBe(true);
  });

  it('names every mark that is one cell, so a new one cannot be missed', () => {
    /**
     * A LIST IS A POOR TEST AND A GOOD LEDGER. It does not prove the renderer
     * draws these correctly — the cases above do that — it records WHICH ids
     * are cell marks, so that adding a fourteenth without deciding is a
     * conversation rather than a silent half-size square.
     */
    expect(CELL_MARKS).toHaveLength(13);
    for (const kind of Object.values(MarkerKind)) {
      expect(CELL_MARKS, `MarkerKind.${kind} is not in the ledger`).toContain(
        `ui_tile_marker_${kind}`,
      );
    }
  });
});
