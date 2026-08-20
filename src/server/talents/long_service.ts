// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// NUMBERS: t-engine4 game/modules/tome/data/talents/techniques/conditioning.lua:21-31 -- Vitality, the Constitution
//          talent of upstream's conditioning tree.
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

/**
 * Long Service -- GROUNDWORK, the category every class carries.
 *
 * "Years of it. The body keeps a ledger too."
 *
 * CONSTITUTION, WHICH IS THE STAT UPSTREAM'S VITALITY IS ABOUT. Ours grants
 * the stat rather than the regeneration and wound-reduction Vitality carries,
 * because this game has neither channel -- and a talent that granted a
 * regeneration nothing reads would be the dead control the whole passive pass
 * was written to avoid.
 *
 * IT DOUBLES Long Hours, ON PURPOSE. The Alchemist's own Constitution passive
 * exists because that class dies first and heals nobody afterwards; this
 * exists because everybody's body is a body. Stacking them is a legitimate
 * build rather than an oversight, and it is exactly what ToME's generic and
 * class trees do to each other.
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

/** The house stat band — see `parade_ground.ts` for the ratio argument. */
const LOW = 1;
const HIGH = 5;
const CURVE = 0.75;

/** Constitution granted at a rank. */
export function constitutionAt(level: number): number {
  return Math.round(combatTalentScale(level, LOW, HIGH, CURVE));
}

export const longService: Talent = {
  id: 'talent:long_service',
  name: 'Long Service',
  classId: null,
  tree: 'generic/groundwork',
  kind: TalentKind.Passive,
  iconId: 'icon_passive_long_service',
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
    `Always on. ${String(constitutionAt(level))} more Constitution — you last longer.`,
};
