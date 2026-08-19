import { MAX_CHARACTER_LEVEL } from '../../src/shared/progression.ts';
import { describe, expect, it } from 'vitest';

import {
  bandOf,
  BUY_HIGH,
  BUY_LOW,
  NB_FILL,
  PURSE,
  SELL_PERCENT,
  baseCost,
  buyPercent,
  buyPrice,
  epochFor,
  priceOf,
  restock,
  sellPrice,
  ShopShelf,
  stockLevelFor,
  stockSeedLabel,
} from '../../src/server/content/shops.ts';
import { ITEMS } from '../../src/server/content/items.ts';
import { isMoneyId, moneyIdFor } from '../../src/server/content/money.ts';
import { resolveItem } from '../../src/server/content/resolve.ts';
import { createRng } from '../../src/shared/rng.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *   THE SPREAD IS THE ECONOMY. EVERYTHING ELSE HERE IS TUNING.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * You buy at 123% and sell at 5%. If those two ever cross — at any price point,
 * for any item — a player can buy something and sell it back for more, and the
 * shop becomes a printing press. That is the property this file is really
 * about; the rest is arithmetic with citations.
 */

const COAT = 'item_watchmans_coat';
const CHEST = 'item_leather_chest';

describe('the price curve', () => {
  it('pins the fit at both ends — Store.lua:34-36 through Combat.lua:1521-1530', () => {
    // `combatTalentScale(max(1, L), 123, 135, "log")` fits x_low=1, x_high=5.
    // At L=1, log10(1) = 0, so the answer is exactly `b` = 123.
    expect(buyPercent(1)).toBeCloseTo(BUY_LOW, 6);
    expect(buyPercent(5)).toBeCloseTo(BUY_HIGH, 6);
    // And it is monotonic between and beyond them — `combatTalentScale` does not
    // clamp at the top, and neither does this.
    expect(buyPercent(3)).toBeGreaterThan(buyPercent(1));
    expect(buyPercent(20)).toBeGreaterThan(buyPercent(5));
  });

  it('treats a level below 1 as 1, because log10(0) is negative infinity', () => {
    // `math.max(1, tl)` at Combat.lua:1523. Without it a level-0 item would
    // price at -Infinity percent, and the first symptom would be a shop paying
    // the player to take things.
    expect(buyPercent(0)).toBe(BUY_LOW);
    expect(buyPercent(-9)).toBe(BUY_LOW);
    expect(buyPercent(Number.NaN)).toBe(BUY_LOW);
  });
});

describe('what a thing is worth', () => {
  it('is the base tier plus every ego cost', () => {
    // `applyEgo` does not strip `cost` (Zone.lua:539-546), so ego cost adds.
    // `rf` is 15, `lg` is 15; the coat is rare, so 25.
    expect(baseCost('rare')).toBe(25);
    expect(priceOf(COAT)).toBe(25);
    expect(priceOf(`${COAT}~rf1`)).toBe(25 + 15);
    expect(priceOf(`${COAT}~rf1.lg1`)).toBe(25 + 15 + 15);
  });

  it('rises with tier', () => {
    expect(baseCost('common')).toBeLessThan(baseCost('uncommon'));
    expect(baseCost('uncommon')).toBeLessThan(baseCost('rare'));
    expect(priceOf(CHEST)).toBeLessThan(priceOf(COAT));
  });

  it('prices nothing it cannot read', () => {
    expect(priceOf('item_cut_before_ship')).toBe(0);
    expect(priceOf(`${COAT}~zz1`)).toBe(0);
    // MONEY IS NOT SELLABLE. Selling gold for a fraction of gold is a bug
    // shaped like a feature, and it would be a real one: `sellPrice` would
    // happily quote 5% of a coin pile.
    expect(priceOf(moneyIdFor(40))).toBe(0);
    expect(sellPrice(moneyIdFor(40))).toBe(0);
    expect(buyPrice(moneyIdFor(40), 1)).toBe(0);
  });
});

