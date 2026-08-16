/// <reference lib="dom" />

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  INVENTORY_PANEL_CARRIED_MAX,
  INVENTORY_PANEL_COLS,
  INVENTORY_PANEL_MARGIN,
  INVENTORY_PANEL_MIN_H,
  INVENTORY_PANEL_MIN_W,
  InventoryHitKind,
  InventoryRowKind,
  InventoryTab,
  drawInventoryPanel,
  focusForHit,
  inventoryPanelGeometry,
  inventoryPanelHitAt,
  inventoryPanelRect,
  inventoryPanelRows,
} from '../../src/client/ui/inventory.ts';
import { ItemTier, SLOT_ORDER } from '../../src/shared/protocol.ts';
import { PROTOCOL_VERSION } from '../../src/shared/version.ts';
import type {
  InventoryFocus,
  InventoryPanelView,
  InventoryRow,
} from '../../src/client/ui/inventory.ts';
import type { CarriedItemView, InventoryMsg, ItemView, Slot } from '../../src/shared/protocol.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE INVENTORY PANEL, READ THE WAY A CLICK READS IT. NO PIXELS ARE ASSERTED.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * vitest.config.ts is explicit that there is deliberately no jsdom and no canvas
 * here, and nothing below paints to anything real. What is tested is the layer
 * where a bug on this screen is INVISIBLE or MISLEADING:
 *
 *   THE ORDER       the doll is `SLOT_ORDER` and the bag is the server's own
 *                   order. A panel that sorted either would move the cell under
 *                   a player's finger because a number changed somewhere else.
 *   THE HIT TEST    the painter and the pointer read ONE geometry function, at
 *                   several viewport sizes. Two copies of that arithmetic is a
 *                   cell that equips the item next to the one that was clicked,
 *                   and the bug only shows up on somebody else's window
 *                   (ui/partypanel.ts:93-99).
 *   THE GRID        four columns, decided by the art: `ui_item_frame_*` is 72x72
 *                   and 320 - 16 of inset holds exactly four of them. Seven worn
 *                   slots are two rows and twelve carried are three.
 *   THE STRIP       every number in it is a STRING the server formatted. The
 *                   client cannot compute one — eslint blocks the three shared/
 *                   modules that would let it — and a client that subtracted two
 *                   armour numbers would be WRONG rather than merely redundant,
 *                   because `rescaleCombatStats` floors.
 *   THE BANDS       the panel rect NEVER touches the hotbar or the resource
 *                   strip. That is the panel-not-modal property made mechanical
 *                   and it is the test that catches a later "just make it a bit
 *                   taller".
 *
 * The hit tests SCAN rather than assert coordinates, for the reason
 * test/client/partypanel.test.ts:56-61 gives: an assertion that a cell starts at
 * x=300 would pass while it was drawn at x=298, because it would be testing the
 * test's own copy of the arithmetic.
 *
 * THE `reference lib="dom"` ON LINE 1 IS REQUIRED and its cost is documented at
 * test/client/turncards.test.ts:51-60.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function worn(itemId: string, name: string, tier: ItemTier): ItemView {
  return { itemId, name, icon: itemId, tier, desc: `${name}, worn.` };
}

function bagged(
  itemId: string,
  name: string,
  tier: ItemTier,
  slot: Slot,
  compare: readonly { label: string; value: string }[] = [],
): CarriedItemView {
  return { itemId, name, icon: itemId, tier, desc: `${name}, in the bag.`, slot, compare };
}

/**
 * FOUR CARRIED ITEMS WHOSE ORDER IS THE OPPOSITE OF EVERY ORDER A PANEL MIGHT BE
 * TEMPTED TO IMPOSE: reverse-alphabetical by name AND by id, and DESCENDING by
 * tier. Any sort at all reorders this list, so the order assertion cannot pass by
 * accident — the same trick test/client/talents.test.ts:82-92 plays on a loadout.
 */
const BAG: readonly CarriedItemView[] = [
  bagged('item_watchmans_coat', "Watchman's Coat", ItemTier.Rare, 'body', [
    { label: 'Armour', value: '+4' },
    { label: 'Hardiness', value: '+10%' },
  ]),
  bagged('item_signet', 'Signet', ItemTier.Uncommon, 'ring', [
    { label: 'Crit. chance', value: '+4%' },
  ]),
  bagged('item_locket', 'Locket', ItemTier.Uncommon, 'trinket'),
  bagged('item_boots', 'Boots', ItemTier.Common, 'feet', [{ label: 'Defence', value: '-1' }]),
];

const DOLL: InventoryMsg['equipped'] = {
  head: worn('item_watchmans_cap', "Watchman's Cap", ItemTier.Uncommon),
  body: worn('item_leather_chest', 'Leather Chestpiece', ItemTier.Common),
  ring: worn('item_inspectors_signet', "Inspector's Signet", ItemTier.Uncommon),
};

function frame(over: Partial<InventoryMsg> = {}): InventoryMsg {
  return {
    v: PROTOCOL_VERSION,
    t: 'inventory',
    carried: BAG,
    equipped: DOLL,
    ...over,
  };
}

function view(over: Partial<InventoryPanelView> = {}): InventoryPanelView {
  return { inventory: frame(), tab: InventoryTab.Equipped, focus: null, ...over };
}

function cellRows(rows: readonly InventoryRow[]) {
  return rows.flatMap((row) => (row.kind === InventoryRowKind.Cells ? [row] : []));
}

function detailOf(rows: readonly InventoryRow[]) {
  const row = rows.find((entry) => entry.kind === InventoryRowKind.Detail);
  if (row === undefined || row.kind !== InventoryRowKind.Detail) {
    throw new Error('unreachable: every panel carries a detail row');
  }
  return row;
}

/** A band that comfortably holds the whole panel, strip included. */
const ROOMY = { width: 800, height: 800, top: 20, bottom: 700 };

function roomyRect() {
  const rect = inventoryPanelRect(ROOMY);
  if (rect === null) throw new Error('unreachable: the roomy band must hold a panel');
  return rect;
}

// ---------------------------------------------------------------------------
// THE ROWS — the doll's order, the bag's order, and the grid's shape
// ---------------------------------------------------------------------------

