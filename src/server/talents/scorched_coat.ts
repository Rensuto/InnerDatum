// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// NUMBERS: t-engine4 game/modules/tome/data/talents/techniques/combat-training.lua:59
//          Heavy Armour Training -- `combatTalentScale(t, 1, 7, 0.75)`.
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

/**
 * Scorched Coat -- the Alchemist, in Ministration.
 *
 * "The coat has been through this before. It counts as armour now."
 *
 * THE SAME BAND STANDING ORDERS USES, DELIBERATELY. ToME hands Armour Training
 * to a great many classes and does not re-tune it per class -- that is what a
 * shared talent IS. Two coats made of different things stopping the same amount
 * of a blow is upstream's answer, and inventing a second band to look original
 * would be a number with no source behind it.
 *
 * WHAT DIFFERS IS WHERE IT SITS. The Watchman's is in the tree about standing in
 * the way; this is in the tree about keeping other people upright, and it is the
 * only thing in Ministration that helps the Alchemist survive doing it.
 *
 * IT HAS NO `onUse`, AND THAT IS THE DECLARATION. See `Talent.onUse` -- the
 * absent body IS `mode = "passive"`.
 */

import { combatTalentScale } from '../../shared/scale.ts';
import { DamageType } from '../engine/damage.ts';
import { Affinity, ClassId, TalentKind, TargetShape } from '../engine/talents.ts';
import type { Talent } from '../engine/talents.ts';

/** ToME's armour band, verbatim -- combat-training.lua:59. */
const ARMOUR_LOW = 1;
const ARMOUR_HIGH = 7;
const CURVE = 0.75;

/** Armour at a rank. */
export function armourAt(level: number): number {
  return Math.round(combatTalentScale(level, ARMOUR_LOW, ARMOUR_HIGH, CURVE));
}

export const scorchedCoat: Talent = {
  id: 'talent:scorched_coat',
  name: 'Scorched Coat',
  classId: ClassId.Alchemist,
  tree: 'ashwick/ministration',
  /** Tier 3 of its tree. See `src/shared/tiers.ts`. */
  tier: 3,
  /** ministration is about WIL. See `Talent.statGate`. */
  statGate: 'wil',
  kind: TalentKind.Passive,
  iconId: 'icon_passive_scorched_coat',
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
  damageType: DamageType.Fire,

  passive: (level) => ({ mods: { armour: armourAt(level) } }),

  describe: (_self, level) =>
    `Always on. The coat is worth ${String(armourAt(level))} armour by now.`,
};
