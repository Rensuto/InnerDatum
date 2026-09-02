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

import { chebyshev, dirFromVector, step } from '../../shared/coords.ts';
import { ActResult, tickLevel } from '../../shared/energy.ts';
import { canWalk } from '../../shared/level.ts';
// THE ONLY NEW IMPORT PROGRESSION NEEDS, AND IT IS FROM src/shared/ (CLAUDE.md
// § 5: engine/** may not reach net/, persist/, ops/ or http/). progression.ts is
// pure arithmetic over three numbers — no state, no dice, no clock — so it is
// safe here for exactly the reasons scale.ts and energy.ts are.
import {
  gainExp,
  categoryPointsForLevel,
  genericPointsForLevel,
  pointsForLevel,
  statPointsForLevel,
  worthExp,
} from '../../shared/progression.ts';
import { ActorKind } from '../../shared/protocol.ts';
import { raiseAlarm } from '../ai/alarm.ts';
import { decideNpcAction } from '../ai/npc.ts';
import type { MonsterCast } from '../ai/npc.ts';
import { hasLineOfSight } from '../../shared/sight.ts';
import {
  HOLD_INTENT,
  IntentKind,
  actBase,
  areEnemies,
  isHostile,
  isMonster,
  spendTurn,
} from './actor.ts';
import { AttackRefusal, attackTarget, canAttack } from './combat.ts';
import { TalentRefusal } from './talents.ts';
import { inQuorum, isBlocking } from './barrier.ts';
import {
  DownedTick,
  ReviveRefusal,
  goDown,
  isDowned,
  isErased,
  resetFloorParty,
  revive,
  surveyParty,
  tickDowned,
} from './downed.ts';
import { membersOf, partyIdOf } from './party.ts';
import { combatAPR } from './derived.ts';
import { DEFAULT_PROJECTILE_DAMAGE_TYPE, stepProjectile } from './projectile.ts';
import type { Dir, TileXY } from '../../shared/coords.ts';
import type { EnergyActor } from '../../shared/energy.ts';
import type { TalentShape } from '../../shared/protocol.ts';
import type { AiCtx } from '../ai/npc.ts';
import type { World } from '../world/world.ts';
import type { EngineActor, Intent, MonsterActor, PlayerActor, StatusPass } from './actor.ts';
import type { StatusApply, StatusHit } from './effects.ts';
import type { DamageType } from '../../shared/damagetype.ts';
import type { ActorMove, GuardCounter, TalentHit } from './talents.ts';
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

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * HOW LONG AN OPEN ROUND WAITS BEFORE CLOSING ITSELF. See `applyRoundTails`.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * DELIBERATELY BESIDE THE BELL so nobody tunes one without seeing the other,
 * and they answer opposite questions. The Bell asks *"is this player still
 * here?"* and runs for twenty seconds, because being wrong means benching
 * somebody who was reading their screen. The Tail asks *"is this player still
 * DECIDING?"* — they have already acted this round, so they are demonstrably at
 * the keyboard — and six seconds is long enough for a second choice and short
 * enough that the table does not notice somebody forgot to press space.
 *
 * SIX IS A GUESS AND IT IS SUPPOSED TO BE CHECKED. The honest measurement is
 * the ratio of self-closed rounds to committed ones in a real session: if the
 * game is closing more rounds than players are, the number is wrong, not the
 * players.
 */
const ROUND_TAIL_MS = 6_000;

/**
 * The most actions one round may ever contain.
 *
 * AP is the real limiter — the cheapest talent is 2 of a 6-AP round — and this
 * should never bind. It exists because a bug in the budget that let a round run
 * forever would freeze the floor for everybody standing on it, and a constant is
 * a cheaper guarantee than a proof.
 */
const MAX_ACTIONS_PER_ROUND = 3;

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
  /**
   * INSIDE THE DEAD ZONE — nearer than the attacker's `combat.minRange`.
   *
   * The Inspector cannot shoot what is standing on her (game-design.md § 2,
   * "the single most important number here"), and this is what says so. NEVER
   * folded into `OutOfRange`: the two carry OPPOSITE instructions — one says
   * close in, the other says back away — and a player told "out of range" while
   * standing on the target concludes the class is broken. combat.ts:52 requires
   * the refusal be distinguishable so the log can say "too close".
   *
   * The string matches `ErrorCode.TooClose` (protocol.ts:1500) deliberately: a
   * refusal reaches the client as a BARE STRING (turn-engine.ts:1418 ->
   * gateway.ts:573), so nothing downstream needed changing to understand it.
   */
  TooClose: 'too_close',
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
      /** Did it connect? See `GameEvent.attacked.hit` — a miss is not a refusal. */
      readonly hit: boolean;
      readonly crit: boolean;
      /** What kind of damage. See `Blow.type`. */
      readonly type?: DamageType;
      /** The three numbers the Record lane prints. See `GameEvent.attacked`. */
      readonly atk?: number;
      readonly def?: number;
      readonly chance?: number;
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
   * ═══════════════════════════════════════════════════════════════════════════
   * A CREATURE CAST SOMETHING. The exact twin of `GameEvent.talent_used`.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * This arm used to be a `hold` — `sweepStepFor` mapped a monster's talent to
   * "it stood there", under a comment reading UNREACHABLE TODAY, because when it
   * was written no monster could produce a Talent intent. That stopped being
   * true the day the bestiary got talents of its own, and the note said as much:
   * *the day a monster casts, this grows a `SweepStep` of its own.*
   *
   * ═══ FIELD FOR FIELD WITH THE PLAYER LANE, WHICH IS THE WHOLE DESIGN ═══
   * Both map to the SAME `{ k: 'talent' }` wire event, so the client needs not
   * one line to draw a monster's cast and no protocol version moves. A wraith
   * taking hold and a Watchman shoving are the same kind of thing happening, and
   * the moment the two lanes describe them differently they start disagreeing
   * about which one the renderer should trust.
   *
   * ═══ AND ITS DAMAGE FOLLOWS AS ORDINARY `attack` STEPS ═══
   * One stamp, then one step per victim, in resolution order — the rule
   * `GameEvent.talent_used` states at length, for the same reason: an AoE is not
   * a special case of damage, it is a stamp followed by the same damage events
   * as everything else. Folding a victim list in here would be a second
   * implementation of "a body took damage", and two of those always end up
   * disagreeing about whether something died.
   */
  | {
      readonly t: 'talent';
      /** THE CASTER. */
      readonly id: string;
      readonly talentId: string;
      /** Where it landed. The caster's own tile for a `self` shape, never a sentinel. */
      readonly at: TileXY;
      readonly shape: TalentShape;
      /** Arms for `cross`, radius for `ball`, 0 otherwise. */
      readonly radius: number;
      /** Set when the talent named an ACTOR rather than a bare tile. */
      readonly targetId?: string;
      /** The talent's own sentences. See `TalentLanding.notes`. */
      readonly notes?: readonly string[];
    }
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
  | {
      readonly t: 'downed';
      readonly id: string;
      readonly turnsLeft: number;
      /**
       * WHO PUT THEM THERE. The `killerId` `noteCasualty` was already handed —
       * see `Effect`'s own note on why that is ONE id and not a list.
       *
       * ═══ IT TRAVELS BECAUSE THE LOG AND THE DEATH SCREEN BOTH NEED IT ═══
       * "You are erased" without a cause is the one sentence in the game a
       * player is guaranteed to read carefully and guaranteed to learn nothing
       * from. The blow that did it is on the line above in the Case Log, but a
       * player who has just gone down is looking at the middle of the screen and
       * not at the transcript.
       *
       * OPTIONAL, because a body can reach 0 with nobody to blame — bleeding out
       * from an effect whose source is gone, or a floor reset. Absent means "no
       * one thing did this", which is the honest answer and reads differently
       * from a name.
       */
      readonly byId?: string;
    }
  /**
   * A BODY THAT DIED MID-SWEEP LEFT SOMETHING ON THE FLOOR.
   *
   * Inside the batch for the reason every other step is: an ordinary event would
   * CLOSE the open sweep (`createEventSink`), and a husk that dies to a guard
   * counter halfway through a monster turn would split one sweep into three. Its
   * player-lane twin is `GameEvent.spilled`; the two carry identical payloads.
   *
   * `id` is the BODY, matching `downed` and `status` above: every `SweepStep`
   * carries an `id` so a renderer can ask "who is this about" without a type
   * test, and here the answer is the corpse.
   */
  | {
      readonly t: 'spill';
      readonly id: string;
      readonly at: TileXY;
      readonly itemIds: readonly string[];
    };

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
      /**
       * ═══ DID IT CONNECT? A MISS IS AN OUTCOME, NOT AN ABSENCE ═══
       *
       * `combat.ts:157` is explicit — "Never a miss — a miss is `ok: true, hit:
       * false`" — and protocol.ts:1543-1545 says a miss produces no damage event
       * "and would otherwise be invisible": a monster that steps up and does
       * nothing reads as a bug rather than as a dodge. So the swing is reported
       * either way, and `hitToWire` (turn-engine.ts) emits the `attack` frame
       * ALONE when this is false — no `damage`, no `death`.
       *
       * A REFUSAL IS A DIFFERENT THING AND STAYS DIFFERENT: it produces no
       * `attacked` event at all, costs zero energy and re-prompts.
       */
      readonly hit: boolean;
      readonly crit: boolean;
      /** What kind of damage. See `Blow.type`. */
      readonly type?: DamageType;
      /**
       * THE ARITHMETIC THE CASE LOG PRINTS VERBATIM — "Hits Bent Watchman (acc
       * 41 vs def 33, 70%)" (game-design.md § 11, combat.ts:174-181). They are
       * what make a miss feel like arithmetic rather than the server being
       * unfair, and `attackTarget` computes all three for free.
       *
       * OPTIONAL because two paths genuinely have no to-hit roll to report and
       * inventing numbers for them would be the lie this field exists to
       * prevent: a travelling orb (there is no roll at fire or at impact, and
       * there never will be — see `fire`), and a talent that projects damage
       * without a weapon swing.
       */
      readonly atk?: number;
      readonly def?: number;
      readonly chance?: number;
      readonly damage: number;
      /**
       * HP PUT BACK rather than taken — see `Blow.healed`.
       *
       * It rides the SAME event as damage because the client's job is identical
       * on both (set hp to the absolute number) and because it is produced by
       * the same `TalentHit`. `hitToWire` is where the two part company: a
       * healing blow emits no `attack` frame at all, so nothing draws a swing.
       */
      readonly healed?: number;
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
  /**
   * A TALENT WENT OFF. THE STAMP, AND NOTHING ELSE.
   *
   * It carries no damage and no hit flag on purpose, because protocol.ts:
   * 1582-1592 requires exactly this shape: a talent that hurts three things
   * emits ONE of these and then one `attacked` per victim, in resolution order,
   * exactly as a weapon swing does. That is what keeps the client's
   * `applyTurnEvent` a single function — an AoE is not a special case of
   * damage, it is one stamp followed by the same damage events as everything
   * else. Folding a victim list in here would be a second, parallel
   * implementation of "an actor took damage", and two of those always end up
   * disagreeing about whether something died.
   *
   * `shape` and `radius` ride along rather than being looked up because a
   * SPECTATOR receives this for a talent that is not in their own loadout and
   * has no table to resolve it from.
   */
  | {
      readonly t: 'talent_used';
      /** THE CASTER. */
      readonly id: string;
      readonly talentId: string;
      /** Where it landed. The caster's own tile for a `self` shape, never a sentinel. */
      readonly at: TileXY;
      readonly shape: TalentShape;
      /** Arms for `cross`, radius for `ball`, 0 otherwise. */
      readonly radius: number;
      /** Set when the talent named an ACTOR rather than a bare tile. */
      readonly targetId?: string;
      /** The talent's own sentences. See `TalentLanding.notes`. */
      readonly notes?: readonly string[];
    }
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
   * ═══════════════════════════════════════════════════════════════════════════
   * A STATUS DEALT DAMAGE — the line a bleed never had.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `attacked` carries a blow struck by somebody taking a turn, and `hitToWire`
   * derives the `damage` frame from it. A bleed strikes nobody's blow, so it
   * produced no frame and the whole transcript of a death by bleeding was one
   * sentence with no number, no hp and no cause.
   *
   * SEPARATE FROM `attacked` RATHER THAN FAKED AS ONE, because there is no
   * attacker and no swing: an `attacked` event with `hit: true` and no accuracy
   * roll would put a lie in the structure the Record lane reads back, and the
   * accuracy arithmetic it prints verbatim would have to be invented.
   *
   * Upstream needs no equivalent because it logs at the PROJECTOR — every hit
   * goes through `takeHit` and then `"%d %s"` (damage_types.lua:491-501),
   * whether it came from a sword or a wound.
   */
  | {
      readonly t: 'status_damage';
      /** The VICTIM, matching `DamageEvent.id`. */
      readonly id: string;
      /** Whoever is to blame, or null for a wound whose owner is gone. */
      readonly sourceId: string | null;
      readonly amount: number;
      readonly hp: number;
      readonly maxHp: number;
      readonly killed: boolean;
      /** What kind of damage the status dealt. See `Blow.type`. */
      readonly type?: DamageType;
      readonly crit: boolean;
    }
  /**
   * A player hit 0 HP and went DOWN, not dead — game-design.md § 9. The five
   * turns start now; `turnsLeft` is what the countdown ring starts at.
   */
  | {
      readonly t: 'downed';
      readonly id: string;
      readonly turnsLeft: number;
      /**
       * WHO PUT THEM THERE. The `killerId` `noteCasualty` was already handed —
       * see `Effect`'s own note on why that is ONE id and not a list.
       *
       * ═══ IT TRAVELS BECAUSE THE LOG AND THE DEATH SCREEN BOTH NEED IT ═══
       * "You are erased" without a cause is the one sentence in the game a
       * player is guaranteed to read carefully and guaranteed to learn nothing
       * from. The blow that did it is on the line above in the Case Log, but a
       * player who has just gone down is looking at the middle of the screen and
       * not at the transcript.
       *
       * OPTIONAL, because a body can reach 0 with nobody to blame — bleeding out
       * from an effect whose source is gone, or a floor reset. Absent means "no
       * one thing did this", which is the honest answer and reads differently
       * from a name.
       */
      readonly byId?: string;
    }
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * A BODY SPILLED ITS GEAR ONTO THE TILE IT DIED ON.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Raised once per corpse, immediately after the kill is recognised, and never
   * for a body that was carrying nothing. `at` is the tile — snapshotted, for
   * exactly the reason `attacked.at` is snapshotted one screen up: a floor reset
   * walks bodies before the caller has translated a single event, and a position
   * read afterwards points somewhere else entirely.
   *
   * `itemIds` are CATALOGUE ids (content/items.ts), in the order they were laid
   * down, which is the order they will be picked up in. It is deliberately not
   * the ground-item ids the world minted: those are the world's own handles, they
   * change on every re-seed, and nothing outside the world may hold one and
   * expect it to still resolve.
   *
   * ═══ IT REACHES NO CLIENT IN THIS BUILD, AND THAT IS NOT AN OVERSIGHT ═══
   * `toWireEvents` (src/server/turn-engine.ts) maps this to NOTHING, exactly like
   * `SweepStep.fired`. The floor is a SNAPSHOT frame's job — complete and
   * absolute, so a client that dropped one patch is corrected by the next rather
   * than showing a phantom coat forever — and that frame arrives with the wire
   * item, which owns the protocol bump. A one-shot event would be the second
   * source of truth for the same fact, which the client's own state rules forbid.
   *
   * It exists on the engine side because the server log, the Case Log's Record
   * lane and every test in test/server/loot.test.ts need to be able to say WHEN
   * something hit the floor and WHAT — and because a kill that silently produced
   * an item is indistinguishable from a kill that produced none.
   */
  | {
      readonly t: 'spilled';
      readonly id: string;
      readonly at: TileXY;
      readonly itemIds: readonly string[];
    }
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
// The talent resolution seam
// ---------------------------------------------------------------------------

