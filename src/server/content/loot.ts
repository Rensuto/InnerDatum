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
import { MAX_EGO_POWER, MAX_MATERIAL, MIN_MATERIAL, formatItemId } from './resolve.ts';
import { itemById } from './items.ts';
import { moneyIdFor, rollMoney } from './money.ts';
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
 * ═══════════════════════════════════════════════════════════════════════════
 * WHICH BAND A PARTY IS IN — AND FOUR OF THE FIVE WERE UNREACHABLE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `bound(ceil(level / 10), 1, 5)` — GameState.lua:1324, ported verbatim, and
 * verbatim was wrong here for a reason that is invisible from inside this file:
 * **ToME's characters go to level 50 and this game's cap is 10.**
 * `MAX_CHARACTER_LEVEL` was 10, so `ceil(10 / 10)` is 1 and EVERY CHARACTER AT
 * EVERY LEVEL FROM THE FIRST HUSK TO THE LAST CASE WAS BAND 1.
 *
 * Measured over twenty thousand rolls a band, which is what the table was
 * quietly holding back:
 *
 *     band   plain     ego   double-ego   money
 *       1    34.2%   41.5%       17.9%    6.4%   <- the only one anybody saw
 *       2    24.8%   39.9%       27.1%    8.2%
 *       3    10.5%   26.7%       54.2%    8.7%
 *       4     5.9%   12.1%       74.0%    8.0%
 *       5     4.8%    4.9%       82.5%    7.8%
 *
 * A whole authored progression — from mostly-plain to four in five carrying two
 * egos — switched off by an arithmetic mismatch between a ported divisor and
 * this game's own ceiling. It is also the answer to *"what does a finished
 * character do"*: the gear chase was there the whole time and nobody could
 * reach it.
 *
 * ═══ THE DIVISOR IS UPSTREAM'S AGAIN (2026-08-20) ═══
 * It was 2 for a while, and the argument for that was sound at the time: five
 * bands across a character's whole life is the shape worth keeping, upstream
 * spans 1..50 in steps of ten, and this game spanned 1..10 — so the same five
 * bands were steps of two.
 *
 * The cap is 50 now (`MAX_CHARACTER_LEVEL`), which puts the ported formula back
 * inside the domain it was written for. `ceil(level / 10)` bands at 10, 20, 30,
 * 40 and 50 exactly as GameState.lua:1324 intends, and the transposition that
 * kept it honest at a cap of 10 becomes the thing making it wrong.
 *
 * THE LESSON SURVIVES THE CHANGE, and it is why this paragraph stays: a formula
 * copied past the point where its assumptions hold is not fidelity, it is the
 * appearance of it. That was true of the divisor then and it is true of the cap
 * now — four separate ported formulas were sitting outside their own domain
 * because of it. See `MAX_CHARACTER_LEVEL` for the other three.
 *
 * Returns a 1-BASED band number, as upstream does. Index `QUALITY_BANDS` with
 * `band - 1`.
 */
export const LEVELS_PER_BAND = 10;

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT GRADE THIS FIND IS. The band, and one step of luck either side of it.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The band already answers "how deep is this character", 1 through 5 across
 * fifty levels — so it IS the grade, and drawing one from thin air would be a
 * second progression curve to keep in step with the first.
 *
 * ═══ THE SPREAD IS WHAT MAKES A DROP WORTH READING ═══
 * Grade == band exactly would mean every item found at a given level is
 * identical in power, and the only variance left in a drop would be its ego.
 * One step either way gives a band-3 character grade 2, 3 or 4: a find that is
 * a little better than the last one is the smallest unit of loot that is worth
 * picking up, and this is where it comes from.
 *
 * ═══ CLAMPED, NOT WRAPPED ═══
 * A band-1 character rolls 1 or 2 and never 0; a band-5 one rolls 4 or 5 and
 * never 6. The clamp is what makes the early game's floor a real floor — a
 * level-2 player cannot find a grade-0 anything — and it slightly favours the
 * middle grade at both ends, which is the correct shape: the extremes should be
 * rarer than the middle.
 *
 * ONE DRAW, LABELLED, and taken unconditionally so the stream does not depend
 * on what the quality roll decided — `rng.ts` states the consequence of a
 * conditional draw and `populateDelve` carries the same warning.
 */
export function materialFor(rng: Rng, level: number): number {
  const band = bandFor(level);
  const drift = rng.int('loot.material', -1, 1);
  return Math.min(MAX_MATERIAL, Math.max(MIN_MATERIAL, band + drift));
}

export function bandFor(level: number): number {
  if (!Number.isFinite(level)) return 1;
  return Math.min(QUALITY_BANDS.length, Math.max(1, Math.ceil(level / LEVELS_PER_BAND)));
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
 * Roll what actually dropped, given the base `loot.pick` chose, and return its
 * id — which may be an ego'd item or may be a coin pile.
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
export function rollLoot(rng: Rng, baseId: string, level: number): string {
  const base = itemById(baseId);
  if (base === undefined) return baseId;

  const band = bandFor(level);
  /**
   * THE GRADE IS DRAWN BEFORE THE QUALITY AND UNCONDITIONALLY.
   *
   * Before, so that a money result — which returns early two lines down — has
   * still taken the same draw as an item result. A draw that happened only on
   * some branches would make every later roll from that seed depend on which
   * branch was taken, and `rng.ts` is explicit that this breaks
   * replay-from-seed. The value is simply discarded on the money path.
   */
  const material = materialFor(rng, level);
  const quality = rollQuality(rng, band);

  // MONEY REPLACES THE ITEM ENTIRELY. The weights did not move when this
  // landed, and that was the point of keeping the column in the table while it
  // still produced a plain base: changing a weight moves every seed's loot for
  // everybody, and changing what a category PRODUCES moves only that category.
  if (quality === LootQuality.Money) return moneyIdFor(rollMoney(rng, band));

  const wanted = egoCountFor(quality);
  // A PLAIN ITEM IS STILL A GRADED ITEM. `formatItemId` writes nothing extra
  // for grade 1, so the commonest early find is the same bare string it always
  // was — and a plain grade-4 coat is a real drop rather than an impossible one.
  if (wanted === 0) return formatItemId(baseId, [], material);

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
      (ego) =>
        base.slot !== undefined && (ego.slots === undefined || ego.slots.includes(base.slot)),
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

  return formatItemId(baseId, refs, material);
}
