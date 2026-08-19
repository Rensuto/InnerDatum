import { describe, expect, it } from 'vitest';

import { NB_FILL, SHELF_CAP } from '../../src/server/content/shops.ts';
import { addSoldItem, catchUpShop, takeFromShelf } from '../../src/server/world/shopstate.ts';
import { createRealms } from '../../src/server/world/realms.ts';
import { createTurnEngine } from '../../src/server/turn-engine.ts';
import type { Realm } from '../../src/server/world/realms.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *      A SHOP IS SHELVES, AN INTEGER, AND ONE FLAG PER SLOT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Three things can go wrong here and only one of them is obvious:
 *
 *   1. THE SHOP IS ON THE WRONG KIND OF REALM. A Common realm lives for the
 *      process; an Inner one is destroyed when the last body leaves, taking its
 *      shelves with it.
 *   2. THE SHOP EXISTS ON ONE BUILD PATH AND NOT THE OTHER. Shared realms are
 *      opened eagerly at boot AND lazily by `open`; wiring only the first leaves
 *      a town with no shelves down a path only some tests take.
 *   3. CLEARING PLAYER-SOLD GOODS DELETES THE SHOP'S OWN. Stock is a list with
 *      legal duplicates, so an id is not an identity — the flag has to travel
 *      with the slot.
 */

function realms(seed: string): ReturnType<typeof createRealms> {
  return createRealms({ seed, engineFor: (world) => createTurnEngine({ world }) });
}

function shopRealm(seed: string): Realm {
  const all = realms(seed);
  const found = all.all().find((realm) => realm.shop !== undefined);
  if (found === undefined) throw new Error('no realm has a shop');
  return found;
}

describe('where a shop lives', () => {
  it('is on a shared realm, never an instanced one', () => {
    // THE CORRECTNESS ARGUMENT, not a preference: `close` refuses a shared
    // realm and `empty()` only ever returns Inner ones, so a Common realm is
    // built once and lives for the process. A shop on an Inner realm would have
    // its shelves dropped with the realm when the last body left, and the next
    // party through the door would find a different shop wearing the same name.
    for (const realm of realms('shop-placement').all()) {
      if (realm.shop === undefined) continue;
      expect(realm.kind).toBe('common');
    }
  });

  it('exists on exactly the towns that are meant to have one, with the shelf each keeps', () => {
    /**
     * TWO NOW, AND THE SECOND ONE NEEDED A SECOND SHELF TO BE WORTH ADDING.
     *
     * `SHOP_SITES` argued for one shop and said *"when a second shop lands it is
     * one string here"*. A shop stocking the same catalogue would not have been
     * a second destination, it would have been the same shop further away — so
     * the string arrived with `ShopShelf`, and Ashwick sells what you drink
     * while Threadneedle sells what you wear.
     *
     * Ashwick is named ALCHEMY ROW and has had a mixer standing in it since the
     * towns were populated, saying "I mix what the Index has not read yet" over
     * an empty counter.
     */
    const withShops = realms('shop-count')
      .all()
      .filter((realm) => realm.shop !== undefined)
      .map((realm) => [realm.siteId, realm.shop?.shelf]);
    expect(withShops).toEqual([
      ['site:threadneedle_row', 'outfitter'],
      ['site:ashwick_row', 'apothecary'],
    ]);
  });

  it('makes the apothecary the only place a draught exists', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * MEASURED, AND IT CAUGHT AN ITEM NOBODY COULD REACH.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * Nothing drops draughts — 300 `rollLoot` rolls produced 300 items and zero
     * of them — so the shelf is the only source. And the shelf produced NOTHING
     * on its first build: `SHOP_EGO_CHANCE` says shop goods are never plain and
     * discards anything with no ego, a draught cannot take one (it has no slot,
     * so every ego filter refuses it), and the fill loop threw it away
     * sixty-four times and gave up.
     *
     * So the item shipped one commit earlier was reachable by nobody at all —
     * the exact "built and wired to nothing" failure this project keeps finding
     * in its own work, caught by asking the shop what was on its shelf rather
     * than by trusting that adding an item adds an item.
     */
    const ashwick = realms('shop-draughts')
      .all()
      .find((realm) => realm.siteId === 'site:ashwick_row');
    expect(ashwick).toBeDefined();
    if (ashwick === undefined) return;

    expect(catchUpShop(ashwick, 3)).toBe(true);
    expect(ashwick.shop?.stock.length ?? 0).toBeGreaterThan(0);
    for (const slot of ashwick.shop?.stock ?? []) {
      expect(slot.id, 'the apothecary is selling something you cannot drink').toBe(
        'item_draught_mending',
      );
    }
  });

  it('starts at epoch -1 with empty shelves, so batch 0 is still owed', () => {
    // Not 0. `epochFor` returns 0 for every party below level 5, so a shop that
    // began at 0 would be considered current and would stand empty until
    // somebody reached level 5.
    const realm = shopRealm('shop-birth');
    expect(realm.shop?.epoch).toBe(-1);
    expect(realm.shop?.stock).toEqual([]);
  });
});

