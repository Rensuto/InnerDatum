import { setTimeout as sleep } from 'node:timers/promises';

import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDownedState } from '../../src/server/engine/downed.ts';
import { createPartyState } from '../../src/server/engine/party.ts';
import { STANDING_LEVEL, isTownsfolkId } from '../../src/server/content/townsfolk.ts';
import { wsGateway } from '../../src/server/net/gateway.ts';
import { createTurnEngine } from '../../src/server/turn-engine.ts';
import { createRealms } from '../../src/server/world/realms.ts';
import { PROTOCOL_VERSION } from '../../src/shared/version.ts';
import { TopicId } from '../../src/shared/protocol.ts';
import type { Realms } from '../../src/server/world/realms.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE GATE ITSELF, DRIVEN — NOT THE TABLE THAT FEEDS IT.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `rumour.test.ts` proves the content is there and that the directions are
 * true. NEITHER OF THOSE IS THE THING THAT BREAKS. What breaks is the join: one
 * expression in `handleTalk` that picks `spec.later` over `spec.topics`, reading
 * a level off an actor union that does not carry it on every branch. The first
 * version of that line did not compile for exactly that reason.
 *
 * So this drives it. A real socket, a real townsperson, the real `talk` frame,
 * at two levels — because the failure mode nobody would notice is the gate
 * silently never opening, which looks identical to a player who has simply not
 * asked the right person.
 */

const FRAME_TIMEOUT_MS = 4_000;

type Harness = { port: number; realms: Realms; close: () => Promise<void> };
let server: Harness;
const openSockets: WebSocket[] = [];

