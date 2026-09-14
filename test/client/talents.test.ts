/// <reference lib="dom" />

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { CATEGORY_POINT_LEVELS, MAX_CHARACTER_LEVEL } from '../../src/shared/progression.ts';

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
  talentPanelWideW,
  STAT_ROWS,
  drawTalentPanel,
  SPEND_CONFIRM_MIN_MS,
  TALENT_MESSAGE_FADE_MS,
  TALENT_MESSAGE_HOLD_MS,
  TALENT_FADE_STEP_MS,
  talentMessageAlpha,
  talentMessageWake,
  TalentMessageTone,
  confirmTooSoon,
  statPressRefusal,
  statNeverRises,
  talentHeaderMessage,
  talentPressRefusal,
  statCellLook,
  statCellRects,
  statCellZone,
  statMinusRect,
  talentMinusRect,
  talentStatAt,
  talentIdAt,
  TALENT_SCROLL_STEP,
  categoryHeadRect,
  talentDeepenAt,
  talentPanelDeepenAt,
  talentHeadingAt,
  talentPanelHeadingAt,
  headingPressRefusal,
  treeSpendFor,
  takeBackStillOffered,
  TAKE_BACK_GUARD_MARGIN,
  TAKE_BACK_GUARD_MS,
  guardTakeBack,
  pressAgainstGuard,
  talentPanelRows,
  talentTipAt,
} from '../../src/client/ui/talents.ts';
import { HEADER_H } from '../../src/client/ui/panel.ts';
import { TALENT_MAX_LEVEL } from '../../src/shared/progression.ts';
import type { TalentPanelView, TalentRow } from '../../src/client/ui/talents.ts';
import type { PanelRect } from '../../src/client/ui/panel.ts';
import { ResourceKind } from '../../src/shared/protocol.ts';
import { PALETTE } from '../../src/client/render/canvas.ts';
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

