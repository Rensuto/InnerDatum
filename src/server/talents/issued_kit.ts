// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// NUMBERS: t-engine4 game/modules/tome/data/talents/techniques/combat-training.lua:39-65 -- Heavy Armour Training,
//          getArmor = combatTalentScale(t, 1, 7, 0.75) and
//          getArmorHardiness = combatTalentScale(t, 1, 9).
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

/**
 * Issued Kit -- GROUNDWORK, the category every class carries.
 *
 * "It is not good armour. It is armour you were taught to wear."
 *
 * BOTH HALVES OF THE UPSTREAM TALENT, because in this game they are two
 * different numbers with two different jobs. `armour` is subtracted from a
 * blow; `armourHardiness` is what FRACTION of the blow armour is allowed to
 * touch at all (Combat.lua:1336, added to a base of 30). Granting one without
 * the other is the classic way a defensive talent reads well and does almost
 * nothing.
 *
 * IT STACKS WITH Standing Orders AND Scorched Coat, which both buy `armour`
 * on their own class trees. That is not a duplication to be tidied away --
 * ToME's Armour Training stacks with worn armour and with everything else,
 * and a generic tree that could not be combined with a class tree would be a
 * tree nobody spends on.
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

/** Upstream's own bands, in this game's units. */
const LOW = 1;
const HIGH = 7;
const CURVE = 0.75;

/** Flat armour at a rank. */
export function armourAt(level: number): number {
  return Math.round(combatTalentScale(level, LOW, HIGH, CURVE));
}

/** Hardiness at a rank -- upstream's second band, `combatTalentScale(t, 1, 9)`. */
const HARD_LOW = 2;
const HARD_HIGH = 12;
export function hardinessAt(level: number): number {
  return Math.round(combatTalentScale(level, HARD_LOW, HARD_HIGH, CURVE));
}

export const issuedKit: Talent = {
  id: 'talent:issued_kit',
  name: 'Issued Kit',
  classId: null,
  tree: 'generic/groundwork',
  /** Tier 1 of its tree. See `src/shared/tiers.ts`. */
  tier: 1,
  kind: TalentKind.Passive,
  iconId: 'icon_passive_issued_kit',
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

  passive: (level) => ({ mods: { armour: armourAt(level), armourHardiness: hardinessAt(level) } }),

  describe: (_self, level) =>
    `Always on. ${String(armourAt(level))} more armour, and it stops ${String(hardinessAt(level))}% more of what it is hit by.`,
};
