// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from
//   t-engine4 game/engines/default/engine/Zone.lua:521-556 (`applyEgo` — an ego is a partial
//              entity merged onto a base, and `cost` is NOT stripped by the merge)
//   t-engine4 game/engines/default/engine/utils.lua:726-734 (`table.ruleMergeAppendAdd` — of its
//              four rules, `add` is the only one our `Wielder` has anything for)
//   t-engine4 game/modules/tome/resolvers.lua:594-613 (`mbonus_material` — magnitude scales with
//              the base's material level, over a guaranteed floor)
//   t-engine4 game/modules/tome/data/general/objects/egos/*.lua (the shape of an authored row)
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" — https://te4.org/license

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *                  EGOS. THE REASON TWO COATS ARE DIFFERENT.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ToME's ego is "an ordinary entity with the same field names as a base object,
 * deep-merged onto it with numbers adding". Ours is smaller for a structural
 * reason rather than a scoping one: `Wielder` is already two flat maps of
 * integers, and `composeSheet` is already an additive fold over exactly those.
 * Three of `ruleMergeAppendAdd`'s four rules — `append_top`, `recurse`,
 * `overwrite` — have NOTHING TO ACT ON here. There are no arrays, no nested
 * tables and no proc callbacks in a `Wielder`. So the one rule that does
 * anything gets ported, and it is addition.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHERE THE VARIETY ACTUALLY COMES FROM
 * ═══════════════════════════════════════════════════════════════════════════
 * 22 bases × (1 + prefixes) × (1 + suffixes) × 4 powers each. Eight egos is
 * already ~1,500 distinguishable items; the roster is sized to grow by adding
 * rows to this file and nothing else. That is the whole argument for doing egos
 * rather than authoring more items: an item is a row plus a 32×32 sprite that
 * has to be drawn, and an ego is a row.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * MAGNITUDE, AND WHY THERE IS NO ROUNDING IN IT
 * ═══════════════════════════════════════════════════════════════════════════
 * ```
 * value = floor + step × power × tierWeight
 * ```
 * `power` is 0..3, off the id. `tierWeight` is 1..3 and IS `ItemTier` — ToME
 * multiplies every ego magnitude by `material_level / 5` (resolvers.lua:594-596),
 * "that single term doing all the work of a tier system without a tier system
 * existing", and `items.ts:113-121` already states that `ItemTier` *is* the drop
 * table. Adding a `material_level` 1..5 beside it would be two fields that must
 * agree, on a catalogue of 22.
 *
 * Upstream rounds with `math.ceil` because its terms are fractional. Every term
 * here is an integer and `validateEgos` refuses one that is not, so the product
 * is exact and no rounding happens at all. That is not tidiness: the fold in
 * engine/equipment.ts is plain floating-point addition, and
 * test/server/equipment.test.ts proves all 5040 orderings of a seven-piece kit
 * are bit-identical *because* integer addition in a double is exact. One
 * fractional ego magnitude silently converts that proof into a proof about one
 * ordering.
 *
 * `floor` is the guaranteed term — the reason a power-0 ego is never worthless —
 * and it must be at least `MIN_STAT_FLOOR` for any `stats` grant, because
 * `rescaleCombatStats` FLOORS (shared/scale.ts:116) and items.ts:105-110 already
 * proves a +1 or +2 primary can rescale to the same integer and move nothing a
 * player can see.
 *
 * TYPES ONLY from items.ts, same discipline as items.ts itself. No RNG, no
 * clock: which ego lands is a decision made elsewhere, and this file only says
 * what one IS.
 */

import { Slot } from './items.ts';
import type { AdditiveMods, AdditiveStats, ItemTier, Wielder } from './items.ts';

/**
 * Which of an item's two ego slots this fills.
 *
 * Zone.lua:333-341 — the slot name is a hard filter on the candidate list, and
 * Zone.lua:650-668's loop fills each declared slot AT MOST ONCE, which is what
 * makes "how many egos can this item have" data rather than code.
 */
