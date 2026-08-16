// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// NUMBERS: Outer Index content/skills/revolver_shot.json
//          (ap_cost 3, range 5, target_shape single, damage_multiplier 0.9)
// SHAPE:   t-engine4 game/modules/tome/class/interface/Combat.lua:380-608
//          (attackTargetWith — archery DOES roll checkHit, unlike a spell)
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" — https://te4.org/license

/**
 * REVOLVER SHOT — the Inspector's reliable attack.
 *
 * "A quick pistol shot from any distance. Cheap, reliable, and louder than the
 * alchemic flares fashionable in upper Alderbrook."
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * IT CARRIES THE DEAD ZONE. min_range 3, ON THE RELIABLE SHOT.
 * ═══════════════════════════════════════════════════════════════════════════
 * The authored JSON says `min_range: 1`. That value is OVERRIDDEN here, and
 * this is the one deliberate contradiction of source data in the twelve, so it
 * gets spelled out:
 *
 *   - In Outer Index, a real-time twin-stick game, `min_range: 1` means "no
 *     dead zone at all". It is the absence of a constraint, not a constraint.
 *   - game-design.md § 2 is emphatic in the other direction: *"`min_range 3` is
 *     the single most important number here: the Inspector **cannot shoot
 *     adjacent**. The Watchman holding a choke is literally what lets the
 *     Inspector exist."*
 *
 * If the dead zone applied only to Sniper's Mark, the Inspector would simply
 * fall back to Revolver Shot whenever something closed, the Watchman's
 * chokepoint would buy nothing, and the class would read as a slightly worse
 * Watchman. The dead zone is a CLASS property, so all three of the Inspector's
 * guns carry it and Fog Step is the only answer to something on top of you.
 *
 * The refusal is `TalentRefusal.MinRange`, never a miss, so the log can say
 * "too close" instead of quietly eating the turn — and `canUseTalent` runs
 * before anything is spent, so being crowded costs zero AP.
 */

import { combatTalentScale } from '../../shared/scale.ts';
import { DamageType } from '../engine/damage.ts';
import {
  Affinity,
  ClassId,
  TalentRefusal,
  TargetShape,
  talentAttack,
  talentId,
  percent,
  talentDone,
  talentRefused,
  targetActor,
} from '../engine/talents.ts';
import type { Talent } from '../engine/talents.ts';

/** FROZEN. Two shots a round out of 6 AP, matching the Watchman's rhythm. */
const AP_COST = 3;
/**
 * FROZEN, and it is the number the dead zone is measured against.
 *
 * A reliable shot with a growing range would eventually reach past Sniper's
 * Mark's 7, at which point the signature is the cheap button with a bigger
 * multiplier and the class has one gun instead of three. Fog Step is the only
 * talent in the game whose level buys distance; see that file's argument.
 */
const RANGE = 5;
/** THE class constant. See the header — it overrides the authored `min_range: 1`. */
export const INSPECTOR_MIN_RANGE = 3;
/** `damage_multiplier: 0.9`. Unchanged at talent level 1. */
const DAMAGE_MULT_LOW = 0.9;
/**
 * TUNED HIGH, not ported. `attackTargetWith` (the `SHAPE:` citation) carries no
 * multiplier of its own, so there is nothing upstream to copy.
 *
 * 1.6 is tuned to hold the gap this talent was authored with: 0.9 against
 * Sniper's Mark's 1.65 is 55%, and 1.6 against its 3.5 is 46%. The reliable
 * shot therefore stays the cheap option rather than converging on the signature
 * — the trade a fully-trained Inspector makes is still "twice for 6 AP, or once
 * for 5 AP and 35 Focus", which is the decision the class is built on.
 */
const DAMAGE_MULT_HIGH = 1.6;

/** The one place this talent's curve is written. */
function damageMult(talentLevel: number): number {
  return combatTalentScale(talentLevel, DAMAGE_MULT_LOW, DAMAGE_MULT_HIGH);
}

export const revolverShot: Talent = {
  id: talentId('revolver_shot'),
  name: 'Revolver Shot',
  classId: ClassId.Inspector,
  iconId: 'icon_active_revolver_shot',
  cost: { ap: AP_COST },
  // At-will, like every reliable slot: skills/*.json carry no cooldown field
  // (0 of 33, docs/data-schemas.md § 5) and AP is the limiter.
  cooldownTurns: 0,
  targeting: {
    shape: TargetShape.Single,
    range: RANGE,
    minRange: INSPECTOR_MIN_RANGE,
    requiresLos: true,
    affinity: Affinity.Hostile,
  },
  damageType: DamageType.Physical,

  onUse: (ctx, self, target) => {
    const victim = targetActor(ctx.world, target);
    if (victim === undefined) return talentRefused(TalentRefusal.NoTarget);

    const hit = talentAttack(ctx, self, victim, { mult: damageMult(ctx.talentLevel) });
    return talentDone([hit]);
  },

  describe: (_self, level) =>
    `Shoot a target ${INSPECTOR_MIN_RANGE}-${RANGE} tiles away for ` +
    `${percent(damageMult(level))} weapon damage. Cannot fire inside ` +
    `${INSPECTOR_MIN_RANGE} tiles. ${AP_COST} AP.`,
};
