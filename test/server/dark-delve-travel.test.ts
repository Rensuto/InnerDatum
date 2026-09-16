// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

import { setTimeout as sleep } from 'node:timers/promises';

import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { exploreTarget } from '../../src/client/input/explore.ts';
import {
  MouseIntentKind,
  mouseIntentAt,
  travelTargetAllowed,
} from '../../src/client/input/mouseintent.ts';
import { readVisionFrame } from '../../src/client/vision.ts';
import { createDownedState } from '../../src/server/engine/downed.ts';
import { createPartyState } from '../../src/server/engine/party.ts';
import { wsGateway } from '../../src/server/net/gateway.ts';
import { createTurnEngine } from '../../src/server/turn-engine.ts';
import { createRealms } from '../../src/server/world/realms.ts';
import { DIR_ORDER, step } from '../../src/shared/coords.ts';
import { fogBytes, fogFromBase64, fogHas } from '../../src/shared/fog.ts';
import { canRoute, canWalk } from '../../src/shared/level.ts';
import { PROTOCOL_VERSION } from '../../src/shared/version.ts';
import type { VisionWindow } from '../../src/client/vision.ts';
import type { Realm, Realms } from '../../src/server/world/realms.ts';
import type { TileXY } from '../../src/shared/coords.ts';
import type { LevelView, RealmMsg, VisionMsg } from '../../src/shared/protocol.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A CLICK MOVES YOU IN A DARK DELVE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Reported live: "when in delve. it gives error and doesnt allow player to move
 * at all." The Underworks drew only the lantern's diamond of floor round the
 * body, and every click on it answered "you have not seen that ground".
 *
 * Every half of that was tested and correct. The server shows a lantern's
 * ground and keeps none of it when the ground is dark (darkness.test.ts pins
 * it, as upstream's `applyLite` does), and `mouseIntentAt` refuses ground the
 * set it is handed does not hold (mouseintent.test.ts pins that, against a set
 * holding every tile). What nothing drove was the line between them: the set
 * main.ts builds out of the server's frames, handed to the click. So this file
 * walks a player through the Underworks' real door, replays every frame through
 * the client's own reader, and asks the client's own click.
 *
 * Nothing is cleared and nothing is placed after the door: the floor's own
 * population is there, and the body is where the server put it.
 */

const FRAME_TIMEOUT_MS = 4_000;
const UNDERWORKS = 'site:underworks';

describe('a click in a dark delve, over the wire', () => {
  let harness: { port: number; realms: Realms; close: () => Promise<void> };
  const sockets: WebSocket[] = [];

  beforeEach(async () => {
    const downed = createDownedState();
    const parties = createPartyState();
    const realms = createRealms({
      seed: 'dark-delve-travel',
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
    harness = {
      port: address.port,
      realms,
      close: async (): Promise<void> => {
        await app.close();
      },
    };
  });

  afterEach(async () => {
    for (const socket of sockets) socket.close();
    sockets.length = 0;
    await harness.close();
  });

  type Client = {
    readonly actorId: string;
    readonly frames: readonly Record<string, unknown>[];
    move(dir: string): Promise<void>;
  };

  async function join(): Promise<Client> {
    const socket = new WebSocket(`ws://127.0.0.1:${String(harness.port)}/ws`);
    sockets.push(socket);
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
          frames,
          async move(dir: string): Promise<void> {
            socket.send(JSON.stringify({ v: PROTOCOL_VERSION, t: 'move', dir }));
            await sleep(250);
          },
        };
      }
      if (Date.now() >= deadline) throw new Error('no welcome came back');
      await sleep(5);
    }
  }

  function realmOf(client: Client): Realm {
    const realm = harness.realms.realmOf(client.actorId);
    if (realm === undefined) throw new Error('the body is in no realm');
    return realm;
  }

  function bodyOf(client: Client): TileXY {
    const body = realmOf(client).world.getActor(client.actorId);
    if (body === undefined) throw new Error('no body');
    return { x: body.x, y: body.y };
  }

  /** In through the Underworks' own door, by a real step onto it. */
  async function enterTheUnderworks(client: Client): Promise<Realm> {
    const overworld = harness.realms.overworld;
    const door = [...overworld.sites].find(([, id]) => id === UNDERWORKS);
    if (door === undefined) throw new Error('no door to the Underworks');
    const [dx, dy] = door[0].split(',').map(Number);
    if (dx === undefined || dy === undefined) throw new Error('a bad door cell');
    const body = overworld.world.getActor(client.actorId);
    if (body === undefined) throw new Error('no body');
    for (const dir of DIR_ORDER) {
      const from = step({ x: dx, y: dy }, OPPOSITE[dir]);
      if (!canWalk(overworld.world.level, from.x, from.y)) continue;
      if (overworld.world.actorAt(from.x, from.y) !== undefined) continue;
      body.x = from.x;
      body.y = from.y;
      await client.move(dir);
      break;
    }
    const realm = realmOf(client);
    expect(realm.siteId, 'never went in').toBe(UNDERWORKS);
    return realm;
  }

  const OPPOSITE = {
    n: 's',
    ne: 'sw',
    e: 'w',
    se: 'nw',
    s: 'n',
    sw: 'ne',
    w: 'e',
    nw: 'se',
  } as const;

  /** Until a vision frame of `realmId` has arrived since `from` frames. */
  async function visionSince(client: Client, realmId: string, from: number): Promise<void> {
    const deadline = Date.now() + FRAME_TIMEOUT_MS;
    while (
      !client.frames.slice(from).some((f) => f['t'] === 'vision' && f['realmId'] === realmId)
    ) {
      if (Date.now() >= deadline) throw new Error('no vision frame came');
      await sleep(10);
    }
  }

  /**
   * WHAT main.ts HOLDS OF THE MAP ON SCREEN, built from the frames in the order
   * they came and exactly as its socket handler builds it: a `realm` frame makes
   * its map the one on screen and merges its `explored` into memory and has-seen,
   * and a `vision` frame for the map on screen goes through `readVisionFrame`.
   * hudwiring.test.ts pins that main.ts does those three things.
   */
  function replay(frames: readonly Record<string, unknown>[]): {
    readonly level: LevelView;
    readonly memory: Set<string>;
    readonly hasSeen: Set<string>;
    readonly window: VisionWindow;
  } {
    const explored = new Map<string, Set<string>>();
    const hasSeen = new Map<string, Set<string>>();
    let currentRealmId: string | null = null;
    let level: LevelView | null = null;
    let window: VisionWindow | null = null;
    for (const frame of frames) {
      if (frame['t'] === 'realm') {
        const msg = frame as unknown as RealmMsg;
        currentRealmId = msg.realmId;
        level = msg.level;
        window = null;
        if (msg.explored !== undefined) {
          const bits = fogFromBase64(msg.explored, fogBytes(msg.level.w, msg.level.h));
          const memory = explored.get(msg.realmId) ?? new Set<string>();
          const everSeen = hasSeen.get(msg.realmId) ?? new Set<string>();
          for (let y = 0; y < msg.level.h; y += 1) {
            for (let x = 0; x < msg.level.w; x += 1) {
              if (!fogHas(bits, msg.level.w, x, y)) continue;
              memory.add(`${String(x)},${String(y)}`);
              everSeen.add(`${String(x)},${String(y)}`);
            }
          }
          explored.set(msg.realmId, memory);
          hasSeen.set(msg.realmId, everSeen);
        }
      } else if (frame['t'] === 'vision') {
        const msg = frame as unknown as VisionMsg;
        if (msg.realmId !== currentRealmId) continue;
        const memory = explored.get(msg.realmId) ?? new Set<string>();
        explored.set(msg.realmId, memory);
        const everSeen = hasSeen.get(msg.realmId) ?? new Set<string>();
        hasSeen.set(msg.realmId, everSeen);
        window = readVisionFrame(msg, memory, everSeen);
      }
    }
    if (level === null || window === null || currentRealmId === null) {
      throw new Error('no map and no window reached the client');
    }
    return {
      level,
      memory: explored.get(currentRealmId) ?? new Set<string>(),
      hasSeen: hasSeen.get(currentRealmId) ?? new Set<string>(),
      window,
    };
  }

  const key = (t: TileXY): string => `${String(t.x)},${String(t.y)}`;

  function inWindow(window: VisionWindow, bits: Uint8Array, t: TileXY): boolean {
    const x = t.x - window.x0;
    const y = t.y - window.y0;
    return x >= 0 && y >= 0 && x < window.w && y < window.h && fogHas(bits, window.w, x, y);
  }

  it('walks onto the lantern-lit floor round the body, and back to floor it has left', async () => {
    const client = await join();
    const realm = await enterTheUnderworks(client);
    // THE FIXTURE IS DARK, checked rather than assumed: the cave is unlit end to
    // end, so none of its floor is ever remembered.
    expect(
      realm.world.lit.every((bit) => bit === 0),
      'precondition: the Underworks is dark',
    ).toBe(true);
    await visionSince(client, realm.id, 0);

    const world = realm.world;
    const first = replay(client.frames);
    const me = bodyOf(client);
    const lanternFloor: TileXY[] = [];
    for (let y = first.window.y0; y < first.window.y0 + first.window.h; y += 1) {
      for (let x = first.window.x0; x < first.window.x0 + first.window.w; x += 1) {
        const tile = { x, y };
        if (!inWindow(first.window, first.window.seen, tile)) continue;
        if (x === me.x && y === me.y) continue;
        if (!canRoute(first.level, x, y) || world.actorAt(x, y) !== undefined) continue;
        lanternFloor.push(tile);
      }
    }
    // THE FIXTURE MUST DISCRIMINATE: open floor in sight, none of it remembered.
    // A lit level, or a window of walls, would pass the assertions below whatever
    // the click's gate reads.
    expect(lanternFloor.length, 'no open floor in the lantern').toBeGreaterThan(0);
    expect(
      lanternFloor.filter((t) => first.memory.has(key(t))),
      'the server remembered dark floor: this fixture cannot test the dark',
    ).toEqual([]);
    expect(
      lanternFloor.some((t) => Math.max(Math.abs(t.x - me.x), Math.abs(t.y - me.y)) === 1),
      'no open floor beside the body',
    ).toBe(true);

    // ═══ THE CLICK, ON EVERY TILE OF IT ═══
    for (const tile of lanternFloor) {
      const intent = mouseIntentAt({
        self: me,
        tile,
        actors: [],
        level: first.level,
        hasSeen: first.hasSeen,
      });
      expect(intent, `a click on ${key(tile)}, in the lantern`).toEqual({
        kind: MouseIntentKind.Travel,
        to: tile,
        stopShort: false,
      });
    }

    // ═══ AND AUTO-EXPLORE, which floods on the same predicate ═══
    const explore = exploreTarget({
      from: me,
      w: first.level.w,
      h: first.level.h,
      passable: (x, y) => travelTargetAllowed(first.level, { x, y }, first.hasSeen),
      seen: first.hasSeen,
      items: [],
      threat: null,
    });
    expect(explore.go, 'auto-explore found no way off the tile it stands on').toBe(true);

    // ═══ A KEYBOARD STEP WAS NEVER REFUSED, and it carries the lantern away ═══
    const start = me;
    for (let walked = 0; walked < 3; walked += 1) {
      const here = bodyOf(client);
      const dir = DIR_ORDER.find((d) => {
        const to = step(here, d);
        const farther =
          Math.max(Math.abs(to.x - start.x), Math.abs(to.y - start.y)) >
          Math.max(Math.abs(here.x - start.x), Math.abs(here.y - start.y));
        return (
          farther && canWalk(world.level, to.x, to.y) && world.actorAt(to.x, to.y) === undefined
        );
      });
      if (dir === undefined) break;
      const before = client.frames.length;
      await client.move(dir);
      expect(bodyOf(client), `the keyboard step ${dir} was refused`).toEqual(step(here, dir));
      await visionSince(client, realm.id, before);
    }

    const later = replay(client.frames);
    const now = bodyOf(client);
    const behind = lanternFloor.filter(
      (t) =>
        !inWindow(later.window, later.window.seen, t) &&
        !(t.x === now.x && t.y === now.y) &&
        world.actorAt(t.x, t.y) === undefined,
    );
    expect(behind.length, 'the walk left no lantern-lit floor out of sight').toBeGreaterThan(0);
    for (const tile of behind) {
      const intent = mouseIntentAt({
        self: now,
        tile,
        actors: [],
        level: later.level,
        hasSeen: later.hasSeen,
      });
      expect(intent.kind, `a click back on ${key(tile)}, seen and left behind`).toBe(
        MouseIntentKind.Travel,
      );
    }
  });
});