/**
 * WHERE A TALENT ACTUALLY HAPPENED. Everything the scheduler needs to turn one
 * resolved activation into events.
 *
 * `hits` is `engine/talents.ts`'s own `TalentHit[]`, unchanged, because the one
 * definition of "what a talent did to somebody" is that type. The scheduler
 * snapshots each victim's hp and tile the instant this returns — see `Effect`.
 */
export type TalentLanding = {
  /** Namespaced `talent:<id>` — the registry key, which IS the wire id. */
  readonly talentId: string;
  /** The centre of the stamp. The caster's own tile for a `self` shape. */
  readonly at: TileXY;
  readonly shape: TalentShape;
  /** Arms for `cross`, radius for `ball`, 0 otherwise. */
  readonly radius: number;
  /** Set when the talent named an ACTOR rather than a bare tile. */
  readonly targetId?: string;
  readonly hits: readonly TalentHit[];
  /**
   * The talent's own sentences, already composed. See `TalentEvent.notes` —
   * they are the half `hits` cannot express, and until this field existed they
   * were built by every talent and read by nothing.
   */
  readonly notes?: readonly string[];
  /**
   * EVERY BODY THE CAST PUT SOMEWHERE ELSE — see `ActorMove` in
   * engine/talents.ts for the desync this exists to close.
   *
   * Carried on the LANDING rather than derived here because the scheduler
   * cannot derive it: by the time this returns the bodies are already standing
   * on their new tiles and there is nothing left to compare against. Empty for
   * the nine talents that move nobody.
   */
  readonly moved: readonly ActorMove[];
};

export type TalentResolutionResult =
  | { readonly ok: true; readonly landing: TalentLanding }
  | { readonly ok: false; readonly reason: TalentRefusal };

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE SEAM `Refusal.NoTalentEffect` HAS BEEN HOLDING OPEN SINCE M3.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * THREE NARROW CALLBACKS, NOT THE `TalentEngine` ITSELF, and the reason is the
 * dependency rule rather than taste: resolving a talent needs the REGISTRY, the
 * registry is built from `src/server/content/classes.ts`, and eslint bans
 * `engine/** -> content/**`. So the adapter that can see both (turn-engine.ts)
 * supplies these three closures, exactly as `statusPass` is supplied for exactly
 * the same reason, and this file never learns what a talent is.
 *
 * ═══ ABSENT IS BYTE-FOR-BYTE TODAY'S BEHAVIOUR ═══
 * Gated identically to `downed` and `parties`: with no seam wired in, a `talent`
 * intent takes `Refusal.NoTalentEffect` — the refund path, zero energy, cleared,
 * re-prompt — no AP is refilled, no resource regenerates, and not one draw moves
 * in the stream. `pump(world, { nowMs, barrier })` is unchanged to the byte.
 */
export type TalentResolution = {
  /**
   * Resolve one activation. `target` is a TILE and is absent for a `self` shape.
   *
   * It may REFUSE, and refusing is the point: the submission gate ran when the
   * packet arrived and this runs at resolution, so the target may have died, the
   * caster may have been shoved out of range, and the refund rule says that
   * costs exactly zero (docs/architecture.md § 2).
   */
  use(actor: EngineActor, talentId: string, target: TileXY | undefined): TalentResolutionResult;
  /**
   * ═════════════════════════════════════════════════════════════════════════
   * WHAT THIS CREATURE COULD CAST AT THAT BODY THIS TURN. Empty for most.
   * ═════════════════════════════════════════════════════════════════════════
   *
   * INJECTED FOR `use`'s REASON, ONE STEP EARLIER: answering it needs the
   * REGISTRY and a SHEET, and the layer that can see the registry, the world
   * and the world's monsters at once is `main.ts`. The AI asks; this forwards.
   *
   * IT MAY ATTACH A SHEET AS A SIDE EFFECT, and that is deliberate rather than
   * hidden. A monster gets one the first time anything asks what it can do,
   * because there is no other moment: `engine.attach` is called from the
   * player's class path and a delve populates its monsters before the engine
   * has ever heard of the realm. Attaching on demand is what makes this work
   * for every spawn path without threading the engine through content.
   *
   * OPTIONAL, so every fixture that builds a `TalentResolution` by hand keeps
   * compiling and reads as a bestiary that knows nothing.
   */
  castable?(self: MonsterActor, target: EngineActor): readonly MonsterCast[];
  /**
   * ONCE PER GAME TURN PER ACTOR, on the BASE clock — the AP/MP refill and the
   * class resource's regeneration.
   *
   * NOT OPTIONAL WHEN A SHEET EXISTS, and the failure mode is silent: sheets are
   * created FULL (talents.ts:744-747) and are only ever decremented, so a class
   * attached without this call drains AP monotonically from the first cast and
   * never refills. The Inspector's Focus — her entire class mechanic — never
   * regenerates at all.
   */
  actBase(actorId: string): void;
  /**
   * This actor changed tiles this turn. `TalentSheet.movedThisTurn`, which is
   * what Focus regen reads ("Focus builds by not moving"): before this call
   * existed the flag had no writer anywhere in src/, so the Inspector regained
   * Focus every turn whatever she did.
   */
  noteMoved(actorId: string): void;
  /**
   * THIS ACTOR JUST KILLED SOMETHING. Reagents are a stock and this is how it
   * refills.
   *
   * ═══ IT IS CALLED FROM `noteCasualty`, WHICH IS THE ONE PLACE A DEATH IS
   * RECOGNISED ═══
   * `TalentEngine.noteKill` existed and had exactly two callers, both inside
   * engine/talents.ts's own damage helpers — so a talent kill paid and the BASIC
   * WEAPON SWING paid nothing. An Alchemist starts at 8 reagents, every one of
   * her four talents costs some, and the majority of her kills come from the
   * bump swing: she drained to 0 over about eight actions and then every button
   * on her hotbar answered `no_resource` for the rest of the session, with
   * `noteStairs` unreachable because M4 has no stairs. Wiring it here fixes the
   * swing, the orb and the talent in one place, and the two calls inside
   * talents.ts were REMOVED rather than left to double-pay.
   */
  noteKill(actorId: string): void;
  /**
   * A BLOW LANDED ON THIS ACTOR. The Watchman's Resolve, which had no writer.
   *
   * engine/talents.ts documented "the scheduler calls `gainResolveOnStruck` from
   * the same place it applies damage to a player" and the function did not
   * exist. His only income was the adjacency clause — and the Inspector's
   * `minRange 3` puts her three tiles off the enemy while he is in contact,
   * which is two tiles from him and NOT adjacent — so the party formation the
   * classes were designed around paid the tank nothing, and solo paid him
   * nothing at all. Iron Curtain (25) and Lockdown (30) were unaffordable
   * forever.
   *
   * A MISS DOES NOT COUNT and neither does a 0-damage blow: see `noteBlows`.
   */
  noteStruck(actorId: string): void;
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * MAY THIS BODY'S ROUND STAY OPEN? — the intra-turn budget's one question.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * True when the actor still has something it could afford to do: a step, or a
   * talent that is off cooldown and payable on AP, MP and its class resource.
   * `engine/talents.ts#hasAffordableAction` is the answer and it is pure.
   *
   * ABSENT IS TODAY'S GAME. `roundStaysOpen` reads `=== true`, so a scheduler
   * built without a talent runtime — which is most of the test suite — closes
   * every round after one action exactly as it always has.
   */
  roundOpen(actorId: string): boolean;
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * CHARGE A STEP. `docs/game-design.md` § 6: **Move = 1 MP**.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Returns whether the body could pay. False means the round is over for them
   * — they have walked as far as the round allows — and the caller closes it.
   *
   * MP EXISTED, WAS REFILLED EVERY TURN AND WAS SPENT BY ONE TALENT. Nothing
   * charged for walking, so the whole column was decorative and so was SLOWED,
   * whose player half is `-1 MP` off a pool nothing drew on.
   *
   * ABSENT IS FREE MOVEMENT, which is the game as it shipped and what every
   * fixture without a talent runtime still gets.
   */
  spendMove(actorId: string): boolean;
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * HOW MUCH HARDER A MARKED BODY IS HIT — the Inspector's Sigil, on the swing
   * that is not a talent.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * 1 means no mark. Anything above it is folded straight into `AttackOpts.mult`
   * by `strike`, which is the ONE basic-attack site in the process and serves
   * BOTH the `Attack` intent and the move bump.
   *
   * ═══ WHY THIS EXISTS AT ALL, AND WHAT IT COST WHILE IT DID NOT ═══
   * `markMultiplier` (engine/talents.ts) has always been folded into
   * `talentAttack` and `talentProject`, so the mark was live for TALENT damage
   * and only talent damage. Its own docblock said bump attacks "will pick it up
   * when M3 wiring replaces that placeholder with `attackTarget`" — that
   * placeholder was replaced and the mark was not carried over, so Sigil's one
   * scaled number moved nothing on the party's free, at-will, most-used source
   * of damage. Sigil's panel text promises "everyone — not just you — deals
   * +N% damage to it"; before this seam that sentence was false for every
   * weapon swing in the game.
   *
   * A SEAM RATHER THAN A DIRECT CALL for the same dependency reason as the four
   * above: the multiplier is read off a talent EFFECT, and this file must not
   * learn what a talent effect is.
   */
  markMultiplier(targetId: string): number;
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * SOMETHING JUST HIT A BODY. IS ANYBODY GUARDING IT, AND DOES THE ATTACKER
   * EAT A FREE SWING FOR IT? — the Watchman's Iron Curtain.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Null when nobody was guarding, when the guardian is down, or when the
   * attacker is out of the guardian's reach. Every one of those is checked
   * behind the seam (`resolveGuardCounter`, engine/talents.ts) so the call site
   * stays one line and this file never learns the string `talent:iron_curtain`.
   *
   * ═══ THE DAMAGE IS ALREADY DONE WHEN THIS RETURNS ═══
   * The counter is not a description of a swing to be made; it IS the swing,
   * applied. The caller's job is only to narrate it and to run the ordinary
   * casualty bookkeeping over it — which is why `noteGuardCounter` re-enters
   * `noteBlows`/`noteCasualty` with the guardian as the killer rather than the
   * monster whose turn it is.
   *
   * ═══ IT WAS DEAD CODE UNTIL NOW, AND THE PANEL WAS SELLING IT ═══
   * `resolveGuardCounter` shipped with its wiring instructions in its own
   * docblock ("when M3 wiring replaces that placeholder") and ZERO production
   * call sites. Meanwhile the counter's multiplier became a per-rank curve
   * (0.7 -> 1.2) that iron_curtain.ts's `describe` advertises in the talent
   * panel's current->next diff. So one of the two things a point in Iron Curtain
   * was advertised to buy could not be observed by any means.
   */
  guardCounter(attackerId: string, victimId: string): GuardCounter | null;
};

// ---------------------------------------------------------------------------
// The loot seam
// ---------------------------------------------------------------------------

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT A CORPSE LEAVES BEHIND, IN THE ORDER IT LEAVES IT.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ONE CLOSURE, SUPPLIED BY THE ADAPTER, for the same dependency reason
 * `TalentResolution` above gives at length: this file may not import
 * `src/server/content/**` (scheduler.ts:515-527 states the rule and routes the
 * entire talent system around it), and the ORDER a body spills in is a content
 * fact — `SLOT_ORDER` lives in content/items.ts, and only the catalogue can say
 * which slot an id belongs to. So turn-engine.ts, which can see both, supplies
 * the answer and this file never learns what an item is.
 *
 * ═══ WHY ONE AND NOT THREE ═══
 * Everything else the spill needs is already legitimately in view. The tile is
 * `victim.x/y`, the list of ids is `victim.carried` and `victim.equipped`
 * (engine/actor.ts owns both), and `world.addGroundItem` is the world's, which
 * the engine may import. Adding a `drop(cell, id)` closure would be a redirection
 * with no boundary behind it, and a second closure that only re-exposes
 * `world.groundItems()` would be worse — a seam with nothing on the far side of
 * it reads like a wired one, which is precisely the failure `PumpCtx.onLevelUp`
 * shipped with once.
 *
 * ═══ ABSENT MUST MEAN BYTE-IDENTICAL BEHAVIOUR. THAT IS THE CONTRACT. ═══
 * Gated identically to `downed`, `parties`, `talents` and `statusPass`: with no
 * loot seam wired in, `noteCasualty` runs exactly the code it ran before this
 * type existed. No ground item is minted, no `spilled` event and no `spill` step
 * is raised, no field on any actor is written, and — the half that actually
 * matters — NOT ONE DRAW MOVES, because the spill takes no draws whether it runs
 * or not. `pump(world, { nowMs, barrier })` is unchanged to the byte, which is
 * what keeps the forty-odd two-argument `pump` call sites in the test suite
 * describing the same game they always described.
 */
