// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/modules/tome/class/Actor.lua:6944-6978 (canBe — immunity)
//                                                        :6980-6986 (save_for_effects)
//                                                        :6988-7043 (on_set_temporary_effect)
//                                                        :525, :597, :606 (the actBase order)
//             t-engine4 game/engines/default/engine/interface/ActorTemporaryEffects.lua:54
//                                                        (`t.decrease = t.decrease or 1`)
//                                                        :74-98  (timedEffects)
//                                                        :100-165 (setEffect)
//                                                        :171-190 (hasEffect / removeEffect)
//             t-engine4 game/modules/tome/class/interface/Combat.lua:275-293 (checkHitOld)
//             t-engine4 game/modules/tome/data/timed_effects/physical.lua:133-141 (CUT on_merge)
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" — https://te4.org/license

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *                      THE STATUS SYSTEM. THE KEYSTONE OF M4.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Three things in this file are the reason it exists, and every one of them is
 * invisible when it is wrong:
 *
 *   1. PARTIAL-SAVE DURATION SCALING (`rollSaveDuration`, Actor.lua:6999-7014).
 *      A save does TWO things: it can negate outright, AND it scales the
 *      duration that survives. Failing narrowly gives you a SHORTER stun, not a
 *      full one. That is the single mechanic that makes save-boosting gear feel
 *      continuous instead of binary, and it is what the whole combat layer is
 *      arranged around.
 *
 *      docs/tome-mechanics.md § 6 quotes the formula and DROPS the stochastic
 *      rounding at Actor.lua:7011. Without that draw, `desired` truncates and a
 *      3-turn stun against a 68% save is deterministically 1 turn instead of
 *      "1 turn, and 5.6% of the time 2". CLAUDE.md lists this as doc drift #1.
 *      The Lua wins. The expected numbers are pinned in
 *      test/server/effects.test.ts beside this citation.
 *
 *   2. THE EFFECT'S TYPE PICKS THE SAVE (Actor.lua:6981-6986), NOT THE ATTACK
 *      THAT DELIVERED IT. A fire spell that applies a physical Bleed is
 *      resisted by the PHYSICAL save. This is the classic mis-port — the
 *      intuitive version routes the save off the damage type or off the
 *      talent's school, and the symptom is that one class's saves never matter.
 *      `SAVE_FOR_EFFECTS` is a table keyed by `EffectDef.type` and there is no
 *      other path to a save in this file.
 *
 *   3. THE TICK ORDER (ActorTemporaryEffects.lua:74-98). `on_timeout` fires and
 *      THEN the duration is decremented (:91), and an effect is removed on the
 *      tick AFTER its duration reaches 0 (:80-81). So `dur: 1` means "ticks
 *      exactly once". Reverse the two lines and every DoT loses a tick and
 *      every stun is off by one, with no crash and no failing plumbing test.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * IT RUNS ON THE BASE CLOCK, ONCE PER GAME TURN, AT ANY SPEED
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `timedEffects` is called from `actBase` (tome/class/Actor.lua:597) and NEVER from `act`.
 * Nothing in this file may read `globalSpeed` or `speedFactor`: haste grants
 * more ACTIONS and must never shorten a debuff. That is the same invariant
 * engine/actor.ts and engine/talents.ts already carry, restated because a
 * status system is exactly where somebody would be tempted to break it.
 *
 * SYNCHRONOUS AND DETERMINISTIC. No I/O, no clock, no `Math.random`. Every draw
 * takes a label. The engine's six anti-async AST selectors apply here.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY A SIDE TABLE AND NOT A FIELD ON `EngineActor`
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Same argument engine/talents.ts makes for its own effect table, and the same
 * answer: nothing here is DUPLICATED state. It is strictly additive, keyed by
 * actor id, and `forgetActor` is called from the one place actors are removed.
 * The two exceptions — the derived `flags` on the combat sheet and a monster's
 * `globalSpeed` — are written THROUGH this module and recomputed from a stored
 * baseline (`recomputeAttributes`), so there is still exactly one writer.
 *
 * `engine/effects.ts` knows about no particular effect. The three MVP statuses
 * live in `src/server/content/effects.ts` and register themselves here, so the
 * dependency runs `content → engine` and never back.
 */

import { ActorKind } from '../../shared/protocol.ts';
import type { DamageType } from '../../shared/damagetype.ts';
import { reentryHealFraction } from '../../shared/progression.ts';
import { bound, getTierDiff } from '../../shared/scale.ts';
import { recomputeGlobalSpeed } from '../../shared/energy.ts';
import { checkHitOld } from '../../shared/checkhit.ts';
import { combatMentalResist, combatPhysicalResist, combatSpellResist } from './derived.ts';
import { composeSheet, composeWielders, wornOf } from './equipment.ts';
import type { PassiveContribution } from './equipment.ts';
import { setCooldown } from './actor.ts';
import type { Combatant, PrimaryStats, StatusFlags } from './derived.ts';
import type { CombatSheet } from './combat.ts';
import type { ItemCatalogue, Slot } from '../content/items.ts';
import type { Rng } from '../../shared/rng.ts';

// ---------------------------------------------------------------------------
// The three channels — Actor.lua:6980-6986
// ---------------------------------------------------------------------------

/**
 * An effect's TYPE. It picks the save that resists it and (from M5) the cure
 * that removes it — NOT the source of the attack.
 *
 * `magical` rather than ToME's overloaded "spell", because the save getter is
 * `combatSpellResist` and the wire/schema word is `magical`
 * (docs/data-schemas.md `SaveChannel`). The Lua table below keeps ToME's exact
 * pairing so `grep -r save_for_effects reference/t-engine4` still lands.
 */
export const SaveChannel = {
  Physical: 'physical',
  Mental: 'mental',
  Magical: 'magical',
} as const;
export type SaveChannel = (typeof SaveChannel)[keyof typeof SaveChannel];

/** Every channel in a fixed order, for iteration that must be reproducible. */
export const SAVE_CHANNELS: readonly SaveChannel[] = [
  SaveChannel.Physical,
  SaveChannel.Mental,
  SaveChannel.Magical,
] as const;

/** A save getter — one of the three in engine/derived.ts. */
type SaveGetter = (c: Combatant, add?: number) => number;

/**
 * THE TABLE THAT PICKS THE SAVE — Actor.lua:6980-6986, verbatim.
 *
 * ```lua
 * local save_for_effects = {
 *   magical  = "combatSpellResist",
 *   mental   = "combatMentalResist",
 *   physical = "combatPhysicalResist",
 * }
 * ```
 *
 * Actor.lua:7002 is the only place upstream reads it:
 * `local save = self[p.apply_save or save_for_effects[e.type]](self)`. Note the
 * key: `e.type`, the EFFECT DEFINITION's type. Not `p.type`, not the damage
 * type, not the talent's school. `applySave` (`p.apply_save`) is the sole
 * override and it is a per-application parameter, which is how ToME expresses
 * "this one poison is resisted by the mental save".
 */
export const SAVE_FOR_EFFECTS: Readonly<Record<SaveChannel, SaveGetter>> = {
  magical: combatSpellResist,
  mental: combatMentalResist,
  physical: combatPhysicalResist,
};

/** This actor's save against `channel`, already rescaled by `derived.ts`. */
export function saveOf(sheet: Combatant | undefined, channel: SaveChannel): number {
  return SAVE_FOR_EFFECTS[channel](sheet ?? {});
}

// ---------------------------------------------------------------------------
// Status / stacking
// ---------------------------------------------------------------------------

/**
 * Detrimental effects are the ones a save can negate — Actor.lua:7024. A
 * beneficial effect still gets its duration scaled by `apply_power` if one is
 * supplied, but it is NEVER refused, because :7024's whole branch is gated on
 * `e.status == "detrimental"`.
 */
export const EffectStatus = {
  Beneficial: 'beneficial',
  Detrimental: 'detrimental',
} as const;
export type EffectStatus = (typeof EffectStatus)[keyof typeof EffectStatus];

/**
 * What a SECOND application does while the first is still live
 * (docs/data-schemas.md `EffectDef.stackMode`).
 *
 * ToME has only two behaviours here (ActorTemporaryEffects.lua:122-130): call
 * `on_merge` if the definition has one, otherwise remove and re-add — which is
 * a REPLACE, so a fresh 1-turn stun genuinely SHORTENS a 5-turn one. That is
 * upstream behaviour and it is preserved as `Refresh`.
 *
 * `Ignore` has no ToME line. It is authored here for effects that must not be
 * chain-locked by re-application, and it exists in the schema, so it exists
 * here rather than being simulated by a comment in three content files.
 */
export const StackMode = {
  /**
   * REPLACE the live instance outright — ActorTemporaryEffects.lua:128
   * (`self:removeEffect(eff_id, true, true)` then the plain assignment at :132).
   * The new duration wins even when it is shorter.
   */
  Refresh: 'refresh',
  /**
   * Hand both instances to the definition's `onMerge` —
   * ActorTemporaryEffects.lua:123-125. CUT's merge (physical.lua:133-141) is
   * the canonical one and it CONSERVES TOTAL DAMAGE rather than stacking it.
   * With no `onMerge`, durations are summed (capped at `maximum`).
   */
  Stack: 'stack',
  /** A second application does nothing while one is live. Authored, not ported. */
  Ignore: 'ignore',
} as const;
export type StackMode = (typeof StackMode)[keyof typeof StackMode];

// ---------------------------------------------------------------------------
// Immunity — Actor.lua:6944-6978 (`canBe`)
// ---------------------------------------------------------------------------

/**
 * The four blanket immunities at Actor.lua:6956-6960. Each is an `attr` check
 * upstream — present at all and the effect is refused with chance 0 and NO
 * RNG DRAW. Modelled here as reserved keys in the same percentage map as the
 * subtype resistances, checked for `> 0` rather than for a percentage, so a
 * content template has exactly one place to write immunities.
 */
export const ImmunityKey = {
  /** `negative_status_effect_immune` (:6956). Blocks every detrimental effect. */
  AllNegative: 'negative_status_effect_immune',
  /** `physical_negative_status_effect_immune` (:6958). */
  PhysicalNegative: 'physical_negative_status_effect_immune',
  /** `mental_negative_status_effect_immune` (:6959). */
  MentalNegative: 'mental_negative_status_effect_immune',
  /** `spell_negative_status_effect_immune` (:6960). */
  MagicalNegative: 'spell_negative_status_effect_immune',
} as const;
export type ImmunityKey = (typeof ImmunityKey)[keyof typeof ImmunityKey];

const BLANKET_IMMUNITY: Readonly<Record<SaveChannel, ImmunityKey>> = {
  physical: ImmunityKey.PhysicalNegative,
  mental: ImmunityKey.MentalNegative,
  magical: ImmunityKey.MagicalNegative,
};

// ---------------------------------------------------------------------------
// The definition
// ---------------------------------------------------------------------------

/**
 * The typed slice of `EffectDef.modifiers` (docs/data-schemas.md:228) — the
 * attributes an effect grants while it is live.
 *
 * These are what `recomputeAttributes` writes onto the actor. Everything here
 * composes ADDITIVELY across live effects except the booleans, which OR.
 */
export type EffectModifiers = {
  /**
   * Sets `StatusFlags.stunned`. Read by combat.ts:356 as `sourceStunned` and
   * applied as a flat ×0.4 to outgoing damage (damage_types.lua:150-153).
   */
  readonly stunned?: boolean;
  /**
   * Sets `StatusFlags.dazed` — halves accuracy, defence, all three powers and
   * all three saves INSIDE the getters, before the rescale (derived.ts).
   */
  readonly dazed?: boolean;
  /** Sets `StatusFlags.scoured` — the same set divided by 1.2. */
  readonly scoured?: boolean;
  /** Sets `StatusFlags.breached` — halves armour hardiness AFTER the bound. */
  readonly breached?: boolean;
  /**
   * ToME's `no_talents_cooldown` (physical.lua:492). While ANY live effect sets
   * it, tome/class/Actor.lua:606 skips `cooldownTalents()` entirely and the actor's
   * cooldowns FREEZE. This is what makes stun a threat rather than a nuisance.
   */
  readonly noTalentsCooldown?: boolean;
  /**
   * MONSTERS ONLY. Added to the energy GAIN multiplier — ToME's
   * `global_speed_add` (physical.lua:632, `-eff.power`). NEGATIVE slows.
   *
   * ═══ THIS IS THE GAIN KNOB, NOT THE COST KNOB ═══
   * `globalSpeed` scales what a monster GAINS per tick; `speedFactor` scales
   * what an action COSTS it (engine/actor.ts). ToME's SLOW moves the gain,
   * so this does too. Anyone reaching for `speedFactor` instead must ADD to it,
   * because a smaller cost multiplier makes the monster FASTER — the exact
   * inversion derived.ts warns about at `combatSpeed`.
   *
   * Players are excluded by D1: `PlayerActor.globalSpeed` is the literal type
   * `1` and readonly. A slow on a player spends `apPenalty` / `mpPenalty`
   * instead — see `budgetPenalty` and the asymmetry note in content/effects.ts.
   */
  readonly globalSpeedAdd?: number;
  /** PLAYERS ONLY (D1). Points removed from the AP refill each game turn. */
  readonly apPenalty?: number;
  /** PLAYERS ONLY (D1). Points removed from the MP refill each game turn. */
  readonly mpPenalty?: number;
  /**
   * ToME's `movement_speed` add (physical.lua:493, `-0.5` for STUNNED).
   *
   * CARRIED AS DATA AND NOT YET READ BY ANYTHING. There is no separate movement
   * cost in this engine — a move is one action — so there is nothing to
   * multiply. It is declared because the number is part of the ported effect
   * and dropping it would make the port silently incomplete; the day movement
   * gets its own cost, this is where it reads from.
   */
  readonly movementSpeedAdd?: number;
  /**
   * Sets `StatusFlags.confused` — the PERCENT chance an action comes out wrong.
   * `mental.lua:80`, `addTemporaryValue("confused", eff.power)`. Summed across
   * live effects exactly as upstream's temporary values sum.
   */
  readonly confusedPercent?: number;
};

