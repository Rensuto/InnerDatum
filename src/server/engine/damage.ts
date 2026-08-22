// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/modules/tome/class/interface/Combat.lua:506-546 (the melee order)
//                                                                  1886-1958 (physicalCrit)
//                                                                  2213-2217 (combatGetFlatResist)
//                                                                  2220-2231 (combatGetResist)
//                                                                  2234-2238 (combatGetResistPen)
//                                                                  2252-2256 (combatGetDamageIncrease)
//             t-engine4 game/modules/tome/data/damage_types.lua:48-528 (defaultProjector)
//                                                              703-720 (physical)
//                                                              727-754 (fire)
//                                                              755-773 (cold)
//                                                              774-792 (lightning)
//                                                              856-875 (darkness)
//                                                              876-904 (mind)
//             t-engine4 game/engines/default/engine/interface/ActorLife.lua:71-81 (takeHit)
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" — https://te4.org/license

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *                        THE ORDERED DAMAGE PIPELINE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The ORDER is the balance. Every stage below is commutative-looking and none of
 * them are; moving one produces a game that still runs, still passes its tests,
 * and is tuned wrong everywhere. The numbered list in `resolveDamage` is the
 * spec, each step carries its citation, and the tests pin the two steps that are
 * most often reordered (the range roll and the crit).
 *
 *  1. DAMAGE-RANGE ROLL         Combat.lua:511   ← FIRST, before armour
 *  2. ARMOUR / HARDINESS        Combat.lua:540-541
 *  3. CRIT                      Combat.lua:544   ← AFTER armour
 *  4. TALENT MULTIPLIER         Combat.lua:546
 *  5. SOURCE DEBUFFS            damage_types.lua:146-153
 *  6. inc_damage (ADDITIVE %)   damage_types.lua:270
 *  7. RESISTANCES               damage_types.lua:345-352 + Combat.lua:2220-2231
 *  8. FLAT DAMAGE ARMOUR        damage_types.lua:404-409
 *  9. takeHit                   ActorLife.lua:71-81
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHY STEP 1 IS FIRST — Combat.lua:508-509, upstream's own comment
 * ───────────────────────────────────────────────────────────────────────────
 * *"Apply weapon damage range. By doing this first, variable damage is more
 * 'smooth' against high armor."* Roll after armour and a high-armour target
 * turns every low roll into a flat zero while high rolls sail through — the
 * variance stops being variance and becomes a threshold. Roll first and armour
 * shaves a consistent slice off the whole distribution.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHY STEP 3 IS AFTER STEP 2 — Combat.lua:541 then :544
 * ───────────────────────────────────────────────────────────────────────────
 * Crit multiplies what SURVIVED armour, not what was swung. Crit before armour
 * and armour becomes a rounding error on any critical hit, which makes crit
 * chance the only defensive stat that matters. This is the single most commonly
 * mis-ported line in ToME and the wiki gets it backwards.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * STEP 2 IS NOT `dam − armour` — Combat.lua:541
 * ───────────────────────────────────────────────────────────────────────────
 *     dam = max(dam * pres - armor, 0) + (dam * (1 - pres))
 * Armour bites only into the `hardiness` FRACTION of the blow (base 30%); the
 * other 70% always lands. Plain subtraction feels immediately wrong in play and
 * makes low-level tanks unkillable, because at level 3 a 6-armour character
 * simply stops taking damage.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * STEP 7 CARRIES THE CLAMPS — Combat.lua:2227-2228
 * ───────────────────────────────────────────────────────────────────────────
 * See `combatGetResist`. Without them the formula INVERTS above 100% and an
 * over-resistant target takes MORE damage. docs/tome-mechanics.md § 8 omits
 * them; the Lua wins.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * SCOPE — what is deliberately absent
 * ═══════════════════════════════════════════════════════════════════════════
 * `damage_types.lua` is 4,076 lines and `Actor.lua:onTakeHit` is ~723 more,
 * because ~90% of both is one-off talent interception: shields, wards, parries,
 * Premonition, Kinetic/Thermal/Charged shields, martyrdom, reflect, affinity
 * heals, iceblocks. None of those talents exist here (PLAN.md caps MVP at 12),
 * so none of their hooks do either. What remains is the ordered spine, which is
 * where all of the feel lives.
 *
 * SYNCHRONOUS AND SEEDED. No await (six AST selectors), no `Math.random` — every
 * draw goes through the `Rng` the caller passes, with a label, so a replay
 * divergence names its call site.
 */

