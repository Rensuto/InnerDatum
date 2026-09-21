// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/modules/tome/class/Party.lua:46-88, :136-139
//                       game/modules/tome/class/GameState.lua:2624-2636
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * SOMEBODY AGREES TO WALK WITH YOU, OVER A REAL SOCKET.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `escort.test.ts` proves the rules — the body, the follow, the arrival, the
 * edge — against the engine directly. This file drives the ENTRY POINT a
 * player uses, because the failures this configuration can have are all in the
 * one line between two correct layers:
 *
 *   The accept flips the body and no client is ever told, so every screen goes
 *     on drawing somebody who lives here and the server answers *"there is
 *     nobody there to talk to"* about the person walking beside them.
 *   The objective closes and the companion is removed with no frame that says
 *     so, and a body the server has deleted stays on the board forever.
 *   The reward is computed and lands on nobody.
 *
 * ═══ AND IT IS TWO PLAYERS, ALWAYS ═══
 * The same rule `briefquarry.test.ts` states: a solo player leads themselves,
 * so a test that drove one could not tell *"the party was paid"* from *"the
 * lead was paid"*.
 */

import { setTimeout as sleep } from 'node:timers/promises';

import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ChatNodeId, ChatOptionId } from '../../src/server/content/chats.ts';
import { createDownedState } from '../../src/server/engine/downed.ts';
import { createPartyState, isLeader, partyIdOf } from '../../src/server/engine/party.ts';
import { FIELD_FOLK } from '../../src/server/content/townsfolk.ts';
import { STRANDED_HAND } from '../../src/server/content/monsters.ts';
import { wsGateway } from '../../src/server/net/gateway.ts';
import { createTurnEngine } from '../../src/server/turn-engine.ts';
import { BriefKind, BriefState } from '../../src/server/world/brief.ts';
import { SITES, createRealms } from '../../src/server/world/realms.ts';
import { canWalk } from '../../src/shared/level.ts';
import { chebyshev } from '../../src/shared/coords.ts';
import { ActorKind, ActorRank } from '../../src/shared/protocol.ts';
import { PROTOCOL_VERSION } from '../../src/shared/version.ts';
import type { BriefSpec } from '../../src/server/world/brief.ts';
import type { PartyState } from '../../src/server/engine/party.ts';
import type { Realm, Realms, SiteDef } from '../../src/server/world/realms.ts';

const FRAME_TIMEOUT_MS = 4_000;
const UNDERWORKS = 'site:underworks';

const WHO = FIELD_FOLK.get('callow');
if (WHO === undefined) throw new Error('nobody in FIELD_FOLK offers an escort');

/**
 * FLOOR 1 SO THE DOOR IS THE FIXTURE — `briefquarry.test.ts`'s reason
 * verbatim: walking in through a marker on the moor is the crossing this
 * feature hangs off, and reaching floor 3 (where the shipped one lives) would
 * mean driving two stairs as well.
 */
const ESCORT: BriefSpec = {
  id: 'test:underworks:one-still-walking',
  kind: BriefKind.Escort,
  floors: [1, 1],
  title: 'The way back, with her',
  detail: 'One of the crew that came down here is still on her feet.',
  reward: { level: 3, rank: ActorRank.Elite },
  offerer: WHO,
  escort: { after: 'leaves', body: STRANDED_HAND },
};

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
    socket.addEventListener('open', () => {
      resolve();
    });
    socket.addEventListener('error', () => {
      reject(new Error('the socket never opened'));
    });
  });
  const send = (frame: Frame): void => {
    socket.send(JSON.stringify({ v: PROTOCOL_VERSION, ...frame }));
  };
  send({ t: 'hello' });

  const deadline = Date.now() + FRAME_TIMEOUT_MS;
  for (;;) {
    const id = frames.find((f) => f['t'] === 'welcome')?.['selfId'];
    if (typeof id === 'string') {
      const client: Client = {
        actorId: id,
        send,
        latest: (type) => [...frames].reverse().find((f) => f['t'] === type),
        all: (type) => frames.filter((f) => f['t'] === type),
        errors: () => {
          const out: string[] = [];
          for (const frame of frames) {
            if (frame['t'] === 'error' && typeof frame['message'] === 'string') {
              out.push(frame['message']);
            }
          }
          return out;
        },
        lines: () => {
          const out: string[] = [];
          for (const frame of frames) {
            if (frame['t'] !== 'log') continue;
            const rows = frame['lines'];
            if (!Array.isArray(rows)) continue;
            for (const row of rows as Frame[]) {
              if (typeof row['text'] === 'string') out.push(row['text']);
            }
          }
          return out;
        },
        close: () => {
          socket.close();
        },
      };
      openClients.push(client);
      return client;
    }
    if (Date.now() >= deadline) throw new Error('no welcome came back');
    await sleep(5);
  }
}

