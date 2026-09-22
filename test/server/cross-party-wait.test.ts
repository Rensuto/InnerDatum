// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

import { setTimeout as sleep } from 'node:timers/promises';

import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { createContentTalentEngine, createTalentBook } from '../../src/server/content/classes.ts';
import { AiProfile, HOLD_INTENT, isPlayer } from '../../src/server/engine/actor.ts';
import { BELL_MS, createBarrier, inQuorum } from '../../src/server/engine/barrier.ts';
import { createDownedState } from '../../src/server/engine/downed.ts';
import { accept, createPartyState, invite, partyIdOf } from '../../src/server/engine/party.ts';
import { talentRuntimeFor } from '../../src/server/main.ts';
import { wsGateway } from '../../src/server/net/gateway.ts';
import { createTurnEngine } from '../../src/server/turn-engine.ts';
import { createWorld } from '../../src/server/world/world.ts';
import { ENERGY_TO_ACT } from '../../src/shared/energy.ts';
import { TileCode } from '../../src/shared/protocol.ts';
import { COMMAND_GAP_MS, PROTOCOL_VERSION } from '../../src/shared/version.ts';
import { attachClassFor } from '../helpers/attach-class.ts';
import type { Barrier } from '../../src/server/engine/barrier.ts';
import type { PlayerActor } from '../../src/server/engine/actor.ts';
import type { PartyState } from '../../src/server/engine/party.ts';
import type { World } from '../../src/server/world/world.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * STRANGERS IN ONE ENGAGED REALM SHARE ITS WAIT — AND NOW ITS BELL AND STRIP.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * THE RULING THIS FILE PINS FIRST. In combat, everyone in one realm waits on
 * everyone in it, party or not: by D-A4 "the turn barrier stay[s] realm-wide", and
 * world/realms.ts keeps strangers out of one fight by instancing it per party
 * rather than by scoping the barrier. Nothing pinned it until this file —
 * turn-clock.test.ts counts game turns, which a mutant that stops strangers
 * blocking leaves unchanged.
 *
 * WHAT WAS BROKEN ON TOP OF IT, fixed 2026-09-22 (`PumpCtx.parties` in
 * engine/scheduler.ts has the whole account):
 *
 *   THE BELL WAS PER PARTY WHILE THE WAIT WAS PER REALM. An idle stranger, a
 *   party of one, sat on the two-minute Solo Bell while the gateway's timer
 *   ran the twenty-second Normal one and found nothing due, and the held
 *   player's strip said `whoseTurn: []`. About two minutes a step, twice.
 *
 *   THE ROUND TAIL NEVER FIRED ON ITS OWN. Nothing armed a timer for it, so an
 *   open round beside one idle player — two blockers, so no Bell — waited for a
 *   keypress, in one party as much as in two.
 *
 * ═══ OVER A REAL SOCKET, WITH THE ENGINE'S CLOCK IN THE TEST'S HAND ═══
 * The engine reads `Date.now() + skewMs`; the gateway's own timers run on the
 * wall clock. So a twenty-second Bell is exercised by moving `skewMs` and
 * calling `engine.bellExpired()`, which is exactly what the gateway's timer
 * does when it fires — and the six-second tail, which is the claim about the
 * gateway's timer itself, is left to the wall clock and waited for.
 *
 * EVERY CASE ASSERTS ITS SETUP BEFORE ITS CLAIM: whose party each body is in,
 * that combat is armed, and that both bodies are in the quorum. A case whose
 * fixture quietly lost one of those would otherwise pass for the wrong reason.
 */

const FRAME_TIMEOUT_MS = 4_000;

type Frame = Record<string, unknown>;

type Client = {
  send(frame: Frame): void;
  hello(): Promise<string>;
  latest(type: string): Frame | undefined;
  close(): void;
};

const openClients: Client[] = [];
const openApps: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const client of openClients) client.close();
  openClients.length = 0;
  for (const close of openApps) await close();
  openApps.length = 0;
});

/** Poll for a condition the server reaches synchronously inside a frame handler. */
async function waitUntil(check: () => boolean, what: string, ms = FRAME_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

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
    send(frame: Frame): void {
      socket.send(JSON.stringify({ v: PROTOCOL_VERSION, ...frame }));
    },
    async hello(): Promise<string> {
      client.send({ t: 'hello' });
      const deadline = Date.now() + FRAME_TIMEOUT_MS;
      for (;;) {
        const id = frames.find((f) => f['t'] === 'welcome')?.['selfId'];
        if (typeof id === 'string') return id;
        if (Date.now() >= deadline) throw new Error('no welcome came back');
        await sleep(5);
      }
    },
    latest(type: string): Frame | undefined {
      return [...frames].reverse().find((f) => f['t'] === type);
    },
    close(): void {
      socket.close();
    },
  };
  openClients.push(client);
  return client;
}