describe('inventoryPanelRows', () => {
  it('walks the doll in SLOT_ORDER and shows every empty slot', () => {
    // The doll is seven slots whether or not anything is in them —
    // EquipDollFrame.lua:165-177 paints the frame and then EITHER the object OR
    // `bg_empty`. A doll that listed only what was worn would hide the fact that
    // `offhand` and `trinket` are places things can go.
    const cells = cellRows(inventoryPanelRows(view())).flatMap((row) => row.cells);
    expect(cells).toHaveLength(SLOT_ORDER.length);
    // Both cell shapes carry a slot, filled or not — which is what makes the doll
    // a fixed seven rather than a list of what happens to be worn.
    expect(cells.map((cell) => cell.slot)).toEqual([...SLOT_ORDER]);
    expect(cells.map((cell) => cell.kind)).toEqual([
      'item',
      'item',
      'empty',
      'empty',
      'empty',
      'item',
      'empty',
    ]);
  });

  it('keeps the bag in the server’s own order and never sorts it', () => {
    const cells = cellRows(inventoryPanelRows(view({ tab: InventoryTab.Carried }))).flatMap(
      (row) => row.cells,
    );
    expect(cells.map((cell) => (cell.kind === 'item' ? cell.name : '—'))).toEqual([
      "Watchman's Coat",
      'Signet',
      'Locket',
      'Boots',
    ]);
  });

  it('carries the wire’s own icon key and never one built from the name', () => {
    const first = cellRows(inventoryPanelRows(view({ tab: InventoryTab.Carried })))[0]?.cells[0];
    expect(first?.kind).toBe('item');
    if (first?.kind !== 'item') throw new Error('unreachable');
    expect(first.icon).toBe('item_watchmans_coat');
  });

  it('lays seven worn slots into two rows and twelve carried into three', () => {
    // FOUR COLUMNS, EXACTLY: 320 - 2x8 of inset is 304, and four 72-pixel frames
    // with three 5-pixel gaps is 303. Nothing else fits and nothing narrower is
    // offered, because a column is the size of a PNG.
    expect(INVENTORY_PANEL_COLS).toBe(4);

    const doll = cellRows(inventoryPanelRows(view()));
    expect(doll).toHaveLength(2);
    expect(doll.map((row) => row.cells.length)).toEqual([4, 3]);

    const full = Array.from({ length: INVENTORY_PANEL_CARRIED_MAX }, (_v, i) =>
      bagged(`item_${String(i)}`, `Thing ${String(i)}`, ItemTier.Common, 'ring'),
    );
    const bag = cellRows(
      inventoryPanelRows(view({ inventory: frame({ carried: full }), tab: InventoryTab.Carried })),
    );
    expect(bag).toHaveLength(3);
    expect(bag.map((row) => row.cells.length)).toEqual([4, 4, 4]);
  });

  it('says so in words when a bag arrives longer than one page holds', () => {
    // The server caps at twelve (gateway.ts's INVENTORY_CAP), so this is
    // unreachable in ordinary play. ui/caselog.ts:467-478's rule applies anyway: a
    // surface that has quietly stopped showing everything must never make the
    // reader infer it.
    const thirteen = Array.from({ length: INVENTORY_PANEL_CARRIED_MAX + 1 }, (_v, i) =>
      bagged(`item_${String(i)}`, `Thing ${String(i)}`, ItemTier.Common, 'ring'),
    );
    const rows = inventoryPanelRows(
      view({ inventory: frame({ carried: thirteen }), tab: InventoryTab.Carried }),
    );
    expect(cellRows(rows).flatMap((row) => row.cells)).toHaveLength(INVENTORY_PANEL_CARRIED_MAX);
    const note = rows.find((row) => row.kind === InventoryRowKind.Note);
    expect(note?.kind).toBe(InventoryRowKind.Note);
    if (note?.kind !== InventoryRowKind.Note) throw new Error('unreachable');
    expect(note.text).toContain('1 more carried');
  });

  it('says something rather than nothing before the first frame arrives', () => {
    // A bare detective is never sent an `inventory` frame at all, so this is the
    // ordinary state rather than a failure, and it must read as one.
    const rows = inventoryPanelRows(view({ inventory: null }));
    const note = rows.find((row) => row.kind === InventoryRowKind.Note);
    if (note?.kind !== InventoryRowKind.Note) throw new Error('unreachable');
    expect(note.text).toContain('nothing');
    expect(cellRows(rows)).toHaveLength(0);
  });

  it('says the bag is empty rather than drawing an empty grid', () => {
    const rows = inventoryPanelRows(
      view({ inventory: frame({ carried: [] }), tab: InventoryTab.Carried }),
    );
    const note = rows.find((row) => row.kind === InventoryRowKind.Note);
    if (note?.kind !== InventoryRowKind.Note) throw new Error('unreachable');
    expect(note.text).toBe('you are carrying nothing');
  });
});

// ---------------------------------------------------------------------------
// THE TABS — one screen, two halves, and switching changes nothing else
// ---------------------------------------------------------------------------

