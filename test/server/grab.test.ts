// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/modules/tome/data/talents/misc/npcs.lua:817-849 (Grab)
//             t-engine4 game/modules/tome/class/interface/Combat.lua:1515-1536 (combatTalentScale)
//                                                               :1782-1788 (combatTalentWeaponDamage)
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" — https://te4.org/license

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * GRAB: A WEAPON BLOW, AND A PIN ONLY IF THE BLOW LANDED.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The numbers are asserted against the Lua's own expressions at the ranks that
 * separate them, and the behaviour through `onUse` with a status door that
 * records what it was asked for. The last case is the real scheduler, so the
 * pin is seen landing on a body rather than requested of a spy.
 */

import { describe, expect, it } from 'vitest';

import { createContentTalentEngine } from '../../src/server/content/classes.ts';
import { EffectId, createMvpEffectState } from '../../src/server/content/effects.ts';
import { INDEX_INKWELL, monsterInit } from '../../src/server/content/monsters.ts';
import { IntentKind } from '../../src/server/engine/actor.ts';
import { createBarrier } from '../../src/server/engine/barrier.ts';
import { attackTarget } from '../../src/server/engine/combat.ts';
import { DamageType } from '../../src/server/engine/damage.ts';
import { combatPhysicalpower } from '../../src/server/engine/derived.ts';
import { SetEffectOutcome, effectsOn, statusApplier } from '../../src/server/engine/effects.ts';
import type { SetEffectResult, StatusApply } from '../../src/server/engine/effects.ts';
import { Refusal, pump, submitIntent } from '../../src/server/engine/scheduler.ts';
import { Affinity, dirToward, tomeCooldownToTurns } from '../../src/server/engine/talents.ts';
import { talentRuntimeFor } from '../../src/server/main.ts';
import { grab, grabDuration, grabMult } from '../../src/server/talents/grab.ts';
import { MONSTER_TALENTS } from '../../src/server/talents/monster.ts';
import { createWorld } from '../../src/server/world/world.ts';
import { DIR_ORDER, step } from '../../src/shared/coords.ts';
import { TileCode } from '../../src/shared/protocol.ts';
import type { TalentCtx } from '../../src/server/engine/talents.ts';

describe('Grab, npcs.lua:817-849 — the numbers', () => {
  it('pins for `floor(combatTalentScale(t, 2, 6))` turns (:828)', () => {
    // sqrt curve through (1, 2) and (5, 6): 3.2361 * sqrt(t) - 1.2361, floored.
    // Rank 3 is the squid's upstream rank; rank 10 is where the default curve
    // and MONSTER_CURVE's 0.75 stop agreeing (8 against 9).
    expect(grabDuration(1)).toBe(2);
    expect(grabDuration(3)).toBe(4);
    expect(grabDuration(5)).toBe(6);
    expect(grabDuration(10)).toBe(8);
  });

  it('hits for `combatTalentWeaponDamage(t, 0.8, 1.4)` (:833), not the band`s low end', () => {
    // 0.8 + 0.6 * sqrt(t / 5). At rank 1 that is 1.0683, which is what tells
    // this helper apart from `combatTalentScale`, whose rank 1 is exactly 0.8.
    expect(grabMult(1)).toBeCloseTo(1.0683, 4);
    expect(grabMult(3)).toBeCloseTo(1.2648, 4);
    expect(grabMult(5)).toBeCloseTo(1.4, 10);
  });

  it('cools down for `cooldown = 6` (:821), through `tomeCooldownToTurns`', () => {
    expect(grab.cooldownTurns).toBe(tomeCooldownToTurns(6));
    expect(grab.cooldownTurns).toBe(3);
    // Bear Down's price, because upstream's Stun carries the same cooldown and
    // stamina (npcs.lua:195-196) — see `GRAB_AP`.
    expect(grab.cost).toEqual({ ap: 5 });
  });

  it('reaches the adjacent body only, `range = 1` (:826)', () => {
    expect(grab.targeting.range).toBe(1.5);
    expect(grab.targeting.minRange).toBe(0);
    expect(grab.targeting.requiresLos).toBe(true);
    // A grab is for a foe, and the blow is the weapon's: `attackTarget(target,
    // nil, ...)` (:833) names no damage type, so the weapon's physical stands.
    expect(grab.targeting.affinity).toBe(Affinity.Hostile);
    expect(grab.damageType).toBe(DamageType.Physical);
  });

  it('is in the bestiary`s registry, and belongs to no player', () => {
    expect(MONSTER_TALENTS).toContain(grab);
    expect(grab.classId).toBeNull();
    expect(createContentTalentEngine().registry.get('talent:grab')).toBe(grab);
  });

  it('says "pin", never "stun", so the stun-ratio guard does not read it as one', () => {
    const said = grab.describe?.({} as never, 1) ?? '';
    expect(said).toContain('pinned for 2 turns');
    expect(said).toContain('107%');
    expect(said).not.toMatch(/stun/i);
  });
});

