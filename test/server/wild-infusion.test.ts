import { describe, expect, it } from 'vitest';

import { EffectId, createMvpEffectState } from '../../src/server/content/effects.ts';
import { resolveItem } from '../../src/server/content/resolve.ts';
import { createPlayerActor } from '../../src/server/engine/actor.ts';
import { combatGetResist } from '../../src/server/engine/damage.ts';
import { DamageType } from '../../src/server/engine/damage.ts';
import {
  EffectStatus,
  SaveChannel,
  recomposeCombat,
  statusApplier,
  statusCurer,
} from '../../src/server/engine/effects.ts';
import type { EffectActor, EquippedActor } from '../../src/server/engine/effects.ts';
import { createRng } from '../../src/shared/rng.ts';
import { wildInfusion } from '../../src/server/talents/wild_infusion.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE WILD INFUSION — inscriptions.lua:134-165, human.lua:54.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The two halves that can each be right while the whole is wrong: the CURE picks
 * the correct effects off a body carrying several, and the `all` RESIST ROW
 * reaches the number the damage maths actually reads.
 */

function body(): EquippedActor & EffectActor {
  const actor = createPlayerActor('p1', {
    name: 'Dalt',
    sprite: 'pc_detective_s',
    x: 1,
    y: 1,
  }) as unknown as EquippedActor & EffectActor;
  return actor;
}

describe('the all-resist row reaches the damage maths', () => {
  /**
   * ═══ ASSERTED THROUGH `combatGetResist`, NOT OFF THE SHEET ═══
   * `buff-channel.test.ts` makes this argument for defence and it applies here:
   * a field that moved is not a body that takes less damage. `combatGetResist`
   * is what `applyDamage` calls, so this is the number that matters.
   */
  it('takes its percentage off every damage type at once', () => {
    const state = createMvpEffectState();
    const rng = createRng('wild-resist');
    const apply = statusApplier(state, rng);
    const actor = body();

    recomposeCombat(actor, state, resolveItem);
    for (const type of [DamageType.Physical, DamageType.Fire, DamageType.Darkness]) {
      expect(combatGetResist(actor.combat?.profile ?? {}, type), `${type} before`).toBe(0);
    }

    apply(actor, EffectId.PainSuppression, 2, { power: 14 });
    recomposeCombat(actor, state, resolveItem);

    /**
     * EVERY TYPE, which is the whole point of the `all` row — six typed bonuses
     * would be a different effect the moment the body resisted anything.
     *
     * `toBeCloseTo` BECAUSE THE COMPOSITION IS MULTIPLICATIVE. `combatGetResist`
     * computes `100 * (1 - (1 - a) * (1 - b))` (Combat.lua:2227-2228), which
     * lands on 14.000000000000002 rather than 14. That drift is not noise to be
     * tidied away — it is the evidence that the number went through the `all`
     * path instead of being added to a typed row, which is the thing under test.
     */
    for (const type of [DamageType.Physical, DamageType.Fire, DamageType.Darkness]) {
      expect(combatGetResist(actor.combat?.profile ?? {}, type), `${type} after`).toBeCloseTo(
        14,
        6,
      );
    }
  });

  /** …and it leaves cleanly, which is what recompute-from-base buys. */
  it('gives the resistance back when it runs out', () => {
    const state = createMvpEffectState();
    const rng = createRng('wild-expiry');
    const apply = statusApplier(state, rng);
    const cure = statusCurer(state, rng);
    const actor = body();

    apply(actor, EffectId.PainSuppression, 2, { power: 14 });
    recomposeCombat(actor, state, resolveItem);
    expect(combatGetResist(actor.combat?.profile ?? {}, DamageType.Fire)).toBeCloseTo(14, 6);

    cure(actor, EffectStatus.Beneficial);
    recomposeCombat(actor, state, resolveItem);
    expect(combatGetResist(actor.combat?.profile ?? {}, DamageType.Fire)).toBe(0);
  });
});

