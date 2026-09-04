// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// DELIBERATELY NOT A PORT. The mechanism this replaces is cited in full below:
//   t-engine4 game/engines/default/engine/interface/ActorInventory.lua:563-572 (onWear)
//                                                                     :578-590 (onTakeoff)
//   t-engine4 game/engines/default/engine/Entity.lua:960, :1054 (the ledger removal reads back)
//                                                   :985-996   (the float round trips that DRIFT)
//   t-engine4 game/modules/tome/class/Actor.lua:105-108 (upstream's own retrofit banning them)
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" — https://te4.org/license

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *      WHAT WORN GEAR CONTRIBUTES TO A COMBAT SHEET. ONE PURE FOLD.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `composeSheet(base, worn)` returns a NEW sheet: the class's own `CombatSheet`
 * with every worn item's `wielder` table added onto it. It never mutates `base`,
 * it never subtracts, and there is no inverse operation anywhere in this file —
 * because UNEQUIP IS NOT A SUBTRACTION. Taking a coat off removes an id from the
 * actor's `equipped` map and re-runs this same fold over the smaller set. There
 * is no reverse arithmetic, so there is nothing for it to get wrong.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS IS NOT ToME'S MECHANISM, WITH THE LINES THAT DECIDED IT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Upstream wears an item by pushing every `wielder` field through
 * `addTemporaryValue` and STORING THE HANDLE ON THE ITEM:
 *
 * ```lua
 * -- ActorInventory.lua:563-572
 * function _M:onWear(o, inven_id)
 *   o.wielded = {}
 *   if o.wielder then
 *     for k, e in pairs(o.wielder) do o.wielded[k] = self:addTemporaryValue(k, e) end
 *   end
 * end
 *
 * -- ActorInventory.lua:578-590
 * function _M:onTakeoff(o, inven_id)
 *   if o.wielded then
 *     for k, id in pairs(o.wielded) do self:removeTemporaryValue(k, id) end
 *   end
 *   o.wielded = nil
 * end
 * ```
 *
 * ToME's reversibility therefore does NOT come from careful arithmetic. It comes
 * from a LEDGER: `removeTemporaryValue` reads the value that was actually
 * applied back out of `self.compute_vals[id]` (Entity.lua:960) and un-applies
 * exactly that (Entity.lua:1054), rather than re-reading the item — which is
 * what makes it exact even when two items and three buffs touched the same
 * field. Porting that ledger literally is possible. It is also pointless here,
 * and it is not even exact upstream:
 *
 *   Entity.lua:985      `mult`     removes by DIVISION
 *   Entity.lua:990-992  `perc_inv` removes by `1 - (1 - b) / (1 - v)`
 *
 * Both are float round trips and both drift. Upstream knows: tome/class/Actor.lua:105-108
 * is a retrofit forcing four speed properties back to plain `add` —
 * `movement_speed`, `combat_physspeed`, `combat_spellspeed`, `combat_mindspeed`
 * — the second of them commented *"Prevent excessive attack speed compounding"*.
 * (:104 sets `global_speed_add` to `"newest"` and is NOT one of the four; an
 * earlier draft cited :104-107 and so quoted three `add`s and a `newest`.) content/items.ts imports that
 * lesson at the type level — `AdditiveMods` has no multiplicative field to
 * express — so the only merge method this file needs is `+`.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * AND THIS CODEBASE HAS ALREADY ARGUED THE SAME CASE AND WON IT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * engine/effects.ts:1353-1362, verbatim, about status effects:
 *
 *   *"RECOMPUTE FROM A BASELINE, DO NOT PATCH INCREMENTALLY. ToME uses
 *   addTemporaryValue / removeTemporaryValue handle pairs, which are exact but
 *   require every activate to have a matching deactivate that reverses precisely
 *   what it did... the pre-effect value is snapshotted once and the live set is
 *   re-composed on top of it after EVERY state change. Idempotent,
 *   order-independent, and it cannot leak a modifier when a hook throws."*
 *
 * Equipment is that problem with more slots. Following the argument that is
 * already in the file makes a non-reversible merge UNREACHABLE BY CONSTRUCTION
 * rather than avoided by discipline, and it means the two systems that both
 * write `actor.combat` are recomposing from the same baseline instead of
 * layering patches on each other.
 *
 * An in-place ToME-style merge is not even available to us: every field of
 * `CombatMods` is readonly (derived.ts:111-146), every field of `CombatSheet` is
 * readonly (combat.ts:115-132), and `DEFAULT_PLAYER_COMBAT` is `Object.freeze`d
 * (actor.ts:634). `Object.assign` onto a shared frozen sheet does not produce a
 * wrong number, it produces cross-actor contamination — every classless body in
 * the process wearing one player's boots.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * NO CATALOGUE IMPORT, AND NO I/O
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `wornOf` TAKES the catalogue rather than importing it, for the reason
 * scheduler.ts:510-527 gives for `TalentResolution`: a function that reaches for
 * a module-level table is a function a test cannot aim at a fixture, and a
 * content table that is reachable from the engine is a content table the engine
 * will eventually branch on. The one thing imported from content/ is
 * `SLOT_ORDER`, which is not the catalogue — it is the answer to "in what order
 * does a body wear things", and there must be exactly one of those.
 *
 * src/server/engine/** may not import net/, persist/, ops/ or http/
 * (CLAUDE.md § non-negotiable 5, enforced by `NO_IO_LAYER_PATTERNS` in
 * eslint.config.js). Nothing here does. Nothing here is async, reads a clock, or
 * draws from an RNG either: this is a pure function of its arguments, which is
 * what lets the character sheet preview and the damage pipeline call it and be
 * guaranteed to agree.
 */

