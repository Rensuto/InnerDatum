// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// NUMBERS: t-engine4 game/modules/tome/data/talents/techniques/conditioning.lua:51-56 -- Unflinching Resolve,
//          a Constitution-scaled chance to shrug off an effect.
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

/**
 * Unflinching -- GROUNDWORK, the category every class carries.
 *
 * "You have been shouted at by worse than this."
 *
 * THE PHYSICAL SAVE, WHICH IS WHAT `STUNNED` AND `SLOWED` ARE ROLLED
 * AGAINST. Upstream's version is a percentage chance to shed an effect after
 * it lands; this game has no shed-on-tick machinery, and the same intent is
 * expressed here as the save that stops it landing at all -- which is the
 * channel `EffectDef.type` already reads.
 *
 * IT MATTERS MORE NOW THAN IT WOULD HAVE LAST WEEK. Three talents in this
 * game apply `STUNNED` or `SLOWED` and monsters have them too. Field Dressing
 * is the Alchemist's answer AFTER one lands; this is everybody's answer
 * before it does, and a party should be able to buy either.
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

/** The house save band, matching Seen Worse and Contingencies. */
const LOW = 4;
const HIGH = 16;
const CURVE = 0.75;

/** Flat physical save at a rank. */
export function saveAt(level: number): number {
  return Math.round(combatTalentScale(level, LOW, HIGH, CURVE));
}

export const unflinching: Talent = {
  id: 'talent:unflinching',
  name: 'Unflinching',
  classId: null,
  tree: 'generic/groundwork',
  kind: TalentKind.Passive,
  iconId: 'icon_passive_unflinching',
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
    `Always on. ${String(saveAt(level))} harder to stun, slow or knock about.`,
};
