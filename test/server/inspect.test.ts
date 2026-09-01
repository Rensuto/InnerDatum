import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import Fastify from 'fastify';

import { AiProfile } from '../../src/server/engine/actor.ts';
import { INSPECTOR, WATCHMAN } from '../../src/server/content/classes.ts';
import { AttackRefusal, canAttack, combatDistance } from '../../src/server/engine/combat.ts';
import { createDownedState } from '../../src/server/engine/downed.ts';
import { createEffectState, setEffect } from '../../src/server/engine/effects.ts';
import { createRng } from '../../src/shared/rng.ts';
import { MVP_EFFECTS, STUNNED } from '../../src/server/content/effects.ts';
import type { EffectState } from '../../src/server/engine/effects.ts';
import { wsGateway } from '../../src/server/net/gateway.ts';
import { createTurnEngine } from '../../src/server/turn-engine.ts';
import { attackBlockedReason } from '../../src/server/view/inspect.ts';
import { createWorld } from '../../src/server/world/world.ts';
import { chebyshev } from '../../src/shared/coords.ts';
import { ErrorCode } from '../../src/shared/protocol.ts';
import { PROTOCOL_VERSION } from '../../src/shared/version.ts';
import type { Actor, World } from '../../src/server/world/world.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * `inspect` — THE ONE FRAME WHOSE ANSWER MUST NOT BE MORE INFORMATIVE THAN
 * THE FLOOR ALLOWS.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * This runs the REAL gateway over a REAL WebSocket, like test/server/identity.ts,
 * because every claim here is about what a SOCKET can learn — and the composition
 * being tested (inspectActor, then attackBlockedReason, in that order and only in
 * that order) lives in the gateway rather than in src/server/view/inspect.ts.
 * Calling the two view functions directly would test the halves and skip the
 * seam, which is exactly where the interesting failure is.
 *
 * ═══ THE ANTI-ORACLE PROPERTY IS THE POINT OF THIS FILE ═══
 * `there is no such actor` and `there is, and you cannot see it` must come back
 * as the SAME frame. If they can be told apart, a patched client never needs to
 * see anybody: it walks the id space, keeps every id whose reply differs from
 * the reply for junk, and has the roster of the floor. `an unknown id is
 * indistinguishable from a hidden one` below is that test, and it is the single
 * assertion in this file that is load-bearing for something other than polish.
 *
 * ═══ WHY THE GEOMETRY IS HAND-PLACED ═══
 * Bodies are moved onto authored tiles of the M1 test level rather than left
 * where the seeded spawn put them, because the file's claims are about
 * DISTANCE and WALLS. The 4x4 block at rows 4-7, columns 5-8 is the wall used
 * throughout: a viewer at (5,3) and a body at (5,8) have four solid tiles
 * between them and nothing else on the map has to cooperate.
 */

/** How long a `waitFor` waits before deciding a frame is never coming. */
const FRAME_TIMEOUT_MS = 2_000;

/** An id of the right shape that nobody in this world owns. */
const MISSING_ID = 'actor_u_0000000000000000';

// ---------------------------------------------------------------------------
// The socket harness
// ---------------------------------------------------------------------------

type Frame = Record<string, unknown>;

function asFrame(text: string): Frame {
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`the server sent something that is not a frame: ${text.slice(0, 80)}`);
  }
  return { ...parsed };
}

type Client = {
  readonly frames: readonly Frame[];
  send(frame: Frame): void;
  hello(): Promise<Frame | undefined>;
  /** Send one `inspect` and return the `inspected` that answers it. */
  inspect(targetId: string): Promise<Frame>;
  waitFor(type: string, timeoutMs?: number): Promise<Frame | undefined>;
  clear(): void;
  close(): void;
};

const openClients: Client[] = [];

