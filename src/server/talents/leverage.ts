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
import { healActor } from '../engine/talents.ts';
import { EffectId } from '../content/effects.ts';
import { EffectStatus, SetEffectOutcome } from '../engine/effects.ts';
import { combatPhysicalpower } from '../engine/derived.ts';
import { DamageType } from '../engine/damage.ts';
import {
  Affinity,
  TalentKind,
  TargetShape,
  TalentRefusal,
  actorsInShape,
  ballTiles,
  talentDone,
  talentId,
  talentRefused,
  targetActor,
  tomeCooldownToTurns,
} from '../engine/talents.ts';
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
      // THROUGH `healActor`, WHICH IS THIS GAME'S `onHeal`. Its docblock says
      // why: the receiver's Constitution decides what a heal is worth, and it
      // lives there *"rather than in each of the four talents that heal … so a
      // fifth heal added later cannot forget it"*. All four forgot it.
      healActor(ctx.self, returnedAt(ctx.level));
    },
  },
  describe: (_self, level) =>
    `Always on. The first blow you land each turn returns ${String(returnedAt(level))} hit ` +
    `points to you. Once a turn — an area effect does not pay per body.`,
};

// ---------------------------------------------------------------------------
// OVERREACH — the payoff for the position One at a Time avoids
// ---------------------------------------------------------------------------

/**
 * How far the grit goes.
 *
 * Upstream's is a CONE of radius `combatTalentScale(t, 1, 2.5)` (dirty.lua:124).
 * Ours is a ball centred on the caster, for `clear_the_street.ts`'s reason —
 * "this happens around you, which is what makes it the answer to being
 * surrounded" — and because `radius` is one number on the wire, so the client's
 * shape preview and the tiles actually hit cannot disagree.
 */
const GRIT_RADIUS = 2;

/**
 * Turns effaced, at a rank.
 *
 * Upstream is `getDuration = combatTalentScale(t, 3, 5)` (dirty.lua:130) and
 * 3..5 floors to 3,3,4,4,5 in our scale — the fourth time today this band has
 * produced two ranks that read identically. 2..6 gives 2,3,4,5,6, and starting
 * a rank lower is the right end to widen from for an effect that lands on
 * EVERYTHING around you rather than on one body.
 */
const EFFACE_LOW = 2;
const EFFACE_HIGH = 6;

export function damageAt(level: number): number {
  return Math.floor(combatTalentScale(level, EFFACE_LOW, EFFACE_HIGH, CURVE));
}

