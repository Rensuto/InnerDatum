import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { CITYBORN, INDEXED, classPointBonus } from '../../src/server/content/origins.ts';
import { expChart, gainExp } from '../../src/shared/progression.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE BAR'S DENOMINATOR IS THE THRESHOLD `gainExp` COMPARES AGAINST.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `sendProgress` states that as an invariant in as many words — "the very
 * threshold `gainExp` compares against, so the bar fills exactly as the level
 * does" — and it WENT FALSE the day an origin could raise the cost of a level.
 * `gainExp` scaled by `exp_mod` and the bar did not, so an Indexed character
 * would have watched it reach the end and stay where it was.
 *
 * ═══ ASSERTED AS AN IDENTITY, NOT AS A NUMBER ═══
 * Nothing below spells a threshold. Each case asks the CHART for the number the
 * bar shows and then hands `gainExp` exactly that much experience: if the two
 * arguments ever diverge again, the level does not arrive and the test says so.
 * A test that pinned 808 would need editing every time the curve moved and would
 * still not be checking the thing that matters.
 */

describe('the experience bar cannot lie about the next level', () => {
  const shown = (level: number, expMod: number): number => expChart(level + 1, expMod);

  it('fills exactly as the level arrives, for an origin with no penalty', () => {
    const mod = CITYBORN.experienceMult;
    for (const level of [1, 5, 12, 30]) {
      const need = shown(level, mod);
      expect(gainExp(level, 0, need - 1, mod).levelsGained, `at ${String(level)}`).toBe(0);
      expect(gainExp(level, 0, need, mod).levelsGained, `at ${String(level)}`).toBe(1);
    }
  });

  /**
   * THE CASE THAT WAS BROKEN. A penalised body's bar has to show the LARGER
   * number, or it promises a level one blow before it can arrive.
   */
  it('fills exactly as the level arrives, for an origin that levels slower', () => {
    const mod = INDEXED.experienceMult;
    for (const level of [1, 5, 12, 30]) {
      const need = shown(level, mod);
      expect(gainExp(level, 0, need - 1, mod).levelsGained, `at ${String(level)}`).toBe(0);
      expect(gainExp(level, 0, need, mod).levelsGained, `at ${String(level)}`).toBe(1);
    }
  });

  /**
   * AND THE TWO ORIGINS GENUINELY DIFFER, so the pair above is not passing
   * because `expMod` is being ignored on both sides at once — which is exactly
   * how the bug looked from inside `gainExp`'s own tests.
   */
  it('shows a bigger number to the origin that pays more', () => {
    for (const level of [1, 10, 40]) {
      expect(shown(level, INDEXED.experienceMult)).toBeGreaterThan(
        shown(level, CITYBORN.experienceMult),
      );
    }
  });

  /**
   * A POINT-GRANTING ORIGIN CHANGES NO THRESHOLD. `classPointBonus` moves what a
   * level PAYS OUT; `experienceMult` moves what it COSTS. Stated because the two
   * live next to each other on `OriginDef` and reaching for the wrong one would
   * be a plausible mistake with no visible symptom.
   */
  it('leaves the threshold alone for an origin that only grants points', () => {
    expect(classPointBonus(CITYBORN).every).toBe(10);
    expect(shown(9, CITYBORN.experienceMult)).toBe(expChart(10));
  });
});

describe('the wiring, which is where it actually broke', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * A SOURCE GUARD, for `point-purses.test.ts`'s reason.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `sendProgress` is a closure inside the gateway and every gateway test in the
   * tree injects its own engine, so no test can drive the real one. The
   * invariant above held in the abstract the whole time the bar was wrong: the
   * defect was one call site passing the chart ONE argument.
   *
   * So this asserts the argument by name. It is the crudest test in the file and
   * the only one that would have caught the bug.
   */
  it('asks the chart with the body’s own multiplier', () => {
    const gateway = readFileSync(
      new URL('../../src/server/net/gateway.ts', import.meta.url),
      'utf8',
    );
    expect(gateway).toContain('expChart(viewer.level + 1, viewer.expMod ?? 1)');
    expect(
      gateway,
      'the bare call is back — an origin that levels slower now has a lying bar',
    ).not.toContain('expChart(viewer.level + 1),');
  });
});
