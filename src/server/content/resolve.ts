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

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *   WHAT SEPARATES A BASE FROM ITS MATERIAL GRADE. ToME's `material_level`.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * An item in this game has been one fixed thing forever. A Watchman's Coat
 * found at level 3 and one found at level 45 are byte-identical — every number
 * on them comes off a frozen catalogue entry — so forty levels of loot has been
 * the same twenty-three objects with a different chance of a prefix on top.
 *
 * Upstream's answer is the one thing that lets a small catalogue carry a long
 * game: the same base drops in five MATERIAL GRADES, each worth more than the
 * last. One authored coat becomes five coats, and the deep bands stop being the
 * shallow bands with better egos.
 *
 * ═══ A SEPARATE TOKEN, AND ABSENT MEANS GRADE 1 ═══
 * `item_coat#3`, `item_coat#3~ab2`. Every id ever written to a save file so far
 * has no `#` in it and parses as grade 1 — which is exactly what those items
 * were — so this needs no migration and no schema bump.
 *
 * NOT FOLDED INTO THE BASE ID, which was the first design and is wrong: the
 * base is looked up in the catalogue by exact string, so `item_coat3` would be
 * an item that does not exist and `itemById` would have to learn to strip
 * digits — which would mis-parse any base whose name legitimately ends in one.
 */
export const MATERIAL_SEPARATOR = '#';

/**
 * The grades. One is what every authored item already is; five is upstream's
 * ceiling — `material_level` runs 1..5 across its whole object table.
 */
export const MIN_MATERIAL = 1;
export const MAX_MATERIAL = 5;

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT A GRADE IS WORTH. Grade 5 is twice grade 1, and nothing in between is
 * rounded away.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `1 + 0.25(m-1)` — 1.00, 1.25, 1.50, 1.75, 2.00. A clean sentence a player can
 * hold: the best version of a coat is twice the coat.
 *
 * ═══ TWO AND NOT MORE, WHICH IS THE WHOLE BALANCE DECISION ═══
 * Upstream's grades span a much wider range, and upstream has 665 objects and
 * fifty levels of zones to spread them over. Twenty-three bases means a grade-5
 * find is one of twenty-three things rather than one of hundreds — so a wider
 * curve would make the last band's drops strictly obsolete the moment a grade-5
 * appeared, and there is nothing else to find.
 *
 * ═══ ROUNDED AT THE END, NOT PER FIELD ═══
 * A coat granting `{ armour: 3, def: 1 }` at grade 3 is `{ 5, 2 }` — 4.5 and
 * 1.5, each rounded once. Rounding a running total instead would make the same
 * item worth different amounts depending on the order the fields were declared
 * in, which is the kind of bug that shows up as "my armour went down when I
 * picked up a better coat".
 *
 * A FLOOR OF 1 ON ANYTHING THAT WAS NON-ZERO. A grade cannot take a number
 * away, and `Math.round(0.4)` is 0 — an item whose one small bonus vanished at
 * a higher grade would read as broken, and it is one `Math.max`.
 */
const MATERIAL_STEP = 0.25;

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT A GRADE IS CALLED. Grade 1 is called nothing at all.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * An item whose numbers are twice another item's and whose NAME is identical is
 * a cruelty: the bag shows two "Watchman's Coat" rows, one of them is worth
 * dropping, and the only way to find out which is to read both tooltips. This
 * is the difference on the row.
 *
 * ═══ A PREFIX, IN FRONT OF THE EGO PREFIX, WHICH IS UPSTREAM'S ORDER ═══
 * "Reinforced Watchman's Coat" becomes "Fitted Reinforced Watchman's Coat" —
 * the grade is a fact about the object itself and the ego is a fact about what
 * was done to it, so the grade sits outermost. `applyEgo` (Zone.lua:527-531)
 * builds its name by the same concatenation and this joins the front of it.
 *
 * ═══ GRADE 1 IS UNNAMED, AND THAT IS NOT AN OVERSIGHT ═══
 * It is the ordinary version of the thing. Naming it "Plain Watchman's Coat"
 * would put a word on every item in the early game to distinguish it from
 * items the player has not seen yet, and would rename every object in every
 * existing save. The absence IS the grade, exactly as it is in the id.
 *
 * THE WORDS ARE MATERIALS AND TREATMENTS, not numbers or stars. "Fitted" tells
 * a player something about the coat; "Tier 3" tells them about the loot table.
 */
