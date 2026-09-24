// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// SHAPE: t-engine4 game/modules/tome/class/Player.lua:140-171 — the floor is armed on arrival
//        t-engine4 game/modules/tome/class/GameState.lua:2928 — the offer states what it pays
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" — https://te4.org/license

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *   THE SHIPPED OBJECTIVE, WALKED FROM THE MOOR TO THE PAYOUT AND BACK OUT.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ═══ THE GAP THIS FILLS, AND IT IS MEMORY `tests-true-of-the-fixture` ═══
 * `brief.test.ts` and `briefquarry.test.ts` both author their own `BriefSpec`
 * and hang it on FLOOR 1 of a site definition they build, because floor 1 is
 * one crossing from the moor and floor 2 is two. Every rule in the feature is
 * therefore proved against a spec that exists only in a test file. NOTHING
 * asserted that `content/briefs.ts` reaches a realm at all: `briefsForSite` on
 * `AUTHORED_SITES`, `SiteDef.briefs` copied at `open`, `briefSpecFor`'s floor
 * band against the SHIPPED `floors: [2, 2]`, and the offerer's own spec id
 * resolving back through `specForActorId` are four joins with no test between
 * them. Deleting the whole authored table left both suites green.
 *
 * So this one authors nothing. It walks two real sockets in through the delve
 * mouth, down the stair, and does the thing the author asked for end to end:
 *
 *   the floor is armed, by the id the content gives it;
 *   the party lead alone may answer, and the other member is told who can;
 *   the offer states its price before it is taken;
 *   the Journal's QUESTS section reads the same frame the strip is drawn from;
 *   the offerer answers where it is IN WORDS and never on the map;
 *   the named body comes apart in a real fight over the socket;
 *   the whole party is paid and the reward is lying where it fell;
 *   walking out ends it, and walking back in does not offer it again.
 *
 * ═══ IT IS SLOW, AND THAT IS THE PRICE OF THE ONLY THING IT PROVES ═══
 * Fifteen seconds, most of it real combat rounds. Everything here is covered
 * faster somewhere else against a fixture; nothing else covers it against the
 * game.
 */

import { setTimeout as sleep } from 'node:timers/promises';

import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { briefOnScreen, briefQuestRows } from '../../src/client/ui/brief.ts';
import { ChatNodeId, ChatOptionId } from '../../src/server/content/chats.ts';
import { createDownedState } from '../../src/server/engine/downed.ts';
import { createPartyState, isLeader } from '../../src/server/engine/party.ts';
import { wsGateway } from '../../src/server/net/gateway.ts';
import { createTurnEngine } from '../../src/server/turn-engine.ts';
import { BriefState } from '../../src/server/world/brief.ts';
import { createRealms, stairsDownOf } from '../../src/server/world/realms.ts';
import { canWalk } from '../../src/shared/level.ts';
import { ActorKind } from '../../src/shared/protocol.ts';
import { PROTOCOL_VERSION } from '../../src/shared/version.ts';
import type { BriefView } from '../../src/shared/protocol.ts';
import type { PartyState } from '../../src/server/engine/party.ts';
import type { Realm, Realms } from '../../src/server/world/realms.ts';

const UNDERWORKS = 'site:underworks';
type Frame = Record<string, unknown>;
type Client = {
  actorId: string;
  send(frame: Frame): void;
  latest(type: string): Frame | undefined;
  all(type: string): Frame[];
  errors(): string[];
  lines(): string[];
  close(): void;
};

const openClients: Client[] = [];
let server: { port: number; realms: Realms; parties: PartyState; close: () => Promise<void> };