describe('catchUpShop', () => {
  it('fills the shelves the first time anybody opens the door', () => {
    const realm = shopRealm('shop-first-open');
    expect(catchUpShop(realm, 1)).toBe(true);
    expect(realm.shop?.epoch).toBe(0);
    expect(realm.shop?.stock).toHaveLength(NB_FILL);
  });

  it('does nothing at all on a second visit at the same level', () => {
    // A shop nobody has levelled past costs nothing to walk into. If this ever
    // starts returning true, the door is doing work on every step.
    const realm = shopRealm('shop-idle');
    catchUpShop(realm, 1);
    const before = JSON.stringify(realm.shop?.stock);
    expect(catchUpShop(realm, 1)).toBe(false);
    expect(JSON.stringify(realm.shop?.stock)).toBe(before);
  });

  it('is a pure function of (seed, shop, epoch, level)', () => {
    // Each batch forks on `shop:<id>:<epoch>` and `fork` is pure, so the same
    // call sequence on the same seed rebuilds the identical shelf — which is
    // what makes a lost batch re-derivable rather than guessed at.
    const a = shopRealm('shop-determinism');
    const b = shopRealm('shop-determinism');
    catchUpShop(a, 25);
    catchUpShop(b, 25);
    expect(a.shop?.stock).toEqual(b.shop?.stock);
    expect(a.shop?.epoch).toBe(b.shop?.epoch);
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * A CATCH-UP IS NOT THE SAME SHELF AS HAVING VISITED ALL ALONG, AND THAT IS
   * CORRECT.
   * ═══════════════════════════════════════════════════════════════════════════
   * The first draft of this file asserted they were equal and it failed, which
   * was the test being wrong rather than the loop: every batch is generated for
   * the party that WALKS IN, so a level-25 party catching up four epochs gets
   * four batches of level-25 goods, where a party that visited at 1, 8, 14 and
   * 25 accumulated one batch from each. Upstream behaves the same way —
   * `loadup` takes the level it is called with.
   *
   * It is also the better behaviour: coming back after a long delve should not
   * hand you the shelf you would have had if you had never left.
   */
  it('stocks a catch-up for the party that walks in, not for the party they were', () => {
    const lazy = shopRealm('shop-catchup');
    catchUpShop(lazy, 25);

    const eager = shopRealm('shop-catchup');
    catchUpShop(eager, 1);
    catchUpShop(eager, 25);

    expect(lazy.shop?.epoch).toBe(eager.shop?.epoch);
    expect(lazy.shop?.stock).not.toEqual(eager.shop?.stock);
  });

  it('grows a batch per epoch, so levelling up is worth walking back into town', () => {
    // THE POINT OF THE EPOCH. Topping up to a fixed four would mean a shop
    // nobody buys from is finished after its first visit — still holding what
    // it rolled for a level-1 party when that party is level 40.
    const realm = shopRealm('shop-grows');
    catchUpShop(realm, 1);
    expect(realm.shop?.stock).toHaveLength(NB_FILL);

    catchUpShop(realm, 12);
    expect(realm.shop?.stock.length ?? 0).toBeGreaterThan(NB_FILL);
  });

  it('caps the shelf, so a level-50 party is not reading a wall', () => {
    const realm = shopRealm('shop-capped');
    catchUpShop(realm, 50);
    expect(realm.shop?.stock.length).toBeLessThanOrEqual(SHELF_CAP);
  });

  it('accumulates rather than emptying — Store.lua `empty_before_restock = false`', () => {
    // Something walked past at level 9 is still there at 40: a restock KEEPS
    // what it was handed and adds to it.
    const realm = shopRealm('shop-accumulate');
    catchUpShop(realm, 1);
    const first = realm.shop?.stock.map((slot) => slot.id) ?? [];

    catchUpShop(realm, 25);
    const after = realm.shop?.stock.map((slot) => slot.id) ?? [];
    expect(after.slice(0, first.length)).toEqual(first);
  });

  it('CLEARS WHAT A PLAYER SOLD IN, and only that', () => {
    // Two lines upstream that stop the shop becoming a free storage chest and
    // stop a sell-then-rebuy loop persisting junk.
    const realm = shopRealm('shop-sold-cleared');
    catchUpShop(realm, 1);
    const shopsOwn = realm.shop?.stock.map((slot) => slot.id) ?? [];

    addSoldItem(realm, 'item_leather_chest');
    expect(realm.shop?.stock.some((slot) => slot.playerSold)).toBe(true);

    catchUpShop(realm, 25);
    expect(realm.shop?.stock.some((slot) => slot.playerSold)).toBe(false);
    // ...and the shop's own goods are untouched.
    expect(realm.shop?.stock.map((slot) => slot.id).slice(0, shopsOwn.length)).toEqual(shopsOwn);
  });

  it('does not delete the shop’s copy of an item the player sold an identical one of', () => {
    // THE HAZARD A `Set<string>` WOULD HAVE WALKED INTO. Stock is a list with
    // legal duplicates, so an id is not an identity: filtering sold goods by id
    // membership would take the shop's coat off the shelf along with the
    // player's, and the symptom would be stock quietly thinning over an evening
    // for no reason anybody could reconstruct.
    const realm = shopRealm('shop-duplicate');
    catchUpShop(realm, 1);
    const twin = realm.shop?.stock[0]?.id;
    if (twin === undefined) throw new Error('unreachable');

    addSoldItem(realm, twin);
    expect(realm.shop?.stock.filter((slot) => slot.id === twin)).toHaveLength(2);

    catchUpShop(realm, 25);
    // Exactly one survives: the shop's. The player's copy carried the flag.
    expect(realm.shop?.stock.filter((slot) => slot.id === twin && !slot.playerSold)).toHaveLength(
      1,
    );
    expect(realm.shop?.stock.filter((slot) => slot.playerSold)).toHaveLength(0);
  });

  it('is a no-op on a realm with no shop', () => {
    const overworld = realms('shop-none').overworld;
    expect(overworld.shop).toBeUndefined();
    expect(catchUpShop(overworld, 40)).toBe(false);
  });
});

describe('taking things off the shelf', () => {
  it('removes BY INDEX, so two identical items are two slots', () => {
    // The duplicate problem a third time. "Remove the one with this id" is
    // ambiguous when two slots hold the same string; an index is not.
    const realm = shopRealm('shop-take');
    catchUpShop(realm, 1);
    const before = realm.shop?.stock.map((slot) => slot.id) ?? [];

    const taken = takeFromShelf(realm, 1);
    expect(taken?.id).toBe(before[1]);
    expect(realm.shop?.stock.map((slot) => slot.id)).toEqual([
      ...before.slice(0, 1),
      ...before.slice(2),
    ]);
  });

  it('refuses an index that is not on the shelf, rather than removing something else', () => {
    const realm = shopRealm('shop-take-bad');
    catchUpShop(realm, 1);
    const size = realm.shop?.stock.length ?? 0;
    expect(takeFromShelf(realm, -1)).toBeUndefined();
    expect(takeFromShelf(realm, size)).toBeUndefined();
    expect(takeFromShelf(realm, 1.5)).toBeUndefined();
    expect(realm.shop?.stock).toHaveLength(size);
  });
});
