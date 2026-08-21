// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// SHAPE:   t-engine4 game/modules/tome/data/talents/misc/npcs.lua — the talents
//          that belong to creatures rather than to a class, and are priced
//          against a body that has no resource pool to spend.
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license
//
// ONE TALENT PER FILE. See the roster note in monster.ts for what breaks
// otherwise — tools/art-needs.mjs reads a talent module whole.

import { combatTalentScale } from '../../shared/scale.ts';
import { EffectId } from '../content/effects.ts';
import { SetEffectOutcome } from '../engine/effects.ts';
import { combatMindpower } from '../engine/derived.ts';
import { DamageType } from '../engine/damage.ts';
import {
  Affinity,
  TalentKind,
  TalentRefusal,
  TargetShape,
  talentDone,
  talentId,
  talentRefused,
  targetActor,
} from '../engine/talents.ts';
import { MONSTER_CURVE } from './monster.ts';
import type { SetEffectResult } from '../engine/effects.ts';
import type { Talent } from '../engine/talents.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * EFFACE — the High Inquisitor's. It reads you, and you get worse at everything.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * "It is not looking at you. It is looking you up."
 *
 * ═══ NO DAMAGE AT ALL, WHICH IS THE ENTIRE IDEA ═══
 * Every other talent in this file is a blow with a rider. This one spends the
 * creature's whole turn and takes nothing off the party's hit points, and it is
 * the most dangerous thing in the bestiary for exactly that reason: a fight
 * where the healer sees no incoming damage is a fight nobody reacts to, and
 * four turns later every roll the party makes is 17% worse and they cannot say
 * when it started.
 *
 * EFFACED is the broadest debuff in the game — `finish()` in engine/derived.ts
 * routes accuracy, defence, all three powers and all three saves through the
 * same division. There is nothing to dodge and nothing to out-tank; you deal
 * with the Inquisitor or you lose the fight slowly.
 *
 * ═══ RANGED, BECAUSE THE CREATURE IS A `RangedKiter` WITH `attackRange: 9` ═══
 * Reach 7 sits inside that band, so this is a talent it is genuinely in
 * position to use — and it kites, so closing on it is the counterplay the
 * profile already implements. Compare the first draft of `graspingHold`, which
 * was a 1.5-reach talent handed to a creature that never closes.
 *
 * MENTAL POWER AGAINST A PHYSICAL SAVE. The channel is upstream's
 * (physical.lua:31, this is an acid effect there); the power is the
 * Inquisitor's own, because what it is doing is reading you.
 */
const EFFACE_AP = 4;
const EFFACE_COOLDOWN = 10;
const EFFACE_RANGE = 7;

/** Authored. Long enough to change a fight, short enough to outlast. */
const EFFACE_DUR_LOW = 4;
const EFFACE_DUR_HIGH = 8;

export function effaceTurns(level: number): number {
  return Math.floor(combatTalentScale(level, EFFACE_DUR_LOW, EFFACE_DUR_HIGH, MONSTER_CURVE));
}

/** The two-branch line. */
function effaceLine(name: string, landed: SetEffectResult | undefined): string[] {
  if (landed === undefined) return [];
  if (landed.outcome === SetEffectOutcome.Immune || landed.dur <= 0) {
    return [`${name} is not on the list.`];
  }
  return [`${name} is effaced (${String(landed.dur)} turns).`];
}

export const efface: Talent = {
  id: talentId('efface'),
  name: 'Efface',
  classId: null,
  tree: 'monster/index',
  kind: TalentKind.Active,
  iconId: 'icon_monster_efface',
  cost: { ap: EFFACE_AP },
  cooldownTurns: EFFACE_COOLDOWN,
  targeting: {
    shape: TargetShape.Single,
    range: EFFACE_RANGE,
    minRange: 0,
    radius: 0,
    requiresLos: true,
    affinity: Affinity.Hostile,
  },
  damageType: DamageType.Physical,

  onUse: (ctx, self, target) => {
    const victim = targetActor(ctx.world, target);
    if (victim === undefined) return talentRefused(TalentRefusal.NoTarget);

    const landed = ctx.status?.(victim, EffectId.Effaced, effaceTurns(ctx.talentLevel), {
      applyPower: combatMindpower(self.combat ?? {}),
      srcId: self.id,
    });
    // NO BLOWS, so the array is empty rather than absent — a cast that hurt
    // nobody is still a cast, and the sweep draws its stamp either way.
    return talentDone([], effaceLine(victim.name, landed));
  },

  describe: (_self, level) =>
    `Reads the target, worsening every roll they make and resist for ` +
    `${String(effaceTurns(level))} turns (physical save).`,
};
