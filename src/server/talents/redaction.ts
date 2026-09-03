// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// SHAPE:   t-engine4 game/modules/tome/data/talents/chronomancy/temporal-combat.lua:296-335
//          — `EFF_BREACH` applied on a cooldown, which is the same effect this
//          applies and the same reason it cannot be at-will.
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

import { combatTalentScale } from '../../shared/scale.ts';
import { EffectId } from '../content/effects.ts';
import { SetEffectOutcome } from '../engine/effects.ts';
import { combatMindpower, TalentPower } from '../engine/derived.ts';
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
 * REDACTION — the black bar. What the armour said is no longer readable.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * "Whatever the coat was for, it is not for that any more."
 *
 * ═══ BREACHED AT RANGE, WHICH IS THE WHOLE DIFFERENCE FROM BREACHING BLOW ═══
 * `breaching_blow.ts` is the Overwritten Husk's, and it is a MELEE weapon
 * strike: adjacent, physical, delivered with the swing. This is the same effect
 * from six tiles by someone who never touches you, and the price of that reach
 * is a real cooldown and a real Ink cost where the husk pays neither.
 *
 * The two sharing an effect is deliberate rather than lazy. `BREACHED` halving
 * armour hardiness (Combat.lua:1334) is the most valuable single thing a party's
 * front rank can be handed, and a class that exists to make things wrong for
 * other people should be able to hand it over. That the husk can do it TO you
 * and the Redactor can do it FOR you is the symmetry.
 *
 * ═══ IT DOES LESS DAMAGE THAN STRIKE OUT AND COSTS FAR MORE ═══
 * On purpose. This is not a rotation button: a Redactor presses it once on the
 * body the melee is about to commit to, and the value is entirely in what
 * somebody ELSE does next. Priced as a setup, not as a turn of output.
 */

const RANGE = 6;
const AP_COST = 5;
const INK_COST = 22;
/**
 * Long. The armour must close again between fights over the same body.
 *
 * TWICE THE CITED TALENT'S, AND THAT IS DELIBERATE. `temporal-combat.lua:296-335`
 * is `cooldown = 8` in ACTIONS, which `tomeCooldownToTurns` converts to 4 turns.
 * This charges 8 turns because upstream's is a melee strike the caster has to
 * walk into and this reaches six tiles — see the header on what that reach costs.
 * Written down because `tools/talent-costs.mjs` reads the citation and would
 * otherwise report it as a silent divergence, which is exactly what that tool is
 * for and exactly what this is not.
 */
const COOLDOWN = 8;

const DAMAGE_LOW = 0.35;
const DAMAGE_HIGH = 0.8;

/** Turns of Breached. The same band `breaching_blow.ts` uses — same effect, same window. */
const BREACH_LOW = 3;
const BREACH_HIGH = 7;

function damageMult(talentLevel: number): number {
  return combatTalentScale(talentLevel, DAMAGE_LOW, DAMAGE_HIGH);
}

function breachTurns(talentLevel: number): number {
  return Math.floor(combatTalentScale(talentLevel, BREACH_LOW, BREACH_HIGH));
}

/** See `strike_out.ts`: a resisted mark and an unattempted one must read apart. */
function breachLine(name: string, landed: SetEffectResult | undefined): string[] {
  if (landed === undefined) return [];
  if (landed.outcome === SetEffectOutcome.Applied) {
    return [`${name} is redacted — the armour stops arguing.`];
  }
  return [`The bar slides off ${name}.`];
}

export const redaction: Talent = {
  id: talentId('redaction'),
  name: 'Redaction',
  classId: ClassId.Redactor,
  tree: 'ledger/redaction',
  tier: 2,
  statGate: 'cun',
  kind: TalentKind.Active,
  iconId: 'icon_active_redaction',
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
  scalesWith: { damage: TalentPower.Weapon, lands: TalentPower.Mind },

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
    if (!victim.alive) return talentDone([hit]);

    /**
     * MAGICAL SAVE, because `BREACHED` carries `type: SaveChannel.Magical` and
     * that field belongs to the effect rather than to the caster. Being
     * overwritten is not something you shrug off by being sturdy — the effect's
     * own note makes the argument.
     */
    const landed = ctx.status?.(victim, EffectId.Breached, breachTurns(ctx.talentLevel), {
      applyPower: combatMindpower(self.combat ?? {}),
      srcId: self.id,
    });
    return talentDone([hit], breachLine(victim.name, landed));
  },

  describe: (_self, level) =>
    `Black-bar a target up to ${String(RANGE)} tiles away for ${percent(damageMult(level))} ` +
    `darkness damage and breach its armour for ${String(breachTurns(level))} turns ` +
    `(magical save). ${String(AP_COST)} AP, ${String(INK_COST)} Ink, ` +
    `${String(COOLDOWN)}-turn cooldown.`,
};