beforeEach(async () => {
  const downed = createDownedState();
  const parties = createPartyState();
  const realms = createRealms({
    seed: 'brief-escort',
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
    parties,
    close: async (): Promise<void> => {
      await app.close();
    },
  };
});

afterEach(async () => {
  for (const client of openClients) client.close();
  openClients.length = 0;
  await server.close();
});

function site(id: string): SiteDef {
  const def = SITES.get(id);
  if (def === undefined) throw new Error(`no such site: ${id}`);
  return def;
}

/** Walk this body onto the Underworks door on the moor. */
async function enterDelve(client: Client): Promise<Realm> {
  const door = [...server.realms.overworld.sites].find(([, id]) => id === UNDERWORKS);
  if (door === undefined) throw new Error('no door to the Underworks');
  const [xs, ys] = door[0].split(',');
  const body = server.realms.overworld.world.getActor(client.actorId);
  if (body === undefined) throw new Error('no body on the moor');
  body.x = Number(xs) - 1;
  body.y = Number(ys);
  client.send({ t: 'move', dir: 'e' });
  await sleep(300);
  const inside = server.realms.realmOf(client.actorId);
  if (inside === undefined || inside.siteId !== UNDERWORKS) {
    throw new Error(`never went in (${client.errors().join('; ') || 'no error'})`);
  }
  return inside;
}

/** Take a class, so the socket stops owing one. See `dialogue.test.ts`. */
async function chooseAClass(client: Client): Promise<void> {
  const offered = client.latest('class_options')?.['options'];
  const first = Array.isArray(offered) ? (offered[0] as Frame | undefined) : undefined;
  const classId = first?.['id'];
  if (typeof classId !== 'string') throw new Error('the server offered no class');
  client.send({ t: 'choose_class', classId });
  await sleep(200);
}

/**
 * Two partied players on an armed floor, beside the person offering to be
 * walked out of it, with the fight stood down.
 *
 * ═══ THE FLOOR IS EMPTIED, AND AN ESCORT IS WHY IT CAN BE ═══
 * A quarry names a body the floor already had, so `briefquarry.test.ts` has to
 * leave one standing. An escort's subject is the person, so nothing else needs
 * to be there — and an empty floor is what keeps `engagement` at zero, which is
 * what lets a `talk` land at all.
 */
async function twoOnTheFloor(spec: BriefSpec = ESCORT): Promise<{
  lead: Client;
  other: Client;
  realm: Realm;
  offererId: string;
}> {
  const lead = await connect();
  const other = await connect();
  await chooseAClass(lead);
  await chooseAClass(other);

  lead.send({ t: 'party', action: 'invite', targetId: other.actorId });
  await sleep(150);
  other.send({ t: 'party', action: 'accept', targetId: lead.actorId });
  await sleep(200);
  expect(isLeader(server.parties, lead.actorId), 'the inviter did not end up leading').toBe(true);

  const def: SiteDef = { ...site(UNDERWORKS), briefs: [spec] };
  server.realms.open(
    def,
    partyIdOf(server.parties, lead.actorId),
    undefined,
    undefined,
    undefined,
    1,
  );

  const realm = await enterDelve(lead);
  await enterDelve(other);
  expect(server.realms.realmOf(other.actorId)?.id, 'the party split across two floors').toBe(
    realm.id,
  );

  const offererId = realm.brief?.offererId ?? '';
  expect(realm.brief?.state, 'walking in armed nothing').toBe(BriefState.Offered);

  for (const body of realm.world.allActors()) {
    if (body.kind === ActorKind.Monster && body.id !== offererId) realm.world.removeActor(body.id);
  }
  realm.world.turn.engagement = 0;

  standBeside(realm, lead.actorId, offererId);
  standBeside(realm, other.actorId, offererId);
  return { lead, other, realm, offererId };
}

/** Put this body on a free tile next to that one. */
function standBeside(realm: Realm, actorId: string, nextTo: string): void {
  const them = realm.world.getActor(nextTo);
  const me = realm.world.getActor(actorId);
  if (them === undefined || me === undefined) throw new Error('nobody to stand beside');
  const taken = new Set(
    realm.world
      .allActors()
      .filter((a) => a.id !== actorId)
      .map((a) => `${String(a.x)},${String(a.y)}`),
  );
  for (const [dx, dy] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
    [1, 1],
    [-1, -1],
    [1, -1],
    [-1, 1],
  ] as const) {
    const x = them.x + dx;
    const y = them.y + dy;
    if (!canWalk(realm.world.level, x, y) || taken.has(`${String(x)},${String(y)}`)) continue;
    me.x = x;
    me.y = y;
    return;
  }
  throw new Error('nowhere to stand beside them');
}

