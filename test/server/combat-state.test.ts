import { describe, expect, it } from 'vitest';

import { AiProfile } from '../../src/server/engine/actor.ts';
import { createDownedState, goDown } from '../../src/server/engine/downed.ts';
import { actorIdForUser } from '../../src/server/net/gateway.ts';
import { createTurnEngine } from '../../src/server/turn-engine.ts';
import { projectTurn } from '../../src/server/view/projector.ts';
import { createWorld } from '../../src/server/world/world.ts';
import { MONSTERS_TURN_ID, TurnActorKind } from '../../src/shared/protocol.ts';
import type { TurnEngine } from '../../src/server/net/gateway.ts';
import type { TurnState } from '../../src/server/view/projector.ts';
import type { Actor, World } from '../../src/server/world/world.ts';
import type { TurnMsg } from '../../src/shared/protocol.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE BUG REPORT FROM REAL PLAY, AT THE SEAM WHERE IT WAS FIXED.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * "The enemy does show up and will initiate combat when too close. The problem
 * is the players do not know when combat starts and there is no indicator that
 * it's turn-based once combat starts."
 *
 * The server has always known. `world.turn.engagement` is the level-wide combat
 * clock and it is the sole reason anybody blocks at the barrier at all — and
 * until v5 it was never projected. A client could infer "probably a fight" from
 * `whoseTurn` being non-empty, which is a DIFFERENT FACT: it arrives with no
 * transition to announce, and it reads identically to "we are waiting on one
 * straggler".
 *
 * WHAT THIS FILE IS FOR, AND HOW IT DIFFERS FROM projector.test.ts.
 *
 * That file pins `projectTurn` against hand-built barrier snapshots — the unit,
 * in isolation. This one drives the REAL engine over a REAL world wherever the
 * claim is about the fact TRAVELLING: a monster walks into view, the engagement
 * clock arms, the frame says so, and it keeps saying so through commits,
 * disconnects and reconnects without the card strip reshuffling underneath four
 * people's eyes. The two overlap deliberately at the edges; the guarantees here
 * are the ones that only mean anything end to end.
 *
 * THE STRIP IS NOT AN INITIATIVE ORDER. Inner Datum is PHASE-LOCKED
 * (DECISIONS.md D1): every player action costs exactly one full turn, so the
 * whole party decides in the SAME window and there is no queue to be in. That is
 * why the order test below asserts join order directly and why the hostile side
 * is ONE card — a row of monster cards would say eight creatures take eight
 * separately-timed turns, and a strip that reordered itself would make three
 * people wait for "their go" while the server was already waiting on all four.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const HUSK_SPRITE = 'enemy_index_husk_s';

/**
 * A barrier snapshot with the fields a test does not care about filled in.
 *
 * `engagement: 0` is the default because it is the state a fresh floor is in:
 * nothing is hunting you, nobody blocks, and a test has to say so explicitly to
 * be about combat.
 */
function barrier(over: Partial<TurnState> = {}): TurnState {
  return {
    gameTurn: 11,
    engagement: 0,
    whoseTurn: [],
    committed: [],
    standingBy: [],
    bellDurationMs: null,
    ...over,
  };
}

type Table = {
  readonly world: World;
  readonly engine: TurnEngine;
  readonly players: readonly Actor[];
  /** Hold for everybody, then pump — one whole game turn of nothing happening. */
  readonly advance: () => void;
};

/**
 * A world with `names.length` detectives on the spawn cluster and no hostiles.
 *
 * The clock is injected rather than read, exactly as the gateway injects it:
 * nothing in the turn path may call `Date.now`, and a test that slept would be
 * measuring the machine.
 */
