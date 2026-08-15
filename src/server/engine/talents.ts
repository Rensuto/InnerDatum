// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/engines/default/engine/interface/ActorTalents.lua:824-826 (getTalentLevel)
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
 * WHAT IS DELIBERATELY NOT HERE
 * ───────────────────────────────────────────────────────────────────────────
 *  - TREES, TALENT POINTS, MASTERY, LEVELLING. PLAN.md § 5 caps MVP at 12
 *    talents / 0 trees / 0 points / fixed loadouts; M6 owns progression. With
 *    no points there is no curve to walk, so all twelve use the multipliers
 *    AUTHORED in `content/skills/*.json` — game-design.md § 2 says values in
 *    brackets are "the authored source numbers, ported verbatim", and 0.8 /
 *    1.65 / 1.3 are exactly those. `MVP_TALENT_LEVEL` and the ToME scaling
 *    helpers below are the seam for the day points land.
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

import { DIR_ORDER, DIR_VECTORS, chebyshev } from '../../shared/coords.ts';
import { ENERGY_TO_ACT } from '../../shared/version.ts';
import { bound, rescaleDamage } from '../../shared/scale.ts';
import { hasLineOfSight } from '../world/world.ts';
import { cooldownOf, setCooldown } from './actor.ts';
import { attackTarget, combatDistance } from './combat.ts';
import { DamageType, applyDamage } from './damage.ts';
import { combatDamage } from './derived.ts';
import type { Dir, TileXY } from '../../shared/coords.ts';
import type { ActorKind, LevelView } from '../../shared/protocol.ts';
import type { Rng } from '../../shared/rng.ts';
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
 * The three class resources, and the one that is not a bar.
 *
 * REAGENTS ARE A COUNTABLE STOCK OF 0-8 THAT REFILLS ON KILLS AND AT STAIRS —
 * not a regenerating pool (game-design.md § 2). That distinction is the whole
 * Alchemist: every cast is a discrete decision about a finite object you are
 * holding, and the UI renders it as pips rather than a bar
 * (docs/assets-needed.md, `ui_pip_reagent_{full,empty}`). `RESOURCE_RULES`
 * below encodes it as `regenPerTurn: 0`, so nothing can quietly turn it into a
 * bar by adding a regen number in one place.
 */
export const ResourceKind = {
  /** Watchman. Builds when struck and when standing next to an ally. */
  Resolve: 'resolve',
  /** Inspector. Builds by holding still and by watching a marked target. */
  Focus: 'focus',
  /** Alchemist. COUNTABLE. Refills on kills and at stairs. Never regenerates. */
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
 * The effective talent level every MVP talent resolves at.
 *
 * MVP has fixed loadouts and no talent points, so this is a constant rather
 * than a lookup. It is pinned at 1 and NOT at 5 because the ToME curves are
 * fitted with `y(1) = low`, and pretending a level-1 character has a
 * fully-trained talent would make the first playtest read as an easy game.
 *
 * ═══ IT IS STILL PASSED THROUGH THE CURVES ═══
 * Every helper that takes a talent level takes THIS, rather than the curve
 * being collapsed to its `low` endpoint by hand. When M6 adds points, the call
 * sites already have the right shape and the numbers move on the right curve —
 * and `getTalentLevel` (ActorTalents.lua:824-826) multiplies raw points by
 * category mastery, so the value is NOT clamped at 5 when it lands.
 */
export const MVP_TALENT_LEVEL = 1;

// ---------------------------------------------------------------------------
// Talent-level damage helpers
// ---------------------------------------------------------------------------

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
       * All three are 0 today and that is the point: nothing in this game gives
       * you a resource for existing. Resolve is earned by standing next to
       * people, Focus by holding still, Reagents by killing something.
       */
      readonly regenPerTurn: number;
      /**
       * Draw PIPS, not a bar — `ResourceView.discrete` on the wire.
       *
       * game-design.md § 2 is emphatic: Reagents are "a countable stock of 0-8
       * ... not a regenerating bar. Every cast is a discrete decision." A bar
       * makes 3-of-8 look like 37% of something continuous and quietly deletes
       * the Alchemist's whole read. Authored HERE rather than derived from the
       * kind in the renderer, because a client-side copy of "which kinds are
       * countable" is exactly the table that will be missing the Enforcer's
       * Shells at M5.
       */
      readonly discrete: boolean;
    }
  >
