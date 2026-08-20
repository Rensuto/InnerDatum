// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// SHAPE:   t-engine4 game/modules/tome/data/talents/techniques/techniques.lua:99
//          — the requirement ladder: stat 12/20/28/36/44 with +2 per rank, and
//          character level 0/4/8/12/16 with +1 per rank, indexed by tier.
//          t-engine4 game/engines/default/engine/interface/ActorTalents.lua:729-734
//          — "know N-1 other talents in this tree" before a tier-N talent opens.
// NUMBERS: DELIBERATELY NOT PORTED. See THE ARITHMETIC below: upstream's own
//          constants make tier 4 unreachable at this game's level cap.
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" — https://te4.org/license

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *   A TREE IS A PATH, NOT A HEADING.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Before this, every talent in a tree was buyable at character level 1 with the
 * first point a player earned. Seven "trees" were therefore seven captions: the
 * word implied an order of study and the code enforced none, so a level-1
 * Watchman could put his first point into the deepest thing in the game.
 *
 * Upstream gets its entire intra-tree structure from ONE integer per talent —
 * its tier — and two gates read off it:
 *
 *   A STAT GATE.   You are not strong/quick/clever enough yet.
 *   A LEVEL GATE.  You have not been doing this long enough yet.
 *   A DEPTH GATE.  You have not learned enough of THIS tree yet
 *                  (ActorTalents.lua:729-734 — know N-1 of its lower talents).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *   THE ARITHMETIC — UPSTREAM'S, VERBATIM, AND IT ONLY WORKS AT A CAP OF 50
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ToME's ladder (techniques.lua:99) is, for tier N and rank r:
 *
 *     stat  >= 12 + 8(N-1) + 2(r-1)      12 / 20 / 28 / 36, +2 a rank
 *     level >=  0 + 4(N-1) +  (r-1)       0 /  4 /  8 / 12, +1 a rank
 *
 * which lands as:
 *
 *     tier 1   level  0   mastered at  4   stat 12 -> 20
 *     tier 2   level  4   mastered at  8   stat 20 -> 28
 *     tier 3   level  8   mastered at 12   stat 28 -> 36
 *     tier 4   level 12   mastered at 16   stat 36 -> 44
 *
 * ═══ THIS FILE ONCE RE-DERIVED THEM, AND THE CAP MOVED INSTEAD ═══
 * For a while `MAX_CHARACTER_LEVEL` was 10, and against that ceiling these
 * numbers are unusable: tier 3 sticks at rank 1, and TIER 4 GATES AT LEVEL 12
 * — past the end of the game. A quarter of every tree would have been content
 * nobody could buy. So this file carried a re-derived ladder
 * (stat +4 a tier, level ceil(1.5(N-1)) + floor((r-1)/2)) and an argument for
 * why adapting the constant was the honest port.
 *
 * That argument was correct and it has been overtaken. The project is now
 * targeting 1:1 with upstream — 1,231 talents, 281 trees, 29 classes — and the
 * cap moved to 50 to match, which puts these constants back inside the domain
 * they were written for. The re-derivation is gone; the citation is now literal
 * rather than shape-only.
 *
 * ═══ AND IT WAS ONE OF FOUR ═══
 * The tier ladder was not alone in being pushed outside its own domain by a cap
 * of 10 — the loot bands put every character in band 1 forever, the xp curve
 * never reached its own `level < 30` branch, and prodigies at 30 and 42 were
 * unreachable. Four ported formulas, four workarounds, one root cause. See
 * `MAX_CHARACTER_LEVEL` in shared/progression.ts.
 * * ═══ WHY THIS IS IN `shared/` ═══
 * The client greys a locked talent and prints why. If it computed that from its
 * own copy of the ladder, the panel and the spend path would be two answers to
 * one question, and they would disagree the first time either moved — the shape
 * that has cost this codebase six bugs. One module, imported by both.
 */

/** Tier 1 is the entry talent of a tree; tier 4 is its deepest. */
export const MIN_TIER = 1;
export const MAX_TIER = 4;

/** The stat a talent's tier is measured against, named by the talent itself. */
export const TIER_STAT_BASE = 12;
export const TIER_STAT_PER_TIER = 8;
export const TIER_STAT_PER_RANK = 2;

/**
 * `4(N-1)` — 0, 4, 8, 12. Upstream's, verbatim (techniques.lua:99).
 */
export const TIER_LEVEL_PER_TIER = 4;

/**
 * ONE CHARACTER LEVEL PER RANK — upstream's `(r-1)`, expressed as a divisor of 1
 * so the shape of the formula stays readable beside the tier term. At a cap of 50
 * that is nothing; at a cap of 10 it meant one talent eating half a career, which
 * is why this was 2 until the cap moved.
 */
export const TIER_LEVEL_PER_TWO_RANKS = 1;