/** Arguments handed to every lifecycle hook. One object, so adding a field is additive. */
export type EffectHookArgs = {
  readonly state: EffectState;
  readonly actor: EffectActor;
  readonly eff: EffectInstance;
  readonly def: EffectDef;
  readonly rng: Rng;
  readonly ctx: EffectCtx;
};

/**
 * An effect declaration. The TS shape of `newEffect{...}`
 * (ActorTemporaryEffects.lua:40-59) intersected with `EffectDef`
 * (docs/data-schemas.md:218-231).
 */
export type EffectDef = {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  /** THE SAVE SELECTOR. Actor.lua:7002 keys `save_for_effects` off exactly this. */
  readonly type: SaveChannel;
  readonly status: EffectStatus;
  readonly stackMode: StackMode;
  /**
   * Immunity keys — ToME's `subtype` table (physical.lua:128, `{wound, cut,
   * bleed}`). Actor.lua:6963-6969 multiplies the actor's resistance to EACH of
   * them, which is why it is a list and not a single key.
   */
  readonly subtypes: readonly string[];
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * "I AM THE CROSS-TIER EFFECT FOR THIS CHANNEL" — Combat.lua:305-309.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * ```lua
   * local cross_tier_effects = {
   *   combatPhysicalResist = self.EFF_OFFBALANCE,
   *   combatSpellResist    = self.EFF_SPELLSHOCKED,
   *   combatMentalResist   = self.EFF_BRAINLOCKED,
   * }
   * ```
   *
   * Upstream hard-codes that table inside `crossTierEffect`. Here the effect
   * DECLARES the role and `createEffectState` indexes it, for the reason the
   * whole engine/content split exists: `engine/effects.ts` must not know the id
   * of any authored status. A build that registers no cross-tier effect for a
   * channel simply fires nothing on it, which is also what every pre-M5 fixture
   * needs to keep doing.
   *
   * At most one per channel — `registerEffect` refuses a second.
   */
  readonly crossTierFor?: SaveChannel;
  /**
   * `e.no_ct_effect` (Actor.lua:7027). This effect never TRIGGERS a cross-tier
   * effect when it lands.
   *
   * Set on the three cross-tier effects themselves. Belt and braces: the trigger
   * already sits inside the `applyPower !== undefined` branch and
   * `crossTierEffect` applies its effect with no power, so the recursion cannot
   * start — but "cannot recurse because of where the call happens to sit" is a
   * property one refactor away from being false, and upstream carries the flag.
   */
  readonly noCtEffect?: boolean;
  /**
   * `t.decrease` — ActorTemporaryEffects.lua:54, defaulted to 1 upstream.
   * How much `dur` drops per game turn. 0 makes an effect permanent until
   * dispelled, which is how ToME writes sustains that live in the same table.
   */
  readonly decrease: number;
  /** The 24×24 badge on disk. An asset key, never a path — the client owns the manifest. */
  readonly icon: string;
  /**
   * ═══ THE LETTERS DRAWN WHEN THE BADGE ART IS NOT THERE ═══
   *
   * `partypanel.ts` falls back to a boxed initial, under a docblock promising
   * that *"a missing badge PNG must not collapse three distinguishable statuses
   * into three identical error squares"*. That promise held while the roster
   * was three. It is now six, and the initials are S, B, S, E, B, D — Stunned
   * against Slowed, Bleeding against Breached.
   *
   * THE SERVER OWNS THIS BECAUSE ONLY THE SERVER SEES THE WHOLE ROSTER. A client
   * deriving a distinct letter would have to know every other effect in the game
   * to know whether its own collides, and it only ever receives the ones on the
   * bodies in front of it.
   *
   * Authored rather than derived, and pinned distinct by a test — a rule that
   * generated them ("first letter, then two if it clashes") would silently
   * renumber existing badges the day a seventh effect is added, and a player
   * learns these squares by shape.
   */
  readonly badge: string;
  /** Attributes granted while live. Recomputed, never incrementally patched. */
  /**
   * ═══ ANY DAMAGE TAKES THIS OFF. ToME's commonest balancing lever. ═══
   *
   * `EFF_DAZED` (physical.lua:558-575) states it in its own long_desc — *"Any
   * damage will remove the daze"* — and it is the reason upstream can hand out
   * a debuff that HALVES eight rolls without the game becoming a stunlock: the
   * effect is worth three turns only if nobody touches you, and in a real fight
   * nobody gets three untouched turns.
   *
   * A daze ported WITHOUT this would be strictly stronger than upstream's while
   * citing upstream's numbers, which is the worst of both — the citation would
   * be true line by line and false as a whole.
   *
   * Swept by `breakDamageSensitive`, driven from `TalentResolution.noteStruck`,
   * which already fires on exactly the right event: a blow that hit and dealt
   * more than zero.
   */
  readonly breaksOnDamage?: boolean;

  readonly modifiers?: EffectModifiers;
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * WHAT THIS EFFECT ADDS TO THE BODY WHILE IT IS UP — the same block a worn
   * item returns.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `modifiers` above is a fixed set of FLAGS and budget knobs — stunned, dazed,
   * `mpPenalty` — and every one of them was written for something being taken
   * AWAY. There was no way for a timed effect to add defence, accuracy, damage
   * or a resistance, which is to say: no way to write a BUFF. Every effect this
   * game has authored is `EffectStatus.Detrimental`, and that is why.
   *
   * ═══ IT IS `Item['wielder']`, AND THE CODEBASE ALREADY ARGUED FOR THAT ═══
   * `Talent.sustain`'s note settles the question this raises: *"THE CONTRIBUTION
   * COMES FROM `passive`, WHICH IS THE POINT. A sustain IS a passive you can
   * switch off — same shape, same fold, same `PassiveContribution` gear and
   * talents already stack through. Giving sustains their own contribution type
   * would be a second combine to keep in step with the first."*
   *
   * A timed effect is the same case one more time: a buff is a passive with a
   * clock on it. So it hands back a `PassiveContribution` — which equipment.ts
   * defines as the very block a worn item returns — and
   * `recomposeCombat` folds it with `composeWielders` — the identical additive
   * combine gear and passives already use — at a stage of its own between the
   * passives and the flags.
   *
   * ═══ A FUNCTION OF THE INSTANCE, SO POWER CAN SCALE ═══
   * `modifiers` is a static object because a flag has no magnitude. A buff does:
   * the defence Evasion grants depends on the rank that cast it, which arrives
   * in `params` and lives on the instance. Taking the instance also means the
   * remaining duration is readable, should an effect ever want to fade.
   *
   * ═══ AND IT NEEDS NO REMOVAL PATH ═══
   * docs/tome-port.md lists "Temp values -> recompute-from-base" as a deliberate
   * deviation, *"removes float drift on buff removal"*. `recomposeCombat`
   * rebuilds from the base sheet every time, so an effect that expires simply
   * stops being folded. There is nothing to undo and nothing to drift.
   */
  readonly wielder?: (instance: EffectInstance) => PassiveContribution;
  /** Parameter defaults — ActorTemporaryEffects.lua:113-115. */
  readonly parameters?: EffectParams;

  // --- lifecycle ------------------------------------------------------------
  /** ActorTemporaryEffects.lua:147. Fires AFTER the instance is in the table. */
  readonly activate?: (args: EffectHookArgs) => void;
  /** ActorTemporaryEffects.lua:192-196 (`deactivate`). Fires BEFORE removal. */
  readonly deactivate?: (args: EffectHookArgs) => void;
  /**
   * ActorTemporaryEffects.lua:85. Fires ONCE PER GAME TURN, BEFORE the duration
   * is decremented (:91). Return `true` to remove the effect immediately.
   */
  readonly onTimeout?: (args: EffectHookArgs) => boolean;
  /**
   * ActorTemporaryEffects.lua:124. `StackMode.Stack` only. Mutates and returns
   * the surviving instance; the incoming one is discarded.
   */
  readonly onMerge?: (
    args: EffectHookArgs & { readonly incoming: EffectInstance },
  ) => EffectInstance;
};

// ---------------------------------------------------------------------------
// The instance
// ---------------------------------------------------------------------------

/**
 * `p` — the parameter table an application carries
 * (ActorTemporaryEffects.lua:105). Open on purpose: an effect's payload is
 * whatever that effect needs, and forcing it into a closed union would put
 * every content field in this engine file.
 */
export type EffectParams = {
  /**
   * `p.apply_power` — Actor.lua:6999. THE GATE. Absent → no save is rolled at
   * all, no draw is consumed, and the effect lands at full duration. That is
   * how ToME applies an effect from another effect without re-rolling.
   */
  readonly applyPower?: number;
  /** `p.apply_save` — Actor.lua:7002/:7018. Overrides `def.type`'s channel. */
  readonly applySave?: SaveChannel;
  /** `p.min_dur` — Actor.lua:7001. Floor on the surviving duration. Default 0. */
  readonly minDur?: number;
  /** Magnitude. Bleed's damage per turn, Slow's fraction. `eff.power` upstream. */
  power?: number;
  /** `p.src` — who applied it. An id, never a reference, so a save can hold it. */
  readonly srcId?: string;
  /**
   * `p.no_ct_effect` — Actor.lua:7027. THIS application triggers no cross-tier
   * effect, whatever the definition says. Upstream's per-application escape
   * hatch, for an effect re-applied by another effect that has already paid the
   * cross-tier cost once.
   */
  readonly noCtEffect?: boolean;
};

/** What actually landed. `p`, after `on_set_temporary_effect` has had it. */
export type EffectInstance = {
  readonly effectId: string;
  /** GAME TURNS remaining. Decremented by `timedEffects` AFTER `onTimeout`. */
  dur: number;
  /** `p.maximum` — Actor.lua:7000. The duration asked for, before the save. */
  readonly maximum: number;
  /** `p.minimum` — Actor.lua:7001. */
  readonly minimum: number;
  /** `p.total_dur` — Actor.lua:7028. What it started at, for the UI's bar. */
  totalDur: number;
  /** `p.amount_decreased` — Actor.lua:7015. `maximum − dur`. The partial save, in turns. */
  readonly amountDecreased: number;
  /** Which save was rolled. `p.save_string` at :7019-7022, as a channel. */
  readonly savedVs: SaveChannel | null;
  /** The save chance that produced `dur`. The number the Case Log prints. */
  readonly saveChance: number;
  readonly params: EffectParams;
};

// ---------------------------------------------------------------------------
// The actor, as the effect system sees it
// ---------------------------------------------------------------------------

/**
 * STRUCTURAL, exactly like combat.ts's `CombatActor` and talents.ts's
 * `TalentActor`, and for the same reason: a bare test fixture and a live
 * `EngineActor` must both be valid inputs.
 *
 * `globalSpeed` is declared MUTABLE and optional even though `PlayerActor` pins
 * it to `readonly 1`. TypeScript does not consider `readonly` when checking
 * assignability, so the compile-time proof below passes and a player really
 * could be written to from here. It never is: every writer branches on
 * `kind === ActorKind.Monster` first. D1 is enforced at the two call sites in
 * `recomputeAttributes`, and there are only two.
 */
export type EffectActor = {
  readonly id: string;
  readonly name: string;
  readonly kind: ActorKind;
  hp: number;
  maxHp: number;
  alive: boolean;
  /** Replaced wholesale by `recomputeAttributes` — `flags` is readonly inside. */
  combat?: CombatSheet;
  /** Shared with engine/actor.ts. STUNNED's 3-talent lockout writes to it. */
  readonly cooldowns: Map<string, number>;
  /** Monsters only. The energy GAIN multiplier; see `EffectModifiers.globalSpeedAdd`. */
  globalSpeed?: number;
};

/**
 * The seam to the systems this file must not import.
 *
 * Every field optional, so `timedEffects(state, actor, rng)` works in a unit
 * test with no world at all. `content/effects.ts` reads `activatableTalents`
 * and `getActor`; nothing in THIS file does.
 */
export type EffectCtx = {
  /** Resolve an id — a DoT's source, for damage attribution. */
  getActor?: (id: string) => EffectActor | undefined;
  /**
   * Talent ids this actor could activate right now. STUNNED's lockout
   * (physical.lua:495-504) picks three of them.
   */
  activatableTalents?: (actorId: string) => readonly string[];
  /** Fired on every state change, for the Case Log's Record lane. */
  log?: (line: EffectLogLine) => void;
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THIS BODY'S SHEET IS STALE — REBUILD IT FROM BASE.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Fired when an effect that CONTRIBUTES STATS lands, merges or leaves. See
   * `EffectDef.wielder`.
   *
   * ═══ WHY IT CANNOT JUST CALL `recomposeCombat` ═══
   * That function takes an `ItemCatalogue`, because stage two folds worn gear.
   * This file must not learn what an item is — the whole point of `EffectCtx` is
   * that effects.ts imports none of the systems it cooperates with. The adapter
   * that holds the catalogue AND the talent engine (server/main.ts) is the only
   * layer that can rebuild a sheet, so it is handed the request instead.
   *
   * ═══ AND WHY NOT `recomputeAttributes`, WHICH IS ALREADY CALLED HERE ═══
   * Because it does `{ ...sheet, flags }` — it PRESERVES the sheet and replaces
   * only the flags. Folding a stat grant there would add the buff again on top
   * of the already-buffed sheet on every subsequent call, which is precisely the
   * float-drift-on-removal that docs/tome-port.md § 9 records this engine as
   * having escaped by recomputing from base. A buff has to go through the
   * rebuild or it does not go anywhere.
   *
   * ═══ ABSENT MEANS ONE TURN OF LATENCY, NOT A WRONG NUMBER ═══
   * `refreshPassives` rebuilds every sheet once per base turn anyway, so a
   * fixture with no hook still converges — it is simply a turn late, which for a
   * four-turn buff is a quarter of it missing at one end and a quarter overstayed
   * at the other.
   */
  sheetDirty?: (actorId: string) => void;

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * A STATUS JUST KILLED SOMEBODY, AND NOTHING ELSE IS GOING TO NOTICE.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * A blow reaches `noteCasualty` through the ACTION OUTCOME it produced — the
   * scheduler reads `killedBy(effect)` and buries whoever is named there. A
   * bleed tick produces no outcome, so it produced no burial: `applyDamage` set
   * `alive = false`, returned `{ killed: true }`, and this file threw the answer
   * away.
   *
   * MEASURED, driving a 3 hp husk with a 5-power bleed through the real pump:
   *
   *     hp=0 alive=false  ·  still in world: true  ·  reaped: []
   *     events: held, turn_ended, engagement
   *
   * A corpse standing on the tile forever — never removed, never announced, no
   * experience, no loot, and counted alive by anything asking whether the site
   * is clear. Bleeding a monster out was strictly worse than letting it live.
   *
   * ═══ A NOTE RATHER THAN A REAP ═══
   * This module cannot bury anybody: `world` is the scheduler's and reaching it
   * from here is the import cycle `statusPass`'s docblock exists to prevent. So
   * the hook says WHAT HAPPENED and the scheduler decides what that means — the
   * same division `log` and `drainStatusLog` already keep, for the same reason.
   *
   * ═══ IT REPORTS THE DAMAGE, NOT ONLY THE DEATH — WHICH IS UPSTREAM'S SHAPE ═══
   * ToME attaches the log to DAMAGE and not to attacks: every hit goes through
   * `DamageType`'s default projector, which calls `takeHit` and then logs
   * `"%d %s"` (damage_types.lua:496-501) — the same path for a sword swing and a
   * bleed tick. That is exactly why upstream has no bug here.
   *
   * Ours derived the `damage` frame from the ACTION OUTCOME instead
   * (`hitToWire`), so a bleed produced no damage line at all: the whole
   * transcript of a death by bleeding was one sentence, with no number, no hp
   * and no cause. Reporting the hit rather than the kill puts the line back and
   * costs nothing extra — the death is a flag on it, which is the order it
   * happens in.
   *
   * `sourceId` is null when the wound has nobody left to blame; the scheduler
   * pays nothing in that case rather than crediting an arbitrary body.
   */
  noteDamage?: (hit: StatusHit) => void;
};

