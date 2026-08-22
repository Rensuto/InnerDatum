// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// SHAPE:   t-engine4 game/modules/tome/data/talents/cursed/gloom.lua — the
//          at-will mind bolt that exists to PUT SOMETHING ON a target rather
//          than to kill it, and is priced as the button you press every turn.
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
  ClassId,
  TalentKind,
  TalentRefusal,
  TargetShape,
  percent,
  talentBaseDamage,
  talentDone,
  talentId,
  talentProject,
  talentRefused,
  targetActor,
} from '../engine/talents.ts';
import type { SetEffectResult } from '../engine/effects.ts';
import type { Talent } from '../engine/talents.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * STRIKE OUT — the Redactor's at-will, and the tap that fills the well.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * "A line through the middle of it. Still legible, and no longer true."
 *
 * ═══ THIS IS THE BUTTON THE WHOLE RESOURCE IS BUILT AROUND ═══
 * `ResourceKind.Ink` pays `INK_PER_MARK` when a detrimental effect LANDS from
 * something you did (engine/talents.ts `noteAfflicted`). Every other class earns
 * its pool by standing somewhere — in front of the blows, or still, or by
 * counting what it brought. A Redactor earns by making something wrong.
 *
 * So the entry talent has to be a mark rather than a hit, and it has to be
 * cheap enough to press when the well is nearly dry. It costs LESS Ink than a
 * landed mark pays back, which makes it the only talent in the game that is
 * net-positive on its own resource — deliberately, because a class whose income
 * is conditional needs one unconditional way to prime it.
 *
 * IT IS NOT FREE, and the difference matters: a miss on the save costs the Ink
 * and returns nothing, so opening on a body with a strong mental save is a real
 * decision rather than a formality.
 *
 * ═══ EFFACED, WHICH ALREADY EXISTED AND NOBODY COULD APPLY ═══
 * `EFFACED` has been in `content/effects.ts` since the husk was written, and
 * until this talent the only thing in the game that could put it on anything was
 * a monster. It is the right mark for this class by its own description —
 * "rubbed out at the edges" — and reusing it rather than inventing a fifth
 * status keeps the badge row legible.
 *
 * Its channel is PHYSICAL (`physical.lua:31`) even though the Redactor applies
 * it with mindpower, and that asymmetry is upstream's own: `apply_power` and
 * `type` are independent fields in `setEffect`, and plenty of ToME's mind
 * talents apply physically-saved effects. What resists being rubbed out is how
 * solid you are, not how clear-headed.
 */

/** Tiles. Short for a ranged class — a clerk works at desk distance. */
const RANGE = 6;
const AP_COST = 4;
/** Under `INK_PER_MARK`. See the header: the entry mark must be net-positive. */
const INK_COST = 8;

/** Weapon-damage multiplier. Low: this is a mark that also stings, not a bolt. */
const DAMAGE_LOW = 0.55;
const DAMAGE_HIGH = 1.1;

/** Turns of Effaced. */
const MARK_LOW = 3;
const MARK_HIGH = 6;

function damageMult(talentLevel: number): number {
  return combatTalentScale(talentLevel, DAMAGE_LOW, DAMAGE_HIGH);
}

function markTurns(talentLevel: number): number {
  return Math.floor(combatTalentScale(talentLevel, MARK_LOW, MARK_HIGH));
}

/**
 * THE LINE THE LOG PRINTS, and it says which of the three things happened.
 *
 * A mark that was RESISTED and a mark that was never attempted look identical
 * on the badge row, and they are worth opposite decisions: one says press it
 * again, the other says this body cannot be marked. Ink is spent either way,
 * so the player is owed the difference in words.
 */
function markLine(name: string, landed: SetEffectResult | undefined): string[] {
  if (landed === undefined) return [];
  if (landed.outcome === SetEffectOutcome.Applied) {
    return [`${name} is struck out.`];
  }
  return [`${name} holds the line — nothing is struck.`];
}

export const strikeOut: Talent = {
  id: talentId('strike_out'),
  name: 'Strike Out',
  classId: ClassId.Redactor,
  tree: 'ledger/redaction',
  /** Tier 1 of its tree. See `src/shared/tiers.ts`. */
  tier: 1,
  /** redaction is about CUNNING. See `Talent.statGate`. */
  statGate: 'cun',
  kind: TalentKind.Active,
  iconId: 'icon_active_strike_out',
  cost: { ap: AP_COST, resource: INK_COST },
  /**
   * AT WILL. The Ink price is the gate, and one gate per button is enough —
   * the same argument `ashwick_flare.ts` makes for its Reagent.
   */
  cooldownTurns: 0,
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

    const hit = talentProject(
      ctx,
      self,
      victim,
      talentBaseDamage(self),
      DamageType.Darkness,
      damageMult(ctx.talentLevel),
    );
    // NOTHING IS MARKED ON A CORPSE. The projection above already took its RNG
    // draws, so the stream does not depend on whether the body died first.
    if (!victim.alive) return talentDone([hit]);

    const landed = ctx.status?.(victim, EffectId.Effaced, markTurns(ctx.talentLevel), {
      applyPower: combatMindpower(self.combat ?? {}),
      srcId: self.id,
    });
    return talentDone([hit], markLine(victim.name, landed));
  },

  describe: (_self, level) =>
    `Strike a line through a target up to ${String(RANGE)} tiles away for ` +
    `${percent(damageMult(level))} darkness damage and efface it for ` +
    `${String(markTurns(level))} turns (physical save). ${String(AP_COST)} AP, ` +
    `${String(INK_COST)} Ink — a mark that lands pays back more than it cost.`,
};
