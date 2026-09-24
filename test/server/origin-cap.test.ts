// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/engines/default/engine/Birther.lua:392-396, :430-432 (a race's
//                         `inc_stats` go into the actor's `inc_stats`)
//             t-engine4 game/modules/tome/dialogs/LevelupDialog.lua:255, :259 (the cap reads
//                         `getStat(sid, nil, nil, true)`, which leaves `inc_stats` out)
//             t-engine4 game/modules/tome/data/birth/races/dwarf.lua:71 (the Archived's table)
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { attachClassFor } from '../helpers/attach-class.ts';

import {
  CLASSES,
  WATCHMAN,
  classById,
  createContentTalentEngine,
  createTalentBook,
} from '../../src/server/content/classes.ts';
import {
  ARCHIVED,
  CITYBORN,
  ORIGINS,
  capBaseOf,
  combatWithOrigin,
  originLifeDelta,
  originOf,
  withoutOriginStats,
} from '../../src/server/content/origins.ts';
import { resolveItem } from '../../src/server/content/resolve.ts';
import { STAT_BASE, stat } from '../../src/server/engine/derived.ts';
import { boughtSheet, recomposeCombat } from '../../src/server/engine/effects.ts';
import { createDownedState } from '../../src/server/engine/downed.ts';
import { maxLifeOf } from '../../src/server/engine/pools.ts';
import { talentLedgerSeams, talentRuntimeFor } from '../../src/server/main.ts';
import { wsGateway } from '../../src/server/net/gateway.ts';
import {
  SaveReason,
  createCharacterBridge,
  createCharacterFile,
  createSaveStore,
} from '../../src/server/persist/saves.ts';
import { createTurnEngine } from '../../src/server/turn-engine.ts';
import { createRealms } from '../../src/server/world/realms.ts';
import { LIFE_PER_CON, PLAYER_RANK } from '../../src/shared/leveling.ts';
import {
  MAX_CHARACTER_LEVEL,
  statCeilingForLevel,
  totalStatPointsAtLevel,
} from '../../src/shared/progression.ts';
import { ActorKind } from '../../src/shared/protocol.ts';
import { PROTOCOL_VERSION } from '../../src/shared/version.ts';
import type { CombatSheet } from '../../src/server/engine/combat.ts';
import type { PrimaryStats } from '../../src/server/engine/derived.ts';
import type { IdentityPort } from '../../src/server/net/gateway.ts';
import type { SaveStore } from '../../src/server/persist/saves.ts';
import type { Realms } from '../../src/server/world/realms.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * AN ORIGIN'S STAT MODIFIERS ARE OUTSIDE THE PER-LEVEL ATTRIBUTE CAP.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ToME's birther puts a race's stats in `inc_stats`, and every cap comparison
 * reads `getStat(sid, nil, nil, true)`, whose `no_inc` leaves `inc_stats` out.
 * Ours stored the origin in `baseCombat` and all five cap readers asked
 * `boughtSheet(x, x.baseCombat ?? x.combat)`, so the origin was INSIDE the cap.
 * They ask `capBaseOf` now.
 *
 * TWO THINGS MUST STILL SEE THE ORIGIN, and the last block pins one of them:
 * hit points pay for origin Constitution, as upstream pays for `inc_stats`
 * Constitution. (The other, the tier gates, reads `body.combat`, which this
 * change does not touch.)
 *
 * THE SOCKET HALF RESTORES A REAL FILE through the real store, because the
 * origin reaches the body through the file (`origin` on disk, `overlayFor` on
 * the way in) and a body built by hand could carry an origin no player can.
 */

type StatKey = Exclude<keyof PrimaryStats, 'lck'>;
const SIX: readonly StatKey[] = ['str', 'dex', 'con', 'mag', 'wil', 'cun'];

const sixOf = (sheet: CombatSheet | undefined): Record<StatKey, number> =>
  Object.fromEntries(SIX.map((key) => [key, stat(sheet ?? {}, key)])) as Record<StatKey, number>;

// ===========================================================================
// T1.1 — the inverse, over the whole matrix
// ===========================================================================

