// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/modules/tome/dialogs/LevelupDialog.lua:433-437 (learnType: unlock or deepen)
//                       game/modules/tome/class/Actor.lua:3757-3760 (the category-point levels)
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
import { talentRuntimeFor } from '../../src/server/main.ts';
import { wsGateway } from '../../src/server/net/gateway.ts';
import {
  createCharacterBridge,
  createCharacterFile,
  createSaveStore,
} from '../../src/server/persist/saves.ts';
import { SaveReason } from '../../src/server/persist/saves.ts';
import { createTurnEngine } from '../../src/server/turn-engine.ts';
import { createRealms } from '../../src/server/world/realms.ts';
import { MASTERY_STEP, TALENT_MAX_LEVEL } from '../../src/shared/progression.ts';
import { PROTOCOL_VERSION } from '../../src/shared/version.ts';
import type { IdentityPort } from '../../src/server/net/gateway.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A CATEGORY POINT WAS SPENT AND THE NEXT RECONNECT TOOK BACK WHAT IT BOUGHT.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * REPORTED LIVE: *"we may have a bug retaining talent unspent points, category
 * points, generic points … when i leave game and rejoin the points
 * disappeared."*
 *
 * `handleHello` builds the body, calls `engine.attachClass` — which assembles
 * the sheet with `sheetForBody`, reading `unlockedTrees` and `deepenedTrees`
 * OFF THE BODY — and only then runs `restoreProgression`, which is where those
 * two lists used to be put on the body. The body `addPlayer` had just made
 * carried neither, so the sheet was always built as though nothing had ever
 * been bought:
 *
 *   - the bought discipline's six talents were not in the sheet, so
 *     `applyTalentPoints` dropped every rank saved in them as an id "this body
 *     no longer has" and the NEXT autosave wrote that loss to disk;
 *   - the deepened tree's mastery went back to its authored value, so a flat
 *     +20% on every rank in that tree quietly stopped applying;
 *   - and `unlockedTrees` / `deepenedTrees` stayed in the file, so
 *     `unspentCategories` still counted both points as spent. Three arrive in a
 *     fifty-level career (`CATEGORY_POINT_LEVELS`), and a Cityborn character is
 *     handed a fourth at birth.
 *
 * ═══ MEASURED, OVER A REAL SOCKET, BEFORE THE FIX ═══
 * A level-10 Watchman holding `generic/leverage` (bought) and
 * `watch/discipline` (deepened) with 2 ranks in `talent:overreach` reconnected
 * to a sheet of 33 talents instead of 39, no `overreach` at all, and
 * `watch/discipline` mastery at 1.15 where it had been 1.35.
 *
 * ═══ WHY THIS FILE DRIVES A SOCKET AND SEEDS A REAL FILE ═══
 * Every part worked alone. `unlockTree` wrote the list, the save layer wrote it
 * to disk, `parseCharacterFile` read it back and `sheetForBody` consumes it
 * correctly — the defect is only in the ORDER `handleHello` runs them in, which
 * is reachable no other way. `test/server/point-purses.test.ts` covers the
 * purse arithmetic and could not see this, because the arithmetic was never
 * wrong.
 */

const OWNER = '284739201847583744';
const HANDLE = 'ren-handle';
const CHARACTER = 'chr_main';
/** A locked, buyable discipline — `content/talent-trees.ts`. */
const BOUGHT_TREE = 'generic/leverage';
const BOUGHT_TALENT = 'talent:overreach';
/** A tree the Watchman is born knowing, so it can only be DEEPENED. */
const DEEPENED_TREE = 'watch/discipline';

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
  const waitFor = async (type: string, timeoutMs = 5000): Promise<Frame | undefined> => {
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
    forget: (): void => {
      frames = [];
    },
    close: (): void => {
      socket.close();
    },
  };
  openClients.push(client);
  return client;
}

type Harness = { port: number; close: () => Promise<void> };

let harness: Harness | undefined;
let root: string | undefined;