export type LootResolution = {
  /**
   * Every item id this body leaves on the floor, in a FIXED, CONTENT-DECIDED
   * ORDER. Empty for a body carrying nothing, which is the common case.
   *
   * ═══ THE ORDER IS THE WHOLE REASON THIS IS A FUNCTION AND NOT A FIELD ═══
   * `Actor:die` sorts the inventories explicitly before it spills them
   * (class/Actor.lua:3038) and walks each one in reverse (:3040). It does that
   * because emitting drops in hash-iteration order gives two replays of one seed
   * the same items in a DIFFERENT floor order — and since a pickup takes the
   * first item on the tile (`World.itemsAt`), a different floor order is a
   * different item picked up. The bug presents as "the wrong thing got taken",
   * which is a report nobody can act on.
   *
   * The implementation must therefore never iterate a Map or an object's keys.
   * See `spillOrderOf` in src/server/turn-engine.ts for the one that ships.
   */
  spillOrder(actor: EngineActor): readonly string[];
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
   * ONE GAME TURN IS OWED TO THIS LEVEL, whether or not anybody needs energy.
   *
   * Forwarded verbatim to `TickLevelCtx.freeRuns`, which carries the whole
   * argument. Set for a SINGLE pump by `turn-engine.ts`'s `tide()`, which the
   * gateway fires from a wall-clock timer — this module still reads no clock and
   * still decides no cadence. It is handed a debt and it pays it.
   *
   * Absent is the behaviour every existing caller has: time passes on this level
   * only when somebody standing in it acts.
   */
  readonly freeRuns?: boolean;
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
   * THE DOOR, where `statusPass` is the CLOCK.
   *
   * `statusPass` ticks what is already on a body; this puts something there.
   * They arrive as two closures rather than one `EffectState` for the reason
   * `statusPass` gives — this module must not import `engine/effects.ts` — and
   * because handing the whole table to a scheduler would let the clock mint
   * effects and the door tick them.
   *
   * ═══ IT SHARES `drainStatusLog`'s BUFFER, WHICH IS THE HALF THAT SHOWS ═══
   * The adapter builds both from ONE `EffectCtx`, so a status inflicted here
   * writes its note into the same buffer `drainStatusLog` empties, and `pump`
   * turns that note into a `status` event on the sweep step of the monster that
   * caused it. That is what makes "Dalt is Bleeding 2 turn(s), not 3" appear
   * under the blow rather than floating loose at the end of the turn.
   *
   * Absent → `strike` takes the branch it has always taken. No draw, no shift.
   */
  readonly applyStatus?: StatusApply;

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * WHO A STATUS KILLED THIS PUMP. A DRAIN, exactly like `drainStatusLog`.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * A blow is buried because `noteCasualty` reads `killedBy(effect)` off the
   * ACTION OUTCOME. A bleed tick produces no outcome, so a monster bled to death
   * was never reaped: 0 hp, `alive === false`, still standing on its tile,
   * un-narrated, unpaid, and counted by anything asking whether the site is
   * clear. See `EffectCtx.noteKill` for the measurement that found it.
   *
   * A DRAIN AND NOT A CALLBACK, for the reason `drainStatusLog` gives in full: a
   * push from inside the effect system would close whatever event batch happened
   * to be open and split one sweep into several. The buffer is per-pump and is
   * spliced empty by whoever asks, so a kill cannot survive into the turn after
   * the one that caused it — which is also what makes the reap idempotent
   * without a second flag on the body.
   */
  readonly drainHits?: () => readonly StatusHit[];
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
  /**
   * THE TALENT RESOLUTION SEAM (see `TalentResolution`).
   *
   * Present → `IntentKind.Talent` resolves for real, the AP/MP budget refills on
   * the base clock and `movedThisTurn` gets its writer.
   *
   * ABSENT → M3 exactly: every talent intent is refused with
   * `Refusal.NoTalentEffect` and nothing else in this file behaves differently.
   */
  readonly talents?: TalentResolution;
  /**
   * THE LOOT SEAM (see `LootResolution`).
   *
   * Present → a monster that dies spills its decided drop onto the tile it fell
   * on, and a `spilled` / `spill` step says so.
   *
   * ABSENT → the pre-drops game, byte for byte. Nothing is minted and NO DRAW
   * MOVES — the spill is draw-free in both directions, because the roll happened
   * at spawn in content/encounter.ts and death only moves an already-decided
   * list. That is the property `test/server/loot.test.ts` pins first.
   */
  readonly loot?: LootResolution;
  /**
   * SOMEBODY REACHED A NEW LEVEL, and their points have just been handed out.
   *
   * Called from the BASE-CLOCK pass, once per level crossed, with the level that
   * was reached — so a boss that carried a character from 3 to 5 in one blow
   * calls this twice, with 4 and then 5, in order.
   *
   * ═══ WHY A CALLBACK AND NOT AN EVENT ═══
   * The level-up narrates as a Case Log RECORD LINE and nothing else. It is
   * deliberately NOT a new `TurnEvent` variant, because src/shared/version.ts
   * records that a new variant independently FORCES a protocol bump (that is
   * what took 2->3 and 4->5), and the protocol item downstream of this one keeps
   * its bump argument down to a single reason. It is not a new `GameEvent`
   * variant either: `toWireEvents` in src/server/turn-engine.ts switches
   * exhaustively over that union by lint rule, so a variant here is an edit
   * there, and the Case Log is that file's to write anyway.
   *
   * So it is the same shape as `statusPass` and `drainStatusLog` above — the
   * adapter that can see both the engine and the log supplies a closure, and
   * this file never learns what a Record line is. Absent → the level still
   * happens, the points are still granted, and nothing is narrated.
   *
   * ═══ WHO SUPPLIES IT, NAMED, BECAUSE FOR ONE BUILD NOBODY DID ═══
   * `createTurnEngine.pump` (src/server/turn-engine.ts) collects the calls into
   * `ReapingPumpResult.levelUps`, and the gateway's `broadcastRecord` turns each
   * into "Ren reaches level 5." This hook shipped once with its full argument
   * written out and ZERO producers — declared, invoked by `applyPendingLevels`,
   * and connected to nothing — so a level-up was silent on every channel the
   * party shares while the only other signal was viewer-private. A documented
   * seam with no caller reads exactly like a wired one.
   */
  readonly onLevelUp?: (actorId: string, level: number) => void;
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
  /**
   * MONSTERS THAT DIED IN THIS CALL, in the order they fell. See
   * `PumpResult.reaped` — the engine ENROLS, and the caller removes.
   */
  readonly reaped: string[];
  /**
   * BODIES MOVED BY SOMEBODY ELSE IN THIS CALL. See `PumpResult.displaced`.
   */
  readonly displaced: string[];
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
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * MONSTERS THAT DIED IN THIS CALL. THE ENGINE ENROLS; THE CALLER REMOVES.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `Actor.lua:2975` ends a death by calling `ActorLife.lua:86-94`, whose first
   * line is `if game.level:hasEntity(self) then game.level:removeEntity(self)
   * end` — a dead monster leaves the map. Ours does too, but NOT FROM IN HERE,
   * and the deviation is deliberate and recorded: upstream removes BEFORE its
   * log line because it still holds the object reference, while our Record lane
   * re-resolves every id through `world.getActor` after the pump has returned.
   * Remove inside the pump and two readers degrade silently, neither of them
   * throwing — `hitToWire` ships `maxHp: 0` and the Case Log narrates "someone
   * 0/0". So the pump names the bodies and the caller buries them, in the one
   * window between broadcasting the record and the resync.
   *
   * ═══ THE WINDOW DOES NOT COVER AN ORB IN FLIGHT, AND NEVER COULD ═══
   * This note used to claim a third reader — "an orb's impact is attributed to a
   * `sourceId` the world no longer knows" — as an argument for reaping LATE. It
   * is a real failure but a different one, and late reaping does nothing about
   * it: the window is one pump wide and the wraith's orb (`projSpeed 2` over
   * `attackRange 6`) lands two or three GAME TURNS after it was fired, in a pump
   * where the shooter is long buried. The gateway keeps a name memo for as long
   * as anything is in the air instead — `reapedNames` in net/gateway.ts.
   *
   * PLAYERS ARE NEVER ON THIS LIST. The guard is POSITIVE (`kind === Monster`),
   * never "not a player" and never `alive === false`: `world.removePlayer` IS
   * `world.removeActor` (the `removePlayer: removeActor` row in world.ts's
   * returned literal — cited by symbol because the line number drifts every
   * time anything above it grows), a DOWNED body is `alive === false`
   * by design, and engine/downed.ts:20-36 is explicit that deleting one loses
   * somebody's character.
   *
   * Each id appears exactly ONCE per body, for free: enrolment reads the
   * outcome's `killed`, which damage.ts:594-597 sets only on the blow that
   * crossed zero.
   */
  readonly reaped: readonly string[];
  /**
   * ═════════════════════════════════════════════════════════════════════════
   * WHO WAS MOVED WITHOUT ASKING TO BE — and why the caller has to be told.
   * ═════════════════════════════════════════════════════════════════════════
   *
   * A swap (Combat.lua:32-74, `World.swapPlaces`) puts a second body on a tile
   * it did not walk onto. The two `moved` events say WHERE everyone ended up,
   * and that is all a renderer needs — but net/ keeps a rule that turns on HOW
   * a body got somewhere, not just where it is: `Session.exitArmed`, which
   * makes standing on a delve's threshold mean *leaving* only once you have
   * stepped off it under your own power. Arriving disarms it, in as many words,
   * *"whatever this body did on the last floor, it has not yet stepped off THIS
   * threshold"*.
   *
   * Being shoved onto the doorstep by a friend is the same situation and needs
   * the same answer, or a party member gets thrown out of a delve by somebody
   * else's keystroke. That fact is unrecoverable from the event stream — a
   * `moved` looks identical whoever caused it — so it is reported here, the way
   * `reaped` and `refusals` are: bookkeeping the caller needs and the wire does
   * not.
   */
  readonly displaced: readonly string[];
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
/**
 * ═══════════════════════════════════════════════════════════════════════════
 * BURY WHOEVER A STATUS KILLED — the monster arm of `survivalPass`.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `survivalPass` is the PLAYER arm: it runs at the tail of `actBase` and enrols
 * a body that bled out into the Downed system. There was no monster arm at all,
 * because a monster's death normally arrives through an action outcome and a
 * bleed produces none.
 *
 * IT DOES THE SAME FOUR THINGS `noteCasualty` DOES, and deliberately not by
 * calling it: that function takes an `Effect` and derives its victims from
 * `killedBy`, and manufacturing a fake outcome to feed it would put a lie in the
 * one structure the Record lane reads back.
 *
 * THE GUARD IS POSITIVE — `kind === Monster` — for the reason `noteCasualty`
 * states where it does the same thing: a DOWNED player is `alive === false` on
 * purpose, `removePlayer` is literally the same closure as `removeActor`, and a
 * mistake here deletes somebody's character rather than merely mis-scoring.
 *
 * AN UNPAID KILL IS STILL A BURIAL. With `killerId` null the body is reaped,
 * narrated and spills its pockets; only the credit is skipped. A corpse left
 * standing because nobody could be paid for it would be the original bug with a
 * smaller footprint.
 */
function resolveStatusHits(run: Run, sweepTurn: number | null): void {
  const drain = run.ctx.drainHits;
  if (drain === undefined) return;

  for (const hit of drain()) {
    /**
     * THE LINE FIRST, AND UNCONDITIONALLY. It is reported even for a body that
     * has since left the world, because the damage HAPPENED and the transcript
     * is a record of what happened — and because withholding it is the exact
     * failure this event exists to fix.
     */
    run.sink.push({
      t: 'status_damage',
      id: hit.victimId,
      sourceId: hit.sourceId,
      amount: hit.amount,
      hp: hit.hp,
      maxHp: hit.maxHp,
      killed: hit.killed,
      type: hit.type,
      crit: hit.crit,
    });

    if (!hit.killed) continue;
    const victim = run.world.getActor(hit.victimId);
    if (victim === undefined) continue;
    /**
     * THE GUARD IS POSITIVE — `kind === Monster` — for the reason `noteCasualty`
     * gives where it does the same thing: a DOWNED player is `alive === false`
     * on purpose, `removePlayer` is literally the same closure as `removeActor`,
     * and a mistake here deletes somebody's character rather than merely
     * mis-scoring. The player arm is `survivalPass`, which runs a line above.
     */
    if (victim.kind !== ActorKind.Monster) continue;
    // Back on its feet by the time this drains? Then it is not a casualty. Cheap,
    // and it keeps the note advisory rather than authoritative.
    if (victim.alive) continue;

    run.reaped.push(victim.id);
    if (hit.sourceId !== null) {
      run.ctx.talents?.noteKill(hit.sourceId);
      awardExperience(run, hit.sourceId, victim);
    }
    spillLoot(run, victim, sweepTurn);
  }
}

