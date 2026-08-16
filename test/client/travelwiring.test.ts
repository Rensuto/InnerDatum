import { describe, expect, it } from 'vitest';

import {
  TRAVEL_ALERT_RADIUS,
  TravelObservation,
  TravelStart,
  createTravel,
  hostileAlert,
} from '../../src/client/input/travel.ts';
import {
  ActorKind,
  ActorRank,
  TileCode,
  TurnActorKind,
  TurnActorState,
} from '../../src/shared/protocol.ts';
import { PROTOCOL_VERSION } from '../../src/shared/version.ts';
import type { Travel, TravelWorld } from '../../src/client/input/travel.ts';
import type { ActorView, LevelView, TurnMsg } from '../../src/shared/protocol.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE INTERRUPT TABLE — src/client/main.ts's WIRING CONTRACT, ONE TEST EACH
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ═══ WHY THIS FILE EXISTS AT ALL ═══
 * main.ts CANNOT BE IMPORTED. It calls `boot()` at module load, which reaches
 * for `document.getElementById`, the Discord SDK and a WebSocket — and
 * vitest.config.ts is emphatic that the environment is `node` with deliberately
 * no jsdom and no mocked SDK ("mocking the SDK would test the mock"). So there
 * is no way to assert anything about that file directly, and the only part of it
 * that is testable at all is the CONTRACT it holds with the pure modules it
 * drives: the exact sequence of observations it feeds the travel machine, and
 * what the machine is required to do with each one.
 *
 * That is what is below. Every test drives `createTravel()` through the same
 * calls main.ts makes, in the same order, for one of the eleven interrupts in
 * decision (b) — and asserts the two things that actually matter afterwards:
 * `active()` is false, and NO FURTHER STEP IS EVER PRODUCED. The second half is
 * the one that would let a bug through: a machine that reported itself idle but
 * still answered `nextStep` would put a `move` on the wire for a walk the player
 * cancelled, and it would do so exactly once, several turns later.
 *
 * ═══ THE LINE THIS FILE DOES NOT CROSS ═══
 * ANY RULE THAT CANNOT BE ASSERTED HERE BELONGS IN src/client/input/, NOT IN
 * main.ts. If a change to the mouse layer needs a decision that this file cannot
 * reach — because it lives in an event handler, a closure inside boot(), or a
 * renderer call — that is the signal to move the decision into a pure module and
 * test it there (input/travel.ts, input/mouseintent.ts, ui/verbs.ts all exist
 * for exactly that reason). main.ts is allowed to be wiring and nothing else.
 *
 * Nothing here modifies input/travel.ts, and nothing here re-implements it: the
 * machine is imported and driven. Where a call site in main.ts is named in a
 * comment it is named with the frame or the event that reaches it, so that a
 * later reader can find the wire from either end.
 */

// ---------------------------------------------------------------------------
// Fixtures. Deliberately the same shapes test/client/travel.test.ts uses — the
// two files ask different questions of one machine, and a second vocabulary for
// "a husk at 4,4" would make them impossible to read together.
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

/** A walled 10x8 field. Everything inside the border is floor. */
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

