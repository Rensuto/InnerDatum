// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported against t-engine4 game/modules/tome/data/timed_effects/other.lua:2899-2916 (EFF_ZONE_AURA_UNDERWATER)
//   and game/modules/tome/class/Game.lua:1322-1335, class/Actor.lua:7263-7267 (on at the door, off at the next)
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" — https://te4.org/license

import { existsSync, readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  EffectId,
  STUNNED,
  ZONE_AURAS,
  ZONE_AURA_UNDERWATER,
  createMvpEffectState,
  validateEffect,
} from '../../src/server/content/effects.ts';
import { INDEX_HUSK, monsterInit } from '../../src/server/content/monsters.ts';
import { resolveItem } from '../../src/server/content/resolve.ts';
import { createDownedState } from '../../src/server/engine/downed.ts';
import {
  ImmunityKey,
  applyZoneEffects,
  dispel,
  effectsOn,
  forgetActor,
  grantImmunity,
  hasEffect,
  recomposeCombat,
  removeEffect,
  setEffect,
  stripZoneEffects,
  timedEffects,
} from '../../src/server/engine/effects.ts';
import { createPartyState } from '../../src/server/engine/party.ts';
import { wsGateway } from '../../src/server/net/gateway.ts';
import {
  createCharacterFile,
  parseCharacterFile,
  serialiseCharacter,
} from '../../src/server/persist/saves.ts';
import { createTurnEngine } from '../../src/server/turn-engine.ts';
import { RealmKind, createRealms } from '../../src/server/world/realms.ts';
import { REDACTION_SITE_ID, canWalk, makeTestMap } from '../../src/shared/level.ts';
import { createRng } from '../../src/shared/rng.ts';
import { PROTOCOL_VERSION } from '../../src/shared/version.ts';
import type { EffectState, EquippedActor } from '../../src/server/engine/effects.ts';
import type { CombatSheet } from '../../src/server/engine/combat.ts';
import type { Realm, Realms, SiteDef } from '../../src/server/world/realms.ts';
import type { World } from '../../src/server/world/world.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A PLACE'S AURA: ON AT THE DOOR, ON EVERYTHING INSIDE, OFF AT THE NEXT DOOR.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Four things are pinned here, each where it can actually fail:
 *
 *   1. THE NUMBERS are upstream's, read off `other.lua` itself when the
 *      reference tree is present, and off a table beside it when it is not.
 *   2. THE RULE on one body — only auras, only the missing ones, and nothing
 *      but the strip takes one off.
 *   3. THE REALM lays them on its population and on a wipe's re-seed.
 *   4. THE DOOR, over a real socket: a player gains the place's auras walking
 *      in, loses them walking out, and the file never holds one.
 */

// ---------------------------------------------------------------------------
// 1. What each aura writes — timed_effects/other.lua
// ---------------------------------------------------------------------------

/** One aura's terms, normalised: lower-case damage types, immunities in percent. */
type Terms = {
  resists: Record<string, number>;
  increase: Record<string, number>;
  immunities: Record<string, number>;
};

type Row = {
  readonly lua: string;
  readonly desc: string;
  readonly terms: Terms;
  /** `attr` or `attr.TYPE` for a term the Lua writes and this port leaves out. */
  readonly unported: readonly string[];
};

function terms(partial: Partial<Terms>): Terms {
  return { resists: {}, increase: {}, immunities: {}, ...partial };
}

/**
 * THE TABLE, beside the Lua. Section 1b reads the Lua and demands they agree.
 * One row: the nine other portable auras wait for a map that names them (see
 * `ZONE_AURAS`).
 */
const ROWS: Readonly<Record<string, Row>> = {
  [EffectId.ZoneAuraUnderwater]: {
    lua: 'ZONE_AURA_UNDERWATER',
    desc: 'Underwater Zone',
    terms: terms({ increase: { cold: 10, fire: -10 }, immunities: { stun: -10 } }),
    unported: [],
  },
};