export function pump(world: World, ctx: PumpCtx): PumpResult {
  if (!Number.isFinite(ctx.nowMs)) {
    throw new RangeError('pump: ctx.nowMs must be a finite number');
  }

  const events: GameEvent[] = [];
  const sink = createEventSink(events);
  const reaped: string[] = [];
  const displaced: string[] = [];

  /**
   * ONE SNAPSHOT of the actor array for the whole call — ToME's `tickLevel` is
   * a cursor over a FIXED entity array (GameEnergyBased.lua:99-107) and this is
   * the same guarantee: nothing joins or leaves the sweep halfway through it.
   * Deaths do not remove anybody; `isActive` stops ticking them and the body
   * stays in the world.
   */
  const actors = world.actorsInTurnOrder();
  const aiCtx = makeAiCtx(world, actors, ctx.talents);

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
    reaped,
    displaced,
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
  // AND THE OPEN ROUNDS, beside the Bell and per party for the same reason.
  // Without this the floor freezes the moment two people hold budget at once —
  // see `applyRoundTails`, which is the entire argument.
  for (const scope of scopes) applyRoundTails(actors, ctx, scope);

  const result = tickLevel(ticking, {
    clock: world.turn.clock,
    // See `PumpCtx.freeRuns`. Forwarded and not interpreted: the cadence belongs
    // to the timer that asked, and the bound belongs to `tickLevel`.
    freeRuns: ctx.freeRuns,

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
     * The first three are `actBase` itself (tome/class/Actor.lua:525, :597, :606), and its
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
      // THE TALENT HALF OF THE SAME PASS, and it goes here rather than anywhere
      // else for the reason `actBase` itself does: it is the AP/MP refill and
      // the class resource's regeneration, both of which must fire exactly ONCE
      // PER GAME TURN AT ANY SPEED. On the act clock a hasted body would refill
      // more often, which is a haste that shortens cooldowns by another name.
      // Absent seam → not called, and nothing about this pass changes.
      ctx.talents?.actBase(actor.id);
      // AND THE LEVELS BANKED DURING THE PUMP ARE PAID OUT HERE, on the same
      // once-per-game-turn-per-actor clock and for a related reason: a talent
      // point that appeared mid-pump could be spent mid-pump, and a talent whose
      // scaling changes between the first and third blow of one AoE moves the
      // labelled draw stream. See `applyPendingLevels`.
      applyPendingLevels(actor, run);
      drainStatus(ctx, sink, null);
      /**
       * ═══ THE BLOW, THEN WHAT IT COST — WHICH IS THE ORDER IT HAPPENED IN ═══
       * `drainStatus` above says "Dalt is Bleeding". This says "5 damage. Dalt
       * 0/4." And `survivalPass` below says "Dalt is DOWN".
       *
       * `resolveStatusHits` FIRST, and it was the other way round for one
       * measured pump: the events came out `downed, erased, damage`, so the
       * transcript announced the consequence and then the cause — a player read
       * that they were down, and only afterwards what had done it.
       *
       * The two do not otherwise interact: this one buries MONSTERS (the player
       * arm is `survivalPass`, and the positive `kind === Monster` guard is what
       * keeps them apart), and `survivalPass` only ever looks at the one actor
       * whose base clock just ticked.
       */
      resolveStatusHits(run, null);
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
    reaped,
    displaced,
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

    // WHO GOT MOVED WITHOUT ASKING. Recorded here rather than inside
    // `emitPlayerEffect`, which takes a sink and not the run — and this is the
    // one place that holds both. See `PumpResult.displaced`.
    if (outcome.effect.kind === 'swapped') run.displaced.push(outcome.effect.otherId);
    emitPlayerEffect(actor, outcome.effect, sink);
    // Statuses this action applied, then anybody it put on the floor. Both in
    // the PLAYER lane rather than the sweep, because this was a human's turn.
    drainStatus(ctx, sink, null);
    // Resolve for anybody this action hurt, then the reap/downed enrolment and
    // the killer's reagent. Both in the PLAYER lane, for the same reason
    // `drainStatus` above is: a human just took their turn.
    noteBlows(outcome.effect, run);
    noteCasualty(outcome.effect, run, null, actor.id);
    // AND ANYBODY GUARDING WHOEVER THIS PLAYER JUST HIT. Called in BOTH lanes
    // rather than only the monster one, so the rule is a property of "a blow
    // landed" rather than of "a monster's turn". It answers null for every
    // player-on-player case today — `resolveGuardCounter` refuses a guardian who
    // is not the attacker's enemy — and costs one Map miss to say so.
    noteGuardCounter(outcome.effect, run, null, actor.id);
    /**
     * ═════════════════════════════════════════════════════════════════════════
     * THE ROUND MAY STAY OPEN — `DECISIONS.md` D1, four milestones late.
     * ═════════════════════════════════════════════════════════════════════════
     *
     * D1 is Accepted and its table reads *"Intra-turn budget: 6 AP / 3 MP,
     * spendable across several talents in one park"*. Every one of the twelve
     * talents is priced against that round and `ward_rush.ts` derives its own
     * cooldown from "an Inner Datum turn holds ~2 actions from a 6 AP budget" —
     * and until this line, one submitted action ended the actor's turn, so Ward
     * Rush at 2 AP and Iron Curtain at 5 cost a player exactly the same thing.
     *
     * `ActResult.Park` is not a new mechanism: it is byte-for-byte what the
     * refund path twenty lines up already returns, and it means "this actor
     * still owes a decision". The energy is simply not spent yet, so the loop
     * comes back to them before the world moves.
     */
    actor.roundActions += 1;
    /**
     * ═════════════════════════════════════════════════════════════════════════
     * A STEP COSTS 1 MP — `docs/game-design.md` § 6, authored and never charged.
     * ═════════════════════════════════════════════════════════════════════════
     *
     * AFTER THE MOVE RESOLVED, not before, and the ordering is deliberate: the
     * step may have been refused by terrain or an occupant, and charging for a
     * wall would be charging for nothing. `resolveIntent` has already answered.
     *
     * `spendMove` ABSENT IS FREE MOVEMENT, which is the game as it shipped and
     * what every fixture without a talent runtime still gets — so a `?? true`
     * here means "nothing is keeping score", not "the body is out of legs".
     */
    /**
     * ═════════════════════════════════════════════════════════════════════════
     * A BUMP ATTACK IS SUBMITTED AS A MOVE, AND IT MUST NOT CHAIN.
     * ═════════════════════════════════════════════════════════════════════════
     *
     * `IntentKind.Move` covers two different acts: walking, and walking INTO
     * something, which `resolveIntent` turns into a swing. Treating both as
     * steps made melee cost 1 MP of 3 and repeat three times a round — roughly
     * tripling basic-attack throughput, which is a bigger balance change than
     * the whole budget and one nobody asked for. `class-wiring.test.ts` caught
     * it as a base-turn count falling from two to one.
     *
     * So the round stays open only for a step that was actually a STEP. An
     * attack closes it, exactly as it did before this commit, and the walk that
     * chains is the one that moved a body.
     */
    const wasStep = intent.kind === IntentKind.Move && outcome.effect.kind !== 'attack';
    const paidForStep = wasStep ? (run.ctx.talents?.spendMove(actor.id) ?? true) : true;
    if (paidForStep && roundStaysOpen(actor, intent, run, wasStep)) {
      actor.roundTailMs = run.ctx.nowMs + ROUND_TAIL_MS;
      return ActResult.Park;
    }
    // D1: exactly ENERGY_TO_ACT, always. `spendTurn` derives that from the
    // actor's kind so no call site can get it wrong — and it is what clears
    // `roundActions` and `roundTailMs`, for the same reason.
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
  // (ai/simple.lua:184-195) for this and it is genuinely nicer, but it costs the
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
    // ONE ACTION, POSSIBLY SEVERAL STEPS — a cast is a stamp plus its damage.
    // Repeated calls append to the SAME open batch; only `sink.push` closes one.
    for (const step of sweepStepFor(actor, outcome.effect)) sink.sweep(gameTurn, step);
    // INTO THE SAME BATCH. A stun landing and a detective hitting the floor are
    // part of the monster turn the client is pacing, and pushing them as
    // ordinary events would close the batch mid-sweep — see `createEventSink`.
    drainStatus(ctx, sink, gameTurn);
    // A monster's blow is the commonest way a Watchman earns Resolve at all —
    // see `TalentResolution.noteStruck`.
    noteBlows(outcome.effect, run);
    noteCasualty(outcome.effect, run, gameTurn, actor.id);
    // ═══ AND THE PUNISH — THE LANE IRON CURTAIN WAS WRITTEN FOR ═══
    // A husk swings at the detective a Watchman is guarding and eats a free
    // counter for it. AFTER `noteCasualty`, so that a blow which put the guarded
    // ally on the floor narrates in that order and so that a guardian who was
    // himself downed by the same pump cannot swing (`resolveGuardCounter`
    // requires a live guardian, and a downed body is `alive === false`).
    noteGuardCounter(outcome.effect, run, gameTurn, actor.id);
  }

  // ToME-native cost: ENERGY_TO_ACT * speedFactor (Actor.lua:1353-1360, 5863).
  spendTurn(actor);
  return ActResult.Done;
}

// ---------------------------------------------------------------------------
// Resolution — one path for players and monsters alike
// ---------------------------------------------------------------------------

/**
 * ONE VICTIM OF ONE BLOW, with the two things that stop being true a line later.
 *
 * Shared by the weapon swing and by every hit a talent produced, so that
 * "somebody got hit" has exactly one shape in this file no matter which verb
 * produced it.
 */
type Blow = {
  readonly targetId: string;
  /** False is a MISS. See `GameEvent.attacked.hit`. */
  readonly hit: boolean;
  readonly crit: boolean;
  /**
   * WHAT KIND OF DAMAGE. Dropped here for four milestones: `combat.ts`'s attack
   * result has carried `type` since M3 and every mapping between it and the wire
   * left it behind, so the Case Log printed "7 damage" for a Redacted's darkness
   * and for a husk's fist alike. Upstream logs the type on every line
   * (damage_types.lua:496-501).
   *
   * OPTIONAL, because the two blows that are not swings genuinely have none to
   * report: a miss did no damage of any kind, and an orb's damage was frozen at
   * the muzzle. Absent means "do not say", not "physical".
   */
  readonly type?: DamageType;
  /** Absent when no to-hit roll happened. See `GameEvent.attacked.atk`. */
  readonly atk?: number;
  readonly def?: number;
  readonly chance?: number;
  readonly damage: number;
  /**
   * HP PUT BACK, for the one talent that does. See `DamageEvent.healed`.
   *
   * `TalentHit` has carried this since the talent engine was written and the
   * `Blow` mapping DROPPED IT, so Mend Wounds became a blow with `damage: 0,
   * hit: true` and the party's only heal was narrated to the whole room as the
   * Alchemist attacking herself and her friend for nothing, with struck-tile
   * markers drawn on both. Absent (and 0) is a damaging blow.
   */
  readonly healed?: number;
  readonly killed: boolean;
  /** The victim's hp and tile the instant this landed. See `GameEvent.attacked`. */
  readonly hp: number;
  readonly at: TileXY;
};

/** What actually happened, once an intent survived its legality check. */
type Effect =
  | { readonly kind: 'move'; readonly from: TileXY; readonly to: TileXY }
  /**
   * TWO BODIES TRADED TILES — see `World.swapPlaces` and Combat.lua:32-74.
   *
   * A SEPARATE EFFECT FROM `move`, even though it emits two ordinary `moved`
   * events, because the caller needs to know somebody was moved who did not ask
   * to be: `PumpResult.displaced` is how net/ learns to disarm that body's door
   * (see the note there). Folding it into `move` would make that fact
   * unrecoverable by the time the sink is read.
   */
  | {
      readonly kind: 'swapped';
      readonly from: TileXY;
      readonly to: TileXY;
      readonly otherId: string;
    }
  | ({ readonly kind: 'attack' } & Blow)
  /**
   * A TALENT LANDED. One stamp, plus one `Blow` per victim.
   *
   * The victim list is carried here rather than being folded into a single
   * event because the wire requires the split (protocol.ts:1582-1592) — see
   * `GameEvent.talent_used`.
   */
  | {
      readonly kind: 'talent';
      readonly landing: TalentLanding;
      readonly blows: readonly Blow[];
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
/**
 * ═══════════════════════════════════════════════════════════════════════════
 * DID THE CONFUSION TAKE THIS ACTION? `mental.lua:80`'s attribute, rolled.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `StatusFlags.confused` is a PERCENT — see its docblock in engine/derived.ts —
 * and both of upstream's consumers roll it the same way, `rng.percent(...)`.
 *
 * BOUNDED AT THE ROLL RATHER THAN WHERE IT IS COMPOSED, so a tooltip prints the
 * number the effects actually granted while the die stays a die: two confusions
 * summing past a hundred would otherwise be an unrollable certainty expressed as
 * arithmetic nobody can see.
 *
 * ONE LABELLED DRAW, and only when there is something to roll — a body with no
 * confusion consumes nothing from the stream, so adding this status changes no
 * existing seed's sequence.
 */
function confusionTakes(actor: EngineActor, world: World, label: string): boolean {
  const pct = actor.combat?.flags?.confused ?? 0;
  if (pct <= 0) return false;
  return world.rng.int(label, 1, 100) <= Math.min(pct, 100);
}

/**
 * WHERE A CONFUSED BODY ACTUALLY STEPS — `Actor.lua:1316-1321`.
 *
 * ```lua
 * if not force and self:attr("confused") then
 *   if rng.percent(self:attr("confused")) then
 *     x, y = self.x + rng.range(-1, 1), self.y + rng.range(-1, 1)
 *   end
 * end
 * ```
 *
 * TWO INDEPENDENT AXES, not a pick from eight names, which is why the ninth
 * outcome exists at all: both offsets can come up zero, and upstream's `move`
 * then walks the body onto its own tile — moved, energy spent, nowhere gained.
 * That is returned here as `null`, and the caller turns it into a HOLD, which is
 * this engine's existing word for "the turn is spent and the board did not
 * change". Collapsing it into a seventh direction would quietly delete an
 * eleventh of the mechanic; making it a REFUSAL would be worse, because a
 * refusal refunds the turn and re-prompts — confusion would become a free
 * re-roll, which is the opposite of what it is for.
 *
 * AND THE SCRAMBLED STEP KEEPS EVERY OTHER RULE. Upstream substitutes the
 * destination at the TOP of `move` and lets the rest of it run, so a confused
 * body that stumbles into a hostile bump-attacks it and one that stumbles into a
 * wall is refused. Ours returns a DIRECTION for the same reason: everything
 * below reads `dir`, so the bump, the ally swap and the terrain check all see
 * the tile the body is really going to.
 */
function confusedStep(actor: EngineActor, dir: Dir, run: Run): Dir | null {
  if (!confusionTakes(actor, run.world, `confused.move.${actor.id}`)) return dir;
  const dx = run.world.rng.int(`confused.dx.${actor.id}`, -1, 1);
  const dy = run.world.rng.int(`confused.dy.${actor.id}`, -1, 1);
  return dirFromVector(dx, dy) ?? null;
}

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
     * ═════════════════════════════════════════════════════════════════════════
     * THE TALENT SEAM, NOW WITH SOMETHING BEHIND IT. See `TalentResolution`.
     * ═════════════════════════════════════════════════════════════════════════
     *
     * The submission path was already complete — src/server/turn-engine.ts
     * checks range, the `min_range` dead zone, line of sight, the cooldown and
     * the resource before this intent is ever queued — so what lands here is a
     * request that WAS legal when the packet arrived. Whether it still is, is
     * this line's question, and `use` re-decides all of it: that is the refund
     * rule (docs/architecture.md § 2), and it is why the resource is spent and
     * the cooldown set THERE rather than at submission.
     *
     * NO SEAM → `Refusal.NoTalentEffect`, exactly as before. Not a stub that
     * pretends to work: a silent success would spend the turn and show the
     * player nothing.
     */
    case IntentKind.Talent: {
      const talents = run.ctx.talents;
      if (talents === undefined) return { ok: false, reason: Refusal.NoTalentEffect };

      /**
       * ═══════════════════════════════════════════════════════════════════════
       * CONFUSED — LOSE THE TURN. `Actor.lua:5499-5504`, and the energy is the
       * whole of it.
       * ═══════════════════════════════════════════════════════════════════════
       *
       * ```lua
       * if self:attr("confused") and ... then
       *   if rng.percent(self:attr("confused")) then
       *     game.logSeen(self, "%s is confused and fails to use %s.", ...)
       *     self:useEnergy()
       *     return false
       * ```
       *
       * ═══ HERE AND NOT IN `submitTalent`, WHICH IS THE POINT ═══
       * The talent GATE (turn-engine.ts) checks only what cannot change between
       * the packet and the tick, because a refusal there costs zero and
       * re-prompts — that refund is what removes hesitation from a co-op turn. A
       * confusion roll checked there would be a free re-roll: press again, roll
       * again, until it works. It has to sit where the turn is actually spent.
       *
       * A HOLD, so the turn is spent and the board does not change — this
       * engine's existing word for exactly upstream's `useEnergy(); return
       * false`. The Confused badge on the caster's own HUD is what explains it;
       * a dedicated log line would be a new wire variant, and the badge carries
       * its own sentence already (`EffectView.desc`).
       */
      if (confusionTakes(actor, world, `confused.talent.${actor.id}`)) {
        return { ok: true, effect: { kind: 'hold' } };
      }

      const used = talents.use(actor, intent.talentId, intent.target);
      if (!used.ok) return { ok: false, reason: talentRefusalToRefusal(used.reason) };

      // The victims' hp and tiles are read HERE, one line after the talent
      // resolved, and never again — the same rule `strike` follows and for the
      // same reason: a floor reset later in this pump rewrites every hp and
      // walks the whole party to the spawn cluster. See `GameEvent.attacked`.
      const blows = used.landing.hits.map((hit): Blow => {
        const victim = world.getActor(hit.targetId);
        return {
          targetId: hit.targetId,
          hit: hit.hit,
          crit: hit.crit,
          type: hit.type,
          damage: hit.damage,
          // CARRIED, NOT DROPPED. This mapping used to keep `damage` alone, and
          // a heal became a blow with `damage: 0, hit: true` — see `Blow.healed`.
          ...(hit.healed > 0 ? { healed: hit.healed } : {}),
          killed: hit.killed,
          hp: victim?.hp ?? 0,
          at: victim === undefined ? used.landing.at : { x: victim.x, y: victim.y },
        };
      });
      /**
       * ═══════════════════════════════════════════════════════════════════════
       * AND THE ROOM HEARD THAT TOO. NPC.lua:342-367 — see `ai/alarm.ts`.
       * ═══════════════════════════════════════════════════════════════════════
       *
       * HERE RATHER THAN INSIDE `talentProject`, and the layering is the reason.
       * `TalentWorld` (engine/talents.ts) deliberately narrows the world to five
       * members and hands out `TalentActor`, which has no `ai` field at all — a
       * talent must not be able to reach into a monster's targeting state, and
       * widening that interface to let one would trade a real boundary for a
       * convenience. The scheduler is the layer that invoked the talent and it
       * holds the real `World`, so the alarm is raised from here, once, over
       * whatever the talent actually hit.
       *
       * ONE CALL PER VICTIM THAT TOOK DAMAGE. A heal (`healed > 0`, `damage: 0`)
       * raises nothing, and neither does a talent that missed — upstream's guard
       * is `value > 0` and a whiff that pulls a room would make missing worse
       * than not acting.
       */
      for (const blow of blows) {
        if (blow.damage <= 0) continue;
        const victim = world.getActor(blow.targetId);
        if (victim !== undefined) raiseAlarm(world, victim, actor);
      }

      return { ok: true, effect: { kind: 'talent', landing: used.landing, blows } };
    }

    case IntentKind.Attack: {
      const target = world.getActor(intent.targetId);
      // KEPT HERE RATHER THAN DELEGATED, both of them: `canAttack` answers
      // `TargetDead` for the first, which is the same refusal in different
      // words, and it has no faction concept at all for the second — hostility
      // is `engine/actor.ts`'s question and combat.ts must not learn it.
      if (target === undefined || !target.alive) return { ok: false, reason: Refusal.NoTarget };
      if (!isHostile(actor, target)) return { ok: false, reason: Refusal.NotHostile };

      // ═══ ONE LEGALITY CHECK, AND IT IS THE ONE THE SWING WILL USE ═══
      // This used to be a Chebyshev reach test plus a line-of-sight test written
      // out here, while `attackTarget` refused on EUCLIDEAN — so an attack could
      // pass this check and then quietly do nothing. The two had to move
      // together; the wiring note at the head of engine/combat.ts is the whole
      // argument, and `strike` below passes `skipLegality` precisely because
      // this line already asked.
      const refusal = canAttack(actor, target, world);
      if (refusal !== null) return { ok: false, reason: attackRefusalToRefusal(refusal) };

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
      return { ok: true, effect: strike(actor, target, run) };
    }

    case IntentKind.Move: {
      const from: TileXY = { x: actor.x, y: actor.y };
      /**
       * ═══════════════════════════════════════════════════════════════════════
       * CONFUSED FIRST, BEFORE EVERY OTHER RULE — `Actor.lua:1316-1321`.
       * ═══════════════════════════════════════════════════════════════════════
       *
       * Upstream substitutes the destination at the very top of `move`, ahead of
       * the bump, the swap and the terrain test, so a scrambled step is a real
       * step in a different direction rather than a special case. This line is
       * that placement; `confusedStep` is the roll.
       *
       * `null` is the stumble-in-place — see `confusedStep` for why it is a hold
       * and not a refusal.
       */
      const dir = confusedStep(actor, intent.dir, run);
      if (dir === null) return { ok: true, effect: { kind: 'hold' } };
      const to = step(actor, dir);

      // BUMP-ATTACK. Walking into a hostile IS the attack input in M2, and it
      // is what makes terrain-only pathing produce monsters that hit things
      // rather than politely route around them.
      const occupant = world.actorAt(to.x, to.y);
      if (occupant !== undefined && isHostile(actor, occupant)) {
        /**
         * ═════════════════════════════════════════════════════════════════════
         * A BUMP IS AN ATTACK, SO IT OBEYS THE ATTACK'S RULES — INCLUDING THE
         * DEAD ZONE. THE WHOLE INTENT IS REFUSED.
         * ═════════════════════════════════════════════════════════════════════
         *
         * The bump used to be an UNCONDITIONAL `strike`, which was harmless
         * while nothing had a `minRange`. It is not harmless now: an Inspector
         * (minRange 3) walking into an adjacent husk is `AttackRefusal.MinRange`,
         * and the question is what her turn does.
         *
         * IT IS REFUSED, WITH `TooClose`, for zero energy and a re-prompt — and
         * neither of the two alternatives is acceptable:
         *
         *   FALL THROUGH TO `tryMove`. It would fail with `Occupied`, which
         *   NAMES THE WRONG REASON. The player is told a body is in the way when
         *   what actually happened is that their weapon will not fire this
         *   close, and combat.ts:52 exists precisely so the log can say "too
         *   close" instead of eating the turn silently.
         *
         *   EXEMPT THE BUMP FROM THE DEAD ZONE. That contradicts game-design.md
         *   § 2 outright: the Inspector cannot shoot what is standing on her, and
         *   a melee exemption is the whole class's counterplay deleted by
         *   accident. What she should do is back away, and `TooClose` is the
         *   only refusal that tells her so.
         *
         * A MONSTER inherits this too — a refused monster intent still costs the
         * turn (`actMonster`) and shows up as a `blocked` sweep step. That is
         * correct: it bumped into something it cannot swing at. The one profile
         * with a dead zone (`ranged_kiter`) can never reach this line anyway,
         * because `intentForStep` rejects any step ending inside `keepAway`.
         */
        const refusal = canAttack(actor, occupant, world);
        if (refusal !== null) return { ok: false, reason: attackRefusalToRefusal(refusal) };
        return { ok: true, effect: strike(actor, occupant, run) };
      }

      /**
       * ═══════════════════════════════════════════════════════════════════════
       * WALKING INTO A FRIEND TRADES PLACES WITH THEM.
       * ═══════════════════════════════════════════════════════════════════════
       *
       * Ported from Combat.lua:32-74 — the `reaction >= 0` half of `bumpInto`,
       * where ToME force-moves both bodies and charges the mover one move. It is
       * on for party members by `Party.lua:271-272` (*"actor.move_others =
       * true"*) and for the player at birth by `descriptors.lua:60`.
       *
       * ═══ WHY IT IS WORTH THE HOT PATH ═══
       * Without it a party member is a WALL. Measured while probing something
       * else entirely: a player following a friend into a delve arrives at the
       * way out, and if anybody is standing on it the only route in is through
       * them — twelve consecutive steps, no movement. The refusal was delivered
       * (`refused at resolution: occupied`, unicast), so it was not silent, but
       * an accurate error message is not the answer to *"my friend is in the
       * doorway"*. In a co-op roguelike played down corridors this is the most
       * repeatable friction there is.
       *
       * ═══ PLAYER TO PLAYER ONLY, AND THE KIND TEST EARNS ITS PLACE ═══
       * The hostile branch above has already returned for anything that would
       * fight, so an occupant reaching this line is never an enemy — which means
       * this test is not about hostiles at all. It is what stops the two cases
       * that ARE non-hostile and are not your friend:
       *
       *   A TOWNSFOLK. `areEnemies` returns false the moment either side is
       *     `Faction.Townsfolk`, so a shopkeeper reaches this line. Without the
       *     kind test a player would shove the person they came to trade with
       *     off her own doorstep. (The gateway's `greetOnBump` intercepts a
       *     townsfolk bump before it is ever submitted, so this is belt and
       *     braces today — and it is the only case a test can reach, which is
       *     what test/server/ally-swap.test.ts uses to pin the gate.)
       *
       *   TWO MONSTERS. A pack is not hostile to itself. Letting them trade
       *     places would let the back rank flow through the front rank, which
       *     turns a corridor from something a party can hold into a queue that
       *     shuffles — and holding a line is most of the tactical geometry this
       *     game has.
       *
       * ═══ AND NEVER A BODY ON THE FLOOR — WHICH IS UNREACHABLE, AND STAYS ═══
       * A Downed body cannot reach this line at all: `goDown` clears `alive`,
       * and `world.actorAt` returns only living bodies, so a casualty is not an
       * occupant of anything. You walk straight over one, and always could —
       * MEASURED, after this guard was written on the assumption it was doing
       * work.
       *
       * It stays because it is the one thing standing between a future change to
       * `actorAt` and a free tow: swapping with a casualty would drag them
       * around the floor, and dragging one onto the threshold would walk them
       * out of the delve entirely. ToME spells the same rule `cant_be_moved`
       * (Combat.lua:53), and a guard that costs a Map lookup is a cheap price
       * for a bug that would present as bodies teleporting out of dungeons.
       */
      if (
        occupant !== undefined &&
        actor.kind === ActorKind.Player &&
        occupant.kind === ActorKind.Player &&
        !(run.ctx.downed !== undefined && isDowned(run.ctx.downed, occupant.id))
      ) {
        const theirs: TileXY = { x: occupant.x, y: occupant.y };
        if (world.swapPlaces(actor.id, occupant.id)) {
          run.ctx.talents?.noteMoved(actor.id);
          return { ok: true, effect: { kind: 'swapped', from, to: theirs, otherId: occupant.id } };
        }
      }

      // `tryMove` remains the ONLY thing in the process allowed to change a
      // position, so terrain and occupancy are decided in exactly one place.
      const moved = world.tryMove(actor.id, dir);
      if (!moved.ok) return { ok: false, reason: moved.reason };
      // `TalentSheet.movedThisTurn` — the flag Focus regen reads, set from the
      // one place in the process where an actor's tile actually changes. Cleared
      // by the talent `actBase` pass at the top of the next game turn.
      run.ctx.talents?.noteMoved(actor.id);
      return { ok: true, effect: { kind: 'move', from, to: { x: moved.x, y: moved.y } } };
    }
  }
}

