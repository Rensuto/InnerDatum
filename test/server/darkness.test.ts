// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

import { setTimeout as sleep } from 'node:timers/promises';

import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AiProfile } from '../../src/server/engine/actor.ts';
import { DamageType } from '../../src/server/engine/damage.ts';
import { createDownedState } from '../../src/server/engine/downed.ts';
import { sightRadiusOf } from '../../src/server/engine/derived.ts';
import { composeWielders } from '../../src/server/engine/equipment.ts';
import { createPartyState } from '../../src/server/engine/party.ts';
import { wsGateway } from '../../src/server/net/gateway.ts';
import { createTurnEngine } from '../../src/server/turn-engine.ts';
import { inspectActor } from '../../src/server/view/inspect.ts';
import { projectProjectiles, visibleActorIds } from '../../src/server/view/projector.ts';
import { createRealms } from '../../src/server/world/realms.ts';
import { createWorld } from '../../src/server/world/world.ts';
import { fogBytes, fogFromBase64, fogHas } from '../../src/shared/fog.ts';
import { canWalk } from '../../src/shared/level.ts';
import { TileCode, alwaysRemembered } from '../../src/shared/protocol.ts';
import { RestStop } from '../../src/shared/rest.ts';
import { canSee } from '../../src/shared/sight.ts';
import { PROTOCOL_VERSION } from '../../src/shared/version.ts';
import type { Realms } from '../../src/server/world/realms.ts';
import type { World } from '../../src/server/world/world.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE SERVER SEES BY THE LIGHT THERE IS, AND EVERY QUESTION READS ONE SET.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * No shipped site is dark yet, so each case darkens its own level: a level built
 * with a room chance of 0 lights nothing (`shared/light.ts`), and the wire cases
 * put the whole moor out before anybody arrives.
 */

const FRAME_TIMEOUT_MS = 4_000;
/** Where the viewer stands in the cases with no socket. */
const EYE = { x: 5, y: 5 };
/** Inside sight, and outside a brass lantern's 2. */
const FAR = 4;

/** An open floor, lit everywhere or nowhere. */
function floor(lit: boolean): World {
  const world = createWorld('darkness', undefined, '', lit ? undefined : { litRoomChance: 0 });
  world.level.tiles.fill(TileCode.FLOOR);
  return world;
}

/** A viewer at `EYE` carrying a light of `lite`. */
function eyeWith(lite: number): { x: number; y: number; combat: { mods: { lite: number } } } {
  return { ...EYE, combat: { mods: { lite } } };
}

/** A husk that stays where it is put. */
function husk(world: World, id: string, x: number, y: number) {
  return world.addMonster(id, {
    name: 'Index Husk',
    sprite: 'enemy_index_husk_s',
    x,
    y,
    profile: AiProfile.MeleeChaser,
    aggroRange: 0,
  });
}

describe('the board, in the dark', () => {
  it('does not show a husk past the lantern, and does once the level is lit', () => {
    const dark = floor(false);
    husk(dark, 'far', EYE.x + FAR, EYE.y);
    expect(visibleActorIds(dark, [eyeWith(2)]).has('far')).toBe(false);

    const lit = floor(true);
    husk(lit, 'far', EYE.x + FAR, EYE.y);
    expect(visibleActorIds(lit, [eyeWith(2)]).has('far')).toBe(true);
  });

  it('shows the husk the lantern reaches, and not with no lantern at all', () => {
    const world = floor(false);
    husk(world, 'near', EYE.x + 1, EYE.y);
    expect(visibleActorIds(world, [eyeWith(2)]).has('near'), 'lantern 2').toBe(true);
    expect(visibleActorIds(world, [eyeWith(0)]).has('near'), 'no lantern').toBe(false);
  });

  it('shows a husk by a teammate’s lantern, when the viewer has it in sight', () => {
    const world = floor(false);
    const mate = world.addPlayer('mate', 'mate');
    mate.x = EYE.x + FAR;
    mate.y = EYE.y + 1;
    mate.combat = composeWielders(mate.combat ?? {}, [{ mods: { lite: 2 } }]);
    husk(world, 'lit-by-mate', EYE.x + FAR, EYE.y);
    expect(visibleActorIds(world, [eyeWith(0)]).has('lit-by-mate')).toBe(true);
  });
});

