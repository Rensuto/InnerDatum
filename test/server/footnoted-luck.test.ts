import { describe, expect, it } from 'vitest';

import { EffectId, createMvpEffectState } from '../../src/server/content/effects.ts';
import {
  BASELINE_LIFE_RATING,
  FOOTNOTED,
  originLifeDelta,
} from '../../src/server/content/origins.ts';
import { resolveItem } from '../../src/server/content/resolve.ts';
import { createPlayerActor } from '../../src/server/engine/actor.ts';
import {
  combatCrit,
  combatMentalResist,
  combatPhysicalResist,
  combatSpellResist,
} from '../../src/server/engine/derived.ts';
import { recomposeCombat, statusApplier } from '../../src/server/engine/effects.ts';
import type { EffectActor, EquippedActor } from '../../src/server/engine/effects.ts';
import { createRng } from '../../src/shared/rng.ts';
import { combatStatScale } from '../../src/shared/scale.ts';
import { luckOfTheFootnoted } from '../../src/server/talents/luck_of_the_footnoted.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * LUCK OF THE FOOTNOTED — races.lua:553-577, mental.lua:1631-1647.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * FOUR CHANNELS, THREE OF THEM READ BY A DIFFERENT FUNCTION. That is what makes
 * this worth a file: a fold that dropped one save would leave the other two and
 * the crit passing, which is exactly how the last two bugs of this shape looked.
 *
 * Every assertion goes through the DERIVED READER rather than off the sheet.
 */

function body(): EquippedActor & EffectActor {
  return createPlayerActor('p1', { name: 'Dalt', sprite: 'pc_detective_s', x: 1, y: 1 });
}

describe('the four channels the effect grants', () => {
  /**
   * ═══ ALL THREE SAVES, ASSERTED AS AN IDENTITY ═══
   * `save()` puts the flat bonus inside `rescaleCombatStats`, so a grant of 20
   * does not raise a save by 20 — `archival-resilience.test.ts` records the
   * draft that failed at 22 for assuming it did. `reader(bare, n)` is the same
   * arithmetic from the other side and needs no number written down.
   */
  it('raises every save and the critical chance at once', () => {
    const state = createMvpEffectState();
    const actor = body();
    recomposeCombat(actor, state, resolveItem);
    const bare = { ...(actor.combat ?? {}) };
    const critBefore = combatCrit(bare);

    statusApplier(state, createRng('luck'))(actor, EffectId.FootnotedLuck, 3, {
      grants: { genericCrit: 20, physResist: 20, spellResist: 20, mentalResist: 20 },
    });
    recomposeCombat(actor, state, resolveItem);
    const after = actor.combat ?? {};

    expect(combatPhysicalResist(after), 'physical').toBe(combatPhysicalResist(bare, 20));
    expect(combatSpellResist(after), 'spell').toBe(combatSpellResist(bare, 20));
    expect(combatMentalResist(after), 'mental').toBe(combatMentalResist(bare, 20));
    expect(combatCrit(after), 'critical chance').toBe(critBefore + 20);
  });

  /**
   * AND THE SPELL SAVE IS NOT ALONG FOR THE RIDE. `unshackled.ts` raises the
   * physical and the mental and deliberately NOT the spell, so a fold that
   * quietly wrote all three whenever it saw two would pass that talent's test
   * and this one. Asserted here because this is the only talent in the game
   * that legitimately moves all three.
   */
  it('is the only grant that moves the spell save too', () => {
    const state = createMvpEffectState();
    const actor = body();
    recomposeCombat(actor, state, resolveItem);
    const bare = { ...(actor.combat ?? {}) };

    statusApplier(state, createRng('luck-spell'))(actor, EffectId.FootnotedLuck, 3, {
      grants: { physResist: 20, mentalResist: 20 },
    });
    recomposeCombat(actor, state, resolveItem);

    expect(combatSpellResist(actor.combat ?? {}), 'nothing granted it').toBe(
      combatSpellResist(bare),
    );
  });

  /** `parameters = { crit = 10, save = 10 }` — mental.lua:1638, all four rows. */
  it('falls back to upstream’s declared ten', () => {
    const state = createMvpEffectState();
    const actor = body();
    recomposeCombat(actor, state, resolveItem);
    const bare = { ...(actor.combat ?? {}) };

    statusApplier(state, createRng('luck-default'))(actor, EffectId.FootnotedLuck, 3, {});
    recomposeCombat(actor, state, resolveItem);

    expect(combatPhysicalResist(actor.combat ?? {})).toBe(combatPhysicalResist(bare, 10));
    expect(combatSpellResist(actor.combat ?? {})).toBe(combatSpellResist(bare, 10));
    expect(combatMentalResist(actor.combat ?? {})).toBe(combatMentalResist(bare, 10));
  });
});

describe('the number the talent computes', () => {
  /** `combatStatScale("cun", 15, 60, 0.75)` — races.lua:562-563. */
  it('scales off Cunning, and spends the one number twice', () => {
    for (const cun of [10, 40, 100]) {
      const desc = luckOfTheFootnoted.describe({ combat: { stats: { cun } } } as never, 1);
      const power = String(Math.round(combatStatScale(cun, 15, 60, 0.75)));
      expect(desc, `at cun ${String(cun)}`).toContain(`gain ${power}% critical chance`);
      expect(desc, 'and the same figure on the saves').toContain(`and ${power} to all three saves`);
    }
  });

  /** The two anchors, exactly — Combat.lua:1548. */
  it('matches upstream at both implied stat values', () => {
    expect(combatStatScale(10, 15, 60, 0.75)).toBeCloseTo(15, 10);
    expect(combatStatScale(100, 15, 60, 0.75)).toBeCloseTo(60, 10);
  });
});

describe('the origin that grants it', () => {
  /**
   * VERBATIM EXCEPT FOR THE ONE THIS GAME CANNOT HOLD. halfling.lua declares
   * `lck = 5` and there is no Luck stat here, so the spread is four entries
   * rather than five. Pinned at four WITH the reason, so a later reader does not
   * "restore" a stat that has nothing to write to.
   */
  it('carries upstream’s spread, minus the stat this game does not have', () => {
    expect(FOOTNOTED.statMods).toEqual({ str: -3, dex: 3, con: 1, cun: 3 });
    expect(
      (FOOTNOTED.statMods as Record<string, number>)['lck'],
      'there is no Luck stat to grant',
    ).toBeUndefined();
  });

  /** THE ONLY ORIGIN THAT TAKES STRENGTH AWAY, and it takes three. */
  it('is the slightest body in the game', () => {
    expect(FOOTNOTED.statMods.str).toBe(-3);
    expect(FOOTNOTED.lifeRating).toBe(BASELINE_LIFE_RATING + 2);
    expect(originLifeDelta(FOOTNOTED)).toBe(2);
  });

  /** `experience = 1.20` (halfling.lua). */
  it('pays a fifth more experience for every level', () => {
    expect(FOOTNOTED.experienceMult).toBe(1.2);
  });

  it('grants exactly the one talent that is a pure content port', () => {
    expect(FOOTNOTED.talents?.map((talent) => talent.id)).toEqual([luckOfTheFootnoted.id]);
  });

  /** No birth points and no period — see `archival-resilience.test.ts` for why absence. */
  it('buys nothing with points', () => {
    expect(FOOTNOTED.birthPoints).toBeUndefined();
    expect(FOOTNOTED.extraPointEvery).toBeUndefined();
  });
});
