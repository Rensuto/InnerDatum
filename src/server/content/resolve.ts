// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported (SHAPE ONLY — the grammar below is ours) from
//   t-engine4 game/engines/default/engine/Zone.lua:521-556 (`applyEgo` — an ego is a partial
//              entity merged onto a base, and the base's own name is rebuilt by concatenation)
//   t-engine4 game/engines/default/engine/Zone.lua:554-612 (`__original` / `ego_list` /
//              `reapplyEgos` — the machinery this file REPLACES; see "WHY AN ID AND NOT AN OBJECT")
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" — https://te4.org/license

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *        AN ITEM'S IDENTITY IS A STRING, AND THE STRING DESCRIBES IT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ```
 * item_watchmans_coat                 a plain item — every id that exists today
 * item_watchmans_coat~ba2             one ego, `ba`, at power 2
 * item_watchmans_coat~ba2.wd1         two egos, in canonical order
 * ```
 *
 * `~` separates the base from its egos, `.` separates egos, and the last
 * character of an ego token is its power. `resolveItem` splits that apart,
 * looks the pieces up and folds them. It takes no RNG, no clock, no registry
 * handle and no persistence — the same id resolves to the same item in the
 * projector, in the save loader and in a test, forever.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY AN ID AND NOT AN ITEM-INSTANCE OBJECT
 * ═══════════════════════════════════════════════════════════════════════════
 * This codebase already carries item identity as a bare string through five
 * independent layers, and an instance object would have changed all five:
 *
 *   the wire, twice   `itemId: z.string()` on equip/drop, and on every view
 *   the save file     `carried?: string[]`, `equipped?: Record<string,string>`
 *   the world         `GroundItem.itemId` — "an id, never the resolved object"
 *   the actor         `actor.carried`, `actor.equipped`
 *
 * So the id grew a grammar instead. `SCHEMA_VERSION` does not move, no save
 * migrates, and an old save's plain ids resolve exactly as they always did.
 *
 * It also deletes work rather than adding it. ToME keeps `__original`, an
 * `ego_list` of post-resolve clones, and `reapplyEgos` — about ninety lines of
 * Lua whose entire purpose is being able to remove an ego without re-rolling
 * it. **Our id IS the ego list and this file IS `reapplyEgos`**, so none of it
 * gets ported.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * NOTHING IN THE GAME BUILDS ONE OF THESE IDS YET
 * ═══════════════════════════════════════════════════════════════════════════
 * `resolveItem('item_watchmans_coat~rf2')` returns a real Reinforced Watchman's
 * Coat with real numbers on it — but no drop, no shop and no spawn constructs
 * such an id, so no player has seen one. The roll lands separately.
 *
 * That order is deliberate and it is the reason this file is testable at all:
 * the entire ego system can be exercised with a string literal and no world, no
 * seed and no monster. When the roll does arrive, the only question left open
 * is which id it builds.
 */

import { ITEM_ID_MAX_CHARS } from '../../shared/protocol.ts';
import { EGO_TAG_ORDER, EgoSlotTag, egoByCode, egoWielder, tierWeight } from './egos.ts';
import { ITEMS, itemById } from './items.ts';
import type { Ego } from './egos.ts';
import type { Item, ItemTier } from './items.ts';

/** Base from egos. */
export const EGO_SEPARATOR = '~';
/** Ego from ego. */
export const EGO_DELIMITER = '.';

/**
 * An ego code is exactly two characters of `[a-z0-9]`.
 *
 * FIXED WIDTH SO THE POWER DIGIT IS FOUND BY POSITION rather than by a regex
 * that has to decide where a name ends and a number begins. Two characters is
 * 1,296 codes against a roster the plan sizes at about thirty.
 */
export const EGO_CODE_LENGTH = 2;

/**
 * The strongest an ego rolls. `int(0, 3)` — see the plan's note on `rng.mbonus`,
 * which is a C builtin absent from the reference clone and therefore
 * reimplemented from its stated contract rather than translated.
 */
export const MAX_EGO_POWER = 3;

/**
 * How many egos one item may carry: a prefix and a suffix.
 *
 * ToME's loop fills each declared slot AT MOST ONCE (Zone.lua:650-668), so "how
 * many egos can this have" is data rather than code. Two is the whole ceiling
 * here, and it is what bounds the id length below.
 */
export const MAX_EGOS = 2;

/**
 * The power digit is base 36, so a single character covers every power a future
 * roster could want without the token growing and without re-parsing old saves.
 */
const POWER_DIGITS = '0123456789abcdefghijklmnopqrstuvwxyz';

/** One ego token, parsed. */
export type ItemEgoRef = {
  /** Two characters. Looked up in the ego roster; unknown means unknown item. */
  readonly code: string;
  /** 0..`MAX_EGO_POWER`. */
  readonly power: number;
};

/** An id, taken apart. */
export type ParsedItemId = {
  /** The part before the `~`. Always a plain catalogue id, never resolved here. */
  readonly base: string;
  /** In id order, which is canonical order. Empty for a plain id. */
  readonly egos: readonly ItemEgoRef[];
};

/**
 * Take an id apart, or return `undefined` if it is not one.
 *
 * STRICT, AND THAT IS THE POINT: this runs on strings out of save files and off
 * the wire, and the one thing worse than rejecting a malformed id is accepting
 * a half-parsed one and quietly resolving it to the wrong item. It does NOT
 * check that the base exists or that the codes name real egos — those are
 * catalogue questions and they belong to `resolveItem`.
 */
export function parseItemId(id: string): ParsedItemId | undefined {
  if (id.length === 0 || id.length > ITEM_ID_MAX_CHARS) return undefined;

  const cut = id.indexOf(EGO_SEPARATOR);
  if (cut < 0) return { base: id, egos: [] };
  // A `~` at either end, or a second one: not an id, and never a base id with a
  // stray character on it. Refuse rather than guess.
  if (cut === 0 || cut === id.length - 1) return undefined;
  if (id.indexOf(EGO_SEPARATOR, cut + 1) >= 0) return undefined;

  const base = id.slice(0, cut);
  const tokens = id.slice(cut + 1).split(EGO_DELIMITER);
  if (tokens.length > MAX_EGOS) return undefined;

  const egos: ItemEgoRef[] = [];
  const seen = new Set<string>();
  for (const token of tokens) {
    if (token.length !== EGO_CODE_LENGTH + 1) return undefined;
    const code = token.slice(0, EGO_CODE_LENGTH);
    if (!/^[a-z0-9]+$/.test(code)) return undefined;
    // THE SAME EGO TWICE IS NOT A STRONGER ITEM, it is an id nothing should
    // have built — the roll fills each slot once. Two ids for one item would
    // also break the "an item is its id" rule the bag's de-duplication rests on.
    if (seen.has(code)) return undefined;
    seen.add(code);

    const power = POWER_DIGITS.indexOf(token.charAt(EGO_CODE_LENGTH));
    if (power < 0 || power > MAX_EGO_POWER) return undefined;
    egos.push({ code, power });
  }

  return { base, egos };
}

/**
 * Build an id from its parts.
 *
 * The ONE writer, so canonical order is a property of the code rather than a
 * convention every call site has to remember. Callers hand egos in roster order
 * and get the string that goes on the wire, into the save file and into the
 * bag's identity check.
 */
export function formatItemId(base: string, egos: readonly ItemEgoRef[]): string {
  if (egos.length === 0) return base;
  const tokens = egos.map((ego) => `${ego.code}${POWER_DIGITS.charAt(ego.power)}`);
  return `${base}${EGO_SEPARATOR}${tokens.join(EGO_DELIMITER)}`;
}

/**
 * How much brighter an ego'd item's tier reads. `Object.lua:517-527` colours an
 * object by how many egos it carries; we say the same thing in the field that
 * already exists, so `ItemView.tier` and `GroundItemView.tier` need no new key
 * and protocol.ts:1580-1581's rule — "the client must not infer it" — holds,
 * because the server still computes it.
 */
const TIER_BY_WEIGHT: readonly ItemTier[] = Object.freeze(['common', 'uncommon', 'rare']);

/**
 * An id to the item it names, or `undefined` if this build does not know it.
 *
 * PURE. It is called from the projector, the save loader, the gateway and the
 * pickup path, and a draw in any one of those would mean that *rendering an
 * inventory mutates the world*.
 *
 * A plain id returns the catalogue's own object BY IDENTITY, so nothing that
 * held an `Item` before this file existed sees a different object now.
 *
 * ═══ WHAT AN EGO CHANGES, AND WHAT IT DELIBERATELY DOES NOT ═══
 * `name` is rebuilt by concatenation, `wielder` is the additive merge, and
 * `tier` climbs one step per ego. `icon` and `desc` are the BASE'S, untouched:
 * there is no ego art, and items.ts:697-703 throws at import on an unknown icon
 * precisely so a violet fallback box cannot ship. An ego'd coat looks like a
 * coat, which is also true in ToME.
 */
export function resolveItem(id: string): Item | undefined {
  const parsed = parseItemId(id);
  if (parsed === undefined) return undefined;

  const base = itemById(parsed.base);
  if (base === undefined) return undefined;
  if (parsed.egos.length === 0) return base;

  // ─── LOOK EVERY EGO UP FIRST ───
  // An unknown code makes the whole item unknown rather than resolving to a bare
  // base wearing a shortened name. Silently losing an ego would read to a player
  // as a bug in the loot and to the save file as a downgrade nobody asked for,
  // and "this build does not know that item" is a case every caller handles.
  const egos: Ego[] = [];
  for (const ref of parsed.egos) {
    const ego = egoByCode(ref.code);
    if (ego === undefined) return undefined;
    egos.push(ego);
  }

  // ─── ONE SLOT, ONCE, IN ORDER ───
  // Zone.lua:650-668 fills each declared slot at most once, so `~rf2.ol1` (two
  // prefixes) and `~lg1.rf2` (a suffix before a prefix) are not items — they are
  // a second spelling of something, and two spellings of one item is exactly
  // what breaks the bag's "an item is its id" de-duplication.
  let seenTag = -1;
  for (const ego of egos) {
    const rank = EGO_TAG_ORDER.indexOf(ego.tag);
    if (rank <= seenTag) return undefined;
    seenTag = rank;
  }

  // ─── SLOT LEGALITY ───
  // An ego that only goes on an offhand cannot be on a ring, however the id got
  // written. The roll already respects this; a hand-edited save does not.
  for (const ego of egos) {
    if (ego.slots !== undefined && !ego.slots.includes(base.slot)) return undefined;
  }

  // ─── THE MERGE. NUMBERS ADD, AND THAT IS THE WHOLE RULE ───
  const stats: Record<string, number> = { ...base.wielder.stats };
  const mods: Record<string, number> = { ...base.wielder.mods };
  for (const [index, ego] of egos.entries()) {
    const ref = parsed.egos[index];
    if (ref === undefined) continue;
    const wielder = egoWielder(ego, ref.power, base.tier);
    for (const [key, value] of Object.entries(wielder.stats ?? {})) {
      stats[key] = (stats[key] ?? 0) + value;
    }
    for (const [key, value] of Object.entries(wielder.mods ?? {})) {
      mods[key] = (mods[key] ?? 0) + value;
    }
  }

  const merged: { stats?: typeof stats; mods?: typeof mods } = {};
  if (Object.keys(stats).length > 0) merged.stats = stats;
  if (Object.keys(mods).length > 0) merged.mods = mods;

  // Prefixes carry their own trailing space and suffixes their own leading one
  // (`validateEgos` proves it), so this is concatenation with no separator
  // logic — Zone.lua:527-531 exactly.
  let name = base.name;
  for (const ego of egos) {
    name = ego.tag === EgoSlotTag.Prefix ? `${ego.name}${name}` : `${name}${ego.name}`;
  }

  const weight = Math.min(TIER_BY_WEIGHT.length, tierWeight(base.tier) + egos.length);

  return Object.freeze({
    ...base,
    id,
    name,
    tier: TIER_BY_WEIGHT[weight - 1] ?? base.tier,
    wielder: merged,
  });
}

// ---------------------------------------------------------------------------
// The import-time checks
// ---------------------------------------------------------------------------

/**
 * The longest id this grammar can ever produce, from the constants above rather
 * than from a number somebody wrote down once.
 *
 * `base` + `~` + `MAX_EGOS` tokens + the delimiters between them.
 */
export function worstCaseIdLength(longestBaseId: number): number {
  return (
    longestBaseId +
    EGO_SEPARATOR.length +
    MAX_EGOS * (EGO_CODE_LENGTH + 1) +
    (MAX_EGOS - 1) * EGO_DELIMITER.length
  );
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * IT THROWS AT MODULE LOAD, WHICH TAKES THE SERVER DOWN BEFORE THE FIRST
 * CONNECTION — the same trade `validateItems` and `_loadoutArityCheck` make.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Two things, and the second is the one that would hurt.
 *
 * 1. NO AUTHORED ID CONTAINS A GRAMMAR CHARACTER. A base id with a `~` in it
 *    would parse as some other item plus an ego, which is a silent misresolve
 *    rather than an error.
 * 2. THE WORST-CASE ID FITS THE WIRE. `ITEM_ID_MAX_CHARS` is a `z.string().max()`
 *    on the equip and drop schemas, so an id one character over it is not a
 *    caught error — it is an item a player can hold, can see, and cannot equip,
 *    and the same length is what a save file round-trips. Checked against the
 *    longest id the CATALOGUE actually has, so authoring a longer item is what
 *    trips it rather than a comment going stale.
 */
export function assertIdGrammarFits(items: readonly Item[]): number {
  let longest = 0;
  for (const item of items) {
    if (item.id.includes(EGO_SEPARATOR) || item.id.includes(EGO_DELIMITER)) {
      throw new Error(
        `resolve: item id '${item.id}' contains a grammar character ` +
          `('${EGO_SEPARATOR}' or '${EGO_DELIMITER}') — it would parse as another item plus an ego`,
      );
    }
    longest = Math.max(longest, item.id.length);
  }

  const worst = worstCaseIdLength(longest);
  if (worst > ITEM_ID_MAX_CHARS) {
    throw new Error(
      `resolve: the longest id this grammar can build is ${String(worst)} characters ` +
        `(base '${String(longest)}' + ${String(MAX_EGOS)} egos), over the ` +
        `${String(ITEM_ID_MAX_CHARS)}-character wire cap — an item a player could hold ` +
        `and could not equip`,
    );
  }
  return worst;
}

/** The check, run. Exported so it is not dead code to the compiler. */
export const WORST_CASE_ID_LENGTH: number = assertIdGrammarFits(ITEMS);
