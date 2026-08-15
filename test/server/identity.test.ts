import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import Fastify from 'fastify';

import { createDownedState } from '../../src/server/engine/downed.ts';
import { createDiscordAuth, readAuthConfig } from '../../src/server/http/auth.ts';
import { createSessionStore } from '../../src/server/http/session.ts';
import { actorIdForUser, wsGateway } from '../../src/server/net/gateway.ts';
import { createTurnEngine } from '../../src/server/turn-engine.ts';
import { createWorld } from '../../src/server/world/world.ts';
import { ErrorCode, parseClientMsg } from '../../src/shared/protocol.ts';
import { PROTOCOL_VERSION } from '../../src/shared/version.ts';
import type { DiscordIdentity } from '../../src/server/http/auth.ts';
import type { SessionStore } from '../../src/server/http/session.ts';
import type { World } from '../../src/server/world/world.ts';

// ---------------------------------------------------------------------------
// ═══════════════════════════════════════════════════════════════════════════
//   IDENTITY CANNOT BE ASSERTED FROM THE WIRE. THE CENTRAL TEST OF M5.
// ═══════════════════════════════════════════════════════════════════════════
//
// CLAUDE.md non-negotiable 5: "Identity comes from a server-side
// `GET /users/@me`, never from a field on the wire — the protocol has no
// `actorId`/`userId` key at all."
//
// This file runs the REAL gateway over a REAL WebSocket against a real world,
// because the claim is about what a socket can and cannot do, and a socket is
// the only thing that can prove it. Nothing here reaches inside the gateway;
// every assertion is made from where an attacker stands — a connection, some
// JSON, and whatever comes back.
//
// THE SHAPE OF THE ARGUMENT, IN THREE PARTS:
//
//   1. THERE IS NO FIELD. Every client schema is `z.strictObject`, so a frame
//      carrying `actorId`, `userId` or `name` is REJECTED rather than
//      sanitised. A client cannot say who it is because the sentence does not
//      exist in the language.
//   2. THE ONE THING IT MAY PRESENT IS NOT A CLAIM. `hello.sessionId` is an
//      opaque handle THIS SERVER MINTED after a server-side `/users/@me`. There
//      is no payload in it to forge; a handle nobody minted resolves to nobody.
//   3. RESOLVING TO NOBODY IS ANONYMOUS PLAY, NOT AN ERROR. That is deliberate
//      (see `verify` in gateway.ts) and it is what keeps tools/e2e-m1.mjs and
//      the plain-browser dev loop working. So the test for a forged handle is
//      not "it is refused" — it is "it gets a throwaway body of its own and
//      cannot touch the person it was impersonating".
//
// NO CAST TO `DiscordUserId` APPEARS HERE. The two test identities are minted
// through `createDiscordAuth().verifyIdentity()` with a stubbed Discord, which
// is the only way anything in this repo can obtain one — the test has to go and
// ask, exactly as the server does.
// ---------------------------------------------------------------------------

/** Snowflake-SHAPED, and nobody's real id. */
const REN_ID = '222222222222222222';
const ALEX_ID = '444444444444444444';

const API_BASE = 'https://discord.invalid/api';

/** How long a `waitFor` waits before deciding a frame is never coming. */
const FRAME_TIMEOUT_MS = 2_000;

let REN: DiscordIdentity;
let ALEX: DiscordIdentity;

/**
 * A verified identity, obtained the only way there is.
 *
 * The stub answers `GET /users/@me`; `verifyIdentity` is what turns that answer
 * into a `DiscordUserId`. Going the long way round is the point — it is a
 * working demonstration that identity has exactly one source.
 */
async function verifiedIdentity(id: string, globalName: string): Promise<DiscordIdentity> {
  const config = readAuthConfig({
    DISCORD_CLIENT_ID: '111111111111111111',
    DISCORD_CLIENT_SECRET: 'test-secret',
  });
  const auth = createDiscordAuth(config, {
    apiBase: API_BASE,
    fetch: (): Promise<Response> =>
      Promise.resolve(
        new Response(
          JSON.stringify({ id, username: globalName.toLowerCase(), global_name: globalName }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        ),
      ),
  });
  const result = await auth.verifyIdentity(`token-for-${id}`);
  if (!result.ok) throw new Error(`could not mint a test identity: ${result.reason}`);
  return result.identity;
}

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
  /** Everything this socket has been sent, in order. */
  readonly frames: readonly Frame[];
  send(frame: Frame): void;
  /** `hello` plus the `welcome` it produces. Undefined if none arrives. */
  hello(fields?: Frame): Promise<Frame | undefined>;
  waitFor(type: string, timeoutMs?: number): Promise<Frame | undefined>;
  waitWhere(predicate: (frame: Frame) => boolean, timeoutMs?: number): Promise<Frame | undefined>;
  /** Forget everything so far, so a `waitFor` cannot match an old frame. */
  clear(): void;
  /** The RFC 6455 code this socket was closed with, or null while it is open. */
  closeCode(): number | null;
  waitClosed(timeoutMs?: number): Promise<number | null>;
  close(): void;
};