beforeEach(async () => {
  const downed = createDownedState();
  const parties = createPartyState();
  const realms = createRealms({
    seed: 'rumour-gate',
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
  /** Refusals, so a silent failure can say why rather than just being silent. */
  errors(): string[];
  lines(): { text: string; speaker?: string }[];
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
        errors(): string[] {
          // Narrowed to strings before joining rather than `String(...)` on an
          // unknown: an error frame whose fields are objects would otherwise
          // report '[object Object]', which is worse than reporting nothing.
          return frames
            .filter((f) => f['t'] === 'error')
            .map((f) => {
              const parts = [f['code'], f['message']].filter(
                (v): v is string => typeof v === 'string',
              );
              return parts.length > 0 ? parts.join(': ') : 'error';
            });
        },
        lines(): { text: string; speaker?: string }[] {
          const out: { text: string; speaker?: string }[] = [];
          for (const frame of frames) {
            if (frame['t'] !== 'log') continue;
            const rows = frame['lines'];
            if (!Array.isArray(rows)) continue;
            for (const row of rows as Record<string, unknown>[]) {
              if (typeof row['text'] === 'string') {
                out.push({
                  text: row['text'],
                  speaker: typeof row['speaker'] === 'string' ? row['speaker'] : undefined,
                });
              }
            }
          }
          return out;
        },
      };
    }
    if (Date.now() >= deadline) throw new Error('no welcome came back');
    await sleep(5);
  }
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WALK INTO A TOWN THROUGH ITS DOOR, THEN STAND NEXT TO WHOEVER LIVES THERE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * THE FIRST VERSION OF THIS MOVED THE BODY BETWEEN WORLDS DIRECTLY and every
 * assertion failed with "nobody answered". That was the test, not the server:
 * `handleTalk` resolves the room through `realmFor(session)`, and a session
 * whose body has been teleported out from under it is still pointed at the map
 * it was on — so the townsperson was, correctly, not there.
 *
 * So the CROSSING is a real `move` intent onto the town's own site cell, which
 * is what moves the session. Only the last step — sliding the body next to the
 * person once both are in the same realm — is direct, because walking a town's
 * street grid over a socket proves nothing this file is about.
 */
async function walkIntoTown(
  realms: Realms,
  actorId: string,
  client: Client,
): Promise<{ townId: string; whoId: string }> {
  // A town that somebody actually lives in, and its door on the overworld.
  const inhabited = new Set(
    realms
      .all()
      .filter((r) => [...r.world.allActors()].some((a) => isTownsfolkId(a.id)))
      .map((r) => r.siteId ?? ''),
  );
  const door = [...realms.overworld.sites].find(([, siteId]) => inhabited.has(siteId));
  if (door === undefined) throw new Error('no inhabited town has a door on the overworld');
  const [xs, ys] = door[0].split(',');

  const body = realms.overworld.world.getActor(actorId);
  if (body === undefined) throw new Error('no body on the overworld');
  body.x = Number(xs) - 1;
  body.y = Number(ys);
  client.send({ t: 'move', dir: 'e' });
  await sleep(250);

  const town = realms.realmOf(actorId);
  if (town === undefined || town.id === realms.overworld.id) {
    throw new Error(`never got into the town (errors: ${client.errors().join('; ') || 'none'})`);
  }

  const who = [...town.world.allActors()].find((a) => isTownsfolkId(a.id));
  if (who === undefined) throw new Error('the town is empty');
  const inside = town.world.getActor(actorId);
  if (inside === undefined) throw new Error('no body in the town');
  inside.x = who.x + 1;
  inside.y = who.y;
  return { townId: town.id, whoId: who.id };
}

/** The most recent thing anybody said out loud. */
function lastSpoken(client: Client): string | undefined {
  return [...client.lines()].reverse().find((l) => l.speaker !== undefined)?.text;
}

describe('asking about rumours', () => {
  it('tells a newcomer the near ones and a veteran where the other map is', async () => {
    const client = await hello(server.port);
    const { townId, whoId } = await walkIntoTown(server.realms, client.actorId, client);
    const town = server.realms.get(townId);
    const body = town?.world.getActor(client.actorId);
    expect(body).toBeDefined();
    if (body === undefined || !('level' in body)) throw new Error('no player body');

    // ── as a stranger ──────────────────────────────────────────────────────
    body.level = 1;
    client.send({ t: 'talk', targetId: whoId, topic: TopicId.Rumour });
    await sleep(200);
    const asStranger = lastSpoken(client);
    expect(
      asStranger,
      `nobody answered (${client.errors().join('; ') || 'no error'})`,
    ).toBeDefined();

    // ── and once they have standing ────────────────────────────────────────
    body.level = STANDING_LEVEL;
    client.send({ t: 'talk', targetId: whoId, topic: TopicId.Rumour });
    await sleep(200);
    const asVeteran = lastSpoken(client);

    // THE GATE OPENED. Two different answers to the same question, which is the
    // whole mechanism — and the only thing that proves the join is wired.
    expect(asVeteran, 'the gate never opened').not.toBe(asStranger);
    // AND IT OPENED ONTO THE THING IT IS FOR: a direction the player can walk.
    expect(asVeteran?.toLowerCase()).toContain('west');
  });

  it('does not open one level early', async () => {
    /**
     * THE BOUNDARY, BECAUSE OFF-BY-ONE HERE IS NOT COSMETIC. Below the line the
     * player is meant to get the near-country rumour; a `>` written as `>=` in
     * the wrong direction would send characters west a level early, into
     * roamers that are half elite. Asserted one step under rather than at 1, so
     * the test fails on the boundary rather than on the obvious case.
     */
    const client = await hello(server.port);
    const { townId, whoId } = await walkIntoTown(server.realms, client.actorId, client);
    const body = server.realms.get(townId)?.world.getActor(client.actorId);
    if (body === undefined || !('level' in body)) throw new Error('no player body');

    body.level = STANDING_LEVEL - 1;
    client.send({ t: 'talk', targetId: whoId, topic: TopicId.Rumour });
    await sleep(200);
    const below = lastSpoken(client);

    body.level = STANDING_LEVEL;
    client.send({ t: 'talk', targetId: whoId, topic: TopicId.Rumour });
    await sleep(200);
    const at = lastSpoken(client);

    expect(below).toBeDefined();
    expect(at).not.toBe(below);
    expect(below?.toLowerCase() ?? '').not.toContain('west');
  });

  it('leaves every other topic alone at every level', async () => {
    // `later` HOLDS ONE TOPIC TODAY and the fallthrough is what keeps the other
    // three unchanged. A veteran asking about the roads must get the roads.
    const client = await hello(server.port);
    const { townId, whoId } = await walkIntoTown(server.realms, client.actorId, client);
    const body = server.realms.get(townId)?.world.getActor(client.actorId);
    if (body === undefined || !('level' in body)) throw new Error('no player body');

    for (const topic of [TopicId.Where, TopicId.Party, TopicId.Roads]) {
      body.level = 1;
      client.send({ t: 'talk', targetId: whoId, topic });
      await sleep(150);
      const young = lastSpoken(client);

      body.level = STANDING_LEVEL + 2;
      client.send({ t: 'talk', targetId: whoId, topic });
      await sleep(150);
      expect(lastSpoken(client), topic).toBe(young);
    }
  });
});
