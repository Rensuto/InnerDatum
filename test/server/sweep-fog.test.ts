// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/engines/default/engine/Actor.lua:520 (sight gates what is told, not only what resolves)
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { actorsNamedBy, fogEvent } from '../../src/server/view/projector.ts';
import { DEFAULT_SIGHT_RADIUS, sightDistance } from '../../src/server/world/sight.ts';
import { createDownedState } from '../../src/server/engine/downed.ts';
import { createPartyState } from '../../src/server/engine/party.ts';
import { wsGateway } from '../../src/server/net/gateway.ts';
import { createTurnEngine } from '../../src/server/turn-engine.ts';
import { createRealms } from '../../src/server/world/realms.ts';
import { AiProfile } from '../../src/server/engine/actor.ts';
import { canWalk } from '../../src/shared/level.ts';
import { hasLineOfSight } from '../../src/server/world/world.ts';
import { PROTOCOL_VERSION } from '../../src/shared/version.ts';
import type { TurnEvent } from '../../src/shared/protocol.ts';
import type { Realms } from '../../src/server/world/realms.ts';
import type { World } from '../../src/server/world/world.ts';
import type { TileXY } from '../../src/shared/coords.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE BOARD WAS FOGGED AND THE WIRE WAS NOT.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `6d201c3` filtered `projectActors`, so a monster out of sight is in no
 * snapshot. It left `SweepMsg` a `BroadcastMsg`, so the same client was still
 * told the tile of every monster that moved anywhere on the map — a position
 * leak by the exact definition CLAUDE.md non-negotiable 4 exists for, and one
 * the fogged board made LOOK fixed.
 *
 * The visible symptom was noise: `client/main.ts:4940` warns and drops a move
 * for an actor it has never seen, so every out-of-sight step wrote a console
 * line. The real problem was underneath it.
 *
 * ═══ WHAT THIS FILE ASSERTS IS AN INVARIANT, NOT A SCENARIO ═══
 * "No frame this client received ever named an actor this client did not hold."
 * That is the whole property, it is checkable by replaying the frame stream, and
 * it catches ORDERING bugs a scenario test would miss — in particular the one
 * that makes recomputing visibility at send time wrong.
 */

const FRAME_TIMEOUT_MS = 4_000;

// ---------------------------------------------------------------------------
// Which actors an event names
// ---------------------------------------------------------------------------

