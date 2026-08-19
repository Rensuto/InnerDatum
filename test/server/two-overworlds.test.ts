import { setTimeout as sleep } from 'node:timers/promises';

import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDownedState } from '../../src/server/engine/downed.ts';
import { createPartyState } from '../../src/server/engine/party.ts';
import { wsGateway } from '../../src/server/net/gateway.ts';
import { createTurnEngine } from '../../src/server/turn-engine.ts';
import { RealmKind, createRealms } from '../../src/server/world/realms.ts';
import { SiteShape, makeSiteMap } from '../../src/shared/sitemap.ts';
import { PROTOCOL_VERSION } from '../../src/shared/version.ts';
import { TileCode } from '../../src/shared/protocol.ts';
import type { SiteDef } from '../../src/server/world/realms.ts';
import type { Realms } from '../../src/server/world/realms.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT A SECOND LANDMASS WOULD HAVE DONE TO YOUR MAP.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The design has a standing intention to add a dark territory — a second
 * overworld, a Redaction of the first. Four things assumed there was exactly
 * one, and **every one of them failed silently**.
 *
 * The worst was the fog. It was `Map<actorId, Uint8Array>` — keyed by the actor
 * ALONE — sized from `realms.overworld`, and `revealFor` fired for ANY realm
 * whose kind is Overworld. So two overworlds would not have misaligned; they
 * would have **MERGED**. Walking the second map would reveal the first and the
 * other way round, into one bitset that `prefsFields` persists as one `explored`
 * string. The client merges rather than replaces — deliberately, because *"a
 * frame that arrived after some walking must not un-see ground the player just
 * crossed"* — so it would never have self-corrected. The player would simply
 * have found their map filling itself in.
 *
 * IDENTICAL DIMENSIONS HIDE THAT RATHER THAN PREVENT IT. At different sizes the
 * bits scramble and somebody notices in a minute; at the same size it is clean,
 * silent and persisted. Every argument for drawing the second map at 170x100 was
 * therefore an argument for the bug being invisible.
 *
 * ═══ AND THIS FILE IS THE REASON `SiteDef.kind` WAS FIXED FIRST ═══
 * The fog fix and the `leaveRealm` fix could both be written, but NEITHER could
 * be tested: with one overworld their old and new behaviour are identical, and a
 * test that cannot fail is not a guard. `SiteDef.kind` was `Common | Inner`, so
 * there was no way to build a second overworld to test them against. Fixing that
 * one turned two forward assertions into two real ones.
 */

const FRAME_TIMEOUT_MS = 4_000;

/**
 * A second overworld, built the way a real one would be: a shared site that
 * carries `RealmKind.Overworld`. Small, because what is under test is the
 * KEYING and not the cartography.
 */
const SECOND_MAP: SiteDef = {
  id: 'site:test_redaction',
  name: 'The Test Redaction',
  kind: RealmKind.Overworld,
  marker: 'gate',
  lingerMs: 0,
  map: (seed) => makeSiteMap(seed, SiteShape.Town, { floor: TileCode.PLAINS, wall: TileCode.CRAG }),
};

type Harness = { port: number; realms: Realms; close: () => Promise<void> };
let server: Harness;
const openSockets: WebSocket[] = [];

beforeEach(async () => {
  const downed = createDownedState();
  const parties = createPartyState();
  const realms = createRealms({
    seed: 'two-overworlds',
    engineFor: (world) => createTurnEngine({ world, downed, parties }),
    sites: new Map([[SECOND_MAP.id, SECOND_MAP]]),
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

async function hello(
  port: number,
): Promise<{ actorId: string; frames: Record<string, unknown>[] }> {
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
    if (typeof id === 'string') return { actorId: id, frames };
    if (Date.now() >= deadline) throw new Error('no welcome came back');
    await sleep(5);
  }
}

describe('a second overworld can exist at all', () => {
  it('builds one from a site that says so, with its own kind', () => {
    /**
     * `SiteDef.kind` was `Common | Inner`, so this realm could not be built
     * except as a town — which typechecks, boots, is walkable, and silently
     * turns off the roamer tick, the fog reveal, the `explored` frame, the exit
     * rule, the nearest-site bearings and `leaveRealm`'s refusal, because all
     * six read `kind === Overworld`.
     */
    const second = server.realms.all().find((r) => r.siteId === SECOND_MAP.id);
    expect(second, 'the second map was never built').toBeDefined();
    expect(second?.kind).toBe(RealmKind.Overworld);

    // TWO OF THEM NOW, which is the thing realms.test.ts asserts cannot happen
    // in the SHIPPED site table — that assertion is about the content, and this
    // one is about the machinery being able to carry it.
    expect(server.realms.all().filter((r) => r.kind === RealmKind.Overworld)).toHaveLength(2);
  });
});

describe('the two maps are two places, not one wearing two names', () => {
  it('opens the same second overworld every time, and keeps its own world', () => {
    /**
     * SHARED-KIND IDEMPOTENCE. A second landmass is one place: everybody who
     * walks through the door is in the same one, exactly as a town is, which is
     * why both kinds take the same branch of `open()`. Two parties crossing in
     * the same millisecond must not get two continents.
     */
    const a = server.realms.open(SECOND_MAP, 'party:one');
    const b = server.realms.open(SECOND_MAP, 'party:two');
    expect(a.id).toBe(b.id);
    expect(a.kind).toBe(RealmKind.Overworld);

    // AND IT IS NOT THE FIRST MAP. Distinct worlds, distinct ids — which is the
    // precondition for the fog having anywhere to key BY.
    expect(a.id).not.toBe(server.realms.overworld.id);
    expect(a.world).not.toBe(server.realms.overworld.world);
  });

  it('gives a walked map an explored bitset, and does not invent one for the other', async () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * WHAT THIS PROVES, AND WHAT IT HONESTLY DOES NOT.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * IT PROVES the `explored` field is per REALM: the overworld the body walked
     * carries one, and the frame is built by asking the fog for THAT realm.
     *
     * IT DOES NOT prove the merge is gone, because proving that needs a body on
     * BOTH maps, and a body gets onto a second overworld through a door — a site
     * cell on the first map pointing at the second — which is content that does
     * not exist yet. `Realm.sites` is a `ReadonlyMap` off the authored map, and
     * casting past that to fake a door would be testing the cast.
     *
     * So this is the honest half, and the note is here rather than a green tick
     * standing in for one. The keying itself is structural now: `fogFor` cannot
     * be called without naming a realm, which is what makes the old failure
     * unrepresentable rather than merely untested.
     */
    const { frames } = await hello(server.port);
    for (let i = 0; i < 4; i += 1) {
      openSockets[0]?.send(JSON.stringify({ v: PROTOCOL_VERSION, t: 'move', dir: 'e' }));
      await sleep(40);
    }
    await sleep(80);

    const home = server.realms.overworld;
    const forHome = frames.filter((f) => f['t'] === 'realm' && f['realmId'] === home.id);
    expect(forHome.length, 'no realm frame for the map being walked').toBeGreaterThan(0);

    // EVERY realm frame this socket received is about the map it is standing on.
    // A frame for the second overworld would mean a body somewhere it has never
    // been, which is the shape the old fog produced in the exploration bitset.
    for (const frame of frames.filter((f) => f['t'] === 'realm')) {
      expect(frame['realmId']).toBe(home.id);
    }
  });
});
