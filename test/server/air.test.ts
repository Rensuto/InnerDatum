// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/modules/tome/class/Actor.lua:574-590, 6725-6741 (air, suffocate)
//             t-engine4 game/modules/tome/data/timed_effects/other.lua:2265-2289 (SUFFOCATING)
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" — https://te4.org/license

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * BREATH: THE POOL, THE GROUND THAT TAKES IT, AND THE STATUS THAT KILLS.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The worked numbers are upstream's, derived once here so nobody has to trust
 * them:
 *
 *   DEEP WATER (`air_level = -5`, water). Each base turn regenerates 3, bounded
 *   at 100, and then takes 5. From a full breath: 100 → 95, and every turn
 *   after nets −2. So after turn k the pool is 97 − 2k. Turn 48 leaves 1; turn
 *   49 regenerates to 4 and takes 5, which is −1, clamped to 0 — and
 *   `EFF_SUFFOCATING` lands, and `timedEffects` runs later in the SAME base
 *   turn, so the first 20% of maximum life comes out on turn 49. Then 25, 30, 35.
 *
 *   A −20 GROUND: 100 → 80, then +3 −20 each turn: 63, 46, 29, 12, and on the
 *   sixth turn 15 − 20 = −5, clamped to 0.
 */

import { describe, expect, it } from 'vitest';

import {
  EffectId,
  MVP_EFFECTS,
  SUFFOCATING,
  SUFFOCATING_START_PERCENT,
  validateEffect,
} from '../../src/server/content/effects.ts';
import {
  INDEX_HUSK,
  INDEX_WRAITH,
  MONSTER_TEMPLATES,
  monsterInit,
} from '../../src/server/content/monsters.ts';
import {
  AIR_REGEN,
  AiProfile,
  MAX_AIR,
  actBase,
  createMonsterActor,
  createPlayerActor,
  suffocate,
} from '../../src/server/engine/actor.ts';
import type { EngineActor, TerrainProbe } from '../../src/server/engine/actor.ts';
import { takeHit } from '../../src/server/engine/damage.ts';
import {
  EffectStatus,
  ImmunityKey,
  SetEffectOutcome,
  createEffectState,
  grantImmunity,
  dispel,
  effectOn,
  hasEffect,
  registerEffect,
  removeEffect,
  setEffect,
  StackMode,
  statusCurer,
  statusPass,
  timedEffects,
} from '../../src/server/engine/effects.ts';
import type {
  EffectCtx,
  EffectLogLine,
  EffectState,
  StatusHit,
} from '../../src/server/engine/effects.ts';
import { createTurnEngine } from '../../src/server/turn-engine.ts';
import { createWorld } from '../../src/server/world/world.ts';
import type { World } from '../../src/server/world/world.ts';
import { tileIndex } from '../../src/shared/coords.ts';
import { TileCode } from '../../src/shared/protocol.ts';
import { RestStop } from '../../src/shared/rest.ts';
import { createRng } from '../../src/shared/rng.ts';
import { AIR_LEVEL, airOf } from '../../src/shared/terrain.ts';
import type { AirGrid } from '../../src/shared/terrain.ts';

const DEEP_WATER: AirGrid = { level: -5, condition: 'water' };

/** The whole roster, registered the way main.ts registers it. */
function statusTable(): EffectState {
  const state = createEffectState();
  for (const def of MVP_EFFECTS) registerEffect(state, def);
  return state;
}

/**
 * A body, a status table, and a probe standing it on `ground`. The door is the
 * production one's shape — `hasEffect` guard, one turn, no params — so a unit
 * test and the turn engine lay the same effect.
 */