describe('the spread', () => {
  /**
   * THE TEST THIS FILE EXISTS FOR.
   *
   * Swept across every base, every ego combination and a range of levels. If
   * buy ever falls to sell, the economy is a printing press — and the failure
   * would not look like a bug from the inside, it would look like a player
   * getting rich.
   */
  it('never lets a sale beat a purchase, for any item at any level', () => {
    const ids = [CHEST, COAT, `${COAT}~rf3`, `${COAT}~rf3.lg3`, `${CHEST}~ol0`, `${CHEST}~wd3.cr3`];
    for (const id of ids) {
      expect(resolveItem(id), `${id} is not a real item`).not.toBeUndefined();
      for (const level of [1, 2, 5, 10, 25, 50]) {
        expect(sellPrice(id)).toBeLessThan(buyPrice(id, level));
      }
    }
  });

  it('will take anything a player can actually carry home', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * A SHOP THAT REFUSES YOUR LOOT IS A SHOP THAT TEACHES YOU NOT TO PICK IT UP.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * MEASURED over 600 rolls off the real bases at level 12: 19% of loot (105
     * of 554) priced at ZERO, and `handleShopSell` answers those with *"the shop
     * will not take that"*. Every PLAIN catalogue base was in that group, which
     * is precisely what a new player is carrying.
     *
     * `items.ts` already makes the argument, about the iron ingot: *"An item
     * that changes no number is worse than no item: it teaches the player that
     * picking things up is not worth the turn it costs."*
     *
     * THE RATIO IS UNTOUCHED — the assertion below still passes, because the fix
     * was a floor on the ROUNDING and not a change to `SELL_PERCENT`. Upstream's
     * 5% is a real number against upstream's prices, which are in the hundreds;
     * ours are 5 to 12, so it floored away.
     */
    for (const item of ITEMS) {
      // Money is the one deliberate refusal and is asserted separately above.
      expect(sellPrice(item.id), `${item.id} cannot be sold at all`).toBeGreaterThan(0);
    }
  });

  it('is roughly 24:1 at the shallow end, which is the number that matters', () => {
    // 123% against 5%. The ratio is what stops arbitrage and it is why shop
    // stock can afford to be strictly better than floor loot.
    expect(BUY_LOW / SELL_PERCENT).toBeGreaterThan(24);
    expect(BUY_LOW / SELL_PERCENT).toBeLessThan(25);
  });

  it('caps what a shop pays PER ITEM, not per transaction', () => {
    // `Store.lua:253,260` applies the purse inside `forAllStack`, so it is a
    // ceiling on each item. We have no stacks, so it is simply per item.
    const rich = `${COAT}~rf3.lg3`;
    expect(Math.floor((priceOf(rich) * SELL_PERCENT) / 100)).toBeLessThanOrEqual(PURSE);
    expect(sellPrice(rich)).toBeLessThanOrEqual(PURSE);
  });

  it('never charges nothing, and never quotes a fraction', () => {
    // A free item is an infinite supply of something — the only way this
    // economy could break from the buying side.
    for (const id of [CHEST, COAT, `${COAT}~rf0`]) {
      expect(buyPrice(id, 1)).toBeGreaterThanOrEqual(1);
      expect(Number.isInteger(buyPrice(id, 1))).toBe(true);
      expect(Number.isInteger(sellPrice(id))).toBe(true);
    }
  });
});

