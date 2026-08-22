// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// SHAPE:   t-engine4 game/modules/tome/data/talents/cunning/tools.lua — the
//          passive that raises Defense rather than armour, because the class it
//          belongs to answers a blow by not being where it lands.
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

import { combatTalentScale } from '../../shared/scale.ts';
import { DamageType } from '../engine/damage.ts';
import { Affinity, ClassId, TalentKind, TargetShape, talentId } from '../engine/talents.ts';
import type { Talent } from '../engine/talents.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * LOOSE LEAF — nothing here is bound, and it does not stay where you swing.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * "Half the file is loose. Grab at it and you are holding four pages of
 * somebody else's afternoon."
 *
 * ═══ DEFENCE, NOT ARMOUR, AND THE CLASS ALREADY SAID WHY ═══
 * `combatArmor` reduces what a blow that CONNECTS takes off you; `combatDefense`
 * decides whether it connects. Every other defensive talent this class owns
 * raises a SAVE — `closed_ledger`, `weight_of_precedent` — and both say in
 * writing that they do nothing about a stick.
 *
 * This is the stick answer, and it is deliberately the cheap half of one. A
 * Redactor who could also stand in the front rank would have no reason to stand
 * anywhere else, which is the argument `REDACTOR`'s own definition makes for
 * life rating 8. Defence buys misses, not survival: it makes the fight the
 * Redactor already wanted — the one at range — slightly more likely to stay
 * that way.
 */

/** Points of defence. Modest: this buys misses, not a front rank. */
const DEF_LOW = 4;
const DEF_HIGH = 14;

function defAt(talentLevel: number): number {
  return Math.round(combatTalentScale(talentLevel, DEF_LOW, DEF_HIGH));
}

export const looseLeaf: Talent = {
  id: talentId('loose_leaf'),
  name: 'Loose Leaf',
  classId: ClassId.Redactor,
  tree: 'ledger/errata',
  tier: 1,
  statGate: 'cun',
  kind: TalentKind.Passive,
  iconId: 'icon_passive_loose_leaf',
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

  passive: (level) => ({ mods: { def: defAt(level) } }),

  describe: (_self, level) =>
    `Always on. ${String(defAt(level))} defence — the chance a blow misses entirely, ` +
    `which is the only defensive number on this class that is about a stick.`,
};