import { FLAT_RESIST_INTERVAL, bound, rescaleCombatStats } from '../../shared/scale.ts';
import type { Rng } from '../../shared/rng.ts';
import { fireDealDamage, fireKill, fireTakeDamage } from './hooks.ts';
import type { BoundHooks, HookHost, TurnProcs } from './hooks.ts';

// ---------------------------------------------------------------------------
// The damage-type registry
// ---------------------------------------------------------------------------

/**
 * The six MVP damage types.
 *
 * `as const` object plus a derived union, NOT an `enum`: `erasableSyntaxOnly` is
 * on because Node type-strips these files and runs them directly, so an enum
 * would not survive to runtime.
 *
 * ToME ships 161 types across 4,076 lines. The overwhelming majority are a
 * single talent's bespoke side effect wearing a damage type's clothes
 * (`DamageType.BLIGHT_DISEASE`, `DamageType.ITEM_ANTIMAGIC_MANABURN`), which is
 * a talent, not a type. These six are the ones with a real identity: a resist
 * column, a colour in the log, and — from M4 — a status they tend to apply.
 *
 * Values are lowercase strings rather than ToME's SCREAMING_CASE because they
 * cross the wire into `content/` JSON and the client's log renderer, where they
 * are matched against authored `*_resistance_pct` keys.
 */
export const DamageType = {
  /** damage_types.lua:703-720. The default for any attack that names none. */
  Physical: 'physical',
  /** damage_types.lua:727-754. The Alchemist's whole kit. */
  Fire: 'fire',
  /** damage_types.lua:755-773. */
  Cold: 'cold',
  /** damage_types.lua:774-792. */
  Lightning: 'lightning',
  /** damage_types.lua:856-875. The Redacted's signature. */
  Darkness: 'darkness',
  /** damage_types.lua:876-904. Resisted by the MENTAL save, not the physical. */
  Mind: 'mind',
} as const;
export type DamageType = (typeof DamageType)[keyof typeof DamageType];

/** Every type, in a fixed order — for iteration that must be reproducible. */
export const DAMAGE_TYPES: readonly DamageType[] = [
  DamageType.Physical,
  DamageType.Fire,
  DamageType.Cold,
  DamageType.Lightning,
  DamageType.Darkness,
  DamageType.Mind,
] as const;

/**
 * A per-type table with an `all` row — ToME's `resists.all + resists[type]`
 * shape (Combat.lua:2227-2228, 2236, 2243, 2253-2255).
 *
 * The `all` row is not a convenience: it composes MULTIPLICATIVELY with the
 * typed row for resistances (see `combatGetResist`) and ADDITIVELY for
 * penetration and damage increase. Three tables, two different algebras, and
 * upstream is consistent about which is which.
 */
export type TypeTable = Partial<Record<DamageType | 'all', number>>;

function tableValue(table: TypeTable | undefined, type: DamageType): number {
  if (table === undefined) return 0;
  return table[type] ?? 0;
}

function tableAll(table: TypeTable | undefined): number {
  if (table === undefined) return 0;
  return table.all ?? 0;
}

// ---------------------------------------------------------------------------
// The defender's damage-side profile
// ---------------------------------------------------------------------------

/**
 * ToME's engine default for `resists_cap` — Actor.lua:211, `{ all = 100 }`.
 *
 * The familiar 70% figure is a PLAYER birth descriptor
 * (data/birth/descriptors.lua:63, `resists_cap = {all=70}`), not an engine
 * constant. Monsters really do cap at 100. docs/tome-mechanics.md § 0 records
 * this; it matters because a monster authored with 100 fire resist is genuinely
 * immune and a player with the same number is not.
 */
export const DEFAULT_RESIST_CAP = 100;

/** What the pipeline needs to know about whoever is being hit. */
export type DamageProfile = {
  /** `resists` — percentages. Composed multiplicatively with the `all` row. */
  readonly resists?: TypeTable;
  /** `resists_cap` — the ceiling, SUMMED across `all` + typed (Combat.lua:2229). */
  readonly resistsCap?: TypeTable;
  /** `flat_damage_armor` — subtracted flat, AFTER percentages (damage_types.lua:404-409). */
  readonly flatDamageArmour?: TypeTable;
};

