import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';

import Fastify from 'fastify';

import { AiProfile } from '../../src/server/engine/actor.ts';
import { DamageType } from '../../src/server/engine/damage.ts';
import { createDownedState } from '../../src/server/engine/downed.ts';
import { wsGateway } from '../../src/server/net/gateway.ts';
import { createTurnEngine } from '../../src/server/turn-engine.ts';
import { createWorld } from '../../src/server/world/world.ts';
import { TileCode } from '../../src/shared/protocol.ts';
import { PROTOCOL_VERSION } from '../../src/shared/version.ts';
import type { CombatSheet } from '../../src/server/engine/combat.ts';
import type { Actor, World } from '../../src/server/world/world.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE REAP WINDOW — AFTER THE NARRATION, BEFORE THE RESYNC.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `world.removeActor` was called for a monster in exactly ONE place — inside a
 * floor reset, i.e. only on a party wipe — so an ordinary kill left the corpse
 * in `world.allActors()` forever. `projectActors` maps every actor with no
 * `alive` filter and the client's renderer never checks the flag, so a dead husk
 * kept drawing with its LIVE sprite and was indistinguishable from a living one.
 * A player reported it.
 *
 * The engine ENROLS (`PumpResult.reaped`) and the gateway BURIES, and the whole
 * design is about WHERE in `pumpAndBroadcast` that happens. test/server/reap.ts
 * pins the enrolment and the cleanup contract; this file pins the WINDOW, which
 * is only observable from a socket:
 *
 *   TOO EARLY AND THE CASE LOG LIES. `nameOf` reads the name off the live body
 *   and `hitToWire` reads its `maxHp`. Reap inside the pump and the Record lane
 *   prints "5 damage. someone 0/0." above "someone is unfiled." — nothing
 *   throws, the log simply stops naming what happened.
 *
 *   TOO LATE AND THE CORPSE SHIPS. The full resync that follows a survival event
 *   sends the whole actor list; a body still in it is drawn standing up.
 *
 *   AND AN ORB OUTLIVES ITS SHOOTER ON PURPOSE. engine/projectile.ts is explicit
 *   that the shooter may be a corpse three turns later, and `reap` deliberately
 *   does not clear the sky. An impact resolved in the SAME pump as the shooter's
 *   death is narrated from the Record lane, which runs before the reap — so it
 *   still carries the creature's name.
 *
 *   A PLAYER IS NEVER REAPED, so no `left` frame is ever minted for one. A
 *   downed body has to stay on the map for an ally to walk to (engine/downed.ts)
 *   and `left` is what the client uses to delete a body outright.
 */

const HUSK_SPRITE = 'enemy_index_husk_s';
const HUSK_MAX_HP = 40;

/**
 * Accuracy that beats any defence in this file, and enough damage to end a body
 * in one blow. A kill decided by a seed is a test that stops holding the day
 * somebody re-tunes a husk's armour.
 */
const NEVER_MISSES: CombatSheet = { mods: { atk: 30, dam: 2000 } };

/** How long a `waitFor` waits before deciding a frame is never coming. */
const FRAME_TIMEOUT_MS = 2_000;

// ---------------------------------------------------------------------------
// The socket harness
// ---------------------------------------------------------------------------

type Frame = Record<string, unknown>;

type Client = {
  readonly frames: readonly Frame[];
  send(frame: Frame): void;
  hello(): Promise<Frame | undefined>;
  /** Send a frame, then wait for the `pong` that proves everything it produced arrived. */
  settle(frame: Frame): Promise<void>;
  waitFor(type: string, timeoutMs?: number): Promise<Frame | undefined>;
  all(type: string): Frame[];
  clear(): void;
  close(): void;
};

const openClients: Client[] = [];