describe('the tabs', () => {
  it('changes the CELLS and leaves every other row alone', () => {
    // `SHOW_EQUIPMENT = "SHOW_INVENTORY"` (Game.lua:2192) is an alias and both
    // open one combined dialog, so the tab is a view onto one frame rather than a
    // second screen with a second source of truth. Everything that is not a cell
    // — the tab strip's counts, the comparison strip — must be identical either
    // way, or the two halves are two panels wearing one header.
    const focus: InventoryFocus = { kind: 'item', itemId: 'item_signet' };
    const equipped = inventoryPanelRows(view({ tab: InventoryTab.Equipped, focus }));
    const carried = inventoryPanelRows(view({ tab: InventoryTab.Carried, focus }));

    const strip = (rows: readonly InventoryRow[]) =>
      rows.filter(
        (row) => row.kind !== InventoryRowKind.Cells && row.kind !== InventoryRowKind.Tabs,
      );
    expect(strip(carried)).toEqual(strip(equipped));

    const tabs = (rows: readonly InventoryRow[]) =>
      rows.find((row) => row.kind === InventoryRowKind.Tabs);
    const a = tabs(equipped);
    const b = tabs(carried);
    if (a?.kind !== InventoryRowKind.Tabs || b?.kind !== InventoryRowKind.Tabs) {
      throw new Error('unreachable');
    }
    // The COUNTS are the same on both tabs; only which one is selected moves.
    expect([a.wornCount, a.carriedCount]).toEqual([3, 4]);
    expect([b.wornCount, b.carriedCount]).toEqual([3, 4]);
    expect(a.tab).toBe(InventoryTab.Equipped);
    expect(b.tab).toBe(InventoryTab.Carried);

    expect(cellRows(equipped).flatMap((row) => row.cells)).toHaveLength(SLOT_ORDER.length);
    expect(cellRows(carried).flatMap((row) => row.cells)).toHaveLength(BAG.length);
  });

  it('answers which tab a click means from POSITION, not from state', () => {
    // The two boxes are laid out by the geometry and never by the selection, so a
    // click on the left half means EQUIPPED whichever tab happens to be open. A
    // hit test that read the current tab would swap the two the moment somebody
    // switched, and the bug would present as a tab that cannot be left.
    const rect = roomyRect();
    for (const tab of [InventoryTab.Equipped, InventoryTab.Carried]) {
      const rows = inventoryPanelRows(view({ tab }));
      const placed = inventoryPanelGeometry(rect, rows).placed.find(
        (entry) => entry.row.kind === InventoryRowKind.Tabs,
      );
      if (placed === undefined) throw new Error('unreachable');
      const [left, right] = placed.tabs;
      if (left === undefined || right === undefined) throw new Error('unreachable');

      const at = (box: { x: number; y: number; w: number; h: number }) =>
        inventoryPanelHitAt(
          rect,
          rows,
          box.x + Math.floor(box.w / 2),
          box.y + Math.floor(box.h / 2),
        );
      expect(at(left)).toEqual({ kind: InventoryHitKind.Tab, tab: InventoryTab.Equipped });
      expect(at(right)).toEqual({ kind: InventoryHitKind.Tab, tab: InventoryTab.Carried });
    }
  });
});

// ---------------------------------------------------------------------------
// THE BAND — the panel-not-modal property, made mechanical
// ---------------------------------------------------------------------------

describe('inventoryPanelRect', () => {
  /**
   * The bottom bands, as main.ts stacks them: the hotbar, then the resource pips,
   * then two prose lines. `panelBand` derives `bottom` from those modules' own
   * exported heights and this panel is handed the result — so the property under
   * test is that the panel NEVER crosses whatever bottom it was given, at any
   * size, for any band.
   */
  const SIZES = [
    { width: 640, height: 480, top: 17, bottom: 337 },
    { width: 800, height: 600, top: 96, bottom: 470 },
    { width: 1024, height: 768, top: 24, bottom: 600 },
    { width: 1280, height: 720, top: 100, bottom: 560 },
    { width: 360, height: 300, top: 12, bottom: 200 },
  ] as const;

  it('never crosses the top or the bottom of its band, at any viewport size', () => {
    // ═══ THIS IS THE TEST THAT CATCHES "just make it a bit taller" ═══
    // The whole design is that a player reading their inventory holds nobody up,
    // and the mechanical half of that is that every control stays visible and
    // pressable underneath the panel. A panel that reached the hotbar would be a
    // modal wearing a panel's clothes.
    for (const size of SIZES) {
      const rect = inventoryPanelRect(size);
      if (rect === null) continue;
      expect(rect.y, `${String(size.width)}x${String(size.height)}`).toBeGreaterThanOrEqual(
        size.top,
      );
      expect(rect.y + rect.h).toBeLessThanOrEqual(size.bottom);
      expect(rect.x).toBeGreaterThanOrEqual(0);
      expect(rect.x + rect.w).toBeLessThanOrEqual(size.width);
    }
  });

  it('clamps the band against the viewport, not just against what it was told', () => {
    // A caller holding a stale viewport size must not be able to push the panel
    // off the bottom, where its close button would be unreachable.
    const rect = inventoryPanelRect({ width: 640, height: 300, top: 20, bottom: 900 });
    if (rect === null) throw new Error('unreachable');
    expect(rect.y + rect.h).toBeLessThanOrEqual(300);
  });

  it('is anchored to the BOTTOM of the band, so it misses both other panels', () => {
    // ui/charsheet.ts centres itself in this band and ui/talents.ts pins itself to
    // the top of it. `c`, `g` and `i` are three independent toggles, so all three
    // can be open at once and the third surface takes the one anchor left.
    const rect = roomyRect();
    expect(rect.y + rect.h).toBe(ROOMY.bottom - INVENTORY_PANEL_MARGIN);
  });

  it('gives up rather than drawing a panel taller or wider than the band', () => {
    expect(
      inventoryPanelRect({ width: 640, height: 480, top: 20, bottom: 20 + INVENTORY_PANEL_MIN_H }),
    ).toBeNull();
    expect(
      inventoryPanelRect({ width: INVENTORY_PANEL_MIN_W, height: 480, top: 20, bottom: 400 }),
    ).toBeNull();
  });

  it('opens at exactly the minimum band, so the constant is a real edge', () => {
    const tight = INVENTORY_PANEL_MIN_H + INVENTORY_PANEL_MARGIN * 2;
    expect(inventoryPanelRect({ width: 640, height: 480, top: 0, bottom: tight })).not.toBeNull();
    expect(inventoryPanelRect({ width: 640, height: 480, top: 0, bottom: tight - 1 })).toBeNull();
  });

  it('is exactly one width, because a column is the size of a PNG', () => {
    // Every other panel in this client clamps its width down to fit a narrow
    // viewport. This one cannot: `ui_item_frame_*` is 72x72 and the icon inside it
    // is 64x64 at 1:1, so there is no three-column arrangement to degrade to.
    for (const size of SIZES) {
      const rect = inventoryPanelRect(size);
      if (rect === null) continue;
      expect(rect.w).toBe(INVENTORY_PANEL_MIN_W);
    }
  });
});

// ---------------------------------------------------------------------------
// THE HIT TEST — one copy of the arithmetic, at several sizes
// ---------------------------------------------------------------------------

