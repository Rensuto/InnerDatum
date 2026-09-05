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

import { SetEffectOutcome } from '../engine/effects.ts';
import type { SetEffectResult } from '../engine/effects.ts';
import { combatTalentScale } from '../../shared/scale.ts';
import { MELEE_REACH } from '../engine/combat.ts';
import { DamageType } from '../engine/damage.ts';
import { EffectId } from '../content/effects.ts';
import { combatPhysicalpower, TalentPower } from '../engine/derived.ts';
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

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * UPSTREAM CHARGES Focus FOR THIS — AND SINCE 2026-09-04 SO DO WE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `2hweapon.lua:216, Stunning Blow` is ``stamina = 8``. The NUMBERS header above carried its
 * cooldown, its damage curve and its effect across; the resource line was not
 * carried, and nothing in this file said so until the probe found it.
 *
 * ═══ WHY IT MATTERS MORE THAN ONE TALENT'S PRICE ═══
 * `tools/class-live.mjs` asks each class, over a socket, what it can spend at
 * the level everybody starts at:
 *
 *     inspector  learned: Revolver Shot(0) | Pistol Whip(0)
 *              NOTHING LEARNED SPENDS FOCUS
 *
 * This talent is the reason. A inspector opens with a full Focus bar, drawn
 * prominently, that cannot be spent on anything until a tier-3 talent — while the
 * Alchemist and the Redactor both spend theirs on the first button they press.
 *
 * ═══ AND IT IS NOT CHANGED HERE ═══
 * Restoring the cost is a balance change to a game people are playing tonight,
 * and the CONVERSION is a real question rather than a transcription: upstream's
 * pools and ours are not the same size, and `RESOLVE_ON_STRUCK` is 6, so a cost
 * near upstream's is two or three earned clauses per press. That is somebody's
 * call to make deliberately. This note exists so it is made deliberately, at the
 * line where it would be made, rather than rediscovered by writing a socket
 * probe a third time.
 *
 * ═══ RULED 2026-09-04: TAKE UPSTREAM'S NUMBER, UNCONVERTED ═══
 * Asked and answered rather than left at the line a third time. The number is
 * TRANSCRIBED, not converted, and that is defensible on three measurements:
 * our pool is 0-100 and so is a ToME actor's stamina (the npcs cluster 90-150);
 * `RESOLVE_PER_TURN` is `0.3 * TOME_ACTIONS_PER_TURN`, which is
 * `tome/class/Actor.lua:230`'s own `stamina_regen = 0.3` ported exactly; and the
 * costs that WERE carried land in the same band -- Lockdown 30, Iron Curtain 25.
 * A conversion factor would have been the invention here; 1:1 is the port.
 */
/**
 * Upstream's own number, transcribed — `2hweapon.lua:219`. See the header's ruling.
 */
const FOCUS_COST = 8;
const AP_COST = 4;
const COOLDOWN = 5;
const MULT_LOW = 0.5;
const MULT_HIGH = 0.9;
const STUN_TURNS = 2;

function damageMult(talentLevel: number): number {
  return combatTalentScale(talentLevel, MULT_LOW, MULT_HIGH);
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT ACTUALLY HAPPENED, NOT WHAT WAS ASKED FOR.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * This line used to read `landed === undefined ? [] : [...]` — a test of
 * whether the STATUS SEAM EXISTS, printed as though it were the result. Every
 * cast announced the authored duration, including the ones the target saved
 * against outright.
 *
 * Caught by `tools/status-live.mjs`: the Case Log said *"Index Cairn is slowed
 * for 3 turns"* and the socket never carried a badge, because the effect came
 * back `outcome=negated, dur=0`. The badge was correctly absent. The sentence
 * was the lie.
 *
 * ═══ AND IT MADE SAVES INVISIBLE, WHICH IS THE REAL COST ═══
 * Every status in this game is rolled against a typed save with partial-save
 * duration scaling — an entire subsystem — and a player who is told "slowed for
 * 3 turns" every single time cannot learn that anything ever resists, cannot
 * see a big save doing its job, and cannot tell a talent that is working from
 * one that is not.
 *
 * `dur <= 0` rather than a test for `Negated` alone: a partial save can grind
 * a duration down to nothing, and "slowed for 0 turns" is the same non-event
 * wearing a different outcome code.
 */
function reelLine(name: string, landed: SetEffectResult | undefined): string[] {
  if (landed === undefined) return [];
  if (landed.outcome === SetEffectOutcome.Immune || landed.dur <= 0) {
    return [`${name} takes it and stays up.`];
  }
  return [`${name} reels for ${String(landed.dur)} turns.`];
}

export const pistolWhip: Talent = {
  id: talentId('pistol_whip'),
  name: 'Pistol Whip',
  classId: ClassId.Inspector,
  tree: 'index/fieldcraft',
  /** Tier 1 of its tree. See `src/shared/tiers.ts`. */
  tier: 1,
  /** fieldcraft is about CUN. See `Talent.statGate`. */
  statGate: 'cun',
  kind: TalentKind.Active,
  iconId: 'icon_active_pistol_whip',
  cost: { ap: AP_COST, resource: FOCUS_COST },
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
  scalesWith: { damage: TalentPower.Weapon, lands: TalentPower.Physical },

  onUse: (ctx, self, target) => {
    const victim = targetActor(ctx.world, target);
    if (victim === undefined) return talentRefused(TalentRefusal.NoTarget);

    const hit = talentAttack(ctx, self, victim, { mult: damageMult(ctx.talentLevel) });
    if (!victim.alive) return talentDone([hit]);

    const landed = ctx.status?.(victim, EffectId.Stunned, STUN_TURNS, {
      applyPower: combatPhysicalpower(self.combat ?? {}),
      srcId: self.id,
    });

    return talentDone([hit], reelLine(victim.name, landed));
  },

  describe: (_self, level) =>
    `Club an adjacent enemy for ${percent(damageMult(level))} weapon damage and stun them ` +
    `for ${String(STUN_TURNS)} turns. ${String(AP_COST)} AP, ${String(COOLDOWN)}-turn cooldown.`,
};
