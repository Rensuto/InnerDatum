// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// SHAPE:   t-engine4 game/modules/tome/data/talents/techniques/combat-training.lua:125-127
//          Light Armour Training -- `getArmorHardiness`, an asymptotic
//          `combatLimit` curve this game has no port of.
//          (Was :128 "reaches 37.5 at rank 5", and BOTH halves were wrong.
//          :128 is `getDefense` -- the next field down the same talent, which
//          is why a name-check could not see it: the line is inside the right
//          block, just not on the right field. And 37.5 is not a hardiness at
//          all. `combatLimit(x, limit, y_low, x_low, y_high, x_high)` is
//          Combat.lua:1487, so the call's trailing pair reads "x=37.5 anchors
//          y=50" -- 37.5 is an ARGUMENT on the x axis. Upstream reaches 33.7 at
//          rank 5, and 50 only at talent level 9.375, which mastery makes
//          reachable. See `scale.ts`, "NEVER CLAMP THE TALENT LEVEL AT 5".)
// OURS:    the band is 5 -> 30 on `combatTalentScale`. See below.
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

/**
 * The Long Shift -- the Watchman, in The Line.
 *
 * "Twelve hours on your feet teaches the coat where to take a blow."
 *
 * THE BAND IS OURS AND THE INTENT IS UPSTREAM'S. Armour hardiness is the
 * PERCENTAGE of your armour that actually applies, and `derived.ts` starts
 * everybody at 30. Forcing `combatLimit`'s endpoints onto `combatTalentScale`
 * would be a citation kept and a curve shape lost, so the number is ours and
 * says so.
 *
 * MEASURED AGAINST THE CURVE IT REPLACES, it is a deliberate shave and not a
 * different shape -- upstream runs 5.6 / 14.7 / 22.1 / 28.4 / 33.7 over ranks
 * 1-5 and ours runs 5 / 12.3 / 18.6 / 24.5 / 30. Worth stating because the
 * header used to claim upstream ended at 37.5, which made the gap look four
 * times wider than it is and this band look arbitrary rather than tuned.
 *
 * 5 TO 30 IS DELIBERATELY SHORT OF STANDING ORDERS. This sits in the same tree,
 * and a second armour talent that out-performed the one the class starts with
 * would turn the first into a wasted point rather than a foundation.
 *
 * IT HAS NO `onUse`, AND THAT IS THE DECLARATION. See `Talent.onUse` -- the
 * absent body IS `mode = "passive"`.
 */

import { combatTalentScale } from '../../shared/scale.ts';
import { DamageType } from '../engine/damage.ts';
import { Affinity, ClassId, TalentKind, TargetShape } from '../engine/talents.ts';
import type { Talent } from '../engine/talents.ts';

/**
 * OURS -- see the header. Added onto `derived.ts`'s base hardiness of 30, so a
 * rank-1 Watchman applies 35% of his armour and a rank-5 one applies 60%.
 */
const HARD_LOW = 5;
const HARD_HIGH = 30;
/** ToME's curve exponent, which IS ported. */
const CURVE = 0.75;

/** Extra armour hardiness at a rank, in percentage points. */
export function hardinessAt(level: number): number {
  return Math.round(combatTalentScale(level, HARD_LOW, HARD_HIGH, CURVE));
}

export const theLongShift: Talent = {
  id: 'talent:the_long_shift',
  name: 'The Long Shift',
  classId: ClassId.Watchman,
  tree: 'watch/the-line',
  /** Tier 3 of its tree. See `src/shared/tiers.ts`. */
  tier: 3,
  /** the-line is about CON. See `Talent.statGate`. */
  statGate: 'con',
  kind: TalentKind.Passive,
  iconId: 'icon_passive_the_long_shift',
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

  passive: (level) => ({ mods: { armourHardiness: hardinessAt(level) } }),

  describe: (_self, level) =>
    `Always on. ${String(hardinessAt(level))}% more of your armour actually applies.`,
};
