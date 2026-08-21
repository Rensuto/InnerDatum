// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// NUMBERS: t-engine4 game/modules/tome/data/talents/techniques/combat-techniques.lua:207-215 -- Spell Shield,
//          combat_spellresist = getTalentLevel(t) * 9.
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

/**
 * Bolt-Hole -- the Inspector, in Fieldcraft.
 *
 * "Every street you walk, you mark the way out of it."
 *
 * THE SPELL SAVE, WHICH NOTHING ELSE IN THIS GAME GRANTS FROM A TALENT.
 * Contingencies already buys the PHYSICAL save in this same tree, and the two
 * are not redundant: they are read by different branches of `checkHit`, and a
 * player who has taken one and is still being landed on knows exactly which
 * one to take next. That is a tree teaching its own mechanics.
 *
 * UPSTREAM'S BAND IS LINEAR IN TALENT LEVEL (9 per rank, so 9 -> 45). Ours
 * uses the house curve at 5 -> 20 to sit beside Seen Worse (5 -> 20) and
 * Contingencies (6 -> 25), because a save that outran the other two would
 * make the comparison above meaningless.
 *
 * IT HAS NO `onUse`, AND THAT IS THE DECLARATION. See `Talent.onUse` -- the
 * absent body IS `mode = "passive"`.
 */

import { combatTalentScale } from '../../shared/scale.ts';
import { DamageType } from '../engine/damage.ts';
import { Affinity, ClassId, TalentKind, TargetShape } from '../engine/talents.ts';
import type { Talent } from '../engine/talents.ts';

/** ToME is level x 9; the house band matches the two saves already here. */
const LOW = 5;
const HIGH = 20;
const CURVE = 0.75;

/** Flat spell save at a rank. */
export function spellSaveAt(level: number): number {
  return Math.round(combatTalentScale(level, LOW, HIGH, CURVE));
}

export const boltHole: Talent = {
  id: 'talent:bolt_hole',
  name: 'Bolt-Hole',
  classId: ClassId.Inspector,
  tree: 'index/fieldcraft',
  /** Tier 3 of its tree. See `src/shared/tiers.ts`. */
  tier: 3,
  /** fieldcraft is about CUN. See `Talent.statGate`. */
  statGate: 'cun',
  kind: TalentKind.Passive,
  iconId: 'icon_passive_bolt_hole',
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