/**
 * ONE BLOW DEALT BY A STATUS, as reported to whoever is driving the pump.
 *
 * `hp`/`maxHp` are captured AT THE HIT rather than read back when the pump
 * drains this: two effects ticking on one body in one base pass would otherwise
 * both report the second one's hp, and the Case Log would print a number the
 * player never had.
 */
export type StatusHit = {
  readonly victimId: string;
  readonly sourceId: string | null;
  readonly amount: number;
  readonly hp: number;
  readonly maxHp: number;
  readonly killed: boolean;
  /**
   * WHAT KIND OF DAMAGE, so the log can say "5 physical" the way upstream does
   * for every source of damage in the game (damage_types.lua:496-501). Optional
   * for the same reason `Blow.type` is: absent means "do not say", never
   * "physical".
   */
  readonly type?: DamageType;
  /** True on a critical. A DoT can crit — `applyDamage` rolls one either way. */
  readonly crit: boolean;
  /**
   * HP PUT BACK rather than taken, and `amount` is 0 when it is set — the exact
   * contract `Blow.healed` and `DamageEvent.healed` already carry, named the
   * same on purpose so the three read as one channel rather than three.
   *
   * A STATUS CAN HEAL. Every hit this type described used to take hit points,
   * because BLEEDING was the only effect that moved a pool at all. Regeneration
   * moves it the other way, and without this the tick would either report
   * nothing — leaving a pool climbing 20 a turn with the transcript silent — or
   * report a heal as damage, which is worse.
   */
  readonly healed?: number;
};

/** One line for the Case Log's Record lane. Terse and mechanical, by design. */
export type EffectLogLine = {
  readonly actorId: string;
  readonly effectId: string;
  readonly kind: 'gained' | 'lost' | 'negated' | 'resisted' | 'immune' | 'merged';
  /** Turns that landed, for `gained`/`merged`. */
  readonly dur?: number;
  /** What was asked for, so the log can print "Slowed 1 turn, not 3". */
  readonly maximum?: number;
  readonly saveChance?: number;
  readonly savedVs?: SaveChannel;
};

// ---------------------------------------------------------------------------
// The state
// ---------------------------------------------------------------------------

const EMPTY_EFFECTS: readonly EffectInstance[] = Object.freeze([]);

/**
 * The side table. One per world.
 *
 * `byActor` preserves INSERTION ORDER (it is a Map), which is what makes
 * `timedEffects` reproducible — ToME iterates `pairs(self.tmp)`, whose order is
 * a Lua hash order and therefore not reproducible at all. That is a deliberate
 * improvement, not a drift: replay requires it.
 */
export type EffectState = {
  readonly defs: Map<string, EffectDef>;
  readonly byActor: Map<string, Map<string, EffectInstance>>;
  /** actor id → immunity key → percent resisted, 0..100. */
  readonly immunities: Map<string, Map<string, number>>;
  /** The pre-effect `flags`, so `recomputeAttributes` can rebuild rather than patch. */
  readonly baseFlags: Map<string, StatusFlags | undefined>;
  /** The pre-effect `globalSpeed`, same reason. Monsters only. */
  readonly baseGlobalSpeed: Map<string, number>;
  /**
   * Save channel → the effect id to apply when someone is outclassed on it.
   * Built from `EffectDef.crossTierFor` as definitions register, so the engine
   * never names an authored status. Empty in a build with no such content, and
   * `crossTierEffect` then does nothing.
   */
  readonly crossTier: Map<SaveChannel, string>;
};

export function createEffectState(defs: readonly EffectDef[] = []): EffectState {
  const state: EffectState = {
    defs: new Map<string, EffectDef>(),
    byActor: new Map<string, Map<string, EffectInstance>>(),
    immunities: new Map<string, Map<string, number>>(),
    baseFlags: new Map<string, StatusFlags | undefined>(),
    baseGlobalSpeed: new Map<string, number>(),
    crossTier: new Map<SaveChannel, string>(),
  };
  for (const def of defs) registerEffect(state, def);
  return state;
}

/** ActorTemporaryEffects.lua:56 — `tempeffect_def["EFF_"..t.name] = t`. */
export function registerEffect(state: EffectState, def: EffectDef): EffectDef {
  const existing = state.defs.get(def.id);
  if (existing !== undefined && existing !== def) {
    throw new Error(`effects: duplicate definition for '${def.id}'`);
  }
  state.defs.set(def.id, def);
  if (def.crossTierFor !== undefined) {
    const claimed = state.crossTier.get(def.crossTierFor);
    if (claimed !== undefined && claimed !== def.id) {
      throw new Error(
        `effects: '${def.id}' and '${claimed}' both claim the ${def.crossTierFor} cross-tier ` +
          `slot — Combat.lua:305-309 maps each save channel to exactly one`,
      );
    }
    state.crossTier.set(def.crossTierFor, def.id);
  }
  return def;
}

/** ActorTemporaryEffects.lua:67-70 — `getEffectFromId`. */
export function effectDef(state: EffectState, effectId: string): EffectDef | undefined {
  return state.defs.get(effectId);
}