async function connect(port: number): Promise<Client> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  let frames: Frame[] = [];

  socket.addEventListener('message', (event: MessageEvent) => {
    frames.push(asFrame(String(event.data)));
  });

  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => {
      resolve();
    });
    socket.addEventListener('error', () => {
      reject(new Error('the socket never opened'));
    });
  });

  const waitFor = async (
    type: string,
    timeoutMs = FRAME_TIMEOUT_MS,
  ): Promise<Frame | undefined> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = frames.find((frame) => frame['t'] === type);
      if (hit !== undefined) return hit;
      if (Date.now() >= deadline) return undefined;
      await sleep(10);
    }
  };

  const client: Client = {
    get frames() {
      return frames;
    },
    send(frame: Frame): void {
      socket.send(JSON.stringify({ v: PROTOCOL_VERSION, ...frame }));
    },
    async hello() {
      client.send({ t: 'hello' });
      return await client.waitFor('welcome');
    },
    async inspect(targetId: string) {
      // Cleared first so `waitFor` cannot match the answer to a previous
      // question — there is no correlation id on this wire, deliberately.
      client.clear();
      client.send({ t: 'inspect', targetId });
      const answer = await client.waitFor('inspected');
      if (answer === undefined) throw new Error(`no \`inspected\` came back for ${targetId}`);
      return answer;
    },
    waitFor,
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

// ---------------------------------------------------------------------------
// The server, and the bodies on the floor
// ---------------------------------------------------------------------------

type Harness = {
  readonly port: number;
  readonly world: World;
  /** The live status table, so a test can put something on a body. */
  readonly effects: EffectState;
  close(): Promise<void>;
};

async function boot(seed: string): Promise<Harness> {
  const app = Fastify({ logger: false });
  const world = createWorld(seed);
  const downed = createDownedState();
  // THE STATUS TABLE IS WIRED NOW. It was absent, so `inspectActor` could not
  // have named a status even after it was taught how — and no test in this file
  // could have noticed.
  const effects = createEffectState(MVP_EFFECTS);
  await app.register(wsGateway, {
    world,
    engine: createTurnEngine({ world, downed }),
    downed,
    effects,
    disconnectGraceMs: 30_000,
  });
  await app.listen({ host: '127.0.0.1', port: 0 });

  const address = app.server.address();
  if (address === null || typeof address === 'string') throw new Error('no port was bound');

  return {
    port: address.port,
    world,
    effects,
    close: async (): Promise<void> => {
      await app.close();
    },
  };
}

let server: Harness;

beforeEach(async () => {
  server = await boot('inspect-test');
});

afterEach(async () => {
  for (const client of openClients) client.close();
  openClients.length = 0;
  await server.close();
});

function actorOf(id: string): Actor {
  const found = server.world.getActor(id);
  if (found === undefined) throw new Error(`test fixture: actor ${id} is missing`);
  return found;
}

function husk(id: string, x: number, y: number): Actor {
  const monster = server.world.addMonster(id, {
    name: `Husk ${id}`,
    sprite: 'enemy_index_husk_s',
    x,
    y,
    profile: AiProfile.MeleeChaser,
  });
  // `addMonster` shuffles to the nearest FREE tile, which is right for authored
  // encounters and wrong for a test whose whole subject is distance. Pinned.
  monster.x = x;
  monster.y = y;
  return monster;
}

/**
 * A viewer at (5,3) with four bodies arranged around the rows 4-7 wall block.
 *
 * EVERYTHING IS PLACED AFTER `hello`, and that matters: the gateway pumps on
 * `hello`, and a pump with monsters already on the floor would start the
 * engagement clock and move things. Nothing in this file sends a frame that
 * pumps, so the arrangement below is the arrangement every assertion sees.
 */
type Scene = {
  readonly client: Client;
  readonly viewer: Actor;
  /** Chebyshev 1, clear line — the bump-attack case. */
  readonly adjacent: Actor;
  /** Chebyshev 2, clear line — out of reach, but visible. */
  readonly twoAway: Actor;
  /** Four wall tiles in between. */
  readonly hidden: Actor;
  /** Visible, and a corpse. */
  readonly corpse: Actor;
  /** A player body at 0 hp, which is NOT a corpse. */
  readonly friend: Actor;
};

async function scene(): Promise<Scene> {
  const client = await connect(server.port);
  const welcome = await client.hello();
  const viewer = actorOf(String(welcome?.['selfId']));
  viewer.x = 5;
  viewer.y = 3;

  const adjacent = husk('m_adjacent', 6, 3);
  const twoAway = husk('m_two_away', 7, 3);
  // (5,4) through (5,7) are the authored 4x4 block, so the bresenham walk from
  // (5,3) hits a wall on its first interior step.
  const hidden = husk('m_hidden', 5, 8);
  const corpse = husk('m_corpse', 6, 2);
  corpse.hp = 0;
  corpse.alive = false;

  const friend = server.world.addPlayer('p_friend', 'Friend');
  friend.x = 4;
  friend.y = 3;
  friend.hp = 0;
  friend.alive = false;

  return { client, viewer, adjacent, twoAway, hidden, corpse, friend };
}

/** The `view` of an `inspected` frame, as an object the test can read. */
function viewOf(frame: Frame): Frame | null {
  const view = frame['view'];
  if (view === null) return null;
  if (typeof view !== 'object' || Array.isArray(view)) {
    throw new Error(`\`view\` should be an object or null, got ${typeof view}`);
  }
  return { ...(view as Frame) };
}

function rowsOf(view: Frame | null): Frame[] {
  const rows = view?.['rows'];
  if (!Array.isArray(rows)) return [];
  return rows.map((row: unknown) => ({ ...(row as Frame) }));
}

// ===========================================================================
// 1. WHAT A VISIBLE HOSTILE ANSWERS
// ===========================================================================

describe('a hostile in line of sight', () => {
  it('comes back as a card for that target, led by the chance to hit', async () => {
    const floor = await scene();

    const answer = await floor.client.inspect(floor.adjacent.id);
    expect(answer['t']).toBe('inspected');
    // The correlation is BY TARGET — there is no request id anywhere on this
    // wire, so a client with two hovers in flight matches on this field.
    expect(answer['targetId']).toBe(floor.adjacent.id);

    const view = viewOf(answer);
    expect(view?.['id']).toBe(floor.adjacent.id);
    expect(view?.['name']).toBe(floor.adjacent.name);
    expect(view?.['maxHp']).toBe(floor.adjacent.maxHp);

    // THE NUMBER THE PLAYER IS ACTUALLY ASKING FOR, and it is the emphasised
    // one: everything else on the card is context for it.
    const hit = rowsOf(view).find((row) => row['label'] === 'Chance to hit');
    expect(hit).toBeDefined();
    expect(hit?.['emphasis']).toBe(true);
    expect(String(hit?.['value'])).toMatch(/^\d+%$/);

    // The badge row stays empty until somebody populates it — asserted so the
    // day it starts carrying effect ids is a day this test notices.
    expect(view?.['effects']).toEqual([]);
  });
});

// ===========================================================================
// 2 & 3. THE ANTI-ORACLE PROPERTY
// ===========================================================================

describe('what the viewer may not know', () => {
  it('answers `view: null` for a body with a wall in the way', async () => {
    const floor = await scene();
    const answer = await floor.client.inspect(floor.hidden.id);

    // NOT a redacted card, NOT an error frame: silence with a shape.
    expect(answer['view']).toBeNull();
    expect(answer['targetId']).toBe(floor.hidden.id);
    // And emphatically not `attackBlockedReason`'s own sentence, which would
    // confirm both that the body exists and that a wall is what is in the way.
    expect(JSON.stringify(answer)).not.toContain('no line of sight');
  });

  it('gives an UNKNOWN id a frame indistinguishable from a HIDDEN one', async () => {
    // ═══ THE MOST IMPORTANT ASSERTION IN THIS FILE ═══
    // If these two frames can be sorted apart by any means — a key, a value, a
    // code, a shape — then `inspect` is an id oracle and a patched client
    // enumerates the floor without ever seeing a single body. They are compared
    // twice: structurally, and as bytes with the echoed target normalised out.
    const floor = await scene();

    const hidden = await floor.client.inspect(floor.hidden.id);
    const missing = await floor.client.inspect(MISSING_ID);

    // Structurally identical apart from the field that merely echoes the
    // question back, so no key is present in one and absent from the other.
    expect(missing).toEqual({ ...hidden, targetId: MISSING_ID });
    expect(Object.keys(missing).sort()).toEqual(Object.keys(hidden).sort());

    // ...and byte-identical once the echo is normalised: same key ORDER, same
    // JSON, nothing to time and nothing to diff.
    const canonical = (frame: Frame, targetId: string): string =>
      JSON.stringify(frame).split(targetId).join('<target>');
    expect(canonical(missing, MISSING_ID)).toBe(canonical(hidden, floor.hidden.id));

    // Neither is an error, either: an ErrorCode for "cannot see it" would be
    // the same oracle wearing a different hat.
    expect(await floor.client.waitFor('error', 100)).toBeUndefined();
  });
});

// ===========================================================================
// 4. REACH — THE QUESTION BUMP-ATTACK ACTUALLY ASKS
// ===========================================================================

describe('`blockedReason` is asked with the viewer’s own reach', () => {
  it('is absent for an adjacent hostile — walk into it and you hit it', async () => {
    const floor = await scene();
    const view = viewOf(await floor.client.inspect(floor.adjacent.id));

    // PRESENT MEANS REFUSED, so absent means "yes". `undefined` rather than an
    // empty string: the key does not survive JSON.stringify at all.
    expect(view?.['blockedReason']).toBeUndefined();
    expect(Object.keys(view ?? {})).not.toContain('blockedReason');
  });

  it('says so for a hostile two tiles away, because the reach is one', async () => {
    const floor = await scene();
    const view = viewOf(await floor.client.inspect(floor.twoAway.id));

    // The viewer is a WATCHMAN now — every joining body gets a class sheet — so
    // the reach is `MELEE_REACH` 1.5, which contains the four diagonals at √2
    // and excludes this body at 2.0. The sentence still says "reaches 1",
    // because 1.5 is the radius that makes the circle the eight-neighbourhood
    // and a fractional reach in a player-facing string is arithmetic, not advice.
    expect(String(view?.['blockedReason'])).toContain('out of range');
    expect(String(view?.['blockedReason'])).toContain('reaches 1');
    expect(String(view?.['blockedReason'])).not.toContain('1.5');
    // The card still arrives: "I can see it and cannot reach it" is exactly the
    // thing a tooltip exists to say.
    expect(view?.['id']).toBe(floor.twoAway.id);
    const distance = rowsOf(view).find((row) => row['label'] === 'Distance');
    expect(distance?.['value']).toBe('2 tiles');
  });
});

// ===========================================================================
// 5. A CORPSE IS NOT A BODY ON THE FLOOR
// ===========================================================================

describe('the dead', () => {
  it('refuses a dead MONSTER and answers a downed PLAYER', async () => {
    const floor = await scene();

    // inspect.ts:119 rejects the first and not the second, deliberately: a husk
    // at 0 hp is scenery, but a player at 0 hp is somebody an ally is running
    // at — and "how long have they got" is the question the run is about.
    expect((await floor.client.inspect(floor.corpse.id))['view']).toBeNull();

    const friend = viewOf(await floor.client.inspect(floor.friend.id));
    expect(friend?.['id']).toBe(floor.friend.id);
    expect(friend?.['hp']).toBe(0);
    // Not a hostile, so no hit chance is offered for a teammate's body.
    expect(rowsOf(friend).map((row) => row['label'])).not.toContain('Chance to hit');
    // ...and the reason an attack would be refused is the honest one.
    expect(friend?.['blockedReason']).toBe('already down');
  });
});

// ===========================================================================
// 6. IT COSTS NOTHING, AND THEREFORE MUST DO NOTHING
// ===========================================================================

describe('an inspect is not a turn', () => {
  it('does not advance the clock, and produces no frame but the answer', async () => {
    const floor = await scene();
    const before = server.world.turn.clock.gameTurn;
    const wherePlayerWas = { x: floor.viewer.x, y: floor.viewer.y };

    floor.client.clear();
    for (const id of [floor.adjacent.id, floor.hidden.id, MISSING_ID]) {
      floor.client.send({ t: 'inspect', targetId: id });
    }
    await sleep(150);

    expect(server.world.turn.clock.gameTurn).toBe(before);
    // No pump ran, so nothing moved and no energy was spent.
    expect({ x: floor.viewer.x, y: floor.viewer.y }).toEqual(wherePlayerWas);
    expect(floor.viewer.pendingIntent).toBeNull();

    // THREE ANSWERS AND NOTHING ELSE. A `turn` frame here would mean the turn
    // key changed; a `state` or a `log` would mean the world did.
    const kinds = floor.client.frames.map((frame) => frame['t']);
    expect(kinds).toEqual(['inspected', 'inspected', 'inspected']);
  });

  it('answers the ASKER alone — an inspect is never broadcast', async () => {
    // What `inspectActor` returns depends on the viewer's line of sight, so the
    // same target inspected by two people is legitimately two different frames.
    // A broadcast would hand one player the other's answer.
    const floor = await scene();
    const bystander = await connect(server.port);
    await bystander.hello();
    bystander.clear();

    await floor.client.inspect(floor.adjacent.id);
    await sleep(100);

    expect(bystander.frames.some((frame) => frame['t'] === 'inspected')).toBe(false);
  });
});

// ===========================================================================
// 7. THE HANDSHAKE COMES FIRST
// ===========================================================================

describe('before `hello`', () => {
  it('is refused with not_authenticated and answers nothing at all', async () => {
    const client = await connect(server.port);
    client.send({ t: 'inspect', targetId: MISSING_ID });

    const refusal = await client.waitFor('error');
    expect(refusal?.['code']).toBe(ErrorCode.NotAuthenticated);
    // No card leaked past the refusal, not even a null one.
    expect(await client.waitFor('inspected', 200)).toBeUndefined();
  });
});

// ===========================================================================
// 8. THE CARD AND THE SERVER MEASURE WITH THE SAME RULER
// ===========================================================================

describe('`attackBlockedReason` asks exactly the question `canAttack` answers', () => {
  /**
   * ═════════════════════════════════════════════════════════════════════════
   * THE DIAGONAL RIM: THE BAND WHERE THE CARD USED TO SAY YES AND MEAN NO.
   * ═════════════════════════════════════════════════════════════════════════
   *
   * `attackBlockedReason` measured with CHEBYSHEV and compared against
   * `combat.range`, which is a EUCLIDEAN radius. That agreed by accident while
   * no player carried a combat sheet at all. Now the Inspector carries range 5
   * and the two disagree along the whole diagonal rim of her ring: Chebyshev 4
   * passes, Euclid 5.657 does not, so the card advertised a shootable target
   * that the server refused on click. combat.ts's wiring note is explicit that
   * the metrics must move together.
   *
   * Driven directly rather than over a socket because the property is about the
   * two functions AGREEING, and the only honest way to assert that is to call
   * both with the same pair of bodies.
   */
  it('agrees with `canAttack` on the diagonal rim of a ranged sheet', () => {
    const world = createWorld('inspect-euclid');
    const shooter = world.addPlayer('p_inspector', 'Wren', {
      // The Inspector's band, verbatim from content/classes.ts.
      combat: { range: 5, minRange: 3 },
    });
    shooter.x = 10;
    shooter.y = 10;

    const husk = world.addMonster('m_diag', {
      name: 'Bent Husk',
      sprite: 'enemy_index_husk_s',
      x: 14,
      y: 14,
      profile: AiProfile.MeleeChaser,
    });
    husk.x = 14;
    husk.y = 14;

    // Chebyshev 4 — inside the old square. Euclid 5.657 — outside the circle.
    expect(chebyshev(shooter, husk)).toBe(4);
    expect(combatDistance(shooter, husk)).toBeGreaterThan(5);

    expect(canAttack(shooter, husk, world)).toBe(AttackRefusal.OutOfRange);
    expect(attackBlockedReason(world, shooter, husk)).toContain('out of range');
  });

  it('reports the dead zone as `too close`, never as out of range', () => {
    // The two carry OPPOSITE instructions — one says close in, the other says
    // back away — and a positional class reads as broken the moment they are
    // confused. Same rule, same words, both layers.
    const world = createWorld('inspect-deadzone');
    const shooter = world.addPlayer('p_inspector', 'Wren', {
      combat: { range: 5, minRange: 3 },
    });
    shooter.x = 10;
    shooter.y = 10;

    const husk = world.addMonster('m_close', {
      name: 'Bent Husk',
      sprite: 'enemy_index_husk_s',
      x: 11,
      y: 10,
      profile: AiProfile.MeleeChaser,
    });
    husk.x = 11;
    husk.y = 10;

    expect(canAttack(shooter, husk, world)).toBe(AttackRefusal.MinRange);
    expect(attackBlockedReason(world, shooter, husk)).toContain('too close');
  });

  it('lets a melee body swing on the diagonal, exactly as the scheduler does', () => {
    // `MELEE_REACH` 1.5 contains √2. A raw Euclidean 1 here would have the card
    // refuse the four diagonals that bump-attack has always allowed.
    const world = createWorld('inspect-diagonal-melee');
    const watchman = world.addPlayer('p_watchman', 'Ren', { combat: { range: 1.5 } });
    watchman.x = 10;
    watchman.y = 10;

    const husk = world.addMonster('m_ne', {
      name: 'Bent Husk',
      sprite: 'enemy_index_husk_s',
      x: 11,
      y: 11,
      profile: AiProfile.MeleeChaser,
    });
    husk.x = 11;
    husk.y = 11;

    expect(canAttack(watchman, husk, world)).toBeNull();
    expect(attackBlockedReason(world, watchman, husk)).toBeUndefined();
  });
});

// ===========================================================================
// 9. THE CHARACTER SHEET — AND THE BOUNDARY IT SITS BEHIND
// ===========================================================================

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ToME'S CharacterSheet.lua, REDUCED — AND THE ORDER IS THE PORTED CONTRACT.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The six stats in ToME's own STR/DEX/CON/MAG/WIL/CUN sequence
 * (CharacterSheet.lua:815-820), then Attack (:935-1120), then Defense
 * (:1304-1321). The SEQUENCE is asserted rather than the membership, because
 * the sequence is the thing the directive asked to be ported: a sheet with the
 * right rows in a different order is a different screen. The COUNT is not
 * spelled anywhere — it was "fifteen" until the sheet grew tabs and had room
 * for four numbers it had always computed.
 *
 * Nothing here is level, xp, gold, equipment, inventory, fatigue, speeds,
 * vision, inscriptions or times-died. ToME prints all of those and every one
 * reads from a system this game does not have; an empty row is worse than an
 * absent one, because "Level: —" sends a player looking for a screen that does
 * not exist.
 */
const SELF_SHEET_LABELS = [
  'Strength',
  'Dexterity',
  'Constitution',
  'Magic',
  'Willpower',
  'Cunning',
  // CharacterSheet.lua:715. The first DERIVED row the General tab has ever had,
  // and it is what Constitution buys besides hit points: every heal in the game
  // is multiplied by the receiver's factor.
  'Healing mod.',
  'Accuracy',
  'Damage',
  'APR',
  'Crit. chance',
  // CharacterSheet.lua:1115-1116, directly under the chance because that is
  // where upstream puts it. Six talents and an ego move this number and no
  // screen printed it, so "your crits land harder" was unverifiable.
  'Crit. power',
  // The three powers — CharacterSheet.lua:1161, :1167-1168, :1179-1181. Upstream
  // prints all three for every character; so does this. `indelible.ts` raises
  // Mindpower and, until these rows, no screen in the game could show it.
  'Phys. power',
  'Spellpower',
  'Mindpower',
  'Armour',
  'Defence',
  // CharacterSheet.lua:1302. The number `BREACHED` halves — `Armour` alone tells
  // a player how much a blow could be stopped by and not how often it is tried.
  'Armour hardiness',
  'Physical save',
  'Spell save',
  'Mental save',
  // CharacterSheet.lua:1312. What Dexterity buys that nothing else does — the
  // chance to cancel an incoming crit outright. It shipped the same day as this
  // row and, for a few hours, without it.
  'Crit. shrug off',
];

/** Every row a HOSTILE or an ALLY card must never grow. */
const SHEET_ONLY_LABELS = [
  'Strength',
  'Dexterity',
  'Constitution',
  'Magic',
  'Willpower',
  'Cunning',
  'Accuracy',
  'Damage',
  'APR',
  'Crit. chance',
  // THE FOUR THAT ARRIVED WITH THE TABS. Listed here as well as in the sheet
  // order, because this is the list that stops them LEAKING: they are pushed
  // only by `pushSelfSheet` today, and a card that grew "Mindpower: 31" for a
  // husk would be telling a player something the server has decided they do not
  // get to know. Absent from this list, that leak would fail nothing.
  'Phys. power',
  'Spellpower',
  'Mindpower',
  'Armour hardiness',
  'Spell save',
  'Mental save',
];

describe('inspecting yourself', () => {
  it('answers the reduced CharacterSheet, in ToME order', async () => {
    const floor = await scene();
    const view = viewOf(await floor.client.inspect(floor.viewer.id));

    // THE CLASS IS A FIELD, NOT A ROW. `rows` is explicitly droppable by a
    // narrow viewport and reorderable by the server, so a header that had to
    // scan it for the label 'Class' would one day draw a nameless detective.
    // The first fresh joiner takes rotation slot 0 — see `classForJoin`.
    expect(view?.['className']).toBe(WATCHMAN.name);

    // THE ORDER, ASSERTED AS A SEQUENCE. See the block above.
    expect(rowsOf(view).map((row) => row['label'])).toEqual(SELF_SHEET_LABELS);

    const value = (label: string): string =>
      String(rowsOf(view).find((row) => row['label'] === label)?.['value']);

    // ═══ THE ONE ASSERTION THAT PROVES THE SHEET IS THE ACTOR'S OWN ═══
    // 24 is the Watchman's authored Strength (content/classes.ts). Read through
    // the ACTOR instead of through `combatantOf` — which compiles only behind a
    // double cast — every stat here would silently resolve to ToME's level-1
    // default of 10, and the card would be confidently, uniformly wrong in a way
    // that still looks entirely plausible.
    expect(value('Strength')).toBe('24');
    expect(value('Constitution')).toBe('20');
    // …and a stat the class does not author still reads ToME's own default
    // rather than a blank, because `stat()` supplies it.
    expect(value('Magic')).toBe('10');

    // A BAND, AND IT IS A MULTIPLIER RATHER THAN A SPREAD: Combat.lua:511 rolls
    // `rng.range(dam, dam * damrange)`, and both endpoints TRUNCATE, so these
    // are the exact two numbers the dice can produce.
    expect(value('Damage')).toMatch(/^\d+–\d+$/);
    expect(value('Crit. chance')).toMatch(/^\d+%$/);
    // Whole numbers everywhere else — no `12.41804809108126` on a card.
    for (const label of ['Accuracy', 'APR', 'Armour', 'Defence', 'Physical save']) {
      expect(value(label)).toMatch(/^-?\d+$/);
    }
  });

  it('emphasises nothing, because emphasis belongs to the hit chance', async () => {
    // `InspectRow.emphasis` is reserved for the number that decides whether to
    // commit. Fifteen emphasised rows emphasise none of them, and it would spend
    // the one piece of formatting the hostile card depends on.
    const floor = await scene();
    const view = viewOf(await floor.client.inspect(floor.viewer.id));

    for (const row of rowsOf(view)) expect(row['emphasis']).toBeUndefined();
  });
});

describe('inspecting ANOTHER player', () => {
  it('is two rows and no class — a party member sheet is theirs alone', async () => {
    // ═══════════════════════════════════════════════════════════════════════
    // THE LEAK TEST. `hostile` is false for ANY player target, so widening the
    // old else-branch to carry the sheet would hand a teammate's stats,
    // accuracy, damage band and three saves to anyone who moves a mouse over
    // them. The same body is inspected by two people in the same instant here,
    // which is the only honest way to state the property.
    // ═══════════════════════════════════════════════════════════════════════
    const floor = await scene();
    const ally = await connect(server.port);
    const allyId = String((await ally.hello())?.['selfId']);

    // Diagonally adjacent to the viewer at (5,3), clear of the rows 4-7 block.
    const allyBody = actorOf(allyId);
    allyBody.x = 4;
    allyBody.y = 2;

    // THEIR OWN VIEW: everything. Second fresh joiner, so rotation slot 1.
    const own = viewOf(await ally.inspect(allyId));
    expect(own?.['className']).toBe(INSPECTOR.name);
    expect(rowsOf(own).map((row) => row['label'])).toEqual(SELF_SHEET_LABELS);

    // SOMEBODY ELSE'S VIEW OF THE SAME BODY: exactly what it has always been.
    const seen = viewOf(await floor.client.inspect(allyId));
    expect(rowsOf(seen).map((row) => row['label'])).toEqual(['Defence', 'Armour']);
    // ABSENT, not present-and-empty — the key must not appear at all.
    expect(Object.keys(seen ?? {})).not.toContain('className');
    for (const label of SHEET_ONLY_LABELS) {
      expect(rowsOf(seen).map((row) => row['label'])).not.toContain(label);
    }
    // ...and nothing about a teammate is ever the emphasised number.
    for (const row of rowsOf(seen)) expect(row['emphasis']).toBeUndefined();
  });

  it('is still silence when a wall is in the way', async () => {
    // The fog-of-war gate runs BEFORE the three-way split and is untouched by
    // it: a party member across the floor is exactly who the FOV seam will one
    // day withhold, and `view: null` must stay the answer rather than a
    // stripped-down card that confirms where they are.
    const floor = await scene();
    const ally = await connect(server.port);
    const allyId = String((await ally.hello())?.['selfId']);

    const allyBody = actorOf(allyId);
    allyBody.x = 5;
    allyBody.y = 8;

    expect((await floor.client.inspect(allyId))['view']).toBeNull();
    // ...while their own sheet is still theirs to read, because the self path
    // short-circuits the line-of-sight check.
    expect(viewOf(await ally.inspect(allyId))?.['className']).toBe(INSPECTOR.name);
  });
});

describe('inspecting a hostile', () => {
  it('gained nothing from the split — the card is what it always was', async () => {
    const floor = await scene();
    const view = viewOf(await floor.client.inspect(floor.adjacent.id));
    const labels = rowsOf(view).map((row) => row['label']);

    // A monster has no class, and `className` means "draw a class line" rather
    // than "unknown" — so the key is absent rather than empty.
    expect(Object.keys(view ?? {})).not.toContain('className');
    // The hit chance still leads, and the distance still closes.
    expect(labels[0]).toBe('Chance to hit');
    expect(labels[labels.length - 1]).toBe('Distance');
    for (const label of SHEET_ONLY_LABELS) expect(labels).not.toContain(label);
  });
});

// ===========================================================================
// RESISTANCES — the readout half of the elemental-resistance change
// ===========================================================================

describe('what a body shrugs off is finally on a screen', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE ENGINE KNEW THIS NUMBER ALL ALONG AND NO SCREEN WOULD SAY IT.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `combatGetResist` has been a complete port since damage.ts was written and
   * monsters have carried resist tables for milestones. Nothing displayed one.
   * The Alchemist's whole kit is Fire, so against a fire-resistant body she was
   * doing a fraction of the damage her own card advertised, with no way to find
   * out why — "it barely scratched it" was an unanswerable question about a
   * number the server had in hand.
   *
   * A CHANNEL WITH NO READOUT IS INVISIBLE AND A READOUT WITH NO CHANNEL IS
   * UNACTIONABLE, which is why both halves shipped together: the hostile card
   * teaches that elements differ, and the character sheet is where the player
   * learns they can answer it.
   */
  it('names the element a hostile resists, on the hostile card', async () => {
    const floor = await scene();
    const target = actorOf(floor.adjacent.id);
    target.combat = { ...(target.combat ?? {}), profile: { resists: { fire: 40 } } };

    const rows = rowsOf(viewOf(await floor.client.inspect(floor.adjacent.id)));
    const fire = rows.find((r) => String(r['label']) === 'Fire resist');
    expect(fire, 'the card never named the resistance').toBeDefined();
    expect(fire?.['value']).toBe('40%');
  });

  it('says nothing at all about an element a body does not resist', async () => {
    /**
     * Six rows of "0%" on every card would push the rows that matter off the
     * pane and teach a player to stop reading. Absence is the statement.
     */
    const floor = await scene();
    const rows = rowsOf(viewOf(await floor.client.inspect(floor.adjacent.id)));
    expect(rows.filter((r) => String(r['label']).endsWith(' resist'))).toEqual([]);
  });

  it('shows the player their own resistances on the character sheet', async () => {
    const floor = await scene();
    const me = floor.viewer;
    me.combat = { ...(me.combat ?? {}), profile: { resists: { cold: 22, darkness: -5 } } };

    const rows = rowsOf(viewOf(await floor.client.inspect(floor.viewer.id)));
    expect(rows).toContainEqual(expect.objectContaining({ label: 'Cold resist', value: '22%' }));
    // A NEGATIVE IS SHOWN, not hidden. A body that is WORSE against an element
    // is the single most important thing this block can tell somebody, and it
    // is the case a "only show what helps" filter would silently swallow.
    expect(rows).toContainEqual(
      expect.objectContaining({ label: 'Darkness resist', value: '-5%' }),
    );
  });

  it('prints the figure the damage pipeline actually spends, cap and all', async () => {
    /**
     * `combatGetResist` applies the ceiling that stops the formula inverting
     * above 100% (Combat.lua:2227-2228). A sheet printing the RAW table would
     * promise 90% to a body the dice treat as 40% — the exact shape of lie this
     * whole file exists to prevent, per its header on the client-side formula.
     */
    const floor = await scene();
    const me = floor.viewer;
    me.combat = {
      ...(me.combat ?? {}),
      profile: { resists: { fire: 90 }, resistsCap: { fire: 40 } },
    };

    const rows = rowsOf(viewOf(await floor.client.inspect(floor.viewer.id)));
    expect(rows).toContainEqual(expect.objectContaining({ label: 'Fire resist', value: '40%' }));
  });
});

