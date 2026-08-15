// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/modules/tome/class/interface/Combat.lua:1216-1263 (combatDefense)
//                                                                  1275-1303 (combatArmor)
//                                                                  1307-1337 (combatArmorHardiness)
//                                                                  1340-1361 (combatAttack)
//                                                                  1402-1406 (combatAPR)
//                                                                  1409-1412 (combatSpeed)
//                                                                  1415-1427 (combatCrit)
//                                                                  1430-1433 (combatDamageRange)
//                                                                  1621-1687 (combatDamage)
//                                                                  1689-1733 (combatPhysicalpower)
//                                                                  1744-1771 (combatSpellpower)
//                                                                  1886-1951 (physicalCrit power)
//                                                                  2056-2084 (combatMindpower)
//                                                                  2122-2204 (the three saves)
//             t-engine4 game/modules/tome/class/Actor.lua:141-162 (the zero defaults)
//             t-engine4 game/modules/tome/load.lua:182-189 (primary stat defaults)
//             t-engine4 game/engines/default/engine/interface/ActorStats.lua:120-142 (getStat)
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" — https://te4.org/license

/**
 * DERIVED STATS — the six primaries and a pile of flat `combat_*` bonuses in,
 * every number the combat pipeline consumes out.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE SHAPE OF EVERY GETTER IN THIS FILE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *   1. sum the raw contributions — base field, stats, talent adds
 *   2. apply the multiplicative debuffs (`dazed` halves, `scoured` divides 1.2)
 *   3. `rescaleCombatStats` ONCE, at the very end
 *
 * Step 2 sits BEFORE step 3 in the Lua and that order is load-bearing, because
 * `rescale` is concave: `rescale(x)/2` and `rescale(x/2)` are different numbers,
 * and the gap widens exactly where high-level characters live. Dazed halving
 * after the rescale would make Dazed *stronger* against strong characters, which
 * is the opposite of what the curve is for.
 *
 * Step 3 happens once per STAT, never once per SOURCE. `rescale(a) + rescale(b)`
 * restores linear gear stacking and silently deletes the diminishing-returns
 * design. See src/shared/scale.ts.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * LUCK IS A HIDDEN CONSTANT 50
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `load.lua:189` gives Luck a default of 50, and nine ToME formulas carry a
 * `(Lck − 50)` term. Pinning Luck at its default makes every one of those terms
 * vanish to zero WITHOUT editing nine formulas — so the ported arithmetic stays
 * byte-comparable against the Lua, and the day a Luck stat is wanted it is one
 * field, not nine edits. docs/tome-mechanics.md § 5 records the decision.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * `getDex(100, true)` IS NOT A SCALED READ
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Combat.lua:1355 reads `self:getDex(100, true)`, which looks like a normalised
 * 0-100 value. ActorStats.lua:134-139 shows it is `val * scale / stat.max`, and
 * every ToME stat has `max = 100` (load.lua:182-189), so it is the plain stat
 * value — `raw = true` only suppresses the floor that would otherwise apply.
 * Do not "fix" it into a division.
 *
 * PURE AND SYNCHRONOUS. src/server/engine/ carries the six anti-async AST
 * selectors plus the determinism bans. Nothing here reads a clock, an entropy
 * source or the world; these are functions of their arguments and nothing else,
 * which is what lets a character-sheet preview and the damage pipeline call the
 * identical code and be guaranteed to agree.
 */

import { bound, rescaleCombatStats } from '../../shared/scale.ts';

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** Luck's default (load.lua:189). Pinned, so every `(Lck − 50)` term is zero. */
export const LUCK_BASE = 50;

/** Every other primary's default (load.lua:182-187). */
export const STAT_BASE = 10;

/**
 * The six primaries, plus the pinned Luck.
 *
 * MVP content only authors str/dex/con/cun — mag and wil default to 10 until a
 * caster class exists (docs/tome-mechanics.md § 5). They are in the type from
 * the start because spell power and two of the three saves read them, and a
 * `mag` that appears later would change every save in the game on the day it
 * lands.
 */
export type PrimaryStats = {
  readonly str?: number;
  readonly dex?: number;
  readonly con?: number;
  readonly mag?: number;
  readonly wil?: number;
  readonly cun?: number;
  /** Pinned at 50 unless something deliberately unpins it. */
  readonly lck?: number;
};

/**
 * The flat `combat_*` fields. Actor.lua:141-162 initialises all of them to 0,
 * except the two speeds which start at 1 — so every default here is ToME's.
 *
 * These are the SUM of gear, class base and buffs. They arrive pre-summed
 * because rescaling happens once at the end of the getter; a caller that
 * rescales per item has already lost.
 */
