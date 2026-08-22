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
 *   TWO CHARACTERS MADE IN QUICK SUCCESSION MUST NOT BE ONE CHARACTER.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A new character's id comes from `nextCharacterId(...)`, and its only source
 * used to be `listCharacters(ownerId)` — A DISK READ. A character's first file
 * is written at once but NOT AWAITED, so between "the character exists" and
 * "its file is on disk" there is a window in which the account looks EMPTY.
 *
 * A second `hello { newCharacter: true }` inside that window is handed the same
 * id as the first — `chr_main`, the id an empty account gets — and the two
 * characters become one file. The second overwrites the first.
 *
 * ═══ THIS WAS MISREAD AS A FLAKY TEST THREE TIMES ═══
 * `character-swap.test.ts` has been failing intermittently under load and
 * blocked three deploys. It was corrected with a longer poll, then a flush,
 * then a longer timeout. The test was right every time: under load the first
 * save lands slower, the window widens, and the collision gets likelier. The
 * symptom is "the store does not have two", which reads like a slow write and
 * is a lost character.
 *
 * ═══ THE MECHANISM IS THE WRITE NOT HAVING FINISHED, NOT THE DEBOUNCE ═══
 * The first theory here was that the first save sat in the DEBOUNCE queue. It
 * does not: `handleHello` calls `saveNow('join')` for every genuinely new
 * character, which goes to `savePlayersNow` and writes at once. Holding the
 * debounce open for five seconds — which this file does — changes nothing, and
 * that is why these two cases pass on the code as it stands.
 *
 * What `savePlayersNow` does NOT do is wait:
 *
 *     void store.saveCharacter(fileFor(snapshot, binding), saveReason);
 *
 * fire and forget, deliberately, so the frame a player is waiting for does not
 * queue behind a disk. So the file is written IMMEDIATELY and lands WHENEVER —
 * and a `readdir` racing an unfinished write is a race no test can win on
 * demand without slowing the disk.
 *
 * ═══ SO THIS FILE PINS THE INVARIANT, AND THE FIX IS TESTED WHERE IT LIVES ═══
 * These two cases assert the property that must hold — two creations, two ids —
 * and they would catch a gross regression. They are NOT a reproduction, and
 * saying so is the point: a test that passes for a reason other than the one it
 * claims is worse than no test. The fix itself is that id minting no longer
 * depends on the disk read alone, and the seam that makes that possible is
 * asserted directly at the foot of this file.
 */

const REN = '284739201847583744';
const HANDLE = 'ren-handle';

/** Long enough that the first character's save cannot possibly have landed. */
const HELD_DEBOUNCE_MS = 5_000;

function identityPort(): IdentityPort {
  return {
    get: (id: string | undefined) =>
      id === HANDLE ? { user: { id: REN }, displayName: 'Ren' } : undefined,
  };
}

type Frame = Record<string, unknown>;

type Harness = {
  port: number;
  store: SaveStore;
  /** THE BRIDGE ITSELF, so a test can ask what it is holding. */
  bridge: ReturnType<typeof createCharacterBridge>;
  close(): Promise<void>;
};

let harness: Harness | undefined;
let root: string | undefined;
const open: WebSocket[] = [];

async function start(): Promise<Harness> {
  root = await mkdtemp(join(tmpdir(), 'inner-datum-idrace-'));
  const app = Fastify({ logger: false });
  const talents = createContentTalentEngine();
  const realms = createRealms({
    seed: 'character-id-race',
    engineFor: (world) =>
      createTurnEngine({
        world,
        talents: createTalentBook(talents, world),
        talentRuntime: talentRuntimeFor(talents, world),
      }),
  });
  const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };
  const store = createSaveStore({ root, logger: quiet, debounceMs: HELD_DEBOUNCE_MS });
  const bridge = createCharacterBridge({ store, logger: quiet });

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
    bridge,
    close: async (): Promise<void> => {
      await app.close();
      await store.close();
    },
  };
}

