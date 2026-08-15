import { describe, expect, it } from 'vitest';

import {
  HOLD_INTENT,
  StandingOrder,
  createPlayerActor,
  spendTurn,
} from '../../src/server/engine/actor.ts';
import {
  BELL_MS,
  RECONNECT_GRACE_MS,
  STANDING_BY_AFTER_AUTO_PASSES,
  bellDurationMs,
  createBarrier,
  inQuorum,
  isBlocking,
  surveyQuorum,
} from '../../src/server/engine/barrier.ts';
import { createWorld } from '../../src/server/world/world.ts';
import { ActResult, createTurnClock, tickLevel } from '../../src/shared/energy.ts';
import type { PlayerActor } from '../../src/server/engine/actor.ts';
import type { BarrierLevel } from '../../src/server/engine/barrier.ts';
import type { TickLevelResult, TurnClock } from '../../src/shared/energy.ts';

/**
 * The Warrant Clock — docs/game-design.md § 4.
 *
 * The hardest problem in co-op turn-based, and the one most likely to make the
 * game unfun. Everything here — combat, exploration, AFK, a laptop lid closing
 * mid-fight — falls out of one side-effect-free predicate plus a countdown.
 *
 * THE PROPERTY THIS FILE EXISTS TO DEFEND is that the barrier parks ONCE PER
 * TURN AT FULL QUORUM. That is what DECISIONS.md § D1 bought by pinning player
 * energy cost to exactly ENERGY_TO_ACT: a phase-locked party crosses the
 * threshold together, so there is one park per turn with everybody in it, which
 * is the one condition the Bell was designed around. Let players buy cheaper
 * actions and the party lands on 667 / 0 / 0 / 333 energy and never re-aligns —
 * the scheduler then parks six times across ten ticks at quorum sizes 1, 2, 3,
 * 2, 1, 3, and the solo-Bell exemption written for the last survivor starts
 * firing while three people sit frozen watching one person think.
 *
 * TIME IS A PARAMETER, NEVER A CLOCK. Nothing in barrier.ts calls `Date.now`
 * (ESLint forbids it) and `setTimeout` does not exist in that block at all, so
 * the entire Bell — including the ten-minute reconnect grace — is exercised
 * below by calling the same function twice with two numbers.
 */

/** Engagement above zero: the barrier is armed and every player owes a decision. */
const IN_COMBAT: BarrierLevel = { engagement: 3, bossFloor: false };
const BOSS_FLOOR: BarrierLevel = { engagement: 3, bossFloor: true };
/** At zero nobody ever blocks, so there is nobody to ring a bell at. */
const OUT_OF_COMBAT: BarrierLevel = { engagement: 0, bossFloor: false };

/**
 * A real `PlayerActor`, not a stand-in. It is simultaneously a valid
 * `BarrierActor` and a valid `EnergyActor`, which is the whole point of there
 * being one actor type in the process — the barrier and the tick loop are
 * looking at the same bytes the world holds.
 */
function seat(id: string): PlayerActor {
  return createPlayerActor(id, { name: id, sprite: 'chr_player_watchman_s', x: 0, y: 0 });
}

function party(size: number): PlayerActor[] {
  return Array.from({ length: size }, (_unused, index) => seat(`p${index + 1}`));
}

/** Everybody holding a full turn's energy: the moment the barrier is consulted. */
function atThreshold(size: number): PlayerActor[] {
  const seats = party(size);
  for (const actor of seats) actor.energy = 1000;
  return seats;
}

// ---------------------------------------------------------------------------
// The barrier predicate
// ---------------------------------------------------------------------------