/** The WHOLE geometry, for the tests that ask about columns rather than rows. */
function geoAt(size: typeof FLOOR, rows?: readonly TalentRow[], scroll = NO_SCROLL) {
  return talentPanelGeometry(rectAt(size), rows ?? talentPanelRows(view()), scroll);
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

  it('prints the mastery and the purse on every heading, as upstream does', () => {
    // `LevelupDialog.lua:493-500`: every known type shows its mastery and names its
    // purse. Ruled 1:1 in Inner Datum's style, so "(x1.00)" and "class" are said.
    const plain = categories(talentPanelRows(view()))[0];
    expect(plain?.text).toBe('Discipline  (x1.00)  — class');

    const tuned = talentPanelRows(
      view({
        loadout: [talent({ id: 'a', name: 'A', ...DISCIPLINE, mastery: 1.3 })],
        passives: [],
      }),
    );
    expect(categories(tuned)[0]?.text).toBe('Discipline  (x1.30)  — class');
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

    it('prints it at mastery 1.00 too, as upstream prints it on every talent', () => {
      // `Actor.lua:6217` has no condition. "3.0" appears nowhere else in this
      // fixture, so finding it is finding the row.
      const texts = paintPanel({
        rows: talentPanelRows(
          view({
            loadout: [talent({ id: 'a', name: 'A', ...DISCIPLINE, mastery: 1, level: 3 })],
            passives: [],
          }),
        ),
        focusId: 'a',
      });
      expect(texts).toContain('3.0');
    });

    it('prints 0.0 before the talent is learned', () => {
      const texts = paintPanel({
        rows: talentPanelRows(
          view({
            loadout: [talent({ id: 'a', name: 'A', ...DISCIPLINE, mastery: 1.3, level: 0 })],
            passives: [],
          }),
        ),
        focusId: 'a',
      });
      expect(texts).toContain('0.0');
    });
  });

  it('names each talent`s use mode in the pane — Actor.lua:6219-6223', () => {
    // Upstream prints Passive, Sustained or Activated. A sustain used to read
    // "Activated", so each of the three is painted and read back.
    const modeOf = (fixture: Parameters<typeof talent>[0], passive: boolean) =>
      paintPanel({
        rows: talentPanelRows(
          view({
            loadout: passive ? [] : [talent(fixture)],
            passives: passive ? [talent(fixture)] : [],
          }),
        ),
        focusId: fixture.id,
      });
    expect(modeOf({ id: 'p', name: 'P', kind: 'passive', ...DISCIPLINE }, true)).toContain(
      'Passive — always on',
    );
    expect(modeOf({ id: 's', name: 'S', kind: 'sustained', ...DISCIPLINE }, false)).toContain(
      'Sustained — toggle, stays on',
    );
    const active = modeOf({ id: 'a', name: 'A', ...DISCIPLINE }, false);
    expect(active).toContain('Activated');
    expect(active).not.toContain('Sustained — toggle, stays on');
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

  it('puts each purse’s counter over its own column, and no caption repeats it', () => {
    /**
     * `tome/dialogs/LevelupDialog.lua:814-836` places `b_class` and `b_generic`
     * directly over their own pane, and nothing else: no caption row. Ours had
     * both — `Class points: 2` in its box and `CLASS  2 points` under it — two
     * renderings of one number twenty-nine pixels of grid tall.
     */
    const rows = talentPanelRows(view({ progress: progress(2, 3) }));
    const rect = rectAt(REAL);
    const geometry = talentPanelGeometry(rect, rows, NO_SCROLL);
    expect(geometry.panes).toHaveLength(2);
    expect(geometry.panes[0]?.generic).toBe(false);
    expect(geometry.panes[1]?.generic).toBe(true);
    const cats = geometry.placed.filter((p) => p.row.kind === TalentRowKind.Category);
    expect(geometry.panes[0]?.rect.x).toBe(cats[0]?.rect.x);

    const texts = paintOps({ rect, rows }).filter((op) => op.kind === 'fillText');
    const klass = texts.find((op) => String(op.args[0]) === 'Class points: 2');
    expect(klass, 'the class counter is gone').toBeDefined();
    // OVER ITS OWN COLUMN: the box starts at the pane and its text is padded in.
    expect(Number(klass?.args[1])).toBe((geometry.panes[0]?.rect.x ?? 0) + 5);
    expect(texts.map((op) => String(op.args[0]))).toContain('Generic points: 3');
    expect(texts.some((op) => /^(CLASS|GENERIC)\b/.test(String(op.args[0])))).toBe(false);
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

  it('names the pool the cost is in, not always Resolve', () => {
    /**
     * Both places this panel prints a cost -- the one-line meta and the detail
     * field -- said the literal word `resolve`, which is the Watchman's pool
     * and wrong for three of the four classes. Same defect as the hotbar
     * tooltip carried, in the screen you open on level-up rather than the card
     * you read mid-fight: a smaller audience for the wrong word, not a smaller
     * error.
     */
    const costed = view({
      pool: ResourceKind.Reagents,
      loadout: [
        talent({
          id: 'talent:crude_blow',
          name: 'Crude Blow',
          ...DISCIPLINE,
          cost: { ap: 4, mp: 0, resource: 2 },
        }),
      ],
    });
    const costedRows = talentPanelRows(costed);
    const cat = talentPanelGeometry(rect, costedRows, NO_SCROLL).placed.find(
      (p) => p.row.kind === TalentRowKind.Category,
    );
    const box = cat?.cells[0];
    if (box === undefined) return;

    const card = talentTipAt(rect, costedRows, box.x + 2, box.y + 2, NO_SCROLL);
    expect(card?.meta ?? '').toContain('Reagents');
    // AND NOT THE WORD IT USED TO SAY. The bug read as correct for years of
    // Watchman testing because Resolve is what it printed.
    expect(card?.meta ?? '').not.toContain('resolve');
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

  it('says a sustain is a toggle rather than pricing it like an attack', () => {
    /**
     * ═══ THE THIRD USE MODE, WHICH THIS CARD USED TO COLLAPSE ═══
     * `Actor.lua:6219-6223` prints `Use mode: Passive / Sustained / Activated`
     * on every talent upstream, because the three behave differently. This card
     * split on `passive` alone, so all five of the game's sustains printed the
     * ACTIVATED meta — an AP cost, a cooldown, a reach — with nothing saying the
     * press is a toggle that stays on and reserves part of the pool.
     *
     * The hotbar has known the difference since stances shipped; the panel a
     * player reads to decide what to LEARN did not.
     */
    const stance = view({
      loadout: [
        talent({
          id: 'talent:ledger_stances',
          name: 'Ledger Stances',
          kind: 'sustained',
          ...DISCIPLINE,
        }),
      ],
      passives: [],
    });
    const stanceRows = talentPanelRows(stance);
    const cat = talentPanelGeometry(rect, stanceRows, NO_SCROLL).placed.find(
      (p) => p.row.kind === TalentRowKind.Category,
    );
    const box = cat?.cells[0];
    if (box === undefined) throw new Error('the stance fixture drew no cell');

    const card = talentTipAt(rect, stanceRows, box.x + 2, box.y + 2, NO_SCROLL);
    expect(card?.meta, 'a sustain must say it toggles').toContain('toggle, stays on');
    // AND IT STILL PRINTS THE PRICE. A toggle is not free; what changed is that
    // the card leads with what the press DOES.
    expect(card?.meta).toContain('AP');
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
type Op = {
  readonly kind: string;
  readonly args: readonly unknown[];
  /** The `fillStyle` in force when the call was made. */
  readonly fill: unknown;
};

function recorder(ops: Op[]): CanvasRenderingContext2D {
  let fill: unknown = null;
  return new Proxy(
    {},
    {
      get: (_t, prop: string) => {
        if (prop === 'measureText') return (text: string) => ({ width: text.length * 6 });
        if (prop === 'canvas') return { width: 1280, height: 720 };
        return (...args: unknown[]) => {
          ops.push({ kind: prop, args, fill });
        };
      },
      set: (_t, prop: string, value: unknown) => {
        if (prop === 'fillStyle') fill = value;
        return true;
      },
    },
  ) as unknown as CanvasRenderingContext2D;
}

const NO_ART = { sprite: () => undefined } as unknown as Parameters<
  typeof drawTalentPanel
>[0]['sprites'];

const SIX = { str: 25, dex: 14, con: 21, mag: 10, wil: 14, cun: 12 };

function paintPanel(over: Partial<Parameters<typeof drawTalentPanel>[0]> = {}): string[] {
  return paintOps(over).flatMap((op) => (op.kind === 'fillText' ? [String(op.args[0])] : []));
}

/** Every canvas call the painter made, for a case that needs more than the text. */
function paintOps(over: Partial<Parameters<typeof drawTalentPanel>[0]> = {}): Op[] {
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
  return ops;
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

  /**
   * ═══ EVERY SIZE THIS GAME IS PLAYED AT, IN THE BAND IT IS ACTUALLY GIVEN ═══
   * The text column was checked for six rows at 1280x720 alone, where it was
   * 503 pixels tall. The first icon fold was then checked against `FLOOR` and
   * `REAL` — whose 40..280 and 40..320 bands are rounder than anything the game
   * produces — and placed all six there while placing four at the real floor.
   *
   * These are `panelBand` in main.ts: the top is the turn bar (14) plus the dock
   * margin (3), plus the turn cards (46) in combat; the bottom is the height less
   * the hotbar (60), two prose lines (14 each) and the margin (3).
   */
  const band = (width: number, height: number, combat: boolean) => ({
    width,
    height,
    top: 14 + (combat ? 46 : 0) + 3,
    bottom: height - 60 - 14 * 2 - 3,
  });
  const SIZES = [
    { name: 'the floor fixture', size: FLOOR },
    { name: 'the Discord fixture', size: REAL },
    { name: '640x320', size: band(640, 320, false) },
    { name: '640x320 in combat', size: band(640, 320, true) },
    { name: '772x367', size: band(772, 367, false) },
    { name: '772x367 in combat', size: band(772, 367, true) },
    { name: '640x384', size: { width: 640, height: 384, top: 60, bottom: 300 } },
    { name: '1280x720', size: band(1280, 720, false) },
  ] as const;

  it('answers the hit test by stat, not by index, at every size', () => {
    /**
     * `spend_stat` NAMES ONE OF SIX. An index would be a second ordering to keep
     * in step with `STAT_ROWS`, and the failure mode is a point spent on the
     * wrong attribute — which nothing outside town refunds.
     */
    for (const { name, size } of SIZES) {
      const rect = rectAt(size);
      const rows = talentPanelRows(view());
      const g = talentPanelGeometry(rect, rows, NO_SCROLL);
      if (g.stats === null) throw new Error(`no column at ${name}`);

      const icons = statCellRects(g.stats);
      expect(icons.length, `a stat was dropped at ${name}`).toBe(STAT_ROWS.length);
      for (let i = 0; i < icons.length; i += 1) {
        const icon = icons[i] as PanelRect;
        const cx = icon.x + Math.floor(icon.w / 2);
        const cy = icon.y + Math.floor(icon.h / 2);
        const hit = talentPanelHitAt(rect, rows, cx, cy, NO_SCROLL);
        expect(hit?.kind, `cell ${String(i)} at ${name} is not a stat hit`).toBe(
          TalentHitKind.Stat,
        );
        if (hit?.kind === TalentHitKind.Stat) expect(hit.stat).toBe(STAT_ROWS[i]?.key);
      }
    }
  });

  it('folds into two columns where six do not stack, and keeps every cell inside', () => {
    /**
     * ═══ A DROPPED STAT CANNOT BE BOUGHT ═══
     * There is no other route to spending an attribute point, so a cell that
     * does not fit is not a cosmetic loss. The column folds instead — and it
     * must fold only where it has to, or a tall window wastes the width the
     * player asked this panel not to waste.
     */
    const columnsAt = (size: (typeof SIZES)[number]['size']): number => {
      const rect = rectAt(size);
      const g = talentPanelGeometry(rect, talentPanelRows(view()), NO_SCROLL);
      if (g.stats === null) throw new Error('no column');
      const icons = statCellRects(g.stats);
      for (const icon of icons) {
        expect(icon.x).toBeGreaterThanOrEqual(g.stats.x);
        expect(icon.x + icon.w).toBeLessThanOrEqual(g.stats.x + g.stats.w);
        expect(icon.y).toBeGreaterThanOrEqual(g.stats.y);
        expect(icon.y + icon.h).toBeLessThanOrEqual(g.stats.y + g.stats.h);
      }
      for (let a = 0; a < icons.length; a += 1) {
        for (let b = a + 1; b < icons.length; b += 1) {
          const p = icons[a] as PanelRect;
          const q = icons[b] as PanelRect;
          const apart =
            p.x + p.w <= q.x || q.x + q.w <= p.x || p.y + p.h <= q.y || q.y + q.h <= p.y;
          expect(apart, `cells ${String(a)} and ${String(b)} overlap`).toBe(true);
        }
      }
      return new Set(icons.map((icon) => icon.x)).size;
    };
    expect(columnsAt(FLOOR)).toBe(2);
    expect(columnsAt(REAL)).toBe(2);
    expect(columnsAt({ width: 1280, height: 720, top: 60, bottom: 640 })).toBe(1);
    for (const { size } of SIZES) columnsAt(size);
  });

  it('drops to sixteen-pixel icons only where two columns of 32 cannot fit', () => {
    // THE DISCORD FRAME KEEPS FULL-SIZE ICONS IN COMBAT. Icons that shrank the
    // moment a fight started would move under the pointer at the worst time.
    const iconAt = (size: (typeof SIZES)[number]['size']): number => {
      const g = talentPanelGeometry(rectAt(size), talentPanelRows(view()), NO_SCROLL);
      if (g.stats === null) throw new Error('no column');
      return (statCellRects(g.stats)[0] as PanelRect).w;
    };
    expect(iconAt(band(640, 320, true))).toBe(16);
    expect(iconAt(band(640, 320, false))).toBe(32);
    expect(iconAt(band(772, 367, true))).toBe(32);
    expect(iconAt(band(772, 367, false))).toBe(32);
    expect(iconAt(band(1280, 720, false))).toBe(32);
  });

  it('keeps a small icon whole — its take-back badge sits beside it, not on it', () => {
    /**
     * The badge is asked before the icon. A ten-pixel corner on a sixteen-pixel
     * icon would leave the press that buys a six-pixel sliver.
     */
    const size = band(640, 320, true);
    const rect = rectAt(size);
    const rows = talentPanelRows(view());
    const g = talentPanelGeometry(rect, rows, NO_SCROLL);
    if (g.stats === null) throw new Error('no column');
    const cun = statCellRects(g.stats)[5] as PanelRect;
    const badge = statMinusRect(cun);
    const overlaps =
      badge.x < cun.x + cun.w &&
      cun.x < badge.x + badge.w &&
      badge.y < cun.y + cun.h &&
      cun.y < badge.y + badge.h;
    expect(overlaps, 'the badge covers the small icon').toBe(false);
    expect(badge.x, 'the badge left its cell').toBeGreaterThanOrEqual(g.stats.x);

    const onBadge = talentPanelHitAt(rect, rows, badge.x + 5, badge.y + 5, NO_SCROLL, null, [
      'cun',
    ]);
    expect(onBadge?.kind).toBe(TalentHitKind.UnspendStat);
    const onIcon = talentPanelHitAt(rect, rows, cun.x + 8, cun.y + 8, NO_SCROLL, null, ['cun']);
    expect(onIcon?.kind).toBe(TalentHitKind.Stat);
  });

  it('never lets an attribute’s badge reach another attribute’s hover zone, at any window size', () => {
    // WHY THE HOVER CAN ASK CELL BY CELL: a badge that overlaps only its own cell
    // names the same attribute whichever is asked first. Swept rather than
    // sampled, because the fold and the small icons are what move the badges.
    const rows = talentPanelRows(view());
    const intersects = (a: PanelRect, b: PanelRect) =>
      a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
    const layouts = new Set<string>();
    for (let width = 640; width <= 1920; width += 16) {
      for (let height = 320; height <= 1080; height += 8) {
        for (const combat of [false, true]) {
          const rect = rectAt(band(width, height, combat));
          const g = talentPanelGeometry(rect, rows, NO_SCROLL);
          if (g.stats === null) continue;
          const icons = statCellRects(g.stats);
          layouts.add(
            `${String(icons[0]?.w)}px ${String(new Set(icons.map((i) => i.x)).size)} col`,
          );
          icons.forEach((icon, j) => {
            const badge = statMinusRect(icon);
            icons.forEach((other, i) => {
              if (i !== j && intersects(badge, statCellZone(other))) {
                throw new Error(
                  `${String(STAT_ROWS[j]?.key)} badge in ${String(STAT_ROWS[i]?.key)} zone at ${String(width)}x${String(height)}`,
                );
              }
            });
          });
        }
      }
    }
    // AND THE SWEEP REACHED ALL THREE LAYOUTS, or it proved nothing about them.
    expect([...layouts].sort()).toEqual(['16px 2 col', '32px 1 col', '32px 2 col']);
  });

  it('answers a hover over an attribute’s badge with the attribute the press takes back', () => {
    // HOVER AND PRESS AGREE on every badge pixel, at both icon sizes. The 32-pixel
    // badge overhangs its icon's top-left corner, above the cell's own zone.
    const rows = talentPanelRows(view());
    const GAINS = { str: [], dex: [], con: [], mag: [], wil: [], cun: [] };
    for (const size of [band(1280, 720, false), band(640, 320, true)]) {
      const rect = rectAt(size);
      const g = talentPanelGeometry(rect, rows, NO_SCROLL);
      if (g.stats === null) throw new Error('no column');
      const icons = statCellRects(g.stats);
      STAT_ROWS.forEach((entry, i) => {
        const badge = statMinusRect(icons[i] as PanelRect);
        for (let y = badge.y; y < badge.y + badge.h; y += 1) {
          for (let x = badge.x; x < badge.x + badge.w; x += 1) {
            const where = `${entry.key} ${String(x)},${String(y)} at ${JSON.stringify(size)}`;
            const press = talentPanelHitAt(rect, rows, x, y, NO_SCROLL, null, [entry.key]);
            expect(press?.kind, where).toBe(TalentHitKind.UnspendStat);
            expect(talentStatAt(rect, rows, x, y, NO_SCROLL, [entry.key]), where).toBe(entry.key);
            // AND THE CARD, which asks the same reader on a window with no pane.
            expect(talentTipAt(rect, rows, x, y, NO_SCROLL, GAINS, [entry.key])?.title, where).toBe(
              entry.name,
            );
          }
        }
      });
    }
  });

  it('draws the 64-pixel art at exactly a half or a quarter, never a fraction', () => {
    /**
     * The HUD draws with smoothing off, so only an exact divisor stays sharp —
     * see `blitReduced`. The column draws at 32 and at 16, so the ratio is
     * checked where it is drawn rather than assumed.
     */
    const art = {
      sprite: (id: string) =>
        id.startsWith('icon_stat_') ? { id, image: {}, w: 64, h: 64 } : undefined,
    } as unknown as Parameters<typeof drawTalentPanel>[0]['sprites'];
    const sizesDrawn = (rect: PanelRect): number[] =>
      paintOps({ sprites: art, rect })
        .filter((op) => op.kind === 'drawImage')
        .map((op) => Number(op.args[3]));
    const tall = rectAt(band(1280, 720, false));
    expect(sizesDrawn(tall)).toEqual([32, 32, 32, 32, 32, 32]);
    const short = rectAt(band(640, 320, true));
    expect(sizesDrawn(short)).toEqual([16, 16, 16, 16, 16, 16]);
  });

  it('reads in the levelup dialog order, STR DEX CON MAG WIL CUN', () => {
    // `LevelupDialog.lua:571` — the screen's own order, not `load.lua`'s
    // definition order, which puts Constitution last.
    expect(STAT_ROWS.map((row) => row.key)).toEqual(['str', 'dex', 'con', 'mag', 'wil', 'cun']);
  });

  it('does not answer for the caption or the air between cells, only the icon', () => {
    // A press on a number is not a press on a control, and a press between two
    // icons must not arm whichever one the arithmetic happens to round towards.
    const rect = rectAt(FLOOR);
    const rows = talentPanelRows(view());
    const g = talentPanelGeometry(rect, rows, NO_SCROLL);
    if (g.stats === null) throw new Error('no column');
    const [str, dex] = statCellRects(g.stats) as [PanelRect, PanelRect];
    const onCaption = talentPanelHitAt(rect, rows, str.x + 16, str.y + str.h + 4, NO_SCROLL);
    expect(onCaption?.kind).not.toBe(TalentHitKind.Stat);
    const between = talentPanelHitAt(rect, rows, str.x + str.w + 2, str.y + 16, NO_SCROLL);
    expect(dex.x, 'the fixture needs two cells side by side').toBeGreaterThan(str.x + str.w + 2);
    expect(between?.kind).not.toBe(TalentHitKind.Stat);
  });

  it('asks the take-back corner before the icon it is carved out of', () => {
    const rect = rectAt(REAL);
    const rows = talentPanelRows(view());
    const g = talentPanelGeometry(rect, rows, NO_SCROLL);
    if (g.stats === null) throw new Error('no column');
    const con = statCellRects(g.stats)[2] as PanelRect;
    const corner = talentMinusRect(con);
    const px = corner.x + corner.w - 2;
    const py = corner.y + corner.h - 2;

    const offered = talentPanelHitAt(rect, rows, px, py, NO_SCROLL, null, ['con']);
    expect(offered?.kind).toBe(TalentHitKind.UnspendStat);
    if (offered?.kind === TalentHitKind.UnspendStat) expect(offered.stat).toBe('con');

    // AND ONLY WHERE THE SERVER OFFERED IT: the same pixel is the icon otherwise.
    const refused = talentPanelHitAt(rect, rows, px, py, NO_SCROLL, null, ['dex']);
    expect(refused?.kind).toBe(TalentHitKind.Stat);
  });

  it('paints the count and six cells, with or without a point in hand', () => {
    /**
     * ═══ THE ICONS DO NOT VANISH WITH THE LAST POINT ═══
     * The text column hid its `+` with nothing to spend. Upstream's stat icons
     * are always there, because they are also where the VALUE is — so all six
     * stay and simply stop being lit. On a bare clone the frame holds the
     * three-letter code, which is how these assertions see the six.
     */
    const withPoints = paintPanel();
    expect(withPoints).toContain('Stats: 3');
    for (const entry of STAT_ROWS) expect(withPoints).toContain(entry.label);

    const spent = paintPanel({ unspentStats: 0 });
    expect(spent).toContain('Stats: 0');
    for (const entry of STAT_ROWS) expect(spent).toContain(entry.label);
  });

  it('draws the count but no cells when the server has said nothing', () => {
    // THE HALF THAT MUST NOT MOVE. A client that has had no `progress` frame
    // yet must not invent zeroes — six cells of `0 (0)` is a lie about a
    // character.
    const silent = paintPanel({ stats: null, unspentStats: 0 });
    expect(silent).toContain('Stats: 0');
    for (const entry of STAT_ROWS) expect(silent).not.toContain(entry.label);
  });

  it('draws the art when it is there, and the code only when it is not', () => {
    // `icon` is a literal per row — see `STAT_ROWS`. Asserted through the
    // painter, so a row whose key never reaches `sprites.sprite` is caught.
    const asked: string[] = [];
    const sprites = {
      sprite: (id: string) => {
        asked.push(id);
        return undefined;
      },
    } as unknown as Parameters<typeof drawTalentPanel>[0]['sprites'];
    paintPanel({ sprites });
    for (const entry of STAT_ROWS) expect(asked).toContain(entry.icon);
  });

  it('answers a hover over the whole cell, caption included', () => {
    const rect = rectAt(FLOOR);
    const rows = talentPanelRows(view());
    const g = talentPanelGeometry(rect, rows, NO_SCROLL);
    if (g.stats === null) throw new Error('no column');
    const wil = statCellRects(g.stats)[4] as PanelRect;
    expect(talentStatAt(rect, rows, wil.x + 16, wil.y + wil.h + 4, NO_SCROLL)).toBe('wil');
    const card = talentTipAt(rect, rows, wil.x + 16, wil.y + 16, NO_SCROLL, {
      str: [],
      dex: [],
      con: [],
      mag: [],
      wil: ['Mental save +0.4'],
      cun: [],
    });
    expect(card?.title).toBe('Willpower');
    expect(card?.lines).toEqual(['Mental save +0.4']);
  });

  it('names what is armed, centred in the title bar over the category counter', () => {
    /**
     * Upstream's message line is `{hcenter=self.b_types, top=-self.t_messages.h}`
     * (`LevelupDialog.lua:834`): above the columns, centred on the middle rule.
     * The warning was a strip over the grid, and before that along the bottom
     * edge the attribute column runs to, where it covered the last captions.
     */
    const rect = talentPanelRect({ width: 1280, height: 720, top: 60, bottom: 640 });
    if (rect === null) throw new Error('no panel');
    const g = talentPanelGeometry(rect, talentPanelRows(view()), NO_SCROLL);
    if (g.stats === null) throw new Error('no column');
    const [klass, generic] = g.panes;
    if (klass === undefined || generic === undefined) throw new Error('no panes');
    const mid = Math.round((klass.rect.x + klass.rect.w + generic.rect.x) / 2);

    const ops = paintOps({ armedStat: 'con' });
    const said = ops.find(
      (op) => op.kind === 'fillText' && String(op.args[0]) === 'press Constitution again to spend',
    );
    expect(said, 'the armed attribute is not named').toBeDefined();
    expect(Number(said?.args[1]), 'not centred on the middle rule').toBe(mid);
    expect(Number(said?.args[2]), 'not in the title bar').toBeLessThan(rect.y + 24);
    expect(Number(said?.args[1]), 'over the attribute column').toBeGreaterThanOrEqual(
      g.stats.x + g.stats.w,
    );

    const talent = talentPanelRows(view()).find((row) => row.kind === TalentRowKind.Category);
    const first = talent?.kind === TalentRowKind.Category ? talent.talents[0] : undefined;
    if (first === undefined) throw new Error('the fixture has no talent');
    expect(paintPanel({ armedId: first.id })).toContain(`press ${first.name} again to spend`);
    expect(paintPanel()).not.toContain('press again to spend');
  });

  it('describes a focused attribute in the description column', () => {
    // `getStatDesc`, LevelupDialog.lua:850-914: the values, then what a point
    // buys. With the name no longer printed in the column, this is where it is.
    const texts = paintPanel({
      level: 3,
      stats: { str: 25, dex: 14, con: 21, mag: 10, wil: 14, cun: 12 },
      statBase: { str: 20, dex: 14, con: 21, mag: 10, wil: 14, cun: 12 },
      focusStat: 'str',
      focusId: 'strike',
      statGains: { str: ['Physical power +1.0'], dex: [], con: [], mag: [], wil: [], cun: [] },
    });
    expect(texts).toContain('Strength');
    expect(texts).toContain('Current value: ');
    expect(texts).toContain('Base value: ');
    expect(texts).toContain('Per point');
    expect(texts).toContain('Physical power +1.0');
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

  it('is as wide as its content and not a pixel wider', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THIS TEST USED TO ASSERT THE OPPOSITE, AND IT WAS RIGHT AT THE TIME.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * It read "takes a share of the viewport rather than a fixed tier", and the
     * panel took `max(tier, min(width * 0.9, room))` — because the grid PACKED
     * ITSELF INTO THE WIDTH, so extra width really did become another column of
     * categories.
     *
     * `const columns = 2` fixed the grid at two panes and the fill rule was
     * never revisited. Extra width bought nothing but whitespace after that:
     * measured at 1280x720, a 1152-wide panel around 782 pixels of content, 319
     * of it pure centring slack, with about 22% of the box inked. Reported as
     * "the talents panel is quite massive. we want to accomodate without
     * wasting space."
     *
     * The tiers were always the content widths. Now one of them IS the width.
     */
    const wide = rectAt({ width: 1280, height: 720, top: 17, bottom: 629 });
    expect(wide.w, 'the panel is spending the viewport on whitespace again').toBeLessThanOrEqual(
      talentPanelWideW(wide.h),
    );
    expect(wide.w, 'the panel stopped reaching its widest shape').toBe(talentPanelWideW(wide.h));
    // AND IT STILL NEVER OVERRUNS. A tier is a promise about a shape, not a
    // licence to exceed the window it is drawn in.
    const tight = rectAt(REAL);
    expect(tight.w, 'the panel overran the viewport').toBeLessThanOrEqual(REAL.width);
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

  it('marks every strip with the purse it spends from', () => {
    const rows = talentPanelRows(twoTrees({ progress: progress(1, 1) }));
    const generic = categories(rows).find((row) => row.tree === 'generic/groundwork');
    const klass = categories(rows).find((row) => row.tree === 'watch/discipline');
    expect(generic?.text).toContain('— generic');
    // AND THE CLASS ONE IS MARKED TOO, as upstream names the purse on every node.
    expect(klass?.text).toBe('Discipline  (x1.00)  — class');
  });

  it('still falls back to the level sentence when every purse is empty', () => {
    const rows = talentPanelRows(twoTrees({ progress: progress(0, 0) }));
    const points = rows.find((row) => row.kind === TalentRowKind.Points);
    expect(points?.kind === TalentRowKind.Points ? points.text : '').toBe(
      'no points — next at level 3',
    );
    // AND IT IS THE TITLE BAR'S RESTING LINE, which is the only place it is
    // painted now — and only while there is truly nothing to spend.
    expect(points?.kind === TalentRowKind.Points ? points.levelNote : null).toBe(
      'no points — next at level 3',
    );
    const busy = talentPanelRows(twoTrees({ progress: progress(1, 0) })).find(
      (row) => row.kind === TalentRowKind.Points,
    );
    expect(busy?.kind === TalentRowKind.Points ? busy.levelNote : 'unset').toBeNull();
  });
});

describe('the attribute ceiling is on the control, not only in the refusal', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * LevelupDialog.lua:255-260 refuses the press; :582-600 PAINT the cell so the
   * player knows before they press.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Upstream greys a capped stat's `%d (%d)` (:593-597), and that grey caption
   * is what these tests look for. It lays nothing over the stat's icon.
   */

  const statIcons = (): PanelRect[] => {
    const rect = talentPanelRect({ width: 1280, height: 720, top: 60, bottom: 640 });
    if (rect === null) throw new Error('no panel');
    const g = talentPanelGeometry(rect, talentPanelRows(view()), NO_SCROLL);
    if (g.stats === null) throw new Error('no column');
    return [...statCellRects(g.stats)];
  };

  /** `SIX` is str 25 / dex 14 / con 21 / mag 10 / wil 14 / cun 12, all composed. */
  const greyed = (over: Partial<Parameters<typeof drawTalentPanel>[0]>): string[] => {
    const icons = statIcons();
    const texts = paintOps(over).filter((op) => op.kind === 'fillText');
    return STAT_ROWS.flatMap((entry, i) => {
      const icon = icons[i] as PanelRect;
      // CENTRED UNDER ITS ICON — that is where the painter puts a caption.
      const caption = texts.find(
        (op) => op.args[1] === icon.x + icon.w / 2 && Number(op.args[2]) >= icon.y + icon.h,
      );
      if (caption === undefined) throw new Error(`no caption under ${entry.key}`);
      return caption.fill === PALETTE.GREY_HI ? [entry.key] : [];
    });
  };

  /** The stats whose icon has anything painted over it inside its frame. */
  const shaded = (over: Partial<Parameters<typeof drawTalentPanel>[0]>): string[] => {
    const icons = statIcons();
    const fills = paintOps(over).filter((op) => op.kind === 'fillRect');
    return STAT_ROWS.flatMap((entry, i) => {
      const icon = icons[i] as PanelRect;
      const quad = fills.some(
        (op) =>
          op.args[0] === icon.x + 1 &&
          op.args[1] === icon.y + 1 &&
          op.args[2] === icon.w - 2 &&
          op.args[3] === icon.h - 2,
      );
      return quad ? [entry.key] : [];
    });
  };

  it('greys the caption of the attributes at the ceiling and leaves the rest live', () => {
    /**
     * At level 3 the ceiling is 24.2. Of the six BOUGHT values below, only `str`
     * at 25 is at or over it, so exactly one caption goes grey — and the other
     * five must not, or the whole column would look broken on the level where
     * one attribute happens to be ahead.
     */
    expect(
      greyed({ level: 3, statBase: { str: 25, dex: 14, con: 21, mag: 10, wil: 14, cun: 12 } }),
    ).toEqual(['str']);
  });

  it('draws nothing over a capped attribute icon', () => {
    /**
     * REPORTED: an Alchemist's Magic icon was darker than the other five. Their
     * Magic starts at 22 against a level-1 ceiling of 21.4, and the cell laid a
     * dark quad over the art. Upstream never shades a stat.
     */
    const capped = { level: 3, statBase: { str: 25, dex: 14, con: 21, mag: 10, wil: 14, cun: 12 } };
    expect(greyed(capped)).toEqual(['str']);
    expect(shaded(capped)).toEqual([]);
  });

  it('opens the cell again as the level catches up', () => {
    // Level 18: the ceiling is 45.2 and nothing here is near it.
    expect(
      greyed({ level: 18, statBase: { str: 25, dex: 14, con: 21, mag: 10, wil: 14, cun: 12 } }),
    ).toEqual([]);
  });

  it('asks the BOUGHT value, not the composed one', () => {
    /**
     * ═══ THE ONE THAT WOULD HURT ═══
     * `stats` here says str 25 while `statBase` says 20 — a body wearing +5 to
     * Strength. Upstream drops every increment (`no_inc`) for exactly this: a
     * good coat must never cost you a point you already own, or taking it off
     * would be a way to level up.
     */
    expect(
      greyed({
        level: 3,
        stats: { str: 25, dex: 14, con: 21, mag: 10, wil: 14, cun: 12 },
        statBase: { str: 20, dex: 14, con: 21, mag: 10, wil: 14, cun: 12 },
      }),
    ).toEqual([]);
  });

  it('leaves every cell live against a server that sends no base', () => {
    // The additive-field contract: an older server loses the affordance, never
    // the ability to spend. The server's refusal is the backstop.
    expect(greyed({ level: 1, statBase: null })).toEqual([]);
  });

  it('prints both numbers on every cell, as upstream does', () => {
    // `("%d (%d)"):format(getStat(sid), getStat(sid, nil, nil, true))` —
    // LevelupDialog.lua:596 and :598. Composed first, bought in brackets.
    const texts = paintPanel({
      level: 3,
      stats: { str: 25, dex: 14, con: 21, mag: 10, wil: 14, cun: 12 },
      statBase: { str: 20, dex: 14, con: 21, mag: 10, wil: 14, cun: 12 },
    });
    expect(texts).toContain('25 (20)');
    expect(texts).toContain('14 (14)');
  });
});

describe('a confirm too soon after its arm is a double-click', () => {
  it('holds the arm for SPEND_CONFIRM_MIN_MS and no longer', () => {
    expect(confirmTooSoon(1000, 1000 + SPEND_CONFIRM_MIN_MS - 1)).toBe(true);
    expect(confirmTooSoon(1000, 1000 + SPEND_CONFIRM_MIN_MS)).toBe(false);
    // Nothing armed is never "too soon" — there is no first press to be soon after.
    expect(confirmTooSoon(null, 0)).toBe(false);
  });
});

describe('statCellLook — the cell rules, as rules', () => {
  const base = { value: 14, base: 14, level: 10, unspent: 3, armed: false, changed: false };

  it('never draws a cell armed that a press could not buy', () => {
    // A gold ring on a control that does nothing is the lit dead button
    // ui/hotbar.ts refuses.
    expect(statCellLook({ ...base, armed: true }).ring).toBe(2);
    expect(statCellLook({ ...base, armed: true, unspent: 0 }).ring).toBe(1);
    expect(statCellLook({ ...base, armed: true, base: 40, level: 3 }).ring).toBe(1);
  });

  it('lights the frame gold exactly where the take-back corner is offered', () => {
    // Upstream's gold is "changed since the dialog opened", which is what gates
    // its `−` (:264-267). Ours gates the `−` on `unspendableStats`.
    expect(statCellLook({ ...base, changed: true, unspent: 0 }).frame).toBe(PALETTE.GOLD);
    expect(statCellLook({ ...base, unspent: 0 }).frame).toBe(PALETTE.SLATE);
    expect(statCellLook(base).frame).toBe(PALETTE.PARCHMENT);
  });

  it('greys the caption at the ceiling only', () => {
    expect(statCellLook({ ...base, base: 40, level: 3 }).captionInk).toBe(PALETTE.GREY_HI);
    expect(statCellLook(base).captionInk).toBe(PALETTE.PARCHMENT);
  });

  it('prints the composed value alone when no base arrived', () => {
    expect(statCellLook({ ...base, value: 17, base: null }).caption).toBe('17');
    expect(statCellLook({ ...base, value: 17 }).caption).toBe('17 (14)');
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

  it('says a tree has been deepened, on that tree alone, and never offers it again', () => {
    // Upstream's gold status (:500), in words: `LoadoutMsg.deepened` names the tree.
    const rows = categories(
      talentPanelRows(
        view({ deepened: ['watch/discipline'], deepenable: ['watch/the-line'], categories: 1 }),
      ),
    );
    const deepenedRow = rows.find((row) => row.tree === 'watch/discipline');
    const other = rows.find((row) => row.tree === 'watch/the-line');
    expect(deepenedRow?.text).toContain('— deepened');
    expect(deepenedRow?.text).not.toContain('deepen to');
    expect(other?.text).not.toContain('— deepened');
    expect(other?.text).toContain('deepen to');
  });

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

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE TAKE-BACK BADGE OVERHANGS INTO THE HEADING'S PRESS BAND.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `talentMinusRect` sits two pixels above and left of its icon, and the icons
   * start `CAT_HEAD_H` below the heading — so the badge's top rows are drawn
   * inside the band the deepen reader answers, which main.ts asks FIRST. Two
   * presses on the visible badge of a deepenable tree armed and then spent a
   * category point. Every assertion goes through `talentPanelDeepenAt`, the
   * entry point main.ts calls, and runs at the production bands too.
   */
  const withTakeBacks = () =>
    deepenable({
      deepenable: ['watch/discipline', 'watch/the-line'],
      loadout: [
        talent({ id: 'talent:crude_blow', name: 'Crude Blow', unlearnable: true, ...DISCIPLINE }),
        talent({ id: 'talent:ward_rush', name: 'Ward Rush', ...DISCIPLINE }),
        talent({ id: 'talent:iron_curtain', name: 'Iron Curtain', unlearnable: true, ...THE_LINE }),
        talent({ id: 'talent:lockdown', name: 'Lockdown', ...THE_LINE }),
      ],
    });
  const stripOf = (geometry: ReturnType<typeof talentPanelGeometry>, tree: string) => {
    const placed = geometry.placed.find(
      (p) => p.row.kind === TalentRowKind.Category && p.row.tree === tree,
    );
    if (placed === undefined || placed.row.kind !== TalentRowKind.Category) {
      throw new Error(`${tree} was not placed`);
    }
    return { placed, row: placed.row };
  };
  const BADGE_BANDS = [
    REAL,
    { width: 772, height: 367, top: 17, bottom: 276 },
    { width: 640, height: 320, top: 63, bottom: 229 },
  ];

  it('never reads a press on any drawn pixel of a take-back badge as a category spend', () => {
    const rows = talentPanelRows(withTakeBacks());
    for (const size of BADGE_BANDS) {
      const rect = rectAt(size);
      const geometry = talentPanelGeometry(rect, rows, NO_SCROLL);
      const { placed, row } = stripOf(geometry, 'watch/discipline');
      const icon = placed.cells[row.talents.findIndex((cell) => cell.canUnlearn)];
      if (icon === undefined) throw new Error('the take-back cell was not placed');
      const minus = talentMinusRect(icon);
      const head = categoryHeadRect(placed.rect);
      const vp = geometry.grid.viewport;
      // THE FIXTURE MUST PUT THE BADGE IN THE BAND, AND ALL OF IT IN THE CLIP.
      expect(minus.y, 'the badge does not reach the heading band').toBeLessThan(head.y + head.h);
      expect(minus.x >= vp.x && minus.y >= vp.y, 'the badge is clipped').toBe(true);

      for (let y = minus.y; y < minus.y + minus.h; y += 1) {
        for (let x = minus.x; x < minus.x + minus.w; x += 1) {
          const where = `${String(x)},${String(y)} at ${JSON.stringify(size)}`;
          expect(talentPanelDeepenAt(rect, rows, x, y, NO_SCROLL), where).toBeNull();
          // EVEN WITH THE ICON ARMED, the badge carved out of it is the take-back.
          const hit = talentPanelHitAt(rect, rows, x, y, NO_SCROLL, 'talent:crude_blow');
          expect(hit?.kind, where).toBe(TalentHitKind.Unlearn);
          if (hit?.kind === TalentHitKind.Unlearn) {
            expect(hit.talentId).toBe('talent:crude_blow');
            expect(hit.badge).toEqual(minus);
          }
        }
      }
    }
  });

  it('describes, on hover, the talent a badge takes back — on every pixel the press does', () => {
    // THE OVERHANG WAS BLIND: a press there took a rank back, and a hover over the
    // same pixels named nothing, because `cellAt` only answers inside the icon.
    const rows = talentPanelRows(withTakeBacks());
    for (const size of BADGE_BANDS) {
      const rect = rectAt(size);
      const geometry = talentPanelGeometry(rect, rows, NO_SCROLL);
      const { placed, row } = stripOf(geometry, 'watch/discipline');
      const icon = placed.cells[row.talents.findIndex((cell) => cell.canUnlearn)];
      if (icon === undefined) throw new Error('the take-back cell was not placed');
      const minus = talentMinusRect(icon);
      expect(minus.x < icon.x || minus.y < icon.y, 'the fixture has no overhang').toBe(true);
      for (let y = minus.y; y < minus.y + minus.h; y += 1) {
        for (let x = minus.x; x < minus.x + minus.w; x += 1) {
          const where = `${String(x)},${String(y)} at ${JSON.stringify(size)}`;
          expect(talentIdAt(rect, rows, x, y, NO_SCROLL), where).toBe('talent:crude_blow');
          expect(talentTipAt(rect, rows, x, y, NO_SCROLL)?.title, where).toMatch(/^Crude Blow\b/);
        }
      }
    }
  });

  it('answers a press on any heading, offered or not, and gives badge pixels up', () => {
    // THE HEADING READER is where a heading answers; the deepen reader is that
    // plus "the server offers it". A tree with no offer still has a heading.
    let badgesSeen = 0;
    const rows = talentPanelRows(
      deepenable({
        deepenable: ['watch/discipline'],
        loadout: [
          talent({ id: 'talent:crude_blow', name: 'Crude Blow', unlearnable: true, ...DISCIPLINE }),
          talent({ id: 'talent:ward_rush', name: 'Ward Rush', ...DISCIPLINE }),
          talent({
            id: 'talent:iron_curtain',
            name: 'Iron Curtain',
            unlearnable: true,
            ...THE_LINE,
          }),
          talent({ id: 'talent:lockdown', name: 'Lockdown', ...THE_LINE }),
        ],
      }),
    );
    for (const size of BADGE_BANDS) {
      const rect = rectAt(size);
      const geometry = talentPanelGeometry(rect, rows, NO_SCROLL);
      const offered = stripOf(geometry, 'watch/discipline');
      const plain = stripOf(geometry, 'watch/the-line');
      const head = categoryHeadRect(plain.placed.rect);
      const x = head.x + head.w - 3;
      const y = head.y + 1;
      expect(talentHeadingAt({ x, y }, geometry), 'an unoffered heading').toBe('watch/the-line');
      expect(talentDeepenAt({ x, y }, geometry), 'offered where it is not').toBeNull();
      const own = categoryHeadRect(offered.placed.rect);
      expect(talentDeepenAt({ x: own.x + own.w - 3, y: own.y + 1 }, geometry)).toBe(
        'watch/discipline',
      );
      // AND A DRAWN BADGE'S PIXELS ARE NEVER A HEADING, offered or not. A badge is
      // drawn only over an icon wholly on screen; over a clipped one there is no
      // badge, and those pixels are the heading's.
      const icon = plain.placed.cells[plain.row.talents.findIndex((cell) => cell.canUnlearn)];
      if (icon === undefined) throw new Error('no take-back cell on the unoffered tree');
      const minus = talentMinusRect(icon);
      const vp = geometry.grid.viewport;
      const drawn =
        icon.x >= vp.x &&
        icon.y >= vp.y &&
        icon.x + icon.w <= vp.x + vp.w &&
        icon.y + icon.h <= vp.y + vp.h;
      const onBadge = talentPanelHeadingAt(rect, rows, minus.x + 1, minus.y, NO_SCROLL);
      if (drawn) {
        badgesSeen += 1;
        expect(
          onBadge,
          `a drawn badge answered as its heading at ${JSON.stringify(size)}`,
        ).toBeNull();
      }
    }
    // THE BADGE CASE WAS REACHED, or the assertion above proved nothing.
    expect(badgesSeen).toBeGreaterThan(0);
  });

  it('confirms a category point on any of the three things that arm one', () => {
    // A deepenable heading, a locked heading, an icon inside a locked tree. And a
    // talent id, which is none of them, stays a talent point.
    const deepenableIds = ['watch/discipline'];
    const unlockableTrees = [{ id: 'generic/leverage' }];
    expect(treeSpendFor('watch/discipline', deepenableIds, unlockableTrees, null)).toBe(
      'watch/discipline',
    );
    expect(treeSpendFor('generic/leverage', deepenableIds, unlockableTrees, null)).toBe(
      'generic/leverage',
    );
    expect(
      treeSpendFor('talent:lever', deepenableIds, unlockableTrees, { unlocks: 'generic/leverage' }),
    ).toBe('generic/leverage');
    expect(
      treeSpendFor('talent:crude_blow', deepenableIds, unlockableTrees, { unlocks: null }),
    ).toBeNull();
    // A LOCKED TREE IS NOT DEEPENABLE, and an id on neither list is not a tree.
    expect(treeSpendFor('watch/the-line', deepenableIds, unlockableTrees, null)).toBeNull();
  });

  it('refuses a heading press in learnType’s order: once, then points', () => {
    // `LevelupDialog.lua:420-426`. A tree already deepened says so even with an
    // empty purse — the rule that binds is the one the player cannot fix.
    expect(headingPressRefusal({ deepened: true, category: 0 })).toEqual({
      text: 'You can only improve a category mastery once!',
      tone: TalentMessageTone.Warning,
    });
    expect(headingPressRefusal({ deepened: true, category: 2 })?.tone).toBe(
      TalentMessageTone.Warning,
    );
    expect(headingPressRefusal({ deepened: false, category: 0 })).toEqual({
      text: 'You have no category points left!',
      tone: TalentMessageTone.Error,
    });
    expect(headingPressRefusal({ deepened: false, category: 1 })).toBeNull();
  });

  it('still offers the deepen beside a badge, and above a talent without one', () => {
    const rows = talentPanelRows(withTakeBacks());
    for (const size of BADGE_BANDS) {
      const rect = rectAt(size);
      const { placed, row } = stripOf(
        talentPanelGeometry(rect, rows, NO_SCROLL),
        'watch/discipline',
      );
      const minus = talentMinusRect(
        placed.cells[row.talents.findIndex((cell) => cell.canUnlearn)] as PanelRect,
      );
      const bare = talentMinusRect(
        placed.cells[row.talents.findIndex((cell) => !cell.canUnlearn)] as PanelRect,
      );
      const deepen = (x: number, y: number) => talentPanelDeepenAt(rect, rows, x, y, NO_SCROLL);
      expect(deepen(minus.x - 1, minus.y), 'left of the badge').toBe('watch/discipline');
      expect(deepen(minus.x + minus.w, minus.y + 1), 'right of the badge').toBe('watch/discipline');
      expect(deepen(bare.x + 3, bare.y), 'over a talent with no take-back').toBe(
        'watch/discipline',
      );
      expect(deepen(minus.x + 3, minus.y - 1), 'the row above the badge').toBe('watch/discipline');
    }
  });

  const badgeAt = (ops: readonly Op[], m: PanelRect) =>
    ops.filter(
      (op) =>
        op.kind === 'fillRect' &&
        op.args[0] === m.x &&
        op.args[1] === m.y &&
        op.args[2] === m.w &&
        op.args[3] === m.h,
    ).length;

  it('answers only the part of a badge that was drawn, as the grid scrolls', () => {
    const rows = talentPanelRows(withTakeBacks());
    const rect = rectAt({ width: 640, height: 320, top: 63, bottom: 229 });
    const unscrolled = talentPanelGeometry(rect, rows, NO_SCROLL);
    const { placed, row } = stripOf(unscrolled, 'watch/discipline');
    const n = row.talents.findIndex((cell) => cell.canUnlearn);
    // THE SCROLL THAT PUTS THE ICON FLUSH WITH THE GRID TOP, derived, not restated.
    const flush = (placed.cells[n] as PanelRect).y - unscrolled.grid.viewport.y;
    expect(unscrolled.grid.maxScroll, 'the fixture cannot scroll that far').toBeGreaterThan(flush);
    for (const scroll of [flush - 1, flush]) {
      const g = talentPanelGeometry(rect, rows, scroll);
      expect(g.grid.scroll).toBe(scroll);
      const icon = stripOf(g, 'watch/discipline').placed.cells[n] as PanelRect;
      const minus = talentMinusRect(icon);
      const vp = g.grid.viewport;
      const label = `scroll ${String(scroll)}`;
      // THE PAINTER DRAWS IT: the icon is still wholly inside the clip.
      expect(badgeAt(paintOps({ rect, rows, scroll }), minus), label).toBe(1);
      // ABOVE THE CLIP: never painted, so it answers nothing at all.
      expect(talentPanelHitAt(rect, rows, minus.x + 3, vp.y - 1, scroll), label).toBeNull();
      expect(talentPanelDeepenAt(rect, rows, minus.x + 3, vp.y - 1, scroll), label).toBeNull();
      // THE FIRST ROW INSIDE IT: painted, so the take-back.
      expect(talentPanelHitAt(rect, rows, minus.x + 3, vp.y, scroll)?.kind, label).toBe(
        TalentHitKind.Unlearn,
      );
      // AND THE LEFT OVERHANG BESIDE THE ICON, which is painted too.
      expect(talentPanelHitAt(rect, rows, minus.x, icon.y + 3, scroll)?.kind, label).toBe(
        TalentHitKind.Unlearn,
      );
    }
    // ONE PAST FLUSH the icon's top row is clipped: no badge drawn, none pressed.
    const past = flush + 1;
    const g = talentPanelGeometry(rect, rows, past);
    const minus = talentMinusRect(stripOf(g, 'watch/discipline').placed.cells[n] as PanelRect);
    expect(
      badgeAt(paintOps({ rect, rows, scroll: past }), minus),
      'drawn over a clipped icon',
    ).toBe(0);
    expect(talentPanelHitAt(rect, rows, minus.x + 3, g.grid.viewport.y + 1, past)).toBeNull();
  });

  it('paints no badge over a clipped icon, and leaves the heading its pixels', () => {
    const rows = talentPanelRows(withTakeBacks());
    const rect = rectAt({ width: 640, height: 320, top: 63, bottom: 229 });
    const at0 = talentPanelGeometry(rect, rows, NO_SCROLL);
    // THE CELL INDEX IS THE ROW'S, not the geometry's: unscrolled, The Line is below
    // the fold at this band and not placed at all.
    const line = categories(rows).find((row) => row.tree === 'watch/the-line');
    if (line === undefined) throw new Error('the fixture has no The Line');
    const n = line.talents.findIndex((cell) => cell.canUnlearn);
    // A SCROLL where The Line's heading is wholly on screen and its icon PARTLY is —
    // the edge a rule allowing overlap would get wrong. Wholly below the clip,
    // every rule agrees and the case proves nothing.
    let found: number | null = null;
    for (let s = 0; s <= at0.grid.maxScroll && found === null; s += 1) {
      const g = talentPanelGeometry(rect, rows, s);
      const strip = g.placed.find(
        (p) => p.row.kind === TalentRowKind.Category && p.row.tree === 'watch/the-line',
      );
      const icon = strip?.cells[n];
      if (strip === undefined || icon === undefined) continue;
      const head = categoryHeadRect(strip.rect);
      const vp = g.grid.viewport;
      const headIn = head.y >= vp.y && head.y + head.h <= vp.y + vp.h;
      const iconIn = icon.y >= vp.y && icon.y + icon.h <= vp.y + vp.h;
      const iconPartly = icon.y >= vp.y && icon.y < vp.y + vp.h;
      if (headIn && iconPartly && !iconIn) found = s;
    }
    expect(found, 'no scroll half-clips the icon under a visible heading').not.toBeNull();
    const scroll = found ?? 0;
    const g = talentPanelGeometry(rect, rows, scroll);
    const minus = talentMinusRect(stripOf(g, 'watch/the-line').placed.cells[n] as PanelRect);

    expect(talentPanelDeepenAt(rect, rows, minus.x + 3, minus.y, scroll)).toBe('watch/the-line');
    expect(talentPanelHitAt(rect, rows, minus.x + 3, minus.y, scroll)).toBeNull();

    expect(badgeAt(paintOps({ rect, rows, scroll }), minus), 'a badge over a clipped icon').toBe(0);
    // THE CONTROL: the same painter does draw a badge over a whole icon.
    const visible = talentPanelGeometry(rect, rows, NO_SCROLL);
    const wholeAt0 = talentMinusRect(
      stripOf(visible, 'watch/discipline').placed.cells[
        stripOf(visible, 'watch/discipline').row.talents.findIndex((cell) => cell.canUnlearn)
      ] as PanelRect,
    );
    expect(badgeAt(paintOps({ rect, rows, scroll: NO_SCROLL }), wholeAt0)).toBe(1);
  });

  it('tells a take-back that is still offered from one that has gone', () => {
    // The question main.ts's guard asks before letting a press on a badge it
    // just refunded reach the deepen offer or the icon's arm.
    const rect = rectAt(REAL);
    const offered = talentPanelRows(withTakeBacks());
    const geometry = talentPanelGeometry(rect, offered, NO_SCROLL);
    const { placed, row } = stripOf(geometry, 'watch/discipline');
    const minus = talentMinusRect(
      placed.cells[row.talents.findIndex((cell) => cell.canUnlearn)] as PanelRect,
    );
    expect(takeBackStillOffered(rect, offered, minus.x + 3, minus.y, NO_SCROLL, [])).toBe(true);
    const gone = talentPanelRows(deepenable());
    expect(takeBackStillOffered(rect, gone, minus.x + 3, minus.y, NO_SCROLL, [])).toBe(false);

    // AND THE ATTRIBUTE BADGE, whose window the server names in `unspendableStats`.
    if (geometry.stats === null) throw new Error('no attribute column');
    const con = statMinusRect(statCellRects(geometry.stats)[2] as PanelRect);
    expect(takeBackStillOffered(rect, offered, con.x + 3, con.y + 3, NO_SCROLL, ['con'])).toBe(
      true,
    );
    expect(takeBackStillOffered(rect, offered, con.x + 3, con.y + 3, NO_SCROLL, [])).toBe(false);

    // AND ON A SCROLLED GRID, which is where main.ts asks it most: the same pixel
    // is a badge at one scroll and a heading at another.
    const band = rectAt({ width: 640, height: 320, top: 63, bottom: 229 });
    const flat = talentPanelGeometry(band, offered, NO_SCROLL);
    const cell = stripOf(flat, 'watch/discipline');
    const k = cell.row.talents.findIndex((t) => t.canUnlearn);
    const flush = (cell.placed.cells[k] as PanelRect).y - flat.grid.viewport.y;
    const scrolled = talentPanelGeometry(band, offered, flush);
    const sm = talentMinusRect(stripOf(scrolled, 'watch/discipline').placed.cells[k] as PanelRect);
    const py = scrolled.grid.viewport.y + 1;
    expect(takeBackStillOffered(band, offered, sm.x + 3, py, flush, [])).toBe(true);
    expect(takeBackStillOffered(band, offered, sm.x + 3, py, NO_SCROLL, [])).toBe(false);
  });

  /**
   * ═══ THE GUARD, PRESS BY PRESS ═══
   * A take-back that empties the window makes the badge vanish, and its pixels are
   * a deepen offer and an arm again. These are the sequences a review walked.
   */
  describe('the take-back guard', () => {
    const badge = { x: 100, y: 100, w: 10, h: 10 };
    const on = { x: 104, y: 104 };

    it('swallows presses on a vanished badge for as long as they keep coming', () => {
      let guard = guardTakeBack(badge, 0);
      for (const at of [400, 800, 1200, 1600, 2000, 2400]) {
        const step = pressAgainstGuard(guard, on, at, false);
        expect(step.swallow, `press at ${String(at)}ms`).toBe(true);
        guard = step.guard as NonNullable<typeof guard>;
      }
    });

    it('still swallows a press that drifted a little off the badge', () => {
      // THE REVIEW'S CASE: two pixels out and back between presses used to release it.
      const guard = guardTakeBack(badge, 0);
      const drift = { x: badge.x - 2, y: badge.y + 3 };
      expect(pressAgainstGuard(guard, drift, 400, false).swallow).toBe(true);
      const edge = { x: badge.x - TAKE_BACK_GUARD_MARGIN, y: badge.y };
      expect(pressAgainstGuard(guard, edge, 400, false).swallow).toBe(true);
    });

    it('lets a press elsewhere through, and ends', () => {
      const guard = guardTakeBack(badge, 0);
      const away = { x: badge.x + badge.w + TAKE_BACK_GUARD_MARGIN, y: badge.y };
      expect(pressAgainstGuard(guard, away, 400, false)).toEqual({ swallow: false, guard: null });
    });

    it('lapses TAKE_BACK_GUARD_MS after the last press, and not before', () => {
      const guard = guardTakeBack(badge, 0);
      expect(pressAgainstGuard(guard, on, TAKE_BACK_GUARD_MS - 1, false).swallow).toBe(true);
      expect(pressAgainstGuard(guard, on, TAKE_BACK_GUARD_MS, false)).toEqual({
        swallow: false,
        guard: null,
      });
    });

    it('lets a take-back that is still offered through, and keeps guarding', () => {
      const guard = guardTakeBack(badge, 0);
      const step = pressAgainstGuard(guard, on, 400, true);
      expect(step.swallow).toBe(false);
      expect(step.guard).toEqual(guard);
    });

    it('does nothing at all with no guard', () => {
      expect(pressAgainstGuard(null, on, 0, false)).toEqual({ swallow: false, guard: null });
    });
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
      // A NOTE ROW is the only sentence the grid places now — the Points row is
      // not placed at all — so the fixture is the loadout-less panel that has one.
      const rows = talentPanelRows(view({ loadout: [], passives: [] }));
      const geometry = talentPanelGeometry(rectAt(size), rows, NO_SCROLL);
      expect(
        geometry.placed.some((placed) => placed.row.kind === TalentRowKind.Points),
        'the points sentence is placed again',
      ).toBe(false);
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
    const geometry = talentPanelGeometry(
      rect,
      talentPanelRows(view({ loadout: [], passives: [] })),
      NO_SCROLL,
    );
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
describe('no caption repeats the counters', () => {
  it('paints each purse once, in its box, including an empty one', () => {
    const texts = paintPanel({ rows: talentPanelRows(view({ progress: progress(1, 0) })) });
    expect(texts.some((t) => /^(CLASS|GENERIC)\b/.test(t))).toBe(false);
    expect(texts).toContain('Class points: 1');
    // A PURSE WITH NOTHING IN IT STILL HAS ITS BOX. "Generic points: 0" over an
    // empty column answers "where do generic points go"; a missing box does not.
    expect(texts).toContain('Generic points: 0');
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE MESSAGE LINE — `LevelupDialog.lua:171-179` and `StatusBox.lua:57-69`.
 * ═══════════════════════════════════════════════════════════════════════════
 */
describe('the message line', () => {
  const said = (text: string, at = 1000) => ({ text, tone: TalentMessageTone.Error, at });

  it('holds a refusal for a second, fades it over half of one, then lets the arm speak', () => {
    const rows = talentPanelRows(view());
    const base = { rows, armedId: 'talent:crude_blow', armedStat: null, message: said('Nope!') };
    const at = (now: number) => talentHeaderMessage({ ...base, now });
    expect(at(1000 + TALENT_MESSAGE_HOLD_MS - 1)).toMatchObject({ text: 'Nope!', alpha: 1 });
    expect(at(1000 + TALENT_MESSAGE_HOLD_MS + TALENT_MESSAGE_FADE_MS / 2)?.alpha).toBeCloseTo(0.5);
    expect(at(1000 + TALENT_MESSAGE_HOLD_MS + TALENT_MESSAGE_FADE_MS)?.text).toBe(
      'press Crude Blow again to spend',
    );
  });

  it('holds for StatusBox’s second and fades over its half — StatusBox.lua:57-69', () => {
    // PINNED AS NUMBERS: every other test in this block is written in these
    // constants, and would pass whatever they held.
    expect([TALENT_MESSAGE_HOLD_MS, TALENT_MESSAGE_FADE_MS]).toEqual([1000, 500]);
    expect(TALENT_FADE_STEP_MS).toBeLessThanOrEqual(TALENT_MESSAGE_FADE_MS / 5);
  });

  it('asks for a frame exactly when the line changes, and stops when it is gone', () => {
    const message = said('Nope!', 1000);
    // NOTHING WHILE IT HOLDS: one wake, at the end of the hold.
    expect(talentMessageWake(message, 1000)).toBe(TALENT_MESSAGE_HOLD_MS);
    expect(talentMessageWake(message, 1000 + TALENT_MESSAGE_HOLD_MS - 1)).toBe(1);
    // STEPS THROUGH THE FADE, and the last step lands on its end, not past it.
    expect(talentMessageWake(message, 1000 + TALENT_MESSAGE_HOLD_MS)).toBe(TALENT_FADE_STEP_MS);
    const end = 1000 + TALENT_MESSAGE_HOLD_MS + TALENT_MESSAGE_FADE_MS;
    expect(talentMessageWake(message, end - 1)).toBe(1);
    expect(talentMessageWake(message, end)).toBeNull();
    // THE JOIN: the scheduler lets go on exactly the frame the painter's alpha
    // reaches nothing — never early (a message cut off mid-fade) and never late
    // (frames spent redrawing a line with nothing on it).
    for (let now = 900; now <= end + 100; now += 7) {
      expect(talentMessageWake(message, now) === null, `at ${String(now)}`).toBe(
        talentMessageAlpha(message, now) === 0,
      );
    }
  });

  it('tells the detail pane the same "never" the title bar is told', () => {
    // A 60 AT LEVEL 30 is stopped by the lifetime bound, not the pace: the press
    // says "further", and the pane pinned to that stat must not promise a level.
    const text = (base: number, level: number) =>
      paintPanel({
        focusStat: 'str',
        stats: { ...SIX, str: base },
        statBase: { ...SIX, str: base },
        level,
      }).join(' ');
    expect(statPressRefusal({ unspent: 1, base: 60, level: 30 })?.text).toBe(
      'You cannot increase this stat further!',
    );
    expect(text(60, 30)).toContain('At its maximum.');
    expect(text(60, 30)).not.toContain('rise again next level');
    // AND WHERE THE PACE STOPS IT, both say wait.
    expect(text(28, 2)).toContain('rise again next level');
    // ONE RULE UNDER BOTH: "never" exactly when the press says "further".
    for (const [base, level] of [
      [60, 30],
      [28, 2],
      [60, 28],
      [60, MAX_CHARACTER_LEVEL],
      [100, 50],
      [59, 28],
    ] as const) {
      expect(statNeverRises(base, level), `${String(base)} at level ${String(level)}`).toBe(
        statPressRefusal({ unspent: 1, base, level })?.text ===
          'You cannot increase this stat further!',
      );
    }
  });

  it('paints an error orange and upstream’s two yellows gold', () => {
    const rows = talentPanelRows(view());
    const ink = (tone: TalentMessageTone) =>
      talentHeaderMessage({
        rows,
        armedId: null,
        armedStat: null,
        message: { text: 'Said.', tone, at: 0 },
        now: 0,
      })?.ink;
    expect(ink(TalentMessageTone.Error)).toBe(PALETTE.ORANGE);
    expect(ink(TalentMessageTone.Warning)).toBe(PALETTE.GOLD);
    expect(ink(TalentMessageTone.Other)).toBe(PALETTE.GOLD);
  });

  it('says the level note only when nothing is armed and nothing was refused', () => {
    const rows = talentPanelRows(view({ progress: progress(0, 0) }));
    const quiet = { rows, armedId: null, armedStat: null, message: null, now: 0 };
    expect(talentHeaderMessage(quiet)?.text).toBe('no points — next at level 3');
    expect(talentHeaderMessage({ ...quiet, armedStat: 'wil' })?.text).toBe(
      'press Willpower again to spend',
    );
    const busy = talentPanelRows(view({ progress: progress(1, 0) }));
    expect(talentHeaderMessage({ ...quiet, rows: busy })).toBeNull();
  });

  it('is painted centred in the title bar while it holds, and not after it fades', () => {
    const rect = talentPanelRect({ width: 1280, height: 720, top: 60, bottom: 640 });
    if (rect === null) throw new Error('no panel');
    const message = said('Prerequisites not met!');
    const holding = paintOps({ message, now: 1500 }).find(
      (op) => op.kind === 'fillText' && String(op.args[0]) === 'Prerequisites not met!',
    );
    expect(holding, 'the refusal was not said').toBeDefined();
    expect(Number(holding?.args[2])).toBeLessThan(rect.y + 24);
    expect(
      paintPanel({ message, now: 1000 + TALENT_MESSAGE_HOLD_MS + TALENT_MESSAGE_FADE_MS }),
    ).not.toContain('Prerequisites not met!');
  });

  it('refuses a talent press in upstream’s order, and exactly when it cannot arm', () => {
    /**
     * `learnTalent(+)` — `LevelupDialog.lua:365-379`: the purse, then the
     * prerequisites, then the rank cap. And null EXACTLY when `canSpend` is true,
     * so the words and the arm never disagree about whether a press buys.
     */
    const fixture = (p: ReturnType<typeof progress>, categories: number) =>
      view({
        progress: p,
        categories,
        loadout: [
          talent({ id: 'maxed', name: 'Maxed', level: TALENT_MAX_LEVEL, ...DISCIPLINE }),
          // CAPPED BELOW THE GAME'S MAXIMUM: "already fully known" is its OWN cap,
          // and a rule comparing against TALENT_MAX_LEVEL would say nothing here.
          talent({ id: 'single', name: 'Single', level: 1, maxLevel: 1, ...DISCIPLINE }),
          talent({
            id: 'gated',
            name: 'Gated',
            level: 0,
            locked: true,
            lockedReason: 'level 4',
            ...DISCIPLINE,
          }),
          talent({ id: 'open', name: 'Open', level: 1, ...DISCIPLINE }),
          talent({
            id: 'gen',
            name: 'Gen',
            level: 1,
            tree: 'generic/groundwork',
            treeName: 'Groundwork',
          }),
        ],
        passives: [],
        unlockable: [
          {
            id: 'generic/leverage',
            name: 'Leverage',
            blurb: 'Weight.',
            talents: [talent({ id: 'lever', name: 'Lever', level: 0 })],
          },
        ],
      });
    const cellsOf = (v: TalentPanelView) =>
      categories(talentPanelRows(v)).flatMap((row) => row.talents);
    const purses = (p: ReturnType<typeof progress>, category: number) => ({
      class: p.unspent,
      generic: p.unspentGenerics,
      category,
    });

    // EVERY COMBINATION of empty and not, at two depths. A refusal that read the
    // wrong purse passes any list where the purses happen to move together.
    const depths = [0, 1, 2];
    const combinations = depths.flatMap((cls) =>
      depths.flatMap((gen) => [0, 1].map((cat) => [cls, gen, cat] as const)),
    );
    expect(combinations).toHaveLength(18);
    for (const [c, g, k] of combinations) {
      const p = progress(c, g);
      for (const cell of cellsOf(fixture(p, k))) {
        expect(
          talentPressRefusal(cell, purses(p, k)) === null,
          `${cell.id} at ${String(c)}/${String(g)}/${String(k)}`,
        ).toBe(cell.canSpend);
      }
    }

    const p = progress(1, 0);
    const text = (id: string) =>
      talentPressRefusal(
        cellsOf(fixture(p, 0)).find((cell) => cell.id === id) as never,
        purses(p, 0),
      )?.text;
    expect(text('gated')).toBe('Prerequisites not met!');
    expect(text('maxed')).toBe('You already fully know this talent!');
    expect(text('gen')).toBe('You have no generic talent points left!');
    expect(text('lever')).toBe('You have no category points left!');
    expect(text('open')).toBeUndefined();
    // THE PURSE IS ASKED FIRST, even of a talent that is also gated.
    const empty = progress(0, 0);
    expect(
      talentPressRefusal(
        cellsOf(fixture(empty, 0)).find((cell) => cell.id === 'gated') as never,
        purses(empty, 0),
      )?.text,
    ).toBe('You have no class talent points left!');
  });

  it('refuses an attribute press with upstream’s three sentences', () => {
    // `incStat` — `LevelupDialog.lua:251-262`.
    expect(statPressRefusal({ unspent: 0, base: 10, level: 1 })?.text).toBe(
      'You have no stat points left!',
    );
    // Level 3's ceiling is 24.2; level 4's is 25.6 — the next level opens 25.
    expect(statPressRefusal({ unspent: 1, base: 25, level: 3 })?.text).toBe(
      'You cannot increase this stat further until next level!',
    );
    // The flat ceiling of 60 does not move with a level, so it is the other sentence.
    expect(statPressRefusal({ unspent: 1, base: 60, level: 40 })?.text).toBe(
      'You cannot increase this stat further!',
    );
    // A STARTING STAT ABOVE THE PACE — a class's 24 with an origin's 4 — waits for
    // levels, not forever: 28 opens at level 6, whose ceiling is 28.4. Asking only
    // whether the NEXT level opens it told this player "further" at levels 2 to 4.
    expect(statPressRefusal({ unspent: 3, base: 28, level: 2 })?.text).toBe(
      'You cannot increase this stat further until next level!',
    );
    // WHERE BOTH BIND, THE LIFETIME BOUND SPEAKS. Level 28's pace is 59.2 and its
    // lifetime bound 60, and no level opens a 60; upstream asks the pace first and
    // says "until next level" here — the one sentence this does not copy.
    expect(statPressRefusal({ unspent: 1, base: 60, level: 28 })?.text).toBe(
      'You cannot increase this stat further!',
    );
    // AND AT THE LEVEL CAP there is no next level to wait for.
    expect(statPressRefusal({ unspent: 1, base: 60, level: MAX_CHARACTER_LEVEL })?.text).toBe(
      'You cannot increase this stat further!',
    );
    expect(statPressRefusal({ unspent: 1, base: 14, level: 3 })).toBeNull();
    expect(statPressRefusal({ unspent: 1, base: null, level: 3 })).toBeNull();
  });

  it('gives the grid its twenty-nine pixels back at the floor, the middle tiers and the wide one', () => {
    // `panelBand`: top = 14 + 3 (+46 in combat), bottom = height − 91. The grid
    // starts where the attribute column does, at the counters plus their air.
    for (const size of [
      { width: 640, height: 320, top: 17, bottom: 229 },
      { width: 640, height: 320, top: 63, bottom: 229 },
      { width: 772, height: 367, top: 17, bottom: 276 },
      { width: 772, height: 367, top: 63, bottom: 276 },
      { width: 640, height: 480, top: 17, bottom: 389 },
      { width: 640, height: 480, top: 63, bottom: 389 },
      // THE WIDE TIER, with the description column: the usual desktop window.
      { width: 1280, height: 720, top: 17, bottom: 629 },
      { width: 1280, height: 720, top: 63, bottom: 629 },
    ]) {
      const rect = rectAt(size);
      const g = talentPanelGeometry(rect, talentPanelRows(view()), NO_SCROLL);
      expect(g.grid.viewport.y - rect.y, JSON.stringify(size)).toBe(57);
      if (g.stats !== null) expect(g.grid.viewport.y).toBe(g.stats.y);
    }
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

describe('the four point counters, laid out as ToME lays them out', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * Asked for as "stat points are clearly laid out, same for category and
   * generic points / category ... the formatting for ToME UI is great".
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Upstream's four are `Button.new` widgets — LevelupDialog.lua:757 ("Stats: "),
   * :766 ("Class points: "), :775 ("Generic points: "), :784 ("Category
   * points: ") — and the placement is the part worth porting: each one sits over
   * the thing it counts (`b_stat` :815, `b_class` :819, `b_generic` :826-828,
   * `b_types` centred on the middle rule :832), never as an evenly spaced bar.
   */
  it('reserves the strip instead of painting over the content', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE COLLISION THIS TEST EXISTS FOR, MEASURED AT THE FLOOR.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * Before the strip was taken out of `top`, the stats column began at the
     * same y the counters would have been drawn at, and the pane captions
     * twenty-six pixels below — so the Stats box would have landed on the first
     * attribute row and the class and generic boxes squarely on the captions.
     *
     * Reserving the height is what makes the row a LAYOUT rather than an
     * overlay, and this asserts the reserve rather than the drawing: the
     * content must start BELOW the strip at every viewport.
     */
    for (const size of [FLOOR, REAL, { width: 1280, height: 720, top: 17, bottom: 629 }]) {
      const geo = geoAt(size);
      const strip = geo.counters;
      expect(strip.h, `${String(size.width)}: the strip has no height`).toBeGreaterThan(0);
      if (geo.stats !== null) {
        expect(
          geo.stats.y,
          `${String(size.width)}: the Stats box lands on the first attribute row`,
        ).toBeGreaterThanOrEqual(strip.y + strip.h);
      }
      for (const pane of geo.panes) {
        expect(
          pane.rect.y,
          `${String(size.width)}: a counter lands on a pane caption`,
        ).toBeGreaterThanOrEqual(strip.y + strip.h);
      }
    }
  });

  it('leaves upstream’s ten pixels of air below, and no rule', () => {
    /**
     * `align_empty1 = Empty.new{width=0, height=10}` (LevelupDialog.lua:810) is
     * the only thing between the counters and the columns. `hsep` is declared
     * at :809 and NEVER USED, so a horizontal rule under the row would be ours
     * rather than a port — worth stating, because it is the obvious thing to
     * add and it is not what the screenshot shows.
     */
    const geo = geoAt({ width: 1280, height: 720, top: 17, bottom: 629 });
    const firstContent = Math.min(
      geo.stats?.y ?? Number.POSITIVE_INFINITY,
      ...geo.panes.map((pane) => pane.rect.y),
    );
    expect(firstContent - (geo.counters.y + geo.counters.h)).toBe(10);
  });

  it('draws a box per counter and a rule per boundary', () => {
    const source = readFileSync('src/client/ui/talents.ts', 'utf8');
    for (const label of ['Stats: ', 'Class points: ', 'Generic points: ', 'Category points: ']) {
      expect(source, `the ${label.trim()} counter is gone`).toContain(label);
    }
    // ONE PER COLUMN, not an evenly spaced bar — the placement IS the port.
    expect(source, 'the generic counter stopped hugging its column').toContain('right - w');
    expect(source, 'the category counter is not on the middle rule').toContain('mid - w / 2');
  });

  it('takes the two spendable purses off the same row the captions use', () => {
    // The box and the caption under it are two renderings of one number. Read
    // from two places they will eventually disagree, and the screen where a
    // player decides how to spend a point is the worst place for that.
    const source = readFileSync('src/client/ui/talents.ts', 'utf8');
    expect(source).toContain('options.rows.find((row) => row.kind === TalentRowKind.Points)');
  });
});
