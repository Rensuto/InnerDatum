// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/engines/default/engine/GameEnergyBased.lua:33-142
//             t-engine4 game/engines/default/engine/Actor.lua:469-485
//             t-engine4 game/modules/tome/class/Actor.lua:476-512, 3909-3914, 5816-5863
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" — https://te4.org/license

/**
 * The energy scheduler: T-Engine4's tick loop, ported.
 *
 * ===========================================================================
 * THERE ARE TWO CLOCKS. THIS IS THE ONE THING TO GET RIGHT.
 * ===========================================================================
 *
 * T-Engine4 runs every actor on two independent counters, and conflating them
 * is the single most expensive mistake available in this file.
 *
 *   THE ACT CLOCK — `energy`, spent by `act()`.
 *     Accrues `ENERGY_PER_TICK * energyMod * globalSpeed` per tick
 *     (GameEnergyBased.lua:125). A hasted actor fills it faster, so it acts
 *     MORE OFTEN. This is where speed lives, and the only place it lives.
 *
 *   THE BASE CLOCK — `energyBase`, spent by `actBase()`.
 *     Accrues a FLAT `ENERGY_PER_TICK` per tick, never multiplied by anything
 *     (GameEnergyBased.lua:114-121). It therefore fires exactly once per game
 *     turn for every actor alive, at any speed. Cooldowns, resource
 *     regeneration and status-effect durations tick HERE
 *     (tome/class/Actor.lua:476-608), and nowhere else.
 *
 * Multiply `energyBase` by anything at all and haste silently becomes a way to
 * buy cooldowns and shorten your own debuffs: the tactical layer collapses, no
 * test fails, and the only symptom is that balance "feels off" three weekends
 * later. The M2 test that pins it: an actor with `globalSpeed = 1.4` takes 14
 * actions across 10 game turns while its cooldowns tick exactly 10 times.
 *
 * The two clocks are separate FIELDS with separate GRANT SITES and separate
 * CALLBACKS (`ctx.act` vs `ctx.actBase`), so losing the distinction requires
 * deliberately deleting a name rather than forgetting an invariant.
 *
 * ===========================================================================
 * THE ARITHMETIC
 * ===========================================================================
 *
 *   ENERGY_TO_ACT / ENERGY_PER_TICK = 1000 / 100 = 10 ticks per GAME TURN.
 *
 * A tick is the engine's atomic step and is invisible to players — nine of
 * every ten produce no traffic at all. A game turn is the unit the fiction,
 * the log and every cooldown and duration are denominated in. ToME's own
 * `game.turn` counts TICKS, which is why its module code is littered with
 * `self.turn % 10` and `self.turn / 10` (tome/class/Game.lua:881, 1740). We
 * carry both numbers explicitly in `TurnClock` so nobody ever has to know
 * which one a bare `turn` meant.
 *
 * ===========================================================================
 * PLAYERS VS MONSTERS (DECISIONS.md § D1)
 * ===========================================================================
 *
 *   PLAYERS  always spend exactly ENERGY_TO_ACT, with `globalSpeed` pinned to
 *            1.0. AP/MP is an intra-turn budget spent inside one park, never a
 *            way to buy an extra park. That is what keeps a party
 *            phase-locked, so the barrier parks ONCE PER TURN AT FULL QUORUM —
 *            the condition the Bell was designed around.
 *   MONSTERS keep ToME's full variable-speed model, on both sides of the
 *            equation: `globalSpeed` scales what they GAIN, and the
 *            `costMultiplier` of `spendForAction` scales what an individual
 *            action COSTS.
 *
 * Those two knobs pull in OPPOSITE directions and are constantly confused:
 * `globalSpeed` 2.0 means "gains energy twice as fast", `costMultiplier` 2.0
 * means "this action costs two turns". A weapon-speed or talent-speed value
 * from ToME is a COST multiplier (tome/class/Actor.lua:5863); haste is a GAIN
 * multiplier (tome/class/Actor.lua:3909-3914).
 *
 * PURE (src/shared/): no clock, no I/O, no randomness, no timers. `tickLevel`
 * is a state transition over actors the caller owns, plus explicit callbacks.
 * Everything the engine does with the result — sending frames, queueing a
 * save — happens in the CALLER after it returns.
 */