type Harness = {
  readonly port: number;
  readonly world: World;
  readonly engine: ReturnType<typeof createTurnEngine>;
  readonly barrier: Barrier;
  readonly parties: PartyState;
  /** Added to `Date.now()` by the ENGINE's clock only. The gateway's timers do not see it. */
  readonly clock: { skewMs: number };
  /** Gives a body a real class sheet, the way production's `attachClass` does. */
  readonly attachClass: (actorId: string, classId: string) => void;
};

/**
 * One floor, all of it walkable, behind a real gateway. The single-world build:
 * no realm registry, so no shared realm and no `assertNoCombatInSharedSpace`,
 * which is what a delve instance is to the barrier.
 *
 * THE PRODUCTION TALENT SEAMS, always — `createTalentBook` and
 * `talentRuntimeFor` are what `buildServer` wires — because an open round only
 * exists where `roundOpen` asks a real sheet. A body with no class attached has
 * no sheet, and `spendMove` then answers "free", which is the game as it shipped.
 */
async function boot(seed: string): Promise<Harness> {
  const world = createWorld(seed);
  world.level.tiles.fill(TileCode.FLOOR);
  const downed = createDownedState();
  const parties = createPartyState();
  const barrier = createBarrier();
  const clock = { skewMs: 0 };
  const talents = createContentTalentEngine();
  const engine = createTurnEngine({
    world,
    downed,
    parties,
    barrier,
    now: () => Date.now() + clock.skewMs,
    talents: createTalentBook(talents, world),
    talentRuntime: talentRuntimeFor(talents, world),
  });

  const app = Fastify({ logger: false });
  await app.register(wsGateway, { world, engine, parties, downed });
  await app.listen({ host: '127.0.0.1', port: 0 });
  openApps.push(async () => {
    await app.close();
  });
  const address = app.server.address();
  if (address === null || typeof address === 'string') throw new Error('no port was bound');

  return {
    port: address.port,
    world,
    engine,
    barrier,
    parties,
    clock,
    attachClass: attachClassFor(talents, world),
  };
}

type Seat = { readonly client: Client; readonly id: string; readonly body: PlayerActor };

/**
 * A player on a socket, standing at (x, y), ready to play.
 *
 * `hello` parks a new body on a standing hold for the class picker (the
 * gateway's `parkForClassChoice`), and a body on a standing order never
 * blocks — so every seat sends one `hold` first, which is the turn verb that
 * lifts the park. Out of combat that hold resolves and the level idles back to
 * everybody at `ENERGY_TO_ACT`.
 */
async function seat(h: Harness, x: number, y: number): Promise<Seat> {
  const client = await connect(h.port);
  const id = await client.hello();
  await sleep(COMMAND_GAP_MS);
  client.send({ t: 'hold' });
  await waitUntil(() => h.world.getActor(id)?.standingOrder === null, 'the class park to lift');
  const body = h.world.getActor(id);
  if (body === undefined || !isPlayer(body)) throw new Error('fixture: no player body');
  body.x = x;
  body.y = y;
  // Nothing here is about damage; a body that could die would end a case early.
  body.maxHp = 5_000;
  body.hp = 5_000;
  body.hpRegen = 0;
  return { client, id, body };
}

/** Something hostile that can see every seat, so the next pump arms combat. */
function husk(h: Harness, x: number, y: number): void {
  h.world.addMonster('m_husk', {
    name: 'Index Husk',
    sprite: 'enemy_index_husk_s',
    x,
    y,
    profile: AiProfile.MeleeChaser,
    maxHp: 5_000,
    aggroRange: 10,
  });
}

/**
 * One `move` frame, and back once the server has ruled on it — the body moved,
 * or the intent is pending. Both happen inside the frame's own handler, which
 * is synchronous, so either one means the pump that followed it is over.
 */
async function step(seatOf: Seat, dir: string): Promise<void> {
  const from = { x: seatOf.body.x, y: seatOf.body.y };
  await sleep(COMMAND_GAP_MS);
  seatOf.client.send({ t: 'move', dir });
  await waitUntil(
    () =>
      seatOf.body.x !== from.x || seatOf.body.y !== from.y || seatOf.body.pendingIntent !== null,
    `${seatOf.id}'s move to be ruled on`,
  );
}

/** The ids on a `turn` frame's strip, and the state each card is drawn in. */
function cards(frame: Frame | undefined): Record<string, unknown> {
  const rows = frame?.['actors'];
  if (!Array.isArray(rows)) return {};
  const out: Record<string, unknown> = {};
  for (const row of rows as Record<string, unknown>[]) out[String(row['id'])] = row['state'];
  return out;
}

function whoseTurnIn(frame: Frame | undefined): unknown[] {
  const ids = frame?.['whoseTurn'];
  return Array.isArray(ids) ? (ids as unknown[]) : [];
}