export type CombatMods = {
  /** `combat_atk` — flat accuracy. */
  readonly atk?: number;
  /** `combat_def` — flat defence. */
  readonly def?: number;
  /** `combat_armor` — flat armour. */
  readonly armour?: number;
  /** `combat_armor_hardiness` — ADDED to the base 30 (Combat.lua:1336). */
  readonly armourHardiness?: number;
  /** `combat_apr` — armour penetration. */
  readonly apr?: number;
  /** `combat_dam` — flat physical power. */
  readonly dam?: number;
  /** `combat_physcrit` — flat physical crit chance, in percentage points. */
  readonly physCrit?: number;
  /** `combat_generic_crit` — crit chance that applies to every school. */
  readonly genericCrit?: number;
  /** `combat_critical_power` — crit MULTIPLIER bonus, in percent (Combat.lua:1951). */
  readonly criticalPower?: number;
  /** `combat_physspeed`. A DIVISOR: higher is faster. See `combatSpeed`. */
  readonly physSpeed?: number;
  /** `combat_damrange` — added to the weapon's damage-range factor. */
  readonly damRange?: number;
  /** `combat_spellpower`. */
  readonly spellPower?: number;
  /** `combat_mindpower`. */
  readonly mindPower?: number;
  /** `combat_generic_power` — added to all three powers (Combat.lua:1693, 1748, 2060). */
  readonly genericPower?: number;
  /** `combat_physresist` — the flat part of the PHYSICAL save. */
  readonly physResist?: number;
  /** `combat_spellresist` — the flat part of the SPELL save. */
  readonly spellResist?: number;
  /** `combat_mentalresist` — the flat part of the MENTAL save. */
  readonly mentalResist?: number;
};

/**
 * A weapon's `combat` table — the subset MVP uses.
 *
 * Absent entirely for an unarmed actor, in which case ToME falls back to
 * `self.combat` (Combat.lua:1341, 1403, 1416, 1431). The `?? 1` defaults below
 * reproduce that fallback's own defaults.
 */
export type Weapon = {
  /** `dam` — the weapon's own damage rating, before stats (Combat.lua:1684). */
  readonly dam?: number;
  /** `atk` — accuracy granted by the weapon. */
  readonly atk?: number;
  /** `apr` — armour penetration granted by the weapon. */
  readonly apr?: number;
  /** `physcrit` — crit chance granted. DEFAULTS TO 1, not 0 (Combat.lua:1424). */
  readonly physCrit?: number;
  /** `physspeed` — the NUMERATOR of the speed division (Combat.lua:1411). */
  readonly physSpeed?: number;
  /** `damrange` — the damage spread. DEFAULTS TO 1.1 (Combat.lua:1432). */
  readonly damRange?: number;
  /**
   * `dammod` — how primaries convert into weapon damage. ToME's default is
   * `{ str = 0.6 }` (Combat.lua:1625); a bow is `{ dex = 0.7, str = 0.5 }`.
   */
  readonly damMod?: PrimaryStats;
};

/**
 * The multiplicative debuffs that live INSIDE the getters.
 *
 * Both land at M4 with the status system. They are wired now because their
 * PLACEMENT — before the rescale — is the part that is easy to get wrong and
 * impossible to notice, and because a flag defaulting to false costs nothing.
 */
export type StatusFlags = {
  /** Halves accuracy, defence, all three powers and all three saves. */
  readonly dazed?: boolean;
  /** Divides the same set by 1.2 (Combat.lua:1359, 1724, 1766, 2079). */
  readonly scoured?: boolean;
  /** `EFF_BREACH` — halves armour hardiness AFTER the bound (Combat.lua:1334). */
  readonly breached?: boolean;
  /**
   * Stunned. Read by NO getter in this file — it is a flat ×0.4 applied to
   * outgoing damage inside the projector (damage_types.lua:150-153).
   *
   * It lives on the same flags object anyway so that a status system has one
   * place to write, and so nobody adds a `stunned` halving to `combatAttack` by
   * analogy with Dazed. Stun's real teeth are elsewhere: Actor.lua:606 skips
   * `cooldownTalents()` while it is set, so a stunned actor's cooldowns FREEZE.
   */
  readonly stunned?: boolean;
};

