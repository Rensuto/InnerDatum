// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

import { describe, expect, it } from 'vitest';

import { TALENT_MAX_LEVEL } from '../../src/shared/progression.ts';
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

const CAP = 10;

describe('the ladder fits the game it is in', () => {
  it('opens every tier inside the level cap', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE ASSERTION THAT JUSTIFIES NOT PORTING UPSTREAM'S CONSTANTS.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * ToME gates tier N at character level `4(N-1)`, which at a cap of 50 is
     * generous and at a cap of 10 puts tier 4 at level 12 — past the end of the
     * game. A quarter of every tree would be content nobody could ever buy.
     */
    for (let tier = MIN_TIER; tier <= MAX_TIER; tier += 1) {
      expect(
        levelRequiredFor(tier, TALENT_MAX_LEVEL),
        `tier ${String(tier)} cannot be mastered inside the cap`,
      ).toBeLessThanOrEqual(CAP);
    }

    // And upstream's, for contrast — the number this ladder exists to avoid.
    const upstreamTierFourMastered = 4 * (MAX_TIER - 1) + (TALENT_MAX_LEVEL - 1);
    expect(upstreamTierFourMastered).toBeGreaterThan(CAP);
  });

  it('still makes the deepest talent cost most of a career', () => {
    /**
     * A ladder that fits is not enough — one that fits TOO easily is a ladder
     * nobody climbs. Mastering the deepest talent in a tree should be a
     * late-game act, not something done on the way past.
     */
    const deepest = levelRequiredFor(MAX_TIER, TALENT_MAX_LEVEL);
    expect(deepest).toBeGreaterThan(CAP / 2);
    expect(deepest).toBeLessThanOrEqual(CAP);
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
