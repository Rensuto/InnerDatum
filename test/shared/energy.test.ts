import { describe, expect, it } from 'vitest';

import {
  ActResult,
  ENERGY_PER_TICK,
  ENERGY_TO_ACT,
  TICKS_PER_GAME_TURN,
  canAct,
  consumeBaseTurn,
  createEnergyActor,
  createTurnClock,
  energyGainPerTick,
  gameTurnOfTick,
  grantBaseEnergy,
  grantEnergy,
  recomputeGlobalSpeed,
  spendForAction,
  tickLevel,
} from '../../src/shared/energy.ts';
import type { EnergyActor, TickLevelResult, TurnClock } from '../../src/shared/energy.ts';

/**
 * ===========================================================================
 * THE HASTE TEST IS THE POINT OF THIS FILE.
 * ===========================================================================
 *
 * T-Engine4 runs every actor on TWO independent counters, and conflating them
 * is the single most expensive mistake available in this codebase:
 *
 *   `energy`     — the ACT clock. Gains ENERGY_PER_TICK * energyMod *
 *                  globalSpeed (GameEnergyBased.lua:124-126). Haste lives here
 *                  and ONLY here.
 *   `energyBase` — the BASE clock. Gains a FLAT ENERGY_PER_TICK, never
 *                  multiplied by anything (GameEnergyBased.lua:114-121). It
 *                  therefore fires exactly once per game turn at any speed, and
 *                  it is what drives cooldowns, regeneration and status
 *                  durations (tome/class/Actor.lua:476-608).
 *
 * Multiply `energyBase` by speed and haste silently becomes a way to buy
 * cooldowns and shorten your own debuffs. Nothing crashes, no test fails on its
 * own, and the only symptom is that balance "feels off" three weekends later —
 * by which point every talent cost in the game has been tuned against the bug.
 * docs/game-design.md § 3 names the test that pins it, and it is written out
 * literally below: a globalSpeed 1.4 actor takes 14 actions across 10 game
 * turns while its cooldowns tick exactly 10 times.
 *
 * WHY maxTicks IS THE DRIVER. `tickLevel` has no "run N turns" mode — it runs
 * to a park, to a fixed point, or to its tick budget. With no `isBlocking`
 * nothing ever parks and the actor always has somewhere to put its energy, so
 * the budget is the only clean stopping point. maxTicks is checked BEFORE the
 * tick is counted, so `maxTicks: 100` executes exactly 100 ticks — precisely
 * ten game turns — and reports `budget`.
 */

type Ledger = {
  /** How many times `act` fired. The speed-DEPENDENT count. */
  readonly actions: number;
  /** How many times `actBase` fired. The speed-INDEPENDENT count. */
  readonly baseTurns: number;
  readonly result: TickLevelResult;
  readonly actor: EnergyActor;
  readonly clock: TurnClock;
};

/**
 * Run one actor for exactly `ticks` engine ticks, counting both clocks
 * separately. The actor always spends a full turn per action (costMultiplier 1),
 * so every difference in `actions` is attributable to `globalSpeed` alone.
 */
function runTicks(globalSpeed: number, ticks: number): Ledger {
  const actor = createEnergyActor('subject', { globalSpeed });
  const clock = createTurnClock();
  let actions = 0;
  let baseTurns = 0;

  const result = tickLevel([actor], {
    clock,
    actBase: () => {
      baseTurns += 1;
    },
    act: (acting) => {
      actions += 1;
      spendForAction(acting, 1);
      return ActResult.Done;
    },
    maxTicks: ticks,
  });

  return { actions, baseTurns, result, actor, clock };
}

/** Ten game turns, the unit the milestone states its expectations in. */
const TEN_TURNS = 10 * TICKS_PER_GAME_TURN;
/** A hundred game turns — long enough for a rounding error to become visible. */
const HUNDRED_TURNS = 100 * TICKS_PER_GAME_TURN;

