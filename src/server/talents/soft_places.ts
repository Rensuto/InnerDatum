// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// NUMBERS: t-engine4 game/modules/tome/data/talents/techniques/thuggery.lua:105
//          Vicious Strikes -- `combatTalentScale(t, 6, 25, 0.75)` onto crit power.
// CUT:     the same talent's `getAPR` band at :106 is deliberately NOT ported.
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

/**
 * Soft Places -- the Watchman, in Discipline.
 *
 * "Nobody is armoured everywhere. You keep a list of where they are not."
 *
 * THE ARMOUR-PIERCING HALF WAS CUT, AND A MEASUREMENT IS WHY.
 * `thuggery.lua:106` pairs this crit-power band with armour penetration scaling
 * 5 to 20. Ported here it would be INERT: the heaviest armour on any monster in
 * `content/monsters.ts` is 4, and rank 1 alone would grant 5 -- so ranks 2
 * through 5 would print a rising number on the panel and change nothing at all
 * in play. A talent that lies about its own progression is worse than a talent
 * with one effect.
 *
 * WHAT SURVIVES IS THE HALF THAT BITES. Critical power multiplies a blow that
 * has already landed, so there is no ceiling in this content for it to hit.
 *
 * IT HAS NO `onUse`, AND THAT IS THE DECLARATION. See `Talent.onUse` -- the
 * absent body IS `mode = "passive"`.
 */

import { combatTalentScale } from '../../shared/scale.ts';
import { DamageType } from '../engine/damage.ts';
import { Affinity, ClassId, TalentKind, TargetShape } from '../engine/talents.ts';
import type { Talent } from '../engine/talents.ts';

/** ToME's crit-power band, verbatim -- thuggery.lua:105. */
const CRIT_POWER_LOW = 6;
const CRIT_POWER_HIGH = 25;
const CURVE = 0.75;

/** Critical power at a rank, in percentage points. */
export function critPowerAt(level: number): number {
  return Math.round(combatTalentScale(level, CRIT_POWER_LOW, CRIT_POWER_HIGH, CURVE));
}

export const softPlaces: Talent = {
  id: 'talent:soft_places',
  name: 'Soft Places',
  classId: ClassId.Watchman,
  tree: 'watch/discipline',
  /** Tier 1 of its tree. See `src/shared/tiers.ts`. */
  tier: 1,
  /** discipline is about STR. See `Talent.statGate`. */
  statGate: 'str',
  kind: TalentKind.Passive,
  iconId: 'icon_passive_soft_places',
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

  passive: (level) => ({ mods: { criticalPower: critPowerAt(level) } }),

  describe: (_self, level) =>
    `Always on. When you crit, it lands ${String(critPowerAt(level))}% harder.`,
};
