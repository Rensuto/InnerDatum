// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// NUMBERS: t-engine4 game/modules/tome/data/talents/spells/explosives.lua:207 (Shockwave Bomb) for the
//          shape -- a thrown charge whose payload is a status rather than
//          damage -- and techniques/2hweapon.lua:213-250 (Stunning Blow)
//          for EFF_STUNNED applied against a save with an apply_power.
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

/**
 * CONCUSSION FLASK -- the Alchemist, in Reagents.
 *
 * "Not much of a bang. A great deal of a ringing."
 *
 * ═══ THE PARTY HAD EXACTLY ONE STUN AND IT WAS ON THE FRONT LINE ═══
 * Lockdown is the Watchman's, it costs him his position to use, and it is one
 * body. In a co-op game where the whole plan is that somebody else is holding
 * the door, the ability to take a turn away from something the party is NOT
 * standing next to is the difference between a plan and a scramble. This is that
 * tool, and it belongs to the class that is already standing at the back.
 *
 * ═══ IT DEALS NO DAMAGE, AND THAT IS THE DESIGN ═══
 * Ashwick Flare and the Alchemic Vial are the damage in this tree. A third
 * thrown thing that also damaged would be a choice between three numbers; a
 * thrown thing that ONLY buys time is a different question -- and it means the
 * flask is worth carrying at any level, because its value never falls behind a
 * damage curve.
 *
 * ═══ ONE TILE, NOT A BALL, AND IT IS PRICED FOR IT ═══
 * A radius-1 stun would take three monsters out of a fight for two turns from
 * six tiles away, which is not a talent, it is an off switch. Single target, and
 * the cost sits high enough that it is the answer to ONE dangerous thing rather
 * than the opener for every fight.
 */

import { combatTalentLimit, combatTalentScale } from '../../shared/scale.ts';
import { DamageType } from '../engine/damage.ts';
import { EffectId } from '../content/effects.ts';
import { combatMindpower } from '../engine/derived.ts';
import {
  Affinity,
  ClassId,
  TalentKind,
  TalentRefusal,
  TargetShape,
  talentDone,
  talentId,
  talentRefused,
  targetActor,
} from '../engine/talents.ts';
import type { Talent } from '../engine/talents.ts';

const AP_COST = 4;
const COOLDOWN = 6;
const REAGENT_COST = 2;
/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE THROW GETS LONGER EVERY RANK, AND THAT IS WHAT MAKES THE TALENT LEGAL.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The stun duration is the headline and it CANNOT carry the curve on its own:
 * whole turns over five ranks is 2 3 3 4 4, which leaves ranks 2->3 and 4->5
 * buying nothing. `talent-scaling.test.ts` refuses a dead rank across the whole
 * table, and `fog_step.ts` states the reason at length -- ranks that read the
 * same in play make the second point a player spent feel stolen.
 *
 * A THIRD DAMAGE NUMBER WAS THE OBVIOUS FIX AND IS THE WRONG ONE. This tree
 * already has two thrown things that damage; the whole argument for this one is
 * that it buys TIME instead, and giving it a damage curve to satisfy a test
 * would delete the distinction the talent exists for.
 *
 * Range is the honest second axis and it needs no new mechanic:
 * `TalentTargeting.rangeAt` already exists for exactly this, `effectiveTalentRange`
 * is the single function both the client's ring and the server's refusal resolve
 * through, and "you can throw it from further back" is precisely what a rank in
 * a thrown talent should mean for the class that stands at the back.
 */
const RANGE_LOW = 4;
const RANGE_HIGH = 8;
/** The same shape as `fog_step`'s: one tile per rank, no dead rank. */
const RANGE_LIMIT = 11;