/**
 * `AttackRefusal` -> `Refusal`. The engine has two refusal vocabularies because
 * combat.ts is structural and knows nothing about intents; this is the one place
 * they meet.
 *
 * `MinRange` -> `TooClose` is the only interesting row and it is the reason this
 * function is not an identity: see `Refusal.TooClose`. The three degenerate
 * targets collapse onto `NoTarget` because from the intent's point of view they
 * are the same fact — there is nobody there to hit.
 */
function attackRefusalToRefusal(reason: AttackRefusal): Refusal {
  switch (reason) {
    case AttackRefusal.OutOfRange:
      return Refusal.OutOfRange;
    case AttackRefusal.NoLineOfSight:
      return Refusal.NoLineOfSight;
    case AttackRefusal.MinRange:
      return Refusal.TooClose;
    case AttackRefusal.TargetDead:
    case AttackRefusal.Dead:
    case AttackRefusal.Self:
      return Refusal.NoTarget;
  }
}

/**
 * `TalentRefusal` -> `Refusal`, for the same reason as above.
 *
 * The rows that carry an INSTRUCTION are kept apart — out of range says close
 * in, too close says back off, no line of sight says move — and everything that
 * is really "this build cannot do that with this talent right now" (cooldown,
 * budget, resource, an unknown id, a blocked destination) collapses onto
 * `NoTalentEffect`, which is the refund path either way.
 */
