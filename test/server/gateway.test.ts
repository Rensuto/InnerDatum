import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import Fastify from 'fastify';

import { DamageType } from '../../src/server/engine/damage.ts';
import { stepProjectile } from '../../src/server/engine/projectile.ts';
import { wsGateway } from '../../src/server/net/gateway.ts';
import { createWorld } from '../../src/server/world/world.ts';
import { PROTOCOL_VERSION } from '../../src/shared/version.ts';
import type { Projectile } from '../../src/server/engine/projectile.ts';
import type { PumpResult, TurnEngine } from '../../src/server/net/gateway.ts';
import type { TurnState } from '../../src/server/view/projector.ts';
import type { World } from '../../src/server/world/world.ts';
import type { TileXY } from '../../src/shared/coords.ts';
import type { TurnEvent } from '../../src/shared/protocol.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE `projectiles` FRAME, AT THE SEAM THAT DECIDES WHETHER IT IS SENT AT ALL.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A travelling orb is the first thing in this game that exists for several
 * turns, moves on its own, and has to be VISIBLE the whole time — because the
 * counterplay is "see it coming and step off the tile", and a shot the player
 * cannot see is just a slower version of the instant hit it replaced.
 *
 * The projection itself is pinned in test/server/projector.test.ts. THIS file is
 * about the gateway's half, which is entirely about WHEN a frame goes out:
 *
 *   NOTHING WHEN THE SKY IS CLEAR. A server whose roster never fires an orb
 *   must send byte-for-byte the frame set it sent before the feature existed,
 *   and an idle pump must cost one string compare.
 *
 *   ONE FRAME PER CHANGE, AND NONE PER NON-CHANGE. The memo is what keeps a
 *   three-turn object from becoming a per-pump stream, and it is only legal
 *   because the frame is a complete snapshot.
 *
 *   ABSENCE MEANS LANDED. An impact is the orb missing from the next list. There
 *   is no "removed" patch and there must never be one — a client that dropped it
 *   would hold a phantom orb forever.
 *
 *   AND A RECONNECT SEES THE SKY. `welcome` carries the level and the actors,
 *   and an orb is neither; the memo would suppress the broadcast because
 *   everyone else has already been told. Without a unicast on that path a player
 *   rejoining mid-flight is the one person in the room who cannot see the shot.
 *
 * ═══ WHY THE ENGINE IS A STUB AND THE WORLD IS REAL ═══
 * `TurnEngine` is injected precisely so this is possible (see its note in
 * gateway.ts — "a test can register this plugin against a fake scheduler"). The
 * claims here are about the gateway's memo and its send sites, and driving them
 * through the real scheduler would mean arranging a fight, a barrier and an
 * energy clock in order to observe a string comparison — every assertion would
 * then also be a hostage to monster AI. So the orbs are put in the REAL world by
 * hand, flown with the REAL `stepProjectile`, and every pump is a fixed point.
 */

/** How long a `waitFor` waits before deciding a frame is never coming. */
const FRAME_TIMEOUT_MS = 2_000;

/** Row 17 of the test map is open floor from x=1 to x=28 — nothing blocks a shot. */
const LANE_Y = 17;

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
  /**
   * PUMP THE SERVER AND WAIT UNTIL EVERYTHING IT SENT HAS ARRIVED.
   *
   * A `move` is the cheapest frame that reaches `pumpAndBroadcast`; the stub
   * engine accepts it and advances nothing, so what comes back is exactly the
   * snapshot band and nothing else.
   *
   * The `ping` afterwards is the ORDERING BARRIER, and it is what makes
   * "no frame was sent" a testable claim rather than a race with a timeout: the
   * socket delivers in order and the gateway answers `ping` synchronously
   * without pumping, so once `pong` is in hand every frame the move produced is
   * already in `frames`.
   */
  pump(): Promise<void>;
  waitFor(type: string, timeoutMs?: number): Promise<Frame | undefined>;
  /** Every frame of one type, in arrival order. */
  all(type: string): Frame[];
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
    async pump() {
      client.send({ t: 'move', dir: 'e' });
      client.send({ t: 'ping' });
      const pong = await client.waitFor('pong');
      if (pong === undefined) throw new Error('the server never answered the ordering ping');
    },
    waitFor,
    all(type: string): Frame[] {
      return frames.filter((frame) => frame['t'] === type);
    },
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
// The server: a real world, and an engine that does nothing at all
// ---------------------------------------------------------------------------

