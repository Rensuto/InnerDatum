/// <reference lib="dom" />
import { describe, expect, it } from 'vitest';

import {
  InventoryHitKind,
  InventoryRowKind,
  InventoryTab,
  inventoryPanelRows,
  tabsFor,
} from '../../src/client/ui/inventory.ts';
import { ItemTier } from '../../src/shared/protocol.ts';
import { PROTOCOL_VERSION } from '../../src/shared/version.ts';
import type { InventoryPanelView } from '../../src/client/ui/inventory.ts';
import type { InventoryMsg, ShopMsg } from '../../src/shared/protocol.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *      THE SHOP TAB. A THIRD BOX THAT EXISTS ONLY WHERE A SHOP DOES.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The failure worth guarding is a tab you can click and not see, or see and not
 * click: the painter and the hit test used to derive the tab list separately
 * from a module constant, and a third tab makes those two derivations able to
 * disagree. They now read one list off the row.
 */

function shopFrame(over: Partial<ShopMsg> = {}): ShopMsg {
  return {
    v: PROTOCOL_VERSION,
    t: 'shop',
    name: 'Threadneedle Row',
    stock: [
      {
        itemId: 'item_watchmans_coat~rf1',
        name: "Reinforced Watchman's Coat",
        icon: 'item_watchmans_coat',
        tier: ItemTier.Rare,
        buy: 49,
        sell: 2,
      },
      {
        itemId: 'item_leather_chest~ol1',
        name: 'Oiled Leather Chestpiece',
        icon: 'item_leather_chest',
        tier: ItemTier.Uncommon,
        buy: 24,
        sell: 1,
      },
    ],
    ...over,
  };
}

function inventoryFrame(money: number, carried: InventoryMsg['carried'] = []): InventoryMsg {
  return { v: PROTOCOL_VERSION, t: 'inventory', carried, equipped: {}, money };
}

function view(over: Partial<InventoryPanelView> = {}): InventoryPanelView {
  return {
    inventory: inventoryFrame(100),
    shop: shopFrame(),
    tab: InventoryTab.Shop,
    focus: null,
    ...over,
  };
}

function tabsRow(rows: readonly ReturnType<typeof inventoryPanelRows>[number][]) {
  const row = rows.find((r) => r.kind === InventoryRowKind.Tabs);
  if (row === undefined || row.kind !== InventoryRowKind.Tabs) throw new Error('no tabs row');
  return row;
}

function detail(rows: readonly ReturnType<typeof inventoryPanelRows>[number][]) {
  const row = rows.find((r) => r.kind === InventoryRowKind.Detail);
  if (row === undefined || row.kind !== InventoryRowKind.Detail) throw new Error('no detail row');
  return row;
}

describe('which tabs exist', () => {
  it('is two in an ordinary room and three where there is a shop', () => {
    // A GREYED THIRD TAB IN EVERY ROOM would be a permanent advertisement for
    // something most rooms do not have, and a player who pressed it once in a
    // corridor would learn to stop looking at it — the wrong lesson for the one
    // tab with gold in it.
    expect(tabsFor(false)).toEqual([InventoryTab.Equipped, InventoryTab.Carried]);
    expect(tabsFor(true)).toEqual([InventoryTab.Equipped, InventoryTab.Carried, InventoryTab.Shop]);
  });

  it('puts the list on the row, so the painter and the hit test cannot disagree', () => {
    expect(tabsRow(inventoryPanelRows(view())).tabs).toHaveLength(3);
    expect(tabsRow(inventoryPanelRows(view({ shop: null }))).tabs).toHaveLength(2);
  });

  it('counts the shelf on the tab, the way the bag counts itself', () => {
    expect(tabsRow(inventoryPanelRows(view())).shopCount).toBe(2);
    expect(tabsRow(inventoryPanelRows(view({ shop: null }))).shopCount).toBe(0);
  });
});

