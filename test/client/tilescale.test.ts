/// <reference lib="dom" />

// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

import { describe, expect, it } from 'vitest';

import { DEFAULT_VIEWPORT, viewLayout } from '../../src/client/render/canvas.ts';
import { TILE_PX } from '../../src/shared/version.ts';

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
  { deviceW: 800, deviceH: 600, dpr: 1, name: 'a small window', css: 64, tilesW: 16, tilesH: 9 },
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
