// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// NUMBERS: t-engine4 game/modules/tome/data/talents/cunning/called-shots.lua:25-26
//          Sling Sniper -- crit chance 3 -> 10, crit power 0.1 -> 0.2 at 0.75.
//          The power band is read as PERCENTAGE POINTS (10 -> 20) because that is
//          the unit `CombatMods.criticalPower` carries; upstream stores a fraction.
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

/**
 * Steady Hands -- the Inspector, in Marksmanship.
 *
 * "Your hand has been steady since the second body."
 *
 * BOTH HALVES LAND, WHICH IS WHY THIS ONE IS WHOLE. Unlike Soft Places and Seen
 * Worse, neither band here runs into a ceiling this game has: critical CHANCE is
 * a roll and critical POWER multiplies a blow that already landed.
 *
 * IT IS THE RANGED CLASS'S ANSWER TO STANDING ORDERS. The Watchman's passive
 * pays while he is standing in the way; this one pays on the shot the Inspector
 * was going to take anyway -- the difference between the two classes stated in a
 * stat block rather than in prose.
 *
 * IT HAS NO `onUse`, AND THAT IS THE DECLARATION. See `Talent.onUse` -- the
 * absent body IS `mode = "passive"`.
 */

import { combatTalentScale } from '../../shared/scale.ts';
import { DamageType } from '../engine/damage.ts';
import { Affinity, ClassId, TalentKind, TargetShape } from '../engine/talents.ts';
import type { Talent } from '../engine/talents.ts';

/** ToME's bands -- called-shots.lua:25-26. */
const CRIT_LOW = 3;
const CRIT_HIGH = 10;
const POWER_LOW = 10;
const POWER_HIGH = 20;
const CURVE = 0.75;

/** Critical chance at a rank, in percentage points. */
export function critChanceAt(level: number): number {
  return Math.round(combatTalentScale(level, CRIT_LOW, CRIT_HIGH, CURVE));
}

/** Critical power at a rank, in percentage points. */
export function critPowerAt(level: number): number {
  return Math.round(combatTalentScale(level, POWER_LOW, POWER_HIGH, CURVE));
}

export const steadyHands: Talent = {
  id: 'talent:steady_hands',
  name: 'Steady Hands',
  classId: ClassId.Inspector,
  tree: 'index/marksmanship',
  kind: TalentKind.Passive,
  iconId: 'icon_passive_steady_hands',
  // A PASSIVE COSTS NOTHING TO HAVE -- `cold_reading.ts` carries the whole note.
  cost: { ap: 0 },
  cooldownTurns: 0,
  /** Never aimed. See `cold_reading.ts` for the argument behind these fields. */
  targeting: {
    shape: TargetShape.Self,
    range: 0,
    minRange: 0,
    radius: 0,
    requiresLos: false,
    affinity: Affinity.Ally,
  },
  damageType: DamageType.Physical,

  passive: (level) => ({
    mods: { physCrit: critChanceAt(level), criticalPower: critPowerAt(level) },
  }),

  describe: (_self, level) =>
    `Always on. ${String(critChanceAt(level))}% more crits, each ${String(critPowerAt(level))}% harder.`,
};
