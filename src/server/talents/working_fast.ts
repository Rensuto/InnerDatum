// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// SHAPE:   t-engine4 game/modules/tome/data/talents/celestial/chants.lua:31 and
//          class/Actor.lua:5922-5931 -- see `careful_method.ts`, which carries
//          the whole argument for the pair.
// NUMBERS: authored.
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

/**
 * WORKING FAST -- METHOD, and the other half of a decision.
 *
 * "The scene is going to be gone in ten minutes. Move."
 *
 * ═══ THE SAME SLOT AS `careful_method`, WHICH IS THE ENTIRE POINT ═══
 * Two stances, one slot, so an Inspector is always working a scene one way or
 * the other and never both. `toggleSustain` DISPLACES rather than refusing
 * (Actor.lua:5922-5931), so changing your mind is one press.
 *
 * ═══ THE TWO ARE NOT BETTER AND WORSE, THEY ARE FOR DIFFERENT ROOMS ═══
 * Careful Method is accuracy and crit: it wants a single hard target you have
 * time to work on, which is the Inspector at their best. This is defence and
 * damage-rating: it wants a room that is already going wrong, where you are
 * being closed on and what matters is that every shot counts and that you are
 * harder to reach.
 *
 * Measured, that is not a hypothetical for this class. `tools/first-fight.mjs`
 * has the Inspector STALLING two openings in twenty-four at twenty-three turns
 * apiece -- kiting a thing it cannot kill fast enough. This is the stance for
 * that fight, and Line of Enquiry in the same tree is the button for it.
 *
 * ═══ WHY THE SAME RESERVE ═══
 * Both hold twenty Focus. A cheaper stance would be the default one, and the
 * pair would collapse into "the good one and the other one" -- which is the
 * failure mode of every two-option system that prices them differently for no
 * stated reason.
 */

import { combatTalentScale } from '../../shared/scale.ts';
import { DamageType } from '../engine/damage.ts';
import { Affinity, ClassId, TalentKind, TargetShape, talentId } from '../engine/talents.ts';
import { METHOD_SLOT } from './careful_method.ts';
import type { Talent } from '../engine/talents.ts';

/** THE SAME AS ITS TWIN'S. See the header. */
const RESERVE = 20;

const DEF_LOW = 5;
const DEF_HIGH = 20;
const CURVE = 0.75;

/** Defence while this is up, at a rank. */
export function defenceAt(level: number): number {
  return Math.round(combatTalentScale(level, DEF_LOW, DEF_HIGH, CURVE));
}

const DAM_LOW = 3;
const DAM_HIGH = 13;

/** Damage rating while this is up, at a rank. */
export function damageAt(level: number): number {
  return Math.round(combatTalentScale(level, DAM_LOW, DAM_HIGH, CURVE));
}

export const workingFast: Talent = {
  id: talentId('working_fast'),
  name: 'Working Fast',
  classId: ClassId.Inspector,
  tree: 'index/method',
  /** Tier 1 of its tree. See `src/shared/tiers.ts`. */
  tier: 1,
  /** method is about WIL. See `Talent.statGate`. */
  statGate: 'wil',
  kind: TalentKind.Sustained,
  iconId: 'icon_sustain_working_fast',
  // FREE TO PRESS — `careful_method.ts` carries the reason.
  cost: { ap: 0 },
  cooldownTurns: 0,
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

  passive: (level) => ({ mods: { def: defenceAt(level), dam: damageAt(level) } }),

  describe: (_self, level) =>
    `A stance. While it is up: ${String(defenceAt(level))} defence and ` +
    `${String(damageAt(level))} damage. Holds ${String(RESERVE)} Focus in reserve, ` +
    `and puts Careful Method down.`,
};