describe('stock', () => {
  it('is never plain and never money — GameState.lua:1165-1221', () => {
    // The one-line policy that makes gold worth carrying. A shop selling the
    // same plain coats the floor drops would make buying strictly irrational at
    // a 24:1 spread.
    const rng = createRng('stock-quality');
    for (let i = 0; i < 40; i += 1) {
      for (const id of restock(rng, [], 1)) {
        expect(isMoneyId(id)).toBe(false);
        expect(id).toContain('~');
        expect(resolveItem(id), `${id} is not a real item`).not.toBeUndefined();
      }
    }
  });

  it('tops up to nb_fill and keeps what was already there', () => {
    // `empty_before_restock = false` on every shop in basic.lua: stock
    // ACCUMULATES, so a player who walked past something at level 9 can still
    // find it at 40.
    const rng = createRng('stock-topup');
    expect(restock(rng, [], 1)).toHaveLength(NB_FILL);

    const kept = [`${COAT}~rf1`, `${CHEST}~ol1`];
    const after = restock(rng, kept, 1);
    expect(after).toHaveLength(NB_FILL);
    expect(after.slice(0, 2)).toEqual(kept);
  });

  it('adds nothing when the shelves are already full', () => {
    const rng = createRng('stock-full');
    const full = [`${COAT}~rf1`, `${COAT}~rf2`, `${COAT}~rf3`, `${CHEST}~ol1`, `${CHEST}~ol2`];
    const before = rng.getState().count;
    expect(restock(rng, full, 1)).toEqual(full);
    // AND IT TAKES NO DRAWS DOING IT, so opening a full shop repeatedly cannot
    // walk the shop stream forward and change what the NEXT restock produces.
    expect(rng.getState().count).toBe(before);
  });

  it('terminates even when nothing can be generated', () => {
    // `engine/Store.lua:76-98` advances its counter when generation returns nil
    // but NOT when `post_filter` rejects, so a restrictive filter retries
    // without bound. On a 22-item catalogue that is a live hang, not a
    // hypothetical — hence the attempt cap.
    const rng = createRng('stock-terminates');
    const stock = restock(rng, [], 10_000);
    expect(stock.length).toBeLessThanOrEqual(NB_FILL);
  });

  it('is a pure function of its seed', () => {
    const run = (): readonly string[] => restock(createRng('shop:general:3'), [], 8);
    expect(run()).toEqual(run());
    expect(restock(createRng('shop:general:4'), [], 8)).not.toEqual(run());
  });

  it('labels a batch by shop and epoch, so a lost one can be re-derived', () => {
    expect(stockSeedLabel('general', 0)).toBe('shop:general:0');
    expect(stockSeedLabel('general', 3)).toBe('shop:general:3');
  });
});

describe('the restock epoch', () => {
  it('is an integer that only ever goes up', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THIS PINNED UPSTREAM'S CADENCE AGAINST UPSTREAM'S RANGE.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `Actor.lua:3740` fires on level 5 then each multiple of ten, and the old
     * assertions checked 5, 10, 19, 20 — levels a character in THIS game cannot
     * reach. Across the career that actually exists it produced three epochs,
     * and the mid-game (5 through 9) was a single shelf that never changed.
     *
     * Same fault as `bandFor`, same question: does the input span the range it
     * did upstream? The cadence is now `LEVELS_PER_BAND`, shared with the loot
     * bands so the shelf is restocked and better at the same moments.
     */
    expect(epochFor(1)).toBe(0);
    expect(epochFor(2)).toBe(1);
    expect(epochFor(3)).toBe(1);
    expect(epochFor(10)).toBe(5);

    let previous = -1;
    for (let level = 1; level <= MAX_CHARACTER_LEVEL; level += 1) {
      const epoch = epochFor(level);
      expect(epoch).toBeGreaterThanOrEqual(previous);
      previous = epoch;
    }
  });

  it('turns the shelves over several times inside the level cap', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE GUARD THAT WOULD HAVE CAUGHT IT.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * A shop nobody has a reason to walk back into is not a shop. Before this,
     * a whole career saw three epochs and levels 5-9 — where a player spends
     * most of their time and most of their gold — were one static shelf.
     *
     * Stated against `MAX_CHARACTER_LEVEL` rather than a literal, so moving the
     * cap or the cadence either keeps the property or fails here. Four is a
     * floor, not the design: the design is one per `LEVELS_PER_BAND`.
     */
    const epochs = new Set<number>();
    for (let level = 1; level <= MAX_CHARACTER_LEVEL; level += 1) epochs.add(epochFor(level));
    expect(epochs.size).toBeGreaterThanOrEqual(4);
  });

  it('gives every single level-up a reason to look in', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE FIRST VERSION OF THIS TEST CLAIMED THEY MOVE TOGETHER. THEY DO NOT.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * It asserted that a band change always comes with a restock, and failed at
     * level 3: `bandOf` is `ceil(level / 2)` and `epochFor` is `floor(level /
     * 2)`, so they are offset by one. The claim was mine and it was wrong.
     *
     * What is actually true is better, and is worth having as the assertion:
     * they INTERLEAVE. Measured across the career —
     *
     *     2  restock          3  better quality
     *     4  restock          5  better quality
     *     6  restock          7  better quality
     *     8  restock          9  better quality
     *    10  restock
     *
     * — so every level from the second to the cap changes the shelves, in
     * contents or in quality, alternately. A player who levels has a reason to
     * put their head round the door every single time, which is more than
     * "both at once" would have bought.
     */
    let lastEpoch = epochFor(1);
    let lastBand = bandOf(1);
    for (let level = 2; level <= MAX_CHARACTER_LEVEL; level += 1) {
      const epoch = epochFor(level);
      const band = bandOf(level);
      expect(
        epoch !== lastEpoch || band !== lastBand,
        `nothing about the shop changed on reaching level ${String(level)}`,
      ).toBe(true);
      lastEpoch = epoch;
      lastBand = band;
    }
  });

  it('makes batch 0 explicit rather than reproducing `or 8`', () => {
    // `Store.lua:74`'s fallback level and its `stores_restock_levels[0]`
    // nil-index are accidents of Lua's 1-based tables, not design.
    expect(epochFor(0)).toBe(0);
    expect(epochFor(-3)).toBe(0);
    expect(epochFor(Number.NaN)).toBe(0);
  });
});

