// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// NUMBERS/SHAPE: t-engine4 game/modules/tome/class/Actor.lua:5580-5627 -- the callback
//                registry; game/modules/tome/data/damage_types.lua:474-480 -- the rewrite
//                contract; Actor.lua's `turn_procs` -- the per-turn latch.
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *   WHERE A TALENT CAN ATTACH. THE THING THIS ENGINE DID NOT HAVE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ═══ THE MEASUREMENT THAT PRODUCED THIS FILE ═══
 * Of 42 shipped talents: 6 grant a raw attribute, 18 grant a flat combat
 * modifier, 18 are actives, and ZERO are conditional or behavioural. 57% of
 * every talent in the game is a number going up.
 *
 * That was never a content decision. It is what the type permitted:
 *
 *     readonly passive?: (level: number) => PassiveContribution;
 *     export type PassiveContribution = NonNullable<Item['wielder']>;
 *
 * A passive received ONLY a level — not the actor, not the attacker, not the
 * board, not what had just happened — and what it returned was *the same shape
 * a worn item returns*. A passive talent was modelled as a piece of equipment,
 * so it could only ever be stats and mods, because that is all a breastplate
 * can be. "When you are hit", "while below half health", "for each adjacent
 * enemy" were not hard to write. They were unsayable.
 *
 * ═══ WHAT UPSTREAM ACTUALLY DOES, MEASURED ═══
 * ToME's variety does not come from a richer passive installer. It comes from
 * having somewhere to attach:
 *
 *   - Only 17% of its 296 passives use the `passives = function` installer this
 *     engine copied. 13.5% register a `callbackOn*`. SEVENTY PERCENT have no
 *     body at all — the rule lives in engine code gated on `knowTalent`, which
 *     is why Combat.lua alone holds 98 `knowTalent` checks.
 *   - The whole system hangs off ONE prioritised bus of 45 named events
 *     (Actor.lua:5580-5627) that talents, timed effects and equipped objects
 *     all register into identically.
 *   - Across a hand-read sample of 60 passives: 22% were pure numbers, 57%
 *     changed a rule and added no number at all, and every single one that
 *     declared a callback was a rule-changer.
 *
 * ═══ TEN EVENTS, NOT FORTY-FIVE ═══
 * Upstream has 45 because it has 1,267 talents and twenty years. The shapes
 * that matter reduce to a handful, and an event nobody listens to is a name
 * somebody has to read past. New events are cheap to add and expensive to
 * remove, so this starts small and grows on demand.
 *
 * ═══ RESOLVED AT DISPATCH, NOT REGISTERED AT LEARN ═══
 * ToME registers handlers when a talent is learned and unregisters on unlearn,
 * because it is dispatching for hundreds of actors in real time. This engine
 * has under ten players with a handful of talents each, resolving synchronously.
 *
 * So there is NO registration step, deliberately. A registry that must be kept
 * in step with the sheet is a second list that can disagree with the first —
 * the exact shape that has cost this codebase six separate bugs. `bindHooks`
 * folds the sheet into a flat array in the SAME pass `refreshPassives` already
 * makes, and that array is the only copy. Learn a talent, the fold re-runs;
 * there is nothing to forget to unregister.
 */

import type { DamageType } from './damage.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE PER-TURN LATCH, AND IT COMES BEFORE THE TRIGGERS, NOT AFTER.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ToME reaches for `turn_procs` 192 times, and every on-hit or on-crit rider
 * depends on it. Without one, a passive that fires "when you are hit" fires
 * once per DAMAGE INSTANCE — so a two-hit talent triggers it twice, an
 * area-of-effect triggers it once per victim, and a damage-over-time triggers
 * it every turn it ticks. Every such talent then has to hand-limit itself, and
 * they will not all remember to.
 *
 * Three uses, all worth having, and the difference between them is a design
 * decision the talent author has to make rather than one this file can make
 * for them (upstream latches Hidden Blades on the TARGET and Celerity on
 * SELF):
 *
 *   `once('unflinching')`               a plain flag: first time this turn
 *   `once(`riposte:${attackerId}`)`     once per attacker
 *   `once(`cleave:${targetId}`)`        once per victim
 *
 * CLEARED IN THE SAME LINE THAT CLEARS `movedThisTurn` — the base-turn tick in
 * engine/talents.ts. One clock, one clearing point. A second place that reset
 * this would be a second answer to "when does a turn begin".
 */
