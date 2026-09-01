// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/modules/tome/class/interface/Combat.lua:295-322 (crossTierEffect)
//                       game/modules/tome/class/Actor.lua:7025-7027 (the trigger)
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

import { describe, expect, it } from 'vitest';

import {
  EffectId,
  MVP_EFFECTS,
  OFF_BALANCE_NUMBED,
  SPELLSHOCK_RESIST,
  createMvpEffectState,
} from '../../src/server/content/effects.ts';
import {
  createEffectState,
  effectsOn,
  hasEffect,
  noTalentsCooldown,
  recomposeCombat,
  saveOf,
  setEffect,
} from '../../src/server/engine/effects.ts';
import { SaveChannel } from '../../src/server/engine/effects.ts';
import { getTierDiff } from '../../src/shared/scale.ts';
import { AiProfile, createMonsterActor } from '../../src/server/engine/actor.ts';
import { resolveItem } from '../../src/server/content/resolve.ts';
import { combatGetResist } from '../../src/server/engine/damage.ts';
import { attackTarget } from '../../src/server/engine/combat.ts';
import { createRng } from '../../src/shared/rng.ts';
import type { EffectActor } from '../../src/server/engine/effects.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * `getTierDiff` SHIPPED WITH A TEST FILE AND NO PRODUCTION CALLER.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Its own docblock in `shared/scale.ts` reads *"Shipped now, used at M4: it is
 * four lines, it is what makes 'you have outgrown this zone' legible without
 * printing a level number, and retrofitting the floors later is how off-by-one
 * tier bugs happen."* It was never used at M4 or since. `grep` found the
 * definition, `test/shared/scale.test.ts`, and nothing else — the eleventh
 * finished system in this codebase with no content pointed at it.
 *
 * What it buys: when an attacker's apply power outranks the defender's save by a
 * whole twenty-point tier, the defender takes a SECOND debuff chosen by the save
 * channel — Off-balance, Spellshocked or Brainlocked — for as many turns as the
 * gap is wide. That is ToME's "you should not be on this floor" pressure, and it
 * scales with the mismatch instead of being a wall.
 */

/** A body with a deliberately terrible save on every channel, so a tier gap is easy. */
function frail(): EffectActor {
  const actor = createMonsterActor('m1', {
    name: 'Index Husk',
    sprite: 'enemy_index_husk_s',
    x: 5,
    y: 5,
    profile: AiProfile.MeleeChaser,
  });
  actor.combat = { stats: { str: 1, dex: 1, con: 1, wil: 1, cun: 1 } };
  return actor;
}

/**
 * `applyPower` a whole tier above `frail()`'s save on any channel.
 *
 * Derived rather than written down: a magic number here would silently stop
 * meaning "one tier above" the day `saveOf`'s constants move, and the test would
 * keep passing while measuring nothing.
 */
function powerAboveTier(target: EffectActor, channel: SaveChannel, tiers: number): number {
  const save = saveOf(target.combat, channel);
  // `max(ceil(x/20), 1)` on BOTH sides — a save at or below zero still sits in
  // tier one. Leaving the floor out here made every fixture one tier short.
  const defenderTier = Math.max(Math.ceil(save / 20), 1);
  const power = (defenderTier + tiers - 1) * 20 + 1;
  expect(getTierDiff(power, save), 'the fixture does not span the tiers it claims').toBe(tiers);
  return power;
}

const rng = () => createRng('cross-tier');

