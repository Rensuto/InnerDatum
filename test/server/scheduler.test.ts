import { describe, expect, it } from 'vitest';

import {
  AiProfile,
  HOLD_INTENT,
  IntentKind,
  cooldownOf,
  setCooldown,
} from '../../src/server/engine/actor.ts';
import { createBarrier } from '../../src/server/engine/barrier.ts';
import { DamageType } from '../../src/server/engine/damage.ts';
import { createDownedState, goDown } from '../../src/server/engine/downed.ts';
import {
  disconnectActor,
  pump,
  reconnectActor,
  submitIntent,
} from '../../src/server/engine/scheduler.ts';
import { createTurnEngine } from '../../src/server/turn-engine.ts';
import { createWorld } from '../../src/server/world/world.ts';
import { TICKS_PER_GAME_TURN } from '../../src/shared/energy.ts';
import type { EngineActor, Intent } from '../../src/server/engine/actor.ts';
import type { Barrier } from '../../src/server/engine/barrier.ts';
import type { GameEvent, PumpResult, SweepStep } from '../../src/server/engine/scheduler.ts';
import type { World } from '../../src/server/world/world.ts';

/**
 * `pump` — the drive loop, and the one function that makes the world move.
 *
 * It sends nothing, saves nothing and waits for nothing: it mutates the world,
 * returns an ordered event list, and hands the caller a Bell deadline to set a
 * real timer for. That is not layering for its own sake — turn resolution being
 * synchronous IS the mutex, and it is why two WebSocket frames cannot interleave
 * mid-turn. Every test below is therefore a plain function call with the wall
 * clock passed in as a number.
 *
 * The two properties this file exists to defend:
 *
 *   ONE PARK PER GAME TURN. Players are phase-locked (D1), so the loop parks
 *   with everybody in it, once, and nine ticks in every ten produce no traffic.
 *
 *   ONE BATCHED SWEEP. Every monster acting between two player parks lands in a
 *   SINGLE `sweep` event carrying an ordered `steps` array; the client paces the
 *   display and the server never sleeps. Four players watching eight monsters
 *   each take an individually-transmitted turn is the second-most-common way
 *   co-op turn-based games die.
 */

const HUSK_SPRITE = 'enemy_index_husk_s';

type Session = {
  readonly world: World;
  readonly barrier: Barrier;
  /** Advance the world. `nowMs` is a parameter because the engine owns no clock. */
  readonly advance: (nowMs: number) => PumpResult;
  /** Submit an intent and resolve it, exactly as an accepted command does. */
  readonly commit: (actorId: string, intent: Intent, nowMs: number) => PumpResult;
};

/**
 * A world with `players` humans on the spawn cluster and `monsters` husks in the
 * corridor east of them — close enough to have line of sight, which is what arms
 * `engagement` and therefore the barrier.
 */
function session(seed: string, players: number, monsters: number, globalSpeed = 1): Session {
  const world = createWorld(seed);
  for (let i = 0; i < players; i += 1) {
    const actor = world.addPlayer(`p${i + 1}`, `Player ${i + 1}`);
    // Placeholder vitals are deliberately small so a fight is over in three
    // turns; several of these tests run for ten and would otherwise be measuring
    // a corpse. M3 brings real numbers from content/.
    actor.maxHp = 10_000;
    actor.hp = 10_000;
  }
  for (let i = 0; i < monsters; i += 1) {
    world.addMonster(`m${i + 1}`, {
      name: `Index Husk ${i + 1}`,
      sprite: HUSK_SPRITE,
      x: 7 + i,
      y: 2,
      profile: AiProfile.MeleeChaser,
      globalSpeed,
    });
  }

  const barrier = createBarrier();
  return {
    world,
    barrier,
    advance: (nowMs) => pump(world, { nowMs, barrier }),
    commit: (actorId, intent, nowMs) => {
      expect(submitIntent(world, barrier, actorId, intent)).toBe(true);
      return pump(world, { nowMs, barrier });
    },
  };
}

function sweeps(events: readonly GameEvent[]): readonly GameEvent[] {
  return events.filter((event) => event.t === 'sweep');
}

function sweepSteps(events: readonly GameEvent[]): SweepStep[] {
  const steps: SweepStep[] = [];
  for (const event of events) {
    if (event.t === 'sweep') steps.push(...event.steps);
  }
  return steps;
}