export type TurnProcs = {
  /**
   * TRUE THE FIRST TIME THIS KEY IS ASKED FOR THIS TURN, false every time after.
   * The name is a verb because it consumes: asking is what spends it.
   */
  once(key: string): boolean;
  /** Whether a key has already been taken, without taking it. */
  seen(key: string): boolean;
  /** Called by the base-turn tick. Never by a talent. */
  clear(): void;
};

export function createTurnProcs(): TurnProcs {
  const taken = new Set<string>();
  return {
    once: (key: string): boolean => {
      if (taken.has(key)) return false;
      taken.add(key);
      return true;
    },
    seen: (key: string): boolean => taken.has(key),
    clear: (): void => {
      taken.clear();
    },
  };
}

/**
 * The minimum an engine hook may know about the body it is attached to.
 *
 * DELIBERATELY NARROW. A hook that could see the whole world would be a hook
 * that could reach the network layer, and `engine -> net` is a dependency this
 * project forbids and ESLint enforces. Widen this when a real talent needs it,
 * and not before.
 */
export type HookSelf = {
  readonly id: string;
  readonly name: string;
  hp: number;
  readonly maxHp: number;
  readonly alive: boolean;
  readonly x: number;
  readonly y: number;
};

/** What every handler is handed. `level` is the EFFECTIVE talent level. */
export type HookCtx = {
  readonly self: HookSelf;
  readonly level: number;
  readonly procs: TurnProcs;
};

