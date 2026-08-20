// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

import { describe, expect, it } from 'vitest';

import { MAX_CHARACTER_LEVEL, TALENT_MAX_LEVEL } from '../../src/shared/progression.ts';
import {
  MAX_TIER,
  MIN_TIER,
  TierRefusal,
  checkTier,
  levelRequiredFor,
  statRequiredFor,
  tierRefusalText,
  treeDepthRequiredFor,
} from '../../src/shared/tiers.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *   A TREE IS A PATH, NOT A HEADING.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Every talent in a tree used to be buyable at character level 1 with a
 * player's first point. The word "tree" implied an order of study and the code
 * enforced none.
 *
 * The gates are ported in SHAPE from upstream and re-derived in CONSTANTS, and
 * the first test here is the one that justifies that split: upstream's own
 * numbers make a quarter of every tree unreachable at this game's level cap.
 */

/**
 * THE SHIPPED CAP, NOT A LITERAL. This file used to say 10 and every
 * assertion below was quietly about that number; when the cap moved to 50 for
 * 1:1 with upstream, five tests failed for a change that was entirely
 * deliberate. Reading the constant is what makes the next cap change a
 * one-line edit rather than an archaeology exercise.
 */
const CAP = MAX_CHARACTER_LEVEL;

describe('the ladder fits the game it is in', () => {
  it('opens every tier inside the level cap, on the constants upstream ships', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THIS TEST ONCE ARGUED THE OPPOSITE, AND BOTH TIMES IT WAS RIGHT.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * At a cap of 10 it existed to justify NOT porting upstream's numbers:
     * `4(N-1)` gates tier 4 at level 12, past the end of the game, so a
     * quarter of every tree was unbuyable and this file carried a re-derived
     * ladder.
     *
     * The cap is 50 now and the constants are upstream's, verbatim
     * (techniques.lua:99). The same assertion now checks that the LITERAL port
     * fits, which is the thing the cap was raised to make true.
     */
    for (let tier = MIN_TIER; tier <= MAX_TIER; tier += 1) {
      expect(
        levelRequiredFor(tier, TALENT_MAX_LEVEL),
        `tier ${String(tier)} cannot be mastered inside the cap`,
      ).toBeLessThanOrEqual(CAP);
    }

    // Tier 4 masters at 16 — comfortably inside 50, and impossible under 10.
    expect(levelRequiredFor(MAX_TIER, TALENT_MAX_LEVEL)).toBeGreaterThan(10);
  });

  it('separates the shallow end from the deep end by a real span of levels', () => {
    /**
     * THIS ASSERTED "most of a career", which was a fact about a cap of 10 and
     * not about the ladder. At 50, tier 4 masters at level 16 — a third of the
     * way in, which is upstream's own pacing and correct: ToME expects you to
     * finish a tree and then go and find more trees.
     *
     * What is worth pinning is the SPAN. Tier 1 and tier 4 must not open at
     * anything like the same time, or the ladder is decoration.
     */
    const shallow = levelRequiredFor(MIN_TIER, 1);
    const deep = levelRequiredFor(MAX_TIER, TALENT_MAX_LEVEL);
    expect(deep - shallow, 'the ladder barely spans anything').toBeGreaterThan(10);
    expect(deep).toBeLessThanOrEqual(CAP);
  });

  it('rises with tier and with rank, independently', () => {
    // Two gates that move together would be one gate wearing two names.
    expect(levelRequiredFor(2, 1)).toBeGreaterThan(levelRequiredFor(1, 1));
    expect(levelRequiredFor(1, 5)).toBeGreaterThan(levelRequiredFor(1, 1));
    expect(statRequiredFor(2, 1)).toBeGreaterThan(statRequiredFor(1, 1));
    expect(statRequiredFor(1, 5)).toBeGreaterThan(statRequiredFor(1, 1));
  });

  it('keeps the stat gate meaningful against a ceiling near 51', () => {
    /**
     * Upstream's stat ladder tops out at 44 + 8 against a stat ceiling past
     * 100 — comfortable there, unreachable here. Ours must be demanding at the
     * top and not impossible.
     */
    const hardest = statRequiredFor(MAX_TIER, TALENT_MAX_LEVEL);
    expect(hardest).toBeGreaterThan(statRequiredFor(MIN_TIER, 1));
    expect(hardest, 'the deepest talent needs a stat no character can reach').toBeLessThan(51);
  });
});