function must(actor: EngineActor | undefined, id: string): EngineActor {
  if (actor === undefined) throw new Error(`test fixture: actor ${id} is missing`);
  return actor;
}

describe('pump parks', () => {
  it('advances to a park the moment a player owes a decision', () => {
    // Nine ticks of nothing (sub-millisecond, no traffic), then one tick where
    // the whole party is parked together. Option (b) from game-design.md § 4
    // spontaneously produces option (c)'s ergonomics without hardcoding them.
    const table = session('park', 2, 1);
    const first = table.advance(0);

    expect(first.status).toBe('parked');
    expect(first.parked).toEqual(['p1', 'p2']);
    expect(first.ticks).toBe(TICKS_PER_GAME_TURN);
    expect(first.gameTurns).toBe(1);
    expect(first.gameTurn).toBe(1);
    // Engagement is level-wide and armed BEFORE anybody is asked whether they
    // are blocking, or the first turn of every fight would run unblocked.
    expect(first.engagement).toBeGreaterThan(0);
    expect(first.events).toEqual([
      { t: 'engagement', turns: 3 },
      { t: 'turn_ended', gameTurn: 1 },
    ]);

    // A committed player resolves immediately and drops out of the blocking set
    // without waiting for the rest of the party — and the clock does not move.
    const afterFirstCommit = table.commit('p1', HOLD_INTENT, 1);
    expect(afterFirstCommit.status).toBe('parked');
    expect(afterFirstCommit.parked).toEqual(['p2']);
    expect(afterFirstCommit.ticks).toBe(0);
    expect(afterFirstCommit.gameTurn).toBe(1);

    // The last commit releases the barrier: the world moves, and the next park
    // is the next turn's, at full quorum.
    const afterLastCommit = table.commit('p2', HOLD_INTENT, 2);
    expect(afterLastCommit.status).toBe('parked');
    expect(afterLastCommit.parked).toEqual(['p1', 'p2']);
    expect(afterLastCommit.ticks).toBe(TICKS_PER_GAME_TURN);
    expect(afterLastCommit.gameTurn).toBe(2);
  });

  it('goes idle out of combat without advancing a single clock', () => {
    // With no hostile in view nobody blocks, so the loop runs until every player
    // sits at the threshold where accrual stops and the process goes to ~0% CPU.
    // The second pump must move NOTHING: if an idle pump advanced the base clock
    // even one notch, a client could spam pings for free regeneration.
    const table = session('idle', 2, 0);

    const first = table.advance(0);
    expect(first.status).toBe('idle');
    expect(first.engagement).toBe(0);
    expect(first.parked).toEqual([]);

    const second = table.advance(1);
    expect(second.status).toBe('idle');
    expect(second.ticks).toBe(0);
    expect(second.gameTurns).toBe(0);
    expect(second.gameTurn).toBe(first.gameTurn);
    expect(second.events).toEqual([]);
    // No Bell out of combat, ever — there is nobody blocking to ring one at.
    expect(second.bell.running).toBe(false);
    expect(second.bell.durationMs).toBeNull();
  });

  it('resolves a move through the world and reports it as one event', () => {
    const table = session('move', 1, 1);
    table.advance(0);
    const before = must(table.world.getActor('p1'), 'p1');
    const from = { x: before.x, y: before.y };

    const result = table.commit('p1', { kind: IntentKind.Move, dir: 's' }, 1);
    const moved = result.events.filter((event) => event.t === 'moved');

    expect(moved).toEqual([{ t: 'moved', id: 'p1', from, to: { x: from.x, y: from.y + 1 } }]);
    expect({ x: before.x, y: before.y }).toEqual({ x: from.x, y: from.y + 1 });
  });
});

