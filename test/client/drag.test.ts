import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  DRAGGABLE_PANELS,
  DRAG_THRESHOLD_PX,
  DragKind,
  DraggablePanel,
  createPanelOffsets,
  moveIntoBand,
  nextOffset,
  passesThreshold,
  settleOffset,
  PANEL_MIN_H,
  PANEL_MIN_W,
  nextSize,
  resizeIntoBand,
  settleResize,
  sizeIntoBand,
} from '../../src/client/ui/drag.ts';
import { SHEET_TABS, charSheetRect, charSheetRows } from '../../src/client/ui/charsheet.ts';
import type { CharSheetView } from '../../src/client/ui/charsheet.ts';
import { HEADER_H, PANEL_PAD, headerDragRect } from '../../src/client/ui/panel.ts';
import type { PanelOffset } from '../../src/client/ui/drag.ts';
import type { PanelRect } from '../../src/client/ui/panel.ts';

/** An untouched panel. `main.ts` has its own; a test may not reach it. */
const NO_OFFSET: PanelOffset = { dx: 0, dy: 0 };

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE DRAG ARITHMETIC. NO DOM, NO CANVAS, NO POINTER, NO LISTENERS.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * vitest.config.ts is explicit that there is deliberately no jsdom here, and
 * src/client/ui/drag.ts is written so that nothing in it needs one: it is four
 * pure functions and two closed sets. That is the point of the module existing
 * at all — the part of a drag that can be silently WRONG is the arithmetic, and
 * arithmetic can be pinned here rather than found in a session.
 *
 * What is actually at stake in each block:
 *
 *   THE CLAMP        `moveIntoBand` is the one thing standing between a dragged
 *                    escape menu and the hotbar underneath it. If it lets a
 *                    panel out of the band, the four talent keys become
 *                    invisible while the menu is up and the panel-not-modal
 *                    promise (main.ts:1972-1980) is broken by a GESTURE — with
 *                    no code change to review. The degenerate cases matter most:
 *                    a band shorter than the panel must PIN, not invert, or the
 *                    clamp itself throws the panel off the top of the screen.
 *
 *   THE THRESHOLD    Mouse.lua:177 is `> 6`, not `>= 6`. One character decides
 *                    whether a firm click on a close control sometimes shoves
 *                    the window sideways instead of pressing the button.
 *
 *   CLAMP ON READ,   the whole resize answer. Nothing is written on a resize, so
 *   SETTLE ON        one moment at a small viewport cannot overwrite where the
 *   RELEASE          player put the panel. What IS written, once, at the end of a
 *                    gesture, is the offset the clamp honoured — `settleOffset`.
 *                    Leaving the raw pointer delta in the store was a shipped
 *                    bug: the next grab re-based on it while the pointer re-based
 *                    on the clamped position, so an overshoot had to be repaid
 *                    pixel for pixel and the title bar stopped responding.
 *
 *   THE HANDLE       `headerDragRect` must not reach the close control on ANY
 *                    panel, or a drag starts on the button that closes the thing
 *                    being dragged.
 */

/**
 * THE FOUR VIEWPORTS THE SIBLING PANEL TESTS ALREADY USE, verbatim, so a change
 * that breaks the drag on the same window that breaks the inventory panel breaks
 * both tests together rather than one of them: test/client/inventory.test.ts
 * :329-332 and :411-414, test/client/talents.test.ts:250-253.
 *
 * `height` is carried even though `moveIntoBand` never reads it — the band's
 * `bottom` is derived FROM that height by `panelBand` (main.ts:534-541), and a
 * row here with a bottom that could not have come from its own height would be a
 * test passing against a viewport that cannot exist.
 *
 * EVERY `bottom` BELOW IS `height - 137` AND THAT IS ARITHMETIC, NOT TASTE:
 * `HOTBAR_TOTAL_H` 88 + `RESOURCE_H` 18 + `LINE_H` 14 x 2 + `DOCK_MARGIN` 3. The
 * four numbers were stale by six pixels apiece (they were written against the
 * 94-pixel hotbar, before the player asked for a smaller bar) plus whatever they
 * had drifted before that; nothing failed, because `moveIntoBand` is happy with
 * any band it is handed, which is exactly why the derivation has to be written
 * out. `top` legitimately varies per row — it is `hudTop`, which depends on how
 * much turn HUD is up — and is not derivable from `height`.
 */
const VIEWPORTS = [
  { name: '640x480', width: 640, height: 480, top: 17, bottom: 343 },
  { name: '800x600', width: 800, height: 600, top: 96, bottom: 463 },
  { name: '1024x768', width: 1024, height: 768, top: 24, bottom: 631 },
  { name: '1280x720', width: 1280, height: 720, top: 100, bottom: 583 },
] as const;

/** A panel that comfortably fits every band above. Centred, pinned near the top. */
function fittingRect(v: (typeof VIEWPORTS)[number]): PanelRect {
  const w = 300;
  const h = 200;
  return { x: Math.floor((v.width - w) / 2), y: v.top + 4, w, h };
}

const band = (v: (typeof VIEWPORTS)[number]): { top: number; bottom: number } => ({
  top: v.top,
  bottom: v.bottom,
});

const offset = (dx: number, dy: number): PanelOffset => ({ dx, dy });

