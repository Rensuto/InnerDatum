import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import Fastify from 'fastify';

import {
  WATCHMAN,
  classById,
  createContentTalentEngine,
  createTalentBook,
  sheetForClass,
} from '../../src/server/content/classes.ts';
import { AiProfile } from '../../src/server/engine/actor.ts';
import { DamageType } from '../../src/server/engine/damage.ts';
import { stepProjectile } from '../../src/server/engine/projectile.ts';
import { talentId } from '../../src/server/engine/talents.ts';
import { talentRuntimeFor } from '../../src/server/main.ts';
import { sustainAnswer, toggleSustain } from '../../src/server/engine/talents.ts';
import { EffectId, createMvpEffectState } from '../../src/server/content/effects.ts';
import { effectsOn, statusApplier } from '../../src/server/engine/effects.ts';
import type { EffectState } from '../../src/server/engine/effects.ts';
import { wsGateway } from '../../src/server/net/gateway.ts';
import { createTurnEngine } from '../../src/server/turn-engine.ts';
import { createWorld } from '../../src/server/world/world.ts';
import { TileCode } from '../../src/shared/protocol.ts';
import { RestStop } from '../../src/shared/rest.ts';
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

/**
 * An open lane with nothing blocking a shot — row 1 of the test map is clear
 * from x=1 to x=28.
 *
 * IT WAS ROW 17 UNTIL FOV, and the move is not cosmetic. The spawn block sits
 * at rows 2-3, so row 17 is about fifteen tiles from where the player stands —
 * inside the sight radius while that was (wrongly) 20, and outside it at
 * upstream's real 10. Every orb in this suite then flew where nobody could see
 * it, and seven tests about the gateway's MEMO started failing for a reason
 * that had nothing to do with memos.
 *
 * Row 1 is adjacent to the spawn and equally clear, so the shots are watched
 * rather than merely fired. The player is never ON it, so nothing here is hit.
 */
const LANE_Y = 1;

/** The Watchman's at-will swing, and the Alchemist's heal he must not be able to press. */
const CRUDE_BLOW = talentId('crude_blow');
const SHIN_CRACK = talentId('shin_crack');
const MEND_WOUNDS = talentId('mend_wounds');

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
    // A stub world where nothing regenerates and nothing threatens: rest ends
    // immediately with nothing gained, which is the honest answer for a fake.
    rest: () => ({ turns: 0, stop: RestStop.Done }),
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
  /**
   * THE STATUS TABLE THE GATEWAY PROJECTS FROM. Optional because only the live
   * harness builds one -- the stub gateway has no engine to apply anything.
   */
  readonly effects?: EffectState;
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
        // NO `sourceId`. `fire` names a shooter that was never added to the
        // world, and since FOV the field is REDACTED when the viewer cannot see
        // the body it names — a phantom is the strongest case of that. The frame
        // is still sent, because an orb is gated on ITS OWN tile and never on
        // its shooter: a shot out of the dark is the one thing a player most
        // needs to see. See `ProjectileView.sourceId`.
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
        // NO `sourceId`. `fire` names a shooter that was never added to the
        // world, and since FOV the field is REDACTED when the viewer cannot see
        // the body it names — a phantom is the strongest case of that. The frame
        // is still sent, because an orb is gated on ITS OWN tile and never on
        // its shooter: a shot out of the dark is the one thing a player most
        // needs to see. See `ProjectileView.sourceId`.
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

    // v10. The envelope is pinned here rather than in a version test of its own
    // because this is the file that drives a real socket end to end, so a client
    // bundle that disagreed would fail here first. Every bump that produced this
    // number was forced by the same rule — an old client would be confidently
    // WRONG rather than merely missing something. 6 -> 7: `projectiles` is an
    // addition a v6 client cannot name, so it draws no orb while the damage
    // still lands three turns later out of nowhere. 7 -> 8: a v7 client cannot
    // name `class_options`, so it draws no picker, plays as the rotation class —
    // and that rotation is WRITTEN TO DISK on `saveNow('join')`, after which the
    // chooser never appears again. A one-way door, which is why the addition
    // forced a bump on its own.
    //
    // 8 -> 9 IS THE "EXISTING FIELD NARROWS" SHAPE, the same one that forced
    // 1 -> 2 (`left`) and 4 -> 5 (`alive`), and it is the ONE reason the bump
    // rests on: `LoadoutTalent.range` stopped being a constant of the CLASS and
    // became per-actor, resolved at the caster's own talent level. A v8 client
    // reads Fog Step's 3 and draws a three-tile ring for a rank-5 Inspector the
    // server would let step seven, so the points she spent do visibly nothing —
    // a field it already knows how to read, now silently meaning something
    // narrower. The v9 ADDITIONS (`level`/`maxLevel`/`desc`/`descNext`, the
    // `progress` frame, the `spend_point` verb) are all things a v8 client can
    // simply ignore and would NOT have forced this on their own;
    // src/shared/version.ts keeps that argument to one reason on purpose, and
    // no new `ErrorCode` was added for exactly the same discipline.
    //
    // ═══ 9 -> 10, AND THE JUSTIFICATION MOVES WITH THE NUMBER ═══
    // This comment's own house rule, so it is restated rather than appended to.
    // The v10 ADDITIONS force nothing on their own and are named here only to be
    // ruled out: four inbound verbs (`pickup`/`equip`/`unequip`/`drop`) narrow
    // nothing a v9 client sends — `respawn` set that precedent at v5 — and the
    // `inventory` frame is one an old client cannot name and therefore ignores,
    // which is the definition of an addition it can survive. No `TurnEvent`
    // variant and no `ErrorCode` member were added either, and both of those
    // would have forced a bump independently.
    //
    // WHAT FORCES IT IS THE `ground` FRAME, AND IT IS THE PERMANENTLY-STUCK
    // SHAPE that forced 5 -> 6 rather than the merely-missing shape. A v9 client
    // cannot name `ground`, so it draws no floor item — AND it has no verb to
    // take one, so there is no way for the player to discover the frame is
    // missing by acting. Both halves fail at once, and the party divides loot
    // around them in voice while their screen says the floor is empty.
    //
    // Independently, and on the 8 -> 9 shape above: once gear composes onto the
    // combat sheet, `ActorView.maxHp` and `InspectView.rows` stop being facts
    // about a CLASS and become facts about a class PLUS its gear. A field a v9
    // client already knows how to read, now silently meaning something narrower.
    // THE ABSOLUTE PIN LIVES IN test/shared/version.test.ts AND ONLY THERE.
    // It was duplicated here, and the duplicate did exactly what a duplicated
    // pin does: the 10 -> 11 bump for the overworld's `realm` frame broke a test
    // about the PROJECTILES frame, in a file that has nothing to say about
    // versioning. Two places to update is one place to forget, and a pin that
    // fails for an unrelated reason trains people to bump numbers without
    // reading the argument attached to them.
    //
    // What this test actually needs is the RELATIVE claim — that the frame on
    // the wire carries the version this build compiled against — which is a
    // real thing to get wrong here and is unaffected by any bump.
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

