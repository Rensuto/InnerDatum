// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// SHAPE:   t-engine4 game/modules/tome/data/talents/spell/explosives.lua -- the
//          alchemist tree's passives, which pay for the bag rather than for any
//          one thing in it.
// NUMBERS: authored.
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

/**
 * THE THREE PASSIVES OF `ashwick/loads`, in one file.
 *
 * ═══ ONE FILE BECAUSE THEY ARE ONE IDEA, AND `loads.ts` SETS THE PRECEDENT ═══
 * The three loads share a body and differ in a rider; these three share a
 * SUBJECT — the bag, and what having loaded it is worth. Split across three
 * files each would carry a copy of the same paragraph explaining the tree, and
 * the fourth author to add one would copy it a fourth time. Every other talent
 * in this game is its own file because every other talent is its own argument.
 */

import { combatTalentScale } from '../../shared/scale.ts';
import { DamageType } from '../engine/damage.ts';
import { Affinity, ClassId, TalentKind, TargetShape, talentId } from '../engine/talents.ts';
import { EMPTY_PASSIVE_VIEW } from '../engine/hooks.ts';
import { causticLoad, concussiveLoad, frostLoad } from './loads.ts';
import type { Talent } from '../engine/talents.ts';

const CURVE = 0.75;

// ---------------------------------------------------------------------------
// STEADY POUR — the one that makes the rest of the tree land
// ---------------------------------------------------------------------------

const POWER_LOW = 5;
const POWER_HIGH = 18;

/** Power in every channel, at a rank. */
export function powerAt(level: number): number {
  return Math.round(combatTalentScale(level, POWER_LOW, POWER_HIGH, CURVE));
}

/**
 * STEADY POUR.
 *
 * "The measure is the whole of it. Everything after the measure is stirring."
 *
 * ═══ THE TALENT THAT MAKES THE OTHER FIVE WORK ═══
 * Every load's rider lands on a SAVE, rolled against the thrower's power.
 * Without something in this tree that raises it, an Alchemist who has spent
 * five points on loads is pouring at exactly the same steadiness they started
 * with, and the tree gets strictly WORSE the deeper into it you go — because
 * later targets have better saves. That is the single commonest way a control
 * tree dies in playtesting: the numbers all rise and the landing rate falls
 * faster. `carrying_voice.ts` is the Watchman's copy of this argument and it is
 * the same argument.
 *
 * `genericPower` AND NOT `spellPower`, WHICH WAS THE FIRST DRAFT. That field is
 * inert — `combatSpellpower` has no call sites and derived.ts:110-134 names the
 * failure. `genericPower` feeds all three power getters (derived.ts:473, :481,
 * :500), so it raises whatever channel a given throw happens to roll with.
 */
export const steadyPour: Talent = {
  id: talentId('steady_pour'),
  name: 'Steady Pour',
  classId: ClassId.Alchemist,
  tree: 'ashwick/loads',
  /** Tier 2 of its tree. See `src/shared/tiers.ts`. */
  tier: 2,
  /** loads is about CUN. See `Talent.statGate`. */
  statGate: 'cun',
  kind: TalentKind.Passive,
  iconId: 'icon_passive_steady_pour',
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

  passive: (level) => ({ mods: { genericPower: powerAt(level) } }),

  describe: (_self, level) =>
    `Always on. ${String(powerAt(level))} to every kind of power — what a load's rider is ` +
    `rolled against a target's save with, so the rest of this discipline keeps landing on ` +
    `things that are getting harder to shift.`,
};

// ---------------------------------------------------------------------------
// FULL BANDOLIER — the mirror of Long Nights
// ---------------------------------------------------------------------------

/** Above this much of the bag, it pays. Half, so it is a habit not a windfall. */
const FULL = 0.5;

const DAM_LOW = 4;
const DAM_HIGH = 16;

/** Damage rating while the bag is full, at a rank. */
export function damageAt(level: number): number {
  return Math.round(combatTalentScale(level, DAM_LOW, DAM_HIGH, CURVE));
}

/**
 * FULL BANDOLIER.
 *
 * "A full bag is a quiet morning. Enjoy it."
 *
 * ═══ THE EXACT MIRROR OF `long_nights.ts`, ON PURPOSE ═══
 * That one pays as your class resource EMPTIES; this pays while it is still
 * full. Both read `resourceFraction`, from opposite ends, and an Alchemist can
 * own both — which is not a contradiction but the most interesting thing about
 * the pair: the two are worth their most at opposite points of the same fight,
 * so a character with both is never at zero value and never at peak.
 *
 * ═══ AND IT ARGUES AGAINST THE CLASS'S OWN HABIT ═══
 * Reagents are countable, regenerate on a slow counter, and every instinct says
 * spend them. This is the first reason not to — a talent that pays for
 * RESTRAINT in a class built around throwing things, which is the kind of
 * tension a build is made out of.
 */
