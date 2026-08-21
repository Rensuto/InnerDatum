// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// SHAPE:   t-engine4 game/modules/tome/data/talents/cunning/dirty.lua -- a
//          generic category a class does NOT open with, bought later with a
//          category point (`{false, 0}` on a Bulwark, warrior.lua:147).
// NUMBERS: authored.
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *   LEVERAGE — WHERE A THING COMES APART. THE FIRST LOCKED TREE IN THE GAME.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Nobody starts with this. It costs a CATEGORY POINT — one of three a character
 * is handed in a whole career, at levels 10, 20 and 36 (Actor.lua:3757-3760) —
 * and that scarcity is the entire mechanic: a category point buys a WHOLE
 * DISCIPLINE, so which one is a decision a build is made of rather than an
 * entry on a shopping list.
 *
 * ═══ WHY THE LOCKED TREES ARE GENERIC AND NOT ANOTHER CLASS'S ═══
 * The obvious design is upstream's: a category point buys somebody else's
 * discipline, a Watchman who learned to shoot. MEASURED, IT DOES NOT FIT.
 * Classes carry nine or ten actives, every class tree needs three or four
 * hotbar slots, and the bar addresses twelve — so the Watchman fits exactly one
 * cross-class unlock and the Inspector, at ten, fits NONE. Three points with
 * nowhere to spend two of them is a currency that reads as broken.
 *
 * A generic tree of six PASSIVES needs zero bar slots, so the ceiling never
 * binds and all three points are always spendable. Upstream locks generic
 * categories too — `cunning/dirty` is closed to a Bulwark — so this is its
 * other shape rather than a departure.
 *
 * ═══ AND IT IS ABOUT THE TWO CHANNELS NOTHING ELSE TOUCHES ═══
 * `apr` and `damRange` are both live — two consumers apiece in the combat
 * getters — and authored by NOT ONE of the sixty-six talents that shipped
 * before this file. Armour penetration in particular is the only answer in the
 * game to something that is simply too well armoured to hurt, and until now no
 * character could buy it at any price.
 */

import { combatTalentScale } from '../../shared/scale.ts';
import { DamageType } from '../engine/damage.ts';
import { Affinity, TalentKind, TargetShape, talentId } from '../engine/talents.ts';
import { EMPTY_PASSIVE_VIEW } from '../engine/hooks.ts';
import type { Talent } from '../engine/talents.ts';

const CURVE = 0.75;

/** Every talent here is shared, so none of them is gated on a stat. */
const SHARED = {
  classId: null,
  tree: 'generic/leverage',
  kind: TalentKind.Passive,
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
} as const;

// ---------------------------------------------------------------------------
// WEAK POINTS — armour penetration, which nothing in the game could buy
// ---------------------------------------------------------------------------

const APR_LOW = 3;
const APR_HIGH = 14;

/** Armour penetration at a rank. */
export function penetrationAt(level: number): number {
  return Math.round(combatTalentScale(level, APR_LOW, APR_HIGH, CURVE));
}

/**
 * WEAK POINTS.
 *
 * "Nothing is armoured all the way round. It is only armoured where you were
 * going to hit it."
 *
 * ═══ THE FIRST TALENT TO GRANT `apr`, AND THAT IS THE POINT OF IT ═══
 * Armour penetration is live — `combatPhysicalpower`'s neighbours read it and
 * the damage pipeline applies it — and until this file NOTHING in the game
 * granted a point of it. Gear does, and gear is a die roll; a character facing
 * an elite husk in heavy plate had no way to CHOOSE to be better against it.
 *
 * IT IS FLAT AND UNCONDITIONAL, deliberately, in a tree that is otherwise
 * conditional. A locked tree has to be worth its category point on the day it
 * is bought, and a wall of conditions is worth nothing until a player has
 * learned what triggers them. One of the six is the door.
 */
export const weakPoints: Talent = {
  ...SHARED,
  id: talentId('weak_points'),
  name: 'Weak Points',
  /** Tier 1 of its tree. See `src/shared/tiers.ts`. */
  tier: 1,
  iconId: 'icon_passive_weak_points',
  passive: (level) => ({ mods: { apr: penetrationAt(level) } }),
  describe: (_self, level) =>
    `Always on. ${String(penetrationAt(level))} armour penetration — the only thing in the ` +
    `game that answers something too well armoured to hurt, and the first talent that sells it.`,
};

// ---------------------------------------------------------------------------
// SECOND LOOK — crit for standing still, where Braced sells armour for it
// ---------------------------------------------------------------------------

const CRIT_LOW = 3;
const CRIT_HIGH = 12;

