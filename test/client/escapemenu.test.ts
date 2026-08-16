/// <reference lib="dom" />

import { describe, expect, it } from 'vitest';

import {
  applyCapture,
  CaptureKind,
  drawEscapeMenu,
  ESCAPE_MENU_MARGIN,
  ESCAPE_MENU_MIN_H,
  ESCAPE_MENU_MIN_W,
  escapeMenuHitAt,
  escapeMenuPaging,
  escapeMenuRect,
  escapeMenuRows,
  MenuHitKind,
  MenuRowKind,
  MenuScreen,
  MenuTone,
} from '../../src/client/ui/escapemenu.ts';
import {
  ACTIONS,
  compileKeymap,
  DEFAULT_KEYMAP,
  labelFor,
  resetAll,
  resetOne,
} from '../../src/client/input/keymap.ts';
import { UiCommand } from '../../src/client/input/keys.ts';
import { PartyAction } from '../../src/shared/protocol.ts';
import type { EscapeMenuView, MenuHit, MenuRow } from '../../src/client/ui/escapemenu.ts';
import type { KeyRemap } from '../../src/client/input/keymap.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE ESCAPE MENU, READ THE WAY A CLICK AND A KEYPRESS READ IT. NO PIXELS.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * vitest.config.ts is explicit that there is deliberately no jsdom and no canvas
 * here, and nothing below paints to anything real. What is tested is the layer
 * where a bug on this screen is INVISIBLE or UNRECOVERABLE:
 *
 *   THE BANDS      the panel rect NEVER touches the hotbar or the resource
 *                  strip, at any viewport size. That is the panel-not-modal
 *                  property made mechanical, and it is the test that catches a
 *                  later "just make it a bit taller" (talents.test.ts:239-275).
 *   THE SIX ROWS   six entries, always six, and LEAVE PARTY is greyed rather
 *                  than dropped for a party of one — because a menu whose SHAPE
 *                  changes with state moves the row you were reaching for
 *                  (ui/contextmenu.ts:94-102).
 *   THE HIT TEST   the painter and the pointer read ONE geometry function. Two
 *                  copies is a REBIND button that lands a row above where it is
 *                  drawn, and the bug only shows up on somebody else's window
 *                  (ui/partypanel.ts:93-99). Everything below SCANS a strip of
 *                  points rather than asserting a coordinate, for the reason
 *                  test/client/partypanel.test.ts:56-61 gives: an assertion that
 *                  a control starts at x=300 would pass while it was drawn at
 *                  x=298, because it would be testing the test's own arithmetic.
 *   THE CAPTURE    a pure state machine, exactly one press wide, in the shape
 *                  test/client/talents.test.ts:200-235 pins `pressSpend` with.
 *                  Escape must disarm, a bare modifier must NOT, a conflict must
 *                  refuse and NAME the holder, and a locked action must refuse.
 *                  Every one of those is a way to brick a keyboard.
 *   THE PAGING     the arithmetic that decides what a player can see at all. A
 *                  page that silently dropped the tail would hide a keybinding
 *                  behind nothing.
 *
 * THE `reference lib="dom"` ON LINE 1 IS REQUIRED and its cost is documented at
 * test/client/turncards.test.ts:51-60.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function view(over: Partial<EscapeMenuView> = {}): EscapeMenuView {
  return {
    screen: MenuScreen.Root,
    keymap: DEFAULT_KEYMAP,
    persisted: true,
    inParty: true,
    page: 0,
    armed: null,
    message: null,
    ...over,
  };
}

/** A band that comfortably holds the whole root menu. */
const ROOMY = { width: 640, height: 400, top: 20, bottom: 360 };

function roomyRect() {
  const rect = escapeMenuRect(ROOMY);
  if (rect === null) throw new Error('unreachable: the roomy band must hold a panel');
  return rect;
}

function keysRows(over: Partial<EscapeMenuView> = {}): readonly MenuRow[] {
  return escapeMenuRows(view({ screen: MenuScreen.Keys, ...over }));
}

function actionRows(rows: readonly MenuRow[]) {
  return rows.flatMap((row) => (row.kind === MenuRowKind.Action ? [row] : []));
}

function entryRows(rows: readonly MenuRow[]) {
  return rows.flatMap((row) => (row.kind === MenuRowKind.Entry ? [row] : []));
}

/** Every hit along one horizontal line. The scan the header describes. */
function across(
  rect: { x: number; y: number; w: number; h: number },
  rows: readonly MenuRow[],
  y: number,
): { readonly x: number; readonly hit: MenuHit }[] {
  const out: { x: number; hit: MenuHit }[] = [];
  for (let x = rect.x; x < rect.x + rect.w; x += 1) {
    const hit = escapeMenuHitAt(rect, rows, x, y);
    if (hit !== null) out.push({ x, hit });
  }
  return out;
}

// ---------------------------------------------------------------------------
// THE BAND — the panel-not-modal property, made mechanical
// ---------------------------------------------------------------------------