async function connect(): Promise<Client> {
  const socket = new WebSocket(`ws://127.0.0.1:${String(server.port)}/ws`);
  const frames: Frame[] = [];
  socket.addEventListener('message', (event: MessageEvent) => {
    const parsed: unknown = JSON.parse(String(event.data));
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      frames.push({ ...parsed });
    }
  });
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve());
    socket.addEventListener('error', () => reject(new Error('no socket')));
  });
  const send = (frame: Frame): void =>
    socket.send(JSON.stringify({ v: PROTOCOL_VERSION, ...frame }));
  send({ t: 'hello' });
  const deadline = Date.now() + 4000;
  for (;;) {
    const id = frames.find((f) => f['t'] === 'welcome')?.['selfId'];
    if (typeof id === 'string') {
      const client: Client = {
        actorId: id,
        send,
        latest: (type) => [...frames].reverse().find((f) => f['t'] === type),
        all: (type) => frames.filter((f) => f['t'] === type),
        errors: () =>
          frames
            .filter((f) => f['t'] === 'error')
            .map((f) => (typeof f['message'] === 'string' ? f['message'] : '')),
        lines: () => {
          const out: string[] = [];
          for (const frame of frames) {
            if (frame['t'] !== 'log') continue;
            const rows = frame['lines'];
            if (!Array.isArray(rows)) continue;
            for (const r of rows as Frame[]) if (typeof r['text'] === 'string') out.push(r['text']);
          }
          return out;
        },
        close: () => socket.close(),
      };
      openClients.push(client);
      return client;
    }
    if (Date.now() >= deadline) throw new Error('no welcome');
    await sleep(5);
  }
}

