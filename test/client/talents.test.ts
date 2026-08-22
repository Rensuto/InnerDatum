/// <reference lib="dom" />

import { describe, expect, it } from 'vitest';

import { CATEGORY_POINT_LEVELS } from '../../src/shared/progression.ts';

import {
  TALENT_PANEL_MARGIN,
  TALENT_PANEL_MIN_H,
  TALENT_PANEL_MIN_W,
  TalentHitKind,
  TalentRowKind,
  pressSpend,
  talentPanelDragAt,
  talentPanelGeometry,
  talentPanelHitAt,
  talentPanelRect,
  STAT_ROWS,
  drawTalentPanel,
  statPlusRect,
  statRowRects,
  talentIdAt,
  TALENT_SCROLL_STEP,
  talentPanelRows,
  talentTipAt,
} from '../../src/client/ui/talents.ts';
import { HEADER_H } from '../../src/client/ui/panel.ts';
import { TALENT_MAX_LEVEL } from '../../src/shared/progression.ts';
import type { TalentPanelView, TalentRow } from '../../src/client/ui/talents.ts';
import type { PanelRect } from '../../src/client/ui/panel.ts';
import type { LoadoutTalent, ProgressMsg } from '../../src/shared/protocol.ts';
/**
 * THE INJECTED WRAPPER IS GONE, ALONG WITH THE PARAMETER IT FED.
 *
 * `talentPanelGeometry` used to accept a text wrapper so these assertions would
 * not depend on how a headless environment measures a font it does not have
 * installed. Nothing ever passed one but this file: the panel wraps with its own
 * measurement everywhere it actually runs, and the parameter existed only to be
 * mocked. The scroll offset took its place in the signature.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function talent(over: Partial<LoadoutTalent> & { id: string; name: string }): LoadoutTalent {
  return {
    icon: 'icon_active_basic_attack',
    cost: { ap: 3, mp: 0, resource: 0 },
    cooldownTurns: 0,
    range: 1.5,
    minRange: 0,
    shape: 'single',
    radius: 0,
    level: 1,
    maxLevel: TALENT_MAX_LEVEL,
    desc: 'Slam an adjacent enemy for 110% weapon damage and drive it back a tile.',
    descNext: 'Slam an adjacent enemy for 130% weapon damage and drive it back a tile.',
    kind: 'active',
    ...over,
  };
}

const DISCIPLINE = { tree: 'watch/discipline', treeName: 'Discipline' };
const THE_LINE = { tree: 'watch/the-line', treeName: 'The Line' };

function view(over: Partial<TalentPanelView> = {}): TalentPanelView {
  return {
    loadout: [
      talent({ id: 'talent:crude_blow', name: 'Crude Blow', ...DISCIPLINE }),
      talent({ id: 'talent:ward_rush', name: 'Ward Rush', ...DISCIPLINE }),
      talent({ id: 'talent:iron_curtain', name: 'Iron Curtain', ...THE_LINE }),
      talent({ id: 'talent:lockdown', name: 'Lockdown', ...THE_LINE }),
    ],
    passives: [
      talent({
        id: 'talent:standing_orders',
        name: 'Standing Orders',
        kind: 'passive',
        cost: { ap: 0, mp: 0, resource: 0 },
        range: 0,
        desc: 'Always on. Your coat is worth 1 armour, on top of anything you wear.',
        descNext: null,
        ...THE_LINE,
      }),
    ],
    progress: progress(1),
    ...over,
  };
}

function progress(unspent: number): ProgressMsg {
  return { level: 2, xp: 1, xpToNext: 61, unspent } as ProgressMsg;
}

/** The floor every window clears: `DEFAULT_VIEWPORT` is 20x10 tiles. */
const FLOOR = { width: 640, height: 320, top: 40, bottom: 280 };
/** The window the player's screenshot came from, in logical pixels. */
const REAL = { width: 772, height: 367, top: 40, bottom: 320 };

function rectAt(size: typeof FLOOR) {
  const rect = talentPanelRect(size);
  if (rect === null) throw new Error('no panel at this size');
  return rect;
}

/**
 * THE UNSCROLLED CASE, which is what almost every test here is about.
 *
 * Named rather than a bare 0 so a reader can tell "this test does not care about
 * scrolling" from "this test asserts the top of the list".
 */
const NO_SCROLL = 0;

function placedAt(size: typeof FLOOR, rows?: readonly TalentRow[], scroll = NO_SCROLL) {
  const rect = rectAt(size);
  return talentPanelGeometry(rect, rows ?? talentPanelRows(view()), scroll).placed;
}

const categories = (rows: readonly TalentRow[]) =>
  rows.flatMap((row) => (row.kind === TalentRowKind.Category ? [row] : []));

// ---------------------------------------------------------------------------

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE TREE IS A GRID OF CATEGORIES, WHICH IS WHAT THE PLAYER ASKED FOR
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A screenshot of ToME's talent screen came with the request: two columns of
 * category blocks, each a header over a horizontal strip of icons with a rank
 * under every one. These are the properties that shape holds.
 */
describe('talentPanelRows builds categories', () => {
  it('groups by tree and keeps the class table order', () => {
    const cats = categories(talentPanelRows(view()));
    expect(cats.map((c) => c.tree)).toEqual(['watch/discipline', 'watch/the-line']);
    expect(cats[0]?.talents.map((t) => t.name)).toEqual(['Crude Blow', 'Ward Rush']);
  });

  it('puts the passives in their own tree beside the actives', () => {
    // The wire keeps them apart so the hotbar cannot show something unpressable;
    // the PANEL is the one surface where they are all talents you own.
    const line = categories(talentPanelRows(view())).find((c) => c.tree === 'watch/the-line');
    expect(line?.talents.map((t) => t.name)).toEqual([
      'Iron Curtain',
      'Lockdown',
      'Standing Orders',
    ]);
    expect(line?.talents.find((t) => t.name === 'Standing Orders')?.passive).toBe(true);
  });

  it('prints the mastery only when it is not one', () => {
    // Six "(x1.00)" headers would be six pieces of furniture teaching a player to
    // stop reading the number that matters.
    const plain = categories(talentPanelRows(view()))[0];
    expect(plain?.text).toBe('Discipline');

    const tuned = talentPanelRows(
      view({
        loadout: [talent({ id: 'a', name: 'A', ...DISCIPLINE, mastery: 1.3 })],
        passives: [],
      }),
    );
    expect(categories(tuned)[0]?.text).toBe('Discipline  (x1.30)');
  });

  it('degrades to one unnamed category when the server sends no tree', () => {
    // The additive-field contract: an old server loses the GROUPING, never the
    // talents. `tree` is optional on the wire precisely so no bump was needed.
    const rows = talentPanelRows(view({ loadout: [talent({ id: 'a', name: 'A' })], passives: [] }));
    const cats = categories(rows);
    expect(cats).toHaveLength(1);
    expect(cats[0]?.talents).toHaveLength(1);
  });

  it('says so rather than drawing a blank box before the loadout lands', () => {
    const rows = talentPanelRows(view({ loadout: [], passives: [] }));
    expect(rows.some((row) => row.kind === TalentRowKind.Note)).toBe(true);
  });
});

