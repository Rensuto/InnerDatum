// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// SHAPE:   t-engine4 game/modules/tome/data/talents/cursed/gloom.lua — the tier-4
//          mind capstone that ends an argument rather than continuing one: heavy
//          single-target damage carrying a stun-family effect on a long cooldown.
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

import { combatTalentScale } from '../../shared/scale.ts';
import { EffectId } from '../content/effects.ts';
import { SetEffectOutcome } from '../engine/effects.ts';
import { combatMindpower } from '../engine/derived.ts';
import { DamageType } from '../engine/damage.ts';
import {
  Affinity,
  ClassId,
  TalentKind,
  TalentRefusal,
  TargetShape,
  percent,
  talentBaseDamage,
  talentDone,
  talentId,
  talentProject,
  talentRefused,
  targetActor,
} from '../engine/talents.ts';
import type { SetEffectResult } from '../engine/effects.ts';
import type { Talent } from '../engine/talents.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * FINAL DRAFT — the version that goes in the file. The rest was working notes.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * "Everything before this was a draft, including you."
 *
 * ═══ THE CAPSTONE, AND THE ONLY THING IN THE CLASS THAT ENDS A TURN ═══
 * The other five talents in this tree make a fight worse for somebody. This one
 * takes a body OUT of it — `DAZED` halves every roll the target makes and every
 * roll it resists (physical.lua:563, `subtype = { stun=true }`), which on a body
 * the party is already about to commit to is the difference between a bad turn
 * and no turn.
 *
 * ═══ DAZED RATHER THAN STUNNED, AND THAT IS A CONCESSION ═══
 * `STUNNED` exists and is the obvious capstone effect. It is not used here.
 * A stun removes a turn outright, and a class that can reliably delete a turn
 * from six tiles away with no line of retaliation is the strongest thing in the
 * game regardless of what its numbers say. Dazed is the half-measure that keeps
 * the body acting — badly — so the party still has a fight rather than an
 * execution.
 *
 * This is the same argument `concussion_flask.ts` makes about a radius-1 stun,
 * applied to range instead of to area.
 *
 * ═══ THE MOST EXPENSIVE BUTTON IN THE CLASS, AND DELIBERATELY SO ═══
 * `class-wiring.test.ts` asserts that the most expensive button in every class
 * fits inside the smallest budget that class can have. At 34 Ink this is that
 * button, and a Redactor cannot open a fight with it: the well starts full but
 * the cooldown and the price mean it is a thing you EARN mid-fight by marking,
 * which is the class's whole shape expressed as its best talent.
 */

const RANGE = 6;
const AP_COST = 6;
/** The most expensive in the class. See the header. */
const INK_COST = 34;
const COOLDOWN = 12;

/** The heaviest multiplier the class has — this is the one turn of output. */
const DAMAGE_LOW = 1.4;
const DAMAGE_HIGH = 2.6;

const DAZE_LOW = 2;
const DAZE_HIGH = 4;

function damageMult(talentLevel: number): number {
  return combatTalentScale(talentLevel, DAMAGE_LOW, DAMAGE_HIGH);
}

function dazeTurns(talentLevel: number): number {
  return Math.floor(combatTalentScale(talentLevel, DAZE_LOW, DAZE_HIGH));
}

/** See `strike_out.ts`: a resisted mark and an unattempted one must read apart. */
function dazeLine(name: string, landed: SetEffectResult | undefined): string[] {
  if (landed === undefined) return [];
  if (landed.outcome === SetEffectOutcome.Applied) {
    return [`${name} is written out of the account.`];
  }
  return [`${name} reads it and stands anyway.`];
}

export const finalDraft: Talent = {
  id: talentId('final_draft'),
  name: 'Final Draft',
  classId: ClassId.Redactor,
  tree: 'ledger/redaction',
  tier: 4,
  statGate: 'cun',
  kind: TalentKind.Active,
  iconId: 'icon_active_final_draft',
  cost: { ap: AP_COST, resource: INK_COST },
  cooldownTurns: COOLDOWN,
  targeting: {
    shape: TargetShape.Single,
    range: RANGE,
    minRange: 0,
    radius: 0,
    requiresLos: true,
    affinity: Affinity.Hostile,
  },
  damageType: DamageType.Darkness,

  onUse: (ctx, self, target) => {
    const victim = targetActor(ctx.world, target);
    if (victim === undefined) return talentRefused(TalentRefusal.NoTarget);

    const hit = talentProject(
      ctx,
      self,
      victim,
      talentBaseDamage(self),
      DamageType.Darkness,
      damageMult(ctx.talentLevel),
    );
    // A CORPSE IS NOT DAZED. The projection has taken its draws either way, so
    // the RNG stream does not depend on whether the blow finished the body.
    if (!victim.alive) return talentDone([hit]);

    const landed = ctx.status?.(victim, EffectId.Dazed, dazeTurns(ctx.talentLevel), {
      applyPower: combatMindpower(self.combat ?? {}),
      srcId: self.id,
    });
    return talentDone([hit], dazeLine(victim.name, landed));
  },

  describe: (_self, level) =>
    `File the last version. A target up to ${String(RANGE)} tiles away takes ` +
    `${percent(damageMult(level))} darkness damage and is dazed for ` +
    `${String(dazeTurns(level))} turns — every roll it makes and resists is halved ` +
    `(physical save). ${String(AP_COST)} AP, ${String(INK_COST)} Ink, ` +
    `${String(COOLDOWN)}-turn cooldown.`,
};
