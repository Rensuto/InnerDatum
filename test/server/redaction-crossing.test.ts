import { setTimeout as sleep } from 'node:timers/promises';

import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDownedState } from '../../src/server/engine/downed.ts';
import { createPartyState } from '../../src/server/engine/party.ts';
import { wsGateway } from '../../src/server/net/gateway.ts';
import { createTurnEngine } from '../../src/server/turn-engine.ts';
import { RealmKind, SITES, createRealms } from '../../src/server/world/realms.ts';
import { REDACTION_SITE_ID } from '../../src/shared/level.ts';
import { PROTOCOL_VERSION } from '../../src/shared/version.ts';
import type { Realms } from '../../src/server/world/realms.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE ROUND TRIP. ALDERBROOK → THE REDACTION → ALDERBROOK, OVER A SOCKET.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `two-overworlds.test.ts` proved a second overworld was POSSIBLE using a
 * synthetic site, and its last test ends by saying the round trip itself
 * *"needs a door on the Alderbrook rows"*. There is one now, at (22,60), so
 * this is that test: the real registry, the real map, the real glyph, and a
 * real body walking through it and back.
 *
 * ═══ WHY THIS IS THE FILE THAT MATTERS OUT OF THE THREE ═══
 * The shared tests prove the map is sound and the registry probe proves the
 * sites resolve. Neither would have caught the fifth blocker, which was a
 * one-line refusal in `leaveRealm` that no map-shaped assertion can see: the
 * player crosses fine, and then the door does not open from the far side, and
 * there is no verb in the protocol that brings them home. A character that can
 * never leave. The only thing that finds that is going there and coming back.
 *
 * THE POSITION IS SET DIRECTLY AND THE STEP IS A REAL INTENT, which is the same
 * shortcut `two-overworlds.test.ts` takes and for the same reason: the door is
 * 99 tiles from the spawn and walking it over a socket would be a minute of
 * wall-clock for nothing. The CROSSING is not shortcut — it is a `move` frame
 * through `dispatch`, resolved by the scheduler, exactly as a player's is.
 */

const FRAME_TIMEOUT_MS = 4_000;

type Harness = { port: number; realms: Realms; close: () => Promise<void> };
let server: Harness;
const openSockets: WebSocket[] = [];