export const EgoSlotTag = { Prefix: 'prefix', Suffix: 'suffix' } as const;
export type EgoSlotTag = (typeof EgoSlotTag)[keyof typeof EgoSlotTag];

/** Prefix then suffix, frozen. The order egos appear in an id and in a name. */
export const EGO_TAG_ORDER: readonly EgoSlotTag[] = Object.freeze([
  EgoSlotTag.Prefix,
  EgoSlotTag.Suffix,
]);

/**
 * The smallest `floor` a primary-stat grant may carry. See the file header —
 * below this the rescale can eat the whole grant and the item lies.
 */
export const MIN_STAT_FLOOR = 3;

/** One term of a grant. Never a bare number, so `floor` is impossible to omit. */
export type EgoGrant = {
  /** The guaranteed `+add`, before power. resolvers.lua:613. Integer, >= 0. */
  readonly floor: number;
  /** Multiplied by power (0..3) and tierWeight (1..3). Integer, >= 0. */
  readonly step: number;
};

/** One authored ego. */
export type Ego = {
  /**
   * TWO CHARACTERS, `[a-z0-9]`, UNIQUE, AND FROZEN FROM THE COMMIT THAT ADDS IT.
   *
   * It is written into the instance id, which is written into save files on a
   * machine in somebody's house. Renaming one re-points every item in every save
   * at a different ego — silently, because the id still parses.
   */
  readonly code: string;
  /**
   * THE WHITESPACE LIVES HERE. Zone.lua:527-531 concatenates with no separator
   * logic at all, so a prefix carries a TRAILING space and a suffix a LEADING
   * one: `"Reinforced " + "Watchman's Coat" + " of the Ledger"`. `validateEgos`
   * checks it, because the failure is a name that reads
   * `ReinforcedWatchman's Coat` and nothing else goes wrong.
   */
  readonly name: string;
  readonly tag: EgoSlotTag;
  /** Lower is commoner: `genprob = floor(10000 / rarity)`. Zone.lua:221. */
  readonly rarity: number;
  /**
   * Zone.lua:218-219. Under-depth divides the weight by `3 × levelsBelow`,
   * over-depth by `levelsAbove` alone — three times gentler upward, which is
   * what makes finding something above your level uncommon and finding
   * something beneath it rare.
   */
  readonly levelRange: readonly [number, number];
  /** Which slots may wear it. Absent = any. Zone.lua:290-296 `checkFilter`. */
  readonly slots?: readonly Slot[];
  /** The partial `Wielder`. Every leaf is an `EgoGrant`, never a bare number. */
  readonly grants: {
    readonly stats?: Partial<Record<keyof AdditiveStats, EgoGrant>>;
    readonly mods?: Partial<Record<keyof AdditiveMods, EgoGrant>>;
  };
  /**
   * Gold added to the base's cost. `applyEgo` strips `unided_name`,
   * `__CLASSNAME`, `__ATOMIC`, `uid`, `rarity` and `level_range` — and nothing
   * else (Zone.lua:539-546) — so upstream ego cost adds to base cost too.
   */
  readonly cost: number;
};

/** `ItemTier` as the multiplier it already is. common 1, uncommon 2, rare 3. */
export function tierWeight(tier: ItemTier): number {
  if (tier === 'rare') return 3;
  if (tier === 'uncommon') return 2;
  return 1;
}

/**
 * One grant, resolved against a power and a base item's tier.
 *
 * Exact by construction — see the header. Exported because `resolveItem` is not
 * the only caller that will want it: the shop's valuation needs the same number
 * without building an item.
 */
export function grantValue(grant: EgoGrant, power: number, tier: ItemTier): number {
  return grant.floor + grant.step * power * tierWeight(tier);
}

// ---------------------------------------------------------------------------
// The roster
// ---------------------------------------------------------------------------

