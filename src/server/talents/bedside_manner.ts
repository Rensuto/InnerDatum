// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// NUMBERS: t-engine4 game/modules/tome/data/talents/undeads/ghoul.lua:26 -- statBonus = ceil(combatTalentScale(t, 2, 15, 0.75)).
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

/**
 * Bedside Manner -- the Alchemist, in Ministration.
 *
 * "Talk while you work. It matters more than the poultice."
 *
 * WILLPOWER, THE LAST PRIMARY STAT NO TALENT IN THIS GAME GRANTS. It is read
 * by the saves and by the resource the Alchemist spends, so it is the stat
 * that decides how many times a fight this class gets to act at all.
 *
 * IT COMPLETES THE SET ON PURPOSE. Between Parade Ground (Strength), Powder
 * Discipline (Dexterity), Cut With Chalk (Cunning), Long Hours (Constitution)
 * and this, five of the six primaries are now reachable by spending a point,
 * one per class-appropriate tree. Magic is the exception and stays one: no
 * authored content reads it yet, and a talent that grants an unread stat is
 * the dead control this whole pass exists to avoid.
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

/** Willpower granted at a rank. */
export function willpowerAt(level: number): number {
  return Math.round(combatTalentScale(level, LOW, HIGH, CURVE));
}

export const bedsideManner: Talent = {
  id: 'talent:bedside_manner',
  name: 'Bedside Manner',
  classId: ClassId.Alchemist,
  tree: 'ashwick/ministration',
  kind: TalentKind.Passive,
  iconId: 'icon_passive_bedside_manner',
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

  passive: (level) => ({ stats: { wil: willpowerAt(level) } }),

  describe: (_self, level) =>
    `Always on. ${String(willpowerAt(level))} more Willpower behind the work.`,
};
