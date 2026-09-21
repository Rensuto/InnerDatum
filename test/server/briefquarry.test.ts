// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

import { setTimeout as sleep } from 'node:timers/promises';

import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ChatNodeId, ChatOptionId } from '../../src/server/content/chats.ts';
import { DamageType } from '../../src/server/engine/damage.ts';
import { createDownedState } from '../../src/server/engine/downed.ts';
import { AiProfile } from '../../src/server/engine/actor.ts';
import { createPartyState, isLeader, partyIdOf } from '../../src/server/engine/party.ts';
import { FIELD_FOLK, TOWNSFOLK, standFolk } from '../../src/server/content/townsfolk.ts';
import { worthExp } from '../../src/shared/progression.ts';
import { wsGateway } from '../../src/server/net/gateway.ts';
import { createTurnEngine } from '../../src/server/turn-engine.ts';
import { BriefKind, BriefState } from '../../src/server/world/brief.ts';
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
 * SOMEBODY ELSE WITH A SPEC, for the case that proves the rows are keyed on the
 * SPEAKER and not on the floor. An ordinary town resident, taken from the table
 * `specForActorId` reads alongside `FIELD_FOLK` — so a body stood up from this
 * passes both of the dialogue window's gates exactly as the offerer does.
 */
const BYSTANDER = TOWNSFOLK.get('site:threadneedle_row')?.[0];
if (BYSTANDER === undefined) throw new Error('no resident to stand up beside the offerer');

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

/**
 * A plus of walkable, unoccupied ground: a centre and its four orthogonal
 * neighbours. What the per-asker bearing case needs to put two people on
 * opposite sides of one speaker with the objective due north of both.
 *
 * `ignore` names bodies that are about to be MOVED onto these cells, so they
 * do not count as occupying the ground they are being taken off.
 */
function plusOfGround(
  realm: Realm,
  ignore: readonly string[],
): { c: TileXY; w: TileXY; e: TileXY; n: TileXY } {
  const skip = new Set(ignore);
  const taken = new Set(
    realm.world
      .allActors()
      .filter((a) => !skip.has(a.id))
      .map((a) => `${String(a.x)},${String(a.y)}`),
  );
  const open = (x: number, y: number): boolean =>
    canWalk(realm.world.level, x, y) &&
    !taken.has(`${String(x)},${String(y)}`) &&
    !realm.sites.has(`${String(x)},${String(y)}`);
  for (let y = 1; y < realm.world.level.h - 1; y += 1) {
    for (let x = 1; x < realm.world.level.w - 1; x += 1) {
      if (!open(x, y) || !open(x - 1, y) || !open(x + 1, y) || !open(x, y - 1)) continue;
      return { c: { x, y }, w: { x: x - 1, y }, e: { x: x + 1, y }, n: { x, y: y - 1 } };
    }
  }
  throw new Error('the floor has no plus of open ground on it');
}

/**
 * The same two players, with the lead having taken it on.
 *
 * AT MODULE SCOPE rather than inside one describe, because three sections need
 * it and a second copy is a second fixture that can drift from this one.
 */
async function taken(): Promise<Awaited<ReturnType<typeof twoOnTheFloor>>> {
  const stage = await twoOnTheFloor();
  await talk(stage.lead, stage.offererId);
  await choose(stage.lead, ChatNodeId.Greet, ChatOptionId.BriefTake);
  return stage;
}

/**
 * Spend turns until the floor's objective reaches `want`, or give up.
 *
 * A BARE `move` IS NOT A PUMP. A step into a wall, into another body or across
 * a barrier that is still waiting on somebody else resolves nothing, so a test
 * that sent one and slept was asserting against whichever of those it happened
 * to get. This walks the four directions in turn, which one of them always is.
 */
