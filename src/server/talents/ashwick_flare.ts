// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// NUMBERS: Outer Index content/skills/fire_bolt.json
//          (display_name "Ashwick Flare", ap_cost 4, range 5, element fire,
//           target_shape single, damage_multiplier 1.3)
// SHAPE:   t-engine4 game/modules/tome/data/talents/spells/fire.lua:20-50
//          (Flame: `cooldown = 3`, `range = 10`, a bolt that goes STRAIGHT to
//           the projector — no `checkHit` anywhere in a spell's path)
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" — https://te4.org/license

/**
 * ASHWICK FLARE — the Alchemist's reliable attack.
 *
 * "A compact ignition of volatile compounds, channeled and loosed from the
 * palm. Smells like Ashwick Row for hours afterward."
 *
 * ═══ IT CANNOT MISS, AND THAT IS THE CLASS ═══
 * `talentProject` skips `checkHit` entirely, because ToME spells do: `Flame`
 * (fire.lua:41-48) and `Throw Bomb` (explosives.lua:44-50) both call
 * `DamageType:get(…).projector` directly, and `attackTargetWith` — the only
 * function in the game that rolls to-hit or applies armour — is never in a
 * spell's call graph. A spell has therefore never been reduced by armour in
 * ToME's history, and reproducing that is what makes these three buttons feel
 * different from the Inspector's three.
 *
 * The trade is the resource. The Inspector's shots are gated by a die; the
 * Alchemist's are gated by a countable stock of eight objects that only refills
 * on a kill or at the stairs. Reliable damage, finite ammunition.
 *
 * ═══ ONE DAMAGE CURVE IN THE GAME ═══
 * The base is `combatDamage` — the same weapon-damage function the Watchman's
 * truncheon runs through — and the difference is entirely in the weapon
 * (content/classes.ts gives the Alchemist a reagent gauntlet whose `dammod` is
 * Magic and Cunning) and in the damage TYPE. ToME's `combatTalentSpellDamage`
 * (Combat.lua:1774-1779) is ported and exported in engine/talents.ts, but is
 * deliberately NOT used here: a second damage curve means two things to
 * balance, two things to test, and two places for a rounding difference to
 * hide. Twelve talents do not need two curves.
 */

import { DamageType } from '../engine/damage.ts';
import {
  Affinity,
  ClassId,
  TalentRefusal,
  TargetShape,
  talentBaseDamage,
  talentId,
  percent,
  talentDone,
  talentProject,
  talentRefused,
  targetActor,
} from '../engine/talents.ts';
import type { Talent } from '../engine/talents.ts';

const AP_COST = 4;
const REAGENT_COST = 1;
const RANGE = 5;
/** `damage_multiplier: 1.3`, `element: "fire"`. */
const DAMAGE_MULT = 1.3;

export const ashwickFlare: Talent = {
  id: talentId('ashwick_flare'),
  name: 'Ashwick Flare',
  classId: ClassId.Alchemist,
  iconId: 'icon_active_fire_bolt',
  cost: { ap: AP_COST, resource: REAGENT_COST },
  // At-will, like the other two reliable slots. The Reagent IS the cooldown:
  // ToME's Flame has `cooldown = 3` and no ammunition, this has ammunition and
  // no cooldown, and one gate per button is enough.
  cooldownTurns: 0,
  targeting: {
    shape: TargetShape.Single,
    range: RANGE,
    minRange: 0,
    requiresLos: true,
    affinity: Affinity.Hostile,
  },
  damageType: DamageType.Fire,

  onUse: (ctx, self, target) => {
    const victim = targetActor(ctx.world, target);
    if (victim === undefined) return talentRefused(TalentRefusal.NoTarget);

    const hit = talentProject(
      ctx,
      self,
      victim,
      talentBaseDamage(self),
      DamageType.Fire,
      DAMAGE_MULT,
    );
    return talentDone([hit]);
  },

  describe: () =>
    `Loose a flare at a target up to ${RANGE} tiles away for ${percent(DAMAGE_MULT)} fire ` +
    `damage. It does not miss. ${AP_COST} AP, ${REAGENT_COST} Reagent.`,
};
