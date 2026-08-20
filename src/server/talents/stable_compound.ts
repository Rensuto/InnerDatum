// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// NUMBERS: t-engine4 game/modules/tome/data/talents/engine/derived.ts:162 -- combat_generic_power (Combat.lua:1693, 1748, 2060).
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

/**
 * Stable Compound -- the Alchemist, in Reagents.
 *
 * "The trick is not the reaction. It is the reaction stopping."
 *
 * `genericPower` IS ADDED TO ALL THREE POWERS, which is why the band is the
 * smallest of the four mod passives here. Upstream adds it once and reads it
 * in physical, spell and mind power alike; this game only reads two of the
 * three today, and the third costs nothing to be correct about in advance.
 *
 * NOT A DEAD CHANNEL, AND THAT WAS CHECKED. `content/egos.ts:270` already
 * grants it, and `derived.ts` folds it into the powers rather than storing it
 * -- unlike `apr`, which no monster in this game has enough armour to make
 * matter, and `mentalResist`, which nothing authored reads. Both of those were
 * rejected for exactly this slot.
 *
 * IT HAS NO `onUse`, AND THAT IS THE DECLARATION. See `Talent.onUse` -- the
 * absent body IS `mode = "passive"`.
 */

import { combatTalentScale } from '../../shared/scale.ts';
import { DamageType } from '../engine/damage.ts';
import { Affinity, ClassId, TalentKind, TargetShape } from '../engine/talents.ts';
import type { Talent } from '../engine/talents.ts';

/** Small on purpose: it is added to every power, not one. */
const LOW = 1;
const HIGH = 5;
const CURVE = 0.75;

/** Power added to every school at a rank. */
export function powerAt(level: number): number {
  return Math.round(combatTalentScale(level, LOW, HIGH, CURVE));
}

export const stableCompound: Talent = {
  id: 'talent:stable_compound',
  name: 'Stable Compound',
  classId: ClassId.Alchemist,
  tree: 'ashwick/reagents',
  kind: TalentKind.Passive,
  iconId: 'icon_passive_stable_compound',
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

  passive: (level) => ({ mods: { genericPower: powerAt(level) } }),

  describe: (_self, level) =>
    `Always on. ${String(powerAt(level))} more power behind everything you do.`,
};
