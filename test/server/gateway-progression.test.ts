import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';

import Fastify from 'fastify';

import {
  ALCHEMIST,
  INSPECTOR,
  WATCHMAN,
  classById,
  createContentTalentEngine,
  createTalentBook,
  sheetForClass,
} from '../../src/server/content/classes.ts';
import { talentRuntimeFor } from '../../src/server/main.ts';
import { wsGateway } from '../../src/server/net/gateway.ts';
import { UNASSIGNED_CLASS } from '../../src/server/persist/saves.ts';
import { createTurnEngine } from '../../src/server/turn-engine.ts';
import { createWorld } from '../../src/server/world/world.ts';
import { AiProfile } from '../../src/server/engine/actor.ts';
import { createDownedState, goDown } from '../../src/server/engine/downed.ts';
import { TALENT_MAX_LEVEL, totalPointsAtLevel } from '../../src/shared/progression.ts';
import { ActorKind, TileCode } from '../../src/shared/protocol.ts';
import { PROTOCOL_VERSION } from '../../src/shared/version.ts';
import type { PlayerActor } from '../../src/server/engine/actor.ts';
import type { TalentEngine } from '../../src/server/engine/talents.ts';
import type {
  CharacterRestore,
  CharacterSnapshot,
  IdentityPort,
  PersistPort,
  TurnEngine,
} from '../../src/server/net/gateway.ts';
import type { World } from '../../src/server/world/world.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * SPENDING A TALENT POINT: WHO MAY, WHAT IT COSTS THE WORLD, AND WHAT COMES
 * BACK OUT OF A SAVE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A spend is the second one-way door in the protocol (the first is
 * `choose_class`): there is no unlearn verb, no refund and no undo, so a point
 * that lands on the wrong talent — or on the wrong PERSON — is gone for the
 * evening. That is why this file leads with security rather than with the happy
 * path, in the same order and the same shape test/server/class-choice.test.ts
 * uses for the other one-way door.
 *
 * ═══ THE SIX CLAIMS, AND WHY EACH ONE HAS TEETH ═══
 *
 *   1. THE FRAME CANNOT NAME A PERSON. `SpendPointSchema` is a `strictObject`,
 *      so an `actorId` on the wire is REJECTED rather than quietly stripped into
 *      a legal frame. Stripping is the dangerous failure here: a sanitised frame
 *      would silently spend the SENDER's point, which is a lie about what the
 *      player asked for and is unrecoverable.
 *
 *   2. THE TALENT IS RESOLVED SERVER-SIDE, THROUGH THIS BODY'S OWN SHEET. An
 *      Alchemist naming the Watchman's Iron Curtain is refused, and so is a
 *      talent nobody has ever registered. One lookup
 *      (`engine.loadoutOf(actorId)`) answers both, which is the point: a second
 *      table of "which talents exist" is a second thing to get out of step.
 *
 *   3. THE THREE GAME RULES: a point in hand, a rank below the cap, and a body
 *      on its feet. Nothing in `engine/` enforces the 1..5 cap — src/shared/
 *      scale.ts deliberately refuses to clamp the curve, and
 *      `applyPendingLevels` only ever grants — so the spend handler is the whole
 *      of it, and this is the only place that can prove it.
 *
 *   4. IT DOES NOT MOVE THE WORLD. The frame joins `inspect` and `choose_class`
 *      in the non-pumping group. If it pumped, a player could bank a levelled
 *      talent AND a free monster turn from one click, and the barrier's whole
 *      "a frame that costs the sender nothing" doctrine would have a hole in it.
 *
 *   5. THE CLIENT IS TOLD, AND TOLD PRIVATELY. A spend produces a fresh
 *      `loadout` (three of its fields are stale the instant a rank changes) and
 *      a fresh `progress` — and `progress` is a `ViewerMsg`, so the party never
 *      learns how many points somebody is holding back.
 *
 *   6. IT SURVIVES THE ROUND TRIP, EFFECT AND ALL. Restoring the NUMBER but not
 *      the EFFECT is the failure that would otherwise ship: a level-6 character
 *      whose Fog Step says 5 and steps 3.
 *
 * ═══ WHY THIS FILE DRIVES A REAL SOCKET AND A REAL TALENT ENGINE ═══
 * Every claim is about the ORDER of private steps inside the gateway. Nothing
 * exports `handleSpendPoint`, and the only place its behaviour is observable is
 * the frames a socket receives and the sheet a body is left holding. The talent
 * engine is the real one because claim 6 is a statement about
 * `sheetOf(...).points` and about a RANGE the server will actually accept; a
 * stub would be a test of the stub. Only the disk is faked, and it is faked as a
 * port rather than as a directory because where the bytes land is
 * test/server/persist.test.ts's question.
 */

/** Snowflake-SHAPED, and nobody's real id. */
const REN_ID = '333333333333333333';
const ALEX_ID = '555555555555555555';

const FRAME_TIMEOUT_MS = 2_000;

// ---------------------------------------------------------------------------
// The socket harness — the same one class-choice.test.ts drives
// ---------------------------------------------------------------------------

type Frame = Record<string, unknown>;

type Client = {
  readonly frames: readonly Frame[];
  send(frame: Frame): void;
  /** Send a raw payload, envelope and all — for the schema tests. */
  sendRaw(payload: unknown): void;
  hello(sessionId?: string): Promise<Frame | undefined>;
  /**
   * SEND A FRAME AND WAIT UNTIL EVERYTHING IT PRODUCED HAS ARRIVED.
   *
   * The `ping` is the ORDERING BARRIER, and it is what makes "no frame was sent"
   * a testable claim rather than a race with a timeout: the socket delivers in
   * order and the gateway answers `ping` synchronously without pumping, so once
   * `pong` is in hand every frame the previous send produced is already here.
   */
  settle(): Promise<void>;
  waitFor(type: string, timeoutMs?: number): Promise<Frame | undefined>;
  all(type: string): Frame[];
  last(type: string): Frame | undefined;
  clear(): void;
  close(): void;
};