const openClients: Client[] = [];

async function connect(port: number): Promise<Client> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  let frames: Frame[] = [];
  let closeCode: number | null = null;

  socket.addEventListener('message', (event: MessageEvent) => {
    frames.push(asFrame(String(event.data)));
  });
  socket.addEventListener('close', (event: CloseEvent) => {
    closeCode = event.code;
  });

  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => {
      resolve();
    });
    socket.addEventListener('error', () => {
      reject(new Error('the socket never opened'));
    });
  });

  const waitWhere = async (
    predicate: (frame: Frame) => boolean,
    timeoutMs = FRAME_TIMEOUT_MS,
  ): Promise<Frame | undefined> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = frames.find(predicate);
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
    async hello(fields: Frame = {}) {
      client.send({ t: 'hello', ...fields });
      return await client.waitFor('welcome');
    },
    waitWhere,
    async waitFor(type: string, timeoutMs = FRAME_TIMEOUT_MS) {
      return await waitWhere((frame) => frame['t'] === type, timeoutMs);
    },
    clear(): void {
      frames = [];
    },
    closeCode: (): number | null => closeCode,
    async waitClosed(timeoutMs = FRAME_TIMEOUT_MS) {
      const deadline = Date.now() + timeoutMs;
      while (closeCode === null && Date.now() < deadline) await sleep(10);
      return closeCode;
    },
    close(): void {
      socket.close();
    },
  };

  openClients.push(client);
  return client;
}

/**
 * Take one step in whichever direction is open, and return the `moved` frame.
 *
 * The spawn tile is wherever the seeded placement put it, so a fixed direction
 * would make the test depend on the map. tools/e2e-m1.mjs walks the compass for
 * the same reason.
 */
async function stepSomewhere(client: Client): Promise<Frame | undefined> {
  for (const dir of ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw']) {
    client.send({ t: 'move', dir });
    const moved = await client.waitFor('moved', 300);
    if (moved !== undefined) return moved;
  }
  return undefined;
}

/** The ids in a `party` frame, which is the wire's own answer to "who is here". */
function partyIds(frame: Frame | undefined): string[] {
  const members = frame?.['members'];
  if (!Array.isArray(members)) return [];
  return members.map((member: unknown) =>
    typeof member === 'object' && member !== null && 'id' in member ? String(member.id) : '?',
  );
}