async function pumpUntil(realm: Realm, who: Client, want: string): Promise<void> {
  for (const dir of ['n', 's', 'e', 'w', 'n', 's', 'e', 'w']) {
    if (realm.brief?.state === want) return;
    who.send({ t: 'move', dir });
    await sleep(220);
  }
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
    /**
     * ═══ A SECOND REAL TOWNSPERSON, STOOD UP BESIDE THE PLAYER ═══
     * THIS CASE USED TO CALL `armBrief` AND CALL THAT A SECOND BODY. It is not:
     * `armBrief` returns early on an armed floor — `brief.test.ts` proves it —
     * so the "second" was the first, `toBeDefined()` was trivially true, and the
     * only other body it found was a hostile MONSTER that `dialogueStanding`
     * could never open a window on. Nobody was ever asked anything, and the
     * mutant below survived the whole file.
     *
     * `standFolk` is the shipped constructor and `specForActorId` reads both
     * tables, so this body passes the two gates the window is behind exactly as
     * the offerer does. The only difference between them is which one the
     * objective belongs to.
     *
     * MUTANT: answer the `brief` seam off the realm alone, ignoring the speaker
     * — `briefSnapshotFor(full, full.brief?.offererId ?? '', me)`. Every
     * townsperson within reach of an armed floor then offers the same work.
     */
    const me = realm.world.getActor(lead.actorId);
    if (me === undefined) throw new Error('no body on the floor');
    const bystander = standFolk(realm.world, BYSTANDER, { x: me.x, y: me.y });
    const them = realm.world.getActor(bystander);
    expect(them, 'the second person never went down').toBeDefined();
    expect(bystander, 'the fixture stood up the offerer twice').not.toBe(offererId);
    standBeside(realm, lead.actorId, bystander);

    await talk(lead, bystander);
    expect(view(lead)?.['speakerName'], 'the window opened on the wrong body').toBe(BYSTANDER.name);
    for (const id of [
      ChatOptionId.BriefTake,
      ChatOptionId.BriefAsk,
      ChatOptionId.BriefWhere,
      ChatOptionId.BriefDecline,
    ]) {
      expect(row(lead, id), `${id} was offered by somebody it is not about`).toBeUndefined();
    }
    expect(row(lead, ChatOptionId.Leave), 'the window has no way out').toBeDefined();

    // AND THE PERSON IT IS ABOUT STILL OFFERS IT, so this is not a test of a
    // floor that quietly stopped carrying an objective. The window is closed
    // first: `talk` waits for a window to EXIST and one already does, so
    // without this the assertion would read the bystander's frame again.
    lead.send({ t: 'dialogue_close' });
    await sleep(150);
    expect(view(lead), 'the window did not close').toBeUndefined();
    standBeside(realm, lead.actorId, offererId);
    await talk(lead, offererId);
    expect(view(lead)?.['speakerName']).toBe(WHO.name);
    expect(row(lead, ChatOptionId.BriefTake)).toBeDefined();
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
    const { lead, other, realm, offererId } = await taken();
    const target = realm.brief?.target;
    const named = target?.k === BriefKind.Quarry ? (target.actorId ?? '') : '';
    const quarry = realm.world.getActor(named);
    const them = realm.world.getActor(offererId);
    const a = realm.world.getActor(lead.actorId);
    const b = realm.world.getActor(other.actorId);
    if (quarry === undefined || them === undefined || a === undefined || b === undefined) {
      throw new Error('no bodies');
    }
    /**
     * ═══ THE TWO ASKERS ON OPPOSITE SIDES OF THE OFFERER ═══
     * THIS CASE USED TO MOVE THE OFFERER NEXT TO THE ASKER, which made the
     * speaker's tile and the asker's tile agree to within a tile — so computing
     * the bearing from either gave the same word and the named mutant survived.
     *
     * The window is gated on ADJACENCY, so the two askers can never be far
     * apart; the answer therefore has to be made to differ by putting the
     * objective CLOSE, which is the geometry a real party ends up in anyway
     * once they are near it. A plus of walkable ground is found on the floor,
     * the offerer stands at its centre, the askers west and east of them, and
     * the body they are hunting due north.
     *
     * MUTANT: compute the bearing from the SPEAKER's tile rather than the
     * asker's — `briefSnapshotFor(full, them.id, them)`. Both members get one
     * answer, which is the one thing a warm-and-cold game must not do.
     */
    const plus = plusOfGround(realm, [offererId, lead.actorId, other.actorId, named]);
    them.x = plus.c.x;
    them.y = plus.c.y;
    a.x = plus.w.x;
    a.y = plus.w.y;
    b.x = plus.e.x;
    b.y = plus.e.y;
    quarry.x = plus.n.x;
    quarry.y = plus.n.y;

    await talk(lead, offererId);
    await choose(lead, ChatNodeId.Greet, ChatOptionId.BriefWhere);
    const west = textOf(view(lead), 'text');
    await talk(other, offererId);
    await choose(other, ChatNodeId.Greet, ChatOptionId.BriefWhere);
    const east = textOf(view(other), 'text');

    expect(west).toContain('Sallow Cordage');
    expect(east).toContain('Sallow Cordage');
    // THE WHOLE RULE IN ONE LINE: two people, two tiles, two true answers.
    expect(west, 'both askers were given the same bearing').not.toBe(east);
    expect(west).toContain('to the north-east');
    expect(east).toContain('to the north-west');
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
   * THE TWO LEVELS HERE DO NOT SEPARATE THE AWARDS, and the docblock used to
   * claim they did. `worthExp` is a CLIFF rather than a curve — upstream's
   * anti-farming floor (`tome/class/Actor.lua:6514`) pays the full value until
   * the recipient is more than seven levels above the body, and nothing after
   * that — so at 10 and 9 against a level-3 notional corpse both are paid 36.
   * The per-recipient rule is checked by the case below this one, on the only
   * pair of levels that can tell.
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

    /**
     * ═══ AND THE AMOUNT IS THE NOTIONAL CORPSE, TO THE POINT ═══
     * `BriefReward` is a level and a rank fed to `worthExp` exactly as a kill
     * is, which is what makes the payout rescale with the floor without a
     * second table to tune. `toBeGreaterThan` alone said nothing about which
     * body the party was being paid for.
     *
     * MUTANT: pay a bespoke number, or read the rank off the body rather than
     * off the reward. The payout stops tracking the floor.
     */
    const paid = {
      lead: xpOf(lead.actorId) - before.lead,
      other: xpOf(other.actorId) - before.other,
    };
    expect(paid.lead).toBe(worthExp(QUARRY.reward.level, QUARRY.reward.rank, 10));
    expect(paid.other).toBe(worthExp(QUARRY.reward.level, QUARRY.reward.rank, 9));

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
   * ═══════════════════════════════════════════════════════════════════════════
   * EACH RECIPIENT IS MEASURED AGAINST THEIR OWN LEVEL, AND THIS IS THE ONLY
   * PAIR OF LEVELS THAT CAN SHOW IT.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `awardExperience`'s own essay explains why the recipient's level was moved
   * INSIDE the loop, and `payParty` is that loop extracted rather than copied.
   * But `worthExp` is a cliff and not a curve: upstream's anti-farming floor
   * (`tome/class/Actor.lua:6514`) pays the full value until the recipient is
   * more than seven levels above the body and nothing at all after that. So two
   * members at 9 and 10 against a level-3 corpse are paid the same, and every
   * assertion of the form *"they were both paid"* is blind to which level was
   * used.
   *
   * ONE ON EACH SIDE OF THE CLIFF is the case that is not: level 10 is paid, and
   * level 12 — for whom this floor's work is beneath notice — is paid nothing.
   *
   * MUTANT: `worthExp(victimLevel, rank, member.level)` -> a constant recipient
   * level. The deep member is paid for a floor they have outgrown, which is the
   * exact farming upstream's floor exists to stop.
   */
  it('pays each member against their own level, and a deep one not at all', async () => {
    const { lead, other, realm } = await taken();
    const shallow = realm.world.getActor(lead.actorId);
    const deep = realm.world.getActor(other.actorId);
    if (shallow?.kind !== ActorKind.Player || deep?.kind !== ActorKind.Player) {
      throw new Error('no player bodies');
    }
    shallow.level = 10;
    deep.level = 12;
    const target = realm.brief?.target;
    const named = target?.k === BriefKind.Quarry ? (target.actorId ?? '') : '';
    const quarry = realm.world.getActor(named);
    if (quarry === undefined) throw new Error('nothing was named');
    // THE KILL ITSELF PAYS NOTHING TO EITHER OF THEM.
    quarry.level = 1;
    const before = { shallow: shallow.xp, deep: deep.xp };

    quarry.hp = 0;
    quarry.alive = false;
    await pumpUntil(realm, lead, BriefState.Closed);

    expect(realm.brief?.state).toBe(BriefState.Closed);
    expect(shallow.xp - before.shallow).toBe(worthExp(QUARRY.reward.level, QUARRY.reward.rank, 10));
    expect(worthExp(QUARRY.reward.level, QUARRY.reward.rank, 12), 'the cliff moved').toBe(0);
    expect(deep.xp, 'a member far above this floor was paid for it').toBe(before.deep);
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

    /**
     * ═══ AND IT IS UNDER THE ROOM THEY WALKED INTO, NOT ABOVE IT ═══
     * It was written where the objective was CLOSED, which is a line above
     * `removePlayer` and five or six lines above the arrival block
     * `announceArrival` then writes. MEASURED at 640x320 with a two-row Case
     * Log: the moor's arrival lines pushed it clean off the top before anybody
     * could read it — the one line that says the party abandoned what they
     * agreed to, and the one line they could not see.
     *
     * The close still happens first; only the sentence moved. See
     * `sayFloorBriefLeft`.
     *
     * MUTANT: write the line inside `endFloorBrief` again.
     */
    const mine = lead.lines();
    const leftAt = mine.findIndex((line) => line.includes(`Left behind: ${QUARRY.title}`));
    const arrival = mine.map((line, at) => (/ tiles/.test(line) ? at : -1)).filter((at) => at >= 0);
    expect(arrival.length, 'the moor never named what is near it').toBeGreaterThan(0);
    expect(leftAt, 'the failure line was buried by the arrival block').toBeGreaterThan(
      Math.max(...arrival),
    );
    expect(said.some((line) => line.toLowerCase().includes('brief'))).toBe(false);
    expect(strip(lead)).toBeNull();
  });
});

