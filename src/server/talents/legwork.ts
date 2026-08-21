// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// SHAPE:   t-engine4 game/modules/tome/data/talents/cunning/survival.lua -- the
//          generic category a class does NOT open with, bought with a category
//          point, and the one upstream fills with getting-about talents.
// NUMBERS: authored.
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *   LEGWORK — GETTING THERE, AND GETTING OUT. THE SECOND LOCKED DISCIPLINE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Nobody starts with it. It costs one of the three category points a character
 * is handed at levels 10, 20 and 36, and it is the second thing there is to
 * spend one on — see `generic/leverage` for the first and for the whole
 * argument about why the locked trees are generic.
 *
 * ═══ IT IS THE FIRST THING IN THE GAME THAT MOVES YOU FURTHER ═══
 * `maxMp` came off the class table and stayed there for a whole career: a
 * level-50 character covered exactly the ground a level-1 one did. Statuses
 * could TAKE movement away — `SLOWED` has carried an `mpPenalty` since it was
 * authored — and nothing in the game could ever give it back, let alone add to
 * it. `moveMp` is a new channel on `CombatMods` and this discipline is what it
 * is for.
 *
 * ═══ THREE OF THE SIX ARE MOVEMENT, AND THAT IS THE DISCIPLINE ═══
 * A flat one, one for being crowded and one for being hurt — which is to say:
 * how much ground you cover, when you need it most, and when you are running.
 * The other three pay for USING it, because a step you cannot do anything with
 * is a step that only matters when you are losing.
 *
 * ═══ AND IT COMPLETES A TRIAD ACROSS THREE TREES ═══
 * `braced.ts` sells armour for standing still, `leverage.ts`'s Second Look
 * sells criticals for it, and Moving Target here sells defence for the
 * opposite. One binary — did this body change tiles — now has three talents in
 * three different disciplines reading it in two directions, which is what turns
 * a quirk into a way of playing.
 */

import { combatTalentScale } from '../../shared/scale.ts';
import { DamageType } from '../engine/damage.ts';
import { Affinity, TalentKind, TargetShape, talentId } from '../engine/talents.ts';
import { EMPTY_PASSIVE_VIEW } from '../engine/hooks.ts';
import type { Talent } from '../engine/talents.ts';

const CURVE = 0.75;

