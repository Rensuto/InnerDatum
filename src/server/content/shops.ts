// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from
//   t-engine4 game/modules/tome/class/Store.lua:32-40 (`init` — buy_percent 5, sell_percent scaled)
//   t-engine4 game/modules/tome/class/Store.lua:250-268 (`getObjectPrice` — the two directions)
//   t-engine4 game/modules/tome/class/interface/Combat.lua:1515-1536 (`combatTalentScale`, "log")
//   t-engine4 game/engines/default/engine/Store.lua:54-98 (`canRestock` / `loadup` — the epoch, the
//              catch-up loop, `empty_before_restock`, `__force_store_forget`)
//   t-engine4 game/modules/tome/data/general/stores/basic.lua:25-27 (purse 25, nb_fill 4)
//   t-engine4 game/modules/tome/class/GameState.lua:1165-1221 (`drop_tables.store` — never plain)
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" — https://te4.org/license

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *              ONE SHOP, AND A SPREAD OF ROUGHLY TWENTY-FOUR TO ONE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `data/general/stores/basic.lua` defines THIRTY-THREE shops that differ only
 * in their filter, their purse and `nb_fill`. Inner Datum has 22 base items
 * across 7 slots — one shop covers the catalogue, and thirty-three would be
 * thirty-two filters over an empty set.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE ONE NUMBER THAT HOLDS THE ECONOMY UP
 * ═══════════════════════════════════════════════════════════════════════════
 * You buy at 123% and you sell at 5%. That ~24:1 spread is not flavour — it is
 * the whole reason a shop cannot be farmed, and it is why shop stock can afford
 * to be strictly BETTER than floor loot without breaking anything. Port the
 * ratio before anything else; every other number here is tuning.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * UPSTREAM'S FIELD NAMES ARE INVERTED AND IT WILL CATCH YOU OUT
 * ═══════════════════════════════════════════════════════════════════════════
 * In `getObjectPrice`, `what == "buy"` means THE PLAYER BUYS, and it reads
 * `store.sell_percent` — the shop's selling price. `what == "sell"` means the
 * player sells and reads `store.buy_percent`. The names are from the SHOP's
 * point of view and every call site is from the player's.
 *
 * Both functions below are named from the PLAYER's side, once, here, so nobody
 * has to hold that inversion in their head twice.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * NOT A TRAP, AND NOT A DIALOG THAT FIRES CALLBACKS ACROSS FRAMES
 * ═══════════════════════════════════════════════════════════════════════════
 * ToME makes stores TRAP-layer entities purely so they can draw over a wall
 * tile, then intercepts `Player:move` so you never enter the tile
 * (`Player.lua:309-312`). That is a rendering hack for a workaround.
 *
 * And its transaction is five functions — `tryBuy`, `doBuy`, `onBuy(before)`,
 * `transfer`, `onBuy(after)` — because a modal dialog fires callbacks across
 * frames, which is why `doBuy` re-finds the object and re-checks `who.money` a
 * SECOND time inside the confirm. Non-negotiable #2 says turn resolution here is
 * fully synchronous: there is no interleaving window, so the transaction is
 * validate, debit, move, log.
 *
 * PURE. No clock, no `Math.random`, no module state. The epoch is an integer a
 * caller keeps; the stock is a pure function of (seed, shopId, epoch).
 */

import { EGO_TAG_ORDER, egoByCode, egosForTag } from './egos.ts';
import { computeRarities, pickEntity } from './rarity.ts';
import { MAX_EGO_POWER, formatItemId, parseItemId } from './resolve.ts';
import { ITEMS, itemById } from './items.ts';
import { isMoneyId } from './money.ts';
import { bandFor } from './loot.ts';
import type { ItemEgoRef } from './resolve.ts';
import type { ItemTier } from './items.ts';
import type { Rng } from '../../shared/rng.ts';

// ---------------------------------------------------------------------------
// What a thing is worth
// ---------------------------------------------------------------------------

/**
 * Base gold by tier. `swords.lua:40,54,68,82,96` runs 5/10/15/25/35 across five
 * material levels; ours is three because `ItemTier` is three (see egos.ts on
 * why there is no second axis).
 *
 * DERIVED FROM `tier` RATHER THAN AUTHORED PER ITEM, deliberately. A `cost`
 * field on all 22 rows would be 22 numbers to keep in a relationship that the
 * tier already expresses — and the first one somebody forgot to update after a
 * retune would be a rare item selling for a common price, silently.
 */