function table(seed: string, names: readonly string[]): Table {
  const world = createWorld(seed);
  const players = names.map((name) => {
    const actor = world.addPlayer(`actor_${name.toLowerCase()}`, name);
    // Big enough that nothing in this file is secretly measuring a corpse: these
    // tests are about the turn frame, never about the fight.
    actor.maxHp = 10_000;
    actor.hp = 10_000;
    return actor;
  });

  const clock = { ms: 0 };
  const engine = createTurnEngine({ world, now: () => clock.ms });
  for (const actor of players) engine.join(actor.id);

  return {
    world,
    engine,
    players,
    advance: () => {
      // Only the people who could actually press a key. Holding on behalf of a
      // dropped socket would clear its Standing By (`noteCommand` — "any command
      // clears it"), which is the barrier telling the truth about a keyboard
      // nobody is at.
      for (const actor of players) {
        if (actor.connected && actor.alive) engine.hold(actor.id);
      }
      clock.ms += 1_000;
      engine.pump();
    },
  };
}

/** A husk, placed close enough to the spawn cluster to have line of sight. */
function husk(world: World, id: string, x: number, y: number): Actor {
  return world.addMonster(id, {
    name: 'Index Husk',
    sprite: HUSK_SPRITE,
    x,
    y,
    profile: AiProfile.MeleeChaser,
  });
}

/** The player cards only, in the order the server sent them. */
function playerIds(frame: TurnMsg): string[] {
  return frame.actors.filter((c) => c.kind === TurnActorKind.Player).map((c) => c.id);
}

// ---------------------------------------------------------------------------
// The fact itself
// ---------------------------------------------------------------------------

describe('the combat clock reaches the client', () => {
  it('carries engagement, and inCombat is exactly engagement > 0', () => {
    const world = createWorld('in-combat');
    const dalt = world.addPlayer('actor_a', 'Dalt');

    // Table-driven because the whole point of `inCombat` being SENT is that the
    // rule is written down once. A client that re-derived it would eventually
    // write `>= 1` against a decaying counter, and two clients disagreeing about
    // whether the party is in a fight is a real bug class in a game where four
    // people are looking at the same room.
    for (const engagement of [0, 1, 2, 3, 50]) {
      const frame = projectTurn(dalt, world, barrier({ engagement }), null);
      expect(frame.engagement, `engagement ${engagement} travels verbatim`).toBe(engagement);
      expect(frame.inCombat, `inCombat at engagement ${engagement}`).toBe(engagement > 0);
    }
  });

  it('arms when a hostile walks into view, and the frame says so', () => {
    // The real engine, the real level, a real husk. `world.turn.engagement` is
    // set by the scheduler's port of `checkStillInCombat` (Actor.lua:7648-7669)
    // and nothing in this test touches it by hand.
    const t = table('arm', ['Dalt', 'Sam']);
    const dalt = t.players[0];
    expect(dalt).toBeDefined();
    if (dalt === undefined) return;

    const quiet = t.engine.pump().turn;
    expect(quiet.engagement).toBe(0);
    expect(projectTurn(dalt, t.world, quiet, null).inCombat).toBe(false);
    // Out of combat nobody blocks — which is exactly why `whoseTurn` cannot
    // stand in for this fact.
    expect(quiet.whoseTurn).toEqual([]);

    husk(t.world, 'mon_a', 8, 2);
    const engaged = t.engine.pump().turn;

    expect(engaged.engagement).toBeGreaterThan(0);
    const frame = projectTurn(dalt, t.world, engaged, null);
    expect(frame.inCombat).toBe(true);
    // And the strip now has a hostile side on it, which it did not a moment ago.
    expect(frame.actors.at(-1)?.id).toBe(MONSTERS_TURN_ID);
  });

  it('lets go again once the floor has lost the party', () => {
    // Engagement DECAYS rather than snapping to zero (ENGAGEMENT_TURNS = 3), so
    // "the fight is over" arrives several turns after the last body fell. That
    // decay is the half of the crossing a client cannot see coming.
    const t = table('decay', ['Dalt']);
    const dalt = t.players[0];
    expect(dalt).toBeDefined();
    if (dalt === undefined) return;

    const monster = husk(t.world, 'mon_a', 8, 2);
    t.engine.pump();
    expect(t.engine.turnState().engagement).toBeGreaterThan(0);

    // A corpse is scenery: `anyContact` skips it, so the clock starts running down.
    monster.alive = false;

    const seen: boolean[] = [];
    for (let i = 0; i < 8; i += 1) {
      t.advance();
      seen.push(projectTurn(dalt, t.world, t.engine.turnState(), null).inCombat);
    }

    expect(seen).toContain(true);
    expect(seen.at(-1)).toBe(false);
    // It falls once and stays down — never flickers back on with nothing alive.
    expect(seen.lastIndexOf(true)).toBeLessThan(seen.indexOf(false));
  });
});

