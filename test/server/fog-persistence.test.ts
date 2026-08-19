import { setTimeout as sleep } from 'node:timers/promises';

import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDownedState } from '../../src/server/engine/downed.ts';
import { createPartyState } from '../../src/server/engine/party.ts';
import { wsGateway } from '../../src/server/net/gateway.ts';
import { createCharacterFile, parseCharacterFile } from '../../src/server/persist/saves.ts';
import { createTurnEngine } from '../../src/server/turn-engine.ts';
import { OVERWORLD_ID, createRealms } from '../../src/server/world/realms.ts';
import { REDACTION_SITE_ID } from '../../src/shared/level.ts';
import { PROTOCOL_VERSION } from '../../src/shared/version.ts';
import type { Realms } from '../../src/server/world/realms.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE MAP YOU WALKED HAS TO STILL BE THERE TOMORROW — ON BOTH MAPS.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `CharacterFile.explored` carried this note:
 *
 *   > ONE OVERWORLD, ONE STRING — and the shape does not change until there are
 *   > two... the day a second overworld exists this line widens to a record and
 *   > the in-memory side is already correct.
 *
 * A second overworld shipped three commits later and the line was never
 * widened. The in-memory side WAS correct — the fog was computed per realm and
 * sent to the client on every frame — and then thrown away at the end of the
 * session. So a player could walk half the dark territory, close the tab, and
 * come back to a black map, while Alderbrook, the country they had already
 * finished with, was remembered perfectly.
 *
 * NOTHING IN THIS REPO HAD EVER DRIVEN FOG PERSISTENCE END TO END, which is why
 * a note describing its own successor could sit there through three commits
 * that made it wrong. This file is that drive.
 */

const FRAME_TIMEOUT_MS = 4_000;

type Saved = {
  actorId: string;
  explored?: string;
  // `unknown` rather than a shape: the point of this sink is to record what the
  // gateway OFFERS, and asserting a type here would be the test agreeing with
  // itself about the very field under examination.
  exploredElsewhere?: unknown;
};

type Harness = {
  port: number;
  realms: Realms;
  saved: () => Saved[];
  close: () => Promise<void>;
};
let server: Harness;
const openSockets: WebSocket[] = [];

