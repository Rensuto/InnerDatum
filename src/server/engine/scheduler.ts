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

import { dirFromVector, step } from '../../shared/coords.ts';
import { tileDistance } from '../../shared/distance.ts';
import { ActResult, tickLevel } from '../../shared/energy.ts';
import { canRoute, canWalk, tileAt } from '../../shared/level.ts';
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
import { decideNpcAction, decideSquadAction, followStep } from '../ai/npc.ts';
import type { MonsterCast } from '../ai/npc.ts';
import { fieldOfView } from '../../shared/sight.ts';
import {
  Faction,
  HOLD_INTENT,
  IntentKind,
  actBase,
  areEnemies,
  catchBreath,
  cooldownOf,
  isHostile,
  isMonster,
  setCooldown,
  spendTurn,
} from './actor.ts';
import { AttackRefusal, attackTarget, canAttack } from './combat.ts';
import type { AttackResult } from './combat.ts';
import { TalentRefusal } from './talents.ts';
import type { KillNote } from './talents.ts';
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
import { combatAPR, combatMindpower } from './derived.ts';
import { applyDamage, combatGetAffinity, combatGetResist, splitBurn } from './damage.ts';
import { teleportRandom } from './talents.ts';
import { canOpenDoors } from './doors.ts';
import { capitalize, trapSentence, trapTakes } from './traps.ts';
import {
  BUBBLES_DEPLETED,
  bubbleOf,
  burnMessage,
  burnOf,
  rollBurn,
  spendsBubble,
  terrainSourceId,
} from './onstand.ts';
import { soundAlarm } from '../ai/alarm.ts';
import { tickZones, visibleFrom } from './zones.ts';
import { DAMAGE_TYPES } from '../../shared/damagetype.ts';
import { DEFAULT_PROJECTILE_DAMAGE_TYPE, stepProjectile } from './projectile.ts';
import type { Dir, TileXY } from '../../shared/coords.ts';
import type { EnergyActor } from '../../shared/energy.ts';
import type { ActorRank, TalentShape } from '../../shared/protocol.ts';
import type { AiCtx } from '../ai/npc.ts';
import { MoveBlock } from '../world/world.ts';
import type { World } from '../world/world.ts';
import type {
  EngineActor,
  Intent,
  MonsterActor,
  PlayerActor,
  StatusPass,
  TerrainProbe,
} from './actor.ts';
import { airOf } from '../../shared/terrain.ts';
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
  /**
   * HELD WHERE YOU STAND — `EFF_PINNED`, `Actor.lua:1338`.
   *
   * NEVER `Terrain` OR `Occupied`. Both of those describe the TILE and send a
   * player looking for another one; this is about the body, and every other
   * direction is refused too. A refusal reaches the client as a bare string
   * (see `TooClose` below), so a new one costs no protocol change and saying
   * the true thing is free.
   */
  Pinned: 'pinned',
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
      /** Nobody swung — see `GameEvent.attacked.ambient`. */
      readonly ambient?: boolean;
      readonly killed: boolean;
      /**
       * THE TARGET'S HP AND TILE THE INSTANT THIS BLOW LANDED. See
       * `GameEvent.attacked` for why both are snapshotted here rather than read
       * off the body later.
       */
      readonly hp: number;
      /**
       * AND ITS MAXIMUM, SNAPSHOTTED FOR THE SAME REASON AND IT WAS NOT.
       *
       * `hitToWire` read this off the world AFTER the pump, under a note saying
       * *"`maxHp` genuinely cannot change during a fight, so there is nothing to
       * snapshot"*. True of the NUMBER and false of the BODY: a party wipe runs a
       * floor reset in the same pump as the blow and the reset removes every
       * hostile, so the lookup answered undefined and the fallback shipped ZERO.
       *
       * MEASURED, in `tools/first-death.mjs`, every run: *"11 physical damage.
       * Index Eidolon 67/0."* — the game's most-read line, saying a creature has
       * no maximum health. Same root cause as `killer-named.test.ts`'s
       * "someone", one field along.
       */
      readonly maxHp?: number;
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
      /**
       * NOBODY SWUNG — the floor did it. See `tickGroundZones` and
       * `hitToWire`'s `ambient`.
       *
       * A ground zone reuses this event rather than minting a variant of its
       * own, which is what let the whole system ship without a protocol bump.
       * This flag is the one thing that reuse gets wrong: an `attacked` event
       * implies a verb and a swinger, and a patch of fire has neither. Set, the
       * wire carries the damage alone.
       *
       * ENGINE-INTERNAL, like every field beside it. `GameEvent` is deliberately
       * NOT `ServerMsg` — see the note on the type — so this costs no version.
       */
      readonly ambient?: boolean;
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
       * AND ITS MAXIMUM, SNAPSHOTTED FOR EXACTLY THE SAME REASON.
       *
       * The paragraph above explains why `hp` may not be read off the body
       * afterwards; `maxHp` was left to be, under a note in `hitToWire` saying
       * it *"genuinely cannot change during a fight"*. True of the NUMBER and
       * false of the BODY — a party wipe runs a floor reset inside the same
       * pump, the reset removes every hostile, the lookup answers undefined and
       * the fallback ships ZERO. `tools/first-death.mjs` printed *"11 physical
       * damage. Index Eidolon 67/0."* on every run.
       *
       * OPTIONAL so every fixture that builds a blow by hand keeps compiling;
       * absent means "ask the world", which is what everybody did before.
       */
      readonly maxHp?: number;
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
      /** HP PUT BACK, with `amount` 0. See `StatusHit.healed`. */
      readonly healed?: number;
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
  /**
   * The tile the talent was AIMED at — the caster's own tile for a `self`
   * shape. For a ball or a cross thrown at a wall that is not the centre of the
   * stamp: it goes off on the last open tile before the wall (`ballCentre`,
   * shared/ball.ts), and main.ts fills this from the aim.
   */
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
/**
 * What one body's `callbackOnActBase` wants the scheduler to do about it.
 *
 * DECLARED HERE, NEXT TO THE SEAM THAT RETURNS IT, and imported BY
 * `talents/call_shadows.ts` rather than from it. `engine -> talents` is the
 * wrong direction: the engine offers a shape and content fills it, which is the
 * same arrangement `TalentResolution` itself has.
 */