import { ENERGY_PER_TICK, ENERGY_TO_ACT } from './version.ts';

export { ENERGY_PER_TICK, ENERGY_TO_ACT };

/**
 * 10. The constant that ties the two clocks together — GameEnergyBased.lua:34.
 *
 * Derived rather than written as `10` so that changing either constant in
 * version.ts cannot leave a stale literal behind.
 */
export const TICKS_PER_GAME_TURN = ENERGY_TO_ACT / ENERGY_PER_TICK;

/**
 * The floor on an action's cost multiplier — tome/class/Actor.lua:5828
 * (`speed = math.max(0.1, speed) -- speed limit`).
 *
 * Without it a stacked speed buff reaches a zero-cost action, and a zero-cost
 * action is an infinite loop inside a synchronous turn resolution: not a slow
 * frame, a wedged server process.
 */
export const MIN_ACTION_COST_MULTIPLIER = 0.1;

/**
 * The floor on `globalSpeed` — tome/class/Actor.lua:3913
 * (`self.global_speed = math.max(self.global_speed, 0.1)`).
 *
 * Zero or negative gain would park an actor forever while still occupying a
 * slot in the sweep.
 */
export const MIN_GLOBAL_SPEED = 0.1;

// ---------------------------------------------------------------------------
// The actor, as the scheduler sees it
// ---------------------------------------------------------------------------

/**
 * The MINIMAL shape the scheduler needs. Deliberately not "the actor" — the
 * world's real actor is a structural superset of this, so `tickLevel` can run
 * over the live array with no adapter, no copy and no second source of truth,
 * while this module stays testable with six-line objects.
 *
 * Mutable on purpose: ToME's loop mutates in place and so does ours. A hundred
 * fresh objects per tick would be pure waste in the hottest loop in the
 * process, and it is the caller's array either way.
 */
export type EnergyActor = {
  /** Stable identity. What `tickLevel` reports back in its parked set. */
  readonly id: string;

  /**
   * THE ACT CLOCK. At >= ENERGY_TO_ACT the actor may act. Speed-dependent.
   * May exceed ENERGY_TO_ACT: the guard at the grant site is checked BEFORE
   * adding, so a fast actor overshoots and carries the remainder forward
   * (GameEnergyBased.lua:124-126).
   */
  energy: number;

  /**
   * THE BASE CLOCK. At >= ENERGY_TO_ACT the actor's once-per-game-turn pass
   * runs. NEVER multiplied by speed. See the header.
   */
  energyBase: number;

  /**
   * Per-actor multiplier on energy GAIN, distinct from `globalSpeed` so a
   * temporary effect and a permanent stat cannot overwrite each other
   * (GameEnergyBased.lua:125 `e.energy.mod`). 1 for everything that is not a
   * slowed projectile (tome/class/Actor.lua:7183-7194).
   *
   * NB engine/Actor.lua:50 defaults this to 0, not 1 — a genuine upstream
   * quirk that only stays harmless because :125 reads `(e.energy.mod or 1)`
   * and Lua treats 0 as truthy. We default it to 1, which is what that line
   * intended.
   */
  energyMod: number;

  /**
   * Haste. Multiplier on energy GAIN — more actions, never faster cooldowns.
   * Pinned to 1.0 for players (D1); free for monsters.
   */
  globalSpeed: number;

  /**
   * Did the most recent `act()` actually spend energy? Cleared by the loop
   * before every `act` call and set by `spendForAction`
   * (GameEnergyBased.lua:128, engine/Actor.lua:483).
   *
   * This is how the loop distinguishes a real action from a free one without
   * snapshotting energy, and it is what makes "the world did not change"
   * decidable — see the idle rule on `tickLevel`.
   */
  energyUsed: boolean;
};

export type EnergyActorInit = {
  readonly energy?: number;
  readonly energyBase?: number;
  readonly energyMod?: number;
  readonly globalSpeed?: number;
};

/**
 * A fresh scheduler state. Both clocks start at zero, so an actor added
 * mid-level takes a full game turn before its first `actBase` — which is
 * correct: it has not yet lived a turn.
 */
