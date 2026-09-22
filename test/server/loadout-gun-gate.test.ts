// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// The rule being guarded is ToME's: a talent whose `preUseTalent(t, true, true)`
// fails is greyed on the hotbar (engine/HotkeysIconsDisplay.lua:182, :194) and
// in the talents list (tome/dialogs/UseTalents.lua:38, :302), and that call
// reaches `on_pre_use` (tome/class/Actor.lua:5547) — `archerPreUse`
// (techniques/archery.lua:46-50) for every archery talent.
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" — https://te4.org/license

import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';

import Fastify from 'fastify';

import { attachClassFor } from '../helpers/attach-class.ts';

import {
  INSPECTOR,
  classById,
  createContentTalentEngine,
  createTalentBook,
  loadoutViewFor,
  sheetForClass,
} from '../../src/server/content/classes.ts';
import { createMvpEffectState } from '../../src/server/content/effects.ts';
import { Slot, itemById } from '../../src/server/content/items.ts';
import { resolveItem } from '../../src/server/content/resolve.ts';
import { AiProfile } from '../../src/server/engine/actor.ts';
import { recomposeCombat } from '../../src/server/engine/effects.ts';
import { maxLifeOf } from '../../src/server/engine/pools.ts';
import { NO_SHOOTER_REASON } from '../../src/server/engine/talents.ts';
import { wsGateway } from '../../src/server/net/gateway.ts';
import { createTurnEngine } from '../../src/server/turn-engine.ts';
import { projectLoadout } from '../../src/server/view/projector.ts';
import { createWorld } from '../../src/server/world/world.ts';
import { PLAYER_RANK } from '../../src/shared/leveling.ts';
import { ActorKind, TileCode } from '../../src/shared/protocol.ts';
import { PROTOCOL_VERSION } from '../../src/shared/version.ts';
import type { PlayerActor } from '../../src/server/engine/actor.ts';
import type {
  CharacterRestore,
  IdentityPort,
  PersistPort,
  TurnEngine,
} from '../../src/server/net/gateway.ts';
import type { World } from '../../src/server/world/world.ts';
import type { LoadoutTalent } from '../../src/shared/protocol.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A GUN BUTTON WITH NO GUN IN THE HAND LOOKS LIKE ONE — `LoadoutTalent.unusable`.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `archerPreUse` refuses an Inspector's gun talents while a melee weapon is in
 * her hand (archer-pre-use.test.ts drives the refusal). Upstream also GREYS
 * them, from the same call; ours could not, because nothing on the wire said
 * so — all six buttons stayed lit with a maul held and every press came back
 * refused. Three joins stand between the rule and a grey button, and each has
 * its own test here:
 *
 *   1. `toLoadoutView` asks the rule of the COMPOSED sheet (content/classes.ts).
 *   2. `toLoadoutTalent` copies it onto the wire (view/projector.ts), the
 *      function that has dropped five optional fields before this one.
 *   3. The gateway RESENDS the loadout when the hand changes (`gateKeyFor`),
 *      because a frame computed right and sent only at `hello` is still a lit
 *      button after the maul goes on.
 *
 * The client half — `affordable` and the tip — is test/client/hotbar-unusable
 * .test.ts.
 */

const MAUL = 'item_bailiffs_maul';

/** The Inspector's talents that fire her gun — derived from the flag, not listed. */
const GUN_TALENTS: readonly string[] = INSPECTOR.loadout
  .filter((talent) => talent.archery === true)
  .map((talent) => talent.id);

/** Two of hers that do NOT — a fist and a step — the control for "all of them". */
const NOT_GUNS: readonly string[] = ['talent:pistol_whip', 'talent:fog_step'];

/** The talents on a frame that say a press will be refused, by id. */
function greyed(talents: readonly LoadoutTalent[]): string[] {
  return talents.filter((talent) => talent.unusable !== undefined).map((talent) => talent.id);
}