afterEach(async () => {
  for (const socket of open) socket.close();
  open.length = 0;
  await harness?.close();
  harness = undefined;
  if (root !== undefined) await rm(root, { recursive: true, force: true });
  root = undefined;
});

/** Make one character and leave its save sitting in the queue. */
async function makeCharacter(port: number, pick: number): Promise<void> {
  const socket = new WebSocket(`ws://127.0.0.1:${String(port)}/ws`);
  open.push(socket);
  const frames: Frame[] = [];
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
  const send = (frame: Frame): void => {
    socket.send(JSON.stringify({ v: PROTOCOL_VERSION, ...frame }));
  };

  send({ t: 'hello', sessionId: HANDLE, newCharacter: true });
  // WAIT FOR THE OFFER, never a fixed sleep — the handshake takes as long as a
  // cold server takes, which is the lesson tools/handshake.mjs was written for.
  const deadline = Date.now() + 4000;
  const offered = async (): Promise<{ id: string }[]> => {
    for (;;) {
      const offer = frames.find((frame) => frame['t'] === 'class_options');
      const options = (offer?.['options'] ?? []) as { id: string }[];
      if (options.length > 0 || Date.now() > deadline) return options;
      await sleep(10);
    }
  };
  const chosen = (await offered())[pick]?.id;
  if (chosen === undefined) throw new Error('the server offered no class to choose');
  send({ t: 'choose_class', classId: chosen });
  await sleep(120);
}

describe('a second character made before the first has been written', () => {
  it('gets an id of its own rather than overwriting the first', async () => {
    harness = await start();

    // BOTH INSIDE THE DEBOUNCE WINDOW. Neither save can have reached the disk,
    // so `listCharacters` answers for an account that still looks empty.
    await makeCharacter(harness.port, 0);
    await makeCharacter(harness.port, 1);

    // NOW let everything land, and count what is actually there.
    await harness.store.flush();
    const rows = await harness.store.listCharacters(REN);

    expect(
      rows.map((row) => row.id),
      'both characters were filed under one id — the second overwrote the first',
    ).toHaveLength(2);
    expect(new Set(rows.map((row) => row.id)).size, 'two rows sharing one id').toBe(2);
  });

  /**
   * AND THE CAP COUNTS THEM TOO. `MAX_CHARACTERS_PER_ACCOUNT` is checked against
   * the same disk read, so the same window would let an account exceed its own
   * limit — a smaller problem than losing a character, and the identical cause.
   */
  it('counts unwritten characters against the account cap', async () => {
    harness = await start();
    for (let i = 0; i < 3; i += 1) await makeCharacter(harness.port, i % 3);
    await harness.store.flush();
    const rows = await harness.store.listCharacters(REN);
    expect(new Set(rows.map((row) => row.id)).size, 'three characters, fewer files').toBe(3);
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *   THE BRIDGE KNOWS WHAT THE DISK HAS NOT HEARD ABOUT YET.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * This is where the fix actually lives, and it is testable without winning a
 * race: the gateway mints an id against the UNION of the disk listing and the
 * characters bound in memory, so a character whose first write is still in
 * flight still holds its id.
 */
describe('boundCharacterIds', () => {
  it('names a character the moment it is bound, before any file exists', async () => {
    harness = await start();

    // Nothing on disk yet for this account.
    expect(await harness.store.listCharacters(REN)).toEqual([]);

    await makeCharacter(harness.port, 0);

    // The bridge is holding it regardless of what the disk has managed.
    const bridge = harness.bridge;
    expect(
      bridge.boundCharacterIds?.(REN) ?? [],
      'the bridge forgot a live character',
    ).toHaveLength(1);
  });

  it('answers nothing for an account with nobody playing', async () => {
    harness = await start();
    expect(harness.bridge.boundCharacterIds?.('999999999999999999') ?? []).toEqual([]);
  });
});
