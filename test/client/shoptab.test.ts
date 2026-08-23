/// <reference lib="dom" />
import { describe, expect, it } from 'vitest';

import {
  InventoryHitKind,
  InventoryRowKind,
  InventoryTab,
  inventoryColumnsFor,
  inventoryPanelDragAt,
  inventoryPanelGeometry,
  inventoryPanelHitAt,
  inventoryPanelRect,
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
        desc: 'Reinforced against the kind of night this beat has.',
      },
      {
        itemId: 'item_leather_chest~ol1',
        name: 'Oiled Leather Chestpiece',
        icon: 'item_leather_chest',
        tier: ItemTier.Uncommon,
        buy: 24,
        sell: 1,
        desc: 'Oiled against the rain, which is most of the year.',
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
              compare: [],
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

describe('a shelf row cannot be picked up', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE BUG: dragging a coat off the shelf sent `equip` for an item you do not
   * own, and the refusal was not quiet.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `shopCells` sets `worn: false`, so a shelf row fell through to
   * `DragKind.Carried` carrying the shop's item id. `springInventoryTab` then
   * flipped the panel to Equipped mid-drag and the drop sent `equip`, which the
   * server answers *"you are not carrying that"* — and `case 'error'` puts a
   * full refusal banner on the canvas, cancels any aim and interrupts a walk.
   *
   * The CLICK path had already decided this: a grid press on the shop tab sets
   * the focus and sends nothing, because BUY is the only control that spends
   * money and the only one that knows the price. This makes the drag agree.
   */
  const rectFor = () => {
    const rect = inventoryPanelRect({ width: 1280, height: 720, top: 60, bottom: 640 });
    if (rect === null) throw new Error('no panel');
    return rect;
  };

  /** The middle of the first cell on whichever tab `v` is showing. */
  function firstCell(v: InventoryPanelView) {
    const rect = rectFor();
    const rows = inventoryPanelRows(v, inventoryColumnsFor(rect.w));
    for (const placed of inventoryPanelGeometry(rect, rows).placed) {
      if (placed.row.kind !== InventoryRowKind.Cells) continue;
      const box = placed.cells[0];
      const cell = placed.row.cells[0];
      if (box === undefined || cell === undefined || cell.kind === 'empty') continue;
      return { rect, rows, x: box.x + box.w / 2, y: box.y + box.h / 2 };
    }
    throw new Error('no filled cell');
  }

  it('refuses the grab, so no drag begins', () => {
    const v = view();
    const { rect, rows, x, y } = firstCell(v);
    expect(inventoryPanelDragAt(rect, rows, x, y)).toBeNull();
  });

  it('still answers the press, so the strip describes what was pressed', () => {
    // A REFUSED GRAB IS NOT A DEAD CONTROL. With no drag to begin, the press
    // falls through to `inventoryPanelHitAt` and behaves exactly as the click
    // does — which is the whole reason refusing the grab is safe here.
    const v = view();
    const { rect, rows, x, y } = firstCell(v);
    const hit = inventoryPanelHitAt(rect, rows, x, y);
    expect(hit?.kind).toBe(InventoryHitKind.Item);
  });

  it('does NOT refuse a bag row, which is the gesture the doll exists for', () => {
    /**
     * THE OTHER HALF, and the one that makes the fix a fix rather than a
     * disabling. `price` is the marker precisely because it is the only field
     * the shelf has and the bag does not — `worn` cannot tell them apart, since
     * a shelf row and a bag row are both `worn: false`, which is how the bug
     * got in.
     */
    const v = view({
      tab: InventoryTab.Carried,
      inventory: inventoryFrame(100, [
        {
          itemId: 'item_watchmans_coat~mine',
          name: "Watchman's Coat",
          icon: 'item_watchmans_coat',
          tier: ItemTier.Common,
          slot: 'body',
          desc: 'A coat you already own, which is the whole point of this row.',
          // EMPTY IS A REAL ANSWER — see `CarriedItemView.compare`. This fixture
          // is about who owns the row, not about what wearing it would change.
          compare: [],
        },
      ]),
    });
    const { rect, rows, x, y } = firstCell(v);
    expect(inventoryPanelDragAt(rect, rows, x, y)?.kind).toBe(InventoryHitKind.DragStart);
  });
});