describe('the two clocks', () => {
  it('gives a globalSpeed 1.4 actor 14 actions across 10 game turns while its cooldowns tick exactly 10 times', () => {
    // THE M2 DEFINITION-OF-DONE TEST, written out literally.
    // docs/game-design.md § 3: "a globalSpeed = 1.4 actor takes 14 actions
    // across 10 game turns while its cooldowns tick exactly 10 times."
    const run = runTicks(1.4, TEN_TURNS);

    // The ACT clock: 140 energy per tick x 100 ticks = 14000, at 1000 an
    // action. Fourteen actions, and haste is the only reason there are more
    // than ten.
    expect(run.actions).toBe(14);

    // The BASE clock: flat 100 per tick whatever the speed, so ten game turns
    // is ten actBase passes. THIS IS THE LINE THAT MATTERS. If it ever reads 14
    // then `energyBase` has been multiplied by `globalSpeed` somewhere, and
    // haste has become a cooldown discount.
    expect(run.baseTurns).toBe(10);

    // ...and the two counts are genuinely different, which is the whole claim.
    expect(run.actions).toBeGreaterThan(run.baseTurns);

    expect(run.clock).toEqual({ tick: 100, gameTurn: 10 });
    expect(run.result.gameTurns).toBe(10);
    expect(run.result.ticks).toBe(TEN_TURNS);
    expect(run.result.status).toBe('budget');
  });

  it('ticks the base clock once per game turn at every speed, from crawling to quadruple', () => {
    // The generalisation of the test above. `baseTurns` must be 10 in every row
    // and `actions` must vary — a single loop over the two clocks that fails
    // loudly whichever one gets contaminated.
    for (const globalSpeed of [0.5, 1, 1.4, 2, 3, 4]) {
      const run = runTicks(globalSpeed, TEN_TURNS);
      expect({ globalSpeed, baseTurns: run.baseTurns, gameTurn: run.clock.gameTurn }).toEqual({
        globalSpeed,
        baseTurns: 10,
        gameTurn: 10,
      });
    }
  });

  it('never scales base-energy, whatever the actor gains on the act clock', () => {
    // The grant sites, tested directly rather than through the loop, so a
    // regression names the function it broke. `grantBaseEnergy` takes no
    // multiplier argument at all — and it must never grow one.
    const quick = createEnergyActor('quick', { globalSpeed: 4, energyMod: 2 });

    expect(energyGainPerTick(quick)).toBe(ENERGY_PER_TICK * 2 * 4);

    for (let i = 1; i < TICKS_PER_GAME_TURN; i += 1) {
      expect(grantBaseEnergy(quick)).toBe(false);
      expect(quick.energyBase).toBe(ENERGY_PER_TICK * i);
    }
    // The tenth flat grant, and only the tenth, banks a whole game turn.
    expect(grantBaseEnergy(quick)).toBe(true);
    expect(quick.energyBase).toBe(ENERGY_TO_ACT);

    // Actor.lua:512 subtracts rather than zeroing, so an off-phase remainder is
    // carried instead of quietly discarded.
    consumeBaseTurn(quick);
    expect(quick.energyBase).toBe(0);
  });
});

describe('actions per game turn', () => {
  it('gives an unhasted actor exactly one action per game turn', () => {
    // The baseline every other row is measured against, and the D1 case: a
    // player's globalSpeed is pinned to 1.0, so a party stays phase-locked and
    // the barrier parks once per turn at full quorum.
    const run = runTicks(1, TEN_TURNS);
    expect(run.actions).toBe(10);
    expect(run.baseTurns).toBe(10);
    expect(run.clock.gameTurn).toBe(10);
  });

  it('gives a doubled actor 20 actions across 10 game turns', () => {
    const run = runTicks(2, TEN_TURNS);
    expect(run.actions).toBe(20);
    expect(run.baseTurns).toBe(10);
  });

  it('gives a halved actor 5 actions across 10 game turns', () => {
    // The other direction, and the one that proves `actions` is not simply
    // being reported as the turn count: a slow actor gets FEWER actions while
    // its cooldowns tick at exactly the same rate as everybody else's. Haste
    // and slow are symmetric about the base clock and neither one touches it.
    const run = runTicks(0.5, TEN_TURNS);
    expect(run.actions).toBe(5);
    expect(run.baseTurns).toBe(10);
  });

  it('clamps a zero or negative speed rather than parking the actor forever', () => {
    // Actor.lua:3913's `math.max(self.global_speed, 0.1)`. Without the floor a
    // stacked slow reaches zero gain, and an actor that can never act still
    // occupies a slot in every sweep — the level stops being able to idle.
    const stalled = createEnergyActor('stalled', { globalSpeed: 0 });
    expect(stalled.globalSpeed).toBe(0.1);
    expect(runTicks(0, TEN_TURNS).actions).toBe(1);

    // The same asymmetric floor, via the recompute helper (Actor.lua:3909-3914):
    // positive modifiers add, negative ones divide, so +N and -N compose back
    // to 1 and no stack of slows can reach zero.
    expect(recomputeGlobalSpeed(1, 0.5)).toBe(1.5);
    expect(recomputeGlobalSpeed(1, -0.5)).toBeCloseTo(1 / 1.5, 12);
    expect(recomputeGlobalSpeed(1, -100)).toBe(0.1);
  });
});