function standing(ground: () => AirGrid | undefined, maxHp = 100) {
  const state = statusTable();
  const rng = createRng('air');
  const hits: StatusHit[] = [];
  const notes: EffectLogLine[] = [];
  const ctx: EffectCtx = {
    noteDamage: (hit) => hits.push(hit),
    log: (line) => notes.push(line),
  };
  const body = createPlayerActor('p1', { name: 'Dalt', sprite: 'x', x: 3, y: 3, maxHp });
  body.hpRegen = 0;
  const probe: TerrainProbe = {
    airAt: () => ground(),
    startSuffocating: (who: EngineActor): void => {
      if (hasEffect(state, who.id, EffectId.Suffocating)) return;
      setEffect(state, who, EffectId.Suffocating, 1, {}, rng, ctx);
    },
  };
  const pass = statusPass(state, rng, ctx);
  const tick = (): void => actBase(body, pass, probe);
  return { state, rng, ctx, body, tick, hits, notes };
}

describe('the pool every body has — resources.lua:45 and tome/class/Actor.lua:228', () => {
  it('is 100 with a regeneration of 3, on players and monsters alike', () => {
    expect(MAX_AIR).toBe(100);
    expect(AIR_REGEN).toBe(3);
    const player = createPlayerActor('p', { name: 'P', sprite: 'x', x: 0, y: 0 });
    const monster = createMonsterActor('m', {
      name: 'M',
      sprite: 'x',
      x: 0,
      y: 0,
      profile: AiProfile.MeleeChaser,
    });
    for (const body of [player, monster]) {
      expect(body.air).toBe(100);
      expect(body.maxAir).toBe(100);
      expect(body.airRegen).toBe(3);
      expect(body.isSuffocating).toBe(false);
      expect(body.forceSuffocate).toBe(false);
    }
  });

  it('refills by 3 a base turn on ground with no air rule, and never past 100', () => {
    const { body, tick } = standing(() => undefined);
    body.air = 40;
    tick();
    expect(body.air).toBe(43);
    body.air = 99;
    tick();
    expect(body.air).toBe(100);
  });
});

describe('deep water — tome/class/Actor.lua:574-590, the worked numbers', () => {
  it('drains 97 − 2k, and SUFFOCATING bites on turn 49 for 20, 25, 30 and 35 per cent', () => {
    const { state, body, tick, hits } = standing(() => DEEP_WATER, 1000);
    for (let k = 1; k <= 48; k += 1) {
      tick();
      expect(body.air, `after turn ${String(k)}`).toBe(97 - 2 * k);
      expect(body.hp, `nothing hurts yet on turn ${String(k)}`).toBe(1000);
    }
    expect(hasEffect(state, body.id, EffectId.Suffocating)).toBe(false);

    const percents: number[] = [];
    for (let k = 49; k <= 52; k += 1) {
      tick();
      expect(body.air, `turn ${String(k)} holds the pool at zero`).toBe(0);
      percents.push(((1000 - body.hp) / 1000) * 100);
      body.hp = 1000;
    }
    expect(percents).toEqual([20, 25, 30, 35]);
    expect(hits.map((hit) => hit.amount)).toEqual([200, 250, 300, 350]);
    // No type: it is not a projector (timed_effects/other.lua:2282-2285).
    expect(hits.every((hit) => hit.type === undefined && hit.sourceId === null)).toBe(true);
    // decrease 0: the duration it was set with is the duration it still has.
    expect(effectOn(state, body.id, EffectId.Suffocating)?.dur).toBe(1);
  });

  it('a −20 ground reads 100, 80, 63, 46, 29, 12, 0 — and lays the effect once', () => {
    const { state, body, tick } = standing(() => ({ level: -20 }));
    const seen = [body.air];
    let laid = 0;
    for (let turn = 1; turn <= 6; turn += 1) {
      const had = hasEffect(state, body.id, EffectId.Suffocating);
      tick();
      if (!had && hasEffect(state, body.id, EffectId.Suffocating)) laid += 1;
      seen.push(body.air);
    }
    expect(seen).toEqual([100, 80, 63, 46, 29, 12, 0]);
    expect(laid).toBe(1);
    expect(body.isSuffocating).toBe(true);
  });

  it('the percentage caps at the whole body, from the seventeenth blow', () => {
    const { state, body, tick } = standing(() => DEEP_WATER, 10_000);
    body.air = 0;
    for (let blow = 1; blow <= 18; blow += 1) {
      body.hp = 10_000;
      tick();
      if (blow === 17 || blow === 18) expect(body.hp).toBe(0);
      body.alive = true;
    }
    expect(effectOn(state, body.id, EffectId.Suffocating)?.params.power).toBe(100);
  });
});

