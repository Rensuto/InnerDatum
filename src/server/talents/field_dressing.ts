// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// NUMBERS: t-engine4 game/modules/tome/data/talents/spells/staff-combat.lua and gifts/moss.lua use
//          removeEffect for cures; the shape ported here is ToME's
//          "remove one detrimental effect from a target" cure, which every
//          module spells the same way: `target:removeEffect(target.EFF_X)`.
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

/**
 * FIELD DRESSING -- the Alchemist, in Ministration.
 *
 * "Hold still. This is going to be worse than the thing that did it."
 *
 * ═══ THE PARTY COULD BE STUNNED AND NOBODY COULD DO ANYTHING ABOUT IT ═══
 * Three of the game's talents apply `STUNNED` or `SLOWED` and NOTHING removes
 * one. Monsters have those talents too. A status a party can receive and cannot
 * answer is not a mechanic, it is a dice roll about whether the fight was
 * winnable -- and stun in a turn-based game is the harshest possible version of
 * that, because it takes the player's turn rather than their hit points.
 *
 * ═══ IT IS THE FIRST CURE IN THE GAME, WHICH IS WHY IT IS DELIBERATELY NARROW
 *     ═══
 * ONE effect, the most recent detrimental one, on ONE ally, at melee range. Not
 * a mass cleanse and not from across the room: the Alchemist has to walk to the
 * person, which is a real cost in a game where movement is the turn. Widening
 * any of those is a later decision with its own diff.
 *
 * ═══ MINISTRATION IS NOW THREE DIFFERENT VERBS ═══
 * Mend Wounds restores life, Backdraft is the aggressive option, and this
 * removes a condition. That is what makes the tree a tree rather than three
 * strengths of the same heal -- and the note on Long Hours already argued that a
 * third way to restore life would be the same talent again with a different
 * sentence.
 *
 * ═══ IT CLOSES THE WOUND TOO, AND THAT IS NOT A RETREAT FROM THAT ARGUMENT ═══
 * The cure count is 1 2 2 3 3 across the ranks, which leaves two of them buying
 * nothing -- and `talent-scaling.test.ts` refuses a dead rank for the reason
 * `fog_step.ts` sets out: a point that reads the same in play feels stolen. A
 * cure has no damage to grow and no duration to lengthen, so it needed a second
 * axis, and a dressing that closes what it cleans is the one that was already
 * implied by the name.
 *
 * IT IS SMALL AND IT IS A FRACTION OF MAX LIFE, deliberately under Mend Wounds
 * at every rank. The distinction the note above draws still holds: this is a
 * rider on a cure, not a third way to restore life. A player who wants healing
 * takes Mend Wounds; a player who takes this for the healing has made a bad
 * trade, and the numbers should say so.
 */

import { combatTalentScale } from '../../shared/scale.ts';
import { DamageType } from '../engine/damage.ts';
import { EffectStatus } from '../engine/effects.ts';
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
  percent,
  healActor,
} from '../engine/talents.ts';
import { MELEE_REACH } from '../engine/combat.ts';
import type { Talent } from '../engine/talents.ts';

const AP_COST = 3;
const COOLDOWN = 4;
const REAGENT_COST = 1;
/**
 * ═══════════════════════════════════════════════════════════════════════════
 * HOW MANY CONDITIONS COME OFF, AND WHY THAT IS THE THING THAT SCALES.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The first draft cured exactly one at every rank, which made a point spent
 * here buy nothing at all -- the trap `talent-scaling.test.ts` refuses across
 * the whole table, and rightly.
 *
 * A cure has no damage to grow and no duration to lengthen. What it has is
 * BREADTH, and upstream's cures scale the same way: the number of effects
 * removed is the curve. One at rank 1, two at rank 5, floored, so the second
 * arrives as a visible event rather than as a fraction.
 */
const CURES_LOW = 1;
const CURES_HIGH = 3;