describe('energy accounting', () => {
  it('does not drift across a hundred game turns, at any speed', () => {
    // A hundred turns of floating-point accumulation with no re-basing. If
    // `energy` were being topped up with a value that is not exactly
    // representable, or if the spend and the grant used different arithmetic,
    // the residue would show up here as a fractional leftover and — far worse —
    // as an action count that is one off the arithmetic answer.
    //
    // 1.4 is deliberately in the list: it is not exactly representable in
    // binary, so this is the row that would catch a real drift.
    for (const [globalSpeed, expectedActions] of [
      [0.5, 50],
      [1, 100],
      [1.4, 140],
      [2, 200],
    ] as const) {
      const run = runTicks(globalSpeed, HUNDRED_TURNS);

      expect({ globalSpeed, actions: run.actions, baseTurns: run.baseTurns }).toEqual({
        globalSpeed,
        actions: expectedActions,
        baseTurns: 100,
      });
      // Both clocks land on exact whole numbers, not 3.637978807091713e-12.
      expect(Number.isInteger(run.actor.energy)).toBe(true);
      expect(Number.isInteger(run.actor.energyBase)).toBe(true);
      expect(run.actor.energy).toBe(0);
      expect(run.actor.energyBase).toBe(0);
      expect(run.clock).toEqual({ tick: HUNDRED_TURNS, gameTurn: 100 });
    }
  });

  it('stops accruing act-energy at the threshold — ToME’s anti-stockpiling guard', () => {
    // GameEnergyBased.lua:124-126. Port this verbatim or a player who idles for
    // a minute out of combat banks sixty turns and then crosses the map in one
    // frame. The guard is checked BEFORE the add, so a fast actor still
    // overshoots by up to one tick's worth and carries the remainder forward.
    const banked = createEnergyActor('banked', { globalSpeed: 1 });

    expect(grantEnergy(banked, 900)).toBe(900);
    expect(canAct(banked)).toBe(false);
    // Below the threshold, so the whole (overshooting) grant lands.
    expect(grantEnergy(banked, ENERGY_PER_TICK * 3)).toBe(300);
    expect(banked.energy).toBe(1200);
    expect(canAct(banked)).toBe(true);
    // At or over it, nothing more is granted however often it is asked.
    expect(grantEnergy(banked, ENERGY_PER_TICK)).toBe(0);
    expect(grantEnergy(banked, ENERGY_PER_TICK)).toBe(0);
    expect(banked.energy).toBe(1200);

    // The remainder survives the spend — that is what "carries forward" means.
    expect(spendForAction(banked, 1)).toBe(ENERGY_TO_ACT);
    expect(banked.energy).toBe(200);
    expect(banked.energyUsed).toBe(true);
  });

  it('scales an action’s COST by its multiplier, in the opposite direction from speed', () => {
    // `globalSpeed` scales what an actor GAINS; `costMultiplier` scales what one
    // action COSTS (Actor.lua:5863). They are constantly confused, so both
    // directions are pinned here. Players always pass 1 (D1); this is the
    // monster side.
    const monster = createEnergyActor('monster');
    monster.energy = 4000;

    expect(spendForAction(monster, 0.5)).toBe(500);
    expect(spendForAction(monster, 2)).toBe(2000);
    // Actor.lua:5828's `math.max(0.1, speed)`. A zero-cost action inside a
    // synchronous turn resolution is not a slow frame, it is a wedged process.
    expect(spendForAction(monster, 0)).toBe(100);
    expect(monster.energy).toBe(1400);

    expect(() => spendForAction(monster, Number.NaN)).toThrow(RangeError);
  });
});

