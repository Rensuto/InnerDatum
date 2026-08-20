// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/modules/tome/class/Actor.lua:3767-3774.
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" — https://te4.org/license

import { describe, expect, it } from 'vitest';

import {
  CAP_BONUS_CLASS_POINTS,
  CAP_BONUS_GENERIC_POINTS,
  CAP_BONUS_STATS,
  MAX_CHARACTER_LEVEL,
  STAT_POINTS_PER_LEVEL,
  genericPointsForLevel,
  pointsForLevel,
  statPointsForLevel,
  totalGenericPointsAtLevel,
  totalPointsAtLevel,
  totalStatPointsAtLevel,
} from '../../src/shared/progression.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *   THE LAST LEVEL IS AN EVENT, NOT THE MOMENT THE NUMBERS STOP.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *     if self.level == 50 then
 *         self.unused_stats    = self.unused_stats    + 10
 *         self.unused_talents  = self.unused_talents  + 3
 *         self.unused_generics = self.unused_generics + 3
 *
 * Unreachable until today: the cap was 10, so this was one of five ported
 * formulas sitting outside its own domain. It is in range now.
 */

describe('the cap bonus', () => {
  it('pays on top of the ordinary grant, not instead of it', () => {
    /**
     * ═══ THE DISTINCTION THAT MATTERS ═══
     * A reading of "instead of" would give the cap 3 class points. Upstream
     * gives it the usual fifth-level 2 AND the bonus 3, which is 5 — and the
     * whole feel of hitting the cap is that it hands you a fistful of things to
     * spend at once.
     */
    const ordinaryFifth = 2;
    expect(pointsForLevel(MAX_CHARACTER_LEVEL)).toBe(ordinaryFifth + CAP_BONUS_CLASS_POINTS);
    expect(statPointsForLevel(MAX_CHARACTER_LEVEL)).toBe(STAT_POINTS_PER_LEVEL + CAP_BONUS_STATS);
  });

  it('gives the generic pool 0 + 3, because the cap is also a fifth level', () => {
    /**
     * ═══ NOT A ROUNDING — TWO RULES FIRING IN ORDER ═══
     * The fifth-level swap (Actor.lua:3752) takes the ordinary generic point
     * away first, and the cap bonus (:3769) then lands on top of nothing. So the
     * last level pays THREE generics, not four.
     */
    expect(MAX_CHARACTER_LEVEL % 5, 'the cap is no longer a fifth level').toBe(0);
    expect(genericPointsForLevel(MAX_CHARACTER_LEVEL)).toBe(CAP_BONUS_GENERIC_POINTS);
  });

  it('fires at the cap and nowhere else', () => {
    // Including the level before it, which is the off-by-one worth pinning.
    for (const level of [2, 5, 10, 25, 45, MAX_CHARACTER_LEVEL - 1]) {
      expect(pointsForLevel(level), `level ${String(level)} paid a cap bonus`).toBeLessThan(
        CAP_BONUS_CLASS_POINTS,
      );
      expect(statPointsForLevel(level)).toBe(STAT_POINTS_PER_LEVEL);
    }
  });

  it('reaches the ledgers, so a character actually receives it', () => {
    /**
     * The per-level functions are what the level-up loop asks; the totals are
     * what a SAVE is reconciled against on load. A bonus that appeared in one
     * and not the other would be handed out and then taken away by the next
     * reconnect — which is the shape of bug the "never persist a derived value"
     * rule exists to prevent, arriving from the other direction.
     */
    const oneBelow = MAX_CHARACTER_LEVEL - 1;
    expect(totalPointsAtLevel(MAX_CHARACTER_LEVEL) - totalPointsAtLevel(oneBelow)).toBe(
      pointsForLevel(MAX_CHARACTER_LEVEL),
    );
    expect(
      totalGenericPointsAtLevel(MAX_CHARACTER_LEVEL) - totalGenericPointsAtLevel(oneBelow),
    ).toBe(genericPointsForLevel(MAX_CHARACTER_LEVEL));
    expect(totalStatPointsAtLevel(MAX_CHARACTER_LEVEL) - totalStatPointsAtLevel(oneBelow)).toBe(
      statPointsForLevel(MAX_CHARACTER_LEVEL),
    );
  });

  it('leaves a capped character with upstream totals', () => {
    /**
     * The whole-career figures, which are what a finished character is holding.
     * Stat points are the one that can be checked against upstream directly:
     * 49 level-ups at 3 apiece is 147, plus the 10 at the cap.
     */
    expect(totalStatPointsAtLevel(MAX_CHARACTER_LEVEL)).toBe(
      (MAX_CHARACTER_LEVEL - 1) * STAT_POINTS_PER_LEVEL + CAP_BONUS_STATS,
    );

    // And the two talent purses still differ by exactly the fifth-level swaps,
    // because the cap bonus pays both sides equally and cannot change the gap.
    const fifths = Math.floor(MAX_CHARACTER_LEVEL / 5);
    expect(
      totalPointsAtLevel(MAX_CHARACTER_LEVEL) - totalGenericPointsAtLevel(MAX_CHARACTER_LEVEL),
    ).toBe(fifths * 2);
  });
});