function body(sheet: CombatSheet, id = 'p1'): EquippedActor {
  return {
    id,
    name: 'Subject',
    kind: 'player',
    hp: 40,
    maxHp: 40,
    alive: true,
    cooldowns: new Map<string, number>(),
    combat: sheet,
    baseCombat: sheet,
  } as unknown as EquippedActor;
}

/** Some stun immunity to take ten points OFF, since a malus on zero is bounded to zero. */
const SHEET: CombatSheet = {
  stats: { str: 10, dex: 10, con: 10, mag: 10, wil: 10, cun: 10, lck: 50 },
  mods: { armour: 32, physResist: 6 },
  immunities: { stun: 55, confusion: 55 },
};

function laid(state: EffectState, actor: EquippedActor, ids: readonly string[]): readonly string[] {
  return applyZoneEffects(state, actor, ids, createRng('zone-auras'), {
    sheetDirty: () => {
      recomposeCombat(actor, state, resolveItem);
    },
  });
}

describe('each aura writes what other.lua writes', () => {
  it('ports the one a shipped map names, as upstream names it', () => {
    expect(ZONE_AURAS.map((def) => def.id)).toEqual(Object.keys(ROWS));
    for (const def of ZONE_AURAS) {
      expect(def.displayName, def.id).toBe(ROWS[def.id]?.desc);
      expect(def.zoneWide, def.id).toBe(true);
      expect(def.noRemove, def.id).toBe(true);
      expect(def.decrease, def.id).toBe(0);
      expect(def.typeOther, def.id).toBe(true);
      expect(validateEffect(def), def.id).toEqual([]);
    }
  });

  for (const def of ZONE_AURAS) {
    it(`${def.id} moves the sheet by exactly its terms, and nothing else`, () => {
      const row = ROWS[def.id];
      if (row === undefined) throw new Error(`no row for ${def.id}`);
      const state = createMvpEffectState();
      const actor = body(SHEET);
      recomposeCombat(actor, state, resolveItem);
      const before = actor.combat ?? {};

      expect(laid(state, actor, [def.id])).toEqual([def.id]);
      const after = actor.combat ?? {};

      const plus = (
        base: Readonly<Record<string, number>> | undefined,
        delta: Record<string, number>,
      ): Record<string, number> => {
        const out: Record<string, number> = { ...base };
        for (const [key, value] of Object.entries(delta)) out[key] = (out[key] ?? 0) + value;
        return out;
      };
      expect(after.profile?.resists ?? {}, 'resists').toEqual(
        plus(before.profile?.resists, row.terms.resists),
      );
      expect(after.increase ?? {}, 'inc_damage').toEqual(plus(before.increase, row.terms.increase));
      expect(after.immunities ?? {}, 'immunities').toEqual(
        plus(before.immunities, row.terms.immunities),
      );
      expect(after.mods ?? {}, 'mods').toEqual(before.mods ?? {});
    });
  }
});

describe('the table is the Lua (reads reference/, skipped without it)', () => {
  const url = new URL(
    '../../reference/t-engine4/game/modules/tome/data/timed_effects/other.lua',
    import.meta.url,
  );
  const present = existsSync(url);

  it.skipIf(!present)('agrees term for term with every ported newEffect block', () => {
    const lua = readFileSync(url, 'utf8');
    for (const [id, row] of Object.entries(ROWS)) {
      const start = lua.indexOf(`name = "${row.lua}"`);
      expect(start, `${row.lua} is not in other.lua`).toBeGreaterThan(0);
      const end = lua.indexOf('newEffect{', start);
      const block = lua.slice(start, end);

      expect(/desc = "([^"]+)"/.exec(block)?.[1], id).toBe(row.desc);
      expect(block, id).toContain('decrease = 0, no_remove = true');
      expect(block, id).toContain('zone_wide_effect = true');

      const found = terms({});
      const skipped: string[] = [];
      for (const m of block.matchAll(/effectTemporaryValue\(eff, "([a-z_]+)", (.+)\)\s*$/gm)) {
        const attr = m[1] ?? '';
        const value = m[2] ?? '';
        if (attr === 'resists' || attr === 'inc_damage') {
          for (const t of value.matchAll(/\[DamageType\.([A-Z]+)\]=(-?\d+)/g)) {
            const key = `${attr}.${t[1] ?? ''}`;
            if (row.unported.includes(key)) {
              skipped.push(key);
              continue;
            }
            const table = attr === 'resists' ? found.resists : found.increase;
            table[(t[1] ?? '').toLowerCase()] = Number(t[2]);
          }
          continue;
        }
        if (row.unported.includes(attr)) {
          skipped.push(attr);
          continue;
        }
        if (attr.endsWith('_immune')) {
          found.immunities[attr.slice(0, -'_immune'.length)] = Math.round(Number(value) * 100);
        } else {
          throw new Error(`${id}: a term this test cannot read: ${attr} = ${value}`);
        }
      }
      expect(found, id).toEqual(row.terms);
      // EVERY "NOT PORTED" IS REAL: a name here that the Lua does not write is a
      // note about a term that does not exist.
      expect([...skipped].sort(), id).toEqual([...row.unported].sort());
    }
  });
});

