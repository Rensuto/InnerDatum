// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// SHAPE:   t-engine4 game/modules/tome/data/talents/cursed/gloom.lua — a tier-3
//          passive that edits an incoming figure once per turn rather than
//          raising a number on the sheet.
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

import { combatTalentScale } from '../../shared/scale.ts';
import { DamageType } from '../engine/damage.ts';
import { Affinity, ClassId, TalentKind, TargetShape, talentId } from '../engine/talents.ts';
import type { Talent } from '../engine/talents.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * SEALED RECORD — the first thing that hits you each turn does not go in.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * "Filed. Sealed. Not available for consultation."
 *
 * ═══ A HOOK, NOT A NUMBER, AND THE FILE SAYS WHY THAT MATTERS ═══
 * engine/talents.ts:1611 keeps count: twenty-four of this game's first
 * forty-two talents were "a number going up", because `passive` receives only a
 * level and can form no other sentence. `onTakeDamage` can REWRITE the figure,
 * which is what makes a block a block.
 *
 * This tree already has two flat numbers in `weight_of_precedent` and
 * `closed_ledger`. A third would be the same talent at a different size. What a
 * Redactor is actually short of is the turn where something reached them at all,
 * and a flat save does nothing about a stick.
 *
 * ═══ ONCE A TURN, LATCHED, AND THE LATCH IS THE BALANCE ═══
 * `ctx.procs.once` is what stops an area effect paying this per body — the same
 * guard `leverage.ts` puts on its heal, for the same reason it gives: without
 * it, the talent is worth several times more against a crowd than against the
 * single heavy blow it exists to blunt.
 *
 * ═══ A PERCENTAGE, FLOORED AT ZERO, AND NEVER NEGATIVE ═══
 * The edit returns a REPLACEMENT figure rather than a delta, so the arithmetic
 * has to be done here and has to be bounded here. A blow reduced past zero would
 * be a heal delivered by an enemy's attack, which is the kind of thing that
 * survives in a codebase for a year because nobody thinks to test for it.
 */

/** Percent of the first blow each turn that is refused. */
const REDUCTION_LOW = 12;
const REDUCTION_HIGH = 32;

function reductionAt(talentLevel: number): number {
  return Math.round(combatTalentScale(talentLevel, REDUCTION_LOW, REDUCTION_HIGH));
}

/**
 * The percentage divisor, named for the same reason `percent()` names its own
 * (engine/talents.ts:305): `no-magic-numbers` is on in `src/server/talents/**`
 * to push TUNABLE numbers into constants, and a conversion factor is not a
 * tunable number. Silencing the rule inline would silence it for whatever gets
 * written on that line next.
 */
const PER_CENT = 100;

export const sealedRecord: Talent = {
  id: talentId('sealed_record'),
  name: 'Sealed Record',
  classId: ClassId.Redactor,
  tree: 'ledger/testimony',
  tier: 3,
  statGate: 'wil',
  kind: TalentKind.Passive,
  iconId: 'icon_passive_sealed_record',
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

  hooks: {
    onTakeDamage: (ctx, incoming) => {
      // A BLOW THAT DID NOTHING IS NOT WORTH THE LATCH. Spending it on a
      // 0-damage graze would disarm this for the turn the real hit lands in.
      if (incoming.dam <= 0) return;
      if (!ctx.procs.once('talent:sealed_record')) return;
      const kept = incoming.dam * (1 - reductionAt(ctx.level) / PER_CENT);
      // NEVER BELOW ZERO. See the header — a negative figure would be a heal
      // delivered by the thing attacking you.
      return { dam: Math.max(0, kept) };
    },
  },

  describe: (_self, level) =>
    `Always on. The first blow that reaches you each turn is ${String(reductionAt(level))}% ` +
    `smaller. Once a turn — a crowd does not get to spend it several times.`,
};
