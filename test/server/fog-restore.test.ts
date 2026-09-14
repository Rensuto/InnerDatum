// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

import { setTimeout as sleep } from 'node:timers/promises';

import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { WATCHMAN } from '../../src/server/content/classes.ts';
import { createDownedState } from '../../src/server/engine/downed.ts';
import { createPartyState } from '../../src/server/engine/party.ts';
import { wsGateway } from '../../src/server/net/gateway.ts';
import { createTurnEngine } from '../../src/server/turn-engine.ts';
import { createRealms } from '../../src/server/world/realms.ts';
import { createFog, fogHas, fogSet, fogToBase64 } from '../../src/shared/fog.ts';
import { REDACTION_SITE_ID } from '../../src/shared/level.ts';
import { PROTOCOL_VERSION } from '../../src/shared/version.ts';
import type { CharacterRestore, IdentityPort, PersistPort } from '../../src/server/net/gateway.ts';
import type { Realms } from '../../src/server/world/realms.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE WAY BACK: A SAVED MAP IS REMEMBERED AGAIN ON THE NEXT JOIN.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `fog-persistence.test.ts` proves the gateway OFFERS both maps to the persist
 * layer, and the file round-trips them. Nothing handed a saved map back to the
 * gateway and looked: dropping either restore survived every suite.
 */

const FRAME_TIMEOUT_MS = 4_000;
const OWNER_ID = '444444444444444444';
const REDACTION_REALM_ID = `realm:${REDACTION_SITE_ID}`;
/** A corner tile nobody can have seen from where a character wakes. */
const FAR_CORNER = { x: 1, y: 1 };

type Harness = { port: number; realms: Realms; close: () => Promise<void> };
let server: Harness;
let restore: CharacterRestore | null = null;
const sockets: WebSocket[] = [];

beforeEach(async () => {
  const downed = createDownedState();
  const parties = createPartyState();
  const realms = createRealms({
    seed: 'fog-restore',
    engineFor: (world) => createTurnEngine({ world, downed, parties }),
  });
  const sessions: IdentityPort = {
    get: (id: string | undefined) =>
      id === 'fog-handle' ? { user: { id: OWNER_ID }, displayName: 'Fog' } : undefined,
  };
  const persist: PersistPort = {
    savePlayers: (): void => {},
    openCharacter: () => Promise.resolve(restore),
  };
  const app = Fastify({ logger: false });
  await app.register(wsGateway, {
    world: realms.overworld.world,
    engine: realms.overworld.engine,
    realms,
    parties,
    downed,
    sessions,
    persist,
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (address === null || typeof address === 'string') throw new Error('no port was bound');
  server = {
    port: address.port,
    realms,
    close: async (): Promise<void> => {
      await app.close();
    },
  };
});

afterEach(async () => {
  for (const socket of sockets) socket.close();
  sockets.length = 0;
  restore = null;
  await server.close();
});

async function join(): Promise<string> {
  const socket = new WebSocket(`ws://127.0.0.1:${String(server.port)}/ws`);
  sockets.push(socket);
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
  socket.send(JSON.stringify({ v: PROTOCOL_VERSION, t: 'hello', sessionId: 'fog-handle' }));
  const deadline = Date.now() + FRAME_TIMEOUT_MS;
  for (;;) {
    const id = frames.find((f) => f['t'] === 'welcome')?.['selfId'];
    if (typeof id === 'string') return id;
    if (Date.now() >= deadline) throw new Error('no welcome came back');
    await sleep(5);
  }
}

/** A saved map of `realm`'s level with only the far corner remembered. */
function savedCorner(w: number, h: number): string {
  const bits = createFog(w, h);
  fogSet(bits, w, FAR_CORNER.x, FAR_CORNER.y);
  return fogToBase64(bits);
}

describe('a saved map comes back', () => {
  it('remembers the home map and the second map a character saved', async () => {
    const home = server.realms.overworld.world;
    const second = server.realms.get(REDACTION_REALM_ID);
    expect(second, 'precondition: the second map exists when a character joins').toBeDefined();
    if (second === undefined) return;

    restore = {
      hp: null,
      cooldowns: {},
      classId: WATCHMAN.id,
      explored: savedCorner(home.level.w, home.level.h),
      exploredElsewhere: {
        [REDACTION_REALM_ID]: savedCorner(second.world.level.w, second.world.level.h),
      },
    };
    const actorId = await join();

    expect(
      fogHas(home.memoryOf(actorId), home.level.w, FAR_CORNER.x, FAR_CORNER.y),
      'the home map was saved and came back forgotten',
    ).toBe(true);
    expect(
      fogHas(second.world.memoryOf(actorId), second.world.level.w, FAR_CORNER.x, FAR_CORNER.y),
      'the second map was saved and came back forgotten',
    ).toBe(true);
  });
});