import { SLOT_ORDER } from '../content/items.ts';
import { STAT_BASE } from './derived.ts';
import { DAMAGE_TYPES } from '../../shared/damagetype.ts';
import { IMMUNITY_KEYS } from '../../shared/immunity.ts';
import { bound } from '../../shared/scale.ts';
import type { ImmunitySubtype } from '../../shared/immunity.ts';
import type { AdditiveMods, AdditiveStats, Item, ItemCatalogue, Slot } from '../content/items.ts';
import type { CombatSheet } from './combat.ts';
import type { OnHitStatus } from './actor.ts';
import type { DamageType } from '../../shared/damagetype.ts';
import type { TypeTable } from './damage.ts';
import type { CombatMods, PrimaryStats } from './derived.ts';

/**
 * The primaries a `wielder` may move, in a FIXED order.
 *
 * A literal list rather than `Object.keys`, for the reason derived.ts:536-540
 * already gives for its own `STAT_KEYS`: key order on a content-authored object
 * is whatever the author typed. It is also the second place `lck` is excluded —
 * once in the type (`AdditiveStats`), once here — so a cast cannot reach it.
 */
const WIELDER_STAT_KEYS: readonly (keyof AdditiveStats)[] = Object.freeze([
  'str',
  'dex',
  'con',
  'mag',
  'wil',
  'cun',
]);

/**
 * The `combat_*` mods a `wielder` may move, in a FIXED order.
 *
 * THE THREE DEAD FIELDS ARE ABSENT FROM THIS LIST AS WELL AS FROM THE TYPE, and
 * that is the belt to the type's braces: an item that reached the fold through a
 * cast with `physSpeed: 4` on it would contribute nothing here, because nothing
 * here reads a key it was not told about. Together with content/items.ts's
 * import-time check that is three independent refusals of the same mistake.
 */
