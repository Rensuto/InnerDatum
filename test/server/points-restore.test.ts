// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/modules/tome/class/Actor.lua:3745-3760 (the four levelup grants)
//                       game/modules/tome/dialogs/LevelupDialog.lua:433-437 (unlock or deepen)
//                       game/engines/default/engine/interface/ActorTalents.lua:899-907 (learnTalentType)
// The third is the ENGINE's and has no module override — tome/class/Actor.lua only CALLS
// learnTalentType (:776, :3398-3410) — so the qualified path is the engine's on purpose.
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { attachClassFor } from '../helpers/attach-class.ts';

import {
  classById,
  createContentTalentEngine,
  createTalentBook,
} from '../../src/server/content/classes.ts';
import {
  birthCategoryPoints,
  classPointBonus,
  genericPointBonus,
  originOf,
} from '../../src/server/content/origins.ts';
import {
  DOWNED_TURNS,
  createDownedState,
  goDown,
  tickDowned,
} from '../../src/server/engine/downed.ts';
import { talentLedgerSeams, talentRuntimeFor } from '../../src/server/main.ts';
import { wsGateway } from '../../src/server/net/gateway.ts';
import {
  SaveReason,
  createCharacterBridge,
  createCharacterFile,
  createSaveStore,
  parseCharacterFile,
  serialiseCharacter,
} from '../../src/server/persist/saves.ts';
import { createTurnEngine } from '../../src/server/turn-engine.ts';
import { SITES, createRealms } from '../../src/server/world/realms.ts';
import { MASTERY_STEP } from '../../src/shared/progression.ts';
import {
  totalCategoryPointsAtLevel,
  totalGenericPointsAtLevel,
  totalPointsAtLevel,
  totalStatPointsAtLevel,
} from '../../src/shared/progression.ts';
import { TalentRowKind, talentPanelRows } from '../../src/client/ui/talents.ts';
import { PROTOCOL_VERSION } from '../../src/shared/version.ts';
import type { DownedState } from '../../src/server/engine/downed.ts';
import type { IdentityPort } from '../../src/server/net/gateway.ts';
import type { SaveStore } from '../../src/server/persist/saves.ts';
import type { Realms } from '../../src/server/world/realms.ts';
import type { TalentEngine } from '../../src/server/engine/talents.ts';
import type { TalentPanelView } from '../../src/client/ui/talents.ts';
import type { LoadoutTalent, ProgressMsg } from '../../src/shared/protocol.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * EVERY POINT KIND, ACROSS EVERY PATH THAT REBUILDS THE BODY.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * REPORTED LIVE, on a level-6 character: *"i believe we may have a bug
 * retaining talent unspent points, category points, generic points, etc. when i
 * leave game and rejoin the points disappeared."*
 *
 * ═══ WHAT WAS ACTUALLY WRONG, AND IT IS AN ORDER AND NOT A LOSS ═══
 * The purses themselves are DERIVED — `totalXAtLevel(level)` minus what the
 * durable record says was spent — so no rebuild path can lose one. What was
 * lost was the thing a category point BUYS. `handleHello` called
 * `engine.attachClass` (which assembles the sheet with `sheetForBody`, reading
 * `unlockedTrees` and `deepenedTrees` OFF THE BODY) and only afterwards ran
 * `restoreProgression`, which is where those two lists were put on the body.
 * The body `addPlayer` had built moments earlier carried neither, so every
 * rebuilt sheet was assembled as though nothing had ever been bought:
 *
 *   - the bought discipline's six talents were absent, so `applyTalentPoints`
 *     dropped every rank saved inside it as an id "this body no longer has" —
 *     and the next autosave wrote that loss to disk, permanently;
 *   - the deepened tree's mastery fell back to its authored value, so a flat
 *     +20% on every rank in that tree silently stopped applying;
 *   - and because `unlockedTrees`/`deepenedTrees` stayed in the FILE, the
 *     category purse still counted both points as spent: two of the scarcest
 *     points in the game, gone, with nothing to show for them.
 *
 * A Cityborn character is handed a category point at birth
 * (`origins.ts` `birthPoints`), so a level-6 tester meets this in their first
 * session — which is exactly the report.
 *
 * ═══ AND A SECOND, INDEPENDENT LOSS IN THE SAME FAMILY ═══
 * `snapshotRealm` wrote `lastLearnt: { class, generic }` and tested emptiness on
 * those two alone. `CharacterFile`, `parseLastLearnt`, `CharacterSnapshot`,
 * `Binding` and `restoreProgression` all carry `stat`; that one site dropped it,
 * so the attribute take-back window closed at every reconnect.
 *
 * ═══ WHY THIS FILE DRIVES A SOCKET AND A REAL STORE ═══
 * Every part is correct alone. `unlockTree` writes the list, the save layer
 * writes it to disk, `parseCharacterFile` reads it back and `sheetForBody`
 * consumes it properly. The defect exists only in the ORDER `handleHello` runs
 * them in — and `test/server/point-purses.test.ts`, which owns the arithmetic,
 * could not see it because the arithmetic was never wrong.
 */

const OWNER = '284739201847583744';
const HANDLE = 'ren-handle';
const CHARACTER = 'chr_main';
const CLASS_ID = 'watchman';
/** Cityborn grants a class, a generic AND a category point at birth. */
const ORIGIN_ID = 'origin_cityborn';
const ORIGIN = originOf(ORIGIN_ID);
/** 20: the second category point has arrived, so the purse is non-empty too. */
const LEVEL = 20;

