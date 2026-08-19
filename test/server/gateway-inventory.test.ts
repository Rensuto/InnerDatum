import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';

import Fastify from 'fastify';

import {
  ALCHEMIST,
  WATCHMAN,
  classById,
  createContentTalentEngine,
  createTalentBook,
  sheetForClass,
} from '../../src/server/content/classes.ts';
import { ITEMS } from '../../src/server/content/items.ts';
import { moneyIdFor } from '../../src/server/content/money.ts';
import { talentRuntimeFor } from '../../src/server/main.ts';
import { wsGateway } from '../../src/server/net/gateway.ts';
import { createTurnEngine } from '../../src/server/turn-engine.ts';
import { createWorld } from '../../src/server/world/world.ts';
import { AiProfile } from '../../src/server/engine/actor.ts';
import { createDownedState, goDown, tickDowned } from '../../src/server/engine/downed.ts';
import { TALENT_MAX_LEVEL } from '../../src/shared/progression.ts';
import { ActorKind, TileCode } from '../../src/shared/protocol.ts';
import { PROTOCOL_VERSION } from '../../src/shared/version.ts';
import type { PlayerActor } from '../../src/server/engine/actor.ts';
import type { DownedState } from '../../src/server/engine/downed.ts';
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
 * THE FOUR LOOT VERBS: WHO MAY, WHAT THEY COST THE WORLD, AND WHAT SURVIVES A
 * SAVE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * This file is the third of its shape, after class-choice.test.ts and
 * gateway-progression.test.ts, and it leads with SECURITY for the same reason
 * both of those do: every one of these verbs writes to a body, and two of them
 * write to a SHARED floor that three to six people are standing on. The
 * ownership rule is a free-for-all — any party member on the tile may take
 * anything, first pickup wins — which is a DEVIATION with no upstream citation
 * (ToME is single-player; `Actor:die` calls `game.level.map:addObject` with no
 * owner and no party concept). A rule that permissive has to be exactly as tight
 * as it claims to be, and this file is where that is proved.
 *
 * ═══ THE EIGHT CLAIMS ═══
 *
 *   1. ALL FOUR SPEND A TURN, AND THEN PUMP. `inspect`, `choose_class` and
 *      `spend_point` are deliberately non-pumping — gateway-progression.test.ts
 *      argues that group on the grounds that "a player could bank a levelled
 *      talent AND a free monster turn from one click". Loot is the MIRROR: a
 *      free pickup lets somebody clear a room's floor mid-fight while every
 *      monster stands still.
 *
 *      TWO TESTS, BECAUSE THEY ARE TWO PROPOSITIONS AND ONE OF THEM SHIPPED
 *      BROKEN. The first proves `engine.pump()` is REACHED, with a non-pumping
 *      verb as the control — but its fixture zeroes `engagement` before every
 *      send, which is precisely the condition under which pumping and charging
 *      come apart. The second is the missing half: mid-fight, engagement up,
 *      the sender blocking, does the world's clock actually move? It did not.
 *      A pump does not charge anybody — `actPlayer` only reaches `spendTurn`
 *      when there is a pending intent — and a blocking sender makes `tickLevel`
 *      return `parked` at once, so the four verbs cost nothing AND moved
 *      nothing. `spendLootTurn` in gateway.ts is the fix; ToME charges on all
 *      four of these paths (Actor.lua:7323, :7352, :7420, Player.lua:1315).
 *
 *   2. NO FRAME CAN NAME A SUBJECT. All four schemas are `strictObject`, so a
 *      smuggled `actorId` is REJECTED rather than stripped into a legal frame —
 *      and a stripped `drop` would put somebody else's coat on the floor for the
 *      room to take.
 *
 *   3. AN ITEM IS RESOLVED AGAINST THE SENDER'S OWN BAG. An `equip` naming
 *      something a DIFFERENT player is holding is refused, and it is refused by
 *      the same lookup that refuses an id nobody holds — because there is no
 *      cross-inventory query in the handler for a forged id to reach into.
 *
 *   4. NO COORDINATE IS EVER READ FROM A FRAME. `pickup` carries no fields at
 *      all and the pile comes off the sender's own live x/y, which is strictly
 *      stronger than range-checking a supplied tile: there is nothing to forge.
 *
 *   5. DOUBLE-TAKE IS IMPOSSIBLE BY CONSTRUCTION. Two players on one tile both
 *      sending `pickup`: exactly one succeeds, the other gets a cheap refusal,
 *      and the item exists in exactly one place afterwards. Non-negotiable 2 —
 *      remove-from-floor and add-to-bag are one indivisible synchronous step —
 *      is what makes that true without a lock.
 *
 *   6. THE BAG HAS A FLOOR AND A CEILING. A full bag refuses a pickup and LEAVES
 *      THE ITEM WHERE IT IS; a body on the floor (Downed or Erased) is refused
 *      all four.
 *
 *   7. THE ROUND TRIP CARRIES THE EFFECT, NOT JUST THE NUMBER. The final
 *      assertion is not an id in a list: it is the ARMOUR ON THE CHARACTER
 *      SHEET, read back through the `inspect` path, which is the only place gear
 *      can have any consequence a player can see.
 *
 *   8. FINISHING CHARACTER CREATION DOES NOT UNDRESS YOU. `reclothePlayer` used
 *      to write `actor.combat` wholesale, so a player who equipped anything and
 *      then picked a class silently lost every contribution while the ids stayed
 *      in `equipped` and the panel went on drawing them.
 *
 * ═══ WHY IT DRIVES A REAL SOCKET ═══
 * Every claim is about the ORDER of private steps inside the gateway. Nothing
 * exports `handlePickup`, and the only place its behaviour is observable is the
 * frames a socket receives and the body it leaves behind. Only the disk is
 * faked, and it is faked as a PORT rather than as a directory because where the
 * bytes land is test/server/persist.test.ts's question.
 */

/** Snowflake-SHAPED, and nobody's real id. */
const REN_ID = '333333333333333333';
const ALEX_ID = '555555555555555555';

const FRAME_TIMEOUT_MS = 2_000;

/** The gateway's cap, restated here so a change to it fails a test rather than a player. */
const INVENTORY_CAP = 12;

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
 * THE PORT, NOT THE BRIDGE, exactly as gateway-progression.test.ts uses one:
 * what this file has to prove about persistence is what `snapshotPlayers` hands
 * over and what `restoreLoadout` does with what it is handed, and both are
 * observable at precisely this seam. Where the bytes land, and whether
 * `fileFor`/`openCharacter` carry the two fields in both directions, is
 * test/server/persist.test.ts's question and is answered there against the real
 * `createCharacterBridge`.
 */
type Recorder = {
  readonly flushes: { readonly reason: string; readonly snapshots: CharacterSnapshot[] }[];
  readonly queued: CharacterSnapshot[][];
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
  readonly downed: DownedState;
  readonly saves: Recorder;
  close(): Promise<void>;
};

/**
 * Boot the real gateway over the real engine.
 *
 * THE CLASS SEAMS ARE COPIED FROM src/server/main.ts, exactly as
 * gateway-progression.test.ts copies them and for the same reason:
 * `buildServer()` binds a port, reads `.env` and mounts static roots. Only
 * `attachClass` and the two talent-point seams are needed here — nothing in this
 * file is about talents, but `handleChooseClass` calls `attachClass` and claim 8
 * goes through it.
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
    downed,
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

/** The body behind a `welcome`, narrowed to a PLAYER — the only kind that carries. */
function bodyOf(welcome: Frame | undefined): PlayerActor {
  const id = String(welcome?.['selfId']);
  const actor = server.world.getActor(id);
  if (actor === undefined) throw new Error(`test fixture: no actor for ${id}`);
  if (actor.kind !== ActorKind.Player) throw new Error(`test fixture: ${id} is not a player`);
  return actor;
}

