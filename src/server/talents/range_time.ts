// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// NUMBERS: t-engine4 game/modules/tome/data/talents/techniques/combat-training.lua:163-169 -- Combat Accuracy,
//          getAttack = combatTalentScale(t, 10, 50, 0.75).
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

/**
 * Range Time -- GROUNDWORK, the category every class carries.
 *
 * "Hours of it, at a paper man, in the rain."
 *
 * THE GENERIC HALF OF Called Shot, AND DELIBERATELY THE SHALLOWER ONE.
 * The Inspector's own accuracy passive runs 2 -> 8 on the same upstream
 * citation; this runs 1 -> 5. That gap is the shape a shared tree should
 * have: everyone can buy the basic version, and the class that lives on the
 * number can buy a better one.
 *
 * THE BAND IS RESCALED BY RATIO, not copied -- `called_shot.ts` carries that
 * whole argument, and it is the same one: `combatAttack` runs over a Dex band
 * of 10-60 upstream and 12-20 here, so +50 would be a fourfold multiplier
 * rather than the doubling it is in ToME.
 *
 * NO CLASS, AND THAT IS THE POINT. `classId` is null here and on the tree: this
 * is true of a body rather than of a profession, which is what
 * `technique/combat-training` is upstream -- seven talents, seven passives, zero
 * buttons, carried by everyone.
 */

import { combatTalentScale } from '../../shared/scale.ts';
import { DamageType } from '../engine/damage.ts';
import { Affinity, TalentKind, TargetShape } from '../engine/talents.ts';
import type { Talent } from '../engine/talents.ts';

/** ToME is 10 -> 50; see `called_shot.ts` for the rescale argument. */
const LOW = 1;
const HIGH = 5;
const CURVE = 0.75;

/** Flat accuracy at a rank. */
export function accuracyAt(level: number): number {
  return Math.round(combatTalentScale(level, LOW, HIGH, CURVE));
}

export const rangeTime: Talent = {
  id: 'talent:range_time',
  name: 'Range Time',
  classId: null,
  tree: 'generic/groundwork',
  kind: TalentKind.Passive,
  iconId: 'icon_passive_range_time',
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

  passive: (level) => ({ mods: { atk: accuracyAt(level) } }),

  describe: (_self, level) =>
    `Always on. ${String(accuracyAt(level))} more accuracy, on everything you swing or fire.`,
};
