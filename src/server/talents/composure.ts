// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// SHAPE:   t-engine4 game/modules/tome/data/talents/technique/combat-training.lua —
//          the generic discipline any class may buy with a category point, six
//          passives deep and priced against being available to everybody.
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license
//
// SIX TALENTS IN ONE FILE, which is the shape every LOCKED generic tree uses —
// `leverage.ts`, `legwork.ts` and `nerve.ts` are each one file of six. They
// share a `SHARED` block and a single band argument, and splitting them would
// put one decision in six places.

import { combatTalentScale } from '../../shared/scale.ts';
import { DamageType } from '../engine/damage.ts';
import { Affinity, TalentKind, TargetShape, talentId } from '../engine/talents.ts';
import type { Talent } from '../engine/talents.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * COMPOSURE — being outnumbered, and what a body does about it.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ═══ THE STATE NOTHING WAS ABOUT ═══
 * `PassiveView` offers four questions a passive may ask: `hpFraction`,
 * `resourceFraction`, `adjacentAllies` and `adjacentEnemies`. The first is
 * covered — five talents scale on being hurt. The third is the WATCHMAN's, and
 * `watch/authority` is built on standing with people, so a generic tree has no
 * business there.
 *
 * `adjacentEnemies` is asked by four talents and every one of them asks it in
 * order to LEAVE: `legwork`'s disengage, and the kiting half of the Inspector.
 * Nothing in the game is about being surrounded and STAYING, which is the state
 * a co-op party ends up in constantly — somebody is always the one the room
 * closed on.
 *
 * ═══ TWO ENEMIES, NOT ONE ═══
 * Every band here turns on `adjacentEnemies() >= OUTNUMBERED`, and the constant
 * is 2 rather than 1 deliberately. One adjacent enemy is a fight; two is a
 * mistake, and a discipline that paid out for standing next to a single husk
 * would be a flat bonus wearing a condition. The talents that already read this
 * number use it the same way.
 *
 * ═══ IT IS A LOCKED TREE, SO IT IS ALLOWED TO BE ENTIRELY PASSIVE ═══
 * `talent-trees.test.ts` requires a CLASS tree to mix actives and passives and
 * exempts the generic ones, and all three existing locked trees are six
 * passives. That is not laziness: a category point buys a discipline, and a
 * discipline that also handed out a button would be competing with the class
 * whose bar it lands on.
 */

