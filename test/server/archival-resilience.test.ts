import { describe, expect, it } from 'vitest';

import {
  ARCHIVAL_RESILIENCE,
  EffectId,
  createMvpEffectState,
} from '../../src/server/content/effects.ts';
import {
  ARCHIVED,
  BASELINE_LIFE_RATING,
  originLifeDelta,
} from '../../src/server/content/origins.ts';
import { resolveItem } from '../../src/server/content/resolve.ts';
import { createPlayerActor } from '../../src/server/engine/actor.ts';
import {
  combatArmor,
  combatArmorHardiness,
  combatPhysicalResist,
  combatSpellResist,
} from '../../src/server/engine/derived.ts';
import {
  EffectStatus,
  recomposeCombat,
  statusApplier,
  statusCurer,
} from '../../src/server/engine/effects.ts';
import type { EffectActor, EquippedActor } from '../../src/server/engine/effects.ts';
import { createRng } from '../../src/shared/rng.ts';
import { combatStatScale } from '../../src/shared/scale.ts';
import { resilienceOfTheArchived } from '../../src/server/talents/resilience_of_the_archived.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * RESILIENCE OF THE ARCHIVED — races.lua:451-478, physical.lua:3524-3559.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * FOUR CHANNELS IN ONE PRESS, which is what makes this worth its own file: the
 * failure this codebase keeps producing is a correct value with no reader, and
 * this talent has four chances at it. Three of the four are read by a different
 * function, so a fold that dropped one would leave the other three passing.
 *
 * Every assertion below goes through the DERIVED READER — `combatArmor`, not
 * `mods.armour` — for `wild-infusion.test.ts`'s reason: a field that moved is
 * not a body that takes less damage.
 */

function body(): EquippedActor & EffectActor {
  return createPlayerActor('p1', {
    name: 'Dalt',
    sprite: 'pc_detective_s',
    x: 1,
    y: 1,
  });
}