describe('withoutOriginStats takes back exactly what combatWithOrigin added', () => {
  it('gives every class its own six back under every origin', () => {
    // NOT VACUOUS: at least one origin has a NEGATIVE modifier. A version that
    // took off only the bonuses would pass against a matrix with none.
    const negatives = ORIGINS.filter((origin) =>
      Object.values(origin.statMods).some((value) => (value ?? 0) < 0),
    );
    expect(
      negatives.map((origin) => origin.id),
      'no origin has a penalty any more',
    ).toContain(ARCHIVED.id);

    for (const cls of CLASSES) {
      for (const origin of ORIGINS) {
        const back = withoutOriginStats(combatWithOrigin(cls.combat, origin), origin);
        expect(sixOf(back), `${cls.id} x ${origin.id}`).toEqual(sixOf(cls.combat));
      }
    }
  });

  it('also inverts a sheet that authored no stats at all', () => {
    // THE FILL ON THE WAY OUT: `combatWithOrigin` reads a missing stat as
    // STAT_BASE, and a version that read it as zero would come back short. The
    // way back never meets a missing stat here, because the way out wrote every
    // stat the origin names, so this pins the forward fill only. The next case
    // pins the reverse one.
    const bare: CombatSheet = {};
    for (const origin of ORIGINS) {
      expect(sixOf(withoutOriginStats(combatWithOrigin(bare, origin), origin))).toEqual(
        sixOf(bare),
      );
    }
  });

  it('fills a missing stat from STAT_BASE on the way back too, a penalty included', () => {
    // Taken off a sheet that never had it: the base less the modifier, so a
    // −2 comes off as +2. Read as zero, Dexterity would be 2 and not 12.
    const dex = ARCHIVED.statMods.dex ?? 0;
    expect(dex, 'the Archived no longer carry a Dexterity penalty').toBeLessThan(0);
    const back = withoutOriginStats({}, ARCHIVED);
    expect(back.stats?.dex).toBe(STAT_BASE - dex);
    expect(back.stats?.str).toBe(STAT_BASE - (ARCHIVED.statMods.str ?? 0));
  });

  it('hands a Cityborn sheet straight back, the same object', () => {
    expect(withoutOriginStats(WATCHMAN.combat, CITYBORN)).toBe(WATCHMAN.combat);
  });
});

describe('capBaseOf is the bought sheet with the origin taken off', () => {
  it("reads an Archived body's cap at the class's stats plus what it bought", () => {
    const body = {
      origin: ARCHIVED.id,
      baseCombat: combatWithOrigin(WATCHMAN.combat, ARCHIVED),
      spentStats: { str: 2, dex: 1 },
    };
    const cap = sixOf(capBaseOf(body));
    expect(cap.str).toBe(stat(WATCHMAN.combat, 'str') + 2);
    // THE PENALTY IS OUTSIDE TOO: −2 Dexterity does not buy two more points.
    expect(cap.dex).toBe(stat(WATCHMAN.combat, 'dex') + 1);
    expect(cap.con).toBe(stat(WATCHMAN.combat, 'con'));
  });

  it('is the old expression for a body with no origin recorded', () => {
    const body = { baseCombat: WATCHMAN.combat, spentStats: { str: 3 } };
    expect(capBaseOf(body)).toEqual(boughtSheet(body, body.baseCombat));
  });
});

// ===========================================================================
// The socket harness: a real store, a real file, the real gateway
// ===========================================================================

const OWNER = '384739201847583745';
const HANDLE = 'origin-cap-handle';

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
  bodyOf: (actorId: string) => ReturnType<Realms['overworld']['world']['getActor']>;
  close: () => Promise<void>;
};

const openHarnesses: Harness[] = [];