beforeEach(async () => {
  const downed = createDownedState();
  const parties = createPartyState();
  const realms = createRealms({
    seed: 'drive-briefs',
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
  if (address === null || typeof address === 'string') throw new Error('no port');
  server = { port: address.port, realms, parties, close: async () => app.close() };
});

afterEach(async () => {
  for (const c of openClients) c.close();
  openClients.length = 0;
  await server.close();
});

async function chooseAClass(c: Client): Promise<void> {
  const offered = c.latest('class_options')?.['options'];
  const first = Array.isArray(offered) ? (offered[0] as Frame | undefined) : undefined;
  const classId = first?.['id'];
  if (typeof classId !== 'string') throw new Error('no class');
  c.send({ t: 'choose_class', classId });
  await sleep(200);
}

/** Step onto a target tile from a free neighbour, which is how a crossing fires. */
async function stepOnto(realm: Realm, c: Client, at: { x: number; y: number }): Promise<void> {
  const body = realm.world.getActor(c.actorId);
  if (body === undefined) throw new Error('no body');
  for (const [dx, dy, dir] of [
    [1, 0, 'w'],
    [-1, 0, 'e'],
    [0, 1, 'n'],
    [0, -1, 's'],
  ] as const) {
    const fx = at.x + dx;
    const fy = at.y + dy;
    if (!canWalk(realm.world.level, fx, fy)) continue;
    const sitting = realm.world.actorAt(fx, fy);
    if (sitting !== undefined && sitting.id !== body.id) continue;
    body.x = fx;
    body.y = fy;
    c.send({ t: 'move', dir });
    await sleep(320);
    return;
  }
  throw new Error('no free ground beside the target tile');
}

async function enterDelve(c: Client): Promise<Realm> {
  const door = [...server.realms.overworld.sites].find(([, id]) => id === UNDERWORKS);
  if (door === undefined) throw new Error('no door');
  const [xs, ys] = door[0].split(',');
  const body = server.realms.overworld.world.getActor(c.actorId);
  if (body === undefined) throw new Error('no body on the moor');
  body.x = Number(xs) - 1;
  body.y = Number(ys);
  c.send({ t: 'move', dir: 'e' });
  await sleep(320);
  const inside = server.realms.realmOf(c.actorId);
  if (inside === undefined) throw new Error(`never went in: ${c.errors().join('; ')}`);
  return inside;
}

function view(c: Client): Frame | undefined {
  const v = c.latest('dialogue')?.['view'];
  return typeof v === 'object' && v !== null ? (v as Frame) : undefined;
}
function options(c: Client): Frame[] {
  const rows = view(c)?.['options'];
  return Array.isArray(rows) ? (rows as Frame[]) : [];
}
function row(c: Client, id: string): Frame | undefined {
  return options(c).find((o) => o['id'] === id);
}
async function talk(c: Client, whoId: string): Promise<void> {
  c.send({ t: 'talk', targetId: whoId });
  const deadline = Date.now() + 4000;
  while (view(c) === undefined) {
    if (Date.now() >= deadline) throw new Error(`no window: ${c.errors().join('; ')}`);
    await sleep(10);
  }
}
async function choose(c: Client, nodeId: string, optionId: string): Promise<void> {
  c.send({ t: 'dialogue_choose', nodeId, optionId });
  await sleep(250);
}
function strip(c: Client): BriefView | null | undefined {
  const last = c.all('brief').at(-1);
  if (last === undefined) return undefined;
  const b = last['brief'];
  return b === null ? null : (b as unknown as BriefView);
}

describe('the objective content/briefs.ts actually ships', () => {
  it('walks the whole objective end to end on the shipped Underworks floor 2', async () => {
    // ── 1. two players, partied, the inviter leading ────────────────────────
    const lead = await connect();
    const mate = await connect();
    await chooseAClass(lead);
    await chooseAClass(mate);
    lead.send({ t: 'party', action: 'invite', targetId: mate.actorId });
    await sleep(200);
    mate.send({ t: 'party', action: 'accept', targetId: lead.actorId });
    await sleep(250);
    expect(isLeader(server.parties, lead.actorId)).toBe(true);
    expect(isLeader(server.parties, mate.actorId)).toBe(false);

    // ── 2. into the Underworks, floor 1 ─────────────────────────────────────
    const one = await enterDelve(lead);
    await enterDelve(mate);
    expect(one.floor).toBe(1);
    expect(one.brief, 'floor 1 carries an objective').toBeUndefined();

    // ── 3. down the stair to floor 2, which is the one that carries it ──────
    const down = stairsDownOf(one);
    if (down === null) throw new Error('no stair down');
    await stepOnto(one, mate, down);
    // A PARTY'S TURNS GO IN ORDER while a fight is on, and floor 1 can have one
    // in sight. If the mate's step is waiting behind the lead's turn, the lead
    // passes it so the mate's step lands — and takes them down the stair; the
    // case after this one pins that — before the lead takes the stair too.
    const queued = one.world.getActor(mate.actorId);
    if (queued?.kind === 'player' && queued.pendingIntent !== null) {
      lead.send({ t: 'hold' });
      await sleep(320);
    }
    await stepOnto(one, lead, down);
    const two = server.realms.realmOf(lead.actorId);
    if (two === undefined) throw new Error('never went down');
    expect(two.floor).toBe(2);
    expect(server.realms.realmOf(mate.actorId)?.id).toBe(two.id);
    const brief = two.brief;
    expect(brief?.id).toBe(`brief:${UNDERWORKS}:2`);
    expect(brief?.title).toBe('It kept its name');
    expect(brief?.state).toBe(BriefState.Offered);

    const offererId = brief?.offererId ?? '';
    const stand = (who: Client): void => {
      const them = two.world.getActor(offererId);
      const me = two.world.getActor(who.actorId);
      if (them === undefined || me === undefined) throw new Error('nobody');
      const taken = new Set(
        two.world
          .allActors()
          .filter((a) => a.id !== me.id)
          .map((a) => `${String(a.x)},${String(a.y)}`),
      );
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
        [1, 1],
        [-1, -1],
      ] as const) {
        const x = them.x + dx;
        const y = them.y + dy;
        if (!canWalk(two.world.level, x, y) || taken.has(`${String(x)},${String(y)}`)) continue;
        me.x = x;
        me.y = y;
        return;
      }
      throw new Error('nowhere to stand');
    };

    // ── 4. the NON-LEAD is offered it, greyed, and refused ──────────────────
    stand(mate);
    await talk(mate, offererId);
    const take = row(mate, ChatOptionId.BriefTake);
    expect(take?.['enabled']).toBe(false);
    expect(String(take?.['reason'])).toContain('can answer for the party');
    await choose(mate, ChatNodeId.Greet, ChatOptionId.BriefTake);
    expect(two.brief?.state, 'a non-lead committed the party').toBe(BriefState.Offered);

    // ── 5. and they may interrogate it to the bottom ────────────────────────
    await choose(mate, ChatNodeId.Greet, ChatOptionId.BriefAsk);

    // ── 6. the lead walks over and takes it ─────────────────────────────────
    stand(lead);
    await talk(lead, offererId);
    await choose(lead, ChatNodeId.Greet, ChatOptionId.BriefAsk);
    await choose(lead, ChatNodeId.BriefAsk, ChatOptionId.BriefTake);
    expect(two.brief?.state).toBe(BriefState.Open);
    expect(two.brief?.acceptedBy).toBe(lead.actorId);
    expect(view(lead), 'the window survived the accept').toBeUndefined();

    // ── 7. both read the strip, and the Journal reads the same frame ────────
    expect(strip(lead)?.state).toBe('open');
    expect(strip(mate)?.state).toBe('open');
    // ONE PLACE TO LOOK: the Journal's QUESTS section is built from the SAME
    // frame the strip is drawn from, which is what the section was shipped
    // empty to guarantee.
    expect(briefQuestRows(strip(lead) ?? null)).toEqual([
      { id: 'brief', name: 'It kept its name', status: 'active' },
    ]);
    expect(
      lead.lines().some((line) => line === 'Taken on: It kept its name.'),
      'the party`s log never said what they took on',
    ).toBe(true);

    // ── 8. find it: the offerer answers in words, per asker ─────────────────
    await talk(lead, offererId);
    await choose(lead, ChatNodeId.Greet, ChatOptionId.BriefWhere);
    /**
     * A BAND AND A COMPASS, IN WORDS, AND NEVER A MARK ON THE MAP.
     * `tome/class/Party.lua:410-418` — three distance bands and a direction.
     * `BriefView` carries no position at all, so this sentence is the only
     * channel there is until the body is in sight.
     */
    const spoken = view(lead)?.['text'];
    const said = typeof spoken === 'string' ? spoken : '';
    expect(said, 'the offerer would not say where it is').toContain('Sallow Cordage');
    expect(
      ['very close', 'close', 'still far away'].some((band) => said.includes(band)),
      `no distance band in: ${said}`,
    ).toBe(true);
    expect(/to the (north|south|east|west)/.test(said), `no bearing in: ${said}`).toBe(true);
    lead.send({ t: 'dialogue_close' });
    await sleep(120);

    const target = two.brief?.target;
    const namedId = target?.k === 'quarry' ? (target.actorId ?? '') : '';
    const quarry = two.world.getActor(namedId);
    if (quarry === undefined || quarry.kind !== ActorKind.Monster) throw new Error('nothing named');
    expect(quarry.name).toBe('Sallow Cordage');
    expect(quarry.mark).toBe('THIS ONE KEPT ITS NAME');

    // ── 9. unmake it, by walking into it ────────────────────────────────────
    const before = {
      lead: (two.world.getActor(lead.actorId) as { xp: number }).xp,
      mate: (two.world.getActor(mate.actorId) as { xp: number }).xp,
    };
    // Everything else off the floor, so the walk is not a fight with the room.
    for (const body of two.world.allActors()) {
      if (body.kind === ActorKind.Monster && body.id !== namedId && body.id !== offererId) {
        two.world.removeActor(body.id);
      }
    }
    two.world.turn.engagement = 0;
    // BOTH OF THEM ACT EACH ROUND: the barrier waits on every party member, so
    // a lead swinging alone is a lead whose intent is held.
    const me0 = two.world.getActor(lead.actorId);
    const it0 = two.world.getActor(namedId);
    if (me0 === undefined || it0 === undefined) throw new Error('no bodies');
    me0.x = it0.x - 1;
    me0.y = it0.y;
    const mateBody = two.world.getActor(mate.actorId);
    if (mateBody !== undefined) {
      mateBody.x = it0.x - 3;
      mateBody.y = it0.y;
    }
    let swings = 0;
    for (; swings < 60 && two.brief?.state === BriefState.Open; swings += 1) {
      const it = two.world.getActor(namedId);
      const me = two.world.getActor(lead.actorId);
      if (it === undefined || me === undefined || !it.alive) break;
      // STAY BESIDE IT — the body moves, and a swing at empty ground is a step.
      if (Math.max(Math.abs(me.x - it.x), Math.abs(me.y - it.y)) !== 1 || me.y !== it.y) {
        me.x = it.x - 1;
        me.y = it.y;
      }
      lead.send({ t: 'move', dir: 'e' });
      mate.send({ t: 'move', dir: swings % 2 === 0 ? 'n' : 's' });
      await sleep(140);
    }
    expect(two.brief?.state, 'the body never came apart').toBe(BriefState.Closed);

    // ── 10. paid, told, and the thing is lying where it fell ────────────────
    const paid = {
      lead: (two.world.getActor(lead.actorId) as { xp: number }).xp - before.lead,
      mate: (two.world.getActor(mate.actorId) as { xp: number }).xp - before.mate,
    };
    expect(paid.mate, 'the mate was not paid for work their party did').toBeGreaterThan(0);
    // THE BODY MOVED WHILE THEY FOUGHT IT, so the reward lands where it FELL
    // rather than where it was standing when the objective was taken.
    const all = two.world.groundItems();
    const lying = all.filter((i) => JSON.stringify(i).includes('lamp'));
    expect(lying.length, 'nothing was left where it fell').toBeGreaterThan(0);
    // THE FRAME CARRIES THE ENDING STATE; the CLIENT stops drawing it.
    expect(strip(lead)?.state).toBe('closed');
    expect(briefOnScreen(strip(lead) ?? null), 'the band is still up').toBe(false);
    // AND THE JOURNAL KEEPS THE OUTCOME, in upstream's own word.
    expect(briefQuestRows(strip(lead) ?? null)[0]?.status).toBe('done');
    expect(lead.lines().some((line) => line === 'Done: It kept its name.')).toBe(true);
    expect(lead.lines().some((line) => line === 'Something is lying where it fell.')).toBe(true);

    // ── 11. take the payment off the floor ──────────────────────────────────
    const me2 = two.world.getActor(lead.actorId);
    const fell = lying[0] as unknown as { x: number; y: number };
    if (me2 === undefined) throw new Error('no body');
    me2.x = fell.x;
    me2.y = fell.y;
    // A FEW TURNS FIRST: the lock the kill just set refuses everything else too.
    for (let idle = 0; idle < 4; idle += 1) {
      lead.send({ t: 'move', dir: idle % 2 === 0 ? 'n' : 's' });
      mate.send({ t: 'move', dir: idle % 2 === 0 ? 's' : 'n' });
      await sleep(160);
    }
    const back2 = two.world.getActor(lead.actorId);
    if (back2 !== undefined) {
      back2.x = fell.x;
      back2.y = fell.y;
    }
    // BY ID: the tile is a pile, and a bare pickup takes the top of it.
    lead.send({ t: 'pickup', id: (lying[0] as unknown as { id: string }).id });
    await sleep(400);
    const after = two.world.groundItems().filter((i) => JSON.stringify(i).includes('lamp'));
    expect(after.length, 'the payment could not be taken off the floor').toBe(0);

    // ── 12. and out, up the stair ───────────────────────────────────────────
    const up = two.spawns[0];
    if (up === undefined) throw new Error('no way back');
    // THE ANTI-STAIRSCUM LOCK IS REAL: *"not so soon after a kill"*. Spend a few
    // turns on the floor before trying the way out, exactly as a party would.
    for (let idle = 0; idle < 6; idle += 1) {
      lead.send({ t: 'move', dir: idle % 2 === 0 ? 'n' : 's' });
      mate.send({ t: 'move', dir: idle % 2 === 0 ? 's' : 'n' });
      await sleep(160);
    }
    await stepOnto(two, mate, up);
    expect(two.brief, 'one member leaving ended it').toBeDefined();
    for (let attempt = 0; attempt < 6 && two.brief !== undefined; attempt += 1) {
      await stepOnto(two, lead, up);
    }
    expect(two.brief, 'the floor kept a reference').toBeUndefined();
    expect(strip(lead), 'the strip survived the walk out').toBeNull();

    // ── 13. and walking back in does not re-offer it ────────────────────────
    const back = server.realms.realmOf(lead.actorId);
    // THE ROOM OFF THIS FLOOR TOO, for step 9's reason: the walk back down is
    // the question here, not a fight. It passed without this until monster
    // sight became ToME's shadowcast, and on this seed the one thing that
    // changed by the stair (14,3) is `delve_27`: under the shadowcast it walks
    // to (14,4), through the diagonal gap, and under the square-and-line rule
    // it did not. `delve_5` stepping onto the stair tile happens under BOTH
    // rules, so it is not what this re-pin answers.
    const floorOne = back ?? one;
    for (const body of floorOne.world.allActors()) {
      if (body.kind === ActorKind.Monster) floorOne.world.removeActor(body.id);
    }
    floorOne.world.turn.engagement = 0;
    const downAgain = stairsDownOf(floorOne);
    if (downAgain === null) throw new Error('no stair down');
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await stepOnto(back ?? one, lead, downAgain);
      if (server.realms.realmOf(lead.actorId)?.floor === 2) break;
      // BOTH OF THEM: the barrier waits on every party member, and the mate
      // standing still is the mate holding the lead's step.
      lead.send({ t: 'move', dir: attempt % 2 === 0 ? 'n' : 's' });
      mate.send({ t: 'move', dir: attempt % 2 === 0 ? 's' : 'n' });
      await sleep(200);
    }
    const again = server.realms.realmOf(lead.actorId);
    expect(again?.id, 'a different instance').toBe(two.id);
    expect(again?.brief, 'the floor offered its work a second time').toBeUndefined();
  }, 60_000);

  it('takes a player down the stair on a step that waited its turn', async () => {
    // A PARTY'S TURNS GO IN ORDER in a fight, so a step sent out of turn lands
    // on somebody else's command — and the stair is checked in the tail of the
    // mover's OWN command, which ran while the step was still waiting. It has
    // to be checked again when the step lands (`walkOnQueued`, net/gateway.ts),
    // or the mover stands on the stair and goes nowhere.
    const lead = await connect();
    const mate = await connect();
    await chooseAClass(lead);
    await chooseAClass(mate);
    lead.send({ t: 'party', action: 'invite', targetId: mate.actorId });
    await sleep(200);
    mate.send({ t: 'party', action: 'accept', targetId: lead.actorId });
    await sleep(250);
    const one = await enterDelve(lead);
    await enterDelve(mate);
    const down = stairsDownOf(one);
    if (down === null) throw new Error('no stair down');

    // A FIGHT, AND THE LEAD FIRST IN IT — set, so the case is not a roll.
    one.world.turn.engagement = 3;
    for (const body of one.world.allActors()) {
      body.initiative = body.id === lead.actorId ? 20 : body.id === mate.actorId ? 10 : 1;
    }

    await stepOnto(one, mate, down);
    const queued = one.world.getActor(mate.actorId);
    expect(
      queued?.kind === 'player' && queued.pendingIntent !== null,
      'the step went in turn',
    ).toBe(true);
    expect(server.realms.realmOf(mate.actorId)?.floor).toBe(1);

    // The lead passes; the mate's step lands, on the stair, and takes them down.
    lead.send({ t: 'hold' });
    await sleep(320);
    expect(server.realms.realmOf(mate.actorId)?.floor).toBe(2);
  }, 20_000);
});