export function baseCost(tier: ItemTier): number {
  if (tier === 'rare') return 25;
  if (tier === 'uncommon') return 12;
  return 5;
}

/**
 * What an item is worth before either margin.
 *
 * `applyEgo` strips `unided_name`, `__CLASSNAME`, `__ATOMIC`, `uid`, `rarity`
 * and `level_range` — and NOTHING ELSE (`Zone.lua:539-546`) — so an ego's own
 * `cost` adds to the base's. That is the entire valuation.
 *
 * ═══ `getPriceFlags` IS NOT PORTED, AND THAT IS A DECISION ═══
 * `Object.lua:2165-2296` is 130 lines walking ~90 stat keys to price an item by
 * what it does. Half of them name resources that do not exist here — vim, hate,
 * psi, equilibrium, `ammo_reload_speed`, `size_category`. A partial port would
 * price some properties and silently ignore others, which is worse than pricing
 * none of them: it would make two similar items differ for a reason no player
 * could see. `cost` on the ego row is the whole valuation.
 *
 * Returns 0 for anything that is not a sellable item — money included, because
 * selling gold for a fraction of gold is a bug shaped like a feature.
 */
export function priceOf(id: string): number {
  if (isMoneyId(id)) return 0;
  const parsed = parseItemId(id);
  if (parsed === undefined) return 0;
  const base = itemById(parsed.base);
  if (base === undefined) return 0;

  let price = baseCost(base.tier);
  for (const ref of parsed.egos) {
    const ego = egoByCode(ref.code);
    if (ego === undefined) return 0;
    price += ego.cost;
  }
  return price;
}

/**
 * The percentage a player PAYS, as a function of item level. 123 → 135.
 *
 * `Store.lua:34-36` is
 * `combatTalentScale(max(1, o.__store_level or 1), 123, 135, "log")`, and
 * `Combat.lua:1521-1530` fits `m = (135 - 123) / (log10(5) - log10(1))` with
 * `b = 123`.
 *
 * ═══ INLINED RATHER THAN DRAGGING THE GENERIC SCALER ACROSS ═══
 * `combatTalentScale` exists to map a TALENT LEVEL onto a range, and Inner
 * Datum has no talent-level concept that a shop price could plausibly be a
 * function of. Porting the general form would import six parameters, four of
 * them unused, and a `math.max(0, ...)` clamp that is dead code at these
 * constants — 123 is never negative. So the two constants are fitted once and
 * the citation carries the derivation. `test/server/shops.test.ts` pins
 * `L=1 → 123` and `L=5 → 135` next to it.
 */
export const BUY_LOW = 123;
export const BUY_HIGH = 135;
/** `(135 - 123) / (log10(5) - log10(1))`. Written out so the fit is checkable. */
export const BUY_SLOPE = (BUY_HIGH - BUY_LOW) / Math.log10(5);

export function buyPercent(level: number): number {
  const clamped = Number.isFinite(level) ? Math.max(1, level) : 1;
  return BUY_LOW + BUY_SLOPE * Math.log10(clamped);
}

/**
 * The percentage a player RECEIVES. `Store.lua:33`, flat.
 *
 * The gem branch — 40% for `type == "gem"` — has no analogue here and is cut.
 */
export const SELL_PERCENT = 5;

/**
 * The most a shop pays for ONE item. `basic.lua:25`.
 *
 * PER UNIT, not per transaction: `Store.lua:253,260` applies it inside
 * `forAllStack`, so it is a ceiling on each item's price. We have no stacks, so
 * it is simply per item.
 *
 * THERE IS NO SHOP WALLET. The shop never runs out of money — upstream has no
 * such concept, and adding one would mean a player who found something good
 * being told to come back later, which is a punishment for succeeding.
 */
export const PURSE = 25;

