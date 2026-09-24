// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// SHAPE:   t-engine4 game/modules/tome/data/talents/chronomancy/chronomancy.lua:52-63
//          Foresight — `mode = "passive"`, `talentTemporaryValue(p, "combat_def", ...)`
// PORTED:  t-engine4 game/modules/tome/data/talents/cunning/survival.lua:21-48
//          Heightened Senses — `sense = floor(combatTalentScale(t, 5, 9))`, written
//          to `heightened_senses` at cunning/survival.lua:36. Radius 5 at rank 1,
//          and the whole of its FOV pass is tome/class/Player.lua:636-644.
// PARTIAL: AND IT IS SAID OUT LOUD RATHER THAN QUIETLY SHIPPED, which is this
//          repo's own standard — `overseer_of_nations.ts` two files over.
//          Upstream's `passives` block writes FOUR attributes
//          (cunning/survival.lua:35-40) and autolearns a fifth talent at
//          cunning/survival.lua:41: `heightened_senses`, `see_invisible`,
//          `see_stealth`, `see_traps`, `T_DISARM_TRAP`. ONE of the five crosses.
//          The other four name things this game does not have: no actor is
//          invisible or stealthed anywhere in `src/`, and `TrapSpec.detectPower`
//          (engine/traps.ts:221) is authored on every trap and READ BY NOTHING —
//          `scheduler.ts` says it in its own words, *"with no detection talent
//          in this game, stepping on it is the only"* way a trap is found. The
//          day any of those four ships, this is the talent that owes it a line.
// NUMBERS: NOT PORTED, and said here rather than hidden. Every defence passive
//          in ToME scales off a STAT — Foresight is
//          `combatTalentStatDamage(t, "mag", 10, 50)`, Light Armour Training is
//          `combatScale(getTalentLevel * getDex, 4, 0, 50, 500, 0.375)`
//          (techniques/combat-training.lua:119) — and `PassiveContribution` has
//          no stat term yet. The band below is chosen against our own defence
//          numbers. When a stat term exists, a real citation replaces this note.
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" — https://te4.org/license

/**
 * COLD READING — the Inspector's passive, and the quiet half of Fieldcraft.
 *
 * "You read the room on the way in. Very little in it surprises you twice."
 *
 * ═══ WHY DEFENCE, IN THIS TREE ═══
 * `Fieldcraft` is about being somewhere else by the time it looks — Fog Step and
 * the Sigil, both of them presses. Defence is that same idea with no button: the
 * blow that was going to land does not, because you had already read where it
 * was coming from.
 *
 * ═══ THE SHAPE IS ToME'S AND THE BAND IS OURS, WHICH IS THE HONEST SPLIT ═══
 * See the header. Porting a formula whose stat term we do not have would mean
 * inventing the half it depends on and citing a line that does not say what the
 * code does. 1 to 5 is deliberately narrower than Standing Orders' 1 to 7:
 * defence gates a hit entirely where armour only shaves one, and `checkHit` is a
 * ratio, so the same number buys more here.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * AND IT IS TWO OF ToME'S PASSIVES, WHICH IS SAID HERE RATHER THAN DISCOVERED
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The defence half is Tactical Expert (cunning/tactical.lua:30-60). The SENSES
 * half is Heightened Senses (cunning/survival.lua:21-48): its `sense` formula is
 * ported number for number — `sense = math.floor(self:combatTalentScale(t, 5,
 * 9))`, RADIUS 5 AT RANK 1, written to the `heightened_senses` attribute that
 * tome/class/Player.lua:636-644 reads.
 *
 * THAT IS THE FORMULA AND IT IS NOT THE WHOLE TALENT. Upstream's `passives`
 * block writes four attributes and autolearns a fifth talent; one of the five
 * crosses. The header's `PARTIAL:` block says which and why, to the standard
 * `overseer_of_nations.ts` sets.
 *
 * ═══ WHY THEY LAND ON ONE TALENT ═══
 * Upstream has two cunning TREES and we have one cunning-gated tier-1 passive.
 * Both upstream talents are `mode = "passive"`, both are tier 1, both `require`
 * a Cunning gate, and `index/fieldcraft` is the Inspector's cunning discipline.
 * Folding a second upstream passive into one of ours is the same move
 * `steady_hands.ts` makes with Sling Sniper's two halves — and it is stated in
 * the header rather than left for the next person to measure.
 *
 * ═══ WHY THE INSPECTOR IS THE ONE WHO GETS IT ═══
 * Because upstream gives it to her. `cunning/survival` is `{true, 0}` — OPEN AT
 * BIRTH — on the Archer (data/birth/classes/warrior.lua:213), and upstream
 * hands every character two unspent class points at birth
 * (tome/class/Actor.lua:170-172) to spend on exactly that kind of thing. Our
 * birth points WERE converted into four free birth talents (`src/shared/tiers.ts`)
 * and this note used that as the reason Heightened Senses had to be one of the
 * four. The birth points exist now as well, 2 class / 1 generic / 3 attribute
 * on top of the four, as upstream pays them on top of its descriptor talents —
 * so this being one of the Inspector's four free talents is now a choice to
 * keep her able to see in the dark from the first step, not the only faithful
 * place for it. It is, in `INSPECTOR.birthTalents`.
 *
 * ═══ WHAT IT WAS WORTH, MEASURED ═══
 * A level-1 Inspector's legal firing band in an unlit cave was EMPTY — not
 * narrow, EMPTY. Her seen radius was exactly 2.00 (the brass lantern's `lite`)
 * and her nearest legal tile is 3.00, so there were zero tiles she could fire
 * at, at every dark site in the game. Her win rate across every floor was 47%
 * on fully lit ground against 4% on unlit: a 12× differential where the
 * Watchman's is 1.4×.
 *
 * ═══ IT IS NOT A LANTERN, AND THE DIFFERENCE IS THE POINT ═══
 * It reveals a tile ONLY where a body is standing, under the same line of sight
 * everything else obeys. The floor stays black. Upstream says so in the talent's
 * own text: *"This is not telepathy, however, and it is still limited to line of
 * sight."*
 *
 * ═══ IT HAS NO `onUse`, AND THAT IS THE DECLARATION ═══
 * See `Talent.onUse` — the absent body IS `mode = "passive"`.
 */