describe('the actBase pass', () => {
  it('runs exactly once per game turn, for a hasted monster as well as a player', () => {
    // THE HASTE INVARIANT, restated at the scheduler level. A globalSpeed 1.4
    // monster gets more ACTIONS; its cooldowns tick on the base clock and must
    // therefore tick at exactly the same rate as the unhasted player's. Get this
    // wrong and haste is a cooldown discount — invisible until balance
    // mysteriously feels bad three weekends later.
    const table = session('actbase', 1, 1, 1.4);
    const player = must(table.world.getActor('p1'), 'p1');
    const monster = must(table.world.getActor('m1'), 'm1');
    setCooldown(player, 'ward_rush', 40);
    setCooldown(monster, 'gutting_strike', 40);

    let monsterActions = 0;
    let nowMs = 0;
    let last = table.advance(nowMs);
    monsterActions += sweepSteps(last.events).length;

    const turnsToRun = 12;
    for (let turn = 0; turn < turnsToRun; turn += 1) {
      nowMs += 1_000;
      last = table.commit('p1', HOLD_INTENT, nowMs);
      monsterActions += sweepSteps(last.events).length;
    }

    const gameTurns = last.gameTurn;
    expect(gameTurns).toBe(turnsToRun + 1);

    // One decrement per game turn, on both actors, with no rounding and no
    // dependence on speed.
    expect(cooldownOf(player, 'ward_rush')).toBe(40 - gameTurns);
    expect(cooldownOf(monster, 'gutting_strike')).toBe(40 - gameTurns);
    expect(cooldownOf(monster, 'gutting_strike')).toBe(cooldownOf(player, 'ward_rush'));

    // ...while the same monster genuinely acted MORE often than there were
    // turns. If this ever equals `gameTurns`, speed has stopped reaching the act
    // clock and the two assertions above have become vacuous.
    expect(monsterActions).toBeGreaterThan(gameTurns);
    expect(monsterActions).toBeLessThanOrEqual(Math.ceil(1.4 * gameTurns));
  });

  it('does not tick a cooldown on a pump that changed nothing', () => {
    // The other half: an idle pump is free to call and cannot be farmed.
    const table = session('actbase-idle', 1, 0);
    const player = must(table.world.getActor('p1'), 'p1');
    table.advance(0);
    setCooldown(player, 'fog_step', 5);

    for (let i = 0; i < 20; i += 1) {
      expect(table.advance(i).status).toBe('idle');
    }
    expect(cooldownOf(player, 'fog_step')).toBe(5);
  });
});

