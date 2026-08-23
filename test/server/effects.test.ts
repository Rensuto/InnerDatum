import { describe, expect, it } from 'vitest';

import {
  DURATION_PCT_CAP,
  EffectStatus,
  ImmunityKey,
  MEAN_FACT,
  NORMAL_SAMPLES,
  SAVE_FOR_EFFECTS,
  STD_DEV,
  SaveChannel,
  SetEffectOutcome,
  StackMode,
  budgetPenalty,
  canBe,
  createEffectState,
  dispelChannel,
  effectDur,
  effectModifiers,
  effectsOn,
  forgetActor,
  grantImmunity,
  hasEffect,
  lockoutTalents,
  noTalentsCooldown,
  normalFloat,
  recomputeAttributes,
  registerEffect,
  removeEffect,
  rollSaveDuration,
  saveOf,
  setEffect,
  statusPass,
  timedEffects,
} from '../../src/server/engine/effects.ts';
import {
  BLEEDING,
  BLEED_POWER,
  EFFECT_IDS,
  EffectId,
  MVP_EFFECTS,
  SLOWED,
  SLOW_POWER,
  STUNNED,
  STUN_TALENT_LOCKOUT,
  createMvpEffectState,
  isStunned,
  validateEffect,
} from '../../src/server/content/effects.ts';
import {
  AiProfile,
  HOLD_INTENT,
  actBase,
  createMonsterActor,
  createPlayerActor,
  setCooldown,
} from '../../src/server/engine/actor.ts';
import { createBarrier } from '../../src/server/engine/barrier.ts';
import { pump, submitIntent } from '../../src/server/engine/scheduler.ts';
import { createWorld } from '../../src/server/world/world.ts';
import { TICKS_PER_GAME_TURN } from '../../src/shared/energy.ts';
import { checkHitOld } from '../../src/shared/checkhit.ts';
import { combatPhysicalResist } from '../../src/server/engine/derived.ts';
import { createRng } from '../../src/shared/rng.ts';
import { drawCount, scriptedRng } from '../helpers/scripted-rng.ts';
import type { EffectActor, EffectDef } from '../../src/server/engine/effects.ts';
import type { Rng } from '../../src/shared/rng.ts';

/**
 * ===========================================================================
 * THE THREE THINGS THIS FILE EXISTS FOR
 * ===========================================================================
 *
 *   1. THE STOCHASTIC ROUNDING AT Actor.lua:7011 (CLAUDE.md doc drift #1).
 *      docs/tome-mechanics.md § 6 quotes the duration formula and stops at
 *      :7009. Without the extra draw, a partial save floors — and every
 *      duration under one full turn collapses to zero, which turns partial
 *      saves back into the binary miss they exist to replace.
 *   2. THE EFFECT'S TYPE PICKS THE SAVE (Actor.lua:6981-6986), not the attack.
 *      Pinned by giving an actor a huge physical save and a terrible mental
 *      one and applying a physical effect with a mental-flavoured delivery.
 *   3. THE DECREMENT COMES AFTER `on_timeout` (ActorTemporaryEffects.lua:91
 *      after :85), and an expired effect survives one extra tick (:80-81). So
 *      `dur: 1` ticks exactly once.
 *
 * None of the three produces a crash, a type error, or a failing plumbing test.
 *
 * `scriptedRng` returns its script verbatim from EVERY method, so a
 * `nextFloat` of 0.5 lands `normalFloat` exactly on its mean and an `int` of
 * `n` is the d100. That is what lets these tests state arithmetic instead of
 * distributions.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function monster(over: Partial<EffectActor> = {}): EffectActor {
  const base = createMonsterActor('m1', {
    name: 'Index Husk',
    sprite: 'enemy_index_husk_s',
    x: 5,
    y: 5,
    profile: AiProfile.MeleeChaser,
  });
  return Object.assign(base, over);
}

function player(over: Partial<EffectActor> = {}): EffectActor {
  const base = createPlayerActor('p1', { name: 'Dalt', sprite: 'pc_detective_s', x: 1, y: 1 });
  return Object.assign(base, over);
}

/** `normalFloat` sits exactly on its mean when every uniform sample is 0.5. */
const ON_THE_MEAN: readonly number[] = [0.5, 0.5, 0.5];

const NEVER_IMMUNE: readonly number[] = [];

/** save roll, 3× normalFloat, stochastic round. The full save-gated budget. */
function saveScript(saveRoll: number, roundRoll: number): number[] {
  return [saveRoll, ...ON_THE_MEAN, roundRoll];
}

// ---------------------------------------------------------------------------
// 1. save_for_effects — Actor.lua:6980-6986
// ---------------------------------------------------------------------------