describe('who does not drown', () => {
  it('a body that breathes water loses nothing and is not suffocating', () => {
    const { state, body, tick } = standing(() => DEEP_WATER);
    body.canBreath = { water: 1 };
    for (let turn = 0; turn < 60; turn += 1) tick();
    expect(body.air).toBe(100);
    expect(body.isSuffocating).toBe(false);
    expect(hasEffect(state, body.id, EffectId.Suffocating)).toBe(false);
  });

  it('a count of zero is no breath at all (tome/class/Actor.lua:586, `<= 0`)', () => {
    const { body, tick } = standing(() => DEEP_WATER);
    body.canBreath = { water: 0 };
    tick();
    expect(body.air).toBe(95);
  });

  it('`no_breath` loses nothing — but the flag is still set, as upstream sets it', () => {
    const { state, body, tick, hits } = standing(() => DEEP_WATER);
    body.noBreath = true;
    for (let turn = 0; turn < 60; turn += 1) tick();
    expect(body.air).toBe(100);
    expect(hits).toEqual([]);
    expect(hasEffect(state, body.id, EffectId.Suffocating)).toBe(false);
    // :587 sets `is_suffocating` BEFORE `suffocate` refuses at :6726.
    expect(body.isSuffocating).toBe(true);
  });

  it('three templates carry `no_breath`, each from its family base, and none `can_breath`', () => {
    const noBreath = MONSTER_TEMPLATES.filter((t) => t.noBreath === true).map((t) => t.id);
    // npcs/losgoroth.lua:48 and npcs/crystal.lua:48.
    expect(noBreath.sort()).toEqual(['index_cairn', 'index_watcher', 'index_wraith']);
    expect(MONSTER_TEMPLATES.filter((t) => t.canBreath !== undefined)).toEqual([]);
    for (const template of MONSTER_TEMPLATES) {
      const body = createMonsterActor('b', monsterInit(template, { x: 0, y: 0 }));
      expect(
        body.noBreath === true,
        `${template.id} lost its breath flag on the way to the body`,
      ).toBe(template.noBreath === true);
    }
  });
});

