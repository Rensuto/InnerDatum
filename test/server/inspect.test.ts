import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import Fastify from 'fastify';

import { AiProfile } from '../../src/server/engine/actor.ts';
import { createDownedState } from '../../src/server/engine/downed.ts';
import { wsGateway } from '../../src/server/net/gateway.ts';
import { createTurnEngine } from '../../src/server/turn-engine.ts';
import { createWorld } from '../../src/server/world/world.ts';
import { ErrorCode } from '../../src/shared/protocol.ts';
import { PROTOCOL_VERSION } from '../../src/shared/version.ts';
import type { Actor, World } from '../../src/server/world/world.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * `inspect` — THE ONE FRAME WHOSE ANSWER MUST NOT BE MORE INFORMATIVE THAN
 * THE FLOOR ALLOWS.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * This runs the REAL gateway over a REAL WebSocket, like test/server/identity.ts,
 * because every claim here is about what a SOCKET can learn — and the composition
 * being tested (inspectActor, then attackBlockedReason, in that order and only in
 * that order) lives in the gateway rather than in src/server/view/inspect.ts.
 * Calling the two view functions directly would test the halves and skip the
 * seam, which is exactly where the interesting failure is.
 *
 * ═══ THE ANTI-ORACLE PROPERTY IS THE POINT OF THIS FILE ═══
 * `there is no such actor` and `there is, and you cannot see it` must come back
 * as the SAME frame. If they can be told apart, a patched client never needs to
 * see anybody: it walks the id space, keeps every id whose reply differs from
 * the reply for junk, and has the roster of the floor. `an unknown id is
 * indistinguishable from a hidden one` below is that test, and it is the single
 * assertion in this file that is load-bearing for something other than polish.
 *
 * ═══ WHY THE GEOMETRY IS HAND-PLACED ═══
 * Bodies are moved onto authored tiles of the M1 test level rather than left
 * where the seeded spawn put them, because the file's claims are about
 * DISTANCE and WALLS. The 4x4 block at rows 4-7, columns 5-8 is the wall used
 * throughout: a viewer at (5,3) and a body at (5,8) have four solid tiles
 * between them and nothing else on the map has to cooperate.
 */

/** How long a `waitFor` waits before deciding a frame is never coming. */
const FRAME_TIMEOUT_MS = 2_000;

/** An id of the right shape that nobody in this world owns. */
const MISSING_ID = 'actor_u_0000000000000000';

// ---------------------------------------------------------------------------
// The socket harness
// ---------------------------------------------------------------------------

type Frame = Record<string, unknown>;

function asFrame(text: string): Frame {
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`the server sent something that is not a frame: ${text.slice(0, 80)}`);
  }
  return { ...parsed };
}

type Client = {
  readonly frames: readonly Frame[];
  send(frame: Frame): void;
  hello(): Promise<Frame | undefined>;
  /** Send one `inspect` and return the `inspected` that answers it. */
  inspect(targetId: string): Promise<Frame>;
  waitFor(type: string, timeoutMs?: number): Promise<Frame | undefined>;
  clear(): void;
  close(): void;
};

const openClients: Client[] = [];

async function connect(port: number): Promise<Client> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  let frames: Frame[] = [];

  socket.addEventListener('message', (event: MessageEvent) => {
    frames.push(asFrame(String(event.data)));
  });

  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => {
      resolve();
    });
    socket.addEventListener('error', () => {
      reject(new Error('the socket never opened'));
    });
  });

  const waitFor = async (
    type: string,
    timeoutMs = FRAME_TIMEOUT_MS,
  ): Promise<Frame | undefined> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = frames.find((frame) => frame['t'] === type);
      if (hit !== undefined) return hit;
      if (Date.now() >= deadline) return undefined;
      await sleep(10);
    }
  };

  const client: Client = {
    get frames() {
      return frames;
    },
    send(frame: Frame): void {
      socket.send(JSON.stringify({ v: PROTOCOL_VERSION, ...frame }));
    },
    async hello() {
      client.send({ t: 'hello' });
      return await client.waitFor('welcome');
    },
    async inspect(targetId: string) {
      // Cleared first so `waitFor` cannot match the answer to a previous
      // question — there is no correlation id on this wire, deliberately.
      client.clear();
      client.send({ t: 'inspect', targetId });
      const answer = await client.waitFor('inspected');
      if (answer === undefined) throw new Error(`no \`inspected\` came back for ${targetId}`);
      return answer;
    },
    waitFor,
    clear(): void {
      frames = [];
    },
    close(): void {
      socket.close();
    },
  };

  openClients.push(client);
  return client;
}

