// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *   DAZED, AND THE RULE THAT MAKES IT FAIR.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `StatusFlags.dazed` is the third flag engine/derived.ts had been reading with
 * nothing to read — `finish()` opens with `if (c.flags?.dazed === true) d = d / 2`
 * and halves the eight rolls that matter, and no effect in the game set it.
 *
 * ═══ AND THE HALVING IS ONLY HALF THE PORT ═══
 * `EFF_DAZED` upstream is *"any damage will remove the daze"* (physical.lua:561),
 * which is why ToME can hand out a debuff this strong without the game becoming
 * a stunlock: three turns of halved everything sounds oppressive and almost
 * never happens, because nobody gets three untouched turns in a real fight.
 *
 * Porting the numbers without that rule would give a citation that is true line
 * by line and false as a whole. So these tests cover both halves — and the
 * second half is a brand new engine capability, which is exactly the kind of
 * thing this codebase has repeatedly built and left unreachable.
 */

import { describe, expect, it } from 'vitest';

import {
  DAZED,
  EFFACED,
  EffectId,
  MVP_EFFECTS,
  createMvpEffectState,
  validateEffect,
} from '../../src/server/content/effects.ts';
import {
  breakDamageSensitive,
  effectsOn,
  recomputeAttributes,
  setEffect,
} from '../../src/server/engine/effects.ts';
import { combatAttack, combatDefense } from '../../src/server/engine/derived.ts';
import { createContentTalentEngine } from '../../src/server/content/classes.ts';
import { talentRuntimeFor } from '../../src/server/main.ts';
import { createWorld } from '../../src/server/world/world.ts';
import { createRng } from '../../src/shared/rng.ts';
import type { EffectActor } from '../../src/server/engine/effects.ts';

const TURNS = 5;

function body(): EffectActor {
  return {
    id: 'a1',
    kind: 'monster',
    name: 'Subject',
    alive: true,
    x: 1,
    y: 1,
    combat: { stats: { str: 60, dex: 60, mag: 60, wil: 60, cun: 60, con: 60 }, mods: {} },
  } as unknown as EffectActor;
}

describe('dazed', () => {
  it('is registered and internally consistent', () => {
    expect(MVP_EFFECTS).toContain(DAZED);
    expect(validateEffect(DAZED)).toEqual([]);
  });

  it('halves the rolls the shared tail runs through', () => {
    const clean = body();
    const marked = body();
    const state = createMvpEffectState();
    setEffect(state, marked, EffectId.Dazed, TURNS, {}, createRng('daze'));
    recomputeAttributes(state, marked);

    expect(marked.combat?.flags?.dazed).toBe(true);
    expect(combatAttack(marked.combat ?? {})).toBeLessThan(combatAttack(clean.combat ?? {}));
    expect(combatDefense(marked.combat ?? {})).toBeLessThan(combatDefense(clean.combat ?? {}));
  });

  /**
   * HARDER THAN EFFACED, WHICH IS THE WHOLE REASON BOTH EXIST.
   *
   * `finish()` halves for dazed and divides by 1.2 for scoured. If these two
   * ever produced the same number, one of them would be a duplicate wearing a
   * different name — and the pair is meant to be a big short debuff against a
   * small long one.
   */
  it('bites harder than effaced', () => {
    const dazedBody = body();
    const effacedBody = body();
    /**
     * A STATE EACH, BECAUSE `body()` HANDS OUT THE SAME ID EVERY TIME.
     *
     * One shared state would file both effects under `a1` and then aggregate
     * BOTH onto whichever actor was recomputed — producing two identical
     * numbers and an assertion that reads like the two effects being equal.
     * They are not; this cost a debugging round to work out.
     */
    const dazedState = createMvpEffectState();
    const effacedState = createMvpEffectState();
    setEffect(dazedState, dazedBody, EffectId.Dazed, TURNS, {}, createRng('a'));
    setEffect(effacedState, effacedBody, EffectId.Effaced, TURNS, {}, createRng('b'));
    recomputeAttributes(dazedState, dazedBody);
    recomputeAttributes(effacedState, effacedBody);

    expect(MVP_EFFECTS).toContain(EFFACED);
    expect(combatAttack(dazedBody.combat ?? {})).toBeLessThan(
      combatAttack(effacedBody.combat ?? {}),
    );
  });
});