describe('the setup this file stands on', () => {
  it('has six gun talents, a maul that is a mainhand, and two controls in the loadout', () => {
    // SIX, because that is the number the gap was reported at and the number
    // `archer-pre-use.test.ts` derives from the class sheet. If it moves, the
    // assertions below still hold — but this line says so first.
    expect(GUN_TALENTS).toHaveLength(6);
    expect(GUN_TALENTS).toContain('talent:revolver_shot');
    expect(itemById(MAUL)?.slot, `${MAUL} is not a mainhand weapon any more`).toBe(Slot.Mainhand);
    expect(itemById(MAUL)?.combat?.archery, 'the maul is a gun now').not.toBe(true);
    const ids = INSPECTOR.loadout.map((talent) => talent.id);
    for (const id of NOT_GUNS) expect(ids, `${id} left the Inspector`).toContain(id);
    for (const id of NOT_GUNS) expect(GUN_TALENTS).not.toContain(id);
  });
});

// ===========================================================================
// 1 + 2. THE VIEW ASKS THE RULE, AND THE PROJECTOR KEEPS THE ANSWER
// ===========================================================================

function inspectorBody(name: string) {
  const world = createWorld(name);
  world.level.tiles.fill(TileCode.FLOOR);
  const effects = createMvpEffectState();
  const talents = createContentTalentEngine();
  const book = createTalentBook(talents, world);
  const body = world.addPlayer('p1', 'Detective', {
    maxHp: 900,
    combat: INSPECTOR.combat,
    classId: INSPECTOR.id,
  });
  body.x = 10;
  body.y = 10;
  talents.attach('p1', sheetForClass(INSPECTOR));
  // THE PRODUCTION FOLD — `recomposeCombat` is what writes the mainhand into
  // `body.combat`, and `body.combat` is the sheet the rule reads.
  const hold = (item: string | undefined): void => {
    body.equipped = item === undefined ? {} : { [Slot.Mainhand]: item };
    recomposeCombat(body, effects, resolveItem);
  };
  hold(undefined);
  return { world, book, body, hold };
}

