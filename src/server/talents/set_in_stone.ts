// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// SHAPE:   t-engine4 game/modules/tome/data/talents/cunning/tools.lua — the
//          passive that raises how hard a critical lands rather than how often,
//          which is the half of crit that a low-damage class can actually use.
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

import { combatTalentScale } from '../../shared/scale.ts';
import { DamageType } from '../engine/damage.ts';
import { Affinity, ClassId, TalentKind, TargetShape, talentId } from '../engine/talents.ts';
import type { Talent } from '../engine/talents.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * SET IN STONE — some corrections do not get corrected back.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * "Ink dries. Stone does not care that you have changed your mind."
 *
 * ═══ CRIT POWER, WHERE `marginalia.ts` GIVES CRIT CHANCE ═══
 * The two are different numbers and the distinction is the whole reason both
 * exist on one class. `genericCrit` is how OFTEN; `criticalPower` is how HARD.
 * `marginalia.ts` argues for the first on the grounds that a Redactor throws
 * small numbers all day and a crit is what occasionally makes one matter.
 *
 * This is the other end of that argument. Once the small number does crit, the
 * class has nothing that makes it worth having crit — and a talent tree about
 * corrections should be able to make one stick.
 *
 * THEY STACK, and that is intended rather than overlooked: chance and power
 * multiply into the same figure, so a Redactor who takes both is spending eight
 * points to turn a 0.55x mark into something occasionally frightening. That is
 * a legitimate build for a class whose alternative is spending those points on
 * more ways to be somewhere else.
 */

/** Percentage points of critical POWER — how much harder a crit lands. */
const POWER_LOW = 8;
const POWER_HIGH = 30;

function powerAt(talentLevel: number): number {
  return Math.round(combatTalentScale(talentLevel, POWER_LOW, POWER_HIGH));
}

export const setInStone: Talent = {
  id: talentId('set_in_stone'),
  name: 'Set In Stone',
  classId: ClassId.Redactor,
  tree: 'ledger/errata',
  tier: 2,
  statGate: 'cun',
  kind: TalentKind.Passive,
  iconId: 'icon_passive_set_in_stone',
  cost: { ap: 0, resource: 0 },
  cooldownTurns: 0,
  targeting: {
    shape: TargetShape.Self,
    range: 0,
    minRange: 0,
    radius: 0,
    requiresLos: false,
    affinity: Affinity.Ally,
  },
  damageType: DamageType.Darkness,

  passive: (level) => ({ mods: { criticalPower: powerAt(level) } }),

  describe: (_self, level) =>
    `Always on. Your criticals land ${String(powerAt(level))}% harder — how HARD, where ` +
    `Marginalia buys how often.`,
};
