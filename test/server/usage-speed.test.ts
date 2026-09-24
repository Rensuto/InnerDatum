// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// The rule being guarded is ToME's: the talent tooltip's `Usage Speed:` line
// (t-engine4 game/modules/tome/class/Actor.lua:6276-6294) reads `no_energy` for
// "Instant", and otherwise `getTalentSpeedType` and `getTalentSpeed` for the body
// that owns the talent (:5798-5830).
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" — https://te4.org/license

import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';

import Fastify from 'fastify';

import { attachClassFor } from '../helpers/attach-class.ts';

import {
  INSPECTOR,
  WATCHMAN,
  classById,
  createContentTalentEngine,
  createTalentBook,
  sheetForClass,
} from '../../src/server/content/classes.ts';
import { BIRTH_INSCRIPTIONS } from '../../src/server/content/inscriptions.ts';
import { resolveItem } from '../../src/server/content/resolve.ts';
import { UNFILED } from '../../src/server/content/origins.ts';
import { recomposeCombat } from '../../src/server/engine/effects.ts';
import { maxLifeOf } from '../../src/server/engine/pools.ts';
import { talentSpeed, usageSpeedOf } from '../../src/server/engine/talents.ts';
import { wsGateway } from '../../src/server/net/gateway.ts';
import { ashwickFlare } from '../../src/server/talents/ashwick_flare.ts';
import { crudeBlow } from '../../src/server/talents/crude_blow.ts';
import { MONSTER_TALENTS } from '../../src/server/talents/monster.ts';
import { healingInfusion } from '../../src/server/talents/healing_infusion.ts';
import { phaseDoorRune } from '../../src/server/talents/phase_door_rune.ts';
import { pistolWhip } from '../../src/server/talents/pistol_whip.ts';
import { strikeOut } from '../../src/server/talents/strike_out.ts';
import { createTurnEngine } from '../../src/server/turn-engine.ts';
import { projectLoadout } from '../../src/server/view/projector.ts';
import { createWorld } from '../../src/server/world/world.ts';
import { PLAYER_RANK } from '../../src/shared/leveling.ts';
import { ActorKind, TileCode } from '../../src/shared/protocol.ts';
import { usageSpeedText } from '../../src/shared/usage-speed.ts';
import { PROTOCOL_VERSION } from '../../src/shared/version.ts';
import type { ClassDef } from '../../src/server/content/classes.ts';
import type { Item } from '../../src/server/content/items.ts';
import type { CombatSheet } from '../../src/server/engine/combat.ts';
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
 * "USAGE SPEED" REPLACED THE AP PRICE, AND IT IS READ OFF THE BODY.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Every talent carried an action-point price until protocol v32, and every
 * surface printed it — long after Slice C retired the budget and every action
 * began ending the turn. The line that replaced it says what a press costs in
 * the one currency the engine charges, in ToME's words.
 *
 * TWO WAYS TO GET IT WRONG, one case each, both through the REAL projection
 * (`loadoutOf` -> `projectLoadout` -> `usageSpeedText`) rather than a fixture:
 *
 *   1. read "instant" off a price of zero. Phase Door Rune was priced `ap: 0`
 *      and costs the turn upstream (it is not `no_energy`); the healing infusion
 *      is `no_energy`. A line derived from the price calls both instant.
 *   2. read the talent and not the body. A weapon-speed talent costs what the
 *      weapon in THIS hand costs; a line computed against a bare sheet says
 *      100% while the scheduler charges 80%.
 */

/** A body of `definition` with the Unfiled's rune and the birth infusions, on a sheet. */
function scene(name: string, definition: ClassDef, combat: CombatSheet = definition.combat) {
  const world = createWorld(name);
  world.level.tiles.fill(TileCode.FLOOR);
  const talents = createContentTalentEngine();
  const book = createTalentBook(talents, world);
  const body = world.addPlayer('p1', 'Detective', {
    maxHp: 900,
    combat,
    classId: definition.id,
  });
  body.x = 10;
  body.y = 10;
  // THE UNFILED CARRY THE PHASE DOOR RUNE (origins.ts), and every body is born
  // with the healing infusion (`BIRTH_INSCRIPTIONS`, human.lua:55) — so one
  // sheet holds both halves of the first case.
  talents.attach('p1', sheetForClass(definition, [], [], BIRTH_INSCRIPTIONS, UNFILED));
  return { body, book };
}

/** The sentence the client prints for `id`, off the wire the projector builds. */
function lineFor(wire: readonly LoadoutTalent[], id: string): string {
  const talent = wire.find((entry) => entry.id === id);
  if (talent === undefined) throw new Error(`${id} is not on the projected loadout`);
  return usageSpeedText(talent.usage);
}