describe('escapeMenuRect', () => {
  /**
   * The bottom bands, as main.ts stacks them: the hotbar, then the resource
   * pips, then two prose lines. `panelBand` derives `bottom` from those modules'
   * own exported heights and this panel is handed the result — so the property
   * under test is that the panel NEVER crosses whatever bottom it was given.
   */
  const SIZES = [
    { width: 640, height: 400, top: 20, bottom: 300 },
    { width: 800, height: 600, top: 96, bottom: 470 },
    { width: 480, height: 360, top: 24, bottom: 250 },
    { width: 1280, height: 720, top: 100, bottom: 560 },
    { width: 360, height: 300, top: 12, bottom: 200 },
  ] as const;

  it('never crosses the top or the bottom of its band, at any viewport size', () => {
    // ═══ THIS IS THE TEST THAT CATCHES "just make it a bit taller" ═══
    // The whole design is that a player reading this menu holds nobody up, and
    // the mechanical half of that is that every control below stays visible and
    // pressable underneath it. A panel that reached the hotbar would be a modal
    // wearing a panel's clothes — and this is the surface where that mistake is
    // most tempting, because upstream's own is a modal.
    for (const size of SIZES) {
      const rect = escapeMenuRect(size);
      if (rect === null) continue;
      expect(rect.y, `${size.width}x${size.height}`).toBeGreaterThanOrEqual(size.top);
      expect(rect.y + rect.h, `${size.width}x${size.height}`).toBeLessThanOrEqual(size.bottom);
      expect(rect.x).toBeGreaterThanOrEqual(0);
      expect(rect.x + rect.w).toBeLessThanOrEqual(size.width);
    }
  });

  it('clamps the band against the VIEWPORT, not just against what it was told', () => {
    // A caller holding a stale viewport size must not be able to push the panel
    // off the bottom, where its close button would be unreachable — and this is
    // the one panel whose close button is a player's way out of a keyboard they
    // have just made a mess of.
    const rect = escapeMenuRect({ width: 640, height: 240, top: 20, bottom: 900 });
    if (rect === null) throw new Error('unreachable');
    expect(rect.y + rect.h).toBeLessThanOrEqual(240);
  });

  it('gives up rather than drawing a panel taller or wider than the band', () => {
    expect(
      escapeMenuRect({ width: 640, height: 400, top: 20, bottom: 20 + ESCAPE_MENU_MIN_H }),
    ).toBeNull();
    expect(
      escapeMenuRect({ width: ESCAPE_MENU_MIN_W, height: 400, top: 20, bottom: 360 }),
    ).toBeNull();
  });

  it('opens at exactly the minimum band, so the constant is a real edge', () => {
    const tight = ESCAPE_MENU_MIN_H + ESCAPE_MENU_MARGIN * 2;
    expect(escapeMenuRect({ width: 640, height: 400, top: 0, bottom: tight })).not.toBeNull();
    expect(escapeMenuRect({ width: 640, height: 400, top: 0, bottom: tight - 1 })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// THE ROOT SCREEN — six rows, all six real
// ---------------------------------------------------------------------------

describe('the root screen', () => {
  it('has exactly six entries, in the ported order, and every one names an effect', () => {
    // ToME's own list drops a row it cannot resolve (GameMenu.lua:125-133), which
    // is how a dead "highscores" entry ships upstream. Carrying the effect ON the
    // row makes that unrepresentable — so this asserts the shape as well as the
    // order.
    const rows = entryRows(escapeMenuRows(view()));
    expect(rows).toHaveLength(6);
    expect(rows.map((row) => row.label)).toEqual([
      'RESUME',
      'KEY BINDINGS',
      'CHARACTER SHEET',
      'TALENTS',
      'INVENTORY',
      'LEAVE PARTY',
    ]);
    expect(rows.map((row) => row.effect)).toEqual([
      { kind: 'resume' },
      { kind: 'keys' },
      // A LAUNCHER, NOT A SECOND SHEET. Game.lua:2308 is
      // `key:triggerVirtual("SHOW_CHARACTER_SHEET")`, and this is the same act:
      // the row emits the verb the KEY emits, so main.ts's existing toggle runs.
      { kind: 'ui', command: UiCommand.ShowSheet },
      { kind: 'ui', command: UiCommand.ShowTalents },
      { kind: 'ui', command: UiCommand.ShowInventory },
      { kind: 'party', action: PartyAction.Leave },
    ]);
    expect(rows.map((row) => row.index)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('draws LEAVE PARTY greyed for a party of one rather than dropping it', () => {
    // ui/contextmenu.ts:94-102: a menu whose shape changes with state moves the
    // row you were reaching for, and a player who cannot see the row at all
    // learns nothing about why they cannot use it.
    const alone = entryRows(escapeMenuRows(view({ inParty: false })));
    expect(alone).toHaveLength(6);
    const leave = alone[5];
    expect(leave?.label).toBe('LEAVE PARTY');
    expect(leave?.enabled).toBe(false);
    // ...and it says WHY, in words, not merely in a shade.
    expect(leave?.reason).toContain('party of one');
  });

  it('names the LIVE key beside each screen row and never a hard-coded letter', () => {
    // A printed "press C" is a lie the moment somebody rebinds. The row reads
    // the same keymap the dispatcher reads.
    const before = entryRows(escapeMenuRows(view()))[2];
    expect(before?.keyLabel).toBe(labelFor('show_sheet', DEFAULT_KEYMAP));

    const rebound = compileKeymap(ACTIONS, { show_sheet: ['key:z'] });
    const after = entryRows(escapeMenuRows(view({ keymap: rebound })))[2];
    expect(after?.keyLabel).toBe('Z');
  });
});

// ---------------------------------------------------------------------------
// THE HIT TEST — one copy of the arithmetic, scanned rather than asserted
// ---------------------------------------------------------------------------

describe('escapeMenuHitAt on the root screen', () => {
  it('hands back ascending entry indices as the pointer walks down the panel', () => {
    // A SCAN down the left edge, describing what was found rather than asserting
    // where each row starts. Each index appears in exactly one contiguous run: a
    // repeat would mean two rows interleaved, a gap would mean one is
    // unreachable.
    const rect = roomyRect();
    const rows = escapeMenuRows(view());
    const seen: number[] = [];
    for (let y = rect.y; y < rect.y + rect.h; y += 1) {
      const hit = escapeMenuHitAt(rect, rows, rect.x + 12, y);
      if (hit === null || hit.kind !== MenuHitKind.Entry) continue;
      if (seen[seen.length - 1] !== hit.index) seen.push(hit.index);
    }
    expect(seen).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('answers the × in the header and nothing else up there', () => {
    const rect = roomyRect();
    const rows = escapeMenuRows(view());
    const hits = across(rect, rows, rect.y + 6)
      .filter((entry) => entry.hit.kind === MenuHitKind.Close)
      .map((entry) => entry.x);
    expect(hits.length).toBeGreaterThan(0);
    // Contiguous, and in the right-hand quarter of the panel.
    expect(hits[hits.length - 1] ?? 0).toBe((hits[0] ?? 0) + hits.length - 1);
    expect(hits[0]).toBeGreaterThan(rect.x + Math.floor((rect.w * 3) / 4));
  });

  it('never answers for the greyed LEAVE PARTY row, anywhere on the panel', () => {
    // UNPRESSABLE IS STRUCTURAL, not a check in the caller. A greyed row that
    // still answered a click would send `party: leave` for a party of one.
    const rect = roomyRect();
    const rows = escapeMenuRows(view({ inParty: false }));
    let leaveHits = 0;
    for (let y = rect.y; y < rect.y + rect.h; y += 1) {
      for (let x = rect.x; x < rect.x + rect.w; x += 5) {
        const hit = escapeMenuHitAt(rect, rows, x, y);
        if (hit?.kind === MenuHitKind.Entry && hit.index === 5) leaveHits += 1;
      }
    }
    expect(leaveHits).toBe(0);

    // ...and it DOES answer once the viewer has somebody to leave, so the
    // assertion above is about the grey rather than about a missing row.
    const grouped = escapeMenuRows(view({ inParty: true }));
    let ok = 0;
    for (let y = rect.y; y < rect.y + rect.h; y += 1) {
      const hit = escapeMenuHitAt(rect, grouped, rect.x + 12, y);
      if (hit?.kind === MenuHitKind.Entry && hit.index === 5) ok += 1;
    }
    expect(ok).toBeGreaterThan(0);
  });

  it('answers null on the panel but off every control, which the caller swallows', () => {
    const rect = roomyRect();
    const rows = escapeMenuRows(view());
    // The header strip, left of the ×.
    expect(escapeMenuHitAt(rect, rows, rect.x + 2, rect.y + 6)).toBeNull();
    // ...and off the panel entirely.
    expect(escapeMenuHitAt(rect, rows, rect.x - 4, rect.y - 4)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// THE KEYS SCREEN — every action, grouped, with its two columns
// ---------------------------------------------------------------------------

describe('the keys screen', () => {
  it('lists every action this build binds, grouped and stably sorted', () => {
    // KeyBinder.lua:196-202 sorts by group then by `order`; ours takes the group
    // order from an explicit list rather than alphabetically (:236), so the
    // sections read in the order a player learns them.
    const rows = keysRows();
    const actions = actionRows(rows);
    expect(actions).toHaveLength(ACTIONS.length);

    const sections = rows.flatMap((row) => (row.kind === MenuRowKind.Section ? [row.label] : []));
    expect(sections).toEqual(['Movement', 'Turn', 'Screens', 'Hotbar', 'Log']);

    // Within a group, definition order. Movement is `DIR_ORDER`, clockwise from
    // north, and a screen that re-ranked it would teach a different ring from
    // the one under the player's fingers.
    const movement = actions.filter((row) => row.actionId.startsWith('move_'));
    expect(movement[0]?.actionId).toBe('move_north');
    expect(movement[1]?.actionId).toBe('move_northeast');
  });

  it('shows both columns as a player reads them, and `--` for an empty slot', () => {
    // KeyBind.lua:158-160's own first line is `if not ks then return "--" end`.
    // NEVER the stored form: a row reading `key:h` leaks a serialisation.
    const north = actionRows(keysRows()).find((row) => row.actionId === 'move_north');
    expect(north?.slots[0]).toBe('K');
    expect(north?.slots[1]).toBe('--');
    // ...and the PERMANENT FLOOR is on the row too, so a player who rewrote `k`
    // can see that the arrows and the numpad still walk them north.
    expect(north?.fixed).toBe('Up / Num8');
  });

  it('marks the five locked actions with a word AND a reason', () => {
    const locked = actionRows(keysRows()).filter((row) => row.locked);
    expect(locked.map((row) => row.actionId)).toEqual([
      'cancel',
      'hotbar_1',
      'hotbar_2',
      'hotbar_3',
      'hotbar_4',
    ]);
    for (const row of locked) {
      expect(row.reason, row.actionId).not.toBeNull();
      expect((row.reason ?? '').length).toBeGreaterThan(10);
    }
    // A LOCKED ROW SHOWS ITS FIXED KEYS, NOT '--'. Both have empty `defaults` —
    // that is what makes them unreachable by a remap — so reading the overlay
    // would tell the player Escape and the digits are unbound.
    expect(locked[0]?.slots[0]).toBe('Esc');
    expect(locked[1]?.slots[0]).toBe('1');
  });

  it('says so on the status line when nothing here will be saved', () => {
    // Decision (h)(3). Without it the first plain-browser session reports the
    // whole persistence feature as broken.
    const status = keysRows({ persisted: false }).find((row) => row.kind === MenuRowKind.Status);
    if (status?.kind !== MenuRowKind.Status) throw new Error('unreachable');
    expect(status.text).toContain('not saved');
    expect(status.tone).toBe(MenuTone.Warn);
  });

  it('states BOTH ways out while a capture is armed', () => {
    // KeyBinder.lua:82's title is "Press a key (escape to cancel, backspace to
    // remove)", and both halves are load-bearing: Escape is the only reason
    // upstream's binder is not self-bricking, Backspace the only way to say
    // "nothing".
    const status = keysRows({ armed: { actionId: 'say', slot: 1 } }).find(
      (row) => row.kind === MenuRowKind.Status,
    );
    if (status?.kind !== MenuRowKind.Status) throw new Error('unreachable');
    expect(status.text).toContain('Escape cancels');
    expect(status.text).toContain('Backspace clears');
    expect(status.text).toContain('key 2');
    expect(status.tone).toBe(MenuTone.Armed);

    // ...and the ROW says which action, with a glyph rather than only a colour.
    const say = actionRows(keysRows({ armed: { actionId: 'say', slot: 1 } })).find(
      (row) => row.actionId === 'say',
    );
    expect(say?.armedSlot).toBe(1);
  });
});

describe('escapeMenuHitAt on the keys screen', () => {
  const rect = roomyRect();
  const rows = keysRows();

  /** The y of a row that carries REBIND controls for `actionId`. */
  function rowY(actionId: string): number {
    for (let y = rect.y; y < rect.y + rect.h; y += 1) {
      for (let x = rect.x + rect.w - 170; x < rect.x + rect.w; x += 2) {
        const hit = escapeMenuHitAt(rect, rows, x, y);
        if (hit?.kind === MenuHitKind.Rebind && hit.actionId === actionId) return y;
      }
    }
    throw new Error(`no rebind control found for ${actionId}`);
  }

  it('lays the four controls out left to right: key 1, key 2, clear, reset', () => {
    // A SCAN across the row. What is asserted is the ORDER and the contiguity —
    // never a coordinate, which would be the test checking its own arithmetic.
    const y = rowY('move_north');
    const hits = across(rect, rows, y);
    const kinds: string[] = [];
    for (const { hit } of hits) {
      const tag =
        hit.kind === MenuHitKind.Rebind
          ? `rebind:${String(hit.slot)}`
          : hit.kind === MenuHitKind.Clear
            ? 'clear'
            : hit.kind === MenuHitKind.Reset
              ? 'reset'
              : hit.kind;
      if (kinds[kinds.length - 1] !== tag) kinds.push(tag);
    }
    expect(kinds).toEqual(['rebind:0', 'rebind:1', 'clear', 'reset']);
    for (const { hit } of hits) {
      if (hit.kind === MenuHitKind.Rebind) expect(hit.actionId).toBe('move_north');
      if (hit.kind === MenuHitKind.Clear) expect(hit.actionId).toBe('move_north');
      if (hit.kind === MenuHitKind.Reset) expect(hit.actionId).toBe('move_north');
    }
  });

  it('answers nothing at all over the NAME column, so a misclick arms nothing', () => {
    const y = rowY('move_north');
    expect(escapeMenuHitAt(rect, rows, rect.x + 12, y)).toBeNull();
  });

  it('offers no control anywhere on the panel for a LOCKED action', () => {
    // The hotbar digits and Escape are `rebindable: false`. Drawing controls that
    // refuse would be worse than drawing none — and the geometry, not the
    // caller, is what makes that true.
    for (let y = rect.y; y < rect.y + rect.h; y += 1) {
      for (let x = rect.x; x < rect.x + rect.w; x += 4) {
        const hit = escapeMenuHitAt(rect, rows, x, y);
        if (hit === null) continue;
        const named =
          hit.kind === MenuHitKind.Rebind ||
          hit.kind === MenuHitKind.Clear ||
          hit.kind === MenuHitKind.Reset
            ? hit.actionId
            : '';
        expect(named).not.toBe('cancel');
        expect(named.startsWith('hotbar_')).toBe(false);
      }
    }
  });

  it('offers RESET ALL and BACK in the footer, and nothing else claims that strip', () => {
    const found = new Set<string>();
    for (let y = rect.y + rect.h - 20; y < rect.y + rect.h; y += 1) {
      for (const { hit } of across(rect, rows, y)) found.add(hit.kind);
    }
    expect(found.has(MenuHitKind.ResetAll)).toBe(true);
    expect(found.has(MenuHitKind.Back)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// THE PAGING — words and a count, and the arithmetic behind them
// ---------------------------------------------------------------------------

describe('paging', () => {
  const rect = roomyRect();

  it('needs more than one page for twenty-six actions, and says the range in words', () => {
    // 26 actions, five headings and five locked rows carrying a second line is
    // more than any band in this client can hold — which is why there is a pager
    // at all rather than a silent truncation.
    const paging = escapeMenuPaging(rect, keysRows());
    expect(paging.total).toBe(ACTIONS.length);
    expect(paging.pageCount).toBeGreaterThan(1);
    expect(paging.page).toBe(0);
    expect(paging.first).toBe(1);
    expect(paging.last).toBeGreaterThan(0);
    expect(paging.last).toBeLessThan(paging.total);
    expect(paging.label).toBe(`1–${String(paging.last)} of ${String(ACTIONS.length)}`);
  });

  it('walks the pages contiguously and ends on the last action', () => {
    // A gap would hide a keybinding behind nothing at all; an overlap would make
    // NEXT feel broken.
    const first = escapeMenuPaging(rect, keysRows());
    let expected = 1;
    for (let page = 0; page < first.pageCount; page += 1) {
      const paging = escapeMenuPaging(rect, keysRows({ page }));
      expect(paging.page, `page ${String(page)}`).toBe(page);
      expect(paging.first, `page ${String(page)}`).toBe(expected);
      expect(paging.last).toBeGreaterThanOrEqual(paging.first);
      expected = paging.last + 1;
    }
    expect(expected - 1).toBe(ACTIONS.length);
  });

  it('clamps a page nobody can be on rather than drawing an empty screen', () => {
    const paging = escapeMenuPaging(rect, keysRows({ page: 99 }));
    expect(paging.page).toBe(paging.pageCount - 1);
    expect(paging.last).toBe(ACTIONS.length);
    // A negative page is the same kind of mistake and gets the same answer.
    expect(escapeMenuPaging(rect, keysRows({ page: -3 })).page).toBe(0);
  });

  it('says a plain count instead of a range when it all fits on one page', () => {
    // The root screen has no pager at all; this is the Keys screen in a band
    // tall enough to hold it, which is the case the range would say nothing in.
    const tall = escapeMenuRect({ width: 640, height: 4000, top: 0, bottom: 4000 });
    if (tall === null) throw new Error('unreachable');
    const roomier = { ...tall, h: 2000 };
    const paging = escapeMenuPaging(roomier, keysRows());
    expect(paging.pageCount).toBe(1);
    expect(paging.label).toBe(`${String(ACTIONS.length)} keys`);
  });
});

// ---------------------------------------------------------------------------
// THE CAPTURE — the pure state machine, one press wide
// ---------------------------------------------------------------------------

describe('applyCapture', () => {
  function press(over: Partial<Parameters<typeof applyCapture>[1]> = {}) {
    return { key: 'z', code: 'KeyZ', ctrlKey: false, altKey: false, metaKey: false, ...over };
  }

  function keymapOf(remap: KeyRemap) {
    return compileKeymap(ACTIONS, remap);
  }

  it('binds a free key, and leaves the OTHER slot on its default', () => {
    // Per-SLOT composition is the deviation keymap.ts takes from
    // KeyBind.lua:114-116, where any remap shadows the whole default array.
    const outcome = applyCapture({ actionId: 'say', slot: 0 }, press(), DEFAULT_KEYMAP);
    if (outcome.kind !== CaptureKind.Bound) throw new Error(`expected bound, got ${outcome.kind}`);
    expect(outcome.remap).toEqual({ say: ['key:z'] });

    const after = keymapOf(outcome.remap);
    expect(labelFor('say', after, 0)).toBe('Z');
    expect(labelFor('say', after, 1)).toBe('/');
    expect(outcome.message).toContain('Z');
  });

  it('reports the bare key for a shifted press, because the dispatcher cannot tell', () => {
    // Every key-side lookup in keys.ts lowercases and does NOT exclude Shift, so
    // Shift+H and H are one press (test/client/input/keys.test.ts:314-316). A UI
    // showing "Shift+H" would promise what the dispatcher cannot honour.
    // A shifted Z rather than a shifted H, deliberately: `h` is already
    // `move_west`, so that press would have been REFUSED for a reason that has
    // nothing to do with the case of the letter and the assertion would have
    // been passing for the wrong reason.
    const outcome = applyCapture(
      { actionId: 'say', slot: 0 },
      press({ key: 'Z', code: 'KeyZ' }),
      DEFAULT_KEYMAP,
    );
    if (outcome.kind !== CaptureKind.Bound) throw new Error('expected bound');
    expect(outcome.remap).toEqual({ say: ['key:z'] });
  });

  it('REFUSES a key somebody else already answers, and names them', () => {
    // A DEVIATION with nothing to port: KeyBinder.lua:98-104 performs no lookup
    // at all and lets `pairs` hash order decide the winner later
    // (KeyBind.lua:227-232). We refuse, name the holder, and leave the row alone
    // — no swap (a second edit nobody asked for) and no silent shadow.
    const outcome = applyCapture(
      { actionId: 'say', slot: 0 },
      press({ key: 'i', code: 'KeyI' }),
      DEFAULT_KEYMAP,
    );
    if (outcome.kind !== CaptureKind.Conflict) throw new Error('expected conflict');
    expect(outcome.holder).toBe('show_inventory');
    expect(outcome.holderName).toBe('Inventory');
    expect(outcome.message).toContain('Inventory');
    // THE ROW IS UNCHANGED: a conflict carries no remap at all, so there is
    // nothing for a careless caller to apply.
    expect('remap' in outcome).toBe(false);
  });

  it('arbitrates by the real dispatcher, so the numpad and the letters collide properly', () => {
    // `code:Numpad7` is `move_northwest`'s frozen floor. String equality would
    // miss it — the candidate is a code and the holder's other keys are letters
    // — so this is the assertion that `conflictsFor` walks the dispatch order.
    const outcome = applyCapture(
      { actionId: 'move_north', slot: 0 },
      press({ key: '7', code: 'Numpad7' }),
      DEFAULT_KEYMAP,
    );
    if (outcome.kind !== CaptureKind.Conflict) throw new Error('expected conflict');
    expect(outcome.holder).toBe('move_northwest');
  });

  it('clears a slot on Backspace and leaves the other one alone', () => {
    // KeyBinder.lua:95-97 does the same with a Lua nil, which its positional file
    // format can express and JSON cannot — hence the reserved 'none'.
    const outcome = applyCapture(
      { actionId: 'say', slot: 0 },
      press({ key: 'Backspace', code: 'Backspace' }),
      DEFAULT_KEYMAP,
    );
    if (outcome.kind !== CaptureKind.Cleared) throw new Error('expected cleared');
    const after = keymapOf(outcome.remap);
    expect(labelFor('say', after, 0)).toBe('--');
    expect(labelFor('say', after, 1)).toBe('/');
  });

  it('DISARMS on Escape and binds nothing', () => {
    // KeyBinder.lua:98 compares the RAW sym, deliberately outside the virtual
    // system. It is the single reason upstream's binder cannot brick itself, and
    // it is the reason ours cannot either.
    const outcome = applyCapture(
      { actionId: 'say', slot: 0 },
      press({ key: 'Escape', code: 'Escape' }),
      DEFAULT_KEYMAP,
    );
    expect(outcome.kind).toBe(CaptureKind.Disarmed);
  });

  it('IGNORES a bare modifier and stays armed, so reaching for a chord is free', () => {
    // KeyBinder.lua:88-93 returns WITHOUT closing its dialog for exactly these.
    for (const key of ['Shift', 'Control', 'Alt', 'Meta']) {
      const outcome = applyCapture(
        { actionId: 'say', slot: 0 },
        press({ key, code: `${key}Left` }),
        DEFAULT_KEYMAP,
      );
      expect(outcome.kind, key).toBe(CaptureKind.Ignored);
    }
  });

  it('REFUSES a Ctrl/Alt/Meta chord with a sentence rather than binding it', () => {
    // keys.ts:340-342 discards those globally — "the browser's and Discord's
    // shortcut space" — so binding one would bind a key the dispatcher can never
    // deliver, and the rebind would appear to take and then do nothing.
    for (const chord of [{ ctrlKey: true }, { altKey: true }, { metaKey: true }]) {
      const outcome = applyCapture({ actionId: 'say', slot: 0 }, press(chord), DEFAULT_KEYMAP);
      if (outcome.kind !== CaptureKind.Refused) throw new Error('expected refused');
      expect(outcome.message).toContain('Ctrl');
    }
  });

  it('REFUSES a locked action, for a bind and for a clear alike', () => {
    for (const actionId of ['cancel', 'hotbar_1']) {
      const bound = applyCapture({ actionId, slot: 0 }, press(), DEFAULT_KEYMAP);
      expect(bound.kind, actionId).toBe(CaptureKind.Refused);
      const cleared = applyCapture(
        { actionId, slot: 0 },
        press({ key: 'Backspace', code: 'Backspace' }),
        DEFAULT_KEYMAP,
      );
      expect(cleared.kind, actionId).toBe(CaptureKind.Refused);
    }
  });

  it('REFUSES a numpad key on an action the dispatcher could never deliver it to', () => {
    // keys.ts has exactly two `code`-keyed tables. `canDeliver` is the predicate
    // that lets the player be told rather than left with a binding that resolves
    // to nothing.
    const outcome = applyCapture(
      { actionId: 'say', slot: 0 },
      press({ key: '7', code: 'Numpad7' }),
      DEFAULT_KEYMAP,
    );
    if (outcome.kind !== CaptureKind.Refused) throw new Error('expected refused');
    expect(outcome.message).toContain('Num7');
  });

  it('does nothing at all when nothing is armed', () => {
    expect(applyCapture(null, press(), DEFAULT_KEYMAP).kind).toBe(CaptureKind.Ignored);
  });

  it('is exactly one press wide: every outcome but IGNORED is terminal', () => {
    // The barrier answer in one assertion. There is no state in which this
    // screen holds the keyboard and waits for a human — which is the thing that
    // stalled the floor when the class picker shipped as a modal.
    const terminal = [
      press(),
      press({ key: 'i' }),
      press({ key: 'Backspace' }),
      press({ key: 'Escape' }),
      press({ ctrlKey: true }),
    ];
    for (const input of terminal) {
      expect(applyCapture({ actionId: 'say', slot: 0 }, input, DEFAULT_KEYMAP).kind).not.toBe(
        CaptureKind.Ignored,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// RESET ONE AND RESET ALL — the two hatches the screen offers by pointer alone
// ---------------------------------------------------------------------------

describe('reset', () => {
  it('puts one action back on its shipped defaults', () => {
    // One line in keymap.ts, and it is one line only because `defaults` is never
    // mutated — the trap KeyBinder.lua:96-103 falls into by storing
    // `t.k.default` by reference and then writing through it, which is why
    // upstream has no reset button at all.
    const rebound: KeyRemap = { say: ['key:z'], move_north: ['key:w'] };
    expect(labelFor('say', compileKeymap(ACTIONS, rebound), 0)).toBe('Z');

    const after = resetOne(rebound, 'say');
    expect(labelFor('say', compileKeymap(ACTIONS, after), 0)).toBe('T');
    // ...and it leaves everything else exactly where the player put it.
    expect(labelFor('move_north', compileKeymap(ACTIONS, after), 0)).toBe('W');
  });

  it('puts EVERYTHING back, and an empty overlay is a real value', () => {
    // `binds: {}` on the wire is RESET ALL and is not a missing field.
    expect(resetAll()).toEqual({});
    const km = compileKeymap(ACTIONS, resetAll());
    expect(labelFor('say', km, 0)).toBe('T');
    expect(labelFor('move_north', km, 0)).toBe('K');
  });
});

// ---------------------------------------------------------------------------
// PAINTING — that the drawer is wired to the geometry, and says what it must
// ---------------------------------------------------------------------------

describe('drawing', () => {
  /**
   * The Proxy recorder from test/client/talents.test.ts:470-511.
   *
   * `measureText` answers SIX PIXELS PER CHARACTER rather than a flat constant,
   * and that is load-bearing: a constant makes `fitText` ellipsise every string
   * it is given — including a three-character button label — so the recorded
   * text would be nothing but ellipses and none of the sentences below could be
   * read. Six is the advance of the 10px monospace every panel here draws with.
   */
  function recorder(
    clips: { x: number; y: number; w: number; h: number }[],
    calls: string[],
    texts: string[],
  ) {
    return new Proxy(
      {},
      {
        get: (_target, prop: string) => {
          if (prop === 'measureText') return (text: string) => ({ width: text.length * 6 });
          if (prop === 'rect')
            return (x: number, y: number, w: number, h: number) => {
              clips.push({ x, y, w, h });
            };
          if (prop === 'fillText')
            return (text: string, ...rest: unknown[]) => {
              texts.push(text);
              calls.push(`fillText(${rest.length + 1})`);
            };
          if (prop === 'canvas') return undefined;
          return (...args: unknown[]) => {
            calls.push(`${prop}(${args.length})`);
          };
        },
        set: () => true,
      },
    ) as unknown as CanvasRenderingContext2D;
  }

  function paint(menuView: EscapeMenuView) {
    const clips: { x: number; y: number; w: number; h: number }[] = [];
    const calls: string[] = [];
    const texts: string[] = [];
    const rect = roomyRect();
    drawEscapeMenu({
      ctx: recorder(clips, calls, texts),
      // NO ART AT ALL, which is the honest state of a fresh clone: every id this
      // panel could want comes from ui/panel.ts, and all three of its helpers
      // degrade to a traced box.
      sprites: { sprite: () => undefined },
      rect,
      screen: menuView.screen,
      rows: escapeMenuRows(menuView),
      hoveredClose: false,
      hovered: null,
    });
    return { clips, calls, texts, rect };
  }

  it('clips to its own rect and pairs every save with a restore', () => {
    const { clips, calls, rect } = paint(view());
    expect(calls.length).toBeGreaterThan(0);
    expect(clips[0]).toEqual({ x: rect.x, y: rect.y, w: rect.w, h: rect.h });
    // An unbalanced restore leaks a font, an alignment or an alpha into every
    // painter later in the frame, and it presents as a bug in whichever surface
    // happens to be drawn next (ui/turncards.ts:786-790 records the same trap).
    expect(calls.filter((c) => c.startsWith('save(')).length).toBe(
      calls.filter((c) => c.startsWith('restore(')).length,
    );
  });

  it('draws all six entries and both titles', () => {
    const root = paint(view());
    expect(root.texts.some((t) => t.includes('GAME MENU'))).toBe(true);
    for (const label of [
      'RESUME',
      'KEY BINDINGS',
      'CHARACTER SHEET',
      'TALENTS',
      'INVENTORY',
      'LEAVE PARTY',
    ]) {
      expect(
        root.texts.some((t) => t.includes(label)),
        label,
      ).toBe(true);
    }

    const keys = paint(view({ screen: MenuScreen.Keys }));
    expect(keys.texts.some((t) => t.includes('KEY BINDINGS'))).toBe(true);
  });

  it('paints the keys screen with its columns, its controls and its pager', () => {
    const { texts } = paint(view({ screen: MenuScreen.Keys }));
    expect(texts).toContain('Move north');
    expect(texts).toContain('Movement');
    // The two per-row controls, in the bracketed-letter grammar.
    expect(texts).toContain('[X]');
    expect(texts).toContain('[D]');
    expect(texts).toContain('RESET ALL');
    expect(texts).toContain('BACK');
    // WORDS AND A COUNT, never a bar (ui/caselog.ts:464-478).
    expect(texts.some((t) => /\d+–\d+ of 26/.test(t))).toBe(true);
    // The permanent floor is on the row, so a rebind cannot look like a break.
    expect(texts.some((t) => t.includes('Up / Num8'))).toBe(true);
  });

  it('marks a locked row with the WORD and the reason, not with a colour', () => {
    // Walked page by page, because `cancel` and the hotbar digits are not on the
    // first one — and a test that only ever looked at page 0 would be blind to
    // most of this screen.
    const pages = escapeMenuPaging(roomyRect(), keysRows()).pageCount;
    const texts: string[] = [];
    for (let page = 0; page < pages; page += 1) {
      texts.push(...paint(view({ screen: MenuScreen.Keys, page })).texts);
    }
    const locked = texts.filter((t) => t.startsWith('LOCKED'));
    expect(locked.length).toBeGreaterThan(0);
    // Not truncated: the whole point of the taller locked row is that the reason
    // survives, and `fitText` here measures at the real six pixels a character.
    expect(locked.some((t) => !t.endsWith('…'))).toBe(true);
  });

  it('paints the armed prompt only while something is armed, with a marker', () => {
    const quiet = paint(view({ screen: MenuScreen.Keys }));
    expect(quiet.texts.some((t) => t.includes('Escape cancels'))).toBe(false);

    const armed = paint(
      view({ screen: MenuScreen.Keys, armed: { actionId: 'move_north', slot: 0 } }),
    );
    expect(armed.texts.some((t) => t.includes('Escape cancels, Backspace clears'))).toBe(true);
    // The armed column wears a different GLYPH, not merely a different colour.
    expect(armed.texts).toContain('[?]');
    expect(quiet.texts).not.toContain('[?]');
  });

  it('tells an anonymous player that none of this will be saved', () => {
    const { texts } = paint(view({ screen: MenuScreen.Keys, persisted: false }));
    expect(texts.some((t) => t.includes('not saved'))).toBe(true);
  });

  it('still paints, and still clips, in a panel too small for six entries', () => {
    const clips: { x: number; y: number; w: number; h: number }[] = [];
    const calls: string[] = [];
    const texts: string[] = [];
    const rect = { x: 4, y: 4, w: 240, h: 96 };
    drawEscapeMenu({
      ctx: recorder(clips, calls, texts),
      sprites: { sprite: () => undefined },
      rect,
      screen: MenuScreen.Root,
      rows: escapeMenuRows(view()),
      hoveredClose: true,
      hovered: 0,
    });
    expect(clips[0]).toEqual(rect);
    // ui/caselog.ts:464-478: a surface that has quietly stopped showing
    // everything must never make the reader infer it.
    expect(texts.some((t) => t.includes('panel too small'))).toBe(true);
  });
});