export type SummonPassResult = {
  /**
   * Bodies whose leash broke. Enrolled in `PumpResult.reaped`, exactly as a
   * monster killed by a blow is — see `noteMonsterDeath` for why a body is
   * enrolled rather than deleted here.
   */
  readonly reap?: readonly string[];
  /** Case Log lines, in the order they happened. */
  readonly records?: readonly string[];
};

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
   * ═══════════════════════════════════════════════════════════════════════════
   * WHICH TALENTS THIS BODY COULD ACTIVATE — `who.talents`, filtered by mode.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * ```lua
   * for tid, lev in pairs(who.talents) do
   *   local t = who:getTalentFromId(tid)
   *   if not who.talents_cd[tid] and t.mode == "activated" then tids[#tids+1] = tid end
   * end
   * ```
   *
   * `traps/annoy.lua:36-40`. Upstream asks TWO questions there and only one of
   * them needs the registry: "is this talent activated rather than passive" is a
   * fact about the talent, and "is it on cooldown" is a fact about the body that
   * `cooldownOf` already answers from `actor.cooldowns`. So this returns the
   * whole activated set and the caller filters — which keeps the seam a question
   * about CONTENT and leaves the engine's own state in the engine.
   *
   * Ids are namespaced `talent:<id>`, the same keys `actor.cooldowns` uses.
   *
   * OPTIONAL, for `castable`'s reason: every fixture that builds a
   * `TalentResolution` by hand keeps compiling, and an absent answer reads as a
   * body with no talents — which is every monster in the game.
   */
  activatedOf?(actorId: string): readonly string[];
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
   *
   * `note` carries WHAT DIED — upstream pays four times as much for a boss
   * (`inkForKill`, engine/talents.ts). Required, for the reason given there.
   */
  noteKill(actorId: string, note: KillNote): void;
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
   * DOES THIS TALENT COST NO TURN? — upstream's `no_energy`, Actor.lua:5862-5863.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Every action spends the actor's turn, as ToME's does (`useEnergy`,
   * engines/default/engine/Actor.lua:478-484). The one exception upstream has is
   * a talent flagged `no_energy`: it is used and the player keeps the turn.
   *
   * OPTIONAL, AND ABSENT IS "EVERY TALENT COSTS A TURN", which is what a
   * scheduler built without a talent runtime has always done.
   */
  noEnergy?(talentId: string): boolean;
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
   * ═════════════════════════════════════════════════════════════════════════
   * A TALENT THAT REPLACES THE SWING — `Combat.lua:164-173`.
   * ═════════════════════════════════════════════════════════════════════════
   *
   * Upstream's `attackTarget` asks ONE question before the mainhand loop, the
   * offhand loop and the barehand fall-through: is Gesture of Pain up? If it
   * is, the gesture happens INSTEAD and `speed` is set, which is the flag all
   * three of those loops test with `if not speed`.
   *
   * `strike` is this engine's `attackTarget`, so this is that question, asked
   * in the same place. `mark` is handed over because `strike` has already
   * resolved it and a replaced blow is still a blow against a marked body.
   *
   * ═══ WHY IT RETURNS AN `AttackResult` AND NOT AN `Effect` ═══
   * So the substitution is TOTAL and invisible to everything downstream: the
   * event, the Case Log line, the alarm, the kill note and the refund rule all
   * read the same shape whether a stylus or a gesture produced it. A second
   * `Effect` kind would have meant a new case in every consumer for a blow that
   * differs only in how its number was arrived at.
   *
   * ABSENT, OR `null`, IS THE ORDINARY SWING — which is every body in the game
   * except a Redactor standing in the stance with both hands empty, and every
   * fixture that builds a `TalentResolution` by hand.
   */
  meleeReplacement?(attacker: EngineActor, target: EngineActor, mark: number): AttackResult | null;
  /**
   * ═════════════════════════════════════════════════════════════════════════
   * ONCE PER BODY PER BASE TURN, AFTER `actBase` — `callbackOnActBase`.
   * ═════════════════════════════════════════════════════════════════════════
   *
   * The summon clock. `tome/data/talents/cursed/shadows.lua:438-453` hangs Call
   * Shadows' whole cadence off exactly this callback: count down, summon, reset.
   * The leash that removes a shadow whose master is gone rides the same pass,
   * from the SHADOW's own base turn — upstream's `on_act` (:324-329).
   *
   * ═══ IT ANSWERS RATHER THAN ACTS, FOR THE ONE THING IT CANNOT DO ITSELF ═══
   * Adding a body is a world call and the seam has a world. BURYING one is not:
   * `PumpResult.reaped` is the channel, the caller drains it after the pump and
   * a body deleted mid-pump narrates as "someone". So a broken leash comes back
   * as an id and this file enrols it exactly as `noteMonsterDeath` does.
   *
   * ABSENT IS A BUILD WITH NO SUMMONS, which is every fixture and was every
   * build before this one.
   */
  summonPass?(actor: EngineActor): SummonPassResult;
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
   *
   * ═══ AND WHO PUT IT DOWN, BECAUSE ONE ITEM IN THE GAME ASKS ═══
   * `NPC:onDie` (tome/class/NPC.lua:393-406) does not spill the Rod of Recall
   * from a table at all: it checks the KILLER'S OWN CAMPAIGN LATCH
   * (`game.state:allowRodRecall()`, class/GameState.lua:93-96), mints the rod,
   * and spends the latch at :406 so no later boss ever drops another. That
   * question cannot be asked of the corpse, so the body that did the killing is
   * handed over with it. `null` is a body nobody is credited with — a bleed
   * whose author has already been buried, and `noteMonsterDeath`'s own
   * `killerId: string | null`.
   *
   * IT IS STILL A CONTENT DECISION AND IT STAYS ON THIS SIDE OF THE SEAM: the
   * engine knows nothing about which ids are handed over once, and `Item` is
   * `src/server/content/**`, which this file may not import.
   */
  spillOrder(actor: EngineActor, killer: EngineActor | null): readonly string[];
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
   * THE ONE STATUS THE GROUND LAYS ON A BODY — see `TerrainProbe.startSuffocating`.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `suffocate`'s `setEffect(EFF_SUFFOCATING, 1, {dam=20})` behind its
   * `hasEffect` guard (tome/class/Actor.lua:6733-6736). A closure for `applyStatus`'s
   * reason, and one more: this module names no authored effect, and the id is
   * content. `turn-engine.ts` builds it from the same `EffectCtx` as the clock
   * and the door, so the "Suffocating" note lands in the same drain.
   *
   * Absent → air still runs out and nothing hurts for it.
   */
  readonly startSuffocating?: (actor: EngineActor) => void;
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * A STATUS TICK HURT THIS BODY — take off what any damage takes off.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `onTakeHit` un-dazes on ANY damage (tome/class/Actor.lua:2156-2158), and a
   * bleed or a burn ticking is damage. A blow reaches the same rule through
   * `TalentResolution.noteStruck`, but that also pays the Watchman's Resolve
   * for absorbing a blow, and a DoT is not a blow — so the tick lane gets this
   * door alone. Built beside `startSuffocating` from the same `EffectCtx`.
   *
   * Absent → a tick breaks nothing, which is every fixture without a status table.
   */
  readonly breakOnDamage?: (actorId: string) => void;
  /**
   * AND THE WAY BACK OUT OF IT: `EFF_SUFFOCATING` removed with `force`, as
   * `cleanActor` removes it from a body death gives back
   * (dialogs/DeathDialog.lua:115). Called with `catchBreath` on every body a wipe
   * or a revive stands up — see `restoreBreath`.
   */
  readonly stopSuffocating?: (actor: EngineActor) => void;

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
   * ═══════════════════════════════════════════════════════════════════════════
   * IS THIS BODY STILL CARRYING SOMETHING THAT COUNTS AS THE FIGHT?
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `tome/class/Actor.lua:7658-7662`, inside `checkStillInCombat` and the one
   * clause of it this engine did not have:
   *
   * ```lua
   * -- Status effects need rechecking
   * for eff_id, p in pairs(self.tmp) do
   *   local e = self:getEffectFromId(eff_id)
   *   if e.status == "detrimental" and e.decrease > 0 then self:enterCombatStatus() break end
   * end
   * ```
   *
   * A DETRIMENTAL EFFECT THAT IS STILL COUNTING DOWN MEANS THE FIGHT IS NOT
   * OVER. Ours asked only whether a hostile was in view, so the last husk dying
   * ended combat while somebody was still bleeding out from it.
   *
   * `decrease > 0` is upstream's own guard and it is doing work: an effect that
   * does not tick down is a PERMANENT one, and a permanent debuff would
   * otherwise hold a level in combat for the rest of the session.
   *
   * A CLOSURE RATHER THAN THE EFFECT TABLE, for the reason `applyStatus` beside
   * it gives: this module must not learn what an effect IS. Absent means the
   * clause is skipped, which is every fixture that wires no effects and is
   * exactly the engine those fixtures were written against.
   */
  readonly stillFighting?: (actorId: string) => boolean;
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
   * Present → THE WIPE IS PER-PARTY. NOTHING ELSE HERE IS. `partyScopes` hands
   * one scope per party to `checkWipe`, and to nothing else, so a wipe resets
   * only the party that fell (DECISIONS.md D10).
   *
   * THE WAIT, THE BELL AND THE ROUND TAILS ARE THE REALM'S. `isBlocking` takes
   * no scope, and `tickLevel` parks the whole level on anybody who owes a
   * decision (shared/energy.ts: once anyone is parked, no monster acts). So
   * above `engagement > 0` every player in the realm waits on every other one,
   * party or not. That is ruled: D-A4 in the sight plan, recorded in
   * DECISIONS.md under "Sight is each player's own…" as "the engagement banner
   * and the turn barrier stay realm-wide", and world/realms.ts
   * keeps strangers out of one fight by instancing every combat space per
   * party, not by scoping the barrier. So the Bell's expiry, the round tails
   * and `PumpResult.bell` all ask the realm (`undefined`, barrier.ts's level
   * slot), and the Bell's length comes from the realm's quorum.
   *
   * THEY WERE PER PARTY UNTIL 2026-09-22, and in a realm holding two parties
   * that made the countdown disagree with the wait: an idle stranger, a party
   * of one, was on the two-minute Solo Bell while the gateway's timer ran the
   * twenty-second Normal one and the player held by them was shown nobody to
   * wait on. The pinning cases are test/server/cross-party-wait.test.ts.
   *
   * Production puts two parties in one combat realm with a party command issued
   * inside a delve — a `leave`, a `kick`, or an `accept` with no name; those
   * are the paths known. The bare accept takes the oldest invite and checks
   * nothing about where the inviter stands (`submitParty` in turn-engine.ts,
   * `findInvite` in engine/party.ts, `answerVerb` in client/input/commands.ts),
   * and a realm crossing does not clear invites. DECISIONS.md, 2026-09-22, "the
   * cross-party wait in combat", lists it for the author.
   *
   * ABSENT → the pre-party game, byte for byte: one level-wide Bell and one
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
 * THE DISTINCT PARTIES STANDING ON THIS LEVEL, in a deterministic order — FOR
 * THE WIPE, AND FOR NOTHING ELSE.
 *
 * `checkWipe` is the one question in this file a party answers (DECISIONS.md
 * D10: your party falling resets the floor for your party). The Bell, the round
 * tails and the wait are the realm's — see `PumpCtx.parties` — so nothing
 * else may start iterating this list without reading that note first.
 *
 * Derived from the world's TURN ORDER rather than from the party table's own
 * iteration order, so two servers replaying the same session sweep the parties
 * in the same sequence — the same argument `graceExpired` makes for sorting its
 * output. Party ids are minted from a counter and are process-local, so their
 * map order depends on who happened to connect first, which is a network-timing
 * input and must not reach game state.
 *
 * `[undefined]` when no party table is wired in: one scope, the whole level,
 * and the wipe reads exactly as it did before parties existed.
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
 * ═══════════════════════════════════════════════════════════════════════════
 * DOES THIS REALM OWE A DECISION AT ALL? A STALLED ONE IS SKIPPED, NOT WAITED ON.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A PARTY'S WIPE LOOP MUST NEVER STARVE THE PUMP, and real co-op found the way
 * it could: a party trapped on the floor churned the shared pump while a player
 * in a different party — with an invite still unanswered — could not get a turn
 * resolved (wipe-recovery.test.ts, "one party on the floor does not starve
 * another"). The wipe is per party; `pump` is LEVEL-WIDE.
 *
 * ═══ AND `pump` STAYS LEVEL-WIDE. THAT IS DELIBERATE. ═══
 * Making the pump per-party would FORK THE WORLD CLOCK, and world.ts says what
 * that costs where it declares `TurnState`: *"One level per party, ever — two
 * live levels means two clocks and an unsolvable UX problem for a Friday
 * night."* Two clocks on one floor means two answers to "what turn is it",
 * monsters ticking at two rates in the same room, and an engagement counter
 * nobody owns. The Bell is the realm's for the same reason — see
 * `PumpCtx.parties`.
 *
 * A realm with nobody in its quorum — every player Downed, Erased, disconnected
 * or Standing By — has no decision to owe. There is nobody to ring a Bell at,
 * nobody whose silence should be turned into a forced pass, and nobody whose
 * deadline the caller should arm its wall-clock timer for.
 *
 * ═══ IT IS A STATED INVARIANT, NOT A NEW RULE, AND THAT IS THE POINT ═══
 * `inQuorum` already answers no for every one of those bodies, so `expire`
 * returns nothing for such a realm today and `bell` reports a dormant countdown.
 * Writing it down HERE is what keeps it true: the day `inQuorum` widens — a
 * downed player who may still vote, a Standing By player who may still be rung —
 * this is the line that has to be reconsidered on purpose, rather than
 * discovered when the Bell starts firing at a frozen screen. The caller below
 * still asks `bell` for its SIDE EFFECT even when it skips; see there for why
 * retiring the countdown matters.
 */
function canDecide(actors: readonly EngineActor[]): boolean {
  return actors.some((actor) => inQuorum(actor));
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
   * The parties `checkWipe` surveys — one per party, or one un-scoped level
   * when no party table was supplied. NOT the barrier: the Bell and the round
   * tails are the realm's (see `PumpCtx.parties`).
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
  /**
   * SENTENCES THE RECORD LANE MUST PRINT THAT NO FRAME CAN CARRY.
   * See `PumpResult.records`. A sibling of `displaced` and for its reason: the
   * one place that holds both the run and the thing that happened.
   */
  readonly records: string[];
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * COMPANIONS THAT HAVE ALREADY WALKED IN THIS PUMP — ONE STEP EACH, AND THE
   * BOUND IS WHAT KEEPS THE IDLE FIXED POINT FINITE.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `actMonster`'s idle gate lets one faction move while `engagement <= 0`
   * (see `FOLLOW_LEASH`). Without this set that exception is unbounded WITHIN A
   * SINGLE PUMP, and the reason is `energy.ts#tickLevel`'s own loop rather than
   * anything about companions: a body that spent energy is below the threshold,
   * so `anyCanGainEnergy` answers true, so the sweep grants again — and it goes
   * on granting until nobody spends. A companion eight tiles back would
   * therefore walk all eight in the pump that one player's single step opened,
   * ageing the world eight game turns for one keypress. Out of combat that is
   * eight turns of regeneration, of effect durations and of cooldowns, bought
   * by walking away from your own companion and back.
   *
   * ONE STEP PER PUMP INSTEAD, which is the rate the design assumed all along:
   * *"the companion catches up while you walk and stands still while you stand
   * still"*. The player's own step already paid for the turn the companion
   * walks in, so a party plus a companion costs exactly the clock the party
   * costs.
   *
   * PER PUMP AND NOT PER GAME TURN, because a pump can advance several turns
   * and a per-turn bound would allow one step in each of them. `Run` is built
   * once per `pump` call, which is what makes this set the right home: it is
   * not state about a body, it is state about a call.
   */
  readonly followed: Set<string>;
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
   * outcome's `killed`, which `applyDamage` sets only on the blow that
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
  /** See `PumpResult.records`. */
  readonly records: readonly string[];
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
      // CARRIED, NOT DROPPED — the note `healed` earned on the talent map, for
      // the same reason and on the third mapper to need it.
      healed: hit.healed,
    });

    // ANY DAMAGE UN-DAZES — see `PumpCtx.breakOnDamage`. Not on a heal
    // (`amount` 0, `healed` set) and not on a tick every resist ate.
    if (hit.amount > 0) run.ctx.breakOnDamage?.(hit.victimId);

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

    // THE SAME BURIAL THE BLOW LANE PERFORMS, and it is the same CALL now
    // rather than the same four lines. See `noteMonsterDeath`: this site keeps
    // its own way of deciding who died — a tick produces no `Effect` and the
    // note above says why manufacturing one would be a lie — and hands the body
    // over. `hit.sourceId` is nullable here and unconditional there, which is
    // why that function takes a nullable killer.
    noteMonsterDeath(run, victim, hit.sourceId, sweepTurn);
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
  const records: string[] = [];

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
   * `updateEngagement`, `enrolCasualties` and `partyScopes` all read: every one
   * of them asks a question only a BODY can answer. This second array — the
   * bodies in turn order, then everything in flight, in insertion order — is
   * handed to `tickLevel` and to nothing else. It is built BELOW, after the
   * engagement check, because a party's fight starting there rolls initiative
   * and the roll is the order (`ensureInitiative`).
   *
   * PROJECTILES GO LAST, AND THAT IS WHAT MAKES THE PHASE LOCK WORK FOR FREE.
   * `actorsInTurnOrder` puts the bodies first; energy.ts:647 skips every actor
   * after the first park unless `actsWhileBlocked`, which only a Player out of a
   * fight gets. So
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
    records,
    // EMPTY EVERY PUMP, and that is the whole mechanism. See `Run.followed`.
    followed: new Set<string>(),
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
  updateEngagement(world, actors, ctx, sink, false);
  // A PARTY'S FIGHT HAS JUST STARTED? Then everybody rolls, and the roll is the
  // order from here on. See `ensureInitiative`; alone it rolls nothing.
  ensureInitiative(world, actors);
  // THE SAME BODIES AS `actors`, in the order this call takes turns in.
  const order = world.actorsInTurnOrder();
  const ticking: readonly EnergyActor[] = [...order, ...world.projectilesInFlight()];

  // The Bell is checked ON ENTRY, ONCE, FOR THE WHOLE REALM — the wait it
  // shortens is realm-wide (`PumpCtx.parties`), so its countdown is too. The
  // caller sets a real timer for the deadline and re-enters when it fires;
  // expiry is applied right here, which means the whole countdown is exercised
  // by calling pump twice with two different `nowMs` values and no timers.
  // IN TURN ORDER, because the Bell is on whoever's turn it is: the first
  // body in `order` that still owes a decision.
  applyBellExpiry(world, order, ctx, sink);

  /**
   * THE GROUND UNDER EVERY BODY, for `actBase`'s air step (tome/class/Actor.lua:584).
   * Read through `world.level` at the moment of asking, so a tile that changed
   * earlier in this pump — a door opened, a bubble spent — is the tile it is now.
   * Built once per pump rather than per body; nothing in it is per body.
   */
  const terrain: TerrainProbe = {
    airAt: (x, y) => airOf(tileAt(world.level, x, y)),
    ...(ctx.startSuffocating === undefined ? {} : { startSuffocating: ctx.startSuffocating }),
  };

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
    //
    // ═══ AND IN A FIGHT, NOT EVEN A PLAYER ═══
    // Engaged, the turns go in ORDER: the sweep stops at the first player who
    // still owes a decision, and a player after them who has already sent one
    // waits for their slot. That is ToME's own pause (GameEnergyBased.lua:
    // 133-136) — the loop breaks on the one player it is waiting for. Out of a
    // fight nobody blocks, so players still move freely around each other.
    actsWhileBlocked: (energyActor) =>
      world.turn.engagement <= 0 &&
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
      actBase(actor, ctx.statusPass, terrain);
      // THE TALENT HALF OF THE SAME PASS, and it goes here rather than anywhere
      // else for the reason `actBase` itself does: it is the AP/MP refill and
      // the class resource's regeneration, both of which must fire exactly ONCE
      // PER GAME TURN AT ANY SPEED. On the act clock a hasted body would refill
      // more often, which is a haste that shortens cooldowns by another name.
      // Absent seam → not called, and nothing about this pass changes.
      ctx.talents?.actBase(actor.id);
      /**
       * ═══════════════════════════════════════════════════════════════════════
       * AND WHAT THIS BODY HAS CALLED UP — `callbackOnActBase`.
       * ═══════════════════════════════════════════════════════════════════════
       *
       * `tome/data/talents/cursed/shadows.lua:438-453` hangs Call Shadows'
       * whole cadence off this exact callback, and `shadows.lua:324-329` hangs
       * the leash off the SHADOW's own turn. One seam serves both arms — see
       * `TalentResolution.summonPass`.
       *
       * HERE, IMMEDIATELY AFTER THE TALENT HALF, because it reads the sheet
       * that line just refilled: a summon costs five Ink and the Ink it costs
       * is this turn's. Above it and the stance would spend a pool that is
       * about to be regenerated into.
       *
       * ═══ A NEW BODY STARTS ACTING ON THE NEXT PUMP, AND THAT IS DELIBERATE ═══
       * `actors` is a snapshot taken at the head of this call and `ticking` is
       * built from it, so a shadow added now is not in either. That is the
       * ORB's rule, stated at `ticking`: *"nothing joins or leaves the sweep
       * halfway through it"*, and it keeps us clear of the mid-sweep array
       * mutation upstream survives only with explicit index fixups.
       */
      const summons = ctx.talents?.summonPass?.(actor);
      if (summons !== undefined) {
        for (const line of summons.records ?? []) run.records.push(line);
        for (const id of summons.reap ?? []) {
          const body = world.getActor(id);
          // POSITIVE `kind === Monster`, for `noteMonsterDeath`'s stated reason:
          // `removePlayer` is literally the same closure as `removeActor`, so a
          // mistake here would delete somebody's character.
          if (body === undefined || body.kind !== ActorKind.Monster) continue;
          // `summon_time = 0` (shadows.lua:374) then `self:die(self)` (:327).
          // `alive` first, so nothing can target it between here and the burial.
          body.alive = false;
          run.reaped.push(id);
        }
      }
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
      // AND WHAT THE TILE UNDER THEM DOES — last, after the countdown. See
      // `onStandPass` for why this clock and not the act clock (D5-4).
      onStandPass(actor, run);
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
      updateEngagement(world, actors, ctx, sink, true);
      // A fight that starts mid-sweep rolls now; the order takes effect on the
      // next call, because the array this sweep walks is fixed (see `ticking`).
      // The player whose turn it is parks the moment they can act, so nothing
      // acts out of order in between.
      ensureInitiative(world, actors);
      // AND WHAT THE FLOOR ITSELF IS DOING. See `tickGroundZones` -- this hook
      // is upstream's once-per-game-turn modulo and the zone pass is what it
      // was written for.
      tickGroundZones(run, null);
    },

    maxTicks: ctx.maxTicks ?? DEFAULT_MAX_TICKS,
  });

  return {
    status: result.status,
    parked: result.parked,
    events,
    reaped,
    displaced,
    records,
    ticks: result.ticks,
    gameTurns: result.gameTurns,
    gameTurn: world.turn.clock.gameTurn,
    engagement: world.turn.engagement,
    // THE REALM'S ONE COUNTDOWN, asked of the whole realm for the reason
    // `PumpCtx.parties` gives. With parties it was the soonest of one countdown
    // per party, which disagreed with the wait once a realm held two of them.
    // Read in the order as it stands NOW: a fight that started mid-sweep has
    // rolled since `order` was taken.
    bell: ctx.barrier.bell(world.actorsInTurnOrder(), world.turn, ctx.nowMs),
  };
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
      /**
       * ═══════════════════════════════════════════════════════════════════════
       * A DOOR OPENING IS NOT AN ERROR, AND THIS IS THE ONLY LINE THAT KNOWS IT.
       * ═══════════════════════════════════════════════════════════════════════
       *
       * Every other refusal reaches its owner as `sendError(..., "refused at
       * resolution: <reason>")`, which is right: they asked for something and
       * did not get it. A door-open is the opposite — they asked for something,
       * got a BETTER outcome than a refusal, and the door is visibly open on
       * their screen. Toasting "refused at resolution: terrain" over the top of
       * that would teach a player that opening doors is a malfunction.
       *
       * THE PARK STAYS, and it is the whole port. `Actor.lua:1346` charges a
       * move's energy only when the body actually changed tile, so upstream's
       * door-open costs nothing and the player is simply asked again —
       * `interface/PlayerExplore.lua:2563`: *"takes a movement action but no
       * energy to do"*. `Park` IS being asked again, for zero energy.
       *
       * A MONSTER TAKES THE OTHER PATH AND IS CHARGED, which is `actMonster`'s
       * existing behaviour and is also upstream: `NPC.lua:87-92` charges any
       * NPC whose turn spent no energy, via `waitTurn`. Neither lane needed a
       * special case for doors; this one needed a special case for TOASTING.
       */
      if (outcome.opened === undefined) {
        // THE REFUND RULE: zero energy, cleared, re-prompt. `Park` is how the
        // loop is told this actor still owes a decision.
        sink.push({ t: 'refunded', id: actor.id, reason: outcome.reason });
      }
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
    // AND WHAT THE BODY THEY HIT MADE THEM PAY FOR IT. After the counter, so a
    // Watchman's punish narrates before the spikes on the thing he punished.
    noteRetaliation(outcome.effect, run, null, actor.id);
    // AND WHATEVER WAS UNDER THE TILE THEY LANDED ON. Last of the five, because
    // a trap is the only one that fires on a MOVE rather than on a blow — see
    // `noteTrap`.
    noteTrap(outcome.effect, run, null, actor.id);
    /**
     * ═════════════════════════════════════════════════════════════════════════
     * ONE ACTION IS ONE TURN — as ToME's is, for everybody, in combat or out.
     * ═════════════════════════════════════════════════════════════════════════
     *
     * ```lua
     * function _M:useEnergy(val)
     *   val = val or game.energy_to_act
     *   self.energy.value = self.energy.value - val
     *   if self.player and self.energy.value < game.energy_to_act then game.paused = false end
     * ```
     *
     * engines/default/engine/Actor.lua:478-484. A step, a swing or a talent
     * spends the turn and the world runs until the player can act again. There
     * is no "end turn" in ToME, and there is none here.
     *
     * THIS WAS AN OPEN ROUND. D1's intra-turn budget (6 AP / 3 MP) parked a
     * player after a step or a talent until they pressed Space, took a third
     * action or waited out a Bell, and a lone player in combat had no tail to
     * close it for them. Testers reported it as "is it my turn, do I pass?" on
     * 2026-08-20 and again on 2026-09-23, and the author ruled it out.
     *
     * THE ONE EXCEPTION IS UPSTREAM'S: a `no_energy` talent (Actor.lua:5862-5863)
     * is used without spending, so the player keeps the turn — parked for zero
     * energy, exactly as the refund and the door-open above are.
     */
    if (
      intent.kind === IntentKind.Talent &&
      run.ctx.talents?.noEnergy?.(intent.talentId) === true
    ) {
      return ActResult.Park;
    }
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
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT THIS BODY IS ABOUT TO DO, OR THAT IT IS DOING NOTHING.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `undefined` IS THE IDLE FIXED POINT, and it is the answer for every monster
 * in the game on every turn outside a fight. `actMonster`'s own essay says what
 * that buys and what it costs; this function is where the ONE exception to it
 * lives, so that the gate stays a single line and the exception is not spelled
 * out inside it.
 *
 * ═══ THE EXCEPTION, AND BOTH HALVES OF ITS BOUND ═══
 * A `Faction.Squad` companion beyond `FOLLOW_LEASH` of its person takes one
 * step toward them. `followStep` refuses everything else — no anchor, already
 * beside them, no route, or a route whose first tile is a swing — and
 * `Run.followed` refuses a second step in the same pump. Neither bound is
 * decoration: the first keeps a stationary party at the fixed point, and the
 * second keeps a walking one from ageing the world at the companion's pace
 * rather than its own.
 *
 * ═══ AND IN A FIGHT IT IS ONE LINE, NOT A SECOND AI ═══
 * `decideSquadAction` wraps `decideNpcAction` rather than replacing it — a
 * companion fights with the same targeting, the same cadence and the same
 * labelled draws as anything else on the floor, because it is one of the
 * bodies on the floor.
 */
