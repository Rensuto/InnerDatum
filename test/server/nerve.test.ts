// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported in shape from t-engine4's `self:hasEffect(...)` talents, where being
// afflicted is a state a talent reads rather than only a cost it pays.
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" — https://te4.org/license

import { describe, expect, it } from 'vitest';

import { EMPTY_PASSIVE_VIEW, createTurnProcs } from '../../src/server/engine/hooks.ts';
import {
  NERVE,
  badNight,
  grit,
  nothingNew,
  shakeItOff,
  stillStanding,
  workThroughIt,
} from '../../src/server/talents/nerve.ts';
import { TALENT_MAX_LEVEL } from '../../src/shared/progression.ts';
import type { HookCtx, PassiveView } from '../../src/server/engine/hooks.ts';

/** A view of a body with `n` things wrong with it, and nothing else true. */
const hurt = (n: number): PassiveView => ({ ...EMPTY_PASSIVE_VIEW, afflicted: () => n });

const ctxOf = (hp: number, maxHp: number, level: number, alive = true): HookCtx => ({
  self: { id: 'p1', name: 'Ren', hp, maxHp, alive, x: 0, y: 0 },
  level,
  procs: createTurnProcs(),
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *   THE STATUS TABLE WAS WRITE-ONLY.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Twelve talents apply a stun, a slow or a bleed and not one has ever asked
 * whether it is standing in one — so being afflicted could only be a cost, and
 * a whole shape of upstream talent had no way to exist here.
 * `PassiveView.afflicted` is the new question and this is the discipline it
 * was added for.
 */

describe('the count is bounded at both ends', () => {
  it('pays nothing to a body nothing has landed on', () => {
    for (const talent of NERVE) {
      const block = talent.passive?.(TALENT_MAX_LEVEL, hurt(0));
      expect(
        Object.keys(block?.mods ?? {}).length,
        `${talent.id} pays a healthy body`,
      ).toBeLessThanOrEqual(
        // `nothingNew` is the deliberate exception — the floor under a tree
        // whose other talents only pay when something has gone wrong.
        talent.id === nothingNew.id ? 2 : 0,
      );
    }
  });

  it('stops counting past three, which is the balance lever', () => {
    /**
     * Three at once is a bad turn; five is a turn somebody is about to die on,
     * and a talent that went on paying into that would pay most at the moment
     * it can no longer help. It also bounds the arithmetic against a future
     * effect table with twenty entries in it.
     */
    const three = workThroughIt.passive?.(3, hurt(3))?.mods?.atk ?? 0;
    const ten = workThroughIt.passive?.(3, hurt(10))?.mods?.atk ?? 0;
    expect(three).toBeGreaterThan(0);
    expect(ten).toBe(three);
  });

  it('scales with the count below the cap', () => {
    const one = workThroughIt.passive?.(3, hurt(1))?.mods?.atk ?? 0;
    const two = workThroughIt.passive?.(3, hurt(2))?.mods?.atk ?? 0;
    expect(two).toBe(one * 2);
  });
});

describe('the compounding save is the answer to a lock chain', () => {
  it('makes the second affliction harder to land than the first', () => {
    /**
     * ═══ THE WORST THING THAT HAPPENS TO A CHARACTER IN THIS GAME ═══
     * Not a big hit — a stun, then another stun, then a third, with the player
     * watching. Once the first has landed there is nothing they can do about
     * the second. This is the something.
     */
    const first = shakeItOff.passive?.(3, hurt(1))?.mods?.physResist ?? 0;
    const second = shakeItOff.passive?.(3, hurt(2))?.mods?.physResist ?? 0;
    expect(first).toBeGreaterThan(0);
    expect(second).toBeGreaterThan(first);
  });

  it('does not stop the first one, and should not', () => {
    // A talent that made a character immune would remove the moment this
    // exists to make survivable.
    expect(shakeItOff.passive?.(TALENT_MAX_LEVEL, hurt(0))?.mods?.physResist ?? 0).toBe(0);
  });

  it('covers all three channels, because a chain does not pick one', () => {
    const block = shakeItOff.passive?.(3, hurt(2));
    expect(block?.mods?.physResist).toBe(block?.mods?.mentalResist);
    expect(block?.mods?.physResist).toBe(block?.mods?.spellResist);
  });
});

describe('the tree is not pure mitigation', () => {
  it('pays for a bad turn offensively too', () => {
    /**
     * Pure mitigation makes losing slower rather than making winning possible.
     * Without this, the correct play while afflicted is always to retreat — and
     * three category points bought a retreat button.
     */
    expect(badNight.passive?.(3, hurt(2))?.mods?.dam ?? 0).toBeGreaterThan(0);
  });

  it('has a floor that pays on a good night', () => {
    // Five of six are worth nothing to a character nothing has landed on, and a
    // discipline worth nothing on a good night is one nobody buys with a point
    // they only get three of.
    const block = nothingNew.passive?.(3, hurt(0));
    expect(block?.mods?.mentalResist ?? 0).toBeGreaterThan(0);
    expect(block?.mods?.spellResist ?? 0).toBeGreaterThan(0);
  });
});

describe('the two hooks', () => {
  it('Grit mends on the base clock', () => {
    const ctx = ctxOf(100, 200, 3);
    grit.hooks?.onTurnStart?.(ctx);
    expect(ctx.self.hp).toBeGreaterThan(100);
  });

  it('Still Standing is the first shipped use of onKill', () => {
    /**
     * The hook has existed since `TalentHooks` did and nothing had ever
     * attached to it — the last of the four to be claimed, after
     * `onTakeDamage`, `onTurnStart` and `onDealDamage`.
     */
    expect(stillStanding.hooks?.onKill, 'the capstone does not use onKill').toBeDefined();
    const ctx = ctxOf(100, 200, 3);
    stillStanding.hooks?.onKill?.(ctx, 'husk_1');
    expect(ctx.self.hp).toBeGreaterThan(100);
  });

  it('neither mends a corpse, so the rescue rules keep their only exit', () => {
    // Downed keeps a body on the board at 0. A downed character healing
    // themselves off the floor would give the whole rescue system a second,
    // invisible way out — the same edge `walk_it_off.ts` guards.
    const onTurn = ctxOf(0, 200, TALENT_MAX_LEVEL, false);
    grit.hooks?.onTurnStart?.(onTurn);
    expect(onTurn.self.hp, 'grit').toBe(0);

    const onKill = ctxOf(0, 200, TALENT_MAX_LEVEL, false);
    stillStanding.hooks?.onKill?.(onKill, 'husk_1');
    expect(onKill.self.hp, 'still_standing').toBe(0);
  });

  it('neither overfills', () => {
    const a = ctxOf(199, 200, TALENT_MAX_LEVEL);
    grit.hooks?.onTurnStart?.(a);
    expect(a.self.hp).toBe(200);

    const b = ctxOf(199, 200, TALENT_MAX_LEVEL);
    stillStanding.hooks?.onKill?.(b, 'husk_1');
    expect(b.self.hp).toBe(200);
  });
});