/** Ported from dirty.lua:122 — Blinding Powder's `cooldown = 12`. */
const POWDER_COOLDOWN_ACTIONS = 12;
const OVERREACH_COOLDOWN = tomeCooldownToTurns(POWDER_COOLDOWN_ACTIONS);
/** Three of six. An area debuff is most of a turn, not all of it. */
const OVERREACH_AP = 3;

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
  kind: TalentKind.Active,
  iconId: 'icon_active_overreach',
  cost: { ap: OVERREACH_AP },
  cooldownTurns: OVERREACH_COOLDOWN,
  targeting: {
    // CENTRED ON THE CASTER, `clear_the_street.ts`'s shape and its reason: this
    // happens around you, which is what makes it an answer to being surrounded.
    shape: TargetShape.Self,
    range: 0,
    minRange: 0,
    radius: GRIT_RADIUS,
    requiresLos: false,
    affinity: Affinity.Hostile,
  },

  onUse: (ctx, self) => {
    const tiles = ballTiles(self, GRIT_RADIUS);
    const victims = actorsInShape(ctx.world, self, tiles, Affinity.Hostile);
    const turns = damageAt(ctx.talentLevel);
    const power = combatPhysicalpower(self.combat ?? {});
    const lines: string[] = [];

    for (const victim of victims) {
      const landed = ctx.status?.(victim, EffectId.Effaced, turns, {
        applyPower: power,
        srcId: self.id,
      });
      /** `strike_out.ts`'s rule: a resisted mark and an unattempted one differ. */
      if (landed === undefined) continue;
      lines.push(
        landed.outcome === SetEffectOutcome.Applied
          ? `${victim.name} is grinding at their eyes.`
          : `${victim.name} blinks it away.`,
      );
    }

    /**
     * A HANDFUL OF GRIT THROWN AT AN EMPTY ROOM STILL COSTS ITS AP AND STILL
     * GOES ON COOLDOWN — `clear_the_street.ts` states the rule and the reason:
     * the player made a read and it was wrong, which is a legible outcome. The
     * refund rule is for intents that went ILLEGAL, not for ones that missed.
     */
    if (lines.length === 0) lines.push('The grit goes nowhere in particular.');
    return talentDone([], lines);
  },

  describe: (_self, level) =>
    `Grit, thrown at everything within ${String(GRIT_RADIUS)} tiles of you: effaced for ` +
    `${String(damageAt(level))} turns (physical save), so every roll they make and resist is ` +
    `worse. The answer to the doorway plan having failed. ${String(OVERREACH_AP)} AP, ` +
    `${String(OVERREACH_COOLDOWN)}-turn cooldown.`,
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
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * AND IT CARRIES `damRange` NOW, WHICH FULL SWING USED TO
 * ═══════════════════════════════════════════════════════════════════════════
 * `spreadAt` was Full Swing's whole passive, and Full Swing became Twist the
 * Knife when this tree was brought to its cited upstream's shape. `damRange` is
 * still LIVE — every class table sets it, and the combat maths reads it — but no
 * TALENT granted it any more, and a channel that was added for one talent and
 * then orphaned by that talent's conversion is exactly the dead-content trap
 * this codebase keeps finding.
 *
 * IT LANDS HERE BECAUSE FULL SWING'S OWN NOTE PUT IT HERE. That note read: "A
 * wider spread is worth most to a character who also has critical chance and
 * critical damage to multiply the top of it." That character is the one holding
 * THIS talent. The two halves were always one idea about the top end of a blow,
 * split across two slots because there were six slots to fill; one of them is a
 * button now, so the idea goes back together.
 *
 * FLAT, NOT SCALED ON HEALTH, unlike the critical damage beside it. A damage
 * ROLL is not a payout, it is the shape of one, and a spread that widened as you
 * bled would make a hurt character's damage read as noise on top of noise.
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
    const spread = { damRange: spreadAt(level) };
    return power <= 0 ? { mods: spread } : { mods: { criticalPower: power, ...spread } };
  },
  describe: (_self, level) =>
    `Always on. Your damage rolls ${String(Math.round(spreadAt(level) * AS_PERCENT))}% wider, and ` +
    `up to ${String(Math.round(fullPowerAt(level)))}% critical damage in proportion to the health ` +
    `you are missing — nothing at full, all of it at death's door.`,
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

/**
 * Turns added to each affliction, at a rank.
 *
 * Upstream is `getDuration = combatTalentScale(t, 2, 4, "log")` (dirty.lua:165),
 * widened to 2..6 for the reason every band in this pass has been: 2..4 floors
 * to 2,2,3,3,4 and two pairs of ranks read identically.
 */
const TWIST_LOW = 2;
const TWIST_HIGH = 6;

export function twistTurnsAt(level: number): number {
  return Math.floor(combatTalentScale(level, TWIST_LOW, TWIST_HIGH, CURVE));
}

/**
 * How many afflictions one twist reaches.
 *
 * Upstream's `getDebuffs = combatTalentScale(t, 1, 3, "log")` (dirty.lua:166) —
 * one at rank one, three at five. Ours floors the same band to 1,1,2,2,3, and
 * that is LEFT ALONE deliberately: `twistTurnsAt` above is the number the
 * description leads with and the one `class-wiring.test.ts` measures, so this
 * one is free to be the coarse, readable "one, then two, then three".
 */
/** Percent, for the sentence the panel prints. */
const AS_PERCENT = 100;

const REACH_LOW = 1;
const REACH_HIGH = 3;

