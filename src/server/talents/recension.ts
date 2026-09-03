// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// SHAPE:   t-engine4 game/modules/tome/data/talents/chronomancy/spacetime-weaving.lua —
//          the tier-4 displacement that resolves an effect around where the
//          caster ARRIVES rather than where they left.
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
  actorsInShape,
  ballTiles,
  stepToward,
  talentDone,
  talentId,
  talentRefused,
} from '../engine/talents.ts';
import type { Talent } from '../engine/talents.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * RECENSION — the whole edition revised, and you were never on that page.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * "A recension is not a correction. It is the text as it should always have
 * been, and the earlier one is withdrawn."
 *
 * ═══ THE CAPSTONE THAT LEAVES RATHER THAN ENDS ═══
 * The other two tier-4s in this class finish an argument: `final_draft` dazes a
 * body and `struck_from_the_record` reaches one through a wall. This one is the
 * escape, and it earns its tier by not being only an escape — everything
 * standing where you ARRIVE is slowed, so the ground you took is ground the
 * fight has to cross twice.
 *
 * ═══ RESOLVED AT THE DESTINATION, AFTER THE WALK ═══
 * The slow is read off where the caster actually ENDED, not where they aimed.
 * `stepToward` walks and can be stopped short, and a capstone that resolved
 * against the intended tile would slow an empty corridor while the Redactor
 * stood two squares back in the fight they meant to leave. Reading the real
 * position costs one line and is the difference between the talent's sentence
 * being true and being nearly true.
 *
 * ═══ IT COSTS THE MOVE EVEN IF NOTHING IS BESIDE YOU ═══
 * Landing alone is a good outcome for this class, not a wasted press, so an
 * empty radius says so and keeps its cost — the rule `expunge` states for a
 * block that falls on nothing. Only a walk that moved NOTHING is refunded,
 * because then the player has not repositioned at all.
 */

const RANGE = 6;
const AP_COST = 5;
const INK_COST = 28;
const COOLDOWN = 10;
/** One tile: nine squares around where you land. See `expunge` on why not more. */
const RADIUS = 1;

/**
 * 3..7, NOT 3..6. Two numbers scale in this description and BOTH must not
 * repeat a pair: 3..6 floors to 3,4,4,5,6 and the slow to 2,3,3,4,5, which
 * renders ranks 2 and 3 identically — a point spent on nothing readable.
 * 3..7 gives 3,4,5,6,7 and every rank reads differently.
 */
const STEPS_LOW = 3;
const STEPS_HIGH = 7;

const SLOW_LOW = 2;
const SLOW_HIGH = 5;

function stepsAt(talentLevel: number): number {
  return Math.floor(combatTalentScale(talentLevel, STEPS_LOW, STEPS_HIGH));
}

function slowTurns(talentLevel: number): number {
  return Math.floor(combatTalentScale(talentLevel, SLOW_LOW, SLOW_HIGH));
}

export const recension: Talent = {
  id: talentId('recension'),
  name: 'Recension',
  classId: ClassId.Redactor,
  tree: 'ledger/errata',
  tier: 4,
  statGate: 'cun',
  kind: TalentKind.Active,
  iconId: 'icon_active_recension',
  cost: { ap: AP_COST, resource: INK_COST },
  cooldownTurns: COOLDOWN,
  targeting: {
    shape: TargetShape.Tile,
    range: RANGE,
    minRange: 0,
    radius: RADIUS,
    requiresLos: true,
    affinity: Affinity.Ally,
  },
  damageType: DamageType.Darkness,
  scalesWith: { lands: TalentPower.Mind },

  onUse: (ctx, self, target) => {
    const moved = stepToward(ctx.world, self, target, stepsAt(ctx.talentLevel));
    // A REVISION THAT MOVED NOTHING IS NOT A REVISION. Refunded — see the header.
    if (moved === 0) return talentRefused(TalentRefusal.NoTarget);

    // WHERE THE CASTER ACTUALLY IS. See the header: the walk can be stopped short.
    const tiles = ballTiles({ x: self.x, y: self.y }, RADIUS);
    const caught = actorsInShape(ctx.world, self, tiles, Affinity.Hostile);
    const turns = slowTurns(ctx.talentLevel);
    const power = combatMindpower(self.combat ?? {});
    const lines = [
      `The edition is revised — you were never on that page (${String(moved)} steps).`,
    ];

    for (const victim of caught) {
      const landed = ctx.status?.(victim, EffectId.Slowed, turns, {
        applyPower: power,
        srcId: self.id,
      });
      if (landed?.outcome === SetEffectOutcome.Applied) {
        lines.push(`${victim.name} is left behind in the earlier text.`);
      }
    }
    return talentDone([], lines);
  },

  describe: (_self, level) =>
    `Revise the edition: step up to ${String(stepsAt(level))} tiles toward a point within ` +
    `${String(RANGE)}, and everything within ${String(RADIUS)} tile of where you LAND is slowed ` +
    `for ${String(slowTurns(level))} turns (physical save). ${String(AP_COST)} AP, ` +
    `${String(INK_COST)} Ink, ${String(COOLDOWN)}-turn cooldown.`,
};
