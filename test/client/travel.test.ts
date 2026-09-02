import { describe, expect, it } from 'vitest';

import {
  TravelHalt,
  TravelObservation,
  TravelStart,
  createTravel,
  hostileAlert,
} from '../../src/client/input/travel.ts';
import { DIR_ORDER, step } from '../../src/shared/coords.ts';
import {
  ActorKind,
  ActorRank,
  TileCode,
  TurnActorKind,
  TurnActorState,
} from '../../src/shared/protocol.ts';
import { PROTOCOL_VERSION } from '../../src/shared/version.ts';
import type { HostileSense, TravelWorld } from '../../src/client/input/travel.ts';
import type { TileXY } from '../../src/shared/coords.ts';
import type { ActorView, LevelView, TurnMsg } from '../../src/shared/protocol.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE TRAVEL STATE MACHINE. NOTHING IS DRAWN AND NOTHING IS SENT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * vitest.config.ts has no jsdom on purpose, and src/client/input/travel.ts is
 * written to need none: it is fed observations and asked for a direction. So
 * what is asserted below is the DECISION layer — the step gate, the interrupts
 * and the direction derivation — in the same spirit as test/client/turncards.ts,
 * which reads a HUD without painting one.
 *
 * THREE OF THESE TESTS ARE ABOUT A STALL RATHER THAN A WRONG ANSWER, and they
 * are the reason the file exists:
 *
 *   1. OUT OF COMBAT EVERY CARD READS `committed` (barrier.ts: at zero nobody
 *      ever blocks, so the barrier is waiting on nobody and the projector says
 *      so). A gate that waited for `waiting` would therefore never fire exactly
 *      when travel is most used — free movement is most of a session.
 *   2. IN COMBAT A SECOND STEP MUST NOT GO OUT BEFORE THE FIRST ONE LANDS, or
 *      it sits in `pendingIntent` and resolves the moment energy tops up,
 *      pre-committing the next turn behind every interrupt check.
 *   3. AND NOT BEFORE THE GAME TURN HAS MOVED ON EITHER. The gateway sends a
 *      player's own `moved` BEFORE the `turn` frame that records the commit, so
 *      "the last step landed" is true for a moment while the turn snapshot still
 *      describes the turn that just ended — and both halves of the old two-part
 *      gate opened on it. `lastStepTurn` is the latch that holds.
 *
 * The maps are ASCII because the claim under test is usually geometric and a
 * flat `number[]` is unreadable. `#` is wall, everything else is floor.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function mapOf(rows: readonly string[]): LevelView {
  const h = rows.length;
  const w = rows[0]?.length ?? 0;
  const tiles: number[] = [];
  for (const row of rows) {
    if (row.length !== w) throw new Error(`ragged test map: "${row}" is not ${w} wide`);
    for (let x = 0; x < w; x += 1) {
      tiles.push(row.charAt(x) === '#' ? TileCode.WALL : TileCode.FLOOR);
    }
  }
  return { w, h, tiles };
}

/** A walled 10x8 field with nothing in it. Everything inside the border is floor. */
const OPEN = mapOf([
  '##########',
  '#........#',
  '#........#',
  '#........#',
  '#........#',
  '#........#',
  '#........#',
  '##########',
]);

/**
 * A room with no door: (3..6, 3..4) is sealed by walls on all four sides AND at
 * every corner, so not even a corner-cutting diagonal gets in.
 */
const SEALED = mapOf([
  '##########',
  '#........#',
  '#.######.#',
  '#.#....#.#',
  '#.#....#.#',
  '#.######.#',
  '#........#',
  '##########',
]);

/**
 * (2,1) and (1,2) are walls, (2,2) is floor. Stepping (1,1) -> (2,2) is a
 * DIAGONAL BETWEEN TWO ORTHOGONAL WALLS, which world.ts:442-446 documents as
 * permitted ("RULE SEAM — CORNER CUTTING ... allowed here, which is what ToME
 * does"). A client that forbade it would refuse a route the server walks.
 */
const CORNER = mapOf(['#####', '#.#.#', '##..#', '#...#', '#####']);