describe('a shelf row carries its own description', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * A SHELF WAS A PICTURE, A NAME AND A PRICE.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * The strip printed a shelf row's description by resolving the item out of the
   * player's OWN bag — so a coat you did not already own showed nothing at all,
   * which is every coat worth looking at. `ShowStore.lua:145` renders the full
   * text for every row on the shelf.
   */
  const detailOf = (rows: readonly ReturnType<typeof inventoryPanelRows>[number][]) => {
    const row = rows.find((r) => r.kind === InventoryRowKind.Detail);
    if (row === undefined || row.kind !== InventoryRowKind.Detail) throw new Error('no strip');
    return row;
  };

  it('shows the prose for something the player does not own', () => {
    const v = view({ focus: { kind: 'item', itemId: 'item_watchmans_coat~rf1' } });
    expect(detailOf(inventoryPanelRows(v)).desc).toBe(
      'Reinforced against the kind of night this beat has.',
    );
  });

  it('falls back to the bag against a server that sends none', () => {
    // The additive-field contract: an older server loses the sentence for
    // items you do not own, never for the ones you do.
    const shop = shopFrame();
    const v = view({
      focus: { kind: 'item', itemId: 'item_watchmans_coat~rf1' },
      shop: {
        ...shop,
        stock: shop.stock.map((row) => ({ ...row, desc: '' })),
      },
    });
    // Nothing in the bag either, so the honest answer is an empty line rather
    // than a sentence about the wrong item.
    expect(detailOf(inventoryPanelRows(v)).desc).toBe('');
  });
});

describe('a worn item says what it is giving you', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE TAB THE PANEL OPENS ON COULD NOT ANSWER THE QUESTION IT EXISTS FOR.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `compare` lived on `CarriedItemView` alone, so a worn item reached the client
   * as a name, a tier and one line of flavour. `ShowEquipment.lua:89` renders the
   * full description for the selected worn item.
   */
  const armour = [{ label: 'Armour', value: '+4' }];

  const wornView = (panelH?: number) =>
    view({
      tab: InventoryTab.Equipped,
      shop: null,
      focus: { kind: 'item', itemId: 'w' },
      inventory: {
        ...inventoryFrame(100),
        equipped: {
          body: {
            itemId: 'w',
            name: 'Watchman’s Coat',
            icon: 'item_watchmans_coat',
            tier: ItemTier.Common,
            desc: 'Heavy wool, official issue.',
            compare: armour,
          },
        },
      },
      ...(panelH === undefined ? {} : { panelH }),
    });

  const detailOf = (rows: readonly ReturnType<typeof inventoryPanelRows>[number][]) => {
    const row = rows.find((r) => r.kind === InventoryRowKind.Detail);
    if (row === undefined || row.kind !== InventoryRowKind.Detail) throw new Error('no strip');
    return row;
  };

  it('carries the stat rows the doll used to be handed empty', () => {
    expect(detailOf(inventoryPanelRows(wornView())).rows).toEqual(armour);
  });

  it('says the same thing whether the strip is tall or short', () => {
    /**
     * THE HEIGHT IS THE SPACE; THE ROWS ARE THE ANSWER. `drawDetail`'s compact
     * branch returns before it reads `rows`, so a short strip draws none of them
     * — but the answer must not change, or the two tabs become two panels
     * wearing one header.
     */
    const short = detailOf(inventoryPanelRows(wornView(120)));
    const tall = detailOf(inventoryPanelRows(wornView(600)));
    expect(short.rows).toEqual(tall.rows);
    expect(short.compact, 'a small panel still protects the doll').toBe(true);
    expect(tall.compact, 'a big one can afford the strip').toBe(false);
  });
});