/** How far the flask can be thrown at a rank: 4 5 6 7 8. */
export function throwRange(talentLevel: number): number {
  return Math.floor(combatTalentLimit(talentLevel, RANGE_LIMIT, RANGE_LOW, RANGE_HIGH));
}
/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE DURATION IS WHAT A POINT BUYS, AND IT HAS TO BUY SOMETHING.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The first draft of this talent was flat: two turns at every rank, no damage,
 * so a point spent in it changed NOTHING. `talent-scaling.test.ts` refuses that
 * across the whole table, and it is right to — a talent you can pour eleven
 * lifetime points into that never improves is a trap laid for the player who
 * likes it most.
 *
 * The radius stays fixed (see the note in `scattershot.ts` about a radius the
 * client cannot follow), and the damage is zero by design, so the duration is
 * the only honest place for the curve. Warshout is upstream's flat-damage
 * stunner and scales exactly this way -- `math.floor(combatTalentScale(t, 4, 8))`
 * at 2hweapon.lua:121. Halved, because a four-turn stun at rank 1 in a game
 * whose fights are `ENGAGEMENT_TURNS` long is not a control talent, it is a
 * deletion.
 */
const STUN_LOW = 2;
const STUN_HIGH = 4;

/**
 * Turns of stun at a rank: 2 3 3 4 4.
 *
 * ROUNDED, NOT FLOORED, AND UPSTREAM FLOORS. The difference matters at exactly
 * one place and it is the important one: `floor` gives 2 2 3 3 4, so the FIRST
 * point a player spends buys nothing visible. `class-wiring.test.ts` refuses
 * that across the whole table by asserting rank 2's sentence differs from rank
 * 1's, and it is the right rule — the first point is the one that teaches a
 * player whether spending points does anything.
 */
export function stunTurnsAt(level: number): number {
  return Math.round(combatTalentScale(level, STUN_LOW, STUN_HIGH));
}

export const concussionFlask: Talent = {
  id: talentId('concussion_flask'),
  name: 'Concussion Flask',
  classId: ClassId.Alchemist,
  tree: 'ashwick/reagents',
  kind: TalentKind.Active,
  iconId: 'icon_active_concussion_flask',
  cost: { ap: AP_COST, resource: REAGENT_COST },
  cooldownTurns: COOLDOWN,
  targeting: {
    shape: TargetShape.Single,
    range: RANGE_LOW,
    // The level-1 range is a FLOOR, not the answer — `rangeAt` is what
    // `canUseTalent` and the projector resolve. Same split as `fog_step`.
    rangeAt: throwRange,
    minRange: 0,
    radius: 0,
    requiresLos: true,
    affinity: Affinity.Hostile,
  },
  damageType: DamageType.Physical,

  onUse: (ctx, self, target) => {
    const victim = targetActor(ctx.world, target);
    if (victim === undefined) return talentRefused(TalentRefusal.NoTarget);

    /**
     * MIND POWER, NOT PHYSICAL POWER, AND IT IS THE ONE ARGUABLE LINE HERE.
     *
     * Stunning Blow passes `combatPhysicalpower` because a big man hit you. A
     * flask that bursts beside somebody is not the Alchemist's arm strength --
     * it is the mixture -- and `combatMindpower` is what this game gives that
     * idea. It reads the Alchemist's Willpower and Cunning, which are the two
     * stats Bedside Manner and Cut With Chalk buy, so the class's own passives
     * improve its own control talent.
     *
     * The SAVE is unchanged: `STUNNED.type` is PHYSICAL, so a heavy thing still
     * shrugs this off more easily than a frail one. What moved is which of the
     * THROWER's numbers is on the other side of that roll.
     */
    const turns = stunTurnsAt(ctx.talentLevel);
    const landed = ctx.status?.(victim, EffectId.Stunned, turns, {
      applyPower: combatMindpower(self.combat ?? {}),
      srcId: self.id,
    });

    // NO HITS, AND THE LINE IS THEREFORE THE WHOLE OUTPUT. A talent that
    // returned an empty `talentDone([])` with nothing to say would look to the
    // player exactly like a talent that failed.
    return talentDone(
      [],
      landed === undefined
        ? [`The flask bursts beside ${victim.name}.`]
        : [`${victim.name} is stunned for ${String(turns)} turns.`],
    );
  },

  describe: (_self, level) =>
    `Burst a flask beside an enemy up to ${String(throwRange(level))} tiles away, stunning them for ` +
    `${String(stunTurnsAt(level))} turns. It deals no damage. ${String(AP_COST)} AP, ` +
    `${String(REAGENT_COST)} Reagents, ${String(COOLDOWN)}-turn cooldown.`,
};