// ---------------------------------------------------------------------------
// The server, and the bodies on the floor
// ---------------------------------------------------------------------------

type Harness = {
  readonly port: number;
  readonly world: World;
  close(): Promise<void>;
};

async function boot(seed: string): Promise<Harness> {
  const app = Fastify({ logger: false });
  const world = createWorld(seed);
  const downed = createDownedState();
  await app.register(wsGateway, {
    world,
    engine: createTurnEngine({ world, downed }),
    downed,
    disconnectGraceMs: 30_000,
  });
  await app.listen({ host: '127.0.0.1', port: 0 });

  const address = app.server.address();
  if (address === null || typeof address === 'string') throw new Error('no port was bound');

  return {
    port: address.port,
    world,
    close: async (): Promise<void> => {
      await app.close();
    },
  };
}

let server: Harness;

beforeEach(async () => {
  server = await boot('inspect-test');
});

afterEach(async () => {
  for (const client of openClients) client.close();
  openClients.length = 0;
  await server.close();
});

function actorOf(id: string): Actor {
  const found = server.world.getActor(id);
  if (found === undefined) throw new Error(`test fixture: actor ${id} is missing`);
  return found;
}

function husk(id: string, x: number, y: number): Actor {
  const monster = server.world.addMonster(id, {
    name: `Husk ${id}`,
    sprite: 'enemy_index_husk_s',
    x,
    y,
    profile: AiProfile.MeleeChaser,
  });
  // `addMonster` shuffles to the nearest FREE tile, which is right for authored
  // encounters and wrong for a test whose whole subject is distance. Pinned.
  monster.x = x;
  monster.y = y;
  return monster;
}

/**
 * A viewer at (5,3) with four bodies arranged around the rows 4-7 wall block.
 *
 * EVERYTHING IS PLACED AFTER `hello`, and that matters: the gateway pumps on
 * `hello`, and a pump with monsters already on the floor would start the
 * engagement clock and move things. Nothing in this file sends a frame that
 * pumps, so the arrangement below is the arrangement every assertion sees.
 */
type Scene = {
  readonly client: Client;
  readonly viewer: Actor;
  /** Chebyshev 1, clear line — the bump-attack case. */
  readonly adjacent: Actor;
  /** Chebyshev 2, clear line — out of reach, but visible. */
  readonly twoAway: Actor;
  /** Four wall tiles in between. */
  readonly hidden: Actor;
  /** Visible, and a corpse. */
  readonly corpse: Actor;
  /** A player body at 0 hp, which is NOT a corpse. */
  readonly friend: Actor;
};

async function scene(): Promise<Scene> {
  const client = await connect(server.port);
  const welcome = await client.hello();
  const viewer = actorOf(String(welcome?.['selfId']));
  viewer.x = 5;
  viewer.y = 3;

  const adjacent = husk('m_adjacent', 6, 3);
  const twoAway = husk('m_two_away', 7, 3);
  // (5,4) through (5,7) are the authored 4x4 block, so the bresenham walk from
  // (5,3) hits a wall on its first interior step.
  const hidden = husk('m_hidden', 5, 8);
  const corpse = husk('m_corpse', 6, 2);
  corpse.hp = 0;
  corpse.alive = false;

  const friend = server.world.addPlayer('p_friend', 'Friend');
  friend.x = 4;
  friend.y = 3;
  friend.hp = 0;
  friend.alive = false;

  return { client, viewer, adjacent, twoAway, hidden, corpse, friend };
}

/** The `view` of an `inspected` frame, as an object the test can read. */
function viewOf(frame: Frame): Frame | null {
  const view = frame['view'];
  if (view === null) return null;
  if (typeof view !== 'object' || Array.isArray(view)) {
    throw new Error(`\`view\` should be an object or null, got ${typeof view}`);
  }
  return { ...(view as Frame) };
}

