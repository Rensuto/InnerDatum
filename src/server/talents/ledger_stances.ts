// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// SHAPE:   t-engine4 game/modules/tome/data/talents/misc/misc.lua — two sustains
//          on one exclusive slot, where putting one up puts the other down and
//          the choice is the talent rather than either half of it.
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license
//
// TWO TALENTS IN ONE FILE, WHICH IS THE EXCEPTION THE ROSTER NOTE ALLOWS FOR A
// STANCE PAIR — `loads.ts` is the precedent. They share `SHARED` below and they
// share a slot, and splitting them would put the two halves of one decision in
// two places where a reader has to hold both to understand either.

import { combatTalentScale } from '../../shared/scale.ts';
import { DamageType } from '../engine/damage.ts';
import { Affinity, ClassId, TalentKind, TargetShape, talentId } from '../engine/talents.ts';
import type { Talent } from '../engine/talents.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE TWO STANCES OF THE LEDGER — how you are holding the book open.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ═══ THE RESERVE IS THE WHOLE TENSION, AND ONLY THIS CLASS FEELS IT ═══
 * A stance costs `sustain.reserve` — resource held back and unspendable while it
 * is up. For an Inspector that is Focus she was not going to spend anyway.
 *
 * For a Redactor it is Ink, and Ink is the thing marks are made of. Standing in
 * a stance means being able to put fewer marks on things, and putting fewer
 * marks on things means earning less Ink (`INK_PER_MARK` pays per mark landed).
 * So a stance here is a genuine bet: it makes each mark better, or it makes YOU
 * harder to unwrite, at the price of making the next mark harder to afford.
 *
 * That is a decision no other class in this game has to make, and it exists
 * because the resource is earned rather than granted.
 *
 * ═══ ONE SLOT, TWO ANSWERS ═══
 * `index/method` established the shape: two sustains sharing a `sustainSlot`, so
 * raising one lowers the other and there is never a build that simply has both.
 * The two here answer opposite questions — am I writing, or am I being written
 * at — and a Redactor who never switches is playing one of them badly.
 */

/**
 * THE SLOT. Both stances name it, which is what makes them exclusive — see
 * `Talent.sustainSlot`.
 */
const LEDGER_SLOT = 'ledger/standing';

/**
 * Ink held back while a stance is up.
 *
 * TUNED AGAINST `strike_out.ts`'s 8, NOT AGAINST THE 100 CEILING. A reserve
 * that left room for two marks would be free; one that left room for none would
 * mean no Redactor ever stands in a stance during a fight. 20 costs a little
 * over two Strike Outs of headroom, which is a price a player can feel without
 * being locked out of their own class.
 */
const RESERVE = 20;

const SHARED = {
  classId: ClassId.Redactor,
  tree: 'ledger/testimony',
  /** Tier 1 of its tree. See `src/shared/tiers.ts`. */
  tier: 1,
  /** testimony is about WIL. See `Talent.statGate`. */
  statGate: 'wil',
  kind: TalentKind.Sustained,
  /**
   * FREE TO PRESS, for the reason `careful_method.ts` states: a stance pays in
   * its reserve and pays nothing else, because charging AP as well would mean
   * changing stance costs a turn's action and nobody would ever do it mid-fight
   * — which is the one moment the choice is interesting.
   */
  cost: { ap: 0 },
  cooldownTurns: 0,
  sustain: { reserve: RESERVE },
  sustainSlot: LEDGER_SLOT,
  targeting: {
    shape: TargetShape.Self,
    range: 0,
    minRange: 0,
    radius: 0,
    requiresLos: false,
    affinity: Affinity.Ally,
  },
  damageType: DamageType.Darkness,
} as const;

// ---------------------------------------------------------------------------
// OPEN LEDGER — writing
// ---------------------------------------------------------------------------

/** Points of power, which for this class is what makes marks land. See `indelible.ts`. */
const OPEN_POWER_LOW = 4;
const OPEN_POWER_HIGH = 14;

function openPowerAt(talentLevel: number): number {
  return Math.round(combatTalentScale(talentLevel, OPEN_POWER_LOW, OPEN_POWER_HIGH));
}

/**
 * OPEN LEDGER — the book is out and you are writing in it.
 *
 * `genericPower` for the reason `indelible.ts` sets out at length: it is the
 * only additive field that reaches `combatMindpower`, because `AdditiveMods`
 * omits all three school powers by construction (content/items.ts:217).
 *
 * STACKS WITH INDELIBLE, and that is intended rather than overlooked. Indelible
 * is always on and this is a bet that costs Ink; a class whose two power sources
 * cancelled would be a class where the stance is never worth pressing.
 */
export const openLedger: Talent = {
  ...SHARED,
  id: talentId('open_ledger'),
  name: 'Open Ledger',
  iconId: 'icon_sustain_open_ledger',

  passive: (level) => ({ mods: { genericPower: openPowerAt(level) } }),

  describe: (_self, level) =>
    `A stance. While it is up your marks go in with ${String(openPowerAt(level))} more power. ` +
    `Holds ${String(RESERVE)} Ink in reserve — the Ink you are not writing with — and puts ` +
    `Closed Ledger down.`,
};

// ---------------------------------------------------------------------------
// CLOSED LEDGER — being written at
// ---------------------------------------------------------------------------

/** Points of mental and spell save. */
const CLOSED_SAVE_LOW = 5;
const CLOSED_SAVE_HIGH = 16;

function closedSaveAt(talentLevel: number): number {
  return Math.round(combatTalentScale(talentLevel, CLOSED_SAVE_LOW, CLOSED_SAVE_HIGH));
}

/**
 * CLOSED LEDGER — the book is shut and you are holding it against your chest.
 *
 * ═══ MENTAL AND SPELL, NOT PHYSICAL, AND THE GAP IS THE POINT ═══
 * A Redactor in this stance is hard to confuse and hard to overwrite and no
 * harder at all to hit with a stick. That is the class's shape defensively: it
 * has no armour answer and is not getting one, because a controller who could
 * also stand in the front rank would have no reason to stand anywhere else.
 *
 * The stance is for the fights where something is marking YOU — which is
 * exactly what the Overwritten Husk does with `breaching_blow.ts`, and exactly
 * what `EFFACED` was written for before any player class could apply it.
 */
export const closedLedger: Talent = {
  ...SHARED,
  id: talentId('closed_ledger'),
  name: 'Closed Ledger',
  iconId: 'icon_sustain_closed_ledger',

  passive: (level) => ({
    mods: { mentalResist: closedSaveAt(level), spellResist: closedSaveAt(level) },
  }),

  describe: (_self, level) =>
    `A stance. While it is up: ${String(closedSaveAt(level))} mental save and ` +
    `${String(closedSaveAt(level))} spell save. Nothing here helps against a stick. ` +
    `Holds ${String(RESERVE)} Ink in reserve and puts Open Ledger down.`,
};