/**
 * How many conditions a rank clears: 1 2 2 3 3.
 *
 * THREE AT THE TOP IS A FULL CLEANSE, and that is deliberate rather than
 * overlooked — `MVP_EFFECTS` is Stunned, Bleeding and Slowed, so rank 5 can
 * take everything off one ally. It is one ally, at melee range, on a cooldown,
 * for most of a character's lifetime point budget; a cure that could never
 * finish the job would be worse.
 *
 * ROUNDED, NOT FLOORED, so the FIRST point buys the second cure. See the note
 * on `concussion_flask.ts#stunTurnsAt` for why that rule exists.
 */
export function curesAt(level: number): number {
  return Math.round(combatTalentScale(level, CURES_LOW, CURES_HIGH));
}

/** Under `mend_wounds` at every rank — see the header. */
const HEAL_LOW = 0.04;
const HEAL_HIGH = 0.12;

/** The fraction of max life the dressing closes. */
export function healFractionAt(level: number): number {
  return combatTalentScale(level, HEAL_LOW, HEAL_HIGH);
}

export const fieldDressing: Talent = {
  id: talentId('field_dressing'),
  name: 'Field Dressing',
  classId: ClassId.Alchemist,
  tree: 'ashwick/ministration',
  kind: TalentKind.Active,
  iconId: 'icon_active_field_dressing',
  cost: { ap: AP_COST, resource: REAGENT_COST },
  cooldownTurns: COOLDOWN,
  targeting: {
    shape: TargetShape.Single,
    range: MELEE_REACH,
    minRange: 0,
    radius: 0,
    requiresLos: false,
    // THE ONE TALENT IN THE GAME AIMED AT A FRIEND AND NOT AT A BODY.
    affinity: Affinity.Ally,
  },
  damageType: DamageType.Physical,

  onUse: (ctx, self, target) => {
    const patient = targetActor(ctx.world, target);
    if (patient === undefined) return talentRefused(TalentRefusal.NoTarget);

    /**
     * THE MOST RECENT DETRIMENTAL ONE, and "most recent" is a choice worth
     * stating. Curing the LONGEST-remaining effect sounds more generous and is
     * worse to play with: the player cannot see the durations of somebody else's
     * statuses well enough to predict it, so the talent would appear to pick at
     * random. The last thing that landed is the thing they just watched land.
     *
     * `ctx.cure` absent is a fixture with no status table, exactly as
     * `ctx.status` absent is for the talents that apply one -- the refusal is
     * the same shape either way, so a caller cannot tell a missing seam from an
     * ally who simply had nothing wrong with them.
     */
    const cleared: string[] = [];
    for (let i = 0; i < curesAt(ctx.talentLevel); i += 1) {
      const cured = ctx.cure?.(patient, EffectStatus.Detrimental);
      // NOTHING LEFT IS NOT A FAILURE ON THE SECOND PASS. A rank-5 dressing on
      // an ally carrying one condition clears the one and stops; only clearing
      // NOTHING AT ALL is the refusal.
      if (cured === undefined || cured === null) break;
      cleared.push(cured);
    }
    if (cleared.length === 0) return talentRefused(TalentRefusal.NoTarget);

    // THE RIDER, AFTER the cure and only when the cure landed. A dressing put on
    // somebody with nothing wrong with them is the refusal above, so this is not
    // a heal that can be spammed by aiming it at a healthy ally.
    const healed = healActor(patient, Math.round(patient.maxHp * healFractionAt(ctx.talentLevel)));

    return talentDone(
      [],
      [
        `${patient.name} shakes off ${cleared.join(' and ')}.`,
        ...(healed > 0 ? [`${patient.name} recovers ${String(healed)}.`] : []),
      ],
    );
  },

  describe: (_self, level) =>
    `Clear the ${String(curesAt(level))} most recent harmful ` +
    `${curesAt(level) === 1 ? 'condition' : 'conditions'} from an adjacent ally and close ` +
    `${percent(healFractionAt(level))} of their health. ${String(AP_COST)} AP, ` +
    `${String(REAGENT_COST)} Reagent, ${String(COOLDOWN)}-turn cooldown.`,
};