describe('the Usage Speed line, through the real projection', () => {
  it('Phase Door Rune reads "Spell (100% of a turn)" and the healing infusion reads "Instant (0% of a turn)"', () => {
    // ═══ THE PRECONDITIONS, STATED ═══ The two differ in `noEnergy` and in
    // nothing a price could say: neither takes anything from the pool.
    expect(phaseDoorRune.noEnergy, 'the rune became no_energy').toBeUndefined();
    expect(healingInfusion.noEnergy).toBe(true);
    expect(phaseDoorRune.cost?.resource ?? 0).toBe(0);
    expect(healingInfusion.cost?.resource ?? 0).toBe(0);

    const { body, book } = scene('usage-inscriptions', WATCHMAN);
    const wire = projectLoadout(body, book.loadoutOf(body)).talents;
    // `is_spell` (inscriptions.lua:1318) is the word; the turn is the price.
    expect(lineFor(wire, phaseDoorRune.id)).toBe('Spell (100% of a turn)');
    expect(lineFor(wire, healingInfusion.id)).toBe('Instant (0% of a turn)');
  });

  it('a weapon-speed talent reads the weapon in this hand: "Weapon (80% of a turn)" at physSpeed 0.8', () => {
    const quick: CombatSheet = {
      ...WATCHMAN.combat,
      weapon: { ...WATCHMAN.combat.weapon, physSpeed: 0.8 },
    };
    // THE CONTROL: the class's own weapon, at upstream's default speed of one.
    const plain = scene('usage-weapon-plain', WATCHMAN);
    const plainWire = projectLoadout(plain.body, plain.book.loadoutOf(plain.body)).talents;
    expect(lineFor(plainWire, crudeBlow.id)).toBe('Weapon (100% of a turn)');

    const fast = scene('usage-weapon-fast', WATCHMAN, quick);
    const fastWire = projectLoadout(fast.body, fast.book.loadoutOf(fast.body)).talents;
    expect(lineFor(fastWire, crudeBlow.id)).toBe('Weapon (80% of a turn)');
    // THE LINE AND THE CHARGE ARE ONE ANSWER: what the scheduler will take for
    // the same swing from the same body (`TalentResolution.talentSpeed`).
    expect(talentSpeed(fast.body, crudeBlow)).toBeCloseTo(0.8, 10);
    // …and a talent that is NOT weapon-speed does not follow the hand.
    expect(lineFor(fastWire, phaseDoorRune.id)).toBe('Spell (100% of a turn)');
  });
});

describe('the word is the upstream category’s — is_spell, is_mind, a technique', () => {
  /**
   * `getTalentSpeedType` (tome/class/Actor.lua:5798-5814) names a talent's
   * speed from its category when the talent does not: Spell, Mind, Weapon or
   * Archery before Standard. There are no category flags here, so every port
   * writes its word as `Talent.speed`.
   *
   * THE RATCHET: these are the ONLY player talents that cost a turn and read
   * Standard, each for a reason. A new talent that costs a turn and names no
   * speed fails here until it says which of the two it is.
   */
  const STANDARD_ON_PURPOSE: Readonly<Record<string, string>> = {
    // inscriptions/infusions is `is_nature`, which names no speed (misc.lua:23).
    'talent:regeneration_infusion': 'nature, not a speed word',
    // cunning/dirty carries no flag (cunning/cunning.lua:27).
    'talent:overreach': 'cunning/dirty',
    // Ports of `no_energy` talents that still cost a turn here — labelled on each.
    'talent:moving_target': 'Evasion, no_energy upstream',
    'talent:downhill': 'Tumble, no_energy upstream',
    'talent:shake_it_off': 'Adrenaline Surge, no_energy upstream',
  };

  it('names every turn-costing talent’s word, or says why it is Standard', () => {
    // A MONSTER'S talents never print a usage line; a player's do.
    const monsters = new Set(MONSTER_TALENTS.map((t) => t.id));
    const standard = createContentTalentEngine()
      .registry.all()
      .filter(
        (t) =>
          !monsters.has(t.id) &&
          t.kind !== 'passive' &&
          t.noEnergy !== true &&
          t.sustain === undefined &&
          t.speed === undefined,
      )
      .map((t) => t.id)
      .sort();
    expect(standard).toEqual(Object.keys(STANDARD_ON_PURPOSE).sort());
  });

  it('a fire port reads Spell and a gloom port reads Mind', () => {
    expect(usageSpeedText(usageSpeedOf({}, ashwickFlare))).toBe('Spell (100% of a turn)');
    expect(usageSpeedText(usageSpeedOf({}, strikeOut))).toBe('Mind (100% of a turn)');
  });
});

