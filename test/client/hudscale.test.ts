/// <reference lib="dom" />

// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_VIEWPORT,
  HUD_MIN_H,
  HUD_MIN_W,
  uiScaleFixed,
  viewLayout,
  zoomFixed,
} from '../../src/client/render/canvas.ts';
import {
  TILE_PX,
  UI_SCALE_MAX,
  UI_SCALE_MIN,
  ZOOM_MAX,
  ZOOM_MIN,
} from '../../src/shared/version.ts';
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

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * AND THE PLAYER CAN NOW MOVE IT — WITHOUT MOVING THE MAP WITH IT.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Asked for in those words: *"we also need to include an option in the settings
 * for UI scaling to lower or increase it."* `hudScale` was computed entirely
 * from the device pixel ratio and `HUD_MAX_*`, with no way for a player to say
 * they wanted the interface bigger.
 *
 * THE WHOLE FILE ABOVE IS THE REASON THIS IS A SECOND STEP AND NOT A SHARED
 * ONE. Zoom and the interface were one factor once, and pressing `=` resized the
 * hotbar and every panel along with the world. These assertions are what stop a
 * future tidy-up from folding the two controls back together.
 */
describe('the interface step', () => {
  const DPR = 1;
  const BOX: readonly [number, number] = [1280, 720];

  function layout(uiScaleStep: number, zoomStep = 0): ReturnType<typeof viewLayout> {
    return viewLayout(BOX[0], BOX[1], DEFAULT_VIEWPORT, zoomStep, DPR, uiScaleStep);
  }

  it('makes the interface larger by drawing fewer logical pixels', () => {
    // `hudScale` is a DIVISOR — `hudW = deviceW / hudScale` — so a bigger factor
    // is a SMALLER logical box and therefore larger furniture. Asserting the box
    // rather than the factor is what keeps this about what a player sees.
    const normal = layout(0);
    const bigger = layout(1);
    expect(bigger.hudScale, 'the step did not reach hudScale').toBeGreaterThan(normal.hudScale);
    expect(bigger.hudW, 'the logical box did not shrink, so nothing got bigger').toBeLessThan(
      normal.hudW,
    );
    expect(bigger.hudH).toBeLessThan(normal.hudH);
  });

  /**
   * THE FLOOR IS NOT NEGOTIABLE. `hudScale` below 1 would draw the interface at
   * a fraction of a device pixel; `Math.max(1, ...)` has always bounded it and
   * the player's step must not be able to defeat that.
   */
  it('never lets a player ask the interface below one device pixel', () => {
    for (const step of [UI_SCALE_MIN, -5, -100]) {
      expect(layout(step).hudScale, `step ${String(step)} went under 1`).toBeGreaterThanOrEqual(1);
    }
  });

  /**
   * ═══ AND IT MUST NOT MOVE THE MAP. THIS IS THE ASSERTION THAT MATTERS ═══
   * Every field the map cares about — its integer magnification and its logical
   * size — has to be identical across the whole interface range. If this ever
   * fails, the two controls have been folded back into one and the bug at the
   * top of this file is back.
   */
  it('leaves the map untouched at every interface step', () => {
    const base = layout(0);
    for (let step = UI_SCALE_MIN; step <= UI_SCALE_MAX; step += 1) {
      const other = layout(step);
      expect(other.scale, `step ${String(step)} moved the map's magnification`).toBe(base.scale);
      expect(other.logicalW, `step ${String(step)} moved the map's width`).toBe(base.logicalW);
      expect(other.logicalH, `step ${String(step)} moved the map's height`).toBe(base.logicalH);
    }
  });

  /** And the converse: zooming the map must still leave the interface alone. */
  it('leaves the interface untouched at every zoom step', () => {
    const base = layout(0, 0);
    for (let zoom = ZOOM_MIN; zoom <= ZOOM_MAX; zoom += 1) {
      expect(layout(0, zoom).hudScale, `zoom ${String(zoom)} moved the interface`).toBe(
        base.hudScale,
      );
    }
  });

  /** Omitting the step is the behaviour every caller had before it existed. */
  it('defaults to the factor viewLayout has always computed', () => {
    expect(viewLayout(BOX[0], BOX[1], DEFAULT_VIEWPORT, 0, DPR).hudScale).toBe(layout(0).hudScale);
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE INTERFACE MAY NOT BE DRAWN LARGER THAN THE WINDOW IT IS IN.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `hudW`/`hudH` floor at `HUD_MIN_W`/`HUD_MIN_H`, so a scale the device cannot
 * honour does not yield a smaller box — it yields a box DRAWN off the screen.
 * What reaches the canvas is `hudW * hudScale`, and when `set_ui_scale` shipped
 * that was 1280 against a 1262-wide window at the first step up: the right edge
 * of the interface past the right edge of the screen.
 *
 * Measured then: +1 overflowed every viewport under 1280 wide, +2 overflowed all
 * five tested. The automatic factor never hit it, which is why it survived
 * review — `round(dpr)` is 1 or 2 on real machines and the `HUD_MAX_*` terms
 * only ever raise the scale on a screen bigger than 1920x1080.
 */
describe('the interface never overflows the window', () => {
  const BOXES: readonly (readonly [number, number])[] = [
    [1280, 720],
    [1262, 428],
    [900, 500],
    [800, 400],
    [HUD_MIN_W, HUD_MIN_H],
  ];

  it('fits at every interface step, on every viewport', () => {
    for (const [w, h] of BOXES) {
      for (let step = UI_SCALE_MIN; step <= UI_SCALE_MAX; step += 1) {
        const l = viewLayout(w, h, DEFAULT_VIEWPORT, 0, 1, step);
        expect(
          l.hudW * l.hudScale,
          `${String(w)}x${String(h)} step ${String(step)} too wide`,
        ).toBeLessThanOrEqual(w);
        expect(
          l.hudH * l.hudScale,
          `${String(w)}x${String(h)} step ${String(step)} too tall`,
        ).toBeLessThanOrEqual(h);
      }
    }
  });

  /**
   * AND THE CAP MUST NOT TOUCH STEP ZERO. Every window keeps exactly the factor
   * it had before an interface step existed, or this "fix" is a silent change to
   * everybody's HUD.
   */
  it('leaves the default factor alone on every viewport', () => {
    for (const [w, h] of BOXES) {
      const withStep = viewLayout(w, h, DEFAULT_VIEWPORT, 0, 1, 0);
      const without = viewLayout(w, h, DEFAULT_VIEWPORT, 0, 1);
      expect(withStep.hudScale, `${String(w)}x${String(h)} moved at step 0`).toBe(without.hudScale);
    }
  });

  /** A window with room still honours the step — the cap is a ceiling, not a lock. */
  it('still grows where there is room for it', () => {
    const base = viewLayout(1280, 720, DEFAULT_VIEWPORT, 0, 1, 0);
    const up = viewLayout(1280, 720, DEFAULT_VIEWPORT, 0, 1, 1);
    expect(
      up.hudScale,
      'a 1280x720 window has room for one step and did not take it',
    ).toBeGreaterThan(base.hudScale);
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A SETTING THAT CANNOT MOVE MUST SAY SO, AND THE MENU ASKS THIS.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The cap above is correct and has a consequence: on a window with no room, all
 * four steps land on the same factor and UI SIZE cycles four WORDS while the
 * screen never changes. `uiScaleFixed` is what the escape menu greys its row on
 * (see `EscapeMenuView.uiScaleFixed`), so it has to be exactly true when that
 * is exactly the case — a flag that guessed would grey a working control or
 * leave a dead one live.
 *
 * DRIVEN AGAINST `viewLayout` ITSELF rather than against a second copy of the
 * arithmetic. The question is "does any step change the factor this function
 * produces", so the check scans every step through the real layout and compares
 * the count of distinct answers. A replica here would be a second opinion, and
 * this repo has been bitten by one of those.
 */
describe('uiScaleFixed', () => {
  // The same five the overflow suite uses, restated rather than hoisted: that
  // list is the set of windows the OVERFLOW must survive, and this one is the
  // set the FLAG must be right about. They agree today and need not tomorrow.
  const BOXES: readonly (readonly [number, number])[] = [
    [1920, 1080],
    [1280, 720],
    [1262, 428],
    [900, 500],
    [800, 400],
    [HUD_MIN_W, HUD_MIN_H],
  ];

  /** Every distinct interface factor `viewLayout` will produce on a window. */
  function factorsOn(w: number, h: number, dpr: number): ReadonlySet<number> {
    const seen = new Set<number>();
    for (let step = UI_SCALE_MIN; step <= UI_SCALE_MAX; step += 1) {
      seen.add(viewLayout(w, h, DEFAULT_VIEWPORT, 0, dpr, step).hudScale);
    }
    return seen;
  }

  it('agrees with viewLayout on every viewport', () => {
    for (const [w, h] of BOXES) {
      for (const dpr of [1, 2]) {
        const only = factorsOn(w, h, dpr).size === 1;
        expect(
          uiScaleFixed(w, h, dpr),
          `${String(w)}x${String(h)} @${String(dpr)}x: ` +
            `${String(factorsOn(w, h, dpr).size)} distinct factor(s)`,
        ).toBe(only);
      }
    }
  });

  /**
   * THE WINDOW THIS GAME IS ACTUALLY PLAYED IN, named rather than derived. It
   * is the case that made the row worth greying, and a regression that gave it
   * range again would mean the overflow cap had been loosened.
   */
  it('is fixed on a 1262x428 window and free on 1280x720', () => {
    expect(uiScaleFixed(1262, 428, 1), '1262x428 has no room for a second factor').toBe(true);
    expect(uiScaleFixed(1280, 720, 1), '1280x720 has room for exactly one step').toBe(false);
  });

  /**
   * THE BOUNDARY, EXACTLY. `HUD_MIN * 2` is the first window that fits a second
   * whole factor, so one pixel short of it in EITHER axis is fixed and the box
   * itself is not.
   */
  it('turns free exactly at twice the interface floor', () => {
    expect(uiScaleFixed(HUD_MIN_W * 2, HUD_MIN_H * 2, 1)).toBe(false);
    expect(uiScaleFixed(HUD_MIN_W * 2 - 1, HUD_MIN_H * 2, 1)).toBe(true);
    expect(uiScaleFixed(HUD_MIN_W * 2, HUD_MIN_H * 2 - 1, 1)).toBe(true);
  });

  /**
   * A HIGH-DPI PHONE-SIZED WINDOW IS NOT FIXED, and this is the case a naive
   * `deviceW < HUD_MIN_W * 2` test would get wrong: `round(dpr)` is 2 there, so
   * the automatic factor is already 2 and SMALLER has somewhere to go even
   * though nothing larger does.
   */
  it('stays free where only the smaller step has room', () => {
    expect(uiScaleFixed(900, 500, 2), 'dpr 2 makes step -1 meaningful').toBe(false);
    expect(factorsOn(900, 500, 2).size, 'exactly two factors: the auto one and one below').toBe(2);
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE MAP'S STEP HAS THE SAME DEAD ZONE, AND NOBODY HAD ASKED.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `uiScaleFixed` above greys the interface step where the window has no room
 * for a second factor. Zoom is the same shape and was never checked: `scale` is
 * `max(1, fit + step)`, so on a window whose fit is already 1, SMALLER clamps
 * straight back and BIGGER needs room for a whole second factor.
 *
 * Measured when this was written — zoom produces exactly ONE map scale on every
 * viewport narrower than 1280, and SMALLER moves nothing on any viewport at
 * all. The 1262x428 window this game is actually played in is one of the dead
 * ones, so the ZOOM row and both its keys did nothing there.
 */
describe('zoomFixed', () => {
  const BOXES: readonly (readonly [number, number])[] = [
    [1920, 1080],
    [1280, 720],
    [1262, 428],
    [900, 500],
    [640, 320],
  ];

  /** Every distinct map scale `viewLayout` will produce on a window. */
  function scalesOn(w: number, h: number): ReadonlySet<number> {
    const seen = new Set<number>();
    for (let z = ZOOM_MIN; z <= ZOOM_MAX; z += 1) {
      seen.add(viewLayout(w, h, DEFAULT_VIEWPORT, z, 1).scale);
    }
    return seen;
  }

  it('agrees with viewLayout on every viewport', () => {
    for (const [w, h] of BOXES) {
      expect(
        zoomFixed(w, h, DEFAULT_VIEWPORT),
        `${String(w)}x${String(h)}: ${String(scalesOn(w, h).size)} distinct map scale(s)`,
      ).toBe(scalesOn(w, h).size === 1);
    }
  });

  /**
   * THE WINDOW THIS GAME IS PLAYED IN, named rather than derived — it is the
   * case that made the row worth greying, and a regression that gave it range
   * back would mean the map scale had changed under everybody.
   */
  it('is fixed on a 1262x428 window and free on 1280x720', () => {
    expect(zoomFixed(1262, 428, DEFAULT_VIEWPORT), '1262x428 has no room to zoom').toBe(true);
    expect(zoomFixed(1280, 720, DEFAULT_VIEWPORT), '1280x720 has room for one step').toBe(false);
  });

  /**
   * AND THE HALF THAT IS TRUE EVERYWHERE. Zooming OUT is dead on every viewport
   * tested, because the fit floors at 1 and cannot go below it. That is not
   * this commit's to fix — it is what `scale`'s floor means — but it is worth
   * pinning, because a change that made SMALLER work would be a change to how
   * big the world looks for everybody and should not pass silently.
   */
  it('never has room to zoom out, on any viewport', () => {
    for (const [w, h] of BOXES) {
      const out = viewLayout(w, h, DEFAULT_VIEWPORT, ZOOM_MIN, 1).scale;
      const normal = viewLayout(w, h, DEFAULT_VIEWPORT, 0, 1).scale;
      expect(out, `${String(w)}x${String(h)} zoomed out below the floor`).toBe(normal);
    }
  });
});