describe('SUFFOCATING — timed_effects/other.lua:2265-2289', () => {
  it('takes `max_life * dam / 100` unrounded: 20% of 37 is 7.4 (other.lua:2285)', () => {
    const { body, tick } = standing(() => DEEP_WATER, 37);
    body.air = 0;
    tick();
    expect(body.hp).toBeCloseTo(37 - 7.4, 9);
  });

  it('is detrimental, with the subtype `suffocating` (other.lua:2270-2271)', () => {
    expect(SUFFOCATING.subtypes).toEqual(['suffocating']);
    expect(SUFFOCATING.status).toBe(EffectStatus.Detrimental);
  });

  it('ignores resistances, a shield and the talent chain: it is `takeHit`, not a projector', () => {
    const { body, tick } = standing(() => DEEP_WATER);
    body.air = 0;
    body.combat = { ...body.combat, profile: { resists: { all: 100 } } };
    body.absorb = (dam: number): number => dam;
    tick();
    expect(body.hp).toBe(100 - SUFFOCATING_START_PERCENT);
  });

  it('leaves the first turn the body can breathe, before it bites, saying so', () => {
    let ground: AirGrid | undefined = DEEP_WATER;
    const { state, body, tick, notes } = standing(() => ground);
    body.air = 0;
    tick();
    expect(body.hp).toBe(80);
    ground = undefined;
    tick();
    expect(body.hp, 'dry ground, and it still bit').toBe(80);
    expect(hasEffect(state, body.id, EffectId.Suffocating)).toBe(false);
    expect(notes.some((n) => n.effectId === EffectId.Suffocating && n.kind === 'lost')).toBe(true);
    expect(body.air).toBe(3);
  });

  it('D5-6: an air bubble refills you AND keeps it biting, as upstream is written', () => {
    let ground: AirGrid | undefined = DEEP_WATER;
    const { state, body, tick } = standing(() => ground);
    body.air = 0;
    tick();
    expect(body.hp).toBe(80);
    ground = AIR_LEVEL[TileCode.WATER_FLOOR_BUBBLE];
    tick();
    // +3 regen, then `suffocate(-15)`: the bubble gives air.
    expect(body.air).toBe(18);
    // …and `is_suffocating` went true at :587, so the effect bit again at 25%.
    expect(body.hp).toBe(55);
    expect(hasEffect(state, body.id, EffectId.Suffocating)).toBe(true);
  });

  it('a bubble lifts a full body past its ceiling, and the next turn bounds it (:6728, :558)', () => {
    const { body, tick } = standing(() => airOf(TileCode.WATER_FLOOR_BUBBLE));
    tick();
    expect(body.air).toBe(115);
    tick();
    expect(body.air).toBe(115);
  });

  it('nothing removes it but itself: no dispel, no cure, no expiry', () => {
    const { state, rng, body, tick } = standing(() => DEEP_WATER);
    body.air = 0;
    tick();
    expect(dispel(state, body, () => true, rng)).toBe(0);
    expect(statusCurer(state, rng)(body, EffectStatus.Detrimental)).toBeNull();
    expect(removeEffect(state, body, EffectId.Suffocating, rng)).toBe(false);
    expect(hasEffect(state, body.id, EffectId.Suffocating)).toBe(true);
    // `force` — ActorTemporaryEffects.lua:191's second clause.
    expect(removeEffect(state, body, EffectId.Suffocating, rng, {}, false, true)).toBe(true);
    expect(hasEffect(state, body.id, EffectId.Suffocating)).toBe(false);
  });

  it('is `type = "other"`: blanket immunities and shorter afflictions pass it by (:6956, :7048)', () => {
    expect(SUFFOCATING.typeOther).toBe(true);
    for (const key of [ImmunityKey.AllNegative, ImmunityKey.PhysicalNegative]) {
      const { state, rng, body } = standing(() => DEEP_WATER);
      grantImmunity(state, body.id, key, 100);
      expect(setEffect(state, body, EffectId.Suffocating, 1, {}, rng).outcome, key).toBe(
        SetEffectOutcome.Applied,
      );
    }
    const { state, rng, body } = standing(() => DEEP_WATER);
    body.combat = { ...body.combat, flags: { ...body.combat?.flags, reduceDetrimentalTime: 100 } };
    expect(setEffect(state, body, EffectId.Suffocating, 1, {}, rng).dur).toBe(1);
  });

  it('is the one shape `validateEffect` lets `decrease: 0` through for', () => {
    expect(validateEffect(SUFFOCATING)).toEqual([]);
    const permanent = 'effect:suffocating: decrease 0 never expires (ActorTemporaryEffects.lua:91)';
    expect(validateEffect({ ...SUFFOCATING, noRemove: undefined })).toContain(permanent);
    expect(validateEffect({ ...SUFFOCATING, onTimeout: undefined })).toContain(permanent);
  });
});