// ---------------------------------------------------------------------------
// 2. The rule on one body — Game.lua:1322-1335, ActorTemporaryEffects.lua:191
// ---------------------------------------------------------------------------

describe('laying and lifting auras on one body', () => {
  it('lays only zone-wide effects, whatever else the list names', () => {
    /**
     * A BUFF AND A BLEED, and not the stun this first named: the sheet carries
     * 55% stun immunity, so a stun set without the filter was usually refused
     * by `canBe` anyway and the filter's absence passed. Nothing on this sheet
     * resists either of these — a buff is never refused, and no wound, cut or
     * bleed immunity is worn — so only the filter keeps them off.
     */
    const state = createMvpEffectState();
    const actor = body(SHEET);
    expect(
      laid(state, actor, [EffectId.Evasive, EffectId.Bleeding, EffectId.ZoneAuraUnderwater]),
    ).toEqual([EffectId.ZoneAuraUnderwater]);
    expect(hasEffect(state, actor.id, EffectId.Evasive)).toBe(false);
    expect(hasEffect(state, actor.id, EffectId.Bleeding)).toBe(false);
  });

  it('lays only what is missing, and leaves the one already worn untouched', () => {
    const state = createMvpEffectState();
    const actor = body(SHEET);
    laid(state, actor, [EffectId.ZoneAuraUnderwater]);
    const worn = effectsOn(state, actor.id)[0];
    const cold = actor.combat?.increase?.cold;

    expect(laid(state, actor, [EffectId.ZoneAuraUnderwater])).toEqual([]);
    expect(effectsOn(state, actor.id)[0], 'the worn aura was set again').toBe(worn);
    expect(actor.combat?.increase?.cold).toBe(cold);
  });

  it('is "other": a blanket status immunity does not keep it off (tome/class/Actor.lua:6956)', () => {
    const state = createMvpEffectState();
    const actor = body(SHEET);
    grantImmunity(state, actor.id, ImmunityKey.AllNegative, 100);
    grantImmunity(state, actor.id, ImmunityKey.PhysicalNegative, 100);
    expect(laid(state, actor, [EffectId.ZoneAuraUnderwater])).toEqual([
      EffectId.ZoneAuraUnderwater,
    ]);
  });

  it('draws nothing from the stream it is handed', () => {
    const state = createMvpEffectState();
    const used = createRng('zone-auras-draws');
    const fresh = createRng('zone-auras-draws');
    applyZoneEffects(
      state,
      body(SHEET),
      ZONE_AURAS.map((def) => def.id),
      used,
    );
    expect(used.int('probe', 0, 1_000_000)).toBe(fresh.int('probe', 0, 1_000_000));
  });

  it('is taken off by nothing but the strip: no cure, no dispel, no clock', () => {
    const state = createMvpEffectState();
    const actor = body(SHEET);
    const rng = createRng('zone-auras-stay');
    laid(state, actor, [EffectId.ZoneAuraUnderwater]);

    expect(removeEffect(state, actor, EffectId.ZoneAuraUnderwater, rng)).toBe(false);
    expect(dispel(state, actor, () => true, rng)).toBe(0);
    for (let turn = 0; turn < 50; turn += 1) timedEffects(state, actor, rng);
    expect(hasEffect(state, actor.id, EffectId.ZoneAuraUnderwater)).toBe(true);
    expect(effectsOn(state, actor.id)[0]?.dur).toBe(1);
  });

  it('strips every aura and nothing else, and the sheet comes back', () => {
    const state = createMvpEffectState();
    const actor = body(SHEET);
    const rng = createRng('zone-auras-strip');
    recomposeCombat(actor, state, resolveItem);
    const bare = actor.combat;
    setEffect(state, actor, STUNNED.id, 3, {}, rng);
    laid(state, actor, [EffectId.ZoneAuraUnderwater]);

    expect(stripZoneEffects(state, actor, rng)).toEqual([EffectId.ZoneAuraUnderwater]);
    expect(effectsOn(state, actor.id).map((eff) => eff.effectId)).toEqual([STUNNED.id]);
    recomposeCombat(actor, state, resolveItem);
    expect(actor.combat?.mods).toEqual(bare?.mods);
    expect(actor.combat?.profile).toEqual(bare?.profile);
    expect(actor.combat?.increase).toEqual(bare?.increase);
    expect(actor.combat?.immunities).toEqual(bare?.immunities);
  });

  it('refuses a zone-wide effect that could tick down or be cured', () => {
    const tickable =
      'effect:zone_aura_underwater: a zone-wide effect must never tick down and must be noRemove';
    expect(validateEffect({ ...ZONE_AURA_UNDERWATER, noRemove: undefined })).toContain(tickable);
    expect(validateEffect({ ...ZONE_AURA_UNDERWATER, decrease: 1 })).toContain(tickable);
    // AND AN EFFECT THAT IS NOT ZONE-WIDE HAS NO BUSINESS AT ZERO.
    expect(validateEffect({ ...ZONE_AURA_UNDERWATER, zoneWide: undefined })).toContain(
      'effect:zone_aura_underwater: decrease 0 never expires (ActorTemporaryEffects.lua:91)',
    );
  });
});