const openClients: Client[] = [];

async function connect(port: number): Promise<Client> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  let frames: Frame[] = [];

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
    sendRaw(payload: unknown): void {
      socket.send(JSON.stringify(payload));
    },
    async hello(sessionId?: string) {
      client.send({ t: 'hello', ...(sessionId === undefined ? {} : { sessionId }) });
      return await client.waitFor('welcome');
    },
    async settle() {
      client.send({ t: 'ping' });
      const pong = await waitFor('pong');
      if (pong === undefined) throw new Error('the server never answered the ordering ping');
      frames = frames.filter((frame) => frame['t'] !== 'pong');
    },
    waitFor,
    all: (type: string): Frame[] => frames.filter((frame) => frame['t'] === type),
    last: (type: string): Frame | undefined => frames.filter((f) => f['t'] === type).at(-1),
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
// The server
// ---------------------------------------------------------------------------

function identityPort(): IdentityPort {
  const people: Readonly<Record<string, { id: string; name: string }>> = {
    'ren-handle': { id: REN_ID, name: 'Ren' },
    'alex-handle': { id: ALEX_ID, name: 'Alex' },
  };
  return {
    get: (id: string | undefined) => {
      const found = id === undefined ? undefined : people[id];
      return found === undefined ? undefined : { user: { id: found.id }, displayName: found.name };
    },
  };
}

/**
 * A `PersistPort` that records instead of writing.
 *
 * IT IS THE PORT, NOT THE BRIDGE, and that is deliberate rather than lazy. What
 * this file has to prove about persistence is what the GATEWAY hands over and
 * what it does with what it is handed — `snapshotPlayers` and `applyRestore` —
 * and both are observable at exactly this seam. The shipped
 * `createCharacterBridge` sits downstream of it and has its own tests; using it
 * here would also hide the one thing the round-trip test is for, because on this
 * build `fileFor` still writes the values the file was OPENED with rather than
 * the snapshot's (see `CharacterSnapshot` in net/gateway.ts, which names the
 * four lines that close that seam).
 */
type Recorder = {
  /** Every immediate flush, in order, with the gateway's own reason label. */
  readonly flushes: { readonly reason: string; readonly snapshots: CharacterSnapshot[] }[];
  /** Every DEBOUNCED batch. A spend must never appear here. */
  readonly queued: CharacterSnapshot[][];
  /** What `openCharacter` answers. Set by a test before the `hello`. */
  restore: CharacterRestore | null;
  readonly port: PersistPort;
};

function recorder(): Recorder {
  const state: Recorder = {
    flushes: [],
    queued: [],
    restore: null,
    port: {
      savePlayers: (snapshots) => {
        state.queued.push([...snapshots]);
      },
      savePlayersNow: (snapshots, reason) => {
        state.flushes.push({ reason, snapshots: [...snapshots] });
      },
      openCharacter: () => Promise.resolve(state.restore),
    },
  };
  return state;
}

type Harness = {
  readonly port: number;
  readonly world: World;
  readonly talents: TalentEngine;
  readonly saves: Recorder;
  close(): Promise<void>;
};

/**
 * Boot the real gateway over the real engine, with the three progression seams
 * src/server/main.ts declares.
 *
 * THE SEAMS ARE COPIED FROM main.ts RATHER THAN IMPORTED, and that is the one
 * compromise in this file: `buildServer()` binds a port, reads `.env` and mounts
 * static roots. What is copied is four lines per method, and every one of them
 * is re-asserted against the SHIPPED implementation's contract in the round-trip
 * test — a copy that stopped matching would show up there as a level that came
 * back without its effect.
 */
async function boot(seed: string): Promise<Harness> {
  const app = Fastify({ logger: false });
  const world = createWorld(seed);
  // Wall to wall floor: nothing here is about terrain, and a spawn search that
  // has to dodge a pillar would make placement a variable.
  world.level.tiles.fill(TileCode.FLOOR);

  const talents = createContentTalentEngine();
  const downed = createDownedState();
  const base = createTurnEngine({
    world,
    now: () => 0,
    downed,
    talents: createTalentBook(talents, world),
    talentRuntime: talentRuntimeFor(talents, world),
  });

  const engine: TurnEngine = {
    ...base,
    attachClass: (actorId: string, classId: string): void => {
      const definition = classById(classId);
      if (definition !== undefined) talents.attach(actorId, sheetForClass(definition));
    },
    raiseTalentPoint: (actorId: string, talentId: string): number | null => {
      const sheet = talents.sheetOf(actorId);
      const current = sheet?.points.get(talentId);
      if (sheet === undefined || current === undefined) return null;
      if (current >= TALENT_MAX_LEVEL) return current;
      const next = current + 1;
      sheet.points.set(talentId, next);
      return next;
    },
    talentPointsOf: (actorId: string): Readonly<Record<string, number>> | undefined => {
      const sheet = talents.sheetOf(actorId);
      if (sheet === undefined) return undefined;
      const out: Record<string, number> = {};
      for (const [id, raw] of sheet.points) out[id] = raw;
      return out;
    },
    applyTalentPoints: (actorId, points): readonly string[] | undefined => {
      const sheet = talents.sheetOf(actorId);
      if (sheet === undefined) return undefined;
      const dropped: string[] = [];
      for (const [id, raw] of Object.entries(points)) {
        if (!sheet.points.has(id) || !Number.isFinite(raw)) {
          dropped.push(id);
          continue;
        }
        sheet.points.set(id, Math.max(1, Math.min(TALENT_MAX_LEVEL, Math.floor(raw))));
      }
      return dropped;
    },
  };

  const saves = recorder();
  await app.register(wsGateway, {
    world,
    engine,
    downed,
    sessions: identityPort(),
    persist: saves.port,
    disconnectGraceMs: 30_000,
  });
  await app.listen({ host: '127.0.0.1', port: 0 });

  const address = app.server.address();
  if (address === null || typeof address === 'string') throw new Error('no port was bound');

  return {
    port: address.port,
    world,
    talents,
    saves,
    close: async (): Promise<void> => {
      await app.close();
    },
  };
}

