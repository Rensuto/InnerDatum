// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

import { setTimeout as sleep } from 'node:timers/promises';

import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { floorsOf, specFor } from '../../src/server/content/delve.ts';
import { createDownedState } from '../../src/server/engine/downed.ts';
import { createPartyState } from '../../src/server/engine/party.ts';
import { wsGateway } from '../../src/server/net/gateway.ts';
import { createTurnEngine } from '../../src/server/turn-engine.ts';
import {
  SITES,
  STAIRS_DOWN_SITE_ID,
  createRealms,
  floorsOfSite,
  stairsDownOf,
} from '../../src/server/world/realms.ts';
import { canWalk } from '../../src/shared/level.ts';
import { ActorKind } from '../../src/shared/protocol.ts';
import { PROTOCOL_VERSION } from '../../src/shared/version.ts';
import type { Realm, Realms, SiteDef } from '../../src/server/world/realms.ts';
import type { TileXY } from '../../src/shared/coords.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A DELVE IS SEVERAL FLOORS DEEP, AS UPSTREAM'S ZONES ARE.
 * ═══════════════════════════════════════════════════════════════════════════
 */

const FRAME_TIMEOUT_MS = 4_000;
const UNDERWORKS = 'site:underworks';
/** The one room with a boss in it: Alderbrook's altar has none. */
const WATCHERS_ALTAR = 'site:redaction:watchers_altar';

function makeRealms(seed = 'floors'): Realms {
  const downed = createDownedState();
  const parties = createPartyState();
  return createRealms({ seed, engineFor: (world) => createTurnEngine({ world, downed, parties }) });
}

function site(id: string): SiteDef {
  const def = SITES.get(id);
  if (def === undefined) throw new Error(`no such site: ${id}`);
  return def;
}

function floorOf(realms: Realms, id: string, partyId: string, floor: number): Realm {
  return realms.open(site(id), partyId, undefined, undefined, undefined, floor);
}

describe('how deep a delve goes', () => {
  it('follows upstream`s tiers: a first-tier level is three floors, deeper is four', () => {
    const chapel = specFor('site:drowned_chapel');
    if (chapel === undefined) throw new Error('no chapel spec');
    expect(floorsOf({ ...chapel, levelRange: [1, 1] })).toBe(3);
    expect(floorsOf({ ...chapel, levelRange: [5, 5] }), 'the top of the first tier').toBe(3);
    expect(floorsOf({ ...chapel, levelRange: [6, 6] }), 'just past it').toBe(4);
    expect(floorsOf({ ...chapel, levelRange: [15, 15] })).toBe(4);
  });

  it('gives a town one floor', () => {
    expect(floorsOfSite('site:alderbrook')).toBe(1);
  });
});