/**
 * TWO STRANGERS IN ONE ENGAGED ROOM, the active one having taken the move they
 * already had the energy for. Every setup claim the cases below rest on is
 * asserted here, before any of them is made.
 */
async function strangersEngaged(seed: string): Promise<{ h: Harness; a: Seat; b: Seat }> {
  const h = await boot(seed);
  const a = await seat(h, 5, 8);
  const b = await seat(h, 5, 20);
  husk(h, 12, 14);

  // TWO PARTIES OF ONE — nobody invited anybody.
  expect(partyIdOf(h.parties, a.id)).not.toBe(partyIdOf(h.parties, b.id));
  // B IS IDLE AND OWES A DECISION the moment combat arms: present, at the
  // threshold, nothing queued and no standing order.
  expect(b.body.energy).toBeGreaterThanOrEqual(ENERGY_TO_ACT);
  expect(b.body.pendingIntent).toBeNull();
  expect(b.body.standingOrder).toBeNull();

  // A's first step is the energy A already had, so it resolves either way.
  const y0 = a.body.y;
  await step(a, 's');
  expect(a.body.y).toBe(y0 + 1);

  // COMBAT IS ARMED and BOTH ARE IN THE QUORUM.
  expect(h.world.turn.engagement).toBeGreaterThan(0);
  expect(inQuorum(a.body)).toBe(true);
  expect(inQuorum(b.body)).toBe(true);
  return { h, a, b };
}

describe('two parties in one engaged realm', () => {
  it('holds the active player’s second step on an idle stranger — the ruling, pinned', async () => {
    const { h, a, b } = await strangersEngaged('cross-party-ruling');
    const y1 = a.body.y;

    // THE CLAIM. A's second step is waiting on B, who is in another party.
    await step(a, 's');
    expect(a.body.y).toBe(y1);
    expect(a.body.pendingIntent).not.toBeNull();
    // ...and it is B the realm is waiting on, not something else holding it.
    expect(h.engine.turnState().whoseTurn).toEqual([b.id]);
  });

  it('rings the idle stranger at the Normal Bell, and names them on the held player’s strip', async () => {
    const { h, a, b } = await strangersEngaged('cross-party-bell');
    const y1 = a.body.y;
    await step(a, 's');
    expect(a.body.pendingIntent).not.toBeNull();

    // THE HELD PLAYER SEES WHO THEY ARE WAITING ON. It said `whoseTurn: []`,
    // with no card for B, under a running countdown.
    await waitUntil(() => whoseTurnIn(a.client.latest('turn')).includes(b.id), "B on A's strip");
    const frame = a.client.latest('turn');
    expect(cards(frame)[b.id]).toBe('bell');
    expect(h.engine.turnState(a.id).whoseTurn).toEqual([b.id]);

    // THE REALM'S BELL: two in the quorum, so the Normal twenty seconds — on the
    // engine and on the gateway's countdown alike.
    expect(h.engine.turnState().bellDurationMs).toBe(BELL_MS.Normal);
    const bellMs = frame?.['bellMs'];
    expect(typeof bellMs).toBe('number');
    expect(bellMs as number).toBeLessThanOrEqual(BELL_MS.Normal);
    expect(bellMs as number).toBeGreaterThan(BELL_MS.Normal - FRAME_TIMEOUT_MS);

    // NOT YET, a second short of it...
    h.clock.skewMs = BELL_MS.Normal - 1_000;
    h.engine.bellExpired();
    expect(b.body.pendingIntent).toBeNull();

    // ...and HELD at twenty seconds. It was B's own two-minute Solo Bell.
    h.clock.skewMs = BELL_MS.Normal + 1_000;
    h.engine.bellExpired();
    expect(b.body.pendingIntent).toEqual(HOLD_INTENT);
    expect(h.barrier.autoPassesOf(b.id)).toBe(1);

    // AND A's STEP GOES THROUGH on the next pump. A's own keypress is what
    // pumps here — the gateway's timer would, twenty real seconds from now.
    await sleep(COMMAND_GAP_MS);
    a.client.send({ t: 'move', dir: 's' });
    await waitUntil(() => a.body.y === y1 + 1, "A's held step to resolve");
  });
});