/** Critical chance while you have not moved, at a rank. */
export function critAt(level: number): number {
  return Math.round(combatTalentScale(level, CRIT_LOW, CRIT_HIGH, CURVE));
}

/**
 * SECOND LOOK.
 *
 * "You saw it the first time. You are checking."
 *
 * THE OFFENSIVE HALF OF `braced.ts`, on the identical condition. That one sells
 * armour for standing still and this sells criticals, so a character who wants
 * both pays twice — and the pair is what turns "did not move this turn" from a
 * single talent's quirk into a way of playing that two trees reward.
 */
export const secondLook: Talent = {
  ...SHARED,
  id: talentId('second_look'),
  name: 'Second Look',
  /** Tier 1 of its tree. See `src/shared/tiers.ts`. */
  tier: 1,
  iconId: 'icon_passive_second_look',
  passive: (level, view = EMPTY_PASSIVE_VIEW) =>
    view.movedThisTurn() ? {} : { mods: { genericCrit: critAt(level) } },
  describe: (_self, level) =>
    `Always on, on any turn you do not change tiles. ${String(critAt(level))}% critical chance.`,
};

// ---------------------------------------------------------------------------
// BLOOD PRICE — the first talent in the game to use `onDealDamage`
// ---------------------------------------------------------------------------

const RETURN_LOW = 1;
const RETURN_HIGH = 6;

/** Hit points returned by the first blow you land each turn, at a rank. */
export function returnedAt(level: number): number {
  return Math.max(1, Math.round(combatTalentScale(level, RETURN_LOW, RETURN_HIGH, CURVE)));
}

/**
 * BLOOD PRICE.
 *
 * "It is not a fair trade. It is a trade."
 *
 * ═══ THE LAST UNUSED HOOK IN `TalentHooks`, AND IT CAN DO EXACTLY ONE THING ═══
 * `onDealDamage` returns void and is handed the hit as a NOTIFICATION — the
 * damage has already resolved, and the handler cannot change it. What it CAN
 * touch is `ctx.self`, so the only honest talent to build on it is one that
 * does something to the striker. That is not a limitation worked around; it is
 * the shape the hook has, and this is what fits it.
 *
 * ═══ ONCE A TURN, LIKE EVERY OTHER LATCHED TALENT ═══
 * Without `procs.once` this fires per DAMAGE INSTANCE — twice for a two-hit
 * talent, once per victim in an area effect. An Alchemist landing a vial on
 * four husks would heal four times, which is not a small talent, it is the best
 * sustain in the game. `unflinching.ts` carries the same note from the
 * receiving side.
 */
export const bloodPrice: Talent = {
  ...SHARED,
  id: talentId('blood_price'),
  name: 'Blood Price',
  /** Tier 2 of its tree. See `src/shared/tiers.ts`. */
  tier: 2,
  iconId: 'icon_passive_blood_price',
  hooks: {
    onDealDamage: (ctx, hit) => {
      // A BLOW THAT DID NOTHING RETURNS NOTHING, and it does not spend the
      // latch either — otherwise a 0-damage graze disarms this for the turn.
      if (hit.dam <= 0) return;
      if (!ctx.self.alive || ctx.self.hp <= 0) return;
      if (!ctx.procs.once('talent:blood_price')) return;
      ctx.self.hp = Math.min(ctx.self.maxHp, ctx.self.hp + returnedAt(ctx.level));
    },
  },
  describe: (_self, level) =>
    `Always on. The first blow you land each turn returns ${String(returnedAt(level))} hit ` +
    `points to you. Once a turn — an area effect does not pay per body.`,
};

// ---------------------------------------------------------------------------
// OVERREACH — the payoff for the position One at a Time avoids
// ---------------------------------------------------------------------------

/** Below this many bodies in reach it pays nothing. Two is "outnumbered". */
const CROWD = 2;
const DAM_LOW = 4;
const DAM_HIGH = 15;

/** Damage rating while outnumbered, at a rank. */
export function damageAt(level: number): number {
  return Math.round(combatTalentScale(level, DAM_LOW, DAM_HIGH, CURVE));
}

/**
 * OVERREACH.
 *
 * "There is no good way to do this. There is only the way you are doing it."
 *
 * ═══ THE EXACT OPPOSITE OF `one_at_a_time.ts`, AND BOTH ARE BUYABLE ═══
 * That one pays while exactly one thing is in reach — the doorway, the corridor,
 * the corner you backed into on purpose. This pays when that plan has failed and
 * two or more are on you.
 *
 * A character can own both, and they never both pay: one of them is always
 * telling you that the position you are in is the one it was built for. That is
 * a better property than it sounds — it means a build has an answer to the fight
 * going wrong instead of only to the fight going right, which is what a party
 * of six friends actually needs on a Tuesday.
 */
