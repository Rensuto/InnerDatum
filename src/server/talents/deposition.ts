// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// SHAPE:   t-engine4 game/modules/tome/data/talents/cursed/gloom.lua — the mid-tier
//          mind talent that applies a bleed-family effect at range, where the
//          value is the duration rather than the hit that carried it.
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
 * DEPOSITION — taken down in full, and it will not stop running.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * "Everything you said, in your own words, in wet ink."
 *
 * ═══ BLEEDING, WHICH FOR THIS CLASS IS A PUN THAT HAPPENS TO BE THE MECHANIC ═══
 * `BLEEDING` is a damage-over-time and it belongs to the melee classes: the
 * Watchman opens somebody up with a truncheon. A Redactor applies it because ink
 * RUNS, and the effect a page-full of running ink has on a body is the same
 * arithmetic either way.
 *
 * It is not a reskin looking for a justification. This tree needed one talent
 * that pays over TIME rather than at the moment of pressing, because everything
 * else the class does is instantaneous — a mark lands, Ink arrives, the turn
 * ends. A bleed is the one mark whose value depends on the fight continuing,
 * which is what a defensive tree should want.
 *
 * ═══ IT PAYS INK ONCE, NOT PER TICK, AND THAT IS DELIBERATE UPSTREAM OF HERE ═══
 * `INK_PER_MARK`'s own note refuses per-tick income — *"not per turn the effect
 * runs, which would pay a long slow twice over and make duration the only stat
 * worth having"*. So this talent is worth exactly one mark of income however
 * long it burns, and its length is worth what it does to the target rather than
 * what it does to the bar.
 */

const RANGE = 6;
const AP_COST = 4;
const INK_COST = 16;
const COOLDOWN = 5;

/** Low: the hit is the delivery, the bleed is the talent. */
const DAMAGE_LOW = 0.4;
const DAMAGE_HIGH = 0.9;

const BLEED_LOW = 4;
const BLEED_HIGH = 8;

function damageMult(talentLevel: number): number {
  return combatTalentScale(talentLevel, DAMAGE_LOW, DAMAGE_HIGH);
}

function bleedTurns(talentLevel: number): number {
  return Math.floor(combatTalentScale(talentLevel, BLEED_LOW, BLEED_HIGH));
}

/** See `strike_out.ts`: a resisted mark and an unattempted one must read apart. */
function bleedLine(name: string, landed: SetEffectResult | undefined): string[] {
  if (landed === undefined) return [];
  if (landed.outcome === SetEffectOutcome.Applied) {
    return [`${name} starts to run.`];
  }
  return [`It dries on ${name} before it takes.`];
}

export const deposition: Talent = {
  id: talentId('deposition'),
  name: 'Deposition',
  classId: ClassId.Redactor,
  tree: 'ledger/testimony',
  tier: 2,
  statGate: 'wil',
  kind: TalentKind.Active,
  iconId: 'icon_active_deposition',
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
    // NOTHING RUNS OUT OF A CORPSE. The projection has taken its draws already.
    if (!victim.alive) return talentDone([hit]);

    const landed = ctx.status?.(victim, EffectId.Bleeding, bleedTurns(ctx.talentLevel), {
      applyPower: combatMindpower(self.combat ?? {}),
      srcId: self.id,
    });
    return talentDone([hit], bleedLine(victim.name, landed));
  },

  describe: (_self, level) =>
    `Take it down in full. A target up to ${String(RANGE)} tiles away takes ` +
    `${percent(damageMult(level))} darkness damage and bleeds for ` +
    `${String(bleedTurns(level))} turns (physical save). ${String(AP_COST)} AP, ` +
    `${String(INK_COST)} Ink, ${String(COOLDOWN)}-turn cooldown.`,
};