// ---------------------------------------------------------------------------
// ═══════════════════════════════════════════════════════════════════════════
//   THE HOTBAR ARRIVES, AND THE BUTTONS DO SOMETHING.
// ═══════════════════════════════════════════════════════════════════════════
//
// Everything above this line runs against a stub scheduler on purpose. These
// two claims cannot: they are about a joining body getting a CLASS and a
// `talent` frame reaching a real talent, which is the whole of what this
// milestone wired up. So this block builds what src/server/main.ts builds — a
// real turn engine, the content talent book, the resolution runtime and the
// class attacher — and asks the same questions from a socket.
//
// WHAT WAS BROKEN, PRECISELY. `main.ts` called `createTurnEngine({ world,
// downed, parties, log })` with no `talents` option, so the book defaulted to
// `EMPTY_TALENT_BOOK` — `loadoutOf: () => []`. `sendLoadout` returns early on an
// empty loadout ("an actor with no talents gets no hotbar rather than an empty
// one"), so the welcome frame set carried no `loadout`, no `cooldowns` and no
// `resource`, and every `talent` frame was refused as "no such talent in this
// loadout". Twelve written, cited, unit-tested talents, unreachable in play.
// ---------------------------------------------------------------------------

/** The real thing: the gateway that ships, wired the way main.ts wires it. */
async function bootLive(seed: string): Promise<Harness> {
  const app = Fastify({ logger: false });
  const world = createWorld(seed);
  world.level.tiles.fill(TileCode.FLOOR);

  const talents = createContentTalentEngine();
  // THE ROSTER, exactly as main.ts registers it — see the note there for the
  // literal that left three effects unregistered in the running game.
  const effects = createMvpEffectState();
  const engine = createTurnEngine({
    world,
    now: () => 0,
    talents: createTalentBook(talents, world),
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * WITH THE STATUS SEAM, which this harness also used to leave out.
     *
     * Talents apply statuses through `ctx.status?.(...)` -- OPTIONAL, so a
     * runtime built without it lets every status talent run to completion and
     * apply nothing. Shin Crack swings, deals damage, logs, and the slow simply
     * does not exist.
     *
     * Third gap of the same shape in this one harness, after `toggleSustain`
     * and `effects`. Every one of them is a capability main.ts wires and the
     * tests did not, and every one hides a whole class of bug.
     */
    talentRuntime: talentRuntimeFor(talents, world, statusApplier(effects, world.rng)),
  });

  await app.register(wsGateway, {
    world,
    engine: {
      ...engine,
      // The lines main.ts writes. The gateway may not import engine/talents.ts —
      // it states its engine contract structurally — so the capability is
      // injected by whoever can see both sides.
      attachClass: (actorId: string, classId: string): void => {
        const definition = classById(classId);
        if (definition !== undefined) talents.attach(actorId, sheetForClass(definition));
      },
      /**
       * ═══════════════════════════════════════════════════════════════════════
       * AND THE STANCE SEAM, WHICH THIS HARNESS USED TO LEAVE OUT.
       * ═══════════════════════════════════════════════════════════════════════
       *
       * `handleTalent` asks this about EVERY talent frame before it reaches
       * `submitTalent`, because a stance and a cast arrive on the same key.
       * `engine.toggleSustain?.(...)` — optional — so a harness that omits it
       * answers `undefined` for free and every cast sails through.
       *
       * Production is not so lucky. main.ts collapsed every refusal to `null`,
       * which the gateway reads as "it is a stance and it cannot go up", so
       * NO ACTIVE TALENT IN THE GAME COULD BE CAST — for fifty commits, live,
       * while the Crude Blow test below passed on every run.
       *
       * A seam only production has is a seam nothing tests. This harness now
       * carries it, and shares `sustainAnswer` with the server so the mapping
       * under test is the mapping that ships.
       */
      toggleSustain: (actorId: string, talentId: string): boolean | null | undefined => {
        const sheet = talents.sheetOf(actorId);
        if (sheet === undefined) return undefined;
        return sustainAnswer(toggleSustain(talents, sheet, talentId));
      },
    },
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE STATUS TABLE, WHICH THIS HARNESS ALSO USED TO LEAVE OUT.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `broadcastEffectsIfChanged` returns on its first line when `effects` is
     * absent, so a harness without it can never see a badge — and a talent that
     * applies a status looks identical to one that does not.
     *
     * The same shape as the missing `toggleSustain`: production wires it, the
     * harness did not, and the gap is exactly where a bug lives unseen.
     */
    effects,
    talentEffects: talents,
    disconnectGraceMs: 30_000,
  });
  await app.listen({ host: '127.0.0.1', port: 0 });

  const address = app.server.address();
  if (address === null || typeof address === 'string') throw new Error('no port was bound');

  return {
    port: address.port,
    world,
    // THE STATUS TABLE THE GATEWAY PROJECTS FROM, so a test can check what the
    // server believes before asking what the socket was told. The two failing
    // separately is the whole point -- see the badge test at the foot of this file.
    effects,
    pending: { events: [] },
    close: async (): Promise<void> => {
      await app.close();
    },
  };
}

