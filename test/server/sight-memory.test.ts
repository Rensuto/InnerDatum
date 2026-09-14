// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { sightRadiusOf } from '../../src/server/engine/derived.ts';
import { createDownedState } from '../../src/server/engine/downed.ts';
import { createPartyState } from '../../src/server/engine/party.ts';
import { wsGateway } from '../../src/server/net/gateway.ts';
import { createTurnEngine } from '../../src/server/turn-engine.ts';
import { RealmKind, SITES, createRealms } from '../../src/server/world/realms.ts';
import { REVEAL_RADIUS, fogBytes, fogFromBase64, fogHas, fogSet } from '../../src/shared/fog.ts';
import { canWalk } from '../../src/shared/level.ts';
import { canSee } from '../../src/shared/sight.ts';
import { PROTOCOL_VERSION } from '../../src/shared/version.ts';
import type { TileXY } from '../../src/shared/coords.ts';
import type { Realm, Realms } from '../../src/server/world/realms.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A REALM REMEMBERS WHAT YOU SAW IN IT — AND ONLY WHAT YOU SAW.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Upstream's map marks every grid a player's sight reaches as remembered, in
 * every zone (`engine/Map.lua:649-687`). The server kept that memory for an
 * overworld only, so in a delve or a town loot dropped off the floor frame the
 * moment it left sight, and a reconnect arrived with nothing on the map.
 *
 * ALL OF THIS IS DRIVEN OVER THE WIRE, through a real town. The memory is a
 * closure inside the gateway, so the only honest readers are the two frames a
 * player receives from it: the `realm` frame's `explored` on a reconnect, and
 * the `ground` frame. Ashwick is a town rather than a delve because a town has
 * walls and no hostiles; the rule under test does not distinguish the two, only
 * an overworld from everything else.
 */

const FRAME_TIMEOUT_MS = 4_000;
const GRACE_MS = 10_000;
// A FAST TIDE. It pumps an occupied town on a clock, which is the one pump in
// this file that no step of the player's causes.
const TIDE_MS = 40;
const ASHWICK = 'site:ashwick_row';

type Frame = Record<string, unknown>;

type Client = {
  readonly frames: Frame[];
  send(frame: Frame): void;
  close(): void;
};

type Harness = {
  port: number;
  realms: Realms;
  close: () => Promise<void>;
};

let server: Harness;
const openClients: Client[] = [];

beforeEach(async () => {
  const downed = createDownedState();
  const parties = createPartyState();
  const realms = createRealms({
    seed: 'sight-memory',
    engineFor: (world) => createTurnEngine({ world, downed, parties }),
  });

  const app = Fastify({ logger: false });
  await app.register(wsGateway, {
    world: realms.overworld.world,
    engine: realms.overworld.engine,
    realms,
    parties,
    downed,
    disconnectGraceMs: GRACE_MS,
    tideMs: TIDE_MS,
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
  for (const client of openClients) client.close();
  openClients.length = 0;
  await server.close();
});

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
    frames,
    send(frame: Frame): void {
      socket.send(JSON.stringify({ v: PROTOCOL_VERSION, ...frame }));
    },
    close(): void {
      socket.close();
    },
  };
  openClients.push(client);
  return client;
}

async function waitFor(
  client: Client,
  pick: (frame: Frame) => boolean,
  what: string,
): Promise<Frame> {
  const deadline = Date.now() + FRAME_TIMEOUT_MS;
  for (;;) {
    const hit = client.frames.find(pick);
    if (hit !== undefined) return hit;
    if (Date.now() >= deadline) throw new Error(`no ${what} came back`);
    await sleep(5);
  }
}

async function hello(
  client: Client,
  resumeToken?: string,
): Promise<{ actorId: string; token: string }> {
  client.send({ t: 'hello', ...(resumeToken === undefined ? {} : { resumeToken }) });
  const welcome = await waitFor(client, (frame) => frame['t'] === 'welcome', 'welcome');
  const actorId = welcome['selfId'];
  const token = welcome['resumeToken'];
  if (typeof actorId !== 'string' || typeof token !== 'string') {
    throw new Error('a welcome with no id or no resume token');
  }
  return { actorId, token };
}

