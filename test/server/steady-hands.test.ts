import { describe, expect, it } from 'vitest';

import { critChanceAt, critPowerAt } from '../../src/server/talents/steady_hands.ts';
import { combatTalentScale } from '../../src/shared/scale.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * SLING SNIPER'S TWO CURVES ARE NOT THE SAME CURVE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `cunning/called-shots.lua:25-26`, verbatim:
 *
 *     bonuses.crit_chance = self:combatTalentScale(t, 3, 10)
 *     bonuses.crit_power  = self:combatTalentScale(t, 0.1, 0.2, 0.75)
 *
 * The chance line passes NO power and takes the 0.5 default (Combat.lua:1518);
 * only the power line passes 0.75. `steady_hands.ts` had one `CURVE = 0.75`
 * constant feeding both, which contradicted its own NUMBERS header — the header
 * has always attached the 0.75 to crit POWER alone.
 *
 * WHY NOTHING CAUGHT IT: `combatTalentScale` returns `low` at rank 1 and `high`
 * at rank 5 whatever the power, so the two ends agreed and only the interior
 * moved. This file existed for no other reason than that nobody had measured
 * the middle.
 */
describe('steady hands carries upstream’s two curves', () => {
  it('scales crit CHANCE on the default power, as called-shots.lua:25 does', () => {
    for (const rank of [1, 2, 3, 4, 5]) {
      // No fourth argument on either side — that IS the assertion.
      expect(critChanceAt(rank)).toBe(Math.round(combatTalentScale(rank, 3, 10)));
    }
  });

  it('scales crit POWER at 0.75, as called-shots.lua:26 does', () => {
    for (const rank of [1, 2, 3, 4, 5]) {
      expect(critPowerAt(rank)).toBe(Math.round(combatTalentScale(rank, 10, 20, 0.75)));
    }
  });

  it('differs from the one-curve version at rank 4, which is where it hid', () => {
    // ═══ THE ONE RANK THE BUG WAS VISIBLE AT ═══
    // Both ends are pinned by the helper, so rank 4 is the only 1..5 rank whose
    // rounded value moves: 8.66 -> 9 on upstream's rule, 8.46 -> 8 on the wrong
    // one. Naming it here means a silent revert to a single CURVE fails.
    expect(critChanceAt(4)).toBe(9);
    expect(Math.round(combatTalentScale(4, 3, 10, 0.75))).toBe(8);
  });

  it('keeps diverging past rank 5, which mastery makes reachable', () => {
    // scale.ts: "NEVER CLAMP THE TALENT LEVEL AT 5" — category mastery pushes
    // effective levels above it, so the interior difference is not academic.
    expect(critChanceAt(10)).toBe(15);
    expect(Math.round(combatTalentScale(10, 3, 10, 0.75))).toBe(17);
  });

  it('pins both endpoints, which the bug never moved', () => {
    expect(critChanceAt(1)).toBe(3);
    expect(critChanceAt(5)).toBe(10);
    expect(critPowerAt(1)).toBe(10);
    expect(critPowerAt(5)).toBe(20);
  });
});