describe('the cure picks the right debuffs off', () => {
  /**
   * ═══ TWO CLAUSES, NOT ONE CLAUSE TWICE — inscriptions.lua:152-156 ═══
   * Upstream removes every CROSS-TIER effect of the type, then ONE ordinary one.
   * Collapsing that into "remove two" takes one too many off a body with no
   * cross-tier effect, which is most bodies most of the time.
   */
  it('takes the cross-tier one AND one ordinary one when both are there', () => {
    const state = createMvpEffectState();
    const rng = createRng('wild-cure-both');
    const apply = statusApplier(state, rng);
    const cure = statusCurer(state, rng);
    const actor = body();

    apply(actor, EffectId.Bleeding, 5, { power: 3 });
    apply(actor, EffectId.Slowed, 5, {});
    apply(actor, EffectId.OffBalance, 5, {});

    const tier = cure(actor, EffectStatus.Detrimental, {
      channel: SaveChannel.Physical,
      crossTierOnly: true,
    });
    const ordinary = cure(actor, EffectStatus.Detrimental, { channel: SaveChannel.Physical });

    expect(tier, 'the cross-tier clause').toBe('Off-balance');
    expect(ordinary, 'the ordinary clause').not.toBeNull();
    expect(ordinary).not.toBe('Off-balance');
  });

  /**
   * AND WITH NO CROSS-TIER EFFECT PRESENT the first clause takes NOTHING —
   * which is the case that would have been wrong had the two clauses been
   * collapsed into a pair of unfiltered cures.
   */
  it('takes only one when there is no cross-tier effect to take', () => {
    const state = createMvpEffectState();
    const rng = createRng('wild-cure-one');
    const apply = statusApplier(state, rng);
    const cure = statusCurer(state, rng);
    const actor = body();

    apply(actor, EffectId.Bleeding, 5, { power: 3 });
    apply(actor, EffectId.Slowed, 5, {});

    expect(
      cure(actor, EffectStatus.Detrimental, {
        channel: SaveChannel.Physical,
        crossTierOnly: true,
      }),
      'nothing is cross-tier here',
    ).toBeNull();
    expect(cure(actor, EffectStatus.Detrimental, { channel: SaveChannel.Physical })).not.toBeNull();
  });

  /**
   * ═══ PHYSICAL ONLY — `what = { physical = true }` (human.lua:54) ═══
   * A wild infusion does nothing about being confused, and that is the tuning
   * rather than a gap: the mental channel is somebody else's problem to solve.
   */
  it('will not touch a mental affliction', () => {
    const state = createMvpEffectState();
    const rng = createRng('wild-cure-channel');
    const apply = statusApplier(state, rng);
    const cure = statusCurer(state, rng);
    const actor = body();

    apply(actor, EffectId.Confused, 5, { power: 50 });

    expect(cure(actor, EffectStatus.Detrimental, { channel: SaveChannel.Physical })).toBeNull();
    // …and the unfiltered cure every other talent uses still reaches it, so the
    // filter narrowed this caller and nobody else.
    expect(cure(actor, EffectStatus.Detrimental)).toBe('Confused');
  });
});

describe('the talent itself', () => {
  /** `no_energy = true` (:137) — the same free press the healing infusion gets. */
  it('costs no time at all', () => {
    expect(wildInfusion.cost.ap).toBe(0);
  });

  /** One rank, like every inscription — see `healing_infusion.ts`. */
  it('is a one-rank button', () => {
    expect(wildInfusion.maxLevel).toBe(1);
  });

  /**
   * IT FIRES WITH NOTHING TO CURE, which is the guard that matters: upstream
   * presses this for the resistance all the time, and a version that refused an
   * unafflicted body would be useless exactly when you want it — the turn
   * BEFORE the blow lands.
   */
  it('still buffs a body with no afflictions at all', () => {
    let applied: string | null = null;
    const ctx = {
      talentLevel: 1,
      cure: () => null,
      status: (_t: unknown, id: string) => {
        applied = id;
        return { outcome: 'applied' };
      },
    } as unknown as Parameters<NonNullable<typeof wildInfusion.onUse>>[0];
    const self = { id: 'p1', name: 'Dalt' } as unknown as Parameters<
      NonNullable<typeof wildInfusion.onUse>
    >[1];

    const result = wildInfusion.onUse?.(ctx, self, { x: 0, y: 0 });
    expect(applied).toBe(EffectId.PainSuppression);
    // `ok: false` IS THE REFUSAL SHAPE. A clean body must still get its window.
    expect(result?.ok, 'a clean body must still get its window').not.toBe(false);
  });
});