describe('SAVE_FOR_EFFECTS — the effect TYPE picks the save (Actor.lua:6981-6986)', () => {
  it('maps each channel to ToME`s own getter', () => {
    expect(SAVE_FOR_EFFECTS[SaveChannel.Physical]).toBe(combatPhysicalResist);
    // The table is keyed by `e.type`, the EFFECT DEFINITION's type — Actor.lua:7002.
    expect(Object.keys(SAVE_FOR_EFFECTS).sort()).toEqual(['magical', 'mental', 'physical']);
  });

  it('reads the PHYSICAL save for a physical effect even when the mental save is ruinous', () => {
    // Con 40 / Str 40 → a big physical save. Cun 1 / Wil 1 → a terrible mental one.
    const sheet = { stats: { con: 40, str: 40, cun: 1, wil: 1 } };
    const phys = saveOf(sheet, SaveChannel.Physical);
    const mental = saveOf(sheet, SaveChannel.Mental);
    expect(phys).toBeGreaterThan(mental);

    // STUNNED is `type: 'physical'`, so THIS is the number a stun rolls against,
    // no matter what delivered it. The classic mis-port routes the save off the
    // attack instead and this assertion is what catches it.
    expect(saveOf(sheet, STUNNED.type)).toBe(phys);
    expect(saveOf(sheet, BLEEDING.type)).toBe(phys);
    expect(saveOf(sheet, SLOWED.type)).toBe(phys);
  });

  it('honours `applySave` — Actor.lua:7002`s `p.apply_save` override', () => {
    const state = createMvpEffectState();
    // Huge physical save, no mental save at all.
    const target = monster({ combat: { stats: { con: 60, str: 60, cun: 1, wil: 1 } } });

    // Rolled against the MENTAL save (near zero), so the power wins comfortably.
    const rng = scriptedRng(saveScript(99, 100));
    const landed = setEffect(
      state,
      target,
      EffectId.Stunned,
      3,
      { applyPower: 30, applySave: SaveChannel.Mental },
      rng,
    );
    expect(landed.savedVs).toBe(SaveChannel.Mental);
    expect(landed.saveChance).toBeLessThan(saveOf(target.combat, SaveChannel.Physical));
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE CLASSIC MIS-PORT, SHOWN AS TWO OUTCOMES OFF ONE SCRIPT
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * A MIND effect is resisted by the MENTAL save even when a truncheon put it
   * there. Actor.lua:7002 reads `save_for_effects[e.type]` — `e` is the EFFECT
   * DEFINITION, and there is no parameter anywhere on the delivery that can
   * choose a channel. The intuitive version routes the save off the damage type
   * or the talent's school, and the symptom is that one class's saves never
   * matter to the effects that are supposed to threaten it.
   *
   * Two definitions identical in every field but `type`, one physical delivery
   * (`applyPower: 30`, exactly as a weapon hands it over), one scripted RNG:
   *
   *   physical save 31 → checkHitOld(31, 30) = 52.19% · roll 50 ≤ 52.19 → SAVED
   *   mental   save  0 → checkHitOld( 0, 30) =  5.00% · roll 50 >  5.00 → not
   *
   * So the victim — a bruiser with Con 60 / Str 60 and Cun 1 / Wil 1 — shrugs
   * off the physical version outright and eats the mental one at full length.
   * Route the save off the ATTACK and both come back identical, with nothing
   * failing anywhere.
   */
  it('uses the MENTAL save for a mind effect delivered by a physical attack', () => {
    const state = createEffectState();
    // Only `type` differs. Same subtypes, same status, same stacking, same id
    // prefix — so nothing but Actor.lua:6981-6986 can explain a difference.
    const mindLash: EffectDef = { ...SLOWED, id: 'effect:test_mind', type: SaveChannel.Mental };
    const bodyLash: EffectDef = { ...SLOWED, id: 'effect:test_body', type: SaveChannel.Physical };
    registerEffect(state, mindLash);
    registerEffect(state, bodyLash);

    const bruiser = { stats: { con: 60, str: 60, cun: 1, wil: 1 } };
    expect(saveOf(bruiser, SaveChannel.Physical)).toBe(31);
    expect(saveOf(bruiser, SaveChannel.Mental)).toBe(0);

    // The delivery is a physical weapon's power, and it is the SAME number in
    // both applications. `applySave` is deliberately not used.
    const swing = { applyPower: 30 };
    const script = saveScript(50, 100);

    const mind = setEffect(
      state,
      monster({ combat: bruiser }),
      mindLash.id,
      4,
      swing,
      scriptedRng(script),
    );
    const body = setEffect(
      state,
      monster({ combat: bruiser }),
      bodyLash.id,
      4,
      swing,
      scriptedRng(script),
    );

    // The channel each one actually rolled against.
    expect(mind.savedVs).toBe(SaveChannel.Mental);
    expect(body.savedVs).toBe(SaveChannel.Physical);
    expect(mind.saveChance).toBe(5); // Combat.lua:284's `min`
    expect(body.saveChance).toBeCloseTo(52.1925, 3);

    // mean_pct = (100 − 5) × 1.1 = 104.5 → 4 × 1.045 = 4.18 → floor 4 → min(4, 4).
    expect(mind.outcome).toBe(SetEffectOutcome.Applied);
    expect(mind.dur).toBe(4);

    // Saved (roll 50 ≤ 52.19), so the 2 turns the duration roll produced are
    // computed and then thrown away — Actor.lua:7034-7037.
    expect(body.outcome).toBe(SetEffectOutcome.Negated);
    expect(body.dur).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 2. THE HEADLINE — partial-save duration scaling, Actor.lua:6999-7014
// ---------------------------------------------------------------------------

describe('rollSaveDuration — the partial save (Actor.lua:7004-7014)', () => {
  it('exposes ToME`s tuning constants verbatim (Actor.lua:7005, :7007)', () => {
    expect(MEAN_FACT).toBe(1.1); // :7005 `mean_fact`
    expect(STD_DEV).toBe(50); // :7005 `std_dev`
    expect(DURATION_PCT_CAP).toBe(2); // :7007 `util.bound(..., 0, 2)`
    expect(NORMAL_SAMPLES).toBe(3);
  });

  /**
   * THE LOG LINE FROM game-design.md § 11:
   *   "[Record]   Dalt saves (phys 38 vs power 31, 68%) — Slowed 1 turn, not 3."
   *
   * mean_pct   = (100 − 68) × 1.1 = 35.2          (Actor.lua:7006)
   * percentage = 0.352                             (:7007, on the mean)
   * desired    = 3 × 0.352 = 1.056                 (:7009)
   * fraction   = 0.056                             (:7010)
   * floor 1, and the round roll must beat 5.6      (:7011)
   * duration   = min(3, 1) = 1                     (:7012)
   */
  it('turns a 68% save into "1 turn, not 3" — the design doc`s own log line', () => {
    const rng = scriptedRng([...ON_THE_MEAN, 57]); // 57 > 5.6 → no bump
    expect(rollSaveDuration(3, 68, rng, 'x')).toBe(1);
    expect(drawCount(rng)).toBe(4); // 3 normal samples + 1 round
  });

  it('bumps to 2 turns on the 5.6% of rolls that beat the fraction (:7011)', () => {
    // THE DRAW THE DOCS DROPPED. Floor alone would make this 1 turn always.
    const rng = scriptedRng([...ON_THE_MEAN, 5]); // 5 <= 5.6 → +1
    expect(rollSaveDuration(3, 68, rng, 'x')).toBe(2);
  });

  it('leaves a full duration when there is no save chance at all', () => {
    // mean_pct 110 → percentage 1.1 → desired 5.5 → floor 5, fraction 0.5.
    // min(5, 5) and min(5, 6) are both 5 — :7012 caps the overshoot.
    expect(rollSaveDuration(5, 0, scriptedRng([...ON_THE_MEAN, 100]))).toBe(5);
    expect(rollSaveDuration(5, 0, scriptedRng([...ON_THE_MEAN, 1]))).toBe(5);
  });

  it('collapses a strong save to 0 or 1 — the "resists" branch feeder (:7039)', () => {
    // maximum 4, saveChance 90 → mean_pct 11 → percentage 0.11 → desired 0.44.
    // floor 0, fraction 0.44 → 1 turn 44% of the time, 0 otherwise.
    expect(rollSaveDuration(4, 90, scriptedRng([...ON_THE_MEAN, 44]))).toBe(1);
    expect(rollSaveDuration(4, 90, scriptedRng([...ON_THE_MEAN, 45]))).toBe(0);
  });

  it('respects `minDur` — Actor.lua:7001/:7014', () => {
    // Same collapse as above, but the caller guaranteed a floor of 2.
    expect(rollSaveDuration(4, 90, scriptedRng([...ON_THE_MEAN, 45]), 'x', 2)).toBe(2);
  });

  it('never exceeds the duration that was asked for, even at the 2× cap (:7007, :7012)', () => {
    // Every sample at its maximum: normalFloat returns mean + std = 160 for a
    // saveChance of 0 → percentage bound to 1.6, desired 4.8 on a maximum of 3.
    const rng = scriptedRng([1, 1, 1, 1]);
    expect(rollSaveDuration(3, 0, rng)).toBe(3);
  });

  it('is monotone: a better save yields a shorter duration — the whole mechanic', () => {
    const durationAt = (saveChance: number): number =>
      rollSaveDuration(10, saveChance, scriptedRng([...ON_THE_MEAN, 100]));

    // maximum 10, on the mean, round roll 100 (never bumps):
    //   save  0% → mean_pct 110 → 11.0 → floor 11 → min(10, 11) = 10
    //   save 50% → mean_pct  55 →  5.5 → floor  5              =  5
    //   save 90% → mean_pct  11 →  1.1 → floor  1              =  1
    // Ten points of save chance buys roughly a tenth of the duration, smoothly.
    expect(durationAt(0)).toBe(10);
    expect(durationAt(50)).toBe(5);
    expect(durationAt(90)).toBe(1);
  });
});

describe('normalFloat — the reimplemented rng.normalFloat (Actor.lua:7007)', () => {
  it('averages NORMAL_SAMPLES uniforms on [-std, +std] and is BOUNDED by them', () => {
    expect(normalFloat(scriptedRng([0.5, 0.5, 0.5]), 'x', 110, 50)).toBeCloseTo(110, 10);
    expect(normalFloat(scriptedRng([0, 0, 0]), 'x', 110, 50)).toBeCloseTo(60, 10);
    // nextFloat is [0, 1), so +std is approached and never reached.
    expect(normalFloat(scriptedRng([1, 1, 1]), 'x', 110, 50)).toBeCloseTo(160, 10);
  });

  it('consumes exactly NORMAL_SAMPLES draws', () => {
    const rng = scriptedRng([0.1, 0.2, 0.3]);
    normalFloat(rng, 'x', 0, 1);
    expect(drawCount(rng)).toBe(NORMAL_SAMPLES);
  });

  it('has a spread of std/3, not std — a real Gaussian would be 3× noisier', () => {
    const rng = createRng('normal-spread');
    let sum = 0;
    let sumSq = 0;
    const n = 4000;
    for (let i = 0; i < n; i += 1) {
      const v = normalFloat(rng, 'spread', 0, 50);
      sum += v;
      sumSq += v * v;
      // BOUNDED. Box-Muller would leave this range roughly 0.3% of the time.
      expect(Math.abs(v)).toBeLessThanOrEqual(50);
    }
    const mean = sum / n;
    const sd = Math.sqrt(sumSq / n - mean * mean);
    expect(Math.abs(mean)).toBeLessThan(1.5);
    expect(sd).toBeGreaterThan(14);
    expect(sd).toBeLessThan(20); // 50/3 ≈ 16.67
  });
});

// ---------------------------------------------------------------------------
// 3. setEffect — the negate branch and the draw budget
// ---------------------------------------------------------------------------

describe('setEffect — Actor.lua:6993-7043', () => {
  it('applies at FULL duration and consumes NO draws without `applyPower` (:6999)', () => {
    const state = createMvpEffectState();
    const target = monster();
    const rng = scriptedRng([]); // running out of script is a failure

    const result = setEffect(state, target, EffectId.Stunned, 4, {}, rng);
    expect(result.outcome).toBe(SetEffectOutcome.Applied);
    expect(result.dur).toBe(4);
    expect(result.saveChance).toBeNull();
    expect(drawCount(rng)).toBe(0);
  });

  it('consumes exactly FIVE draws when a save is rolled', () => {
    // 1 checkHitOld percent + 3 normalFloat samples + 1 stochastic round.
    // A stage that quietly stops drawing desynchronises the rest of the turn.
    const state = createMvpEffectState();
    const rng = scriptedRng(saveScript(100, 100));
    setEffect(state, monster(), EffectId.Stunned, 3, { applyPower: 20 }, rng);
    expect(drawCount(rng)).toBe(5);
  });

  /**
   * THE NEGATE BRANCH — Actor.lua:7034-7037.
   *
   * The duration is computed FIRST (:7014) and then thrown away when `saved` is
   * true. `saved` and the duration are two SEPARATE draws off the same chance,
   * which is why a strong save can still occasionally eat a full stun.
   */
  it('negates outright when the save roll lands, even with a rolled duration (:7034-7037)', () => {
    const state = createMvpEffectState();
    const target = monster();
    // A default actor's physical save is 7 (rescale of (10+10)·0.35), and
    // checkHitOld(7, 7) is exactly parity — Combat.lua:285-288.
    const save = saveOf(target.combat, SaveChannel.Physical);
    expect(save).toBe(7);
    expect(checkHitOld(save, 7, scriptedRng([50]), 'probe').chance).toBe(50);

    // mean_pct = (100 − 50) × 1.1 = 55 → 3 × 0.55 = 1.65 → floor 1, and the
    // round roll of 100 does not bump it. So a NON-ZERO duration was computed…
    // …and then the save roll of 1 (≤ 50) throws it away. :7034-7037.
    const rng = scriptedRng(saveScript(1, 100));
    const result = setEffect(state, target, EffectId.Stunned, 3, { applyPower: 7 }, rng);

    expect(result.outcome).toBe(SetEffectOutcome.Negated);
    expect(result.dur).toBe(0);
    expect(hasEffect(state, target.id, EffectId.Stunned)).toBe(false);
    // All five draws still happened. The duration was rolled and discarded.
    expect(drawCount(rng)).toBe(5);
  });

  it('lands that same 1 turn when the save roll misses — the partial, side by side', () => {
    const state = createMvpEffectState();
    const target = monster();
    // Identical script except the save roll: 51 > 50, so `saved` is false and
    // the duration computed above survives. THIS is "1 turn, not 3".
    const rng = scriptedRng(saveScript(51, 100));
    const result = setEffect(state, target, EffectId.Stunned, 3, { applyPower: 7 }, rng);

    expect(result.outcome).toBe(SetEffectOutcome.Applied);
    expect(result.dur).toBe(1);
    expect(result.maximum).toBe(3);
    expect(result.effect?.amountDecreased).toBe(2);
  });

  it('RESISTS (a different event) when the save fails but the duration scales to 0 (:7038-7040)', () => {
    const state = createMvpEffectState();
    const target = monster({ combat: { stats: { con: 60, str: 60 } } });

    // Save roll of 100 always fails → not negated. But a huge save means a tiny
    // mean_pct, so the duration collapses and there is nothing left to apply.
    const rng = scriptedRng(saveScript(100, 100));
    const result = setEffect(state, target, EffectId.Stunned, 2, { applyPower: 1 }, rng);

    expect(result.outcome).toBe(SetEffectOutcome.Resisted);
    expect(result.dur).toBe(0);
    expect(hasEffect(state, target.id, EffectId.Stunned)).toBe(false);
  });

  it('records the partial save as `amountDecreased` — Actor.lua:7015', () => {
    const state = createMvpEffectState();
    const target = monster();
    // Force a known partial: save chance 68 is unreachable from stats here, so
    // drive `rollSaveDuration` directly and compare against what landed.
    const rng = scriptedRng(saveScript(100, 100));
    const result = setEffect(state, target, EffectId.Slowed, 5, { applyPower: 25 }, rng);

    expect(result.outcome).toBe(SetEffectOutcome.Applied);
    const eff = result.effect;
    expect(eff).not.toBeNull();
    if (eff === null) return;
    // "N turns, not 5" — the number the Case Log prints.
    expect(eff.amountDecreased).toBe(eff.maximum - eff.dur);
    expect(eff.maximum).toBe(5);
    expect(eff.savedVs).toBe(SaveChannel.Physical);
  });

  it('does NOT refuse a beneficial effect — the negate block is detrimental-only (:7024)', () => {
    const state = createEffectState();
    const boon: EffectDef = {
      id: 'effect:test_boon',
      displayName: 'Boon',
      badge: 'Bo',
      description: 'test',
      type: SaveChannel.Physical,
      status: EffectStatus.Beneficial,
      stackMode: StackMode.Refresh,
      subtypes: ['boon'],
      decrease: 1,
      icon: 'icon_status_shielded',
    };
    registerEffect(state, boon);

    // A save roll of 1 always "hits" — for a detrimental effect that would negate.
    const rng = scriptedRng(saveScript(1, 100));
    const result = setEffect(state, monster(), boon.id, 4, { applyPower: 20 }, rng);
    expect(result.outcome).toBe(SetEffectOutcome.Applied);
  });

  it('removes rather than applies when asked for a non-positive duration (:109)', () => {
    const state = createMvpEffectState();
    const target = monster();
    setEffect(state, target, EffectId.Slowed, 3, {}, scriptedRng([]));
    expect(hasEffect(state, target.id, EffectId.Slowed)).toBe(true);

    const result = setEffect(state, target, EffectId.Slowed, 0, {}, scriptedRng([]));
    expect(result.outcome).toBe(SetEffectOutcome.Removed);
    expect(hasEffect(state, target.id, EffectId.Slowed)).toBe(false);
  });

  it('floors a fractional duration — ActorTemporaryEffects.lua:110', () => {
    const state = createMvpEffectState();
    const target = monster();
    setEffect(state, target, EffectId.Slowed, 3.9, {}, scriptedRng([]));
    expect(effectDur(state, target.id, EffectId.Slowed)).toBe(3);
  });

  it('refuses an unknown id rather than throwing', () => {
    const state = createMvpEffectState();
    const result = setEffect(state, monster(), 'effect:nope', 3, {}, scriptedRng([]));
    expect(result.outcome).toBe(SetEffectOutcome.Unknown);
  });
});

// ---------------------------------------------------------------------------
// 4. Immunity — Actor.lua:6944-6978
// ---------------------------------------------------------------------------

describe('canBe — immunity (Actor.lua:6951-6978)', () => {
  it('composes subtype resistances MULTIPLICATIVELY (:6964-6968)', () => {
    const state = createMvpEffectState();
    const target = monster();
    // BLEEDING carries { wound, cut, bleed } — physical.lua:128.
    grantImmunity(state, target.id, 'wound', 50);
    grantImmunity(state, target.id, 'bleed', 50);

    // 100 × 0.5 × 0.5 = 25% chance of being affected. Additive stacking would
    // make two mediocre immunities a total one.
    const result = canBe(state, target, BLEEDING, scriptedRng([25]));
    expect(result.chance).toBe(25);
    expect(result.can).toBe(true);
    expect(canBe(state, target, BLEEDING, scriptedRng([26])).can).toBe(false);
  });

  it('refuses total immunity with NO DRAW (:6969)', () => {
    const state = createMvpEffectState();
    const target = monster();
    grantImmunity(state, target.id, 'stun', 100);
    const rng = scriptedRng([]); // any draw here would throw
    expect(canBe(state, target, STUNNED, rng).can).toBe(false);
    expect(drawCount(rng)).toBe(0);
  });

  it('draws nothing at all when nothing is resisted (:6977`s short-circuit)', () => {
    const state = createMvpEffectState();
    const rng = scriptedRng(NEVER_IMMUNE);
    expect(canBe(state, monster(), STUNNED, rng).can).toBe(true);
    expect(drawCount(rng)).toBe(0);
  });

  it('honours the blanket per-channel immunity (:6958-6960)', () => {
    const state = createMvpEffectState();
    const target = monster();
    grantImmunity(state, target.id, ImmunityKey.PhysicalNegative, 1);
    expect(canBe(state, target, STUNNED, scriptedRng([])).can).toBe(false);

    const result = setEffect(state, target, EffectId.Stunned, 3, {}, scriptedRng([]));
    expect(result.outcome).toBe(SetEffectOutcome.Immune);
  });

  /**
   * IMMUNITY BLOCKS ENTIRELY — not "for zero turns", not "at reduced duration".
   * The refusal happens at Actor.lua:6951-6978, BEFORE the save at :6999, so no
   * instance is created, no modifier is composed and no save is even rolled.
   * A port that returned a 0-duration instance would leave the badge on the
   * portrait and the freeze on the cooldowns.
   */
  it('blocks entirely: no instance, no flag, no freeze, and no save rolled', () => {
    const state = createMvpEffectState();
    const target = monster();
    grantImmunity(state, target.id, 'stun', 100);

    const rng = scriptedRng([]); // a save roll here would throw
    const result = setEffect(state, target, EffectId.Stunned, 5, { applyPower: 40 }, rng);

    expect(result.outcome).toBe(SetEffectOutcome.Immune);
    expect(result.effect).toBeNull();
    expect(result.saveChance).toBeNull();
    expect(drawCount(rng)).toBe(0);

    // And none of STUNNED's consequences arrived by another route.
    expect(hasEffect(state, target.id, EffectId.Stunned)).toBe(false);
    expect(effectsOn(state, target.id)).toHaveLength(0);
    expect(noTalentsCooldown(state, target.id)).toBe(false);
    expect(isStunned(state, target.id)).toBe(false);
  });

  it('treats a corpse as immune to everything', () => {
    const state = createMvpEffectState();
    const target = monster({ alive: false });
    expect(setEffect(state, target, EffectId.Stunned, 3, {}, scriptedRng([])).outcome).toBe(
      SetEffectOutcome.Immune,
    );
  });
});

// ---------------------------------------------------------------------------
// 5. The tick — ActorTemporaryEffects.lua:74-98
// ---------------------------------------------------------------------------

describe('timedEffects — ActorTemporaryEffects.lua:74-98', () => {
  it('fires on_timeout BEFORE decrementing (:85 then :91) — `dur: 1` ticks exactly once', () => {
    const state = createMvpEffectState();
    const target = monster({ hp: 40, maxHp: 40 });
    setEffect(state, target, EffectId.Bleeding, 1, { power: BLEED_POWER }, scriptedRng([]));

    const rng = createRng('bleed-1');
    const first = timedEffects(state, target, rng);
    expect(first.ticked).toEqual([EffectId.Bleeding]);
    expect(target.hp).toBe(40 - BLEED_POWER); // it DID tick
    expect(effectDur(state, target.id, EffectId.Bleeding)).toBe(0); // then decremented

    // :80-81 — the NEXT pass sees dur <= 0, removes it, and does NOT tick.
    const second = timedEffects(state, target, rng);
    expect(second.ticked).toEqual([]);
    expect(second.expired).toEqual([EffectId.Bleeding]);
    expect(target.hp).toBe(40 - BLEED_POWER);
    expect(hasEffect(state, target.id, EffectId.Bleeding)).toBe(false);
  });

  it('deals exactly power × dur over a multi-turn bleed', () => {
    const state = createMvpEffectState();
    const target = monster({ hp: 40, maxHp: 40 });
    setEffect(state, target, EffectId.Bleeding, 4, { power: 3 }, scriptedRng([]));

    const rng = createRng('bleed-4');
    for (let i = 0; i < 4; i += 1) timedEffects(state, target, rng);
    expect(target.hp).toBe(40 - 12); // 3 × 4, exactly
    // Still present with dur 0 — it goes on the fifth pass (:80-81).
    expect(hasEffect(state, target.id, EffectId.Bleeding)).toBe(true);
    timedEffects(state, target, rng);
    expect(hasEffect(state, target.id, EffectId.Bleeding)).toBe(false);
    expect(target.hp).toBe(40 - 12);
  });

  it('draws NOTHING per bleed tick — no damage range, no crit (damage.ts steps 1 and 3)', () => {
    const state = createMvpEffectState();
    const target = monster({ hp: 40, maxHp: 40 });
    setEffect(state, target, EffectId.Bleeding, 2, { power: 3 }, scriptedRng([]));
    const rng = scriptedRng([]);
    timedEffects(state, target, rng);
    expect(drawCount(rng)).toBe(0);
  });

  it('honours `decrease` — ActorTemporaryEffects.lua:54, :91', () => {
    const state = createEffectState();
    const slowTick: EffectDef = { ...SLOWED, id: 'effect:test_half', decrease: 0.5 };
    registerEffect(state, slowTick);
    const target = monster();
    setEffect(state, target, slowTick.id, 2, {}, scriptedRng([]));

    const rng = createRng('decrease');
    timedEffects(state, target, rng);
    expect(effectDur(state, target.id, slowTick.id)).toBe(1.5);
  });

  it('respects a filter, exactly as ToME`s `timedEffects(filter)` does (:79)', () => {
    const state = createMvpEffectState();
    const target = monster({ hp: 40, maxHp: 40 });
    setEffect(state, target, EffectId.Bleeding, 3, { power: 3 }, scriptedRng([]));
    setEffect(state, target, EffectId.Slowed, 3, {}, scriptedRng([]));

    timedEffects(state, target, createRng('filter'), {}, (def) => def.id === EffectId.Slowed);
    expect(effectDur(state, target.id, EffectId.Slowed)).toBe(2);
    expect(effectDur(state, target.id, EffectId.Bleeding)).toBe(3); // untouched
    expect(target.hp).toBe(40);
  });

  it('removes an effect whose on_timeout returns true (:85-86)', () => {
    const state = createEffectState();
    const oneShot: EffectDef = {
      ...SLOWED,
      id: 'effect:test_oneshot',
      onTimeout: (): boolean => true,
    };
    registerEffect(state, oneShot);
    const target = monster();
    setEffect(state, target, oneShot.id, 5, {}, scriptedRng([]));
    timedEffects(state, target, createRng('oneshot'));
    expect(hasEffect(state, target.id, oneShot.id)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5b. THE CLOCK — Actor.lua:597 is inside actBase, and actBase is energyBase
// ---------------------------------------------------------------------------

describe('durations run on the BASE clock, once per game turn at any speed', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * HASTE BUYS ACTIONS. IT MUST NEVER BUY A SHORTER DEBUFF.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `timedEffects` is called from `actBase` (Actor.lua:597), which fires on
   * `energyBase` — a flat ENERGY_PER_TICK per tick, never multiplied
   * (GameEnergyBased.lua:114-121). Put a duration on the ACT clock instead and a
   * hasted actor shrugs a 5-turn stun in three turns while a slowed one wears it
   * for eight, with nothing failing anywhere and the only symptom being that
   * haste quietly becomes the best defensive stat in the game.
   *
   * Two husks in ONE world, on the same seed, differing only in `globalSpeed`,
   * driven through the real `pump`. Same stun, same number of turns.
   */
  it('decrements a hasted monster`s stun at exactly the same rate as a normal one', () => {
    const world = createWorld('duration-clock');
    const barrier = createBarrier();
    const effects = createMvpEffectState();

    world.addPlayer('p1', 'Dalt');
    const brisk = world.addMonster('m1', {
      name: 'Index Husk',
      sprite: 'enemy_index_husk_s',
      x: 7,
      y: 2,
      profile: AiProfile.MeleeChaser,
      globalSpeed: 2,
    });
    const plodding = world.addMonster('m2', {
      name: 'Index Husk',
      sprite: 'enemy_index_husk_s',
      x: 8,
      y: 2,
      profile: AiProfile.MeleeChaser,
    });
    for (const husk of [brisk, plodding]) {
      husk.maxHp = 10_000;
      husk.hp = 10_000;
      setEffect(effects, husk, EffectId.Stunned, 20, {}, world.rng);
    }
    expect(brisk.globalSpeed).toBe(2);
    expect(plodding.globalSpeed).toBe(1);

    const pass = statusPass(effects, world.rng);
    // The opening pump takes nobody's turn — it fills the act clocks and parks.
    pump(world, { nowMs: 0, barrier, statusPass: pass });
    for (let turn = 1; turn <= 6; turn += 1) {
      submitIntent(world, barrier, 'p1', HOLD_INTENT);
      const result = pump(world, { nowMs: turn, barrier, statusPass: pass });
      expect(result.gameTurns).toBe(1);
    }

    // Seven game turns of base clock, seven decrements, at both speeds.
    expect(effectDur(effects, 'm1', EffectId.Stunned)).toBe(13);
    expect(effectDur(effects, 'm2', EffectId.Stunned)).toBe(13);
  });
});

// ---------------------------------------------------------------------------
// 6. STUNNED — the freeze
// ---------------------------------------------------------------------------

describe('STUNNED — the cooldown freeze (Actor.lua:606)', () => {
  it('sets no_talents_cooldown and the ×0.4 damage flag', () => {
    const state = createMvpEffectState();
    const target = monster();
    setEffect(state, target, EffectId.Stunned, 3, {}, scriptedRng([]));

    expect(noTalentsCooldown(state, target.id)).toBe(true);
    // damage_types.lua:150-153, read by combat.ts:356 as `sourceStunned`.
    expect(target.combat?.flags?.stunned).toBe(true);
    expect(isStunned(state, target.id)).toBe(true);
  });

  /**
   * THE HEADLINE BEHAVIOUR. A stunned actor's cooldowns DO NOT TICK.
   *
   * Actor.lua:606 — `if not self:attr("no_talents_cooldown") then
   * self:cooldownTalents() end`. Without it, stun is a damage debuff you wait
   * out with a full bar of talents ready.
   */
  it('FREEZES cooldowns through actBase, and releases them the turn it expires', () => {
    const state = createMvpEffectState();
    const target = createMonsterActor('m9', {
      name: 'Index Husk',
      sprite: 'enemy_index_husk_s',
      x: 2,
      y: 2,
      profile: AiProfile.MeleeChaser,
    });
    setCooldown(target, 'talent:crude_blow', 4);
    setEffect(state, target, EffectId.Stunned, 2, {}, scriptedRng([]));

    const rng = createRng('freeze');
    const pass = statusPass(state, rng);
    // `statusPass` returns a plain `(actor) => boolean`; `EngineActor` satisfies
    // `EffectActor` structurally, which is the proof that the seam needs no cast.
    const tick = (): void => actBase(target, pass);

    // Turn 1: stunned (dur 2 → 1). Cooldown must NOT move.
    tick();
    expect(target.cooldowns.get('talent:crude_blow')).toBe(4);
    // Turn 2: still stunned (dur 1 → 0).
    tick();
    expect(target.cooldowns.get('talent:crude_blow')).toBe(4);
    // Turn 3: the stun is removed by this very pass (:80-81), and Actor.lua
    // reads the attr AFTER :597's timedEffects — so cooldowns tick THIS turn.
    tick();
    expect(target.cooldowns.get('talent:crude_blow')).toBe(3);
    expect(hasEffect(state, target.id, EffectId.Stunned)).toBe(false);
    // And normally thereafter.
    tick();
    expect(target.cooldowns.get('talent:crude_blow')).toBe(2);
  });

  it('actBase without a status pass behaves exactly as it did before M4', () => {
    const target = createMonsterActor('m8', {
      name: 'Index Husk',
      sprite: 'enemy_index_husk_s',
      x: 2,
      y: 2,
      profile: AiProfile.MeleeChaser,
    });
    setCooldown(target, 'talent:crude_blow', 2);
    actBase(target);
    expect(target.cooldowns.get('talent:crude_blow')).toBe(1);
  });

  it('locks out three READY talents on a 1-turn cooldown (physical.lua:495-504)', () => {
    const state = createMvpEffectState();
    const target = monster();
    const loadout = ['talent:a', 'talent:b', 'talent:c', 'talent:d'];

    setEffect(state, target, EffectId.Stunned, 3, {}, createRng('lockout'), {
      activatableTalents: () => loadout,
    });

    const locked = loadout.filter((id) => target.cooldowns.has(id));
    expect(locked).toHaveLength(STUN_TALENT_LOCKOUT);
    for (const id of locked) expect(target.cooldowns.get(id)).toBe(1);
  });

  it('never re-cools a talent already cooling down — that would SHORTEN it (:498)', () => {
    const target = monster();
    setCooldown(target, 'talent:long', 9);
    const picked = lockoutTalents(target, ['talent:long', 'talent:free'], 3, createRng('l2'), 'x');
    expect(picked).toEqual(['talent:free']);
    expect(target.cooldowns.get('talent:long')).toBe(9);
  });
});

// ---------------------------------------------------------------------------
// 7. BLEEDING — the merge
// ---------------------------------------------------------------------------

describe('BLEEDING — CUT`s on_merge conserves total damage (physical.lua:133-141)', () => {
  it('merges 3×4 into 3×4 as 6×4 — the SAME 24 total, front-loaded', () => {
    const state = createMvpEffectState();
    const target = monster({ hp: 60, maxHp: 60 });
    setEffect(state, target, EffectId.Bleeding, 4, { power: 3 }, scriptedRng([]));
    const merged = setEffect(state, target, EffectId.Bleeding, 4, { power: 3 }, scriptedRng([]));

    expect(merged.outcome).toBe(SetEffectOutcome.Merged);
    const eff = merged.effect;
    expect(eff).not.toBeNull();
    if (eff === null) return;
    // olddam 12, newdam 12, dur ceil(8/2) = 4, power 24/4 = 6.
    expect(eff.dur).toBe(4);
    expect(eff.params.power).toBe(6);

    const rng = createRng('merge-total');
    for (let i = 0; i < 4; i += 1) timedEffects(state, target, rng);
    expect(target.hp).toBe(60 - 24); // NOT 48. It does not stack.
  });

  it('handles the uneven case: {3, 1} + {9, 5} → power 16 over 3 turns', () => {
    const state = createMvpEffectState();
    const target = monster({ hp: 80, maxHp: 80 });
    setEffect(state, target, EffectId.Bleeding, 1, { power: 3 }, scriptedRng([]));
    setEffect(state, target, EffectId.Bleeding, 5, { power: 9 }, scriptedRng([]));

    const eff = effectsOn(state, target.id)[0];
    expect(eff).toBeDefined();
    if (eff === undefined) return;
    // 3 + 45 = 48 total; dur ceil(6/2) = 3; power 48/3 = 16.
    expect(eff.dur).toBe(3);
    expect(eff.params.power).toBe(16);
  });

  it('applies physical RESISTANCE but never armour — the DoT goes through the projector', () => {
    const state = createMvpEffectState();
    const resistant = monster({
      hp: 40,
      maxHp: 40,
      // Armour 20 would erase a 3-damage hit if the armour stage ran at all.
      combat: {
        mods: { armour: 20, armourHardiness: 100 },
        profile: { resists: { physical: 50 } },
      },
    });
    setEffect(state, resistant, EffectId.Bleeding, 1, { power: 4 }, scriptedRng([]));
    timedEffects(state, resistant, createRng('bleed-resist'));
    // 4 × (1 − 0.50) = 2. Armour never entered the pipeline.
    expect(resistant.hp).toBe(38);
  });

  it('blames the source when one is named, and the wound`s owner otherwise (:150)', () => {
    const state = createMvpEffectState();
    const victim = monster({ hp: 30, maxHp: 30 });
    const cutter = player();
    setEffect(state, victim, EffectId.Bleeding, 2, { power: 3, srcId: cutter.id }, scriptedRng([]));

    // A STUNNED source deals ×0.4 through the projector — damage_types.lua:150-153.
    setEffect(state, cutter, EffectId.Stunned, 3, {}, scriptedRng([]));
    timedEffects(state, victim, createRng('blame'), { getActor: () => cutter });
    expect(victim.hp).toBeCloseTo(30 - 3 * 0.4, 10);
  });
});

// ---------------------------------------------------------------------------
// 8. SLOWED — the D1 asymmetry
// ---------------------------------------------------------------------------

describe('SLOWED — two mechanisms, one effect (physical.lua:631-636 + DECISIONS.md D1)', () => {
  it('reduces a MONSTER`s globalSpeed — the GAIN knob, not the cost knob', () => {
    const state = createMvpEffectState();
    const target = monster();
    expect(target.globalSpeed).toBe(1);

    setEffect(state, target, EffectId.Slowed, 3, {}, scriptedRng([]));
    // physical.lua:632 — `global_speed_add = -eff.power`. NEGATIVE.
    expect(target.globalSpeed).toBeCloseTo(1 - SLOW_POWER, 10);
    // speedFactor — the COST multiplier — is untouched. Reducing it would make
    // the monster FASTER, which is the inversion derived.ts warns about.
    expect((target as unknown as { speedFactor: number }).speedFactor).toBe(1);

    removeEffect(state, target, EffectId.Slowed, scriptedRng([]));
    expect(target.globalSpeed).toBe(1);
  });

  it('restores from a BASELINE, so two slows and one expiry do not leak', () => {
    const state = createEffectState();
    registerEffect(state, SLOWED);
    const other: EffectDef = { ...SLOWED, id: 'effect:test_slow2' };
    registerEffect(state, other);

    const target = monster();
    setEffect(state, target, EffectId.Slowed, 3, {}, scriptedRng([]));
    setEffect(state, target, other.id, 3, {}, scriptedRng([]));
    expect(target.globalSpeed).toBeCloseTo(1 - 2 * SLOW_POWER, 10);

    removeEffect(state, target, other.id, scriptedRng([]));
    expect(target.globalSpeed).toBeCloseTo(1 - SLOW_POWER, 10);
    removeEffect(state, target, EffectId.Slowed, scriptedRng([]));
    expect(target.globalSpeed).toBe(1);
  });

  it('preserves a monster`s AUTHORED base speed', () => {
    const state = createMvpEffectState();
    const fast = monster({ globalSpeed: 1.4 });
    setEffect(state, fast, EffectId.Slowed, 3, {}, scriptedRng([]));
    expect(fast.globalSpeed).toBeCloseTo(1.4 - SLOW_POWER, 10);
    removeEffect(state, fast, EffectId.Slowed, scriptedRng([]));
    expect(fast.globalSpeed).toBeCloseTo(1.4, 10);
  });

  it('NEVER touches a PLAYER`s clock — it spends the budget instead (D1)', () => {
    const state = createMvpEffectState();
    const detective = player();
    setEffect(state, detective, EffectId.Slowed, 3, {}, scriptedRng([]));

    // The pin: a player's globalSpeed stays exactly 1, or the party barrier
    // stops parking once per turn at full quorum.
    expect(detective.globalSpeed).toBe(1);
    expect(budgetPenalty(state, detective.id)).toEqual({ ap: 0, mp: 1 });
  });

  it('floors a stacked slow at 0.1 so a monster`s clock can never stop', () => {
    const state = createEffectState();
    const heavy: EffectDef = {
      ...SLOWED,
      id: 'effect:test_heavy',
      modifiers: { globalSpeedAdd: -0.95 },
    };
    registerEffect(state, heavy);
    const target = monster();
    setEffect(state, target, heavy.id, 3, {}, scriptedRng([]));
    expect(target.globalSpeed).toBe(0.1);
  });
});

// ---------------------------------------------------------------------------
// 9. Stacking, dispel, housekeeping
// ---------------------------------------------------------------------------

describe('stacking modes (ActorTemporaryEffects.lua:122-130)', () => {
  it('Refresh REPLACES — a shorter re-application genuinely shortens it (:128)', () => {
    const state = createMvpEffectState();
    const target = monster();
    setEffect(state, target, EffectId.Stunned, 5, {}, scriptedRng([]));
    setEffect(state, target, EffectId.Stunned, 1, {}, scriptedRng([]));
    // Upstream behaviour, and it is genuinely surprising the first time.
    expect(effectDur(state, target.id, EffectId.Stunned)).toBe(1);
  });

  /**
   * REFRESHING IS NOT DOUBLING. ActorTemporaryEffects.lua:128 removes and re-adds,
   * so the SECOND application's duration is the whole answer. The plausible-wrong
   * version adds them, and the symptom is a chain-stun that grows every time it
   * is re-applied until the victim never acts again.
   */
  it('Refresh sets the new duration rather than summing the two', () => {
    const state = createMvpEffectState();
    const target = monster();
    setEffect(state, target, EffectId.Stunned, 3, {}, scriptedRng([]));
    setEffect(state, target, EffectId.Stunned, 3, {}, scriptedRng([]));

    expect(effectDur(state, target.id, EffectId.Stunned)).toBe(3); // not 6
    // One instance, not two — a second row would double every modifier as well.
    expect(effectsOn(state, target.id)).toHaveLength(1);

    // And re-applying mid-duration restarts it rather than extending it.
    timedEffects(state, target, createRng('refresh-tick'));
    expect(effectDur(state, target.id, EffectId.Stunned)).toBe(2);
    setEffect(state, target, EffectId.Stunned, 3, {}, scriptedRng([]));
    expect(effectDur(state, target.id, EffectId.Stunned)).toBe(3);
  });

  it('Ignore leaves the live instance alone', () => {
    const state = createEffectState();
    const stubborn: EffectDef = {
      ...SLOWED,
      id: 'effect:test_ignore',
      stackMode: StackMode.Ignore,
    };
    registerEffect(state, stubborn);
    const target = monster();
    setEffect(state, target, stubborn.id, 4, {}, scriptedRng([]));
    const again = setEffect(state, target, stubborn.id, 9, {}, scriptedRng([]));
    expect(again.outcome).toBe(SetEffectOutcome.Ignored);
    expect(effectDur(state, target.id, stubborn.id)).toBe(4);
  });

  it('Stack without onMerge extends, capped at the longer `maximum`', () => {
    const state = createEffectState();
    const extend: EffectDef = { ...SLOWED, id: 'effect:test_extend', stackMode: StackMode.Stack };
    registerEffect(state, extend);
    const target = monster();
    setEffect(state, target, extend.id, 3, {}, scriptedRng([]));
    setEffect(state, target, extend.id, 2, {}, scriptedRng([]));
    expect(effectDur(state, target.id, extend.id)).toBe(3); // min(max(3,2), 3+2)
  });
});

describe('dispel and housekeeping', () => {
  it('dispelChannel removes every detrimental effect of one channel', () => {
    const state = createMvpEffectState();
    const target = monster({ hp: 40, maxHp: 40 });
    setEffect(state, target, EffectId.Stunned, 3, {}, scriptedRng([]));
    setEffect(state, target, EffectId.Bleeding, 3, {}, scriptedRng([]));

    expect(dispelChannel(state, target, SaveChannel.Physical, scriptedRng([]))).toBe(2);
    expect(effectsOn(state, target.id)).toHaveLength(0);
    // And the derived attributes come back with them.
    expect(noTalentsCooldown(state, target.id)).toBe(false);
    expect(target.combat?.flags?.stunned).toBe(false);
  });

  it('dispelChannel leaves other channels alone', () => {
    const state = createEffectState();
    registerEffect(state, STUNNED);
    const mental: EffectDef = { ...SLOWED, id: 'effect:test_mental', type: SaveChannel.Mental };
    registerEffect(state, mental);
    const target = monster();
    setEffect(state, target, EffectId.Stunned, 3, {}, scriptedRng([]));
    setEffect(state, target, mental.id, 3, {}, scriptedRng([]));

    expect(dispelChannel(state, target, SaveChannel.Mental, scriptedRng([]))).toBe(1);
    expect(hasEffect(state, target.id, EffectId.Stunned)).toBe(true);
  });

  it('forgetActor drops everything, including the baselines', () => {
    const state = createMvpEffectState();
    const target = monster();
    grantImmunity(state, target.id, 'stun', 30);
    setEffect(state, target, EffectId.Slowed, 3, {}, scriptedRng([]));
    forgetActor(state, target.id);

    expect(effectsOn(state, target.id)).toHaveLength(0);
    expect(state.immunities.has(target.id)).toBe(false);
    expect(state.baseGlobalSpeed.has(target.id)).toBe(false);
  });

  it('effectModifiers composes booleans by OR and numbers by sum', () => {
    const state = createMvpEffectState();
    const target = monster();
    setEffect(state, target, EffectId.Stunned, 3, {}, scriptedRng([]));
    setEffect(state, target, EffectId.Slowed, 3, {}, scriptedRng([]));

    const mods = effectModifiers(state, target.id);
    expect(mods.stunned).toBe(true);
    expect(mods.noTalentsCooldown).toBe(true);
    expect(mods.globalSpeedAdd).toBeCloseTo(-SLOW_POWER, 10);
    expect(mods.mpPenalty).toBe(1);
  });

  it('recomputeAttributes is idempotent', () => {
    const state = createMvpEffectState();
    const target = monster();
    setEffect(state, target, EffectId.Slowed, 3, {}, scriptedRng([]));
    const once = target.globalSpeed;
    recomputeAttributes(state, target);
    recomputeAttributes(state, target);
    expect(target.globalSpeed).toBe(once);
  });

  it('preserves an actor`s AUTHORED flags underneath the effect-derived ones', () => {
    const state = createMvpEffectState();
    const target = monster({ combat: { flags: { dazed: true } } });
    setEffect(state, target, EffectId.Stunned, 2, {}, scriptedRng([]));
    expect(target.combat?.flags?.dazed).toBe(true);
    expect(target.combat?.flags?.stunned).toBe(true);

    removeEffect(state, target, EffectId.Stunned, scriptedRng([]));
    expect(target.combat?.flags?.dazed).toBe(true);
    expect(target.combat?.flags?.stunned).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 10. The content roster
// ---------------------------------------------------------------------------

describe('the status roster (game-design.md § 12)', () => {
  /**
   * ═══ THE ROSTER IS PINNED IN ORDER, AND THE ORDER IS LOAD-BEARING ═══
   * `MVP_EFFECTS` is iterated wherever iteration must be reproducible, and the
   * ids double as the client's badge atlas keys. Appending is free; reordering
   * or renaming is not, which is what this pins.
   *
   * It was three for the whole of the MVP and read "ships exactly three". The
   * two additions are EFFACED and BREACHED — the content half of `scoured` and
   * `breached`, two flags engine/derived.ts had been reading since the
   * defensive maths was ported, with no effect anywhere setting either.
   */
  it('ships the roster in order, with the badges the client expects', () => {
    expect(EFFECT_IDS).toEqual([
      EffectId.Stunned,
      EffectId.Bleeding,
      EffectId.Slowed,
      EffectId.Effaced,
      EffectId.Breached,
      EffectId.Dazed,
      // The first beneficial one. Appended rather than slotted in, so a client
      // holding an older badge atlas keeps the indices it already has.
      EffectId.Evasive,
    ]);
    expect(MVP_EFFECTS.map((def) => def.icon)).toEqual([
      'icon_status_stunned',
      'icon_status_bleeding',
      'icon_status_slowed',
      'icon_status_effaced',
      'icon_status_breached',
      'icon_status_dazed',
      'icon_status_evasive',
    ]);
  });

  /**
   * ═══ ALL DETRIMENTAL, ALL TICKING DOWN AT ONE PER TURN ═══
   * `decrease: 0` is a PERMANENT effect — legal for a sustain, a bug for a
   * status — so this is the assertion that catches a status that never expires.
   *
   * THE SAVE CHANNEL IS NO LONGER UNIFORM, and that is a port fidelity matter
   * rather than a loosening. Every status was physical while the roster was the
   * three MVP ones; BREACHED is `type = "magical"` upstream (magical.lua:3214),
   * and being overwritten is not something you shrug off by being sturdy. Each
   * effect's channel is asserted against its own source below.
   */
  it('is entirely TEMPORARY, and no longer entirely detrimental', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THIS ASSERTED `status === Detrimental` FOR EVERY EFFECT, AND IT WAS TRUE
     * FOR AS LONG AS A TIMED EFFECT HAD NO WAY TO ADD ANYTHING.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `EffectModifiers` is a fixed set of flags and budget penalties — stunned,
     * dazed, `mpPenalty` — every one of them written for something being taken
     * away. So all six authored effects were detrimental, and an assertion that
     * they all were read like a property of the design rather than a
     * consequence of the machinery.
     *
     * The engine never agreed. `canBe` skips the immunity checks for a
     * beneficial effect, `creditForLanding` refuses to pay a caster for one,
     * `dispel` will not touch one, and the save block carries the comment *"A
     * beneficial effect keeps its scaled duration and is never refused"*. Four
     * branches built for a kind of effect no content had ever authored.
     *
     * `EffectDef.wielder` is what unlocked it: an effect can hand back the block
     * a worn item hands back, and `recomposeCombat` folds it exactly as it folds
     * gear and passives.
     *
     * ═══ TEMPORARY IS STILL THE RULE, AND IT IS THE HALF WORTH KEEPING ═══
     * `decrease: 1` means every effect here ticks down. A permanent one would be
     * a property of the body wearing a duration, which is what a passive or a
     * piece of gear is for.
     */
    for (const def of MVP_EFFECTS) {
      expect(def.decrease, def.id).toBe(1);
    }
    const kinds = new Set(MVP_EFFECTS.map((def) => def.status));
    expect(kinds.has(EffectStatus.Detrimental), 'the roster lost its detrimental half').toBe(true);
    expect(kinds.has(EffectStatus.Beneficial), 'nothing points at the beneficial path').toBe(true);
  });

  it('gives each status the save channel its source names', () => {
    const channels = Object.fromEntries(MVP_EFFECTS.map((def) => [def.id, def.type]));
    expect(channels).toEqual({
      // The three MVP statuses — physical.lua throughout.
      [EffectId.Stunned]: SaveChannel.Physical,
      [EffectId.Bleeding]: SaveChannel.Physical,
      [EffectId.Slowed]: SaveChannel.Physical,
      // physical.lua:31 — `ITEM_ANTIMAGIC_SCOURED` is a physical/acid effect.
      [EffectId.Effaced]: SaveChannel.Physical,
      // magical.lua:3214 — `EFF_BREACH` is magical/temporal.
      [EffectId.Breached]: SaveChannel.Magical,
      // physical.lua:562 — `EFF_DAZED` is physical, subtype stun.
      [EffectId.Dazed]: SaveChannel.Physical,
      /**
       * physical.lua's `EFF_EVASION`. THE CHANNEL IS A LABEL HERE, NOT A GATE:
       * nothing resists a buff, because `canBe` only consults immunities for a
       * detrimental effect and `applySave` only rolls for one. It is recorded
       * anyway so the badge and any future dispel-by-channel agree with upstream.
       */
      [EffectId.Evasive]: SaveChannel.Physical,
    });
  });

  it('validates clean', () => {
    for (const def of MVP_EFFECTS) expect(validateEffect(def)).toEqual([]);
  });

  /**
   * ═══ SIX STATUSES, SIX DISTINGUISHABLE BADGES ═══
   *
   * partypanel.ts boxes a short glyph when the badge PNG is missing, under a
   * docblock promising that a missing PNG must not collapse distinguishable
   * statuses into identical squares. It used to draw the first letter of the
   * name, which held on a roster of three and stops dead on this one: Stunned
   * against Slowed, Bleeding against Breached.
   *
   * This is the assertion that keeps the promise. It fails the moment a seventh
   * effect picks a glyph somebody already has.
   */
  it('gives every status a badge glyph nothing else shares', () => {
    const glyphs = MVP_EFFECTS.map((def) => def.badge);
    expect(new Set(glyphs).size, `badge glyphs collide: ${glyphs.join(', ')}`).toBe(glyphs.length);
  });

  it('validateEffect catches the mistakes that are silent at runtime', () => {
    expect(validateEffect({ ...SLOWED, decrease: 0 })).toContain(
      'effect:slowed: decrease 0 never expires (ActorTemporaryEffects.lua:91)',
    );
    expect(
      validateEffect({ ...BLEEDING, id: 'effect:x', onMerge: undefined }).some((p) =>
        p.includes('without onMerge'),
      ),
    ).toBe(true);
    expect(
      validateEffect({ ...SLOWED, modifiers: { globalSpeedAdd: -1 } }).some((p) =>
        p.includes('stop a monster'),
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 11. End to end, through the real `pump`
// ---------------------------------------------------------------------------

describe('the freeze through the real drive loop (scheduler → actBase → effects)', () => {
  /**
   * The same world, driven twice: once with the status pass wired in and once
   * without. The only difference is Actor.lua:606, and it is worth the whole
   * fixture because this is the one assertion that proves the seam is connected
   * rather than merely correct in isolation.
   */
  function drive(stun: boolean): number {
    const world = createWorld('effects-pump');
    const barrier = createBarrier();
    const effects = createMvpEffectState();

    const detective = world.addPlayer('p1', 'Dalt');
    detective.maxHp = 10_000;
    detective.hp = 10_000;

    const husk = world.addMonster('m1', {
      name: 'Index Husk',
      sprite: 'enemy_index_husk_s',
      x: 7,
      y: 2,
      profile: AiProfile.MeleeChaser,
    });
    husk.maxHp = 10_000;
    husk.hp = 10_000;
    setCooldown(husk, 'talent:crude_blow', 30);

    // Long enough that it cannot expire mid-test — the question here is whether
    // the freeze is WIRED, not how long a stun lasts.
    if (stun) setEffect(effects, husk, EffectId.Stunned, 99, {}, world.rng);

    // THE ONE LINE THE ADAPTER IN turn-engine.ts OWNS.
    const pass = statusPass(effects, world.rng, { getActor: (id) => world.getActor(id) });

    for (let tick = 1; tick <= 6 * TICKS_PER_GAME_TURN; tick += 1) {
      submitIntent(world, barrier, 'p1', HOLD_INTENT);
      pump(world, { nowMs: tick, barrier, statusPass: pass });
    }
    return husk.cooldowns.get('talent:crude_blow') ?? 0;
  }

  it('freezes a stunned monster`s cooldowns and leaves an unstunned one ticking', () => {
    const frozen = drive(true);
    const ticking = drive(false);

    expect(frozen).toBe(30); // not one point, across six game turns
    expect(ticking).toBeLessThan(30); // the identical world, minus the stun
  });

  it('pump without a statusPass behaves exactly as it did at M3', () => {
    const world = createWorld('effects-pump-off');
    const barrier = createBarrier();
    const husk = world.addMonster('m1', {
      name: 'Index Husk',
      sprite: 'enemy_index_husk_s',
      x: 7,
      y: 2,
      profile: AiProfile.MeleeChaser,
    });
    setCooldown(husk, 'talent:crude_blow', 30);

    for (let tick = 1; tick <= TICKS_PER_GAME_TURN; tick += 1) {
      pump(world, { nowMs: tick, barrier });
    }
    expect(husk.cooldowns.get('talent:crude_blow')).toBe(29);
  });
});

// ---------------------------------------------------------------------------
// 12. Replay determinism
// ---------------------------------------------------------------------------

describe('determinism', () => {
  it('two runs from the same seed produce the same durations', () => {
    const run = (): number[] => {
      const state = createMvpEffectState();
      const rng: Rng = createRng('replay-effects');
      const out: number[] = [];
      for (let i = 0; i < 30; i += 1) {
        const target = monster({ combat: { stats: { con: 22, str: 22 } } });
        out.push(setEffect(state, target, EffectId.Stunned, 4, { applyPower: 22 }, rng).dur);
      }
      return out;
    };
    expect(run()).toEqual(run());
  });

  it('produces a spread of durations rather than a binary outcome — the whole point', () => {
    const state = createMvpEffectState();
    const rng = createRng('spread-effects');
    const seen = new Set<number>();
    for (let i = 0; i < 400; i += 1) {
      const target = monster({ combat: { stats: { con: 20, str: 20 } } });
      seen.add(setEffect(state, target, EffectId.Stunned, 5, { applyPower: 22 }, rng).dur);
    }
    // Binary application would give {0, 5}. Partial saves give the middle.
    expect(seen.size).toBeGreaterThan(3);
  });
});