describe('suffocate — tome/class/Actor.lua:6725-6741', () => {
  it('refuses a `no_breath` body outright', () => {
    const body = createPlayerActor('p', { name: 'P', sprite: 'x', x: 0, y: 0 });
    body.noBreath = true;
    expect(suffocate(body, 50)).toBe(false);
    expect(body.air).toBe(100);
    expect(body.forceSuffocate).toBe(false);
  });

  it('a pool that lands on exactly zero has run out (`<= 0`, :6731)', () => {
    const body = createPlayerActor('p', { name: 'P', sprite: 'x', x: 0, y: 0 });
    body.air = 5;
    let asked = 0;
    suffocate(body, 5, () => (asked += 1));
    expect(body.air).toBe(0);
    expect(asked).toBe(1);
  });

  it('subtracts unclamped above, clamps at zero, and only then asks for the status', () => {
    const body = createPlayerActor('p', { name: 'P', sprite: 'x', x: 0, y: 0 });
    let asked = 0;
    expect(suffocate(body, -20, () => (asked += 1))).toBe(true);
    expect(body.air).toBe(120);
    expect(body.forceSuffocate).toBe(true);
    expect(asked).toBe(0);
    suffocate(body, 500, () => (asked += 1));
    expect(body.air).toBe(0);
    expect(asked).toBe(1);
  });

  it('air taken between base turns keeps the body suffocating for exactly one (:578-583)', () => {
    const { body, tick } = standing(() => undefined);
    suffocate(body, 10);
    tick();
    expect(body.isSuffocating).toBe(true);
    expect(body.forceSuffocate).toBe(false);
    tick();
    expect(body.isSuffocating).toBe(false);
  });
});

describe('`noRemove` — ActorTemporaryEffects.lua:191, beyond the one effect that has it', () => {
  /** A permanent-until-it-says-so effect with a counted `deactivate`. */
  function held(decrease: number) {
    const state = createEffectState();
    let deactivated = 0;
    registerEffect(state, {
      ...SUFFOCATING,
      id: 'effect:held',
      stackMode: StackMode.Refresh,
      decrease,
      onTimeout: undefined,
      describe: undefined,
      deactivate: () => {
        deactivated += 1;
      },
    });
    const body = createPlayerActor('h', { name: 'H', sprite: 'x', x: 0, y: 0 });
    return { state, body, rng: createRng('held'), deactivations: () => deactivated };
  }

  it('an expiry does not remove it, and the tick does not report it gone (:95-97, no force)', () => {
    const { state, body, rng } = held(1);
    setEffect(state, body, 'effect:held', 1, {}, rng);
    expect(timedEffects(state, body, rng).expired).toEqual([]);
    const second = timedEffects(state, body, rng);
    expect(second.expired, 'reported as expired while still on the body').toEqual([]);
    expect(hasEffect(state, body.id, 'effect:held')).toBe(true);
  });

  it('a re-set still replaces it, running `deactivate` — `removeEffect(eff_id, true, true)` (:128)', () => {
    const { state, body, rng, deactivations } = held(0);
    setEffect(state, body, 'effect:held', 1, {}, rng);
    setEffect(state, body, 'effect:held', 1, {}, rng);
    expect(deactivations()).toBe(1);
  });
});

