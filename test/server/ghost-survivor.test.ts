import { describe, expect, it } from 'vitest';

import { createBarrier } from '../../src/server/engine/barrier.ts';
import {
  DOWNED_TURNS,
  Survival,
  createDownedState,
  downedView,
  goDown,
  isErased,
  survivalOf,
  surveyParty,
} from '../../src/server/engine/downed.ts';
import { pump } from '../../src/server/engine/scheduler.ts';
import { createWorld } from '../../src/server/world/world.ts';
import type { Barrier } from '../../src/server/engine/barrier.ts';
import type { DownedState, PresenceCheck } from '../../src/server/engine/downed.ts';
import type { GameEvent, PumpResult } from '../../src/server/engine/scheduler.ts';
import type { Actor, World } from '../../src/server/world/world.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE GHOST. THE BUG THAT STRANDED A LIVE PLAYER, PINNED.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * REPORTED FROM REAL CO-OP PLAY, and it is the reason this file exists as its
 * own file rather than as four more cases in test/server/downed.test.ts:
 *
 *   *"When I had my friend test, his character is still showing... when the
 *   player dies, we need a respawn method as I was stuck since the other
 *   player's character is there."*
 *
 * A friend closed the activity. Their body stayed standing — M2 keeps it there
 * ON PURPOSE, because a dropped socket must not yank somebody out of a fight —
 * and the wipe predicate asked only `survivalOf`, so that body counted as `Up`.
 * `up.length !== 0`, THE WIPE NEVER FIRED, and the player who had actually gone
 * down went Downed, then Erased, then nothing at all: no floor reset, no rescue,
 * no way back, and not one thing failing anywhere in the process.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT THIS FILE PINS THAT A UNIT TEST OF `surveyParty` CANNOT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The fix is one predicate, but the predicate is a JOIN ACROSS THREE MODULES
 * that no single one of them can check:
 *
 *   engine/barrier.ts   `disconnect` / `reconnect` WRITE `connected` and
 *                       `standingBy` on the body.
 *   engine/scheduler.ts `isPresent` READS exactly those two flags and hands
 *                       `surveyParty` the answer.
 *   engine/downed.ts    `surveyParty` counts `survivors` and the wipe fires.
 *
 * Every test below therefore drives the REAL barrier and the REAL pump. A test
 * that passed its own lambda for presence would keep passing on the day
 * somebody renamed a flag, and the symptom in production is silence: a player
 * sitting on a frozen screen with nothing in the log.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type Table = {
  readonly world: World;
  readonly downed: DownedState;
  readonly barrier: Barrier;
  /** One pump at a given wall clock. The only way anything below advances. */
  readonly advance: (nowMs: number) => PumpResult;
  readonly actor: (id: string) => Actor;
};

/**
 * `players` humans on the spawn cluster, a survival table wired in, and no
 * monsters — the wipe is checked on the way INTO every pump (`enrolCasualties`),
 * so nothing has to hit anybody for these scenarios to play out.
 */
function table(seed: string, players: number): Table {
  const world = createWorld(seed);
  const downed = createDownedState();
  const barrier = createBarrier();

  for (let i = 0; i < players; i += 1) {
    const actor = world.addPlayer(`p${String(i + 1)}`, `Player ${String(i + 1)}`);
    // Placeholder regeneration would quietly heal a ghost between pumps and make
    // "the absent body was not touched" measure the wrong thing.
    actor.hpRegen = 0;
  }

  return {
    world,
    downed,
    barrier,
    advance: (nowMs) => pump(world, { nowMs, barrier, downed }),
    actor: (id) => {
      const found = world.getActor(id);
      if (found === undefined) throw new Error(`test fixture: actor ${id} is missing`);
      return found;
    },
  };
}

/**
 * IS SOMEBODY DRIVING THIS BODY? — the same two flags, read the same way.
 *
 * A deliberate mirror of `isPresent` in engine/scheduler.ts rather than an
 * import of it (it is private, and it should stay private). Written out here so
 * that a test asserting on `survivors` is asserting on the same question the
 * scheduler asks, and so the pump tests below have something to compare against.
 */
