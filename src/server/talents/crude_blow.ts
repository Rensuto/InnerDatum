// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// NUMBERS: Outer Index content/skills/basic_attack.json
//          (ap_cost 3, range 1, min_range 1, target_shape single,
//           damage_type physical, damage_multiplier 1.0)
// SHAPE:   t-engine4 game/modules/tome/class/interface/Combat.lua:92-262 (attackTarget)
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" — https://te4.org/license

/**
 * CRUDE BLOW — the Watchman's reliable attack.
 *
 * "A raw, graceless swing — the first thing you learn on Alderbrook's lower
 * streets and the last thing you forget."
 *
 * ═══ WHY THE COOLDOWN IS ZERO, DELIBERATELY ═══
 * `content/abilities/basic_attack.json` — the OTHER file with this id — carries
 * `cooldown_sec: 2.0`, which R2 would convert to 2 turns. That donor value is
 * READ AND DECLINED here, for two reasons that both point the same way:
 *
 *   1. docs/data-schemas.md § 5 R6: `skills/` is the MECHANICAL authority and
 *      `abilities/` is "a scaling-and-flavour donor only". Six ids exist in
 *      both directories with incompatible schemas and this is one of them.
 *   2. The same doc, two paragraphs later: "skills/*.json have NO cooldown
 *      field — verified, 0 of 33 ... Default `cooldownTurns: 0` and do not
 *      fabricate cooldowns on import." AP is the limiter.
 *
 * A reliable attack on a two-turn cooldown is not a reliable attack. At 3 AP
 * out of 6 this is exactly two swings a round, which is the intended rhythm.
 */

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

const AP_COST = 3;
const RANGE = 1;
/** `damage_multiplier: 1.0` — the baseline every other multiplier is read against. */
const DAMAGE_MULT = 1;

export const crudeBlow: Talent = {
  id: talentId('crude_blow'),
  name: 'Crude Blow',
  classId: ClassId.Watchman,
  iconId: 'icon_active_basic_attack',
  cost: { ap: AP_COST },
  // At-will. See the header — the donor's 2.0 s is declined on purpose.
  cooldownTurns: 0,
  targeting: {
    shape: TargetShape.Single,
    range: RANGE,
    // Melee has no dead zone. `min_range: 1` in the source means "adjacent is
    // fine" in a real-time game; here the closest legal tile IS 1.
    minRange: 0,
    requiresLos: false,
    affinity: Affinity.Hostile,
  },
  damageType: DamageType.Physical,

  onUse: (ctx, self, target) => {
    const victim = targetActor(ctx.world, target);
    // Legality was checked before this ran, but the body re-reads rather than
    // trusting: a refusal here is refunded exactly like one from the predicate.
    if (victim === undefined) return talentRefused(TalentRefusal.NoTarget);

    const hit = talentAttack(ctx, self, victim, { mult: DAMAGE_MULT });
    return talentDone([hit]);
  },

  describe: () =>
    `Swing at an adjacent enemy for ${percent(DAMAGE_MULT)} weapon damage. ${AP_COST} AP.`,
};