/** The same field with (3,2) walled — the very next tile of the walk below. */
const SHUT = mapOf([
  '##########',
  '#........#',
  '#..#.....#',
  '#........#',
  '#........#',
  '#........#',
  '#........#',
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

/** A `turn` frame carrying one self card, hand-built for the same reason travel.test.ts hand-builds one. */
function turnFrame(inCombat: boolean, state: TurnActorState, gameTurn = 12): TurnMsg {
  return {
    v: PROTOCOL_VERSION,
    t: 'turn',
    gameTurn,
    engagement: inCombat ? 4 : 0,
    inCombat,
    actors: [
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

/** A walk east from (2,2) to (6,2) with its first step already sent. */
function walking(): Travel {
  const travel = createTravel();
  expect(
    travel.begin({ from: { x: 2, y: 2 }, to: { x: 6, y: 2 }, level: OPEN, stopShort: false }),
  ).toBe(TravelStart.Started);
  return travel;
}

/**
 * THE ASSERTION EVERY INTERRUPT SHARES.
 *
 * Not just "it stopped" but "it stays stopped, whatever it is shown next". A
 * cancelled machine is asked for a step from three different worlds — where it
 * stands, one tile along, and after a fresh turn edge — because the failure this
 * guards against is a stale step escaping several frames later, long after the
 * player has forgotten they clicked.
 */
function expectStoppedForGood(travel: Travel): void {
  expect(travel.active()).toBe(false);
  expect(travel.preview()).toEqual([]);
  expect(travel.destination()).toBeNull();
  expect(travel.nextStep(world())).toBeNull();
  expect(travel.nextStep(world({ self: { x: 3, y: 2 } }))).toBeNull();
  travel.observeSelfMoved({ x: 3, y: 2 });
  expect(travel.observeTurn(world({ turn: turnFrame(false, TurnActorState.Committed) }))).toBe(
    TravelObservation.Continue,
  );
  expect(travel.nextStep(world())).toBeNull();
}

// ---------------------------------------------------------------------------
// AUTO-COMMIT. One step per turn, and never two.
// ---------------------------------------------------------------------------

describe('the tick main.ts runs on every applied frame', () => {
  it('produces one step, then the next only after the moved frame confirms it', () => {
    const travel = walking();

    // main.ts: `tickTravel` in onMessage — ONE `{t:'move',dir}` and never a
    // following `commit` (barrier.ts:293-305 is commit-on-submit, so a commit
    // would find pendingIntent null at turn-engine.ts:1008, queue a HOLD and
    // burn the next turn).
    expect(travel.nextStep(world())).toEqual({ dir: 'e' });
    // The same frame batch asked again — nothing has confirmed the first step.
    expect(travel.nextStep(world())).toBeNull();

    // main.ts: `case 'moved'` when msg.id === selfId.
    travel.observeSelfMoved({ x: 3, y: 2 });

    expect(travel.nextStep(world({ self: { x: 3, y: 2 } }))).toEqual({ dir: 'e' });
    expect(travel.active()).toBe(true);
  });

  it('never puts two steps in one game turn, however the frames are ordered', () => {
    const travel = walking();
    const turnT = turnFrame(false, TurnActorState.Committed, 40);

    // main.ts: `tickTravel` in onMessage — ONE `{t:'move',dir}`.
    expect(travel.nextStep(world({ turn: turnT }))).toEqual({ dir: 'e' });

    // THE ORDER THE GATEWAY ACTUALLY BROADCASTS IN. `pumpAndBroadcast` fans out
    // the player lane first and calls `broadcastTurnIfChanged` last, so main.ts
    // ticks once on the `moved` — with `awaitingStep` cleared and a turn
    // snapshot that still says turn 40. Without gate (iii) both halves of the
    // old gate open here and a second move goes out inside one game turn.
    travel.observeSelfMoved({ x: 3, y: 2 });
    expect(travel.nextStep(world({ self: { x: 3, y: 2 }, turn: turnT }))).toBeNull();

    // ...and the real turn frame, one message later, is what releases it.
    expect(
      travel.observeTurn(
        world({ self: { x: 3, y: 2 }, turn: turnFrame(false, TurnActorState.Committed, 41) }),
      ),
    ).toBe(TravelObservation.Continue);
    expect(
      travel.nextStep(
        world({ self: { x: 3, y: 2 }, turn: turnFrame(false, TurnActorState.Committed, 41) }),
      ),
    ).toEqual({ dir: 'e' });
  });

  it('survives a turn frame that belongs to somebody else', () => {
    const travel = walking();
    expect(travel.nextStep(world({ turn: turnFrame(true, TurnActorState.Waiting, 40) }))).toEqual({
      dir: 'e',
    });

    // ═══ THE REGRESSION THIS TEST EXISTS FOR ═══
    // `turn` frames go out whenever ANY term of `turnKey` moves — an ally
    // committing, an ally's pump advancing the clock, engagement changing, the
    // Bell arming — and frames are ordered per socket, so one lands routinely
    // between a traveller's `move` going out and their own `moved` coming back.
    // Reading that as "the move was silently refused" killed the walk on its
    // first step, more often the more people were playing, and printed a
    // sentence ("the way was refused") that was simply false.
    expect(travel.observeTurn(world({ turn: turnFrame(true, TurnActorState.Committed, 41) }))).toBe(
      TravelObservation.Continue,
    );
    expect(travel.active()).toBe(true);

    // The step lands late and the walk carries on exactly as planned.
    travel.observeSelfMoved({ x: 3, y: 2 });
    expect(travel.preview()).toEqual([
      { x: 4, y: 2 },
      { x: 5, y: 2 },
      { x: 6, y: 2 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// INTERRUPTS 1-7 — the ones main.ts owns. All of them are `cancel()`, which is
// idempotent precisely so seven careless call sites can share it.
// ---------------------------------------------------------------------------

describe('the seven interrupts main.ts cancels for', () => {
  /**
   * The shared body: walk, send a step, then have main.ts cancel.
   *
   * Every one of these is the SAME call — the point of the table is that all
   * seven reach it, from seven places, and that none of them leaves the machine
   * able to produce another step. `cancelledAfterAStep` also proves the cancel
   * survives a step being in flight, which is the state a walk spends most of
   * its life in and the one where a leaked `moved` could revive it.
   */
  function cancelledAfterAStep(): Travel {
    const travel = walking();
    expect(travel.nextStep(world())).toEqual({ dir: 'e' });
    travel.cancel();
    return travel;
  }

  it('(1) a mousedown anywhere on the canvas', () => {
    // main.ts: the FIRST line of the mousedown handler, above the token-menu
    // branch, so a click later swallowed by a panel still stops the walk.
    expectStoppedForGood(cancelledAfterAStep());
  });

  it('(2) any keydown reaching the window', () => {
    // main.ts: a dedicated window listener beside `bindGameKeys`, NOT a
    // `KeyHandlers` member — keys.ts:348-351 drops unmapped keys and :297 drops
    // everything while a text entry is focused, so q/w/e/Tab/F1 would otherwise
    // never reach a cancel.
    expectStoppedForGood(cancelledAfterAStep());
  });

  it('(3) Escape, from inside the ordered cancel chain', () => {
    // main.ts: `if (cancelTravelIfActive()) return;` after the token menu and
    // BEFORE targeting, because one press backs out of exactly one thing.
    expectStoppedForGood(cancelledAfterAStep());
  });

  it('(4) an error frame — including the one that carries a refunded move', () => {
    // main.ts: `case 'error'`, beside `targeting?.cancel()`.
    //
    // THIS IS ALSO HOW A SILENT REFUSAL IS HEARD ABOUT NOW. A move accepted by
    // `submitMove` and refused at RESOLUTION spends no energy, so no clock
    // advances, `turnKey` is byte-identical and `broadcastTurnIfChanged` sends
    // nothing at all — there is no `moved`, no `turn` and, before this, no
    // `error` either. The gateway unicasts the refund (`PumpResult.refusals`),
    // and it arrives here, as the one frame actually correlated with the
    // viewer's own action.
    expectStoppedForGood(cancelledAfterAStep());
  });

  it('(5) the viewer took damage', () => {
    // main.ts: `applyTurnEvent` case 'damage' when event.id === selfId. That one
    // function reads BOTH lanes — the immediate `damaged` frame and the batched
    // sweep — which is why the hook is there and not in applyServerMessage.
    expectStoppedForGood(cancelledAfterAStep());
  });

  it('(6) the viewer went down', () => {
    // main.ts: `applyTurnEvent` case 'downed' when event.id === selfId.
    expectStoppedForGood(cancelledAfterAStep());
  });

  it('(7) welcome or state replaced the board', () => {
    // main.ts: both cases in applyServerMessage. The route was a plan across a
    // map that no longer exists.
    expectStoppedForGood(cancelledAfterAStep());
  });

  it('cancels the same way when no step is in flight, and says nothing about it', () => {
    // The idempotence the seven call sites depend on: `case 'error'` fires for
    // refusals that have nothing to do with a walk, and main.ts must be able to
    // call this without checking anything first.
    const travel = createTravel();
    travel.cancel();
    travel.cancel();
    expectStoppedForGood(travel);
  });
});

// ---------------------------------------------------------------------------
// INTERRUPTS 8-10 — inside the machine. main.ts feeds them and reads the answer.
// ---------------------------------------------------------------------------

describe('the three interrupts the machine detects for itself', () => {
  it('(8) a hostile becomes newly visible, and the exported predicate agrees', () => {
    const travel = walking();
    const self = { x: 2, y: 2 };

    // The FIRST observation can never alert — there is nothing to cross from,
    // and a husk already on screen when the player clicked is not news.
    expect(travel.observeTurn(world())).toBe(TravelObservation.Continue);

    const arrived = [husk('m1', 5, 4)];
    // The same question main.ts's machine asks internally, asked here directly:
    // the wiring contract is that the two cannot disagree, because there is only
    // one implementation and this is it.
    expect(
      hostileAlert(
        { inCombat: false, actors: [], self },
        { inCombat: false, actors: arrived, self },
        TRAVEL_ALERT_RADIUS,
      ),
    ).toBe(true);
    expect(travel.observeTurn(world({ actors: arrived }))).toBe(TravelObservation.Hostile);

    expectStoppedForGood(travel);
  });

  it('(8) and it is not a corpse or an ally that stops the walk', () => {
    const travel = walking();
    expect(travel.observeTurn(world())).toBe(TravelObservation.Continue);

    // A dead husk and a friend arriving inside the radius are both non-events.
    // The walk that stops for every moving thing is a walk nobody uses.
    const harmless = [husk('m1', 4, 3, false), detective('p2', 3, 3)];
    expect(travel.observeTurn(world({ actors: harmless }))).toBe(TravelObservation.Continue);
    expect(travel.active()).toBe(true);
  });

  it('(9) the route stopped being walkable, and no step is offered for it', () => {
    // NO CALL SITE IN main.ts AT ALL, and that is the point of listing it here:
    // the check is inside `nextStep`, so the wiring is simply "ask every frame
    // and send what comes back". A door that shut mid-walk cancels rather than
    // re-routing — the plan the player agreed to no longer exists, and walking
    // them somewhere they did not ask for is the one thing travel must not do.
    const travel = walking();
    expect(travel.nextStep(world({ level: SHUT }))).toBeNull();
    expectStoppedForGood(travel);
  });

  it('(9) a live body parked on the next tile stops it too, and a corpse does not', () => {
    const blocked = walking();
    expect(blocked.nextStep(world({ actors: [husk('m1', 3, 2)] }))).toBeNull();
    expect(blocked.active()).toBe(false);

    const overACorpse = walking();
    expect(overACorpse.nextStep(world({ actors: [husk('m2', 3, 2, false)] }))).toEqual({
      dir: 'e',
    });
  });

  it('(10) a move that landed somewhere else ends the walk', () => {
    // A shove, a Fog Step, or a resync. main.ts feeds `observeSelfMoved` from
    // BOTH lanes — `case 'moved'` and the sweep's `case 'move'` — so a self move
    // that arrives inside a batch is observed too.
    const travel = walking();
    expect(travel.nextStep(world())).toEqual({ dir: 'e' });

    travel.observeSelfMoved({ x: 2, y: 3 });

    expectStoppedForGood(travel);
  });
});

// ---------------------------------------------------------------------------
// (11) ARRIVAL — a normal end, and the only one that is not an interrupt.
// ---------------------------------------------------------------------------

describe('arrival', () => {
  it('ends the walk by itself, so the preview clears with nothing to reset', () => {
    // main.ts polls `active()` and passes `preview()`/`destination()` into the
    // scene unconditionally every frame. There is no arrival callback and there
    // must not be one: the accessors emptying IS the notification.
    const travel = createTravel();
    expect(
      travel.begin({ from: { x: 2, y: 2 }, to: { x: 4, y: 2 }, level: OPEN, stopShort: false }),
    ).toBe(TravelStart.Started);

    expect(travel.nextStep(world())).toEqual({ dir: 'e' });
    travel.observeSelfMoved({ x: 3, y: 2 });
    expect(travel.active()).toBe(true);

    expect(travel.nextStep(world({ self: { x: 3, y: 2 } }))).toEqual({ dir: 'e' });
    travel.observeSelfMoved({ x: 4, y: 2 });

    expectStoppedForGood(travel);
  });
});