/** The locked discipline a category point BUYS — `content/talent-trees.ts`. */
const BOUGHT_TREE = 'generic/leverage';
/** One of its six, and the ranks inside it are what a rebuild used to drop. */
const BOUGHT_TALENT = 'talent:overreach';
/** A tree the Watchman is born knowing, so a point can only DEEPEN it. */
const DEEPENED_TREE = 'watch/discipline';
/** A class-tree talent, so the class purse has something spent in it too. */
const CLASS_TALENT = 'talent:crude_blow';
/** The town the crossing test walks into. A Common realm: no monsters to die to. */
const DOOR_SITE = 'site:threadneedle_row';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT THE FIXTURE SPENT — written here, never derived from the sheet.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The expectations below are `granted - spent`, and `spent` is these four
 * numbers: what this file's own seeded character bought. Reading them back off
 * `spendByPurse` would be restating production's derivation and would pass
 * against any consistent-but-wrong answer — [Tests true of the fixture] is the
 * failure this shape exists to avoid, and the remedy is that the SPEND is the
 * fixture's own statement and the GRANT comes from `shared/progression.ts`.
 */
/** `talent:crude_blow` is a birth talent at rank 1 and the file says 3. */
const CLASS_RANKS_BOUGHT = 2;
/** `talent:overreach` starts at 0 inside the bought tree and the file says 2. */
const GENERIC_RANKS_BOUGHT = 2;
/** One unlock, one deepen. There is no third way to spend a category point. */
const CATEGORY_POINTS_SPENT = 2;
/** `{ str: 3, con: 2 }`. */
const STAT_POINTS_SPENT = 5;

/** Every purse, as one value, so no test can assert three of four by accident. */
type Purses = {
  level: number;
  class: number;
  generic: number;
  category: number;
  stat: number;
};

const EXPECTED: Purses = {
  level: LEVEL,
  class: totalPointsAtLevel(LEVEL, classPointBonus(ORIGIN)) - CLASS_RANKS_BOUGHT,
  generic: totalGenericPointsAtLevel(LEVEL, genericPointBonus(ORIGIN)) - GENERIC_RANKS_BOUGHT,
  category: totalCategoryPointsAtLevel(LEVEL, birthCategoryPoints(ORIGIN)) - CATEGORY_POINTS_SPENT,
  stat: totalStatPointsAtLevel(LEVEL) - STAT_POINTS_SPENT,
};

/** The attribute take-back window, seeded and expected back. */
const STAT_WINDOW = ['con', 'str'] as const;

/** The sheet a correctly rebuilt body must hold. Measured, not guessed. */
const SHEET_WITH_PURCHASES = 39;
const SHEET_WITHOUT_PURCHASES = 33;

function seeded(): Parameters<typeof createCharacterFile>[0] {
  return {
    id: CHARACTER,
    ownerId: OWNER,
    name: 'Ren',
    classId: CLASS_ID,
    origin: ORIGIN_ID,
    level: LEVEL,
    talentPoints: { [CLASS_TALENT]: 1 + CLASS_RANKS_BOUGHT, [BOUGHT_TALENT]: GENERIC_RANKS_BOUGHT },
    unlockedTrees: [BOUGHT_TREE],
    deepenedTrees: [DEEPENED_TREE],
    spentStats: { str: 3, con: 2 },
    lastLearnt: { class: [CLASS_TALENT], generic: [BOUGHT_TALENT], stat: [...STAT_WINDOW] },
    resources: { hp: 100, ap: 1, mp: 0, special: { kind: 'resolve', value: 10 } },
  };
}

function identityPort(): IdentityPort {
  return {
    get: (id: string | undefined) =>
      id === HANDLE ? { user: { id: OWNER }, displayName: 'Ren' } : undefined,
  };
}

type Frame = Record<string, unknown>;

type Client = {
  send(frame: Frame): void;
  waitFor(type: string, timeoutMs?: number): Promise<Frame | undefined>;
  last(type: string): Frame | undefined;
  forget(): void;
  settle(): Promise<void>;
  close(): void;
};

const openClients: Client[] = [];

