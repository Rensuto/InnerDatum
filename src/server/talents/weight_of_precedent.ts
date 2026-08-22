// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// SHAPE:   t-engine4 game/modules/tome/data/talents/cursed/gloom.lua — the mind
//          tree's own resistance passive, which protects the caster from the
//          school the caster is best at.
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

import { combatTalentScale } from '../../shared/scale.ts';
import { DamageType } from '../engine/damage.ts';
import { Affinity, ClassId, TalentKind, TargetShape, talentId } from '../engine/talents.ts';
import type { Talent } from '../engine/talents.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WEIGHT OF PRECEDENT — it has been decided before, and it was decided this way.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * "You cannot argue with the file. Other people have tried."
 *
 * ═══ THE SAVE THIS CLASS ATTACKS IS THE SAVE THIS CLASS RAISES ═══
 * Every mark a Redactor throws rolls against a save. This passive raises the
 * MENTAL save, which is the one a mind caster is most often on the receiving end
 * of — and it is the one the class's own marks would beat.
 *
 * That symmetry is not decoration. It means a Redactor's answer to another
 * controller is to be a better controller, rather than to put on heavier armour,
 * and it is why `closed_ledger` raises the same two saves rather than armour.
 * The class has one defensive axis and it is the axis it already lives on.
 *
 * ═══ IT IS FLAT, AND IT STACKS WITH THE STANCE ON PURPOSE ═══
 * `closed_ledger` costs 20 Ink of reserve for a larger number; this costs
 * nothing and is always on. A player who takes both is spending points and a
 * reserve to be very hard to unwrite, which is a legitimate build rather than an
 * accident — the same way `indelible` and `open_ledger` stack on the offensive
 * side. Both pairs were checked rather than assumed.
 */

/** Points of mental save. Half of what the stance gives, and free. */
const SAVE_LOW = 3;
const SAVE_HIGH = 10;

function saveAt(talentLevel: number): number {
  return Math.round(combatTalentScale(talentLevel, SAVE_LOW, SAVE_HIGH));
}

export const weightOfPrecedent: Talent = {
  id: talentId('weight_of_precedent'),
  name: 'Weight of Precedent',
  classId: ClassId.Redactor,
  tree: 'ledger/testimony',
  tier: 2,
  statGate: 'wil',
  kind: TalentKind.Passive,
  iconId: 'icon_passive_weight_of_precedent',
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

  passive: (level) => ({ mods: { mentalResist: saveAt(level) } }),

  describe: (_self, level) =>
    `Always on. ${String(saveAt(level))} mental save — the roll you make against everything ` +
    `that tries to do to you what you do to other people.`,
};
