import { setTimeout as sleep } from 'node:timers/promises';

import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDownedState } from '../../src/server/engine/downed.ts';
import { accept, createPartyState, invite } from '../../src/server/engine/party.ts';
import { wsGateway } from '../../src/server/net/gateway.ts';
import { createTurnEngine } from '../../src/server/turn-engine.ts';
import { RealmKind, createRealms } from '../../src/server/world/realms.ts';
import { canWalk } from '../../src/shared/level.ts';
import { PROTOCOL_VERSION } from '../../src/shared/version.ts';
import type { PartyState } from '../../src/server/engine/party.ts';
import type { Realms } from '../../src/server/world/realms.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * AN EMPTIED INSTANCE IS REAPED — BY EVERY PATH THAT CAN EMPTY IT.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * There are THREE ways the last body leaves an instance and only ONE of them
 * armed the reaper:
 *
 *   `leaveRealm`      walking back out of the door you came in by.  reaped
 *   `crossIntoRealm`  FOLLOWING somebody into another realm.        leaked
 *   `recallBody`      the reconnect grace expiring where you stood. leaked
 *
 * `INSTANCE_LINGER_MS` says a delve waits five minutes for you to come back and
 * is then thrown away. Through either leaking path it waited FOREVER, and
 * `Realms.open` hands a party back its existing non-sealed instance — so a party
 * that cleared the Underworks in the morning, followed a friend out, and walked
 * back in that evening got their morning floor: every monster still dead, every
 * chest still open, no loot and no fight. The five-minute policy exists
 * precisely so that cannot happen.
 *
 * An ambush leaked the same way with worse consequences, because
 * `ENCOUNTER_SITE.lingerMs` is 0 for a reason of its own — *"fleeing has to MEAN
 * something. If the breach you ran out of were still there thirty seconds later,
 * running would be a way to save-scum a fight."* Following a party member out of
 * a breach left the breach standing.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * NO FAKE TIMERS, AND THAT IS WHY THE AMBUSH IS THE FIXTURE
 * ═══════════════════════════════════════════════════════════════════════════
 * `lingerMs: 0` is closed ON THE SPOT rather than on a `setTimeout`, so every
 * assertion here is synchronous with the act that caused it. A five-minute delve
 * would need the clock faked, and faking the clock under a live socket, a
 * Fastify server and a reconnect grace is how a test starts asserting things
 * about its own mocks.
 *
 * NO TEST BOOTED THE GATEWAY WITH A REALM REGISTRY AT ALL BEFORE THIS FILE,
 * which is the whole reason two of the three paths could be wrong for as long as
 * they were: crossing, following, reaping and the instance lifecycle had no
 * coverage of any kind.
 */

const FRAME_TIMEOUT_MS = 2_000;
const GRACE_MS = 60;

type Frame = Record<string, unknown>;

type Client = {
  send(frame: Frame): void;
  hello(): Promise<string>;
  waitFor(type: string, timeoutMs?: number): Promise<Frame | undefined>;
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

  const waitFor = async (
    type: string,
    timeoutMs = FRAME_TIMEOUT_MS,
  ): Promise<Frame | undefined> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = frames.find((frame) => frame['t'] === type);
      if (hit !== undefined) return hit;
      if (Date.now() >= deadline) return undefined;
      await sleep(5);
    }
  };

  const client: Client = {
    send(frame: Frame): void {
      socket.send(JSON.stringify({ v: PROTOCOL_VERSION, ...frame }));
    },
    async hello(): Promise<string> {
      client.send({ t: 'hello' });
      const welcome = await waitFor('welcome');
      const selfId = welcome?.['selfId'];
      if (typeof selfId !== 'string') throw new Error('no welcome came back');
      return selfId;
    },
    waitFor,
    close(): void {
      socket.close();
    },
  };

  openClients.push(client);
  return client;
}

type Harness = {
  port: number;
  realms: Realms;
  parties: PartyState;
  close: () => Promise<void>;
};

let server: Harness;

async function boot(): Promise<Harness> {
  const downed = createDownedState();
  const parties = createPartyState();
  const realms = createRealms({
    seed: 'instance-reap',
    engineFor: (world) => createTurnEngine({ world, downed, parties }),
  });

  const app = Fastify({ logger: false });
  await app.register(wsGateway, {
    // THE REAL REGISTRY AND REAL ENGINES. A stub scheduler cannot be used here:
    // crossing calls `join`, `leave` and `setConnected` on the DESTINATION
    // realm's own engine, and the reap is decided by what is left in a world
    // after a real `removePlayer`.
    world: realms.overworld.world,
    engine: realms.overworld.engine,
    realms,
    parties,
    downed,
    disconnectGraceMs: GRACE_MS,
  });
  await app.listen({ host: '127.0.0.1', port: 0 });

  const address = app.server.address();
  if (address === null || typeof address === 'string') throw new Error('no port was bound');

  return {
    port: address.port,
    realms,
    parties,
    close: async (): Promise<void> => {
      await app.close();
    },
  };
}

beforeEach(async () => {
  server = await boot();
});

afterEach(async () => {
  for (const client of openClients) client.close();
  openClients.length = 0;
  await server.close();
});

/**
 * Every INSTANCE, which is the reaper's whole job as a list.
 *
 * `RealmKind.Inner` and not merely "everything that is not Alderbrook": the
 * five COMMON sites are built once at boot, because there is only ever one of
 * each of those places, and they are never reaped by anything. Counting them
 * was the first thing this file got wrong.
 */
