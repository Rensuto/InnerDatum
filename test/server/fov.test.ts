// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/engines/default/engine/Actor.lua:47 (`self.sight = t.sight or 20`)
//                       game/engines/default/engine/Actor.lua:520 (distance AND line)
//                       game/modules/tome/class/Game.lua (playerFOV — the party's eyes, unioned)
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SIGHT_RADIUS, canSee } from '../../src/server/world/sight.ts';
import { projectActors, visibleActorIds } from '../../src/server/view/projector.ts';
import { createWorld } from '../../src/server/world/world.ts';
import { createDownedState } from '../../src/server/engine/downed.ts';
import { createPartyState } from '../../src/server/engine/party.ts';
import { wsGateway } from '../../src/server/net/gateway.ts';
import { createTurnEngine } from '../../src/server/turn-engine.ts';
import { createRealms } from '../../src/server/world/realms.ts';
import { AiProfile } from '../../src/server/engine/actor.ts';
import { canWalk } from '../../src/shared/level.ts';
import { TileCode } from '../../src/shared/protocol.ts';
import { PROTOCOL_VERSION } from '../../src/shared/version.ts';
import type { Realms } from '../../src/server/world/realms.ts';
import type { World } from '../../src/server/world/world.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * EVERY CLIENT COULD SEE EVERY MONSTER ON THE MAP, AND HAD SINCE M1.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `Actor.lua:520` gates sight on TWO terms:
 *
 * ```lua
 * local sees_target = (self.sight and core.fov.distance(sx, sy, tx, ty) <= self.sight
 *                      or not self.sight) and ...
 * ```
 *
 * This codebase had the SECOND (`hasLineOfSight` has gated combat, talents and
 * AI since M2) and never the first, and neither was ever applied to the VIEW.
 * `projectActors` returned `world.allActors()` and its docblock said so —
 * *"FOV SEAM: this is the one that matters … Today: everyone."*
 *
 * ═══ WHY THIS FILE IS A WIRE TEST AND NOT A UNIT TEST ═══
 * Because FOV is not a filter, and a unit test would never have found that out.
 * `state` is a RESYNC frame — realm change, rename, level-up, respawn, and
 * nothing else. The per-turn transport is the sweep stream, and the client DROPS
 * a move for an actor it has never seen (`client/main.ts:4940`). So a filter on
 * the snapshot alone hides a monster at the last resync and never shows it
 * again, however close it walks — a board silently wrong for minutes at a time,
 * and green under every unit test you could write.
 *
 * The feature is the TRANSITIONS. So this drives a real socket and asserts the
 * frames: `joined` when something walks into sight, `left` when it walks out.
 */

const FRAME_TIMEOUT_MS = 4_000;

// ---------------------------------------------------------------------------
// The rule itself
// ---------------------------------------------------------------------------