async function connect(port: number): Promise<Client> {
  const socket = new WebSocket(`ws://127.0.0.1:${String(port)}/ws`);
  let frames: Frame[] = [];
  socket.addEventListener('message', (event: MessageEvent) => {
    for (const raw of String(event.data).split('\n')) {
      if (raw.trim() === '') continue;
      try {
        frames.push(JSON.parse(raw) as Frame);
      } catch {
        /* not a frame this test reads */
      }
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
  const waitFor = async (type: string, timeoutMs = 8000): Promise<Frame | undefined> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = frames.find((frame) => frame['t'] === type);
      if (hit !== undefined) return hit;
      if (Date.now() >= deadline) return undefined;
      await sleep(10);
    }
  };
  const client: Client = {
    send: (frame: Frame): void => {
      socket.send(JSON.stringify({ v: PROTOCOL_VERSION, ...frame }));
    },
    waitFor,
    last: (type: string): Frame | undefined => frames.filter((f) => f['t'] === type).at(-1),
    /**
     * DROP EVERYTHING SEEN SO FAR. A swap is a SECOND hello, so every frame
     * afterwards has a stale twin in front of it that `waitFor` would return.
     */
    forget: (): void => {
      frames = [];
    },
    settle: async (): Promise<void> => {
      client.send({ t: 'ping' });
      await waitFor('pong');
      frames = frames.filter((frame) => frame['t'] !== 'pong');
    },
    close: (): void => {
      socket.close();
    },
  };
  openClients.push(client);
  return client;
}

type Harness = {
  port: number;
  root: string;
  store: SaveStore;
  realms: Realms;
  talents: TalentEngine;
  downed: DownedState;
  bodyOf: (actorId: string) => ReturnType<Realms['overworld']['world']['getActor']>;
  close: () => Promise<void>;
};

const openHarnesses: Harness[] = [];
let root: string | undefined;

/**
 * The gateway with the real realms, the real talent engine, the real persist
 * bridge and — the part that matters here — THE REAL TALENT-LEDGER SEAMS.
 *
 * ═══ `talentLedgerSeams` IS PRODUCTION'S OWN OBJECT, NOT A COPY ═══
 * `restoreProgression` rebuilds the generic purse only `if (split !== undefined)`
 * — `split` being `engine.talentSpendOf?.(actor.id)`. A harness that omits that
 * seam therefore gets a restore which never touches `unspentGenerics` at all,
 * and a test written to prove the generic purse survives would be asserting
 * against a number production never computed. Every socket harness in the tree
 * used to hand-copy these three; `src/server/main.ts` exports them now, so this
 * file drives the same closures the live server does.
 *
 * `attachClass` is NOT among them — it needs the realm registry and
 * `refreshPassives` — so it stays `test/helpers/attach-class.ts`, which goes
 * through the same `sheetForBody` production goes through.
 */
async function start(opts: { root?: string; graceMs?: number } = {}): Promise<Harness> {
  const where = opts.root ?? (await mkdtemp(join(tmpdir(), 'inner-datum-points-')));
  root ??= where;
  const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };
  const app = Fastify({ logger: false });
  const talents = createContentTalentEngine();
  const downed = createDownedState();

  // ASSIGNED ONCE THE REALMS EXIST and reached through a closure rather than by
  // mutating the object: `createRealms` spreads the seams into each engine, so a
  // later write to the field would never reach the copies.
  let attach: (actorId: string, classId: string) => void = () => undefined;
  const seams = {
    attachClass: (actorId: string, classId: string): void => {
      attach(actorId, classId);
    },
    ...talentLedgerSeams(talents),
  };

  const realms = createRealms({
    seed: 'points-restore',
    engineFor: (world) => ({
      ...createTurnEngine({
        world,
        downed,
        talents: createTalentBook(talents, world),
        talentRuntime: talentRuntimeFor(talents, world),
      }),
      ...seams,
    }),
  });
  attach = attachClassFor(talents, realms.overworld.world);
  const store = createSaveStore({ root: where, logger: quiet, debounceMs: 5 });

  if (opts.root === undefined) {
    // THE FILE OF A CHARACTER WHO HAS ALREADY SPENT FROM ALL FOUR PURSES,
    // written through the real writer so every field is shaped as a live save is.
    await store.saveCharacter(createCharacterFile(seeded()), SaveReason.Manual);
    await store.flush();
  }

  await app.register(wsGateway, {
    world: realms.overworld.world,
    engine: realms.overworld.engine,
    realms,
    downed,
    sessions: identityPort(),
    persist: createCharacterBridge({ store, logger: quiet }),
    ...(opts.graceMs === undefined ? {} : { disconnectGraceMs: opts.graceMs }),
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (address === null || typeof address === 'string') throw new Error('no port was bound');
  const harness: Harness = {
    port: address.port,
    root: where,
    store,
    realms,
    talents,
    downed,
    bodyOf: (actorId) =>
      realms
        .all()
        .map((realm) => realm.world.getActor(actorId))
        .find((found) => found !== undefined),
    close: async (): Promise<void> => {
      await app.close();
      await store.close();
    },
  };
  openHarnesses.push(harness);
  return harness;
}

/** Say hello as Ren and pick the character named. */
async function arrive(port: number, characterId = CHARACTER): Promise<Client> {
  const client = await connect(port);
  client.send({ t: 'hello', sessionId: HANDLE });
  const roster = await client.waitFor('roster');
  const rows = (roster?.['characters'] ?? []) as { id: string }[];
  expect(
    rows.map((row) => row.id),
    'the seeded character is not on the roster',
  ).toContain(characterId);
  client.forget();
  client.send({ t: 'hello', sessionId: HANDLE, characterId });
  await client.waitFor('welcome');
  await client.settle();
  await sleep(120);
  return client;
}

// ---------------------------------------------------------------------------
// Reading the four purses back — off the wire, and off the body.
// ---------------------------------------------------------------------------

function pursesOnTheWire(progress: Frame | undefined): Purses {
  expect(progress, 'no progress frame arrived').toBeDefined();
  return {
    level: Number(progress?.['level']),
    class: Number(progress?.['unspent']),
    generic: Number(progress?.['unspentGenerics']),
    category: Number(progress?.['unspentCategories']),
    stat: Number(progress?.['unspentStats']),
  };
}

function pursesOnTheBody(body: unknown): Purses {
  const it = body as Record<string, number> | undefined;
  expect(it, 'the body is not in any realm').toBeDefined();
  return {
    level: Number(it?.['level']),
    class: Number(it?.['unspentPoints']),
    generic: Number(it?.['unspentGenerics']),
    category: Number(it?.['unspentCategories']),
    stat: Number(it?.['unspentStatPoints']),
  };
}

type WireTalent = { id: string; tree?: string; level?: number; mastery?: number };

function talentsOf(loadout: Frame | undefined): WireTalent[] {
  return [
    ...((loadout?.['talents'] ?? []) as WireTalent[]),
    ...((loadout?.['passives'] ?? []) as WireTalent[]),
  ];
}

/**
 * WHAT THE CATEGORY POINTS ACTUALLY BOUGHT, asserted off the sheet.
 *
 * The purse says the points are gone. Only the sheet says what they bought is
 * still there, and that is the half a rebuild used to drop — so every path in
 * this file checks both, or it would pass on a character that had paid twice
 * for nothing.
 */
function expectPurchasesIntact(talents: WireTalent[], where: string): void {
  expect(talents.length, `${where}: the sheet lost talents`).toBe(SHEET_WITH_PURCHASES);
  const bought = talents.filter((talent) => talent.tree === BOUGHT_TREE);
  expect(bought.length, `${where}: the bought discipline is not in the sheet`).toBeGreaterThan(0);
  const raised = bought.find((talent) => talent.id === BOUGHT_TALENT);
  expect(raised, `${where}: ${BOUGHT_TALENT} came back with no entry at all`).toBeDefined();
  // `level` on the wire is the EFFECTIVE level (raw x mastery), so 2 raw is >= 2.
  expect(raised?.level ?? 0, `${where}: the saved ranks were dropped`).toBeGreaterThanOrEqual(
    GENERIC_RANKS_BOUGHT,
  );
  // AND THE OTHER THING A CATEGORY POINT BUYS — LevelupDialog.lua:435-436's
  // +0.2, a flat 20% on every rank in that tree, present and future. Against the
  // class's OWN authored figure plus one step; `masteries` is per class per tree,
  // so comparing with a neighbouring tree would assert nothing.
  const deepened = talents.find((talent) => talent.tree === DEEPENED_TREE);
  const authored = classById(CLASS_ID)?.masteries?.[DEEPENED_TREE] ?? 1;
  expect(deepened?.mastery ?? 0, `${where}: the deepening is not on the sheet`).toBeCloseTo(
    authored + MASTERY_STEP,
    5,
  );
}

/** The same question of the live sheet, for a path that sends no loadout frame. */
function expectSheetIntact(harness: Harness, actorId: string, where: string): void {
  const sheet = harness.talents.sheetOf(actorId);
  expect(sheet, `${where}: this body has no talent sheet`).toBeDefined();
  expect(sheet?.points.size, `${where}: the sheet lost talents`).toBe(SHEET_WITH_PURCHASES);
  expect(sheet?.points.get(BOUGHT_TALENT), `${where}: the saved ranks were dropped`).toBe(
    GENERIC_RANKS_BOUGHT,
  );
  expect(sheet?.mastery.get(DEEPENED_TREE) ?? 0, `${where}: the deepening is gone`).toBeCloseTo(
    (classById(CLASS_ID)?.masteries?.[DEEPENED_TREE] ?? 1) + MASTERY_STEP,
    5,
  );
}

afterEach(async () => {
  for (const client of openClients) client.close();
  openClients.length = 0;
  for (const harness of openHarnesses) await harness.close();
  openHarnesses.length = 0;
  if (root !== undefined) await rm(root, { recursive: true, force: true });
  root = undefined;
});

// ---------------------------------------------------------------------------

describe('the fixture spends from every purse and leaves something in each', () => {
  it('has a non-zero expectation for all four, so no assertion below is vacuous', () => {
    /**
     * THE GUARD [Membership is not a rank] ASKS FOR. Four `toBe` assertions
     * against four numbers that all happened to be zero would pass on a server
     * that had emptied every purse — which is precisely the bug reported.
     */
    expect(EXPECTED.class, 'the class purse expectation is empty').toBeGreaterThan(0);
    expect(EXPECTED.generic, 'the generic purse expectation is empty').toBeGreaterThan(0);
    expect(EXPECTED.category, 'the category purse expectation is empty').toBeGreaterThan(0);
    expect(EXPECTED.stat, 'the attribute purse expectation is empty').toBeGreaterThan(0);
    // AND THE SHEET FIGURES ARE REAL. `sheetForBody` with both purchases is six
    // talents wider than without; if content ever changes that, the path tests
    // below would silently stop distinguishing a restored sheet from a bare one.
    expect(SHEET_WITH_PURCHASES - SHEET_WITHOUT_PURCHASES, 'the tree is empty').toBeGreaterThan(0);
  });
});

describe('every point kind survives the join that reads the file', () => {
  it('hands back all four purses, the bought discipline and the take-back window', async () => {
    const harness = await start();
    const client = await arrive(harness.port);

    expect(pursesOnTheWire(client.last('progress'))).toEqual(EXPECTED);
    expectPurchasesIntact(talentsOf(client.last('loadout')), 'first join');
    // THE ATTRIBUTE WINDOW, which is persisted rather than derived: nothing else
    // records the ORDER points were bought in, and the order IS the rule.
    const window = (client.last('progress')?.['unspendableStats'] ?? []) as string[];
    expect([...window].sort(), 'the take-back window did not come back').toEqual([...STAT_WINDOW]);
  });
});

describe('every point kind survives a reconnect after the grace expires', () => {
  it('rebuilds the body from the file and loses none of the four', async () => {
    /**
     * THE PATH THE REPORT NAMES: leave the game, come back. The grace timer is
     * cut to nothing so `recallBody` fires — it SAVES, then drops the body out
     * of the world — and the rejoin therefore takes `resolveActor`'s CREATE
     * path, which is the one that rebuilds a sheet from a file.
     */
    const harness = await start({ graceMs: 20 });
    const first = await arrive(harness.port);
    expect(pursesOnTheWire(first.last('progress'))).toEqual(EXPECTED);
    first.close();
    // The recall, then its save, then a rejoin that has to read the file.
    await sleep(400);
    await harness.store.flush();

    const again = await arrive(harness.port);
    expect(pursesOnTheWire(again.last('progress')), 'a purse emptied on reconnect').toEqual(
      EXPECTED,
    );
    expectPurchasesIntact(talentsOf(again.last('loadout')), 'after a reconnect');
    const window = (again.last('progress')?.['unspendableStats'] ?? []) as string[];
    expect([...window].sort(), 'the take-back window closed on reconnect').toEqual([
      ...STAT_WINDOW,
    ]);
  });

  it('and the SECOND reconnect still has them, so nothing was written away', async () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE HALF THAT MAKES THE LOSS PERMANENT, AND IT IS A SEPARATE TEST.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * A restore that drops ranks is recoverable until the next autosave writes
     * the dropped spread back to disk. [Audit the way back]: the first rejoin
     * reads the file, and the SAVE it queues on the way out is the half that
     * turns a bad read into a bad file. So this goes round twice, and the
     * assertions are made on the third body.
     *
     * The attribute window is the one that could only ever fail here:
     * `snapshotRealm` wrote `lastLearnt` without its `stat` list, so the file
     * after the first round trip had no window in it at all.
     */
    const harness = await start({ graceMs: 20 });
    (await arrive(harness.port)).close();
    await sleep(400);
    await harness.store.flush();
    (await arrive(harness.port)).close();
    await sleep(400);
    await harness.store.flush();

    const third = await arrive(harness.port);
    expect(pursesOnTheWire(third.last('progress')), 'a purse emptied on the round trip').toEqual(
      EXPECTED,
    );
    expectPurchasesIntact(talentsOf(third.last('loadout')), 'after two round trips');
    const window = (third.last('progress')?.['unspendableStats'] ?? []) as string[];
    expect([...window].sort(), 'the take-back window was written away').toEqual([...STAT_WINDOW]);
  });
});

describe('every point kind survives a character swap and back', () => {
  it('retires the body, builds a second character, and returns to all four purses', async () => {
    const harness = await start();
    const first = await arrive(harness.port);
    expect(pursesOnTheWire(first.last('progress'))).toEqual(EXPECTED);
    first.close();

    // A SWAP IS A NEW SOCKET, because `handleHello` refuses a second hello on a
    // connection that completed one and the client obeys by re-handshaking.
    const other = await connect(harness.port);
    other.send({ t: 'hello', sessionId: HANDLE, newCharacter: true });
    const offered = await other.waitFor('class_options');
    const options = (offered?.['options'] ?? []) as { id: string }[];
    const chosen = options[0]?.id;
    expect(chosen, 'the server offered no class to choose').toBeDefined();
    other.send({ t: 'choose_class', classId: chosen });
    await other.settle();
    other.close();
    await sleep(300);
    await harness.store.flush();

    const back = await arrive(harness.port);
    expect(pursesOnTheWire(back.last('progress')), 'a purse emptied on the swap back').toEqual(
      EXPECTED,
    );
    expectPurchasesIntact(talentsOf(back.last('loadout')), 'after a character swap');
    // AND THE WINDOW, because a swap SAVES the body it is walking away from
    // (`saveNow('character-swap')`) — so this path exercises the write side too.
    const window = (back.last('progress')?.['unspendableStats'] ?? []) as string[];
    expect([...window].sort(), 'the take-back window did not survive a swap').toEqual([
      ...STAT_WINDOW,
    ]);
  });
});

describe('every point kind survives walking through a door', () => {
  it('carries all four purses and the bought discipline into the realm beyond', async () => {
    /**
     * A CROSSING BUILDS A NEW BODY IN A NEW WORLD. Two `World`s are two closures
     * over two actor tables, so `carryAcross` copies a hand-written list onto the
     * arrival — the shape this codebase keeps getting wrong, and the reason the
     * assertion is every purse rather than the one that moved.
     *
     * The SHEET is not carried and does not need to be: it is per-actor in a
     * talent engine shared across realms. So it is asked of the engine directly.
     */
    const harness = await start();
    const client = await arrive(harness.port);
    const selfId = String(client.last('welcome')?.['selfId']);
    expect(pursesOnTheBody(harness.bodyOf(selfId))).toEqual(EXPECTED);

    const door = [...harness.realms.overworld.sites].find(([, id]) => id === DOOR_SITE);
    expect(door, `no door to ${DOOR_SITE} on the moor`).toBeDefined();
    const [xs, ys] = (door?.[0] ?? '0,0').split(',');
    const body = harness.bodyOf(selfId);
    expect(body, 'no body to move').toBeDefined();
    if (body === undefined) return;
    body.x = Number(xs) - 1;
    body.y = Number(ys);
    // A REAL `move` INTENT, so the crossing runs the handler a keypress runs.
    client.send({ t: 'move', dir: 'e' });
    await sleep(400);

    expect(harness.realms.realmOf(selfId)?.id, 'the door did not open').toBe(`realm:${DOOR_SITE}`);
    expect(pursesOnTheBody(harness.bodyOf(selfId)), 'a purse emptied at the door').toEqual(
      EXPECTED,
    );
    expectSheetIntact(harness, selfId, 'through the door');
    // AND THE TWO LISTS, because `unlockableOf` reads the BODY: an arrival
    // without them would re-offer a discipline this character already owns.
    const arrived = harness.bodyOf(selfId) as unknown as Record<string, string[] | undefined>;
    expect(arrived['unlockedTrees'], 'the bought discipline did not cross').toEqual([BOUGHT_TREE]);
    expect(arrived['deepenedTrees'], 'the deepening did not cross').toEqual([DEEPENED_TREE]);
    // AND THE TAKE-BACK WINDOW, on the body rather than the wire: walking OUT of
    // a delve is exactly when a player reaches a quiet place and can finally use
    // it, so a door that closed it would close it at the worst moment.
    const carried = (arrived as unknown as { lastLearnt?: { stat?: string[] } }).lastLearnt;
    expect([...(carried?.stat ?? [])].sort(), 'the take-back window did not cross').toEqual([
      ...STAT_WINDOW,
    ]);
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * AND THE TWO FIELDS THE SAME HAND-WRITTEN LIST WAS STILL DROPPING.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `carryAcross` states its own contract — *"what is carried is precisely what
   * `snapshotPlayers` writes down"* — and it was not true of `money` or of
   * `knownLore`. Both were found by reading the save writer beside the crossing
   * list, field by field, after the purse bug above; they are the eighth and
   * ninth entries this list has been missing and the reason it is asserted as a
   * WHOLE rather than one field at a time.
   *
   * THE TWO FAIL DIFFERENTLY, which is why both halves are here:
   *
   *   `money` is written on EVERY save unconditionally, so the reset to
   *       `STARTING_MONEY` reached the disk inside the debounce. Gold earned all
   *       evening, gone through a doorway.
   *   `knownLore` is an "absent means this producer cannot say" field, so the
   *       crossing alone left the file alone — and then `learnLore` pushed the
   *       next note onto an empty body list and the save wrote THAT over the
   *       character's whole Journal.
   */
  it('carries the purse of coin and the case notes read so far', async () => {
    const harness = await start();
    const client = await arrive(harness.port);
    const selfId = String(client.last('welcome')?.['selfId']);
    const before = harness.bodyOf(selfId);
    expect(before, 'no body to cross with').toBeDefined();
    if (before === undefined || before.kind !== 'player') return;
    // EARNED RATHER THAN SEEDED: the fixture's file carries the birth purse, and
    // a body still holding the birth purse on the far side would pass this test
    // while the bug was live. See `STARTING_MONEY`.
    before.money = 250;
    before.knownLore = ['lore:first_note', 'lore:second_note'];

    const door = [...harness.realms.overworld.sites].find(([, id]) => id === DOOR_SITE);
    expect(door, `no door to ${DOOR_SITE} on the moor`).toBeDefined();
    const [xs, ys] = (door?.[0] ?? '0,0').split(',');
    before.x = Number(xs) - 1;
    before.y = Number(ys);
    client.send({ t: 'move', dir: 'e' });
    await sleep(400);
    expect(harness.realms.realmOf(selfId)?.id, 'the door did not open').toBe(`realm:${DOOR_SITE}`);

    const arrived = harness.bodyOf(selfId);
    expect(arrived, 'nobody arrived').toBeDefined();
    if (arrived === undefined || arrived.kind !== 'player') return;
    expect(arrived.money, 'the purse of coin did not cross the threshold').toBe(250);
    expect([...(arrived.knownLore ?? [])], 'the case notes did not cross').toEqual([
      'lore:first_note',
      'lore:second_note',
    ]);

    // AND THE FILE, because the crossing is only half of the loss: the next
    // autosave is what makes it permanent, and `money` is written on every one.
    client.close();
    await sleep(600);
    await harness.store.flush();
    const result = await harness.store.loadCharacter(OWNER, CHARACTER);
    expect(result.file?.money, 'the file was written with the reset purse').toBe(250);
    expect([...(result.file?.knownLore ?? [])], 'the file lost a case note').toEqual([
      'lore:first_note',
      'lore:second_note',
    ]);
  });
});

describe('every point kind survives dying and standing back up', () => {
  it('keeps all four purses and the sheet across an erasure and a respawn', async () => {
    /**
     * A RESPAWN IS NOT A REBUILD — `submitRespawn` stands the SAME actor object
     * up and walks it to a spawn tile — so this path is the one that should
     * never have been able to lose a point. It is asserted anyway, because
     * "should not be able to" is exactly what was said about the door
     * (`carryAcross` lost two purses) and about the reconnect.
     */
    const harness = await start();
    const client = await arrive(harness.port);
    const selfId = String(client.last('welcome')?.['selfId']);
    const realm = harness.realms.realmOf(selfId);
    const body = harness.bodyOf(selfId);
    expect(body, 'no body to erase').toBeDefined();
    if (body === undefined || realm === undefined) return;

    body.hp = 0;
    body.alive = false;
    goDown(harness.downed, body, realm.world.turn.clock.gameTurn);
    for (let i = 0; i < DOWNED_TURNS; i += 1) tickDowned(harness.downed, body);

    client.forget();
    client.send({ t: 'respawn' });
    await sleep(300);

    expect(pursesOnTheBody(harness.bodyOf(selfId)), 'a purse emptied on respawn').toEqual(EXPECTED);
    expectSheetIntact(harness, selfId, 'after a respawn');
  });
});

describe('every point kind survives a cold restart over the same save root', () => {
  it('reads all four purses and the bought discipline back out of the files', async () => {
    /**
     * THE PATH A DEPLOY TAKES. The process that wrote the save is gone — a new
     * talent engine, new realms, new sheets — so nothing survives except what is
     * on disk, which makes this the strictest statement of the same rule.
     */
    const first = await start({ graceMs: 20 });
    const client = await arrive(first.port);
    expect(pursesOnTheWire(client.last('progress'))).toEqual(EXPECTED);
    client.close();
    await sleep(300);
    await first.close();
    openHarnesses.length = 0;

    const second = await start({ root: first.root });
    const back = await arrive(second.port);
    expect(pursesOnTheWire(back.last('progress')), 'a purse emptied across a restart').toEqual(
      EXPECTED,
    );
    expectPurchasesIntact(talentsOf(back.last('loadout')), 'after a restart');
    const window = (back.last('progress')?.['unspendableStats'] ?? []) as string[];
    expect([...window].sort(), 'the take-back window did not survive a restart').toEqual([
      ...STAT_WINDOW,
    ]);
  });
});

describe('the file the server writes still names every point kind', () => {
  it('keeps the purchases, the spread, the attributes and all three windows', async () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE WRITE SIDE, READ OFF DISK. `snapshotRealm` is the only author.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * Everything above asks what the SERVER hands back. This asks what is in the
     * file afterwards, which is the fact the next process will be handed — and
     * it is where `lastLearnt.stat` was being dropped: the emptiness test and the
     * object literal both named `class` and `generic` only, so a character who
     * had spent attribute points wrote a file with no window in it.
     */
    const harness = await start({ graceMs: 20 });
    (await arrive(harness.port)).close();
    await sleep(400);
    await harness.store.flush();

    const loaded = await harness.store.loadCharacter(OWNER, CHARACTER);
    const file = (loaded as { file?: Record<string, unknown> }).file;
    expect(file, 'the character file did not come back').toBeDefined();
    expect(file?.['level'], 'the level was not written').toBe(LEVEL);
    expect(file?.['unlockedTrees'], 'the bought discipline was not written').toEqual([BOUGHT_TREE]);
    expect(file?.['deepenedTrees'], 'the deepening was not written').toEqual([DEEPENED_TREE]);
    const spread = (file?.['talentPoints'] ?? {}) as Record<string, number>;
    expect(spread[BOUGHT_TALENT], 'the ranks inside the bought tree were written away').toBe(
      GENERIC_RANKS_BOUGHT,
    );
    expect(spread[CLASS_TALENT], 'the class ranks were written away').toBe(1 + CLASS_RANKS_BOUGHT);
    expect(file?.['spentStats'], 'the attribute spend was not written').toEqual({ str: 3, con: 2 });
    const window = (file?.['lastLearnt'] ?? {}) as Record<string, string[] | undefined>;
    expect(window['class'], 'the class window was not written').toEqual([CLASS_TALENT]);
    expect(window['generic'], 'the generic window was not written').toEqual([BOUGHT_TALENT]);
    expect([...(window['stat'] ?? [])].sort(), 'the ATTRIBUTE window was not written').toEqual([
      ...STAT_WINDOW,
    ]);
  });
});

describe('the save round trip keeps every point kind', () => {
  it('serialises and parses back with no repair and nothing dropped', () => {
    /**
     * THE UNIT HALF. `createCharacterFile` → `serialiseCharacter` →
     * `parseCharacterFile` with ZERO problems reported, which is the persist
     * layer's own contract ("`serialiseCharacter(createCharacterFile(...))`
     * reloads with zero repairs").
     *
     * THE SHAPE DID NOT CHANGE, SO `SCHEMA_VERSION` DID NOT MOVE. Every field
     * this fix touches — `unlockedTrees`, `deepenedTrees`, `lastLearnt.stat` —
     * was already declared and already parsed; the gateway simply failed to
     * write one of them and read the other two too late. A bump would have
     * meant a migration for a format that never differed.
     */
    const file = createCharacterFile(seeded());
    const result = parseCharacterFile(JSON.parse(serialiseCharacter(file)));
    expect(result.ok, 'the file this build writes does not load').toBe(true);
    if (!result.ok) return;
    expect(result.problems, 'the round trip needed repairs').toEqual([]);
    expect(result.file.level).toBe(LEVEL);
    expect(result.file.unlockedTrees).toEqual([BOUGHT_TREE]);
    expect(result.file.deepenedTrees).toEqual([DEEPENED_TREE]);
    expect(result.file.spentStats).toEqual({ str: 3, con: 2 });
    expect(result.file.talentPoints?.[BOUGHT_TALENT]).toBe(GENERIC_RANKS_BOUGHT);
    expect(result.file.lastLearnt?.class).toEqual([CLASS_TALENT]);
    expect(result.file.lastLearnt?.generic).toEqual([BOUGHT_TALENT]);
    expect(result.file.lastLearnt?.stat).toEqual([...STAT_WINDOW]);
    expect(SITES.has(DOOR_SITE), 'the crossing test walks into a place that does not exist').toBe(
      true,
    );
  });

  it('and a file that predates all three fields still loads, granting nothing', () => {
    /**
     * THE DEFAULT THAT MUST NOT ZERO ANYBODY. A save written before disciplines
     * or before `unspend_stat` has none of these keys, and absence has to read as
     * "nothing bought, no window open" rather than as an empty list somebody
     * wrote down — which is what keeps `SCHEMA_VERSION` still.
     */
    const bare = createCharacterFile({
      id: CHARACTER,
      ownerId: OWNER,
      name: 'Ren',
      classId: CLASS_ID,
      level: LEVEL,
      resources: { hp: 100, ap: 1, mp: 0, special: { kind: 'resolve', value: 10 } },
    });
    const result = parseCharacterFile(JSON.parse(serialiseCharacter(bare)));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.problems, 'an old file needed repairs').toEqual([]);
    expect(result.file.unlockedTrees).toBeUndefined();
    expect(result.file.deepenedTrees).toBeUndefined();
    expect(result.file.lastLearnt).toBeUndefined();
    // AND THE PURSE IT LOADS WITH IS THE WHOLE GRANT, never zero: `unspentPoints`
    // is derived from the ledger, so a character who bought nothing owes nothing.
    expect(result.file.unspentPoints).toBe(totalPointsAtLevel(LEVEL));
  });
});

describe('the talent screen shows what the server says after a rejoin', () => {
  it('draws the bought discipline as a category of its own and names all four purses', async () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE CLIENT'S COPY OF THE COUNTS, BUILT FROM THE REAL FRAMES.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * [Test the join, not the halves.] The panel is a pure function of two
     * frames and is tested to death on hand-written fixtures in
     * `test/client/talents.test.ts`; the server is tested above on what it
     * sends. Neither half can say what a PLAYER sees after a rejoin, because
     * that is the two halves joined — so this drives the real socket through the
     * real reconnect and feeds the frames that come back into the real
     * `talentPanelRows`.
     *
     * WHAT IT CATCHES THAT THE SERVER ASSERTIONS DO NOT: the sheet is what
     * carries the bought discipline, and the panel draws a CATEGORY per tree it
     * finds there. A rebuild that dropped the tree leaves the screen with no
     * heading to press — so the category point is spent, the purse says so, and
     * there is nothing on the screen that it bought.
     */
    const harness = await start({ graceMs: 20 });
    (await arrive(harness.port)).close();
    await sleep(400);
    await harness.store.flush();
    const client = await arrive(harness.port);

    const loadout = client.last('loadout');
    const progress = client.last('progress') as unknown as ProgressMsg | undefined;
    expect(loadout, 'no loadout frame arrived').toBeDefined();
    expect(progress, 'no progress frame arrived').toBeDefined();
    if (loadout === undefined || progress === undefined) return;

    const view: TalentPanelView = {
      loadout: (loadout['talents'] ?? []) as readonly LoadoutTalent[],
      passives: (loadout['passives'] ?? []) as readonly LoadoutTalent[],
      unlockable: (loadout['unlockable'] ?? []) as TalentPanelView['unlockable'],
      deepenable: (loadout['deepenable'] ?? []) as readonly string[],
      deepened: (loadout['deepened'] ?? []) as readonly string[],
      categories: progress.unspentCategories,
      progress,
    };
    const rows = talentPanelRows(view);

    // THE DISCIPLINE THE POINT BOUGHT, AS A HEADING WITH ITS ICONS UNDER IT.
    const headings = rows
      .filter((row) => row.kind === TalentRowKind.Category)
      .map((row) => (row.kind === TalentRowKind.Category ? row.tree : ''));
    expect(headings, 'the bought discipline has no heading on the screen').toContain(BOUGHT_TREE);

    // AND IT IS NOT ON SALE AGAIN. A second category point spent on a tree this
    // character already owns is the scarcest currency in the game, burned twice.
    const forSale = ((loadout['unlockable'] ?? []) as { id?: string }[]).map((tree) => tree.id);
    expect(forSale, 'the bought discipline is being offered for sale again').not.toContain(
      BOUGHT_TREE,
    );

    // THE FOUR COUNTS, AS THE PLAYER READS THEM — one row, composed by
    // `pointsText`, naming every purse that has something in it.
    const points = rows.find((row) => row.kind === TalentRowKind.Points);
    expect(points, 'the panel drew no points row').toBeDefined();
    const text = points?.kind === TalentRowKind.Points ? points.text : '';
    expect(text, 'the class purse is not on the screen').toContain(
      `${String(EXPECTED.class)} class`,
    );
    expect(text, 'the generic purse is not on the screen').toContain(
      `${String(EXPECTED.generic)} generic`,
    );
    expect(text, 'the category purse is not on the screen').toContain(
      `${String(EXPECTED.category)} category`,
    );
    expect(text, 'the attribute purse is not on the screen').toContain(
      `${String(EXPECTED.stat)} stat`,
    );

    // AND THE `−` COLUMN, which is the server's answer and never the client's.
    expect(
      [...(progress.unspendableStats ?? [])].sort(),
      'the take-back column lost its rows',
    ).toEqual([...STAT_WINDOW]);
  });
});