/**
 * "This account already plays the Watchman." Set BEFORE the `hello`.
 *
 * EVERY TEST HERE ARRIVES WITH A CLASS ON FILE except the one that is about the
 * chooser, and the reason is `snapshotPlayers`: a body in `classChoiceOwed` has
 * its loadout DELIBERATELY omitted from the snapshot, so a test that skipped
 * this and then asserted on `snapshot.carried` would be asserting against the
 * provisional-class rule and would read as a missing feature.
 */
function playsThe(definition: typeof WATCHMAN, over: Partial<CharacterRestore> = {}): void {
  server.saves.restore = { hp: null, cooldowns: {}, classId: definition.id, ...over };
}

/** Stand this body on a named tile. Placement is not what any of these tests is about. */
function standAt(body: PlayerActor, x: number, y: number): void {
  body.x = x;
  body.y = y;
}

/** The value of one row on the most recent `inspected` character sheet. */
function sheetRow(client: Client, label: string): string | undefined {
  const view = client.last('inspected')?.['view'];
  if (typeof view !== 'object' || view === null) return undefined;
  const rows = (view as Record<string, unknown>)['rows'];
  if (!Array.isArray(rows)) return undefined;
  const hit = (rows as Frame[]).find((row) => row['label'] === label);
  return hit === undefined ? undefined : String(hit['value']);
}

/** Ask the server what this body's own character sheet says, and wait for the answer. */
async function readSheet(client: Client, selfId: string): Promise<void> {
  client.send({ t: 'inspect', targetId: selfId });
  await client.settle();
}

/** Every id on the floor, whatever tile it is on. */
function floorIds(): string[] {
  return server.world.groundItems().map((item) => item.itemId);
}

// ===========================================================================
// 1. ALL FOUR PUMP
// ===========================================================================

