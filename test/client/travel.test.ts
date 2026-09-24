import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  nearestSeenHostile,
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
 * and the direction derivation — in the same spirit as test/client/turnbar.test.ts,
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
      // `+` IS A SHUT DOOR, matching `shared/vaults.ts`' LEGEND so one glyph
      // means one thing across every ASCII map in the repo. `'` is an open one —
      // needed because the door tests turn the first into the second by hand,
      // exactly as main.ts's `case 'terrain'` writes into `level.tiles`.
      const ch = row.charAt(x);
      tiles.push(
        ch === '#'
          ? TileCode.WALL
          : ch === '+'
            ? TileCode.DOOR
            : ch === "'"
              ? TileCode.DOOR_OPEN
              : TileCode.FLOOR,
      );
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

/**
 * A room reachable ONLY through the shut door at (5,3).
 *
 * The wall is unbroken apart from that one tile and every corner is sealed, so a
 * router that treats a door as solid answers NoRoute rather than merely taking a
 * longer way round — which is what makes the door the whole difference.
 */
const DOORED = mapOf([
  '##########',
  '#....#...#',
  '#....#...#',
  '#....+...#',
  '#....#...#',
  '#....#...#',
  '#....#...#',
  '##########',
]);

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
 * dragged in for no gain (turnbar.test.ts pays that cost for a different and
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
    // A self card that owes a decision is the one being waited on.
    current: state === TurnActorState.Waiting || state === TurnActorState.Bell ? 'self' : null,
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

  it('fires when a live hostile joins the board', () => {
    // A hostile coming into view ARRIVES on the board: the server builds it from
    // this player's own sight.
    const after = sense(false, [husk('m1', 7, 7)]);
    expect(hostileAlert(sense(false, []), after)).toBe(true);
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
    // The husk has not moved a square and `inCombat` was already true at both
    // ends; walking into sight of it is what put it on the board.
    const before = sense(true, [], { x: 5, y: 5 });
    const after = sense(true, [husk('m1', 20, 5)], { x: 13, y: 5 });
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
     * `TRAVEL_ALERT_RADIUS` was 8 and answered "how far can something notice
     * ME"; the question travel asks is "what have I just noticed", which upstream
     * bounds by SIGHT (Player.lua:849-858). There is no distance in the rule now.
     */
    const after = sense(false, [husk('m1', 14, 5)]);
    expect(hostileAlert(sense(false, []), after)).toBe(true);
  });

  it('trusts the board over its own map: a hostile the server sent is seen, wall or not', () => {
    /**
     * THIS ASSERTED SILENCE, when the client judged sight for itself with
     * `canSee` at the default radius. The server builds the board from this
     * player's own sight, at a radius the client cannot know, so a hostile it
     * sent is one this player can see even where the client's copy of the map
     * shows a wall between them.
     */
    const walled = mapOf(['##########', '#....#...#', '#....#...#', '#....#...#', '##########']);
    const at: TileXY = { x: 3, y: 2 };
    const after = sense(false, [husk('m1', 7, 2)], at, walled);
    expect(hostileAlert(sense(false, [], at, walled), after)).toBe(true);
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

// ---------------------------------------------------------------------------
// nearestSeenHostile — the rule the explore refusal spends
// ---------------------------------------------------------------------------

describe('nearestSeenHostile', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * "ON MY BOARD" STOPPED MEANING "I CAN SEE IT" WHEN FOV LANDED, AND MEANS IT AGAIN.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * When FOV first landed the actor list a client held was the PARTY'S pooled
   * sight, so a husk only a teammate could see was on it, and this helper
   * filtered the board through `canSee` from this body. The server now builds
   * each player's board from that player's own eyes at their own sight radius,
   * which is what upstream's `spotHostiles` walks (Player.lua:849-858). So a
   * hostile on the board is one this player can see, and the rule is membership.
   */
  const me: TileXY = { x: 2, y: 2 };

  it('finds a hostile in the open', () => {
    expect(nearestSeenHostile(OPEN, me, [husk('m1', 5, 2)])?.name).toBe('Index Husk');
  });

  it('gives the offset, so one bearing helper serves rest and explore', () => {
    expect(nearestSeenHostile(OPEN, me, [husk('m1', 5, 4)])).toEqual({
      name: 'Index Husk',
      dx: 3,
      dy: 2,
    });
  });

  it('trusts the board over its own map: a hostile the server sent counts, wall or not', () => {
    // THIS ASSERTED NULL, when the board was the party's pooled sight. The server
    // sends a player only what their own eyes can see, at a radius the client
    // cannot know, so a hostile on the board is a reason this body may not walk
    // even where the client's copy of the map shows a wall between them.
    const walled = mapOf(['#######', '#..#..#', '#..#..#', '#..#..#', '#######']);
    expect(nearestSeenHostile(walled, { x: 2, y: 2 }, [husk('m1', 5, 2)])).toEqual({
      name: 'Index Husk',
      dx: 3,
      dy: 0,
    });
  });

  it('has no distance in the rule: a hostile on the board counts however far off', () => {
    // THIS ASSERTED NULL beyond the default sight radius. A hostile that far away
    // is only on the board because this player can see it.
    const field = mapOf(
      Array.from({ length: 30 }, (_, y) =>
        y === 0 || y === 29 ? '#'.repeat(30) : `#${'.'.repeat(28)}#`,
      ),
    );
    expect(nearestSeenHostile(field, { x: 2, y: 2 }, [husk('m1', 25, 2)])?.dx).toBe(23);
  });

  it('ignores a corpse and ignores a teammate', () => {
    expect(nearestSeenHostile(OPEN, me, [husk('m1', 4, 2, false)])).toBeNull();
    expect(nearestSeenHostile(OPEN, me, [detective('p2', 4, 2)])).toBeNull();
  });

  it('picks the NEAREST of several', () => {
    const near = nearestSeenHostile(OPEN, me, [husk('far', 6, 2), husk('near', 3, 2)]);
    expect(near?.dx).toBe(1);
  });

  it('sees nothing at all before the first board', () => {
    // Refusing to explore is the safe direction on a frame that cannot be
    // reasoned about.
    expect(nearestSeenHostile(null, me, [husk('m1', 3, 2)])).toBeNull();
  });

  it('and main.ts spends it rather than scanning again', () => {
    /**
     * A SOURCE GUARD, on `healing-factor.test.ts`' terms — *"the weakest kind of
     * test, chosen because the alternative is none"*. main.ts's closure is
     * unreachable from `test/`, so a mutation that reverts
     * `nearestVisibleHostile` to its own distance scan passes every runtime
     * assertion in this file: the shared rule stays correct and simply stops
     * being called.
     *
     * That is not hypothetical. The scan it replaced lived beside a docblock
     * admitting it was not line of sight, through two rewrites of that docblock,
     * for two milestones.
     */
    const main = readFileSync(new URL('../../src/client/main.ts', import.meta.url), 'utf8');
    const at = main.indexOf('function nearestVisibleHostile(');
    expect(at, 'nearestVisibleHostile was renamed — this guard is now blind').toBeGreaterThan(-1);
    const body = main.slice(at, main.indexOf('\n}', at));
    expect(
      body.includes('nearestSeenHostile('),
      'nearestVisibleHostile stopped delegating — the sight test is bypassed',
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Doors
// ---------------------------------------------------------------------------

describe('a shut door on the route', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * WALKING INTO A DOOR IS THE ONE ACCEPTED COMMAND THAT MOVES NOBODY.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `scheduler.ts`'s Move case swings the door and returns a refusal carrying
   * `opened`, deliberately suppressing the `refunded` push so the player is not
   * toasted for a success. `Actor.lua:1346` charges a move only when the body
   * changed tile, so it costs nothing and the actor is asked again.
   *
   * FOR THIS MACHINE THAT IS A STEP WITH NO `moved` FRAME BEHIND IT, and every
   * other outcome has one. What the server sends instead is a `terrain` frame,
   * which main.ts applies by writing into `level.tiles` — so the tests below
   * open a door the way the client does, by editing the map.
   */
  const openDoorIn = (level: LevelView, at: TileXY): void => {
    level.tiles[at.y * level.w + at.x] = TileCode.DOOR_OPEN;
  };

  /** A fresh copy, because these tests mutate the map the way a frame does. */
  const doored = (): LevelView => ({ w: DOORED.w, h: DOORED.h, tiles: [...DOORED.tiles] });

  it('routes THROUGH it — the room behind is not unreachable', () => {
    /**
     * THE FIXTURE IS SEALED APART FROM THE DOOR, so a router that treats one as
     * solid does not merely take a longer way round: it answers NoRoute. That
     * was the state of auto-explore on a works floor — the BSP generator hangs a
     * door on about ten of the ways through a building, and every one of them
     * was a wall to this predicate.
     */
    const travel = createTravel();
    const start = travel.begin({
      from: { x: 3, y: 3 },
      to: { x: 7, y: 3 },
      level: DOORED,
      stopShort: false,
    });

    expect(start).toBe(TravelStart.Started);
    expect(travel.preview()).toContainEqual({ x: 5, y: 3 });
  });

  it('steps into it rather than halting Blocked', () => {
    // `canRoute` and not `canWalk`: the stale-route check in `nextStep` is the
    // second place a door reads as a wall, and a route that planned through one
    // would halt on the tile before it every single time.
    const travel = createTravel();
    const level = doored();
    const self = { x: 4, y: 3 };
    travel.begin({ from: self, to: { x: 7, y: 3 }, level, stopShort: false });

    const walk = travel.nextStep(
      world({ self, level, turn: turnFrame(false, TurnActorState.Committed) }),
    );
    expect(walk?.dir).toBe('e');
    expect(travel.takeHalt()).toBeNull();
    expect(travel.active()).toBe(true);
  });

  it('re-issues the SAME step once the door is open, without advancing the route', () => {
    /**
     * ═══ THE STALL THIS EXISTS TO PREVENT ═══
     * `observeSelfMoved` is the only thing that clears `awaitingStep`, and a
     * door-open produces no `moved` frame. Without the release the walk waits
     * forever for a frame that is never coming — route still painted across the
     * map, token never moving, nothing on screen saying why.
     *
     * AND THE ROUTE MUST NOT ADVANCE. The door tile is still the next tile and
     * the body is still one short of it; advancing would send the following step
     * diagonally past the doorway into the wall beside it.
     */
    const travel = createTravel();
    const level = doored();
    const self = { x: 4, y: 3 };
    const turn = turnFrame(false, TurnActorState.Committed);
    travel.begin({ from: self, to: { x: 7, y: 3 }, level, stopShort: false });

    expect(travel.nextStep(world({ self, level, turn }))?.dir).toBe('e');
    // The step is in flight and nothing has changed yet: no second step.
    expect(travel.nextStep(world({ self, level, turn }))).toBeNull();

    openDoorIn(level, { x: 5, y: 3 });

    const again = travel.nextStep(world({ self, level, turn }));
    expect(again?.dir, 'the walk stalled on the door it had just opened').toBe('e');
    // STILL THE SAME TILE. The preview is the proof: `index` did not move.
    expect(travel.preview()[0]).toEqual({ x: 5, y: 3 });
  });

  it('takes that second step in the SAME game turn, because opening cost none', () => {
    /**
     * GATE (iii) IS THE ONE THAT WOULD SWALLOW THIS. It stamps `lastStepTurn`
     * from the server's counter and refuses a second step until the turn moves
     * on — and a door-open moves no turn on, because it spends no energy. Out of
     * combat nothing else would move it either, so the walk would stop dead.
     *
     * SAME `gameTurn` ON BOTH SIDES, which is the whole claim.
     */
    const travel = createTravel();
    const level = doored();
    const self = { x: 4, y: 3 };
    const turn = turnFrame(true, TurnActorState.Waiting, 41);
    travel.begin({ from: self, to: { x: 7, y: 3 }, level, stopShort: false });

    expect(travel.nextStep(world({ self, level, turn }))?.dir).toBe('e');
    openDoorIn(level, { x: 5, y: 3 });
    expect(travel.nextStep(world({ self, level, turn }))?.dir).toBe('e');
  });

  it('but a door step that actually LANDED still latches the turn', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE STALE MAP, AND THE ONLY REASON A DOOR STEP IS STAMPED AT ALL.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * A tile this machine believes is shut may already be open on the server —
     * the `terrain` frame is simply late. Then the move LANDS, a `moved` frame
     * arrives, and the walk took a real step in this game turn. If a door step
     * went out UNSTAMPED on the argument that opening a door costs nothing, a
     * second move would follow it inside one turn, sit in `pendingIntent` and
     * pre-commit the next one: exactly the failure gate (iii) was added for.
     *
     * SO THE STAMP GOES ON EVERY STEP AND ONLY THE RELEASE TAKES IT OFF — which
     * is why the release is triggered by the TERRAIN and never by the move. This
     * drives the move.
     */
    const travel = createTravel();
    const level = doored();
    const turn = turnFrame(true, TurnActorState.Waiting, 41);
    travel.begin({ from: { x: 4, y: 3 }, to: { x: 7, y: 3 }, level, stopShort: false });

    expect(travel.nextStep(world({ self: { x: 4, y: 3 }, level, turn }))?.dir).toBe('e');
    // The server had it open all along and moved us onto it.
    expect(travel.observeSelfMoved({ x: 5, y: 3 })).toBe(TravelObservation.Continue);
    openDoorIn(level, { x: 5, y: 3 });

    expect(
      travel.nextStep(world({ self: { x: 5, y: 3 }, level, turn })),
      'a second move went out inside one game turn',
    ).toBeNull();
  });

  it('does not release a step that was never aimed at a door', () => {
    // The release is gated on the tile having been SHUT when the step went out,
    // and not merely on it being walkable now — otherwise every ordinary step in
    // flight would clear its own gate the instant it was issued, which is gate
    // (i) deleted.
    const travel = createTravel();
    const turn = turnFrame(true, TurnActorState.Waiting);
    travel.begin({ from: { x: 2, y: 2 }, to: { x: 6, y: 2 }, level: OPEN, stopShort: false });

    expect(travel.nextStep(world({ turn }))?.dir).toBe('e');
    expect(travel.nextStep(world({ turn }))).toBeNull();
  });

  it('walks the whole way through and arrives', () => {
    // THE JOIN, driven end to end: plan, open, re-ask, step, continue. Each half
    // above is correct on its own and the walk is what has to work.
    const travel = createTravel();
    const level = doored();
    let self: TileXY = { x: 4, y: 3 };
    let gameTurn = 10;

    travel.begin({ from: self, to: { x: 7, y: 3 }, level, stopShort: false });
    for (let guard = 0; guard < 30 && travel.active(); guard += 1) {
      const walk = travel.nextStep(
        world({ self, level, turn: turnFrame(true, TurnActorState.Waiting, gameTurn) }),
      );
      if (walk === null) break;
      const to = step(self, walk.dir);
      // THE SERVER'S OWN BRANCH: a step into a shut door swings it and moves
      // nobody, and the game turn does not advance because nothing was spent.
      if (level.tiles[to.y * level.w + to.x] === TileCode.DOOR) {
        openDoorIn(level, to);
        continue;
      }
      self = to;
      gameTurn += 1;
      travel.observeSelfMoved(self);
    }

    expect(travel.active(), 'the walk never reached the far room').toBe(false);
    expect(self).toEqual({ x: 7, y: 3 });
    expect(travel.takeHalt()).toBeNull();
  });
});
