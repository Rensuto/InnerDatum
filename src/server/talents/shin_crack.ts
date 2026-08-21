// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// NUMBERS: t-engine4 game/modules/tome/data/talents/techniques/archery.lua:790-815
//          Crippling Shot -- cooldown 10, combatTalentWeaponDamage(t, 1, 1.5),
//          EFF_SLOW for 7 turns with apply_power = combatAttack().
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

/**
 * SHIN CRACK -- the Watchman, in The Line.
 *
 * "Below the knee. They stop being somewhere else in a hurry."
 *
 * ═══ THE LINE COULD STOP ONE THING AND ONLY BY STANDING ON IT ═══
 * Lockdown taunts and stuns on a long cooldown; Iron Curtain guards an ally.
 * Neither does anything about the monster that has decided to walk PAST the
 * Watchman, which is the failure mode of a guard who cannot be everywhere. A
 * slow is the cheap, repeatable answer: it does not stop the runner, it means
 * the Watchman gets there first.
 *
 * ═══ THE CITATION IS A BOW TALENT AND THE TRANSPLANT IS DELIBERATE ═══
 * Crippling Shot is upstream's slow-on-a-weapon-hit, and what is being ported is
 * the SHAPE -- a normal weapon strike whose payload is EFF_SLOW checked against
 * a save. It arrives here on a truncheon instead of an arrow because this class
 * has no bow, and because a slow delivered from eight tiles away is a different
 * talent entirely: at melee range the Watchman has to have already caught them,
 * which is the cost that makes it fair.
 *
 * DURATION IS 3, NOT 7. Upstream's seven turns is priced against a ten-turn
 * cooldown and a real-time-derived clock; this game's fights are `ENGAGEMENT_TURNS`
 * long, and a slow that outlasts the fight is a slow with no decision in it.
 */

import { SetEffectOutcome } from '../engine/effects.ts';
import type { SetEffectResult } from '../engine/effects.ts';
import { combatTalentScale } from '../../shared/scale.ts';
import { MELEE_REACH } from '../engine/combat.ts';
import { DamageType } from '../engine/damage.ts';
import { EffectId } from '../content/effects.ts';
import { combatAttack } from '../engine/derived.ts';
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
} from '../engine/talents.ts';
import type { Talent } from '../engine/talents.ts';
import { percent } from '../engine/talents.ts';

const AP_COST = 3;
const COOLDOWN = 3;
const MULT_LOW = 0.8;
const MULT_HIGH = 1.2;
/** See the header: `ENGAGEMENT_TURNS`, not upstream's seven. */
const SLOW_TURNS = 3;

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
function slowLine(name: string, landed: SetEffectResult | undefined): string[] {
  if (landed === undefined) return [];
  if (landed.outcome === SetEffectOutcome.Immune || landed.dur <= 0) {
    return [`${name} shakes it off.`];
  }
  return [`${name} is slowed for ${String(landed.dur)} turns.`];
}

export const shinCrack: Talent = {
  id: talentId('shin_crack'),
  name: 'Shin Crack',
  classId: ClassId.Watchman,
  tree: 'watch/the-line',
  /** Tier 1 of its tree. See `src/shared/tiers.ts`. */
  tier: 1,
  /** the-line is about CON. See `Talent.statGate`. */
  statGate: 'con',
  kind: TalentKind.Active,
  iconId: 'icon_active_shin_crack',
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

    // Nothing left to slow. The swing above still consumed its RNG draws, so the
    // stream does not depend on whether it died first -- `lockdown.ts` makes and
    // explains the same guarantee.
    if (!victim.alive) return talentDone([hit]);

    /**
     * AGAINST ACCURACY, WHICH IS UPSTREAM'S CHOICE AND NOT THE OBVIOUS ONE.
     * Crippling Shot passes `apply_power = self:combatAttack()` rather than
     * physical power, so the thing that lands the SLOW is the same number that
     * lands the HIT. That makes Called Shot and a good weapon improve this
     * talent's payload, which is the coherence worth keeping.
     */
    const landed = ctx.status?.(victim, EffectId.Slowed, SLOW_TURNS, {
      applyPower: combatAttack(self.combat ?? {}),
      srcId: self.id,
    });

    return talentDone([hit], slowLine(victim.name, landed));
  },

  describe: (_self, level) =>
    `Crack an adjacent enemy below the knee for ${percent(damageMult(level))} weapon damage ` +
    `and slow them for ${String(SLOW_TURNS)} turns. ${String(AP_COST)} AP, ` +
    `${String(COOLDOWN)}-turn cooldown.`,
};
