import { setTimeout as sleep } from 'node:timers/promises';

import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDownedState } from '../../src/server/engine/downed.ts';
import { createPartyState } from '../../src/server/engine/party.ts';
import { wsGateway } from '../../src/server/net/gateway.ts';
import { createTurnEngine } from '../../src/server/turn-engine.ts';
import { createRealms } from '../../src/server/world/realms.ts';
import { ALDERBROOK_REGIONS, canWalk, regionAt } from '../../src/shared/level.ts';
import { PROTOCOL_VERSION } from '../../src/shared/version.ts';
import type { Realms } from '../../src/server/world/realms.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE LINE ACTUALLY REACHES A CLIENT.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `regionAt` is pure and `test/shared/regions.test.ts` proves the table is
 * sound — but a correct table that no socket ever hears from is the failure this
 * project keeps finding in its own work: a status system with a hundred test
 * references and no production caller, a talent note whose only reference was
 * its setter, Sigil's mark projected nowhere. Every one of them passed its unit
 * tests.
 *
 * So this drives a real socket over a real gateway, walks a body across a real
 * boundary, and reads what came back down the wire.
 */

const FRAME_TIMEOUT_MS = 2_000;

type Frame = Record<string, unknown>;

type Client = {
  send(frame: Frame): void;
  hello(): Promise<string>;
  lines(): string[];
  frame(type: string): Frame | undefined;
  close(): void;
};

const openClients: Client[] = [];

