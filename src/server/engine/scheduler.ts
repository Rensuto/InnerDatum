// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/engines/default/engine/GameEnergyBased.lua:95-147 (drive loop)
//             t-engine4 game/modules/tome/class/Actor.lua:7648-7669 (checkStillInCombat)
//             t-engine4 game/modules/tome/class/Party.lua:71 (the party is contiguous)
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" — https://te4.org/license

/**
 * `pump` — the drive loop. The one function that makes the world move.
 *
 * It advances engine ticks until either a player owes a decision (PARK), the
 * act clock reaches a fixed point (IDLE), or a bounded tick budget runs out
 * (BUDGET). It collects everything that happened into an ordered event list and
 * RETURNS it.
 *
 * ===========================================================================
 * IT SENDS NOTHING, SAVES NOTHING, AND WAITS FOR NOTHING
 * ===========================================================================
 *
 * src/server/engine/** may not import net/, persist/, ops/ or http/ (ESLint
 * enforces it), and may not contain `await` (six AST selectors enforce that).
 * So `pump` returns events and the CALLER broadcasts them; `pump` returns a
 * Bell deadline and the CALLER sets the timer; `pump` mutates the world and the
 * CALLER queues the save.
 *
 * That is not layering for its own sake. Turn resolution being synchronous IS
 * the mutex: two WebSocket frames cannot interleave mid-turn because there is
 * no suspension point to interleave at. The moment one `await` appears in this
 * call graph, a second frame can mutate the world between a legality check and
 * its effect, and the resulting desyncs depend on network timing and cannot be
 * reproduced locally. If you want a lock here, the real bug is that resolution
 * went async.
 *
 * ===========================================================================
 * THE MONSTER SWEEP IS ONE EVENT, NOT ONE EVENT PER MONSTER
 * ===========================================================================
 *
 * Every monster that acts between two player parks lands in a SINGLE `sweep`
 * event carrying an ordered `steps` array. The client paces the display of
 * those steps (~80 ms each, capped around 2.2 s, skippable); the server never
 * sleeps and never sends eight frames where one will do.
 *
 * Four players watching eight monsters each take an individually-timed,
 * individually-transmitted turn is the second-most-common way co-op turn-based
 * games die, right behind one player deliberating while the others tab out. The
 * batching is modelled here, in the event SHAPE, precisely so that the netcode
 * cannot accidentally undo it later.
 *
 * ===========================================================================
 * DETERMINISM
 * ===========================================================================
 *
 * Given (world state, RNG state, and the wall-clock values passed in), `pump`
 * produces the same events on any machine. Actor order comes from the world's
 * turn order, not from a hash table; every random draw goes through the world's
 * seeded PCG32 with a label; nothing here reads a clock.
 */

import { chebyshev, step } from '../../shared/coords.ts';
import { ActResult, tickLevel } from '../../shared/energy.ts';
import { canWalk } from '../../shared/level.ts';
import { ActorKind } from '../../shared/protocol.ts';
import { decideNpcAction } from '../ai/npc.ts';
import { hasLineOfSight } from '../world/world.ts';
import { HOLD_INTENT, IntentKind, actBase, applyDamage, isHostile, spendTurn } from './actor.ts';
import { inQuorum, isBlocking } from './barrier.ts';
import {
  DownedTick,
  ReviveRefusal,
  goDown,
  isErased,
  resetFloorParty,
  revive,
  surveyParty,
  tickDowned,
} from './downed.ts';
import { membersOf, partyIdOf } from './party.ts';
import { combatAPR } from './derived.ts';
import { DEFAULT_PROJECTILE_DAMAGE_TYPE, stepProjectile } from './projectile.ts';
import type { TileXY } from '../../shared/coords.ts';
import type { EnergyActor } from '../../shared/energy.ts';
import type { AiCtx } from '../ai/npc.ts';
import type { World } from '../world/world.ts';
import type { EngineActor, Intent, MonsterActor, PlayerActor, StatusPass } from './actor.ts';
import type { Projectile } from './projectile.ts';
import type { Barrier, BellState, PartyScope } from './barrier.ts';
import type { DownedState } from './downed.ts';
import type { EffectLogLine } from './effects.ts';
import type { PartyState } from './party.ts';

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/**
 * Hard ceiling on engine ticks in ONE `pump` call — 20 game turns.
 *
 * THE SAFETY VALVE, and it is not theoretical. In combat the loop parks within
 * ten ticks; out of combat it idles on the first sweep. The case this exists
 * for is the one where nothing can park and nothing can idle: every player
 * Standing By or disconnected while monsters still have targets. Without a
 * bound that is not a slow frame, it is a synchronous loop that never returns
 * and a server process that never answers again.
 *
 * 20 turns rather than 2 so that a legitimate long resolution is never cut
 * short, and rather than 1000 so that an AFK party does not eat two hundred
 * turns of monster attacks inside a single call before anyone is told.
 */
const DEFAULT_MAX_TICKS = 200;

/**
 * How many game turns engagement survives after the last contact.
 *
 * ToME's `checkStillInCombat` uses 50 TICKS — five game turns
 * (Actor.lua:7650, `game.turn - self.in_combat < 50`). Three here, deliberately:
 * ToME's counter exists to keep combat-only effects alive, while ours decides
 * how long every player on the level stays locked to the barrier after the last
 * monster dies. Five turns of parking at an empty room is five turns of four
 * people pressing space for no reason.
 */
const ENGAGEMENT_TURNS = 3;

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/** Why an actor spent its turn doing nothing. */
export const HoldReason = {
  /** It asked to. A player pressing hold, or a monster with nothing in reach. */
  Chosen: 'chosen',
  /** Excluded from quorum, auto-holding every turn until they act again. */
  StandingBy: 'standing_by',
  /** A standing order supplied the action. */
  StandingOrder: 'standing_order',
} as const;
export type HoldReason = (typeof HoldReason)[keyof typeof HoldReason];

/**
 * Why an intent was refused AT RESOLUTION.
 *
 * Legality is checked here, not at submission, which is what makes the refund
 * rule free: an intent that went illegal in between — the target died, you were
 * knocked out of range — costs ZERO energy, clears, and re-prompts. Without
 * that, players sit still rather than risk wasting a turn, and hesitation is
 * the disease the whole design is treating.
 */
export const Refusal = {
  NoActor: 'no_actor',
  Terrain: 'terrain',
  Occupied: 'occupied',
  NoTarget: 'no_target',
  NotHostile: 'not_hostile',
  OutOfRange: 'out_of_range',
  NoLineOfSight: 'no_los',
  /**
   * A revive named somebody who is not on the floor — already picked up, never
   * down, already Erased, or there is no survival system wired in at all.
   *
   * Distinct from `NoTarget` on purpose: `NoTarget` means "nobody is there",
   * this means "somebody is there and they do not need you". The two carry
   * opposite instructions, and reporting the wrong one in the middle of a rescue
   * is how a player learns to distrust the button.
   */
  NotDowned: 'not_downed',
  /**
   * A talent intent arrived and this build has no effect for it.
   *
   * THE RESOLUTION SEAM, and it is deliberately a refusal rather than a stub
   * that pretends to work. The wire, the validation and the intent all exist;
   * the twelve `src/server/talents/*.ts` effect files are what plug in here, and
   * until one does, a talent takes the refund path — zero energy, cleared,
   * re-prompt — which is the same path a target that died mid-turn takes. A
   * silent success would spend the turn and show the player nothing.
   */
  NoTalentEffect: 'no_talent_effect',
} as const;
export type Refusal = (typeof Refusal)[keyof typeof Refusal];

/** One monster's action inside a batched sweep. */
export type SweepStep =
  | { readonly t: 'move'; readonly id: string; readonly from: TileXY; readonly to: TileXY }
  | {
      readonly t: 'attack';
      readonly id: string;
      readonly targetId: string;
      readonly damage: number;
      readonly killed: boolean;
      /**
       * THE TARGET'S HP AND TILE THE INSTANT THIS BLOW LANDED. See
       * `GameEvent.attacked` for why both are snapshotted here rather than read
       * off the body later.
       */
      readonly hp: number;
      readonly at: TileXY;
    }
  | { readonly t: 'hold'; readonly id: string }
  | { readonly t: 'blocked'; readonly id: string; readonly reason: Refusal }
  /**
   * A TRAVELLING SHOT LEFT THE MUZZLE. `id` is the shooter, `to` the tile it is
   * aimed at (the target's tile at this instant — the orb does not re-aim).
   *
   * ═══ IT IS DROPPED AT THE WIRE, ON PURPOSE ═══
   * `sweepStepsToWire` (src/server/turn-engine.ts) maps this to NOTHING. The
   * launch is carried by the `projectiles` SNAPSHOT frame, which is the only
   * representation that survives a park, a reconnect and a resync — and a
   * one-frame event for a three-turn object would be the second source of truth
   * the client's own state rules forbid. It exists on the engine side because
   * tests, the server log and any future Record-lane prose all need to be able
   * to say WHEN the shot was fired, and because a monster's turn that produced
   * no step at all would read as a monster that did nothing.
   */
  | { readonly t: 'fired'; readonly id: string; readonly to: TileXY }
  /**
   * A status landed, expired or was saved against DURING the sweep.
   *
   * It lives inside the batch rather than beside it because pushing an ordinary
   * event would CLOSE the batch (see `createEventSink`), and a stun applied by
   * the third of eight monsters would split one sweep into three — which is the
   * exact fragmentation the batching exists to prevent.
   *
   * ═══ `id` IS THE BODY THE STATUS IS ON, NOT THE MONSTER THAT APPLIED IT ═══
   * The same is true of `downed` below. EVERY `SweepStep` carries an `id` so a
   * renderer can always ask "who is this about" without a type test, and for
   * these two the answer is the SUBJECT: the body that is now stunned, the
   * detective who is now on the floor.
   */
  | { readonly t: 'status'; readonly id: string; readonly note: EffectLogLine }
  /** A monster's blow put a player on the floor. game-design.md § 9. */
  | { readonly t: 'downed'; readonly id: string; readonly turnsLeft: number };