/** Step through Ashwick's door the way a player does, and wait on the far side. */
async function intoAshwick(client: Client, actorId: string): Promise<Realm> {
  const overworld = server.realms.overworld;
  let door: TileXY | undefined;
  for (const [cell, siteId] of overworld.sites) {
    if (siteId !== ASHWICK) continue;
    const [xs, ys] = cell.split(',');
    door = { x: Number(xs), y: Number(ys) };
  }
  if (door === undefined) throw new Error('Ashwick is not on the map');
  const body = overworld.world.getActor(actorId);
  if (body === undefined) throw new Error('no body on the overworld');
  body.x = door.x - 1;
  body.y = door.y;

  client.send({ t: 'move', dir: 'e' });
  const deadline = Date.now() + FRAME_TIMEOUT_MS;
  while (server.realms.realmOf(actorId)?.siteId !== ASHWICK && Date.now() < deadline) {
    await sleep(10);
  }
  const town = server.realms.realmOf(actorId);
  if (town?.siteId !== ASHWICK) throw new Error('never got through the door');
  // Past the arrival pump and a few tides, so whatever is remembered has been.
  await sleep(TIDE_MS * 4);
  return town;
}

const keyOf = (tile: TileXY): string => `${String(tile.x)},${String(tile.y)}`;

/** Every tile of `realm` an eye at `eye` sees, by the rule the server spends. */
function sightFrom(realm: Realm, eye: TileXY, radius: number): Set<string> {
  const { level } = realm.world;
  const out = new Set<string>();
  for (let y = 0; y < level.h; y += 1) {
    for (let x = 0; x < level.w; x += 1) {
      if (canSee(level, eye, { x, y }, radius)) out.add(keyOf({ x, y }));
    }
  }
  return out;
}

/** The first free floor tile `accept` agrees to, scanning in reading order. */
function floorWhere(realm: Realm, accept: (tile: TileXY) => boolean): TileXY {
  const { level } = realm.world;
  const taken = new Set(realm.world.allActors().map((actor) => keyOf(actor)));
  for (let y = 0; y < level.h; y += 1) {
    for (let x = 0; x < level.w; x += 1) {
      const tile = { x, y };
      if (!canWalk(level, x, y) || taken.has(keyOf(tile))) continue;
      if (accept(tile)) return tile;
    }
  }
  throw new Error('no floor tile fits');
}

/** A free floor tile whose own sight shares nothing with `seen`. */
function outOfSight(realm: Realm, seen: ReadonlySet<string>, radius: number): TileXY {
  return floorWhere(realm, (tile) => {
    if (seen.has(keyOf(tile))) return false;
    const there = sightFrom(realm, tile, radius);
    return there.size > 20 && [...there].every((cell) => !seen.has(cell));
  });
}

/** Drop the socket, come back on the token, and decode the memory the server sends. */
async function memoryOnReturn(
  client: Client,
  token: string,
  realm: Realm,
): Promise<Uint8Array | undefined> {
  client.close();
  await sleep(100);
  const back = await connect(server.port);
  await hello(back, token);
  const frame = await waitFor(
    back,
    (f) => f['t'] === 'realm' && f['realmId'] === realm.id,
    `realm frame for ${realm.name}`,
  );
  const explored = frame['explored'];
  if (explored === undefined) return undefined;
  if (typeof explored !== 'string') throw new Error('explored is not a string');
  const { w, h } = realm.world.level;
  return fogFromBase64(explored, fogBytes(w, h));
}

