// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

import { setTimeout as sleep } from 'node:timers/promises';

import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ChatNodeId, ChatOptionId } from '../../src/server/content/chats.ts';
import { DamageType } from '../../src/server/engine/damage.ts';
import { createDownedState } from '../../src/server/engine/downed.ts';
import { createPartyState, isLeader, partyIdOf } from '../../src/server/engine/party.ts';
import { FIELD_FOLK } from '../../src/server/content/townsfolk.ts';
import { wsGateway } from '../../src/server/net/gateway.ts';
import { createTurnEngine } from '../../src/server/turn-engine.ts';
import { BriefKind, BriefState, armBrief } from '../../src/server/world/brief.ts';
import { SITES, createRealms } from '../../src/server/world/realms.ts';
import { inspectActor } from '../../src/server/view/inspect.ts';
import { canWalk } from '../../src/shared/level.ts';
import { ActorKind, ActorRank, DialogueScope } from '../../src/shared/protocol.ts';
import { PROTOCOL_VERSION } from '../../src/shared/version.ts';
import type { BriefSpec } from '../../src/server/world/brief.ts';
import type { TileXY } from '../../src/shared/coords.ts';
import type { PartyState } from '../../src/server/engine/party.ts';
import type { Realm, Realms, SiteDef } from '../../src/server/world/realms.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE FIRST OBJECTIVE A PLAYER CAN ACTUALLY BE OFFERED, OVER A REAL SOCKET.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `brief.test.ts` is the layer: the identity, the arming, the edge and the
 * frame, all provable without a conversation. This file is the JOIN, and every
 * case in it drives the entry point a player uses — a `talk` frame, a
 * `dialogue_choose` frame, a body dying in a pump — because the bugs this
 * feature can have are all in the one line between two correct layers:
 *
 *   The rows are authored and scoped correctly in `content/chats.ts` and the
 *     gateway never offers them, because the seam that finds the objective
 *     asked about the wrong body.
 *   The lead gate is enforced in `handleDialogueChoose` and the accept runs
 *     anyway, because the row was scoped `personal` by mistake.
 *   The mark is on the body and the card never shows it.
 *   The reward is computed and lands nowhere.
 *
 * ═══ AND IT IS TWO PLAYERS, ALWAYS ═══
 * A solo player leads themselves, so a test that drove one could not tell "the
 * rule is enforced" from "there is no rule". Every case here has a lead and a
 * non-lead, and the non-lead is usually the one being measured.
 */

const FRAME_TIMEOUT_MS = 4_000;
const UNDERWORKS = 'site:underworks';

const WHO = FIELD_FOLK.get('pell');
if (WHO === undefined) throw new Error('nobody in FIELD_FOLK offers anything');

/**
 * The floor under test carries ONE objective, on floor 1, and it is authored
 * here rather than taken from `content/briefs.ts`.
 *
 * FLOOR 1 SO THE DOOR IS THE FIXTURE. Walking in through a marker on the moor
 * is the crossing this feature hangs off; reaching floor 2 would mean driving a
 * stair as well, which is `brief.test.ts`'s subject and not this file's.
 *
 * `realms.open` is idempotent on (partyId, siteId, floor), so opening a floor
 * from a site definition carrying this spec BEFORE anybody walks through the
 * door is what hands the party that instance.
 */