describe('the three gates', () => {
  /**
   * A CHARACTER WHO CLEARS EVERY GATE. `statValue` is deliberately past the
   * stat ceiling and `characterLevel` is the cap, so these tests are about the
   * gate logic rather than about whether a particular build qualifies.
   */
  const open = {
    rank: 1,
    statValue: 99,
    characterLevel: CAP,
    treeKnown: MAX_TIER,
  } as const;

  it('lets a qualified character through', () => {
    expect(checkTier({ ...open, tier: MAX_TIER }).ok).toBe(true);
  });

  it('refuses depth before level, and level before stat', () => {
    /**
     * ═══ THE ORDER IS THE MESSAGE ═══
     * A player short on all three should be told the one they can act on
     * SOONEST. Another talent in the tree is a decision available right now; a
     * character level is a few fights away; a stat is three levels of points.
     * Reporting the stat first sends them to grind for a number when a click
     * would have done.
     */
    // NAMES A STAT, so all three gates are live. Without one the stat gate is
    // correctly skipped — which is the next test, and is why this one has to
    // say 'str' out loud rather than relying on the default.
    const shortOnEverything = {
      tier: MAX_TIER,
      rank: 5,
      stat: 'str',
      statValue: 0,
      characterLevel: 0,
      treeKnown: 0,
    };
    const first = checkTier(shortOnEverything);
    expect(first.ok).toBe(false);
    if (!first.ok) expect(first.reason).toBe(TierRefusal.Depth);

    const withDepth = checkTier({ ...shortOnEverything, treeKnown: MAX_TIER });
    expect(withDepth.ok).toBe(false);
    if (!withDepth.ok) expect(withDepth.reason).toBe(TierRefusal.Level);

    const withLevel = checkTier({ ...shortOnEverything, treeKnown: MAX_TIER, characterLevel: CAP });
    expect(withLevel.ok).toBe(false);
    if (!withLevel.ok) expect(withLevel.reason).toBe(TierRefusal.Stat);
  });

  it('wants N-1 OTHER talents of the tree, so a tree is walked in order', () => {
    for (let tier = MIN_TIER; tier <= MAX_TIER; tier += 1) {
      expect(treeDepthRequiredFor(tier)).toBe(tier - 1);
    }
    // Tier 1 asks for nothing, which is what makes it the way in.
    expect(treeDepthRequiredFor(MIN_TIER)).toBe(0);
  });

  it('does not gate a talent that names no stat', () => {
    /**
     * NOT A LOOPHOLE. Upstream's generic combat-training tree is things true of
     * a BODY rather than of a discipline, and nothing about your Cunning should
     * gate whether you have been shouted at before. A talent with no `statGate`
     * makes no claim about who you are, so there is nothing to check.
     */
    const noStat = checkTier({
      tier: MAX_TIER,
      rank: 5,
      statValue: 0,
      characterLevel: CAP,
      treeKnown: 3,
    });
    expect(noStat.ok, 'an ungated talent was refused on a stat it never named').toBe(true);
  });

  it('checks the rank being BOUGHT, which the caller must pass', () => {
    // An off-by-one here reads as "the cap feels wrong" and nothing else. The
    // gate is a rule about the rank being purchased, not the one already held.
    const atFive = checkTier({ ...open, tier: 1, rank: 5, characterLevel: 0 });
    const atOne = checkTier({ ...open, tier: 1, rank: 1, characterLevel: 0 });
    expect(atOne.ok).toBe(true);
    expect(atFive.ok, 'rank 5 of a tier-1 talent costs no character level at all').toBe(false);
  });
});

describe('what the player is told', () => {
  it('says something actionable for each refusal', () => {
    const cases = [
      checkTier({ tier: 4, rank: 1, statValue: 99, characterLevel: 99, treeKnown: 0 }),
      checkTier({ tier: 4, rank: 1, statValue: 99, characterLevel: 0, treeKnown: 3 }),
      checkTier({ tier: 4, rank: 1, stat: 'str', statValue: 1, characterLevel: 99, treeKnown: 3 }),
    ];
    for (const c of cases) {
      expect(c.ok).toBe(false);
      const text = tierRefusalText(c);
      expect(text, 'a refusal with no sentence is a button that does nothing').not.toBeNull();
      expect((text ?? '').length).toBeGreaterThan(10);
    }
    // The stat refusal names the stat and both figures, so a panel can print
    // "Needs 24 str; you have 1" rather than a shrug.
    const statCase = cases[2];
    expect(statCase, 'the stat case vanished').toBeDefined();
    if (statCase !== undefined) expect(tierRefusalText(statCase)).toContain('str');
  });

  it('says nothing at all when the answer is yes', () => {
    expect(tierRefusalText({ ok: true })).toBeNull();
  });
});
