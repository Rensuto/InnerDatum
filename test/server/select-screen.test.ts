// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import {
  classById,
  createContentTalentEngine,
  createTalentBook,
  sheetForClass,
} from '../../src/server/content/classes.ts';
import { talentRuntimeFor } from '../../src/server/main.ts';
import { wsGateway } from '../../src/server/net/gateway.ts';
import { createCharacterBridge, createSaveStore } from '../../src/server/persist/saves.ts';
import { createTurnEngine } from '../../src/server/turn-engine.ts';
import { createRealms } from '../../src/server/world/realms.ts';
import { PROTOCOL_VERSION } from '../../src/shared/version.ts';
import type { IdentityPort } from '../../src/server/net/gateway.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *      "WHO ARE YOU TONIGHT" — THE SELECT SCREEN, OVER THE REAL WIRE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * THE ONE CLAIM THAT MATTERS AND IS EASY TO GET WRONG: a socket sitting in the
 * select screen HAS NO BODY. Not a hidden one, not one parked on a spawn tile —
 * none. `hello` returns before `world.addPlayer` is ever reached, no `welcome`
 * is sent, and the world's actor count does not move.
 *
 * That is what makes the screen safe. A token standing in a field while its
 * player reads a menu is something a monster can walk up to, and "play one at a
 * time" is not a rule enforced somewhere else — it is the fact that a socket
 * owns one body or none.
 *
 * A REAL SAVE STORE ON A REAL TEMP DIRECTORY, because the roster is read off a
 * DIRECTORY LISTING. An in-memory fixture would answer from a Map and prove
 * nothing about the code that actually runs.
 */
const REN = '284739201847583744';
const HANDLE = 'ren-handle';

function identityPort(): IdentityPort {
  return {
    get: (id: string | undefined) =>
      id === HANDLE ? { user: { id: REN }, displayName: 'Ren' } : undefined,
  };
}

type Frame = Record<string, unknown>;

type Client = {
  send(frame: Frame): void;
  waitFor(type: string, timeoutMs?: number): Promise<Frame | undefined>;
  all(type: string): Frame[];
  settle(): Promise<void>;
  close(): void;
};

const openClients: Client[] = [];

async function connect(port: number): Promise<Client> {
  const socket = new WebSocket(`ws://127.0.0.1:${String(port)}/ws`);
  let frames: Frame[] = [];
  socket.addEventListener('message', (event: MessageEvent) => {
    for (const raw of String(event.data).split('\n')) {
      if (raw.trim() === '') continue;
      try {
        frames.push(JSON.parse(raw) as Frame);
      } catch {
        /* not a frame this test reads */
      }
    }
  });
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => {
      resolve();
    });
    socket.addEventListener('error', () => {
      reject(new Error('the socket never opened'));
    });
  });

  const waitFor = async (type: string, timeoutMs = 3000): Promise<Frame | undefined> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = frames.find((frame) => frame['t'] === type);
      if (hit !== undefined) return hit;
      if (Date.now() >= deadline) return undefined;
      await sleep(10);
    }
  };

  const client: Client = {
    send: (frame: Frame): void => {
      socket.send(JSON.stringify({ v: PROTOCOL_VERSION, ...frame }));
    },
    waitFor,
    all: (type: string): Frame[] => frames.filter((frame) => frame['t'] === type),
    settle: async (): Promise<void> => {
      client.send({ t: 'ping' });
      await waitFor('pong');
      frames = frames.filter((frame) => frame['t'] !== 'pong');
    },
    close: (): void => {
      socket.close();
    },
  };
  openClients.push(client);
  return client;
}

type Harness = {
  port: number;
  actorCount: () => number;
  close: () => Promise<void>;
};

let harness: Harness | undefined;
let root: string | undefined;