// ---------------------------------------------------------------------------
// The events
// ---------------------------------------------------------------------------

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * DAMAGE ARRIVING — AND THIS ONE IS A REWRITE CHAIN, NOT A NOTIFICATION.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The single most valuable contract in this file, and the reason it is worth
 * doing before any other event. Upstream's is four lines
 * (damage_types.lua:474-480):
 *
 * ```lua
 * if ret.dam then dam = ret.dam end
 * if ret.stopped then return ret.stopped end
 * ```
 *
 * A handler that can REWRITE the number, rather than merely watch it, turns a
 * whole family of designs into ordinary talents instead of engine features:
 * blocks, shields, thresholded mitigation ("no single blow takes more than a
 * quarter of you"), redirection, retaliation, reflection, damage caps, and
 * last-stand effects that refuse to let a blow be lethal.
 *
 * Every one of those is currently impossible here, and none of them needs a
 * line of engine code once this exists.
 *
 * ═══ HANDLERS SEE THE FIGURE AS IT STANDS ═══
 * Each runs in turn on the value the previous one left, so two mitigations
 * compose the way a reader expects rather than both reducing the original and
 * silently double-counting.
 *
 * ═══ AND THE POINT IN THE PIPELINE IS DELIBERATE ═══
 * This fires on the FINAL figure — after armour, resists and crit, immediately
 * before hit points move. A hook upstream of the mitigation maths would be
 * rewriting an input nobody can reason about; a talent that says "cap a blow at
 * 20" means the blow that lands, not a number three multiplications from it.
 */
export type IncomingDamage = {
  /** The figure as it stands after every previous handler. */
  readonly dam: number;
  readonly type: DamageType;
  /** Who is to blame. Identity only — the maths already happened. */
  readonly sourceId: string;
  /** True when this blow would take the body to zero, before any handler runs. */
  readonly lethal: boolean;
};

/**
 * `dam` REPLACES the figure; `stopped` refuses the blow outright.
 *
 * Returning nothing means "I did not care about this one", which is the
 * overwhelmingly common case and must therefore be the cheapest thing to write.
 */
export type DamageEdit = {
  readonly dam?: number;
  readonly stopped?: boolean;
};

export type TakeDamageHook = (ctx: HookCtx, incoming: IncomingDamage) => DamageEdit | void;

/** A blow this body landed. Notification only — the damage has already resolved. */
export type OutgoingHit = {
  readonly targetId: string;
  readonly dam: number;
  readonly type: DamageType;
  readonly crit: boolean;
  readonly killed: boolean;
};

export type DealDamageHook = (ctx: HookCtx, hit: OutgoingHit) => void;
export type TurnStartHook = (ctx: HookCtx) => void;
export type KillHook = (ctx: HookCtx, victimId: string) => void;

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT A TALENT DECLARES.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * OPTIONAL, AND ORTHOGONAL TO `kind`. A hook is not a fourth `TalentKind` — an
 * active can carry one (a strike that also marks its victim), and so can a
 * sustain (a stance that acts while it is up). Upstream is explicit about this:
 * 67 of its 199 sustains have an empty body and exist ONLY as a proc source.
 *
 * NAMED `onX`, NOT REGISTERED BY STRING, so the compiler is what catches a
 * typo. Upstream keys a table by event name and a misspelling there is a
 * handler that silently never runs.
 */
export type TalentHooks = {
  readonly onTakeDamage?: TakeDamageHook;
  readonly onDealDamage?: DealDamageHook;
  readonly onTurnStart?: TurnStartHook;
  readonly onKill?: KillHook;
};

/**
 * One talent's hooks, with its level already resolved.
 *
 * BOUND AT FOLD TIME so the dispatch site never has to reach for a registry or
 * a point map — which is what keeps `applyDamage` from needing to know that
 * talents exist at all. It receives an array of these on the target and folds
 * it; it does not look anything up.
 */
export type BoundHooks = {
  readonly talentId: string;
  readonly level: number;
  readonly hooks: TalentHooks;
};

/** Anything a hook can be fired against. Structural, so tests need no world. */
export type HookHost = HookSelf & {
  /** Bound in the same pass that composes passives. Absent means none. */
  readonly talentHooks?: readonly BoundHooks[];
  readonly turnProcs?: TurnProcs;
};

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/**
 * A host with no hooks is the common case and must cost nothing. Shared so the
 * three dispatchers cannot disagree about what "no hooks" means.
 */
function activeHooks(host: HookHost): readonly BoundHooks[] {
  const bound = host.talentHooks;
  return bound === undefined || bound.length === 0 ? [] : bound;
}

function ctxFor(host: HookHost, bound: BoundHooks): HookCtx {
  return {
    self: host,
    level: bound.level,
    /**
     * A HOST WITHOUT A LATCH GETS A FRESH ONE, so a hook may always call
     * `once` without a null check. It is per-call rather than per-turn, which
     * means "first time" is true every time — correct for a monster or a
     * fixture that has no turn structure to latch against, and never wrong in
     * a way that silently drops a proc.
     */
    procs: host.turnProcs ?? createTurnProcs(),
  };
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE REWRITE FOLD. Ported from damage_types.lua:474-480.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Returns the damage that should actually land. `stopped` short-circuits the
 * rest of the chain — a blow that has been refused is not available for a
 * second handler to reduce further, and letting the fold continue would let two
 * "prevent this" talents each think they were the one that saved you.
 *
 * NEGATIVE FIGURES ARE CLAMPED, not trusted. A handler returning a number
 * larger than the blow is a heal wearing a hook, which belongs in a heal.
 */
export function fireTakeDamage(host: HookHost, incoming: IncomingDamage): number {
  const bound = activeHooks(host);
  if (bound.length === 0) return incoming.dam;

  let dam = incoming.dam;
  for (const entry of bound) {
    const handler = entry.hooks.onTakeDamage;
    if (handler === undefined) continue;
    const edit = handler(ctxFor(host, entry), { ...incoming, dam });
    if (edit === undefined || edit === null) continue;
    if (edit.stopped === true) return 0;
    if (typeof edit.dam === 'number' && Number.isFinite(edit.dam)) {
      dam = Math.max(0, edit.dam);
    }
  }
  return dam;
}

/** Notification. Nothing a handler returns is read. */
export function fireDealDamage(host: HookHost, hit: OutgoingHit): void {
  for (const entry of activeHooks(host)) {
    entry.hooks.onDealDamage?.(ctxFor(host, entry), hit);
  }
}

/** Notification. Fired once per victim, by whoever resolved the kill. */
export function fireKill(host: HookHost, victimId: string): void {
  for (const entry of activeHooks(host)) {
    entry.hooks.onKill?.(ctxFor(host, entry), victimId);
  }
}

/**
 * Notification, fired by the base-turn tick.
 *
 * AFTER THE LATCH IS CLEARED, never before: a turn-start hook that wants to
 * arm something for the turn it is starting must be able to, and a hook that
 * ran against the previous turn's latch would see a board it cannot act on.
 */
export function fireTurnStart(host: HookHost): void {
  for (const entry of activeHooks(host)) {
    entry.hooks.onTurnStart?.(ctxFor(host, entry));
  }
}
