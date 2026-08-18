import { describe, expect, it } from 'vitest';

import { PURSE, buyPrice, sellPrice } from '../../src/server/content/shops.ts';
import { moneyIdFor } from '../../src/server/content/money.ts';
import { projectShop } from '../../src/server/view/projector.ts';
import { resolveItem } from '../../src/server/content/resolve.ts';
import { catchUpShop } from '../../src/server/world/shopstate.ts';
import { createRealms } from '../../src/server/world/realms.ts';
import { createTurnEngine } from '../../src/server/turn-engine.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *   THE SHELF ON THE WIRE. PRICES ARE THE SERVER'S AND NOBODY ELSE'S.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The frame carries both prices already worked out. A client that derived them
 * would be a second copy of the economy, and the first thing to drift would be
 * the ~24:1 spread — silently, because a wrong price still looks like a price.
 */

function shelf(seed: string, level: number): readonly string[] {
  const realms = createRealms({
    seed,
    engineFor: (world) => createTurnEngine({ world }),
  });
  const realm = realms.all().find((r) => r.shop !== undefined);
  if (realm === undefined) throw new Error('no shop realm');
  catchUpShop(realm, level);
  return realm.shop?.stock.map((slot) => slot.id) ?? [];
}

describe('projectShop', () => {
  it('prices every row, and never at zero', () => {
    // A free item is an infinite supply of something — the only way this
    // economy could break from the buying side.
    const msg = projectShop('Threadneedle Row', shelf('frame-prices', 1), 1);
    expect(msg.stock.length).toBeGreaterThan(0);
    for (const row of msg.stock) {
      expect(row.buy).toBeGreaterThanOrEqual(1);
      expect(Number.isInteger(row.buy)).toBe(true);
      expect(Number.isInteger(row.sell)).toBe(true);
      // AND THE SPREAD HOLDS ON EVERY ROW THE PLAYER CAN SEE, which is the one
      // invariant that stops a shop being farmable.
      expect(row.sell).toBeLessThan(row.buy);
      expect(row.sell).toBeLessThanOrEqual(PURSE);
    }
  });

  it('agrees exactly with the pricing functions — one economy, not two', () => {
    const stock = shelf('frame-agrees', 8);
    const msg = projectShop('Threadneedle Row', stock, 8);
    for (const [i, row] of msg.stock.entries()) {
      const id = stock[i];
      if (id === undefined) throw new Error('unreachable');
      expect(row.itemId).toBe(id);
      expect(row.buy).toBe(buyPrice(id, 8));
      expect(row.sell).toBe(sellPrice(id));
    }
  });

  it('names each row the way the player will read it, egos folded in', () => {
    const stock = shelf('frame-names', 1);
    const msg = projectShop('Threadneedle Row', stock, 1);
    for (const [i, row] of msg.stock.entries()) {
      const id = stock[i];
      if (id === undefined) throw new Error('unreachable');
      const item = resolveItem(id);
      expect(row.name).toBe(item?.name);
      expect(row.icon).toBe(item?.icon);
      expect(row.tier).toBe(item?.tier);
    }
  });

  it('keeps the shop’s own order — two identical coats are two rows', () => {
    // `shop_buy` names an id and the handler takes the FIRST match by index, so
    // the wire order and the shelf order have to be the same order or the
    // player buys a different coat from the one they clicked.
    const stock = ['item_watchmans_coat~rf1', 'item_watchmans_coat~rf1'];
    const msg = projectShop('Threadneedle Row', stock, 1);
    expect(msg.stock).toHaveLength(2);
    expect(msg.stock[0]?.itemId).toBe(msg.stock[1]?.itemId);
  });

  it('skips a row it cannot resolve rather than refusing the whole shelf', () => {
    // Reachable exactly as `projectGroundItems` is: a content reload deleted an
    // item out from under a live shop. Show what can be shown.
    const msg = projectShop('Threadneedle Row', ['item_cut_before_ship', 'item_leather_chest'], 1);
    expect(msg.stock.map((row) => row.itemId)).toEqual(['item_leather_chest']);
  });

  it('carries no purse, because a shelf is shared and a purse is not', () => {
    // A first draft put `money` on this frame so the tab could grey what you
    // cannot afford. It is a BROADCAST — that would have been one player's
    // balance sent to everybody in the room, and a second copy of a number
    // `InventoryMsg` already carries, free to disagree with it.
    const msg = projectShop('Threadneedle Row', shelf('frame-nopurse', 1), 1);
    expect(Object.keys(msg)).not.toContain('money');
  });

  it('refuses to price money, so a coin pile can never be shelved for gold', () => {
    const msg = projectShop('Threadneedle Row', [moneyIdFor(40)], 1);
    // `resolveItem` does not know money, so it never reaches a price at all.
    expect(msg.stock).toEqual([]);
  });
});