describe('the floors of one delve', () => {
  it('opens each floor as its own instance, and the same one again', () => {
    const realms = makeRealms();
    const first = floorOf(realms, UNDERWORKS, 'party-a', 1);
    const second = floorOf(realms, UNDERWORKS, 'party-a', 2);
    expect(second.id).not.toBe(first.id);
    expect(first.floor).toBe(1);
    expect(second.floor).toBe(2);
    expect(floorOf(realms, UNDERWORKS, 'party-a', 2)).toBe(second);
    expect(realms.open(site(UNDERWORKS), 'party-a')).toBe(first);
  });

  it('puts one stair down on every floor but the last, on open ground off the threshold', () => {
    const realms = makeRealms();
    const floors = floorsOfSite(UNDERWORKS);
    expect(floors, 'a one-floor delve cannot test stairs').toBeGreaterThan(1);
    for (let floor = 1; floor <= floors; floor += 1) {
      const realm = floorOf(realms, UNDERWORKS, 'party-b', floor);
      const stairs = [...realm.sites.values()].filter((id) => id === STAIRS_DOWN_SITE_ID);
      expect(stairs.length, `floor ${String(floor)}`).toBe(floor < floors ? 1 : 0);
      const at = stairsDownOf(realm);
      if (floor === floors) {
        expect(at, 'the last floor has a stair down').toBeNull();
        continue;
      }
      if (at === null) throw new Error('no stair down');
      expect(canWalk(realm.world.level, at.x, at.y), 'the stair is not on open ground').toBe(true);
      expect(
        realm.spawns.some((t) => t.x === at.x && t.y === at.y),
        'the stair is on the threshold',
      ).toBe(false);
    }
  });

  it('builds each floor one level deeper, as upstream`s `base_level + level - 1`', () => {
    const realms = makeRealms();
    const first = floorOf(realms, UNDERWORKS, 'party-c', 1);
    const second = floorOf(realms, UNDERWORKS, 'party-c', 2);
    expect(first.baseLevel).toBeDefined();
    expect(second.baseLevel).toBe((first.baseLevel ?? 0) + 1);
    // AND THE BODIES THEMSELVES: the first of each floor's population is the same
    // roster entry, one level up.
    const leader = (realm: Realm): number | undefined =>
      realm.world.allActors().find((a) => a.id.endsWith('delve_0'))?.level;
    expect(leader(first), 'the first floor has no population').toBeDefined();
    expect(leader(second)).toBe((leader(first) ?? 0) + 1);
  });

  it('keeps the boss for the last floor', () => {
    const realms = makeRealms();
    const floors = floorsOfSite(WATCHERS_ALTAR);
    const bossOn = (floor: number): boolean =>
      floorOf(realms, WATCHERS_ALTAR, 'party-d', floor)
        .world.allActors()
        .some((a) => a.id.endsWith('delve_boss'));
    for (let floor = 1; floor < floors; floor += 1) {
      expect(bossOn(floor), `a boss on floor ${String(floor)}`).toBe(false);
    }
    expect(bossOn(floors), 'no boss on the last floor').toBe(true);
  });
});

