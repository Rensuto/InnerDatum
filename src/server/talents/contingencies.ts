// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// NUMBERS: t-engine4 game/modules/tome/data/talents/misc/races.lua:333-341
//          Unshackled -- `getSave = combatTalentScale(t, 6, 25, 0.75)`, written
//          into the physical and mental saves together.
// CUT:     the mental half.
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

/**
 * Contingencies -- the Inspector, in Fieldcraft.
 *
 * "You had a way out of this room before you came into it."
 *
 * ONE OF UPSTREAM'S TWO SAVES, FOR THE REASON `seen_worse` GIVES. Unshackled
 * writes its band into `combat_physresist` AND `combat_mentalresist` in one
 * call. Only the first has anything to resist here -- `content/effects.ts`
 * states that nothing authored uses the mental channel -- so porting both would
 * double the citation and halve the honesty.
 *
 * IT HAS NO `onUse`, AND THAT IS THE DECLARATION. See `Talent.onUse` -- the
 * absent body IS `mode = "passive"`.
 */

import { combatTalentScale } from '../../shared/scale.ts';
import { DamageType } from '../engine/damage.ts';
import { Affinity, ClassId, TalentKind, TargetShape } from '../engine/talents.ts';
import type { Talent } from '../engine/talents.ts';

/** ToME's save band, verbatim -- races.lua:333-341. */
const SAVE_LOW = 6;
const SAVE_HIGH = 25;
const CURVE = 0.75;

/** Physical resistance at a rank. */
export function saveAt(level: number): number {
  return Math.round(combatTalentScale(level, SAVE_LOW, SAVE_HIGH, CURVE));
}

export const contingencies: Talent = {
  id: 'talent:contingencies',
  name: 'Contingencies',
  classId: ClassId.Inspector,
  tree: 'index/fieldcraft',
  /** Tier 3 of its tree. See `src/shared/tiers.ts`. */
  tier: 3,
  /** fieldcraft is about CUN. See `Talent.statGate`. */
  statGate: 'cun',
  kind: TalentKind.Passive,
  iconId: 'icon_passive_contingencies',
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

  passive: (level) => ({ mods: { physResist: saveAt(level) } }),

  describe: (_self, level) =>
    `Always on. ${String(saveAt(level))} better at refusing what the body is told.`,
};
