// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

import { setTimeout as sleep } from 'node:timers/promises';

import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDownedState } from '../../src/server/engine/downed.ts';
import { createPartyState } from '../../src/server/engine/party.ts';
import { wsGateway } from '../../src/server/net/gateway.ts';
import { createTurnEngine } from '../../src/server/turn-engine.ts';
import type { IdentityPort, PersistPort } from '../../src/server/net/gateway.ts';
import {
  EXIT_SITE_ID,
  SITES,
  STAIRS_DOWN_SITE_ID,
  UNDERMOST_SITE_ID,
  createRealms,
  floorsOfSite,
  stairsDownOf,
} from '../../src/server/world/realms.ts';
import { canWalk } from '../../src/shared/level.ts';
import { ActorKind, LogLane } from '../../src/shared/protocol.ts';
import { PROTOCOL_VERSION } from '../../src/shared/version.ts';
import type { Realm, Realms } from '../../src/server/world/realms.ts';
import type { TileXY } from '../../src/shared/coords.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHERE A NEW CHARACTER WAKES, AND THE ONLY WAY OUT OF IT.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Upstream's Escape from Reknor: three levels (data/zones/reknor-escape/
 * zone.lua:24), a first level whose up stair is floor (:67-69), and a last
 * level drawn by hand with the way out at its far end (:72-79). Here the
 * premise is waking deep in a cave and climbing to the surface.
 */
const FRAME_TIMEOUT_MS = 4_000;
/** A cave-shaped delve of several floors that is not the Undermost. */
const UNDERWORKS = 'site:underworks';

function makeRealms(seed = 'undermost'): Realms {
  const downed = createDownedState();
  const parties = createPartyState();
  return createRealms({ seed, engineFor: (world) => createTurnEngine({ world, downed, parties }) });
}

function undermost(): NonNullable<ReturnType<typeof SITES.get>> {
  const def = SITES.get(UNDERMOST_SITE_ID);
  if (def === undefined) throw new Error('no Undermost');
  return def;
}

function exitOf(realm: Realm): TileXY | null {
  for (const [cell, id] of realm.sites) {
    if (id !== EXIT_SITE_ID) continue;
    const [x, y] = cell.split(',').map(Number);
    if (x === undefined || y === undefined) return null;
    return { x, y };
  }
  return null;
}

describe('the Undermost, as a zone', () => {
  it('is three floors, like upstream`s escape, and on no map', () => {
    expect(floorsOfSite(UNDERMOST_SITE_ID)).toBe(3);
    const realms = makeRealms();
    expect(
      [...realms.overworld.sites.values()].includes(UNDERMOST_SITE_ID),
      'the Undermost has a door on the overworld',
    ).toBe(false);
  });

  it('climbs by stairs on the first two floors and leaves by the exit on the last', () => {
    const realms = makeRealms();
    for (let floor = 1; floor <= 3; floor += 1) {
      const realm = realms.open(undermost(), 'party-u', undefined, undefined, undefined, floor);
      const stairs = [...realm.sites.values()].filter((id) => id === STAIRS_DOWN_SITE_ID);
      const exits = [...realm.sites.values()].filter((id) => id === EXIT_SITE_ID);
      expect(stairs.length, `stairs on floor ${String(floor)}`).toBe(floor < 3 ? 1 : 0);
      expect(exits.length, `exits on floor ${String(floor)}`).toBe(floor < 3 ? 0 : 1);
      const monsters = realm.world.allActors().filter((a) => a.kind === ActorKind.Monster).length;
      if (floor < 3) {
        expect(monsters, `nobody rolled on floor ${String(floor)}`).toBeGreaterThan(0);
        continue;
      }
      // UPSTREAM'S LAST LEVEL ROLLS NOBODY (zone.lua:79): its fight is placed.
      expect(monsters, 'the last floor rolled a population').toBe(0);
      const exit = exitOf(realm);
      if (exit === null) throw new Error('no exit on the last floor');
      expect(canWalk(realm.world.level, exit.x, exit.y), 'the exit is not ground').toBe(true);
      expect(realm.spawns.length, 'the last floor has no arrival').toBeGreaterThan(0);
    }
  });

  it('draws the last floor by hand, the same floor every time', () => {
    const a = makeRealms('undermost-a').open(undermost(), 'p', undefined, undefined, undefined, 3);
    const b = makeRealms('undermost-b').open(undermost(), 'p', undefined, undefined, undefined, 3);
    expect(a.world.level.tiles).toEqual(b.world.level.tiles);
    const first = makeRealms('undermost-a').open(
      undermost(),
      'p',
      undefined,
      undefined,
      undefined,
      1,
    );
    const other = makeRealms('undermost-b').open(
      undermost(),
      'p',
      undefined,
      undefined,
      undefined,
      1,
    );
    expect(first.world.level.tiles, 'the generated floors are not generated').not.toEqual(
      other.world.level.tiles,
    );
  });
});

