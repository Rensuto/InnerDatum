// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// SHAPE:   t-engine4 — the `self:hasEffect(...)` talents that run all through
//          upstream's trees, where being afflicted is a state a talent can read
//          rather than only a cost it pays.
// NUMBERS: authored.
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *   NERVE — WORKING THROUGH IT. THE THIRD AND LAST LOCKED DISCIPLINE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * It costs the third of the three category points a character is handed at
 * levels 10, 20 and 36 — see `generic/leverage` for the first, `generic/legwork`
 * for the second, and `TalentTree.locked` for why the locked trees are generic.
 *
 * ═══ THE STATUS TABLE WAS SOMETHING THAT HAPPENED TO YOU AND NOTHING ELSE ═══
 * Twelve talents in this game apply a stun, a slow or a bleed. NOT ONE has ever
 * asked whether it is standing in one. So being afflicted could only ever be a
 * cost — a number going down, a turn taken away — and a whole shape of upstream
 * talent had no way to exist here: `self:hasEffect(...)` runs all through
 * ToME's own trees, and half of what it expresses is a character who is BETTER
 * for having something wrong with them.
 *
 * `PassiveView.afflicted` is the new question and this discipline is what it is
 * for. A COUNT rather than a predicate, because "how much is wrong with me" is
 * a scale a talent can pay against where "am I stunned" is one talent's
 * business.
 *
 * ═══ IT IS THE ANSWER TO THE THING A PARTY CANNOT OTHERWISE PLAN FOR ═══
 * Armour answers damage and defence answers being hit. Nothing answers a stun
 * that has already landed except the Alchemist's Field Dressing, which is one
 * class's button on a cooldown. This is everybody's, it is worse than the
 * Alchemist's, and both of those are the point — a party without that third
 * seat is not locked out of the fights where the floor fights back.
 *
 * ═══ AND IT CANNOT BE FARMED ═══
 * Every number here reads a count the PLAYER does not control: monsters apply
 * the statuses, and nothing in the game lets a character afflict themselves. A
 * talent that paid for a self-inflicted condition would be a talent that
 * rewarded standing in a fire, and this tree deliberately has no way to do
 * that.
 */

import { combatTalentScale } from '../../shared/scale.ts';
import { DamageType } from '../engine/damage.ts';
import { EffectStatus } from '../engine/effects.ts';
import {
  Affinity,
  TalentKind,
  TalentRefusal,
  TargetShape,
  healActor,
  percent,
  talentDone,
  talentId,
  talentRefused,
  tomeCooldownToTurns,
} from '../engine/talents.ts';
import { EMPTY_PASSIVE_VIEW } from '../engine/hooks.ts';
import type { Talent } from '../engine/talents.ts';

const CURVE = 0.75;

/** Every talent here is shared, so none of them is gated on a stat. */
const SHARED = {
  classId: null,
  tree: 'generic/nerve',
  kind: TalentKind.Passive,
  cost: { ap: 0 },
  cooldownTurns: 0,
  targeting: {
    shape: TargetShape.Self,
    range: 0,
    minRange: 0,
    radius: 0,
    requiresLos: false,
    affinity: Affinity.Ally,
  },
  damageType: DamageType.Physical,
} as const;

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * HOW MANY AFFLICTIONS ANY OF THESE WILL COUNT. Three, and the cap is the
 * balance lever rather than the per-affliction figure.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Three detrimental effects at once is a bad turn; five is a turn somebody is
 * about to die on, and a talent that went on paying into that would be paying
 * most at the moment it can no longer help. It also bounds the arithmetic
 * against a future effect table with twenty entries in it, which is the version
 * of this that gets away from an author.
 */
const MAX_COUNTED = 3;

/** What the view says, bounded. Every talent in the file reads through it. */
function counted(view: { afflicted(): number }): number {
  return Math.min(MAX_COUNTED, Math.max(0, view.afflicted()));
}

// ---------------------------------------------------------------------------
// WORK THROUGH IT — the door
// ---------------------------------------------------------------------------

const ATK_LOW = 4;
const ATK_HIGH = 14;

