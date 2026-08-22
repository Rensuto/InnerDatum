import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';

import Fastify from 'fastify';

import {
  ALCHEMIST,
  INSPECTOR,
  WATCHMAN,
  CLASSES,
  classById,
  createContentTalentEngine,
  createTalentBook,
  sheetForClass,
} from '../../src/server/content/classes.ts';
import { talentRuntimeFor } from '../../src/server/main.ts';
import { wsGateway } from '../../src/server/net/gateway.ts';
import {
  LoadOutcome,
  SOLO_CHARACTER_ID,
  SaveOutcome,
  UNASSIGNED_CLASS,
  createCharacterBridge,
  createCharacterFile,
} from '../../src/server/persist/saves.ts';
import { StandingOrder } from '../../src/server/engine/actor.ts';
import { REAGENT_REGEN_EVERY_TURNS } from '../../src/server/engine/talents.ts';
import { createTurnEngine } from '../../src/server/turn-engine.ts';
import { createWorld } from '../../src/server/world/world.ts';
import { ActorKind, TileCode } from '../../src/shared/protocol.ts';
import { PROTOCOL_VERSION } from '../../src/shared/version.ts';
import type { PlayerActor } from '../../src/server/engine/actor.ts';
import type { TalentEngine } from '../../src/server/engine/talents.ts';
import type { CharacterRestore, IdentityPort, PersistPort } from '../../src/server/net/gateway.ts';
import { RetireOutcome } from '../../src/server/persist/saves.ts';
import type {
  CharacterFile,
  CharacterHeader,
  LoadResult,
  RetireResult,
  SaveStore,
} from '../../src/server/persist/saves.ts';
import type { World } from '../../src/server/world/world.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHO OWES A CHOICE, WHAT HAPPENS WHEN THEY MAKE IT, AND WHAT MUST NOT.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Until this milestone a player's class was ASSIGNED: a persisted id if there
 * was one, otherwise a per-process rotation over the three `CLASSES`. That
 * rotation is unchanged and still clothes every joining body — THE BODY IS
 * NEVER CLASSLESS, because a token appears on four other screens the instant
 * `world.addPlayer` returns and it has to arrive wearing something. What is new
 * is that a player who has never chosen gets to REPLACE that provisional
 * assignment, once, before their body has done anything.
 *
 * ═══ THE FOUR CLAIMS, AND WHY EACH ONE IS HERE RATHER THAN OBVIOUS ═══
 *
 *   1. WHO IS ASKED. Three states of a character file mean "nobody has ever
 *      picked" — no file at all, a null `classId`, and the `UNASSIGNED_CLASS`
 *      sentinel that EVERY file written before classes existed holds. A fourth
 *      state looks identical to the wrong predicate and must NOT be asked: a
 *      DANGLING id, a file naming a class this build renamed. That inversion is
 *      the sharpest hazard in the feature and it has a test of its own below.
 *
 *   2. THE SERVER DECIDES. The frame names a class and nothing else — no actor
 *      id, no target — and the server refuses an id it does not have
 *      (`bad_message`) and a body that has already chosen (`not_your_turn`).
 *
 *   3. A SECOND CHOICE IS A FREE SECOND WIND. `talentEngine.attach` ends in an
 *      unconditional `sheets.set` (engine/talents.ts:872-875), so accepting a
 *      second `choose_class` would hand back a FULL resource pool, mid-fight, to
 *      anybody with a devtools console. The wire cannot express that rule — the
 *      frame is legal and the id is real — so the refusal is the whole of it,
 *      and the test asserts those NUMBERS rather than the absence of a frame.
 *      The health half of that exploit is closed a second way as well, in
 *      section 4: `reclothePlayer` used to set `hp = maxHp` unconditionally on
 *      the argument that the body was "undamaged by construction", which is
 *      false for every returning player and for anybody hit while the modal is
 *      up. It now fills only a body that was already whole.
 *
 *   4. IT PERSISTS, AND THEN IT IS OVER. The chosen id reaches
 *      `CharacterFile.classId` on an immediate flush rather than the five-second
 *      debounce, and the next connection finds it and is never shown the screen
 *      again.
 *
 * ═══ WHY THIS FILE DRIVES A REAL SOCKET, A REAL ENGINE AND A REAL BRIDGE ═══
 * Every claim above is about the ORDER of private steps inside the gateway:
 * nothing exports `classChoiceOwed`, nothing exports `classFor`, and the only
 * place either is observable is the frames a socket receives and the body a
 * `hello` leaves in the world. The talent engine is the real one because claim 3
 * is a statement about `sheetOf(...).resource.value` and a stub would be a
 * test of the stub. The persistence bridge is the real one because claim 4 is a
 * statement about a `CharacterFile` field; only the DISK is faked, and it is
 * faked as a Map rather than a temp directory because where the bytes land is
 * test/server/saves-identity.test.ts's question, not this file's.
 */

/** Snowflake-SHAPED, and nobody's real id. */
const REN_ID = '222222222222222222';
const ALEX_ID = '444444444444444444';

/** How long a `waitFor` waits before deciding a frame is never coming. */
const FRAME_TIMEOUT_MS = 2_000;

/** ISO stamps are injected so nothing here depends on a clock. */
const FIXED_NOW = '2026-01-01T00:00:00.000Z';

// ---------------------------------------------------------------------------
// The socket harness
// ---------------------------------------------------------------------------

type Frame = Record<string, unknown>;