async function connect(port: number): Promise<Client> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  let frames: Frame[] = [];

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
    /**
     * THE ORDERING BARRIER, and it is what makes "no frame was sent" a testable
     * claim rather than a race with a timeout: the socket delivers in order and
     * the gateway answers `ping` synchronously without pumping, so once `pong`
     * is in hand every frame the command produced is already in `frames`.
     */
    async settle(frame: Frame) {
      client.send(frame);
      client.send({ t: 'ping' });
      const pong = await client.waitFor('pong');
      if (pong === undefined) throw new Error('the server never answered the ordering ping');
      frames = frames.filter((f) => f['t'] !== 'pong');
    },
    waitFor,
    all: (type: string): Frame[] => frames.filter((frame) => frame['t'] === type),
    clear: (): void => {
      frames = [];
    },
    close: (): void => {
      socket.close();
    },
  };

  openClients.push(client);
  return client;
}

// ---------------------------------------------------------------------------
// The server: the REAL gateway, the REAL turn engine, a real world
// ---------------------------------------------------------------------------

type Harness = {
  readonly port: number;
  readonly world: World;
  close(): Promise<void>;
};

async function boot(seed: string): Promise<Harness> {
  const app = Fastify({ logger: false });
  const world = createWorld(seed);
  // Open floor, so every body in this file is standing where the test put it
  // rather than wherever the authored map had room.
  world.level.tiles.fill(TileCode.FLOOR);
  const downed = createDownedState();

  await app.register(wsGateway, {
    world,
    engine: createTurnEngine({ world, downed, now: () => 0 }),
    downed,
    disconnectGraceMs: 30_000,
  });
  await app.listen({ host: '127.0.0.1', port: 0 });

  const address = app.server.address();
  if (address === null || typeof address === 'string') throw new Error('no port was bound');

  return {
    port: address.port,
    world,
    close: async (): Promise<void> => {
      await app.close();
    },
  };
}

let server: Harness;

afterEach(async () => {
  for (const client of openClients) client.close();
  openClients.length = 0;
  await server.close();
});

function actorOf(id: string): Actor {
  const found = server.world.getActor(id);
  if (found === undefined) throw new Error(`test fixture: no actor ${id}`);
  return found;
}

/** Stand a body on an exact tile. Placement, not movement — nothing is watching yet. */
function placeAt(actor: Actor, x: number, y: number): Actor {
  actor.x = x;
  actor.y = y;
  return actor;
}

/** Every Record-lane line this socket has been sent, flattened, in order. */
function logLines(client: Client): string[] {
  const out: string[] = [];
  for (const frame of client.all('log')) {
    const lines = frame['lines'];
    if (!Array.isArray(lines)) continue;
    for (const line of lines) {
      if (typeof line === 'object' && line !== null && 'text' in line) {
        out.push(String((line as { text: unknown }).text));
      }
    }
  }
  return out;
}

/** The ids carried by every `left` frame, in order. */
function leftIds(client: Client): string[] {
  return client.all('left').map((frame) => String(frame['id']));
}

/** A husk on a tile, ready to be killed. */
function husk(id: string, x: number, y: number, hp = HUSK_MAX_HP): Actor {
  const monster = server.world.addMonster(id, {
    name: 'Index Husk',
    sprite: HUSK_SPRITE,
    x,
    y,
    profile: AiProfile.MeleeChaser,
    maxHp: HUSK_MAX_HP,
  });
  monster.hp = hp;
  return monster;
}

// ===========================================================================