describe('a town remembers what you saw in it', () => {
  it('sends it back on a reconnect, stopped by walls exactly where the eye is', async () => {
    const client = await connect(server.port);
    const { actorId, token } = await hello(client);
    const town = await intoAshwick(client, actorId);
    expect(town.kind, 'the rule under test is for realms that are not an overworld').not.toBe(
      RealmKind.Overworld,
    );
    const body = town.world.getActor(actorId);
    if (body === undefined) throw new Error('no body in the town');
    const here = { x: body.x, y: body.y };
    const seen = sightFrom(town, here, sightRadiusOf(body));

    const memory = await memoryOnReturn(client, token, town);
    expect(memory, 'the town frame carried no memory at all').toBeDefined();
    if (memory === undefined) return;

    const { level } = town.world;
    const wrong: string[] = [];
    let hiddenInsideTheDisc = 0;
    for (let y = 0; y < level.h; y += 1) {
      for (let x = 0; x < level.w; x += 1) {
        const cell = keyOf({ x, y });
        if (fogHas(memory, level.w, x, y) !== seen.has(cell)) wrong.push(cell);
        const dx = x - here.x;
        const dy = y - here.y;
        if (dx * dx + dy * dy <= REVEAL_RADIUS * REVEAL_RADIUS && !seen.has(cell)) {
          hiddenInsideTheDisc += 1;
        }
      }
    }
    // NOT VACUOUS: some ground inside the overworld's reveal disc is out of
    // sight from here, so a memory drawn as that disc cannot pass.
    expect(hiddenInsideTheDisc).toBeGreaterThan(0);
    expect(wrong, 'remembered tiles differ from exactly what was in sight').toEqual([]);
  });

  it('remembers where a body ends up when no step of its own put it there', async () => {
    const client = await connect(server.port);
    const { actorId, token } = await hello(client);
    const town = await intoAshwick(client, actorId);
    const body = town.world.getActor(actorId);
    if (body === undefined) throw new Error('no body in the town');
    const radius = sightRadiusOf(body);
    const before = sightFrom(town, body, radius);

    // MOVED BY THE WORLD, the way a knockback or a floor reset moves a body, and
    // then pumped by the tide. Nothing here is a `move` from this player.
    const there = outOfSight(town, before, radius);
    expect(town.world.placeAt(actorId, there), 'could not put the body down').toBe(true);
    await sleep(TIDE_MS * 6);

    const memory = await memoryOnReturn(client, token, town);
    if (memory === undefined) throw new Error('the town frame carried no memory at all');
    const { level } = town.world;
    const forgotten = [...sightFrom(town, there, radius)].filter((cell) => {
      const [xs, ys] = cell.split(',');
      return !fogHas(memory, level.w, Number(xs), Number(ys));
    });
    expect(forgotten, 'ground in sight of where the body was put is not remembered').toEqual([]);
  });

  it('remembers at the body`s own sight radius, not the default one', async () => {
    /**
     * THE RADIUS IS THE BODY'S. `sightRadiusOf` reads the talent, the ego and
     * the blindness that narrow or widen it, and `blinded.test.ts` pins that
     * reading; this pins that the memory is handed the body's answer and not
     * the default. The modifier is written straight onto the sheet because a
     * quiet town recomposes nothing between pumps, so it holds.
     */
    const client = await connect(server.port);
    const { actorId, token } = await hello(client);
    const town = await intoAshwick(client, actorId);
    const body = town.world.getActor(actorId);
    if (body === undefined) throw new Error('no body in the town');
    const sheet = body.combat;
    if (sheet === undefined) throw new Error('a body with no sheet');
    const wide = sightRadiusOf(body);
    const before = sightFrom(town, body, wide);
    const there = outOfSight(town, before, wide);

    body.combat = { ...sheet, mods: { ...sheet.mods, sight: -6 } };
    const narrow = sightRadiusOf(body);
    expect(narrow, 'the modifier did not narrow the sight').toBeLessThan(wide);
    expect(town.world.placeAt(actorId, there), 'could not put the body down').toBe(true);
    await sleep(TIDE_MS * 6);

    const memory = await memoryOnReturn(client, token, town);
    if (memory === undefined) throw new Error('the town frame carried no memory at all');
    const { level } = town.world;
    const has = (cell: string): boolean => {
      const [xs, ys] = cell.split(',');
      return fogHas(memory, level.w, Number(xs), Number(ys));
    };
    const near = sightFrom(town, there, narrow);
    const beyond = [...sightFrom(town, there, wide)].filter((cell) => !near.has(cell));
    expect(beyond.length, 'nothing lies between the two radii here').toBeGreaterThan(0);
    expect(
      [...near].filter((cell) => !has(cell)),
      'in sight and not remembered',
    ).toEqual([]);
    expect(beyond.filter(has), 'remembered past the body`s own sight').toEqual([]);
  });
});

