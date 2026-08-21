// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// SHAPE:   t-engine4 game/modules/tome/data/talents/celestial/chants.lua -- the
//          chant tree's passives, which pay for HOLDING a stance rather than for
//          any particular one.
// NUMBERS: authored.
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

/**
 * CORROBORATION -- METHOD.
 *
 * "One witness is a story. Two is a fact."
 *
 * ═══ THE FIRST TALENT TO READ `PassiveView.isSustained` ═══
 * The view has answered this since it existed and nothing has asked, for the
 * simple reason that nothing in the game was a stance until this tree. It is
 * the shape upstream uses constantly: a talent that keys off your OWN sustains,
 * so a tree's passives are worth more to a character who has committed to it
 * than to one who dipped a point in.
 *
 * ═══ IT DOES NOT CARE WHICH METHOD ═══
 * Careful or Fast, it pays the same. Paying more for one would put a thumb on
 * the scale between two options that are deliberately equal, and the pair only
 * works as a decision while neither is the default.
 *
 * ═══ SAVES, WHICH IS THE CHANNEL THE INSPECTOR CANNOT OTHERWISE BUY ═══
 * Marksmanship is damage at range and Fieldcraft is getting away; between them
 * this class has almost nothing against a status that has already landed. That
 * is the hole this fills, and it fills it CONDITIONALLY -- an Inspector who
 * wants to be hard to stun has to be standing there working, which is exactly
 * the moment they are most vulnerable to one.
 */

import { combatTalentScale } from '../../shared/scale.ts';
import { DamageType } from '../engine/damage.ts';
import { Affinity, ClassId, TalentKind, TargetShape, talentId } from '../engine/talents.ts';
import { EMPTY_PASSIVE_VIEW } from '../engine/hooks.ts';
import { carefulMethod } from './careful_method.ts';
import { workingFast } from './working_fast.ts';
import type { Talent } from '../engine/talents.ts';

const SAVE_LOW = 5;
const SAVE_HIGH = 20;
const CURVE = 0.75;

/** Every save, while a method is up, at a rank. */
export function saveAt(level: number): number {
  return Math.round(combatTalentScale(level, SAVE_LOW, SAVE_HIGH, CURVE));
}

export const corroboration: Talent = {
  id: talentId('corroboration'),
  name: 'Corroboration',
  classId: ClassId.Inspector,
  tree: 'index/method',
  /** Tier 2 of its tree. See `src/shared/tiers.ts`. */
  tier: 2,
  /** method is about WIL. See `Talent.statGate`. */
  statGate: 'wil',
  kind: TalentKind.Passive,
  iconId: 'icon_passive_corroboration',
  cost: { ap: 0 },
  cooldownTurns: 0,
  targeting: {
    shape: TargetShape.Self,
    range: 0,
    minRange: 0,
    radius: 0,
    requiresLos: false,
    affinity: Affinity.Ally,
  },
  damageType: DamageType.Physical,

  passive: (level, view = EMPTY_PASSIVE_VIEW) => {
    // ASKED BY ID, BOTH OF THEM. Naming the two rather than reading the slot
    // because `PassiveView` answers about a TALENT and knows nothing about
    // slots — and because a third method arriving later should have to decide
    // for itself whether this pays for it.
    const working = view.isSustained(carefulMethod.id) || view.isSustained(workingFast.id);
    if (!working) return {};
    const save = saveAt(level);
    return { mods: { physResist: save, mentalResist: save, spellResist: save } };
  },

  describe: (_self, level) =>
    `Always on, while either method is up. ${String(saveAt(level))} to all three saves — ` +
    `the channel this class cannot otherwise buy, and you only have it while you are ` +
    `standing there working.`,
};