describe('ten ticks make one game turn', () => {
  it('derives the ratio from the two constants rather than hard-coding it', () => {
    // GameEnergyBased.lua:33-34. Everything downstream — every cooldown, every
    // duration, the Bell, the log's turn counter — is denominated in game turns,
    // so this ratio is the units contract for the whole engine.
    expect(ENERGY_TO_ACT).toBe(1000);
    expect(ENERGY_PER_TICK).toBe(100);
    expect(TICKS_PER_GAME_TURN).toBe(10);
    expect(ENERGY_TO_ACT / ENERGY_PER_TICK).toBe(TICKS_PER_GAME_TURN);
  });

  it('advances the game turn once every ten ticks and not before', () => {
    // ToME's own `game.turn` counts TICKS, which is why its module code is full
    // of `self.turn % 10` (tome/class/Game.lua:881, 1740). TurnClock carries
    // both numbers so nobody has to know which one a bare `turn` meant.
    for (let tick = 0; tick <= 3 * TICKS_PER_GAME_TURN; tick += 1) {
      expect(gameTurnOfTick(tick)).toBe(Math.floor(tick / 10));
    }

    // The counter advances AFTER the entity loop (GameEnergyBased.lua:89-90), so
    // at a sweep boundary the two numbers agree exactly.
    const seen: number[] = [];
    const run = runTicks(1, 3 * TICKS_PER_GAME_TURN);
    expect(run.clock.gameTurn).toBe(gameTurnOfTick(run.clock.tick));

    // And the hook fires exactly once per completed turn, in order.
    const actor = createEnergyActor('hooked');
    const clock = createTurnClock();
    tickLevel([actor], {
      clock,
      actBase: () => {},
      act: (acting) => {
        spendForAction(acting, 1);
        return ActResult.Done;
      },
      onGameTurn: (current) => {
        seen.push(current.gameTurn);
      },
      maxTicks: 3 * TICKS_PER_GAME_TURN,
    });
    expect(seen).toEqual([1, 2, 3]);
    expect(clock.tick).toBe(30);
  });
});

describe('tickLevel termination', () => {
  it('reports idle without moving a single clock when nothing can change', () => {
    // The out-of-combat fixed point: everybody sits at the threshold, accrual
    // stops, nobody spends. If an idle pump advanced the base clock even one
    // notch, a client could spam pings for free regeneration.
    const resting = createEnergyActor('resting');
    resting.energy = ENERGY_TO_ACT;
    const clock = createTurnClock();
    let baseTurns = 0;

    const result = tickLevel([resting], {
      clock,
      actBase: () => {
        baseTurns += 1;
      },
      act: () => ActResult.Done,
    });

    expect(result.status).toBe('idle');
    expect(result.ticks).toBe(0);
    expect(result.gameTurns).toBe(0);
    expect(clock).toEqual({ tick: 0, gameTurn: 0 });
    expect(baseTurns).toBe(0);
    expect(resting.energyBase).toBe(0);
  });

  it('returns the COMPLETE blocking set, discovered within a single tick', () => {
    // The one deliberate structural deviation from ToME (GameEnergyBased.lua:
    // 99-107, 133-141): a park does not stop the sweep. Players are
    // phase-locked, so all of them cross the threshold on the same tick; break
    // out at the first one and player 2 is invisible to the barrier until
    // player 1 has decided, which is round-robin with extra steps.
    const party = [createEnergyActor('p1'), createEnergyActor('p2'), createEnergyActor('p3')];
    const clock = createTurnClock();

    const result = tickLevel(party, {
      clock,
      actBase: () => {},
      act: () => ActResult.Done,
      isBlocking: () => true,
      maxTicks: 5 * TICKS_PER_GAME_TURN,
    });

    expect(result.status).toBe('parked');
    expect(result.parked).toEqual(['p1', 'p2', 'p3']);
    // One game turn, not one tick per player.
    expect(result.ticks).toBe(TICKS_PER_GAME_TURN);
    expect(result.gameTurns).toBe(1);
  });

  it('rejects a maxTicks that could never terminate', () => {
    const actor = createEnergyActor('a');
    const ctx = { clock: createTurnClock(), actBase: () => {}, act: () => ActResult.Done };
    expect(() => tickLevel([actor], { ...ctx, maxTicks: 0 })).toThrow(RangeError);
    expect(() => tickLevel([actor], { ...ctx, maxTicks: 1.5 })).toThrow(RangeError);
  });
});