const WIELDER_MOD_KEYS: readonly (keyof AdditiveMods)[] = Object.freeze([
  // ADDITIVE, which is upstream's: two sources of `numbed` stack into one attr.
  // Nothing but the Off-balance cross-tier effect grants it today.
  'numbed',
  'atk',
  'def',
  'armour',
  'armourHardiness',
  'apr',
  'dam',
  'physCrit',
  'genericCrit',
  'criticalPower',
  'damRange',
  'genericPower',
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * AND THE TWO TARGETED POWERS — THE `moveMp` MISTAKE, MADE A SECOND TIME.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * The note below on `moveMp` says it exactly: a field `content/items.ts` says
   * an item may grant, missing from THIS list, is an item that type-checks,
   * persists, prints a tooltip and changes nothing.
   *
   * `0bced47` lifted the ban on `spellPower` and `mindPower` in `AdditiveMods`
   * and in both dead-key lists — three places — and not here, which is the
   * fourth. `genericPower` was already on the list and feeds both getters, so
   * the blanket version worked and the targeted one silently did not.
   *
   * Caught by the reachability test for the ego that grants `mindPower`: the
   * value reached the item and never reached the sheet.
   */
  'spellPower',
  'mindPower',
  'physResist',
  'spellResist',
  'mentalResist',
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * `moveMp` WAS MISSING, AND content/items.ts SAID AN ITEM COULD GRANT IT.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `DEAD_MOD_KEYS`'s own note argues at length that `moveMp` is NOT a dead
   * field — *"`refreshPassives` folds it into the movement ceiling and it
   * works"* — and closes with *"SO AN ITEM MAY GRANT IT AND NONE DOES."*
   *
   * An item could not. The type permitted one (`AdditiveMods` omits only the
   * three genuinely dead fields), so a pair of boots granting `moveMp` would
   * type-check, pass the import-time check, persist, draw a tooltip — and be
   * dropped right here, because this list is the belt to that type's braces and
   * nothing in the fold reads a key it was not told about. Exactly the "item
   * that changes no number a player can see" those two guards exist to prevent,
   * arriving through the door neither was watching.
   *
   * Five of the six lenses in the 2026-08-31 stat audit flagged it independently
   * and every one was refuted as latent, because nothing grants it today. It is
   * fixed now rather than when somebody authors the boots, since the day it
   * bites is the day it is hardest to see.
   */
  'moveMp',
]);

/**
 * WHAT AN ABSENT FIELD MEANS, PER SIDE, AND GETTING IT WRONG COSTS 10 STRENGTH.
 *
 * An absent `mods.*` is 0 — every getter in derived.ts reads `?? 0`. An absent
 * `stats.*` is TEN, not zero: `stat()` (derived.ts:220-225) defaults to
 * `STAT_BASE`, which is ToME's own `load.lua:182-187`. So a ring granting
 * `str: 3` to a sheet with no `stats` table must produce `str: 13`, not
 * `str: 3` — the naive version hands a Watchman a ring and takes seven points of
 * Strength off him, on a sheet that reads as an upgrade.
 */
function baseStat(base: PrimaryStats | undefined, key: keyof AdditiveStats): number {
  return base?.[key] ?? STAT_BASE;
}

