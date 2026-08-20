// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// NUMBERS: t-engine4 game/modules/tome/data/talents/undeads/ghoul.lua:26 -- statBonus = ceil(combatTalentScale(t, 2, 15, 0.75)).
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

/**
 * Long Hours -- the Alchemist, in Ministration.
 *
 * "Nobody sent for a replacement, so."
 *
 * CONSTITUTION, WHICH IS WHAT KEEPS THE SUPPORT ALIVE LONG ENOUGH TO SUPPORT.
 * An Alchemist who dies on turn three healed nobody, and Ministration is the
 * tree that ought to say so. Scorched Coat already buys armour here, which
 * blunts each blow; this raises the pool the blows are coming out of, and the
 * two are worth different amounts against different enemies.
 *
 * DELIBERATELY NOT MORE HEALING. A third way to restore life in a tree that
 * has two would be the same talent again with a different sentence.
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

/** Constitution granted at a rank. */
export function constitutionAt(level: number): number {
  return Math.round(combatTalentScale(level, LOW, HIGH, CURVE));
}

export const longHours: Talent = {
  id: 'talent:long_hours',
  name: 'Long Hours',
  classId: ClassId.Alchemist,
  tree: 'ashwick/ministration',
  kind: TalentKind.Passive,
  iconId: 'icon_passive_long_hours',
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

  passive: (level) => ({ stats: { con: constitutionAt(level) } }),

  describe: (_self, level) =>
    `Always on. ${String(constitutionAt(level))} more Constitution -- you last.`,
};
