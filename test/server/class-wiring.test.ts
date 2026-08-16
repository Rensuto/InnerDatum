import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';

import Fastify from 'fastify';

import {
  ALCHEMIST,
  CLASSES,
  INSPECTOR,
  WATCHMAN,
  createContentTalentEngine,
  loadoutViewFor,
  sheetForClass,
  toResourceView,
} from '../../src/server/content/classes.ts';
import { downedSpriteFor } from '../../src/server/engine/downed.ts';
import { AiProfile } from '../../src/server/engine/actor.ts';
import {
  FOCUS_ON_HELD_GROUND,
  FOCUS_PER_TURN,
  REAGENT_REGEN_EVERY_TURNS,
  RESOLVE_ON_STRUCK,
  RESOLVE_PER_TURN,
} from '../../src/server/engine/talents.ts';
import { talentRuntimeFor } from '../../src/server/main.ts';
import { actorIdForUser, wsGateway } from '../../src/server/net/gateway.ts';
import { createTurnEngine } from '../../src/server/turn-engine.ts';
import {
  projectClassOptions,
  projectResource,
  projectTurn,
} from '../../src/server/view/projector.ts';
import { createWorld } from '../../src/server/world/world.ts';
import { TALENT_MAX_LEVEL } from '../../src/shared/progression.ts';
import { ActorKind, TileCode } from '../../src/shared/protocol.ts';
import { PROTOCOL_VERSION } from '../../src/shared/version.ts';
import type { CharacterRestore, IdentityPort, PersistPort } from '../../src/server/net/gateway.ts';
import type { TurnState } from '../../src/server/view/projector.ts';
import type { PlayerActor } from '../../src/server/engine/actor.ts';
import type { World } from '../../src/server/world/world.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A CLASS ON EVERY BODY — WHO DECIDES, WHEN, AND WHAT IT PUTS ON THE ACTOR.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Before this milestone `world.addPlayer` set a name and
 * `spriteForJoinIndex(joinIndex)` and NOTHING ELSE. `sheetForClass` and
 * `createContentTalentEngine` were called only from tests. A player was a
 * sprite, not a Watchman: 60 hp for everybody, the placeholder combat sheet for
 * everybody, and an empty hotbar for everybody.
 *
 * WHAT IS PINNED HERE, AND WHY EACH ONE HAS TEETH:
 *
 *   THE ASSIGNMENT IS DETERMINISTIC AND THE FILE OVERRIDES IT. `actorIdForUser`
 *   is a stable hash, so a returning player IS the same actor id — but the
 *   rotation counter is per-process and never decremented, so rotation alone
 *   would make somebody a different class every evening. The character file is
 *   the only thing that remembers, so it wins, and it does NOT consume a place
 *   in the rotation for the people joining beside them.
 *
 *   THE ORDER IS LOAD-BEARING. `applyRestore` clamps a restored hp to
 *   `actor.maxHp`, and a classless body defaults to 60. Apply the class AFTER
 *   `addPlayer` and a Watchman who logged off at 70 comes back at 60, once per
 *   resume, with nothing failing anywhere. The class is therefore an ARGUMENT to
 *   `addPlayer`, and this file proves it by restoring above the default.
 *
 *   THE SPRITE COMES OFF THE `ClassDef`, so "a Watchman drawn as an Alchemist"
 *   is unrepresentable rather than merely avoided — and the two things DERIVED
 *   from that key (the `_downed_s` variant and the turn card's portrait) both
 *   resolve for all three classes.
 *
 *   THE HOTBAR CANNOT LIE ABOUT WHAT IT COSTS. AP and MP are deliberately not on
 *   the wire, which is only honest while they are structurally incapable of
 *   being short — so the most expensive button must fit in the smallest budget,
 *   and the budget must actually refill.
 *
 * ═══ WHY THIS FILE DRIVES A REAL SOCKET ═══
 * The class decision lives inside the gateway's `resolveActor`, between reading
 * the character file and calling `addPlayer`. Nothing exports it and nothing
 * should: the claim is about the ORDER of three private steps, and the only
 * place that order is observable is the body a `hello` produces.
 */

/** Snowflake-SHAPED, and nobody's real id. */
const REN_ID = '222222222222222222';
const ALEX_ID = '444444444444444444';

/** How long a `waitFor` waits before deciding a frame is never coming. */
const FRAME_TIMEOUT_MS = 2_000;

// ---------------------------------------------------------------------------
// The socket harness — deliberately the smallest one that can ask a question
// ---------------------------------------------------------------------------

type Frame = Record<string, unknown>;

type Client = {
  readonly frames: readonly Frame[];
  hello(sessionId?: string): Promise<Frame | undefined>;
  waitFor(type: string, timeoutMs?: number): Promise<Frame | undefined>;
  all(type: string): Frame[];
  close(): void;
};

const openClients: Client[] = [];

async function connect(port: number): Promise<Client> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
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
    frames,
    async hello(sessionId?: string) {
      socket.send(
        JSON.stringify({
          v: PROTOCOL_VERSION,
          t: 'hello',
          ...(sessionId === undefined ? {} : { sessionId }),
        }),
      );
      return await waitFor('welcome');
    },
    waitFor,
    all: (type: string): Frame[] => frames.filter((frame) => frame['t'] === type),
    close: (): void => {
      socket.close();
    },
  };

  openClients.push(client);
  return client;
}

