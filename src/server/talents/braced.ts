// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// SHAPE:   t-engine4 game/modules/tome/data/talents/techniques/combat-training.lua
//          -- Armour Training, the flat-armour entry of the generic tree.
// NUMBERS: authored. The STANDING-STILL condition is ours and is
//          `T_SHIELD_WALL`'s shape (shield-defense.lua) without the shield.
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

/**
 * BRACED -- NIGHTSHIFT.
 *
 * "Feet apart, weight down. You are not going anywhere and neither is it."
 *
 * ═══ THE OTHER HALF OF LIGHT ON THE FEET, DELIBERATELY ═══
 * `generic/groundwork` sells defence flatly, and defence is what you want while
 * moving. This is armour you only have while you are NOT, and the two together
 * are the first real fork in the shared trees: a character who kites buys one, a
 * character who holds a doorway buys the other, and a character who buys both
 * has spent four points to be adequate at each.
 *
 * ═══ IT READS THE SAME LATCH THE ENGINE ALREADY KEEPS ═══
 * `TalentSheet.movedThisTurn` exists for the scheduler; `PassiveView.movedThisTurn`
 * is the read-only window onto it. Nothing new is tracked and nothing can drift,
 * which is the whole reason the view is a set of questions rather than a bag of
 * numbers copied out once a turn.
 *
 * ═══ AND IT IS NOT A TRAP ═══
 * The bonus is gone the instant you step, and the panel says so in those words.
 * A conditional that a player has to discover by dying is a bad talent however
 * good its numbers are.
 */

import { combatTalentScale } from '../../shared/scale.ts';
import { DamageType } from '../engine/damage.ts';
import { Affinity, TalentKind, TargetShape } from '../engine/talents.ts';
import { EMPTY_PASSIVE_VIEW } from '../engine/hooks.ts';
import type { Talent } from '../engine/talents.ts';

/**
 * WIDER THAN ISSUED KIT'S BAND, because this is off whenever the character
 * moves and Issued Kit never is. A conditional worth the same as an
 * unconditional is a conditional nobody buys.
 */
const ARMOUR_LOW = 3;
const ARMOUR_HIGH = 12;
const CURVE = 0.75;

/** Armour while standing, at a rank. */
export function armourAt(level: number): number {
  return Math.round(combatTalentScale(level, ARMOUR_LOW, ARMOUR_HIGH, CURVE));
}

/**
 * AND A LITTLE HARDINESS WITH IT. Armour without hardiness is a number that
 * stops mattering against anything that hits hard -- `armourHardiness` is what
 * decides how much of a blow armour is allowed to eat (Combat.lua), so a talent
 * that grants one and not the other is worth much less than it reads.
 */
const HARDINESS_LOW = 3;
const HARDINESS_HIGH = 12;

/** Armour hardiness while standing, at a rank. */
export function hardinessAt(level: number): number {
  return Math.round(combatTalentScale(level, HARDINESS_LOW, HARDINESS_HIGH, CURVE));
}

export const braced: Talent = {
  id: 'talent:braced',
  name: 'Braced',
  classId: null,
  tree: 'generic/nightshift',
  /** Tier 1 of its tree. See `src/shared/tiers.ts`. */
  tier: 1,
  kind: TalentKind.Passive,
  iconId: 'icon_passive_braced',
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
    // A BODY WITH NO WORLD HAS NOT MOVED, which is what `EMPTY_PASSIVE_VIEW`
    // answers and is the right default: a fixture asking what this talent is
    // worth should be told what it is worth when it applies.
    if (view.movedThisTurn()) return {};
    return { mods: { armour: armourAt(level), armourHardiness: hardinessAt(level) } };
  },

  describe: (_self, level) =>
    `Always on, while you stand still. ${String(armourAt(level))} armour and ` +
    `${String(hardinessAt(level))} hardiness on any turn you do not change tiles — ` +
    `gone the moment you step.`,
};
