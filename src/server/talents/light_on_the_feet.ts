// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// NUMBERS: t-engine4 game/modules/tome/data/talents/techniques/combat-training.lua:117-128 -- Light Armour Training,
//          getDefense scales on talent level times Dexterity.
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

/**
 * Light on the Feet -- GROUNDWORK, the category every class carries.
 *
 * "The first thing they teach is where not to be standing."
 *
 * DEFENCE, WHICH IS THE OTHER WAY TO NOT BE HIT. Issued Kit above blunts a
 * blow that landed; this is the roll it never gets to make. Upstream splits
 * its armour training the same way and for the same reason, and a player who
 * has taken one and is still being hit knows which to take next.
 *
 * A FLAT BAND, WHERE UPSTREAM'S SCALES ON DEXTERITY TOO. That coupling is
 * real and deliberate upstream -- light armour rewards the dextrous -- but it
 * would make this talent worth three times as much to an Inspector as to a
 * Watchman, and the whole argument for a shared tree is that it is worth the
 * same to everybody. The Dexterity coupling lives on Powder Discipline, where
 * it belongs to a class.
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

/** Flat, not Dex-coupled — see the header. */
const LOW = 1;
const HIGH = 6;
const CURVE = 0.75;

/** Flat defence at a rank. */
export function defenceAt(level: number): number {
  return Math.round(combatTalentScale(level, LOW, HIGH, CURVE));
}

export const lightOnTheFeet: Talent = {
  id: 'talent:light_on_the_feet',
  name: 'Light on the Feet',
  classId: null,
  tree: 'generic/groundwork',
  /** Tier 2 of its tree. See `src/shared/tiers.ts`. */
  tier: 2,
  kind: TalentKind.Passive,
  iconId: 'icon_passive_light_on_the_feet',
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

  passive: (level) => ({ mods: { def: defenceAt(level) } }),

  describe: (_self, level) => `Always on. ${String(defenceAt(level))} harder to land a blow on.`,
};