describe('the four loot verbs advance the world', () => {
  it('pumps on every one of them, where a non-pumping verb does not', async () => {
    // ═══════════════════════════════════════════════════════════════════════
    // THE MIRROR OF THE NON-PUMPING GROUP'S ARGUMENT.
    // ═══════════════════════════════════════════════════════════════════════
    //
    // gateway-progression.test.ts pins `spend_point` as NON-pumping with "if it
    // pumped, a player could bank a levelled talent AND a free monster turn from
    // one click". Loot is the case that line was drawing the boundary against: a
    // FREE pickup lets a player clear a room's floor mid-fight while every
    // monster stands still, and unlike a talent point — bounded by levels earned
    // — the floor holds as many things as have died on it.
    //
    // `inspect` IS THE CONTROL, and it is what makes this a claim about the four
    // verbs rather than about the fixture: the same world, the same instant, one
    // frame that must not move the clock and four that must.
    server = await boot('loot-pumps');
    const ren = await connect(server.port);
    playsThe(WATCHMAN);
    const body = bodyOf(await ren.hello('ren-handle'));
    standAt(body, 10, 10);
    body.carried = ['item_watchmans_cap'];

    // THE WORLD NEEDS SOMETHING TO DO, or "it pumped" and "it did not" produce
    // identical worlds and the test proves nothing: with a lone player standing
    // still and out of combat, `pump` reaches its fixed point on the first tick
    // and returns `idle`. A husk on the floor is the slack, and it is also
    // exactly the thing the rule is about — the free MONSTER TURN a
    // non-pumping loot verb would hand out.
    const husk = server.world.addMonster('m_husk', {
      name: 'Index Husk',
      sprite: 'enemy_index_husk_s',
      x: 20,
      y: 20,
      profile: AiProfile.MeleeChaser,
      maxHp: 200,
    });
    await ren.settle();

    /**
     * Send one frame and answer "did the world move?".
     *
     * ═══ THE TWO RESETS ARE FIXTURE BOOKKEEPING AND NOT PART OF THE CLAIM ═══
     * AN IDLE PUMP IS A FIXED POINT — the gateway's own note says so: nothing
     * gained energy, nothing spent any, no clock advanced on the way out, which
     * is precisely what stops a client spamming frames from farming regeneration.
     * So the FIRST pump in a resting world does all the available work and the
     * next three would correctly do none, and four verbs in a row would be
     * measuring the first one only. Draining the husk's energy gives each verb
     * the same slack to consume; clearing engagement stops a fight that started
     * mid-test from parking the player at the barrier, where a pump is also
     * correctly a no-op.
     *
     * What is NOT reset is anything the handler touches. The claim is entirely
     * about whether `engine.pump()` was reached.
     */
    const moved = async (frame: Frame): Promise<boolean> => {
      server.world.turn.engagement = 0;
      husk.energy = 0;
      const tick = server.world.turn.clock.tick;
      const at = { x: husk.x, y: husk.y };
      ren.send(frame);
      await ren.settle();
      return server.world.turn.clock.tick > tick || husk.x !== at.x || husk.y !== at.y;
    };

    // THE CONTROL. A non-pumping verb, in this exact world, moves nothing.
    expect(await moved({ t: 'inspect', targetId: body.id })).toBe(false);

    // 1. `equip` — the item is in the bag, so this is a legal write.
    expect(await moved({ t: 'equip', itemId: 'item_watchmans_cap' })).toBe(true);
    expect(body.equipped?.['head']).toBe('item_watchmans_cap');

    // 2. `unequip` — back into the bag.
    expect(await moved({ t: 'unequip', slot: 'head' })).toBe(true);
    expect(body.equipped?.['head']).toBeUndefined();

    // 3. `drop` — onto the sender's own tile, never a tile from the frame.
    expect(await moved({ t: 'drop', itemId: 'item_watchmans_cap' })).toBe(true);
    expect(server.world.itemsAt(body.x, body.y)).toHaveLength(1);

    // 4. `pickup` — off it again.
    expect(await moved({ t: 'pickup' })).toBe(true);
    expect(body.carried).toEqual(['item_watchmans_cap']);
  });

  it('SENDS THE NEW PURSE after a coin pickup, which the memo key used to suppress', async () => {
    // ═══════════════════════════════════════════════════════════════════════
    // THE BUG THIS PINS, AND IT SHIPPED.
    // ═══════════════════════════════════════════════════════════════════════
    // A coin pile is not a bag entry — `handlePickup` credits `money` and puts
    // nothing in `carried` (content/money.ts says why). `inventoryKeyOf` hashed
    // `[carried, equipped]` and nothing else, so picking one up moved NEITHER
    // list, the key did not change, and `sendInventoryIfChanged` sent nothing:
    // the gold on the panel sat still until the player happened to pick up or
    // equip an item, at which point it jumped by however much they had earned
    // since.
    //
    // It is the exact failure a memo key is for — a frame suppressed because
    // the thing that changed was not in the key — and the rule it costs is
    // worth writing down: anything `InventoryMsg` CARRIES has to be in that
    // key, not merely anything the BAG carries.
    server = await boot('coin-frame');
    const ren = await connect(server.port);
    playsThe(WATCHMAN);
    const body = bodyOf(await ren.hello('ren-handle'));
    standAt(body, 10, 10);
    await ren.settle();

    const before = body.money;
    server.world.addGroundItem({ x: 10, y: 10 }, moneyIdFor(14));
    ren.clear();
    ren.send({ t: 'pickup' });
    await ren.settle();

    // The purse really moved...
    expect(body.money).toBe(before + 14);
    // ...and it never entered the bag, which is the whole reason the key missed.
    expect(body.carried ?? []).toEqual([]);
    // ...and the client was TOLD. Before the fix there was no inventory frame
    // here at all.
    const inventory = ren.last('inventory');
    expect(inventory).toBeDefined();
    expect(inventory?.['money']).toBe(before + 14);
  });

  it('CHARGES the sender a turn mid-fight, where pumping alone charges nothing', async () => {
    // ═══════════════════════════════════════════════════════════════════════
    // THE CLAIM THE TEST ABOVE CANNOT MAKE, AND THE BUG IT LET THROUGH.
    // ═══════════════════════════════════════════════════════════════════════
    // `moved()` zeroes `engagement` before every send, which is exactly the
    // condition under which the interesting failure happens — so it proves
    // "`engine.pump()` was reached" and nothing more. Pumping is NOT charging:
    // `actPlayer` (engine/scheduler.ts) only reaches `spendTurn` when the actor
    // has a pending intent, and mid-fight a sender holding full energy with a
    // null intent IS the blocking set (engine/barrier.ts `isBlocking`), so the
    // pump returned `parked` immediately. The verbs shipped costing nothing AND
    // moving nothing: a player at 5 hp put on a seven-piece kit between two
    // swings of a wraith that never got to swing.
    //
    // THIS TEST DELETES NOTHING. Engagement stays up, the husk keeps its energy,
    // and the only question asked is whether the world's clock moved — which,
    // with the sender blocking, it cannot do unless the verb spent their turn.
    server = await boot('loot-charges');
    const ren = await connect(server.port);
    playsThe(WATCHMAN);
    const body = bodyOf(await ren.hello('ren-handle'));
    standAt(body, 10, 10);
    body.carried = ['item_watchmans_cap'];

    // ADJACENT, so there is something in the level that wants a turn the moment
    // the barrier releases. Unbound: nothing below reads it, because what is
    // being measured is the CLOCK and not this monster's behaviour.
    server.world.addMonster('m_husk', {
      name: 'Index Husk',
      sprite: 'enemy_index_husk_s',
      x: 11,
      y: 10,
      profile: AiProfile.MeleeChaser,
      maxHp: 200,
    });
    await ren.settle();

    // THE FIGHT IS ON. This is the state the exploit lived in and it is left
    // exactly as it is for the rest of the test.
    server.world.turn.engagement = 3;
    const tickBefore = server.world.turn.clock.tick;
    const gameTurnBefore = server.world.turn.clock.gameTurn;

    // THE CONTROL, IN THE SAME WORLD AND THE SAME INSTANT: a non-charging verb.
    // It pumps nothing and charges nothing, and the clock proves the world is
    // genuinely parked on this player rather than merely quiet.
    ren.send({ t: 'inspect', targetId: body.id });
    await ren.settle();
    expect(server.world.turn.clock.tick).toBe(tickBefore);

    ren.send({ t: 'equip', itemId: 'item_watchmans_cap' });
    await ren.settle();

    // THE COAT IS ON — the verb still did its job.
    expect(body.equipped?.['head']).toBe('item_watchmans_cap');
    // AND IT WAS PAID FOR. The clock could not have moved while the sender was
    // blocking, so any advance at all is the turn being spent.
    expect(server.world.turn.clock.tick).toBeGreaterThan(tickBefore);
    expect(server.world.turn.clock.gameTurn).toBeGreaterThan(gameTurnBefore);
    // A WHOLE GAME TURN, MEASURED: tick 10 -> 20, gameTurn 1 -> 2, with
    // TICKS_PER_GAME_TURN of 10. NOT asserted through anybody's energy, and that
    // is worth writing down: by the time the pump returns, every actor is back
    // at the threshold (the loop runs on until the player blocks again), so an
    // energy reading at this instant says nothing at all about who acted. The
    // clock is the only honest witness here.
    //
    // AND THE FIGHT IS STILL ON, which is what makes the reading mean what it
    // says: if engagement had lapsed, the advance could have been the
    // out-of-combat fixed point re-accruing rather than a turn being spent.
    expect(server.world.turn.engagement).toBeGreaterThan(0);

    // ═══ AND IT IS PER VERB, NOT ONCE ═══
    // The second verb pays again. That is what stops the whole seven-piece kit
    // going on inside one turn: each swap is its own turn at the barrier, and
    // the wraith gets one swing for each.
    const afterFirst = server.world.turn.clock.gameTurn;
    ren.send({ t: 'unequip', slot: 'head' });
    await ren.settle();
    expect(body.equipped?.['head']).toBeUndefined();
    expect(server.world.turn.clock.gameTurn).toBeGreaterThan(afterFirst);
  });

  it('flushes the disk for the ONE-WAY DOOR and debounces the other three', async () => {
    // ═══════════════════════════════════════════════════════════════════════
    // ONE IMMEDIATE WRITE, THREE DEBOUNCED — AND THE SPLIT IS A CORRECTION.
    // ═══════════════════════════════════════════════════════════════════════
    // All four used to call `saveNow`, which snapshots EVERY player in the world
    // and writes one file per bound player with no coalescing at all
    // (`runExclusive` in persist/saves.ts chains, it does not replace). The
    // justification given was that the exposure equals `spend_point`'s and is
    // "bounded by the same 20/s token bucket" — but a bucket bounds the RATE and
    // not the TOTAL, and spends are finite where equip/unequip and drop/pickup
    // are a reversible pair that can be alternated forever. Six bound players
    // doing that is 120 atomic write-plus-rename cycles a second.
    //
    // `pickup` KEEPS the flush because it is the only one-way door: the floor is
    // never persisted, so an unsaved take DESTROYS the item. The other three
    // move an id between two persisted places, or onto a floor that dies with
    // the process either way — an un-flushed `drop` leaves the file still
    // claiming the item, which is a recovery and not a loss.
    server = await boot('loot-save-policy');
    const ren = await connect(server.port);
    playsThe(WATCHMAN);
    const body = bodyOf(await ren.hello('ren-handle'));
    standAt(body, 10, 10);
    server.world.addGroundItem({ x: 10, y: 10 }, 'item_watchmans_cap');

    const flushesBefore = server.saves.flushes.length;
    ren.send({ t: 'pickup' });
    await ren.settle();
    expect(body.carried).toEqual(['item_watchmans_cap']);
    // THE ONE-WAY DOOR IS ON DISK BEFORE ANYTHING ELSE HAPPENS.
    expect(server.saves.flushes.length).toBe(flushesBefore + 1);
    expect(server.saves.flushes.at(-1)?.reason).toBe('loot');

    // AND THE OTHER THREE TAKE THE QUEUE. Asserted as "no NEW flush" rather than
    // "no flush at all", because the pickup above legitimately produced one.
    const flushed = server.saves.flushes.length;
    for (const frame of [
      { t: 'equip', itemId: 'item_watchmans_cap' },
      { t: 'unequip', slot: 'head' },
      { t: 'drop', itemId: 'item_watchmans_cap' },
    ]) {
      const queued = server.saves.queued.length;
      ren.send(frame);
      await ren.settle();
      expect(server.saves.queued.length).toBe(queued + 1);
      expect(server.saves.flushes.length).toBe(flushed);
    }
  });

  it('sends the floor to everybody and the bag to nobody but its owner', async () => {
    // ═══════════════════════════════════════════════════════════════════════
    // TWO FRAMES, TWO UNIONS, AND THE SPLIT IS VISIBLE ON THE WIRE.
    // ═══════════════════════════════════════════════════════════════════════
    // `ground` is a `BroadcastMsg`: the pile is a POSITION, world state, and
    // everybody is looking at the same floor. `inventory` is a `ViewerMsg`:
    // `CarriedItemView.compare` is a delta against the RECIPIENT'S own doll, so
    // one shared copy would be arithmetically wrong for everybody but its
    // author — quite apart from telling the room what somebody is holding back.
    server = await boot('loot-frames');
    const ren = await connect(server.port);
    playsThe(WATCHMAN);
    const renBody = bodyOf(await ren.hello('ren-handle'));
    const alex = await connect(server.port);
    playsThe(WATCHMAN);
    const alexBody = bodyOf(await alex.hello('alex-handle'));
    standAt(renBody, 10, 10);
    standAt(alexBody, 12, 12);
    // THE COAT REACHES THE FLOOR THROUGH A VERB rather than through
    // `addGroundItem`, because the floor frame is a MEMO: a table written behind
    // the gateway's back is a change no pump ever saw, and the test would then
    // be asserting about a frame the server had no reason to send.
    renBody.carried = ['item_watchmans_coat'];
    await ren.settle();
    await alex.settle();
    ren.clear();
    alex.clear();

    ren.send({ t: 'drop', itemId: 'item_watchmans_coat' });
    await ren.settle();
    await alex.settle();

    // THE FLOOR REACHED BOTH OF THEM. Alex is two tiles away and is told about
    // it anyway — the pile is shared, unowned, and not FOV-gated, which is an
    // accepted leak riding the one `ProjectilesMsg` already carries.
    const dropped = (frame: Frame | undefined): unknown[] =>
      Array.isArray(frame?.['items']) ? (frame['items'] as unknown[]) : [];
    expect(dropped(ren.last('ground'))).toHaveLength(1);
    expect(dropped(alex.last('ground'))).toHaveLength(1);

    ren.clear();
    alex.clear();
    ren.send({ t: 'pickup' });
    await ren.settle();
    await alex.settle();

    // AND IT IS EMPTY AGAIN — complete and absolute, so the marker comes off
    // Alex's map through a frame that lists nothing rather than through a
    // "taken" message that does not exist.
    expect(ren.last('ground')?.['items']).toEqual([]);
    expect(alex.last('ground')?.['items']).toEqual([]);

    // THE BAG REACHED EXACTLY ONE OF THEM.
    const carried = ren.last('inventory')?.['carried'];
    expect(Array.isArray(carried) ? (carried as Frame[]).map((r) => r['itemId']) : []).toEqual([
      'item_watchmans_coat',
    ]);
    expect(alex.all('inventory')).toHaveLength(0);

    // AND THE TRANSCRIPT NAMED WHO TOOK IT. That line IS the ownership rule: the
    // pile is unowned and the fastest click wins, so the only thing that settles
    // an argument afterwards is a log everybody can read.
    const lines = ren
      .all('log')
      .flatMap((frame) => (Array.isArray(frame['lines']) ? (frame['lines'] as Frame[]) : []))
      .map((line) => String(line['text']));
    expect(lines.some((text) => text.includes("Ren picks up the Watchman's Coat"))).toBe(true);
  });
});

