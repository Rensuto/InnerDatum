/// <reference lib="dom" />

// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

import { describe, expect, it } from 'vitest';

import { DEFAULT_VIEWPORT, viewLayout } from '../../src/client/render/canvas.ts';
import { TILE_PX, ZOOM_MAX, ZOOM_MIN } from '../../src/shared/version.ts';
import type { Viewport } from '../../src/client/render/canvas.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ZOOMING THE MAP RESIZED THE WHOLE GAME.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The HUD painted into the MAP's backbuffer, so what a player saw of the
 * interface was `hudLogicalPx * scale` — the map's integer magnification. Two
 * things followed and both are wrong:
 *
 *   PRESSING `=` DID NOT MAGNIFY THE MAP. It magnified the map and the hotbar
 *   and the party strip and every panel, together, as if the window had shrunk.
 *
 *   EVERY LEVER THAT MADE THE MAP BIGGER MADE THE INTERFACE SMALLER, by exactly
 *   the same factor, because both are `floor(device / (minTiles * TILE_PX))`.
 *
 * Upstream separates them and in this direction: `tome/class/Game.lua:571` is
 * `local map_x, map_y, map_w, map_h = self.uiset:getMapSize()` — the UI SET
 * hands the map its rectangle — and `engine/Map.lua:148-158`'s `setZoom` recomputes
 * only `viewport.mwidth`/`mheight`, the count of CELLS inside a pixel rectangle
 * it does not touch.
 *
 * ═══ WHY THIS TESTS A FUNCTION AND NOT A CANVAS ═══
 * `vitest.config.ts` sets the environment to `node` with deliberately no jsdom,
 * so there is no `createRenderer` to drive — the same ground pathpreview.test.ts
 * stands on, and the same reason `pathCellOrigin` is exported. `viewLayout` is
 * the whole of the sizing arithmetic as a pure function of the device box, and
 * `resize()` does nothing with it but assign the answers.
 */

/**
 * The windows this game is actually played in, in DEVICE pixels.
 *
 * `2318x1102` is not invented: it is 1159x551 CSS at dpr 2, the window the
 * "tiles read smaller than Tales of Maj'Eyal's" report came from and the one
 * `DEFAULT_VIEWPORT`'s own docblock measures against.
 */
const WINDOWS: readonly (readonly [number, number, string])[] = [
  [1248, 860, 'Discord activity iframe, dpr 1'],
  [2318, 1102, 'the reported window, 1159x551 at dpr 2'],
  [1920, 1080, '1080p fullscreen'],
  [2560, 1440, '1440p'],
  [3840, 2160, '4K'],
  [5120, 1440, 'ultrawide'],
  [800, 600, 'a small window'],
  [640, 320, 'the floor, exactly'],
];

/**
 * WHAT THE SHARED BUFFER USED TO GIVE THE INTERFACE, written out as it was.
 *
 * Not a restatement of the new code — it is the OLD code, with the two literals
 * it was built from: `DEFAULT_VIEWPORT` 20x10 at the `TILE_PX` of 32 it was
 * written against. Every case below asserts the interface still lands exactly
 * here, which is what makes this a pure decoupling rather than a change of
 * appearance, and which is what will fail the day the map's cell size moves and
 * takes the interface with it.
 */
function scaleTheSharedBufferGave(deviceW: number, deviceH: number): number {
  return Math.max(1, Math.floor(Math.min(deviceW / (20 * 32), deviceH / (10 * 32))));
}

