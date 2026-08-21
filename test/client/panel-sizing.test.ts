// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

import { describe, expect, it } from 'vitest';

import { charSheetRect } from '../../src/client/ui/charsheet.ts';
import { talentPanelRect } from '../../src/client/ui/talents.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *   THE PANELS TAKE A SHARE OF THE WINDOW, NOT A FIXED NUMBER OF PIXELS.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Both windows used to carry a flat pixel ceiling — `SHEET_MAX_W = 560` and
 * `PANEL_MAX_H = 300` — so they were the same size on a 1538-pixel window as on
 * a 700-pixel one. Each then ran out of room and hid content, in writing:
 *
 *     "<section> hidden — panel too small"          (charsheet.ts)
 *     "N categories hidden — panel too small"       (talents.ts)
 *
 * A player reported both. The screen had the space; the panels were forbidden
 * from using it.
 *
 * ═══ THE RULE IS UPSTREAM'S ═══
 *   CharacterSheet.lua:50  util.bound(font_w*200, game.w*0.5, game.w*0.95)
 *                          util.bound(font_h*36,  game.h*.35, game.h*.85)
 *   LevelupDialog.lua:89   game.w * 0.9, game.h * 0.9
 *
 * ═══ WHY THIS FILE ASSERTS RATIOS AND NOT PIXELS ═══
 * A pixel assertion is what let the ceilings sit unnoticed: 560 is a perfectly
 * reasonable-looking number and says nothing about the screen it is drawn on.
 * The property that matters is that the panel GROWS WITH THE WINDOW, so that is
 * what is pinned.
 */

/** The window the bug was reported on, and a small one for the floor. */
const BIG = { width: 1538, height: 769, top: 40, bottom: 690 };
const SMALL = { width: 1248, height: 480, top: 17, bottom: 343 };

describe('the character sheet grows with the window', () => {
  it('takes at least half the width, as CharacterSheet.lua:50 does', () => {
    const rect = charSheetRect(BIG);
    expect(rect).not.toBeNull();
    if (rect === null) return;
    expect(rect.w, 'the sheet is under half the window wide').toBeGreaterThanOrEqual(
      Math.floor(BIG.width * 0.5),
    );
    expect(
      rect.w,
      'the sheet is over 95% wide and has stopped leaving map visible',
    ).toBeLessThanOrEqual(Math.floor(BIG.width * 0.95));
  });

  /**
   * THE REGRESSION GUARD. 560 was the old ceiling; a sheet that lands on or
   * under it on a 1538-pixel window has had a flat cap put back.
   */
  it('is far past the old 560-pixel ceiling on a real window', () => {
    const rect = charSheetRect(BIG);
    expect(rect?.w, 'the flat 560 cap is back').toBeGreaterThan(560);
  });

  it('is bigger on a bigger window — the property a pixel cap destroys', () => {
    const small = charSheetRect(SMALL);
    const big = charSheetRect(BIG);
    expect(small).not.toBeNull();
    expect(big).not.toBeNull();
    if (small === null || big === null) return;
    expect(big.w * big.h, 'the sheet ignores the extra room').toBeGreaterThan(small.w * small.h);
  });

  it('still fits inside the band it is centred in', () => {
    for (const box of [BIG, SMALL]) {
      const rect = charSheetRect(box);
      if (rect === null) continue;
      expect(rect.x, 'drawn off the left edge').toBeGreaterThanOrEqual(0);
      expect(rect.x + rect.w, 'drawn off the right edge').toBeLessThanOrEqual(box.width);
      expect(rect.y, 'drawn above the top dock').toBeGreaterThanOrEqual(box.top);
      expect(rect.y + rect.h, 'drawn under the bottom dock').toBeLessThanOrEqual(box.bottom);
    }
  });
});

describe('the talent window grows with the window', () => {
  /**
   * ToME gives this dialog `game.h * 0.9`. Ours is additionally clamped to the
   * band between the HUD docks, so the assertion is against the band rather
   * than the raw fraction — but it must use nearly all of it.
   */
  it('takes nearly the whole free band, as LevelupDialog.lua:89 does', () => {
    const rect = talentPanelRect(BIG);
    expect(rect).not.toBeNull();
    if (rect === null) return;
    const band = BIG.bottom - BIG.top;
    expect(rect.h, 'the talent window leaves most of the band empty').toBeGreaterThan(band * 0.9);
  });

  /** 300 was the old ceiling, and it is what hid whole talent trees. */
  it('is far past the old 300-pixel ceiling on a real window', () => {
    const rect = talentPanelRect(BIG);
    expect(rect?.h, 'the flat 300 cap is back').toBeGreaterThan(300);
  });

  it('is taller on a taller window', () => {
    const small = talentPanelRect(SMALL);
    const big = talentPanelRect(BIG);
    if (small === null || big === null) return;
    expect(big.h, 'the talent window ignores the extra height').toBeGreaterThan(small.h);
  });

  it('still fits inside its band', () => {
    for (const box of [BIG, SMALL]) {
      const rect = talentPanelRect(box);
      if (rect === null) continue;
      expect(rect.x).toBeGreaterThanOrEqual(0);
      expect(rect.x + rect.w).toBeLessThanOrEqual(box.width);
      expect(rect.y).toBeGreaterThanOrEqual(box.top);
      expect(rect.y + rect.h).toBeLessThanOrEqual(box.bottom);
    }
  });
});
