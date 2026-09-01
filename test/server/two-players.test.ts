import { delveLevel, partyHint, specFor } from '../../src/server/content/delve.ts';
import { RealmKind, SITES, TIDE_MS } from '../../src/server/world/realms.ts';
import { setTimeout as sleep } from 'node:timers/promises';
import { canWalk } from '../../src/shared/level.ts';

import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AiProfile } from '../../src/server/engine/actor.ts';
import { ActorKind } from '../../src/shared/protocol.ts';
import { createDownedState, goDown } from '../../src/server/engine/downed.ts';
import { createPartyState, membersOf } from '../../src/server/engine/party.ts';
import { wsGateway } from '../../src/server/net/gateway.ts';
import { createTurnEngine } from '../../src/server/turn-engine.ts';
import { createRealms } from '../../src/server/world/realms.ts';
import { PROTOCOL_VERSION } from '../../src/shared/version.ts';
import { STAT_POINTS_PER_LEVEL } from '../../src/shared/progression.ts';
import type { PartyState } from '../../src/server/engine/party.ts';
import type { Realms } from '../../src/server/world/realms.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * TWO PEOPLE IN ONE WORLD — THE PILLAR WITH NO END-TO-END TEST.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * This game exists to be played by three to six friends in a voice channel, and
 * every socket test in this repo until now drove exactly one of them. The party
 * machinery has unit tests, the barrier has unit tests, and nothing had ever
 * asserted the thing the whole design is for: that a second person joining is
 * visible, coherent, and not quietly misrepresented.
 *
 * ═══ WRITTEN AFTER CHECKING BY HAND, AND EVERY WORRY WAS UNFOUNDED ═══
 * Driven manually first, expecting to find a gap. There was not one:
 *
 *   - A sees `Player 2 arrives.` in the Case Log.
 *   - B's `welcome` carries both bodies, so they can see each other immediately.
 *   - The party pane draws `party_state` and NOTHING ELSE, so each of them is
 *     honestly shown alone until somebody invites — `ui/partypanel.ts` records
 *     fixing exactly the bug I went looking for, where "a player alone on the
 *     floor was shown a party they were not in".
 *   - Right-clicking the other body offers `Invite to party` (`ui/verbs.ts`).
 *
 * So this file is not a bug fix. It is the hand-check made permanent, because
 * the co-op surface being correct and the co-op surface being GUARDED are
 * different things, and the second one is what survives the next refactor.
 *
 * THE ONE ASYMMETRY IS REAL AND IS ASSERTED BELOW: the `party` frame lists
 * everybody in the realm and `party_state` lists your actual party. They are two
 * different questions — who is here, and who am I playing with — and experience
 * follows the second one.
 */

const FRAME_TIMEOUT_MS = 4_000;

type Frame = Record<string, unknown>;

type Client = {
  send(frame: Frame): void;
  hello(): Promise<string>;
  latest(type: string): Frame | undefined;
  count(type: string): number;
  lines(): string[];
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

  const client: Client = {
    send(frame: Frame): void {
      socket.send(JSON.stringify({ v: PROTOCOL_VERSION, ...frame }));
    },
    async hello(): Promise<string> {
      client.send({ t: 'hello' });
      const deadline = Date.now() + FRAME_TIMEOUT_MS;
      for (;;) {
        const id = frames.find((f) => f['t'] === 'welcome')?.['selfId'];
        if (typeof id === 'string') return id;
        if (Date.now() >= deadline) throw new Error('no welcome came back');
        await sleep(5);
      }
    },
    latest(type: string): Frame | undefined {
      return [...frames].reverse().find((f) => f['t'] === type);
    },
    /** How many of a kind have arrived — for telling "a frame came" from "one was already here". */
    count(type: string): number {
      return frames.filter((f) => f['t'] === type).length;
    },
    lines(): string[] {
      const out: string[] = [];
      for (const frame of frames) {
        if (frame['t'] !== 'log') continue;
        const rows = frame['lines'];
        if (!Array.isArray(rows)) continue;
        for (const row of rows as unknown[]) {
          const text = (row as Record<string, unknown>)['text'];
          if (typeof text === 'string') out.push(text);
        }
      }
      return out;
    },
    close(): void {
      socket.close();
    },
  };

  openClients.push(client);
  return client;
}

type Harness = {
  downed: ReturnType<typeof createDownedState>;
  port: number;
  realms: Realms;
  parties: PartyState;
  close: () => Promise<void>;
};
let server: Harness;