describe('breaking on damage', () => {
  it('is the flag dazed carries and the others do not', () => {
    expect(DAZED.breaksOnDamage).toBe(true);
    for (const def of MVP_EFFECTS) {
      if (def.id === EffectId.Dazed) continue;
      expect(def.breaksOnDamage ?? false, `${def.displayName} should not break on damage`).toBe(
        false,
      );
    }
  });

  it('takes the daze off and says what it took', () => {
    const actor = body();
    const state = createMvpEffectState();
    setEffect(state, actor, EffectId.Dazed, TURNS, {}, createRng('daze'));
    expect(effectsOn(state, actor.id)).toHaveLength(1);

    const shed = breakDamageSensitive(state, actor, createRng('hit'));
    expect(shed).toEqual([DAZED.displayName]);
    expect(effectsOn(state, actor.id)).toHaveLength(0);
  });

  /**
   * AND LEAVES EVERYTHING ELSE ALONE.
   *
   * A sweep that took the bleed off too would make being hit a CURE, which is
   * the opposite of the mechanic. This is the assertion that would catch a
   * `breaksOnDamage` check inverted or dropped.
   */
  it('does not disturb an effect that survives being hit', () => {
    const actor = body();
    const state = createMvpEffectState();
    setEffect(state, actor, EffectId.Dazed, TURNS, {}, createRng('daze'));
    setEffect(state, actor, EffectId.Bleeding, TURNS, {}, createRng('bleed'));

    breakDamageSensitive(state, actor, createRng('hit'));
    const left = effectsOn(state, actor.id).map((eff) => eff.effectId);
    expect(left).toEqual([EffectId.Bleeding]);
  });

  it('is a cheap no-op on a body carrying nothing fragile', () => {
    const actor = body();
    const state = createMvpEffectState();
    setEffect(state, actor, EffectId.Slowed, TURNS, {}, createRng('slow'));
    expect(breakDamageSensitive(state, actor, createRng('hit'))).toEqual([]);
    expect(effectsOn(state, actor.id)).toHaveLength(1);
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * AND THE HOOK ACTUALLY REACHES IT.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Every assertion above tests the sweep in isolation, and a sweep nothing
   * calls is the failure this codebase keeps finding — nine times so far, most
   * recently a monster talent system where every part worked and no creature
   * could cast. `breakOnDamage` is a brand new seam on `talentRuntimeFor`, and
   * the only thing that drives it is `noteStruck`.
   *
   * So this asserts the CALL, through the real adapter, with the real signature.
   * If the seam is dropped, misordered, or the hook stops firing, this fails.
   */
  it('is driven by noteStruck, through the real runtime', () => {
    const world = createWorld('struck');
    const struck: string[] = [];
    const runtime = talentRuntimeFor(
      createContentTalentEngine(),
      world,
      undefined,
      undefined,
      undefined,
      undefined,
      (actorId: string) => struck.push(actorId),
    );

    runtime.noteStruck('a1');
    expect(struck, 'noteStruck never reached breakOnDamage').toEqual(['a1']);
  });

  /** The flags come back off, not just the effect row. */
  it('restores the rolls it was suppressing', () => {
    const clean = body();
    const actor = body();
    const state = createMvpEffectState();
    setEffect(state, actor, EffectId.Dazed, TURNS, {}, createRng('daze'));
    recomputeAttributes(state, actor);
    expect(actor.combat?.flags?.dazed).toBe(true);

    breakDamageSensitive(state, actor, createRng('hit'));
    recomputeAttributes(state, actor);
    expect(actor.combat?.flags?.dazed).toBe(false);
    expect(combatAttack(actor.combat ?? {})).toBe(combatAttack(clean.combat ?? {}));
  });
});