// ---------------------------------------------------------------------------
// The zero crossing — the moment somebody has to be TOLD
// ---------------------------------------------------------------------------

/**
 * EVERYTHING THE PRE-M5 CHANGE KEY WAS MADE OF, reproduced here as the BUG.
 *
 * `turnKey` in src/server/net/gateway.ts is module-private, so this is not a
 * second implementation of it — it is the v4 key, written out so the collision
 * can be demonstrated rather than described. The gateway's key gained
 * `state.engagement` as a term for exactly the reason these tests show: 0 -> n
 * is the instant combat starts and n -> 0 the instant it ends, NEITHER
 * NECESSARILY MOVES THE QUORUM, and a frame suppressed as a duplicate is a
 * transition the client was never sent and therefore cannot announce.
 */
function legacyKey(state: TurnState): string {
  return [
    state.gameTurn,
    state.whoseTurn.join(','),
    state.committed.join(','),
    state.standingBy.join(','),
    state.bellDurationMs === null ? '-' : 'bell',
  ].join('|');
}

describe('the zero crossing is a frame, not a silence', () => {
  it('opens a fight the quorum cannot see: every player already Standing By', () => {
    // The concrete case the gateway's comment names. Two detectives are out of
    // the quorum — two silent turns each, or two dropped sockets — so the
    // blocking set is EMPTY both before and after the husks arrive. Under the v4
    // key these two moments are the same message.
    const world = createWorld('crossing-open');
    const dalt = world.addPlayer('actor_a', 'Dalt');
    world.addPlayer('actor_b', 'Sam');
    husk(world, 'mon_a', 8, 2);

    const parked = { standingBy: ['actor_a', 'actor_b'] };
    const free = barrier({ ...parked, engagement: 0 });
    const engaged = barrier({ ...parked, engagement: 3 });

    // The v4 surface is byte-identical across the crossing...
    expect(free.whoseTurn).toEqual(engaged.whoseTurn);
    expect(free.committed).toEqual(engaged.committed);
    expect(free.standingBy).toEqual(engaged.standingBy);
    expect(legacyKey(free)).toBe(legacyKey(engaged));

    // ...and the frames are not, which is the whole fix.
    const before = projectTurn(dalt, world, free, null);
    const after = projectTurn(dalt, world, engaged, null);
    expect(before.inCombat).toBe(false);
    expect(after.inCombat).toBe(true);
    expect(JSON.stringify(before)).not.toBe(JSON.stringify(after));
  });

  it('closes one the same way, on the decay step that reaches zero', () => {
    // The other direction, and the commoner one: engagement counts down while
    // the party is already walking around committing every turn, so the quorum
    // has not moved for three turns when the fight finally ends.
    const world = createWorld('crossing-close');
    const dalt = world.addPlayer('actor_a', 'Dalt');
    husk(world, 'mon_a', 8, 2);

    const frames = [3, 2, 1, 0].map((engagement) =>
      projectTurn(dalt, world, barrier({ engagement }), null),
    );

    const keys = [3, 2, 1, 0].map((engagement) => legacyKey(barrier({ engagement })));
    // Every step of the decay is invisible to the v4 key...
    expect(new Set(keys).size).toBe(1);
    // ...and every step is a distinct frame now.
    expect(new Set(frames.map((f) => JSON.stringify(f))).size).toBe(frames.length);

    // And `inCombat` flips exactly once, on the last step. A client watching the
    // flag rather than the number gets one announcement, not four.
    expect(frames.map((f) => f.inCombat)).toEqual([true, true, true, false]);
  });
});