describe('the trigger fires, and picks the effect by save channel', () => {
  it('applies Off-balance when a PHYSICAL effect outranks a physical save', () => {
    // Combat.lua:306 — `combatPhysicalResist = self.EFF_OFFBALANCE`.
    const state = createMvpEffectState();
    const target = frail();
    const power = powerAboveTier(target, SaveChannel.Physical, 2);

    setEffect(state, target, EffectId.Stunned, 3, { applyPower: power }, rng());
    expect(hasEffect(state, target.id, EffectId.OffBalance)).toBe(true);
  });

  it('applies Brainlocked when a MENTAL effect outranks a mental save', () => {
    /**
     * Combat.lua:308 — `combatMentalResist = self.EFF_BRAINLOCKED`. The channel
     * comes from `EffectDef.type`, so this uses `applySave` to reroute a
     * physical effect onto the mental channel (Actor.lua:7002's
     * `p.apply_save or save_for_effects[e.type]`) — the same override the
     * trigger passes through.
     */
    const state = createMvpEffectState();
    const target = frail();
    const power = powerAboveTier(target, SaveChannel.Mental, 2);

    setEffect(
      state,
      target,
      EffectId.Stunned,
      3,
      { applyPower: power, applySave: SaveChannel.Mental },
      rng(),
    );
    expect(hasEffect(state, target.id, EffectId.Brainlocked)).toBe(true);
    expect(hasEffect(state, target.id, EffectId.OffBalance)).toBe(false);
  });

  it('applies Spellshocked on the MAGICAL channel', () => {
    // Combat.lua:307 — `combatSpellResist = self.EFF_SPELLSHOCKED`. Breached is
    // authored `magical` (magical.lua:3214), so no override is needed.
    const state = createMvpEffectState();
    const target = frail();
    const power = powerAboveTier(target, SaveChannel.Magical, 1);

    setEffect(state, target, EffectId.Breached, 3, { applyPower: power }, rng());
    expect(hasEffect(state, target.id, EffectId.Spellshocked)).toBe(true);
  });

  it('lasts exactly the tier gap, in turns', () => {
    // Combat.lua:321 — `local dur = self:getTierDiff(apply_power, save)`. The
    // gap IS the duration; there is no separate magnitude.
    for (const tiers of [1, 2, 3]) {
      const state = createMvpEffectState();
      const target = frail();
      const power = powerAboveTier(target, SaveChannel.Physical, tiers);

      setEffect(state, target, EffectId.Stunned, 3, { applyPower: power }, rng());
      const live = effectsOn(state, target.id).find((e) => e.effectId === EffectId.OffBalance);
      expect(live?.dur, `${String(tiers)} tiers`).toBe(tiers);
    }
  });
});

describe('the ORDERING, which is the half a careful reading would still miss', () => {
  it('fires even when the target SHRUGGED THE EFFECT OFF', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * Actor.lua:7025-7027 SITS ABOVE `if saved then ... return true`.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * So making your save against something two tiers above you still leaves you
     * off-balance. That is the whole mechanic: being outclassed costs you
     * something whether or not the blow lands, which is what makes it a pressure
     * rather than a coin flip.
     *
     * Moving the trigger below the `roll.hit` return compiles, passes every save
     * test in the tree, and deletes half of what this is for. Only this
     * assertion notices.
     */
    const state = createMvpEffectState();
    const target = frail();
    const power = powerAboveTier(target, SaveChannel.Physical, 2);

    // Hunt a seed whose save roll NEGATES the stun. `scriptedRng` cannot be used
    // here: the trigger runs a nested `setEffect`, and a fixed script would run
    // out mid-call and mask the result as an error.
    let negated = false;
    for (let i = 0; i < 200 && !negated; i += 1) {
      const attempt = createMvpEffectState();
      const body = frail();
      const result = setEffect(
        attempt,
        body,
        EffectId.Stunned,
        3,
        { applyPower: power },
        createRng(`shrug-${String(i)}`),
      );
      if (hasEffect(attempt, body.id, EffectId.Stunned)) continue;
      negated = true;
      // THE STUN WAS REFUSED — a save, not an immunity or a bad id.
      expect(result.saveChance).not.toBeNull();
      // ...AND THE CROSS-TIER DEBUFF LANDED ANYWAY.
      expect(
        hasEffect(attempt, body.id, EffectId.OffBalance),
        'a shrugged-off effect left no cross-tier debuff — the trigger moved below the save',
      ).toBe(true);
    }
    expect(negated, 'no seed in 200 refused the stun; the fixture proves nothing').toBe(true);
    expect(hasEffect(state, target.id, EffectId.OffBalance)).toBe(false);
  });
});

