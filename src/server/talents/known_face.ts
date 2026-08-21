// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// SHAPE:   t-engine4 game/modules/tome/data/talents/cunning/tactical.lua
//          -- Tactical Expert, a passive whose figure is read off who is adjacent.
// NUMBERS: authored. Upstream counts FOES; this counts friends, for the reason
//          in the header.
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

/**
 * KNOWN FACE -- AUTHORITY.
 *
 * "People stand straighter when there is a uniform in the room. So does the
 * uniform."
 *
 * ═══ THE FIRST TALENT IN THIS GAME THAT PAYS FOR HAVING FRIENDS NEARBY ═══
 * `PassiveView.adjacentAllies` has existed since the view did and NOTHING has
 * ever called it. Every conditional in the game so far reads hostiles, health
 * or movement -- which is to say every one of them is about the fight, and none
 * is about the PARTY. This is a game for three to six friends in a voice
 * channel, and until now standing next to one of them was worth nothing
 * mechanically.
 *
 * ═══ IT IS SMALL, AND IT HAS TO BE ═══
 * A large bonus for huddling would make the correct play "everyone stand in one
 * square", which is both boring and exactly wrong for a game whose monsters have
 * an area attack. The figure is deliberately modest and CAPPED at two allies:
 * enough that a pair working a corridor feels different from two people in
 * different rooms, not enough to pay for a scrum.
 *
 * ═══ AND IT IS DEFENCE, NOT DAMAGE ═══
 * A damage bonus for grouping would push a party into the shape that dies to
 * one Alchemic Vial. Defence rewards the formation without rewarding the
 * cluster, because the thing that punishes a cluster is not being hit more
 * often -- it is being hit by the same blow.
 */

import { combatTalentScale } from '../../shared/scale.ts';
import { DamageType } from '../engine/damage.ts';
import { Affinity, ClassId, TalentKind, TargetShape, talentId } from '../engine/talents.ts';
import { EMPTY_PASSIVE_VIEW } from '../engine/hooks.ts';
import type { Talent } from '../engine/talents.ts';

/**
 * HOW MANY FRIENDS IT WILL COUNT. Two, and the cap is the balance lever rather
 * than the per-ally figure -- see the header on why a scrum must not pay.
 */
const MAX_ALLIES = 2;

const PER_ALLY_LOW = 2;
const PER_ALLY_HIGH = 7;
const CURVE = 0.75;

/** Defence per adjacent ally, at a rank. */
export function perAllyAt(level: number): number {
  return Math.round(combatTalentScale(level, PER_ALLY_LOW, PER_ALLY_HIGH, CURVE));
}

/** The most this can ever be worth, for the sentence the panel prints. */
export function maximumAt(level: number): number {
  return perAllyAt(level) * MAX_ALLIES;
}

export const knownFace: Talent = {
  id: talentId('known_face'),
  name: 'Known Face',
  classId: ClassId.Watchman,
  tree: 'watch/authority',
  /** Tier 1 of its tree. See `src/shared/tiers.ts`. */
  tier: 1,
  /** authority is about WIL. See `Talent.statGate`. */
  statGate: 'wil',
  kind: TalentKind.Passive,
  iconId: 'icon_passive_known_face',
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
    // ALONE IS NOTHING, which is what `EMPTY_PASSIVE_VIEW` answers and is the
    // honest reading for a solo character: there is nobody to stand straight in
    // front of.
    const friends = Math.min(MAX_ALLIES, view.adjacentAllies());
    if (friends <= 0) return {};
    return { mods: { def: perAllyAt(level) * friends, mentalResist: perAllyAt(level) * friends } };
  },

  describe: (_self, level) =>
    `Always on. ${String(perAllyAt(level))} defence and mental save for each friend standing next ` +
    `to you, up to ${String(MAX_ALLIES)} of them — ${String(maximumAt(level))} at most. ` +
    `Nothing at all when you are alone.`,
};
