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
 *   THE ARITHMETIC, AND WHY UPSTREAM'S CONSTANTS CANNOT BE COPIED
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ToME's ladder (techniques.lua:99) is, for tier N and rank r:
 *
 *     stat  >= 12 + 8(N-1) + 2(r-1)
 *     level >=  0 + 4(N-1) +  (r-1)
 *
 * Those constants are fitted to a FIFTY-LEVEL game whose stats run past 100.
 * Ported literally into a game with a level cap of 10 and a stat ceiling near
 * 51, they produce this:
 *
 *     tier 1   level  0 + 0    ->  reachable, rank 5 at level  4
 *     tier 2   level  0 + 4    ->  reachable, rank 5 at level  8
 *     tier 3   level  0 + 8    ->  rank 1 at level 8; rank 5 needs level 12
 *     tier 4   level  0 + 12   ->  NEVER. The cap is 10.
 *
 * A quarter of every tree would be dead content, and another quarter would be
 * half-buyable. That is not a port, it is a bug with a citation.
 *
 * So the SHAPE is ported and the CONSTANTS are re-derived. The shape is what
 * fifteen years of tuning is actually worth here: two independent gates, linear
 * in tier and linear in rank, plus a depth requirement — a talent you cannot yet
 * afford in stats may still be reachable by playing longer, and vice versa,
 * which is what stops the ladder feeling like one number in a coat.
 *
 * OUR LADDER, fitted so that ALL FOUR TIERS OPEN INSIDE TEN LEVELS:
 *
 *     stat  >= 12 + 4(N-1) + 2(r-1)      12 / 16 / 20 / 24, +2 a rank
 *     level >= ceil(1.5(N-1)) + floor((r-1)/2)
 *
 * which lands as:
 *
 *     tier 1   level 0   rank 5 at level 2    stat 12 -> 20
 *     tier 2   level 2   rank 5 at level 4    stat 16 -> 24
 *     tier 3   level 3   rank 5 at level 5    stat 20 -> 28
 *     tier 4   level 5   rank 5 at level 7    stat 24 -> 32
 *
 * Every tier is reachable, the deepest talent still costs most of a character's
 * life to master, and the stat gate stays meaningful against a ceiling of ~51
 * rather than one of 100.
 *
 * ═══ WHY THIS IS IN `shared/` ═══
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
export const TIER_STAT_PER_TIER = 4;
export const TIER_STAT_PER_RANK = 2;

/**
 * `ceil(1.5(N-1))` — 0, 2, 3, 5. The half-step is deliberate: a flat 2 per tier
 * would put tier 4 at level 6 and leave the back half of the game with nothing
 * left to unlock, and a flat 3 would push it to 9 and leave one level to use it.
 */
export const TIER_LEVEL_PER_TIER = 1.5;

/**
 * `floor((r-1)/2)` — a rank costs a character level only every OTHER rank.
 * Upstream charges one per rank, which at a cap of 50 is nothing and at a cap of
 * 10 would mean a single talent consuming half a character's career.
 */
export const TIER_LEVEL_PER_TWO_RANKS = 2;

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