describe('isBlocking', () => {
  it('blocks every quorum member who has not committed, and only those', () => {
    const [waiting, committed, ordered, spent, downed] = party(5);
    if (
      waiting === undefined ||
      committed === undefined ||
      ordered === undefined ||
      spent === undefined ||
      downed === undefined
    ) {
      throw new Error('test fixture: the party is short');
    }

    for (const actor of [waiting, committed, ordered, downed]) actor.energy = 1000;
    // Commit-on-submit: the mere PRESENCE of an intent is the commitment, even
    // before it resolves. A refund at resolution puts them straight back here.
    committed.pendingIntent = HOLD_INTENT;
    // A standing order supplies the action, so its owner is dragged into
    // lockstep by engagement but never has to click (Player.lua:401-406).
    ordered.standingOrder = StandingOrder.Hold;
    // `spent` has already acted this turn: energy below the threshold.
    spent.energy = 0;
    downed.alive = false;

    expect(isBlocking(waiting, IN_COMBAT)).toBe(true);
    expect(isBlocking(committed, IN_COMBAT)).toBe(false);
    expect(isBlocking(ordered, IN_COMBAT)).toBe(false);
    expect(isBlocking(spent, IN_COMBAT)).toBe(false);
    expect(isBlocking(downed, IN_COMBAT)).toBe(false);

    const survey = surveyQuorum([waiting, committed, ordered, spent, downed], IN_COMBAT);
    expect(survey.blocking).toEqual(['p1']);
    // Four living players in the quorum; the corpse is not counted at all.
    expect(survey.total).toBe(4);
    expect(survey.committed).toBe(3);
  });

  it('never blocks anyone out of combat, however much energy they are holding', () => {
    // Engagement is the only co-op-specific clause in the predicate, and at zero
    // it switches the whole barrier off: the loop runs until every player sits
    // at the threshold where accrual stops, the pump idles, and exploration
    // feels like free grid movement on the same energy engine.
    const seats = atThreshold(4);
    expect(seats.map((actor) => isBlocking(actor, OUT_OF_COMBAT))).toEqual([
      false,
      false,
      false,
      false,
    ]);
    expect(surveyQuorum(seats, OUT_OF_COMBAT).blocking).toEqual([]);
    // ...and the same party in combat blocks to a man.
    expect(surveyQuorum(seats, IN_COMBAT).blocking).toEqual(['p1', 'p2', 'p3', 'p4']);
  });
});

// ---------------------------------------------------------------------------
// ONCE PER TURN, AT FULL QUORUM
// ---------------------------------------------------------------------------

/**
 * The barrier driven by the real tick loop, with the real `isBlocking`.
 *
 * `actsWhileBlocked` is true for players because commit-on-submit resolves
 * immediately: whoever's packet lands first is resolved first, without waiting
 * on the rest of the party. That is what makes arrival order — rather than array
 * order — the thing this test varies.
 */
function driver(seats: readonly PlayerActor[], clock: TurnClock, level: BarrierLevel) {
  const byId = new Map(seats.map((actor) => [actor.id, actor]));
  return (): TickLevelResult =>
    tickLevel(seats, {
      clock,
      actBase: () => {},
      isBlocking: (energyActor) => {
        const actor = byId.get(energyActor.id);
        return actor !== undefined && isBlocking(actor, level);
      },
      actsWhileBlocked: () => true,
      act: (energyActor) => {
        const actor = byId.get(energyActor.id);
        if (actor === undefined || actor.pendingIntent === null) return ActResult.Done;
        actor.pendingIntent = null;
        // D1: a player's action costs exactly ENERGY_TO_ACT, always.
        spendTurn(actor);
        return ActResult.Done;
      },
      maxTicks: 500,
    });
}