type Client = {
  readonly frames: readonly Frame[];
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
      // The pong is consumed so a second `settle` cannot match the first one's.
      frames = frames.filter((frame) => frame['t'] !== 'pong');
    },
    waitFor,
    all: (type: string): Frame[] => frames.filter((frame) => frame['t'] === type),
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
// The server: the real gateway, the real engine, the real bridge, a Map for a disk
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
 * A `SaveStore` whose disk is a Map, keyed exactly as the real one keys a path.
 *
 * The REAL `createCharacterBridge` sits on top of it, which is what makes
 * "the chosen id reaches `CharacterFile.classId`" a claim about the shipped
 * `fileFor` rather than about a test double: the bridge's own rule is
 * `snapshot.classId ?? binding.classId` (saves.ts:1189), and a test that
 * recorded the SNAPSHOT would pass whether or not that line existed.
 */
type Disk = {
  /** `<ownerId>/<characterId>` -> the last file written there. */
  readonly files: Map<string, CharacterFile>;
  /** Every immediate write, in order, with the reason the gateway gave. */
  readonly flushes: { readonly key: string; readonly reason: string }[];
  /** Files written through the DEBOUNCED path. Should stay empty for a choice. */
  readonly scheduled: string[];
  readonly store: SaveStore;
};

function disk(): Disk {
  const files = new Map<string, CharacterFile>();
  const flushes: { key: string; reason: string }[] = [];
  const scheduled: string[] = [];
  const keyOf = (ownerId: string, characterId: string): string => `${ownerId}/${characterId}`;

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
      const file = files.get(keyOf(ownerId, characterId));
      if (file === undefined) {
        return Promise.resolve({
          outcome: LoadOutcome.Missing,
          file: null,
          migrated: false,
          problems: [],
        });
      }
      return Promise.resolve({
        outcome: LoadOutcome.Loaded,
        file,
        migrated: false,
        problems: [],
      });
    },
    saveCharacter: (file: CharacterFile, reason: string) => {
      const key = keyOf(file.ownerId, file.id);
      files.set(key, file);
      flushes.push({ key, reason });
      return Promise.resolve({ outcome: SaveOutcome.Written, path: key });
    },
    scheduleCharacter: (file: CharacterFile): void => {
      const key = keyOf(file.ownerId, file.id);
      files.set(key, file);
      scheduled.push(key);
    },
    flush: (): Promise<void> => Promise.resolve(),
    close: (): Promise<void> => Promise.resolve(),
    pendingCount: (): number => 0,
  };

  return { files, flushes, scheduled, store };
}

type Harness = {
  readonly port: number;
  readonly world: World;
  readonly disk: Disk;
  /** The REAL talent engine, so a resource pool can be read directly. */
  readonly talents: TalentEngine;
  close(): Promise<void>;
};

type BootOptions = {
  /**
   * How long a dropped body waits before it is recalled. Thirty seconds for
   * every test but the reconnect one, which needs the body genuinely GONE from
   * the world so that a second `hello` re-reads the file rather than taking the
   * resume path.
   */
  readonly graceMs?: number;
  /**
   * Replaces the bridge's own `openCharacter` with a fixed answer.
   *
   * ONE TEST NEEDS THIS AND ONLY ONE. `CharacterRestore.classId` is
   * `string | null` and the gateway's three-valued read has a branch for the
   * null — but the shipped bridge can never produce it, because
   * `CharacterFile.classId` is a required non-empty `string` and the parser
   * refuses a file without one (saves.ts:480-481). The null is a property of the
   * PORT rather than of the file: another implementation, or a build with no
   * class column, is entitled to answer it, and the gateway must not then decide
   * the player has already chosen. Faking it as a file would be inventing bytes
   * the real store would reject; faking it at the port is the honest seam.
   *
   * NOTHING BINDS on this path — `openCharacter` is what registers a save
   * binding — so a test using it must not also make a claim about persistence.
   */
  readonly restore?: () => CharacterRestore | null;
};

