import { describe, expect, it } from 'vitest';

import { cunningAt } from '../../src/server/talents/cut_with_chalk.ts';
import { dexterityAt } from '../../src/server/talents/powder_discipline.ts';
import { combatTalentScale } from '../../src/shared/scale.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * TWO TALENTS, ONE DONOR LINE, AND IT SPECIFIES A ROUNDING MODE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `undeads/ghoul.lua:26` is
 *
 *     statBonus = function(self, t) return math.ceil(self:combatTalentScale(t, 2, 15, 0.75)) end
 *
 * and both `cut_with_chalk` and `powder_discipline` cite it, quoting the `ceil`
 * in their own NUMBERS headers. Both then called `Math.round`.
 *
 * THE BAND RESCALE IS NOT THE ISSUE and is not asserted here: 2→15 becomes 1→6
 * because upstream's stats run 10→60+ against our 10→24, and both files argue
 * that at the line. A rounding mode is a separate claim, and it was the one the
 * citation made explicitly.
 *
 * ONE RANK, WHICH IS WHY IT SURVIVED. On the shared 1→6 @ 0.75 band the two
 * rules agree at ranks 1, 3, 4 and 5. Only rank 2 differs — raw 2.4545, so
 * `round` gives 2 and `ceil` gives 3.
 */
describe('the ghoul band rounds the way its citation says', () => {
  const RANKS = [1, 2, 3, 4, 5] as const;

  it('cut with chalk ceils, matching ghoul.lua:26', () => {
    for (const rank of RANKS) {
      expect(cunningAt(rank)).toBe(Math.ceil(combatTalentScale(rank, 1, 6, 0.75)));
    }
  });

  it('powder discipline ceils, from the same donor line', () => {
    for (const rank of RANKS) {
      expect(dexterityAt(rank)).toBe(Math.ceil(combatTalentScale(rank, 1, 6, 0.75)));
    }
  });

  it('names rank 2, the only rank the two rules disagree on', () => {
    // Stated as literals so a silent revert to `Math.round` fails here even if
    // somebody changes the helper underneath both files.
    expect(cunningAt(2)).toBe(3);
    expect(dexterityAt(2)).toBe(3);
    expect(Math.round(combatTalentScale(2, 1, 6, 0.75))).toBe(2);
  });

  it('leaves the four ranks where the rules already agreed', () => {
    expect([1, 3, 4, 5].map((r) => cunningAt(r))).toEqual([1, 4, 5, 6]);
    expect([1, 3, 4, 5].map((r) => dexterityAt(r))).toEqual([1, 4, 5, 6]);
  });
});