/**
 * PREFIXES — what was done to the thing. Armour, weight, treatment.
 *
 * Deliberately the physical half: a prefix reads as a property of the object
 * and a suffix as a property of its history, which is the only way eight names
 * stay legible when a player sees them combined.
 */
const PREFIXES: readonly Ego[] = [
  {
    code: 'rf',
    name: 'Reinforced ',
    tag: EgoSlotTag.Prefix,
    // The commonest thing in the set and the plainest. Every roster needs one
    // ego that is not interesting, or "it has a name" stops meaning anything.
    rarity: 3,
    levelRange: [1, 50],
    grants: { mods: { armour: { floor: 1, step: 1 }, armourHardiness: { floor: 2, step: 1 } } },
    cost: 15,
  },
  {
    code: 'ol',
    name: 'Oiled ',
    tag: EgoSlotTag.Prefix,
    rarity: 4,
    levelRange: [1, 50],
    grants: { mods: { def: { floor: 2, step: 1 }, damRange: { floor: 0, step: 1 } } },
    cost: 15,
  },
  {
    code: 'wt',
    name: 'Weighted ',
    tag: EgoSlotTag.Prefix,
    rarity: 6,
    levelRange: [1, 50],
    // Offhand and trinket only: this is a thing you hit with, and there is no
    // weapon slot (items.ts:52-60 — the four weapon icons do not exist on disk).
    slots: [Slot.Offhand, Slot.Trinket],
    grants: { mods: { dam: { floor: 2, step: 2 }, atk: { floor: 2, step: 1 } } },
    cost: 20,
  },
  {
    code: 'wd',
    name: 'Warded ',
    tag: EgoSlotTag.Prefix,
    // Rarer and later. `levelRange` is the real gate — see the note on the
    // field, and §5 of the port plan on why `greater_ego` was cut in favour of
    // exactly this.
    rarity: 12,
    levelRange: [4, 50],
    grants: {
      mods: {
        spellResist: { floor: 2, step: 2 },
        mentalResist: { floor: 2, step: 2 },
      },
    },
    cost: 35,
  },
];

/**
 * SUFFIXES — where the thing has been. Every one of these grants a primary, so
 * every `floor` in here is at or above `MIN_STAT_FLOOR`.
 */
const SUFFIXES: readonly Ego[] = [
  {
    code: 'lg',
    name: ' of the Ledger',
    tag: EgoSlotTag.Suffix,
    rarity: 4,
    levelRange: [1, 50],
    // Cunning feeds `combatCrit` at 0.3/point OUTSIDE the rescale, which is why
    // items.ts:573-575 picked it for the Cipher: no floor can eat it.
    grants: { stats: { cun: { floor: 3, step: 1 } } },
    cost: 15,
  },
  {
    code: 'lw',
    name: ' of the Long Watch',
    tag: EgoSlotTag.Suffix,
    rarity: 5,
    levelRange: [1, 50],
    grants: { stats: { con: { floor: 3, step: 1 } }, mods: { physResist: { floor: 1, step: 1 } } },
    cost: 18,
  },
  {
    code: 'qh',
    name: ' of Quiet Hands',
    tag: EgoSlotTag.Suffix,
    rarity: 7,
    levelRange: [2, 50],
    grants: { stats: { dex: { floor: 3, step: 1 } }, mods: { physCrit: { floor: 1, step: 1 } } },
    cost: 22,
  },
  {
    code: 'cr',
    name: ' of the Coroner',
    tag: EgoSlotTag.Suffix,
    rarity: 14,
    levelRange: [5, 50],
    grants: {
      stats: { mag: { floor: 3, step: 1 }, wil: { floor: 3, step: 1 } },
      mods: { genericPower: { floor: 2, step: 2 } },
    },
    cost: 40,
  },
];

/** Every authored ego, prefixes then suffixes. Order is `EGO_TAG_ORDER`. */
export const EGOS: readonly Ego[] = Object.freeze([...PREFIXES, ...SUFFIXES]);

