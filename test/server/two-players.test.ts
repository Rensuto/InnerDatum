import { setTimeout as sleep } from 'node:timers/promises';

import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDownedState } from '../../src/server/engine/downed.ts';
import { createPartyState, membersOf } from '../../src/server/engine/party.ts';
import { wsGateway } from '../../src/server/net/gateway.ts';
import { createTurnEngine } from '../../src/server/turn-engine.ts';
import { createRealms } from '../../src/server/world/realms.ts';
import { PROTOCOL_VERSION } from '../../src/shared/version.ts';
import type { PartyState } from '../../src/server/engine/party.ts';
import type { Realms } from '../../src/server/world/realms.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * TWO PEOPLE IN ONE WORLD — THE PILLAR WITH NO END-TO-END TEST.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * This game exists to be played by three to six friends in a voice channel, and
 * every socket test in this repo until now drove exactly one of them. The party
 * machinery has unit tests, the barrier has unit tests, and nothing had ever
 * asserted the thing the whole design is for: that a second person joining is
 * visible, coherent, and not quietly misrepresented.
 *
 * ═══ WRITTEN AFTER CHECKING BY HAND, AND EVERY WORRY WAS UNFOUNDED ═══
 * Driven manually first, expecting to find a gap. There was not one:
 *
 *   - A sees `Player 2 arrives.` in the Case Log.
 *   - B's `welcome` carries both bodies, so they can see each other immediately.
 *   - The party pane draws `party_state` and NOTHING ELSE, so each of them is
 *     honestly shown alone until somebody invites — `ui/partypanel.ts` records
 *     fixing exactly the bug I went looking for, where "a player alone on the
 *     floor was shown a party they were not in".
 *   - Right-clicking the other body offers `Invite to party` (`ui/verbs.ts`).
 *
 * So this file is not a bug fix. It is the hand-check made permanent, because
 * the co-op surface being correct and the co-op surface being GUARDED are
 * different things, and the second one is what survives the next refactor.
 *
 * THE ONE ASYMMETRY IS REAL AND IS ASSERTED BELOW: the `party` frame lists
 * everybody in the realm and `party_state` lists your actual party. They are two
 * different questions — who is here, and who am I playing with — and experience
 * follows the second one.
 */

const FRAME_TIMEOUT_MS = 4_000;

type Frame = Record<string, unknown>;

type Client = {
  send(frame: Frame): void;
  hello(): Promise<string>;
  latest(type: string): Frame | undefined;
  lines(): string[];
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
        const id = frames.find((f) => f['t'] === 'welcome')?.['selfId'];
        if (typeof id === 'string') return id;
        if (Date.now() >= deadline) throw new Error('no welcome came back');
        await sleep(5);
      }
    },
    latest(type: string): Frame | undefined {
      return [...frames].reverse().find((f) => f['t'] === type);
    },
    lines(): string[] {
      const out: string[] = [];
      for (const frame of frames) {
        if (frame['t'] !== 'log') continue;
        const rows = frame['lines'];
        if (!Array.isArray(rows)) continue;
        for (const row of rows as unknown[]) {
          const text = (row as Record<string, unknown>)['text'];
          if (typeof text === 'string') out.push(text);
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

type Harness = { port: number; realms: Realms; parties: PartyState; close: () => Promise<void> };
let server: Harness;

beforeEach(async () => {
  const downed = createDownedState();
  const parties = createPartyState();
  const realms = createRealms({
    seed: 'two-players',
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
    parties,
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

/** Every name in a frame's `members` array. */
function membersIn(frame: Frame | undefined): string[] {
  const rows = frame?.['members'];
  if (!Array.isArray(rows)) return [];
  return (rows as unknown[]).map((row) => String((row as Record<string, unknown>)['name']));
}

describe('somebody else turns up', () => {
  it('tells the person already here, and shows them to each other', async () => {
    const first = await connect(server.port);
    await first.hello();
    await sleep(100);
    const before = first.lines().length;

    const second = await connect(server.port);
    await second.hello();
    await sleep(200);

    // THE ARRIVAL IS AN EVENT, not something you notice by looking at the map.
    expect(
      first
        .lines()
        .slice(before)
        .some((line) => line.includes('arrives')),
    ).toBe(true);

    // AND THE NEWCOMER CAN SEE WHO WAS ALREADY STANDING THERE. `welcome` carries
    // the actor list, so there is no window where the world looks empty.
    const seen = second.latest('welcome')?.['actors'];
    expect(Array.isArray(seen)).toBe(true);
    expect((seen as unknown[]).length).toBeGreaterThan(1);
  });

  it('does not pretend two strangers are playing together', async () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE ONE THING THAT WOULD MATTER IF IT WERE WRONG.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `awardExperience` pays `membersOf(parties, killerId)` — the actual party,
     * not everybody in the room. So two people standing side by side who have
     * not partied are each earning alone, and a pane that showed them as a party
     * would be teaching them to expect a share they are not getting.
     *
     * `ui/partypanel.ts` draws `party_state` and nothing else, and its header
     * records fixing this exact bug once already: *"a player alone on the floor
     * was shown a party they were not in"*. This is that fix, asserted from the
     * wire rather than from the comment.
     */
    const first = await connect(server.port);
    const firstId = await first.hello();
    const second = await connect(server.port);
    const secondId = await second.hello();
    await sleep(200);

    // THE PARTY IS HONEST: each of them is alone in it.
    expect(membersIn(second.latest('party_state'))).toHaveLength(1);
    expect(membersIn(first.latest('party_state'))).toHaveLength(1);

    // AND THE ENGINE AGREES, which is what makes the pane's honesty matter:
    // experience follows this list, so a shared pane over separate parties would
    // be a promise the scheduler does not keep.
    expect(membersOf(server.parties, firstId)).toEqual([firstId]);
    expect(membersOf(server.parties, secondId)).toEqual([secondId]);
  });

  it('lists everyone present in the OTHER frame, which is a different question', async () => {
    /**
     * `party` is who is HERE and `party_state` is who you are PLAYING WITH. Two
     * frames because they are two questions — the turn strip needs everybody in
     * the realm to draw a card per body, and the party pane needs your own
     * party. Asserting the difference so neither is ever "simplified" into the
     * other by somebody who finds two frames redundant.
     */
    const first = await connect(server.port);
    await first.hello();
    const second = await connect(server.port);
    await second.hello();
    await sleep(200);

    expect(membersIn(second.latest('party'))).toHaveLength(2);
    expect(membersIn(second.latest('party_state'))).toHaveLength(1);
  });

  it('puts them in one party when one invites and the other accepts', async () => {
    // THE VERB EXISTS AND IS REACHABLE: `ui/verbs.ts` offers `Invite to party`
    // on a right-click of any player who is not already in yours. This is the
    // wire half of that gesture, and the state it is supposed to produce.
    const first = await connect(server.port);
    const firstId = await first.hello();
    const second = await connect(server.port);
    const secondId = await second.hello();
    await sleep(150);

    first.send({ t: 'party', action: 'invite', targetId: secondId });
    await sleep(150);
    second.send({ t: 'party', action: 'accept', targetId: firstId });
    await sleep(200);

    expect(membersOf(server.parties, firstId)).toHaveLength(2);
    expect(membersOf(server.parties, secondId)).toContain(firstId);
    // …and the pane now says so, for both of them.
    expect(membersIn(second.latest('party_state'))).toHaveLength(2);
  });
});