describe('the kill is narrated before the body leaves', () => {
  it('names the monster and prints a real maxHp, then sends ONE `left` for it', async () => {
    // ═══════════════════════════════════════════════════════════════════════
    // THE 'someone is unfiled' / '0/0' REGRESSION, PINNED FROM THE WIRE.
    // ═══════════════════════════════════════════════════════════════════════
    //
    // `nameOf` is `world.getActor(id)?.name ?? 'someone'` and `hitToWire` reads
    // `world.getActor(targetId)?.maxHp ?? 0`. Both resolve by ID, after the pump
    // has returned. Reap one line earlier — inside the pump, or before
    // `broadcastRecord` — and the whole kill is narrated about a body that is no
    // longer there.
    server = await boot('reap-narration');
    const client = await connect(server.port);
    const welcome = await client.hello();
    const ren = placeAt(actorOf(String(welcome?.['selfId'])), 10, 10);
    ren.hpRegen = 0;
    ren.combat = NEVER_MISSES;
    husk('m_husk', 11, 10, 1);
    client.clear();

    await client.settle({ t: 'move', dir: 'e' });

    const lines = logLines(client);
    /**
     * NAMED, BECAUSE THE SERVER HAS ALWAYS KNOWN. `Game.lua:1686` writes
     * "#Source# killed #Target#!"; ours dropped `killerId` on the floor while
     * `turn-engine.ts:923` and `:1325` both populated it.
     *
     * THE ABSENT CASE IS REAL and is pinned in `gateway-record.test.ts` rather
     * than here: `OPTIONAL_ACTOR_IDS` redacts `killerId` for a killer the viewer
     * cannot see, and a death from an effect whose source is gone carries none
     * at all — the line degrades to the bare sentence in both.
     */
    expect(lines).toContain('Index Husk is unfiled by Player 1.');
    expect(lines.some((line) => line.includes('someone'))).toBe(false);
    // The damage line carries the victim's ABSOLUTE vitals, and the maximum is
    // read off the body. `0/0` is what a reaped-too-early body reports.
    expect(lines.some((line) => line.endsWith(`Index Husk 0/${String(HUSK_MAX_HP)}.`))).toBe(true);

    // …and only then is the body removed, exactly once.
    expect(leftIds(client)).toEqual(['m_husk']);
    expect(server.world.getActor('m_husk')).toBeUndefined();
  });

  it('leaves the corpse out of the next full board any client is sent', async () => {
    // `projectActors` has no `alive` filter and the renderer never checks the
    // flag, so a corpse in this list is a husk drawn with its LIVE sprite. That
    // is the bug a player reported, and it is why the reap window sits ABOVE the
    // resync rather than below it.
    server = await boot('reap-board');
    const client = await connect(server.port);
    const welcome = await client.hello();
    const ren = placeAt(actorOf(String(welcome?.['selfId'])), 10, 10);
    ren.hpRegen = 0;
    ren.combat = NEVER_MISSES;
    husk('m_husk', 11, 10, 1);

    await client.settle({ t: 'move', dir: 'e' });

    const second = await connect(server.port);
    const board = await second.hello();
    const actors = board?.['actors'];
    if (!Array.isArray(actors)) throw new Error('the welcome carried no actor list');

    expect(actors.map((row: { id?: unknown }) => String(row.id))).not.toContain('m_husk');
  });
});