/**
 * RESISTANCE — Combat.lua:2220-2231.
 *
 * ```lua
 * local a = math.min((self.resists.all or 0) / 100, 1) -- Prevent large numbers
 * local b = math.min((self.resists[type] or 0) / 100, 1) -- from inverting the formulas
 * local r = util.bound(100 * (1 - (1 - a) * (1 - b)), -100,
 *                      (self.resists_cap.all or 0) + (self.resists_cap[type] or 0))
 * ```
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * LINES 2227-2228 ARE THE CLAMPS. THEY ARE NOT OPTIONAL.
 * ═══════════════════════════════════════════════════════════════════════════
 * The composition `1 − (1−a)(1−b)` is only monotone while `a, b ≤ 1`. Past that
 * both factors go NEGATIVE, their product turns POSITIVE, and the resistance
 * falls back down — an actor with more protection takes more damage. Upstream's
 * own comment says so in as many words, and docs/tome-mechanics.md § 8 quotes
 * the formula without them.
 *
 *   resists { all: 200, fire: 200 }, cap 100
 *     WITH the clamps:  a = 1,   b = 1   → 100% → immune
 *     WITHOUT:          a = 2,   b = 2   → 100·(1 − (−1)(−1)) = 0% → full damage
 *
 * A test pins exactly that pair.
 *
 * Composition is MULTIPLICATIVE: 50% all and 50% fire is 75%, not 100%. That is
 * what keeps stacked resistance sources from reaching immunity by addition.
 *
 * The floor of −100 is what makes vulnerability cap at double damage
 * (damage_types.lua:350) rather than running away.
 */
export function combatGetResist(profile: DamageProfile, type: DamageType): number {
  // Combat.lua:2227-2228 — the clamps. Do not remove.
  const a = Math.min(tableAll(profile.resists) / 100, 1);
  const b = Math.min(tableValue(profile.resists, type) / 100, 1);

  const caps = profile.resistsCap;
  const cap = caps === undefined ? DEFAULT_RESIST_CAP : (caps.all ?? 0) + (caps[type] ?? 0);

  return bound(100 * (1 - (1 - a) * (1 - b)), -100, cap);
}

/** PENETRATION — Combat.lua:2234-2238. ADDITIVE across `all` + typed. */
export function combatGetResistPen(pen: TypeTable | undefined, type: DamageType): number {
  return tableAll(pen) + tableValue(pen, type);
}

/**
 * FLAT DAMAGE ARMOUR — Combat.lua:2213-2217.
 *
 * ```lua
 * local dec = (self.flat_damage_armor.all or 0) + (self.flat_damage_armor[type] or 0)
 * return self:rescaleCombatStats(dec, 40)
 * ```
 *
 * Note the INTERVAL 40 — this is the one caller in the whole game that does not
 * use the default 20. Flat reduction applies to every hit no matter how small,
 * so it needs a flatter curve or it trivialises chip damage; `FLAT_RESIST_INTERVAL`
 * exists in scale.ts so the 40 cannot quietly drift back to 20.
 */
export function combatGetFlatResist(profile: DamageProfile, type: DamageType): number {
  const flat = profile.flatDamageArmour;
  if (flat === undefined) return 0;
  return rescaleCombatStats(tableAll(flat) + tableValue(flat, type), FLAT_RESIST_INTERVAL);
}

/** DAMAGE INCREASE — Combat.lua:2252-2256. ADDITIVE percentages, `all` + typed. */
export function combatGetDamageIncrease(inc: TypeTable | undefined, type: DamageType): number {
  return tableAll(inc) + tableValue(inc, type);
}

// ---------------------------------------------------------------------------
// The individual stages
// ---------------------------------------------------------------------------

/**
 * STEP 1 — the damage-range roll. Combat.lua:511, `rng.range(dam, dam * damrange)`.
 *
 * REIMPLEMENTED, NOT TRANSLATED, and the difference matters. ToME's `rng.range`
 * is native C and absent from the reference clone (1,656 `.lua` files, zero
 * `.c`/`.h` — docs/tome-mechanics.md § 10). Its documented semantics are an
 * inclusive integer range, and because the C entry point takes its arguments
 * through `luaL_checknumber` into an `int`, BOTH ENDPOINTS TRUNCATE toward zero.
 * So `rng.range(12.7, 20.3)` is a uniform integer in `[12, 20]`, and the roll is
 * where a float damage value first becomes an integer.
 *
 * That truncation is reproduced here rather than rounded, because rounding the
 * low end up biases every weapon in the game upward by half a point.
 */
export function rollDamageRange(dam: number, damRange: number, rng: Rng, label: string): number {
  const low = Math.trunc(dam);
  const high = Math.trunc(dam * damRange);
  if (low === high) return low;
  return low < high ? rng.int(label, low, high) : rng.int(label, high, low);
}

