// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// SHAPE:   t-engine4 game/modules/tome/data/talents/techniques/archery-utility.lua
//          -- the archer's distance talents, which pay for the range the class
//          is trying to keep.
// NUMBERS: authored.
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

/**
 * COLD CASE -- METHOD.
 *
 * "The ones you solve are the ones you were never in the room for."
 *
 * ═══ IT PAYS FOR THE THING THE CLASS IS ALREADY TRYING TO DO ═══
 * The Inspector's whole shape is reaching what has not reached you. Every
 * number they own is a number about a shot; NONE of them has ever cared how far
 * away the shot was, so a class defined by distance had no mechanical reason to
 * keep any. This is that reason.
 *
 * ═══ AND IT IS THE MIRROR OF THE WATCHMAN'S `one_at_a_time` ═══
 * That one pays while exactly one thing is in reach — the doorway. This pays
 * while nothing is near — the roofline. Two classes, two opposite readings of
 * the same view method, and a party that has both is a party fighting in two
 * places on purpose, which is the whole of what a co-op roguelike positioning
 * system is for.
 *
 * ═══ A FLOOR, NOT A SLOPE ═══
 * "More damage the further away" scales without bound on a big map and makes
 * the correct play "stand in the far corner and never move", which is not a
 * fight. A threshold pays once, at a distance the class has to actually
 * maintain against things walking at it, and stops there.
 */

import { combatTalentScale } from '../../shared/scale.ts';
import { DamageType } from '../engine/damage.ts';
import { Affinity, ClassId, TalentKind, TargetShape, talentId } from '../engine/talents.ts';
import { EMPTY_PASSIVE_VIEW } from '../engine/hooks.ts';
import type { Talent } from '../engine/talents.ts';

/**
 * HOW FAR IS FAR ENOUGH. Four tiles is past every melee reach in the game and
 * one short of the Inspector's own comfortable range, so it is a distance they
 * have to hold rather than one they start at.
 */
const FAR = 4;

const DAM_LOW = 5;
const DAM_HIGH = 20;
const CURVE = 0.75;

/** Damage rating while nothing is close, at a rank. */
export function damageAt(level: number): number {
  return Math.round(combatTalentScale(level, DAM_LOW, DAM_HIGH, CURVE));
}

const CRIT_LOW = 4;
const CRIT_HIGH = 15;

/** Critical damage while nothing is close, at a rank. */
export function criticalAt(level: number): number {
  return Math.round(combatTalentScale(level, CRIT_LOW, CRIT_HIGH, CURVE));
}

export const coldCase: Talent = {
  id: talentId('cold_case'),
  name: 'Cold Case',
  classId: ClassId.Inspector,
  tree: 'index/method',
  /** Tier 3 of its tree. See `src/shared/tiers.ts`. */
  tier: 3,
  /** method is about WIL. See `Talent.statGate`. */
  statGate: 'wil',
  kind: TalentKind.Passive,
  iconId: 'icon_passive_cold_case',
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
    /**
     * `Infinity` — NOTHING ALIVE ON THE BOARD — COUNTS AS FAR, and that is the
     * honest reading rather than a loophole: there is nothing near you. It also
     * costs nothing, because a talent's contribution only matters when
     * something is being hit, and if nothing is alive nothing is being hit.
     */
    if (view.nearestEnemyDistance() < FAR) return {};
    return { mods: { dam: damageAt(level), criticalPower: criticalAt(level) } };
  },

  describe: (_self, level) =>
    `Always on, while nothing living is within ${String(FAR)} tiles of you. ` +
    `${String(damageAt(level))} damage and ${String(criticalAt(level))}% critical damage. ` +
    `The reason to keep the distance this class is built for.`,
};