describe('moveIntoBand', () => {
  it.each(VIEWPORTS)('$name: a zero offset returns the rect unchanged', (v) => {
    const rect = fittingRect(v);
    expect(moveIntoBand(rect, offset(0, 0), band(v), v.width)).toEqual(rect);
  });

  it.each(VIEWPORTS)('$name: a large positive dy pins y to band.bottom - h', (v) => {
    const rect = fittingRect(v);
    const moved = moveIntoBand(rect, offset(0, 9999), band(v), v.width);
    expect(moved.y).toBe(v.bottom - rect.h);
    // The bottom edge lands exactly ON the band's floor and never below it: one
    // pixel past this is one pixel of panel over the resource strip.
    expect(moved.y + moved.h).toBe(v.bottom);
  });

  it.each(VIEWPORTS)('$name: a large negative dy pins y to band.top', (v) => {
    const rect = fittingRect(v);
    expect(moveIntoBand(rect, offset(0, -9999), band(v), v.width).y).toBe(v.top);
  });

  it.each(VIEWPORTS)('$name: dx pins to 0 and to width - w', (v) => {
    const rect = fittingRect(v);
    expect(moveIntoBand(rect, offset(-9999, 0), band(v), v.width).x).toBe(0);

    const right = moveIntoBand(rect, offset(9999, 0), band(v), v.width);
    expect(right.x).toBe(v.width - rect.w);
    expect(right.x + right.w).toBe(v.width);
  });

  it.each(VIEWPORTS)('$name: a small offset is applied verbatim, not snapped', (v) => {
    const rect = fittingRect(v);
    const moved = moveIntoBand(rect, offset(-7, 11), band(v), v.width);
    expect(moved.x).toBe(rect.x - 7);
    expect(moved.y).toBe(rect.y + 11);
  });

  it.each(VIEWPORTS)('$name: w and h are never modified, at any offset', (v) => {
    const rect = fittingRect(v);
    for (const o of [
      offset(0, 0),
      offset(9999, 9999),
      offset(-9999, -9999),
      offset(3, -400),
      offset(-400, 3),
    ]) {
      const moved = moveIntoBand(rect, o, band(v), v.width);
      expect(moved.w).toBe(rect.w);
      expect(moved.h).toBe(rect.h);
    }
  });

  it.each(VIEWPORTS)('$name: a rect taller than the band pins to band.top, never negative', (v) => {
    // Deliberately taller than the band it is being clamped into. The naive
    // min(max(...)) answers `band.bottom - h`, which here is ABOVE band.top and
    // on a short band is negative outright — the clamp throwing the panel off
    // the top of the screen. Reachable in practice: the band is recomputed every
    // frame (main.ts:1904-1906) and the viewport can shrink between the frame
    // that produced the rect and the frame that clamps it.
    const tall: PanelRect = { x: 20, y: v.top, w: 200, h: v.bottom - v.top + 120 };
    for (const o of [offset(0, 0), offset(0, 9999), offset(0, -9999)]) {
      const moved = moveIntoBand(tall, o, band(v), v.width);
      expect(moved.y).toBe(v.top);
      expect(moved.y).toBeGreaterThanOrEqual(0);
      expect(moved.h).toBe(tall.h);
    }
  });

  it.each(VIEWPORTS)('$name: a rect wider than the viewport pins to x 0, never negative', (v) => {
    const wide: PanelRect = { x: 0, y: v.top, w: v.width + 80, h: 100 };
    for (const o of [offset(0, 0), offset(9999, 0), offset(-9999, 0)]) {
      const moved = moveIntoBand(wide, o, band(v), v.width);
      expect(moved.x).toBe(0);
      expect(moved.w).toBe(wide.w);
    }
  });

  it.each(VIEWPORTS)('$name: an exactly band-tall rect sits at band.top, not below it', (v) => {
    // The boundary between the ordinary path and the pin: max === band.top.
    const exact: PanelRect = { x: 10, y: v.top, w: 100, h: v.bottom - v.top };
    expect(moveIntoBand(exact, offset(0, 9999), band(v), v.width).y).toBe(v.top);
    expect(moveIntoBand(exact, offset(0, -9999), band(v), v.width).y).toBe(v.top);
  });

  it.each(VIEWPORTS)('$name: the result is always inside the band and the viewport', (v) => {
    const rect = fittingRect(v);
    for (const o of [
      offset(0, 0),
      offset(1, 1),
      offset(-1, -1),
      offset(5000, 5000),
      offset(-5000, -5000),
      offset(5000, -5000),
      offset(-5000, 5000),
    ]) {
      const moved = moveIntoBand(rect, o, band(v), v.width);
      expect(moved.y).toBeGreaterThanOrEqual(v.top);
      expect(moved.y + moved.h).toBeLessThanOrEqual(v.bottom);
      expect(moved.x).toBeGreaterThanOrEqual(0);
      expect(moved.x + moved.w).toBeLessThanOrEqual(v.width);
    }
  });
});

