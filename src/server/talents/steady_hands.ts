// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// NUMBERS: t-engine4 game/modules/tome/data/talents/cunning/called-shots.lua:25-26
//          Sling Sniper -- crit chance 3 -> 10, crit power 0.1 -> 0.2 at 0.75.
//          The power band is read as PERCENTAGE POINTS (10 -> 20) because that is
//          the unit `CombatMods.criticalPower` carries; upstream stores a fraction.
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

/**
 * Steady Hands -- the Inspector, in Marksmanship.
 *
 * "Your hand has been steady since the second body."
 *
 * BOTH HALVES LAND, WHICH IS WHY THIS ONE IS WHOLE. Unlike Soft Places and Seen
 * Worse, neither band here runs into a ceiling this game has: critical CHANCE is
 * a roll and critical POWER multiplies a blow that already landed.
 *
 * IT IS THE RANGED CLASS'S ANSWER TO STANDING ORDERS. The Watchman's passive
 * pays while he is standing in the way; this one pays on the shot the Inspector
 * was going to take anyway -- the difference between the two classes stated in a
 * stat block rather than in prose.
 *
 * IT HAS NO `onUse`, AND THAT IS THE DECLARATION. See `Talent.onUse` -- the
 * absent body IS `mode = "passive"`.
 */

import { combatTalentScale } from '../../shared/scale.ts';
import { DamageType } from '../engine/damage.ts';
import { Affinity, ClassId, TalentKind, TargetShape } from '../engine/talents.ts';
import type { Talent } from '../engine/talents.ts';

/** ToME's bands -- called-shots.lua:25-26. */
const CRIT_LOW = 3;
const CRIT_HIGH = 10;
const POWER_LOW = 10;
const POWER_HIGH = 20;
/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ONLY THE POWER HALF CARRIES 0.75, AND THE HEADER ABOVE ALWAYS SAID SO.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Upstream, called-shots.lua:25-26, verbatim:
 *
 *     bonuses.crit_chance = self:combatTalentScale(t, 3, 10)
 *     bonuses.crit_power  = self:combatTalentScale(t, 0.1, 0.2, 0.75)
 *
 * The CHANCE line passes no power at all, so it takes `combatTalentScale`'s
 * default of 0.5 (Combat.lua:1518, `power, add, shift = power or 0.5, ...`).
 * Only the POWER line passes 0.75 — which is exactly what this file's own
 * NUMBERS header says, "crit power 0.1 -> 0.2 AT 0.75". A single `CURVE`
 * constant applied it to both, so the code contradicted its own citation.
 *
 * ═══ IT HIDES IN THE MIDDLE, WHICH IS WHY NOTHING CAUGHT IT ═══
 * `combatTalentScale` returns `low` at rank 1 and `high` at rank 5 whatever
 * the power, so both ends agreed and only the interior moved. Rank 4 is the
 * one that differs after rounding: upstream 8.66 -> 9, ours 8.46 -> 8.
 *
 * AND IT KEEPS DIVERGING PAST RANK 5, which this codebase treats as live —
 * scale.ts says "NEVER CLAMP THE TALENT LEVEL AT 5" because category mastery
 * pushes effective levels above it. At an effective 10 the two rules give
 * 15.2 and 16.8.
 */
const POWER_CURVE = 0.75;

/** Critical chance at a rank, in percentage points. */
export function critChanceAt(level: number): number {
  // NO CURVE ARGUMENT, deliberately — upstream omits it here and takes the
  // 0.5 default. See `POWER_CURVE`.
  return Math.round(combatTalentScale(level, CRIT_LOW, CRIT_HIGH));
}

/** Critical power at a rank, in percentage points. */
export function critPowerAt(level: number): number {
  return Math.round(combatTalentScale(level, POWER_LOW, POWER_HIGH, POWER_CURVE));
}

export const steadyHands: Talent = {
  id: 'talent:steady_hands',
  name: 'Steady Hands',
  classId: ClassId.Inspector,
  tree: 'index/marksmanship',
  /** Tier 1 of its tree. See `src/shared/tiers.ts`. */
  tier: 1,
  /** marksmanship is about DEX. See `Talent.statGate`. */
  statGate: 'dex',
  kind: TalentKind.Passive,
  iconId: 'icon_passive_steady_hands',
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

  passive: (level) => ({
    mods: { physCrit: critChanceAt(level), criticalPower: critPowerAt(level) },
  }),

  describe: (_self, level) =>
    `Always on. ${String(critChanceAt(level))}% more crits, each ${String(critPowerAt(level))}% harder.`,
};