// ===========================================================================
// 6. THE DECLINE, WHICH IS AN ANSWER AND NOT A SILENCE
// ===========================================================================

describe('refusing it', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * *"NOT THIS TIME."* — AND THE PERSON GOES WITH IT.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `tome/class/GameState.lua:2974-2976` removes the encounter on a refusal
   * rather than leaving it standing: an offer you may decline and then walk back
   * to is an offer with no weight, and a person who keeps asking is furniture.
   *
   * THE WHOLE DECLINE LANE WAS UNTESTED AT THE JOIN. `world/brief.ts#declineBrief`
   * had unit cases; nothing anywhere picked the row as the lead. Two mutants
   * survived every test this feature had:
   *
   * MUTANT: `const brief = declineBrief(realm);` -> `const brief = undefined;`.
   * The lead's refusal does nothing at all — the offerer stands, the offer is
   * re-takeable for ever, and the window rebuild never happens.
   *
   * MUTANT: delete `announceLeft(offererId, …)`. The body is removed from the
   * world and the room is never told, which `client/main.ts` forbids inferring
   * from absence — so the offerer stands on every other screen for ever.
   */
  it('takes the offer and the person off the floor, and tells the room', async () => {
    const { lead, other, realm, offererId } = await twoOnTheFloor();
    // THE OTHER MEMBER IS MID-CONVERSATION WITH THEM, which is what makes the
    // window rebuild real rather than incidental.
    await talk(other, offererId);
    expect(row(other, ChatOptionId.BriefTake), 'the fixture never offered it').toBeDefined();

    await talk(lead, offererId);
    await choose(lead, ChatNodeId.Greet, ChatOptionId.BriefDecline);

    expect(realm.brief, 'the offer survived a refusal').toBeUndefined();
    expect(realm.world.getActor(offererId), 'they are still standing there').toBeUndefined();
    expect(lead.errors()).toEqual([]);

    // ═══ THE ROOM LEARNS IT AS A FRAME, NOT AS AN ABSENCE ═══
    const left = other
      .all('left')
      .some((frame) => frame['actorId'] === offererId || frame['id'] === offererId);
    expect(left, 'the body was deleted and nobody was told').toBe(true);

    // ═══ AND NOTHING WAS LEFT LYING WHERE THEY STOOD ═══ `removeActor` is not a
    // death: no corpse, no loot, no Record kill line. A quest-giver who leaves a
    // body behind is a quest-giver somebody looted.
    const said = [...lead.lines(), ...other.lines()];
    expect(said.some((line) => line.includes(`${WHO.name} is unmade`))).toBe(false);
    expect(said.some((line) => line.includes('stop expecting anything'))).toBe(true);

    // AND THE OTHER MEMBER'S WINDOW NO LONGER OFFERS WORK THAT IS GONE.
    expect(
      row(other, ChatOptionId.BriefTake),
      'a deleted offer is still pressable',
    ).toBeUndefined();
  });

  /**
   * AND IT DOES NOT COME BACK THROUGH THE DOOR. `Realm.granted` is `hasQuest`
   * (`engine/interface/ActorQuest.lua:50`), and a refusal is an answer.
   *
   * MUTANT: record the grant at the accept rather than at the arm. Walking out
   * and back in re-offers what the lead just refused.
   */
  it('does not stand them back up when the party walks out and returns', async () => {
    const { lead, other, realm, offererId } = await twoOnTheFloor();
    await talk(lead, offererId);
    await choose(lead, ChatNodeId.Greet, ChatOptionId.BriefDecline);
    expect(realm.brief).toBeUndefined();

    await leaveByThreshold(realm, other);
    await leaveByThreshold(realm, lead);
    const back = await enterDelve(lead);
    expect(back.id, 'they were handed a different instance').toBe(realm.id);
    expect(back.brief, 'the floor offered again what the lead had refused').toBeUndefined();
  });
});

