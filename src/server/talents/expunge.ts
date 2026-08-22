// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// SHAPE:   t-engine4 game/modules/tome/data/talents/spells/darkness.lua — a
//          thrown darkness ball that lands an effect on everything it covers,
//          priced as the tree's area answer rather than its damage.
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
  TargetShape,
  actorsInShape,
  ballTiles,
  percent,
  talentBaseDamage,
  talentDone,
  talentId,
  talentProject,
} from '../engine/talents.ts';
import type { TalentHit } from '../engine/talents.ts';
import type { Talent } from '../engine/talents.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * EXPUNGE — a whole paragraph gone at once.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * "Not a line. A block."
 *
 * ═══ THE CLASS'S ONLY AREA BUTTON, AND ITS BEST TURN OF INCOME ═══
 * `INK_PER_MARK` pays per detrimental effect that LANDS from something you did,
 * and nothing in the definition caps it at one a turn. So a ball that slows
 * four bodies pays four times, and this is the talent that turns a bad opening
 * — no marks out, well nearly dry — into a full bar in one press.
 *
 * That is the intended shape of the class stated as a button: the Redactor is
 * poor when nothing is wrong and rich when a great deal is, and the way out of
 * poverty is to make a great deal wrong at once.
 *
 * ═══ IT IS PRICED AS INCOME, NOT AS DAMAGE ═══
 * The multiplier is the lowest in the tree and it is applied per body, so a ball
 * that catches one target is a strictly worse Strike Out that costs more. The
 * talent is a bet on how many things are standing together, and losing that bet
 * costs the Ink and the cooldown — the same rule `alchemic_vial.ts` states for a
 * vial thrown at an empty crossroads.
 *
 * ═══ SLOWED, WHICH IS THE MARK THAT DOES NOT STACK INTO A LOCK ═══
 * A radius-1 ball covers nine tiles. Stunning nine bodies would end a fight
 * outright, which is the argument `concussion_flask.ts` makes against exactly
 * that at exactly this radius. `SLOWED` degrades a crowd without removing it,
 * and a crowd that is still acting is a crowd that can still be marked again.
 */

/** Tiles from the caster to the centre of the ball. */
const RANGE = 5;
/** Nine tiles. See the header on why the effect is a slow and not a stun. */
const RADIUS = 1;
const AP_COST = 5;
const INK_COST = 26;
const COOLDOWN = 6;

/** Per body, and the lowest in the tree. See the header. */
const DAMAGE_LOW = 0.3;
const DAMAGE_HIGH = 0.7;

const SLOW_LOW = 2;
const SLOW_HIGH = 5;

function damageMult(talentLevel: number): number {
  return combatTalentScale(talentLevel, DAMAGE_LOW, DAMAGE_HIGH);
}

function slowTurns(talentLevel: number): number {
  return Math.floor(combatTalentScale(talentLevel, SLOW_LOW, SLOW_HIGH));
}

export const expunge: Talent = {
  id: talentId('expunge'),
  name: 'Expunge',
  classId: ClassId.Redactor,
  tree: 'ledger/redaction',
  tier: 3,
  statGate: 'cun',
  kind: TalentKind.Active,
  iconId: 'icon_active_expunge',
  cost: { ap: AP_COST, resource: INK_COST },
  cooldownTurns: COOLDOWN,
  targeting: {
    shape: TargetShape.Ball,
    range: RANGE,
    minRange: 0,
    radius: RADIUS,
    requiresLos: true,
    affinity: Affinity.Hostile,
  },
  damageType: DamageType.Darkness,

  onUse: (ctx, self, target) => {
    // THE SAME CONSTANT THE WIRE SENDS AS `radius`, so the client's shape
    // preview and the tiles that are actually covered cannot disagree — the
    // guarantee `alchemic_vial.ts` and `clear_the_street.ts` both make.
    const tiles = ballTiles(target, RADIUS);
    const victims = actorsInShape(ctx.world, self, tiles, Affinity.Hostile);

    const base = talentBaseDamage(self);
    const mult = damageMult(ctx.talentLevel);
    const turns = slowTurns(ctx.talentLevel);
    const power = combatMindpower(self.combat ?? {});
    const hits: TalentHit[] = [];
    const lines: string[] = [];

    for (const victim of victims) {
      hits.push(talentProject(ctx, self, victim, base, DamageType.Darkness, mult));
      // A BODY THE BLOCK KILLED IS NOT THEN SLOWED. The projection above has
      // already taken its draws, so the stream does not depend on the order the
      // ball happened to find people in.
      if (!victim.alive) continue;
      const landed = ctx.status?.(victim, EffectId.Slowed, turns, {
        applyPower: power,
        srcId: self.id,
      });
      if (landed?.outcome === SetEffectOutcome.Applied) {
        lines.push(`${victim.name} is expunged from the page.`);
      }
    }

    /**
     * NOTHING CAUGHT IS STILL AN OUTCOME. It spends the Ink and the cooldown
     * and says so, rather than refusing: the player made a read on where bodies
     * would be standing and it was wrong, which is legible. The refund rule
     * covers intents that went ILLEGAL, not intents that went badly.
     */
    if (victims.length === 0) return talentDone([], ['The block falls on nothing.']);
    return talentDone(hits, lines);
  },

  describe: (_self, level) =>
    `Drop a block of ink on a point up to ${String(RANGE)} tiles away. Everything within ` +
    `${String(RADIUS)} tile takes ${percent(damageMult(level))} darkness damage and is slowed ` +
    `for ${String(slowTurns(level))} turns (physical save). ${String(AP_COST)} AP, ` +
    `${String(INK_COST)} Ink, ${String(COOLDOWN)}-turn cooldown — and every body it marks ` +
    `pays its Ink back.`,
};
