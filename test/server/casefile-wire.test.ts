import { setTimeout as sleep } from 'node:timers/promises';

import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDownedState } from '../../src/server/engine/downed.ts';
import { createPartyState } from '../../src/server/engine/party.ts';
import { wsGateway } from '../../src/server/net/gateway.ts';
import { createTurnEngine } from '../../src/server/turn-engine.ts';
import { SITES, createRealms } from '../../src/server/world/realms.ts';
import { fileableCount, isFileable } from '../../src/server/world/casefile.ts';
import { ActorKind } from '../../src/shared/protocol.ts';
import { PROTOCOL_VERSION } from '../../src/shared/version.ts';
import type { Realms } from '../../src/server/world/realms.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * CLEARING A ROOM HAS TO ACTUALLY FILE IT.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `casefile.test.ts` proves what is fileable and what survives disk. Neither is
 * the thing that breaks. What breaks is the JOIN: a block inside the clear
 * handler that has to run at the same moment `shouldAnnounceCleared` fires, for
 * every player still on their feet, and reach a socket that may not be there.
 *
 * `cleared.test.ts` is PURE — it drives `shouldAnnounceCleared` directly, so
 * nothing in this repo had ever driven a real room going quiet over a real
 * socket. That is why this file kills something.
 *
 * ═══ THE SCENARIO IS SHAPED, THE KILL IS NOT ═══
 * The room is reduced to one resident with one hit point before the fight, so
 * the test is a few frames rather than a level-1 character grinding five husks.
 * The DEATH goes through the ordinary damage pipeline — a bump attack, resolved
 * by the scheduler. That distinction is not pedantry: an earlier probe in this
 * project set `hp = 0; alive = false` directly and reported 0 of 20 loot spills
 * because it had skipped the pipeline that spills them. Setting a monster's hit
 * points to 1 and then hitting it is a scenario; setting them to 0 is a lie.
 */

const FRAME_TIMEOUT_MS = 4_000;

type Harness = { port: number; realms: Realms; close: () => Promise<void> };
let server: Harness;
const openSockets: WebSocket[] = [];

beforeEach(async () => {
  const downed = createDownedState();
  const parties = createPartyState();
  const realms = createRealms({
    seed: 'casefile-wire',
    engineFor: (world) => createTurnEngine({ world, downed, parties }),
  });

  const app = Fastify({ logger: false });
  await app.register(wsGateway, {
    world: realms.overworld.world,
    engine: realms.overworld.engine,
    realms,
    parties,
    downed,
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
  for (const socket of openSockets) socket.close();
  openSockets.length = 0;
  await server.close();
});

type Client = {
  actorId: string;
  send(frame: Record<string, unknown>): void;
  lines(): string[];
  markers(): Record<string, unknown>[];
};

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
        lines(): string[] {
          const out: string[] = [];
          for (const frame of frames) {
            if (frame['t'] !== 'log') continue;
            const rows = frame['lines'];
            if (!Array.isArray(rows)) continue;
            for (const row of rows as Record<string, unknown>[]) {
              if (typeof row['text'] === 'string') out.push(row['text']);
            }
          }
          return out;
        },
        markers(): Record<string, unknown>[] {
          const latest = [...frames]
            .reverse()
            .find((f) => (f['t'] === 'sites' || f['t'] === 'realm') && Array.isArray(f['sites']));
          const rows = latest?.['sites'];
          return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
        },
      };
    }
    if (Date.now() >= deadline) throw new Error('no welcome came back');
    await sleep(5);
  }
}

/** Walk onto the first fileable site's cell, which opens it. */
async function enterADelve(realms: Realms, client: Client): Promise<string> {
  const door = [...realms.overworld.sites].find(([, siteId]) => {
    const def = SITES.get(siteId);
    return def !== undefined && isFileable(def);
  });
  if (door === undefined) throw new Error('no fileable site on the overworld');
  const [xs, ys] = door[0].split(',');
  const body = realms.overworld.world.getActor(client.actorId);
  if (body === undefined) throw new Error('no body');
  body.x = Number(xs) - 1;
  body.y = Number(ys);
  client.send({ t: 'move', dir: 'e' });
  await sleep(250);
  return door[1];
}

/**
 * Leave exactly one resident, on one hit point, standing west of the player.
 *
 * The room is SHAPED here and the kill happens over the wire — see the header.
 */
function leaveOneAlmostDead(realms: Realms, actorId: string): void {
  const realm = realms.realmOf(actorId);
  const body = realm?.world.getActor(actorId);
  if (realm === undefined || body === undefined) throw new Error('not in a delve');

  const monsters = [...realm.world.allActors()].filter((a) => a.kind === ActorKind.Monster);
  expect(monsters.length, 'the delve generated empty').toBeGreaterThan(0);

  const [survivor, ...rest] = monsters;
  for (const other of rest) realm.world.removeActor(other.id);
  if (survivor === undefined) throw new Error('no survivor');
  survivor.hp = 1;
  survivor.x = body.x + 1;
  survivor.y = body.y;
}