function rowsOf(view: Frame | null): Frame[] {
  const rows = view?.['rows'];
  if (!Array.isArray(rows)) return [];
  return rows.map((row: unknown) => ({ ...(row as Frame) }));
}

// ===========================================================================
// 1. WHAT A VISIBLE HOSTILE ANSWERS
// ===========================================================================

describe('a hostile in line of sight', () => {
  it('comes back as a card for that target, led by the chance to hit', async () => {
    const floor = await scene();

    const answer = await floor.client.inspect(floor.adjacent.id);
    expect(answer['t']).toBe('inspected');
    // The correlation is BY TARGET — there is no request id anywhere on this
    // wire, so a client with two hovers in flight matches on this field.
    expect(answer['targetId']).toBe(floor.adjacent.id);

    const view = viewOf(answer);
    expect(view?.['id']).toBe(floor.adjacent.id);
    expect(view?.['name']).toBe(floor.adjacent.name);
    expect(view?.['maxHp']).toBe(floor.adjacent.maxHp);

    // THE NUMBER THE PLAYER IS ACTUALLY ASKING FOR, and it is the emphasised
    // one: everything else on the card is context for it.
    const hit = rowsOf(view).find((row) => row['label'] === 'Chance to hit');
    expect(hit).toBeDefined();
    expect(hit?.['emphasis']).toBe(true);
    expect(String(hit?.['value'])).toMatch(/^\d+%$/);

    // The badge row stays empty until somebody populates it — asserted so the
    // day it starts carrying effect ids is a day this test notices.
    expect(view?.['effects']).toEqual([]);
  });
});

// ===========================================================================
// 2 & 3. THE ANTI-ORACLE PROPERTY
// ===========================================================================

describe('what the viewer may not know', () => {
  it('answers `view: null` for a body with a wall in the way', async () => {
    const floor = await scene();
    const answer = await floor.client.inspect(floor.hidden.id);

    // NOT a redacted card, NOT an error frame: silence with a shape.
    expect(answer['view']).toBeNull();
    expect(answer['targetId']).toBe(floor.hidden.id);
    // And emphatically not `attackBlockedReason`'s own sentence, which would
    // confirm both that the body exists and that a wall is what is in the way.
    expect(JSON.stringify(answer)).not.toContain('no line of sight');
  });

  it('gives an UNKNOWN id a frame indistinguishable from a HIDDEN one', async () => {
    // ═══ THE MOST IMPORTANT ASSERTION IN THIS FILE ═══
    // If these two frames can be sorted apart by any means — a key, a value, a
    // code, a shape — then `inspect` is an id oracle and a patched client
    // enumerates the floor without ever seeing a single body. They are compared
    // twice: structurally, and as bytes with the echoed target normalised out.
    const floor = await scene();

    const hidden = await floor.client.inspect(floor.hidden.id);
    const missing = await floor.client.inspect(MISSING_ID);

    // Structurally identical apart from the field that merely echoes the
    // question back, so no key is present in one and absent from the other.
    expect(missing).toEqual({ ...hidden, targetId: MISSING_ID });
    expect(Object.keys(missing).sort()).toEqual(Object.keys(hidden).sort());

    // ...and byte-identical once the echo is normalised: same key ORDER, same
    // JSON, nothing to time and nothing to diff.
    const canonical = (frame: Frame, targetId: string): string =>
      JSON.stringify(frame).split(targetId).join('<target>');
    expect(canonical(missing, MISSING_ID)).toBe(canonical(hidden, floor.hidden.id));

    // Neither is an error, either: an ErrorCode for "cannot see it" would be
    // the same oracle wearing a different hat.
    expect(await floor.client.waitFor('error', 100)).toBeUndefined();
  });
});

// ===========================================================================
// 4. REACH — THE QUESTION BUMP-ATTACK ACTUALLY ASKS
// ===========================================================================

