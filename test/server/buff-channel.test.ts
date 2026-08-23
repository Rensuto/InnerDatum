// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported against t-engine4 class/Actor.lua:6949-6978 (`canBe`) and the
// `addTemporaryValue` grants that every buff in data/timed_effects/*.lua uses.
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" — https://te4.org/license

import { describe, expect, it } from 'vitest';

import {
  EffectStatus,
  canBe,
  createEffectState,
  recomposeCombat,
  removeEffect,
  statusApplier,
} from '../../src/server/engine/effects.ts';
import { EVASIVE, MVP_EFFECTS, createMvpEffectState } from '../../src/server/content/effects.ts';
import { EffectId } from '../../src/server/content/effects.ts';
import { resolveItem } from '../../src/server/content/resolve.ts';
import { combatDefense } from '../../src/server/engine/derived.ts';
import { createRng } from '../../src/shared/rng.ts';
import type { EffectActor, EquippedActor } from '../../src/server/engine/effects.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE BUFF CHANNEL — a timed effect that ADDS something.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Every effect this game had authored was `EffectStatus.Detrimental`, and that
 * was not a decision: `EffectModifiers` is a closed set of flags and budget
 * penalties — stunned, dazed, `mpPenalty` — with no channel of any kind for
 * granting a stat. A `+10 defence` buff was inexpressible, so ToME's entire
 * self-buff vocabulary was unportable.
 *
 * Measured across upstream's five `data/timed_effects/*.lua`, the most common
 * `addTemporaryValue` keys are `resists`, `combat_def`, `inc_damage`,
 * `inc_stats`, `combat_atk`, `combat_armor` — additive stat and mod grants, the
 * exact shape of `AdditiveStats` / `AdditiveMods`. This port had implemented the
 * tail of that distribution and skipped the head.
 *
 * `EffectDef.wielder` is the head: an effect hands back the block a worn item
 * hands back, and `recomposeCombat` folds it with the same `composeWielders`
 * gear and passives already go through.
 */

function body(): EquippedActor {
  return {
    id: 'p1',
    name: 'Subject',
    kind: 'player',
    hp: 40,
    maxHp: 40,
    alive: true,
    /**
     * `mods.def` IS THE DEFENCE CHANNEL, not a top-level `def`.
     * `combatDefense` reads `c.mods?.def` (engine/derived.ts) — the first draft
     * of this fixture put a bare `def` on the sheet and asserted against it,
     * which measured a field nothing in the combat maths reads and reported a
     * working buff as broken.
     */
    combat: { mods: { def: 10 } },
    baseCombat: { mods: { def: 10 } },
  } as unknown as EquippedActor;
}

describe('a beneficial effect reaches the sheet', () => {
  it('adds its grant, and the grant is gone when it expires', () => {
    const state = createMvpEffectState();
    const rng = createRng('buff-channel');
    const apply = statusApplier(state, rng);
    const actor = body();

    recomposeCombat(actor, state, resolveItem);
    // THROUGH THE GETTER THE COMBAT MATHS USES, so this asserts that the body
    // actually defends better rather than that a field moved.
    const before = combatDefense(actor.combat ?? {});

    apply(actor, EffectId.Evasive, 4, { power: 7 });
    recomposeCombat(actor, state, resolveItem);
    expect(combatDefense(actor.combat ?? {}), 'the buff never reached the sheet').toBe(before + 7);

    /**
     * AND IT LEAVES CLEANLY, which is the half that needs no undo.
     * docs/tome-port.md § 9 records "Temp values -> recompute-from-base" as a
     * deliberate deviation because it *"removes float drift on buff removal"*.
     * The fold reads only what is still live, so an expiry is simply an absence.
     */
    removeEffect(state, actor, EffectId.Evasive, rng);
    recomposeCombat(actor, state, resolveItem);
    expect(combatDefense(actor.combat ?? {}), 'the buff overstayed its welcome').toBe(before);
  });

  it('does not drift when the sheet is rebuilt over and over', () => {
    // THE BUG THE REBUILD EXISTS TO PREVENT. Folding a grant into a sheet that
    // already carries it — which is what `recomputeAttributes` would do, since
    // it preserves the sheet and replaces only the flags — adds the buff again
    // on every call. Ten rebuilds, one buff's worth.
    const state = createMvpEffectState();
    const actor = body();
    statusApplier(state, createRng('drift'))(actor, EffectId.Evasive, 4, {
      power: 5,
    });
    recomposeCombat(actor, state, resolveItem);
    const once = combatDefense(actor.combat ?? {});
    for (let i = 0; i < 10; i += 1) recomposeCombat(actor, state, resolveItem);
    expect(combatDefense(actor.combat ?? {}), 'the grant compounded').toBe(once);
  });
});

describe('nothing resists a blessing', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * Actor.lua:6955-6970 — THE SUBTYPE PRODUCT IS INSIDE THE DETRIMENTAL GUARD.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * ```lua
   * if e and e.status == "detrimental" then
   *   ...blanket immunities...
   *   if not what then
   *     local chance = 100
   *     for typ, _ in pairs(e.subtype) do ... end
   *     return chance == 0 and false or rng.percent(chance), chance
   *   end
   * elseif ...
   * ```
   *
   * A beneficial effect skips all of it and falls to :6974's `if not test then
   * return true, 100 end`. This port hoisted the product OUT of the guard, so
   * every effect ran it — invisible while every authored effect was detrimental,
   * and reachable the moment the first buff existed.
   */
  it('applies at 100 even to a body immune to its own subtype', () => {
    const state = createMvpEffectState();
    const actor = body() as unknown as EffectActor;
    // Total immunity to the buff's own subtype. For a DETRIMENTAL effect this is
    // an outright refusal; for a blessing upstream never consults it.
    state.immunities.set(actor.id, new Map([['evasion', 100]]));

    const answer = canBe(state, actor, EVASIVE, createRng('immune'));
    expect(answer.can, 'a buff was refused by an immunity').toBe(true);
    expect(answer.chance).toBe(100);
  });

  it('draws no rng, so a blessing cannot shift the stream', () => {
    /**
     * THE SERIOUS HALF. `rollPercent` pulls from the labelled stream, so a draw
     * upstream never makes shifts every subsequent draw in the turn — the
     * determinism contract (docs/tome-port.md § 7) broken by a buff landing.
     *
     * Asserted by COUNTING DRAWS: the same rng is asked before and after, and
     * the value it hands back must not have moved.
     */
    const state = createMvpEffectState();
    const actor = body() as unknown as EffectActor;
    state.immunities.set(actor.id, new Map([['evasion', 50]]));

    const rng = createRng('stream');
    const witness = createRng('stream');
    canBe(state, actor, EVASIVE, rng);
    expect(rng.int('probe', 0, 1_000_000)).toBe(witness.int('probe', 0, 1_000_000));
  });

  it('still refuses a DETRIMENTAL effect the body is immune to', () => {
    // The guard must not have been widened into "nothing is ever resisted".
    const detrimental = MVP_EFFECTS.find((def) => def.status === EffectStatus.Detrimental);
    expect(detrimental).toBeDefined();
    if (detrimental === undefined) return;

    const state = createEffectState([detrimental]);
    const actor = body() as unknown as EffectActor;
    state.immunities.set(actor.id, new Map(detrimental.subtypes.map((s) => [s, 100] as const)));
    expect(canBe(state, actor, detrimental, createRng('still-immune')).can).toBe(false);
  });
});