/** code → ego. The one lookup; `resolveItem` is its only hot caller. */
export const EGO_CATALOGUE: ReadonlyMap<string, Ego> = new Map(EGOS.map((ego) => [ego.code, ego]));

/** One ego, or undefined for a code this build does not know. */
export function egoByCode(code: string): Ego | undefined {
  return EGO_CATALOGUE.get(code);
}

/** Every ego that may fill one tag, in roster order. */
export function egosForTag(tag: EgoSlotTag): readonly Ego[] {
  return EGOS.filter((ego) => ego.tag === tag);
}

// ---------------------------------------------------------------------------
// The import-time check
// ---------------------------------------------------------------------------

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * IT THROWS AT MODULE LOAD. Same trade as `validateItems`, same reason: a
 * content mistake that survives startup is a content mistake four friends
 * discover in a voice channel on a Friday night.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Seven things, and the first two are the ones that would be expensive.
 *
 *  1. CODES ARE TWO CHARACTERS OF `[a-z0-9]` AND UNIQUE. The code goes into
 *     save files. A duplicate silently shadows in `EGO_CATALOGUE` and the loser
 *     becomes an ego that can roll and can never resolve — every item carrying
 *     it turns into "not an item this build knows" on the next load.
 *  2. NAME WHITESPACE MATCHES THE TAG. A prefix without its trailing space
 *     produces `ReinforcedWatchman's Coat` and nothing else goes wrong, so it
 *     ships.
 *  3. EVERY GRANT VALUE IS A FINITE, NON-NEGATIVE INTEGER, at every power and
 *     every tier. Checked by evaluating the corners rather than by trusting the
 *     arithmetic, so a future fractional term is caught here and not by a
 *     commutativity proof quietly weakening.
 *  4. A `stats` grant's floor is at least `MIN_STAT_FLOOR`.
 *  5. NO `DEAD_MOD_KEYS`. The type already refuses them; a `grants` arriving
 *     through a cast does not.
 *  6. `levelRange` is ordered and positive.
 *  7. `rarity` and `cost` are positive integers — `genprob = 10000 / rarity`
 *     divides by it, and a zero would be an ego that is infinitely common.
 */
export function validateEgos(egos: readonly Ego[]): readonly Ego[] {
  const seen = new Set<string>();

  for (const ego of egos) {
    if (!/^[a-z0-9]{2}$/.test(ego.code)) {
      throw new Error(`egos: code '${ego.code}' must be exactly two characters of [a-z0-9]`);
    }
    if (seen.has(ego.code)) throw new Error(`egos: duplicate code '${ego.code}'`);
    seen.add(ego.code);

    if (ego.name.trim().length === 0) throw new Error(`egos: ${ego.code} has an empty name`);
    if (ego.tag === EgoSlotTag.Prefix && !ego.name.endsWith(' ')) {
      throw new Error(
        `egos: prefix '${ego.code}' names '${ego.name}' with no trailing space — ` +
          `the concatenation would read 'ReinforcedWatchman's Coat'`,
      );
    }
    if (ego.tag === EgoSlotTag.Suffix && !ego.name.startsWith(' ')) {
      throw new Error(
        `egos: suffix '${ego.code}' names '${ego.name}' with no leading space — ` +
          `the concatenation would read "Watchman's Coatof the Ledger"`,
      );
    }

    const [low, high] = ego.levelRange;
    if (!Number.isInteger(low) || !Number.isInteger(high) || low < 1 || high < low) {
      throw new Error(
        `egos: ${ego.code} has levelRange [${String(low)}, ${String(high)}], which must be ` +
          `two integers with 1 <= low <= high`,
      );
    }
    if (!Number.isInteger(ego.rarity) || ego.rarity < 1) {
      throw new Error(
        `egos: ${ego.code} has rarity ${String(ego.rarity)}; genprob divides by it, so it ` +
          `must be a positive integer`,
      );
    }
    if (!Number.isInteger(ego.cost) || ego.cost < 0) {
      throw new Error(`egos: ${ego.code} has cost ${String(ego.cost)}; must be a whole number`);
    }

    const statGrants = Object.entries(ego.grants.stats ?? {});
    const modGrants = Object.entries(ego.grants.mods ?? {});
    if (statGrants.length === 0 && modGrants.length === 0) {
      throw new Error(
        `egos: ${ego.code} grants nothing — it would be a name that changes no number a ` +
          `player can see, which is worse than no ego at all`,
      );
    }

    for (const [key, grant] of [...statGrants, ...modGrants]) {
      if (DEAD_GRANT_KEYS.includes(key)) {
        throw new Error(
          `egos: ${ego.code} grants '${key}', which has ZERO call sites in src/ — ` +
            `see the note on DEAD_MOD_KEYS in content/items.ts`,
        );
      }
      if (grant === undefined) continue;
      assertGrant(ego.code, key, grant);
    }

    for (const [key, grant] of statGrants) {
      if (grant !== undefined && grant.floor < MIN_STAT_FLOOR) {
        throw new Error(
          `egos: ${ego.code} grants ${key} with floor ${String(grant.floor)}; a primary-stat ` +
            `floor below ${String(MIN_STAT_FLOOR)} can rescale to the same integer and move ` +
            `nothing (see content/items.ts:105-110)`,
        );
      }
    }
  }

  return egos;
}

