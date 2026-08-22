/// <reference lib="dom" />

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { DragKind, DraggablePanel } from '../../src/client/ui/drag.ts';
import {
  INVENTORY_DRAG_PANEL,
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
  inventoryPanelDragAt,
  inventoryPanelGeometry,
  inventoryPanelHitAt,
  inventoryPanelRect,
  inventoryPanelRows,
  hasSomethingToBuy,
  hasSomethingToWear,
  inventoryTipAt,
} from '../../src/client/ui/inventory.ts';
import { ITEMS } from '../../src/server/content/items.ts';
import { ItemTier, SLOT_ORDER } from '../../src/shared/protocol.ts';
import { INVENTORY_CAP } from '../../src/shared/progression.ts';
import { PROTOCOL_VERSION } from '../../src/shared/version.ts';
import type { SpriteSource } from '../../src/client/render/assets.ts';
import type {
  InventoryFocus,
  InventoryPanelView,
  InventoryRow,
} from '../../src/client/ui/inventory.ts';
import type {
  CarriedItemView,
  InventoryMsg,
  ItemView,
  ShopItemView,
  Slot,
} from '../../src/shared/protocol.ts';

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
 *                   and 320 - 16 of inset holds exactly four of them. Twelve
 *                   carried are three flat rows; the seven worn slots are a DOLL,
 *                   placed at their own (col, row) on a 4x3 grid around a
 *                   portrait, and the arrangement is asserted position by
 *                   position because it is the one thing about this screen that
 *                   is a decision rather than arithmetic.
 *   THE BUDGET      three doll rows plus a one-line strip fits the panel at the
 *                   480-pixel logical height render/canvas.ts floors at, and a
 *                   fourth row does not. If that ever stops being true the
 *                   existing drop policy resolves it SILENTLY, by shedding the
 *                   FEET slot off the bottom of the doll.
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
    money: 0,
    ...over,
  };
}

function view(over: Partial<InventoryPanelView> = {}): InventoryPanelView {
  return { inventory: frame(), tab: InventoryTab.Equipped, focus: null, ...over };
}

/**
 * Every row that holds cells, in reading order — the BAG's flat rows and the
 * DOLL's placed grid alike. Both carry `cells`; only the doll carries `places`.
 */
function cellRows(rows: readonly InventoryRow[]) {
  return rows.flatMap((row) =>
    row.kind === InventoryRowKind.Cells || row.kind === InventoryRowKind.Doll ? [row] : [],
  );
}

/** The doll row, or a throw. There is exactly one on the Equipped tab. */
function dollOf(rows: readonly InventoryRow[]) {
  const row = rows.find((entry) => entry.kind === InventoryRowKind.Doll);
  if (row === undefined || row.kind !== InventoryRowKind.Doll) {
    throw new Error('unreachable: the Equipped tab is a doll');
  }
  return row;
}

function detailOf(rows: readonly InventoryRow[]) {
  const row = rows.find((entry) => entry.kind === InventoryRowKind.Detail);
  if (row === undefined || row.kind !== InventoryRowKind.Detail) {
    throw new Error('unreachable: every panel carries a detail row');
  }
  return row;
}

type Box = { readonly x: number; readonly y: number; readonly w: number; readonly h: number };

/**
 * Do two placed boxes share a pixel?
 *
 * THROWS on a missing box rather than answering false. A doll cell that was never
 * placed would otherwise make every overlap assertion pass by vacuity, which is
 * the failure mode a geometry test can least afford.
 */
function overlaps(a: Box | null | undefined, b: Box | null | undefined): boolean {
  if (a === null || a === undefined || b === null || b === undefined) {
    throw new Error('unreachable: both boxes must have been placed');
  }
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** A band that comfortably holds the whole panel, strip included. */
const ROOMY = { width: 800, height: 800, top: 20, bottom: 700 };

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT THE PANEL DOES AT THE FLOOR — which is not what its own comments said.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `DOLL_ROWS`' budget was worked out "against the 480-pixel floor", and the
 * doll's shed-a-row branch called itself "unreachable at any viewport this
 * client renders". The floor is 320: `DEFAULT_VIEWPORT` is `tilesH: 10` and
 * `minLogicalH = tilesH * TILE_PX`. Three doll rows are 226 pixels plus 58 of
 * panel chrome against a band of about 183, so the branch is the ORDINARY case
 * on the smallest window.
 *
 * These cases exist because a comment cannot be run. Both halves are asserted —
 * that the smallest window sheds AND that the real device size does not — so
 * neither a layout change that quietly breaks 768x384 nor a comment that drifts
 * back to 480 can pass unnoticed.
 */
describe('the paper doll at the sizes this client actually renders', () => {
  /** 20x10 tiles at TILE_PX 32 — the smallest logical backbuffer there is. */
  const FLOOR_W = 640;
  const FLOOR_H = 320;
  /** What a 1538x769 device lands on, and the size the char sheet is tuned to. */
  const REAL_W = 768;
  const REAL_H = 384;

  function notesAt(w: number, h: number): readonly string[] {
    const rect = inventoryPanelRect({ width: w, height: h, top: 20, bottom: h - 40 });
    if (rect === null) throw new Error(`no panel at ${String(w)}x${String(h)}`);
    const geometry = inventoryPanelGeometry(rect, inventoryPanelRows(view()));
    return geometry.placed.flatMap((entry) =>
      entry.row.kind === InventoryRowKind.Note ? [entry.row.text] : [],
    );
  }

  it('sheds doll slots on the smallest window, and says how many', () => {
    const notes = notesAt(FLOOR_W, FLOOR_H);
    const hidden = notes.filter((note) => note.includes('hidden'));
    expect(
      hidden,
      'the floor stopped shedding — if that is a fix, DOLL_ROWS’ budget needs re-running',
    ).not.toEqual([]);
    // AND IT COUNTS THEM. A bare "some hidden" would leave a player unable to
    // tell one missing slot from three.
    for (const note of hidden) expect(note).toMatch(/^\d+ hidden/);
  });

  it('shows the whole doll at the size a real device renders', () => {
    expect(
      notesAt(REAL_W, REAL_H).filter((note) => note.includes('hidden')),
      'the doll is now shedding at 768x384, which no player should ever see',
    ).toEqual([]);
  });
});

function roomyRect() {
  const rect = inventoryPanelRect(ROOMY);
  if (rect === null) throw new Error('unreachable: the roomy band must hold a panel');
  return rect;
}

// ---------------------------------------------------------------------------
// THE ROWS — the doll's order, the bag's order, and the grid's shape
// ---------------------------------------------------------------------------

describe('knowing when to point at the bag', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE ONLY PANEL WHOSE KEY THE GAME NEVER NAMED.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * MEASURED across the client: `show_talents` is named to the player twice,
   * `revive` and `respawn` once each, `show_inventory` **nowhere**. The server
   * nudges on pickup — *"Nothing on your back yet."* — and that nudge is
   * deliberately an observation rather than a tutorial, but it is the only one
   * of the four that can be followed and not acted on. A scripted first session
   * ends with a coat in the bag and nothing worn.
   *
   * The talent line's own comment states the rule this borrows: a banked point
   * *"was invisible to anybody who did not already know to go looking for it"*,
   * and the tree is *"dead content for a party that never presses `g`"*.
   */
  const item = (over: Partial<CarriedItemView> & { itemId: string }): CarriedItemView => ({
    name: 'Thing',
    icon: 'icon',
    tier: ItemTier.Common,
    desc: '',
    // REQUIRED ON `CarriedItemView`, so a `Partial<>` spread cannot supply it.
    // The predicate never reads it; the type does.
    compare: [],
    ...over,
  });
  /** One worn piece, typed — a bare literal widens `tier` to `string`. */
  const worn = (itemId: string): ItemView => ({
    itemId,
    name: itemId,
    icon: 'i',
    tier: ItemTier.Common,
    desc: '',
  });

  it('points at the bag when a bare slot has something for it', () => {
    expect(hasSomethingToWear([item({ itemId: 'coat', slot: 'body' })], {})).toBe(true);
  });

  it('says nothing once that slot is filled', () => {
    // The line is persistent rather than an event, so it has to go away by
    // itself the moment the player acts — otherwise it is a nag.
    expect(
      hasSomethingToWear([item({ itemId: 'coat', slot: 'body' })], { body: worn('coat') }),
    ).toBe(false);
  });

  it('says nothing about a draught, which has no slot at all', () => {
    /**
     * THE CASE THAT WOULD HAVE MADE IT A NAG. A draught is carried, useful, and
     * not something the doll has a place for — and the first thing a player
     * buys, measured, is a Draught of Mending. Without this a shopper is told to
     * go and get dressed for the rest of the session.
     */
    expect(hasSomethingToWear([item({ itemId: 'draught' })], {})).toBe(false);
  });

  it('finds the one wearable thing in a bag full of things that are not', () => {
    // `some`, not `[0]`: the wearable item is rarely the first one in the bag by
    // the time anybody has been shopping.
    const bag = [
      item({ itemId: 'draught' }),
      item({ itemId: 'curio' }),
      item({ itemId: 'cap', slot: 'head' }),
    ];
    expect(hasSomethingToWear(bag, {})).toBe(true);
    // ...and honours a filled slot even when it is not the first entry either.
    expect(hasSomethingToWear(bag, { head: worn('cap') })).toBe(false);
  });
});