// ===========================================================================
// 2. SECURITY — the frame, the id, and the tile
// ===========================================================================

describe('no loot frame can name anybody but its sender', () => {
  it('REJECTS a smuggled actorId on all four verbs rather than stripping it', async () => {
    // ═══════════════════════════════════════════════════════════════════════
    // THE STRIP IS THE DANGEROUS FAILURE, NOT THE REJECTION.
    // ═══════════════════════════════════════════════════════════════════════
    // All four schemas are `strictObject`, so an unknown key is a parse ERROR.
    // Were they plain objects the extra key would be dropped and each frame
    // would become a perfectly legal verb against the SENDER's own body — a
    // `drop` that put somebody else's coat on the floor for the room to take,
    // with nothing in the log to say why.
    server = await boot('loot-strict');
    const ren = await connect(server.port);
    playsThe(WATCHMAN);
    const body = bodyOf(await ren.hello('ren-handle'));
    standAt(body, 10, 10);
    body.carried = ['item_watchmans_cap'];
    server.world.addGroundItem({ x: 10, y: 10 }, 'item_watchmans_coat');
    ren.clear();

    for (const frame of [
      { v: PROTOCOL_VERSION, t: 'pickup', actorId: 'actor_somebody_else' },
      { v: PROTOCOL_VERSION, t: 'equip', itemId: 'item_watchmans_cap', actorId: 'actor_else' },
      { v: PROTOCOL_VERSION, t: 'unequip', slot: 'head', actorId: 'actor_else' },
      { v: PROTOCOL_VERSION, t: 'drop', itemId: 'item_watchmans_cap', actorId: 'actor_else' },
    ]) {
      ren.sendRaw(frame);
    }
    await ren.settle();

    expect(ren.all('error')).toHaveLength(4);
    for (const error of ren.all('error')) expect(error['code']).toBe('bad_message');
    // NOTHING HAPPENED. Not the bag, not the doll, not the floor.
    expect(body.carried).toEqual(['item_watchmans_cap']);
    expect(body.equipped ?? {}).toEqual({});
    expect(floorIds()).toEqual(['item_watchmans_coat']);
  });

  it('REJECTS a hand-crafted pickup carrying a tile', async () => {
    // ═══════════════════════════════════════════════════════════════════════
    // THERE IS NO COORDINATE ON THE WIRE, SO THERE IS NO CHECK TO GET WRONG.
    // ═══════════════════════════════════════════════════════════════════════
    // `PickupSchema` is `{ v, t }`. protocol.ts's own note says a hand-crafted
    // frame from a devtools console is THE NORMAL CASE to design for; here there
    // is nothing to craft, which is strictly stronger than range-checking a
    // supplied tile — no off-by-one in an adjacency test can ever let somebody
    // reach across the room and take the coat a friend is standing over.
    server = await boot('loot-no-tile');
    const ren = await connect(server.port);
    playsThe(WATCHMAN);
    const body = bodyOf(await ren.hello('ren-handle'));
    standAt(body, 10, 10);
    // The coat is FAR AWAY, which is what the forged frame is reaching for.
    server.world.addGroundItem({ x: 20, y: 20 }, 'item_watchmans_coat');
    ren.clear();

    ren.sendRaw({ v: PROTOCOL_VERSION, t: 'pickup', x: 20, y: 20 });
    await ren.settle();

    expect(ren.last('error')?.['code']).toBe('bad_message');
    expect(body.carried ?? []).toEqual([]);
    expect(floorIds()).toEqual(['item_watchmans_coat']);
  });

  it('reads the pile from the BODY, so a pickup follows the body and never a frame', async () => {
    // ═══════════════════════════════════════════════════════════════════════
    // "THE HANDLER NEVER READS A COORDINATE FROM THE FRAME", PROVED POSITIVELY.
    // ═══════════════════════════════════════════════════════════════════════
    // The frame is byte-identical every time — it has no fields — so the only
    // thing that can decide WHICH pile is taken is the live x/y on the body the
    // session owns. Two identical frames, two different tiles, two different
    // items: the same input producing different output IS the proof that the
    // input is not where the answer comes from.
    server = await boot('loot-follows-body');
    const ren = await connect(server.port);
    playsThe(WATCHMAN);
    const body = bodyOf(await ren.hello('ren-handle'));
    server.world.addGroundItem({ x: 10, y: 10 }, 'item_watchmans_cap');
    server.world.addGroundItem({ x: 15, y: 15 }, 'item_watchmans_coat');

    standAt(body, 10, 10);
    ren.send({ t: 'pickup' });
    await ren.settle();
    expect(body.carried).toEqual(['item_watchmans_cap']);

    standAt(body, 15, 15);
    ren.send({ t: 'pickup' });
    await ren.settle();
    expect(body.carried).toEqual(['item_watchmans_cap', 'item_watchmans_coat']);

    // And standing nowhere near anything is a refusal rather than a reach.
    standAt(body, 3, 3);
    ren.clear();
    ren.send({ t: 'pickup' });
    await ren.settle();
    expect(ren.last('error')?.['code']).toBe('illegal_move');
  });

  it('refuses an equip naming an item ANOTHER player is holding', async () => {
    // ═══════════════════════════════════════════════════════════════════════
    // THERE IS NO CROSS-INVENTORY LOOKUP FOR A FORGED ID TO REACH INTO.
    // ═══════════════════════════════════════════════════════════════════════
    // The id is real, the frame is well formed, and zod accepts both —
    // deliberately, because baking the catalogue into the wire schema would make
    // every content edit a protocol change (`TalentSchema`'s stated precedent).
    // The ONLY thing refusing this is that the server resolves `itemId` against
    // THIS actor's own `carried`, so an id the sender does not hold is simply
    // not found in their own list. That is a stronger property than an ownership
    // CHECK: there is no query here that could be written to span two players.
    server = await boot('loot-cross-inventory');
    const ren = await connect(server.port);
    playsThe(WATCHMAN);
    const renBody = bodyOf(await ren.hello('ren-handle'));
    const alex = await connect(server.port);
    playsThe(WATCHMAN);
    const alexBody = bodyOf(await alex.hello('alex-handle'));

    alexBody.carried = ['item_watchmans_coat'];
    renBody.carried = [];
    ren.clear();

    ren.send({ t: 'equip', itemId: 'item_watchmans_coat' });
    await ren.settle();

    expect(ren.last('error')?.['code']).toBe('bad_message');
    // NEITHER BODY MOVED. Not Ren's doll, and — the half that would be theft —
    // not Alex's bag.
    expect(renBody.equipped ?? {}).toEqual({});
    expect(alexBody.carried).toEqual(['item_watchmans_coat']);
    expect(alexBody.equipped ?? {}).toEqual({});
  });

  it('refuses a drop naming an id NOBODY holds, with the same refusal', async () => {
    // THE SAME ERROR AS THE TEST ABOVE, AND THAT IS THE POINT. "No such item"
    // and "somebody else's item" are the same question — is this id in YOUR
    // list? — so they get the same answer. A distinct "that belongs to Alex"
    // would be an oracle over other people's bags, which is exactly what
    // `InventoryMsg` being a `ViewerMsg` exists to prevent.
    server = await boot('loot-unheld-drop');
    const ren = await connect(server.port);
    playsThe(WATCHMAN);
    const body = bodyOf(await ren.hello('ren-handle'));
    standAt(body, 10, 10);
    ren.clear();

    ren.send({ t: 'drop', itemId: 'item_inspectors_locket' });
    await ren.settle();

    expect(ren.last('error')?.['code']).toBe('bad_message');
    // AND NOTHING WAS CONJURED ONTO THE FLOOR. A `drop` that trusted the wire
    // would be an item duplicator with no upper bound.
    expect(floorIds()).toEqual([]);
  });

  it('refuses an unequip of an empty slot without touching the bag', async () => {
    // A stale `unequip { slot }` — the client is a frame behind and the slot is
    // already empty. `bad_message` and nothing else happens, which is the whole
    // reason the verb names a SLOT rather than an ITEM: a stale
    // `unequip { itemId }` would ask to remove something no longer worn, whereas
    // this one empties the slot the player is looking at.
    server = await boot('loot-empty-slot');
    const ren = await connect(server.port);
    playsThe(WATCHMAN);
    const body = bodyOf(await ren.hello('ren-handle'));
    body.carried = ['item_watchmans_cap'];
    ren.clear();

    ren.send({ t: 'unequip', slot: 'body' });
    await ren.settle();

    expect(ren.last('error')?.['code']).toBe('bad_message');
    expect(body.carried).toEqual(['item_watchmans_cap']);
  });
});

