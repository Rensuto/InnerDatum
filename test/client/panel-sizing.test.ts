// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

import { describe, expect, it } from 'vitest';

import { SHEET_TABS, charSheetRect, charSheetRows } from '../../src/client/ui/charsheet.ts';
import { ItemTier } from '../../src/shared/protocol.ts';
import type { CharSheetView, SheetRow } from '../../src/client/ui/charsheet.ts';
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

/**
 * A sheet with something on every page, so the sizer has real rows to measure.
 *
 * THE ITEM NAME IS THE LONGEST THING THIS PANEL CAN BE ASKED TO DRAW and it is
 * here deliberately: `charSheetRows` puts `worn[slot].name` straight into a
 * Field, nothing on the wire bounds it, and it is what decides the Equipment
 * page's width.
 */
function pagesFor(view: Partial<CharSheetView> = {}): readonly (readonly SheetRow[])[] {
  const full: CharSheetView = {
    view: {
      name: 'Ren',
      className: 'The Alchemist',
      origin: 'The Cityborn',
      hp: 128,
      maxHp: 128,
      rows: [
        { label: 'Armour hardiness', value: '34%', group: 'defence' },
        { label: 'Physical save', value: '19', group: 'defence' },
        { label: 'Accuracy', value: '11', group: 'attack' },
      ],
    } as unknown as CharSheetView['view'],
    resource: null,
    // A FULL BAR. The Talents page is the tallest this panel ever draws, and it
    // is what decides how many columns a short band forces -- an empty loadout
    // would make the squashed case below prove nothing.
    loadout: Array.from({ length: 12 }, (_unused, i) => ({
      id: `talent:t${String(i)}`,
      name: `Talent ${String(i)}`,
      icon: 'icon_talent',
      cost: { ap: 3 },
      cooldownTurns: 4,
      range: 5,
      minRange: 0,
      level: 1,
      maxLevel: 5,
      desc: '',
      descNext: '',
    })) as unknown as CharSheetView['loadout'],
    cooldowns: {},
    progress: null,
    equipped: {
      legs: {
        itemId: 'item_long',
        name: "Reinforced Watchman's Trousers of the Long Watch",
        icon: 'item_long',
        tier: ItemTier.Common,
        desc: '',
        compare: [],
      },
    },
    ...view,
  } as CharSheetView;
  return SHEET_TABS.map((tab) => charSheetRows(full, tab));
}

describe('the character sheet is sized by its rows, under upstream’s ceiling', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THIS BLOCK USED TO ASSERT THE OPPOSITE, AND BOTH VERSIONS ARE RIGHT ABOUT
   * THE BUG THEY WERE WRITTEN FOR.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * It read *"takes at least half the width, as CharacterSheet.lua:50 does"* and
   * *"is bigger on a bigger window"*. Those pinned the fix for a FLAT 560-PIXEL
   * CAP that ignored the screen and made the sheet drop whole sections.
   *
   * Then a player reported the other end of it: *"the character page is quite
   * large and has a LOT of wasted space."* Measured, it was — four columns of
   * 288 opened at 1280x720 with every row of every tab placed in column one.
   * Upstream earns 200 columns by drawing four stat zones side by side
   * (CharacterSheet.lua:600-845); our pages are a dozen rows.
   *
   * So the rule is no longer "take a share of the window". It is TAKE WHAT THE
   * ROWS NEED, UNDER UPSTREAM'S BOUND — and the bound is still `:50` verbatim,
   * still cited, still what the panel gets whenever the rows want more than it.
   * These assertions pin that, and the two properties the old block existed to
   * defend are the last two: nothing is ever hidden, and the panel still expands
   * when expanding is what stops content being dropped.
   */
  it('does not take half the window when its rows do not need it', () => {
    const rect = charSheetRect({ ...BIG, pages: pagesFor() });
    expect(rect).not.toBeNull();
    if (rect === null) return;
    expect(rect.w, 'the sheet is still taking a share of the window').toBeLessThan(
      Math.floor(BIG.width * 0.5),
    );
  });

  it('never exceeds upstream’s ceiling', () => {
    for (const box of [BIG, SMALL]) {
      const rect = charSheetRect({ ...box, pages: pagesFor() });
      if (rect === null) continue;
      expect(
        rect.w,
        'the sheet is over 95% wide and has stopped leaving map visible',
      ).toBeLessThanOrEqual(Math.floor(box.width * 0.95));
    }
  });

  /**
   * THE OLD REGRESSION, STILL GUARDED, AND NOW AT THE END THAT MATTERS.
   *
   * A flat cap hurt when the rows outgrew it. So: give the panel a band too
   * short to pour the rows into one column and it MUST widen — that is the
   * behaviour whose absence produced "hidden — panel too small", and it is the
   * only case where the extra width was ever worth having.
   */
  it('still widens when a short band forces the rows into more columns', () => {
    const roomy = charSheetRect({ ...BIG, pages: pagesFor() });
    const squashed = charSheetRect({
      width: BIG.width,
      height: 400,
      top: 20,
      bottom: 200,
      pages: pagesFor(),
    });
    expect(roomy).not.toBeNull();
    expect(squashed).not.toBeNull();
    if (roomy === null || squashed === null) return;
    expect(squashed.w, 'a squashed band did not buy any extra columns').toBeGreaterThan(roomy.w);
  });

  it('still fits inside the band it is centred in', () => {
    for (const box of [BIG, SMALL]) {
      const rect = charSheetRect({ ...box, pages: pagesFor() });
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