describe('the sentence itself', () => {
  it('capitalises the speed type and truncates the percentage, as `%d` does', () => {
    expect(usageSpeedText({ type: 'archery', speed: 1 })).toBe('Archery (100% of a turn)');
    expect(usageSpeedText({ type: 'movement', speed: 2 })).toBe('Movement (200% of a turn)');
    // `("%d"):format(55.5)` is "55": Lua casts, it does not round.
    expect(usageSpeedText({ type: 'special', speed: 0.555 })).toBe('Special (55% of a turn)');
  });

  it('says Instant at 0%, whatever fraction arrives beside it', () => {
    // Upstream's `no_energy` branch is a fixed string; the fraction is not read.
    expect(usageSpeedText({ type: 'instant', speed: 0 })).toBe('Instant (0% of a turn)');
    expect(usageSpeedText({ type: 'instant', speed: 1 })).toBe('Instant (0% of a turn)');
  });
});

// ===========================================================================
// THE RESEND: a weapon swap re-sends the line, over a real socket
// ===========================================================================

/** Snowflake-SHAPED, and nobody's real id. */
const REN_ID = '333333333333333333';
const FRAME_TIMEOUT_MS = 2_000;
const MAUL = 'item_bailiffs_maul';
/** No authored weapon has a speed but 1, so the harness's catalogue makes one. */
const QUICK_PHYS_SPEED = 0.8;

type Frame = Record<string, unknown>;

type Client = {
  send(frame: Frame): void;
  hello(sessionId: string): Promise<Frame | undefined>;
  settle(): Promise<void>;
  all(type: string): Frame[];
  last(type: string): Frame | undefined;
  clear(): void;
  close(): void;
};

const openClients: Client[] = [];

/** The gateway-inventory.test.ts client, as loadout-gun-gate.test.ts cut it. */
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
      // `ping` is answered synchronously and without pumping, and the socket
      // delivers in order: once `pong` is here, so is everything before it.
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

/**
 * THE MAUL, AT 80% — the real item, with its weapon's speed changed and nothing
 * else. The gateway validates the equip against the real catalogue (the maul is
 * a mainhand); `refreshBody` folds what the hand holds through this one, which
 * is main.ts's seam with the catalogue swapped.
 */
function quickCatalogue(id: string): Item | undefined {
  const item = resolveItem(id);
  if (id !== MAUL || item?.combat === undefined) return item;
  return { ...item, combat: { ...item.combat, physSpeed: QUICK_PHYS_SPEED } };
}

type Harness = { readonly port: number; readonly world: World; close(): Promise<void> };

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
      recomposeCombat(actor, null, quickCatalogue);
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

function talentsOf(frame: Frame | undefined): LoadoutTalent[] {
  const talents = frame?.['talents'];
  return Array.isArray(talents) ? (talents as LoadoutTalent[]) : [];
}

describe('the loadout is re-sent when the hand changes the line', () => {
  it('a weapon swap moves a weapon-speed talent to "Weapon (80% of a turn)", and back', async () => {
    const harness = await boot('usage-socket', { hp: null, cooldowns: {}, classId: INSPECTOR.id });
    server = harness;
    const ren = await connect(harness.port);
    const welcome = await ren.hello('ren-handle');
    await ren.settle();
    const body = harness.world.getActor(String(welcome?.['selfId']));
    if (body?.kind !== ActorKind.Player) throw new Error('test fixture: no player body');
    const player: PlayerActor = body;

    // ═══ THE SETUP ═══ Pistol Whip is a weapon-speed talent on her bar, and at
    // join her hand is empty and her own weapon is at upstream's default.
    expect(pistolWhip.speed).toBe('weapon');
    expect(player.equipped?.mainhand).toBeUndefined();
    expect(lineFor(talentsOf(ren.last('loadout')), pistolWhip.id)).toBe('Weapon (100% of a turn)');

    // ═══ THE QUICK MAUL GOES ON ═══
    player.carried = [...(player.carried ?? []), MAUL];
    ren.clear();
    ren.send({ t: 'equip', itemId: MAUL });
    await ren.settle();
    expect(ren.last('error'), 'the equip was refused').toBeUndefined();
    expect(player.equipped?.mainhand).toBe(MAUL);
    const armed = ren.all('loadout');
    expect(armed, 'no loadout followed the swap — the line stays at 100%').toHaveLength(1);
    expect(lineFor(talentsOf(armed[0]), pistolWhip.id)).toBe('Weapon (80% of a turn)');
    // A talent that does not read the hand stays put.
    expect(lineFor(talentsOf(armed[0]), healingInfusion.id)).toBe('Instant (0% of a turn)');

    // ═══ AND IT COMES OFF ═══
    ren.clear();
    ren.send({ t: 'unequip', slot: 'mainhand' });
    await ren.settle();
    const bare = ren.all('loadout');
    expect(bare, 'no loadout followed the empty hand').toHaveLength(1);
    expect(lineFor(talentsOf(bare[0]), pistolWhip.id)).toBe('Weapon (100% of a turn)');
  });
});