function husk(id: string, x: number, y: number, alive = true): ActorView {
  return {
    id,
    name: 'Index Husk',
    sprite: 'enemy_index_husk_s',
    x,
    y,
    kind: ActorKind.Monster,
    rank: ActorRank.Normal,
    hp: alive ? 12 : 0,
    maxHp: 12,
    alive,
  };
}

function detective(id: string, x: number, y: number): ActorView {
  return {
    id,
    name: 'Sam',
    sprite: 'chr_player_watchman_s',
    x,
    y,
    kind: ActorKind.Player,
    rank: ActorRank.Normal,
    hp: 30,
    maxHp: 30,
    alive: true,
  };
}

/**
 * A `turn` frame carrying one self card in `state`.
 *
 * Hand-built rather than projected: the claim under test is the gate reading a
 * card, and a test importing the real projector would need `reference lib="dom"`
 * dragged in for no gain (turncards.test.ts pays that cost for a different and
 * larger claim). The OTHER card is always `committed` so nothing can pass by
 * accidentally finding the wrong one.
 */
function turnFrame(inCombat: boolean, state: TurnActorState, gameTurn = 12): TurnMsg {
  return {
    v: PROTOCOL_VERSION,
    t: 'turn',
    gameTurn,
    engagement: inCombat ? 4 : 0,
    inCombat,
    actors: [
      {
        id: 'other',
        name: 'Mo',
        kind: TurnActorKind.Player,
        state: TurnActorState.Committed,
        hp: 30,
        maxHp: 30,
        isSelf: false,
        downed: false,
      },
      {
        id: 'self',
        name: 'Dalt',
        kind: TurnActorKind.Player,
        state,
        hp: 30,
        maxHp: 30,
        isSelf: true,
        downed: false,
      },
    ],
    whoseTurn: [],
    committed: [],
    standingBy: [],
    bellMs: null,
  };
}

function world(over: Partial<TravelWorld> = {}): TravelWorld {
  return { self: { x: 2, y: 2 }, level: OPEN, actors: [], turn: null, ...over };
}

// ---------------------------------------------------------------------------
// begin()
// ---------------------------------------------------------------------------

describe('travel.begin', () => {
  it('starts on clear floor and previews the tiles ahead, never the one under you', () => {
    const travel = createTravel();
    const from = { x: 2, y: 2 };

    expect(travel.begin({ from, to: { x: 6, y: 2 }, level: OPEN, stopShort: false })).toBe(
      TravelStart.Started,
    );
    expect(travel.active()).toBe(true);
    expect(travel.preview()).toEqual([
      { x: 3, y: 2 },
      { x: 4, y: 2 },
      { x: 5, y: 2 },
      { x: 6, y: 2 },
    ]);
    expect(travel.destination()).toEqual({ x: 6, y: 2 });
  });

  it('answers already-there for the tile you stand on, and starts nothing', () => {
    const travel = createTravel();
    const start = travel.begin({
      from: { x: 4, y: 3 },
      to: { x: 4, y: 3 },
      level: OPEN,
      stopShort: false,
    });

    // `[]` from findPath, NEVER conflated with null — path.ts:303-311.
    expect(start).toBe(TravelStart.AlreadyThere);
    expect(travel.active()).toBe(false);
    expect(travel.preview()).toEqual([]);
  });

  it('answers no-route into a sealed room and stays idle', () => {
    const travel = createTravel();
    const start = travel.begin({
      from: { x: 1, y: 1 },
      to: { x: 4, y: 3 },
      level: SEALED,
      stopShort: false,
    });

    expect(start).toBe(TravelStart.NoRoute);
    expect(travel.active()).toBe(false);
    expect(travel.destination()).toBeNull();
  });

  it('drops the final tile when stopping short, so the walk ends beside the target', () => {
    const travel = createTravel();
    // (6,2) is where a husk would be standing; we mean to end on (5,2).
    expect(
      travel.begin({ from: { x: 2, y: 2 }, to: { x: 6, y: 2 }, level: OPEN, stopShort: true }),
    ).toBe(TravelStart.Started);
    expect(travel.destination()).toEqual({ x: 5, y: 2 });
    expect(travel.preview()).not.toContainEqual({ x: 6, y: 2 });
  });
});

