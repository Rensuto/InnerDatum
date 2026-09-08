// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE DAMAGE SHIELD — magical.lua:733-745, Actor.lua:2304-2348, and the rune
 * at inscriptions.lua:321-345.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ═══ WHAT IT COSTS WITHOUT IT ═══
 * Every defence this game had made the blow SMALLER — armour, resists, a
 * percentage rewrite. Nothing stood in front of a body, so nothing could be
 * spent to survive one specific hit you could see coming. A party that can only
 * heal after the fact can only ever react; the shield is the button you press
 * on the turn BEFORE, and it is half of what makes a turn-based fight a
 * decision rather than an exchange.
 *
 * ═══ DRIVEN THROUGH THE REAL RUNTIME, NOT THROUGH THE PARTS ═══
 * `infusion-saturation.test.ts` states the rule this file follows: the mechanic
 * is a JOIN across five layers — the rune calls `ctx.status`, the effect lands
 * with a pool, `main.ts` binds `actor.absorb` from the effect state,
 * `applyDamage` calls it, and `shieldAbsorber` spends it. Each can be correct
 * while the wire between two of them is cold. So this presses the button and
 * then hits the body.
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { EffectId, createMvpEffectState } from '../../src/server/content/effects.ts';
import {
  classById,
  createContentTalentEngine,
  sheetForClass,
} from '../../src/server/content/classes.ts';
import { effectsOn, shieldAbsorber, statusApplier } from '../../src/server/engine/effects.ts';
import { talentRuntimeFor } from '../../src/server/main.ts';
import { createWorld } from '../../src/server/world/world.ts';
import { applyDamage, DamageType } from '../../src/server/engine/damage.ts';
import { scriptedRng } from '../helpers/scripted-rng.ts';
import { shieldingRune } from '../../src/server/talents/shielding_rune.ts';
import { healingInfusion } from '../../src/server/talents/healing_infusion.ts';
import { UNFILED } from '../../src/server/content/origins.ts';
import { trained } from '../helpers/trained.ts';

/** A body that knows the rune, with a real runtime behind it. */
function arena() {
  const world = createWorld('damage-shield');
  const player = world.addPlayer('p1', 'Dalt');
  player.maxHp = 400;
  // HURT, so the healing infusion below has something to do — a refused talent
  // sets no cooldown and would measure nothing.
  player.hp = 200;

  const effects = createMvpEffectState();
  const engine = createContentTalentEngine();
  const definition = classById('watchman');
  if (definition === undefined) throw new Error('no watchman');
  // THE RUNE COMES FROM THE ORIGIN, not from a birth inscription — `elf.lua:107`
  // gives it to the Shalore, and this game has one elf. See `UNFILED`.
  engine.attach('p1', trained(sheetForClass(definition, [], [], undefined, UNFILED)));

  const runtime = talentRuntimeFor(engine, world, statusApplier(effects, world.rng));
  // What main.ts's compose pass binds. The production wiring is asserted
  // separately below; this is the same closure, so the arithmetic tests here
  // are testing the shipped function rather than a copy of it.
  player.absorb = (dam: number): number =>
    shieldAbsorber(effects, EffectId.DamageShield)('p1', dam);
  return { world, player, effects, runtime };
}

/** What is left in the pool on a body, or 0 when there is no shield. */
function pool(effects: ReturnType<typeof createMvpEffectState>, id: string): number {
  const live = effectsOn(effects, id).find((eff) => eff.effectId === EffectId.DamageShield);
  const own = live?.params['power'];
  return typeof own === 'number' ? own : 0;
}

/** One unmitigated blow. No draws: `rollDamageRange` and `rollCrit` are pinned. */
function hit(player: ReturnType<typeof arena>['player'], amount: number) {
  return applyDamage(
    player,
    amount,
    DamageType.Physical,
    { id: 'attacker', name: 'Something' },
    scriptedRng([]),
  );
}