describe('actorsNamedBy', () => {
  it('names the subject of an ordinary event', () => {
    const move: TurnEvent = { k: 'move', id: 'm1', x: 3, y: 4, fromX: 2, fromY: 4 };
    expect(actorsNamedBy(move)).toEqual(['m1']);
  });

  it('names BOTH sides of an attack', () => {
    // The case that matters: an attack seen only from the attacker's side would
    // reach a client holding no body for `targetId`.
    const attack: TurnEvent = { k: 'attack', id: 'm1', targetId: 'p1', x: 3, y: 4, hit: true };
    expect([...actorsNamedBy(attack)].sort()).toEqual(['m1', 'p1']);
  });

  it('names the rescuer as well as the rescued', () => {
    // `RevivedEvent.byId` — "the one event in the game that names a friend".
    const revived: TurnEvent = { k: 'revived', id: 'p1', byId: 'p2', hp: 5, maxHp: 20 };
    expect([...actorsNamedBy(revived)].sort()).toEqual(['p1', 'p2']);
  });

  it('does not mistake a talent or effect id for a body', () => {
    const used: TurnEvent = {
      k: 'talent',
      id: 'p1',
      talentId: 'talent:alchemic_vial',
      x: 1,
      y: 1,
      shape: 'cross',
      radius: 1,
    } as unknown as TurnEvent;
    expect(actorsNamedBy(used)).toEqual(['p1']);
  });

  it('never lets an unheld id reach the wire, for EVERY variant of the union', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE PROPERTY ITSELF, DERIVED FROM THE DECLARATION RATHER THAN A LIST.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * An eleventh `TurnEvent` variant carrying a new actor id would leak
     * silently: `fogEvent` would neither gate nor redact it, the filter would
     * pass the event, and a client would be handed the position of a body it
     * cannot see. No type error — the union widens and the function keeps
     * compiling.
     *
     * So this reads the union out of protocol.ts, builds ONE SYNTHETIC EVENT
     * PER VARIANT with every id field set to a body the viewer does not hold,
     * and asserts the only two acceptable answers: withhold it, or serialise
     * it with no trace of the unheld name. That is the actual invariant, and it
     * needs no hand-maintained list to stay true.
     *
     * IT HAS ALREADY EARNED ITS KEEP THREE TIMES. `DamageEvent.sourceId`,
     * `DeathEvent.killerId` and `TalentEvent.targetId` were all missing from
     * the first implementation, and a hand grep for id fields half an hour
     * earlier had found none of them — every one is written `field?:`, which
     * puts a `?` where the grep expected a colon.
     */
    const source = readFileSync(new URL('../../src/shared/protocol.ts', import.meta.url), 'utf8');

    const union = /export type TurnEvent =([\s\S]*?);/.exec(source);
    expect(union, 'the TurnEvent union moved — this guard is now blind').not.toBeNull();
    const variants = [...(union?.[1] ?? '').matchAll(/\|?\s*(\w+Event)/g)].map((m) => String(m[1]));
    expect(variants.length).toBeGreaterThan(5);

    /** Id-shaped fields that name no ACTOR, and so cannot leak a position. */
    const notActors = new Set(['talentId', 'effectId']);

    const ME = 'the-viewer';
    const held = new Set([ME]);
    let checked = 0;

    for (const variant of variants) {
      // Sliced rather than matched. A regex built by interpolating a name into
      // a template literal has to escape its braces through two layers, and the
      // version that did got them wrong in a way that still compiled and simply
      // matched nothing — a guard that silently checks zero variants.
      const opens = `export type ${variant} = {`;
      const at = source.indexOf(opens);
      expect(at, `${variant} is in the union but has no declaration`).toBeGreaterThan(-1);
      const decl = source.slice(at + opens.length, source.indexOf('\n};', at));

      const kind = /^\s{2}k: '([a-z_]+)'/m.exec(decl)?.[1];
      expect(kind, `${variant} has no k discriminant`).toBeDefined();

      const fields = [...decl.matchAll(/^\s{2}(\w*[Ii]d)\s*(\??):/gm)].map((m) => String(m[1]));
      const actorFields = fields.filter((f) => !notActors.has(f));
      expect(actorFields, `${variant} declares no id at all`).toContain('id');

      // The subject is the viewer, so nothing is withheld for the trivial
      // reason; every OTHER id names a body the viewer does not hold.
      const synthetic: Record<string, unknown> = { k: kind, id: ME };
      for (const field of actorFields) {
        if (field !== 'id') synthetic[field] = `unheld-${field}`;
      }

      const fogged = fogEvent(synthetic as unknown as TurnEvent, held);
      checked += 1;
      if (fogged === null) continue; // withheld outright is always acceptable
      expect(
        JSON.stringify(fogged),
        `${variant} reached the wire naming a body the viewer does not hold — ` +
          `add the field to actorsNamedBy (required ids gate) or OPTIONAL_ACTOR_IDS ` +
          `(optional ids redact)`,
      ).not.toContain('unheld-');
    }
    expect(checked, 'the scrape matched no variants').toBeGreaterThan(5);
  });
});

