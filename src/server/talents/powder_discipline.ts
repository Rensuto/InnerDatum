// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// NUMBERS: t-engine4 game/modules/tome/data/talents/undeads/ghoul.lua:26 -- statBonus = ceil(combatTalentScale(t, 2, 15, 0.75)).
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

/**
 * Powder Discipline -- the Inspector, in Marksmanship.
 *
 * "Measure it twice and it never surprises you."
 *
 * DEXTERITY, WHICH IS THIS CLASS'S WHOLE ARGUMENT. It is in `combatAttack`
 * directly, it is in the revolver's `damMod`, and it is in defence -- so one
 * point here quietly improves the three numbers an Inspector cares about at
 * once.
 *
 * THAT IS WHY IT SITS BESIDE Called Shot RATHER THAN REPLACING IT. Called Shot
 * buys accuracy and nothing else, which is legible and cheap; this buys a
 * little of everything, which is broad and expensive. A player who wants to
 * hit reliably takes the first; a player building the whole character takes
 * the second. Both are correct, and having both is the point of a tree.
 *
 * IT HAS NO `onUse`, AND THAT IS THE DECLARATION. See `Talent.onUse` -- the
 * absent body IS `mode = "passive"`.
 */

import { combatTalentScale } from '../../shared/scale.ts';
import { DamageType } from '../engine/damage.ts';
import { Affinity, ClassId, TalentKind, TargetShape } from '../engine/talents.ts';
import type { Talent } from '../engine/talents.ts';

/** ToME's band is 2 -> 15 (ghoul.lua:26). RESCALED, and the ratio is why:
 * upstream's primary stats run 10 -> 60+, so +15 is roughly a quarter of a
 * high stat. Ours are authored at 10 -> 24 (`content/classes.ts`), so the
 * same PROPORTION is +6, and copying the number instead of the ratio would
 * make one talent point worth more than the whole class table. */
const LOW = 1;
const HIGH = 6;
const CURVE = 0.75;

/** Dexterity granted at a rank. */
export function dexterityAt(level: number): number {
  return Math.round(combatTalentScale(level, LOW, HIGH, CURVE));
}

export const powderDiscipline: Talent = {
  id: 'talent:powder_discipline',
  name: 'Powder Discipline',
  classId: ClassId.Inspector,
  tree: 'index/marksmanship',
  kind: TalentKind.Passive,
  iconId: 'icon_passive_powder_discipline',
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

  passive: (level) => ({ stats: { dex: dexterityAt(level) } }),

  describe: (_self, level) =>
    `Always on. ${String(dexterityAt(level))} more Dexterity -- aim, damage and footwork at once.`,
};