describe('the rune', () => {
  it('raises a shield with the pool upstream gives a Shalore at birth', () => {
    const { player, effects, runtime } = arena();
    expect(pool(effects, 'p1'), 'shielded before anything was pressed').toBe(0);

    const used = runtime.use(player, shieldingRune.id, undefined);
    expect(used.ok, `the rune was refused: ${used.ok ? '' : used.reason}`).toBe(true);
    // `elf.lua:107` — `resolvers.inscription("RUNE:_SHIELDING", {..., power=100})`.
    expect(pool(effects, 'p1')).toBe(100);
  });

  it('refuses while a shield is already up — inscriptions.lua:330-332', () => {
    /**
     * `on_pre_use = function(self, t) return not self:hasEffect(self.EFF_DAMAGE_SHIELD) end`.
     * Upstream greys the button out; ours refuses at the press, which is this
     * codebase's settled shape for the same thing. Either way the point is that
     * a player cannot spend an eight-turn cooldown replacing a shield they are
     * already standing behind.
     */
    const { player, runtime } = arena();
    expect(runtime.use(player, shieldingRune.id, undefined).ok).toBe(true);
    const again = runtime.use(player, shieldingRune.id, undefined);
    expect(again.ok, 'a second rune landed on top of the first').toBe(false);
  });
});

describe('the shield in front of the blow', () => {
  it('eats the whole hit while the pool covers it — Actor.lua:2317-2320', () => {
    const { player, effects, runtime } = arena();
    runtime.use(player, shieldingRune.id, undefined);
    const before = player.hp;

    const out = hit(player, 30);
    expect(player.hp, 'the body took damage through a shield that covered it').toBe(before);
    expect(out.dealt).toBe(0);
    // AND IT SAYS SO. A shield that silently reduced the number would look like
    // the attacker rolling badly — upstream prints `(%d absorbed)` at :2326.
    expect(out.absorbed, 'the absorb was swallowed instead of reported').toBe(30);
    expect(pool(effects, 'p1'), 'the pool did not pay for it').toBe(70);
  });

  it('spills the remainder when the blow is bigger — Actor.lua:2322-2325', () => {
    const { player, effects, runtime } = arena();
    runtime.use(player, shieldingRune.id, undefined);
    const before = player.hp;

    const out = hit(player, 130);
    expect(out.absorbed, 'the shield did not spend everything it had').toBe(100);
    expect(out.dealt, 'the spill did not land').toBe(30);
    expect(player.hp).toBe(before - 30);
    expect(pool(effects, 'p1')).toBe(0);
  });

  it('crumbles when it empties, and absorbs nothing after', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * A SPENT SHIELD IS RETIRED BY THE SWEEP, NOT FROM INSIDE THE BLOW.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * Upstream calls `removeEffect` on the spot (Actor.lua:2346). Ours zeroes
     * the duration and lets the per-turn tick take it, because `removeEffect`
     * fires a `deactivate` hook and therefore needs an `Rng` — and
     * engine/damage.ts states at length that adding a draw inside `applyDamage`
     * shifts every subsequent draw for the rest of the session.
     *
     * NOTHING IS LOST MECHANICALLY, which is what this asserts: an empty pool
     * absorbs nothing, so the spent shield is already inert against every blow
     * between here and the sweep. What lingers is the badge, for one turn.
     */
    const { player, effects, runtime } = arena();
    runtime.use(player, shieldingRune.id, undefined);
    hit(player, 100);
    expect(pool(effects, 'p1')).toBe(0);

    const live = effectsOn(effects, 'p1').find((eff) => eff.effectId === EffectId.DamageShield);
    expect(live?.dur, 'a spent shield was left with turns on the clock').toBe(0);

    const before = player.hp;
    const out = hit(player, 40);
    expect(out.absorbed, 'a spent shield absorbed something').toBe(0);
    expect(player.hp, 'the blow after the shield crumbled did not land').toBe(before - 40);
  });

  it('leaves an unshielded body exactly as it was', () => {
    // The absorber must be a no-op for the overwhelming majority of blows in
    // this game, and `absorbed: 0` is what every existing damage assertion in
    // the suite depends on.
    const { player } = arena();
    const before = player.hp;
    const out = hit(player, 25);
    expect(out.absorbed).toBe(0);
    expect(out.dealt).toBe(25);
    expect(player.hp).toBe(before - 25);
  });
});