function presence(world: World): PresenceCheck {
  return (id: string): boolean => {
    const actor = world.getActor(id);
    return actor !== undefined && actor.connected && !actor.standingBy;
  };
}

/** Put a body on the floor the way a killing blow outside a pump does. */
function knockDown(table_: Table, id: string): Actor {
  const actor = table_.actor(id);
  actor.hp = 0;
  actor.alive = false;
  goDown(table_.downed, actor, table_.world.turn.clock.gameTurn);
  return actor;
}

function wipeIn(events: readonly GameEvent[]): readonly string[] | undefined {
  const event = events.find((candidate) => candidate.t === 'party_wipe');
  if (event === undefined || event.t !== 'party_wipe') return undefined;
  return event.restored;
}

// ---------------------------------------------------------------------------
// The report itself
// ---------------------------------------------------------------------------

describe('the ghost that stranded a live player', () => {
  it('WIPES when the friend has closed the activity and the survivor is Downed', () => {
    // THE REPORTED SCENARIO, EXACTLY. Two players. One closes the activity —
    // which the gateway's close handler turns into `barrier.disconnect` — and
    // the other goes down. Before the fix this state was terminal.
    const stranded = table('ghost-report', 2);
    stranded.advance(0);
    stranded.barrier.disconnect(stranded.actor('p2'), 0);

    const dalt = knockDown(stranded, 'p1');

    // ═══ THE BUG, WRITTEN AS AN ASSERTION ═══
    // A predicate that counts every body still standing says the party is fine
    // while there is nobody left who could possibly help. That is the old
    // behaviour, and it is what stranded somebody for an evening.
    expect(surveyParty(stranded.world.allActors(), stranded.downed, () => true).wiped).toBe(false);
    // ...and the same survey, asked about who is actually at a keyboard.
    const honest = surveyParty(
      stranded.world.allActors(),
      stranded.downed,
      presence(stranded.world),
    );
    expect(honest.wiped).toBe(true);

    const result = stranded.advance(1);

    // THE FLOOR RESETS AND THE PLAYER IS BACK ON THEIR FEET. M4 has no
    // permadeath: a wipe restores rather than removing (game-design.md § 9).
    expect(wipeIn(result.events)).toEqual(['p1']);
    expect(dalt.alive).toBe(true);
    expect(dalt.hp).toBe(dalt.maxHp);
    expect(survivalOf(stranded.downed, 'p1')).toBe(Survival.Up);
  });

  it('leaves the ghost in `up` and NEVER in `downed` — it is simply not a survivor', () => {
    // The distinction that must not drift while reading the fix. A disconnected
    // body is conscious, at whatever hp its owner left it on, and they may walk
    // back in ten minutes to find it exactly there. Filing it under `downed`
    // would put a five-turn countdown on a healthy body and let
    // `resetFloorParty` rewrite hp nobody lost.
    const stranded = table('ghost-not-downed', 2);
    stranded.advance(0);

    const ghost = stranded.actor('p2');
    ghost.hp = 41;
    stranded.barrier.disconnect(ghost, 0);
    knockDown(stranded, 'p1');

    const survey = surveyParty(
      stranded.world.allActors(),
      stranded.downed,
      presence(stranded.world),
    );
    expect(survey.up).toEqual(['p2']);
    expect(survey.survivors).toEqual([]);
    expect(survey.downed).toEqual(['p1']);
    expect(survey.erased).toEqual([]);

    expect(wipeIn(stranded.advance(1).events)).toEqual(['p1']);

    // AND THE RESTORATION DID NOT REACH THEM. No record, so `resetFloorParty`
    // skips them entirely: the hp they left on, the body still in the world, and
    // still absent — somebody who walked away has not come back just because the
    // floor did.
    expect(ghost.hp).toBe(41);
    expect(ghost.alive).toBe(true);
    expect(stranded.downed.byActor.has('p2')).toBe(false);
    expect(survivalOf(stranded.downed, 'p2')).toBe(Survival.Up);
    expect(ghost.connected).toBe(false);
    expect(ghost.standingBy).toBe(true);
  });

  it('does not count an AFK player either — Standing By is absence with the socket open', () => {
    // The other half of the report: *"him being AFK, not in game, etc"*. The
    // scheduler's presence check reads BOTH flags, because two consecutive
    // auto-passes (engine/barrier.ts `expire`) mean the Bell has already given
    // up on somebody, and they are not about to cross a room to pick a friend up.
    const stranded = table('afk-wipe', 2);
    stranded.advance(0);

    const afk = stranded.actor('p2');
    afk.standingBy = true;
    expect(afk.connected).toBe(true);

    const dalt = knockDown(stranded, 'p1');
    expect(wipeIn(stranded.advance(1).events)).toEqual(['p1']);
    expect(dalt.hp).toBe(dalt.maxHp);
    // The floor came back; they did not. Standing By survives a wipe by design.
    expect(afk.standingBy).toBe(true);
  });

  it('never reports a wipe on a level nobody is standing on', () => {
    // The emptiness clause, and it is not pedantry: without it a freshly booted
    // server reports a party wipe on every single game turn and resets a floor
    // that has nobody on it. `downed + erased > 0` is what carries it, and the
    // presence predicate must not be able to reach past it.
    const empty = createDownedState();
    expect(surveyParty([], empty, () => true).wiped).toBe(false);
    expect(surveyParty([], empty, () => false).wiped).toBe(false);

    const booted = table('empty-level', 0);
    for (const nowMs of [0, 1, 2]) {
      expect(booted.advance(nowMs).events.some((event) => event.t === 'party_wipe')).toBe(false);
    }
  });

  it('counts a player who has come back as a survivor again — presence is read FRESH', () => {
    // Presence is a live fact, never a latch. Somebody whose wifi blinked and
    // came back inside their ten minutes is at the keyboard, can cross a room and
    // can pick their friend up — so the countdown is theirs to beat, and firing a
    // wipe past them would hand the party a free floor reset for a dropped packet.
    const rescue = table('ghost-returns', 2);
    rescue.advance(0);

    const friend = rescue.actor('p2');
    rescue.barrier.disconnect(friend, 0);

    const dalt = knockDown(rescue, 'p1');
    expect(surveyParty(rescue.world.allActors(), rescue.downed, presence(rescue.world)).wiped).toBe(
      true,
    );

    // They walk back in before the next pump — `barrier.reconnect`, which is
    // what the gateway's resume path calls.
    rescue.barrier.reconnect(friend);
    const survey = surveyParty(rescue.world.allActors(), rescue.downed, presence(rescue.world));
    expect(survey.survivors).toEqual(['p2']);
    expect(survey.wiped).toBe(false);

    const result = rescue.advance(1);
    expect(result.events.some((event) => event.t === 'party_wipe')).toBe(false);

    // AND THE MECHANIC IS INTACT. The body is still on the floor with turns on
    // its clock and an ally who can reach it: "I died" still means "GET TO ME".
    expect(dalt.hp).toBe(0);
    expect(isErased(rescue.downed, 'p1')).toBe(false);
    expect(survivalOf(rescue.downed, 'p1')).toBe(Survival.Downed);
    const view = downedView(rescue.downed, 'p1');
    expect(view?.total).toBe(DOWNED_TURNS);
    expect(view?.turnsLeft).toBeGreaterThan(0);

    // ...and if they close the activity a second time, the wipe is right there.
    rescue.barrier.disconnect(friend, 2);
    expect(rescue.advance(3).events.some((event) => event.t === 'party_wipe')).toBe(true);
    expect(dalt.alive).toBe(true);
    expect(dalt.hp).toBe(dalt.maxHp);
  });
});