/** Drop everything about an actor. The one place `removeActor` must call. */
export function forgetActor(state: EffectState, actorId: string): void {
  state.byActor.delete(actorId);
  state.immunities.delete(actorId);
  state.baseFlags.delete(actorId);
  state.baseGlobalSpeed.delete(actorId);
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** ActorTemporaryEffects.lua:171-173 — `hasEffect`. */
export function hasEffect(state: EffectState, actorId: string, effectId: string): boolean {
  return state.byActor.get(actorId)?.has(effectId) === true;
}

/** The live instance, or undefined. */
export function effectOn(
  state: EffectState,
  actorId: string,
  effectId: string,
): EffectInstance | undefined {
  return state.byActor.get(actorId)?.get(effectId);
}

/** Every live effect, in application order. */
export function effectsOn(state: EffectState, actorId: string): readonly EffectInstance[] {
  const table = state.byActor.get(actorId);
  if (table === undefined) return EMPTY_EFFECTS;
  return [...table.values()];
}

/** Turns left on one effect, or 0. */
export function effectDur(state: EffectState, actorId: string, effectId: string): number {
  return effectOn(state, actorId, effectId)?.dur ?? 0;
}

// ---------------------------------------------------------------------------
// Immunity — Actor.lua:6944-6978
// ---------------------------------------------------------------------------

/**
 * Set a resistance, 0..100, against one immunity key or subtype.
 *
 * 100 is total immunity and is refused with NO DRAW; 0 is refused with no draw
 * too (:6977's `resist == 0 and true or ...` short-circuits before
 * `rng.percent`). Both of those are exceptions to this codebase's usual "always
 * draw" rule and both are upstream behaviour — the stream position has to match
 * or a replay diverges the moment anything gains an immunity.
 */
export function grantImmunity(
  state: EffectState,
  actorId: string,
  key: string,
  percent: number,
): void {
  const table = state.immunities.get(actorId) ?? new Map<string, number>();
  table.set(key, bound(percent, 0, 100));
  state.immunities.set(actorId, table);
}

/** Percent resisted for one key. 0 when nothing was granted. */
export function immunityOf(state: EffectState, actorId: string, key: string): number {
  return state.immunities.get(actorId)?.get(key) ?? 0;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE SAME QUESTION, ASKED OF BOTH PLACES AN ANSWER CAN COME FROM.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `state.immunities` is the effect system's own table, and `grantImmunity`
 * SETS a key rather than adding to it. That is right for its one caller — a
 * timed effect owns its grant and drops it when it expires — and it is exactly
 * wrong for gear: two rings would not stack, and taking one off could not be
 * undone without the `addTemporaryValue` ledger this codebase deliberately does
 * not have. `equipment.ts` says so at length about `resists`.
 *
 * So WORN immunity rides the COMPOSED SHEET instead, rebuilt from nothing by
 * `recomposeCombat` on every equip, unequip, level and effect tick. Removing
 * the ring removes the immunity because the sheet is recomputed, not because
 * anybody remembered to subtract.
 *
 * ADDITIVE between the two sources and then bounded, which is what upstream's
 * single `stun_immune` attr is: one number every source adds into.
 */
export function immunityAgainst(state: EffectState, actor: EffectActor, key: string): number {
  const worn = actor.combat?.immunities?.[key] ?? 0;
  return bound(immunityOf(state, actor.id, key) + worn, 0, 100);
}

/** `canBe`'s two return values — Actor.lua:6950, `true/false` plus the chance. */
export type CanBeResult = {
  /** Can it be applied? */
  readonly can: boolean;
  /** Percent chance of being affected, 0..100. `100 − resist`, composed. */
  readonly chance: number;
};

/**
 * CAN THIS EFFECT BE APPLIED AT ALL — Actor.lua:6951-6978, the `what == nil`
 * path (:6963-6969), which is the one `setEffect` uses.
 *
 * ```lua
 * local chance = 100
 * for typ, _ in pairs(e.subtype) do
 *   local _, t_chance = self:canBe(typ)
 *   chance = chance*t_chance/100
 * end
 * return chance == 0 and false or rng.percent(chance), chance
 * ```
 *
 * MULTIPLICATIVE across subtypes, and that composition is the point: BLEEDING
 * carries `{wound, cut, bleed}`, so 50% wound resistance and 50% bleed
 * resistance leave a 25% chance of being cut, not 0%. Additive stacking would
 * make two mediocre immunities a total one.
 *
 * The four blanket immunities (:6956-6960) short-circuit ahead of all of it.
 */
export function canBe(
  state: EffectState,
  actor: EffectActor,
  def: EffectDef,
  rng: Rng,
): CanBeResult {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * NOTHING RESISTS A BUFF, AND THE WHOLE BLOCK BELOW IS INSIDE THE GUARD.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Read the Lua again with the indentation in mind (Actor.lua:6955-6970). The
   * subtype product AND ITS `rng.percent` DRAW are both inside
   * `if e and e.status == "detrimental" then`. A beneficial effect skips every
   * line of it, falls through to :6974's `local test = self.StatusTypes[what]`
   * with `what == nil`, and returns `true, 100`.
   *
   * ═══ THIS PORT HOISTED THE PRODUCT OUT OF THE GUARD, AND IT MATTERS TWICE ═══
   * Only the blanket immunities were guarded here; the subtype loop ran for
   * every effect. Harmless for exactly as long as every authored effect was
   * detrimental, which was true until `EVASIVE` (content/effects.ts). Two
   * consequences, and the second is the serious one:
   *
   *   A BUFF COULD BE REFUSED. An actor carrying an immunity that happened to
   *   match one of the buff's subtypes would shrug off a blessing. Upstream
   *   never refuses one.
   *
   *   AND IT COULD FIRE AN RNG DRAW UPSTREAM NEVER MAKES. `rollPercent` pulls
   *   from the labelled stream, so a buff landing on a partially-immune body
   *   would shift every subsequent draw in that turn — the determinism contract
   *   (docs/tome-port.md § 7) broken by a blessing.
   *
   * Latent rather than live: `chance >= 100` short-circuits before the draw, and
   * nothing in the game grants an immunity matching a buff's subtypes today. It
   * is fixed here because the first beneficial effect has just been authored and
   * this is the shape of bug that waits for content to arrive.
   */
  if (def.status !== EffectStatus.Detrimental) return { can: true, chance: 100 };

  /**
   * :6956 — the blanket one, then :6958-6960's per-channel one.
   *
   * `immunityOf` AND NOT `immunityAgainst`, deliberately: these four are tested
   * for TRUTH rather than for a percentage, so any nonzero value is TOTAL
   * refusal. `IMMUNITY_KEYS` already refuses to let content author them, and
   * reading the sheet here as well would make a validation bug — one blanket key
   * slipping into one ego — into immunity to every detrimental effect in the
   * game. Two locks on the same door, because that door is the whole M4 system.
   */
  if (immunityOf(state, actor.id, ImmunityKey.AllNegative) > 0) return { can: false, chance: 0 };
  if (immunityOf(state, actor.id, BLANKET_IMMUNITY[def.type]) > 0) {
    return { can: false, chance: 0 };
  }

  // :6964-6968 — the subtype product.
  let chance = 100;
  for (const subtype of def.subtypes) {
    const resist = immunityAgainst(state, actor, subtype);
    chance = (chance * (100 - resist)) / 100;
  }

  // :6969 — total immunity refuses with NO DRAW.
  if (chance === 0) return { can: false, chance: 0 };
  // :6977's short-circuit: nothing resisted at all also draws nothing.
  if (chance >= 100) return { can: true, chance: 100 };

  const roll = rollPercent(rng, `effects.${def.id}.immune`);
  return { can: roll <= chance, chance };
}

// ---------------------------------------------------------------------------
// THE HEADLINE: partial-save duration scaling — Actor.lua:6999-7014
// ---------------------------------------------------------------------------

/** `mean_fact` — Actor.lua:7005. Raise it to lengthen the average failed save. */
export const MEAN_FACT = 1.1;
/** `std_dev` — Actor.lua:7005. Raise it for more randomness in the duration. */
export const STD_DEV = 50;
/** `util.bound(..., 0, 2)` — Actor.lua:7007. A duration can DOUBLE, then be capped. */
export const DURATION_PCT_CAP = 2;
/** How many uniform samples `normalFloat` averages. See the note below. */
export const NORMAL_SAMPLES = 3;

/**
 * `rng.percent(v)` — `rand_range(1, 100) <= v`, both ends inclusive.
 *
 * Same reimplementation shared/checkhit.ts documents: ToME's `rng.percent` is
 * native C and the reference clone holds 1,656 `.lua` files and zero `.c`
 * (docs/tome-mechanics.md § 10). Drawn UNCONDITIONALLY — a short-circuit at
 * chance 0 or 100 would move every later draw in the turn.
 */
function rollPercent(rng: Rng, label: string): number {
  return rng.int(label, 1, 100);
}

/**
 * `rng.normalFloat(mean, std)` — Actor.lua:7007.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * A REIMPLEMENTATION OF DOCUMENTED SEMANTICS, NOT A TRANSLATION
 * ═══════════════════════════════════════════════════════════════════════════
 * `rng.normalFloat` is native C in `src/rng.c` and is ABSENT from the reference
 * clone, exactly like `rng.percent` and `core.fov.*`. docs/tome-mechanics.md
 * § 10 lists it as one of the primitives that must be written from scratch.
 *
 * T-Engine's `normalFloat` is NOT a Gaussian. It is the mean of
 * `NORMAL_SAMPLES` uniform draws on `[-std, +std]` — a Bates distribution,
 * n = 3 — added to `mean`. Two properties follow and both matter here:
 *
 *   - IT IS BOUNDED. The result never leaves `mean ± std`. A true Box–Muller
 *     Gaussian has infinite tails, and with `mean_pct = 110, std = 50` those
 *     tails would occasionally produce a duration multiplier of 3 or 4 that the
 *     `util.bound(..., 0, 2)` at :7007 was never written to catch.
 *   - ITS SPREAD IS NARROWER THAN `std` SUGGESTS. Averaging three samples gives
 *     a standard deviation of `std / 3` ≈ 16.7 percentage points, not 50. Swap
 *     in a real Gaussian and every stun duration becomes three times as noisy.
 *
 * Three draws, labelled individually, so a replay diff names the sample that
 * diverged rather than just "the duration roll".
 */
export function normalFloat(rng: Rng, label: string, mean: number, std: number): number {
  let sum = 0;
  for (let i = 0; i < NORMAL_SAMPLES; i += 1) {
    // nextFloat is [0, 1) → [-std, +std).
    sum += -std + rng.nextFloat(`${label}.${i}`) * 2 * std;
  }
  return mean + sum / NORMAL_SAMPLES;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE SINGLE MOST INTERESTING NUMBER IN THE COMBAT LAYER — Actor.lua:7004-7014
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ```lua
 * local mean_fact, std_dev = 1.1, 50                              -- :7005
 * local mean_pct = (100-savechance)*mean_fact                     -- :7006
 * local percentage = util.bound(rng.normalFloat(mean_pct, std_dev)/100, 0, 2)  -- :7007
 * local desired = p.maximum * percentage                          -- :7009
 * local fraction = desired % 1                                    -- :7010
 * desired = math.floor(desired) + (rng.percent(100*fraction) and 1 or 0)       -- :7011
 * local duration = math.min(p.maximum, desired)                   -- :7012
 * p.dur = util.bound(duration, p.minimum or 0, p.maximum)         -- :7014
 * ```
 *
 * LINE 7011 IS THE STOCHASTIC ROUNDING THE DOCS DROPPED (CLAUDE.md, doc drift
 * #1; docs/tome-mechanics.md § 6 stops at :7009 and floors). It is not a
 * rounding nicety. Without it, a 3-turn effect against a strong save truncates
 * to a deterministic integer, and every duration below one full turn collapses
 * to zero — which turns the entire partial-save mechanic back into the binary
 * miss it exists to replace. WITH it, `desired = 1.056` is 1 turn 94.4% of the
 * time and 2 turns 5.6% of the time, in expectation exactly 1.056.
 *
 * WORKED EXAMPLES (pinned in test/server/effects.test.ts).
 * All assume `normalFloat` landed exactly on its mean, i.e. three `nextFloat`
 * draws of 0.5:
 *
 *   maximum 3, saveChance 68  (game-design.md § 11's log line)
 *     mean_pct   = (100 − 68) × 1.1 = 35.2
 *     percentage = 0.352
 *     desired    = 3 × 0.352        = 1.056   → floor 1, fraction 0.056
 *     round roll ≥ 6  → 1 turn      ("Slowed 1 turn, not 3.")
 *     round roll ≤ 5  → 2 turns     (5.6% of the time)
 *
 *   maximum 5, saveChance 0   (no save at all — an unresisted stun)
 *     mean_pct   = 110 → percentage 1.1 → desired 5.5 → floor 5, fraction 0.5
 *     min(5, 5 or 6) = 5           → the full duration, both ways
 *
 *   maximum 4, saveChance 90  (a save-stacked defender)
 *     mean_pct   = 11 → percentage 0.11 → desired 0.44 → floor 0, fraction 0.44
 *     round roll ≤ 44 → 1 turn ; otherwise 0 → the "resists" branch at :7039
 *
 * The `min(p.maximum, ...)` at :7012 is what stops the +1 from ever exceeding
 * the duration that was asked for; the `bound(..., minimum, maximum)` at :7014
 * is what lets a talent guarantee a floor with `minDur`.
 *
 * @param maximum the duration asked for. `p.maximum` at :7000.
 * @param saveChance the SECOND return of `checkHitOld(save, applyPower)`.
 * @param minimum `p.min_dur`, default 0.
 */
export function rollSaveDuration(
  maximum: number,
  saveChance: number,
  rng: Rng,
  label = 'effects.duration',
  minimum = 0,
): number {
  const meanPct = (100 - saveChance) * MEAN_FACT; // :7006
  const percentage = bound(
    normalFloat(rng, `${label}.normal`, meanPct, STD_DEV) / 100,
    0,
    DURATION_PCT_CAP,
  ); // :7007

  const raw = maximum * percentage; // :7009
  const fraction = raw % 1; // :7010
  // :7011 — THE DRAW THE DOCS DROPPED. Unconditional: at fraction 0 the roll
  // simply always fails, and the stream stays aligned.
  const bumped = Math.floor(raw) + (rollPercent(rng, `${label}.round`) <= 100 * fraction ? 1 : 0);

  const duration = Math.min(maximum, bumped); // :7012
  return bound(duration, minimum, maximum); // :7014
}

// ---------------------------------------------------------------------------
// setEffect — ActorTemporaryEffects.lua:105-165 + Actor.lua:6993-7043
// ---------------------------------------------------------------------------

/** Why `setEffect` returned what it did. Every branch upstream, named. */
export const SetEffectOutcome = {
  /** It landed. `dur` is what survived the save. */
  Applied: 'applied',
  /** It was already live and `onMerge` folded them together (:123-125). */
  Merged: 'merged',
  /** Already live, `StackMode.Ignore`. Nothing happened. */
  Ignored: 'ignored',
  /**
   * THE NEGATE BRANCH — Actor.lua:7034-7037. The save roll came up `saved`, so
   * the effect is refused OUTRIGHT even though a duration was computed.
   */
  Negated: 'negated',
  /**
   * Actor.lua:7038-7040. The save roll FAILED but the duration scaled to 0, so
   * there is nothing to apply. Upstream logs this as "resists" rather than
   * "shrugs off", and they are genuinely different events.
   */
  Resisted: 'resisted',
  /** `canBe` refused it — Actor.lua:6951-6978. */
  Immune: 'immune',
  /** `dur <= 0` was asked for. ActorTemporaryEffects.lua:109 removes instead. */
  Removed: 'removed',
  /** No such definition is registered. */
  Unknown: 'unknown',
} as const;
export type SetEffectOutcome = (typeof SetEffectOutcome)[keyof typeof SetEffectOutcome];

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHO, IF ANYONE, GETS PAID FOR THIS EFFECT LANDING.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Returns the id of the actor to credit, or `null` when nobody is owed anything.
 *
 * ═══ WHY THIS IS A FUNCTION AND NOT FOUR CONDITIONS IN `main.ts` ═══
 * It was four conditions in `main.ts`, inside a closure, and it was the ONLY
 * place `ResourceKind.Ink` could ever be earned. Nothing could reach it from a
 * test without booting a server, so the rule that defines an entire class's
 * economy had no coverage of its own — and it shipped months before any class
 * that could earn Ink existed, which is exactly the arrangement where a wrong
 * condition survives indefinitely.
 *
 * The wiring stays in `main.ts` (it is the only place the applier and the talent
 * engine are both in scope). The RULE lives here, where it can be asked.
 *
 * ═══ THE FOUR CONDITIONS, EACH OF WHICH IS A REAL DECISION ═══
 *
 *   1. THERE IS A SOURCE. An effect with no `srcId` — a trap, a floor, a
 *      lingering cloud nobody threw — pays nobody, because nobody did it.
 *
 *   2. THE SOURCE IS NOT THE VICTIM. A Redactor who is bleeding does not get
 *      paid for bleeding. Self-inflicted marks would otherwise be the cheapest
 *      income in the game.
 *
 *   3. IT LANDED, AND FOR A REAL DURATION. A save the target MADE pays nothing.
 *      Paying on the ATTEMPT would make Ink a flat tax on pressing buttons and
 *      would reward spraying marks at things that shrug them off — the opposite
 *      of the class. `dur > 0` catches the immune and refused cases that report
 *      `Applied` with nothing on the clock.
 *
 *   4. IT IS DETRIMENTAL. A bandage on an ally is not something written down.
 *
 * ═══ `Applied` ONLY, WHICH MEANS A REFRESH PAYS NOTHING, AND THAT IS THE
 *     CONDITION HOLDING THE WHOLE ECONOMY UP ═══
 * Condition 3 asks for `Applied` specifically, so `Merged` — the outcome when
 * the effect was ALREADY on the target and `onMerge` folded the two together —
 * earns nothing. That reads like an oversight and is the opposite of one.
 *
 * `strike_out` costs 8 Ink and a landed mark pays `INK_PER_MARK`, which is 12.
 * The talent is net-positive on purpose: it is the one unconditional way to
 * prime a well that is nearly dry. If a REFRESH also paid, a Redactor could
 * stand in front of one already-effaced husk and press the same button forever
 * for +4 Ink a press, and the resource would stop being a resource.
 *
 * The mark has to be NEW. One mark, one payment — and re-marking something you
 * already marked is not a new mark, whatever it does to the clock.
 *
 * ═══ AND IT IS ONCE, WHICH IS ENFORCED BY WHERE IT IS CALLED ═══
 * Income per TICK would make duration the only stat worth having and would pay
 * a long slow twice over. This is asked at the moment of APPLYING and nowhere
 * else, so one mark is one payment however long it burns.
 */
export function creditForLanding(
  targetId: string,
  landed: SetEffectResult,
  srcId: string | undefined,
  status: EffectStatus | undefined,
): string | null {
  if (srcId === undefined || srcId === targetId) return null;
  if (landed.outcome !== SetEffectOutcome.Applied || landed.dur <= 0) return null;
  if (status !== EffectStatus.Detrimental) return null;
  return srcId;
}

export type SetEffectResult = {
  readonly outcome: SetEffectOutcome;
  /** Turns that actually landed. 0 for every refusal. */
  readonly dur: number;
  /** What was asked for, so a log can say "1 turn, not 3". */
  readonly maximum: number;
  /** The save chance rolled, or null when `applyPower` was absent. */
  readonly saveChance: number | null;
  /** Which of the three was used. Null when no save was rolled. */
  readonly savedVs: SaveChannel | null;
  /** The live instance, when one exists. */
  readonly effect: EffectInstance | null;
};

const NO_CTX: EffectCtx = {};

function refusal(
  outcome: SetEffectOutcome,
  maximum: number,
  saveChance: number | null,
  savedVs: SaveChannel | null,
): SetEffectResult {
  return { outcome, dur: 0, maximum, saveChance, savedVs, effect: null };
}

/**
 * APPLY AN EFFECT. `setEffect` + `on_set_temporary_effect`, in one function
 * because upstream's split is an inheritance artefact
 * (ActorTemporaryEffects.lua:118 calls `self:check("on_set_temporary_effect")`)
 * and re-creating it here would mean two exported functions where one is never
 * legal to call alone.
 *
 * THE ORDER, and it is the whole contract:
 *   1. `duration <= 0` removes instead of applying (:109). Floor it (:110).
 *   2. Merge in the definition's parameter defaults (:113-115).
 *   3. `canBe` — immunity (Actor.lua:6951-6978).
 *   4. THE SAVE, if `applyPower` is present (Actor.lua:6999-7014). This is
 *      where `rollSaveDuration` runs, and it consumes draws whether or not the
 *      effect ends up landing.
 *   5. THE NEGATE BRANCH (:7024-7042) — `saved` refuses, `dur == 0` resists.
 *   6. Stacking (:122-130).
 *   7. Insert, `activate` (:147), recompute attributes.
 *
 * ═══ THE DRAW BUDGET, WHICH IS PART OF THE REPLAY CONTRACT ═══
 * A save-gated application consumes exactly FIVE draws, always, in this order:
 *   1 × `checkHitOld` percent  +  3 × `normalFloat`  +  1 × stochastic round.
 * Plus one more if any immunity is partial. An application with no `applyPower`
 * consumes NONE. `test/server/effects.test.ts` pins both counts, because a
 * stage that quietly stops drawing desynchronises every later roll in the turn.
 */
/**
 * ═══════════════════════════════════════════════════════════════════════════
 * BEING OUTCLASSED COSTS SOMETHING EXTRA — Combat.lua:295-322.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ```lua
 * local dur = self:getTierDiff(apply_power, save)
 * self:setEffect(ct_effect, dur, {})
 * ```
 *
 * Tiers are twenty rescaled points wide. When an attacker's apply power outranks
 * the defender's save by a WHOLE tier, the defender takes a second debuff on top
 * of whatever landed — Off-balance, Spellshocked or Brainlocked, chosen by the
 * save channel — and the tier gap IS its duration in turns.
 *
 * ═══ IT FIRES EVEN WHEN THE SAVE SUCCEEDED, AND THAT IS THE POINT ═══
 * Actor.lua:7025-7027 calls this INSIDE `if p.dur > 0` and BEFORE the `if saved`
 * return. So shrugging off a stun from something two tiers above you still
 * leaves you off-balance. It is upstream's way of saying "you do not belong on
 * this floor" without printing a level number — a soft, legible pressure that
 * scales with the gap rather than a wall.
 *
 * ═══ A ZERO DURATION REMOVES, AND THAT IS UPSTREAM'S TOO ═══
 * `setEffect(ct, 0, {})` hits ActorTemporaryEffects.lua:109 — *"Beware, setting
 * to 0 means removing"*. So a same-tier hit CLEARS an existing cross-tier
 * debuff. It reads like an accident of upstream's control flow and it is the
 * behaviour fifteen years of play were tuned against, so it is ported as
 * written; CLAUDE.md's rule is that when the docs and the Lua disagree, the Lua
 * wins. Kept as one unconditional call rather than a `dur > 0` guard so the
 * difference is visible rather than quietly dropped.
 *
 * ═══ IT CANNOT RECURSE ═══
 * The applied effect carries no `applyPower`, so the trigger below — which sits
 * inside `applyPower !== undefined` — is unreachable from it. The three
 * cross-tier definitions ALSO set `noCtEffect`, because that argument depends on
 * where a call happens to sit and is one refactor from being false.
 */
function crossTierEffect(
  state: EffectState,
  target: EffectActor,
  applyPower: number,
  channel: SaveChannel,
  rng: Rng,
  ctx: EffectCtx,
): void {
  const crossTierId = state.crossTier.get(channel);
  // A build with no cross-tier content registered. Every pre-M5 fixture.
  if (crossTierId === undefined) return;

  // Combat.lua:313 — `self[apply_save or save_for_effects[e.type]](self, true)`.
  // The DEFENDER's save on the same channel the effect was rolled against.
  const save = saveOf(target.combat, channel);
  setEffect(state, target, crossTierId, getTierDiff(applyPower, save), {}, rng, ctx);
}

export function setEffect(
  state: EffectState,
  target: EffectActor,
  effectId: string,
  duration: number,
  params: EffectParams,
  rng: Rng,
  ctx: EffectCtx = NO_CTX,
): SetEffectResult {
  const def = state.defs.get(effectId);
  if (def === undefined) return refusal(SetEffectOutcome.Unknown, 0, null, null);

  // ActorTemporaryEffects.lua:109 — "Beware, setting to 0 means removing".
  if (duration <= 0) {
    removeEffect(state, target, effectId, rng, ctx);
    return refusal(SetEffectOutcome.Removed, 0, null, null);
  }
  // :110 — `dur = math.floor(dur)`.
  const maximum = Math.floor(duration);

  // :113-115 — the definition's defaults fill in whatever the caller omitted.
  const merged: EffectParams = { ...def.parameters, ...params };

  // Actor.lua:6951-6978. A corpse is immune to everything by construction.
  if (!target.alive) return refusal(SetEffectOutcome.Immune, maximum, null, null);
  const immunity = canBe(state, target, def, rng);
  if (!immunity.can) {
    ctx.log?.({ actorId: target.id, effectId, kind: 'immune' });
    return refusal(SetEffectOutcome.Immune, maximum, null, null);
  }

  // ── THE SAVE ────────────────────────────────────────────────────────────
  // Actor.lua:6999 — `if p.apply_power and (save_for_effects[e.type] or
  // p.apply_save)`. No power means no save, no draw, full duration.
  let dur = maximum;
  let saveChance: number | null = null;
  let savedVs: SaveChannel | null = null;

  const applyPower = merged.applyPower;
  if (applyPower !== undefined) {
    // :7002 — `p.apply_save or save_for_effects[e.type]`. THE EFFECT'S TYPE.
    const channel = merged.applySave ?? def.type;
    const save = saveOf(target.combat, channel);

    // :7003 — `checkHitOld(save, p.apply_power)`. The SAVE is `atk` and the
    // incoming power is `def`, so `hit === true` means the effect was RESISTED.
    const roll = checkHitOld(save, applyPower, rng, `effects.${def.id}.save`);
    saveChance = roll.chance;
    savedVs = channel;

    // :7004-7014.
    dur = rollSaveDuration(
      maximum,
      roll.chance,
      rng,
      `effects.${def.id}.duration`,
      merged.minDur ?? 0,
    );

    // :7024-7042 — the negate branch. BOTH refusals are detrimental-only,
    // because upstream's whole block is gated on `e.status == "detrimental"`.
    // A beneficial effect keeps its scaled duration and is never refused.
    if (def.status === EffectStatus.Detrimental) {
      if (dur > 0) {
        /**
         * :7025-7027 — THE CROSS-TIER EFFECT, BEFORE THE `saved` CHECK BELOW.
         *
         * ```lua
         * if not p.no_ct_effect and not e.no_ct_effect then
         *   self:crossTierEffect(eff_id, p.apply_power, p.apply_save or ...)
         * end
         * ```
         *
         * The position is the rule: a shrugged-off effect has already passed
         * `dur > 0` and still gets here, so being outclassed costs you something
         * even when you make the save. Moving this below the `roll.hit` return
         * would compile, pass every save test, and silently delete half of what
         * the mechanic is for.
         */
        if (def.noCtEffect !== true && merged.noCtEffect !== true) {
          crossTierEffect(state, target, applyPower, channel, rng, ctx);
        }

        // :7034-7037. Note the ordering: the duration was computed FIRST and is
        // then thrown away. `saved` and the duration are two separate draws off
        // the same chance, which is why a 90% save can still occasionally eat a
        // full-length stun and a 10% save can occasionally shrug one off.
        if (roll.hit) {
          ctx.log?.({
            actorId: target.id,
            effectId,
            kind: 'negated',
            maximum,
            saveChance: roll.chance,
            savedVs: channel,
          });
          return refusal(SetEffectOutcome.Negated, maximum, roll.chance, channel);
        }
      } else {
        // :7038-7040 — failed the save but scaled to nothing.
        ctx.log?.({
          actorId: target.id,
          effectId,
          kind: 'resisted',
          maximum,
          saveChance: roll.chance,
          savedVs: channel,
        });
        return refusal(SetEffectOutcome.Resisted, maximum, roll.chance, channel);
      }
    } else if (dur <= 0) {
      // A BENEFICIAL effect never reaches :7024's refusal block, but it still
      // lands here with nothing left. ActorTemporaryEffects.lua:119 catches that
      // case for both statuses — `if p.dur <= 0 then return self:removeEffect()`
      // — so refusing is the same outcome by a shorter path.
      return refusal(SetEffectOutcome.Resisted, maximum, roll.chance, channel);
    }
  }

  const instance: EffectInstance = {
    effectId,
    dur,
    maximum,
    minimum: merged.minDur ?? 0,
    // :7028 — `p.total_dur = p.dur`. What the UI's shrinking bar divides by.
    totalDur: dur,
    // :7015 — `p.amount_decreased = p.maximum - p.dur`. THE PARTIAL SAVE, in
    // turns. This is the number the Case Log's "1 turn, not 3" is built from.
    amountDecreased: maximum - dur,
    savedVs,
    saveChance: saveChance ?? 100,
    params: merged,
  };

  // ── STACKING — ActorTemporaryEffects.lua:122-130 ─────────────────────────
  const table = state.byActor.get(target.id) ?? new Map<string, EffectInstance>();
  const live = table.get(effectId);
  if (live !== undefined) {
    switch (def.stackMode) {
      case StackMode.Ignore:
        return {
          outcome: SetEffectOutcome.Ignored,
          dur: live.dur,
          maximum,
          saveChance,
          savedVs,
          effect: live,
        };
      case StackMode.Stack: {
        // :123-125 — `self.tmp[eff_id] = ed.on_merge(self, self.tmp[eff_id], p, ed)`.
        const kept =
          def.onMerge === undefined
            ? extendMerge(live, instance)
            : def.onMerge({ state, actor: target, eff: live, def, rng, ctx, incoming: instance });
        table.set(effectId, kept);
        state.byActor.set(target.id, table);
        recomputeAttributes(state, target);
        if (def.wielder !== undefined) ctx.sheetDirty?.(target.id);
        ctx.log?.({ actorId: target.id, effectId, kind: 'merged', dur: kept.dur, maximum });
        return {
          outcome: SetEffectOutcome.Merged,
          dur: kept.dur,
          maximum,
          saveChance,
          savedVs,
          effect: kept,
        };
      }
      case StackMode.Refresh:
        // :128 — remove and re-add. `deactivate` genuinely runs, which is what
        // lets an effect that grabbed something on the way in let go of it.
        removeEffect(state, target, effectId, rng, ctx, true);
        break;
    }
  }

  // :132 — `self.tmp[eff_id] = p`.
  const fresh = state.byActor.get(target.id) ?? table;
  fresh.set(effectId, instance);
  state.byActor.set(target.id, fresh);

  // :147 — `if ed.activate then ed.activate(self, p, ed) end`. AFTER the
  // instance is in the table, so a hook that reads `effectsOn` sees itself.
  def.activate?.({ state, actor: target, eff: instance, def, rng, ctx });
  recomputeAttributes(state, target);
  // A CONTRIBUTING EFFECT JUST LANDED. See `EffectCtx.sheetDirty`.
  if (def.wielder !== undefined) ctx.sheetDirty?.(target.id);

  ctx.log?.({
    actorId: target.id,
    effectId,
    kind: 'gained',
    dur,
    maximum,
    ...(saveChance === null ? {} : { saveChance }),
    ...(savedVs === null ? {} : { savedVs }),
  });

  return { outcome: SetEffectOutcome.Applied, dur, maximum, saveChance, savedVs, effect: instance };
}

/**
 * The default `StackMode.Stack` merge when a definition supplies no `onMerge`:
 * EXTEND, capped at the longer of the two `maximum`s.
 *
 * Not a ToME line — upstream simply has no default, because an effect either
 * declares `on_merge` or is replaced. The cap exists so that ten small
 * applications cannot out-last what any single one of them could ask for, which
 * is the failure mode that makes stacking effects degenerate.
 */
function extendMerge(live: EffectInstance, incoming: EffectInstance): EffectInstance {
  const cap = Math.max(live.maximum, incoming.maximum);
  live.dur = Math.min(cap, live.dur + incoming.dur);
  live.totalDur = Math.max(live.totalDur, live.dur);
  return live;
}

// ---------------------------------------------------------------------------
// removeEffect / dispel — ActorTemporaryEffects.lua:176-200
// ---------------------------------------------------------------------------

/**
 * Drop one effect, running `deactivate` first.
 *
 * `silent` suppresses the log line and is set by the `Refresh` path, because a
 * re-application is one event and logging "you are no longer stunned" in the
 * middle of being re-stunned is worse than saying nothing.
 *
 * NOT PORTED: the `__setting_up` deferral at :181-189, which exists because
 * ToME's `on_gain` can trigger a removal of the effect being installed while
 * `game:onTickEnd` is available to defer it. There is no tick-end queue in a
 * synchronous engine, and no hook here can re-enter `setEffect` for the same
 * effect id — `activate` runs after insertion and the three MVP effects do not
 * apply statuses. If one ever does, this is the line it will trip over.
 */
/**
 * ═══════════════════════════════════════════════════════════════════════════
 * SOMETHING HIT THIS BODY — TAKE OFF EVERYTHING THAT CANNOT SURVIVE THAT.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Returns the display names of what came off, so a caller can say so; empty is
 * the overwhelmingly common case and costs one map lookup.
 *
 * ═══ THE CALLER DECIDES WHAT COUNTS AS DAMAGE, AND ONE ALREADY DOES ═══
 * `TalentResolution.noteStruck` fires on a blow that HIT and dealt more than
 * zero — a miss does not count and neither does a 0-damage blow (see
 * `noteBlows`). That is precisely upstream's condition, and it means this
 * function never has to define damage itself.
 *
 * COLLECTED BEFORE REMOVING, because `removeEffect` mutates the same table
 * `effectsOn` reads from, and iterating a live view while deleting from it is
 * how one of two simultaneous dazes survives.
 */
export function breakDamageSensitive(
  state: EffectState,
  actor: EffectActor,
  rng: Rng,
  ctx: EffectCtx = NO_CTX,
): readonly string[] {
  const doomed: string[] = [];
  for (const eff of effectsOn(state, actor.id)) {
    if (state.defs.get(eff.effectId)?.breaksOnDamage === true) doomed.push(eff.effectId);
  }
  if (doomed.length === 0) return [];

  const shed: string[] = [];
  for (const id of doomed) {
    const name = state.defs.get(id)?.displayName;
    removeEffect(state, actor, id, rng, ctx);
    if (name !== undefined) shed.push(name);
  }
  return shed;
}

export function removeEffect(
  state: EffectState,
  actor: EffectActor,
  effectId: string,
  rng: Rng,
  ctx: EffectCtx = NO_CTX,
  silent = false,
): boolean {
  const table = state.byActor.get(actor.id);
  const eff = table?.get(effectId);
  if (table === undefined || eff === undefined) return false;

  const def = state.defs.get(effectId);
  // :192-196 — deactivate BEFORE the instance leaves the table, so a hook can
  // still read its own parameters.
  def?.deactivate?.({ state, actor, eff, def, rng, ctx });

  table.delete(effectId);
  if (table.size === 0) state.byActor.delete(actor.id);
  recomputeAttributes(state, actor);
  /**
   * AND IT HAS TO FIRE ON THE WAY OUT TOO. See `EffectCtx.sheetDirty`.
   *
   * `recomposeCombat` rebuilds from base and folds only what is STILL live, so
   * removal needs no undo — but it does need the rebuild, or the body keeps the
   * defence of a buff that expired until something else happens to ask for one.
   * An expiry nobody notices is the worse half of this bug: the grant is
   * visible, the overstay is not.
   */
  if (def?.wielder !== undefined) ctx.sheetDirty?.(actor.id);

  if (!silent) ctx.log?.({ actorId: actor.id, effectId, kind: 'lost' });
  return true;
}

/**
 * Remove every live effect matching a predicate; returns how many went.
 *
 * The predicate shape is ToME's `timedEffects(filter)` (:73) reused, so "every
 * physical detrimental effect" is `(def) => def.type === 'physical' && ...` in
 * both places rather than two different filter conventions.
 */
export function dispel(
  state: EffectState,
  actor: EffectActor,
  filter: (def: EffectDef, eff: EffectInstance) => boolean,
  rng: Rng,
  ctx: EffectCtx = NO_CTX,
): number {
  const table = state.byActor.get(actor.id);
  if (table === undefined) return 0;

  const doomed: string[] = [];
  for (const [effectId, eff] of table) {
    const def = state.defs.get(effectId);
    if (def !== undefined && filter(def, eff)) doomed.push(effectId);
  }
  for (const effectId of doomed) removeEffect(state, actor, effectId, rng, ctx);
  return doomed.length;
}

/** Every detrimental effect resisted by one channel. The shape a cure takes. */
export function dispelChannel(
  state: EffectState,
  actor: EffectActor,
  channel: SaveChannel,
  rng: Rng,
  ctx: EffectCtx = NO_CTX,
): number {
  return dispel(
    state,
    actor,
    (def) => def.type === channel && def.status === EffectStatus.Detrimental,
    rng,
    ctx,
  );
}

// ---------------------------------------------------------------------------
// timedEffects — ActorTemporaryEffects.lua:74-98
// ---------------------------------------------------------------------------

/** What one actor's status pass did. The scheduler turns this into log lines. */
export type TickReport = {
  /** Effect ids whose `onTimeout` fired this turn. */
  readonly ticked: readonly string[];
  /** Effect ids removed this turn — expired, or `onTimeout` returned true. */
  readonly expired: readonly string[];
  /**
   * Is `no_talents_cooldown` set AFTER the pass? tome/class/Actor.lua:606 reads it AFTER
   * :597's `timedEffects()`, so an effect that expired this turn has already
   * released the freeze by the time cooldowns tick.
   */
  readonly noTalentsCooldown: boolean;
};

const EMPTY_REPORT: TickReport = Object.freeze({
  ticked: Object.freeze([]),
  expired: Object.freeze([]),
  noTalentsCooldown: false,
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE TICK — ActorTemporaryEffects.lua:74-98. ORDER IS THE WHOLE FUNCTION.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ```lua
 * for eff, p in pairs(self.tmp) do
 *   def = _M.tempeffect_def[eff]
 *   if not filter or filter(def, p) then
 *     if p.dur <= 0 then
 *       todel[#todel+1] = eff                       -- :80-81
 *     else
 *       if def.on_timeout then
 *         if def.on_timeout(self, p, def) then todel[#todel+1] = eff end   -- :85-86
 *       end
 *     end
 *     p.dur = p.dur - def.decrease                  -- :91  ← AFTER on_timeout
 *   end
 * end
 * while #todel > 0 do self:removeEffect(table.remove(todel)) end           -- :95-97
 * ```
 *
 * ═══ THE DECREMENT COMES AFTER THE TIMEOUT (:91 after :85) ═══
 * `dur: 1` therefore means "fires exactly once". Move the decrement above the
 * hook and every DoT loses its last tick and every stun ends a turn early.
 *
 * ═══ AN EXPIRED EFFECT SURVIVES ONE EXTRA TICK (:80-81) ═══
 * Reaching `dur == 0` does not remove it; the NEXT pass sees `dur <= 0` and
 * queues the removal, and `on_timeout` does NOT fire on that pass. So a 2-turn
 * bleed ticks on turns 1 and 2 and is gone at the start of turn 3, having dealt
 * damage exactly twice. docs/tome-mechanics.md § 6 states this correctly and it
 * is still the single easiest thing in the file to get backwards.
 *
 * ═══ IT RUNS ON THE BASE CLOCK ═══
 * Called from `actBase` (tome/class/Actor.lua:597), between `regenLife` (:525) and
 * `cooldownTalents` (:606). Once per GAME TURN at any speed. Nothing in here
 * reads a speed multiplier.
 *
 * DETERMINISM DEVIATION, DELIBERATE: upstream iterates `pairs(self.tmp)`, a Lua
 * hash order that is not reproducible across runs. This iterates a `Map` in
 * insertion order. Two bleeds landing in a different order must not produce a
 * different total, and with a Lua hash order they could.
 */
export function timedEffects(
  state: EffectState,
  actor: EffectActor,
  rng: Rng,
  ctx: EffectCtx = NO_CTX,
  filter?: (def: EffectDef, eff: EffectInstance) => boolean,
): TickReport {
  const table = state.byActor.get(actor.id);
  if (table === undefined || table.size === 0) return EMPTY_REPORT;

  const ticked: string[] = [];
  const doomed: string[] = [];

  // Snapshot: `onTimeout` may kill the actor, and a dead actor's table can be
  // dropped by `forgetActor` from a death hook. Iterating a copy keeps the pass
  // well-defined either way.
  for (const [effectId, eff] of [...table]) {
    const def = state.defs.get(effectId);
    if (def === undefined) {
      doomed.push(effectId);
      continue;
    }
    if (filter !== undefined && !filter(def, eff)) continue;

    if (eff.dur <= 0) {
      // :80-81 — expired last turn. Queue it, and do NOT fire the hook.
      doomed.push(effectId);
    } else if (def.onTimeout !== undefined) {
      // :83-89.
      ticked.push(effectId);
      if (def.onTimeout({ state, actor, eff, def, rng, ctx })) doomed.push(effectId);
    }

    // :91 — AFTER the hook, unconditionally, including for the expired branch.
    eff.dur -= def.decrease;
  }

  // :95-97.
  for (const effectId of doomed) removeEffect(state, actor, effectId, rng, ctx);

  return {
    ticked,
    expired: doomed,
    noTalentsCooldown: noTalentsCooldown(state, actor.id),
  };
}

// ---------------------------------------------------------------------------
// Derived attributes — the `addTemporaryValue` / `removeTemporaryValue` pair
// ---------------------------------------------------------------------------

/**
 * Every modifier from every live effect, composed.
 *
 * Booleans OR; numbers sum. Cheap enough to call per query — an actor carries
 * at most a handful of effects and this is a turn-based game.
 */
export function effectModifiers(state: EffectState, actorId: string): EffectModifiers {
  const table = state.byActor.get(actorId);
  if (table === undefined || table.size === 0) return {};

  let stunned = false;
  let dazed = false;
  let scoured = false;
  let breached = false;
  let freeze = false;
  let globalSpeedAdd = 0;
  let apPenalty = 0;
  let mpPenalty = 0;
  let movementSpeedAdd = 0;
  let confusedPercent = 0;

  for (const [effectId, live] of table) {
    const mods = state.defs.get(effectId)?.modifiers;
    if (mods === undefined) continue;
    stunned = stunned || mods.stunned === true;
    dazed = dazed || mods.dazed === true;
    scoured = scoured || mods.scoured === true;
    breached = breached || mods.breached === true;
    freeze = freeze || mods.noTalentsCooldown === true;
    globalSpeedAdd += mods.globalSpeedAdd ?? 0;
    apPenalty += mods.apPenalty ?? 0;
    mpPenalty += mods.mpPenalty ?? 0;
    movementSpeedAdd += mods.movementSpeedAdd ?? 0;
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE ONE MODIFIER READ OFF THE INSTANCE RATHER THAN THE DEFINITION.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `mental.lua:80` is `addTemporaryValue("confused", eff.power)` — `eff`,
     * not the definition — and the two genuinely differ, because `:78` REDUCES
     * that instance's power by the wearer's `confusion_immune` before storing
     * it. Reading the definition's fifty here would compose the number the
     * effect was authored with rather than the one that actually landed, and
     * partial confusion immunity would show on the sheet and do nothing.
     *
     * The definition's value is still the fallback, so an effect that declares
     * `confusedPercent` without a `power` parameter behaves as written.
     */
    if (mods.confusedPercent !== undefined) {
      const own = live.params['power'];
      confusedPercent += typeof own === 'number' ? own : mods.confusedPercent;
    }
  }

  return {
    stunned,
    dazed,
    scoured,
    breached,
    noTalentsCooldown: freeze,
    globalSpeedAdd,
    apPenalty,
    mpPenalty,
    movementSpeedAdd,
    confusedPercent,
  };
}

/**
 * ═══ THE COOLDOWN FREEZE — tome/class/Actor.lua:606 ═══
 *
 * ```lua
 * -- Cooldown talents after effects, because some of them involve breaking sustains.
 * if not self:attr("no_talents_cooldown") then self:cooldownTalents() end
 * ```
 *
 * THIS IS WHY A STUNNED ACTOR'S COOLDOWNS FREEZE. It is one line, it has no
 * visible symptom when it is missing, and without it stun is a minor damage
 * debuff instead of the thing that ends a fight — the victim simply waits it
 * out with a full bar of talents ready. `engine/actor.ts#actBase` takes this as
 * its `statusPass` callback's return value and skips `tickCooldowns` on `true`.
 *
 * Read AFTER `timedEffects` (:597 before :606), so a stun expiring this turn has
 * already released the freeze and cooldowns tick normally on that same turn.
 */
export function noTalentsCooldown(state: EffectState, actorId: string): boolean {
  const table = state.byActor.get(actorId);
  if (table === undefined) return false;
  for (const effectId of table.keys()) {
    if (state.defs.get(effectId)?.modifiers?.noTalentsCooldown === true) return true;
  }
  return false;
}

/** Points to remove from a PLAYER's per-turn budget refill. See content/effects.ts. */
export type BudgetPenalty = {
  readonly ap: number;
  readonly mp: number;
};

/**
 * THE PLAYER HALF OF SLOW — D1's asymmetry, made explicit.
 *
 * A player's `globalSpeed` is the literal type `1` and readonly, because the
 * party barrier only parks once per turn at full quorum while everyone stays
 * phase-locked (engine/actor.ts). So a slow on a player CANNOT touch the clock;
 * it removes points from the intra-turn budget instead.
 *
 * The caller applies this immediately after the refill in
 * `talentEngine.actBase` (`sheet.ap = sheet.maxAp; sheet.mp = sheet.maxMp;`) —
 * a QUERY rather than a stateful subtraction, precisely because that refill
 * would clobber anything subtracted earlier in the turn.
 */
export function budgetPenalty(state: EffectState, actorId: string): BudgetPenalty {
  const mods = effectModifiers(state, actorId);
  return { ap: mods.apPenalty ?? 0, mp: mods.mpPenalty ?? 0 };
}

/**
 * STAGE THREE OF THE SINGLE WRITER: the effect-derived attributes.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE OWNERSHIP SPLIT, STATED HERE AND RESTATED VERBATIM AT THE OTHER SITE
 * (world/world.ts#reclothePlayer). NEITHER CLAIMS THE OTHER'S AUTHORITY.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *     `actor.baseCombat` is OWNED BY THE THING THAT DRESSES THE BODY —
 *         `createPlayerActor`, `createMonsterActor`, and `reclothePlayer`.
 *         Nothing else writes it, ever.
 *     `actor.equipped` is OWNED BY THE EQUIPMENT VERBS.
 *     `actor.combat` is OWNED BY `recomposeCombat` BELOW, and by nothing else.
 *         It is DERIVED — baseCombat, then gear, then these flags — and any
 *         writer that skips a stage produces a body whose sheet cannot be
 *         reproduced from its own fields.
 *
 * THIS FUNCTION IS THE LAST OF THE THREE STAGES and is deliberately still
 * exported and still callable on its own: an effect landing or expiring changes
 * flags and NOTHING ELSE, so re-running the gear fold on every tick of every DoT
 * would be pure waste. Spreading the live sheet is safe precisely because the
 * two earlier stages never touch `flags` — `Wielder` has no flag field to grant
 * (content/items.ts) — so this cannot drop a gear contribution and the gear fold
 * cannot drop a status.
 *
 * ═══ RECOMPUTE FROM A BASELINE, DO NOT PATCH INCREMENTALLY ═══
 * ToME uses `addTemporaryValue` / `removeTemporaryValue` handle pairs
 * (physical.lua:491-493 and :507-509), which are exact but require every
 * `activate` to have a matching `deactivate` that reverses precisely what it
 * did. Two slows landing and one expiring is where that bookkeeping breaks.
 *
 * Here the pre-effect value is snapshotted once (`baseFlags`,
 * `baseGlobalSpeed`) and the live set is re-composed on top of it after EVERY
 * state change. Idempotent, order-independent, and it cannot leak a modifier
 * when a hook throws. Same observable behaviour, no handles.
 *
 * engine/equipment.ts follows this same argument for gear, and cites this
 * paragraph as the precedent. That is not decoration: the two systems both write
 * one field, and they are only safe together because BOTH recompose from a
 * baseline rather than patching each other's output.
 *
 * `flags` is rebuilt as a new object because `Combatant.flags` and every field
 * inside `StatusFlags` are readonly — which is the correct shape, since a
 * derived getter must never be able to write one.
 */
export function recomputeAttributes(state: EffectState, actor: EffectActor): void {
  const mods = effectModifiers(state, actor.id);

  // --- combat sheet flags ---------------------------------------------------
  if (!state.baseFlags.has(actor.id)) state.baseFlags.set(actor.id, actor.combat?.flags);
  const base = state.baseFlags.get(actor.id);
  const sheet = actor.combat;

  const flags: StatusFlags = {
    dazed: (base?.dazed ?? false) || mods.dazed === true,
    scoured: (base?.scoured ?? false) || mods.scoured === true,
    breached: (base?.breached ?? false) || mods.breached === true,
    stunned: (base?.stunned ?? false) || mods.stunned === true,
    // ADDED, NOT OR'D, because it is a percentage — `mental.lua:80` sums it
    // through `addTemporaryValue` like any other temporary attribute. Bounded
    // where it is ROLLED rather than here, so the number a tooltip prints is
    // the number the effects actually granted.
    confused: (base?.confused ?? 0) + (mods.confusedPercent ?? 0),
  };
  // A FRESH OBJECT, never a write into `sheet`. Stage two hands this stage a
  // FROZEN sheet (`composeSheet` freezes its output), and an in-place write onto
  // it would throw in strict mode — which is the correct outcome and also the
  // reason it can never silently corrupt a shared `ClassDef.combat`.
  actor.combat = { ...sheet, flags };

  // --- the energy GAIN multiplier (MONSTERS ONLY — D1) ----------------------
  // The `kind` check is the D1 enforcement. `PlayerActor.globalSpeed` is
  // `readonly 1`, but TypeScript ignores `readonly` for assignability, so the
  // structural `EffectActor` above would happily let this write to a player.
  // It does not, and this is one of exactly two places that could.
  if (actor.kind === ActorKind.Monster) {
    const current = actor.globalSpeed ?? 1;
    if (!state.baseGlobalSpeed.has(actor.id)) state.baseGlobalSpeed.set(actor.id, current);
    const baseSpeed = state.baseGlobalSpeed.get(actor.id) ?? current;
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * SYMMETRIC SCALING — Actor.lua:3910-3913. A SLOW DIVIDES; IT DOES NOT
     * SUBTRACT.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * ```lua
     * if self.global_speed_add >= 0 then self.global_speed = base + add
     * else self.global_speed = base / (1 + math.abs(add))  -- Symmetric scaling
     * end
     * ```
     *
     * This line was `max(0.1, base + add)` for both signs, and the comment
     * beside it said the floor existed because *"a stacked slow must not reach
     * zero"* — which is true, and is the symptom rather than the rule. Upstream
     * does not need a floor to stop a slow reaching zero: division cannot get
     * there. The floor is a backstop for a base speed authored at zero.
     *
     * ═══ THE DIFFERENCE IS NOT SMALL ═══
     * At `SLOW_POWER = 0.3`: one slow was 0.70 against upstream's 0.769; TWO
     * were 0.40 against 0.625; FOUR were 0.10 — the floor, a body that has
     * effectively stopped — against 0.455. Stacking slows was a hard disable
     * here and a diminishing return upstream, and "a +N and a −N compose back
     * to 1" was false.
     *
     * `recomputeGlobalSpeed` in `shared/energy.ts` has been the correct port of
     * this since it was written, with the asymmetry spelled out in its docblock,
     * and had NO caller anywhere in `src/` — found by walking every exported
     * function in the engine and shared layers for readers, with comments
     * stripped. The same shape as `getTierDiff`, which shipped unused for months.
     */
    actor.globalSpeed = recomputeGlobalSpeed(baseSpeed, mods.globalSpeedAdd ?? 0);
  }
}

/**
 * An actor that can wear things. `EffectActor` plus the three fields
 * engine/actor.ts added to `ActorCommon`.
 *
 * Structural rather than `EngineActor`, like every other actor type in this
 * directory: a bare test fixture with an id, a sheet and an `equipped` map is a
 * valid input, and widening it to the real actor would drag the energy clocks
 * and the barrier's control flags into every equipment unit test.
 */
export type EquippedActor = EffectActor & {
  /** The sheet before gear and before statuses. See engine/actor.ts. */
  baseCombat?: CombatSheet;
  /**
   * The attribute points this character has spent, as a delta over the class
   * sheet. Folded at stage one and a half — see `recomposeCombat` and the field's
   * own note in engine/actor.ts.
   */
  spentStats?: PrimaryStats;
  equipped?: Partial<Record<Slot, string>>;
  carried?: readonly string[];
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * WHAT THIS BODY'S PASSIVE TALENTS ARE WORTH, SUMMED AT THEIR RANKS.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * ToME's `passives = function(self, t, p) self:talentTemporaryValue(p,
   * "combat_def", ...) end` writes a passive's contribution onto the ACTOR, and
   * every getter then reads it without knowing a talent was involved
   * (buckler-training.lua:183-186). This is that, in one field.
   *
   * OWNED BY THE TALENT LAYER, exactly as `equipped` is owned by the equipment
   * verbs and `baseCombat` by whatever dresses the body — see the essay on
   * `recomposeCombat` below, which is still the only writer of `combat` itself.
   * Keeping it a stored contribution rather than a lookup is what lets this file
   * stay unable to import the talent registry, which it must.
   */
  passiveCombat?: PassiveContribution;
};

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT THIS BODY HAS BOUGHT — the class sheet plus the attribute points spent,
 * and NOTHING WORN.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ToME's `getStat(sid, nil, nil, true)`: the fourth argument is `no_inc` and it
 * drops `inc_stats` — every increment from gear, effects and temporary sources.
 * Upstream asks for exactly this in three places and they are all the same
 * question: how high has the PLAYER pushed this attribute, as opposed to how
 * high are they standing today.
 *
 * ═══ EXPORTED, BECAUSE THE ANSWER IS NEEDED OUTSIDE THE FOLD ═══
 * `recomposeCombat` uses it as stage one and a half. The gateway uses it for
 * `statCeilingForLevel` — a ceiling asked of the COMPOSED value would let a good
 * coat cost you the ability to spend a point you own — and to send the base to
 * the client, which draws `25 (20)` the way upstream's dialog does
 * (LevelupDialog.lua:624-627).
 *
 * ONE COMPUTATION AND NOT THREE. The gateway could reach `classById(...)` and
 * add `spentStats` itself; that would be a second opinion about what a base is,
 * and the first thing to drift would be the day something else joins the fold
 * below gear.
 */
export function boughtSheet(
  actor: { readonly spentStats?: PrimaryStats },
  baseSheet: CombatSheet | undefined,
): CombatSheet | undefined {
  const grown = actor.spentStats;
  return grown === undefined || baseSheet === undefined
    ? baseSheet
    : composeWielders(baseSheet, [{ stats: grown }]);
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *        THE SINGLE WRITER OF `actor.combat`. THE ORDER IS FIXED.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *     1. baseCombat                       — the class sheet, untouched
 *     2. composeSheet(worn gear)          — engine/equipment.ts, additive
 *     3. recomputeAttributes(flags)       — directly above
 *
 * Call it after ANY change to any of the three inputs: a class chosen, an item
 * equipped or dropped, a save restored. It is idempotent — running it twice in a
 * row produces an equal sheet — which is the property that makes it safe to call
 * defensively rather than exactly once.
 *
 * ═══ WHY THIS FIXED A LIVE BUG RATHER THAN MERELY TIDYING ═══
 * `actor.combat` had TWO competing writers before this function existed:
 * `recomputeAttributes` above, which PRESERVES an earlier merge by spreading,
 * and `world.ts#reclothePlayer`, which did `actor.combat = overlay.combat` and
 * destroyed one wholesale. The second is the character-creation path. A player
 * who picked up and equipped a coat and then finished choosing their class
 * silently lost the coat's contribution — the id stayed in `equipped`, the
 * inventory screen kept drawing it, and the armour it granted was gone with
 * nothing failing anywhere.
 *
 * ═══ `state` MAY BE null, AND THAT IS NOT A CONVENIENCE ═══
 * `world/world.ts` cannot see the status system — it imports the actor MODEL and
 * nothing else from engine/, which is what keeps `world -> engine` one-way — so
 * it genuinely has no `EffectState` to pass. `null` means "this caller cannot
 * speak for stage three", and the honest answer is then to CARRY THE LIVE FLAGS
 * FORWARD UNCHANGED: stages one and two cannot alter a flag (a `Wielder` has no
 * flag field), so the flags that were on the sheet a line ago are still exactly
 * right. Recomputing them from a baseline this caller cannot read would mean
 * inventing one, and inventing one drops every live status the moment somebody
 * chooses a class mid-fight.
 *
 * ═══ THE IDENTITY SHORT-CIRCUIT IS DELIBERATE ═══
 * A body wearing nothing, carrying no status, gets `actor.combat = baseCombat`
 * BY IDENTITY rather than a copy. `composeSheet` always allocates (that is its
 * contract and its purity test), but allocating a copy of the class sheet for
 * every classless body in the process would be noise — and it would break
 * `expect(body.combat).toBe(ALCHEMIST.combat)`, which is the assertion two
 * suites use to say "the class was applied WHOLESALE, not blended".
 */
export function recomposeCombat(
  actor: EquippedActor,
  state: EffectState | null,
  catalogue: ItemCatalogue,
): void {
  // Read BEFORE stage two overwrites the sheet — see the `state === null` note.
  const liveFlags = actor.combat?.flags;

  // Stage one. A fixture with neither field is an M2-era actor and keeps ToME's
  // bare defaults inside derived.ts, exactly as it did before this existed.
  const baseSheet = actor.baseCombat ?? actor.combat;

  /**
   * Stage one and a half — THE ATTRIBUTE POINTS THIS CHARACTER HAS SPENT.
   *
   * ABOVE THE CLASS SHEET AND BELOW EVERYTHING WORN, because this is the body
   * growing rather than something put on it: a Watchman who has poured nine
   * points into Strength IS stronger, and the coat he then buys adds to that
   * rather than to who he was at level one.
   *
   * `composeWielders` is the same additive combine gear and passives use, so a
   * spent point and a pauldron stack the way a player expects — and the class's
   * authored sheet stays untouched underneath, which is what makes "take the
   * coat off" exact and what lets a retune of any class correct every existing
   * character instead of stranding them.
   */
  const base = boughtSheet(actor, baseSheet);

  // Stage two.
  if (base !== undefined) {
    const worn = wornOf(actor.equipped, catalogue);
    actor.combat = worn.length === 0 ? base : composeSheet(base, worn);
  }

  // Stage two and a half — THE PASSIVE TALENTS. Additive over gear and under
  // status flags, which is where ToME puts them: a passive is a property of the
  // body like a breastplate is, and a stun that zeroes a flag must still win.
  // `composeSheet` is the same additive combine gear uses, so a passive and a
  // pauldron stack the way a player expects rather than replacing each other.
  const passive = actor.passiveCombat;
  if (passive !== undefined && actor.combat !== undefined) {
    actor.combat = composeWielders(actor.combat, [passive]);
  }

  /**
   * Stage two and three quarters — THE LIVE TIMED EFFECTS. See `EffectDef.wielder`.
   *
   * ═══ ABOVE THE PASSIVES AND BELOW THE FLAGS, WHICH IS THE ONLY PLACE IT GOES ═══
   * Above the passives because a buff is temporary and a passive is a property
   * of the body: the thing that fades should stack ON the thing that does not,
   * the way a potion sits on top of a breastplate.
   *
   * Below stage three because that is where `recomputeAttributes` puts the
   * STATUS FLAGS, and stage two and a half's note already states the rule those
   * enforce — *"a stun that zeroes a flag must still win"*. A buff that outranked
   * a stun would be a buff that makes you immune to being stunned, which is a
   * different feature and not this one.
   *
   * ═══ ONLY WHEN THERE IS AN EFFECT TABLE ═══
   * `state === null` is a fixture with no status system, and every one of them
   * keeps the sheet it has always had.
   */
  if (state !== null && actor.combat !== undefined) {
    const blocks: (PassiveContribution | undefined)[] = [];
    for (const instance of effectsOn(state, actor.id)) {
      const contribute = effectDef(state, instance.effectId)?.wielder;
      if (contribute !== undefined) blocks.push(contribute(instance));
    }
    if (blocks.length > 0) actor.combat = composeWielders(actor.combat, blocks);
  }

  // Stage three.
  if (state !== null) {
    recomputeAttributes(state, actor);
  } else if (liveFlags !== undefined && actor.combat !== undefined) {
    actor.combat = { ...actor.combat, flags: liveFlags };
  }
}

/**
 * Adopt an actor's CURRENT attributes as the baseline.
 *
 * Call once at spawn, before any effect lands, when a content template writes
 * flags or a non-1 `globalSpeed` of its own. Without it the first
 * `recomputeAttributes` snapshots whatever is there at that moment, which is
 * the same thing — this exists so the intent is expressible at the call site.
 */
export function noteBaseline(state: EffectState, actor: EffectActor): void {
  state.baseFlags.set(actor.id, actor.combat?.flags);
  if (actor.kind === ActorKind.Monster) {
    state.baseGlobalSpeed.set(actor.id, actor.globalSpeed ?? 1);
  }
}

// ---------------------------------------------------------------------------
// The actBase seam
// ---------------------------------------------------------------------------

/**
 * The callback `engine/actor.ts#actBase` takes, bound to a state and a context.
 *
 * ═══ WHY A CALLBACK AND NOT AN IMPORT ═══
 * `actBase` must run `timedEffects` (tome/class/Actor.lua:597) BEFORE `cooldownTalents`
 * (:606) and must skip the latter when the former leaves `no_talents_cooldown`
 * set. If actor.ts imported this module the graph would close a cycle — this
 * module imports `setCooldown` from actor.ts for STUNNED's talent lockout. A
 * callback keeps the dependency one-way and keeps actor.ts ignorant of statuses.
 *
 * ```ts
 * actBase(actor, statusPass(effects, rng, ctx));
 * ```
 */
export function statusPass(
  state: EffectState,
  rng: Rng,
  ctx: EffectCtx = NO_CTX,
): (actor: EffectActor) => boolean {
  return (actor: EffectActor): boolean => timedEffects(state, actor, rng, ctx).noTalentsCooldown;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE OTHER DIRECTION: SOMETHING WANTS TO *CAUSE* A STATUS.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `statusPass` is the CLOCK — it ticks what is already on a body. This is the
 * DOOR: a talent connects, and asks for a stun. They are deliberately separate
 * closures because they are wanted in different places (the clock by `actBase`,
 * the door by a talent body) and giving either caller the whole `EffectState`
 * would let a talent tick the clock, or `actBase` mint an effect.
 *
 * ═══ WHY A CLOSURE RATHER THAN THE STATE ═══
 * Same reason `statusPass` is one: `engine/talents.ts` must not import this
 * module. The talent layer already owns a small effect system of its own
 * (`TalentEffect` — taunts, marks) and two modules that both export "effects"
 * into each other is how a cycle starts. The closure carries the state, the
 * rng and the log with it, and the talent layer sees a function.
 *
 * THE RNG AND THE LOG COME FROM THE ADAPTER, not from the caller, which is
 * what guarantees a stun rolled inside a talent draws from the same labelled
 * stream — and writes into the same Record — as one rolled anywhere else.
 */
export type StatusApply = (
  target: EffectActor,
  effectId: string,
  duration: number,
  params?: EffectParams,
) => SetEffectResult;

export function statusApplier(state: EffectState, rng: Rng, ctx: EffectCtx = NO_CTX): StatusApply {
  return (target, effectId, duration, params = {}): SetEffectResult =>
    setEffect(state, target, effectId, duration, params, rng, ctx);
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE OTHER DIRECTION: TAKE ONE OFF. `StatusApply`'s twin, and the same shape
 * for the same reason.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A closure rather than the table, so `engine/talents.ts` still never imports
 * this module — the whole argument is written above `StatusApply` and applies
 * here unchanged.
 *
 * ═══ IT RETURNS THE NAME, WHICH IS WHAT THE TALENT NEEDS AND CANNOT GET ═══
 * A boolean would leave the caller writing "shakes something off". The talent
 * layer has no effect catalogue — that is the entire point of the seam — so the
 * only place the display name exists is here. Null means there was nothing of
 * that status on them, which is a REFUSAL upstream at the talent, not a silent
 * success: `field_dressing.ts` refunds on it rather than spending the reagent.
 *
 * ═══ THE MOST RECENTLY APPLIED ONE ═══
 * Not the longest-remaining, which sounds more generous and plays worse: a
 * player cannot see the durations on somebody else's statuses well enough to
 * predict which one a "best" rule would pick, so it would look like the talent
 * chose at random. The last thing that landed is the thing they just watched
 * land. `effectsOn` returns them in application order, so this is its tail.
 */
/**
 * WHICH ONE TO TAKE OFF, where a caller wants to be choosy.
 *
 * ═══ BOTH FIELDS EXIST FOR `Infusion: Wild`, WHICH IS UPSTREAM'S FUSSIEST CURE ═══
 * `inscriptions.lua:152-156` runs TWO removals: every CROSS-TIER effect matching
 * a type table, and then ONE ordinary effect of that type. Without `channel` the
 * cure would take a mental debuff off a body that asked to shake off a physical
 * one; without `crossTierOnly` the two clauses collapse into "remove two", which
 * removes one too many whenever the cross-tier effect is not there.
 *
 * ABSENT MEANS UNFILTERED, so every existing caller is unchanged — `field_dressing`,
 * `healing_infusion` and `nerve` all mean "whatever is worst, take it off".
 */
export type StatusCureOptions = {
  /** Only an effect whose `type` is this channel. */
  readonly channel?: SaveChannel;
  /** Only an effect that `crossTierFor` marks — `EffectState.crossTier`'s values. */
  readonly crossTierOnly?: boolean;
};

export type StatusCure = (
  target: EffectActor,
  status: EffectStatus,
  options?: StatusCureOptions,
) => string | null;

export function statusCurer(state: EffectState, rng: Rng, ctx: EffectCtx = NO_CTX): StatusCure {
  return (target, status, options) => {
    const held = effectsOn(state, target.id);
    // THE CROSS-TIER IDS, as a set, so the filter below is a lookup rather than
    // a scan of the map for every effect on the body.
    const crossTierIds = new Set(state.crossTier.values());
    for (let i = held.length - 1; i >= 0; i -= 1) {
      const instance = held[i];
      if (instance === undefined) continue;
      const def = effectDef(state, instance.effectId);
      if (def === undefined || def.status !== status) continue;
      if (options?.channel !== undefined && def.type !== options.channel) continue;
      if (options?.crossTierOnly === true && !crossTierIds.has(instance.effectId)) continue;
      // `removeEffect` runs the effect's own `onRemove`, which is what puts back
      // whatever it took away — so a cure goes through it rather than deleting
      // the row, exactly as an expiry does.
      if (!removeEffect(state, target, instance.effectId, rng, ctx)) continue;
      return def.displayName;
    }
    return null;
  };
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * MAKE WHAT IS ALREADY WRONG LAST LONGER. Ported from Twist the Knife —
 * cunning/dirty.lua:175-190.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Upstream walks `target.tmp`, adds `dur` to every detrimental effect it finds
 * and stops after `max_nb` of them:
 *
 *     for eff_id, p in pairs(target.tmp) do
 *       local e = target.tempeffect_def[eff_id]
 *       if e.status == "detrimental" and e.type ~= "other" and e.decrease ~= 0 then
 *         p.dur = p.dur + dur
 *
 * ═══ IT IS A THIRD STATUS SEAM AND IT HAS TO BE ═══
 * `TalentCtx` had exactly two — `status` applies and `cure` removes — and
 * NOTHING COULD READ what a body was currently suffering. A whole shape of ToME
 * talent depends on that read: the ones that pay you for a condition somebody
 * else inflicted, which is most of what makes a party's talents combine rather
 * than merely stack. It is the seam that was missing, not one talent.
 *
 * ═══ `dur` IS MUTATED AND `totalDur` GOES WITH IT ═══
 * `EffectInstance.dur` is declared mutable precisely because `timedEffects`
 * decrements it. `totalDur` is "what it started at, for the UI's bar" — leaving
 * it behind would draw a bar that reads six turns of six with eleven left on it.
 * Upstream does not carry a bar so it has no equivalent line; ours does.
 *
 * NO SAVE. Upstream's extension is not rolled against anything — the save was
 * already made, and lost, when the effect landed. Making a body save twice for
 * one affliction is a rule nobody could read off the screen.
 *
 * Returns the display names of what it lengthened, in table order, so the caller
 * can say which — `removeEffect`'s contract, one door along.
 */
export type StatusExtend = (
  target: EffectActor,
  status: EffectStatus,
  turns: number,
  max: number,
) => readonly string[];

export function statusExtender(state: EffectState): StatusExtend {
  return (target, status, turns, max) => {
    if (turns <= 0 || max <= 0) return EMPTY_NAMES;
    const held = effectsOn(state, target.id);
    const touched: string[] = [];
    for (const instance of held) {
      if (touched.length >= max) break;
      const def = effectDef(state, instance.effectId);
      if (def === undefined || def.status !== status) continue;
      // ALREADY EXPIRING IS STILL EXTENDABLE. `dur: 1` means "ticks once more"
      // (see the note at the head of this file), so a 1 is a live effect and
      // lengthening it is the whole point of the talent.
      instance.dur += turns;
      instance.totalDur += turns;
      touched.push(def.displayName);
    }
    return touched;
  };
}

const EMPTY_NAMES: readonly string[] = Object.freeze([]);

/**
 * Put `count` of an actor's ready talents on a 1-turn cooldown.
 *
 * physical.lua:495-504 — STUNNED's talent lockout, and the reason its comment
 * says "Just set cooldown to 1 since cooldown does not decrease while stunned":
 * with the freeze on, that 1 does not tick, so the lockout lasts exactly as long
 * as the stun does and then releases on the turn the stun ends.
 *
 * ```lua
 * for tid, lev in pairs(self.talents) do
 *   if t and not self.talents_cd[tid] and t.mode == "activated" ... then tids[] = t end
 * end
 * for i = 1, 3 do
 *   local t = rng.tableRemove(tids)
 *   if not t then break end
 *   self:startTalentCooldown(t.id, 1)
 * end
 * ```
 *
 * `rng.tableRemove` picks and removes without replacement; a labelled `shuffle`
 * then taking a prefix is the same distribution with one draw sequence instead
 * of `count` of them. Lives here rather than in content/effects.ts so the
 * `setCooldown` import — and therefore the one edge from this module to
 * actor.ts — stays in the engine layer.
 *
 * @returns the talent ids actually locked out.
 */
export function lockoutTalents(
  actor: EffectActor,
  candidates: readonly string[],
  count: number,
  rng: Rng,
  label: string,
): readonly string[] {
  // :498 — `not self.talents_cd[tid]`: a talent already cooling down is not a
  // candidate, because re-setting it to 1 would SHORTEN it.
  const ready = candidates.filter((id) => !actor.cooldowns.has(id));
  if (ready.length === 0 || count <= 0) return [];

  const picked = rng.shuffle(label, ready).slice(0, count);
  for (const id of picked) setCooldown(actor, id, 1); // :503
  return picked;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE FLOOR RECOVERS WHILE NOBODY IS ON IT — Game.lua:1369-1388.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ═══ WHAT IT STOPS ═══
 * Soften a room, walk out, rest to full outside, walk back in to the same
 * half-dead monsters with their cooldowns still spent and your debuffs still on
 * them. `Realm.sealed` already names that failure — *"'run away' and 'pause the
 * fight' would be the same verb"* — and closes it for roaming encounters by
 * sealing them. Every site is still open, and this is what makes walking back in
 * cost something.
 *
 * ═══ THREE THINGS, AND ALL THREE ARE UPSTREAM'S ═══
 * Hostiles heal a tenth of maximum per game turn away (`reentryHealFraction`),
 * every talent cooldown is cleared, and every DETRIMENTAL effect is stripped.
 * Beneficial ones are deliberately left: upstream tests `e.status ==
 * "detrimental"` and nothing else, and a rule that also cancelled a monster's
 * own buffs would be handing the player something for leaving.
 *
 * ═══ HOSTILES ONLY ═══
 * `reactionToward(target) < 0` upstream. A shopkeeper is not part of the fight
 * being paused, and healing one would be a rule about the wrong bodies.
 */
export function restoreOnReentry(
  // `EffectActor` AND NOT THE ENGINE'S ACTOR: this module deliberately does not
  // import `engine/actor.ts`, and everything the rule touches — hp, maxHp,
  // alive, cooldowns — is already on the narrow shape it takes everywhere else.
  actors: readonly EffectActor[],
  /**
   * WHOSE FIGHT THIS IS. Upstream asks `reactionToward(target) < 0`; hostility
   * is a FACTION question and this module has no faction table, so the caller
   * owns it — the same seam `exploreTarget` uses for the same reason. A
   * shopkeeper is not part of the fight being paused.
   */
  isHostile: (actor: EffectActor) => boolean,
  state: EffectState | undefined,
  turnsAway: number,
  rng: Rng,
): void {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * NO TIME, NO RECOVERY — and the guard is upstream's, wrapping everything.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `if self.level.last_turn and self.level.last_turn < self.turn then` (:1370).
   * STRICTLY less: at zero turns away the whole block is skipped, cooldowns and
   * effects included, and it is worth being exact about because the difference
   * is exploitable HERE in a way it cannot be upstream. `follow` costs no game
   * turn, so a player who steps out of a delve and immediately follows a friend
   * back in would otherwise clear every hostile cooldown and strip every debuff
   * the party had landed — for free, as often as they liked. The rule that
   * closes an exploit would have opened a better one.
   *
   * INSIDE THE RULE RATHER THAN AT THE CALLER, because this function IS
   * upstream's block and the guard is the first line of it. A caller-side check
   * would be a second place to remember.
   */
  if (!Number.isFinite(turnsAway) || turnsAway <= 0) return;

  const fraction = reentryHealFraction(turnsAway);

  for (const actor of actors) {
    if (!actor.alive || !isHostile(actor)) continue;

    // THE HEAL IS CLAMPED TO THE CEILING, exactly as upstream's `util.bound`
    // does. A fraction of maximum added to a body already near full must not
    // overshoot into a monster with more life than it was authored with.
    if (fraction > 0) actor.hp = Math.min(actor.maxHp, actor.hp + actor.maxHp * fraction);

    // EVERY COOLDOWN, NOT THE EXPIRED ONES. `talents_cd = {}` upstream: the
    // point is that a monster which spent its big talent on you has it back.
    actor.cooldowns.clear();

    if (state === undefined) continue;
    /**
     * COLLECTED FIRST, THEN REMOVED — AND TODAY THAT IS A GUARD, NOT A FIX.
     *
     * Upstream builds a `todel` list because its `tmp` table IS the live one and
     * deleting mid-walk would skip entries. Ours does not have that bug:
     * `effectsOn` returns `[...table.values()]`, a snapshot, so removing while
     * iterating is already safe. A mutation test confirmed it — rewriting this
     * as a direct remove-in-loop breaks nothing.
     *
     * It is kept because the shape is one `effectsOn` change away from
     * mattering: the day that function returns the live view for cheapness, a
     * direct loop starts silently leaving every second effect on the body, and
     * this is the only place that walks it while deleting. Written down rather
     * than left to look load-bearing, so nobody deletes it believing a test
     * covers it — `NEXUS/knowledge/mistakes-ledger.md`'s second check.
     */
    const doomed: string[] = [];
    for (const instance of effectsOn(state, actor.id)) {
      if (effectDef(state, instance.effectId)?.status === EffectStatus.Detrimental) {
        doomed.push(instance.effectId);
      }
    }
    for (const effectId of doomed) removeEffect(state, actor, effectId, rng);
  }
}