/**
 * A combat sheet. Everything the formulas in this file need and nothing else.
 *
 * Deliberately NOT `EngineActor`: a character-sheet preview, a test vector and a
 * monster template are all valid inputs, and none of them has an energy clock.
 * M4's content loader hangs one of these off each actor.
 */
export type Combatant = {
  readonly stats?: PrimaryStats;
  readonly mods?: CombatMods;
  readonly weapon?: Weapon;
  readonly flags?: StatusFlags;
};

// ---------------------------------------------------------------------------
// Stat access
// ---------------------------------------------------------------------------

/** One primary, defaulted to ToME's own starting value. */
export function stat(c: Combatant, which: keyof PrimaryStats): number {
  const stats = c.stats;
  const base = which === 'lck' ? LUCK_BASE : STAT_BASE;
  if (stats === undefined) return base;
  return stats[which] ?? base;
}

/** `(Lck − 50)`. Zero while Luck stays pinned — see the file header. */
function luckDelta(c: Combatant): number {
  return stat(c, 'lck') - LUCK_BASE;
}

/**
 * Steps 2 and 3 of every getter, in the one place: debuffs, then the rescale.
 *
 * Every caller that skips this is a caller that will eventually rescale in the
 * wrong order. There is no second copy of these two lines in this file.
 */
function finish(c: Combatant, raw: number): number {
  let d = raw;
  if (c.flags?.dazed === true) d = d / 2;
  if (c.flags?.scoured === true) d = d / 1.2;
  return rescaleCombatStats(d);
}

// ---------------------------------------------------------------------------
// Offence
// ---------------------------------------------------------------------------

/**
 * ACCURACY — Combat.lua:1340-1361.
 *
 * ```lua
 * local atk = 4 + self.combat_atk + talent + (weapon.atk or 0)
 *           + (ammo and ammo.atk or 0) + (self:getLck() - 50) * 0.4   -- :1343
 * local d = self:combatAttackBase(weapon, ammo) + (self:getDex(100, true) - 10)
 * if self:attr("dazed") then d = d / 2 end
 * return self:rescaleCombatStats(d)
 * ```
 *
 * The bare `4` at :1343 is a real constant, not a placeholder: it is what makes
 * an unarmed level-1 character with 10 Dex sit slightly above parity rather than
 * exactly at it.
 *
 * NOT PORTED: the `T_WEAPON_COMBAT` mastery term (:1342), `hit_penalty_2h`
 * (:1347), and the psi/willpower attack substitutions (:1353-1354). All three
 * are talent systems M3 does not have. Each is one `+` when it lands.
 */
export function combatAttack(c: Combatant): number {
  const m = c.mods;
  const raw = 4 + (m?.atk ?? 0) + (c.weapon?.atk ?? 0) + luckDelta(c) * 0.4 + (stat(c, 'dex') - 10);
  return finish(c, raw);
}

/**
 * DEFENCE — Combat.lua:1216-1263.
 *
 * ```lua
 * local d = math.max(0, self.combat_def + (self:getDex() - 10) * 0.35
 *                                       + (self:getLck() - 50) * 0.4)   -- :1245
 * return math.max(0, d * mult + add)                                    -- :1253
 * ... local d = math.max(0, base_defense + (add or 0))                  -- :1260
 * if self:attr("dazed") then d = d / 2 end                              -- :1261
 * return self:rescaleCombatStats(d)                                     -- :1262
 * ```
 *
 * Note the DOUBLE floor at zero (:1245 and :1253) around the multiplier, and the
 * comment at :1253 explaining why the additive bonuses land last: talent
 * multipliers must not compound with each other. With no talents in M3 the two
 * floors collapse into one, and they are both written out anyway so the shape is
 * still recognisable when Iron Curtain adds a `mult` at M3.
 *
 * Dex contributes at 0.35 here against 1.0 for accuracy — defence is the
 * expensive side of the trade, on purpose.
 */
export function combatDefense(c: Combatant, add = 0): number {
  const base = Math.max(0, (c.mods?.def ?? 0) + (stat(c, 'dex') - 10) * 0.35 + luckDelta(c) * 0.4);
  return finish(c, Math.max(0, base + add));
}

/**
 * ARMOUR — Combat.lua:1275-1303. `self.combat_armor + add`.
 *
 * DELIBERATELY NOT RESCALED. Armour is subtracted from damage in the same units
 * damage is measured in (Combat.lua:541), so putting it on the accuracy curve
 * would be a category error. The only file in this directory whose getter does
 * not end in `rescale`, and the reason is worth remembering.
 */
