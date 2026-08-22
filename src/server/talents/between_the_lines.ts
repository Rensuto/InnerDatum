// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// SHAPE:   t-engine4 game/modules/tome/data/talents/cunning/tools.lua — the
//          passive that raises armour penetration, the number that decides how
//          much of a target's plate is simply not consulted.
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

import { combatTalentScale } from '../../shared/scale.ts';
import { DamageType } from '../engine/damage.ts';
import { Affinity, ClassId, TalentKind, TargetShape, talentId } from '../engine/talents.ts';
import type { Talent } from '../engine/talents.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * BETWEEN THE LINES — what the coat says is not the whole document.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * "There is always a gap in the wording. Write in it."
 *
 * ═══ APR, AND IT IS THE SAME IDEA AS THIS CLASS'S BEST TALENT ═══
 * `redaction.ts` applies `BREACHED`, which halves armour HARDINESS — the
 * fraction of a blow armour is allowed to touch at all. Armour penetration is
 * the small, permanent, always-on version of that: `combatAPR` is subtracted
 * from the target's armour before it reduces anything (Combat.lua:1402-1406).
 *
 * One is a cooldown you spend on the body the party is about to commit to; this
 * is the quiet one that applies to every mark you throw for the rest of the
 * fight. A tree about corrections should include the correction nobody notices.
 *
 * ═══ IT HELPS THE MARKS, WHICH IS WHY IT IS HERE AND NOT ON A DAMAGE TREE ═══
 * The Redactor's damage figures are deliberately small — `strike_out` is 0.55x
 * at rank 1 — and a small figure is exactly the one armour eats entirely. APR
 * is worth proportionally MORE to a class throwing 3-damage marks than to one
 * throwing 30-damage swings, which is the opposite of how it usually reads.
 */

/** Points of armour penetration. */
const APR_LOW = 2;
const APR_HIGH = 8;

function aprAt(talentLevel: number): number {
  return Math.round(combatTalentScale(talentLevel, APR_LOW, APR_HIGH));
}

export const betweenTheLines: Talent = {
  id: talentId('between_the_lines'),
  name: 'Between The Lines',
  classId: ClassId.Redactor,
  tree: 'ledger/errata',
  tier: 3,
  statGate: 'cun',
  kind: TalentKind.Passive,
  iconId: 'icon_passive_between_the_lines',
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

  passive: (level) => ({ mods: { apr: aprAt(level) } }),

  describe: (_self, level) =>
    `Always on. ${String(aprAt(level))} armour penetration — worth more to a class throwing ` +
    `small figures than to one throwing large ones, because armour eats a small figure whole.`,
};