function talentRefusalToRefusal(reason: TalentRefusal): Refusal {
  switch (reason) {
    case TalentRefusal.OutOfRange:
      return Refusal.OutOfRange;
    case TalentRefusal.MinRange:
      return Refusal.TooClose;
    case TalentRefusal.NoLineOfSight:
      return Refusal.NoLineOfSight;
    case TalentRefusal.NoTarget:
    case TalentRefusal.Dead:
    case TalentRefusal.Self:
      return Refusal.NoTarget;
    case TalentRefusal.NotHostile:
    case TalentRefusal.NotAlly:
      return Refusal.NotHostile;
    case TalentRefusal.Blocked:
      return Refusal.Occupied;
    case TalentRefusal.UnknownTalent:
    case TalentRefusal.NotLearned:
    case TalentRefusal.OnCooldown:
    case TalentRefusal.NoAp:
    case TalentRefusal.NoMp:
    case TalentRefusal.NoResource:
    /* falls through — A PASSIVE HAS NOTHING TO FIRE, which from the turn's point
       of view is the same outcome as a cooldown: the intent produced no effect
       and cost no energy. It joins the group rather than taking a `Refusal` of
       its own, because nothing downstream would draw it differently. */
    case TalentRefusal.Passive:
      return Refusal.NoTalentEffect;
  }
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ONE SWING, THROUGH THE REAL PIPELINE — combat.ts#attackTarget.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * This was the M2 placeholder: `rng.int('combat.bump.damage', damageMin,
 * damageMax)` straight into a flat `applyDamage`, with no `checkHit`, no
 * armour, no armour penetration, no resists and no crit. Every `weapon.dam` /
 * `atk` / `apr` ported into content/monsters.ts from ToME was inert because of
 * this one function.
 *
 * TWO CALLERS INHERIT EVERYTHING BELOW: `IntentKind.Attack` and the Move bump.
 *
 * ═══ `skipLegality`, AND WHY IT IS NOT A HOLE ═══
 * `resolveIntent` has already run `canAttack` for both callers, because it needs
 * the refusal as a REFUND REASON before it commits. Asking twice would be two
 * chances to disagree about the same tile.
 *
 * ═══ THE ONE THING THE NEW PATH DROPS, AND THE ONE LINE THAT PUTS IT BACK ═══
 * `engine/actor.ts`'s old `applyDamage` cleared `pendingIntent` on a killing
 * blow; `damage.ts`'s does not, because damage.ts knows nothing about intents. A
 * body that goes down holding one would resolve it the moment an ally picks them
 * up — a turn nobody took. engine/projectile.ts:619-623 carries the identical
 * two lines for the identical reason.
 *
 * THE CORPSE-CAMP GUARD SURVIVED THE MOVE: damage.ts:589 still returns an empty
 * outcome against a body that is already down, which is what the
 * `damage.ts `applyDamage`` row in engine/downed.ts's "what Downed changes"
 * table depends on.
 *
 * ═══ AND THE MARK IS FOLDED IN HERE, WHICH IS THE ONLY PLACE IT CAN BE ═══
 * `TalentResolution.markMultiplier` has the full argument. In short: this is the
 * one basic-attack site in the process, it serves both the `Attack` intent and
 * the move bump, and until this line existed the Inspector's Sigil moved nothing
 * on the party's most-used source of damage while her panel promised it did.
 */
function strike(attacker: EngineActor, target: EngineActor, run: Run): Effect {
  const { world } = run;

  /**
   * ═══ AN UNMARKED SWING IS BYTE-FOR-BYTE WHAT IT WAS ═══
   * The key is OMITTED at 1 rather than passed as 1. `applyDamage` guards on
   * `spec.mult !== undefined` (damage.ts) and multiplying by 1 is identity in
   * exact arithmetic — but "identity in exact arithmetic" is not the property
   * this project needs. Replay-from-seed needs the pipeline to take the SAME
   * BRANCH, and the absent key is the only way to promise that without arguing
   * about floats. The seam being absent (a build with no talents wired in)
   * answers 1 through the `??` and lands in the same branch.
   */
  const mark = run.ctx.talents?.markMultiplier(target.id) ?? 1;
  const outcome = attackTarget(attacker, target, world, world.rng, {
    skipLegality: true,
    ...(mark === 1 ? {} : { mult: mark }),
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * AND WHAT THIS PARTICULAR CREATURE LEAVES BEHIND — `MonsterActor.onHit`.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * ToME's melee riders (a ghoul's paralysis, a bone giant's stun) are rows on
   * the NPC, not branches in the attack. So this is one guarded call at the one
   * basic-attack site in the process, and every creature that declares nothing
   * takes exactly the branch it always took.
   *
   * ═══ FOUR CONDITIONS, AND THREE OF THEM ARE ABOUT NOT LYING ═══
   *   `outcome.ok` and `outcome.hit`  A MISS INFLICTS NOTHING. The log already
   *     says "Miss (acc 28 vs def 44)"; a bleed under that line would make the
   *     defence stat read as decoration.
   *   `!outcome.killed`               A CORPSE DOES NOT BLEED. The badge would
   *     pop on a body that is already unfiled, and `setEffect` refuses a dead
   *     target anyway (Actor.lua:6951-6978) — this makes the intent explicit
   *     rather than leaning on a refusal happening to be silent.
   *   `attacker.onHit`                Most of the roster has none.
   *
   * The draw is taken AFTER the swing's own draws, always, so a creature with a
   * rider consumes a suffix of the stream rather than shifting the swing that
   * produced it.
   */
  const rider = isMonster(attacker) ? attacker.onHit : undefined;
  if (rider !== undefined && outcome.ok && outcome.hit && !outcome.killed) {
    run.ctx.applyStatus?.(target, rider.effectId, rider.turns, {
      ...(rider.power === undefined ? {} : { applyPower: rider.power }),
      ...(rider.magnitude === undefined ? {} : { power: rider.magnitude }),
      srcId: attacker.id,
    });
  }

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * AND WHOEVER SAW THAT HAPPEN NOW KNOWS WHERE YOU ARE. NPC.lua:342-367.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `ai/alarm.ts` carries the whole argument. The condition is upstream's
   * `value > 0` and nothing more: a MISS raises no alarm, because the defence
   * stat has to mean something and a whiff that pulls a room would make missing
   * worse than not swinging.
   *
   * AFTER the rider, so a creature's own on-hit effect is applied to the body
   * before its friends are told — and, more to the point, after every draw this
   * swing takes. `raiseAlarm` draws nothing, so its position cannot move the
   * stream; keeping it last anyway means it stays true if it ever needs to.
   */
  if (outcome.ok && outcome.hit && outcome.damage > 0) {
    raiseAlarm(world, target, attacker);
  }

  // UNREACHABLE BY CONSTRUCTION — `skipLegality` is the only thing that can make
  // `attackTarget` refuse, and it is set on the line above. Written out rather
  // than asserted away because the alternative is a cast, and the honest answer
  // to "the swing did not happen" is a swing that did nothing.
  if (!outcome.ok) {
    return {
      kind: 'attack',
      targetId: target.id,
      hit: false,
      crit: false,
      damage: 0,
      killed: false,
      hp: target.hp,
      at: { x: target.x, y: target.y },
    };
  }

  if (outcome.killed) target.pendingIntent = null;

  // `hp` and `at` are read HERE, one line after the blow, and never again. A
  // floor reset later in the same pump rewrites the first to full and walks the
  // body to the spawn cluster — see `GameEvent.attacked`.
  return {
    kind: 'attack',
    targetId: target.id,
    hit: outcome.hit,
    crit: outcome.crit,
    // CARRIED, NOT DROPPED — the same note `healed` earned on the talent map
    // below. `combat.ts` has computed this since M3 and nothing passed it on.
    type: outcome.type,
    atk: outcome.atk,
    def: outcome.def,
    chance: outcome.chance,
    damage: outcome.damage,
    killed: outcome.killed,
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
    // THE RIDER, FROZEN AT THE MUZZLE alongside the damage below. See
    // `ProjectileInit.onHit` for why it is read here and not at impact.
    ...(attacker.onHit === undefined ? {} : { onHit: attacker.onHit }),
    damage: {
      dam: rolled,
      type: sheet?.damageType ?? DEFAULT_PROJECTILE_DAMAGE_TYPE,
      apr: sheet === undefined ? 0 : combatAPR(sheet),
      increase: sheet?.increase,
      penetration: sheet?.penetration,
      // AND THE SHOOTER'S OWN DEBUFFS, on the same terms as `apr` above: the
      // flight cannot reach back to this body, so what is true now is what the
      // bolt carries. See `ProjectileDamage`.
      sourceDazed: sheet?.flags?.dazed,
      sourceStunned: sheet?.flags?.stunned,
      sourceNumbed: sheet?.mods?.numbed,
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
   * ═══════════════════════════════════════════════════════════════════════════
   * WHAT THE ORB LEAVES BEHIND — the ranged half of `MonsterActor.onHit`.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * ═══ IT IS APPLIED HERE AND CARRIED THERE ═══
   * The rider was frozen onto the projectile at the muzzle, beside its damage
   * and for the same reason (`ProjectileInit.onHit`): an orb in the air is a
   * fact, not a promise about whatever has happened to the shooter during two
   * or three game turns of flight. But `engine/projectile.ts` works with
   * `ProjectileVictim`, the narrowest possible view of a body, and `setEffect`
   * needs a whole actor — so the orb carries the data and this function, which
   * already holds both the world and the status door, performs the act.
   *
   * ═══ NO `hit` CHECK, AND THAT IS NOT AN OMISSION ═══
   * `strike`'s melee rider guards on `outcome.hit` because a swing can miss. An
   * orb cannot: there is no to-hit roll at fire or at impact, deliberately and
   * permanently (see `fire`). The counterplay to an orb is STEPPING OFF THE
   * TILE, and that has already been resolved three lines above — a body that
   * moved leaves `impact === null` and this is never reached.
   *
   * A corpse still takes nothing. Same rule as melee, same reason.
   */
  const rider = proj.onHit;
  if (rider !== undefined && !impact.killed) {
    const victim = world.getActor(impact.targetId);
    if (victim !== undefined) {
      run.ctx.applyStatus?.(victim, rider.effectId, rider.turns, {
        ...(rider.power === undefined ? {} : { applyPower: rider.power }),
        ...(rider.magnitude === undefined ? {} : { power: rider.magnitude }),
        srcId: proj.sourceId,
      });
    }
  }

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * AND THE ROOM HEARD IT — the site this whole mechanic is FOR. `ai/alarm.ts`.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * A thrown orb is how a player opens on a group from across a room, and it is
   * the case where the gap was widest: the two husks standing behind the one
   * that got hit have no line to the thrower and nothing in their own field of
   * view, so until now they stood still while their friend burned.
   *
   * HERE AND NOT IN `engine/projectile.ts`, for the reason the rider block above
   * gives about itself: that module works through `ProjectileWorld`, a narrowed
   * view with no `getActor` and no AI state on its bodies. This function already
   * holds the real world, exactly as it already holds the status door.
   *
   * THE SHOOTER MAY BE A CORPSE by the time an orb lands — flight is two or
   * three game turns. `raiseAlarm` answers with an empty list for a dead source
   * rather than sending a pack after a body that is no longer standing, which is
   * the same honesty the impact event's own attribution note is about.
   */
  if (impact.damage > 0) {
    const victim = world.getActor(impact.targetId);
    if (victim !== undefined) raiseAlarm(world, victim, world.getActor(proj.sourceId));
  }

  /**
   * THE IMPACT IS A SWEEP STEP, NOT AN ORDINARY EVENT, and it is attributed to
   * the SHOOTER'S ID even if that body is now a corpse (tome/class/Game.lua:1713
   * does the same).
   *
   * An ordinary `push` here would CLOSE the open batch (see `createEventSink`),
   * splitting one monster turn into three because an orb happened to land in the
   * middle of it — the exact fragmentation the batching exists to prevent.
   */
  /**
   * `hit: true`, ALWAYS, AND `atk`/`def`/`chance` ABSENT.
   *
   * There is no to-hit roll on this path, at fire or at impact, and there never
   * will be — see `fire`. An orb that reached a body HIT it, so reporting
   * anything else would make the client draw a miss marker over a blow that
   * landed. The three accuracy numbers are omitted rather than zeroed, because
   * "acc 0 vs def 0, 0%" beside 14 damage is a lie the Case Log would print.
   * `crit` is false for the same reason: the orb's damage was frozen at the
   * muzzle and no crit was ever rolled.
   */
  const blow: Blow = {
    targetId: impact.targetId,
    hit: true,
    crit: false,
    // CARRIED. A wraith is the ranged kiter — "the reason positioning exists" —
    // so its void blast is the damage a player most needs named, and it was the
    // one blow in the game arriving as a bare number after the swings were fixed.
    type: impact.type,
    damage: impact.damage,
    killed: impact.killed,
    hp: impact.hp,
    at: impact.at,
  };

  sink.sweep(gameTurn, { t: 'attack', id: proj.sourceId, ...blow });

  /**
   * AND IT MUST GO THROUGH `noteCasualty`. This is the only place a killed
   * player becomes a `DownedRecord` IN THE LANE IT HAPPENED IN. `enrolCasualties`
   * would eventually catch the body on the NEXT pump — it is the safety net for
   * anything that falls outside the loop — but it files in the PLAYER lane, so a
   * detective killed by an orb would be narrated after the floor reset rather
   * than before it. See `GameEvent.party_wipe.duringSweep` for the evening that
   * cost.
   */
  // THE SHOOTER IS STILL THE KILLER, THREE TURNS LATER AND POSSIBLY A CORPSE.
  // `proj.sourceId` is the attribution the orb has carried since the muzzle;
  // `noteKill`/`noteStruck` both no-op for a body with no sheet, so a shooter
  // that has since been reaped costs one Map miss rather than a branch.
  noteBlows({ kind: 'attack', ...blow }, run);
  noteCasualty({ kind: 'attack', ...blow }, run, gameTurn, proj.sourceId);

  return ActResult.Done;
}

function emitPlayerEffect(actor: PlayerActor, effect: Effect, sink: EventSink): void {
  switch (effect.kind) {
    case 'move':
      sink.push({ t: 'moved', id: actor.id, from: effect.from, to: effect.to });
      return;
    /**
     * TWO ORDINARY `moved` EVENTS, NOT A NEW WIRE KIND.
     *
     * The same ruling the talent lane already made about repositioning: *"The
     * ordinary `moved` event, not a new event kind: `toWireEvents` already turns
     * it into `{k:'move'}` and the client already has the one reader. A second
     * event kind for the same fact is the second source of truth the client's
     * own state rules forbid."*
     *
     * THE MOVER FIRST. Both orders draw the same final frame, but a client that
     * renders them one at a time briefly shows two bodies on one tile if the
     * displaced one is moved last — and this way round the transient overlap is
     * on the tile being VACATED, which is the one already under the camera.
     */
    case 'swapped':
      sink.push({ t: 'moved', id: actor.id, from: effect.from, to: effect.to });
      sink.push({ t: 'moved', id: effect.otherId, from: effect.to, to: effect.from });
      return;
    case 'attack':
      sink.push(attackedEvent(actor.id, effect));
      return;
    /**
     * ONE STAMP, THEN ONE `attacked` PER VICTIM, IN RESOLUTION ORDER.
     *
     * That split is protocol.ts:1582-1592's requirement, not a style: it is
     * what keeps the client's `applyTurnEvent` a single function, because an
     * AoE is one stamp followed by exactly the same damage events a weapon
     * swing produces. A talent that hit nothing still emits its stamp — the FX
     * happened, and a cast that vanished would read as the button being broken.
     */
    case 'talent':
      sink.push({
        t: 'talent_used',
        id: actor.id,
        talentId: effect.landing.talentId,
        at: effect.landing.at,
        shape: effect.landing.shape,
        radius: effect.landing.radius,
        ...(effect.landing.targetId === undefined ? {} : { targetId: effect.landing.targetId }),
        // WHAT IT SAID, straight through. Composed in the talent body, rendered
        // in the gateway's Record lane; nothing between the two reads a word of
        // it. See `TalentEvent.notes` for the milestone they spent unread.
        ...(effect.landing.notes === undefined || effect.landing.notes.length === 0
          ? {}
          : { notes: effect.landing.notes }),
      });
      /**
       * ═══════════════════════════════════════════════════════════════════════
       * THEN EVERY BODY THE CAST MOVED — BEFORE THE DAMAGE, NOT AFTER.
       * ═══════════════════════════════════════════════════════════════════════
       *
       * Three talents reposition somebody (`ActorMove` in engine/talents.ts) and
       * NOTHING TOLD THE CLIENT. The stamp is drawn and then explicitly changes
       * no state; there is no client-initiated resync in the protocol; and
       * `needsFullResync` fires only on downed/revived/erased. So an Inspector
       * who spent her turn, her AP, her MP and a ten-turn cooldown on Fog Step
       * was drawn on the tile she had left — with the camera, the targeting
       * cursor and travel pathing all anchored there — until the party wiped.
       *
       * BEFORE THE BLOWS, because `Blow.at` is the victim's tile snapshotted
       * AFTER the talent resolved: Ward Rush knocks the husk back and the
       * `attacked` event's marker belongs on the tile it was knocked TO. Emit
       * the moves after and the client draws the hit marker on the old square
       * for one frame and then teleports the body under it.
       *
       * The ordinary `moved` event, not a new kind: `toWireEvents` already turns
       * it into `{k:'move'}` and the client already has the one reader. A second
       * event kind for the same fact is the second source of truth the client's
       * own state rules forbid.
       */
      for (const move of effect.landing.moved) {
        sink.push({ t: 'moved', id: move.id, from: move.from, to: move.to });
      }
      for (const blow of effect.blows) sink.push(attackedEvent(actor.id, blow));
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

/** One `Blow` as the event a human's lane emits. The one place the two align. */
function attackedEvent(attackerId: string, blow: Blow): GameEvent {
  return { t: 'attacked', id: attackerId, ...blow };
}

/**
 * ONE MONSTER ACTION, AS THE STEPS THAT DESCRIBE IT.
 *
 * ═══ MANY RATHER THAN ONE, BECAUSE A CAST IS A STAMP PLUS ITS DAMAGE ═══
 * Every other action here is exactly one step and returns a single-element
 * array. A talent is the exception the player lane already lives with: one
 * `talent_used` and then one `attacked` per victim. Appending them all to the
 * same open batch keeps the sweep whole — only `sink.push` closes a batch, and
 * `sink.sweep` called five times running is five steps inside one sweep.
 */
function sweepStepFor(actor: MonsterActor, effect: Effect): readonly SweepStep[] {
  switch (effect.kind) {
    case 'move':
      return [{ t: 'move', id: actor.id, from: effect.from, to: effect.to }];
    case 'attack':
      return [{ t: 'attack', id: actor.id, ...effect }];
    case 'talent':
      /**
       * THE STAMP, THEN EVERY BODY IT HIT — the player lane's shape exactly.
       *
       * This arm read `hold` for as long as no monster could cast, under a
       * comment that named the day it would need writing. A creature's cast is
       * now indistinguishable from a detective's at the wire, which is what lets
       * one `applyTurnEvent` on the client draw both.
       */
      return [
        {
          t: 'talent',
          id: actor.id,
          talentId: effect.landing.talentId,
          at: effect.landing.at,
          shape: effect.landing.shape,
          radius: effect.landing.radius,
          ...(effect.landing.targetId === undefined ? {} : { targetId: effect.landing.targetId }),
          // OMITTED WHEN EMPTY, matching the player lane: an absent key is the
          // shape `TalentEvent.notes` documents.
          ...(effect.landing.notes === undefined || effect.landing.notes.length === 0
            ? {}
            : { notes: effect.landing.notes }),
        },
        ...effect.blows.map((blow): SweepStep => ({ t: 'attack', id: actor.id, ...blow })),
      ];
    case 'hold':
      return [{ t: 'hold', id: actor.id }];
    case 'swapped':
      // UNREACHABLE, AND NOT A LIE. The swap requires BOTH bodies to be players
      // (see the note on the rule), so a monster cannot produce this effect. The
      // arm exists because both lanes share the `Effect` union, and a monster
      // that could swap would walk through the line a party is holding.
      //
      // THE `talent` ARM ABOVE NO LONGER KEEPS THIS ONE COMPANY: it was
      // unreachable on precisely the same grounds until the bestiary got
      // talents. An arm justified by "no monster can produce this" is a claim
      // with an expiry date, and this file has now watched one expire.
      return [{ t: 'hold', id: actor.id }];
    case 'fired':
      // The shot left the muzzle. Nothing has been hit — the impact arrives as
      // its own `attack` step, up to three turns later, from `actProjectile`.
      // This step is dropped at the wire on purpose; see `SweepStep.fired`.
      return [{ t: 'fired', id: actor.id, to: effect.to }];
    case 'revive':
      // UNREACHABLE TODAY, AND NOT A LIE. `decideNpcAction` (ai/npc.ts) emits
      // Move, Attack and Hold and nothing else, so no monster can ever produce a
      // Revive intent. The arm exists because the `Effect` union is shared by
      // both lanes, and reading it as a hold is the honest answer: the monster
      // spent its turn and the client draws nothing. The day something in the
      // world can pick its own kind up, this grows its own `SweepStep`.
      return [{ t: 'hold', id: actor.id }];
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

/** Every `Blow` this effect carries — one for a swing, N for an AoE, none else. */
function blowsOf(effect: Effect): readonly Blow[] {
  if (effect.kind === 'attack') return [effect];
  if (effect.kind === 'talent') return effect.blows;
  return [];
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE CLASS-RESOURCE BOOKKEEPING FOR ONE RESOLVED ACTION.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Called from all three lanes beside `noteCasualty` (player, sweep, projectile)
 * and for the same reason it is: this is where a blow's consequences are known
 * exactly once. Both members are no-ops for a body with no sheet and for the
 * two resources they do not own, so a monster swinging at a monster costs one
 * Map miss and changes nothing.
 *
 * ═══ ONLY LANDED, ONLY WITH DAMAGE ON IT ═══
 * `hit === false` is a MISS and pays no Resolve — the Watchman is rewarded for
 * absorbing a blow, not for being swung at. `damage <= 0` covers the fully
 * armoured hit and, importantly, the HEAL: `TalentHit` reports a heal as a blow
 * with `damage: 0`, and paying the Watchman Resolve for being bandaged would be
 * a free 6 per turn from a friendly Alchemist.
 *
 * `noteKill` is NOT here — it belongs with `noteCasualty`, which already walks
 * exactly the bodies that died and already knows the monster/player split.
 */
function noteBlows(effect: Effect, run: Run): void {
  const talents = run.ctx.talents;
  if (talents === undefined) return;
  for (const blow of blowsOf(effect)) {
    if (!blow.hit || blow.damage <= 0) continue;
    talents.noteStruck(blow.targetId);
  }
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE PUNISH. SOMETHING HIT A GUARDED BODY, SO WHOEVER IS GUARDING IT SWINGS.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Called from the two lanes that produce a landed weapon swing, right after the
 * blow's own bookkeeping, with the lane's identity — the same shape and the same
 * placement as `noteBlows` and `noteCasualty`, because a counter is exactly a
 * blow's consequence and has to narrate inside the batch the client is pacing.
 *
 * ═══ WHAT MUST BE TRUE BEFORE ANYBODY SWINGS BACK ═══
 * A LANDED BLOW WITH DAMAGE ON IT. A miss is not something to punish, and a
 * fully-armoured 0 is the same non-event `noteBlows` already refuses to pay
 * Resolve for. Using the same test in both places is deliberate: "the Watchman
 * was hit" must mean one thing.
 *
 * ═══ THE GUARDIAN IS THE KILLER, NOT THE ACTOR WHOSE TURN IT IS ═══
 * This is the whole reason the counter is not folded into the `attack` Effect.
 * `noteCasualty` takes ONE `killerId` and spends it on `noteKill` (the
 * Alchemist's reagent) and on `awardExperience`. A counter that killed the husk
 * while riding on the monster's effect would have paid the MONSTER's kill credit
 * and awarded the xp to the monster's party, which is nobody. So the counter is
 * re-entered as its OWN one-blow effect with the guardian's id, and every rule
 * downstream — the reap enrolment, the idempotence, the party share — applies to
 * it unchanged and in exactly one place.
 *
 * ═══ IT DOES NOT RECURSE, AND THAT IS BY CONSTRUCTION ═══
 * No call to `noteGuardCounter` from inside itself. A counter that could be
 * countered is two Watchmen guarding each other swinging until one dies inside a
 * single turn. `resolveGuardCounter`'s `isEnemy(guardian, attacker)` would stop
 * the two-Watchman case anyway, but relying on that would make the recursion
 * bound an accident of the faction rule rather than a decision.
 *
 * ═══ THE PROJECTILE LANE IS DELIBERATELY NOT WIRED ═══
 * `actProjectile` also lands blows on players, and it does not call this. The
 * reason is reach rather than tidiness: `resolveGuardCounter` requires the
 * guardian to be within `attackRange` of the ATTACKER, and the only thing in the
 * game that throws an orb is a `ranged_kiter` whose entire behaviour is staying
 * out of exactly that reach. Wiring it would add a guaranteed-null call to the
 * hottest lane in the pump. The day something shoots from two tiles away this
 * line moves, and it is one line.
 */
function noteGuardCounter(
  effect: Effect,
  run: Run,
  sweepTurn: number | null,
  attackerId: string,
): void {
  if (effect.kind !== 'attack') return;
  if (!effect.hit || effect.damage <= 0) return;

  const talents = run.ctx.talents;
  if (talents === undefined) return;

  const counter = talents.guardCounter(attackerId, effect.targetId);
  if (counter === null) return;

  // `hp` and `at` are read HERE, one line after the counter landed, for the same
  // reason `strike` reads them one line after its own blow: `Blow` snapshots the
  // two things that stop being true immediately. The body is still in the world
  // even if the counter killed it — `noteCasualty` ENROLS a dead monster and the
  // caller buries it after the pump returns.
  const victim = run.world.getActor(counter.hit.targetId);
  const blow: Blow = {
    targetId: counter.hit.targetId,
    hit: counter.hit.hit,
    crit: counter.hit.crit,
    type: counter.hit.type,
    damage: counter.hit.damage,
    killed: counter.hit.killed,
    hp: victim?.hp ?? 0,
    at: { x: victim?.x ?? 0, y: victim?.y ?? 0 },
  };

  // THE ORDINARY `attacked` EVENT, ATTRIBUTED TO THE GUARDIAN. No new event
  // kind and therefore no protocol bump: src/shared/version.ts records that a
  // new `TurnEvent` variant independently forces one, and a counter-swing is a
  // swing. The client already draws it, and the Case Log already narrates it.
  if (sweepTurn === null) run.sink.push(attackedEvent(counter.guardianId, blow));
  else run.sink.sweep(sweepTurn, { t: 'attack', id: counter.guardianId, ...blow });

  const counterEffect: Effect = { kind: 'attack', ...blow };
  noteBlows(counterEffect, run);
  noteCasualty(counterEffect, run, sweepTurn, counter.guardianId);
}

/** Every body this effect killed. Empty for anything that killed nothing. */
function killedBy(effect: Effect): readonly string[] {
  if (effect.kind === 'attack') return effect.killed ? [effect.targetId] : [];
  if (effect.kind !== 'talent') return [];
  const dead: string[] = [];
  for (const blow of effect.blows) {
    if (blow.killed) dead.push(blow.targetId);
  }
  return dead;
}

/**
 * A blow landed and somebody stopped moving. PLAYERS GO DOWN; MONSTERS ARE REAPED.
 *
 * The one place a casualty is turned into an event, called from all three lanes
 * (player, sweep, projectile) with the lane's identity, so a detective hitting
 * the floor mid-sweep stays inside the batch the client is already pacing.
 *
 * Reading `killed` off the effect rather than re-checking `alive` is deliberate:
 * `damage.ts:589` returns an empty outcome against something already down, so
 * `killed` is true exactly once per body — which is what makes both branches
 * below idempotent for free. A victim hit twice inside one sweep cannot be
 * re-enrolled, cannot re-fire the wipe check, and cannot appear on the reap list
 * twice.
 */
function noteCasualty(effect: Effect, run: Run, sweepTurn: number | null, killerId: string): void {
  for (const targetId of killedBy(effect)) {
    const victim = run.world.getActor(targetId);
    if (victim === undefined) continue;

    /**
     * ═════════════════════════════════════════════════════════════════════════
     * A MONSTER JOINS THE REAP LIST. IT IS NOT REMOVED HERE.
     * ═════════════════════════════════════════════════════════════════════════
     *
     * `Actor.lua:2975` -> `ActorLife.lua:86-94` removes the entity as the last
     * act of dying. We enrol instead and let the caller bury the body, because
     * the Record lane still has to NAME it: it re-resolves ids through
     * `world.getActor` after the pump has returned, so a body deleted here
     * narrates as "someone 0/0" and an orb in flight loses its shooter. See
     * `PumpResult.reaped`.
     *
     * THE GUARD IS POSITIVE. Not "not a player", not `!alive`: a DOWNED body is
     * `alive === false` on purpose and deleting one loses somebody's character
     * (engine/downed.ts:20-36), and `world.removePlayer` is literally the same
     * closure as `world.removeActor` (the `removePlayer: removeActor` row in
     * world.ts's returned literal), so a mistake here is
     * unrecoverable rather than merely wrong.
     */
    if (victim.kind === ActorKind.Monster) {
      run.reaped.push(victim.id);
      /**
       * ═════════════════════════════════════════════════════════════════════
       * AND THE KILLER IS PAID. THE ONE PLACE IN THE GAME THAT DOES.
       * ═════════════════════════════════════════════════════════════════════
       *
       * `TalentResolution.noteKill` has the full argument. In short: the only
       * two callers of `TalentEngine.noteKill` were inside engine/talents.ts's
       * own damage helpers, so the basic weapon swing — which is where most of
       * an Alchemist's kills come from — paid nothing, her eight reagents
       * drained monotonically, and her whole hotbar answered `no_resource`
       * permanently with `noteStairs` unreachable in a floor that has no stairs.
       *
       * HERE, because `killed` is true exactly once per body (damage.ts:589
       * returns an empty outcome against something already down), so this cannot
       * double-pay a party of four racing the same husk — the same property that
       * makes the reap enrolment above idempotent.
       *
       * MONSTERS ONLY, and that falls out of the branch rather than needing a
       * guard: nothing pays for putting a PLAYER down, which is the arm below.
       */
      run.ctx.talents?.noteKill(killerId);
      // AND THE EXPERIENCE, ON THE SAME LINE OF REASONING AND FOR THE SAME
      // REASON IT IS HERE RATHER THAN IN A TALENT. See `awardExperience`.
      awardExperience(run, killerId, victim);
      // ...AND THE BODY EMPTIES ITS POCKETS ONTO THE TILE IT FELL ON. See
      // `spillLoot`: it takes NO DRAW, and it is here rather than at the kill
      // site in damage.ts for exactly that reason.
      spillLoot(run, victim, sweepTurn);
      continue;
    }

    const survival = run.survival;
    // No survival system wired in: M3 exactly — a player at 0 hp is a corpse,
    // and a corpse is not reaped either. See `PumpCtx.downed`.
    if (survival === null) continue;

    const record = goDown(survival.state, victim, run.world.turn.clock.gameTurn);
    if (record === null) continue; // already on the floor

    const step = {
      t: 'downed',
      id: victim.id,
      turnsLeft: record.turnsLeft,
      // WHO PUT THEM THERE — the same id the experience and the kill credit
      // were just paid on, so the log, the screen and the ledger cannot
      // disagree about who did this.
      byId: killerId,
    } as const;
    if (sweepTurn === null) run.sink.push(step);
    else run.sink.sweep(sweepTurn, step);

    // THE LANE TRAVELS WITH IT. A wipe caused by a monster's blow must narrate
    // after that blow, and the caller cannot work out which lane it belongs to
    // once the event list has been split. See `GameEvent.party_wipe.duringSweep`.
    checkWipe(run, sweepTurn);
  }
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE CORPSE EMPTIES ITS POCKETS. NOT ONE RANDOM NUMBER IS DRAWN HERE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ═══ WHAT IT PORTS ═══
 * `Actor:die`, modules/tome/class/Actor.lua:3011-3060. Upstream's death spill
 * walks the creature's ALREADY-RESOLVED inventories and calls
 * `game.level.map:addObject(dropx, dropy, o)` on each; the drop TABLE was rolled
 * back at entity resolution (`resolvers.calc.drops`, resolvers.lua:427-450). The
 * only draws anywhere in `Actor:die` are the cosmetic blood roll at :3008 and one
 * boss-artifact refusal at :3044, and we have neither. So this function is
 * upstream's shape and upstream's draw count: ZERO.
 *
 * ═══ WHY THAT IS THE ONE PROPERTY WORTH THE WHOLE DESIGN ═══
 * This runs inside `noteCasualty`, inside the pump, on a stream (`world.rng`)
 * consumed linearly by `combat.checkhit`, `combat.crit`, `combat.bump.damage`,
 * `ai.fire.chance`, `ai.flee.side`, `ai.flee.hardside` and `ai.target.keep`. One
 * new draw at the moment a monster dies moves every subsequent draw in that pump
 * and in every pump after it — shared/rng.ts:31-39 states the rule outright:
 * renaming a label never alters a replay, adding or removing a DRAW always does.
 * A drop roll HERE would have been the single most expensive line in the feature.
 * It is at spawn instead (content/encounter.ts), on a third forked stream.
 *
 * ═══ THE ORDER IS SORTED, NEVER MAP-INSERTION ORDER ═══
 * Delegated to `LootResolution.spillOrder`, which is where the content-side
 * SLOT_ORDER lives. Actor.lua:3038 sorts the inventories explicitly and :3040
 * iterates each in reverse for exactly this reason: two runs from the same seed
 * that produce the same items in a different FLOOR order have a different tile
 * list, therefore a different pickup index, and the bug presents as "the wrong
 * item got picked up".
 *
 * ═══ IDEMPOTENCE IS FREE, AND THEN BOLTED DOWN ANYWAY ═══
 * `killedBy` reads the `killed` flag off the effect rather than re-checking
 * `alive`, and `damage.ts:589` returns an EMPTY outcome against something already
 * down — so `killed` is true exactly once per body and this runs exactly once per
 * corpse. That is the same property that stops the reap list double-enrolling and
 * `noteKill` double-paying. Clearing the two fields below is belt to that brace:
 * even if a future path did re-enter, the second visit finds an empty body and
 * `spillOrder` answers with an empty list.
 *
 * ═══ THE BODY IS STILL IN THE WORLD WHEN THIS RUNS ═══
 * `noteCasualty` ENROLS a dead monster and the caller buries it after the pump
 * returns (see `PumpResult.reaped`), so `victim.x/y` is still the tile it died
 * on. Spilling after the reap would have nowhere to spill to.
 */
function spillLoot(run: Run, victim: EngineActor, sweepTurn: number | null): void {
  const loot = run.ctx.loot;
  if (loot === undefined) return;

  const itemIds = loot.spillOrder(victim);
  if (itemIds.length === 0) return;

  // SNAPSHOTTED ONCE, BEFORE ANYTHING ELSE. Both the ground items and the event
  // read this object rather than the body, so a coat and the log line that
  // announces it can never disagree about where the body fell.
  const at = { x: victim.x, y: victim.y };
  for (const itemId of itemIds) run.world.addGroundItem(at, itemId);

  // THE BODY IS EMPTY NOW, AND SAYING SO IS NOT COSMETIC. It is enrolled for
  // reaping on this same pump, so nothing will read it again in practice — but
  // "in practice" is how an item ends up existing twice, once on the floor and
  // once on a corpse that a resync happened to ship first.
  //
  // `equipped` is cleared without recomposing the sheet, deliberately: the fold
  // in engine/effects.ts#recomposeCombat needs the catalogue, which this file may
  // not see, and a dead body's combat sheet has no reader — `combatDamage` is
  // only ever asked of something that is about to swing.
  victim.carried = [];
  victim.equipped = {};

  const step = { id: victim.id, at, itemIds } as const;
  // THE SAME LANE SPLIT `downed` MAKES TWENTY LINES DOWN, and for the same
  // reason: a push closes any open sweep batch (`createEventSink`), so a monster
  // that dies to a guard counter halfway through the monster turn would fragment
  // one sweep into three if this took the player lane unconditionally.
  if (sweepTurn === null) run.sink.push({ t: 'spilled', ...step });
  else run.sink.sweep(sweepTurn, { t: 'spill', ...step });
}

// ---------------------------------------------------------------------------
// Experience — the award, the party share, and the level on the base clock
// ---------------------------------------------------------------------------

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ONE HUSK DIED. EVERY MEMBER OF THE KILLER'S PARTY BANKS THE FULL AWARD.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ═══ THERE IS NO `Ported from` HEADER ON THIS FUNCTION AND THERE MUST NEVER BE
 * ONE. ToME HAS NO PARTY EXPERIENCE RULE AT ALL. ═══
 *
 * The share rule below is an ORIGINAL DESIGN, recorded as DECISIONS.md D12, and
 * the absence upstream was verified three ways rather than assumed:
 * `modules/tome/class/Party.lua` contains ZERO occurrences of `exp` — no award,
 * no split, no proximity check; `modules/tome/class/Player.lua` contains ZERO
 * `gainExp`; and across the whole tome module there is exactly ONE combat award
 * site, `class/Actor.lua:2985-2987`, which pays `src:resolveSource()` AND NOBODY
 * ELSE. ToME is single-player: its party members level independently and only
 * the actor that landed the blow is paid. Citing a Lua line here would be
 * provenance for a mechanic that does not exist upstream, which is precisely the
 * failure `src/server/content/resolvers.ts` was rewritten to prevent — and
 * CLAUDE.md's THE LUA WINS rule cuts both ways: the Lua also wins when it is
 * silent.
 *
 * THE RULE, AND THE ONE SENTENCE THAT DECIDES IT: division by headcount punishes
 * inviting a fifth friend, and a proximity radius punishes the Inspector, whose
 * `min_range 3` puts her out of any sensible radius while she is doing exactly
 * her job. Everything else — the full award, the flat share, the absence of a
 * last-hit bonus — follows from those two.
 *
 * ═══ A MEMBER WHO IS ON THE FLOOR STILL SHARES, AND THAT IS DELIBERATE ═══
 * game-design.md § 9 is "no permadeath, no loss": in this game `alive === false`
 * means DOWNED (or Erased, which the floor reset undoes on the same pump), not
 * dead. A player being carried is still on the case, and taxing them a level for
 * the crime of having been hit is the one thing § 9 rules out. D12's own wording
 * says "living, connected" — it was written before this question had a site to
 * be answered at, and its "dead players earn nothing" clause has no referent
 * until Sworn permadeath lands at M7. The `connected` half goes for the same
 * reason and D12's own consequences argue it: *"everyone is always the same
 * level"* is the property the whole rule exists to produce, and a friend whose
 * wifi blinked for twenty husks comes back a level short of it. A body that has
 * genuinely left the game is not in the party table at all — `forgetActor`
 * (party.ts:615-626) is what removes it.
 *
 * It has to be answered HERE and in a comment rather than by accident, because
 * party.ts:79-91 is explicit that the party table knows nothing about actors:
 * `membersOf` hands back ids and has no opinion about which of them are standing.
 *
 * THE GUARD ORDER IS LOAD-BEARING, EVERY STEP OF IT.
 */
function awardExperience(run: Run, killerId: string, victim: EngineActor): void {
  /**
   * 1. THE KILLER MAY NOT EXIST. The projectile lane freezes `sourceId` at the
   *    muzzle and the shooter can be several game turns dead by the time the orb
   *    lands — `PumpResult.reaped`'s own doc says the reap window "does not cover
   *    an orb in flight" and never could. An exception raised here escapes
   *    through `pump` into a ws handler and takes the process with it, so this is
   *    a lookup and a return rather than a `!`.
   */
  const killer = run.world.getActor(killerId);
  if (killer === undefined) return;

  /**
   * 2. AND IT MAY BE A MONSTER — BEFORE ANY party.ts CALL, WHICH IS THE WHOLE
   *    POINT OF THE ORDER. Monster-kills-monster is representable (a stray orb,
   *    a future charm) and `partyOf` MUTATES: it mints a party on demand and says
   *    so at party.ts:275-290, "IT MUTATES, AND THAT IS THE CONTRACT". Both
   *    `membersOf` and `partyIdOf` go through it. Touching the table with a
   *    husk's id therefore leaves a party row for a body that only `forgetActor`
   *    ever clears — a leak with no symptom, which is why the test for it asserts
   *    on `state.byId.size` rather than on anything a player could see.
   */
  if (killer.kind !== ActorKind.Player) return;

  /**
   * 3. WHO IS PAID. `PumpCtx.parties` is already in scope through `run.ctx`, so
   *    there is no new plumbing: with no party table wired in this is the
   *    pre-party game exactly, one recipient, and with one it is the killer's
   *    whole party INCLUDING the killer (`membersOf` returns them).
   */
  const recipients =
    run.ctx.parties === undefined ? [killerId] : membersOf(run.ctx.parties, killerId);

  for (const recipientId of recipients) {
    // 5. Ids, not bodies (see the party.ts note above), so each is resolved and
    //    anything that is not a player is skipped. NO DIVISION BY HEADCOUNT, NO
    //    PROXIMITY CHECK, NO RADIUS, and no `alive`/`connected` filter.
    const member = run.world.getActor(recipientId);
    if (member === undefined || member.kind !== ActorKind.Player) continue;

    /**
     * ═════════════════════════════════════════════════════════════════════════
     * 6. THE AWARD IS COMPUTED PER RECIPIENT, FROM THE RECIPIENT'S OWN LEVEL.
     * ═════════════════════════════════════════════════════════════════════════
     *
     * `worthExp` is `level × rankWorth(rank) × XP_WORTH_MULT`, and the `level`
     * it wants is the level of THE ACTOR BEING PAID — which is what its own
     * `@param` says, and which is a deliberate deviation from Actor.lua:6513-6531
     * (upstream uses the victim's) argued at length in src/shared/progression.ts.
     *
     * ═══ IT USED TO BE COMPUTED ONCE, FROM THE KILLER, AND PAID TO EVERYBODY ═══
     * The defence was that the difference is unobservable "because full-share
     * keeps the party at one level". NOTHING ENFORCES THAT INVARIANT, and an
     * ordinary multiplayer event falsifies it on the first kill: a fifth friend
     * joins mid-session at level 1, accepts an invite, and from that moment the
     * party's whole xp rate is set by WHOEVER HAPPENS TO LAND THE KILLING BLOW.
     * Four level-8 players earned 25.6 a husk when one of them last-hit and 3.2
     * when the newcomer did — an eightfold swing on identical work, with no log
     * line and nothing in the UI to explain it, and a standing incentive to feed
     * every last hit to the highest-level player.
     *
     * ONE LINE MOVED INSIDE THE LOOP REMOVES ALL OF IT. The killer's level is
     * now irrelevant to everybody but the killer, each member's own progression
     * is self-consistent whatever the party's composition, and the full share
     * (DECISIONS.md D12 — no division by headcount, no proximity radius) is
     * untouched: everybody is still paid for every kill, at their own rate.
     *
     * A LEVEL-HOMOGENEOUS PARTY — which is every party this has ever been tested
     * with, and the only one the old claim was true for — sees byte-identical
     * numbers, because every recipient's level IS the killer's.
     */
    const award = worthExp(member.level, victim.rank);

    /**
     * `gainExp` IS PURE AND RETURNS A NEW PAIR — it does not mutate, so the
     * assignment is the moment the character changes and there is no window in
     * which a half-levelled actor is observable by the synchronous turn loop.
     *
     * `level` and `xp` LAND NOW; the POINTS do not. Neither of these two numbers
     * is read by any dice roll, so moving them mid-pump moves no draw. A talent
     * point is the opposite: it can be spent, and a spent point changes
     * `combatTalentScale`'s answer. See `applyPendingLevels`.
     */
    const gained = gainExp(member.level, member.xp, award);
    member.level = gained.level;
    member.xp = gained.xp;
    member.pendingLevels += gained.levelsGained;

    /**
     * ═══ AND THE STAIRS SHUT FOR A MOMENT — `last_kill_turn`, Game.lua:880 ═══
     *
     * Anti-stairscum: walk in, kill the first thing, walk straight back out to a
     * freshly generated floor. See `NO_STAIRS_GAME_TURNS`.
     *
     * ON THE SAME LOOP AS THE EXPERIENCE, deliberately. This file has already
     * decided a kill is the PARTY's event — no division by headcount, no
     * proximity check — and the exploit needs that reading to be closed: charge
     * only the killer and one player kills while another opens the door. Riding
     * the existing loop is also what stops the two answers to "whose kill was
     * that" from drifting apart.
     */
    member.lastKillTurn = run.world.turn.clock.gameTurn;
  }
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * PAY OUT THE BANKED LEVELS. ONCE PER GAME TURN PER ACTOR, ON THE BASE CLOCK.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The award side runs the instant something dies, which is the middle of a pump.
 * The pump walks ONE FROZEN ACTOR SNAPSHOT and every RNG draw in it is labelled
 * and ordered, so anything that can change a formula's answer between the first
 * and the third blow of one AoE moves the stream and breaks replay-from-seed
 * (CLAUDE.md § 3). A talent point can do exactly that — one point raises a raw
 * talent level, and `combatTalentScale` reads raw talent levels — so the points
 * are banked in `pendingLevels` and handed out HERE, beside `actBase`, which is
 * the once-per-game-turn-per-actor hook everything speed-independent already uses
 * (`TalentResolution.actBase`, and tome/class/Actor.lua:476-609 for the pass itself).
 *
 * The levels being paid for are the TOP `pendingLevels` levels of the character:
 * a second kill later in the same pump raises both numbers together, so the
 * window never slides. `pointsForLevel` is what makes the fifth level worth two.
 */
function applyPendingLevels(actor: EngineActor, run: Run): void {
  if (actor.kind !== ActorKind.Player || actor.pendingLevels <= 0) return;

  const from = actor.level - actor.pendingLevels + 1;
  actor.pendingLevels = 0;

  for (let level = from; level <= actor.level; level += 1) {
    // ONE GRANT PER LEVEL CROSSED, never one per award: a boss that carries a
    // character from 4 to 6 owes the level-5 pair AND the level-6 single.
    actor.unspentPoints += pointsForLevel(level);
    // AND THE GENERIC POINT, which is the same grant seen from the other side:
    // two a level, always, and a fifth level moves one of them across.
    actor.unspentGenerics += genericPointsForLevel(level);
    // AND, AT TEN, TWENTY AND THIRTY-SIX, A WHOLE DISCIPLINE. Actor.lua:3757-3760.
    // In the same loop and on the same per-level-crossed rule as the other
    // three: a boss that carries a character from 9 to 11 owes the level-10
    // category point, and granting it from a different site is how one of them
    // silently stops arriving.
    actor.unspentCategories += categoryPointsForLevel(level);
    // AND THE THREE ATTRIBUTE POINTS, on the same per-level-crossed rule and in
    // the same loop. `Actor.lua:3748` grants both in one place too — a level is
    // one event that owes two currencies, and granting them from two different
    // sites is how one of them silently stops arriving.
    actor.unspentStatPoints += statPointsForLevel(level);
    // A RECORD LINE, NOT AN EVENT — see `PumpCtx.onLevelUp`. One call per level,
    // in order, so the log reads "Ren reaches level 5. Ren reaches level 6."
    // rather than silently swallowing the level nobody saw.
    run.ctx.onLevelUp?.(actor.id, level);
  }
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
 * A WIPE COSTS HIT POINTS AND POSITION. IT DOES NOT COST PROGRESSION.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `resetFloorParty` restores hp, `alive`, the sprite and both clocks, and it
 * touches NOTHING ELSE — `level`, `xp`, `unspentPoints` and `pendingLevels` all
 * survive a wipe untouched, which is game-design.md § 9's "no permadeath, NO
 * LOSS" read at its word. This is stated from both sides on purpose: a reset
 * that quietly zeroed a level would look identical to a working one from in
 * here, and would be found by a player at the end of an evening rather than by
 * anything that fails. test/server/progression-award.test.ts pins it.
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

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * MAY THIS ACTOR KEEP GOING? Four clauses, and three of them are refusals.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * OUT OF COMBAT, NEVER. Free movement is the whole point of a quiet floor —
 * `engagement <= 0` means nothing is waiting on anybody, the pump idles at a
 * fixed point, and holding a round open there would invent a turn structure
 * where the game deliberately has none.
 *
 * ONLY A TALENT, and this is the clause that makes the change balance-neutral
 * on movement. If a step left the round open, "swing then walk away for free"
 * would be available to everybody from the first fight, which is a bigger
 * change to how combat feels than the budget itself. A move closes the round,
 * so step-then-act is impossible too — both directions cost a round, exactly as
 * they do today. Movement joins the budget with its own commit and its own
 * price, deliberately.
 *
 * A HARD CEILING, belt-and-braces. AP is the real limiter and this should never
 * bind — the cheapest talent is 2 of 6 — but a bug in the budget that let a
 * round run forever would freeze the floor for everybody in it, and a constant
 * is a cheaper guarantee than a proof.
 *
 * AND THE SEAM ANSWERS `=== true`, so a scheduler built without a talent
 * runtime — which is most of the test suite, every fixture, and every tool —
 * closes every round after one action exactly as it always has.
 */
function roundStaysOpen(
  actor: PlayerActor,
  intent: Intent,
  run: Run,
  /** True only for a move that actually moved — see `actPlayer`. */
  wasStep: boolean,
): boolean {
  if (run.world.turn.engagement <= 0) return false;
  if (actor.roundActions >= MAX_ACTIONS_PER_ROUND) return false;
  /**
   * A MOVE MAY NOW KEEP THE ROUND OPEN, and it did not in C3.
   *
   * That commit refused every non-talent deliberately, because a step that left
   * the round open while nothing charged for it would have handed everybody
   * "swing then walk away for free" from the first fight. `spendMove` is what
   * removed that objection: a step costs 1 MP out of 3, so walking is bounded
   * by the same round everything else is.
   *
   * THE CHARGE HAPPENS AT THE SITE THAT RESOLVES THE MOVE, not here — this
   * predicate must stay a question. See `actPlayer`.
   */
  if (intent.kind !== IntentKind.Talent && !wasStep) return false;
  return run.ctx.talents?.roundOpen(actor.id) === true;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE TAIL — a per-player deadline, and WITHOUT IT THE FLOOR FREEZES FOREVER.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * This is not a nicety. Three independent design reviews found the same hole
 * and none of the three proposed designs had closed it.
 *
 * `barrier.ts` arms the Bell only when `blocking.length <= 1`. Today that is
 * safe because the blocking set drains monotonically: everybody owes exactly one
 * decision, so it only ever shrinks. UNDER AN OPEN ROUND A PLAYER WHO ACTS
 * RE-ENTERS THE BLOCKING SET — their intent is cleared and their energy is
 * unspent, which is precisely what `isBlocking` reads.
 *
 * So two people holding leftover budget who have mentally finished and turned
 * back to the voice channel leave `blocking.length === 2` permanently. `armed`
 * is false, so no countdown starts; `expire` returns `EMPTY_PASSES` on
 * `!state.running`, so Standing By cannot rescue it either. The level stops:
 * no monsters, no orbs, no sweep, no server-side recovery, until a human
 * happens to press a key.
 *
 * ═══ WHY IT IS NOT THE BELL, AND MUST NOT BE ═══
 * The Bell is about a player who is ABSENT. It counts `autoPasses`, and two of
 * those is Standing By — a bench. The Tail is about a player who is PRESENT and
 * still thinking, and benching them for taking six seconds over a second action
 * would punish exactly the behaviour this feature exists to create. So it
 * installs `HOLD_INTENT` and touches no barrier bookkeeping at all: the close
 * routes through the ordinary path, `roundStaysOpen` refuses a hold,
 * `spendTurn` fires, and both fields clear.
 *
 * ═══ WALL CLOCK, FOR THE REASON A TOWN TAUGHT US ═══
 * `shared/energy.ts` advances `gameTurn` only while something can gain energy,
 * and a table sitting mid-round thinking is by definition not advancing it. A
 * game-turn deadline would never arrive — the same trap that nearly shipped in
 * the townsfolk dialogue.
 *
 * ═══ SOLO IS NEVER HURRIED ═══
 * At a quorum of one there is nobody to keep waiting, and a six-second clock on
 * a person playing alone is a stopwatch nobody asked for. The Solo Bell already
 * covers the absent case at 120s.
 */
function applyRoundTails(
  actors: readonly EngineActor[],
  ctx: PumpCtx,
  scope: PartyScope | undefined,
): void {
  // SOLO IS NEVER HURRIED. `inQuorum` is the same test the Bell's `canDecide`
  // uses, so "how many people are we waiting on" has one answer in this file.
  let inParty = 0;
  for (const actor of actors) {
    if (inScope(actor.id, scope) && inQuorum(actor)) inParty += 1;
  }
  if (inParty <= 1) return;

  for (const actor of actors) {
    if (actor.kind !== ActorKind.Player) continue;
    if (!inScope(actor.id, scope)) continue;
    if (actor.roundTailMs === null || ctx.nowMs < actor.roundTailMs) continue;
    // THE ORDINARY PATH. A hold is refused by `roundStaysOpen`, so it resolves,
    // spends the turn, and clears the round — no special close to keep in step.
    actor.pendingIntent = HOLD_INTENT;
    actor.roundTailMs = null;
  }
}

/** Is any hostile pair currently in view of each other?
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE FOURTH COPY OF "SAME KIND MEANS SAME SIDE", AND THE WORST PLACED OF THEM.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The docblock said "hostile pair" and the code asked `kind`. Three other sites
 * made the same substitution — `isHostile`, `talents.ts#isEnemy`, and an inline
 * comparison in `canUseTalent` — and all three were found by looking for them.
 * THIS ONE WAS FOUND BY RUNNING THE TESTS, because what it does is not subtle:
 *
 * A Common realm is a TOWN, shared by every party in it, and it is shareable
 * precisely because nothing in it ever lifts `engagement` above zero. Put one
 * friendly shopkeeper in line of sight of a player and this function returns
 * true, `updateEngagement` sets `ENGAGEMENT_TURNS`, and `isBlocking` then
 * answers true for every unrelated player standing in that town — all of them
 * waiting on people they never agreed to play with, with a Bell running and
 * nothing on screen explaining why. Permanently, because she never leaves.
 *
 * `test/server/realms.test.ts` already spelled that consequence out in full,
 * under a test asserting towns hold no monsters at all. It is the reason the
 * emptiness assertion existed, and it is why placing one person broke it.
 *
 * `areEnemies` is the one answer. A townsfolk is nobody's enemy, so she is not
 * contact, so a town stays a town.
 */
