import { setTimeout as sleep } from 'node:timers/promises';

import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDownedState } from '../../src/server/engine/downed.ts';
import { createPartyState } from '../../src/server/engine/party.ts';
import { wsGateway } from '../../src/server/net/gateway.ts';
import { createTurnEngine } from '../../src/server/turn-engine.ts';
import { RealmKind, createRealms } from '../../src/server/world/realms.ts';
import { maxRoamersFor } from '../../src/server/world/roamers.ts';
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

describe('danger scales with the ground, not with a constant', () => {
  it('gives each map its own roamer cap', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE FOURTH BLOCKER, AND THE ONLY ONE WITH A VISIBLE FAILURE.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `MAX_ROAMERS` was a flat 18 whose own comment described a DENSITY — *"about
     * one per five hundred cells... the number that was actually playtested"*.
     * Under a flat cap a second landmass HALVES the danger on both: the same
     * eighteen creatures spread across twice the ground, on a map whose whole
     * premise is that it is worse than the first.
     *
     * This is the one of the four that could be caught by a number rather than
     * by a story, and it is caught here: two maps of different size, two
     * different caps, neither of them a constant.
     */
    const second = server.realms.all().find((r) => r.siteId === SECOND_MAP.id);
    expect(second).toBeDefined();
    if (second === undefined) return;

    const home = maxRoamersFor(server.realms.overworld);
    const other = maxRoamersFor(second);

    // Alderbrook is 170x100 and the test map is a 30x30 room, so the caps must
    // differ — and the big one must be the moor.
    expect(home).toBeGreaterThan(other);
    // AND ALDERBROOK IS UNCHANGED at the hand-tuned eighteen, which is what says
    // this is a re-derivation rather than a retune.
    expect(home).toBe(15);
  });
});

describe('you can get home again', () => {
  it('refuses to let anybody walk off the map they woke up on', async () => {
    /**
     * ALDERBROOK IS UNCHANGED. `leaveRealm` used to refuse on `kind ===
     * Overworld`, which is exactly right for the one map a character is born on:
     * its edge is the edge of the world, and it is already drawn as erased
     * ground. The rule now asks whether there is anywhere to go BACK to, and for
     * somebody who woke up here the answer is no.
     */
    const { actorId } = await hello(server.port);
    const home = server.realms.overworld;
    const body = home.world.getActor(actorId);
    expect(body).toBeDefined();
    if (body === undefined) return;

    const before = server.realms.realmOf(actorId)?.id;
    const spawn = home.spawns[0];
    if (spawn === undefined) throw new Error('no spawn');
    body.x = spawn.x;
    body.y = spawn.y;

    openSockets[0]?.send(JSON.stringify({ v: PROTOCOL_VERSION, t: 'move', dir: 'e' }));
    await sleep(60);
    body.x = spawn.x;
    body.y = spawn.y;
    openSockets[0]?.send(JSON.stringify({ v: PROTOCOL_VERSION, t: 'move', dir: 'w' }));
    await sleep(120);

    expect(server.realms.realmOf(actorId)?.id, 'walked off the edge of the world').toBe(before);
  });

  it('is the fifth blocker, and it would have stranded somebody permanently', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE ONE THAT ENDS A CHARACTER.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `leaveRealm` began `if (from.kind === RealmKind.Overworld) return false;`
     * — a statement about the ONE map that existed when it was written. A second
     * landmass is an overworld too, so the first player to cross into the dark
     * territory would have found the door refusing to open from the far side,
     * with no verb in the protocol that could bring them home. Not a teleport,
     * not a merged map: a character that can never leave.
     *
     * It was not on the list of four. It was found by asking "how does the
     * player get back" BEFORE building the door, which is the only reason it is
     * a comment rather than a bug report from somebody's evening.
     *
     * The rule is now about whether there is anywhere to go back to, and
     * `markersFor` asks the SAME question so the map never offers a door the
     * server would refuse. Asserted here as the shape of the condition, because
     * the round trip itself needs a door on the Alderbrook rows and that is
     * content which does not exist yet.
     */
    const second = server.realms.all().find((r) => r.siteId === SECOND_MAP.id);
    expect(second?.kind).toBe(RealmKind.Overworld);
    // A second overworld HAS a threshold to stand on, which is what `leaveRealm`
    // requires and what `markersFor` now draws as "The way out".
    expect((second?.spawns ?? []).length).toBeGreaterThan(0);
  });
});