export const overreach: Talent = {
  ...SHARED,
  id: talentId('overreach'),
  name: 'Overreach',
  /** Tier 2 of its tree. See `src/shared/tiers.ts`. */
  tier: 2,
  iconId: 'icon_passive_overreach',
  passive: (level, view = EMPTY_PASSIVE_VIEW) =>
    view.adjacentEnemies() < CROWD ? {} : { mods: { dam: damageAt(level) } },
  describe: (_self, level) =>
    `Always on, while ${String(CROWD)} or more enemies are next to you. ` +
    `${String(damageAt(level))} damage. The answer to the doorway plan having failed.`,
};

// ---------------------------------------------------------------------------
// COMMITTED — the offensive twin of Second Wind, on the same condition
// ---------------------------------------------------------------------------

const POWER_LOW = 10;
const POWER_HIGH = 40;

/** Critical damage at death's door, at a rank, before the wound multiplier. */
export function fullPowerAt(level: number): number {
  return combatTalentScale(level, POWER_LOW, POWER_HIGH, CURVE);
}

/** What is actually granted: the full figure times the health you are missing. */
export function powerAt(level: number, hpFraction: number): number {
  const missing = Math.min(1, Math.max(0, 1 - hpFraction));
  return Math.round(fullPowerAt(level) * missing);
}

/**
 * COMMITTED.
 *
 * "Past a certain point there is no longer a decision to make, which is a
 * relief."
 *
 * `second_wind.ts` reads the same number and sells SAVES with it — the talent
 * for being finished off. This sells critical damage: the talent for finishing
 * it first. Together they are a whole way of playing that the game has not
 * previously rewarded at all, and they are in two different trees on purpose,
 * so committing to it costs a category point and a handful of generic ones.
 */
export const committed: Talent = {
  ...SHARED,
  id: talentId('committed'),
  name: 'Committed',
  /** Tier 3 of its tree. See `src/shared/tiers.ts`. */
  tier: 3,
  iconId: 'icon_passive_committed',
  passive: (level, view = EMPTY_PASSIVE_VIEW) => {
    const power = powerAt(level, view.hpFraction());
    return power <= 0 ? {} : { mods: { criticalPower: power } };
  },
  describe: (_self, level) =>
    `Always on. Up to ${String(Math.round(fullPowerAt(level)))}% critical damage, in proportion ` +
    `to the health you are missing — nothing at full, all of it at death's door.`,
};

// ---------------------------------------------------------------------------
// FULL SWING — the other channel nothing had ever granted
// ---------------------------------------------------------------------------

const RANGE_LOW = 0.06;
const RANGE_HIGH = 0.24;

/** How much wider the damage spread runs, at a rank. */
export function spreadAt(level: number): number {
  return combatTalentScale(level, RANGE_LOW, RANGE_HIGH, CURVE);
}

/** Percent, for the sentence the panel prints. */
const AS_PERCENT = 100;

/**
 * FULL SWING — the deepest thing in the tree.
 *
 * "Half measures leave you exactly where you were."
 *
 * ═══ `damRange` IS THE SECOND LIVE CHANNEL NOTHING HAD EVER GRANTED ═══
 * It is the width of the damage roll — upstream's `damrange`, defaulting to 1.1
 * (Combat.lua:1432). Widening it does not raise the average blow much; it raises
 * the CEILING of one, which is a different thing to want and the only channel in
 * the game that offers it.
 *
 * ═══ IT IS THE DEEPEST BECAUSE IT IS THE MOST CONDITIONAL WITHOUT A CONDITION ═══
 * A wider spread is worth most to a character who also has critical chance and
 * critical damage to multiply the top of it — which is to say, to somebody who
 * has already bought the rest of this tree. Nothing here is written down as a
 * prerequisite; the arithmetic simply makes the last talent worth more to the
 * player who arrived last, which is what a tier-3 slot should do.
 */
export const fullSwing: Talent = {
  ...SHARED,
  id: talentId('full_swing'),
  name: 'Full Swing',
  /** Tier 3 of its tree. See `src/shared/tiers.ts`. */
  tier: 3,
  iconId: 'icon_passive_full_swing',
  passive: (level) => ({ mods: { damRange: spreadAt(level) } }),
  describe: (_self, level) =>
    `Always on. Your damage rolls ${String(Math.round(spreadAt(level) * AS_PERCENT))}% wider — ` +
    `the same average blow with a far higher best one, which is what critical damage multiplies.`,
};

/** The six, in panel order. */
export const LEVERAGE: readonly Talent[] = Object.freeze([
  weakPoints,
  secondLook,
  bloodPrice,
  overreach,
  committed,
  fullSwing,
]);