describe('the interface has its own scale', () => {
  it('does not move when the map is zoomed, at any window', () => {
    for (const [w, h, name] of WINDOWS) {
      const out = viewLayout(w, h, DEFAULT_VIEWPORT, ZOOM_MIN);
      const mid = viewLayout(w, h, DEFAULT_VIEWPORT, 0);
      const inn = viewLayout(w, h, DEFAULT_VIEWPORT, ZOOM_MAX);
      for (const [label, got] of [
        ['out', out],
        ['in', inn],
      ] as const) {
        expect(got.hudScale, `${name} zoomed ${label}`).toBe(mid.hudScale);
        expect(got.hudW, `${name} zoomed ${label}`).toBe(mid.hudW);
        expect(got.hudH, `${name} zoomed ${label}`).toBe(mid.hudH);
      }
    }
  });

  it('and the zoom it ignores is one the MAP really answers', () => {
    /**
     * THE OTHER HALF OF THE CLAIM ABOVE, and the half that stops it passing
     * vacuously: "the interface did not move" is worthless if nothing moved.
     * Zoom must still be a live control on the map, at the window the game is
     * played in.
     */
    const out = viewLayout(2318, 1102, DEFAULT_VIEWPORT, ZOOM_MIN);
    const mid = viewLayout(2318, 1102, DEFAULT_VIEWPORT, 0);
    const inn = viewLayout(2318, 1102, DEFAULT_VIEWPORT, ZOOM_MAX);
    expect(out.scale).toBeLessThan(mid.scale);
    expect(inn.scale).toBeGreaterThan(mid.scale);
    // And fewer tiles fit as it grows — the thing `engine/Map.lua:153-154` recomputes.
    expect(inn.logicalW / TILE_PX).toBeLessThan(mid.logicalW / TILE_PX);
  });

  it('lands exactly where the shared buffer used to put it', () => {
    for (const [w, h, name] of WINDOWS) {
      const got = viewLayout(w, h, DEFAULT_VIEWPORT, 0);
      expect(got.hudScale, name).toBe(scaleTheSharedBufferGave(w, h));
    }
  });

  it('is never smaller than the box every panel is laid out against', () => {
    /**
     * `ui/hotbar.ts`, `ui/xpbar.ts` and `ui/talents.ts` all size themselves
     * against a 640-pixel floor in prose. A window below it is cropped rather
     * than allowed to shrink the box — the same rule the map has always had for
     * its minimum viewport, and the reason those panels' arithmetic is still
     * true after the split.
     */
    for (const [w, h, name] of WINDOWS) {
      const got = viewLayout(w, h, DEFAULT_VIEWPORT, 0);
      expect(got.hudW, `${name} width`).toBeGreaterThanOrEqual(640);
      expect(got.hudH, `${name} height`).toBeGreaterThanOrEqual(320);
    }
    const tiny = viewLayout(320, 200, DEFAULT_VIEWPORT, 0);
    expect(tiny.hudW).toBe(640);
    expect(tiny.hudH).toBe(320);
  });

  it('does not move when the MAP changes how big its cells are', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE POINT OF THE WHOLE SPLIT, AND THE ONE ASSERTION THAT LOOKS FORWARD.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `TILE_PX` is a module constant a test cannot vary, but the map's floor is
     * `minTiles * TILE_PX` — so halving the tile count is the same lever as
     * doubling the cell, and it moves the map by exactly the factor a cell size
     * change would. The interface must not follow it anywhere.
     */
    const half: Viewport = { tilesW: 10, tilesH: 5 };
    for (const [w, h, name] of WINDOWS) {
      const wide = viewLayout(w, h, DEFAULT_VIEWPORT, 0);
      const tight = viewLayout(w, h, half, 0);
      expect(tight.hudScale, `${name} scale`).toBe(wide.hudScale);
      expect(tight.hudW, `${name} width`).toBe(wide.hudW);
      expect(tight.hudH, `${name} height`).toBe(wide.hudH);
    }
    // And again: not vacuous. The map really did move.
    expect(viewLayout(2318, 1102, half, 0).scale).toBeGreaterThan(
      viewLayout(2318, 1102, DEFAULT_VIEWPORT, 0).scale,
    );
  });

  it('covers the window the map letterboxes', () => {
    /**
     * The map is CENTRED and may leave bars; the interface is blitted at the
     * origin and fills the box. That is why `backbufferPoint` has no letterbox
     * term any more: at any window where `offsetX` is not zero, undoing the
     * map's offset would put a click on the hotbar out by `offsetX / scale`.
     */
    let sawALetterbox = false;
    for (const [w, h, name] of WINDOWS) {
      const got = viewLayout(w, h, DEFAULT_VIEWPORT, 0);
      if (got.offsetX > 0 || got.offsetY > 0) sawALetterbox = true;
      // Within one interface pixel of the whole device box, unless the floor
      // clamped it up — in which case it is larger, and cropped.
      expect(got.hudW * got.hudScale, `${name} width`).toBeGreaterThanOrEqual(
        Math.min(w, got.hudScale * 640) - got.hudScale,
      );
      expect(got.hudH * got.hudScale, `${name} height`).toBeGreaterThanOrEqual(
        Math.min(h, got.hudScale * 320) - got.hudScale,
      );
    }
    expect(sawALetterbox, 'no window in the table letterboxes the map').toBe(true);
  });
});