export function createEnergyActor(id: string, init: EnergyActorInit = {}): EnergyActor {
  return {
    id,
    energy: init.energy ?? 0,
    energyBase: init.energyBase ?? 0,
    energyMod: init.energyMod ?? 1,
    globalSpeed: Math.max(MIN_GLOBAL_SPEED, init.globalSpeed ?? 1),
    energyUsed: false,
  };
}

// ---------------------------------------------------------------------------
// The two clocks
// ---------------------------------------------------------------------------

/**
 * Both clocks, in one value, so the distinction is visible in every signature
 * that carries time.
 *
 * INVARIANT, at every sweep boundary: `gameTurn === Math.floor(tick / TICKS_PER_GAME_TURN)`.
 * Mid-tick `gameTurn` can lag by less than one turn, because it counts turns
 * that have COMPLETED — matching ToME, which advances its counter after the
 * entity loop rather than before (GameEnergyBased.lua:89-90).
 */
export type TurnClock = {
  /** Engine ticks executed. 1-based while a tick is in progress. */
  tick: number;
  /** COMPLETED game turns. What the log, cooldowns and durations count in. */
  gameTurn: number;
};

export function createTurnClock(): TurnClock {
  return { tick: 0, gameTurn: 0 };
}

/** Whole game turns elapsed at `tick`. The one place the /10 is written down. */
export function gameTurnOfTick(tick: number): number {
  return Math.floor(tick / TICKS_PER_GAME_TURN);
}

// ---------------------------------------------------------------------------
// Energy accounting — engine/Actor.lua:469-485
// ---------------------------------------------------------------------------

/**
 * What one tick is worth to this actor — GameEnergyBased.lua:125.
 *
 * `ENERGY_PER_TICK * energyMod * globalSpeed`. Note what is absent: nothing
 * here touches `energyBase`.
 */
export function energyGainPerTick(actor: EnergyActor): number {
  return ENERGY_PER_TICK * actor.energyMod * actor.globalSpeed;
}

/**
 * Grant act-energy, subject to ToME's anti-stockpiling guard — GameEnergyBased.lua:124-126.
 *
 * Energy accrues ONLY while strictly below ENERGY_TO_ACT. Port this verbatim:
 * it is why a player who idles for a minute out of combat does not bank sixty
 * turns and then teleport across the map. The guard is checked before the add,
 * so a fast actor still overshoots the threshold by up to one tick's worth and
 * carries that remainder into the next action.
 *
 * @returns how much was actually granted — 0 when the actor was already at or
 * over the threshold.
 */
export function grantEnergy(actor: EnergyActor, amount: number): number {
  if (actor.energy >= ENERGY_TO_ACT) return 0;
  actor.energy += amount;
  return amount;
}

/**
 * Grant base-energy: a FLAT ENERGY_PER_TICK, never scaled — GameEnergyBased.lua:115-117.
 *
 * Exported so that the one grant site for the speed-independent clock has a
 * name and can be grepped for. It takes no multiplier, and it must never grow
 * one.
 *
 * @returns true when the actor has now banked a full game turn and owes an
 * `actBase` pass.
 */
export function grantBaseEnergy(actor: EnergyActor): boolean {
  if (actor.energyBase < ENERGY_TO_ACT) actor.energyBase += ENERGY_PER_TICK;
  return actor.energyBase >= ENERGY_TO_ACT;
}

/**
 * Does this actor have enough energy to act? — engine/Actor.lua:472-475,
 * where it is called `enoughEnergy`.
 */
export function canAct(actor: EnergyActor, need: number = ENERGY_TO_ACT): boolean {
  return actor.energy >= need;
}

/**
 * Spend energy on an action — engine/Actor.lua:479-485 (`useEnergy`), with the
 * cost derived as at tome/class/Actor.lua:5863
 * (`useEnergy(getTalentSpeed(ab) * game.energy_to_act)`).
 *
 * `costMultiplier` is a COST scale, the opposite direction from `globalSpeed`:
 * 0.5 is a half-turn action, 2.0 costs two turns. Weapon speed, spell speed
 * and movement speed all arrive here.
 *
 *   PLAYERS PASS 1.0. ALWAYS. (D1.) A player's action costs exactly one turn;
 *   cheaper talents cost less AP, not less energy. The moment a player spends
 *   anything other than ENERGY_TO_ACT the party stops being phase-locked, the
 *   barrier starts parking at partial quorum, and the Bell — which exists to
 *   pressure the last straggler — starts firing on three people at once.
 *
 * Clamped at MIN_ACTION_COST_MULTIPLIER, and refuses a non-finite multiplier
 * outright: a NaN cost would silently make an actor unable to ever act again.
 *
 * @returns the energy actually deducted.
 */
