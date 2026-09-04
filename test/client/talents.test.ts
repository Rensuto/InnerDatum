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
  categoryHeadRect,
  talentDeepenAt,
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

/**
 * THE SECOND ARGUMENT IS THE ONE THAT WAS MISSING, and its absence is most of
 * why the two-purse bug survived: `as ProgressMsg` casts away every field this
 * object does not set, so `unspentGenerics` was silently `undefined` in every
 * test on this screen and the panel's `?? 0` read it as an empty generic purse.
 */
function progress(unspent: number, generics = 0): ProgressMsg {
  return {
    level: 2,
    xp: 1,
    xpToNext: 61,
    unspent,
    unspentGenerics: generics,
  } as ProgressMsg;
}

/** A generic tree, which spends the OTHER purse. See `isGenericTree`. */
const GROUNDWORK = { tree: 'generic/groundwork', treeName: 'Groundwork' };

/** The floor every window clears: `HUD_MIN_W`x`HUD_MIN_H`, 640x320. */
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

  describe('the level the game computes with', () => {
    /**
     * ═════════════════════════════════════════════════════════════════════════
     * `Actor.lua:6217` — "Effective talent level: %.1f", upstream's FIRST line.
     * ═════════════════════════════════════════════════════════════════════════
     *
     * The `Talent level` row is the rank a player BUYS. `getTalentLevel` is
     * `raw x mastery` and that is what every number in the description below is
     * computed from, so the pane printed 3 beside numbers derived from 3.9 and
     * never named the gap. Not exotic here: every class authors a signature tree
     * at 1.3 (`classes.ts:367`).
     */
    it('prints the raw rank times the tree mastery', () => {
      const texts = paintPanel({
        rows: talentPanelRows(
          view({
            loadout: [talent({ id: 'a', name: 'A', ...DISCIPLINE, mastery: 1.3, level: 3 })],
            passives: [],
          }),
        ),
        focusId: 'a',
      });
      expect(texts, 'the effective level is nowhere on the pane').toContain('3.9');
    });

    /**
     * AND NOT WHERE IT WOULD ONLY RESTATE THE RANK. A tree at mastery 1 makes
     * the two figures identical, and a second row saying "3.0" beside "3 → 4" is
     * the furniture the mastery header refuses for `(x1.00)` one screen up.
     */
    it('says nothing on a tree with no mastery', () => {
      const texts = paintPanel({
        rows: talentPanelRows(
          view({
            loadout: [talent({ id: 'a', name: 'A', ...DISCIPLINE, mastery: 1, level: 3 })],
            passives: [],
          }),
        ),
        focusId: 'a',
      });
      expect(texts).not.toContain('3.0');
    });

    /** NOR ON AN UNLEARNED ONE, whose effective level is a truthful 0.0. */
    it('says nothing before the talent is learned', () => {
      const texts = paintPanel({
        rows: talentPanelRows(
          view({
            loadout: [talent({ id: 'a', name: 'A', ...DISCIPLINE, mastery: 1.3, level: 0 })],
            passives: [],
          }),
        ),
        focusId: 'a',
      });
      expect(texts).not.toContain('0.0');
    });
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

  it('stacks two CLASS categories in one column, not side by side', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THIS CASE USED TO ASSERT THE OPPOSITE, AND THE OPPOSITE WAS THE BUG.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * It read *"same row, different columns — which is the whole shape of the
     * screenshot"*, and it was true of a grid that packed as many columns as
     * fitted and flowed class and generic disciplines through them together.
     * The player's second screenshot is of that shape and the words under it
     * are *"we have a middle category that is two columns wide and should only
     * be 1"*.
     *
     * A column here means a PURSE, not a slot: `tome/dialogs/LevelupDialog.lua`
     * :505-506 dispatches every category into `ctree` or `gtree` and :822/:826
     * place the two side by side. Both of `view()`'s trees are class trees, so
     * they belong in the same pane, one under the other.
     */
    const cats = placedAt(REAL).filter((p) => p.row.kind === TalentRowKind.Category);
    expect(cats).toHaveLength(2);
    expect(cats[0]?.rect.x, 'two class trees landed in different columns').toBe(cats[1]?.rect.x);
    expect(cats[0]?.rect.y).toBeLessThan(cats[1]?.rect.y ?? 0);
  });

  it('and puts a generic category in the other column, beside the class one', () => {
    /**
     * THE OTHER HALF, and without it the case above is satisfied by a layout
     * with one column — which is not what was asked for and not what upstream
     * does. `GROUNDWORK` is a generic tree, so it heads the second pane at the
     * same height the first class tree heads the first.
     */
    const withGeneric = view({
      loadout: [
        talent({ id: 'talent:crude_blow', name: 'Crude Blow', ...DISCIPLINE }),
        talent({ id: 'talent:shore_up', name: 'Shore Up', ...GROUNDWORK }),
      ],
      passives: [],
    });
    const cats = talentPanelGeometry(
      rectAt(REAL),
      talentPanelRows(withGeneric),
      NO_SCROLL,
    ).placed.filter((p) => p.row.kind === TalentRowKind.Category);
    expect(cats).toHaveLength(2);
    expect(cats[0]?.rect.y, 'the two purses are not level').toBe(cats[1]?.rect.y);
    expect(cats[0]?.rect.x).toBeLessThan(cats[1]?.rect.x ?? 0);
  });

  it('captions each column with the purse it spends', () => {
    /**
     * `tome/dialogs/LevelupDialog.lua:814-836` places `b_class` and `b_generic`
     * directly over their own pane, so "Class points: 2" is read above the
     * column those points can be spent in. Ours had one merged sentence and a
     * `· generic` suffix on the heading, which this file's own note called out
     * as the reason nothing on screen said why one strip was live and the one
     * under it grey.
     */
    const geometry = talentPanelGeometry(
      rectAt(REAL),
      talentPanelRows(view({ progress: progress(2, 3) })),
      NO_SCROLL,
    );
    expect(geometry.panes).toHaveLength(2);
    expect(geometry.panes[0]?.generic).toBe(false);
    expect(geometry.panes[1]?.generic).toBe(true);
    expect(geometry.panes[0]?.text).toContain('2');
    expect(geometry.panes[1]?.text).toContain('3');
    // Each caption sits over its own column, and neither scrolls with it.
    const cats = geometry.placed.filter((p) => p.row.kind === TalentRowKind.Category);
    expect(geometry.panes[0]?.rect.x).toBe(cats[0]?.rect.x);
    for (const cat of cats) {
      expect(cat.rect.y).toBeGreaterThanOrEqual(
        (geometry.panes[0]?.rect.y ?? 0) + (geometry.panes[0]?.rect.h ?? 0),
      );
    }
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

  it('has room for a FOURTH at every window but the floor, where it scrolls', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE COST OF ONE COLUMN PER PURSE, STATED RATHER THAN DISCOVERED.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * This used to demand four at every viewport including the floor, and it
     * was true of a width-packed grid that flowed four class trees into two
     * columns of two. A pane is one category wide now — `ctree` and `gtree`,
     * `tome/dialogs/LevelupDialog.lua:822` and :826 — so four class trees are
     * four rows deep in one column, and at the 640x320 floor the panel is 228
     * tall and holds three of them.
     *
     * The player asked for exactly this trade in the same sentence as the
     * layout: *"should only be 1, even if the player has to scroll down."* So
     * the assertion is that the fourth is REACHABLE, not that it is on screen
     * at the smallest window this client can produce.
     */
    for (const [w, h] of VIEWPORTS) {
      if (w === 640 && h === 320) continue;
      const size = { width: w, height: h, top: 40, bottom: h - 40 };
      expect(categoriesPlacedAt(size, 4), `${String(w)}x${String(h)}`).toBe(4);
    }
  });

  it('and at the floor the fourth is reachable by scrolling, not lost', () => {
    const size = { width: 640, height: 320, top: 40, bottom: 280 };
    const rect = talentPanelRect(size);
    expect(rect).not.toBeNull();
    if (rect === null) return;
    const rows = talentPanelRows(nCategories(4));

    const unscrolled = talentPanelGeometry(rect, rows, NO_SCROLL);
    expect(unscrolled.placed.filter((p) => p.row.kind === TalentRowKind.Category)).toHaveLength(3);
    expect(unscrolled.grid.maxScroll, 'nothing to scroll, so the fourth is LOST').toBeGreaterThan(
      0,
    );

    // Scrolled to the end, the last category is on screen.
    const scrolled = talentPanelGeometry(rect, rows, unscrolled.grid.maxScroll);
    const last = scrolled.placed
      .filter((p) => p.row.kind === TalentRowKind.Category)
      .map((p) => (p.row.kind === TalentRowKind.Category ? p.row.tree : ''));
    expect(last, 'the fourth category is unreachable at any scroll').toContain('t/3');
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
    // `HUD_MIN_W` is 640 interface pixels — and a description
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
     * ═══ AND IT NOW COSTS THE GRID NOTHING AT ALL ═══
     * The measurement above and the whole "the pane costs about a column"
     * argument belonged to a width-packed grid. The grid is two panes wide at
     * every window — one per purse, `tome/dialogs/LevelupDialog.lua:822` and
     * :826 — so its width is a constant and the description takes only slack
     * the disciplines were never going to use. That is a stronger property than
     * the floor this used to assert, so it is asserted as an equality.
     */
    const narrowGrid = at(1100);
    for (const width of [1280, 1440, 1920]) {
      expect(at(width).cols, `${String(width)} columns beside the pane`).toBe(narrowGrid.cols);
    }
    expect(narrowGrid.cols, 'both purses are on screen without the pane').toBeGreaterThanOrEqual(1);
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
     * `HUD_MIN_W` is 640 interface pixels. Spending a point is a
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

describe('the two purses, which are not interchangeable', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE BUG: the panel read `unspent` for everything, and generic points arrive
   * FOUR LEVELS OUT OF FIVE.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * The server has kept the purses apart since they existed —
   * `fromGenerics ? body.unspentGenerics : body.unspentPoints` (gateway.ts) —
   * and `ProgressMsg` carries both. The panel read one, so the ordinary
   * level-up state (class 0, generic 2) drew "no points — next at level 3" over
   * a screen of live generic icons that could not be pressed.
   *
   * Upstream shows both counters side by side, always, and marks every node
   * `(generic)` or `(class)` (LevelupDialog.lua:583, :754-789).
   */

  /** Two talents, one in a class tree and one in a generic tree. */
  function twoTrees(over: Partial<TalentPanelView> = {}): TalentPanelView {
    return view({
      loadout: [
        talent({ id: 'talent:hold_the_line', name: 'Hold the Line', ...DISCIPLINE }),
        talent({ id: 'talent:long_stride', name: 'Long Stride', ...GROUNDWORK }),
      ],
      passives: [],
      ...over,
    });
  }

  const cellFor = (rows: readonly TalentRow[], id: string) =>
    categories(rows)
      .flatMap((row) => row.talents)
      .find((cell) => cell.id === id);

  it('lets a generic point buy a generic talent when the class purse is empty', () => {
    // THE REGRESSION, stated the way a player meets it: two generic points in
    // hand, every generic icon dead.
    const rows = talentPanelRows(twoTrees({ progress: progress(0, 2) }));
    expect(cellFor(rows, 'talent:long_stride')?.canSpend).toBe(true);
  });

  it('does not let a generic point buy a CLASS talent', () => {
    // The other direction, and the server would refuse it: a live `+` the
    // server answers "no class talent points in hand" is worse than a grey one.
    const rows = talentPanelRows(twoTrees({ progress: progress(0, 2) }));
    expect(cellFor(rows, 'talent:hold_the_line')?.canSpend).toBe(false);
  });

  it('does not let a class point buy a GENERIC talent', () => {
    const rows = talentPanelRows(twoTrees({ progress: progress(2, 0) }));
    expect(cellFor(rows, 'talent:hold_the_line')?.canSpend).toBe(true);
    expect(cellFor(rows, 'talent:long_stride')?.canSpend).toBe(false);
  });

  it('names both purses rather than only one', () => {
    const rows = talentPanelRows(twoTrees({ progress: progress(2, 1) }));
    const points = rows.find((row) => row.kind === TalentRowKind.Points);
    expect(points?.kind === TalentRowKind.Points ? points.text : '').toBe(
      '2 class · 1 generic to spend',
    );
  });

  it('does not say "no points" while a generic point is in hand', () => {
    // THE EXACT SENTENCE THE BUG PRODUCED, pinned so it cannot come back.
    const rows = talentPanelRows(twoTrees({ progress: progress(0, 2) }));
    const points = rows.find((row) => row.kind === TalentRowKind.Points);
    const text = points?.kind === TalentRowKind.Points ? points.text : '';
    expect(text).not.toContain('no points');
    expect(text).toBe('2 generic to spend');
  });

  it('lights the plate for a level-up that granted only generics', () => {
    // `unspent` on the row is what the painter highlights on. Reading the class
    // purse alone left it dark on four level-ups in five.
    const rows = talentPanelRows(twoTrees({ progress: progress(0, 2) }));
    const points = rows.find((row) => row.kind === TalentRowKind.Points);
    expect(points?.kind === TalentRowKind.Points ? points.unspent : 0).toBe(2);
  });

  it('marks the generic strip so the player can see which purse it spends', () => {
    const rows = talentPanelRows(twoTrees({ progress: progress(1, 1) }));
    const generic = categories(rows).find((row) => row.tree === 'generic/groundwork');
    const klass = categories(rows).find((row) => row.tree === 'watch/discipline');
    expect(generic?.text).toContain('generic');
    // AND THE CLASS ONE IS NOT MARKED. Labelling the majority case is furniture.
    expect(klass?.text).toBe('Discipline');
  });

  it('still falls back to the level sentence when every purse is empty', () => {
    const rows = talentPanelRows(twoTrees({ progress: progress(0, 0) }));
    const points = rows.find((row) => row.kind === TalentRowKind.Points);
    expect(points?.kind === TalentRowKind.Points ? points.text : '').toBe(
      'no points — next at level 3',
    );
  });
});

describe('the attribute ceiling is on the control, not only in the refusal', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * LevelupDialog.lua:255-260 refuses the press; :584, :593 and :610-616 PAINT
   * the row so the player knows before they press.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Ours had no ceiling at all below an unreachable 100, so three points a level
   * could all go into one attribute. Now the rule is ported, this column has to
   * show it — a `+` that looks live and earns a red refusal banner is the worst
   * of both.
   */

  /** `SIX` is str 25 / dex 14 / con 21 / mag 10 / wil 14 / cun 12, all composed. */
  const glyphs = (over: Partial<Parameters<typeof drawTalentPanel>[0]>) =>
    paintPanel(over).filter((text) => text === '+' || text === '–');

  it('greys the attributes at the ceiling and leaves the rest live', () => {
    /**
     * At level 3 the ceiling is 24.2. Of the six BOUGHT values below, only `str`
     * at 25 is at or over it, so exactly one control goes dead — and the other
     * five must not, or the whole column would look broken on the level where
     * one attribute happens to be ahead.
     */
    const drawn = glyphs({
      level: 3,
      statBase: { str: 25, dex: 14, con: 21, mag: 10, wil: 14, cun: 12 },
    });
    expect(drawn.filter((g) => g === '–')).toHaveLength(1);
    expect(drawn.filter((g) => g === '+')).toHaveLength(5);
  });

  it('opens the control again as the level catches up', () => {
    // Level 18: the ceiling is 45.2 and nothing here is near it.
    const drawn = glyphs({
      level: 18,
      statBase: { str: 25, dex: 14, con: 21, mag: 10, wil: 14, cun: 12 },
    });
    expect(drawn.filter((g) => g === '–')).toHaveLength(0);
  });

  it('asks the BOUGHT value, not the composed one', () => {
    /**
     * ═══ THE ONE THAT WOULD HURT ═══
     * `stats` here says str 25 while `statBase` says 20 — a body wearing +5 to
     * Strength. Upstream drops every increment (`no_inc`) for exactly this: a
     * good coat must never cost you a point you already own, or taking it off
     * would be a way to level up.
     */
    const drawn = glyphs({
      level: 3,
      stats: { str: 25, dex: 14, con: 21, mag: 10, wil: 14, cun: 12 },
      statBase: { str: 20, dex: 14, con: 21, mag: 10, wil: 14, cun: 12 },
    });
    expect(drawn.filter((g) => g === '–')).toHaveLength(0);
  });

  it('leaves every control live against a server that sends no base', () => {
    // The additive-field contract: an older server loses the affordance, never
    // the ability to spend. The server's refusal is the backstop.
    const drawn = glyphs({ level: 1, statBase: null });
    expect(drawn.filter((g) => g === '–')).toHaveLength(0);
    expect(drawn.filter((g) => g === '+')).toHaveLength(6);
  });

  it('prints the base in brackets when armour is doing some of the work', () => {
    // `25 (20)` — LevelupDialog.lua:624-627. It is also what explains a greyed
    // control beside a number that looks nowhere near any limit.
    const texts = paintPanel({
      level: 3,
      stats: { str: 25, dex: 14, con: 21, mag: 10, wil: 14, cun: 12 },
      statBase: { str: 20, dex: 14, con: 21, mag: 10, wil: 14, cun: 12 },
    });
    expect(texts).toContain('25 (20)');
    // ...AND NOT WHEN THEY AGREE. `(14)` beside a bare 14 on every row is
    // furniture — the same argument the mastery header makes for `(x1.00)`.
    expect(texts).toContain('14');
    expect(texts).not.toContain('14 (14)');
  });
});

describe('the pane says what the next rank wants, before it refuses you', () => {
  /**
   * `lockedReason` exists only while a gate is closed, so on its own it taught
   * nobody anything until the day it stopped them. `LoadoutTalent.requires` is
   * present either way — ToME's `getTalentReqDesc` lists every requirement every
   * time (ActorTalents.lua:744-798).
   */
  const withReqs = (
    requires: readonly { text: string; met: boolean }[],
    over: Partial<LoadoutTalent> = {},
  ) =>
    paintPanel({
      rows: talentPanelRows(
        view({
          loadout: [
            talent({
              id: 'talent:hold_the_line',
              name: 'Hold the Line',
              requires,
              ...DISCIPLINE,
              ...over,
            }),
          ],
          passives: [],
        }),
      ),
      focusId: 'talent:hold_the_line',
    });

  it('prints a requirement that is already met', () => {
    // THE ONE THAT WAS MISSING ENTIRELY. A met requirement is the whole reason
    // this exists — it is what lets a player plan three ranks ahead.
    const texts = withReqs([{ text: '18 str (25)', met: true }]);
    expect(texts).toContain('Needs');
    expect(texts.some((t) => t.includes('18 str (25)'))).toBe(true);
  });

  it('marks an unmet one differently without relying on colour', () => {
    // `!` versus `·` — the rule ui/partypanel.ts states and this file follows
    // everywhere. A player who cannot separate orange from bone still reads it.
    const unmet = withReqs([{ text: '18 str (14)', met: false }]);
    const met = withReqs([{ text: '18 str (25)', met: true }]);
    expect(unmet.some((t) => t.startsWith('!'))).toBe(true);
    expect(met.some((t) => t.startsWith('·'))).toBe(true);
    expect(met.some((t) => t.startsWith('!'))).toBe(false);
  });

  it('lists every clause rather than only the first that fails', () => {
    const texts = withReqs([
      { text: '2 others in this discipline (0)', met: false },
      { text: 'level 6', met: false },
      { text: '18 str (14)', met: false },
    ]);
    expect(texts.filter((t) => t.startsWith('!'))).toHaveLength(3);
  });

  it('says nothing at all when there is nothing to require', () => {
    // A talent at its cap has no next rank, and an empty heading is furniture.
    expect(withReqs([])).not.toContain('Needs');
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * DEEPENING A CATEGORY — LevelupDialog.lua:433-437's `else` branch.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The other thing a category point buys, and it had no surface at all: the panel
 * offered locked trees and nothing else, so two of the three points a character
 * ever sees had nothing to be spent on once the disciplines they wanted were
 * bought.
 *
 * THE OFFER GOES ON THE HEADER, because what is bought is the CATEGORY and not
 * any talent in it — which is where upstream puts its own +/- as well.
 */
describe('the deepen offer', () => {
  const deepenable = (over: Partial<TalentPanelView> = {}) =>
    view({ deepenable: ['watch/discipline'], categories: 1, ...over });

  it('appears on the named category and on no other', () => {
    const rows = categories(talentPanelRows(deepenable()));
    const offered = rows.filter((row) => row.deepen).map((row) => row.tree);
    expect(offered).toEqual(['watch/discipline']);
  });

  it('names the NUMBER it would reach, not the step', () => {
    // "+0.2" is arithmetic a player has to do while deciding whether to spend
    // the scarcest currency in the game. "→ x1.20" is the answer to it.
    const row = categories(talentPanelRows(deepenable())).find((r) => r.deepen);
    expect(row?.text).toContain('x1.20');
  });

  it('is silent with no category point in hand', () => {
    /**
     * BOTH CLAUSES ARE NEEDED and this is the one that is easy to drop. The
     * server's list answers "has this been deepened"; only the purse answers
     * "can you afford it". An offer drawn with an empty purse is a live control
     * the server refuses, which `TalentCell.canUnlearn` records as reading like
     * a broken button rather than like a rule.
     */
    const rows = categories(talentPanelRows(deepenable({ categories: 0 })));
    expect(rows.some((row) => row.deepen)).toBe(false);
    expect(rows.every((row) => !row.text.includes('deepen'))).toBe(true);
  });

  it('is silent for a tree the server did not list', () => {
    // A tree already deepened is absent from `deepenable` forever — upstream's
    // "You can only improve a category mastery once!" stated as data.
    const rows = categories(talentPanelRows(view({ deepenable: [], categories: 1 })));
    expect(rows.some((row) => row.deepen)).toBe(false);
  });

  it('never offers on a LOCKED tree, whose icons already spend the same point', () => {
    // Two live offers in one category would make "which one did I just buy"
    // unanswerable at the moment of no return.
    const rows = categories(
      talentPanelRows(
        view({
          categories: 1,
          deepenable: ['generic/leverage'],
          unlockable: [
            { id: 'generic/leverage', name: 'Leverage', blurb: 'Weight and angles.', talents: [] },
          ],
        }),
      ),
    );
    const locked = rows.find((row) => row.tree === 'generic/leverage');
    expect(locked?.deepen).toBe(false);
  });

  it('a press on the heading names the tree, and elsewhere names nothing', () => {
    /**
     * THE JOIN. Every assertion above passes with `talentDeepenAt` returning
     * null for everything — a row flag nothing reads, which is this project's
     * signature defect and has cost it two commits in two days.
     */
    const rows = talentPanelRows(deepenable());
    const rect = rectAt(REAL);
    const placed = talentPanelGeometry(rect, rows, NO_SCROLL).placed;
    const target = placed.find(
      (p) => p.row.kind === TalentRowKind.Category && p.row.deepen === true,
    );
    expect(target, 'no deepenable category was placed').toBeDefined();
    if (target === undefined) return;

    const head = categoryHeadRect(target.rect);
    const hit = talentDeepenAt(
      { x: head.x + head.w / 2, y: head.y + 1 },
      talentPanelGeometry(rect, rows, NO_SCROLL),
    );
    expect(hit).toBe('watch/discipline');

    // BELOW THE HEADING IS THE ICON STRIP, which spends a TALENT point. A
    // deepen reader that claimed the whole category would silently turn every
    // talent press in that tree into an irreversible category spend.
    const below = talentDeepenAt(
      { x: head.x + head.w / 2, y: head.y + head.h + 4 },
      talentPanelGeometry(rect, rows, NO_SCROLL),
    );
    expect(below).toBeNull();
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * `Stats:9to spend` — TWO SENTENCES SHARING AN ORIGIN.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Reported from a screenshot, verbatim, as the panel's heading. It is
 * `Stats: 9` and `9 stat to spend` drawn on the same bold-10px-mono baseline
 * six pixels apart, with `drawStats` running last and overprinting the first
 * forty-two pixels of the sentence — so the clean tail `to spend` is all that
 * survives.
 *
 * THE CAUSE IS ONE MISSING TERM. `afterStats` is the reserve taken off the LEFT
 * for the attribute column. It was applied to `gridX` and to `barX` and not to
 * the sentence rows, which still started at the panel's own inset while
 * carrying the already-narrowed `innerW`. It fires at every box `HUD_MIN_W` can
 * produce, not only wide ones — the attribute column is earned at 530 and the
 * floor gives 560.
 */
describe('the points sentence is not drawn on top of the attribute column', () => {
  for (const [name, size] of [
    ['the 640x320 floor', FLOOR],
    ['the reported window', REAL],
  ] as const) {
    it(`clears the stats box at ${name}`, () => {
      const geometry = talentPanelGeometry(rectAt(size), talentPanelRows(view()), NO_SCROLL);
      const stats = geometry.stats;
      expect(stats, 'no attribute column — this case proves nothing').not.toBeNull();

      const sentences = geometry.placed.filter(
        (placed) => placed.row.kind !== TalentRowKind.Category,
      );
      expect(sentences.length, 'no sentence row to collide with').toBeGreaterThan(0);

      for (const placed of sentences) {
        expect(
          placed.rect.x,
          `a sentence starts at ${String(placed.rect.x)}, inside the stats box`,
        ).toBeGreaterThanOrEqual((stats?.x ?? 0) + (stats?.w ?? 0));
      }
    });
  }

  it('and stays inside the panel it was narrowed for', () => {
    /**
     * THE OTHER HALF: moving a row right is only a fix if it does not then run
     * off the end. The sentence carries `innerW`, which was already reduced by
     * the stats column, so shifting its origin by the same reserve has to land
     * it exactly within the grid's own span rather than past it.
     */
    const rect = rectAt(FLOOR);
    const geometry = talentPanelGeometry(rect, talentPanelRows(view()), NO_SCROLL);
    for (const placed of geometry.placed) {
      if (placed.row.kind === TalentRowKind.Category) continue;
      expect(placed.rect.x + placed.rect.w).toBeLessThanOrEqual(rect.x + rect.w);
    }
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE TWO PURSES ARE TWO COLUMNS, AND EACH SAYS WHAT IT SPENDS.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `tome/dialogs/LevelupDialog.lua:505-506` dispatches every category into
 * `ctree` or `gtree`; :694 and :715 build a tree pane for each; :822 and :826
 * place them side by side; and :814-836 put `b_class` and `b_generic` directly
 * over their own pane. Ours flowed both kinds through one width-packed grid and
 * distinguished them with a `· generic` suffix on the heading.
 */
describe('the pane captions', () => {
  it('are painted, one per purse, with their own counts', () => {
    const texts = paintPanel({ rows: talentPanelRows(view({ progress: progress(2, 3) })) });
    expect(texts.some((t) => t.startsWith('CLASS') && t.includes('2'))).toBe(true);
    expect(texts.some((t) => t.startsWith('GENERIC') && t.includes('3'))).toBe(true);
  });

  it('say `1 point` rather than `1 points`', () => {
    const texts = paintPanel({ rows: talentPanelRows(view({ progress: progress(1, 0) })) });
    expect(texts).toContain('CLASS  1 point');
    expect(texts).toContain('GENERIC  0 points');
  });

  it('and a pane with nothing in it still carries its caption', () => {
    /**
     * "GENERIC 0 points" over an empty column answers "where do generic points
     * go". A missing column answers nothing, and this character has no generic
     * tree at all — which is the ordinary state before the first generic
     * discipline is bought.
     */
    const texts = paintPanel({ rows: talentPanelRows(view()) });
    expect(texts.some((t) => t.startsWith('GENERIC'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// A tree shorter than the grid
// ---------------------------------------------------------------------------

describe('a short strip is centred, not left with a hole', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * WHY THIS IS THE TEST THAT LETS `TalentTree.size` EXIST.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `talent-trees.test.ts` demanded six talents in EVERY tree, and its reason was
   * this row: "a tree with four draws a gap in a row of boxes, which reads as a
   * talent that failed to load rather than as a tree with room in it". That is
   * true of a LEFT-ALIGNED short row — the blank on the right reads as missing.
   *
   * Centring is what makes a declared-short tree honest, so the rule could change
   * from "always six" to "exactly what you declared".
   *
   * SYMMETRY IS ASSERTED, NOT A PIXEL COUNT. It is the property that matters and
   * the only one true at every length: a FULL strip is symmetric with zero on
   * both sides, so this covers the "a full row must not move" case without
   * needing a six-talent fixture to exist.
   */
  function stripsOf(count: number) {
    const rows = talentPanelRows(view());
    const trimmed = categories(rows).map((row) => ({
      ...row,
      talents: row.talents.slice(0, count),
    }));
    return placedAt(REAL, trimmed).filter((p) => p.row.kind === TalentRowKind.Category);
  }

  it('leaves the same blank on both sides, at every length', () => {
    for (const count of [1, 2, 3]) {
      for (const placed of stripsOf(count)) {
        const first = placed.cells[0];
        const last = placed.cells[placed.cells.length - 1];
        if (first === undefined || last === undefined) continue;
        const leftGap = first.x - placed.rect.x;
        const rightGap = placed.rect.x + placed.rect.w - (last.x + last.w);
        // WITHIN A PIXEL, because the inset floors — an odd remainder cannot split.
        expect(
          Math.abs(leftGap - rightGap),
          `at ${String(count)}: ${String(leftGap)} vs ${String(rightGap)}`,
        ).toBeLessThanOrEqual(1);
      }
    }
  });

  /** A shorter strip is inset FURTHER — the centring actually moves with length. */
  it('insets a shorter strip more than a longer one', () => {
    const one = stripsOf(1)[0];
    const three = stripsOf(3)[0];
    if (one === undefined || three === undefined) return;
    const gap = (p: typeof one) => (p.cells[0]?.x ?? 0) - p.rect.x;
    expect(gap(one), 'a lone icon sits no further in than three').toBeGreaterThan(gap(three));
  });

  /** …and it is still clickable where it is drawn, which is the whole contract. */
  it('keeps the press on the icon after the move', () => {
    const rows = talentPanelRows(view());
    const trimmed = categories(rows).map((row) => ({ ...row, talents: row.talents.slice(0, 1) }));
    const rect = rectAt(REAL);
    const placed = talentPanelGeometry(rect, trimmed, NO_SCROLL).placed.find(
      (p) => p.row.kind === TalentRowKind.Category,
    );
    const box = placed?.cells[0];
    if (box === undefined) return;
    expect(talentPanelHitAt(rect, trimmed, box.x + 2, box.y + 2, NO_SCROLL)?.kind).toBe(
      TalentHitKind.Row,
    );
  });
});