/** The gateway over the real realms, talent engine, persist bridge and ledger seams. */
async function start(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'inner-datum-origin-cap-'));
  const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };
  const app = Fastify({ logger: false });
  const talents = createContentTalentEngine();
  const downed = createDownedState();
  let attach: (actorId: string, classId: string) => void = () => undefined;
  const seams = {
    attachClass: (actorId: string, classId: string): void => {
      attach(actorId, classId);
    },
    ...talentLedgerSeams(talents),
    /**
     * THE POOL RESIZE, copied from `refreshPassives` in src/server/main.ts: the
     * refold, then `maxLifeOf` with the origin's half of the life rating. It is
     * not exported (it closes over the whole server), and without it a restored
     * body keeps the class's authored `maxHp`, which would make the hit-point
     * test below a test of this harness.
     */
    refreshBody: (actorId: string): void => {
      const actor = realms.realmOf(actorId)?.world.getActor(actorId);
      if (actor === undefined) return;
      recomposeCombat(actor, null, resolveItem);
      if (actor.kind !== ActorKind.Player || actor.classId === undefined) return;
      const definition = classById(actor.classId);
      if (definition === undefined) return;
      const origin = originOf(actor.origin);
      actor.maxHp = maxLifeOf(
        actor,
        { ...definition, lifeRating: definition.lifeRating + originLifeDelta(origin) },
        PLAYER_RANK,
      );
      actor.hp = Math.min(actor.hp, actor.maxHp);
    },
  };
  const realms = createRealms({
    seed: 'origin-cap',
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
  const store = createSaveStore({ root, logger: quiet, debounceMs: 5 });
  const identity: IdentityPort = {
    get: (id: string | undefined) =>
      id === HANDLE ? { user: { id: OWNER }, displayName: 'Ren' } : undefined,
  };
  await app.register(wsGateway, {
    world: realms.overworld.world,
    engine: realms.overworld.engine,
    realms,
    downed,
    sessions: identity,
    persist: createCharacterBridge({ store, logger: quiet }),
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (address === null || typeof address === 'string') throw new Error('no port was bound');
  const harness: Harness = {
    port: address.port,
    root,
    store,
    realms,
    bodyOf: (actorId) =>
      realms
        .all()
        .map((realm) => realm.world.getActor(actorId))
        .find((found) => found !== undefined),
    close: async (): Promise<void> => {
      await app.close();
      await store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
  openHarnesses.push(harness);
  return harness;
}

afterEach(async () => {
  for (const client of openClients) client.close();
  openClients.length = 0;
  for (const harness of openHarnesses) await harness.close();
  openHarnesses.length = 0;
});

/** Write a Watchman of this origin, level and ledger to disk, through the real writer. */
async function writeWatchman(
  harness: Harness,
  id: string,
  origin: string,
  level: number,
  spentStats?: PrimaryStats,
): Promise<void> {
  await harness.store.saveCharacter(
    createCharacterFile({
      id,
      ownerId: OWNER,
      name: 'Ren',
      classId: WATCHMAN.id,
      origin,
      level,
      talentPoints: {},
      ...(spentStats === undefined ? {} : { spentStats }),
      resources: { hp: 1000, special: { kind: 'resolve', value: 10 } },
    }),
    SaveReason.Manual,
  );
  await harness.store.flush();
}

/** Say hello, pick the character named, and hand back the client and the body. */
async function arrive(harness: Harness, characterId: string) {
  const client = await connect(harness.port);
  client.send({ t: 'hello', sessionId: HANDLE });
  const roster = await client.waitFor('roster');
  const rows = (roster?.['characters'] ?? []) as { id: string }[];
  expect(
    rows.map((row) => row.id),
    'the written character is not on the roster',
  ).toContain(characterId);
  client.forget();
  client.send({ t: 'hello', sessionId: HANDLE, characterId });
  const welcome = await client.waitFor('welcome');
  await client.settle();
  await sleep(120);
  const body = harness.bodyOf(String(welcome?.['selfId']));
  if (body === undefined) throw new Error('the restored body is in no realm');
  return { client, body };
}

// ===========================================================================
// T1.2 — the spend the old cap refused
// ===========================================================================

/**
 * THE LEVEL AND LEDGER WHERE THE TWO RULES PART COMPANY FOR ARCHIVED STRENGTH.
 *
 * The lowest level L, and the fewest Strength points k already bought (with a
 * point still in hand), where the class's Strength plus k is under
 * `statCeilingForLevel(L)` and the class's Strength plus k plus the origin's 4
 * is not. Searched rather than written down so that a retune of the class
 * sheet moves the witness instead of emptying it. At HEAD that is level 3 with
 * nothing bought: Strength 24 is under 24.2, and 28 is over it.
 */
function witness(classStr: number, originStr: number): { level: number; bought: number } {
  for (let level = 1; level <= MAX_CHARACTER_LEVEL; level += 1) {
    const ceiling = statCeilingForLevel(level);
    for (let bought = 0; bought < totalStatPointsAtLevel(level); bought += 1) {
      if (classStr + bought < ceiling && classStr + bought + originStr >= ceiling) {
        return { level, bought };
      }
    }
  }
  throw new Error('no level where the origin moves the Strength cap');
}

describe('an Archived Watchman may raise Strength that his origin already raised', () => {
  it('accepts the spend_stat the old cap refused', async () => {
    const originStr = ARCHIVED.statMods.str ?? 0;
    // THE SETUP, ASSERTED. dwarf.lua:71 is `str=4`.
    expect(originStr, 'the Archived no longer carry +4 Strength').toBe(4);
    const classStr = stat(WATCHMAN.combat, 'str');
    const { level, bought } = witness(classStr, originStr);

    const harness = await start();
    await writeWatchman(
      harness,
      'chr_archived_cap',
      ARCHIVED.id,
      level,
      bought > 0 ? { str: bought } : undefined,
    );
    const { client, body } = await arrive(harness, 'chr_archived_cap');
    if (body.kind !== 'player') throw new Error('the restored body is not a player');

    const ceiling = statCeilingForLevel(level);
    expect(body.level, 'the file came back at a different level').toBe(level);
    expect(body.origin, 'the origin did not come back off the file').toBe(ARCHIVED.id);
    expect(
      stat(body.combat ?? {}, 'str'),
      'composed Strength is under the ceiling, so nothing is being tested',
    ).toBeGreaterThanOrEqual(ceiling);
    // AND THE OLD EXPRESSION REALLY WOULD HAVE REFUSED: the origin is in `baseCombat`.
    expect(
      stat(boughtSheet(body, body.baseCombat ?? body.combat) ?? {}, 'str'),
      'the old cap base is under the ceiling too',
    ).toBeGreaterThanOrEqual(ceiling);
    expect(body.unspentStatPoints, 'no attribute point in hand').toBeGreaterThan(0);
    const purse = body.unspentStatPoints;

    client.forget();
    client.send({ t: 'spend_stat', stat: 'str' });
    await client.settle();

    expect(client.last('error'), 'the spend was refused').toBeUndefined();
    expect(body.spentStats?.str ?? 0, 'no Strength was bought').toBe(bought + 1);
    expect(body.unspentStatPoints).toBe(purse - 1);
  });
});

// ===========================================================================
// T1.3 — the panel and the character sheet agree about what was bought
// ===========================================================================

/** The bracketed figure on a stat row, or the bare figure when the row has none. */
function bracketed(value: string): number {
  const match = /\((-?\d+)\)\s*$/.exec(value);
  return Number(match === null ? value : match[1]);
}

describe("the talent panel's statBase is the character sheet's bracketed figure", () => {
  it('for all six, on an Archived Watchman', async () => {
    const harness = await start();
    await writeWatchman(harness, 'chr_archived_sheet', ARCHIVED.id, 5, { str: 1, dex: 2 });
    const { client, body } = await arrive(harness, 'chr_archived_sheet');

    const progress = client.last('progress');
    const statBase = progress?.['statBase'] as Record<StatKey, number> | undefined;
    expect(statBase, 'no statBase on the progress frame').toBeDefined();

    client.forget();
    client.send({ t: 'inspect', targetId: body.id });
    await client.settle();
    const view = client.last('inspected')?.['view'] as { rows?: Frame[] } | undefined;
    const rows = view?.rows ?? [];

    let differs = 0;
    for (const key of SIX) {
      const row = rows.find((candidate) => candidate['stat'] === key);
      expect(row, `no ${key} row on the character sheet`).toBeDefined();
      const value = String(row?.['value']);
      expect(bracketed(value), `${key}: sheet says ${value}`).toBe(
        Math.round(statBase?.[key] ?? NaN),
      );
      if (/\(/.test(value)) differs += 1;
    }
    // NOT VACUOUS: the origin shows as a bracket on the rows it moves, so the
    // comparison above is between two numbers that could have disagreed.
    expect(differs, 'no row printed a bracket').toBeGreaterThan(0);
    // AND BOTH ARE THE CAP BASE, origin left out.
    expect(statBase?.str).toBe(stat(WATCHMAN.combat, 'str') + 1);
    expect(statBase?.dex).toBe(stat(WATCHMAN.combat, 'dex') + 2);
  });
});

// ===========================================================================
// T1.4 — hit points still pay for the origin's Constitution
// ===========================================================================

describe("an Archived Watchman's hit points still count his origin's Constitution", () => {
  it('is the Cityborn figure plus four a point at level 1', async () => {
    const originCon = ARCHIVED.statMods.con ?? 0;
    expect(originCon, 'the Archived no longer carry +3 Constitution').toBe(3);

    // TWO SERVERS, ONE CHARACTER EACH: the same account on one server would be
    // a character swap, which is a different path from the one being asked about.
    const first = await start();
    await writeWatchman(first, 'chr_archived_life', ARCHIVED.id, 1);
    const archivedMax = (await arrive(first, 'chr_archived_life')).body.maxHp;
    const second = await start();
    await writeWatchman(second, 'chr_cityborn_life', CITYBORN.id, 1);
    const citybornMax = (await arrive(second, 'chr_cityborn_life')).body.maxHp;

    expect(archivedMax - citybornMax, 'the origin Constitution bought no hit points').toBe(
      originCon * LIFE_PER_CON,
    );
    // AND THE ABSOLUTE FIGURE: the class's own base, plus 3 x 4.
    expect(archivedMax).toBe(WATCHMAN.maxHp + originCon * LIFE_PER_CON);
  });
});