/**
 * A scheduler that accepts everything and advances nothing.
 *
 * EVERY PUMP IS A FIXED POINT — `idle`, no events, no refusals — so the only
 * thing that can differ between two pumps is what the test itself changed in the
 * world. `bellDurationMs: null` keeps the Bell disarmed, which matters because
 * an armed Bell is a `setTimeout` that would outlive the test.
 */
function stubEngine(pending: Pending): TurnEngine {
  const turn: TurnState = {
    gameTurn: 4,
    engagement: 0,
    whoseTurn: [],
    committed: [],
    standingBy: [],
    bellDurationMs: null,
  };
  const drain = (): PumpResult => {
    const playerEvents = pending.events;
    pending.events = [];
    return { status: 'idle', turn, playerEvents, sweep: [], refusals: [] };
  };

  return {
    join: () => undefined,
    leave: () => undefined,
    setConnected: () => undefined,
    submitMove: () => ({ ok: true }),
    submitTalent: () => ({ ok: false, code: 'illegal_move', reason: 'no talents in this build' }),
    loadoutOf: () => [],
    resourceOf: () => undefined,
    commit: () => ({ ok: true }),
    hold: () => ({ ok: true }),
    bellExpired: () => undefined,
    // Accepts unconditionally, because the claim under test is about what the
    // gateway sends AFTER a success and not about who is allowed to ask.
    submitRespawn: () => ({ ok: true }),
    pump: drain,
    turnState: () => turn,
  };
}

/**
 * Events the NEXT pump will report, and then forget.
 *
 * One field, mutable, so a test can say "somebody goes down on the next pump"
 * without a fight: the three survival events are the ones `needsFullResync`
 * watches for, and that branch is the second place a `projectiles` frame is
 * sent.
 */
type Pending = { events: TurnEvent[] };

type Harness = {
  readonly port: number;
  readonly world: World;
  readonly pending: Pending;
  close(): Promise<void>;
};

async function boot(seed: string): Promise<Harness> {
  const app = Fastify({ logger: false });
  const world = createWorld(seed);
  const pending: Pending = { events: [] };
  await app.register(wsGateway, {
    world,
    engine: stubEngine(pending),
    disconnectGraceMs: 30_000,
  });
  await app.listen({ host: '127.0.0.1', port: 0 });

  const address = app.server.address();
  if (address === null || typeof address === 'string') throw new Error('no port was bound');

  return {
    port: address.port,
    world,
    pending,
    close: async (): Promise<void> => {
      await app.close();
    },
  };
}

let server: Harness;

beforeEach(async () => {
  server = await boot('gateway-projectiles');
});

afterEach(async () => {
  for (const client of openClients) client.close();
  openClients.length = 0;
  await server.close();
});

/** One orb in the air, fired east along the open lane. */
function fire(from: TileXY, to: TileXY, projSpeed = 2): Projectile {
  return server.world.addProjectile({
    sourceId: 'mon_a',
    origin: from,
    to,
    projSpeed,
    range: 10,
    damage: { dam: 5, type: DamageType.Physical, apr: 0 },
  });
}

/** The orb list off one `projectiles` frame, as plain rows a test can read. */
function orbs(frame: Frame | undefined): unknown[] {
  const list = frame?.['projectiles'];
  if (!Array.isArray(list)) throw new Error('that frame carried no projectiles array');
  return list;
}

// ---------------------------------------------------------------------------

