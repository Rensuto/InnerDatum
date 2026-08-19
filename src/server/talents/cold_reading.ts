// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// SHAPE:   t-engine4 game/modules/tome/data/talents/chronomancy/chronomancy.lua:52-63
//          Foresight — `mode = "passive"`, `talentTemporaryValue(p, "combat_def", ...)`
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

export const coldReading: Talent = {
  id: 'talent:cold_reading',
  name: 'Cold Reading',
  classId: ClassId.Inspector,
  tree: 'index/fieldcraft',
  kind: TalentKind.Passive,
  iconId: 'icon_passive_cold_reading',
  // A PASSIVE COSTS NOTHING TO HAVE. There is no moment at which it is paid for,
  // which is what the word means; `submitTalent` refuses it above the payment
  // block, so `canUseTalent` never runs against these zeroes.
  cost: { ap: 0 },
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

  passive: (level) => ({ mods: { def: defenceAt(level) } }),

  describe: (_self, level) =>
    `Always on. You are ${String(defenceAt(level))} harder to hit, before anything you wear.`,
};