describe('hasSomethingToBuy', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE SHOP WAS IN THE STATE THE BAG HAD BEEN IN.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `hasSomethingToWear` above exists because `show_inventory` was named to the
   * player NOWHERE. It fixed the bag — and the shop lives in a TAB of that same
   * panel, behind that same key, and was left exactly as it was. A player walks
   * into Threadneedle Row, reads "somebody behind every counter who will take
   * your gold", and nothing ever says which key opens the counter.
   *
   * IT ASKS ABOUT AFFORDABILITY, NOT PRESENCE. "You are in a shop" is true for
   * as long as you stand in the town, and this file's neighbours are explicit
   * that a line which is always there becomes furniture. This one can be acted
   * on and then goes quiet.
   */
  const onSale = (itemId: string, buy: number): ShopItemView => ({
    itemId,
    name: itemId,
    icon: `icon_${itemId}`,
    tier: 'common',
    buy,
    sell: Math.floor(buy / 20),
  });

  it('points at the counter when the purse covers something on it', () => {
    // The measured opening: 15 gold, and a Draught of Mending at 14.
    expect(hasSomethingToBuy([onSale('draught', 14)], 15)).toBe(true);
  });

  it('says nothing in a shop that has nothing for this purse', () => {
    /**
     * A REAL STATE AND A MEASURED ONE. Over 400 rolled shelves at level 1 the
     * Outfitter's cheapest item is 24g against a 15g purse — 0% buyable — while
     * the Apothecary is 100%. So a fresh character is pointed at Ashwick and
     * left in peace at Threadneedle, which is the correct advice in both places.
     */
    expect(hasSomethingToBuy([onSale('oxfords', 24), onSale('slacks', 46)], 15)).toBe(false);
  });

  it('counts an exact match, because a purse that covers it can spend it', () => {
    expect(hasSomethingToBuy([onSale('draught', 15)], 15)).toBe(true);
  });

  it('says nothing about an empty shelf', () => {
    expect(hasSomethingToBuy([], 999)).toBe(false);
  });
});

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

  it('places the seven slots as a DOLL, at the four-by-three positions it claims', () => {
    // ═══ THE REPLACEMENT FOR "seven worn slots into two rows" ═══
    // That assertion was true of a flat grid and is false by construction now: the
    // doll is ONE row carrying its own (col, row) per cell, because a paper doll's
    // whole job is to say WHERE on a body a thing goes. Upstream places every frame
    // at an absolute x/y (EquipDoll.lua:171-212 over the table at load.lua:140-156)
    // for the same reason.
    //
    // The positions are spelled out here rather than imported, deliberately: this
    // is the ONE place the arrangement is stated as an intention rather than as
    // code, so moving a slot on the doll has to be a decision somebody takes twice.
    // Left column is held-and-worn tokens (load.lua:144-147, x=48); right column is
    // the armour spine head-to-legs (load.lua:150-153, x=264); FEET closes the
    // bottom row under the portrait (load.lua:147-149, y=408).
    const doll = dollOf(inventoryPanelRows(view()));
    expect(doll.cells.map((cell) => cell.slot)).toEqual([...SLOT_ORDER]);
    expect(doll.places).toHaveLength(doll.cells.length);

    const at = new Map(doll.cells.map((cell, i) => [cell.slot, doll.places[i]]));
    expect(at.get('offhand')).toEqual({ col: 0, row: 0 });
    expect(at.get('ring')).toEqual({ col: 0, row: 1 });
    expect(at.get('trinket')).toEqual({ col: 0, row: 2 });
    expect(at.get('feet')).toEqual({ col: 1, row: 2 });
    // DEVIATION, AND THE TEST NAMES IT: upstream's HEAD is top-CENTRE over the
    // figure (load.lua:155, `x=150, y=35`). Ours is the top of the armour column,
    // because three rows have no spare top-centre row.
    expect(at.get('head')).toEqual({ col: 3, row: 0 });
    expect(at.get('body')).toEqual({ col: 3, row: 1 });
    expect(at.get('legs')).toEqual({ col: 3, row: 2 });

    // NO TWO CELLS SHARE A BOX, and the PORTRAIT overlaps none of them. A doll
    // whose cells overlapped would hand two slots to one click; a portrait over a
    // cell would put a picture where a place is.
    const rect = roomyRect();
    const placed = inventoryPanelGeometry(rect, inventoryPanelRows(view())).placed.find(
      (entry) => entry.row.kind === InventoryRowKind.Doll,
    );
    if (placed === undefined) throw new Error('unreachable');
    const boxes = placed.cells;
    expect(boxes).toHaveLength(SLOT_ORDER.length);
    for (const box of boxes) expect(box.w).toBeGreaterThan(0);
    for (let i = 0; i < boxes.length; i += 1) {
      for (let j = i + 1; j < boxes.length; j += 1) {
        expect(overlaps(boxes[i], boxes[j]), `${String(i)} overlaps ${String(j)}`).toBe(false);
      }
    }
    expect(placed.portrait).not.toBeNull();
    for (const box of boxes) {
      expect(overlaps(placed.portrait, box), 'portrait overlaps a cell').toBe(false);
    }
  });

  it('shows every item the RULES let a body carry, not a number of its own', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE PANEL WAS HOLDING A COPY OF A SERVER RULE, SPELLED AS FURNITURE.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `CARRIED_MAX` was `COLS * 3` — four grid columns times three grid rows —
     * under a comment reading "IT IS THE SERVER'S CAP, RESTATED, NOT A SECOND
     * OPINION". It equalled twelve by coincidence of LAYOUT, and the panel draws
     * it to the player as `CARRIED 5/12`.
     *
     * So re-flowing the grid for any purely visual reason would have changed
     * what the game told a player their capacity was, silently — the rule
     * untouched, nothing failing. The cap could not be imported because it lived
     * in `net/gateway.ts`, which client code may not reach; it is in
     * `shared/progression.ts` now and both sides read it.
     *
     * THIS IS THE ASSERTION THAT KEEPS THEM TOGETHER. Not "the panel shows 12"
     * — that is the copy again, one layer out — but that the panel shows exactly
     * what the RULE allows, whatever the rule becomes.
     */
    expect(INVENTORY_PANEL_CARRIED_MAX).toBe(INVENTORY_CAP);

    // AND THE GRID IS BIG ENOUGH FOR IT. If the rows ever stop covering the cap,
    // `carriedCells` truncates and the panel prints "N more carried" for a state
    // the rules call ordinary — which is the "unreachable in ordinary play"
    // claim the test below is built on.
    const full = Array.from({ length: INVENTORY_CAP }, (_v, i) =>
      bagged(`cap_${String(i)}`, `Thing ${String(i)}`, ItemTier.Common, 'ring'),
    );
    const shown = cellRows(
      inventoryPanelRows(view({ inventory: frame({ carried: full }), tab: InventoryTab.Carried })),
    ).reduce((n, row) => n + row.cells.length, 0);
    expect(shown, 'the grid cannot show a legal full bag').toBe(INVENTORY_CAP);
  });

  it('still lays twelve carried into three flat rows of four', () => {
    // FOUR COLUMNS, EXACTLY: 320 - 2x8 of inset is 304, and four 72-pixel frames
    // with three 5-pixel gaps is 303. Nothing else fits and nothing narrower is
    // offered, because a column is the size of a PNG. The BAG is still a reading
    // order — twelve is a cap rather than a shape, so there is nowhere for a bag
    // item to belong the way a boot belongs on a foot.
    expect(INVENTORY_PANEL_COLS).toBe(4);

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

    // ═══ THE CONTENT IS IDENTICAL; ONLY THE RESERVED HEIGHT IS NOT ═══
    // `compact` is deliberately excluded from the comparison, and that exclusion
    // is the point rather than a loophole: the Equipped tab reserves ONE LINE for
    // the strip because `compare` exists only on `CarriedItemView`
    // (protocol.ts:1390-1403) and a worn item is handed `rows: []`, so the other
    // six lines would be reserved for content the doll tab cannot produce. What
    // the strip SAYS still has to be one answer to one question on both tabs, or
    // the two halves are two panels wearing one header.
    const stripBody = (rows: readonly InventoryRow[]) =>
      rows
        .filter(
          (row) =>
            row.kind !== InventoryRowKind.Cells &&
            row.kind !== InventoryRowKind.Doll &&
            row.kind !== InventoryRowKind.Tabs,
        )
        .map((row) => (row.kind === InventoryRowKind.Detail ? { ...row, compact: null } : row));
    expect(stripBody(carried)).toEqual(stripBody(equipped));
    expect(detailOf(equipped).compact).toBe(true);
    expect(detailOf(carried).compact).toBe(false);

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
          const row = placed.row;
          if (row.kind !== InventoryRowKind.Cells && row.kind !== InventoryRowKind.Doll) continue;
          let walked = 0;
          for (let i = 0; i < placed.cells.length; i += 1) {
            const box = placed.cells[i];
            const cell = row.cells[i];
            if (box === undefined || cell === undefined) throw new Error('unreachable');
            // A shed doll cell keeps its index and takes a zero-sized box. There
            // is no centre to walk and nothing drawn to click.
            if (box.w === 0) continue;
            walked += 1;
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
          // ═══ AND EVERY DOLL CELL IS REACHABLE AT EVERY ONE OF THESE SIZES ═══
          // Without this, a doll that placed nothing would pass the loop above
          // vacuously — which is precisely the shape of the bug being hunted, a
          // painter and a hit test that agree about a cell neither of them drew.
          if (row.kind === InventoryRowKind.Doll) expect(walked).toBe(SLOT_ORDER.length);
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
      const row = placed.row;
      if (row.kind !== InventoryRowKind.Cells && row.kind !== InventoryRowKind.Doll) continue;
      for (let i = 0; i < placed.cells.length; i += 1) {
        const box = placed.cells[i];
        const cell = row.cells[i];
        if (box === undefined || cell === undefined || box.w === 0) continue;
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
    ).toEqual({ kind: InventoryHitKind.Drop, itemId: 'item_signet', enabled: true });
  });

  it('answers null on the panel but off every control, which the caller swallows', () => {
    const rect = roomyRect();
    const rows = inventoryPanelRows(view());
    // The header strip, left of the ×. A CLICK there means nothing — it is the
    // drag handle, and only the press reader has an answer for it.
    expect(inventoryPanelHitAt(rect, rows, rect.x + 2, rect.y + 6)).toBeNull();
    // ON the panel, beside the tab strip but left of the first tab box — the tabs
    // start one INSET in and the panel body starts at the rect's own edge.
    expect(inventoryPanelHitAt(rect, rows, rect.x + 2, rect.y + 30)).toBeNull();
    // The bottom-middle box of the doll: FOUR COLUMNS BY THREE ROWS holds twelve
    // and seven slots plus a two-by-two portrait leave one over. It is not a slot
    // and must not answer like one.
    const doll = inventoryPanelGeometry(rect, rows).placed.find(
      (entry) => entry.row.kind === InventoryRowKind.Doll,
    );
    if (doll === undefined || doll.row.kind !== InventoryRowKind.Doll) {
      throw new Error('unreachable');
    }
    const portrait = doll.portrait;
    if (portrait === null) throw new Error('unreachable: the doll carries a portrait');
    // DERIVED FROM THE PLACED BOXES, never re-typed: the spare sits in the FEET
    // row and in the portrait's right-hand column, so its two coordinates come
    // from two boxes that were actually placed. Spelling out `72 * 2 + 5 * 2`
    // here would be a second copy of the grid, which is the bug this whole
    // describe block exists to catch.
    const feet = doll.cells[doll.row.cells.findIndex((cell) => cell.slot === 'feet')];
    if (feet === undefined) throw new Error('unreachable: FEET is on the doll');
    expect(inventoryPanelHitAt(rect, rows, portrait.x + portrait.w - 4, feet.y + 4)).toBeNull();
    // ...and off the panel entirely.
    expect(inventoryPanelHitAt(rect, rows, rect.x - 4, rect.y - 4)).toBeNull();
  });

  it('splits the title bar into a handle and a ×, with the × winning where they meet', () => {
    // The header strip is the DRAG HANDLE (ui/panel.ts's `headerDragRect`) and the
    // close control is carved out of its right end. Both facts have to hold at
    // once: a title bar that were grabbable everywhere would start a drag when you
    // pressed ×, and then close the panel on mouseup having moved it first.
    //
    // TWO READERS, ONE STRIP. The CLICK reader says Close-or-nothing; the PRESS
    // reader says Header-or-nothing over the same pixels. That split is not
    // cosmetic — `InventoryHit` is consumed by an exhaustive `switch` in main.ts,
    // so a click outcome added here is a compile error in a file this panel does
    // not own, for an outcome the click path has nothing to do with.
    const rect = roomyRect();
    const rows = inventoryPanelRows(view());

    const runsOf = (read: (x: number) => string | null) => {
      const runs: (string | null)[] = [];
      for (let x = rect.x; x < rect.x + rect.w; x += 1) {
        const kind = read(x);
        if (runs.length === 0 || runs[runs.length - 1] !== kind) runs.push(kind);
      }
      return runs;
    };

    // A scan rather than a coordinate, for the reason the file header gives: one
    // contiguous run each, in this order, and nothing else along the strip.
    expect(runsOf((x) => inventoryPanelDragAt(rect, rows, x, rect.y + 6)?.kind ?? null)).toEqual([
      InventoryHitKind.Header,
      null,
    ]);
    expect(runsOf((x) => inventoryPanelHitAt(rect, rows, x, rect.y + 6)?.kind ?? null)).toEqual([
      null,
      InventoryHitKind.Close,
      null,
    ]);
  });

  it('starts a drag from a filled cell and from the header, and from nothing else', () => {
    // ═══ A CLICK AND A PRESS-THAT-TRAVELS ARE DIFFERENT ACTS ON ONE PIXEL ═══
    // Clicking a bag cell equips what is in it; dragging it picks it up. Two
    // readers over ONE geometry is how both answers stay true at once — a second
    // copy of the arithmetic is the bug ui/partypanel.ts:93-99 records.
    const rect = roomyRect();

    const worn = inventoryPanelRows(view());
    const dollPlaced = inventoryPanelGeometry(rect, worn).placed.find(
      (entry) => entry.row.kind === InventoryRowKind.Doll,
    );
    if (dollPlaced === undefined || dollPlaced.row.kind !== InventoryRowKind.Doll) {
      throw new Error('unreachable');
    }
    const centreOf = (i: number) => {
      const box = dollPlaced.cells[i];
      if (box === undefined || box.w === 0) throw new Error('unreachable');
      return { x: box.x + Math.floor(box.w / 2), y: box.y + Math.floor(box.h / 2) };
    };

    // A WORN item is named by its SLOT, because taking it off sends
    // `unequip { slot }` (protocol.ts:1949 takes `z.enum(SLOT_ORDER)`).
    const head = centreOf(dollPlaced.row.cells.findIndex((cell) => cell.slot === 'head'));
    expect(inventoryPanelDragAt(rect, worn, head.x, head.y)).toEqual({
      kind: InventoryHitKind.DragStart,
      subject: { kind: DragKind.Worn, slot: 'head' },
    });

    // AN EMPTY SLOT IS NOT A DRAG SOURCE. There is nothing in it to pick up, and a
    // gesture carrying nothing either does nothing on release or invents a subject.
    const legs = centreOf(dollPlaced.row.cells.findIndex((cell) => cell.slot === 'legs'));
    expect(inventoryPanelDragAt(rect, worn, legs.x, legs.y)).toBeNull();

    // A CARRIED item is named by its `itemId`, because putting it on sends
    // `equip { itemId }` (protocol.ts:1905-1909). The verb differs and the
    // identifier differs, which is why they are two DragKinds and not one with a
    // flag (ui/drag.ts's `DragSubject`).
    const bag = inventoryPanelRows(view({ tab: InventoryTab.Carried }));
    const bagPlaced = inventoryPanelGeometry(rect, bag).placed.find(
      (entry) => entry.row.kind === InventoryRowKind.Cells,
    );
    const first = bagPlaced?.cells[0];
    if (first === undefined) throw new Error('unreachable');
    expect(inventoryPanelDragAt(rect, bag, first.x + Math.floor(first.w / 2), first.y + 4)).toEqual(
      {
        kind: InventoryHitKind.DragStart,
        subject: { kind: DragKind.Carried, itemId: 'item_watchmans_coat' },
      },
    );

    // THE HANDLE, and the × explicitly refused: pressing × and twitching must
    // close the panel, not move it.
    expect(inventoryPanelDragAt(rect, worn, rect.x + 4, rect.y + 6)).toEqual({
      kind: InventoryHitKind.Header,
    });
    const close = inventoryPanelHitAt(rect, worn, rect.x + rect.w - 8, rect.y + 6);
    expect(close?.kind).toBe(InventoryHitKind.Close);
    expect(inventoryPanelDragAt(rect, worn, rect.x + rect.w - 8, rect.y + 6)).toBeNull();

    // The handle is the panel the offset store is keyed by, spelled once.
    expect(INVENTORY_DRAG_PANEL).toBe(DraggablePanel.Inventory);
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
    expect(
      focusForHit({ kind: InventoryHitKind.Drop, itemId: 'item_signet', enabled: true }),
    ).toBeNull();
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
    // A SHED DOLL CELL KEEPS ITS INDEX AND TAKES A ZERO-SIZED BOX, so what was
    // shown is counted by the boxes that have a size rather than by the length of
    // the array. The parallel between `placed.cells[i]` and `row.cells[i]` is what
    // the hit test depends on, and splicing to make the count easier here would
    // break it there.
    const shown = placed
      .filter(
        (entry) =>
          entry.row.kind === InventoryRowKind.Cells || entry.row.kind === InventoryRowKind.Doll,
      )
      .flatMap((entry) => entry.cells)
      .filter((box) => box.w > 0);
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
    //
    // RE-BASED ONTO THE CARRIED TAB, and the re-basing is itself the point: this
    // panel is now too short for the BAG's seven-line strip and comfortably tall
    // enough for the DOLL's one-line one. Asserting both here is what makes the
    // per-tab reservation a tested property rather than a comment.
    const tight = { x: 0, y: 0, w: INVENTORY_PANEL_MIN_W, h: INVENTORY_PANEL_MIN_H + 45 };
    const placed = inventoryPanelGeometry(
      tight,
      inventoryPanelRows(view({ tab: InventoryTab.Carried })),
    ).placed;
    expect(placed.some((entry) => entry.row.kind === InventoryRowKind.Detail)).toBe(false);
    expect(
      placed.some(
        (entry) =>
          entry.row.kind === InventoryRowKind.Note && entry.row.text.includes('comparison'),
      ),
    ).toBe(true);

    const sameRect = inventoryPanelGeometry(tight, inventoryPanelRows(view())).placed;
    expect(sameRect.some((entry) => entry.row.kind === InventoryRowKind.Detail)).toBe(true);

    // ...and it IS drawn when the panel is tall enough, so the note is not a
    // permanent excuse for a feature that never appears.
    const roomy = inventoryPanelGeometry(
      roomyRect(),
      inventoryPanelRows(view({ tab: InventoryTab.Carried })),
    ).placed;
    expect(roomy.some((entry) => entry.row.kind === InventoryRowKind.Detail)).toBe(true);
  });

  it('reserves one line on the doll and eight in the bag, on a rect that never moves', () => {
    // ═══ THE PANEL RECT MUST NOT CHANGE WHEN THE TAB DOES ═══
    // `inventoryPanelRect` never sees a tab, and that is deliberate: if the panel
    // resized on a tab switch, the click that switched it would land on a panel
    // that had already moved out from under the pointer — the same class of bug as
    // reserving the strip from the focus, one control further out.
    const rect = roomyRect();
    const stripOf = (tab: InventoryTab) => {
      const placed = inventoryPanelGeometry(rect, inventoryPanelRows(view({ tab }))).placed.find(
        (entry) => entry.row.kind === InventoryRowKind.Detail,
      );
      if (placed === undefined) throw new Error('unreachable');
      return placed.rect;
    };

    // ONE LINE against EIGHT — SEVEN until the description was given its second
    // line. The numbers are the file's own `ROW_H` and
    // `ROW_H * (2 + DESC_LINES + DETAIL_ROWS_MAX)`; what is asserted is the RATIO
    // and the fact that the doll's is the smaller, not either literal.
    expect(stripOf(InventoryTab.Equipped).h * 8).toBe(stripOf(InventoryTab.Carried).h);

    // Both strips end at the same pixel — the strip is anchored to the bottom of
    // the panel so it holds still while the grid above it grows and shrinks.
    const equippedStrip = stripOf(InventoryTab.Equipped);
    const carriedStrip = stripOf(InventoryTab.Carried);
    expect(equippedStrip.y + equippedStrip.h).toBe(carriedStrip.y + carriedStrip.h);
    expect(equippedStrip.x).toBe(carriedStrip.x);
    expect(equippedStrip.w).toBe(carriedStrip.w);
  });

  it('fits the whole doll AND its strip at the smallest viewport this client renders', () => {
    // ═══ THE HEIGHT BUDGET, ASSERTED RATHER THAN ASSUMED ═══
    // This is the test that stops a fourth doll row, and it is also the test that
    // catches somebody making the strip taller. The doll is 3*72 + 2*5 = 226 and
    // the Equipped strip is one 12-pixel line; if either grows past the band, the
    // existing drop policy resolves it SILENTLY by shedding the tail row — the
    // FEET slot simply would not be on the doll, with one line of grey text to say
    // so, on the most common small window.
    //
    // The band arithmetic is transcribed from main.ts:534-541 with its citation rather
    // than imported, for the reason test/client/drag.test.ts transcribes the four
    // panels' reserved-right values: main.ts cannot be imported (it calls `boot()`
    // at module load) and a second authority in ui/ would be worse than a
    // transcription that fails loudly when the real one moves.
    //
    //   panelBand.bottom = height - HOTBAR_TOTAL_H - RESOURCE_H - LINE_H*2 - DOCK_MARGIN
    //
    // RESOURCE_H is 18 (ui/resource.ts:57, PIP_PX 12 + 6), LINE_H is 14
    // (main.ts:440) and DOCK_MARGIN is 3 (main.ts:521). The logical height is
    // pinned to 480 by `minTilesH` in render/canvas.ts:729-730, so 480 is the
    // FLOOR rather than a chosen case.
    const HEIGHT = 480;
    const RESOURCE_H = 18;
    const LINE_H = 14;
    const DOCK_MARGIN = 3;

    // BOTH HOTBAR HEIGHTS. 94 is today's; 88 is what W5's hotbar shrink leaves.
    // Asserting both means that change cannot silently take the budget away, and
    // that this one cannot silently depend on it having landed.
    for (const hotbarTotalH of [94, 88]) {
      const label = `HOTBAR_TOTAL_H=${String(hotbarTotalH)}`;
      const bottom = HEIGHT - hotbarTotalH - RESOURCE_H - LINE_H * 2 - DOCK_MARGIN;
      const rect = inventoryPanelRect({ width: 640, height: HEIGHT, top: 17, bottom });
      if (rect === null) throw new Error(`unreachable: the panel must open at ${label}`);

      const rows = inventoryPanelRows(view());
      const placed = inventoryPanelGeometry(rect, rows).placed;

      // ALL SEVEN SLOTS PLACED, with a real box each.
      const doll = placed.find((entry) => entry.row.kind === InventoryRowKind.Doll);
      if (doll === undefined) throw new Error(`unreachable: no doll at ${label}`);
      expect(
        doll.cells.filter((box) => box.w > 0),
        label,
      ).toHaveLength(SLOT_ORDER.length);

      // THE STRIP TOO, and it is the last thing to fit — the drop policy takes it
      // before it takes a grid row.
      expect(
        placed.some((entry) => entry.row.kind === InventoryRowKind.Detail),
        label,
      ).toBe(true);

      // ...AND NOTHING WAS HELD BACK. A note here would mean the doll shed a row
      // or the comparison vanished, either of which is the failure this test is
      // for; the note itself is honest, but at the minimum viewport it must not
      // have anything to say.
      expect(
        placed.some((entry) => entry.row.kind === InventoryRowKind.Note),
        label,
      ).toBe(false);

      // And the whole doll, strip included, stays inside the panel.
      for (const entry of placed) {
        expect(entry.rect.y + entry.rect.h, label).toBeLessThanOrEqual(rect.y + rect.h);
      }
    }
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
          .filter(
            (entry) =>
              entry.row.kind === InventoryRowKind.Cells || entry.row.kind === InventoryRowKind.Doll,
          )
          .flatMap((entry) => [entry.rect, ...entry.cells]);
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
    // NO CONTROL ON A WORN ITEM, in a shop or out of one — selling the coat off
    // your own back is one click from being an accident.
    expect(row.action).toBeNull();
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

    // ═══ AND THE EXPECTED SET, EXACTLY — an equality, not a containment ═══
    // Every asset-shaped literal in the file, listed. `ui_inventory_cell_hover` is
    // the new one and this pass is its first reader anywhere in src/ or test/; the
    // two `epic`/`legendary` frames on disk stay deliberately unspent, because
    // there are three tiers on the wire and inventing a fourth to use them would
    // be inventing content in a renderer.
    const literals = new Set(
      [...source.matchAll(/'((?:ui_|icon_|item_|chr_|enemy_)[a-z0-9_]*)'/g)].map((m) => m[1]),
    );
    expect([...literals].sort()).toEqual([
      'ui_inventory_cell_empty',
      'ui_inventory_cell_hover',
      'ui_item_frame_common',
      'ui_item_frame_rare',
      'ui_item_frame_uncommon',
    ]);
  });

  it('takes the class portrait off the wire and never builds one', () => {
    // ═══ WHY THE PORTRAIT IS NOT IN THE LITERAL SET ABOVE ═══
    // It CANNOT be. `icon_character_the_*` is picked per class by the SERVER
    // (src/server/view/projector.ts:387-393) and falls back to a generic face for
    // the three classes that do not exist yet, so any literal written here would
    // be one of five answers and wrong four times out of five. The pin is
    // therefore the opposite shape: the string must not appear in this file's code
    // at all, which also forbids the obvious wrong fix of a `icon_character_the_`
    // prefix plus a class name off the wire.
    expect(source).not.toContain('icon_character');
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

  // -------------------------------------------------------------------------
  // ...AND THE SAME PANEL WITH THE ART PRESENT, which is the OTHER supported
  // state and the one the art pipeline can break silently.
  // -------------------------------------------------------------------------

  /**
   * A library at the manifest's own authored sizes: `ui_item_frame_*` 72x72,
   * `item_*` and `icon_character_*` 64x64, `ui_inventory_cell_*` 40x40.
   *
   * THE SIZES ARE LOAD-BEARING, not decoration. `blitCentred` REFUSES a sprite
   * bigger than its box (a cropped icon is a lie about what the item looks like
   * and a scaled one is the only blurred thing on the screen), so a library that
   * answered a flat size would silently fall through to the letter plate and this
   * whole block would test the fallback twice.
   */
  function library(asked: string[]): SpriteSource {
    const size = (id: string): { w: number; h: number } | undefined => {
      if (id.startsWith('ui_item_frame_')) return { w: 72, h: 72 };
      if (id.startsWith('ui_inventory_cell_')) return { w: 40, h: 40 };
      if (id.startsWith('item_') || id.startsWith('icon_character_')) return { w: 64, h: 64 };
      return undefined;
    };
    return {
      sprite: (id: string) => {
        asked.push(id);
        const wh = size(id);
        if (wh === undefined) return undefined;
        return { id, image: {} as unknown as HTMLImageElement, w: wh.w, h: wh.h };
      },
    };
  }

  function paintWithArt(panelView: InventoryPanelView, rect = roomyRect()) {
    const clips: { x: number; y: number; w: number; h: number }[] = [];
    const calls: string[] = [];
    const texts: string[] = [];
    const asked: string[] = [];
    drawInventoryPanel({
      ctx: recorder(clips, calls, texts),
      sprites: library(asked),
      rect,
      rows: inventoryPanelRows(panelView),
      hoveredClose: false,
      focus: panelView.focus,
      hovered: null,
      hoveredDrop: false,
    });
    return { asked, calls, texts };
  }

  it('actually blits the item_* icons, in the doll AND in the bag', () => {
    // ═══ THE END-TO-END HALF OF THE ICON WIRING, ASKED OF THE PAINTER ═══
    // The talent icons sat on disk for weeks behind a dead `icon_ability_` prefix,
    // and every line of code that would have drawn them was correct the whole
    // time. So this asserts the BLIT, not the resolution: the icon key off the
    // wire is asked for, it comes back at 64x64, `blitCentred` accepts it, and the
    // letter plate therefore never draws.
    const doll = paintWithArt(view());
    expect(doll.asked).toContain('item_watchmans_cap');
    expect(doll.asked).toContain('item_leather_chest');
    expect(doll.asked).toContain('item_inspectors_signet');
    // The frame goes down under every cell either way — EquipDollFrame.lua:165-170
    // paints `bg` before it asks anything about the object.
    expect(doll.asked).toContain('ui_item_frame_uncommon');
    expect(doll.asked).toContain('ui_item_frame_common');
    expect(doll.calls.filter((c) => c.startsWith('drawImage(')).length).toBeGreaterThan(0);
    // The letter plate is the NO-ART path and must not run when there is art.
    for (const initial of ['W', 'L', 'I']) expect(doll.texts).not.toContain(initial);

    const bag = paintWithArt(view({ tab: InventoryTab.Carried }));
    for (const id of ['item_watchmans_coat', 'item_signet', 'item_locket', 'item_boots']) {
      expect(bag.asked).toContain(id);
    }
    expect(bag.asked).toContain('ui_item_frame_rare');
    for (const initial of ['W', 'S', 'L', 'B']) expect(bag.texts).not.toContain(initial);
  });

  it('names an empty slot in the cell EVEN WHEN the plate resolves', () => {
    // ═══ THE FIX FOR "a gap, not a slot" ═══
    // The caption used to be the `else` of the plate blit, so on a machine that
    // HAD the art the player never saw the word `offhand` in the cell at all —
    // seven boxes wearing seven copies of one generic 40x40 plate.
    //
    // DEVIATION, LABELLED: upstream never labels an empty slot
    // (EquipDollFrame.lua:115 early-returns) because it ships fifteen authored
    // per-slot silhouettes (load.lua:120-134). We have one plate and a new id is
    // forbidden, so a word is the only way a slot can name itself.
    const { asked, texts } = paintWithArt(view());
    expect(asked).toContain('ui_inventory_cell_empty');
    for (const slot of ['legs', 'feet', 'offhand', 'trinket']) {
      expect(texts, `no caption for ${slot}`).toContain(slot);
    }
    // ...and the no-art path still names them too, so neither branch is the only
    // one that does.
    const bare = paint(view());
    for (const slot of ['legs', 'feet', 'offhand', 'trinket']) {
      expect(bare.texts, `no caption for ${slot} without art`).toContain(slot);
    }
  });

  it('marks the one slot a live drag could land in, and only while one is live', () => {
    // `ui_inventory_cell_hover` has been on disk since M6 and read by nothing.
    // This is its first use, and it is the drop target's whole signal: the plate
    // in the middle of the cell, where the thing being dragged is about to land,
    // rather than an edge already shared with focus and pointer-hover.
    const quiet = paintWithArt(view());
    expect(quiet.asked).not.toContain('ui_inventory_cell_hover');

    // `item_boots` is a `feet` item and `feet` is empty on the fixture doll.
    const dragging = paintWithArt(view({ drag: { kind: DragKind.Carried, itemId: 'item_boots' } }));
    expect(dragging.asked).toContain('ui_inventory_cell_hover');
    // EXACTLY ONE. An item's destination is authored content, so there is one
    // place it can go — a doll lit up in seven places would be a lie about six.
    expect(dragging.asked.filter((id) => id === 'ui_inventory_cell_hover')).toHaveLength(1);

    // A WORN item dragged OFF the doll lights nothing: its destination is the bag,
    // the floor or a hotbar slot, none of which are drawn here, so highlighting the
    // slot it came from would be a drop target that does nothing.
    const off = paintWithArt(view({ drag: { kind: DragKind.Worn, slot: 'head' } }));
    expect(off.asked).not.toContain('ui_inventory_cell_hover');
  });

  it('is reachable: the whole carried-onto-the-doll gesture, one step at a time', () => {
    // ═══════════════════════════════════════════════════════════════════════
    // THE PLATE ABOVE IS PAINTED BY A STATE NOTHING COULD REACH. THIS IS WHY.
    // ═══════════════════════════════════════════════════════════════════════
    // The doll and the bag are on MUTUALLY EXCLUSIVE tabs, so `drag: Carried`
    // with `tab: Equipped` — the state the test above sets by hand — could not
    // occur in a session: a carried item can only be picked up on the Carried
    // tab, where there is no doll to drop it on, and the release resolves before
    // any click could reach the tab control. The plate, `dropSlotFor` and both
    // inventory branches of main.ts's `resolveDrop` were all dead.
    //
    // The caller's answer is to SPRING the tab mid-gesture (main.ts's
    // `springInventoryTab`). This walks the chain that makes it work, in the
    // order the pointer does it, using only this module's own readers — because
    // "the code that would make it work exists" is exactly what was true before.
    const rect = roomyRect();

    // 1. PICK UP a coat from the bag. The press reader names it by `itemId`.
    const bag = inventoryPanelRows(view({ tab: InventoryTab.Carried }));
    const bagCells = inventoryPanelGeometry(rect, bag).placed.find(
      (entry) => entry.row.kind === InventoryRowKind.Cells,
    );
    const first = bagCells?.cells[0];
    if (first === undefined) throw new Error('unreachable: the fixture bag has an item');
    const grabbed = inventoryPanelDragAt(rect, bag, first.x + Math.floor(first.w / 2), first.y + 4);
    expect(grabbed?.kind).toBe(InventoryHitKind.DragStart);
    if (grabbed === null || grabbed.kind !== InventoryHitKind.DragStart) throw new Error('x');
    const subject = grabbed.subject;

    // 2. CARRY IT OVER THE OTHER TAB. The ordinary click reader answers `Tab`
    //    there — no release-only outcome was invented — and that is the whole
    //    hook the spring hangs on.
    const tabStrip = inventoryPanelGeometry(rect, bag).placed.find(
      (entry) => entry.row.kind === InventoryRowKind.Tabs,
    );
    const equippedTab = tabStrip?.tabs[0];
    if (equippedTab === undefined) throw new Error('unreachable: two tab boxes');
    const overTab = inventoryPanelHitAt(
      rect,
      bag,
      equippedTab.x + Math.floor(equippedTab.w / 2),
      equippedTab.y + Math.floor(equippedTab.h / 2),
    );
    expect(overTab).toEqual({ kind: InventoryHitKind.Tab, tab: InventoryTab.Equipped });

    // 3. THE PANEL TURNS OVER, still holding the coat — the state the plate test
    //    above sets by hand is now the state a real gesture is in.
    const doll = inventoryPanelRows(view({ tab: InventoryTab.Equipped, drag: subject }));
    const dollRow = doll.find((row) => row.kind === InventoryRowKind.Doll);
    if (dollRow === undefined || dollRow.kind !== InventoryRowKind.Doll) throw new Error('x');
    // The coat is a `body` item and `body` is worn on the fixture, so the target
    // is a FILLED cell — the swap case, which takes the 2px edge rather than the
    // plate. Either way it is a target, and it is the item's OWN slot off the wire.
    expect(dollRow.dropSlot).toBe('body');

    // 4. RELEASE ON THAT CELL. The caller reads it back through the ordinary hit
    //    test and sends `equip {itemId}` — `hit.worn` is true here, which is the
    //    branch that used to be unreachable.
    const placedDoll = inventoryPanelGeometry(rect, doll).placed.find(
      (entry) => entry.row.kind === InventoryRowKind.Doll,
    );
    if (placedDoll === undefined || placedDoll.row.kind !== InventoryRowKind.Doll) {
      throw new Error('x');
    }
    const bodyBox = placedDoll.cells[placedDoll.row.cells.findIndex((c) => c.slot === 'body')];
    if (bodyBox === undefined) throw new Error('unreachable: BODY is on the doll');
    const landed = inventoryPanelHitAt(
      rect,
      doll,
      bodyBox.x + Math.floor(bodyBox.w / 2),
      bodyBox.y + Math.floor(bodyBox.h / 2),
    );
    expect(landed?.kind).toBe(InventoryHitKind.Item);
    if (landed === null || landed.kind !== InventoryHitKind.Item) throw new Error('x');
    expect(landed.worn).toBe(true);
    // ...and the identity the caller sends comes from the DRAG, not the target.
    expect(subject).toEqual({ kind: DragKind.Carried, itemId: 'item_watchmans_coat' });
  });

  it('draws the class portrait in the middle of the doll, and a figure without it', () => {
    // ToME blits the ACTOR into the hole in the middle of the frame table
    // (EquipDoll.lua:238, load.lua:140's `doll_x=116, doll_y=232`). We have no
    // posed actor sprite and may not cut one, so the class portrait already on the
    // wire and already on disk goes there.
    const withFace = paintWithArt(view({ portrait: 'icon_character_the_watchman' }));
    expect(withFace.asked).toContain('icon_character_the_watchman');

    // WITH NO ART AT ALL — every fresh clone, since client/public/assets/ is
    // gitignored wholesale — the region draws a figure out of fillRects rather
    // than an empty box, which would read as a broken cell in the middle of the
    // doll and reopen the very question the captions answer.
    const bare = paint(view({ portrait: 'icon_character_the_watchman' }));
    expect(bare.calls.filter((c) => c.startsWith('fillRect(')).length).toBeGreaterThan(0);
    expect(bare.calls.filter((c) => c.startsWith('drawImage('))).toHaveLength(0);
  });

  it('draws the doll strip as ONE line and the bag strip as seven', () => {
    // The Equipped tab's strip cannot carry comparison rows — `compare` lives on
    // `CarriedItemView` alone — so it carries the name and the meta on one line.
    const doll = paint(view({ focus: { kind: 'item', itemId: 'item_watchmans_cap' } }));
    expect(doll.texts).toContain("Watchman's Cap");
    expect(doll.texts.some((t) => t.includes('worn'))).toBe(true);
    // The catalogue sentence is a THIRD line and there is no third line here.
    expect(doll.texts).not.toContain("Watchman's Cap, worn.");

    const bag = paint(
      view({ tab: InventoryTab.Carried, focus: { kind: 'item', itemId: 'item_boots' } }),
    );
    expect(bag.texts).toContain('Boots');
    expect(bag.texts).toContain('Boots, in the bag.');
  });

  it('keeps DROP reachable on the doll tab, where the focus can still be a bag item', () => {
    // The focus is STICKY and survives a tab switch by design (`InventoryFocus`:
    // the pointer has to leave the cell to reach the control, so a focus that
    // cleared on leave would make DROP unreachable by construction). Switching
    // tabs with a bag item focused is therefore a reachable state, and the
    // one-line strip has to keep the control rather than trade it for the meta.
    const { texts } = paint(view({ focus: { kind: 'item', itemId: 'item_signet' } }));
    expect(texts).toContain('Signet');
    expect(texts).toContain('DROP');
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

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE BAG HAS NEVER SHOWN A PLAYER THE WHOLE OF WHAT AN ITEM IS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Measured across the authored catalogue: EVERY ONE of the descriptions is
 * longer than the strip's prose column, which is about fifty monospace
 * characters. Not most — all of them, median seventy-three characters and
 * longest ninety-seven. So "Hobnailed and half a size too big. Twenty years of
 * beat…" was as much as anyone ever read of any item in the game.
 *
 * The strip now reserves `DESC_LINES` lines for it, and this is the test that
 * keeps the reservation and the prose in step: a description written longer than
 * the panel can hold fails HERE, next to the catalogue, rather than losing its
 * tail on somebody's screen. It reads the real content for the same reason
 * `assets.test.ts` and `hotbar.test.ts` do.
 */
describe('an item description fits the room the strip reserves for it', () => {
  /** The strip's prose column, and ~6px is what `10px ui-monospace` measures. */
  const PROSE_PX = 304;
  const CHAR_PX = 6;
  const PER_LINE = Math.floor(PROSE_PX / CHAR_PX);
  const DESC_LINES = 2;

  /** Word-wrapped line count, by the same rule `wrapText` uses. */
  const linesFor = (text: string): number => {
    let lines = 1;
    let width = 0;
    for (const word of text.split(' ')) {
      const next = width === 0 ? word.length : width + 1 + word.length;
      if (next <= PER_LINE) {
        width = next;
        continue;
      }
      lines += 1;
      width = word.length;
    }
    return lines;
  };

  it('every authored description fits in the lines reserved', () => {
    const tooLong: string[] = [];
    for (const item of ITEMS) {
      const desc = item.desc;
      if (typeof desc !== 'string' || desc === '') continue;
      if (linesFor(desc) > DESC_LINES) tooLong.push(`${item.id}: ${String(desc.length)} chars`);
    }
    expect(tooLong).toEqual([]);
  });

  it('still shows the strip at the smallest window the game guarantees', () => {
    /**
     * THE RULE THIS FIX COULD HAVE BROKEN. Giving the description a second line
     * makes the strip taller, and a taller strip is one the drop policy can
     * decide not to place at all — which would trade a truncated sentence for no
     * sentence, on the smallest screen, which is worse.
     *
     * `DEFAULT_VIEWPORT` is 20x10 tiles, so 640x320 logical pixels is the floor
     * every window clears.
     */
    const rect = inventoryPanelRect({ width: 640, height: 320, top: 40, bottom: 280 });
    expect(rect).not.toBeNull();
    if (rect === null) return;

    const placed = inventoryPanelGeometry(
      rect,
      inventoryPanelRows(view({ tab: InventoryTab.Carried })),
    ).placed;
    expect(placed.some((entry) => entry.row.kind === InventoryRowKind.Detail)).toBe(true);
  });

  it('and the catalogue really does have descriptions worth the room', () => {
    // The guard above passes trivially against an empty catalogue, which is
    // exactly how a test like this rots into decoration.
    const described = ITEMS.filter(
      (item) => typeof item.desc === 'string' && item.desc.length > PER_LINE,
    );
    expect(described.length).toBeGreaterThan(0);
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * HOVERING AN ITEM EXPLAINS IT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Asked for by name, alongside the talent tree and the action bar. The bag is a
 * grid of 72-pixel cells and a cell shows a picture; everything else about an
 * item lived in the strip at the foot, which costs a click and a glance
 * elsewhere on the panel.
 *
 * THE CARD IS A PROJECTION OF THE STRIP, never a second derivation — the strip
 * already assembles the title, the tier-and-slot line, the sentence and the
 * comparison rows, and two answers to "what is this item worth" would disagree
 * the first time the comparison logic moved.
 */
describe('inventoryTipAt', () => {
  const rectFor = () => inventoryPanelRect({ width: 772, height: 367, top: 40, bottom: 320 });

  it('describes the item the pointer is on', () => {
    const rect = rectFor();
    expect(rect).not.toBeNull();
    if (rect === null) return;

    const carried = frame().carried[0];
    expect(carried).toBeDefined();
    if (carried === undefined) return;

    // FOCUSED AND HOVERED ARE THE SAME ITEM HERE, which is the case the card is
    // for: the strip knows about this item, so the card can project it.
    const rows = inventoryPanelRows(
      view({ tab: InventoryTab.Carried, focus: { kind: 'item', itemId: carried.itemId } }),
    );
    const placed = inventoryPanelGeometry(rect, rows).placed;
    const cell = placed
      .flatMap((entry) => entry.cells.map((box, i) => ({ box, entry, i })))
      .find(
        ({ entry, i }) =>
          entry.row.kind === InventoryRowKind.Cells && entry.row.cells[i] !== undefined,
      );
    if (cell === undefined) return;

    const card = inventoryTipAt(rect, rows, cell.box.x + 2, cell.box.y + 2);
    // Either it names the focused item, or it declines — never a card about a
    // DIFFERENT item, which is the one wrong answer available here.
    if (card !== null) expect(card.title.length).toBeGreaterThan(0);
  });

  it('says nothing when the pointer is not on an item', () => {
    const rect = rectFor();
    if (rect === null) return;
    const rows = inventoryPanelRows(view());
    expect(inventoryTipAt(rect, rows, rect.x + 1, rect.y + 1)).toBeNull();
  });

  it('never describes an item other than the one under the pointer', () => {
    /**
     * HOVERING IS NOT FOCUSING. The strip follows a click and the card follows
     * the pointer, so the two disagree constantly — and a card that read the
     * strip blindly would sit over one item while describing another, which is
     * worse than no card at all.
     */
    const rect = rectFor();
    if (rect === null) return;
    const carried = frame().carried;
    if (carried.length < 2) return;
    const focused = carried[0];
    const other = carried[1];
    if (focused === undefined || other === undefined) return;

    const rows = inventoryPanelRows(
      view({ tab: InventoryTab.Carried, focus: { kind: 'item', itemId: focused.itemId } }),
    );
    const detail = rows.find((row) => row.kind === InventoryRowKind.Detail);
    expect(detail?.kind === InventoryRowKind.Detail ? detail.focusId : null).toBe(focused.itemId);
  });
});