describe('and it stops where upstream stops it', () => {
  it('does NOTHING at the same tier', () => {
    // `getTierDiff` returns 0 when the tiers match, and a 0-turn effect is not
    // an effect. This is the common case: most fights are within a tier.
    const state = createMvpEffectState();
    const target = frail();
    const save = saveOf(target.combat, SaveChannel.Physical);

    setEffect(state, target, EffectId.Stunned, 3, { applyPower: save }, rng());
    expect(getTierDiff(save, save)).toBe(0);
    expect(hasEffect(state, target.id, EffectId.OffBalance)).toBe(false);
  });

  it('a same-tier hit REMOVES an existing cross-tier debuff, which is upstream`s', () => {
    /**
     * `setEffect(ct, 0, {})` hits ActorTemporaryEffects.lua:109 — *"Beware,
     * setting to 0 means removing"*. Upstream calls it unconditionally, so a
     * same-tier attacker clears the Off-balance a bigger one left on you.
     *
     * It reads like an accident of upstream's control flow. It is ported as
     * written because CLAUDE.md's standing rule is that the Lua wins over any
     * reading of it, and because fifteen years of balance sat on top of this
     * behaviour. Pinned HERE rather than left implicit so that the day somebody
     * decides to diverge, they change a test that says why.
     */
    const state = createMvpEffectState();
    const target = frail();
    const power = powerAboveTier(target, SaveChannel.Physical, 2);
    const save = saveOf(target.combat, SaveChannel.Physical);

    setEffect(state, target, EffectId.Stunned, 3, { applyPower: power }, rng());
    expect(hasEffect(state, target.id, EffectId.OffBalance)).toBe(true);

    setEffect(state, target, EffectId.Bleeding, 3, { applyPower: save }, rng());
    expect(hasEffect(state, target.id, EffectId.OffBalance)).toBe(false);
  });

  it('never recurses — a cross-tier effect triggers no cross-tier effect', () => {
    // Two guards, deliberately: the applied effect carries no `applyPower`, so
    // the trigger's branch is unreachable, AND all three definitions set
    // `noCtEffect`. The first is a property of where a call sits; the second
    // survives a refactor.
    const state = createMvpEffectState();
    const target = frail();
    const power = powerAboveTier(target, SaveChannel.Physical, 3);

    setEffect(state, target, EffectId.Stunned, 3, { applyPower: power }, rng());
    const live = effectsOn(state, target.id).filter((e) => e.effectId === EffectId.OffBalance);
    expect(live.length).toBe(1);
    for (const def of MVP_EFFECTS) {
      if (def.crossTierFor === undefined) continue;
      expect(def.noCtEffect, `${def.id} could trigger another cross-tier effect`).toBe(true);
    }
  });

  it('honours `noCtEffect` on a single application', () => {
    // Actor.lua:7027's `p.no_ct_effect` — an effect re-applied by another effect
    // that has already paid the cross-tier cost once.
    const state = createMvpEffectState();
    const target = frail();
    const power = powerAboveTier(target, SaveChannel.Physical, 2);

    setEffect(state, target, EffectId.Stunned, 3, { applyPower: power, noCtEffect: true }, rng());
    expect(hasEffect(state, target.id, EffectId.OffBalance)).toBe(false);
  });

  it('does nothing at all in a build with no cross-tier content registered', () => {
    // Every pre-M5 fixture. `createEffectState([...])` with no `crossTierFor`
    // leaves the index empty and the trigger returns before touching anything.
    const bare = createEffectState(MVP_EFFECTS.filter((d) => d.crossTierFor === undefined));
    const target = frail();
    const power = powerAboveTier(target, SaveChannel.Physical, 2);

    setEffect(bare, target, EffectId.Stunned, 3, { applyPower: power }, rng());
    expect(effectsOn(bare, target.id).map((e) => e.effectId)).toEqual([EffectId.Stunned]);
  });
});

