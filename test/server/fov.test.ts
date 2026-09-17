// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/engines/default/engine/Actor.lua:47 (`self.sight = t.sight or 20`)
//                       game/engines/default/engine/Actor.lua:520 (distance AND line)
//                       game/modules/tome/class/Game.lua:1755 (playerFOV: the played character's sight alone)
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_SIGHT_RADIUS,
  MINIMAP_REVEAL_RADIUS,
  canSee,
  sightDistance,
} from '../../src/shared/sight.ts';
import { REVEAL_RADIUS, fogBytes, fogFromBase64, fogHas } from '../../src/shared/fog.ts';
import { projectActors, visibleActorIds } from '../../src/server/view/projector.ts';
import { createWorld } from '../../src/server/world/world.ts';
import { createDownedState } from '../../src/server/engine/downed.ts';
import { createPartyState } from '../../src/server/engine/party.ts';
import { wsGateway } from '../../src/server/net/gateway.ts';
import { createTurnEngine } from '../../src/server/turn-engine.ts';
import { SITES, createRealms, stairsDownOf } from '../../src/server/world/realms.ts';
import { AiProfile, Faction, isMonster } from '../../src/server/engine/actor.ts';
import { WATCHMAN } from '../../src/server/content/classes.ts';
import { sightRadiusOf } from '../../src/server/engine/derived.ts';
import { STUNNED } from '../../src/server/content/effects.ts';
import { DamageType } from '../../src/server/engine/damage.ts';
import { createEffectState, setEffect } from '../../src/server/engine/effects.ts';
import { createRng } from '../../src/shared/rng.ts';
import type { EffectState } from '../../src/server/engine/effects.ts';
import { canWalk } from '../../src/shared/level.ts';
import { TileCode } from '../../src/shared/protocol.ts';
import { PropId } from '../../src/shared/props.ts';
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

  it('is upstream`s TEN — and this test asserted 20 for three commits', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE ENGINE SAYS 20. THE MODULE SAYS 10. THE MODULE IS THE GAME.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `engine/Actor.lua:47` is `self.sight = t.sight or 20`, and that citation
     * is what this file shipped with — under the heading "not a number somebody
     * picked", which was true and beside the point.
     *
     * ToME is a MODULE on that engine. `modules/tome/class/Actor.lua:178` sets
     * `t.sight = t.sight or 10` in its own `init` and delegates to
     * `engine.Actor.init` at :264, so `t.sight` is already 10 when the engine's
     * line runs and the `or 20` never fires. Every module call site agrees:
     * `Player.lua:648`, `:854`, `NPC.lua:102`, `:114`, `Game.lua:2068` all pass
     * `self.sight or 10`.
     *
     * CLAUDE.md's rule is "when the docs and the Lua disagree, the Lua wins".
     * The sharper version, learned here: WHEN THE ENGINE AND THE MODULE
     * DISAGREE, THE MODULE WINS — it is the game we are porting.
     */
    expect(DEFAULT_SIGHT_RADIUS).toBe(10);
  });

  it('sees to the radius and not one tile past it', () => {
    const world = field();
    // THE FIXTURE MUST BE ABLE TO FAIL. A map narrower than the radius would
    // make every assertion below true of the wall instead of the rule.
    expect(world.level.w).toBeGreaterThan(DEFAULT_SIGHT_RADIUS + 1);

    const eye = { x: 1, y: 1 };
    expect(canSee(world.level, eye, { x: 1 + DEFAULT_SIGHT_RADIUS, y: 1 })).toBe(true);
    expect(canSee(world.level, eye, { x: 2 + DEFAULT_SIGHT_RADIUS, y: 1 })).toBe(false);
  });

  it('measures a circle, not a king`s walk', () => {
    /**
     * `core.fov.distance` is Euclidean. This codebase uses `chebyshev` for
     * REACH, and using it here would make the diagonal corner of a square
     * visible while the cardinal edge just past the radius was not — the wrong
     * shape for a torch.
     *
     * (9,9) is the discriminating tile at radius 10: its king-move distance from
     * (1,1) is 8 and would be IN, its true distance is 11.3 and is OUT. A
     * mutation to `chebyshev` fails here and nowhere else.
     */
    const world = field();
    expect(canSee(world.level, { x: 1, y: 1 }, { x: 9, y: 9 })).toBe(false);
    // ...while the cardinal tile at exactly the radius is in, so the assertion
    // above is about the METRIC and not merely about the distance.
    expect(canSee(world.level, { x: 1, y: 1 }, { x: 11, y: 1 })).toBe(true);
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
      x: 1 + DEFAULT_SIGHT_RADIUS + 3,
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

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * A BODY THAT SEES FURTHER ACTUALLY SEES FURTHER — `self.sight`, tome/class/Actor.lua:178.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `CombatMods.sight` folds and `sightRadiusOf` reads it, and BOTH of those can
   * be right while the projection still spends the constant — which is exactly
   * what happened: reverting this call site to the bare `canSee(level, eye,
   * actor)` left the whole suite green. A channel the FOV does not spend is a
   * bonus nobody can see with.
   *
   * THE MONSTER SITS ONE TILE PAST THE DEFAULT, so the assertion is the
   * difference the talent makes and nothing else.
   */
  it('lets an eye with a sight bonus reach one tile further', () => {
    const world = createWorld('fov-sight');
    world.level.tiles.fill(TileCode.FLOOR);
    const beyond = 'beyond';
    world.addMonster(beyond, {
      name: 'Index Husk',
      sprite: 'enemy_index_husk_s',
      x: 1 + DEFAULT_SIGHT_RADIUS + 1,
      y: 1,
      profile: AiProfile.MeleeChaser,
    });

    const plain = { x: 1, y: 1 };
    expect(projectActors(world, [plain]).map((a) => a.id)).not.toContain(beyond);

    const keen = { x: 1, y: 1, combat: { mods: { sight: 1 } } };
    expect(projectActors(world, [keen]).map((a) => a.id)).toContain(beyond);
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
    mate.x = 1 + DEFAULT_SIGHT_RADIUS + 3;
    mate.y = 1;
    expect(projectActors(world, [{ x: 1, y: 1 }]).map((a) => a.id)).toContain('p2');
  });

  it('unions a list of eyes, though the gateway hands it only one', () => {
    // Every frame is built from ONE viewer's body now (`eyesOf` in the gateway),
    // and the wire tests below hold that. This is the projector's own rule for a
    // list of eyes, kept in one place.
    const { world, far } = peopled();
    const alone = projectActors(world, [{ x: 1, y: 1 }]).map((a) => a.id);
    const scouted = projectActors(world, [
      { x: 1, y: 1 },
      { x: 1 + DEFAULT_SIGHT_RADIUS, y: 1 },
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
let effects: EffectState;
const openSockets: WebSocket[] = [];

beforeEach(async () => {
  const downed = createDownedState();
  const parties = createPartyState();
  const realms = createRealms({
    seed: 'fov-wire',
    engineFor: (world) => createTurnEngine({ world, downed, parties }),
  });
  effects = createEffectState([STUNNED]);
  const app = Fastify({ logger: false });
  await app.register(wsGateway, {
    world: realms.overworld.world,
    engine: realms.overworld.engine,
    realms,
    parties,
    downed,
    effects,
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
  readonly frames: readonly Record<string, unknown>[];
  send(frame: Record<string, unknown>): void;
  /** Every actor id this client's board holds, replaying the frames it got. */
  board(): Set<string>;
  /** The cells of the latest `ground` frame, or none if there has not been one. */
  ground(): Set<string>;
  /** The cells of the dressing this client holds — see `props` below. */
  props(): Set<string>;
  /** The minimap's own marks this client holds, `"x,y" -> kind`. */
  beacons(): Map<string, string>;
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
        frames,
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
        ground(): Set<string> {
          const last = [...frames].reverse().find((f) => f['t'] === 'ground');
          const rows = last?.['items'];
          const cells = new Set<string>();
          if (!Array.isArray(rows)) return cells;
          for (const row of rows as { cell?: unknown }[]) {
            if (Array.isArray(row.cell)) cells.add(row.cell.join(','));
          }
          return cells;
        },
        /**
         * The dressing this client currently holds, replaying its own handler.
         *
         * THE LATEST `props` FRAME WINS AND THE MAP FRAME SEEDS IT, which is
         * the client's rule: `realm` carries what was in sight on arrival and
         * every later change — including the EMPTY list that withdraws a room's
         * furniture — comes on a `props` frame. Reading only the last `props`
         * would score an arrival as "no dressing" and hide a real leak.
         */
        props(): Set<string> {
          const last = [...frames]
            .reverse()
            .find((f) => (f['t'] === 'props' || f['t'] === 'realm') && 'props' in f);
          const rows = last?.['props'];
          const cells = new Set<string>();
          if (!Array.isArray(rows)) return cells;
          for (const row of rows as { x?: unknown; y?: unknown }[]) {
            cells.add(`${String(row.x)},${String(row.y)}`);
          }
          return cells;
        },
        /**
         * The minimap's own marks this client holds, as `cell -> kind`. Same
         * replay rule as `props`: `sites` is the later frame and `realm` seeds it.
         */
        beacons(): Map<string, string> {
          const last = [...frames].reverse().find((f) => f['t'] === 'sites' || f['t'] === 'realm');
          const rows = last?.['beacons'];
          const marks = new Map<string, string>();
          if (!Array.isArray(rows)) return marks;
          for (const row of rows as { x?: unknown; y?: unknown; kind?: unknown }[]) {
            marks.set(`${String(row.x)},${String(row.y)}`, String(row.kind));
          }
          return marks;
        },
      };
    }
    if (Date.now() >= deadline) throw new Error('no welcome came back');
    await sleep(5);
  }
}

/**
 * A body's tile and a tile beside it, both free floor, in sight of each other,
 * and more than `minDist` from every tile in `from`.
 *
 * FAR BY DISTANCE RATHER THAN BY A WALL, so the fixture leans on nothing about
 * the map's walls: past the sight radius nothing is in sight, and past the
 * overworld's reveal disc nothing is remembered either.
 */
function farPair(
  world: World,
  from: readonly { x: number; y: number }[],
  minDist: number,
  avoid: ReadonlySet<string> = new Set(),
): { body: { x: number; y: number }; lurk: { x: number; y: number } } {
  const level = world.level;
  const free = (x: number, y: number): boolean =>
    canWalk(level, x, y) &&
    world.actorAt(x, y) === undefined &&
    !avoid.has(`${String(x)},${String(y)}`);
  const far = (x: number, y: number): boolean =>
    from.every((tile) => (tile.x - x) ** 2 + (tile.y - y) ** 2 > minDist * minDist);
  for (let y = 1; y < level.h - 1; y += 1) {
    for (let x = 1; x < level.w - 2; x += 1) {
      if (!free(x, y) || !free(x + 1, y) || !far(x, y) || !far(x + 1, y)) continue;
      const body = { x, y };
      const lurk = { x: x + 1, y };
      if (canSee(level, body, lurk)) return { body, lurk };
    }
  }
  throw new Error('no free pair of tiles that far from everyone');
}

/**
 * A free walkable tile AT a distance, rather than merely past one.
 *
 * `farPair` answers "far enough", which is the right question for a sight test
 * and the wrong one for a RADIUS test: a beacon case has to put one body inside
 * the reveal radius and one outside it, and "somewhere past 14" could land both
 * on the same side. This bands the distance to `[dist, dist + 1)` — the same
 * Euclidean `sightDistance` the server measures with, never a king's walk.
 *
 * THE BAND IS `(dist - 1, dist]`, WHICH IS THE HALF THAT MATTERS. A tile "at
 * least 20 away" can be 20.4 away, and a case built on one cannot tell `<= 20`
 * from `< 20`. Landing AT OR JUST UNDER the asked-for distance makes
 * `ringTile(r)` and `ringTile(r + 1)` a genuine boundary pair: the first must be
 * admitted and the second must not, whatever `r` is.
 *
 * It THROWS rather than returning undefined: a fixture that could not place its
 * own body has not tested anything, and a skipped assertion reads as a pass.
 */
function ringTile(
  world: World,
  from: { x: number; y: number },
  dist: number,
  avoid: readonly { x: number; y: number }[] = [],
): { x: number; y: number } {
  const level = world.level;
  for (let y = 1; y < level.h - 1; y += 1) {
    for (let x = 1; x < level.w - 1; x += 1) {
      if (!canWalk(level, x, y) || world.actorAt(x, y) !== undefined) continue;
      if (avoid.some((t) => t.x === x && t.y === y)) continue;
      const d = sightDistance(from, { x, y });
      if (d > dist - 1 && d <= dist) return { x, y };
    }
  }
  throw new Error(`no free tile at distance ${String(dist)}`);
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

  /**
   * ═════════════════════════════════════════════════════════════════════════
   * THE DRESSING, WHICH IS THE ONE THING HERE THAT DOES NOT COME BACK.
   * ═════════════════════════════════════════════════════════════════════════
   *
   * MEASURED on the live server before this: standing in the street of
   * Alderbrook a viewer could see 0 of the town's 43 props by the sight rule and
   * was sent all 43 — the inside of every building painted over never-seen black
   * (`projectProps` shipped with no eyes at all, arguing the leak on purpose).
   *
   * Ruled by the author on 2026-09-17: *"the props should only be visible if you
   * have actual line of sight with it."* That is a DELIBERATE DIVERGENCE —
   * `engine/Object.lua:28-29` would remember dressing, and floor loot below
   * still does.
   */
  it('keeps a prop off your floor until you can see it, and takes it back off when you look away', async () => {
    const client = await hello(server.port);
    const world = server.realms.overworld.world;
    const body = world.getActor(client.actorId);
    if (body === undefined) throw new Error('no body');

    // A TILE GENUINELY OUT OF SIGHT, FOUND RATHER THAN ASSUMED — and a second
    // one, in sight, to stand on. A fixture with no dark tile would make every
    // assertion here true of the map instead of the rule.
    const level = world.level;
    const { body: far, lurk } = farPair(world, [body], DEFAULT_SIGHT_RADIUS + 4);
    expect(
      canSee(level, body, lurk),
      'the prop tile is already in sight — the fixture cannot test the rule',
    ).toBe(false);
    world.addProp(lurk, PropId.OfferingBowl);
    const cell = `${String(lurk.x)},${String(lurk.y)}`;

    // ═══ OUT OF SIGHT: IT IS NOT ON THE WIRE AT ALL ═══
    client.send({ t: 'hold' });
    await sleep(250);
    expect(client.props(), 'a prop out of sight is on your floor').not.toContain(cell);

    // ═══ WALK UP TO IT ═══
    body.x = far.x;
    body.y = far.y;
    client.send({ t: 'hold' });
    await sleep(250);
    expect(
      client.props(),
      'a prop on the tile beside you never reached your floor — the map frame alone ' +
        'cannot do this, which is why `props` is a frame of its own',
    ).toContain(cell);

    // ═══ AND WALK AWAY AGAIN. THIS HALF IS THE WHOLE COMMIT ═══
    const home = farPair(world, [lurk], DEFAULT_SIGHT_RADIUS + 4).body;
    body.x = home.x;
    body.y = home.y;
    client.send({ t: 'hold' });
    await sleep(250);
    expect(
      client.props(),
      'the furniture stayed on screen after you left the room — a prop is never drawn ' +
        'from memory',
    ).not.toContain(cell);
  });

  it('forgets the bookshelf on a tile you remember and still shows you the coat on it', async () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE CASE THAT SEPARATES THE TWO RULES, AND IT IS THE POINT OF BOTH.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * One tile, one prop, one coat, one viewer who has stood there and walked
     * away. `engine/Object.lua:28-29` gives objects `display_on_remember`, so the
     * COAT is still on their floor — upstream's rule, kept. The PROP is not —
     * ours, ruled 2026-09-17.
     *
     * MUTATION-CHECKED FROM INSIDE: swap `seenTilesFor` for `knownTilesFor` in
     * `broadcastPropsIfChanged` and this case fails on the prop while the coat
     * keeps passing, so it is the RULE under test and not the fixture.
     */
    const client = await hello(server.port);
    const world = server.realms.overworld.world;
    const body = world.getActor(client.actorId);
    if (body === undefined) throw new Error('no body');

    const { body: stand, lurk } = farPair(world, [body], DEFAULT_SIGHT_RADIUS + 4);
    world.addProp(lurk, PropId.OfferingBowl);
    world.addGroundItem(lurk, 'item_watchmans_cap');
    const cell = `${String(lurk.x)},${String(lurk.y)}`;

    // ═══ STAND THERE AND LOOK AT IT, so the pump writes it into memory ═══
    body.x = stand.x;
    body.y = stand.y;
    client.send({ t: 'hold' });
    await sleep(250);
    expect(client.props(), 'the prop beside you was never sent at all').toContain(cell);
    expect(client.ground(), 'the coat beside you was never sent at all').toContain(cell);

    // ═══ WALK OUT OF SIGHT OF IT. THE TILE IS NOW REMEMBERED AND UNSEEN ═══
    const away = farPair(world, [lurk], DEFAULT_SIGHT_RADIUS + 4).body;
    body.x = away.x;
    body.y = away.y;
    client.send({ t: 'hold' });
    await sleep(250);

    expect(
      client.ground(),
      'a coat on a tile you remember fell off your floor — that is upstream`s rule and ' +
        'it is not the one that changed',
    ).toContain(cell);
    expect(
      client.props(),
      'a prop on a tile you merely REMEMBER is on your floor — props have no memory',
    ).not.toContain(cell);
  });

  it('keeps a townsperson behind a wall off your board, and tells you when they step out', async () => {
    /**
     * THE HALF THE AUTHOR REPORTED AS *"i can see assets, people and props
     * through walls"*, pinned. `placeTownsfolk` stamps `Faction.Townsfolk` on a
     * resident and adds them with `world.addMonster`, so a townsperson takes the
     * ordinary monster path through `visibleActorIds` — there is no faction
     * exemption anywhere and this case is what keeps one from being added.
     */
    const client = await hello(server.port);
    const world = server.realms.overworld.world;
    const body = world.getActor(client.actorId);
    if (body === undefined) throw new Error('no body');
    const { lurk } = farPair(world, [body], DEFAULT_SIGHT_RADIUS + 4);
    const reeve = world.addMonster('reeve', {
      name: 'The reeve',
      sprite: 'npc_townsfolk_reeve',
      x: lurk.x,
      y: lurk.y,
      profile: AiProfile.MeleeChaser,
      aggroRange: 0,
      faction: Faction.Townsfolk,
    });

    client.send({ t: 'hold' });
    await sleep(250);
    expect(client.board(), 'a townsperson out of sight is on your board').not.toContain(reeve.id);

    reeve.x = body.x + 1;
    reeve.y = body.y;
    client.send({ t: 'hold' });
    await sleep(250);
    expect(client.board(), 'a townsperson standing beside you never arrived').toContain(reeve.id);

    reeve.x = lurk.x;
    reeve.y = lurk.y;
    client.send({ t: 'hold' });
    await sleep(250);
    expect(client.board(), 'a townsperson who walked off stayed on your board').not.toContain(
      reeve.id,
    );
  });

  it('marks a friendly face on the minimap within the reveal radius, and never a hostile', async () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE ONE EXCEPTION TO THE FOG RULE, AND IT IS OURS — see `BeaconView`.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * BOTH BODIES STAND ON THE SAME TILE'S DISTANCE and neither is in sight, so
     * the only thing separating them in this assertion is the rule: a friendly
     * face is marked, a hostile never is, at any distance.
     */
    const client = await hello(server.port);
    const world = server.realms.overworld.world;
    const body = world.getActor(client.actorId);
    if (body === undefined) throw new Error('no body');

    const near = ringTile(world, body, DEFAULT_SIGHT_RADIUS + 4);
    const alsoNear = ringTile(world, body, DEFAULT_SIGHT_RADIUS + 5, [near]);
    // ═══ A BOUNDARY PAIR, ONE TILE APART ACROSS THE RADIUS ═══
    // `ringTile` lands AT OR JUST UNDER the distance asked for, so `edge` is
    // inside the radius and `beyond` is the first step outside it. A "far away"
    // body would pass whatever the comparison was; these two do not.
    const edge = ringTile(world, body, MINIMAP_REVEAL_RADIUS, [near, alsoNear]);
    const beyond = ringTile(world, body, MINIMAP_REVEAL_RADIUS + 1, [near, alsoNear, edge]);
    // THE FIXTURE MUST BE ABLE TO FAIL: a mark inside sight would prove nothing,
    // and a "far" body inside the radius would prove the opposite of the rule.
    for (const tile of [near, alsoNear, edge, beyond]) {
      expect(canSee(world.level, body, tile), 'the fixture put a beacon inside sight').toBe(false);
    }
    expect(sightDistance(body, edge), 'the edge tile is outside the radius').toBeLessThanOrEqual(
      MINIMAP_REVEAL_RADIUS,
    );
    expect(sightDistance(body, beyond), 'the far tile is inside the radius').toBeGreaterThan(
      MINIMAP_REVEAL_RADIUS,
    );

    const townsfolk = (id: string, at: { x: number; y: number }): void => {
      world.addMonster(id, {
        name: 'A neighbour',
        sprite: 'npc_townsfolk_reeve',
        x: at.x,
        y: at.y,
        profile: AiProfile.MeleeChaser,
        aggroRange: 0,
        faction: Faction.Townsfolk,
      });
    };
    townsfolk('near-friend', near);
    townsfolk('edge-friend', edge);
    townsfolk('far-friend', beyond);
    world.addMonster('lurker', {
      name: 'Index Husk',
      sprite: 'enemy_index_husk_s',
      x: alsoNear.x,
      y: alsoNear.y,
      profile: AiProfile.MeleeChaser,
      aggroRange: 0,
    });

    client.send({ t: 'hold' });
    await sleep(250);
    const marks = client.beacons();
    expect(
      marks.get(`${String(near.x)},${String(near.y)}`),
      'a friendly face inside the reveal radius is not on the minimap',
    ).toBe('friendly');
    expect(
      marks.has(`${String(alsoNear.x)},${String(alsoNear.y)}`),
      'a HOSTILE you cannot see is on the minimap — the exception buys navigation, ' +
        'never intelligence',
    ).toBe(false);
    expect(
      marks.get(`${String(edge.x)},${String(edge.y)}`),
      'a friendly face AT the reveal radius is not on the minimap — the comparison is `<=`',
    ).toBe('friendly');
    expect(
      marks.has(`${String(beyond.x)},${String(beyond.y)}`),
      'a friendly face one tile PAST the reveal radius is on the minimap',
    ).toBe(false);
    // AND THE MARK CARRIES NOTHING ELSE: no id, no name, no sprite.
    const rows = [...client.frames].reverse().find((f) => Array.isArray(f['beacons']))?.['beacons'];
    for (const row of (rows ?? []) as Record<string, unknown>[]) {
      expect(Object.keys(row).sort(), 'a beacon carries more than a position and a kind').toEqual([
        'kind',
        'x',
        'y',
      ]);
    }
  });

  it('marks the way in and the way on, near it or once you have seen it', async () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE TWO GATES ARE DIFFERENT, AND THIS IS THE CASE THAT SAYS WHY.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * A friendly face is a fact about NOW, so it is marked on proximity alone. A
     * stair is TERRAIN, and `engine/Grid.lua:30-32` remembers terrain — so a
     * stair you have personally stood on stays marked from the far end of the
     * floor, and one you have never seen is marked only when you are near it.
     *
     * DRIVEN THROUGH A REAL CROSSING, because the overworld has no stair at all:
     * a fixture that never entered a delve could not have asked this question.
     */
    const client = await hello(server.port);
    const overworld = server.realms.overworld;
    const door = [...overworld.sites].find(([, siteId]) => SITES.get(siteId)?.kind === 'inner');
    if (door === undefined) throw new Error('the overworld has no room to walk into');
    const [dxs, dys] = door[0].split(',');
    const outside = overworld.world.getActor(client.actorId);
    if (outside === undefined) throw new Error('no body');
    outside.x = Number(dxs) - 1;
    outside.y = Number(dys);
    client.send({ t: 'move', dir: 'e' });
    await sleep(450);

    const realm = server.realms.realmOf(client.actorId);
    expect(realm?.siteId, 'the delver never crossed').toBe(door[1]);
    if (realm === undefined) return;
    const body = realm.world.getActor(client.actorId);
    const spawn = realm.spawns[0];
    const stair = stairsDownOf(realm);
    if (body === undefined || spawn === undefined) throw new Error('no body in the room');
    expect(stair, 'this floor has no stair down — the case cannot ask its question').not.toBeNull();
    if (stair === null) return;

    // ═══ THE WAY BACK, from the tile you are standing on ═══
    expect(
      client.beacons().get(`${String(spawn.x)},${String(spawn.y)}`),
      'the way back out is not marked on the tile you arrived on',
    ).toBe('entrance');

    // ═══ THE STAIR, FAR OFF AND NEVER SEEN ═══
    const hide = ringTile(realm.world, stair, MINIMAP_REVEAL_RADIUS + 1, [spawn]);
    body.x = hide.x;
    body.y = hide.y;
    client.send({ t: 'hold' });
    await sleep(250);
    const stairCell = `${String(stair.x)},${String(stair.y)}`;
    expect(
      client.beacons().has(stairCell),
      'a stair you have never seen, past the reveal radius, is on your minimap',
    ).toBe(false);

    // ═══ WALK WITHIN THE RADIUS OF IT, STILL WITHOUT SEEING IT ═══
    const close = ringTile(realm.world, stair, MINIMAP_REVEAL_RADIUS, [spawn, hide]);
    body.x = close.x;
    body.y = close.y;
    client.send({ t: 'hold' });
    await sleep(250);
    expect(
      client.beacons().get(stairCell),
      'a stair inside the reveal radius is not on your minimap',
    ).toBe('exit');

    // ═══ AND ONCE YOU HAVE STOOD ON IT, IT STAYS MARKED FROM ANYWHERE ═══
    body.x = stair.x;
    body.y = stair.y;
    client.send({ t: 'hold' });
    await sleep(250);
    body.x = hide.x;
    body.y = hide.y;
    client.send({ t: 'hold' });
    await sleep(250);
    expect(
      client.beacons().get(stairCell),
      'a stair you have personally walked onto came off the minimap when you left — ' +
        'that is terrain, and terrain is remembered',
    ).toBe('exit');
  });

  it('keeps a STRANGER off your board too, while your own party is never fogged', async () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * "TEAMMATES ARE NEVER FOGGED" MEANT "EVERY PLAYER IS", AND THEY ARE NOT.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `visibleActorIds` exempted `ActorKind.Player` outright. A Common realm is
     * *"shared by every party in it"* (`world/realms.ts`), so in Alderbrook a
     * stranger's body was on your board through the walls — the other half of
     * *"i can see assets, people and props through walls"*. Upstream cannot
     * decide this one: ToME has one party and no strangers. The rule is the
     * author's: not in YOUR party means you see them when you can see them.
     *
     * ONE FIXTURE, TWO SIDES, so the assertion is the party and not the
     * distance: both bodies stand on the same far tile pair, and the only thing
     * that changes between the halves is that they join up.
     */
    const mine = await hello(server.port);
    const theirs = await hello(server.port);
    const world = server.realms.overworld.world;
    const me = world.getActor(mine.actorId);
    const scout = world.getActor(theirs.actorId);
    if (me === undefined || scout === undefined) throw new Error('no body');
    const { body } = farPair(world, [me], REVEAL_RADIUS + 2);
    scout.x = body.x;
    scout.y = body.y;

    mine.send({ t: 'hold' });
    await sleep(250);
    expect(
      mine.board(),
      'a STRANGER twenty tiles away and behind everything is on your board',
    ).not.toContain(theirs.actorId);

    // ═══ AND THE SAME TWO BODIES, ONCE THEY ARE PLAYING TOGETHER ═══
    mine.send({ t: 'party', action: 'invite', targetId: theirs.actorId });
    await sleep(150);
    theirs.send({ t: 'party', action: 'accept', targetId: mine.actorId });
    await sleep(200);
    mine.send({ t: 'hold' });
    await sleep(250);
    expect(
      mine.board(),
      'your own party member fell off your board — the co-op half of this rule is the ' +
        'half the game cannot do without',
    ).toContain(theirs.actorId);
  });

  it('does not put a monster on your board that only your teammate can see', async () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * EACH PLAYER SEES WITH THEIR OWN EYES. This file used to assert the union.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * Upstream computes sight for the character being played and no one else
     * (`Game.lua:1755` calls `self.player:playerFOV()`). The board was built
     * from every player in the realm instead, so a monster a teammate had found
     * across the map was on everybody's screen.
     */
    const mine = await hello(server.port);
    const theirs = await hello(server.port);
    const world = server.realms.overworld.world;
    const me = world.getActor(mine.actorId);
    const scout = world.getActor(theirs.actorId);
    if (me === undefined || scout === undefined) throw new Error('no body');
    const { body, lurk } = farPair(world, [me], REVEAL_RADIUS + 2);
    scout.x = body.x;
    scout.y = body.y;
    const lurker = world.addMonster('lurker', {
      name: 'Index Husk',
      sprite: 'enemy_index_husk_s',
      x: lurk.x,
      y: lurk.y,
      profile: AiProfile.MeleeChaser,
      aggroRange: 0,
    });

    theirs.send({ t: 'hold' });
    await sleep(250);
    mine.send({ t: 'hold' });
    await sleep(250);

    expect(theirs.board(), 'the scout standing beside it was not shown it').toContain(lurker.id);
    expect(mine.board(), 'a monster only your teammate can see is on your board').not.toContain(
      lurker.id,
    );
  });

  it('does not put a pile on your floor that only your teammate can see', async () => {
    const mine = await hello(server.port);
    const theirs = await hello(server.port);
    const world = server.realms.overworld.world;
    const me = world.getActor(mine.actorId);
    const scout = world.getActor(theirs.actorId);
    if (me === undefined || scout === undefined) throw new Error('no body');
    const { body, lurk } = farPair(world, [me], REVEAL_RADIUS + 2);
    scout.x = body.x;
    scout.y = body.y;
    world.addGroundItem(lurk, 'item_watchmans_cap');
    const cell = `${String(lurk.x)},${String(lurk.y)}`;

    theirs.send({ t: 'hold' });
    await sleep(250);
    mine.send({ t: 'hold' });
    await sleep(250);

    expect(theirs.ground(), 'the scout standing beside it was not shown it').toContain(cell);
    expect(mine.ground(), 'a pile only your teammate can see is on your floor').not.toContain(cell);
  });

  it('hands a player who joins a board built from their own body alone', async () => {
    const theirs = await hello(server.port);
    const overworld = server.realms.overworld;
    const world = overworld.world;
    const scout = world.getActor(theirs.actorId);
    if (scout === undefined) throw new Error('no body');
    // FAR FROM EVERY SPAWN, because the joiner will stand on or beside one.
    const { body, lurk } = farPair(world, [...overworld.spawns, scout], DEFAULT_SIGHT_RADIUS + 4);
    scout.x = body.x;
    scout.y = body.y;
    const lurker = world.addMonster('lurker', {
      name: 'Index Husk',
      sprite: 'enemy_index_husk_s',
      x: lurk.x,
      y: lurk.y,
      profile: AiProfile.MeleeChaser,
      aggroRange: 0,
    });
    theirs.send({ t: 'hold' });
    await sleep(250);
    expect(theirs.board(), 'the scout standing beside it was not shown it').toContain(lurker.id);

    const mine = await hello(server.port);
    const rows = mine.frames.find((f) => f['t'] === 'welcome')?.['actors'];
    const welcomed = Array.isArray(rows) ? (rows as { id?: unknown }[]).map((row) => row.id) : [];
    expect(welcomed.length, 'the welcome carried no board at all').toBeGreaterThan(0);
    expect(welcomed, 'the welcome board').not.toContain(lurker.id);
    await sleep(150);
    // AND THE REALM FRAME'S OWN LIST, not only the board it leaves: the next
    // sight pass would send `left` for a monster this frame should never have
    // carried, and the board would look right while the frame was wrong.
    const realmRows = mine.frames.find((f) => f['t'] === 'realm')?.['actors'];
    const arrived = Array.isArray(realmRows)
      ? (realmRows as { id?: unknown }[]).map((row) => row.id)
      : [];
    expect(arrived.length, 'the realm frame carried no board at all').toBeGreaterThan(0);
    expect(arrived, 'the realm board').not.toContain(lurker.id);
    expect(mine.board(), 'the board after the realm frame').not.toContain(lurker.id);
  });

  it('does not tell you about a blow on a monster only your teammate can see', async () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE PLAYER LANE, PER VIEWER. A board that hides the monster is not enough.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `moved`, `attacked`, `damaged`, `died`, `used` and `erased` went to the
     * whole realm, so a monster your teammate was fighting across the map was
     * off your board and still in your frames. Each copy now goes through
     * `fogEvent` against the recipient's own ledger, as the sweep lane did.
     */
    const mine = await hello(server.port);
    const theirs = await hello(server.port);
    const overworld = server.realms.overworld;
    const world = overworld.world;
    const me = world.getActor(mine.actorId);
    const scout = world.getActor(theirs.actorId);
    if (me === undefined || scout === undefined) throw new Error('no body');
    const doors = new Set(overworld.sites.keys());
    const { body, lurk } = farPair(world, [me], REVEAL_RADIUS + 2, doors);
    scout.x = body.x;
    scout.y = body.y;
    const lurker = world.addMonster('lurker', {
      name: 'Index Husk',
      sprite: 'enemy_index_husk_s',
      x: lurk.x,
      y: lurk.y,
      profile: AiProfile.MeleeChaser,
      aggroRange: 0,
    });
    // A MELEE CLASS, because a body that has not chosen one strikes at range and
    // a step into an adjacent hostile is refused as too close.
    theirs.send({ t: 'choose_class', classId: WATCHMAN.id });
    await sleep(200);
    theirs.send({ t: 'hold' });
    await sleep(250);
    expect(theirs.board(), 'the scout standing beside it was not shown it').toContain(lurker.id);

    // THE BLOW: a step into a hostile is an attack.
    theirs.send({ t: 'move', dir: 'e' });
    await sleep(150);
    mine.send({ t: 'hold' });
    await sleep(150);
    const names = (frame: Record<string, unknown>): boolean => {
      const ev = frame['ev'];
      if (typeof ev !== 'object' || ev === null) return false;
      const fields = ev as Record<string, unknown>;
      return fields['id'] === lurker.id || fields['targetId'] === lurker.id;
    };
    const lane = new Set(['attacked', 'damaged', 'died']);
    const aboutIt = (frame: Record<string, unknown>): boolean =>
      lane.has(String(frame['t'])) && names(frame);
    const deadline = Date.now() + FRAME_TIMEOUT_MS;
    while (!theirs.frames.some(aboutIt) && Date.now() < deadline) {
      await sleep(10);
    }
    expect(theirs.frames.some(aboutIt), 'the scout never heard their own blow').toBe(true);
    await sleep(150);
    expect(mine.frames.filter(aboutIt), 'a blow on a monster you cannot see reached you').toEqual(
      [],
    );
  });

  it('always tells you where a teammate stepped, however far away', async () => {
    // PLAYERS ARE ALWAYS HELD, so a teammate's step is never fogged. The lane
    // being per viewer must not cost the party each other's positions.
    const mine = await hello(server.port);
    const theirs = await hello(server.port);
    const overworld = server.realms.overworld;
    const world = overworld.world;
    const me = world.getActor(mine.actorId);
    const scout = world.getActor(theirs.actorId);
    if (me === undefined || scout === undefined) throw new Error('no body');
    const doors = new Set(overworld.sites.keys());
    const { body, lurk } = farPair(world, [me], REVEAL_RADIUS + 2, doors);
    scout.x = body.x;
    scout.y = body.y;
    const stepped = (frame: Record<string, unknown>): boolean =>
      frame['t'] === 'moved' &&
      frame['id'] === theirs.actorId &&
      frame['x'] === lurk.x &&
      frame['y'] === lurk.y;

    theirs.send({ t: 'move', dir: 'e' });
    await sleep(80);
    const deadline = Date.now() + FRAME_TIMEOUT_MS;
    while (!mine.frames.some(stepped) && Date.now() < deadline) {
      await sleep(10);
    }
    expect(mine.frames.some(stepped), 'a teammate`s step far away never reached you').toBe(true);
  });

  it('does not show you a badge on a monster only your teammate can see', async () => {
    /**
     * A BADGE IS A FACT ABOUT A BODY (`engine/Actor.lua:30-34`). The `effects`
     * frame was built from every player's eyes and sent to the room, so a stun on
     * a monster only your teammate could see named that monster on your client.
     */
    const mine = await hello(server.port);
    const theirs = await hello(server.port);
    const overworld = server.realms.overworld;
    const world = overworld.world;
    const me = world.getActor(mine.actorId);
    const scout = world.getActor(theirs.actorId);
    if (me === undefined || scout === undefined) throw new Error('no body');
    const doors = new Set(overworld.sites.keys());
    const { body, lurk } = farPair(world, [me], REVEAL_RADIUS + 2, doors);
    scout.x = body.x;
    scout.y = body.y;
    const lurker = world.addMonster('lurker', {
      name: 'Index Husk',
      sprite: 'enemy_index_husk_s',
      x: lurk.x,
      y: lurk.y,
      profile: AiProfile.MeleeChaser,
      aggroRange: 0,
    });
    setEffect(effects, lurker, STUNNED.id, 50, {}, createRng('fov-badge'));

    theirs.send({ t: 'hold' });
    await sleep(250);
    mine.send({ t: 'hold' });
    await sleep(250);

    const badged = (client: Client): boolean => {
      const last = [...client.frames].reverse().find((f) => f['t'] === 'effects');
      const rows = last?.['actors'];
      return (
        Array.isArray(rows) && (rows as { id?: unknown }[]).some((row) => row.id === lurker.id)
      );
    };
    expect(badged(theirs), 'the scout standing beside it was not shown its badge').toBe(true);
    expect(badged(mine), 'a badge on a monster only your teammate can see reached you').toBe(false);
  });

  it('does not show you fire only your teammate can see', async () => {
    const mine = await hello(server.port);
    const theirs = await hello(server.port);
    const overworld = server.realms.overworld;
    const world = overworld.world;
    const me = world.getActor(mine.actorId);
    const scout = world.getActor(theirs.actorId);
    if (me === undefined || scout === undefined) throw new Error('no body');
    const doors = new Set(overworld.sites.keys());
    const { body, lurk } = farPair(world, [me], REVEAL_RADIUS + 2, doors);
    scout.x = body.x;
    scout.y = body.y;
    world.addZone({
      srcId: theirs.actorId,
      tiles: [lurk],
      type: DamageType.Physical,
      damage: 1,
      turns: 50,
      selfFire: false,
      friendlyFire: false,
    });

    theirs.send({ t: 'hold' });
    await sleep(250);
    mine.send({ t: 'hold' });
    await sleep(250);

    const burning = (client: Client): boolean => {
      const last = [...client.frames].reverse().find((f) => f['t'] === 'zones');
      const rows = last?.['tiles'];
      return (
        Array.isArray(rows) &&
        (rows as { x?: unknown; y?: unknown }[]).some((row) => row.x === lurk.x && row.y === lurk.y)
      );
    };
    expect(burning(theirs), 'the scout standing beside it was not shown the fire').toBe(true);
    expect(burning(mine), 'fire only your teammate can see reached you').toBe(false);
  });

  it('shows you only the roamers you can see, and shows one when you walk into sight of it', async () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * DANGER ON THE MOOR IS SIGHT-GATED LIKE EVERYTHING ELSE.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * Every roamer on the map was a marker on every player's map. Now a viewer
     * gets one only when they can see it — and gets it the moment they can,
     * which for a player walking toward a still roamer is a PLAYER's step, not
     * a roamer's, so it has to be re-sent after the pump rather than only when
     * the roamers move.
     */
    const mine = await hello(server.port);
    const overworld = server.realms.overworld;
    const world = overworld.world;
    const me = world.getActor(mine.actorId);
    if (me === undefined) throw new Error('no body');
    const doors = new Set(overworld.sites.keys());
    const { body, lurk } = farPair(world, [me], REVEAL_RADIUS + 2, doors);
    const place = (id: string, name: string, at: { x: number; y: number }): void => {
      overworld.roamers.set(id, {
        id,
        x: at.x,
        y: at.y,
        name,
        templateId: 'monster:index_husk',
        sprite: 'enemy_index_husk_s',
        homeX: at.x,
        homeY: at.y,
        unseen: 0,
        goingHome: false,
      });
    };
    place('roamer:far', 'a far breach', lurk);

    const named = (name: string): boolean => {
      const last = [...mine.frames].reverse().find((f) => f['t'] === 'sites' || f['t'] === 'realm');
      const rows = last?.['sites'];
      return Array.isArray(rows) && (rows as { name?: unknown }[]).some((row) => row.name === name);
    };

    mine.send({ t: 'hold' });
    await sleep(250);
    expect(named('a far breach'), 'a roamer far out of sight is on your map').toBe(false);

    // WALK INTO SIGHT OF IT — placed rather than walked, as the other tests here
    // do, and pumped by a command that moves no roamer.
    me.x = body.x;
    me.y = body.y;
    mine.send({ t: 'hold' });
    await sleep(250);
    expect(named('a far breach'), 'a roamer you are standing beside never reached your map').toBe(
      true,
    );
  });

  it('writes a teammate`s blow on a monster you cannot see as a blow on something', async () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE CASE LOG IS A TRANSCRIPT OF WHAT YOU SAW, AS UPSTREAM'S IS.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `Game.lua`'s `logVisible` writes a line when either side is visible and
     * `logMessage` calls an unseen side "something". The Record lane was one
     * batch for the realm, so the monster a teammate was fighting out of your
     * sight was named, hit and killed in your log.
     */
    const mine = await hello(server.port);
    const theirs = await hello(server.port);
    /**
     * ═══ AND THEY ARE ACTUALLY IN ONE PARTY NOW, WHICH THEY NEVER WERE ═══
     * This case is named for a TEAMMATE and paired two STRANGERS. It passed
     * because `visibleActorIds` exempted every `ActorKind.Player` from fog,
     * whoever they were playing with — on a Common realm *"shared by every party
     * in it"* that put strangers on your board through the walls of Alderbrook,
     * which is half of what the author reported. The exemption is the PARTY now,
     * so this fixture has to make the claim its own title makes. Without these
     * four lines the scout is a stranger twenty-two tiles off, no line in that
     * pump names a body this viewer holds, and the Record lane correctly says
     * nothing at all — which is the case pinned directly below.
     */
    mine.send({ t: 'party', action: 'invite', targetId: theirs.actorId });
    await sleep(150);
    theirs.send({ t: 'party', action: 'accept', targetId: mine.actorId });
    await sleep(200);
    const overworld = server.realms.overworld;
    const world = overworld.world;
    const me = world.getActor(mine.actorId);
    const scout = world.getActor(theirs.actorId);
    if (me === undefined || scout === undefined) throw new Error('no body');
    const doors = new Set(overworld.sites.keys());
    const { body, lurk } = farPair(world, [me], REVEAL_RADIUS + 2, doors);
    scout.x = body.x;
    scout.y = body.y;
    world.addMonster('lurker', {
      name: 'Index Husk',
      sprite: 'enemy_index_husk_s',
      x: lurk.x,
      y: lurk.y,
      profile: AiProfile.MeleeChaser,
      aggroRange: 0,
    });
    theirs.send({ t: 'choose_class', classId: WATCHMAN.id });
    await sleep(200);
    theirs.send({ t: 'hold' });
    await sleep(250);

    theirs.send({ t: 'move', dir: 'e' });
    await sleep(150);
    mine.send({ t: 'hold' });
    await sleep(150);

    const texts = (client: Client): string[] =>
      client.frames
        .filter((f) => f['t'] === 'log')
        .flatMap((f) => (Array.isArray(f['lines']) ? (f['lines'] as { text?: unknown }[]) : []))
        .map((line) => String(line.text));
    const blow = (target: string): readonly string[] => [
      `${scout.name} hits ${target}.`,
      `${scout.name} misses ${target}.`,
    ];
    const deadline = Date.now() + FRAME_TIMEOUT_MS;
    while (!texts(theirs).some((t) => blow('Index Husk').includes(t)) && Date.now() < deadline) {
      await sleep(10);
    }
    expect(
      texts(theirs).some((t) => blow('Index Husk').includes(t)),
      'the scout never read their own blow',
    ).toBe(true);
    await sleep(150);
    expect(
      texts(mine).filter((t) => t.includes('Index Husk')),
      'a monster you cannot see was named in your log',
    ).toEqual([]);
    expect(
      texts(mine).some((t) => blow('something').includes(t)),
      'your teammate`s blow is missing from your log',
    ).toBe(true);
  });

  it('sends each viewer a window of what the server sees for them, and only when it changes', async () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE SERVER'S SIGHT, ON THE WIRE, BIT FOR BIT.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * Every bit of the window must be `canSee` from the body at its own sight
     * radius; standing still must send nothing more; and a body moved by the
     * world must be sent the window around where it now stands.
     */
    const mine = await hello(server.port);
    const world = server.realms.overworld.world;
    const me = world.getActor(mine.actorId);
    if (me === undefined) throw new Error('no body');
    const visions = (): Record<string, unknown>[] => mine.frames.filter((f) => f['t'] === 'vision');
    const check = (frame: Record<string, unknown>, eye: { x: number; y: number }): string[] => {
      const w = Number(frame['w']);
      const h = Number(frame['h']);
      const x0 = Number(frame['x0']);
      const y0 = Number(frame['y0']);
      const bits = fogFromBase64(String(frame['seen']), fogBytes(w, h));
      const radius = sightRadiusOf(me);
      const wrong: string[] = [];
      for (let y = 0; y < h; y += 1) {
        for (let x = 0; x < w; x += 1) {
          const tile = { x: x0 + x, y: y0 + y };
          if (fogHas(bits, w, x, y) !== canSee(world.level, eye, tile, radius)) {
            wrong.push(`${String(tile.x)},${String(tile.y)}`);
          }
        }
      }
      return wrong;
    };

    mine.send({ t: 'hold' });
    await sleep(250);
    const first = visions().at(-1);
    expect(first, 'no vision frame came at all').toBeDefined();
    if (first === undefined) return;
    expect(check(first, me), 'the window disagrees with the server`s sight').toEqual([]);

    // STANDING STILL: another pump, and nothing new to say.
    const before = visions().length;
    mine.send({ t: 'hold' });
    await sleep(250);
    expect(visions().length, 'a vision frame was sent for a viewer who did not move').toBe(before);

    // MOVED BY THE WORLD, then pumped: the window follows the body.
    const { body } = farPair(
      world,
      [me],
      REVEAL_RADIUS + 2,
      new Set(server.realms.overworld.sites.keys()),
    );
    me.x = body.x;
    me.y = body.y;
    mine.send({ t: 'hold' });
    await sleep(250);
    const moved = visions().at(-1);
    if (moved === undefined) throw new Error('the vision frames vanished');
    expect(visions().length, 'no window for where the body was moved').toBeGreaterThan(before);
    expect(check(moved, me), 'the moved window disagrees with the server`s sight').toEqual([]);
  });

  it('stamps the dressing frame with the realm it describes', async () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * A MUTATION SURVIVOR, AND IT WOULD HAVE DELETED THE WHOLE FEATURE SILENTLY.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `PropsMsg.realmId` is the client's stale-frame guard — `case 'props'` in
     * client/main.ts is `if (msg.realmId === currentRealmId)` and drops the
     * frame otherwise. Change the server's `realmId: realm.id` to anything else
     * and every case in this file still passed: the helper matches on
     * `t === 'props'` and never read the field. The live client would have
     * frozen its prop layer at arrival forever — no furniture appearing, no
     * withdrawal, which is the reported bug WITH the fix in place.
     *
     * TWO REALMS, because one would pass against a frame stamped with any
     * constant string: the assertion is that the stamp FOLLOWS the crossing.
     */
    const client = await hello(server.port);
    const overworld = server.realms.overworld;
    const outside = overworld.world.getActor(client.actorId);
    if (outside === undefined) throw new Error('no body');

    const propsFrames = (): Record<string, unknown>[] =>
      client.frames.filter((f) => f['t'] === 'props');

    // A PROP THE VIEWER CAN SEE, so there is a frame to read at all: the memo
    // is silent when the list has not changed, and an empty loop is a pass
    // that measured nothing.
    const beside = { x: outside.x + 1, y: outside.y };
    if (!canWalk(overworld.world.level, beside.x, beside.y)) {
      throw new Error('no ground beside the body');
    }
    overworld.world.addProp(beside, PropId.OfferingBowl);
    client.send({ t: 'hold' });
    await sleep(250);
    expect(propsFrames().length, 'no dressing frame came on the overworld at all').toBeGreaterThan(
      0,
    );
    for (const frame of propsFrames()) {
      expect(frame['realmId'], 'a dressing frame is stamped with a realm nobody is in').toBe(
        overworld.id,
      );
    }

    // ═══ AND THE STAMP FOLLOWS YOU THROUGH THE DOOR ═══
    const door = [...overworld.sites].find(([, siteId]) => SITES.get(siteId)?.kind === 'inner');
    if (door === undefined) throw new Error('the overworld has no room to walk into');
    const [dxs, dys] = door[0].split(',');
    outside.x = Number(dxs) - 1;
    outside.y = Number(dys);
    client.send({ t: 'move', dir: 'e' });
    await sleep(450);
    const inner = server.realms.realmOf(client.actorId);
    expect(inner?.id, 'the delver never crossed').not.toBe(overworld.id);
    if (inner === undefined) return;
    const arrival = [...client.frames].reverse().find((f) => f['t'] === 'realm');
    expect(arrival?.['realmId'], 'the arrival frame names another realm').toBe(inner.id);
    // FROM THE ARRIVAL FRAME ON, never from the `move` that caused it: the step
    // that walked onto the door resolved on the OVERWORLD and its dressing
    // frame is correctly stamped with the map the body was still standing on.
    const crossed = client.frames.indexOf(arrival as Record<string, unknown>);

    const body = inner.world.getActor(client.actorId);
    if (body === undefined) throw new Error('no body inside');
    const near = { x: body.x + 1, y: body.y };
    if (!canWalk(inner.world.level, near.x, near.y)) throw new Error('no ground beside the body');
    inner.world.addProp(near, PropId.OfferingBowl);
    client.send({ t: 'hold' });
    await sleep(250);
    const after = client.frames.slice(crossed).filter((frame) => frame['t'] === 'props');
    expect(after.length, 'no dressing frame came after the crossing at all').toBeGreaterThan(0);
    for (const frame of after) {
      expect(
        frame['realmId'],
        'a dressing frame is stamped with the realm you have left — the client drops it, ' +
          'and the prop layer freezes where you arrived',
      ).toBe(inner.id);
    }
  });

  it('never marks a stranger as a friendly face, partied or not', async () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * `isMonster` IS THE TERM THAT KEEPS PLAYERS OUT OF THE BEACON LIST.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * Dropping it left every case in this file green, and it re-opens through
     * the minimap exactly what `visibleActorIds` was changed to shut: a stranger
     * twenty tiles away behind a wall would get a mark on your map, because
     * nothing in the world is hostile to them either. And a TEAMMATE would get a
     * second, differently-shaped dot on top of `partyMarks` — the "one dot, two
     * answers" the builder's own docblock refuses.
     *
     * BOTH HALVES, before and after joining up, because the two refusals have
     * different reasons and one term covers both.
     */
    const mine = await hello(server.port);
    const theirs = await hello(server.port);
    const world = server.realms.overworld.world;
    const me = world.getActor(mine.actorId);
    const other = world.getActor(theirs.actorId);
    if (me === undefined || other === undefined) throw new Error('no body');

    // WELL INSIDE THE REVEAL RADIUS AND WELL OUTSIDE SIGHT, so the only thing
    // that can be keeping them off the map is the rule.
    const stand = ringTile(world, me, DEFAULT_SIGHT_RADIUS + 4);
    other.x = stand.x;
    other.y = stand.y;
    expect(canSee(world.level, me, stand), 'the fixture put the stranger in sight').toBe(false);
    expect(sightDistance(me, stand)).toBeLessThanOrEqual(MINIMAP_REVEAL_RADIUS);
    const cell = `${String(stand.x)},${String(stand.y)}`;

    mine.send({ t: 'hold' });
    await sleep(250);
    expect(
      mine.beacons().has(cell),
      'a STRANGER inside the reveal radius is marked on your minimap as a friendly face',
    ).toBe(false);

    mine.send({ t: 'party', action: 'invite', targetId: theirs.actorId });
    await sleep(150);
    theirs.send({ t: 'party', action: 'accept', targetId: mine.actorId });
    await sleep(200);
    other.x = stand.x;
    other.y = stand.y;
    mine.send({ t: 'hold' });
    await sleep(250);
    expect(
      mine.beacons().has(cell),
      'a TEAMMATE is beaconed as well as marked by `partyMarks` — one dot, two answers',
    ).toBe(false);
  });

  it('takes a friendly face off the minimap when they are killed', async () => {
    // `a.alive` in the beacon filter, which nothing asserted: a townsperson you
    // have killed stayed marked as somebody to walk up to.
    const client = await hello(server.port);
    const world = server.realms.overworld.world;
    const body = world.getActor(client.actorId);
    if (body === undefined) throw new Error('no body');
    const stand = ringTile(world, body, DEFAULT_SIGHT_RADIUS + 4);
    const neighbour = world.addMonster('doomed-friend', {
      name: 'A neighbour',
      sprite: 'npc_townsfolk_reeve',
      x: stand.x,
      y: stand.y,
      profile: AiProfile.MeleeChaser,
      aggroRange: 0,
      faction: Faction.Townsfolk,
    });
    const cell = `${String(stand.x)},${String(stand.y)}`;

    client.send({ t: 'hold' });
    await sleep(250);
    expect(client.beacons().get(cell), 'the fixture never marked the living neighbour').toBe(
      'friendly',
    );

    neighbour.hp = 0;
    neighbour.alive = false;
    client.send({ t: 'hold' });
    await sleep(250);
    expect(
      client.beacons().has(cell),
      'a friendly face you have killed is still marked on the minimap',
    ).toBe(false);
  });

  it('marks a three-tile gate once, not once per tile of it', async () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * ONE DOOR IS ONE MARK — see `oneMarkPerBlock`.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * MEASURED ON THE RENDERED MINIMAP: four of the five towns ship a spawn
     * block of three tiles or more, so the entrance arm emitted a beacon per
     * tile. At `cell = 3` each glyph's outline overpaints its neighbour's fill,
     * and the composite measured 36 orange pixels in a 10x7 smear — the
     * hollow-vs-solid channel that tells an entrance from an exit is the first
     * thing to go, which is the one thing the player asked to be able to read.
     */
    const client = await hello(server.port);
    const overworld = server.realms.overworld;
    const door = [...overworld.sites].find(([, siteId]) => SITES.get(siteId)?.kind === 'inner');
    if (door === undefined) throw new Error('the overworld has no room to walk into');
    const [dxs, dys] = door[0].split(',');
    const outside = overworld.world.getActor(client.actorId);
    if (outside === undefined) throw new Error('no body');
    outside.x = Number(dxs) - 1;
    outside.y = Number(dys);
    client.send({ t: 'move', dir: 'e' });
    await sleep(450);

    const realm = server.realms.realmOf(client.actorId);
    if (realm === undefined) throw new Error('never crossed');
    const spawn = realm.spawns[0];
    if (spawn === undefined) throw new Error('the floor has no arrival');

    // A THREE-TILE THRESHOLD, built here rather than hunted for: the delve
    // mapgen gives one spawn today (`mapgen/level.ts`), so the shape this rule
    // exists for has to be made before it can be measured.
    const block = [
      { x: spawn.x, y: spawn.y },
      { x: spawn.x + 1, y: spawn.y },
      { x: spawn.x + 2, y: spawn.y },
    ];
    expect(
      block.every((t) => canWalk(realm.world.level, t.x, t.y)),
      'the fixture could not lay a three-tile threshold on open ground',
    ).toBe(true);
    (realm.spawns as { x: number; y: number }[]).splice(0, realm.spawns.length, ...block);
    const body = realm.world.getActor(client.actorId);
    if (body === undefined) throw new Error('no body inside');
    body.x = block[0]?.x ?? spawn.x;
    body.y = block[0]?.y ?? spawn.y;

    client.send({ t: 'hold' });
    await sleep(250);
    const marks = [...client.beacons()].filter(([, kind]) => kind === 'entrance');
    expect(
      marks.length,
      'a three-tile gate is drawn as three marks — at minimap scale that is a smear, ' +
        'not a door',
    ).toBe(1);
    expect(
      block.some((t) => `${String(t.x)},${String(t.y)}` === marks[0]?.[0]),
      'the one mark does not stand on the gate it represents',
    ).toBe(true);

    // AND A SECOND, SEPARATE GATE IS STILL ITS OWN MARK. Contiguity is the
    // whole rule; collapsing to "one entrance per map" would hide a way home.
    const far = ringTile(realm.world, body, MINIMAP_REVEAL_RADIUS - 2, block);
    (realm.spawns as { x: number; y: number }[]).push(far);
    client.send({ t: 'hold' });
    await sleep(250);
    expect(
      [...client.beacons()].filter(([, kind]) => kind === 'entrance').length,
      'a second gate on the far side of the room was folded into the first',
    ).toBe(2);

    /**
     * ═══ AND THE BOARD AND THE MINIMAP ANSWER DIFFERENTLY ABOUT THAT GATE ═══
     * This is the one place the two gates are visibly different rules and it is
     * the whole shape of the feature: the minimap marks a way out you are NEAR
     * (`MINIMAP_REVEAL_RADIUS`, ours, deliberate), and the board draws only what
     * you have actually seen (`knownTile`, terrain's own rule). The far gate is
     * eighteen tiles off and behind everything, so it is on the one and not the
     * other. Today's maps put you on your only threshold, so without a second,
     * remote gate this rule has nothing to be measured against.
     */
    const farCell = `${String(far.x)},${String(far.y)}`;
    expect(client.beacons().get(farCell), 'the far gate is not marked on the minimap').toBe(
      'entrance',
    );
    const drawn = [...client.frames]
      .reverse()
      .find((f) => f['t'] === 'sites' || f['t'] === 'realm')?.['sites'];
    expect(
      ((drawn ?? []) as { x?: unknown; y?: unknown }[]).map(
        (row) => `${String(row.x)},${String(row.y)}`,
      ),
      'a gate you have never seen is drawn on your board through the walls',
    ).not.toContain(farCell);
  });

  it('keeps the stair off the BOARD until you have seen it, and keeps it once you have', async () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE HALF OF THE REPORT THAT WAS LEFT OPEN — see `markersFor`.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * Props and bodies were fogged and the MARKER layer was not: `paintSites`
     * runs after `paintLight`, so a stair was painted at full brightness on the
     * alpha-1 black of never-seen rock. Measured in The Underworks: standing at
     * 32,19, the stair at 32,14 was drawn through five tiles of stone on a tile
     * whose own `vision` frame said `seen=0 remembered=0`.
     *
     * AND THE SECOND HALF IS NOT OPTIONAL. A way on is terrain
     * (`engine/Grid.lua:30-32`) and upstream's stair grids are
     * `always_remember`, so once seen it must STAY — a marker that blinks off as
     * you walk away is worse than one drawn through rock. Ours stand on ordinary
     * floor, which in an unlit cave is not remembered at all, so `waysSeen`
     * carries the fact instead.
     */
    const client = await hello(server.port);
    const overworld = server.realms.overworld;
    const door = [...overworld.sites].find(([, siteId]) => SITES.get(siteId)?.kind === 'inner');
    if (door === undefined) throw new Error('the overworld has no room to walk into');
    const [dxs, dys] = door[0].split(',');
    const outside = overworld.world.getActor(client.actorId);
    if (outside === undefined) throw new Error('no body');
    outside.x = Number(dxs) - 1;
    outside.y = Number(dys);
    client.send({ t: 'move', dir: 'e' });
    await sleep(450);

    const realm = server.realms.realmOf(client.actorId);
    if (realm === undefined) throw new Error('never crossed');
    const stair = stairsDownOf(realm);
    const spawn = realm.spawns[0];
    if (stair === null || spawn === undefined) throw new Error('no stair on this floor');
    const body = realm.world.getActor(client.actorId);
    if (body === undefined) throw new Error('no body inside');

    /**
     * ═══ AND THE ROOM IS DARK, WHICH IS WHAT MAKES THE SECOND HALF A TEST ═══
     * A lit floor is remembered by the ORDINARY terrain memory
     * (`computeVision`: `kept` is `litAt || alwaysRemembered`), so on a works or
     * a ruin the "walk away" half below passes whether or not `waysSeen` exists
     * — measured, the mutant survived. An unlit cave is where a stair standing
     * on `FLOOR` or `SOOT` is remembered by nothing at all, and it is the room a
     * new character wakes in.
     */
    realm.world.lit.fill(0);

    const sites = (): Map<string, string> => {
      const last = [...client.frames]
        .reverse()
        .find((f) => f['t'] === 'sites' || f['t'] === 'realm');
      const rows = last?.['sites'];
      const out = new Map<string, string>();
      if (!Array.isArray(rows)) return out;
      for (const row of rows as { x?: unknown; y?: unknown; marker?: unknown }[]) {
        out.set(`${String(row.x)},${String(row.y)}`, String(row.marker));
      }
      return out;
    };
    const stairCell = `${String(stair.x)},${String(stair.y)}`;

    // ═══ FAR OFF AND NEVER SEEN: NOT ON THE BOARD ═══
    const hide = ringTile(realm.world, stair, MINIMAP_REVEAL_RADIUS + 1, [spawn]);
    body.x = hide.x;
    body.y = hide.y;
    client.send({ t: 'hold' });
    await sleep(250);
    expect(
      sites().has(stairCell),
      'a stair you have never seen is drawn on your board through the rock',
    ).toBe(false);
    // AND THE MINIMAP AGREES AT THIS DISTANCE — the two surfaces contradicting
    // each other about one tile is what made this a bug rather than a choice.
    expect(client.beacons().has(stairCell), 'the minimap marked what the board hid').toBe(false);

    // ═══ STAND ON IT: ON THE BOARD ═══
    body.x = stair.x;
    body.y = stair.y;
    client.send({ t: 'hold' });
    await sleep(250);
    expect(sites().get(stairCell), 'the stair under your own feet is not on your board').toBe(
      'stair',
    );

    // ═══ WALK AWAY AGAIN: STILL ON THE BOARD ═══
    body.x = hide.x;
    body.y = hide.y;
    client.send({ t: 'hold' });
    await sleep(250);
    expect(
      sites().get(stairCell),
      'a stair you have stood on came off your board when you left it — that is terrain, ' +
        'and upstream`s stair grids are always_remember',
    ).toBe('stair');
  });

  it('does not announce a stranger who arrives behind your walls', async () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * `joined` CARRIES THE WHOLE BODY, AND IT USED TO BE A BROADCAST.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * MEASURED on the live gateway: a player hiding indoors 45 tiles from the
     * spawn received `{"actor":{"name":"Player 2","sprite":…,"x":25,"y":46,
     * "hp":60}}` for a stranger crossing into Alderbrook — name, sprite, exact
     * tile, hp, for a body they cannot see — and the ledger write beside it put
     * that stranger into `session.visible`, which is the set the sweep filter
     * reads. `reconcileSight` corrected the BOARD one frame later, which is why
     * nothing looked wrong; the data had already reached the browser.
     *
     * A REGRESSION OF THIS COMMIT'S OWN RULE rather than an old gap: until
     * `teammateFor` landed every player was a teammate and the broadcast was
     * correct.
     */
    const mine = await hello(server.port);
    const world = server.realms.overworld.world;
    const me = world.getActor(mine.actorId);
    if (me === undefined) throw new Error('no body');
    const { body } = farPair(world, [me], REVEAL_RADIUS + 2);
    me.x = body.x;
    me.y = body.y;
    mine.send({ t: 'hold' });
    await sleep(250);
    const before = mine.frames.filter((f) => f['t'] === 'joined').length;

    // A BRAND-NEW PLAYER SAYS HELLO, far away and out of sight. `hello` is one
    // of the three callers; the two crossings take the same path.
    const theirs = await hello(server.port);
    await sleep(300);
    const announced = mine.frames
      .filter((f) => f['t'] === 'joined')
      .slice(before)
      .map((f) => (f['actor'] as Record<string, unknown>)['id']);
    expect(announced, 'a stranger you cannot see was announced to you, body and all').not.toContain(
      theirs.actorId,
    );
    expect(mine.board(), 'a stranger you cannot see is on your board').not.toContain(
      theirs.actorId,
    );

    // AND THE ANNOUNCE IS NOT MERELY DELETED: walk into sight of them and the
    // body arrives. Without this the case would pass against a gateway that
    // never announces anybody.
    const scout = world.getActor(theirs.actorId);
    if (scout === undefined) throw new Error('no stranger body');
    scout.x = me.x + 1;
    scout.y = me.y;
    mine.send({ t: 'hold' });
    await sleep(250);
    expect(mine.board(), 'a stranger standing beside you never arrived').toContain(theirs.actorId);
  });

  it('does not hand you a monster`s move from the room you teleported out of', async () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE SWEEP LEDGER IS ONE PUMP STALE, AND A PHASE DOOR IS TEN TILES.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `fogEvent` filters each viewer's sweep against `session.visible`, and the
     * four cases its docblock works through are all correct FOR A VIEWER WHO
     * TOOK ONE STEP. `phase_door_rune` moves a body up to ten tiles, and the
     * monsters' moves for that turn then go out under a ledger describing the
     * room that body has left. Measured over 176 relocations: 20 sweep frames
     * carried moves for bodies 40+ tiles away, e.g. a step at 59,2 sent to a
     * viewer standing at 13,4. Under 800 legal one-tile walks it never fired
     * once, which is why walking never showed it.
     *
     * DRIVEN BY MOVING THE BODY rather than by the rune: the rule is about any
     * relocation, and recall and a forced swap do the same thing. The husk is
     * made to keep walking by handing it a remembered tile to walk to — a
     * chaser that cannot see its target heads for `ai.lastSeen` (`ai/npc.ts`
     * `targetPosition`), which is the whole reason there is anything to leak.
     */
    const client = await hello(server.port);
    const world = server.realms.overworld.world;
    const me = world.getActor(client.actorId);
    if (me === undefined) throw new Error('no body');

    // A MONSTER STANDING BESIDE YOU, so it is genuinely in the ledger first.
    const beside = { x: me.x + 1, y: me.y };
    if (!canWalk(world.level, beside.x, beside.y)) throw new Error('no ground beside the body');
    const husk = world.addMonster('pacing-husk', {
      name: 'Index Husk',
      sprite: 'enemy_index_husk_s',
      x: beside.x,
      y: beside.y,
      profile: AiProfile.MeleeChaser,
      aggroRange: 20,
    });

    /**
     * AND A SECOND BODY WAITING WHERE YOU ARE ABOUT TO LAND, which is why this
     * is an INTERSECTION and not a recomputation. Rebuilding the ledger from the
     * new tile would admit THIS one's move — and the client has never been told
     * it exists, so `applyTurnEvent`'s `move` case throws the frame away with a
     * warning (`client/main.ts`). `reconcileSight` announces it properly at the
     * foot of the same pump; the sweep must not get there first.
     *
     * PLACED BEFORE THE FIRST PUMP so the scheduler has enrolled it and it can
     * act on the pump under test — a body added a millisecond earlier emits
     * nothing, and a case measuring silence from a body that was never going to
     * speak measures nothing.
     */
    const { body: away } = farPair(world, [{ x: me.x, y: me.y }, beside], REVEAL_RADIUS + 2);
    // A FEW TILES OFF AND IN PLAIN VIEW OF IT, never adjacent: a chaser that can
    // already reach you bump-attacks, and an attack is not the event under test.
    let waiting: { x: number; y: number } | undefined;
    for (let dy = -6; dy <= 6 && waiting === undefined; dy += 1) {
      for (let dx = -6; dx <= 6; dx += 1) {
        const at = { x: away.x + dx, y: away.y + dy };
        const d = sightDistance(away, at);
        if (d < 3 || d > 6) continue;
        if (!canWalk(world.level, at.x, at.y) || world.actorAt(at.x, at.y) !== undefined) continue;
        if (!canSee(world.level, away, at)) continue;
        waiting = at;
        break;
      }
    }
    if (waiting === undefined) throw new Error('nowhere in sight of the landing tile to wait');
    const stranger = world.addMonster('waiting-husk', {
      name: 'Index Husk',
      sprite: 'enemy_index_husk_s',
      x: waiting.x,
      y: waiting.y,
      profile: AiProfile.MeleeChaser,
      aggroRange: 20,
    });
    client.send({ t: 'hold' });
    await sleep(250);
    expect(client.board(), 'the fixture never put the husk in the ledger').toContain(husk.id);
    expect(client.board(), 'the fixture had already told you about the second husk').not.toContain(
      stranger.id,
    );

    // ═══ AND NOW YOU ARE SOMEWHERE ELSE ENTIRELY ═══
    me.x = away.x;
    me.y = away.y;
    // SOMEWHERE FOR THEM TO WALK: the tile each thinks you are on. Set by hand
    // because a monster with nowhere to go emits no event for anything to leak.
    const wander = farPair(world, [{ x: me.x, y: me.y }], DEFAULT_SIGHT_RADIUS + 2).body;
    if (!isMonster(husk) || !isMonster(stranger)) throw new Error('not a monster');
    husk.ai.lastSeen = { x: wander.x, y: wander.y };
    const wasAt = { x: husk.x, y: husk.y };
    const strangerWasAt = { x: stranger.x, y: stranger.y };
    const before = client.frames.length;
    client.send({ t: 'hold' });
    await sleep(300);
    expect(
      { x: husk.x, y: husk.y },
      'the husk did not move on the pump under test, so nothing was leaked or withheld — ' +
        'that is the fixture failing, not the rule passing',
    ).not.toEqual(wasAt);
    expect(
      { x: stranger.x, y: stranger.y },
      'the second husk did not move either, so the intersection half measures nothing',
    ).not.toEqual(strangerWasAt);

    const moves = client.frames.slice(before).flatMap((frame) => {
      if (frame['t'] !== 'sweep') return [];
      const events = frame['events'];
      return Array.isArray(events) ? (events as Record<string, unknown>[]) : [];
    });
    expect(
      moves.filter((event) => event['id'] === husk.id),
      'a sweep carried a monster`s move in the room you blinked out of, forty tiles away',
    ).toEqual([]);
    expect(
      moves.filter((event) => event['id'] === stranger.id),
      'a sweep named a body your client has never been told about — the filter recomputed ' +
        'the ledger instead of narrowing it',
    ).toEqual([]);
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
  it('pools no player`s eyes into anything a player is sent', () => {
    // Every frame is built from the recipient's own body (`eyesOf`). The pooled
    // eyes are gone; this keeps them gone, and holds the three frames that were
    // the last to use them — effects, projectiles, zones — to `eyesOf`.
    const text = readFileSync(new URL('../../src/server/net/gateway.ts', import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    expect(text, 'the pooled eyes are back').not.toMatch(/\beyesIn\b/);
    const calls = [...text.matchAll(/project(?:Effects|Projectiles|Zones)\(/g)].map((m) =>
      text.slice(m.index, m.index + 220),
    );
    expect(calls.length, 'no effects, projectiles or zones frame is built at all').toBeGreaterThan(
      2,
    );
    expect(
      calls.filter((call) => !call.includes('eyesOf')),
      'an effects, projectiles or zones frame is built without the recipient`s own eyes',
    ).toEqual([]);
  });

  it('writes the Case Log record for each viewer, never once for the room', () => {
    const text = readFileSync(new URL('../../src/server/net/gateway.ts', import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    const start = text.indexOf('const recordTo = ');
    expect(start, 'the per-viewer record builder is gone').toBeGreaterThan(-1);
    const body = text.slice(start, text.indexOf('const broadcastRecord = ', start));
    expect(body, 'the record is broadcast to the room').not.toMatch(/\bbroadcast\(/);
    expect(body, 'the record is written without the viewer`s ledger').toContain(
      'recordFor(event, headlined, see)',
    );
  });

  it('builds no dressing frame without the eyes to gate it, and never from memory', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * TWO RED LINES, BECAUSE THE SECOND ONE IS THE EASY MISTAKE.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `projectProps(world)` with no predicate is the WHOLE floor, which is a
     * legitimate call for the GM console and every fixture — and is exactly what
     * shipped to every player for the life of the feature. That is the first
     * line.
     *
     * The second is sharper and is the one a well-meaning reader would cross:
     * `knownTilesFor` sits four lines from `seenTilesFor`, is what the FLOOR
     * frame beside it correctly uses, and reintroduces the leak in one word. A
     * source guard is the weakest kind and it is what there is: nothing at
     * runtime can tell a GM read from a player read.
     */
    const text = readFileSync(new URL('../../src/server/net/gateway.ts', import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    const calls = [...text.matchAll(/projectProps\(/g)].map((m) =>
      text.slice(m.index, m.index + 160),
    );
    expect(calls.length, 'no dressing frame is built at all').toBeGreaterThan(0);
    expect(
      calls.filter((call) => !call.includes('seenTilesFor')),
      'a dressing frame is built without this viewer`s CURRENT sight',
    ).toEqual([]);
    expect(
      calls.filter((call) => call.includes('knownTilesFor')),
      'a dressing frame is gated on memory — props have none, deliberately',
    ).toEqual([]);
  });

  it('derives the minimap`s reveal radius and never writes the number twice', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE SECOND-CONSTANT INCIDENT, WHICH THIS FILE ALREADY PAID FOR ONCE.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `DEFAULT_SIGHT_RADIUS` existed with the right value and the right citation
     * while a second copy beside it shipped 20 for three commits, because nobody
     * grepped for the concept first (CLAUDE.md § 4). `MINIMAP_REVEAL_RADIUS` is
     * defined as twice that one, so this asserts BOTH halves: the number, and
     * that it is derived rather than typed out again.
     *
     * The wire case above pins the COMPARISON with a boundary pair one tile
     * apart; it cannot pin the number, because its own fixture is placed from
     * the same constant. These two assertions are the other half of that.
     */
    expect(MINIMAP_REVEAL_RADIUS).toBe(DEFAULT_SIGHT_RADIUS * 2);
    expect(MINIMAP_REVEAL_RADIUS, 'ours, and it is twenty').toBe(20);

    const sight = readFileSync(new URL('../../src/shared/sight.ts', import.meta.url), 'utf8');
    expect(
      sight,
      'the reveal radius is a literal — change the sight radius and it silently will not follow',
    ).toContain('MINIMAP_REVEAL_RADIUS = DEFAULT_SIGHT_RADIUS * 2');

    const gateway = readFileSync(
      new URL('../../src/server/net/gateway.ts', import.meta.url),
      'utf8',
    )
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    const beacons = gateway.slice(gateway.indexOf('const beaconsFor ='));
    const body = beacons.slice(0, beacons.indexOf('const sitesMemoKey'));
    expect(body.length, 'the beacon builder is gone').toBeGreaterThan(200);
    expect(body, 'the beacon builder measures against a number of its own').not.toMatch(/\b20\b/);
    expect(body, 'the beacon builder does not read the shared radius at all').toContain(
      'MINIMAP_REVEAL_RADIUS',
    );
  });

  it('anchors the sight ledger to a tile everywhere it writes one', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * `visible` AND `visibleAt` ARE ONE FACT — see `Session.visibleAt`.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * The sweep filter asks whether the viewer is still standing where their
     * ledger was computed. A write that left the tile behind would hand it a
     * position from the map the body has LEFT, and two worlds share a
     * coordinate space and nothing else. There are four writers and the
     * behavioural case can only reach one of them, so this holds the other
     * three: every `session.visible = ` is followed by an `anchorLedger` call.
     */
    const text = readFileSync(new URL('../../src/server/net/gateway.ts', import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    const writes = [...text.matchAll(/session\.visible = /g)].map((m) =>
      text.slice(m.index, m.index + 220),
    );
    expect(writes.length, 'nothing writes the ledger wholesale any more').toBeGreaterThan(2);
    expect(
      writes.filter((write) => !write.includes('anchorLedger(')),
      'the ledger is replaced without saying where it was taken from',
    ).toEqual([]);
  });

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
    // `Props` JOINED THE LIST HERE, and it is why the list is a list: the
    // dressing shipped unfogged for the life of the feature while this exact
    // guard sat four lines away naming two of the three projections.
    const unfogged = [...text.matchAll(/project(?:Actors|World|Props)\(\s*[A-Za-z.]+\s*\)/g)].map(
      (m) => m[0],
    );
    expect(
      unfogged,
      'a snapshot is built without eyes in the gateway — every send there serves a player',
    ).toEqual([]);
  });
});
