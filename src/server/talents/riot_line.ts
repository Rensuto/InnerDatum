// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// SHAPE:   t-engine4 game/modules/tome/data/talents/techniques/shield-defense.lua
//          -- the shield tree's damage-eating talents, which intercept a blow
//          rather than adding to a resistance.
// NUMBERS: authored.
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

/**
 * RIOT LINE -- AUTHORITY.
 *
 * "Nobody in a line gets hit as hard as a man on his own. That is the entire
 * theory of the line."
 *
 * ═══ THE PARTY VERSION OF UNFLINCHING, AND A DIFFERENT SHAPE ═══
 * Unflinching blunts the first blow of every turn unconditionally. This blunts
 * it only while somebody is standing next to you, and it blunts it harder --
 * so the two are a real choice rather than a strict ordering, and the one you
 * want depends on how your friends play rather than on a number.
 *
 * It is the second half of `Known Face` and deliberately a different KIND of
 * thing: Known Face is defence, which is about being missed, and this is
 * mitigation, which is about being hit and minding less. A tree whose two
 * passives both raised defence would be one passive sold twice.
 *
 * ═══ WHY IT READS THE HOOK RATHER THAN THE PASSIVE ═══
 * `passive` can only add to the sheet, and a flat `physResist` for standing
 * near a friend is exactly the increment this tree exists to avoid. Blunting a
 * specific blow is a rule, and rules are what `hooks` are for.
 *
 * ═══ AND WHY THE ADJACENCY CHECK IS NOT IN THE HOOK ═══
 * `HookCtx` carries the body, the level and the latch -- no board. So the
 * ADJACENCY half lives in `passive`, which does get a view, and it writes the
 * answer nowhere: instead the passive contributes the mitigation as a resist
 * and the hook is not used at all.
 *
 * That was the third design and the first two were worse. Stated plainly
 * because the constraint is real and the next talent will hit it: a hook cannot
 * see the board, a passive cannot change a rule, and a talent that wants both
 * has to pick which half matters more. Here it is the condition, so this is a
 * passive -- but it contributes to `armourHardiness` as well as `physResist`,
 * which is the closest the sheet vocabulary gets to "the blow lands softer"
 * rather than "there is less of it".
 */

import { combatTalentScale } from '../../shared/scale.ts';
import { DamageType } from '../engine/damage.ts';
import { Affinity, ClassId, TalentKind, TargetShape, talentId } from '../engine/talents.ts';
import { EMPTY_PASSIVE_VIEW } from '../engine/hooks.ts';
import type { Talent } from '../engine/talents.ts';

const RESIST_LOW = 4;
const RESIST_HIGH = 15;
const CURVE = 0.75;

/** Physical save while a friend is beside you, at a rank. */
export function resistAt(level: number): number {
  return Math.round(combatTalentScale(level, RESIST_LOW, RESIST_HIGH, CURVE));
}

const ARMOUR_LOW = 3;
const ARMOUR_HIGH = 11;

/** Armour while a friend is beside you, at a rank. */
export function armourAt(level: number): number {
  return Math.round(combatTalentScale(level, ARMOUR_LOW, ARMOUR_HIGH, CURVE));
}

export const riotLine: Talent = {
  id: talentId('riot_line'),
  name: 'Riot Line',
  classId: ClassId.Watchman,
  tree: 'watch/authority',
  /** Tier 3 of its tree. See `src/shared/tiers.ts`. */
  tier: 3,
  /** authority is about WIL. See `Talent.statGate`. */
  statGate: 'wil',
  kind: TalentKind.Passive,
  iconId: 'icon_passive_riot_line',
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
     * ONE FRIEND IS ENOUGH AND A SECOND ADDS NOTHING, which is the difference
     * between this and Known Face on purpose. Known Face pays per body and
     * rewards a formation; this pays for not being ALONE, and a talent that
     * scaled with the crowd would make both of them the same talent and push a
     * party into the shape that dies to one area attack.
     */
    if (view.adjacentAllies() < 1) return {};
    return { mods: { physResist: resistAt(level), armour: armourAt(level) } };
  },

  describe: (_self, level) =>
    `Always on, while at least one friend is next to you. ${String(resistAt(level))} physical ` +
    `save and ${String(armourAt(level))} armour. One friend is enough — a second adds nothing, ` +
    `so this pays for not standing alone rather than for standing in a crowd.`,
};
