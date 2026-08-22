// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// SHAPE:   t-engine4 game/modules/tome/data/talents/cursed/gloom.lua — the
//          passive that raises the power a class's own effects are applied with,
//          rather than the damage of any one button.
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

import { combatTalentScale } from '../../shared/scale.ts';
import { DamageType } from '../engine/damage.ts';
import { Affinity, ClassId, TalentKind, TargetShape, talentId } from '../engine/talents.ts';
import type { Talent } from '../engine/talents.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * INDELIBLE — the marks go in harder, which for this class is the damage stat.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * "Not the sort that comes out."
 *
 * ═══ MINDPOWER IS THIS CLASS'S DAMAGE NUMBER, EVEN THOUGH IT IS NOT DAMAGE ═══
 * Every mark the Redactor applies rolls its `applyPower` against a save. A
 * Watchman who raises Strength hits harder; a Redactor whose marks go in harder
 * does not hit harder AT ALL — the mark either lands or does not, and the whole
 * rest of the class depends on which.
 *
 * That is why this passive raises power rather than `dam`. For a class whose
 * economy is "did the mark land", a point on the save roll is worth more than a
 * point on a bolt — and a flat `dam` bonus would have been the twenty-fifth
 * talent in this game that is a number going up, which is the count
 * `Talent.hooks` puts on the record at engine/talents.ts:1611.
 *
 * ═══ `genericPower`, WHICH IS THE ONLY FIELD THAT CAN REACH MINDPOWER ═══
 * The obvious field is `mindPower`, and it cannot be used: `AdditiveMods` is
 * `Omit<CombatMods, 'physSpeed' | 'spellPower' | 'mindPower'>`
 * (content/items.ts:217), so the three school powers are exactly what a passive
 * or a worn item is forbidden to add. `genericPower` is not omitted, and
 * `combatMindpower` folds it into `add` at engine/derived.ts:526 — so it is
 * both the correct field and the only one.
 *
 * IT RAISES ALL THREE POWERS, not just this one (Combat.lua:1693, 1748, 2060),
 * and that is stated rather than hidden. For a Redactor the other two are close
 * to inert — nothing in the class applies with spellpower or physical power —
 * so the breadth costs the game nothing here even though it would matter on a
 * hybrid.
 *
 * An earlier draft of this file raised `spellPower` and argued at length that it
 * was the same number `combatMindpower` reads. It was not; that is
 * `combatSpellpower`, a different function for a different school. The passive
 * would have compiled, shown a bonus on the sheet, and moved no mark this class
 * ever throws.
 *
 * ═══ AND THE FORMULA IS WHY THIS CLASS HAS THE TWO STATS IT HAS ═══
 * Combat.lua:2076, ported verbatim:
 *
 *     mindpower = combat_mindpower + getWil() * 0.7 + getCun() * 0.4
 *
 * It is the only power in the game fed by TWO stats, and the weights sum above
 * 1.0 — so a mind caster who splits Will and Cunning beats one who pours
 * everything into either. The Redactor's two trees gate on exactly those two
 * (`ledger/redaction` on Cunning, `ledger/testimony` on Will), which means the
 * class's stat spread is not a flavour choice laid over the engine: it is the
 * shape the engine already rewards, and this talent sits on top of it.
 */

/** Points of power. Modest at rank 1, worth a fourth point at rank 5. */
const POWER_LOW = 3;
const POWER_HIGH = 12;

function powerAt(talentLevel: number): number {
  return Math.round(combatTalentScale(talentLevel, POWER_LOW, POWER_HIGH));
}

export const indelible: Talent = {
  id: talentId('indelible'),
  name: 'Indelible',
  classId: ClassId.Redactor,
  tree: 'ledger/redaction',
  tier: 1,
  statGate: 'cun',
  kind: TalentKind.Passive,
  iconId: 'icon_passive_indelible',
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

  passive: (level) => ({ mods: { genericPower: powerAt(level) } }),

  describe: (_self, level) =>
    `Always on. Your marks go in with ${String(powerAt(level))} more power, so more of them ` +
    `beat the save — which for this class is what a damage bonus is.`,
};