export function combatArmor(c: Combatant, add = 0): number {
  return (c.mods?.armour ?? 0) + add;
}

/**
 * ARMOUR HARDINESS — Combat.lua:1307-1337. **BASE 30.**
 *
 * ```lua
 * return util.bound(30 + self.combat_armor_hardiness + add, 0, 100) * multi
 * ```
 *
 * The percentage of an incoming blow that armour is allowed to bite into. The
 * base 30 is the single most consequential constant in ToME's defensive maths:
 * because 70% of every hit bypasses armour by default, heavy armour flattens
 * chip damage and never trivialises a big one. Start it at 100 (the intuitive
 * `dam − armour`) and low-level tanks become unkillable.
 *
 * `multi` is 0.5 under `EFF_BREACH` (:1334) and applies AFTER the bound, so a
 * breached actor can sit below the 0-100 band's floor logic entirely.
 */
export function combatArmorHardiness(c: Combatant, add = 0): number {
  const multi = c.flags?.breached === true ? 0.5 : 1;
  return bound(30 + (c.mods?.armourHardiness ?? 0) + add, 0, 100) * multi;
}

/** ARMOUR PENETRATION — Combat.lua:1402-1406. `combat_apr + (weapon.apr or 0)`. */
export function combatAPR(c: Combatant): number {
  return (c.mods?.apr ?? 0) + (c.weapon?.apr ?? 0);
}

/**
 * ATTACK SPEED — Combat.lua:1409-1412.
 *
 * ```lua
 * return (weapon.physspeed or 1) / math.max(self.combat_physspeed + (add or 0), 0.1)
 * ```
 *
 * ═══ THIS RETURNS A COST MULTIPLIER, NOT A RATE ═══
 * `combat_physspeed` is a DIVISOR. Higher `combat_physspeed` → smaller result →
 * the attack costs less energy → the actor is FASTER. Invert this by accident
 * and every haste item in the game becomes a slow item, with no crash, no
 * failing test, and a symptom ("combat feels bad") that takes weeks to trace.
 *
 * The `0.1` floor stops a stacked debuff from producing a division by zero.
 */
export function combatSpeed(c: Combatant, add = 0): number {
  return (c.weapon?.physSpeed ?? 1) / Math.max((c.mods?.physSpeed ?? 1) + add, 0.1);
}

/**
 * PHYSICAL CRIT CHANCE — Combat.lua:1415-1427.
 *
 * ```lua
 * local crit = self.combat_physcrit + (self.combat_generic_crit or 0)
 *            + (self:getCun() - 10) * 0.3 + (self:getLck() - 50) * 0.30
 *            + (weapon.physcrit or 1) + addcrit
 * return math.max(crit, 0)
 * ```
 *
 * `(weapon.physcrit or 1)` — an actor with no weapon gets **+1**, not +0. Small
 * and easy to drop; it is the floor that keeps every attack in the game capable
 * of critting.
 *
 * NOT clamped to 100 here (:1426 says so explicitly — "crit > 100% may be offset
 * by crit reduction elsewhere"). The clamp happens at the roll, in damage.ts.
 */
export function combatCrit(c: Combatant, addCrit = 0): number {
  const m = c.mods;
  const crit =
    (m?.physCrit ?? 0) +
    (m?.genericCrit ?? 0) +
    (stat(c, 'cun') - 10) * 0.3 +
    luckDelta(c) * 0.3 +
    (c.weapon?.physCrit ?? 1) +
    addCrit;
  return Math.max(crit, 0);
}

/** Base crit multiplier — Combat.lua:1950-1951, `1.5 + crit_power_add + ...`. */
export const CRIT_BASE_POWER = 1.5;

/**
 * CRIT MULTIPLIER — Combat.lua:1950-1951 (and identically :1979-1980, :2027-2028
 * for spell and mind, which is why one function serves all three).
 *
 * ```lua
 * dam = dam * (1.5 + crit_power_add + (self.combat_critical_power or 0) / 100)
 * ```
 *
 * `combat_critical_power` is in PERCENTAGE POINTS and divided by 100;
 * `crit_power_add` is already a fraction. Two units in one expression, exactly
 * as upstream — mixing them up turns a +20% crit-damage item into +2000%.
 */
export function combatCritPower(c: Combatant, critPowerAdd = 0): number {
  return CRIT_BASE_POWER + critPowerAdd + (c.mods?.criticalPower ?? 0) / 100;
}

