// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported against t-engine4 game/modules/tome/dialogs/DeathDialog.lua:92-128 (cleanActor, restoreResources)
//             t-engine4 game/modules/tome/class/Actor.lua:3675-3696 (resetToFull)
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" — https://te4.org/license

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A BODY THAT COMES BACK COMES BACK BREATHING — the wipe, a revive, a respawn.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `EFF_SUFFOCATING` is `no_remove`, so the wipe's `dispel` cannot take it off,
 * and a downed body skips `actBase`, so its air stays at 0. Before
 * `restoreBreath`, a solo player who drowned in a pond was stood up at air 0
 * with the blow still climbing and downed again two turns later — and from the
 * eighteenth turn, on every turn, for ever. Every fixture here is a body in
 * water that has already drowned once.
 */

import { setTimeout as sleep } from 'node:timers/promises';

import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { EffectId, MVP_EFFECTS } from '../../src/server/content/effects.ts';
import { MAX_AIR, catchBreath, createPlayerActor } from '../../src/server/engine/actor.ts';
import {
  DOWNED_TURNS,
  createDownedState,
  isDowned,
  isErased,
} from '../../src/server/engine/downed.ts';
import { createEffectState, hasEffect, registerEffect } from '../../src/server/engine/effects.ts';
import type { EffectState } from '../../src/server/engine/effects.ts';
import { wsGateway } from '../../src/server/net/gateway.ts';
import { createTurnEngine } from '../../src/server/turn-engine.ts';
import { createWorld } from '../../src/server/world/world.ts';
import type { World } from '../../src/server/world/world.ts';
import type { ReapingPumpResult } from '../../src/server/turn-engine.ts';
import { ErasedReason, TileCode } from '../../src/shared/protocol.ts';
import { PROTOCOL_VERSION } from '../../src/shared/version.ts';

function statusTable(): EffectState {
  const state = createEffectState();
  for (const def of MVP_EFFECTS) registerEffect(state, def);
  return state;
}

/** Did this pump tell the clients the floor reset under somebody? */
function wiped(result: ReapingPumpResult): boolean {
  return [...result.playerEvents, ...result.sweep].some(
    (event) => event.k === 'erased' && event.reason === ErasedReason.Wipe,
  );
}

/** Every tile a pond, so the spawn a reset or a respawn uses is water too. */
function drowned(seed: string): World {
  const world = createWorld(seed);
  world.level.tiles.fill(TileCode.POND_WATER);
  return world;
}

describe('catchBreath — resetToFull for air (tome/class/Actor.lua:3675-3696)', () => {
  it('fills the pool and clears both suffocation flags', () => {
    const body = createPlayerActor('p1', { name: 'Dalt', sprite: 'x', x: 3, y: 3 });
    body.air = 0;
    body.isSuffocating = true;
    body.forceSuffocate = true;
    catchBreath(body);
    expect(body.air).toBe(MAX_AIR);
    expect(body.isSuffocating).toBe(false);
    expect(body.forceSuffocate).toBe(false);
  });
});