describe('the monster sweep', () => {
  it('comes back as ONE batched event, not one message per monster', () => {
    // THE M2 DEFINITION-OF-DONE ITEM. The batching is modelled in the event
    // SHAPE precisely so the netcode cannot accidentally undo it later: a
    // consumer that wants per-monster frames has to go out of its way to build
    // them, rather than getting them by default.
    const monsterCount = 6;
    const table = session('sweep', 2, monsterCount);

    table.advance(0);
    table.commit('p1', HOLD_INTENT, 1);
    const released = table.commit('p2', HOLD_INTENT, 2);

    const batches = sweeps(released.events);
    expect(batches).toHaveLength(1);

    const steps = sweepSteps(released.events);
    expect(steps).toHaveLength(monsterCount);
    expect(steps.map((step) => step.id)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5', 'm6']);

    // Nothing a monster did leaked out as a top-level event; the whole sweep is
    // inside the one batch.
    const loose = released.events.filter(
      (event) => event.t === 'moved' || event.t === 'attacked' || event.t === 'held',
    );
    expect(loose.map((event) => ('id' in event ? event.id : ''))).toEqual(['p2']);

    // ...and the batch is stamped with the turn it belongs to, so the client can
    // pace it against the right turn marker.
    const [batch] = batches;
    if (batch === undefined || batch.t !== 'sweep') throw new Error('expected one sweep batch');
    expect(batch.gameTurn).toBe(1);
  });

  it('keeps the batch to the run of monster actions between two other events', () => {
    // The batching rule is one line — any non-monster event closes the open
    // batch — which is what keeps the event list in true chronological order
    // instead of collecting every monster action of the pump into one blob.
    const table = session('sweep-order', 1, 3);
    table.advance(0);
    const released = table.commit('p1', HOLD_INTENT, 1);

    const kinds = released.events.map((event) => event.t);
    expect(kinds).toEqual(['held', 'sweep', 'turn_ended']);
    expect(sweepSteps(released.events)).toHaveLength(3);
  });
});

describe('determinism', () => {
  /** A fixed script: hold every turn and let the husks come to you. */
  function play(seed: string, turns: number): GameEvent[] {
    const table = session(seed, 2, 3);
    const events: GameEvent[] = [];
    for (let turn = 0; turn < turns; turn += 1) {
      events.push(...table.advance(turn * 1_000).events);
      events.push(...table.commit('p1', HOLD_INTENT, turn * 1_000 + 1).events);
      events.push(...table.commit('p2', HOLD_INTENT, turn * 1_000 + 2).events);
    }
    return events;
  }

  it('produces an identical event list from an identical seed and command sequence', () => {
    // Given (world state, RNG state, and the wall-clock values passed in), pump
    // produces the same events on any machine. Actor order comes from the
    // world's turn order rather than a hash table, every draw goes through the
    // seeded PCG32 with a label, and nothing in the engine reads a clock. A
    // divergence here means a save that loads into a different fight.
    const first = play('replay', 10);
    const second = play('replay', 10);

    expect(JSON.stringify(second)).toEqual(JSON.stringify(first));
    // The run has to be substantial enough to be worth comparing: monsters
    // walked, then hit somebody, which is where the RNG actually gets used.
    expect(sweepSteps(first).some((step) => step.t === 'attack')).toBe(true);
    expect(first.length).toBeGreaterThan(20);
  });

  it('separates two seeds once the dice come out', () => {
    // The other half of the same guarantee. Without it the test above would
    // still pass with the seed ignored entirely, and every fight in every
    // session would roll identical damage.
    const damage = (events: readonly GameEvent[]): number[] =>
      sweepSteps(events).flatMap((step) => (step.t === 'attack' ? [step.damage] : []));

    const alpha = damage(play('seed-alpha', 10));
    const beta = damage(play('seed-beta', 10));

    expect(alpha.length).toBeGreaterThan(0);
    expect(beta.length).toBeGreaterThan(0);
    expect(alpha).not.toEqual(beta);
  });
});

describe('the travelling projectile leaves the instant attack alone', () => {
  /** Hold for twelve turns and let the husks come. Returns what the run produced. */
  function instantRun(seed: string): {
    readonly table: Session;
    readonly steps: SweepStep[];
    readonly events: GameEvent[];
  } {
    const table = session(seed, 1, 3);
    const steps: SweepStep[] = [];
    const events: GameEvent[] = [];
    let last = table.advance(0);
    for (let turn = 0; turn < 12; turn += 1) {
      steps.push(...sweepSteps(last.events));
      events.push(...last.events);
      // NOTHING IS EVER IN THE AIR on this path — not for a single tick.
      expect(table.world.projectilesInFlight()).toEqual([]);
      last = table.commit('p1', HOLD_INTENT, (turn + 1) * 1_000);
    }
    steps.push(...sweepSteps(last.events));
    events.push(...last.events);
    return { table, steps, events };
  }

  it('AN ATTACKER WITH NO projSpeed IS UNCHANGED — same step, same events, same stream', () => {
    // ═══════════════════════════════════════════════════════════════════════
    // THE SAFETY PROPERTY OF THE WHOLE FEATURE, IN ONE TEST.
    // ═══════════════════════════════════════════════════════════════════════
    //
    // ActorTalents.lua:988 — `if not t.proj_speed then return nil end`. ABSENT
    // MEANS INSTANTANEOUS, so every attack that existed before travelling orbs
    // did must still take the `strike` path: the same single
    // `combat.bump.damage` draw at the same position in the stream, the same
    // `attack` sweep step, and no orb anywhere. A husk has no `projSpeed` and
    // neither does the elite; only the wraith carries one.
    const first = instantRun('no-projspeed');

    // Blows landed, instantly, exactly as they always did...
    const attacks = first.steps.filter((step) => step.t === 'attack');
    expect(attacks.length).toBeGreaterThan(0);
    for (const hit of attacks) {
      if (hit.t !== 'attack') throw new Error('unreachable');
      // The M2 placeholder range, straight from `strike`.
      expect(hit.damage).toBeGreaterThanOrEqual(3);
      expect(hit.damage).toBeLessThanOrEqual(6);
    }
    // ...and not one of them was a launch.
    expect(first.steps.some((step) => step.t === 'fired')).toBe(false);

    // AND THE STREAM IS IN THE SAME PLACE IT WOULD HAVE BEEN. The fork must not
    // add, remove or re-order a single draw on this path: the same seed and the
    // same script leave the generator on the same cursor, with the same draw
    // count and the same last label. Anything the fork did to `strike` — an
    // extra roll, a moved roll, a relabelled one — lands here.
    const second = instantRun('no-projspeed');
    expect(second.table.world.rng.getState()).toEqual(first.table.world.rng.getState());
    expect(JSON.stringify(second.events)).toEqual(JSON.stringify(first.events));
    expect(first.table.world.rng.getState().count).toBeGreaterThan(0);
  });

  it('A FLOOR RESET TAKES EVERYTHING OUT OF THE AIR — the loop, closed again', () => {
    // `resetFloor`'s own header records the evening this cost: a party restored
    // in place, one tile from the thing that killed them, knocked down again on
    // the next pump, forever. An orb that survived the wipe is that bug with a
    // three-turn fuse — it lands on the restored party standing on the spawn
    // cluster at full health, and re-creates the loop exactly. The projectile
    // table is cleared in step 2, before the floor is re-seeded.
    const world = createWorld('reset-projectiles');
    const downed = createDownedState();
    const ren = world.addPlayer('p1', 'Ren');
    ren.x = 22;
    ren.y = 20;

    world.addProjectile({
      sourceId: 'm_gone',
      origin: { x: 16, y: 20 },
      to: { x: 22, y: 20 },
      projSpeed: 2,
      range: 6,
      damage: { dam: 40, type: DamageType.Physical, apr: 0 },
    });
    expect(world.projectilesInFlight()).toHaveLength(1);

    const engine = createTurnEngine({ world, downed, now: () => 0 });
    ren.hp = 0;
    ren.alive = false;
    goDown(downed, ren, world.turn.clock.gameTurn);
    engine.pump();

    // The party is up, the floor is re-seeded, and the sky is clear.
    expect(world.getActor('p1')?.alive).toBe(true);
    expect(world.projectilesInFlight()).toEqual([]);
  });
});

describe('the tick budget', () => {
  it('returns instead of spinning when nothing can park and nothing can idle', () => {
    // THE SAFETY VALVE, and it is not theoretical: every player Standing By or
    // disconnected while monsters still have targets means nobody blocks (so no
    // park) and somebody is still spending energy (so no idle). Without a bound
    // that is not a slow frame — it is a synchronous loop that never returns and
    // a server process that never answers again.
    const table = session('budget', 1, 1);
    table.advance(0);
    expect(disconnectActor(table.world, table.barrier, 'p1', 1)).toBe(true);

    const budget = 25;
    const result = pump(table.world, { nowMs: 2, barrier: table.barrier, maxTicks: budget });

    expect(result.status).toBe('budget');
    expect(result.ticks).toBe(budget);
    expect(result.parked).toEqual([]);
    // State is consistent and the caller may simply call again — which is what
    // makes this a valve rather than an error path.
    expect(result.gameTurns).toBe(Math.floor(budget / TICKS_PER_GAME_TURN));
    expect(pump(table.world, { nowMs: 3, barrier: table.barrier, maxTicks: budget }).ticks).toBe(
      budget,
    );

    // The disconnected player auto-held every turn rather than being asked, and
    // their body never left the world.
    const held = result.events.filter((event) => event.t === 'held');
    expect(held.length).toBeGreaterThan(0);
    expect(held.every((event) => event.t === 'held' && event.reason === 'standing_by')).toBe(true);
    expect(table.world.getActor('p1')).toBeDefined();

    // Reconnecting puts them back in the quorum, and the very next pump parks
    // again instead of burning the budget.
    expect(reconnectActor(table.world, table.barrier, 'p1')).toBe(true);
    const back = pump(table.world, { nowMs: 4, barrier: table.barrier, maxTicks: budget });
    expect(back.status).toBe('parked');
    expect(back.parked).toEqual(['p1']);
  });

  it('rejects a nonsense clock rather than freezing the Bell forever', () => {
    // A NaN here would stop every countdown and look exactly like "the Bell is
    // broken" three weekends later, so it fails loudly at the boundary.
    const table = session('nan', 1, 1);
    expect(() => pump(table.world, { nowMs: Number.NaN, barrier: table.barrier })).toThrow(
      RangeError,
    );
  });
});
