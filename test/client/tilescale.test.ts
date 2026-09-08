/// <reference lib="dom" />

// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

import { describe, expect, it } from 'vitest';

import { DEFAULT_VIEWPORT, viewLayout } from '../../src/client/render/canvas.ts';
import { TILE_PX, ZOOM_MAX, ZOOM_MIN } from '../../src/shared/version.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * HOW BIG A CELL IS ON THE SCREEN — WHICH IS THE WHOLE OF THE COMPLAINT.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * "The cell size in Inner Datum seems much smaller than Tales of Maj'Eyal. I
 * want the world to feel bigger." The answer is two constants and NEITHER of
 * them is obvious on its own:
 *
 *   `TILE_PX` alone does almost nothing. A cell on screen is `TILE_PX * scale`
 *   and `scale` is `floor(device / (minTiles * TILE_PX))`, so the constant
 *   appears on both sides and very nearly cancels — raising it to 64 without
 *   touching the viewport makes the world SMALLER on some windows, because the
 *   coarser quantisation loses more to the floor.
 *
 *   `DEFAULT_VIEWPORT` is the lever, and it only became a free one once the
 *   interface stopped sharing the map's scale — see hudscale.test.ts.
 *
 * So this file asserts the two together, in CSS pixels per cell, which is the
 * unit a player actually experiences. Device pixels are not it: at dpr 2 a
 * 128-pixel cell and a 64-pixel one look identical apart from sharpness.
 */

type Window = {
  readonly deviceW: number;
  readonly deviceH: number;
  readonly dpr: number;
  readonly name: string;
  /** CSS pixels per cell, and the cells across and down, as shipped. */
  readonly css: number;
  readonly tilesW: number;
  readonly tilesH: number;
};

const WINDOWS: readonly Window[] = [
  {
    deviceW: 2318,
    deviceH: 1102,
    dpr: 2,
    name: 'the reported window, 1159x551 at dpr 2',
    css: 64,
    tilesW: 18,
    tilesH: 8,
  },
  {
    deviceW: 1248,
    deviceH: 860,
    dpr: 1,
    name: 'Discord activity iframe at dpr 1',
    css: 64,
    tilesW: 19,
    tilesH: 13,
  },
  { deviceW: 1920, deviceH: 1080, dpr: 1, name: '1080p', css: 64, tilesW: 30, tilesH: 16 },
  { deviceW: 2560, deviceH: 1440, dpr: 1, name: '1440p', css: 128, tilesW: 20, tilesH: 11 },
  { deviceW: 3840, deviceH: 2160, dpr: 2, name: '4K at dpr 2', css: 96, tilesW: 20, tilesH: 11 },
  { deviceW: 5120, deviceH: 1440, dpr: 1, name: 'ultrawide', css: 128, tilesW: 30, tilesH: 11 },
  /**
   * WAS 16 ACROSS, AND 16 × 64 IS 1024 IN AN 800-PIXEL WINDOW.
   *
   * The buffer used to floor at `DEFAULT_VIEWPORT`'s 16 columns whether or not
   * the window could hold them, so `offsetX` went negative and 112 pixels of map
   * were cut off each side. This row pinned that as correct, which is why it had
   * to change: `viewLayout` now takes as many whole tiles as FIT.
   *
   * The same floor on the vertical axis is what put two thirds of a player's own
   * sprite above the top of the screen at 1262×428 — see the note on `fitTilesH`
   * in render/canvas.ts, and `the map never overflows the window` below.
   */
  { deviceW: 800, deviceH: 600, dpr: 1, name: 'a small window', css: 64, tilesW: 12, tilesH: 9 },
];

/**
 * THE LAYOUT AS IT SHIPPED BEFORE, written out as it was.
 *
 * Not a restatement of the code under test — it is the OLD code with its three
 * literals: `TILE_PX` 32, `DEFAULT_VIEWPORT` 20x10, `MAX_TILES_*` 48x32. It is
 * what makes "bigger" a comparison rather than an adjective.
 */
function asItShipped(deviceW: number, deviceH: number): { css: number; tilesW: number } {
  const scale = Math.max(1, Math.floor(Math.min(deviceW / (20 * 32), deviceH / (10 * 32))));
  const tilesW = Math.min(48, Math.max(20, Math.floor(deviceW / (32 * scale))));
  return { css: 32 * scale, tilesW };
}

