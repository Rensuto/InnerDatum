// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from
//   t-engine4 game/modules/tome/class/GameState.lua:1108-1163 (`drop_tables.normal` — the
//              depth-banded quality weights this table is derived from)
//   t-engine4 game/modules/tome/class/GameState.lua:1324 (`bound(math.ceil(level/10), 1, 5)`)
//   t-engine4 game/modules/tome/class/GameState.lua:1345-1436 (`entityFilterAlter` — the item
//              does not decide how many egos it gets; a rolled CATEGORY forces the count)
//   t-engine4 game/engines/default/engine/Zone.lua:640-670 (the natural-ego loop, one per slot)
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" — https://te4.org/license

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *   HOW GOOD A DROP IS, DECIDED BY THE WORLD RATHER THAN BY THE ITEM
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The genuinely important finding in ToME's loot system is a negative one:
 * **an item has no say in how many egos it gets.** A depth-banded weight table
 * rolls a CATEGORY — plain, one ego, two egos, money — and the category then
 * forces the count. Quality is a property of where you are, not of the sword.
 *
 * That is what makes loot feel like it belongs to a place. Everything a level-1
 * party finds is mostly plain because the BAND says so, and the same sword
 * found later is likelier to have a name on it without one number on the sword
 * changing.
 *
 * Upstream expresses this by MUTATING a filter table through five patched-on
 * hook functions. We return an enum. Same shape, and it can be read.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * EVERY DRAW HERE IS ON A PER-DROP FORK, AND THAT IS THE WHOLE TRICK
 * ═══════════════════════════════════════════════════════════════════════════
 * `shared/rng.ts:31-39` states the constraint: adding or removing a draw shifts
 * every later draw on that stream forever. So none of these draws go on
 * `world.loot`. They go on `world.lootRng.fork('loot.ego:<actor>:<n>')`, and
 * `fork` is a pure function of (state, inc, label) that DOES NOT ADVANCE ITS
 * PARENT (rng.ts:261-274).
 *
 * Therefore **the number of draws this file takes is not load-bearing**. Add an
 * ego next year, change the quality table, add a third slot: `world.loot` still
 * sits at exactly two draws per monster, `world.turn` and `world.spawn` are
 * byte-identical, and no seeded test moves. That converts "every future loot
 * change is a stream-breaking change" into "none of them are", which is the
 * single most valuable line in the port plan.
 *
 * The fork LABEL must be unique per fork — rng.ts:266-272 warns that
 * `fork('monster')` in a loop hands every monster the same sequence. It carries
 * the actor id and the drop index for that reason. (The parent's state has also
 * advanced by then, so a re-seeded floor forks differently even for a monster
 * whose id is reused; the label is belt to that braces.)
 *
 * NO CLOCK, NO `Math.random`, NO MODULE STATE. One `Rng` in, one string out.
 */

import { EGO_TAG_ORDER, egosForTag } from './egos.ts';
import { computeRarities, pickEntity } from './rarity.ts';
import { MAX_EGO_POWER, formatItemId } from './resolve.ts';
import { itemById } from './items.ts';
import type { ItemEgoRef } from './resolve.ts';
import type { Rng } from '../../shared/rng.ts';

/**
 * What a drop turned out to be.
 *
 * ToME's nine categories collapse to four. `uniques`, `greater`,
 * `greater_normal` and `double_greater` all depend on the greater-ego tier,
 * which the port plan cut because `Object.lua:489-499` shows nothing in the
 * engine reads it — the real gating is the co-declared `level_range`, which we
 * do port. `lore` has no analogue.
 */
export const LootQuality = {
  Plain: 'plain',
  Ego: 'ego',
  DoubleEgo: 'double_ego',
  Money: 'money',
} as const;
export type LootQuality = (typeof LootQuality)[keyof typeof LootQuality];

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE BANDS. FIVE OF THEM, AND PRE-M6 EVERY PARTY IS IN BAND 1.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Derived from `drop_tables.normal` (GameState.lua:1108-1163) with the greater
 * columns folded into `double_ego`.
 *
 * WEIGHTS ARE NOT NORMALISED, DELIBERATELY. Upstream's band 1 totals 112.5 and
 * that is fine: the roll is over the running total, so a designer changes one
 * number without rebalancing the row. Normalising would turn every tuning edit
 * into four edits, three of which are arithmetic.
 */
export const QUALITY_BANDS: readonly (readonly { quality: LootQuality; weight: number }[])[] =
  Object.freeze([
    // band 1 — levels 1-10. Mostly plain, which is what makes the first named
    // thing a party finds an event rather than a Tuesday.
    Object.freeze([
      { quality: LootQuality.Plain, weight: 38 },
      { quality: LootQuality.Ego, weight: 45 },
      { quality: LootQuality.DoubleEgo, weight: 20 },
      { quality: LootQuality.Money, weight: 7 },
    ]),
    // band 2 — 11-20
    Object.freeze([
      { quality: LootQuality.Plain, weight: 25 },
      { quality: LootQuality.Ego, weight: 40 },
      { quality: LootQuality.DoubleEgo, weight: 28 },
      { quality: LootQuality.Money, weight: 8 },
    ]),
    // band 3 — 21-30
    Object.freeze([
      { quality: LootQuality.Plain, weight: 10 },
      { quality: LootQuality.Ego, weight: 25 },
      { quality: LootQuality.DoubleEgo, weight: 50 },
      { quality: LootQuality.Money, weight: 8 },
    ]),
    // band 4 — 31-40
    Object.freeze([
      { quality: LootQuality.Plain, weight: 6 },
      { quality: LootQuality.Ego, weight: 12 },
      { quality: LootQuality.DoubleEgo, weight: 74 },
      { quality: LootQuality.Money, weight: 8 },
    ]),
    // band 5 — 41+
    Object.freeze([
      { quality: LootQuality.Plain, weight: 5 },
      { quality: LootQuality.Ego, weight: 5 },
      { quality: LootQuality.DoubleEgo, weight: 85 },
      { quality: LootQuality.Money, weight: 8 },
    ]),
  ]);

