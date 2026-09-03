// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// SHAPE:   t-engine4 game/modules/tome/data/talents/cursed/gloom.lua — the tier-4
//          mind capstone that reaches past the wall: a talent whose distinction
//          is not its figure but that line of sight is not required.
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
 * STRUCK FROM THE RECORD — you were not at this. You have never been at this.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * "It is not that nobody saw you. It is that the page no longer has a line for
 * you to have been on."
 *
 * ═══ THE OTHER CAPSTONE, AND IT IS NOT ANOTHER BIG NUMBER ═══
 * `final_draft.ts` closes `ledger/redaction` by taking a body out of the fight
 * with the heaviest multiplier the class owns. Giving this tree a second one of
 * those would make the choice between the two trees a choice between two sizes
 * of the same talent.
 *
 * What this one does instead is REACH. Everything else in the class carries
 * `requiresLos: true` and stops at the first wall. This does not: a Redactor can
 * strike out something they cannot see, around a corner, through a door, on the
 * strength of knowing it is there.
 *
 * That is the sentence the class has been making all along — the record is what
 * is true, not the room — and it is the one capability in the game that says it
 * mechanically rather than in a description.
 *
 * ═══ WHAT IT COSTS TO BE ALLOWED THAT ═══
 * Its damage is well under Final Draft's and its Effaced is the same mark
 * `strike_out.ts` throws at tier 1. A talent that ignores line of sight must not
 * ALSO be the biggest hit available, or there is no reason to stand where you
 * can see anything.
 *
 * ═══ THE TARGET STILL HAS TO EXIST, AND THE SERVER STILL DECIDES THAT ═══
 * Dropping `requiresLos` drops a RESOLUTION gate, not a validation one. The
 * intent is still parsed, the range is still checked, `targetActor` still has to
 * find a body at those coordinates, and `Affinity.Hostile` still refuses a
 * teammate. What a client may not do is name a tile the server has not agreed
 * is a target — CLAUDE.md's fifth non-negotiable, unchanged by this talent.
 */

const RANGE = 6;
const AP_COST = 6;
const INK_COST = 30;
const COOLDOWN = 10;

/** Under Final Draft's, and that gap is the price of ignoring walls. */
const DAMAGE_LOW = 0.9;
const DAMAGE_HIGH = 1.7;

const MARK_LOW = 4;
const MARK_HIGH = 8;

function damageMult(talentLevel: number): number {
  return combatTalentScale(talentLevel, DAMAGE_LOW, DAMAGE_HIGH);
}

function markTurns(talentLevel: number): number {
  return Math.floor(combatTalentScale(talentLevel, MARK_LOW, MARK_HIGH));
}

/** See `strike_out.ts`: a resisted mark and an unattempted one must read apart. */
function markLine(name: string, landed: SetEffectResult | undefined): string[] {
  if (landed === undefined) return [];
  if (landed.outcome === SetEffectOutcome.Applied) {
    return [`${name} is struck from the record.`];
  }
  return [`${name} is still on the page.`];
}

export const struckFromTheRecord: Talent = {
  id: talentId('struck_from_the_record'),
  name: 'Struck From The Record',
  classId: ClassId.Redactor,
  tree: 'ledger/testimony',
  tier: 4,
  statGate: 'wil',
  kind: TalentKind.Active,
  iconId: 'icon_active_struck_from_the_record',
  cost: { ap: AP_COST, resource: INK_COST },
  cooldownTurns: COOLDOWN,
  targeting: {
    shape: TargetShape.Single,
    range: RANGE,
    minRange: 0,
    radius: 0,
    /** THE WHOLE TALENT. See the header — and note it drops a resolution gate, not a check. */
    requiresLos: false,
    affinity: Affinity.Hostile,
  },
  damageType: DamageType.Darkness,
  scalesWith: { damage: TalentPower.Weapon, lands: TalentPower.Mind },

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
    if (!victim.alive) return talentDone([hit]);

    const landed = ctx.status?.(victim, EffectId.Effaced, markTurns(ctx.talentLevel), {
      applyPower: combatMindpower(self.combat ?? {}),
      srcId: self.id,
    });
    return talentDone([hit], markLine(victim.name, landed));
  },

  describe: (_self, level) =>
    `Strike out something you cannot see. A target within ${String(RANGE)} tiles — through ` +
    `walls, around corners — takes ${percent(damageMult(level))} darkness damage and is ` +
    `effaced for ${String(markTurns(level))} turns (physical save). ${String(AP_COST)} AP, ` +
    `${String(INK_COST)} Ink, ${String(COOLDOWN)}-turn cooldown.`,
};