// ---------------------------------------------------------------------------
// nextStep() — the gate
// ---------------------------------------------------------------------------

describe('travel.nextStep', () => {
  function walking(): ReturnType<typeof createTravel> {
    const travel = createTravel();
    travel.begin({ from: { x: 2, y: 2 }, to: { x: 6, y: 2 }, level: OPEN, stopShort: false });
    return travel;
  }

  it('offers nothing while a step is still in flight', () => {
    const travel = walking();

    expect(travel.nextStep(world())).toEqual({ dir: 'e' });
    // Nothing has confirmed the first step. A second `move` now would land in
    // pendingIntent and silently pre-commit the next turn.
    expect(travel.nextStep(world())).toBeNull();
  });

  it('waits in combat while the self card reads committed', () => {
    const travel = walking();
    const turn = turnFrame(true, TurnActorState.Committed);

    expect(travel.nextStep(world({ turn }))).toBeNull();
    expect(travel.active()).toBe(true);
  });

  it('steps in combat when the self card reads waiting, and again when it reads bell', () => {
    const waiting = walking();
    expect(waiting.nextStep(world({ turn: turnFrame(true, TurnActorState.Waiting) }))).toEqual({
      dir: 'e',
    });

    const bell = walking();
    expect(bell.nextStep(world({ turn: turnFrame(true, TurnActorState.Bell) }))).toEqual({
      dir: 'e',
    });
  });

  it('steps out of combat even though every card reads committed', () => {
    const travel = walking();
    // THE STALL THE SURVEY WARNED ABOUT. At engagement 0 nobody blocks, so the
    // projector marks everyone `committed` — including the traveller. Gating on
    // `waiting` here would freeze travel during free movement, which is most of
    // a session.
    const turn = turnFrame(false, TurnActorState.Committed);

    expect(travel.nextStep(world({ turn }))).toEqual({ dir: 'e' });
  });

  it('derives the direction by walking DIR_ORDER, for all eight neighbours', () => {
    const from = { x: 4, y: 3 };
    for (const dir of DIR_ORDER) {
      const travel = createTravel();
      const to = step(from, dir);
      expect(travel.begin({ from, to, level: OPEN, stopShort: false })).toBe(TravelStart.Started);
      expect(travel.nextStep(world({ self: from }))).toEqual({ dir });
    }
  });

  it('cuts a corner between two orthogonal walls, because the server permits it', () => {
    const travel = createTravel();
    const from = { x: 1, y: 1 };

    expect(travel.begin({ from, to: { x: 2, y: 2 }, level: CORNER, stopShort: false })).toBe(
      TravelStart.Started,
    );
    expect(travel.nextStep(world({ self: from, level: CORNER }))).toEqual({ dir: 'se' });
  });

  it('cancels rather than stepping when a live body is on the next tile', () => {
    const travel = walking();

    expect(travel.nextStep(world({ actors: [husk('m1', 3, 2)] }))).toBeNull();
    expect(travel.active()).toBe(false);
  });

  it('walks over a corpse, which does not block on the server either', () => {
    const travel = walking();

    expect(travel.nextStep(world({ actors: [husk('m1', 3, 2, false)] }))).toEqual({ dir: 'e' });
  });

  // -------------------------------------------------------------------------
  // GATE (iii) — one step per GAME TURN, and the reason gate (i) cannot do it.
  // -------------------------------------------------------------------------

  it('refuses a second step on the same game turn even after the moved frame lands', () => {
    const travel = walking();
    const turnT = turnFrame(false, TurnActorState.Committed, 40);

    expect(travel.nextStep(world({ turn: turnT }))).toEqual({ dir: 'e' });

    // THE EXACT ORDERING THE GATEWAY PRODUCES. `pumpAndBroadcast` fans out the
    // player lane before it calls `broadcastTurnIfChanged`, so the tick that
    // fires on this `moved` sees a cleared `awaitingStep` AND a turn snapshot
    // that still describes turn 40 — under which gate (ii) says yes. Without
    // the latch a SECOND move goes out inside one game turn, lands in
    // `pendingIntent` and pre-commits the next one.
    travel.observeSelfMoved({ x: 3, y: 2 });
    expect(travel.nextStep(world({ self: { x: 3, y: 2 }, turn: turnT }))).toBeNull();
    expect(travel.active()).toBe(true);
  });

  it('steps again once a turn frame says the game turn moved on', () => {
    const travel = walking();

    expect(
      travel.nextStep(world({ turn: turnFrame(false, TurnActorState.Committed, 40) })),
    ).toEqual({ dir: 'e' });
    travel.observeSelfMoved({ x: 3, y: 2 });

    expect(
      travel.nextStep(
        world({ self: { x: 3, y: 2 }, turn: turnFrame(false, TurnActorState.Committed, 41) }),
      ),
    ).toEqual({ dir: 'e' });
  });

  it('holds the latch across a cancel, so a re-click cannot put two moves in one turn', () => {
    const travel = createTravel();
    const turnT = turnFrame(false, TurnActorState.Committed, 40);

    travel.begin({ from: { x: 2, y: 2 }, to: { x: 6, y: 2 }, level: OPEN, stopShort: false });
    expect(travel.nextStep(world({ turn: turnT }))).toEqual({ dir: 'e' });

    // main.ts's mousedown cancels FIRST and starts the new walk second, which
    // resets `awaitingStep` — so gate (i) is wide open and only a latch that
    // outlives the walk stops a second move landing in the same turn.
    travel.cancel();
    travel.begin({ from: { x: 2, y: 2 }, to: { x: 2, y: 6 }, level: OPEN, stopShort: false });
    expect(travel.nextStep(world({ turn: turnT }))).toBeNull();

    // ...and the new walk is not broken, only delayed to the next turn.
    expect(
      travel.nextStep(world({ turn: turnFrame(false, TurnActorState.Committed, 41) })),
    ).toEqual({ dir: 's' });
  });
});