/**
 * The gateway with the realms, the real talent engine and the real persist
 * bridge behind it.
 *
 * THE TWO POINT SEAMS ARE `src/server/main.ts`'S, COPIED, and the copy is
 * deliberate rather than lazy: `wrapForGateway` is a closure inside
 * `buildServer`, so no test in the tree can reach the real object, and a sheet
 * that never receives its saved ranks would make this file pass for the wrong
 * reason. `attachClass` is NOT copied — `attachClassFor` is the shared stub and
 * goes through `sheetForBody` exactly as production does, which is the rule
 * this test is about.
 */
async function start(): Promise<Harness> {
  root = await mkdtemp(join(tmpdir(), 'inner-datum-discipline-'));
  const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };
  const app = Fastify({ logger: false });
  const talents = createContentTalentEngine();

  /**
   * THE SEAMS GO ON EVERY REALM'S ENGINE, WHICH IS WHERE PRODUCTION PUTS THEM.
   *
   * `main.ts` wraps the factory — `engineFor: (forWorld) =>
   * wrapForGateway(engineFor(forWorld))` — because `realmFor(session)` reads the
   * engine off the REALM the body is standing in, never off the `engine`
   * option, which is only the fallback for a session with no realm. A harness
   * that passes them on the option alone gets a gateway whose `attachClass` is
   * undefined and a character with no talents at all.
   */
  // ASSIGNED BELOW, ONCE THE REALMS EXIST, and reached through a closure rather
  // than by mutating the object: `createRealms` spreads `seams` into each
  // engine, so a later write to the field would never reach the copies.
  let attach: (actorId: string, classId: string) => void = () => undefined;
  const seams = {
    attachClass: (actorId: string, classId: string): void => {
      attach(actorId, classId);
    },
    // `main.ts`'s `talentPointsOf`, verbatim: a plain object, never the map.
    talentPointsOf: (actorId: string): Readonly<Record<string, number>> | undefined => {
      const sheet = talents.sheetOf(actorId);
      if (sheet === undefined) return undefined;
      const out: Record<string, number> = {};
      for (const [id, raw] of sheet.points) out[id] = raw;
      return out;
    },
    // `main.ts`'s `applyTalentPoints`, verbatim: an id the sheet does not have
    // is REPORTED, never seeded, and a rank is clamped rather than refused.
    applyTalentPoints: (
      actorId: string,
      points: Readonly<Record<string, number>>,
    ): readonly string[] | undefined => {
      const sheet = talents.sheetOf(actorId);
      if (sheet === undefined) return undefined;
      const dropped: string[] = [];
      for (const [talentId, raw] of Object.entries(points)) {
        if (!sheet.points.has(talentId) || !Number.isFinite(raw)) {
          dropped.push(talentId);
          continue;
        }
        sheet.points.set(talentId, Math.max(0, Math.min(TALENT_MAX_LEVEL, Math.floor(raw))));
      }
      return dropped;
    },
  };

  const realms = createRealms({
    seed: 'discipline-restore',
    engineFor: (world) => ({
      ...createTurnEngine({
        world,
        talents: createTalentBook(talents, world),
        talentRuntime: talentRuntimeFor(talents, world),
      }),
      ...seams,
    }),
  });
  // THE SHARED STUB, which goes through `sheetForBody` exactly as production
  // does — see `test/helpers/attach-class.ts`. Assigned after the realms exist
  // because it needs the world a restored body is placed in, which is the
  // overworld (`handleHello`'s `entryWorld`).
  attach = attachClassFor(talents, realms.overworld.world);
  const store = createSaveStore({ root, logger: quiet, debounceMs: 5 });

  // THE FILE OF A CHARACTER WHO HAS ALREADY SPENT BOTH CATEGORY POINTS, written
  // through the real writer so every field is shaped exactly as a live save is.
  await store.saveCharacter(
    createCharacterFile({
      id: CHARACTER,
      ownerId: OWNER,
      name: 'Ren',
      classId: 'watchman',
      level: 10,
      talentPoints: { [BOUGHT_TALENT]: 2 },
      unlockedTrees: [BOUGHT_TREE],
      deepenedTrees: [DEEPENED_TREE],
      resources: { hp: 100, ap: 1, mp: 0, special: { kind: 'resolve', value: 10 } },
    }),
    SaveReason.Manual,
  );

  await app.register(wsGateway, {
    world: realms.overworld.world,
    engine: realms.overworld.engine,
    realms,
    sessions: identityPort(),
    persist: createCharacterBridge({ store, logger: quiet }),
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (address === null || typeof address === 'string') throw new Error('no port was bound');
  return {
    port: address.port,
    close: async (): Promise<void> => {
      await app.close();
      await store.close();
    },
  };
}

/** Say hello as Ren, answering the roster with the one character on it. */
async function arrive(port: number): Promise<Client> {
  const client = await connect(port);
  client.send({ t: 'hello', sessionId: HANDLE });
  const roster = await client.waitFor('roster');
  const rows = (roster?.['characters'] ?? []) as { id: string }[];
  expect(rows.length, 'the seeded character is not on the roster').toBe(1);
  client.forget();
  client.send({ t: 'hello', sessionId: HANDLE, characterId: rows[0]?.id });
  await client.waitFor('welcome');
  await sleep(150);
  return client;
}

type WireTalent = { id: string; tree?: string; level?: number; mastery?: number };

function talentsOf(loadout: Frame | undefined): WireTalent[] {
  return [
    ...((loadout?.['talents'] ?? []) as WireTalent[]),
    ...((loadout?.['passives'] ?? []) as WireTalent[]),
  ];
}

afterEach(async () => {
  for (const client of openClients) client.close();
  openClients.length = 0;
  await harness?.close();
  harness = undefined;
  if (root !== undefined) await rm(root, { recursive: true, force: true });
  root = undefined;
});

describe('a discipline a category point bought survives the reconnect that rebuilt the body', () => {
  it('hands back the bought tree, its saved ranks and the deepened mastery', async () => {
    harness = await start();
    const client = await arrive(harness.port);
    const talents = talentsOf(client.last('loadout'));

    // THE DISCIPLINE ITSELF. Its six talents are the thing the point bought.
    const bought = talents.filter((talent) => talent.tree === BOUGHT_TREE);
    expect(bought.length, 'the bought discipline is not in the sheet').toBeGreaterThan(0);

    // AND THE RANKS INSIDE IT, which `applyTalentPoints` drops when the tree is
    // missing — the loss the next autosave then makes permanent. `level` on the
    // wire is the EFFECTIVE level (raw x mastery), so 2 raw is at least 2.
    const raised = bought.find((talent) => talent.id === BOUGHT_TALENT);
    expect(raised, `${BOUGHT_TALENT} came back with no entry at all`).toBeDefined();
    expect(raised?.level ?? 0, 'the saved ranks were dropped').toBeGreaterThanOrEqual(2);

    // AND THE OTHER THING A CATEGORY POINT BUYS — LevelupDialog.lua:435-436's
    // +0.2, which is a flat 20% on every rank in that tree, present and future.
    const deepened = talents.find((talent) => talent.tree === DEEPENED_TREE);
    expect(deepened, 'the deepened tree has no talents on the sheet').toBeDefined();
    // AGAINST THE CLASS'S OWN AUTHORED FIGURE PLUS ONE STEP, never against
    // another tree's: `masteries` is per class per tree (`TalentSheet.mastery`),
    // so a neighbouring tree is a different number and comparing with it would
    // assert nothing. `deepenedMastery` is `(authored ?? 1) + MASTERY_STEP`.
    const authored = classById('watchman')?.masteries?.[DEEPENED_TREE] ?? 1;
    expect(deepened?.mastery ?? 0, 'the deepening is not on the sheet').toBeCloseTo(
      authored + MASTERY_STEP,
      5,
    );
  });

  it('still counts both points as spent, so neither is handed back either', async () => {
    // THE OTHER DIRECTION OF THE SAME RULE. The lists stay in the file, so a
    // restore that rebuilt the sheet without them must not also refund the
    // points — a character would come back with a point in hand and no way to
    // notice the discipline it already paid for had gone.
    harness = await start();
    const client = await arrive(harness.port);
    const progress = client.last('progress');
    expect(progress, 'no progress frame arrived').toBeDefined();
    // Level 10 grants one at birth (Cityborn) and one at 10; both are spent.
    expect(progress?.['unspentCategories']).toBe(0);
    expect(progress?.['level']).toBe(10);
  });
});
