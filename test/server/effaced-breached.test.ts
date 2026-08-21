// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *   THE TWO DEBUFFS WHOSE ENGINE HALF WAS BUILT YEARS BEFORE THEIR CONTENT.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `StatusFlags.scoured` and `StatusFlags.breached` were ported with the
 * defensive maths and wired into `finish()` and `combatArmorHardiness`, each
 * carrying its upstream line number. Both were correct. Both were unreachable,
 * because no effect in the game set either flag — so the division by 1.2 and
 * the halving of hardiness had never once run in play.
 *
 * These tests are the proof the wire is hot, end to end: set the effect, run
 * `recomputeAttributes`, and read the number a real fight would read.
 */

import { describe, expect, it } from 'vitest';

import {
  BREACHED,
  EFFACED,
  EffectId,
  MVP_EFFECTS,
  createMvpEffectState,
  validateEffect,
} from '../../src/server/content/effects.ts';
import { recomputeAttributes, setEffect } from '../../src/server/engine/effects.ts';
import { createRng } from '../../src/shared/rng.ts';
import {
  combatArmorHardiness,
  combatAttack,
  combatDefense,
  combatPhysicalpower,
} from '../../src/server/engine/derived.ts';
import type { EffectActor } from '../../src/server/engine/effects.ts';

const TURNS = 5;
const HARDINESS_ADD = 20;

/** A body with ordinary numbers, so the getters have something to divide. */
function body(): EffectActor {
  return {
    id: 'a1',
    kind: 'monster',
    name: 'Subject',
    alive: true,
    x: 1,
    y: 1,
    combat: {
      stats: { str: 60, dex: 60, mag: 60, wil: 60, cun: 60, con: 60 },
      mods: { armourHardiness: HARDINESS_ADD },
    },
  } as unknown as EffectActor;
}

/**
 * LAND THE EFFECT, NO SAVE ALLOWED.
 *
 * A seeded rng because `setEffect` rolls the save through it, and these tests
 * are about what the flag DOES rather than how often it lands — the save itself
 * has its own coverage. An empty `params` means no `applyPower`, which against
 * any real save is a landing, and that is what makes these assertions
 * deterministic rather than seed-dependent.
 */
function afflict(actor: EffectActor, id: string): void {
  const state = createMvpEffectState();
  setEffect(state, actor, id, TURNS, {}, createRng('afflict'));
  recomputeAttributes(state, actor);
}

describe('effaced', () => {
  it('is registered and internally consistent', () => {
    expect(MVP_EFFECTS).toContain(EFFACED);
    expect(validateEffect(EFFACED)).toEqual([]);
  });

  it('sets the scoured flag the defensive maths has always read', () => {
    const actor = body();
    afflict(actor, EffectId.Effaced);
    expect(actor.combat?.flags?.scoured).toBe(true);
  });

  /**
   * ═══ EVERY ROLL, WHICH IS THE ENTIRE POINT OF THE EFFECT ═══
   * `finish()` is the shared tail of accuracy, defence, all three powers and
   * all three saves. One flag moves all eight, and that breadth is what makes
   * Efface worth a creature's whole turn.
   *
   * ═══ AND THE RATIO IS NOT 1.2, ON PURPOSE ═══
   * The division happens BEFORE `rescaleCombatStats`, which is upstream's order
   * (Combat.lua:1359 divides inside the getter, then rescales) and the reason
   * `finish()` exists as one function rather than two lines copied about. The
   * rescale is non-linear, so the ratio a player actually experiences varies
   * with how high the stat was. Asserting `/ 1.2` on the OUTPUT would be
   * asserting the rescale away.
   */
  it('lowers every roll that runs through the shared tail', () => {
    const clean = body();
    const marked = body();
    afflict(marked, EffectId.Effaced);

    for (const [what, get] of [
      ['accuracy', combatAttack],
      ['defence', combatDefense],
      ['physical power', combatPhysicalpower],
    ] as const) {
      const before = get(clean.combat ?? {});
      const after = get(marked.combat ?? {});
      expect(after, `${what} should drop when effaced`).toBeLessThan(before);
    }
  });
});

describe('breached', () => {
  it('is registered and internally consistent', () => {
    expect(MVP_EFFECTS).toContain(BREACHED);
    expect(validateEffect(BREACHED)).toEqual([]);
  });

  /**
   * EXACTLY HALF, AND THIS ONE CAN BE ASSERTED EXACTLY.
   *
   * `combatArmorHardiness` multiplies by 0.5 AFTER the 0-100 bound
   * (Combat.lua:1334), and nothing rescales afterwards — so unlike Efface above,
   * the ratio a player experiences is the ratio in the source.
   */
  it('halves armour hardiness after the bound', () => {
    const clean = body();
    const marked = body();
    afflict(marked, EffectId.Breached);

    const before = combatArmorHardiness(clean.combat ?? {});
    const after = combatArmorHardiness(marked.combat ?? {});
    expect(marked.combat?.flags?.breached).toBe(true);
    expect(after).toBeCloseTo(before / 2);
  });

  /** It touches hardiness and nothing else — the four immunities are absent. */
  it('leaves the rolls alone', () => {
    const clean = body();
    const marked = body();
    afflict(marked, EffectId.Breached);
    expect(combatAttack(marked.combat ?? {})).toBe(combatAttack(clean.combat ?? {}));
    expect(combatDefense(marked.combat ?? {})).toBe(combatDefense(clean.combat ?? {}));
  });
});