describe('an open round closes on the gateway’s own timer', () => {
  it('closes a same-party round beside an idle member with nobody pressing a key', async () => {
    const h = await boot('cross-party-tail');
    const a = await seat(h, 5, 8);
    const b = await seat(h, 7, 8);
    h.attachClass(a.id, 'watchman');
    expect(invite(h.parties, a.id, b.id, Date.now()).ok).toBe(true);
    expect(accept(h.parties, b.id, a.id, Date.now()).ok).toBe(true);
    husk(h, 12, 14);

    // ONE PARTY.
    expect(partyIdOf(h.parties, a.id)).toBe(partyIdOf(h.parties, b.id));

    // A steps, and the step leaves A's round open: MP to spare, so A parks
    // mid-round with a tail six seconds out.
    await step(a, 's');
    expect(h.world.turn.engagement).toBeGreaterThan(0);
    expect(inQuorum(a.body)).toBe(true);
    expect(inQuorum(b.body)).toBe(true);
    expect(a.body.roundActions).toBe(1);
    expect(a.body.roundTailMs).not.toBeNull();

    // TWO BLOCKERS, SO NO BELL — the Bell's timer cannot be what rescues this.
    const open = h.engine.turnState();
    expect([...open.whoseTurn].sort()).toEqual([a.id, b.id].sort());
    expect(open.acting).toEqual([a.id]);
    expect(open.bellDurationMs).toBeNull();
    expect(open.roundTailInMs ?? null).not.toBeNull();

    // THE CLAIM. Nobody sends anything; the gateway's timer comes back for the
    // tail, the pump holds A, and A's round closes.
    const tailInMs = (a.body.roundTailMs ?? 0) - Date.now();
    await waitUntil(() => a.body.roundActions === 0, "A's round to close", tailInMs + 4_000);
    expect(a.body.roundTailMs).toBeNull();

    // The world now waits on B alone — the last straggler, so the Bell is on.
    const after = h.engine.turnState();
    expect(after.whoseTurn).toEqual([b.id]);
    expect(after.bellDurationMs).toBe(BELL_MS.Normal);
  });

  /**
   * AND ACROSS TWO PARTIES, which is where the tail's quorum has to be the
   * realm's. A stranger stopped mid-round beside an idle stranger is two
   * blockers in one realm: no Bell, so only the tail can move the floor. A tail
   * that counted each PARTY's quorum saw a party of one there and never fired,
   * and the floor waited for a keypress (measured in review: four stalls).
   */
  it('closes a STRANGER’s round beside an idle stranger the same way', async () => {
    const h = await boot('cross-party-tail-strangers');
    const a = await seat(h, 5, 8);
    const b = await seat(h, 7, 8);
    h.attachClass(a.id, 'watchman');
    husk(h, 12, 14);

    // TWO PARTIES OF ONE — nobody invited anybody.
    expect(partyIdOf(h.parties, a.id)).not.toBe(partyIdOf(h.parties, b.id));

    await step(a, 's');
    expect(h.world.turn.engagement).toBeGreaterThan(0);
    expect(inQuorum(a.body)).toBe(true);
    expect(inQuorum(b.body)).toBe(true);
    expect(a.body.roundActions).toBe(1);
    expect(a.body.roundTailMs).not.toBeNull();

    const open = h.engine.turnState();
    expect([...open.whoseTurn].sort()).toEqual([a.id, b.id].sort());
    expect(open.bellDurationMs).toBeNull();
    expect(open.roundTailInMs ?? null).not.toBeNull();

    const tailInMs = (a.body.roundTailMs ?? 0) - Date.now();
    await waitUntil(() => a.body.roundActions === 0, "A's round to close", tailInMs + 4_000);
    expect(a.body.roundTailMs).toBeNull();
    expect(h.engine.turnState().whoseTurn).toEqual([b.id]);
  });
});

describe('one player alone', () => {
  it('is on the two-minute Solo Bell, exactly as before', async () => {
    const h = await boot('cross-party-solo');
    const a = await seat(h, 5, 8);
    husk(h, 12, 14);

    const y0 = a.body.y;
    await step(a, 's');
    expect(a.body.y).toBe(y0 + 1);
    // The world ran on until A owed a decision again: combat armed, A in the
    // quorum and the only one in it.
    await waitUntil(
      () => h.engine.turnState().whoseTurn.includes(a.id),
      'A to owe a decision again',
    );
    expect(h.world.turn.engagement).toBeGreaterThan(0);
    expect(inQuorum(a.body)).toBe(true);
    expect(h.world.allActors().filter((body) => isPlayer(body))).toHaveLength(1);

    expect(h.engine.turnState().bellDurationMs).toBe(BELL_MS.Solo);
    await waitUntil(() => typeof a.client.latest('turn')?.['bellMs'] === 'number', 'the Bell');
    expect(a.client.latest('turn')?.['bellMs'] as number).toBeGreaterThan(BELL_MS.Normal);

    // Twenty seconds is nothing to somebody playing alone...
    h.clock.skewMs = BELL_MS.Normal + 1_000;
    h.engine.bellExpired();
    expect(a.body.pendingIntent).toBeNull();

    // ...and two minutes holds them.
    h.clock.skewMs = BELL_MS.Solo + 1_000;
    h.engine.bellExpired();
    expect(a.body.pendingIntent).toEqual(HOLD_INTENT);
  });
});