export function spendForAction(actor: EnergyActor, costMultiplier = 1): number {
  if (!Number.isFinite(costMultiplier)) {
    throw new RangeError(`spendForAction(${actor.id}): costMultiplier must be finite`);
  }
  const cost = ENERGY_TO_ACT * Math.max(MIN_ACTION_COST_MULTIPLIER, costMultiplier);
  actor.energy -= cost;
  actor.energyUsed = true;
  return cost;
}

/**
 * Consume one banked game turn of base-energy — tome/class/Actor.lua:512
 * (`self.energyBase = self.energyBase - game.energy_to_act`).
 *
 * SUBTRACT, never zero: the remainder is what keeps an actor whose base clock
 * was topped up off-phase from drifting.
 *
 * The loop calls this itself, immediately before `ctx.actBase`, rather than
 * leaving it to the callback as ToME does. Behaviourally identical — ToME's
 * line 512 runs before every early return in `actBase` — but a caller that
 * forgets it would run `actBase` on every single tick, which is haste applied
 * to cooldowns by another route.
 */
export function consumeBaseTurn(actor: EnergyActor): void {
  actor.energyBase -= ENERGY_TO_ACT;
}

/**
 * Recompute `globalSpeed` from a base and an additive modifier —
 * tome/class/Actor.lua:3909-3914.
 *
 * Deliberately asymmetric: positive modifiers ADD, negative ones DIVIDE. So
 * +0.5 is 1.5x while -0.5 is 1/1.5 = 0.667x, and a slow can never reach zero
 * however many stack. ToME's own comment calls this "Symmetric scaling"; the
 * point is that a +N and a -N compose back to 1.
 */
export function recomputeGlobalSpeed(base: number, add: number): number {
  const speed = add >= 0 ? base + add : base / (1 + Math.abs(add));
  return Math.max(MIN_GLOBAL_SPEED, speed);
}

// ---------------------------------------------------------------------------
// tickLevel — GameEnergyBased.lua:95-142
// ---------------------------------------------------------------------------

/**
 * What an `act` callback tells the loop.
 *
 * Object + union rather than an `enum`: `erasableSyntaxOnly` is on, because
 * Node type-strips this file and runs it directly.
 */
export const ActResult = {
  /** Resolved, declined, or acted for free. The sweep moves on. */
  Done: 'done',
  /**
   * The actor STILL owes a decision after being asked to resolve one — the
   * refund rule (game-design.md § 4). Legality is checked at resolution, so an
   * intent that went illegal in between (the target died, you were knocked out
   * of range) costs zero energy, clears, and re-prompts. Returning `Park` is
   * how the loop is told to re-prompt rather than let the world move on.
   *
   * The ordinary "has not decided yet" case is `isBlocking`, not this — see
   * there for why the distinction is load-bearing.
   */
  Park: 'park',
} as const;
export type ActResult = (typeof ActResult)[keyof typeof ActResult];

