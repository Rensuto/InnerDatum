// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// NUMBERS: t-engine4 game/modules/tome/data/talents/techniques/combat-training.lua:163-169 -- Combat Accuracy,
//          getAttack = combatTalentScale(t, 10, 50, 0.75).
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

/**
 * Called Shot -- the Inspector, in Marksmanship.
 *
 * "You do not fire at a man. You fire at a spot on him."
 *
 * ACCURACY, RESCALED BY RATIO RATHER THAN COPIED. `combatAttack` is
 * `4 + atk + weapon.atk + (dex - 10)` (engine/derived.ts). Upstream runs that
 * same formula over a Dex band of 10 -> 60, so a level-20 archer sits near 55
 * raw and +50 is roughly a doubling. Our classes are authored at Dex 12 -> 20,
 * which puts the Inspector near 14 raw -- so +50 would not be a doubling, it
 * would be a fourfold multiplier and would end the accuracy question for the
 * rest of the game.
 *
 * +8 AT RANK 5 IS THE SAME DEAL UPSTREAM OFFERS, measured as a proportion of
 * the accuracy the character actually has. That is the rule this file follows
 * whenever a ToME band crosses into this game's smaller numbers.
 *
 * IT HAS NO `onUse`, AND THAT IS THE DECLARATION. See `Talent.onUse` -- the
 * absent body IS `mode = "passive"`.
 */

import { combatTalentScale } from '../../shared/scale.ts';
import { DamageType } from '../engine/damage.ts';
import { Affinity, ClassId, TalentKind, TargetShape } from '../engine/talents.ts';
import type { Talent } from '../engine/talents.ts';

/** ToME is 10 -> 50; see the note above for why ours is 2 -> 8. */
const LOW = 2;
const HIGH = 8;
const CURVE = 0.75;

/** Flat accuracy at a rank. */
export function accuracyAt(level: number): number {
  return Math.round(combatTalentScale(level, LOW, HIGH, CURVE));
}

export const calledShot: Talent = {
  id: 'talent:called_shot',
  name: 'Called Shot',
  classId: ClassId.Inspector,
  tree: 'index/marksmanship',
  kind: TalentKind.Passive,
  iconId: 'icon_passive_called_shot',
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
    `Always on. ${String(accuracyAt(level))} more accuracy on every shot and swing.`,
};