describe('the three numbers the engine knew and no screen printed', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * A CHANNEL WITH NO READOUT IS INVISIBLE — AND IT HAD JUST BEEN WRITTEN DOWN.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * The elemental-resistance change shipped its rows in the same commit as its
   * channel, on exactly that argument. The very next commit added two channels —
   * Constitution's healing multiplier and Dexterity's crit shrug — and no rows,
   * so both were real in the pipeline and absent from every surface a player can
   * look at. `combatCritPower` had been in that state far longer: live in every
   * melee resolve, moved by six talents and an ego, printed nowhere.
   *
   * ═══ THE VALUES, NOT THE LABELS ═══
   * `SELF_SHEET_LABELS` above pins the order, and a row carrying the wrong
   * number would satisfy it completely. These read what the row actually says,
   * over a real socket, which is the only place the whole chain is visible.
   */
  const sheetValue = async (label: string): Promise<string> => {
    const floor = await scene();
    const view = viewOf(await floor.client.inspect(floor.viewer.id));
    return String(rowsOf(view).find((row) => row['label'] === label)?.['value']);
  };

  it('prints crit power the way upstream does, at 150 and up', async () => {
    // `150 + combat_critical_power` — CharacterSheet.lua:1116. The getter carries
    // 1.5 as a multiplier, and a sheet reading "Crit. power 1.5" would be the
    // only figure on it that is neither a percentage nor a whole number.
    expect(await sheetValue('Crit. power')).toBe('150%');
  });

  it('prints what Constitution is buying beyond hit points', async () => {
    // The Watchman stands at Constitution 20, which is +7.9% on the curve and
    // rounds to 108%. A body at the base 10 would read exactly 100%, so this
    // also proves the row is reading the ACTOR rather than a default.
    const healing = await sheetValue('Healing mod.');
    expect(healing).toMatch(/^1\d\d%$/);
    expect(healing, 'the row is reading a base-10 default, not the Watchman').not.toBe('100%');
  });

  it('prints what Dexterity is buying that nothing else can', async () => {
    // 0.3 x DEX. The Watchman's authored Dexterity is 14, so 4.2 -> 4%.
    const shrug = await sheetValue('Crit. shrug off');
    expect(shrug).toMatch(/^\d+%$/);
    expect(shrug).toBe(`${String(Math.round(0.3 * (WATCHMAN.combat.stats?.dex ?? 0)))}%`);
  });
});

