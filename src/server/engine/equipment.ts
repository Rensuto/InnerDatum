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
 * Both are float round trips and both drift. Upstream knows: Actor.lua:105-108
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
import type { AdditiveMods, AdditiveStats, Item, ItemCatalogue, Slot } from '../content/items.ts';
import type { CombatSheet } from './combat.ts';
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
  'physResist',
  'spellResist',
  'mentalResist',
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
  const resistDelta = new Map<DamageType, number>();

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
  if (resistDelta.size > 0) {
    const resists: { -readonly [K in keyof TypeTable]: TypeTable[K] } = {
      ...base.profile?.resists,
    };
    for (const [key, delta] of resistDelta) resists[key] = (resists[key] ?? 0) + delta;
    out.profile = Object.freeze({ ...base.profile, resists: Object.freeze(resists) });
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