import { combatTalentScale } from '../../shared/scale.ts';
import { DamageType } from '../engine/damage.ts';
import { Affinity, ClassId, TalentKind, TargetShape } from '../engine/talents.ts';
import type { Talent } from '../engine/talents.ts';

/**
 * OUR BAND — see the header for why it is not ported. Narrower than Standing
 * Orders' 1..7 because defence gates a hit entirely where armour shaves one.
 */
const DEF_LOW = 1;
const DEF_HIGH = 5;
/** ToME's curve exponent, which IS ported. */
const CURVE = 0.75;

/** Defence at a rank. Our band, ToME's curve shape. */
export function defenceAt(level: number): number {
  return Math.round(combatTalentScale(level, DEF_LOW, DEF_HIGH, CURVE));
}

/**
 * HOW MANY FOES STILL PAY. Upstream caps Tactical Expert as well; the number is
 * ours because our rooms are smaller than upstream's.
 */
export const ADJACENT_CAP = 3;
/** The per-foe band. Named for the same reason DEF_LOW/DEF_HIGH above are. */
const PER_FOE_LOW = 2;
const PER_FOE_HIGH = 6;

/** Defence granted PER adjacent enemy, at a rank. */
export function perFoeAt(level: number): number {
  return Math.round(combatTalentScale(level, PER_FOE_LOW, PER_FOE_HIGH, CURVE));
}

/**
 * ToME'S OWN BAND, NOT OURS — cunning/survival.lua:27:
 *
 *     sense = function(self, t) return math.floor(self:combatTalentScale(t, 5, 9)) end
 *
 * No curve argument, so `combatTalentScale`'s default power of 0.5 applies
 * (Combat.lua:1518) — which is what `combatTalentScale` here already does when
 * none is passed, so this is one line and it is upstream's.
 *
 * `Math.floor`, NOT `Math.round`, and that is upstream's too.
 *
 * ═══ AND BE EXACT ABOUT WHERE THEY DISAGREE, BECAUSE IT IS NOT WHERE THIS SAID
 * IT WAS ═══
 * This used to read *"rank 2 is 6.66 and the two rules disagree about it forever
 * after"*. Rank 2 is 6.34 and both rules give 6. Driven across the curve, the
 * two agree at EVERY WHOLE RANK — 5 / 6.34 / 7.37 / 8.24 / 9 — so no integer
 * talent level can tell them apart, and a test pinning ranks 1 to 5 would pin
 * nothing at all.
 *
 * THEY DISAGREE AT FRACTIONAL LEVELS, WHICH ARE REAL: `ActorTalents.lua:826`
 * multiplies raw points by category mastery, so a mastered rank 2 is talent
 * level 2.6 and `scale.ts` is explicit that the curve must never clamp it. At
 * 2.6 the value is 6.98 — floor 6, round 7 — and 1.5 and 2.5 split the same way.
 * That is the level `test/server/darkness.test.ts` pins, for this reason.
 */
