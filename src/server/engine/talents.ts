// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/engines/default/engine/interface/ActorTalents.lua:819-822 (getTalentLevelRaw)
//                                                                          826-834 (getTalentLevel, with mastery)
//                                                                          1002-1013 (cooldownTalents)
//             t-engine4 game/modules/tome/class/Actor.lua:476-609 (actBase), :606 (the stun guard)
//             t-engine4 game/modules/tome/class/interface/Combat.lua:1774-1779 (combatTalentSpellDamage)
//             t-engine4 game/modules/tome/data/talents/gifts/summon-utility.lua:21-40 (Taunt)
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" — https://te4.org/license

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *                            THE TALENT SYSTEM
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Twelve talents, four per class, each a hand-written TypeScript file under
 * src/server/talents/. This module is everything those twelve files share: the
 * `Talent` shape, the registry, the resource pools, the cooldown bookkeeping and
 * the ONE entry point (`useTalent`) that enforces the refund rule.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * THERE IS NO TALENT SCRIPTING LANGUAGE, AND THAT IS THE DESIGN
 * ───────────────────────────────────────────────────────────────────────────
 * docs/tome-mechanics.md § 9 measured it: 1,209 `newTalent{}` blocks in the
 * reference clone, **814 of them (67%) carrying a bespoke `action = function`**.
 * A JSON op-interpreter that could run those would BE a scripting language — a
 * compiler project wearing a content-pipeline costume, whose cost lands in the
 * worst possible way because writing schema *feels* like progress while
 * producing zero playable talents.
 *
 * So: one plain function per talent, ~40 lines, numbers copied from the Lua and
 * from the authored Outer Index JSON. Every talent file cites its sources on its
 * first lines. That citation is a licence obligation AND the only way anyone
 * (including you, in six months) can tell a tuned number from a guessed one.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * COOLDOWNS TICK ON THE **BASE** CLOCK. THIS IS THE #1 PORT MISTAKE.
 * ───────────────────────────────────────────────────────────────────────────
 * `energyBase` accrues a flat ENERGY_PER_TICK and is NEVER multiplied by
 * anything, so `actBase` fires exactly once per game turn at any speed
 * (Actor.lua:476-609). Cooldowns live there — `tickCooldowns` in
 * engine/actor.ts, called from `actBase`, ported from
 * ActorTalents.lua:1002-1013 — and therefore a hasted actor gets more ACTIONS
 * and never a faster cooldown.
 *
 * Get this wrong and haste becomes a way to cheat cooldowns, the tactical layer
 * collapses, and it is invisible in play until balance mysteriously feels bad.
 * The M2 test that pins it: globalSpeed 1.4 → 14 actions across 10 game turns
 * while cooldowns tick exactly 10 times.
 *
 * This module does NOT re-implement that tick. It calls `setCooldown` and
 * `cooldownOf` from engine/actor.ts, so there is exactly one cooldown store in
 * the process (`actor.cooldowns`) and exactly one thing that decrements it.
 * What this module DOES own — the resource regen and the two talent-owned
 * durations below — is likewise driven from `talentActBase`, on the same clock,
 * for the same reason.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * THE REFUND RULE (docs/architecture.md § 2, engine/actor.ts's Intent doc)
 * ───────────────────────────────────────────────────────────────────────────
 * "An intent that goes illegal between submission and resolution costs ZERO and
 * re-prompts." `useTalent` honours it structurally, not by discipline:
 *
 *   1. `canUseTalent` — a PURE predicate. Mutates nothing.
 *   2. `onUse` — may still refuse (no free tile to be shoved into, the ally
 *      died between the check and now). A refusal here also costs nothing.
 *   3. ONLY on success: spend AP, spend MP, spend the resource, set the
 *      cooldown. Four mutations, one place, after the last thing that can fail.
 *
 * That ordering is why a player never hesitates: pressing a button that turns
 * out to be illegal is free. Spend first and refund later and you have two code
 * paths that must agree about what was spent — which is the same bug class as a
 * second copy of a combat formula.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * TALENT POINTS ARE HERE NOW. TREES AND MASTERY ARE NOT, AND WILL NOT BE.
 * ───────────────────────────────────────────────────────────────────────────
 * The cap this docblock used to describe ("0 trees / 0 points / fixed
 * loadouts") is LIFTED. `TalentSheet.points` holds one RAW point count per
 * talent, 1..5, seeded at 1 for every loadout id, and `useTalent` computes
 * `ctx.talentLevel` once and hands it to the body. All twelve talents walk a
 * `combatTalentScale(level, low, high)` curve whose `low` is EXACTLY the number
 * they shipped with, so nothing was re-based when the levels landed and every
 * `NUMBERS:` citation in src/server/talents/ is still true verbatim at level 1.
 *
 * What is still deliberately absent, with the reason each:
 *
 *  - TREES. `Talent` has no category, no tier and no prerequisite field, and
 *    `ClassDef.loadout` is exactly four talents enforced at import time. A
 *    "tree" here would be one category holding four nodes with no edges — a
 *    list wearing chrome. DECISIONS.md (d) settles it; ToME itself ships the
 *    degenerate case (LevelupDialog.lua:737-755 builds a one-node
 *    `TalentTrees` with `no_cross = true` for the stat column).
 *  - MASTERY. ActorTalents.lua:824-834 multiplies raw points by a per-class,
 *    per-TREE mastery so that a Berserker's 2h tree outranks an Arcane Blade's.
 *    We have four talents per class and no shared trees, so there is nothing to
 *    differentiate. Dropping it is what makes effective level == raw level,
 *    1..5 — see `getTalentLevelRaw`.
 *  - LEVEL, XP AND UNSPENT POINTS. Those live on `PlayerActor`, not here. The
 *    save layer cannot reach the talent engine (`PlayerActor.classId`'s own
 *    docblock, engine/actor.ts, makes exactly that argument for exactly that
 *    reason), so the sheet owns RAW POINTS ONLY and the actor owns the ledger.
 *    Two owners for one number is how they disagree.
 *  - SUSTAINS. `mode: 'sustained'` needs cooldown-on-DEACTIVATE
 *    (docs/tome-mechanics.md § 9) and a passive-value stack. None of the twelve
 *    is a sustain.
 *  - ENERGY. DECISIONS.md § D1: a player action costs exactly ENERGY_TO_ACT and
 *    the scheduler's `spendTurn` is the only spender. AP is the intra-turn
 *    budget; a talent spends AP and never energy. A second energy spender is
 *    exactly how a party falls out of phase lock.
 *  - EVENTS. `useTalent` returns a value. The scheduler turns values into
 *    `GameEvent`s, because only the scheduler knows whether this was a player
 *    action or part of a batched monster sweep.
 *
 * SYNCHRONOUS AND SEEDED. src/server/engine/** and src/server/talents/** both
 * carry the six anti-async AST selectors and the `Math.random`/`Date.now` bans.
 * Every draw goes through the `Rng` the caller passes, with a label.
 */

import type { PassiveContribution } from './equipment.ts';
import { DIR_ORDER, DIR_VECTORS, chebyshev } from '../../shared/coords.ts';
import { ENERGY_TO_ACT } from '../../shared/version.ts';
import { bound, rescaleDamage } from '../../shared/scale.ts';
import { hasLineOfSight } from '../world/world.ts';
import { Faction, areEnemies, cooldownOf, setCooldown } from './actor.ts';
import type { Sided } from './actor.ts';
import { attackTarget, combatDistance } from './combat.ts';
import { DamageType, applyDamage } from './damage.ts';
import { combatDamage } from './derived.ts';
import type { Dir, TileXY } from '../../shared/coords.ts';
import type { ActorKind, LevelView } from '../../shared/protocol.ts';
import type { Rng } from '../../shared/rng.ts';
import type { StatusApply } from './effects.ts';
import type { World } from '../world/world.ts';
import type { CombatSheet } from './combat.ts';

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/**
 * The three MVP classes (game-design.md § 2). Enforcer, Cipher-Clerk and the
 * Voidling are explicitly deferred.
 *
 * `as const` object plus a derived union rather than an `enum`, because
 * `erasableSyntaxOnly` is on and Node type-strips this file to run it.
 */
export const ClassId = {
  Watchman: 'watchman',
  Inspector: 'inspector',
  Alchemist: 'alchemist',
} as const;
export type ClassId = (typeof ClassId)[keyof typeof ClassId];

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT PRESSING A TALENT DOES, OR THAT YOU CANNOT PRESS IT.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ToME's three, verbatim in meaning (`ActorTalents.lua` — `mode = "activated"`,
 * `"sustained"`, `"passive"`). Every talent this game has ever had is `Active`,
 * which is why the field did not exist: a set of one needs no name.
 *
 * IT IS ON THE WIRE because the hotbar and the talent panel both have to draw
 * the difference — a passive with a keybind is a key that does nothing, and a
 * sustained that does not show whether it is ON is the one state the player
 * needs. `LoadoutTalent.kind` is optional and additive, so no protocol bump.
 */
export const TalentKind = {
  /** Costs its resources and resolves now. Everything shipped so far. */
  Active: 'active',
  /**
   * Toggled. Pays once, stays on, and reserves something until it is toggled
   * off. Nothing implements this yet — the value is declared so the panel can
   * be built once rather than twice.
   */
  Sustained: 'sustained',
  /** Never pressed. True for as long as there is a point in it. */
  Passive: 'passive',
} as const;
export type TalentKind = (typeof TalentKind)[keyof typeof TalentKind];

/**
 * The three class resources, and the one that is COUNTED rather than measured.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ALL THREE TRICKLE. REAGENTS TRICKLE IN WHOLE VIALS, AND THAT IS THE WHOLE
 * DISTINCTION.
 * ═══════════════════════════════════════════════════════════════════════════
 * This block used to say "not a regenerating pool … nothing can quietly turn it
 * into a bar", and `RESOURCE_RULES` used to encode that as three zeroes. The
 * designer has now played the shipped build and reversed it: a resource you can
 * only earn by killing is a resource that leaves you standing in a corridor with
 * every button greyed out, which is not a decision, it is a dead class. W7's
 * DECISIONS.md entry records the reversal.
 *
 * What the reversal is careful NOT to do is make Reagents continuous:
 *
 *   RESOLVE, FOCUS — continuous, 0-100, `regenPerTurn` FRACTIONAL. Ported from
 *     ToME's `stamina_regen`/`psi_regen` defaults (Actor.lua:227-241), applied
 *     once per BASE turn by `regenResources` (ActorResource.lua:201-211) from
 *     `actBase` (Actor.lua:558). Standing next to people and holding still are
 *     still where the real income is; the trickle is the floor under them.
 *
 *   REAGENTS — COUNTABLE, 0-8. Refilled one per kill, topped up at stairs, and
 *     ONE WHOLE VIAL every `regenEvery` game turns via an integer counter that
 *     lives beside the pool rather than inside it (`ResourcePool.regenCounter`,
 *     a verbatim port of `regenAmmo`, Actor.lua:2074-2084). `pool.value` is
 *     therefore an INTEGER at every observable moment — a stronger guarantee
 *     than the zero it replaced, because a zero can be edited to 0.5 by anyone
 *     while an integer counter cannot express a fraction at all.
 *
 * Upstream already ships exactly this shape and it is why the reconciliation is
 * a port rather than a capitulation: Souls is an explicit min-0/max-10 countable
 * stock (resources.lua:266) earned one per kill, and two shipped NPCs set
 * `soul_regen = 1` (dreadfell/npcs.lua:71). "Nothing regenerates by default"
 * (data/birth/descriptors.lua:71 sets base `mana_regen = 0`) and "this class's
 * stock trickles" are both true statements about ToME.
 *
 * The UI does not change: pips, never a bar (docs/assets-needed.md,
 * `ui_pip_reagent_{full,empty}`). A slow refill expressed in whole pips still
 * answers "how many casts do I have left?", which is the only question the
 * Alchemist's player is ever asking.
 */
export const ResourceKind = {
  /** Watchman. Builds when struck, next to an ally, and slowly on its own. */
  Resolve: 'resolve',
  /** Inspector. Builds by holding still, by watching a mark, and slowly on its own. */
  Focus: 'focus',
  /** Alchemist. COUNTABLE. Refills on kills, at stairs, and one whole vial per `regenEvery`. */
  Reagents: 'reagents',
} as const;
export type ResourceKind = (typeof ResourceKind)[keyof typeof ResourceKind];

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * EVERY TALENT ID IS NAMESPACED `talent:<id>`. THIS IS MANDATORY, NOT STYLISTIC.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * docs/data-schemas.md § 5 rule **R6**: *"NAMESPACE: skills/ -> talent:<id>,
 * abilities/ -> ability:<id>. MANDATORY."* Six ids exist in BOTH source
 * directories with incompatible schemas — `alchemic_vial`, `arc_chain`,
 * `backdraft`, `basic_attack`, `corruption_pulse`, `void_rend` — and a naive
 * merge produces one dictionary where the second load clobbers the first.
 *
 * It is applied HERE, at the registry key, rather than at the wire boundary,
 * because `actor.cooldowns` is keyed by talent id and `projectCooldowns`
 * (view/projector.ts) sends those keys VERBATIM for the client to match against
 * `LoadoutTalent.id`. Namespacing at the edge instead would mean the cooldown
 * wipe silently never matched a button — a bug that looks like "cooldowns don't
 * work" and is actually a string mismatch two modules away.
 */
export const TALENT_ID_PREFIX = 'talent:';

/** `crude_blow` -> `talent:crude_blow`. The one place the prefix is written. */
export function talentId(bare: string): string {
  return `${TALENT_ID_PREFIX}${bare}`;
}

/** `talent:crude_blow` -> `crude_blow`. For a log line or an asset lookup. */
export function bareTalentId(id: string): string {
  return id.startsWith(TALENT_ID_PREFIX) ? id.slice(TALENT_ID_PREFIX.length) : id;
}

/**
 * A multiplier as the percentage a player reads on a tooltip.
 *
 * Exists so the twelve talent files do not each carry a bare `* 100` — which
 * `no-magic-numbers` flags in src/server/talents/** on purpose, because that
 * rule is there to push tunable numbers into named constants and a formatting
 * factor is not a tunable number.
 */
export function percent(fraction: number): string {
  const PER_CENT = 100;
  return `${Math.round(fraction * PER_CENT)}%`;
}

/** Targeting shapes. `target_shape` in content/skills/*.json, mapped by R8. */
export const TargetShape = {
  /** No target picked; the caster is the origin. */
  Self: 'self',
  /** One actor. */
  Single: 'single',
  /** A tile plus its four orthogonal neighbours — Alchemic Vial. */
  Cross: 'cross',
  /** Every actor within `radius` of the origin, Euclidean. */
  Ball: 'ball',
  /** A free tile to stand on. Fog Step. */
  Tile: 'tile',
} as const;
export type TargetShape = (typeof TargetShape)[keyof typeof TargetShape];

/** Who a shape is allowed to land on. Player AoE never damages allies (§ 10). */
export const Affinity = {
  Hostile: 'hostile',
  Ally: 'ally',
  Any: 'any',
} as const;
export type Affinity = (typeof Affinity)[keyof typeof Affinity];

// ---------------------------------------------------------------------------
// Cooldowns — TURNS, and the two conversions that get you there
// ---------------------------------------------------------------------------

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * COOLDOWNS ARE IN GAME TURNS. NEITHER SOURCE OF NUMBERS IS ALREADY IN THEM.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * SOURCE 1 — Outer Index `content/abilities/*.json` carries `cooldown_sec`,
 * because that project is a real-time survivors-like. docs/data-schemas.md § 5
 * rule **R2** is the conversion, quoted verbatim:
 *
 *     R2  toTurns(sec) = max(1, round(sec))     cooldown_sec, duration_sec, …
 *                        cooldowns additionally clamped to [0,30]; 0 == at-will
 *
 * `secondsToTurns` below is that rule and the ONLY place the factor lives. Note
 * the `max(1, …)`: a 0.4 s real-time cooldown is a whole turn here, because
 * there is no such thing as a fraction of a turn. A source `0.0` means at-will
 * and stays 0 — that is what the "0 == at-will" clause is for, and it is why
 * this function special-cases non-positive input instead of letting `max(1, …)`
 * silently promote an at-will ability to a one-turn gate.
 *
 * SOURCE 2 — t-engine4 talents carry `cooldown = N` already in TURNS, but a
 * ToME turn holds exactly ONE action while an Inner Datum turn holds a 6-AP
 * budget (PLAN.md § 6: player actions cost a flat turn, AP is the intra-turn
 * budget). At ~3 AP per talent that is two talents per turn, so a verbatim
 * `cooldown = 6` would gate ~12 actions here where upstream gated 6.
 * `tomeCooldownToTurns` divides by `TOME_ACTIONS_PER_TURN` and ceilings, which
 * restores upstream's intent: "you get N other actions before this returns".
 *
 * Every one of the twelve names which source it used, in a comment, next to the
 * number. A cooldown with no provenance is a guess, and a guess is the thing
 * that makes a balance pass unfalsifiable.
 */
export const MAX_COOLDOWN_TURNS = 30;

/** R2 (docs/data-schemas.md § 5): `cooldown_sec` → turns. */
export function secondsToTurns(seconds: number): number {
  // "0 == at-will". Without this branch `max(1, …)` would promote every
  // at-will ability in the donor data to a one-turn gate.
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  return bound(Math.max(1, Math.round(seconds)), 0, MAX_COOLDOWN_TURNS);
}

/**
 * How many talent activations fit in one Inner Datum turn.
 *
 * 6 AP per round (game-design.md § 6, from `city_watchman.json`'s `max_ap: 6`)
 * against talents costing 2-5 AP. Two is the honest average and the number the
 * ToME cooldown conversion divides by.
 */
export const TOME_ACTIONS_PER_TURN = 2;

/** A t-engine4 `cooldown = N` (ToME turns = ToME actions) → Inner Datum turns. */
export function tomeCooldownToTurns(tomeCooldown: number): number {
  if (!Number.isFinite(tomeCooldown) || tomeCooldown <= 0) return 0;
  return bound(Math.ceil(tomeCooldown / TOME_ACTIONS_PER_TURN), 0, MAX_COOLDOWN_TURNS);
}

/**
 * The talent level a MONSTER's ability resolves at. Not a player's.
 *
 * ═══ IT WAS CALLED `MVP_TALENT_LEVEL` AND THE RENAME IS THE POINT ═══
 * Players now carry real per-talent points (`TalentSheet.points`), so "the
 * level everything resolves at" no longer exists as a concept. Monsters still
 * have no sheet and no points — src/server/content/monsters.ts derives an
 * orb's damage from `combatTalentSpellDamage(power, THIS, 15, 240)` — so the
 * constant survives, narrowed to the one population it is still true for. A
 * player level and a monster level sharing one symbol would mean the day
 * monsters gain ranks, raising theirs silently raises everybody's.
 *
 * The docblock this replaced also claimed that "every helper that takes a
 * talent level takes THIS". That was already false before points landed:
 * `grep -rn MVP_TALENT_LEVEL src/server/talents/` found nothing, because all
 * twelve had their curves collapsed to the `low` endpoint by hand. They are
 * un-collapsed now and read `ctx.talentLevel`, which is never this constant.
 */
export const MONSTER_TALENT_LEVEL = 1;

// ---------------------------------------------------------------------------
// Talent-level damage helpers
// ---------------------------------------------------------------------------

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE HELPER THE CITATIONS NAME IS NOT THE HELPER THE TWELVE CALL, ON PURPOSE.
 * ═══════════════════════════════════════════════════════════════════════════
 * Several of the twelve cite `combatTalentWeaponDamage` in their own headers
 * (sniper_mark.ts:5-8 quotes `combatTalentWeaponDamage(t, 1.7, 3.5)` straight
 * out of sniper.lua:260-289). Every one of them nevertheless calls
 * `combatTalentScale`, and the reason is arithmetic rather than preference:
 *
 *     combatTalentScale(1, low, high)          === low       EXACTLY
 *     combatTalentWeaponDamage(1, 1.65, 3.5)   === 2.4773…
 *
 * `combatTalentScale` is fitted with xLow = 1 (scale.ts:182-208), so level 1
 * returns the `low` endpoint to the bit. `combatTalentWeaponDamage` is
 * `base + (max-base)·sqrt(tl/5)`, which at tl = 1 is 45% of the way up the
 * curve already. Adopting the helper the citation names would have silently
 * re-based EVERY shipped number — Sniper's Mark off its authored 1.65, the
 * Watchman's swing off 1.0 — and broken the level-1 assertions in
 * test/server/talents.test.ts, which are the cheapest proof that the
 * un-collapse changed nothing.
 *
 * So: SHAPE and HIGH may come from the Lua; LOW is whatever the file already
 * shipped; and the helper is the one whose y(1) is that LOW. Each of the twelve
 * says which is which next to its own pair.
 */

/**
 * `combatTalentSpellDamage` — Combat.lua:1774-1779.
 *
 * ```lua
 * local mod = max / ((base + 100) * ((math.sqrt(5) - 1) * 0.8 + 1))
 * return self:rescaleDamage((base + spellpower) * ((math.sqrt(tl) - 1) * 0.8 + 1) * mod)
 * ```
 *
 * Ported as a pure function of numbers rather than a method on an actor, so the
 * caller supplies the power (`combatSpellpower`, `combatMindpower` — the mind
 * variant at :2087-2092 is the identical three lines with a different power).
 *
 * It is here rather than in src/shared/scale.ts because scale.ts is the SHARED
 * curve module and this one needs a derived stat that only the server computes.
 * Nothing in the twelve currently calls it — the Alchemist's damage runs
 * through `combatDamage` and a multiplier, exactly like everything else, so
 * there is ONE damage curve in the game (see `talentAttack`). It is exported
 * because the next caster talent will need it and re-deriving `mod` from the
 * Lua is a twenty-minute job that produces a subtly different number.
 */
export function combatTalentSpellDamage(
  power: number,
  talentLevel: number,
  base: number,
  max: number,
): number {
  const SQRT5_TERM = (Math.sqrt(5) - 1) * 0.8 + 1;
  const mod = max / ((base + 100) * SQRT5_TERM);
  const level = (Math.sqrt(Math.max(talentLevel, 0)) - 1) * 0.8 + 1;
  return rescaleDamage((base + power) * level * mod);
}

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------

/**
 * ToME's `stamina_regen` 0.3 (Actor.lua:230) x `TOME_ACTIONS_PER_TURN`.
 *
 * Named rather than inlined so a balance pass has one symbol to grep and the
 * tests can assert the DERIVATION rather than a copied decimal.
 */
export const RESOLVE_PER_TURN = 0.3 * TOME_ACTIONS_PER_TURN;

/** ToME's `psi_regen` 0.2 (Actor.lua:239) x `TOME_ACTIONS_PER_TURN`. */
export const FOCUS_PER_TURN = 0.2 * TOME_ACTIONS_PER_TURN;

/**
 * GAME TURNS PER ONE WHOLE REAGENT. The Alchemist's floor, and only her floor.
 *
 * ═══ WHERE 12 COMES FROM, AND WHY IT IS NOT 6 ═══
 * Upstream's mana regen is 0.5/turn (Actor.lua:229) and the cheapest attack
 * spell in the game costs `mana = 12` (data/talents/spells/fire.lua:26), so a
 * ToME caster buys one cast every 24 ToME turns. Divide by
 * `TOME_ACTIONS_PER_TURN` for our turn density and one 1-Reagent cast is 12 of
 * our turns.
 *
 * REJECTED: the 6 in `ammo_every = 6 - e.combat.ammo_regen`
 * (data/general/objects/egos/ammo.lua:227) — upstream's own cadence for exactly
 * this counter, and therefore the tempting number. At 6 a ~100-turn floor pays
 * ~16 vials against ~15 from kills, which makes the trickle EQUAL to the kill
 * economy and turns the Alchemist into a mana class after all. At 12 it pays
 * ~8, so bodies stay the income and this is the safety net that the dead
 * `noteStairs` was supposed to be.
 *
 * The ammo figure was NOT additionally halved: `ammo_every` is a reload cadence
 * rather than an action budget, and applying the density factor twice is how a
 * citation stops meaning anything.
 */
export const REAGENT_REGEN_EVERY_TURNS = 12;

/** Per-kind limits and regeneration. One table, so no pool can drift. */
export const RESOURCE_RULES: Readonly<
  Record<
    ResourceKind,
    {
      readonly max: number;
      readonly start: number;
      /**
       * UNCONDITIONAL gain per GAME TURN, on the base clock, before the
       * per-class clauses in `regenResource`.
       *
       * ═══ PORTED, WITH THE TURN-DENSITY FACTOR APPLIED EXACTLY ONCE ═══
       * ToME's per-turn defaults are authored at Actor.lua:227-241 —
       * `mana_regen = 0.5`, `stamina_regen = 0.3` ("Stamina regens slower than
       * mana"), `psi_regen = 0.2` ("Energy regens slowly") — and added by
       * `regenResources` (ActorResource.lua:201-211), which is ONE bounded add
       * and contains no rng anywhere in the file. Its clock is `actBase`
       * (Actor.lua:558), driven by `energyBase`, which GameEnergyBased.lua:114-121
       * grants FLAT while :125 multiplies the ACT clock by `global_speed`. A
       * hasted actor therefore gets more actions and exactly the same
       * regeneration — which is our energy.ts:621-629 invariant, and why
       * `regenResource` is reachable only from `TalentEngine.actBase`.
       *
       * A ToME turn holds ONE action; ours holds `TOME_ACTIONS_PER_TURN`. So a
       * per-turn ACCRUAL is MULTIPLIED by that factor to hold upstream's
       * actions-per-refill — the exact inverse of what `tomeCooldownToTurns`
       * does to a cooldown, and the reason both live next to the same constant.
       *
       *   RESOLVE 0.6 = stamina 0.3 x 2. Stamina is the physical-fatigue
       *     resource of a melee body; Resolve is the nearest thing we have.
       *   FOCUS 0.4 = psi 0.2 x 2. Psi is the mental one
       *     (data/birth/classes/psionic.lua:40 is the class-level value).
       *
       * BOTH ARE DELIBERATELY TINY NEXT TO THE EARNED CLAUSES: one blow taken
       * pays `RESOLVE_ON_STRUCK` (6), ten turns of trickle. Holding ground pays
       * `FOCUS_ON_HELD_GROUND` (12), thirty turns of trickle. That is ToME
       * parity and it is meant to be a floor, not a second income — if you can
       * WATCH it tick up, the rate is wrong.
       *
       * REAGENTS STAY 0 HERE and use `regenEvery` instead, because a fractional
       * add is precisely what would turn a counted stock into a bar.
       */
      readonly regenPerTurn: number;
      /**
       * WHOLE GAME TURNS PER ONE WHOLE UNIT. Omitted means "no timed refill".
       *
       * ONLY MEANINGFUL FOR A DISCRETE KIND. It is the mechanism that lets a
       * counted stock regenerate without the pool ever holding a fraction:
       * `regenResource` banks turns on `ResourcePool.regenCounter` and grants
       * exactly 1 when the counter reaches this number, which is `regenAmmo`'s
       * `ammo_every` / `reload_counter` pair verbatim (Actor.lua:2074-2084).
       *
       * A continuous kind must leave this undefined and use `regenPerTurn`.
       * Setting both would be two clocks feeding one pool, and the fractional
       * one would defeat the whole reason the integer one exists.
       */
      readonly regenEvery?: number;
      /**
       * Draw PIPS, not a bar — `ResourceView.discrete` on the wire.
       *
       * A bar makes 3-of-8 look like 37% of something continuous and quietly
       * deletes the Alchemist's whole read. Authored HERE rather than derived
       * from the kind in the renderer, because a client-side copy of "which
       * kinds are countable" is exactly the table that will be missing the
       * Enforcer's Shells at M5.
       *
       * This flag is NOT a statement that the pool never refills — it says the
       * pool is COUNTABLE, and `regenEvery` refills it in countable units.
       */
      readonly discrete: boolean;
    }
  >
> = {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * BORN FULL — ActorResource.lua:131, and it used to be born empty.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * ```lua
   * -- engines/default/engine/interface/ActorResource.lua:130-131
   * self[r.maxname]    = t[r.maxname] or r.max
   * self[r.short_name] = t[r.short_name] or (r.switch_direction and self[r.minname] or self[r.maxname])
   * ```
   *
   * An actor is created holding its resource at **`maxname`** unless the
   * resource is `switch_direction` — the flag Equilibrium carries because it
   * prefers its minimum. Stamina and Psi are not switch_direction, so a ToME
   * Bulwark is born with a full stamina bar and a Psionic with full Psi. Both
   * `start: 0`s here were a port deviation, and CLAUDE.md's rule is that when
   * the docs and the Lua disagree, the Lua wins.
   *
   * ═══ WHAT IT DID TO A FIRST SESSION, MEASURED ═══
   * A stranger picks the Watchman — the control class, the one whose whole
   * pitch is holding the choke — and gets a hotbar of four talents with two of
   * them greyed out. Lockdown costs 30 and Resolve accrues at 6 a blow taken
   * plus a 0.6 trickle, so it is FIVE TURNS OF BEING HIT EVERY TURN away. The
   * opening solo ambush is one 25-hp husk that dies in three swings:
   * `tools/status-live.mjs` walked it and reached **22 of the 30** as the husk
   * fell. So the class's signature button cannot be pressed in the fight that
   * introduces it. The Inspector is the same story at 35 for Sniper's Mark; the
   * Alchemist, whose stock is discrete and already started at 8 of 8, showed a
   * new player everything she had on turn one.
   *
   * ═══ THIS IS A BURST, NOT AN INCOME, AND THE ECONOMY IS UNCHANGED ═══
   * Nothing here refills these two pools. `noteStairs` tops up Reagents only,
   * and has no call site anyway (there are no stairs yet). So a full bar buys
   * exactly one opening play; the moment it is spent, the earned clauses —
   * struck, adjacent ally, held ground — are the only way back, which is the
   * economy game-design.md § 2 describes and this does not touch. The doc's own
   * framing gives it away: the trickle is "a floor under a SPENT Inspector",
   * and you cannot be spent if you never had any.
   *
   * NOT MEASURABLE BY THE EXISTING TOOLS, stated plainly: `first-fight.mjs` and
   * `delve-run.mjs` drive a bump-attacking body that presses no talents at all,
   * so neither can see this change. What can see it is a person, and
   * `tools/status-live.mjs`, which presses Lockdown over a real socket.
   */
  [ResourceKind.Resolve]: { max: 100, start: 100, regenPerTurn: RESOLVE_PER_TURN, discrete: false },
  [ResourceKind.Focus]: { max: 100, start: 100, regenPerTurn: FOCUS_PER_TURN, discrete: false },
  // 0-8, COUNTABLE. Starts full: you walked in carrying eight vials, and the
  // first fight should be about spending them rather than about waiting.
  [ResourceKind.Reagents]: {
    max: 8,
    start: 8,
    regenPerTurn: 0,
    regenEvery: REAGENT_REGEN_EVERY_TURNS,
    discrete: true,
  },
};

/**
 * Resolve builds when struck (game-design.md § 2).
 *
 * WIRING, NOW REAL: `TalentEngine.noteStruck` is the entry point, the scheduler
 * calls it through `TalentResolution.noteStruck` from `noteBlows` — the one
 * place a landed blow is recognised — and `talentRuntimeFor` (server/main.ts)
 * is the adapter in between. It used to say "the scheduler calls
 * `gainResolveOnStruck`" and NOTHING CALLED ANYTHING: the function did not
 * exist, so a Watchman's only income was the adjacency clause below, and a solo
 * Watchman sat at 0 Resolve forever with Iron Curtain (25) and Lockdown (30)
 * permanently unaffordable. That is half a class's buttons, greyed out for the
 * whole session, with nothing failing anywhere.
 *
 * The adjacency clause is still the co-op half and still matters: the Inspector
 * standing three tiles back does NOT feed the tank, so being struck is what
 * pays a Watchman who is doing his job alone at the choke.
 */
export const RESOLVE_ON_STRUCK = 6;
/** …and when adjacent to an ally, per ally, per game turn. */
export const RESOLVE_PER_ADJACENT_ALLY = 3;
/** Focus builds by NOT MOVING — the "precision" half of ranged precision. */
export const FOCUS_ON_HELD_GROUND = 12;
/** …and by holding LOS on a marked target. */
export const FOCUS_ON_MARKED_IN_SIGHT = 8;
/** Reagents refill on kills — one per kill, never past the cap. */
export const REAGENTS_PER_KILL = 1;

export type ResourcePool = {
  readonly kind: ResourceKind;
  value: number;
  readonly max: number;
  /**
   * GAME TURNS banked toward the next whole unit of a `regenEvery` refill.
   * `reload_counter` in `regenAmmo` (Actor.lua:2074-2084). Always 0 for a kind
   * with no `regenEvery`.
   *
   * ═══ ENGINE-ONLY, NOT ON THE WIRE, AND DELIBERATELY NOT SAVED ═══
   * `ResourceView` carries `current`/`max`/`discrete` and nothing else, and this
   * is NOT in `SavedResources` (persist/saves.ts:330-342). A reconnect therefore
   * loses at most `regenEvery - 1` turns of accumulation.
   *
   * That is the same invisible class of loss as `TalentSheet.movedThisTurn`,
   * which is also rebuilt from nothing on load: nobody can observe it, nothing
   * derived from it is wrong afterwards, and the worst case costs eleven turns
   * of walking. Which is exactly why NO `SCHEMA_VERSION` BUMP IS NEEDED — the
   * saved shape is byte-identical to what it was before regen existed.
   *
   * THE OMISSION IS A DECISION, NOT AN OVERSIGHT. Persisting it would put a
   * sub-unit counter into a save file whose entire promise is that a Reagent is
   * a countable object, and would buy back eleven turns nobody was counting.
   * Anyone tempted to "fix" it should read this paragraph first.
   */
  regenCounter: number;
};

export function createResourcePool(kind: ResourceKind): ResourcePool {
  const rules = RESOURCE_RULES[kind];
  return { kind, value: rules.start, max: rules.max, regenCounter: 0 };
}

export function hasResource(pool: ResourcePool, amount: number): boolean {
  return pool.value >= amount;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * IS THERE ANYTHING LEFT THIS BODY COULD ACTUALLY DO THIS ROUND?
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The question `roundStaysOpen` asks after every action. If the answer is no,
 * the round closes and the world moves; if it is yes, the player is parked and
 * owed another decision.
 *
 * ═══ IT HAS TO BE HONEST ABOUT ALL THREE BUDGETS, NOT JUST AP ═══
 * Answering on `sheet.ap` alone is the tempting version and it strands people:
 * a Watchman sitting on 5 AP with Lockdown cooling and 12 Resolve has budget and
 * NOTHING TO SPEND IT ON. He would be parked with every button grey, waiting for
 * a Tail he has no reason to wait out, wondering what the game wants. So a
 * talent counts only if it is off cooldown AND affordable on AP AND affordable
 * on the class resource — the same three questions `canUseTalent` asks, in the
 * same order, for the same reason.
 *
 * ═══ `moveCost` IS A PARAMETER, NOT AN IMPORT ═══
 * eslint forbids `engine/** -> content/**`, and the cost of a step is content's
 * to own. Passing it keeps this module pure and keeps the number in one place.
 * Zero means a step is free, which is the game as it shipped.
 */
/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT A STEP COSTS — `docs/game-design.md` § 6, authored and never charged.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * *"The 6-AP / 3-MP round (from `city_watchman.json`'s `max_ap: 6` / `max_mp:
 * 3`). **Move = 1 MP**; talents cost their authored `ap_cost`."*
 *
 * MP existed, was refilled every turn, and was spent by exactly one talent (Fog
 * Step). Nothing charged for walking, so the entire M column was decorative —
 * and so was SLOWED, whose player half is `-1 MP` and therefore subtracted from
 * a pool nothing drew on.
 *
 * ONE MP, NOT THE AP THE IMPLEMENTATION PLAN PROPOSED. The plan priced a step
 * at 2 AP; the design document prices it at 1 MP, and `city_watchman.json` is
 * where both numbers come from. When a plan and the design authority disagree
 * about an authored number, the authored number wins — and it is the better
 * mechanic here, because it keeps movement and casting on separate budgets, so
 * a Watchman cannot trade his whole round for six steps.
 */
export const MOVE_MP_COST = 1;

/**
 * What a status is taking off this body's round.
 *
 * DECLARED HERE RATHER THAN IMPORTED from engine/effects.ts, structurally, for
 * the reason `TalentCallCtx.status` gives at length: this module runs a small
 * effect system of its own, and two modules exporting "effects" into each other
 * is how a cycle starts. The shape is two numbers, and the adapter in main.ts is
 * the one place that holds both sides.
 */
export type BudgetPenalty = { readonly ap: number; readonly mp: number };

export function hasAffordableAction(
  engine: TalentEngine,
  actor: TalentActor,
  /**
   * What a step costs, in MP. `MOVE_MP_COST` in play; 0 in a build where
   * walking is free, which is every fixture that does not thread the seam.
   */
  moveCost: number,
): boolean {
  const sheet = engine.sheetOf(actor.id);
  if (sheet === undefined) return false;
  // A STEP IS AN ACTION. Checked first because it is the cheapest thing anybody
  // can do and the commonest reason a round is still worth holding open.
  if (moveCost > 0 && sheet.mp >= moveCost) return true;

  for (const id of sheet.loadout) {
    const talent = engine.registry.get(id);
    if (talent === undefined) continue;
    if (cooldownOf(actor, talent.id) > 0) continue;
    if (sheet.ap < (talent.cost.ap ?? 0)) continue;
    if (sheet.mp < (talent.cost.mp ?? 0)) continue;
    if (!hasResource(sheet.resource, talent.cost.resource ?? 0)) continue;
    return true;
  }
  return false;
}

/** Spend, or refuse and change nothing. Never goes negative. */
export function spendResource(pool: ResourcePool, amount: number): boolean {
  if (amount <= 0) return true;
  if (pool.value < amount) return false;
  pool.value -= amount;
  return true;
}

/** Gain, clamped to the cap. Returns what was actually added. */
export function gainResource(pool: ResourcePool, amount: number): number {
  const before = pool.value;
  pool.value = bound(pool.value + amount, 0, pool.max);
  return pool.value - before;
}

/**
 * "Resolve builds when struck" — the half of the rule that had no code at all.
 *
 * A FREE FUNCTION AS WELL AS AN ENGINE METHOD because the sheet is the whole
 * input: `TalentEngine.noteStruck` resolves an id to a sheet and delegates here,
 * and a test can drive the arithmetic without standing up an engine. It does NOT
 * check the resource kind — its one caller does, and re-checking in two places
 * is how the two eventually disagree about who earns Resolve.
 *
 * @returns what was actually added, which is 0 at the cap.
 */
export function gainResolveOnStruck(sheet: TalentSheet): number {
  return gainResource(sheet.resource, RESOLVE_ON_STRUCK);
}

// ---------------------------------------------------------------------------
// Talent-owned durations — the two effects M3 genuinely cannot ship without
// ---------------------------------------------------------------------------

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THIS IS NOT THE STATUS SYSTEM. M4 OWNS THAT.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * game-design.md § 7 ships Stunned / Bleeding / Slowed at M4, with typed saves
 * and partial-save duration scaling. None of that is here and none of it should
 * be — a second effect system is exactly the kind of thing that gets written
 * twice and reconciled never.
 *
 * What IS here is the two durations without which two of the twelve talents do
 * not exist as designed:
 *
 *   GUARDED — the Watchman is standing over an ally. This is "the thing that
 *             makes co-op work" (game-design.md § 2's ally-utility slot), so it
 *             cannot wait for M4.
 *   MARKED  — the Inspector has painted a target and allies hit it harder. Same
 *             argument: the Inspector's ally-utility slot IS the mark.
 *
 * Both are stored in one table keyed by actor id, both tick on the BASE clock
 * in `talentActBase`, and both are shaped like M4's `EffectDef` (a kind, a
 * duration in turns, a power) so that M4 absorbs them by moving the table
 * rather than by rewriting the talents.
 *
 * WHY A SIDE TABLE AND NOT A FIELD ON `EngineActor`. engine/actor.ts argues,
 * correctly, that a second view of an actor desyncs and that `hp` is the first
 * field to go. That argument is about DUPLICATED state. Nothing here is
 * duplicated: it is strictly additive, keyed by id, and `forget()` is called
 * from the one place actors are removed. Keeping it out of `EngineActor` is
 * also what lets M4 delete this table in one commit.
 */
export const TalentEffect = {
  /** Held by the GUARDIAN. `otherId` is the ally being guarded. */
  Guarding: 'guarding',
  /** Held by the TARGET. `otherId` is who taunted it. */
  Taunted: 'taunted',
  /** Held by the TARGET. `power` is the % extra damage everything deals to it. */
  Marked: 'marked',
} as const;
export type TalentEffect = (typeof TalentEffect)[keyof typeof TalentEffect];

export type TalentEffectInstance = {
  readonly kind: TalentEffect;
  /** The other party — the guarded ally, the taunter, the marker. */
  readonly otherId: string;
  /** GAME TURNS remaining. Decremented in `talentActBase`, never in `act`. */
  turns: number;
  /**
   * Magnitude, where the effect has one. SNAPSHOT AT CAST TIME AND `readonly`
   * — the number the caster had when the effect landed, not the number they
   * have now. That is what lets a talent level move without retroactively
   * changing a mark that is already burning on a monster.
   *
   * ═══ THE UNITS ARE PER-KIND, AND THERE ARE TWO ═══
   *   Marked   — PERCENT extra damage the target takes. `markMultiplier` turns
   *              it into `1 + power/100`.
   *   Guarding — the counter-swing's weapon-damage MULTIPLIER, read straight by
   *              `resolveGuardCounter`. Not a percent; 0.7 means 70%.
   *   Taunted  — unused, written as 0.
   *
   * Two units on one field is a real wart. It is preferred to a second field
   * that is `undefined` for two kinds out of three, and to a discriminated
   * union that M4's `EffectDef` would have to absorb anyway — the whole reason
   * this table is shaped like `EffectDef` is so M4 can adopt it by MOVING it.
   */
  readonly power: number;
};

// ---------------------------------------------------------------------------
// The actor, as the talent system sees it
// ---------------------------------------------------------------------------

/**
 * STRUCTURAL, exactly like combat.ts's `CombatActor` and for the same reason: a
 * bare test fixture, a content-loaded template and a live `EngineActor` are all
 * valid inputs, and widening this to the real actor type would drag the energy
 * clocks and the barrier's control flags into every talent unit test.
 *
 * `ai` and `energy` are optional because only monsters have the first and the
 * scheduler owns the second; the two talents that touch them (Iron Curtain's
 * aggro pull and Lockdown's action-budget drain) narrow before writing.
 */
export type TalentActor = {
  readonly id: string;
  readonly name: string;
  readonly kind: ActorKind;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  alive: boolean;
  readonly attackRange?: number;
  readonly combat?: CombatSheet;
  /** Talent id -> GAME TURNS left. Owned and ticked by engine/actor.ts. */
  readonly cooldowns: Map<string, number>;
  /** Monsters only. Written by the taunt talents — this is ToME's `setTarget`. */
  readonly ai?: { targetId: string | null };
  /**
   * WHICH SIDE. Declared here because `isEnemy` and `isFriend` read it, and a
   * type that did not mention it would let the whole faction rule work only by
   * runtime luck — the object really is a `MonsterActor` and really does carry
   * the field, but nothing would have said so and the next reader would have
   * removed the check as dead. See `Faction` in engine/actor.ts.
   */
  readonly faction?: Faction;
  /** The ACT clock. Read-modify-written ONLY by Lockdown; see the note there. */
  energy?: number;
};

/**
 * ONE BODY THAT A TALENT PUT SOMEWHERE ELSE — net, not per step.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS TYPE EXISTS: THREE TALENTS MOVED PEOPLE AND NOBODY WAS TOLD
 * ═══════════════════════════════════════════════════════════════════════════
 * Fog Step blinks the caster up to three tiles, Ward Rush knocks the victim back
 * and advances the caster into the vacated square, and Backdraft shoves. All
 * three go through `world.tryMove`, so the SERVER's positions were always right
 * — but `Effect.talent` carried only `{landing, blows}`, `toWireEvents` emitted
 * a single `{k:'talent'}` FX stamp, and the client's `case 'talent'` is
 * deliberately NO STATE CHANGE. So no `move` frame was ever produced and every
 * client, the caster's own included, kept drawing her on the tile she left, with
 * the camera, the targeting cursor and travel pathing all anchored there. There
 * is no client-initiated resync in the protocol and `needsFullResync` fires only
 * on downed/revived/erased, so the desync was PERMANENT until somebody wiped.
 *
 * `from` and `to` are the NET displacement — `stepToward` walks up to three
 * single steps and the wire wants one hop, exactly as `GameEvent.moved` carries
 * one for an ordinary walk.
 */
export type ActorMove = {
  readonly id: string;
  readonly from: TileXY;
  readonly to: TileXY;
};

/** Just enough world. `World` satisfies it — proven below. */
export type TalentWorld = {
  readonly level: LevelView;
  getActor(id: string): TalentActor | undefined;
  actorAt(x: number, y: number): TalentActor | undefined;
  allActors(): TalentActor[];
  tryMove(id: string, dir: Dir): { ok: true; x: number; y: number } | { ok: false; reason: string };
};

/**
 * Compile-time proof that the real world is a valid `TalentWorld`. If a method
 * is renamed on either side this fails HERE, naming both types, rather than at
 * a call site in a talent file with an error pointing at the wrong module.
 */
const _worldShapeCheck = (world: World): TalentWorld => world;

// ---------------------------------------------------------------------------
// The talent
// ---------------------------------------------------------------------------

/** What a use costs. Every field optional; most talents use two of the four. */
export type TalentCost = {
  /** Action points, out of the 6 a player gets per round (game-design.md § 6). */
  readonly ap?: number;
  /** Movement points, out of 3. Move = 1 MP. */
  readonly mp?: number;
  /** The class resource. Kind is implied by the class; amount is authored. */
  readonly resource?: number;
};

export type TalentTargeting = {
  readonly shape: TargetShape;
  /**
   * Tiles, EUCLIDEAN (`core.fov.distance`) — see combat.ts's note on metrics.
   *
   * THE LEVEL-1 RANGE when `rangeAt` is present. Read it through
   * `effectiveTalentRange`, never directly, or Fog Step is gated at 3 tiles for
   * a character who bought it up to 7.
   */
  readonly range: number;
  /**
   * OPTIONAL PER-ACTOR RANGE — the one talent number that is not damage.
   *
   * Fog Step's whole content is its distance, so its level has to move that or
   * its level is cosmetic (`combatTalentLimit(t, 10, 3, 7)`, mobility.lua:40-62,
   * floored: 3/4/5/6/7, one tile per level with no dead rank). Every other
   * talent omits this and its range is frozen — see each file's own argument.
   *
   * ═══ WHY A FUNCTION ON THE TALENT AND NOT A TABLE IN THE ENGINE ═══
   * The registry-cycle rule below (`Talent`'s docblock) is that engine/talents.ts
   * must never import the talent files, and it must therefore never learn the
   * string `talent:fog_step` either — a lookup table keyed by id would be that
   * knowledge smuggled in as data. A closure the talent supplies keeps the
   * curve in the file that cites it, which is also the file a balance pass
   * opens.
   *
   * `canUseTalent` resolves it before `checkTargeting`; view/projector.ts is
   * the other caller, so the number the client draws its ring at is the number
   * the server refuses against.
   */
  readonly rangeAt?: (talentLevel: number) => number;
  /**
   * The dead zone. Closer than this and the talent is REFUSED, never missed.
   *
   * The Inspector's 3 (game-design.md § 2: "the single most important number
   * here"). 0 for everything melee, and 0 for Fog Step specifically — see that
   * file, it is the escape hatch and gating it would be a cruel joke.
   */
  readonly minRange: number;
  /** Cross and Ball only. Tiles. */
  readonly radius?: number;
  /** Ranged talents need it; melee does not (you are standing on them). */
  readonly requiresLos: boolean;
  /** Who the shape may land on. Player AoE never hits allies (§ 10). */
  readonly affinity: Affinity;
};

/** Where the player pointed. `actorId` is present for actor-targeted shapes. */
export type TalentTarget = {
  readonly x: number;
  readonly y: number;
  readonly actorId?: string;
};

/**
 * What a CALLER of `useTalent` supplies. Notably NOT `talentLevel`.
 *
 * The level is not the caller's to know: `useTalent` reads the sheet anyway (it
 * has to, to spend AP), the talent id is already in its hand, and computing the
 * level in one place is what stops the scheduler, the GM console and a test
 * fixture from each having their own opinion about what level somebody's talent
 * is. src/server/main.ts's `talentRuntimeFor` passes exactly these three.
 */
export type TalentCallCtx = {
  readonly engine: TalentEngine;
  readonly world: TalentWorld;
  /** The world's seeded stream. Every draw carries a label. */
  readonly rng: Rng;
  /**
   * ═══════════════════════════════════════════════════════════════════════
   * THE DOOR TO THE STATUS SYSTEM. A CLOSURE, AND THAT IS DELIBERATE.
   * ═══════════════════════════════════════════════════════════════════════
   *
   * This module must not import `engine/effects.ts`. It already runs a small
   * effect system of its own — `TalentEffect`, which is taunts and marks and
   * guards, per-talent bookkeeping the scheduler reads — and two modules that
   * each export "effects" into the other is how a cycle starts. So the real
   * status table arrives as `statusApplier(state, rng, ctx)`: one function,
   * carrying its own state, rng and log.
   *
   * The rng is the WORLD's, folded in by whoever built the closure rather than
   * taken from `ctx.rng` here, so a stun rolled inside a talent draws from the
   * same labelled stream as one rolled anywhere else — which is what keeps a
   * seeded replay a replay.
   *
   * OPTIONAL, LIKE EVERY OTHER SEAM IN THIS FILE. Absent → a talent that wants
   * a status silently does the rest of its job, which is what every fixture
   * built before the status table existed expects.
   */
  readonly status?: StatusApply;
};

/**
 * Everything a talent BODY is handed. One object, so signatures stay short.
 *
 * ═══ `talentLevel` IS THE WHOLE SEAM ═══
 * It is computed ONCE, in `useTalent`, from the caster's sheet, and injected
 * beside the recording world. That is deliberately the only way a body learns
 * its rank: no talent needs to know its own id, none reaches for the sheet, and
 * none can be resolved at a level nobody wrote down. A body that wants a scaled
 * number writes `combatTalentScale(ctx.talentLevel, LOW, HIGH)` and nothing
 * else.
 */
export type TalentCtx = TalentCallCtx & {
  /** Effective talent level, 1..5 for a player. See `getTalentLevelRaw`. */
  readonly talentLevel: number;
};

/** One actor's slice of what a talent did. The Record log prints these. */
export type TalentHit = {
  readonly targetId: string;
  /** False is a MISS. Talents that never roll to-hit (spells) report true. */
  readonly hit: boolean;
  readonly damage: number;
  readonly healed: number;
  readonly crit: boolean;
  readonly killed: boolean;
  readonly type: DamageType;
};

/**
 * A GUARDED ALLY WAS STRUCK AND WHOEVER IS GUARDING THEM SWUNG BACK — the
 * second half of the Watchman's Iron Curtain, and `resolveGuardCounter`'s answer.
 *
 * `guardianId` is carried BESIDE the hit rather than folded into it because
 * `TalentHit` names only the VICTIM, and the whole point of a counter is that
 * somebody other than the actor whose turn it is dealt the damage. Without this
 * field the scheduler would have to either attribute the `attacked` event to the
 * monster that got hit, or walk the guard table a second time to find out who
 * swung — a second answer to a question this function has already answered.
 */
export type GuardCounter = {
  /** Who swung. Always a live body with a `Guarding` effect naming the victim. */
  readonly guardianId: string;
  /** The swing, ALREADY APPLIED to the world by the time this is returned. */
  readonly hit: TalentHit;
};

/** Why a talent never happened. NEVER a miss — a miss is `hit: false`. */
export const TalentRefusal = {
  UnknownTalent: 'unknown_talent',
  /**
   * IT HAS NO BODY TO RUN — a passive. Pressing one is a mistake a player can
   * make (a stale hotbar, a rebound key, a click on the panel row), so the
   * answer is a sentence rather than a throw, and it is refused BEFORE anything
   * is charged: a passive that ate the turn's action points would be the worst
   * possible reading of "always on".
   */
  Passive: 'passive',
  /** Not in this actor's fixed loadout. */
  NotLearned: 'not_learned',
  Dead: 'dead',
  OnCooldown: 'on_cooldown',
  NoAp: 'no_ap',
  NoMp: 'no_mp',
  NoResource: 'no_resource',
  /** No actor there, or the one that was there is a corpse. */
  NoTarget: 'no_target',
  NotHostile: 'not_hostile',
  NotAlly: 'not_ally',
  Self: 'self',
  OutOfRange: 'out_of_range',
  /** INSIDE the dead zone. The Inspector cannot shoot what is on top of it. */
  MinRange: 'min_range',
  NoLineOfSight: 'no_los',
  /** Terrain or a body in the way of a shove, a step or a placement. */
  Blocked: 'blocked',
} as const;
export type TalentRefusal = (typeof TalentRefusal)[keyof typeof TalentRefusal];

/**
 * A talent body's answer. Discriminated on `ok` so a caller cannot read `hits`
 * off a refusal, and a refusal from here is refunded exactly like a refusal
 * from `canUseTalent`.
 */
export type TalentOutcome =
  | { readonly ok: false; readonly reason: TalentRefusal }
  | {
      readonly ok: true;
      readonly hits: readonly TalentHit[];
      /** Log lines the talent wants said. Terse and mechanical (§ 11). */
      readonly notes: readonly string[];
    };

/** Convenience for the common `ok: true` shape. */
export function talentDone(
  hits: readonly TalentHit[] = [],
  notes: readonly string[] = [],
): TalentOutcome {
  return { ok: true, hits, notes };
}

/** Convenience for a refusal, which is the refund path. */
export function talentRefused(reason: TalentRefusal): TalentOutcome {
  return { ok: false, reason };
}

/**
 * A talent. Twelve of these exist; each lives in its own file under
 * src/server/talents/ and is registered by src/server/content/classes.ts.
 *
 * The registry is built THERE and not here on purpose: engine/talents.ts must
 * not import the talent files, or `engine → talents → engine` is a cycle and
 * the module graph stops being one-way.
 */
export type Talent = {
  readonly id: string;
  readonly name: string;
  readonly classId: ClassId;
  /**
   * WHICH TREE THIS BELONGS TO — `content/talent-trees.ts`'s `TalentTree.id`.
   *
   * A SOFT REFERENCE, exactly as `classId` is: a string rather than a union of
   * the authored tree ids, so adding a tree is a content edit and not a change
   * to the engine's type. The panel groups by it and falls back to ungrouped for
   * an id nothing authored, which is the same treatment a missing class gets.
   */
  readonly tree: string;
  /** Active, sustained or passive. See `TalentKind` — everything is Active today. */
  readonly kind: TalentKind;
  /**
   * `manifest.icons` key. All twelve already exist as 64x64 art
   * (docs/assets-needed.md, "Talent and ability icons": *zero needed, at any
   * planned milestone*).
   */
  readonly iconId: string;
  readonly cost: TalentCost;
  /** GAME TURNS. 0 is at-will and gated by AP alone. See the conversions above. */
  readonly cooldownTurns: number;
  readonly targeting: TalentTargeting;
  /** What its damage is typed as. `physical` for anything that does none. */
  readonly damageType: DamageType;
  /**
   * THE body. Synchronous — targeting already arrived with the command.
   *
   * ABSENT ON A PASSIVE, and that is the whole of how a passive is declared.
   * ToME spells the same thing as `mode = "passive"` with no `action`; here the
   * missing function IS the mode, so a passive cannot be given a body by
   * accident and an active cannot lose one — `kind` and this field would then be
   * two statements of one fact, and the compiler only checks one of them.
   *
   * `submitTalent` refuses a talent with no body rather than throwing: pressing
   * one is a mistake a player can make, and the answer is a sentence.
   */
  readonly onUse?: (ctx: TalentCtx, self: TalentActor, target: TalentTarget) => TalentOutcome;
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * WHAT THIS PASSIVE IS WORTH AT A RANK. Absent on everything else.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * ToME's `passives = function(self, t, p) self:talentTemporaryValue(p,
   * "combat_def", t.getDef(self, t)) end` (buckler-training.lua:183-186): a
   * passive writes onto the ACTOR, and every derived getter then reads it
   * without knowing a talent was involved. The port keeps that property — the
   * return value lands in `actor.passiveCombat` and `recomposeCombat` folds it in
   * at stage two and a half, over gear and under status flags.
   *
   * IT RETURNS THE SAME SHAPE A WORN ITEM CONTRIBUTES, through the same combine,
   * so "does a passive stack with a pauldron" has one answer instead of two.
   */
  readonly passive?: (level: number) => PassiveContribution;
  /**
   * One line for the hotbar tooltip, rendered SERVER-SIDE, AT A GIVEN LEVEL.
   *
   * The client never computes a displayed number — eslint's
   * `NO_COMBAT_MATH_PATTERNS` blocks it from even importing the formulas, and a
   * second copy of a formula always diverges.
   *
   * ═══ THE `level` PARAMETER IS WHAT MAKES THE PANEL HONEST ═══
   * Called twice per talent — `describe(self, level)` and
   * `describe(self, level + 1)` — to produce the current→next diff that ToME's
   * levelup dialog puts on screen (LevelupDialog.lua:963-970). That diff is the
   * single most valuable thing on that screen, and it is only possible because
   * both strings are rendered where the formulas live.
   *
   * EVERY IMPLEMENTATION MUST RENDER ITS SCALED NUMBER. A `describe` that
   * ignores its rank shows a player a level that changes nothing, which is
   * worse than showing no level at all. test/server/talent-scaling.test.ts
   * asserts `describe(self, n) !== describe(self, n + 1)` for all twelve at
   * every rank, so a talent added later without a curve fails there.
   */
  readonly describe: (self: TalentActor, level: number) => string;
};

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

export type TalentRegistry = {
  register(talent: Talent): void;
  get(id: string): Talent | undefined;
  /** Insertion order, which is hotbar order. */
  all(): readonly Talent[];
  forClass(classId: ClassId): readonly Talent[];
};

/** A registry. Duplicate ids THROW — a silently clobbered talent is a bad day. */
export function createTalentRegistry(): TalentRegistry {
  const byId = new Map<string, Talent>();

  return {
    register: (talent: Talent): void => {
      if (byId.has(talent.id)) {
        throw new Error(`talents: duplicate talent id ${talent.id}`);
      }
      byId.set(talent.id, talent);
    },
    get: (id: string): Talent | undefined => byId.get(id),
    all: (): readonly Talent[] => [...byId.values()],
    forClass: (classId: ClassId): readonly Talent[] =>
      [...byId.values()].filter((talent) => talent.classId === classId),
  };
}

// ---------------------------------------------------------------------------
// The per-actor sheet
// ---------------------------------------------------------------------------

/**
 * A player's class state: the loadout, the RAW talent points, the resource pool
 * and the intra-turn budget.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE SHEET OWNS RAW POINTS. IT DOES NOT OWN LEVEL, XP OR UNSPENT POINTS.
 * ═══════════════════════════════════════════════════════════════════════════
 * Those three live on `PlayerActor` (engine/actor.ts), for the reason that
 * type's `classId` docblock already spells out at length: the SAVE LAYER CANNOT
 * REACH THE TALENT ENGINE. src/server/persist/ knows about actors and not about
 * sheets, so anything it must write down has to be on the actor. The split is
 * therefore not a style choice — put `level` here as well and there are two
 * fields called level, one of which is the one that got saved.
 *
 * Stated once, here, so neither side ever claims authority over the other's:
 *
 *     TalentSheet.points   RAW points per talent, 1..5. THIS IS THE TRUTH about
 *                          what a talent does. Persisted verbatim.
 *     PlayerActor.level    character level. PlayerActor.xp, per-level xp.
 *     unspent              DERIVED, never stored:
 *                          totalPointsAtLevel(level) - sum(points.values()).
 *
 * `loadout` stays `readonly`: progression DEEPENS the four rather than adding a
 * fifth, so nothing appends to it. `ClassDef.loadout` is arity-checked at four
 * at import time, and a fifth talent would be a content change, not a level-up.
 */
export type TalentSheet = {
  readonly classId: ClassId;
  readonly loadout: readonly string[];
  /**
   * THE PASSIVES THIS BODY OWNS. Separate from `loadout` for the reason
   * `ClassDef.passives` gives: `loadout` IS the hotbar, and a passive on the
   * hotbar is a key that does nothing.
   *
   * They share `points`, because a passive is raised with the same talent point
   * as anything else and `getTalentLevelRaw` reads one map. Two point maps would be
   * two answers to "what rank is this", and the spend path would have to pick.
   */
  readonly passives: readonly string[];
  /**
   * Namespaced talent id -> RAW points spent on it, 1..5.
   *
   * KEYED EXACTLY LIKE `actor.cooldowns` — `talent:<id>`, the registry key,
   * which `projectCooldowns` already sends verbatim for the client to match
   * against `LoadoutTalent.id`. A second keying convention here would produce a
   * panel where the `+` button and the cooldown pip disagree about which
   * talent they are on, two modules apart.
   *
   * MUTABLE (`Map`, not `ReadonlyMap`) because the spend path writes it. The
   * CAP is not enforced here — `TALENT_MAX_LEVEL` belongs to the spend path,
   * which is the only thing that hands out points; see src/shared/scale.ts's
   * "NEVER CLAMP THE TALENT LEVEL AT 5" for why the curve deliberately does not
   * clamp either.
   */
  readonly points: Map<string, number>;
  readonly resource: ResourcePool;
  ap: number;
  readonly maxAp: number;
  mp: number;
  readonly maxMp: number;
  /**
   * Did this actor change tiles since its last base turn? Focus regen reads it
   * ("Focus builds ... by not moving"). Set by whoever moves an actor; cleared
   * by `talentActBase` after the regen pass.
   */
  movedThisTurn: boolean;
};

export type TalentSheetInit = {
  /** The passives this class owns. Absent is none, which is every old fixture. */
  readonly passives?: readonly string[];
  readonly classId: ClassId;
  readonly loadout: readonly string[];
  readonly resource: ResourceKind;
  readonly maxAp: number;
  readonly maxMp: number;
  /**
   * A RESTORED point spread. Omit it for a fresh character.
   *
   * Present so that a save restore feeds THE SAME CONSTRUCTOR a new character
   * does, rather than building a sheet and then mutating it into shape — two
   * ways to make a sheet is two places for the seeding rule below to be
   * forgotten, and the one that forgets it hands a loaded character talents at
   * level 0.
   */
  readonly points?: ReadonlyMap<string, number>;
};

/**
 * BIRTH GRANTS THE FOUR AT LEVEL 1, and that seeding is the whole birth grant.
 *
 * ToME's own pattern: data/birth/classes/warrior.lua:80-86 hands a fresh
 * Berserker five talents outright, already learned, before a single point is
 * spent. Ours hands four — `ClassDef.loadout` — and `pointsForLevel` therefore
 * drops upstream's separate 2-point birth grant (Actor.lua:171), because these
 * four ARE that gift, paid in talents instead of points. See
 * src/shared/progression.ts for the budget arithmetic that falls out of it.
 *
 * Seeding at 1 rather than 0 is load-bearing in a way that is easy to miss:
 * `combatTalentScale` maps tl <= 0 to 0.1 (scale.ts:191), so a talent at level
 * 0 does not refuse — it resolves, quietly, for a fraction of its damage.
 */
export function createTalentSheet(init: TalentSheetInit): TalentSheet {
  const points = new Map<string, number>();
  for (const id of init.loadout) points.set(id, init.points?.get(id) ?? 1);
  // A PASSIVE IS BORN LEARNED, exactly as the four are. Rank 0 would not merely
  // be "off": `combatTalentScale` maps 0 to 0.1, so a passive at rank 0 is a
  // tenth of itself rather than nothing — see `BIRTH_RANK`'s note. Learned at
  // one is the honest state and the only one the scale reads cleanly.
  const passives = init.passives ?? [];
  for (const id of passives) points.set(id, init.points?.get(id) ?? 1);

  return {
    classId: init.classId,
    loadout: [...init.loadout],
    passives: [...passives],
    points,
    resource: createResourcePool(init.resource),
    ap: init.maxAp,
    maxAp: init.maxAp,
    mp: init.maxMp,
    maxMp: init.maxMp,
    movedThisTurn: false,
  };
}

/**
 * The EFFECTIVE talent level — `getTalentLevelRaw`, ActorTalents.lua:824-834.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * MASTERY IS DELIBERATELY DROPPED, AND THAT IS WHY THIS IS ONE LINE.
 * ═══════════════════════════════════════════════════════════════════════════
 * Upstream reads, VERBATIM, at ActorTalents.lua:834:
 *
 *     return t and (self:getTalentLevelRaw(id)) * ((self.talents_types_mastery[t.type[1]] or 0) + 1) or 0
 *
 * (This block used to carry a PARAPHRASE — `self:getTalentTypeMastery(...) or 1`
 * — set in this file's verbatim-quote style. `getTalentTypeMastery` is a real
 * function at ActorTalents.lua:849 and it is `(x or 0) + 1`, but `getTalentLevelRaw`
 * does not call it; it inlines the table read. A paraphrase indented as a quote
 * is the one thing a reader cannot check by grepping.)
 *
 * The mastery figure is authored PER CLASS PER TREE at birth, and what is
 * authored is a BONUS rather than a multiplier — warrior.lua:68 and :72 give a
 * Berserker
 *
 *     ["technique/2hweapon-assault"]={true, 0.3},
 *     ["technique/combat-training"]={true, 0.3},
 *
 * where `true` is "start with this tree open" and 0.3 is the bonus.
 * Birther.lua:408 ACCUMULATES it (`talents_types_mastery[t] = (existing or 0) +
 * mastery`, so two descriptors contributing to one tree add up) and the `+ 1`
 * above is what turns 0.3 into a 1.3 multiplier at read time. The distinction
 * matters for anybody restoring this: store multipliers where ToME stores
 * additive bonuses and a second contributor multiplies instead of accumulating.
 *
 * (This block also used to name the tree `technique/2hweapon` — the real one is
 * `technique/2hweapon-assault` — and to attribute 1.2 to combat-training, which
 * is 0.3/1.3 like its neighbour. The 0.2 that would read as 1.2 belongs to
 * `["technique/bloodthirst"]={false, 0.2}` at warrior.lua:76.)
 *
 * Mastery's entire job is to make the same talent, in the same tree, stronger
 * for the class that specialises in it.
 * We have FOUR talents per class and NO SHARED TREES: every talent is reachable
 * from exactly one loadout (test/server/talents.test.ts pins the whole 3x12
 * grid), so there is no second owner to differentiate against and a mastery
 * table would be twelve rows of 1.0.
 *
 * WHAT DROPPING IT BUYS, and it is not just brevity: effective level == raw
 * level == 1..5, which is EXACTLY the interval `combatTalentScale` is fitted
 * over (xLow = 1, xHigh = 5, scale.ts:193-194). Nothing extrapolates, nothing
 * clamps, and the "4/5" a player reads in the panel is the same integer the
 * damage formula receives. With mastery, 4 raw points at 1.3 is talent level
 * 5.2 and the UI has to either lie or explain itself.
 *
 * @returns 0 for a talent this sheet has no points in. NOT 1 — a caller that
 *   gets 0 asked about something the actor does not have, and `canUseTalent`
 *   answers `NotLearned` for exactly that case before anything reaches here.
 */
export function getTalentLevelRaw(sheet: TalentSheet, id: string): number {
  return sheet.points.get(id) ?? 0;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE EFFECTIVE LEVEL — RAW TIMES THE CATEGORY'S MASTERY. ActorTalents.lua:826-834
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *     return t and (self:getTalentLevelRaw(id))
 *                * ((self.talents_types_mastery[t.type[1]] or 0) + 1) or 0
 *
 * That `+ 1` is upstream storing mastery as `value - 1` (:861 writes `v - 1`,
 * :849 reads it back as `+ 1`), so a category at "x1.30" holds 0.3 and a
 * category with no entry at all behaves as 1.0. We store the multiplier itself,
 * because there is no save-file compatibility reason to keep the offset and an
 * offset nobody needs is a subtraction somebody eventually forgets.
 *
 * ═══ THIS IS THE NUMBER THE MATHS USES; RAW IS THE NUMBER THE PANEL PRINTS ═══
 * ToME shows "4/5" — points SPENT — in the tree, and feeds the effective level to
 * `combatTalentScale`. Two different questions with two different answers, and
 * the reason this file's own name for them was wrong until now: what we called
 * `getTalentLevel` was upstream's RAW, which meant the mastery-aware one had no
 * name here at all and could not be missed.
 *
 * MASTERY DEFAULTS TO 1, so every caller that has no category to hand gets
 * exactly the behaviour it had before this existed.
 */
export function getTalentLevel(sheet: TalentSheet, id: string, mastery = 1): number {
  return getTalentLevelRaw(sheet, id) * mastery;
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

export type TalentEngine = {
  readonly registry: TalentRegistry;

  /** Give an actor a class. Called once, at spawn, by content/classes.ts. */
  attach(actorId: string, sheet: TalentSheet): TalentSheet;
  sheetOf(actorId: string): TalentSheet | undefined;
  /** Drop everything about an actor. The one place `removeActor` must call. */
  forget(actorId: string): void;

  effectsOn(actorId: string): readonly TalentEffectInstance[];
  effectOn(actorId: string, kind: TalentEffect): TalentEffectInstance | undefined;
  addEffect(actorId: string, effect: TalentEffectInstance): void;
  removeEffect(actorId: string, kind: TalentEffect): void;

  /**
   * ONCE PER GAME TURN PER ACTOR, from `actBase` and never from `act`.
   *
   * Ticks the talent-owned durations, regenerates the class resource and
   * refills the AP/MP budget. Nothing in here may read `globalSpeed` or
   * `speedFactor`; see this file's header for why that is the invariant.
   */
  /**
   * @param penalty what a status is taking off this round — SLOWED's `-1 MP`.
   *   Absent is no penalty, which is every caller that has no status table.
   */
  actBase(actorId: string, world: TalentWorld, penalty?: BudgetPenalty): void;

  /**
   * A kill happened. Reagents are a stock and this is half of how it refills.
   *
   * ═══ EXACTLY ONE CALLER, AND IT IS THE SCHEDULER ═══
   * `noteCasualty` (engine/scheduler.ts) is the one place a death is recognised
   * — for the weapon swing, for a talent, and for an orb landing three turns
   * after it was fired — so it is the one place that pays. `talentAttack` and
   * `talentProject` used to call this themselves, which paid the talent path
   * and left the basic swing paying nothing: an Alchemist who killed with her
   * bump swing (the majority of kills) got no reagent, spent her eight, and
   * every button on her hotbar answered `no_resource` for the rest of the
   * session with no way back. Two payment sites would ALSO double-pay a talent
   * kill once the scheduler seam existed, so the two calls were removed rather
   * than a third added.
   */
  noteKill(killerId: string): void;
  /**
   * A blow LANDED on this actor. Resolve's other half (`RESOLVE_ON_STRUCK`).
   *
   * Guarded on `ResourceKind.Resolve` for exactly the reason `noteKill` guards
   * on Reagents: paying the Inspector's Focus for being hit would reward the one
   * thing her class exists to avoid.
   *
   * Called for a LANDED blow with damage on it, never for a miss and never for
   * a refusal — see `noteBlows` in engine/scheduler.ts.
   */
  noteStruck(victimId: string): void;
  /** The party took the stairs. The other half: every Alchemist tops up. */
  noteStairs(): void;
};

export function createTalentEngine(registry: TalentRegistry): TalentEngine {
  const sheets = new Map<string, TalentSheet>();
  const effects = new Map<string, TalentEffectInstance[]>();

  const effectsOn = (actorId: string): readonly TalentEffectInstance[] =>
    effects.get(actorId) ?? [];

  const engine: TalentEngine = {
    registry,

    attach: (actorId: string, sheet: TalentSheet): TalentSheet => {
      sheets.set(actorId, sheet);
      return sheet;
    },
    sheetOf: (actorId: string): TalentSheet | undefined => sheets.get(actorId),
    forget: (actorId: string): void => {
      sheets.delete(actorId);
      effects.delete(actorId);
    },

    effectsOn,
    effectOn: (actorId: string, kind: TalentEffect): TalentEffectInstance | undefined =>
      effectsOn(actorId).find((effect) => effect.kind === kind),

    addEffect: (actorId: string, effect: TalentEffectInstance): void => {
      // `refresh` stacking (docs/data-schemas.md `EffectDef.stackMode`): a
      // second application replaces the first rather than queueing behind it,
      // so re-taunting never produces two competing taunts on one monster.
      const list = effects.get(actorId) ?? [];
      const kept = list.filter((existing) => existing.kind !== effect.kind);
      kept.push(effect);
      effects.set(actorId, kept);
    },

    removeEffect: (actorId: string, kind: TalentEffect): void => {
      const list = effects.get(actorId);
      if (list === undefined) return;
      const kept = list.filter((existing) => existing.kind !== kind);
      if (kept.length === 0) effects.delete(actorId);
      else effects.set(actorId, kept);
    },

    actBase: (actorId: string, world: TalentWorld, penalty?: BudgetPenalty): void => {
      tickEffects(effects, actorId);
      const sheet = sheets.get(actorId);
      if (sheet === undefined) return;
      const actor = world.getActor(actorId);
      if (actor === undefined || !actor.alive) return;
      regenResource(engine, sheet, actor, world);
      /**
       * ═══════════════════════════════════════════════════════════════════════
       * THE REFILL, MINUS WHATEVER IS BEING DONE TO THIS BODY.
       * ═══════════════════════════════════════════════════════════════════════
       *
       * SLOWED's player half is `-1 MP` and it has never been subtracted from
       * anything: `budgetPenalty` in engine/effects.ts had ZERO production
       * callers, so a Slowed detective moved exactly as far and acted exactly as
       * often as an unslowed one. The badge was the whole effect.
       *
       * HERE AND NOT EARLIER, because this line is the reason. `budgetPenalty`'s
       * own docblock says so: *"The caller applies this immediately after the
       * refill … a QUERY rather than a stateful subtraction, precisely because
       * that refill would clobber anything subtracted earlier in the turn."*
       * Anything that took MP off a Slowed player mid-round would be handed it
       * straight back on the next base pass.
       *
       * FLOORED AT ZERO. A penalty larger than the pool is a body that cannot
       * act, not a body with negative movement — and `hasAffordableAction` reads
       * these, so a negative would answer "affordable" through a sign error.
       */
      sheet.ap = Math.max(0, sheet.maxAp - (penalty?.ap ?? 0));
      sheet.mp = Math.max(0, sheet.maxMp - (penalty?.mp ?? 0));
      sheet.movedThisTurn = false;
    },

    noteKill: (killerId: string): void => {
      const sheet = sheets.get(killerId);
      if (sheet === undefined) return;
      // Reagents ONLY. Resolve and Focus are earned by standing in the right
      // place, not by landing the last hit — a kill-fed Resolve bar would pay
      // the Watchman for stealing the Inspector's shot.
      if (sheet.resource.kind === ResourceKind.Reagents) {
        gainResource(sheet.resource, REAGENTS_PER_KILL);
      }
    },

    noteStruck: (victimId: string): void => {
      const sheet = sheets.get(victimId);
      if (sheet === undefined) return;
      // RESOLVE ONLY. See `RESOLVE_ON_STRUCK`: this is the half of the rule
      // that pays a Watchman who is holding a choke with nobody beside him.
      if (sheet.resource.kind === ResourceKind.Resolve) {
        gainResolveOnStruck(sheet);
      }
    },

    // ═══════════════════════════════════════════════════════════════════════
    // STILL DEAD CODE. NOTHING IN src/ CALLS THIS. READ THIS BEFORE ASSUMING.
    // ═══════════════════════════════════════════════════════════════════════
    // `grep -rn noteStairs src/` finds this definition, the `TalentEngine` member
    // above, and TWO COMMENTS IN THE SCHEDULER (scheduler.ts:622, :2521) that
    // both describe it as unreachable "in a floor that has no stairs". There is
    // no call site, because there are no stairs yet.
    //
    // The per-turn regen added to `regenResource` is the FLOOR, NOT A
    // REPLACEMENT FOR THIS. It exists so an Alchemist is never permanently
    // stranded at zero; it does not top anyone up between floors, and it pays
    // about half what bodies do. When stairs land, wire this — the symptom that
    // made its absence obvious (a hotbar answering `no_resource` forever) is now
    // gone, so nothing will remind you.
    noteStairs: (): void => {
      for (const sheet of sheets.values()) {
        if (sheet.resource.kind === ResourceKind.Reagents) {
          gainResource(sheet.resource, sheet.resource.max);
        }
      }
    },
  };

  return engine;
}

/** Decrement every duration; drop it at zero, exactly as `cooldownTalents` does. */
function tickEffects(effects: Map<string, TalentEffectInstance[]>, actorId: string): void {
  const list = effects.get(actorId);
  if (list === undefined) return;
  const kept: TalentEffectInstance[] = [];
  for (const effect of list) {
    effect.turns -= 1;
    if (effect.turns > 0) kept.push(effect);
  }
  if (kept.length === 0) effects.delete(actorId);
  else effects.set(actorId, kept);
}

/** The per-class regen clause, once per game turn. */
function regenResource(
  engine: TalentEngine,
  sheet: TalentSheet,
  actor: TalentActor,
  world: TalentWorld,
): void {
  const pool = sheet.resource;
  gainResource(pool, RESOURCE_RULES[pool.kind].regenPerTurn);

  switch (pool.kind) {
    case ResourceKind.Resolve: {
      // "builds when struck and when adjacent to an ally" — the second half.
      let allies = 0;
      for (const other of world.allActors()) {
        if (other.id === actor.id || !other.alive || other.kind !== actor.kind) continue;
        if (chebyshev(actor, other) <= 1) allies += 1;
      }
      if (allies > 0) gainResource(pool, allies * RESOLVE_PER_ADJACENT_ALLY);
      return;
    }
    case ResourceKind.Focus: {
      // "builds by holding LOS on a marked target and by not moving".
      if (!sheet.movedThisTurn) gainResource(pool, FOCUS_ON_HELD_GROUND);
      for (const other of world.allActors()) {
        if (!other.alive || other.kind === actor.kind) continue;
        const mark = engine.effectOn(other.id, TalentEffect.Marked);
        if (mark === undefined || mark.otherId !== actor.id) continue;
        if (hasLineOfSight(world.level, actor, other)) {
          gainResource(pool, FOCUS_ON_MARKED_IN_SIGHT);
          break;
        }
      }
      return;
    }
    case ResourceKind.Reagents: {
      // ═══════════════════════════════════════════════════════════════════════
      // A COUNTED STOCK THAT REFILLS IN WHOLE UNITS — `regenAmmo`, ported.
      // ═══════════════════════════════════════════════════════════════════════
      // Actor.lua:2074-2084, verbatim:
      //
      //     if ammo.combat.shots_left >= ammo.combat.capacity then
      //       ammo.combat.shots_left = ammo.combat.capacity return end
      //     ammo.combat.reload_counter = (ammo.combat.reload_counter or 0) + 1
      //     if ammo.combat.reload_counter == r then
      //       ammo.combat.reload_counter = 0
      //       ammo.combat.shots_left = util.bound(shots_left + 1, 0, capacity)
      //     end
      //
      // THIS BLOCK USED TO FORBID EXACTLY THIS CHANGE ("if a regen line ever
      // appears here, the Alchemist has quietly become a mana class"). The
      // designer has since played the shipped build. Sitting at 0 Reagents with
      // four greyed-out buttons and no route back — `noteStairs` has never had a
      // caller, see below — is not "every cast is a discrete decision", it is a
      // class that has stopped existing. W7's DECISIONS.md entry records the
      // reversal and its reasoning.
      //
      // WHAT SURVIVES THE REVERSAL, mechanically rather than by promise: the
      // grant is ONE WHOLE UNIT and the REMAINDER LIVES ON THE COUNTER, NEVER
      // ON THE POOL. `pool.value` is an integer at every observable moment, so
      // the pips and the "N/8" on the character sheet can never disagree — a
      // stronger guarantee than the `regenPerTurn: 0` it replaces, which any
      // edit could have turned into 0.5.
      //
      // This is also still the FLOOR and not the economy: `REAGENT_REGEN_EVERY_TURNS`
      // pays roughly 8 vials over a 100-turn floor against roughly 15 from
      // bodies. Kills remain how an Alchemist is paid.
      //
      // INTEGER ARITHMETIC ONLY AND NO RNG. This runs inside the seeded turn,
      // and one draw here would shift every subsequent roll — the failure that
      // surfaces weeks later as "the level regenerated differently".
      const every = RESOURCE_RULES[pool.kind].regenEvery;
      if (every === undefined) return;
      // Actor.lua:2078. WITHOUT THE AT-CAP EARLY RETURN the counter banks while
      // the pool is full and the first vial she spends comes back for free —
      // and both kills and stairs push her to the cap, so that is the common
      // case, not an edge one. Upstream does NOT clear the counter here and
      // neither do we: a partial count that was genuinely earned before a
      // top-up survives it, which is bounded by `every - 1` turns and can never
      // exceed the cap because `gainResource` clamps.
      if (pool.value >= pool.max) return;
      pool.regenCounter += 1;
      if (pool.regenCounter >= every) {
        pool.regenCounter = 0;
        gainResource(pool, 1);
      }
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// Legality — the pure predicate half of the refund rule
// ---------------------------------------------------------------------------

/**
 * This talent's range FOR A CHARACTER OF THIS LEVEL, in tiles.
 *
 * One line, exported, because three places need the same answer and two of them
 * are on opposite sides of the wire: `canUseTalent` refuses against it,
 * view/projector.ts sends it as `LoadoutTalent.range` so the client's ring is
 * drawn at it, and the submission gate in turn-engine.ts re-checks it. A talent
 * whose range scales and whose ring does not is a player clicking a legal tile
 * and being told no.
 *
 * Everything without a `rangeAt` returns its static `range` — which is eleven
 * of the twelve, each of which argues its own frozen number in its own file.
 */
export function effectiveTalentRange(targeting: TalentTargeting, talentLevel: number): number {
  return targeting.rangeAt === undefined ? targeting.range : targeting.rangeAt(talentLevel);
}

/**
 * Can this actor use this talent on this target, RIGHT NOW?
 *
 * PURE — it reads the world and the actor's SHEET, and mutates neither. That is
 * what lets the scheduler call it at resolution time (the refund rule) and the
 * projector call it to grey out a hotbar slot, with no chance of the two
 * disagreeing.
 *
 * ("Reads the sheet" is not new; it has read it since the `NotLearned` check
 * below, and the AP/MP/resource checks are three more reads. It is restated
 * because the sheet now also carries the TALENT POINTS, and the range it
 * resolves for Fog Step is therefore per-actor rather than per-talent — a
 * caller holding a `Talent` alone can no longer reproduce this answer.)
 *
 * @returns the refusal, or `null` when it is legal.
 */
export function canUseTalent(
  engine: TalentEngine,
  actor: TalentActor,
  talent: Talent,
  target: TalentTarget,
  world: TalentWorld,
): TalentRefusal | null {
  if (!actor.alive) return TalentRefusal.Dead;

  const sheet = engine.sheetOf(actor.id);
  if (sheet === undefined || !sheet.loadout.includes(talent.id)) {
    return TalentRefusal.NotLearned;
  }
  if (cooldownOf(actor, talent.id) > 0) return TalentRefusal.OnCooldown;

  const cost = talent.cost;
  if (sheet.ap < (cost.ap ?? 0)) return TalentRefusal.NoAp;
  if (sheet.mp < (cost.mp ?? 0)) return TalentRefusal.NoMp;
  if (!hasResource(sheet.resource, cost.resource ?? 0)) return TalentRefusal.NoResource;

  // The sheet is already in hand, so the level costs nothing to resolve here —
  // and resolving it HERE rather than inside `checkTargeting` keeps that
  // function a function of numbers, testable without an engine.
  const range = effectiveTalentRange(talent.targeting, getTalentLevelRaw(sheet, talent.id));
  return checkTargeting(actor, talent.targeting, target, world, range);
}

/**
 * Range, dead zone, line of sight, and who is standing there.
 *
 * `range` arrives as a PARAMETER rather than being read off `targeting`,
 * because it is per-actor for anything carrying a `rangeAt` and this function
 * has no actor sheet to resolve it from. Passing the resolved number is what
 * keeps the resolution in exactly one place (`effectiveTalentRange`).
 */
function checkTargeting(
  actor: TalentActor,
  targeting: TalentTargeting,
  target: TalentTarget,
  world: TalentWorld,
  range: number,
): TalentRefusal | null {
  if (targeting.shape === TargetShape.Self) return null;

  // EUCLIDEAN, matching `core.fov.distance` and every other range in the game.
  // A Chebyshev ring is a square that reaches 7.07 tiles into its corners, and
  // the targeting UI draws a circle (combat.ts documents the two metrics).
  const distance = combatDistance(actor, target);
  if (distance > range) return TalentRefusal.OutOfRange;

  // THE DEAD ZONE. `<` not `<=`: minRange 3 means 3 is the closest LEGAL tile,
  // which is how the authored `min_range` reads and how the ring's hole is cut.
  if (targeting.minRange > 0 && distance < targeting.minRange) return TalentRefusal.MinRange;

  if (targeting.requiresLos && distance > 1 && !hasLineOfSight(world.level, actor, target)) {
    return TalentRefusal.NoLineOfSight;
  }

  if (targeting.shape === TargetShape.Tile) {
    // A destination must be empty floor. `tryMove` re-checks terrain when the
    // step actually happens; this check exists so the refusal is legible.
    if (world.actorAt(target.x, target.y) !== undefined) return TalentRefusal.Blocked;
    return null;
  }

  if (targeting.shape !== TargetShape.Single) return null;

  const victim = targetActor(world, target);
  if (victim === undefined) return TalentRefusal.NoTarget;
  if (victim.id === actor.id && targeting.affinity === Affinity.Hostile) return TalentRefusal.Self;
  // THE THIRD COPY, written inline rather than as a call, which is why fixing
  // the other two would still have let the Inspector shoot a shopkeeper:
  // `'player' === 'monster'` is false, so this never refused. See `areEnemies`.
  if (targeting.affinity === Affinity.Hostile && !areEnemies(actor, victim)) {
    return TalentRefusal.NotHostile;
  }
  if (targeting.affinity === Affinity.Ally && areEnemies(actor, victim)) {
    return TalentRefusal.NotAlly;
  }
  return null;
}

// ---------------------------------------------------------------------------
// useTalent — THE entry point
// ---------------------------------------------------------------------------

export type TalentUseResult =
  | { readonly ok: false; readonly reason: TalentRefusal }
  | {
      readonly ok: true;
      readonly talentId: string;
      readonly hits: readonly TalentHit[];
      readonly notes: readonly string[];
      /**
       * EVERY BODY THIS CAST PUT SOMEWHERE ELSE. See `ActorMove` for the bug.
       *
       * Empty for the nine talents that move nobody, so the caller's loop over
       * it costs nothing.
       */
      readonly moved: readonly ActorMove[];
      readonly apSpent: number;
      readonly mpSpent: number;
      readonly resourceSpent: number;
      readonly cooldownTurns: number;
    };

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A `TalentWorld` THAT REMEMBERS WHO IT MOVED. THE ONLY NEW MOVER IS NOBODY.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `tryMove` is delegated verbatim — world.ts is emphatic that it is "the ONLY
 * thing in the process allowed to change a position", and this wrapper does not
 * become a second one: it reads the tile before, calls the real thing, and
 * writes down what happened. Every other method is passed straight through.
 *
 * ═══ WHY AN INTERCEPTOR AND NOT A RETURN VALUE FROM EACH TALENT ═══
 * `stepToward` and `knockback` already return a step COUNT, and threading a
 * `moved` list out of all twelve `onUse` bodies would mean the tenth talent to
 * be written is the one that forgets — and forgetting is SILENT, because the
 * server's position is right and only the drawing is wrong. Recording at the one
 * function that can move anybody makes the report structural: a talent added
 * next year that shoves somebody is reported without touching this file.
 *
 * NET, NOT PER STEP: three consecutive `tryMove`s for one body collapse into one
 * `from`→`to`, because the wire's `move` frame is one hop and the client sets an
 * absolute destination. A body walked back to where it started reports nothing.
 */
function recordingWorld(world: TalentWorld, into: Map<string, ActorMove>): TalentWorld {
  return {
    level: world.level,
    getActor: (id) => world.getActor(id),
    actorAt: (x, y) => world.actorAt(x, y),
    allActors: () => world.allActors(),
    tryMove: (id, dir) => {
      const before = world.getActor(id);
      const from = before === undefined ? undefined : { x: before.x, y: before.y };
      const result = world.tryMove(id, dir);
      if (!result.ok || from === undefined) return result;

      // First step wins the `from`; every later step only advances `to`. The
      // caster of Fog Step takes three steps and the client is told one hop.
      const seen = into.get(id);
      into.set(id, { id, from: seen?.from ?? from, to: { x: result.x, y: result.y } });
      return result;
    },
  };
}

/** Drop the round trips: a body that ended where it began did not move. */
function netMoves(recorded: Map<string, ActorMove>): readonly ActorMove[] {
  const out: ActorMove[] = [];
  for (const move of recorded.values()) {
    if (move.from.x === move.to.x && move.from.y === move.to.y) continue;
    out.push(move);
  }
  return out;
}

/**
 * Resolve one talent activation.
 *
 * THE ORDER BELOW IS THE REFUND RULE AND IT IS LOAD-BEARING:
 *
 *   check (pure) → body (may refuse) → THEN spend AP/MP/resource/cooldown
 *
 * Nothing is deducted until after the last thing that can fail, so an intent
 * that went illegal between submission and resolution — the target died, you
 * were shoved out of range — costs exactly zero and re-prompts. Spending first
 * and refunding on failure would mean two code paths that must agree about what
 * was taken, and they will not.
 *
 * IT DOES NOT SPEND ENERGY (D1: `spendTurn` in the scheduler is the only
 * spender) and IT EMITS NO EVENTS (only the scheduler knows whether this was a
 * player action or part of a batched monster sweep).
 */
export function useTalent(
  engine: TalentEngine,
  actor: TalentActor,
  talentId: string,
  target: TalentTarget,
  ctx: TalentCallCtx,
): TalentUseResult {
  const talent = engine.registry.get(talentId);
  if (talent === undefined) return { ok: false, reason: TalentRefusal.UnknownTalent };

  const refusal = canUseTalent(engine, actor, talent, target, ctx.world);
  if (refusal !== null) return { ok: false, reason: refusal };

  // Re-read the sheet rather than threading it out of `canUseTalent`: that
  // function must stay pure and returning state from a predicate is how a
  // predicate stops being one.
  const sheet = engine.sheetOf(actor.id);
  if (sheet === undefined) return { ok: false, reason: TalentRefusal.NotLearned };

  // ═══ THE BODY RUNS AGAINST A WORLD THAT WRITES DOWN WHO IT MOVED ═══
  // `recordingWorld` delegates every method, `tryMove` included, so this is not
  // a second mover — it is the same one with a notebook. See `ActorMove`: three
  // talents reposition bodies and the wire was never told, so the caster of Fog
  // Step was drawn on the tile she left, permanently.
  //
  // ═══ A REFUSAL CARRIES NO `moved`, AND THAT IS CHECKED, NOT ASSUMED ═══
  // The refusal shape stays exactly what it was, because a refusal takes the
  // refund path and emits no `Effect` for a move to ride on. That is only safe
  // while no talent shoves somebody and THEN refuses — and none does: Fog Step
  // is the only one that refuses after calling a mover, and it refuses on
  // `moved === 0`, which is precisely the case where nothing was recorded. If a
  // future talent breaks that, it has to grow an `Effect` of its own anyway.
  //
  // ═══ AND AT A LEVEL THE BODY DOES NOT HAVE TO GO LOOKING FOR ═══
  // Computed here, once, from the sheet re-read three lines above. The
  // alternative — every body calling `getTalentLevelRaw(engine.sheetOf(self.id),
  // <its own id>)` — would put the talent's own id inside the talent twice
  // (once in `id`, once in the lookup) and give twelve files a chance to look
  // up the wrong one. There is no observable level anywhere else: what a talent
  // resolved at is what this line said.
  const recorded = new Map<string, ActorMove>();
  const scoped: TalentCtx = {
    ...ctx,
    world: recordingWorld(ctx.world, recorded),
    talentLevel: getTalentLevelRaw(sheet, talent.id),
  };
  // A PASSIVE HAS NO BODY. Checked here rather than at submission for the reason
  // `canAttack` gives about resolution-time legality — and note it costs nothing:
  // the payment block is below this line, not above it.
  const body = talent.onUse;
  if (body === undefined) return { ok: false, reason: TalentRefusal.Passive };
  const outcome = body(scoped, actor, target);
  if (!outcome.ok) return { ok: false, reason: outcome.reason };

  // --- past this line nothing can fail, so now we pay -----------------------
  const apSpent = talent.cost.ap ?? 0;
  const mpSpent = talent.cost.mp ?? 0;
  const resourceSpent = talent.cost.resource ?? 0;
  sheet.ap -= apSpent;
  sheet.mp -= mpSpent;
  spendResource(sheet.resource, resourceSpent);
  // engine/actor.ts owns the store AND the once-per-game-turn decrement.
  setCooldown(actor, talent.id, talent.cooldownTurns);

  return {
    ok: true,
    talentId: talent.id,
    hits: outcome.hits,
    notes: outcome.notes,
    moved: netMoves(recorded),
    apSpent,
    mpSpent,
    resourceSpent,
    cooldownTurns: talent.cooldownTurns,
  };
}

// ---------------------------------------------------------------------------
// Helpers the twelve share
// ---------------------------------------------------------------------------

/** The combat sheet, or ToME's defaults for everything it omits. */
export function combatOf(actor: TalentActor): CombatSheet {
  return actor.combat ?? {};
}

/**
 * The LIVING actor a Single / Ally shape landed on, or undefined.
 *
 * Id first, tile second. The id is what the client actually clicked, and by the
 * time the intent resolves the body it named may have been shoved off that
 * tile — resolving by tile alone is how a shove turns "attack the wraith" into
 * "attack whoever stepped into the wraith's square", which is the refund rule's
 * commonest trigger dressed up as a targeting bug.
 */
export function targetActor(world: TalentWorld, target: TalentTarget): TalentActor | undefined {
  const byId = target.actorId === undefined ? undefined : world.getActor(target.actorId);
  const found = byId ?? world.actorAt(target.x, target.y);
  return found !== undefined && found.alive ? found : undefined;
}

/** Are these two on opposite sides? M3 factions are players vs monsters. */
export function isEnemy(a: Sided, b: Sided): boolean {
  // THE SECOND COPY OF `a.kind !== b.kind`, now delegating. It was invisible to
  // a grep for `isHostile` and it feeds `pullAggro` and `resolveGuardCounter`,
  // both of which come right for free. See `areEnemies` in engine/actor.ts.
  return areEnemies(a, b);
}

/** Same side. True for yourself — bracing is guarding yourself. */
export function isFriend(a: Sided, b: Sided): boolean {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * A TOWNSFOLK IS NOBODY'S FRIEND EITHER, AND THAT IS NOT PEDANTRY.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `areEnemies` takes her out of the fight on one side; this takes her out on
   * the other. Without it `a.kind === b.kind` makes a shopkeeper the ALLY of
   * every husk in the game — she is a `Monster` — and the Ally affinity is not
   * decoration: Iron Curtain guards the worst-off adjacent friend and pulls
   * their hunters onto the Watchman. A husk standing next to Merrow would have
   * counted as somebody to protect.
   *
   * Read the other way it is just as wrong. If she is a `Player`'s ally she is
   * healable, guardable, and counted in the party's own arithmetic — a body the
   * Alchemist is obliged to keep alive, in a party nobody invited her to.
   *
   * SHE IS NEITHER. Not an enemy, not an ally, simply not a participant — which
   * is the honest shape of a person standing behind a counter while a fight goes
   * on somewhere else.
   */
  if (a.faction === Faction.Townsfolk || b.faction === Faction.Townsfolk) return false;
  return a.kind === b.kind;
}

/**
 * CHEBYSHEV proximity — the "adjacent" / "nearby" test, NOT the range test.
 *
 * combat.ts explains the two metrics: Euclidean for every range, radius and
 * targeting ring (`core.fov.distance`), Chebyshev for adjacency and A* step
 * costs. This is the second one, and it is only ever used for "is this thing
 * standing next to me", where a diagonal genuinely is adjacent.
 */
export function withinTiles(a: TileXY, b: TileXY, tiles: number): boolean {
  return chebyshev(a, b) <= tiles;
}

/**
 * The extra damage multiplier a Marked target eats — the Inspector's Sigil made
 * mechanical.
 *
 * Every talent that deals damage folds this in (`talentAttack`, `talentProject`)
 * and so does the BASIC WEAPON SWING — `strike` in engine/scheduler.ts reads it
 * through the `TalentResolution.markMultiplier` seam and folds it into
 * `AttackOpts.mult`. That covers both the `Attack` intent and the move bump,
 * which are the same function.
 *
 * ═══ IT DID NOT, AND SIGIL'S PANEL WAS LYING ABOUT IT ═══
 * This note used to end "basic bump attacks ... will pick it up when M3 wiring
 * replaces that placeholder with `attackTarget`; that is one call site, not a
 * system." The placeholder WAS replaced and the mark was not carried over, so
 * for the whole of that build a marked husk took byte-identical damage from a
 * bump at every rank of Sigil — while sigil.ts's `describe` promised "everyone —
 * not just you — deals +N% damage to it" and the panel diffed that number
 * per-rank. The party's free, at-will, most-used damage was the one thing the
 * mark did not touch.
 *
 * ═══ WHAT IT STILL DOES NOT COVER, STATED RATHER THAN LEFT TO BE FOUND ═══
 * A TRAVELLING ORB. `fire`/`stepProjectile` freeze the damage integer at the
 * muzzle (ActorProject.lua:353 does the same) and the impact never re-enters
 * `attackTarget`, so a mark applied while the orb is in flight does not touch
 * it. That is a consequence of the frozen-at-fire rule rather than an oversight,
 * and the only shooter in the game is a monster.
 */
export function markMultiplier(engine: TalentEngine, targetId: string): number {
  const mark = engine.effectOn(targetId, TalentEffect.Marked);
  if (mark === undefined) return 1;
  const PERCENT = 100;
  return 1 + mark.power / PERCENT;
}

/** The unit direction from `from` toward `to`, or null when they coincide. */
export function dirToward(from: TileXY, to: TileXY): Dir | null {
  const dx = Math.sign(to.x - from.x);
  const dy = Math.sign(to.y - from.y);
  if (dx === 0 && dy === 0) return null;
  for (const dir of DIR_ORDER) {
    const vector = DIR_VECTORS[dir];
    if (vector.dx === dx && vector.dy === dy) return dir;
  }
  return null;
}

/**
 * Walk an actor up to `tiles` steps toward a destination, stopping at the first
 * blocked step. Returns how many steps actually happened.
 *
 * ═══ IT GOES THROUGH `world.tryMove` ═══
 * world.ts is emphatic that `tryMove` is "the ONLY thing in the process allowed
 * to change a position", because terrain, occupancy and the corner-cutting rule
 * are decided in exactly one place. A knockback or a blink that wrote `actor.x`
 * directly would be a second mover, and the first thing it would get wrong is
 * shoving somebody into a wall.
 *
 * The consequence, stated plainly: a "teleport" here is a walk. With
 * `requiresLos` on the targeting, the only observable difference is around a
 * pillar, and the cost of the alternative is a second position writer.
 */
export function stepToward(
  world: TalentWorld,
  actor: TalentActor,
  destination: TileXY,
  tiles: number,
): number {
  let moved = 0;
  for (let i = 0; i < tiles; i += 1) {
    if (actor.x === destination.x && actor.y === destination.y) break;
    const dir = dirToward(actor, destination);
    if (dir === null) break;
    if (!world.tryMove(actor.id, dir).ok) break;
    moved += 1;
  }
  return moved;
}

/** Shove `victim` directly away from `origin`. Returns tiles actually moved. */
export function knockback(
  world: TalentWorld,
  victim: TalentActor,
  origin: TileXY,
  tiles: number,
): number {
  let moved = 0;
  for (let i = 0; i < tiles; i += 1) {
    const dir = dirToward(origin, victim);
    if (dir === null) break;
    if (!world.tryMove(victim.id, dir).ok) break;
    moved += 1;
  }
  return moved;
}

/**
 * The tiles a Cross covers: the centre plus four orthogonal arms of length
 * `arms` — protocol.ts's `TalentShape.Cross` uses exactly that wording, so the
 * client's shape preview and this list are describing the same five (or nine,
 * or thirteen) tiles.
 *
 * It takes the arm length rather than hard-coding 1 so that bumping a talent's
 * `radius` cannot make the preview and the damage disagree — which would be a
 * bug the player experiences as "the vial hit something outside the highlight".
 *
 * FIXED ORDER: centre, then north, east, south, west, outward. Damage is
 * applied in this order, so the RNG draws happen in this order, so a replay
 * cannot diverge because two monsters swapped tiles.
 */
const CROSS_ARMS = [DIR_VECTORS.n, DIR_VECTORS.e, DIR_VECTORS.s, DIR_VECTORS.w] as const;

export function crossTiles(centre: TileXY, arms = 1): readonly TileXY[] {
  const tiles: TileXY[] = [centre];
  for (const vector of CROSS_ARMS) {
    for (let out = 1; out <= arms; out += 1) {
      tiles.push({ x: centre.x + vector.dx * out, y: centre.y + vector.dy * out });
    }
  }
  return tiles;
}

/**
 * The tiles a Ball covers — a CIRCULAR cut, not a square.
 *
 * Euclidean, matching `core.fov.distance` and ToME's `type="ball"` targeting.
 * A Chebyshev ball of radius 2 is a 5x5 square that reaches 2.83 tiles into its
 * corners, which is 40% more area than the ring the client draws. The
 * mismatch shows up as a heal that visibly did not reach someone standing
 * inside the circle, which is the worst possible place for it to show up.
 *
 * Row-major order, so the tile list — and therefore the RNG draw order of
 * anything applied to it — is identical on every machine.
 */
export function ballTiles(centre: TileXY, radius: number): readonly TileXY[] {
  const tiles: TileXY[] = [];
  const span = Math.floor(radius);
  for (let dy = -span; dy <= span; dy += 1) {
    for (let dx = -span; dx <= span; dx += 1) {
      const tile = { x: centre.x + dx, y: centre.y + dy };
      if (combatDistance(centre, tile) <= radius) tiles.push(tile);
    }
  }
  return tiles;
}

/**
 * Everything a shape lands on, filtered by affinity.
 *
 * `Affinity.Hostile` is the one that matters: game-design.md § 10 states it
 * flatly — **player AoE does not damage allies**, and there is no PvP, ever.
 * Monster-on-monster chains keep friendly fire (`index_glut.json` already
 * declares `bomb_aoe_hits_enemies: true`), which is why this filters by side
 * rather than by "is a player".
 */
export function actorsInShape(
  world: TalentWorld,
  self: TalentActor,
  tiles: readonly TileXY[],
  affinity: Affinity,
): readonly TalentActor[] {
  const found: TalentActor[] = [];
  for (const tile of tiles) {
    const actor = world.actorAt(tile.x, tile.y);
    if (actor === undefined || !actor.alive) continue;
    if (found.some((seen) => seen.id === actor.id)) continue;
    if (affinity === Affinity.Hostile && !isEnemy(self, actor)) continue;
    if (affinity === Affinity.Ally && actor.kind !== self.kind) continue;
    found.push(actor);
  }
  return found;
}

/**
 * A weapon swing with a talent multiplier — Combat.lua:546's `mult`.
 *
 * Delegates the entire ordered pipeline to combat.ts / damage.ts: to-hit, then
 * the damage range rolled BEFORE armour, then armour/hardiness, then the crit
 * AFTER armour, then the multiplier, then the projector. Not one line of that
 * ordering is repeated here, which is the point — the order IS the balance and
 * it exists in exactly one function.
 *
 * `skipLegality` is passed because `canUseTalent` already ran; it means "I
 * already asked", not "let me shoot through a wall".
 */
export function talentAttack(
  // `TalentCallCtx`, not `TalentCtx`: this helper multiplies whatever `mult` it
  // is handed and never asks what level produced it. Typing it at the narrower
  // shape is what lets `resolveGuardCounter` — which has no talent and
  // therefore no level — call it without inventing one.
  ctx: TalentCallCtx,
  self: TalentActor,
  victim: TalentActor,
  opts: { readonly mult: number; readonly damtype?: DamageType; readonly critBonus?: number },
): TalentHit {
  const result = attackTarget(self, victim, ctx.world, ctx.rng, {
    mult: opts.mult * markMultiplier(ctx.engine, victim.id),
    damtype: opts.damtype,
    critBonus: opts.critBonus,
    skipLegality: true,
  });

  if (!result.ok) {
    return {
      targetId: victim.id,
      hit: false,
      damage: 0,
      healed: 0,
      crit: false,
      killed: false,
      type: opts.damtype ?? DamageType.Physical,
    };
  }

  // NO `noteKill` HERE — see `TalentEngine.noteKill`. The scheduler's
  // `noteCasualty` pays for every kill in the game from one place; paying here
  // as well would hand an Alchemist two reagents for one body the moment the
  // scheduler seam was wired, and paying ONLY here is what left her basic swing
  // earning nothing.
  return {
    targetId: victim.id,
    hit: result.hit,
    damage: result.damage,
    healed: 0,
    crit: result.crit,
    killed: result.killed,
    type: result.type,
  };
}

/**
 * Damage that does not roll to hit — the caster path.
 *
 * ToME's spells never call `checkHit`: `Flame` (spells/fire.lua:21-45) and
 * `Throw Bomb` (spells/explosives.lua:21-50) both go straight to
 * `DamageType:get(…).projector`. Reproducing that is what makes the Alchemist
 * feel different from the Inspector — reliable damage gated by a countable
 * stock, rather than accurate damage gated by a die.
 *
 * It also skips the ARMOUR stage, again faithfully: `attackTargetWith` is the
 * only thing in ToME that applies armour, so a spell has never been reduced by
 * armour in the game's history (damage.ts's `DamageSpec` doc says so).
 */
export function talentProject(
  // See `talentAttack` — the level is already folded into `mult` by the caller.
  ctx: TalentCallCtx,
  self: TalentActor,
  victim: TalentActor,
  base: number,
  type: DamageType,
  mult: number,
): TalentHit {
  const outcome = applyDamage(victim, base, type, self, ctx.rng, {
    mult: mult * markMultiplier(ctx.engine, victim.id),
    increase: combatOf(self).increase,
    penetration: combatOf(self).penetration,
  });
  // NO `noteKill` HERE either, for the reason on `talentAttack` above.
  return {
    targetId: victim.id,
    hit: true,
    damage: outcome.dealt,
    healed: 0,
    crit: outcome.crit,
    killed: outcome.killed,
    type,
  };
}

/** The base damage a caster talent multiplies. See `talentAttack`'s note. */
export function talentBaseDamage(self: TalentActor): number {
  return combatDamage(combatOf(self));
}

/** Restore HP, clamped at max. Returns what was actually restored. */
export function healActor(target: TalentActor, amount: number): number {
  if (!target.alive || amount <= 0) return 0;
  const before = target.hp;
  target.hp = Math.min(target.maxHp, target.hp + amount);
  return target.hp - before;
}

/**
 * ToME's `Taunt` (gifts/summon-utility.lua:29-38): `a:setTarget(self)`.
 *
 * THE GUARD THAT ACTUALLY PROTECTS AN ALLY, with no new hook anywhere. The AI
 * in src/server/ai/npc.ts already reads `ai.targetId` and already keeps it
 * across turns (ToME's 90% hysteresis, ai/simple.lua:253) — which is exactly
 * what makes a taunt stick for more than one tick instead of being re-decided
 * the instant it lands.
 *
 * @returns how many hostiles were pulled.
 */
export function pullAggro(
  world: TalentWorld,
  onto: TalentActor,
  filter: (hostile: TalentActor) => boolean,
): number {
  let pulled = 0;
  for (const other of world.allActors()) {
    if (!other.alive || !isEnemy(onto, other)) continue;
    const ai = other.ai;
    if (ai === undefined || !filter(other)) continue;
    ai.targetId = onto.id;
    pulled += 1;
  }
  return pulled;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE PUNISH: an enemy that hits a guarded ally eats a free counter.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Iron Curtain installs `TalentEffect.Guarding` on the WATCHMAN, naming the
 * ally. This function is the other half: given a blow that just landed on
 * somebody, it finds whoever is guarding them and swings back.
 *
 * WIRING — IT IS WIRED, and the call site is not in this module. This docblock
 * used to describe the wiring as future work ("when M3 wiring replaces that
 * placeholder with `attackTarget`") and that description outlived the
 * placeholder: `strike` was rewritten onto `attackTarget` and the counter line
 * was never added, so this function shipped with ZERO production callers while
 * iron_curtain.ts's `describe` advertised its per-rank curve in the talent
 * panel. One of the two things a point in Iron Curtain bought could not be
 * observed by any means.
 *
 * TODAY: `noteGuardCounter` (engine/scheduler.ts) calls this through the
 * `TalentResolution.guardCounter` seam, from BOTH lanes, immediately after a
 * landed weapon blow — and re-enters `noteBlows`/`noteCasualty` with the
 * GUARDIAN as the killer, so a counter that finishes a husk pays the Watchman's
 * reagent and his party's experience rather than the husk's.
 *
 * It lives here rather than there because the guard table lives here, and
 * because engine/scheduler.ts adds its line without learning what a talent is.
 *
 * TWO GUARDS: the counter needs REACH (you cannot punish something on the far
 * side of the room) and the guardian must be alive. Both are checked here so
 * the call site stays one line.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE MULTIPLIER COMES OFF THE EFFECT, NOT OFF A CONSTANT IN THIS FILE.
 * ═══════════════════════════════════════════════════════════════════════════
 * It used to be `GUARD_COUNTER_MULT = 0.7`, a module constant, which was fine
 * while every Iron Curtain in the game was identical. It no longer is: the
 * talent has a level, and a counter that ignored it would be the one part of
 * Iron Curtain that a talent point did nothing to.
 *
 * So iron_curtain.ts SNAPSHOTS its scaled multiplier onto the `Guarding`
 * instance's `power` at cast time, and this reads it back. `markMultiplier`
 * (above) is the precedent — the mark's bonus has always ridden on `power` for
 * exactly this reason, and a mark already burning does not change when the
 * Inspector levels.
 *
 * ═══ AND THIS FUNCTION STILL DOES NOT KNOW WHAT IRON CURTAIN IS ═══
 * Deliberately no talent id anywhere in it, and no `registry.get`. This module
 * must never learn the string `talent:iron_curtain` — see the registry-cycle
 * note on `Talent` — so the effect instance is the ONLY channel by which a
 * talent's numbers reach a counter the scheduler triggers.
 *
 * @returns the counter-swing and who threw it, or null when nobody was guarding.
 */
export function resolveGuardCounter(
  ctx: TalentCallCtx,
  attackerId: string,
  victimId: string,
): GuardCounter | null {
  const attacker = ctx.world.getActor(attackerId);
  if (attacker === undefined || !attacker.alive) return null;

  for (const guardian of ctx.world.allActors()) {
    if (!guardian.alive || guardian.id === victimId) continue;
    const guard = ctx.engine.effectOn(guardian.id, TalentEffect.Guarding);
    if (guard === undefined || guard.otherId !== victimId) continue;
    if (!isEnemy(guardian, attacker)) continue;
    // Reach. `attackRange` is the M2 placeholder; a melee guardian is 1.
    if (chebyshev(guardian, attacker) > (guardian.attackRange ?? 1)) continue;
    return {
      guardianId: guardian.id,
      hit: talentAttack(ctx, guardian, attacker, { mult: guard.power }),
    };
  }
  return null;
}

/**
 * Strip a slice of a target's action budget — the authored `debuff_ap` effect
 * (`content/skills/lockdown.json`, `{ type: "debuff_ap", value: 2 }`).
 *
 * MONSTERS HAVE NO AP. They run ToME's variable-speed model on the act clock
 * (engine/actor.ts's player/monster asymmetry), so "two action points" has to
 * be expressed in the currency they actually spend: `ENERGY_TO_ACT * ap /
 * maxAp`. Two of six AP is a third of a turn, and stacking it delays the next
 * monster action by exactly that much.
 *
 * It touches the ACT clock and never `energyBase`. Draining the base clock
 * would shorten the target's cooldowns and debuffs, which is the same class of
 * bug as letting haste do it — see this file's header.
 */
export function drainActionBudget(target: TalentActor, apPoints: number, maxAp: number): number {
  const energy = target.energy;
  if (typeof energy !== 'number' || apPoints <= 0 || maxAp <= 0) return 0;
  const cost = (ENERGY_TO_ACT * apPoints) / maxAp;
  const drained = Math.min(energy, cost);
  target.energy = energy - drained;
  return drained;
}
