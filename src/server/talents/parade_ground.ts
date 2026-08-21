// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// NUMBERS: t-engine4 game/modules/tome/data/talents/undeads/ghoul.lua:26 -- statBonus = ceil(combatTalentScale(t, 2, 15, 0.75)).
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

/**
 * Parade Ground -- the Watchman, in Discipline.
 *
 * "Drill until the arm stops asking."
 *
 * A PRIMARY STAT, WHICH IS THE WIDEST THING A TALENT POINT CAN BUY HERE.
 * Strength feeds the Watchman's `damMod` of 0.6 (content/classes.ts), his
 * carrying, and every physical save that reads it -- so this is the one
 * passive in the tree whose effect the player cannot fully enumerate, and
 * that is deliberate. ToME's stat talents are the same bargain.
 *
 * IT IS DELIBERATELY THE SMALLEST BAND IN THE FILE. A stat is worth more per
 * point than a mod because it multiplies rather than adds.
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

/** Strength granted at a rank. */
export function strengthAt(level: number): number {
  return Math.round(combatTalentScale(level, LOW, HIGH, CURVE));
}

export const paradeGround: Talent = {
  id: 'talent:parade_ground',
  name: 'Parade Ground',
  classId: ClassId.Watchman,
  tree: 'watch/discipline',
  /** Tier 2 of its tree. See `src/shared/tiers.ts`. */
  tier: 2,
  /** discipline is about STR. See `Talent.statGate`. */
  statGate: 'str',
  kind: TalentKind.Passive,
  iconId: 'icon_passive_parade_ground',
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

  passive: (level) => ({ stats: { str: strengthAt(level) } }),

  describe: (_self, level) =>
    `Always on. ${String(strengthAt(level))} more Strength, which touches everything.`,
};