describe('settleOffset — what a release banks', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE REGRESSION THIS BLOCK EXISTS FOR: A TITLE BAR THAT STOPPED WORKING.
   * ═══════════════════════════════════════════════════════════════════════════
   * The offset used to be stored RAW and never reconciled with the clamp, while
   * the next gesture's grab point came from the CLAMPED position on screen. So
   * every pixel of overshoot was banked permanently and had to be paid back
   * before the panel moved again — and the legal travel is tiny next to a pointer
   * stroke, so one careless sweep bought several completely dead drags.
   *
   * The panel below is the REAL character sheet at the smallest backbuffer this
   * client renders, taken from `charSheetRect` rather than typed out: 1248
   * logical pixels wide (1280 minus the letterbox at integer scale), in a band
   * of top 17 / bottom 343.
   *
   * ═══ ITS SIZE HAS MOVED TWICE AND THESE ASSERTIONS NO LONGER SPELL IT ═══
   * It was 328x268 under a flat 560-pixel cap; then 1185x314 when the sheet took
   * ToME's `util.bound(font_w*200, ...)` sizing (CharacterSheet.lua:50); and it
   * is smaller again now that the panel is sized by the rows it actually draws
   * with that bound kept as a ceiling. Each move rewrote a pile of literals here
   * that were never the subject.
   *
   * SO THE NUMBERS ARE DERIVED FROM THE RECT NOW, not typed. What is asserted is
   * the RELATION -- a release banks the offset the clamp honoured, so the drawn
   * position is identical either way and the next grab re-bases on it. That is
   * true at every panel size, which is the point; the literals only ever recorded
   * which size was current the day they were written.
   *
   * THE TRAVEL IS STILL THE THING UNDER TEST: a panel has only a few pixels of
   * legal movement inside this band next to a pointer stroke of hundreds, and
   * banking the raw offset is what bought several completely dead drags.
   */
  const WIDTH = 1248;
  const BAND = { top: 17, bottom: 343 };
  const sheet = (): PanelRect => {
    // THE PANEL IS SIZED BY ITS ROWS NOW, so a rect cannot be asked for without
    // saying what is on the pages. This file is about DRAGGING rather than
    // layout, so the fixture only has to be a sheet that opens -- but it has to
    // be a real one, because an empty view would size a panel no player sees.
    const view = {
      view: null,
      resource: null,
      loadout: [],
      cooldowns: {},
      progress: null,
      equipped: {},
    } as unknown as CharSheetView;
    const rect = charSheetRect({
      width: WIDTH,
      height: 480,
      top: BAND.top,
      bottom: BAND.bottom,
      pages: SHEET_TABS.map((tab) => charSheetRows(view, tab)),
    });
    if (rect === null) throw new Error('the sheet must fit the smallest band this client renders');
    return rect;
  };

  it('answers the offset the clamp honoured, not the one the pointer reached', () => {
    const rect = sheet();
    // The pointer is hauled to the bottom of the window, hundreds of pixels
    // against a panel with a few of legal travel.
    const raw = nextOffset(offset(0, 0), 600, 50, 600, 473);
    expect(raw.dy).toBe(423);
    const settled = settleOffset(rect, raw, BAND, WIDTH);
    expect(settled.dy).toBe(BAND.bottom - rect.h - rect.y);
    expect(settled.dy, 'the clamp banked the whole sweep').toBeLessThan(raw.dy);
    // ...and the drawn position is identical either way, which is the property
    // that makes settling invisible to the player.
    expect(moveIntoBand(rect, settled, BAND, WIDTH)).toEqual(moveIntoBand(rect, raw, BAND, WIDTH));
  });

  it('the NEXT drag moves the panel — the bug was that it did not', () => {
    const rect = sheet();
    // Gesture 1: grab the title bar at y=50 and sweep to the bottom of the
    // window. The panel lands pinned at the band's floor.
    const first = settleOffset(rect, nextOffset(offset(0, 0), 600, 50, 600, 473), BAND, WIDTH);
    const pinned = moveIntoBand(rect, first, BAND, WIDTH);
    expect(pinned.y, 'the panel did not land on the band floor').toBe(BAND.bottom - rect.h);

    // Gesture 2: grab it again where it now IS — that is the whole point, the
    // pointer re-bases on the drawn position — and drag 100 pixels up.
    const second = nextOffset(first, 600, pinned.y + 8, 600, pinned.y + 8 - 100);
    const moved = moveIntoBand(rect, second, BAND, WIDTH);
    // WITH THE RAW OFFSET BANKED (dy 423) this answered 75 again: a hundred
    // pixels of drag, zero pixels of movement, four times over.
    expect(moved.y).toBeLessThan(pinned.y);
    // A HUNDRED PIXELS OF DRAG BUYS A HUNDRED PIXELS OF MOVEMENT, or as much of
    // it as the band allows. Spelling `BAND.top` here only worked while the
    // panel was big enough that 100 overshot the whole travel.
    expect(moved.y).toBe(Math.max(BAND.top, pinned.y - 100));
  });

  it('is idempotent — settling a settled offset changes nothing', () => {
    // `cancelDrag` restores `offsetAtGrab`, which is always a settled value, and
    // a settle that drifted would move a panel every time a gesture was abandoned.
    const rect = sheet();
    for (const raw of [offset(0, 0), offset(5000, 5000), offset(-5000, -900), offset(-40, 12)]) {
      const once = settleOffset(rect, raw, BAND, WIDTH);
      expect(settleOffset(rect, once, BAND, WIDTH)).toEqual(once);
    }
  });

  it('never banks a position the band would refuse to draw', () => {
    const rect = sheet();
    for (const raw of [offset(9999, 9999), offset(-9999, -9999), offset(0, 300)]) {
      const settled = settleOffset(rect, raw, BAND, WIDTH);
      const drawn = moveIntoBand(rect, settled, BAND, WIDTH);
      expect(drawn.y).toBeGreaterThanOrEqual(BAND.top);
      expect(drawn.y + drawn.h).toBeLessThanOrEqual(BAND.bottom);
      expect(drawn.x).toBeGreaterThanOrEqual(0);
      expect(drawn.x + drawn.w).toBeLessThanOrEqual(WIDTH);
      // The settled offset places the panel where the settle said it would, with
      // no second clamp needed. That is what makes the store a POSITION.
      expect(drawn).toEqual({
        x: rect.x + settled.dx,
        y: rect.y + settled.dy,
        w: rect.w,
        h: rect.h,
      });
    }
  });

  it('a settled offset still survives a shrink and a restore', () => {
    // The resize answer is untouched by settling, because settling happens on
    // RELEASE and a resize writes nothing at all.
    const rect = sheet();
    const settled = settleOffset(rect, offset(200, 9999), BAND, WIDTH);
    // DERIVED SO IT IS ACTUALLY TOO SHORT. This was a literal `bottom: 200`,
    // which stopped being shorter than the panel the moment the sheet was sized
    // by its rows -- and a band that fits is not testing the pinning branch.
    const short = { top: 17, bottom: 17 + rect.h - 20 };
    const shrunk = moveIntoBand(rect, settled, short, 400);
    // Too short to hold the panel: it pins to the top rather than inverting, and
    // the stored offset is not rewritten by that.
    expect(shrunk.y).toBe(short.top);
    expect(moveIntoBand(rect, settled, BAND, WIDTH).y).toBe(rect.y + settled.dy);
  });
});

describe('passesThreshold', () => {
  it('is 6, matching Mouse.lua:177', () => {
    expect(DRAG_THRESHOLD_PX).toBe(6);
  });

  it('exactly 6px is FALSE — upstream is `> 6`, not `>= 6`', () => {
    // In x, in y, and diagonally. A `>=` here makes a firm click on a header
    // control sometimes move the panel instead of pressing the control.
    expect(passesThreshold(100, 100, 106, 100)).toBe(false);
    expect(passesThreshold(100, 100, 100, 106)).toBe(false);
    expect(passesThreshold(100, 100, 106, 106)).toBe(false);
  });

  it('7px is TRUE, in x, in y and diagonally', () => {
    expect(passesThreshold(100, 100, 107, 100)).toBe(true);
    expect(passesThreshold(100, 100, 100, 107)).toBe(true);
    expect(passesThreshold(100, 100, 107, 107)).toBe(true);
  });

  it('negative deltas behave exactly the same — it is an absolute distance', () => {
    expect(passesThreshold(100, 100, 94, 100)).toBe(false);
    expect(passesThreshold(100, 100, 100, 94)).toBe(false);
    expect(passesThreshold(100, 100, 94, 94)).toBe(false);
    expect(passesThreshold(100, 100, 93, 100)).toBe(true);
    expect(passesThreshold(100, 100, 100, 93)).toBe(true);
    expect(passesThreshold(100, 100, 93, 93)).toBe(true);
  });

  it('is CHEBYSHEV, not Euclidean', () => {
    // 5,5 is 7.07 apart as the crow flies and would pass a Euclidean test; it is
    // 5 apart in Chebyshev and upstream keeps it a click.
    expect(passesThreshold(0, 0, 5, 5)).toBe(false);
    // 0,7 fails a "both axes" reading and passes upstream's max().
    expect(passesThreshold(0, 0, 0, 7)).toBe(true);
  });

  it('a press that does not move at all is a click', () => {
    expect(passesThreshold(42, 42, 42, 42)).toBe(false);
  });
});