/** The lowest stat value that opens tier `tier` at raw rank `rank`. */
export function statRequiredFor(tier: number, rank: number): number {
  const t = Math.max(MIN_TIER, Math.min(MAX_TIER, Math.floor(tier)));
  const r = Math.max(1, Math.floor(rank));
  return TIER_STAT_BASE + TIER_STAT_PER_TIER * (t - 1) + TIER_STAT_PER_RANK * (r - 1);
}

/** The lowest CHARACTER level that opens tier `tier` at raw rank `rank`. */
export function levelRequiredFor(tier: number, rank: number): number {
  const t = Math.max(MIN_TIER, Math.min(MAX_TIER, Math.floor(tier)));
  const r = Math.max(1, Math.floor(rank));
  return Math.ceil(TIER_LEVEL_PER_TIER * (t - 1)) + Math.floor((r - 1) / TIER_LEVEL_PER_TWO_RANKS);
}

/**
 * HOW MANY OTHER TALENTS OF THE SAME TREE MUST ALREADY BE KNOWN.
 *
 * ActorTalents.lua:729-734, ported verbatim in shape: tier N wants N-1 of them.
 * This is the gate that makes a tree a PATH rather than four independent
 * purchases that happen to share a caption — you cannot reach for the deepest
 * thing in a discipline without having studied the rest of it.
 *
 * KNOWN, not mastered. One point in each is enough, so the depth requirement is
 * about breadth of study rather than another rank tax.
 */
export function treeDepthRequiredFor(tier: number): number {
  return Math.max(0, Math.min(MAX_TIER, Math.floor(tier)) - 1);
}

export const TierRefusal = {
  /** Not strong/quick/clever enough yet. Carries the stat and the figure. */
  Stat: 'stat',
  /** Not been doing this long enough yet. */
  Level: 'level',
  /** Has not learned enough of this tree yet. */
  Depth: 'depth',
} as const;
export type TierRefusal = (typeof TierRefusal)[keyof typeof TierRefusal];

export type TierCheck =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: TierRefusal;
      /** What is needed. A number for stat/level, a count for depth. */
      readonly needed: number;
      /** What the character has. Lets the panel print "18 / 20". */
      readonly have: number;
      /** Which stat, when the refusal is a stat one. */
      readonly stat?: string;
    };

export type TierContext = {
  /** The tier of the talent being bought. Absent means tier 1. */
  readonly tier?: number;
  /** The raw rank being bought — the rank AFTER the point is spent. */
  readonly rank: number;
  /** Which stat this talent is gated on, and the character's value of it. */
  readonly stat?: string;
  readonly statValue: number;
  readonly characterLevel: number;
  /** How many OTHER talents of this same tree the character already knows. */
  readonly treeKnown: number;
};

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE ONE ANSWER TO "MAY I BUY THIS". Read by the spend path AND by the panel.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ORDER IS DELIBERATE: depth, then level, then stat. A player who is short on
 * all three should be told the one they can do something about SOONEST — another
 * talent in the tree is a decision available right now, a character level is a
 * few fights away, and a stat is three levels of points. Reporting the stat
 * first would send them to grind for a number when a click would have done.
 *
 * PURE. No clock, no randomness, no world. It takes numbers and returns a
 * verdict, which is what lets the client run the identical check to grey a
 * button and print the same sentence the server would have refused with.
 */
export function checkTier(ctx: TierContext): TierCheck {
  const tier = ctx.tier ?? MIN_TIER;

  const depth = treeDepthRequiredFor(tier);
  if (ctx.treeKnown < depth) {
    return { ok: false, reason: TierRefusal.Depth, needed: depth, have: ctx.treeKnown };
  }

  const level = levelRequiredFor(tier, ctx.rank);
  if (ctx.characterLevel < level) {
    return { ok: false, reason: TierRefusal.Level, needed: level, have: ctx.characterLevel };
  }

  /**
   * A TALENT THAT NAMES NO STAT IS NOT GATED ON ONE, and that is not a loophole.
   * Upstream's generic combat-training tree is exactly this: things true of a
   * body rather than of a discipline, which nothing about your Cunning should
   * gate. The gate exists to say "you are not that person yet", and some talents
   * make no such claim.
   */
  if (ctx.stat !== undefined) {
    const needed = statRequiredFor(tier, ctx.rank);
    if (ctx.statValue < needed) {
      return {
        ok: false,
        reason: TierRefusal.Stat,
        needed,
        have: ctx.statValue,
        stat: ctx.stat,
      };
    }
  }

  return { ok: true };
}

/** The sentence a player reads. One phrasing, so the panel and the log agree. */
export function tierRefusalText(check: TierCheck): string | null {
  if (check.ok) return null;
  switch (check.reason) {
    case TierRefusal.Depth:
      return `Learn ${String(check.needed)} more of this discipline first.`;
    case TierRefusal.Level:
      return `Not yet — this opens at level ${String(check.needed)}.`;
    case TierRefusal.Stat:
      return `Needs ${String(check.needed)} ${String(check.stat ?? 'aptitude')}; you have ${String(check.have)}.`;
  }
}
