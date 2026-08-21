// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// SHAPE:   t-engine4 game/modules/tome/data/talents/cunning/tactical.lua
//          -- Tactical Expert, whose bonus is a function of who is adjacent.
// NUMBERS: authored. Upstream's counts NEARBY foes and rises with them; this
//          one falls with them, for the reason in the header.
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

/**
 * ONE AT A TIME -- NIGHTSHIFT.
 *
 * "A doorway is worth more than a friend. A friend will not stay where you put
 * them."
 *
 * ═══ IT RISES WHEN YOU ARE FIGHTING ONE THING, AND THAT IS BACKWARDS ═══
 * Upstream's Tactical Expert pays MORE the more bodies are around you, which is
 * a talent about being surrounded and coping. This pays most when exactly one
 * thing is in reach, and it is a talent about ARRANGING not to be surrounded --
 * about the corridor, the doorway, the corner you backed into on purpose.
 *
 * That is a decision this game already asks and had nothing to reward. Every
 * map here has rooms and doors; a party that fights in a doorway takes fewer
 * blows, and until now the only payoff was the blows themselves. This makes
 * positioning worth a talent point.
 *
 * ═══ ZERO ADJACENT IS ZERO BONUS, NOT THE MAXIMUM ═══
 * The obvious formula is "the fewer the better", and it hands a character
 * standing alone across the room the full figure for doing nothing. This pays
 * for FIGHTING one thing, so the count has to be exactly one -- alone is worth
 * nothing, and the Inspector shooting from six tiles away does not get it.
 */

import { combatTalentScale } from '../../shared/scale.ts';
import { DamageType } from '../engine/damage.ts';
import { Affinity, TalentKind, TargetShape } from '../engine/talents.ts';
import { EMPTY_PASSIVE_VIEW } from '../engine/hooks.ts';
import type { Talent } from '../engine/talents.ts';

const ATK_LOW = 4;
const ATK_HIGH = 18;
const CURVE = 0.75;

/** Accuracy against a lone adjacent foe, at a rank. */
export function accuracyAt(level: number): number {
  return Math.round(combatTalentScale(level, ATK_LOW, ATK_HIGH, CURVE));
}

/**
 * AND CRIT, WHICH IS WHAT MAKES IT AN OFFENSIVE TALENT RATHER THAN A HIT-RATE
 * ONE. Accuracy alone stops mattering once it is enough; a crit chance keeps
 * paying, and it is what turns a held doorway into a threat instead of a stall.
 */
const CRIT_LOW = 2;
const CRIT_HIGH = 9;

/** Physical crit chance against a lone adjacent foe, at a rank. */
export function critAt(level: number): number {
  return Math.round(combatTalentScale(level, CRIT_LOW, CRIT_HIGH, CURVE));
}

export const oneAtATime: Talent = {
  id: 'talent:one_at_a_time',
  name: 'One at a Time',
  classId: null,
  tree: 'generic/nightshift',
  /** Tier 2 of its tree. See `src/shared/tiers.ts`. */
  tier: 2,
  kind: TalentKind.Passive,
  iconId: 'icon_passive_one_at_a_time',
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
    // EXACTLY ONE. `EMPTY_PASSIVE_VIEW` answers zero, so a fixture with no world
    // correctly gets nothing -- see the header on why alone is not the maximum.
    if (view.adjacentEnemies() !== 1) return {};
    return { mods: { atk: accuracyAt(level), physCrit: critAt(level) } };
  },

  describe: (_self, level) =>
    `Always on, while exactly one enemy is next to you. ${String(accuracyAt(level))} accuracy and ` +
    `${String(critAt(level))}% critical chance — a doorway is worth a talent point.`,
};