async function talk(client: Client, whoId: string): Promise<void> {
  client.send({ t: 'talk', targetId: whoId });
  const deadline = Date.now() + FRAME_TIMEOUT_MS;
  while (view(client) === undefined) {
    if (Date.now() >= deadline) {
      throw new Error(`no window came back (${client.errors().join('; ') || 'no error'})`);
    }
    await sleep(10);
  }
}

async function choose(client: Client, nodeId: string, optionId: string): Promise<void> {
  client.send({ t: 'dialogue_choose', nodeId, optionId });
  await sleep(250);
}

function view(client: Client): Frame | undefined {
  const v = client.latest('dialogue')?.['view'];
  return typeof v === 'object' && v !== null ? (v as Frame) : undefined;
}

/** The latest `brief` frame this socket was handed, or undefined. */
function strip(client: Client): Frame | null | undefined {
  const last = client.all('brief').at(-1);
  if (last === undefined) return undefined;
  const brief = last['brief'];
  return brief === null ? null : (brief as Frame);
}

/**
 * Every `ActorView` of one body this socket has been handed, oldest first —
 * out of `state` lists and `joined` frames alike, because the board arrives
 * both ways and the question is what this client currently believes.
 */
function viewsOf(client: Client, actorId: string): Frame[] {
  const out: Frame[] = [];
  for (const frame of [...client.all('state'), ...client.all('joined')]) {
    const one = frame['actor'];
    if (typeof one === 'object' && one !== null && (one as Frame)['id'] === actorId) {
      out.push(one as Frame);
    }
    const many = frame['actors'];
    if (!Array.isArray(many)) continue;
    for (const row of many as Frame[]) if (row['id'] === actorId) out.push(row);
  }
  return out;
}

/** The floor's objective, taken on by the lead. */
async function taken(spec: BriefSpec = ESCORT): Promise<Awaited<ReturnType<typeof twoOnTheFloor>>> {
  const stage = await twoOnTheFloor(spec);
  await talk(stage.lead, stage.offererId);
  await choose(stage.lead, ChatNodeId.Greet, ChatOptionId.BriefTake);
  return stage;
}

/** Spend turns until the floor's objective reaches `want`, or give up. */
async function pumpUntil(realm: Realm, who: Client, want: string): Promise<void> {
  for (const dir of ['n', 's', 'e', 'w', 'n', 's', 'e', 'w']) {
    if (realm.brief?.state === want) return;
    who.send({ t: 'move', dir });
    await sleep(220);
  }
}

// ===========================================================================
// 1. THE ACCEPT — A PERSON BECOMES A COMPANION, AND EVERY SCREEN IS TOLD
// ===========================================================================