describe('the four channels the effect grants', () => {
  /**
   * ═══ THE JOIN, DRIVEN THROUGH THE REAL APPLIER ═══
   * `statusApplier` is what the talent's `ctx.status` resolves to in play, and
   * `recomposeCombat` is the fold. Between them they are every step from "the
   * talent handed over a `grants` block" to "the number a hit is measured
   * against changed" — which is the span where the last two bugs of this shape
   * lived, both of them with correct halves on either side.
   */
  it('raises armour, hardiness and both saves at once', () => {
    const state = createMvpEffectState();
    const apply = statusApplier(state, createRng('archival-fold'));
    const actor = body();
    recomposeCombat(actor, state, resolveItem);

    // A SNAPSHOT, not a live reference — `recomposeCombat` rebuilds `actor.combat`
    // in place, so holding the object would compare the buffed body with itself.
    const bare = { ...(actor.combat ?? {}) };
    const before = {
      armour: combatArmor(actor.combat ?? {}),
      hardiness: combatArmorHardiness(actor.combat ?? {}),
      phys: combatPhysicalResist(actor.combat ?? {}),
      spell: combatSpellResist(actor.combat ?? {}),
    };

    apply(actor, EffectId.ArchivalResilience, 4, {
      grants: { armour: 12, armourHardiness: 20, physResist: 17, spellResist: 17 },
    });
    recomposeCombat(actor, state, resolveItem);

    expect(combatArmor(actor.combat ?? {}), 'armour').toBe(before.armour + 12);
    expect(combatArmorHardiness(actor.combat ?? {}), 'hardiness').toBe(before.hardiness + 20);

    /**
     * ═══ THE SAVES ARE ASSERTED AS AN IDENTITY, BECAUSE THEY ARE NOT LINEAR ═══
     * `save()` puts the flat bonus INSIDE `rescaleCombatStats` (derived.ts:643),
     * so a grant of 17 does not raise the save by 17 — the tier curve compresses
     * it, and the first draft of this test asserted `before + 17` and failed at
     * 22. That draft was checking my arithmetic rather than the game.
     *
     * `add` enters the same sum as the folded `mods.physResist`, so a bare body
     * asked for the bonus must land exactly where a buffed body lands. That
     * holds at every point on the curve and needs no number written down.
     */
    expect(combatPhysicalResist(actor.combat ?? {}), 'physical save').toBe(
      combatPhysicalResist(bare, 17),
    );
    expect(combatSpellResist(actor.combat ?? {}), 'spell save').toBe(combatSpellResist(bare, 17));
    expect(combatPhysicalResist(actor.combat ?? {}), 'and it did move').toBeGreaterThan(
      before.phys,
    );
  });

  /**
   * ═══ AND ALL FOUR GO BACK ═══
   * A buff that never lifts is a permanent one. Named separately because the
   * fold and the unfold are different code: `recomposeCombat` rebuilds from the
   * live effect list, so an effect that outlived its duration would show here
   * and nowhere else.
   */
  it('gives every one of them back when it ends', () => {
    const state = createMvpEffectState();
    const apply = statusApplier(state, createRng('archival-unfold'));
    const actor = body();
    recomposeCombat(actor, state, resolveItem);
    const bare = combatArmor(actor.combat ?? {});

    apply(actor, EffectId.ArchivalResilience, 4, { grants: { armour: 12, armourHardiness: 20 } });
    recomposeCombat(actor, state, resolveItem);
    expect(combatArmor(actor.combat ?? {})).toBe(bare + 12);

    statusCurer(state, createRng('archival-cure'))(actor, EffectStatus.Beneficial);
    recomposeCombat(actor, state, resolveItem);
    expect(combatArmor(actor.combat ?? {}), 'armour').toBe(bare);
    expect(combatArmorHardiness(actor.combat ?? {}), 'hardiness').toBe(30);
  });

  /**
   * THE DEFAULTS ARE UPSTREAM'S, and hardiness is deliberately NOT among them —
   * physical.lua:3537 declares `{ armor=10, spell=10, physical=10 }` and nothing
   * else, even though `activate` reads `eff.armor_hardiness`. An application
   * carrying no grants at all must therefore move three channels and leave
   * hardiness at its base 30.
   */
  it('falls back to upstream’s three declared parameters', () => {
    const state = createMvpEffectState();
    const apply = statusApplier(state, createRng('archival-defaults'));
    const actor = body();
    recomposeCombat(actor, state, resolveItem);
    const bareCombat = { ...(actor.combat ?? {}) };
    const bare = combatArmor(actor.combat ?? {});

    apply(actor, EffectId.ArchivalResilience, 4, {});
    recomposeCombat(actor, state, resolveItem);

    expect(combatArmor(actor.combat ?? {})).toBe(bare + 10);
    // As an identity, for the reason given in the first test of this file.
    expect(combatPhysicalResist(actor.combat ?? {})).toBe(combatPhysicalResist(bareCombat, 10));
    expect(combatSpellResist(actor.combat ?? {})).toBe(combatSpellResist(bareCombat, 10));
    expect(combatArmorHardiness(actor.combat ?? {}), 'undeclared upstream').toBe(30);
    expect(ARCHIVAL_RESILIENCE.parameters?.grants?.armourHardiness).toBeUndefined();
  });
});

