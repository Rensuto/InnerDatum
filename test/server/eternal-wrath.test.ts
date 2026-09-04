import { describe, expect, it } from 'vitest';

import { EffectId, createMvpEffectState } from '../../src/server/content/effects.ts';
import {
  BASELINE_LIFE_RATING,
  UNFILED,
  originLifeDelta,
} from '../../src/server/content/origins.ts';
import { resolveItem } from '../../src/server/content/resolve.ts';
import { createPlayerActor } from '../../src/server/engine/actor.ts';
import {
  DamageType,
  combatGetDamageIncrease,
  combatGetResist,
} from '../../src/server/engine/damage.ts';
import { combatMentalResist, combatPhysicalResist } from '../../src/server/engine/derived.ts';
import { recomposeCombat, statusApplier } from '../../src/server/engine/effects.ts';
import { composeWielders } from '../../src/server/engine/equipment.ts';
import type { EffectActor, EquippedActor } from '../../src/server/engine/effects.ts';
import { createRng } from '../../src/shared/rng.ts';
import { combatStatScale } from '../../src/shared/scale.ts';
import { unshackled } from '../../src/server/talents/unshackled.ts';
import { wrathOfTheWoods } from '../../src/server/talents/wrath_of_the_woods.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WRATH OF THE WOODS — races.lua:311-330, physical.lua:801-819.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `Wielder.damageAll` is a WRITER FOR A READER THAT WAS ALREADY CORRECT:
 * `combatGetDamageIncrease` has summed the `all` row with the typed one since
 * damage.ts was written, and nothing could put a number there. That is the
 * shape this codebase keeps producing, and the shape a unit test on either half
 * cannot see — so every assertion below reads the number the DAMAGE MATHS gets,
 * never the field the fold wrote.
 */

function body(): EquippedActor & EffectActor {
  return createPlayerActor('p1', { name: 'Dalt', sprite: 'pc_detective_s', x: 1, y: 1 });
}

function wrathed(power: number): EquippedActor & EffectActor {
  const state = createMvpEffectState();
  const actor = body();
  statusApplier(state, createRng('wrath'))(actor, EffectId.EternalWrath, 3, { power });
  recomposeCombat(actor, state, resolveItem);
  return actor;
}

describe('the damage half reaches the damage maths', () => {
  /**
   * EVERY TYPE, WHICH IS WHAT `all` MEANS. Asserted across the whole roster
   * rather than one type, because a fold that wrote the number into a single
   * typed row instead of `'all'` would pass a one-type test.
   */
  it('raises the increase for every damage type at once', () => {
    const actor = wrathed(15);
    for (const type of [
      DamageType.Physical,
      DamageType.Fire,
      DamageType.Cold,
      DamageType.Lightning,
      DamageType.Darkness,
      DamageType.Mind,
    ]) {
      expect(combatGetDamageIncrease(actor.combat?.increase, type), type).toBe(15);
    }
  });

  /**
   * ═══ AND IT SUMS WITH A TYPED ROW, WHERE THE RESIST `all` MULTIPLIES ═══
   * damage_types.lua:202 is `(inc_damage.all or 0) + (inc_damage[type] or 0)`.
   * This is the assertion that separates the two `all` rows, and it is the one
   * that catches a fold copied from `resistAll` without reading the algebra: a
   * multiplicative composition would give 10.5 here, not 15.
   */
  it('adds to a typed increase rather than scaling it', () => {
    /**
     * DRIVEN THROUGH `composeWielders` AND NOT THROUGH AN ACTOR, deliberately.
     * The first draft hand-set `actor.combat.increase` and then called
     * `recomposeCombat`, which REBUILDS from the base sheet and discarded it —
     * the typed row was gone before the effect ever folded, and the test failed
     * against correct production code. `composeWielders` is the fold itself, and
     * a `base` argument is the honest way to say "this body already had one".
     *
     * A typed increase is the real shape, not a contrived one: the Alchemist's
     * whole identity is `increase: { fire: 10 }` (classes.ts:579).
     */
    const base = { increase: Object.freeze({ [DamageType.Fire]: 5 }) } as never;
    const folded = composeWielders(base, [{ damageAll: 10 }]);

    expect(combatGetDamageIncrease(folded.increase, DamageType.Fire), 'typed + all').toBe(15);
    expect(combatGetDamageIncrease(folded.increase, DamageType.Cold), 'all alone').toBe(10);
  });

  /**
   * AND TWO SOURCES OF `all` SUM WITH EACH OTHER, which is the property the
   * whole additive fold exists to guarantee — `equipment.ts` argues at length
   * that additive-only is what makes unequip exact by construction.
   */
  it('adds two all-rows together rather than taking the larger', () => {
    const folded = composeWielders({}, [{ damageAll: 10 }, { damageAll: 5 }]);
    expect(combatGetDamageIncrease(folded.increase, DamageType.Cold)).toBe(15);
  });
});

