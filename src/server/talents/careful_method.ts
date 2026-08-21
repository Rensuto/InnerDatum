// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// SHAPE:   t-engine4 game/modules/tome/data/talents/celestial/chants.lua:31
//          -- `sustain_positive = 20`: a stance takes a fixed bite out of the
//          POOL'S CEILING for as long as it is up.
//          t-engine4 game/modules/tome/class/Actor.lua:5922-5931 -- a slot
//          DISPLACES rather than refusing.
// NUMBERS: authored.
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

/**
 * CAREFUL METHOD -- METHOD, and the FIRST SUSTAINED TALENT IN THIS GAME.
 *
 * "Measure. Photograph. Then touch it."
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *   THE WHOLE STANCE SYSTEM WAS BUILT AND NOTHING COULD REACH IT.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `Talent.sustain`, `Talent.sustainSlot`, `toggleSustain` with its careful
 * displace-then-test ordering, `TalentSheet.sustained`, the passive fold's
 * `[...sheet.passives, ...sheet.sustained]`, `PassiveView.isSustained`, the
 * gateway's toggle branch and `LoadoutTalent.sustained` on the wire -- all of
 * it shipped, all of it correct, and `TalentKind.Sustained` said so out loud:
 * *"Nothing implements this yet."* Forty-eight talents, zero stances.
 *
 * That is the third time this codebase has carried a finished system nobody
 * had authored content for (see `Talent.tier`, and `monsterInit`'s level
 * parameter). It is worth naming as a pattern rather than a coincidence.
 *
 * ═══ WHAT A STANCE COSTS IS ROOM, NOT FOCUS ═══
 * `sustain.reserve` comes off the POOL'S CEILING while it is up, and comes
 * back when it goes down. That is upstream's trade exactly and it is a better
 * one than a per-turn drain: a stance does not run out, it makes everything
 * else you do that fight a little tighter. An Inspector holding a method has
 * fewer Sniper's Marks in them, and choosing which is the game.
 *
 * ═══ AND IT SHARES A SLOT WITH `working_fast` ═══
 * `sustainSlot: 'method'`, so raising one lowers the other. You are working
 * this scene one way or the other; there is no way to be doing both, and
 * upstream's own slot rule DISPLACES rather than refusing so that changing
 * your mind is one press instead of two.
 */

import { combatTalentScale } from '../../shared/scale.ts';
import { DamageType } from '../engine/damage.ts';
import { Affinity, ClassId, TalentKind, TargetShape, talentId } from '../engine/talents.ts';
import type { Talent } from '../engine/talents.ts';

/**
 * WHAT IT TAKES OFF THE CEILING. Focus is a 0-100 pool, so this is a fifth of
 * it -- enough that an Inspector notices, small enough that holding a stance
 * is not the same as giving up their signature.
 *
 * FLAT ACROSS RANKS, deliberately: upstream's `sustain_positive` is a constant
 * too. A reservation that shrank as you levelled would make the deep ranks
 * strictly better rather than a trade, and the trade is the point.
 */
const RESERVE = 20;

/** Both methods answer to the same slot. See the header. */
export const METHOD_SLOT = 'method';

const ATK_LOW = 6;
const ATK_HIGH = 24;
const CURVE = 0.75;

/** Accuracy while this is up, at a rank. */
export function accuracyAt(level: number): number {
  return Math.round(combatTalentScale(level, ATK_LOW, ATK_HIGH, CURVE));
}

const CRIT_LOW = 3;
const CRIT_HIGH = 12;

/** Physical crit chance while this is up, at a rank. */
export function critAt(level: number): number {
  return Math.round(combatTalentScale(level, CRIT_LOW, CRIT_HIGH, CURVE));
}

export const carefulMethod: Talent = {
  id: talentId('careful_method'),
  name: 'Careful Method',
  classId: ClassId.Inspector,
  tree: 'index/method',
  /** Tier 1 of its tree. See `src/shared/tiers.ts`. */
  tier: 1,
  /** method is about WIL. See `Talent.statGate`. */
  statGate: 'wil',
  kind: TalentKind.Sustained,
  iconId: 'icon_sustain_careful_method',
  /**
   * FREE TO PRESS. A stance pays in `sustain.reserve` and pays nothing else --
   * charging AP as well would mean putting one up costs a turn's action, and a
   * player would simply never change stance mid-fight, which is the one moment
   * the choice is interesting.
   */
  cost: { ap: 0 },
  cooldownTurns: 0,
  /** PRESENT IS WHAT MAKES IT A STANCE. See `Talent.sustain`. */
  sustain: { reserve: RESERVE },
  sustainSlot: METHOD_SLOT,
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
   * THE CONTRIBUTION COMES FROM `passive`, WHICH IS THE DESIGN. A sustain IS a
   * passive you can switch off -- same shape, same fold, same
   * `PassiveContribution` gear and talents already stack through. The fold
   * reads `sheet.sustained`, so this is worth nothing while the stance is down
   * without a single conditional here.
   */
  passive: (level) => ({ mods: { atk: accuracyAt(level), physCrit: critAt(level) } }),

  describe: (_self, level) =>
    `A stance. While it is up: ${String(accuracyAt(level))} accuracy and ` +
    `${String(critAt(level))}% critical chance. Holds ${String(RESERVE)} Focus in reserve, ` +
    `and puts Working Fast down.`,
};