describe('the ways back, in water', () => {
  it('a solo player who drowns is stood up by the wipe breathing, and stays up', () => {
    const world = drowned('breath-wipe');
    const effects = statusTable();
    const downed = createDownedState();
    const dalt = world.addPlayer('p1', 'Dalt', { maxHp: 100 });
    dalt.hpRegen = 0;
    dalt.air = 4;
    const engine = createTurnEngine({
      world,
      now: () => 0,
      effects,
      downed,
      reseedFloor: () => {},
    });
    engine.join('p1');

    let reset = false;
    for (let pump = 0; pump < 20 && !reset; pump += 1) {
      engine.hold('p1');
      reset = wiped(engine.pump());
    }
    expect(reset, 'precondition: the pond drowned them').toBe(true);
    expect(dalt.alive).toBe(true);
    expect(dalt.air).toBeGreaterThanOrEqual(MAX_AIR - 5);
    expect(hasEffect(effects, 'p1', EffectId.Suffocating)).toBe(false);

    // 48 turns of breath from a full pool; 30 is well inside it.
    for (let pump = 0; pump < 30; pump += 1) {
      engine.hold('p1');
      const again = wiped(engine.pump());
      expect(again, `wiped again on pump ${String(pump)}`).toBe(false);
    }
    expect(dalt.hp).toBe(100);
  });

  it('a revived body is picked up breathing, and the next base turn does not down it again', () => {
    const world = drowned('breath-revive');
    const effects = statusTable();
    const downed = createDownedState();
    const dalt = world.addPlayer('p1', 'Dalt', { maxHp: 100 });
    const ren = world.addPlayer('p2', 'Ren', { maxHp: 100 });
    dalt.x = 12;
    dalt.y = 4;
    dalt.hpRegen = 0;
    dalt.air = 0;
    dalt.hp = 10;
    ren.x = 13;
    ren.y = 4;
    ren.noBreath = true;
    const engine = createTurnEngine({ world, now: () => 0, effects, downed });
    engine.join('p1');
    engine.join('p2');

    for (let pump = 0; pump < 10 && !isDowned(downed, 'p1'); pump += 1) {
      engine.hold('p1');
      engine.hold('p2');
      engine.pump();
    }
    expect(isDowned(downed, 'p1'), 'precondition: the pond downed them').toBe(true);
    expect(hasEffect(effects, 'p1', EffectId.Suffocating)).toBe(true);

    expect(engine.submitRevive?.('p2', 'w').ok).toBe(true);
    engine.pump();
    expect(dalt.alive).toBe(true);
    expect(hasEffect(effects, 'p1', EffectId.Suffocating)).toBe(false);
    expect(dalt.air).toBeGreaterThan(MAX_AIR - 10);

    const picked = dalt.hp;
    for (let pump = 0; pump < 10; pump += 1) {
      engine.hold('p1');
      engine.hold('p2');
      engine.pump();
    }
    expect(dalt.alive).toBe(true);
    expect(dalt.hp).toBe(picked);
  });

  it('an erased body that respawns gets up breathing', () => {
    const world = drowned('breath-respawn');
    const effects = statusTable();
    const downed = createDownedState();
    const dalt = world.addPlayer('p1', 'Dalt', { maxHp: 100 });
    const ren = world.addPlayer('p2', 'Ren', { maxHp: 100 });
    dalt.hpRegen = 0;
    dalt.air = 0;
    dalt.hp = 10;
    ren.noBreath = true;
    const engine = createTurnEngine({ world, now: () => 0, effects, downed });
    engine.join('p1');
    engine.join('p2');

    for (let pump = 0; pump < 10 + DOWNED_TURNS * 2 && !isErased(downed, 'p1'); pump += 1) {
      engine.hold('p1');
      engine.hold('p2');
      engine.pump();
    }
    expect(isErased(downed, 'p1'), 'precondition: drowned and not reached').toBe(true);
    expect(dalt.air).toBe(0);

    expect(engine.submitRespawn?.('p1').ok).toBe(true);
    expect(dalt.air).toBe(MAX_AIR);
    expect(dalt.isSuffocating).toBe(false);
    expect(hasEffect(effects, 'p1', EffectId.Suffocating)).toBe(false);

    for (let pump = 0; pump < 10; pump += 1) {
      engine.hold('p1');
      engine.hold('p2');
      engine.pump();
    }
    expect(dalt.alive).toBe(true);
    expect(dalt.hp).toBe(100);
  });
});

const openSockets: WebSocket[] = [];
const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const socket of openSockets) socket.close();
  openSockets.length = 0;
  for (const close of closers) await close();
  closers.length = 0;
});

describe('the Case Log line for it', () => {
  it('says the body is Suffocating, with no turn count: `decrease = 0` counts none', async () => {
    const world = createWorld('breath-log');
    world.level.tiles.fill(TileCode.FLOOR);
    const effects = statusTable();
    const app = Fastify({ logger: false });
    await app.register(wsGateway, {
      world,
      engine: createTurnEngine({ world, now: () => 0, effects }),
      effects,
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    closers.push(async () => {
      await app.close();
    });
    const address = app.server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');

    const socket = new WebSocket(`ws://127.0.0.1:${String(address.port)}/ws`);
    openSockets.push(socket);
    const frames: Record<string, unknown>[] = [];
    socket.addEventListener('message', (event: MessageEvent) => {
      const parsed: unknown = JSON.parse(String(event.data));
      if (typeof parsed === 'object' && parsed !== null) {
        frames.push({ ...(parsed as Record<string, unknown>) });
      }
    });
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => {
        resolve();
      });
      socket.addEventListener('error', () => {
        reject(new Error('socket never opened'));
      });
    });
    socket.send(JSON.stringify({ v: PROTOCOL_VERSION, t: 'hello' }));
    const deadline = Date.now() + 4_000;
    let actorId = '';
    while (actorId === '') {
      const id = frames.find((f) => f['t'] === 'welcome')?.['selfId'];
      if (typeof id === 'string') actorId = id;
      else if (Date.now() >= deadline) throw new Error('no welcome');
      else await sleep(5);
    }

    const body = world.getActor(actorId);
    if (body === undefined) throw new Error('the welcome named no body');
    world.level.tiles[body.y * world.level.w + body.x] = TileCode.POND_WATER;
    body.air = 1;
    for (let turn = 0; turn < 3; turn += 1) {
      socket.send(JSON.stringify({ v: PROTOCOL_VERSION, t: 'hold' }));
      await sleep(80);
    }
    expect(hasEffect(effects, actorId, EffectId.Suffocating), 'precondition').toBe(true);

    const said = frames
      .filter((f) => f['t'] === 'log')
      .flatMap((f): unknown[] => (Array.isArray(f['lines']) ? (f['lines'] as unknown[]) : []))
      .map((row) => String((row as Record<string, unknown>)['text']));
    const suffocating = said.filter((line) => line.includes('Suffocating'));
    expect(suffocating.length, said.join(' | ')).toBeGreaterThan(0);
    for (const line of suffocating) {
      expect(line).toMatch(/ is Suffocating\.$/);
    }
  });
});