/** Every talent here is shared, so none of them is gated on a stat. */
const SHARED = {
  classId: null,
  tree: 'generic/legwork',
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
 * WHY EVERY MOVEMENT BAND IN THIS FILE IS SMALL.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A class has three or four movement points. One extra is a QUARTER more
 * ground, and three would be nearly double — at which point a party stops
 * having to think about where it stands, which is most of what this game's
 * tactical layer is made of. `one_at_a_time`, `braced`, `riot_line` and
 * `cold_case` all pay for a POSITION, and a character who can simply walk out
 * of any position has quietly turned all four of them off.
 *
 * So the numbers here look timid beside the damage bands elsewhere and are not:
 * one point of movement is worth more than ten of damage in the fights this
 * discipline is for.
 */
const MP_LOW = 1;
const MP_HIGH = 2;

/** Extra movement, at a rank. Small on purpose — see above. */
function movementAt(level: number): number {
  return Math.max(1, Math.round(combatTalentScale(level, MP_LOW, MP_HIGH, CURVE)));
}

// ---------------------------------------------------------------------------
// LONG STRIDE — the door, and the first talent that moves you further
// ---------------------------------------------------------------------------

/** Extra movement points, always, at a rank. */
export function strideAt(level: number): number {
  return movementAt(level);
}

/**
 * LONG STRIDE.
 *
 * "The city is not big. It only feels big because of how you walk it."
 *
 * FLAT AND UNCONDITIONAL, in a discipline that is otherwise conditional, for
 * `weak_points.ts`'s reason exactly: a locked tree has to be worth its category
 * point on the day it is bought, and a wall of conditions is worth nothing
 * until a player has learned what triggers them. One of the six is the door.
 */
export const longStride: Talent = {
  ...SHARED,
  id: talentId('long_stride'),
  name: 'Long Stride',
  /** Tier 1 of its tree. See `src/shared/tiers.ts`. */
  tier: 1,
  iconId: 'icon_passive_long_stride',
  passive: (level) => ({ mods: { moveMp: strideAt(level) } }),
  describe: (_self, level) =>
    `Always on. ${String(strideAt(level))} more movement each turn — the first thing in the ` +
    `game that covers more ground than the class you picked.`,
};

// ---------------------------------------------------------------------------
// MOVING TARGET — defence for the thing Braced refuses to do
// ---------------------------------------------------------------------------

const DEF_LOW = 4;
const DEF_HIGH = 16;

/** Defence while moving, at a rank. */
export function defenceAt(level: number): number {
  return Math.round(combatTalentScale(level, DEF_LOW, DEF_HIGH, CURVE));
}

/**
 * MOVING TARGET.
 *
 * "Standing still is a decision. Usually the wrong one."
 *
 * THE THIRD READING OF ONE BINARY. `braced.ts` sells armour for NOT moving and
 * `leverage.ts`'s Second Look sells criticals for it; this sells defence for
 * the opposite. A character can hold all three and will always be paid by
 * exactly two of them, which is the property that makes "did I move" a decision
 * every turn rather than a habit.
 */
export const movingTarget: Talent = {
  ...SHARED,
  id: talentId('moving_target'),
  name: 'Moving Target',
  /** Tier 1 of its tree. See `src/shared/tiers.ts`. */
  tier: 1,
  iconId: 'icon_passive_moving_target',
  passive: (level, view = EMPTY_PASSIVE_VIEW) =>
    view.movedThisTurn() ? { mods: { def: defenceAt(level) } } : {},
  describe: (_self, level) =>
    `Always on, on any turn you change tiles. ${String(defenceAt(level))} defence — the exact ` +
    `opposite of Braced, and you can own both.`,
};

// ---------------------------------------------------------------------------
// KICK OFF — movement for the moment you most need it
// ---------------------------------------------------------------------------

/** Extra movement while something is in reach, at a rank. */
export function disengageAt(level: number): number {
  return movementAt(level);
}

/**
 * KICK OFF.
 *
 * "You do not push past them. You push off them."
 *
 * ═══ IT PAYS EXACTLY WHEN MOVEMENT IS WORTH THE MOST ═══
 * Extra ground while nothing is near you is convenience. Extra ground while
 * something is standing on you is an escape, and it is the difference between
 * a fight you chose to leave and one you had to finish. That is the whole
 * design of this talent, and it is why the condition is adjacency rather than
 * anything about your own body.
 *
 * IT STACKS WITH LONG STRIDE, deliberately. Two points of movement in a crowd
 * is a lot — and it costs two talents in a locked tree, which is exactly the
 * kind of thing three category points and a career of ordinary ones should be
 * able to buy if a player wants it badly enough.
 */
export const kickOff: Talent = {
  ...SHARED,
  id: talentId('kick_off'),
  name: 'Kick Off',
  /** Tier 2 of its tree. See `src/shared/tiers.ts`. */
  tier: 2,
  iconId: 'icon_passive_kick_off',
  passive: (level, view = EMPTY_PASSIVE_VIEW) =>
    view.adjacentEnemies() >= 1 ? { mods: { moveMp: disengageAt(level) } } : {},
  describe: (_self, level) =>
    `Always on, while anything hostile is next to you. ${String(disengageAt(level))} more ` +
    `movement — the difference between a fight you chose to leave and one you had to finish.`,
};

// ---------------------------------------------------------------------------
// LIGHT FEET — accuracy on the move, so a step is not a wasted turn
// ---------------------------------------------------------------------------

const ATK_LOW = 5;
const ATK_HIGH = 18;

/** Accuracy while moving, at a rank. */
export function accuracyAt(level: number): number {
  return Math.round(combatTalentScale(level, ATK_LOW, ATK_HIGH, CURVE));
}

/**
 * LIGHT FEET.
 *
 * "Walk and chew gum. It is not actually difficult."
 *
 * ═══ THE TALENT THAT STOPS THIS TREE BEING A RETREAT BUTTON ═══
 * Three of these six hand out movement, and movement alone only ever helps you
 * LEAVE. Without something that pays for moving and then acting, the whole
 * discipline reads as "run away better" — which is a real thing to want and a
 * dull thing to build a category around.
 *
 * Accuracy rather than damage, because accuracy is what a moving shot actually
 * lacks: the Inspector stepping out of a dead zone and firing is the shape this
 * is for, and their problem is landing it rather than how hard it lands.
 */
export const lightFeet: Talent = {
  ...SHARED,
  id: talentId('light_feet'),
  name: 'Light Feet',
  /** Tier 2 of its tree. See `src/shared/tiers.ts`. */
  tier: 2,
  iconId: 'icon_passive_light_feet',
  passive: (level, view = EMPTY_PASSIVE_VIEW) =>
    view.movedThisTurn() ? { mods: { atk: accuracyAt(level) } } : {},
  describe: (_self, level) =>
    `Always on, on any turn you change tiles. ${String(accuracyAt(level))} accuracy — so a step ` +
    `and a shot is a turn rather than half of one.`,
};

// ---------------------------------------------------------------------------
// DOWNHILL — the last of the movement, and the most conditional
// ---------------------------------------------------------------------------

/** Below this much health it pays. A quarter — genuinely in trouble. */
const HURT = 0.25;

/** Extra movement while badly hurt, at a rank. */
export function flightAt(level: number): number {
  return movementAt(level);
}

/**
 * DOWNHILL.
 *
 * "It is easier going down. That is not a comfort."
 *
 * ═══ A THRESHOLD, WHERE `second_wind` AND `committed` USE A RAMP ═══
 * Those two scale smoothly with the health you are missing, which is right for
 * a NUMBER — there is no edge to miss by one point. Movement is not a number, it
 * is a whole step or it is nothing, so a ramp would round to the same integer
 * across most of the bar and then jump anyway. A stated threshold is the honest
 * shape and the player can read it off their own health.
 *
 * A QUARTER, WHICH IS LOW ON PURPOSE. This is the talent for the turn you
 * decide to leave, and it should not be paying during the ordinary business of
 * being hit. `dead_on_your_feet.ts` draws its line in the same place and for the
 * same reason.
 */
export const downhill: Talent = {
  ...SHARED,
  id: talentId('downhill'),
  name: 'Downhill',
  /** Tier 3 of its tree. See `src/shared/tiers.ts`. */
  tier: 3,
  iconId: 'icon_passive_downhill',
  passive: (level, view = EMPTY_PASSIVE_VIEW) =>
    view.hpFraction() <= HURT ? { mods: { moveMp: flightAt(level) } } : {},
  describe: (_self, level) =>
    `Always on, below a quarter of your health. ${String(flightAt(level))} more movement — the ` +
    `turn you decide to leave, and not one before it.`,
};

// ---------------------------------------------------------------------------
// SECOND EXIT — the capstone, and it pays for having looked
// ---------------------------------------------------------------------------

const SAVE_LOW = 5;
const SAVE_HIGH = 18;

/** Physical save while nothing is in reach, at a rank. */
export function saveAt(level: number): number {
  return Math.round(combatTalentScale(level, SAVE_LOW, SAVE_HIGH, CURVE));
}

const DEF_FAR_LOW = 4;
const DEF_FAR_HIGH = 14;

/** Defence while nothing is in reach, at a rank. */
export function openDefenceAt(level: number): number {
  return Math.round(combatTalentScale(level, DEF_FAR_LOW, DEF_FAR_HIGH, CURVE));
}

/**
 * SECOND EXIT — the deepest thing in the tree.
 *
 * "You found it on the way in. That was the point of the way in."
 *
 * ═══ IT PAYS FOR THE POSITION THE REST OF THE TREE BUYS ═══
 * Five talents above this hand out movement and reward using it; this is what
 * the movement was FOR. Nothing adjacent means the discipline worked — you are
 * where you meant to be and the thing that wanted you is not — and a tier-4
 * slot should pay for the plan having come off rather than for another way to
 * start it.
 *
 * SAVES AND DEFENCE, WHICH IS NOT THE SAME AS "MORE DEFENCE". A body with
 * nothing in reach is being shot at, shouted at and worked on at range, and the
 * saves are the half of that a moving character otherwise has no answer to —
 * `cold_case.ts` reads the same condition from the offensive side, so an
 * Inspector who owns both is paid twice for the range they were keeping anyway.
 */
export const secondExit: Talent = {
  ...SHARED,
  id: talentId('second_exit'),
  name: 'Second Exit',
  /** Tier 3 of its tree. See `src/shared/tiers.ts`. */
  tier: 3,
  iconId: 'icon_passive_second_exit',
  passive: (level, view = EMPTY_PASSIVE_VIEW) =>
    view.adjacentEnemies() > 0
      ? {}
      : { mods: { physResist: saveAt(level), def: openDefenceAt(level) } },
  describe: (_self, level) =>
    `Always on, while nothing hostile is next to you. ${String(saveAt(level))} physical save and ` +
    `${String(openDefenceAt(level))} defence — what the rest of this discipline was for.`,
};

/** The six, in panel order. */
export const LEGWORK: readonly Talent[] = Object.freeze([
  longStride,
  movingTarget,
  kickOff,
  lightFeet,
  downhill,
  secondExit,
]);