/**
 * STEP 2 — armour and hardiness. Combat.lua:540-541.
 *
 * ```lua
 * armor = math.max(0, armor - apr)
 * dam = math.max(dam * pres - armor, 0) + (dam * (1 - pres))
 * ```
 *
 * `pres` is `bound(hardiness / 100, 0, 1)` (:506). Penetration is subtracted
 * from ARMOUR here — subtractive, unlike resistance penetration in step 7, which
 * is multiplicative. Two penetration stats, two different algebras, and mixing
 * them up is the reason "penetration feels dead" bug reports exist.
 *
 * Worked example (dam 20, armour 10, apr 0, hardiness 30):
 *   pres = 0.3 → max(20·0.3 − 10, 0) + 20·0.7 = 0 + 14 = 14
 * Ten points of armour against a 20-point blow removes six, not ten, and the
 * remaining 70% of the blow was never eligible to be blocked.
 */
export function applyArmour(dam: number, armour: number, apr: number, hardiness: number): number {
  const pres = bound(hardiness / 100, 0, 1);
  const effective = Math.max(0, armour - apr);
  return Math.max(dam * pres - effective, 0) + dam * (1 - pres);
}

/** What a crit roll produced. */
export type CritResult = {
  readonly dam: number;
  readonly crit: boolean;
};

/**
 * STEP 3 — the crit. Combat.lua:1935-1952 (`physicalCrit`); spell and mind are
 * the same three lines at :1977-1980 and :2025-2028.
 *
 * ```lua
 * chance = util.bound(chance, 0, 100)
 * if rng.percent(chance) then
 *     dam = dam * (1.5 + crit_power_add + (self.combat_critical_power or 0) / 100)
 * end
 * ```
 *
 * The clamp to `[0, 100]` happens HERE, not in `combatCrit` — Combat.lua:1426
 * says so explicitly, because crit reduction (`combatCritReduction`, :1869-1883)
 * is subtracted from the chance in between and needs the headroom above 100 to
 * bite into.
 *
 * The draw is unconditional even at 0% or 100%, for the same replay reason as in
 * checkhit.ts: skipping a draw shifts every subsequent roll in the turn.
 *
 * `deflect == 0` guards this call at :544 — a fully parried blow cannot crit.
 * Parry is M4+; the guard is the caller's, and combat.ts carries the note.
 */
export function rollCrit(
  dam: number,
  chance: number,
  critPower: number,
  rng: Rng,
  label: string,
): CritResult {
  const bounded = bound(chance, 0, 100);
  const roll = rng.int(label, 1, 100);
  if (roll > bounded) return { dam, crit: false };
  return { dam: dam * critPower, crit: true };
}

/**
 * STEP 7 — resistance, with MULTIPLICATIVE penetration.
 * damage_types.lua:345-352.
 *
 * ```lua
 * local res = target:combatGetResist(type)
 * pen = util.bound(pen, 0, 100)
 * if res > 0 then res = res * (100 - pen) / 100 end
 * if res >= 100 then dam = 0
 * elseif res <= -100 then dam = dam * 2
 * else dam = dam * ((100 - res) / 100) end
 * ```
 *
 * ═══ PENETRATION IS MULTIPLICATIVE ═══
 * 10 penetration against 30 resistance leaves **27**, not 20. Implementers
 * reflexively write subtraction; the result is penetration gear that feels dead
 * at low resistance and broken at high, and the numbers are close enough at
 * mid-range that playtesting will not catch it.
 *
 * Penetration only applies to POSITIVE resistance (`if res > 0`) — it cannot be
 * used to deepen a vulnerability.
 */
export function applyResists(dam: number, resist: number, penetration: number): number {
  let res = resist;
  const pen = bound(penetration, 0, 100);
  if (res > 0) res = (res * (100 - pen)) / 100;

  if (res >= 100) return 0;
  if (res <= -100) return dam * 2;
  return (dam * (100 - res)) / 100;
}

// ---------------------------------------------------------------------------
// The pipeline
// ---------------------------------------------------------------------------

/**
 * One blow, described completely.
 *
 * Optional fields are genuinely optional STAGES, not defaulted numbers: a talent
 * that deals exact damage omits `damageRange` and no roll happens (and no draw
 * is consumed); an unarmed swing at nothing omits `armour` and step 2 is skipped
 * entirely. That is faithful — ToME only runs the range roll and the armour
 * stage inside `attackTargetWith`, never in the projector, so a spell has never
 * been reduced by armour in ToME's entire history.
 */
