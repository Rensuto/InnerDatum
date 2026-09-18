// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

import { setTimeout as sleep } from 'node:timers/promises';

import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { floorsOf, nbNpcFor, specFor } from '../../src/server/content/delve.ts';
import { createDownedState } from '../../src/server/engine/downed.ts';
import { createPartyState } from '../../src/server/engine/party.ts';
import { wsGateway } from '../../src/server/net/gateway.ts';
import { createTurnEngine } from '../../src/server/turn-engine.ts';
import {
  ENCOUNTER_SITE,
  SITES,
  STAIRS_DOWN_SITE_ID,
  createRealms,
  floorsOfSite,
  stairsDownOf,
  zoneOf,
} from '../../src/server/world/realms.ts';
import { canWalk } from '../../src/shared/level.ts';
import type { AuthoredMap } from '../../src/shared/level.ts';
import { ActorKind, TileCode } from '../../src/shared/protocol.ts';
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
/** A works: ToME's Roomer, which chooses its own stair down. */
const GEARFORD = 'site:gearford_ward';
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

  it('stands a works stair where its generator put it, and none on the last floor', () => {
    /**
     * Roomer places its own down stair (`engine/generator/map/Roomer.lua:48-56`)
     * and hands it back as `AuthoredMap.down`. The realm stands the stair there
     * rather than on the furthest tile it can find, and still decides whether
     * this floor has a level below it. The map is rebuilt from the seed the
     * realm built it from: the root and the realm id (`realms.ts` `seedFor`).
     */
    const root = 'floors-works';
    const realms = makeRealms(root);
    const floors = floorsOfSite(GEARFORD);
    expect(floors, 'a one-floor delve cannot test stairs').toBeGreaterThan(1);
    for (let floor = 1; floor <= floors; floor += 1) {
      const realm = floorOf(realms, GEARFORD, 'party-w', floor);
      const drawn = site(GEARFORD).map(`${root}:${realm.id}`, undefined, floor);
      expect(drawn.view.tiles, 'precondition: the same floor rebuilt').toEqual(
        realm.world.level.tiles,
      );
      expect(drawn.down, `floor ${String(floor)} came back without a stair`).toBeDefined();
      expect(stairsDownOf(realm), `floor ${String(floor)}`).toEqual(
        floor < floors ? drawn.down : null,
      );
    }
  });

  it('populates the floor it stood the stair on, and puts a wipe back on it too', () => {
    /**
     * THE JOIN BETWEEN THE REALM AND `populateDelve`. The placer refuses a cell
     * in `sites` (`content/delve.ts`, `roomFor`), and the stair only reaches
     * `sites` in the map `withStairsDown` returns. Handing the populate call, or
     * the wipe's reseed, the map as drawn would put bodies, litter and traps on
     * the stair with every unit test still green.
     *
     * A one-row corridor whose stair is in the middle of every candidate there
     * is: the roster alone covers about one cell in seven, so over thirty floors
     * the stair would be stood on many times over.
     */
    const w = 60;
    const tiles = Array.from({ length: w * 5 }, (_, i) =>
      Math.floor(i / w) === 2 && i % w >= 1 && i % w <= w - 2 ? TileCode.FLOOR : TileCode.WALL,
    );
    const corridor: AuthoredMap = {
      view: { w, h: 5, tiles },
      spawns: [{ x: 2, y: 2 }],
      down: { x: 30, y: 2 },
      sites: new Map(),
    };
    const gearford: SiteDef = { ...site(GEARFORD), map: () => corridor };
    const gearfordSpec = specFor(GEARFORD);
    if (gearfordSpec === undefined) throw new Error('no spec for Gearford Ward');
    const realms = makeRealms('stair-join');
    const onStair = (realm: Realm): string[] => {
      const at = stairsDownOf(realm);
      if (at === null) throw new Error('precondition: the floor has no stair down');
      const { world } = realm;
      const here = (thing: { readonly x: number; readonly y: number }): boolean =>
        thing.x === at.x && thing.y === at.y;
      return [
        ...world.allActors().filter((a) => a.kind === ActorKind.Monster && here(a)),
        ...world.groundItems().filter(here),
        ...world.traps().filter(here),
        ...world.props().filter(here),
      ].map((thing) => JSON.stringify(thing).slice(0, 80));
    };
    let bodies = 0;
    for (let n = 0; n < 30; n += 1) {
      const realm = realms.open(
        gearford,
        `party-stair-${String(n)}`,
        undefined,
        undefined,
        undefined,
        1,
      );
      expect(stairsDownOf(realm), 'precondition: the stair is where the map put it').toEqual({
        x: 30,
        y: 2,
      });
      expect(onStair(realm), `floor ${String(n)}: populated onto the stair`).toEqual([]);

      const { world } = realm;
      for (const body of world.allActors().filter((a) => a.kind === ActorKind.Monster)) {
        world.removeActor(body.id);
      }
      expect(world.reseedFloor, 'precondition: the realm gave its floor a reseed').toBeDefined();
      world.reseedFloor?.(world);
      bodies += world.allActors().filter((a) => a.kind === ActorKind.Monster).length;
      expect(onStair(realm), `floor ${String(n)}: a wipe put a body on the stair`).toEqual([]);
    }
    /**
     * ═══ THE FLOOR'S OWN BAND, NOT A ROUND NUMBER ═══
     * This read `> 100` — about three and a half bodies a floor, which was the
     * Gearford band when it was `6-8` and authored. Gearford is the one zone
     * upstream scales with AREA (`nbNpcPerArea`, `infinite-dungeon/zone.lua:255-256`)
     * and this fixture is a 60x5 corridor, so the honest precondition is the
     * band the placer itself computes for 300 cells.
     */
    const band = nbNpcFor(gearfordSpec, 1, corridor.view.w * corridor.view.h);
    expect(bodies, 'precondition: the reseed put nobody back').toBeGreaterThan(0);
    expect(bodies / 30, 'the reseed put back more than the floor holds').toBeLessThanOrEqual(
      band[1],
    );
  });

  it('counts every floor a party has open as one zone, and an ambush as a zone of one', () => {
    const realms = makeRealms();
    const first = floorOf(realms, UNDERWORKS, 'party-z', 1);
    const second = floorOf(realms, UNDERWORKS, 'party-z', 2);
    expect(new Set(zoneOf(realms, first))).toEqual(new Set([first, second]));
    // ANOTHER PARTY'S COPY OF THE SAME DELVE is its own zone.
    const theirs = floorOf(realms, UNDERWORKS, 'party-y', 1);
    expect(zoneOf(realms, theirs)).toEqual([theirs]);
    // TWO BREACHES FOR ONE PARTY are not one zone: an empty one must close.
    const breach = realms.open(ENCOUNTER_SITE, 'party-z');
    breach.sealed = true;
    const again = realms.open(ENCOUNTER_SITE, 'party-z');
    expect(again.id, 'precondition: a second breach').not.toBe(breach.id);
    expect(zoneOf(realms, breach)).toEqual([breach]);
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
    /**
     * THE STAIR IS ON THE MAP the player is sent, where upstream names it —
     * ONCE THAT PLAYER HAS BEEN WITHIN SIGHT OF IT.
     *
     * This used to read the frame that arrived with the floor, and it passed
     * because `markersFor` drew every stair to everybody. It does not any more:
     * a way on is terrain, `engine/Grid.lua:30-32` remembers terrain, and a
     * stair painted through rock on never-seen black was half of the report that
     * rule came from. The absence half is pinned on a hand-built map in
     * test/server/fov.test.ts, where the geometry is not the mapgen's to change.
     */
    const beside = STEPS.map((s) => ({ x: stairs.x + s.dx, y: stairs.y + s.dy })).find(
      (t) => canWalk(first.world.level, t.x, t.y) && first.world.actorAt(t.x, t.y) === undefined,
    );
    if (beside === undefined) throw new Error('the stair has no open ground beside it');
    await stepOnto(client, beside);
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

  it('keeps the floor above while the party is below, and lets both go once they are out', async () => {
    const client = await join();
    const door = [...harness.realms.overworld.sites].find(([, id]) => id === UNDERWORKS);
    if (door === undefined) throw new Error('no door to the Underworks');
    const [dx, dy] = door[0].split(',').map(Number);
    if (dx === undefined || dy === undefined) throw new Error('a bad door cell');
    await stepOnto(client, { x: dx, y: dy });

    // A LINGER SHORT ENOUGH TO WATCH. The default is minutes.
    const shorten = (realm: Realm): void => {
      (realm as unknown as { lingerMs: number }).lingerMs = 30;
    };
    const first = realmOf(client);
    shorten(first);
    clear(first);
    const stairs = stairsDownOf(first);
    if (stairs === null) throw new Error('the first floor has no stair down');
    await stepOnto(client, stairs);
    const second = realmOf(client);
    shorten(second);
    expect(second.floor).toBe(2);

    await sleep(300);
    expect(
      harness.realms.get(first.id),
      'the floor above was reaped while the party was below it',
    ).toBeDefined();

    clear(second);
    await leaveByThreshold(client);
    await leaveByThreshold(client);
    expect(realmOf(client).id).toBe(harness.realms.overworld.id);
    await sleep(300);
    expect(harness.realms.get(first.id), 'the first floor outlived the party').toBeUndefined();
    expect(harness.realms.get(second.id), 'the second floor outlived the party').toBeUndefined();
  });

  it('keeps the floor below when the party walks back in before its linger runs out', async () => {
    const client = await join();
    const door = [...harness.realms.overworld.sites].find(([, id]) => id === UNDERWORKS);
    if (door === undefined) throw new Error('no door to the Underworks');
    const [dx, dy] = door[0].split(',').map(Number);
    if (dx === undefined || dy === undefined) throw new Error('a bad door cell');
    await stepOnto(client, { x: dx, y: dy });

    const shorten = (realm: Realm): void => {
      (realm as unknown as { lingerMs: number }).lingerMs = 400;
    };
    const first = realmOf(client);
    shorten(first);
    clear(first);
    const stairs = stairsDownOf(first);
    if (stairs === null) throw new Error('the first floor has no stair down');
    await stepOnto(client, stairs);
    const second = realmOf(client);
    shorten(second);
    clear(second);

    // UP AND OUT, which starts every floor's linger...
    await leaveByThreshold(client);
    await leaveByThreshold(client);
    expect(realmOf(client).id).toBe(harness.realms.overworld.id);
    // ...AND STRAIGHT BACK IN, before it runs out.
    await stepOnto(client, { x: dx, y: dy });
    expect(realmOf(client).id, 'walked back into a fresh first floor').toBe(first.id);

    await sleep(700);
    expect(
      harness.realms.get(second.id),
      'the floor below closed while the party was back inside the delve',
    ).toBeDefined();
  });
});