describe('the loadout says which buttons the hand cannot press', () => {
  it('greys nothing while her hand is empty and the revolver is hers', () => {
    const scene = inspectorBody('gun-gate-bare');
    // THE PRECONDITION, stated: the composed weapon is the class's gun.
    expect(scene.body.combat?.weapon?.archery).toBe(true);
    const loadout = scene.book.loadoutOf(scene.body);
    for (const id of GUN_TALENTS) {
      expect(
        loadout.map((talent) => talent.id),
        `${id} is not on the hotbar`,
      ).toContain(id);
    }
    expect(greyed(loadout), 'a gun talent was greyed with the gun in hand').toEqual([]);
  });

  it('greys exactly the six gun talents while a maul is held, with the refusal’s words', () => {
    const scene = inspectorBody('gun-gate-maul');
    scene.hold(MAUL);
    // THE PRECONDITION: the maul really is in the hand and really replaced the gun.
    expect(scene.body.equipped?.mainhand).toBe(MAUL);
    expect(scene.body.combat?.weapon?.archery).not.toBe(true);

    const loadout = scene.book.loadoutOf(scene.body);
    expect(greyed(loadout).sort()).toEqual([...GUN_TALENTS].sort());
    for (const talent of loadout) {
      if (talent.unusable === undefined) continue;
      expect(talent.unusable).toBe(NO_SHOOTER_REASON);
    }
    // THE CONTROLS. A fist and a step do not need a gun, and a rule written as
    // "maul held => grey the class" would grey these too.
    for (const id of NOT_GUNS) {
      const talent = loadout.find((entry) => entry.id === id);
      expect(talent, `${id} is not on the hotbar`).toBeDefined();
      expect(talent?.unusable, `${id} was greyed by the maul`).toBeUndefined();
    }

    // …AND IT SURVIVES THE PROJECTOR, the hand-written copy that dropped five
    // optional fields before this one. projector.test.ts pins the key set on a
    // fixture; this is the real view going through it.
    const wire = projectLoadout(scene.body, loadout).talents;
    expect(greyed(wire).sort()).toEqual([...GUN_TALENTS].sort());
  });

  it('greys a button exactly when the press is refused for the gun — one rule, read twice', () => {
    // THE GREY AND THE REFUSAL, SIDE BY SIDE, for the one gun talent a
    // level-1 Inspector has learned. Both come off the same book, the same
    // body and the same hand, so if either stopped asking `archerPreUse` the
    // two would part company here.
    const scene = inspectorBody('gun-gate-agree');
    scene.world.addMonster('foe', {
      name: 'Index Husk',
      sprite: 'enemy_index_husk_s',
      x: 14,
      y: 10,
      profile: AiProfile.MeleeChaser,
      maxHp: 9999,
    });
    const shot = 'talent:revolver_shot';
    const at = { x: 14, y: 10 };
    const unusable = (): string | undefined =>
      scene.book.loadoutOf(scene.body).find((talent) => talent.id === shot)?.unusable;

    // THE CONTROL: the same tile, the gun in hand, is legal — so the refusal
    // below is the hand and not the aim.
    expect(scene.book.check(scene.body, shot, at), 'the shot is illegal with the gun').toBeNull();
    expect(unusable()).toBeUndefined();

    scene.hold(MAUL);
    expect(scene.book.check(scene.body, shot, at)).toBe('refused');
    expect(unusable()).toBe(NO_SHOOTER_REASON);

    scene.hold(undefined);
    expect(scene.book.check(scene.body, shot, at)).toBeNull();
    expect(unusable()).toBeUndefined();
  });

  it('says nothing on the class picker’s preview, which is the class as authored', () => {
    // `loadoutViewFor` hands `toLoadoutView` the class's own sheet — whose
    // weapon is her revolver — so a card showing the class to somebody who has
    // not chosen yet can never draw a greyed gun. Asserted because the clause
    // reads `self`, and the preview's `self` is a stand-in: a stand-in built
    // with no weapon would grey all six on the picker.
    const preview = loadoutViewFor(INSPECTOR);
    for (const id of GUN_TALENTS) {
      expect(
        preview.map((talent) => talent.id),
        `${id} is not on the card`,
      ).toContain(id);
    }
    expect(greyed(preview), 'the picker greyed a gun the class is holding').toEqual([]);
  });
});

// ===========================================================================
// 3. THE RESEND, OVER A REAL SOCKET
// ===========================================================================

/** Snowflake-SHAPED, and nobody's real id. */
const REN_ID = '333333333333333333';

const FRAME_TIMEOUT_MS = 2_000;

type Frame = Record<string, unknown>;