function anyContact(world: World, actors: readonly EngineActor[]): boolean {
  for (const monster of actors) {
    if (monster.kind !== ActorKind.Monster || !monster.alive) continue;
    for (const player of actors) {
      if (player.kind !== ActorKind.Player || !player.alive) continue;
      // FACTION, NOT KIND. See the header.
      if (!areEnemies(monster, player)) continue;
      if (chebyshev(monster, player) > monster.ai.aggroRange) continue;
      if (hasLineOfSight(world.level, monster, player)) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// The AI's view of the world
// ---------------------------------------------------------------------------

function makeAiCtx(
  world: World,
  actors: readonly EngineActor[],
  /**
   * THE TALENT SEAM, FORWARDED. Absent for every build with no talent book, and
   * an absent `castable` reads as "this creature knows nothing" — which is what
   * nearly every monster in the game is.
   */
  talents?: TalentResolution,
): AiCtx {
  return {
    // TERRAIN ONLY — see the note in ai/npc.ts. Handing A* an actor-aware
    // predicate is how you get monsters that never land a blow.
    isPassable: (x, y) => canWalk(world.level, x, y),
    actorAt: (x, y) => world.actorAt(x, y),
    visibleEnemies: (self) => visibleEnemies(self, world, actors),
    rng: world.rng,
    // FORWARDED WITHOUT A DEFAULT. `castable` is optional on both sides, so a
    // resolution that cannot answer and a build with no resolution at all
    // produce the identical empty list rather than two different silences.
    ...(talents?.castable === undefined
      ? {}
      : { castable: (self, target) => talents.castable?.(self, target) ?? [] }),
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
