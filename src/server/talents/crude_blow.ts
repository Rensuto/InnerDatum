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

import { combatTalentScale } from '../../shared/scale.ts';
import { MELEE_REACH } from '../engine/combat.ts';
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
  TalentKind,
} from '../engine/talents.ts';
import type { Talent } from '../engine/talents.ts';

/** FROZEN. 3 of 6 AP is exactly two swings a round — see the header's rhythm. */
const AP_COST = 3;
/**
 * MELEE REACH — 1.5, NOT 1, AND THE ARITHMETIC IS THE WHOLE JUSTIFICATION.
 *
 * `checkTargeting` (engine/talents.ts) and `submitTalent` (turn-engine.ts) both
 * measure with `combatDistance`, which is EUCLIDEAN — `core.fov.distance`. The
 * four diagonal neighbours sit at √2 = 1.4142…, so a range of exactly 1 refuses
 * every one of them: a Watchman standing corner-to-corner with a husk is told
 * OutOfRange on a talent whose whole point is that he is standing on it. 1.5 is
 * the only round number between √2 and the nearest non-neighbour at 2.0, so a
 * circle of that radius holds exactly the eight tiles around you.
 *
 * Imported rather than written as 1.5, because a second literal somewhere else
 * is a second definition of what melee means (engine/combat.ts `MELEE_REACH`).
 */
const RANGE = MELEE_REACH;
/**
 * `damage_multiplier: 1.0` — the baseline every other multiplier is read
 * against, and still EXACTLY the number this talent deals at talent level 1.
 * `combatTalentScale(1, low, high)` returns `low` to the bit (scale.ts:182-208),
 * so un-collapsing this into a curve re-based nothing.
 */
const DAMAGE_MULT_LOW = 1;
/**
 * TUNED HIGH, not ported. There is no upstream Crude Blow to port from — the
 * `SHAPE:` citation above is `attackTarget` itself, which carries no numbers.
 *
 * 1.8 is tuned against the two numbers that ARE authored in this class: Ward
 * Rush's 0.8 (the cheap engage) and Iron Curtain's 1.4 (the heavy, 5 AP and 25
 * Resolve). A fully-trained reliable swing landing at 1.8 sits ABOVE the
 * untrained heavy and BELOW the trained one (2.4), which keeps the at-will
 * button worth pressing all evening without letting it replace the two that
 * cost a resource. Doubling the low would have put it at 2.0 and done exactly
 * that.
 */
const DAMAGE_MULT_HIGH = 1.8;

/** The one place this talent's curve is written. `describe` and `onUse` share it. */
function damageMult(talentLevel: number): number {
  return combatTalentScale(talentLevel, DAMAGE_MULT_LOW, DAMAGE_MULT_HIGH);
}

export const crudeBlow: Talent = {
  id: talentId('crude_blow'),
  name: 'Crude Blow',
  classId: ClassId.Watchman,
  tree: 'watch/discipline',
  kind: TalentKind.Active,
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

    const hit = talentAttack(ctx, self, victim, { mult: damageMult(ctx.talentLevel) });
    return talentDone([hit]);
  },

  describe: (_self, level) =>
    `Swing at an adjacent enemy for ${percent(damageMult(level))} weapon damage. ${AP_COST} AP.`,
};
