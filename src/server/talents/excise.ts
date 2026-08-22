// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// SHAPE:   t-engine4 game/modules/tome/data/talents/chronomancy/spacetime-weaving.lua —
//          the displacement that also leaves something on what it moved past,
//          so the reposition and the mark are one press rather than two turns.
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
  stepToward,
  talentDone,
  talentId,
  talentRefused,
  targetActor,
} from '../engine/talents.ts';
import type { SetEffectResult } from '../engine/effects.ts';
import type { Talent } from '../engine/talents.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * EXCISE — cut it out of the account, and step back from what is left.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * "You take the paragraph out. You do not stand where it was."
 *
 * ═══ IT MOVES AWAY, WHICH IS THE OPPOSITE OF WHAT A GAP-CLOSER DOES ═══
 * `errata` names a destination. This names a BODY, marks it, and puts distance
 * between the two of you — the one thing a Redactor wants after something has
 * reached them. The mark pays `INK_PER_MARK` when it lands, so the retreat is
 * the half that is free.
 *
 * ═══ THE MARK LANDS FIRST, AND THAT ORDER IS LOAD-BEARING ═══
 * `stepToward` walks, so the step can be blocked; the mark cannot. Marking
 * before moving means a Redactor cornered against a wall still gets the effect
 * they paid for, and only loses the retreat they could not have made anyway. The
 * reverse order would silently turn a bad position into a wasted press.
 *
 * ═══ EFFACED, NOT SLOWED ═══
 * `expunge` already slows, in an area, and `recension` slows what it lands
 * beside. Effaced is the class's own mark — "rubbed out at the edges", every
 * roll made and resisted worse — and putting it on the one body that got close
 * is what makes the retreat stick rather than merely delaying the next swing.
 */

const RANGE = 4;
const AP_COST = 4;
const INK_COST = 14;
const COOLDOWN = 5;

/** Tiles of retreat, taken AFTER the mark. */
const STEPS_LOW = 2;
const STEPS_HIGH = 4;

const MARK_LOW = 3;
const MARK_HIGH = 6;

function stepsAt(talentLevel: number): number {
  return Math.floor(combatTalentScale(talentLevel, STEPS_LOW, STEPS_HIGH));
}

function markTurns(talentLevel: number): number {
  return Math.floor(combatTalentScale(talentLevel, MARK_LOW, MARK_HIGH));
}

/** See `strike_out.ts`: a resisted mark and an unattempted one must read apart. */
function markLine(name: string, landed: SetEffectResult | undefined): string[] {
  if (landed === undefined) return [];
  return landed.outcome === SetEffectOutcome.Applied
    ? [`${name} is cut out of the account.`]
    : [`${name} will not come out.`];
}

export const excise: Talent = {
  id: talentId('excise'),
  name: 'Excise',
  classId: ClassId.Redactor,
  tree: 'ledger/errata',
  tier: 2,
  statGate: 'cun',
  kind: TalentKind.Active,
  iconId: 'icon_active_excise',
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

    const landed = ctx.status?.(victim, EffectId.Effaced, markTurns(ctx.talentLevel), {
      applyPower: combatMindpower(self.combat ?? {}),
      srcId: self.id,
    });

    /**
     * AWAY FROM THE BODY, ALONG THE LINE BETWEEN YOU — and the destination has to
     * be FAR, not merely behind.
     *
     * The first version reflected the victim through the caster:
     * `self + (self - victim)`. That puts the destination exactly as far behind
     * you as the victim is in front, which for an ADJACENT body is one tile —
     * and `stepToward` stops on arrival, so every rank retreated exactly one
     * step however many it had bought. `talent-scaling.test.ts` reads rank 1
     * against rank 5 and caught it as a talent that does not scale.
     *
     * The direction is the sign of the difference; the DISTANCE is the steps
     * this rank is allowed. A destination past the wall behind you simply stops
     * at the wall, which is the honest outcome and the reason this can aim
     * further than it expects to walk.
     */
    const steps = stepsAt(ctx.talentLevel);
    const away = {
      x: self.x + Math.sign(self.x - victim.x) * steps,
      y: self.y + Math.sign(self.y - victim.y) * steps,
    };
    const moved = stepToward(ctx.world, self, away, steps);

    const lines = markLine(victim.name, landed);
    if (moved > 0) lines.push(`You step back ${String(moved)}.`);
    return talentDone([], lines);
  },

  describe: (_self, level) =>
    `Cut a body within ${String(RANGE)} tiles out of the account — effaced for ` +
    `${String(markTurns(level))} turns (physical save) — then step up to ` +
    `${String(stepsAt(level))} tiles away from it. The mark lands even when the step ` +
    `cannot. ${String(AP_COST)} AP, ${String(INK_COST)} Ink, ${String(COOLDOWN)}-turn cooldown.`,
};