describe('the barrier parks once per turn at full quorum', () => {
  it('holds the whole party at one park per game turn, whatever order they commit in', () => {
    // Four players, three turns, three different arrival orders. The claim under
    // test is that arrival order changes WHO is left blocking mid-turn and
    // nothing else: every turn still opens with one park containing all four,
    // and exactly one pump per turn advances the clock — by exactly ten ticks.
    const seats = party(4);
    const ids = seats.map((actor) => actor.id);
    const clock = createTurnClock();
    const pump = driver(seats, clock, IN_COMBAT);
    const byId = new Map(seats.map((actor) => [actor.id, actor]));

    // Turn one's park: everybody crosses the threshold on the same tick.
    let park = pump();
    expect(park.status).toBe('parked');
    expect(park.parked).toEqual(ids);
    expect(park.ticks).toBe(10);
    expect(clock.gameTurn).toBe(1);

    const arrivalOrders = [
      ['p1', 'p2', 'p3', 'p4'],
      ['p4', 'p3', 'p2', 'p1'],
      ['p2', 'p4', 'p1', 'p3'],
    ];

    for (const order of arrivalOrders) {
      const turnBefore = clock.gameTurn;
      const ticksPerCommit: number[] = [];
      const committed = new Set<string>();

      for (const id of order) {
        const actor = byId.get(id);
        if (actor === undefined) throw new Error(`test fixture: no seat ${id}`);
        actor.pendingIntent = HOLD_INTENT;
        committed.add(id);
        park = pump();
        ticksPerCommit.push(park.ticks);

        // Mid-turn the blocking set is exactly "everybody who has not committed
        // yet", in array order — arrival order decides WHO is left, and nothing
        // else. Once the last one lands, the very next park is the NEXT turn's,
        // at full quorum again.
        expect(park.parked).toEqual(
          committed.size === ids.length ? ids : ids.filter((seatId) => !committed.has(seatId)),
        );
        expect(park.status).toBe('parked');
      }

      // The clock does not move until the last commit lands, and then it moves
      // by exactly one game turn. ONE park per turn, not four.
      expect(ticksPerCommit).toEqual([0, 0, 0, 10]);
      expect(clock.gameTurn).toBe(turnBefore + 1);
      expect(park.parked).toEqual(ids);
    }

    expect(clock.tick).toBe(40);
    expect(clock.gameTurn).toBe(4);
  });

  it('keeps a party of one on the same one-park-per-turn rhythm', () => {
    // The degenerate case, checked because it is the one the Bell treats
    // specially and therefore the one most likely to drift.
    const seats = party(1);
    const clock = createTurnClock();
    const pump = driver(seats, clock, IN_COMBAT);

    for (let turn = 1; turn <= 3; turn += 1) {
      const park = pump();
      expect(park.parked).toEqual(['p1']);
      expect(clock.gameTurn).toBe(turn);
      const solo = seats[0];
      if (solo === undefined) throw new Error('test fixture: the party is empty');
      solo.pendingIntent = HOLD_INTENT;
    }
    expect(clock.tick).toBe(30);
  });
});

// ---------------------------------------------------------------------------
// The Bell
// ---------------------------------------------------------------------------

describe('the Bell start condition', () => {
  it('does not start until committed >= quorum - 1', () => {
    // NO TIMER AT ALL until everybody but the last straggler has committed.
    // Starting one earlier is pressure with nothing to do about it: a clock on
    // somebody while two other people are still thinking.
    for (const committed of [0, 1, 2, 3, 4]) {
      const seats = atThreshold(4);
      for (let i = 0; i < committed; i += 1) {
        const actor = seats[i];
        if (actor === undefined) throw new Error('test fixture: the party is short');
        actor.pendingIntent = HOLD_INTENT;
      }

      const barrier = createBarrier();
      const state = barrier.bell(seats, IN_COMBAT, 0);

      expect({ committed, running: state.running }).toEqual({
        committed,
        // Runs only at committed === 3: quorum - 1 with somebody still blocking.
        running: committed === 3,
      });
      expect(state.quorum).toBe(4);
      expect(state.committed).toBe(committed);
    }
  });

  it('rings for the last straggler only, and does not restart while it is running', () => {
    const seats = atThreshold(3);
    const [first, second, straggler] = seats;
    if (first === undefined || second === undefined || straggler === undefined) {
      throw new Error('test fixture: the party is short');
    }
    const barrier = createBarrier();

    first.pendingIntent = HOLD_INTENT;
    expect(barrier.bell(seats, IN_COMBAT, 1_000).running).toBe(false);

    second.pendingIntent = HOLD_INTENT;
    const started = barrier.bell(seats, IN_COMBAT, 2_000);
    expect(started.running).toBe(true);
    expect(started.stragglers).toEqual([straggler.id]);
    expect(started.deadlineMs).toBe(2_000 + BELL_MS.Normal);

    // Idempotent: asking again later does not hand the straggler a fresh clock.
    const later = barrier.bell(seats, IN_COMBAT, 9_000);
    expect(later.deadlineMs).toBe(2_000 + BELL_MS.Normal);
    expect(later.remainingMs).toBe(BELL_MS.Normal - 7_000);

    // Once they commit, the countdown is gone rather than merely ignored.
    straggler.pendingIntent = HOLD_INTENT;
    const finished = barrier.bell(seats, IN_COMBAT, 9_500);
    expect(finished.running).toBe(false);
    expect(finished.deadlineMs).toBeNull();
    expect(finished.stragglers).toEqual([]);
  });
});