describe('an orb outlives its shooter', () => {
  it('still lands, and is still narrated with the shooter’s name', async () => {
    // ═══════════════════════════════════════════════════════════════════════
    // THE REASON THE REAP IS DELIBERATELY *NOT* PART OF THE PUMP.
    // ═══════════════════════════════════════════════════════════════════════
    //
    // engine/projectile.ts is explicit that the orb carries everything it needs
    // and that the shooter may be a corpse when it lands, so `reap` does not
    // clear the sky. The impact arrives as an ordinary `attack` step attributed
    // to `proj.sourceId` — and the Record lane resolves that id through
    // `world.getActor`. Both happen inside `broadcastRecord`, which runs BEFORE
    // the reap loop, so a shooter that dies in the same pump as its own orb
    // lands is still there to be named.
    server = await boot('reap-orb');
    const client = await connect(server.port);
    const welcome = await client.hello();
    const ren = placeAt(actorOf(String(welcome?.['selfId'])), 10, 10);
    ren.hpRegen = 0;
    ren.combat = NEVER_MISSES;

    // The shooter, one tile east and already at death's door.
    husk('m_husk', 11, 10, 1);
    // …and its shot, two tiles west of Ren and fast enough to cross inside one
    // game turn. Put in the air by hand: what is under test is the ORDER of the
    // gateway's three steps, not the wraith's AI.
    server.world.addProjectile({
      sourceId: 'm_husk',
      origin: { x: 8, y: 10 },
      to: { x: 10, y: 10 },
      projSpeed: 6,
      range: 10,
      damage: { dam: 5, type: DamageType.Physical, apr: 0 },
    });
    client.clear();

    await client.settle({ t: 'move', dir: 'e' });

    const lines = logLines(client);
    // The blow landed on Ren, attributed by name to the body that fired it…
    expect(lines.some((line) => line.startsWith('Index Husk hits '))).toBe(true);
    // …and nothing anywhere was narrated about 'someone'.
    expect(lines.some((line) => line.includes('someone'))).toBe(false);
    // The shooter is gone all the same — an orb in flight is not a reason to
    // keep a corpse on the map.
    expect(leftIds(client)).toEqual(['m_husk']);
    expect(server.world.getActor('m_husk')).toBeUndefined();
    expect(server.world.projectilesInFlight()).toHaveLength(0);
  });

  it('is STILL named when it lands a pump or two after the shooter was buried', async () => {
    // ═══════════════════════════════════════════════════════════════════════
    // THE CASE THE REAP WINDOW CANNOT COVER, AND USED TO CLAIM IT DID.
    // ═══════════════════════════════════════════════════════════════════════
    //
    // Three separate comments asserted that reaping AFTER the narration keeps an
    // orb's shooter attributable "for up to three turns". It does not: the window
    // is ONE PUMP wide, and INDEX_WRAITH authors `projSpeed 2` over
    // `attackRange 6`, so its orb needs two to three GAME TURNS to arrive. The
    // normal case was the unprotected one, and it printed
    //
    //     someone hits Ren.   14 damage.
    //
    // for the single biggest hit in the game — the exact string the test above
    // asserts must never appear, arriving through the door that test does not
    // watch. The fix is a name memo in the gateway that lives exactly as long as
    // something is in the air (`reapedNames`).
    server = await boot('reap-orb-later');
    const client = await connect(server.port);
    const welcome = await client.hello();
    const ren = placeAt(actorOf(String(welcome?.['selfId'])), 10, 10);
    ren.hpRegen = 0;
    ren.maxHp = 500;
    ren.hp = 500;
    ren.combat = NEVER_MISSES;

    husk('m_husk', 11, 10, 1);
    // SLOW, and fired from far enough away that it cannot possibly arrive in the
    // pump that kills the shooter. This is the wraith's own geometry.
    server.world.addProjectile({
      sourceId: 'm_husk',
      origin: { x: 3, y: 10 },
      to: { x: 10, y: 10 },
      projSpeed: 2,
      range: 12,
      damage: { dam: 14, type: DamageType.Physical, apr: 0 },
    });
    client.clear();

    // Pump one: Ren kills the shooter. The orb is still several tiles out.
    await client.settle({ t: 'move', dir: 'e' });
    expect(leftIds(client)).toEqual(['m_husk']);
    expect(server.world.getActor('m_husk')).toBeUndefined();
    expect(server.world.projectilesInFlight().length).toBeGreaterThan(0);

    // ...and then stand still until it arrives.
    client.clear();
    for (let turn = 0; turn < 6 && server.world.projectilesInFlight().length > 0; turn += 1) {
      await client.settle({ t: 'hold' });
    }

    const lines = logLines(client);
    expect(server.world.projectilesInFlight()).toHaveLength(0);
    expect(lines.some((line) => line.startsWith('Index Husk hits '))).toBe(true);
    expect(lines.some((line) => line.includes('someone'))).toBe(false);
  });
});