// ---------------------------------------------------------------------------
// 3. The realm — its population, and a wipe's re-seed
// ---------------------------------------------------------------------------

const AURA_IDS = [EffectId.ZoneAuraUnderwater];

/** Two husks on walkable cells that are not arrival tiles. */
function populateHusks(world: World): void {
  const { level } = world;
  const spawns = new Set(makeTestMap().spawns.map((s) => `${String(s.x)},${String(s.y)}`));
  let placed = 0;
  for (let y = 1; y < level.h - 1 && placed < 2; y += 1) {
    for (let x = 1; x < level.w - 1 && placed < 2; x += 1) {
      if (!canWalk(level, x, y) || spawns.has(`${String(x)},${String(y)}`)) continue;
      if (world.actorAt(x, y) !== undefined) continue;
      world.addMonster(`husk_${String(placed)}`, monsterInit(INDEX_HUSK, { x, y }));
      placed += 1;
    }
  }
}

function auraSite(id: string, zoneEffects: readonly string[] | undefined): SiteDef {
  return {
    id,
    name: 'A room with weather in it',
    kind: RealmKind.Inner,
    marker: 'gate',
    lingerMs: 0,
    map: () => ({ ...makeTestMap(), ...(zoneEffects === undefined ? {} : { zoneEffects }) }),
    populate: (world) => {
      populateHusks(world);
    },
  };
}

function monsters(realm: Realm): readonly EquippedActor[] {
  return realm.world.allActors().filter((a) => a.kind === 'monster');
}

