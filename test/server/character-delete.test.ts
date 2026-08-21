// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
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
import {
  RetireOutcome,
  createCharacterBridge,
  createSaveStore,
} from '../../src/server/persist/saves.ts';
import { createTurnEngine } from '../../src/server/turn-engine.ts';
import { createRealms } from '../../src/server/world/realms.ts';
import { PROTOCOL_VERSION } from '../../src/shared/version.ts';
import type { IdentityPort } from '../../src/server/net/gateway.ts';
import type { CharacterFile, SaveStore } from '../../src/server/persist/saves.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *   DELETING A CHARACTER, ON A SERVER THAT HOLDS THE ONLY COPY.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The select screen could hold eight characters and had no way to hold seven,
 * which mattered the moment a swap bug produced three copies of the same one.
 *
 * ═══ THE CONSTRAINT THAT SHAPED ALL OF THIS ═══
 * Before `retireCharacter`, NOTHING IN THIS PROJECT DELETED PLAYER DATA. The
 * persist layer imported `readFile` and `readdir` and nothing else, and its own
 * log lines twice tell a human to *"move the file aside by hand"*. This is a
 * self-hosted server in somebody's house holding the only copy of a friend's
 * character, with no backup tier and no undo anywhere in the product.
 *
 * So the delete is a RENAME, and the tests below are mostly about that being
 * true rather than about the row disappearing — the row disappearing is the
 * easy half and the half a careless implementation also gets right.
 */
const REN = '284739201847583744';
const MAB = '119284736152947200';
const HANDLE = 'ren-handle';
const HANDLE_MAB = 'mab-handle';

function identityPort(): IdentityPort {
  return {
    get: (id: string | undefined) => {
      if (id === HANDLE) return { user: { id: REN }, displayName: 'Ren' };
      if (id === HANDLE_MAB) return { user: { id: MAB }, displayName: 'Mab' };
      return undefined;
    },
  };
}

type Frame = Record<string, unknown>;

type Client = {
  send(frame: Frame): void;
  waitFor(type: string, timeoutMs?: number): Promise<Frame | undefined>;
  latest(type: string): Frame | undefined;
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
    latest: (type: string): Frame | undefined => frames.filter((f) => f['t'] === type).at(-1),
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
  root: string;
  close: () => Promise<void>;
};

let harness: Harness | undefined;
let root: string | undefined;