async function connect(port: number): Promise<Client> {
  const socket = new WebSocket(`ws://127.0.0.1:${String(port)}/ws`);
  const frames: Frame[] = [];

  socket.addEventListener('message', (event: MessageEvent) => {
    const parsed: unknown = JSON.parse(String(event.data));
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      frames.push({ ...parsed });
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

  const client: Client = {
    send(frame: Frame): void {
      socket.send(JSON.stringify({ v: PROTOCOL_VERSION, ...frame }));
    },
    async hello(): Promise<string> {
      client.send({ t: 'hello' });
      const deadline = Date.now() + FRAME_TIMEOUT_MS;
      for (;;) {
        const welcome = frames.find((f) => f['t'] === 'welcome');
        const selfId = welcome?.['selfId'];
        if (typeof selfId === 'string') return selfId;
        if (Date.now() >= deadline) throw new Error('no welcome came back');
        await sleep(5);
      }
    },
    /** Every Record line this socket has been sent, in order. */
    lines(): string[] {
      const out: string[] = [];
      for (const frame of frames) {
        if (frame['t'] !== 'log') continue;
        const rows = frame['lines'];
        if (!Array.isArray(rows)) continue;
        for (const row of rows) {
          const text = (row as Record<string, unknown>)['text'];
          if (typeof text === 'string') out.push(text);
        }
      }
      return out;
    },
    frame(type: string): Frame | undefined {
      return frames.find((f) => f['t'] === type);
    },
    close(): void {
      socket.close();
    },
  };

  openClients.push(client);
  return client;
}

type Harness = { port: number; realms: Realms; close: () => Promise<void> };
let server: Harness;

beforeEach(async () => {
  const downed = createDownedState();
  const parties = createPartyState();
  const realms = createRealms({
    seed: 'region-line',
    engineFor: (world) => createTurnEngine({ world, downed, parties }),
  });

  const app = Fastify({ logger: false });
  await app.register(wsGateway, {
    world: realms.overworld.world,
    engine: realms.overworld.engine,
    realms,
    parties,
    downed,
    disconnectGraceMs: 30_000,
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
  for (const client of openClients) client.close();
  openClients.length = 0;
  await server.close();
});

/**
 * A pair of side-by-side walkable tiles that sit in DIFFERENT regions — the one
 * step in the whole map that must produce a line. Found rather than written
 * down, so moving a border moves the test with it.
 */
function aBorderStep(): { from: { x: number; y: number }; into: string } {
  const level = server.realms.overworld.world.level;
  for (const region of ALDERBROOK_REGIONS) {
    const x = region.x0;
    if (x <= 0) continue;
    for (let y = region.y0; y <= region.y1; y += 1) {
      if (!canWalk(level, x, y) || !canWalk(level, x - 1, y)) continue;
      if (regionAt(x - 1, y) === regionAt(x, y)) continue;
      return { from: { x: x - 1, y }, into: regionAt(x, y) };
    }
  }
  throw new Error('the map has no walkable pair straddling a region border');
}

describe('crossing into a named part of the moor says so', () => {
  it('sends one Record line naming the ground you walked into', async () => {
    const client = await connect(server.port);
    const actorId = await client.hello();

    const { from, into } = aBorderStep();
    const body = server.realms.overworld.world.getActor(actorId);
    expect(body).toBeDefined();
    if (body === undefined) return;
    body.x = from.x;
    body.y = from.y;

    // A first step to fill in the region silently — arriving somewhere already
    // announced itself, and two lines about one act read as a stutter.
    client.send({ t: 'move', dir: 'w' });
    await sleep(60);
    body.x = from.x;
    body.y = from.y;

    client.send({ t: 'move', dir: 'e' });
    await sleep(120);

    const said = client.lines().filter((l) => l.startsWith('You come to '));
    expect(said, `nothing was said about crossing into ${into}`).toContain(`You come to ${into}.`);
  });

  it('says nothing at all for a step inside one region', async () => {
    /**
     * THE HALF THAT MAKES IT BEARABLE. A line on every step is a movement
     * ticker, and the Record lane exists for the handful of things worth
     * reading. `Session.region` is what keeps a walk quiet until it leaves.
     */
    const client = await connect(server.port);
    const actorId = await client.hello();
    const level = server.realms.overworld.world.level;

    // Somewhere with three walkable tiles in a row, all in one region.
    const body = server.realms.overworld.world.getActor(actorId);
    expect(body).toBeDefined();
    if (body === undefined) return;

    let placed = false;
    for (let y = 60; y < 75 && !placed; y += 1) {
      for (let x = 100; x < 140; x += 1) {
        if (!canWalk(level, x, y) || !canWalk(level, x + 1, y) || !canWalk(level, x + 2, y))
          continue;
        if (regionAt(x, y) !== regionAt(x + 2, y)) continue;
        body.x = x;
        body.y = y;
        placed = true;
        break;
      }
    }
    expect(placed, 'no three-in-a-row inside one region').toBe(true);

    client.send({ t: 'move', dir: 'e' });
    await sleep(60);
    const before = client.lines().filter((l) => l.startsWith('You come to ')).length;
    client.send({ t: 'move', dir: 'e' });
    await sleep(120);

    expect(client.lines().filter((l) => l.startsWith('You come to ')).length).toBe(before);
  });
});

describe('the names reach the map, not just the log', () => {
  it('sends the whole region table once, on the realm frame', async () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE FIELD THAT WAS DELIBERATELY NOT SHIPPED UNTIL SOMETHING DREW IT.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * When the crossing line landed, the table stayed off the wire on purpose —
     * *"an unused protocol field is the same disease"* as a subsystem wired to
     * nothing, and this project has found four of those in its own work. It
     * ships now because the world map draws it: the log could tell you that you
     * had ENTERED the Bracken Waste and the map could not tell you where the
     * Bracken Waste was.
     *
     * ONCE, ON ENTRY. Twelve rectangles is a few hundred bytes and the answer
     * never changes, so re-sending it per step would be traffic that says what
     * the client already knows.
     */
    const client = await connect(server.port);
    await client.hello();
    await sleep(80);

    const realm = client.frame('realm');
    expect(realm).toBeDefined();
    const regions = realm?.['regions'];
    expect(Array.isArray(regions), 'the realm frame carried no region table').toBe(true);
    if (!Array.isArray(regions)) return;

    expect(regions.length).toBeGreaterThan(6);
    for (const row of regions) {
      const r = row as Record<string, unknown>;
      expect(typeof r['name']).toBe('string');
      for (const bound of ['x0', 'y0', 'x1', 'y1']) {
        expect(typeof r[bound], `${String(r['name'])} has no ${bound}`).toBe('number');
      }
    }

    // AND THE NAMES ARE THE ONES THE LOG USES, or the map captions a different
    // world from the one the Case Log is narrating.
    const names = new Set(regions.map((row) => (row as Record<string, unknown>)['name']));
    expect(names.has('Alderbrook Common')).toBe(true);
    expect(names.has('the Bracken Waste')).toBe(true);
  });
});