function instances(): readonly string[] {
  return server.realms
    .all()
    .filter((r) => r.kind === RealmKind.Inner)
    .map((r) => r.id);
}

/**
 * WALK A BODY INTO A BREACH, the way a player does: stand next to something
 * visibly dangerous and take one step onto it.
 *
 * The roamer is planted rather than waited for — `tickRoamers` moves them on a
 * schedule this test has no business depending on — but everything after the
 * plant is the real path: `handleMove` to `crossIntoSite` to `crossInto` to
 * `crossIntoRealm`, including the roamer being consumed on the way in.
 */
async function walkIntoAnAmbush(client: Client, actorId: string): Promise<void> {
  const overworld = server.realms.overworld;
  const body = overworld.world.getActor(actorId);
  if (body === undefined) throw new Error('that body is not in the overworld');

  // TWO ADJACENT WALKABLE TILES, found rather than written down: the overworld
  // is a 170x100 authored map, and a coordinate pair hardcoded here would be a
  // test that breaks the next time somebody moves a tree.
  const { level } = overworld.world;
  let from: { x: number; y: number } | undefined;
  for (let y = 1; y < level.h - 1 && from === undefined; y += 1) {
    for (let x = 1; x < level.w - 2; x += 1) {
      if (canWalk(level, x, y) && canWalk(level, x + 1, y)) {
        from = { x, y };
        break;
      }
    }
  }
  if (from === undefined) throw new Error('the overworld has no two adjacent walkable tiles');

  body.x = from.x;
  body.y = from.y;
  overworld.roamers.set('roamer:test', {
    id: 'roamer:test',
    x: from.x + 1,
    y: from.y,
    name: 'a test breach',
    sprite: 'enemy_index_husk_s',
  });

  client.send({ t: 'move', dir: 'e' });

  /**
   * POLL THE REGISTRY, NOT THE FRAMES, and the difference is a bug this file
   * already made once. `hello` sends a `realm` frame of its own for the
   * overworld, so waiting for "a frame of type realm" returned the STALE one
   * instantly and every assertion after it ran before the move had resolved.
   * The registry cannot lie about this in the same way: an instance is either
   * open or it is not.
   */
  const deadline = Date.now() + FRAME_TIMEOUT_MS;
  while (instances().length === 0 && Date.now() < deadline) await sleep(5);
  const opened = instances();
  if (opened.length !== 1) {
    throw new Error(
      `expected exactly one instance, got ${String(opened.length)} (body at ${String(body.x)},${String(body.y)})`,
    );
  }
}

describe('the reaper covers every way an instance can empty', () => {
  it('closes the breach the last body FOLLOWS out of', async () => {
    /**
     * THE LEAK, AS A PLAYER MEETS IT. Two friends on the overworld. One walks
     * into a breach; the other stays put; the first thinks better of it and uses
     * the party pane's Follow to pop back out to their friend. Nobody is in the
     * breach any more, and `ENCOUNTER_SITE.lingerMs` is 0 — it must be gone.
     */
    const a = await connect(server.port);
    const b = await connect(server.port);
    const aid = await a.hello();
    const bid = await b.hello();

    const now = Date.now();
    expect(invite(server.parties, bid, aid, now).ok).toBe(true);
    expect(accept(server.parties, aid, bid, now).ok).toBe(true);

    await walkIntoAnAmbush(a, aid);
    expect(instances()).toHaveLength(1);

    a.send({ t: 'follow', targetId: bid });
    // Two `realm` frames by now — in, and back out again — so settle on the
    // registry rather than on a frame count.
    await sleep(120);

    expect(server.realms.realmOf(aid)?.id).toBe(server.realms.overworld.id);
    expect(instances()).toEqual([]);
  });

  it('closes the breach a dropped player is RECALLED out of', async () => {
    /**
     * THE SAME LEAK, REACHED BY LOSING YOUR CONNECTION. Alone in a breach, the
     * socket drops, and the grace later takes the body out of that world.
     * Nothing else will ever visit that realm — its only occupant's session is
     * gone — so a reap not armed here is never armed at all, and the realm and
     * its six memo rows live for the lifetime of the process.
     */
    const a = await connect(server.port);
    const aid = await a.hello();

    await walkIntoAnAmbush(a, aid);
    expect(instances()).toHaveLength(1);

    a.close();
    await sleep(GRACE_MS + 400);

    expect(server.realms.realmOf(aid)).toBeUndefined();
    expect(instances()).toEqual([]);
  });

  it('never closes Alderbrook, however many people leave it', async () => {
    /**
     * THE NO-REGRESSION HALF, and it is not hypothetical: both fixes call
     * `reapIfEmpty` on the realm somebody left, and on the overworld that is a
     * realm which is routinely empty at four in the morning. `Realms.close`
     * refuses a shared realm outright and `reapIfEmpty` returns before it ever
     * asks — two independent refusals, because a town torn down when the last
     * person leaves is a town that loses the coat you dropped in it.
     */
    const a = await connect(server.port);
    const aid = await a.hello();
    await walkIntoAnAmbush(a, aid);

    a.close();
    await sleep(GRACE_MS + 400);

    expect(server.realms.get(server.realms.overworld.id)).toBeDefined();
  });
});
