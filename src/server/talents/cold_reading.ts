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
  passive: (level, view) => {
    const foes = Math.min(ADJACENT_CAP, view.adjacentEnemies());
    return foes === 0 ? {} : { mods: { def: perFoeAt(level) * foes } };
  },

  describe: (_self, level) =>
    `Always on. +${String(perFoeAt(level))} defence for each enemy beside you, up to ` +
    `${String(ADJACENT_CAP)}. Nothing when you are alone.`,
};