let server: Harness;

afterEach(async () => {
  for (const client of openClients) client.close();
  openClients.length = 0;
  await server.close();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The body behind a `welcome`, narrowed to a PLAYER — the only kind that levels. */
function bodyOf(welcome: Frame | undefined): PlayerActor {
  const id = String(welcome?.['selfId']);
  const actor = server.world.getActor(id);
  if (actor === undefined) throw new Error(`test fixture: no actor for ${id}`);
  if (actor.kind !== ActorKind.Player) throw new Error(`test fixture: ${id} is not a player`);
  return actor;
}

/**
 * "This account already plays the Alchemist." Set BEFORE the `hello`.
 *
 * ═══ WHY EVERY TEST HERE ARRIVES WITH A CLASS ON FILE ═══
 * Two reasons, and the second is the one that bites. The first is ordinary: the
 * rotation is per-PROCESS, so a test that names `talent:iron_curtain` has to say
 * which class it is asking about rather than depend on join order.
 *
 * The second is that a body which has NOT chosen is in `classChoiceOwed`, and
 * `snapshotPlayers` deliberately files `UNASSIGNED_CLASS` and NO talent spread
 * for anybody in that set — a provisional class's ranks are an answer to a
 * question nobody has been asked. So a test that skipped this and then asserted
 * on `snapshot.talentPoints` would be asserting against the chooser's sentinel
 * and would read as a missing feature rather than as the rule it is.
 */
function playsThe(definition: typeof WATCHMAN, over: Partial<CharacterRestore> = {}): void {
  server.saves.restore = { hp: null, cooldowns: {}, classId: definition.id, ...over };
}

/** The talent rows off the most recent `loadout` frame. */
function loadoutRows(client: Client): Frame[] {
  const frame = client.last('loadout');
  const talents = frame?.['talents'];
  return Array.isArray(talents) ? (talents as Frame[]) : [];
}

function rowFor(client: Client, talentId: string): Frame | undefined {
  return loadoutRows(client).find((row) => row['id'] === talentId);
}

// ===========================================================================
// 1. SECURITY — the frame, the id, and who may spend
// ===========================================================================

describe('a spend frame cannot name anybody', () => {
  it('REJECTS an actorId rather than stripping it', async () => {
    // ═══════════════════════════════════════════════════════════════════════
    // THE STRIP IS THE DANGEROUS FAILURE, NOT THE REJECTION.
    // ═══════════════════════════════════════════════════════════════════════
    //
    // `SpendPointSchema` is a `strictObject`, so an unknown key is a parse
    // ERROR. If it were a plain object the extra key would be dropped and the
    // frame would become a perfectly legal spend against the SENDER's own
    // sheet — a point permanently spent on a talent nobody asked for, with no
    // unlearn verb to undo it and nothing in the log to say why.
    //
    // The claim is therefore about the ERROR, and specifically about which one:
    // `bad_message` from the parser, before the handler is ever entered, which
    // is proved by the sheet being untouched afterwards.
    server = await boot('spend-strict');
    playsThe(WATCHMAN);
    const ren = await connect(server.port);
    const body = bodyOf(await ren.hello('ren-handle'));
    body.unspentPoints = 5;
    ren.clear();

    ren.sendRaw({
      v: PROTOCOL_VERSION,
      t: 'spend_point',
      talentId: 'talent:crude_blow',
      actorId: 'actor_somebody_else',
    });
    await ren.settle();

    const error = ren.last('error');
    expect(error?.['code']).toBe('bad_message');
    // NOTHING HAPPENED. Not the point, not the rank, and no frame that would
    // have told a client otherwise.
    expect(body.unspentPoints).toBe(5);
    expect(server.talents.sheetOf(body.id)?.points.get('talent:crude_blow')).toBe(1);
    expect(ren.all('loadout')).toHaveLength(0);
    expect(ren.all('progress')).toHaveLength(0);
  });

  it('refuses a talent that belongs to somebody else’s class', async () => {
    // AN ALCHEMIST CANNOT BUY THE WATCHMAN'S IRON CURTAIN. The id is real, the
    // frame is well-formed, and zod accepts both — deliberately, because baking
    // the talent catalogue into the wire schema would make every content edit a
    // protocol change. So the ONLY thing refusing this is the server-side
    // lookup through this body's own sheet, which is exactly the check being
    // pinned.
    server = await boot('spend-wrong-class');
    const ren = await connect(server.port);
    playsThe(ALCHEMIST);
    const body = bodyOf(await ren.hello('ren-handle'));
    body.unspentPoints = 3;
    ren.clear();

    ren.send({ t: 'spend_point', talentId: 'talent:iron_curtain' });
    await ren.settle();

    expect(ren.last('error')?.['code']).toBe('bad_message');
    expect(body.unspentPoints).toBe(3);
    // And the id did not get SEEDED into the sheet either — a spend must never
    // teach a body a talent it never learned.
    expect(server.talents.sheetOf(body.id)?.points.has('talent:iron_curtain')).toBe(false);
  });

  it('refuses a talent id no registry has ever heard of', async () => {
    server = await boot('spend-unknown');
    const ren = await connect(server.port);
    playsThe(WATCHMAN);
    const body = bodyOf(await ren.hello('ren-handle'));
    body.unspentPoints = 3;
    ren.clear();

    ren.send({ t: 'spend_point', talentId: 'talent:no_such_thing' });
    await ren.settle();

    expect(ren.last('error')?.['code']).toBe('bad_message');
    expect(body.unspentPoints).toBe(3);
  });
});

describe('the three game rules', () => {
  it('refuses a spend with no points in hand', async () => {
    server = await boot('spend-broke');
    const ren = await connect(server.port);
    playsThe(WATCHMAN);
    const body = bodyOf(await ren.hello('ren-handle'));
    // A fresh character: four talents at rank 1 and NOTHING granted yet.
    expect(body.unspentPoints).toBe(0);
    ren.clear();

    ren.send({ t: 'spend_point', talentId: 'talent:crude_blow' });
    await ren.settle();

    expect(ren.last('error')?.['code']).toBe('bad_message');
    expect(server.talents.sheetOf(body.id)?.points.get('talent:crude_blow')).toBe(1);
  });

  it('refuses a spend on a talent already at the cap', async () => {
    // ═══ THE CAP LIVES HERE AND NOWHERE ELSE ═══
    // Nothing in `engine/` enforces 1..5: `applyPendingLevels` only ever grants,
    // and src/shared/scale.ts:165-170 argues at length that the CURVE must not
    // clamp (a level above 5 has to extrapolate honestly, or a future mastery
    // system silently flat-lines). So this handler is the whole of the cap and
    // this test is the whole of the proof.
    server = await boot('spend-capped');
    const ren = await connect(server.port);
    playsThe(WATCHMAN);
    const body = bodyOf(await ren.hello('ren-handle'));
    body.unspentPoints = 4;
    const sheet = server.talents.sheetOf(body.id);
    sheet?.points.set('talent:crude_blow', TALENT_MAX_LEVEL);
    ren.clear();

    ren.send({ t: 'spend_point', talentId: 'talent:crude_blow' });
    await ren.settle();

    expect(ren.last('error')?.['code']).toBe('bad_message');
    expect(sheet?.points.get('talent:crude_blow')).toBe(TALENT_MAX_LEVEL);
    // AND THE POINT IS STILL IN HAND. A refused spend that had already charged
    // for itself would be the worst possible outcome of this branch.
    expect(body.unspentPoints).toBe(4);
  });

  it('refuses a spend from a DOWNED body, and the point survives', async () => {
    // ═══════════════════════════════════════════════════════════════════════
    // NOT A COURTESY. A DOWNED BODY IS MID-RECORD.
    // ═══════════════════════════════════════════════════════════════════════
    //
    // `goDown` files a `DownedRecord` that `revive`/`standUp` reads back to put
    // the right body on its feet, which is why `handleChooseClass` refuses a
    // body on the floor. A spend is milder — it rewrites a rank rather than a
    // sprite — but it is the same class of write to a body whose state is
    // half-held somewhere else, and "not now" costs the player nothing: the
    // point is still there when somebody picks them up.
    server = await boot('spend-downed');
    const ren = await connect(server.port);
    playsThe(WATCHMAN);
    const body = bodyOf(await ren.hello('ren-handle'));
    body.unspentPoints = 2;
    goDown(createDownedState(), body, 0);
    expect(body.alive).toBe(false);
    ren.clear();

    ren.send({ t: 'spend_point', talentId: 'talent:crude_blow' });
    await ren.settle();

    // `not_your_turn` — "not now", never "not there".
    expect(ren.last('error')?.['code']).toBe('not_your_turn');
    expect(body.unspentPoints).toBe(2);
    expect(server.talents.sheetOf(body.id)?.points.get('talent:crude_blow')).toBe(1);
  });

  it('refuses a spend while a class choice is still outstanding', async () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE POINT WOULD BE DESTROYED, SILENTLY AND IRREVERSIBLY.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `handleChooseClass` ends in `engine.attachClass`, whose seam finishes with
     * an unconditional `sheets.set` of a FRESH sheet — every talent back to rank
     * 1 — and it credits nothing back to `unspentPoints`. So a point spent
     * before the picker is answered is spent twice over: the rank it bought is
     * overwritten and the point was already deducted, with no error and no log
     * line anywhere.
     *
     * THIS IS NOT AN EDGE CASE FOR THE FIRST FOUR SECONDS. `classChoiceOwed` is
     * cleared only by answering, and `unparkOnCommand` deliberately releases the
     * park while LEAVING the id in the set — precisely so somebody can start
     * playing before finishing the paperwork. Such a body has a real rotation
     * class, a real loadout and a real sheet, and `awardExperience` filters only
     * on `kind === Player`, so it genuinely banks points over a whole evening.
     *
     * THE SHIPPED CLIENT CANNOT SEND THIS — every input gate returns early while
     * `classOptions !== null`. That is exactly why the test exists: CLAUDE.md's
     * non-negotiable is "never trust the client", and this handler's docblock
     * used to assume the state was unreachable for a reason that is false.
     */
    server = await boot('spend-owes-class');
    const ren = await connect(server.port);
    // `restore.classId === UNASSIGNED_CLASS` is what `handleHello` reads as
    // "we still owe them a screen" — every character file written before classes
    // shipped holds this exact string.
    server.saves.restore = { hp: null, cooldowns: {}, classId: UNASSIGNED_CLASS };
    const body = bodyOf(await ren.hello('ren-handle'));
    // The rotation dressed them provisionally, so there IS a sheet to damage.
    const sheet = server.talents.sheetOf(body.id);
    expect(sheet).toBeDefined();
    const talent = [...(sheet?.points.keys() ?? [])][0];
    expect(talent).toBeDefined();
    body.unspentPoints = 3;
    ren.clear();

    ren.send({ t: 'spend_point', talentId: talent ?? '' });
    await ren.settle();

    // `not_your_turn` — "not now", on the same shape the downed branch uses.
    expect(ren.last('error')?.['code']).toBe('not_your_turn');
    // AND NOTHING MOVED. The rank is untouched and the points are still in hand,
    // so answering the picker costs this player nothing.
    expect(sheet?.points.get(talent ?? '')).toBe(1);
    expect(body.unspentPoints).toBe(3);
  });

  it('answers `internal` and mutates NOTHING when the body is not in the world', async () => {
    // ═══ THE RECALLED-MID-CLICK CASE ═══
    // The socket is still open and still authenticated, and the body it owns has
    // been removed — a recall that fired between the click and the frame. The
    // ordering rule this pins is `handleChooseClass`'s: nothing below the
    // in-world check is undoable, so the check comes FIRST and the answer is a
    // capability failure rather than a game-rule refusal.
    server = await boot('spend-no-body');
    const ren = await connect(server.port);
    playsThe(WATCHMAN);
    const body = bodyOf(await ren.hello('ren-handle'));
    body.unspentPoints = 3;

    // The sheet, byte for byte, before the frame.
    const before = JSON.stringify([...(server.talents.sheetOf(body.id)?.points ?? [])]);
    server.world.removePlayer(body.id);
    ren.clear();

    ren.send({ t: 'spend_point', talentId: 'talent:crude_blow' });
    await ren.settle();

    expect(ren.last('error')?.['code']).toBe('internal');
    // BYTE-IDENTICAL. The sheet outlives the body in the talent engine's table
    // until `forget` runs, so "nothing was touched" is a claim that can be made
    // precisely rather than by absence.
    expect(JSON.stringify([...(server.talents.sheetOf(body.id)?.points ?? [])])).toBe(before);
    expect(ren.all('loadout')).toHaveLength(0);
    expect(ren.all('progress')).toHaveLength(0);
  });
});

// ===========================================================================
// 2. WHAT A SUCCESSFUL SPEND DOES — AND WHAT IT MUST NOT
// ===========================================================================

describe('a successful spend', () => {
  it('does not advance the world: no clock, no energy, no monster', async () => {
    // ═══════════════════════════════════════════════════════════════════════
    // NON-PUMPING, BESIDE `inspect` AND `choose_class`.
    // ═══════════════════════════════════════════════════════════════════════
    //
    // The group's own reason, in the dispatch switch: a frame that costs the
    // sender nothing must not be a way to make the server advance the world. If
    // a spend pumped, one click would buy a rank AND a free monster turn — and
    // a player holding four points could hand the party four extra husk turns
    // from the safety of a panel.
    //
    // Proved three ways rather than one, because "the world did not move" has
    // three independent witnesses and any one of them alone could be a
    // coincidence of a quiet turn: the game clock, the mover's own energy, and
    // whether a monster with a live intent got to act.
    server = await boot('spend-nonpumping');
    const ren = await connect(server.port);
    playsThe(WATCHMAN);
    const body = bodyOf(await ren.hello('ren-handle'));
    body.unspentPoints = 2;
    body.x = 10;
    body.y = 10;
    const husk = server.world.addMonster('m_husk', {
      name: 'Index Husk',
      sprite: 'enemy_index_husk_s',
      x: 14,
      y: 10,
      profile: AiProfile.MeleeChaser,
      maxHp: 200,
    });
    // A live fight, so the barrier is armed and a pump would visibly do work.
    server.world.turn.engagement = 5;
    await ren.settle();

    const clockBefore = server.world.turn.clock.gameTurn;
    const energyBefore = body.energy;
    const huskAt = { x: husk.x, y: husk.y };
    ren.clear();

    ren.send({ t: 'spend_point', talentId: 'talent:crude_blow' });
    await ren.settle();

    expect(server.talents.sheetOf(body.id)?.points.get('talent:crude_blow')).toBe(2);
    expect(server.world.turn.clock.gameTurn).toBe(clockBefore);
    expect(body.energy).toBe(energyBefore);
    expect({ x: husk.x, y: husk.y }).toEqual(huskAt);
    // And no frame that only a pump can produce.
    expect(ren.all('sweep')).toHaveLength(0);
    expect(ren.all('moved')).toHaveLength(0);
  });

  it('clears Standing By — a spend is a human at the keyboard', async () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE STRAGGLER WHO IS READING THE PANEL IS STILL PLAYING.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `expire` sets `standingBy` after two silent Bells, and that flag removes a
     * body from the quorum ENTIRELY: from then on they auto-hold with no Bell
     * delay and the party stops waiting for them. Ren levels mid-fight, opens
     * the panel and spends forty-five seconds reading four current->next diffs
     * to decide where the point goes — long enough for exactly that to happen,
     * while the server holds two `spend_point` frames from her, each of which
     * took a deliberate press on a `+` button.
     *
     * `barrier.noteCommand`'s own doctrine is "someone who is at the keyboard
     * trying things is present, and that is the only thing Standing By is
     * measuring". Every TURN verb carries it; `spend_point` does not pump, so it
     * needs the `notePresence` seam to reach it.
     *
     * ═══ AND IT MUST NOT RESTART THE BELL ═══
     * The Bell's key is the BLOCKING SET, and a spend does not change who owes a
     * turn. Rejoining the quorum must not buy the straggler a second of extra
     * time, or the panel becomes a stall button.
     */
    server = await boot('spend-presence');
    const ren = await connect(server.port);
    playsThe(WATCHMAN);
    const body = bodyOf(await ren.hello('ren-handle'));
    body.unspentPoints = 1;
    // Two silent Bells have rung: this is exactly what `expire` leaves behind.
    body.standingBy = true;
    ren.clear();

    ren.send({ t: 'spend_point', talentId: 'talent:crude_blow' });
    await ren.settle();

    expect(server.talents.sheetOf(body.id)?.points.get('talent:crude_blow')).toBe(2);
    // BACK IN THE QUORUM. Without the seam this stays true for the rest of the
    // fight and the party never waits for her again.
    expect(body.standingBy).toBe(false);
  });

  it('flushes to disk immediately rather than riding the 5s debounce', async () => {
    // ═══ A SPENT POINT MUST BE ON DISK BEFORE THE NEXT THING THAT CHANGES IT
    // ═══ The same argument `handleChooseClass` makes for `saveNow('join')`: the
    // spend is irreversible and cannot be re-derived from anything else in the
    // file, so the five seconds a debounce costs are precisely the five seconds
    // in which a browser closing loses a decision the player already made.
    //
    // It matters a second way here. `SaveStore.scheduleCharacter` holds its
    // snapshot BY REFERENCE, so the debounced path is a promise about an object
    // that is still moving — which is why `snapshotPlayers` builds a fresh
    // `CharacterFile` on every call and why this one takes the immediate path.
    server = await boot('spend-flush');
    const ren = await connect(server.port);
    playsThe(INSPECTOR);
    const body = bodyOf(await ren.hello('ren-handle'));
    body.unspentPoints = 1;
    server.saves.flushes.length = 0;
    server.saves.queued.length = 0;

    ren.send({ t: 'spend_point', talentId: 'talent:fog_step' });
    await ren.settle();

    expect(server.saves.flushes.map((f) => f.reason)).toEqual(['spend']);
    expect(server.saves.queued).toHaveLength(0);
    // And the flush carries the NEW spread, not the one the pump before it saw.
    const filed = server.saves.flushes[0]?.snapshots.find((s) => s.actorId === body.id);
    expect(filed?.talentPoints?.['talent:fog_step']).toBe(2);
    expect(filed?.unspentPoints).toBe(0);
  });

  it('resends the loadout with the new level, desc and descNext', async () => {
    // ═══ THREE OF THE FIELDS ARE STALE THE INSTANT A RANK CHANGES ═══
    // `range` is per-actor from v9, and `desc`/`descNext` are the current->next
    // diff (LevelupDialog.lua:963-970). A panel that spent a point and did not
    // get a new `loadout` would keep drawing the rank it just left, which is the
    // one thing a levelup screen must never do.
    server = await boot('spend-loadout');
    const ren = await connect(server.port);
    playsThe(INSPECTOR);
    const body = bodyOf(await ren.hello('ren-handle'));
    body.unspentPoints = 4;
    await ren.settle();
    ren.clear();

    ren.send({ t: 'spend_point', talentId: 'talent:fog_step' });
    await ren.settle();

    // EXACTLY ONE. `sendLoadout` carries no once-guard, so a handler that
    // called it twice would work and would also double every hotbar rebuild.
    expect(ren.all('loadout')).toHaveLength(1);
    const row = rowFor(ren, 'talent:fog_step');
    expect(row?.['level']).toBe(2);
    expect(row?.['maxLevel']).toBe(TALENT_MAX_LEVEL);
    expect(String(row?.['desc'])).not.toBe(String(row?.['descNext']));
    expect(row?.['descNext']).not.toBeNull();
    // The other three are untouched and still say rank 1, so a spend is a
    // per-talent write rather than a class-wide one.
    expect(rowFor(ren, 'talent:snipers_mark')?.['level']).toBe(1);
  });

  it('reports descNext as null once the talent reaches the cap', async () => {
    // ToME's at-cap branch (LevelupDialog.lua:971-975) renders the current
    // description ALONE. `null` is that branch on the wire, and it is null
    // rather than "" because an empty string draws a blank row where the diff
    // should be — a fact the renderer must handle, not one it can miss.
    server = await boot('spend-cap-diff');
    const ren = await connect(server.port);
    playsThe(INSPECTOR);
    const body = bodyOf(await ren.hello('ren-handle'));
    body.unspentPoints = 1;
    server.talents.sheetOf(body.id)?.points.set('talent:fog_step', TALENT_MAX_LEVEL - 1);
    ren.clear();

    ren.send({ t: 'spend_point', talentId: 'talent:fog_step' });
    await ren.settle();

    const row = rowFor(ren, 'talent:fog_step');
    expect(row?.['level']).toBe(TALENT_MAX_LEVEL);
    expect(row?.['descNext']).toBeNull();
    expect(String(row?.['desc']).length).toBeGreaterThan(0);
  });

  it('sends `progress` to the spender and to NOBODY else', async () => {
    // ═══════════════════════════════════════════════════════════════════════
    // AN UNSPENT POINT IS INTENT, AND INTENT IS VIEWER-PRIVATE.
    // ═══════════════════════════════════════════════════════════════════════
    //
    // The same argument that made cooldowns private (protocol.ts): "Ren is
    // holding a point back" is a decision she has not made yet, and a party
    // panel that showed everyone's banked points would turn a private judgement
    // into a queue of people telling each other what to buy. `ProgressMsg` is a
    // `ViewerMsg`, so `broadcast(progress)` does not COMPILE — this test is the
    // runtime half, proving nothing routes around the type.
    server = await boot('spend-progress-private');
    playsThe(WATCHMAN);
    const ren = await connect(server.port);
    const alex = await connect(server.port);
    const renBody = bodyOf(await ren.hello('ren-handle'));
    await alex.hello('alex-handle');
    renBody.unspentPoints = 3;
    await ren.settle();
    await alex.settle();
    ren.clear();
    alex.clear();

    ren.send({ t: 'spend_point', talentId: 'talent:lockdown' });
    await ren.settle();
    await alex.settle();

    const progress = ren.last('progress');
    expect(progress?.['unspent']).toBe(2);
    expect(progress?.['level']).toBe(renBody.level);
    expect(alex.all('progress')).toHaveLength(0);
    expect(alex.all('loadout')).toHaveLength(0);
  });

  it('says which talent went up, and says it to the whole room', async () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE ONE CHOICE THAT MATTERS WAS THE ONLY SILENT ONE.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * MEASURED, driving a Watchman to level 2 and spending the point: the panel
     * changed and the Record lane said nothing. Every other beat narrates
     * itself — *"Player 1 takes up as The Watchman."*, *"Player 1 reaches level
     * 2."*, *"A talent point to spend."*, even *"Reinforced Watchman's Boots
     * on. Armour 6 -> 10."* for a pair of boots — while the irreversible
     * decision about who this character IS produced no line at all.
     *
     * ═══ AND IT IS THE ROOM'S LINE, WHICH IS THE HALF WORTH PINNING ═══
     * The test directly above proves `progress` reaches the spender and NOBODY
     * else, because an unspent point is intent and intent is private. A spent
     * one is the opposite: it is a fact about a body the party is standing next
     * to and is about to watch in use. Getting that backwards is silent either
     * way — a Margin line would look correct to the person who pressed the
     * button and vanish for everyone else — so the assertion that matters is
     * ALEX's, not Ren's.
     */
    server = await boot('spend-says-so');
    playsThe(WATCHMAN);
    const ren = await connect(server.port);
    const alex = await connect(server.port);
    const renBody = bodyOf(await ren.hello('ren-handle'));
    await alex.hello('alex-handle');
    renBody.unspentPoints = 3;
    await ren.settle();
    await alex.settle();
    ren.clear();
    alex.clear();

    ren.send({ t: 'spend_point', talentId: 'talent:lockdown' });
    await ren.settle();
    await alex.settle();

    const linesOf = (client: Awaited<ReturnType<typeof connect>>): string[] =>
      client
        .all('log')
        .flatMap((frame) => (frame['lines'] ?? []) as { text?: string }[])
        .map((line) => String(line.text ?? ''));

    expect(linesOf(ren).join(' | '), 'the spender was told nothing').toMatch(
      /trains Lockdown to rank \d+\./,
    );
    expect(linesOf(alex).join(' | '), 'the party watched it happen in silence').toMatch(
      /trains Lockdown to rank \d+\./,
    );
  });
});