/** Absent mods are zero everywhere in derived.ts. */
function baseMod(base: CombatMods | undefined, key: keyof AdditiveMods): number {
  return base?.[key] ?? 0;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE FOLD. ADDITIVE, ORDER-INDEPENDENT, AND IT NEVER TOUCHES `base`.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * @param base the actor's own sheet — `actor.baseCombat`, which is the class
 *   sheet exactly as content/classes.ts authored it and is NEVER written to.
 * @param worn the items to fold on, in a stable order (`wornOf` supplies one).
 * @returns a NEW frozen sheet. Distinct from `base` even when `worn` is empty,
 *   because a caller that gets `base` back sometimes and a copy other times has
 *   an aliasing bug waiting for the first `Object.assign`.
 *
 * ═══ WHY IT ACCUMULATES FIRST AND APPLIES ONCE ═══
 * Not for speed. `rescaleCombatStats` is CONCAVE and is applied once per STAT at
 * the end of each getter (derived.ts:26-42): the sum must reach the getter as
 * one number. Accumulating here mirrors that and, more importantly, makes the
 * fold provably commutative — every wielder value is an integer (content/items.ts
 * enforces it at import time), and integer addition in a double is exact, so all
 * 5040 orderings of a seven-piece kit produce bit-identical output. That is
 * test 3 in test/server/equipment.test.ts.
 *
 * ═══ WHY A KEY IS ONLY WRITTEN WHEN SOMETHING CONTRIBUTED TO IT ═══
 * `composeSheet(base, [])` must deep-equal `base`. Unconditionally emitting
 * `stats: {}` and `mods: {}` would make an empty fold structurally different
 * from the sheet it folded, which breaks the round-trip proof that unequipping
 * everything restores the original — the one property this whole file exists to
 * guarantee.
 *
 * Fields this fold does not touch — `weapon`, `flags`, `profile`, `increase`,
 * `penetration`, `range`, `minRange`, `damageType` — are carried across BY
 * REFERENCE. They are readonly all the way down and nothing in the process
 * mutates them; copying them would only create a second object that has to be
 * kept in sync with `ClassDef.combat`.
 */
/**
 * WHAT A PASSIVE TALENT IS WORTH — the same shape a worn item contributes.
 *
 * Named rather than inlined as `Item['wielder']` because a passive is not an
 * item and the type should not have to be read as one; identical in structure so
 * `composeWielders` can take both without a second combine.
 */
export type PassiveContribution = NonNullable<Item['wielder']>;

export function composeSheet(base: CombatSheet, worn: readonly Item[]): CombatSheet {
  return composeWielders(
    base,
    worn.map((item) => item.wielder),
  );
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE COMBINE ITSELF, OVER ANYTHING THAT CONTRIBUTES LIKE A WORN ITEM DOES.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Split out of `composeSheet` when PASSIVE TALENTS arrived. A passive
 * contributes exactly what a breastplate contributes — some stats, some mods,
 * added — and ToME agrees: `talentTemporaryValue(p, "combat_def", ...)` puts a
 * passive's defence in the same field a shield puts its own
 * (buckler-training.lua:183-186, Actor.lua's `combat_def`). Two combiners would
 * be two answers to "do a passive and a pauldron stack", and the first time they
 * disagreed the difference would be a number on a character sheet nobody could
 * account for.
 */
export function composeWielders(
  base: CombatSheet,
  blocks: readonly (Item['wielder'] | undefined)[],
): CombatSheet {
  const statDelta = new Map<keyof AdditiveStats, number>();
  const modDelta = new Map<keyof AdditiveMods, number>();
  const resistDelta = new Map<DamageType | 'all', number>();
  // THE TWO ATTACKER-SIDE TABLES. Same shape, same fixed key list, same reason.
  const damageDelta = new Map<DamageType, number>();
  const penDelta = new Map<DamageType, number>();
  const immunityDelta = new Map<ImmunitySubtype, number>();
  /**
   * THE ONE CHANNEL THAT IS NOT A NUMBER. Every other delta above is a running
   * sum; a rider either fires or it does not, so these CONCATENATE. Upstream
   * folds every wielder's `melee_project` and fires all of them — two serrated
   * blades are two cuts, not the louder of the two.
   *
   * IN BLOCK ORDER, which is doll order, so a body that wears the same things
   * lands the same riders in the same sequence every time. `composeWielders` is
   * on the deterministic path and an order that depended on a Map's iteration
   * would be a replay divergence nobody could name.
   */
  const riders: OnHitStatus[] = [];

  for (const wielder of blocks) {
    if (wielder === undefined) continue;
    const stats = wielder.stats;
    if (stats !== undefined) {
      for (const key of WIELDER_STAT_KEYS) {
        const value = stats[key];
        if (value === undefined) continue;
        statDelta.set(key, (statDelta.get(key) ?? 0) + value);
      }
    }
    const mods = wielder.mods;
    if (mods !== undefined) {
      for (const key of WIELDER_MOD_KEYS) {
        const value = mods[key];
        if (value === undefined) continue;
        modDelta.set(key, (modDelta.get(key) ?? 0) + value);
      }
    }
    /**
     * THE THIRD CHANNEL. Additive like the other two, and over a FIXED key list
     * for the same reason: `DAMAGE_TYPES` is the enumeration, so a table that
     * reached this fold with a seventh key contributes nothing rather than
     * writing a row `combatGetResist` will never read.
     *
     * ADDITIVE IS CORRECT HERE AND IS NOT THE SAME AS ToME'S `all` ROW. Two
     * coats at +10 fire make +20 fire, which is what upstream does for TYPED
     * resistances — `addTemporaryValue` on `resists[FIRE]` is a plain add. The
     * multiplicative composition in `combatGetResist` is between the `all` row
     * and the typed row at READ time, not between two items, and `Wielder`
     * refuses `all` precisely so this fold never has to know about it.
     */
    const resists = wielder.resists;
    if (resists !== undefined) {
      for (const key of DAMAGE_TYPES) {
        const value = resists[key];
        if (value === undefined) continue;
        resistDelta.set(key, (resistDelta.get(key) ?? 0) + value);
      }
    }
    /**
     * AND THE OFFENSIVE PAIR — `inc_damage` and `resists_pen`.
     *
     * The note at the head of this fold lists `increase` and `penetration`
     * among the fields *"carried across BY REFERENCE"*, and that was true and
     * complete right up until content could move them. A class could already
     * author both (the Alchemist's `increase: { fire: 10 }`); an item could not,
     * and the Redactor — whose damage type is resisted 50% by seven of the nine
     * creatures in the game — had no way to build against that at all.
     */
    const damage = wielder.damage;
    if (damage !== undefined) {
      for (const key of DAMAGE_TYPES) {
        const value = damage[key];
        if (value === undefined) continue;
        damageDelta.set(key, (damageDelta.get(key) ?? 0) + value);
      }
    }
    const pen = wielder.penetration;
    if (pen !== undefined) {
      for (const key of DAMAGE_TYPES) {
        const value = pen[key];
        if (value === undefined) continue;
        penDelta.set(key, (penDelta.get(key) ?? 0) + value);
      }
    }
    /**
     * AND THE STATUS DEFENCE, over `IMMUNITY_KEYS` for the same fixed-list
     * reason as the three above it.
     *
     * ADDITIVE WITHIN A KEY AND MULTIPLICATIVE ACROSS SUBTYPES, and the split is
     * not an inconsistency. Upstream keeps ONE `stun_immune` attr that every
     * source adds into (`addTemporaryValue`, a plain add), so two rings at 15%
     * stun make 30% stun. The multiplicative composition lives one level up, in
     * `canBe`, BETWEEN the subtypes of a single effect — 50% wound and 50% bleed
     * leave a quarter chance of being cut. Adding there instead would make two
     * mediocre immunities into a total one, and `canBe`'s docblock says so.
     */
    /**
     * THE `all` RESIST ROW, which only an effect reaches — `validateItems`
     * refuses it on gear. Additive into the same delta map the typed rows use,
     * keyed by `'all'`: `TypeTable` is `DamageType | 'all'`, and
     * `combatGetResist` reads the row directly, so nothing downstream needs to
     * learn a new shape.
     */
    if (wielder.onHit !== undefined) riders.push(wielder.onHit);

    if (wielder.resistAll !== undefined) {
      resistDelta.set('all', (resistDelta.get('all') ?? 0) + wielder.resistAll);
    }
    const immunities = wielder.immunities;
    if (immunities !== undefined) {
      for (const key of IMMUNITY_KEYS) {
        const value = immunities[key];
        if (value === undefined) continue;
        immunityDelta.set(key, (immunityDelta.get(key) ?? 0) + value);
      }
    }
  }

  // A MUTABLE copy, built and then frozen. `CombatSheet`'s fields are readonly,
  // which is the correct shape for every reader — this is the one writer, and it
  // writes a fresh object rather than the actor's live one.
  const out: { -readonly [K in keyof CombatSheet]: CombatSheet[K] } = { ...base };

  if (statDelta.size > 0) {
    const stats: { -readonly [K in keyof PrimaryStats]: PrimaryStats[K] } = { ...base.stats };
    for (const [key, delta] of statDelta) stats[key] = baseStat(base.stats, key) + delta;
    out.stats = Object.freeze(stats);
  }

  if (modDelta.size > 0) {
    const mods: { -readonly [K in keyof CombatMods]: CombatMods[K] } = { ...base.mods };
    for (const [key, delta] of modDelta) mods[key] = baseMod(base.mods, key) + delta;
    out.mods = Object.freeze(mods);
  }

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE RESIST ROW LIVES UNDER `profile`, WHICH THIS FOLD OTHERWISE CARRIES BY
   * REFERENCE — SO IT IS REBUILT RATHER THAN MUTATED.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * The note above lists `profile` among the fields *"carried across BY
   * REFERENCE … readonly all the way down and nothing in the process mutates
   * them"*. That stays true: this writes a NEW `profile` object with a NEW
   * `resists` table and leaves the caller's alone. Writing into `base.profile`
   * would be exactly the cross-actor contamination this file exists to prevent
   * — every classless body in the process sharing one frozen sheet.
   *
   * `resistsCap` AND `flatDamageArmour` ARE CARRIED THROUGH UNTOUCHED. An item
   * cannot move either: a cap is what stops the resist formula inverting above
   * 100% (Combat.lua:2227-2228), and letting gear raise its own ceiling would be
   * an item that grants immunity in two affixes rather than one.
   */
  /**
   * EMITTED ONLY WHEN SOMETHING GRANTED ONE, exactly as every table above is.
   * `composeSheet(base, [])` must deep-equal `base`, and an unconditional
   * `onHit: []` would make an empty fold structurally different from the sheet
   * it folded — which breaks the round-trip proof that unequipping everything
   * restores the original.
   *
   * THE BASE'S OWN COME FIRST. A class sheet cannot author a rider today, but
   * concatenating rather than replacing is what makes that a content question
   * instead of a second edit here.
   */
  if (riders.length > 0) {
    out.onHit = Object.freeze([...(base.onHit ?? []), ...riders]);
  }

  if (resistDelta.size > 0) {
    const resists: { -readonly [K in keyof TypeTable]: TypeTable[K] } = {
      ...base.profile?.resists,
    };
    for (const [key, delta] of resistDelta) resists[key] = (resists[key] ?? 0) + delta;
    out.profile = Object.freeze({ ...base.profile, resists: Object.freeze(resists) });
  }

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE TWO ATTACKER-SIDE TABLES, REBUILT RATHER THAN MUTATED.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `increase` and `penetration` sit directly on the sheet rather than under
   * `profile`, so each is one fresh frozen table — but the rule is the resist
   * row's exactly: never write into the caller's, because the class sheet is
   * shared by every body of that class and a write would contaminate all of them.
   *
   * ADDITIVE, and for `resists`' reason: two rings at +5 fire are +10 fire,
   * which is what upstream's plain `add` on `inc_damage` does.
   */
  if (damageDelta.size > 0) {
    const table: { -readonly [K in keyof TypeTable]: TypeTable[K] } = { ...base.increase };
    for (const [key, delta] of damageDelta) table[key] = (table[key] ?? 0) + delta;
    out.increase = Object.freeze(table);
  }

  if (penDelta.size > 0) {
    const table: { -readonly [K in keyof TypeTable]: TypeTable[K] } = { ...base.penetration };
    for (const [key, delta] of penDelta) table[key] = (table[key] ?? 0) + delta;
    out.penetration = Object.freeze(table);
  }

  /**
   * THE STATUS DEFENCE, rebuilt on the same terms and BOUNDED AT 100 HERE.
   *
   * The other three tables are left unbounded because their readers clamp:
   * `combatGetResist` has `resists_cap`, `damage_types.lua:345-352` bounds
   * penetration. `canBe` clamps too, but a sheet that says 140% would still be
   * a sheet the character panel prints as 140% — a number the player cannot act
   * on, above a ceiling nothing shows them. Clamped where it is composed, so the
   * sheet and the die agree about what is on it.
   */
  if (immunityDelta.size > 0) {
    const table: Record<string, number> = { ...base.immunities };
    for (const [key, delta] of immunityDelta) {
      table[key] = bound((table[key] ?? 0) + delta, 0, 100);
    }
    out.immunities = Object.freeze(table);
  }

  return Object.freeze(out);
}

/**
 * The items an actor is actually wearing, in `SLOT_ORDER` — never in the order
 * the `equipped` map happens to iterate.
 *
 * ═══ WHY THE ORDER IS SPECIFIED AT ALL, GIVEN THAT ADDITION COMMUTES ═══
 * The composed SHEET is order-independent and proven so. Everything downstream
 * of the iteration is not: a Case Log line, a tooltip's row order, and — the one
 * that actually bites — the order a corpse spills its gear onto the floor.
 * ToME sorts its inventories before spilling for exactly this reason
 * (Actor.lua:3038-3040), because emitting drops in hash order gives two replays
 * of one seed the same items in a different floor order, and the bug then
 * presents as "the wrong item got picked up". A `Partial<Record<Slot, string>>`
 * built by a player pressing buttons has whatever key order that produced. This
 * function is where that stops.
 *
 * ═══ REPAIR, NEVER REJECT ═══
 * An id the catalogue does not know is SKIPPED, and so is an item filed under a
 * slot it does not belong in. Both are reachable from a save file written by a
 * build that authored an item this one does not, and neither is worth refusing
 * to load a character over. The equip path is what enforces slot legality when a
 * player asks; this is what survives the aftermath.
 */
export function wornOf(
  equipped: Partial<Record<Slot, string>> | undefined,
  catalogue: ItemCatalogue,
): Item[] {
  if (equipped === undefined) return [];

  const worn: Item[] = [];
  for (const slot of SLOT_ORDER) {
    const id = equipped[slot];
    if (id === undefined) continue;
    const item = catalogue(id);
    if (item === undefined) continue;
    if (item.slot !== slot) continue;
    worn.push(item);
  }
  return worn;
}
