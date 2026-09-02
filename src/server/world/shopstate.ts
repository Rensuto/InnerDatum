// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from
//   t-engine4 game/engines/default/engine/Store.lua:54-98 (`canRestock` / `loadup` — the lazy
//              catch-up loop, `empty_before_restock`, `__force_store_forget`)
//   t-engine4 game/modules/tome/class/Store.lua:171-178 (player-sold goods are flagged at sale)
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" — https://te4.org/license

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *        A SHOP RESTOCKS WHEN YOU OPEN THE DOOR, AND NEVER OTHERWISE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `engine/Store.lua:54-61` lets a shop restock iff `last_filled < stores_restock`, and
 * `loadup` is a catch-up `while` loop run lazily when the player walks in.
 * There is no timer, no scheduler entry and no per-pump work: a shop nobody
 * visits costs exactly nothing, and a shop visited after four level-ups catches
 * up four batches in one call.
 *
 * THAT MATTERS HERE MORE THAN IT DOES UPSTREAM. Non-negotiable #2 says turn
 * resolution is fully synchronous and the pump is the mutex; anything ticking
 * shops inside it would be work done on every realm every pump for a thing that
 * changes when somebody levels. And an epoch persists as an integer, where a
 * timer would persist as a timestamp that is wrong the moment a host reboots.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * IDEMPOTENT, AND RE-DERIVABLE FROM THE SEED
 * ═══════════════════════════════════════════════════════════════════════════
 * Each batch forks `world.shopRng` on `shop:<shopId>:<epoch>`, and `fork` is
 * pure over (state, inc, label) — so batch 3 is the same batch 3 however many
 * times the loop runs and whatever happened in between. Catching up 0→2 in one
 * call therefore produces exactly the shelf that two separate visits would
 * have, which is the property that makes a lazy loop safe to write at all.
 */

import { NB_FILL, epochFor, restock, stockLevelFor } from '../content/shops.ts';
import { stockSeedLabel } from '../content/shops.ts';
import type { Realm, ShopSlot } from './realms.ts';

/**
 * Bring a shop's shelves up to the party's current epoch.
 *
 * A no-op for a realm with no shop, and a no-op when the shop is already
 * current — both silent, because "you opened a door" is not an event worth a
 * log line.
 *
 * @returns true when anything changed, so a caller can decide whether to send a
 *   frame rather than sending one every time somebody steps on the tile.
 */
export function catchUpShop(realm: Realm, partyMaxLevel: number): boolean {
  const shop = realm.shop;
  if (shop === undefined) return false;

  const target = epochFor(partyMaxLevel);
  if (shop.epoch >= target) return false;

  const level = stockLevelFor(partyMaxLevel);
  const shopId = realm.siteId ?? realm.id;

  while (shop.epoch < target) {
    shop.epoch += 1;

    /**
     * ═════════════════════════════════════════════════════════════════════
     * WHAT SURVIVES A RESTOCK: EVERYTHING THE SHOP ITSELF PUT THERE.
     * ═════════════════════════════════════════════════════════════════════
     * `empty_before_restock = false` on every shop in `basic.lua`, so stock
     * ACCUMULATES — something walked past at level 9 is still there at 40.
     * The only thing ever removed is what a player sold in, which is flagged
     * at sale time and cleared here.
     *
     * FILTERED ON THE SLOT'S FLAG, NEVER ON THE ID. Two identical ids can sit
     * on one shelf legitimately (`restock` says why), so a set of sold ids
     * could not tell the player's coat from the shop's own and would delete
     * both. The flag travels with the slot precisely so that it cannot.
     */
    const keep = shop.stock.filter((slot) => !slot.playerSold).map((slot) => slot.id);

    // A BATCH PER EPOCH, BOUNDED. `restock` argues the shape at its `target`
    // parameter: topping up to a fixed four would mean a shop nobody buys from
    // is finished after its first visit, still holding the goods it rolled for
    // a level-1 party when that party is level 40 — an epoch that changes
    // nothing a player can see is not a feature.
    shop.stock = restock(
      realm.world.shopRng.fork(stockSeedLabel(shopId, shop.epoch)),
      keep,
      level,
      NB_FILL * (shop.epoch + 1),
      // WHAT THIS SHOP SELLS. Ashwick's shelf is draughts and Threadneedle's is
      // everything worn — see `ShopShelf`; a second shop stocking the same
      // catalogue would be the same shop, further away.
      shop.shelf,
    )
      // EVERYTHING ON THE SHELF AFTER A RESTOCK IS THE SHOP'S. What the player
      // sold in has just been cleared, and what `restock` added is new — so a
      // flat re-wrap is correct rather than a merge that would have to decide
      // which of two identical strings kept its flag.
      .map((id): ShopSlot => ({ id, playerSold: false }));
  }

  return true;
}

/**
 * Put an item a player sold onto the shelves, flagged.
 *
 * PUSHED RATHER THAN INSERTED IN PRICE ORDER, so the shelf reads as a history:
 * what the shop had, then what the party brought in. Upstream does the same and
 * for a duller reason — `addObject` appends.
 */
export function addSoldItem(realm: Realm, itemId: string): void {
  realm.shop?.stock.push({ id: itemId, playerSold: true });
}

/**
 * Take one item off the shelf BY INDEX, and return whether it was there.
 *
 * BY INDEX AND NOT BY ID, which is the same duplicate problem a third time: two
 * identical coats are two slots, and removing "the one with this id" would be
 * ambiguous about which. The caller finds the index it means; this removes
 * exactly that slot.
 */
export function takeFromShelf(realm: Realm, index: number): ShopSlot | undefined {
  const shop = realm.shop;
  if (shop === undefined) return undefined;
  if (!Number.isInteger(index) || index < 0 || index >= shop.stock.length) return undefined;
  return shop.stock.splice(index, 1)[0];
}
