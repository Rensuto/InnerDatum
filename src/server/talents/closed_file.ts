// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// SHAPE:   t-engine4 game/modules/tome/data/talents/cunning/dirty.lua -- the
//          execute shape: a blow whose multiplier is a function of how little
//          the target has left.
// NUMBERS: authored.
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

/**
 * CLOSED FILE -- METHOD, and the deepest thing in it.
 *
 * "Everything after this is paperwork."
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *   THE FIRST TALENT IN THE GAME WHOSE DAMAGE DEPENDS ON THE TARGET.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Every other attack in this game multiplies a weapon by a rank. This one
 * multiplies it by a rank AND by how nearly finished the thing in front of you
 * is — full health and it is a mediocre shot, nearly dead and it is the best
 * one the class owns.
 *
 * ═══ WHY THAT IS WORTH A TIER-4 SLOT ═══
 * It is the answer to the Inspector's OTHER measured problem. `first-fight.mjs`
 * has this class taking twenty-three turns to a Watchman's ten, and slowing the
 * target (Line of Enquiry, two tiers down) fixes the front of that fight. This
 * fixes the BACK of it — the long tail where a husk is at a fifth of its health
 * and still takes four more shots, which is where a twenty-three-turn fight
 * actually goes.
 *
 * ═══ IT SCALES ON THE FRACTION, NOT ON A THRESHOLD ═══
 * A threshold ("below 25%, double damage") is a cliff a player has to compute
 * mid-fight against a health bar they can only see approximately. A smooth
 * ramp is legible without arithmetic: the more hurt it is, the harder this
 * lands, and there is no edge to miss by one point.
 *
 * ═══ AND IT CANNOT FINISH SOMETHING IT DID NOT HELP HURT ═══
 * Nothing stops a player opening with it, and nothing needs to: opening with it
 * is simply bad, because at full health it is the worst attack in the class for
 * the most Focus. The talent teaches its own use.
 */

import { combatTalentScale } from '../../shared/scale.ts';
import { DamageType } from '../engine/damage.ts';
import { TalentPower } from '../engine/derived.ts';
import {
  Affinity,
  ClassId,
  TalentRefusal,
  TargetShape,
  percent,
  talentAttack,
  talentDone,
  talentId,
  talentRefused,
  targetActor,
  TalentKind,
} from '../engine/talents.ts';
import { INSPECTOR_MIN_RANGE } from './revolver_shot.ts';
import type { Talent } from '../engine/talents.ts';

/** FROZEN. Expensive, and a long cooldown: this is the shot that ends it. */
const AP_COST = 4;
const FOCUS_COST = 25;
const COOLDOWN_TURNS = 6;
const RANGE = 6;

/** What it is worth against a target at FULL health. Deliberately poor. */
const FLOOR_LOW = 0.4;
const FLOOR_HIGH = 0.8;
const CURVE = 0.75;

/** The multiplier against an untouched target, at a rank. */
export function floorMultAt(level: number): number {
  return combatTalentScale(level, FLOOR_LOW, FLOOR_HIGH, CURVE);
}

/** How much MORE it is worth against one at death's door, at a rank. */
const BONUS_LOW = 1.1;
const BONUS_HIGH = 2.6;

/** The extra multiplier at zero health, at a rank. */
export function bonusMultAt(level: number): number {
  return combatTalentScale(level, BONUS_LOW, BONUS_HIGH, CURVE);
}

/**
 * The multiplier this shot actually lands with.
 *
 * EXPORTED so the test measures the shipped curve rather than a copy of it, and
 * so `describe` and `onUse` cannot disagree about what the panel promised.
 */
export function multFor(level: number, hpFraction: number): number {
  const missing = Math.min(1, Math.max(0, 1 - hpFraction));
  return floorMultAt(level) + bonusMultAt(level) * missing;
}

export const closedFile: Talent = {
  id: talentId('closed_file'),
  name: 'Closed File',
  classId: ClassId.Inspector,
  tree: 'index/method',
  /** Tier 4 of its tree — the deepest thing in it. See `src/shared/tiers.ts`. */
  tier: 4,
  /** method is about WIL. See `Talent.statGate`. */
  statGate: 'wil',
  kind: TalentKind.Active,
  iconId: 'icon_active_closed_file',
  cost: { ap: AP_COST, resource: FOCUS_COST },
  cooldownTurns: COOLDOWN_TURNS,
  targeting: {
    shape: TargetShape.Single,
    range: RANGE,
    // The class's dead zone, imported rather than re-typed. See
    // `line_of_enquiry.ts` for why that matters.
    minRange: INSPECTOR_MIN_RANGE,
    requiresLos: true,
    affinity: Affinity.Hostile,
  },
  damageType: DamageType.Physical,
  scalesWith: { damage: TalentPower.Weapon },

  onUse: (ctx, self, target) => {
    const victim = targetActor(ctx.world, target);
    if (victim === undefined) return talentRefused(TalentRefusal.NoTarget);

    /**
     * READ BEFORE THE BLOW, WHICH IS THE ONLY ORDER THAT MAKES SENSE. The
     * multiplier is a fact about the target as the shot was AIMED — reading it
     * afterwards would be reading the damage this shot itself did, and the
     * talent would scale on its own effect.
     *
     * A ZERO CEILING IS A FULL BODY. `maxHp` cannot be zero for anything alive,
     * but a division that could produce `NaN` would propagate silently through
     * the multiplier into a damage figure nobody could explain.
     */
    const ceiling = Math.max(1, victim.maxHp);
    const fraction = Math.max(0, Math.min(1, victim.hp / ceiling));
    const mult = multFor(ctx.talentLevel, fraction);

    const hit = talentAttack(ctx, self, victim, { mult });
    return talentDone([hit], victim.alive ? [] : [`${victim.name} is filed and closed.`]);
  },

  describe: (_self, level) =>
    `Shoot for ${percent(floorMultAt(level))} weapon damage against an untouched target, ` +
    `rising to ${percent(multFor(level, 0))} against one at death's door. ` +
    `${String(AP_COST)} AP, ${String(FOCUS_COST)} Focus, ${String(COOLDOWN_TURNS)}-turn cooldown.`,
};