/**
 * Everything `pump` observed, in the order it happened.
 *
 * Deliberately NOT `ServerMsg`. These are facts about the world; turning them
 * into frames is the view layer's job and involves an FOV filter that the
 * engine must not be able to skip — the event log leaks visibility more often
 * than the tile grid does ("you hear a door open" is a position).
 */
export type GameEvent =
  | { readonly t: 'moved'; readonly id: string; readonly from: TileXY; readonly to: TileXY }
  | {
      readonly t: 'attacked';
      readonly id: string;
      readonly targetId: string;
      readonly damage: number;
      readonly killed: boolean;
      /**
       * ═══ THE TARGET'S HP THE INSTANT THIS BLOW LANDED ═══
       *
       * SNAPSHOTTED, NOT READ OFF THE BODY AFTERWARDS, and a real Case Log is
       * why. The caller translates events into frames once the pump has RETURNED,
       * so anything it reads from the world then is the state at the END of the
       * call — and a floor reset rewrites every body's hp mid-pump. The transcript
       * that produced this field read:
       *
       *     Index Wraith hits Ren.  3 damage. Ren 60/60.
       *     Ren is unfiled.
       *
       * Sixty out of sixty, and unfiled in the next line. Both numbers were true
       * at different instants, which is exactly what a log must never do.
       *
       * It also retires the older limitation the adapter documented: a victim hit
       * twice inside one sweep used to report the same final hp on both frames.
       * `maxHp` is still read from the world, because nothing in a fight changes
       * it and there is nothing to snapshot.
       */
      readonly hp: number;
      /**
       * ═══ AND THE TILE IT LANDED ON, FOR THE SAME REASON ═══
       *
       * The client flashes a marker here. A floor reset WALKS THE WHOLE PARTY TO
       * THE SPAWN CLUSTER before the caller has translated a single event, so a
       * position read afterwards paints the killing blow thirty tiles from where
       * it happened. Carrying it removes a second lie the old code told as well:
       * a victim that had left the world reported the attack at tile 0,0.
       */
      readonly at: TileXY;
    }
  | { readonly t: 'held'; readonly id: string; readonly reason: HoldReason }
  | { readonly t: 'refunded'; readonly id: string; readonly reason: Refusal }
  /**
   * The Bell ran out on a straggler; they have been forced to hold. NEVER a
   * random attack — that gets someone killed and ends friendships.
   */
  | {
      readonly t: 'auto_passed';
      readonly id: string;
      readonly consecutive: number;
      readonly standingBy: boolean;
    }
  /** THE BATCH. One per contiguous run of monster actions. See the header. */
  | { readonly t: 'sweep'; readonly gameTurn: number; readonly steps: readonly SweepStep[] }
  /** A game turn completed. ToME advances its counter after the loop, so do we. */
  | { readonly t: 'turn_ended'; readonly gameTurn: number }
  /** Level-wide combat state changed. Drives the "in combat" UI and the Bell. */
  | { readonly t: 'engagement'; readonly turns: number }
  /**
   * A STATUS CHANGED — gained, lost, negated, resisted, shrugged off by an
   * immunity, or merged into a live one (engine/effects.ts `EffectLogLine`).
   *
   * The whole line is carried rather than three flattened fields because the
   * Case Log's Record lane prints exactly this: *"Dalt saves (phys 38 vs power
   * 31, 68%) — Slowed 1 turn, not 3"* (game-design.md § 11) needs the channel,
   * the chance, the duration that landed AND the one that was asked for. Which
   * of them is a `negated` and which a `resisted` is `note.kind`'s job, and they
   * are genuinely different events (Actor.lua:7034-7037 vs :7038-7040).
   */
  | { readonly t: 'status'; readonly note: EffectLogLine }
  /**
   * A player hit 0 HP and went DOWN, not dead — game-design.md § 9. The five
   * turns start now; `turnsLeft` is what the countdown ring starts at.
   */
  | { readonly t: 'downed'; readonly id: string; readonly turnsLeft: number }
  /** Somebody reached them in time. `byId` is who spent their turn. */
  | {
      readonly t: 'revived';
      readonly id: string;
      readonly byId: string;
      readonly hp: number;
      /** Turns that were still on the clock. This is the number people shout about. */
      readonly turnsSpared: number;
    }
  /** The countdown ran out. NOT permadeath — the body is still there. */
  | { readonly t: 'erased'; readonly id: string }
  /**
   * EVERY player is Downed or Erased. The engine has already put the party back
   * on its feet at full HP (`resetFloorParty`); the CALLER re-seeds the floor's
   * monsters, walks everybody back to the spawn cluster and clears statuses.
   * See engine/downed.ts for the whole checklist, and for why M4 has no
   * permadeath at all.
   */
  | {
      readonly t: 'party_wipe';
      readonly gameTurn: number;
      readonly restored: readonly string[];
      /**
       * WHICH PARTY WENT DOWN — `PartyScope.id`, or the EMPTY STRING for the
       * un-scoped level, which is the same slot barrier.ts gives it.
       *
       * Carried because the caller's half of the reset is per-party and because
       * "did THIS party wipe again" is the only way to notice a floor reset that
       * is not working. `restored` cannot answer either question: it is empty for
       * a party that was already standing (nothing to put back on its feet) and
       * it changes as people join and leave.
       *
       * Process-local bookkeeping, exactly as engine/party.ts says. It never
       * reaches a client — src/server/turn-engine.ts translates this event into
       * one `erased` per name and drops the id.
       */
      readonly partyId: string;
      /**
       * ═══ THE LANE THIS HAPPENED IN, SO THE LOG READS IN THE RIGHT ORDER ═══
       *
       * True when the last body fell to a MONSTER'S blow, which is where a wipe
       * almost always comes from. The caller splits the event list into two lanes
       * — what a human did, then what the world did — and broadcasts the player
       * lane FIRST, so a wipe filed under the wrong lane is narrated before the
       * blow that caused it. That is not a cosmetic complaint; the transcript
       * that produced this field announced the floor reset two lines above the
       * attack that triggered it, and reading it cost an evening on the wrong bug.
       *
       * It is a FLAG rather than a `SweepStep` because a floor reset is not one
       * monster's action: it restores every body on the level at once, and a
       * renderer pacing the batch has nothing to draw for it beat by beat. The
       * event still CLOSES the open batch (see `createEventSink`) — which is
       * correct, because the monster turn's narration genuinely ends here.
       */
      readonly duringSweep: boolean;
    };

// ---------------------------------------------------------------------------
// pump
// ---------------------------------------------------------------------------

export type PumpCtx = {
  /**
   * Wall-clock milliseconds, PASSED IN. The engine may not read a clock —
   * `Date.now` is an ESLint error here and `setTimeout` does not exist. The
   * caller owns time; this module owns policy.
   */
  readonly nowMs: number;
  /**
   * The party's barrier. It lives ACROSS pumps (it holds the countdown's start
   * time and the Standing By counters), so the caller owns the instance.
   */
  readonly barrier: Barrier;
  /**
   * The status pass — `timedEffects` plus the `no_talents_cooldown` answer.
   *
   * PASSED IN, exactly like `nowMs` and `barrier`, and for the layering reason
   * rather than the purity one: building one needs the effect state, the world
   * rng AND the talent engine (Stunned locks out three talents,
   * physical.lua:495-504), and the adapter in turn-engine.ts is the only thing
   * that holds all three. `engine/effects.ts#statusPass` builds it:
   *
   * ```ts
   * statusPass: statusPass(effects, world.rng, {
   *   getActor: (id) => world.getActor(id),
   *   activatableTalents: (id) => talents.sheetOf(id)?.loadout ?? [],
   *   log: (line) => caseLog.record(line),
   * })
   * ```
   *
   * Absent → no status system, and `actBase` behaves exactly as it did at M3.
   */
  readonly statusPass?: StatusPass;
  /**
   * Take everything `EffectCtx.log` has recorded since the last call, and CLEAR
   * it. `pump` turns each line into a `status` event, in place.
   *
   * A DRAIN RATHER THAN A CALLBACK, and the reason is the batched sweep. The
   * effect system does not know whether it is running inside a monster's turn or
   * a player's, and a push from in there would close an open batch and split one
   * sweep into several (`createEventSink`). So the notes are buffered by the
   * caller and collected by `pump` at points where it knows which lane it is in:
   * after every `actBase` pass, after every player action, and — as `status`
   * SWEEP STEPS — after every monster action.
   *
   * ```ts
   * const notes: EffectLogLine[] = [];
   * const effectCtx = { log: (line) => notes.push(line), … };
   * pump(world, { …, drainStatusLog: () => notes.splice(0, notes.length) });
   * ```
   *
   * Absent → no `status` events, and nothing else changes.
   */
  readonly drainStatusLog?: () => readonly EffectLogLine[];
  /**
   * The DOWNED table (engine/downed.ts). Lives ACROSS pumps, like the barrier,
   * because a five-turn countdown outlives any single call.
   *
   * Present → a player who reaches 0 HP is DOWNED rather than dead: prone, out
   * of the quorum, still on the map, with a visible countdown; an adjacent ally
   * can spend a turn to pick them up (`IntentKind.Revive`); and a party wipe
   * puts everybody back on their feet and asks the caller to reset the floor.
   *
   * ABSENT → M3 behaviour exactly: 0 HP sets `alive = false` and the body is a
   * corpse. Every survival branch in this file is gated on this being supplied,
   * so `pump(world, { nowMs, barrier })` is unchanged to the byte.
   */
  readonly downed?: DownedState;
  /**
   * WHO IS PLAYING WITH WHOM (engine/party.ts). Lives ACROSS pumps, like the
   * barrier and the survival table, because a party outlives every turn.
   *
   * Present → THE BARRIER IS PER-PARTY. The quorum, the commit count, the Bell
   * and the wipe are each computed once per party rather than once per level,
   * so a solo player never waits on somebody they never agreed to play with —
   * which is the entire reason parties exist. Engagement stays LEVEL-WIDE: it
   * is a fact about the world, and barrier.ts's essay on it is unchanged.
   *
   * ABSENT → the pre-party game, byte for byte: one level-wide barrier and one
   * level-wide wipe, exactly as `pump(world, { nowMs, barrier })` has always
   * behaved. Every branch below is gated on it, for the same reason `downed` is.
   */
  readonly parties?: PartyState;
  /** Override the tick budget. Tests use it; production should not need to. */
  readonly maxTicks?: number;
};