describe('a shot in the dark', () => {
  it('is not drawn past the lantern, and is once the level is lit', () => {
    for (const lit of [false, true]) {
      const world = floor(lit);
      husk(world, 'shooter', EYE.x + FAR + 2, EYE.y);
      const orb = world.addProjectile({
        sourceId: 'shooter',
        origin: { x: EYE.x + FAR + 2, y: EYE.y },
        to: { x: EYE.x + FAR, y: EYE.y },
        projSpeed: 1,
        range: 10,
        damage: { dam: 5, type: DamageType.Physical, apr: 0 },
      });
      const drawn = projectProjectiles(world, [eyeWith(2)]).projectiles.map((p) => p.id);
      expect(drawn.includes(orb.id), `lit: ${String(lit)}`).toBe(lit);
    }
  });
});

describe('inspecting in the dark', () => {
  it('answers nothing for a husk nobody can see, and a card once the level is lit', () => {
    for (const lit of [false, true]) {
      const world = floor(lit);
      const viewer = world.addPlayer('viewer', 'viewer');
      viewer.x = EYE.x;
      viewer.y = EYE.y;
      const target = husk(world, 'far', EYE.x + FAR, EYE.y);
      expect(inspectActor(world, viewer, target) !== null, `lit: ${String(lit)}`).toBe(lit);
    }
  });
});

describe('a rest in the dark', () => {
  /** A hurt player at `EYE` with no lantern, and a husk `FAR` tiles east. */
  function rest(lit: boolean) {
    const world = floor(lit);
    const engine = createTurnEngine({
      world,
      downed: createDownedState(),
      parties: createPartyState(),
    });
    const body = world.addPlayer('p1', 'p1', { maxHp: 40 });
    body.x = EYE.x;
    body.y = EYE.y;
    engine.join('p1');
    engine.setConnected('p1', true);
    engine.pump();
    body.hp = 10;
    husk(world, 'far', EYE.x + FAR, EYE.y);
    return engine.rest('p1');
  }

  it('is not broken by a husk nobody can see', () => {
    expect(rest(false).stop).not.toBe(RestStop.Hostile);
  });

  it('and is broken by the same husk once the level is lit', () => {
    expect(rest(true).stop).toBe(RestStop.Hostile);
  });

  /** The same hurt player with no lantern, and a shot fired at them from six tiles east. */
  function restUnderFire(lit: boolean) {
    const world = floor(lit);
    const engine = createTurnEngine({
      world,
      downed: createDownedState(),
      parties: createPartyState(),
    });
    const body = world.addPlayer('p1', 'p1', { maxHp: 40 });
    body.x = EYE.x;
    body.y = EYE.y;
    engine.join('p1');
    engine.setConnected('p1', true);
    engine.pump();
    body.hp = 10;
    world.addProjectile({
      sourceId: 'somebody',
      origin: { x: EYE.x + 6, y: EYE.y },
      to: { x: EYE.x, y: EYE.y },
      projSpeed: 1,
      range: 20,
      damage: { dam: 1, type: DamageType.Physical, apr: 0 },
    });
    return engine.rest('p1');
  }

  it('is not broken by a shot coming out of the dark', () => {
    // Upstream stops a rest for a projectile only on a grid the player sees.
    expect(restUnderFire(false).stop).not.toBe(RestStop.Hostile);
  });

  it('and is broken by the same shot once the level is lit', () => {
    expect(restUnderFire(true).stop).toBe(RestStop.Hostile);
  });
});