export type DamageSpec = {
  /** Base damage before any stage. `combatDamage()` for a weapon swing. */
  readonly base: number;
  readonly type: DamageType;

  // --- step 1 ---------------------------------------------------------------
  /** Present → roll `[base, base × damageRange]`. Absent → exact damage. */
  readonly damageRange?: number;

  // --- step 2 ---------------------------------------------------------------
  /** Target's `combatArmor()`. Absent → no armour stage (spells, DoTs). */
  readonly armour?: number;
  /** Target's `combatArmorHardiness()`. Only read when `armour` is present. */
  readonly hardiness?: number;
  /** Attacker's `combatAPR()`. */
  readonly apr?: number;

  // --- step 3 ---------------------------------------------------------------
  /** Present → roll a crit. Absent → no crit and no draw. */
  readonly critChance?: number;
  /** `combatCritPower()`. Only read when `critChance` is present. */
  readonly critPower?: number;

  // --- step 4 ---------------------------------------------------------------
  /** The talent multiplier (Combat.lua:546). Sniper's Mark is 1.65. */
  readonly mult?: number;

  // --- step 5 ---------------------------------------------------------------
  /** Source is Dazed — ×0.5 (damage_types.lua:146-148). */
  readonly sourceDazed?: boolean;
  /** Source is Stunned — ×0.4 (damage_types.lua:150-153). */
  readonly sourceStunned?: boolean;

  // --- step 6 ---------------------------------------------------------------
  /** Attacker's `inc_damage` table. Additive percentages. */
  readonly increase?: TypeTable;

  // --- step 7 ---------------------------------------------------------------
  /** Attacker's `resists_pen` table. */
  readonly penetration?: TypeTable;
};

/** The pipeline's output, before it reaches a body. */
export type DamageResolution = {
  /** Final damage. A FLOAT — ToME never rounds, and neither does this. */
  readonly amount: number;
  readonly crit: boolean;
  /** Damage after step 4, before the projector. Useful for a log's "raw" figure. */
  readonly beforeResists: number;
  /** The composed resistance percentage actually used, post-penetration inputs. */
  readonly resist: number;
};

/**
 * THE PIPELINE. Run the nine numbered steps in order.
 *
 * Read the numbered comments as the specification; each one is the citation for
 * the line above it. If a stage ever needs to move, it moves here and the
 * comment moves with it, and the diff will be visible in review — which is the
 * entire point of resolving damage in one function rather than in five call
 * sites that each do part of it.
 */
export function resolveDamage(
  spec: DamageSpec,
  target: DamageProfile,
  rng: Rng,
  label: string,
): DamageResolution {
  let dam = spec.base;

  // 1. DAMAGE-RANGE ROLL — Combat.lua:511. FIRST, before armour, so that
  //    variance stays variance against a high-armour target.
  if (spec.damageRange !== undefined) {
    dam = rollDamageRange(dam, spec.damageRange, rng, `${label}.range`);
  }

  // 2. ARMOUR / HARDINESS — Combat.lua:540-541. Only the hardiness fraction of
  //    the blow is eligible; the rest always lands.
  if (spec.armour !== undefined) {
    dam = applyArmour(dam, spec.armour, spec.apr ?? 0, spec.hardiness ?? 0);
  }

  // 3. CRIT — Combat.lua:544. AFTER armour. Multiplies what survived.
  let crit = false;
  if (spec.critChance !== undefined) {
    const rolled = rollCrit(dam, spec.critChance, spec.critPower ?? 1.5, rng, `${label}.crit`);
    dam = rolled.dam;
    crit = rolled.crit;
  }

  // 4. TALENT MULTIPLIER — Combat.lua:546.
  if (spec.mult !== undefined) dam = dam * spec.mult;

  const beforeResists = dam;

  // 5. SOURCE DEBUFFS — damage_types.lua:146-153. Dazed ×0.5, Stunned ×0.4, and
  //    they COMPOUND: a dazed-and-stunned attacker deals 20%.
  if (spec.sourceDazed === true) dam = dam * 0.5;
  if (spec.sourceStunned === true) dam = dam * 0.4;

  // 6. inc_damage — damage_types.lua:270, `dam = dam + (dam * inc / 100)`.
  //    ADDITIVE percentages: +20% and +30% is +50%, not +56%.
  const inc = combatGetDamageIncrease(spec.increase, spec.type);
  if (inc !== 0) dam = dam + (dam * inc) / 100;

  // 7. RESISTANCES — damage_types.lua:345-352, with the Combat.lua:2227-2228
  //    clamps inside `combatGetResist`. Penetration is MULTIPLICATIVE.
  const resist = combatGetResist(target, spec.type);
  dam = applyResists(dam, resist, combatGetResistPen(spec.penetration, spec.type));

  // 8. FLAT DAMAGE ARMOUR — damage_types.lua:404-409. After the percentages, so
  //    it is worth most against the many small hits and least against one big
  //    one. `min(dam, dec)` first, so it can never push damage negative.
  if (dam > 0) {
    const dec = Math.min(dam, combatGetFlatResist(target, spec.type));
    if (dec > 0) dam = Math.max(0, dam - dec);
  }

  return { amount: dam, crit, beforeResists, resist };
}