/**
 * DAMAGE RANGE — Combat.lua:1430-1433.
 *
 * ```lua
 * return (self.combat_damrange or 0) + (weapon.damrange or (1.1 - (add or 0))) + (add or 0)
 * ```
 *
 * The high end of the roll, as a multiple of base damage: 1.1 by default, so an
 * unmodified swing rolls uniformly across `[dam, dam × 1.1]`. Note the odd
 * `(1.1 - add) + add` shape — `add` cancels out for a weaponless actor and does
 * not for an armed one. Reproduced rather than simplified; the asymmetry is
 * upstream's and a talent that passes `add` depends on it.
 */
export function combatDamageRange(c: Combatant, add = 0): number {
  const weaponRange = c.weapon?.damRange ?? 1.1 - add;
  return (c.mods?.damRange ?? 0) + weaponRange + add;
}

// ---------------------------------------------------------------------------
// The three powers
// ---------------------------------------------------------------------------

/**
 * PHYSICAL POWER — Combat.lua:1689-1733.
 *
 * ```lua
 * local d = math.max(0, (self.combat_dam or 0) + add + str)   -- :1722
 * if self:attr("dazed") then d = d / 2 end
 * if self:attr("scoured") then d = d / 1.2 end
 * return self:rescaleCombatStats(d) * mod                     -- :1731
 * ```
 *
 * The comment at :1722 is the reason for the `max(0, ...)`: it "allows strong
 * debuffs to offset strength", i.e. the floor is applied to the SUM, so a −30
 * debuff can cancel 30 Strength but never drive the total negative.
 *
 * `mod` multiplies AFTER the rescale (:1731) while `add` goes in before it. Two
 * knobs, two sides of the curve, and swapping them is silent.
 */
export function combatPhysicalpower(
  c: Combatant,
  opts: { mod?: number; add?: number } = {},
): number {
  const mod = opts.mod ?? 1;
  const add = (opts.add ?? 0) + (c.mods?.genericPower ?? 0);
  const raw = Math.max(0, (c.mods?.dam ?? 0) + add + stat(c, 'str'));
  return finish(c, raw) * mod;
}

/** SPELL POWER — Combat.lua:1744-1771. Same shape, Magic instead of Strength. */
export function combatSpellpower(c: Combatant, opts: { mod?: number; add?: number } = {}): number {
  const mod = opts.mod ?? 1;
  const add = (opts.add ?? 0) + (c.mods?.genericPower ?? 0);
  const raw = Math.max(0, (c.mods?.spellPower ?? 0) + add + stat(c, 'mag'));
  return finish(c, raw) * mod;
}

/**
 * MIND POWER — Combat.lua:2056-2084.
 *
 * ```lua
 * local d = math.max(0, (self.combat_mindpower or 0) + add
 *                     + self:getWil() * 0.7 + self:getCun() * 0.4)   -- :2076
 * ```
 *
 * The only power fed by TWO stats, and neither at full weight. 0.7 Wil + 0.4 Cun
 * sums above 1.0, so a mind caster who splits stats beats one who does not — the
 * opposite of the physical/spell single-stat pattern, and intentional.
 */
export function combatMindpower(c: Combatant, opts: { mod?: number; add?: number } = {}): number {
  const mod = opts.mod ?? 1;
  const add = (opts.add ?? 0) + (c.mods?.genericPower ?? 0);
  const raw = Math.max(
    0,
    (c.mods?.mindPower ?? 0) + add + stat(c, 'wil') * 0.7 + stat(c, 'cun') * 0.4,
  );
  return finish(c, raw) * mod;
}

// ---------------------------------------------------------------------------
// The three saves
// ---------------------------------------------------------------------------

/**
 * All three saves share one shape — Combat.lua:2135, 2165, 2196:
 *
 * ```lua
 * local d = self.combat_<x>resist + (statA + statB + (self:getLck() - 50) * 0.5) * 0.35 + add
 * if self:attr("dazed") then d = d / 2 end
 * return self:rescaleCombatStats(d)
 * ```
 *
 * The 0.35 weight is what keeps saves from running away: two 100-point stats buy
 * 70 rescaled-input points, which the tier curve then compresses to about 40 —
 * enough to matter, never enough to be immune. `checkHitOld` does the rest.
 *
 * WHICH SAVE RESISTS AN EFFECT IS DECIDED BY THE EFFECT'S TYPE, NOT BY THE
 * ATTACK THAT DELIVERED IT (Actor.lua:6981-6985). A physical stun from a spell
 * is resisted by the PHYSICAL save. Getting that backwards makes every
 * cross-school build feel arbitrary.
 */