describe('taking somebody on', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE FLIP REACHES THE WIRE, AND THIS IS WHY `PROTOCOL_VERSION` MOVED.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `ActorView.faction` travels on the actor view and on nothing else. A
   * `moved` event carries an id; a sweep carries steps; `resyncBoard`'s own
   * note lists the four things that resend a board and a faction flip is not
   * one of them. So without the re-announce in `takeBrief`, every client in the
   * realm goes on holding `faction: 'townsfolk'` for a body the server now
   * treats as a companion — the verb menu keeps offering `Talk to` and the
   * server keeps refusing it.
   *
   * MUTANT: delete the `announceJoined` call. The board is right, the brief is
   * open, the strip is up, and every screen is wrong about whose side the
   * person walking beside them is on.
   */
  it('tells both screens the person changed sides', async () => {
    const stage = await taken();
    expect(stage.realm.brief?.state).toBe(BriefState.Open);

    const walking = stage.realm.world.getActor(stage.offererId);
    expect(walking?.kind).toBe(ActorKind.Monster);
    expect(walking?.kind === ActorKind.Monster ? walking.faction : undefined).toBe('squad');

    for (const client of [stage.lead, stage.other]) {
      const held = viewsOf(client, stage.offererId).at(-1);
      expect(held, `${client.actorId} was never told about the body`).toBeDefined();
      expect(held?.['faction'], 'the client still thinks she lives here').toBe('squad');
    }
  });

  /**
   * AND THE STRIP GOES UP FOR THE WHOLE PARTY, not for whoever answered. The
   * non-lead may not take it on and is in it the moment it is taken.
   */
  it('puts the objective on both strips', async () => {
    const stage = await taken();
    for (const client of [stage.lead, stage.other]) {
      expect(strip(client)).toEqual({ state: BriefState.Open, title: ESCORT.title });
    }
  });
});

// ===========================================================================
// 2. THE CLOSE — THE DOOR, THE PAYMENT, AND THE BODY LEAVING THE BOARD
// ===========================================================================