export type TickLevelCtx = {
  /** Mutated in place. The caller owns it and reads it after the call. */
  readonly clock: TurnClock;

  /**
   * THE SPEED-INDEPENDENT PASS. Runs once per game turn per actor: regen,
   * status durations, cooldowns, combat-engagement decay
   * (tome/class/Actor.lua:476-608). `consumeBaseTurn` has already run.
   */
  readonly actBase: (actor: EnergyActor, clock: TurnClock) => void;

  /**
   * THE SPEED-DEPENDENT PASS. Runs whenever the actor holds ENERGY_TO_ACT and
   * is not blocking, so a hasted actor is called MORE OFTEN. Spend via
   * `spendForAction`. Returning `Done` without spending is legal and means
   * "nothing to do" — the out-of-combat case, where players sit at the
   * threshold and the loop goes idle.
   */
  readonly act: (actor: EnergyActor, clock: TurnClock) => ActResult;

  /**
   * DOES THIS ACTOR OWE A DECISION NOBODY HAS MADE YET? The co-op
   * generalisation of ToME's `game.paused` (Player.lua:409 +
   * GameEnergyBased.lua:133-137): one global flag bound to one `game.player`
   * becomes a per-actor predicate, so the pause condition is a SET rather than
   * a singleton (game-design.md § 4).
   *
   * It MUST BE SIDE-EFFECT FREE, and that is the entire reason it is separate
   * from `act`. The loop has to distinguish "this actor would park" from "this
   * actor would take its turn" WITHOUT taking that turn — otherwise it cannot
   * discover the whole blocking set in one tick, and the barrier degrades into
   * round-robin: park on player 1, wait, park on player 2, wait. Players 2-4
   * tab out and the session dies. That failure mode is the whole reason the
   * design rejected strict initiative.
   *
   * Omitted means nothing ever blocks — the monster-only and single-actor
   * cases, and every test that does not care about the barrier.
   */
  readonly isBlocking?: (actor: EnergyActor, clock: TurnClock) => boolean;

  /**
   * May this actor still take its turn while someone else is parked at the
   * barrier? Defaults to NO.
   *
   * TRUE for player-controlled actors: "commit-on-submit, resolve immediately"
   * (game-design.md § 4). A player who has committed resolves at once, in
   * arrival order, without waiting on the rest of the party.
   *
   * FALSE for everything the world drives. A monster must not take its turn
   * while a human still owes a decision — that freeze is what ToME gets for
   * free by breaking out of the tick loop on `game.paused`, and losing it
   * means the enemies move while you are still choosing.
   */
  readonly actsWhileBlocked?: (actor: EnergyActor) => boolean;

  /**
   * Skip an actor without removing it from the array — the port of
   * GameEnergyBased.lua:113's `if e and e.act and e.energy`, plus
   * engine/Actor.lua:59's dead check. A disconnected player's body stays in
   * the world and stays in this array; it simply stops being ticked, which is
   * exactly what Standing By needs.
   */
  readonly isActive?: (actor: EnergyActor) => boolean;

  /**
   * Fired once per COMPLETED game turn, at the tail of the tick that completes
   * it — GameEnergyBased.lua:89-90, 146. The level-wide signal, as distinct
   * from the per-actor `actBase`.
   */
  readonly onGameTurn?: (clock: TurnClock) => void;

  /**
   * Hard bound on ticks executed in one call. Exceeding it returns `'budget'`
   * rather than throwing, so the caller decides whether a runaway is fatal.
   * Turn resolution is synchronous: an unbounded loop here is not a dropped
   * frame, it is a server that never answers again.
   */
  readonly maxTicks?: number;
};

export type TickLevelResult = {
  /**
   * `parked` — at least one actor owes a decision. The tick FINISHED first, so
   *            `parked` is the complete blocking set for this turn — the
   *            quorum the Bell counts against. Call again when a decision
   *            lands.
   * `idle`   — the act clock has reached a fixed point: nobody can gain energy
   *            and nobody spent any. NO clocks advanced on the way out, so
   *            pumping an idle level repeatedly is free and cannot be farmed
   *            for regeneration.
   * `budget` — `maxTicks` was exhausted. State is consistent; call again.
   */
  readonly status: 'parked' | 'idle' | 'budget';
  /**
   * Everyone blocking, in array order. Empty unless `status` is `parked`.
   * THIS IS THE QUORUM: the Bell starts once everyone but the stragglers has
   * committed, and Standing By removes an actor from it.
   */
  readonly parked: readonly string[];
  /** Ticks executed by THIS call. */
  readonly ticks: number;
  /** Game turns completed by THIS call. */
  readonly gameTurns: number;
};

/** 1000 game turns in a single pump. Nothing legitimate comes close. */
const DEFAULT_MAX_TICKS = 10_000;

/**
 * Consecutive clockless passes before we call it a runaway. Legitimately this
 * is 1, or a small number when an actor with banked overflow energy spends it
 * on very cheap actions. Sixty-four in a row means a callback is manufacturing
 * energy inside `act`, which would otherwise spin forever without ever
 * touching `maxTicks`.
 */
const MAX_CONSECUTIVE_RESOLVE_PASSES = 64;