describe('the stairs, over the wire', () => {
  let harness: { port: number; realms: Realms; close: () => Promise<void> };
  const sockets: WebSocket[] = [];

  beforeEach(async () => {
    const downed = createDownedState();
    const parties = createPartyState();
    const realms = createRealms({
      seed: 'floors-wire',
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

  const STEPS = [
    { dir: 'e', dx: 1, dy: 0, back: 'w' },
    { dir: 'w', dx: -1, dy: 0, back: 'e' },
    { dir: 's', dx: 0, dy: 1, back: 'n' },
    { dir: 'n', dx: 0, dy: -1, back: 's' },
  ] as const;

  function realmOf(client: Client): Realm {
    const realm = harness.realms.realmOf(client.actorId);
    if (realm === undefined) throw new Error('the body is in no realm');
    return realm;
  }

  /** Empty a floor of monsters, so nothing stands on a stair or shuts it with a kill. */
  function clear(realm: Realm): void {
    for (const actor of realm.world.allActors()) {
      if (actor.kind === ActorKind.Monster) realm.world.removeActor(actor.id);
    }
  }

  /** Put the body beside `cell` on open ground, and step onto it. */
  async function stepOnto(client: Client, cell: TileXY): Promise<void> {
    const realm = realmOf(client);
    const body = realm.world.getActor(client.actorId);
    if (body === undefined) throw new Error('no body');
    for (const step of STEPS) {
      const x = cell.x - step.dx;
      const y = cell.y - step.dy;
      if (!canWalk(realm.world.level, x, y) || realm.world.actorAt(x, y) !== undefined) continue;
      body.x = x;
      body.y = y;
      await client.move(step.dir);
      return;
    }
    throw new Error('no open ground beside the cell');
  }

  /** Stand on the threshold, step off it and back on: what leaving is. */
  async function leaveByThreshold(client: Client): Promise<void> {
    const realm = realmOf(client);
    const body = realm.world.getActor(client.actorId);
    if (body === undefined) throw new Error('no body');
    const onThreshold = (x: number, y: number): boolean =>
      realm.spawns.some((t) => t.x === x && t.y === y);
    for (const tile of realm.spawns) {
      for (const step of STEPS) {
        const x = tile.x + step.dx;
        const y = tile.y + step.dy;
        if (onThreshold(x, y) || !canWalk(realm.world.level, x, y)) continue;
        if (realm.world.actorAt(x, y) !== undefined) continue;
        body.x = tile.x;
        body.y = tile.y;
        await client.move(step.dir);
        await client.move(step.back);
        return;
      }
    }
    throw new Error('no threshold tile has open ground beside it');
  }

  it('goes down the stair, back up the threshold, and out of the door', async () => {
    const client = await join();
    const door = [...harness.realms.overworld.sites].find(([, id]) => id === UNDERWORKS);
    if (door === undefined) throw new Error('no door to the Underworks');
    const [dx, dy] = door[0].split(',').map(Number);
    if (dx === undefined || dy === undefined) throw new Error('a bad door cell');
    await stepOnto(client, { x: dx, y: dy });

    const first = realmOf(client);
    expect(first.siteId, 'never went in').toBe(UNDERWORKS);
    expect(first.floor).toBe(1);

    // ═══ DOWN ═══
    clear(first);
    const stairs = stairsDownOf(first);
    if (stairs === null) throw new Error('the first floor has no stair down');
    // THE STAIR IS ON THE MAP the player is sent, where upstream names it.
    const map = [...client.frames]
      .reverse()
      .find((f) => (f['t'] === 'sites' || f['t'] === 'realm') && Array.isArray(f['sites']));
    const marker = (map?.['sites'] as Record<string, unknown>[] | undefined)?.find(
      (m) => m['x'] === stairs.x && m['y'] === stairs.y,
    );
    expect(marker, 'the stair is not on the map').toMatchObject({
      marker: 'stair',
      name: 'Next level',
    });
    await stepOnto(client, stairs);
    const second = realmOf(client);
    expect(second.floor, 'the stair did not go down').toBe(2);
    expect(second.siteId).toBe(UNDERWORKS);
    const below = second.world.getActor(client.actorId);
    expect(
      second.spawns.some((t) => t.x === below?.x && t.y === below.y),
      'did not arrive on the threshold, where upstream arrives on the up stair',
    ).toBe(true);

    // ═══ UP ═══
    clear(second);
    await leaveByThreshold(client);
    expect(realmOf(client).id, 'the threshold did not go back up').toBe(first.id);
    const above = first.world.getActor(client.actorId);
    expect({ x: above?.x, y: above?.y }, 'did not arrive on the stair down').toEqual(stairs);

    // ═══ AND OUT ═══
    await leaveByThreshold(client);
    expect(realmOf(client).id, 'the first floor`s threshold did not lead out').toBe(
      harness.realms.overworld.id,
    );
    const home = harness.realms.overworld.world.getActor(client.actorId);
    expect({ x: home?.x, y: home?.y }, 'did not come out at the door they went in by').toEqual({
      x: dx,
      y: dy,
    });
  });

  it('keeps the stair shut straight after a kill, as the door is', async () => {
    // Upstream guards every change of level (`changeLevelCheck`,
    // class/Game.lua:878), and this port shuts the door after a kill; the stair
    // down is a change of level too.
    const client = await join();
    const door = [...harness.realms.overworld.sites].find(([, id]) => id === UNDERWORKS);
    if (door === undefined) throw new Error('no door to the Underworks');
    const [dx, dy] = door[0].split(',').map(Number);
    if (dx === undefined || dy === undefined) throw new Error('a bad door cell');
    await stepOnto(client, { x: dx, y: dy });

    const first = realmOf(client);
    clear(first);
    const stairs = stairsDownOf(first);
    if (stairs === null) throw new Error('the first floor has no stair down');
    const body = first.world.getActor(client.actorId);
    if (body === undefined || body.kind !== ActorKind.Player) throw new Error('no player body');
    // A KILL THIS TURN, recorded where a kill records it.
    body.lastKillTurn = first.world.turn.clock.gameTurn;

    await stepOnto(client, stairs);
    expect(realmOf(client).id, 'the stair opened straight after a kill').toBe(first.id);
  });
});