// ---------------------------------------------------------------------------
// The server: the REAL gateway, the REAL turn engine, a stubbed disk
// ---------------------------------------------------------------------------

/**
 * A session table with two people in it and nothing else.
 *
 * `IdentityPort` is one method wide precisely so this is possible — see its note
 * in gateway.ts. What matters here is only that a handle resolves to a stable
 * Discord id, because that is what `actorIdForUser` hashes into the actor id a
 * returning player gets.
 */
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
 * A character store that only knows how to be READ, keyed by actor id.
 *
 * Writes go into `saved` rather than to a disk: what this file is about is the
 * class a body is BUILT with, and persist/saves.ts already owns the bytes (see
 * test/server/saves-identity.test.ts, which asserts the round trip for real).
 */
type Disk = {
  readonly restores: Map<string, CharacterRestore>;
  readonly saved: { classId?: string; hp: number }[];
  readonly port: PersistPort;
};

function disk(): Disk {
  const restores = new Map<string, CharacterRestore>();
  const saved: { classId?: string; hp: number }[] = [];
  return {
    restores,
    saved,
    port: {
      savePlayers: (snapshots) => {
        for (const snapshot of snapshots) {
          saved.push({
            hp: snapshot.hp,
            ...(snapshot.classId === undefined ? {} : { classId: snapshot.classId }),
          });
        }
      },
      openCharacter: (_ownerId: string, actorId: string): Promise<CharacterRestore | null> =>
        Promise.resolve(restores.get(actorId) ?? null),
    },
  };
}

type Harness = {
  readonly port: number;
  readonly world: World;
  readonly disk: Disk;
  /** Every log line the server emitted, as raw NDJSON. */
  readonly logs: string[];
  close(): Promise<void>;
};