const MATERIAL_WORDS: readonly string[] = Object.freeze([
  '',
  'Fitted ',
  'Tailored ',
  'Reinforced Weave ',
  'Bespoke ',
]);

/** The word for a grade, or an empty string for the ordinary one. */
export function materialWord(material: number): string {
  const m = Math.max(MIN_MATERIAL, Math.min(MAX_MATERIAL, Math.floor(material)));
  return MATERIAL_WORDS[m - 1] ?? '';
}

/** The multiplier for a grade. 1.00 at grade 1, 2.00 at grade 5. */
export function materialMultiplier(material: number): number {
  const m = Math.max(MIN_MATERIAL, Math.min(MAX_MATERIAL, Math.floor(material)));
  return 1 + MATERIAL_STEP * (m - 1);
}

/** One authored number at a grade. Never smaller than it was, never zero from non-zero. */
export function atMaterial(value: number, material: number): number {
  if (value === 0) return 0;
  const scaled = Math.round(value * materialMultiplier(material));
  // SIGN-PRESERVING. A negative authored number — a heavy coat's defence
  // penalty — gets WORSE at a higher grade, which is the honest reading of "a
  // bigger version of the same thing" and stops a grade quietly erasing a
  // drawback the item was balanced around.
  return value > 0 ? Math.max(1, scaled) : Math.min(-1, scaled);
}
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
  /**
   * 1..`MAX_MATERIAL`. ONE FOR AN ID THAT DOES NOT SAY, which is every id
   * written before grades existed and every plain authored base.
   */
  readonly material: number;
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
/**
 * Take a material grade off the front half of an id, or `undefined` if the
 * grade is not one.
 *
 * ═══ ABSENT IS GRADE 1, AND THAT IS WHAT MAKES THIS NEED NO MIGRATION ═══
 * Every id ever written to a save file before this existed has no `#` in it,
 * and grade 1 is exactly what those items were. The same additive-field
 * contract every optional field in this codebase leans on, applied to a string
 * grammar rather than to an object.
 *
 * STRICT ABOUT THE REST: a `#` with nothing after it, a non-integer, a leading
 * zero, or a grade outside 1..`MAX_MATERIAL` makes the whole id unknown. This
 * runs on strings out of save files and off the wire, and the one thing worse
 * than rejecting a malformed id is resolving a half-parsed one to an item that
 * is quietly stronger than it should be.
 */
function splitMaterial(head: string): { base: string; material: number } | undefined {
  const at = head.indexOf(MATERIAL_SEPARATOR);
  if (at < 0) return { base: head, material: MIN_MATERIAL };
  if (at === 0 || at === head.length - 1) return undefined;
  if (head.indexOf(MATERIAL_SEPARATOR, at + 1) >= 0) return undefined;

  const digits = head.slice(at + 1);
  if (!/^[1-9][0-9]*$/.test(digits)) return undefined;
  const material = Number(digits);
  if (material < MIN_MATERIAL || material > MAX_MATERIAL) return undefined;
  return { base: head.slice(0, at), material };
}

export function parseItemId(id: string): ParsedItemId | undefined {
  if (id.length === 0 || id.length > ITEM_ID_MAX_CHARS) return undefined;

  /**
   * THE EGO SECTION COMES OFF FIRST, THEN THE GRADE, and the order matters: a
   * `#` inside an ego token is not a grade, and looking for one there would
   * mis-parse the day an ego code grammar grows a punctuation mark.
   */
  const cut = id.indexOf(EGO_SEPARATOR);
  if (cut < 0) {
    const plain = splitMaterial(id);
    return plain === undefined
      ? undefined
      : { base: plain.base, material: plain.material, egos: [] };
  }
  // A `~` at either end, or a second one: not an id, and never a base id with a
  // stray character on it. Refuse rather than guess.
  if (cut === 0 || cut === id.length - 1) return undefined;
  if (id.indexOf(EGO_SEPARATOR, cut + 1) >= 0) return undefined;

  const graded = splitMaterial(id.slice(0, cut));
  if (graded === undefined) return undefined;
  const { base, material } = graded;
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

  return { base, material, egos };
}