// ---------------------------------------------------------------------------
// The strip's order — the property that makes it readable at all
// ---------------------------------------------------------------------------

describe('the card strip is stable, because it is not a queue', () => {
  it('holds join order through commits, a disconnect and a reconnect', () => {
    // Deliberately joined out of alphabetical order, and out of hp order, so a
    // strip sorted by ANYTHING would show up here. The order carries no
    // information on purpose: nothing in it can be mistaken for an initiative
    // queue, and no card moves under a cursor between two frames.
    const t = table('stable', ['Zed', 'Ann', 'Mo', 'Bo']);
    const zed = t.players[0];
    const ann = t.players[1];
    expect(zed).toBeDefined();
    expect(ann).toBeDefined();
    if (zed === undefined || ann === undefined) return;

    const JOINED = ['actor_zed', 'actor_ann', 'actor_mo', 'actor_bo'];
    const orders: string[][] = [];
    /** The card WORDS, kept only to prove the strip really did change underneath. */
    const shapes: string[] = [];
    const snap = (): void => {
      const frame = projectTurn(zed, t.world, t.engine.turnState(), null);
      orders.push(playerIds(frame));
      shapes.push(frame.actors.map((c) => c.state).join(','));
    };

    husk(t.world, 'mon_a', 8, 2);
    t.engine.pump();
    snap();

    // One player commits while the rest still owe a decision.
    t.engine.hold('actor_mo');
    t.engine.pump();
    snap();

    // A socket drops. game-design.md § 4: THE BODY STAYS WHERE IT FELL — it goes
    // on Standing By and the party runs at full speed. A card that vanished here
    // would delete the person the party most needs to be looking at, and a card
    // that MOVED would be worse: it would look like the turn order changed
    // because somebody's wifi did.
    t.engine.setConnected('actor_ann', false);
    t.engine.pump();
    snap();

    // Several turns pass with them still gone.
    t.advance();
    t.advance();
    snap();

    // And they come back.
    t.engine.setConnected('actor_ann', true);
    t.engine.pump();
    snap();

    // Somebody goes down. Still on the strip, still in the same place.
    const downed = createDownedState();
    goDown(downed, zed, t.engine.turnState().gameTurn);
    const fallen = projectTurn(ann, t.world, t.engine.turnState(), null, downed);
    orders.push(playerIds(fallen));
    shapes.push(fallen.actors.map((c) => c.state).join(','));

    for (const [i, order] of orders.entries()) {
      expect(order, `frame ${i}`).toEqual(JOINED);
    }
    expect(orders).toHaveLength(6);
    // AND THE STRIP REALLY DID CHANGE UNDERNEATH, or the equality above would be
    // six copies of one frame rather than a stability result.
    expect(new Set(shapes).size).toBeGreaterThan(1);
  });

  it('keeps every detective on the strip, including the ones nobody is waiting for', () => {
    const t = table('present', ['Zed', 'Ann']);
    const zed = t.players[0];
    expect(zed).toBeDefined();
    if (zed === undefined) return;

    husk(t.world, 'mon_a', 8, 2);
    t.engine.setConnected('actor_ann', false);
    t.engine.pump();

    const state = t.engine.turnState();
    // The barrier has genuinely dropped them from the quorum...
    expect(state.whoseTurn).not.toContain('actor_ann');
    // ...and the strip still has their face on it.
    const frame = projectTurn(zed, t.world, state, null);
    expect(playerIds(frame)).toEqual(['actor_zed', 'actor_ann']);
    expect(frame.actors.find((c) => c.id === 'actor_ann')?.state).toBe('standing_by');
  });
});

// ---------------------------------------------------------------------------
// The hostile side — ONE card, however many husks
// ---------------------------------------------------------------------------