describe('the two saturation pools', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * DRINKING AN INFUSION MUST NOT SLOW A RUNE DOWN — Actor.lua:6356-6362.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Upstream branches on the inscription's type at BOTH ends: `:5850-5856` sets
   * `EFF_INFUSION_COOLDOWN` or `EFF_RUNE_COOLDOWN`, and `:6356-6362` reads back
   * whichever matches. One shared counter would be one fewer effect and one
   * fewer flag, and it would tax a body carrying both twice for one press.
   *
   * This is the exact shape a single counter would pass every other test in the
   * suite while getting wrong, so it is asserted from both directions.
   */
  it('taxes the rune only after a RUNE, not after an infusion', () => {
    const { player, runtime } = arena();

    // An infusion first. It raises the INFUSION pool and must not touch the rune.
    expect(runtime.use(player, healingInfusion.id, undefined).ok).toBe(true);
    player.cooldowns.clear();

    expect(runtime.use(player, shieldingRune.id, undefined).ok).toBe(true);
    expect(
      player.cooldowns.get(shieldingRune.id),
      'the healing infusion taxed the shielding rune — the pools are shared',
    ).toBe(shieldingRune.cooldownTurns);
  });

  it('taxes the infusion only after an INFUSION, not after a rune', () => {
    const { player, runtime } = arena();

    expect(runtime.use(player, shieldingRune.id, undefined).ok).toBe(true);
    player.cooldowns.clear();

    expect(runtime.use(player, healingInfusion.id, undefined).ok).toBe(true);
    expect(
      player.cooldowns.get(healingInfusion.id),
      'the shielding rune taxed the healing infusion — the pools are shared',
    ).toBe(healingInfusion.cooldownTurns);
  });

  it('does tax its own kind, so the mechanic is present at all', () => {
    /**
     * THE CONTROL. The two assertions above both pass if NEITHER pool works,
     * which is the way a test for independence quietly becomes a test for
     * nothing. This proves the rune pool is wired: saturate it, then press the
     * rune, and the cooldown must be longer than the talent declares.
     *
     * APPLIED DIRECTLY rather than by pressing a second rune, because the rune
     * refuses while its own shield is up (`on_pre_use`) and this game has one.
     * The join being read is still the real one — the effect's power folds onto
     * `StatusFlags.runeSaturation` and `setCooldown` reads it back.
     */
    const { world, player, effects, runtime } = arena();
    // other.lua:122-126 — the power is what escalates. Two stacks.
    const apply = statusApplier(effects, world.rng);
    apply(player, EffectId.RuneSaturation, 10, { power: 2 });

    expect(runtime.use(player, shieldingRune.id, undefined).ok).toBe(true);
    const taxed = player.cooldowns.get(shieldingRune.id) ?? 0;
    expect(taxed, 'the rune saturation pool is not reaching setCooldown').toBeGreaterThan(
      shieldingRune.cooldownTurns,
    );
  });
});

describe('the wiring production actually uses', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE ARENA ABOVE BINDS `absorb` BY HAND, SO IT CANNOT SEE A COLD JOIN.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * That is deliberate — it keeps the arithmetic tests reading the shipped
   * `shieldAbsorber` rather than a copy — but it means every one of them would
   * stay green with nothing in production setting the field at all. This is the
   * half they cannot reach: `refreshPassives` lives inside `boot`'s closure and
   * no test can call it, so the assertion is against the source, on
   * `lifebar.test.ts`'s precedent (a pure function cannot see whether anybody
   * uses what it returns).
   */
  const MAIN = readFileSync('src/server/main.ts', 'utf8');

  it('builds one absorber and hangs it on every composed body', () => {
    expect(MAIN, 'nothing builds the absorber').toContain(
      'const absorbShield = shieldAbsorber(effects, EffectId.DamageShield);',
    );
    expect(MAIN, 'the absorber is never put on an actor — every shield is inert').toContain(
      'actor.absorb = (dam: number): number => absorbShield(actor.id, dam);',
    );
  });

  it('sets it beside the talent hooks, in the pass that runs on every compose', () => {
    // Order, not just presence: the field has to be written in the same pass
    // that writes `talentHooks`, which is the one that runs whenever a body is
    // composed. Anywhere else and a body composed by another path has no shield.
    const hooks = MAIN.indexOf('actor.talentHooks = bound.length > 0 ? bound : undefined;');
    const absorb = MAIN.indexOf('actor.absorb = (dam: number): number =>');
    expect(hooks).toBeGreaterThan(-1);
    expect(absorb, 'the absorber is set outside the compose pass').toBeGreaterThan(hooks);
    expect(absorb - hooks, 'the two have drifted apart into different passes').toBeLessThan(1600);
  });
});