/** The three dead `CombatMods` fields, by name. Mirrors items.ts's own list. */
const DEAD_GRANT_KEYS: readonly string[] = Object.freeze(['physSpeed', 'spellPower', 'mindPower']);

/** Every tier, for the corner check below. */
const ALL_TIERS: readonly ItemTier[] = Object.freeze(['common', 'uncommon', 'rare']);

/**
 * Evaluate a grant at every corner of its domain and refuse anything that is not
 * a finite non-negative integer.
 *
 * THE CORNERS RATHER THAN THE TERMS, because the invariant that matters is about
 * the VALUE the fold receives. Checking `floor` and `step` in isolation would
 * pass a step of 0.5 that only misbehaves at odd powers.
 */
function assertGrant(code: string, key: string, grant: EgoGrant): void {
  for (const tier of ALL_TIERS) {
    for (let power = 0; power <= 3; power += 1) {
      const value = grantValue(grant, power, tier);
      if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
        throw new Error(
          `egos: ${code} grants ${key} = ${String(value)} at power ${String(power)} on a ` +
            `${tier} item; every resolved value must be a finite non-negative INTEGER or the ` +
            `fold in engine/equipment.ts stops being exactly order-independent`,
        );
      }
    }
  }
}

/** The check, run. It is `EGOS`, by identity. */
export const CHECKED_EGOS: readonly Ego[] = validateEgos(EGOS);

/** A `Wielder` this ego contributes at one power on one tier of base item. */
export function egoWielder(ego: Ego, power: number, tier: ItemTier): Wielder {
  const stats: Partial<Record<keyof AdditiveStats, number>> = {};
  for (const [key, grant] of Object.entries(ego.grants.stats ?? {})) {
    if (grant === undefined) continue;
    stats[key as keyof AdditiveStats] = grantValue(grant, power, tier);
  }

  const mods: Partial<Record<keyof AdditiveMods, number>> = {};
  for (const [key, grant] of Object.entries(ego.grants.mods ?? {})) {
    if (grant === undefined) continue;
    mods[key as keyof AdditiveMods] = grantValue(grant, power, tier);
  }

  // A key is written only when something contributed to it — the same rule
  // `composeSheet` follows, and for the same reason: an empty `stats: {}` is
  // structurally different from no `stats` at all, and one of the two is what a
  // deep-equal round-trip test compares against.
  const out: { stats?: typeof stats; mods?: typeof mods } = {};
  if (Object.keys(stats).length > 0) out.stats = stats;
  if (Object.keys(mods).length > 0) out.mods = mods;
  return out;
}