describe('the sight rule', () => {
  /** An open field, so only the term under test can hide anything. */
  function field(): World {
    const world = createWorld('sight');
    world.level.tiles.fill(TileCode.FLOOR);
    return world;
  }

  it('is upstream`s twenty, not a number somebody picked', () => {
    // `engine/Actor.lua:47` — `self.sight = t.sight or 20`. PLAN.md called
    // choosing this a design decision still to be taken; it is a port.
    expect(SIGHT_RADIUS).toBe(20);
  });

  it('sees to the radius and not one tile past it', () => {
    const world = field();
    // THE FIXTURE MUST BE ABLE TO FAIL. A map narrower than the radius would
    // make every assertion below true of the wall instead of the rule.
    expect(world.level.w).toBeGreaterThan(SIGHT_RADIUS + 1);

    const eye = { x: 1, y: 1 };
    expect(canSee(world.level, eye, { x: 1 + SIGHT_RADIUS, y: 1 })).toBe(true);
    expect(canSee(world.level, eye, { x: 2 + SIGHT_RADIUS, y: 1 })).toBe(false);
  });

  it('measures a circle, not a king`s walk', () => {
    /**
     * `core.fov.distance` is Euclidean. This codebase uses `chebyshev` for
     * REACH, and using it here would make the diagonal corner of a square
     * visible at 20 while the cardinal edge at 21 was not — the wrong shape for
     * a torch, and a real difference: (16,16) is 21.2 from (1,1) and must be
     * dark, though its king-move distance is only 15.
     */
    const world = field();
    expect(canSee(world.level, { x: 1, y: 1 }, { x: 16, y: 16 })).toBe(false);
  });

  it('still stops at a wall well inside the radius', () => {
    // The half that already existed, asserted so that removing the range term
    // cannot be mistaken for removing the whole rule.
    const world = createWorld('sight-wall');
    world.level.tiles.fill(TileCode.FLOOR);
    for (let y = 0; y < world.level.h; y += 1) {
      world.level.tiles[y * world.level.w + 5] = TileCode.WALL;
    }
    expect(canSee(world.level, { x: 1, y: 3 }, { x: 3, y: 3 })).toBe(true);
    expect(canSee(world.level, { x: 1, y: 3 }, { x: 9, y: 3 })).toBe(false);
  });

  it('a body sees itself', () => {
    // Stated because the viewer is always inside the set this filters.
    const world = field();
    expect(canSee(world.level, { x: 4, y: 4 }, { x: 4, y: 4 })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The board a viewer is handed
// ---------------------------------------------------------------------------

describe('the projected board', () => {
  function peopled(): { world: World; near: string; far: string } {
    const world = createWorld('fov-board');
    world.level.tiles.fill(TileCode.FLOOR);
    const player = world.addPlayer('p1', 'Dalt');
    player.x = 1;
    player.y = 1;
    const near = world.addMonster('near', {
      name: 'Index Husk',
      sprite: 'enemy_index_husk_s',
      x: 3,
      y: 1,
      profile: AiProfile.MeleeChaser,
    });
    const far = world.addMonster('far', {
      name: 'Index Husk',
      sprite: 'enemy_index_husk_s',
      x: 1 + SIGHT_RADIUS + 3,
      y: 1,
      profile: AiProfile.MeleeChaser,
    });
    expect(world.level.w).toBeGreaterThan(far.x);
    return { world, near: near.id, far: far.id };
  }

  it('withholds a monster past the radius and keeps the one in front of you', () => {
    const { world, near, far } = peopled();
    const shown = projectActors(world, [{ x: 1, y: 1 }]).map((a) => a.id);
    expect(shown).toContain(near);
    expect(shown).not.toContain(far);
  });

  it('never withholds a teammate, however far away they are', () => {
    /**
     * Upstream's party is always on the map because it is always `game.party`.
     * Ours is a co-op game played in a voice channel: a party that could not see
     * its own scout would spend the session reading tile coordinates aloud, and
     * `standingBy`, the party panel and the turn banner are all fed from this
     * list and are all about people rather than things you are hunting.
     */
    const { world } = peopled();
    const mate = world.addPlayer('p2', 'Mate');
    mate.x = 1 + SIGHT_RADIUS + 3;
    mate.y = 1;
    expect(projectActors(world, [{ x: 1, y: 1 }]).map((a) => a.id)).toContain('p2');
  });

  it('unions the party`s eyes — what your scout sees, you see', () => {
    // `Game.lua#playerFOV` computes FOV for the player AND every party member
    // onto one `seens` map. The far husk is invisible from the door and obvious
    // from where the scout is standing.
    const { world, far } = peopled();
    const alone = projectActors(world, [{ x: 1, y: 1 }]).map((a) => a.id);
    const scouted = projectActors(world, [
      { x: 1, y: 1 },
      { x: 1 + SIGHT_RADIUS, y: 1 },
    ]).map((a) => a.id);
    expect(alone).not.toContain(far);
    expect(scouted).toContain(far);
  });

  it('and no eyes at all still means the whole board, for the GM console', () => {
    // `projectActors(world)` with no eyes is the 127.0.0.1-only path. The guard
    // at the bottom of this file is what keeps it off the player path.
    const { world, far } = peopled();
    expect(projectActors(world).map((a) => a.id)).toContain(far);
  });

  it('the id set and the view list are the same answer', () => {
    // Two functions, and the gateway diffs one against the other. If they ever
    // disagreed the symptom would be a monster on your board that you are not
    // considered able to see, or the reverse.
    const { world } = peopled();
    const eyes = [{ x: 1, y: 1 }];
    expect([...visibleActorIds(world, eyes)].sort()).toEqual(
      projectActors(world, eyes)
        .map((a) => a.id)
        .sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// The transitions, over a real socket
// ---------------------------------------------------------------------------

type Harness = { port: number; realms: Realms; close: () => Promise<void> };
let server: Harness;
const openSockets: WebSocket[] = [];

beforeEach(async () => {
  const downed = createDownedState();
  const parties = createPartyState();
  const realms = createRealms({
    seed: 'fov-wire',
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

type Client = {
  actorId: string;
  send(frame: Record<string, unknown>): void;
  /** Every actor id this client's board holds, replaying the frames it got. */
  board(): Set<string>;
};

async function hello(port: number): Promise<Client> {
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
    if (typeof id === 'string') {
      return {
        actorId: id,
        send(frame): void {
          socket.send(JSON.stringify({ v: PROTOCOL_VERSION, ...frame }));
        },
        /**
         * THE CLIENT'S OWN BOOKKEEPING, REPLAYED. `client/main.ts:11247-11255`
         * is four lines — `joined` sets, `left` deletes — and a snapshot
         * replaces. Asserting against a replay of the real handler rather than
         * against "did some frame arrive" is what makes this a test about the
         * board the player is actually looking at.
         */
        board(): Set<string> {
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
        },
      };
    }
    if (Date.now() >= deadline) throw new Error('no welcome came back');
    await sleep(5);
  }
}

describe('a monster walking into and out of sight', () => {
  it('is not on your board until it is, and is off it again when it leaves', async () => {
    const client = await hello(server.port);
    const world = server.realms.overworld.world;
    const body = world.getActor(client.actorId);
    if (body === undefined) throw new Error('no body');

    // A TILE GENUINELY OUT OF SIGHT, found rather than assumed — a map with no
    // such tile would make every assertion below true of the fixture.
    const level = world.level;
    let dark: { x: number; y: number } | undefined;
    for (let y = 0; y < level.h && dark === undefined; y += 1) {
      for (let x = 0; x < level.w; x += 1) {
        if (!canWalk(level, x, y)) continue;
        if (world.actorAt(x, y) !== undefined) continue;
        if (!canSee(level, body, { x, y })) {
          dark = { x, y };
          break;
        }
      }
    }
    expect(dark, 'no walkable tile is out of sight — the fixture cannot test FOV').toBeDefined();
    if (dark === undefined) return;

    const lurker = world.addMonster('lurker', {
      name: 'Index Husk',
      sprite: 'enemy_index_husk_s',
      x: dark.x,
      y: dark.y,
      profile: AiProfile.MeleeChaser,
      aggroRange: 0, // it must not decide to come and find us mid-test
    });

    // ═══ OUT OF SIGHT ═══
    client.send({ t: 'hold' });
    await sleep(250);
    expect(client.board(), 'a monster out of sight is on the board').not.toContain(lurker.id);

    // ═══ IT STEPS INTO THE LIGHT ═══
    const here = world.getActor(client.actorId);
    if (here === undefined) throw new Error('no body');
    lurker.x = here.x + 1;
    lurker.y = here.y;
    client.send({ t: 'hold' });
    await sleep(250);
    expect(
      client.board(),
      'a monster standing next to you never reached your board — this is the bug a ' +
        'snapshot-only filter would have shipped',
    ).toContain(lurker.id);

    // ═══ AND BACK OUT ═══
    lurker.x = dark.x;
    lurker.y = dark.y;
    client.send({ t: 'hold' });
    await sleep(250);
    expect(client.board(), 'it left sight and stayed on the board').not.toContain(lurker.id);
  });

  it('and you are always on your own board', async () => {
    const client = await hello(server.port);
    client.send({ t: 'hold' });
    await sleep(250);
    expect(client.board()).toContain(client.actorId);
  });
});

// ---------------------------------------------------------------------------
// The guard the projector's docblock promises
// ---------------------------------------------------------------------------

describe('every player-facing send is fogged', () => {
  it('no snapshot reaches a socket unfiltered', () => {
    /**
     * `projectActors(world)` with no eyes is the WHOLE BOARD, and it is a
     * legitimate call for the GM console and the ops listener. The projector's
     * docblock promises this test exists, so that a future unfiltered send to a
     * player is a red line rather than a silent leak.
     *
     * A SOURCE GUARD, the weakest kind, chosen because the alternative is none:
     * there is no runtime seam that can tell a GM read from a player read.
     */
    const text = readFileSync(new URL('../../src/server/net/gateway.ts', import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    const unfogged = [...text.matchAll(/project(?:Actors|World)\(\s*[A-Za-z.]+\s*\)/g)].map(
      (m) => m[0],
    );
    expect(
      unfogged,
      'a snapshot is built without eyes in the gateway — every send there serves a player',
    ).toEqual([]);
  });
});
