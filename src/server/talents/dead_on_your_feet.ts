// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// SHAPE:   t-engine4 game/modules/tome/data/talents/techniques/conditioning.lua:23-49
//          -- True Grit, the conditioning tree's stay-upright talent.
// NUMBERS: authored. Upstream's is a heal on a cooldown; this is a floor on one
//          blow a turn, which is the same promise made in a way this engine can
//          keep synchronously.
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

/**
 * DEAD ON YOUR FEET -- NIGHTSHIFT.
 *
 * "You will find out how bad it was tomorrow."
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *   THE SECOND TALENT IN THIS GAME THAT CHANGES A RULE RATHER THAN A NUMBER.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * One blow per turn cannot take this body below one hit point. Not damage
 * reduction, not a heal -- a FLOOR, and a floor is worth exactly nothing until
 * the moment it is worth everything, which is the most interesting shape a
 * defensive talent can have.
 *
 * ═══ WHY IT IS NOT AN IMMORTALITY BUTTON ═══
 * Three things bound it, and all three are deliberate:
 *
 *   ONCE A TURN. `procs.once` keyed on this talent's own id, so a second blow
 *   in the same turn kills normally. Against one heavy attacker it is a
 *   reprieve; against four husks it buys one of the four.
 *
 *   IT DOES NOT HEAL. You are left at 1, which is a worse place to be than
 *   wherever you were -- and every talent in this tree that scales on missing
 *   health is at its strongest there, which is what makes the tree cohere.
 *
 *   IT HAS A FLOOR OF ITS OWN. Below a rank-scaled threshold of health it does
 *   not fire at all: it saves a body that was standing, not one that was
 *   already gone. A talent that always fired would make the last quarter of a
 *   health bar meaningless, which is the part of it that matters most.
 *
 * ═══ AND IT IS WHY `HookSelf.hp` IS READABLE ═══
 * The hook needs to know what this blow would leave, which means reading the
 * body mid-resolution. That is safe here for the reason everything in this
 * engine is safe: turn resolution is synchronous, so nothing can move between
 * the read and the edit.
 */

import { combatTalentScale } from '../../shared/scale.ts';
import { DamageType } from '../engine/damage.ts';
import { Affinity, TalentKind, TargetShape } from '../engine/talents.ts';
import type { Talent } from '../engine/talents.ts';

/**
 * HOW HURT IS TOO HURT FOR IT TO FIRE, as a fraction of maximum health.
 *
 * A HIGHER RANK REACHES FURTHER DOWN: 25% at rank 1 falling to 5% at rank 5, so
 * the first point saves you from a blow that lands while you are still in the
 * fight and the fifth saves you from very nearly the last one.
 */
const FLOOR_HIGH = 0.25;

/** The house curve, matching every other talent in this tree. */
const CURVE = 0.75;

/** Percent, for the sentence the panel prints. */
const AS_PERCENT = 100;
const FLOOR_LOW = 0.05;

/** The lowest health fraction this still fires at, at a rank. */
export function thresholdAt(level: number): number {
  // INVERTED BAND: `combatTalentScale` climbs, and this figure falls, so the
  // band is walked from the top. Spelled out rather than negated because a
  // negative band silently produces a curve nobody meant.
  const climbed = combatTalentScale(level, 0, FLOOR_HIGH - FLOOR_LOW, CURVE);
  return Math.max(FLOOR_LOW, FLOOR_HIGH - climbed);
}

export const deadOnYourFeet: Talent = {
  id: 'talent:dead_on_your_feet',
  name: 'Dead on Your Feet',
  classId: null,
  tree: 'generic/nightshift',
  /** Tier 2 of its tree. See `src/shared/tiers.ts`. */
  tier: 2,
  kind: TalentKind.Passive,
  iconId: 'icon_passive_dead_on_your_feet',
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
    onTakeDamage: (ctx, incoming) => {
      // NOT A KILLING BLOW: nothing to do, and the latch is NOT spent. Spending
      // it on a scratch would let a husk disarm this by hitting first.
      if (incoming.dam < ctx.self.hp) return;
      // ALREADY TOO FAR GONE. See `thresholdAt` -- this saves a body that was
      // standing, not one that was already on the floor.
      if (ctx.self.hp < ctx.self.maxHp * thresholdAt(ctx.level)) return;
      if (!ctx.procs.once('talent:dead_on_your_feet')) return;
      // ONE SHORT OF WHAT WOULD KILL. Expressed as an edit to the FIGURE rather
      // than a write to `hp`, so every downstream reader -- the log line, the
      // damage frame, the on-deal hooks of whoever swung -- sees one consistent
      // number instead of a blow that reported more than it did.
      return { dam: Math.max(0, ctx.self.hp - 1) };
    },
  },

  describe: (_self, level) =>
    `Always on. Once each turn, a blow that would kill you leaves you on 1 instead — ` +
    `but only while you are above ${String(Math.round(thresholdAt(level) * AS_PERCENT))}% health. ` +
    `It does not heal you.`,
};
