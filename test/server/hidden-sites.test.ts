import { setTimeout as sleep } from 'node:timers/promises';

import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDownedState } from '../../src/server/engine/downed.ts';
import { createPartyState } from '../../src/server/engine/party.ts';
import { wsGateway } from '../../src/server/net/gateway.ts';
import { createTurnEngine } from '../../src/server/turn-engine.ts';
import { SITES, createRealms } from '../../src/server/world/realms.ts';
import { PROTOCOL_VERSION } from '../../src/shared/version.ts';
import type { Realms } from '../../src/server/world/realms.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A MARKER YOU HAVE NOT FOUND IS NOT ON YOUR MAP.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Thirteen markers arrived with the first frame, so the overworld had never once
 * rewarded LOOKING: everything worth walking to was handed over before the
 * player took a step, and a map with no unknown on it is a list of destinations
 * rather than a place.
 *
 * The three hidden sites are gated on the character's OWN fog bitset — already
 * computed, already persisted, already on the wire — so this costs no new state
 * and no new save field.
 *
 * DRIVEN OVER A SOCKET, because "the server filters a list" is exactly the kind
 * of claim that unit-tests green while no client is ever told. This file reads
 * what actually came down the wire, twice: once before the ground was walked and
 * once after.
 */

const FRAME_TIMEOUT_MS = 4_000;
const HIDDEN = ['site:cairnfoot', 'site:barrow_end', 'site:the_weir'] as const;

type Frame = Record<string, unknown>;

type Client = {
  send(frame: Frame): void;
  hello(): Promise<string>;
  /** Every site NAME the server has ever shown this socket. */
  markers(): Set<string>;
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
    markers(): Set<string> {
      const out = new Set<string>();
      for (const frame of frames) {
        const list = frame['sites'];
        if (!Array.isArray(list)) continue;
        for (const row of list) {
          const name = (row as Record<string, unknown>)['name'];
          if (typeof name === 'string') out.add(name);
        }
      }
      return out;
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
    seed: 'hidden-sites',
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

/** Where a hidden site actually sits on the shipped map. */
function cellOf(siteId: string): { x: number; y: number } {
  for (const [cell, id] of server.realms.overworld.sites) {
    if (id !== siteId) continue;
    const [xs, ys] = cell.split(',');
    return { x: Number(xs), y: Number(ys) };
  }
  throw new Error(`${siteId} is not on the map`);
}

describe('the three hidden sites have to be found', () => {
  it('shows a fresh character every ordinary marker and none of the hidden ones', async () => {
    const client = await connect(server.port);
    await client.hello();
    await sleep(80);

    const shown = client.markers();
    // The thirteen that have always been there are all still there. Nothing a
    // player has been reading for weeks is ever taken away.
    expect(shown.has('Alderbrook')).toBe(true);
    expect(shown.has('The Underworks')).toBe(true);
    expect(shown.size).toBeGreaterThan(10);

    for (const siteId of HIDDEN) {
      const name = SITES.get(siteId)?.name ?? siteId;
      expect(shown.has(name), `${name} was given away before it was found`).toBe(false);
    }
  });

  it('puts the marker on the map the moment you stand on that ground', async () => {
    /**
     * THE HALF THAT MAKES IT A FEATURE RATHER THAN A DELETION. A gate with no
     * way through is just three sites nobody can reach, and this is the
     * assertion that fails if the reveal is wired to nothing.
     *
     * The timing matters as much as the fact: `sendSites` is otherwise re-sent
     * only when a roamer moves, so without the counter in `handleMove` the
     * marker would appear several turns later, attached to nothing the player
     * did. The whole feeling is walking over a rise and finding something.
     */
    const client = await connect(server.port);
    const actorId = await client.hello();
    await sleep(80);

    const weir = cellOf('site:the_weir');
    const body = server.realms.overworld.world.getActor(actorId);
    expect(body).toBeDefined();
    if (body === undefined) return;

    // Standing beside it, then taking the one step that reveals it. Placed
    // rather than walked: the walk is thirty tiles and this test is about the
    // gate, not the pathfinder.
    body.x = weir.x - 1;
    body.y = weir.y;
    client.send({ t: 'move', dir: 'e' });
    await sleep(150);

    expect(client.markers().has('The Weir')).toBe(true);
  });

  it('does not hand one player another player’s discovery', async () => {
    /**
     * PER PLAYER, NOT PER PARTY, and that is the correct reading rather than the
     * cheap one: finding something is yours, and TELLING THE OTHERS is the good
     * part. Four people in a voice channel discovering a marker at four
     * different moments is the mechanic working, not a bug in it.
     */
    const finder = await connect(server.port);
    const other = await connect(server.port);
    const finderId = await finder.hello();
    await other.hello();
    await sleep(80);

    const weir = cellOf('site:the_weir');
    const body = server.realms.overworld.world.getActor(finderId);
    if (body === undefined) throw new Error('no body');
    body.x = weir.x - 1;
    body.y = weir.y;
    finder.send({ t: 'move', dir: 'e' });
    await sleep(150);

    expect(finder.markers().has('The Weir')).toBe(true);
    expect(other.markers().has('The Weir')).toBe(false);
  });
});
