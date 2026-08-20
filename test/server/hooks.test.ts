// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

import { describe, expect, it } from 'vitest';

import { DamageType, applyDamage } from '../../src/server/engine/damage.ts';
import { createTurnProcs, fireTakeDamage } from '../../src/server/engine/hooks.ts';
import { bluntAt, unflinching } from '../../src/server/talents/unflinching.ts';
import { createRng } from '../../src/shared/rng.ts';
import type { BoundHooks, TurnProcs } from '../../src/server/engine/hooks.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *   SOMEWHERE FOR A TALENT TO ATTACH.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * MEASURED BEFORE THIS EXISTED: of 42 talents, 6 granted a raw attribute, 18
 * granted a flat combat modifier, 18 were actives, and ZERO were conditional or
 * behavioural. 57% of every talent in the game was a number going up.
 *
 * That was never a content decision — it was the only sentence the type could
 * form. `passive?: (level: number) => PassiveContribution` receives a level and
 * returns the shape a worn item returns, so a passive talent was modelled as a
 * breastplate and could say nothing a breastplate cannot.
 *
 * Upstream's variety does not come from a richer installer: only 17% of ToME's
 * 296 passives use `passives = function` at all, 70% have no body whatsoever,
 * and the rules live in engine code hung on a bus of 45 named events. These
 * tests cover the smallest useful version of that bus, and the two properties
 * that are easy to get wrong and fail SILENTLY when you do.
 */

function boundHook(level: number): BoundHooks {
  const hooks = unflinching.hooks;
  expect(hooks, 'Unflinching no longer declares a hook').toBeDefined();
  if (hooks === undefined) throw new Error('unreachable');
  return { talentId: unflinching.id, level, hooks };
}

function host(procs: TurnProcs, level = 3): Parameters<typeof fireTakeDamage>[0] {
  return {
    id: 'watchman',
    name: 'Ren',
    hp: 72,
    maxHp: 72,
    alive: true,
    x: 0,
    y: 0,
    talentHooks: [boundHook(level)],
    turnProcs: procs,
  };
}

const incoming = (dam: number) =>
  ({ dam, type: DamageType.Physical, sourceId: 'husk', lethal: false }) as const;

describe('the rewrite chain', () => {
  it('lets a talent change the number that lands', () => {
    const procs = createTurnProcs();
    const blunt = bluntAt(3);
    expect(blunt, 'the talent blunts nothing, so this test proves nothing').toBeGreaterThan(0);

    // ═══ THE ASSERTION THAT WAS IMPOSSIBLE BEFORE ═══
    // No arrangement of `PassiveContribution` could express this: it is not a
    // stat, not a mod, and it depends on what is happening.
    expect(fireTakeDamage(host(procs), incoming(20))).toBe(20 - blunt);
  });

  it('fires ONCE a turn, not once a blow', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE PROPERTY THAT FAILS SILENTLY, WHICH IS WHY THE LATCH CAME FIRST.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * Without `turn_procs` this fires per DAMAGE INSTANCE: twice for a two-hit
     * talent, once per victim in an area effect, and every turn a damage-over-
     * time ticks. Nothing errors. The talent is simply worth several times what
     * it says, and the only symptom is that the Watchman is hard to kill.
     *
     * ToME reaches for this latch 192 times.
     */
    const procs = createTurnProcs();
    const blunt = bluntAt(3);
    const first = fireTakeDamage(host(procs), incoming(20));
    const second = fireTakeDamage(host(procs), incoming(20));
    const third = fireTakeDamage(host(procs), incoming(20));

    expect(first, 'the first blow was not blunted').toBe(20 - blunt);
    expect(second, 'the second blow of the same turn was blunted too').toBe(20);
    expect(third).toBe(20);
  });

  it('arms again when the turn does', () => {
    const procs = createTurnProcs();
    const blunt = bluntAt(3);
    expect(fireTakeDamage(host(procs), incoming(20))).toBe(20 - blunt);
    expect(fireTakeDamage(host(procs), incoming(20))).toBe(20);
    // The base-turn tick calls exactly this, on the same line that clears
    // `movedThisTurn` — see engine/talents.ts.
    procs.clear();
    expect(fireTakeDamage(host(procs), incoming(20)), 'the latch never re-armed').toBe(20 - blunt);
  });

  it('composes two handlers on the running figure, not on the original', () => {
    /**
     * Each handler sees the value the previous one left. Folding against the
     * ORIGINAL instead would let two mitigations each subtract from the full
     * blow and silently double-count — the arithmetic every stacked-reduction
     * bug is made of.
     */
    const procs = createTurnProcs();
    const halve: BoundHooks = {
      talentId: 'test:halve',
      level: 1,
      hooks: { onTakeDamage: (_ctx, dmg) => ({ dam: dmg.dam / 2 }) },
    };
    const takeTwo: BoundHooks = {
      talentId: 'test:take-two',
      level: 1,
      hooks: { onTakeDamage: (_ctx, dmg) => ({ dam: dmg.dam - 2 }) },
    };
    const both = {
      id: 'x',
      name: 'x',
      hp: 50,
      maxHp: 50,
      alive: true,
      x: 0,
      y: 0,
      talentHooks: [halve, takeTwo],
      turnProcs: procs,
    };
    // 40 -> 20 -> 18. Against the original it would be 40 -> 20 and 40 -> 38.
    expect(fireTakeDamage(both, incoming(40))).toBe(18);
  });

  it('lets a handler refuse a blow outright, and stops the chain when it does', () => {
    const procs = createTurnProcs();
    const seen: string[] = [];
    const refuse: BoundHooks = {
      talentId: 'test:refuse',
      level: 1,
      hooks: {
        onTakeDamage: () => {
          seen.push('refuse');
          return { stopped: true };
        },
      },
    };
    const after: BoundHooks = {
      talentId: 'test:after',
      level: 1,
      hooks: {
        onTakeDamage: () => {
          seen.push('after');
          return { dam: 999 };
        },
      },
    };
    const body = {
      id: 'x',
      name: 'x',
      hp: 50,
      maxHp: 50,
      alive: true,
      x: 0,
      y: 0,
      talentHooks: [refuse, after],
      turnProcs: procs,
    };

    expect(fireTakeDamage(body, incoming(30))).toBe(0);
    /**
     * AND THE REST OF THE CHAIN DID NOT RUN. A refused blow is not available for
     * a later handler to reduce further — letting the fold continue would let
     * two "prevent this" talents each believe they were the one that saved you,
     * and the second one here would have put the damage back.
     */
    expect(seen, 'the chain kept running after a blow was refused').toEqual(['refuse']);
  });

  it('costs nothing and changes nothing for a body with no hooks', () => {
    // Every existing fixture in the suite is this shape. It must fold to the
    // identity, which is what lets this land without touching them.
    const bare = { id: 'x', name: 'x', hp: 9, maxHp: 9, alive: true, x: 0, y: 0 };
    expect(fireTakeDamage(bare, incoming(7))).toBe(7);
  });
});

