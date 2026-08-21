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
import type { SaveStore } from '../../src/server/persist/saves.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *   CHANGING CHARACTER MUST CHANGE THE CHARACTER.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * REPORTED FROM A REAL SESSION, WITH A SCREENSHOT: the select screen showed
 * three rows, all called Ren, all level 2, all "The Alchemist of Ashwick Row",
 * all 15 gold, all "just now". Pressing NEW CHARACTER twice had produced two
 * more copies of the character already being played.
 *
 * ═══ WHAT WAS ACTUALLY WRONG ═══
 * `resolveActor` keys a body to the ACCOUNT (`findBody(verified.actorId)`) and
 * its identity branch returns the body it finds BEFORE `applyRestore` runs.
 * That is right for a reconnect — the body never left the world and re-applying
 * the file would roll the evening back to the last save — and wrong for a swap.
 *
 * So the allocator did its job, `openCharacter` bound `chr_0002`, no file
 * existed so `restore` was null, and then the LIVE body was reattached and the
 * next autosave wrote it into `chr_0002.json`.
 *
 * ═══ AND THE HALF NOBODY SAW, WHICH IS THE WORSE ONE ═══
 * `restore` was discarded on that same branch, so picking an EXISTING character
 * kept the body you were already playing, bound it to the other character's
 * file, and overwrote that character with this one on the first autosave. The
 * duplicate rows were visible. This was not, and it destroys a save.
 *
 * ═══ WHY THESE TESTS DRIVE THE REAL SOCKET ═══
 * The bug is in the hello fork — the id allocator, the persist bridge and the
 * save store were all behaving correctly on their own, and a test of any one of
 * them passes while the game duplicates characters. The only place the defect
 * exists is the order these parts run in.
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
  forget(): void;
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
    /**
     * DROP EVERYTHING SEEN SO FAR. The swap is a SECOND hello on the SAME
     * socket, so every frame this test cares about afterwards has an identical
     * twin from the first pass sitting in front of it — and `waitFor` would
     * hand back the stale one and pass while nothing had happened.
     */
    forget: (): void => {
      frames = [];
    },
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
  store: SaveStore;
  actorCount: () => number;
  close: () => Promise<void>;
};

let harness: Harness | undefined;
let root: string | undefined;

