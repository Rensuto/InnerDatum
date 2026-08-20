import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';

import Fastify from 'fastify';

import { createContentTalentEngine, createTalentBook } from '../../src/server/content/classes.ts';
import { talentRuntimeFor } from '../../src/server/main.ts';
import { wsGateway } from '../../src/server/net/gateway.ts';
import {
  LoadOutcome,
  SaveOutcome,
  createCharacterBridge,
  createCharacterFile,
  parseCharacterFile,
} from '../../src/server/persist/saves.ts';
import { createTurnEngine } from '../../src/server/turn-engine.ts';
import { createWorld } from '../../src/server/world/world.ts';
import {
  KEYBIND_ACTION_MAX_CHARS,
  KEYBIND_KEYSTRING_MAX_CHARS,
  KEYBIND_KEYS_PER_ACTION,
  KEYBIND_MAX_ACTIONS,
  TileCode,
  parseClientMsg,
} from '../../src/shared/protocol.ts';
import { PROTOCOL_VERSION, SCHEMA_VERSION } from '../../src/shared/version.ts';
import type { IdentityPort } from '../../src/server/net/gateway.ts';
import { RetireOutcome } from '../../src/server/persist/saves.ts';
import type {
  CharacterFile,
  CharacterHeader,
  LoadResult,
  RetireResult,
  SaveStore,
} from '../../src/server/persist/saves.ts';
import type { BroadcastMsg, KeybindsMsg, ViewerMsg } from '../../src/shared/protocol.ts';
import type { Actor, World } from '../../src/server/world/world.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE KEYMAP ON THE WIRE: WHAT ZOD REFUSES, WHO IS ALLOWED TO HEAR IT, AND
 * WHAT IT COSTS THE WORLD.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The feature is one sentence — "no one likes to reconfigure keybinds" — and
 * every way it can fail is a way one of the four claims below stops being true.
 *
 *   1. THE SHAPE IS BOUNDED AT THE TRUST BOUNDARY. protocol.ts:6-14 is explicit
 *      that "CLIENT -> SERVER is zod. It is the single trust boundary in the
 *      whole system", and a keymap is the first frame in this protocol whose
 *      payload is an OPEN-KEYED MAP rather than a fixed set of fields. Four caps
 *      hold it shut, all four exported, and every one of them has a test here
 *      because an unbounded one is 16 KB of attacker-chosen text arriving in a
 *      character file.
 *
 *   2. A KEYMAP IS TRUE FOR EXACTLY ONE PERSON. `KeybindsMsg` is a `ViewerMsg`,
 *      so `broadcast(keybindsMsg)` must not COMPILE — which is a claim about the
 *      type system and is therefore tested with `@ts-expect-error` rather than
 *      with an assertion nobody can violate at runtime. A comment saying "do not
 *      broadcast this" is not enforcement.
 *
 *   3. IT DOES NOT MOVE THE WORLD. `set_keybinds` is the fourth member of the
 *      non-pumping self-only group beside `inspect`, `choose_class` and
 *      `spend_point`. If it pumped, a patched client would farm a free monster
 *      turn per keystroke off a settings screen — the mirror of the argument
 *      test/server/gateway-progression.test.ts:69-72 makes for a spend.
 *
 *   4. THE VERSION DOES NOT MOVE. Neither `PROTOCOL_VERSION` nor
 *      `SCHEMA_VERSION`. A reflex bump of the first refuses every shipped client
 *      for a frame it can safely ignore; a reflex bump of the second QUARANTINES
 *      a friend's character file in every older build, over a keyboard
 *      preference. src/shared/version.ts argues both at length and this file is
 *      what makes the argument fail the gate if somebody bumps out of tidiness.
 *
 * ═══ AND ONE CLAIM THAT IS NOT ABOUT THE WIRE AT ALL ═══
 * The disk has its OWN copy of the four caps (persist/saves.ts:1112-1126),
 * because a hand-edited character file never passes through zod. THE DISK CAP
 * MUST NEVER BE TIGHTER THAN THE WIRE CAP, or a map the server just ACCEPTED
 * comes back repaired after a reconnect and the player watches a binding they set
 * change by itself. The last section pins the two sets equal by running a map
 * built at exactly the exported caps through the real `parseCharacterFile`.
 *
 * NO DOM ANYWHERE IN THIS FILE. The capture field, the conflict detector and the
 * Keys screen are the client's, and they are tested where they live.
 */

/** Snowflake-SHAPED, and nobody's real id. */
const REN_ID = '333333333333333333';

const FRAME_TIMEOUT_MS = 2_000;

/**
 * THE SHARED FIXTURE, DELIBERATELY UNEVEN.
 *
 * Two keys on one action, one on the next, and a third action from a different
 * group — so a serialiser that sorted the slot array, padded it to two or
 * truncated it to one is caught rather than merely suspected. The tagged forms
 * are both present (`key:` follows the player's layout, `code:` survives
 * NumLock), which is the distinction src/client/input/keys.ts:258-283 makes and
 * the one a flattened namespace would destroy invisibly.
 */
const REBOUND_KEYS: Readonly<Record<string, readonly string[]>> = {
  move_north: ['key:w', 'code:Numpad8'],
  move_south: ['key:s'],
  toggle_inventory: ['key:i'],
};

// ===========================================================================
// 1. THE SCHEMA — every cap, and the two shapes that are not caps at all
// ===========================================================================

/** A well-formed frame, with `over` folded in so a test can break one field. */
function frame(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { v: PROTOCOL_VERSION, t: 'set_keybinds', binds: { move_north: ['key:w'] }, ...over };
}

