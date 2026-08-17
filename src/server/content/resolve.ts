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
 * There are no egos. `EGO_CODES` is empty, so every id with a `~` in it is an
 * id this build does not know, and `resolveItem` says so by returning
 * `undefined` — which is the answer every caller already handles, because a
 * build that drops an item another build authored is a case the save loader,
 * the projector and the pickup path were all written for.
 *
 * That is deliberate. The grammar ships first and unused: nothing a player can
 * see changes, and every step after this one is a content edit rather than a
 * refactor of twelve call sites under a deadline.
 */

import { ITEM_ID_MAX_CHARS } from '../../shared/protocol.ts';
import { ITEMS, itemById } from './items.ts';
import type { Item } from './items.ts';

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
 * Every ego code that exists. EMPTY, ON PURPOSE — see the file header.
 *
 * A real lookup against real content, which happens to have nothing in it yet.
 * `resolveItem` takes the same path it will take when the roster is authored,
 * so the "unknown ego" branch is exercised by every test in this build rather
 * than being a branch nobody runs until the day it matters.
 */
const EGO_CODES: ReadonlySet<string> = new Set<string>();

/**
 * An id to the item it names, or `undefined` if this build does not know it.
 *
 * PURE. It is called from the projector, the save loader, the gateway and the
 * pickup path, and a draw in any one of those would mean that *rendering an
 * inventory mutates the world*.
 *
 * A plain id returns the catalogue's own object BY IDENTITY, so nothing that
 * held an `Item` before this file existed sees a different object now.
 */
export function resolveItem(id: string): Item | undefined {
  const parsed = parseItemId(id);
  if (parsed === undefined) return undefined;

  const base = itemById(parsed.base);
  if (base === undefined) return undefined;
  if (parsed.egos.length === 0) return base;

  // Unknown egos make the whole item unknown, rather than resolving to a bare
  // base wearing the wrong name. An item that silently lost its egos would read
  // to the player as a bug in the loot, and to the save file as a downgrade
  // nobody asked for.
  for (const ego of parsed.egos) {
    if (!EGO_CODES.has(ego.code)) return undefined;
  }

  // Unreachable while `EGO_CODES` is empty. The fold lands here in the step that
  // authors the roster; until then an ego'd id is an id this build does not know
  // and every caller already handles that.
  return undefined;
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