/**
 * What the player pays for one item. Whole gold — see `PlayerActor.money`.
 *
 * FLOORED RATHER THAN ROUNDED. `Store.lua:267` rounds to 0.01 despite its own
 * trailing comment saying 0.1 (the Lua wins, per CLAUDE.md); with integer
 * currency the question is moot, and flooring is the direction that cannot
 * charge a player one gold more than the number they were shown.
 *
 * AT LEAST 1, so nothing in the shop is ever free. A zero-price item is an
 * infinite supply of something, which is the only way this economy could break
 * from the buying side.
 */
export function buyPrice(id: string, level: number): number {
  const price = priceOf(id);
  if (price <= 0) return 0;
  return Math.max(1, Math.floor((price * buyPercent(level)) / 100));
}

/**
 * What the player receives for one item, capped at the purse.
 *
 * FLOORED, so a cheap item sells for 0 rather than for a rounded-up 1 — which
 * is upstream's behaviour and is also what keeps `buyPrice` strictly greater
 * than `sellPrice` at every price point. The moment those two cross, a player
 * can buy an item and sell it back for more, and the economy is a printing
 * press.
 */
export function sellPrice(id: string): number {
  const price = priceOf(id);
  if (price <= 0) return 0;
  return Math.min(PURSE, Math.floor((price * SELL_PERCENT) / 100));
}

// ---------------------------------------------------------------------------
// Stock
// ---------------------------------------------------------------------------

/** `basic.lua:27`. How many pieces one restock batch is worth. */
export const NB_FILL = 4;

/**
 * The most a shelf may ever hold.
 *
 * A shop that grew a batch per epoch forever would be a wall of items by level
 * 50 and a scrolling problem nobody asked for. Three batches is enough that the
 * shelf visibly improves as a party levels and small enough to read at a
 * glance.
 */
export const SHELF_CAP = 12;

/**
 * The generation attempt cap, which upstream does not have.
 *
 * `engine/Store.lua:76-98` advances its counter when generation returns nil but
 * NOT when `post_filter` rejects, so a restrictive filter retries without
 * bound. On a 22-item catalogue that is a live hang rather than a hypothetical.
 */
const MAX_FILL_ATTEMPTS = 64;

/**
 * SHOP GOODS ARE NEVER PLAIN. `GameState.lua:1165-1221` sets
 * `basic = 0, money = 0, lore = 0` at every tier of the `store` table.
 *
 * One line of policy, and it is what makes gold worth carrying: if the shop
 * sold the same plain coats the floor does, the ~24:1 spread would make buying
 * strictly irrational. Flat across bands, as upstream's is.
 */
const SHOP_EGO_CHANCE = 70;

/**
 * Roll one piece of stock. Egos always, one or two of them.
 *
 * A SEPARATE FUNCTION FROM `rollLoot` RATHER THAN A FLAG ON IT, because the
 * shop's quality rule is not a band — it is "never plain, never money", which
 * is a different KIND of statement from a weight table. Sharing the roll would
 * mean a `if (forShop)` inside the loot path, and the loot path is the one
 * place in this system whose draw order is worth protecting from conditionals.
 *
 * It still shares the two things that matter: `computeRarities` decides which
 * ego, and `formatItemId` writes the id.
 */
function rollStockItem(rng: Rng, level: number): string | undefined {
  const base = pickEntity(
    rng,
    'shop.base',
    computeRarities(
      ITEMS.map((item) => ({
        item,
        // The catalogue has no `rarity`/`levelRange` of its own — `tier` is the
        // drop table (items.ts:113-121). So a shop weights by tier, which is
        // the same statement the monster tables make.
        rarity: item.tier === 'rare' ? 12 : item.tier === 'uncommon' ? 6 : 3,
        levelRange: [1, 50] as readonly [number, number],
      })),
      level,
    ),
  );
  if (base === undefined) return undefined;

  const wanted = rng.int('shop.egos', 0, 99) < SHOP_EGO_CHANCE ? 2 : 1;
  const refs: ItemEgoRef[] = [];
  for (let i = 0; i < wanted && i < EGO_TAG_ORDER.length; i += 1) {
    const tag = EGO_TAG_ORDER[i];
    if (tag === undefined) continue;
    const ego = pickEntity(
      rng,
      'shop.ego',
      computeRarities(
        egosForTag(tag),
        level,
        (candidate) => candidate.slots === undefined || candidate.slots.includes(base.item.slot),
      ),
    );
    if (ego === undefined) continue;
    refs.push({ code: ego.code, power: rng.int('shop.power', 0, MAX_EGO_POWER) });
  }

  // Nothing eligible at this level. A plain item is NOT the fallback — see
  // SHOP_EGO_CHANCE — so this piece of stock simply does not exist, and the
  // fill loop tries again.
  if (refs.length === 0) return undefined;
  return formatItemId(base.item.id, refs);
}