describe('the first purchase in a career', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * A NEW PLAYER MUST ALWAYS BE ABLE TO BUY SOMETHING SOMEWHERE.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * MEASURED over 400 rolled shelves at level 1, against the 15 gold a character
   * starts with (`STARTING_MONEY`):
   *
   *     Threadneedle (Outfitter)   buyable 0.0%    cheapest ever 24g, median 33g
   *     Ashwick     (Apothecary)   buyable 100.0%  cheapest ever 14g, median 14g
   *
   * That split is the design working, not a fault, and it is worth writing down
   * before somebody "fixes" the Outfitter: armour is the thing you save nine
   * more gold for, and the Apothecary is where a purse that has never been
   * filled can still buy something. The Draught of Mending is 14g at level 1 —
   * uncommon, base 12, x123% — which is a one-gold margin and clearly authored
   * as the opening buy.
   *
   * A ONE-GOLD MARGIN IS EXACTLY WHY THIS IS PINNED. Any of `baseCost`,
   * `BUY_LOW`, the draught's tier, or `STARTING_MONEY` moving by a single point
   * silently makes the first shop in the game sell a new player nothing, and
   * nothing else in the suite would notice — the shelf would still roll, the
   * price would still be correct, and the transcript would just read
   * "15 gold buys 0 of 4" as it did before any of this was measured.
   */
  it('always stocks the apothecary with something a starting purse can buy', () => {
    const STARTING_MONEY = 15;
    let worst = 0;
    for (let i = 0; i < 200; i += 1) {
      const stock = restock(
        createRng(`opening-buy:${String(i)}`),
        [],
        1,
        undefined,
        ShopShelf.Apothecary,
      );
      expect(stock.length, `roll ${String(i)} produced an empty shelf`).toBeGreaterThan(0);
      const cheapest = Math.min(...stock.map((id) => buyPrice(id, stockLevelFor(1))));
      worst = Math.max(worst, cheapest);
    }
    expect(worst, 'a level-1 apothecary shelf priced out a starting purse').toBeLessThanOrEqual(
      STARTING_MONEY,
    );
  });

  it('leaves the outfitter as something to save for rather than a second apothecary', () => {
    /**
     * THE OTHER HALF, so this pair cannot be satisfied by making everything
     * cheap. If the Outfitter ever starts undercutting a starting purse the two
     * shops have collapsed into one, which `ShopShelf`'s own docstring calls the
     * thing that makes a second shop "the same shop, further away".
     */
    let cheapestSeen = Infinity;
    for (let i = 0; i < 200; i += 1) {
      const stock = restock(
        createRng(`save-for-it:${String(i)}`),
        [],
        1,
        undefined,
        ShopShelf.Outfitter,
      );
      if (stock.length === 0) continue;
      cheapestSeen = Math.min(cheapestSeen, ...stock.map((id) => buyPrice(id, stockLevelFor(1))));
    }
    expect(cheapestSeen).toBeGreaterThan(15);
  });
});