/** Accuracy per affliction, at a rank. */
export function accuracyAt(level: number): number {
  return Math.round(combatTalentScale(level, ATK_LOW, ATK_HIGH, CURVE));
}

/** The most it can be worth, for the sentence the panel prints. */
export function accuracyMaxAt(level: number): number {
  return accuracyAt(level) * MAX_COUNTED;
}

/**
 * WORK THROUGH IT.
 *
 * "You can do the job with a broken hand. It is just slower."
 *
 * ═══ ACCURACY, WHICH IS THE THING AN AFFLICTED BODY ACTUALLY LOSES ═══
 * `dazed` halves accuracy and `SLOWED` takes actions away; a character in
 * trouble is missing more than they are hitting soft. Paying the loss back in
 * the channel it was taken from is what makes this feel like working through
 * something rather than a consolation prize in a different currency.
 */
export const workThroughIt: Talent = {
  ...SHARED,
  id: talentId('work_through_it'),
  name: 'Work Through It',
  /** Tier 1 of its tree. See `src/shared/tiers.ts`. */
  tier: 1,
  iconId: 'icon_passive_work_through_it',
  passive: (level, view = EMPTY_PASSIVE_VIEW) => {
    const n = counted(view);
    return n === 0 ? {} : { mods: { atk: accuracyAt(level) * n } };
  },
  describe: (_self, level) =>
    `Always on. ${String(accuracyAt(level))} accuracy for each thing currently wrong with you, ` +
    `up to ${String(MAX_COUNTED)} — ${String(accuracyMaxAt(level))} at worst.`,
};

// ---------------------------------------------------------------------------
// SHAKE IT OFF — the tree's button, and conditioning's active slot
// Shaped after techniques/conditioning.lua:148 (Adrenaline Surge), which is the
// one `action =` in a tree that is otherwise two passives and a sustain.
// ---------------------------------------------------------------------------

const SHAKE_LOW = 1;
const SHAKE_HIGH = 3;

/**
 * How many afflictions one shake takes off.
 *
 * `field_dressing.ts` runs the same 1..3 band for the same reason, and floors it
 * the same way — 1,1,2,2,3. THAT IS NOT A DRIFT TO FIX: a cure count is a coarse
 * number and the talent's other scaling figure carries the per-rank movement the
 * honesty gate reads. Here that figure is the cooldown... which our engine holds
 * flat. So `saveAt` below survives the conversion and is what scales.
 */
export function saveAt(level: number): number {
  return Math.max(1, Math.floor(combatTalentScale(level, SHAKE_LOW, SHAKE_HIGH, CURVE)));
}

/**
 * The breath you get back with it.
 *
 * ═══ THE CLEANSE COUNT COULD NOT CARRY THE SCALING ON ITS OWN ═══
 * `saveAt` floors 1..3 to 1,1,2,2,3, so ranks 1 and 2 read identically and so do
 * 3 and 4 — `class-wiring.test.ts` refuses that. Widening the band was the wrong
 * fix: this talent's own note bounds the count deliberately, because "a talent
 * that made a character immune would remove the moment this exists to make
 * survivable", and clearing five afflictions is that talent.
 *
 * So a second number carries the rank, and `field_dressing.ts` already has the
 * shape — a cure with a heal rider, where the cure count is coarse and the
 * fraction is smooth. Under a dressing's 4-12% at every rank, because this one
 * needs no reagent, no ally and no aim.
 */
const BREATH_LOW = 0.03;
const BREATH_HIGH = 0.09;

export function breathAt(level: number): number {
  return combatTalentScale(level, BREATH_LOW, BREATH_HIGH);
}

/** Two of six: shrugging is quick, and it is the turn you had a bad one. */
const SHAKE_AP = 2;
/** Ported from conditioning.lua:152 — Adrenaline Surge's `cooldown = 24`. */
const SURGE_COOLDOWN_ACTIONS = 24;
const SHAKE_COOLDOWN = tomeCooldownToTurns(SURGE_COOLDOWN_ACTIONS);

