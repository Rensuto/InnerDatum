import { setTimeout as sleep } from 'node:timers/promises';

import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { StandingOrder } from '../../src/server/engine/actor.ts';
import { createDownedState } from '../../src/server/engine/downed.ts';
import { createPartyState, isLeader, leave } from '../../src/server/engine/party.ts';
import { ChatNodeId, ChatOptionId, topicNodeId } from '../../src/server/content/chats.ts';
import { STANDING_LEVEL } from '../../src/server/content/townsfolk.ts';
import { wsGateway } from '../../src/server/net/gateway.ts';
import { createTurnEngine } from '../../src/server/turn-engine.ts';
import { createRealms } from '../../src/server/world/realms.ts';
import { canWalk } from '../../src/shared/level.ts';
import { DialogueScope, TOPIC_LABEL, TopicId } from '../../src/shared/protocol.ts';
import { PROTOCOL_VERSION } from '../../src/shared/version.ts';
import type { PartyState } from '../../src/server/engine/party.ts';
import type { Realm, Realms } from '../../src/server/world/realms.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE CONVERSATION, OVER A REAL SOCKET, WITH TWO PEOPLE IN THE ROOM.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The author's ruling, 2026-09-17, verbatim: *"the other players should be able
 * to interact with npcs and have dialogue interactions, but story driving
 * conversations should only be applicable to the host to protect their
 * playthrough"*.
 *
 * That is TWO rules and every case below is about keeping them apart. Anybody
 * may open a window and ask anything personal; only the party lead may give an
 * answer that commits the run. A test that drove one player could not tell the
 * difference between "the rule is enforced" and "there is no rule", because a
 * solo player leads themselves — so every case here has a lead AND a non-lead,
 * and the non-lead is the one being measured.
 *
 * ═══ AND IT IS DRIVEN, NOT UNIT-TESTED ═══
 * `chats.test.ts` is the graph. The join is what breaks here: the scope check
 * lives in `handleDialogueChoose` and reads a resolved scope off
 * `visibleOptions`, and every way of getting that wrong — trusting the frame we
 * sent, reading `option.scope` directly, checking membership instead of
 * leadership — produces a server that passes a unit test and hands a non-lead
 * the whole playthrough.
 */

const FRAME_TIMEOUT_MS = 4_000;

type Frame = Record<string, unknown>;

type Client = {
  actorId: string;
  send(frame: Frame): void;
  latest(type: string): Frame | undefined;
  count(type: string): number;
  errors(): string[];
  lines(): { text: string; speaker?: string; gameTurn: number }[];
  close(): void;
};

const openClients: Client[] = [];