/** Shared so the common non-parked returns do not allocate. */
const EMPTY_PARKED: readonly string[] = [];

/**
 * THE TICK LOOP — ported from GameEnergyBased.lua:95-142 (`tickLevel`).
 *
 * Per tick, in ARRAY ORDER, per actor, in exactly this sequence:
 *
 *   1. base clock  — grant a flat ENERGY_PER_TICK; at ENERGY_TO_ACT run
 *                    `actBase` and subtract    (Lua :114-121, Actor.lua:512)
 *   2. act clock   — grant `energyGainPerTick`, but only while below the
 *                    threshold                                (Lua :124-126)
 *   3. act         — at or above the threshold: park if blocking, otherwise
 *                    clear `energyUsed` and call `act`        (Lua :127-130)
 *
 * Per-actor rather than phase-by-phase (all grants, then all actions) because
 * that is what the Lua does, and the difference is observable: an actor early
 * in the array acts on energy granted this tick, before an actor later in the
 * array has been granted anything.
 *
 * ===========================================================================
 * THE ONE DELIBERATE STRUCTURAL DEVIATION: THE PAUSE IS AT THE TICK BOUNDARY
 * ===========================================================================
 *
 * ToME breaks out of the sweep the instant the player parks and remembers the
 * index in `level.last_iteration` (GameEnergyBased.lua:99-107, 133-141). With
 * one human that is right. With four it is a trap, and this is the single most
 * important thing in this file after the two clocks.
 *
 * Players are phase-locked (D1), so all four cross ENERGY_TO_ACT on the same
 * tick — but IN ARRAY ORDER. Break out at the first one and player 2 is still
 * sitting at 900 energy, invisible to the barrier, and nobody even asks them
 * until player 1 has decided. The result is round-robin with extra steps: the
 * exact "player 1 deliberates for 40 seconds, players 2-4 tab out" failure the
 * design rejected strict initiative to avoid, arrived at by accident.
 *
 * So a park does NOT stop the sweep. The tick RUNS TO COMPLETION, every actor
 * that crosses the threshold on it is tested, and `parked` comes back holding
 * the whole set. That set is the quorum the Bell counts, and it is why the
 * barrier parks ONCE PER TURN AT FULL QUORUM.
 *
 * Nothing else gets to act after the first park (unless `actsWhileBlocked`),
 * so the world is just as frozen as ToME's — the difference is only that the
 * freeze begins at the end of the tick rather than the middle of it.
 *
 * That also removes the resumable cursor entirely: every return happens on a
 * sweep boundary, so `tickLevel` needs no saved index and cannot mis-resume
 * into an array that changed while a player was thinking.
 *
 * ===========================================================================
 * FULLY SYNCHRONOUS
 * ===========================================================================
 *
 * Six ESLint selectors make `await` a lint error in the engine, and this
 * function is why: the synchronicity IS the mutex. Two WebSocket frames cannot
 * interleave mid-turn because there is no suspension point to interleave at.
 * Anything that waits — a decision, a Bell timer, a disk write — belongs to
 * the CALLER, on the far side of a park.
 *
 * ===========================================================================
 * TERMINATION, WHICH IS OURS AND NOT ToME'S
 * ===========================================================================
 *
 * ToME never needs to stop: its `tick` is driven once per rendered frame. A
 * server that wakes only when something happens needs a fixed point, so a
 * sweep comes in two flavours:
 *
 *   A TICK advances both clocks. It runs iff at least one active actor is
 *   below the act threshold — iff granting energy would change anything.
 *
 *   A RESOLVE PASS advances NOTHING. It gives actors already at the threshold
 *   their `act` call: that is where a just-arrived intent executes and where
 *   the barrier discovers who is blocking.
 *
 * EVERY CALL BEGINS WITH A RESOLVE PASS, and that is not an optimisation — it
 * is what keeps the party phase-locked. The last player to commit is holding
 * exactly ENERGY_TO_ACT; if the loop ticked before resolving them they would
 * spend one tick later than everyone else, and drift another tick out of phase
 * on every turn after that.
 *
 * `idle` is a resolve pass that changed nothing, and no clock moves on the way
 * out. That last clause is load-bearing: if an idle pump advanced the base
 * clock even one notch, a client could spam pings for free regeneration.
 */