/**
 * Top the shelves up to `NB_FILL`, keeping what is already there.
 *
 * `empty_before_restock = false` on every shop in `basic.lua`, so stock
 * ACCUMULATES: a player who walked past something at level 9 can still find it
 * at level 40. The only thing ever removed is inventory the player sold, which
 * is flagged at sale time (`Store.lua:171-178`) — two lines that stop the shop
 * becoming a free storage chest and stop sell-then-rebuy loops persisting junk.
 *
 * @param keep what survived the restock — shop-generated stock, never
 *   player-sold goods. The caller owns that filter because it owns the flag.
 */
export function restock(
  rng: Rng,
  keep: readonly string[],
  level: number,
  /**
   * HOW FULL THE SHELF SHOULD END UP. Defaults to one batch.
   *
   * ═══ WHY THIS IS A PARAMETER AND NOT ALWAYS `NB_FILL` ═══
   * Upstream tops up to a fixed `nb_fill` every restock, which means a shop
   * nobody buys from is DONE after its first batch: four items, generated for a
   * level-1 party, sitting there unchanged at level 40. Upstream gets away with
   * it because it has 33 shops and a catalogue of thousands; here it would make
   * the restock epoch a number that changes nothing a player can see.
   *
   * So a shop's shelf grows a batch per epoch, bounded — see `SHELF_CAP`. That
   * makes levelling up visibly worth walking back into town for, which is the
   * only thing the epoch was ever for.
   */
  target: number = NB_FILL,
): string[] {
  const stock = [...keep];
  const want = Math.max(0, Math.min(SHELF_CAP, Math.floor(target)));
  let attempts = 0;
  while (stock.length < want && attempts < MAX_FILL_ATTEMPTS) {
    attempts += 1;
    const id = rollStockItem(rng, level);
    if (id === undefined) continue;
    // NOT A SET BY ID. Two Reinforced coats at different powers are different
    // strings already; two at the SAME power are genuinely the same item, and a
    // shelf holding two of them is a shop, not a bug.
    stock.push(id);
  }
  return stock;
}

/**
 * The epoch a party's level implies. `Actor.lua:3740` fires a restock when a
 * character hits level 5 or a multiple of 10.
 *
 * AN INTEGER, NOT A TIMER. `Store.lua:54-61` lets a shop restock iff
 * `last_filled < game.state.stores_restock`, and `loadup` is a catch-up `while`
 * loop run lazily when you open the door. Zero background work, no scheduler
 * involvement — which matters given non-negotiable #2 — and it persists as two
 * integers.
 *
 * PARTY MAX LEVEL is the input, for the reason recorded in DECISIONS.md: it
 * cannot be gamed by benching a high-level character.
 *
 * `Store.lua:74`'s `or 8` fallback and its `stores_restock_levels[0]` nil-index
 * are accidents of Lua's 1-based tables. Batch 0 is explicit here.
 */
export function epochFor(partyMaxLevel: number): number {
  if (!Number.isFinite(partyMaxLevel) || partyMaxLevel < 5) return 0;
  const level = Math.floor(partyMaxLevel);
  // One for reaching 5, then one per completed multiple of ten.
  return 1 + Math.floor(level / 10);
}

/** The level a shop stocks for. Same band input the loot tables use. */
export function stockLevelFor(partyMaxLevel: number): number {
  return Math.max(1, Math.floor(Number.isFinite(partyMaxLevel) ? partyMaxLevel : 1));
}

/** Exposed so a caller can label its fork consistently. See `world.shop`. */
export function stockSeedLabel(shopId: string, epoch: number): string {
  return `shop:${shopId}:${String(epoch)}`;
}

/** Diagnostics: how rich a band's shelves are. Never on a hot path. */
export function bandOf(partyMaxLevel: number): number {
  return bandFor(stockLevelFor(partyMaxLevel));
}