describe('fogEvent — withheld, redacted, or whole', () => {
  const held = new Set(['p1', 'seen']);

  it('withholds an event whose subject the viewer does not hold', () => {
    const move: TurnEvent = { k: 'move', id: 'unseen', x: 3, y: 4, fromX: 2, fromY: 4 };
    expect(fogEvent(move, held)).toBeNull();
  });

  it('passes an event whose actors are all held, untouched', () => {
    const move: TurnEvent = { k: 'move', id: 'seen', x: 3, y: 4, fromX: 2, fromY: 4 };
    expect(fogEvent(move, held)).toEqual(move);
  });

  it('withholds an attack when only ONE side is held', () => {
    // Both sides gate: an `attack` is a positional animation from A to B, and a
    // client holding no body for `targetId` cannot draw it.
    const attack: TurnEvent = {
      k: 'attack',
      id: 'seen',
      targetId: 'unseen',
      x: 3,
      y: 4,
      hit: true,
    };
    expect(fogEvent(attack, held)).toBeNull();
  });

  it('DELIVERS a blow from an unseen attacker, with the attacker redacted', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE ASSERTION THE WHOLE REDACTION RULE EXISTS FOR.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * Gating on `sourceId` would withhold this frame entirely and a player would
     * watch their own health bar drop with nothing said. Passing it through
     * would name a body standing in the dark. Neither is right; stripping it is.
     */
    const hit: TurnEvent = {
      k: 'damage',
      id: 'p1',
      amount: 12,
      hp: 8,
      maxHp: 20,
      sourceId: 'unseen',
    };
    const fogged = fogEvent(hit, held);
    expect(fogged, 'the blow was swallowed — the victim is visible').not.toBeNull();
    expect(fogged?.k).toBe('damage');
    expect((fogged as { amount: number }).amount).toBe(12);
    expect((fogged as { sourceId?: string }).sourceId).toBeUndefined();
  });

  it('and the redaction really leaves the wire, not just the object', () => {
    // `JSON.stringify` omits an undefined value, which is what makes assigning
    // `undefined` the same thing as deleting the key. Asserted on the SERIALISED
    // frame because that is what a determined observer reads.
    const hit: TurnEvent = {
      k: 'damage',
      id: 'p1',
      amount: 12,
      hp: 8,
      maxHp: 20,
      sourceId: 'unseen',
    };
    expect(JSON.stringify(fogEvent(hit, held))).not.toContain('unseen');
  });

  it('keeps the attacker when the viewer CAN see them', () => {
    const hit: TurnEvent = {
      k: 'damage',
      id: 'p1',
      amount: 12,
      hp: 8,
      maxHp: 20,
      sourceId: 'seen',
    };
    expect((fogEvent(hit, held) as { sourceId?: string }).sourceId).toBe('seen');
  });
});

// ---------------------------------------------------------------------------
// The invariant, over a real socket
// ---------------------------------------------------------------------------

type Harness = { port: number; realms: Realms; close: () => Promise<void> };
let server: Harness;
const openSockets: WebSocket[] = [];