/**
 * SHAKE IT OFF.
 *
 * "The second one always lands worse than the first. Nobody knows why."
 *
 * ═══ A LOCK CHAIN IS THE WORST THING THAT HAPPENS TO A CHARACTER HERE ═══
 * Not a big hit — a stun, then another stun, then a third, with the player
 * watching. This talent has always been the answer to that. It used to be a
 * PASSIVE that made each successive affliction harder to LAND:
 *
 *   "Always on. N to all three saves for each thing currently wrong with you,
 *    up to three — so a second affliction is harder to land than the first."
 *
 * ═══ AND A SAVE BONUS IS NOT AN ANSWER YOU CAN GIVE WHILE IT IS HAPPENING ═══
 * That is the trouble with it: the player being chain-stunned is watching, and a
 * passive that improves the odds of the NEXT roll is something happening TO them
 * rather than something they did. The old note said so itself, without meaning
 * to — "once the first has landed there is nothing they can do about the second."
 * There is now. It is this.
 *
 * `technique/conditioning` is the upstream shape for a discipline about working
 * through affliction: Vitality and Unflinching Resolve are `mode = "passive"`,
 * Daunting Presence is `mode = "sustained"`, and Adrenaline Surge is the one
 * `action =` (conditioning.lua:21, 51, 95, 148). This tree had six passives and
 * no button at all, which is exactly the slot Adrenaline Surge occupies: the
 * thing you press when the turn has gone badly.
 *
 * ═══ IT TAKES THE AFFLICTION OFF RATHER THAN RESISTING THE NEXT ONE ═══
 * `ctx.cure` is the seam `field_dressing.ts` uses on an ALLY; this is the same
 * door turned on yourself, which is a shape the game did not have. The old
 * talent's own argument still holds and still bounds this one — it must not make
 * a character immune, "a talent that made a character immune would remove the
 * moment this exists to make survivable" — so it is one to three afflictions on
 * a TWELVE-TURN cooldown, which is a way out of one bad chain per fight and not
 * a way to ignore afflictions.
 */
export const shakeItOff: Talent = {
  ...SHARED,
  id: talentId('shake_it_off'),
  name: 'Shake It Off',
  /** Tier 1 of its tree. See `src/shared/tiers.ts`. */
  tier: 1,
  kind: TalentKind.Active,
  iconId: 'icon_active_shake_it_off',
  cost: { ap: SHAKE_AP },
  cooldownTurns: SHAKE_COOLDOWN,
  targeting: {
    // YOURSELF, which is the whole difference from Field Dressing.
    shape: TargetShape.Self,
    range: 0,
    minRange: 0,
    radius: 0,
    requiresLos: false,
    affinity: Affinity.Ally,
  },

  onUse: (ctx, self) => {
    /**
     * `field_dressing.ts`'s loop and its rule, word for word: nothing left on
     * the SECOND pass is not a failure — a rank-5 shake on a body carrying one
     * condition clears the one and stops. Only clearing NOTHING AT ALL refuses,
     * and it must refuse, or this becomes a button a player presses at full
     * health to burn a cooldown they wanted later.
     */
    const cleared: string[] = [];
    for (let i = 0; i < saveAt(ctx.talentLevel); i += 1) {
      const cured = ctx.cure?.(self, EffectStatus.Detrimental);
      if (cured === undefined || cured === null) break;
      cleared.push(cured);
    }
    if (cleared.length === 0) return talentRefused(TalentRefusal.NoTarget);

    /**
     * THE RIDER, AFTER the cure and only when the cure landed —
     * `field_dressing.ts`'s order and its reason. A shake aimed at a body with
     * nothing wrong is the refusal above, so this is not a heal that can be
     * pressed on a good turn.
     */
    const healed = healActor(self, Math.round(self.maxHp * breathAt(ctx.talentLevel)));
    const lines = [`You shake off ${cleared.join(', ').toLowerCase()}.`];
    if (healed > 0) lines.push(`You get ${String(healed)} back with it.`);
    return talentDone([], lines);
  },

  describe: (_self, level) =>
    `Shake off up to ${String(saveAt(level))} of the things currently wrong with you and get ` +
    `${percent(breathAt(level))} of your health back with them. Refuses when nothing is wrong. ` +
    `${String(SHAKE_AP)} AP, ${String(SHAKE_COOLDOWN)}-turn cooldown — one way out of one bad ` +
    `chain, not a way to ignore afflictions.`,
};