describe('the Undermost, over the wire', () => {
  let harness: { port: number; realms: Realms; close: () => Promise<void> };
  const sockets: WebSocket[] = [];

  beforeEach(async () => {
    const downed = createDownedState();
    const parties = createPartyState();
    const realms = createRealms({
      seed: 'undermost-wire',
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

  function clear(realm: Realm): void {
    for (const actor of realm.world.allActors()) {
      if (actor.kind === ActorKind.Monster) realm.world.removeActor(actor.id);
    }
  }

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

  async function offAndBackOntoThreshold(client: Client): Promise<void> {
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

  it('has no way back from the first floor, and leaves by the exit on the last', async () => {
    const client = await join();
    const overworld = harness.realms.overworld;
    const body = overworld.world.getActor(client.actorId);
    if (body === undefined) throw new Error('no body on the overworld');

    // A DOOR FOR THE TEST ONLY: nothing on any map leads here.
    const door = STEPS.map((s) => ({ x: body.x + s.dx, y: body.y + s.dy })).find(
      (c) =>
        canWalk(overworld.world.level, c.x, c.y) && overworld.world.actorAt(c.x, c.y) === undefined,
    );
    if (door === undefined) throw new Error('no open ground beside the body');
    (overworld.sites as Map<string, string>).set(
      `${String(door.x)},${String(door.y)}`,
      UNDERMOST_SITE_ID,
    );
    await stepOnto(client, door);

    const first = realmOf(client);
    expect(first.siteId, 'never went in').toBe(UNDERMOST_SITE_ID);
    expect(first.floor).toBe(1);

    // ═══ NO WAY BACK, AND NONE DRAWN ═══ The threshold carries no way-out marker,
    // because the marker asks what leaving asks.
    const firstMap = [...client.frames]
      .reverse()
      .find((f) => (f['t'] === 'sites' || f['t'] === 'realm') && Array.isArray(f['sites']));
    const drawnOut = (firstMap?.['sites'] as Record<string, unknown>[] | undefined)?.filter(
      (m) => m['marker'] === 'gate' && first.spawns.some((s) => s.x === m['x'] && s.y === m['y']),
    );
    expect(drawnOut, 'a way out is drawn on a threshold that leads nowhere').toEqual([]);
    clear(first);
    await offAndBackOntoThreshold(client);
    expect(realmOf(client).id, 'the first floor`s threshold led out').toBe(first.id);

    // ═══ UP THROUGH THE FLOORS ═══
    for (const floor of [1, 2]) {
      const here = realmOf(client);
      expect(here.floor).toBe(floor);
      clear(here);
      const stairs = stairsDownOf(here);
      if (stairs === null) throw new Error(`floor ${String(floor)} has no stair`);
      await stepOnto(client, stairs);
    }
    const last = realmOf(client);
    expect(last.floor, 'never reached the last floor').toBe(3);
    clear(last);

    // ═══ THE WAY OUT IS ON THE MAP, AND IT IS THE WAY OUT ═══
    const exit = exitOf(last);
    if (exit === null) throw new Error('no exit on the last floor');
    const map = [...client.frames]
      .reverse()
      .find((f) => (f['t'] === 'sites' || f['t'] === 'realm') && Array.isArray(f['sites']));
    const marker = (map?.['sites'] as Record<string, unknown>[] | undefined)?.find(
      (m) => m['x'] === exit.x && m['y'] === exit.y,
    );
    // AND IT IS THE CAVE'S OWN STAIR, not the generic one: the landmark is a
    // preference the client falls back from, so `marker` stays beside it.
    expect(marker, 'the way out is not on the map').toMatchObject({
      marker: 'stair',
      name: 'The way out',
      landmark: 'prop_cave_way_up',
    });
    // AND ON THE EXIT ALONE. This floor's arrival thresholds are also named "The
    // way out" (`markersFor`'s `exits`, a `gate`), but on any floor after the
    // first `leaveRealm` takes them to the previous floor, not to daylight. The
    // case above finds the exit's marker and stops, so the cave stair painted on
    // a threshold as well would pass it. Where it is drawn, not merely that it is.
    const sites = (map?.['sites'] as Record<string, unknown>[] | undefined) ?? [];
    expect(
      sites.some(
        (m) => m['marker'] === 'gate' && last.spawns.some((s) => s.x === m['x'] && s.y === m['y']),
      ),
      'the last floor draws no threshold, so the check below has nothing to refuse',
    ).toBe(true);
    expect(
      sites
        .filter((m) => m['landmark'] === 'prop_cave_way_up')
        .map((m) => ({ x: m['x'], y: m['y'] })),
      'the cave stair is drawn somewhere other than the way out',
    ).toEqual([{ x: exit.x, y: exit.y }]);
    await stepOnto(client, exit);
    expect(realmOf(client).id, 'the exit did not lead out').toBe(overworld.id);
    const home = overworld.world.getActor(client.actorId);
    expect({ x: home?.x, y: home?.y }, 'did not come out where they went in').toEqual(door);
  });

  /**
   * THE CAVE STAIR IS THE UNDERMOST'S, NOT EVERY ZONE'S.
   *
   * `exit:out` has exactly one map use today (the Undermost's last floor), so the
   * case above cannot tell "the Undermost's way out wears the cave stair" from
   * "every way out does": delete the site guard in `markersFor` and it still
   * passes. This is the other half: a way out on a floor of some OTHER zone
   * keeps the stair family marker and carries no landmark.
   *
   * THE UNDERWORKS, BECAUSE IT IS A CAVE TOO — `SiteShape.Cave` in soot and crag,
   * what the Undermost's generated floors are made of (world/realms.ts). And ON
   * ITS LAST FLOOR, where upstream puts an exit and where the Undermost's is. So
   * a guard reading "a cave", "the last floor" or "an inner realm" instead of
   * "the Undermost" fails here as well as a guard deleted outright.
   *
   * THE FLOOR IS PREPARED BEFORE THE PARTY ARRIVES, through the same idempotent
   * `open` the stair calls, keyed on the party the gateway itself minted at the
   * door. So the exit is on the map in the `realm` frame the last stair sends,
   * and nothing here reaches past the wire to read a marker.
   */
  it('draws any other zone`s way out as the plain stair, with no cave landmark', async () => {
    const client = await join();
    const overworld = harness.realms.overworld;
    const door = [...overworld.sites].find(([, id]) => id === UNDERWORKS);
    if (door === undefined) throw new Error('no door to the Underworks');
    const [dx, dy] = door[0].split(',').map(Number);
    if (dx === undefined || dy === undefined) throw new Error('a bad door cell');
    await stepOnto(client, { x: dx, y: dy });

    const first = realmOf(client);
    expect(first.siteId, 'never went in').toBe(UNDERWORKS);
    const floors = floorsOfSite(UNDERWORKS);
    expect(floors, 'a one-floor delve has no stair to arrive by').toBeGreaterThan(1);
    const underworks = SITES.get(UNDERWORKS);
    if (underworks === undefined || first.partyId === undefined) {
      throw new Error('no Underworks, or a floor with no party');
    }
    const last = harness.realms.open(
      underworks,
      first.partyId,
      undefined,
      undefined,
      undefined,
      floors,
    );
    // ANY OPEN CELL that is neither a threshold nor already a site.
    const exit = ((): TileXY => {
      const level = last.world.level;
      for (let y = 0; y < level.h; y += 1) {
        for (let x = 0; x < level.w; x += 1) {
          if (!canWalk(level, x, y) || last.sites.has(`${String(x)},${String(y)}`)) continue;
          if (last.spawns.some((t) => t.x === x && t.y === y)) continue;
          return { x, y };
        }
      }
      throw new Error('no open ground on the last floor');
    })();
    (last.sites as Map<string, string>).set(`${String(exit.x)},${String(exit.y)}`, EXIT_SITE_ID);

    for (let floor = 1; floor < floors; floor += 1) {
      const here = realmOf(client);
      expect(here.floor).toBe(floor);
      clear(here);
      const stairs = stairsDownOf(here);
      if (stairs === null) throw new Error(`floor ${String(floor)} has no stair`);
      await stepOnto(client, stairs);
    }
    expect(realmOf(client).id, 'the stairs did not lead to the prepared floor').toBe(last.id);

    const map = [...client.frames]
      .reverse()
      .find((f) => (f['t'] === 'sites' || f['t'] === 'realm') && Array.isArray(f['sites']));
    const marker = (map?.['sites'] as Record<string, unknown>[] | undefined)?.find(
      (m) => m['x'] === exit.x && m['y'] === exit.y,
    );
    expect(marker, 'the way out is not on the map').toMatchObject({
      marker: 'stair',
      name: 'The way out',
    });
    expect(marker, 'another zone`s way out wears the Undermost`s cave stair').not.toHaveProperty(
      'landmark',
    );
  });
});

describe('a new character wakes in the Undermost', () => {
  // A SIGNED-IN PLAYER, because only a store asked on behalf of somebody can
  // answer that their character is new.
  const HANDLE = 'birth-handle';
  const identity: IdentityPort = {
    get: (id: string | undefined) =>
      id === HANDLE ? { user: { id: 'birth-user' }, displayName: 'Wren' } : undefined,
  };
  const sockets: WebSocket[] = [];
  let close: (() => Promise<void>) | undefined;

  afterEach(async () => {
    for (const socket of sockets) socket.close();
    sockets.length = 0;
    await close?.();
    close = undefined;
  });

  async function boot(persist?: PersistPort): Promise<{ port: number; realms: Realms }> {
    const downed = createDownedState();
    const parties = createPartyState();
    const realms = createRealms({
      seed: 'undermost-birth',
      engineFor: (world) => createTurnEngine({ world, downed, parties }),
    });
    const app = Fastify({ logger: false });
    await app.register(wsGateway, {
      world: realms.overworld.world,
      engine: realms.overworld.engine,
      realms,
      parties,
      downed,
      sessions: identity,
      ...(persist === undefined ? {} : { persist }),
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (address === null || typeof address === 'string') throw new Error('no port was bound');
    close = async (): Promise<void> => {
      await app.close();
    };
    return { port: address.port, realms };
  }

  async function chooseAClass(
    port: number,
  ): Promise<{ actorId: string; frames: Record<string, unknown>[] }> {
    const socket = new WebSocket(`ws://127.0.0.1:${String(port)}/ws`);
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
    socket.send(
      JSON.stringify({ v: PROTOCOL_VERSION, t: 'hello', sessionId: HANDLE, newCharacter: true }),
    );
    const deadline = Date.now() + FRAME_TIMEOUT_MS;
    let actorId: string | undefined;
    let classId: string | undefined;
    while (Date.now() < deadline && (actorId === undefined || classId === undefined)) {
      const welcome = frames.find((f) => f['t'] === 'welcome')?.['selfId'];
      if (typeof welcome === 'string') actorId = welcome;
      const offered = frames.find((f) => f['t'] === 'class_options')?.['options'];
      if (Array.isArray(offered)) classId = (offered[0] as { id?: string } | undefined)?.id;
      await sleep(10);
    }
    if (actorId === undefined || classId === undefined) throw new Error('no class was offered');
    socket.send(JSON.stringify({ v: PROTOCOL_VERSION, t: 'choose_class', classId }));
    await sleep(400);
    return { actorId, frames };
  }

  it('puts a character the store has no file for in the Undermost, and tells it why', async () => {
    const noFile: PersistPort = {
      savePlayers: () => undefined,
      savePlayersNow: () => undefined,
      openCharacter: () => Promise.resolve(null),
    };
    const { port, realms } = await boot(noFile);
    const { actorId, frames } = await chooseAClass(port);

    const realm = realms.realmOf(actorId);
    expect(realm?.siteId, 'a new character did not wake in the Undermost').toBe(UNDERMOST_SITE_ID);
    expect(realm?.floor).toBe(1);
    const margin = frames
      .filter((f) => f['t'] === 'log')
      .flatMap((f) => (f['lines'] as { lane: string; text: string }[] | undefined) ?? [])
      .filter((line) => line.lane === LogLane.Margin)
      .map((line) => line.text);
    expect(
      margin.some((text) => text.startsWith('You wake')),
      'nobody told it why',
    ).toBe(true);
    expect(
      margin.some((text) => text.startsWith('Your file is open')),
      'a character in the cave was pointed at a case on the surface',
    ).toBe(false);
  });

  it('leaves a character on the map when there is no store to say it is new', async () => {
    const { port, realms } = await boot();
    const { actorId } = await chooseAClass(port);
    expect(realms.realmOf(actorId)?.id).toBe(realms.overworld.id);
  });
});