// ---------------------------------------------------------------------------
// A BIRTH GRANT THAT STOPS BEING ONE — the join, not the function
// ---------------------------------------------------------------------------

describe('a file written before a class changed its four', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE PURSES ARE DERIVED, SO A STALE FREE RANK IS A PERMANENT CHARGE.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `REDACTOR.birthTalents` displaced `open_ledger` and `issued_kit` when
   * `ledger/unwritten` landed. `sheet.birth` is rebuilt from the CURRENT
   * definition on every load and `createTalentSheet` seeds a new birth id at
   * rank 1, so an old file comes back with NINE rank-1 entries against SEVEN
   * free grants — and `spendByPurse` charges the difference to purses this file
   * has already established are `earned - spent`, floored at zero. One class
   * point and one generic point, gone silently and for ever.
   *
   * `migrateLegacyBirthGrants` (content/classes.ts) takes the free rank back
   * instead, and is unit-tested in `unwritten.test.ts`. THIS IS THE JOIN:
   * removing the call from `restoreProgression` left every one of those unit
   * cases green, which is `test-the-join-not-the-halves` exactly.
   */
  const LEGACY = 'chr_legacy_redactor';

  /** The file HEAD would have written for a Redactor who had spent nothing. */
  function legacyRedactor(): Parameters<typeof createCharacterFile>[0] {
    return {
      id: LEGACY,
      ownerId: OWNER,
      name: 'Ren',
      classId: 'redactor',
      origin: ORIGIN_ID,
      level: 1,
      // The four she WAS born with, at the rank a birth grant seeds. Two of
      // them are no longer granted; nothing on disk records that they were.
      talentPoints: {
        'talent:strike_out': 1,
        'talent:indelible': 1,
        'talent:open_ledger': 1,
        'talent:issued_kit': 1,
      },
      resources: { hp: 100, ap: 1, mp: 0, special: { kind: 'ink', value: 10 } },
    };
  }

  it('costs her nothing, and a fresh character of the same level agrees', async () => {
    const harness = await start();
    await harness.store.saveCharacter(createCharacterFile(legacyRedactor()), SaveReason.Manual);
    await harness.store.flush();

    const client = await arrive(harness.port, LEGACY);
    const selfId = String(client.last('welcome')?.['selfId']);
    const purses = pursesOnTheBody(harness.bodyOf(selfId));
    client.close();

    /**
     * WHAT A LEVEL-1 REDACTOR OF THIS ORIGIN IS OWED, from the same functions
     * the rest of this file derives its expectations with. She has spent
     * nothing, so every purse is the whole grant.
     */
    expect(purses.class, 'the swap charged her a class point').toBe(
      totalPointsAtLevel(1, classPointBonus(ORIGIN)),
    );
    expect(purses.generic, 'the swap charged her a generic point').toBe(
      totalGenericPointsAtLevel(1, genericPointBonus(ORIGIN)),
    );
    // NOT VACUOUS: the origin really grants something at level 1, or both lines
    // above would be asserting 0 === 0.
    expect(purses.class + purses.generic, 'this origin grants nothing at birth').toBeGreaterThan(0);
  });

  it('still lets her press the two stances she has just been given', async () => {
    /**
     * THE OTHER HALF OF "costs her nothing": the migration takes a rank OFF, so
     * the case above would also pass if it had emptied her sheet. She must come
     * back owning the class's current four at rank 1 — that is what the two
     * points are being spared FOR.
     */
    const harness = await start();
    await harness.store.saveCharacter(createCharacterFile(legacyRedactor()), SaveReason.Manual);
    await harness.store.flush();
    const client = await arrive(harness.port, LEGACY);
    const definition = classById('redactor');
    if (definition === undefined) throw new Error('no redactor');

    const selfId = String(client.last('welcome')?.['selfId']);
    const sheet = harness.talents.sheetOf(selfId);
    expect(sheet, 'the restored body has no sheet').toBeDefined();
    for (const talent of definition.birthTalents) {
      expect(sheet?.points.get(talent.id), `${talent.id} came back unlearned`).toBe(1);
    }
    // AND THE TWO THAT WERE DISPLACED ARE BACK TO UNLEARNED, which is what "no
    // longer granted" means and is the rank that was taken off.
    expect(sheet?.points.get('talent:open_ledger'), 'the displaced stance is still free').toBe(0);
    client.close();
  });
});
