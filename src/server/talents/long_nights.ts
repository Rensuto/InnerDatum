// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// SHAPE:   t-engine4 game/modules/tome/data/talents/techniques/conditioning.lua:100-129
//          -- Unbreakable Will, whose figure is a function of the body's state.
// NUMBERS: authored. The RUNNING-ON-EMPTY condition is ours; it is `T_TRUE_GRIT`'s
//          missing-resource shape (conditioning.lua:23-49) read off the class pool.
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

/**
 * LONG NIGHTS -- NIGHTSHIFT.
 *
 * "The fourth hour is the one that teaches you something."
 *
 * ═══ THE ONLY TALENT IN THE GAME THAT READS THE CLASS RESOURCE ═══
 * Resolve, Focus and Reagents are spent by twelve talents and read by none: the
 * pool has always been a budget and never a STATE. This makes running it down
 * mean something, and it means something different for each of the three
 * classes, which is exactly the property a shared tree should have:
 *
 *   THE WATCHMAN builds Resolve by being hit, so a full bar is a bad sign and
 *   this is worth least when he is winning.
 *   THE INSPECTOR spends Focus on the shots that matter, so this pays for the
 *   fight having gone long.
 *   THE ALCHEMIST empties the bag deliberately, so this is close to a reward
 *   for playing the class the way it wants to be played.
 *
 * One talent, three readings, no per-class code. That is what a generic tree is
 * for, and it is why this is a better use of a category than a fourth flat save.
 *
 * ═══ MENTAL AND SPELL, NOT PHYSICAL ═══
 * The physical channel is crowded -- Unflinching, Second Wind and armour all
 * live there. These two are the ones a party has almost no answer to, and a
 * talent that is the answer to the thing you cannot otherwise answer is worth
 * more than a bigger number in the channel you already cover.
 */

import { combatTalentScale } from '../../shared/scale.ts';
import { DamageType } from '../engine/damage.ts';
import { Affinity, TalentKind, TargetShape } from '../engine/talents.ts';
import { EMPTY_PASSIVE_VIEW } from '../engine/hooks.ts';
import type { Talent } from '../engine/talents.ts';

const LOW = 6;
const HIGH = 24;
const CURVE = 0.75;

/** The full figure at a rank, on an empty pool. */
export function fullSaveAt(level: number): number {
  return combatTalentScale(level, LOW, HIGH, CURVE);
}

/**
 * What is granted: the full figure times the fraction of the pool that is GONE.
 *
 * `EMPTY_PASSIVE_VIEW` answers a FULL pool, so a fixture with no world gets
 * nothing -- which is the honest reading of "this character has not spent
 * anything yet".
 */
export function saveAt(level: number, resourceFraction: number): number {
  const spent = Math.min(1, Math.max(0, 1 - resourceFraction));
  return Math.round(fullSaveAt(level) * spent);
}

export const longNights: Talent = {
  id: 'talent:long_nights',
  name: 'Long Nights',
  classId: null,
  tree: 'generic/nightshift',
  /** Tier 3 of its tree. See `src/shared/tiers.ts`. */
  tier: 3,
  kind: TalentKind.Passive,
  iconId: 'icon_passive_long_nights',
  cost: { ap: 0 },
  cooldownTurns: 0,
  targeting: {
    shape: TargetShape.Self,
    range: 0,
    minRange: 0,
    radius: 0,
    requiresLos: false,
    affinity: Affinity.Ally,
  },
  damageType: DamageType.Physical,

  passive: (level, view = EMPTY_PASSIVE_VIEW) => {
    const save = saveAt(level, view.resourceFraction());
    return { mods: { mentalResist: save, spellResist: save } };
  },

  describe: (_self, level) =>
    `Always on. Up to ${String(Math.round(fullSaveAt(level)))} to mental and spell saves, ` +
    `in proportion to how much of your class resource you have spent — nothing on a full bar.`,
};