// ===========================================================================
// 3. THE CONTESTED PILE — the free-for-all rule's sharpest edge
// ===========================================================================

describe('two players standing on one item', () => {
  it('gives it to exactly one of them, and it exists in exactly one place after', async () => {
    // ═══════════════════════════════════════════════════════════════════════
    // DOUBLE-TAKE IS IMPOSSIBLE BY CONSTRUCTION, NOT BY A LOCK.
    // ═══════════════════════════════════════════════════════════════════════
    //
    // Remove-from-floor and add-to-bag are ONE INDIVISIBLE SYNCHRONOUS STEP
    // inside the pump. CLAUDE.md non-negotiable 2 is what makes that true:
    // there is no `await` anywhere in the path, so two `pickup` frames are two
    // separate synchronous handler invocations and the second one finds the id
    // gone. `removeGroundItem`'s boolean answer is checked rather than discarded
    // precisely so that the day anything DOES interleave, the failure is a
    // refusal rather than a duplicated item.
    //
    // THIS IS THE SHARPEST EDGE OF THE OWNERSHIP RULE and the reason it gets its
    // own describe: the pile is unowned, so two friends racing for one coat is
    // the NORMAL case rather than an attack.
    server = await boot('loot-contested');
    const ren = await connect(server.port);
    playsThe(WATCHMAN);
    const renBody = bodyOf(await ren.hello('ren-handle'));
    const alex = await connect(server.port);
    playsThe(WATCHMAN);
    const alexBody = bodyOf(await alex.hello('alex-handle'));

    // ONE TILE, ONE COAT, TWO DETECTIVES.
    standAt(renBody, 10, 10);
    standAt(alexBody, 10, 10);
    server.world.addGroundItem({ x: 10, y: 10 }, 'item_watchmans_coat');
    await ren.settle();
    await alex.settle();
    ren.clear();
    alex.clear();

    ren.send({ t: 'pickup' });
    alex.send({ t: 'pickup' });
    await ren.settle();
    await alex.settle();

    const holders = [renBody, alexBody].filter((body) =>
      (body.carried ?? []).includes('item_watchmans_coat'),
    );
    // EXACTLY ONE. Not zero (the race must not lose the item) and not two.
    expect(holders).toHaveLength(1);
    // AND THE FLOOR IS EMPTY, so the coat is in exactly one place in the world.
    expect(floorIds()).toEqual([]);

    // THE LOSER GETS A CHEAP REFUSAL RATHER THAN SILENCE. Absence is not a
    // signal — "no frame yet" and "no frame ever" look identical to a client —
    // and the loser's panel has to stop showing a button that will never work.
    const loser = holders[0] === renBody ? alex : ren;
    expect(loser.last('error')?.['code']).toBe('illegal_move');
  });
});

// ===========================================================================
// 4. THE BAG'S LIMITS, AND A BODY ON THE FLOOR
// ===========================================================================