async function start(): Promise<Harness> {
  root = await mkdtemp(join(tmpdir(), 'inner-datum-swap-'));
  const app = Fastify({ logger: false });
  const talents = createContentTalentEngine();
  const realms = createRealms({
    seed: 'character-swap',
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
    store,
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

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *   A SWAP IS A NEW SOCKET, BECAUSE THAT IS WHAT THE CLIENT DOES.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `handleHello` refuses a second hello on a connection that already completed
 * one — *"hello has already been completed"* — and the client obeys that by
 * dropping the socket and reconnecting (`socket.rehandshake`, which also drops
 * the resume token on purpose so the server is not asked to hand back the body
 * being walked away from).
 *
 * SO THE OLD BODY IS STILL IN THE WORLD WHEN THE SWAP ARRIVES, sitting out its
 * reconnect grace, and that is exactly the state the bug lived in: the new
 * socket verifies as the same account, `resolveActor` finds that body, and
 * hands it back wearing a different character's id. A test that reused one
 * socket would never reach the branch.
 */
async function createCharacter(
  port: number,
  pick: number,
): Promise<{ client: Client; classId: string }> {
  const client = await connect(port);
  client.send({ t: 'hello', sessionId: HANDLE, newCharacter: true });
  const offered = await client.waitFor('class_options');
  const options = (offered?.['options'] ?? []) as { id: string }[];
  const chosen = options[pick]?.id;
  if (chosen === undefined) throw new Error('the server offered no class to choose');
  client.send({ t: 'choose_class', classId: chosen });
  await client.settle();
  return { client, classId: chosen };
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * DRAIN THE WRITE QUEUE, THEN READ. Never a sleep, and never a poll either.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ═══ TWO WRONG ANSWERS CAME BEFORE THIS ONE ═══
 * First a fixed `sleep(120)` — a bet that the server would notice a disconnect
 * and flush within 120ms. It won alone and lost under `npm run check`, where
 * tsc and eslint run beside the suite, reporting "two characters were created
 * and the store does not have two": a message that reads like a broken create
 * path and is not one.
 *
 * Then POLLING `listCharacters` until the row appeared, which is better and
 * still wrong. It waits for a symptom of the write rather than the write, so it
 * returns at the FIRST of several — and a disconnect produces more than one.
 * The test that snapshots a character's bytes then compares them to the retired
 * copy failed on 14ms of `updatedAt` because a second write landed in the gap.
 *
 * `store.flush()` is the actual answer and was there the whole time: it
 * alternates draining the debounce timers and awaiting the writes in flight,
 * so when it returns there is nothing left to land. No deadline, no sampling
 * window, and nothing that gets slower on a loaded machine.
 *
 * The general lesson, which cost two rounds to learn: when a test is racing a
 * queue, drain the queue. Waiting for evidence that the queue moved is a
 * different and weaker claim.
 */
async function settled(
  h: Harness,
  expected = 1,
  timeoutMs = 5000,
): Promise<Awaited<ReturnType<Harness['store']['listCharacters']>>> {
  /**
   * ═══ BOTH HALVES, AND EACH ONE ALONE WAS SHIPPED AND WAS WRONG ═══
   *
   * WAIT FIRST, because a disconnect's save is queued by the gateway's CLOSE
   * HANDLER, and that handler has not necessarily run when a test reaches this
   * line. `flush` on its own drains an empty queue, returns honestly, and the
   * write lands afterwards — which failed as "two characters were not created",
   * a message that reads like a broken create path and is not one.
   *
   * FLUSH SECOND, because arriving is not the same as finishing: the row can be
   * listed while another write for the same character is still pending, and a
   * test that then reads the file's BYTES compares against a copy that is about
   * to change.
   *
   * The polling loop waits for the write to be QUEUED AND VISIBLE; the flush
   * waits for everything queued to be DONE. Neither answers the other's
   * question, which is why both are here.
   */
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = await h.store.listCharacters(REN);
    if (rows.length >= expected || Date.now() > deadline) break;
    await sleep(10);
  }
  await h.store.flush();
  return h.store.listCharacters(REN);
}

describe('changing character', () => {
  it('makes a NEW character rather than a copy of the one being played', async () => {
    harness = await start();
    const client = await connect(harness.port);

    client.send({ t: 'hello', sessionId: HANDLE });
    expect(await client.waitFor('roster'), 'no roster was offered').toBeDefined();

    // ═══ THE SETUP HAS TO HAVE WORKED BEFORE THE CLAIM MEANS ANYTHING ═══
    // Two DIFFERENT classes, asserted distinct here, because the whole test is
    // "these two rows differ" and two picks that happened to be the same class
    // would fail for a reason that has nothing to do with the bug.
    const first = await createCharacter(harness.port, 0);
    first.client.close();
    const second = await createCharacter(harness.port, 1);
    expect(second.classId, 'the two picks were the same class').not.toBe(first.classId);

    // Let the debounced autosave land for the second body.
    const rows = await settled(harness, 2);
    expect(rows, 'two characters were created and the store does not have two').toHaveLength(2);

    // ═══ THE ASSERTION THAT WAS FAILING ═══
    // Before the fix both rows read the same class — the screenshot's three
    // identical Alchemists — because the live body was reattached and written
    // into the new character's file.
    const classes = rows.map((row) => row.classId);
    expect(
      new Set(classes).size,
      `both characters saved as the same class: ${classes.join(', ')}`,
    ).toBe(2);
  });

  it('leaves exactly one body in the world, because you play one at a time', async () => {
    harness = await start();
    const before = harness.actorCount();
    const client = await connect(harness.port);

    client.send({ t: 'hello', sessionId: HANDLE });
    await client.waitFor('roster');
    client.close();
    const first = await createCharacter(harness.port, 0);
    expect(harness.actorCount(), 'the first character put no body in the world').toBe(before + 1);

    first.client.close();
    await createCharacter(harness.port, 1);
    /**
     * NOT `before + 2`. The retired body is removed from the world before the
     * new one is placed — a body left standing while its player is somebody
     * else is something a monster can walk up to, and it would also be the
     * thing `resolveActor` finds on the NEXT swap.
     */
    expect(harness.actorCount(), 'the old body was left standing in the world').toBe(before + 1);
  });

  it('gives a character back unchanged after playing a different one', async () => {
    harness = await start();
    const client = await connect(harness.port);

    client.send({ t: 'hello', sessionId: HANDLE });
    await client.waitFor('roster');
    client.close();
    const first = await createCharacter(harness.port, 0);
    first.client.close();
    const second = await createCharacter(harness.port, 1);
    expect(second.classId).not.toBe(first.classId);
    const firstClass = first.classId;
    const secondClass = second.classId;
    const rows = await settled(harness, 2);
    const original = rows.find((row) => row.classId === firstClass);
    expect(original, 'the first character is not in the store at all').toBeDefined();
    if (original === undefined) return;

    // ═══ GO BACK TO THE FIRST ONE, BY ID, THE WAY THE SCREEN DOES ═══
    second.client.close();
    const back = await connect(harness.port);
    back.send({ t: 'hello', sessionId: HANDLE, characterId: original.id });
    const welcome = await back.waitFor('welcome');
    expect(welcome, 'selecting a saved character never entered the world').toBeDefined();
    await back.settle();
    await sleep(120);

    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE HALF THAT DESTROYS A SAVE.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * The identity branch returned the standing body and never reached
     * `applyRestore`, so selecting this character handed back the body of the
     * OTHER one — and the next autosave wrote that body into this character's
     * file. The row would flip to the second class and the first character
     * would be gone, with no message anywhere saying so.
     */
    const after = await harness.store.listCharacters(REN);
    const reopened = after.find((row) => row.id === original.id);
    expect(reopened?.classId, 'selecting a character overwrote it with the one being played').toBe(
      firstClass,
    );
    // AND THE OTHER ONE IS STILL THERE, unharmed by being walked away from.
    expect(after.map((row) => row.classId).sort()).toEqual([firstClass, secondClass].sort());
  });
});