/**
 * THE DISTINCT PARTIES STANDING ON THIS LEVEL, in a deterministic order.
 *
 * Derived from the world's TURN ORDER rather than from the party table's own
 * iteration order, so two servers replaying the same session sweep the parties
 * in the same sequence — the same argument `graceExpired` makes for sorting its
 * output. Party ids are minted from a counter and are process-local, so their
 * map order depends on who happened to connect first, which is a network-timing
 * input and must not reach game state.
 *
 * `[undefined]` when no party table is wired in: one scope, the whole level,
 * and every call below reads exactly as it did before parties existed.
 */
function partyScopes(
  actors: readonly EngineActor[],
  parties: PartyState | undefined,
): readonly (PartyScope | undefined)[] {
  if (parties === undefined) return [undefined];

  const scopes: PartyScope[] = [];
  const seen = new Set<string>();
  for (const actor of actors) {
    if (actor.kind !== ActorKind.Player) continue;
    const id = partyIdOf(parties, actor.id);
    if (seen.has(id)) continue;
    seen.add(id);
    scopes.push({ id, members: membersOf(parties, actor.id) });
  }
  return scopes;
}

/**
 * Party membership, with `undefined` meaning the whole level.
 *
 * A local copy of barrier.ts's private `inScope` rather than an export of it:
 * four ids and an `includes` is not a rule anybody can get wrong, and exporting
 * it would invite a second caller to start deciding membership outside the
 * barrier — which is the one thing engine/party.ts exists to prevent.
 */