describe('what the bag refuses', () => {
  it('refuses a pickup into a full bag and LEAVES THE ITEM WHERE IT IS', async () => {
    // ═══════════════════════════════════════════════════════════════════════
    // THE ITEM STAYING ON THE FLOOR IS THE HALF THAT MATTERS.
    // ═══════════════════════════════════════════════════════════════════════
    // A refusal that also removed the item would destroy somebody's drop to
    // enforce a limit, which is strictly worse than the limit. The refusal is
    // also the ONE loud one in this handler: it goes to the Case Log rather than
    // only to the sender, because the useful information is "somebody else take
    // this" and the party is standing on the tile. It is rate-limited by the
    // GAME TURN rather than by the socket — a refused pickup does not pump, so
    // the turn cannot advance until the player does something that moves the
    // world, and a client in a loop therefore cannot turn one refusal into
    // twenty broadcasts a second.
    server = await boot('loot-full-bag');
    const ren = await connect(server.port);
    playsThe(WATCHMAN);
    const body = bodyOf(await ren.hello('ren-handle'));
    standAt(body, 10, 10);

    // TWELVE REAL IDS. Real, because `handlePickup` checks "do you already own
    // this" BEFORE it checks the cap, so a bag of invented ids would prove the
    // wrong branch.
    const bag = ITEMS.slice(0, INVENTORY_CAP).map((item) => item.id);
    const spare = ITEMS[INVENTORY_CAP];
    if (spare === undefined) throw new Error('test fixture: the catalogue is too small');
    body.carried = bag;
    server.world.addGroundItem({ x: 10, y: 10 }, spare.id);
    await ren.settle();
    ren.clear();

    ren.send({ t: 'pickup' });
    await ren.settle();

    expect(ren.last('error')?.['code']).toBe('illegal_move');
    expect(body.carried).toEqual(bag);
    expect(floorIds()).toEqual([spare.id]);

    // AND THE ROOM WAS TOLD, ONCE.
    const lines = ren
      .all('log')
      .flatMap((frame) => (Array.isArray(frame['lines']) ? (frame['lines'] as Frame[]) : []))
      .map((line) => String(line['text']))
      .filter((text) => text.includes('evidence bag is full'));
    expect(lines).toHaveLength(1);

    // A SECOND SPAM-CLICK ON THE SAME TURN IS STILL REFUSED AND STILL SILENT ON
    // THE SHARED LANE. The 20/s token bucket is per-socket and cannot tell a
    // pickup from a ping, so without the per-turn brake this would be an
    // amplifier: one client's loop becoming twenty broadcasts a second to
    // everybody.
    ren.clear();
    ren.send({ t: 'pickup' });
    await ren.settle();
    expect(ren.last('error')?.['code']).toBe('illegal_move');
    expect(ren.all('log')).toHaveLength(0);
  });

  it('refuses an id the body already owns, because `carried` IS A SET', async () => {
    // ═══════════════════════════════════════════════════════════════════════
    // THE REFUSAL THAT PREVENTS A BUG THAT WOULD LOOK LIKE A PERSISTENCE BUG.
    // ═══════════════════════════════════════════════════════════════════════
    // A saved id carries no per-instance handle, so persist/saves.ts keeps the
    // FIRST occurrence and drops later ones. Without this check a party that
    // found two identical caps would appear to keep both until the next reload,
    // and the loss would present as "my second cap vanished when I relogged" —
    // with the bug looking like it is in persistence when it is here.
    //
    // WORN COUNTS AS OWNED TOO. The doll and the bag are one set for this
    // purpose, or picking up a duplicate of what you are wearing would be legal
    // and would vanish the same way.
    server = await boot('loot-set-not-bag');
    const ren = await connect(server.port);
    playsThe(WATCHMAN);
    const body = bodyOf(await ren.hello('ren-handle'));
    standAt(body, 10, 10);
    body.carried = ['item_watchmans_cap'];
    server.world.addGroundItem({ x: 10, y: 10 }, 'item_watchmans_cap');
    ren.clear();

    ren.send({ t: 'pickup' });
    await ren.settle();
    expect(ren.last('error')?.['code']).toBe('bad_message');
    expect(body.carried).toEqual(['item_watchmans_cap']);
    expect(floorIds()).toEqual(['item_watchmans_cap']);

    // The same refusal when the duplicate is being WORN rather than carried.
    body.carried = [];
    body.equipped = { head: 'item_watchmans_cap' };
    ren.clear();
    ren.send({ t: 'pickup' });
    await ren.settle();
    expect(ren.last('error')?.['code']).toBe('bad_message');
    expect(floorIds()).toEqual(['item_watchmans_cap']);
  });

  it('refuses an unequip into a full bag rather than discarding the coat', async () => {
    // THE ONE VERB THE CAP CAN REFUSE. `equip` swaps (the count never rises),
    // `drop` removes, `pickup` checks before it takes — only this one moves an
    // item INTO the bag without taking one out. Being told plainly beats the
    // other way this could have gone, which is silently dropping the coat on the
    // floor to make room.
    server = await boot('loot-unequip-full');
    const ren = await connect(server.port);
    playsThe(WATCHMAN);
    const body = bodyOf(await ren.hello('ren-handle'));
    body.carried = ITEMS.slice(0, INVENTORY_CAP).map((item) => item.id);
    body.equipped = { body: 'item_watchmans_coat' };
    ren.clear();

    ren.send({ t: 'unequip', slot: 'body' });
    await ren.settle();

    expect(ren.last('error')?.['code']).toBe('illegal_move');
    expect(body.equipped['body']).toBe('item_watchmans_coat');
    expect(body.carried).toHaveLength(INVENTORY_CAP);
  });
});

describe('a body on the floor', () => {
  it('is refused all four verbs while Downed, and the offer survives', async () => {
    // ═══════════════════════════════════════════════════════════════════════
    // THE SAME GUARD `handleSpendPoint` USES, AND FOR THE SAME REASON.
    // ═══════════════════════════════════════════════════════════════════════
    // A downed body carries a `DownedRecord` that `revive`/`standUp` reads back
    // to put the RIGHT body on its feet, and quietly rewriting what that body is
    // wearing while it lies there is the class of corruption gateway.ts records
    // at its class chooser. `not_your_turn` is "not now", never "never": the
    // coat is still on the tile the moment somebody picks them up.
    server = await boot('loot-downed');
    const ren = await connect(server.port);
    playsThe(WATCHMAN);
    const body = bodyOf(await ren.hello('ren-handle'));
    standAt(body, 10, 10);
    body.carried = ['item_watchmans_cap'];
    server.world.addGroundItem({ x: 10, y: 10 }, 'item_watchmans_coat');

    goDown(server.downed, body, 0);
    expect(body.alive).toBe(false);
    ren.clear();

    ren.send({ t: 'pickup' });
    ren.send({ t: 'equip', itemId: 'item_watchmans_cap' });
    ren.send({ t: 'unequip', slot: 'head' });
    ren.send({ t: 'drop', itemId: 'item_watchmans_cap' });
    await ren.settle();

    expect(ren.all('error')).toHaveLength(4);
    for (const error of ren.all('error')) expect(error['code']).toBe('not_your_turn');
    expect(body.carried).toEqual(['item_watchmans_cap']);
    expect(body.equipped ?? {}).toEqual({});
    expect(floorIds()).toEqual(['item_watchmans_coat']);
  });

  it('is refused all four verbs while Erased, on the same single read', async () => {
    // `!alive` IS DOWNED AND ERASED BOTH, which is what lets one read cover the
    // pair without net/ learning the survival table's shape. Tested separately
    // anyway, because "the countdown ran out" is a genuinely different state —
    // it is the one a player can leave by themselves, with `respawn`, and the
    // gear has to be waiting for them when they do.
    server = await boot('loot-erased');
    const ren = await connect(server.port);
    playsThe(WATCHMAN);
    const body = bodyOf(await ren.hello('ren-handle'));
    standAt(body, 10, 10);
    body.carried = ['item_watchmans_cap'];

    goDown(server.downed, body, 0);
    // Run the countdown out. `tickDowned` is the engine's own path to Erased;
    // hand-setting a flag would be a test of a flag.
    for (let i = 0; i < 10; i += 1) tickDowned(server.downed, body);
    ren.clear();

    ren.send({ t: 'equip', itemId: 'item_watchmans_cap' });
    ren.send({ t: 'drop', itemId: 'item_watchmans_cap' });
    await ren.settle();

    expect(ren.all('error')).toHaveLength(2);
    for (const error of ren.all('error')) expect(error['code']).toBe('not_your_turn');
    expect(body.carried).toEqual(['item_watchmans_cap']);
  });
});