beforeEach(async () => {
  const downed = createDownedState();
  const parties = createPartyState();
  const realms = createRealms({
    seed: 'sweep-fog',
    engineFor: (world) => createTurnEngine({ world, downed, parties }),
  });
  const app = Fastify({ logger: false });
  await app.register(wsGateway, {
    world: realms.overworld.world,
    engine: realms.overworld.engine,
    realms,
    parties,
    downed,
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (address === null || typeof address === 'string') throw new Error('no port was bound');
  server = {
    port: address.port,
    realms,
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

type Client = {
  actorId: string;
  frames: Record<string, unknown>[];
  send(frame: Record<string, unknown>): void;
};

async function hello(port: number): Promise<Client> {
  const socket = new WebSocket(`ws://127.0.0.1:${String(port)}/ws`);
  openSockets.push(socket);
  const frames: Record<string, unknown>[] = [];
  socket.addEventListener('message', (event: MessageEvent) => {
    const parsed: unknown = JSON.parse(String(event.data));
    if (typeof parsed === 'object' && parsed !== null) {
      frames.push({ ...(parsed as Record<string, unknown>) });
    }
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
    if (typeof id === 'string') {
      return {
        actorId: id,
        frames,
        send(frame): void {
          socket.send(JSON.stringify({ v: PROTOCOL_VERSION, ...frame }));
        },
      };
    }
    if (Date.now() >= deadline) throw new Error('no welcome came back');
    await sleep(5);
  }
}

/**
 * Replay the client's real bookkeeping and report every violation.
 *
 * `client/main.ts:11247-11255` is the whole handler: `joined` sets, `left`
 * deletes, a snapshot replaces. Walking the frames in order and checking each
 * sweep against the board AS IT STOOD AT THAT MOMENT is what makes this an
 * ordering test and not just a filtering one.
 */
function namesTheClientNeverHeld(frames: readonly Record<string, unknown>[]): string[] {
  const held = new Set<string>();
  const violations: string[] = [];
  let sweeps = 0;

  for (const frame of frames) {
    const t = frame['t'];
    if (t === 'welcome' || t === 'state' || t === 'realm') {
      const rows = frame['actors'];
      if (!Array.isArray(rows)) continue;
      if (t !== 'welcome') held.clear();
      for (const row of rows as Record<string, unknown>[]) {
        if (typeof row['id'] === 'string') held.add(row['id']);
      }
    } else if (t === 'joined') {
      const actor = frame['actor'];
      if (typeof actor === 'object' && actor !== null) {
        const who = (actor as Record<string, unknown>)['id'];
        if (typeof who === 'string') held.add(who);
      }
    } else if (t === 'left') {
      const who = frame['id'];
      if (typeof who === 'string') held.delete(who);
    } else if (t === 'sweep') {
      const events = frame['events'];
      if (!Array.isArray(events)) continue;
      sweeps += 1;
      for (const event of events as TurnEvent[]) {
        for (const named of actorsNamedBy(event)) {
          if (!held.has(named)) violations.push(`${event.k} named ${named}`);
        }
      }
    }
  }
  // A run with no sweeps at all would make the check vacuous; the caller asserts
  // on this separately rather than letting silence pass for correctness.
  if (sweeps === 0) violations.push('__no_sweeps__');
  return violations;
}

/** How far the hunters below will chase. Far enough to cross the dark gap. */
const AGGRO = 60;

/**
 * A walkable, unoccupied tile OUT OF SIGHT but WELL INSIDE `AGGRO`.
 *
 * ═══ THE FIXTURE THIS REPLACES WAS INERT, AND EVERYTHING PASSED ANYWAY ═══
 * The first version took the FARTHEST tile on the map and never checked
 * `canWalk`. It picked a wall; `addMonster` quietly relocated to the nearest
 * free tile; the overworld turned out to be far larger than the 30x30 test map,
 * so the husk ended up 110 tiles from the party — outside its own aggro range —
 * and never took a single turn. Every assertion passed. So did the mutation
 * that deletes the filter outright, because there was nothing to leak.
 *
 * The assertion that would have caught it is not "is the tile far" but "did the
 * monster MOVE", and the caller now makes it.
 */
function darkButReachable(world: World, from: TileXY): TileXY {
  const level = world.level;
  let best: (TileXY & { d: number }) | undefined;
  for (let y = 1; y < level.h - 1; y += 1) {
    for (let x = 1; x < level.w - 1; x += 1) {
      if (!canWalk(level, x, y)) continue;
      if (world.actorAt(x, y) !== undefined) continue;
      const d = sightDistance(from, { x, y });
      // Beyond sight with a margin, and close enough to hunt. The NEAREST such
      // tile, so the walk is short and several of its steps fall in the dark.
      if (d <= DEFAULT_SIGHT_RADIUS + 2 || d > AGGRO * 0.5) continue;
      /**
       * AND IT MUST BE ABLE TO SEE THE PARTY, or it never wakes up.
       *
       * `anyContact` and `visibleEnemies` both require `hasLineOfSight`, and
       * neither is bounded by OUR sight radius — real monsters carry
       * `aggroRange` 0-14 so the two can never disagree in the shipped game,
       * but a fixture with a long leash can sit in clear view at 22 and simply
       * idle. That is what the first two versions of this fixture did.
       *
       * The tile this leaves is the interesting one anyway: it can see you and
       * you cannot see it. It hunts you out of the dark.
       */
      if (!hasLineOfSight(level, { x, y }, from)) continue;
      if (best === undefined || d < best.d) best = { x, y, d };
    }
  }
  expect(
    best,
    'no walkable tile is out of sight, in aggro range, and in line of sight',
  ).toBeDefined();
  if (best === undefined) throw new Error('unreachable');
  return { x: best.x, y: best.y };
}

describe('the sweep a viewer is sent', () => {
  it('never names an actor that viewer does not hold', async () => {
    const client = await hello(server.port);
    const world = server.realms.overworld.world;
    const body = world.getActor(client.actorId);
    if (body === undefined) throw new Error('no body');
    // It gets hit while this runs; it must live long enough to be told things.
    body.hp = 5000;
    body.maxHp = 5000;

    // THE HUNTER, starting in the dark and walking in. Those first steps are
    // exactly the window the old realm-wide broadcast leaked.
    const dark = darkButReachable(world, body);
    const chaser = world.addMonster('chaser', {
      name: 'Index Husk',
      sprite: 'enemy_index_husk_s',
      x: dark.x,
      y: dark.y,
      profile: AiProfile.MeleeChaser,
      aggroRange: AGGRO,
    });
    // `addMonster` RELOCATES if the tile is taken, so where it actually stands
    // is the only position worth asserting on.
    const startedAt = { x: chaser.x, y: chaser.y };
    expect(
      sightDistance(body, startedAt),
      'the hunter was placed inside sight — there is no dark walk to test',
    ).toBeGreaterThan(DEFAULT_SIGHT_RADIUS);

    /**
     * AND SOMETHING THE PLAYER CAN SEE, or the invariant is vacuous: a run in
     * which every event is correctly withheld produces no sweep at all, and
     * "no violations" would then be true of a build that sends nothing.
     */
    world.addMonster('neighbour', {
      name: 'Index Husk',
      sprite: 'enemy_index_husk_s',
      x: body.x + 3,
      y: body.y,
      profile: AiProfile.MeleeChaser,
      aggroRange: AGGRO,
    });

    for (let turn = 0; turn < 12; turn += 1) {
      client.send({ t: 'hold' });
      await sleep(110);
    }

    // ═══ THE FIXTURE DID SOMETHING ═══
    const now = world.getActor('chaser');
    expect(now, 'the hunter left the world').toBeDefined();
    expect(
      now === undefined ? 0 : Math.abs(now.x - startedAt.x) + Math.abs(now.y - startedAt.y),
      'the hunter never moved — it took no turns, so this test proves nothing',
    ).toBeGreaterThan(0);

    // ═══ AND THE INVARIANT HELD WHILE IT DID ═══
    const violations = namesTheClientNeverHeld(client.frames);
    expect(
      violations.filter((v) => v !== '__no_sweeps__'),
      'a sweep named a body this client had never been told about',
    ).toEqual([]);
    expect(violations, 'no sweep arrived at all — the check was vacuous').not.toContain(
      '__no_sweeps__',
    );
  });

  it('says nothing whatever about a hunter still in the dark', async () => {
    /**
     * The blunt half, kept separate so its failure reads differently: not "the
     * board disagreed with the stream" but "this name was on the wire at all".
     * Searches the raw serialised frames, because that is what a determined
     * observer reads — a client that merely DROPS an unknown actor is not fog.
     */
    const client = await hello(server.port);
    const world = server.realms.overworld.world;
    const body = world.getActor(client.actorId);
    if (body === undefined) throw new Error('no body');
    body.hp = 5000;
    body.maxHp = 5000;

    const dark = darkButReachable(world, body);
    const chaser = world.addMonster('chaser', {
      name: 'Index Husk',
      sprite: 'enemy_index_husk_s',
      x: dark.x,
      y: dark.y,
      profile: AiProfile.MeleeChaser,
      aggroRange: AGGRO,
    });
    const startedAt = { x: chaser.x, y: chaser.y };
    expect(sightDistance(body, startedAt)).toBeGreaterThan(DEFAULT_SIGHT_RADIUS);

    // Two turns only — long enough to act, short enough that it is still out
    // of sight when we look.
    client.send({ t: 'hold' });
    await sleep(140);
    client.send({ t: 'hold' });
    await sleep(140);

    const now = world.getActor('chaser');
    expect(
      now === undefined ? 0 : Math.abs(now.x - startedAt.x) + Math.abs(now.y - startedAt.y),
      'the hunter never moved — nothing was withheld because nothing happened',
    ).toBeGreaterThan(0);
    expect(
      now === undefined ? 0 : sightDistance(body, now),
      'it arrived already — shorten the walk or this proves nothing',
    ).toBeGreaterThan(DEFAULT_SIGHT_RADIUS);

    const named = client.frames.some((frame) => JSON.stringify(frame).includes('chaser'));
    expect(named, 'a monster still in the dark was named on the wire').toBe(false);
  });
});
