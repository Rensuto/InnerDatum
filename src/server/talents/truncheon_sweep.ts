// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// NUMBERS: t-engine4 game/modules/tome/data/talents/techniques/2hweapon.lua:22-58
//          Death Dance -- radius 1 ball, selffire=false, cooldown 10,
//          combatTalentWeaponDamage(t, 1.4, 2.1).
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

/**
 * TRUNCHEON SWEEP -- the Watchman, in Discipline.
 *
 * "One arc, waist height. It is not elegant and it is not meant to be."
 *
 * ═══ THE FIRST TALENT IN THE GAME THAT ANSWERS BEING SURROUNDED ═══
 * Every melee talent this class had struck ONE body. Standing in a doorway with
 * three things on you, the Watchman's whole answer was to hit one of them and
 * take the other two -- which makes the position he is built to hold the
 * position he is worst in. Death Dance is upstream's answer to the same problem
 * on the same kind of character, and it lands on the same tiles: `radius = 1`,
 * `selffire = false`.
 *
 * ═══ IT IS `TargetShape.Self`, WHICH IS NOT A CONTRADICTION ═══
 * The player aims nothing -- the arc is around the body, so there is no tile to
 * pick. `Self` is what makes the client send it IMMEDIATELY instead of opening a
 * targeting ring (`activateSlot` branches on exactly that), and an aim that
 * cannot be aimed is a ring the player has to dismiss before the thing happens.
 * The RADIUS still travels on the wire so the panel can describe it.
 *
 * ═══ WHY IT IS WEAKER PER BODY THAN CRUDE BLOW ═══
 * Upstream pays 1.4-2.1 for this because a two-hander swinging at a crowd is the
 * berserker's whole identity. The Watchman is a guard: the sweep is the answer
 * to being surrounded, not a better opener, so the band sits UNDER Crude Blow's
 * per-target damage and only pays off past two bodies. A talent that beat the
 * at-will attack one-on-one would simply replace it.
 */

import { combatTalentScale } from '../../shared/scale.ts';
import { DamageType } from '../engine/damage.ts';
import {
  Affinity,
  ClassId,
  TalentKind,
  TargetShape,
  actorsInShape,
  ballTiles,
  talentAttack,
  talentDone,
  talentId,
} from '../engine/talents.ts';
import type { Talent, TalentHit } from '../engine/talents.ts';
import { percent } from '../engine/talents.ts';

const AP_COST = 4;
const COOLDOWN = 4;
/** One tile out, which is every neighbour including the diagonals. */
const RADIUS = 1;
/** Under Crude Blow per body -- see the header. */
const MULT_LOW = 0.6;
const MULT_HIGH = 1.0;

/** The one place this talent's curve is written. */
function damageMult(talentLevel: number): number {
  return combatTalentScale(talentLevel, MULT_LOW, MULT_HIGH);
}

export const truncheonSweep: Talent = {
  id: talentId('truncheon_sweep'),
  name: 'Truncheon Sweep',
  classId: ClassId.Watchman,
  tree: 'watch/discipline',
  /** Tier 2 of its tree. See `src/shared/tiers.ts`. */
  tier: 2,
  /** discipline is about STR. See `Talent.statGate`. */
  statGate: 'str',
  kind: TalentKind.Active,
  iconId: 'icon_active_truncheon_sweep',
  cost: { ap: AP_COST },
  cooldownTurns: COOLDOWN,
  targeting: {
    shape: TargetShape.Self,
    range: 0,
    minRange: 0,
    radius: RADIUS,
    requiresLos: false,
    affinity: Affinity.Hostile,
  },
  damageType: DamageType.Physical,

  onUse: (ctx, self) => {
    const tiles = ballTiles({ x: self.x, y: self.y }, RADIUS);
    // `Affinity.Hostile` is what keeps the party out of it, the same way the
    // vial's cross does. A sweep that caught the person you are standing in
    // front of would be a trap rather than a talent.
    const victims = actorsInShape(ctx.world, self, tiles, Affinity.Hostile);

    const mult = damageMult(ctx.talentLevel);
    const hits: TalentHit[] = [];
    for (const victim of victims) {
      hits.push(talentAttack(ctx, self, victim, { mult }));
    }

    // An arc through empty air still costs the AP and still goes on cooldown --
    // the refund rule covers intents that went ILLEGAL, not bets that went bad.
    return talentDone(hits, [`Sweep. ${String(hits.length)} caught.`]);
  },

  describe: (_self, level) =>
    `Swing at every enemy standing next to you for ${percent(damageMult(level))} weapon ` +
    `damage each. Allies are never hit. ${String(AP_COST)} AP, ${String(COOLDOWN)}-turn cooldown.`,
};