describe('takeHit — tome/class/interface/ActorLife.lua:41-60 with onTakeHit detached', () => {
  it('subtracts, clamps what it reports to the hit points there were, and kills at zero', () => {
    const body = { hp: 30, alive: true };
    expect(takeHit(body, 12)).toEqual({ dealt: 12, killed: false });
    expect(body.hp).toBe(18);
    expect(takeHit(body, 40)).toEqual({ dealt: 18, killed: true });
    expect(body).toEqual({ hp: 0, alive: false });
  });

  it('takes nothing from a corpse or for a non-positive value (:43)', () => {
    expect(takeHit({ hp: 0, alive: false }, 10)).toEqual({ dealt: 0, killed: false });
    const body = { hp: 10, alive: true };
    expect(takeHit(body, 0)).toEqual({ dealt: 0, killed: false });
    expect(takeHit(body, -5)).toEqual({ dealt: 0, killed: false });
    expect(body.hp).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// THE JOIN — the scheduler's probe and turn-engine's door, driven for real
// ---------------------------------------------------------------------------

function pond(seed: string): { world: World; effects: EffectState } {
  const world = createWorld(seed);
  world.level.tiles.fill(TileCode.FLOOR);
  return { world, effects: statusTable() };
}

function paint(world: World, x: number, y: number, code: TileCode): void {
  world.level.tiles[tileIndex(x, y, world.level.w)] = code;
}

/** A pocket of pond water walled on all eight sides, so nothing can wade out. */
function pocket(world: World, x: number, y: number): void {
  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) paint(world, x + dx, y + dy, TileCode.WALL);
  }
  paint(world, x, y, TileCode.POND_WATER);
}

// OFF THE DIAGONAL from here down: a probe that read `(y, x)` would find the same
// tile at (10, 10), and finds dry floor at (12, 4).
describe('through the turn engine — the probe and the door are wired', () => {
  it('a player standing in a pond drains 97 − 2k and takes the blows on turn 49', () => {
    const { world, effects } = pond('air-join');
    const dalt = world.addPlayer('p1', 'Dalt', { maxHp: 1000 });
    dalt.x = 12;
    dalt.y = 4;
    dalt.hpRegen = 0;
    paint(world, 12, 4, TileCode.POND_WATER);
    const engine = createTurnEngine({ world, now: () => 0, effects });
    engine.join('p1');
    const start = world.turn.clock.gameTurn;

    const blows: number[] = [];
    for (let pump = 0; pump < 120 && blows.length < 4; pump += 1) {
      expect(engine.hold('p1').ok).toBe(true);
      engine.pump();
      const k = world.turn.clock.gameTurn - start;
      if (k <= 48) {
        expect(dalt.air, `after game turn ${String(k)}`).toBe(97 - 2 * k);
        expect(dalt.hp).toBe(1000);
      } else {
        blows.push(1000 - dalt.hp);
        dalt.hp = 1000;
      }
    }
    expect(blows).toEqual([200, 250, 300, 350]);
    expect(hasEffect(effects, 'p1', EffectId.Suffocating)).toBe(true);
  });

  it('a monster that breathes drowns and is buried; a Wraith beside it does not', () => {
    const { world, effects } = pond('air-drown');
    const dalt = world.addPlayer('p1', 'Dalt', { maxHp: 100 });
    dalt.x = 30;
    dalt.y = 30;
    pocket(world, 5, 7);
    pocket(world, 9, 5);
    world.addMonster('m_husk', monsterInit(INDEX_HUSK, { x: 5, y: 7 }));
    const wraith = world.addMonster('m_wraith', monsterInit(INDEX_WRAITH, { x: 9, y: 5 }));
    expect(world.getActor('m_husk')?.x).toBe(5);
    expect(wraith.x).toBe(9);

    const engine = createTurnEngine({ world, now: () => 0, effects });
    engine.join('p1');
    const reaped: string[] = [];
    for (let pump = 0; pump < 80; pump += 1) {
      engine.hold('p1');
      reaped.push(...engine.pump().reaped);
    }
    expect(reaped, 'the husk drowned and nothing buried it').toContain('m_husk');
    expect(wraith.alive).toBe(true);
    expect(wraith.air).toBe(100);
  });

  it('lays SUFFOCATING for one turn through the production door, as `setEffect(..., 1, {dam=20})`', () => {
    const { world, effects } = pond('air-door-turns');
    const dalt = world.addPlayer('p1', 'Dalt', { maxHp: 1000 });
    dalt.x = 12;
    dalt.y = 4;
    dalt.air = 0;
    paint(world, 12, 4, TileCode.POND_WATER);
    const engine = createTurnEngine({ world, now: () => 0, effects });
    engine.join('p1');
    for (let pump = 0; pump < 3; pump += 1) {
      engine.hold('p1');
      engine.pump();
    }
    expect(effectOn(effects, 'p1', EffectId.Suffocating)?.dur).toBe(1);
  });

  it('with no status table the lungs still empty and nothing hurts — the absent contract', () => {
    const world = createWorld('air-absent');
    world.level.tiles.fill(TileCode.FLOOR);
    const dalt = world.addPlayer('p1', 'Dalt', { maxHp: 100 });
    dalt.x = 12;
    dalt.y = 4;
    dalt.hpRegen = 0;
    paint(world, 12, 4, TileCode.POND_WATER);
    const engine = createTurnEngine({ world, now: () => 0 });
    engine.join('p1');
    for (let pump = 0; pump < 70; pump += 1) {
      engine.hold('p1');
      engine.pump();
    }
    expect(dalt.air).toBe(0);
    expect(dalt.hp).toBe(100);
  });
});

describe('rest in water — Player.lua:771-781, through `engine.rest`', () => {
  it('rests a wounded body in a pond until its lungs are a quarter empty, and says why', () => {
    const { world, effects } = pond('air-rest');
    const dalt = world.addPlayer('p1', 'Dalt', { maxHp: 1000 });
    dalt.x = 12;
    dalt.y = 4;
    dalt.hp = 500;
    paint(world, 12, 4, TileCode.POND_WATER);
    const engine = createTurnEngine({ world, now: () => 0, effects });
    engine.join('p1');

    const result = engine.rest('p1');
    expect(result.stop).toBe(RestStop.Breath);
    // 97 − 2k first drops below 75 at k = 12 (73). It must have started, and
    // stopped long before the water began to hurt.
    expect(result.turns).toBeGreaterThan(0);
    expect(dalt.air).toBeLessThan(75);
    expect(dalt.air).toBeGreaterThanOrEqual(71);
    expect(hasEffect(effects, 'p1', EffectId.Suffocating)).toBe(false);
  });

  it('on a bubble, does not wait for breath: `is_suffocating` is set there (:1004, D5-6)', () => {
    const { world, effects } = pond('air-rest-bubble');
    const dalt = world.addPlayer('p1', 'Dalt', { maxHp: 100 });
    dalt.x = 12;
    dalt.y = 4;
    dalt.air = 10;
    paint(world, 12, 4, TileCode.WATER_FLOOR_BUBBLE);
    const engine = createTurnEngine({ world, now: () => 0, effects });
    engine.join('p1');

    // Turn one rests (the body has not yet had a base turn on the bubble), and
    // that turn sets `is_suffocating`; the next check has nothing it may wait on.
    const result = engine.rest('p1');
    expect(result.stop).toBe(RestStop.Done);
    expect(result.turns).toBe(1);
    expect(dalt.air).toBeLessThan(100);
  });

  it('a body that does not breathe, or breathes water, rests in a pond (:1001 asks `losing`)', () => {
    for (const who of ['no_breath', 'can_breath'] as const) {
      const { world, effects } = pond(`air-rest-${who}`);
      const dalt = world.addPlayer('p1', 'Dalt', { maxHp: 1000 });
      dalt.x = 12;
      dalt.y = 4;
      dalt.hp = 900;
      dalt.air = 50;
      if (who === 'no_breath') dalt.noBreath = true;
      else dalt.canBreath = { water: 1 };
      paint(world, 12, 4, TileCode.POND_WATER);
      const engine = createTurnEngine({ world, now: () => 0, effects });
      engine.join('p1');
      expect(engine.rest('p1').stop, who).not.toBe(RestStop.Breath);
    }
  });

  it('on dry ground, rests a short breath back to full even at full health (:1004)', () => {
    const { world, effects } = pond('air-rest-dry');
    const dalt = world.addPlayer('p1', 'Dalt', { maxHp: 100 });
    dalt.x = 12;
    dalt.y = 4;
    dalt.air = 40;
    const engine = createTurnEngine({ world, now: () => 0, effects });
    engine.join('p1');

    const result = engine.rest('p1');
    expect(result.stop).toBe(RestStop.Done);
    expect(dalt.air).toBe(100);
  });
});
