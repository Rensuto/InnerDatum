// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// SHAPE:   t-engine4 game/modules/tome/data/talents/techniques/battle-tactics.lua:100-158
//          -- True Grit, whose resistance is paid in proportion to missing life:
//          `getResist = (1 - life/max_life) * resistCoeff` (:114).
//          (Was conditioning.lua:100-129 "Unbreakable Will, the conditioning
//          tree's save talent". Those lines are Daunting Presence, that tree has
//          no save talent, and Unbreakable Will is an uberTalent at uber/wil.lua
//          that ignores mental effects outright rather than granting a save.)
// NUMBERS: authored. The SCALING-BY-HARM half is `T_TRUE_GRIT`'s shape applied
//          to saves rather than to resistance -- our `saveAt` is
//          `fullSaveAt(level) * (1 - hpFraction)`, which is upstream's line above
//          with a save where it has a resistance.
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

/**
 * SECOND WIND -- NIGHTSHIFT, the second category every class carries.
 *
 * "The worse it got, the less of it seemed to reach you."
 *
 * ═══ THE INVERSE OF A STAT, WHICH IS THE POINT OF THIS WHOLE TREE ═══
 * `generic/groundwork` is six flat numbers -- armour, defence, accuracy, two
 * saves and a Constitution -- and that is what it should be: what everyone is
 * taught. This tree is what a body LEARNS, and every talent in it is worth a
 * different amount depending on what is happening, which is what makes buying
 * one a decision rather than an increment.
 *
 * This one is worth NOTHING at full health and a great deal at a quarter. A
 * character who never gets hit should not buy it; a character who is the reason
 * everybody else does not get hit should buy it first.
 *
 * ═══ WHY BOTH SAVES AND NOT ONE ═══
 * Physical alone would make it Unflinching with a condition attached, and
 * Unflinching is already in the other tree at the same tier. The pair is what
 * gives it its own shape: it is the talent for being FINISHED OFF, and what
 * finishes a wounded body is whichever channel the thing standing over it uses.
 */

import { combatTalentScale } from '../../shared/scale.ts';
import { DamageType } from '../engine/damage.ts';
import { Affinity, TalentKind, TargetShape } from '../engine/talents.ts';
import { EMPTY_PASSIVE_VIEW } from '../engine/hooks.ts';
import type { Talent } from '../engine/talents.ts';

/**
 * The save at a rank, AT DEATH'S DOOR. The band is wide because the number is
 * multiplied by how hurt you are and is therefore zero most of the time -- a
 * band matching Unflinching's would make this strictly worse than Unflinching.
 */
const LOW = 8;
const HIGH = 30;
const CURVE = 0.75;

/** The full figure at a rank, before the wound multiplier. */
export function fullSaveAt(level: number): number {
  return combatTalentScale(level, LOW, HIGH, CURVE);
}

/**
 * What is actually granted: the full figure times the fraction of health this
 * body is MISSING. At full health that is zero, and zero is honest -- the
 * character sheet should not show a save that is not doing anything.
 */
export function saveAt(level: number, hpFraction: number): number {
  const missing = Math.min(1, Math.max(0, 1 - hpFraction));
  return Math.round(fullSaveAt(level) * missing);
}

export const secondWind: Talent = {
  id: 'talent:second_wind',
  name: 'Second Wind',
  classId: null,
  tree: 'generic/nightshift',
  /** Tier 1 of its tree. See `src/shared/tiers.ts`. */
  tier: 1,
  kind: TalentKind.Passive,
  iconId: 'icon_passive_second_wind',
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

  /**
   * `view` DEFAULTED, and every conditional talent in this tree does the same:
   * four fixtures call `passive(3)` with one argument, and `EMPTY_PASSIVE_VIEW`
   * answers a body at full health on an empty board -- which reads here as "no
   * bonus", the honest answer for a character nothing has happened to.
   */
  passive: (level, view = EMPTY_PASSIVE_VIEW) => {
    const save = saveAt(level, view.hpFraction());
    return { mods: { physResist: save, mentalResist: save } };
  },

  describe: (_self, level) =>
    `Always on. Up to ${String(Math.round(fullSaveAt(level)))} to physical and mental saves, ` +
    `in proportion to the health you are missing — nothing at full, all of it at death's door.`,
};