describe('how big a cell is', () => {
  it('is what the shipped constants say, at every window in the table', () => {
    for (const w of WINDOWS) {
      const got = viewLayout(w.deviceW, w.deviceH, DEFAULT_VIEWPORT, 0, w.dpr);
      expect((TILE_PX * got.scale) / w.dpr, `${w.name} cell`).toBe(w.css);
      expect(got.logicalW / TILE_PX, `${w.name} across`).toBe(w.tilesW);
      expect(got.logicalH / TILE_PX, `${w.name} down`).toBe(w.tilesH);
    }
  });

  it('is never below the 64 pixels upstream draws a cell at', () => {
    /**
     * `tome/class/Game.lua:565-567` falls back to `tw, th = 64, 64`. A cell
     * smaller than that on a dpr-1 screen is this game rendering below the size
     * the art is authored at, which is where the complaint came from: the
     * iframe was showing 32.
     */
    for (const w of WINDOWS) {
      expect(
        (TILE_PX * viewLayout(w.deviceW, w.deviceH, DEFAULT_VIEWPORT, 0, w.dpr).scale) / w.dpr,
        w.name,
      ).toBeGreaterThanOrEqual(64);
    }
  });

  it('is bigger than it shipped on every window where it was under 64', () => {
    /**
     * THE COMPARISON, AND THE EXCEPTION STATED RATHER THAN HIDDEN.
     *
     * Windows that already drew a cell at 64 CSS pixels or more are not
     * improved by this and are not meant to be — 2560x1440 and the 4K case are
     * unchanged in size and changed only in sharpness, because a 64-pixel
     * source at 2x is not a 32-pixel source at 4x.
     *
     * 1920x1080 at dpr 1 goes the other way, 96 -> 64, and that is the honest
     * outcome rather than a regression to tune away: 64 real pixels a cell IS
     * what upstream looks like at 1080p, and the 96 was this project's 32-pixel
     * art blown up three times.
     */
    let improved = 0;
    for (const w of WINDOWS) {
      const before = asItShipped(w.deviceW, w.deviceH);
      const after =
        (TILE_PX * viewLayout(w.deviceW, w.deviceH, DEFAULT_VIEWPORT, 0, w.dpr).scale) / w.dpr;
      const beforeCss = before.css / w.dpr;
      if (beforeCss < 64) {
        expect(after, `${w.name} was ${String(beforeCss)}`).toBeGreaterThan(beforeCss);
        improved += 1;
      } else if (w.deviceW === 1920) {
        expect(after).toBeLessThan(beforeCss);
      } else {
        expect(after, `${w.name} should be unchanged`).toBe(beforeCss);
      }
    }
    // Not vacuous: three of the seven were below upstream's cell size.
    expect(improved).toBe(3);
  });

  it('shows fewer cells where it shows bigger ones', () => {
    /**
     * The other half of the same fact, and the one a player feels as "the world
     * is bigger": the map used to spend a window's surplus on MORE cells, so
     * the iframe drew 39 across. `engine/Map.lua:153-154` is the same quantity
     * upstream recomputes — `viewport.mwidth`, the count of cells in a fixed
     * rectangle.
     */
    const iframe = viewLayout(1248, 860, DEFAULT_VIEWPORT, 0, 1);
    expect(asItShipped(1248, 860).tilesW).toBe(39);
    expect(iframe.logicalW / TILE_PX).toBe(19);
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE MAP NEVER OVERFLOWS THE WINDOW, AND YOUR OWN BODY IS NEVER CUT OFF.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `viewLayout` used to floor the tile count at `DEFAULT_VIEWPORT`, arguing
 * "never show LESS than was asked for". That is right whenever the window can
 * hold the request and silently wrong when it cannot: the backbuffer is then
 * bigger than the canvas, `offset*` goes negative, and the edges of the map are
 * simply gone.
 *
 * WHICH INCLUDES YOU. `cameraAxis` CLAMPS at the level edge rather than
 * centring — it has to, or the camera would show the void beyond the map — so a
 * player standing on the top row of a level is drawn at backbuffer y 0. At
 * 1262×428, where `offsetY` was -42, that put screen y at -42: two thirds of
 * your own character above the top of the screen, on the window this game is
 * actually played in.
 *
 * The two assertions are separate because they fail for different reasons. The
 * first is arithmetic about the buffer; the second is what a player sees, and
 * it is the one that would still catch this if somebody re-introduced the floor
 * somewhere other than here.
 */
describe('the map never overflows the window', () => {
  const EDGES: readonly (readonly [number, number, number])[] = [
    [1262, 428, 1],
    [1280, 720, 1],
    [1920, 1080, 1],
    [2318, 1102, 2],
    [800, 600, 1],
    [640, 320, 1],
  ];

  it('draws no more map than the canvas can hold, at any zoom', () => {
    for (const [w, h, dpr] of EDGES) {
      for (const zoom of [ZOOM_MIN, 0, ZOOM_MAX]) {
        const got = viewLayout(w, h, DEFAULT_VIEWPORT, zoom, dpr);
        expect(
          got.logicalW * got.scale,
          `${String(w)}x${String(h)} zoom ${String(zoom)} too wide`,
        ).toBeLessThanOrEqual(w);
        expect(
          got.logicalH * got.scale,
          `${String(w)}x${String(h)} zoom ${String(zoom)} too tall`,
        ).toBeLessThanOrEqual(h);
        // The letterbox is what centres it, and it cannot be negative if the
        // two above hold — asserted anyway, because it is the number the
        // painter actually uses.
        expect(got.offsetX, `${String(w)}x${String(h)} offsetX`).toBeGreaterThanOrEqual(0);
        expect(got.offsetY, `${String(w)}x${String(h)} offsetY`).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('keeps a player standing on a level edge fully on screen', () => {
    /**
     * The camera arithmetic `cameraAxis` performs, at the one position that
     * exposes the clamp: the top-left corner of a level far bigger than the
     * view. A centred camera would hide this — the bug only appears where the
     * clamp stops the camera following.
     */
    const world = 100 * TILE_PX;
    for (const [w, h, dpr] of EDGES) {
      const got = viewLayout(w, h, DEFAULT_VIEWPORT, 0, dpr);
      const camY = Math.min(
        Math.max(Math.floor(TILE_PX / 2 - got.logicalH / 2), 0),
        world - got.logicalH,
      );
      const top = (0 * TILE_PX - camY) * got.scale + got.offsetY;
      expect(
        top,
        `${String(w)}x${String(h)}: the player's own tile starts above the screen`,
      ).toBeGreaterThanOrEqual(0);
      expect(
        top + TILE_PX * got.scale,
        `${String(w)}x${String(h)}: the player's own tile ends below the screen`,
      ).toBeLessThanOrEqual(h);
    }
  });
});
