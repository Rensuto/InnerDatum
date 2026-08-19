// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// NUMBERS: t-engine4 game/modules/tome/data/talents/celestial/sun.lua:138,142
//          `getCrit = combatTalentScale(t, 2, 10, 0.75)` ->
//          `talentTemporaryValue(p, "combat_physcrit", getCrit(self, t))`
// SHAPE:   the same lines, and again at gifts/sand-drake.lua:37,41 — the
//          identical passive on an unrelated class. Two independent uses of one
//          band is a TUNING; one talent's use of it is that talent's accident.
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" — https://te4.org/license

/**
 * MEASURED DOSES — the Alchemist's passive, and what makes Reagents a tree.
 *
 * "You stopped guessing at the quantities some time ago."
 *
 * ═══ WHY CRIT, AND WHY GENERIC RATHER THAN PHYSICAL ═══
 * ToME hangs this band on `combat_physcrit` because both of its owners swing a
 * weapon. The Alchemist throws vials, and `genericCrit` is the field our own
 * derived layer reads for anything that is not a weapon blow — so keeping the
 * citation on `physCrit` would be a citation preserved and a meaning lost. Same
 * band, correct field, and the difference is written down rather than silent.
 *
 * ═══ IT HAS NO `onUse`, AND THAT IS THE DECLARATION ═══
 * See `Talent.onUse` — the absent body IS `mode = "passive"`. `submitTalent`
 * refuses it before charging anything, so a stale hotbar or a mis-click costs a
 * sentence rather than a turn.
 */

import { combatTalentScale } from '../../shared/scale.ts';
import { DamageType } from '../engine/damage.ts';
import { Affinity, ClassId, TalentKind, TargetShape } from '../engine/talents.ts';
import type { Talent } from '../engine/talents.ts';

/** ToME's band, at sun.lua:138 and again at sand-drake.lua:37. */
const CRIT_LOW = 2;
const CRIT_HIGH = 10;
const CURVE = 0.75;

/** Critical chance at a rank, in percentage points. sun.lua:138. */
export function critAt(level: number): number {
  return Math.round(combatTalentScale(level, CRIT_LOW, CRIT_HIGH, CURVE));
}

export const measuredDoses: Talent = {
  id: 'talent:measured_doses',
  name: 'Measured Doses',
  classId: ClassId.Alchemist,
  tree: 'ashwick/reagents',
  kind: TalentKind.Passive,
  iconId: 'icon_passive_measured_doses',
  // A PASSIVE COSTS NOTHING TO HAVE — see `cold_reading.ts` for the whole note.
  cost: { ap: 0 },
  cooldownTurns: 0,
  /** Never aimed. `cold_reading.ts` carries the argument for these fields. */
  targeting: {
    shape: TargetShape.Self,
    range: 0,
    minRange: 0,
    radius: 0,
    requiresLos: false,
    affinity: Affinity.Ally,
  },
  damageType: DamageType.Fire,

  passive: (level) => ({ mods: { genericCrit: critAt(level) } }),

  describe: (_self, level) =>
    `Always on. Everything you throw crits ${String(critAt(level))}% more often.`,
};