export function tickLevel(actors: readonly EnergyActor[], ctx: TickLevelCtx): TickLevelResult {
  const { clock } = ctx;
  const maxTicks = ctx.maxTicks ?? DEFAULT_MAX_TICKS;
  if (!Number.isInteger(maxTicks) || maxTicks < 1) {
    throw new RangeError(`tickLevel: maxTicks must be a positive integer, got ${String(maxTicks)}`);
  }

  const startTick = clock.tick;
  const startGameTurn = clock.gameTurn;
  const finish = (
    status: TickLevelResult['status'],
    parked: readonly string[],
  ): TickLevelResult => ({
    status,
    parked,
    ticks: clock.tick - startTick,
    gameTurns: clock.gameTurn - startGameTurn,
  });

  // The entry sweep is always a resolve pass — see TERMINATION above.
  let granting = false;
  let first = true;
  // Did anything move? Only ever describes the sweep just completed: a park
  // returns, so this never has to survive a call boundary.
  let progressed = false;
  let resolvePasses = 0;

  for (;;) {
    // ---- sweep boundary --------------------------------------------------
    if (!first) {
      granting = anyCanGainEnergy(actors, ctx.isActive);
      if (granting) {
        resolvePasses = 0;
        if (clock.tick - startTick >= maxTicks) return finish('budget', EMPTY_PARKED);
        clock.tick += 1;
      } else {
        if (!progressed) return finish('idle', EMPTY_PARKED);
        resolvePasses += 1;
        if (resolvePasses > MAX_CONSECUTIVE_RESOLVE_PASSES) {
          return finish('budget', EMPTY_PARKED);
        }
      }
      progressed = false;
    }
    first = false;

    // ---- the sweep -------------------------------------------------------
    const parked: string[] = [];
    for (const actor of actors) {
      if (ctx.isActive !== undefined && !ctx.isActive(actor)) continue;

      if (granting) {
        // ---- THE SPEED-INDEPENDENT CLOCK ---- GameEnergyBased.lua:114-121.
        // energyBase is NEVER multiplied by globalSpeed or energyMod. This is
        // the single most important line in the engine: it is why haste grants
        // more actions but never accelerates a cooldown or shortens a debuff.
        if (grantBaseEnergy(actor)) {
          consumeBaseTurn(actor);
          ctx.actBase(actor, clock);
        }

        // ---- THE SPEED-DEPENDENT CLOCK ---- GameEnergyBased.lua:124-126.
        grantEnergy(actor, energyGainPerTick(actor));
        progressed = true;
      }

      // ---- GameEnergyBased.lua:127-130 ---------------------------------
      if (!canAct(actor)) continue;

      // The barrier, tested BEFORE acting and without side effects.
      if (ctx.isBlocking?.(actor, clock) === true) {
        parked.push(actor.id);
        continue;
      }
      // Someone ahead of us is parked, so the world is frozen for everything
      // the world drives. Energy is already banked and nothing is lost — this
      // actor takes its turn in the resolve pass after the barrier lifts.
      if (parked.length > 0 && ctx.actsWhileBlocked?.(actor) !== true) continue;

      actor.energyUsed = false;
      const result = ctx.act(actor, clock);
      if (actor.energyUsed) progressed = true;
      // The refund rule: still owes a decision after resolution.
      if (result === ActResult.Park) parked.push(actor.id);
    }

    // ---- end of sweep ----------------------------------------------------
    if (granting && clock.tick % TICKS_PER_GAME_TURN === 0) {
      // GameEnergyBased.lua:89-90 — the turn counter advances after the loop.
      clock.gameTurn += 1;
      ctx.onGameTurn?.(clock);
    }
    if (parked.length > 0) return finish('parked', parked);
  }
}

/**
 * Is there any point in granting energy? False means every active actor is at
 * or over the threshold, so a tick would move the act clock nowhere.
 */
function anyCanGainEnergy(
  actors: readonly EnergyActor[],
  isActive: ((actor: EnergyActor) => boolean) | undefined,
): boolean {
  for (const actor of actors) {
    if (isActive !== undefined && !isActive(actor)) continue;
    if (actor.energy < ENERGY_TO_ACT) return true;
  }
  return false;
}