/**
 * Build an id from its parts.
 *
 * The ONE writer, so canonical order is a property of the code rather than a
 * convention every call site has to remember. Callers hand egos in roster order
 * and get the string that goes on the wire, into the save file and into the
 * bag's identity check.
 */
export function formatItemId(
  base: string,
  egos: readonly ItemEgoRef[],
  /**
   * THE MATERIAL GRADE. Defaulted to 1, and grade 1 WRITES NOTHING — so every
   * existing caller produces the byte-identical string it produced before, and
   * the commonest item in the game keeps the shortest id it can have.
   *
   * That is not only tidiness: ids are compared as strings for the bag's
   * de-duplication, so `item_coat` and `item_coat#1` must never both exist.
   * One spelling per item, and the default is what enforces it.
   */
  material: number = MIN_MATERIAL,
): string {
  const graded =
    material <= MIN_MATERIAL ? base : `${base}${MATERIAL_SEPARATOR}${String(material)}`;
  if (egos.length === 0) return graded;
  const tokens = egos.map((ego) => `${ego.code}${POWER_DIGITS.charAt(ego.power)}`);
  return `${graded}${EGO_SEPARATOR}${tokens.join(EGO_DELIMITER)}`;
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

  const material = parsed.material;

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE EARLY RETURN IS NOW CONDITIONAL ON THE GRADE TOO, AND IT HAD TO BE.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * It read `if (parsed.egos.length === 0) return base;` — hand back the frozen
   * catalogue entry, untouched, which was exactly right while an id could say
   * nothing else about an item. A plain GRADED id (`item_coat#3`) would have
   * taken that same path and come back as a grade-1 coat: the id would parse,
   * the item would resolve, every number would be wrong, and nothing anywhere
   * would report an error.
   *
   * A grade-1 item with no egos still takes it, which is every item that has
   * ever existed in a save file — so the common path is unchanged and still
   * returns the shared frozen object rather than building a copy per lookup.
   */
  if (parsed.egos.length === 0 && material === MIN_MATERIAL) return base;

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
    // See loot.ts: a slotless item takes no ego, so an id that claims one is an
    // id this build cannot make sense of — which is the same answer an unknown
    // ego code already gets.
    if (base.slot === undefined) return undefined;
    if (ego.slots !== undefined && !ego.slots.includes(base.slot)) return undefined;
  }

  /**
   * ─── THE MERGE. NUMBERS ADD, AND THAT IS THE WHOLE RULE ───
   *
   * ═══ THE BASE IS SCALED BY ITS GRADE; THE EGOS ARE NOT ═══
   * A grade is a fact about the OBJECT — a better coat is a better coat — and
   * an ego is a fact about what happened to it, which does not get better
   * because the coat underneath did. Upstream agrees in effect: ego magnitudes
   * come off the ego's own table and the material level scales the base.
   *
   * It also keeps the arithmetic legible. Scaling both would mean a grade-5
   * item with two egos multiplying four authored numbers by the same figure,
   * and no player could work out where any of it came from.
   */
  const stats: Record<string, number> = {};
  for (const [key, value] of Object.entries(base.wielder.stats ?? {})) {
    stats[key] = atMaterial(value, material);
  }
  const mods: Record<string, number> = {};
  for (const [key, value] of Object.entries(base.wielder.mods ?? {})) {
    mods[key] = atMaterial(value, material);
  }
  /**
   * RESISTS SCALE WITH THE GRADE TOO, and the alternative was considered and
   * rejected. A per-channel exception — "the grade improves the armour but not
   * the fireproofing" — would be a rule with no mechanical statement behind it,
   * and the first question a player asks about a Bespoke coat is whether it is
   * better at everything or only at some things. It is better at everything.
   *
   * `MAX_ITEM_RESIST` therefore bounds the AUTHORED number and the resolved one
   * can reach twice it at grade 5, exactly as an authored `armour: 4` resolves
   * to 8. That is why the cap is set well under a quarter of the 100 ceiling.
   */
  const resists: Record<string, number> = {};
  for (const [key, value] of Object.entries(base.wielder.resists ?? {})) {
    resists[key] = atMaterial(value, material);
  }
  // THE TWO ATTACKER-SIDE TABLES, on the same grade curve as everything else a
  // base authors. See the note above on why resists scale with the material.
  const damage: Record<string, number> = {};
  for (const [key, value] of Object.entries(base.wielder.damage ?? {})) {
    damage[key] = atMaterial(value, material);
  }
  const penetration: Record<string, number> = {};
  for (const [key, value] of Object.entries(base.wielder.penetration ?? {})) {
    penetration[key] = atMaterial(value, material);
  }
  /**
   * AND THE STATUS DEFENCE, on the grade curve with everything else — "it is
   * better at everything", the rule stated above.
   *
   * Note which half that scales: a BASE item's authored immunity, the same as
   * its authored resistance. An EGO's contribution is added raw below, because
   * `egoWielder` has already resolved it against the ego's own power and the
   * base's tier — grading it again would multiply two curves together.
   */
  const immunities: Record<string, number> = {};
  for (const [key, value] of Object.entries(base.wielder.immunities ?? {})) {
    immunities[key] = atMaterial(value, material);
  }
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
    for (const [key, value] of Object.entries(wielder.resists ?? {})) {
      resists[key] = (resists[key] ?? 0) + value;
    }
    for (const [key, value] of Object.entries(wielder.damage ?? {})) {
      damage[key] = (damage[key] ?? 0) + value;
    }
    for (const [key, value] of Object.entries(wielder.penetration ?? {})) {
      penetration[key] = (penetration[key] ?? 0) + value;
    }
    /**
     * THE LINE WHOSE ABSENCE MADE THE WHOLE IMMUNITY CHANNEL INVISIBLE.
     *
     * `Shockproof ` and ` of Whole Cloth` rolled onto real loot from the day
     * they were authored — 390 and 142 times in a 5,938-item sample — and every
     * one of them resolved to an item with no immunity on it, because this merge
     * is field-by-field and did not know the field existed. The ego roster, the
     * fold, `canBe` and both readouts were all correct and connected; a player
     * would have found a Shockproof cap that did nothing and had no way to tell.
     */
    for (const [key, value] of Object.entries(wielder.immunities ?? {})) {
      immunities[key] = (immunities[key] ?? 0) + value;
    }
  }

  const merged: {
    stats?: typeof stats;
    mods?: typeof mods;
    resists?: typeof resists;
    damage?: typeof damage;
    penetration?: typeof penetration;
    immunities?: typeof immunities;
  } = {};
  if (Object.keys(stats).length > 0) merged.stats = stats;
  if (Object.keys(mods).length > 0) merged.mods = mods;
  if (Object.keys(resists).length > 0) merged.resists = resists;
  if (Object.keys(damage).length > 0) merged.damage = damage;
  if (Object.keys(penetration).length > 0) merged.penetration = penetration;
  if (Object.keys(immunities).length > 0) merged.immunities = immunities;

  // Prefixes carry their own trailing space and suffixes their own leading one
  // (`validateEgos` proves it), so this is concatenation with no separator
  // logic — Zone.lua:527-531 exactly.
  let name = base.name;
  for (const ego of egos) {
    name = ego.tag === EgoSlotTag.Prefix ? `${ego.name}${name}` : `${name}${ego.name}`;
  }
  // THE GRADE GOES ON LAST, WHICH PUTS IT FIRST. See `MATERIAL_WORDS`: the
  // grade is a fact about the object and an ego is a fact about what was done
  // to it, so the grade is the outermost word.
  name = `${materialWord(material)}${name}`;

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