/**
 * Bump east until the thing standing there is dead.
 *
 * ONE SWING IS NOT A KILL. The first version sent a single `move` and the test
 * reported "never filed" — the log said *"Player 1 misses Index Eidolon"*.
 * `checkHit` is a real roll on this path, which is the whole reason the kill is
 * driven over the wire rather than assigned: a test that could not miss would
 * not be exercising the pipeline it claims to.
 */
async function keepSwinging(realms: Realms, client: Client): Promise<void> {
  for (let swing = 0; swing < 30; swing += 1) {
    const realm = realms.realmOf(client.actorId);
    const living = [...(realm?.world.allActors() ?? [])].filter(
      (a) => a.kind === ActorKind.Monster && a.alive,
    );
    if (living.length === 0) break;
    client.send({ t: 'move', dir: 'e' });
    await sleep(70);
  }
  // A beat for the pump that noticed the room emptying, and the frames it sent.
  await sleep(300);
}

describe('closing a case', () => {
  it('files it, counts it, and says so to the person who did it', async () => {
    const client = await hello(server.port);
    const siteId = await enterADelve(server.realms, client);
    expect(server.realms.realmOf(client.actorId)?.siteId).toBe(siteId);

    // A pump or two so the resident count is recorded before the room empties —
    // `shouldAnnounceCleared` needs an EDGE, and an edge needs a previous.
    await sleep(200);
    leaveOneAlmostDead(server.realms, client.actorId);
    await sleep(200);

    await keepSwinging(server.realms, client);

    const filedLine = client.lines().find((l) => l.startsWith('Filed.'));
    expect(
      filedLine,
      `never filed — log was: ${client.lines().slice(-4).join(' | ')}`,
    ).toBeDefined();
    // THE COUNT IS THE POINT — the first time this game tells a player how big
    // it is. One closed, and the denominator read off the registry.
    expect(filedLine).toBe(`Filed. 1 of ${String(fileableCount(SITES))}.`);
  });

  it('marks it on the map, for that player', async () => {
    /**
     * The other half of the join. A file nobody can see is a counter in a log
     * line that scrolls away — the whole value is that the MAP changes, because
     * the map is where "what should I do now" gets asked.
     */
    const client = await hello(server.port);
    const siteId = await enterADelve(server.realms, client);
    await sleep(200);
    leaveOneAlmostDead(server.realms, client.actorId);
    await sleep(200);
    await keepSwinging(server.realms, client);

    /**
     * ═══════════════════════════════════════════════════════════════════════
     * BACK OUT TO THE OVERWORLD, WHICH IS WHERE THE MARKER LIVES.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * The first version of this checked the markers while the player was still
     * INSIDE the delve, and asserted `marked ?? somethingElse` — which is
     * defined whether or not a marker ever came back filed. It passed, and it
     * was measuring nothing. Two faults in one line: the wrong map, and a
     * fallback that made the wrong map impossible to notice.
     *
     * A delve draws its own exit and nothing else; the case file is a mark on
     * the world map. So the player has to go home before the question can even
     * be asked.
     */
    const inside = server.realms.realmOf(client.actorId);
    const exit = inside?.spawns[0];
    if (exit === undefined) throw new Error('the delve has no way out');
    const body = inside?.world.getActor(client.actorId);
    if (body === undefined) throw new Error('no body');
    body.x = exit.x;
    body.y = exit.y;
    client.send({ t: 'move', dir: 'w' });
    await sleep(150);
    client.send({ t: 'move', dir: 'e' });
    await sleep(300);
    expect(server.realms.realmOf(client.actorId)?.id, 'never got back out').toBe(
      server.realms.overworld.id,
    );

    const marked = client.markers().filter((m) => m['filed'] === true);
    expect(marked, 'no marker came back filed').toHaveLength(1);
    expect(marked[0]?.['name']).toBe(SITES.get(siteId)?.name);
    // AND ONLY THAT ONE. Sixteen other rooms are still open, and a file that
    // marked them all would be worse than one that marked none.
    const all = client.markers().filter((m) => m['danger'] !== undefined);
    expect(all.length).toBeGreaterThan(1);
  });

  it('does not file a room somebody else cleared', async () => {
    /**
     * A case file is a fact about a CHARACTER. Two people in the same world,
     * one of them never in the room — the second must still be looking at a
     * gap. This is the assertion that would fail if the file were ever keyed by
     * realm or by party rather than by body.
     */
    const doer = await hello(server.port);
    const bystander = await hello(server.port);
    await enterADelve(server.realms, doer);
    await sleep(200);
    leaveOneAlmostDead(server.realms, doer.actorId);
    await sleep(200);
    await keepSwinging(server.realms, doer);

    expect(doer.lines().some((l) => l.startsWith('Filed.'))).toBe(true);
    expect(bystander.lines().some((l) => l.startsWith('Filed.'))).toBe(false);
    expect(bystander.markers().some((m) => m['filed'] === true)).toBe(false);
  });
});