beforeEach(async () => {
  const downed = createDownedState();
  const parties = createPartyState();
  const realms = createRealms({
    seed: 'two-players',
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
    downed,
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

/** Every name in a frame's `members` array. */
function membersIn(frame: Frame | undefined): string[] {
  const rows = frame?.['members'];
  if (!Array.isArray(rows)) return [];
  return (rows as unknown[]).map((row) => String((row as Record<string, unknown>)['name']));
}

describe('somebody else turns up', () => {
  it('tells the person already here, and shows them to each other', async () => {
    const first = await connect(server.port);
    await first.hello();
    await sleep(100);
    const before = first.lines().length;

    const second = await connect(server.port);
    await second.hello();
    await sleep(200);

    // THE ARRIVAL IS AN EVENT, not something you notice by looking at the map.
    expect(
      first
        .lines()
        .slice(before)
        .some((line) => line.includes('arrives')),
    ).toBe(true);

    // AND THE NEWCOMER CAN SEE WHO WAS ALREADY STANDING THERE. `welcome` carries
    // the actor list, so there is no window where the world looks empty.
    const seen = second.latest('welcome')?.['actors'];
    expect(Array.isArray(seen)).toBe(true);
    expect((seen as unknown[]).length).toBeGreaterThan(1);
  });

  it('tells the newcomer who is already out here', async () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE ARRIVAL ANNOUNCEMENT POINTED ONE WAY, AND IT WAS THE WRONG WAY.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * MEASURED with two clients on a real server: the player already standing
     * there is told "Player 2 arrives", and the transcript of EVERYTHING the
     * newcomer ever saw contains no mention of the person on the moor with them.
     * Three runs, identical.
     *
     * The test above pins the half that worked, and its second assertion is why
     * this one is separate: `welcome` carrying an actor list means the newcomer
     * can SEE them if they happen to be on screen. That is not the same as being
     * TOLD, and this game narrates through its log — a body two hundred tiles
     * away is off screen by definition.
     *
     * IT MATTERS BECAUSE OF WHO IS BEING LEFT OUT. Fewer than ten people play
     * this, `awardExperience` pays every party member a FULL share with no
     * division, and `partyHint` calls that incentive "enormous and entirely
     * invisible". The person who has just decided to play is the one best placed
     * to start a party and the one the game left wondering if they were alone.
     */
    const first = await connect(server.port);
    await first.hello();
    await sleep(150);

    const second = await connect(server.port);
    await second.hello();
    await sleep(300);

    // ═══ THE ASSERTION THAT WAS FAILING ═══
    const told = second.lines().find((line) => line.startsWith('Here with you:'));
    expect(
      told,
      `the newcomer was told nothing — log was: ${second.lines().join(' | ')}`,
    ).toBeDefined();

    // BY NAME, because somebody in your own realm is somebody you can walk up
    // to. The count-only form is for people in another room; see the note in
    // `announceArrival`.
    const already = first.latest('welcome')?.['selfId'];
    const whoever = (second.latest('welcome')?.['actors'] ?? []) as { id: string; name: string }[];
    const theirName = whoever.find((a) => a.id === already)?.name;
    expect(theirName, 'could not read the first player name').toBeDefined();
    if (theirName !== undefined) expect(told).toContain(theirName);
  });

  it('says nothing at all to somebody who really is alone', async () => {
    /**
     * ═══ THE HALF THAT MUST NOT MOVE ═══
     * "You are alone out here" is a true sentence and a discouraging one, and a
     * solo player has not asked the question. The whole value of the line is on
     * the evening somebody else IS on — so it fires then and only then.
     */
    const only = await connect(server.port);
    await only.hello();
    await sleep(300);

    const lines = only.lines();
    expect(lines.filter((l) => l.startsWith('Here with you:'))).toEqual([]);
    expect(lines.filter((l) => l.startsWith('Working tonight:'))).toEqual([]);
    // AND THE SETUP HAS TO BE WHAT IT CLAIMS. A run where the arrival never
    // happened would pass this by saying nothing for the wrong reason.
    expect(lines.length, 'nothing was said at all — did the player arrive?').toBeGreaterThan(0);
  });

  it('does not pretend two strangers are playing together', async () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE ONE THING THAT WOULD MATTER IF IT WERE WRONG.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `awardExperience` pays `membersOf(parties, killerId)` — the actual party,
     * not everybody in the room. So two people standing side by side who have
     * not partied are each earning alone, and a pane that showed them as a party
     * would be teaching them to expect a share they are not getting.
     *
     * `ui/partypanel.ts` draws `party_state` and nothing else, and its header
     * records fixing this exact bug once already: *"a player alone on the floor
     * was shown a party they were not in"*. This is that fix, asserted from the
     * wire rather than from the comment.
     */
    const first = await connect(server.port);
    const firstId = await first.hello();
    const second = await connect(server.port);
    const secondId = await second.hello();
    await sleep(200);

    // THE PARTY IS HONEST: each of them is alone in it.
    expect(membersIn(second.latest('party_state'))).toHaveLength(1);
    expect(membersIn(first.latest('party_state'))).toHaveLength(1);

    // AND THE ENGINE AGREES, which is what makes the pane's honesty matter:
    // experience follows this list, so a shared pane over separate parties would
    // be a promise the scheduler does not keep.
    expect(membersOf(server.parties, firstId)).toEqual([firstId]);
    expect(membersOf(server.parties, secondId)).toEqual([secondId]);
  });

  it('lists everyone present in the OTHER frame, which is a different question', async () => {
    /**
     * `party` is who is HERE and `party_state` is who you are PLAYING WITH. Two
     * frames because they are two questions — the turn strip needs everybody in
     * the realm to draw a card per body, and the party pane needs your own
     * party. Asserting the difference so neither is ever "simplified" into the
     * other by somebody who finds two frames redundant.
     */
    const first = await connect(server.port);
    await first.hello();
    const second = await connect(server.port);
    await second.hello();
    await sleep(200);

    expect(membersIn(second.latest('party'))).toHaveLength(2);
    expect(membersIn(second.latest('party_state'))).toHaveLength(1);
  });

  it('says what a level bought, not only that one happened', async () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE MOMENT THE CLASS STOPS BEING A COSTUME, AND IT HAD NO TEST.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * A character starts with four talents at rank 1 and **zero** points, which
     * `pointsForLevel` argues for at length: *"our four loadout talents, already
     * learned at level 1, ARE our birth grant"*, and 11 points against 16
     * purchasable steps is what keeps the panel a choice rather than a checklist.
     *
     * So level 2 is the first time a player decides anything, and MEASURED it is
     * two delves away — the quiet Drowned Chapel pays 12.8 and the Underworks
     * 16.0 against a threshold of 27, or nine lone roamers at 3.2 each.
     *
     * ═══ AND THIS BEAT HAS ALREADY BEEN HALF-BROKEN ONCE ═══
     * `ProgressMsg` is viewer-private, so before the Record line existed *"a
     * party could cross three levels in its first fight and finish the evening
     * with every talent at rank 1 because nothing ever suggested opening the
     * panel."* The fix for that announced the LEVEL and still never mentioned the
     * POINT — *"the reader is told something happened and not what it bought
     * them"* — and the second line was added afterwards.
     *
     * Two lines, two separate regressions, and nothing guarded either. A
     * refactor that dropped the `granted > 0` block would have passed the whole
     * suite.
     */
    const a = await connect(server.port);
    const actorId = await a.hello();
    await sleep(250);

    const world = server.realms.overworld.world;
    const body = world.getActor(actorId);
    // NARROWED ON `kind`, the way `projectPartyState` does it: `level`, `xp` and
    // `unspentPoints` live on `PlayerActor` and the union does not carry them.
    if (body === undefined || body.kind !== ActorKind.Player) throw new Error('no player body');
    // Enough to survive the husk swinging back; a corpse levels nobody.
    body.maxHp = 9000;
    body.hp = 9000;

    // ONE KILL SHORT OF THE THRESHOLD. Asserted rather than assumed, because a
    // probe that reads a level-up it did not cause is the whole failure mode.
    expect(body.level, 'a fresh body is not level 1').toBe(1);
    expect(body.unspentPoints, 'a fresh body already had points').toBe(0);
    body.xp = 26;

    let spot: { x: number; y: number; dir: string } | null = null;
    for (const [dx, dy, dir] of [
      [1, 0, 'e'],
      [-1, 0, 'w'],
      [0, 1, 's'],
      [0, -1, 'n'],
    ] as const) {
      const x = body.x + dx;
      const y = body.y + dy;
      if (canWalk(world.level, x, y) && world.actorAt(x, y) === undefined) {
        spot = { x, y, dir };
        break;
      }
    }
    expect(spot, 'nowhere to stand a husk').not.toBeNull();
    if (spot === null) return;
    world.addMonster('husk_levelling', {
      name: 'Index Husk',
      sprite: 'enemy_index_husk_s',
      x: spot.x,
      y: spot.y,
      // ONE HIT POINT. This test is about what is SAID, and a husk that survives
      // three swings makes it about the damage roll instead.
      maxHp: 1,
      profile: AiProfile.MeleeChaser,
    });

    const before = a.lines().length;
    for (let i = 0; i < 8 && world.getActor('husk_levelling') !== undefined; i += 1) {
      a.send({ t: 'move', dir: spot.dir });
      await sleep(160);
    }
    await sleep(250);

    expect(world.getActor('husk_levelling'), 'the husk never died').toBeUndefined();
    const after = world.getActor(actorId);
    expect(after !== undefined && after.kind === ActorKind.Player).toBe(true);
    if (after === undefined || after.kind !== ActorKind.Player) return;
    expect(after.level, 'the kill did not level them').toBe(2);
    expect(after.unspentPoints, 'the level granted no point').toBe(1);

    const said = a.lines().slice(before);
    expect(
      said.some((text) => text.includes('reaches level 2')),
      `no level line — ${JSON.stringify(said)}`,
    ).toBe(true);
    // THE SECOND LINE, AND THE ONE THAT WAS MISSING FOR A WHILE. Asserted
    // separately so dropping it fails on its own terms rather than hiding behind
    // the level line.
    expect(
      said.some((text) => text.includes('talent point')),
      `the level was announced and the point was not — ${JSON.stringify(said)}`,
    ).toBe(true);
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * AND THE GENERIC POINT, WHICH ARRIVED AT FOUR LEVELS IN FIVE IN SILENCE.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `genericPointsForLevel` had exactly ONE caller in the whole server — the
     * line that grants it. The comment above says the talent point "was missing
     * for a while"; the two purses added after it were never given the same
     * treatment, and a category point (three in a fifty-level career, and it
     * buys a whole discipline) arrived with no word at all.
     *
     * ASSERTED SEPARATELY, on the same grounds the line above states: dropping
     * one must fail on its own terms rather than hiding behind the others.
     */
    expect(
      said.some((text) => text.includes('generic point')),
      `the generic point was granted and not announced — ${JSON.stringify(said)}`,
    ).toBe(true);

    /**
     * ═══════════════════════════════════════════════════════════════════════
     * AND THE OTHER CURRENCY, WHICH ARRIVED SILENTLY FOR TWO COMMITS.
     * ═══════════════════════════════════════════════════════════════════════
     * The assertion above exists because announcing the LEVEL and not the POINT
     * tells a reader something happened and not what it bought them. Attributes
     * landed with the grant wired and no sentence at all — three points a level
     * appearing in a panel nobody had been given a reason to open, which is the
     * same bug one currency over.
     *
     * THE COUNT IS READ FROM THE GRANT rather than written as `3`, exactly as
     * the gateway composes it: a literal here would go on passing the day the
     * grant changed and only for the players who got the other number.
     */
    expect(after.unspentStatPoints, 'the level granted no attribute points').toBe(
      STAT_POINTS_PER_LEVEL,
    );
    expect(
      said.some((text) => text.includes('attribute point')),
      `the attribute points were granted and not announced — ${JSON.stringify(said)}`,
    ).toBe(true);
  });

  it('says what changed when you put something on', async () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE MARGIN ASKED THE QUESTION AND NEVER ANSWERED IT.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `pickup` sends *"Nothing on your back yet."* — unicast, margin, advice —
     * and it is a good nudge: an observation that implies an action rather than
     * a tutorial naming a key.
     *
     * MEASURED by driving the whole first session over a socket
     * (`tools/first-session.mjs`): a player who FOLLOWS that nudge, opens the
     * bag and equips, was told **nothing at all**. The only way to learn whether
     * the key had worked was to open another panel and compare a number they had
     * never been shown.
     *
     * The Case Log stays quiet and that is deliberate — `handleEquip` argues it,
     * and the argument is about the RECORD, which the party reads to work out
     * what killed them. It was never an argument for silence toward the person
     * who just got dressed.
     *
     * THE NUMBER IS THE POINT. `equipment.test.ts` measures a full kit at armour
     * 6 -> 16, and a player shown neither end of that reads their own
     * survivability as luck.
     */
    const a = await connect(server.port);
    const actorId = await a.hello();
    await sleep(250);

    const body = server.realms.overworld.world.getActor(actorId);
    if (body === undefined) throw new Error('no body');
    // In the bag, which is where a pickup would have put it.
    body.carried = ['item_watchmans_coat'];
    const before = a.lines().length;

    a.send({ t: 'equip', itemId: 'item_watchmans_coat' });
    await sleep(300);

    // THE SETUP IS ASSERTED BEFORE THE RESULT: an equip that silently refused
    // would leave the bag full and make the missing line look like the bug.
    expect(
      server.realms.overworld.world.getActor(actorId)?.equipped?.['body'],
      'the coat never went on',
    ).toBe('item_watchmans_coat');

    const said = a.lines().slice(before);
    const line = said.find((text) => text.includes("Watchman's Coat"));
    expect(line, `nothing was said — the log added: ${JSON.stringify(said)}`).toBeDefined();
    expect(line, 'the line does not carry the number the detour was for').toMatch(
      /Armour \d+ -> \d+/,
    );
  });

  it('says only what went on when the number does not move', async () => {
    /**
     * THE CONTROL, and the reason the line is conditional.
     *
     * A badge changes `atk` and no armour at all. *"Armour 9 -> 9"* would be the
     * noise `handleEquip`'s own paragraph refuses, so a piece that moves nothing
     * says what went on and stops. Without this, a change that always printed the
     * number would pass the test above and be wrong seven slots out of eight.
     */
    const a = await connect(server.port);
    const actorId = await a.hello();
    await sleep(250);

    const body = server.realms.overworld.world.getActor(actorId);
    if (body === undefined) throw new Error('no body');
    body.carried = ['item_watchmans_badge'];
    const before = a.lines().length;

    a.send({ t: 'equip', itemId: 'item_watchmans_badge' });
    await sleep(300);

    expect(
      server.realms.overworld.world.getActor(actorId)?.equipped?.['trinket'],
      'the badge never went on',
    ).toBe('item_watchmans_badge');

    const line = a
      .lines()
      .slice(before)
      .find((text) => text.includes("Watchman's Badge"));
    expect(line, 'the badge went on in silence').toBeDefined();
    expect(line, 'a badge reported an armour change it did not make').not.toMatch(/Armour/);
  });

  it('answers a refused rule with the sentence about that rule', async () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE RIGHT SENTENCE EXISTED AND THE PLAYER NEVER SAW IT.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * The client renders `refusalText(msg.code)` on the canvas; `msg.message` is
     * the developer's copy, in the status line and the console. So the CODE is
     * what a player reads, and every one of these rode a code about something
     * else:
     *
     *   invite yourself   -> `not_your_turn` -> "not your turn yet — the clock
     *                        has not asked you", while `partyRefusalText`'s
     *                        "you cannot invite yourself" went unseen.
     *   revive empty air  -> `illegal_move`  -> "you cannot go that way", for a
     *                        key pressed to help somebody.
     *
     * `Refused` means *the message IS the sentence*, and the client shows it
     * verbatim. Asserted on BOTH halves — a code with the wrong words, or the
     * right words under `not_your_turn`, are each the bug this fixes.
     */
    const a = await connect(server.port);
    const aId = await a.hello();
    await sleep(200);

    const cases: readonly (readonly [string, Frame, string])[] = [
      ['invite yourself', { t: 'party', action: 'invite', targetId: aId }, 'invite yourself'],
      ['revive empty air', { t: 'revive', dir: 'n' }, 'lying there'],
      ['respawn upright', { t: 'respawn' }, 'on your feet'],
    ];

    for (const [label, frame, fragment] of cases) {
      a.send(frame);
      await sleep(220);
      const err = a.latest('error') as { code?: string; message?: string } | undefined;
      expect(err, `${label} was not refused at all`).toBeDefined();
      expect(err?.code, `${label} answered with a code about something else`).toBe('refused');
      expect(err?.message, `${label} did not carry its own sentence`).toContain(fragment);
    }
  });

  it('still calls a wall a wall', async () => {
    /**
     * THE CONTROL, and the reason the routing table has a default.
     *
     * Walking into terrain is the commonest refusal in the game and
     * `illegal_move` is exactly right for it — the client turns it into "you
     * cannot go that way". A change that made every refusal `refused` would have
     * traded one wrong sentence for another, and this is what would catch it.
     */
    const a = await connect(server.port);
    const actorId = await a.hello();
    await sleep(200);

    // A WALL, FOUND RATHER THAN ASSUMED. Bodies are placed through the map here
    // for the same reason they are everywhere else in this file.
    const world = server.realms.overworld.world;
    const body = world.getActor(actorId);
    if (body === undefined) throw new Error('no body');
    /**
     * A WALL, WALKED TO RATHER THAN ASSUMED ADJACENT.
     *
     * The redesigned moor gives the gate a courtyard, so the spawn now has open
     * ground on all four sides and the old version of this found no wall at all.
     * Stepping east until something refuses is what a player does anyway.
     */
    let into: string | null = null;
    for (let step = 0; step < 40 && into === null; step += 1) {
      if (!canWalk(world.level, body.x + 1, body.y)) {
        into = 'e';
        break;
      }
      body.x += 1;
    }
    expect(into, 'the spawn has open ground on all four sides').not.toBeNull();
    if (into === null) return;

    a.send({ t: 'move', dir: into });
    await sleep(300);
    const err = a.latest('error') as { code?: string } | undefined;
    expect(err?.code, 'a wall stopped reading as a wall').toBe('illegal_move');
  });

  it('tells an Inspector she is too close rather than that she cannot go that way', async () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE FIX FOR A PLAYTESTED BUG WAS IN THE CODEBASE AND UNREACHABLE.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `minRange: 3` is on the Inspector's combat sheet, so walking into an
     * adjacent husk is `AttackRefusal.MinRange` — the class's whole counterplay,
     * and combat.ts:52 exists, in its own words, *"precisely so the log can say
     * 'too close' instead of eating the turn silently"*.
     *
     * The refund loop forwarded every resolution refusal as `illegal_move`, so
     * the log said *"you cannot go that way"* — while the client held the
     * sentence written for exactly this case, from exactly this case: *"a
     * scripted Inspector bump-attacking the opening ambush stalled 3 runs in 12,
     * doing nothing, forever — which is precisely what a new player does."*
     *
     * Asserted on the CODE, because the code is what selects that sentence.
     */
    const a = await connect(server.port);
    const actorId = await a.hello();
    await sleep(200);
    a.send({ t: 'choose_class', classId: 'inspector' });
    await sleep(300);

    const world = server.realms.overworld.world;
    const body = world.getActor(actorId);
    if (body === undefined) throw new Error('no body');
    // Enough to survive whatever the husk does back; a corpse cannot be refused.
    body.maxHp = 9000;
    body.hp = 9000;

    let spot: { x: number; y: number; dir: string } | null = null;
    for (const [dx, dy, dir] of [
      [1, 0, 'e'],
      [-1, 0, 'w'],
      [0, 1, 's'],
      [0, -1, 'n'],
    ] as const) {
      const x = body.x + dx;
      const y = body.y + dy;
      if (canWalk(world.level, x, y) && world.actorAt(x, y) === undefined) {
        spot = { x, y, dir };
        break;
      }
    }
    expect(spot, 'nowhere to stand a husk').not.toBeNull();
    if (spot === null) return;
    const husk = world.addMonster('husk_deadzone', {
      name: 'Index Husk',
      sprite: 'enemy_index_husk_s',
      x: spot.x,
      y: spot.y,
      profile: AiProfile.MeleeChaser,
      maxHp: 5000,
    });
    // THE MEASUREMENT ONLY MEANS ANYTHING IF IT IS ACTUALLY ADJACENT. A first
    // version of this asserted against a husk `addMonster` had relocated, and
    // read `terrain` — the player had walked into a wall.
    expect(Math.max(Math.abs(husk.x - body.x), Math.abs(husk.y - body.y))).toBe(1);

    a.send({ t: 'move', dir: spot.dir });
    await sleep(350);
    const err = a.latest('error') as { code?: string; message?: string } | undefined;
    expect(err, 'the dead-zone bump was not refused').toBeDefined();
    expect(err?.code, `the Inspector was told the wrong thing: ${JSON.stringify(err)}`).toBe(
      'too_close',
    );
  });

  it('trades places with a party member instead of treating them as a wall', async () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * A FRIEND IN THE DOORWAY WAS A WALL.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * Ported from Combat.lua:32-74 (`Actor:bumpInto`, the `reaction >= 0` half),
     * switched on for party members by Party.lua:271-272 and for the player at
     * birth by descriptors.lua:60.
     *
     * FOUND WHILE MEASURING SOMETHING ELSE: a player following a friend into a
     * delve arrives at the way out, and with anybody standing on it the only
     * route in is through them — twelve consecutive steps, no movement. The
     * refusal WAS delivered (`refused at resolution: occupied`, unicast), so it
     * was never silent; an accurate error message is simply not the answer to
     * *"my friend is in the doorway"*.
     */
    const a = await connect(server.port);
    const aId = await a.hello();
    const b = await connect(server.port);
    const bId = await b.hello();
    await sleep(200);
    a.send({ t: 'party', action: 'invite', targetId: bId });
    await sleep(140);
    b.send({ t: 'party', action: 'accept', targetId: aId });
    await sleep(250);

    const world = server.realms.overworld.world;
    const ab = world.getActor(aId);
    const bb = world.getActor(bId);
    if (ab === undefined || bb === undefined) throw new Error('no bodies');
    bb.x = ab.x + 1;
    bb.y = ab.y;
    const a0 = { x: ab.x, y: ab.y };
    const b0 = { x: bb.x, y: bb.y };

    a.send({ t: 'move', dir: 'e' });
    // The barrier: B is standing and owes the turn too, or nothing resolves.
    b.send({ t: 'hold' });
    await sleep(450);

    const a1 = world.getActor(aId);
    const b1 = world.getActor(bId);
    expect({ x: a1?.x, y: a1?.y }, 'the mover did not take the tile').toEqual(b0);
    // BOTH HALVES. Asserting only the mover would pass if the other body were
    // deleted, left behind, or put anywhere at all.
    expect({ x: b1?.x, y: b1?.y }, 'the other body was not moved out').toEqual(a0);
    expect(a.latest('error'), 'a successful swap must refuse nothing').toBeUndefined();
  });

  it('attacks a monster rather than trading places with it', async () => {
    /**
     * A HOSTILE BUMP IS STILL AN ATTACK, end to end over a socket.
     *
     * IT DOES NOT PIN THE SWAP'S KIND TEST, and the first version of this
     * comment claimed it did. Reverting the rule is what found otherwise: with
     * the kind test deleted this still passed, because the hostile branch
     * returns long before the swap is reached. The gate is pinned in
     * test/server/ally-swap.test.ts, against a TOWNSFOLK — the only non-hostile
     * non-player an engine test can put on a tile.
     *
     * Asserted by POSITION rather than by hit points: the blow can miss, and a
     * test that read damage would be flaky for a reason that has nothing to do
     * with what it is about. Where the two bodies stand afterwards is the fact.
     */
    const a = await connect(server.port);
    const aId = await a.hello();
    await sleep(200);

    const world = server.realms.overworld.world;
    const body = world.getActor(aId);
    if (body === undefined) throw new Error('no body');
    const target = { x: body.x + 1, y: body.y };
    const mob = world.addMonster('m_swap_probe', {
      name: 'Index Husk',
      sprite: 'enemy_index_husk_s',
      x: target.x,
      y: target.y,
      profile: AiProfile.MeleeChaser,
      // ENOUGH TO SURVIVE THE BUMP. A monster that dies takes its body off the
      // board and the position assertion below loses its subject — see the
      // note there about measuring a corpse.
      maxHp: 500,
    });
    expect(mob, 'the monster would not stand there').toBeDefined();
    const mine = { x: body.x, y: body.y };

    a.send({ t: 'move', dir: 'e' });
    await sleep(450);

    const after = world.getActor(aId);
    expect({ x: after?.x, y: after?.y }, 'the player swapped with a MONSTER').toEqual(mine);
    const beast = world.getActor(mob.id);
    // Dead is a legitimate outcome of a bump; standing on the player's old tile
    // is not.
    if (beast !== undefined) {
      expect({ x: beast.x, y: beast.y }, 'the monster took the player tile').toEqual(target);
    }
  });

  it('marks the door a party member went through, and only that one', async () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * "WHERE IS EVERYBODY" WAS SILENCE FOR THE PEOPLE HARDEST TO FIND.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `partyMarks` puts a mark on the world map for every member standing on it
     * and deliberately omits anybody inside an instance, because their
     * coordinates belong to another level. Honest, and half a picture: the map
     * draws all seventeen doors, and the one fact it did not carry was which of
     * them somebody is behind.
     *
     * ═══ AND THE OBVIOUS JOIN WAS MEASURED AND REJECTED ═══
     * `away.place === site.name` looks sufficient — all twenty-two realms do
     * carry their site's name — and **six of those names are duplicated across
     * the two landmasses**: `redaction:underworks` is "The Underworks" and so is
     * `underworks`. A name join would mark the Alderbrook door for a friend
     * standing in the Redaction, which is not a missing mark but a confident lie.
     *
     * So the server joins by SITE ID, where it holds both the realm registry and
     * the party table, and the client draws what it is told.
     *
     * THE "ONLY THAT ONE" HALF IS THE POINT. A test that just found the friend's
     * name somewhere in the site list would pass on a join that marked every
     * door in the game.
     */
    const outside = await connect(server.port);
    const outsideId = await outside.hello();
    const delver = await connect(server.port);
    const delverId = await delver.hello();
    await sleep(200);
    outside.send({ t: 'party', action: 'invite', targetId: delverId });
    await sleep(150);
    delver.send({ t: 'party', action: 'accept', targetId: outsideId });
    await sleep(250);
    expect(membersOf(server.parties, outsideId)).toHaveLength(2);

    const door = [...server.realms.overworld.sites][0];
    if (door === undefined) throw new Error('the overworld has no doors');
    const [xs, ys] = door[0].split(',');
    const body = server.realms.overworld.world.getActor(delverId);
    if (body === undefined) throw new Error('no body');
    body.x = Number(xs) - 1;
    body.y = Number(ys);
    delver.send({ t: 'move', dir: 'e' });
    await sleep(400);

    // THE SETUP, ASSERTED BEFORE THE RESULT. A delver who never crossed would
    // make "no door is marked" look like the join failing.
    expect(server.realms.realmOf(delverId)?.siteId, 'the delver never crossed').toBe(door[1]);

    /**
     * READ OFF THE `sites` FRAME, NOT `realm`.
     *
     * `realm` carries the whole board and is sent on a CROSSING; `sites` is the
     * marker-only frame and is what a viewer standing still receives. A first
     * version of this read `realm.sites`, got the frame from before the delver
     * had moved, and reported the join as broken when it was the probe reading
     * a stale board.
     *
     * The viewer is deliberately NOT made to move: the whole point is that the
     * map corrects itself for somebody who is standing still, because a mark
     * that appears only when you happen to walk is indistinguishable from none.
     */
    const sites = (outside.latest('sites')?.sites ?? []) as readonly Record<string, unknown>[];
    expect(sites.length, 'the viewer got no sites at all').toBeGreaterThan(0);
    const marked = sites.filter((site) => Array.isArray(site.party) && site.party.length > 0);
    expect(
      marked.length,
      `expected exactly one marked door, got ${JSON.stringify(marked.map((m) => m.name))}`,
    ).toBe(1);
    expect(marked[0]?.x).toBe(Number(xs));
    expect(marked[0]?.y).toBe(Number(ys));
    expect(marked[0]?.party).toEqual(['Player 2']);

    /**
     * ═══════════════════════════════════════════════════════════════════════
     * AND IT MUST COME BACK OFF WHEN THEY LEAVE — WHICH IS THE HALF THAT
     * ISOLATES THE DELIVERY.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * The mark APPEARING proves less than it looks: the delver's crossing step
     * is a move on the OVERWORLD, so it pumps the overworld, and the roamer tick
     * sends every overworld session a fresh `sites` frame whenever a roamer
     * happens to shuffle. Reverting the delivery hook left this test green for
     * exactly that reason.
     *
     * Walking back OUT pumps the DELVE and nothing else — no overworld pump, no
     * roamer tick, no other reason for this viewer to be sent anything at all.
     * If the mark is still on the door here, the map is telling somebody their
     * friend is in a room they walked out of.
     */
    const gate = server.realms.realmOf(delverId)?.spawns[0];
    expect(gate, 'the delve has no way out').toBeDefined();
    if (gate === undefined) return;
    /**
     * WALKED, NOT PLACED. `Session.exitArmed` is set by a MOVE that lands off
     * the threshold — arriving on it leaves the door disarmed on purpose, so
     * that the shuffle across a spawn cluster is not a decision to go. Writing
     * x/y past it looks like the same thing and leaves the exit unarmed, which
     * reads as the crossing being broken.
     */
    for (const dir of ['e', 'n', 's', 'w', 'w'] as const) {
      if (server.realms.realmOf(delverId)?.siteId === undefined) break;
      delver.send({ t: 'move', dir });
      await sleep(160);
      const at = server.realms.realmOf(delverId)?.world.getActor(delverId);
      // Back onto the threshold once we have stepped off it.
      if (at !== undefined && (at.x !== gate.x || at.y !== gate.y)) {
        const dx = gate.x > at.x ? 'e' : gate.x < at.x ? 'w' : '';
        const dy = gate.y > at.y ? 's' : gate.y < at.y ? 'n' : '';
        const back = `${dy}${dx}`;
        if (back !== '') {
          delver.send({ t: 'move', dir: back });
          await sleep(160);
        }
      }
    }
    await sleep(250);
    expect(server.realms.realmOf(delverId)?.siteId, 'the delver never left').toBeUndefined();

    const after = (outside.latest('sites')?.sites ?? []) as readonly Record<string, unknown>[];
    const still = after.filter((site) => Array.isArray(site.party) && site.party.length > 0);
    expect(still, 'the door still names somebody who has walked back out of it').toEqual([]);
  });

  it('updates a standing viewer when somebody FOLLOWS, which pumps nothing here', async () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE ONE SCENARIO THAT ISOLATES THE DELIVERY, AND IT TOOK TWO FAILED
     * ATTEMPTS TO FIND.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `SiteView.party` is computed correctly and something has to SEND it.
     * `sendSites` fires on three occasions — a case filed, the roamers moving,
     * fog uncovering a hidden site — and a friend walking through a door is none
     * of them.
     *
     * But proving that is harder than it looks, and reverting the hook is what
     * showed it: a delver's crossing STEP is a move on the overworld, so it
     * pumps the overworld, so `tickRoamers` sends every overworld session a
     * fresh frame whenever a roamer happens to shuffle. Walking back OUT has the
     * same problem — the exit lands them on the overworld and `handleMove` pumps
     * it. Both versions of this test stayed green with the delivery removed.
     *
     * ═══ AND IT DOES NOT ISOLATE THE HOOK. THE REASON IS WORTH KNOWING ═══
     * Reverting `refreshPartySites` leaves this green, and chasing why is what
     * finally explained the delivery. `crossIntoRealm` ends in
     * `pumpAndBroadcast()` — no argument, so EVERY realm pumps, the overworld
     * included — and `pumpRealm` re-sends `sites` to everyone standing there.
     *
     * But only `if (tickRoamers(...))`, and roamers step once every
     * `MOVE_EVERY_TURNS` = **3** pumps. So the incidental refresh covers two
     * crossings in three, and the third leaves a friend marked on a door they
     * have walked out of until a roamer happens to move.
     *
     * The hook is what makes it every crossing. This test asserts the OUTCOME a
     * player sees, which is true either way; the guarantee is the arithmetic
     * above, and a test that pinned it would be pinning the roamer schedule.
     */
    const outside = await connect(server.port);
    const outsideId = await outside.hello();
    const first = await connect(server.port);
    const firstId = await first.hello();
    const second = await connect(server.port);
    const secondId = await second.hello();
    await sleep(220);
    for (const id of [firstId, secondId]) {
      outside.send({ t: 'party', action: 'invite', targetId: id });
      await sleep(130);
    }
    first.send({ t: 'party', action: 'accept', targetId: outsideId });
    await sleep(140);
    second.send({ t: 'party', action: 'accept', targetId: outsideId });
    await sleep(220);
    expect(membersOf(server.parties, outsideId)).toHaveLength(3);

    const door = [...server.realms.overworld.sites][0];
    if (door === undefined) throw new Error('no doors');
    const [xs, ys] = door[0].split(',');
    const body = server.realms.overworld.world.getActor(firstId);
    if (body === undefined) throw new Error('no body');
    body.x = Number(xs) - 1;
    body.y = Number(ys);
    first.send({ t: 'move', dir: 'e' });
    await sleep(400);
    expect(server.realms.realmOf(firstId)?.siteId, 'the first never crossed').toBe(door[1]);

    // THE BASELINE, and it is asserted so the follow below is measured against a
    // known frame rather than against nothing.
    const before = ((outside.latest('sites')?.sites ?? []) as readonly Record<string, unknown>[])
      .filter((site) => Array.isArray(site.party) && site.party.length > 0)
      .flatMap((site) => site.party as readonly string[]);
    expect(before, 'the first player is not on the door yet').toEqual(['Player 2']);

    second.send({ t: 'follow', targetId: firstId });
    await sleep(350);
    expect(server.realms.realmOf(secondId)?.id, 'the second did not follow').toBe(
      server.realms.realmOf(firstId)?.id,
    );

    const named = ((outside.latest('sites')?.sites ?? []) as readonly Record<string, unknown>[])
      .filter((site) => Array.isArray(site.party) && site.party.length > 0)
      .flatMap((site) => site.party as readonly string[]);
    expect([...named].sort(), 'the viewer never learned the second player went in').toEqual([
      'Player 2',
      'Player 3',
    ]);
  });

  it('shows a party member elsewhere the clock they have to beat', async () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * "GET TO ME" IS ADDRESSED TO SOMEBODY WHO HAS TO BE TOLD.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * game-design.md § 9 says Downed exists because it turns *"I died"* into
     * *"GET TO ME"*. The countdown rode `PartyMember.downed`, which is scoped to
     * ONE FLOOR — so a member who walked into an instance and went down inside
     * it was described to the rest of their party by `hp` alone, and `hp: 0` is
     * what Downed, Erased and dead all read.
     *
     * ═══ AND THE FRAME DID NOT ARRIVE EITHER ═══
     * `refreshViewers` skipped every socket outside the pumped realm, on a note
     * saying that was *"a cost saving rather than a correctness one"* — true
     * when written, and untrue from the day `awayMembers` made this the one
     * frame that describes people who are not in the realm.
     *
     * MEASURED BEFORE THE FIX: the town player's pane read `60/60, committed`
     * — full health, taking their turn — while their friend lay at 0 hp on a
     * five-turn clock, and it stayed that way until they happened to take a
     * step.
     *
     * SO THIS ASSERTS BOTH HALVES AT ONCE, and the second one is the reason the
     * viewer here never moves: the frame must be PUSHED by the pump that is
     * happening somewhere else.
     */
    const town = await connect(server.port);
    const townId = await town.hello();
    const delver = await connect(server.port);
    const delverId = await delver.hello();
    const helper = await connect(server.port);
    const helperId = await helper.hello();
    await sleep(200);

    for (const [client, id] of [
      [town, delverId],
      [town, helperId],
    ] as const) {
      client.send({ t: 'party', action: 'invite', targetId: id });
      await sleep(120);
    }
    delver.send({ t: 'party', action: 'accept', targetId: townId });
    await sleep(150);
    helper.send({ t: 'party', action: 'accept', targetId: townId });
    await sleep(250);
    expect(membersOf(server.parties, townId)).toHaveLength(3);

    // BOTH OF THEM THROUGH THE DOOR, and the helper first.
    const door = [...server.realms.overworld.sites][0];
    if (door === undefined) throw new Error('the overworld has no doors');
    const [xs, ys] = door[0].split(',');
    for (const [client, id] of [
      [helper, helperId],
      [delver, delverId],
    ] as const) {
      const body = server.realms.overworld.world.getActor(id);
      if (body === undefined) throw new Error('no body');
      body.x = Number(xs) - 1;
      body.y = Number(ys);
      client.send({ t: 'move', dir: 'e' });
      await sleep(350);
    }
    const inner = server.realms.realmOf(delverId);
    expect(inner?.siteId, 'the delver never crossed').toBe(door[1]);
    expect(server.realms.realmOf(helperId)?.id, 'the two are not in one instance').toBe(inner?.id);

    // THE SCENARIO HAS TO BE SURVIVABLE TO BE THE ONE UNDER TEST. Downing the
    // only party member inside an instance is a WIPE, and the engine resolves
    // it by resetting the floor — correct, and not a rescue window. The helper
    // is standing here first for exactly that reason.
    const body = inner?.world.getActor(delverId);
    if (body === undefined) throw new Error('no delve body');
    expect(goDown(server.downed, body, 1), 'the engine refused to put them down').not.toBeNull();
    expect(body.hp).toBe(0);

    // ONE PUMP IN THE DELVE — in play the body goes down inside one, and it is
    // that pump which has to reach a party member who is somewhere else.
    helper.send({ t: 'move', dir: 'n' });
    await sleep(400);

    // AND THE VIEWER HAS NOT MOVED SINCE BEFORE ANY OF IT. That is the half a
    // memoised frame cannot fake.
    const row = (
      town.latest('party_state')?.members as readonly Record<string, unknown>[] | undefined
    )?.find((member) => member.id === delverId);
    expect(row, 'the party pane lost the row for a member in an instance').toBeDefined();
    expect(
      row?.downed,
      `told nothing about a member on the floor — the row read ${JSON.stringify(row)}`,
    ).toBeTruthy();
    const view = row?.downed as { status: string; turnsLeft: number; total: number };
    expect(view.status).toBe('downed');
    expect(view.total).toBe(5);
    // STILL RUNNING. A clock already at zero is not a rescue window, and a test
    // that passed on one would be asserting the wrong thing.
    expect(view.turnsLeft, 'the clock had already run out').toBeGreaterThan(0);
    expect(view.turnsLeft).toBeLessThanOrEqual(view.total);
  });

  it('tells a lone player at the door what the map already knew', async () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE WARNING WAS ON A SCREEN THEY MAY NOT HAVE OPEN.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `partyHint` publishes *"hard alone"* and *"bring a party"* beside every
     * marker on the world map — the right place for choosing where to go, and
     * the wrong place for the moment the advice becomes actionable. Arrival
     * carried the room's name and its blurb and nothing else.
     *
     * IT IS STILL ACTIONABLE AT THE DOOR, which is why it earns a line: the
     * arrival tile IS the way out, so somebody just told they are
     * under-strength can turn round having lost a step.
     */
    const client = await connect(server.port);
    const actorId = await client.hello();
    await sleep(150);

    // A GRADED ROOM, chosen from the registry rather than named, so the test
    // does not pin which site happens to carry which grade today.
    const graded = [...SITES].find(([id, def]) => {
      const spec = specFor(id);
      return def.kind === RealmKind.Inner && spec !== undefined && partyHint(spec) !== null;
    });
    expect(graded, 'no room in the game is graded high enough to warn about').toBeDefined();
    if (graded === undefined) return;

    const door = [...server.realms.overworld.sites].find(([, id]) => id === graded[0]);
    expect(door, `${graded[0]} has no door on the overworld`).toBeDefined();
    if (door === undefined) return;
    const [xs, ys] = door[0].split(',');
    const body = server.realms.overworld.world.getActor(actorId);
    if (body === undefined) throw new Error('no body');
    body.x = Number(xs) - 1;
    body.y = Number(ys);
    client.send({ t: 'move', dir: 'e' });
    await sleep(300);

    expect(server.realms.realmOf(actorId)?.siteId, 'never crossed').toBe(graded[0]);
    const warned = client.lines().filter((text) => text.startsWith('Graded '));
    expect(
      warned,
      `no warning — the log ended: ${client.lines().slice(-3).join(' | ')}`,
    ).toHaveLength(1);
    expect(warned[0]).toContain('You are one.');
  });

  it('says nothing at the door to a party that brought somebody', async () => {
    /**
     * THE HALF THAT KEEPS IT FROM BECOMING NOISE. `nearestSites` argues it about
     * the map and it applies here: *"a 'quiet' beside every settlement would
     * train a player to stop reading the word"*. The hints are about being
     * ALONE, so a party of two hears nothing — and a warning that fired for
     * everybody would be read by nobody.
     */
    const first = await connect(server.port);
    const firstId = await first.hello();
    const second = await connect(server.port);
    const secondId = await second.hello();
    await sleep(150);
    first.send({ t: 'party', action: 'invite', targetId: secondId });
    await sleep(150);
    second.send({ t: 'party', action: 'accept', targetId: firstId });
    await sleep(200);
    expect(membersOf(server.parties, firstId)).toHaveLength(2);

    const graded = [...SITES].find(([id, def]) => {
      const spec = specFor(id);
      return def.kind === RealmKind.Inner && spec !== undefined && partyHint(spec) !== null;
    });
    if (graded === undefined) throw new Error('no graded room');
    const door = [...server.realms.overworld.sites].find(([, id]) => id === graded[0]);
    if (door === undefined) throw new Error('no door');
    const [xs, ys] = door[0].split(',');
    const body = server.realms.overworld.world.getActor(firstId);
    if (body === undefined) throw new Error('no body');
    body.x = Number(xs) - 1;
    body.y = Number(ys);
    first.send({ t: 'move', dir: 'e' });
    await sleep(300);

    expect(server.realms.realmOf(firstId)?.siteId).toBe(graded[0]);
    expect(first.lines().filter((text) => text.startsWith('Graded '))).toHaveLength(0);
  });

  it('shows how strong the people you are playing with are', async () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * "BRING A PARTY" WITH NO WAY TO SEE THE PARTY IS HALF AN INSTRUCTION.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * The world map grades every room and `partyHint` turns the top of that
     * scale into *"bring a party"*; `populateDelve` then builds the floor
     * against `partyMaxLevel`. Both systems key off how strong the group is —
     * and the pane that exists to show a player who they are playing with
     * carried name, portrait, hit points and turn state, and not that number.
     *
     * DRIVEN OVER A SOCKET rather than asserted on the projector, because the
     * failure worth guarding is the field being dropped somewhere between the
     * body and the row — which is exactly what `save-completeness.test.ts` was
     * written for on the persistence side, and the same shape here.
     */
    const first = await connect(server.port);
    const firstId = await first.hello();
    const second = await connect(server.port);
    const secondId = await second.hello();
    await sleep(150);

    // A REAL DIFFERENCE BETWEEN THEM, so a row showing the wrong body's level
    // cannot pass by coincidence.
    const strong = server.realms.overworld.world.getActor(secondId);
    expect(strong).toBeDefined();
    if (strong === undefined || !('level' in strong)) throw new Error('no player body');
    strong.level = 6;

    first.send({ t: 'party', action: 'invite', targetId: secondId });
    await sleep(150);
    second.send({ t: 'party', action: 'accept', targetId: firstId });
    await sleep(250);

    const rows = first.latest('party_state')?.['members'];
    expect(Array.isArray(rows)).toBe(true);
    const seen = (rows as Record<string, unknown>[]).map((row) => ({
      name: String(row['name']),
      level: row['level'],
    }));
    expect(seen).toHaveLength(2);

    // EVERY ROW CARRIES ONE. A party of two where only your own row has a level
    // is the join failing in the direction nobody would notice.
    for (const row of seen) {
      expect(row.level, `${row.name} has no level on the pane`).toBeTypeOf('number');
    }
    // AND IT IS THE OTHER PLAYER'S OWN, not a copy of the viewer's.
    expect(seen.some((row) => row.level === 6)).toBe(true);
  });

  it('puts them in one party when one invites and the other accepts', async () => {
    // THE VERB EXISTS AND IS REACHABLE: `ui/verbs.ts` offers `Invite to party`
    // on a right-click of any player who is not already in yours. This is the
    // wire half of that gesture, and the state it is supposed to produce.
    const first = await connect(server.port);
    const firstId = await first.hello();
    const second = await connect(server.port);
    const secondId = await second.hello();
    await sleep(150);

    first.send({ t: 'party', action: 'invite', targetId: secondId });
    await sleep(150);
    second.send({ t: 'party', action: 'accept', targetId: firstId });
    await sleep(200);

    expect(membersOf(server.parties, firstId)).toHaveLength(2);
    expect(membersOf(server.parties, secondId)).toContain(firstId);
    // …and the pane now says so, for both of them.
    expect(membersIn(second.latest('party_state'))).toHaveLength(2);
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A ROOM BUILT FOR FOUR, WALKED INTO BY ONE, SAYS SO.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `crossIntoRealm` sizes a delve from the PARTY ROSTER, not from who actually
 * walks in, and its comment argues that well: *"One person opening a door for a
 * party of four is opening it for four, and the room should know."* The others
 * are expected to follow, and `follow` crosses instantly and costs no turn.
 *
 * ═══ WHAT IT COSTS WHEN THEY DO NOT FOLLOW, MEASURED ═══
 *
 *     bodies      solo   party of 2   party of 4
 *     chapel       3.9      6.3          10.2
 *     underworks   4.8      7.4          12.3
 *     blackwood    8.9     13.5          22.4
 *
 * So a member of a four-party who scouts ahead alone meets two and a half times
 * the room, and NOTHING told them. `partyHint` says "bring a party" — but it
 * grades the ROOM off its spec, so it is silent for `restless`, and a player
 * who has a party on paper has already satisfied it.
 *
 * ═══ A LINE, NOT A RULE CHANGE ═══
 * Sizing from the crosser instead would break the case the design is built for:
 * four people walking in together would each get a solo room because the first
 * one through was alone for a moment. The scaling is right; the silence was not.
 *
 * PHRASED FORWARD, because at the instant it is said the others may be one step
 * behind — "bring them" is true whether they follow or not, where "you are
 * alone" would be wrong a second later.
 */
describe('the room is built for the party, and the first one in is told', () => {
  it('tells a lone crosser the room was sized for everybody', async () => {
    const outside = await connect(server.port);
    const outsideId = await outside.hello();
    const delver = await connect(server.port);
    const delverId = await delver.hello();
    await sleep(200);
    outside.send({ t: 'party', action: 'invite', targetId: delverId });
    await sleep(150);
    delver.send({ t: 'party', action: 'accept', targetId: outsideId });
    await sleep(250);
    expect(membersOf(server.parties, outsideId)).toHaveLength(2);

    const door = [...server.realms.overworld.sites][0];
    if (door === undefined) throw new Error('the overworld has no doors');
    const [xs, ys] = door[0].split(',');
    const body = server.realms.overworld.world.getActor(delverId);
    if (body === undefined) throw new Error('no body');
    body.x = Number(xs) - 1;
    body.y = Number(ys);
    delver.send({ t: 'move', dir: 'e' });
    await sleep(400);

    expect(server.realms.realmOf(delverId)?.siteId, 'the delver never crossed').toBe(door[1]);

    // ═══ THE ASSERTION THAT WAS FAILING ═══
    // Nothing in the log mentioned the party at all.
    const said = delver.lines();
    expect(
      said.some((line) => /built for/i.test(line)),
      said.join(' | '),
    ).toBe(true);
  });

  it('says nothing of the kind to somebody playing alone', async () => {
    // THE COUNTERFACTUAL. A party of one IS the room it gets, so the line would
    // be furniture — and furniture phrased as a warning is worse than silence.
    const solo = await connect(server.port);
    const soloId = await solo.hello();
    await sleep(200);

    const door = [...server.realms.overworld.sites][0];
    if (door === undefined) throw new Error('the overworld has no doors');
    const [xs, ys] = door[0].split(',');
    const body = server.realms.overworld.world.getActor(soloId);
    if (body === undefined) throw new Error('no body');
    body.x = Number(xs) - 1;
    body.y = Number(ys);
    solo.send({ t: 'move', dir: 'e' });
    await sleep(400);

    expect(solo.lines().some((line) => /built for/i.test(line))).toBe(false);
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE ARRIVAL BEARINGS DO NOT READ OUT A SITE YOU ARE MEANT TO FIND.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Three sites are `hidden` — Cairnfoot, Barrow End, The Weir — and `markersFor`
 * withholds each until the character's own fog holds its cell. `nearestSites`
 * never checked: it printed name, compass bearing, distance and danger grade
 * for whatever was closest, so the list spoke the secret aloud.
 *
 * MEASURED over the seventeen overworld sites: seven arrival points have a
 * hidden site among their nearest three. The Watcher's Altar is one — Cairnfoot
 * is 13 tiles from it — and Alderbrook, the STARTING town, is another.
 *
 * This drives the real thing: stand on the Watcher's Altar's door, step in,
 * step back out, and read what the moor says on arrival.
 */
describe('what the moor tells you when you come back out', () => {
  it('names no hidden site in the bearings', async () => {
    const walker = await connect(server.port);
    const walkerId = await walker.hello();
    await sleep(200);

    const altar = [...server.realms.overworld.sites].find(([, id]) => id === 'site:watchers_altar');
    if (altar === undefined) throw new Error('the moor has no altar site');
    const [ax, ay] = altar[0].split(',').map(Number);

    const body = server.realms.overworld.world.getActor(walkerId);
    if (body === undefined) throw new Error('no body');
    body.x = (ax ?? 0) - 1;
    body.y = ay ?? 0;

    walker.send({ t: 'move', dir: 'e' });
    await sleep(400);
    expect(server.realms.realmOf(walkerId)?.siteId, 'never got in').toBe('site:watchers_altar');

    // Arriving DISARMS the tile, so leaving is a step off and a step back on.
    walker.send({ t: 'move', dir: 'w' });
    await sleep(250);
    walker.send({ t: 'move', dir: 'e' });
    await sleep(450);
    expect(server.realms.realmOf(walkerId)?.kind, 'never got back out').toBe(RealmKind.Overworld);

    // ═══ THE ASSERTION ═══
    // Cairnfoot is 13 tiles from here and this character has never been near it.
    const said = walker.lines().join(' | ');
    for (const secret of ['Cairnfoot', 'Barrow End', 'The Weir']) {
      expect(said.includes(secret), `${secret} was read out: ${said}`).toBe(false);
    }
    // …and the list is not simply empty, or the assertion above is vacuous.
    expect(said).toMatch(/tiles/);
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A FRIEND WHO DIES ALONE IN A DELVE IS NEWS ON THE MOOR.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Measured: A and B are one party, B stays on the moor, A dives alone and dies.
 * Across the whole episode B receives eleven `party_state` frames carrying a row
 * for A, and NOT ONE of them says `downed` — because a lone diver's survivor
 * count is zero the instant they fall, so the wipe and the floor reset run
 * inside the same pump and the downed record is gone before the pane is
 * projected. B's entire Case Log for the episode is two lines: that A went in,
 * and that A arrived. A's own log meanwhile reads "is DOWN — 5 turns, and
 * nobody is coming" and "is erased — nobody is left standing".
 *
 * So B watches a health bar dip to 13 and spring back to 69, and the game never
 * says what happened.
 *
 * ═══ THE ASYMMETRY IS THE ARGUMENT ═══
 * Two things already cross realms to the moor: "Word from the moor: X went into
 * Y" and "Word from the moor: X cleared Y". Going in crosses. Coming out
 * victorious crosses. Dying did not — which is the one of the three a party can
 * still act on.
 */
describe('the moor hears when somebody does not come back', () => {
  it('tells you what you are walking into, before the fight it is about', async () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE LEVEL FEELING — `Game.lua:1338-1353`, on a real crossing.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * The bands are unit-tested in test/shared/zone.test.ts; this is the wiring
     * question those cannot answer — whether a body walking through a real door
     * is ever told. A feature that computes a correct sentence and shows it to
     * nobody is the exact shape `test/server/reentry-wiring.test.ts` was written
     * about.
     *
     * ═══ THE DOOR IS CHOSEN BY LEVEL, NOT TAKEN FIRST ═══
     * The silent band is three levels wide either side, and the first door on
     * the overworld is The Drowned Chapel at level 1 — which a level-1 body
     * enters to exactly the silence upstream intends. Taking `[0]` would have
     * produced a test that passed for the wrong reason and then went on passing
     * after the feature was deleted.
     */
    const player = await connect(server.port);
    const playerId = await player.hello();
    await sleep(200);

    const hard = [...server.realms.overworld.sites].find(([, siteId]) => {
      const spec = specFor(siteId);
      return spec !== undefined && delveLevel(spec, { level: 1, size: 1 }) >= 6;
    });
    if (hard === undefined) throw new Error('no room on the map is far above a beginner');
    const [tile, siteId] = hard;
    const spec = specFor(siteId);
    if (spec === undefined) throw new Error('unreachable — filtered above');

    // `level` lives on `PlayerActor`; `getActor` answers the wider `EngineActor`.
    const body = server.realms.overworld.world.getActor(playerId);
    if (body === undefined || body.kind !== ActorKind.Player) throw new Error('no body');
    expect(body.level, 'the fixture is not a beginner').toBe(1);
    // ...and the gap is what the sentence is about, so it is asserted rather
    // than assumed: at 5 or more above, upstream's band is Terror.
    expect(delveLevel(spec, { level: 1, size: 1 }) - body.level).toBeGreaterThanOrEqual(5);

    const [xs, ys] = tile.split(',');
    body.x = Number(xs) - 1;
    body.y = Number(ys);
    const before = player.lines().length;
    player.send({ t: 'move', dir: 'e' });
    await sleep(500);

    expect(server.realms.realmOf(playerId)?.siteId, 'never crossed the threshold').toBe(siteId);
    const said = player.lines().slice(before);
    expect(
      said.some((line) => /past you/.test(line)),
      `walked into a level-${String(delveLevel(spec, { level: 1, size: 1 }))} room at level 1 and was told nothing — log was ${said.join(' | ')}`,
    ).toBe(true);
  });

  it('tells the client about a wipe no monster caused', async () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE DEATH PLATE DREW FOR ONE KIND OF DEATH AND NO OTHER.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * The plate's Wiped stage reads the `erased` EVENT and nothing else, because
     * `resetFloorParty` deletes the downed record inside the pump that raised it
     * — the `party` snapshot says the body is up, so the event is the only
     * witness.
     *
     * That event reached clients only inside a `sweep`, which carries its batch
     * wholesale, and `party_wipe` is filed there only when `duringSweep` is
     * true. THREE of the four `checkWipe` call sites raise it on the player lane
     * instead: at pump entry (`enrolCasualties`, scheduler.ts:3588), on a
     * bleed-out (:3617) and on a countdown expiry (:3624). `messageForEvent`
     * returned null for `erased`, and the player-lane loop drops null — so all
     * three were discarded before they reached a socket.
     *
     * The result was the exact inverse of the intent: the plate drew when a
     * monster landed the killing blow, and stayed dark for a lone player
     * bleeding to death, which is the case it was written for.
     *
     * ═══ WHY THE FIXTURE PUTS THEM DOWN BY HAND ═══
     * A wipe needs no survivors, and the pump has to be driven by something
     * other than the dead. Setting hp to 0 and letting `enrolCasualties` enrol
     * them on the way into a tide pump is the player-lane path, which is the one
     * under test — a monster's blow would take the sweep lane and pass even with
     * the bug present.
     */
    const alone = await connect(server.port);
    const aloneId = await alone.hello();
    await sleep(250);

    const body = server.realms.overworld.world.getActor(aloneId);
    if (body === undefined) throw new Error('no body');
    body.hp = 0;
    body.alive = false;

    // Nothing is sent: a dead body's commands are refused, and the tide is what
    // advances the world when a party has stopped pressing keys.
    await sleep(TIDE_MS + 900);

    const erased = alone.latest('erased');
    expect(erased, 'no `erased` frame reached the client at all').toBeDefined();
    const ev = erased?.['ev'] as Record<string, unknown> | undefined;
    expect(ev?.['id'], 'the frame is about the wrong body').toBe(aloneId);
    expect(ev?.['reason'], 'a lone death is a WIPE — nobody was left standing').toBe('wipe');
  });

  it('does not promise a rescue from somebody who has stopped playing', async () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * TWO CONSECUTIVE LINES, COUNTING DIFFERENT PEOPLE.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * The DOWN line counted `alive`. The WIPE counts PRESENCE — `surveyParty`
     * only adds a body to `survivors` when `isPresent(actor)` holds, and that is
     * `connected && !standingBy`. So a teammate who was alive but had dropped
     * their socket, or was Standing By, counted for the first sentence and not
     * for the second, and the transcript read:
     *
     *     Dalt is DOWN — 5 turns to reach them.
     *     Dalt is erased — the party is down. The floor resets.
     *
     * A rescue window announced, and cancelled by the wipe underneath it.
     *
     * "TURNS TO REACH THEM" IS A CLAIM ABOUT SOMEBODY WHO CAN ACT, and a body
     * nobody is driving cannot walk over. It is the difference between a friend
     * running and a friend who logged off — told to the player least able to
     * check which.
     */
    const stayer = await connect(server.port);
    const stayerId = await stayer.hello();
    const afk = await connect(server.port);
    const afkId = await afk.hello();
    await sleep(200);
    stayer.send({ t: 'party', action: 'invite', targetId: afkId });
    await sleep(150);
    afk.send({ t: 'party', action: 'accept', targetId: stayerId });
    await sleep(250);
    expect(membersOf(server.parties, stayerId), 'the party never formed').toHaveLength(2);

    // THE ONLY OTHER MEMBER STOPS PLAYING. Standing By rather than a dropped
    // socket, because it is the case a player CHOOSES and therefore the one
    // that happens on an ordinary evening — somebody stepping away mid-delve.
    const helper = server.realms.overworld.world.getActor(afkId);
    if (helper === undefined) throw new Error('no helper body');
    helper.standingBy = true;
    expect(helper.alive, 'the fixture killed them instead of parking them').toBe(true);

    const body = server.realms.overworld.world.getActor(stayerId);
    if (body === undefined) throw new Error('no body');
    /**
     * DOWNED BY THE PUMP, NOT BY HAND. Calling `goDown` here would create the
     * record and then `enrolCasualties` would find one already there and push
     * NO `downed` event — so the line under test would never be written. The
     * body is put at 0 and the pump enrols it, which is what happens in play.
     */
    const before = stayer.lines().length;
    body.hp = 0;
    body.alive = false;
    /**
     * AND NOTHING IS SENT BY EITHER OF THEM — THE TIDE DRIVES THIS PUMP.
     *
     * A command from the parked client IS presence: it clears `standingBy`, and
     * would un-park the very body this test is about. A command from the downed
     * one is refused before it reaches the barrier, because `submitIntent` takes
     * nothing from a body that is not `alive`.
     *
     * So the only thing left that can advance the world is the tide, which is
     * exactly what advances it in play when a party stops pressing keys.
     */
    await sleep(TIDE_MS + 900);

    const said = stayer.lines().slice(before);
    const down = said.filter((line) => /is DOWN/.test(line));
    expect(down.length, `no DOWN line at all — log was ${said.join(' | ')}`).toBeGreaterThan(0);
    for (const line of down) {
      expect(line, 'promised a rescue from somebody who is Standing By').not.toMatch(
        /to reach them/,
      );
    }
  });

  it('tells a party member standing outside that their friend went down', async () => {
    const outside = await connect(server.port);
    const outsideId = await outside.hello();
    const diver = await connect(server.port);
    const diverId = await diver.hello();
    await sleep(200);
    outside.send({ t: 'party', action: 'invite', targetId: diverId });
    await sleep(150);
    diver.send({ t: 'party', action: 'accept', targetId: outsideId });
    await sleep(250);
    expect(membersOf(server.parties, outsideId)).toHaveLength(2);

    const door = [...server.realms.overworld.sites][0];
    if (door === undefined) throw new Error('the overworld has no doors');
    const [dx, dy] = door[0].split(',').map(Number);
    const body = server.realms.overworld.world.getActor(diverId);
    if (body === undefined) throw new Error('no body');
    body.x = (dx ?? 0) - 1;
    body.y = dy ?? 0;
    diver.send({ t: 'move', dir: 'e' });
    await sleep(400);

    const inside = server.realms.realmOf(diverId);
    expect(inside?.kind, 'the diver never got in').toBe(RealmKind.Inner);

    /**
     * LET THE ROOM DO IT. Writing `hp = 0` directly does not raise a wipe — the
     * engine restores on its own pass and the body comes back at 0.5 — so the
     * death has to arrive the way a death arrives: Blackwood is `grim`, the
     * diver is alone in a room built for two, and standing still is fatal.
     */
    let died = false;
    for (let turn = 0; turn < 120 && !died; turn += 1) {
      diver.send({ t: 'hold' });
      await sleep(45);
      died = diver.lines().some((line) => /erased/i.test(line));
    }
    expect(died, 'the room never killed the diver').toBe(true);
    await sleep(500);

    // ═══ THE ASSERTION THAT WAS FAILING ═══
    // Nothing about the death reached the moor at all.
    const heard = outside.lines().join(' | ');
    expect(heard, 'the moor heard nothing about it').toMatch(/went down|did not come/i);
  });
});
