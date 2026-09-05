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
  combatMentalResist,
  combatMindpower,
  combatPhysicalResist,
  combatPhysicalpower,
  combatSpellResist,
  combatSpellpower,
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
   * ═══ WHAT YOU SWING WITH, AND NOT WHAT YOU SOAK WITH ═══
   * This test used to say "every roll that runs through the shared tail" and
   * assert that DEFENCE dropped too. That was true of our code and not of
   * ToME's: `scoured` is on the five accuracy getters (Combat.lua:1359-1396)
   * and the three powers (:1724, :1744, :2056), and on NOTHING else.
   * `combatDefense`, `combatDefenseRanged` and the three resists carry no
   * `scoured` term at all. `dazed` is the flag that really does move all
   * thirteen — see `finish()`.
   *
   * So the breadth that "makes Efface worth a creature's whole turn" is the
   * offensive half. A body that has been scoured still guards itself normally.
   *
   * ═══ AND THE RATIO IS NOT 1.2, ON PURPOSE ═══
   * The division happens BEFORE `rescaleCombatStats`, which is upstream's order
   * (Combat.lua:1359 divides inside the getter, then rescales) and the reason
   * `finish()` exists as one function rather than two lines copied about. The
   * rescale is non-linear, so the ratio a player actually experiences varies
   * with how high the stat was. Asserting `/ 1.2` on the OUTPUT would be
   * asserting the rescale away.
   */
  it('lowers what you swing with', () => {
    const clean = body();
    const marked = body();
    afflict(marked, EffectId.Effaced);

    for (const [what, get] of [
      ['accuracy', combatAttack],
      ['physical power', combatPhysicalpower],
      ['spell power', combatSpellpower],
      ['mind power', combatMindpower],
    ] as const) {
      const before = get(clean.combat ?? {});
      const after = get(marked.combat ?? {});
      expect(after, `${what} should drop when effaced`).toBeLessThan(before);
    }
  });

  it('leaves defence and the three saves exactly where they were', () => {
    // ═══ THE HALF THAT WAS WRONG, PINNED SO IT STAYS RIGHT ═══
    // Upstream scours accuracy and the powers only. Effaced was quietly taking
    // a sixth off a body's defence and all three saves as well, which made it
    // strictly harsher than ToME's antimagic scouring.
    const clean = body();
    const marked = body();
    afflict(marked, EffectId.Effaced);

    for (const [what, get] of [
      ['defence', combatDefense],
      ['physical save', combatPhysicalResist],
      ['spell save', combatSpellResist],
      ['mental save', combatMentalResist],
    ] as const) {
      expect(get(marked.combat ?? {}), `${what} must not move when effaced`).toBe(
        get(clean.combat ?? {}),
      );
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