describe('the defensive half', () => {
  /**
   * THE SAME NUMBER, THROUGH `combatGetResist` — the function `applyDamage`
   * calls. `toBeCloseTo` because the `all` row composes MULTIPLICATIVELY there
   * (Combat.lua:2227-2228) and the product is not exact in binary.
   */
  it('takes its percentage off every damage type', () => {
    const actor = wrathed(15);
    for (const type of [DamageType.Physical, DamageType.Fire, DamageType.Darkness]) {
      expect(combatGetResist(actor.combat?.profile ?? {}, type), type).toBeCloseTo(15, 6);
    }
  });

  /**
   * AND A BARE BODY HAS NEITHER, so the two blocks above are not passing against
   * a fixture that was already resistant. The cheapest test in the file and the
   * one that makes the others mean something.
   */
  it('is nothing at all without the effect', () => {
    const actor = body();
    recomposeCombat(actor, createMvpEffectState(), resolveItem);
    expect(combatGetDamageIncrease(actor.combat?.increase, DamageType.Fire)).toBe(0);
    expect(combatGetResist(actor.combat?.profile ?? {}, DamageType.Fire)).toBe(0);
  });
});

describe('the numbers the talent computes', () => {
  /** `combatStatScale("wil", 11, 20)` — races.lua:318, asserted against the curve. */
  it('scales the power off Willpower', () => {
    for (const wil of [10, 40, 100]) {
      const desc = wrathOfTheWoods.describe({ combat: { stats: { wil } } } as never, 1);
      const power = String(Math.round(combatStatScale(wil, 11, 20)));
      expect(desc, `at wil ${String(wil)}`).toContain(`deal ${power}% more damage`);
      expect(desc, `and the same number twice`).toContain(`take ${power}% less`);
    }
  });

  /** The two ends, exactly — Combat.lua:1548. */
  it('matches upstream at both implied stat values', () => {
    expect(combatStatScale(10, 11, 20)).toBeCloseTo(11, 10);
    expect(combatStatScale(100, 11, 20)).toBeCloseTo(20, 10);
  });
});

describe('Unshackled', () => {
  /**
   * TWO SAVES AND NOT THE THIRD. Spell is deliberately absent — races.lua:339-340
   * writes `combat_physresist` and `combat_mentalresist` and nothing else, and a
   * third would be an invention wearing a citation.
   */
  it('raises the physical and mental saves and leaves spell alone', () => {
    // `(level, view)` — level first. Labelled because this signature has been
    // got backwards before, and a passive that silently returns nothing is quiet.
    const granted = unshackled.passive?.(1, {} as never);
    expect(granted?.mods?.physResist).toBe(6);
    expect(granted?.mods?.mentalResist).toBe(6);
    expect(granted?.mods?.spellResist, 'upstream writes two channels, not three').toBeUndefined();
  });

  /**
   * AND IT REACHES THE READERS. Asserted as an identity for
   * `archival-resilience.test.ts`'s reason: `save()` puts the flat bonus inside
   * `rescaleCombatStats`, so six points of grant is not six points of save.
   */
  it('moves the numbers the saves are read from', () => {
    const actor = body();
    recomposeCombat(actor, createMvpEffectState(), resolveItem);
    const bare = { ...(actor.combat ?? {}) };

    const buffed = { ...bare, mods: { ...bare.mods, physResist: 6, mentalResist: 6 } };
    expect(combatPhysicalResist(buffed)).toBe(combatPhysicalResist(bare, 6));
    expect(combatMentalResist(buffed)).toBe(combatMentalResist(bare, 6));
    expect(combatPhysicalResist(buffed)).toBeGreaterThan(combatPhysicalResist(bare));
  });
});

describe('the origin that grants them', () => {
  /**
   * THE LUA TABLE, NOT UPSTREAM'S OWN BLURB. elf.lua's description lists three
   * modifiers and the table carries five — the Willpower and the Magic penalty
   * are both absent from the prose. Pinned at five so a later "correction"
   * against the blurb fails here.
   */
  it('carries the stat spread the table declares, not the one it describes', () => {
    expect(UNFILED.statMods).toEqual({ str: 2, dex: 3, con: 1, mag: -2, wil: 1 });
    expect(Object.keys(UNFILED.statMods).length, 'five, not the blurb’s three').toBe(5);
  });

  /** `life_rating = 11`, `experience = 1.35` (elf.lua). */
  it('is the fastest learner to punish and the lightest of the three penalised', () => {
    expect(UNFILED.lifeRating).toBe(BASELINE_LIFE_RATING + 1);
    expect(originLifeDelta(UNFILED)).toBe(1);
    expect(UNFILED.experienceMult).toBe(1.35);
  });

  /** Both ported talents, in upstream's tier order. */
  it('grants both of the talents that are pure content ports', () => {
    expect(UNFILED.talents?.map((talent) => talent.id)).toEqual([
      wrathOfTheWoods.id,
      unshackled.id,
    ]);
  });

  /** No birth points and no period — see `archival-resilience.test.ts` for why absence. */
  it('buys nothing with points', () => {
    expect(UNFILED.birthPoints).toBeUndefined();
    expect(UNFILED.extraPointEvery).toBeUndefined();
  });
});
