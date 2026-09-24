// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

import { setTimeout as sleep } from 'node:timers/promises';

import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { createContentTalentEngine, createTalentBook } from '../../src/server/content/classes.ts';
import { AiProfile, HOLD_INTENT, isPlayer } from '../../src/server/engine/actor.ts';
import { BELL_MS, createBarrier, inQuorum } from '../../src/server/engine/barrier.ts';
import { createDownedState, goDown } from '../../src/server/engine/downed.ts';
import { createPartyState, partyIdOf } from '../../src/server/engine/party.ts';
import { talentRuntimeFor } from '../../src/server/main.ts';
import { wsGateway } from '../../src/server/net/gateway.ts';
import { createTurnEngine } from '../../src/server/turn-engine.ts';
import { createWorld } from '../../src/server/world/world.ts';
import { ENERGY_TO_ACT } from '../../src/shared/energy.ts';
import { TileCode } from '../../src/shared/protocol.ts';
import { COMMAND_GAP_MS, PROTOCOL_VERSION } from '../../src/shared/version.ts';
import { attachClassFor } from '../helpers/attach-class.ts';
import type { Barrier } from '../../src/server/engine/barrier.ts';
import type { DownedState } from '../../src/server/engine/downed.ts';
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
  readonly downed: DownedState;
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
 * `talentRuntimeFor` are what `buildServer` wires — so every rule these cases
 * drive is the one a player meets.
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
    downed,
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

  // THE ORDER, SET RATHER THAN ROLLED: A then B, then the husk. A party's
  // turns go in initiative order (`ensureInitiative`, engine/scheduler.ts),
  // which keeps a roll it finds, so every case below is about the rule and
  // not about which way a seed fell. The roll itself is pinned further down.
  h.world.turn.engagement = 3;
  a.body.initiative = 20;
  b.body.initiative = 10;
  for (const body of h.world.allActors()) if (!isPlayer(body)) body.initiative = 1;

  // A's first step is A's turn, so it resolves.
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
    // AND NAMES IT: it is B's turn, and the frame says so in one field.
    expect(frame?.['current']).toBe(b.id);
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

  it('holds a move sent out of turn until its slot, then plays both in order', async () => {
    const { h, a, b } = await strangersEngaged('cross-party-order');
    await waitUntil(() => h.engine.turnState().current === b.id, "B's turn");
    const ya = a.body.y;
    const yb = b.body.y;

    // A HAS ALREADY HAD THIS ROUND'S TURN, so A's next step waits behind B.
    await step(a, 's');
    expect(a.body.y).toBe(ya);
    expect(h.engine.turnState().current).toBe(b.id);

    // B takes theirs, and the queue drains in order: B, then A.
    await step(b, 'n');
    await waitUntil(() => b.body.y === yb - 1 && a.body.y === ya + 1, 'both steps to resolve');
  });

  it('hands the next player in line a fresh count on screen, not the rest of the last one’s', async () => {
    const { h, a, b } = await strangersEngaged('cross-party-fresh');
    // B holds, and the next round opens on A.
    await waitUntil(() => h.engine.turnState().current === b.id, "B's turn");
    await sleep(COMMAND_GAP_MS);
    b.client.send({ t: 'hold' });
    await waitUntil(() => h.engine.turnState().current === a.id, "A's turn again");

    // A thinks for a second and a half of real time — the gateway's clock...
    await sleep(1_500);
    const turn = h.world.turn.clock.gameTurn;
    await step(a, 's');
    // ...and B, next in the SAME game turn, is handed the whole count. Keyed on
    // the game turn alone, the gateway gave B what was left of A's.
    await waitUntil(() => b.client.latest('turn')?.['current'] === b.id, "B's turn on B's screen");
    expect(h.world.turn.clock.gameTurn, 'the fixture crossed a game turn').toBe(turn);
    const bellMs = b.client.latest('turn')?.['bellMs'];
    expect(typeof bellMs).toBe('number');
    expect(bellMs as number).toBeGreaterThan(BELL_MS.Normal - 1_000);
  });

  it('does not strand a queued move when the party ahead of it wipes and the floor resets', async () => {
    const { h, a, b } = await strangersEngaged('cross-party-wipe');
    // A THIRD STRANGER, LAST IN LINE, whose command is the pump below: a downed
    // player's own commands are refused before anything is pumped.
    const c = await seat(h, 20, 5);
    c.body.initiative = 5;
    await waitUntil(() => h.engine.turnState().current === b.id, "B's turn");
    const ya = a.body.y;

    // A queues a step behind B...
    await step(a, 's');
    expect(a.body.pendingIntent).not.toBeNull();
    // ...and B's party goes down in full. The next pump wipes it, stands B up
    // at the head of the line while the realm is still flagged in a fight, and
    // only then resets the floor and ends the fight.
    b.body.hp = 0;
    b.body.alive = false;
    goDown(h.downed, b.body, h.world.turn.clock.gameTurn);

    // C's hold is the pump, and it queues behind B like A's step. A must move
    // on it without pressing anything: the wipe stands B up at the head of the
    // line, but on a clock `resetFloorParty` zeroed, and A's queued step is at
    // the threshold — so A goes, and the realm is never parked on a party that
    // is about to be reset.
    await sleep(COMMAND_GAP_MS);
    c.client.send({ t: 'hold' });
    await waitUntil(() => a.body.y === ya + 1, "A's queued step to resolve after the reset");
    // THE PREMISE: B's party really did wipe and stand back up.
    expect(b.body.alive).toBe(true);
  });
});

describe('one player alone', () => {
  it('moves the world on every step and never runs a clock — ToME`s solo loop', async () => {
    /**
     * ═══ ONE STEP, ONE TURN, NO PASS — `useEnergy`, engines/default/engine/Actor.lua:478-484 ═══
     * A lone player in combat used to be parked after a step with movement
     * points left (the open round), and only Space, a third action or a
     * two-minute Solo Bell moved the world. Driven over the real socket: a
     * single `move` frame spends the turn, the game clock advances, and the
     * player owes the next decision with NO countdown on them — ten minutes
     * later they have still not been passed or benched.
     */
    const h = await boot('cross-party-solo');
    const a = await seat(h, 5, 8);
    husk(h, 12, 14);

    const y0 = a.body.y;
    await step(a, 's');
    expect(a.body.y).toBe(y0 + 1);
    await waitUntil(
      () => h.engine.turnState().whoseTurn.includes(a.id),
      'A to owe a decision again',
    );
    expect(h.world.turn.engagement).toBeGreaterThan(0);
    expect(inQuorum(a.body)).toBe(true);
    expect(h.world.allActors().filter((body) => isPlayer(body))).toHaveLength(1);

    // THE STEP WAS THE TURN: the clock moved without a commit, and a second
    // step moves it again.
    const turnBefore = h.world.turn.clock.gameTurn;
    await sleep(COMMAND_GAP_MS);
    await step(a, 's');
    expect(a.body.y).toBe(y0 + 2);
    await waitUntil(
      () => h.world.turn.clock.gameTurn > turnBefore,
      'the world to move on the step alone',
    );

    // AND NO CLOCK, EVER.
    expect(h.engine.turnState().bellDurationMs).toBeNull();
    h.clock.skewMs = 10 * 60_000;
    h.engine.bellExpired();
    expect(a.body.pendingIntent, 'a lone player was auto-passed').toBeNull();
    expect(a.body.standingBy, 'a lone player was benched').toBe(false);
  });
});
