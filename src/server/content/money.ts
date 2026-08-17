// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from
//   t-engine4 game/modules/tome/data/general/objects/money.lua:29-36 (`on_prepickup` — a coin pile
//              adds to `who.money` and REFUSES to enter the inventory)
//   t-engine4 game/modules/tome/data/general/objects/money.lua:38-45 (the pile amount)
//   t-engine4 game/modules/tome/class/Actor.lua:260 (`money = 0`), :1686-1699 (`incMoney`, clamped)
//   t-engine4 game/modules/tome/data/birth/descriptors.lua:74 (a character starts with 15)
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" — https://te4.org/license

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *        A COIN PILE IS AN ITEM ID THAT IS NOT AN ITEM, AND THAT IS
 *        DELIBERATE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `item_iron_ingot@14` is fourteen gold lying on the floor. It travels every
 * path an item id travels — a monster's `carried`, the spill on death, a
 * `GroundItem`, the wire — because those paths all take a string and none of
 * them needed changing. But `resolveItem` does NOT know it, and that is the
 * point:
 *
 *   AN `Item` HAS A `slot`. A coin pile does not, and giving it one — Trinket,
 *   say, because something has to go there — would put a lie in the catalogue
 *   that the equip path, the paper doll and `wornOf` would each have to be
 *   taught to ignore. Four places that must agree, to avoid one that says
 *   nothing.
 *
 * So money is a NARROW special case in exactly the four places that handle a
 * loose id, each of which is listed here so the set is auditable:
 *
 *   `spillOrderOf`  (turn-engine.ts)  — a corpse must be able to drop it
 *   `projectGroundItems` (projector)  — it must be drawable on the floor
 *   `handlePickup`  (gateway.ts)      — it becomes gold, not a bag entry
 *   `rollLoot`      (content/loot.ts) — it is what the `money` category makes
 *
 * Everywhere else, `resolveItem` returning `undefined` is exactly right: money
 * is not something you wear, compare, or keep in a bag.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE ICON WAS ALREADY ON DISK, WAITING FOR THIS
 * ═══════════════════════════════════════════════════════════════════════════
 * `items.ts:283-289` explains that `item_iron_ingot` is the 23rd icon, present
 * in the manifest and deliberately unauthored, because "we have no currency, no
 * vendor and no crafting, so its only property would be occupying an inventory
 * cell. An item that changes no number is worse than no item."
 *
 * That is still true of an INGOT and is why one is still not in `ITEMS`. What
 * changed is that there is now a currency for its sprite to depict.
 */

import type { Rng } from '../../shared/rng.ts';

/** Base from amount. A third grammar character, and it never mixes with `~`. */
export const MONEY_SEPARATOR = '@';

/** The asset the pile draws as. Not in `KNOWN_ICON_IDS` — see the header. */
export const MONEY_ICON = 'item_iron_ingot';

/** The id before the amount. Shares the icon's name because it depicts it. */
export const MONEY_BASE_ID = 'item_iron_ingot';

/**
 * How big a pile can get, which is what BOUNDS THE ID LENGTH.
 *
 * Three digits, so the longest money id is `item_iron_ingot@999` — 19
 * characters against the 64-character wire cap. Unbounded amounts would make
 * the id length a function of the economy, and the first symptom would be an
 * equip frame refused by `z.string().max()` for a reason nobody could see.
 */
export const MAX_MONEY_PILE = 999;

/**
 * The smallest pile worth being a drop.
 *
 * ToME's own pile is `rng.avg(4,10)/10` — 0.4 to 1.0 gold, with ZERO depth
 * scaling (money.lua:38-45), because its design intent is that gold comes from
 * SELLING and coins are rounding. Ours scales with the band so that a pile
 * stays a real but small fraction of a sale, and it is whole gold: no float
 * currency, for the same reason ego magnitudes are integers.
 */
export const MIN_MONEY_PILE = 2;

/** Build a coin id. The one writer, so the grammar has a single spelling. */
export function moneyIdFor(amount: number): string {
  const clamped = Math.max(MIN_MONEY_PILE, Math.min(MAX_MONEY_PILE, Math.floor(amount)));
  return `${MONEY_BASE_ID}${MONEY_SEPARATOR}${String(clamped)}`;
}

/**
 * How much this id is worth, or `undefined` if it is not money.
 *
 * STRICT, like `parseItemId` and for the same reason: this runs on strings off
 * the wire and out of files, and accepting a half-parsed one would credit a
 * player the wrong number silently. Leading zeros, signs, decimals, an empty
 * amount and anything over the cap are all refused rather than coerced.
 */
export function moneyAmountOf(id: string): number | undefined {
  const cut = id.indexOf(MONEY_SEPARATOR);
  if (cut <= 0) return undefined;
  if (id.slice(0, cut) !== MONEY_BASE_ID) return undefined;

  const digits = id.slice(cut + 1);
  if (!/^[1-9][0-9]{0,2}$/.test(digits)) return undefined;
  const amount = Number(digits);
  if (amount < MIN_MONEY_PILE || amount > MAX_MONEY_PILE) return undefined;
  return amount;
}

/** Whether this id names money at all. */
export function isMoneyId(id: string): boolean {
  return moneyAmountOf(id) !== undefined;
}

/** What the Case Log calls it. Singular is possible; `MIN_MONEY_PILE` is 2. */
export function moneyName(amount: number): string {
  return `${String(amount)} gold`;
}

/**
 * How much a pile is worth at this band. ONE DRAW, labelled `ego.money`.
 *
 * Taken on the same per-drop fork as the rest of the quality roll, so — like
 * every other draw in that file — its count is not load-bearing.
 */
export function rollMoney(rng: Rng, band: number): number {
  const base = rng.int('ego.money', 2, 6);
  return Math.min(MAX_MONEY_PILE, Math.max(MIN_MONEY_PILE, base * Math.max(1, band)));
}
