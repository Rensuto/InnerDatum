/// <reference lib="dom" />

// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_VIEWPORT,
  HUD_MIN_H,
  HUD_MIN_W,
  viewLayout,
} from '../../src/client/render/canvas.ts';
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
const WINDOWS: readonly (readonly [number, number, number, string])[] = [
  [1248, 860, 1, 'Discord activity iframe, dpr 1'],
  [2318, 1102, 2, 'the reported window, 1159x551 at dpr 2'],
  [1619, 757, 1, 'the window the UI was called massive on'],
  [1920, 1080, 1, '1080p fullscreen'],
  [2560, 1440, 1, '1440p'],
  [3840, 2160, 2, '4K'],
  [5120, 1440, 1, 'ultrawide'],
  [800, 600, 1, 'a small window'],
  [640, 320, 1, 'the floor, exactly'],
];

/**
 * WHAT THE SHARED BUFFER USED TO GIVE THE INTERFACE, written out as it was.
 *
 * Not a restatement of the code under test — it is the OLD code, with the two
 * literals it was built from: `DEFAULT_VIEWPORT` 20x10 at the `TILE_PX` of 32
 * it was written against.
 *
 * It is kept because the interface no longer lands here ON PURPOSE, and the
 * comparison is the claim. That rule made the factor a function of the WINDOW,
 * so a bigger screen meant a bigger hotbar — 6x on a 4K display, laid out in a
 * 640x360 box. Reported as *"the UI is massive at this zoom level"*.
 */
function scaleTheSharedBufferGave(deviceW: number, deviceH: number): number {
  return Math.max(1, Math.floor(Math.min(deviceW / (20 * 32), deviceH / (10 * 32))));
}

describe('the interface has its own scale', () => {
  it('does not move when the map is zoomed, at any window', () => {
    for (const [w, h, dpr, name] of WINDOWS) {
      const out = viewLayout(w, h, DEFAULT_VIEWPORT, ZOOM_MIN, dpr);
      const mid = viewLayout(w, h, DEFAULT_VIEWPORT, 0, dpr);
      const inn = viewLayout(w, h, DEFAULT_VIEWPORT, ZOOM_MAX, dpr);
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
    const out = viewLayout(2318, 1102, DEFAULT_VIEWPORT, ZOOM_MIN, 2);
    const mid = viewLayout(2318, 1102, DEFAULT_VIEWPORT, 0, 2);
    const inn = viewLayout(2318, 1102, DEFAULT_VIEWPORT, ZOOM_MAX, 2);
    expect(out.scale).toBeLessThan(mid.scale);
    expect(inn.scale).toBeGreaterThan(mid.scale);
    // And fewer tiles fit as it grows — the thing `engine/Map.lua:153-154` recomputes.
    expect(inn.logicalW / TILE_PX).toBeLessThan(mid.logicalW / TILE_PX);
  });

  it('is a constant physical size — the device ratio, not the window', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE RULE, AND THE ONE IT REPLACED.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `round(dpr)`, so a 12-pixel label is 12 CSS pixels at dpr 1 and 12 CSS
     * pixels at dpr 2 — which is what the ratio is for. Capped so the box may
     * not exceed `HUD_MAX_*`, or the interface becomes a postage stamp on a
     * very large display.
     *
     * Upstream does the same thing by construction: `tome/class/Game.lua:571`
     * asks `self.uiset:getMapSize()`, so the UI takes what it needs and the map
     * gets the rest. A bigger screen there means more MAP.
     */
    for (const [w, h, dpr, name] of WINDOWS) {
      const got = viewLayout(w, h, DEFAULT_VIEWPORT, 0, dpr);
      const capped = Math.max(Math.ceil(w / 1920), Math.ceil(h / 1080));
      expect(got.hudScale, name).toBe(Math.max(1, Math.round(dpr), capped));
      expect(got.hudW, `${name} box width`).toBeLessThanOrEqual(Math.max(1920, HUD_MIN_W));
      expect(got.hudH, `${name} box height`).toBeLessThanOrEqual(Math.max(1080, HUD_MIN_H));
    }
  });

  it('and is smaller than the old rule made it on every window above a laptop', () => {
    /**
     * THE COMPLAINT, AS A COMPARISON. On any window where the old rule reached
     * past 1x, the interface was magnified more than it is now — which is the
     * whole of "the UI is massive". Never larger, on any window in the table.
     */
    let reduced = 0;
    for (const [w, h, dpr, name] of WINDOWS) {
      const got = viewLayout(w, h, DEFAULT_VIEWPORT, 0, dpr);
      const before = scaleTheSharedBufferGave(w, h);
      expect(got.hudScale, `${name} got BIGGER`).toBeLessThanOrEqual(before);
      if (got.hudScale < before) reduced += 1;
    }
    expect(reduced, 'no window was actually improved').toBeGreaterThanOrEqual(5);
  });

  it('gives the panels the height they were starved of', () => {
    /**
     * THE HALF THAT MATTERS MOST, and it is not the width. `ui/inventory.ts`
     * sheds paper-doll rows and `ui/charsheet.ts` drops whole sections when the
     * box is short, and the old rule handed them 360 pixels on ANY screen
     * bigger than a laptop — 1080p, 1440p and 4K all landed on exactly 360.
     */
    for (const [w, h, dpr, name] of WINDOWS) {
      const got = viewLayout(w, h, DEFAULT_VIEWPORT, 0, dpr);
      const before = Math.max(HUD_MIN_H, Math.floor(h / scaleTheSharedBufferGave(w, h)));
      expect(got.hudH, `${name} lost height`).toBeGreaterThanOrEqual(before);
    }
    // 1080p was the worst of them: 360 pixels of interface on a 1080-pixel screen.
    expect(viewLayout(1920, 1080, DEFAULT_VIEWPORT, 0, 1).hudH).toBe(1080);
  });

  it('is never smaller than the box every panel is laid out against', () => {
    /**
     * `ui/hotbar.ts`, `ui/xpbar.ts` and `ui/talents.ts` all size themselves
     * against a 640-pixel floor in prose. A window below it is cropped rather
     * than allowed to shrink the box — the same rule the map has always had for
     * its minimum viewport, and the reason those panels' arithmetic is still
     * true after the split.
     */
    for (const [w, h, dpr, name] of WINDOWS) {
      const got = viewLayout(w, h, DEFAULT_VIEWPORT, 0, dpr);
      expect(got.hudW, `${name} width`).toBeGreaterThanOrEqual(640);
      expect(got.hudH, `${name} height`).toBeGreaterThanOrEqual(320);
    }
    const tiny = viewLayout(320, 200, DEFAULT_VIEWPORT, 0, 1);
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
    for (const [w, h, dpr, name] of WINDOWS) {
      const wide = viewLayout(w, h, DEFAULT_VIEWPORT, 0, dpr);
      const tight = viewLayout(w, h, half, 0, dpr);
      expect(tight.hudScale, `${name} scale`).toBe(wide.hudScale);
      expect(tight.hudW, `${name} width`).toBe(wide.hudW);
      expect(tight.hudH, `${name} height`).toBe(wide.hudH);
    }
    // And again: not vacuous. The map really did move.
    expect(viewLayout(2318, 1102, half, 0, 2).scale).toBeGreaterThan(
      viewLayout(2318, 1102, DEFAULT_VIEWPORT, 0, 2).scale,
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
    for (const [w, h, dpr, name] of WINDOWS) {
      const got = viewLayout(w, h, DEFAULT_VIEWPORT, 0, dpr);
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