type Asked = {
  readonly target: string;
  readonly effectId: string;
  readonly turns: number;
  readonly applyPower: unknown;
  readonly srcId: unknown;
};

/**
 * A squid beside a detective on open floor, and a status door that writes down
 * what it is asked. `answer`, when given, is what the door says back instead of
 * asking the real one, so the record's line can be pinned to each outcome.
 */
function beside(
  seed: string,
  level: number,
  defence: number,
  opts: { readonly answer?: SetEffectResult; readonly hp?: number } = {},
) {
  const world = createWorld(seed);
  world.level.tiles.fill(TileCode.FLOOR);
  const dalt = world.addPlayer('p1', 'Dalt', { maxHp: 1000 });
  dalt.x = 5;
  dalt.y = 5;
  if (opts.hp !== undefined) dalt.hp = opts.hp;
  dalt.combat = { ...dalt.combat, mods: { ...dalt.combat?.mods, def: defence } };
  const squid = world.addMonster('m1', monsterInit(INDEX_INKWELL, { x: 6, y: 5 }, 1));
  const effects = createMvpEffectState();
  const real = statusApplier(effects, world.rng);
  const asked: Asked[] = [];
  const status: StatusApply = (target, effectId, turns, params = {}) => {
    asked.push({
      target: target.id,
      effectId,
      turns,
      applyPower: params.applyPower,
      srcId: params.srcId,
    });
    return opts.answer ?? real(target, effectId, turns, params);
  };
  const ctx: TalentCtx = {
    engine: createContentTalentEngine(),
    world,
    rng: world.rng,
    status,
    talentLevel: level,
  };
  const onUse = grab.onUse;
  if (onUse === undefined) throw new Error('Grab has no onUse');
  const use = () => onUse(ctx, squid, { x: dalt.x, y: dalt.y, actorId: 'p1' });
  return { world, dalt, squid, effects, asked, use };
}