async function start(): Promise<Harness> {
  root = await mkdtemp(join(tmpdir(), 'inner-datum-select-'));
  const app = Fastify({ logger: false });
  const talents = createContentTalentEngine();
  const realms = createRealms({
    seed: 'select-screen',
    engineFor: (world) =>
      createTurnEngine({
        world,
        talents: createTalentBook(talents, world),
        talentRuntime: talentRuntimeFor(talents, world),
      }),
  });
  const store = createSaveStore({
    root,
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    debounceMs: 5,
  });
  const bridge = createCharacterBridge({
    store,
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
  });

  await app.register(wsGateway, {
    world: realms.overworld.world,
    engine: {
      ...realms.overworld.engine,
      attachClass: (actorId: string, classId: string): void => {
        const definition = classById(classId);
        if (definition !== undefined) talents.attach(actorId, sheetForClass(definition));
      },
    },
    realms,
    sessions: identityPort(),
    persist: bridge,
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (address === null || typeof address === 'string') throw new Error('no port was bound');

  return {
    port: address.port,
    actorCount: () => [...realms.overworld.world.allActors()].length,
    close: async (): Promise<void> => {
      await app.close();
      await store.close();
    },
  };
}

afterEach(async () => {
  for (const client of openClients) client.close();
  openClients.length = 0;
  await harness?.close();
  harness = undefined;
  if (root !== undefined) await rm(root, { recursive: true, force: true });
  root = undefined;
});

describe('the character select screen', () => {
  it('shows a verified player a roster and puts no body in the world', async () => {
    harness = await start();
    const before = harness.actorCount();
    const client = await connect(harness.port);

    client.send({ t: 'hello', sessionId: HANDLE });
    const roster = await client.waitFor('roster');

    expect(roster, 'a verified player was never offered a roster').toBeDefined();
    // FIRST SIGHT OF THE ACCOUNT: no directory, so no rows, and the screen is an
    // invitation to create rather than an error.
    expect(roster?.['characters']).toEqual([]);
    expect(roster?.['canCreate']).toBe(true);
    expect(roster?.['cases']).toBeGreaterThan(0);

    // ═══ THE ASSERTION THE WHOLE DESIGN RESTS ON ═══
    await client.settle();
    expect(client.all('welcome'), 'a body was built for somebody still at the menu').toHaveLength(
      0,
    );
    expect(harness.actorCount(), 'the world grew while nobody had chosen').toBe(before);
  });

  it('lets an anonymous player straight in, because there is no account to list', async () => {
    // THE HALF THAT MUST NOT MOVE. This game is developed with no Discord app
    // configured, and an empty select screen in front of somebody who can never
    // fill it is a menu that only says no.
    harness = await start();
    const client = await connect(harness.port);
    client.send({ t: 'hello' });

    expect(await client.waitFor('welcome'), 'an anonymous player was left at a menu').toBeDefined();
    expect(client.all('roster')).toHaveLength(0);
  });

  it('creates a character on request and drops that player into the world', async () => {
    harness = await start();
    const client = await connect(harness.port);

    client.send({ t: 'hello', sessionId: HANDLE, newCharacter: true });
    const welcome = await client.waitFor('welcome');
    expect(welcome, 'a new character never entered the world').toBeDefined();
    // A BRAND-NEW CHARACTER OWES A CLASS CHOICE, which is how a player can tell
    // this is a new one rather than a resumed one.
    expect(await client.waitFor('class_options')).toBeDefined();
  });

  it('remembers a character and offers it back by name on the next connection', async () => {
    harness = await start();
    const first = await connect(harness.port);
    first.send({ t: 'hello', sessionId: HANDLE, newCharacter: true });
    await first.waitFor('welcome');
    const options = (first.all('class_options')[0]?.['options'] ?? []) as { id: string }[];
    first.send({ t: 'choose_class', classId: options[0]?.id });
    await first.settle();
    // A CLASS CHOICE IS A CRITICAL SAVE, so the file is on disk without waiting
    // out a debounce.
    await sleep(400);
    first.close();

    const second = await connect(harness.port);
    second.send({ t: 'hello', sessionId: HANDLE });
    const roster = await second.waitFor('roster');
    const rows = (roster?.['characters'] ?? []) as {
      id: string;
      className?: string;
      playable: boolean;
    }[];

    expect(rows.length, 'the character that was just played is not on the roster').toBe(1);
    expect(rows[0]?.playable).toBe(true);
    // ═══ THE CLASS ARRIVES RESOLVED, NOT AS AN ID ═══
    // A row reading `watchman` has leaked an id at the player.
    expect(rows[0]?.className, 'the row shows a class id instead of a name').toBe(
      classById(options[0]?.id ?? '')?.name,
    );

    // AND NAMING IT ENTERS THE WORLD, with no class choice owed this time —
    // which is the proof the file was found rather than a new one made.
    const third = await connect(harness.port);
    third.send({ t: 'hello', sessionId: HANDLE, characterId: rows[0]?.id });
    expect(await third.waitFor('welcome')).toBeDefined();
    await third.settle();
    expect(third.all('class_options'), 'a saved character was asked to choose again').toHaveLength(
      0,
    );
  });

  it('gives the roster back rather than a body when the named character is not theirs', async () => {
    /**
     * ═══ SOMEBODY ELSE'S CHARACTER IS NOT A PATH THAT EXISTS ═══
     * The lookup is `data/characters/<ownerId>/<characterId>.json` and the owner
     * comes from the verified session, never from the frame — so naming another
     * account's character id resolves to a file that is not there.
     *
     * IT MUST NOT JOIN ANYWAY. Joining with no binding would put a player in the
     * world believing they are playing a character that is not being written to,
     * and they would find out at the end of the evening.
     */
    harness = await start();
    const client = await connect(harness.port);
    client.send({ t: 'hello', sessionId: HANDLE, characterId: 'chr_0007' });

    const roster = await client.waitFor('roster');
    expect(roster, 'an unknown character id was allowed into the world').toBeDefined();
    await client.settle();
    expect(client.all('welcome')).toHaveLength(0);
  });
});