describe('the projectiles frame', () => {
  it('is never sent while the sky is clear', async () => {
    // ═══ THE NO-REGRESSION TEST FOR EVERY EXISTING SERVER ═══
    // Absence is the client's default, so an empty frame would be a frame that
    // says what its recipient already believes — on every pump, forever, on a
    // roster where one creature in three can fire. The memo is seeded with the
    // empty key for exactly this.
    const client = await connect(server.port);
    await client.hello();
    client.clear();

    await client.pump();
    await client.pump();

    expect(client.all('projectiles')).toEqual([]);
  });

  it('announces the first orb in the air, once', async () => {
    const client = await connect(server.port);
    await client.hello();
    client.clear();

    const proj = fire({ x: 2, y: LANE_Y }, { x: 8, y: LANE_Y });
    await client.pump();

    const sent = client.all('projectiles');
    expect(sent).toHaveLength(1);
    expect(orbs(sent[0])).toEqual([
      {
        id: proj.id,
        x: 2,
        y: LANE_Y,
        sourceId: 'mon_a',
        targetX: 8,
        targetY: LANE_Y,
        // Six tiles at two tiles a game turn. TURNS, never milliseconds.
        turnsToImpact: 3,
      },
    ]);
  });

  it('says nothing on a pump where the orb did not move — the memo', async () => {
    // ═══ THIS IS THE PHASE LOCK, SEEN FROM THE WIRE ═══
    // An orb freezes while the party deliberates (it is skipped the moment
    // anybody is parked at the barrier), so "in the air and unchanged" is not an
    // edge case — it is what every orb does for as long as the humans take. If
    // that state cost a frame per pump, a three-turn object would become a
    // per-keystroke stream to every socket in the room.
    const client = await connect(server.port);
    await client.hello();
    fire({ x: 2, y: LANE_Y }, { x: 8, y: LANE_Y });

    await client.pump();
    expect(client.all('projectiles')).toHaveLength(1);

    client.clear();
    await client.pump();
    await client.pump();
    expect(client.all('projectiles')).toEqual([]);
  });

  it('sends a fresh frame the moment the orb has moved', async () => {
    const client = await connect(server.port);
    await client.hello();
    const proj = fire({ x: 2, y: LANE_Y }, { x: 8, y: LANE_Y });

    await client.pump();
    client.clear();

    // The real flight code, not a hand-written cursor: the orb is born holding a
    // full turn of energy, so one `act` moves it one tile.
    stepProjectile(proj, server.world);
    await client.pump();

    const sent = client.all('projectiles');
    expect(sent).toHaveLength(1);
    expect(orbs(sent[0])).toEqual([
      {
        id: proj.id,
        x: 3,
        y: LANE_Y,
        sourceId: 'mon_a',
        targetX: 8,
        targetY: LANE_Y,
        // Five tiles left at two a turn, rounded UP: a partial turn is still a
        // turn the player gets to act in.
        turnsToImpact: 3,
      },
    ]);
  });

  it('reports an impact as the orb GONE, never as a patch', async () => {
    // ═══ ABSENCE IS THE ONLY SPELLING OF "IT LANDED" ═══
    // The blow itself is an ordinary `attack` step attributed to the shooter, so
    // there is no `projectile_landed` event and there must never be one: a
    // one-frame event for a three-turn object is a second source of truth for
    // the same fact, and the frame that survives a dropped packet is the
    // snapshot. What the client receives is a list that no longer has the orb
    // in it, which is also exactly what it receives if it missed every earlier
    // frame — the two are indistinguishable ON PURPOSE.
    const client = await connect(server.port);
    await client.hello();
    const proj = fire({ x: 2, y: LANE_Y }, { x: 8, y: LANE_Y });

    await client.pump();
    client.clear();

    // What `actProjectile` does the instant an orb detonates: out of the air
    // before anything else looks at the world.
    server.world.removeProjectile(proj.id);
    await client.pump();

    const sent = client.all('projectiles');
    expect(sent).toHaveLength(1);
    expect(orbs(sent[0])).toEqual([]);

    // And the clear sky is now the baseline again: no repeat frames.
    client.clear();
    await client.pump();
    expect(client.all('projectiles')).toEqual([]);
  });

  it('shows the sky to somebody who has just arrived, and the memo cannot suppress it', async () => {
    // ═══ THE RECONNECT-MID-FLIGHT CASE ═══
    // The first client's pump has already broadcast this orb, so the memo holds
    // its key and the pump at the end of the newcomer's `hello` broadcasts
    // NOTHING. Their only sight of the shot is the unicast on the welcome path,
    // and `welcome` itself cannot carry it: that frame is the level and the
    // actors, and an orb is deliberately neither.
    const first = await connect(server.port);
    await first.hello();
    fire({ x: 2, y: LANE_Y }, { x: 8, y: LANE_Y });
    await first.pump();
    first.clear();

    const rejoined = await connect(server.port);
    const welcome = await rejoined.hello();

    // v7. `projectiles` is an addition a v6 client cannot name, so it draws no
    // orb while the damage still lands three turns later out of nowhere — which
    // is not "less UI", it is confidently wrong UI, and it is what forced the
    // bump.
    expect(PROTOCOL_VERSION).toBe(7);
    expect(welcome?.['v']).toBe(PROTOCOL_VERSION);

    const seen = await rejoined.waitFor('projectiles');
    expect(orbs(seen)).toHaveLength(1);
    // The people already in the room are told nothing: they can see it.
    expect(first.all('projectiles')).toEqual([]);
  });

  it('resends the sky with the board, because `state` carries no orb', async () => {
    // ═══ THE FULL-RESYNC PATH ═══
    // Down, up or erased: each swaps a SPRITE, and `sprite` travels only on
    // `ActorView`, so the gateway answers with the whole actor list. That frame
    // says nothing whatever about what is in the air — an orb is not an actor —
    // and the memo would suppress the ordinary snapshot because the list has not
    // changed. So the resync carries the sky with it, and the newly-restored
    // body is not the one person on the floor who cannot see the shot.
    const client = await connect(server.port);
    const welcome = await client.hello();
    const selfId = String(welcome?.['selfId']);
    fire({ x: 2, y: LANE_Y }, { x: 8, y: LANE_Y });

    await client.pump();
    client.clear();

    server.pending.events = [{ k: 'downed', id: selfId, turns: 5 }];
    await client.pump();

    // The board came, and the sky came with it — in that order, so a client
    // reads the corrected bodies before the objects flying between them.
    expect(client.all('state')).toHaveLength(1);
    const sky = client.all('projectiles');
    expect(sky).toHaveLength(1);
    expect(orbs(sky[0])).toHaveLength(1);

    // AND ONLY ONCE. The forced send updates the memo, so the snapshot band a
    // few lines later in the same pump says nothing — a resync must not be a way
    // to make the server send the same frame twice.
    client.clear();
    await client.pump();
    expect(client.all('projectiles')).toEqual([]);
  });

  it('resends the sky after a RESPAWN too — every `state` broadcast clears the client', async () => {
    // ═══ THE OTHER `state` SITE, AND THE MEMO MAKES IT WORSE ═══
    // src/client/main.ts's `case 'state'` runs `clearProjectiles()`, so ANY
    // `state` broadcast wipes the orb off every screen that receives it. There
    // are three sites: the full resync in `pumpAndBroadcast`, the rename in
    // `hello`, and `handleRespawn`. Only the first used to carry the sky.
    //
    // The memo then actively suppressed the correction rather than merely
    // failing to send it: `broadcastProjectilesIfChanged` compares against the
    // last thing BROADCAST, the orb list has not changed, so the pump that
    // follows sends nothing at all. The party stands there dodging a shot they
    // can no longer see — which is precisely the failure the whole feature is
    // meant to prevent.
    const client = await connect(server.port);
    await client.hello();
    fire({ x: 2, y: LANE_Y }, { x: 8, y: LANE_Y });

    await client.pump();
    client.clear();

    client.send({ t: 'respawn' });
    const sky = await client.waitFor('projectiles');

    expect(client.all('state')).toHaveLength(1);
    expect(orbs(sky)).toHaveLength(1);
    // ...and exactly once: the forced send updates the memo, so the snapshot
    // band in the pump a few lines later says nothing.
    expect(client.all('projectiles')).toHaveLength(1);
  });

  it('sends nothing extra to a newcomer when there is nothing in the air', async () => {
    // The other half of the welcome path. A join on a quiet floor must produce
    // the same frames it always did.
    const client = await connect(server.port);
    await client.hello();
    await client.pump();

    expect(client.all('projectiles')).toEqual([]);
  });
});
