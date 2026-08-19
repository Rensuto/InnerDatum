import { partyHint, specFor } from '../../src/server/content/delve.ts';
import { RealmKind, SITES } from '../../src/server/world/realms.ts';
import { setTimeout as sleep } from 'node:timers/promises';
import { canWalk } from '../../src/shared/level.ts';

import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AiProfile } from '../../src/server/engine/actor.ts';
import { createDownedState, goDown } from '../../src/server/engine/downed.ts';
import { createPartyState, membersOf } from '../../src/server/engine/party.ts';
import { wsGateway } from '../../src/server/net/gateway.ts';
import { createTurnEngine } from '../../src/server/turn-engine.ts';
import { createRealms } from '../../src/server/world/realms.ts';
import { PROTOCOL_VERSION } from '../../src/shared/version.ts';
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
    let into: string | null = null;
    for (const [dx, dy, dir] of [
      [1, 0, 'e'],
      [-1, 0, 'w'],
      [0, 1, 's'],
      [0, -1, 'n'],
    ] as const) {
      if (!canWalk(world.level, body.x + dx, body.y + dy)) {
        into = dir;
        break;
      }
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