// ---------------------------------------------------------------------------
// BAD NIGHT — damage, so the tree is not purely defensive
// ---------------------------------------------------------------------------

const DAM_LOW = 3;
const DAM_HIGH = 12;

/** Damage rating per affliction, at a rank. */
export function damageAt(level: number): number {
  return Math.round(combatTalentScale(level, DAM_LOW, DAM_HIGH, CURVE));
}

/**
 * BAD NIGHT.
 *
 * "Some of the best work gets done on the worst nights."
 *
 * THE TREE WOULD BE PURE MITIGATION WITHOUT THIS, and pure mitigation is a
 * discipline that makes losing slower rather than making winning possible. A
 * character who has bought Nerve should get something out of a bad turn beyond
 * surviving it — otherwise the correct play while afflicted is always to
 * retreat, and three category points bought a retreat button.
 */
export const badNight: Talent = {
  ...SHARED,
  id: talentId('bad_night'),
  name: 'Bad Night',
  /** Tier 2 of its tree. See `src/shared/tiers.ts`. */
  tier: 2,
  iconId: 'icon_passive_bad_night',
  passive: (level, view = EMPTY_PASSIVE_VIEW) => {
    const n = counted(view);
    return n === 0 ? {} : { mods: { dam: damageAt(level) * n } };
  },
  describe: (_self, level) =>
    `Always on. ${String(damageAt(level))} damage for each thing currently wrong with you, up ` +
    `to ${String(MAX_COUNTED)}. A bad turn should still be worth something.`,
};

// ---------------------------------------------------------------------------
// GRIT — the turn tick, and the only healing that scales with trouble
// ---------------------------------------------------------------------------

const MEND_LOW = 1;
const MEND_HIGH = 4;

/** Hit points recovered per affliction, per turn, at a rank. */
export function mendAt(level: number): number {
  return Math.max(1, Math.round(combatTalentScale(level, MEND_LOW, MEND_HIGH, CURVE)));
}

/**
 * GRIT.
 *
 * "It stops hurting eventually. That is not the same as stopping."
 *
 * ═══ IT READS THE VIEW FROM A HOOK, WHICH IT CANNOT DO ═══
 * `onTurnStart` is handed `self`, `level` and the latch — no board, no status
 * table. So the affliction count is not available where the healing happens,
 * and this talent CANNOT be "heal per affliction" however much it wants to be.
 *
 * WHAT IT IS INSTEAD: a flat mend on the base clock, like `walk_it_off.ts`,
 * bought in a tree whose other five talents pay for being afflicted. The
 * discipline is what makes it a trouble talent; the talent itself is honest
 * about what the hook can see. Stated plainly because the obvious reading of
 * the design is that this scales, and it does not.
 *
 * FLAT, so it does not grow with the life curve — `walk_it_off.ts` carries that
 * whole argument and it is the same one.
 */
export const grit: Talent = {
  ...SHARED,
  id: talentId('grit'),
  name: 'Grit',
  /** Tier 2 of its tree. See `src/shared/tiers.ts`. */
  tier: 2,
  iconId: 'icon_passive_grit',
  hooks: {
    onTurnStart: (ctx) => {
      // A CORPSE DOES NOT MEND, and Downed keeps a body on the board at 0 —
      // without this a downed character would heal themselves off the floor
      // past the rescue rules. `walk_it_off.ts` guards the same edge.
      if (!ctx.self.alive || ctx.self.hp <= 0) return;
      ctx.self.hp = Math.min(ctx.self.maxHp, ctx.self.hp + mendAt(ctx.level));
    },
  },
  describe: (_self, level) =>
    `Always on. You recover ${String(mendAt(level))} hit points at the start of each turn — ` +
    `flat, so it matters most early, and never while you are down.`,
};

// ---------------------------------------------------------------------------
// NOTHING NEW — the flat one, for the character who is never afflicted
// ---------------------------------------------------------------------------

const FLAT_LOW = 6;
const FLAT_HIGH = 22;