> = {
  [ResourceKind.Resolve]: { max: 100, start: 0, regenPerTurn: 0, discrete: false },
  [ResourceKind.Focus]: { max: 100, start: 0, regenPerTurn: 0, discrete: false },
  // 0-8, COUNTABLE. Starts full: you walked in carrying eight vials, and the
  // first fight should be about spending them rather than about waiting.
  [ResourceKind.Reagents]: { max: 8, start: 8, regenPerTurn: 0, discrete: true },
};

/**
 * Resolve builds when struck (game-design.md § 2).
 *
 * WIRING: the scheduler calls `gainResolveOnStruck` from the same place it
 * applies damage to a player. Until that lands the Watchman still builds from
 * the adjacency clause below, which is the half that rewards standing with the
 * party — the co-op half.
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
};

export function createResourcePool(kind: ResourceKind): ResourcePool {
  const rules = RESOURCE_RULES[kind];
  return { kind, value: rules.start, max: rules.max };
}

export function hasResource(pool: ResourcePool, amount: number): boolean {
  return pool.value >= amount;
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
  /** Magnitude, where the effect has one. Marked's bonus, in percent. */
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
  /** The ACT clock. Read-modify-written ONLY by Lockdown; see the note there. */
  energy?: number;
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
  /** Tiles, EUCLIDEAN (`core.fov.distance`) — see combat.ts's note on metrics. */
  readonly range: number;
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

