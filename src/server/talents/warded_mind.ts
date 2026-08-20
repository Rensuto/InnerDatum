// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// NUMBERS: t-engine4 game/modules/tome/data/talents/techniques/combat-techniques.lua:207-215 -- Spell Shield,
//          combat_spellresist = getTalentLevel(t) * 9.
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

/**
 * Warded Mind -- GROUNDWORK, the category every class carries.
 *
 * "Chalk on the inside of the hatband. It cannot hurt."
 *
 * THE SPELL SAVE, THE THIRD OF THE THREE AND THE ONE MOST PEOPLE NEVER BUY.
 * Unflinching above covers the physical channel and this covers the magical
 * one, so a player who has hardened against one kind of trouble and is still
 * being landed on can read the tree and know what to do about it. That is a
 * category teaching its own mechanics, which is what a training tree is for.
 *
 * SHALLOWER THAN Bolt-Hole, the Inspector's own version, for the reason Range
 * Time is shallower than Called Shot: the shared tree sells the basic form of
 * a thing and the class tree sells the good one.
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

/** Upstream is level x 9; the house band sits under Bolt-Hole's 5 -> 20. */
const LOW = 3;
const HIGH = 14;
const CURVE = 0.75;

/** Flat spell save at a rank. */
export function spellSaveAt(level: number): number {
  return Math.round(combatTalentScale(level, LOW, HIGH, CURVE));
}

export const wardedMind: Talent = {
  id: 'talent:warded_mind',
  name: 'Warded Mind',
  classId: null,
  tree: 'generic/groundwork',
  kind: TalentKind.Passive,
  iconId: 'icon_passive_warded_mind',
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

  passive: (level) => ({ mods: { spellResist: spellSaveAt(level) } }),

  describe: (_self, level) =>
    `Always on. ${String(spellSaveAt(level))} harder to land a working on you.`,
};