describe('which one is sigiled?', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * SIX HUSKS, SIX IDENTICAL ORANGE DOTS.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `render/canvas.ts#paintStatusPips` draws a FOUR-PIXEL square per status,
   * coloured only by whether it is harmful — so Marked, Stunned and Bleeding
   * are the same dot. The server has been sending every status's name and badge
   * letter the whole time (`projectEffects` covers every actor, not only the
   * party); nothing displayed them, and a four-pixel pip cannot carry a letter.
   *
   * The card is where identity goes. It is already the surface a player points
   * a monster at to read, and a row is a shape the client already draws.
   *
   * ═══ AND `InspectView.effects` HAD BEEN `[]` SINCE IT WAS DECLARED ═══
   * Its own comment calls it "effect ids the viewer can see on this actor" and
   * `inspectActor` was never given the status table, so it could not have been
   * anything else. This suite could not have caught that either: its harness
   * registered the gateway with no `effects` at all.
   */
  it('names the status on a hostile, with how long it has left', async () => {
    const floor = await scene();
    setEffect(server.effects, actorOf(floor.adjacent.id), STUNNED.id, 3, {}, createRng('stun'));

    const rows = rowsOf(viewOf(await floor.client.inspect(floor.adjacent.id)));
    const stun = rows.find((r) => String(r['label']) === STUNNED.displayName);
    expect(stun, 'the card said nothing about the status on it').toBeDefined();
    expect(stun?.['value']).toBe('3 turns');
  });

  it('says "1 turn" rather than "1 turns"', async () => {
    // A HUD that cannot count is a HUD a player stops reading.
    const floor = await scene();
    setEffect(server.effects, actorOf(floor.adjacent.id), STUNNED.id, 1, {}, createRng('stun'));
    const rows = rowsOf(viewOf(await floor.client.inspect(floor.adjacent.id)));
    expect(rows.find((r) => String(r['label']) === STUNNED.displayName)?.['value']).toBe('1 turn');
  });

  it('fills the effect ids that had been an empty array since they were declared', async () => {
    const floor = await scene();
    setEffect(server.effects, actorOf(floor.adjacent.id), STUNNED.id, 2, {}, createRng('stun'));
    const view = viewOf(await floor.client.inspect(floor.adjacent.id));
    expect(view?.['effects']).toEqual([STUNNED.id]);
  });

  it('says nothing at all about a body with nothing on it', async () => {
    // Absence is the statement. A card that listed "no statuses" would spend a
    // row on the common case and push the rows that matter off a narrow panel.
    const floor = await scene();
    const rows = rowsOf(viewOf(await floor.client.inspect(floor.adjacent.id)));
    expect(rows.find((r) => String(r['label']) === STUNNED.displayName)).toBeUndefined();
    expect(viewOf(await floor.client.inspect(floor.adjacent.id))?.['effects']).toEqual([]);
  });
});