/** Everything a talent body is handed. One object, so signatures stay short. */
export type TalentCtx = {
  readonly engine: TalentEngine;
  readonly world: TalentWorld;
  /** The world's seeded stream. Every draw carries a label. */
  readonly rng: Rng;
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

/** Why a talent never happened. NEVER a miss — a miss is `hit: false`. */
export const TalentRefusal = {
  UnknownTalent: 'unknown_talent',
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
  /** THE body. Synchronous — targeting already arrived with the command. */
  readonly onUse: (ctx: TalentCtx, self: TalentActor, target: TalentTarget) => TalentOutcome;
  /**
   * One line for the hotbar tooltip, rendered SERVER-SIDE.
   *
   * The client never computes a displayed number — eslint's
   * `NO_COMBAT_MATH_PATTERNS` blocks it from even importing the formulas, and a
   * second copy of a formula always diverges.
   */
  readonly describe: (self: TalentActor) => string;
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
 * A player's class state: the FIXED loadout, the resource pool and the
 * intra-turn budget.
 *
 * ZERO talent points and ZERO trees (PLAN.md § 5's hard cap). `loadout` is
 * exactly four ids, chosen at character creation and never edited, which is why
 * it is `readonly` — M6 is where it stops being.
 */
export type TalentSheet = {
  readonly classId: ClassId;
  readonly loadout: readonly string[];
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
  readonly classId: ClassId;
  readonly loadout: readonly string[];
  readonly resource: ResourceKind;
  readonly maxAp: number;
  readonly maxMp: number;
};

export function createTalentSheet(init: TalentSheetInit): TalentSheet {
  return {
    classId: init.classId,
    loadout: [...init.loadout],
    resource: createResourcePool(init.resource),
    ap: init.maxAp,
    maxAp: init.maxAp,
    mp: init.maxMp,
    maxMp: init.maxMp,
    movedThisTurn: false,
  };
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
  actBase(actorId: string, world: TalentWorld): void;

  /** A kill happened. Reagents are a stock and this is half of how it refills. */
  noteKill(killerId: string): void;
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

    actBase: (actorId: string, world: TalentWorld): void => {
      tickEffects(effects, actorId);
      const sheet = sheets.get(actorId);
      if (sheet === undefined) return;
      const actor = world.getActor(actorId);
      if (actor === undefined || !actor.alive) return;
      regenResource(engine, sheet, actor, world);
      sheet.ap = sheet.maxAp;
      sheet.mp = sheet.maxMp;
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
    case ResourceKind.Reagents:
      // COUNTABLE STOCK. Refills on kills (`noteKill`) and at stairs
      // (`noteStairs`) and at NO other time. If a regen line ever appears here,
      // the Alchemist has quietly become a mana class and every cast has
      // stopped being a decision.
      return;
  }
}

// ---------------------------------------------------------------------------
// Legality — the pure predicate half of the refund rule
// ---------------------------------------------------------------------------

/**
 * Can this actor use this talent on this target, RIGHT NOW?
 *
 * Pure: it reads the world and mutates nothing. That is what lets the scheduler
 * call it at resolution time (the refund rule) and the projector call it to
 * grey out a hotbar slot, with no chance of the two disagreeing.
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

  return checkTargeting(actor, talent.targeting, target, world);
}

/** Range, dead zone, line of sight, and who is standing there. */
function checkTargeting(
  actor: TalentActor,
  targeting: TalentTargeting,
  target: TalentTarget,
  world: TalentWorld,
): TalentRefusal | null {
  if (targeting.shape === TargetShape.Self) return null;

  // EUCLIDEAN, matching `core.fov.distance` and every other range in the game.
  // A Chebyshev ring is a square that reaches 7.07 tiles into its corners, and
  // the targeting UI draws a circle (combat.ts documents the two metrics).
  const distance = combatDistance(actor, target);
  if (distance > targeting.range) return TalentRefusal.OutOfRange;

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
  if (targeting.affinity === Affinity.Hostile && victim.kind === actor.kind) {
    return TalentRefusal.NotHostile;
  }
  if (targeting.affinity === Affinity.Ally && victim.kind !== actor.kind) {
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
      readonly apSpent: number;
      readonly mpSpent: number;
      readonly resourceSpent: number;
      readonly cooldownTurns: number;
    };

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
  ctx: TalentCtx,
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

  const outcome = talent.onUse(ctx, actor, target);
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
export function isEnemy(a: TalentActor, b: TalentActor): boolean {
  return a.kind !== b.kind;
}

/** Same side. True for yourself — bracing is guarding yourself. */
export function isFriend(a: TalentActor, b: TalentActor): boolean {
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
 * Every talent that deals damage folds this in, so the mark is LIVE for all
 * talent damage today. Basic bump attacks go through the scheduler's own strike
 * path and will pick it up when M3 wiring replaces that placeholder with
 * `attackTarget`; that is one call site, not a system.
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
  ctx: TalentCtx,
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

  if (result.killed) ctx.engine.noteKill(self.id);
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
  ctx: TalentCtx,
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
  if (outcome.killed) ctx.engine.noteKill(self.id);
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
 * WIRING — ONE CALL SITE, and it is not in this module. The scheduler applies
 * monster damage in `strike` (engine/scheduler.ts, still the M2 placeholder).
 * When M3 wiring replaces that placeholder with `attackTarget`, the counter
 * goes in immediately after the hit lands:
 *
 * ```ts
 * const counter = resolveGuardCounter(talentCtx, attacker.id, target.id);
 * if (counter !== null) sink.sweep(gameTurn, { t: 'attack', id: guardian, … });
 * ```
 *
 * It lives here rather than there because the guard table lives here, and
 * because engine/scheduler.ts must be able to add the line without learning
 * what a talent is.
 *
 * TWO GUARDS: the counter needs REACH (you cannot punish something on the far
 * side of the room) and the guardian must be alive. Both are checked here so
 * the call site stays one line.
 *
 * @returns the counter-swing, or null when nobody was guarding.
 */
export const GUARD_COUNTER_MULT = 0.7;

export function resolveGuardCounter(
  ctx: TalentCtx,
  attackerId: string,
  victimId: string,
): TalentHit | null {
  const attacker = ctx.world.getActor(attackerId);
  if (attacker === undefined || !attacker.alive) return null;

  for (const guardian of ctx.world.allActors()) {
    if (!guardian.alive || guardian.id === victimId) continue;
    const guard = ctx.engine.effectOn(guardian.id, TalentEffect.Guarding);
    if (guard === undefined || guard.otherId !== victimId) continue;
    if (!isEnemy(guardian, attacker)) continue;
    // Reach. `attackRange` is the M2 placeholder; a melee guardian is 1.
    if (chebyshev(guardian, attacker) > (guardian.attackRange ?? 1)) continue;
    return talentAttack(ctx, guardian, attacker, { mult: GUARD_COUNTER_MULT });
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