function inScope(actorId: string, scope: PartyScope | undefined): boolean {
  return scope === undefined || scope.members.includes(actorId);
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * DOES THIS PARTY OWE A DECISION AT ALL? A STALLED ONE IS SKIPPED, NOT WAITED ON.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ONE PARTY MUST NEVER BE ABLE TO FREEZE ANOTHER, and real co-op found the way
 * it could: a party trapped on the floor churned the shared pump while a player
 * in a different party — with an invite still unanswered — could not get a turn
 * resolved. Parties scope the BARRIER; `pump` is LEVEL-WIDE.
 *
 * ═══ AND `pump` STAYS LEVEL-WIDE. THAT IS DELIBERATE. ═══
 * Making the pump per-party would FORK THE WORLD CLOCK, and world.ts says what
 * that costs where it declares `TurnState`: *"One level per party, ever — two
 * live levels means two clocks and an unsolvable UX problem for a Friday
 * night."* Two clocks on one floor means two answers to "what turn is it",
 * monsters ticking at two rates in the same room, and an engagement counter
 * nobody owns. SKIPPING IS ENOUGH, and skipping is all this does.
 *
 * A party with nobody in its quorum — every member Downed, Erased, disconnected
 * or Standing By — has no decision to owe. There is nobody to ring a Bell at,
 * nobody whose silence should be turned into a forced pass, and nobody whose
 * deadline the caller should arm its single wall-clock timer for.
 *
 * ═══ IT IS A STATED INVARIANT, NOT A NEW RULE, AND THAT IS THE POINT ═══
 * `inQuorum` already answers no for every one of those bodies, so `expire`
 * returns nothing for such a party today and `bell` reports a dormant countdown.
 * Writing it down HERE is what keeps it true: the day `inQuorum` widens — a
 * downed player who may still vote, a Standing By player who may still be rung —
 * this is the line that has to be reconsidered on purpose, rather than
 * discovered when one party's Bell starts firing at another party's frozen
 * screen. The callers below still ask `bell` for its SIDE EFFECT even when they
 * skip; see there for why retiring the countdown matters.
 */
function canDecide(actors: readonly EngineActor[], scope: PartyScope | undefined): boolean {
  for (const actor of actors) {
    if (inScope(actor.id, scope) && inQuorum(actor)) return true;
  }
  return false;
}

/**
 * The survival system's state FOR THE DURATION OF ONE PUMP.
 *
 * `wipes` is the whole reason this is not just `DownedState`. A floor reset
 * happens INSIDE the tick loop — the party is restored the moment the last body
 * hits the floor, so nobody watches a frozen screen — and the caller does not
 * get to re-seed the monsters until `pump` returns. Between those two moments
 * the restored party is standing in the same room as the same monsters, so a
 * second wipe within the same call is possible and would be a reset loop that
 * never returns. One per pump, and the second detection is simply ignored: the
 * party is already up, and the caller is already being told to rebuild the floor.
 *
 * ═══ THIS GUARD ONLY BOUNDS ONE CALL. THE CALLER BOUNDS THE REST. ═══
 * A set that lives for one pump cannot see a party that wipes on EVERY pump —
 * which is precisely what a floor reset that does not separate the party from
 * what killed them looks like from in here: one tidy wipe per call, forever, and
 * nothing failing anywhere. Noticing that needs state that outlives the call, so
 * it lives with the caller (`turn-engine.ts`, `WIPE_CHURN_TURNS`), which already
 * owns everything else that spans pumps.
 */
type SurvivalRun = {
  readonly state: DownedState;
  /**
   * The parties already reset inside THIS call, by `PartyScope.id` — or by the
   * empty string for the un-scoped level, which is the same slot barrier.ts
   * gives it. Per party rather than a single counter, because one party wiping
   * says nothing at all about the party fighting in the next room, and a shared
   * counter would silently swallow the second party's reset.
   */
  readonly wiped: Set<string>;
};

/**
 * One pump's worth of context, threaded to everything that resolves an action.
 *
 * Built once in `pump` and never stored: it holds the event sink for THIS call
 * and the wipe counter for THIS call, so it must not outlive the call. The
 * engine remains stateless between pumps; `world`, `ctx.barrier` and
 * `ctx.downed` are the only things that live across them, and all three are
 * owned by the caller.
 */
type Run = {
  readonly world: World;
  readonly ctx: PumpCtx;
  readonly aiCtx: AiCtx;
  readonly sink: EventSink;
  /** Null when the caller wired in no survival system. */
  readonly survival: SurvivalRun | null;
  /**
   * The barriers this pump is arbitrating — one per party, or one un-scoped
   * level when no party table was supplied.
   *
   * Computed ONCE per pump against the same frozen actor snapshot everything
   * else uses, so a party that changed mid-tick cannot split a turn in half.
   * Party commands arrive between pumps (net/gateway.ts pumps after each one),
   * which is what makes that safe.
   */
  readonly scopes: readonly (PartyScope | undefined)[];
};

export type PumpResult = {
  /**
   * `parked` — at least one player owes a decision. `parked` is the COMPLETE
   *            blocking set for this turn, because the tick ran to completion
   *            before returning. That set is the quorum the Bell counts.
   * `idle`   — fixed point: nobody can gain energy and nobody spent any. No
   *            clock advanced on the way out, so pumping an idle level is free
   *            and cannot be farmed for regeneration.
   * `budget` — the tick ceiling was hit. State is consistent; call again.
   */
  readonly status: 'parked' | 'idle' | 'budget';
  /** Everyone still owing a decision. Empty unless `status` is `parked`. */
  readonly parked: readonly string[];
  /** In order. The caller broadcasts these; the engine never sends anything. */
  readonly events: readonly GameEvent[];
  readonly ticks: number;
  readonly gameTurns: number;
  /** Completed game turns since the world began. */
  readonly gameTurn: number;
  /** Turns of engagement left. 0 means nobody blocks and the level can idle. */
  readonly engagement: number;
  /** Everything the Bell and the turn indicator need. */
  readonly bell: BellState;
};

/**
 * Advance the world until a player owes a decision, or nothing can happen.
 *
 * Call it after every accepted command, and again whenever a Bell deadline
 * returned in `bell.deadlineMs` elapses. It is cheap to call when there is
 * nothing to do — an idle pump advances no clock and allocates one array.
 */
export function pump(world: World, ctx: PumpCtx): PumpResult {
  if (!Number.isFinite(ctx.nowMs)) {
    throw new RangeError('pump: ctx.nowMs must be a finite number');
  }

  const events: GameEvent[] = [];
  const sink = createEventSink(events);

  /**
   * ONE SNAPSHOT of the actor array for the whole call — ToME's `tickLevel` is
   * a cursor over a FIXED entity array (GameEnergyBased.lua:99-107) and this is
   * the same guarantee: nothing joins or leaves the sweep halfway through it.
   * Deaths do not remove anybody; `isActive` stops ticking them and the body
   * stays in the world.
   */
  const actors = world.actorsInTurnOrder();
  const aiCtx = makeAiCtx(world, actors);

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE SAME SNAPSHOT RULE, EXTENDED TO ORBS — AND TWO NAMES, ONE ARRAY EACH.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `actors` stays exactly what it was and is what `makeAiCtx`,
   * `updateEngagement`, `applyBellExpiry`, `enrolCasualties` and `partyScopes`
   * all read: every one of them asks a question only a BODY can answer. This
   * second array — actors first, then everything in flight, in insertion order —
   * is handed to `tickLevel` and to nothing else.
   *
   * PROJECTILES GO LAST, AND THAT IS WHAT MAKES THE PHASE LOCK WORK FOR FREE.
   * `actorsInTurnOrder` puts the party first; energy.ts:647 skips every actor
   * after the first park unless `actsWhileBlocked`, which only a Player gets. So
   * by the time the sweep reaches an orb, `parked` is already non-empty and the
   * orb is skipped — it hangs in the air for exactly as long as the human takes
   * to decide, and advances when the turn resolves. That freeze is the feature,
   * not a workaround, and it needs no new mechanism.
   *
   * AN ORB FIRED DURING THIS PUMP THEREFORE STARTS MOVING ON THE NEXT ONE. That
   * is deliberate and it is what keeps us clear of the mid-sweep array mutation
   * upstream survives only with explicit index fixups (Level.lua:111-113,
   * :141-143). It also preserves the guarantee stated above `actors`: nothing
   * joins or leaves the sweep halfway through it.
   */
  const ticking: readonly EnergyActor[] = [...actors, ...world.projectilesInFlight()];

  /**
   * Everything the resolution path needs, in one object, built once per call.
   *
   * The same idiom `TalentCtx` and `EffectHookArgs` use, and for the same
   * reason: `actPlayer` / `actMonster` / `resolveIntent` / `strike` all need the
   * world, the sink, the AI's view AND the survival table, and threading four
   * more parameters through four functions is how a call site ends up passing
   * them in the wrong order. `survival` is null for a caller with no survival
   * system, and every branch below is gated on it.
   */
  const scopes = partyScopes(actors, ctx.parties);

  const run: Run = {
    world,
    ctx,
    aiCtx,
    sink,
    survival: ctx.downed === undefined ? null : { state: ctx.downed, wiped: new Set<string>() },
    scopes,
  };

  // Anything the caller applied BETWEEN pumps — a GM command, a status handed
  // out at spawn — is reported before this call's own events, so the log reads
  // in the order the world actually changed.
  drainStatus(ctx, sink, null);

  // ...and anybody who hit 0 HP outside this call. See `enrolCasualties`: this
  // is what makes the wipe reachable when the LAST body fell to something that
  // is not a monster's blow, and it runs before engagement because restoring a
  // wiped party changes who is alive and therefore who is in contact.
  enrolCasualties(actors, run);

  // Engagement first: it is the only co-op-specific clause in `isBlocking`, so
  // it has to be true BEFORE anybody is asked whether they are blocking.
  updateEngagement(world, actors, sink, false);

  // The Bell is checked ON ENTRY, ONCE PER PARTY. The caller sets a real timer
  // for the deadline this returns and re-enters when it fires; expiry is applied
  // right here, which means the whole countdown is exercised by calling pump
  // twice with two different `nowMs` values and no timers at all.
  for (const scope of scopes) applyBellExpiry(world, actors, ctx, sink, scope);

  const result = tickLevel(ticking, {
    clock: world.turn.clock,

    // engine/Actor.lua:59 — a dead actor does not act. The body stays in the
    // array either way, which is exactly what a disconnected player needs too.
    //
    // ═══ A FALLEN DETECTIVE IS STILL ON THE CLOCK, AND THAT IS THE WIDENING ═══
    // `isActive` gates the WHOLE per-actor block in `tickLevel`, including the
    // base-clock grant that drives `actBase`. So a body at 0 HP that is merely
    // `alive === false` is never ticked, and its five-turn countdown would sit
    // frozen forever — the mechanic would silently not exist, with nothing
    // failing anywhere.
    //
    // The clause is "a PLAYER who has not been Erased", not "a body with a
    // record", so that a player taken to 0 by a path that never called
    // `noteCasualty` is still ticked and therefore still ENROLLED by the base
    // pass. Keeping them active costs nothing else: they cannot act (see `act`
    // below), cannot block (barrier.ts's `inQuorum` reads `alive`), cannot be
    // targeted (`visibleEnemies` reads `alive`) and cannot be damaged
    // (`applyDamage` returns 0). An ERASED body falls out and stops being ticked
    // at all, which is what makes the erased state cheap.
    isActive: (energyActor) => {
      // ═══ THE ORB NEEDS AN EXPLICIT BRANCH OR IT IS NEVER TICKED AT ALL ═══
      // `resolveActor` answers undefined for a projectile and the line below
      // returns FALSE on undefined, so without this the orb would sit in the
      // array accruing nothing, forever, with nothing failing anywhere. A landed
      // orb falls out here, which is what makes `landed` cheap: the world has
      // already dropped it, but the snapshot this sweep is walking still holds it.
      //
      // ═══ `landed` IS THE WHOLE TEST. "STILL HAS PATH LEFT" IS NOT A CLAUSE ═══
      // An orb that has stepped onto the LAST tile of its line has no path left
      // and has not detonated: `projectDoMove` reaches ActorProject.lua:403 —
      // `if (not lx and not ly)` — only on the NEXT act, because upstream's
      // `line_function:step()` has to be called once more to answer nil. Gate on
      // the cursor as well and that act never happens: the orb hangs on its final
      // tile forever, is never removed from the world, and rejoins the ticking
      // array on every pump for the rest of the session. Termination is
      // guaranteed by the cursor anyway — every act either advances it or lands.
      const proj = world.getProjectile(energyActor.id);
      if (proj !== undefined) return !proj.landed;

      const actor = resolveActor(world, energyActor);
      if (actor === undefined) return false;
      if (actor.alive) return true;
      if (run.survival === null) return false;
      return actor.kind === ActorKind.Player && !isErased(run.survival.state, actor.id);
    },

    // The barrier, tested before acting and WITHOUT side effects, so the whole
    // blocking set is discovered within one tick instead of one park at a time.
    isBlocking: (energyActor) => {
      // EXPLICITLY FALSE FOR AN ORB, rather than false by accident through the
      // undefined path below. Nothing in flight owes anybody a decision, and
      // `inQuorum` (engine/barrier.ts) opens with `kind === ActorKind.Player`
      // anyway — so there is no field an orb could ever set to get into the
      // blocking set. Writing it down is what keeps that true the day the
      // undefined path changes shape.
      if (world.getProjectile(energyActor.id) !== undefined) return false;

      const actor = resolveActor(world, energyActor);
      return actor !== undefined && isBlocking(actor, world.turn);
    },

    // Commit-on-submit, resolve immediately: a player who has committed does
    // not wait on the rest of the party. Monsters do — the world freezes while
    // a human still owes a decision, which is what ToME gets for free by
    // breaking out of the loop on `game.paused`.
    // ...and an orb is EXPLICITLY not one of them: it is not a Player, so the
    // expression already answers false, but "the world freezes while a human
    // decides" is the phase-lock constraint itself and must not depend on an
    // undefined lookup happening to land the right way.
    actsWhileBlocked: (energyActor) =>
      world.getProjectile(energyActor.id) === undefined &&
      resolveActor(world, energyActor)?.kind === ActorKind.Player,

    /**
     * THE SPEED-INDEPENDENT PASS. Once per game turn per actor, at any speed.
     *
     * ═══════════════════════════════════════════════════════════════════════
     * THE ORDER IS REGEN → EFFECTS → COOLDOWNS → THE DOWNED COUNTDOWN
     * ═══════════════════════════════════════════════════════════════════════
     *
     * The first three are `actBase` itself (Actor.lua:525, :597, :606), and its
     * own ordering is upstream's, including the comment at :605 explaining why
     * effects come before cooldowns. The fourth is ours, and it goes LAST for
     * one concrete reason:
     *
     *   ═══ BLEEDING CAN DOWN YOU ═══
     *   physical.lua:149-151's `on_timeout` projects its damage inside
     *   `timedEffects`, which is inside the `actBase` call above. So a body that
     *   bled out this turn is ALREADY at 0 HP by the time `survivalPass` looks
     *   at it, and gets enrolled with its full five turns on the turn it
     *   actually fell. Run the countdown first and a bleed death is invisible
     *   for a whole game turn — the party is told a turn late, which in a
     *   five-turn window is a fifth of the rescue.
     *
     * The status drain sits between them so that "you are bleeding out" is
     * logged before "you are down", which is the order it happened in.
     */
    actBase: (energyActor) => {
      // AN ORB HAS NO BASE CLOCK — GameEnergyBased.lua:113-114 guards the whole
      // base-clock block on `e.actBase and e.energyBase`, so an entity without
      // them is ticked for `act` only. It regenerates nothing, carries no
      // cooldowns and holds no statuses; returning here immediately is the port.
      if (world.getProjectile(energyActor.id) !== undefined) return;

      const actor = resolveActor(world, energyActor);
      if (actor === undefined) return;
      actBase(actor, ctx.statusPass);
      drainStatus(ctx, sink, null);
      survivalPass(actor, run);
    },

    // THE SPEED-DEPENDENT PASS. A hasted monster arrives here more often, and
    // so does a fast orb — that is the whole of `projSpeed`.
    act: (energyActor) => {
      const proj = world.getProjectile(energyActor.id);
      if (proj !== undefined) return actProjectile(proj, run);

      const actor = resolveActor(world, energyActor);
      if (actor === undefined) return ActResult.Done;
      // PRONE. A downed body reaches here only because its base clock is still
      // running (see `isActive`); it does not get a turn, and returning `Done`
      // rather than `Park` is what keeps it out of the Bell's straggler set as
      // surely as `inQuorum` does.
      if (!actor.alive) return ActResult.Done;
      return actor.kind === ActorKind.Player ? actPlayer(actor, run) : actMonster(actor, run);
    },

    onGameTurn: (clock) => {
      sink.push({ t: 'turn_ended', gameTurn: clock.gameTurn });
      // The level-wide port of `checkStillInCombat` (Actor.lua:7648-7669).
      // Per-turn rather than per-pump, so decay counts turns and not commands.
      updateEngagement(world, actors, sink, true);
    },

    maxTicks: ctx.maxTicks ?? DEFAULT_MAX_TICKS,
  });

  return {
    status: result.status,
    parked: result.parked,
    events,
    ticks: result.ticks,
    gameTurns: result.gameTurns,
    gameTurn: world.turn.clock.gameTurn,
    engagement: world.turn.engagement,
    bell: soonestBell(world, actors, ctx, scopes),
  };
}

/**
 * THE BELL THE CALLER SHOULD SET ITS ONE TIMER FOR.
 *
 * With parties there are N countdowns and only one wall clock above this layer,
 * so `PumpResult.bell` reports the one that will ring FIRST. That is the honest
 * answer for a single timer: it is a WAKE-UP, and when it fires the caller
 * re-enters `pump`, which sweeps every party's `expire` — each of which checks
 * its own deadline and does nothing if that party still has time. So a later
 * party is never rung early, and it is never forgotten either, because whatever
 * pump follows the earlier ring reports the next-soonest deadline in turn.
 *
 * With no party table there is exactly one scope and this is a single
 * `barrier.bell` call, identical to what it replaced.
 */
function soonestBell(
  world: World,
  actors: readonly EngineActor[],
  ctx: PumpCtx,
  scopes: readonly (PartyScope | undefined)[],
): BellState {
  let soonest: BellState | null = null;
  for (const scope of scopes) {
    const state = ctx.barrier.bell(actors, world.turn, ctx.nowMs, scope);
    // A PARTY THAT OWES NO DECISION CONTRIBUTES NO DEADLINE — see `canDecide`.
    // The `bell` call above is still made, and the reason is its SIDE EFFECT:
    // an unarmed survey RETIRES that party's countdown. Skipping the call as
    // well would leave a row behind from before the party went down, and a solo
    // party coming back off the floor would inherit whatever was left of the
    // twenty seconds it was on when it fell — which reads as the Bell firing on
    // somebody the instant they get up.
    if (!canDecide(actors, scope)) continue;
    if (soonest === null) {
      soonest = state;
      continue;
    }
    // A running countdown always beats a dormant one — the caller needs a timer
    // for it — and between two running ones the earlier deadline wins.
    if (!state.running) continue;
    if (
      !soonest.running ||
      (state.deadlineMs !== null &&
        soonest.deadlineMs !== null &&
        state.deadlineMs < soonest.deadlineMs)
    ) {
      soonest = state;
    }
  }
  // `scopes` is never empty — `partyScopes` answers `[undefined]` for the
  // un-scoped level and a level with no players still yields one scope — but
  // the type does not say so, and inventing a state here would be a lie the
  // caller could arm a timer against.
  return soonest ?? ctx.barrier.bell(actors, world.turn, ctx.nowMs);
}

/**
 * THE sanctioned way to give an actor an intent.
 *
 * It is a function rather than `actor.pendingIntent = intent` because two
 * things must happen together and forgetting the second is invisible: the
 * intent lands, AND the barrier is told a human is present, which clears
 * Standing By and resets their auto-pass count. A second submission REPLACES
 * the first — you changed your mind, and there is no reason to make you wait
 * for a decision you have already withdrawn.
 *
 * @returns false when there is no such living actor. Callers answer the socket
 * with an error rather than pumping.
 */
export function submitIntent(
  world: World,
  barrier: Barrier,
  actorId: string,
  intent: Intent,
): boolean {
  const actor = world.getActor(actorId);
  if (actor === undefined || !actor.alive) return false;
  actor.pendingIntent = intent;
  barrier.noteCommand(actor);
  return true;
}

/**
 * A socket dropped. THE BODY STAYS IN THE WORLD.
 *
 * It is a MUD: you do not yank somebody out of a fight because their wifi
 * blinked, and a mid-fight recall would be a free escape besides. The body
 * leaves the quorum immediately (so nobody waits on a socket that is gone) and
 * auto-holds every turn until they return or the ten-minute grace expires.
 */
export function disconnectActor(
  world: World,
  barrier: Barrier,
  actorId: string,
  nowMs: number,
): boolean {
  const actor = world.getActor(actorId);
  if (actor === undefined) return false;
  barrier.disconnect(actor, nowMs);
  return true;
}

/** They came back. Rejoins the quorum and clears the auto-pass count. */
export function reconnectActor(world: World, barrier: Barrier, actorId: string): boolean {
  const actor = world.getActor(actorId);
  if (actor === undefined) return false;
  barrier.reconnect(actor);
  return true;
}

// ---------------------------------------------------------------------------
// Acting
// ---------------------------------------------------------------------------

/**
 * `tickLevel` hands its callbacks an `EnergyActor` — the minimal scheduler view
 * — so the full actor is recovered by id. One Map lookup on a table of under
 * thirty, and the alternative is a cast, which this project bans on purpose.
 */
function resolveActor(world: World, energyActor: EnergyActor): EngineActor | undefined {
  return world.getActor(energyActor.id);
}

/**
 * A player's turn.
 *
 * ARRIVAL ORDER, not array order, and it falls out rather than being arranged:
 * every accepted command pumps synchronously, so whoever's packet lands first
 * is resolved first. If two players attack the same monster on the same tick,
 * the first packet gets the kill — which is correct co-op behaviour, and the
 * loser is protected by the refund rule.
 */
function actPlayer(actor: PlayerActor, run: Run): ActResult {
  const { world, ctx, sink } = run;
  const intent = actor.pendingIntent;

  if (intent !== null) {
    // Cleared BEFORE resolution, so an illegal intent cannot be retried forever
    // by a loop that keeps finding it still pending.
    actor.pendingIntent = null;
    const outcome = resolveIntent(actor, intent, run);

    if (!outcome.ok) {
      // THE REFUND RULE: zero energy, cleared, re-prompt. `Park` is how the
      // loop is told this actor still owes a decision.
      sink.push({ t: 'refunded', id: actor.id, reason: outcome.reason });
      return ActResult.Park;
    }

    emitPlayerEffect(actor, outcome.effect, sink);
    // Statuses this action applied, then anybody it put on the floor. Both in
    // the PLAYER lane rather than the sweep, because this was a human's turn.
    drainStatus(ctx, sink, null);
    noteCasualty(outcome.effect, run, null);
    // D1: exactly ENERGY_TO_ACT, always. `spendTurn` derives that from the
    // actor's kind so no call site can get it wrong.
    spendTurn(actor);
    return ActResult.Done;
  }

  // No intent, and the loop only gets here when this actor is NOT blocking.
  if (world.turn.engagement > 0) {
    if (actor.standingBy) return autoHold(actor, HoldReason.StandingBy, sink);
    if (actor.standingOrder !== null) return autoHold(actor, HoldReason.StandingOrder, sink);
  }

  // OUT OF COMBAT, THE FIXED POINT. Nobody blocks, so everyone sits at
  // ENERGY_TO_ACT where accrual stops, nothing is spent, and `tickLevel`
  // returns `idle` — the process goes to ~0% CPU until the next command.
  // Movement drains the bank the instant it arrives, so exploration feels like
  // free grid movement while remaining the same energy engine underneath.
  return ActResult.Done;
}

/** Brace in place and spend the turn. */
function autoHold(actor: PlayerActor, reason: HoldReason, sink: EventSink): ActResult {
  sink.push({ t: 'held', id: actor.id, reason });
  spendTurn(actor);
  return ActResult.Done;
}

/**
 * A monster's turn. Everything it does lands in the batched sweep.
 *
 * The AI decides an intent and it is resolved through the SAME `resolveIntent`
 * a player's goes through, so a monster cannot walk through a wall via a code
 * path no player takes. A refused intent still costs the turn — it bumped into
 * something — which is the difference between a monster and a player: a player
 * gets refunded and re-prompted, a monster does not get to think again.
 */
function actMonster(actor: MonsterActor, run: Run): ActResult {
  const { world, ctx, aiCtx, sink } = run;
  // NOTHING TO DO COSTS NOTHING. This is the other half of the fixed point: a
  // monster that spent its turn bracing at an empty room would re-accrue and
  // brace again forever, and `pump` would never return idle.
  //
  // CONSEQUENCE, STATED PLAINLY BECAUSE IT IS EASY TO READ AS A BUG: monsters
  // do not move at all until somebody walks into an aggro radius with line of
  // sight. There is no patrolling and no wandering — a husk nine tiles down a
  // corridor stands perfectly still until you are eight. ToME has `move_wander`
  // (simple.lua:184-195) for this and it is genuinely nicer, but it costs the
  // idle fixed point: something has to spend energy for the level to keep
  // ticking, and then the server has a game loop and a home PC has a fan. When
  // wandering lands it needs its own budget — a wander pump the caller drives on
  // a slow timer, not this one.
  if (world.turn.engagement <= 0) return ActResult.Done;

  const gameTurn = world.turn.clock.gameTurn;
  const outcome = resolveIntent(actor, decideNpcAction(actor, aiCtx), run);

  if (!outcome.ok) {
    sink.sweep(gameTurn, { t: 'blocked', id: actor.id, reason: outcome.reason });
  } else {
    sink.sweep(gameTurn, sweepStepFor(actor, outcome.effect));
    // INTO THE SAME BATCH. A stun landing and a detective hitting the floor are
    // part of the monster turn the client is pacing, and pushing them as
    // ordinary events would close the batch mid-sweep — see `createEventSink`.
    drainStatus(ctx, sink, gameTurn);
    noteCasualty(outcome.effect, run, gameTurn);
  }

  // ToME-native cost: ENERGY_TO_ACT * speedFactor (Actor.lua:1353-1360, 5863).
  spendTurn(actor);
  return ActResult.Done;
}

// ---------------------------------------------------------------------------
// Resolution — one path for players and monsters alike
// ---------------------------------------------------------------------------

/** What actually happened, once an intent survived its legality check. */
type Effect =
  | { readonly kind: 'move'; readonly from: TileXY; readonly to: TileXY }
  | {
      readonly kind: 'attack';
      readonly targetId: string;
      readonly damage: number;
      readonly killed: boolean;
      /** The victim's hp and tile the instant this landed. See `GameEvent.attacked`. */
      readonly hp: number;
      readonly at: TileXY;
    }
  | { readonly kind: 'hold' }
  /**
   * A TRAVELLING SHOT WAS FIRED. Nothing has been hit yet, and may never be.
   *
   * The damage was rolled and FROZEN at this instant (see `fire`); everything
   * after this is the orb's own business on the energy clock. `to` is the tile
   * it is aimed at, which is the target's tile RIGHT NOW — it does not re-aim,
   * and that is the counterplay.
   */
  | { readonly kind: 'fired'; readonly to: TileXY; readonly projectileId: string }
  /** An ally was picked up off the floor. engine/downed.ts owns the arithmetic. */
  | {
      readonly kind: 'revive';
      readonly targetId: string;
      readonly hp: number;
      readonly turnsSpared: number;
    };

type Resolution =
  { readonly ok: true; readonly effect: Effect } | { readonly ok: false; readonly reason: Refusal };

/**
 * Apply an intent to the world, or refuse it.
 *
 * THE LEGALITY CHECK LIVES HERE, inside the loop, and that placement is the
 * whole of the refund rule. It is why an intent submitted three seconds ago
 * against a monster that has since died costs nothing.
 */
function resolveIntent(actor: EngineActor, intent: Intent, run: Run): Resolution {
  const { world } = run;
  switch (intent.kind) {
    case IntentKind.Hold:
      return { ok: true, effect: { kind: 'hold' } };

    /**
     * GET TO THEM — game-design.md § 9, engine/downed.ts.
     *
     * Every check lives in `revive`, including the reach, so that the ONE
     * definition of "reaching you" cannot drift from the one the log prints.
     * The refusals are mapped rather than passed through because the wire's
     * vocabulary is `Refusal`, and the two that matter are kept apart:
     * OUT_OF_REACH says *close in*, NOT_DOWNED says *they are fine, do something
     * else*. Both cost zero and re-prompt (the refund rule), which is what makes
     * the button safe to press in the one moment a player must not hesitate.
     */
    case IntentKind.Revive: {
      if (run.survival === null) return { ok: false, reason: Refusal.NotDowned };
      const target = world.getActor(intent.targetId);
      if (target === undefined) return { ok: false, reason: Refusal.NoTarget };

      const result = revive(run.survival.state, target, actor);
      if (!result.ok) {
        return result.reason === ReviveRefusal.OutOfReach
          ? { ok: false, reason: Refusal.OutOfRange }
          : { ok: false, reason: Refusal.NotDowned };
      }
      return {
        ok: true,
        effect: {
          kind: 'revive',
          targetId: target.id,
          hp: result.hp,
          turnsSpared: result.turnsSpared,
        },
      };
    }

    /**
     * THE TALENT SEAM. See `Refusal.NoTalentEffect`.
     *
     * The submission path is complete — src/server/turn-engine.ts checks range,
     * the `min_range` dead zone, line of sight, the cooldown and the resource
     * before this intent is ever queued — so what lands here is a LEGAL request
     * with no effect attached yet. The talent files own the other half: this
     * case grows a lookup into them and an `Effect` variant, and nothing else in
     * this function changes.
     */
    case IntentKind.Talent:
      return { ok: false, reason: Refusal.NoTalentEffect };

    case IntentKind.Attack: {
      const target = world.getActor(intent.targetId);
      if (target === undefined || !target.alive) return { ok: false, reason: Refusal.NoTarget };
      if (!isHostile(actor, target)) return { ok: false, reason: Refusal.NotHostile };
      const distance = chebyshev(actor, target);
      if (distance > actor.attackRange) return { ok: false, reason: Refusal.OutOfRange };
      // Melee needs no sight check; anything with reach does, or it shoots
      // through the wall it is standing behind.
      if (distance > 1 && !hasLineOfSight(world.level, actor, target)) {
        return { ok: false, reason: Refusal.NoLineOfSight };
      }

      /**
       * ═══════════════════════════════════════════════════════════════════════
       * THE FORK. ABSENT `projSpeed` IS THE OLD PATH, BYTE FOR BYTE.
       * ═══════════════════════════════════════════════════════════════════════
       *
       * ActorTalents.lua:988 — `if not t.proj_speed then return nil end`. That
       * one guard is the entire safety property of this feature: every attack
       * that existed before travelling orbs did still runs `strike`, at the same
       * stream position, producing the same Effect and the same events. A test
       * in test/server/scheduler.test.ts pins exactly that.
       *
       * `projSpeed` lives on `MonsterActor` only, which is why the kind test is
       * here rather than a bare field read: no player talent declares one, so
       * the fired branch is reachable from the monster lane alone.
       */
      if (actor.kind === ActorKind.Monster && actor.projSpeed !== undefined) {
        return { ok: true, effect: fire(actor, target, actor.projSpeed, world) };
      }
      return { ok: true, effect: strike(actor, target, world) };
    }

    case IntentKind.Move: {
      const from: TileXY = { x: actor.x, y: actor.y };
      const to = step(actor, intent.dir);

      // BUMP-ATTACK. Walking into a hostile IS the attack input in M2, and it
      // is what makes terrain-only pathing produce monsters that hit things
      // rather than politely route around them.
      const occupant = world.actorAt(to.x, to.y);
      if (occupant !== undefined && isHostile(actor, occupant)) {
        return { ok: true, effect: strike(actor, occupant, world) };
      }

      // `tryMove` remains the ONLY thing in the process allowed to change a
      // position, so terrain and occupancy are decided in exactly one place.
      const moved = world.tryMove(actor.id, intent.dir);
      if (!moved.ok) return { ok: false, reason: moved.reason };
      return { ok: true, effect: { kind: 'move', from, to: { x: moved.x, y: moved.y } } };
    }
  }
}

/**
 * PLACEHOLDER COMBAT. M3 replaces this with the ordered pipeline from
 * docs/tome-mechanics.md — `checkHit`, then the weapon range rolled BEFORE
 * armour, then armour/hardiness, then the crit, then the multiplier, then the
 * damage-type projector. The order there is load-bearing and none of it is
 * here; what is here is enough to make a turn have consequences.
 */
function strike(attacker: EngineActor, target: EngineActor, world: World): Effect {
  const rolled = world.rng.int('combat.bump.damage', attacker.damageMin, attacker.damageMax);
  const damage = applyDamage(target, rolled);
  // `hp` and `at` are read HERE, one line after the blow, and never again. A
  // floor reset later in the same pump rewrites the first to full and walks the
  // body to the spawn cluster — see `GameEvent.attacked`.
  return {
    kind: 'attack',
    targetId: target.id,
    damage,
    killed: !target.alive,
    hp: target.hp,
    at: { x: target.x, y: target.y },
  };
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE SAME SWING, PUT IN THE AIR INSTEAD OF ON THE BODY.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * THE DRAW IS IDENTICAL TO `strike`'S, IN EVERY RESPECT THAT MATTERS TO A
 * REPLAY: same generator, same label, same bounds, same position in the stream.
 * The only difference is that the integer is FROZEN onto the orb instead of
 * being handed to a body — which is exactly the split ToME uses, where
 * T_VOID_BLAST computes its damage at cast (misc/npcs.lua:723-747) and
 * `ActorProject.lua:353` stores that fixed number in `project.def.dam` for the
 * projectile to carry.
 *
 * THERE IS NO TO-HIT ROLL, AT FIRE OR AT IMPACT, AND THERE NEVER WILL BE. There
 * is none on this path upstream either — `projectile()` routes straight to the
 * DamageType projector with no `checkHit` anywhere — and there is none to move,
 * because `combat.ts#attackTarget` (the only `checkHit` caller) is not on the
 * scheduler's path at all. Rolling to hit at fire would make dodging cosmetic;
 * rolling at impact would be an unlabelled mid-flight draw whose position in the
 * stream depends on how many orbs are in the air. Counterplay is 100%
 * POSITIONAL, which is upstream's answer and the better one.
 *
 * Every attacker-side number is snapshotted HERE, at fire, so impact never has
 * to touch the shooter's body — see `ProjectileDamage`, and the fact that the
 * shooter may be a corpse three turns from now.
 */
function fire(
  attacker: MonsterActor,
  target: EngineActor,
  projSpeed: number,
  world: World,
): Effect {
  // THE SAME DRAW `strike` TAKES, AT THE SAME STREAM POSITION.
  const rolled = world.rng.int('combat.bump.damage', attacker.damageMin, attacker.damageMax);
  const sheet = attacker.combat;

  const proj = world.addProjectile({
    sourceId: attacker.id,
    origin: { x: attacker.x, y: attacker.y },
    // THE TARGET'S TILE, NOT THE TARGET. The line is built once, from the two
    // endpoints at this instant (ActorProject.lua:343-347), and never rebuilt.
    to: { x: target.x, y: target.y },
    projSpeed,
    // The same reach the legality check above measured with, and with the same
    // metric — see the deviation note on `blockPath` in engine/projectile.ts.
    range: attacker.attackRange,
    damage: {
      dam: rolled,
      type: sheet?.damageType ?? DEFAULT_PROJECTILE_DAMAGE_TYPE,
      apr: sheet === undefined ? 0 : combatAPR(sheet),
      increase: sheet?.increase,
      penetration: sheet?.penetration,
    },
  });

  return { kind: 'fired', to: { x: target.x, y: target.y }, projectileId: proj.id };
}

/**
 * ONE ORB'S TURN. Projectile.lua:210-230 does the flying; this does the paperwork.
 *
 * IT RETURNS `Done` UNCONDITIONALLY, and that is the one line in this file that
 * can hang the barrier if it is ever written otherwise: energy.ts:653 pushes an
 * actor into `parked` on a `Park` return and :659 returns the moment `parked` is
 * non-empty. An orb that parked would be a permanent member of a quorum nobody
 * can satisfy — four people staring at a Bell that never rings.
 */
function actProjectile(proj: Projectile, run: Run): ActResult {
  const { world, sink } = run;
  const gameTurn = world.turn.clock.gameTurn;

  const outcome = stepProjectile(proj, world);
  if (!outcome.landed) return ActResult.Done;

  // It detonated. Out of the air before anything else looks at the world.
  world.removeProjectile(proj.id);

  const impact = outcome.impact;
  // Landed on empty floor: the target died, or stepped off the tile it was
  // aimed at. THAT IS THE COUNTERPLAY and it costs the shooter its shot.
  if (impact === null) return ActResult.Done;

  /**
   * THE IMPACT IS A SWEEP STEP, NOT AN ORDINARY EVENT, and it is attributed to
   * the SHOOTER'S ID even if that body is now a corpse (tome/class/Game.lua:1713
   * does the same).
   *
   * An ordinary `push` here would CLOSE the open batch (see `createEventSink`),
   * splitting one monster turn into three because an orb happened to land in the
   * middle of it — the exact fragmentation the batching exists to prevent.
   */
  sink.sweep(gameTurn, {
    t: 'attack',
    id: proj.sourceId,
    targetId: impact.targetId,
    damage: impact.damage,
    killed: impact.killed,
    hp: impact.hp,
    at: impact.at,
  });

  /**
   * AND IT MUST GO THROUGH `noteCasualty`. This is the only place a killed
   * player becomes a `DownedRecord` IN THE LANE IT HAPPENED IN. `enrolCasualties`
   * would eventually catch the body on the NEXT pump — it is the safety net for
   * anything that falls outside the loop — but it files in the PLAYER lane, so a
   * detective killed by an orb would be narrated after the floor reset rather
   * than before it. See `GameEvent.party_wipe.duringSweep` for the evening that
   * cost.
   */
  noteCasualty(
    {
      kind: 'attack',
      targetId: impact.targetId,
      damage: impact.damage,
      killed: impact.killed,
      hp: impact.hp,
      at: impact.at,
    },
    run,
    gameTurn,
  );

  return ActResult.Done;
}

function emitPlayerEffect(actor: PlayerActor, effect: Effect, sink: EventSink): void {
  switch (effect.kind) {
    case 'move':
      sink.push({ t: 'moved', id: actor.id, from: effect.from, to: effect.to });
      return;
    case 'attack':
      sink.push({
        t: 'attacked',
        id: actor.id,
        targetId: effect.targetId,
        damage: effect.damage,
        killed: effect.killed,
        hp: effect.hp,
        at: effect.at,
      });
      return;
    case 'hold':
      sink.push({ t: 'held', id: actor.id, reason: HoldReason.Chosen });
      return;
    case 'fired':
      // UNREACHABLE TODAY, AND NOT A LIE — the same shape as `revive` in
      // `sweepStepFor` below. `projSpeed` lives on `MonsterActor` alone and no
      // player talent declares one, so a human cannot produce this effect. The
      // arm exists because both lanes share the `Effect` union.
      //
      // AND IT WOULD STILL EMIT NOTHING IF IT COULD. The launch is carried by
      // the `projectiles` snapshot frame, which is the only representation that
      // survives a park, a reconnect and a resync; an event here would be the
      // second source of truth for the same fact.
      return;
    case 'revive':
      // `id` is the person who got up, `byId` the person who spent their turn —
      // the same subject-first shape `downed` and `erased` use, so a log
      // renderer never has to remember which way round this one event reads.
      sink.push({
        t: 'revived',
        id: effect.targetId,
        byId: actor.id,
        hp: effect.hp,
        turnsSpared: effect.turnsSpared,
      });
      return;
  }
}

function sweepStepFor(actor: MonsterActor, effect: Effect): SweepStep {
  switch (effect.kind) {
    case 'move':
      return { t: 'move', id: actor.id, from: effect.from, to: effect.to };
    case 'attack':
      return {
        t: 'attack',
        id: actor.id,
        targetId: effect.targetId,
        damage: effect.damage,
        killed: effect.killed,
        hp: effect.hp,
        at: effect.at,
      };
    case 'hold':
      return { t: 'hold', id: actor.id };
    case 'fired':
      // The shot left the muzzle. Nothing has been hit — the impact arrives as
      // its own `attack` step, up to three turns later, from `actProjectile`.
      // This step is dropped at the wire on purpose; see `SweepStep.fired`.
      return { t: 'fired', id: actor.id, to: effect.to };
    case 'revive':
      // UNREACHABLE TODAY, AND NOT A LIE. `decideNpcAction` (ai/npc.ts) emits
      // Move, Attack and Hold and nothing else, so no monster can ever produce a
      // Revive intent. The arm exists because the `Effect` union is shared by
      // both lanes, and reading it as a hold is the honest answer: the monster
      // spent its turn and the client draws nothing. The day something in the
      // world can pick its own kind up, this grows its own `SweepStep`.
      return { t: 'hold', id: actor.id };
  }
}

// ---------------------------------------------------------------------------
// Statuses — the log drain
// ---------------------------------------------------------------------------

/**
 * Move everything `EffectCtx.log` has buffered into the event list, IN THE LANE
 * WE ARE CURRENTLY IN.
 *
 * `sweepTurn === null` means the player lane, where a `status` event is an
 * ordinary event and closes any open monster batch — correct, because a human
 * just took their turn. A number means we are inside a monster's turn, and the
 * note goes in as a `status` SWEEP STEP so the batch survives (see
 * `createEventSink`: any ordinary event closes it).
 *
 * Called at four points, all of them places where the lane is known: on entry to
 * `pump`, after every `actBase` pass, after every player action and after every
 * monster action. Absent hook → no allocation and no events.
 */
function drainStatus(ctx: PumpCtx, sink: EventSink, sweepTurn: number | null): void {
  const drain = ctx.drainStatusLog;
  if (drain === undefined) return;
  for (const note of drain()) {
    if (sweepTurn === null) sink.push({ t: 'status', note });
    else sink.sweep(sweepTurn, { t: 'status', id: note.actorId, note });
  }
}

// ---------------------------------------------------------------------------
// Survival — Downed, Erased, and the wipe (engine/downed.ts owns the rules)
// ---------------------------------------------------------------------------

/**
 * IS A HUMAN DRIVING THIS BODY RIGHT NOW? Connected, and not Standing By.
 *
 * THE SAME TWO FLAGS `inQuorum` READS, MINUS `alive`, AND THAT IS THE POINT.
 * `inQuorum` answers "should the party wait for this actor's decision", so it
 * excludes anyone on the floor. This answers "could this actor still do
 * something about the party's situation", which is a question a body at 0 hp
 * fails for a completely different reason — and the wipe check has to be able to
 * ask them apart. Reusing `inQuorum` here would report every downed body as
 * absent and every absent body as downed.
 *
 * BOTH FLAGS, not just `connected`: Standing By means two consecutive auto-passes
 * or a dropped socket (engine/barrier.ts), and somebody the Bell has already
 * given up on is not going to cross a room to pick a friend up.
 */
function isPresent(actor: EngineActor): boolean {
  return actor.connected && !actor.standingBy;
}

/**
 * A blow landed and somebody stopped moving. PLAYERS GO DOWN; MONSTERS DIE.
 *
 * The one place a casualty is turned into an event, called from both lanes with
 * the lane's identity, so a detective hitting the floor mid-sweep stays inside
 * the batch the client is already pacing.
 *
 * Reading `killed` off the effect rather than re-checking `alive` is deliberate:
 * `applyDamage` returns 0 against something already down (engine/actor.ts), so
 * `killed` is true exactly once per body and a second blow on the same turn
 * cannot re-enrol it or re-fire the wipe check.
 */
function noteCasualty(effect: Effect, run: Run, sweepTurn: number | null): void {
  const survival = run.survival;
  if (survival === null || effect.kind !== 'attack' || !effect.killed) return;

  const victim = run.world.getActor(effect.targetId);
  if (victim === undefined) return;

  const record = goDown(survival.state, victim, run.world.turn.clock.gameTurn);
  if (record === null) return; // a monster, or a body already on the floor

  const step = { t: 'downed', id: victim.id, turnsLeft: record.turnsLeft } as const;
  if (sweepTurn === null) run.sink.push(step);
  else run.sink.sweep(sweepTurn, step);

  // THE LANE TRAVELS WITH IT. A wipe caused by a monster's blow must narrate
  // after that blow, and the caller cannot work out which lane it belongs to
  // once the event list has been split. See `GameEvent.party_wipe.duringSweep`.
  checkWipe(run, sweepTurn);
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ON ENTRY: ENROL ANY PLAYER WHO IS AT 0 HP AND NOT YET ON THE FLOOR.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `noteCasualty` catches every body that fell to a blow inside a pump and
 * `survivalPass` catches every body that bled out inside one. This catches the
 * rest: a GM command, a talent that damages outside the loop, a save restored
 * with somebody already down — anything that set `alive = false` between calls.
 *
 * ═══ IT IS ALSO THE ONLY THING THAT CAN SEE THE LAST-SURVIVOR WIPE ═══
 * If the final conscious player falls outside a pump, NOTHING IS LEFT TO MOVE:
 * no player can act, no monster has a target, engagement decays, and `tickLevel`
 * returns `idle` on its first resolve pass without ever running an `actBase`.
 * The wipe would then never be detected and the party would sit on a frozen
 * screen forever. Surveying here, before the loop, removes that hole entirely —
 * and costs one pass over the actor array on a pump that had nothing to do.
 */
function enrolCasualties(actors: readonly EngineActor[], run: Run): void {
  const survival = run.survival;
  if (survival === null) return;

  for (const actor of actors) {
    if (actor.alive || actor.kind !== ActorKind.Player) continue;
    const record = goDown(survival.state, actor, run.world.turn.clock.gameTurn);
    if (record === null) continue;
    run.sink.push({ t: 'downed', id: actor.id, turnsLeft: record.turnsLeft });
  }

  // The player lane: nothing has swept yet on the way into a pump.
  checkWipe(run, null);
}

/**
 * THE DOWNED COUNTDOWN, one game turn of it, on the BASE clock.
 *
 * Runs at the tail of the `actBase` pass — AFTER regeneration, the status pass
 * and the cooldown pass. See the ordering note on `pump`'s `actBase` callback:
 * effects come first because BLEEDING CAN DOWN YOU, and the enrolment branch
 * below is what catches that case.
 *
 * ═══ A BODY ENROLLED ON THIS PASS DOES NOT ALSO TICK ON IT ═══
 * The early return is the whole of it, and it is the same shape as
 * ActorTemporaryEffects.lua:91 decrementing AFTER `on_timeout`: five turns has
 * to mean five turns somebody can actually cross a room in, not four and a bit.
 */
function survivalPass(actor: EngineActor, run: Run): void {
  const survival = run.survival;
  if (survival === null || actor.kind !== ActorKind.Player) return;

  if (!actor.alive) {
    // Bled out inside `timedEffects`, or fell to anything else that forgot to
    // call `noteCasualty`. Idempotent: `goDown` returns null for a body that is
    // already on the floor, so the common case costs one Map lookup.
    const fresh = goDown(survival.state, actor, run.world.turn.clock.gameTurn);
    if (fresh !== null) {
      run.sink.push({ t: 'downed', id: actor.id, turnsLeft: fresh.turnsLeft });
      // The `actBase` pass is its own lane, not a monster's turn — a body that
      // bled out did so on the clock, not under a blow.
      checkWipe(run, null);
      return;
    }
  }

  if (tickDowned(survival.state, actor) === DownedTick.Erased) {
    run.sink.push({ t: 'erased', id: actor.id });
    checkWipe(run, null);
  }
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * IS EVERYBODY DOWN? THEN THE FLOOR RESETS. NOBODY LOSES A CHARACTER.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * game-design.md § 9: *"Erased (timer expires, or party wipe) — MVP: the floor
 * resets and the party restarts it. **No permadeath, no loss.**"* Sworn
 * permadeath is M7, opt-in, and gated behind a tested GM restore drill that does
 * not exist yet. If you are here to delete a body, read engine/downed.ts's
 * header first.
 *
 * Checked the moment the last player hits the floor rather than at the turn
 * boundary, because at that moment NOTHING IS LEFT TO MOVE: no player can act,
 * no monster has a target, engagement decays, and `tickLevel` reaches its idle
 * fixed point. Waiting for a turn that will never complete would leave the party
 * staring at a frozen screen. `resetFloorParty` puts them up at full HP with both
 * clocks re-zeroed, so they land phase-locked and park together on the next turn.
 *
 * THE CALLER OWNS THE OTHER HALF — monsters, spawn tiles, statuses, the save.
 * The `party_wipe` event is the seam, exactly like the Bell deadline: the engine
 * may not reach into persist/, net/ or the level generator. That half is
 * `resetFloor` in src/server/turn-engine.ts, and it is not optional: a party
 * restored IN PLACE stands up inside the same fight that just killed it, is
 * knocked down again on the next pump, and wipes forever. Read the ordering note
 * there before changing anything here.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * A BODY NOBODY IS DRIVING DOES NOT COUNT AS A SURVIVOR
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * This is where the presence predicate is supplied, and it is the fix for a bug
 * that stranded a live player in real co-op play. A disconnected body stays in
 * the world by design (M2: a dropped socket must not yank someone out of a
 * fight), so it was counted as `Up`, the survey never reported a wipe, and the
 * player who had actually gone down went Downed -> Erased with no floor reset
 * and no way back. See engine/downed.ts's header.
 *
 * The predicate is passed IN rather than read inside `surveyParty`, because
 * presence is a fact about a socket and downed.ts must not learn what one is.
 * The scheduler already reads the two flags the barrier owns.
 */
function checkWipe(run: Run, sweepTurn: number | null): void {
  const survival = run.survival;
  if (survival === null) return;

  const present = (id: string): boolean => {
    const actor = run.world.getActor(id);
    return actor !== undefined && isPresent(actor);
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // ONE SURVEY PER PARTY, AND ONE RESET PER PARTY PER PUMP.
  // ═══════════════════════════════════════════════════════════════════════════
  //
  // YOUR PARTY WIPING RESETS THE FLOOR FOR YOUR PARTY. Surveying the whole level
  // instead would mean a solo player two rooms away — who has not been hit and
  // is not down — silently holding a floor reset off a party that is entirely on
  // the floor, which is the same shape as the ghost bug this predicate was
  // already fixed for once (see engine/downed.ts's header) and would be just as
  // invisible: nothing fails, nobody is told, and the party sits there.
  //
  // The party's own body list is what `surveyParty` and `resetFloorParty` are
  // both given, so the restoration cannot reach anybody outside it either.
  for (const scope of run.scopes) {
    const scopeId = scope?.id ?? '';
    if (survival.wiped.has(scopeId)) continue;

    const players =
      scope === undefined
        ? run.world.allActors()
        : run.world.allActors().filter((actor) => scope.members.includes(actor.id));

    const survey = surveyParty(players, survival.state, present);
    if (!survey.wiped) continue;

    survival.wiped.add(scopeId);
    run.sink.push({
      t: 'party_wipe',
      gameTurn: run.world.turn.clock.gameTurn,
      partyId: scopeId,
      duringSweep: sweepTurn !== null,
      restored: resetFloorParty(players, survival.state),
    });
  }
}

// ---------------------------------------------------------------------------
// The Bell
// ---------------------------------------------------------------------------

/**
 * Apply an elapsed countdown, if one has elapsed.
 *
 * On expiry the straggler is forced to HOLD — brace, gain defence. NEVER a
 * random attack: an auto-attack picks a target the player did not, pulls
 * something they were avoiding, and gets somebody killed. That ends friendships
 * and it ends sessions.
 */
function applyBellExpiry(
  world: World,
  actors: readonly EngineActor[],
  ctx: PumpCtx,
  sink: EventSink,
  scope: PartyScope | undefined,
): void {
  // A PARTY THAT OWES NO DECISION IS SKIPPED, NOT WAITED ON — see `canDecide`.
  // `bell` is still asked, for the side effect `soonestBell` documents: it is
  // what retires a countdown that was running when the last member went down.
  if (!canDecide(actors, scope)) {
    ctx.barrier.bell(actors, world.turn, ctx.nowMs, scope);
    return;
  }

  for (const pass of ctx.barrier.expire(actors, world.turn, ctx.nowMs, scope)) {
    const actor = world.getActor(pass.id);
    if (actor === undefined) continue;
    actor.pendingIntent = HOLD_INTENT;
    sink.push({
      t: 'auto_passed',
      id: pass.id,
      consecutive: pass.consecutive,
      standingBy: pass.standingBy,
    });
  }
}

// ---------------------------------------------------------------------------
// Engagement — the level-wide port of checkStillInCombat
// ---------------------------------------------------------------------------

/**
 * Recompute whether the level is in combat.
 *
 * LEVEL-WIDE, not per-actor, and that is the one deliberate change from ToME
 * (where `in_combat` is a per-actor field, Actor.lua:7637-7669). Per-player
 * engagement would let somebody thirty tiles away walk fifty free tiles while a
 * friend tanks; level-wide costs nothing, matches the fiction — you can hear
 * the fight — and is what produces the "get over here" pressure that makes
 * co-op work. The explorer is dragged into lockstep by it and still never has
 * to click, because a standing order supplies their action.
 *
 * @param decay only at a game-turn boundary. Contact refreshes on every call so
 * that a monster stepping into view arms the barrier before anybody is asked
 * whether they are blocking; the countdown down from it must only ever advance
 * once per turn, or a chatty client could talk the party out of combat.
 */
function updateEngagement(
  world: World,
  actors: readonly EngineActor[],
  sink: EventSink,
  decay: boolean,
): void {
  const before = world.turn.engagement;

  if (anyContact(world, actors)) {
    world.turn.engagement = ENGAGEMENT_TURNS;
  } else if (decay && world.turn.engagement > 0) {
    world.turn.engagement -= 1;
  }

  if (world.turn.engagement !== before) {
    sink.push({ t: 'engagement', turns: world.turn.engagement });
  }
}

/** Is any hostile pair currently in view of each other? */
function anyContact(world: World, actors: readonly EngineActor[]): boolean {
  for (const monster of actors) {
    if (monster.kind !== ActorKind.Monster || !monster.alive) continue;
    for (const player of actors) {
      if (player.kind !== ActorKind.Player || !player.alive) continue;
      if (chebyshev(monster, player) > monster.ai.aggroRange) continue;
      if (hasLineOfSight(world.level, monster, player)) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// The AI's view of the world
// ---------------------------------------------------------------------------

function makeAiCtx(world: World, actors: readonly EngineActor[]): AiCtx {
  return {
    // TERRAIN ONLY — see the note in ai/npc.ts. Handing A* an actor-aware
    // predicate is how you get monsters that never land a blow.
    isPassable: (x, y) => canWalk(world.level, x, y),
    actorAt: (x, y) => world.actorAt(x, y),
    visibleEnemies: (self) => visibleEnemies(self, world, actors),
    rng: world.rng,
  };
}

/**
 * Hostiles a monster can see, NEAREST FIRST with ties broken by id.
 *
 * The id tie-break is not cosmetic: two players equidistant from a monster is
 * the commonest possible board state, and without a total order the target
 * would depend on iteration order and a replay could diverge into a different
 * fight.
 *
 * FOV SEAM (M3): this becomes a shadowcast lookup. Aggro range plus a Bresenham
 * sight line is the M2 stand-in, and it lives here rather than in ai/npc.ts so
 * that upgrading it touches one function.
 */
function visibleEnemies(
  self: MonsterActor,
  world: World,
  actors: readonly EngineActor[],
): readonly EngineActor[] {
  const seen: { readonly actor: EngineActor; readonly distance: number }[] = [];

  for (const other of actors) {
    if (!other.alive || !isHostile(self, other)) continue;
    const distance = chebyshev(self, other);
    if (distance > self.ai.aggroRange) continue;
    if (!hasLineOfSight(world.level, self, other)) continue;
    seen.push({ actor: other, distance });
  }

  seen.sort((a, b) => {
    if (a.distance !== b.distance) return a.distance - b.distance;
    return a.actor.id < b.actor.id ? -1 : 1;
  });
  return seen.map((entry) => entry.actor);
}

// ---------------------------------------------------------------------------
// The event sink — where the sweep gets batched
// ---------------------------------------------------------------------------

type EventSink = {
  /** Append an ordinary event. CLOSES any open monster sweep first. */
  push(event: GameEvent): void;
  /** Append a monster action, opening a new batch if none is open. */
  sweep(gameTurn: number, step: SweepStep): void;
};

/**
 * Batches contiguous monster actions into one `sweep` event.
 *
 * The rule is one line and it is why ordering survives: ANY non-monster event
 * closes the open batch. So a batch is exactly "the run of monster actions
 * between two other things", the event list stays in true chronological order,
 * and in the normal case — every player parked, then the monsters go — that run
 * is the entire sweep, delivered as a single event exactly as the milestone
 * requires.
 *
 * The mutable `steps` array is held privately and published into the event as a
 * `readonly SweepStep[]`, so consumers cannot append to a batch that the sink
 * still considers open.
 */
function createEventSink(events: GameEvent[]): EventSink {
  let open: SweepStep[] | null = null;

  const openSweep = (gameTurn: number): SweepStep[] => {
    const steps: SweepStep[] = [];
    events.push({ t: 'sweep', gameTurn, steps });
    open = steps;
    return steps;
  };

  return {
    push: (event: GameEvent): void => {
      open = null;
      events.push(event);
    },
    sweep: (gameTurn: number, step: SweepStep): void => {
      const steps = open ?? openSweep(gameTurn);
      steps.push(step);
    },
  };
}