describe('the hotbar, on a server with the talent book wired in', () => {
  it('arrives in the welcome frame set instead of being skipped', async () => {
    server = await bootLive('gateway-hotbar');
    const client = await connect(server.port);
    await client.hello();

    // The loadout is unicast ONCE per connection, at `welcome`, because M3
    // loadouts are fixed. Nothing resends it — so a class attached one line
    // after `sendLoadout` would leave this socket with no hotbar until it
    // reconnected.
    const loadout = await client.waitFor('loadout');
    const talents = loadout?.['talents'];
    if (!Array.isArray(talents)) throw new Error('the loadout frame carried no talents');

    // The first fresh join takes the first place in the rotation.
    expect(talents.map((row: { id?: unknown }) => String(row.id))).toEqual(
      WATCHMAN.loadout.map((talent) => talent.id),
    );

    // …and the two viewer-private frames that keep it honest come with it: the
    // cooldown map the buttons grey out from, and the resource the cost readout
    // turns orange against.
    expect(await client.waitFor('cooldowns')).toBeDefined();
    const resource = await client.waitFor('resource');
    expect((resource?.['resource'] as { kind?: unknown } | undefined)?.kind).toBe('resolve');
  });

  it('resolves a `talent` frame into a `used` event for the whole room', async () => {
    // ═══ THE FRAME THE WHOLE MILESTONE HANGS OFF ═══
    // `handleTalent` decides nothing: it hands the request to `submitTalent`,
    // which defers to the book's `check` (the one implementation of "may this be
    // used"), and the pump resolves it through the runtime. What comes back out
    // is the FX stamp — public, because everyone watching should see the
    // Watchman swing — followed by the ordinary attack/damage triple.
    server = await bootLive('gateway-talent');
    const client = await connect(server.port);
    const welcome = await client.hello();

    const ren = server.world.getActor(String(welcome?.['selfId']));
    if (ren === undefined) throw new Error('the welcome named no body');
    ren.x = 10;
    ren.y = 10;
    server.world.addMonster('m_husk', {
      name: 'Index Husk',
      sprite: 'enemy_index_husk_s',
      x: 11,
      y: 10,
      profile: AiProfile.MeleeChaser,
      maxHp: 200,
    });
    client.clear();

    client.send({ t: 'talent', talentId: CRUDE_BLOW, target: { x: 11, y: 10 } });
    const used = await client.waitFor('used');

    expect(used).toBeDefined();
    const event = used?.['ev'];
    expect((event as { talentId?: unknown } | undefined)?.talentId).toBe(CRUDE_BLOW);
    expect((event as { id?: unknown } | undefined)?.id).toBe(ren.id);
    // No refusal came back on the same socket — the submission gate accepted it.
    expect(client.all('error')).toEqual([]);
  });

  it('refuses a talent that is not in this body’s four, with `bad_message`', async () => {
    // M3 loadouts are FIXED, so a frame naming the Alchemist's heal on a
    // Watchman was hand-crafted rather than clicked — and `bad_message` says
    // exactly that rather than dressing it up as a game rule. The refusal is
    // UNICAST: the room does not need to know what somebody tried to press.
    server = await bootLive('gateway-talent-refused');
    const client = await connect(server.port);
    await client.hello();
    client.clear();

    client.send({ t: 'talent', talentId: MEND_WOUNDS });
    const error = await client.waitFor('error');

    expect(error?.['code']).toBe('bad_message');
    expect(client.all('used')).toEqual([]);
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *   A STATUS THAT LANDS MUST REACH THE SCREEN.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `tools/status-live.mjs` pressed a slowing talent against a live server, the
 * server's own Case Log said *"Index Cairn is slowed for 3 turns"*, and the
 * socket received THREE `effects` frames before the press and three after. The
 * status was applied and the client was never told.
 *
 * A badge nobody can see is a debuff nobody can play around, which is the whole
 * value of the six statuses this game now has.
 */
describe('a landed status reaches the socket as a badge', () => {
  it('sends an effects frame carrying the badge the cast just applied', async () => {
    server = await bootLive('gateway-badge');
    const client = await connect(server.port);
    const welcome = await client.hello();

    const ren = server.world.getActor(String(welcome?.['selfId']));
    if (ren === undefined) throw new Error('the welcome named no body');
    ren.x = 10;
    ren.y = 10;
    const husk = server.world.addMonster('m_husk', {
      name: 'Index Husk',
      sprite: 'enemy_index_husk_s',
      x: 11,
      y: 10,
      profile: AiProfile.MeleeChaser,
      maxHp: 400,
      // A BODY THAT CANNOT SAVE. The slow is rolled against a physical save like
      // every status in this game, and a husk with ordinary stats shrugs it off
      // often enough to make this test a coin flip about the wrong thing. What
      // is under test is whether a LANDED status reaches the socket.
      combat: { stats: { str: 1, dex: 1, con: 1, wil: 1, cun: 1, mag: 1 } },
    });
    client.clear();

    /**
     * SHIN CRACK, because it slows and a Watchman is born knowing it. Crude
     * Blow would prove the cast path and nothing about the status pipeline.
     */
    client.send({ t: 'talent', talentId: SHIN_CRACK, target: { x: 11, y: 10 } });
    await client.waitFor('used');

    // THE SERVER'S OWN TABLE FIRST, so a failure below cannot be blamed on the
    // talent having quietly done nothing.
    expect(
      effectsOn(server.effects ?? createMvpEffectState(), husk.id).map((e) => e.effectId),
      'the slow never landed on the server at all',
    ).toContain(EffectId.Slowed);

    const frame = await client.waitFor('effects');
    expect(frame, 'no effects frame followed the cast').toBeDefined();
    const rows = (frame?.['actors'] ?? []) as { id: string; effects: { id: string }[] }[];
    const onHusk = rows.find((row) => row.id === husk.id);
    expect(
      onHusk,
      'the effects frame named every body except the one that was slowed',
    ).toBeDefined();
    expect(onHusk?.effects.map((e) => e.id)).toContain(EffectId.Slowed);
  });
});
