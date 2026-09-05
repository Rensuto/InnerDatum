// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// NUMBERS: t-engine4 game/modules/tome/data/talents/undeads/ghoul.lua:26 -- statBonus = ceil(combatTalentScale(t, 2, 15, 0.75)).
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

/**
 * Cut With Chalk -- the Alchemist, in Reagents.
 *
 * "Half of it is filler. Knowing which half is the job."
 *
 * CUNNING, WHICH IS THE ALCHEMIST'S STAT AND IS CURRENTLY BOUGHT BY NOTHING.
 * Measured Doses in this same tree buys crit chance, which is one narrow
 * number; this buys the stat that feeds it, along with everything else Cunning
 * touches. Taking both stacks in the obvious direction, which is the ToME
 * pattern of a tree that rewards commitment over breadth.
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

/** Cunning granted at a rank. */
export function cunningAt(level: number): number {
  /**
   * ═══ `ceil`, WHICH IS WHAT THE HEADER QUOTES ═══
   * `ghoul.lua:26` is `math.ceil(self:combatTalentScale(t, 2, 15, 0.75))`, and
   * the NUMBERS line at the top of this file quotes it WITH the `ceil`. This
   * read `Math.round`.
   *
   * The BAND rescale (2->15 becomes 1->6, because upstream's stats run 10->60+
   * against our 10->24) is argued above and stands. Rounding mode is not a band
   * and was not covered by it: on our own band the two rules agree at ranks 1,
   * 3, 4 and 5 and disagree at rank 2, where the raw value is 2.4545 — `round`
   * gives 2 and the rule we cite gives 3. One rank, one point, silently not the
   * cited behaviour.
   */
  return Math.ceil(combatTalentScale(level, LOW, HIGH, CURVE));
}

export const cutWithChalk: Talent = {
  id: 'talent:cut_with_chalk',
  name: 'Cut With Chalk',
  classId: ClassId.Alchemist,
  tree: 'ashwick/reagents',
  /** Tier 3 of its tree. See `src/shared/tiers.ts`. */
  tier: 3,
  /** reagents is about MAG. See `Talent.statGate`. */
  statGate: 'mag',
  kind: TalentKind.Passive,
  iconId: 'icon_passive_cut_with_chalk',
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

  passive: (level) => ({ stats: { cun: cunningAt(level) } }),

  describe: (_self, level) =>
    `Always on. ${String(cunningAt(level))} more Cunning, and it compounds.`,
};