/**
 * Which band a party is in. `bound(ceil(level / 10), 1, 5)` — GameState.lua:1324.
 *
 * Returns a 1-BASED band number, as upstream does, so the citation reads
 * straight across. Index `QUALITY_BANDS` with `band - 1`.
 */
export function bandFor(level: number): number {
  if (!Number.isFinite(level)) return 1;
  return Math.min(QUALITY_BANDS.length, Math.max(1, Math.ceil(level / 10)));
}

/**
 * PARTY MAX LEVEL, which is Inner Datum's substitute for a zone level.
 *
 * There is no zone level here: the overworld is one map and a site is a room.
 * Party MAX rather than average or the killer's own, for one reason — it cannot
 * be gamed by benching a high-level character, and it tracks the frontier of
 * what the party can actually use. Recorded in DECISIONS.md as a decision, not
 * as a port; ToME fires the equivalent on the single player's level because
 * ToME has a single player.
 *
 * Defaults to 1 for an empty world, which is also what pre-M6 gives, and band 1
 * is then the only band any of this reaches.
 */
export function partyMaxLevel(levels: readonly number[]): number {
  let max = 1;
  for (const level of levels) {
    if (Number.isFinite(level) && level > max) max = level;
  }
  return max;
}

/**
 * DRAW 1 — the category. One float over the running total.
 *
 * `GameState.lua:1369` is `rng.float(0, total)`; ours is `nextFloat` scaled,
 * which is the same distribution in one draw.
 */
export function rollQuality(rng: Rng, band: number): LootQuality {
  const row = QUALITY_BANDS[Math.min(QUALITY_BANDS.length, Math.max(1, band)) - 1];
  if (row === undefined || row.length === 0) return LootQuality.Plain;

  let total = 0;
  for (const entry of row) total += entry.weight;

  const roll = rng.nextFloat('ego.category') * total;
  let seen = 0;
  for (const entry of row) {
    seen += entry.weight;
    if (roll < seen) return entry.quality;
  }
  // Unreachable — `roll < total` and `seen` ends at `total`. Returned rather
  // than thrown: a content edit is not worth a crash on a live floor.
  return LootQuality.Plain;
}

/** How many ego slots a category fills. The category decides, not the item. */
export function egoCountFor(quality: LootQuality): number {
  if (quality === LootQuality.Ego) return 1;
  if (quality === LootQuality.DoubleEgo) return 2;
  return 0;
}

/**
 * Roll the egos for one base item and return the instance id.
 *
 * @param rng THE PER-DROP FORK, not `world.lootRng`. See the file header.
 * @param baseId what `loot.pick` returned. Returned unchanged if it names
 *   nothing this build knows, if the category came up plain, or if no ego was
 *   eligible — a base item is always a valid answer.
 * @param level party max level, for both the band and `computeRarities`.
 *
 * DRAWS, IN THIS ORDER: `ego.category`, then per slot filled `ego.pick` and
 * `ego.power`. The plan reserved an `ego.slot` draw for choosing among declared
 * slots; there are exactly two tags and the loop fills them in `EGO_TAG_ORDER`,
 * so there is nothing to choose and the draw would be a coin flip whose outcome
 * is ignored. It is not taken. (`ego.money` lands with the currency.)
 */
export function rollEgos(rng: Rng, baseId: string, level: number): string {
  const base = itemById(baseId);
  if (base === undefined) return baseId;

  const quality = rollQuality(rng, bandFor(level));
  const wanted = egoCountFor(quality);
  // MONEY IS PLAIN FOR NOW, and the column stays in the table on purpose: when
  // currency lands, that is a change to what `money` PRODUCES rather than a
  // change to the weights, and changing the weights would move every seed's
  // loot for everyone.
  if (wanted === 0) return baseId;

  const refs: ItemEgoRef[] = [];
  for (let i = 0; i < wanted && i < EGO_TAG_ORDER.length; i += 1) {
    const tag = EGO_TAG_ORDER[i];
    if (tag === undefined) continue;

    // `checkFilter`, Zone.lua:290-296: an ego that names slots may only land on
    // one of them. Applied inside `computeRarities` so a rejected candidate
    // costs nothing, exactly as upstream applies its filter.
    const candidates = computeRarities(
      egosForTag(tag),
      level,
      (ego) => ego.slots === undefined || ego.slots.includes(base.slot),
    );

    // DRAW — one, whatever the roster size.
    const ego = pickEntity(rng, `ego.pick`, candidates);
    // Nothing eligible at this level for this slot. `pickEntity` took no draw,
    // and a one-ego item is a perfectly good answer to a double_ego roll — the
    // alternative is refusing to drop anything, which is worse.
    if (ego === undefined) continue;

    // DRAW — the magnitude. `rng.mbonus` is a C builtin and the reference clone
    // ships no `src/`, so this is a REIMPLEMENTATION of a stated contract
    // rather than a translation — the standing ruling content/resolvers.ts:36-42
    // already records, and the same one `rollDrop`'s `rng.percent` makes.
    const power = rng.int('ego.power', 0, MAX_EGO_POWER);
    refs.push({ code: ego.code, power });
  }

  if (refs.length === 0) return baseId;
  return formatItemId(baseId, refs);
}