// ===========================================================================
// 5. WHAT EQUIPMENT ACTUALLY DOES — Trap 1, closed at the character sheet
// ===========================================================================

describe('gear moves a number the player can read', () => {
  it('changes the ARMOUR on the character sheet, and changes it back', async () => {
    // ═══════════════════════════════════════════════════════════════════════
    // THE ONLY PLACE GEAR CAN HAVE A CONSEQUENCE A PLAYER CAN SEE.
    // ═══════════════════════════════════════════════════════════════════════
    // `view/inspect.ts` reads `actor.combat` and knows nothing about items — it
    // needed no edit when equipment landed, which is the proof that the numbers
    // reach the sheet through the one path the dice also roll against. If this
    // assertion could pass with a second path, it would not be worth making.
    //
    // AND THE ROUND TRIP IS EXACT. Unequip is not a subtraction: it is the same
    // additive fold re-run over a smaller set, so there is no inverse operation
    // to get wrong and no way to gain armour by re-equipping.
    server = await boot('loot-sheet');
    const ren = await connect(server.port);
    playsThe(WATCHMAN);
    const body = bodyOf(await ren.hello('ren-handle'));
    standAt(body, 10, 10);
    body.carried = ['item_watchmans_cap'];

    await readSheet(ren, body.id);
    const bare = sheetRow(ren, 'Armour');
    expect(bare).toBeDefined();

    ren.send({ t: 'equip', itemId: 'item_watchmans_cap' });
    await ren.settle();
    await readSheet(ren, body.id);
    const geared = sheetRow(ren, 'Armour');
    // +3 EXACTLY. The cap is the THRESHOLD PIECE: armour 6 -> 9 clears the
    // husk's apr 7 and the elite's apr 8, and `max(0, armour - apr)` means
    // anything below that measures as literally zero.
    expect(Number(geared)).toBe(Number(bare) + 3);

    ren.send({ t: 'unequip', slot: 'head' });
    await ren.settle();
    await readSheet(ren, body.id);
    expect(sheetRow(ren, 'Armour')).toBe(bare);
  });

  it('does not destroy equipped gear when a class is picked', async () => {
    // ═══════════════════════════════════════════════════════════════════════
    // THE world.ts:604 BUG, DRIVEN END TO END.
    // ═══════════════════════════════════════════════════════════════════════
    // `reclothePlayer` used to do `actor.combat = overlay.combat`, which
    // replaced the WHOLE sheet — so a player who equipped anything and then
    // finished character creation silently lost every contribution while the ids
    // stayed in `equipped` and the panel went on drawing them. Nothing failed
    // anywhere; the armour was simply gone. It now writes `baseCombat` and
    // recomposes, and this is the test that says so from outside.
    //
    // NO `playsThe` HERE, deliberately: this is the ONE test in the file that
    // wants a body which still owes a class choice, because that is the only
    // state in which the chooser is answerable.
    server = await boot('loot-reclothe');
    const ren = await connect(server.port);
    server.saves.restore = null;
    const body = bodyOf(await ren.hello('ren-handle'));
    standAt(body, 10, 10);
    body.carried = ['item_watchmans_cap'];

    ren.send({ t: 'equip', itemId: 'item_watchmans_cap' });
    await ren.settle();
    await readSheet(ren, body.id);
    const beforeChoice = Number(sheetRow(ren, 'Armour'));

    ren.send({ t: 'choose_class', classId: ALCHEMIST.id });
    await ren.settle();

    // THE IDS SURVIVED — which was always true, and was the reason the bug was
    // invisible.
    expect(body.equipped?.['head']).toBe('item_watchmans_cap');
    // AND SO DID THE EFFECT. The Alchemist's base armour differs from the
    // Watchman's, so the assertion is not "the same number" — it is that the
    // cap's +3 is still folded on top of whatever the new class brings.
    await readSheet(ren, body.id);
    const afterChoice = Number(sheetRow(ren, 'Armour'));
    expect(afterChoice).toBe(Number(ALCHEMIST.combat?.mods?.armour ?? 0) + 3);
    // The bug's signature was `afterChoice === base with no gear`, so this is
    // the assertion that would have failed before the fix.
    expect(beforeChoice).toBeGreaterThan(0);

    // AND THE PANEL WAS RESENT, because the comparison rows are deltas against a
    // baseline that just changed even though neither id list moved.
    expect(ren.all('inventory').length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// 6. THE ROUND TRIP — a coat is worth nothing if its effect does not come back
// ===========================================================================

describe('a loadout survives a snapshot and a restore', () => {
  it('brings back the bag, the doll AND the armour on the character sheet', async () => {
    // ═══════════════════════════════════════════════════════════════════════
    // RESTORING THE ID BUT NOT THE EFFECT IS THE FAILURE THIS CATCHES.
    // ═══════════════════════════════════════════════════════════════════════
    //
    // The identical argument gateway-progression.test.ts makes about a level: a
    // restore that put `equipped` on the body but never recomposed would look
    // completely correct in the save file, completely correct in the panel, and
    // the player would fight with the bare class sheet. So the final assertion
    // is not an id in a list — it is the ARMOUR ON THE CHARACTER SHEET, read
    // back through the `inspect` path.
    //
    // AND IT WATCHES `applyRestore`'S HP CLAMP. That clamp runs BEFORE the gear
    // lands, against the bare-class ceiling. No item in this catalogue
    // contributes `maxHp` — `AdditiveMods` has no such field — which is the only
    // reason the order is safe, and the day one does the clamp would silently
    // shave hp off a geared character on every load.
    server = await boot('loot-round-trip-a');
    const first = await connect(server.port);
    playsThe(WATCHMAN);
    const body = bodyOf(await first.hello('ren-handle'));
    standAt(body, 10, 10);
    server.world.addGroundItem({ x: 10, y: 10 }, 'item_watchmans_cap');
    server.world.addGroundItem({ x: 10, y: 10 }, 'item_watchmans_coat');

    first.send({ t: 'pickup' });
    first.send({ t: 'pickup' });
    await first.settle();
    first.send({ t: 'equip', itemId: 'item_watchmans_coat' });
    await first.settle();

    await readSheet(first, body.id);
    const gearedArmour = sheetRow(first, 'Armour');

    // THE SNAPSHOT, taken by the gateway itself — not a hand-built literal, so
    // what is carried forward is whatever `snapshotPlayers` really writes.
    //
    // READ OFF THE QUEUE, NOT OFF THE FLUSH LIST, and the distinction is the
    // point of `saveLoot`: `pickup` is the one verb that flushes immediately
    // (the floor is unpersisted, so an unsaved take DESTROYS the item), while
    // `equip` rides the debounce, because an id moving between two persisted
    // places on one body loses nothing but a re-click. Both paths run the SAME
    // `snapshotPlayers`, so this is the same object either way — reading the
    // flush list here would silently assert against the state before the equip.
    const filed = server.saves.queued.at(-1)?.find((s) => s.actorId === body.id);
    expect(filed?.carried).toEqual(['item_watchmans_cap']);
    expect(filed?.equipped).toEqual({ body: 'item_watchmans_coat' });
    await server.close();

    // ═══ A FRESH WORLD, A FRESH PROCESS'S WORTH OF STATE ═══
    server = await boot('loot-round-trip-b');
    server.saves.restore = {
      hp: null,
      cooldowns: {},
      classId: WATCHMAN.id,
      carried: filed?.carried,
      equipped: filed?.equipped,
    };

    const second = await connect(server.port);
    const restored = bodyOf(await second.hello('ren-handle'));
    expect(restored.carried).toEqual(['item_watchmans_cap']);
    expect(restored.equipped?.['body']).toBe('item_watchmans_coat');

    // ═══ THE ONE THAT MATTERS ═══
    await readSheet(second, restored.id);
    expect(sheetRow(second, 'Armour')).toBe(gearedArmour);

    // AND THE PANEL AGREES, off the frames the restored socket actually got —
    // sent on the welcome path, after the gear landed and the sheet recomposed.
    const panel = second.last('inventory');
    expect(Object.keys((panel?.['equipped'] ?? {}) as Frame)).toEqual(['body']);
  });

  it('carries an ABSENCE forward rather than emptying a bag it cannot speak for', async () => {
    // ═══════════════════════════════════════════════════════════════════════
    // ABSENT IS NOT EMPTY, AND THE `??` CHAIN READS THEM DIFFERENTLY.
    // ═══════════════════════════════════════════════════════════════════════
    // `[]`/`{}` is a CLAIM — this character owns nothing — and `undefined` is
    // "this build cannot say". `fileFor` writes `snapshot.carried ??
    // binding.carried`, so an absence leaves the disk exactly as it found it
    // while an empty array OVERWRITES a returning player's bag with nothing. A
    // body that has never touched an item must therefore produce neither key.
    server = await boot('loot-absent');
    const ren = await connect(server.port);
    playsThe(WATCHMAN);
    const body = bodyOf(await ren.hello('ren-handle'));

    const filed = server.saves.flushes.at(-1)?.snapshots.find((s) => s.actorId === body.id);
    expect(filed).toBeDefined();
    expect(Object.hasOwn(filed ?? {}, 'carried')).toBe(false);
    expect(Object.hasOwn(filed ?? {}, 'equipped')).toBe(false);

    // AND A PLAYER WHO GENUINELY DROPPED EVERYTHING DOES MAKE THE CLAIM. The
    // loot verbs always write an array rather than deleting the field, so an
    // emptied bag reaches the disk as `[]` and the file is emptied with it.
    standAt(body, 10, 10);
    server.world.addGroundItem({ x: 10, y: 10 }, 'item_watchmans_cap');
    ren.send({ t: 'pickup' });
    await ren.settle();
    ren.send({ t: 'drop', itemId: 'item_watchmans_cap' });
    await ren.settle();

    const later = [...server.saves.flushes, ...server.saves.queued.map((s) => ({ snapshots: s }))]
      .flatMap((entry) => entry.snapshots)
      .filter((snapshot) => snapshot.actorId === body.id)
      .at(-1);
    expect(later?.carried).toEqual([]);
  });

  it('repairs a file that names an item this build does not have', async () => {
    // REPAIR, NEVER REJECT. A character file must never be the reason somebody
    // cannot play tonight — and this is re-checked in the gateway even though
    // persist/saves.ts already checks it, because `PersistPort` is an INTERFACE:
    // a test double, the e2e harness or a future store may hand back anything. A
    // gateway that trusted it would put an unknown id onto a live body, where
    // `wornOf` skips it in the fold while the panel draws it — so the two would
    // disagree about what a character is wearing.
    server = await boot('loot-repair');
    const ren = await connect(server.port);
    server.saves.restore = {
      hp: null,
      cooldowns: {},
      classId: WATCHMAN.id,
      carried: ['item_that_was_deleted', 'item_watchmans_cap', 'item_watchmans_cap'],
      equipped: {
        // A body item filed under the legs slot.
        legs: 'item_watchmans_coat',
        head: 'item_watchmans_cap',
      },
    };

    const body = bodyOf(await ren.hello('ren-handle'));
    // The wrong-slot entry is DROPPED, not demoted to the bag and not re-filed
    // into the slot the catalogue names — both repairs were considered and
    // rejected in persist/saves.ts's `parseEquipped`.
    expect(body.equipped).toEqual({ head: 'item_watchmans_cap' });
    // The unknown id is gone, and so is the duplicate of the WORN cap: `carried`
    // is a set, and an id in both lists keeps the equipped copy.
    expect(body.carried).toEqual([]);
  });
});

describe('the first thing you ever pick up', () => {
  /** Every Margin/Record line this socket has been shown, flattened. */
  function saidTo(client: { all: (t: string) => Record<string, unknown>[] }): string[] {
    return client.all('log').flatMap((frame) => {
      const rows = frame['lines'];
      if (!Array.isArray(rows)) return [];
      return (rows as unknown[]).map((row) => String((row as Record<string, unknown>)['text']));
    });
  }

  it('tells a bare-legged player that their legs are bare', async () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * A NEW CHARACTER WEARS NOTHING, AND NOTHING SAID SO.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * Measured: `projectInventory` on a fresh body answers `equipped: {}` and
     * `carried: []` — the classes have no starting kit at all. So the first
     * thing that drops is the first gear that player has ever owned, and putting
     * it on is their first real upgrade.
     *
     * The transcript said *"picks up the Reinforced Watchman's Trousers"* and
     * stopped. A player who never opens the bag never equips anything and
     * quietly finds the game harder than it should be — which reads as
     * difficulty rather than as a missed step. `tools/first-session.mjs` shows
     * the whole opening in twenty-three lines and that was the gap in it.
     *
     * THE SAME VOICE AS `Something is still on the floor.` — a short observation
     * that implies an action, rather than a tutorial naming a key.
     */
    server = await boot('bare-legs');
    const ren = await connect(server.port);
    playsThe(WATCHMAN);
    const body = bodyOf(await ren.hello('ren-handle'));
    standAt(body, 10, 10);
    expect(body.equipped ?? {}, 'the fixture already dressed them').toEqual({});
    server.world.addGroundItem({ x: 10, y: 10 }, 'item_watchmans_trousers');

    ren.send({ t: 'pickup' });
    await ren.settle();

    expect(saidTo(ren)).toContain('Nothing on your legs yet.');
  });

  it('says nothing about a slot that is already filled', async () => {
    /**
     * ONCE PER EMPTY SLOT, BY CONSTRUCTION. It fires only when the slot is bare
     * at the moment of the pickup, so a player who is already wearing trousers
     * and picks up a second pair hears nothing — at most seven of these in a
     * career, each at the first moment it means anything.
     */
    server = await boot('legs-covered');
    const ren = await connect(server.port);
    playsThe(WATCHMAN);
    const body = bodyOf(await ren.hello('ren-handle'));
    standAt(body, 10, 10);
    body.equipped = { legs: 'item_watchmans_trousers' };
    server.world.addGroundItem({ x: 10, y: 10 }, 'item_inspectors_slacks');

    ren.send({ t: 'pickup' });
    await ren.settle();

    expect(saidTo(ren).some((line) => line.startsWith('Nothing on your'))).toBe(false);
  });

  it('says nothing about a draught, which is not worn at all', async () => {
    // `Item.slot` is absent on a consumable, so there is no part of you it could
    // be talking about. A "nothing on your undefined yet" would be the interface
    // reading its own field names back to somebody.
    server = await boot('bare-and-thirsty');
    const ren = await connect(server.port);
    playsThe(WATCHMAN);
    const body = bodyOf(await ren.hello('ren-handle'));
    standAt(body, 10, 10);
    server.world.addGroundItem({ x: 10, y: 10 }, 'item_draught_mending');

    ren.send({ t: 'pickup' });
    await ren.settle();

    expect(body.carried).toContain('item_draught_mending');
    expect(saidTo(ren).some((line) => line.startsWith('Nothing on your'))).toBe(false);
  });
});