describe('the Bell duration', () => {
  it('is null out of combat, 20s normal, 12s on a boss floor, and 120s at quorum 1', () => {
    expect(bellDurationMs(4, OUT_OF_COMBAT)).toBeNull();
    expect(bellDurationMs(4, IN_COMBAT)).toBe(20_000);
    expect(bellDurationMs(4, BOSS_FLOOR)).toBe(12_000);

    // NEVER PUT A 20-SECOND CLOCK ON THE LAST PERSON STANDING. The Bell exists
    // to stop three people waiting on one; with nobody waiting it has no job,
    // and hurrying somebody through the tensest moment the game has is the
    // opposite of what it is for. Two minutes, and it beats the boss floor's
    // shorter clock rather than being overridden by it.
    expect(bellDurationMs(1, IN_COMBAT)).toBe(120_000);
    expect(bellDurationMs(1, BOSS_FLOOR)).toBe(120_000);
    expect(bellDurationMs(0, IN_COMBAT)).toBe(120_000);

    expect(BELL_MS).toEqual({ Normal: 20_000, Boss: 12_000, Solo: 120_000 });
  });

  it('hands the lone survivor the full two minutes, measured from when they started thinking', () => {
    // A party of one is `committed >= total - 1` the moment they block, so the
    // countdown is armed immediately — with the SOLO duration.
    const seats = atThreshold(1);
    const barrier = createBarrier();

    const state = barrier.bell(seats, IN_COMBAT, 500);
    expect(state.running).toBe(true);
    expect(state.quorum).toBe(1);
    expect(state.durationMs).toBe(BELL_MS.Solo);
    expect(state.deadlineMs).toBe(500 + BELL_MS.Solo);
    expect(barrier.expire(seats, IN_COMBAT, 500 + BELL_MS.Normal)).toEqual([]);
  });

  it('runs the shorter clock on a boss floor', () => {
    const seats = atThreshold(2);
    const [committed] = seats;
    if (committed === undefined) throw new Error('test fixture: the party is short');
    committed.pendingIntent = HOLD_INTENT;

    const barrier = createBarrier();
    const state = barrier.bell(seats, BOSS_FLOOR, 0);
    expect(state.running).toBe(true);
    expect(state.durationMs).toBe(BELL_MS.Boss);
    expect(state.deadlineMs).toBe(BELL_MS.Boss);
  });
});

// ---------------------------------------------------------------------------
// Standing By
// ---------------------------------------------------------------------------