describe('the grid lays out in columns', () => {
  it('places every talent at the smallest window the game guarantees', () => {
    /**
     * THE RULE THIS REDESIGN EXISTS TO SATISFY, and the third time a layout
     * change has threatened it. The old vertical list gave each talent a
     * 43-pixel full-width row and started hiding the fifth; a category strip
     * holds five in 63 pixels.
     */
    const placed = placedAt(FLOOR);
    const shown = placed.flatMap((p) =>
      p.row.kind === TalentRowKind.Category ? p.row.talents : [],
    );
    expect(shown).toHaveLength(5);
    expect(placed.some((p) => p.row.kind === TalentRowKind.Note)).toBe(false);
  });

  it('gives every icon a rect, index for index with its talents', () => {
    for (const p of placedAt(REAL)) {
      if (p.row.kind !== TalentRowKind.Category) continue;
      expect(p.cells).toHaveLength(p.row.talents.length);
    }
  });

  it('never overlaps two icons', () => {
    // Five click targets a category, and a grid gives five chances per category
    // to put two of them in the same place.
    const boxes = placedAt(REAL).flatMap((p) => p.cells);
    for (let i = 0; i < boxes.length; i += 1) {
      for (let j = i + 1; j < boxes.length; j += 1) {
        const a = boxes[i];
        const b = boxes[j];
        if (a === undefined || b === undefined) continue;
        const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
        expect(apart, `icons ${String(i)} and ${String(j)} overlap`).toBe(true);
      }
    }
  });

  it('keeps every icon inside the panel', () => {
    const rect = rectAt(FLOOR);
    for (const box of placedAt(FLOOR).flatMap((p) => p.cells)) {
      expect(box.x).toBeGreaterThanOrEqual(rect.x);
      expect(box.y).toBeGreaterThanOrEqual(rect.y);
      expect(box.x + box.w).toBeLessThanOrEqual(rect.x + rect.w);
      expect(box.y + box.h).toBeLessThanOrEqual(rect.y + rect.h);
    }
  });

  it('puts two categories side by side when there is width for them', () => {
    const cats = placedAt(REAL).filter((p) => p.row.kind === TalentRowKind.Category);
    expect(cats).toHaveLength(2);
    // Same row, different columns — which is the whole shape of the screenshot.
    expect(cats[0]?.rect.y).toBe(cats[1]?.rect.y);
    expect(cats[0]?.rect.x).not.toBe(cats[1]?.rect.x);
  });
});