function save(c: Combatant, flat: number, statA: number, statB: number, add: number): number {
  return finish(c, flat + (statA + statB + luckDelta(c) * 0.5) * 0.35 + add);
}

/** PHYSICAL SAVE — Combat.lua:2122-2148. Constitution + Strength. */
export function combatPhysicalResist(c: Combatant, add = 0): number {
  return save(c, c.mods?.physResist ?? 0, stat(c, 'con'), stat(c, 'str'), add);
}

/** SPELL SAVE — Combat.lua:2152-2176. Magic + Willpower. */
export function combatSpellResist(c: Combatant, add = 0): number {
  return save(c, c.mods?.spellResist ?? 0, stat(c, 'mag'), stat(c, 'wil'), add);
}

/** MENTAL SAVE — Combat.lua:2180-2204. Cunning + Willpower. */
export function combatMentalResist(c: Combatant, add = 0): number {
  return save(c, c.mods?.mentalResist ?? 0, stat(c, 'cun'), stat(c, 'wil'), add);
}

// ---------------------------------------------------------------------------
// Weapon damage
// ---------------------------------------------------------------------------

/** ToME's default `dammod` when a weapon declares none — Combat.lua:1625. */
const DEFAULT_DAMMOD: PrimaryStats = { str: 0.6 };

/**
 * The primaries, in a fixed order.
 *
 * A literal list rather than `Object.keys` over the `dammod` table: key order on
 * a content-loaded object is whatever the JSON author typed, and while addition
 * commutes, anything later derived from this iteration (a log line, a draw)
 * would inherit that instability. Fixed here, once.
 */
const STAT_KEYS = ['str', 'dex', 'con', 'mag', 'wil', 'cun', 'lck'] as const;

/**
 * The 'power' half of weapon damage — Combat.lua:1682-1687.
 *
 * ```lua
 * local power = math.max((weapon_combat.dam or 1) + (add or 0), 1)
 * return (math.sqrt(power / 10) - 1) * 0.5 + 1
 * ```
 *
 * A square root, so doubling a weapon's rating is worth far less than doubling
 * it: the term is 1.0 at rating 10 and only ~1.29 at rating 40. This is what
 * stops a big weapon from being strictly better than a build.
 */
export function combatDamagePower(c: Combatant, add = 0): number {
  const power = Math.max((c.weapon?.dam ?? 1) + add, 1);
  return (Math.sqrt(power / 10) - 1) * 0.5 + 1;
}

/**
 * BASE WEAPON DAMAGE — Combat.lua:1661-1679.
 *
 * ```lua
 * local dammod = self:getDammod(damage or weapon)      -- default { str = 0.6 }
 * for stat, mod in pairs(dammod) do totstat = totstat + self:getStat(stat) * mod end
 * local power = self:combatDamagePower(damage or weapon, totstat)
 * local phys  = self:combatPhysicalpower(nil, weapon, totstat)
 * return 0.3 * phys * power * talented_mod
 * ```
 *
 * ═══ `totstat` IS FED IN TWICE, ON PURPOSE ═══
 * It goes into `combatDamagePower` as `add` (raising the weapon's effective
 * rating) AND into `combatPhysicalpower` as `add` (raising the power before its
 * rescale). That double count is why stats feel strong on weapon attacks and it
 * is not a bug in the original. Consequently `combatPhysicalpower(c)` called
 * bare returns a DIFFERENT number from the one used inside this function — both
 * are correct, for different questions.
 *
 * NOT PORTED: `combatTrainingPercentInc` and its `+30` correction (:1674-1675).
 * That is weapon-mastery, which is a talent tree, which is M6. When it lands it
 * is two lines here and a `talented_mod` on the return.
 *
 * The result is a FLOAT and stays one all the way to `takeHit`. ToME never
 * rounds damage (ActorLife.lua:69-77 subtracts the raw value); rounding early
 * compounds through the armour and resist stages.
 */
export function combatDamage(c: Combatant, addDamMod?: PrimaryStats): number {
  const damMod = c.weapon?.damMod ?? DEFAULT_DAMMOD;

  let totstat = 0;
  for (const key of STAT_KEYS) {
    const mod = damMod[key];
    if (mod !== undefined) totstat += stat(c, key) * mod;
    const extra = addDamMod?.[key];
    if (extra !== undefined) totstat += stat(c, key) * extra;
  }

  const power = combatDamagePower(c, totstat);
  const phys = combatPhysicalpower(c, { add: totstat });
  return 0.3 * phys * power;
}