function partyName(frame: Frame | undefined, id: string): string | undefined {
  const members = frame?.['members'];
  if (!Array.isArray(members)) return undefined;
  for (const member of members) {
    if (typeof member !== 'object' || member === null) continue;
    if ('id' in member && String(member.id) === id && 'name' in member) return String(member.name);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// The server
// ---------------------------------------------------------------------------

type Harness = {
  readonly port: number;
  /** The live world, for the assertions that must not be taken on the wire's word. */
  readonly world: World;
  /** The real session table, so a test can mint and revoke handles. */
  readonly sessions: SessionStore;
  close(): Promise<void>;
};

async function boot(): Promise<Harness> {
  const app = Fastify({ logger: false });
  const world = createWorld('identity-test');
  const downed = createDownedState();
  const engine = createTurnEngine({ world, downed });
  const sessions = createSessionStore({ ttlMs: 60_000 });

  // The SAME store the auth route would write to — main.ts creates one and
  // hands it to both. Two would be two answers to "who is this".
  await app.register(wsGateway, {
    world,
    engine,
    downed,
    sessions,
    // Shortened only so a stray timer cannot outlive the test process; nothing
    // here waits for it.
    disconnectGraceMs: 30_000,
  });
  await app.listen({ host: '127.0.0.1', port: 0 });

  const address = app.server.address();
  if (address === null || typeof address === 'string') throw new Error('no port was bound');

  return {
    port: address.port,
    world,
    sessions,
    close: async (): Promise<void> => {
      await app.close();
    },
  };
}

let server: Harness;

beforeAll(async () => {
  REN = await verifiedIdentity(REN_ID, 'Ren');
  ALEX = await verifiedIdentity(ALEX_ID, 'Alex');
});

beforeEach(async () => {
  server = await boot();
});

afterEach(async () => {
  for (const client of openClients) client.close();
  openClients.length = 0;
  await server.close();
});

// ===========================================================================
// 1. THERE IS NO FIELD IN WHICH TO CLAIM AN IDENTITY
// ===========================================================================

describe('the protocol has no identity field, on any message', () => {
  /** One legal example of every frame a client may send. */
  const LEGAL: readonly Frame[] = [
    { t: 'hello' },
    { t: 'hello', sessionId: 'an-opaque-handle', resumeToken: 'a-resume-token' },
    { t: 'move', dir: 'n' },
    { t: 'commit' },
    { t: 'hold' },
    { t: 'talent', talentId: 'talent:strike' },
    { t: 'talent', talentId: 'talent:strike', target: { x: 3, y: 4 } },
    { t: 'say', text: 'behind the pillar' },
    { t: 'point', x: 3, y: 4 },
    { t: 'revive', dir: 'e' },
    { t: 'ping' },
  ];

  /** Every spelling of "I am somebody" that a client might reach for. */
  const IDENTITY_KEYS = [
    'actorId',
    'userId',
    'id',
    'selfId',
    'ownerId',
    'discordId',
    'name',
    'speaker',
    'as',
  ];

  it('parses every legal frame', () => {
    for (const frame of LEGAL) {
      const parsed = parseClientMsg({ v: PROTOCOL_VERSION, ...frame });
      expect(parsed.ok, `${String(frame['t'])} should parse`).toBe(true);
    }
  });

  it('rejects the same frame the moment it names anybody', () => {
    for (const frame of LEGAL) {
      for (const key of IDENTITY_KEYS) {
        const forged = { v: PROTOCOL_VERSION, ...frame, [key]: 'actor_u_941c3ee4777234e1' };
        const parsed = parseClientMsg(forged);
        expect(parsed.ok, `${String(frame['t'])} + ${key} must be refused`).toBe(false);
      }
    }
  });

  it('rejects rather than strips, so the attempt is visible in the log', () => {
    // `z.strictObject`, not `z.object`. The difference matters: a schema that
    // stripped the key would be equally safe and would make the attempt
    // invisible, and "somebody tried to move another actor" is worth seeing.
    const parsed = parseClientMsg({ v: PROTOCOL_VERSION, t: 'move', dir: 'n', actorId: 'x' });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// 2. A FORGED HANDLE IS NOT AN IMPERSONATION
// ===========================================================================

describe('a forged session handle', () => {
  it('gets anonymous play, never the impersonated actor', async () => {
    const renSession = server.sessions.create(REN, 'Ren');

    const ren = await connect(server.port);
    const renWelcome = await ren.hello({ sessionId: renSession.id });
    expect(renWelcome?.['selfId']).toBe(actorIdForUser(REN_ID));

    // A handle of exactly the right SHAPE — 43 base64url characters, which is
    // what this server mints — that this server did not mint.
    const forger = await connect(server.port);
    const forged = 'F0rgedHandleThatLooksExactlyLikeARealOne123';
    expect(forged).toHaveLength(renSession.id.length);
    const forgedWelcome = await forger.hello({ sessionId: forged });

    // ANONYMOUS PLAY, AND A BODY OF ITS OWN.
    expect(forgedWelcome?.['selfId']).toBeDefined();
    expect(forgedWelcome?.['selfId']).not.toBe(renWelcome?.['selfId']);
    expect(String(forgedWelcome?.['selfId']).startsWith('actor_u_')).toBe(false);

    // Ren is untouched: still connected, still driving their own body, and now
    // simply aware that somebody else joined.
    expect(ren.closeCode()).toBeNull();
    const party = await forger.waitFor('party');
    expect(partyIds(party).sort()).toEqual(
      [String(renWelcome?.['selfId']), String(forgedWelcome?.['selfId'])].sort(),
    );
    expect(partyName(party, String(renWelcome?.['selfId']))).toBe('Ren');
    // …and the forger is a numbered stranger, not a second Ren.
    expect(partyName(party, String(forgedWelcome?.['selfId']))).toMatch(/^Player \d+$/);
    expect(server.world.allActors()).toHaveLength(2);
  });

  it('cannot reach a body by presenting a handle that has been revoked', async () => {
    const renSession = server.sessions.create(REN, 'Ren');
    const ren = await connect(server.port);
    const renWelcome = await ren.hello({ sessionId: renSession.id });
    const renActor = String(renWelcome?.['selfId']);

    // Ren's laptop closes. The body stays in the world for the grace window —
    // which is precisely the window in which a stolen handle would be worth
    // something, if it still worked.
    ren.close();
    await ren.waitClosed();
    server.sessions.revoke(renSession.id);

    const thief = await connect(server.port);
    const welcome = await thief.hello({ sessionId: renSession.id });

    expect(welcome?.['selfId']).toBeDefined();
    expect(welcome?.['selfId']).not.toBe(renActor);
    // Ren's body is still standing there, still Ren's.
    expect(server.world.getActor(renActor)?.name).toBe('Ren');
    expect(server.world.allActors()).toHaveLength(2);
  });

  it('is treated the same as no handle at all — an empty, absent or junk one', async () => {
    const renSession = server.sessions.create(REN, 'Ren');
    const renActor = actorIdForUser(REN_ID);

    for (const junk of [renSession.id.slice(0, -1), `${renSession.id}x`, 'null', '../../etc']) {
      const client = await connect(server.port);
      const welcome = await client.hello({ sessionId: junk });
      expect(welcome?.['selfId']).not.toBe(renActor);
      client.close();
    }

    // Nobody ever reached Ren's body, and Ren has not even connected yet.
    expect(server.world.getActor(renActor)).toBeUndefined();
  });
});

// ===========================================================================
// 3. A FORGED FIELD CANNOT MOVE SOMEBODY ELSE
// ===========================================================================

describe('extra identity fields on a live socket', () => {
  it('cannot move another actor — the frame is refused and nobody moves', async () => {
    const renSession = server.sessions.create(REN, 'Ren');
    const ren = await connect(server.port);
    const renWelcome = await ren.hello({ sessionId: renSession.id });
    const renActor = String(renWelcome?.['selfId']);
    const renBefore = server.world.getActor(renActor);
    const before = { x: renBefore?.x, y: renBefore?.y };

    const attacker = await connect(server.port);
    await attacker.hello();
    ren.clear();
    attacker.clear();

    // The exact frame tools/e2e-m1.mjs sends, and it must keep failing.
    attacker.send({ t: 'move', dir: 'n', actorId: renActor, userId: REN_ID });

    const refusal = await attacker.waitFor('error');
    expect(refusal?.['code']).toBe(ErrorCode.BadMessage);
    // Not one `moved` frame anywhere: the schema refused the frame before the
    // engine ever saw it, so nothing was submitted for anybody.
    expect(await attacker.waitFor('moved', 250)).toBeUndefined();
    expect(await ren.waitFor('moved', 250)).toBeUndefined();
    const renAfter = server.world.getActor(renActor);
    expect({ x: renAfter?.x, y: renAfter?.y }).toEqual(before);
  });

  it('cannot speak, point or revive as anybody else either', async () => {
    const renSession = server.sessions.create(REN, 'Ren');
    const ren = await connect(server.port);
    const renWelcome = await ren.hello({ sessionId: renSession.id });
    const renActor = String(renWelcome?.['selfId']);

    const attacker = await connect(server.port);
    await attacker.hello();
    ren.clear();
    attacker.clear();

    attacker.send({ t: 'say', text: 'I confess', speaker: renActor });
    attacker.send({ t: 'point', x: 2, y: 2, actorId: renActor });
    attacker.send({ t: 'revive', dir: 'n', actorId: renActor });

    // THREE REFUSALS, and not one frame attributed to Ren. `say` and `point`
    // are the two frames nothing else brakes — they change no state, so the
    // schema is the only thing standing between them and a broadcast.
    expect((await attacker.waitFor('error'))?.['code']).toBe(ErrorCode.BadMessage);
    await sleep(100);
    expect(attacker.frames.filter((frame) => frame['t'] === 'error')).toHaveLength(3);
    expect(ren.frames.some((frame) => frame['t'] === 'pinged')).toBe(false);
    expect(JSON.stringify(ren.frames)).not.toContain('I confess');
  });
});

// ===========================================================================
// 4. A VERIFIED IDENTITY IS STABLE, AND IS NOT A SNOWFLAKE
// ===========================================================================

describe('a verified session', () => {
  it('resolves to the same actor id across a reconnect', async () => {
    const session = server.sessions.create(REN, 'Ren');

    const first = await connect(server.port);
    const firstWelcome = await first.hello({ sessionId: session.id });
    const actorId = String(firstWelcome?.['selfId']);
    expect(actorId).toBe(actorIdForUser(REN_ID));

    first.close();
    await first.waitClosed();

    // NO RESUME TOKEN. The reconnect carries nothing but the session handle, so
    // the only thing that can put this socket back on that body is the identity
    // behind it.
    const second = await connect(server.port);
    const secondWelcome = await second.hello({ sessionId: session.id });

    expect(secondWelcome?.['selfId']).toBe(actorId);
    // One body, not two: the reconnect reattached rather than spawning.
    expect(server.world.allActors()).toHaveLength(1);
    const party = await second.waitFor('party');
    expect(partyIds(party)).toEqual([actorId]);
    expect(partyName(party, actorId)).toBe('Ren');
  });

  it('never puts the Discord snowflake on the wire', async () => {
    const session = server.sessions.create(REN, 'Ren');
    const client = await connect(server.port);
    await client.hello({ sessionId: session.id });
    client.send({ t: 'move', dir: 'n' });
    await sleep(100);

    // CLAUDE.md non-negotiable 7. `ActorView.id` is on every `moved`, every
    // `joined` and every `party` row, in every client's memory and in the Case
    // Log — so the snowflake must never enter any of them.
    const everything = JSON.stringify(client.frames);
    expect(everything.length).toBeGreaterThan(0);
    expect(everything).not.toContain(REN_ID);
    expect(actorIdForUser(REN_ID)).not.toContain(REN_ID);
    // Stable and derived, so a returning player finds their own character.
    expect(actorIdForUser(REN_ID)).toBe(actorIdForUser(REN_ID));
    expect(actorIdForUser(REN_ID)).not.toBe(actorIdForUser(ALEX_ID));
  });

  it('follows the person, not the socket: two people keep two bodies', async () => {
    const renSession = server.sessions.create(REN, 'Ren');
    const alexSession = server.sessions.create(ALEX, 'Alex');

    const ren = await connect(server.port);
    const renWelcome = await ren.hello({ sessionId: renSession.id });
    const alex = await connect(server.port);
    const alexWelcome = await alex.hello({ sessionId: alexSession.id });

    expect(renWelcome?.['selfId']).toBe(actorIdForUser(REN_ID));
    expect(alexWelcome?.['selfId']).toBe(actorIdForUser(ALEX_ID));
    expect(server.world.allActors()).toHaveLength(2);

    const party = await alex.waitFor('party');
    expect(partyName(party, actorIdForUser(REN_ID))).toBe('Ren');
    expect(partyName(party, actorIdForUser(ALEX_ID))).toBe('Alex');
  });

  it('takes the display name from Discord, not from anything the client said', async () => {
    // The handle carries no name, and there is no field for one. The name in
    // the party panel is whatever the session table says — which is whatever
    // `/users/@me` said, scrubbed by `safeDisplayName`.
    const session = server.sessions.create(REN, 'Ren');
    const client = await connect(server.port);
    client.send({ t: 'hello', sessionId: session.id, name: 'Somebody Else' });

    // A `hello` that tries to carry a name is not a rename — it is a refused
    // frame, and no body is created for it at all.
    expect((await client.waitFor('error'))?.['code']).toBe(ErrorCode.BadMessage);
    expect(await client.waitFor('welcome', 200)).toBeUndefined();
    expect(server.world.allActors()).toHaveLength(0);

    // The name that does arrive is the one the session table holds, which is
    // the one `/users/@me` gave.
    const welcome = await client.hello({ sessionId: session.id });
    expect(partyName(await client.waitFor('party'), String(welcome?.['selfId']))).toBe('Ren');
  });
});

// ===========================================================================
// 5. TWO SOCKETS, ONE PERSON
// ===========================================================================

describe('two sockets with the same identity', () => {
  it('the second takes over, the first is closed, and exactly one actor remains', async () => {
    const session = server.sessions.create(REN, 'Ren');

    const firstTab = await connect(server.port);
    const firstWelcome = await firstTab.hello({ sessionId: session.id });
    const actorId = String(firstWelcome?.['selfId']);

    const secondTab = await connect(server.port);
    const secondWelcome = await secondTab.hello({ sessionId: session.id });

    // ONE PERSON DRIVES ONE DETECTIVE. A party panel with two identical names
    // splitting one character's turns between two windows is the failure the
    // barrier cannot recover from.
    expect(secondWelcome?.['selfId']).toBe(actorId);
    expect(await firstTab.waitClosed()).toBe(4001);
    expect(secondTab.closeCode()).toBeNull();
    expect(server.world.allActors()).toHaveLength(1);

    const party = await secondTab.waitFor('party');
    expect(partyIds(party)).toEqual([actorId]);

    // The survivor still drives the body, and the takeover cost nothing.
    secondTab.clear();
    const moved = await stepSomewhere(secondTab);
    expect(moved?.['id']).toBe(actorId);
  });

  it('does not announce a `joined` for the takeover — the body was already there', async () => {
    const renSession = server.sessions.create(REN, 'Ren');
    const alexSession = server.sessions.create(ALEX, 'Alex');

    const alex = await connect(server.port);
    await alex.hello({ sessionId: alexSession.id });
    const renTabOne = await connect(server.port);
    await renTabOne.hello({ sessionId: renSession.id });

    alex.clear();
    const renTabTwo = await connect(server.port);
    await renTabTwo.hello({ sessionId: renSession.id });
    await renTabOne.waitClosed();

    // Alex sees no second Ren appear, because there is no second Ren.
    expect(alex.frames.some((frame) => frame['t'] === 'joined')).toBe(false);
    expect(server.world.allActors()).toHaveLength(2);
  });
});

// ===========================================================================
// 6. ANONYMOUS PLAY — THE PLAIN-BROWSER PATH
// ===========================================================================

describe('anonymous play', () => {
  it('works end to end with no session, no handle and no Discord', async () => {
    const one = await connect(server.port);
    const welcome = await one.hello();

    expect(welcome?.['selfId']).toBeDefined();
    const selfId = String(welcome?.['selfId']);
    // A throwaway body: `actor_<uuid>`, not the `actor_u_` shape a verified
    // account gets, so a stored id says at a glance which it is.
    expect(selfId.startsWith('actor_')).toBe(true);
    expect(selfId.startsWith('actor_u_')).toBe(false);

    // The level really arrived, so this is a playable connection and not just
    // a frame with an id in it.
    const level = welcome?.['level'];
    expect(typeof level === 'object' && level !== null && 'w' in level ? level.w : 0).toBe(30);

    const two = await connect(server.port);
    const twoWelcome = await two.hello();
    expect(twoWelcome?.['selfId']).not.toBe(selfId);

    // Two anonymous players see each other.
    expect((await one.waitFor('joined'))?.['t']).toBe('joined');
    const party = await two.waitFor('party');
    expect(partyIds(party)).toHaveLength(2);
    expect(partyName(party, selfId)).toMatch(/^Player \d+$/);

    // And one of them can move, which the other is told about — the whole of
    // M1's promise, still reachable with no Discord anywhere in sight.
    one.clear();
    two.clear();
    expect((await stepSomewhere(one))?.['id']).toBe(selfId);
    expect((await two.waitFor('moved'))?.['id']).toBe(selfId);
    expect(server.world.allActors()).toHaveLength(2);
  });

  it('is what a server with no session table at all gives everybody', async () => {
    // A gateway registered without `sessions` — the M3 shape, and the shape
    // tools/e2e-m1.mjs runs against. A `hello` carrying a handle is not an
    // error there either; it simply resolves to nobody.
    const app = Fastify({ logger: false });
    const world = createWorld('no-sessions');
    const downed = createDownedState();
    await app.register(wsGateway, { world, engine: createTurnEngine({ world, downed }), downed });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (address === null || typeof address === 'string') throw new Error('no port was bound');

    const client = await connect(address.port);
    const welcome = await client.hello({ sessionId: 'anything-at-all' });

    expect(String(welcome?.['selfId']).startsWith('actor_u_')).toBe(false);
    expect(world.allActors()).toHaveLength(1);

    client.close();
    await app.close();
  });
});