export const fullBandolier: Talent = {
  id: talentId('full_bandolier'),
  name: 'Full Bandolier',
  classId: ClassId.Alchemist,
  tree: 'ashwick/loads',
  /** Tier 2 of its tree. See `src/shared/tiers.ts`. */
  tier: 2,
  /** loads is about CUN. See `Talent.statGate`. */
  statGate: 'cun',
  kind: TalentKind.Passive,
  iconId: 'icon_passive_full_bandolier',
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

  passive: (level, view = EMPTY_PASSIVE_VIEW) => {
    // `EMPTY_PASSIVE_VIEW` ANSWERS A FULL POOL, so a fixture with no world gets
    // the bonus — which is the honest reading of "nothing has been spent yet".
    if (view.resourceFraction() < FULL) return {};
    return { mods: { dam: damageAt(level) } };
  },

  describe: (_self, level) =>
    `Always on, while more than half your Reagents are still in the bag. ` +
    `${String(damageAt(level))} damage. The first reason this class has ever had not to ` +
    `throw everything.`,
};

// ---------------------------------------------------------------------------
// PRACTISED HANDS — the capstone, and it pays for committing
// ---------------------------------------------------------------------------

const CRIT_LOW = 4;
const CRIT_HIGH = 14;
const CRIT_POWER_LOW = 8;
const CRIT_POWER_HIGH = 30;

/** Critical chance while a load is up, at a rank. */
export function critAt(level: number): number {
  return Math.round(combatTalentScale(level, CRIT_LOW, CRIT_HIGH, CURVE));
}

/** Critical damage while a load is up, at a rank. */
export function critPowerAt(level: number): number {
  return Math.round(combatTalentScale(level, CRIT_POWER_LOW, CRIT_POWER_HIGH, CURVE));
}

/**
 * PRACTISED HANDS — the deepest thing in the tree.
 *
 * "You stopped reading the labels a long time ago."
 *
 * ═══ IT PAYS FOR HOLDING A LOAD, WHICH IS THE TREE'S OWN COST ═══
 * A load reserves a whole Reagent — an eighth of the bag against a resource
 * that regenerates on a counter, which is the steepest sustain cost in the
 * game. This is what makes paying it worth doing rather than merely
 * interesting, and at tier 4 it has to be: the whole cost of the condition
 * has to come back at once or nobody buys the deep end.
 *
 * ═══ ANY LOAD, NOT A PARTICULAR ONE ═══
 * `corroboration.ts` makes the same call for the Inspector's methods and for
 * the same reason: paying more for one would put a thumb on the scale between
 * options that are deliberately equal, and a set of modes only works as a
 * decision while none of them is the default.
 *
 * CRIT AND CRIT DAMAGE rather than flat damage, because flat damage is what
 * Full Bandolier already sells two tiers down — and because a crit on an area
 * throw is the single biggest number this class can produce.
 */
export const practisedHands: Talent = {
  id: talentId('practised_hands'),
  name: 'Practised Hands',
  classId: ClassId.Alchemist,
  tree: 'ashwick/loads',
  /** Tier 4 of its tree — the deepest thing in it. See `src/shared/tiers.ts`. */
  tier: 4,
  /** loads is about CUN. See `Talent.statGate`. */
  statGate: 'cun',
  kind: TalentKind.Passive,
  iconId: 'icon_passive_practised_hands',
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

  passive: (level, view = EMPTY_PASSIVE_VIEW) => {
    // ASKED BY ID, ALL THREE. `PassiveView` answers about a TALENT and knows
    // nothing about slots — and a fourth load arriving later should have to
    // decide for itself whether this pays for it.
    const loaded =
      view.isSustained(causticLoad.id) ||
      view.isSustained(frostLoad.id) ||
      view.isSustained(concussiveLoad.id);
    if (!loaded) return {};
    return { mods: { genericCrit: critAt(level), criticalPower: critPowerAt(level) } };
  },

  describe: (_self, level) =>
    `Always on, while any load is up. ${String(critAt(level))}% critical chance and ` +
    `${String(critPowerAt(level))}% critical damage — what holding a Reagent back is finally ` +
    `worth.`,
};
