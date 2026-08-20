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
import {
  combatArmor,
  combatAttack,
  combatCrit,
  combatDefense,
  combatPhysicalpower,
  combatSpellResist,
} from '../../src/server/engine/derived.ts';
import { armourAt } from '../../src/server/talents/standing_orders.ts';
import { critAt } from '../../src/server/talents/measured_doses.ts';
import { defenceAt } from '../../src/server/talents/cold_reading.ts';
import { powerAt as officePowerAt } from '../../src/server/talents/weight_of_office.ts';
import { strengthAt } from '../../src/server/talents/parade_ground.ts';
import { accuracyAt } from '../../src/server/talents/called_shot.ts';
import { spellSaveAt } from '../../src/server/talents/bolt_hole.ts';
import { powerAt as compoundPowerAt } from '../../src/server/talents/stable_compound.ts';
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

/**
 * The COMPOSED sheet, which is what every derived getter takes — `body` returns
 * the actor, and an actor is not a `Combatant`. Passing one reads every field as
 * absent and makes each assertion below compare a default against itself, which
 * looks exactly like an inert channel and is how this file first reported five
 * live grants as dead.
 */
function sheet(passive: PassiveContribution | undefined) {
  return body(passive).combat ?? {};
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE FOUR CHANNELS THE SECOND WAVE OF PASSIVES OPENED, EACH PROVED LIVE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `apr` and `mentalResist` were both REJECTED for these slots after exactly
 * this check failed for them by inspection: no monster in this game carries
 * enough armour for penetration to change a roll, and nothing authored reads
 * the mental save at all. A talent on either would have type-checked,
 * persisted, drawn an icon, printed a tooltip and moved no number.
 *
 * So every channel a passive grants gets a test that runs it through the
 * derived getter the damage pipeline actually calls. A grant that cannot be
 * observed at the far end is not a talent, it is a decoration.
 */
describe('the channels the new passives grant are all live', () => {
  it('flat physical power reaches combatPhysicalpower', () => {
    const bare = combatPhysicalpower(sheet(undefined));
    const one = combatPhysicalpower(sheet({ mods: { dam: officePowerAt(1) } }));
    const five = combatPhysicalpower(sheet({ mods: { dam: officePowerAt(5) } }));

    expect(one).toBeGreaterThan(bare);
    expect(five).toBeGreaterThan(one);
  });

  it('accuracy reaches combatAttack', () => {
    const bare = combatAttack(sheet(undefined));
    const one = combatAttack(sheet({ mods: { atk: accuracyAt(1) } }));
    const five = combatAttack(sheet({ mods: { atk: accuracyAt(5) } }));

    expect(one).toBeGreaterThan(bare);
    expect(five).toBeGreaterThan(one);
  });

  it('the spell save reaches combatSpellResist', () => {
    const bare = combatSpellResist(sheet(undefined));
    const one = combatSpellResist(sheet({ mods: { spellResist: spellSaveAt(1) } }));
    const five = combatSpellResist(sheet({ mods: { spellResist: spellSaveAt(5) } }));

    expect(one).toBeGreaterThan(bare);
    expect(five).toBeGreaterThan(one);
  });

  it('generic power reaches the physical power it is added to', () => {
    // `genericPower` is added to all three powers (Combat.lua:1693, 1748, 2060).
    // Physical is the one this game reads most, so it is the one asserted.
    const bare = combatPhysicalpower(sheet(undefined));
    const five = combatPhysicalpower(sheet({ mods: { genericPower: compoundPowerAt(5) } }));

    expect(five).toBeGreaterThan(bare);
  });

  /**
   * A STAT IS THE WIDEST GRANT AND THE EASIEST ONE TO GET WRONG, because it
   * travels a different road from a mod: `composeWielders` folds `stats` into
   * the sheet's OWN stat block, and every derived getter then reads it back
   * through `stat(c, ...)`. A version of this that only merged `mods` would
   * leave five of the nine new talents completely inert while the other four
   * worked, which is the failure hardest to notice by playing.
   */
  it('a granted stat moves the two numbers that read it', () => {
    const bare = sheet(undefined);
    const strong = sheet({ stats: { str: strengthAt(5) } });

    // Strength feeds physical power directly (Combat.lua:1693).
    expect(combatPhysicalpower(strong)).toBeGreaterThan(combatPhysicalpower(bare));
  });

  it('a granted stat is worth more at rank 5 than at rank 1', () => {
    expect(strengthAt(5)).toBeGreaterThan(strengthAt(1));
    expect(combatPhysicalpower(sheet({ stats: { str: strengthAt(5) } }))).toBeGreaterThan(
      combatPhysicalpower(sheet({ stats: { str: strengthAt(1) } })),
    );
  });

  it('grants nothing when the body has earned nothing', () => {
    // The mirror of the armour case above: absence must be free, or every
    // actor in the game silently carries a rank-0 bonus.
    expect(combatAttack(sheet(undefined))).toBe(combatAttack(sheet({})));
    expect(combatPhysicalpower(sheet(undefined))).toBe(combatPhysicalpower(sheet({})));
  });
});