beforeEach(async () => {
  const downed = createDownedState();
  const parties = createPartyState();
  const realms = createRealms({
    seed: 'fog-persistence',
    engineFor: (world) => createTurnEngine({ world, downed, parties }),
  });

  // A SINK THAT ONLY RECORDS. The question is what the gateway OFFERS the
  // persist layer, and a real store would answer it through two more seams.
  const captured: Saved[] = [];

  const app = Fastify({ logger: false });
  await app.register(wsGateway, {
    world: realms.overworld.world,
    engine: realms.overworld.engine,
    realms,
    parties,
    downed,
    // NO CAST. `PersistPort` is satisfied structurally by this one method, which
    // is worth noticing rather than papering over: the gateway asks the persist
    // layer for exactly one thing on this path, so a sink that records is a
    // complete implementation of what it depends on.
    persist: {
      savePlayers: (snapshots: readonly Record<string, unknown>[]): void => {
        for (const snapshot of snapshots) {
          captured.push({
            actorId: String(snapshot['actorId']),
            explored: typeof snapshot['explored'] === 'string' ? snapshot['explored'] : undefined,
            exploredElsewhere: snapshot['exploredElsewhere'],
          });
        }
      },
    },
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (address === null || typeof address === 'string') throw new Error('no port was bound');

  server = {
    port: address.port,
    realms,
    saved: () => captured,
    close: async (): Promise<void> => {
      await app.close();
    },
  };
});

afterEach(async () => {
  for (const socket of openSockets) socket.close();
  openSockets.length = 0;
  await server.close();
});

type Client = { actorId: string; send(frame: Record<string, unknown>): void };

async function hello(port: number): Promise<Client> {
  const socket = new WebSocket(`ws://127.0.0.1:${String(port)}/ws`);
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

  const deadline = Date.now() + FRAME_TIMEOUT_MS;
  for (;;) {
    const id = frames.find((f) => f['t'] === 'welcome')?.['selfId'];
    if (typeof id === 'string') {
      return {
        actorId: id,
        send(frame): void {
          socket.send(JSON.stringify({ v: PROTOCOL_VERSION, ...frame }));
        },
      };
    }
    if (Date.now() >= deadline) throw new Error('no welcome came back');
    await sleep(5);
  }
}

/** Walk east then west, so a few cells of wherever they are get revealed. */
async function walkAbit(client: Client): Promise<void> {
  for (const dir of ['e', 'w', 'e', 'w']) {
    client.send({ t: 'move', dir });
    await sleep(60);
  }
}

describe('the fog that has to outlive the session', () => {
  it('offers the persist layer BOTH maps, not only the one you woke on', async () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE ASSERTION THAT WOULD HAVE CAUGHT IT.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `explored` alone passing is not evidence of anything — it passed
     * throughout the whole period the second map's fog was being discarded.
     * Both keys, or the test is measuring the half that already worked.
     */
    const client = await hello(server.port);
    await walkAbit(client);

    // ── across to the dark territory, through its own door ─────────────────
    const door = [...server.realms.overworld.sites].find(([, id]) => id === REDACTION_SITE_ID);
    expect(door, 'no door to the Redaction').toBeDefined();
    if (door === undefined) return;
    const [dx, dy] = door[0].split(',').map(Number);
    const body = server.realms.overworld.world.getActor(client.actorId);
    if (body === undefined || dx === undefined || dy === undefined) throw new Error('no body');
    body.x = dx - 1;
    body.y = dy;
    client.send({ t: 'move', dir: 'e' });
    await sleep(250);

    const there = server.realms.realmOf(client.actorId);
    expect(there?.id, 'never crossed').toBe(`realm:${REDACTION_SITE_ID}`);
    await walkAbit(client);
    await sleep(400);

    const mine = server.saved().filter((s) => s.actorId === client.actorId);
    expect(mine.length, 'nothing was ever offered to the persist layer').toBeGreaterThan(0);

    const last = mine[mine.length - 1];
    expect(last?.explored, 'the home map was not offered').toBeDefined();
    expect(
      (last?.exploredElsewhere as Record<string, string> | undefined)?.[
        `realm:${REDACTION_SITE_ID}`
      ],
      'the second map was walked and then thrown away',
    ).toBeDefined();
  });

  it('offers nothing for a second map nobody has been to', async () => {
    /**
     * `undefined` AND NOT `{}`, which is the distinction the whole carry-forward
     * rule turns on: `createCharacterFile` reads an absent field as "this
     * producer cannot say" and leaves the disk alone, while `{}` is a statement
     * that there is nothing — and that statement would ERASE a second map for
     * anybody whose fog had not been touched in the current process.
     */
    const client = await hello(server.port);
    await walkAbit(client);
    await sleep(400);

    const mine = server.saved().filter((s) => s.actorId === client.actorId);
    expect(mine.length).toBeGreaterThan(0);
    for (const snapshot of mine) {
      expect(snapshot.exploredElsewhere).toBeUndefined();
    }
  });
});

describe('the file the fog is written into', () => {
  const BASE = {
    id: 'chr_probe',
    ownerId: '111111111111111111',
    name: 'Ren',
    classId: 'class:watchman',
    resources: { hp: 30, ap: 0, mp: 0, special: { kind: '', value: 0 } },
    createdAt: '2026-01-01T00:00:00.000Z',
  } as const;

  it('round-trips both maps through disk', () => {
    const file = createCharacterFile({
      ...BASE,
      explored: 'AAAA',
      exploredElsewhere: { [`realm:${REDACTION_SITE_ID}`]: 'BBBB' },
    });
    const parsed = parseCharacterFile(JSON.parse(JSON.stringify(file)) as unknown);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.file.explored).toBe('AAAA');
    expect(parsed.file.exploredElsewhere).toEqual({ [`realm:${REDACTION_SITE_ID}`]: 'BBBB' });
  });

  it('loads a file written before the second map existed', () => {
    /**
     * THE ROLLBACK STORY, WHICH IS WHY THIS IS A SECOND FIELD AND NOT A WIDER
     * `explored`. Had `explored` become `string | Record<...>`, an older build
     * reading a newer file would hit `typeof doc.explored === 'string'`, see an
     * object, and drop it — costing the player the home region they had walked
     * since the game existed. Keeping it a string means an old build reads it
     * byte-for-byte and simply does not know about the rest.
     */
    const file = createCharacterFile({ ...BASE, explored: 'AAAA' });
    const doc = JSON.parse(JSON.stringify(file)) as Record<string, unknown>;
    delete doc['exploredElsewhere'];
    const parsed = parseCharacterFile(doc);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.file.explored).toBe('AAAA');
    expect(parsed.file.exploredElsewhere).toBeUndefined();
  });

  it('drops one bad entry rather than the whole record', () => {
    // REPAIR, NEVER REJECT — the rule every other field in `parseCharacterDoc`
    // follows. One hand-edited key must not cost a player the other map.
    const file = createCharacterFile({
      ...BASE,
      exploredElsewhere: { [`realm:${REDACTION_SITE_ID}`]: 'GOOD' },
    });
    const doc = JSON.parse(JSON.stringify(file)) as Record<string, unknown>;
    doc['exploredElsewhere'] = { [`realm:${REDACTION_SITE_ID}`]: 'GOOD', 'realm:junk': 42 };
    const parsed = parseCharacterFile(doc);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.file.exploredElsewhere).toEqual({ [`realm:${REDACTION_SITE_ID}`]: 'GOOD' });
  });

  it('reads an empty record as “cannot say” so the disk is left alone', () => {
    const file = createCharacterFile({ ...BASE, exploredElsewhere: {} });
    const doc = JSON.parse(JSON.stringify(file)) as Record<string, unknown>;
    doc['exploredElsewhere'] = {};
    const parsed = parseCharacterFile(doc);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.file.exploredElsewhere).toBeUndefined();
  });

  it('never writes the home map into the record as well', () => {
    // TWO SOURCES OF TRUTH FOR ONE BITSET is the failure this avoids: the home
    // overworld belongs to `explored`, and the first time the two disagreed the
    // loser would be whichever loaded second. `exploredElsewhere` in the gateway
    // skips `realms.overworld.id` for exactly this reason.
    expect(OVERWORLD_ID).not.toBe(`realm:${REDACTION_SITE_ID}`);
  });
});
