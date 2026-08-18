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
 * Alchemist's are gated by a countable stock of eight objects, paid for mostly
 * by killing things — with a top-up at the stairs and a slow trickle of one
 * whole vial every twelve turns underneath it (`REAGENT_REGEN_EVERY_TURNS`,
 * engine/talents.ts). Reliable damage, finite ammunition: the trickle is a floor
 * so a spent Alchemist is never stranded, and at roughly half what bodies pay it
 * does not turn the stock into a bar. Every cast is still a decision about a
 * countable object you are holding.
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

import { combatTalentScale } from '../../shared/scale.ts';
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

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * 3 OF 6, AND IT WAS 4 — THE ONE NUMBER THAT MADE THE BUDGET REAL FOR HER.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `DECISIONS.md` D1 is Accepted and reads *"Intra-turn budget: 6 AP / 3 MP,
 * spendable across several talents in one park"*. Every talent in the game is
 * priced against that round; the engine has never enforced it, and the work to
 * make it enforce it is under way.
 *
 * At 4, the Alchemist's kit was {4, 5, 4, 4} — Flare, Vial, Backdraft, Mend —
 * and her cheapest PAIR was 8. **She had no two-talent round at all, ever.** So
 * the feature the whole budget exists to create, sequencing two cheap actions
 * instead of spending the round on one heavy one, would have shipped for two
 * classes out of three and silently skipped hers.
 *
 * At 3 she has Flare twice, Flare and Mend, or Mend twice — a burst round, a
 * mixed round, and a defensive round. That is the decision arriving, rather than
 * the mechanism arriving and the decision not.
 *
 * ═══ IT COSTS NOTHING TODAY, WHICH IS WHY IT LANDS FIRST ═══
 * One submitted action still ends the actor's turn and `actBase` refills the bar
 * before anyone can observe it, so this deduction is currently unobservable.
 * That is the point of landing the CONTENT before the ENGINE: no deploy is ever
 * half-tuned, and if the numbers are wrong they are wrong while nobody can feel
 * them.
 */
const AP_COST = 3;
/**
 * FROZEN AT 1, and this is the Alchemist's whole gate. Reagents are a countable
 * stock of eight that only refills on a kill or at the stairs, so the cost IS
 * the cooldown (see the `cooldownTurns: 0` note below). A rank that made casts
 * cheaper would turn a finite stock into a bar, which engine/talents.ts's
 * `RESOURCE_RULES` exists to make impossible.
 */
const REAGENT_COST = 1;
/** FROZEN, and equal to the Inspector's reliable range on purpose: the two
 * ranged classes hold the same line, and the difference between them is the
 * die, not the distance. */
const RANGE = 5;
/** `damage_multiplier: 1.3`, `element: "fire"`. Unchanged at talent level 1. */
const DAMAGE_MULT_LOW = 1.3;
/**
 * TUNED HIGH, not ported. ToME's Flame (fire.lua:20-50, the `SHAPE:` citation)
 * carries no multiplier at all — it scales through
 * `combatTalentSpellDamage(t, 25, 290)` (fire.lua:39, cited to the one line so
 * the endpoints are greppable), a FLAT damage curve off spellpower, because
 * upstream spells do not multiply a weapon. This line used to quote 28/270,
 * which is neither Flame's pair nor anything else in the cited block; 28/280
 * does exist at fire.lua:145 but belongs to a different talent, so the wrong
 * number was also the most misleading possible wrong number. This talent
 * deliberately
 * runs on the one damage curve the whole game shares (see the header), so
 * upstream's endpoints are in the wrong units to copy.
 *
 * 2.2 is tuned against the Inspector's Revolver Shot (0.9 -> 1.6), which is the
 * fair comparison: both are the class's at-will ranged button. The flare is
 * ~37% stronger at every rank because it CANNOT MISS and cannot be reduced by
 * armour, and it is paid for out of eight objects rather than out of nothing.
 * That premium is the class trade stated as a number.
 */
const DAMAGE_MULT_HIGH = 2.2;

/** The one place this talent's curve is written. */
function damageMult(talentLevel: number): number {
  return combatTalentScale(talentLevel, DAMAGE_MULT_LOW, DAMAGE_MULT_HIGH);
}

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
      damageMult(ctx.talentLevel),
    );
    return talentDone([hit]);
  },

  describe: (_self, level) =>
    `Loose a flare at a target up to ${RANGE} tiles away for ${percent(damageMult(level))} ` +
    `fire damage. It does not miss. ${AP_COST} AP, ${REAGENT_COST} Reagent.`,
};