/** Mental and spell save, always, at a rank. */
export function wardAt(level: number): number {
  return Math.round(combatTalentScale(level, FLAT_LOW, FLAT_HIGH, CURVE));
}

/**
 * NOTHING NEW.
 *
 * "Whatever it is, it has been in the file before."
 *
 * ═══ THE ONE THAT PAYS WHEN THE REST OF THE TREE DOES NOT ═══
 * Five of these six are worth nothing to a character nothing has landed on, and
 * a discipline that is worth nothing on a good night is one nobody buys with a
 * point they only get three of. This is the floor under it: unconditional, in
 * the two channels that MAKE the rest of the tree relevant, so buying Nerve
 * makes you harder to afflict in the first place as well as better at it once
 * you are.
 *
 * MENTAL AND SPELL rather than physical, because the physical channel is
 * crowded — `unflinching`, `second_wind`, `riot_line` and armour all live there
 * — and because what the Redaction does to a body is not a punch.
 */
export const nothingNew: Talent = {
  ...SHARED,
  id: talentId('nothing_new'),
  name: 'Nothing New',
  /** Tier 3 of its tree. See `src/shared/tiers.ts`. */
  tier: 3,
  iconId: 'icon_passive_nothing_new',
  passive: (level) => ({ mods: { mentalResist: wardAt(level), spellResist: wardAt(level) } }),
  describe: (_self, level) =>
    `Always on, always. ${String(wardAt(level))} to mental and spell saves — the floor under a ` +
    `discipline whose other talents only pay when something has already gone wrong.`,
};

// ---------------------------------------------------------------------------
// STILL STANDING — the capstone, and the first shipped use of `onKill`
// ---------------------------------------------------------------------------

const KILL_LOW = 4;
const KILL_HIGH = 16;

/** Hit points recovered per kill, at a rank. */
export function reliefAt(level: number): number {
  return Math.max(1, Math.round(combatTalentScale(level, KILL_LOW, KILL_HIGH, CURVE)));
}

/**
 * STILL STANDING — the deepest thing in the tree.
 *
 * "Something has to stop, and it is not going to be you."
 *
 * ═══ THE FIRST SHIPPED TALENT TO USE `onKill` ═══
 * The hook has existed since `TalentHooks` did and NOTHING has ever attached to
 * it — the last of the four to be claimed, after `onTakeDamage`, `onTurnStart`
 * and `onDealDamage`. A hook nobody calls is a hook whose contract nobody has
 * tested.
 *
 * ═══ WHY A KILL IS THE RIGHT TRIGGER FOR THIS TREE'S CAPSTONE ═══
 * Everything else here pays for being in trouble, which means the whole
 * discipline is worth most in the fights that are going badly — and a tree that
 * only ever rewards suffering teaches a player to expect to lose. A kill is the
 * moment a bad fight turns, and paying for it is what turns Nerve from
 * enduring into finishing.
 *
 * NO LATCH, deliberately, where `blood_price.ts` needed one: a kill is already
 * the scarce thing. Nobody manufactures four of them in a turn to farm this,
 * and capping it at one would punish exactly the moment the talent exists to
 * reward — clearing two bodies at once, which is how a bad turn ends.
 */
export const stillStanding: Talent = {
  ...SHARED,
  id: talentId('still_standing'),
  name: 'Still Standing',
  /** Tier 3 of its tree. See `src/shared/tiers.ts`. */
  tier: 3,
  iconId: 'icon_passive_still_standing',
  hooks: {
    onKill: (ctx) => {
      if (!ctx.self.alive || ctx.self.hp <= 0) return;
      ctx.self.hp = Math.min(ctx.self.maxHp, ctx.self.hp + reliefAt(ctx.level));
    },
  },
  describe: (_self, level) =>
    `Always on. Recover ${String(reliefAt(level))} hit points every time you kill something — ` +
    `the moment a bad fight turns, and what this discipline is finally for.`,
};

/** The six, in panel order. */
export const NERVE: readonly Talent[] = Object.freeze([
  workThroughIt,
  shakeItOff,
  badNight,
  grit,
  nothingNew,
  stillStanding,
]);