beforeEach(async () => {
  const downed = createDownedState();
  const parties = createPartyState();
  // THE REAL `SITES`, deliberately: every other socket suite here supplies its
  // own table, and a door wired only into a fixture is a door nobody can use.
  const realms = createRealms({
    seed: 'redaction-crossing',
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

async function hello(
  port: number,
): Promise<{ actorId: string; frames: Record<string, unknown>[]; socket: WebSocket }> {
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
    if (typeof id === 'string') return { actorId: id, frames, socket };
    if (Date.now() >= deadline) throw new Error('no welcome came back');
    await sleep(5);
  }
}

/** The most recent frame of a type, which is the one the player is looking at. */
function latest(
  frames: Record<string, unknown>[],
  type: string,
): Record<string, unknown> | undefined {
  return [...frames].reverse().find((f) => f['t'] === type);
}

/** Where the door is, read off the map rather than written down twice. */
function doorCell(realms: Realms): { x: number; y: number } {
  const found = [...realms.overworld.sites].find(([, id]) => id === REDACTION_SITE_ID);
  if (found === undefined) throw new Error('no door to the Redaction on the Alderbrook rows');
  const [xs, ys] = found[0].split(',');
  return { x: Number(xs), y: Number(ys) };
}

/**
 * Put the body one step west of `cell` and step east onto it.
 *
 * The step is a real `move` intent so the crossing runs the handler a player's
 * keypress runs. The placement is not — see the header.
 */
async function stepOnto(
  realms: Realms,
  actorId: string,
  socket: WebSocket,
  cell: { x: number; y: number },
): Promise<void> {
  const realm = realms.realmOf(actorId);
  const body = realm?.world.getActor(actorId);
  if (body === undefined) throw new Error('no body to move');
  body.x = cell.x - 1;
  body.y = cell.y;
  socket.send(JSON.stringify({ v: PROTOCOL_VERSION, t: 'move', dir: 'e' }));
  await sleep(200);
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WALK OFF THE DOORSTEP AND BACK ONTO IT, WHICH IS WHAT LEAVING ACTUALLY IS.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `Session.exitArmed`: you arrive STANDING ON the threshold, so "standing on
 * the threshold means leave" would bounce every player straight back out of
 * every door they walked through. The rule is that you have to step off it
 * first, and the flag is set inside `leaveRealm` by a move that lands anywhere
 * else — which means the arming CANNOT be faked by assigning coordinates.
 *
 * The first version of this helper did exactly that and reported the round trip
 * as broken. It was not: it was a test that had skipped a step a player cannot
 * skip. Both moves here are real intents for that reason.
 */
async function stepOffAndBack(
  realms: Realms,
  actorId: string,
  socket: WebSocket,
  cell: { x: number; y: number },
): Promise<void> {
  const body = realms.realmOf(actorId)?.world.getActor(actorId);
  if (body === undefined) throw new Error('no body to move');
  body.x = cell.x;
  body.y = cell.y;
  // OFF — this is the move that arms the exit.
  socket.send(JSON.stringify({ v: PROTOCOL_VERSION, t: 'move', dir: 'w' }));
  await sleep(200);
  // AND BACK ON.
  socket.send(JSON.stringify({ v: PROTOCOL_VERSION, t: 'move', dir: 'e' }));
  await sleep(250);
}

describe('walking into the dark territory', () => {
  it('crosses onto a second overworld that names itself', async () => {
    const { actorId, frames, socket } = await hello(server.port);
    expect(server.realms.realmOf(actorId)?.id).toBe(server.realms.overworld.id);

    await stepOnto(server.realms, actorId, socket, doorCell(server.realms));

    const now = server.realms.realmOf(actorId);
    expect(now?.id, 'the door did not open').toBe(`realm:${REDACTION_SITE_ID}`);
    // AND IT IS AN OVERWORLD, which is not cosmetic: six subsystems read this
    // field, including the roamer tick and the way home. See `SiteDef.kind`.
    expect(now?.kind).toBe(RealmKind.Overworld);

    // THE PLAYER IS TOLD. The two maps look alike on purpose, so the name in the
    // frame is most of what distinguishes them on screen.
    const realm = latest(frames, 'realm');
    expect(realm?.['name']).toBe('The Redaction');
    expect(realm?.['kind']).toBe(RealmKind.Overworld);
  });

  it('draws the way home, and it opens', async () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE FIFTH BLOCKER, DRIVEN RATHER THAN ARGUED.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `leaveRealm` began `if (from.kind === RealmKind.Overworld) return false;`
     * and `markersFor` drew no exit on an overworld for the same reason. Both
     * were true of the one map that existed when they were written. Either one
     * alone strands the player: without the marker they cannot find the tile,
     * and without the rule the tile does nothing.
     *
     * So this asserts BOTH HALVES on the far side — the marker is drawn, and
     * standing on it works — because a test that only checked the second would
     * pass against a build where the way home is invisible.
     */
    const { actorId, frames, socket } = await hello(server.port);
    await stepOnto(server.realms, actorId, socket, doorCell(server.realms));

    const there = server.realms.realmOf(actorId);
    expect(there?.id).toBe(`realm:${REDACTION_SITE_ID}`);
    const arrival = there?.spawns[0];
    if (arrival === undefined) throw new Error('the Redaction has no arrival tile');

    // ── the marker is on the map ───────────────────────────────────────────
    const sites = latest(frames, 'realm')?.['sites'];
    expect(Array.isArray(sites)).toBe(true);
    const wayOut = (sites as Record<string, unknown>[]).find(
      (s) => s['x'] === arrival.x && s['y'] === arrival.y,
    );
    expect(wayOut, 'no way out drawn on the far map').toBeDefined();
    expect(wayOut?.['name']).toBe('The way out');

    // ── and standing on it works ───────────────────────────────────────────
    await stepOffAndBack(server.realms, actorId, socket, arrival);
    expect(server.realms.realmOf(actorId)?.id, 'stranded on the far map').toBe(
      server.realms.overworld.id,
    );
  });

  it('puts them back on the Alderbrook side of the door they used', async () => {
    // NOT AT THE SPAWN. Being teleported to the city after a crossing would
    // undo the ninety-nine tiles the player walked to get here, which is the
    // difference between a door and a fast-travel node.
    const { actorId, socket } = await hello(server.port);
    const door = doorCell(server.realms);
    await stepOnto(server.realms, actorId, socket, door);
    const arrival = server.realms.realmOf(actorId)?.spawns[0];
    if (arrival === undefined) throw new Error('no arrival tile');
    await stepOffAndBack(server.realms, actorId, socket, arrival);

    const home = server.realms.realmOf(actorId);
    expect(home?.id).toBe(server.realms.overworld.id);
    const body = home?.world.getActor(actorId);
    expect(body).toBeDefined();
    if (body === undefined) return;
    expect(Math.max(Math.abs(body.x - door.x), Math.abs(body.y - door.y))).toBeLessThanOrEqual(2);
  });

  it('is a place with somewhere to go, not seven thousand empty cells', async () => {
    /**
     * The map being crossable is `test/shared/redaction.test.ts`'s job. This is
     * the other half of it: that the doors on it RESOLVE — every marker the far
     * map draws has a `SiteDef` behind it, and opening one produces a floor
     * with things on it. A marker with no definition is drawn and then does
     * nothing when you stand on it, which is the failure mode this repo has
     * shipped more times than any other.
     */
    const { actorId, socket } = await hello(server.port);
    await stepOnto(server.realms, actorId, socket, doorCell(server.realms));
    const there = server.realms.realmOf(actorId);
    if (there === undefined) throw new Error('never crossed');

    expect(there.sites.size).toBeGreaterThan(3);
    for (const [, siteId] of there.sites) {
      const def = SITES.get(siteId);
      expect(def, `${siteId} is drawn on the map and has no definition`).toBeDefined();
      // NOTHING OVER THERE IS A TOWN. See `REDACTED_TOWN` — a shared realm on
      // that map would have no shop, no townsfolk and no monsters, which is an
      // empty street grid rather than an eerie one.
      expect(def?.kind).toBe(RealmKind.Inner);
    }
  });
});