describe('a player is never reaped', () => {
  it('sends no `left` for a body that is merely on the floor', async () => {
    // ═══════════════════════════════════════════════════════════════════════
    // `left` DELETES THE BODY ON EVERY CLIENT. IT MUST NEVER NAME A PLAYER.
    // ═══════════════════════════════════════════════════════════════════════
    //
    // `world.removePlayer` IS `world.removeActor` — the same closure — so the
    // only thing standing between a downed detective and deletion is the
    // POSITIVE `kind === 'monster'` guard inside `reap`. engine/downed.ts is
    // explicit that M4 ships no permadeath and that an ally has to be able to
    // walk to the body; a client that had deleted it would draw nothing to walk
    // to, and the party panel would show a countdown over an empty tile.
    server = await boot('reap-spares-players');
    const client = await connect(server.port);
    const welcome = await client.hello();
    const ren = placeAt(actorOf(String(welcome?.['selfId'])), 10, 10);
    ren.hpRegen = 0;
    ren.hp = 1;

    // A SECOND DETECTIVE, ACROSS THE ROOM. Without one this is a party of one,
    // the first body on the floor IS a wipe, and the floor reset would stand
    // them straight back up for a reason that has nothing to do with the claim.
    const witness = await connect(server.port);
    const other = await witness.hello();
    placeAt(actorOf(String(other?.['selfId'])), 3, 3).hpRegen = 0;

    // The thing that puts Ren down: adjacent, lands every blow, hits hard
    // enough to end a detective in one.
    const killer = server.world.addMonster('m_killer', {
      name: 'Index Husk',
      sprite: HUSK_SPRITE,
      x: 11,
      y: 10,
      profile: AiProfile.MeleeChaser,
      combat: NEVER_MISSES,
    });
    killer.hp = killer.maxHp;
    client.clear();

    // BOTH detectives pass, for as many turns as it takes the husk to swing.
    // Only one of them holding would park the barrier on the other, and a
    // parked barrier is a pump in which no monster ever gets a turn.
    for (let round = 0; round < 5 && actorOf(ren.id).alive; round += 1) {
      witness.send({ t: 'hold' });
      await client.settle({ t: 'hold' });
    }

    // They really did go down — otherwise this test passes by doing nothing.
    expect(logLines(client).some((line) => line.includes('is DOWN'))).toBe(true);
    expect(actorOf(ren.id).alive).toBe(false);
    // …and no `left` was minted for anybody at all: nothing else died.
    expect(leftIds(client)).toEqual([]);
    expect(server.world.getActor(ren.id)).toBeDefined();
  });

  it('tells a lone player nobody is left standing, not that "the party" is down', async () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * A PARTY OF ONE IS NOT A PARTY, AND THE DOWNED LINE ALREADY KNEW THAT.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * Driving a solo Watchman into a `grim` site produced, verbatim:
     *
     *     Player 1 is DOWN — 5 turns, and nobody is coming.
     *     Player 1 is erased — the party is down. The floor resets.
     *
     * The first line knows it is speaking to somebody by themselves — it was
     * written for exactly that, because "N turns to reach them" is an
     * instruction addressed to nobody when you are alone. The second announces
     * the collapse of a party of one, one beat later, at the moment the game is
     * explaining why the run ended.
     *
     * NO SECOND DETECTIVE HERE, which is the whole setup: the test above needs
     * one precisely BECAUSE a party of one makes the first body on the floor a
     * wipe. That is the case this asserts.
     */
    server = await boot('erased-alone');
    const client = await connect(server.port);
    const welcome = await client.hello();
    const ren = placeAt(actorOf(String(welcome?.['selfId'])), 10, 10);
    ren.hpRegen = 0;
    ren.hp = 1;

    const killer = server.world.addMonster('m_killer', {
      name: 'Index Husk',
      sprite: HUSK_SPRITE,
      x: 11,
      y: 10,
      profile: AiProfile.MeleeChaser,
      combat: NEVER_MISSES,
    });
    killer.hp = killer.maxHp;
    client.clear();

    for (let round = 0; round < 5; round += 1) {
      client.send({ t: 'hold' });
      await client.settle({ t: 'hold' });
    }

    const lines = logLines(client);
    // It really did happen, or the two assertions below pass by finding nothing.
    expect(lines.some((line) => line.includes('is erased'))).toBe(true);
    expect(lines.some((line) => line.includes('nobody is left standing'))).toBe(true);
    expect(
      lines.some((line) => line.includes('the party is down')),
      'a player by themselves was told a party went down',
    ).toBe(false);
  });
});