describe('nextOffset composed with moveIntoBand', () => {
  it('accumulates from the offset captured at the grab, not from zero', () => {
    const at = offset(10, -4);
    expect(nextOffset(at, 200, 200, 230, 180)).toEqual({ dx: 40, dy: -24 });
  });

  it('is raw and unclamped — it never consults a band', () => {
    expect(nextOffset(offset(0, 0), 0, 0, 100000, -100000)).toEqual({
      dx: 100000,
      dy: -100000,
    });
  });

  it.each(VIEWPORTS)('$name: dragging to each band edge lands the panel on that edge', (v) => {
    const rect = fittingRect(v);
    const b = band(v);
    // Grab the header at some point inside the panel and haul the pointer well
    // past each edge in turn. The raw offset is enormous; the clamp is what
    // makes the result land exactly on the edge.
    const grabX = rect.x + 20;
    const grabY = rect.y + 8;

    const top = moveIntoBand(
      rect,
      nextOffset(offset(0, 0), grabX, grabY, grabX, -5000),
      b,
      v.width,
    );
    expect(top.y).toBe(b.top);

    const bottom = moveIntoBand(
      rect,
      nextOffset(offset(0, 0), grabX, grabY, grabX, 5000),
      b,
      v.width,
    );
    expect(bottom.y).toBe(b.bottom - rect.h);

    const left = moveIntoBand(
      rect,
      nextOffset(offset(0, 0), grabX, grabY, -5000, grabY),
      b,
      v.width,
    );
    expect(left.x).toBe(0);

    const right = moveIntoBand(
      rect,
      nextOffset(offset(0, 0), grabX, grabY, 5000, grabY),
      b,
      v.width,
    );
    expect(right.x).toBe(v.width - rect.w);
  });

  it.each(VIEWPORTS)(
    '$name: clamping is idempotent — clamping a clamped rect moves nothing',
    (v) => {
      const rect = fittingRect(v);
      const b = band(v);
      for (const o of [offset(0, 0), offset(5000, 5000), offset(-5000, -5000), offset(-30, 60)]) {
        const once = moveIntoBand(rect, o, b, v.width);
        // Re-clamping the RESULT with a zero offset is what `hudLayout` effectively
        // does on the very next frame when nothing has moved. It must be a no-op,
        // or a panel would creep across the screen while the player sat still.
        expect(moveIntoBand(once, offset(0, 0), b, v.width)).toEqual(once);
      }
    },
  );

  it('a shrunk viewport re-clamps without losing the offset', () => {
    // ═══ CLAMP ON READ — this is the test that says so. ═══
    // A resize writes NOTHING: `hudLayout` runs again against the new band and
    // the stored offset is untouched, which is what makes the restore below
    // exact. (The offset a real gesture leaves behind has been through
    // `settleOffset` first — see that block. The property under test here is the
    // same for either value, and the raw one is the harder case.)
    const big = VIEWPORTS[3]; // 1280x720
    const rect: PanelRect = { x: 490, y: big.top + 4, w: 300, h: 200 };

    // The player hauls the panel to the bottom-right of the big window. The raw
    // offset it settles on is whatever the pointer travel was — here, large.
    const raw = nextOffset(offset(0, 0), 600, 200, 1400, 900);
    const placed = moveIntoBand(rect, raw, band(big), big.width);
    expect(placed.x).toBe(big.width - rect.w);
    expect(placed.y).toBe(big.bottom - rect.h);

    // Now the window shrinks. Nothing recomputes the offset; `hudLayout` just
    // runs again against a smaller band and a narrower viewport.
    const small = VIEWPORTS[0]; // 640x480
    const smallRect: PanelRect = { x: 170, y: small.top + 4, w: 300, h: 200 };
    const shrunk = moveIntoBand(smallRect, raw, band(small), small.width);
    expect(shrunk.x).toBe(small.width - smallRect.w);
    expect(shrunk.y).toBe(small.bottom - smallRect.h);
    expect(shrunk.x).toBeGreaterThanOrEqual(0);
    expect(shrunk.y).toBeGreaterThanOrEqual(small.top);

    // THE RAW OFFSET IS UNTOUCHED BY EITHER CLAMP. Nothing above mutated it, and
    // that is what lets the next assertion hold at all.
    expect(raw).toEqual({ dx: 800, dy: 700 });

    // Restore the big window and the panel is back exactly where the player put
    // it. Had the offset been clamped on WRITE at the small size, this would
    // answer a position the player never chose and there would be no way to tell.
    expect(moveIntoBand(rect, raw, band(big), big.width)).toEqual(placed);
  });

  it('a modest offset survives a shrink and a restore unchanged', () => {
    // The same property at a magnitude that is NOT clamped at the big size, so
    // the restore has a non-edge position to get back to.
    const big = VIEWPORTS[2]; // 1024x768
    const small = VIEWPORTS[0]; // 640x480
    const rect: PanelRect = { x: 362, y: big.top + 4, w: 300, h: 200 };
    const raw = offset(40, 300);

    // At 1024x768 the band is 576 tall and nothing is clamped: the panel sits
    // exactly where the delta says.
    const placed = moveIntoBand(rect, raw, band(big), big.width);
    expect(placed).toEqual({ x: rect.x + 40, y: rect.y + 300, w: 300, h: 200 });

    // At 640x480 the band is 320 tall and the same delta runs off the bottom.
    const smallRect: PanelRect = { x: 170, y: small.top + 4, w: 300, h: 200 };
    const shrunk = moveIntoBand(smallRect, raw, band(small), small.width);
    expect(shrunk.y).toBe(small.bottom - smallRect.h);
    expect(shrunk.x).toBe(smallRect.x + 40);

    // …and the restore is byte-identical to where it was before the shrink.
    expect(moveIntoBand(rect, raw, band(big), big.width)).toEqual(placed);
  });
});