async function boot(seed: string, options: BootOptions = {}): Promise<Harness> {
  const app = Fastify({ logger: false });
  const world = createWorld(seed);
  // Wall to wall floor: nothing in this file is about terrain, and a spawn
  // search that has to dodge a pillar would make placement a variable.
  world.level.tiles.fill(TileCode.FLOOR);

  const store = disk();
  const talents = createContentTalentEngine();
  const engine = createTurnEngine({
    world,
    now: () => 0,
    talents: createTalentBook(talents, world),
    talentRuntime: talentRuntimeFor(talents, world),
  });

  const bridge = createCharacterBridge({
    store: store.store,
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    now: () => FIXED_NOW,
  });
  const override = options.restore;
  const persist: PersistPort =
    override === undefined
      ? bridge
      : { ...bridge, openCharacter: () => Promise.resolve(override()) };

  await app.register(wsGateway, {
    world,
    engine: {
      ...engine,
      // The two lines src/server/main.ts writes. The gateway may not import
      // engine/talents.ts — it states its engine contract structurally — so the
      // capability is injected by whoever can see both sides. `handleChooseClass`
      // reaches the sheet through exactly this seam and no other.
      attachClass: (actorId: string, classId: string): void => {
        const definition = classById(classId);
        if (definition !== undefined) talents.attach(actorId, sheetForClass(definition));
      },
    },
    sessions: identityPort(),
    persist,
    disconnectGraceMs: options.graceMs ?? 30_000,
  });
  await app.listen({ host: '127.0.0.1', port: 0 });

  const address = app.server.address();
  if (address === null || typeof address === 'string') throw new Error('no port was bound');

  return {
    port: address.port,
    world,
    disk: store,
    talents,
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

/**
 * The body behind a `welcome`, read out of the world and narrowed to a PLAYER.
 *
 * `classId` lives on `PlayerActor` alone — a monster has no class — so the
 * discriminant is what makes the field reachable at all.
 */
function bodyOf(welcome: Frame | undefined): PlayerActor {
  const id = String(welcome?.['selfId']);
  const actor = server.world.getActor(id);
  if (actor === undefined) throw new Error(`test fixture: no actor for ${id}`);
  if (actor.kind !== ActorKind.Player) throw new Error(`test fixture: ${id} is not a player`);
  return actor;
}

/**
 * Put a file on the fake disk for a verified account, exactly where
 * `openCharacter` will look for it.
 *
 * Built through the REAL `createCharacterFile` rather than as an object literal
 * with a cast: it stamps the schema version and the kind, so a fixture here
 * cannot drift from what the store would actually have read back.
 *
 * `classId` is a bare `string` rather than a `ClassId`, which is the same choice
 * the field itself makes — it is a SOFT reference (saves.ts), and half of what
 * this file tests is what happens when the value is the `unassigned` sentinel or
 * a name no build has any more. A narrowed parameter could express neither.
 */
function fileOnDisk(discordUserId: string, classId: string): void {
  server.disk.files.set(
    `${discordUserId}/${SOLO_CHARACTER_ID}`,
    createCharacterFile({
      id: SOLO_CHARACTER_ID,
      ownerId: discordUserId,
      name: 'Ren',
      classId,
      resources: { hp: 30, ap: 0, mp: 0, special: { kind: '', value: 0 } },
      position: { zoneId: 'zone:test_level', depth: 0, cell: [5, 5] },
      createdAt: FIXED_NOW,
    }),
  );
}

// ===========================================================================
// 1. WHO IS OFFERED THE SCREEN
// ===========================================================================

describe('who owes a class choice', () => {
  it('offers the picker to a first-ever join, with all three classes on it', async () => {
    server = await boot('choice-first-join');

    const client = await connect(server.port);
    const welcome = await client.hello('ren-handle');
    const options = await client.waitFor('class_options');

    // THE BODY IS ALREADY CLOTHED. The rotation dressed it before the frame
    // went out — there is no window in which a token stands on the map with no
    // sprite and no maxHp, because everybody else can already see it.
    expect(bodyOf(welcome).classId).toBe(WATCHMAN.id);

    const rows = options?.['options'];
    if (!Array.isArray(rows)) throw new Error('the class_options frame carried no options');
    /**
     * EVERY CLASS THAT SHIPS, IN THE ORDER `CLASSES` LISTS THEM — built from the
     * registry rather than spelled out.
     *
     * The property is that the picker offers ALL of them and offers them in the
     * order the content declares. A literal states neither: it silently becomes
     * a partial list the day a class is added, which is the one day the picker
     * is most likely to be missing one. This spelled out three and the Redactor
     * made it four.
     */
    expect(rows.map((row: { id?: unknown }) => String(row.id))).toEqual(
      CLASSES.map((definition) => definition.id),
    );
  });

  it('offers it when the restore names no class at all', async () => {
    // The MIDDLE value of the three-valued read: a file was found and it says
    // nothing about a class. Driven through the PORT rather than through a file
    // on the fake disk, because the shipped bridge cannot produce this —
    // `CharacterFile.classId` is a required non-empty string and the parser
    // refuses a file without one (saves.ts:480-481). `CharacterRestore.classId`
    // is nonetheless `string | null`, so the branch is part of the contract the
    // gateway signed, and "we never take that branch today" is exactly how a
    // branch rots into one that does the wrong thing. See `BootOptions.restore`.
    server = await boot('choice-null-class', {
      restore: () => ({ hp: 30, cooldowns: {}, classId: null }),
    });

    const client = await connect(server.port);
    await client.hello('ren-handle');

    expect(await client.waitFor('class_options')).toBeDefined();
  });

  it('offers it to a file holding the `unassigned` sentinel', async () => {
    // ═══ THE ORDINARY CASE, NOT AN EDGE CASE ═══
    // `fileFor` wrote `UNASSIGNED_CLASS` unconditionally before classes were
    // wired in, so EVERY character file already on disk holds this exact string.
    // If the sentinel did not open the chooser, the feature would ship to
    // precisely nobody who has played before.
    server = await boot('choice-unassigned');
    fileOnDisk(REN_ID, UNASSIGNED_CLASS);

    const client = await connect(server.port);
    await client.hello('ren-handle');

    expect(await client.waitFor('class_options')).toBeDefined();
  });

  it('does NOT offer it to a file that names a class this build has', async () => {
    server = await boot('choice-resolvable');
    fileOnDisk(REN_ID, ALCHEMIST.id);

    const client = await connect(server.port);
    const welcome = await client.hello('ren-handle');
    await client.settle();

    expect(bodyOf(welcome).classId).toBe(ALCHEMIST.id);
    expect(client.all('class_options')).toEqual([]);
  });

  it('does NOT offer it for a DANGLING id — the inversion hazard', async () => {
    // ═══════════════════════════════════════════════════════════════════════
    // THE SHARPEST HAZARD IN THE FEATURE, AND THE ONE WITH A PRECEDENT.
    // ═══════════════════════════════════════════════════════════════════════
    //
    // `classById(saved) === undefined` is the WRONG predicate for "nobody has
    // chosen", because it answers `undefined` for BOTH `'unassigned'` AND a
    // class this build renamed or deleted. persist/saves.ts:1110-1124 records
    // what that confusion already cost once: the dangling-class WARNING — whose
    // stated purpose is to be the only evidence a class was renamed — fired for
    // every returning player on the first evening after deploy.
    //
    // Reusing it here would be the same mistake with far sharper teeth. On the
    // day somebody renames a class id, every returning player is shown a
    // chooser, and the accept path then OVERWRITES their file with whatever they
    // pick. A save is not recoverable from a screen they were never meant to
    // see.
    //
    // So the substitute-and-log path is kept exactly as it was: a stand-in class
    // for tonight, a warn line for whoever renamed it, and NO chooser.
    server = await boot('choice-dangling');
    fileOnDisk(REN_ID, 'class_deleted_in_m6');

    const client = await connect(server.port);
    const welcome = await client.hello('ren-handle');
    await client.settle();

    // Substituted, so they can play — that half is class-wiring.test.ts's.
    expect(bodyOf(welcome).classId).toBe(WATCHMAN.id);
    // And NOT asked. This is the assertion the whole test exists for.
    expect(client.all('class_options')).toEqual([]);
  });

  it('does NOT offer it to a resumed body', async () => {
    // A resume short-circuits before the file is even consulted: both re-attach
    // paths in `resolveActor` return `{ resumed: true }` under the stated rule
    // "NOTHING ELSE IS RE-ATTACHED HERE". The body kept the class it was built
    // with, so there is nothing to choose.
    server = await boot('choice-resumed');

    const first = await connect(server.port);
    const welcome = await first.hello('ren-handle');
    const body = bodyOf(welcome);
    // They answered the picker, so nobody owes anything any more.
    first.send({ t: 'choose_class', classId: INSPECTOR.id });
    await first.settle();
    first.close();

    // A SECOND SOCKET FOR THE SAME ACCOUNT, while the body is still in the
    // world. Identity wins outright over everything else, so this reattaches.
    const again = await connect(server.port);
    const rejoined = await again.hello('ren-handle');
    await again.settle();

    expect(String(rejoined?.['selfId'])).toBe(body.id);
    expect(again.all('class_options')).toEqual([]);
  });

  it('is unicast — a second player joining tells the first nothing', async () => {
    // ═══ `ClassOptionsMsg` IS A `ViewerMsg`, AND STRUCTURALLY SO ═══
    // `broadcast(projectClassOptions())` does not compile. What is per-viewer is
    // not the CONTENT — the frame is byte-identical for everybody, which is why
    // `projectClassOptions` takes no arguments — but whether it arrives at all.
    // Handed to the room it would drop a modal chooser in front of people who
    // are mid-fight and have had a class for a week.
    server = await boot('choice-unicast');

    const ren = await connect(server.port);
    await ren.hello('ren-handle');
    expect(await ren.waitFor('class_options')).toBeDefined();
    expect(ren.all('class_options')).toHaveLength(1);

    const alex = await connect(server.port);
    await alex.hello('alex-handle');
    expect(await alex.waitFor('class_options')).toBeDefined();
    await ren.settle();

    // Alex owes a choice and was offered one. Ren was offered one exactly once,
    // at their own `hello`, and Alex arriving added nothing.
    expect(alex.all('class_options')).toHaveLength(1);
    expect(ren.all('class_options')).toHaveLength(1);
  });
});

// ===========================================================================
// 2. THE HANDLER — WHAT IS REFUSED, AND WHAT AN ACCEPT DOES
// ===========================================================================

describe('choose_class, refused', () => {
  it('answers `bad_message` for a class this build does not have, and changes nothing', async () => {
    // ═══ ZOD ACCEPTS THIS FRAME ON PURPOSE ═══
    // `ChooseClassSchema` validates `classId` as a bounded string rather than a
    // `z.enum` of the three ids, following `TalentSchema`'s stated precedent:
    // baking the catalogue into the wire schema would make every content edit a
    // PROTOCOL change. So the server's own `classById` lookup is the ONLY thing
    // refusing it, and `bad_message` is the honest code — no picker this server
    // sent could have produced the id.
    server = await boot('choice-unknown-id');

    const client = await connect(server.port);
    const welcome = await client.hello('ren-handle');
    const body = bodyOf(welcome);
    const before = { sprite: body.sprite, maxHp: body.maxHp, classId: body.classId };
    await client.waitFor('class_options');
    client.clear();

    client.send({ t: 'choose_class', classId: 'class_that_never_existed' });
    const error = await client.waitFor('error');

    expect(error?.['code']).toBe('bad_message');
    expect({ sprite: body.sprite, maxHp: body.maxHp, classId: body.classId }).toEqual(before);
    // AND THE OFFER STANDS. A rejected id must not consume the one choice — a
    // hand-crafted frame from somebody else's console would otherwise lock a
    // player out of the screen they still need.
    expect(client.all('state')).toEqual([]);
    client.send({ t: 'choose_class', classId: ALCHEMIST.id });
    await client.settle();
    expect(body.classId).toBe(ALCHEMIST.id);
  });

  it('answers `not_your_turn` to a body that has already chosen', async () => {
    server = await boot('choice-twice');

    const client = await connect(server.port);
    const welcome = await client.hello('ren-handle');
    const body = bodyOf(welcome);
    await client.waitFor('class_options');

    client.send({ t: 'choose_class', classId: ALCHEMIST.id });
    await client.settle();
    expect(body.classId).toBe(ALCHEMIST.id);
    client.clear();

    client.send({ t: 'choose_class', classId: WATCHMAN.id });
    const error = await client.waitFor('error');

    // "Not now", the same shape `handleRespawn` refuses with. No new ErrorCode
    // member: version.ts's 7 -> 8 entry states in writing that reusing the two
    // existing codes is what keeps the bump argument to a single reason.
    expect(error?.['code']).toBe('not_your_turn');
    expect(body.classId).toBe(ALCHEMIST.id);
  });

  it('does not refill the resource pool or top the body up on the refused second choice', async () => {
    // ═══════════════════════════════════════════════════════════════════════
    // THE RULE THE WIRE CANNOT EXPRESS, ASSERTED ON THE NUMBERS THEMSELVES.
    // ═══════════════════════════════════════════════════════════════════════
    //
    // TWO THINGS AN ACCEPTED SECOND CHOICE WOULD HAND OUT FREE, and they come
    // from the two halves of the accept path:
    //
    //   THE RESOURCE POOL. `TalentEngine.attach` ends in an unconditional
    //   `sheets.set` (engine/talents.ts:872-875) — it does not merge and it does
    //   not ask whether a sheet is already there — so a second attach replaces a
    //   spent sheet with a freshly minted one at its starting value.
    //
    //   THE HEALTH. `reclothePlayer` used to set `hp = maxHp` outright, which
    //   would be a full heal on demand, from anywhere, mid-fight. It now fills
    //   only a body that was already at its ceiling — see section 4 — so this
    //   half is belt AND braces: the membership test refuses the frame, and the
    //   world would refuse the heal even if it did not.
    //
    // The frame is LEGAL and the id is REAL, so neither zod nor `classById` can
    // see either one coming. The membership test in `handleChooseClass` is the
    // entire defence, and both consequences are NUMBERS rather than frames —
    // which is why this asserts the sheet and the body directly rather than
    // counting errors.
    //
    // COOLDOWNS ARE ASSERTED TOO, and honestly labelled: they live on the ACTOR
    // rather than on the sheet, so neither half of the accept path clears them
    // and they would survive even an accepted second choice. That is exactly why
    // pinning them is worth the line — it is the invariant most likely to be
    // broken by a future edit that decides re-clothing should reset "everything".
    server = await boot('choice-no-refill');

    const client = await connect(server.port);
    const welcome = await client.hello('ren-handle');
    const body = bodyOf(welcome);
    await client.waitFor('class_options');

    client.send({ t: 'choose_class', classId: ALCHEMIST.id });
    await client.settle();

    // Take a beating, spend the pool, put a talent on cooldown — a fight.
    const sheet = server.talents.sheetOf(body.id);
    if (sheet === undefined) throw new Error('test fixture: the accepted choice attached no sheet');
    const spent = sheet.resource.value - 1;
    sheet.resource.value = spent;
    sheet.resource.regenCounter = 0;
    body.hp = 9;
    body.cooldowns.set('talent:mend_wounds', 4);

    client.send({ t: 'choose_class', classId: ALCHEMIST.id });
    await client.settle();

    // The SAME sheet object, still spent; the same battered body.
    expect(server.talents.sheetOf(body.id)).toBe(sheet);
    // ═══ THE TURN COUNT IS PINNED, BECAUSE REAGENTS NOW REFILL ON A TIMER ═══
    // The pool is one below its cap, so `regenCounter` runs, and after
    // `REAGENT_REGEN_EVERY_TURNS` base turns the stock would come back by one
    // ALL ON ITS OWN — which would read here as "the second choice refilled
    // her", the exact bug this test exists to catch, arriving from the wrong
    // direction. The counter is zeroed above and asserted below, so this stays
    // a statement about `handleChooseClass` rather than about how long a settle
    // happens to take today.
    expect(sheet.resource.regenCounter).toBeLessThan(REAGENT_REGEN_EVERY_TURNS);
    expect(sheet.resource.value).toBe(spent);
    expect(body.hp).toBe(9);
    expect(body.cooldowns.get('talent:mend_wounds')).toBe(4);
  });
});

describe('choose_class, accepted', () => {
  it('re-clothes the body wholesale and fills it to the new maximum', async () => {
    server = await boot('choice-accepted');

    const client = await connect(server.port);
    const welcome = await client.hello('ren-handle');
    const body = bodyOf(welcome);
    // Provisionally a Watchman, and standing somewhere in particular.
    expect(body.classId).toBe(WATCHMAN.id);
    const where = { x: body.x, y: body.y };
    await client.waitFor('class_options');

    client.send({ t: 'choose_class', classId: ALCHEMIST.id });
    await client.settle();

    // EVERY FIELD, from the `ClassDef`. Half a class blended with the previous
    // one is a body nobody authored — the same rule `addPlayer`'s overlay obeys.
    expect(body.classId).toBe(ALCHEMIST.id);
    expect(body.sprite).toBe(ALCHEMIST.sprite);
    expect(body.maxHp).toBe(ALCHEMIST.maxHp);
    expect(body.combat).toBe(ALCHEMIST.combat);
    expect(body.hpRegen).toBe(ALCHEMIST.hpRegen);
    // FULL, at the NEW ceiling: the choice happens at character creation, so the
    // body is undamaged by construction and there is nothing to carry across.
    expect(body.hp).toBe(ALCHEMIST.maxHp);
    // AND IT DID NOT MOVE. Neither the tile nor the name is a property of a
    // class, and re-running placement would teleport a token other people are
    // already looking at.
    expect({ x: body.x, y: body.y }).toEqual(where);
    expect(body.name).toBe('Ren');
  });

  it('resends the hotbar, the cooldowns and the board', async () => {
    server = await boot('choice-refresh');

    const client = await connect(server.port);
    const welcome = await client.hello('ren-handle');
    const body = bodyOf(welcome);
    await client.waitFor('class_options');
    client.clear();

    client.send({ t: 'choose_class', classId: ALCHEMIST.id });
    await client.settle();

    // ═══ THE LOADOUT, AGAIN ═══
    // It is normally sent exactly ONCE per connection — but that is a property
    // of the call site in `hello`, not of `sendLoadout`, which carries no
    // once-guard. Without this the player would sit there pressing the
    // Watchman's four buttons on an Alchemist's sheet until they reconnected.
    const loadout = client.all('loadout');
    expect(loadout).toHaveLength(1);
    const talents = loadout[0]?.['talents'];
    if (!Array.isArray(talents)) throw new Error('the loadout frame carried no talents');
    expect(talents.map((row: { id?: unknown }) => String(row.id))).toEqual(
      ALCHEMIST.loadout.map((talent) => talent.id),
    );

    // …and the two viewer-private frames that keep it honest: a different pool
    // with a different maximum, and the cooldown map the buttons grey out from.
    expect(client.all('cooldowns')).toHaveLength(1);
    const resource = client.all('resource')[0];
    expect((resource?.['resource'] as { kind?: unknown } | undefined)?.kind).toBe(
      ALCHEMIST.resource,
    );

    // ═══ AND THE BOARD, BECAUSE `sprite` AND `maxHp` TRAVEL ONLY ON `ActorView` ═══
    // No delta carries either one, so the whole actor list is resent — the same
    // deliberately dumb answer `needsFullResync` and the rename path both give.
    const state = client.all('state');
    expect(state).toHaveLength(1);
    const actors = state[0]?.['actors'];
    if (!Array.isArray(actors)) throw new Error('the state frame carried no actors');
    const self = actors.find((row: { id?: unknown }) => String(row.id) === body.id) as
      { sprite?: unknown; maxHp?: unknown } | undefined;
    expect(self?.sprite).toBe(ALCHEMIST.sprite);
    expect(self?.maxHp).toBe(ALCHEMIST.maxHp);
  });

  it('leaves the join rotation exactly where it was', async () => {
    // ═══════════════════════════════════════════════════════════════════════
    // A CHOSEN CLASS IS NOT A ROLLED ONE.
    // ═══════════════════════════════════════════════════════════════════════
    //
    // `classRotation`'s own note (gateway.ts) says it advances only on a fresh
    // ASSIGNMENT, because it exists to spread the FALLBACK across joiners.
    // Advancing it on a choice would skew what the next person gets — and the
    // counter is private, so the only way to observe it is to have somebody
    // else join and see what they are handed.
    server = await boot('choice-rotation');

    const ren = await connect(server.port);
    const renBody = bodyOf(await ren.hello('ren-handle'));
    // The first fresh join takes the first place in the rotation, which is now
    // at one.
    expect(renBody.classId).toBe(WATCHMAN.id);

    // Ren picks the third class. If the choice touched the counter, it would
    // move — and the assertion below would find Alex as an Alchemist.
    ren.send({ t: 'choose_class', classId: ALCHEMIST.id });
    await ren.settle();
    expect(renBody.classId).toBe(ALCHEMIST.id);

    const alex = await connect(server.port);
    expect(bodyOf(await alex.hello('alex-handle')).classId).toBe(INSPECTOR.id);
  });
});

// ===========================================================================
// 3. IT PERSISTS, AND THEN IT IS OVER
// ===========================================================================

describe('the chosen class survives the session', () => {
  it('reaches CharacterFile.classId on an IMMEDIATE write, not the debounce', async () => {
    server = await boot('choice-persisted');

    const client = await connect(server.port);
    await client.hello('ren-handle');
    await client.waitFor('class_options');
    // The `hello` flush has already happened; only the choice's write is under
    // test here.
    server.disk.flushes.length = 0;
    server.disk.scheduled.length = 0;

    client.send({ t: 'choose_class', classId: ALCHEMIST.id });
    await client.settle();

    const file = server.disk.files.get(`${REN_ID}/${SOLO_CHARACTER_ID}`);
    // THE BRIDGE'S OWN RULE IS UNDER TEST HERE, not a recorded snapshot:
    // `fileFor` writes `snapshot.classId ?? binding.classId` (saves.ts:1189),
    // and the binding still holds `unassigned` from the load. The live body has
    // to win or the choice is never written down.
    expect(file?.classId).toBe(ALCHEMIST.id);

    // ═══ IMMEDIATE, AND UNDER THE EXISTING `join` LABEL ═══
    // The five seconds a debounce would cost are precisely the window in which a
    // brand-new character has no record of what it chose to be. The label is
    // reused rather than added to `REASON_BY_LABEL` because character creation
    // IS the join — the same event, finishing a few seconds later — and
    // `REASON_BY_LABEL['join']` maps it to a manual save.
    expect(server.disk.scheduled).toEqual([]);
    expect(server.disk.flushes).toHaveLength(1);
    expect(server.disk.flushes[0]?.reason).toBe('manual');
  });

  it('is found on the next connection, and the chooser never appears again', async () => {
    // ═══ THE FULL CIRCLE, AND THE BODY MUST GENUINELY BE GONE ═══
    // A short grace so the recall really fires: while the body is still in the
    // world, identity re-attaches to it and the file is never re-read, which
    // would make this a test of the resume path instead.
    server = await boot('choice-round-trip', { graceMs: 60 });

    const first = await connect(server.port);
    const body = bodyOf(await first.hello('ren-handle'));
    await first.waitFor('class_options');
    first.send({ t: 'choose_class', classId: INSPECTOR.id });
    await first.settle();
    first.close();

    // Wait for the recall rather than for a fixed span: the claim is about what
    // a LATER connection reads off the disk, and it is only a real reconnect
    // once the body has left the world.
    const deadline = Date.now() + FRAME_TIMEOUT_MS;
    while (server.world.getActor(body.id) !== undefined && Date.now() < deadline) {
      await sleep(10);
    }
    expect(server.world.getActor(body.id)).toBeUndefined();

    const later = await connect(server.port);
    const rejoined = bodyOf(await later.hello('ren-handle'));
    await later.settle();

    // A brand-new body for the same account — and it is an Inspector because the
    // file said so, not because the rotation happened to agree. The rotation is
    // at one here, so a re-roll would produce the Inspector too; the maxHp is
    // what separates "read from the file" from "rolled again" only if they
    // differ, so the class id is asserted against the FILE as well.
    expect(rejoined.classId).toBe(INSPECTOR.id);
    expect(server.disk.files.get(`${REN_ID}/${SOLO_CHARACTER_ID}`)?.classId).toBe(INSPECTOR.id);
    // AND NO CHOOSER. A returning player is protected by the file alone: the
    // set that tracks who owes a choice is per-process and was cleared when the
    // body was recalled, so this read comes entirely from disk.
    expect(later.all('class_options')).toEqual([]);
  });

  it('does NOT write the provisional class while the choice is still outstanding', async () => {
    // ═══════════════════════════════════════════════════════════════════════
    // THE ROTATION'S GUESS MUST NOT REACH THE FILE. IT IS AN ANSWER TO A
    // QUESTION NOBODY HAS BEEN ASKED.
    // ═══════════════════════════════════════════════════════════════════════
    //
    // `handleHello` flushes `saveNow('join')` for every genuinely new character,
    // and `fileFor` persists `snapshot.classId ?? binding.classId` off the LIVE
    // BODY — which at that instant is already wearing the class the rotation
    // handed it. So the file named a class seconds before the player had seen a
    // single card, and the whole three-valued `owes` read
    // (`restore.classId === UNASSIGNED_CLASS`) came back false ever after.
    //
    // THERE IS NO SECOND ROUTE TO THE SCREEN. `handleChooseClass` refuses
    // anybody outside `classChoiceOwed`, that set is per-process, and no frame
    // or command re-opens the picker — so one premature write assigned somebody
    // their class permanently, decided by a counter.
    server = await boot('choice-not-yet-written');

    const client = await connect(server.port);
    const welcome = await client.hello('ren-handle');
    await client.waitFor('class_options');
    await client.settle();

    // The BODY wears the provisional class — it has to, a token is on four
    // other screens the instant `addPlayer` returns…
    expect(bodyOf(welcome).classId).toBe(WATCHMAN.id);
    // …and the FILE says nobody has chosen, which is the truth.
    expect(server.disk.files.get(`${REN_ID}/${SOLO_CHARACTER_ID}`)?.classId).toBe(UNASSIGNED_CLASS);
  });

  it('asks again after a recall when the picker was never answered', async () => {
    // The failure this closes, end to end: open the Activity, get pulled away
    // without confirming, come back after the grace. The body is recalled, and
    // if the recall's own `saveNow` had stamped the provisional class the next
    // `hello` would compute that nothing is owed and hand back a class the
    // player never picked — permanently, with nothing in the game able to change
    // it. The same shape covers a process restart, which CLAUDE.md documents as
    // the live-session hotfix path.
    server = await boot('choice-unanswered-recall', { graceMs: 60 });

    const first = await connect(server.port);
    const body = bodyOf(await first.hello('ren-handle'));
    expect(await first.waitFor('class_options')).toBeDefined();
    // NOTHING IS SENT. They are looking at the modal when they close the tab.
    first.close();

    const deadline = Date.now() + FRAME_TIMEOUT_MS;
    while (server.world.getActor(body.id) !== undefined && Date.now() < deadline) {
      await sleep(10);
    }
    expect(server.world.getActor(body.id)).toBeUndefined();
    // The recall's flush wrote the sentinel, not the rotation's guess.
    expect(server.disk.files.get(`${REN_ID}/${SOLO_CHARACTER_ID}`)?.classId).toBe(UNASSIGNED_CLASS);

    const later = await connect(server.port);
    await later.hello('ren-handle');
    // AND THE SCREEN COMES BACK. This is the assertion the test exists for.
    expect(await later.waitFor('class_options')).toBeDefined();
  });
});

// ===========================================================================
// 4. WHAT AN UNANSWERED PICKER MAY NOT COST — ANYBODY ELSE, OR THE PLAYER
// ===========================================================================

describe('a player reading the chooser', () => {
  it('is parked on a standing hold, so the level does not freeze around them', async () => {
    // ═══════════════════════════════════════════════════════════════════════
    // THE ONE FAILURE THE WHOLE TURN DESIGN EXISTS TO PREVENT.
    // ═══════════════════════════════════════════════════════════════════════
    //
    // Parties scope the BARRIER — `surveyQuorum`, `bell` and `expire` all take a
    // `PartyScope` — so a joiner being a party of one is TRUE and does NOT make
    // this safe. Parties do not scope the WORLD CLOCK. `isBlocking`
    // (engine/barrier.ts) needs only quorum + energy + no pending intent + NO
    // STANDING ORDER + `engagement > 0`, engagement is a LEVEL scalar, and
    // shared/energy.ts:647 then makes every monster on the floor `continue`
    // behind the first parked actor. One person reading three class
    // descriptions stopped the fight in the next room for two minutes at a time.
    //
    // `standingOrder` is the field that already means "an order supplies this
    // actor's action, so it never blocks" (engine/actor.ts:149-159). Asserting
    // it directly is the only way to make the claim from outside: the gateway
    // exports neither `classChoiceOwed` nor its parking helpers, and the barrier
    // reads the body.
    server = await boot('choice-does-not-stall');

    const client = await connect(server.port);
    const body = bodyOf(await client.hello('ren-handle'));
    await client.waitFor('class_options');

    expect(body.standingOrder).toBe(StandingOrder.Hold);

    client.send({ t: 'choose_class', classId: ALCHEMIST.id });
    await client.settle();

    // AND IT COMES STRAIGHT BACK OFF. Left on, this player would auto-hold every
    // turn for the rest of the session and the party would never wait for them.
    expect(body.standingOrder).toBeNull();
  });

  it('gets the barrier back on their first command, choice or no choice', async () => {
    // ═══ "OWES A CHOICE" AND "IS NOT PLAYING" ARE NOT THE SAME POPULATION ═══
    // An anonymous socket owes a choice — `openCharacter` answers null with no
    // verified identity — and anonymous play is plain-browser development and
    // tools/e2e-m1.mjs, both of which send `hello` and then start walking.
    // Leaving those bodies parked would mean the world never waits for them.
    // The park is about SILENCE, and any turn verb ends it; the same doctrine
    // `barrier.noteCommand` states in its own words.
    server = await boot('choice-unpark-on-command');

    const client = await connect(server.port);
    const body = bodyOf(await client.hello());
    await client.waitFor('class_options');
    expect(body.standingOrder).toBe(StandingOrder.Hold);

    client.send({ t: 'hold' });
    await client.settle();

    expect(body.standingOrder).toBeNull();
    // AND THE CHOICE IS STILL OWED — the command released the barrier and
    // nothing else. Accepted, so they were still in the set.
    client.send({ t: 'choose_class', classId: INSPECTOR.id });
    await client.settle();
    expect(body.classId).toBe(INSPECTOR.id);
  });

  it('is not healed by finishing character creation', async () => {
    // ═══════════════════════════════════════════════════════════════════════
    // THE FIRST CHOICE USED TO BE A FULL HEAL, ON A BODY OF THE CLIENT'S
    // CHOOSING.
    // ═══════════════════════════════════════════════════════════════════════
    //
    // `reclothePlayer` set `hp = maxHp` outright, justified by "the body is
    // UNDAMAGED BY CONSTRUCTION at this moment". It is not. A returning player
    // is restored from their file and THEN offered the chooser — every character
    // file written before classes existed holds `UNASSIGNED_CLASS` — and a body
    // whose owner is reading the modal is still in the world where things can
    // hit it. So a battered detective could bank 30-odd hit points by finishing
    // a screen, once per character, through the honest UI.
    //
    // THE RULE IS NOW ARITHMETIC: full only if it was already full, otherwise
    // clamped. The undamaged case — asserted a few tests up — is unchanged.
    server = await boot('choice-no-free-heal');

    const client = await connect(server.port);
    const welcome = await client.hello('ren-handle');
    const body = bodyOf(welcome);
    await client.waitFor('class_options');

    // Chewed on while the modal was up.
    body.hp = 9;

    client.send({ t: 'choose_class', classId: ALCHEMIST.id });
    await client.settle();

    // The class landed in full…
    expect(body.classId).toBe(ALCHEMIST.id);
    expect(body.maxHp).toBe(ALCHEMIST.maxHp);
    // …and the damage came with it.
    expect(body.hp).toBe(9);
  });

  it('cannot answer the picker from the floor, and is still owed the screen', async () => {
    // ═══ RE-CLOTHING A DOWNED BODY CORRUPTS ITS CLASS PERMANENTLY ═══
    // `goDown` captures `upSprite: actor.sprite` — the PROVISIONAL class's
    // sprite — and both `revive` and `standUp` restore it. Writing the CHOSEN
    // class's sprite over that body means the restore puts the WRONG class back
    // on its feet, for the rest of the session, with the turn card's portrait
    // (derived from `actor.sprite`) and the character sheet's class name
    // (derived from `actor.classId`) disagreeing for good. It would also
    // broadcast a full green bar under a Downed marker.
    //
    // REFUSED, NOT CONSUMED. `not_your_turn` means *not now*, so the id stays in
    // `classChoiceOwed` and the same choice lands the moment they are up.
    server = await boot('choice-refused-while-down');

    const client = await connect(server.port);
    const welcome = await client.hello('ren-handle');
    const body = bodyOf(welcome);
    await client.waitFor('class_options');
    client.clear();

    // On the floor. `goDown` sets exactly these two, and `alive` is the one the
    // gateway reads — it is false for Erased too, which is the point of reading
    // it rather than the survival table.
    body.hp = 0;
    body.alive = false;

    client.send({ t: 'choose_class', classId: ALCHEMIST.id });
    const error = await client.waitFor('error');

    expect(error?.['code']).toBe('not_your_turn');
    expect(body.classId).toBe(WATCHMAN.id);
    expect(body.sprite).toBe(WATCHMAN.sprite);
    expect(body.hp).toBe(0);

    // Picked up. The screen was never spent.
    body.alive = true;
    body.hp = 5;
    client.send({ t: 'choose_class', classId: ALCHEMIST.id });
    await client.settle();
    expect(body.classId).toBe(ALCHEMIST.id);
  });
});