describe('walking her to the door', () => {
  /**
   * THE WHOLE FEATURE, END TO END, THROUGH THE POST-PUMP SWEEP.
   *
   * Three things have to happen in one pump and each is a different layer:
   * `noteBriefProgress` closes it, `payBrief` pays the party that holds the
   * floor, and the body is taken off the board WITH A FRAME THAT SAYS SO —
   * `client/main.ts` forbids inferring an actor's removal from its absence.
   *
   * MUTANT: drop the `announceLeft` in `noteBrief`. The companion is gone from
   * the server and drawn on every screen for the rest of the floor, standing
   * on the stair the party is trying to take.
   */
  it('closes it, pays the whole party, and takes the body off the board', async () => {
    const stage = await taken();
    const target = stage.realm.brief?.target;
    if (target?.k !== BriefKind.Escort) throw new Error('not an escort');

    // Stand her at the way out with both of them in sight of it — which is
    // where a floor of following puts her, and is not what this case is about.
    const walking = stage.realm.world.getActor(stage.offererId);
    if (walking === undefined) throw new Error('no companion');
    walking.x = target.at.x;
    walking.y = target.at.y;
    standBeside(stage.realm, stage.lead.actorId, stage.offererId);
    standBeside(stage.realm, stage.other.actorId, stage.offererId);

    await pumpUntil(stage.realm, stage.lead, BriefState.Closed);

    expect(stage.realm.brief?.state, stage.lead.errors().join('; ')).toBe(BriefState.Closed);
    expect(stage.realm.world.getActor(stage.offererId), 'the body stayed').toBeUndefined();

    for (const client of [stage.lead, stage.other]) {
      const body = server.realms.realmOf(client.actorId)?.world.getActor(client.actorId);
      expect(body?.kind === ActorKind.Player ? body.xp : 0, 'nobody was paid').toBeGreaterThan(0);
      expect(client.lines(), 'the party was not told').toContain(`Done: ${ESCORT.title}.`);
      expect(strip(client)).toEqual({ state: BriefState.Closed, title: ESCORT.title });
    }
    const left = stage.lead.all('left').map((f) => f['id']);
    expect(left, 'the board was never told the body went').toContain(stage.offererId);
  });

  /**
   * AND SHE HAS TO BE AT THE DOOR. A party that takes it on, runs ahead and
   * leaves her where she was standing has not finished anything.
   *
   * MUTANT: close on the companion being alive. The objective pays out on the
   * first pump after the accept, from across the floor.
   */
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * AND THE MEMBER WHO WALKED OUT FIRST IS PAID TOO, WHEREVER THEY ARE.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * A BRIEF IS A PARTY CONTRACT, NOT A FLOOR EVENT — the design's F.1 — and
   * `after: 'leaves'` ends the objective AT THE DOOR, which is precisely where
   * a party files out one at a time. So the commonest possible shape of the
   * shipped configuration is exactly this one: somebody is already through.
   *
   * TWO RULES ARE UNDER TEST AND THEY ARE DIFFERENT LAYERS:
   *
   *   THE COMPANION IS RE-HOMED. `world/brief.ts#keepAnchor`, and upstream's
   *     `Game.lua:1282-1283`. Without it the half that stayed walks to the way
   *     out beside a body that took its last step when the lead left.
   *   THE PAYOUT RESOLVES ACROSS REALMS. `payParty` took a `World` and looked
   *     everybody up in it; the lead is in another one. MEASURED before the
   *     fix: the mate levelled, the lead's `xp` did not move at all, and the
   *     lead's Case Log read *"Done: …"* about work they were paid nothing for.
   *
   * MUTANT (either): re-point on distance instead of absence; or resolve
   * recipients through `realm.world` again. The first strands her, the second
   * tells somebody they finished and hands them nothing.
   */
  it('pays the member who left first, and follows the one who stayed', async () => {
    const stage = await taken();
    const target = stage.realm.brief?.target;
    if (target?.k !== BriefKind.Escort) throw new Error('not an escort');

    const xpOf = (client: Client): number => {
      const body = server.realms.realmOf(client.actorId)?.world.getActor(client.actorId);
      return body?.kind === ActorKind.Player ? body.xp : -1;
    };
    const leadBefore = xpOf(stage.lead);

    // ═══ THE LEAD — WHO ACCEPTED IT — GOES FIRST ═══
    await leaveByThreshold(stage.realm, stage.lead);
    expect(stage.realm.brief?.state, 'one member leaving ended it').toBe(BriefState.Open);
    expect(server.realms.realmOf(stage.lead.actorId)?.id, 'the lead never left the floor').not.toBe(
      stage.realm.id,
    );

    // AND THE LEASH MOVES TO THE ONE STILL STANDING ON IT.
    const walking = stage.realm.world.getActor(stage.offererId);
    if (walking?.kind !== ActorKind.Monster) throw new Error('no companion');
    await pumpUntil(stage.realm, stage.other, BriefState.Closed);
    expect(walking.anchorId, 'she is still waiting for somebody who left').toBe(
      stage.other.actorId,
    );

    // Now the one who stayed walks her the last few tiles.
    walking.x = target.at.x;
    walking.y = target.at.y;
    standBeside(stage.realm, stage.other.actorId, stage.offererId);
    await pumpUntil(stage.realm, stage.other, BriefState.Closed);

    expect(stage.realm.brief?.state, stage.other.errors().join('; ')).toBe(BriefState.Closed);
    expect(xpOf(stage.other), 'the one who did the walking').toBeGreaterThan(0);
    expect(xpOf(stage.lead), 'the one who agreed to it, paid nothing').toBeGreaterThan(leadBefore);
    for (const client of [stage.lead, stage.other]) {
      expect(client.lines(), 'the party was not told').toContain(`Done: ${ESCORT.title}.`);
    }
  });

  it('does not close while she is still standing where you met her', async () => {
    const stage = await taken();
    const target = stage.realm.brief?.target;
    if (target?.k !== BriefKind.Escort) throw new Error('not an escort');
    const walking = stage.realm.world.getActor(stage.offererId);
    if (walking === undefined) throw new Error('no companion');
    expect(
      chebyshev(walking, target.at),
      'the fixture stood her at the door by accident',
    ).toBeGreaterThan(2);

    await pumpUntil(stage.realm, stage.lead, BriefState.Closed);

    expect(stage.realm.brief?.state).toBe(BriefState.Open);
    expect(stage.lead.lines()).not.toContain(`Done: ${ESCORT.title}.`);
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * AND WHEN SHE GOES DOWN, THE PARTY IS TOLD IN ONE LINE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ONE LINE, AND NO SECOND SENTENCE. The failure never blames the party,
 * because the second sentence is where blame lives — the same rule the decline
 * follows. The strip carries the true state and stops being an objective; the
 * Case Log carries what happened.
 *
 * MUTANT: pay on a failure as well (reuse the `Done:` arm for both states). The
 * party is paid for a body they lost, and the strip says they finished it.
 */
describe('losing her', () => {
  it('fails it in the pump she falls in, and says so once', async () => {
    const stage = await taken();
    const walking = stage.realm.world.getActor(stage.offererId);
    if (walking === undefined) throw new Error('no companion');
    const paid = server.realms.realmOf(stage.lead.actorId)?.world.getActor(stage.lead.actorId);
    const before = paid?.kind === ActorKind.Player ? paid.xp : 0;

    walking.hp = 0;
    walking.alive = false;

    await pumpUntil(stage.realm, stage.lead, BriefState.Failed);

    expect(stage.realm.brief?.state, stage.lead.errors().join('; ')).toBe(BriefState.Failed);
    for (const client of [stage.lead, stage.other]) {
      const lines = client.lines().filter((line) => line === `Lost: ${ESCORT.title}.`);
      expect(lines, 'the party was not told, or was told twice').toHaveLength(1);
      expect(client.lines()).not.toContain(`Done: ${ESCORT.title}.`);
      expect(strip(client)).toEqual({ state: BriefState.Failed, title: ESCORT.title });
    }
    const after = server.realms.realmOf(stage.lead.actorId)?.world.getActor(stage.lead.actorId);
    expect(after?.kind === ActorKind.Player ? after.xp : 0, 'paid for a body they lost').toBe(
      before,
    );
  });
});

// ===========================================================================
// 3. LEAVING WITHOUT HER
// ===========================================================================

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * AND THE OTHER CONFIGURATION: SHE STAYS, AND STOPS BEING YOURS.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `after: 'stays'` is BUILT AND DRIVEN AND NOT AUTHORED ONTO ANY FLOOR (the
 * design's Phase 4, step 16), which is exactly why it needs a socket case: the
 * half of it that only a client can see is the one nothing else would catch.
 *
 * `landCompanion` puts the body back to `Townsfolk` — not a flourish. Leave it
 * `Squad` with an anchor and the follow rule walks her straight back out of the
 * place the party just walked her to, and every husk on the floor still wants
 * her dead. But the FACTION TRAVELS ON THE ACTOR VIEW AND ON NOTHING ELSE, so
 * without the re-announce every screen goes on holding `squad` for somebody the
 * server has handed back to the floor — and the verb menu goes on refusing
 * `Talk to` about a person standing in front of them.
 *
 * MUTANT: `else if (false) announceJoined(...)` in `noteBrief`. The server is
 * right, the objective closes, the payment lands, and every client is wrong
 * about whose side she is on for the rest of the floor.
 */
describe('leaving her where she wanted to be', () => {
  const ERRAND: BriefSpec = { ...ESCORT, escort: { after: 'stays', body: STRANDED_HAND } };

  it('stands her down to the floor, and tells both screens so', async () => {
    const stage = await taken(ERRAND);
    const target = stage.realm.brief?.target;
    if (target?.k !== BriefKind.Escort) throw new Error('not an escort');
    expect(target.after, 'the fixture is the walk-out').toBe('stays');

    // Both screens are told she is yours when it is taken on — the precondition
    // for the assertion that they are told again when she stops being.
    for (const client of [stage.lead, stage.other]) {
      expect(viewsOf(client, stage.offererId).at(-1)?.['faction']).toBe('squad');
    }

    const walking = stage.realm.world.getActor(stage.offererId);
    if (walking === undefined) throw new Error('no companion');
    walking.x = target.at.x;
    walking.y = target.at.y;
    standBeside(stage.realm, stage.lead.actorId, stage.offererId);
    standBeside(stage.realm, stage.other.actorId, stage.offererId);

    await pumpUntil(stage.realm, stage.lead, BriefState.Closed);
    expect(stage.realm.brief?.state, stage.lead.errors().join('; ')).toBe(BriefState.Closed);

    // THE BODY STAYS. That is the whole of the configuration: the party walks
    // back to the stair unescorted.
    const after = stage.realm.world.getActor(stage.offererId);
    expect(after, 'she was reaped like a walk-out').toBeDefined();
    expect(after?.kind === ActorKind.Monster ? after.faction : undefined).toBe('townsfolk');
    expect(after?.kind === ActorKind.Monster ? after.anchorId : 'still held').toBeUndefined();

    for (const client of [stage.lead, stage.other]) {
      expect(
        viewsOf(client, stage.offererId).at(-1)?.['faction'],
        'the client still thinks she is walking with them',
      ).toBe('townsfolk');
      expect(client.lines()).toContain(`Done: ${ESCORT.title}.`);
    }
  });
});

describe('the floor`s edge', () => {
  /**
   * ONE LINE, TO THE WHOLE PARTY, AT THE MOMENT THE LAST OF THEM LEAVES. Not a
   * confirm dialog and not a second sentence: the game must not make abandoning
   * a moral event, and the second sentence is where blame lives.
   *
   * MUTANT: fail the brief when the FIRST member leaves. A party that splits up
   * — which the barrier already tolerates — loses an objective the other half
   * is still working on.
   */
  it('fails it when the last of them walks out, and not when the first does', async () => {
    const stage = await taken();

    await leaveByThreshold(stage.realm, stage.lead);
    expect(stage.realm.brief?.state, 'one member leaving ended it').toBe(BriefState.Open);
    expect(stage.lead.lines()).not.toContain(`Left behind: ${ESCORT.title}.`);

    await leaveByThreshold(stage.realm, stage.other);
    expect(stage.realm.brief, 'the floor kept its objective').toBeUndefined();
    for (const client of [stage.lead, stage.other]) {
      expect(client.lines(), 'nobody was told').toContain(`Left behind: ${ESCORT.title}.`);
      expect(strip(client)).toBeNull();
    }
  });
});

/** Stand on the threshold, step off it and back on: what LEAVING is. */
async function leaveByThreshold(realm: Realm, client: Client): Promise<void> {
  const body = realm.world.getActor(client.actorId);
  if (body === undefined) throw new Error('no body');
  const onThreshold = (x: number, y: number): boolean =>
    realm.spawns.some((t) => t.x === x && t.y === y);
  const steps = [
    { dir: 'e', dx: 1, dy: 0, back: 'w' },
    { dir: 'w', dx: -1, dy: 0, back: 'e' },
    { dir: 's', dx: 0, dy: 1, back: 'n' },
    { dir: 'n', dx: 0, dy: -1, back: 's' },
  ] as const;
  for (const tile of realm.spawns) {
    const sitting = realm.world.actorAt(tile.x, tile.y);
    if (sitting !== undefined && sitting.id !== body.id) continue;
    for (const step of steps) {
      const x = tile.x + step.dx;
      const y = tile.y + step.dy;
      if (onThreshold(x, y) || !canWalk(realm.world.level, x, y)) continue;
      if (realm.world.actorAt(x, y) !== undefined) continue;
      body.x = tile.x;
      body.y = tile.y;
      client.send({ t: 'move', dir: step.dir });
      await sleep(250);
      client.send({ t: 'move', dir: step.back });
      await sleep(300);
      return;
    }
  }
  throw new Error('no threshold tile has open ground beside it');
}