describe('each debuff actually does the thing its description claims', () => {
  it('Off-balance takes 15% off everything you deal, through the SHEET', () => {
    /**
     * damage_types.lua:158-160 — `dam = dam - dam * numbed / 100`. Asserted on
     * the composed sheet rather than on the effect definition, because a
     * `wielder` block that never reaches `recomposeCombat` is the failure this
     * project keeps shipping.
     */
    const state = createMvpEffectState();
    const target = frail();
    const base = { ...target.combat };
    const body = Object.assign(target, { baseCombat: base });

    recomposeCombat(body, state, resolveItem);
    expect(body.combat?.mods?.numbed ?? 0).toBe(0);

    setEffect(state, body, EffectId.OffBalance, 2, {}, rng());
    recomposeCombat(body, state, resolveItem);
    expect(body.combat?.mods?.numbed).toBe(OFF_BALANCE_NUMBED);
  });

  it('Spellshocked lowers EVERY resistance, via the `all` row', () => {
    /**
     * magical.lua:1979-1983 — `addTemporaryValue("resists", { all = -power })`.
     *
     * Measured through `combatGetResist`, which is where the `all` row's
     * MULTIPLICATIVE composition with the typed row lives (Combat.lua:2227-2228).
     * Six typed −20s would pass a test that only read the table; only this one
     * distinguishes them.
     */
    const state = createMvpEffectState();
    const target = frail();
    const body = Object.assign(target, {
      combat: { stats: { str: 1, dex: 1, con: 1, wil: 1, cun: 1 } },
      baseCombat: { stats: { str: 1, dex: 1, con: 1, wil: 1, cun: 1 } },
    });

    recomposeCombat(body, state, resolveItem);
    const before = combatGetResist(body.combat?.profile ?? {}, 'fire');

    setEffect(state, body, EffectId.Spellshocked, 2, {}, rng());
    recomposeCombat(body, state, resolveItem);
    const after = combatGetResist(body.combat?.profile ?? {}, 'fire');

    expect(after).toBeLessThan(before);
    // `100 * (1 - (1 - a) * (1 - b))` with a = −0.2 lands at −19.999999999999996.
    // ToME never rounds a resistance and neither does `combatGetResist`, so the
    // assertion carries the tolerance rather than the formula carrying a round.
    expect(after).toBeCloseTo(-SPELLSHOCK_RESIST, 10);
  });

  it('Brainlocked freezes cooldowns and darkens exactly one talent', () => {
    // mental.lua:2246-2253 — `no_talents_cooldown` plus `for i = 1, 1 do`.
    const state = createMvpEffectState();
    const target = frail();
    const talents = ['talent:a', 'talent:b', 'talent:c'];

    setEffect(state, target, EffectId.Brainlocked, 2, {}, rng(), {
      activatableTalents: () => talents,
    });

    expect(noTalentsCooldown(state, target.id)).toBe(true);
    expect(talents.filter((id) => target.cooldowns.has(id)).length).toBe(1);
  });
});

describe('Off-balance reaches the BLOW, not merely the sheet', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE WIRE BETWEEN THE TWO TESTS ABOVE, WHICH NEITHER OF THEM COVERS.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * One test proves `numbed` reaches the composed sheet. Another proves
   * `resolveDamage` subtracts it. Between them sits one line in `combat.ts`
   * — `sourceNumbed: self.mods?.numbed` — and deleting it passed all 4,083
   * tests in the tree. That is this project's signature defect: two correct
   * halves and nothing asserting they are joined.
   *
   * So this one swings a real attack and reads the number off the result.
   */
  const world = () => ({
    hasLineOfSight: () => true,
    isBlocked: () => false,
  });

  const body = (numbed?: number) => ({
    id: numbed === undefined ? 'clear' : 'reeling',
    name: 'Watchman',
    x: 1,
    y: 1,
    hp: 40,
    alive: true,
    combat: {
      stats: { str: 20, dex: 20, con: 20, wil: 20, cun: 20 },
      mods: { dam: 20, atk: 500, ...(numbed === undefined ? {} : { numbed }) },
    },
  });

  const dummy = () => ({
    id: 'dummy',
    name: 'Husk',
    x: 2,
    y: 1,
    hp: 9999,
    alive: true,
    combat: { stats: { str: 1, dex: 1, con: 1, wil: 1, cun: 1 } },
  });

  function hit(attacker: ReturnType<typeof body>): number {
    // A fixed seed, so the only difference between the two swings is the sheet.
    const result = attackTarget(attacker, dummy(), world() as never, createRng('numbed-blow'));
    expect(result.ok, 'the fixture never landed a blow').toBe(true);
    return (result as { damage: number }).damage;
  }

  it('an off-balance attacker deals measurably less', () => {
    const clear = hit(body());
    const reeling = hit(body(OFF_BALANCE_NUMBED));
    expect(clear).toBeGreaterThan(0);
    expect(
      reeling,
      'numbed never reached the blow — check combat.ts passes sourceNumbed',
    ).toBeLessThan(clear);
    // damage_types.lua:158-160 — `dam - dam * 15 / 100`, i.e. 85%.
    expect(reeling).toBeCloseTo(clear * (1 - OFF_BALANCE_NUMBED / 100), 6);
  });
});