async function start(): Promise<Harness> {
  root = await mkdtemp(join(tmpdir(), 'inner-datum-delete-'));
  const app = Fastify({ logger: false });
  const talents = createContentTalentEngine();
  const realms = createRealms({
    seed: 'character-delete',
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
    root,
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

/** Make a character on its own socket, the way the client does. */
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

const ownerDir = (h: Harness, owner: string): string => join(h.root, 'characters', owner);

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WAIT UNTIL THE STORE HOLDS `n` CHARACTERS. Never a fixed sleep.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ═══ THE FLAKE THIS REPLACES ═══
 * Every one of these tests used to close a socket, `await sleep(140)`, and read
 * the store — betting that 140ms was long enough for the server to notice the
 * disconnect and flush the character to disk. In isolation that bet always won.
 * Under `npm run check`, where tsc and eslint are running beside the suite, it
 * lost often enough to fail a gate run, reporting "two characters were not
 * created" — which reads exactly like a broken create path and is not one.
 *
 * ═══ POLLING IS NOT A LONGER SLEEP ═══
 * A fixed sleep encodes a guess about the machine. This encodes the CONDITION,
 * so it returns the moment the write lands and is correct on a fast machine and
 * a loaded one alike. The suite also gets faster, since the common case no
 * longer pays 140ms it did not need.
 *
 * ═══ AND IT RETURNS ON TIMEOUT RATHER THAN THROWING ═══
 * A helper that threw would report its own deadline as the failure. Returning
 * whatever the store has lets the caller's assertion — which knows what it
 * wanted and why — print the real problem.
 */
async function waitForCharacters(
  h: Harness,
  owner: string,
  n: number,
  timeoutMs = 5000,
): Promise<Awaited<ReturnType<Harness['store']['listCharacters']>>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = await h.store.listCharacters(owner);
    if (rows.length >= n || Date.now() > deadline) return rows;
    await sleep(10);
  }
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * AND THEN WAIT FOR THE WRITING TO STOP. Appearing is not the same as settled.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A disconnect produces MORE THAN ONE WRITE — the character lands, and then the
 * teardown writes it again a few milliseconds later. `waitForCharacters` above
 * returns at the first of those, which is right for a test that only wants the
 * row to exist and wrong for one that reads the file's BYTES: `renames the file
 * aside` snapshots the file, deletes, and compares the retired copy against the
 * snapshot, so a second write landing in between changes `updatedAt` and the
 * comparison fails on a 14ms difference.
 *
 * The old `sleep(140)` hid this by being longer than the whole sequence. That
 * is worth stating plainly, because it is the general case: a fixed sleep does
 * not just make a test slow and occasionally flaky, it silently supplies a
 * condition nobody ever wrote down. Replacing it with the wrong condition turns
 * an intermittent failure into a reliable one — which is how this got found.
 *
 * TWO IDENTICAL READS IN A ROW is the settle test. `updatedAt` moves on every
 * write, so two matching samples 10ms apart mean nothing is still writing.
 */
async function waitForSettled(h: Harness, owner: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  for (;;) {
    const rows = await h.store.listCharacters(owner);
    const stamp = rows.map((r) => `${r.id}:${String(r.updatedAt ?? '')}`).join('|');
    if ((stamp === last && stamp !== '') || Date.now() > deadline) return;
    last = stamp;
    await sleep(10);
  }
}

describe('deleting a character', () => {
  it('takes the row off the roster and answers with the list itself', async () => {
    harness = await start();
    const first = await createCharacter(harness.port, 0);
    first.client.close();
    const second = await createCharacter(harness.port, 1);
    second.client.close();
    const before = await waitForCharacters(harness, REN, 2);
    expect(before, 'two characters were not created').toHaveLength(2);
    const doomed = before[1];
    expect(doomed).toBeDefined();
    if (doomed === undefined) return;

    const menu = await connect(harness.port);
    menu.send({ t: 'hello', sessionId: HANDLE });
    expect(await menu.waitFor('roster')).toBeDefined();

    menu.forget();
    menu.send({ t: 'delete_character', characterId: doomed.id });

    /**
     * THE ANSWER IS THE ROSTER, NOT AN ACK. A screen that always shows the truth
     * needs no separate vocabulary for a delete having happened.
     */
    const after = await menu.waitFor('roster');
    expect(after, 'the delete was never answered').toBeDefined();
    const rows = (after?.['characters'] ?? []) as { id: string }[];
    expect(
      rows.map((r) => r.id),
      'the deleted character is still on the roster',
    ).not.toContain(doomed.id);
    expect(rows).toHaveLength(1);
  });

  it('renames the file aside instead of destroying it', async () => {
    harness = await start();
    const made = await createCharacter(harness.port, 0);
    made.client.close();
    const [row] = await waitForCharacters(harness, REN, 1);
    expect(row).toBeDefined();
    if (row === undefined) return;

    // THE BYTES ARE THE SUBJECT HERE, so wait for the writing to stop and not
    // merely for the row to appear. See waitForSettled.
    await waitForSettled(harness, REN);
    const before = await readdir(ownerDir(harness, REN));
    const live = before.find((f) => f === `${row.id}.json`);
    expect(live, 'the character file is not where the store says it is').toBeDefined();
    const bytes = await readFile(join(ownerDir(harness, REN), `${row.id}.json`), 'utf8');
    expect(bytes.length, 'the character file is empty').toBeGreaterThan(0);

    const result = await harness.store.retireCharacter(REN, row.id);
    expect(result.outcome).toBe(RetireOutcome.Retired);

    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE ASSERTION THIS WHOLE FILE EXISTS FOR.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * An `unlink` passes every other test here. This is the one it cannot pass:
     * the bytes are still on disk, under a name that does not end in `.json`,
     * which is exactly what makes them invisible to `listCharacters` and
     * recoverable by a human with a rename.
     */
    const after = await readdir(ownerDir(harness, REN));
    expect(after, 'the live file is still there').not.toContain(`${row.id}.json`);
    const tomb = after.find((f) => f.startsWith(`${row.id}.json.retired-`));
    expect(
      tomb,
      `nothing was renamed aside; the directory holds ${after.join(', ')}`,
    ).toBeDefined();
    if (tomb === undefined) return;
    expect(
      await readFile(join(ownerDir(harness, REN), tomb), 'utf8'),
      'the retired file is not the character that was deleted',
    ).toBe(bytes);
  });

  it('refuses to delete a character somebody is playing', async () => {
    harness = await start();
    // LEFT CONNECTED, so this character has a body in the world and a binding.
    const playing = await createCharacter(harness.port, 0);
    const [row] = await waitForCharacters(harness, REN, 1);
    expect(row).toBeDefined();
    if (row === undefined) return;

    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THROUGH THE SOCKET, BECAUSE THE REFUSAL IS NOT THE STORE'S TO MAKE.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * The store has files and a write queue and no idea that one of those files
     * is attached to a living body that will autosave over the answer three
     * seconds from now. `bindings` is that knowledge and it lives on the bridge,
     * so a test that called `store.retireCharacter` directly would be asserting
     * about the wrong layer and would pass whether or not the guard existed.
     *
     * A SECOND SOCKET ON THE SAME ACCOUNT is exactly how a player reaches this:
     * one tab playing, one tab on the select screen.
     */
    const menu = await connect(harness.port);
    menu.send({ t: 'hello', sessionId: HANDLE });
    expect(await menu.waitFor('roster'), 'the second socket got no roster').toBeDefined();
    menu.forget();
    menu.send({ t: 'delete_character', characterId: row.id });
    const answer = await menu.waitFor('roster');
    expect(answer, 'the refused delete was never answered').toBeDefined();

    const rows = (answer?.['characters'] ?? []) as { id: string }[];
    expect(
      rows.map((r) => r.id),
      'a character was deleted out from under the body playing it',
    ).toContain(row.id);
    expect(await harness.store.listCharacters(REN)).toHaveLength(1);
    playing.client.close();
  });

  it('cannot be talked into deleting somebody else’s character', async () => {
    harness = await start();
    const rens = await createCharacter(harness.port, 0);
    rens.client.close();
    const [row] = await waitForCharacters(harness, REN, 1);
    expect(row).toBeDefined();
    if (row === undefined) return;

    // Mab connects, and asks for the id Ren is using.
    const mab = await connect(harness.port);
    mab.send({ t: 'hello', sessionId: HANDLE_MAB });
    expect(await mab.waitFor('roster')).toBeDefined();
    mab.forget();
    mab.send({ t: 'delete_character', characterId: row.id });
    await mab.waitFor('roster');
    await sleep(120);

    /**
     * ═══ THE OWNER IS NOT ON THE WIRE, SO THIS CANNOT EVEN BE EXPRESSED ═══
     * The frame names a character and nothing else; the owner is re-derived
     * from Mab's verified session. So the id lands in MAB's directory, where
     * there is no such file, and Ren's character is untouched.
     */
    const survivors = await harness.store.listCharacters(REN);
    expect(
      survivors.map((r) => r.id),
      'another account deleted a character it does not own',
    ).toContain(row.id);
  });

  it('refuses an id that tries to climb out of the store', async () => {
    harness = await start();
    /**
     * A CANARY ONE DIRECTORY ABOVE THE ROOT, which is the shape
     * test/server/saves-identity.test.ts uses for the same class of attack. A
     * delete is the operation where a traversal does not merely read or
     * overwrite something outside the store — it MOVES it, and the original
     * name is gone.
     */
    const canary = join(harness.root, '..', `canary-${String(process.pid)}.json`);
    await writeFile(canary, 'do not move me', 'utf8');
    try {
      for (const hostile of ['../../canary', '..\\..\\canary', '../../../etc/passwd', '', '.']) {
        const result = await harness.store.retireCharacter(REN, hostile);
        expect(result.outcome, `a hostile id was accepted: ${hostile}`).toBe(
          RetireOutcome.Rejected,
        );
      }
      expect(await readFile(canary, 'utf8'), 'the canary moved').toBe('do not move me');
    } finally {
      await rm(canary, { force: true });
    }
  });

  it('treats a character that is already gone as done, not as an error', async () => {
    harness = await start();
    const made = await createCharacter(harness.port, 0);
    made.client.close();
    const [row] = await waitForCharacters(harness, REN, 1);
    expect(row).toBeDefined();
    if (row === undefined) return;

    expect((await harness.store.retireCharacter(REN, row.id)).outcome).toBe(RetireOutcome.Retired);
    /**
     * A ROW CLICKED TWICE, or two tabs on the same account. The caller asked for
     * a state — "this character is not in my list" — and that state holds.
     */
    expect((await harness.store.retireCharacter(REN, row.id)).outcome).toBe(RetireOutcome.Absent);
  });

  it('is not undone by an autosave that was already ticking', async () => {
    harness = await start();
    const made = await createCharacter(harness.port, 0);
    made.client.close();
    const [row] = await waitForCharacters(harness, REN, 1);
    expect(row).toBeDefined();
    if (row === undefined) return;

    const file = await readFile(join(ownerDir(harness, REN), `${row.id}.json`), 'utf8');
    const doc = JSON.parse(file) as Record<string, unknown>;

    // ARM A DEBOUNCED WRITE, then delete before it lands. `scheduleCharacter`
    // derives its path from the file's own `ownerId`/`id`, so the round-tripped
    // document targets exactly the path about to be renamed.
    harness.store.scheduleCharacter(doc as unknown as CharacterFile);
    expect(harness.store.pendingCount(), 'nothing was actually scheduled').toBeGreaterThan(0);

    expect((await harness.store.retireCharacter(REN, row.id)).outcome).toBe(RetireOutcome.Retired);

    // WELL PAST THE 5ms DEBOUNCE. If the timer survived, the file is back.
    await sleep(120);
    const after = await readdir(ownerDir(harness, REN));
    expect(after, 'a pending autosave wrote the character back after it was deleted').not.toContain(
      `${row.id}.json`,
    );
  });
});