describe('inventoryPanelHitAt', () => {
  it('answers with the cell the painter placed, at every viewport size', () => {
    // ═══ THE TWO-COPIES-OF-THE-ARITHMETIC BUG, ASKED DIRECTLY ═══
    // The geometry the painter reads is walked, and every placed cell's own
    // centre is put back through the hit test. Anything that computed the two
    // separately would disagree here on at least one of these sizes, which is
    // exactly how the bug presents: fine on the author's window, wrong on
    // somebody else's — and here "wrong" means wearing the item beside the one
    // that was clicked.
    for (const size of [
      { width: 640, height: 480, top: 17, bottom: 337 },
      { width: 800, height: 600, top: 96, bottom: 470 },
      { width: 1024, height: 900, top: 24, bottom: 780 },
      { width: 1280, height: 720, top: 100, bottom: 560 },
    ]) {
      const rect = inventoryPanelRect(size);
      if (rect === null) continue;

      for (const tab of [InventoryTab.Equipped, InventoryTab.Carried]) {
        const rows = inventoryPanelRows(view({ tab }));
        const geometry = inventoryPanelGeometry(rect, rows);

        for (const placed of geometry.placed) {
          if (placed.row.kind !== InventoryRowKind.Cells) continue;
          for (let i = 0; i < placed.cells.length; i += 1) {
            const box = placed.cells[i];
            const cell = placed.row.cells[i];
            if (box === undefined || cell === undefined) throw new Error('unreachable');
            const hit = inventoryPanelHitAt(
              rect,
              rows,
              box.x + Math.floor(box.w / 2),
              box.y + Math.floor(box.h / 2),
            );
            if (cell.kind === 'empty') {
              expect(hit).toEqual({ kind: InventoryHitKind.EmptySlot, slot: cell.slot });
            } else {
              expect(hit).toEqual({
                kind: InventoryHitKind.Item,
                itemId: cell.itemId,
                slot: cell.slot,
                worn: cell.worn,
              });
            }
          }
        }
      }
    }
  });

  it('tells an empty slot from a filled one, and names both', () => {
    // The two are different acts: one is `unequip` and one is nothing at all. A
    // cell that answered the same for both would let a click on an empty slot
    // take off whatever the panel drew last.
    const rect = roomyRect();
    const rows = inventoryPanelRows(view());
    const found = new Map<string, unknown>();
    for (const placed of inventoryPanelGeometry(rect, rows).placed) {
      if (placed.row.kind !== InventoryRowKind.Cells) continue;
      for (let i = 0; i < placed.cells.length; i += 1) {
        const box = placed.cells[i];
        const cell = placed.row.cells[i];
        if (box === undefined || cell === undefined) continue;
        const hit = inventoryPanelHitAt(rect, rows, box.x + 4, box.y + 4);
        found.set(cell.kind === 'item' ? cell.itemId : cell.slot, hit);
      }
    }
    expect(found.get('item_watchmans_cap')).toEqual({
      kind: InventoryHitKind.Item,
      itemId: 'item_watchmans_cap',
      slot: 'head',
      worn: true,
    });
    expect(found.get('legs')).toEqual({ kind: InventoryHitKind.EmptySlot, slot: 'legs' });
  });

  it('marks a carried item as NOT worn, which is what decides equip from unequip', () => {
    const rect = roomyRect();
    const rows = inventoryPanelRows(view({ tab: InventoryTab.Carried }));
    const placed = inventoryPanelGeometry(rect, rows).placed.find(
      (entry) => entry.row.kind === InventoryRowKind.Cells,
    );
    const box = placed?.cells[0];
    if (box === undefined) throw new Error('unreachable');
    expect(inventoryPanelHitAt(rect, rows, box.x + 2, box.y + 2)).toEqual({
      kind: InventoryHitKind.Item,
      itemId: 'item_watchmans_coat',
      slot: 'body',
      worn: false,
    });
  });

  it('hands back one contiguous run per cell as the pointer walks a row', () => {
    // A SCAN across the grid, describing what was found rather than asserting
    // where each cell starts. Each id appears in exactly one run: a repeat would
    // mean two cells interleaved, a gap would mean one is unreachable.
    const rect = roomyRect();
    const rows = inventoryPanelRows(view({ tab: InventoryTab.Carried }));
    const placed = inventoryPanelGeometry(rect, rows).placed.find(
      (entry) => entry.row.kind === InventoryRowKind.Cells,
    );
    const first = placed?.cells[0];
    if (placed === undefined || first === undefined) throw new Error('unreachable');

    const seen: string[] = [];
    const y = first.y + Math.floor(first.h / 2);
    for (let x = rect.x; x < rect.x + rect.w; x += 1) {
      const hit = inventoryPanelHitAt(rect, rows, x, y);
      if (hit === null || hit.kind !== InventoryHitKind.Item) continue;
      if (seen[seen.length - 1] !== hit.itemId) seen.push(hit.itemId);
    }
    expect(seen).toEqual(['item_watchmans_coat', 'item_signet', 'item_locket', 'item_boots']);
  });

  it('answers the × in the header and nothing else up there', () => {
    const rect = roomyRect();
    const rows = inventoryPanelRows(view());
    const hits: number[] = [];
    for (let x = rect.x; x < rect.x + rect.w; x += 1) {
      if (inventoryPanelHitAt(rect, rows, x, rect.y + 6)?.kind === InventoryHitKind.Close) {
        hits.push(x);
      }
    }
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[hits.length - 1] ?? 0).toBe((hits[0] ?? 0) + hits.length - 1);
    expect(hits[0]).toBeGreaterThan(rect.x + Math.floor((rect.w * 3) / 4));
  });

  it('offers DROP for a carried item and for nothing else', () => {
    // ToME drops out of INVEN (`playerDrop`, Game.lua:2173-2176). Taking a worn
    // thing off is a separate act there and here, so a worn item and an empty slot
    // both answer no control at all rather than a greyed one — there is nothing to
    // teach about a button that would never apply.
    const rect = roomyRect();
    const dropFor = (focus: InventoryFocus | null) => {
      const rows = inventoryPanelRows(view({ tab: InventoryTab.Carried, focus }));
      const strip = inventoryPanelGeometry(rect, rows).placed.find(
        (entry) => entry.row.kind === InventoryRowKind.Detail,
      );
      return strip?.drop ?? null;
    };

    expect(dropFor(null)).toBeNull();
    expect(dropFor({ kind: 'slot', slot: 'legs' })).toBeNull();
    expect(dropFor({ kind: 'item', itemId: 'item_watchmans_cap' })).toBeNull();

    const box = dropFor({ kind: 'item', itemId: 'item_signet' });
    if (box === null) throw new Error('unreachable: a carried item can be dropped');
    const rows = inventoryPanelRows(
      view({ tab: InventoryTab.Carried, focus: { kind: 'item', itemId: 'item_signet' } }),
    );
    expect(
      inventoryPanelHitAt(rect, rows, box.x + Math.floor(box.w / 2), box.y + Math.floor(box.h / 2)),
    ).toEqual({ kind: InventoryHitKind.Drop, itemId: 'item_signet' });
  });

  it('answers null on the panel but off every control, which the caller swallows', () => {
    const rect = roomyRect();
    const rows = inventoryPanelRows(view());
    // The header strip, left of the ×.
    expect(inventoryPanelHitAt(rect, rows, rect.x + 2, rect.y + 6)).toBeNull();
    // ...and off the panel entirely.
    expect(inventoryPanelHitAt(rect, rows, rect.x - 4, rect.y - 4)).toBeNull();
  });

  it('turns a hit into the focus the strip is about, in ONE place', () => {
    expect(
      focusForHit({
        kind: InventoryHitKind.Item,
        itemId: 'item_signet',
        slot: 'ring',
        worn: false,
      }),
    ).toEqual({ kind: 'item', itemId: 'item_signet' });
    expect(focusForHit({ kind: InventoryHitKind.EmptySlot, slot: 'feet' })).toEqual({
      kind: 'slot',
      slot: 'feet',
    });
    // A tab, the ×, the DROP control and a miss are all "not about a thing", so
    // none of them may quietly change what the strip is describing.
    expect(focusForHit({ kind: InventoryHitKind.Tab, tab: InventoryTab.Carried })).toBeNull();
    expect(focusForHit({ kind: InventoryHitKind.Drop, itemId: 'item_signet' })).toBeNull();
    expect(focusForHit(null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// THE DROP POLICY — no scrolling, and it says so in words
// ---------------------------------------------------------------------------

describe('the drop policy', () => {
  it('drops whole cell rows from the tail and says how many went', () => {
    // ui/caselog.ts:467-478's rule. There is no scrollbar sprite, no drag state
    // machine and no scrolling surface in this client but the Case Log, so a
    // panel too short for its grid must say what it is not showing.
    const rect = { x: 0, y: 0, w: INVENTORY_PANEL_MIN_W, h: INVENTORY_PANEL_MIN_H + 20 };
    const rows = inventoryPanelRows(view());
    const placed = inventoryPanelGeometry(rect, rows).placed;
    const shown = placed
      .filter((entry) => entry.row.kind === InventoryRowKind.Cells)
      .flatMap((entry) => entry.cells);
    expect(shown.length).toBeLessThan(SLOT_ORDER.length);

    const note = placed.find(
      (entry) => entry.row.kind === InventoryRowKind.Note && entry.row.text.includes('hidden'),
    );
    expect(note).toBeDefined();
  });

  it('says when the comparison strip itself is the thing that did not fit', () => {
    // The easier of the two omissions to forget and the worse one to leave
    // silent: a panel that had quietly stopped comparing items looks exactly like
    // a panel whose comparison happens to be empty, and an empty comparison is a
    // real answer this frame can give.
    // Tall enough for both sentences and still too short for the strip. On a band
    // shorter even than this the sentences go too, which is talents.ts's own last
    // resort: a note that would be drawn over the hotbar is worse than no note.
    const tight = { x: 0, y: 0, w: INVENTORY_PANEL_MIN_W, h: INVENTORY_PANEL_MIN_H + 45 };
    const placed = inventoryPanelGeometry(tight, inventoryPanelRows(view())).placed;
    expect(placed.some((entry) => entry.row.kind === InventoryRowKind.Detail)).toBe(false);
    expect(
      placed.some(
        (entry) =>
          entry.row.kind === InventoryRowKind.Note && entry.row.text.includes('comparison'),
      ),
    ).toBe(true);

    // ...and it IS drawn when the panel is tall enough, so the note is not a
    // permanent excuse for a feature that never appears.
    const roomy = inventoryPanelGeometry(roomyRect(), inventoryPanelRows(view())).placed;
    expect(roomy.some((entry) => entry.row.kind === InventoryRowKind.Detail)).toBe(true);
  });

  it('never places a row below the panel’s own inner bottom', () => {
    for (const h of [140, 200, 260, 320, 373]) {
      const rect = { x: 0, y: 0, w: INVENTORY_PANEL_MIN_W, h };
      for (const placed of inventoryPanelGeometry(rect, inventoryPanelRows(view())).placed) {
        expect(placed.rect.y + placed.rect.h, `h=${String(h)}`).toBeLessThanOrEqual(
          rect.y + rect.h,
        );
      }
    }
  });

  it('reserves the strip from the RECT and never from the focus', () => {
    // ═══ THE ONE THAT STOPS THE GRID MOVING UNDER THE POINTER ═══
    // If the strip appeared when a cell was pointed at, the grid's remaining
    // height would shrink at that instant and the tail row would drop — so the
    // cell under the pointer could vanish BECAUSE it was pointed at, and pointing
    // at the row above would bring it back. Placement must depend on the panel's
    // size and on nothing else.
    for (const h of [140, 200, 260, 320, 373]) {
      const rect = { x: 0, y: 0, w: INVENTORY_PANEL_MIN_W, h };
      const cold = inventoryPanelGeometry(rect, inventoryPanelRows(view())).placed;
      const warm = inventoryPanelGeometry(
        rect,
        inventoryPanelRows(view({ focus: { kind: 'item', itemId: 'item_watchmans_cap' } })),
      ).placed;

      const cells = (placed: typeof cold) =>
        placed
          .filter((entry) => entry.row.kind === InventoryRowKind.Cells)
          .map((entry) => entry.rect);
      expect(cells(warm), `h=${String(h)}`).toEqual(cells(cold));
    }
  });
});

// ---------------------------------------------------------------------------
// THE COMPARISON STRIP — the server's answer, drawn and not computed
// ---------------------------------------------------------------------------

describe('the comparison strip', () => {
  it('carries the server’s rows VERBATIM and in the server’s order', () => {
    // ui/charsheet.ts:69-75 keeps the same contract for `InspectView.rows`, and
    // the order is already ToME's own: Object.lua:1280-1287 renders desc_wielder
    // as accuracy, armour penetration, physical crit, physical power, THEN armour,
    // hardiness, defence — attack first, then defence, each a signed delta.
    const row = detailOf(
      inventoryPanelRows(
        view({ tab: InventoryTab.Carried, focus: { kind: 'item', itemId: 'item_watchmans_coat' } }),
      ),
    );
    expect(row.rows).toEqual([
      { label: 'Armour', value: '+4' },
      { label: 'Hardiness', value: '+10%' },
    ]);
    expect(row.title).toBe("Watchman's Coat");
    expect(row.meta).toBe('rare · body');
    expect(row.hiddenRows).toBe(0);
  });

  it('draws an EMPTY comparison as blank rather than inventing a “no change” line', () => {
    // `CarriedItemView.compare` says an empty list is a real answer: armour below
    // the attacker's penetration measures as exactly zero (`max(0, armour - apr)`),
    // and two items that do the same thing compare to nothing.
    const row = detailOf(
      inventoryPanelRows(
        view({ tab: InventoryTab.Carried, focus: { kind: 'item', itemId: 'item_locket' } }),
      ),
    );
    expect(row.rows).toEqual([]);
    expect(row.title).toBe('Locket');
  });

  it('shows a whole prefix and says how many it held back when there are too many', () => {
    const many = [
      bagged('item_many', 'Many', ItemTier.Rare, 'body', [
        { label: 'Strength', value: '+3' },
        { label: 'Accuracy', value: '+3' },
        { label: 'Damage', value: '+2' },
        { label: 'Armour', value: '+4' },
        { label: 'Defence', value: '+1' },
        { label: 'Hardiness', value: '+10%' },
      ]),
    ];
    const row = detailOf(
      inventoryPanelRows(
        view({
          inventory: frame({ carried: many }),
          tab: InventoryTab.Carried,
          focus: { kind: 'item', itemId: 'item_many' },
        }),
      ),
    );
    // A PREFIX, never a sample: the rows shown are the first ones the server sent,
    // in its order, and the count of what is missing is said out loud.
    expect(row.rows.map((line) => line.label)).toEqual(['Strength', 'Accuracy', 'Damage']);
    expect(row.hiddenRows).toBe(3);
  });

  it('has no numbers at all for a WORN item, because the wire has none', () => {
    // `compare` lives on `CarriedItemView` and not on `ItemView`: "what would
    // change if I put this on" is meaningless for something already on. The panel
    // must not invent the answer.
    const row = detailOf(
      inventoryPanelRows(view({ focus: { kind: 'item', itemId: 'item_watchmans_cap' } })),
    );
    expect(row.rows).toEqual([]);
    expect(row.meta).toContain('worn');
    expect(row.dropId).toBeNull();
  });

  it('names an empty slot instead of leaving the strip blank', () => {
    const row = detailOf(inventoryPanelRows(view({ focus: { kind: 'slot', slot: 'offhand' } })));
    expect(row.title).toBe('offhand');
    expect(row.meta).toBe('empty');
  });

  it('falls back to the hint when the focused item has left the inventory', () => {
    // It was equipped, dropped, or taken by somebody else between the hover and
    // this frame. A stale name would be a panel describing something that is gone.
    const row = detailOf(
      inventoryPanelRows(view({ focus: { kind: 'item', itemId: 'item_that_went_away' } })),
    );
    expect(row.title).toBe('');
    expect(row.rows).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// THE ONE RULE A GREP CAN ENFORCE — this file may not do the arithmetic
// ---------------------------------------------------------------------------

describe('the panel computes nothing', () => {
  /**
   * CODE ONLY, COMMENTS STRIPPED, for test/client/assets.test.ts:176-180's reason:
   * the prose in this file NAMES the things it is forbidding, so a grep over the
   * raw text would fail on the warning rather than on the violation, and the
   * obvious fix — deleting the warning — is the wrong one.
   */
  const source = readFileSync(new URL('../../src/client/ui/inventory.ts', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  it('never imports the three shared modules that would let it', () => {
    // eslint blocks these already; this says WHY in a place a reader will look.
    // A second copy of a combat formula in the browser diverges the first time
    // either side is touched, and it reads to the player as rigged dice.
    expect(source).not.toContain('shared/checkhit');
    expect(source).not.toContain('shared/scale');
    expect(source).not.toContain('shared/energy');
  });

  it('never turns a formatted value back into a number', () => {
    // `rescaleCombatStats` FLOORS, so +3 Strength is worth a different number of
    // points of damage depending on where the total already sits. A browser doing
    // plain arithmetic would confidently promise something the server will not
    // deliver — which is worse than showing nothing.
    expect(source).not.toContain('parseInt');
    expect(source).not.toContain('parseFloat');
    expect(source).not.toMatch(/\bNumber\(/);
    // Nothing may be added to, subtracted from or multiplied by a wire value.
    expect(source).not.toMatch(/\.value\s*[-+*/]/);
    expect(source).not.toMatch(/[-+*/]\s*[\w.]*\.value\b/);
    expect(source).not.toMatch(/\.compare\s*[-+*/]/);
  });

  it('spends neither of the two reserved palette entries', () => {
    // CRIMSON means "hostiles are engaged" and nothing else; VIOLET_HI IS the
    // missing-asset box, so anything drawn in it is indistinguishable from a
    // broken manifest.
    expect(source).not.toContain('CRIMSON');
    expect(source).not.toContain('VIOLET_HI');
  });

  it('names every sprite id it asks for, and never assembles one', () => {
    // ToME mangles a name into a filename (Birther.lua:47-48) and survives a miss
    // because it ships `unknown_32_bg.png`. We ship none — client/public/assets/ is
    // gitignored wholesale — so a derived key resolves to the LOUD violet box.
    const args = [...source.matchAll(/sprites\.sprite\(([^)]*)\)/g)].map((m) =>
      (m[1] ?? '').trim(),
    );
    expect(args.length).toBeGreaterThan(0);
    for (const arg of args) {
      expect(arg, `assembles a sprite key: ${arg}`).not.toMatch(/[+`]/);
    }
  });
});

// ---------------------------------------------------------------------------
// THE FLOOR GLYPH — the other half of this feature, and the other thing a grep
// can enforce
// ---------------------------------------------------------------------------

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE MAP'S LOOT MARK ASKS FOR NO ART, AND THAT HAS TO BE PINNED RATHER THAN
 * COMMENTED
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * test/client/assets.test.ts:144-165 sets out the trap in full for `paintPath`
 * and `paintProjectiles`: adding a `MarkerKind` member and blitting
 * `ui_tile_marker_<it>` follows the shape of every other overlay in render/
 * canvas.ts and fails loudly for EVERYONE, because the id is in no manifest,
 * client/public/assets/ is gitignored wholesale so a bare clone has no manifest
 * at all, and `blitSprite` resolves a miss to the intentionally shouty violet
 * fallback box.
 *
 * `paintLoot` is the third overlay of that kind and it carries a SECOND
 * temptation the other two do not: the item's own 64x64 icon really is in the
 * manifest, and drawing it into a 32x32 tile means either a downscale (the exact
 * resampling the backbuffer exists to prevent) or a centre crop (a quarter of a
 * picture, identifying nothing).
 *
 * The pin lives here rather than beside its siblings because assets.test.ts is
 * outside this change's file list. It reads the same way: code only, comments
 * stripped, so a grep fails on the violation rather than on the warning that
 * names it.
 */
describe('the floor glyph stays art-free', () => {
  const canvasSrc = readFileSync(
    new URL('../../src/client/render/canvas.ts', import.meta.url),
    'utf8',
  )
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  const body = (() => {
    const from = canvasSrc.indexOf('function paintLoot(');
    const to = canvasSrc.indexOf('function paintProjectiles(');
    expect(from).toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);
    return canvasSrc.slice(from, to);
  })();

  it('paints a pile with fillRect and never with a sprite', () => {
    expect(body).not.toContain('blitSprite');
    expect(body).not.toContain('drawImage');
    // The 1px INK surround, the legibility trick the status pips and the orbs
    // both use: a pile sits on floor, beside a wall and under the lit top edge of
    // a wall, and without it the mark disappears against exactly one of them.
    expect(body).toContain('PALETTE.INK');
  });

  it('spends none of the four colours the map has already claimed', () => {
    // GOLD is the player's own route and cursor; ORANGE is the orb, and an orb
    // and a pile are the two things on the map that must never be confused —
    // one is arriving and one is waiting. CRIMSON means "hostiles are engaged".
    // VIOLET_HI IS the missing-asset box.
    for (const claimed of [
      'PALETTE.GOLD',
      'PALETTE.ORANGE',
      'PALETTE.CRIMSON',
      'PALETTE.VIOLET_HI',
    ]) {
      expect(body, `paintLoot spends ${claimed}`).not.toContain(claimed);
    }
  });

  it('encodes tier as SIZE as well as colour, so it survives greyscale', () => {
    // ui/partypanel.ts:78-92: never colour alone. A four-pixel mark on a 32-pixel
    // tile is at the limit of what a hue can carry, so the two encodings run in
    // the same direction and a rare drop is the biggest AND the brightest thing
    // on the floor.
    const sizes = /const LOOT_DOT_PX[^=]*=\s*\{([^}]*)\}/.exec(canvasSrc);
    const inks = /const LOOT_DOT_INK[^=]*=\s*\{([^}]*)\}/.exec(canvasSrc);
    expect(sizes).not.toBeNull();
    expect(inks).not.toBeNull();

    const tiers = Object.values(ItemTier);
    for (const tier of tiers) {
      expect(sizes?.[1] ?? '', `no size for ${tier}`).toContain(tier);
      expect(inks?.[1] ?? '', `no ink for ${tier}`).toContain(tier);
    }
    const numbers = [...(sizes?.[1] ?? '').matchAll(/:\s*(\d+)/g)].map((m) => Number(m[1]));
    expect(numbers).toHaveLength(tiers.length);
    // Strictly increasing, and every one small enough to leave the floor grid
    // countable — counting tiles is how a player measures a move.
    expect([...numbers].sort((a, b) => a - b)).toEqual(numbers);
    expect(new Set(numbers).size).toBe(numbers.length);
    for (const n of numbers) expect(n).toBeLessThan(16);
  });
});

// ---------------------------------------------------------------------------
// PAINTING — the strip's strings, and that the painter reads the same geometry
// ---------------------------------------------------------------------------

describe('drawing', () => {
  /**
   * The Proxy recorder from test/client/talents.test.ts:470-505, unchanged in
   * shape: `fillText`'s STRING is kept, not just the call's arity, because what
   * this panel has to be caught NOT doing is rewriting the server's numbers.
   *
   * `measureText` answers SIX PIXELS PER CHARACTER rather than a flat constant,
   * which is load-bearing: a constant width makes `fitText` truncate every string
   * it is given, so the recorded text would be an ellipsis and nothing could be
   * read back. Six is the advance of the 10px monospace every panel here draws
   * with.
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
              calls.push(`fillText(${String(rest.length + 1)})`);
            };
          if (prop === 'canvas') return undefined;
          return (...args: unknown[]) => {
            calls.push(`${prop}(${String(args.length)})`);
          };
        },
        set: () => true,
      },
    ) as unknown as CanvasRenderingContext2D;
  }

  function paint(panelView: InventoryPanelView, rect = roomyRect()) {
    const clips: { x: number; y: number; w: number; h: number }[] = [];
    const calls: string[] = [];
    const texts: string[] = [];
    drawInventoryPanel({
      ctx: recorder(clips, calls, texts),
      // NO ART AT ALL, which is the supported state of a fresh clone:
      // client/public/assets/ is gitignored wholesale, so the letter plates and
      // the traced frames are the only path and they run here.
      sprites: { sprite: () => undefined },
      rect,
      rows: inventoryPanelRows(panelView),
      hoveredClose: false,
      focus: panelView.focus,
      hovered: null,
      hoveredDrop: false,
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

  it('draws the server’s comparison rows verbatim, label and value alike', () => {
    const { texts } = paint(
      view({ tab: InventoryTab.Carried, focus: { kind: 'item', itemId: 'item_watchmans_coat' } }),
    );
    expect(texts).toContain('Armour');
    expect(texts).toContain('+4');
    expect(texts).toContain('Hardiness');
    // The percentage arrives already carrying its sign and its `%`. Nothing here
    // formats a number.
    expect(texts).toContain('+10%');
    expect(texts).toContain("Watchman's Coat");
    expect(texts).toContain('rare · body');
  });

  it('draws the catalogue’s own sentence, which is what that field exists for', () => {
    const { texts } = paint(
      view({ tab: InventoryTab.Carried, focus: { kind: 'item', itemId: 'item_boots' } }),
    );
    expect(texts).toContain('Boots, in the bag.');
  });

  it('says how to use the panel while nothing is pointed at, and stops once it is', () => {
    const quiet = paint(view());
    expect(quiet.texts.some((t) => t.includes('point at an item'))).toBe(true);

    const busy = paint(view({ focus: { kind: 'slot', slot: 'feet' } }));
    expect(busy.texts.some((t) => t.includes('point at an item'))).toBe(false);
  });

  it('marks the selected tab with brackets as well as with a colour, and counts both', () => {
    // ui/partypanel.ts:78-92: never colour alone. The count on the tab is also how
    // the bag says "four of twelve" without a thirteenth cell existing to say it.
    const { texts } = paint(view());
    expect(texts).toContain('[EQUIPPED 3/7]');
    expect(texts).toContain('CARRIED 4/12');

    const other = paint(view({ tab: InventoryTab.Carried }));
    expect(other.texts).toContain('EQUIPPED 3/7');
    expect(other.texts).toContain('[CARRIED 4/12]');
  });

  it('draws the DROP control for a carried item and not for a worn one', () => {
    const carried = paint(
      view({ tab: InventoryTab.Carried, focus: { kind: 'item', itemId: 'item_signet' } }),
    );
    expect(carried.texts).toContain('DROP');

    const wornFocus = paint(view({ focus: { kind: 'item', itemId: 'item_watchmans_cap' } }));
    expect(wornFocus.texts).not.toContain('DROP');
  });

  it('falls back to a LETTER inside a cell rather than to the violet error box', () => {
    // ui/hotbar.ts:193-201's rule: twelve identical violet squares would make the
    // panel unreadable, and on a clone with no art at all that is the ONLY state.
    const { texts } = paint(view({ tab: InventoryTab.Carried }));
    for (const initial of ['W', 'S', 'L', 'B']) expect(texts).toContain(initial);
  });

  it('still paints, and still clips, in a panel too small for the whole grid', () => {
    const rect = { x: 4, y: 4, w: INVENTORY_PANEL_MIN_W, h: INVENTORY_PANEL_MIN_H + 20 };
    const { clips, texts } = paint(view(), rect);
    expect(clips[0]).toEqual(rect);
    expect(texts.some((t) => t.includes('hidden'))).toBe(true);
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE ONE WIRE THAT CANNOT BE DRIVEN: `case 'inventory'` MUST INVALIDATE THE
 * CHARACTER SHEET'S CACHE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * src/client/main.ts CANNOT BE IMPORTED — it calls `boot()` at module load and
 * reaches for `document`, the Discord SDK and a WebSocket, and vitest.config.ts
 * is emphatic that there is no jsdom and no mocked SDK. test/client/travelwiring.ts
 * states the rule that follows: anything assertable belongs in a pure module.
 * This one is not assertable anywhere else, because the thing being asserted IS
 * a line in an event handler inside `boot()`'s closure — so it is pinned the way
 * assets.test.ts pins main.ts's asset prefixes, by reading the source.
 *
 * THE CASE BLOCK IS CUT OUT OF THE RAW FILE FIRST AND ONLY THEN STRIPPED of its
 * own line comments — deliberately NOT the whole-file strip the two blocks above
 * do, which is unsafe on this file and silently so. main.ts contains the eslint
 * path glob `src/client/` + two stars inside an ordinary line comment; a
 * block-comment regex run over the whole file reads those two characters as the
 * START of a comment and swallows everything up to the next real docblock's
 * close. The marker search then lands hundreds of lines away and the test passes
 * or fails on text nobody meant to assert. Cutting first means the only text
 * ever regexed is the twenty lines under test.
 *
 * ═══ WHAT BREAKS WITHOUT IT — TRAP 1, EXACTLY AS A PLAYER MEETS IT ═══
 * `inspectCache` is cleared in exactly one other place, `case 'turn'`, and only
 * on a game-turn EDGE. A loot verb does spend the sender's turn server-side, so
 * usually the clock moves and that edge arrives — but `tickLevel` returns
 * `parked` without advancing anything while another player still owes a
 * decision. Measured: two players, engagement up, one blocking; the other
 * equips, pays the turn (energy 1000 -> 0) and the clock does not move (tick 20,
 * gameTurn 2, before and after). `broadcastTurnIfChanged` then suppresses the
 * frame as a duplicate, so the sheet goes on printing the armour the player had
 * before they got dressed, and re-opening the panel does not help —
 * `requestSelfSheet` early-returns on an entry stamped with the current turn.
 * The DELETE is what makes the re-ask do anything, which is why the ORDER of the
 * two calls is asserted and not just their presence.
 */
describe('the inventory frame re-asks for the character sheet', () => {
  const mainSrc = readFileSync(new URL('../../src/client/main.ts', import.meta.url), 'utf8');

  const body = (() => {
    const from = mainSrc.indexOf("case 'inventory':");
    expect(from).toBeGreaterThan(-1);
    const to = mainSrc.indexOf("case 'party':", from);
    expect(to).toBeGreaterThan(from);
    // Comments stripped from the CUT, never from the file. See the header.
    return mainSrc.slice(from, to).replace(/^\s*\/\/.*$/gm, '');
  })();

  it('deletes the viewer own cache entry and THEN re-asks, in that order', () => {
    const deleted = body.indexOf('inspectCache.delete(selfId)');
    const reasked = body.indexOf('refreshSelfSheet()');
    expect(deleted).toBeGreaterThan(-1);
    expect(reasked).toBeGreaterThan(-1);
    // THE ORDER IS THE FIX. Re-asking against a live entry sends nothing at all.
    expect(deleted).toBeLessThan(reasked);
  });

  it('refreshes a card pinned to the viewer own body on the same frame', () => {
    // `tooltipView()` consults the pin BEFORE the cache, so clearing the cache
    // alone leaves a self-pinned card quoting the old armour indefinitely — the
    // identical shadowing bug the game-turn edge already had to fix once.
    expect(body).toContain('pinnedInspectId === selfId');
    expect(body).toContain('refreshPinnedInspect()');
  });
});