describe('the overworld remembers by sight too', () => {
  it('sends back exactly what was in sight, not a disc around where you stood', async () => {
    /**
     * THE OVERWORLD KEPT A DISC at the reveal radius, through ridges and
     * trees, while the client drew the same disc for itself. The client draws
     * the server's memory now, so the overworld is remembered as anywhere else.
     */
    const client = await connect(server.port);
    const { actorId, token } = await hello(client);
    const overworld = server.realms.overworld;
    client.send({ t: 'hold' });
    await sleep(TIDE_MS * 4);
    const body = overworld.world.getActor(actorId);
    if (body === undefined) throw new Error('no body on the overworld');
    const here = { x: body.x, y: body.y };
    const seen = sightFrom(overworld, here, sightRadiusOf(body));

    const memory = await memoryOnReturn(client, token, overworld);
    expect(memory, 'the overworld frame carried no memory at all').toBeDefined();
    if (memory === undefined) return;

    const { level } = overworld.world;
    const wrong: string[] = [];
    let hiddenInsideTheDisc = 0;
    for (let y = 0; y < level.h; y += 1) {
      for (let x = 0; x < level.w; x += 1) {
        const cell = keyOf({ x, y });
        if (fogHas(memory, level.w, x, y) !== seen.has(cell)) wrong.push(cell);
        const dx = x - here.x;
        const dy = y - here.y;
        if (dx * dx + dy * dy <= REVEAL_RADIUS * REVEAL_RADIUS && !seen.has(cell)) {
          hiddenInsideTheDisc += 1;
        }
      }
    }
    // NOT VACUOUS: some ground inside the old disc is out of sight from the
    // spawn, so a memory drawn as that disc cannot pass.
    expect(hiddenInsideTheDisc).toBeGreaterThan(0);
    expect(wrong, 'remembered tiles differ from exactly what was in sight').toEqual([]);
  });
});

describe('loot stays on the map after it leaves sight', () => {
  it('keeps a pile you saw on the floor frame once you are nowhere in sight of it', async () => {
    const client = await connect(server.port);
    const { actorId } = await hello(client);
    const town = await intoAshwick(client, actorId);
    const body = town.world.getActor(actorId);
    if (body === undefined) throw new Error('no body in the town');
    const radius = sightRadiusOf(body);
    const before = sightFrom(town, body, radius);
    const there = outOfSight(town, before, radius);
    const after = sightFrom(town, there, radius);

    // One pile on ground seen from the door, one on ground seen from the far
    // spot. The second exists only to make the floor frame change, so a frame
    // that still carries the first is a statement rather than a stale memo.
    const seenEarlier = floorWhere(town, (tile) => before.has(keyOf(tile)));
    const seenLater = floorWhere(town, (tile) => after.has(keyOf(tile)));
    town.world.addGroundItem(seenEarlier, 'item_watchmans_cap');
    expect(town.world.placeAt(actorId, there), 'could not put the body down').toBe(true);
    town.world.addGroundItem(seenLater, 'item_watchmans_cap');

    const cellsOf = (frame: Frame): string[] =>
      (frame['items'] as readonly { cell: readonly [number, number] }[]).map((row) =>
        row.cell.join(','),
      );
    const frame = await waitFor(
      client,
      (f) => f['t'] === 'ground' && cellsOf(f).includes(keyOf(seenLater)),
      'floor frame with the later pile',
    );
    expect(cellsOf(frame), 'the pile seen earlier fell off the floor').toContain(
      keyOf(seenEarlier),
    );
  });
});

describe('a closed instance takes its memory with it', () => {
  it('keeps memory on the instance`s own world, which closing lets go of', () => {
    /**
     * An instance id is never minted twice, so a closed instance's memory can
     * never be sent again: keeping it would be a leak with no symptom but the
     * heap. The memory lives on the instance's world (`World.memoryOf`), so it
     * goes when the registry lets go of that world.
     */
    const realms = createRealms({
      seed: 'memory-close',
      engineFor: (world) =>
        createTurnEngine({ world, downed: createDownedState(), parties: createPartyState() }),
    });
    const mine = SITES.get('site:hollow_mine');
    if (mine === undefined) throw new Error('no such site');
    const delve = realms.open(mine, 'party-memory');
    fogSet(delve.world.memoryOf('p1'), delve.world.level.w, 1, 1);
    expect(realms.close(delve.id)).toBe(true);
    expect(realms.get(delve.id), 'a closed instance can still be reached').toBeUndefined();

    // AND THE GATEWAY KEEPS NO STORE OF ITS OWN for a closed instance to leave
    // bitsets behind in. A source guard, because that closure is private.
    const source = readFileSync(
      new URL('../../src/server/net/gateway.ts', import.meta.url),
      'utf8',
    );
    expect(source, 'the gateway keeps its own memory store again').not.toMatch(
      /Map<string, Map<string, Uint8Array>>/,
    );
  });
});