async function connect(port: number): Promise<Client> {
  const socket = new WebSocket(`ws://127.0.0.1:${String(port)}/ws`);
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
        count: (type) => frames.filter((f) => f['t'] === type).length,
        errors: () =>
          frames
            .filter((f) => f['t'] === 'error')
            .map((f) =>
              [f['code'], f['message']]
                .filter((v): v is string => typeof v === 'string')
                .join(': '),
            ),
        lines: () => {
          const out: { text: string; speaker?: string; gameTurn: number }[] = [];
          for (const frame of frames) {
            if (frame['t'] !== 'log') continue;
            const rows = frame['lines'];
            if (!Array.isArray(rows)) continue;
            for (const row of rows as Record<string, unknown>[]) {
              if (typeof row['text'] === 'string') {
                out.push({
                  text: row['text'],
                  speaker: typeof row['speaker'] === 'string' ? row['speaker'] : undefined,
                  // THE CLOCK IT WAS FILED UNDER, which is what draws the turn
                  // separators in a reader's log — and is the whole of the rule
                  // that a line is stamped with the RECIPIENT's realm.
                  gameTurn: typeof row['gameTurn'] === 'number' ? row['gameTurn'] : -1,
                });
              }
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

type Harness = { port: number; realms: Realms; parties: PartyState; close: () => Promise<void> };
let server: Harness;

beforeEach(async () => {
  const downed = createDownedState();
  const parties = createPartyState();
  const realms = createRealms({
    seed: 'dialogue',
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

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WALK IN THROUGH THE DOOR, THEN STAND NEXT TO MERROW STITCH.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `rumour-gate.test.ts`'s own note is the reason the crossing is a real `move`
 * and not a teleport: `handleTalk` resolves the room through `realmFor(session)`,
 * so a session whose body was moved between worlds under it is still pointed at
 * the map it was on and the townsperson is, correctly, not there.
 *
 * MERROW BY NAME rather than "whoever is first in the room". She is the only
 * person who is BOTH a shopkeeper and carries a level-gated rumour, so one
 * fixture drives the counter seam and the condition gate, and every case below
 * is about the same body.
 */
const WHO = 'merrow';

async function walkIntoTown(
  realms: Realms,
  client: Client,
): Promise<{ town: Realm; whoId: string }> {
  const home = realms
    .all()
    .find((r) => [...r.world.allActors()].some((a) => a.id.endsWith(`:town:${WHO}`)));
  if (home === undefined) throw new Error(`nowhere in this world does ${WHO} live`);
  const door = [...realms.overworld.sites].find(([, siteId]) => siteId === home.siteId);
  if (door === undefined) throw new Error('that town has no door on the overworld');
  const [xs, ys] = door[0].split(',');

  const body = realms.overworld.world.getActor(client.actorId);
  if (body === undefined) throw new Error('no body on the overworld');
  body.x = Number(xs) - 1;
  body.y = Number(ys);
  client.send({ t: 'move', dir: 'e' });
  await sleep(250);

  const town = realms.realmOf(client.actorId);
  if (town === undefined || town.id === realms.overworld.id) {
    throw new Error(`never got into the town (${client.errors().join('; ') || 'no error'})`);
  }
  const who = [...town.world.allActors()].find((a) => a.id.endsWith(`:town:${WHO}`));
  if (who === undefined) throw new Error('she is not in her own town');

  // ═══ BESIDE HER, ON A TILE NOBODY IS STANDING ON ═══ Two bodies cannot share
  // a cell, and Chebyshev 1 is eight tiles, so the second person takes the next
  // free one rather than the same one. Searched rather than computed: she stands
  // with her back to a wall, so at least one of the eight is not floor.
  const taken = new Set([...town.world.allActors()].map((a) => `${String(a.x)},${String(a.y)}`));
  const me = town.world.getActor(client.actorId);
  if (me === undefined) throw new Error('no body in the town');
  taken.delete(`${String(me.x)},${String(me.y)}`);
  const spot = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
    [1, 1],
    [-1, -1],
    [1, -1],
    [-1, 1],
  ]
    .map(([dx, dy]) => ({ x: who.x + (dx ?? 0), y: who.y + (dy ?? 0) }))
    .find(
      (at) =>
        canWalk(town.world.level, at.x, at.y) && !taken.has(`${String(at.x)},${String(at.y)}`),
    );
  if (spot === undefined) throw new Error('nowhere to stand beside her');
  me.x = spot.x;
  me.y = spot.y;
  return { town, whoId: who.id };
}

/** The window as this client last saw it, or nothing. */
function view(client: Client): Frame | undefined {
  const frame = client.latest('dialogue');
  const v = frame?.['view'];
  return typeof v === 'object' && v !== null ? (v as Frame) : undefined;
}

function options(client: Client): Frame[] {
  const rows = view(client)?.['options'];
  return Array.isArray(rows) ? (rows as Frame[]) : [];
}

function row(client: Client, id: string): Frame | undefined {
  return options(client).find((o) => o['id'] === id);
}

/** One string field off a frame, narrowed rather than stringified. */
function textOf(frame: Frame | undefined, key: string): string {
  const value = frame?.[key];
  return typeof value === 'string' ? value : '';
}

/** Open a window on Merrow and wait for it. */
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
  await sleep(160);
}

/** Both of them in the same town, partied, with `a` leading. */
async function twoInTown(): Promise<{
  lead: Client;
  other: Client;
  town: Realm;
  whoId: string;
}> {
  const lead = await connect(server.port);
  const other = await connect(server.port);
  const first = await walkIntoTown(server.realms, lead);
  const second = await walkIntoTown(server.realms, other);
  expect(second.town.id, 'a town is a Common realm and must be shared').toBe(first.town.id);

  lead.send({ t: 'party', action: 'invite', targetId: other.actorId });
  await sleep(150);
  other.send({ t: 'party', action: 'accept', targetId: lead.actorId });
  await sleep(200);

  // ASSERT THE FIXTURE ACTED, never that it was configured. A test whose party
  // never formed would find every story row greyed for both of them and read as
  // a passing rule.
  expect(isLeader(server.parties, lead.actorId), 'the inviter did not end up leading').toBe(true);
  expect(isLeader(server.parties, other.actorId), 'the second player leads too').toBe(false);
  return { lead, other, town: first.town, whoId: first.whoId };
}

/**
 * TAKE A CLASS, WHICH IS WHAT TAKES THIS SOCKET OUT OF `classChoiceOwed`.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * AN ANONYMOUS SOCKET HIDES EVERY PARK BUG IN THIS FILE, AND IT HID TWO
 * ═══════════════════════════════════════════════════════════════════════════
 * `unparkOnCommand` releases a body only while its owner still owes a class
 * choice, and an anonymous socket owes one for its whole life. So every case
 * that drives a bare `hello` gets its standing order cleared BY ACCIDENT on the
 * next verb, and a conversation that leaked a park looked perfectly healthy.
 * Both leaks this file now pins — the second `talk` and the dropped socket —
 * were invisible until a test chose a class first, which is what every real
 * player does before they ever meet a townsperson.
 */
async function chooseAClass(client: Client): Promise<void> {
  const offered = client.latest('class_options')?.['options'];
  const first = Array.isArray(offered) ? (offered[0] as Frame | undefined) : undefined;
  const classId = textOf(first, 'id');
  if (classId === '') throw new Error('the server offered no class to choose');
  client.send({ t: 'choose_class', classId });
  await sleep(200);
}

/** Put this body over the rumour gate, where the route rows exist. */
function giveStanding(town: Realm, actorId: string): void {
  const body = town.world.getActor(actorId);
  if (body === undefined || !('level' in body)) throw new Error('no player body');
  body.level = STANDING_LEVEL;
}

describe('anybody may talk', () => {
  it('opens a window for a player who does not lead the party', async () => {
    /**
     * RULING 1. Opening a conversation is not a privilege — the verb gates on
     * ADJACENCY, exactly as it always did, and on nothing about parties. The
     * previous design made the window the host's alone and this is the case that
     * would have caught it.
     */
    const { other, whoId } = await twoInTown();
    await talk(other, whoId);

    const v = view(other);
    expect(v?.['speakerName']).toBe('Merrow Stitch');
    expect(v?.['nodeId']).toBe(ChatNodeId.Greet);
    expect(v?.['sprite']).toBe('chr_npc_merrow_stitch_s');
    expect(v?.['portrait']).toBe('chr_portrait_merrow_stitch');
    expect(options(other).length).toBeGreaterThan(1);
  });

  it('lets two people hold a conversation with the same person at once', async () => {
    // RULING 5. State is per socket, so one window does not evict another — and
    // a shopkeeper with six people at her counter is the ordinary case, not the
    // exotic one.
    const { lead, other, whoId } = await twoInTown();
    await talk(lead, whoId);
    await talk(other, whoId);

    expect(view(lead)?.['nodeId']).toBe(ChatNodeId.Greet);
    expect(view(other)?.['nodeId']).toBe(ChatNodeId.Greet);

    // AND THEY MOVE INDEPENDENTLY. One of them walking down a branch must not
    // drag the other with it, which is what a realm-keyed table would do.
    await choose(lead, ChatNodeId.Greet, topicNodeId(TopicId.Roads));
    expect(view(lead)?.['nodeId']).toBe(topicNodeId(TopicId.Roads));
    expect(view(other)?.['nodeId']).toBe(ChatNodeId.Greet);
  });

  it('answers a personal question for a non-lead, and tells nobody else', async () => {
    /**
     * RULING 2 and RULING 4 in one case, because they are the same fact from two
     * sides: a topic is personal, so the non-lead gets the answer AND the party
     * log does not. Six players asking a shopkeeper about the roads must not
     * push the party's own conversation off the band.
     */
    const { lead, other, whoId } = await twoInTown();
    await talk(other, whoId);
    const quiet = lead.lines().length;

    await choose(other, ChatNodeId.Greet, topicNodeId(TopicId.Roads));

    const answered = view(other);
    expect(answered?.['nodeId']).toBe(topicNodeId(TopicId.Roads));
    // THE WORDS ARE THE TABLE'S, so this holds no second copy of them — a
    // fixture that re-types its content can only test itself. What is asserted
    // is that something was said and that it is not the greeting she opened
    // with, which is the failure a dead row actually produces.
    expect(textOf(answered, 'text')).not.toBe('');
    expect(textOf(answered, 'text')).not.toBe(textOf(view(lead), 'text'));

    // IT IS IN THEIR OWN LOG, as a transcript.
    const said = other.lines().map((l) => l.text);
    expect(said).toContain(TOPIC_LABEL[TopicId.Roads]);
    // AND IT IS IN NOBODY ELSE'S. Asserted as "no new lines at all" rather than
    // "not this string": a routing bug that sent the whole exchange to the party
    // would fail the second form only if the string happened to match.
    expect(lead.lines().length, 'shop chatter reached the party log').toBe(quiet);
  });

  it('opens the shelf from inside the window, for a non-lead', async () => {
    /**
     * The author: *"shop options and other interactions will still occur through
     * the dialogue interaction box"*. Buying is not a decision about the party's
     * story — each buyer spends their own purse — so the row is personal, and it
     * must reach the same `shop` frame the door has always sent.
     */
    const { other, whoId } = await twoInTown();
    await talk(other, whoId);
    expect(row(other, ChatOptionId.Shop)?.['enabled']).toBe(true);
    expect(row(other, ChatOptionId.Shop)?.['scope']).toBe(DialogueScope.Personal);

    const before = other.count('shop');
    await choose(other, ChatNodeId.Greet, ChatOptionId.Shop);
    expect(other.count('shop'), 'the counter never opened').toBeGreaterThan(before);
    // AND THE CONVERSATION IS STILL THERE. The shelf is reached from inside the
    // window; opening it must not close the window that offered it.
    expect(view(other)?.['nodeId']).toBe(ChatNodeId.Greet);

    /**
     * ═══ AND BUYING DOES NOT CLOSE IT EITHER ═══
     * `handleShopBuy` runs `unparkOnCommand`, which ends a conversation for
     * every other verb that reaches it — a body cannot both talk and act. The
     * counter is the author's stated exception: *"shop options and other
     * interactions will still occur through the dialogue interaction box"*.
     *
     * A BOGUS ITEM ID ON PURPOSE. `unparkOnCommand` runs BEFORE any of that
     * handler's validation, so a refused purchase exercises the exception
     * exactly as a real one does and needs no coins, no shelf and no restock.
     *
     * MUTATION: drop the `true` from `unparkOnCommand(session, true)` in
     * `handleShopBuy` and this goes red.
     */
    other.send({ t: 'shop_buy', itemId: 'nothing_on_this_shelf' });
    await sleep(160);
    expect(view(other), 'buying closed the conversation that sold it').toBeDefined();
  });
});

describe('only the host answers for the party', () => {
  it('shows a non-lead the story row, greyed, naming who can', async () => {
    /**
     * RULING 3, and it is a deliberate exception to `verbs.ts`'s rule that a
     * never-enabled row is a lie with a tooltip on it. The answer IS available
     * to the party and simply not through this player — hiding it would tell
     * four people the conversation has fewer answers than it has, and the one
     * who can give the missing one is in the same voice channel.
     */
    const { lead, other, town, whoId } = await twoInTown();
    giveStanding(town, other.actorId);
    await talk(other, whoId);
    await choose(other, ChatNodeId.Greet, topicNodeId(TopicId.Rumour));

    const party = row(other, ChatOptionId.RouteParty);
    expect(party, 'the story row was hidden rather than greyed').toBeDefined();
    expect(party?.['enabled']).toBe(false);
    expect(party?.['scope']).toBe(DialogueScope.Story);
    // THE REASON NAMES A PERSON. "Unavailable" is a bug report; a name is an
    // instruction to turn to somebody.
    const leadName = town.world.getActor(lead.actorId)?.name ?? '';
    expect(leadName).not.toBe('');
    expect(textOf(party, 'reason')).toContain(leadName);

    // AND THE PERSONAL ROW BESIDE IT IS LIVE, so the greying is about the scope
    // and not about the node.
    expect(row(other, ChatOptionId.RouteSelf)?.['enabled']).toBe(true);
  });

  it('refuses a story answer from a non-lead and changes nothing', async () => {
    /**
     * THE RULE WITH TEETH. The client's grey is a courtesy; this is the rule.
     * The frame is hand-built with an id the server did offer — so this is not a
     * "you were not offered that" refusal — and the only thing standing between
     * a non-lead and the party's map is the scope check.
     *
     * MUTATION: delete the `option.scope === Story && !isPartyLead` branch in
     * `handleDialogueChoose` and this goes red on the fog assertion, not merely
     * on the error one.
     */
    const { lead, other, town, whoId } = await twoInTown();
    giveStanding(town, other.actorId);
    giveStanding(town, lead.actorId);
    await talk(other, whoId);
    await choose(other, ChatNodeId.Greet, topicNodeId(TopicId.Rumour));

    const before = fogPrint(lead.actorId);
    await choose(other, topicNodeId(TopicId.Rumour), ChatOptionId.RouteParty);

    expect(other.errors().join(' ')).toContain('answer for the party');
    // NOTHING MOVED. The lead's map is the one a non-lead must not be able to
    // write, and it is the actual state the ruling protects.
    expect(fogPrint(lead.actorId), 'a non-lead wrote on the party’s map').toBe(before);
    // AND THE WINDOW STANDS, on the same node, so they can pick something they
    // may pick rather than being thrown out for asking.
    expect(view(other)?.['nodeId']).toBe(topicNodeId(TopicId.Rumour));
  });

  it('applies the lead’s story answer and puts it in the whole party’s log', async () => {
    /**
     * RULING 4. The exchange the party is following: the line, the answer, and
     * what it produced, in every member's Case Log — that is how four people
     * follow a playthrough they are not driving.
     */
    const { lead, other, town, whoId } = await twoInTown();
    giveStanding(town, lead.actorId);
    await talk(lead, whoId);
    await choose(lead, ChatNodeId.Greet, topicNodeId(TopicId.Rumour));

    expect(row(lead, ChatOptionId.RouteParty)?.['enabled']).toBe(true);
    const beforeOther = fogPrint(other.actorId);
    await choose(lead, topicNodeId(TopicId.Rumour), ChatOptionId.RouteParty);

    expect(lead.errors()).toEqual([]);
    // IT REACHED THE OTHER PLAYER'S CHARACTER, which is what makes it a party
    // decision rather than a personal one.
    expect(fogPrint(other.actorId), 'the party’s map never changed').not.toBe(beforeOther);
    expect(view(lead)?.['nodeId']).toBe(ChatNodeId.RouteParty);

    // AND THE PARTY READ IT. The answer the lead gave, in somebody else's log.
    const heard = other.lines().map((l) => l.text);
    expect(heard, 'the party could not follow the exchange').toContain(
      "Put it on the whole party's map.",
    );
  });

  it('re-asks every open window when the lead changes, and applies nothing', async () => {
    /**
     * LEADERSHIP MOVES when somebody leaves (`engine/party.ts` — the badge is
     * handed on). Everybody with a window open may have just gained the right to
     * answer half of it, and their screen says otherwise.
     *
     * NOTHING RETROACTIVE: the story answer the old lead did not take is not
     * taken, so the map must be untouched across the whole case.
     */
    const { lead, other, town, whoId } = await twoInTown();
    giveStanding(town, other.actorId);
    await talk(other, whoId);
    await choose(other, ChatNodeId.Greet, topicNodeId(TopicId.Rumour));
    expect(row(other, ChatOptionId.RouteParty)?.['enabled']).toBe(false);

    const before = fogPrint(other.actorId);
    const frames = other.count('dialogue');

    lead.send({ t: 'party', action: 'leave' });
    await sleep(250);

    expect(isLeader(server.parties, other.actorId), 'the badge never moved').toBe(true);
    expect(other.count('dialogue'), 'the window was not re-asked').toBeGreaterThan(frames);
    // SAME NODE, DIFFERENT PERMISSION. Closing would have been the cheaper rule
    // and the wrong one.
    expect(view(other)?.['nodeId']).toBe(topicNodeId(TopicId.Rumour));
    expect(row(other, ChatOptionId.RouteParty)?.['enabled']).toBe(true);
    expect(fogPrint(other.actorId), 'something was applied retroactively').toBe(before);
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * A PARTY MEMBER TWO REALMS AWAY READS IT ON THEIR OWN CLOCK.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `recordDialogue` stamps each copy with `realmFor(to)` — the RECIPIENT's
   * realm — and every other case in this file has both players in one town,
   * where the recipient's clock and the speaker's are the same number and the
   * rule is unfalsifiable. `LogLine.gameTurn` is what draws the turn separators
   * in a reader's log, so a town's frozen clock stamped onto a line arriving in
   * the middle of somebody's fight files it under a turn they are nowhere near.
   *
   * SO THE PARTY IS FORMED ON THE MOOR and only the LEAD goes indoors. The
   * fixture asserts the two clocks actually differ before it asserts which one
   * was used, because a case where they agree would pass either way.
   */
  it('files a story line under the reader’s own clock, not the speaker’s', async () => {
    const lead = await connect(server.port);
    const other = await connect(server.port);
    lead.send({ t: 'party', action: 'invite', targetId: other.actorId });
    await sleep(150);
    other.send({ t: 'party', action: 'accept', targetId: lead.actorId });
    await sleep(200);
    expect(isLeader(server.parties, lead.actorId), 'the inviter did not end up leading').toBe(true);

    // THE OTHER PLAYER STAYS OUTSIDE AND KEEPS WALKING, which is what makes the
    // overworld's clock a different number from the town's.
    for (const dir of ['n', 's', 'e', 'w', 'n', 's']) {
      other.send({ t: 'move', dir });
      await sleep(80);
    }

    const { town, whoId } = await walkIntoTown(server.realms, lead);
    expect(server.realms.realmOf(other.actorId)?.id, 'the second player went indoors too').toBe(
      server.realms.overworld.id,
    );
    giveStanding(town, lead.actorId);
    const moor = server.realms.overworld.world.turn.clock.gameTurn;
    expect(
      town.world.turn.clock.gameTurn,
      'the two clocks agree; this case proves nothing',
    ).not.toBe(moor);

    await talk(lead, whoId);
    await choose(lead, ChatNodeId.Greet, topicNodeId(TopicId.Rumour));
    await choose(lead, topicNodeId(TopicId.Rumour), ChatOptionId.RouteParty);
    expect(lead.errors()).toEqual([]);

    const heard = other.lines().find((l) => l.text === "Put it on the whole party's map.");
    expect(heard, 'the party could not follow the exchange').toBeDefined();
    expect(heard?.gameTurn, 'the line was filed under the speaker’s clock').toBe(
      server.realms.overworld.world.turn.clock.gameTurn,
    );
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * LEADERSHIP IS RE-DERIVED WHEN THE ANSWER LANDS. THE FRAME IS NOT BELIEVED.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * The case above proves a story answer is refused while the badge is somewhere
   * else. THIS ONE PROVES THE OTHER DIRECTION, and it is the one that shows
   * `enabled` is never read server-side: the window on this socket still says
   * `enabled: false` with somebody else's name under the row, and the moment the
   * badge is theirs the same frame is APPLIED.
   *
   * THE BADGE IS MOVED BEHIND THE GATEWAY'S BACK — `leave` is called on the
   * party state directly rather than sent as a `party` frame — precisely so that
   * `resendDialogues` does not fire and the client is left holding the stale
   * permission. A test that went through the frame would be measuring the
   * re-send, which has its own case above.
   */
  it('applies a story answer from somebody whose window still says they may not', async () => {
    const { lead, other, town, whoId } = await twoInTown();
    giveStanding(town, other.actorId);
    await talk(other, whoId);
    await choose(other, ChatNodeId.Greet, topicNodeId(TopicId.Rumour));
    expect(row(other, ChatOptionId.RouteParty)?.['enabled'], 'the fixture is not set up').toBe(
      false,
    );
    const frames = other.count('dialogue');

    leave(server.parties, lead.actorId);
    expect(isLeader(server.parties, other.actorId), 'the badge never moved').toBe(true);
    expect(other.count('dialogue'), 'the window was re-sent; the frame is not stale').toBe(frames);

    const before = fogPrint(other.actorId);
    await choose(other, topicNodeId(TopicId.Rumour), ChatOptionId.RouteParty);
    expect(other.errors(), 'the server believed the frame it had sent').toEqual([]);
    expect(fogPrint(other.actorId), 'the story answer did nothing').not.toBe(before);
    expect(view(other)?.['nodeId']).toBe(ChatNodeId.RouteParty);
  });
});

describe('what the server refuses', () => {
  it('refuses an option it never offered', async () => {
    const { other, whoId } = await twoInTown();
    await talk(other, whoId);
    await choose(other, ChatNodeId.Greet, 'burn_the_town_down');
    expect(other.errors().join(' ')).toContain('not something you can say');
    expect(view(other)?.['nodeId']).toBe(ChatNodeId.Greet);
  });

  it('refuses an option whose condition has not opened yet', async () => {
    /**
     * THE CONDITION IS THE SERVER'S, AND THIS IS THE CASE THAT PROVES IT. Below
     * `STANDING_LEVEL` Merrow's rumour names no country, so the route rows are
     * not offered — and a hand-built frame naming one must be refused rather
     * than trusted. Asserted at the BOUNDARY (`STANDING_LEVEL - 1`) rather than
     * at level 1, so an off-by-one in the gate fails here.
     *
     * MUTATION: delete the `visibleOptions` rebuild on the pick path — trust
     * `open.offered` alone — and this stays green while the one below goes red;
     * delete `open.offered` and the reverse. Both halves are load-bearing.
     */
    const { other, town, whoId } = await twoInTown();
    const body = town.world.getActor(other.actorId);
    if (body === undefined || !('level' in body)) throw new Error('no player body');
    body.level = STANDING_LEVEL - 1;

    await talk(other, whoId);
    await choose(other, ChatNodeId.Greet, topicNodeId(TopicId.Rumour));
    expect(row(other, ChatOptionId.RouteSelf), 'the gate was already open').toBeUndefined();

    const before = fogPrint(other.actorId);
    await choose(other, topicNodeId(TopicId.Rumour), ChatOptionId.RouteSelf);
    expect(other.errors().join(' ')).toContain('not something you can say');
    expect(fogPrint(other.actorId)).toBe(before);
  });

  it('refuses an option that was offered and has since stopped passing', async () => {
    // THE OTHER HALF OF THE SAME RULE. The row WAS on their screen; the world
    // moved under it. Upstream can evaluate a condition once because nothing
    // moves between its draw and its click. Six people move.
    const { other, town, whoId } = await twoInTown();
    giveStanding(town, other.actorId);
    await talk(other, whoId);
    await choose(other, ChatNodeId.Greet, topicNodeId(TopicId.Rumour));
    expect(row(other, ChatOptionId.RouteSelf)?.['enabled']).toBe(true);

    // The gate shuts between the frame and the answer.
    const body = town.world.getActor(other.actorId);
    if (body === undefined || !('level' in body)) throw new Error('no player body');
    body.level = STANDING_LEVEL - 1;

    const before = fogPrint(other.actorId);
    await choose(other, topicNodeId(TopicId.Rumour), ChatOptionId.RouteSelf);
    expect(other.errors().join(' ')).toContain('not something you can say');
    expect(fogPrint(other.actorId)).toBe(before);
  });

  it('refuses an option that has only just started passing', async () => {
    /**
     * THE HALF `open.offered` ALONE CATCHES, and the reason both halves are
     * kept. Here the rebuild at pick time would PASS — the level went up between
     * the frame and the answer, so the row is legal now — and the player is
     * still answering a question they were never asked. A client that only had
     * to satisfy the rebuild could pick rows it had never been shown.
     *
     * MUTATION: delete the `open.offered.has(...)` term and this goes red while
     * every other refusal case stays green.
     */
    const { other, town, whoId } = await twoInTown();
    const body = town.world.getActor(other.actorId);
    if (body === undefined || !('level' in body)) throw new Error('no player body');
    body.level = STANDING_LEVEL - 1;

    await talk(other, whoId);
    await choose(other, ChatNodeId.Greet, topicNodeId(TopicId.Rumour));
    expect(row(other, ChatOptionId.RouteSelf), 'the row was offered after all').toBeUndefined();

    // The gate opens between the frame and the answer.
    body.level = STANDING_LEVEL;
    const before = fogPrint(other.actorId);
    await choose(other, topicNodeId(TopicId.Rumour), ChatOptionId.RouteSelf);
    expect(other.errors().join(' ')).toContain('not something you can say');
    expect(fogPrint(other.actorId)).toBe(before);
  });

  it('refuses an answer to a question that has already been replaced', async () => {
    const { other, whoId } = await twoInTown();
    await talk(other, whoId);
    await choose(other, ChatNodeId.Greet, topicNodeId(TopicId.Roads));
    expect(view(other)?.['nodeId']).toBe(topicNodeId(TopicId.Roads));

    // A frame that crossed the one that moved them.
    await choose(other, ChatNodeId.Greet, ChatOptionId.Leave);
    expect(other.errors().join(' ')).toContain('older question');
    expect(view(other)?.['nodeId'], 'a stale answer moved the conversation').toBe(
      topicNodeId(TopicId.Roads),
    );
  });

  it('closes the window when the speaker is no longer within reach', async () => {
    const { other, town, whoId } = await twoInTown();
    await talk(other, whoId);
    const body = town.world.getActor(other.actorId);
    const her = town.world.getActor(whoId);
    if (body === undefined || her === undefined) throw new Error('no bodies');
    body.x = her.x + 6;

    await choose(other, ChatNodeId.Greet, topicNodeId(TopicId.Roads));
    expect(other.errors().join(' ')).toContain('nobody there');
    expect(view(other), 'the window outlived the conversation').toBeUndefined();
  });
});

describe('the world does not stop while somebody talks', () => {
  it('parks the talker and hands the body back when the window closes', async () => {
    /**
     * RULING 7, and the mechanism is the class chooser's: `engine/barrier.ts`'s
     * `isBlocking` reads `standingOrder === null`, so a parked body never blocks
     * the quorum, never starts a Bell and never parks the tick loop.
     *
     * ASSERTED ON THE FIELD rather than on a downstream effect, because a town
     * has no engagement and therefore no barrier to observe: `isBlocking` is
     * false there for everybody, so a test that only watched the other player
     * move would pass with the park deleted.
     */
    const { other, town, whoId } = await twoInTown();
    const body = town.world.getActor(other.actorId);
    if (body === undefined) throw new Error('no player body');
    expect(body.standingOrder).toBeNull();

    await talk(other, whoId);
    expect(body.standingOrder, 'the talker was never parked').toBe(StandingOrder.Hold);

    other.send({ t: 'dialogue_close' });
    await sleep(160);
    expect(view(other)).toBeUndefined();
    expect(body.standingOrder, 'the body was never handed back').toBeNull();
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * TALKING TWICE HANDS THE BODY BACK ONCE — THE SECOND `talk` IS A REPLACEMENT.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * SHIPPED FOR A DAY, and it was permanent: `openDialogue` overwrote the map
   * entry without closing what it replaced, so the second `OpenDialogue` read
   * `standingOrder` on a body the FIRST one had just parked and recorded
   * `wasParked: true`. From there `closeDialogue`'s restore-don't-clear rule
   * never released, and nothing else could — `unparkOnCommand` is inert for
   * anybody who has chosen a class. The body held `StandingOrder.Hold` for the
   * rest of the session, so `engine/barrier.ts`'s `isBlocking` stopped counting
   * it and the party never waited for that player again.
   *
   * IT IS TWO RIGHT-CLICKS IN THE SHIPPED CLIENT: `MapVerb.Talk` sends a bare
   * `talk` with no "already talking" gate, and the window's mousedown gate
   * swallows only presses inside the panel.
   *
   * AND THE CLASS IS CHOSEN FIRST, which is the whole reason it was not caught:
   * see `chooseAClass`.
   */
  it('hands the body back after a SECOND talk replaced the first', async () => {
    const { other, town, whoId } = await twoInTown();
    await chooseAClass(other);
    const body = town.world.getActor(other.actorId);
    if (body === undefined) throw new Error('no player body');
    expect(body.standingOrder).toBeNull();

    await talk(other, whoId);
    await talk(other, whoId);
    expect(body.standingOrder, 'the talker was never parked').toBe(StandingOrder.Hold);

    other.send({ t: 'dialogue_close' });
    await sleep(160);
    expect(view(other)).toBeUndefined();
    expect(body.standingOrder, 'a re-opened window never unparked').toBeNull();

    // AND NO KEYPRESS WAS NEEDED TO RESCUE IT. A body that is still parked here
    // is parked for the session: the next verb cannot release it either.
    other.send({ t: 'move', dir: 'n' });
    await sleep(200);
    expect(body.standingOrder, 'permanently parked').toBeNull();
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * AND A SOCKET THAT DROPS MID-SENTENCE HANDS IT BACK TOO.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `map-delete-is-not-cancel`, word for word: the close handler deleted the
   * conversation's table entry and left the park it owned in place. Nothing in
   * the disconnect path writes `standingOrder` — `setConnected(false)`,
   * `startGrace`, `saveNow` and the pump all leave it — and the reconnect
   * resumes the SAME body, so "Discord Activity closed while a shop window was
   * up" ended with a character the barrier never waited for again.
   */
  it('hands the body back when the socket drops with the window open', async () => {
    const { other, town, whoId } = await twoInTown();
    await chooseAClass(other);
    const body = town.world.getActor(other.actorId);
    if (body === undefined) throw new Error('no player body');

    await talk(other, whoId);
    expect(body.standingOrder).toBe(StandingOrder.Hold);

    other.close();
    await sleep(400);
    // THE BODY IS STILL IN THE WORLD — game-design.md § 4, a disconnect does not
    // yank somebody out of a fight — and it is standing by, not braced.
    expect(town.world.getActor(other.actorId), 'the body left the world').toBeDefined();
    expect(body.standingOrder, 'the dropped socket left its park behind').toBeNull();
  });

  /**
   * THE TERMINAL ANSWER — `engine/dialogs/Chat.lua:104-110`, an answer with no
   * jump ENDS the conversation. Every node carries `leave` and it is the whole
   * of that port; nothing drove it successfully before, so deleting the close
   * from that branch left all the socket cases green while the window stayed up
   * and the body stayed parked with it.
   */
  it('closes the window on an answer that ends the conversation', async () => {
    const { other, town, whoId } = await twoInTown();
    await chooseAClass(other);
    await talk(other, whoId);
    const body = town.world.getActor(other.actorId);
    if (body === undefined) throw new Error('no player body');
    expect(body.standingOrder).toBe(StandingOrder.Hold);

    await choose(other, ChatNodeId.Greet, ChatOptionId.Leave);
    expect(other.errors(), 'leaving is not an error').toEqual([]);
    expect(view(other), 'the window survived the goodbye').toBeUndefined();
    expect(body.standingOrder, 'the body was never handed back').toBeNull();
  });

  it('lets a turn verb end the conversation, which is the old-client net', async () => {
    // A body cannot both talk and act. It is also what saves a client that
    // cannot draw the window at all: one keypress and they are back in play.
    const { other, town, whoId } = await twoInTown();
    await talk(other, whoId);
    const body = town.world.getActor(other.actorId);
    if (body === undefined) throw new Error('no player body');
    expect(body.standingOrder).toBe(StandingOrder.Hold);

    other.send({ t: 'move', dir: 'n' });
    await sleep(250);
    expect(view(other), 'the window survived a move').toBeUndefined();
    expect(body.standingOrder).toBeNull();
  });

  it('lets the other player keep playing, and spends no turn doing it', async () => {
    /**
     * TWO FACTS IN ONE CASE. Nothing about a conversation advances the clock —
     * `TalkSchema`'s own rule, and the reason the whole group of non-pumping
     * verbs exists — and the person standing next to the talker is unaffected.
     *
     * ASSERT THE FIXTURE ACTED: the second player's body must have MOVED, not
     * merely been allowed to try.
     */
    const { lead, other, town, whoId } = await twoInTown();
    await talk(other, whoId);

    const mover = town.world.getActor(lead.actorId);
    if (mover === undefined) throw new Error('no second body');
    const from = { x: mover.x, y: mover.y };
    const clock = town.world.turn.clock.gameTurn;

    for (const dir of ['n', 's', 'e', 'w']) {
      lead.send({ t: 'move', dir });
      await sleep(120);
      if (mover.x !== from.x || mover.y !== from.y) break;
    }
    expect({ x: mover.x, y: mover.y }, 'the other player could not move').not.toEqual(from);

    // AND THE TALKER'S OWN SIDE SPENT NOTHING. The clock moved because somebody
    // WALKED; opening, answering and closing must add nothing to it.
    const walked = town.world.turn.clock.gameTurn;
    await choose(other, ChatNodeId.Greet, topicNodeId(TopicId.Party));
    other.send({ t: 'dialogue_close' });
    await sleep(160);
    expect(town.world.turn.clock.gameTurn, 'talking advanced the world').toBe(walked);
    expect(clock).toBeLessThanOrEqual(walked);
  });
});

/**
 * How many overworld tiles this character has on their map.
 *
 * The story answer's whole effect is fog, so the assertion has to be able to
 * see it. READ OFF THE WORLD and never off a frame: `explored` rides `RealmMsg`
 * and is not re-sent for a reveal that happens while the body is indoors, which
 * is exactly when this one happens — a frame-based check would report "nothing
 * changed" for a reveal that worked perfectly.
 *
 * A COUNT rather than a bitset comparison, so a failure message says how far
 * apart the two are instead of printing nine thousand tiles.
 */
function fogPrint(actorId: string): number {
  let lit = 0;
  for (const byte of server.realms.overworld.world.memoryOf(actorId)) {
    for (let bit = 0; bit < 8; bit += 1) if ((byte & (1 << bit)) !== 0) lit += 1;
  }
  return lit;
}