describe('Standing By', () => {
  it('excludes a player from the quorum after two consecutive auto-passes', () => {
    // Two auto-passes and they leave the DENOMINATOR, not just the countdown:
    // from then on they auto-hold immediately with no Bell delay, so the party
    // runs at full speed instead of eating a 20-second pause every single turn
    // for somebody who walked away. This happens in every session that lasts
    // more than an hour.
    expect(STANDING_BY_AFTER_AUTO_PASSES).toBe(2);

    const seats = atThreshold(2);
    const [absent, present] = seats;
    if (absent === undefined || present === undefined) {
      throw new Error('test fixture: the party is short');
    }
    present.pendingIntent = HOLD_INTENT;
    const barrier = createBarrier();

    // The caller reads the deadline, sets a real timer, and re-enters. Nothing
    // below waits on anything.
    expect(barrier.bell(seats, IN_COMBAT, 0).deadlineMs).toBe(BELL_MS.Normal);
    expect(barrier.expire(seats, IN_COMBAT, BELL_MS.Normal - 1)).toEqual([]);

    const first = barrier.expire(seats, IN_COMBAT, BELL_MS.Normal);
    expect(first).toEqual([{ id: absent.id, consecutive: 1, standingBy: false }]);
    expect(absent.standingBy).toBe(false);
    expect(inQuorum(absent)).toBe(true);

    // Second turn, second silence.
    expect(barrier.bell(seats, IN_COMBAT, BELL_MS.Normal).running).toBe(true);
    const second = barrier.expire(seats, IN_COMBAT, 2 * BELL_MS.Normal);
    expect(second).toEqual([{ id: absent.id, consecutive: 2, standingBy: true }]);

    expect(absent.standingBy).toBe(true);
    expect(inQuorum(absent)).toBe(false);
    expect(isBlocking(absent, IN_COMBAT)).toBe(false);

    // The quorum has genuinely shrunk: one active player, reported alongside the
    // reason so the UI can say "1 of 2, one standing by" rather than silently
    // counting down from a smaller number.
    const survey = surveyQuorum(seats, IN_COMBAT);
    expect(survey.total).toBe(1);
    expect(survey.standingBy).toEqual([absent.id]);
    expect(survey.blocking).toEqual([]);

    // ...and the Bell for what remains is the SOLO clock, because there is now
    // nobody waiting on the last player.
    expect(bellDurationMs(survey.total, IN_COMBAT)).toBe(BELL_MS.Solo);
  });

  it('is cleared by any command at all, and the silence count restarts', () => {
    // "Any command clears it" — deliberately not "any command that resolves
    // legally". Someone at the keyboard trying things is present, and presence
    // is the only thing Standing By measures.
    const seats = atThreshold(2);
    const [absent, present] = seats;
    if (absent === undefined || present === undefined) {
      throw new Error('test fixture: the party is short');
    }
    present.pendingIntent = HOLD_INTENT;
    const barrier = createBarrier();

    barrier.bell(seats, IN_COMBAT, 0);
    barrier.expire(seats, IN_COMBAT, BELL_MS.Normal);
    expect(barrier.autoPassesOf(absent.id)).toBe(1);

    barrier.noteCommand(absent);
    expect(barrier.autoPassesOf(absent.id)).toBe(0);
    expect(absent.standingBy).toBe(false);

    // Because the count restarted, the NEXT silence is a first offence again and
    // does not tip them out of the quorum.
    barrier.bell(seats, IN_COMBAT, BELL_MS.Normal);
    const next = barrier.expire(seats, IN_COMBAT, 2 * BELL_MS.Normal);
    expect(next).toEqual([{ id: absent.id, consecutive: 1, standingBy: false }]);
    expect(inQuorum(absent)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Disconnect
// ---------------------------------------------------------------------------

describe('disconnect', () => {
  it('leaves the body in the world and puts it Standing By immediately', () => {
    // It is a MUD: you do not yank somebody out of a fight because their wifi
    // blinked, and a mid-fight recall would be a free escape besides. So the
    // body stays exactly where it stood, keeps its hp, and stays in the actor
    // table — it simply stops being counted and stops blocking.
    const world = createWorld('barrier-disconnect');
    const dropped = world.addPlayer('gone', 'Gone');
    const remaining = world.addPlayer('here', 'Here');
    dropped.energy = 1000;
    remaining.energy = 1000;
    const where = { x: dropped.x, y: dropped.y };
    const barrier = createBarrier();

    expect(surveyQuorum([dropped, remaining], IN_COMBAT).total).toBe(2);

    barrier.disconnect(dropped, 5_000);

    // Still there. Still alive. Still standing on the same tile.
    expect(world.getActor('gone')).toBe(dropped);
    expect(world.allActors()).toHaveLength(2);
    expect({ x: dropped.x, y: dropped.y }).toEqual(where);
    expect(dropped.alive).toBe(true);
    expect(dropped.hp).toBe(dropped.maxHp);

    // ...but out of the quorum, immediately, with no Bell delay — nobody waits
    // on a socket that is gone.
    expect(dropped.connected).toBe(false);
    expect(dropped.standingBy).toBe(true);
    expect(inQuorum(dropped)).toBe(false);
    expect(isBlocking(dropped, IN_COMBAT)).toBe(false);

    const survey = surveyQuorum([dropped, remaining], IN_COMBAT);
    expect(survey.total).toBe(1);
    expect(survey.standingBy).toEqual(['gone']);
    expect(survey.blocking).toEqual(['here']);
  });

  it('holds the ten-minute grace before the body may be recalled', () => {
    // Recall happens at the next safe moment AFTER the grace, never mid-fight.
    expect(RECONNECT_GRACE_MS).toBe(600_000);

    const world = createWorld('barrier-grace');
    const dropped = world.addPlayer('gone', 'Gone');
    const barrier = createBarrier();

    barrier.disconnect(dropped, 1_000);
    expect(barrier.graceExpired(1_000)).toEqual([]);
    expect(barrier.graceExpired(1_000 + RECONNECT_GRACE_MS - 1)).toEqual([]);
    expect(barrier.graceExpired(1_000 + RECONNECT_GRACE_MS)).toEqual(['gone']);

    // Coming back re-seats them and wipes the silence count; the body never
    // moved, so there is nothing to restore.
    barrier.reconnect(dropped);
    expect(dropped.connected).toBe(true);
    expect(dropped.standingBy).toBe(false);
    expect(barrier.autoPassesOf('gone')).toBe(0);
    expect(barrier.graceExpired(1_000 + 2 * RECONNECT_GRACE_MS)).toEqual([]);
    expect(inQuorum(dropped)).toBe(true);
    expect(world.getActor('gone')).toBe(dropped);
  });
});