// ===========================================================================
// 3. THE CLIENT/SERVER AGREEMENT — one range, both ends
// ===========================================================================

describe('the ring the client draws is the ring the server enforces', () => {
  it('sends Fog Step’s ranked range, and accepts a step at exactly it', async () => {
    // ═══════════════════════════════════════════════════════════════════════
    // ONE ASSERTION, BOTH ENDS OF THE WIRE, BECAUSE THERE IS ONE FUNCTION.
    // ═══════════════════════════════════════════════════════════════════════
    //
    // Fog Step is the only talent whose level buys DISTANCE instead of damage:
    // `combatTalentLimit(t, 10, 3, 7)` (mobility.lua:40-62), floored to
    // 3/4/5/6/7. `LoadoutTalent.range` and the range `canUseTalent` refuses
    // against are both `effectiveTalentRange(targeting, level)` — the same
    // exported function called from opposite sides — and this test pins the pair
    // rather than either alone, because either alone can be right while the two
    // disagree.
    //
    // THE FAILURE IT CATCHES: a class-constant 3 on the wire, so a rank-3
    // Inspector draws a three-tile ring around a talent the server would let her
    // step five. The points she spent do visibly nothing, which is precisely the
    // lie a levelup panel exists not to tell.
    server = await boot('spend-range-agreement');
    const ren = await connect(server.port);
    playsThe(INSPECTOR);
    const body = bodyOf(await ren.hello('ren-handle'));
    body.x = 5;
    body.y = 5;
    body.unspentPoints = 2;
    await ren.settle();
    ren.clear();

    ren.send({ t: 'spend_point', talentId: 'talent:fog_step' });
    ren.send({ t: 'spend_point', talentId: 'talent:fog_step' });
    await ren.settle();

    const wireRange = Number(rowFor(ren, 'talent:fog_step')?.['range']);
    // Rank 3 on the ported curve, THROUGH the Inspector's fieldcraft mastery
    // (1.15) — so the effective rank is 3.45 and the ring is one tile wider
    // than the ungraded curve gives. Spelled out so the port is pinned here
    // too, not merely round-tripped; the number moved when the tree was graded
    // and that is the change being recorded.
    expect(wireRange).toBe(6);
    ren.clear();

    // THE SERVER'S OWN ANSWER, at exactly the distance it just advertised. A
    // legal submission produces no `error`; the step itself resolves in the
    // pump and is somebody else's test.
    ren.send({ t: 'talent', talentId: 'talent:fog_step', target: { x: 5 + wireRange, y: 5 } });
    await ren.settle();
    expect(ren.all('error')).toHaveLength(0);

    // …and one tile beyond it is refused, with the code that says "close in"
    // rather than the one that says "back away".
    body.x = 5;
    body.y = 5;
    // The cast above put the talent on cooldown; this branch is about RANGE, and
    // `submitTalent` checks the authoritative gate before it queues, so the
    // cooldown would mask the answer. Clearing it keeps the claim about the one
    // rule being tested.
    body.cooldowns.clear();
    ren.clear();
    ren.send({ t: 'talent', talentId: 'talent:fog_step', target: { x: 5 + wireRange + 1, y: 5 } });
    await ren.settle();
    expect(ren.last('error')?.['code']).toBe('out_of_range');
  });
});