const SHARED = {
  classId: null,
  tree: 'generic/composure',
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
 * HOW MANY IS "SURROUNDED". Two, and the header argues it: one adjacent enemy
 * is an ordinary fight and paying out for it would be a flat bonus in a
 * costume.
 */
const OUTNUMBERED = 2;

/** Below this, a body is in the trouble the back half of this tree is about. */
const HURT = 0.5;

// ---------------------------------------------------------------------------
// Tier 1
// ---------------------------------------------------------------------------

const WALL_LOW = 4;
const WALL_HIGH = 16;
export function backToWallAt(level: number): number {
  return Math.round(combatTalentScale(level, WALL_LOW, WALL_HIGH));
}

/**
 * BACK TO THE WALL — the first thing that stops being true when they surround
 * you is that any of them has to try very hard.
 *
 * DEFENCE, which decides whether a blow CONNECTS. Being outnumbered is mostly a
 * problem of volume — three bodies rolling against you instead of one — and the
 * number that answers volume is the one that makes each roll fail more often.
 */
export const backToTheWall: Talent = {
  ...SHARED,
  id: talentId('back_to_the_wall'),
  name: 'Back to the Wall',
  tier: 1,
  iconId: 'icon_passive_back_to_the_wall',
  passive: (level, view) =>
    view.adjacentEnemies() >= OUTNUMBERED ? { mods: { def: backToWallAt(level) } } : {},
  describe: (_self, level) =>
    `While ${String(OUTNUMBERED)} or more enemies are adjacent: ${String(backToWallAt(level))} ` +
    `defence. Nothing at all when only one of them has reached you.`,
};

const COUNT_LOW = 3;
const COUNT_HIGH = 12;
export function countThemAt(level: number): number {
  return Math.round(combatTalentScale(level, COUNT_LOW, COUNT_HIGH));
}

/**
 * COUNT THEM — the flat one, and the tree needs exactly one.
 *
 * A discipline where every talent is conditional is a discipline that does
 * nothing at all on the turn you most want to have bought it — the turn BEFORE
 * the room closes. This is the entry that is simply true, and it is the mental
 * save because keeping count is what stops a bad position becoming a panic.
 */
export const countThem: Talent = {
  ...SHARED,
  id: talentId('count_them'),
  name: 'Count Them',
  tier: 1,
  iconId: 'icon_passive_count_them',
  passive: (level) => ({ mods: { mentalResist: countThemAt(level) } }),
  describe: (_self, level) =>
    `Always on. ${String(countThemAt(level))} mental save — the only line in this ` +
    `discipline that does not wait for the room to close.`,
};

// ---------------------------------------------------------------------------
// Tier 2
// ---------------------------------------------------------------------------

const FRAME_LOW = 2;
const FRAME_HIGH = 8;
export function holdTheFrameAt(level: number): number {
  return Math.round(combatTalentScale(level, FRAME_LOW, FRAME_HIGH));
}

/**
 * HOLD THE FRAME — armour, where `backToTheWall` buys misses.
 *
 * The two halves of being hit less: one makes the roll fail, this reduces what
 * the roll that succeeded takes off you. Both are conditional on the same
 * count, and a player who takes both has spent a category point and eight
 * talent points to be genuinely hard to close on — which is the discipline
 * working rather than a stack that got out of hand.
 */
export const holdTheFrame: Talent = {
  ...SHARED,
  id: talentId('hold_the_frame'),
  name: 'Hold the Frame',
  tier: 2,
  iconId: 'icon_passive_hold_the_frame',
  passive: (level, view) =>
    view.adjacentEnemies() >= OUTNUMBERED ? { mods: { armour: holdTheFrameAt(level) } } : {},
  describe: (_self, level) =>
    `While ${String(OUTNUMBERED)} or more enemies are adjacent: ${String(holdTheFrameAt(level))} ` +
    `armour — what gets through the blows that do land.`,
};

const BREATH_LOW = 4;
const BREATH_HIGH = 15;
export function evenBreathingAt(level: number): number {
  return Math.round(combatTalentScale(level, BREATH_LOW, BREATH_HIGH));
}

/**
 * EVEN BREATHING — the physical save, and it waits for the HURT half rather
 * than the crowded one.
 *
 * The tree's condition splits here on purpose. The first four talents ask "how
 * many", and a discipline that only ever asked that would be one long sentence.
 * A body that is outnumbered AND under half is in a different kind of trouble —
 * the kind where the thing that kills you is a stun landing rather than a blow —
 * and a save is what answers it.
 */
export const evenBreathing: Talent = {
  ...SHARED,
  id: talentId('even_breathing'),
  name: 'Even Breathing',
  tier: 2,
  iconId: 'icon_passive_even_breathing',
  passive: (level, view) =>
    view.hpFraction() < HURT ? { mods: { physResist: evenBreathingAt(level) } } : {},
  describe: (_self, level) =>
    `While below half health: ${String(evenBreathingAt(level))} physical save. It answers the ` +
    `stun that finishes you, not the blow.`,
};

// ---------------------------------------------------------------------------
// Tier 3
// ---------------------------------------------------------------------------

const FIRST_ATK_LOW = 3;
const FIRST_ATK_HIGH = 12;
const FIRST_CRIT_LOW = 2;
const FIRST_CRIT_HIGH = 8;
export function notTheFirstAtkAt(level: number): number {
  return Math.round(combatTalentScale(level, FIRST_ATK_LOW, FIRST_ATK_HIGH));
}
export function notTheFirstCritAt(level: number): number {
  return Math.round(combatTalentScale(level, FIRST_CRIT_LOW, FIRST_CRIT_HIGH));
}

/**
 * NOT THE FIRST TIME — the only line here that makes you BETTER rather than
 * harder to remove, and it is deliberately the deepest.
 *
 * Everything above is a way to survive being surrounded. A discipline that only
 * ever taught survival would teach a player that the answer to a closing room
 * is to endure it, and the answer is to end it. Accuracy and crit chance both,
 * because being outnumbered means more rolls and the value of each is what
 * decides whether the count goes down.
 */
export const notTheFirstTime: Talent = {
  ...SHARED,
  id: talentId('not_the_first_time'),
  name: 'Not the First Time',
  tier: 3,
  iconId: 'icon_passive_not_the_first_time',
  passive: (level, view) =>
    view.adjacentEnemies() >= OUTNUMBERED
      ? { mods: { atk: notTheFirstAtkAt(level), genericCrit: notTheFirstCritAt(level) } }
      : {},
  describe: (_self, level) =>
    `While ${String(OUTNUMBERED)} or more enemies are adjacent: ${String(notTheFirstAtkAt(level))} ` +
    `accuracy and ${String(notTheFirstCritAt(level))}% critical chance. The way out is through.`,
};

const LAST_LOW = 5;
const LAST_HIGH = 18;
export function lastWordAt(level: number): number {
  return Math.round(combatTalentScale(level, LAST_LOW, LAST_HIGH));
}

/**
 * LAST WORD — both remaining saves, and it wants BOTH halves of the trouble.
 *
 * Surrounded and under half is the state this whole discipline is named for,
 * and it is the only talent here that asks for both. `spellResist` and
 * `mentalResist` together are the two channels a body cannot armour against —
 * the ones that take the turn away rather than the hit points — and losing a
 * turn is what actually kills somebody who is already down to a corner.
 */
export const lastWord: Talent = {
  ...SHARED,
  id: talentId('last_word'),
  name: 'Last Word',
  tier: 3,
  iconId: 'icon_passive_last_word',
  passive: (level, view) =>
    view.adjacentEnemies() >= OUTNUMBERED && view.hpFraction() < HURT
      ? { mods: { spellResist: lastWordAt(level), mentalResist: lastWordAt(level) } }
      : {},
  describe: (_self, level) =>
    `While ${String(OUTNUMBERED)} or more enemies are adjacent AND you are below half health: ` +
    `${String(lastWordAt(level))} spell save and ${String(lastWordAt(level))} mental save — the ` +
    `two channels armour cannot answer.`,
};

/** The six, in panel order. */
export const COMPOSURE: readonly Talent[] = Object.freeze([
  backToTheWall,
  countThem,
  holdTheFrame,
  evenBreathing,
  notTheFirstTime,
  lastWord,
]);
