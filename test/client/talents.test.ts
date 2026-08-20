/// <reference lib="dom" />

import { describe, expect, it } from 'vitest';

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
  talentIdAt,
  talentPanelRows,
  talentTipAt,
} from '../../src/client/ui/talents.ts';
import { HEADER_H } from '../../src/client/ui/panel.ts';
import { TALENT_MAX_LEVEL } from '../../src/shared/progression.ts';
import type { TalentPanelView, TalentRow } from '../../src/client/ui/talents.ts';
import type { LoadoutTalent, ProgressMsg } from '../../src/shared/protocol.ts';

/**
 * A WRAPPER WITH ARITHMETIC A TEST CAN PREDICT — six pixels a character, which
 * is what `10px ui-monospace` measures to in the browser this ships in.
 *
 * Injected rather than measured, which is the reason `talentPanelGeometry` takes
 * the wrapper as a parameter at all: these assertions are about where things
 * land, and they must not depend on how a headless environment renders a font it
 * does not have installed.
 */
const CHAR_PX = 6;
function wrapAt(text: string, maxPx: number): readonly string[] {
  const per = Math.max(1, Math.floor(maxPx / CHAR_PX));
  if (text === '') return [''];
  const out: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    const candidate = line === '' ? word : `${line} ${word}`;
    if (candidate.length <= per) {
      line = candidate;
      continue;
    }
    if (line !== '') out.push(line);
    let rest = word;
    while (rest.length > per) {
      out.push(rest.slice(0, per));
      rest = rest.slice(per);
    }
    line = rest;
  }
  if (line !== '' || out.length === 0) out.push(line);
  return out;
}

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