type Client = {
  send(frame: Frame): void;
  hello(sessionId: string): Promise<Frame | undefined>;
  /** The ordering barrier — see gateway-inventory.test.ts, whose harness this is. */
  settle(): Promise<void>;
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

  const waitFor = async (type: string): Promise<Frame | undefined> => {
    const deadline = Date.now() + FRAME_TIMEOUT_MS;
    for (;;) {
      const hit = frames.find((frame) => frame['t'] === type);
      if (hit !== undefined) return hit;
      if (Date.now() >= deadline) return undefined;
      await sleep(10);
    }
  };

  const client: Client = {
    send(frame: Frame): void {
      socket.send(JSON.stringify({ v: PROTOCOL_VERSION, ...frame }));
    },
    async hello(sessionId: string) {
      client.send({ t: 'hello', sessionId });
      return await waitFor('welcome');
    },
    async settle() {
      // The gateway answers `ping` synchronously and without pumping, and the
      // socket delivers in order: once `pong` is here, everything the previous
      // send produced is here too — so "no frame arrived" is a claim, not a race.
      client.send({ t: 'ping' });
      const pong = await waitFor('pong');
      if (pong === undefined) throw new Error('the server never answered the ordering ping');
      frames = frames.filter((frame) => frame['t'] !== 'pong');
    },
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

function identityPort(): IdentityPort {
  return {
    get: (id: string | undefined) =>
      id === 'ren-handle' ? { user: { id: REN_ID }, displayName: 'Ren' } : undefined,
  };
}

type Harness = {
  readonly port: number;
  readonly world: World;
  close(): Promise<void>;
};

/**
 * The real gateway over the real engine and the real talent book — the
 * gateway-inventory.test.ts harness cut to what an equip needs. `refreshBody`
 * is main.ts's seam, copied the way that file copies it: it is what folds the
 * new mainhand into `combat`, which is the sheet the loadout is computed from.
 */
async function boot(seed: string, restore: CharacterRestore): Promise<Harness> {
  const app = Fastify({ logger: false });
  const world = createWorld(seed);
  world.level.tiles.fill(TileCode.FLOOR);
  const talents = createContentTalentEngine();
  const base = createTurnEngine({
    world,
    now: () => 0,
    talents: createTalentBook(talents, world),
  });
  const engine: TurnEngine = {
    ...base,
    attachClass: attachClassFor(talents, world),
    refreshBody: (actorId: string): void => {
      const actor = world.getActor(actorId);
      if (actor === undefined) return;
      recomposeCombat(actor, null, resolveItem);
      if (actor.kind !== ActorKind.Player || actor.classId === undefined) return;
      const definition = classById(actor.classId);
      if (definition === undefined) return;
      actor.maxHp = maxLifeOf(actor, definition, PLAYER_RANK);
      actor.hp = Math.min(actor.hp, actor.maxHp);
    },
  };
  const persist: PersistPort = {
    savePlayers: () => undefined,
    savePlayersNow: () => undefined,
    openCharacter: () => Promise.resolve(restore),
  };
  await app.register(wsGateway, {
    world,
    engine,
    sessions: identityPort(),
    persist,
    disconnectGraceMs: 30_000,
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (address === null || typeof address === 'string') throw new Error('no port was bound');
  return {
    port: address.port,
    world,
    close: async (): Promise<void> => {
      await app.close();
    },
  };
}

let server: Harness | undefined;

afterEach(async () => {
  for (const client of openClients) client.close();
  openClients.length = 0;
  await server?.close();
  server = undefined;
});

function bodyOf(harness: Harness, welcome: Frame | undefined): PlayerActor {
  const id = String(welcome?.['selfId']);
  const actor = harness.world.getActor(id);
  if (actor === undefined) throw new Error(`test fixture: no actor for ${id}`);
  if (actor.kind !== ActorKind.Player) throw new Error(`test fixture: ${id} is not a player`);
  return actor;
}

/** The talents on a `loadout` frame. */
function talentsOf(frame: Frame | undefined): LoadoutTalent[] {
  const talents = frame?.['talents'];
  return Array.isArray(talents) ? (talents as LoadoutTalent[]) : [];
}

/** An Inspector on file, logged in, with every join frame already in hand. */
async function inspectorOnline(seed: string): Promise<{ ren: Client; body: PlayerActor }> {
  const harness = await boot(seed, { hp: null, cooldowns: {}, classId: INSPECTOR.id });
  server = harness;
  const ren = await connect(harness.port);
  const body = bodyOf(harness, await ren.hello('ren-handle'));
  await ren.settle();
  return { ren, body };
}

describe('the loadout is re-sent when the weapon hand changes', () => {
  it('greys the gun talents the moment a maul goes on, and lights them when it comes off', async () => {
    const { ren, body } = await inspectorOnline('gun-gate-socket');

    // ═══ THE SETUP, ASSERTED BEFORE THE CLAIM ═══
    // She is an Inspector, her hand is empty, and the frame `hello` sent her
    // greys nothing. Without these the "it arrived greyed" below could be a
    // frame that was greyed all along.
    expect(body.classId).toBe(INSPECTOR.id);
    expect(body.equipped?.mainhand, 'the Inspector was born holding something').toBeUndefined();
    const joined = ren.last('loadout');
    expect(joined, 'hello sent no loadout').toBeDefined();
    for (const id of GUN_TALENTS) {
      expect(talentsOf(joined).map((talent) => talent.id)).toContain(id);
    }
    expect(greyed(talentsOf(joined)), 'greyed at join with an empty hand').toEqual([]);

    // ═══ THE MAUL GOES ON ═══
    // Its level and attributes are recorded first: the key also moves on
    // those, and a maul that ever gains a stat bonus would resend the loadout
    // through THEM, passing this with the hand term deleted.
    const level = body.level;
    const stats = JSON.stringify(body.combat?.stats);
    body.carried = [...(body.carried ?? []), MAUL];
    ren.clear();
    ren.send({ t: 'equip', itemId: MAUL });
    await ren.settle();

    expect(ren.last('error'), 'the equip was refused').toBeUndefined();
    expect(body.equipped?.mainhand, 'the maul is not in her hand').toBe(MAUL);
    expect(body.level, 'the maul moved her level').toBe(level);
    expect(JSON.stringify(body.combat?.stats), 'the maul moved an attribute').toBe(stats);
    // ONE frame, not zero and not two: the equip's own pump walked
    // `refreshViewers`, and the key moved exactly once.
    const armed = ren.all('loadout');
    expect(armed, 'no loadout followed the maul — the buttons stay lit').toHaveLength(1);
    expect(greyed(talentsOf(armed[0])).sort()).toEqual([...GUN_TALENTS].sort());
    for (const talent of talentsOf(armed[0])) {
      if (talent.unusable !== undefined) expect(talent.unusable).toBe(NO_SHOOTER_REASON);
    }
    for (const id of NOT_GUNS) {
      const talent = talentsOf(armed[0]).find((entry) => entry.id === id);
      expect(talent?.unusable, `${id} was greyed by the maul`).toBeUndefined();
    }

    // ═══ AND IT COMES OFF ═══
    ren.clear();
    ren.send({ t: 'unequip', slot: 'mainhand' });
    await ren.settle();

    expect(ren.last('error'), 'the unequip was refused').toBeUndefined();
    expect(body.equipped?.mainhand, 'the maul is still in her hand').toBeUndefined();
    expect(body.carried).toContain(MAUL);
    const bare = ren.all('loadout');
    expect(bare, 'no loadout followed the empty hand — the buttons stay grey').toHaveLength(1);
    expect(greyed(talentsOf(bare[0])), 'still greyed with the gun back').toEqual([]);
  });

  it('does not resend for gear that leaves the hand alone', async () => {
    // THE CONTROL FOR "WHEN THE HAND CHANGES". A key that moved on every
    // equip would pass the test above and resend the largest viewer-private
    // frame there is for every hat. The cap moves armour and no attribute, so
    // nothing else in `gateKeyFor` can move either.
    const { ren, body } = await inspectorOnline('gun-gate-cap');
    const stats = JSON.stringify(body.combat?.stats);
    body.carried = [...(body.carried ?? []), 'item_watchmans_cap'];
    ren.clear();
    ren.send({ t: 'equip', itemId: 'item_watchmans_cap' });
    await ren.settle();

    expect(ren.last('error'), 'the cap was refused').toBeUndefined();
    expect(body.equipped?.head, 'the cap is not on').toBe('item_watchmans_cap');
    expect(JSON.stringify(body.combat?.stats), 'the cap moved an attribute').toBe(stats);
    expect(ren.all('loadout'), 'a hat resent the hotbar').toHaveLength(0);
  });
});