const SENSE_LOW = 5;
const SENSE_HIGH = 9;

/** The radius at which this body can make out a creature outside its light. */
export function senseAt(level: number): number {
  return Math.floor(combatTalentScale(level, SENSE_LOW, SENSE_HIGH));
}

export const coldReading: Talent = {
  id: 'talent:cold_reading',
  name: 'Cold Reading',
  classId: ClassId.Inspector,
  tree: 'index/fieldcraft',
  /** Tier 1 of its tree. See `src/shared/tiers.ts`. */
  tier: 1,
  /** fieldcraft is about CUN. See `Talent.statGate`. */
  statGate: 'cun',
  kind: TalentKind.Passive,
  iconId: 'icon_passive_cold_reading',
  // A PASSIVE COSTS NOTHING TO HAVE. There is no moment at which it is paid for,
  // which is what the word means; `submitTalent` refuses it above the payment
  // block, so `canUseTalent` never runs against these zeroes.
  cooldownTurns: 0,
  /**
   * NEVER AIMED. `TargetShape.Self` at range 0, and `Affinity.Ally` because the
   * union has no self-only member and you are an ally of yourself — the reading
   * `iron_curtain.ts` already relies on. Every field here is a formality for a
   * talent that is never targeted; they are filled in honestly rather than left
   * to make a passive look aimable.
   */
  targeting: {
    shape: TargetShape.Self,
    range: 0,
    minRange: 0,
    radius: 0,
    requiresLos: false,
    affinity: Affinity.Ally,
  },
  damageType: DamageType.Physical,

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   *   DEFENCE FOR EACH ONE OF THEM. Ported from cunning/tactical.lua:30-60.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * This was a flat number, and as a flat number it was STRICTLY DOMINATED by
   * Light on the Feet — same stat, same curve, same point pool, larger figure.
   * Two talents on the panel and no reason to ever take this one.
   *
   * Upstream's Tactical Expert is `nb_foes * getDefense`, capped: defence that
   * exists only while you are surrounded. That is a different SHAPE rather than
   * a different number, and shape is what makes a choice. Light on the Feet is
   * better in a corridor; this is better in a doorway. Neither dominates, and a
   * player has something to decide.
   *
   * ═══ CAPPED, BECAUSE UPSTREAM CAPS IT ═══
   * Uncapped, this rewards standing in the middle of six husks — the exact
   * position the rest of the game teaches you to avoid. Past three, more company
   * should be a problem rather than a bonus.
   *
   * ═══ AND IT PAYS NOTHING WHEN YOU ARE ALONE, ON PURPOSE ═══
   * A conditional that still pays out when its condition is false is a flat
   * bonus wearing a costume. The fold runs every turn precisely so that "nothing"
   * is an answer it can give.
   */
  /**
   * TWO CHANNELS, AND ONLY ONE OF THEM IS CONDITIONAL.
   *
   * `senses` is UNCONDITIONAL — upstream writes it once in `passives` and it
   * never asks about the situation (cunning/survival.lua:35-40). The defence is
   * conditional for the reason above it: a conditional that pays out when its
   * condition is false is a flat bonus wearing a costume. So the empty-handed
   * return is no longer `{}`; a body alone in the dark still senses.
   */
  passive: (level, view) => {
    const foes = Math.min(ADJACENT_CAP, view.adjacentEnemies());
    const senses = senseAt(level);
    return foes === 0 ? { mods: { senses } } : { mods: { senses, def: perFoeAt(level) * foes } };
  },

  describe: (_self, level) =>
    `Always on. You make out a creature within ${String(senseAt(level))} tiles even in the dark, ` +
    `and gain +${String(perFoeAt(level))} defence for each enemy beside you, up to ` +
    `${String(ADJACENT_CAP)}.`,
};