// ---------------------------------------------------------------------------
// Applying it to a body
// ---------------------------------------------------------------------------

/** The minimum an actor needs for step 9. `EngineActor` satisfies it. */
export type DamageTarget = {
  hp: number;
  alive: boolean;
  readonly combat?: { readonly profile?: DamageProfile };
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * WHAT THIS BODY DOES ABOUT BEING HIT. See engine/hooks.ts.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * OPTIONAL, AND STRUCTURAL, so every existing caller and every fixture keeps
   * working untouched — a target with no hooks folds to the identity and costs
   * one array check.
   *
   * BOUND ONTO THE BODY RATHER THAN LOOKED UP HERE. This module must not know
   * that talents exist: `engine -> net|persist` is forbidden and a registry
   * lookup would drag the whole content layer into the damage path. The same
   * fold that composes passives writes this array (see `refreshPassives`), so
   * there is exactly one copy and nothing to keep in step.
   */
  readonly talentHooks?: readonly BoundHooks[];
  readonly turnProcs?: TurnProcs;
  /**
   * ═══ WHO THIS BODY IS, FOR ITS OWN HOOKS ONLY ═══
   * A hook is handed `self`, and a talent that reads "while below half health"
   * needs a ceiling to compare against. Every production caller passes an
   * `Actor`, which has all four already; they are OPTIONAL so that the dozens
   * of existing fixtures — which pass `{ hp, alive }` and nothing else — keep
   * compiling untouched.
   */
  readonly id?: string;
  readonly name?: string;
  readonly maxHp?: number;
  readonly x?: number;
  readonly y?: number;
};

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * TELL THE ATTACKER WHAT THEY JUST DID. Notification only.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `fireDealDamage` and `fireKill` had no callers at all, so `leverage.ts`'s heal
 * ("the first blow you land each turn returns N hit points to you") and
 * `nerve.ts`'s kill payoff never ran. Both talents were written, reviewed,
 * tested against their own hook bodies, and reachable by nothing.
 *
 * ═══ THE SOURCE ITSELF IS THE HOST, NEVER A COPY ═══
 * `hasBody` narrows the argument in place, so the object handed to the
 * dispatchers is the attacker's actual body and a hook that writes `ctx.self.hp`
 * writes to the actor. Assembling a literal from these fields would compile,
 * run, fire, and heal a temporary — see the note at the turn-start fire site in
 * engine/talents.ts, which is where that mistake was made and caught.
 *
 * ═══ DEAL BEFORE KILL, BECAUSE A KILL IS ALSO A HIT ═══
 * A blow that finishes a body is both, and the order is the one the sentences
 * imply: "when you land a blow" resolves before "when you kill something". A
 * talent doing both sees them in that order rather than in whichever order this
 * function happened to be written.
 *
 * ═══ IT TAKES NO RNG DRAW ═══
 * The long note at the death branch below states the rule: adding a draw inside
 * `applyDamage` shifts every subsequent draw for the rest of the session. A
 * `TalentHooks` implementation is handed no `Rng` and cannot reach one, so this
 * call cannot move a replay.
 */
