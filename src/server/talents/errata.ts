// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// SHAPE:   t-engine4 game/modules/tome/data/talents/chronomancy/spacetime-weaving.lua —
//          the short controlled displacement that costs a resource and no turn
//          of output, priced as a repositioning tool rather than an escape.
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

import { combatTalentScale } from '../../shared/scale.ts';
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
} from '../engine/talents.ts';
import type { Talent } from '../engine/talents.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ERRATA — a correction to the record, including where you were standing.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * "The earlier account placed you by the door. The earlier account was wrong."
 *
 * ═══ THE CLASS HAD NO ANSWER TO BEING REACHED ═══
 * A Redactor is life rating 8, the frailest body that ships, and by design has
 * no armour answer — `closed_ledger` and `weight_of_precedent` both say in
 * writing that they do nothing about a stick. That is the correct trade for a
 * controller, and it left the class with no move at all for the turn something
 * closed the gap: every one of its eleven other talents is something to do TO a
 * body, and none of them is somewhere else to stand.
 *
 * ═══ A TELEPORT HERE IS A WALK, AND THE ENGINE SAYS SO ═══
 * `stepToward` goes through `world.tryMove`, which world.ts calls "the ONLY
 * thing in the process allowed to change a position" — terrain, occupancy and
 * the corner-cutting rule are decided in exactly one place. So this does not
 * pass through a wall, and the engine's own note is blunt about the trade: "the
 * only observable difference is around a pillar, and the cost of the
 * alternative is a second position writer."
 *
 * It returns the steps ACTUALLY taken, which is what the log prints. A
 * correction that got two tiles of the three it wanted is a different event
 * from one that got none, and a player who is about to be hit needs to know
 * which happened.
 */

/**
 * Tiles asked for.
 *
 * ═══ 2..6 BECAUSE 2..4 GAVE THE SAME NUMBER TWICE ═══
 * `combatTalentScale(l, 2, 4)` floors to 2,2,3,3,4 — so ranks 1 and 2 spent a
 * point on nothing a player could read, and so did 3 and 4. `class-wiring.test.ts`
 * catches exactly that ("descNext must not equal desc") and caught this. The
 * step count is this talent's ONLY scaling number, so it has to move every rank
 * on its own; 2..6 floors to 2,3,4,5,6.
 */
const STEPS_LOW = 2;
const STEPS_HIGH = 6;
const AP_COST = 2;
const INK_COST = 6;
const COOLDOWN = 3;
/** How far away the destination may be named. */
const RANGE = 5;

function stepsAt(talentLevel: number): number {
  return Math.floor(combatTalentScale(talentLevel, STEPS_LOW, STEPS_HIGH));
}

export const errata: Talent = {
  id: talentId('errata'),
  name: 'Errata',
  classId: ClassId.Redactor,
  tree: 'ledger/errata',
  tier: 1,
  statGate: 'cun',
  kind: TalentKind.Active,
  iconId: 'icon_active_errata',
  cost: { ap: AP_COST, resource: INK_COST },
  cooldownTurns: COOLDOWN,
  targeting: {
    shape: TargetShape.Tile,
    range: RANGE,
    minRange: 0,
    radius: 0,
    requiresLos: true,
    /**
     * A TILE, NOT A BODY. `Affinity.Ally` is the shape's own affinity and not a
     * claim about who is standing there — this names GROUND, and the mover
     * refuses an occupied tile through `tryMove` like any other step.
     */
    affinity: Affinity.Ally,
  },
  damageType: DamageType.Darkness,

  onUse: (ctx, self, target) => {
    const moved = stepToward(ctx.world, self, target, stepsAt(ctx.talentLevel));
    // NOTHING MOVED IS A REFUSAL, NOT A SPENT TURN. Every step was blocked, so
    // the player has not repositioned and must not be charged for having tried
    // — `talentRefused` refunds, which is the one thing a mis-aimed escape must
    // do. A PARTIAL move is a real outcome and keeps its cost.
    if (moved === 0) return talentRefused(TalentRefusal.NoTarget);
    return talentDone(
      [],
      [
        moved === 1
          ? 'The account is corrected by a step.'
          : `The account is corrected by ${String(moved)} steps.`,
      ],
    );
  },

  describe: (_self, level) =>
    `Correct the record about where you were: step up to ${String(stepsAt(level))} tiles toward a ` +
    `point within ${String(RANGE)}. It walks, so a wall still stops it. ${String(AP_COST)} AP, ` +
    `${String(INK_COST)} Ink, ${String(COOLDOWN)}-turn cooldown.`,
};
