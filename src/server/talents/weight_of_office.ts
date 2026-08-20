// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// NUMBERS: t-engine4 game/modules/tome/data/talents/gifts/fire-drake.lua:30-34 -- flat combat_dam granted on learn.
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

/**
 * Weight of Office -- the Watchman, in Discipline.
 *
 * "It is not the truncheon. It is who is holding it."
 *
 * FLAT PHYSICAL POWER, WHICH IS THE CHANNEL NOTHING ELSE IN THIS CLASS TOUCHES.
 * Standing Orders buys armour and Seen Worse buys a save; both pay while the
 * Watchman is being hit. This is the first passive he has that pays while he
 * is the one hitting, and it is in Discipline rather than The Line for
 * exactly that reason -- the two trees should not both answer the same
 * question.
 *
 * `dam` FEEDS EVERY BLOW, not just the talents. It is added before the weapon
 * and before the stat multiplier (Combat.lua:1684), so it improves the plain
 * attack the player makes eight times a fight rather than the one they spend
 * AP on -- the difference between a passive that is felt and a passive that
 * is read off a sheet.
 *
 * IT HAS NO `onUse`, AND THAT IS THE DECLARATION. See `Talent.onUse` -- the
 * absent body IS `mode = "passive"`.
 */

import { combatTalentScale } from '../../shared/scale.ts';
import { DamageType } from '../engine/damage.ts';
import { Affinity, ClassId, TalentKind, TargetShape } from '../engine/talents.ts';
import type { Talent } from '../engine/talents.ts';

/** Upstream grants a flat +4 per rank; the house curve is used instead. */
const LOW = 2;
const HIGH = 8;
const CURVE = 0.75;

/** Flat physical power at a rank. */
export function powerAt(level: number): number {
  return Math.round(combatTalentScale(level, LOW, HIGH, CURVE));
}

export const weightOfOffice: Talent = {
  id: 'talent:weight_of_office',
  name: 'Weight of Office',
  classId: ClassId.Watchman,
  tree: 'watch/discipline',
  kind: TalentKind.Passive,
  iconId: 'icon_passive_weight_of_office',
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

  passive: (level) => ({ mods: { dam: powerAt(level) } }),

  describe: (_self, level) =>
    `Always on. Every blow you land carries ${String(powerAt(level))} more.`,
};
