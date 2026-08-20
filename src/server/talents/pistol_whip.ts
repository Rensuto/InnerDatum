// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// NUMBERS: t-engine4 game/modules/tome/data/talents/techniques/2hweapon.lua:213-250
//          Stunning Blow -- cooldown 6, combatTalentWeaponDamage(t, 1, 1.5),
//          EFF_STUNNED with apply_power = combatPhysicalpower().
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

/**
 * PISTOL WHIP -- the Inspector, in Fieldcraft.
 *
 * "The heavy end is still a tool."
 *
 * ═══ FIELDCRAFT IS ABOUT NOT BEING THERE, AND HAD NOTHING FOR ALREADY BEING
 *     THERE ═══
 * Fog Step moves you and Sigil marks the ground; both are answers you need
 * BEFORE something reaches you. Once a monster is adjacent, a ranged class with
 * no melee option is a class that has already lost the exchange. This is the
 * panic button: it is not good damage and it is not meant to be -- it buys the
 * turn back.
 *
 * ═══ IT IS THE STUN THAT COSTS, NOT THE HIT ═══
 * The damage band sits UNDER Crude Blow, which is a Watchman's at-will swing,
 * because the Inspector holding a revolver by the barrel should not be
 * competing with a guard holding a truncheon properly. What the player is paying
 * four AP and a long cooldown for is `EFF_STUNNED` -- and `STUNNED.type` is the
 * PHYSICAL save, so this checks against the stat the Inspector is worst at,
 * which is the honest price of a melee talent on a ranged class.
 */

import { combatTalentScale } from '../../shared/scale.ts';
import { MELEE_REACH } from '../engine/combat.ts';
import { DamageType } from '../engine/damage.ts';
import { EffectId } from '../content/effects.ts';
import { combatPhysicalpower } from '../engine/derived.ts';
import {
  Affinity,
  ClassId,
  TalentKind,
  TalentRefusal,
  TargetShape,
  talentAttack,
  talentDone,
  talentId,
  talentRefused,
  targetActor,
  percent,
} from '../engine/talents.ts';
import type { Talent } from '../engine/talents.ts';

const AP_COST = 4;
const COOLDOWN = 5;
const MULT_LOW = 0.5;
const MULT_HIGH = 0.9;
const STUN_TURNS = 2;

function damageMult(talentLevel: number): number {
  return combatTalentScale(talentLevel, MULT_LOW, MULT_HIGH);
}

export const pistolWhip: Talent = {
  id: talentId('pistol_whip'),
  name: 'Pistol Whip',
  classId: ClassId.Inspector,
  tree: 'index/fieldcraft',
  kind: TalentKind.Active,
  iconId: 'icon_active_pistol_whip',
  cost: { ap: AP_COST },
  cooldownTurns: COOLDOWN,
  targeting: {
    shape: TargetShape.Single,
    range: MELEE_REACH,
    minRange: 0,
    radius: 0,
    requiresLos: false,
    affinity: Affinity.Hostile,
  },
  damageType: DamageType.Physical,

  onUse: (ctx, self, target) => {
    const victim = targetActor(ctx.world, target);
    if (victim === undefined) return talentRefused(TalentRefusal.NoTarget);

    const hit = talentAttack(ctx, self, victim, { mult: damageMult(ctx.talentLevel) });
    if (!victim.alive) return talentDone([hit]);

    const landed = ctx.status?.(victim, EffectId.Stunned, STUN_TURNS, {
      applyPower: combatPhysicalpower(self.combat ?? {}),
      srcId: self.id,
    });

    return talentDone(
      [hit],
      landed === undefined ? [] : [`${victim.name} reels for ${String(STUN_TURNS)} turns.`],
    );
  },

  describe: (_self, level) =>
    `Club an adjacent enemy for ${percent(damageMult(level))} weapon damage and stun them ` +
    `for ${String(STUN_TURNS)} turns. ${String(AP_COST)} AP, ${String(COOLDOWN)}-turn cooldown.`,
};