describe('the chain is wired into real damage', () => {
  /**
   * The unit tests above prove the fold. This proves it is CONNECTED — that
   * `applyDamage`, the one sink every blow in the game passes through, actually
   * consults it. A perfect fold nothing calls is the shape this project has
   * shipped before: `budgetPenalty` had zero production callers and a Slowed
   * player moved exactly as far as an unslowed one for weeks.
   */
  function victim(withHook: boolean) {
    const procs = createTurnProcs();
    return {
      id: 'ren',
      name: 'Ren',
      hp: 72,
      maxHp: 72,
      alive: true,
      x: 0,
      y: 0,
      ...(withHook ? { talentHooks: [boundHook(3)], turnProcs: procs } : {}),
    };
  }

  it('reduces real damage through applyDamage', () => {
    const plain = victim(false);
    const guarded = victim(true);
    // NO CRIT, NO RANGE ROLL, so the two runs differ by the hook alone rather
    // than by a die. `damageRange: 0` and `critChance: 0` keep the pipeline deterministic.
    const opts = { damageRange: 0, critChance: 0, critPower: 0 } as const;

    const a = applyDamage(plain, 20, DamageType.Physical, { id: 'husk' }, createRng('a'), opts);
    const b = applyDamage(guarded, 20, DamageType.Physical, { id: 'husk' }, createRng('a'), opts);

    expect(a.dealt, 'the control took no damage, so the comparison is empty').toBeGreaterThan(0);
    expect(b.dealt, 'applyDamage never consulted the hook').toBeLessThan(a.dealt);
    // EXACTLY the blunt, not merely less — a hook that fired twice, or that
    // read the wrong rank, would still satisfy `toBeLessThan` above.
    expect(a.dealt - b.dealt).toBe(bluntAt(3));
    // ...and the guarded body really is the one holding the extra hit points.
    expect(guarded.hp).toBeGreaterThan(plain.hp);
  });

  it('leaves the body with the hit points the outcome reports', () => {
    const guarded = victim(true);
    const before = guarded.hp;
    const out = applyDamage(guarded, 20, DamageType.Physical, { id: 'husk' }, createRng('b'), {
      damageRange: 0,
      critChance: 0,
      critPower: 0,
    });
    // The clamp and the chain must agree — a body that lost more than `dealt`
    // is the kind of drift a player reads as the log lying to them.
    expect(before - guarded.hp).toBe(out.dealt);
  });
});