// ===========================================================================
// 7. THE OBJECTIVE IS THE FLOOR'S, AND SO IS EVERYTHING IT PAYS
// ===========================================================================

describe('who the objective belongs to', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * ONE ID, ONE INSTANCE, ONCE — WALKING OUT AND BACK IS NOT A NEW FLOOR.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `Brief.id` carries the floor because upstream's does, and upstream's reason
   * is `hasQuest`: one grant per id, ever. Ours had the id and no ledger, so the
   * floor's edge cleared `realm.brief` and the next arrival minted the SAME id
   * again on the SAME lingering instance. Measured over a socket: two quarries,
   * two `Done:` lines, xp 0 -> 36 -> 72 for both members, and two alchemist's
   * lamps lying on one floor.
   *
   * MUTANT: delete the `realm.granted.has(id)` guard in `armBrief`. The delve
   * mouth becomes a repeatable payout.
   */
  it('does not offer the same floor`s work twice to a party that walks back in', async () => {
    const { lead, other, realm } = await twoOnTheFloor();
    expect(realm.brief?.id, 'the fixture armed nothing').toBeDefined();

    await leaveByThreshold(realm, other);
    await leaveByThreshold(realm, lead);
    expect(realm.brief, 'the edge left a reference behind').toBeUndefined();

    const back = await enterDelve(lead);
    expect(back.id, 'they were handed a different instance').toBe(realm.id);
    expect(back.brief, 'the same id was minted a second time').toBeUndefined();
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * A MEMBER WHO WALKS OUT OF THE PARTY WALKS OUT OF THE OBJECTIVE.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Every consumer used to resolve the audience through
   * `partyMembersOf(brief.acceptedBy)`, and `membersOf` answers *"who is with
   * this person NOW"* — so the moment the lead who took it left the party, the
   * objective followed them. MEASURED over a socket: the deserter +36, the
   * member who was still standing on the floor +0, no `Done:` line for them, and
   * their strip still reading `state: 'open'` for work their party no longer
   * held.
   *
   * An Inner realm holds exactly one party (`Realm.partyId`), so the instance
   * can answer the question and `acceptedBy` goes back to being a sentence about
   * who spoke.
   *
   * MUTANT: resolve `briefAudience` through `partyMembersOf(brief.acceptedBy)`.
   * The leaver is paid for work they walked out on and the party is told
   * nothing.
   */
  it('pays the party that holds the floor, and not the member who left it', async () => {
    const { lead, other, realm } = await taken();
    const stay = realm.world.getActor(other.actorId);
    const go = realm.world.getActor(lead.actorId);
    if (stay?.kind !== ActorKind.Player || go?.kind !== ActorKind.Player) {
      throw new Error('no player bodies');
    }
    // THE KILL ITSELF PAYS NOTHING — see the payout case above for both halves
    // of why. Without it this file cannot tell a brief`s payout from a kill`s.
    stay.level = 10;
    go.level = 10;
    const target = realm.brief?.target;
    const named = target?.k === BriefKind.Quarry ? (target.actorId ?? '') : '';
    const quarry = realm.world.getActor(named);
    if (quarry === undefined) throw new Error('nothing was named');
    quarry.level = 1;

    // THE LEAD WALKS OUT OF THE PARTY. `engine/party.ts#leave` mints them a
    // party of one and hands the badge to the heir; the original row keeps its
    // id and its remaining member, which is the row the realm was opened under.
    lead.send({ t: 'party', action: 'leave' });
    await sleep(250);
    expect(partyIdOf(server.parties, lead.actorId)).not.toBe(
      partyIdOf(server.parties, other.actorId),
    );

    const before = { stay: stay.xp, go: go.xp };
    quarry.hp = 0;
    quarry.alive = false;
    await pumpUntil(realm, other, BriefState.Closed);

    expect(realm.brief?.state, 'the objective never closed').toBe(BriefState.Closed);
    expect(stay.xp, 'the party that did the work was not paid').toBeGreaterThan(before.stay);
    expect(go.xp, 'the member who walked out was paid anyway').toBe(before.go);
    expect(
      other.lines().some((line) => line.includes(`Done: ${QUARRY.title}`)),
      'the party was not told their own objective closed',
    ).toBe(true);
    expect(
      lead.lines().filter((line) => line.includes(`Done: ${QUARRY.title}`)),
      'the leaver was told about work they walked out on',
    ).toEqual([]);
  });

  /**
   * AND THE STRIP GOES WITH THE MEMBERSHIP. Nothing else re-sends the frame —
   * it goes out on arrival, on a hello, and when the objective itself moves —
   * so without a send on a party change a deserter keeps a band on screen for
   * the rest of the floor.
   *
   * MUTANT: delete `sendBrief(member)` from `handleParty`'s affected loop.
   */
  it('takes the strip off the screen of somebody who leaves the party', async () => {
    const { lead, other } = await taken();
    expect(strip(lead)?.['state'], 'the taker never had a strip').toBe(BriefState.Open);
    lead.send({ t: 'party', action: 'leave' });
    await sleep(300);
    expect(strip(lead), 'the leaver kept a band for work they left').toBeNull();
    expect(strip(other)?.['state'], 'the member who stayed lost theirs').toBe(BriefState.Open);
  });

  /**
   * AND SOMEBODY WHO JOINS AFTER THE ACCEPT IS PAID, because the audience is
   * read at payment rather than recorded at the accept — the same rule every
   * kill in the game already follows.
   *
   * MUTANT: snapshot the members at the accept. A friend who walked in ten turns
   * later helps finish the work and is paid nothing.
   */
  it('pays a member who joined the party after the objective was taken', async () => {
    const { lead, other, realm } = await taken();
    const body = realm.world.getActor(other.actorId);
    const leadBody = realm.world.getActor(lead.actorId);
    if (body?.kind !== ActorKind.Player || leadBody?.kind !== ActorKind.Player) {
      throw new Error('no player bodies');
    }
    /**
     * ═══ THEY LEAVE AND REJOIN, WHICH IS THE ONLY WAY TO JOIN A DELVE PARTY ═══
     * An invite resolves its target through `world.getActor` (`turn-engine.ts`
     * `submitParty`), so both bodies must be in the SAME world — and an instance
     * is keyed on the party that opened it, so nobody outside the party can walk
     * onto the floor to be invited. Leaving and rejoining on the floor is
     * therefore the real shape of "somebody joined after the accept", and it is
     * the one a party actually produces: a member drops, comes back, and is
     * re-invited mid-floor.
     */
    other.send({ t: 'party', action: 'leave' });
    await sleep(250);
    expect(partyIdOf(server.parties, other.actorId)).not.toBe(
      partyIdOf(server.parties, lead.actorId),
    );
    lead.send({ t: 'party', action: 'invite', targetId: other.actorId });
    await sleep(200);
    other.send({ t: 'party', action: 'accept', targetId: lead.actorId });
    await sleep(250);
    expect(
      partyIdOf(server.parties, other.actorId),
      `they never rejoined (${other.errors().join('; ') || 'no error'})`,
    ).toBe(partyIdOf(server.parties, lead.actorId));

    // THE KILL ITSELF PAYS NOTHING — see the payout case for both halves of why.
    body.level = 10;
    leadBody.level = 10;
    const target = realm.brief?.target;
    const named = target?.k === BriefKind.Quarry ? (target.actorId ?? '') : '';
    const quarry = realm.world.getActor(named);
    if (quarry === undefined) throw new Error('nothing was named');
    quarry.level = 1;
    const before = body.xp;

    quarry.hp = 0;
    quarry.alive = false;
    await pumpUntil(realm, lead, BriefState.Closed);

    expect(realm.brief?.state).toBe(BriefState.Closed);
    expect(body.xp, 'a member who joined after the accept was not paid').toBeGreaterThan(before);
  });
});

// ===========================================================================
// 8. A WIPE PAYS NOTHING, BECAUSE THE FIGHT DID NOT HAPPEN
// ===========================================================================

describe('a floor reset under an open objective', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * IDENTITY, NOT PRESENCE — AND THE OLD RULE PAID THE PARTY FOR WIPING.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `resetFloor` runs INSIDE the pump, reaps every monster and re-seeds the
   * floor with a fresh roll; the post-pump sweep reads the floor on the far side
   * of that, before the wipe branch re-arms anything. `noteBriefProgress` read
   * *"the body is not there"* as *"the body was unmade"*, so a quarry the reseed
   * did not re-mint closed the objective, paid both members and wrote `Done:`
   * into the Case Log of a party that had just died. MEASURED: xp 0 -> 36 each,
   * one `Done:` line, and the objective re-offered in the same pump — accept,
   * die, get paid, repeat.
   *
   * THE BODY HERE IS PLACED BY THIS TEST, with an id the delve generator never
   * mints. That is what makes the case deterministic: an index id like `delve_0`
   * is re-created by the reseed, and the bug then hides behind a body that
   * happens to be alive.
   *
   * MUTANT: compare presence rather than identity — `if (body !== undefined &&
   * body.alive) return undefined;`. A wipe pays.
   */
  it('pays nothing and says nothing for a body the reset deleted', async () => {
    const { lead, other, realm, offererId } = await twoOnTheFloor();
    // AN ELITE THE GENERATOR NEVER MINTS. `markQuarry` names the highest rank
    // first, and the floor`s own survivor is a Normal.
    const spot = plusOfGround(realm, []);
    realm.world.addMonster('probe_kept_its_name', {
      name: 'husk',
      sprite: 'mon_index_husk',
      x: spot.c.x,
      y: spot.c.y,
      profile: AiProfile.MeleeChaser,
      rank: ActorRank.Elite,
      maxHp: 40,
    });

    await talk(lead, offererId);
    await choose(lead, ChatNodeId.Greet, ChatOptionId.BriefTake);
    const target = realm.brief?.target;
    const named = target?.k === BriefKind.Quarry ? target.actorId : null;
    expect(named, 'the fixture`s own body was not the one named').toBe('probe_kept_its_name');

    const leadBody = realm.world.getActor(lead.actorId);
    const otherBody = realm.world.getActor(other.actorId);
    if (leadBody?.kind !== ActorKind.Player || otherBody?.kind !== ActorKind.Player) {
      throw new Error('no player bodies');
    }
    const before = { lead: leadBody.xp, other: otherBody.xp };

    // THE FLOOR KILLS THE WHOLE PARTY, exactly as the re-arm case does.
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

    expect(realm.world.getActor('probe_kept_its_name'), 'the reset kept it').toBeUndefined();
    expect(realm.brief?.state, 'the wipe did not put the objective back').toBe(BriefState.Offered);
    expect(leadBody.xp, 'the party was paid for a floor they died on').toBe(before.lead);
    expect(otherBody.xp, 'the party was paid for a floor they died on').toBe(before.other);
    const said = [...lead.lines(), ...other.lines()];
    expect(
      said.some((line) => line.includes(`Done: ${QUARRY.title}`)),
      'the party was told they finished what killed them',
    ).toBe(false);
  });
});