function notifySource(
  source: DamageSource,
  targetId: string,
  dam: number,
  type: DamageType,
  crit: boolean,
  killed: boolean,
): void {
  if (!hasBody(source)) return;
  fireDealDamage(source, { targetId, dam, type, crit, killed });
  if (killed) fireKill(source, targetId);
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ANYTHING THAT CAN BE BLAMED FOR A HIT. The maths is still in the spec.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * This was `{ id }` and its comment said "identity only". That was true of the
 * maths and it is what made `fireDealDamage` and `fireKill` unreachable: both
 * dispatchers need the ATTACKER's body, and `applyDamage` was handed a name tag.
 * Two hooks shipped with a context type, a dispatch loop, and no way to be
 * called — `leverage.ts`'s heal and `nerve.ts`'s kill payoff never ran.
 *
 * ═══ EVERY FIELD OPTIONAL, WHICH IS NOT LAZINESS ═══
 * The same shape `DamageTarget` above uses, for the same reason its own note
 * gives: a caller with nothing but an id — a trap, a bleed with a dead author,
 * a fixture — keeps compiling untouched and simply grows no hooks. `hasBody`
 * below is the one place that decides whether there is enough here to fire.
 *
 * `hp` IS MUTABLE because a hook writes to it: `leverage.ts` heals the attacker
 * on the blow it landed. That write must reach the real body, which is why this
 * type describes the actor rather than a copy of it — see the fire site.
 */
export type DamageSource = {
  readonly id: string;
  readonly name?: string;
  hp?: number;
  readonly maxHp?: number;
  readonly alive?: boolean;
  readonly x?: number;
  readonly y?: number;
  readonly talentHooks?: readonly BoundHooks[];
  readonly turnProcs?: TurnProcs;
};

/**
 * IS THERE ENOUGH OF A BODY HERE TO RUN A HOOK ON?
 *
 * A TYPE PREDICATE RATHER THAN A CAST, and it narrows the ARGUMENT rather than
 * returning a new object. That is the whole point: `ctxFor` sets `self: host`,
 * so a hook that mutates writes into whatever object it was handed. Returning a
 * literal assembled from these fields would take the write and discard it — the
 * bug `talents.ts`'s turn-start fire site records having made once already.
 *
 * The checks are exactly `HookSelf`'s required members. A body missing any of
 * them is a source that was never an actor, and it fires nothing.
 */
function hasBody(source: DamageSource): source is DamageSource & HookHost {
  return (
    source.talentHooks !== undefined &&
    source.talentHooks.length > 0 &&
    source.name !== undefined &&
    source.hp !== undefined &&
    source.maxHp !== undefined &&
    source.alive !== undefined &&
    source.x !== undefined &&
    source.y !== undefined
  );
}

export type DamageOutcome = {
  /** HP actually removed — never more than the target had. What the log prints. */
  readonly dealt: number;
  /** The pipeline's own figure before the clamp to remaining HP. */
  readonly raw: number;
  readonly crit: boolean;
  /** True only on the blow that crossed zero, so the death event fires once. */
  readonly killed: boolean;
  readonly type: DamageType;
  readonly source: string;
};

/**
 * STEP 9 — `takeHit`. ActorLife.lua:71-81.
 *
 * ```lua
 * self.life = self.life - value
 * if self.life <= self.die_at and not self.dead then ... return self:die(...) end
 * ```
 *
 * TWO DELIBERATE DEVIATIONS from upstream, both recorded rather than hidden:
 *
 *   1. `die_at` is pinned to 0. ToME lets an actor configure a negative death
 *      threshold; nothing in MVP uses it, and the Downed state (game-design.md
 *      § 9) is a scheduler concern rather than a damage one.
 *   2. `dealt` is CLAMPED to the target's remaining HP, where ToME returns the
 *      full uncapped value. The log reads "Wraith 45 → 0", so reporting 61
 *      damage to a 45 HP monster would be a lie in the only place a player can
 *      see it. `raw` carries the uncapped figure for anything that needs it.
 *
 * The BODY IS NOT REMOVED — `alive` goes false and it stops blocking movement,
 * but it stays in the actor table so the log, the death event and a player's
 * reconnect all still have something to point at. That is the existing M2
 * contract (engine/actor.ts) and this function preserves it.
 */
export function applyDamage(
  target: DamageTarget,
  amount: number,
  type: DamageType,
  source: DamageSource,
  rng: Rng,
  spec: Omit<DamageSpec, 'base' | 'type'> = {},
): DamageOutcome {
  const resolved = resolveDamage(
    { ...spec, base: amount, type },
    target.combat?.profile ?? {},
    rng,
    `combat.damage.${type}`,
  );

  const empty: DamageOutcome = {
    dealt: 0,
    raw: resolved.amount,
    crit: resolved.crit,
    killed: false,
    type,
    source: source.id,
  };

  // A swing at a corpse still consumed its draws above — that is intentional, so
  // the stream does not depend on whether the target happened to die first.
  if (!target.alive || resolved.amount <= 0) return empty;

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * WHAT THIS BODY DOES ABOUT IT. The rewrite chain — see engine/hooks.ts.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * HERE, AND THE POSITION IS THE WHOLE DESIGN. This is the final figure:
   * `resolveDamage` above has already rolled the range, applied armour against
   * penetration and hardiness, taken resists, and rolled the crit. The next
   * statement moves hit points.
   *
   * A hook placed upstream of that maths would be rewriting an input three
   * multiplications away from anything a player experiences, and a talent that
   * says "no single blow takes more than a quarter of you" would mean the blow
   * before mitigation — which is not what the sentence says, and not what
   * anybody would predict from it.
   *
   * ═══ AND BEFORE THE CLAMP TO REMAINING HP, WHICH ALSO MATTERS ═══
   * `lethal` is computed against the figure as it stands, so a last-stand hook
   * can ask "would this kill me" and get an honest answer. Clamping first would
   * make every fatal blow indistinguishable from one that left the body at zero.
   */
  const after =
    target.talentHooks === undefined || target.talentHooks.length === 0
      ? resolved.amount
      : fireTakeDamage(
          {
            id: target.id ?? '',
            name: target.name ?? '',
            hp: target.hp,
            maxHp: target.maxHp ?? target.hp,
            alive: target.alive,
            x: target.x ?? 0,
            y: target.y ?? 0,
            talentHooks: target.talentHooks,
            turnProcs: target.turnProcs,
          },
          {
            dam: resolved.amount,
            type,
            sourceId: source.id,
            lethal: resolved.amount >= target.hp,
          },
        );

  // A CHAIN THAT REFUSED THE BLOW OUTRIGHT still consumed the draws above and
  // still reports the pipeline figure as `raw` — the roll happened; this body
  // simply did not take it.
  if (after <= 0) return empty;

  const dealt = Math.min(target.hp, after);
  target.hp -= dealt;

  if (target.hp <= 0) {
    target.hp = 0;
    /**
     * ═════════════════════════════════════════════════════════════════════════
     * THIS IS THE MOMENT A MONSTER DIES, AND IT IS DELIBERATELY DRAW-FREE.
     * ═════════════════════════════════════════════════════════════════════════
     *
     * NOTHING FUNCTIONAL CHANGED HERE FOR THE DROP SYSTEM. This note exists
     * because these three lines are the obvious place to put a drop roll, the
     * obvious place is wrong, and there is no error anywhere to say so.
     *
     * `applyDamage` runs inside the pump on `world.rng` — the single linear
     * stream that `combat.checkhit`, `combat.crit`, `combat.bump.damage`,
     * `ai.fire.chance`, `ai.flee.side`, `ai.flee.hardside` and `ai.target.keep`
     * all consume in turn order. shared/rng.ts:31-39 states the rule: renaming a
     * label never alters a replay, ADDING OR REMOVING A DRAW ALWAYS DOES. So one
     * `rng.percent(35)` on this line would shift every subsequent draw in this
     * pump AND in every pump for the rest of the session — a monster that dies
     * changes what the next monster rolls to hit.
     *
     * WHAT WOULD AND WOULD NOT HAVE CAUGHT IT, because it is not obvious and it
     * decided the design: scheduler.test.ts:390 pins `damage` to a literal 4 and
     * :395-396 requires both a hit and a miss across twelve turns — both would
     * have gone red, eventually, in a file about something else. The assertion
     * that LOOKS like the guard, :400-408's `rng.getState()` equality, would have
     * passed: it tests replay CONSISTENCY, not absolute stream position. And the
     * twelve files using test/helpers/scripted-rng.ts inject BELOW this level
     * (into `attackTarget` / `applyDamage` / `rollCrit` directly), so its
     * over-draw throw would not have fired either. Nothing in the suite would
     * have gone red on the way to a broken replay.
     *
     * THE ROLL IS AT SPAWN INSTEAD — content/encounter.ts, on `world.lootRng`, a
     * third fork off the root. That is not a workaround, it is what upstream
     * does: `resolvers.calc.drops` resolves the drop at ENTITY RESOLUTION
     * (modules/tome/resolvers.lua:427-450, `__resolve_last = true` at :421) and
     * `Actor:die` spills an already-decided inventory
     * (modules/tome/class/Actor.lua:3011-3060) with no drop-table draw in it. Our
     * spill is `spillLoot` in engine/scheduler.ts, and it draws nothing either.
     *
     * If a future pass wants a first-refusal window for the killer, a rarity
     * re-roll, or anything else that needs a random number when something dies:
     * it does not go here. Take it on `world.lootRng` at a site that is not
     * inside `applyDamage`, and say in the commit what it costs.
     */
    target.alive = false;
    notifySource(source, target.id ?? '', dealt, type, resolved.crit, true);
    return { ...empty, dealt, killed: true };
  }

  notifySource(source, target.id ?? '', dealt, type, resolved.crit, false);
  return { ...empty, dealt };
}
