// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// SHAPE:   t-engine4 game/modules/tome/data/talents/techniques/conditioning.lua:51-98
//          -- Vitality, the conditioning tree's regeneration talent.
// NUMBERS: authored, and deliberately small. See THE BAND below.
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

/**
 * WALK IT OFF -- NIGHTSHIFT, and the deepest thing in it.
 *
 * "Nothing a night and a bad breakfast will not fix."
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *   THE ONLY HEALING IN THIS GAME THAT IS NOT A CLASS'S JOB.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Mend Wounds is the Alchemist's, Field Dressing is the Alchemist's, and a
 * party without one has exactly the class regeneration its `hpRegen` grants and
 * nothing else. That makes the third seat a soft requirement, which is the one
 * thing a game for three-to-six friends must not have -- the party that shows up
 * is whoever is free tonight.
 *
 * This is everyone's answer, it is far worse than the Alchemist's, and both of
 * those are the point: a party with an Alchemist still wants the Alchemist, and
 * a party without one is not locked out of long nights on the moor.
 *
 * ═══ THE BAND IS SMALL AND IT IS THE THIRD THING I TRIED ═══
 * Regeneration is the most dangerous number in a turn-based game, because a
 * party that out-heals the floor can clear it with no risk by walking in
 * circles. Two guards, both structural rather than numeric:
 *
 *   IT IS PER GAME TURN, on the base clock, like `ClassDef.hpRegen` -- so it
 *   does not scale with how fast a character acts.
 *   IT IS A FLAT FIGURE, not a fraction of maximum health, so it does NOT grow
 *   with the life curve. At level 1 it is a meaningful fraction of 72 hit
 *   points; at level 50 it is a rounding error against 1,444, which is exactly
 *   the shape a safety net should have. A percentage would have made a
 *   level-50 character unkillable out of combat and, far worse, uninteresting.
 *
 * ═══ IT WRITES TO `hp`, WHICH ALMOST NOTHING DOES ═══
 * `HookSelf.hp` is mutable for this and for the handful of talents that will
 * follow it. Clamped to `maxHp` HERE rather than trusted to a caller: a body
 * reading 80/72 is a number no other part of this game can display, and the
 * clamp is one line against a bug that would appear as a rendering fault three
 * subsystems away.
 */

import { combatTalentScale } from '../../shared/scale.ts';
import { DamageType } from '../engine/damage.ts';
import { Affinity, TalentKind, TargetShape } from '../engine/talents.ts';
import type { Talent } from '../engine/talents.ts';

const LOW = 1;
const HIGH = 5;
const CURVE = 0.75;

/** Hit points regained per game turn, at a rank. */
export function regenAt(level: number): number {
  return Math.max(1, Math.round(combatTalentScale(level, LOW, HIGH, CURVE)));
}

export const walkItOff: Talent = {
  id: 'talent:walk_it_off',
  name: 'Walk It Off',
  classId: null,
  tree: 'generic/nightshift',
  /** Tier 3 of its tree. See `src/shared/tiers.ts`. */
  tier: 3,
  kind: TalentKind.Passive,
  iconId: 'icon_passive_walk_it_off',
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

  hooks: {
    onTurnStart: (ctx) => {
      // A CORPSE DOES NOT MEND. `onTurnStart` fires on the base clock and the
      // Downed system keeps a body on the board at 0 -- without this, a downed
      // character would quietly heal themselves off the floor and the rescue
      // rules would have a second, invisible exit.
      if (!ctx.self.alive || ctx.self.hp <= 0) return;
      ctx.self.hp = Math.min(ctx.self.maxHp, ctx.self.hp + regenAt(ctx.level));
    },
  },

  describe: (_self, level) =>
    `Always on. You recover ${String(regenAt(level))} hit points at the start of each turn. ` +
    `A flat figure, so it matters most early and least at the cap — and never while you are down.`,
};