describe('the shelf', () => {
  it('draws a cell per row, in the shop’s own order', () => {
    // `shop_buy` names an id and the server takes the FIRST match by index, so
    // the drawn order and the shelf order have to be one order or the player
    // buys a different coat from the one they clicked.
    const rows = inventoryPanelRows(view());
    const cells = rows.flatMap((row) => (row.kind === InventoryRowKind.Cells ? row.cells : []));
    expect(cells.map((cell) => (cell.kind === 'item' ? cell.itemId : ''))).toEqual([
      'item_watchmans_coat~rf1',
      'item_leather_chest~ol1',
    ]);
  });

  it('marks what the viewer cannot afford, without hiding it', () => {
    // A shelf that looked identical whether or not you could buy from it makes
    // a player click to find out, and a refusal is a worse answer than a
    // greyed price.
    const poor = inventoryPanelRows(view({ inventory: inventoryFrame(30) }));
    const cells = poor.flatMap((row) => (row.kind === InventoryRowKind.Cells ? row.cells : []));
    const flags = cells.map((cell) => (cell.kind === 'item' ? cell.affordable : null));
    expect(flags).toEqual([false, true]);
  });

  it('says so plainly when the shelves are bare', () => {
    const rows = inventoryPanelRows(view({ shop: shopFrame({ stock: [] }) }));
    const note = rows.find((row) => row.kind === InventoryRowKind.Note);
    expect(note?.kind === InventoryRowKind.Note ? note.text : '').toContain('bare');
  });
});

describe('the strip’s one control', () => {
  it('offers BUY with the price on it, on the shop tab', () => {
    const rows = inventoryPanelRows(
      view({ focus: { kind: 'item', itemId: 'item_watchmans_coat~rf1' } }),
    );
    const action = detail(rows).action;
    expect(action?.kind).toBe('buy');
    expect(action?.label).toBe('BUY 49');
    expect(action?.enabled).toBe(true);
  });

  it('greys BUY rather than hiding it when the purse is short', () => {
    // A control that vanished when you could not afford it would move the
    // strip's layout under the pointer.
    const rows = inventoryPanelRows(
      view({
        inventory: inventoryFrame(10),
        focus: { kind: 'item', itemId: 'item_watchmans_coat~rf1' },
      }),
    );
    expect(detail(rows).action?.enabled).toBe(false);
    expect(detail(rows).action?.kind).toBe('buy');
  });

  it('shows the price and what it sells back for, which is how the spread is learned', () => {
    const rows = inventoryPanelRows(
      view({ focus: { kind: 'item', itemId: 'item_watchmans_coat~rf1' } }),
    );
    expect(detail(rows).meta).toContain('49 gold');
    expect(detail(rows).meta).toContain('sells back for 2');
  });

  it('turns DROP into SELL for a carried item, but only where there is a shop', () => {
    // ONE CONTROL, because the two acts are alternatives rather than
    // companions: nobody standing in a shop wants to throw a coat on the floor
    // when the shop will pay for it.
    const carried = [
      {
        itemId: 'item_leather_chest~ol1',
        name: 'Oiled Leather Chestpiece',
        icon: 'item_leather_chest',
        tier: ItemTier.Uncommon,
        desc: 'x',
        slot: 'body' as const,
        compare: [],
      },
    ];
    const focus = { kind: 'item', itemId: 'item_leather_chest~ol1' } as const;

    const inShop = inventoryPanelRows(
      view({ inventory: inventoryFrame(100, carried), tab: InventoryTab.Carried, focus }),
    );
    expect(detail(inShop).action?.kind).toBe('sell');
    expect(detail(inShop).action?.label).toBe('SELL 1');

    const outside = inventoryPanelRows(
      view({
        inventory: inventoryFrame(100, carried),
        shop: null,
        tab: InventoryTab.Carried,
        focus,
      }),
    );
    expect(detail(outside).action?.kind).toBe('drop');
    expect(detail(outside).action?.label).toBe('DROP');
  });

  it('offers nothing at all on a worn item, in a shop or out of one', () => {
    const rows = inventoryPanelRows(
      view({
        inventory: {
          ...inventoryFrame(100),
          equipped: {
            body: {
              itemId: 'w',
              name: 'W',
              icon: 'item_leather_chest',
              tier: ItemTier.Common,
              desc: 'x',
            },
          },
        },
        tab: InventoryTab.Equipped,
        focus: { kind: 'item', itemId: 'w' },
      }),
    );
    expect(detail(rows).action).toBeNull();
  });
});

describe('the hit kinds', () => {
  it('names buy and sell separately from drop', () => {
    // One button, three meanings — and the caller must be able to tell them
    // apart, because one spends gold.
    expect(InventoryHitKind.Buy).toBe('buy');
    expect(InventoryHitKind.Sell).toBe('sell');
    expect(InventoryHitKind.Drop).toBe('drop');
  });
});