describe('the set_keybinds schema', () => {
  it('accepts a real remap, uneven slot arrays and all', () => {
    const parsed = parseClientMsg(frame({ binds: REBOUND_KEYS }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.msg.t).toBe('set_keybinds');
    if (parsed.msg.t !== 'set_keybinds') return;
    // VERBATIM, INCLUDING THE UNEVENNESS. `move_north` keeps two keys and
    // `move_south` keeps one; a schema that normalised the arrays to a fixed
    // length would quietly invent a binding nobody set.
    expect(parsed.msg.binds).toEqual(REBOUND_KEYS);
  });

  it('accepts an EMPTY map — that is the RESET ALL button, not a malformed frame', () => {
    // `binds: {}` is the only spelling of "put everything back". A schema that
    // required at least one action would leave the player with no way to say it
    // and would force a second verb into the protocol for a button.
    const parsed = parseClientMsg(frame({ binds: {} }));
    expect(parsed.ok).toBe(true);
  });

  it('accepts an action cleared to NO keys — `[]` is a decision, not an absence', () => {
    // persist/saves.ts keeps such an action as `[]` rather than deleting it,
    // because the map's KEYS are data too: deleting would turn "the player
    // cleared this" into "the player never opened the screen". The wire has to be
    // able to express what the disk is willing to store.
    const parsed = parseClientMsg(frame({ binds: { move_north: [] } }));
    expect(parsed.ok).toBe(true);
  });

  it('REJECTS a frame with no `v` — the only version check there is', () => {
    // ═════════════════════════════════════════════════════════════════════════
    // protocol.ts:2101-2107, restated because it is the trap every new schema in
    // this file can fall into: `parseClientMsg`'s own version check is guarded by
    // `'v' in candidate`, and the gateway's `wireVersion` returns undefined for a
    // frame that has none. A schema whose `v` was `.optional()` would therefore
    // let a client from any deploy in, silently, past the one gate that exists to
    // stop it. The `z.literal` is the whole of what makes the field mandatory.
    // ═════════════════════════════════════════════════════════════════════════
    const bare: Record<string, unknown> = { t: 'set_keybinds', binds: { move_north: ['key:w'] } };
    const parsed = parseClientMsg(bare);
    expect(parsed.ok).toBe(false);
  });

  it('REJECTS an unknown key rather than stripping it — strictObject', () => {
    // THE STRIP IS THE DANGEROUS FAILURE, exactly as it is for `spend_point`. A
    // plain `z.object` would drop `actorId` and hand the handler a perfectly
    // legal frame, which would then rewrite the SENDER's own keyboard — the
    // screen showing what they asked for while the server did something else.
    const parsed = parseClientMsg(frame({ actorId: 'actor_somebody_else' }));
    expect(parsed.ok).toBe(false);
  });

  it('REJECTS more actions than the cap', () => {
    const binds: Record<string, string[]> = {};
    for (let index = 0; index <= KEYBIND_MAX_ACTIONS; index += 1) {
      binds[`action_${String(index)}`] = ['key:a'];
    }
    expect(Object.keys(binds)).toHaveLength(KEYBIND_MAX_ACTIONS + 1);
    expect(parseClientMsg(frame({ binds })).ok).toBe(false);
    // And the cap itself is INCLUSIVE — an off-by-one here would refuse a map a
    // client legitimately built against the exported number.
    delete binds['action_0'];
    expect(parseClientMsg(frame({ binds })).ok).toBe(true);
  });

  it('REJECTS an over-long action id', () => {
    const long = 'a'.repeat(KEYBIND_ACTION_MAX_CHARS + 1);
    expect(parseClientMsg(frame({ binds: { [long]: ['key:a'] } })).ok).toBe(false);
    const exact = 'a'.repeat(KEYBIND_ACTION_MAX_CHARS);
    expect(parseClientMsg(frame({ binds: { [exact]: ['key:a'] } })).ok).toBe(true);
  });

  it('REJECTS an over-long key string', () => {
    const long = `key:${'a'.repeat(KEYBIND_KEYSTRING_MAX_CHARS)}`;
    expect(parseClientMsg(frame({ binds: { move_north: [long] } })).ok).toBe(false);
    const exact = 'a'.repeat(KEYBIND_KEYSTRING_MAX_CHARS);
    expect(parseClientMsg(frame({ binds: { move_north: [exact] } })).ok).toBe(true);
  });

  it('REJECTS more keys per action than the cap', () => {
    const keys = Array.from({ length: KEYBIND_KEYS_PER_ACTION + 1 }, (_, i) => `key:${String(i)}`);
    expect(parseClientMsg(frame({ binds: { move_north: keys } })).ok).toBe(false);
    expect(parseClientMsg(frame({ binds: { move_north: keys.slice(1) } })).ok).toBe(true);
  });

  it('REJECTS an EMPTY key string — nobody pressed that', () => {
    // The one place `.min(1)` sits on the string rather than on the array, and
    // the asymmetry is the point: an empty LIST is a decision ("cleared"), an
    // empty STRING is a key that does not exist. Letting it through would put a
    // binding in the map that no press can ever match, which reads to the player
    // as a rebind that silently did nothing.
    expect(parseClientMsg(frame({ binds: { move_north: [''] } })).ok).toBe(false);
  });

  it('REJECTS a non-array value', () => {
    // The shape a hand-rolled client actually produces: one key, unwrapped.
    expect(parseClientMsg(frame({ binds: { move_north: 'key:w' } })).ok).toBe(false);
    expect(parseClientMsg(frame({ binds: { move_north: null } })).ok).toBe(false);
    expect(parseClientMsg(frame({ binds: { move_north: { 0: 'key:w' } } })).ok).toBe(false);
  });

  it('REJECTS a `binds` that is not an object at all', () => {
    expect(parseClientMsg(frame({ binds: 'key:w' })).ok).toBe(false);
    expect(parseClientMsg(frame({ binds: [] })).ok).toBe(false);
    expect(parseClientMsg(frame({ binds: undefined })).ok).toBe(false);
  });
});

// ===========================================================================
// 2. THE PRIVACY, AS A COMPILE ERROR
// ===========================================================================

describe('a keymap frame is viewer-private by construction', () => {
  it('is a ViewerMsg and is therefore NOT assignable to BroadcastMsg', () => {
    /**
     * ═════════════════════════════════════════════════════════════════════════
     * THE `@ts-expect-error` IS THE ENFORCEMENT. THE `expect` BELOW IS DECORATION.
     * ═════════════════════════════════════════════════════════════════════════
     *
     * `BroadcastMsg = Exclude<ServerMsg, ViewerMsg>` and the gateway's
     * `broadcast` takes a `BroadcastMsg`, so the only way to prove "this frame
     * can never be handed to the room" is to write the assignment that must not
     * compile and let the build fail if it starts compiling. A runtime assertion
     * cannot express it: there is nothing to observe about a type at runtime, and
     * a test that only asserted "we did not call broadcast" would pass for the
     * one call site that exists today and say nothing about the next one.
     *
     * If `KeybindsMsg` is ever dropped from `ViewerMsg`, `@ts-expect-error` turns
     * into "unused expect-error" and `npm run typecheck` fails — which is exactly
     * the alarm wanted, in the file that made the claim.
     */
    const keybinds: KeybindsMsg = {
      v: PROTOCOL_VERSION,
      t: 'keybinds',
      binds: REBOUND_KEYS,
      persisted: true,
    };

    // A `ViewerMsg` it is, and this line is what proves membership rather than
    // merely asserting it in prose.
    const viewer: ViewerMsg = keybinds;
    expect(viewer.t).toBe('keybinds');

    // @ts-expect-error a keymap is true for exactly one person, so it must never
    // be assignable to the type `broadcast` accepts.
    const broadcastable: BroadcastMsg = keybinds;
    expect(broadcastable.t).toBe('keybinds');
  });
});

// ===========================================================================
// 3. THE GATEWAY — the socket harness
// ===========================================================================

type Frame = Record<string, unknown>;

type Client = {
  send(frame: Frame): void;
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
      const hit = frames.find((f) => f['t'] === type);
      if (hit !== undefined) return hit;
      if (Date.now() >= deadline) return undefined;
      await sleep(10);
    }
  };

  const client: Client = {
    send(frame: Frame): void {
      socket.send(JSON.stringify({ v: PROTOCOL_VERSION, ...frame }));
    },
    /**
     * ═══ v19: THE HANDSHAKE IS TWO ROUND TRIPS FOR A SIGNED-IN PLAYER ═══
     *
     * A verified `hello` that names no character is answered with a `roster` AND
     * NO BODY — that is the select screen, and every test in this file would sit
     * on `waitFor('welcome')` until it timed out.
     *
     * SO THIS DOES WHAT THE REAL CLIENT DOES: ask, then choose. Take the first
     * playable character if there is one, otherwise ask for a new one. That
     * covers both shapes these tests need — a first-ever join and a reconnect to
     * the character a previous client just made — with no per-test annotation
     * and, more importantly, with no second definition of the handshake that
     * could drift from the one `src/client/` performs.
     *
     * An account with no characters allocates the DEFAULT id, which is
     * `SOLO_CHARACTER_ID` — so every file assertion in this suite still finds
     * `chr_main` exactly where it always did.
     */
    async hello(sessionId?: string) {
      if (sessionId === undefined) {
        client.send({ t: 'hello' });
        return await client.waitFor('welcome');
      }
      client.send({ t: 'hello', sessionId });
      const roster = await client.waitFor('roster');
      if (roster === undefined) return await client.waitFor('welcome');
      const rows = (roster['characters'] ?? []) as { id: string; playable: boolean }[];
      const mine = rows.find((row) => row.playable);
      client.send(
        mine === undefined
          ? { t: 'hello', sessionId, newCharacter: true }
          : { t: 'hello', sessionId, characterId: mine.id },
      );
      return await client.waitFor('welcome');
    },
    async settle() {
      client.send({ t: 'ping' });
      const pong = await waitFor('pong');
      if (pong === undefined) throw new Error('the server never answered the ordering ping');
      frames = frames.filter((f) => f['t'] !== 'pong');
    },
    waitFor,
    all: (type: string): Frame[] => frames.filter((f) => f['t'] === type),
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

function identityPort(): IdentityPort {
  const people: Readonly<Record<string, { id: string; name: string }>> = {
    'ren-handle': { id: REN_ID, name: 'Ren' },
  };
  return {
    get: (id: string | undefined) => {
      const found = id === undefined ? undefined : people[id];
      return found === undefined ? undefined : { user: { id: found.id }, displayName: found.name };
    },
  };
}

/**
 * A `SaveStore` whose disk is a Map, keyed exactly as the real one keys a path,
 * with the REAL `createCharacterBridge` sitting on top of it.
 *
 * THE BRIDGE IS REAL BECAUSE ONE CLAIM HERE IS ABOUT IT. "An anonymous socket's
 * rebind reaches no file" is a property of `owned()` — the bridge drops a
 * snapshot it has no binding for, and only `openCharacter` ever creates one, and
 * `openCharacter` is called only for somebody the identity port named. A
 * recording `PersistPort` would be handed the anonymous snapshot too (the gateway
 * hands over EVERY player and lets the port decide), so a test double would have
 * proved the opposite of what it looked like it proved.
 */
type Disk = {
  /** `<ownerId>/<characterId>` -> the last file written there. */
  readonly files: Map<string, CharacterFile>;
  /** Every immediate write, in order, with the reason the gateway gave. */
  readonly flushes: { readonly key: string; readonly reason: string }[];
  /**
   * Answer `corrupt` to every load, which is one of the two outcomes the bridge
   * deliberately REFUSES TO BIND (saves.ts returns null before `bindings.set`, so
   * the bytes stay where a human can look at them). The only way to reach the
   * state the `persisted` flag used to lie about.
   */
  corrupt: boolean;
  readonly store: SaveStore;
};

function disk(): Disk {
  const files = new Map<string, CharacterFile>();
  const flushes: { key: string; reason: string }[] = [];
  const keyOf = (ownerId: string, characterId: string): string => `${ownerId}/${characterId}`;
  const self = { corrupt: false };

  const store: SaveStore = {
    root: '<memory>',
    /**
     * AN IN-MEMORY STORE STILL OWES THE WHOLE CONTRACT — the same argument the
     * `listCharacters` note above makes. This fixture has a map, not a
     * directory, so a retire is a delete FROM THE MAP: the real store renames
     * the file aside because bytes on somebody`s only server are worth keeping,
     * and a Map entry has no such claim on anybody.
     */
    retireCharacter: (ownerId: string, characterId: string): Promise<RetireResult> => {
      const had = files.delete(keyOf(ownerId, characterId));
      return Promise.resolve({
        outcome: had ? RetireOutcome.Retired : RetireOutcome.Absent,
        path: '<memory>',
      });
    },
    // AN IN-MEMORY STORE STILL OWES THE WHOLE CONTRACT. This fixture predates
    // the roster and has no directory to read, so it answers from the same map
    // its loader uses — which keeps it honest if a test ever asks.
    listCharacters: (ownerId: string): Promise<readonly CharacterHeader[]> =>
      Promise.resolve(
        [...files.entries()]
          .filter(([key]) => key.startsWith(`${ownerId}/`))
          .map(([, file]) => ({
            id: file.id,
            name: file.name,
            classId: file.classId,
            level: file.level ?? 1,
            filed: file.filed?.length ?? 0,
            money: file.money ?? 0,
            createdAt: file.createdAt,
            updatedAt: file.updatedAt,
            playable: true,
          })),
      ),
    loadCharacter: (ownerId: string, characterId: string): Promise<LoadResult> => {
      if (self.corrupt) {
        return Promise.resolve({
          outcome: LoadOutcome.Corrupt,
          file: null,
          migrated: false,
          problems: ['the fixture said so'],
        });
      }
      const file = files.get(keyOf(ownerId, characterId));
      if (file === undefined) {
        return Promise.resolve({
          outcome: LoadOutcome.Missing,
          file: null,
          migrated: false,
          problems: [],
        });
      }
      return Promise.resolve({ outcome: LoadOutcome.Loaded, file, migrated: false, problems: [] });
    },
    saveCharacter: (file: CharacterFile, reason: string) => {
      const key = keyOf(file.ownerId, file.id);
      files.set(key, file);
      flushes.push({ key, reason });
      return Promise.resolve({ outcome: SaveOutcome.Written, path: key });
    },
    scheduleCharacter: (file: CharacterFile): void => {
      files.set(keyOf(file.ownerId, file.id), file);
    },
    flush: (): Promise<void> => Promise.resolve(),
    close: (): Promise<void> => Promise.resolve(),
    pendingCount: (): number => 0,
  };

  return {
    files,
    flushes,
    get corrupt(): boolean {
      return self.corrupt;
    },
    set corrupt(value: boolean) {
      self.corrupt = value;
    },
    store,
  };
}

type Harness = {
  readonly port: number;
  readonly world: World;
  readonly disk: Disk;
  close(): Promise<void>;
};

/**
 * `existing` IS WHAT MAKES A SERVER RESTART EXPRESSIBLE.
 *
 * Booting a SECOND gateway over the SAME `Disk` gives an empty world (so
 * `resolveActor` cannot resume a body and `resolved.resumed` is false) sitting on
 * top of the bytes the first one wrote. That is the only arrangement in which
 * `restoreProgression` — and therefore `restoreKeybinds` — actually runs, and
 * nothing in the suite produced it before.
 */
async function boot(seed: string, existing?: Disk): Promise<Harness> {
  const app = Fastify({ logger: false });
  const world = createWorld(seed);
  // Wall to wall floor: nothing here is about terrain, and a spawn search that
  // has to dodge a pillar would make placement a variable.
  world.level.tiles.fill(TileCode.FLOOR);

  const store = existing ?? disk();
  const talents = createContentTalentEngine();
  const engine = createTurnEngine({
    world,
    now: () => 0,
    talents: createTalentBook(talents, world),
    talentRuntime: talentRuntimeFor(talents, world),
  });

  await app.register(wsGateway, {
    world,
    engine,
    sessions: identityPort(),
    persist: createCharacterBridge({
      store: store.store,
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      now: () => '2026-01-01T00:00:00.000Z',
    }),
    disconnectGraceMs: 30_000,
  });
  await app.listen({ host: '127.0.0.1', port: 0 });

  const address = app.server.address();
  if (address === null || typeof address === 'string') throw new Error('no port was bound');

  return {
    port: address.port,
    world,
    disk: store,
    close: async (): Promise<void> => {
      await app.close();
    },
  };
}

let server: Harness;

/**
 * The LIVE body behind a `welcome`, read straight out of the world.
 *
 * Not narrowed to `PlayerActor`, deliberately: `keybinds` is declared on
 * `ActorCommon` beside `carried` and `equipped` — the block engine/actor.ts
 * argues exists because `snapshotPlayers` cannot reach anything but the actor
 * table — so a narrowing here would imply a distinction the type does not make.
 */
function bodyOf(welcome: Frame | undefined): Actor {
  const id = String(welcome?.['selfId']);
  const actor = server.world.getActor(id);
  if (actor === undefined) throw new Error(`test fixture: no actor for ${id}`);
  return actor;
}

describe('set_keybinds, over a real socket', () => {
  // SCOPED TO THIS BLOCK, not to the file. The schema, privacy, version and cap
  // suites boot nothing, and a file-level hook would try to close a server they
  // never started.
  afterEach(async () => {
    for (const client of openClients) client.close();
    openClients.length = 0;
    await server.close();
  });

  it('stores the map on the body, echoes it to the sender ALONE, and does not pump', async () => {
    /**
     * ═════════════════════════════════════════════════════════════════════════
     * THE THREE CLAIMS THAT MAKE A REBIND SAFE TO SEND MID-FIGHT.
     * ═════════════════════════════════════════════════════════════════════════
     *
     * STORED ON THE BODY, not on the session, because two tabs are one player:
     * the second claims the same actor and the older socket is closed with 4001,
     * so one body means one map and there is no last-writer-wins between windows.
     *
     * ECHOED TO THE SENDER ALONE, because a keymap is true for exactly one
     * person. Claim 2 above makes `broadcast` a compile error; this is the
     * runtime half — the other socket in the room hears nothing.
     *
     * AND IT DOES NOT PUMP. The world is mid-engagement here on purpose, so a
     * pump would visibly do work: the game turn would advance and the monster
     * would take a step. A settings screen must not be a way to make the server
     * advance the world — the group's own rule, and the mirror of the argument
     * against a free pickup.
     */
    server = await boot('keybinds-store');
    const ren = await connect(server.port);
    const alex = await connect(server.port);
    const body = bodyOf(await ren.hello('ren-handle'));
    await alex.hello();

    // A live fight, so a pump would be unmistakable.
    server.world.turn.engagement = 5;
    await ren.settle();
    await alex.settle();
    const clockBefore = server.world.turn.clock.gameTurn;
    const energyBefore = body.energy;
    ren.clear();
    alex.clear();

    ren.send({ t: 'set_keybinds', binds: REBOUND_KEYS });
    await ren.settle();
    await alex.settle();

    // ON THE BODY, normalised (keys sorted, arrays copied) but never trimmed.
    expect(body.keybinds).toEqual(REBOUND_KEYS);

    // ECHOED, and the echo is what the SERVER holds rather than what the client
    // hoped it sent — which is the whole reason the frame exists.
    const echo = ren.last('keybinds');
    expect(echo?.['binds']).toEqual(REBOUND_KEYS);
    expect(echo?.['persisted']).toBe(true);
    expect(ren.all('error')).toHaveLength(0);

    // AND NOBODY ELSE HEARD IT.
    expect(alex.all('keybinds')).toHaveLength(0);

    // AND THE WORLD DID NOT MOVE.
    expect(server.world.turn.clock.gameTurn).toBe(clockBefore);
    expect(body.energy).toBe(energyBefore);
    expect(ren.all('sweep')).toHaveLength(0);
    expect(ren.all('moved')).toHaveLength(0);
    expect(alex.all('sweep')).toHaveLength(0);
    expect(alex.all('moved')).toHaveLength(0);
  });

  it('flushes immediately, and the keys land in the character FILE', async () => {
    // `saveNow('keybinds')` rather than the 5s debounce, for `join`'s reason: the
    // interesting window is the seconds after somebody finishes a rebind and
    // closes the tab, which is exactly when a person who has just spent two
    // minutes on the Keys screen closes it. The label is not in `REASON_BY_LABEL`,
    // so the bridge files it as `SaveReason.Manual` through its own `??` — the
    // honest category, since a rebind is a deliberate act by a person.
    server = await boot('keybinds-flush');
    const ren = await connect(server.port);
    await ren.hello('ren-handle');
    server.disk.flushes.length = 0;

    ren.send({ t: 'set_keybinds', binds: REBOUND_KEYS });
    await ren.settle();

    expect(server.disk.flushes.map((f) => f.reason)).toContain('manual');
    const file = server.disk.files.get(`${REN_ID}/chr_main`);
    expect(file?.keybinds).toEqual(REBOUND_KEYS);
  });

  it('answers not_authenticated when the socket has no actor yet', async () => {
    // ═════════════════════════════════════════════════════════════════════════
    // THE GUARD IS DOUBLED, AND BOTH HALVES ANSWER THE SAME CODE.
    // ═════════════════════════════════════════════════════════════════════════
    //
    // The dispatch switch sits below `handleFrame`'s own `helloDone` gate, so a
    // frame that arrives before `hello` is refused there. `handleSetKeybinds`
    // narrows `session.actorId === null` ANYWAY — `handleChooseClass`'s stated
    // shape, "a narrowing, not a gate" — because the compiler needs the null gone
    // and answering honestly beats a non-null assertion. What this test pins is
    // the OUTCOME a client sees, which must be `not_authenticated` and must not
    // be a silently accepted frame that stores a keymap on nobody.
    server = await boot('keybinds-anon-gate');
    const ren = await connect(server.port);

    ren.send({ t: 'set_keybinds', binds: REBOUND_KEYS });
    const error = await ren.waitFor('error');
    expect(error?.['code']).toBe('not_authenticated');
    expect(ren.all('keybinds')).toHaveLength(0);
  });

  it('accepts an anonymous socket’s rebind, says persisted:false, and writes no file', async () => {
    /**
     * ═════════════════════════════════════════════════════════════════════════
     * ANONYMOUS PLAY GETS THE FEATURE. IT JUST DOES NOT GET TO KEEP IT, AND THE
     * FRAME SAYS SO IN A FIELD RATHER THAN LEAVING IT TO BE DISCOVERED.
     * ═════════════════════════════════════════════════════════════════════════
     *
     * This is forced rather than chosen. `openCharacter` is the only thing in the
     * process that ever creates a binding and it is called only for somebody a
     * server-side `GET /users/@me` has named; an unbound actor is dropped by
     * `owned()` in the bridge. So there is no file to write to, and refusing the
     * rebind instead would break plain-browser development and tools/e2e-m1.mjs —
     * the same argument the class picker already makes for offering itself to an
     * anonymous socket.
     *
     * `persisted: false` IS THE PART THAT COSTS NOTHING AND SAVES AN EVENING.
     * Without it, the first plain-browser session reports the whole persistence
     * feature as broken, which is a cost this codebase has already paid twice for
     * the same shape of silence.
     */
    server = await boot('keybinds-anonymous');
    const ren = await connect(server.port);
    // NO sessionId: nothing verified this socket, so there is no owner and no file.
    const body = bodyOf(await ren.hello());
    ren.clear();

    ren.send({ t: 'set_keybinds', binds: REBOUND_KEYS });
    await ren.settle();

    // ACCEPTED. It works for the rest of the session, which is the point.
    expect(body.keybinds).toEqual(REBOUND_KEYS);
    expect(ren.all('error')).toHaveLength(0);

    // AND THE FRAME TELLS THE TRUTH ABOUT WHAT HAPPENS NEXT.
    expect(ren.last('keybinds')?.['persisted']).toBe(false);

    // AND NOTHING REACHED A FILE. Not a flush, not a scheduled write, not a byte.
    expect(server.disk.flushes).toHaveLength(0);
    expect(server.disk.files.size).toBe(0);
  });

  it('sends a keybinds frame on hello, before the socket has asked for anything', async () => {
    // UNCONDITIONAL, in the block that already sends progress / class_options /
    // party_state / inventory, and for the block's own stated reason: THIS SOCKET
    // HAS SEEN NOTHING YET. `{}` is a real answer here rather than a reason to
    // stay silent — it tells a Keys screen that the server holds no overrides,
    // which a client that drew its defaults and waited would never learn.
    server = await boot('keybinds-hello');
    const first = await connect(server.port);
    await first.hello('ren-handle');

    const fresh = await first.waitFor('keybinds');
    expect(fresh).toBeDefined();
    expect(fresh?.['binds']).toEqual({});
    expect(fresh?.['persisted']).toBe(true);

    // AND A RETURNING PLAYER GETS WHAT THEY SET. The rebind, a fresh socket, and
    // the map comes back off the file through the real bridge — which is the one
    // sentence the whole feature is.
    first.send({ t: 'set_keybinds', binds: REBOUND_KEYS });
    await first.settle();
    first.close();
    // The body is still in the world under its grace, so the second socket
    // resumes rather than re-reading the file; either way the frame must carry
    // what the server holds.
    const again = await connect(server.port);
    await again.hello('ren-handle');
    const returned = await again.waitFor('keybinds');
    expect(returned?.['binds']).toEqual(REBOUND_KEYS);
  });

  it('carries the map off the DISK onto a FRESH body after a server restart', async () => {
    /**
     * ═════════════════════════════════════════════════════════════════════════
     * THE ONE LINK THE WHOLE FEATURE RESTS ON, AND NOTHING WALKED IT.
     * ═════════════════════════════════════════════════════════════════════════
     *
     * `restoreKeybinds` is what carries a saved keymap from `CharacterRestore`
     * onto a body, and it is reached from exactly one place: `restoreProgression`,
     * which `handleHello` calls only inside `if (!resolved.resumed)`. Every other
     * test in this file and in persist.test.ts stops short of it — persist stops
     * at the bridge and never boots a gateway; the test above closes its first
     * socket with the 30s grace still running and says so in its own comment
     * ("the body is still in the world under its grace, so the second socket
     * RESUMES rather than re-reading the file"). So the entire chain could be
     * mutated to `actor.keybinds = {}` and the gate would stay green.
     *
     * That is the seam the directive names by name — "a previous pass shipped a
     * broken persistence feature under a green gate because nothing walked the
     * bridge" — and its failure is silent and then destructive: `sendKeybinds`
     * reads `body?.keybinds ?? {}`, the client's `case 'keybinds'` calls
     * `setKeymap({})`, the screen still says `persisted: true`, and the FIRST
     * rebind made afterwards uploads a map built from `{}` and overwrites the good
     * file. The player loses their keys and the save on the way out.
     *
     * ═══ HOW THE RESTART IS SPELLED ═══
     * A second `boot()` over the SAME `Disk`. The new gateway has an EMPTY world,
     * so `resolveActor` has nothing to resume, `resolved.resumed` is false, and
     * `handleHello` genuinely takes the `openCharacter` -> `restoreProgression`
     * -> `restoreKeybinds` path against bytes that came off a file.
     */
    const first = await boot('keybinds-restart');
    const before = await connect(first.port);
    await before.hello('ren-handle');
    before.send({ t: 'set_keybinds', binds: REBOUND_KEYS });
    await before.settle();

    // The bytes are on the "disk" and the process holding them is going away.
    expect(first.disk.files.get(`${REN_ID}/chr_main`)?.keybinds).toEqual(REBOUND_KEYS);
    before.close();
    await first.close();

    // A NEW SERVER, A NEW WORLD, THE SAME FILES.
    server = await boot('keybinds-restart-again', first.disk);
    const after = await connect(server.port);
    const welcome = await after.hello('ren-handle');

    // THE BODY IS FRESH — a resumed one would prove nothing, which is exactly the
    // hole the test above leaves.
    expect(String(welcome?.['selfId'])).not.toBe('');
    // ON THE BODY, off the file, through `restoreKeybinds`.
    expect(bodyOf(welcome).keybinds).toEqual(REBOUND_KEYS);
    // ...AND ON THE WIRE, in the unconditional `hello`-block frame the Keys
    // screen renders.
    const returned = await after.waitFor('keybinds');
    expect(returned?.['binds']).toEqual(REBOUND_KEYS);
    expect(returned?.['persisted']).toBe(true);
  });

  it('says persisted:false for a VERIFIED player the bridge refused to bind', async () => {
    /**
     * ═════════════════════════════════════════════════════════════════════════
     * THE ONE CASE `persisted` USED TO OVERSTATE, AND THE SCREEN COULD NOT
     * SURVIVE IT.
     * ═════════════════════════════════════════════════════════════════════════
     * `too_new` and `corrupt` are the two outcomes `openCharacter` deliberately
     * does NOT bind — the files stay on disk untouched so a human can look at
     * them, and the player carries on tonight with a throwaway body. `owned()`
     * then drops every snapshot they generate, so not one byte is written all
     * evening.
     *
     * The flag was `session.ownerId !== null && persist !== undefined`, which is
     * `true` here. The Keys screen shows its NOT SAVED warning only when
     * `!persisted`, so the one line whose entire job is to say "this will not be
     * kept" said nothing, and then made way for the quiet hint. Ten minutes of
     * rebinding, silently discarded, recoverable only by a human reading the
     * host's log.
     *
     * `isBound` closes it by asking the map `owned()` itself reads — the one
     * source of truth, queried rather than guessed at. The gateway still grows no
     * binding table of its own, which is the rule that mattered.
     */
    server = await boot('keybinds-unbound');
    server.disk.corrupt = true;
    const ren = await connect(server.port);
    await ren.hello('ren-handle');

    // VERIFIED — the identity port named them, so `ownerId` is not null and the
    // old predicate would have answered true.
    const hello = await ren.waitFor('keybinds');
    expect(hello?.['persisted']).toBe(false);

    ren.send({ t: 'set_keybinds', binds: REBOUND_KEYS });
    await ren.settle();

    // ACCEPTED AND LIVE FOR THE SESSION, exactly as an anonymous socket's is...
    expect(ren.last('keybinds')?.['binds']).toEqual(REBOUND_KEYS);
    expect(ren.all('error')).toHaveLength(0);
    // ...AND THE FRAME TELLS THE TRUTH ABOUT WHAT HAPPENS NEXT, which is the
    // whole of the fix.
    expect(ren.last('keybinds')?.['persisted']).toBe(false);
    // Corroborated by the disk: the flush ran and reached nothing.
    expect(server.disk.files.size).toBe(0);
  });

  it('writes NOTHING when a rebind changes nothing, but still echoes', async () => {
    /**
     * ═════════════════════════════════════════════════════════════════════════
     * THE ONLY `saveNow` PATH IN THE GATEWAY THAT HAD NO PRECONDITION.
     * ═════════════════════════════════════════════════════════════════════════
     * `spend_point` gates on `unspentPoints` and on the raise succeeding before it
     * flushes; `pickup` needs a real ground item and spends the turn; death,
     * recall, join and disconnect are world events a client cannot repeat. This
     * handler wrote and flushed on EVERY accepted frame — and `saveNow` writes
     * every bound player's file, each one an fsync'd atomic write plus a full
     * `.bak` copy. `set_keybinds` is charged one token like any other frame, so a
     * looping client sustained 20 of those a second indefinitely, rewriting and
     * rotating the backups of four people who did nothing, with `runExclusive`
     * growing an unbounded promise chain for `flush()` to drain at shutdown.
     * Nothing downstream could dedupe it either: `saveCharacter` stamps a fresh
     * `updatedAt` before serialising, so the bytes differ every time.
     *
     * THE ECHO IS NOT PART OF THE FIX. The frame's contract is that the screen
     * renders what the SERVER holds, and a client that resent an unchanged map is
     * still owed that answer.
     */
    server = await boot('keybinds-idempotent');
    const ren = await connect(server.port);
    await ren.hello('ren-handle');

    ren.send({ t: 'set_keybinds', binds: REBOUND_KEYS });
    await ren.settle();
    const flushesAfterTheRealChange = server.disk.flushes.length;
    expect(flushesAfterTheRealChange).toBeGreaterThan(0);
    ren.clear();

    // The same map, five more times — a stuck client, or a patched one.
    for (let i = 0; i < 5; i += 1) ren.send({ t: 'set_keybinds', binds: REBOUND_KEYS });
    await ren.settle();

    // NOT ONE MORE WRITE.
    expect(server.disk.flushes).toHaveLength(flushesAfterTheRealChange);
    // ...AND FIVE MORE ECHOES, because the contract is unchanged.
    expect(ren.all('keybinds')).toHaveLength(5);
    expect(ren.last('keybinds')?.['binds']).toEqual(REBOUND_KEYS);
    expect(ren.all('error')).toHaveLength(0);

    // AND A GENUINE CHANGE STILL FLUSHES IMMEDIATELY — the check is idempotence,
    // not a debounce, and the seconds after a rebind are exactly the window
    // `saveNow` exists for.
    ren.send({ t: 'set_keybinds', binds: { move_north: ['key:q'] } });
    await ren.settle();
    expect(server.disk.flushes.length).toBe(flushesAfterTheRealChange + 1);
    expect(server.disk.files.get(`${REN_ID}/chr_main`)?.keybinds).toEqual({
      move_north: ['key:q'],
    });
  });
});

// ===========================================================================
// 4. THE TWO VERSIONS, PINNED
// ===========================================================================

describe('neither version number moves for a keyboard preference', () => {
  it('did not move PROTOCOL_VERSION, which has since moved for something else', () => {
    // A bump is forced by what an OLD CLIENT would silently get WRONG, never by
    // an addition it can ignore (protocol.ts:127-128). `set_keybinds` is inbound,
    // so an older client never sends one; `keybinds` is outbound and
    // `applyServerMessage` has no `default:` arm, so a client that cannot name it
    // drops it and keeps its compiled defaults. No field narrowed, no `TurnEvent`
    // variant, no `ErrorCode` member, and nothing writes a keymap on behalf of a
    // client that did not send one — so there is no v8-style one-way door either.
    // Bumping would have refused every shipped client for none of that.
    //
    // ═══ THIS ASSERTION IS ABOUT A CAUSE, NOT ABOUT A NUMBER ═══
    // The constant was 10 when this suite was written and is 11 now, moved by
    // the overworld's `realm` frame — the first frame other than `welcome` to
    // carry a `LevelView`. That is somebody else's bump and it does not weaken
    // the argument above; keybinds still did not force one.
    //
    // So this pins the FLOOR rather than the value. Re-pinning it to today's
    // number on every unrelated bump is how a test quietly turns into a
    // restatement of the constant, which proves nothing and fails for reasons
    // that have nothing to do with keyboards. What must never happen is the
    // version moving BECAUSE of a keyboard preference, and the guard for that is
    // the changelog entry in src/shared/version.ts, which names its own cause.
    expect(PROTOCOL_VERSION).toBeGreaterThanOrEqual(10);
  });

  it('SCHEMA_VERSION stays 1', () => {
    // docs/data-schemas.md:48-49, verbatim: "Adding an *optional* field needs no
    // bump; the bump is for renames, semantic changes, and new required fields."
    // `keybinds` is optional on `CharacterFile`, `migrateDoc` compares nothing but
    // this integer, and a v1 file without the key loads untouched. The trade is
    // the most lopsided in the file: not bumping costs a rebind if somebody rolls
    // a build back, bumping QUARANTINES the character in every older build.
    expect(SCHEMA_VERSION).toBe(1);
  });
});

// ===========================================================================
// 5. THE WIRE CAPS AND THE DISK CAPS, PINNED EQUAL
// ===========================================================================

describe('the disk caps are never tighter than the wire caps', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * TWO SETS OF FOUR NUMBERS, IN TWO FILES, AND ONLY ONE OF THEM CAN BE EXPORTED.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * persist/saves.ts declares its own `KEYBIND_*` constants module-privately,
   * because a hand-edited character file never passes through zod and the disk
   * genuinely needs its own bounds. THE RULE IS DIRECTIONAL: the disk cap must
   * never be TIGHTER than the wire cap. If it were, a map the server ACCEPTED
   * over the wire would come back REPAIRED after a reconnect, and the player
   * would watch a binding they set change by itself — which is the single most
   * confusing failure this feature can produce, because nothing errors and
   * nothing logs on the path the player is looking at.
   *
   * SO THE PIN IS BEHAVIOURAL RATHER THAN A COMPARISON OF LITERALS. A map built
   * at EXACTLY the exported caps goes through the real `createCharacterFile` and
   * the real `parseCharacterFile`, and must come back byte-identical with no
   * `problems` line. A literal assertion could not be written at all — the disk
   * constants are not exported — and would be weaker if it could, because what
   * matters is the parser's behaviour and not the number it happens to read.
   */
  const atTheCaps = (): Record<string, string[]> => {
    const binds: Record<string, string[]> = {};
    for (let action = 0; action < KEYBIND_MAX_ACTIONS; action += 1) {
      // Ids padded to exactly the character cap, and distinct.
      const id = `a${String(action).padStart(KEYBIND_ACTION_MAX_CHARS - 1, '0')}`;
      binds[id] = Array.from({ length: KEYBIND_KEYS_PER_ACTION }, (_, slot) =>
        `k${String(slot)}`.padEnd(KEYBIND_KEYSTRING_MAX_CHARS, 'x'),
      );
    }
    return binds;
  };

  const fileWith = (binds: Record<string, string[]>): CharacterFile =>
    createCharacterFile({
      id: 'chr_main',
      ownerId: REN_ID,
      name: 'Ren',
      classId: 'watchman',
      keybinds: binds,
      resources: { hp: 30, ap: 0, mp: 0, special: { kind: '', value: 0 } },
      createdAt: '2026-01-01T00:00:00.000Z',
    });

  it('accepts a map built at exactly the wire caps, unrepaired and complete', () => {
    const binds = atTheCaps();
    expect(Object.keys(binds)).toHaveLength(KEYBIND_MAX_ACTIONS);

    const parsed = parseCharacterFile(JSON.parse(JSON.stringify(fileWith(binds))));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    // NOT ONE COMPLAINT. A `problems` line here would mean the disk is tighter
    // than the wire somewhere, and the player would find out on a reconnect.
    expect(parsed.problems.filter((p) => p.includes('keybinds'))).toEqual([]);
    expect(parsed.file.keybinds).toEqual(binds);
  });

  it('and is not LOOSER either — one over any cap is repaired on the way in', () => {
    // The other direction is not a correctness hazard (the wire refuses it before
    // the disk ever sees it) but it is the half that proves the two sets are the
    // SAME numbers rather than merely compatible ones. Each case is one step over
    // exactly one cap.
    const overActions = atTheCaps();
    overActions['one_action_too_many'] = ['key:a'];
    const a = parseCharacterFile(JSON.parse(JSON.stringify(fileWith(overActions))));
    expect(a.ok && Object.keys(a.file.keybinds ?? {})).toHaveLength(KEYBIND_MAX_ACTIONS);

    const overId = { ['a'.repeat(KEYBIND_ACTION_MAX_CHARS + 1)]: ['key:a'] };
    const b = parseCharacterFile(JSON.parse(JSON.stringify(fileWith(overId))));
    expect(b.ok && b.file.keybinds).toEqual({});

    const overKeys = {
      move_north: Array.from({ length: KEYBIND_KEYS_PER_ACTION + 1 }, (_, i) => `key:${String(i)}`),
    };
    const c = parseCharacterFile(JSON.parse(JSON.stringify(fileWith(overKeys))));
    expect(c.ok && c.file.keybinds?.['move_north']).toHaveLength(KEYBIND_KEYS_PER_ACTION);

    const overString = { move_north: ['k'.repeat(KEYBIND_KEYSTRING_MAX_CHARS + 1)] };
    const d = parseCharacterFile(JSON.parse(JSON.stringify(fileWith(overString))));
    expect(d.ok && d.file.keybinds).toEqual({ move_north: [] });
  });
});