describe('a realm lays its auras on what lives in it', () => {
  const wet = auraSite('site:test_weather', AURA_IDS);
  const dry = auraSite('site:test_dry', undefined);
  const make = (effects: EffectState | undefined): Realms =>
    createRealms({
      seed: 'zone-auras',
      engineFor: (world) => createTurnEngine({ world }),
      sites: new Map([
        [wet.id, wet],
        [dry.id, dry],
      ]),
      ...(effects === undefined ? {} : { effects }),
    });

  it('keeps the map`s list, and puts it on every body the floor was populated with', () => {
    const state = createMvpEffectState();
    const realm = make(state).open(wet, 'party:weather');
    expect(realm.zoneEffects).toEqual(AURA_IDS);
    const husks = monsters(realm);
    expect(husks.length).toBe(2);
    for (const husk of husks) {
      expect(effectsOn(state, husk.id).map((eff) => eff.effectId)).toEqual(AURA_IDS);
      // AND IT IS ON THE SHEET THE HUSK FIGHTS WITH, not only in the table.
      const authored = INDEX_HUSK.combat.increase?.cold ?? 0;
      expect(husk.combat?.increase?.cold).toBe(authored + 10);
    }
  });

  it('puts nothing on a floor whose map names none', () => {
    const state = createMvpEffectState();
    const realm = make(state).open(dry, 'party:dry');
    expect(realm.zoneEffects).toEqual([]);
    for (const husk of monsters(realm)) expect(effectsOn(state, husk.id)).toEqual([]);
  });

  it('puts them back on a population a wipe re-mints', () => {
    const state = createMvpEffectState();
    const realm = make(state).open(wet, 'party:wipe');
    // WHAT `resetFloor` DOES FIRST: every monster reaped, its table forgotten.
    for (const husk of monsters(realm)) {
      realm.world.removeActor(husk.id);
      forgetActor(state, husk.id);
    }
    expect(monsters(realm)).toEqual([]);

    realm.world.reseedFloor?.(realm.world);
    const husks = monsters(realm);
    expect(husks.length).toBe(2);
    for (const husk of husks) {
      expect(effectsOn(state, husk.id).map((eff) => eff.effectId)).toEqual(AURA_IDS);
    }
  });

  it('builds and populates with no status table at all', () => {
    const realm = make(undefined).open(wet, 'party:bare');
    expect(monsters(realm).length).toBe(2);
  });

  it('is handed the status table in production, or the population goes bare', () => {
    /**
     * THE ONE JOIN THE SOCKET TESTS DO NOT REACH. `RealmsOptions.effects` is
     * optional, and the test above is the proof that leaving it out is silent:
     * the realm builds, the floor populates, and no monster wears anything.
     * The Weir names an aura (test/server/themed-sites.test.ts), but every
     * harness builds its own realms rather than booting main.ts — so read the
     * call main.ts makes.
     */
    const main = readFileSync(new URL('../../src/server/main.ts', import.meta.url), 'utf8');
    const call = /const realms = createRealms\(\{([\s\S]*?)\n {2}\}\);/.exec(main)?.[1];
    expect(call, 'main.ts no longer builds its realms where this looks').toBeDefined();
    expect(call?.replace(/\/\/.*$/gm, '')).toMatch(/^\s*effects,?\s*$/m);
  });
});

// ---------------------------------------------------------------------------
// 4. The door, over a real socket — and the file
// ---------------------------------------------------------------------------

const FRAME_TIMEOUT_MS = 4_000;

type Harness = {
  port: number;
  realms: Realms;
  effects: EffectState;
  close: () => Promise<void>;
};
let server: Harness;
const openSockets: WebSocket[] = [];

