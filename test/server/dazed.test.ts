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
  hasEffect,
  recomputeAttributes,
  setEffect,
} from '../../src/server/engine/effects.ts';
import { combatAttack, combatDefense } from '../../src/server/engine/derived.ts';
import { createContentTalentEngine } from '../../src/server/content/classes.ts';
import { talentRuntimeFor } from '../../src/server/main.ts';
import { refusalFrame } from '../../src/server/net/gateway.ts';
import { createTurnEngine } from '../../src/server/turn-engine.ts';
import { createWorld } from '../../src/server/world/world.ts';
import { AiProfile } from '../../src/server/engine/actor.ts';
import { ErrorCode, TileCode } from '../../src/shared/protocol.ts';
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
    /**
     * POSITIONAL, AND THE COUNT OF `undefined`s IS LOAD-BEARING.
     *
     * `talentRuntimeFor` takes nine parameters and this call reaches the SEVENTH
     * by counting past six. A parameter inserted anywhere before it silently
     * re-binds this argument to its neighbour — which is exactly what happened
     * when `hasStatus` landed after `cure`: `breakOnDamage` stopped being called
     * and nothing about the call site looked wrong.
     */
    const runtime = talentRuntimeFor(
      createContentTalentEngine(),
      world,
      undefined, // status
      undefined, // penaltyFor
      undefined, // cure
      undefined, // hasStatus
      undefined, // onActBase
      (actorId: string) => struck.push(actorId), // breakOnDamage
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

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A DAZE ROOTS YOU, AND ANY DAMAGE BREAKS IT — through the turn engine.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * physical.lua:570 gives DAZED `never_move`; tome/class/Actor.lua:1338-1342 lets a
 * rooted body still swing at what it walks into; and :2156-2158 takes the daze
 * off on ANY damage, a bleed's tick included. Driven through `createTurnEngine`
 * because the rule lives in the join between the effect, the move gate and the
 * tick lane.
 */
describe('a daze roots you where you stand', () => {
  function stage(seed: string) {
    const world = createWorld(seed);
    world.level.tiles.fill(TileCode.FLOOR);
    const effects = createMvpEffectState();
    const ren = world.addPlayer('p1', 'Ren', { maxHp: 500 });
    ren.x = 2;
    ren.y = 5;
    ren.hpRegen = 0;
    // Every blow the tick lane reports as a BLOW. A DoT must not appear here:
    // `noteStruck` pays the Watchman's Resolve, and a tick is not a blow.
    const struck: string[] = [];
    const runtime = talentRuntimeFor(createContentTalentEngine(), world);
    const engine = createTurnEngine({
      world,
      now: () => 0,
      effects,
      talentRuntime: {
        ...runtime,
        noteStruck: (id: string) => {
          struck.push(id);
          runtime.noteStruck(id);
        },
      },
    });
    engine.join('p1');
    const daze = (): void => {
      setEffect(effects, ren, EffectId.Dazed, TURNS, {}, createRng(`${seed}:daze`));
      recomputeAttributes(effects, ren);
    };
    return { world, engine, effects, ren, struck, daze };
  }

  it('refuses the step, where the same body undazed walks', () => {
    const table = stage('daze-root');
    // The control, first: this body can walk.
    expect(table.engine.submitMove('p1', 'e').ok).toBe(true);
    table.engine.pump();
    expect(table.ren.x, 'the fixture body could not walk to begin with').toBe(3);

    table.daze();
    expect(table.ren.combat?.flags?.pinned, 'the daze did not root').toBe(true);
    expect(table.engine.submitMove('p1', 'e').ok).toBe(true);
    const result = table.engine.pump();
    expect(table.ren.x, 'a dazed body walked').toBe(3);
    expect(result.refusals).toContainEqual({ id: 'p1', reason: 'pinned' });
  });

  it('still swings at what it walks into — the rooted body attacks', () => {
    const table = stage('daze-swing');
    const husk = table.world.addMonster('m1', {
      name: 'Index Husk',
      sprite: 'enemy_index_husk_s',
      x: 3,
      y: 5,
      profile: AiProfile.MeleeChaser,
      maxHp: 500,
    });
    husk.hpRegen = 0;
    table.daze();

    expect(table.engine.submitMove('p1', 'e').ok).toBe(true);
    const result = table.engine.pump();
    expect(result.refusals, 'the bump was refused as a move').not.toContainEqual({
      id: 'p1',
      reason: 'pinned',
    });
    expect(
      result.playerEvents.some((event) => event.k === 'attack'),
      'the rooted body did not swing',
    ).toBe(true);
    expect(table.ren.x).toBe(2);
  });

  it('is broken by a bleed ticking, which is not a blow — and then the body walks', () => {
    const table = stage('daze-tick');
    table.daze();
    setEffect(table.effects, table.ren, EffectId.Bleeding, 3, { power: 1 }, createRng('bleed'));

    expect(table.engine.hold('p1').ok).toBe(true);
    table.engine.pump();
    expect(table.ren.hp, 'the bleed never ticked').toBeLessThan(500);
    expect(hasEffect(table.effects, 'p1', EffectId.Dazed), 'the tick left the daze on').toBe(false);
    expect(table.struck, 'a tick was paid as a blow').toEqual([]);

    expect(table.engine.submitMove('p1', 'e').ok).toBe(true);
    table.engine.pump();
    expect(table.ren.x, 'the body the tick woke up could not walk').toBe(3);
  });

  it('is NOT broken by a heal ticking — only damage un-dazes', () => {
    // The un-daze is in `onTakeHit` (tome/class/Actor.lua:2156-2158); a heal is
    // never a hit. The tick lane reports a heal with `amount` 0.
    const table = stage('daze-heal');
    table.ren.hp = 400;
    table.daze();
    setEffect(table.effects, table.ren, EffectId.Regeneration, 3, { power: 5 }, createRng('regen'));

    expect(table.engine.hold('p1').ok).toBe(true);
    table.engine.pump();
    expect(table.ren.hp, 'the regeneration never ticked').toBeGreaterThan(400);
    expect(hasEffect(table.effects, 'p1', EffectId.Dazed), 'a heal broke the daze').toBe(true);
  });

  it('says what upstream says to a body that cannot move', () => {
    // tome/class/Actor.lua:1341 — "You are unable to move!", not "you cannot go
    // that way", which sends a player looking for another direction.
    expect(refusalFrame('pinned')).toEqual({
      code: ErrorCode.Refused,
      message: 'You are unable to move!',
    });
    expect(refusalFrame('terrain').code).toBe(ErrorCode.IllegalMove);
  });
});