export function twistReachAt(level: number): number {
  return Math.max(1, Math.floor(combatTalentScale(level, REACH_LOW, REACH_HIGH, CURVE)));
}

/** How far a twist reaches. Upstream is `range = 1`, melee (dirty.lua:162). */
const TWIST_RANGE = 1;
/** Four of six. Upstream's is a weapon-speed attack; ours is most of a turn. */
const TWIST_AP = 4;
/** Ported from dirty.lua:157 — `cooldown = 15`, and `fixed_cooldown = true`. */
const TWIST_COOLDOWN_ACTIONS = 15;
const TWIST_COOLDOWN = tomeCooldownToTurns(TWIST_COOLDOWN_ACTIONS);

/**
 * FULL SWING — the deepest thing in the tree.
 *
 * "Half measures leave you exactly where you were."
 *
 * ═══ IT WAS THE `damRange` PASSIVE, AND THAT GRANT MOVED TO `committed` ═══
 * The width of the damage roll — upstream's `damrange`, defaulting to 1.1
 * (Combat.lua:1432) — used to be this talent's whole body. The old note argued
 * that "a wider spread is worth most to a character who also has critical chance
 * and critical damage to multiply the top of it", which is a description of the
 * talent two slots up, so that is where `spreadAt` now lives. See `committed`.
 *
 * ═══ AND WHAT REPLACED IT IS THE THIRD STATUS SEAM ═══
 * `TalentCtx` had `status` to apply and `cure` to remove, and nothing at all to
 * READ what a body was already suffering. Twist the Knife needs exactly that —
 * it lengthens what is there rather than adding anything — and so does every
 * upstream talent that pays you for a condition a TEAMMATE inflicted, which is
 * most of what makes a party's talents combine rather than merely stack.
 * `extend` is that seam, and this is its first caller.
 */
export const fullSwing: Talent = {
  ...SHARED,
  id: talentId('full_swing'),
  name: 'Full Swing',
  /** Tier 3 of its tree. See `src/shared/tiers.ts`. */
  tier: 3,
  kind: TalentKind.Active,
  iconId: 'icon_active_full_swing',
  cost: { ap: TWIST_AP },
  cooldownTurns: TWIST_COOLDOWN,
  targeting: {
    shape: TargetShape.Single,
    range: TWIST_RANGE,
    minRange: 0,
    radius: 0,
    requiresLos: true,
    affinity: Affinity.Hostile,
  },

  onUse: (ctx, self, target) => {
    const victim = targetActor(ctx.world, target);
    if (victim === undefined) return talentRefused(TalentRefusal.NoTarget);

    /**
     * NOTHING WRONG WITH THEM IS A REFUSAL, NOT A SPENT TURN.
     *
     * `field_dressing.ts` draws the identical line from the other side — a
     * dressing put on somebody with nothing wrong with them refunds — and the
     * reason is the same: this talent's whole text is about what is ALREADY
     * there, so aiming it at an untouched body is a mis-aim rather than a read
     * that did not come off. The grit in `overreach` above is the opposite case
     * and says so.
     */
    const lengthened = ctx.extend?.(
      victim,
      EffectStatus.Detrimental,
      twistTurnsAt(ctx.talentLevel),
      twistReachAt(ctx.talentLevel),
    );
    if (lengthened === undefined || lengthened.length === 0) {
      return talentRefused(TalentRefusal.NoTarget);
    }

    return talentDone(
      [],
      lengthened.map((name) => `${victim.name} is not done with ${name.toLowerCase()}.`),
    );
  },

  describe: (_self, level) =>
    `Find what is already wrong with a body in reach and make it last: up to ` +
    `${String(twistReachAt(level))} of the afflictions on them run ` +
    `${String(twistTurnsAt(level))} turns longer. No save — theirs was made when it landed. ` +
    `Refuses a target with nothing wrong. ${String(TWIST_AP)} AP, ` +
    `${String(TWIST_COOLDOWN)}-turn cooldown.`,
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