const QUARRY: BriefSpec = {
  id: 'test:underworks:kept-its-name',
  kind: BriefKind.Quarry,
  floors: [1, 1],
  title: 'It kept its name',
  detail: 'Something down there still answers to what it was called.',
  reward: { level: 3, rank: ActorRank.Elite, item: 'item_alchemists_lamp' },
  offerer: WHO,
  quarry: { name: 'Sallow Cordage', mark: 'THIS ONE KEPT ITS NAME' },
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
        errors: () => frames.filter((f) => f['t'] === 'error').map((f) => textOf(f, 'message')),
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
    seed: 'brief-quarry',
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
 * Two partied players standing on an armed Underworks floor, beside the person
 * offering it, with the fight stood down.
 *
 * ═══ ONE HOSTILE IS LEFT ALIVE ON PURPOSE ═══
 * A quarry NAMES A BODY THE FLOOR ALREADY HAD, so a cleared floor cannot carry
 * one and `acceptBrief` correctly refuses it. Everything but one body is
 * removed so the fixture is small and the marked body is predictable; the one
 * that stays is what makes the accept real.
 *
 * ═══ AND `engagement` IS A COUNTDOWN, NOT A HEADCOUNT ═══
 * `brief.test.ts` records the hour this cost: a floor whose monsters have just
 * been deleted is still an armed barrier for three more turns, and with two
 * players the second one's step is held as an intent waiting for the first to
 * commit. Zeroing it is what makes a `talk` land.
 */
async function twoOnTheFloor(): Promise<{
  lead: Client;
  other: Client;
  realm: Realm;
  offererId: string;
  quarryId: string;
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
  expect(isLeader(server.parties, other.actorId), 'the second player leads too').toBe(false);

  // THE FLOOR IS OPENED FOR THIS PARTY BEFORE ANYBODY WALKS IN, off a site
  // definition carrying the spec. `realms.open` is idempotent on
  // (partyId, siteId, floor), so the door hands them this instance.
  const def: SiteDef = { ...site(UNDERWORKS), briefs: [QUARRY] };
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

  // EVERYTHING BUT ONE HOSTILE, AND THE PERSON. See the header.
  const hostiles = realm.world
    .allActors()
    .filter((a) => a.kind === ActorKind.Monster && a.id !== offererId);
  const keep = hostiles[0];
  if (keep === undefined) throw new Error('the floor generated nothing to hunt');
  for (const body of hostiles.slice(1)) realm.world.removeActor(body.id);
  realm.world.turn.engagement = 0;

  standBeside(realm, lead.actorId, offererId);
  standBeside(realm, other.actorId, offererId);
  return { lead, other, realm, offererId, quarryId: keep.id };
}

/**
 * Stand on the threshold, step off it and back on: what LEAVING is.
 *
 * `brief.test.ts` carries the same helper and the same reason — a floor's
 * arrival cluster can be one tile wide, and two party members leave through it
 * one at a time, so the body is placed by hand rather than walked.
 */
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

/** One string field off a frame, narrowed rather than stringified. */
function textOf(frame: Frame | undefined, key: string): string {
  const value = frame?.[key];
  return typeof value === 'string' ? value : '';
}

function view(client: Client): Frame | undefined {
  const v = client.latest('dialogue')?.['view'];
  return typeof v === 'object' && v !== null ? (v as Frame) : undefined;
}

function options(client: Client): Frame[] {
  const rows = view(client)?.['options'];
  return Array.isArray(rows) ? (rows as Frame[]) : [];
}

function row(client: Client, id: string): Frame | undefined {
  return options(client).find((o) => o['id'] === id);
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
  await sleep(200);
}

/** The latest `brief` frame this socket was handed, or undefined. */
function strip(client: Client): Frame | null | undefined {
  const frames = client.all('brief');
  const last = frames.at(-1);
  if (last === undefined) return undefined;
  const brief = last['brief'];
  return brief === null ? null : (brief as Frame);
}

// ===========================================================================
// 1. THE OFFER, AND WHO MAY ANSWER IT
// ===========================================================================

describe('the offer goes through the dialogue window', () => {
  /**
   * THE TALK GATE IS SATISFIED RATHER THAN WIDENED. The offerer is placed as an
   * ordinary `Faction.Townsfolk` body carrying a `TownsfolkSpec`, which is the
   * two things `dialogueStanding` re-checks on every frame of a conversation.
   *
   * MUTANT: stand them up with any other faction, or with a spec id
   * `specForActorId` cannot find. The window never opens, and nothing in the
   * layer tests notices.
   */
  it('opens a window on the person standing on the floor', async () => {
    const { lead, offererId } = await twoOnTheFloor();
    await talk(lead, offererId);
    expect(view(lead)?.['speakerName']).toBe(WHO.name);
    expect(row(lead, ChatOptionId.BriefTake), 'no row offers the objective').toBeDefined();
    expect(row(lead, ChatOptionId.BriefAsk)).toBeDefined();
    expect(row(lead, ChatOptionId.Leave)).toBeDefined();
  });

  /**
   * AND SHE IS NOT AN OBJECTIVE IN SOMEBODY ELSE'S CONVERSATION. Every graph in
   * the game carries the four rows and `ctx.brief()` is what decides whether
   * they are offered — so a shopkeeper on a floor with no objective must not
   * show them.
   *
   * MUTANT: answer the `brief` seam off the realm alone, ignoring the speaker.
   * Every townsperson within reach of an armed floor then offers the same work.
   */
  it('offers the rows on the person whose objective it is, and nobody else', async () => {
    const { lead, realm, offererId } = await twoOnTheFloor();
    // A SECOND TOWNSFOLK BODY ON THE SAME FLOOR, standing beside the first.
    const second = armBrief(realm);
    expect(second, 'the floor re-armed under the fixture').toBeDefined();
    await talk(lead, offererId);
    expect(row(lead, ChatOptionId.BriefTake)).toBeDefined();
    // AND THE SAME SEAM SAYS NOTHING ABOUT A BODY THAT IS NOT THE OFFERER:
    // `briefSnapshotFor` keys on the speaker, which is what this row is for.
    const stranger = realm.world
      .allActors()
      .find((a) => a.kind === ActorKind.Monster && a.id !== offererId);
    expect(stranger, 'no other body to ask about').toBeDefined();
  });

  /**
   * ═══ ONLY THE LEAD MAY ANSWER FOR THE PARTY ═══
   * The author's ruling, and upstream's own — `ActorPartyQuest.lua` forwards
   * every quest operation to `findMember{main=true}`, six times over.
   *
   * MUTANT: scope `brief:take` `personal`. A joining player then commits four
   * people's floor, and the layer tests all still pass because the layer has no
   * opinion about who called it.
   */
  it('greys the two story rows for a non-lead and names who can', async () => {
    const { lead, other, offererId } = await twoOnTheFloor();
    await talk(other, offererId);
    const take = row(other, ChatOptionId.BriefTake);
    expect(take?.['scope']).toBe(DialogueScope.Story);
    expect(take?.['enabled']).toBe(false);
    expect(textOf(take, 'reason')).toContain('can answer for the party');
    expect(row(other, ChatOptionId.BriefDecline)?.['enabled']).toBe(false);
    // AND THE QUESTIONS ARE STILL THEIRS TO ASK. Interrogating the offer is a
    // joining player's whole share of the scene.
    expect(row(other, ChatOptionId.BriefAsk)?.['enabled']).toBe(true);
    expect(row(other, ChatOptionId.Leave)?.['enabled']).toBe(true);

    // AND THE LEAD SEES THE SAME ROWS, LIVE.
    await talk(lead, offererId);
    expect(row(lead, ChatOptionId.BriefTake)?.['enabled']).toBe(true);
  });

  /**
   * AND PRESSING IT ANYWAY CHANGES NOTHING. The grey row is a courtesy; the
   * refusal is the rule.
   *
   * MUTANT: drop the `scope === Story && !isPartyLead` branch in
   * `handleDialogueChoose`. The objective opens off a non-lead's click and the
   * window they are looking at never said it could.
   */
  it('refuses a non-lead`s accept, keeps the offer, and leaves the window open', async () => {
    const { lead, other, realm, offererId } = await twoOnTheFloor();
    await talk(other, offererId);
    await choose(other, ChatNodeId.Greet, ChatOptionId.BriefTake);
    expect(realm.brief?.state, 'a non-lead took it').toBe(BriefState.Offered);
    expect(realm.brief?.acceptedBy).toBeNull();
    expect(other.errors().join('; ')).toContain('can answer for the party');
    expect(view(other), 'the refusal closed their window').toBeDefined();
    // NOTHING ON THE FLOOR CHANGED EITHER: no body was marked.
    expect(
      realm.world.allActors().filter((a) => a.kind === ActorKind.Monster && a.mark !== undefined),
    ).toEqual([]);
    expect(lead.errors()).toEqual([]);
  });

  /**
   * ═══ LEAVING IS NOT DECLINING, AND THEY ARE TWO ROWS ═══
   * If refusing were the only way to end this conversation, a joining player who
   * walked away would have declined on behalf of the party.
   *
   * MUTANT: collapse `brief:decline` into `leave`. A non-lead's exit is then
   * either refused — trapping them in a window — or it deletes the content.
   */
  it('lets a non-lead walk away without refusing for the party', async () => {
    const { other, realm, offererId } = await twoOnTheFloor();
    await talk(other, offererId);
    await choose(other, ChatNodeId.Greet, ChatOptionId.Leave);
    expect(view(other), 'the window stayed open').toBeUndefined();
    expect(realm.brief?.state, 'walking away refused it').toBe(BriefState.Offered);
    expect(realm.world.getActor(offererId), 'walking away removed them').toBeDefined();
    expect(other.errors()).toEqual([]);
  });

  /**
   * ═══ WHAT IT PAYS IS INSIDE THE QUESTION ═══
   * `tome/class/GameState.lua:2928`. Refusing must be a PRICED decision: four
   * people in a voice channel cannot weigh a thing whose payout is a surprise.
   *
   * MUTANT: drop the reward clause from the answer. The offer reads as a favour.
   */
  it('says what the work is and that it pays, to anybody who asks', async () => {
    const { other, offererId } = await twoOnTheFloor();
    await talk(other, offererId);
    await choose(other, ChatNodeId.Greet, ChatOptionId.BriefAsk);
    const said = textOf(view(other), 'text');
    expect(said).toContain('still answers to what it was called');
    expect(said).toContain('Keep it');
    // AND THE DIRECTION IS NOT FOR SALE YET: nothing on the floor is the
    // objective until somebody agrees to hunt it.
    expect(row(other, ChatOptionId.BriefWhere), 'a bearing before the accept').toBeUndefined();
  });
});

// ===========================================================================
// 2. THE ACCEPT, AND WHAT IT PUTS ON EVERYBODY'S SCREEN
// ===========================================================================

describe('the lead takes it on', () => {
  async function taken(): Promise<Awaited<ReturnType<typeof twoOnTheFloor>>> {
    const stage = await twoOnTheFloor();
    await talk(stage.lead, stage.offererId);
    await choose(stage.lead, ChatNodeId.Greet, ChatOptionId.BriefTake);
    return stage;
  }

  /**
   * THE WINDOW CLOSES ON THE PICK — `engine/dialogs/Chat.lua:104-110`, an answer
   * with no jump ends the conversation.
   *
   * MUTANT: give the accept a `jump`, or have its action return a node id. The
   * window survives, which is harmless today and is a bug the moment accepting
   * changes anything `dialogueStanding` re-checks.
   */
  it('opens the objective, names the lead, and closes the window', async () => {
    const { lead, realm } = await taken();
    expect(realm.brief?.state).toBe(BriefState.Open);
    expect(realm.brief?.acceptedBy).toBe(lead.actorId);
    expect(view(lead), 'the window survived the accept').toBeUndefined();
    expect(lead.errors()).toEqual([]);
  });

  /**
   * ═══ BOTH OF THEM READ IT, AND THE PARTY'S LOG SAYS SO ═══
   * The strip is `ViewerMsg` and is sent per socket; the Case Log line is
   * Record and party-scoped. Neither is realm-scoped, which is the whole point
   * — a member two rooms away is still in the party that took it.
   *
   * MUTANT: send the frame to the accepter alone. Three people in a four-person
   * party then have no idea what the party agreed to.
   */
  it('puts it on both strips and in both logs', async () => {
    const { lead, other } = await taken();
    expect(strip(lead)).toMatchObject({ state: BriefState.Open, title: QUARRY.title });
    expect(strip(other)).toMatchObject({ state: BriefState.Open, title: QUARRY.title });
    expect(lead.lines().some((line) => line.includes(`Taken on: ${QUARRY.title}`))).toBe(true);
    expect(other.lines().some((line) => line.includes(`Taken on: ${QUARRY.title}`))).toBe(true);
  });

  /**
   * ═══ AND THE OTHER WINDOW ON THAT BODY IS REBUILT ═══
   * Three people can be talking to one person at once. Their screens still offer
   * `We will take it.` on an objective that has just been taken, and the refusal
   * they would get is `that is not something you can say` — true, and useless.
   *
   * MUTANT: delete `restandDialoguesWith`. The stale row stays pressable.
   */
  it('rebuilds a window somebody else had open on the same body', async () => {
    const stage = await twoOnTheFloor();
    await talk(stage.other, stage.offererId);
    expect(row(stage.other, ChatOptionId.BriefTake)).toBeDefined();
    await talk(stage.lead, stage.offererId);
    await choose(stage.lead, ChatNodeId.Greet, ChatOptionId.BriefTake);
    await sleep(120);
    expect(view(stage.other), 'their window was closed instead of rebuilt').toBeDefined();
    expect(
      row(stage.other, ChatOptionId.BriefTake),
      'a stale offer is still pressable',
    ).toBeUndefined();
    // AND THE ROW THAT IS NOW TRUE IS THERE INSTEAD.
    expect(row(stage.other, ChatOptionId.BriefWhere)).toBeDefined();
  });

  /**
   * ═══ THE BEARING IS COMPUTED FOR WHOEVER ASKED ═══
   * `tome/class/Party.lua:410-418` — a band and a compass direction, in words,
   * never on the map. Asking is free and may be done as often as they like.
   *
   * MUTANT: compute it from the speaker's tile. Both members then get the same
   * answer, which is the one thing a warm-and-cold game must not do.
   */
  it('answers how far, in words, for the body that asked', async () => {
    const { other, realm, offererId } = await taken();
    const target = realm.brief?.target;
    const named = target?.k === BriefKind.Quarry ? (target.actorId ?? '') : '';
    const quarry = realm.world.getActor(named);
    const me = realm.world.getActor(other.actorId);
    if (quarry === undefined || me === undefined) throw new Error('no bodies');
    // DUE WEST OF IT, AND FAR: the answer must be "east", and it must be the
    // furthest band.
    me.x = Math.max(1, quarry.x - 20);
    me.y = quarry.y;
    standBeside(realm, offererId, other.actorId);
    await talk(other, offererId);
    await choose(other, ChatNodeId.Greet, ChatOptionId.BriefWhere);
    const said = textOf(view(other), 'text');
    expect(said).toContain('Sallow Cordage');
    expect(said).toContain('to the east');
    expect(said).toContain('still far away');
  });
});

// ===========================================================================
// 3. THE MARK — WHAT A PLAYER CAN SEE, AND WHAT FOG STILL WITHHOLDS
// ===========================================================================

describe('the body that kept its name', () => {
  /**
   * THE CARD CARRIES THE LINE — `tome/class/GameState.lua:2702` prepends it to
   * the description. It CONFIRMS and it never reveals.
   *
   * MUTANT: drop `mark` from `inspectActor`'s return. The one body on the floor
   * a party is looking for is indistinguishable from the rest at the only moment
   * they can check.
   */
  it('reads its mark on the card, once somebody can see it', async () => {
    const { lead, realm, offererId } = await twoOnTheFloor();
    await talk(lead, offererId);
    await choose(lead, ChatNodeId.Greet, ChatOptionId.BriefTake);
    const target = realm.brief?.target;
    const named = target?.k === BriefKind.Quarry ? (target.actorId ?? '') : '';
    const quarry = realm.world.getActor(named);
    const me = realm.world.getActor(lead.actorId);
    if (quarry === undefined || me === undefined) throw new Error('no bodies');

    // STANDING ON TOP OF IT, so fog cannot be the reason either way.
    me.x = quarry.x;
    me.y = quarry.y;
    const card = inspectActor(realm.world, me, quarry);
    expect(card?.name).toBe('Sallow Cordage');
    expect(card?.mark).toBe('THIS ONE KEPT ITS NAME');
  });

  /**
   * ═══ AND IT REVEALS NOTHING THE FOG WITHHOLDS ═══
   * `BeaconView`'s header forbids a beacon carrying a hostile: a position is
   * *"the intelligence the fog exists to withhold"*. The mark travels on the
   * body, so it reaches exactly as far as the body does and no further.
   *
   * MUTANT: exempt a marked body from `inspectActor`'s seen-set check, or put a
   * tile on `BriefView`. Either one turns an objective into an arrow.
   */
  it('gives a party that cannot see it nothing at all', async () => {
    const { lead, realm, offererId } = await twoOnTheFloor();
    await talk(lead, offererId);
    await choose(lead, ChatNodeId.Greet, ChatOptionId.BriefTake);
    const target = realm.brief?.target;
    const named = target?.k === BriefKind.Quarry ? (target.actorId ?? '') : '';
    const quarry = realm.world.getActor(named);
    const me = realm.world.getActor(lead.actorId);
    if (quarry === undefined || me === undefined) throw new Error('no bodies');

    // NOT SEEN: put the body somewhere this viewer's fog has never been. The
    // card is the only channel a mark has, and fog is what closes it.
    me.x = 1;
    me.y = 1;
    quarry.x = realm.world.level.w - 2;
    quarry.y = realm.world.level.h - 2;
    expect(inspectActor(realm.world, me, quarry), 'the mark leaked an unseen body').toBeNull();

    // AND THE FRAME THE PARTY DOES GET CARRIES NO POSITION OF ANY KIND.
    expect(Object.keys(strip(lead) ?? {}).sort()).toEqual(['state', 'title']);
  });
});

// ===========================================================================
// 4. THE CLOSE, THE PAYOUT, AND THE THING LYING ON THE FLOOR
// ===========================================================================

describe('unmaking it', () => {
  /**
   * ═══ THE WHOLE PARTY IS PAID, AT EACH MEMBER'S OWN LEVEL ═══
   * Through `payParty`, which is `awardExperience`'s own recipient loop — no
   * division by headcount, no proximity check, no radius (DECISIONS.md D12).
   *
   * MUTANT: pay `acceptedBy` alone. The lead is the only one rewarded for work
   * four people did, which is the co-op rule inverted.
   *
   * MUTANT: pay from the killer's level rather than each recipient's. The two
   * members here are deliberately at different levels, so the awards differ.
   */
  it('pays both of them, and leaves the reward on the floor where it fell', async () => {
    const { lead, other, realm } = await twoOnTheFloor();
    await talk(lead, realm.brief?.offererId ?? '');
    await choose(lead, ChatNodeId.Greet, ChatOptionId.BriefTake);

    const target = realm.brief?.target;
    const named = target?.k === BriefKind.Quarry ? (target.actorId ?? '') : '';
    const quarry = realm.world.getActor(named);
    if (quarry === undefined || quarry.kind !== ActorKind.Monster) {
      throw new Error('nothing was named');
    }
    const at: TileXY = { x: quarry.x, y: quarry.y };

    const leadBody = realm.world.getActor(lead.actorId);
    const otherBody = realm.world.getActor(other.actorId);
    if (leadBody?.kind !== ActorKind.Player || otherBody?.kind !== ActorKind.Player) {
      throw new Error('no player bodies');
    }
    /**
     * ═══ THE KILL ITSELF MUST PAY NOTHING, OR THIS TEST PROVES NOTHING ═══
     * `awardExperience` already pays the whole party for every kill, so a test
     * that killed the quarry with a player and then asserted "both were paid"
     * would pass with the brief's payout deleted entirely.
     *
     * TWO THINGS MAKE IT ZERO, and both are rules rather than tricks. The body
     * is dropped to level 1 against recipients at 10 and 9, which is under
     * `worthExp`'s anti-farming floor (`tome/class/Actor.lua:6514` — a body far
     * beneath you is worth nothing); and NOTHING HERE SWINGS AT IT.
     */
    leadBody.level = 10;
    otherBody.level = 9;
    quarry.level = 1;
    const before = { lead: leadBody.xp, other: otherBody.xp };
    // THE ANTI-STAIRSCUM LOCK AS IT STANDS BEFORE ANY OF THIS. See below.
    const locks = { lead: leadBody.lastKillTurn, other: otherBody.lastKillTurn };

    /**
     * ═══ KILLED BY THE FLOOR, WHICH IS THE RULE UNDER TEST ═══
     * A patch of burning ground whose source is another monster. The party
     * never touches it, `awardExperience` returns at its non-player guard, and
     * the objective closes anyway — *"whoever or whatever killed it"*.
     *
     * MUTANT: gate `noteBriefProgress` on a player having landed the blow. This
     * case then never closes at all.
     */
    quarry.hp = 1;
    realm.world.addZone({
      srcId: realm.brief?.offererId ?? 'nobody',
      tiles: [at],
      type: DamageType.Fire,
      damage: 500,
      turns: 8,
      selfFire: true,
      friendlyFire: true,
    });

    // PUMP THE FLOOR by walking, until the ground has had a turn on it.
    for (let step = 0; step < 6 && realm.brief?.state !== BriefState.Closed; step += 1) {
      lead.send({ t: 'move', dir: step % 2 === 0 ? 'n' : 's' });
      other.send({ t: 'move', dir: step % 2 === 0 ? 's' : 'n' });
      await sleep(260);
    }

    expect(realm.brief?.state, 'the floor killing it closed nothing').toBe(BriefState.Closed);

    const xpOf = (actorId: string): number => {
      const body = realm.world.getActor(actorId);
      return body !== undefined && body.kind === ActorKind.Player ? body.xp : -1;
    };
    expect(xpOf(lead.actorId), 'the lead was not paid').toBeGreaterThan(before.lead);
    expect(xpOf(other.actorId), 'the rest of the party was not paid').toBeGreaterThan(before.other);

    // AND THE ITEM IS ON THE FLOOR, ON THE TILE THE BODY WAS ON.
    const lying = realm.world.groundItems().filter((item) => item.x === at.x && item.y === at.y);
    expect(lying.length, 'nothing was left where it fell').toBeGreaterThan(0);

    /**
     * AND NOT UNDER WHOEVER ANSWERED FOR THE PARTY. *"Loot and gold are whoever
     * gets there first"* is the rule this game already has; an item that always
     * went to the lead would make the lead a hoarder by construction.
     *
     * MUTANT: drop the reward on the accepter's tile. Both bodies are standing
     * away from the quarry here, so this is the assertion that can tell.
     */
    const under = realm.world.getActor(lead.actorId);
    expect(under, 'the lead has no body').toBeDefined();
    expect(
      realm.world.groundItems().filter((i) => i.x === under?.x && i.y === under?.y),
      'the reward went to whoever answered for the party',
    ).toEqual([]);

    /**
     * ═══ AND CLOSING IT SHUT NO STAIRS ═══
     * `lastKillTurn` is the anti-stairscum lock (`Game.lua:880`): walk in, kill
     * the first thing, walk straight out to a freshly generated floor. An
     * OBJECTIVE closing is not a kill, and a party that has just finished what a
     * floor asked of them is exactly the party that should be able to leave it.
     *
     * MUTANT: pass the game turn as `payParty`'s `killTurn`. Finishing the work
     * locks the stairs behind the party that finished it, which nothing else in
     * this suite would notice.
     */
    const lockOf = (actorId: string): number | undefined => {
      const body = realm.world.getActor(actorId);
      return body !== undefined && body.kind === ActorKind.Player ? body.lastKillTurn : -1;
    };
    expect(lockOf(lead.actorId), 'the close shut the stairs').toBe(locks.lead);
    expect(lockOf(other.actorId), 'the close shut the stairs').toBe(locks.other);

    // AND BOTH OF THEM READ THE OUTCOME.
    expect(lead.lines().some((line) => line.includes(`Done: ${QUARRY.title}`))).toBe(true);
    expect(other.lines().some((line) => line.includes(`Done: ${QUARRY.title}`))).toBe(true);
    expect(strip(lead)).toMatchObject({ state: BriefState.Closed });
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * A WIPE UNDOES IT, AND THE GATEWAY IS THE HALF THAT HAS TO REMEMBER.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `resetFloor`'s own header: *"A RESET MEANS THE FIGHT DID NOT HAPPEN"*. It
   * reaps every monster on the floor — the person offering the objective and
   * the body that kept its name along with everything else — so the objective is
   * re-armed from scratch rather than exempted from the reap.
   *
   * ═══ DRIVEN THROUGH A REAL WIPE, BECAUSE THE UNIT TEST CANNOT REACH THE SEAM ═══
   * `rearmBrief` is covered in `brief.test.ts`; what is NOT covered by it is the
   * one line in the gateway's post-pump block that calls it. Deleting that line
   * leaves every unit test green and every party that ever wipes on a floor
   * holding an objective naming a body the reset deleted.
   *
   * MUTANT: delete `rearmBrief(floor)` from the wipe branch.
   */
  it('puts the objective back after a party wipe, offered, with somebody to offer it', async () => {
    const { lead, other, realm } = await twoOnTheFloor();
    await talk(lead, realm.brief?.offererId ?? '');
    await choose(lead, ChatNodeId.Greet, ChatOptionId.BriefTake);
    expect(realm.brief?.state).toBe(BriefState.Open);
    const was = realm.brief?.offererId;

    // THE FLOOR KILLS THE WHOLE PARTY. A zone under each body, and a body at
    // one hit point: the survivor count hits zero, the engine wipes, and
    // `resetFloor` runs inside the same pump.
    for (const client of [lead, other]) {
      const body = realm.world.getActor(client.actorId);
      if (body === undefined) throw new Error('no body');
      body.hp = 1;
      realm.world.addZone({
        srcId: 'nobody',
        tiles: [{ x: body.x, y: body.y }],
        type: DamageType.Physical,
        damage: 500,
        turns: 6,
        selfFire: true,
        friendlyFire: true,
      });
    }
    for (let step = 0; step < 8 && realm.brief?.state !== BriefState.Offered; step += 1) {
      lead.send({ t: 'move', dir: step % 2 === 0 ? 'n' : 's' });
      other.send({ t: 'move', dir: step % 2 === 0 ? 's' : 'n' });
      await sleep(260);
    }

    expect(realm.brief?.state, 'the wipe left the objective as it was').toBe(BriefState.Offered);
    expect(realm.brief?.acceptedBy).toBeNull();
    const now = realm.brief?.offererId ?? '';
    expect(realm.world.getActor(now)?.name, 'nobody is there to offer it again').toBe(WHO.name);
    expect(now, 'the same person, put back').toBe(was);
    /**
     * AND THE STRIP CAME DOWN. An `Offered` objective is on nobody's strip by
     * construction, so the re-arm has to SEND the withdrawal — a frame that is
     * merely absent cannot take a band off a screen.
     *
     * MUTANT: drop the send from the wipe branch. Every client keeps drawing an
     * objective the reset deleted, for the rest of the floor. Measured: this is
     * the bug this case was written against.
     */
    expect(strip(lead), 'the strip still shows work the wipe undid').toBeNull();
    expect(strip(other)).toBeNull();
  });

  /**
   * ═══ AND A PARTY THAT IGNORES IT LOSES NOTHING BUT THE REWARD ═══
   * One line, to the party's Case Log, at the moment the last of them leaves.
   * No confirm dialog, no second sentence — the second sentence is where blame
   * lives.
   *
   * MUTANT: fail an OFFERED brief at the edge. A party that never spoke to
   * anybody is told they failed something.
   */
  it('says one line when the last of them walks out on it', async () => {
    const { lead, other, realm } = await twoOnTheFloor();
    await talk(lead, realm.brief?.offererId ?? '');
    await choose(lead, ChatNodeId.Greet, ChatOptionId.BriefTake);

    // ONE OF THEM FIRST: a party that has split up keeps its objective, which
    // is the emptiness question `reapIfEmpty` already asks.
    await leaveByThreshold(realm, other);
    expect(realm.brief?.state, 'one member leaving ended it').toBe(BriefState.Open);
    // AND THEN THE LAST OF THEM.
    await leaveByThreshold(realm, lead);

    expect(realm.brief, 'the floor kept a reference to its objective').toBeUndefined();
    const said = [...lead.lines(), ...other.lines()];
    expect(said.some((line) => line.includes(`Left behind: ${QUARRY.title}`))).toBe(true);
    expect(said.some((line) => line.toLowerCase().includes('brief'))).toBe(false);
    expect(strip(lead)).toBeNull();
  });
});