function decideMonsterAction(actor: MonsterActor, run: Run): Intent | undefined {
  const { world, aiCtx } = run;
  if (world.turn.engagement <= 0) {
    if (actor.faction !== Faction.Squad || run.followed.has(actor.id)) return undefined;
    const step = followStep(actor, aiCtxFor(actor, aiCtx, world));
    if (step === undefined) return undefined;
    run.followed.add(actor.id);
    return step;
  }
  const ctx = aiCtxFor(actor, aiCtx, world);
  return actor.faction === Faction.Squad
    ? decideSquadAction(actor, ctx)
    : decideNpcAction(actor, ctx);
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
  const { world, ctx, sink } = run;
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
  //
  // ═══ AND ONE FACTION IS LET OUT OF IT, BOUNDED TWICE ═══
  // See `decideMonsterAction`: a companion beyond `FOLLOW_LEASH` of its person
  // takes ONE step per pump toward them, and everything else — including a
  // companion already beside its person — still returns here having spent
  // nothing.
  const intent = decideMonsterAction(actor, run);
  if (intent === undefined) return ActResult.Done;

  const gameTurn = world.turn.clock.gameTurn;
  const outcome = resolveIntent(actor, intent, run);

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
    // ally on the floor narrates in that order, and so that a guardian downed by
    // that same blow cannot swing — `resolveGuardCounter` requires a live
    // guardian (talents.ts:3465) and a downed body is `alive === false`.
    //
    // ═══ EXCEPT ON A WIPE, AND THE ORDER IS WHY ═══
    // That second guarantee held for an ordinary downing and was stated flatly
    // here, which was wrong. `noteCasualty` reaches `checkWipe`, and on a FULL
    // wipe `resetFloorParty` → `standUp` sets `alive = true` on every party body
    // (downed.ts:692) before this line reads it. `standUp` touches no effects
    // and the only production `dispel` is in `resetFloor` (turn-engine.ts:665),
    // which runs after the pump — so `Guarding` is still on the guardian too.
    // A Watchman put on the floor by the wiping blow therefore CAN counter.
    //
    // Left as it is rather than guarded against. The restoration landing before
    // the remaining monsters swing is deliberate and load-bearing — moving it to
    // the end of the pump was tried and reverted, and `wipe-recovery.test.ts`
    // caught it (tools/first-death.mjs's header records both). Suppressing the
    // counter would need a "was this body restored this pump" flag invented for
    // one near-inert case: the countered monster is reaped and re-seeded by
    // `resetFloor` moments later.
    noteGuardCounter(outcome.effect, run, gameTurn, actor.id);
    // ═══ AND THE SPIKES — THE LANE `on_melee_hit` WAS WRITTEN FOR ═══
    // A husk swings at a detective in spiked plate and bleeds for it. Both lanes
    // rather than only this one, for `noteGuardCounter`'s reason: the rule is a
    // property of "a blow landed", not of whose turn it was.
    noteRetaliation(outcome.effect, run, gameTurn, actor.id);
    // AND THE PLATE IT WALKED ONTO. Both lanes, for the reason the two above
    // are: a husk chasing you across its own floor springs the same trap.
    noteTrap(outcome.effect, run, gameTurn, actor.id);
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
  /** And its maximum, snapshotted for the same reason — see the sweep step. */
  readonly maxHp?: number;
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
  | { readonly ok: true; readonly effect: Effect }
  | {
      readonly ok: false;
      readonly reason: Refusal;
      /**
       * ═══════════════════════════════════════════════════════════════════════
       * THE REFUSAL THAT CHANGED THE WORLD ON ITS WAY OUT — `engine/doors.ts`.
       * ═══════════════════════════════════════════════════════════════════════
       *
       * Present when this step opened a door. The step still did not happen —
       * `Grid.lua:64`'s `return true` means BLOCKED — so `Refusal.Terrain` is
       * the honest answer to *"why am I still here"*: terrain stopped you, and
       * it is a different piece of terrain now.
       *
       * IT IS NOT ON THE WIRE AND MUST NOT GO THERE. The client learns about
       * the door from `TerrainMsg`, which is absolute and self-correcting; a
       * second channel saying the same thing is a second channel that can
       * disagree. This field exists for ONE reader — `actPlayer`, which uses it
       * to keep a successful door-open from surfacing as an error toast.
       */
      readonly opened?: TileXY;
    };

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
      restoreBreath(run.ctx, target);
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
          maxHp: victim?.maxHp ?? 0,
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
         * ═══ AND THE SECOND ONE IS WHAT UPSTREAM ACTUALLY DOES — SEE BELOW ═══
         * THIS LINE IS STILL RIGHT AND THE PARAGRAPH ABOVE IT WAS HALF WRONG,
         * which is worth leaving in place rather than deleting. `canAttack` is
         * still the judge and the bump still obeys whatever it says. What
         * changed is the answer: `rangeRefusal` no longer refuses an ARCHERY
         * wielder inside `MELEE_REACH`, because upstream's melee loop skips a
         * bow and punches instead (tome/class/interface/Combat.lua:181, :204,
         * :221-231). So the Inspector's bump lands here as a `BAREHAND` swing
         * (measured at 7.06 damage against the revolver's 11.54 — read that
         * constant's note, `dam = 1` is not a damage of 1), and the dead zone
         * is intact everywhere else — she
         * still cannot SHOOT adjacent, and the band between 1.5 and 3 tiles is
         * still empty for her. "A melee exemption" would have been the whole
         * class deleted; a fist is what upstream gives her, and measured it is
         * the difference between 0/12 and a real run.
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
       * ═══ A PLAYER OR HER PARTY'S SUMMON, AND THE KIND TEST EARNS ITS PLACE ═══
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
       *     braces today — and `test/server/ally-swap.test.ts` is what pins it.)
       *
       *   TWO MONSTERS. A pack is not hostile to itself. Letting them trade
       *     places would let the back rank flow through the front rank, which
       *     turns a corridor from something a party can hold into a queue that
       *     shuffles — and holding a line is most of the tactical geometry this
       *     game has.
       *
       * ═══ …AND YOUR OWN SUMMON IS THE ONE NON-HOSTILE MONSTER THAT MUST ═══
       * `Faction.Bound` broke the "two monsters" reading the day it landed: a
       * Bound shadow is a Monster, `areEnemies` answers false against every
       * player (engine/actor.ts#reactsAs), so the hostile branch above returns
       * nothing and a shadow standing in a doorway was an absolute wall — to
       * its own summoner and, because the second half of the test asked the
       * OCCUPANT's kind, to every teammate as well.
       *
       * MEASURED on an instrumented copy of the driver, Redactor, twelve moor
       * delves, four runs each, with Call Shadows genuinely raised: 4159 of
       * 13765 ordered steps — 30.2% — were refused by a body she had called up
       * herself, wins fell by half, six new stalls appeared and turns-per-win
       * rose by 17%. With the swap emulated, blocked steps went to 44 and every
       * one of those numbers returned. Barrow End went 4/4 to 0/4 and back.
       *
       * AFTERWARDS, on the shipped driver: the stance costs her no wins at all
       * (7/48 raised and 7/48 down, over the same forty-eight runs) and takes
       * 13.7% less damage off her. A wall she could not pass was the whole of
       * the difference.
       *
       * UPSTREAM HAS NO SUCH CASE because `shadows.lua:431-434` puts the shadow
       * in `game.party`, and party membership is exactly what makes the
       * friendly half of `Combat.lua:32-74` legal — `Party.lua:271-272`'s
       * `move_others = true`, already cited at the head of this block. Ours is
       * not a party member (see `talents/call_shadows.ts` for why), so the
       * permission is granted here instead, on the narrowest possible fact:
       * THIS OCCUPANT IS SOMETHING A PLAYER CALLED UP. `summonerId` is the
       * link `reactsAs` cannot walk (it is handed no world), so asking it here
       * is asking the one question a faction cannot answer.
       *
       * THE "TWO MONSTERS" ARGUMENT IS UNTOUCHED: a monster is still never the
       * mover on this branch, and a shadow still cannot trade places with
       * another shadow or with a teammate who did not call it.
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
      /**
       * ═══════════════════════════════════════════════════════════════════════
       * ONCE PER PAIR PER GAME TURN — the clause upstream has no need of.
       * ═══════════════════════════════════════════════════════════════════════
       *
       * `Combat.lua:32-74` is the PLAYER pushing a FOLLOWER, and a follower has
       * no opinion about where it is going. Ours are two people at two keyboards,
       * and every swap moves BOTH bodies — so two friends walking the same way
       * undo each other, forever.
       *
       * MEASURED, two real sockets on one moor: A and B adjacent, both walking
       * east, ten commands each. Twenty position changes, NET ZERO, alternating
       * between exactly two tiles. Walking down a corridor together is the most
       * ordinary thing a party does and it did not work.
       *
       * ═══ WHY ONE EXCHANGE IS THE WHOLE FIX ═══
       * The second swap of a pair is always the one that undoes the first, so
       * refusing it is enough. What happens next is the behaviour we wanted all
       * along: the body that was pushed back is blocked for that one move, and on
       * the NEXT turn the one in front steps into free floor and the one behind
       * follows it. One move lost at the moment they collide, then clean travel.
       *
       * ═══ AND THE DOORWAY IS UNTOUCHED ═══
       * The case this swap exists for — *"my friend is in the doorway"*, which the
       * comment above measured at twelve consecutive refused steps — is a friend
       * STANDING STILL. They swap once and are through, and the second exchange
       * this refuses never happens because nobody is pushing back.
       */
      /**
       * THE MOVER'S OWN MARK, NOT THE OCCUPANT'S — see `Actor.shovedBy`.
       *
       * This read the occupant's, which made the rule symmetric: A pushes past
       * B, both are marked, and A can never come back past B until B takes a
       * normal step of their own. A friend standing still in a doorway therefore
       * became a one-way door, and the refusal is refunded rather than costing a
       * turn, so a client re-sending the direction froze the whole floor.
       *
       * Asking the MOVER whether it was just shoved by this occupant refuses
       * only the reflexive shove-back, which is the entire loop being closed.
       */
      /**
       * ═══════════════════════════════════════════════════════════════════════
       * PINNED — AND IT IS BELOW THE BUMP ON PURPOSE, WHICH IS UPSTREAM'S ORDER.
       * ═══════════════════════════════════════════════════════════════════════
       *
       * `Actor.lua:1337` labels its own branch *"Never move but tries to attack ?
       * ok"* and then hands the step to the collision code with `act = true`,
       * which is how a pinned body still hits what it walked into. The attack
       * branch above has already returned for exactly that case, so putting the
       * gate here reproduces it without a special case.
       *
       * ═══ IT REFUSES THE SWAP TOO, AND THAT IS NOT AN OVERSIGHT ═══
       * Trading places with a friend is a move by any reading — both bodies
       * change tile — and `never_move` is a statement about this body, not about
       * what is standing in the way. A pinned player who could still swap would
       * have a way out of a pin that depended on a teammate being conveniently
       * adjacent, which is the sort of rule nobody can find and everybody
       * eventually exploits.
       *
       * ═══ AND A ROOTED BODY IS THE SAME BRANCH ═══
       * Pinned is a temporary `never_move`; a crystal's is permanent
       * (`crystal.lua:39`, `MonsterActor.neverMove`). Upstream reads the one
       * attribute for both, so this reads both here.
       */
      if (
        actor.combat?.flags?.pinned === true ||
        (actor.kind === ActorKind.Monster && actor.neverMove === true)
      ) {
        return { ok: false, reason: Refusal.Pinned };
      }

      const wouldUndo = occupant !== undefined && actor.shovedBy === occupant.id;
      /**
       * A BODY THE PARTY BROUGHT — see the block above.
       *
       * TWO WAYS TO BE ONE, AND THEY ARE THE SAME TEST ASKED TWICE. `summonerId`
       * is set by `shadowInitAt` and by nothing else in the game;
       * `Faction.Squad` is a temporary companion, which has no summoner and is
       * the floor's rather than anybody's. Reaching this line at all means the
       * occupant is NOT hostile (the bump-attack branch has already returned),
       * so either fact plus that one is upstream's party test: a summon whose
       * root is a player is a party member (`shadows.lua:431-434`), an escortee
       * is one by `addMember` (`Party.lua:46-88`), and every party member may be
       * moved through (`Party.lua:271-272`). Norgan says it on his own template
       * — `data/zones/reknor-escape/npcs.lua:91` is `move_others=true`.
       *
       * NOT `summonerId === actor.id`, WHICH WAS THE FIRST VERSION. That let a
       * Redactor past her own shadow and left it an absolute wall to her
       * TEAMMATES, which upstream has no equivalent of — a party member is a
       * party member whoever called it up. A summon whose root were a monster
       * would be hostile and would never reach this line.
       *
       * AND A COMPANION IS THE CASE WITH NO WORKAROUND. A shadow lives ten
       * turns and its summoner can stop making them; a companion stands on this
       * floor for as long as the objective does, and an objective that asks you
       * to walk somebody somewhere is an objective whose body is in the doorway
       * by construction.
       *
       * ═══ `actor.kind === ActorKind.Player` IS UNREACHABLE TODAY, MEASURED ═══
       * Deleting that clause and running the whole suite leaves 7153 tests
       * green, which is the same answer the Downed guard below gives and for
       * the same kind of reason: nothing proposes the case. Every producer of
       * an `IntentKind.Move` in `ai/npc.ts` refuses an occupied destination
       * first (`intentForStep`, `canRetreat`, `aiFindSafeGrid` and the
       * passability closure `advance` paths with), and a standing order is a
       * player's. So a monster never arrives here with an occupant at all.
       *
       * IT STAYS, AND THE MUTANT IS RECORDED RATHER THAN THE TEST FAKED: the
       * "two monsters" argument above is the rule this clause states, a fixture
       * that hand-built a monster Move into an occupied tile would be testing
       * the fixture, and the day the AI learns to shove is the day this line is
       * the only thing between a pack and the front rank it is queuing behind.
       */
      const friendlyBody =
        occupant !== undefined &&
        isMonster(occupant) &&
        (occupant.summonerId !== undefined || occupant.faction === Faction.Squad);
      if (
        occupant !== undefined &&
        !wouldUndo &&
        actor.kind === ActorKind.Player &&
        (occupant.kind === ActorKind.Player || friendlyBody) &&
        !(run.ctx.downed !== undefined && isDowned(run.ctx.downed, occupant.id))
      ) {
        const theirs: TileXY = { x: occupant.x, y: occupant.y };
        if (world.swapPlaces(actor.id, occupant.id)) {
          // ONLY THE BODY THAT WAS MOVED WITHOUT ASKING. The mover chose this
          // step, so it has nothing to undo and must stay free to walk back —
          // marking it too is what turned a friend standing still into a wall.
          occupant.shovedBy = actor.id;
          // AND THE MOVER'S OWN MARK IS SPENT. If A was shoved by C and then
          // deliberately swaps with B, A is no longer mid-exchange with anyone.
          actor.shovedBy = undefined;
          run.ctx.talents?.noteMoved(actor.id);
          return { ok: true, effect: { kind: 'swapped', from, to: theirs, otherId: occupant.id } };
        }
      }

      // `tryMove` remains the ONLY thing in the process allowed to change a
      // position, so terrain and occupancy are decided in exactly one place.
      const moved = world.tryMove(actor.id, dir);
      if (!moved.ok) {
        /**
         * ═══════════════════════════════════════════════════════════════════
         * WALKING INTO A DOOR OPENS IT, AND THE WALK STILL DOES NOT HAPPEN.
         * ═══════════════════════════════════════════════════════════════════
         *
         * `Grid.lua:60-64` — the door is swung and `block_move` returns TRUE,
         * which means blocked. So this is the one refusal in the engine that
         * is not a failure, and it is deliberately expressed as one anyway:
         * `engine/doors.ts` has the argument, but the short version is that
         * the two lanes already do the right thing with a refusal and would
         * both do the wrong thing with a success.
         *
         * AFTER `tryMove`, NOT INSTEAD OF IT. `tryMove` is documented as *"the
         * ONLY thing in the process allowed to change a position"*, and its
         * ordering — terrain, then occupancy — is what decides which refusal
         * this is. Asking about doors first would open one through a body
         * standing in the doorway, which is exactly the tile somebody is most
         * likely to be standing in.
         */
        if (moved.reason === MoveBlock.Terrain && canOpenDoors(actor)) {
          const at = step(actor, dir);
          if (world.openDoor(at.x, at.y)) {
            return { ok: false, reason: Refusal.Terrain, opened: at };
          }
        }
        return { ok: false, reason: moved.reason };
      }
      /**
       * ═══════════════════════════════════════════════════════════════════════
       * A STEP ONTO FREE FLOOR ENDS THE EXCHANGE — FOR **BOTH** BODIES.
       * ═══════════════════════════════════════════════════════════════════════
       *
       * The comment here already said the rule — *"once EITHER of them has gone
       * somewhere under their own power there is nothing left to undo"* — and
       * only ever cleared one half of it. The other half is what left a shoved
       * body permanently unable to come back past a shover who then stood still:
       * the mark clears when the MARKED body moves, and a marked body whose only
       * route is back through the shover never gets to move.
       *
       * MEASURED. `DELVE_DIAG=stuck` on Blackwood, 750 turns:
       *
       *     p0 at 9,15 -> w 8,15 | occupant p2 | energy 1000 | shovedBy p2
       *
       * — p0 refused every turn, refunded every turn (so never completing the
       * turn that would have cleared its own mark), and because `Park` means
       * *"the loop comes back to them before the world moves"*, the floor's
       * clock stopped for the whole party.
       *
       * ONE SCAN OVER THE ACTOR TABLE, which is under thirty bodies and only on
       * a step that actually landed. The alternative — an index of who is marked
       * — would be a second copy of a fact that lives on the bodies.
       */
      actor.shovedBy = undefined;
      for (const other of world.allActors()) {
        if (other.shovedBy === actor.id) other.shovedBy = undefined;
      }
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
    case TalentRefusal.NoShooter:
    /* falls through — NOTHING IN THE HAND TO FIRE (`NoShooter`, `archerPreUse`)
       is the build and not the aim, so it is here with the budgets. A PASSIVE
       HAS NOTHING TO FIRE, which from the turn's point of view is the same
       outcome as a cooldown: the intent produced no effect and cost no energy.
       It joins the group rather than taking a `Refusal` of its own, because
       nothing downstream would draw it differently. */
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
 * up — a turn nobody took. `stepProjectile`'s own kill arm (engine/projectile.ts)
 * carries the identical
 * two lines for the identical reason.
 *
 * THE CORPSE-CAMP GUARD SURVIVED THE MOVE: `applyDamage`'s `!target.alive` guard
 * still returns an empty
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
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * IS THE SWING REPLACED? — `Combat.lua:164-173`, AND IT IS ASKED FIRST.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Upstream asks this ABOVE the mainhand loop, the offhand loop and the
   * barehand fall-through, and sets `speed` — the flag all three test with
   * `if not speed`. So a replaced blow does not ALSO swing a weapon, and this
   * line is the only place that can be true.
   *
   * ABSENT SEAM, ABSENT METHOD OR `null` IS BYTE-FOR-BYTE THE OLD PATH: the
   * `??` falls through to `attackTarget` with the same arguments at the same
   * position in the draw stream. `TalentResolution.meleeReplacement` carries
   * the whole argument.
   */
  const replaced = run.ctx.talents?.meleeReplacement?.(attacker, target, mark) ?? null;
  const outcome =
    replaced ??
    attackTarget(attacker, target, world, world.rng, {
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
  /**
   * ═══ AND THE SAME ROW OFF A WORN THING — `wielder.melee_project` ═══
   * This read `isMonster(attacker) ? attacker.onHit` and so a rider was a fact
   * only a CREATURE could state: a ghoul could paralyse, and no blade in the
   * game could open a cut. `composeWielders` now folds `Wielder.onHit` onto the
   * sheet, so a player's riders arrive by the same route their armour does.
   *
   * BOTH SOURCES, NOT ONE OR THE OTHER. A monster with a rider that also wore
   * something would otherwise silently lose one of them, and the bestiary is
   * exactly where that will happen first.
   */
  /**
   * ═══ AND A REPLACED BLOW CARRIES NO WEAPON RIDER — see `gesture_of_pain.ts` ═══
   * `wielder.melee_project` and `MonsterActor.onHit` are properties of a WEAPON
   * that was swung and of a BODY that swung it. A gesture swings neither:
   * upstream's replacement path never reaches `attackTargetWith`, which is the
   * only thing in ToME that runs a melee rider, and its own proc pass
   * (gestures.lua:158-179) fires the MINDSTARS' procs and nothing else. An
   * empty list here is that, said in this engine's vocabulary.
   */
  const riders =
    replaced !== null
      ? []
      : [
          ...(isMonster(attacker) && attacker.onHit !== undefined ? [attacker.onHit] : []),
          ...(attacker.combat?.onHit ?? []),
        ];
  for (const rider of riders) {
    if (!(outcome.ok && outcome.hit && !outcome.killed)) break;
    /**
     * ═══ `rng.percent(25)` — THE ROLL BEFORE THE SAVE, AND ONLY WHEN ASKED ═══
     * `OnHitStatus.chance` carries the argument. What matters here is the
     * STREAM: the draw is taken only for a rider that declares one, so every
     * creature authored before this field consumes exactly the sequence it
     * always did — and it is taken inside the loop, after the swing's own
     * draws, which is the discipline the note above already sets.
     *
     * The label carries the effect id so two riders on one blow are separable
     * in a log, which is the whole reason labelled draws exist.
     */
    if (
      rider.chance !== undefined &&
      run.world.rng.int(`rider.${rider.effectId}`, 1, 100) > rider.chance
    ) {
      continue;
    }
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
      maxHp: target.maxHp,
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
    maxHp: target.maxHp,
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
    // NOT the legality check's number or metric: `canAttack` measured
    // `combat.range` on ToME's rounded length, and this is `attackRange`, the
    // orb's CHEBYSHEV flight limit (see the deviation note on `blockPath` in
    // engine/projectile.ts). The orb invariant in monsters.test.ts keeps the
    // two numbers equal for every shooter, and a Chebyshev length never exceeds
    // the rounded one, so the orb reaches every tile the check accepted.
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
      // What MIND rolls against the target's save on impact. See `ProjectileDamage`.
      ...(sheet === undefined ? {} : { mindpower: combatMindpower(sheet) }),
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
   * "%s resists the mind attack!" — damage_types.lua:894, when MIND's save held
   * and half landed. PLAYERS ONLY, for the fire trap's reason: the Record lane
   * has no fog, and a monster's name would be handed to anybody on the floor.
   */
  if (impact.mindResisted === true) {
    const struck = world.getActor(impact.targetId);
    if (struck !== undefined && struck.kind === ActorKind.Player) {
      run.records.push(`${capitalize(struck.name)} resists the mind attack!`);
    }
  }

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
    maxHp: impact.maxHp,
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
    maxHp: victim?.maxHp ?? 0,
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

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * AND WHAT IT COST TO LAND THAT BLOW — `on_melee_hit`, Combat.lua:851-891.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The whole upstream rule, with the one talent that modifies it (Close Combat
 * Management, which sets `fa` and `pct` and which this game does not have)
 * absent so that both are 0:
 *
 * ```lua
 * if hitted then
 *   for typ, dam in pairs(target.on_melee_hit) do
 *     if dam > 0 then DT.projector(target, self.x, self.y, typ, dam) end
 * ```
 *
 * `target` is the defender and `self.x, self.y` is the ATTACKER's tile: the
 * defender is the SOURCE and the attacker is what gets hit. Spiked armour.
 *
 * ═══ WHY IT IS A SIBLING OF `noteGuardCounter` AND NOT PART OF THE SWING ═══
 * Identical reasoning, and that function's docblock is the long version: a blow
 * that travels the other way has a DIFFERENT KILLER, and `noteCasualty` spends
 * exactly one `killerId` on `noteKill` and `awardExperience`. Retaliation that
 * rode on the attacker's own effect would pay the attacker's kill credit for
 * killing themselves. So it is re-entered as its own one-blow effect with the
 * DEFENDER's id, and every rule downstream applies to it unchanged.
 *
 * ═══ THE GUARD IS `hit` AND NOTHING ELSE, WHICH IS NOT WHAT THE COUNTER DOES ═══
 * `noteGuardCounter` additionally requires `effect.damage > 0`, on the stated
 * ground that a fully-armoured 0 is a non-event. That is a local rule and a good
 * one for a Watchman's punish; it is NOT this rule. Upstream sets `hitted = true`
 * at Combat.lua:621 unconditionally inside the branch where the blow connected,
 * after armour and after any parry — so a blow that a breastplate reduced to
 * nothing still connected, and the spikes still went in. Being untouchable and
 * being unhittable are different, and the affix is bought for the first.
 *
 * ═══ NO `not target.dead`, AND THE ABSENCE IS THE PORT ═══
 * The brand at Combat.lua:723 carries that guard. The Acid Blood block two lines
 * BELOW this one, at :893, carries that guard. This block does not, in a file
 * where the surrounding code plainly knows how to write it. So a defender killed
 * by the blow still burns the hand that did it, and a body can trade its last
 * moment for the kill. `world.getActor` still resolves it: `noteCasualty` ENROLS
 * a dead monster and the caller buries it after the pump returns.
 *
 * ═══ IT TAKES NO DRAW, SO ITS POSITION CANNOT MOVE THE STREAM ═══
 * A flat `applyDamage` with no `damageRange` and no `critChance` reaches
 * `resolveDamage` and consumes nothing — the same measured property the brand
 * relies on (test/server/combat.test.ts counts the draws). Placed after
 * `noteCasualty` anyway, so the narration order is "the blow, then who fell,
 * then what it cost", and so the position stays true if that ever changes.
 *
 * ═══ WHAT IS DELIBERATELY NOT WIRED ═══
 * A guard counter does not trigger the countered body's retaliation, and a
 * talent's melee blow does not trigger the defender's. Both are the same gap
 * `noteGuardCounter` already has and for the same reason — this lane keys off
 * the `attack` Effect, and a talent produces a `talent` Effect with blows inside
 * it. Upstream has neither gap, because upstream's `attackTargetWith` IS the one
 * function all three go through. Closing it means giving `TalentHit` the same
 * re-entry these two have, not moving this code.
 */
/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A BODY LANDED ON A TILE, AND SOMETHING WAS WAITING UNDER IT.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ```lua
 * --- When moving on a trap, trigger it
 * function _M:on_move(x, y, who, forced)
 *   if not forced then self:trigger(x, y, who) end
 * end
 * ```
 *
 * `engine/Trap.lua:152-155`, raised by `engine.Actor.move`'s
 * `map:checkAllEntities(x, y, "on_move", self, force)` — so it fires for ANY
 * body that walks, on the tile it ARRIVED at, and never for a forced move.
 *
 * ═══ A SIBLING OF `noteGuardCounter` AND `noteRetaliation`, FOR THEIR REASON ═══
 * Called from BOTH lanes with a `sweepTurn`, because "you stepped on something"
 * is a property of a step and not of whose turn it was. A husk chasing you
 * across its own floor sets off the same plate you did.
 *
 * ═══ THE SWAP IS DELIBERATELY NOT A STEP, AND UPSTREAM AGREES ═══
 * `effect.kind !== 'move'` returns early, so trading places with a friend does
 * not spring anything. Upstream's `on_move` is gated on `not forced`, and a
 * shove is the definition of a forced move (`Combat.lua:32-74` force-moves both
 * bodies). Getting this wrong would make "my friend is in the doorway" — the
 * most repeatable friction in the game, which the swap exists to fix — into a
 * way to set off a trap you never chose to walk onto.
 */
function noteTrap(effect: Effect, run: Run, sweepTurn: number | null, moverId: string): void {
  if (effect.kind !== 'move') return;
  const { world } = run;
  const trap = world.trapAt(effect.to.x, effect.to.y);
  if (trap === undefined) return;

  const victim = world.getActor(moverId);
  if (victim === undefined || !victim.alive) return;

  /**
   * THE DRAW IS TAKEN BEFORE THE KNOWLEDGE IS SET, and the order matters to the
   * seeded stream rather than to the rule: `trapTakes` draws exactly once per
   * body-on-trap whatever the outcome, so a replay does not depend on who had
   * already met this plate.
   */
  if (!trapTakes(trap, world.rng, moverId)) return;

  /**
   * YOU LEARN IT BY SETTING IT OFF — `engine/Trap.lua:143-146`'s `if known then
   * self:setKnown(who, true, x, y) end`, where an elemental trap's `triggered`
   * returns `true` and therefore always teaches.
   *
   * THIS IS THE COUNTERPLAY, not a nicety. The trap is NOT removed (upstream's
   * `del` is nil on a bolt), so it fires again on the next body that stands on
   * it — and with no detection talent in this game, stepping on it is the only
   * way anybody ever finds out it is there.
   *
   * SET BEFORE THE EFFECT, so a body the trap KILLS still learnt it. That costs
   * nothing for a corpse and matters for the alarm, whose effect reads the
   * victim's position after the fact.
   */
  trap.knownBy.add(moverId);

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * AND IT SAYS WHAT IT WAS — `engine/Trap.lua:126-135`'s `message`.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * ```lua
   * local str = self.message
   * str = str:gsub("@target@", tname)
   * game.logSeen(who, "%s", str)
   * ```
   *
   * THE DAMAGE ALONE CANNOT SAY THIS. The burn rides `ambient`, which is the
   * flag that strips the verb, the name and the struck-tile marker — correct,
   * because nobody swung — and what is left is a bare number. The number names
   * the element and nothing names the TRAP, so without this line a player takes
   * seven fire damage from the floor and is told only that they took it.
   *
   * ═══ PLAYERS ONLY, BECAUSE THE RECORD LANE HAS NO FOG ═══
   * Upstream uses `logSeen`, which suppresses the sentence when the victim
   * cannot be seen. Ours is a realm-wide broadcast with no per-viewer form, so
   * narrating a husk's mishap would name a body the party may not be able to
   * see, and would also hand them a trap's location for free — the exact leak
   * `TrapsMsg` is a `ViewerMsg` to prevent. A monster springing a trap is
   * therefore silent, which is a strict subset of upstream's behaviour rather
   * than a different rule.
   */
  if (victim.kind === ActorKind.Player) {
    run.records.push(trapSentence(trap.message, victim.name));
  }

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * WHAT IT ACTUALLY DOES. Exhaustive, so the next family is a compile error.
   * ═══════════════════════════════════════════════════════════════════════════
   */
  if (trap.effect.kind === 'bolt') {
    /**
     * FIREBURN, WHEN THE BOLT CARRIES ONE — damage_types.lua:1130-1140. Only
     * `init_dam` goes through the projector now; the remainder becomes the
     * burn below, so the two halves sum to the trap's whole `dam`.
     */
    const burn = trap.effect.burn;
    const split =
      burn === undefined
        ? undefined
        : splitBurn(trap.effect.damage, burn.initialPercent, burn.turns);
    const outcome = applyDamage(
      victim,
      split?.initial ?? trap.effect.damage,
      trap.effect.damageType,
      trap,
      world.rng,
      {},
    );

    const blow: Blow = {
      targetId: moverId,
      hit: true,
      crit: false,
      type: outcome.type,
      damage: outcome.dealt,
      killed: outcome.killed,
      hp: victim.hp,
      maxHp: victim.maxHp,
      at: { x: victim.x, y: victim.y },
    };

    /**
     * `ambient`, FOR THE ZONE BURN'S REASON AND MORE SHARPLY. That flag exists
     * because an `attacked` event implies a verb and a swinger, and a burning
     * floor has neither — it printed `someone hits Ren.` once a turn. A trap
     * has no swinger at all, ever: there is no body to name even in principle,
     * so the frame that names one would be wrong on every floor rather than
     * only when the source happened to be dead.
     */
    if (sweepTurn === null) {
      run.sink.push({ t: 'attacked', id: trap.id, ...blow, ambient: true });
    } else run.sink.sweep(sweepTurn, { t: 'attack', id: trap.id, ...blow, ambient: true });

    /**
     * ═════════════════════════════════════════════════════════════════════════
     * AND THE REST BURNS — `target:setEffect(target.EFF_BURNING, dur, {src=src,
     * power=dam / dur, no_ct_effect=true})`, damage_types.lua:1134-1138.
     * ═════════════════════════════════════════════════════════════════════════
     *
     * ONLY ON A BODY STILL STANDING. Upstream asks the map for an actor at the
     * tile (:1133), and a body the first half killed has left the map. Ours is
     * still on its tile, and `setEffect` refuses it — a corpse is immune to
     * everything, with no draw and no line — so no guard is repeated here.
     *
     * AND DECIDED HERE, BEFORE THE CASUALTY PASS, WHICH IS WHAT MAKES THAT TRUE.
     * `noteCasualty` can wipe the party and `resetFloorParty` stands everybody
     * up inside it. Asked after that, a body the hit killed is alive again, and
     * it was set alight and burnt twice inside the same pump — hp 496/500 on a
     * full restore, measured. Upstream settles the burn inside the projector,
     * while the body is still dead; so does this.
     *
     * NO `applyPower`, as upstream passes none: no save, no draw, full turns.
     *
     * `srcId` IS THE TRAP, as upstream's `src` is and as the bolt half above
     * is blamed. `getActor` cannot resolve it, so `BURNING`'s tick blames a bare
     * id with no sheet: nothing weakens the burn, since a trap is never stunned,
     * and nobody is paid for it. The sliding rock below passes no source
     * because upstream's passes none; this one passes the one upstream passes.
     */
    if (burn !== undefined && split !== undefined) {
      run.ctx.applyStatus?.(victim, burn.effectId, burn.turns, {
        power: split.power,
        srcId: trap.id,
        noCtEffect: true,
      });
    }

    const sprung: Effect = { kind: 'attack', ...blow };
    noteBlows(sprung, run);
    noteCasualty(sprung, run, sweepTurn, trap.id);
  } else if (trap.effect.kind === 'lethargy') {
    /**
     * ═════════════════════════════════════════════════════════════════════════
     * THE LETHARGY RUNE. It takes the buttons, not the hit points.
     * ═════════════════════════════════════════════════════════════════════════
     *
     * ```lua
     * for tid, lev in pairs(who.talents) do
     *   if not who.talents_cd[tid] and t.mode == "activated" then tids[#tids+1] = tid end
     * end
     * for i = 1, 3 do
     *   local tid = rng.tableRemove(tids)
     *   if not tid then break end
     *   who.talents_cd[tid] = rng.range(4, 7)
     * end
     * ```
     *
     * `traps/annoy.lua:36-45`. TWO FILTERS AND THEY LIVE IN DIFFERENT PLACES:
     * "is it activated" is a fact about the talent and comes from the content
     * seam; "is it ready" is a fact about this body and comes from
     * `actor.cooldowns`, which this engine already owns.
     *
     * ═══ `rng.tableRemove` REMOVES WHAT IT RETURNS ═══
     * So the picks are DISTINCT — a body with three ready talents loses all
     * three and never loses one of them twice — and the loop `break`s on an
     * empty list, which is why a body with one talent loses one rather than
     * erroring. Splicing out of a local copy is that, exactly.
     *
     * ═══ THE DRAWS ARE ORDERED AND EVERY ONE IS LABELLED ═══
     * A pick and then a duration, per talent, in that order. The number of
     * draws depends on how many ready talents the victim had, which is a fact
     * about the victim and not about the seed — and that is fine here because
     * nothing downstream of a trap re-rolls the floor.
     */
    const ready = (run.ctx.talents?.activatedOf?.(moverId) ?? []).filter(
      (talentId) => cooldownOf(victim, talentId) === 0,
    );
    for (let i = 0; i < trap.effect.count; i += 1) {
      if (ready.length === 0) break;
      const at = world.rng.int(`trap.lethargy.${trap.id}.pick${String(i)}`, 0, ready.length - 1);
      const [talentId] = ready.splice(at, 1);
      if (talentId === undefined) break;
      setCooldown(
        victim,
        talentId,
        world.rng.int(
          `trap.lethargy.${trap.id}.turns${String(i)}`,
          trap.effect.minTurns,
          trap.effect.maxTurns,
        ),
      );
    }
  } else if (trap.effect.kind === 'status') {
    /**
     * ═════════════════════════════════════════════════════════════════════════
     * A RIDER ON THE FLOOR — `who:setEffect(...)`, the commonest trap body.
     * ═════════════════════════════════════════════════════════════════════════
     *
     * THE SAME DOOR A MONSTER'S `onHit` USES, and deliberately so: `applyStatus`
     * shares `drainStatusLog`'s buffer, so the save line and the badge arrive
     * attached to this pump rather than floating loose at the end of the turn.
     *
     * ═══ NO `srcId`, WHICH IS UPSTREAM AND ALSO CORRECT HERE ═══
     * `{apply_power = self.disarm_power + 5}` is the whole params table — there
     * is no source actor on it. A trap is not a body: passing `trap.id` would
     * hand the status system an id that `getActor` cannot resolve, to attribute
     * a rider to something that was never standing anywhere.
     *
     * The resist branch upstream spells out (`canBe`, then "%s resists!") is
     * what `setEffect` does for us in one call: an immunity refuses outright,
     * and otherwise the Physical save is rolled against `applyPower` with the
     * Record line written either way.
     */
    run.ctx.applyStatus?.(victim, trap.effect.effectId, trap.effect.turns, {
      applyPower: trap.effect.applyPower,
    });
  } else if (trap.effect.kind === 'teleport') {
    /**
     * ═════════════════════════════════════════════════════════════════════════
     * THE TELEPORT TRAP. It does not hurt you; it takes you away from everybody.
     * ═════════════════════════════════════════════════════════════════════════
     *
     * ```lua
     * game:onTickEnd(function()
     *   game.logSeen(who, "%s is teleported away!", who.name:capitalize())
     *   who:teleportRandom(x, y, 100)
     * end)
     * ```
     *
     * `traps/teleport.lua:37-41`. `onTickEnd` is upstream deferring the move out
     * of the middle of a `checkAllEntities` walk over the map it is about to
     * edit — an iteration-safety measure, not a timing rule. Ours is already
     * outside that walk: `noteTrap` runs from the two act lanes, after
     * `tryMove` has finished, so the move happens here and the event ordering is
     * the same one the player sees.
     *
     * ═══ UPSTREAM CENTRES ON THE PLATE; OURS CENTRES ON THE BODY ═══
     * `teleportRandom(x, y, 100)` takes the trap's tile. Our `teleportRandom`
     * takes an actor and reads `actor.x`/`actor.y`, with no centre parameter to
     * pass one through. THE TWO COINCIDE, because a trap fires on the tile its
     * victim just arrived at — `noteTrap` returns early otherwise — so there is
     * no reachable case where they differ.
     *
     * Stated rather than assumed, because it is the sort of difference that
     * stays invisible until something springs a trap it is not standing on. On
     * that day this is the line to change, and the range is large enough that
     * a centre a tile or two out would not be observable anyway.
     */
    teleportRandom(world, victim, trap.effect.range, world.rng);
  } else {
    /**
     * ═════════════════════════════════════════════════════════════════════════
     * THE ALARM. No damage, no event, and the loudest thing on the floor.
     * ═════════════════════════════════════════════════════════════════════════
     *
     * NOTHING IS EMITTED HERE and that is not an omission. The board already
     * carries the consequence: every roused body starts walking toward the
     * victim on its own turn, which the sweep reports as ordinary movement
     * because that is what it is. An event saying "an alarm went off" would be
     * a second channel for a fact the screen is about to show anyway, and the
     * Record line above has already said it in words.
     */
    soundAlarm(world, victim, { x: trap.x, y: trap.y }, trap.effect.radius);
  }

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * AND IT IS GONE, IF IT WAS THE KIND THAT GOES — upstream's `del`.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * ```lua
   * if del then game.level.map:remove(x, y, Map.TRAP) end
   * ```
   *
   * `engine/Trap.lua:148-150`. LAST, after the effect and after the knowledge,
   * because both read the trap — and the knowledge is what makes removing it
   * safe to do while a client still holds it: the next `traps` frame is built
   * from `world.traps()` and simply stops listing it, which the client applies
   * wholesale.
   */
  if (trap.spent) world.removeTrap(trap.x, trap.y);
}

function noteRetaliation(
  effect: Effect,
  run: Run,
  sweepTurn: number | null,
  attackerId: string,
): void {
  if (effect.kind !== 'attack') return;
  if (!effect.hit) return;

  const defender = run.world.getActor(effect.targetId);
  if (defender === undefined) return;
  const table = defender.combat?.retaliation;
  if (table === undefined) return;

  const attacker = run.world.getActor(attackerId);
  if (attacker === undefined) return;

  let damage = 0;
  let killed = false;
  let type: DamageType | undefined;
  // `TypeTable` admits `'all'` and `on_melee_hit` never uses it — walking
  // `DAMAGE_TYPES` is what stops an `all` row becoming a ninth projection
  // nothing resists. Same rule, same reason, as the brand loop in combat.ts.
  for (const key of DAMAGE_TYPES) {
    const amount: number | undefined = table[key];
    if (amount === undefined || amount <= 0) continue;
    const burn = applyDamage(attacker, amount, key, defender, run.world.rng, {
      // THE DEFENDER'S, because the defender is the source. `defaultProjector`
      // (damage_types.lua:48) reads `src.inc_damage` and `src.resists_pen` off
      // whoever is projecting, and here that is the body being hit. Armour is
      // NOT passed, and that is the whole finding of the commit before this one:
      // `combat_armor` lives in `attackTargetWith` and a projector never sees it.
      ...(defender.combat?.increase === undefined ? {} : { increase: defender.combat.increase }),
      ...(defender.combat?.penetration === undefined
        ? {}
        : { penetration: defender.combat.penetration }),
    });
    damage += burn.dealt;
    if (burn.killed) killed = true;
    // THE FIRST TYPE THAT ACTUALLY LANDED, for the one `type` a `Blow` carries.
    // Upstream projects each separately and logs each separately; the wire has
    // one row per blow, and `brandDamage` already aggregates on the same terms.
    if (type === undefined && burn.dealt > 0) type = key;
  }

  // Nothing was authored, or everything authored was zero. No event, and
  // nothing downstream to run — `noteBlows` would refuse to pay Resolve for it
  // and `noteCasualty` has no body.
  if (damage <= 0 && !killed) return;

  // `hp` and `at` one line after the blow, for `strike`'s reason: a `Blow`
  // snapshots the two things that stop being true immediately.
  const blow: Blow = {
    targetId: attacker.id,
    hit: true,
    crit: false,
    ...(type === undefined ? {} : { type }),
    damage,
    killed,
    hp: attacker.hp,
    maxHp: attacker.maxHp,
    at: { x: attacker.x, y: attacker.y },
  };

  // THE ORDINARY `attacked` EVENT, ATTRIBUTED TO THE DEFENDER — no new event
  // kind and therefore no protocol bump, exactly as the guard counter argues.
  if (sweepTurn === null) run.sink.push(attackedEvent(defender.id, blow));
  else run.sink.sweep(sweepTurn, { t: 'attack', id: defender.id, ...blow });

  const retaliationEffect: Effect = { kind: 'attack', ...blow };
  noteBlows(retaliationEffect, run);
  noteCasualty(retaliationEffect, run, sweepTurn, defender.id);
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT THE FLOOR ITSELF DOES, ONCE A GAME TURN — Map.lua:1231-1254.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `engine/zones.ts` carries the rule; this is where it is spent, and the
 * PLACEMENT is the half that file cannot state.
 *
 * ═══ ON `onGameTurn`, WHICH IS UPSTREAM'S OWN CADENCE ═══
 * `Game.lua:1737` is `processEffects(self.turn % 10 ~= 0)` — the argument is
 * `update_shape_only`, so the damage-and-decrement pass runs on one tick in ten
 * and the other nine only move particles. ToME's `game.turn` counts TICKS and
 * ours counts game turns, so this hook IS that modulo. Hung off the pump
 * instead, a four-turn fire would be gone before anybody finished a sentence.
 *
 * ═══ AFTER `updateEngagement`, AND IT IS NOT ARBITRARY ═══
 * A zone can kill, and a kill is what `updateEngagement` reads the board for.
 * Burning first would let the engagement decay be computed against a body that
 * is about to stop existing this same instant; burning after means the floor's
 * damage lands on a board whose combat state has already been settled for the
 * turn, exactly as a monster's swing does.
 *
 * ═══ THE BODIES ARE ENROLLED, NOT BURIED — `noteCasualty`'S RULE ═══
 * A zone hit is re-entered as a one-blow `attack` effect attributed to the
 * ZONE'S SOURCE, which is `noteGuardCounter`'s argument one more time:
 * `noteCasualty` spends exactly one `killerId` on the kill credit and the
 * experience, and a fire that killed something has a killer — the body that lit
 * it. A zone whose source has left the world still burns (see `tickZones`), and
 * `noteCasualty` handles an unknown killer id the way it always has.
 */
function tickGroundZones(run: Run, sweepTurn: number | null): void {
  const { world } = run;
  const tick = tickZones(world, world.rng);

  for (const hit of tick.hits) {
    const victim = world.getActor(hit.victimId);
    // `hp` and `at` one line after the burn, for `strike`'s reason: a `Blow`
    // snapshots the two things that stop being true immediately.
    const blow: Blow = {
      targetId: hit.victimId,
      hit: true,
      crit: false,
      type: hit.outcome.type,
      damage: hit.outcome.dealt,
      killed: hit.outcome.killed,
      hp: victim?.hp ?? 0,
      maxHp: victim?.maxHp ?? 0,
      at: { x: victim?.x ?? 0, y: victim?.y ?? 0 },
    };

    /**
     * THE ORDINARY `attacked` EVENT — no new event kind and therefore no
     * protocol bump, which is the same argument the guard counter and the
     * spikes both make.
     *
     * ═══ BUT FLAGGED `ambient`, BECAUSE NOBODY SWUNG ═══
     * The reuse is right about the plumbing and wrong about the sentence. An
     * `attacked` event implies a verb and a swinger, and the body that lit this
     * patch is usually dead and often already reaped — so the Case Log said
     *
     *     someone hits Ren.        3 physical damage. Ren 51/60.
     *
     * once a game turn, for as long as the fire burned. `hitToWire` takes the
     * heal's exit on this flag and emits the damage alone: no verb, no name, no
     * struck-tile marker. The player can see the tile is burning now, which is
     * the half of the answer the wash provides.
     */
    // BUILT RATHER THAN SPREAD. `attackedEvent` returns the whole `GameEvent`
    // union, so `{ ...attackedEvent(...), ambient: true }` widens to "every
    // variant, plus ambient" and stops being assignable. The `attacked` shape is
    // named here instead.
    if (sweepTurn === null) {
      run.sink.push({ t: 'attacked', id: hit.srcId, ...blow, ambient: true });
    } else run.sink.sweep(sweepTurn, { t: 'attack', id: hit.srcId, ...blow, ambient: true });

    const effect: Effect = { kind: 'attack', ...blow };
    noteBlows(effect, run);
    noteCasualty(effect, run, sweepTurn, hit.srcId);
  }

  // AND THE BURNT-OUT ONES GO, HERE RATHER THAN INSIDE THE WALK. `tickZones`
  // returns the ids for `PumpResult.reaped`'s reason — a table that deleted its
  // own rows mid-walk is the classic way to skip one.
  for (const id of tick.expired) world.removeZone(id);
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE TILE UNDER A BODY DOES SOMETHING — `on_stand`, tome/class/Actor.lua:681.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ```lua
 * game.level.map:checkEntity(self.x, self.y, Map.TERRAIN, "on_stand", self)
 * ```
 *
 * Two grids answer: LAVA_FLOOR burns and WATER_FLOOR_BUBBLE spends a charge
 * (`shared/terrain.ts` `ON_STAND`). A FAKE twin is a different code with no
 * entry, so it does nothing here and nothing needs to ask.
 *
 * ═══ ON THE BASE CLOCK, ONCE A GAME TURN, AND THAT IS A DIVERGENCE (D5-4) ═══
 * Upstream fires this inside `act()`, after `actBase` in the same tick
 * (engine/GameEnergyBased.lua:114-130), so for a speed-1 body it is once a game
 * turn, after the air step — which this keeps. Here it hangs off the `actBase`
 * callback instead, because our `act` is re-entered on every `Park` and every
 * idle resolve pass and would burn a waiting player once per pass. The
 * consequences, every one of them once a game turn where upstream is once an
 * action: a hasted body burns once a turn, not three times; a slowed body burns
 * every turn, not every other one; a monster out of the fight, whose `act`
 * returns early, still burns and still spends a bubble; and a player who takes
 * several steps in one round burns once, on the tile they stand on when their
 * base clock ticks. `test/server/onstand.test.ts` pins the first three; the
 * last rides on the same clock and has no test of its own.
 *
 * ═══ LAST IN THE PASS, AFTER `survivalPass` ═══
 * Upstream's `on_stand` runs after the whole of `actBase`. A burn that downs a
 * player enrols them through `noteCasualty`, as a zone's burn does, so the
 * countdown above did not need to see it first — and a body already down when
 * the pass began is skipped here, as upstream skips a dead body's `act`.
 *
 * ═══ THE FACTION CHECK IS NOT PORTED ═══
 * `if self.faction and who:reactionToward(self) >= 0 then return end`
 * (data/general/grids/lava.lua:34). No grid here has a faction, which is also
 * true of every plain upstream lava floor, so it would never fire.
 */
function onStandPass(actor: EngineActor, run: Run): void {
  if (!actor.alive) return;
  const { world } = run;
  const code = tileAt(world.level, actor.x, actor.y);

  const burn = burnOf(code);
  if (burn !== undefined) {
    const span = world.burnRange(code);
    if (span === undefined) return;
    const sourceId = terrainSourceId(code);
    // `DT:get(DT.FIRE).projector(self, x, y, FIRE, rng.range(mindam, maxdam))`
    // (data/general/grids/lava.lua:36): the ordinary projector, so resists,
    // shields and affinity all apply, from a source with no sheet at all.
    const outcome = applyDamage(
      actor,
      rollBurn(world.rng, span),
      burn.type,
      { id: sourceId },
      world.rng,
    );
    // Nothing landed — fully resisted, or eaten by a shield. Upstream's line
    // below is gated on `dam > 0`, and a zero is the non-event `noteBlows`
    // refuses to pay for; the retaliation lane makes the same call.
    if (outcome.dealt <= 0 && !outcome.killed) return;

    const blow: Blow = {
      targetId: actor.id,
      hit: true,
      crit: false,
      type: outcome.type,
      damage: outcome.dealt,
      killed: outcome.killed,
      hp: actor.hp,
      maxHp: actor.maxHp,
      at: { x: actor.x, y: actor.y },
    };
    // `ambient`, for the zone burn's and the trap's reason: nobody swung.
    run.sink.push({ t: 'attacked', id: sourceId, ...blow, ambient: true });

    // `if dam > 0 and who.player then self:logCombat(who, "#Source# burns #Target#!")`
    // (:38). The `dam > 0` half is the return above. Players only, for the
    // trap's reason as well as upstream's: the Record lane is a realm-wide
    // broadcast with no per-viewer form.
    if (actor.kind === ActorKind.Player) {
      run.records.push(trapSentence(burnMessage(code), actor.name));
    }

    const burnt: Effect = { kind: 'attack', ...blow };
    noteBlows(burnt, run);
    noteCasualty(burnt, run, null, sourceId);
    return;
  }

  /**
   * THE BUBBLE — data/general/grids/water.lua:106-115. The +15 air already
   * came from `actBase`'s air step (its `air_level`); this is only the charge.
   */
  if (bubbleOf(code) === undefined || !spendsBubble(actor)) return;
  const left = world.spendBubble(actor.x, actor.y);
  if (left === undefined || left > 0) return;
  // `game.logSeen(who, ...)`: players only, for the burn's reason above.
  if (actor.kind === ActorKind.Player) run.records.push(BUBBLES_DEPLETED);
  world.depleteBubble(actor.x, actor.y);
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A MONSTER IS BURIED. THE FOUR THINGS THAT HAPPEN, IN ONE PLACE AT LAST.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ═══ THERE WERE TWO BURIAL SITES AND ONLY ONE OF THEM WAS OBVIOUS ═══
 * `noteCasualty` handles every BLOW-driven death across six lanes. It is not the
 * only one: `resolveStatusHits` buries a monster killed by a bleed and does the
 * same four things INLINE, deliberately, because `noteCasualty` derives its
 * victims from an `Effect` and a damage-over-tick produces none — its own note
 * says manufacturing a fake outcome *"would put a lie in the one structure the
 * Record lane reads back"*.
 *
 * That reasoning is still right, and it is an argument about the ARGUMENT, not
 * about the body. So the body moves here and both callers keep their own way of
 * deciding who died. The duplication was survivable while it was four lines; it
 * stopped being survivable the moment a fifth thing had to happen on death,
 * because a fifth thing added to one site and not the other is invisible — a
 * creature bled out rather than hit would simply not do it, and nothing in the
 * suite would go red.
 *
 * ═══ THE KILLER MAY BE NOBODY, WHICH IS WHY THE ID IS NULLABLE ═══
 * `noteCasualty` always has one. `resolveStatusHits` has `hit.sourceId`, which
 * is `string | null` — a bleed whose author has already been buried. `noteKill`
 * and `awardExperience` are the two that need a name and they are skipped when
 * there is none, exactly as that site skipped them before. The reap, the spill
 * and the death row do not care who did it.
 *
 * ═══ THE ORDER IS UPSTREAM'S AND IT IS NOT AN IMPLEMENTATION DETAIL ═══
 * `Actor:die` (tome/class/Actor.lua:2975) reaches `engine/interface/ActorLife.lua:91`,
 * whose `self:check("on_die", src, death_note)` fires BEFORE the experience
 * award at Actor.lua:2983-2988 and before the drop spill at :3011-3060. So:
 * enrol, then the death row, then the credit, then the pockets.
 *
 * Putting the row after `spillLoot` would also read a body whose `carried` and
 * `equipped` that function has already emptied.
 */
function noteMonsterDeath(
  run: Run,
  victim: MonsterActor,
  killerId: string | null,
  sweepTurn: number | null,
): void {
  /**
   * A MONSTER JOINS THE REAP LIST. IT IS NOT REMOVED HERE.
   *
   * `tome/class/Actor.lua:2975` -> `engine/interface/ActorLife.lua:86-94`
   * removes the entity as the last act of dying. We enrol instead and let the
   * caller bury the body, because the Record lane still has to NAME it: it
   * re-resolves ids through `world.getActor` after the pump has returned, so a
   * body deleted here narrates as "someone 0/0" and an orb in flight loses its
   * shooter. See `PumpResult.reaped`.
   */
  run.reaped.push(victim.id);

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * AND WHAT THE BODY LEAVES ON THE FLOOR — `on_die`. See `OnDeathZone`.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * ```lua
   * -- general/npcs/vermin.lua:82-91
   * on_die = function(self, src)
   *   game.level.map:addEffect(self, self.x, self.y, 5,
   *     engine.DamageType.BLIGHT, self:getStr(90, true), 2, 5, nil, ...)
   * ```
   *
   * ═══ THE BODY IS STILL ON ITS TILE, WHICH IS THE WHOLE REASON THIS SLOT ═══
   * `spillLoot`'s note already states the property this depends on: the corpse
   * is enrolled rather than removed, so `victim.x/y` is still the tile it died
   * on until the caller buries it after the pump returns. A zone placed after
   * the reap would have nowhere to go.
   *
   * ═══ IT TAKES NO DRAW, AND THAT IS LOAD-BEARING RATHER THAN INCIDENTAL ═══
   * `world.addZone` advances a monotonic counter and nothing else.
   * `spillLoot`'s docblock is an outright prohibition on drawing at the moment
   * of death — one `rng.percent()` here *"moves every subsequent draw in that
   * pump and in every pump after it"* — and `OnDeathZone` has no `chance` field
   * for exactly that reason.
   *
   * ═══ AND IT STOPS AT THE WALLS — `engine/Map.lua:1103-1104`'S BLOCKING FLAG ═══
   * Upstream's `core.fov.circle_grids(x, y, radius, true)` shadowcasts, and
   * the `true` makes terrain `block_move` the wall. `visibleFrom` is that call
   * (`shared/ball.ts` with `blocksMove`) plus our `canWalk` clause. It WAS the
   * talent ball's disc filtered by a Bresenham line over `blocksSightAt`,
   * because `ballTiles` took no level; that asked sight where upstream asks
   * movement, and a cloud crossed lava it should have stopped at. It used to add
   * that changing the footprint "would reorder `actorsInShape` and move every
   * seed in the suite"; that was false — a narrower or wider disc walked in the
   * same row-major order keeps every shared tile's place, so only a body on an
   * added or removed tile moves a draw. `visibleFrom`'s note has the argument.
   *
   * THE DISC ITSELF IS ToME'S: `discTiles`, so a radius-1 cloud covers the
   * whole 3x3 the body fell in the middle of, where the exact-Euclid disc
   * `ballTiles` used to cut left the four diagonals out. A wall cannot take a
   * tile from a radius-1 ball; only radius 2 and up can lose one.
   *
   * This paragraph used to say the flag could wait — *"nothing living stands in
   * a wall … the day zones are DRAWN, a cloud will appear to seep through"* —
   * and it was right about the harm and wrong about the timing. The tile list
   * is what a renderer draws, so the flag has to be true BEFORE anything draws
   * it, not at the same time.
   */
  const leaves = victim.onDie;
  if (leaves !== undefined) {
    run.world.addZone({
      srcId: victim.id,
      tiles: visibleFrom(run.world.level, { x: victim.x, y: victim.y }, leaves.radius),
      type: leaves.type,
      damage: leaves.damage,
      turns: leaves.turns,
      // A DEAD SOURCE CANNOT BE SPARED, so this is `false` rather than a
      // decision: `tickZones` reads `selfFire` against a body that is about to
      // leave the world, and the corpse is not standing anywhere by the time
      // the first tick comes round.
      selfFire: false,
      friendlyFire: leaves.friendlyFire,
    });
  }

  if (killerId !== null) {
    /**
     * ═════════════════════════════════════════════════════════════════════
     * AND THE KILLER IS PAID. THE ONE PLACE IN THE GAME THAT DOES.
     * ═════════════════════════════════════════════════════════════════════
     *
     * `TalentResolution.noteKill` has the full argument. In short: the only two
     * callers of `TalentEngine.noteKill` were inside engine/talents.ts's own
     * damage helpers, so the basic weapon swing — which is where most of an
     * Alchemist's kills come from — paid nothing, her eight reagents drained
     * monotonically, and her whole hotbar answered `no_resource` permanently.
     *
     * `killed` is true exactly once per body (`applyDamage` returns an empty
     * outcome against something already down), so this cannot double-pay a
     * party of four racing the same husk — the same property that makes the
     * reap enrolment above idempotent.
     */
    const killer = run.world.getActor(killerId);
    run.ctx.talents?.noteKill(killerId, {
      rank: victim.rank,
      level: victim.level,
      /**
       * A KILLER WHOSE BODY IS ALREADY GONE is not hypothetical: the projectile
       * lane freezes `sourceId` at the muzzle and the shooter can be several
       * game turns dead when the orb lands (`awardExperience` opens on the same
       * fact). `killerLevel` is read by the out-of-depth clause ALONE, and that
       * clause compares it against the victim's own level — so handing it the
       * victim's level makes the clause answer "not out of depth" rather than
       * inventing a number for a body nobody can look at.
       */
      killerLevel: killer?.level ?? victim.level,
    });
    // AND THE EXPERIENCE, ON THE SAME LINE OF REASONING AND FOR THE SAME REASON
    // IT IS HERE RATHER THAN IN A TALENT. See `awardExperience`.
    awardExperience(run, killerId, victim);
  }

  // ...AND THE BODY EMPTIES ITS POCKETS ONTO THE TILE IT FELL ON. See
  // `spillLoot`: it takes NO DRAW, and it is here rather than at the kill site
  // in damage.ts for exactly that reason.
  spillLoot(run, victim, sweepTurn, killerId);
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
 * `applyDamage`'s `!target.alive` guard returns an empty outcome against
 * something already down, so
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
      /**
       * THE FOUR THINGS, AND THEY ARE NO LONGER WRITTEN OUT HERE. See
       * `noteMonsterDeath`: `resolveStatusHits` buries a monster too and had
       * its own copy of this block, which is fine for four lines and stops
       * being fine the moment a fifth thing has to happen on death.
       *
       * MONSTERS ONLY, and that still falls out of the branch rather than
       * needing a guard: nothing pays for putting a PLAYER down, which is the
       * arm below.
       */
      noteMonsterDeath(run, victim, killerId, sweepTurn);
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
 * `alive`, and `applyDamage`'s `!target.alive` guard returns an EMPTY outcome
 * against something already
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
function spillLoot(
  run: Run,
  victim: EngineActor,
  sweepTurn: number | null,
  killerId: string | null,
): void {
  const loot = run.ctx.loot;
  if (loot === undefined) return;

  // THE BODY, NOT THE ID, because the seam has to read a ledger off it — see
  // `LootResolution.spillOrder`. A killer that has already been buried resolves
  // to `null` here and the seam treats it as "nobody is credited", which is the
  // same answer `awardExperience` gives an id it cannot resolve.
  const killer = killerId === null ? null : (run.world.getActor(killerId) ?? null);
  const itemIds = loot.spillOrder(victim, killer);
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
   * ═════════════════════════════════════════════════════════════════════════
   * HOW DEEP THE CORPSE CAME FROM — read ONCE, off the body that died.
   * ═════════════════════════════════════════════════════════════════════════
   *
   * Actor.lua:6530's `self.level`, where `self` is the thing being asked what it
   * is worth. Read here rather than inside the payout loop because it is a fact
   * about the CORPSE and cannot vary per recipient — where the recipient's own
   * level, which the floor at :6514 compares it against, obviously can.
   */
  const victimLevel = victim.level;

  /**
   * AND WHICH OF UPSTREAM'S TWO LADDERS IT IS PAID ON — Actor.lua:6519.
   *
   * `if not game.zone.infinite_dungeon then` is a branch over the whole rank
   * table, not a modifier on it (`shared/progression.ts` `RANK_WORTH_INFINITE`).
   * Read off the CORPSE for the same reason its level is: `payParty` is handed
   * a body and a list of people and has no zone to ask. See
   * `MonsterActor.infiniteDungeon` for why born-here and died-here cannot
   * disagree.
   */
  const infiniteDungeon = victim.kind === ActorKind.Monster ? victim.infiniteDungeon : undefined;

  /**
   * 2. AND IT MAY BE A MONSTER — BEFORE ANY party.ts CALL, WHICH IS THE WHOLE
   *    POINT OF THE ORDER. Monster-kills-monster is representable (a stray orb,
   *    a future charm) and `partyOf` MUTATES: it mints a party on demand and says
   *    so at party.ts:275-290, "IT MUTATES, AND THAT IS THE CONTRACT". Both
   *    `membersOf` and `partyIdOf` go through it. Touching the table with a
   *    husk's id therefore leaves a party row for a body that only `forgetActor`
   *    ever clears — a leak with no symptom, which is why the test for it asserts
   *    on `state.byId.size` rather than on anything a player could see.
   *
   *    ═══ AND THE GUARD STAYS. ONE MONSTER IS CREDITED THROUGH SOMEBODY ═══
   *    ELSE'S ID, WHICH IS NOT THE SAME THING AS RELAXING IT.
   *
   *    A `Faction.Squad` companion is a body the party brought, and upstream
   *    pays the owner for what a body it lent you kills: `Actor.lua:2984-2987`
   *    awards `src:resolveSource()`, and `resolveSource` (`:2911-2917`) is
   *    `if self.summoner_gain_exp and self.summoner then return
   *    self.summoner:resolveSource() end` — the chain is walked to a root and
   *    the ROOT is paid.
   *
   *    So the branch resolves an owner and hands party.ts a PLAYER's id, which
   *    is the property this guard exists for; it never hands it the
   *    companion's. An `anchorId` that resolves to nothing, or to a body that
   *    is not a player, pays nobody — a companion whose anchor has taken the
   *    stair is a companion with no owner on this floor, and inventing one
   *    would be inventing a party row.
   *
   *    ═══ WHY IT IS WORTH A BRANCH AT ALL ═══
   *    Without it a companion that lands the last blow on a floor pays the
   *    people who walked it NOTHING, which makes the one thing the companion is
   *    for — fighting beside you — a reason to keep it out of the fight. Same
   *    argument the Quarry makes when it refuses to care who killed it.
   *
   *    ═══ AND `Faction.Bound` IS DELIBERATELY NOT IN THIS BRANCH ═══
   *    A shadow's kill still pays nobody. That is not an omission this fixes by
   *    accident: `talents/call_shadows.ts` states it as a divergence with a
   *    measured price (`summoner_gain_exp` and `summoner_hate_per_kill` "did
   *    not cross" — thirteen Ink down against having swung herself) and argues
   *    it as the reason to press the button to HOLD a line rather than to farm
   *    one. Reversing somebody's argued decision is not a side effect of adding
   *    a faction. If it is ever revisited, it is one clause here and both
   *    bodies go through the same lines.
   */
  let creditedId = killerId;
  if (killer.kind !== ActorKind.Player) {
    const owner = killer.faction === Faction.Squad ? killer.anchorId : undefined;
    if (owner === undefined) return;
    const ownerBody = run.world.getActor(owner);
    if (ownerBody === undefined || ownerBody.kind !== ActorKind.Player) return;
    creditedId = owner;
  }

  /**
   * 3. WHO IS PAID. `PumpCtx.parties` is already in scope through `run.ctx`, so
   *    there is no new plumbing: with no party table wired in this is the
   *    pre-party game exactly, one recipient, and with one it is the killer's
   *    whole party INCLUDING the killer (`membersOf` returns them).
   *
   *    `creditedId` AND NOT `killerId`, WHICH IS THE WHOLE OF THE BRANCH ABOVE:
   *    for everything that has ever killed anything here the two are the same
   *    id, and for a companion the second one is a monster's.
   */
  const recipients =
    run.ctx.parties === undefined ? [creditedId] : membersOf(run.ctx.parties, creditedId);

  /**
   * 4. AND THE PAYOUT ITSELF, WHICH IS NOW SHARED.
   *
   * Everything above this line is about a KILL — the killer may not exist, the
   * killer may be a monster, and `partyOf` mutates so the table must not be
   * touched before both of those are answered. Everything below it is about
   * PAYING A LIST OF PEOPLE for a body of a level and a rank, which is also
   * what closing an objective is (`world/brief.ts`, `BriefReward`).
   *
   * EXTRACTED AND NOT COPIED. The half worth protecting is the essay inside
   * `payParty` about the award being computed per recipient from the
   * RECIPIENT'S own level: a second copy of that loop would agree with this one
   * on the day it was written and disagree the first time either moved.
   */
  payParty(
    (id) => run.world.getActor(id),
    recipients,
    victimLevel,
    victim.rank,
    run.world.turn.clock.gameTurn,
    infiniteDungeon,
  );
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * PAY A LIST OF PEOPLE FOR ONE NOTIONAL CORPSE. THE LOOP, AND NOTHING ELSE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `awardExperience` above keeps its three guards, its killer resolution and its
 * party lookup; this is the part that hands out the experience, and it is
 * exported so that closing an objective pays through the SAME loop a kill does
 * rather than through a second one that agrees with it today.
 *
 * ═══ `killTurn` IS `null` FOR A PAYOUT THAT IS NOT A KILL ═══
 * `lastKillTurn` is the anti-stairscum lock (`Game.lua:880` `last_kill_turn`):
 * walk in, kill the first thing, walk straight back out to a freshly generated
 * floor. It rides this loop for a kill because this file has already decided a
 * kill is the PARTY'S event — charge only the killer and one player kills while
 * another opens the door. An OBJECTIVE closing is not a kill and must not shut
 * the stairs: a party that has just finished what a floor asked of them is
 * exactly the party that should be able to leave it.
 *
 * NO DIVISION BY HEADCOUNT, NO PROXIMITY CHECK, NO RADIUS, and no
 * `alive`/`connected` filter — DECISIONS.md D12, unchanged.
 *
 * ═══ IT TAKES A LOOKUP AND NOT A `World`, AND THAT IS THE WHOLE OF ONE BUG ═══
 * It took `world` and resolved every recipient through it, which is right for a
 * KILL — a kill is an event on one floor, and a party member who is somewhere
 * else did not stand in that fight. It is WRONG FOR A BRIEF, which is a party
 * contract rather than a floor event (the design's F.1), and the difference was
 * player-visible in the shipped configuration: an escort whose destination is
 * the way out is finished AT THE DOOR, which is exactly where a party files out
 * one at a time. Driven over two sockets — both accept, the lead steps out
 * first, the mate walks her the last few tiles — the mate levelled, THE LEAD'S
 * `xp` DID NOT MOVE, and the lead's Case Log read *"Done: The way back, with
 * her."* The person who agreed to it was told it was finished and paid nothing.
 *
 * So the RESOLUTION is the caller's and the LOOP is still only here: the kill
 * passes its own world's lookup and `net/gateway.ts#payBrief` passes one that
 * asks `realms.realmOf` first. One loop, two questions about where somebody is,
 * and neither of them copied.
 */
export function payParty(
  bodyOf: (id: string) => EngineActor | undefined,
  recipients: readonly string[],
  victimLevel: number,
  rank: ActorRank,
  killTurn: number | null,
  /**
   * `game.zone.infinite_dungeon` (Actor.lua:6519) — which rank ladder this
   * body is worth. Absent everywhere but the Infinity Tower, and absent is
   * upstream's ordinary ladder, so no existing caller moves a number.
   */
  infiniteDungeon?: true,
): void {
  for (const recipientId of recipients) {
    // 5. Ids, not bodies (see the party.ts note above), so each is resolved and
    //    anything that is not a player is skipped.
    const member = bodyOf(recipientId);
    if (member === undefined || member.kind !== ActorKind.Player) continue;

    /**
     * ═════════════════════════════════════════════════════════════════════════
     * 6. THE AWARD IS COMPUTED PER RECIPIENT, FROM THE RECIPIENT'S OWN LEVEL.
     * ═════════════════════════════════════════════════════════════════════════
     *
     * `worthExp` is `victimLevel × rankWorth(rank) × XP_WORTH_MULT`, which is
     * Actor.lua:6513-6544 as written — and it takes the RECIPIENT'S level too,
     * for the anti-farming floor at :6514, and the zone's flag for the choice
     * of ladder at :6519.
     *
     * ═══ IT USED TO BE THE RECIPIENT'S LEVEL, AND THAT WAS A STATED DEVIATION ═══
     * src/shared/progression.ts carried the substitution and its own expiry
     * condition: *"the day floors and monster levels land, this MUST be swapped
     * back to the victim's level"*. Delves ship monster levels 1 to 15 and
     * `monsterInit` now records them, so this is that day.
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
    const award = worthExp(victimLevel, rank, member.level, infiniteDungeon === true);

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
    // `member.expMod` IS THE ORIGIN'S PENALTY, and it belongs on the recipient
    // rather than the killer: upstream multiplies the CHART, which is a fact
    // about whose levels these are. A party of two origins levels at two rates
    // off the same kill, which is exactly what upstream does.
    const gained = gainExp(member.level, member.xp, award, member.expMod ?? 1);
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
    if (killTurn !== null) member.lastKillTurn = killTurn;
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
    // `extra_talent_point_every` RIDES ALONG, and `atBirth` deliberately does
    // not — nor does anybody's 3/2/1 (tome/class/Actor.lua:170-172). A birth
    // grant is a term in the progression totals, which the gateway pays into
    // the purses once (seeded fresh, or recomputed on a restore); it is never
    // re-granted on a level crossed. `from` is the first level GAINED, so it is
    // never 1, and the per-level functions answer 0 at 1 anyway.
    const originBonus = { every: actor.extraPointEvery };
    actor.unspentPoints += pointsForLevel(level, originBonus);
    // AND THE GENERIC POINT, which is the same grant seen from the other side:
    // two a level, always, and a fifth level moves one of them across.
    actor.unspentGenerics += genericPointsForLevel(level, originBonus);
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
    const restored = resetFloorParty(players, survival.state);
    // BREATHING, BEFORE ANOTHER BASE TURN CAN PASS. The party is stood up HERE,
    // mid-pump, and base turns run until it parks; `resetFloor` only moves it
    // after `pump` returns. See `restoreBreath`.
    for (const id of restored) {
      const body = run.world.getActor(id);
      if (body !== undefined) restoreBreath(run.ctx, body);
    }
    run.sink.push({
      t: 'party_wipe',
      gameTurn: run.world.turn.clock.gameTurn,
      partyId: scopeId,
      duringSweep: sweepTurn !== null,
      restored,
    });
  }
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * STAND UP BREATHING — the air refilled and `EFF_SUFFOCATING` taken off.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Every way this game gives a body back — the wipe, a revive, a respawn — is
 * upstream's one way back from death, `cleanActor` plus `restoreResources`
 * (dialogs/DeathDialog.lua:92-128), as far as breath goes. See `catchBreath`.
 *
 * `noRemove` is why this has to be said out loud: the wipe's `dispel` cannot take
 * Suffocating off, a downed body skips `actBase`, and the Weir's arrival is
 * water. Measured before this existed: a solo player who drowned there was
 * restored at air 0 with the blow at 40%, downed again two turns later, and from
 * the eighteenth turn wiped on every turn with no end.
 *
 * A REVIVE KEEPS ITS 25% AND EVERY OTHER STATUS. Only breath is restored there:
 * a body picked up at a quarter of its life, still suffocating at 25% or more a
 * turn, is dead on the next base turn, so a revive in water would do nothing.
 */
function restoreBreath(ctx: PumpCtx, body: EngineActor): void {
  catchBreath(body);
  ctx.stopSuffocating?.(body);
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
 *
 * ONE COUNTDOWN, THE REALM'S — no scope is passed, which is barrier.ts's level
 * slot. See `PumpCtx.parties` for why it is not one per party any more.
 */
function applyBellExpiry(
  world: World,
  actors: readonly EngineActor[],
  ctx: PumpCtx,
  sink: EventSink,
): void {
  // A REALM THAT OWES NO DECISION IS SKIPPED, NOT WAITED ON — see `canDecide`.
  // `bell` is still asked, and the reason is its SIDE EFFECT: an unarmed
  // survey RETIRES the countdown. Skipping the call as well would leave a row
  // behind from before everybody went down, and a solo player coming back off
  // the floor would inherit whatever was left of the clock they were on when
  // they fell — which reads as the Bell firing on somebody the instant they
  // get up (floor-reset.test.ts, "hands a party coming back off the floor a
  // FRESH countdown").
  if (!canDecide(actors)) {
    ctx.barrier.bell(actors, world.turn, ctx.nowMs);
    return;
  }

  for (const pass of ctx.barrier.expire(actors, world.turn, ctx.nowMs)) {
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
// Initiative — who goes first when a party's fight starts. OURS.
// ---------------------------------------------------------------------------

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * INITIATIVE: A PARTY TAKES ITS TURNS IN ORDER, AND THE ROLL SETS THE ORDER.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * NOT A PORT. ToME has no initiative ("initiative" is in neither engines/ nor
 * modules/tome/class/): it walks a fixed entity array (GameEnergyBased.lua:
 * 99-107) and whoever is ready acts in array order. The author ruled on
 * 2026-09-23 that in a multiplayer fight "initiative should matter for the
 * initial combat turn order", and alone play stays ToME's. So:
 *
 * - IN A REALM WITH TWO OR MORE PLAYERS, every living body — players and
 *   monsters, each for itself — rolls when the fight starts, and the roll is
 *   the array order (`World.actorsInTurnOrder`) for the rest of the fight.
 *   Everybody at normal speed spends exactly one turn per action, so the order
 *   repeats round after round; a faster or slower body still interleaves by
 *   energy, as in ToME. A body that joins mid-fight (a summon) rolls when it
 *   is first seen.
 * - ALONE, NOBODY ROLLS, and the order is the party-first one it always was.
 * - OUT OF A FIGHT, NOBODY HAS ONE. The next contact rolls fresh.
 *
 * 1d10 + (Dex + Cun) / 10, from a FORK per body and per fight, so the roll
 * spends nothing from the world's stream and every seeded replay that never
 * met a party is byte-identical.
 */
function ensureInitiative(world: World, actors: readonly EngineActor[]): void {
  const party = actors.filter((actor) => actor.kind === ActorKind.Player).length;
  if (world.turn.engagement <= 0 || party < 2) {
    for (const actor of actors) actor.initiative = undefined;
    return;
  }
  for (const actor of actors) {
    if (actor.alive && actor.initiative === undefined)
      actor.initiative = rollInitiative(world, actor);
  }
}

/** One body's roll. See `ensureInitiative`. */
export function rollInitiative(world: World, actor: EngineActor): number {
  const rng = world.rng.fork(`initiative:${actor.id}:${String(world.turn.clock.gameTurn)}`);
  const stats = actor.combat?.stats;
  return rng.int('initiative.d10', 1, 10) + ((stats?.dex ?? 10) + (stats?.cun ?? 10)) / 10;
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
  ctx: PumpCtx,
  sink: EventSink,
  decay: boolean,
): void {
  const before = world.turn.engagement;

  if (anyContact(world, actors)) {
    world.turn.engagement = ENGAGEMENT_TURNS;
  } else if (before > 0 && (stillAfflicted(actors, ctx) || stillHunting(actors))) {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * IT EXTENDS COMBAT AND CANNOT START IT — `tome/class/Actor.lua:7649`.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `checkStillInCombat` opens `if not self.in_combat then return end`, so
     * upstream's effect clause only ever stops combat LAPSING. The first draft
     * of this put it beside `anyContact` in the same `if`, where it can also
     * BEGIN combat — and that version is a catastrophe rather than a bug.
     *
     * A SHARED REALM'S `engagement` MUST STAY AT ZERO. It is the last clause of
     * `isBlocking` (engine/barrier.ts), and today that holds structurally: a
     * town has no hostiles, so `anyContact` is false and nothing else could
     * raise it. Let a bleeding player raise it and the first detective to walk
     * out of a delve with a wound puts every unrelated person in Alderbrook into
     * a single barrier, waiting on a stranger, with a Bell running and nothing
     * on screen to explain it. That is the precise failure roamers are markers
     * to avoid and `assertNoCombatInSharedSpace` throws over.
     *
     * `before > 0` is the whole guard, and it is upstream's own line.
     *
     * TWO CLAUSES SHELTER BEHIND IT NOW. `stillHunting` was added here rather
     * than beside `anyContact` for precisely the reason written above, and it
     * gets the argument for free: whatever cannot start combat cannot start it
     * in a town either.
     */
    world.turn.engagement = ENGAGEMENT_TURNS;
  } else if (decay && world.turn.engagement > 0) {
    world.turn.engagement -= 1;
  }

  if (world.turn.engagement !== before) {
    sink.push({ t: 'engagement', turns: world.turn.engagement });
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
/**
 * Is anybody still carrying the fight on them? `tome/class/Actor.lua:7658-7662`.
 *
 * THE HALF OF `checkStillInCombat` THIS ENGINE DID NOT HAVE. Upstream asks twice
 * whether combat is over — once for contact, and then again for any detrimental
 * effect still counting down — and only lets it lapse if BOTH are quiet. Ours
 * asked the first question and stopped, so the last husk dying ended combat
 * while the person it had opened up was still bleeding.
 *
 * ═══ PLAYERS ONLY, WHICH IS OURS AND NOT UPSTREAM'S ═══
 * `checkStillInCombat` runs per actor and a bleeding MONSTER keeps its own
 * `in_combat` flag up. Ours is level-wide (see `updateEngagement`), so asking
 * about monsters would mean one husk limping away with a bleed on it holds the
 * whole floor in lockstep — an empty room that will not release the party
 * because something they already beat is dying somewhere else. The clause is
 * about the person in danger, and the person in danger is a player.
 */
function stillAfflicted(actors: readonly EngineActor[], ctx: PumpCtx): boolean {
  const carrying = ctx.stillFighting;
  if (carrying === undefined) return false;
  for (const actor of actors) {
    if (actor.kind !== ActorKind.Player || !actor.alive) continue;
    if (carrying(actor.id)) return true;
  }
  return false;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * IS ANYTHING STILL HUNTING? THE CLAUSE THAT LET `PURSUIT_TURNS` EXIST.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `ai/npc.ts` ports upstream's `ai/simple.lua:210`: a monster that loses sight
 * of you walks to the tile it last saw you on and keeps hunting for
 * `PURSUIT_TURNS` — TEN — before it forgets. That number could never happen.
 *
 * Engagement is level-wide and refreshes only on `anyContact`, which requires a
 * monster to SEE a player. A monster hunting a remembered tile sees nobody by
 * definition, so the moment the last one loses sight the countdown starts, and
 * three turns later `actMonster`'s `engagement <= 0` freezes the whole floor —
 * including one mid-stride with seven pursuit turns left. **The hunt was capped
 * at three by a mechanism that has nothing to do with hunting**, and the effect
 * at the table is the thing this exists to stop: break line of sight, count to
 * three, and everything on the level stands still. Every fight was escapable by
 * stepping round a corner and waiting.
 *
 * ═══ IT EXTENDS COMBAT AND CANNOT START IT ═══
 * Same shape as `stillAfflicted` above and for the same reason — it sits behind
 * that branch's `before > 0`. A monster's `lastSeen` is only ever stamped by
 * `decideNpcAction` on a turn it could see somebody, so this cannot fire in a
 * realm that was never in combat; the guard makes that structural rather than
 * incidental, and `assertNoCombatInSharedSpace` is what would notice.
 *
 * ═══ AND IT STILL GOES IDLE, WHICH IS NOT OPTIONAL HERE ═══
 * The fixed point survives because the hunt is BOUNDED and self-clearing:
 * `forget()` nulls `lastSeen` on arriving at the tile, on failing to route to
 * it, and at `PURSUIT_TURNS`. So this clause can hold engagement up for at most
 * ten turns past the last sighting, after which it is false, the ordinary decay
 * runs, and the pump idles. It is a longer leash, not an open one — and note
 * that it deliberately does NOT ask about `targetId`, which a monster can hold
 * while standing in a room it cannot leave.
 */
function stillHunting(actors: readonly EngineActor[]): boolean {
  for (const actor of actors) {
    if (actor.kind !== ActorKind.Monster || !actor.alive) continue;
    if (actor.ai.lastSeen !== null) return true;
  }
  return false;
}

/**
 * Does any monster SEE a player it is hostile to? The engagement clock's only
 * way in (`updateEngagement`).
 *
 * THE SAME SIGHT AS `visibleEnemies`, ASKED OF PLAYERS ONLY: a monster's
 * `fieldOfView` (shared/sight.ts) out to its `aggroRange`. So this is true
 * exactly when some monster's `visibleEnemies` holds a player, and a monster
 * that can see you always arms the clock it will act under. It was a Chebyshev
 * square plus a Bresenham line, in step with `visibleEnemies` then too; the
 * two moved together and a test holds them together.
 *
 * Exported for that test. The pump is its only production caller.
 */
export function anyContact(world: World, actors: readonly EngineActor[]): boolean {
  for (const monster of actors) {
    if (monster.kind !== ActorKind.Monster || !monster.alive) continue;
    // One circle per monster, and none for a monster with no player in its disc.
    let sees: ((to: TileXY) => boolean) | undefined;
    for (const player of actors) {
      if (player.kind !== ActorKind.Player || !player.alive) continue;
      // FACTION, NOT KIND. See the header.
      if (!areEnemies(monster, player)) continue;
      sees ??= fieldOfView(world.level, monster, monster.ai.aggroRange);
      if (sees(player)) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// The AI's view of the world
// ---------------------------------------------------------------------------

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THIS CREATURE'S OWN IDEA OF PASSABLE — `Actor.lua:1489-1497`, the path string.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ```lua
 * function _M:getPathString()
 *   local ps = self.open_door and "return {open_door=true,can_pass={" or "return {can_pass={"
 * ```
 *
 * Upstream does not ask "is this tile passable"; it asks "is this tile passable
 * TO THIS BODY", and bakes the answer into a per-actor path string that the FOV
 * route caches are keyed by (`Map.lua:301-302`, :487). Walk `Grid:block_move`
 * with a route probe's arguments (`act=false, couldpass=true`) and the arms fall
 * out: an actor WITH `open_door` matches none of them and a closed door is
 * passable to it; an actor without matches the third and it is a wall.
 *
 * ═══ WITHOUT THIS, THE MONSTER HALF OF DOORS IS UNREACHABLE CODE ═══
 * `intentForStep` returns `undefined` for an impassable tile, so a shared
 * terrain-only predicate means the AI never PROPOSES a step into a shut door —
 * and `resolveIntent`'s door branch, and `MonsterActor.opensDoors`, and every
 * `open_door = true` on a template, can never fire. MEASURED, and the way it was
 * found is worth recording: deleting the `canOpenDoors` gate from the resolution
 * broke NO test, because nothing had ever walked a monster into a door.
 *
 * ═══ THE COMMON CASE ALLOCATES NOTHING ═══
 * Almost every creature in the bestiary answers false, and those get the SHARED
 * context back unchanged rather than a per-turn copy of it.
 *
 * The A* route predicate inherits this through `ApproachOpts.route`, which
 * defaults to `ctx.isPassable` — so a door-opener will also plan a route through
 * a shut door rather than only blunder into one. That is upstream's behaviour
 * and it is the whole reason the path string exists.
 */
function aiCtxFor(actor: MonsterActor, shared: AiCtx, world: World): AiCtx {
  if (!canOpenDoors(actor)) return shared;
  return {
    ...shared,
    // `canRoute` IS THIS EXPRESSION, and it used to be spelled out here. It is
    // upstream's `couldpass` and the CLIENT's router asks the identical question
    // of the identical function — two spellings of one rule across the wire is
    // how a monster and a player end up disagreeing about which doors are ways
    // through. `shared/level.ts` holds the argument.
    isPassable: (x, y) => canRoute(world.level, x, y),
  };
}

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
    // THE LINE `canAttack` WILL ASK OF THE SAME SHOT (`world.lineClearFor`, as
    // `resolveIntent` hands it the world), so the AI cannot propose a shot the
    // resolution refuses for its line. See `AiCtx.lineClear`. With `from`, the
    // same body asked from that tile: the kite guard's sidestep. A monster's
    // line reads only its kind and its tile, so that is all the stand-in has.
    lineClear: (self, target, from) =>
      world.lineClearFor(
        from === undefined ? self : { id: self.id, kind: self.kind, x: from.x, y: from.y },
        target,
      ),
    // THE SAME SHADOWCAST `visibleEnemies` ASKS, from another tile — the kite
    // guard's sidestep must not step out of sight (`AiCtx.seesFrom`).
    seesFrom: (self, target, from) => fieldOfView(world.level, from, self.ai.aggroRange)(target),
    // RESOLVED AT THE MOMENT OF ASKING, like `anchorAt` below: a body that took
    // the stair earlier in this pump is off the level, which is upstream's
    // `hasEntity` test (see `AiCtx.actorById`).
    actorById: (id) => world.getActor(id),
    rng: world.rng,
    // THE GROUND, BY CODE, READ AT THE MOMENT OF ASKING — so a bubble spent or a
    // door opened earlier in this pump is the tile it is now. The per-body half
    // (who drowns, who burns) is `shared/terrain.ts`, asked in ai/npc.ts with the
    // body in hand, which is what keeps `aiCtxFor`'s common case allocation-free.
    terrainAt: (x, y) => tileAt(world.level, x, y),
    // AND WHAT THE GROUND WOULD DO TO IT: the floor's own resolved lava roll, after
    // this body's resistance and affinity (ActorAI.lua:681-686). `faction` is not
    // read — no grid here has one — and `invulnerable` is not ported.
    gridDamage: (self, x, y) => {
      const code = tileAt(world.level, x, y);
      const burn = burnOf(code);
      const range = burn === undefined ? undefined : world.burnRange(code);
      if (burn === undefined || range === undefined) return 0;
      const profile = self.combat?.profile ?? {};
      const kept =
        100 - combatGetResist(profile, burn.type) - combatGetAffinity(profile, burn.type);
      return (((range.max + range.min) / 2) * kept) / 100;
    },
    // FORWARDED WITHOUT A DEFAULT. `castable` is optional on both sides, so a
    // resolution that cannot answer and a build with no resolution at all
    // produce the identical empty list rather than two different silences.
    ...(talents?.castable === undefined
      ? {}
      : { castable: (self, target) => talents.castable?.(self, target) ?? [] }),
    /**
     * ═══ WHERE A COMPANION'S PERSON IS STANDING — see `AiCtx.anchorAt` ═══
     *
     * RESOLVED AT THE MOMENT OF ASKING, like `terrainAt` and `actorAt` above,
     * so a person who crossed a stair earlier in this pump is gone rather than
     * a stale pair of numbers the companion is still walking toward.
     *
     * THREE REFUSALS AND EACH IS A REAL STATE: no anchor (every body in the
     * game but a companion), an anchor who is not in this world any more, and
     * an anchor who is not a LIVE PLAYER. The last covers a downed person —
     * `alive` is false while a body is on the floor — and the answer it
     * produces is the right one: the companion keeps fighting over them
     * instead of walking back to a body that is not going anywhere.
     */
    anchorAt: (self) => {
      const id = self.anchorId;
      if (id === undefined) return undefined;
      const body = world.getActor(id);
      if (body === undefined || body.kind !== ActorKind.Player || !body.alive) return undefined;
      return { x: body.x, y: body.y };
    },
  };
}

/**
 * Hostiles a monster can see, NEAREST FIRST with ties broken by id.
 *
 * ═══ SEEN IS ToME's FIELD OF VIEW — `tome/class/NPC.lua:99-105` ═══
 * A monster sees the bodies on the cells its field of view reaches from its
 * tile with `block_sight` as the wall. `doFOV` passes `cache = true`, so that
 * is `core.fov.calc_default_fov` (`engine/interface/ActorFOV.lua:65-94`), the
 * same `fov_circle` geometry as `core.fov.calc_circle` over the map's
 * `block_sight` cache (the note on `fieldOfView`). Ours is `fieldOfView`
 * (shared/sight.ts), out to its `aggroRange`, which is this game's
 * `self.sight` (the note on `MonsterTemplate.aggroRange`). It WAS a Chebyshev
 * square of `aggroRange` plus one Bresenham line from centre to centre (the M2
 * stand-in this note promised would become a shadowcast). Nothing else about
 * seeing changed:
 * `alive` and `isHostile` are the whole of the rest, as they were.
 *
 * ═══ NEAREST IS `tileDistance`, ToME's KEY ═══
 * `engine/interface/ActorFOV.lua:86` sorts `fov.actors_dist` on `__sqdist`,
 * and the C stores there the ROUNDED distance squared (`map_default_seen` in
 * src/fov.c, git only): `core.fov.distance`, which is `tileDistance`. So
 * bodies at (4,0) and (3,3) are equally near, both 4. The key was Chebyshev,
 * which put (3,3) first.
 *
 * The id tie-break is ours and it is not cosmetic: two players equidistant from
 * a monster is the commonest possible board state, and without a total order
 * the target would depend on iteration order and a replay could diverge into a
 * different fight. Rounding makes ties commoner, not rarer.
 *
 * Exported for the lockstep test with `anyContact`. The AI context is its only
 * production caller.
 */
export function visibleEnemies(
  self: MonsterActor,
  world: World,
  actors: readonly EngineActor[],
): readonly EngineActor[] {
  const seen: { readonly actor: EngineActor; readonly distance: number }[] = [];
  const sees = fieldOfView(world.level, self, self.ai.aggroRange);

  for (const other of actors) {
    if (!other.alive || !isHostile(self, other)) continue;
    if (!sees(other)) continue;
    seen.push({ actor: other, distance: tileDistance(self, other) });
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