describe('the dark, over the wire', () => {
  let harness: { port: number; realms: Realms; close: () => Promise<void> };
  const sockets: WebSocket[] = [];

  beforeEach(async () => {
    const downed = createDownedState();
    const parties = createPartyState();
    const realms = createRealms({
      seed: 'darkness-wire',
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
    send(frame: Record<string, unknown>): void;
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
          send(frame): void {
            socket.send(JSON.stringify({ v: PROTOCOL_VERSION, ...frame }));
          },
        };
      }
      if (Date.now() >= deadline) throw new Error('no welcome came back');
      await sleep(5);
    }
  }

  /** One turn, and the frames it sends. */
  async function hold(client: Client): Promise<void> {
    client.send({ t: 'hold' });
    await sleep(250);
  }

  /** The board the client holds: a snapshot replaces it, `joined` adds, `left` removes. */
  function board(frames: readonly Record<string, unknown>[]): Set<string> {
    const held = new Set<string>();
    for (const frame of frames) {
      const t = frame['t'];
      if (t === 'welcome' || t === 'state' || t === 'realm') {
        const rows = frame['actors'];
        if (!Array.isArray(rows)) continue;
        if (t !== 'welcome') held.clear();
        for (const row of rows as Record<string, unknown>[]) {
          if (typeof row['id'] === 'string') held.add(row['id']);
        }
      } else if (t === 'joined') {
        const actor = frame['actor'];
        if (typeof actor === 'object' && actor !== null) {
          const who = (actor as Record<string, unknown>)['id'];
          if (typeof who === 'string') held.add(who);
        }
      } else if (t === 'left') {
        const who = frame['id'];
        if (typeof who === 'string') held.delete(who);
      }
    }
    return held;
  }

  /** The cells of the latest `ground` frame. */
  function ground(frames: readonly Record<string, unknown>[]): Set<string> {
    const last = [...frames].reverse().find((f) => f['t'] === 'ground');
    const rows = last?.['items'];
    const cells = new Set<string>();
    if (!Array.isArray(rows)) return cells;
    for (const row of rows as { cell?: unknown }[]) {
      if (Array.isArray(row.cell)) cells.add(row.cell.join(','));
    }
    return cells;
  }

  it('keeps a husk past the lantern off the board, and puts it on inside the lantern', async () => {
    const world = harness.realms.overworld.world;
    // THE WHOLE MOOR DARK BEFORE ANYBODY ARRIVES, so nothing was seen by daylight.
    world.lit.fill(0);
    const client = await join();
    const body = world.getActor(client.actorId);
    if (body === undefined) throw new Error('no body');
    expect(body.equipped?.['lite'], 'precondition: the join gave a lantern').toBe(
      'item_brass_lantern',
    );

    const level = world.level;
    const spot = [
      { x: body.x + FAR, y: body.y },
      { x: body.x - FAR, y: body.y },
      { x: body.x, y: body.y + FAR },
      { x: body.x, y: body.y - FAR },
    ].find(
      (t) =>
        canWalk(level, t.x, t.y) && world.actorAt(t.x, t.y) === undefined && canSee(level, body, t),
    );
    expect(
      spot,
      'no open tile four away in sight: this fixture cannot test the dark',
    ).toBeDefined();
    if (spot === undefined) return;

    const lurker = husk(world, 'lurker', spot.x, spot.y);
    await hold(client);
    expect(board(client.frames), 'a husk in the dark reached the board').not.toContain(lurker.id);

    // One step from the body, on the line to where it stood: inside the lantern.
    lurker.x = body.x + Math.sign(spot.x - body.x);
    lurker.y = body.y + Math.sign(spot.y - body.y);
    await hold(client);
    expect(board(client.frames), 'a husk inside the lantern never reached the board').toContain(
      lurker.id,
    );
  });

  it('shows the ground its lantern lights, keeps none of it, and shows the loot on it', async () => {
    const world = harness.realms.overworld.world;
    world.lit.fill(0);
    const client = await join();
    const body = world.getActor(client.actorId);
    if (body === undefined) throw new Error('no body');
    const level = world.level;

    // GROUND MEMORY DOES NOT KEEP, INSIDE THE LANTERN, found rather than assumed.
    let spot: { x: number; y: number } | undefined;
    for (let dy = -2; dy <= 2 && spot === undefined; dy += 1) {
      for (let dx = -2; dx <= 2; dx += 1) {
        const x = body.x + dx;
        const y = body.y + dy;
        if ((dx === 0 && dy === 0) || dx * dx + dy * dy > 4) continue;
        if (x < 0 || y < 0 || x >= level.w || y >= level.h) continue;
        if (alwaysRemembered(level.tiles[y * level.w + x] ?? TileCode.WALL)) continue;
        if (!canWalk(level, x, y) || !canSee(level, body, { x, y })) continue;
        spot = { x, y };
        break;
      }
    }
    expect(
      spot,
      'no forgettable ground inside the lantern: this fixture cannot test memory',
    ).toBeDefined();
    if (spot === undefined) return;

    world.addGroundItem(spot, 'item_watchmans_cap');
    await hold(client);

    const frame = [...client.frames].reverse().find((f) => f['t'] === 'vision');
    expect(frame, 'no vision frame came').toBeDefined();
    const x0 = Number(frame?.['x0']);
    const y0 = Number(frame?.['y0']);
    const w = Number(frame?.['w']);
    const h = Number(frame?.['h']);
    expect(frame?.['sight'], 'the vision frame carries no sight radius').toBe(sightRadiusOf(body));
    const seen = fogFromBase64(String(frame?.['seen']), fogBytes(w, h));
    const remembered = fogFromBase64(String(frame?.['remembered']), fogBytes(w, h));
    expect(fogHas(seen, w, spot.x - x0, spot.y - y0), 'the lantern did not show it').toBe(true);
    expect(fogHas(remembered, w, spot.x - x0, spot.y - y0), 'memory kept dark ground').toBe(false);
    expect(ground(client.frames), 'the loot on it was withheld').toContain(
      `${String(spot.x)},${String(spot.y)}`,
    );
  });
});