describe('the numbers the talent computes', () => {
  /**
   * ═══ ASSERTED AGAINST THE CURVE, NOT AGAINST A PINNED NUMBER ═══
   * `xp-bar.test.ts`'s rule. Naming 12 here would need editing whenever the
   * curve is retuned and still would not check that the talent reads CON.
   */
  it('scales armour and both saves off Constitution', () => {
    for (const con of [10, 30, 60, 100]) {
      // `(self, level)` — the level is ignored by this talent, which is capped at
      // rank 1, but the signature is not optional.
      const desc = resilienceOfTheArchived.describe({ combat: { stats: { con } } } as never, 1);
      /**
       * THE WHOLE PHRASE, not the bare number. A `toContain('7')` passes on the
       * "23 turn cooldown" at the end of the same sentence, which would make
       * this test true of any description long enough.
       */
      expect(desc, `armour at con ${String(con)}`).toContain(
        `gain ${String(Math.round(combatStatScale(con, 7, 25)))} armour`,
      );
      expect(desc, `saves at con ${String(con)}`).toContain(
        `and ${String(Math.round(combatStatScale(con, 12, 30, 0.75)))} to both`,
      );
    }
  });

  /**
   * AND THE CURVE ACTUALLY CLIMBS. The pair above would pass against a talent
   * that ignored CON entirely if `combatStatScale` were flat, which is exactly
   * the mistake `power = 1` would introduce — see `combatStatScale`'s note.
   */
  it('gives a sturdier body a bigger grant', () => {
    expect(combatStatScale(100, 7, 25)).toBeGreaterThan(combatStatScale(10, 7, 25));
    expect(combatStatScale(60, 12, 30, 0.75)).toBeGreaterThan(combatStatScale(20, 12, 30, 0.75));
  });

  /** `combatStatScale`'s two anchors — Combat.lua:1548. Both ends, exactly. */
  it('matches upstream at the two implied stat values', () => {
    expect(combatStatScale(10, 7, 25)).toBeCloseTo(7, 10);
    expect(combatStatScale(100, 7, 25)).toBeCloseTo(25, 10);
    expect(combatStatScale(10, 12, 30, 0.75)).toBeCloseTo(12, 10);
    expect(combatStatScale(100, 12, 30, 0.75)).toBeCloseTo(30, 10);
    expect(combatStatScale(10, 1, 5, 'log'), 'the log branch too').toBeCloseTo(1, 10);
    expect(combatStatScale(100, 1, 5, 'log')).toBeCloseTo(5, 10);
  });
});

describe('the origin that grants it', () => {
  /**
   * VERBATIM, INCLUDING THE NEGATIVES — dwarf.lua:71. The two subtractions are
   * the only ones in the game, so an origin table that silently dropped a
   * negative would still look like a plausible origin.
   */
  it('carries upstream’s stat spread, both directions', () => {
    expect(ARCHIVED.statMods).toEqual({ str: 4, dex: -2, con: 3, mag: -2, wil: 3 });
    const total = Object.values(ARCHIVED.statMods).reduce((sum, n) => sum + n, 0);
    expect(total, 'six points net, not ten').toBe(6);
  });

  /** `life_rating = 12` (dwarf.lua:80) against the baseline ten — see the header of `origins.ts`. */
  it('contributes two life per level over the baseline', () => {
    expect(ARCHIVED.lifeRating).toBe(BASELINE_LIFE_RATING + 2);
    expect(originLifeDelta(ARCHIVED)).toBe(2);
  });

  /** `experience = 1.25` (dwarf.lua:87). The steepest penalty in the game. */
  it('pays a quarter more experience for every level', () => {
    expect(ARCHIVED.experienceMult).toBe(1.25);
  });

  /**
   * ONE TALENT, AND THAT IS THE PORTED SHAPE rather than an accident — the tree
   * entry names the three that are missing and why. Pinned so that adding a
   * second one is a deliberate edit here as well as there.
   */
  it('grants exactly the one talent that is a pure content port', () => {
    expect(ARCHIVED.talents?.map((talent) => talent.id)).toEqual([resilienceOfTheArchived.id]);
  });

  /**
   * AND IT BUYS NOTHING WITH POINTS. Only the Cityborn get birth points and the
   * every-tenth-level bonus (`copy_add` / `extra_*_every`, human.lua:60-70); the
   * Archived pay in experience instead. Absence is the assertion because
   * `DEFAULT_ORIGIN` is the Cityborn, so a body that lost its origin would read
   * as HAVING these — the direction `gateway-progression.test.ts` pins.
   */
  it('grants no birth points and no extra-point period', () => {
    expect(ARCHIVED.birthPoints).toBeUndefined();
    expect(ARCHIVED.extraPointEvery).toBeUndefined();
  });
});