describe('Grab — what a cast does', () => {
  it('on a hit, asks for PINNED at the scaled duration with its own physical power (:836-838)', () => {
    for (const level of [1, 3]) {
      // Defence 0 against the family's `atk = 25`: `hitChance` is 100.
      const { squid, asked, use } = beside(`grab-hit-${String(level)}`, level, 0);
      const outcome = use();
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.hits.map((h) => h.hit)).toEqual([true]);
      expect(asked).toEqual([
        {
          target: 'p1',
          effectId: EffectId.Pinned,
          turns: grabDuration(level),
          applyPower: combatPhysicalpower(squid.combat ?? {}),
          // The squid is the source, so the pin is credited to it and not to nobody.
          srcId: 'm1',
        },
      ]);
      // And the record says which way the save went, with the turns it got.
      expect(outcome.notes).toHaveLength(1);
      expect(outcome.notes[0]).toMatch(/^Dalt (is pinned \(\d turns\)\.|resists the grab!)$/);
    }
  });

  it('on a miss, pins nobody (`if hit then`, :836)', () => {
    // A defence no accuracy reaches: `hitChance` floors at 0.
    const { asked, effects, use } = beside('grab-miss', 1, 10_000);
    const outcome = use();
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.hits.map((h) => h.hit)).toEqual([false]);
    expect(asked).toEqual([]);
    expect(outcome.notes).toEqual([]);
    expect(effectsOn(effects, 'p1').map((e) => e.effectId)).not.toContain(EffectId.Pinned);
  });

  it('hits for `grabMult` of the rank, and the rank moves the blow (:833)', () => {
    /**
     * THE MULTIPLIER THROUGH `onUse`, not only on the helper. Each cast is set
     * beside `attackTarget` on an identical world asked for exactly
     * `grabMult(rank)`: the same seed draws the same to-hit, range and crit, so
     * the two blows are equal only if the talent handed the swing that number.
     * Several seeds, because one blow can round two multipliers onto one figure.
     */
    const blows = new Map<number, number[]>();
    for (const level of [1, 5]) {
      const dealt: number[] = [];
      for (let n = 0; n < 8; n += 1) {
        const seed = `grab-mult-${String(n)}`;
        const outcome = beside(seed, level, 0).use();
        expect(outcome.ok).toBe(true);
        if (!outcome.ok) return;
        const alone = beside(seed, level, 0);
        const swing = attackTarget(alone.squid, alone.dalt, alone.world, alone.world.rng, {
          mult: grabMult(level),
          skipLegality: true,
        });
        if (!swing.ok) throw new Error('the reference swing was refused');
        expect(outcome.hits[0]?.damage, `${seed} at rank ${String(level)}`).toBe(swing.damage);
        dealt.push(swing.damage);
      }
      blows.set(level, dealt);
    }
    // Precondition: rank 5's 1.4 and rank 1's 1.068 are different blows here.
    expect(blows.get(5)).not.toEqual(blows.get(1));
  });

  it('writes the pin into the record, and a refusal as upstream`s "resists the grab!" (:840)', () => {
    const answer = (outcome: SetEffectOutcome, dur: number): SetEffectResult => ({
      outcome,
      dur,
      maximum: grabDuration(1),
      saveChance: null,
      savedVs: null,
      effect: null,
    });
    const said = (result: SetEffectResult): readonly string[] => {
      const outcome = beside('grab-line', 1, 0, { answer: result }).use();
      if (!outcome.ok) throw new Error('the cast was refused');
      expect(
        outcome.hits.map((h) => h.hit),
        'precondition: the blow landed',
      ).toEqual([true]);
      return outcome.notes;
    };
    expect(said(answer(SetEffectOutcome.Applied, 2))).toEqual(['Dalt is pinned (2 turns).']);
    expect(said(answer(SetEffectOutcome.Applied, 1))).toEqual(['Dalt is pinned (1 turns).']);
    // `canBe("pin")` refused, a save negated it, a save scaled it to nothing.
    for (const outcome of [
      SetEffectOutcome.Immune,
      SetEffectOutcome.Negated,
      SetEffectOutcome.Resisted,
    ]) {
      expect(said(answer(outcome, 0)), outcome).toEqual(['Dalt resists the grab!']);
    }
  });

  it('holds no corpse: a blow that kills asks for no pin and says nothing of one', () => {
    // One hit point and defence 0: the blow lands and the body is dead before
    // the pin is reached. The real door answers a corpse `Immune`, and the
    // record would tell the party a dead man resisted.
    const { dalt, asked, use } = beside('grab-kill', 1, 0, { hp: 1 });
    const outcome = use();
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.hits.map((h) => h.hit)).toEqual([true]);
    expect(dalt.alive, 'precondition: the blow killed').toBe(false);
    expect(asked).toEqual([]);
    expect(outcome.notes).toEqual([]);
  });

  it('pins the detective in a real fight, through the scheduler and the real status door', () => {
    /**
     * THE JOIN. `monster-casts.test.ts` proves the Inkwell CASTS; this proves
     * the cast reaches a body. The fight is `monster-casts`'s own shape — eight
     * tiles apart, the detective walking in, a sampler after every pump —
     * because a pin that lands and wears off between samples is still a pin.
     */
    let pinnedTurns = 0;
    let longest = 0;
    for (let seed = 0; seed < 6; seed += 1) {
      const world = createWorld(`grab-fight-${String(seed)}`);
      const player = world.addPlayer('p1', 'Dalt');
      player.maxHp = 100_000;
      player.hp = 100_000;
      world.addMonster('m1', monsterInit(INDEX_INKWELL, { x: player.x + 8, y: player.y }, 5));
      const effects = createMvpEffectState();
      const barrier = createBarrier();
      const talents = talentRuntimeFor(
        createContentTalentEngine(),
        world,
        statusApplier(effects, world.rng),
      );
      for (let turn = 0; turn < 60; turn += 1) {
        const foe = world.getActor('m1');
        const dir = foe === undefined || !foe.alive ? null : dirToward(player, foe);
        submitIntent(
          world,
          barrier,
          'p1',
          dir === null ? { kind: IntentKind.Hold } : { kind: IntentKind.Move, dir },
        );
        pump(world, { nowMs: turn * 100, barrier, talents });
        const pin = effectsOn(effects, 'p1').find((e) => e.effectId === EffectId.Pinned);
        if (pin !== undefined) {
          pinnedTurns += 1;
          longest = Math.max(longest, pin.dur);
        }
      }
    }
    expect(pinnedTurns, 'six fights and the Inkwell never pinned anybody').toBeGreaterThan(0);
    // Never longer than the rank-1 ask: a save only shortens.
    expect(longest).toBeLessThanOrEqual(grabDuration(1));
  });

  it('and the pinned detective cannot step away from it (`never_move`, physical.lua:993)', () => {
    /**
     * THE CASE ABOVE STOPPED AT THE EFFECT TABLE, AND THE PIN DID NOTHING. The
     * effect landed and expired on schedule while `effectModifiers` never
     * collected `pinned`, so the flag the scheduler reads stayed false and the
     * detective walked away from every grab. So this one takes the step: each
     * turn the Inkwell holds them, they try for a free tile, and the scheduler
     * must refuse it as `pinned` and leave them where they stood.
     *
     * A REFUSED STEP DOES NOT END THE TURN, so it is followed by a hold.
     */
    let refused = 0;
    for (let seed = 0; seed < 6; seed += 1) {
      const world = createWorld(`grab-hold-${String(seed)}`);
      world.level.tiles.fill(TileCode.FLOOR);
      const player = world.addPlayer('p1', 'Dalt');
      player.x = 10;
      player.y = 10;
      player.maxHp = 100_000;
      player.hp = 100_000;
      world.addMonster('m1', monsterInit(INDEX_INKWELL, { x: 11, y: 10 }, 5));
      const effects = createMvpEffectState();
      const barrier = createBarrier();
      const talents = talentRuntimeFor(
        createContentTalentEngine(),
        world,
        statusApplier(effects, world.rng),
      );
      let now = 0;
      const turn = (dir: (typeof DIR_ORDER)[number] | null) => {
        submitIntent(
          world,
          barrier,
          'p1',
          dir === null ? { kind: IntentKind.Hold } : { kind: IntentKind.Move, dir },
        );
        now += 100;
        return pump(world, { nowMs: now, barrier, talents });
      };
      for (let t = 0; t < 40; t += 1) {
        const held = effectsOn(effects, 'p1').some((e) => e.effectId === EffectId.Pinned);
        if (!held) {
          turn(null);
          continue;
        }
        const away = DIR_ORDER.find((dir) => {
          const to = step(player, dir);
          return world.actorAt(to.x, to.y) === undefined;
        });
        if (away === undefined) throw new Error('the detective is boxed in');
        const before = { x: player.x, y: player.y };
        const out = turn(away);
        expect(out.events, `seed ${String(seed)} turn ${String(t)}`).toContainEqual({
          t: 'refunded',
          id: 'p1',
          reason: Refusal.Pinned,
        });
        expect({ x: player.x, y: player.y }, 'a pinned detective walked').toEqual(before);
        refused += 1;
        turn(null);
      }
    }
    expect(refused, 'six fights and nobody was ever held').toBeGreaterThan(0);
  });
});
