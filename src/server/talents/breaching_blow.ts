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
import { combatSpellpower } from '../engine/derived.ts';
import { DamageType } from '../engine/damage.ts';
import {
  Affinity,
  TalentKind,
  TalentRefusal,
  TargetShape,
  percent,
  talentAttack,
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
 * BREACHING BLOW — the Overwritten Husk's. An elite that opens your armour.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * "It has read your coat and found the seam."
 *
 * SHAPE from t-engine4 data/talents/chronomancy/temporal-combat.lua:296-335 —
 * the weapon talent that applies `EFF_BREACH`:
 *
 *     cooldown = 8,
 *     getDamage   = combatTalentWeaponDamage(t, 1, 1.5)
 *     getDuration = floor(combatTalentScale(t, 3, 7))
 *     target:setEffect(target.EFF_BREACH, t.getDuration(self, t), ...)
 *
 * ═══ WHY THE ELITE HUSK AND NOT THE COMMON ONE ═══
 * The Index Husk is the trash of this game and should stay a thing you kill
 * without thinking. The Overwritten Husk is its `ActorRank.Elite` twin, and an
 * elite whose only difference is a bigger number is a normal monster wearing a
 * ring. This is the difference: it does something to you that persists after it
 * dies, and the party has to decide whether to kill it first.
 *
 * ═══ MELEE, BECAUSE THE CREATURE IS A `MeleeChaser` WITH `attackRange: 1` ═══
 * That sentence is here because the first monster talent in this file was
 * written without it and went to a `RangedKiter` that never closed to its 1.5
 * reach — offered every turn, refused on range every turn, silently. A talent's
 * range and its creature's profile are one decision, not two.
 */
const BREACH_AP = 3;
const BREACH_COOLDOWN = 8;

/** temporal-combat.lua:312 — `combatTalentWeaponDamage(t, 1, 1.5)`. */
const BREACH_DAMAGE_LOW = 1;
const BREACH_DAMAGE_HIGH = 1.5;

/** temporal-combat.lua:313 — `floor(combatTalentScale(t, 3, 7))`. */
const BREACH_DUR_LOW = 3;
const BREACH_DUR_HIGH = 7;

export function breachMult(level: number): number {
  return combatTalentScale(level, BREACH_DAMAGE_LOW, BREACH_DAMAGE_HIGH, MONSTER_CURVE);
}

export function breachTurns(level: number): number {
  return Math.floor(combatTalentScale(level, BREACH_DUR_LOW, BREACH_DUR_HIGH, MONSTER_CURVE));
}

/** The two-branch line. A breach that was saved against says so. */
function breachLine(name: string, landed: SetEffectResult | undefined): string[] {
  if (landed === undefined) return [];
  if (landed.outcome === SetEffectOutcome.Immune || landed.dur <= 0) {
    return [`${name}'s coat holds.`];
  }
  return [`${name} is breached (${String(landed.dur)} turns).`];
}

export const breachingBlow: Talent = {
  id: talentId('breaching_blow'),
  name: 'Breaching Blow',
  classId: null,
  tree: 'monster/index',
  kind: TalentKind.Active,
  iconId: 'icon_monster_breaching_blow',
  cost: { ap: BREACH_AP },
  cooldownTurns: BREACH_COOLDOWN,
  targeting: {
    shape: TargetShape.Single,
    range: 1.5,
    minRange: 0,
    radius: 0,
    requiresLos: true,
    affinity: Affinity.Hostile,
  },
  damageType: DamageType.Physical,

  onUse: (ctx, self, target) => {
    const victim = targetActor(ctx.world, target);
    if (victim === undefined) return talentRefused(TalentRefusal.NoTarget);

    const hit = talentAttack(ctx, self, victim, { mult: breachMult(ctx.talentLevel) });
    // A corpse has no armour worth opening. The swing above still took its RNG
    // draws, so the stream does not depend on whether it died first.
    if (!victim.alive) return talentDone([hit]);

    /**
     * MAGICAL POWER AGAINST A MAGICAL SAVE — upstream applies this one with
     * `apply_power = getParadoxSpellpower` (temporal-combat.lua:315), and
     * `BREACHED` carries `type: SaveChannel.Magical` to match. A husk's
     * spellpower is unremarkable, which is the point: this lands often enough
     * to matter and not so often that armour stops being worth wearing.
     */
    const landed = ctx.status?.(victim, EffectId.Breached, breachTurns(ctx.talentLevel), {
      applyPower: combatSpellpower(self.combat ?? {}),
      srcId: self.id,
    });
    return talentDone([hit], breachLine(victim.name, landed));
  },

  describe: (_self, level) =>
    `Opens a seam for ${percent(breachMult(level))} weapon damage and breaches armour for ` +
    `${String(breachTurns(level))} turns (magical save).`,
};