describe('the offset store', () => {
  it('starts all four panels at zero', () => {
    const offsets = createPanelOffsets();
    for (const panel of DRAGGABLE_PANELS) {
      expect(offsets[panel]).toEqual({ dx: 0, dy: 0 });
    }
  });

  it('names exactly the five panels the decision lists, and nothing else', () => {
    /**
     * THE EXCLUSIONS ARE LOAD-BEARING, NOT OMISSIONS: the class picker is a
     * scrimmed full-viewport modal, and the hotbar is the anchor `panelBand`'s
     * bottom is derived from.
     *
     * ═══ THE CASE LOG WAS ON THAT LIST OF EXCLUSIONS AND IS NOW A MEMBER ═══
     * It was excluded because it and the party pane were the two halves of one
     * `rightReserved` handshake — the log was a dock down the right-hand side
     * and the pane sized itself from what the log left. That reason died with
     * the dock: the log is a bottom-left window now (`Minimalist.lua:381`) and
     * reserves nothing from a pane in the top-left, so `rightReserved` is 0 and
     * the two are independent.
     *
     * The pane itself is still excluded, and still for its own reason.
     */
    expect([...DRAGGABLE_PANELS].sort()).toEqual(['inventory', 'log', 'menu', 'sheet', 'talents']);
    expect(Object.keys(createPanelOffsets()).sort()).toEqual([
      'inventory',
      'log',
      'menu',
      'sheet',
      'talents',
    ]);
  });

  it('hands out an independent record each call', () => {
    const a = createPanelOffsets();
    const b = createPanelOffsets();
    a[DraggablePanel.Menu] = offset(12, 12);
    expect(b[DraggablePanel.Menu]).toEqual({ dx: 0, dy: 0 });
  });

  it('DragKind is the five things a drag can carry', () => {
    /**
     * A CLOSED SET, ASSERTED WHOLE. Every drop target in the client switches on
     * this and the compiler checks exhaustiveness — so a fifth member breaks
     * the build in the places that matter, and this test is what says the set
     * was widened ON PURPOSE rather than by a merge.
     *
     * `talent` is the fourth. It arrived with the rebindable bar: the six keyed
     * slots hold a binding rather than `loadout[n]`, so a talent has to be able
     * to travel from the panel to a slot.
     *
     * `resize` IS THE FIFTH, and it is a separate kind rather than a flag on
     * `panel` because the two gestures WRITE DIFFERENT THINGS: a move writes an
     * offset and a resize writes a size. Sharing one kind would put a boolean
     * in front of every settle path and every drop target, which is the shape
     * this union exists to refuse.
     */
    expect(Object.values(DragKind).sort()).toEqual([
      'carried',
      'panel',
      'resize',
      'talent',
      'worn',
    ]);
  });
});