describe('walking through a door', () => {
  beforeEach(async () => {
    const downed = createDownedState();
    const parties = createPartyState();
    const effects = createMvpEffectState();
    // THE REAL `SITES`, so the door is the real Redaction door on the real rows.
    const realms = createRealms({
      seed: 'zone-auras-door',
      engineFor: (world) => createTurnEngine({ world, downed, parties, effects }),
      effects,
    });
    const app = Fastify({ logger: false });
    await app.register(wsGateway, {
      world: realms.overworld.world,
      engine: realms.overworld.engine,
      realms,
      parties,
      downed,
      effects,
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (address === null || typeof address === 'string') throw new Error('no port was bound');
    server = {
      port: address.port,
      realms,
      effects,
      close: async (): Promise<void> => {
        await app.close();
      },
    };
  });

  afterEach(async () => {
    for (const socket of openSockets) socket.close();
    openSockets.length = 0;
    await server.close();
  });

  async function hello(): Promise<{
    actorId: string;
    socket: WebSocket;
    frames: Record<string, unknown>[];
  }> {
    const socket = new WebSocket(`ws://127.0.0.1:${String(server.port)}/ws`);
    openSockets.push(socket);
    const frames: Record<string, unknown>[] = [];
    socket.addEventListener('message', (event: MessageEvent) => {
      const parsed: unknown = JSON.parse(String(event.data));
      if (typeof parsed === 'object' && parsed !== null) frames.push({ ...parsed });
    });
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => {
        resolve();
      });
      socket.addEventListener('error', () => {
        reject(new Error('socket never opened'));
      });
    });
    socket.send(JSON.stringify({ v: PROTOCOL_VERSION, t: 'hello' }));
    const deadline = Date.now() + FRAME_TIMEOUT_MS;
    for (;;) {
      const id = frames.find((f) => f['t'] === 'welcome')?.['selfId'];
      if (typeof id === 'string') return { actorId: id, socket, frames };
      if (Date.now() >= deadline) throw new Error('no welcome came back');
      await sleep(5);
    }
  }

  /**
   * GIVE A REALM A LIST AFTER IT WAS BUILT. The Weir is a delve far from the
   * door these tests walk through, so the list is written onto realms the
   * registry built at boot — the same cast floors.test.ts uses for `lingerMs`.
   * What is under test is the gateway reading `Realm.zoneEffects` at the door;
   * the map-to-realm half is the realm section above.
   */
  function weather(realm: Realm, ids: readonly string[]): void {
    (realm as unknown as { zoneEffects: readonly string[] }).zoneEffects = ids;
  }

  function redaction(): Realm {
    const found = server.realms.all().find((r) => r.siteId === REDACTION_SITE_ID);
    if (found === undefined) throw new Error('no Redaction realm was built');
    return found;
  }

  function doorCell(): { x: number; y: number } {
    const found = [...server.realms.overworld.sites].find(([, id]) => id === REDACTION_SITE_ID);
    if (found === undefined) throw new Error('no door to the Redaction on the Alderbrook rows');
    const [xs, ys] = found[0].split(',');
    return { x: Number(xs), y: Number(ys) };
  }

  async function stepEastOnto(actorId: string, socket: WebSocket, cell: { x: number; y: number }) {
    const held = server.realms.realmOf(actorId)?.world.getActor(actorId);
    if (held === undefined) throw new Error('no body to move');
    held.x = cell.x - 1;
    held.y = cell.y;
    socket.send(JSON.stringify({ v: PROTOCOL_VERSION, t: 'move', dir: 'e' }));
    await sleep(200);
  }

  /** Off the threshold and back on: two real moves, which is what arms the exit. */
  async function leaveBy(actorId: string, socket: WebSocket, cell: { x: number; y: number }) {
    const held = server.realms.realmOf(actorId)?.world.getActor(actorId);
    if (held === undefined) throw new Error('no body to move');
    held.x = cell.x;
    held.y = cell.y;
    socket.send(JSON.stringify({ v: PROTOCOL_VERSION, t: 'move', dir: 'w' }));
    await sleep(200);
    socket.send(JSON.stringify({ v: PROTOCOL_VERSION, t: 'move', dir: 'e' }));
    await sleep(250);
  }

  function auras(actorId: string): readonly string[] {
    return effectsOn(server.effects, actorId)
      .map((eff) => eff.effectId)
      .filter((effectId) => effectId.startsWith('effect:zone_aura_'));
  }

  function sheetOf(actorId: string): CombatSheet | undefined {
    return server.realms.realmOf(actorId)?.world.getActor(actorId)?.combat;
  }

  it('gains the place`s aura walking in, and loses it walking out to a place with none', async () => {
    weather(redaction(), [EffectId.ZoneAuraUnderwater]);

    const { actorId, socket } = await hello();
    expect(auras(actorId), 'the moor names no aura').toEqual([]);
    const cold0 = sheetOf(actorId)?.increase?.cold ?? 0;

    // ── in ───────────────────────────────────────────────────────────────────
    await stepEastOnto(actorId, socket, doorCell());
    expect(server.realms.realmOf(actorId)?.id, 'never crossed').toBe(redaction().id);
    expect(auras(actorId)).toEqual([EffectId.ZoneAuraUnderwater]);
    expect(sheetOf(actorId)?.increase?.cold, 'the new body fights without it').toBe(cold0 + 10);

    // ── out, to ground with no aura: the sheet must come back bare ───────────
    const arrival = server.realms.realmOf(actorId)?.spawns[0];
    if (arrival === undefined) throw new Error('no arrival tile');
    await leaveBy(actorId, socket, arrival);
    expect(server.realms.realmOf(actorId)?.id, 'stranded').toBe(server.realms.overworld.id);
    expect(auras(actorId)).toEqual([]);
    expect(sheetOf(actorId)?.increase?.cold ?? 0, 'the water followed them out').toBe(cold0);
  });

  it('wears the same aura once, crossing between two places that both lay it', async () => {
    weather(server.realms.overworld, [EffectId.ZoneAuraUnderwater]);
    weather(redaction(), [EffectId.ZoneAuraUnderwater]);
    const { actorId, socket } = await hello();
    expect(auras(actorId)).toEqual([EffectId.ZoneAuraUnderwater]);
    const worn = sheetOf(actorId)?.increase?.cold ?? 0;

    await stepEastOnto(actorId, socket, doorCell());
    expect(server.realms.realmOf(actorId)?.id, 'never crossed').toBe(redaction().id);
    expect(auras(actorId)).toEqual([EffectId.ZoneAuraUnderwater]);
    expect(sheetOf(actorId)?.increase?.cold, 'laid twice').toBe(worn);
  });

  it('sends the place`s aura in the first badge frame after hello', async () => {
    weather(server.realms.overworld, [EffectId.ZoneAuraUnderwater]);
    const { frames } = await hello();
    const deadline = Date.now() + FRAME_TIMEOUT_MS;
    while (!frames.some((f) => f['t'] === 'effects') && Date.now() < deadline) await sleep(5);
    const first = frames.find((f) => f['t'] === 'effects');
    expect(JSON.stringify(first)).toContain(EffectId.ZoneAuraUnderwater);
  });

  it('lays it on a later arrival and leaves the first one`s alone', async () => {
    weather(redaction(), [EffectId.ZoneAuraUnderwater]);
    const a = await hello();
    await stepEastOnto(a.actorId, a.socket, doorCell());
    const underwater = (id: string) =>
      effectsOn(server.effects, id).find((eff) => eff.effectId === EffectId.ZoneAuraUnderwater);
    const first = underwater(a.actorId);
    expect(first, 'the first arrival wore nothing').toBeDefined();

    const b = await hello();
    await stepEastOnto(b.actorId, b.socket, { x: doorCell().x, y: doorCell().y });
    expect(server.realms.realmOf(b.actorId)?.id).toBe(redaction().id);
    expect(auras(b.actorId)).toEqual([EffectId.ZoneAuraUnderwater]);
    expect(underwater(a.actorId), 'the first arrival`s aura was set again').toBe(first);
  });
});

describe('a character file', () => {
  it('never holds a place`s aura, and keeps every other status it was given', () => {
    const file = createCharacterFile({
      id: 'chr_aura',
      ownerId: '284739201847583744',
      name: 'Sergeant Vell',
      classId: 'watchman',
      resources: { hp: 61, ap: 4, mp: 2, special: { kind: 'resolve', value: 3 } },
      effects: [
        { effectId: EffectId.ZoneAuraUnderwater, turnsRemaining: 1 },
        { effectId: 'effect:bleeding', turnsRemaining: 2, magnitude: 6 },
      ],
      position: { zoneId: 'alderbrook', depth: 1, cell: [12, 7] },
      createdAt: '2026-09-17T00:00:00.000Z',
    });
    const parsed = parseCharacterFile(JSON.parse(serialiseCharacter(file)));
    expect(parsed.ok && parsed.file.effects).toEqual([
      { effectId: 'effect:bleeding', turnsRemaining: 2, magnitude: 6 },
    ]);
  });
});