async function boot(seed: string): Promise<Harness> {
  const logs: string[] = [];
  const app = Fastify({
    // pino writes NDJSON here rather than to stdout, which is what makes "the
    // substitution was logged" a testable claim instead of a hope.
    logger: {
      level: 'warn',
      stream: {
        write: (line: string): void => {
          logs.push(line);
        },
      },
    },
  });
  const world = createWorld(seed);
  const store = disk();

  await app.register(wsGateway, {
    world,
    engine: createTurnEngine({ world }),
    sessions: identityPort(),
    persist: store.port,
    disconnectGraceMs: 30_000,
  });
  await app.listen({ host: '127.0.0.1', port: 0 });

  const address = app.server.address();
  if (address === null || typeof address === 'string') throw new Error('no port was bound');

  return {
    port: address.port,
    world,
    disk: store,
    logs,
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
 * The body behind a `welcome`, read out of the world rather than off the wire.
 *
 * NARROWED TO A PLAYER, because `classId` lives on `PlayerActor` and not on the
 * union — which is the whole point of the discriminant: a monster has no class,
 * so the field is not reachable without saying which kind of body this is.
 */
function bodyOf(welcome: Frame | undefined): PlayerActor {
  const id = String(welcome?.['selfId']);
  const actor = server.world.getActor(id);
  if (actor === undefined) throw new Error(`test fixture: no actor for ${id}`);
  if (actor.kind !== ActorKind.Player) throw new Error(`test fixture: ${id} is not a player`);
  return actor;
}

// ===========================================================================
// 1. WHICH CLASS, AND WHAT IT PUTS ON THE BODY
// ===========================================================================

describe('a first-ever join', () => {
  it('is assigned a class by rotation, and the whole body comes from that ClassDef', async () => {
    server = await boot('class-rotation');

    const first = bodyOf(await (await connect(server.port)).hello());
    const second = bodyOf(await (await connect(server.port)).hello());
    const third = bodyOf(await (await connect(server.port)).hello());

    // ROTATION, NOT A FIXED DEFAULT. Three friends on the first evening the
    // feature exists must not be handed three identical hotbars — and there is
    // no chooser yet to tell them apart with.
    expect([first.classId, second.classId, third.classId]).toEqual([
      WATCHMAN.id,
      INSPECTOR.id,
      ALCHEMIST.id,
    ]);

    // EVERY FIELD, from the definition. Not "a sprite and then some numbers
    // somewhere else": half a class blended with the classless placeholder is a
    // body nobody authored, which is why `createPlayerActor` takes the combat
    // sheet WHOLESALE.
    expect(first.sprite).toBe(WATCHMAN.sprite);
    expect(first.maxHp).toBe(WATCHMAN.maxHp);
    expect(first.hp).toBe(WATCHMAN.maxHp);
    expect(first.hpRegen).toBe(WATCHMAN.hpRegen);
    expect(first.combat).toBe(WATCHMAN.combat);
    // …and the Alchemist really is the squishiest body rather than a third
    // Watchman with different art.
    expect(third.maxHp).toBe(ALCHEMIST.maxHp);
    expect(third.combat).toBe(ALCHEMIST.combat);
  });

  it('rotates past six players without ever reaching a class that does not exist', async () => {
    // `world.ts#PLAYER_SPRITES` is still SIX wide — it is the classless fallback
    // — and `CLASSES` is three. Before the overlay, the fourth player joined as
    // `chr_player_enforcer_s`: art for a class with no `_downed_s` variant, no
    // portrait and no loadout. The rotation that decides a class is the
    // gateway's and is three wide, so the fourth is a Watchman again.
    server = await boot('class-rotation-wrap');

    const bodies: PlayerActor[] = [];
    for (let i = 0; i < 4; i += 1) {
      bodies.push(bodyOf(await (await connect(server.port)).hello()));
    }

    expect(bodies.map((actor) => actor.classId)).toEqual([
      WATCHMAN.id,
      INSPECTOR.id,
      ALCHEMIST.id,
      WATCHMAN.id,
    ]);
    expect(bodies.every((actor) => actor.sprite.includes('enforcer'))).toBe(false);
  });
});

describe('a returning player', () => {
  it('gets the class in their file, whatever the rotation would have said', async () => {
    server = await boot('class-from-file');
    // The rotation is at zero, so a fresh join here would be a Watchman.
    server.disk.restores.set(actorIdForUser(REN_ID), {
      hp: 40,
      cooldowns: {},
      classId: ALCHEMIST.id,
    });

    const ren = bodyOf(await (await connect(server.port)).hello('ren-handle'));
    expect(ren.classId).toBe(ALCHEMIST.id);
    expect(ren.maxHp).toBe(ALCHEMIST.maxHp);

    // ═══ AND THEY DID NOT CONSUME A PLACE IN THE ROTATION ═══
    // Ren was never rolled for, so the next person to join fresh is still the
    // first — otherwise three friends who each reconnect once end up as three
    // Watchmen, which is the failure the rotation exists to prevent.
    const alex = bodyOf(await (await connect(server.port)).hello('alex-handle'));
    expect(alex.classId).toBe(WATCHMAN.id);
  });

  it('is not filed down to 60 hp by the restore — the class is applied FIRST', async () => {
    // ═══════════════════════════════════════════════════════════════════════
    // THE ORDER BUG THIS TEST EXISTS FOR, IN ONE LINE.
    // ═══════════════════════════════════════════════════════════════════════
    //
    // `applyRestore` clamps to `Math.min(actor.maxHp, …)`. A classless body's
    // maxHp is 60 (`DEFAULT_PLAYER_MAX_HP`). So a Watchman who logged off at 70
    // out of 72 comes back at 60 if the class arrives one line later — a silent
    // 10 hp tax, once per resume, that nothing anywhere reports.
    server = await boot('class-before-restore');
    server.disk.restores.set(actorIdForUser(REN_ID), {
      hp: 70,
      cooldowns: {},
      classId: WATCHMAN.id,
    });

    const ren = bodyOf(await (await connect(server.port)).hello('ren-handle'));

    expect(ren.maxHp).toBe(WATCHMAN.maxHp);
    // A BAND RATHER THAN AN EQUALITY, and the reason is real: the pump at the
    // foot of `hello` has already ticked one game turn of the Watchman's 0.5
    // hp regen, so the figure is 70.5. What is under test is that nothing
    // CLAMPED — 60 is what a clamp looks like, and it is ten below the floor.
    expect(ren.hp).toBeGreaterThanOrEqual(70);
    expect(ren.hp).toBeLessThanOrEqual(WATCHMAN.maxHp);
  });

  it('substitutes and LOGS when the file names a class this build does not have', async () => {
    // A SOFT reference all the way to the disk (persist/saves.ts): a save from a
    // build with a fourth class must never be the reason somebody cannot play
    // tonight. It is also the only evidence that a class was renamed, so it is
    // a warning rather than a shrug.
    server = await boot('class-dangling');
    server.disk.restores.set(actorIdForUser(REN_ID), {
      hp: 30,
      cooldowns: {},
      classId: 'class_deleted_in_m6',
    });

    const ren = bodyOf(await (await connect(server.port)).hello('ren-handle'));

    expect(ren.classId).toBe(WATCHMAN.id);
    const warned = server.logs.filter((line) => line.includes('class_deleted_in_m6'));
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain('substituting');
  });
});

// ===========================================================================
// 2. THE THREE THINGS DERIVED FROM THE SPRITE
// ===========================================================================

describe('every class sprite resolves to real art', () => {
  it('has a matching _downed_s key, derived rather than looked up', () => {
    // `goDown` swaps a body's sprite for the downed variant by APPENDING AN
    // INFIX (engine/downed.ts), which is what keeps the engine free of the
    // content layer. That only works while every authored `downedSprite` is
    // exactly what the derivation produces — the art is gitignored wholesale,
    // so a mismatch renders as a violet fallback box under a body on the floor.
    for (const definition of CLASSES) {
      expect(downedSpriteFor(definition.sprite)).toBe(definition.downedSprite);
    }
  });

  it('has its own portrait on the turn card, standing AND on the floor', async () => {
    // `portraitForPlayer` strips both suffixes so a downed body keeps the same
    // face — the one moment the party most needs to recognise whose body that
    // is. A class whose sprite family is not in the table would fall back to the
    // generic detective at that exact moment.
    server = await boot('class-portraits');
    const world = createWorld('class-portraits-world');
    world.level.tiles.fill(TileCode.FLOOR);

    const state: TurnState = {
      gameTurn: 1,
      engagement: 0,
      whoseTurn: [],
      committed: [],
      standingBy: [],
      bellDurationMs: null,
    };

    const expected = [
      'icon_character_the_watchman',
      'icon_character_the_inspector',
      'icon_character_the_alchemist',
    ];
    CLASSES.forEach((definition, index) => {
      world.addPlayer(`p${String(index)}`, definition.name, { sprite: definition.sprite });
    });
    const viewer = world.getActor('p0');
    if (viewer === undefined) throw new Error('test fixture: no viewer');

    const standing = projectTurn(viewer, world, state, null).actors;
    expect(standing.map((card) => card.portrait)).toEqual(expected);

    // …and again with every body swapped to its downed key.
    for (const definition of CLASSES) {
      const body = world.allActors().find((actor) => actor.sprite === definition.sprite);
      if (body !== undefined) body.sprite = definition.downedSprite;
    }
    const fallen = projectTurn(viewer, world, state, null).actors;
    expect(fallen.map((card) => card.portrait)).toEqual(expected);
  });

  it('has a portrait row of its own, so a fourth class cannot ship a generic face', async () => {
    // ═══════════════════════════════════════════════════════════════════════
    // THE TABLE MUST HAVE A ROW PER CLASS, AND THE FALLBACK MUST STAY UNUSED.
    // ═══════════════════════════════════════════════════════════════════════
    //
    // `PORTRAIT_BY_CLASS` (view/projector.ts) falls back to
    // `icon_character_the_detective` for a body wearing a sprite no class
    // authored — which is right for the classless rotation in world.ts and for
    // a GM-dressed body, and WRONG for a real class, because it would mean a
    // class shipped without a face and nothing anywhere would fail.
    //
    // Asked through `projectClassOptions` rather than by exporting the table:
    // the claim is about what reaches a player on the picker, which is the one
    // screen where a generic face is indistinguishable from a bug and the one
    // screen a new player cannot skip. Adding a fourth `ClassDef` without a
    // portrait row fails HERE, at the point the card is built.
    //
    // A server is booted although nothing here talks to one: this file's
    // `afterEach` closes `server` unconditionally, so leaving it holding the
    // previous test's already-closed handle is how a passing test breaks the
    // next one.
    server = await boot('class-portrait-rows');

    const options = projectClassOptions().options;
    expect(options.map((option) => option.id)).toEqual(CLASSES.map((c) => c.id));

    for (const option of options) {
      expect(option.portrait).not.toBe('icon_character_the_detective');
      // An asset KEY from the family that exists on disk, never one derived
      // from the class NAME — ToME mangles its birther icon names and gets away
      // with it because it ships an `unknown_32_bg.png`; this repo gitignores
      // client/public/assets/ wholesale and draws a violet box instead.
      expect(option.portrait.startsWith('icon_character_')).toBe(true);
    }
    // One face per class, so two classes cannot quietly share a portrait row.
    expect(new Set(options.map((option) => option.portrait)).size).toBe(CLASSES.length);
  });
});

// ===========================================================================
// 3. THE BUDGET THE HOTBAR SPENDS
// ===========================================================================

describe('AP and MP are structurally incapable of being short', () => {
  it('keeps the most expensive button inside the smallest budget', () => {
    // ═══════════════════════════════════════════════════════════════════════
    // THE ASSERTION THAT KEEPS THE HOTBAR HONEST WITHOUT AN AP/MP WIRE FRAME.
    // ═══════════════════════════════════════════════════════════════════════
    //
    // AP and MP are deliberately NOT on the wire: DECISIONS.md D1 pins a player
    // to one action per turn, `actBase` refills every base turn, and nothing
    // else decrements `sheet.ap` — Lockdown's `drainActionBudget` writes the
    // VICTIM'S ENERGY and says so. So a cost can never be unaffordable at the
    // moment of use, and the client needs no bar to draw.
    //
    // That is only true while this holds. The day somebody authors a 7-AP
    // talent the BUILD fails here, instead of a button greying out in play with
    // nothing on the wire to explain why.
    //
    // ═══════════════════════════════════════════════════════════════════════
    // TALENT POINTS DO NOT REACH THIS GUARD, AND THAT IS A DESIGN RULE.
    // ═══════════════════════════════════════════════════════════════════════
    //
    // A rank buys ONE scaled number per talent and never a cost: every `AP_COST`
    // and `MP_COST` in src/server/talents/ is a module constant, several of them
    // labelled FROZEN in their own file with the reason (fog_step.ts: "a rank
    // that made it cheaper would make it the first button pressed"). So
    // `TalentCost` stays a property of the CATALOGUE while `range` and `desc`
    // became properties of the ACTOR, which is why this guard can still be
    // asked of a `ClassDef` rather than of a per-actor `LoadoutTalent` view.
    //
    // The day somebody scales a cost, this assertion stops being sufficient
    // rather than stops being true: it would prove the RANK-1 cost fits the
    // budget while a rank-5 Fog Step at 7 AP quietly did not. Whoever writes
    // that curve owes this test a loop over 1..TALENT_MAX_LEVEL.
    const apCosts = CLASSES.flatMap((c) => c.loadout.map((talent) => talent.cost.ap ?? 0));
    const mpCosts = CLASSES.flatMap((c) => c.loadout.map((talent) => talent.cost.mp ?? 0));

    expect(Math.max(...apCosts)).toBeLessThanOrEqual(Math.min(...CLASSES.map((c) => c.maxAp)));
    expect(Math.max(...mpCosts)).toBeLessThanOrEqual(Math.min(...CLASSES.map((c) => c.maxMp)));

    // And the wire view a PICKER builds agrees with the authored numbers it was
    // built from, at every one of the twelve, so a future `toLoadoutView` that
    // scaled a cost would fail here rather than three screens away.
    const viewCosts = CLASSES.flatMap((c) => loadoutViewFor(c).map((talent) => talent.cost.ap));
    expect(viewCosts).toEqual(apCosts);
  });

  it('previews an unlearned class at level 1, on every talent of every class', () => {
    // ═══════════════════════════════════════════════════════════════════════
    // THE PICKER HAS NO ACTOR, SO IT HAS NO RANK TO READ — IT STATES ONE.
    // ═══════════════════════════════════════════════════════════════════════
    //
    // `loadoutViewFor(definition)` is the class-picker path
    // (`projectClassOptions` -> `toClassOptionView`, view/projector.ts). It is
    // shown to somebody who has not chosen a class, so there is no sheet, no
    // points and no rank anywhere — and `toLoadoutView` needs a level. It passes
    // 1 explicitly: an UNLEARNED class is previewed at its BIRTH level, which is
    // exactly what a picker should show ("this is what you get if you take it,
    // before you have spent anything").
    //
    // WHY THIS IS WORTH A TEST RATHER THAN BEING OBVIOUS: the alternative that
    // would look tidier is reading the VIEWER's current provisional body, which
    // is wearing a DIFFERENT class — every displayed number would then be
    // computed against the wrong combat sheet, and nothing would fail. The
    // assertion below is the whole of the guard against that, plus the guard
    // against a future default of 0 (`combatTalentScale` maps 0 to a tenth of
    // the damage rather than refusing, so a level-0 preview would silently
    // under-sell every class).
    for (const definition of CLASSES) {
      const view = loadoutViewFor(definition);
      expect(view).toHaveLength(definition.loadout.length);
      for (const talent of view) {
        expect(talent.level).toBe(1);
        expect(talent.maxLevel).toBe(TALENT_MAX_LEVEL);
        // A rendered sentence, not an empty string, and the rank-2 diff beside
        // it — a picker card with a blank description is indistinguishable from
        // a broken one, and `descNext` must not be null below the cap.
        expect(talent.desc.length).toBeGreaterThan(0);
        expect(talent.descNext).not.toBeNull();
        expect(talent.descNext).not.toBe(talent.desc);
      }
    }

    // AND THE RANGE IS THE LEVEL-1 RANGE, which is the one field where "level 1"
    // is observable rather than merely stated. Fog Step is the only talent whose
    // range scales (3/4/5/6/7 on `combatTalentLimit(t, 10, 3, 7)`,
    // mobility.lua:40-62), so a picker that previewed it at any other rank would
    // advertise a mobility the class does not start with.
    const inspectorView = loadoutViewFor(INSPECTOR);
    const fogStep = inspectorView.find((talent) => talent.id === 'talent:fog_step');
    expect(fogStep?.range).toBe(3);
  });

  it('refills both on the next base turn, through the adapter main.ts ships', async () => {
    // ═══ NOT OPTIONAL, AND THE FAILURE IS SILENT ═══
    // Sheets are created FULL and are only ever decremented, so a class attached
    // WITHOUT this call drains AP monotonically from the first cast and never
    // refills. Nothing throws; the hotbar simply stops working three fights in.
    //
    // Driven through `talentRuntimeFor` — the adapter src/server/main.ts hands
    // to `createTurnEngine` — rather than a copy written here, because a copy
    // would go on passing on the day the shipped one stopped calling `actBase`.
    server = await boot('class-refill');

    const world = createWorld('class-refill-world');
    world.level.tiles.fill(TileCode.FLOOR);
    const ren = world.addPlayer('p1', 'Ren', { maxHp: WATCHMAN.maxHp });
    ren.x = 10;
    ren.y = 10;
    ren.hpRegen = 0;
    // Far enough away to keep the fight armed without ever reaching anybody, so
    // the barrier parks every turn and nothing interrupts the measurement.
    world.addMonster('m_husk', {
      name: 'Index Husk',
      sprite: 'enemy_index_husk_s',
      x: 24,
      y: 10,
      profile: AiProfile.MeleeChaser,
      maxHp: 500,
    });

    const talents = createContentTalentEngine();
    const sheet = talents.attach('p1', sheetForClass(WATCHMAN));
    const engine = createTurnEngine({
      world,
      now: () => 0,
      talentRuntime: talentRuntimeFor(talents, world),
    });
    engine.join('p1');
    world.turn.engagement = 3;

    sheet.ap = 0;
    sheet.mp = 0;
    expect(engine.hold('p1').ok).toBe(true);
    engine.pump();

    expect(sheet.ap).toBe(sheet.maxAp);
    expect(sheet.mp).toBe(sheet.maxMp);
  });

  it('suppresses the Inspector’s Focus on a turn she MOVED', async () => {
    // ═══ `movedThisTurn` HAD NO WRITER ANYWHERE IN src/ ═══
    // So the Inspector regained her full 12 Focus every turn whatever she did —
    // her entire class mechanic ("Focus builds by holding LOS on a marked target
    // and by NOT MOVING", game-design.md § 2) was a per-turn stipend. The writer
    // is `noteMoved` on the adapter under test.
    //
    // Asserted through the RESOURCE, because the flag is set by the move and
    // consumed by the very next base pass inside the SAME pump: by the time
    // `pump` returns it has already done its job and been cleared.
    server = await boot('class-focus');

    const world = createWorld('class-focus-world');
    world.level.tiles.fill(TileCode.FLOOR);
    const vex = world.addPlayer('p1', 'Vex', { maxHp: INSPECTOR.maxHp });
    vex.x = 10;
    vex.y = 10;
    vex.hpRegen = 0;
    world.addMonster('m_husk', {
      name: 'Index Husk',
      sprite: 'enemy_index_husk_s',
      x: 24,
      y: 10,
      profile: AiProfile.MeleeChaser,
      maxHp: 500,
    });

    const talents = createContentTalentEngine();
    const sheet = talents.attach('p1', sheetForClass(INSPECTOR));
    const engine = createTurnEngine({
      world,
      now: () => 0,
      talentRuntime: talentRuntimeFor(talents, world),
    });
    engine.join('p1');
    world.turn.engagement = 3;

    // The first pump carries TWO base passes — one before the actor has ever
    // acted — so it is burned rather than measured.
    expect(engine.hold('p1').ok).toBe(true);
    engine.pump();

    const delta = (act: () => void): number => {
      const before = sheet.resource.value;
      act();
      engine.pump();
      return sheet.resource.value - before;
    };

    // ONE BASE TURN PER `delta`, so each expectation carries exactly one flat
    // `FOCUS_PER_TURN` on top of the clause it is actually about. That trickle
    // is unconditional (`regenPerTurn` is added before the per-class switch in
    // `regenResource`), so it appears in BOTH answers and neither figure is
    // tuned to make the test green — the difference between them is still
    // exactly `FOCUS_ON_HELD_GROUND`.
    // `toBeCloseTo` AND NOT `toBe`, for a reason worth stating once: a
    // CONTINUOUS pool now accumulates a fractional rate, and 0.4 is not
    // representable in binary — a delta measured off a pool that has already
    // taken a few adds is 12.400000000000002, not 12.4. That drift is confined
    // to Resolve and Focus by design. It is exactly why Reagents keep their
    // remainder on an integer counter instead: a DISCRETE pool that drifted by
    // 2e-15 would eventually floor to the wrong pip.
    expect(
      delta(() => {
        expect(engine.hold('p1').ok).toBe(true);
      }),
    ).toBeCloseTo(FOCUS_ON_HELD_GROUND + FOCUS_PER_TURN, 6);
    expect(
      delta(() => {
        expect(engine.submitMove('p1', 'w').ok).toBe(true);
      }),
    ).toBeCloseTo(FOCUS_PER_TURN, 6);
  });
});

// ===========================================================================
// THE TWO CLASS RESOURCES THAT HAD NO INCOME AT ALL
// ===========================================================================

describe('a class resource that can only be earned in play', () => {
  /**
   * One player of `definition`, a husk east of them, a real content talent
   * engine and the adapter src/server/main.ts actually ships.
   *
   * `talentRuntimeFor` rather than a copy written here, for the reason the
   * `actBase` test above gives: a copy keeps passing on the day the shipped one
   * stops forwarding a hook.
   */
  const bench = (
    seed: string,
    definition: typeof WATCHMAN,
    monster: { readonly maxHp?: number; readonly atk?: number } = {},
  ): {
    readonly world: World;
    readonly sheet: ReturnType<typeof sheetForClass>;
    readonly engine: ReturnType<typeof createTurnEngine>;
    readonly player: PlayerActor;
  } => {
    const world = createWorld(seed);
    world.level.tiles.fill(TileCode.FLOOR);

    const player = world.addPlayer('p1', 'Ren', {
      maxHp: definition.maxHp,
      combat: definition.combat,
      classId: definition.id,
    });
    player.x = 10;
    player.y = 10;
    player.hpRegen = 0;

    const husk = world.addMonster('m_husk', {
      name: 'Index Husk',
      sprite: 'enemy_index_husk_s',
      x: 11,
      y: 10,
      profile: AiProfile.MeleeChaser,
      maxHp: monster.maxHp ?? 40,
    });
    // Accuracy that beats any defence in this file, so the assertion is decided
    // by the wiring rather than by which seed happened to roll well.
    if (monster.atk !== undefined) husk.combat = { mods: { atk: monster.atk } };

    const talents = createContentTalentEngine();
    const sheet = talents.attach('p1', sheetForClass(definition));
    const engine = createTurnEngine({
      world,
      now: () => 0,
      talentRuntime: talentRuntimeFor(talents, world),
    });
    engine.join('p1');
    world.turn.engagement = 3;

    if (player.kind !== ActorKind.Player) throw new Error('fixture: p1 is not a player');
    return { world, sheet, engine, player };
  };

  it('pays the Alchemist a Reagent for a kill landed by the BASIC SWING', () => {
    // ═══════════════════════════════════════════════════════════════════════
    // THE ONE-WAY DOOR THIS CLOSES.
    // ═══════════════════════════════════════════════════════════════════════
    //
    // KILLS ARE THE ALCHEMIST'S ECONOMY. There is now also a slow floor under
    // her — one whole vial every `REAGENT_REGEN_EVERY_TURNS` base turns — but it
    // pays roughly half what bodies do and it is deliberately NOT what this test
    // is about. (This comment used to say a kill was her ONLY income, which was
    // true when it was written and is the exact sentence that would mislead the
    // next reader into thinking a green here proves the whole economy.)
    //
    // `TalentEngine.noteKill` was called from exactly two places, both inside
    // talents.ts's own damage helpers — so a kill landed by the bump swing,
    // which is where most of her kills come from, paid nothing. Eight actions
    // in, the pool hit 0 and every one of her four talents answered
    // `no_resource` for the rest of the process, with no mechanism left that
    // could grant one. `noteStairs` has never had a call site, so the only
    // escape was to leave the world entirely. That is the failure this closes,
    // and the timed floor does not close it: at twelve turns a vial it would
    // have taken a minute and a half of walking to buy back one cast.
    const table = bench('reagent-basic-kill', ALCHEMIST);
    // Enough to kill in one swing, so the assertion is about the wiring.
    table.player.combat = { mods: { atk: 60, dam: 2000 } };
    const husk = table.world.getActor('m_husk');
    if (husk === undefined) throw new Error('fixture: the husk is missing');
    husk.hp = 1;

    table.sheet.resource.value = 2;
    expect(table.engine.submitMove('p1', 'e').ok).toBe(true);
    const result = table.engine.pump();

    // It really was the basic swing, and the body really did die.
    expect(result.reaped).toEqual(['m_husk']);
    expect(table.sheet.resource.value).toBe(3);
    // ═══ THE TURN COUNT IS PINNED, NOT ASSUMED ═══
    // The pool stayed below its cap for the whole pump, so `regenCounter` IS the
    // number of base turns that elapsed — an exact, readable clock. Asserting it
    // is what stops this test from silently becoming "a kill plus whatever the
    // timer happened to hand out" if the pump ever carries more passes. Two, and
    // twelve are needed for a vial, so the +1 above came from the corpse.
    expect(table.sheet.resource.regenCounter).toBe(2);
  });

  it('pays it exactly ONCE, so a party racing the same body cannot double-dip', () => {
    // `killed` is true exactly once per body (damage.ts returns an empty outcome
    // against something already down), which is the same property that makes the
    // reap enrolment idempotent. Two payment sites would break it — which is why
    // the calls inside talents.ts were removed rather than a third added.
    const table = bench('reagent-once', ALCHEMIST);
    table.player.combat = { mods: { atk: 60, dam: 2000 } };
    const husk = table.world.getActor('m_husk');
    if (husk === undefined) throw new Error('fixture: the husk is missing');
    husk.hp = 1;

    table.sheet.resource.value = 0;
    expect(table.engine.submitMove('p1', 'e').ok).toBe(true);
    table.engine.pump();
    expect(table.sheet.resource.value).toBe(1);
    expect(table.sheet.resource.regenCounter).toBe(2);

    // ...and pumping again over the corpse adds nothing.
    expect(table.engine.hold('p1').ok).toBe(true);
    table.engine.pump();
    expect(table.sheet.resource.value).toBe(1);
    // THE COUNT IS PINNED FOR THE SAME REASON as the test above: the pool never
    // reached its cap, so `regenCounter` is exactly the base turns elapsed. Three
    // is well inside `REAGENT_REGEN_EVERY_TURNS`, which is what makes "adds
    // nothing" a claim about `noteKill` rather than about the clock — if a
    // future pump carried twelve passes this would go red HERE, naming the real
    // reason, instead of the reagent count going quietly wrong.
    expect(table.sheet.resource.regenCounter).toBe(3);
    expect(table.sheet.resource.regenCounter).toBeLessThan(REAGENT_REGEN_EVERY_TURNS);
  });

  it('puts the timed vial ON THE WIRE, through a real pump and the real projector', () => {
    // ═══════════════════════════════════════════════════════════════════════
    // END TO END, BECAUSE "THE CODE THAT WOULD MAKE IT WORK EXISTS" IS NOT IT.
    // ═══════════════════════════════════════════════════════════════════════
    // The talent icons sat on disk for weeks behind a dead prefix while every
    // unit test passed. So this drives a REAL `createTurnEngine` through more
    // than `REAGENT_REGEN_EVERY_TURNS` base turns and reads the answer off
    // `projectResource` — the same function the gateway sends — rather than off
    // the sheet. Everything between `actBase` and the browser is in the path.
    const table = bench('reagent-regen-wire', ALCHEMIST, { maxHp: 500 });
    // She must survive the wait, and the husk must not die (a kill would pay her
    // a reagent through `noteKill` and the assertion would be about the wrong
    // mechanism entirely).
    table.player.maxHp = 100_000;
    table.player.hp = 100_000;

    table.sheet.resource.value = 3;
    table.sheet.resource.regenCounter = 0;

    const wireValue = (): number => {
      const frame = projectResource(table.player, toResourceView(table.sheet));
      if (frame === null) throw new Error('the Alchemist has no resource frame');
      // The property the pips depend on, asserted on the WIRE and not on the
      // pool: a discrete resource is a whole number by the time it leaves.
      expect(frame.resource.discrete).toBe(true);
      expect(Number.isInteger(frame.resource.current)).toBe(true);
      return frame.resource.current;
    };

    expect(wireValue()).toBe(3);

    // `PUMPS` pumps carry `PUMPS + 1` base passes (the first carries two), so
    // this crosses twelve and lands on it exactly once.
    const PUMPS = REAGENT_REGEN_EVERY_TURNS - 1;
    const trace: number[] = [];
    for (let pump = 0; pump < PUMPS; pump += 1) {
      expect(table.engine.hold('p1').ok).toBe(true);
      table.engine.pump();
      trace.push(wireValue());
    }

    // The vial arrived, exactly one of it, and every frame before it read 3 —
    // no partial value was ever sent.
    expect(table.sheet.resource.regenCounter).toBe(0);
    expect(wireValue()).toBe(4);
    expect(trace.filter((value) => value === 3)).toHaveLength(PUMPS - 1);
    expect(trace[trace.length - 1]).toBe(4);
  });

  it('builds the Watchman’s Resolve when he is STRUCK, with no ally in reach', () => {
    // ═══════════════════════════════════════════════════════════════════════
    // HALF A CLASS'S BUTTONS, GREYED OUT FOREVER.
    // ═══════════════════════════════════════════════════════════════════════
    //
    // engine/talents.ts documented "the scheduler calls `gainResolveOnStruck`
    // from the same place it applies damage to a player" — and the function did
    // not exist. His only income was `RESOLVE_PER_ADJACENT_ALLY`, so a solo
    // Watchman traced 0,0,0,… forever and Iron Curtain (25) and Lockdown (30)
    // were never affordable. It is close to true in the intended party too: the
    // Inspector's `minRange 3` puts her two tiles from the tank, not adjacent.
    //
    // NOBODY ELSE IS ON THIS FLOOR, on purpose — this asserts the half that was
    // missing, not the half that already worked.
    const table = bench('resolve-struck', WATCHMAN, { maxHp: 500, atk: 60 });
    table.player.maxHp = 100_000;
    table.player.hp = 100_000;

    const trace: number[] = [];
    for (let turn = 0; turn < 6; turn += 1) {
      expect(table.engine.hold('p1').ok).toBe(true);
      table.engine.pump();
      trace.push(table.sheet.resource.value);
    }

    // Monotonic and non-zero: the husk lands most swings and each landed one
    // pays `RESOLVE_ON_STRUCK`.
    expect(trace[0]).toBeGreaterThan(0);
    expect(trace[trace.length - 1]).toBeGreaterThanOrEqual(RESOLVE_ON_STRUCK * 4);
    // The two buttons that were unreachable are reachable.
    expect(Math.max(...trace)).toBeGreaterThanOrEqual(30);
  });

  it('does not pay Resolve for a MISS, or for being healed', () => {
    // A miss is not absorption and a bandage is not a blow. `noteBlows` gates on
    // `hit && damage > 0`, which covers both — and the heal case matters because
    // `TalentHit` reports one as a blow with `damage: 0`, so an un-gated hook
    // would hand a Watchman a free 6 every time the Alchemist patched him up.
    const table = bench('resolve-miss', WATCHMAN, { maxHp: 500 });
    const husk = table.world.getActor('m_husk');
    if (husk === undefined) throw new Error('fixture: the husk is missing');
    // Accuracy so low it cannot land: `hitChance` floors at 5%, so this is
    // asserted over the OUTCOME rather than by counting turns.
    husk.combat = { mods: { atk: -10_000 } };
    table.player.combat = { ...WATCHMAN.combat, mods: { def: 10_000 } };
    table.player.maxHp = 100_000;
    table.player.hp = 100_000;

    const before = table.player.hp;
    // ═══ THE TURN COUNT IS PINNED, BECAUSE THE FLOOR IS TIME-BASED ═══
    // Every base turn now pays an unconditional `RESOLVE_PER_TURN`, so the
    // expected figure is a function of HOW MANY BASE TURNS RAN and cannot be
    // left implicit. `TURNS` pumps carry `TURNS + 1` base passes: the first pump
    // carries two, one of them before the actor has ever acted (the Focus test
    // above burns that pass rather than measuring it; this one accounts for it
    // instead, because the trickle is why it can no longer be ignored).
    const TURNS = 8;
    const blowLanded: boolean[] = [];
    let previous = table.player.hp;
    for (let turn = 0; turn < TURNS; turn += 1) {
      expect(table.engine.hold('p1').ok).toBe(true);
      table.engine.pump();
      blowLanded.push(table.player.hp < previous);
      previous = table.player.hp;
    }

    // ═══ THE OLD IDENTITY IS DEAD AND THIS IS ITS REPLACEMENT ═══
    // This used to assert `value % RESOLVE_ON_STRUCK === 0`, which is a true
    // statement only while every income is a multiple of 6. A fractional
    // trickle kills it outright — 5.4 % 6 is 5.4 — so the claim is re-expressed
    // as the two BOUNDS it was really making: at least one `RESOLVE_ON_STRUCK`
    // per blow that removed hp, and nothing at all for the swings that missed.
    const struck = before - table.player.hp;
    const blows = blowLanded.filter(Boolean).length;
    const trickle = RESOLVE_PER_TURN * (TURNS + 1);
    expect(table.sheet.resource.value).toBeGreaterThanOrEqual(RESOLVE_ON_STRUCK * blows);
    if (struck === 0) {
      expect(blows).toBe(0);
      // Nothing landed, so the pool holds the floor and NOT ONE POINT MORE.
      expect(table.sheet.resource.value).toBeCloseTo(trickle, 6);
    }
    // …and the ceiling that gives this teeth either way: an un-gated hook would
    // pay 6 for every SWING, landed or not, which is `RESOLVE_ON_STRUCK * TURNS`
    // above the floor. A heal reported as a blow with `damage: 0` would land in
    // the same place.
    expect(table.sheet.resource.value).toBeLessThan(RESOLVE_ON_STRUCK * TURNS + trickle);
  });
});