describe('headerDragRect', () => {
  /**
   * WHAT EACH PANEL RESERVES AT THE RIGHT END OF ITS HEADER.
   *
   * Transcribed from the four private `closeRect` helpers — ui/charsheet.ts:689,
   * ui/talents.ts:518, ui/inventory.ts:978, ui/escapemenu.ts:957 — which are all
   * `x: rect.x + rect.w - PANEL_PAD - CLOSE_PX` with `CLOSE_PX = 13`, plus the
   * character sheet's `[G]` control, whose rect is `talentsRect` at
   * ui/charsheet.ts:703-711: it sits `HEADER_BTN_GAP` (3) further left and is
   * `TALENTS_BTN_W` (48, ui/charsheet.ts:266) wide. The sheet's own reservation
   * is composed once at ui/charsheet.ts:731 (`headerHandle`) and this table is
   * the transcription of that sum.
   *
   * They are transcribed rather than imported because they are deliberately
   * private: ui/panel.ts must not become a second authority on where any panel's
   * close control is. If one of those modules moves its control, this table
   * fails, which is the correct place for that to surface.
   *
   * THE 30 BELOW USED TO BE WRONG AND NOTHING CAUGHT IT, which is worth a line of
   * its own: `headerDragRect` is a pure function of the reservation it is handed,
   * so a table that is self-consistent with its own bad constant passes happily
   * while claiming to pin a panel that does not exist. The constant is checked by
   * reading ui/charsheet.ts, and there is no mechanism that does it for us.
   */
  const CLOSE_PX = 13;
  const HEADER_BTN_GAP = 3;
  const TALENTS_BTN_W = 48;
  const RESERVED = [
    { panel: 'sheet', reserved: PANEL_PAD + CLOSE_PX + HEADER_BTN_GAP + TALENTS_BTN_W },
    { panel: 'talents', reserved: PANEL_PAD + CLOSE_PX },
    { panel: 'inventory', reserved: PANEL_PAD + CLOSE_PX },
    { panel: 'menu', reserved: PANEL_PAD + CLOSE_PX },
  ] as const;

  /** The leftmost control in that panel's header, in the same terms. */
  function leftmostControlX(rect: PanelRect, panel: string): number {
    const closeX = rect.x + rect.w - PANEL_PAD - CLOSE_PX;
    return panel === 'sheet' ? closeX - HEADER_BTN_GAP - TALENTS_BTN_W : closeX;
  }

  it.each(RESERVED)('$panel: the handle never reaches the controls', ({ panel, reserved }) => {
    for (const v of VIEWPORTS) {
      const rect = fittingRect(v);
      const handle = headerDragRect(rect, reserved);
      expect(handle.x).toBe(rect.x);
      expect(handle.y).toBe(rect.y);
      // The one assertion that matters: the handle's right edge stops at or
      // before the leftmost control. One pixel over and a press on the close
      // button starts a drag, which then closes the panel it just moved.
      expect(handle.x + handle.w).toBeLessThanOrEqual(leftmostControlX(rect, panel));
    }
  });

  it.each(RESERVED)('$panel: height is exactly HEADER_H', ({ reserved }) => {
    for (const v of VIEWPORTS) {
      expect(headerDragRect(fittingRect(v), reserved).h).toBe(HEADER_H);
      // Not "about" HEADER_H: a handle taller than the strip makes the first row
      // of the body draggable, so a click meant for a talent row moves the panel.
      expect(headerDragRect(fittingRect(v), reserved).h).toBe(24);
    }
  });

  it('leaves a usable handle on a real panel — this is not a zero-width strip', () => {
    // The sheet reserves the most (5 + 13 + 3 + 48 = 69px) and is the narrowest
    // case in practice.
    const rect: PanelRect = { x: 0, y: 0, w: 180, h: 200 };
    expect(PANEL_PAD + CLOSE_PX + HEADER_BTN_GAP + TALENTS_BTN_W).toBe(69);
    expect(headerDragRect(rect, PANEL_PAD + CLOSE_PX + HEADER_BTN_GAP + TALENTS_BTN_W).w).toBe(111);
  });

  it('floors at zero rather than going negative on a panel narrower than its controls', () => {
    // A negative width would pass nothing at hit test but would still be handed
    // to fillRect, and a negative-width highlight is a debugging afternoon.
    expect(headerDragRect({ x: 4, y: 4, w: 10, h: 40 }, 51).w).toBe(0);
    expect(headerDragRect({ x: 4, y: 4, w: 0, h: 40 }, 18).w).toBe(0);
  });

  it('ignores a negative reservedRight rather than growing past the panel', () => {
    // Nobody should pass one; if somebody does, the handle is the whole strip and
    // not the strip plus overhang into the panel beside it.
    expect(headerDragRect({ x: 0, y: 0, w: 200, h: 100 }, -40).w).toBe(200);
  });

  it('a zero reservation is the whole strip', () => {
    const handle = headerDragRect({ x: 7, y: 9, w: 200, h: 100 }, 0);
    expect(handle).toEqual({ x: 7, y: 9, w: 200, h: HEADER_H });
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * RESIZING A PANEL — the size half of a gesture whose position half is above.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Ported from `Minimalist.lua:596-605`. Upstream floors each axis at 20 during
 * the drag and bounds the box at drag END, from `saveSettings` -> `boundPlaces`
 * (`:393-395`); the split is deliberate there and is kept here, because a box
 * that stopped following the pointer mid-gesture reads as the drag breaking.
 */
describe('nextSize', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * ABSOLUTE, LIKE `Minimalist.lua:600-601`. It was a delta, and that was half
   * the resize bug.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   *     places[id].w = math.max(20, x - places[id].x + drag.payload.ox)
   *
   * The size comes from where the pointer IS relative to the panel's own origin,
   * plus how far into the handle the grab landed — never from an accumulated
   * `sizeAtGrab + (x - grabX)`.
   */
  const ORIGIN = { x: 100, y: 100 };
  /** Grabbed exactly on the panel's bottom-right corner: no inset. */
  const CORNER = { dx: 0, dy: 0 };

  it('sizes from the pointer, measured off the panel’s own origin', () => {
    expect(nextSize(ORIGIN, CORNER, 440, 330)).toEqual({ w: 340, h: 230 });
  });

  it('keeps the grabbed pixel under the pointer', () => {
    /**
     * `ox` upstream. A press 5px inside the grip must not snap the corner to the
     * pointer — the box should be 5px smaller than the pointer's own offset, so
     * the pixel under the cursor stays under it.
     */
    const inset = { dx: -5, dy: -3 };
    expect(nextSize(ORIGIN, inset, 440, 330)).toEqual({ w: 345, h: 233 });
  });

  it('is a function of the pointer, not of the last frame', () => {
    /**
     * The same purity `nextOffset` has and for the same reason: a dropped frame
     * must not cost the gesture anything. Stronger here than it was under the
     * delta form — there is no accumulated state left for a dropped frame to
     * corrupt.
     */
    const a = nextSize(ORIGIN, CORNER, 460, 200);
    const b = nextSize(ORIGIN, CORNER, 460, 200);
    expect(a).toEqual(b);
  });

  it('floors each axis independently, like upstream', () => {
    // `w = math.max(20, ...)` and `h = math.max(20, ...)` are two separate
    // statements up there — dragging the corner past the left edge must not
    // also collapse the height.
    const squashed = nextSize(ORIGIN, CORNER, -5000, 330);
    expect(squashed.w).toBe(PANEL_MIN_W);
    expect(squashed.h, 'the height collapsed with the width').toBe(230);
  });

  it('banks nothing when the pointer overshoots and comes back', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE BUG THIS FORM EXISTS TO KILL.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * Under the delta form the store kept growing past whatever the paint
     * capped, so dragging back had to unwind the overshoot before the box moved
     * at all — a box that has stopped following the pointer, which is exactly
     * what was reported. Absolute sizing cannot bank: the answer for a pointer
     * is the same whether or not it has been further out.
     */
    const far = nextSize(ORIGIN, CORNER, 9000, 9000);
    expect(far.h).toBeGreaterThan(8000);
    const back = nextSize(ORIGIN, CORNER, 440, 330);
    expect(back, 'the overshoot was banked and had to be unwound').toEqual({ w: 340, h: 230 });
  });
});

describe('sizeIntoBand', () => {
  const band = { top: 40, bottom: 400 };

  it('is what caps it, at settle time', () => {
    const capped = sizeIntoBand({ w: 9000, h: 9000 }, band, 800);
    expect(capped.w).toBe(800);
    expect(capped.h).toBe(band.bottom - band.top);
  });

  it('keeps the floor it was given', () => {
    const tiny = sizeIntoBand({ w: 1, h: 1 }, band, 800);
    expect(tiny).toEqual({ w: PANEL_MIN_W, h: PANEL_MIN_H });
  });

  it('survives a band shorter than the minimum', () => {
    /**
     * A stored size outlives the window it was chosen in, and a band can be
     * shorter than `PANEL_MIN_H` on a very short viewport. The floor wins —
     * returning a negative height would be a canvas of negative size, which
     * throws rather than degrading.
     */
    const squeezed = sizeIntoBand({ w: 300, h: 300 }, { top: 0, bottom: 10 }, 800);
    expect(squeezed.h).toBe(PANEL_MIN_H);
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A RESIZE GRIP MUST FOLLOW THE POINTER. Reported: "the resizing reverses up
 * and down".
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The Case Log's rect was `y: band.bottom - size.h` — the BOTTOM edge pinned,
 * so growing the box moved its top upward while the grip, which is at the
 * bottom, stayed exactly where it was. Dragging down made the box grow up.
 *
 * The rule that fixes it is one sentence: THE TOP IS A FUNCTION OF THE BAND AND
 * THE PLAYER'S OFFSET, NEVER OF THE HEIGHT. This models that arithmetic, because
 * `unmovedPanelRect` is a closure over module state that a test cannot reach —
 * the same reason `hudscale.test.ts` models `viewLayout`'s callers.
 */
describe('a bottom-right grip grows the box downward', () => {
  const band = { top: 3, bottom: 656 };
  const DEFAULT_H = 200;
  const W = 1280;

  /** Where the log's top goes: the band alone, never the current height. */
  const anchor = (): number => band.bottom - DEFAULT_H;
  /** The unmoved log, as `unmovedPanelRect` builds it. */
  const unmoved = (h: number): PanelRect => ({ x: 3, y: anchor(), w: 640, h });

  it('leaves the top where it is however tall the box gets', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THIS DRIVES THE REAL FUNCTION NOW, AND THE OLD VERSION COULD NOT.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * It used to assert `anchor()` against itself in a loop that discarded its
     * own variable (`void h`) — an identity, true of this file's model and
     * silent about the game. The rule lives in `resizeIntoBand`, which is pure
     * and exported precisely so it can be asked.
     */
    const top = anchor();
    for (const h of [PANEL_MIN_H, DEFAULT_H, DEFAULT_H * 3, 9000]) {
      const landed = resizeIntoBand(unmoved(h), NO_OFFSET, band, W);
      expect(landed.y, `a box ${String(h)} tall moved its own top`).toBe(top);
    }
  });

  it('stops the bottom at the floor rather than pushing the top up', () => {
    /**
     * THE INVERSION'S SECOND ROUTE, AND IT SHIPPED.
     *
     * `moveIntoBand` clamps y into `[top, bottom - h]`, so a box grown taller
     * than the room beneath it is pushed UP — the top rises while the grip sits
     * against the floor. `hudLayout` had a line meant to stop that
     * (`Math.min(placed.h, own.bottom - placed.y)`) and it never fired once,
     * because `moveIntoBand` had already made the height fit BY MOVING THE TOP.
     *
     * The old version of this test computed the cap itself and asserted its own
     * arithmetic, so it stayed green through the whole of that.
     */
    const landed = resizeIntoBand(unmoved(900), NO_OFFSET, band, W);
    expect(landed.y, 'the top rose to make room').toBe(anchor());
    expect(landed.y + landed.h, 'the box was allowed past the floor').toBe(band.bottom);
    expect(landed.h, 'the cap collapsed the box instead of stopping it').toBeGreaterThan(
      PANEL_MIN_H,
    );
  });

  it('lets a box that was moved UP grow taller than the default', () => {
    // The other half of a fixed top: the way to a taller log is to move it up
    // first, exactly as it is for any window whose bottom is against an edge.
    const landed = resizeIntoBand(unmoved(900), { dx: 0, dy: -300 }, band, W);
    expect(landed.y).toBe(anchor() - 300);
    expect(landed.h, 'moving the box up bought no extra height').toBe(DEFAULT_H + 300);
  });

  it('clamps the origin without consulting the height — the whole rule', () => {
    /**
     * Two boxes at the same offset and different heights must land at the same
     * PLACE. Under `moveIntoBand` they do not, and that difference is the bug.
     */
    const short = resizeIntoBand(unmoved(PANEL_MIN_H), { dx: 0, dy: 40 }, band, W);
    const tall = resizeIntoBand(unmoved(600), { dx: 0, dy: 40 }, band, W);
    expect(tall.y, 'the taller box was placed somewhere else').toBe(short.y);
  });

  it('never lets a move shrink a panel that has no grip', () => {
    // `moveIntoBand`'s own rule, and the reason `resizeIntoBand` is not simply
    // swapped in everywhere: a drag moves a panel, it does not resize one.
    const moved = moveIntoBand({ x: 3, y: 400, w: 640, h: 300 }, { dx: 0, dy: 9000 }, band, W);
    expect(moved.h, 'a move resized the panel').toBe(300);
    expect(moved.y + moved.h, 'a move pushed the panel past the floor').toBeLessThanOrEqual(
      band.bottom,
    );
  });

  it('derives the top from the BAND in main.ts, not from the height', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE TESTS ABOVE MODEL THE ARITHMETIC AND CANNOT SEE THE CODE.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `unmovedPanelRect` is a module-scope function in main.ts that reads module
     * state, so no test can call it — and MEASURED, that matters: restoring the
     * original `y: own.bottom - size.h` leaves every assertion above GREEN,
     * because they assert this file's model rather than the game's line.
     *
     * A model that agrees with a bug is worth nothing. This reads the source,
     * which is how main.ts is guarded everywhere else in this suite.
     */
    const source = readFileSync('src/client/main.ts', 'utf8');
    expect(source, 'the log anchors its top to the band').toContain(
      'const y = own.bottom - defaultLogH(own);',
    );
    // THE BUG, NAMED. `size.h` here is the bottom-anchored form that made the
    // grip run the wrong way.
    expect(source, 'the log is bottom-anchored again — the grip will invert').not.toContain(
      'own.bottom - size.h',
    );
    // And the cap that stops the top rising at the floor.
    expect(source).toContain('Math.min(placed.h, own.bottom - placed.y)');
  });

  it('lets a box moved UP grow taller than one left in the corner', () => {
    /**
     * The consequence of the cap, and the reason it is not a limitation: the
     * room below the anchor IS the height, so moving the box up buys height.
     * That is the gesture every window manager teaches.
     */
    const inCorner = band.bottom - anchor();
    const movedUp = band.bottom - (anchor() - 120);
    expect(movedUp, 'moving the box up bought no extra height').toBeGreaterThan(inCorner);
  });
});

describe('the painter and the settle agree about the resizable panel', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * TWO ANSWERS TO "WHERE IS THIS PANEL" IS THE FAILURE THIS PAIR PREVENTS.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `movePanel` draws the Log through `resizeIntoBand` and every other panel
   * through `moveIntoBand`. `settlePanel` must branch on the SAME condition, or
   * the offset banked when the button comes up is one the painter never drew.
   *
   * The cost is not a pixel. Modelled at 1280x720 with a stored height of 400:
   * a box drawn by one clamp and settled by the other jumps by the whole
   * difference between its height and its floor — hundreds of pixels, after a
   * drag that went the other way. `settleOffset`'s own note argues the same
   * thing for one pixel of rounding.
   */
  const band = { top: 3, bottom: 656 };
  const W = 1280;
  const rect: PanelRect = { x: 3, y: 456, w: 640, h: 400 };

  it('settles to exactly where it draws, at every offset', () => {
    for (const dy of [-900, -300, -1, 0, 1, 200, 900]) {
      const offset = { dx: 0, dy };
      const drawn = resizeIntoBand(rect, offset, band, W);
      const settled = settleResize(rect, offset, band, W);
      const redrawn = resizeIntoBand(rect, settled, band, W);
      expect(redrawn.y, `dy=${String(dy)} settled somewhere it was not drawn`).toBe(drawn.y);
      expect(redrawn.h, `dy=${String(dy)} changed height on the settle`).toBe(drawn.h);
    }
  });

  it('is idempotent: settling twice moves nothing', () => {
    // A gesture that banked a different offset the second time would creep the
    // panel a little further every time it was touched.
    const once = settleResize(rect, { dx: 0, dy: -1000 }, band, W);
    const twice = settleResize(rect, once, band, W);
    expect(twice).toEqual(once);
  });

  it('main.ts branches on the same condition in both places', () => {
    /**
     * The two call sites are a module-scope function and a closure, so no test
     * can call either. This reads the source, which is how main.ts is guarded
     * everywhere else in this suite — and it is the assertion that would have
     * caught the plan that changed the painter and left the settle alone.
     */
    const source = readFileSync('src/client/main.ts', 'utf8');
    expect(source, 'the painter does not take the resize clamp').toContain(
      'panel === DraggablePanel.Log\n    ? resizeIntoBand(rect, panelOffsets[panel], band, width)',
    );
    expect(source, 'the settle does not branch with the painter').toContain(
      'const settle = subject.panel === DraggablePanel.Log ? settleResize : settleOffset;',
    );
  });

  it('the inert cap in hudLayout is gone, not merely bypassed', () => {
    /**
     * It never fired once, because `moveIntoBand` had already made the height
     * fit BY MOVING THE TOP. Leaving it beside `resizeIntoBand` would be a
     * second authority on the cap.
     *
     * ASSERTED AS CODE, NOT AS A STRING. The first version of this checked that
     * the expression was absent from the file and went red immediately — the
     * docblock explaining the removal quotes it, which is exactly what a
     * docblock explaining a removal should do. A negative assertion has to name
     * a shape prose cannot contain.
     */
    const source = readFileSync('src/client/main.ts', 'utf8');
    expect(source, 'the cap that never fired is still applied').not.toContain(
      '{ ...placed, h: Math.max(PANEL_MIN_H',
    );
    expect(source, 'the layout no longer takes the placed rect whole').toContain(
      'const log = placed;',
    );
  });
});

describe('the case log keeps its size when a fight starts', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * REPORTED AS "each area we enter causes the log to reset its size".
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Combat is what does it. `turnHudHeight` is `TURN_BAR_H +
   * turnCardsHeight(turn)`, and `turnCardsHeight` is ZERO out of combat and
   * `TURN_CARDS_H` in it — so the band's top jumps the instant something is in
   * the initiative. Correct for the band; wrong for everything the log derives
   * from it, because `defaultLogH` is a FRACTION of the band and the anchor and
   * the height cap are both computed from that.
   *
   * And `settlePanel` wrote the shorter value into the STORE, which is what made
   * it permanent: every walk into a fight ratcheted the box down and leaving the
   * fight never gave it back.
   */
  const H = 428;
  const QUIET = { top: 3 + 14, bottom: H - 60 - 3 };
  const FIGHTING = { top: 3 + 14 + 52, bottom: H - 60 - 3 };

  it('the two bands really do differ, or this file is testing nothing', () => {
    // The fixture has to exercise the thing. A band that did not move would
    // make every assertion below true of any implementation at all.
    expect(FIGHTING.top, 'the card strip does not move the band').toBeGreaterThan(QUIET.top);
  });

  it('derives the log’s own geometry from a band the cards cannot move', () => {
    const source = readFileSync('src/client/main.ts', 'utf8');
    expect(source, 'the quiet band is gone').toContain(
      'function quietLogBand(height: number): { top: number; bottom: number } {',
    );
    // The anchor and the default size.
    expect(source, 'the log sizes itself from the live band again').toContain(
      'const own = quietLogBand(height);',
    );
    // And the settle, which is where the ratchet lived.
    expect(source, 'the settle clamps the STORE against a band combat shrinks').toContain(
      'logSize = sizeIntoBand(logSize, quietLogBand(logicalH), logicalW);',
    );
  });

  it('the cap that actually moved is the ANCHOR, not the band height', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE FIRST VERSION OF THIS TEST BLAMED THE WRONG CLAMP.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `sizeIntoBand` caps the height against the band's own HEIGHT — 296 while
     * fighting at this window — so a 200-tall log sails through it and the
     * assertion passed for both bands. That is the shape this project keeps
     * getting caught by: an arithmetic model that agrees with the code and says
     * nothing about the bug.
     *
     * The cap that moves is `resizeIntoBand`'s: `h <= band.bottom - y`, where
     * the log's anchor is `bottom - defaultLogH(band)` and `defaultLogH` is a
     * FRACTION of the band. So the reachable height IS `defaultLogH`, and it
     * falls from 157 to 133 the instant the cards appear.
     */
    const DEFAULT_FRACTION = 0.45;
    const capFor = (band: { top: number; bottom: number }): number => {
      const anchor = band.bottom - Math.round((band.bottom - band.top) * DEFAULT_FRACTION);
      const landed = resizeIntoBand({ x: 3, y: anchor, w: 640, h: 9000 }, NO_OFFSET, band, 1280);
      return landed.h;
    };
    expect(capFor(FIGHTING), 'the fixture no longer exercises the drop').toBeLessThan(
      capFor(QUIET),
    );
    // ...and the fix is that the log never asks the fighting band at all.
    const source = readFileSync('src/client/main.ts', 'utf8');
    expect(source).not.toContain('const own = logBand(height, band.top - DOCK_MARGIN);');
  });
});