// ---------------------------------------------------------------------------
// The observations
// ---------------------------------------------------------------------------

describe('travel.observeSelfMoved', () => {
  it('advances the path when the server put us where we asked', () => {
    const travel = createTravel();
    travel.begin({ from: { x: 2, y: 2 }, to: { x: 5, y: 2 }, level: OPEN, stopShort: false });
    travel.nextStep(world());

    travel.observeSelfMoved({ x: 3, y: 2 });

    expect(travel.active()).toBe(true);
    expect(travel.preview()).toEqual([
      { x: 4, y: 2 },
      { x: 5, y: 2 },
    ]);
    // The gate reopened: a confirmed landing is what allows the next step.
    expect(travel.nextStep(world({ self: { x: 3, y: 2 } }))).toEqual({ dir: 'e' });
  });

  it('cancels when the server put us somewhere else', () => {
    const travel = createTravel();
    travel.begin({ from: { x: 2, y: 2 }, to: { x: 5, y: 2 }, level: OPEN, stopShort: false });
    travel.nextStep(world());

    // Shoved, or resynced. The rest of the route is a plan from a tile we are
    // no longer standing on.
    travel.observeSelfMoved({ x: 2, y: 3 });

    expect(travel.active()).toBe(false);
    expect(travel.preview()).toEqual([]);
  });

  it('ends the walk on arrival, which is not an interrupt', () => {
    const travel = createTravel();
    travel.begin({ from: { x: 2, y: 2 }, to: { x: 3, y: 2 }, level: OPEN, stopShort: false });
    travel.nextStep(world());

    travel.observeSelfMoved({ x: 3, y: 2 });

    expect(travel.active()).toBe(false);
    expect(travel.destination()).toBeNull();
  });
});