describe('the hostile side is one card', () => {
  it('stays one entry whether one husk is on the floor or seven', () => {
    // They resolve TOGETHER: `SweepMsg` carries the whole monster turn in one
    // frame precisely so four people do not watch eight individually-timed
    // turns, and the card strip has to tell the same story the wire does.
    const world = createWorld('one-card');
    const dalt = world.addPlayer('actor_a', 'Dalt');
    const engaged = barrier({ engagement: 3, whoseTurn: ['actor_a'] });

    const aggregates = (): TurnMsg['actors'] =>
      projectTurn(dalt, world, engaged, null).actors.filter(
        (c) => c.kind === TurnActorKind.Monsters,
      );

    // Engaged with nothing left standing — the turn the last husk died, before
    // engagement has decayed off. Still one card, and honestly faceless.
    expect(aggregates()).toHaveLength(1);
    expect(aggregates()[0]?.portrait).toBeUndefined();

    for (let i = 0; i < 7; i += 1) {
      husk(world, `mon_${i}`, 8 + i, 2);
      expect(aggregates(), `${i + 1} husks`).toHaveLength(1);
    }

    const [side] = aggregates();
    expect(side?.id).toBe(MONSTERS_TURN_ID);
    // A GROUP, never a creature. "Index Husk" on a card beside four detectives
    // would say one husk is taking a turn.
    expect(side?.name).toBe('The Filed');
    // The sum over the living hostiles — how much fight is left in the other
    // side, drawn as a group bar.
    expect(side?.maxHp).toBe(
      world
        .allActors()
        .filter((a) => a.kind === 'monster')
        .reduce((total, a) => total + a.maxHp, 0),
    );
  });

  it('is last, so its arrival never shifts a player card sideways', () => {
    const world = createWorld('last');
    const dalt = world.addPlayer('actor_a', 'Dalt');
    world.addPlayer('actor_b', 'Sam');
    husk(world, 'mon_a', 8, 2);

    const free = projectTurn(dalt, world, barrier(), null);
    const engaged = projectTurn(dalt, world, barrier({ engagement: 3 }), null);

    expect(free.actors.map((c) => c.id)).toEqual(['actor_a', 'actor_b']);
    expect(engaged.actors.map((c) => c.id)).toEqual(['actor_a', 'actor_b', MONSTERS_TURN_ID]);
    // Out of combat there is nothing hunting you, and a card for it would say
    // the party is waiting on something.
    expect(free.actors.some((c) => c.kind === TurnActorKind.Monsters)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Per-recipient — the flag that made `turn` a ViewerMsg
// ---------------------------------------------------------------------------

describe('the frame is built per recipient', () => {
  it('marks exactly one card as self, and a different one for each viewer', () => {
    const t = table('self', ['Dalt', 'Sam', 'Mo']);
    const [dalt, sam] = t.players;
    expect(dalt).toBeDefined();
    expect(sam).toBeDefined();
    if (dalt === undefined || sam === undefined) return;

    husk(t.world, 'mon_a', 8, 2);
    const state = t.engine.pump().turn;

    const asDalt = projectTurn(dalt, t.world, state, null);
    const asSam = projectTurn(sam, t.world, state, null);

    expect(asDalt.actors.filter((c) => c.isSelf).map((c) => c.id)).toEqual(['actor_dalt']);
    expect(asSam.actors.filter((c) => c.isSelf).map((c) => c.id)).toEqual(['actor_sam']);
    // Never the aggregate. There is no body behind that card to be.
    expect(asDalt.actors.find((c) => c.id === MONSTERS_TURN_ID)?.isSelf).toBe(false);

    // AND NOTHING ELSE DIFFERS, which is the argument for unicasting the frame
    // rather than hiding something in it: every card on the tracker is public,
    // and the ONE flag that is true for one person is why a shared copy would
    // highlight the wrong player's card on three screens.
    const stripped = (frame: TurnMsg): string =>
      JSON.stringify({ ...frame, actors: frame.actors.map(({ isSelf: _s, ...rest }) => rest) });
    expect(stripped(asDalt)).toBe(stripped(asSam));
  });

  it('highlights nobody for a socket with no body', () => {
    // A spectator, or a body still being assigned. "No card is highlighted" has
    // to be a fact the server states rather than a comparison that happens to
    // fail in the browser.
    const world = createWorld('spectator');
    world.addPlayer('actor_a', 'Dalt');
    const ghost = world.addMonster('mon_ghost', {
      name: 'Index Husk',
      sprite: HUSK_SPRITE,
      x: 8,
      y: 2,
      profile: AiProfile.MeleeChaser,
    });

    const frame = projectTurn(ghost, world, barrier({ engagement: 3 }), null);
    expect(frame.actors.some((c) => c.isSelf)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Containment — CLAUDE.md non-negotiable 7
// ---------------------------------------------------------------------------

describe('no Discord id reaches a turn frame', () => {
  /** Snowflake-SHAPED, and nobody's real account. */
  const SNOWFLAKE = '135790246813579024';

  it('carries the hashed actor id and never the account behind it', () => {
    // `actorIdForUser` is the ONE producer of a verified player's actor id and it
    // hashes: `actor_u_<16 hex>`. Nothing downstream has to remember to strip
    // anything, because there is nothing here to strip — which is the only way
    // to be sure a snowflake never lands in a client's memory or a log excerpt.
    const actorId = actorIdForUser(SNOWFLAKE);
    expect(actorId).not.toContain(SNOWFLAKE);
    expect(actorId).toMatch(/^actor_u_[0-9a-f]{16}$/);

    const world = createWorld('containment');
    const ren = world.addPlayer(actorId, 'Ren');
    world.addPlayer(actorIdForUser('864209753186420975'), 'Alex');
    husk(world, 'mon_a', 8, 2);

    const downed = createDownedState();
    const frame = projectTurn(
      ren,
      world,
      barrier({ engagement: 3, whoseTurn: [actorId], standingBy: [] }),
      12_000,
      downed,
    );

    const wire = JSON.stringify(frame);
    // Not vacuous: the frame really is about this player.
    expect(wire).toContain(actorId);
    expect(wire).not.toContain(SNOWFLAKE);
    expect(wire).not.toContain('864209753186420975');

    // Belt and braces on the shape rather than on one string: every id on the
    // strip is either a body's actor id or the namespaced aggregate, and no
    // other field is an identifier at all.
    for (const card of frame.actors) {
      expect(card.id === MONSTERS_TURN_ID || /^(actor_|p\d)/.test(card.id)).toBe(true);
    }
  });

  it('puts nothing on a card beyond the nine fields the tracker draws', () => {
    // Spelled out as a key check because the failure mode is ADDITIVE: somebody
    // spreads the engine actor one day and `energy`, `pendingIntent` and the
    // AI's target are on the wire — and energy alone would let a client compute
    // the turn order in advance.
    const world = createWorld('fields');
    const dalt = world.addPlayer('actor_a', 'Dalt');
    husk(world, 'mon_a', 8, 2);

    const frame = projectTurn(dalt, world, barrier({ engagement: 3 }), null);
    const expected = [
      'downed',
      'hp',
      'id',
      'isSelf',
      'kind',
      'maxHp',
      'name',
      'portrait',
      'state',
    ].sort();

    for (const card of frame.actors) {
      expect(Object.keys(card).sort(), card.id).toEqual(expected);
    }
    // And the envelope itself: the three legacy arrays, the two new numbers, the
    // strip and the Bell. Nothing has quietly joined them.
    expect(Object.keys(frame).sort()).toEqual(
      [
        'actors',
        'bellMs',
        'committed',
        'engagement',
        'gameTurn',
        'inCombat',
        'standingBy',
        't',
        'v',
        'whoseTurn',
      ].sort(),
    );
  });
});