describe('`blockedReason` is asked with the viewer’s own reach', () => {
  it('is absent for an adjacent hostile — walk into it and you hit it', async () => {
    const floor = await scene();
    const view = viewOf(await floor.client.inspect(floor.adjacent.id));

    // PRESENT MEANS REFUSED, so absent means "yes". `undefined` rather than an
    // empty string: the key does not survive JSON.stringify at all.
    expect(view?.['blockedReason']).toBeUndefined();
    expect(Object.keys(view ?? {})).not.toContain('blockedReason');
  });

  it('says so for a hostile two tiles away, because the reach is one', async () => {
    const floor = await scene();
    const view = viewOf(await floor.client.inspect(floor.twoAway.id));

    // The viewer carries no combat sheet, so `viewer.combat?.range ?? 1` is 1 —
    // which IS bump-attack reach, and bump-attack is the only attack there is.
    expect(String(view?.['blockedReason'])).toContain('out of range');
    // The card still arrives: "I can see it and cannot reach it" is exactly the
    // thing a tooltip exists to say.
    expect(view?.['id']).toBe(floor.twoAway.id);
    const distance = rowsOf(view).find((row) => row['label'] === 'Distance');
    expect(distance?.['value']).toBe('2 tiles');
  });
});

// ===========================================================================
// 5. A CORPSE IS NOT A BODY ON THE FLOOR
// ===========================================================================

describe('the dead', () => {
  it('refuses a dead MONSTER and answers a downed PLAYER', async () => {
    const floor = await scene();

    // inspect.ts:119 rejects the first and not the second, deliberately: a husk
    // at 0 hp is scenery, but a player at 0 hp is somebody an ally is running
    // at — and "how long have they got" is the question the run is about.
    expect((await floor.client.inspect(floor.corpse.id))['view']).toBeNull();

    const friend = viewOf(await floor.client.inspect(floor.friend.id));
    expect(friend?.['id']).toBe(floor.friend.id);
    expect(friend?.['hp']).toBe(0);
    // Not a hostile, so no hit chance is offered for a teammate's body.
    expect(rowsOf(friend).map((row) => row['label'])).not.toContain('Chance to hit');
    // ...and the reason an attack would be refused is the honest one.
    expect(friend?.['blockedReason']).toBe('already down');
  });
});

// ===========================================================================
// 6. IT COSTS NOTHING, AND THEREFORE MUST DO NOTHING
// ===========================================================================

describe('an inspect is not a turn', () => {
  it('does not advance the clock, and produces no frame but the answer', async () => {
    const floor = await scene();
    const before = server.world.turn.clock.gameTurn;
    const wherePlayerWas = { x: floor.viewer.x, y: floor.viewer.y };

    floor.client.clear();
    for (const id of [floor.adjacent.id, floor.hidden.id, MISSING_ID]) {
      floor.client.send({ t: 'inspect', targetId: id });
    }
    await sleep(150);

    expect(server.world.turn.clock.gameTurn).toBe(before);
    // No pump ran, so nothing moved and no energy was spent.
    expect({ x: floor.viewer.x, y: floor.viewer.y }).toEqual(wherePlayerWas);
    expect(floor.viewer.pendingIntent).toBeNull();

    // THREE ANSWERS AND NOTHING ELSE. A `turn` frame here would mean the turn
    // key changed; a `state` or a `log` would mean the world did.
    const kinds = floor.client.frames.map((frame) => frame['t']);
    expect(kinds).toEqual(['inspected', 'inspected', 'inspected']);
  });

  it('answers the ASKER alone — an inspect is never broadcast', async () => {
    // What `inspectActor` returns depends on the viewer's line of sight, so the
    // same target inspected by two people is legitimately two different frames.
    // A broadcast would hand one player the other's answer.
    const floor = await scene();
    const bystander = await connect(server.port);
    await bystander.hello();
    bystander.clear();

    await floor.client.inspect(floor.adjacent.id);
    await sleep(100);

    expect(bystander.frames.some((frame) => frame['t'] === 'inspected')).toBe(false);
  });
});

// ===========================================================================
// 7. THE HANDSHAKE COMES FIRST
// ===========================================================================

describe('before `hello`', () => {
  it('is refused with not_authenticated and answers nothing at all', async () => {
    const client = await connect(server.port);
    client.send({ t: 'inspect', targetId: MISSING_ID });

    const refusal = await client.waitFor('error');
    expect(refusal?.['code']).toBe(ErrorCode.NotAuthenticated);
    // No card leaked past the refusal, not even a null one.
    expect(await client.waitFor('inspected', 200)).toBeUndefined();
  });
});
