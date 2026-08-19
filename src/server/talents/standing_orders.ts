// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// NUMBERS: t-engine4 game/modules/tome/data/talents/techniques/combat-training.lua:59
//          Heavy Armour Training — `getArmor = combatTalentScale(t, 1, 7, 0.75)`
// SHAPE:   the same file :39-59 — `mode = "passive"`, `points = 5`, and
//          combat-training.lua's comment "Called by _M:combatArmor" is the whole
//          contract: a passive writes a number the getter already reads.
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" — https://te4.org/license

/**
 * STANDING ORDERS — the first passive in the game, and the Watchman's.
 *
 * "You wear the coat correctly. It is heavier than it looks and that is the
 * point."
 *
 * ═══ WHY ARMOUR, AND WHY THIS CLASS FIRST ═══
 * `The Line` is the tree about standing where somebody else would have been hit
 * (content/talent-trees.ts), and every talent in it so far is something you
 * PRESS at the moment of the hit — Iron Curtain, Lockdown. A tree of nothing but
 * reactions asks a player to be in the right place at the right time twice. A
 * passive in it is the half that pays while you are simply standing there, which
 * is what the class does most.
 *
 * ═══ 1 TO 7 IS ToME'S BAND, NOT A GUESS ═══
 * `combatTalentScale(t, 1, 7, 0.75)` verbatim from Heavy Armour Training. What
 * is NOT ported is its `ArmorEffect` multiplier, which reads the body slot's
 * subtype and returns 0 for cloth and light — this game has no armour subtypes,
 * so the multiplier would be a constant 1 dressed up as a lookup. The band is
 * the tuning; the multiplier is a system we do not have.
 *
 * ═══ IT HAS NO `onUse`, AND THAT IS THE DECLARATION ═══
 * See `Talent.onUse` — the absent body IS `mode = "passive"`. `submitTalent`
 * refuses this one before charging anything, so a stale hotbar or a mis-click
 * costs a sentence rather than a turn.
 */

import { combatTalentScale } from '../../shared/scale.ts';
import { DamageType } from '../engine/damage.ts';
import { Affinity, ClassId, TalentKind, TargetShape } from '../engine/talents.ts';
import type { Talent } from '../engine/talents.ts';

/** ToME's band for this passive, verbatim — combat-training.lua:59. */
const ARMOUR_LOW = 1;
const ARMOUR_HIGH = 7;
/** The curve's exponent, also ToME's. */
const CURVE = 0.75;

/** Armour at a rank. combat-training.lua:59. */
export function armourAt(level: number): number {
  return Math.round(combatTalentScale(level, ARMOUR_LOW, ARMOUR_HIGH, CURVE));
}

export const standingOrders: Talent = {
  id: 'talent:standing_orders',
  name: 'Standing Orders',
  classId: ClassId.Watchman,
  tree: 'watch/the-line',
  kind: TalentKind.Passive,
  iconId: 'icon_passive_standing_orders',
  // A PASSIVE COSTS NOTHING TO HAVE. The zeroes are not a placeholder for a cost
  // nobody decided: there is no moment at which this is paid for, which is what
  // the word means. `canUseTalent` never runs against it — `submitTalent` refuses
  // it above the payment block.
  cost: { ap: 0 },
  cooldownTurns: 0,
  /**
   * NEVER AIMED. `TargetShape.Self` at range 0, and `Affinity.Ally` because the
   * union has no self-only member and you are an ally of yourself — the reading
   * `iron_curtain.ts` already relies on. A passive is never targeted at all, so
   * every field here is a formality; they are filled in honestly rather than
   * left to look aimable.
   */
  targeting: {
    shape: TargetShape.Self,
    range: 0,
    minRange: 0,
    radius: 0,
    requiresLos: false,
    affinity: Affinity.Ally,
  },
  damageType: DamageType.Physical,

  passive: (level) => ({ mods: { armour: armourAt(level) } }),

  describe: (_self, level) =>
    `Always on. Your coat is worth ${String(armourAt(level))} armour, on top of anything you wear.`,
};
