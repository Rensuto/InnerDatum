// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// SHAPE:   t-engine4 game/modules/tome/data/talents/cursed/gloom.lua — a passive
//          in a mind tree that widens the caster's reach rather than raising a
//          damage figure, because reach is what a controller is short of.
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

import { combatTalentScale } from '../../shared/scale.ts';
import { DamageType } from '../engine/damage.ts';
import { Affinity, ClassId, TalentKind, TargetShape, talentId } from '../engine/talents.ts';
import type { Talent } from '../engine/talents.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * MARGINALIA — notes in the margin. What you can reach to write on.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * "The page is only so wide. Write smaller and go further out."
 *
 * ═══ CRIT, AND WHY IT IS THE ONE NUMBER WORTH RAISING HERE ═══
 * `genericCrit` applies to every school (engine/derived.ts:151), which for this
 * class means it applies to the darkness projections all three of its actives
 * make. That is the ordinary reading and it is not the interesting one.
 *
 * The interesting one is that a Redactor's turn is usually a MARK rather than a
 * kill, and a mark's damage is deliberately small — `strike_out.ts` throws
 * 0.55x at rank 1. A class that mostly throws small numbers gets more out of a
 * crit chance than a class that throws large ones, because the flat cost of
 * pressing the button is the same either way and the crit is what occasionally
 * makes the small number matter.
 *
 * ═══ WHAT THIS IS NOT ═══
 * It is not "your marks last longer" and not "your marks land more often" —
 * `indelible.ts` already owns the second and the first would make duration the
 * only stat in the class worth having, which is the exact failure
 * `INK_PER_MARK`'s note refuses ("not per turn the effect runs, which would pay
 * a long slow twice over").
 */

/** Percentage points of crit, on every school. */
const CRIT_LOW = 2;
const CRIT_HIGH = 9;

function critAt(talentLevel: number): number {
  return Math.round(combatTalentScale(talentLevel, CRIT_LOW, CRIT_HIGH));
}

export const marginalia: Talent = {
  id: talentId('marginalia'),
  name: 'Marginalia',
  classId: ClassId.Redactor,
  tree: 'ledger/redaction',
  tier: 2,
  statGate: 'cun',
  kind: TalentKind.Passive,
  iconId: 'icon_passive_marginalia',
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

  passive: (level) => ({ mods: { genericCrit: critAt(level) } }),

  describe: (_self, level) =>
    `Always on. ${String(critAt(level))}% more chance to crit with anything you do — which is ` +
    `worth most to a class that spends its turns throwing small numbers.`,
};