// ===========================================================================
// 9. WHAT THE PLAYER READS, IN THE ORDER THEY READ IT
// ===========================================================================

describe('the order of the offer and its outcome', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE QUESTION COMES BEFORE THE COMMITMENT.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * The window opens on the greeting, and the keyboard cursor sits on the first
   * enabled row. With `We will take it.` first, one Enter at first contact
   * committed the whole party past the only row that says what the work is or
   * what it pays — measured over a socket: `offered` -> one Enter -> `open`.
   *
   * `tome/class/GameState.lua:2928` puts the reward inside the offer, and this
   * file's own chat notes say refusing must be a PRICED decision. The price was
   * written and was never on screen first.
   *
   * MUTANT: order `briefOptions` with the accept first again. The default
   * keypress becomes the irreversible one.
   */
  it('puts the two questions above the two answers', async () => {
    const { lead, offererId } = await twoOnTheFloor();
    await talk(lead, offererId);
    const ids = options(lead).map((o) => o['id']);
    const ask = ids.indexOf(ChatOptionId.BriefAsk);
    const take = ids.indexOf(ChatOptionId.BriefTake);
    const decline = ids.indexOf(ChatOptionId.BriefDecline);
    expect(ask, 'the offer does not ask what it is').toBeGreaterThanOrEqual(0);
    expect(ids[0], 'the first row a player lands on is the irreversible one').toBe(
      ChatOptionId.BriefAsk,
    );
    expect(ask, 'the commitment is above the question').toBeLessThan(take);
    expect(take, 'the refusal is above the acceptance').toBeLessThan(decline);
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * AND THE OUTCOME SITS UNDER ITS OWN CAUSE IN THE LOG.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `handleDialogueChoose` ran `option.action` — where `takeBrief` writes
   * *"Taken on: …"* — BEFORE recording the exchange, so the merged default view
   * of the Case Log read the result above the answer that produced it:
   *
   *     Pell Oxbow: I came down with eleven. Do not count.
   *     Taken on: It kept its name.
   *     Player 11: We will take it.
   *
   * `announceCleared` carries the identical note about the identical mistake,
   * and the identical fix: whatever CAUSES something goes out first.
   *
   * MUTANT: move `recordDialogue` back below `option.action?.(ctx)`.
   */
  it('writes the answer above the thing the answer did', async () => {
    const { lead, offererId } = await twoOnTheFloor();
    await talk(lead, offererId);
    await choose(lead, ChatNodeId.Greet, ChatOptionId.BriefTake);
    const said = lead.lines();
    const answer = said.findIndex((line) => line.includes('We will take it.'));
    const outcome = said.findIndex((line) => line.includes(`Taken on: ${QUARRY.title}`));
    expect(answer, 'the exchange was never written down').toBeGreaterThanOrEqual(0);
    expect(outcome, 'the accept wrote no line').toBeGreaterThanOrEqual(0);
    expect(answer, 'the outcome was filed above its own cause').toBeLessThan(outcome);
  });
});