describe('a press lands on the icon it was drawn on', () => {
  it('hits the talent under the pointer', () => {
    const rows = talentPanelRows(view());
    const rect = rectAt(REAL);
    for (const p of talentPanelGeometry(rect, rows, NO_SCROLL).placed) {
      if (p.row.kind !== TalentRowKind.Category) continue;
      for (let n = 0; n < p.cells.length; n += 1) {
        const box = p.cells[n];
        if (box === undefined) continue;
        const hit = talentPanelHitAt(rect, rows, box.x + 2, box.y + 2, NO_SCROLL);
        expect(hit?.kind).toBe(TalentHitKind.Row);
      }
    }
  });

  it('reads a press on the ARMED icon as the spend, not another arm', () => {
    /**
     * There is no separate `+` in the grid: five small buttons beside five large
     * ones means the wrong one is always the easy press. `pressSpend` already
     * owns the two-press rule, so an armed icon IS the confirm.
     */
    const rows = talentPanelRows(view());
    const rect = rectAt(REAL);
    const first = talentPanelGeometry(rect, rows, NO_SCROLL).placed.find(
      (p) => p.row.kind === TalentRowKind.Category,
    );
    const box = first?.cells[0];
    const armedId =
      first?.row.kind === TalentRowKind.Category ? first.row.talents[0]?.id : undefined;
    expect(box).toBeDefined();
    expect(armedId).toBeDefined();
    if (box === undefined || armedId === undefined) return;

    expect(talentPanelHitAt(rect, rows, box.x + 2, box.y + 2, NO_SCROLL, armedId)?.kind).toBe(
      TalentHitKind.Spend,
    );
  });

  it('refuses to spend with no point in hand', () => {
    const rows = talentPanelRows(view({ progress: progress(0) }));
    const rect = rectAt(REAL);
    const first = talentPanelGeometry(rect, rows, NO_SCROLL).placed.find(
      (p) => p.row.kind === TalentRowKind.Category,
    );
    const box = first?.cells[0];
    const armedId =
      first?.row.kind === TalentRowKind.Category ? first.row.talents[0]?.id : undefined;
    if (box === undefined || armedId === undefined) return;
    // `canSpend` is false, so even the armed icon is only ever an arm.
    expect(talentPanelHitAt(rect, rows, box.x + 2, box.y + 2, NO_SCROLL, armedId)?.kind).toBe(
      TalentHitKind.Row,
    );
  });

  it('hits nothing in the gap between two icons', () => {
    const rows = talentPanelRows(view());
    const rect = rectAt(REAL);
    const first = talentPanelGeometry(rect, rows, NO_SCROLL).placed.find(
      (p) => p.row.kind === TalentRowKind.Category,
    );
    const a = first?.cells[0];
    if (a === undefined) return;
    expect(talentPanelHitAt(rect, rows, a.x + a.w + 1, a.y + 2, NO_SCROLL)).toBeNull();
  });

  it('still closes on the close control', () => {
    const rows = talentPanelRows(view());
    const rect = rectAt(REAL);
    const close = talentPanelGeometry(rect, rows, NO_SCROLL).close;
    expect(talentPanelHitAt(rect, rows, close.x + 1, close.y + 1, NO_SCROLL)?.kind).toBe(
      TalentHitKind.Close,
    );
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * HOVER IS WHERE THE PROSE WENT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Asked for directly: "hover-over-icon to reveal what the ability does". It is
 * also what makes the grid affordable — every description printed inline was a
 * row, and rows are what ran out.
 */
describe('hovering an icon explains it', () => {
  const rows = talentPanelRows(view());
  const rect = rectAt(REAL);
  const firstBox = () => {
    const cat = talentPanelGeometry(rect, rows, NO_SCROLL).placed.find(
      (p) => p.row.kind === TalentRowKind.Category,
    );
    return cat?.cells[0];
  };

  it('returns a card naming the talent and its rank', () => {
    const box = firstBox();
    if (box === undefined) return;
    const card = talentTipAt(rect, rows, box.x + 2, box.y + 2, NO_SCROLL);
    expect(card?.title).toContain('Crude Blow');
    expect(card?.title).toContain(`1/${String(TALENT_MAX_LEVEL)}`);
  });

  it('carries the whole description and the next rank, unabridged', () => {
    // The panel shows fifteen icons and no prose; if the card truncates, the
    // description is nowhere at all.
    const box = firstBox();
    if (box === undefined) return;
    const card = talentTipAt(rect, rows, box.x + 2, box.y + 2, NO_SCROLL);
    expect(card?.lines.join(' ')).toContain('110% weapon damage');
    expect((card?.nextLines ?? []).join(' ')).toContain('130% weapon damage');
    for (const line of [...(card?.lines ?? []), ...(card?.nextLines ?? [])]) {
      expect(line).not.toContain('…');
    }
  });

  it('says a passive is always on rather than printing a cost at it', () => {
    const cat = talentPanelGeometry(rect, rows, NO_SCROLL).placed.find(
      (p) => p.row.kind === TalentRowKind.Category && p.row.tree === 'watch/the-line',
    );
    const idx =
      cat?.row.kind === TalentRowKind.Category ? cat.row.talents.findIndex((t) => t.passive) : -1;
    const box = idx >= 0 ? cat?.cells[idx] : undefined;
    if (box === undefined) return;
    const card = talentTipAt(rect, rows, box.x + 2, box.y + 2, NO_SCROLL);
    expect(card?.meta).toBe('always on');
  });

  it('is null when the pointer is not on an icon', () => {
    expect(talentTipAt(rect, rows, rect.x + 1, rect.y + 1, NO_SCROLL)).toBeNull();
  });
});

describe('the panel itself', () => {
  it('refuses to open in a band too small to be useful', () => {
    expect(
      talentPanelRect({
        width: TALENT_PANEL_MIN_W + TALENT_PANEL_MARGIN * 2,
        height: 200,
        top: 0,
        bottom: TALENT_PANEL_MIN_H,
      }),
    ).toBeNull();
  });

  it('is dragged by its header and nowhere else', () => {
    const rect = rectAt(REAL);
    expect(talentPanelDragAt(rect, rect.x + 30, rect.y + 4)?.kind).toBe(TalentHitKind.Header);
    expect(talentPanelDragAt(rect, rect.x + 30, rect.y + HEADER_H + 20)).toBeNull();
  });

  it('needs two presses to spend, and says so in between', () => {
    // ToME's own "there is no refund" guard, unchanged by the redesign.
    // `spend` is the talent id to send, or null for "send nothing" — not a
    // boolean. A first press arms and sends nothing; the second sends.
    expect(pressSpend(null, 'talent:crude_blow')).toEqual({
      armed: 'talent:crude_blow',
      spend: null,
    });
    expect(pressSpend('talent:crude_blow', 'talent:crude_blow').spend).toBe('talent:crude_blow');
    // Arming a DIFFERENT talent moves the arm and still sends nothing.
    expect(pressSpend('talent:ward_rush', 'talent:crude_blow').spend).toBeNull();
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE PANEL HOLDS A THIRD CATEGORY, AND THIS IS WHY THAT WAS CHECKED FIRST.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A class carried two categories and was about to carry three. `talentPanelRect`
 * is a FIXED 480x300 at every viewport from the 640x400 window up to 1280x720 —
 * it does not grow with the screen — so "there will be room on a big monitor"
 * was not available as an answer, and authoring eighteen talents before finding
 * that out would have been eighteen talents behind a note saying
 * `1 category hidden — panel too small`.
 *
 * MEASURED, not reasoned: a category block is `CAT_H` tall and they flow into
 * two columns, and at the 640x320 FLOOR — the smallest window this client
 * renders, where the panel is squeezed to 480x228 — four still fit. Three is
 * therefore safe with a category of headroom.
 *
 * THE FOURTH IS ASSERTED ON PURPOSE. It is the difference between "the number we
 * happen to have fits" and "there is room to grow", and it is the assertion that
 * will fail first if `CAT_H`, `PANEL_MAX_H` or the column count moves.
 */
describe('the panel has room for the categories a class carries', () => {
  /** `n` categories of six talents each — four actives and two passives. */
  function nCategories(n: number): TalentPanelView {
    const loadout: LoadoutTalent[] = [];
    const passives: LoadoutTalent[] = [];
    for (let t = 0; t < n; t += 1) {
      const tree = { tree: `t/${String(t)}`, treeName: `Category ${String(t)}` };
      for (let i = 0; i < 4; i += 1) {
        loadout.push(
          talent({ id: `talent:a${String(t)}${String(i)}`, name: `Act ${String(i)}`, ...tree }),
        );
      }
      for (let i = 0; i < 2; i += 1) {
        passives.push(
          talent({
            id: `talent:p${String(t)}${String(i)}`,
            name: `Pass ${String(i)}`,
            kind: 'passive',
            descNext: null,
            ...tree,
          }),
        );
      }
    }
    return { loadout, passives, progress: progress(1) };
  }

  function categoriesPlacedAt(size: typeof FLOOR, count: number): number {
    const rect = talentPanelRect(size);
    if (rect === null) throw new Error('no panel at this size');
    const rows = talentPanelRows(nCategories(count));
    return talentPanelGeometry(rect, rows, NO_SCROLL).placed.filter(
      (placed) => placed.row.kind === TalentRowKind.Category,
    ).length;
  }

  const VIEWPORTS = [
    [640, 320],
    [640, 400],
    [772, 480],
    [1024, 600],
    [1280, 720],
  ] as const;

  it('draws all THREE at every viewport, including the floor', () => {
    for (const [w, h] of VIEWPORTS) {
      const size = { width: w, height: h, top: 40, bottom: h - 40 };
      expect(categoriesPlacedAt(size, 3), `${String(w)}x${String(h)}`).toBe(3);
    }
  });

  it('has room for a FOURTH, which is the headroom rather than the requirement', () => {
    for (const [w, h] of VIEWPORTS) {
      const size = { width: w, height: h, top: 40, bottom: h - 40 };
      expect(categoriesPlacedAt(size, 4), `${String(w)}x${String(h)}`).toBe(4);
    }
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * NOTHING IS HIDDEN ANY MORE, BECAUSE THE GRID SCROLLS.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * This case used to assert the opposite — that a tail too long for the panel
   * was dropped and SAID SO. The concession was honest and the honesty was the
   * best part of it, but it was still a player who could not see two of their
   * own disciplines. Widening the panel bought some back and could never buy
   * them all: the tree count grows with content and the band between the HUD
   * docks does not.
   *
   * Upstream scrolls (TalentTrees.lua:72 slider, :388 `glScissor`), so there is
   * no tail to concede.
   */
  it('places every category however many there are', () => {
    const size = { width: 640, height: 320, top: 40, bottom: 280 };
    const rect = talentPanelRect(size);
    if (rect === null) throw new Error('no panel');
    const rows = talentPanelRows(nCategories(9));
    const geometry = talentPanelGeometry(rect, rows, NO_SCROLL);
    const notes = geometry.placed.flatMap((entry) =>
      entry.row.kind === TalentRowKind.Note ? [entry.row.text] : [],
    );
    expect(
      notes.some((note) => /categories hidden/.test(note)),
      'the panel is still conceding a tail instead of scrolling',
    ).toBe(false);
    expect(
      geometry.grid.maxScroll,
      'nine categories fit a 640x320 panel unscrolled',
    ).toBeGreaterThan(0);
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE SAFETY PROPERTY: A STRIP YOU CANNOT SEE IS A STRIP YOU CANNOT CLICK.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * A talent icon SPENDS A POINT and there is no refund gesture. A row scrolled
   * out of the window must therefore not merely be invisible — it must not be
   * PLACED, because the hit test walks the placed list. The sentence rows sit
   * immediately ABOVE the grid window, so a strip scrolled off the top lands
   * squarely on them and a press there would spend a point on a discipline that
   * is nowhere on the screen.
   *
   * This is the assertion the whole design of the scroll is arranged around: the
   * offset is folded into the geometry rather than applied with a `ctx.translate`
   * at the paint, so the pointer and the picture read one arithmetic.
   */
  it('does not place a row scrolled out of the window', () => {
    const size = { width: 640, height: 320, top: 40, bottom: 280 };
    const rect = talentPanelRect(size);
    if (rect === null) throw new Error('no panel');
    const rows = talentPanelRows(nCategories(9));

    const top = talentPanelGeometry(rect, rows, NO_SCROLL);
    const scrolled = talentPanelGeometry(rect, rows, top.grid.maxScroll);

    const names = (g: typeof top): string[] =>
      g.placed.flatMap((entry) =>
        entry.row.kind === TalentRowKind.Category ? [entry.row.tree] : [],
      );

    expect(names(scrolled), 'scrolling changed nothing').not.toEqual(names(top));
    for (const entry of scrolled.placed) {
      if (entry.row.kind !== TalentRowKind.Category) continue;
      const viewport = scrolled.grid.viewport;
      expect(
        entry.rect.y + entry.rect.h > viewport.y && entry.rect.y < viewport.y + viewport.h,
        `a strip outside the window was placed at y=${String(entry.rect.y)}`,
      ).toBe(true);
    }
  });

  /**
   * CLAMPED AT BOTH ENDS, and the far end is `content - viewport` rather than
   * `content`. TalentTrees.lua:350 uses the latter and lets a pane scroll a
   * whole viewport past its own end, leaving the reader staring at blank space;
   * TextzoneList.lua:148 has it right and is the one ported.
   */
  it('clamps the offset instead of trusting the caller', () => {
    const size = { width: 640, height: 320, top: 40, bottom: 280 };
    const rect = talentPanelRect(size);
    if (rect === null) throw new Error('no panel');
    const rows = talentPanelRows(nCategories(9));

    expect(talentPanelGeometry(rect, rows, -5000).grid.scroll, 'scrolled above the top').toBe(0);
    const far = talentPanelGeometry(rect, rows, 999_999).grid;
    expect(far.scroll, 'scrolled past the end').toBe(far.maxScroll);
    expect(far.maxScroll, 'the end is past the content').toBeLessThanOrEqual(far.viewport.h * 9);
  });

  /** A list that already fits cannot scroll at all. */
  it('has nowhere to go when everything fits', () => {
    const rect = talentPanelRect({ width: 1280, height: 640, top: 40, bottom: 560 });
    if (rect === null) throw new Error('no panel');
    const geometry = talentPanelGeometry(rect, talentPanelRows(nCategories(2)), 40);
    expect(geometry.grid.maxScroll).toBe(0);
    expect(geometry.grid.scroll, 'a panel with nothing to scroll still moved').toBe(0);
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * AND THE HALF-SCROLLED STRIP, WHICH IS THE HOLE THE FIRST RULE LEAVES OPEN.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * "Do not place a row entirely outside the window" is not enough. A strip
   * scrolled HALFWAY off the top must still be placed — its visible half has to
   * be drawn — and it carries all of its cells with it, including icons whose
   * boxes are now above the window entirely. The painter clips those away. The
   * hit test, left alone, would still match them.
   *
   * So this walks every cell of a scrolled panel, asks the hit test about the
   * middle of each one, and requires that the only cells answering are cells
   * inside the window. A press on blank panel above the grid must find nothing —
   * anything else is an irreversible spend on an invisible icon.
   */
  it('refuses a press on an icon the clip has eaten', () => {
    const size = { width: 640, height: 320, top: 40, bottom: 280 };
    const rect = talentPanelRect(size);
    if (rect === null) throw new Error('no panel');
    const rows = talentPanelRows(nCategories(9));

    const top = talentPanelGeometry(rect, rows, NO_SCROLL);
    /** Half a strip, so at least one row straddles the top of the window. */
    const half = Math.floor(TALENT_SCROLL_STEP / 2);
    expect(half, 'the fixture cannot straddle anything').toBeGreaterThan(0);
    expect(top.grid.maxScroll, 'nothing to scroll').toBeGreaterThanOrEqual(half);

    const geometry = talentPanelGeometry(rect, rows, half);
    const viewport = geometry.grid.viewport;

    let straddled = 0;
    let answered = 0;
    for (const entry of geometry.placed) {
      if (entry.row.kind !== TalentRowKind.Category) continue;
      const above = entry.rect.y < viewport.y;
      if (above) straddled += 1;
      for (const box of entry.cells) {
        const cx = box.x + box.w / 2;
        const cy = box.y + box.h / 2;
        const hit = talentPanelHitAt(rect, rows, cx, cy, half);
        const whole =
          box.x >= viewport.x &&
          box.y >= viewport.y &&
          box.x + box.w <= viewport.x + viewport.w &&
          box.y + box.h <= viewport.y + viewport.h;
        if (whole) {
          if (hit !== null) answered += 1;
          continue;
        }
        expect(
          hit,
          `an icon clipped at y=${String(box.y)} answered a press; the window starts at ${String(viewport.y)}`,
        ).toBeNull();
        expect(
          talentIdAt(rect, rows, cx, cy, half),
          'a clipped icon still names itself to the hover card',
        ).toBeNull();
      }
    }

    expect(straddled, 'no strip straddled the window, so this proved nothing').toBeGreaterThan(0);
    expect(
      answered,
      'the guard silenced the whole grid, not just the clipped part',
    ).toBeGreaterThan(0);
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE BAR IS THE ONLY THING THAT SAYS THE GRID CONTINUES.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * The panel used to print "N categories hidden" — ugly, but it told a player
   * there was more. Deleting that row without drawing a bar would have traded a
   * visible shortfall for an invisible one, which is the worse of the two.
   *
   * So: a bar exactly when there is somewhere to scroll, none when there is not,
   * and a thumb that reaches the bottom of its track at the bottom of the list.
   */
  it('draws a bar only when there is more, and runs it to the end', () => {
    const rect = talentPanelRect({ width: 640, height: 320, top: 40, bottom: 280 });
    if (rect === null) throw new Error('no panel');
    const rows = talentPanelRows(nCategories(9));

    const top = talentPanelGeometry(rect, rows, NO_SCROLL).grid;
    expect(top.bar, 'a scrollable grid drew no bar').not.toBeNull();
    expect(top.thumb, 'a bar with no thumb').not.toBeNull();
    if (top.bar === null || top.thumb === null) throw new Error('unreachable');
    expect(top.thumb.y, 'the thumb does not start at the top').toBe(top.bar.y);
    expect(top.thumb.h, 'the thumb fills a track it should not').toBeLessThan(top.bar.h);

    const end = talentPanelGeometry(rect, rows, top.maxScroll).grid;
    if (end.bar === null || end.thumb === null) throw new Error('the bar vanished mid-scroll');
    expect(
      end.thumb.y + end.thumb.h,
      'the thumb stops short of the end while the list is at its end',
    ).toBe(end.bar.y + end.bar.h);

    const fits = talentPanelGeometry(
      talentPanelRect({ width: 1280, height: 640, top: 40, bottom: 560 }) ?? rect,
      talentPanelRows(nCategories(2)),
      NO_SCROLL,
    ).grid;
    expect(fits.bar, 'a grid with nothing to scroll drew a bar anyway').toBeNull();
  });

  /**
   * AND THE BAR NEVER SITS ON AN ICON. It lives in a gutter reserved before the
   * columns were counted; if that arithmetic ever slips, the overlap lands on
   * the right-hand column of a surface where every icon spends a point.
   */
  it('keeps the bar clear of every strip', () => {
    const rect = talentPanelRect({ width: 640, height: 320, top: 40, bottom: 280 });
    if (rect === null) throw new Error('no panel');
    const rows = talentPanelRows(nCategories(9));
    const geometry = talentPanelGeometry(rect, rows, NO_SCROLL);
    const bar = geometry.grid.bar;
    if (bar === null) throw new Error('no bar to check');

    expect(bar.x, 'the bar starts inside the grid instead of beside it').toBeGreaterThanOrEqual(
      geometry.grid.viewport.x + geometry.grid.viewport.w,
    );
    expect(bar.x + bar.w, 'the bar runs off the panel').toBeLessThanOrEqual(rect.x + rect.w);

    for (const entry of geometry.placed) {
      if (entry.row.kind !== TalentRowKind.Category) continue;
      for (const box of entry.cells) {
        expect(
          box.x + box.w <= bar.x || box.x >= bar.x + bar.w,
          `an icon at x=${String(box.x)} runs under the bar at ${String(bar.x)}`,
        ).toBe(true);
      }
    }
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *   THE DESCRIPTION COLUMN — ToME's LEVELUP DIALOG HAS ONE, AND SO DOES THIS.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The player sent the upstream screen: trees down the left, everything about ONE
 * talent down the right. This pins the three things that make it work rather
 * than the pixels it works out to.
 *
 * ═══ IT IS NOT THE STRIP THAT WAS REMOVED, AND THAT DISTINCTION IS THE POINT ═══
 * A reserved strip at the FOOT was replaced by a hover card because it cost its
 * height on every frame whether or not anything was being pointed at. That
 * argument was about HEIGHT and it still holds — the grid keeps the whole band,
 * and this asserts it: the column takes width, never a single row of icons.
 */
describe('the description column', () => {
  const WIDE = { width: 1280, height: 720, top: 60, bottom: 640 };
  const NARROW = { width: 640, height: 384, top: 60, bottom: 300 };

  it('appears on a wide window and not on the guaranteed floor', () => {
    const wide = talentPanelRect(WIDE);
    const narrow = talentPanelRect(NARROW);
    expect(wide).not.toBeNull();
    expect(narrow).not.toBeNull();
    if (wide === null || narrow === null) return;

    expect(talentPanelGeometry(wide, talentPanelRows(view()), NO_SCROLL).detail).not.toBeNull();
    // ═══ THE FLOOR STILL WORKS ═══
    // `DEFAULT_VIEWPORT` is 20 tiles — 640 logical pixels — and a description
    // squeezed into what is left there would be the cut-off-mid-sentence bug the
    // panel was widened to fix. Below the threshold there is no column and the
    // hover card is still the answer.
    expect(talentPanelGeometry(narrow, talentPanelRows(view()), NO_SCROLL).detail).toBeNull();
  });

  it('never spends width on prose that the grid still needs', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE DEFECT NOTHING IN THIS FILE COULD SEE.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * The pane was taken the moment its pieces fitted — `fullW` 622 — so a
     * thousand-pixel window showed TWO columns of disciplines while spending 280
     * pixels on a description the hover card already answers. Every test here
     * passed throughout: they check that the pane appears, that it is tall
     * enough, and that it costs no ROWS. Nobody asked what it costs in COLUMNS.
     *
     * Measured through the real geometry, eight disciplines:
     *
     *     before  900=2  960=2  1024=2  1100=2  1152=2  1280=3  1440=4
     *     after   900=3  960=3  1024=3  1100=3  1152=2  1280=3  1440=4
     *
     * ═══ AND WHY THIS IS NOT A MONOTONICITY TEST ═══
     * I wrote that first. It is not achievable and it is worth writing down why:
     * the pane is a FIXED width and the grid is width-packed, so taking it
     * always costs about a column. The grid's own curve without a pane runs
     * 900=3 1152=4 1440=5 1920=7 — about one above the with-pane curve
     * everywhere — so there is NO threshold at which the pane appears for free.
     * A monotonic layout would mean never showing the pane at all.
     *
     * What IS true, and is what this asserts: the pane never appears on a window
     * upstream would have given a tooltip, and where it does appear it costs the
     * grid at most one column.
     */
    const many = view({
      loadout: Array.from({ length: 8 }, (_unused, i) =>
        talent({
          id: `talent:probe_${String(i)}`,
          name: `Probe ${String(i)}`,
          tree: `probe/tree_${String(i)}`,
          treeName: `Tree ${String(i)}`,
        }),
      ),
      passives: [],
    });

    const at = (width: number): { cols: number; pane: boolean; panelW: number } => {
      const rect = talentPanelRect({ width, height: 900, top: 60, bottom: 820 });
      if (rect === null) return { cols: 0, pane: false, panelW: 0 };
      const g = talentPanelGeometry(rect, talentPanelRows(many), NO_SCROLL);
      const cats = g.placed.filter((row) => row.row.kind === TalentRowKind.Category);
      const firstY = cats.length === 0 ? 0 : Math.min(...cats.map((row) => row.rect.y));
      return {
        cols: cats.filter((row) => row.rect.y === firstY).length,
        pane: g.detail !== null,
        panelW: rect.w,
      };
    };

    // ═══ NO PANE ON A PANEL NARROWER THAN UPSTREAM'S THOUSAND ═══
    // LevelupDialog.lua:90 — `if game.w * 0.9 >= 1000 then self.no_tooltip = true`.
    for (const width of [640, 768, 900, 1024, 1100]) {
      const seen = at(width);
      expect(seen.pane, `${String(width)} -> panel ${String(seen.panelW)}`).toBe(false);
    }
    for (const width of [1280, 1440, 1920]) {
      expect(at(width).pane, String(width)).toBe(true);
    }

    /**
     * ═══ AND WHERE IT APPEARS, THE GRID IS STILL WORTH LOOKING AT ═══
     * The pane costs about a column wherever it lands (see the note above), so
     * the guard is a FLOOR on what is left rather than a comparison against a
     * layout that does not exist. Two columns is the floor the original
     * `PANEL_W_STATS` argument was built on — a panel that can hold the pane and
     * only ONE strip has become the reserved strip that was deleted, on the
     * other axis.
     */
    for (const width of [1280, 1440, 1920]) {
      expect(at(width).cols, `${String(width)} columns beside the pane`).toBeGreaterThanOrEqual(2);
    }

    // ═══ AND THE GRID STILL GROWS WITH THE WINDOW OVERALL ═══
    expect(at(1920).cols).toBeGreaterThan(at(640).cols);
  });

  it('takes width from the panel and never a row from the grid', () => {
    // ═══ THE ASSERTION THAT KEEPS THE OLD ARGUMENT HONEST ═══
    // The strip that was removed cost HEIGHT. If this ever starts costing rows,
    // it has become the thing that was deleted.
    const wide = talentPanelRect(WIDE);
    const narrow = talentPanelRect(NARROW);
    if (wide === null || narrow === null) throw new Error('no panel');

    const rows = talentPanelRows(view());
    const withPane = talentPanelGeometry(wide, rows, NO_SCROLL);
    const without = talentPanelGeometry(narrow, rows, NO_SCROLL);

    const categories = (g: ReturnType<typeof talentPanelGeometry>): number =>
      g.placed.filter((placed) => placed.row.kind === TalentRowKind.Category).length;

    expect(categories(withPane)).toBeGreaterThanOrEqual(categories(without));
    // And the pane is the full height of the content band, not a strip in it.
    expect(withPane.detail?.h).toBeGreaterThan(100);
  });

  it('is derived from the rect alone, so the hit test and the paint agree', () => {
    /**
     * ═══ THE RULE THIS FILE'S HEADER SPENDS A PARAGRAPH ON ═══
     * The painter and `talentPanelHitAt` both call `talentPanelGeometry` and must
     * agree to the pixel about what is where. A pane whose PRESENCE depended on
     * the rows would move under the pointer the first time a category was added —
     * so the same rect must produce the same pane whatever it is holding.
     */
    const wide = talentPanelRect(WIDE);
    if (wide === null) throw new Error('no panel');
    const full = talentPanelGeometry(wide, talentPanelRows(view()), NO_SCROLL).detail;
    const empty = talentPanelGeometry(wide, [], NO_SCROLL).detail;
    expect(empty).toEqual(full);
  });

  it('names the talent under the pointer by id, not by index', () => {
    /**
     * AN INDEX CANNOT NAME A TALENT ONCE THERE ARE CATEGORIES — index 0 means
     * something different in every one of them, which is the bug `cellAt` was
     * split out to prevent. The column, the hover card and the press must all be
     * about the same icon, so they share one traversal.
     */
    const wide = talentPanelRect(WIDE);
    if (wide === null) throw new Error('no panel');
    const rows = talentPanelRows(view());
    const geometry = talentPanelGeometry(wide, rows, NO_SCROLL);

    const found: string[] = [];
    for (const placed of geometry.placed) {
      if (placed.row.kind !== TalentRowKind.Category) continue;
      for (let i = 0; i < placed.cells.length; i += 1) {
        const box = placed.cells[i];
        const cell = placed.row.talents[i];
        if (box === undefined || cell === undefined) continue;
        const id = talentIdAt(wide, rows, box.x + 2, box.y + 2, NO_SCROLL);
        expect(id, `${cell.name} at ${String(box.x)},${String(box.y)}`).toBe(cell.id);
        found.push(cell.id);
      }
    }
    expect(found.length, 'no icons were placed to point at').toBeGreaterThan(4);
    // TWO CATEGORIES, so index 0 exists twice and a by-index answer would have
    // returned the same id for both. This is the counterfactual, in the fixture.
    expect(new Set(found).size).toBe(found.length);
  });

  it('answers null for a point that is on the panel but not on an icon', () => {
    // THE HALF THAT MUST NOT MOVE: the column keeps the last talent rather than
    // emptying, and it can only do that if "over nothing" is distinguishable
    // from "over something". See `talentFocusId` in main.ts.
    const wide = talentPanelRect(WIDE);
    if (wide === null) throw new Error('no panel');
    const rows = talentPanelRows(view());
    expect(talentIdAt(wide, rows, wide.x + 2, wide.y + wide.h - 2, NO_SCROLL)).toBeNull();
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *   THE ATTRIBUTE COLUMN — ToME'S LEVELUP DIALOG, ON THE LEFT OF THIS SCREEN.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Asked for directly: attributes exactly as Tales of Maj'Eyal, on the talent
 * page, with the points. The server half is done — three a level
 * (`Actor.lua:3748`), six stats, `spend_stat` with no refund — and this is the
 * only surface a player can act on it through.
 */
type Op = { readonly kind: string; readonly args: readonly unknown[] };

function recorder(ops: Op[]): CanvasRenderingContext2D {
  return new Proxy(
    {},
    {
      get: (_t, prop: string) => {
        if (prop === 'measureText') return (text: string) => ({ width: text.length * 6 });
        if (prop === 'canvas') return { width: 1280, height: 720 };
        return (...args: unknown[]) => {
          ops.push({ kind: prop, args });
        };
      },
      set: () => true,
    },
  ) as unknown as CanvasRenderingContext2D;
}

const NO_ART = { sprite: () => undefined } as unknown as Parameters<
  typeof drawTalentPanel
>[0]['sprites'];

const SIX = { str: 25, dex: 14, con: 21, mag: 10, wil: 14, cun: 12 };

function paintPanel(over: Partial<Parameters<typeof drawTalentPanel>[0]> = {}): string[] {
  const rect = talentPanelRect({ width: 1280, height: 720, top: 60, bottom: 640 });
  if (rect === null) throw new Error('no panel');
  const ops: Op[] = [];
  drawTalentPanel({
    ctx: recorder(ops),
    sprites: NO_ART,
    // UNSCROLLED UNLESS A CASE SAYS OTHERWISE. `over` is spread after this, so a
    // test about the scrolled panel still sets its own.
    scroll: NO_SCROLL,
    rect,
    rows: talentPanelRows(view()),
    hoveredClose: false,
    hovered: null,
    armedId: null,
    stats: SIX,
    unspentStats: 3,
    ...over,
  });
  return ops.flatMap((op) => (op.kind === 'fillText' ? [String(op.args[0])] : []));
}

describe('the attribute column', () => {
  it('is drawn even on the guaranteed floor, because spending has no other route', () => {
    /**
     * ═══ THE ORDER THE THREE COLUMNS ARE EARNED IN IS A JUDGEMENT ═══
     * `DEFAULT_VIEWPORT` is 20 tiles — 640 logical pixels. Spending a point is a
     * REQUIRED action with no command, no key and no other panel behind it; if
     * the column is not drawn, a levelled character cannot spend what they were
     * granted. Reading a description has the hover card. So the attributes are
     * earned before the description, which inverts the order the two landed in.
     */
    const floor = talentPanelRect({ width: 640, height: 384, top: 60, bottom: 300 });
    expect(floor).not.toBeNull();
    if (floor === null) return;
    const g = talentPanelGeometry(floor, talentPanelRows(view()), NO_SCROLL);
    expect(g.stats, 'no attribute column at the narrowest supported window').not.toBeNull();
    // AND THE DESCRIPTION IS WHAT GIVES WAY THERE, not the grid.
    expect(g.detail).toBeNull();
  });

  it('never lets the column and the grid overlap', () => {
    // THE LAYOUT BUG THIS CATCHES: the column is taken off the left BEFORE the
    // grid is measured. Reversed, a two-column grid ends up half underneath a
    // row of stat labels, and every icon in it is a click target.
    const rect = talentPanelRect({ width: 1280, height: 720, top: 60, bottom: 640 });
    if (rect === null) throw new Error('no panel');
    const g = talentPanelGeometry(rect, talentPanelRows(view()), NO_SCROLL);
    expect(g.stats).not.toBeNull();
    if (g.stats === null) return;
    const right = g.stats.x + g.stats.w;
    for (const placed of g.placed) {
      if (placed.row.kind !== TalentRowKind.Category) continue;
      for (const cell of placed.cells) {
        expect(cell.x, 'an icon is under the attribute column').toBeGreaterThanOrEqual(right);
      }
    }
  });

  it('answers the hit test by stat, not by index', () => {
    /**
     * `spend_stat` NAMES ONE OF SIX. An index would be a second ordering to keep
     * in step with `STAT_ROWS`, and the failure mode is a point spent on the
     * wrong attribute — which nothing refunds.
     */
    const rect = talentPanelRect({ width: 1280, height: 720, top: 60, bottom: 640 });
    if (rect === null) throw new Error('no panel');
    const rows = talentPanelRows(view());
    const g = talentPanelGeometry(rect, rows, NO_SCROLL);
    if (g.stats === null) throw new Error('no column');

    const boxes = statRowRects(g.stats);
    expect(boxes.length, 'the column has room for fewer than six').toBe(STAT_ROWS.length);

    for (let i = 0; i < boxes.length; i += 1) {
      const plus = statPlusRect(boxes[i] as PanelRect);
      const hit = talentPanelHitAt(rect, rows, plus.x + 1, plus.y + 1, NO_SCROLL);
      expect(hit?.kind, `row ${String(i)} is not a stat hit`).toBe(TalentHitKind.Stat);
      if (hit?.kind === TalentHitKind.Stat) expect(hit.stat).toBe(STAT_ROWS[i]?.key);
    }
  });

  it('does not answer for the label or the value, only the +', () => {
    // A hit anywhere on the row would arm a spend the player never aimed at.
    const rect = talentPanelRect({ width: 1280, height: 720, top: 60, bottom: 640 });
    if (rect === null) throw new Error('no panel');
    const rows = talentPanelRows(view());
    const g = talentPanelGeometry(rect, rows, NO_SCROLL);
    if (g.stats === null) throw new Error('no column');
    const first = statRowRects(g.stats)[0] as PanelRect;
    const onLabel = talentPanelHitAt(rect, rows, first.x + 2, first.y + 2, NO_SCROLL);
    expect(onLabel?.kind).not.toBe(TalentHitKind.Stat);
  });

  it('paints the count and all six, and the + only while there is a point', () => {
    const withPoints = paintPanel();
    expect(withPoints).toContain('Stats: 3');
    for (const entry of STAT_ROWS) expect(withPoints).toContain(entry.label);
    expect(withPoints.filter((t) => t === '+')).toHaveLength(STAT_ROWS.length);

    // ═══ NO POINTS, NO `+` ═══
    // A control that is always there teaches a player to press it and be
    // refused, and the refusal costs a round trip to be told what the screen
    // already knew.
    const spent = paintPanel({ unspentStats: 0 });
    expect(spent).toContain('Stats: 0');
    expect(spent.filter((t) => t === '+')).toHaveLength(0);
  });

  it('draws its heading but no rows when the server has said nothing', () => {
    // THE HALF THAT MUST NOT MOVE. A client that has had no `progress` frame
    // yet, or one outliving a server without attributes, must not invent zeroes
    // — six rows of `STR 0` is a lie about a character.
    const silent = paintPanel({ stats: null, unspentStats: 0 });
    expect(silent).toContain('Stats: 0');
    expect(silent).not.toContain('STR');
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *   THE PANEL USES THE WIDTH IT HAS. IT STILL DOES NOT FIT EVERY TREE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Reported: "the talent (G) is too small to accomodate and the page says so."
 * It says so by dropping whole CATEGORIES — talent trees — with a row reading
 * "N categories hidden — panel too small".
 *
 * ═══ WHAT IS FIXED HERE ═══
 * The panel snapped to a fixed tier however much room there was: 572 wide on a
 * 772-pixel viewport, 852 on a 1280 one, with two hundred and four hundred
 * pixels unused respectively. It now takes upstream's share
 * (LevelupDialog.lua:89, `game.w * 0.9`) with the tier kept as a FLOOR, and the
 * category grid runs as many strips per line as fit instead of a hard two.
 *
 * ═══ WHAT IS NOT, AND THIS FILE WILL NOT PRETEND OTHERWISE ═══
 * At the smaller viewports the extra width crosses the threshold that turns on
 * the DESCRIPTION PANE, which consumes it — so the grid is back to two columns
 * and eight trees still do not all fit. No width rule can guarantee they will:
 * the tree count grows with content and the band between the HUD docks does not.
 *
 * The answer upstream uses is SCROLLING — TalentTrees.lua:72 gives the list a
 * slider, :388 clips with `glScissor`, :451-455 draws the bar only while the
 * pane is focused. That is the next change and deliberately not this one: a
 * scrolled grid means the hit test must subtract the offset, and a talent icon
 * SPENDS A POINT with no refund gesture, so a mis-targeted click is an
 * irreversible spend on a live server.
 *
 * So there is no case below asserting that nothing is hidden — because
 * something still is.
 */
/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE UNLOCK SENTENCE IS READ OFF THE CONSTANT, NOT SPELLED OUT.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * "Category points arrive at levels 10, 20 and 36" was written out four times
 * in `ui/talents.ts` while the levels themselves live in
 * `CATEGORY_POINT_LEVELS`. Moving one would have left four player-facing
 * strings lying about when the next discipline unlocks.
 *
 * This asserts the SENTENCE CONTAINS THE CONSTANT'S NUMBERS rather than a
 * literal of its own — a test that spelled "10, 20 and 36" here would drift in
 * exactly the same way and take the guard with it.
 */
describe('the locked-tree row says when points arrive', () => {
  it('names every level the constant names', () => {
    const rect = talentPanelRect({ width: 640, height: 320, top: 40, bottom: 280 });
    if (rect === null) throw new Error('no panel');
    // NO CATEGORY POINT IN HAND, which is the branch that names the levels —
    // with one in the purse the row reads "1 category point" instead.
    const rows = talentPanelRows(
      view({
        categories: 0,
        unlockable: [
          {
            id: 'generic/composure',
            name: 'Composure',
            blurb: 'Being outnumbered, and what a body does about it.',
            talents: [],
          },
        ],
      }),
    );
    const text = rows
      .flatMap((row) => (row.kind === TalentRowKind.Category ? [row.text] : []))
      .join(' | ');
    expect(text, 'no locked row was built').toMatch(/locked/);
    for (const level of CATEGORY_POINT_LEVELS) {
      expect(text, `level ${String(level)} is missing from the unlock sentence`).toContain(
        String(level),
      );
    }
  });
});

describe('the talent panel uses the room it has', () => {
  /** More categories than any class holds, so the grid is genuinely pressed. */
  function manyCategories(n: number): readonly TalentRow[] {
    const base = categories(talentPanelRows(view()));
    const first = base[0];
    if (first === undefined) throw new Error('the fixture has no categories');
    return Array.from({ length: n }, (_, i) => ({ ...first, name: `Tree ${String(i)}` }));
  }

  it('takes a share of the viewport rather than a fixed tier', () => {
    const rect = rectAt(REAL);
    expect(rect.w, 'the panel is back on a fixed width tier').toBeGreaterThan(600);
    expect(rect.w, 'the panel overran the viewport').toBeLessThanOrEqual(REAL.width);
  });

  it('grows with the viewport instead of snapping', () => {
    expect(rectAt({ width: 1280, height: 640, top: 40, bottom: 560 }).w).toBeGreaterThan(
      rectAt(REAL).w,
    );
  });

  /**
   * AND THE STRIPS NEVER SHRINK. Every icon is a click target that spends a
   * point with no refund, so a narrower strip is a mis-click waiting to happen.
   * More width must mean more strips per line, never smaller ones.
   */
  it('keeps every strip one width', () => {
    const widths = new Set(
      placedAt(REAL, manyCategories(8))
        .filter((row) => row.row.kind === TalentRowKind.Category)
        .map((row) => row.rect.w),
    );
    expect(widths.size, 'the strips are not all one width').toBe(1);
  });

  /**
   * NOTHING IS HIDDEN NOW, so there is nothing to announce. The row that said
   * so was the only thing between a player and a discipline they did not know
   * existed — and it is gone because the discipline is not.
   */
  it('announces nothing, because it hides nothing', () => {
    const placed = placedAt(REAL, manyCategories(12));
    const note = placed.find((row) => row.row.kind === TalentRowKind.Note);
    expect(note, 'the panel is still conceding a tail').toBeUndefined();
  });
});