// ===========================================================================
// 4. THE ROUND TRIP — a level is worth nothing if its effect does not come back
// ===========================================================================

describe('progression survives a snapshot and a restore', () => {
  it('brings back level, xp, points and BOTH per-talent ranks — effect included', async () => {
    // ═══════════════════════════════════════════════════════════════════════
    // RESTORING THE NUMBER BUT NOT THE EFFECT IS THE FAILURE THIS CATCHES.
    // ═══════════════════════════════════════════════════════════════════════
    //
    // A restore that wrote `level = 6` and `talentPoints` onto a body but let
    // `attachClass` run AFTERWARDS would look completely correct in the save
    // file and completely correct in the panel — and Fog Step would still step
    // three tiles, because `TalentEngine.attach` ends in an unconditional
    // `sheets.set` and would have thrown the ranks away without a word. So the
    // final assertion is not about a number at all: it is about the RANGE THE
    // SERVER ACTUALLY ACCEPTS on the restored body.
    //
    // THE LEDGER IS THE SECOND CLAIM. `unspentPoints` is a CACHE, and
    // `applyRestore` recomputes it as `totalPointsAtLevel(level)` minus every
    // raw point SPENT — where spent is `raw - 1`, because the first rank of each
    // of the four is the birth grant nobody paid for. A level-6 Inspector with
    // two points in Fog Step and two in Sniper's Mark has spent 2 of the 5 the
    // ledger grants, so 3 come back in hand.
    server = await boot('round-trip-a');
    const first = await connect(server.port);
    playsThe(INSPECTOR);
    const body = bodyOf(await first.hello('ren-handle'));
    body.level = 6;
    body.xp = 42;
    body.unspentPoints = totalPointsAtLevel(6);
    first.clear();

    first.send({ t: 'spend_point', talentId: 'talent:fog_step' });
    first.send({ t: 'spend_point', talentId: 'talent:snipers_mark' });
    await first.settle();
    expect(body.unspentPoints).toBe(totalPointsAtLevel(6) - 2);

    // THE SNAPSHOT, taken by the gateway itself on the immediate flush the
    // spend triggered — not a hand-built literal, so what is carried forward is
    // whatever `snapshotPlayers` really writes.
    const filed = server.saves.flushes.at(-1)?.snapshots.find((s) => s.actorId === body.id);
    expect(filed?.level).toBe(6);
    expect(filed?.xp).toBe(42);
    expect(filed?.talentPoints?.['talent:fog_step']).toBe(2);
    expect(filed?.talentPoints?.['talent:snipers_mark']).toBe(2);
    await server.close();

    // ═══ A FRESH WORLD, A FRESH PROCESS'S WORTH OF STATE ═══
    server = await boot('round-trip-b');
    server.saves.restore = {
      hp: null,
      cooldowns: {},
      classId: INSPECTOR.id,
      level: filed?.level,
      xp: filed?.xp,
      // DELIBERATELY WRONG, so the reconciliation is proved rather than
      // coincidentally satisfied: the ledger must win over the file's cache.
      unspentPoints: 99,
      talentPoints: filed?.talentPoints,
    };

    const second = await connect(server.port);
    const restored = bodyOf(await second.hello('ren-handle'));
    expect(restored.level).toBe(6);
    expect(restored.xp).toBe(42);
    // 5 granted by levels 2..6, minus 2 spent. The 99 in the file is ignored.
    expect(restored.unspentPoints).toBe(totalPointsAtLevel(6) - 2);
    expect(server.talents.sheetOf(restored.id)?.points.get('talent:fog_step')).toBe(2);
    expect(server.talents.sheetOf(restored.id)?.points.get('talent:snipers_mark')).toBe(2);

    // AND THE PANEL AGREES, off the frames the restored socket actually got.
    expect(second.last('progress')?.['level']).toBe(6);
    expect(second.last('progress')?.['unspent']).toBe(totalPointsAtLevel(6) - 2);
    const rows = loadoutRows(second);
    expect(rows.find((r) => r['id'] === 'talent:fog_step')?.['level']).toBe(2);

    // ═══ THE ONE THAT MATTERS: THE EFFECT CAME BACK, NOT ONLY THE NUMBER ═══
    // Rank 2 is a four-tile step. The server accepting exactly four proves the
    // restored rank reached `canUseTalent`, which is the only place it can have
    // any consequence at all.
    restored.x = 6;
    restored.y = 6;
    second.clear();
    second.send({ t: 'talent', talentId: 'talent:fog_step', target: { x: 10, y: 6 } });
    await second.settle();
    expect(second.all('error')).toHaveLength(0);
  });

  it('refunds the points of a talent id this build no longer gives the body', async () => {
    // ═══════════════════════════════════════════════════════════════════════
    // docs/data-schemas.md § 1: "If a talent id disappears, the load path moves
    // its points to a `refundPool` and logs it rather than throwing. Friends'
    // saves must outlive your content edits."
    // ═══════════════════════════════════════════════════════════════════════
    //
    // There is no pool object and no second piece of arithmetic, and that is the
    // design rather than a shortcut: a vanished id never lands on the sheet, so
    // it is never counted as SPENT, so the ledger hands its points back as
    // unspent automatically. This test is what proves the two halves add up —
    // without the refund the player would be permanently short, which is the
    // exact loss the paragraph exists to prevent.
    server = await boot('round-trip-refund');
    server.saves.restore = {
      hp: null,
      cooldowns: {},
      classId: INSPECTOR.id,
      level: 6,
      xp: 0,
      unspentPoints: 0,
      talentPoints: {
        // Four ranks bought on a talent that no longer exists — 3 points spent.
        'talent:removed_in_a_later_build': 4,
        'talent:fog_step': 2,
      },
    };

    const ren = await connect(server.port);
    const body = bodyOf(await ren.hello('ren-handle'));

    // The surviving talent kept its rank...
    expect(server.talents.sheetOf(body.id)?.points.get('talent:fog_step')).toBe(2);
    // ...the vanished one was not seeded onto the sheet...
    expect(server.talents.sheetOf(body.id)?.points.has('talent:removed_in_a_later_build')).toBe(
      false,
    );
    // ...and its 3 points came back, so the character is 5 - 1 = 4 in hand
    // rather than 5 - 4 = 1. The file's stored 0 is ignored entirely.
    expect(body.unspentPoints).toBe(totalPointsAtLevel(6) - 1);
  });

  it('leaves the birth defaults alone when the port cannot say', async () => {
    // ═══ ABSENT IS NOT ZERO, AND THE DISTINCTION IS THE WHOLE SAFETY NET ═══
    // The SHIPPED `createCharacterBridge.openCharacter` still returns only
    // `{hp, cooldowns, classId}` — the four progression fields are `?` on
    // `CharacterRestore` precisely so that an implementation which predates them
    // reads as "this port cannot say" rather than as "this character is level
    // 1". Read the other way round, the first `hello` of the evening would file
    // a level-8 detective down to 1 and the ledger would then confiscate every
    // point they had spent.
    server = await boot('round-trip-silent-port');
    server.saves.restore = { hp: 40, cooldowns: {}, classId: WATCHMAN.id };

    const ren = await connect(server.port);
    const body = bodyOf(await ren.hello('ren-handle'));

    expect(body.level).toBe(1);
    expect(body.xp).toBe(0);
    expect(body.unspentPoints).toBe(0);
    expect(server.talents.sheetOf(body.id)?.points.get('talent:crude_blow')).toBe(1);
  });
});
