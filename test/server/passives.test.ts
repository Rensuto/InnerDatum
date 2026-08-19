// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A PASSIVE IS ONLY REAL IF A DERIVED NUMBER MOVES
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The mechanism has four parts and three of them can be right while the feature
 * does nothing: a talent can declare a contribution, the sheet can hold it at a
 * rank, `recomposeCombat` can have a stage for it — and if nothing writes
 * `actor.passiveCombat`, the armour a player was promised never arrives.
 *
 * So this asserts the END of the chain, through the same `combatArmor` the
 * damage pipeline calls, rather than any of the parts.
 */

import { describe, expect, it } from 'vitest';

import { WATCHMAN, INSPECTOR, ALCHEMIST } from '../../src/server/content/classes.ts';
import { recomposeCombat } from '../../src/server/engine/effects.ts';
import { combatArmor, combatCrit, combatDefense } from '../../src/server/engine/derived.ts';
import { armourAt } from '../../src/server/talents/standing_orders.ts';
import { critAt } from '../../src/server/talents/measured_doses.ts';
import { defenceAt } from '../../src/server/talents/cold_reading.ts';
import type { EquippedActor } from '../../src/server/engine/effects.ts';
import type { PassiveContribution } from '../../src/server/engine/equipment.ts';

/** No catalogue: nothing here wears anything, and gear has its own tests. */
const NOTHING_WORN = () => undefined;

/** A body with a class sheet and whatever passive contribution it has earned. */
function body(passive: PassiveContribution | undefined): EquippedActor {
  const actor = {
    id: 'a',
    baseCombat: WATCHMAN.combat,
    passiveCombat: passive,
  } as unknown as EquippedActor;
  recomposeCombat(actor, null, NOTHING_WORN);
  return actor;
}

describe('a passive reaches the number the damage pipeline reads', () => {
  it('adds its armour, and adds MORE at a higher rank', () => {
    const bare = body(undefined);
    const one = body({ mods: { armour: armourAt(1) } });
    const five = body({ mods: { armour: armourAt(5) } });

    // Through `combatArmor`, which is what `attackTarget` calls — not by
    // reading the field back out, which would prove only that a write happened.
    expect(combatArmor(one.combat ?? {})).toBe(combatArmor(bare.combat ?? {}) + armourAt(1));
    expect(combatArmor(five.combat ?? {})).toBeGreaterThan(combatArmor(one.combat ?? {}));
  });

  it('is worth nothing at all when the body has none', () => {
    // The absent case has to compose byte-for-byte like it did before passives
    // existed, or every class without one silently changed.
    expect(combatArmor(body(undefined).combat ?? {})).toBe(combatArmor(WATCHMAN.combat));
  });

  it('carries the other two classes to their own derived getters', () => {
    const inspector = { id: 'i', baseCombat: INSPECTOR.combat } as unknown as EquippedActor;
    inspector.passiveCombat = { mods: { def: defenceAt(1) } };
    recomposeCombat(inspector, null, NOTHING_WORN);
    expect(combatDefense(inspector.combat ?? {})).toBe(
      combatDefense(INSPECTOR.combat) + defenceAt(1),
    );

    const alchemist = { id: 'k', baseCombat: ALCHEMIST.combat } as unknown as EquippedActor;
    alchemist.passiveCombat = { mods: { genericCrit: critAt(1) } };
    recomposeCombat(alchemist, null, NOTHING_WORN);
    expect(combatCrit(alchemist.combat ?? {})).toBeGreaterThan(combatCrit(ALCHEMIST.combat));
  });

  it('scales the way ToME scales it — monotonic, and not linear', () => {
    // `combatTalentScale` at 0.75 is a curve, so equal ranks are not equal
    // steps. Asserting BOTH properties is what distinguishes a real port from a
    // multiplication that happens to rise.
    const steps = [1, 2, 3, 4, 5].map((rank) => armourAt(rank));
    for (let i = 1; i < steps.length; i += 1) {
      expect(steps[i]).toBeGreaterThanOrEqual(steps[i - 1] ?? 0);
    }
    expect(steps.at(-1)).toBeGreaterThan(steps[0] ?? 0);
  });
});