describe('travel.observeTurn', () => {
  it('does NOT stop the walk merely because a step is still in flight', () => {
    const travel = createTravel();
    travel.begin({ from: { x: 2, y: 2 }, to: { x: 6, y: 2 }, level: OPEN, stopShort: false });
    travel.nextStep(world());

    // A `turn` frame is not a game-turn edge and it is not about the viewer:
    // it is broadcast whenever ANY term of `turnKey` moves, so another player
    // committing lands one here while our own `moved` is still in flight. This
    // used to be read as "the move was silently refused" and killed the walk on
    // its first step in any party bigger than one. The refund is now unicast by
    // the server as an `error` frame; absence proves nothing.
    expect(travel.observeTurn(world({ turn: turnFrame(true, TurnActorState.Waiting) }))).toBe(
      TravelObservation.Continue,
    );
    expect(travel.active()).toBe(true);

    // And the step still lands normally when its own frame finally arrives.
    travel.observeSelfMoved({ x: 3, y: 2 });
    expect(travel.preview()).toEqual([
      { x: 4, y: 2 },
      { x: 5, y: 2 },
      { x: 6, y: 2 },
    ]);
  });

  it('continues on the first observation, because there is nothing to cross from', () => {
    const travel = createTravel();
    travel.begin({ from: { x: 2, y: 2 }, to: { x: 6, y: 2 }, level: OPEN, stopShort: false });

    // A husk that was already on screen when the player clicked is not news.
    const seen = world({ actors: [husk('m1', 4, 4)] });
    expect(travel.observeTurn(seen)).toBe(TravelObservation.Continue);
    expect(travel.observeTurn(seen)).toBe(TravelObservation.Continue);
    expect(travel.active()).toBe(true);
  });

  it('interrupts when something hostile arrives, and stops the walk', () => {
    const travel = createTravel();
    travel.begin({ from: { x: 2, y: 2 }, to: { x: 6, y: 2 }, level: OPEN, stopShort: false });
    travel.observeTurn(world());

    expect(travel.observeTurn(world({ actors: [husk('m1', 4, 4)] }))).toBe(
      TravelObservation.Hostile,
    );
    expect(travel.active()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// hostileAlert — the visibility PROXY
// ---------------------------------------------------------------------------

describe('hostileAlert', () => {
  const self: TileXY = { x: 5, y: 5 };
  /**
   * A LARGE OPEN FIELD, because the rule is `canSee` now and `canSee` needs a
   * map. Open so that only DISTANCE decides these cases; the wall case gets its
   * own fixture below, where the wall is the thing under test.
   */
  const FIELD: LevelView = { w: 40, h: 40, tiles: new Array<number>(40 * 40).fill(TileCode.FLOOR) };
  const sense = (
    inCombat: boolean,
    actors: readonly ActorView[],
    at: TileXY = self,
    level: LevelView = FIELD,
  ): HostileSense => ({ inCombat, actors, self: at, level });

  it('is quiet on a steady state', () => {
    const near = sense(true, [husk('m1', 7, 7)]);
    expect(hostileAlert(near, near)).toBe(false);
  });

  it('fires when inCombat crosses false -> true', () => {
    // `anyContact` arms the engagement clock the moment a monster has line of
    // sight and is inside its own aggro range.
    expect(hostileAlert(sense(false, []), sense(true, []))).toBe(true);
  });

  it('fires when a live hostile enters the radius', () => {
    const before = sense(false, [husk('m1', 29, 29)]);
    const after = sense(false, [husk('m1', 7, 7)]);
    expect(hostileAlert(before, after)).toBe(true);
  });

  /**
   * THE ARM THAT USED NOT TO EXIST AT ALL, and the gap it left.
   *
   * A husk that never moves is added to `before` on the same observation it
   * would have fired on, so long as both ends are measured from the CURRENT
   * tile — and the `inCombat` arm cannot cover it, because engagement is
   * LEVEL-WIDE: with two allies fighting in another room `inCombat` has been
   * true for turns and there is no crossing left to detect. Travel walked
   * straight past.
   */
  it('fires when the TRAVELLER closes on a hostile that never moved, mid-fight', () => {
    const stationary = [husk('m1', 20, 5)];
    // 15 tiles away, then 7 — the husk has not moved a square, and `inCombat`
    // was already true at both ends.
    const before = sense(true, stationary, { x: 5, y: 5 });
    const after = sense(true, stationary, { x: 13, y: 5 });
    expect(hostileAlert(before, after)).toBe(true);
  });

  it('stays quiet while the traveller walks with a hostile already in range', () => {
    // The other half of the same rule: something inside the radius on BOTH
    // observations is not news, however far the traveller moved. A walk that
    // stopped every turn beside a husk it had already been told about is a walk
    // nobody uses.
    const stationary = [husk('m1', 10, 5)];
    const before = sense(true, stationary, { x: 5, y: 5 });
    const after = sense(true, stationary, { x: 6, y: 5 });
    expect(hostileAlert(before, after)).toBe(false);
  });

  it('fires for a hostile at NINE tiles, which the old radius of 8 missed', () => {
    /**
     * The gap the constant left. `TRAVEL_ALERT_RADIUS` was 8 and answered "how
     * far can something notice ME"; the question travel asks is "what have I
     * just noticed", which upstream bounds by SIGHT (Player.lua:854). A husk
     * that walked into view at nine tiles down a corridor used to be watched in
     * silence while the walk carried on toward it.
     */
    const before = sense(false, [husk('m1', 30, 5)]);
    const after = sense(false, [husk('m1', 14, 5)]);
    expect(hostileAlert(before, after)).toBe(true);
  });

  it('stays quiet for one that is close but behind a wall', () => {
    /**
     * And the half a radius could never express at all: chebyshev has no idea
     * what a wall is. Two tiles away through solid rock is not a sighting, and
     * a walk that stopped for it would stop in every corridor in the game.
     */
    const walled = mapOf(['##########', '#....#...#', '#....#...#', '#....#...#', '##########']);
    const at: TileXY = { x: 3, y: 2 };
    const before = sense(false, [], at, walled);
    const after = sense(false, [husk('m1', 7, 2)], at, walled);
    expect(hostileAlert(before, after)).toBe(false);
    // ...and the control: the SAME distance with no wall between does fire.
    const open2 = sense(false, [husk('m1', 7, 2)], at, FIELD);
    expect(hostileAlert(sense(false, [], at, FIELD), open2)).toBe(true);
  });

  it('ignores a corpse entering sight', () => {
    const after = sense(false, [husk('m1', 6, 6, false)]);
    expect(hostileAlert(sense(false, []), after)).toBe(false);
  });

  it('ignores a player entering the radius', () => {
    const after = sense(false, [detective('p2', 6, 6)]);
    expect(hostileAlert(sense(false, []), after)).toBe(false);
  });
});

describe('a walk that crosses something worth stopping for', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * TRAVEL WALKED STRAIGHT OVER LOOT.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * The route is a path to a tile and everything between it was scenery, so a
   * player who clicked across a room walked over a coat and learned nothing
   * about it. Upstream's `runCheck` (Player.lua:1126-1196) halts on an unseen
   * object — and on a `notice` grid, a store entrance and a talkable NPC, none
   * of which this game has on the floor.
   */
  it('reports the tile it stopped on rather than walking on', () => {
    const travel = createTravel();
    travel.begin({ from: { x: 2, y: 2 }, to: { x: 5, y: 2 }, level: OPEN, stopShort: false });
    travel.nextStep(world());

    expect(travel.observeSelfMoved({ x: 3, y: 2 }, true)).toBe(TravelObservation.Notable);
  });

  it('says nothing when the tile is bare, which is nearly every tile', () => {
    const travel = createTravel();
    travel.begin({ from: { x: 2, y: 2 }, to: { x: 5, y: 2 }, level: OPEN, stopShort: false });
    travel.nextStep(world());

    expect(travel.observeSelfMoved({ x: 3, y: 2 })).toBe(TravelObservation.Continue);
    expect(travel.active(), 'a bare tile must not end the walk').toBe(true);
  });

  it('does NOT report arrival as an interruption', () => {
    /**
     * AUTO-EXPLORE AIMS AT ITEM TILES, so arriving on one is the plan working.
     * Reporting it would put a "travel stopped" notice on top of a walk that
     * finished — and the check sits after the arrival branch for exactly that.
     */
    const travel = createTravel();
    travel.begin({ from: { x: 2, y: 2 }, to: { x: 3, y: 2 }, level: OPEN, stopShort: false });
    travel.nextStep(world());

    expect(travel.observeSelfMoved({ x: 3, y: 2 }, true)).toBe(TravelObservation.Continue);
    expect(travel.active(), 'it arrived, so the walk is over either way').toBe(false);
  });

  it('still cancels for a move nobody asked for, loot or no loot', () => {
    // The shove case outranks it: the rest of the route is a plan from a tile we
    // are not standing on, and what is underfoot there is beside the point.
    const travel = createTravel();
    travel.begin({ from: { x: 2, y: 2 }, to: { x: 5, y: 2 }, level: OPEN, stopShort: false });
    travel.nextStep(world());

    expect(travel.observeSelfMoved({ x: 2, y: 3 }, true)).toBe(TravelObservation.Continue);
    expect(travel.active()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// takeHalt() — the four stops that used to say nothing
// ---------------------------------------------------------------------------

describe('travel.takeHalt', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * A WALK THAT STOPS WITHOUT A SENTENCE IS A DROPPED INPUT.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Four conditions cancelled the walk and returned `null`, main.ts's driver
   * returned on `null`, and the route line vanished with nothing said. The
   * cancels were right — the reasoning is beside each one — but none of them
   * ever argued for the silence, and main.ts's own header calls a refusal that
   * never reaches the player the worst failure mode in a turn-based game.
   */
  function walking() {
    const travel = createTravel();
    travel.begin({ from: { x: 2, y: 2 }, to: { x: 6, y: 2 }, level: OPEN, stopShort: false });
    return travel;
  }

  it('says nothing while the walk is going fine', () => {
    const travel = walking();
    expect(travel.nextStep(world())).toEqual({ dir: 'e' });
    expect(travel.takeHalt()).toBeNull();
  });

  it('reports a route tile that stopped being walkable', () => {
    const travel = walking();
    const shut = mapOf(['##########', '#........#', '#..#.....#', '#........#', '##########']);
    // The wall is at (3,2), one east of the traveller.
    expect(travel.nextStep(world({ level: shut }))).toBeNull();
    expect(travel.takeHalt()).toBe(TravelHalt.Blocked);
  });

  it('reports a body standing on the next route tile', () => {
    const travel = walking();
    expect(travel.nextStep(world({ actors: [husk('m1', 3, 2)] }))).toBeNull();
    expect(travel.takeHalt()).toBe(TravelHalt.Occupied);
  });

  it('reports being somewhere the route does not expect', () => {
    // Shoved, teleported or resynced: the route is about somebody else's
    // position now, and re-routing them somewhere they did not ask for is the
    // one thing a travel system must never do.
    const travel = walking();
    expect(travel.nextStep(world({ self: { x: 8, y: 6 } }))).toBeNull();
    expect(travel.takeHalt()).toBe(TravelHalt.Displaced);
  });

  it('reports a move to a tile it never asked for', () => {
    const travel = walking();
    expect(travel.nextStep(world())).toEqual({ dir: 'e' });
    travel.observeSelfMoved({ x: 2, y: 5 });
    expect(travel.takeHalt()).toBe(TravelHalt.Unexpected);
  });

  it('gives the reason ONCE, so a polling driver cannot repeat it', () => {
    // Read-and-clear: the reason describes a TRANSITION. A sticky field would
    // re-announce the same stop on every tick after it.
    const travel = walking();
    travel.nextStep(world({ actors: [husk('m1', 3, 2)] }));
    expect(travel.takeHalt()).toBe(TravelHalt.Occupied);
    expect(travel.takeHalt()).toBeNull();
  });

  it('does not carry a stale reason into the next walk', () => {
    const travel = walking();
    travel.nextStep(world({ actors: [husk('m1', 3, 2)] }));
    travel.begin({ from: { x: 2, y: 2 }, to: { x: 5, y: 2 }, level: OPEN, stopShort: false });
    expect(travel.takeHalt(), 'a new walk owes no explanation for the last one').toBeNull();
  });

  it('stays quiet when MAIN cancels, because main has already said why', () => {
    /**
     * `cancel` is the public verb and main.ts calls it for reasons it has
     * already phrased ("you were hit — travel stopped"). A halt queued here
     * would make the driver announce the same stop again, one frame later, in
     * different words.
     */
    const travel = walking();
    travel.cancel();
    expect(travel.takeHalt()).toBeNull();
  });
});