function placedAt(size: typeof FLOOR, rows?: readonly TalentRow[]) {
  const rect = rectAt(size);
  return talentPanelGeometry(rect, rows ?? talentPanelRows(view()), wrapAt).placed;
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
    for (const p of talentPanelGeometry(rect, rows, wrapAt).placed) {
      if (p.row.kind !== TalentRowKind.Category) continue;
      for (let n = 0; n < p.cells.length; n += 1) {
        const box = p.cells[n];
        if (box === undefined) continue;
        const hit = talentPanelHitAt(rect, rows, box.x + 2, box.y + 2);
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
    const first = talentPanelGeometry(rect, rows, wrapAt).placed.find(
      (p) => p.row.kind === TalentRowKind.Category,
    );
    const box = first?.cells[0];
    const armedId =
      first?.row.kind === TalentRowKind.Category ? first.row.talents[0]?.id : undefined;
    expect(box).toBeDefined();
    expect(armedId).toBeDefined();
    if (box === undefined || armedId === undefined) return;

    expect(talentPanelHitAt(rect, rows, box.x + 2, box.y + 2, armedId)?.kind).toBe(
      TalentHitKind.Spend,
    );
  });

  it('refuses to spend with no point in hand', () => {
    const rows = talentPanelRows(view({ progress: progress(0) }));
    const rect = rectAt(REAL);
    const first = talentPanelGeometry(rect, rows, wrapAt).placed.find(
      (p) => p.row.kind === TalentRowKind.Category,
    );
    const box = first?.cells[0];
    const armedId =
      first?.row.kind === TalentRowKind.Category ? first.row.talents[0]?.id : undefined;
    if (box === undefined || armedId === undefined) return;
    // `canSpend` is false, so even the armed icon is only ever an arm.
    expect(talentPanelHitAt(rect, rows, box.x + 2, box.y + 2, armedId)?.kind).toBe(
      TalentHitKind.Row,
    );
  });

  it('hits nothing in the gap between two icons', () => {
    const rows = talentPanelRows(view());
    const rect = rectAt(REAL);
    const first = talentPanelGeometry(rect, rows, wrapAt).placed.find(
      (p) => p.row.kind === TalentRowKind.Category,
    );
    const a = first?.cells[0];
    if (a === undefined) return;
    expect(talentPanelHitAt(rect, rows, a.x + a.w + 1, a.y + 2)).toBeNull();
  });

  it('still closes on the close control', () => {
    const rows = talentPanelRows(view());
    const rect = rectAt(REAL);
    const close = talentPanelGeometry(rect, rows, wrapAt).close;
    expect(talentPanelHitAt(rect, rows, close.x + 1, close.y + 1)?.kind).toBe(TalentHitKind.Close);
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
    const cat = talentPanelGeometry(rect, rows, wrapAt).placed.find(
      (p) => p.row.kind === TalentRowKind.Category,
    );
    return cat?.cells[0];
  };

  it('returns a card naming the talent and its rank', () => {
    const box = firstBox();
    if (box === undefined) return;
    const card = talentTipAt(rect, rows, box.x + 2, box.y + 2);
    expect(card?.title).toContain('Crude Blow');
    expect(card?.title).toContain(`1/${String(TALENT_MAX_LEVEL)}`);
  });

  it('carries the whole description and the next rank, unabridged', () => {
    // The panel shows fifteen icons and no prose; if the card truncates, the
    // description is nowhere at all.
    const box = firstBox();
    if (box === undefined) return;
    const card = talentTipAt(rect, rows, box.x + 2, box.y + 2);
    expect(card?.lines.join(' ')).toContain('110% weapon damage');
    expect((card?.nextLines ?? []).join(' ')).toContain('130% weapon damage');
    for (const line of [...(card?.lines ?? []), ...(card?.nextLines ?? [])]) {
      expect(line).not.toContain('…');
    }
  });

  it('says a passive is always on rather than printing a cost at it', () => {
    const cat = talentPanelGeometry(rect, rows, wrapAt).placed.find(
      (p) => p.row.kind === TalentRowKind.Category && p.row.tree === 'watch/the-line',
    );
    const idx =
      cat?.row.kind === TalentRowKind.Category ? cat.row.talents.findIndex((t) => t.passive) : -1;
    const box = idx >= 0 ? cat?.cells[idx] : undefined;
    if (box === undefined) return;
    const card = talentTipAt(rect, rows, box.x + 2, box.y + 2);
    expect(card?.meta).toBe('always on');
  });

  it('is null when the pointer is not on an icon', () => {
    expect(talentTipAt(rect, rows, rect.x + 1, rect.y + 1)).toBeNull();
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
    return talentPanelGeometry(rect, rows, wrapAt).placed.filter(
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

  it('says so in WORDS when it genuinely cannot hold them all', () => {
    // The concession is not being removed, only proved to be honest — this file
    // header's rule is that a dropped tail says so. Nine categories is past what
    // any class carries and is here to exercise the ladder itself.
    const size = { width: 640, height: 320, top: 40, bottom: 280 };
    const rect = talentPanelRect(size);
    if (rect === null) throw new Error('no panel');
    const rows = talentPanelRows(nCategories(9));
    const placed = talentPanelGeometry(rect, rows, wrapAt).placed;
    const notes = placed.flatMap((entry) =>
      entry.row.kind === TalentRowKind.Note ? [entry.row.text] : [],
    );
    expect(notes.some((note) => /categories hidden/.test(note))).toBe(true);
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

    expect(talentPanelGeometry(wide, talentPanelRows(view())).detail).not.toBeNull();
    // ═══ THE FLOOR STILL WORKS ═══
    // `DEFAULT_VIEWPORT` is 20 tiles — 640 logical pixels — and a description
    // squeezed into what is left there would be the cut-off-mid-sentence bug the
    // panel was widened to fix. Below the threshold there is no column and the
    // hover card is still the answer.
    expect(talentPanelGeometry(narrow, talentPanelRows(view())).detail).toBeNull();
  });

  it('takes width from the panel and never a row from the grid', () => {
    // ═══ THE ASSERTION THAT KEEPS THE OLD ARGUMENT HONEST ═══
    // The strip that was removed cost HEIGHT. If this ever starts costing rows,
    // it has become the thing that was deleted.
    const wide = talentPanelRect(WIDE);
    const narrow = talentPanelRect(NARROW);
    if (wide === null || narrow === null) throw new Error('no panel');

    const rows = talentPanelRows(view());
    const withPane = talentPanelGeometry(wide, rows);
    const without = talentPanelGeometry(narrow, rows);

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
    const full = talentPanelGeometry(wide, talentPanelRows(view())).detail;
    const empty = talentPanelGeometry(wide, []).detail;
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
    const geometry = talentPanelGeometry(wide, rows);

    const found: string[] = [];
    for (const placed of geometry.placed) {
      if (placed.row.kind !== TalentRowKind.Category) continue;
      for (let i = 0; i < placed.cells.length; i += 1) {
        const box = placed.cells[i];
        const cell = placed.row.talents[i];
        if (box === undefined || cell === undefined) continue;
        const id = talentIdAt(wide, rows, box.x + 2, box.y + 2);
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
    expect(talentIdAt(wide, rows, wide.x + 2, wide.y + wide.h - 2)).toBeNull();
  });
});
