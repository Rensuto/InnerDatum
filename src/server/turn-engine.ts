/**
 * The adapter between the pure turn engine and the socket layer.
 *
 * WHY THIS FILE IS NOT UNDER src/server/engine/
 *
 * The engine is deliberately clock-free: ESLint bans `Date.now` there, and
 * `setTimeout` is not in scope. `barrier.expire(actors, level, nowMs)` and
 * `pump(world, { nowMs })` both take wall-clock as an argument precisely so the
 * engine stays a pure state transition that a test can drive turn by turn.
 *
 * But the gateway's `TurnEngine` contract is clock-free in the OTHER direction:
 * `bellExpired()` and `pump()` take no arguments, because the socket layer fires
 * them from a real timer and should not have to thread time through.
 *
 * Something has to own the clock and close that gap. Putting it inside engine/
 * would mean weakening the lint rule that keeps the engine deterministic — the
 * single most valuable structural guarantee in the codebase. So the adapter
 * lives one directory up, outside the engine glob, and `now()` is injected so
 * tests can drive it without a real clock either.
 *
 * It also owns the Barrier instance, because the barrier's state (Standing By
 * counters, the countdown's start time) must outlive any single pump.
 */

import { inBounds, step } from '../shared/coords.ts';
import { bound } from '../shared/scale.ts';
import {
  HEAL_FACTOR_MAX,
  HEAL_FACTOR_MIN,
  healingFactor,
  sightRadiusOf,
} from './engine/derived.ts';
import { REST_MAX_TURNS, RestStop, restBonus, restCheck } from '../shared/rest.ts';
import type { RestResult, RestView } from '../shared/rest.ts';
import {
  ActorKind,
  ErasedReason,
  ErrorCode,
  PartyAction,
  TalentShape,
} from '../shared/protocol.ts';
import type { Dir, TileXY } from '../shared/coords.ts';
import type { LoadoutTalent, ResourceView, TurnEvent, UnlockableTree } from '../shared/protocol.ts';
import type { DamageType } from '../shared/damagetype.ts';
import { seedTestEncounter } from './content/encounter.ts';
import { SLOT_ORDER } from './content/items.ts';
import { isMoneyId } from './content/money.ts';
import { resolveItem } from './content/resolve.ts';
import { HOLD_INTENT, IntentKind, cooldownOf, isHostile, isPlayer } from './engine/actor.ts';
import type { Intent } from './engine/actor.ts';
import type { Barrier, BarrierLevel, PartyScope } from './engine/barrier.ts';
import { createBarrier } from './engine/barrier.ts';
import { RespawnRefusal, forgetActor as forgetDowned, isErased, respawn } from './engine/downed.ts';
import type { DownedState } from './engine/downed.ts';
import {
  dispel,
  forgetActor as forgetEffects,
  statusApplier,
  statusPass,
  effectDef,
  effectsOn,
  EffectStatus,
} from './engine/effects.ts';
import type { EffectLogLine, EffectState, StatusHit } from './engine/effects.ts';
import { combatDistance } from './engine/combat.ts';
import {
  MAX_PARTY_SIZE,
  PartyRefusal,
  accept as acceptInvite,
  decline as declineInvite,
  forgetActor as forgetParty,
  invite as inviteToParty,
  invitesFor,
  kick as kickFromParty,
  leave as leaveParty,
  membersOf,
  partyIdOf,
  partyOf,
} from './engine/party.ts';
import type { PartyResult, PartyState } from './engine/party.ts';
import type { GameEvent, SweepStep, TalentResolution } from './engine/scheduler.ts';
import { disconnectActor, pump, reconnectActor, submitIntent } from './engine/scheduler.ts';
import type {
  IntentResult,
  LevelUpNote,
  PartyCommandResult,
  PartySnapshot,
  PumpResult,
  TalentRefusal,
  TalentResult,
  TurnEngine,
} from './net/gateway.ts';
import { toDisplayName } from './view/projector.ts';
import type { TurnState } from './view/projector.ts';
import { hasLineOfSight } from '../shared/sight.ts';
import { canSee, sightDistance } from '../shared/sight.ts';
import { currentTile, orbOnMyLine } from './engine/projectile.ts';
import type { Actor, World } from './world/world.ts';

/**
 * WHAT AN ACTOR CAN DO, as authored content sees it.
 *
 * DECLARED HERE, SATISFIED ELSEWHERE — the same trick `TurnEngine` plays in
 * net/gateway.ts. `src/server/talents/` may not import net/ (eslint blocks it)
 * and this adapter may not be imported by the engine, so stating the contract
 * structurally means the talent files satisfy it without importing anything,
 * this file compiles without importing them, and a test can hand `submitTalent`
 * a two-talent book with no content pipeline behind it.
 *
 * IT IS READ-ONLY, AND THAT IS THE DIVISION OF LABOUR. Everything here answers
 * "may this be submitted?". SPENDING the resource and SETTING the cooldown
 * happen at RESOLUTION, inside the scheduler, because an intent that goes
 * illegal between submission and resolution must cost ZERO — the refund rule
 * (docs/architecture.md § 2). Deducting a Reagent when the packet lands would
 * charge for a cast that a wall, a death or a knockback then cancels.
 */
export type TalentBook = {
  /**
   * This actor's hotbar, in slot order. Empty for anything without one — every
   * monster in M3, and a player before a class has been chosen.
   */
  loadoutOf(actor: Actor): readonly LoadoutTalent[];
  /**
   * This actor's PASSIVES — never on the hotbar, and that is why they are not in
   * `loadoutOf`. See `LoadoutMsg.passives`.
   *
   * OPTIONAL, so every fixture that predates passives still satisfies this port
   * without being edited to return an empty array it does not have.
   */
  passivesOf?(actor: Actor): readonly LoadoutTalent[];
  /**
   * The locked disciplines this actor could buy. Optional for the same reason
   * `passivesOf` is: a fixture that predates them satisfies this port without
   * being edited to return an empty array it does not have.
   */
  unlockableOf?(actor: Actor): readonly UnlockableTree[];
  deepenableOf?(actor: Actor): readonly string[];
  /** This actor's class resource, or undefined for an actor that has none. */
  resourceOf(actor: Actor): ResourceView | undefined;
  /**
   * HOW FAST THAT POOL REFILLS, per game turn. Only `rest` asks.
   *
   * ═══ WHY THIS IS NOT A FIELD ON `ResourceView` ═══
   * `ResourceView` goes over the wire. A bar that is drawing `current/max` has
   * never needed the trickle rate, and adding a field to a protocol type to
   * answer a server-side question would make every client parse a number it
   * does not draw.
   *
   * ═══ AND WHY IT IS NOT DERIVED FROM `discrete` ═══
   * `RESOURCE_RULES` already holds `regenPerTurn` per kind, and Reagents is the
   * kind that regenerates on a counter rather than per turn — so `discrete`
   * happens to correlate with "trickle is zero" TODAY. Restating a constant
   * that lives somewhere else is the failure this codebase keeps finding: the
   * copy stays right until the original moves, and then nothing says so.
   *
   * Optional for the reason `passivesOf` is — a fixture predating rest still
   * satisfies the type. Absent reads as zero, which makes `restCheck` treat the
   * pool as one that cannot fill, which is the safe end: a rest that stops early
   * rather than one that never stops.
   */
  poolRegenOf?(actor: Actor): number;
  /**
   * Add to that pool, clamped to its ceiling. Returns what actually landed.
   *
   * THE ONLY WRITE ON THIS INTERFACE, and it exists for one caller: a rest pays
   * the accelerated trickle to every party member (`Player.lua:983-993` pays
   * `incStamina`/`incMana`/`incPsi` beside the heal). Everything else here
   * READS, because the talent engine owns spending.
   */
  gainPool?(actor: Actor, amount: number): number;
  /**
   * THE AUTHORITATIVE LEGALITY CHECK, when one exists. Null means legal.
   *
   * OPTIONAL, AND THE REASON IS WORTH THE PARAGRAPH. `canUseTalent` in
   * src/server/engine/talents.ts is the function the SCHEDULER calls at
   * resolution, and it knows things this adapter cannot see: the AP and MP
   * budgets, whether the body under the cursor is hostile, whether a Fog Step
   * destination is occupied. When it is wired through here, `submitTalent`
   * defers to it completely and there is exactly ONE implementation of
   * "may this be used" in the process — which is the only way submission and
   * resolution can be guaranteed to agree.
   *
   * When it is NOT supplied, `submitTalent` falls back to the subset it can
   * decide from the catalogue alone: membership, cooldown, class resource,
   * range, the dead zone and line of sight. That fallback calls the SAME
   * `combatDistance` and `hasLineOfSight` the resolution-time checker calls, so
   * the two can differ in what they check but never in how they measure.
   */
  check?(actor: Actor, talentId: string, target: TileXY | undefined): TalentRefusal | null;
};

/**
 * The book a server with no talents wired in uses.
 *
 * Not a placeholder to be deleted: it is what makes `createTurnEngine({ world })`
 * keep working unchanged, and it fails CLOSED — every talent id is unknown, so
 * every `talent` frame is refused. A default that accepted everything would be a
 * validation bypass that only shows up in production.
 */
export const EMPTY_TALENT_BOOK: TalentBook = {
  loadoutOf: () => [],
  resourceOf: () => undefined,
};

/**
 * Structurally Fastify's `app.log`, exactly as persist/saves.ts's `SaveLogger`
 * is, so main.ts hands over its own logger and a floor reset lands in the same
 * stream as every request line.
 *
 * OPTIONAL HERE, unlike the save store's, and the difference is what each one
 * guards. A save that silently discarded its warning would hide a lost
 * character; a floor reset that cannot find a spawn tile is a worse POSITION,
 * not a lost anything, and `createTurnEngine({ world })` has to keep working for
 * the dozens of tests that describe the turn loop and have no logger to give it.
 */
export type TurnLogger = {
  info: (context: Record<string, unknown>, message: string) => void;
  warn: (context: Record<string, unknown>, message: string) => void;
  error: (context: Record<string, unknown>, message: string) => void;
};

const SILENT_LOGGER: TurnLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/**
 * How close together two of the SAME party's wipes have to be before it is
 * churn rather than a hard floor — in GAME TURNS.
 *
 * TURNS, NOT PUMPS, and the unit is the whole point. A pump is not a thing
 * anybody can reason about: the gateway drives one after every accepted frame,
 * so a chat message between two wipes would break a "consecutive pumps" counter
 * and hide the exact loop it exists to catch. A floor reset that worked buys the
 * party a walk back across the room; wiping again inside two game turns means
 * they never left the fight.
 */
const WIPE_CHURN_TURNS = 2;

/**
 * THE TALENT RUNTIME, from this layer's side.
 *
 * `TalentResolution` is the three callbacks the SCHEDULER needs (resolve a cast,
 * refill the budget on the base clock, note a move). `forget` is the fourth, and
 * it belongs to this file rather than to the scheduler because the two callers
 * are both here: a player genuinely leaving (`leave`) and a reaped monster
 * (`reap`). engine/talents.ts's own note — *"`forget()` is called from the one
 * place actors are removed"* — is the contract this satisfies.
 */
export type TalentRuntime = TalentResolution & {
  /** Drop this actor's sheet and every talent effect keyed to it. */
  forget(actorId: string): void;
};

export type TurnEngineOptions = {
  readonly world: World;
  /**
   * Injected so a test can step time deliberately instead of sleeping. Defaults
   * to the real clock; this is the ONLY place in the turn path that reads one.
   */
  readonly now?: () => number;
  /** Shared with the gateway so both agree on what "still connected" means. */
  readonly barrier?: Barrier;
  /** Authored talents. Defaults to `EMPTY_TALENT_BOOK`, which refuses everything. */
  readonly talents?: TalentBook;
  /**
   * THE SURVIVAL TABLE (engine/downed.ts). Who is on the floor, and for how many
   * more turns.
   *
   * OPTIONAL, AND ABSENT MEANS NOBODY IS EVER DOWN. It lives ACROSS pumps, like
   * the barrier, because a five-turn countdown that reset every time the world
   * advanced would never reach zero — so it is owned here and handed to `pump`
   * rather than built inside it.
   *
   * Every survival branch in the scheduler is gated on it being supplied, which
   * is what keeps a server with no `downed` wired in byte-for-byte the M3 game:
   * a player who hits 0 hp is a corpse, exactly as before. That is a deliberate
   * fail-closed default — the alternative, inventing a timer nobody is counting,
   * would put "4 turns left" on a panel above a body that will never get up.
   *
   * The same instance must reach the gateway (for `projectParty`), which is why
   * src/server/main.ts creates it and passes it to both.
   */
  readonly downed?: DownedState;
  /**
   * WHO IS PLAYING WITH WHOM (engine/party.ts).
   *
   * PRESENT → THE BARRIER IS PER-PARTY. Every question the barrier answers —
   * the quorum, the commit count, the blocking set, the Bell's countdown and
   * the wipe — is scoped to the asking player's party rather than to the level,
   * which is the whole point: a solo player must never wait on somebody they
   * never agreed to play with. Engagement is untouched and stays level-wide.
   *
   * ABSENT → the level-wide barrier, byte for byte, exactly as it behaved
   * before parties existed. Optional for the same reason `downed` is: a test
   * that builds `createTurnEngine({ world })` describes the same game it always
   * did, and the party verbs answer honestly that this build has no party
   * system rather than pretending.
   *
   * Owned by src/server/main.ts and handed to BOTH this and the gateway, like
   * the survival table — two instances would be two answers to "who is in my
   * party", one of them driving the barrier and the other drawing the pane.
   */
  readonly parties?: PartyState;
  /**
   * Where a floor reset's diagnostics go. Defaults to silence.
   *
   * There are exactly two lines and both are things a player would otherwise
   * report as "the game broke": a level with no free spawn tile, and a party
   * that wipes again within `WIPE_CHURN_TURNS` of its last wipe. See `resetFloor`.
   */
  readonly log?: TurnLogger;
  /**
   * PUT THE FLOOR'S MONSTERS BACK. Defaults to `seedTestEncounter`.
   *
   * A SEAM RATHER THAN A HARD-WIRED CALL, for the reason M5 is about to make
   * obvious: today "the floor" is three hand-placed monsters in
   * content/encounter.ts, and tomorrow it is whatever the zone generator built.
   * A floor reset has to re-run WHATEVER made this floor, and this is the one
   * line that has to change when that answer does.
   *
   * It must be IDEMPOTENT ON ID and it must place at AUTHORED positions.
   * `resetFloor` removes every monster first, so what this call sees is an empty
   * floor and the party already standing somewhere else.
   */
  readonly reseedFloor?: (world: World) => void;
  /**
   * THE TALENT RUNTIME (see `TalentRuntime` and `TalentResolution`).
   *
   * Present → `IntentKind.Talent` resolves for real inside the pump, the AP/MP
   * budget refills on the base clock, `movedThisTurn` gets its writer, and a
   * body that leaves the world takes its sheet with it.
   *
   * ABSENT → M3 exactly: every talent intent is refused with `no_talent_effect`
   * and nothing else changes. Optional for the same reason `downed` and
   * `parties` are — a test that builds `createTurnEngine({ world })` describes
   * the same game it always did.
   *
   * SEPARATE FROM `talents` ABOVE, and both are needed. `TalentBook` is the
   * READ-ONLY submission gate (what is in your hotbar, may this be sent); this
   * is the RESOLUTION half (what actually happens, what it costs). Splitting
   * them is what makes the refund rule free: nothing is deducted at submission.
   */
  readonly talentRuntime?: TalentRuntime;
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * REBUILD THIS BODY'S SHEET FROM BASE — an effect that grants stats moved.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Forwarded to `EffectCtx.sheetDirty`, which carries the whole argument.
   * Passed in for exactly the reason `onActBase` beside it is: the rebuild is
   * `refreshPassives`, which lives inside the server closure in main.ts because
   * it is the one place that can see the item catalogue, the talent registry and
   * the world at once. This adapter cannot reach it, so the capability arrives
   * as an argument rather than as an import.
   *
   * OPTIONAL: absent means a buff's grant lands on the next base turn instead of
   * immediately, which every fixture that builds an engine by hand is content
   * with and no player would be.
   */
  readonly onSheetDirty?: (actorId: string) => void;
  /**
   * THE STATUS TABLE (engine/effects.ts). Who is bleeding, stunned, slowed.
   *
   * Read here for ONE purpose: `reap` has to clear it, and it is the first entry
   * on the cleanup contract. A server with no status system wired in passes
   * nothing and the reap simply has one fewer table to empty.
   */
  readonly effects?: EffectState;
};

const OK: IntentResult = { ok: true };

function refuse(reason: string): IntentResult {
  return { ok: false, reason };
}

/**
 * A refused party command. SEPARATE FROM `refuse` ABOVE and not an alias for
 * it: the two results are only the same shape on the failure arm, and letting
 * one function serve both would mean the compiler could no longer tell a
 * successful party command — which must carry `affected` and a notice — from a
 * successful move, which carries neither.
 */
function refuseParty(reason: string): PartyCommandResult {
  return { ok: false, reason };
}

const TALENT_OK: TalentResult = { ok: true };

/**
 * The intent, built from the CATALOGUE'S copy of the id and never the caller's
 * string. The two are equal — the loadout lookup proved it — but this way the
 * intent carries a key the server minted rather than 64 attacker-supplied
 * characters, so nothing downstream is ever handed one it did not mint itself.
 *
 * A `self` shape queues no target at all rather than the caster's own tile: an
 * absent target is a fact about the talent, whereas a coordinate would have to
 * be re-checked at resolution against a caster who may since have been shoved.
 */
function talentIntent(talent: LoadoutTalent, target: TileXY | undefined): Intent {
  if (target === undefined) return { kind: IntentKind.Talent, talentId: talent.id };
  return { kind: IntentKind.Talent, talentId: talent.id, target: { x: target.x, y: target.y } };
}

/**
 * `code` is what the CLIENT branches on; `reason` is for the player and the log.
 * Both are needed and neither substitutes for the other — a client cannot flash
 * the ring's hole for a sentence, and a player cannot act on `too_close` alone.
 */
/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT TO SAY WHEN THE AUTHORITATIVE CHECKER REFUSES.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The checker answers a CODE and nothing else, and the code used to be printed
 * at the player — see the call site. The client rewrites most categories itself
 * (`refusalText`), so these matter most for the arms where it defers; they are
 * all written as the sentence a player would want either way.
 *
 * `bad_message` IS THE ONE THAT HAD TO CHANGE and the one this exists for: at
 * that call site it can only mean "you have not raised this yet", because the
 * loadout-membership check has already refused anything the body does not have.
 */
function refusalSentence(name: string, code: TalentRefusal): string {
  switch (code) {
    case ErrorCode.BadMessage:
      return `${name}: you have not learned that yet`;
    case ErrorCode.OnCooldown:
      return `${name} is still cooling down`;
    case ErrorCode.NoResource:
      return `${name}: not enough to pay for it`;
    case ErrorCode.OutOfRange:
      return `${name}: too far away`;
    case ErrorCode.TooClose:
      return `${name}: too close`;
    case ErrorCode.NoLos:
      return `${name}: no line of sight to that tile`;
    case ErrorCode.NotYourTurn:
      return `${name}: not now`;
    case ErrorCode.IllegalMove:
      // "NOT AT THAT" IS WHAT EVERY TARGETING REFUSAL MEANS — blocked terrain,
      // an empty tile, yourself, an ally under a hostile talent. See
      // `REFUSAL_TO_CODE`, which collapses five of them onto this code for the
      // reason a targeting UI can act on: ask for another tile.
      return `${name}: not at that`;
  }
}

function refuseTalent(code: TalentRefusal, reason: string): TalentResult {
  return { ok: false, code, reason };
}

/**
 * One `RespawnRefusal`, in the sentence the player reads.
 *
 * PROSE ONLY. The RULE is `respawn`'s in engine/downed.ts and this function does
 * not re-decide any of it — it is the same division `submitRevive` keeps with
 * `ReviveRefusal`, and it exists because the engine's vocabulary is a tag and
 * the player's is a sentence. `Downed` gets the longest one on purpose: a player
 * on the floor pressing this key needs to be told that somebody can still reach
 * them, or they will read the refusal as the game being broken.
 */
/**
 * One `PartyRefusal`, in the sentence the player reads.
 *
 * PROSE ONLY, exactly as `respawnRefusalText` below is. The RULES are
 * engine/party.ts's and this function re-decides none of them; it exists
 * because the engine's vocabulary is a tag and a player's is a sentence, and
 * because "party is full" needs to name the number to be actionable.
 */
function partyRefusalText(reason: PartyRefusal, action: PartyAction): string {
  switch (reason) {
    case PartyRefusal.Self:
      return action === PartyAction.Kick
        ? 'to leave your own party, use leave'
        : 'you cannot invite yourself';
    case PartyRefusal.AlreadyTogether:
      return 'you are already in the same party';
    case PartyRefusal.AlreadyInvited:
      return 'you have already invited them — the offer is still standing';
    case PartyRefusal.PartyFull:
      return `that party is full (${String(MAX_PARTY_SIZE)})`;
    case PartyRefusal.NoInvite:
      return 'there is no invitation waiting for you';
    case PartyRefusal.NotLeader:
      return 'only the party leader can remove somebody';
    case PartyRefusal.NotAMember:
      return 'they are not in your party';
    case PartyRefusal.Solo:
      return 'you are already on your own';
  }
}

/**
 * ONE CASE LOG LINE for a party command that succeeded.
 *
 * IT GOES IN THE RECORD LANE, not the Margin, and the distinction is the one
 * protocol.ts draws: the Margin is what PEOPLE said, the Record is what the
 * RULES did — and a party change is a rule change. It is the reason the barrier
 * a player is standing at just moved, and six turns later "why did I stop
 * waiting for Ren?" has to be answerable by scrolling back.
 *
 * NAMES, NOT IDS, and they go through the same display-name filter every other
 * projection uses — a party notice is drawn from a Discord nickname and is read
 * by everybody at the table.
 */
function partyNotice(action: PartyAction, actor: Actor, target: Actor | undefined): string {
  const who = toDisplayName(actor.name);
  const them = target === undefined ? 'them' : toDisplayName(target.name);
  switch (action) {
    case PartyAction.Invite:
      return `${who} invites ${them} to their party.`;
    case PartyAction.Accept:
      return `${who} joins the party.`;
    case PartyAction.Decline:
      return `${who} declines the invitation.`;
    case PartyAction.Leave:
      return `${who} leaves the party.`;
    case PartyAction.Kick:
      return `${who} removes ${them} from the party.`;
  }
}

function respawnRefusalText(reason: RespawnRefusal): string {
  switch (reason) {
    case RespawnRefusal.Up:
      return 'you are already on your feet';
    case RespawnRefusal.Downed:
      return 'you are down, not erased — an ally can still reach you';
    case RespawnRefusal.NotAPlayer:
      return 'no_actor';
  }
}

/** The Bell's inputs, read fresh each time — engagement changes every turn. */
function levelOf(world: World): BarrierLevel {
  return { engagement: world.turn.engagement, bossFloor: world.turn.bossFloor };
}

function playersOf(world: World): Actor[] {
  return world.allActors().filter((a) => a.kind === 'player');
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE OTHER HALF OF A FLOOR RESET — EVERYTHING THE ENGINE IS NOT ALLOWED TO DO
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `resetFloorParty` (engine/downed.ts) puts every body back on its feet at full
 * hp with both clocks re-zeroed, AND IT DOES NOT MOVE ANYTHING — it may not, for
 * the reason its own header gives: nothing in engine/ knows where a spawn tile
 * is, and nothing in engine/ may re-seed content. Its checklist ends with *"the
 * `party_wipe` event is the seam"*, and this function is what was on the far
 * side of that seam and had never been written.
 *
 * WHAT THAT COST, VERBATIM FROM A LIVE SESSION'S CASE LOG:
 *
 *     Ren is erased — the party is down. The floor resets.
 *     Index Wraith hits Ren.  3 damage.
 *     Ren is DOWN — 5 turns to reach them.
 *
 * The floor "reset" and left Ren standing at full health one tile from the
 * wraith that had just killed them, still in combat, still engaged. The wraith
 * swung again, Ren went down again, the party wiped again. Two players spent an
 * evening in that loop, and the operator's report — *"downing doesn't fully
 * down, it seems to revive me"* — is exactly what an infinite reset looks like
 * from inside the game.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE ORDER IS THE FIX. NOTHING HOSTILE MAY ACT BETWEEN THE RESTORATION AND
 * THE RELOCATION.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * This runs the instant `pump` returns and BEFORE any of the work that follows
 * a pump: before the events are translated, before a single frame is broadcast,
 * before the state resync, before the save. Turn resolution is synchronous — no
 * `await` exists anywhere in this call graph — so "the instant it returns" is
 * literal: no other socket's frame, no Bell timer and no other party's command
 * can interleave. That is the whole reason this function is called where it is
 * rather than from the gateway, which is the layer that would look natural.
 *
 * The three steps are ordered too, and each order is load-bearing:
 *
 *   1. MOVE THE PARTY FIRST. `world.placeAtSpawn` is the world's own free-tile
 *      search — the same one `submitRespawn` uses for one body — so there is
 *      exactly one rule in the process for "where does a body come back", and it
 *      already guarantees the tile holds no living body. Moving first also frees
 *      the tiles the fight was standing on, so step 2 finds the authored monster
 *      positions empty instead of shuffling every spawn one ring outward.
 *
 *   2. THEN RESET THE HOSTILES — every monster removed, then the floor re-seeded
 *      at its AUTHORED positions. Not "heal the survivors": a reset that leaves a
 *      wounded wraith three tiles from the spawn cluster is the same bug with
 *      extra steps, and the authored encounter is deliberately placed far from
 *      the spawn corner (content/encounter.ts), which is what makes step 1's
 *      tile safe rather than merely unoccupied.
 *
 *   3. THEN DROP ENGAGEMENT TO ZERO. The fight is over. Landing straight back
 *      into a parked barrier is what made this read as "downing doesn't fully
 *      down" — the party got up, the Bell was still ringing at them, and the
 *      next monster turn arrived before anybody had moved. At zero, nobody
 *      blocks, the pump idles, and the party gets the moment to breathe that a
 *      floor reset is supposed to be. It re-arms on its own the moment a hostile
 *      has line of sight again — `updateEngagement` recomputes it every turn, so
 *      this is a reset and not an override.
 *
 * ═══ THE PATHOLOGICAL CASE IS ANSWERED, NOT LOOPED OVER ═══
 * A level with no free tile at all takes more than 761 players, and the answer
 * is a warning and a body left where it fell — never a retry loop. A hang is
 * worse than an unfair position: an unfair position is one bad turn, a hang is
 * a server that stops answering with four people in a voice channel.
 */
function resetFloor(
  world: World,
  restored: readonly string[],
  reseedFloor: (world: World) => void,
  log: TurnLogger,
  reap: (actorId: string) => boolean,
  /**
   * THE STATUS TABLE, so a restored body is restored. Optional, like every other
   * seam in this file: absent is the behaviour before the status system existed.
   */
  effects: EffectState | undefined,
): void {
  // 1 — the party, out of the fight.
  for (const id of restored) {
    if (world.placeAtSpawn(id) !== undefined) continue;
    log.warn({ actorId: id }, 'floor reset: no free spawn tile — the body stays where it fell');
  }

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * ...AND OFF THEM. A RESET MEANS THE FIGHT DID NOT HAPPEN.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * That is this function's own stated principle, and every other clause obeys
   * it: hit points go back to full, the hostiles return to their authored tiles,
   * the loot on the floor is swept, the orbs in the air are cleared, and `reap`
   * empties all five talent side-tables so a re-seeded husk is not still Marked.
   *
   * STATUSES WERE THE ONE THING LEFT ON THE BODY. So a party that wiped while
   * bleeding — which is the ordinary way to wipe now that the Overwritten Husk's
   * claw exists — was stood back up at full health in the spawn cluster with the
   * Bleeding badge still lit and three damage a turn still arriving from a fight
   * the game had just declared did not happen. `dispel` existed and had no
   * production caller.
   *
   * ═══ EVERYTHING, NOT JUST THE HARMFUL HALF ═══
   * The filter is `() => true` rather than "detrimental only", and that is the
   * same rule the rest of the reset follows. A wipe is not a cure: it is an
   * UNDO. Keeping a beneficial effect through it would hand a party a buff they
   * paid for in a fight that no longer exists, and the asymmetry would be worth
   * farming the moment anybody noticed.
   *
   * `world.rng` because `dispel` may draw — an effect's `onRemove` is allowed
   * to, and taking the draw off the world's own labelled stream is what keeps a
   * seeded replay a replay.
   */
  if (effects !== undefined) {
    for (const id of restored) {
      const body = world.getActor(id);
      if (body === undefined) continue;
      dispel(effects, body, () => true, world.rng);
    }
  }

  // 2 — the hostiles, back at their authored positions.
  //
  // ═══ THROUGH `reap`, NOT `world.removeActor` DIRECTLY, AND IT MATTERS ═══
  // content/encounter.ts:99 re-seeds with STABLE IDS, so the husk that stands up
  // after a reset carries the same key every side table used. Delete it from the
  // world alone and the new body inherits the old one's talent effects — a
  // re-seeded monster that is still Marked, still Taunted, still counting down a
  // Guard it never received. `reap` is the one function that empties all five
  // tables in the one correct order.
  for (const actor of world.allActors()) {
    if (actor.kind === 'monster') reap(actor.id);
  }
  // ...AND EVERYTHING STILL IN THE AIR, BEFORE THE FLOOR IS RE-SEEDED.
  // An orb outlives the body that fired it by design (engine/projectile.ts: the
  // shooter may be a corpse), so removing the monsters does not remove their
  // shots. One that survived this wipe would land two turns later on a party
  // standing at the SPAWN CLUSTER at full health — which re-creates, exactly,
  // the loop this function's own header records: down, reset, hit, down again.
  // The projectile table is the third table `resetFloor` has to know about, and
  // the reason it is cleared HERE rather than in the engine is the same reason
  // step 2 exists at all: engine/ may not re-seed content.
  for (const proj of world.projectilesInFlight()) world.removeProjectile(proj.id);
  // ...AND EVERYTHING LYING ON THE FLOOR. THE FOURTH TABLE, AND THE PREVIOUS
  // THREE EACH COST A LIVE SESSION FIRST.
  //
  // Bodies, side tables, orbs and now items: every one of them was added to this
  // function only after a party found the hole in a voice channel. This one is
  // written down before it can be: a wipe re-seeds the encounter at its authored
  // positions and hands the party a fresh fight, so LEAVING THE LOOT FROM THE
  // FIGHT YOU JUST LOST IS A FREE CONSOLATION PRIZE FOR WIPING — and one the
  // party can farm, because the reset costs them nothing but time
  // (game-design.md § 9: no permadeath, no loss). Wiped with the floor, for the
  // same stated reason the orbs directly above are: a reset means the fight did
  // not happen.
  //
  // The drops are NOT lost, they are re-rolled: `reseedFloor` mints three new
  // bodies that each take their own spawn-time roll (content/encounter.ts). The
  // floor is worth the same as it was, and it is worth it again only by fighting.
  for (const item of world.groundItems()) world.removeGroundItem(item.id);
  reseedFloor(world);

  // 3 — out of combat.
  world.turn.engagement = 0;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT A CORPSE LEAVES BEHIND, IN THE ORDER IT LEAVES IT.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The one implementation of `LootResolution.spillOrder` (engine/scheduler.ts).
 * It lives HERE, in the adapter, for the reason every other seam in that file
 * lives here: the engine may not import `src/server/content/**`, and both halves
 * of the answer — `SLOT_ORDER` and the catalogue — are content.
 *
 * ═══ WORN FIRST, IN SLOT ORDER; THEN CARRIED, IN CARRY ORDER ═══
 * Ported from `Actor:die`, modules/tome/class/Actor.lua:3036-3040:
 *
 * ```lua
 * local invens = {}
 * for inven_id, inven in pairs(self.inven) do invens[#invens+1] = inven end
 * table.sort(invens, function(a,b) if a.id == 1 then return false ... end)  -- :3038
 * for _, inven in ipairs(invens) do
 *     for i = #inven, 1, -1 do                                              -- :3040
 * ```
 *
 * Upstream sorts the inventories and pushes `INVEN` (id 1 — the backpack) to the
 * END, so worn gear hits the floor before loose items. Ours does the same thing
 * with `SLOT_ORDER` and then `carried`. The reverse walk at :3040 is NOT ported
 * and does not need to be: it is an artifact of Lua's `table.remove` shifting
 * indices under an in-place loop, and we build a new array instead.
 *
 * THE POINT IS NOT ELEGANCE, IT IS THAT THE ORDER EXISTS AT ALL. `equipped` is a
 * plain object and `Object.keys` would hand back whatever order a player happened
 * to press buttons in — which differs between two replays of one seed. Since
 * `World.itemsAt` hands the pile back in insertion order and a pickup takes index
 * 0, a different spill order is literally a different item picked up, and the bug
 * report reads "the wrong thing got taken".
 *
 * ═══ TWO FILTERS, BOTH DELIBERATE ═══
 *   AN ID THE CATALOGUE DOES NOT KNOW IS DROPPED, not spilled. It would reach the
 *     floor, ride the ground frame to every client, and render as the LOUD violet
 *     fallback box — the one failure this project's asset rules exist to make
 *     impossible. A build that deleted an item is the realistic way to get here.
 *   A DUPLICATE IS SPILLED ONCE. `carried` is a SET, not a bag
 *     (persist/saves.ts's `parseCarried` keeps the first occurrence and drops the
 *     rest), and `equipped` wins over `carried` for the same id on load. Honouring
 *     that here means a body cannot leave two of a thing it could only ever have
 *     owned one of.
 */
function spillOrderOf(actor: Actor): readonly string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  const take = (id: string | undefined): void => {
    if (id === undefined || seen.has(id)) return;
    // The catalogue is the only thing that can tell a live id from a stale one.
    // MONEY IS THE ONE ID IT CANNOT ANSWER FOR — a coin pile is not an `Item`
    // and deliberately has no `slot` (content/money.ts says why). Without this
    // clause a corpse carrying gold would spill nothing, and the failure would
    // read as "the drop table stopped working" rather than as a missing case.
    if (!isMoneyId(id) && resolveItem(id) === undefined) return;
    seen.add(id);
    out.push(id);
  };

  // SLOT_ORDER, never `Object.keys(worn)`. See the header.
  const worn = actor.equipped;
  if (worn !== undefined) {
    for (const slot of SLOT_ORDER) take(worn[slot]);
  }
  // ...then the backpack, in the order things went into it — which is upstream's
  // `INVEN`-last rule and, for a monster, is just its one pre-rolled drop.
  for (const id of actor.carried ?? []) take(id);

  return out;
}

/**
 * Engine events -> wire events.
 *
 * The engine and the wire deliberately do NOT share an event type. The engine's
 * vocabulary is about bookkeeping (`refunded`, `auto_passed`, `engagement`) and
 * most of it is nobody's business on the client; the wire's is about what to
 * draw. Translating here is what stops internal bookkeeping leaking into the
 * protocol every time the scheduler grows a new event.
 *
 * Anything with no visual meaning maps to nothing and is dropped on purpose.
 */
function toWireEvents(
  world: World,
  events: readonly GameEvent[],
  where: 'player' | 'sweep',
): TurnEvent[] {
  const out: TurnEvent[] = [];
  for (const ev of events) {
    switch (ev.t) {
      case 'moved':
        out.push({
          k: 'move',
          id: ev.id,
          fromX: ev.from.x,
          fromY: ev.from.y,
          x: ev.to.x,
          y: ev.to.y,
        });
        break;
      case 'attacked':
        out.push(
          ...hitToWire(world, ev.id, ev.targetId, ev.hit, ev.damage, ev.killed, ev.hp, ev.at, {
            healed: ev.healed,
            crit: ev.crit,
            type: ev.type,
            // THE SNAPSHOT, forwarded. Without this line the field exists and
            // every caller declines to use it — which is how it was lost.
            maxHp: ev.maxHp,
          }),
        );
        break;
      /**
       * THE TALENT STAMP. One frame; the victims arrive as their own `attacked`
       * events immediately after this, exactly as a weapon swing's do.
       *
       * The whole receiving half was written and waiting: protocol.ts:1599-1616
       * declares the frame (`TalentEvent`, protocol.ts:1619), the gateway's
       * `case 'talent': return { …t: 'used', ev: event }` fans it out, and the
       * client's `case 'used':` in `applyServerMsg` draws it. This `case` is the
       * producer that was missing.
       *
       * CITED BY SYMBOL. The two line numbers that used to be here — gateway.ts:
       * 996-997 and client/main.ts:3376 — both drifted the moment anything above
       * them grew, and 996-997 landed on a `persist?: PersistPort` doc comment,
       * which reads as "the gateway never forwards a talent" and invites a
       * SECOND fan-out path beside the one that already works.
       */
      case 'talent_used':
        out.push({
          k: 'talent',
          id: ev.id,
          talentId: ev.talentId,
          x: ev.at.x,
          y: ev.at.y,
          shape: ev.shape,
          radius: ev.radius,
          ...(ev.targetId === undefined ? {} : { targetId: ev.targetId }),
          // OMITTED WHEN EMPTY, not sent as `[]`: most talents author none, and
          // an absent key is the shape `TalentEvent.notes` documents.
          ...(ev.notes === undefined || ev.notes.length === 0 ? {} : { notes: ev.notes }),
        });
        break;
      case 'sweep':
        // Only the sweep lane unpacks these; in the player lane a sweep event
        // would mean the monster turn resolved inside a human's action, which
        // is a scheduler bug rather than something to render.
        if (where === 'sweep') out.push(...sweepStepsToWire(world, ev.steps));
        break;
      // M4 — the status system. `EffectLogLine` is the engine's own record of
      // what happened to a body; `statusToWire` decides which of its six kinds
      // has anything to DRAW.
      case 'status':
        out.push(...statusToWire(ev.note));
        break;
      /**
       * ═══════════════════════════════════════════════════════════════════════
       * A BLEED, AS A DAMAGE LINE. THE ONE A DEATH BY BLEEDING NEVER HAD.
       * ═══════════════════════════════════════════════════════════════════════
       *
       * `hitToWire` builds the `damage` frame out of an ACTION OUTCOME, so a
       * blow that nobody struck produced nothing at all: the transcript of a
       * death by bleeding was a single sentence with no number, no hp and no
       * cause. Upstream has no equivalent gap because it logs at the projector
       * — `takeHit`, then `"%d %s"` — for a sword and a wound alike
       * (damage_types.lua:491-501).
       *
       * ═══ WHAT THIS STILL DOES NOT SAY, AND WHY IT IS NOT SAID HERE ═══
       * The line reads "5 damage. Index Husk 0/3." — a number and an hp pair,
       * with the CAUSE missing. Upstream's is "5 physical" and bolds a crit,
       * because it logs at the projector and has the type and the crit in hand.
       * `DamageEvent` carries neither, and neither does `AttackEvent` past
       * `hitToWire`, so a swing's crit is dropped on the identical line — one
       * fault, one fix, and it is a WIRE change: `PROTOCOL_VERSION` must be
       * argued on one stated reason in its own commit (src/shared/version.ts).
       * That commit is the one that names the cause; this one stops the damage
       * being invisible, which is the half that needs no new field.
       *
       * ═══ AND `death` ONLY FOR A MONSTER ═══
       * `hitToWire` pushes `death` for whoever `killed` names, player or not,
       * and the Record lane prints "X is unfiled." for it — which is a monster's
       * permanent death printed over a player who is merely DOWNED with an ally
       * running at them. That is a real fault and it is not this event's to
       * repeat: here the player arm is `survivalPass`, which raises `downed`,
       * and only a monster gets the death line.
       */
      case 'status_damage': {
        out.push({
          k: 'damage',
          id: ev.id,
          amount: ev.amount,
          hp: ev.hp,
          maxHp: ev.maxHp,
          ...(ev.sourceId === null ? {} : { sourceId: ev.sourceId }),
          ...(ev.type === undefined ? {} : { type: ev.type }),
          ...(ev.crit ? { crit: true } : {}),
          // AND A HEAL IS A `damage` FRAME WITH `healed` SET, which is the
          // contract `DamageEvent.healed` already states and the client already
          // renders — the Case Log prints the heal instead of "0 damage" and
          // render/sweep.ts keeps the struck-tile marker off the body. Nothing
          // new on the wire; this mapper simply stopped dropping it.
          ...(ev.healed === undefined || ev.healed <= 0 ? {} : { healed: ev.healed }),
        });
        if (ev.killed && world.getActor(ev.id)?.kind === ActorKind.Monster) {
          out.push({
            k: 'death',
            id: ev.id,
            ...(ev.sourceId === null ? {} : { killerId: ev.sourceId }),
          });
        }
        break;
      }
      // M4 — the survival system (engine/downed.ts, game-design.md § 9).
      case 'downed':
        out.push({
          k: 'downed',
          id: ev.id,
          turns: ev.turnsLeft,
          // ═══ `sourceId` WAS ON THE WIRE ALREADY AND NOTHING FILLED IT ═══
          // `DownedEvent.sourceId` is declared and documented — "who put them
          // there, when there is an actor to blame" — and both bridge sites
          // dropped it, which is the field-by-field mapper losing a field that
          // `test/server/projector.test.ts` was made a compile error for once
          // before. Absent stays absent: a body that bled out has nobody to name.
          ...(ev.byId === undefined ? {} : { sourceId: ev.byId }),
        });
        break;
      case 'revived':
        out.push({
          k: 'revived',
          id: ev.id,
          byId: ev.byId,
          hp: ev.hp,
          // ABSOLUTE, like every other vital on the wire. Read from the world
          // after the fact rather than carried through the engine, exactly as
          // `hitToWire` reads the victim's hp: the maximum does not change
          // during a revive, so there is nothing to snapshot.
          maxHp: world.getActor(ev.id)?.maxHp ?? 0,
        });
        break;
      case 'erased':
        out.push({ k: 'erased', id: ev.id, reason: ErasedReason.Timer });
        break;
      /**
       * A PARTY WIPE, narrated as what it is: everybody was erased, and the
       * floor is about to be refiled.
       *
       * `restored` is the list the engine has ALREADY put back on its feet
       * (`resetFloorParty`), which is why one `erased` per name is the honest
       * account rather than a contradiction — the erasure is what happened, the
       * restoration is the MVP's answer to it (§ 9: no permadeath, no loss, the
       * floor resets and the party restarts it).
       *
       * The gateway follows these with a full `state` resync, because every
       * body's hp and both its clocks have just been rewritten underneath the
       * clients and a delta cannot express that.
       */
      case 'party_wipe':
        for (const id of ev.restored) {
          out.push({ k: 'erased', id, reason: ErasedReason.Wipe });
        }
        break;
      /**
       * ═══════════════════════════════════════════════════════════════════════
       * A CORPSE LEFT SOMETHING ON THE FLOOR — AND IT MAPS TO NOTHING, YET.
       * ═══════════════════════════════════════════════════════════════════════
       *
       * The same argument, verbatim, that `SweepStep.fired` makes below: the
       * floor is carried by a SNAPSHOT frame — complete and absolute, so a client
       * that dropped a patch is corrected by the next frame rather than showing a
       * phantom coat forever. A phantom floor item sends somebody walking across
       * the map to a thing that is not there.
       *
       * THAT FRAME EXISTS NOW, AND THIS PARAGRAPH SAID IT DID NOT. It read
       * *"`PROTOCOL_VERSION` was 9, the wire has no `ground` message and no
       * `pickup` verb... so this event is real, logged, tested and deliberately
       * not drawn"*. All three clauses have since stopped being true — the
       * version is 19, `ground` is a `ViewerMsg` with a per-session memo, and
       * `pickup` is a client verb — so the note was telling the next reader that
       * floor loot is invisible in a game where it is drawn.
       *
       * WHAT STAYS TRUE IS WHY THIS EVENT MAPS TO NOTHING: the floor is carried
       * by that SNAPSHOT rather than by a per-drop delta, for the reason above.
       * `spilled` is the server-side record of the drop; the frame a player sees
       * is the ground snapshot the gateway sends after it.
       *
       * The five below it are the older bookkeeping group: real, logged
       * server-side, and with nothing to draw. `spilled` sits with them at the
       * wire and is the one of the six that a player can now see the RESULT of.
       */
      case 'spilled':
      case 'held':
      case 'refunded':
      case 'auto_passed':
      case 'turn_ended':
      case 'engagement':
        break;
    }
  }
  return out;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE THREE REFUSALS, AS RECORD LINES. Actor.lua:7034-7040, :6951-6978.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Upstream writes two DIFFERENT sentences here and the distinction is real:
 *
 *     saved:          "%s shrugs off %s '%s'!"      (:7036)
 *     scaled to zero: "%s resists %s '%s'!"         (:7039)
 *
 * `statusToWire`'s own note already says they are "genuinely different events".
 * A shrug is the save roll beating the power outright; a resist is the save
 * losing and the duration grinding away to nothing anyway. A player who cannot
 * tell them apart cannot tell whether their save is worth another point.
 *
 * ═══ THE NUMBERS ARE THE POINT, NOT DECORATION ═══
 * `docs/game-design.md` § 11's sample Record is *"Dalt saves (phys 38 vs power
 * 31, 68%)"*, and the whole reason `EffectLogLine` carries `saveChance` and
 * `savedVs` is so this line can print them. Without the odds a save reads as
 * the game being arbitrary; with them it reads as a stat that is working.
 *
 * ═══ WALKS THE SWEEP STEPS TOO ═══
 * A monster's rider is refused INSIDE its turn, so its note is a `status` step
 * in a batched sweep rather than a top-level event — which is most of them, and
 * a version that only read the player lane would miss every save made against
 * a monster's blow.
 *
 * ═══ EXPORTED SO THE RULE CAN BE STATED AS A TEST ═══
 * The same call `engine/pools.ts` and `view/projector.ts#statGainLines` made,
 * for the same reason and after the same lesson: the four docblocks that
 * promised this line all described behaviour nothing could reach, and a rule
 * that cannot be aimed at is a rule that gets to be wrong indefinitely. It is
 * a pure function of its three arguments, so a test needs no pump.
 */
export function saveLines(
  world: World,
  effects: EffectState | undefined,
  events: readonly GameEvent[],
): string[] {
  if (effects === undefined) return [];
  const out: string[] = [];

  const say = (note: EffectLogLine): void => {
    if (note.kind !== 'negated' && note.kind !== 'resisted' && note.kind !== 'immune') return;
    const who = world.getActor(note.actorId)?.name;
    const what = effectDef(effects, note.effectId)?.displayName;
    // A body or an effect that is gone is a content reload under a live game —
    // the same case `projectEffects` skips, and there is nothing honest to say.
    if (who === undefined || what === undefined) return;

    if (note.kind === 'immune') {
      out.push(`${who} is immune to ${what}.`);
      return;
    }
    // THE ODDS, when the roll carried them. `saveChance` is null for a refusal
    // that took no roll at all, and inventing a percentage would be worse than
    // omitting one.
    const odds =
      note.saveChance === null || note.saveChance === undefined
        ? ''
        : ` (${note.savedVs ?? 'save'} ${String(Math.round(note.saveChance))}%)`;
    out.push(
      note.kind === 'negated'
        ? `${who} shrugs off ${what}${odds}.`
        : `${who} resists ${what}${odds}.`,
    );
  };

  for (const event of events) {
    if (event.t === 'status') say(event.note);
    else if (event.t === 'sweep') {
      for (const step of event.steps) if (step.t === 'status') say(step.note);
    }
  }
  return out;
}

/**
 * One `EffectLogLine` -> the events a client can draw, which is not all of them.
 *
 * SIX KINDS IN, TWO OUT, and the four that produce nothing are the interesting
 * half. `negated` (Actor.lua:7034-7037), `resisted` (:7038-7040) and `immune`
 * (:6951-6978) all mean NOTHING LANDED — there is no badge to pop and no
 * duration to time, so an event would be an animation of an absence. They are
 * still real and still recorded: they go into the Case Log's Record lane as
 * words, which is where "Dalt saves (phys 38 vs power 31, 68%)" belongs.
 *
 * `merged` produces an `effect_applied` because that is what it looks like from
 * outside — the badge's number changed. Bleeding's merge conserves total damage
 * rather than stacking it (physical.lua:133-141), and the client is shown the
 * duration that survived, which is the only number the badge draws.
 *
 * `turns` FALLING BACK TO 0 is not a hidden failure: `EffectLogLine.dur` is
 * populated for exactly the two kinds read here, so the `??` is a type-level
 * formality that the engine's own contract already rules out.
 */
function statusToWire(note: EffectLogLine): TurnEvent[] {
  switch (note.kind) {
    case 'gained':
    case 'merged':
      return [
        {
          k: 'effect_applied',
          id: note.actorId,
          effectId: note.effectId,
          turns: note.dur ?? 0,
          // What was ASKED FOR. `turns < maximum` is the partial save, and it is
          // the whole reason both numbers are on the wire — see protocol.ts.
          maximum: note.maximum ?? note.dur ?? 0,
        },
      ];
    case 'lost':
      return [{ k: 'effect_expired', id: note.actorId, effectId: note.effectId }];
    case 'negated':
    case 'resisted':
    case 'immune':
      return [];
  }
}

/**
 * One landed blow, expanded into the three frames the client draws.
 *
 * `hp`/`maxHp` are ABSOLUTE, not deltas. That is the protocol's choice and a
 * good one: a client that dropped a frame is corrected by the next hit rather
 * than drifting forever.
 *
 * ═══ `hp` AND THE TILE ARE THE ENGINE'S SNAPSHOT; ONLY `maxHp` IS READ HERE ═══
 * This function runs AFTER the pump, so anything it reads off a body is that
 * body's state at the END of the call — and a floor reset rewrites every hp AND
 * walks the whole party to the spawn cluster mid-pump. Reading the hp here
 * produced a Case Log that said *"3 damage. Ren 60/60."* one line above *"Ren is
 * unfiled."*, which is a log misreporting a death as a full-health hit; reading
 * the tile here would flash the killing blow's marker thirty tiles from where it
 * landed. `GameEvent.attacked` carries both from one line after the blow.
 *
 * It also retires the old limitation: a victim hit twice inside one sweep used
 * to report the same final hp on both frames, and now each frame carries the hp
 * that blow left them on. `maxHp` genuinely cannot change during a fight, so
 * there is nothing to snapshot and the world is still the right place to ask.
 */
function hitToWire(
  world: World,
  attackerId: string,
  targetId: string,
  hit: boolean,
  amount: number,
  killed: boolean,
  hp: number,
  at: TileXY,
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE REST OF THE BLOW, BY NAME — AND IT WAS A POSITIONAL TAIL.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `healed` was the eighth positional argument, defaulted, and one of the two
   * callers simply stopped short of it. That is the shape that lost `crit`: a
   * long positional list where a caller passing four of five is indistinguishable
   * from a caller that meant to.
   *
   * `healed` — HP PUT BACK. Exactly one caller can produce it (the player lane's
   *   talent blows); a monster sweep or a travelling orb has nothing to say.
   *   See `Blow.healed`.
   * `crit`  — computed since M3 and dropped HERE, so a critical hit read
   *   character-for-character like a graze.
   * `type`  — computed since M3 and dropped a hop earlier, in `Blow`.
   */
  extra: {
    /** The victim's maximum at the instant the blow landed. See the use below. */
    readonly maxHp?: number;
    healed?: number;
    crit?: boolean;
    type?: DamageType;
  } = {},
): TurnEvent[] {
  const healed = extra.healed ?? 0;
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * A HEAL IS NOT A SWING: NO `attack` FRAME, AND THEREFORE NO SWING ANYWHERE.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `TalentHit.healed` was dropped in the `Blow` mapping, so Mend Wounds arrived
   * as `hit: true, damage: 0` and the whole room read:
   *
   *     Ren uses Mend Wounds.
   *     Ren hits Ren.       0 damage. Ren 41.5/54.
   *     Ren hits Alex.      0 damage. Alex 31/54.
   *
   * ...with render/sweep.ts stamping the STRUCK-TILE marker on both allies,
   * because that marker hangs off the `attack` frame. Suppressing the frame
   * removes the verb, the marker and the miss/hit read in one line — nothing
   * downstream needed a new case.
   *
   * THE `damage` FRAME STILL GOES OUT, because the client's hp is corrected from
   * the absolute number on it and a heal nobody is told about is a health bar
   * that stays wrong until the next resync. It carries `healed` so the Case Log
   * can say "patches up" instead of "0 damage" — see `DamageEvent.healed`.
   */
  if (healed > 0) {
    const healedVictim = world.getActor(targetId);
    return [
      {
        k: 'damage',
        id: targetId,
        amount: 0,
        healed,
        hp,
        maxHp: healedVictim?.maxHp ?? 0,
        sourceId: attackerId,
      },
    ];
  }

  const out: TurnEvent[] = [
    {
      k: 'attack',
      id: attackerId,
      targetId,
      x: at.x,
      y: at.y,
      hit,
    },
  ];

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * A MISS EMITS THE `attack` FRAME ALONE. NO DAMAGE, NO DEATH.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `AttackEvent.hit` has been on the wire since M2 and both readers were
   * already finished — `client/render/sweep.ts`'s `case 'attack'` picks the
   * marker off `event.hit`, and the gateway's `recordFor` `case 'attack'`
   * narrates "Watchman misses Bent Husk." Both by symbol: gateway.ts:2563 is a
   * `sendTurn(...)` call today, and a reader who follows it concludes no miss
   * narration exists and writes a second one.
   * The PRODUCER was the only liar: it hard-coded `true` because nothing
   * upstream of it could miss.
   *
   * Emitting a `damage` frame here would apply hp from a blow that never landed,
   * and a `death` frame would kill somebody with it. A miss is not a refusal
   * either: a refusal produces no `attack` frame at all, costs zero energy and
   * re-prompts (`PumpResult.refusals`).
   */
  if (!hit) return out;

  const victim = world.getActor(targetId);
  out.push({
    k: 'damage',
    id: targetId,
    amount,
    hp,
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE SNAPSHOT FIRST, AND THE WORLD ONLY AS A FALLBACK.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * This was `victim?.maxHp ?? 0` alone, under the note above saying *"maxHp
     * genuinely cannot change during a fight, so there is nothing to snapshot"*.
     * True of the NUMBER and false of the BODY. This function runs AFTER the
     * pump, and a party wipe runs a floor reset inside the same pump — which
     * removes every hostile in the room. The lookup then answers undefined and
     * the fallback ships ZERO.
     *
     * MEASURED, in `tools/first-death.mjs`, on every run: *"11 physical damage.
     * Index Eidolon 67/0."* in the Case Log — the game's most-read line, saying
     * a creature has no maximum health. It is the same root cause as
     * `killer-named.test.ts`'s "someone", one field along, and the same fix the
     * paragraph above already applied to `hp` and the tile.
     *
     * THE WORLD IS STILL ASKED when no snapshot came — every fixture that
     * builds a blow by hand, and the narrow projectile actor whose `maxHp` is
     * optional (damage.ts explains why).
     */
    maxHp: extra.maxHp ?? victim?.maxHp ?? 0,
    sourceId: attackerId,
    // Both omitted rather than defaulted when the blow has nothing to say:
    // absent means "do not name it", which is not the same as "physical" or
    // "not a crit". See `DamageEvent.type`.
    ...(extra.type === undefined ? {} : { type: extra.type }),
    ...(extra.crit === true ? { crit: true } : {}),
  });
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * A DOWNED PLAYER IS NOT DEAD, AND THIS USED TO SAY THEY WERE.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `killed` is `applyDamage`'s answer, and it is true of ANY body taken to 0 —
   * which for a player is the Downed state, deliberately (`alive === false` on
   * purpose, engine/downed.ts). This pushed `death` for it, and the Record lane
   * renders that as *"X is unfiled."*: the game's own word for a monster being
   * removed for good, printed over somebody with five turns on the clock and an
   * ally two tiles away.
   *
   * MEASURED over a real socket, walking a Watchman into an ambush — the events
   * in the order the client received them:
   *
   *     damage x13, death, downed, erased/wipe, damage
   *
   * So the transcript read "Player 1 is unfiled." and then, underneath it,
   * "Player 1 is DOWN — 5 turns". Two lines about the same body disagreeing
   * about whether the run is over, with the wrong one first.
   *
   * THE PLAYER'S EVENT IS `downed`, and `noteCasualty` already raises it with
   * the killer's id on it. Nothing is lost by this guard; a line is stopped
   * from being invented.
   */
  if (killed && world.getActor(targetId)?.kind === ActorKind.Monster) {
    out.push({ k: 'death', id: targetId, killerId: attackerId });
  }
  return out;
}

function sweepStepsToWire(world: World, steps: readonly SweepStep[]): TurnEvent[] {
  const out: TurnEvent[] = [];
  for (const step of steps) {
    switch (step.t) {
      case 'move':
        out.push({
          k: 'move',
          id: step.id,
          fromX: step.from.x,
          fromY: step.from.y,
          x: step.to.x,
          y: step.to.y,
        });
        break;
      case 'attack':
        out.push(
          ...hitToWire(
            world,
            step.id,
            step.targetId,
            step.hit,
            step.damage,
            step.killed,
            step.hp,
            step.at,
            { crit: step.crit, type: step.type, maxHp: step.maxHp },
          ),
        );
        break;
      /**
       * A CREATURE'S CAST — THE SAME WIRE EVENT A DETECTIVE'S PRODUCES.
       *
       * Field for field with the `talent_used` arm above, and that is the design
       * rather than a coincidence: the client has exactly one `k: 'talent'`
       * renderer, and a monster casting is not a different kind of happening
       * from a player casting. No protocol version moves for this.
       *
       * Its damage follows as ordinary `attack` steps, handled above.
       */
      case 'talent':
        out.push({
          k: 'talent',
          id: step.id,
          talentId: step.talentId,
          x: step.at.x,
          y: step.at.y,
          shape: step.shape,
          radius: step.radius,
          ...(step.targetId === undefined ? {} : { targetId: step.targetId }),
          ...(step.notes === undefined || step.notes.length === 0 ? {} : { notes: step.notes }),
        });
        break;
      // A status that landed DURING the monster turn. It rides inside the batch
      // rather than beside it because an ordinary event would close the batch and
      // split one sweep into three — see `SweepStep` in engine/scheduler.ts.
      case 'status':
        out.push(...statusToWire(step.note));
        break;
      // A monster's blow put a detective on the floor, mid-sweep. The client
      // paces this like any other step, so the countdown appears on the beat the
      // blow landed rather than after the whole monster turn has played out.
      case 'downed':
        out.push({
          k: 'downed',
          id: step.id,
          turns: step.turnsLeft,
          // The sweep lane's copy of the same fill — see the other site.
          ...(step.byId === undefined ? {} : { sourceId: step.byId }),
        });
        break;
      /**
       * ═══════════════════════════════════════════════════════════════════════
       * A SHOT LEFT THE MUZZLE — AND IT MAPS TO NOTHING, DELIBERATELY.
       * ═══════════════════════════════════════════════════════════════════════
       *
       * The orb is carried by the `projectiles` SNAPSHOT frame, which is the
       * only representation that survives a park, a reconnect and a resync: it
       * is complete and absolute, so a client that dropped a frame is corrected
       * by the next one rather than drawing a phantom orb forever.
       *
       * A one-frame event for a THREE-TURN object would be a second source of
       * truth for the same fact, which the client's own state rules forbid — and
       * it would be the wrong shape besides: the client applies a whole sweep in
       * one synchronous pass and clears its markers a quarter of a second later,
       * which is precisely when the player is deciding whether to step out of
       * the line. A three-turn threat rendered as a flash is the feature failing
       * its own test.
       *
       * The IMPACT is not dropped: it arrives as an ordinary `attack` step from
       * `actProjectile`, attributed to the shooter, up to three turns after this.
       */
      // A monster died mid-sweep and dropped something. Dropped at the wire for
      // the identical reason `fired` directly above is, and for the identical
      // reason its player-lane twin `GameEvent.spilled` is — the floor is a
      // snapshot frame's job, and that frame arrives with the protocol bump.
      case 'spill':
      case 'fired':
      case 'hold':
      case 'blocked':
        break;
    }
  }
  return out;
}

/**
 * What one pump produced, plus THE BODIES THAT ARE READY TO BE BURIED.
 *
 * A WIDENING OF the gateway's `PumpResult` rather than an edit to it, for the
 * reason that type's own header gives: the contract is INJECTED, NOT IMPORTED —
 * eslint bans `engine/** -> net/**` and net/ does not import the engine, so each
 * side states the shape it needs and the compiler proves they meet. A caller
 * still typed as the narrower `PumpResult` simply cannot see `reaped`, which is
 * correct: it has no `reap` to call either.
 */
export type ReapingPumpResult = PumpResult & {
  /**
   * Monsters that died during this pump, in the order they fell. STILL IN THE
   * WORLD — see `createTurnEngine`'s `reap`, and `PumpResult.reaped` in
   * engine/scheduler.ts for why the deletion is the caller's and not the pump's.
   */
  readonly reaped: readonly string[];
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * LEVELS CROSSED IN THIS PUMP — the one shared signal that a talent point
   * exists.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * A FOURTH LIST RATHER THAN A NEW `TurnEvent`, and for exactly the reason
   * `refusals` above is one: src/shared/version.ts records that a new `TurnEvent`
   * variant independently FORCES a protocol bump, and this needs none — the
   * gateway turns each entry into an ordinary Record-lane `LogLine`, which is
   * free text on a frame that already exists.
   *
   * ═══ WITHOUT IT A LEVEL-UP IS COMPLETELY SILENT, AND IT WAS ═══
   * `PumpCtx.onLevelUp` (engine/scheduler.ts) was declared, documented at length
   * as the Case Log narration seam, and invoked by `applyPendingLevels` — with
   * NOTHING ANYWHERE CONSTRUCTING THE CLOSURE. So the Case Log, which reports
   * every blow, every status and every death, said nothing at all when a player
   * gained a level; and `ProgressMsg` is viewer-private by design, so the only
   * other signal was a number behind a key the player had no reason to press.
   * Three friends could cross levels 2, 3 and 4 in the first fight of the
   * evening and finish it with every talent at rank 1.
   */
  readonly levelUps: readonly LevelUpNote[];
};

/**
 * The adapter, plus the two things the gateway needs that the narrow port does
 * not declare: the barrier instance (shared, because its Standing By counters
 * outlive every pump) and `reap`.
 */
export type ReapingTurnEngine = Omit<TurnEngine, 'pump'> & {
  readonly barrier: Barrier;
  pump(): ReapingPumpResult;
  /**
   * PASS TURNS UNTIL THERE IS A REASON TO STOP — ToME's `rest`.
   *
   * Answers how many turns went by and why it ended, so the caller can say one
   * sentence. See `src/shared/rest.ts` for the rule and why it is a pure
   * predicate here when upstream's heals inside itself.
   */
  rest(actorId: string): RestResult;
  /**
   * A WALL-CLOCK TICK ARRIVED — one game turn is owed to this realm.
   *
   * Fired by the gateway's per-realm timer for a shared realm, where the world
   * must keep moving whether or not anybody is pressing keys. Marks the debt;
   * the next `pump()` pays it and broadcasts, exactly as `bellExpired()` does.
   * Calling it twice before a pump still buys one turn.
   */
  tide(): void;
  /**
   * BURY ONE MONSTER — the full cleanup contract, in order, ending with the
   * world. Answers false for a player and for an unknown id; calling it twice is
   * free. Drain `ReapingPumpResult.reaped` through this and broadcast one
   * `{t:'left', id}` per body.
   */
  reap(actorId: string): boolean;
};

/**
 * WHAT A RESTING BODY CAN SEE — the engine half of `src/shared/rest.ts`.
 *
 * Every field is read fresh each turn, because every one of them can change on
 * the turn that just passed: a husk walks into view, a bleed expires, the last
 * cooldown turns over. A view built once and reused would rest through all of it.
 */
function buildRestView(
  world: World,
  self: Actor,
  talents: TalentBook,
  effects: EffectState | undefined,
): RestView {
  /**
   * THE NEAREST HOSTILE THIS BODY CAN SEE. Upstream keeps a `spotted` list
   * maintained by its FOV pass (Player.lua:974); we have no such list yet
   * (CLAUDE.md is blunt that per-player FOV is M6), so this asks the same
   * question directly of every actor in the realm.
   *
   * NEAREST rather than first, because the bearing is the whole point of the
   * message — pointing a player at a husk across the room while one stands
   * beside them would be worse than saying nothing.
   */
  let threat: RestView['threat'] = null;
  let best = Infinity;
  for (const other of world.allActors()) {
    if (other === self || !other.alive || !isHostile(self, other)) continue;
    /**
     * ONE SIGHT RULE, and this call site no longer spells its own.
     *
     * It used to measure with `chebyshev` and then test `hasLineOfSight`
     * separately — the pair `visibleEnemies` uses for monster AGGRO, which is a
     * different question. Upstream asks this one with `core.fov.calc_circle`
     * (Player.lua:854), a CIRCLE, so a husk at a diagonal 10 was interrupting
     * rests here at a true distance of 14. `canSee` is that circle plus the
     * wall test, and it is the same function the FOV projection spends.
     */
    const dist = sightDistance(self, other);
    if (dist >= best || !canSee(world.level, self, other, sightRadiusOf(self))) continue;
    best = dist;
    threat = { name: toDisplayName(other.name), dx: other.x - self.x, dy: other.y - self.y };
  }

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * AND A SHOT ALREADY IN THE AIR. Player.lua:861-885, the half we never had.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `spotHostiles` takes an `actors_only` flag and rest passes it FALSE, so
   * upstream stops a rest for an inbound projectile as well as for a body. Ours
   * scanned actors alone, which meant a detective could sit regenerating while a
   * bolt crossed the room at them — the precise moment resting is worst.
   *
   * The geometry is `orbOnMyLine` (engine/projectile.ts), which carries the two
   * terms and the reason for each. Here: your own shot is trusted, a friend's is
   * not, and the orb must be somewhere you can actually see.
   */
  for (const proj of world.projectilesInFlight()) {
    if (proj.landed || proj.sourceId === self.id) continue;
    const at = currentTile(proj);
    if (!canSee(world.level, self, at, sightRadiusOf(self))) continue;
    if (!orbOnMyLine(proj, self)) continue;
    // NEAREST WINS, shared with the actor pass above, so the sentence names
    // whichever thing is closest rather than whichever was scanned last.
    const dist = sightDistance(self, at);
    if (dist >= best) continue;
    best = dist;
    // Upstream names the projectile (`proj:getName() or proj.name`); ours have
    // no names, and "a shot" is what the Record lane calls one everywhere else.
    threat = { name: 'a shot', dx: at.x - self.x, dy: at.y - self.y };
  }

  /**
   * ANY DETRIMENTAL EFFECT STILL RUNNING (Player.lua:1023-1029). Beneficial ones
   * are deliberately NOT counted: a rest that waited out its own buffs would end
   * exactly when the party is weakest, which is upstream's reason for testing
   * `status` rather than merely `dur > 0`.
   */
  let afflicted = false;
  if (effects !== undefined) {
    for (const instance of effectsOn(effects, self.id)) {
      if (effectDef(effects, instance.effectId)?.status === EffectStatus.Detrimental) {
        afflicted = true;
        break;
      }
    }
  }

  const view = talents.resourceOf(self);
  const regen = talents.poolRegenOf?.(self) ?? 0;

  return {
    hp: self.hp,
    maxHp: self.maxHp,
    hpRegen: self.hpRegen,
    resource:
      view === undefined ? null : { value: view.current, max: view.max, regenPerTurn: regen },
    afflicted,
    // `> 0` and not `.size > 0`: a cooldown map holds zeroes for talents that are
    // ready, because `projectCooldowns` reads the same map to grey the buttons.
    cooling: [...self.cooldowns.values()].some((turns) => turns > 0),
    threat,
  };
}

export function createTurnEngine(opts: TurnEngineOptions): ReapingTurnEngine {
  const { world } = opts;
  const now = opts.now ?? (() => Date.now());
  const barrier = opts.barrier ?? createBarrier();
  /**
   * ONE GAME TURN IS OWED TO THIS REALM. See `tide()`.
   *
   * Lives out here beside `barrier` and for the same reason: it is state that
   * must survive between pumps. A tide can arrive at any moment; the pump that
   * follows is what spends it.
   */
  let owedTurn = false;
  const talents = opts.talents ?? EMPTY_TALENT_BOOK;
  const log = opts.log ?? SILENT_LOGGER;
  const reseedFloor = opts.reseedFloor ?? seedTestEncounter;

  /**
   * THE GAME TURN EACH PARTY LAST WIPED ON. The churn alarm, and nothing else.
   *
   * IT LIVES HERE BECAUSE IT HAS TO OUTLIVE A PUMP. The scheduler already
   * refuses to reset the same party twice inside one call (`SurvivalRun.wiped`),
   * which bounds a reset loop WITHIN a call — but a floor reset that fails to
   * separate the party from what killed them produces one tidy wipe per call,
   * forever, and from inside the engine that is indistinguishable from a party
   * having a bad night. Only something that spans pumps can tell them apart.
   *
   * It is a diagnosis, not a brake: the reset still runs, because the right
   * answer to "this is not working" is never "stop trying to put them back on
   * their feet". What it buys is a log line naming the party and the turn,
   * instead of an evening spent reading a Case Log that looks fine.
   */
  const lastWipeTurn = new Map<string, number>();

  /**
   * ═════════════════════════════════════════════════════════════════════════
   * BURY A MONSTER. THE ONE FUNCTION THAT REMOVES A BODY FROM THE WORLD.
   * ═════════════════════════════════════════════════════════════════════════
   *
   * ToME ends a death at `Actor.lua:2975`, which calls
   * `engines/default/engine/interface/ActorLife.lua:86-94`:
   *
   * ```lua
   * if game.level:hasEntity(self) then game.level:removeEntity(self) end
   * ```
   *
   * DELIBERATE DEVIATION, RECORDED SO IT IS NOT RE-LITIGATED: upstream removes
   * BEFORE its log line because it still holds the object reference. Our Record
   * lane re-resolves every id through `world.getActor` after the pump has
   * returned, so we remove AFTER the narration — the caller drains
   * `PumpResult.reaped` in the window between broadcasting the record and the
   * resync. Reap inside the pump and two readers degrade silently: `hitToWire`
   * ships `maxHp: 0` and the Case Log narrates "someone 0/0".
   *
   * ═══ AND ONE READER THE WINDOW DOES *NOT* SAVE, STATED SO NOBODY RELIES ON
   * IT ═══
   * An orb in flight is attributed to `proj.sourceId`, and the window only
   * covers the pump the shooter died in. The wraith authors `projSpeed 2` over
   * `attackRange 6`, so its orb arrives two or three GAME TURNS later, in a pump
   * where this body is long gone. Ordering cannot fix that — the gateway keeps a
   * name memo for exactly as long as something is in the air (`reapedNames` in
   * net/gateway.ts). Do not add "and an orb keeps its shooter" to the list
   * above; it does not.
   *
   * ALSO DECLINED, IN THE SAME BREATH: `bloodyDeath` (Actor.lua:3008,
   * BloodyDeath.lua:29-51). It is a terrain tint needing a per-tile layer the
   * renderer does not have, and it injects `1 + 2n` UNLABELLED draws into the
   * middle of every kill — which is exactly the thing replay-from-seed cannot
   * survive.
   *
   * ═══ THE ORDER IS THE CONTRACT, AND `world.removeActor` IS LAST ═══
   * Once the body is out of the world there is no way left to enumerate which
   * side tables still hold its id: every one of them is keyed by a string and
   * none of them can be walked backwards. So the world deletion is the last
   * line, always.
   *
   * ═══ THE GUARD IS POSITIVE. `kind === 'monster'`, NEVER "not a player" ═══
   * `world.removePlayer` IS `world.removeActor` — the same closure, the
   * `removePlayer: removeActor` row in world.ts's returned literal, cited by
   * symbol because a line number there drifts every time the file grows — so
   * there is no type-level protection here at all. A DOWNED body is
   * `alive === false` by design and an ERASED one still has to be there for an
   * ally to walk to; engine/downed.ts:20-36 is explicit that M4 ships no
   * permadeath and that deleting a body loses somebody's character. A negative
   * guard would quietly delete both the first time an unexpected `kind` appears.
   *
   * ═══ TWO THINGS ARE DELIBERATELY NOT CLEANED ═══
   * ORBS IN FLIGHT — engine/projectile.ts is explicit that the shooter may be a
   * corpse three turns later; the orb carries everything it needs, and the sky
   * is cleared separately and deliberately by `resetFloor`.
   * OTHER MONSTERS' `ai.targetId` — npc.ts:186-196 self-heals: a target that is
   * no longer visible simply fails the `find` and a new one is acquired.
   *
   * @returns whether a body was actually removed. False for a player, for an
   * unknown id, and for anything already reaped — so calling it twice is free.
   */
  const reap = (actorId: string): boolean => {
    const actor = world.getActor(actorId);
    if (actor === undefined) return false;
    if (actor.kind !== 'monster') return false;

    if (opts.effects !== undefined) forgetEffects(opts.effects, actorId);
    opts.talentRuntime?.forget(actorId);
    if (opts.downed !== undefined) forgetDowned(opts.downed, actorId);
    if (opts.parties !== undefined) forgetParty(opts.parties, actorId);
    barrier.forget(actorId);
    return world.removeActor(actorId);
  };

  /**
   * Built fresh rather than cached. The quorum depends on who is conscious and
   * connected RIGHT NOW, and a stale snapshot here would show the wrong name
   * next to the Bell — which game-design.md calls the known killer of co-op
   * turn-based games.
   */
  /**
   * WHICH BARRIER THIS PLAYER IS STANDING AT, or undefined for the level.
   *
   * Undefined in exactly two cases and both mean "the pre-party game": no party
   * table was wired in, or no actor id was named (the gateway's level-wide
   * bookkeeping — see `turnState` below).
   *
   * `partyOf` MINTS on demand, which is what makes "every player is always in a
   * party" true without a join path that could forget to do it. It is
   * idempotent, so asking on every frame costs one Map lookup.
   */
  const scopeFor = (actorId: string | undefined): PartyScope | undefined => {
    const parties = opts.parties;
    if (parties === undefined || actorId === undefined) return undefined;
    return { id: partyIdOf(parties, actorId), members: membersOf(parties, actorId) };
  };

  /**
   * EVERY BARRIER ON THIS LEVEL, one per party, in a deterministic order.
   *
   * Used by `bellExpired`, which is entered from ONE wall-clock timer in the
   * gateway and therefore has to sweep them all: each `expire` reads its own
   * party's deadline and returns nothing if that party still has time, so a
   * single wake-up is safe for any number of countdowns.
   */
  const allScopes = (): readonly (PartyScope | undefined)[] => {
    const parties = opts.parties;
    if (parties === undefined) return [undefined];
    const scopes: PartyScope[] = [];
    const seen = new Set<string>();
    for (const actor of playersOf(world)) {
      const id = partyIdOf(parties, actor.id);
      if (seen.has(id)) continue;
      seen.add(id);
      scopes.push({ id, members: membersOf(parties, actor.id) });
    }
    return scopes;
  };

  /**
   * @param viewerId whose party this snapshot is about. OMITTED means the whole
   *   level, which is what the gateway's "has the barrier changed?" key is
   *   built from — the level-wide blocking set is the exact union of every
   *   party's, so one cheap comparison cannot miss a per-party change.
   */
  const turnState = (viewerId?: string): TurnState => {
    const level = levelOf(world);
    const scope = scopeFor(viewerId);
    const snapshot = barrier.survey(playersOf(world), level, scope);
    /**
     * The countdown, only when one is genuinely on somebody. See the note on
     * `bellDurationMs` below — this exists as a named function so the two facts
     * `BellState` carries cannot be confused again by a one-line edit.
     */
    const bellToArm = (): number | null => {
      if (snapshot.total === 0) return null;
      const state = barrier.bell(playersOf(world), level, now(), scope);
      return state.running ? state.durationMs : null;
    };

    return {
      gameTurn: world.turn.clock.gameTurn,
      // THE COMBAT CLOCK, TAKEN FROM THE SAME `BarrierLevel` THE SURVEY WAS RUN
      // AGAINST. `levelOf` read it once, at the top of this function, and both
      // the blocking set below and this number come out of that one read — so
      // the frame can never say "in combat" beside an empty quorum, or the
      // reverse, because the two were decided from different instants.
      //
      // It is what the client has been missing entirely: 0 is free movement,
      // above 0 is a fight, and the CROSSING is the moment somebody has to be
      // told (see `turnKey` in net/gateway.ts).
      engagement: level.engagement,
      whoseTurn: snapshot.blocking,
      committed: snapshot.blocking.length === 0 ? [] : [],
      standingBy: snapshot.standingBy,
      /**
       * WHO IS MID-ROUND. Read off the bodies rather than tracked separately,
       * because `roundActions` is already the answer and a second copy is a
       * second thing to keep in step — `spendTurn` clears it and nothing else
       * has to remember to.
       *
       * FILTERED TO THE BLOCKING SET, so this is always a subset of
       * `whoseTurn`: a player whose round closed is not mid-round, and one in
       * another party is not this snapshot's business.
       */
      acting: snapshot.blocking.filter((id) => {
        const body = world.getActor(id);
        // `isPlayer` narrows the union — `roundActions` is a player-only field,
        // which is what keeps `BarrierActor` untouched by the whole feature.
        return body !== undefined && isPlayer(body) && body.roundActions > 0;
      }),
      /**
       * ═══════════════════════════════════════════════════════════════════════
       * HOW LONG TO ARM FOR — AND `null` UNLESS A BELL IS ACTUALLY RUNNING.
       * ═══════════════════════════════════════════════════════════════════════
       *
       * `BellState` carries two different facts and its own doc comments draw
       * the line: `running` is *"true while a countdown is actually running"*,
       * `durationMs` is *"what the countdown WOULD be, EVEN WHEN IT IS NOT
       * RUNNING"*. This field used to be the second one — and the gateway's
       * `syncBell` reads it as *arm a real wall-clock timer for this long*.
       *
       * So the moment three people were in a fight, a 20-second timer was armed
       * and a 20-second countdown was drawn on three screens with nobody having
       * committed to anything. When it reached zero `barrier.expire` re-derived
       * the rule, correctly found the Bell had never been armed, and returned no
       * passes — so the clock hit zero, NOTHING HAPPENED, and it started again.
       * Forever, in every group fight.
       *
       * That is worse than a cosmetic bug. The Bell's whole force is social: the
       * clock appearing means *the table is waiting on you now*. A countdown that
       * is always running is a countdown that is never information, so the one
       * moment it should have meant something — everybody else committed, the
       * table waiting on one person — was indistinguishable from the twenty
       * minutes of noise before it.
       *
       * `barrier.ts` states the rule this restores, and states why it is safe to
       * be aggressive: *"`committed >= total - 1` is the same thing as
       * `blocking.length <= 1`: the Bell only ever rings for the LAST straggler,
       * which is why it can be aggressive without ever hurrying somebody who has
       * company."*
       *
       * SOLO IS UNTOUCHED. At a quorum of one, `blocking.length <= 1` holds from
       * the first blocker, so `running` is already true and the two-minute clock
       * appears exactly when it always did.
       */
      bellDurationMs: bellToArm(),
      // THE MEMBERSHIP THE THREE ARRAYS ABOVE WERE COMPUTED AGAINST. Absent for
      // the level-wide snapshot, which is what it has always meant. The
      // projector filters the card strip on it so that one card can never be
      // built from one party's blocking set over another party's roster.
      party: scope?.members,
    };
  };

  const requireLiveActor = (actorId: string): Actor | undefined => {
    const actor = world.getActor(actorId);
    if (actor === undefined || !actor.alive) return undefined;
    return actor;
  };

  /**
   * Hand a VALIDATED talent intent to the scheduler. The last line of
   * `submitTalent`, factored out only so the `self` and targeted paths cannot
   * drift apart on what "accepted" means.
   *
   * `submitIntent` can still say no — the actor died on another socket's frame
   * between the checks above and this call, which is a real race in a co-op
   * game where every accepted command pumps synchronously.
   */
  const queue = (actorId: string, intent: Intent): TalentResult => {
    const accepted = submitIntent(world, barrier, actorId, intent);
    return accepted ? TALENT_OK : refuseTalent(ErrorCode.NotYourTurn, 'no_actor');
  };

  const api: ReapingTurnEngine = {
    barrier,

    join(actorId: string): void {
      // Idempotent by construction: the world created the actor, and the
      // barrier allocates its record lazily on first contact. Clearing any
      // stale Standing By is the part that actually matters — a player who
      // dropped and came back must rejoin the quorum, not stay excluded.
      const actor = world.getActor(actorId);
      if (actor !== undefined) barrier.reconnect(actor);
    },

    leave(actorId: string): void {
      // A genuine departure, not a dropped socket. Drop the bookkeeping too,
      // or a rejoining id inherits the old Standing By counters.
      barrier.forget(actorId);
      // AND THE TALENT SHEET, beside it: engine/talents.ts keys its sheets and
      // its Guard/Taunt/Mark table by actor id, and an id that comes back —
      // `actorIdForUser` is a stable hash, so the same player returning tomorrow
      // IS the same id — would inherit whatever was left on it.
      opts.talentRuntime?.forget(actorId);
      // AND THE PARTY, for the same reason: a party row pointing at a body that
      // is no longer in the world would scope a barrier to somebody who cannot
      // block, and the pane would draw a member nobody can reach. NOT the
      // disconnect path — see `forgetActor`'s own note: a dropped socket keeps
      // its seat at the table for the whole reconnect grace.
      if (opts.parties !== undefined) forgetParty(opts.parties, actorId);
      /**
       * ═══════════════════════════════════════════════════════════════════════
       * AND THE TWO TABLES THIS FORGOT — THE COUNTDOWN AND THE STATUSES.
       * ═══════════════════════════════════════════════════════════════════════
       *
       * `reap` — twelve lines up, for a MONSTER leaving — empties all five
       * tables, and names the reason in its own docblock. This path, for a
       * PLAYER leaving, emptied three. The two it missed are the two that
       * describe a body's condition rather than its relationships.
       *
       * ═══ THE SCENARIO, AND IT IS NOT EXOTIC ═══
       * Somebody's Discord drops mid-fight while they are DOWNED. The reconnect
       * grace expires and their body is recalled through here. They come back
       * that evening — and `actorIdForUser` is a stable hash, so the same player
       * IS the same id — to a brand-new, full-health body that the Downed table
       * still has a record for. They are drawn prone under a countdown marker,
       * they are outside the quorum so the barrier waits on somebody who cannot
       * act, and a party of one wipes: `resetFloor` runs on a floor where
       * nothing happened.
       *
       * The status table is the same shape of bug and arrived this milestone:
       * they would come back still Bleeding, from a fight they left.
       *
       * ═══ WHY `leave` AND NOT `setConnected(false)` ═══
       * Exactly the reason the party line above gives. A dropped socket KEEPS
       * its seat for the whole reconnect grace — its countdown must keep running
       * and its statuses must keep ticking, because the body is still on the
       * floor and its friends can still reach it. This is the other path: the
       * body is leaving the world, so everything keyed to it goes with it.
       */
      if (opts.downed !== undefined) forgetDowned(opts.downed, actorId);
      if (opts.effects !== undefined) forgetEffects(opts.effects, actorId);
      world.removePlayer(actorId);
    },

    setConnected(actorId: string, connected: boolean): void {
      if (connected) {
        reconnectActor(world, barrier, actorId);
      } else {
        // THE BODY STAYS IN THE WORLD. This is the M2 semantic change from M1.
        disconnectActor(world, barrier, actorId, now());
      }
    },

    submitMove(actorId: string, dir: Dir): IntentResult {
      if (requireLiveActor(actorId) === undefined) return refuse('no_actor');
      const accepted = submitIntent(world, barrier, actorId, { kind: IntentKind.Move, dir });
      return accepted ? OK : refuse('no_actor');
    },

    loadoutOf(actorId: string): readonly LoadoutTalent[] {
      const actor = world.getActor(actorId);
      return actor === undefined ? [] : talents.loadoutOf(actor);
    },

    passivesOf(actorId: string): readonly LoadoutTalent[] {
      const actor = world.getActor(actorId);
      return actor === undefined ? [] : (talents.passivesOf?.(actor) ?? []);
    },

    deepenableOf(actorId: string): readonly string[] {
      const actor = world.getActor(actorId);
      return actor === undefined ? [] : (talents.deepenableOf?.(actor) ?? []);
    },

    unlockableOf(actorId: string): readonly UnlockableTree[] {
      const actor = world.getActor(actorId);
      return actor === undefined ? [] : (talents.unlockableOf?.(actor) ?? []);
    },

    resourceOf(actorId: string): ResourceView | undefined {
      const actor = world.getActor(actorId);
      return actor === undefined ? undefined : talents.resourceOf(actor);
    },

    /**
     * ═════════════════════════════════════════════════════════════════════════
     * THE TALENT GATE. THE POINT OF THE WHOLE FEATURE.
     * ═════════════════════════════════════════════════════════════════════════
     *
     * The client's range ring, `min_range` hole, LOS greying and cooldown wipe
     * are a CONVENIENCE. This function is the rule. Everything the overlay draws
     * is re-decided here from the server's own world, because the frame that
     * matters is not the one a well-behaved renderer sends — it is the one typed
     * into a devtools console by a friend who wants to know whether the Inspector
     * really cannot shoot point blank.
     *
     * SEVEN CHECKS, IN THIS ORDER, EACH WITH ITS OWN CODE:
     *
     *   1. the actor is alive             -> not_your_turn
     *   2. the talent is IN THEIR LOADOUT -> bad_message   (M3 loadouts are fixed)
     *   3. it is off cooldown             -> on_cooldown
     *   4. they can afford it             -> no_resource
     *   5. the target is on the map       -> illegal_move
     *   6. range, then THE DEAD ZONE      -> out_of_range / too_close
     *   7. line of sight                  -> no_los
     *
     * ORDER 6 IS NOT ARBITRARY and it is the same order as `canAttack` in
     * engine/combat.ts (:252-262), deliberately: two places that decide "can this
     * reach that" must agree, or a talent and a weapon swing disagree about the
     * same tile and the bug reads as the server cheating. `combatDistance` is
     * imported from that file for the same reason — one Euclidean metric in the
     * process, matching `core.fov.distance`, so a range-5 ring is a CIRCLE and
     * not a square that reaches 7.07 tiles into its corners.
     *
     * TOO_CLOSE IS NEVER OUT_OF_RANGE. game-design.md § 2 calls `min_range 3`
     * the single most important number in the Inspector, and the two failures
     * carry opposite instructions: one says close in, the other says back away.
     * Reporting the wrong one is how a positional class gets read as broken.
     *
     * WHAT IS DELIBERATELY *NOT* CHECKED HERE: whether a monster is standing on
     * the target tile, whether it is still alive, and whether it is still
     * hostile. Those are RESOLUTION questions — an intent that goes illegal
     * between the packet and the tick costs zero energy and re-prompts
     * (docs/architecture.md § 2), and that refund is what removes hesitation from
     * a co-op turn. What is checked here is only what cannot change in between:
     * terrain, the caster's own position at submission, the catalogue, and the
     * bookkeeping the caster owns.
     */
    submitTalent(actorId: string, talentId: string, target?: TileXY): TalentResult {
      const actor = requireLiveActor(actorId);
      if (actor === undefined) {
        // "Not now", not "not there" — the body is gone or it is a corpse.
        return refuseTalent(ErrorCode.NotYourTurn, 'no_actor');
      }

      // ═══════════════════════════════════════════════════════════════════
      // MEMBERSHIP IS THE FIRST REAL CHECK, AND IT IS SHEET-DRIVEN.
      // ═══════════════════════════════════════════════════════════════════
      //
      // This comment used to justify itself with "M3 loadouts are FIXED
      // (PLAN.md § M3: zero trees, zero talent points)". THE POINTS LANDED and
      // that clause is false — but the CODE was always right, because it has
      // never read a `ClassDef`: `talents.loadoutOf(actor)` maps this BODY's
      // own `TalentSheet.loadout` through the registry (`createTalentBook` in
      // content/classes.ts), so it answers what this actor can actually use
      // rather than what its class was authored with.
      //
      // What progression changed is the DEPTH of the four, never the count, so
      // the claim underneath survives intact: "do you have this talent" is a
      // lookup in your own four, and a frame naming a thirteenth — or the
      // Alchemist's heal on the Watchman — is a hand-crafted frame rather than
      // a UI slip. `bad_message` rather than a game-rule code says so.
      //
      // ═══ AND THE VIEW IT RETURNS IS PER-ACTOR, WHICH THE FALLBACK RELIES ON
      // ═══ See the range check below.
      const talent = talents.loadoutOf(actor).find((entry) => entry.id === talentId);
      if (talent === undefined) {
        return refuseTalent(ErrorCode.BadMessage, `no such talent in this loadout: ${talentId}`);
      }

      // WHEN THE REAL CHECKER IS WIRED IN, IT WINS OUTRIGHT. Everything below
      // this branch is the catalogue-only fallback; running both would be two
      // implementations of the same rule, and the second one is always the one
      // that is wrong about a corner tile.
      const authoritative = talents.check?.(actor, talent.id, target) ?? null;
      if (authoritative !== null) {
        /**
         * ═══════════════════════════════════════════════════════════════════
         * A SENTENCE, NOT THE CODE. THIS PRINTED `Ward Rush: bad_message`.
         * ═══════════════════════════════════════════════════════════════════
         *
         * It read `${talent.name}: ${authoritative}` — the wire code, rendered
         * as prose. For most codes the client rewrites the category itself
         * (`refusalText` turns `out_of_range` into "too far away"), but
         * `bad_message` is the one arm where it deliberately DEFERS: *"a game
         * rule, and the server already wrote the sentence."* Here the server had
         * not written one, so a player pressing a hotbar button they have not
         * learned yet was told, verbatim, `Ward Rush: bad_message`.
         *
         * MEASURED with `tools/round-live.mjs`, which reported `casts landed: 0`
         * and three of those errors — and then concluded from zero casts that
         * the multi-action round was "CLOSED".
         *
         * ═══ AND AT THIS CALL SITE `bad_message` HAS EXACTLY ONE MEANING ═══
         * `REFUSAL_TO_CODE` (content/classes.ts) maps two refusals onto it,
         * `NotLearned` and `UnknownTalent` — but the loadout-membership check
         * eight lines above has already refused anything this body does not
         * carry, so a talent reaching the checker is always one it HAS. The only
         * thing left for the checker to object to is that it has never been
         * raised above rank 0, which is a GAME RULE and reads as one now.
         *
         * (That mapping's own justification — *"M3 loadouts are FIXED, so a
         * frame naming a talent that is not in your four was hand-crafted rather
         * than clicked"* — is the same stale sentence the membership check above
         * already corrected: the points landed, a loadout carries nine talents
         * and two of them are learned.)
         */
        return refuseTalent(authoritative, refusalSentence(talent.name, authoritative));
      }
      if (talents.check !== undefined) {
        return queue(actorId, talentIntent(talent, target));
      }

      const cooling = cooldownOf(actor, talent.id);
      if (cooling > 0) {
        return refuseTalent(ErrorCode.OnCooldown, `${talent.name}: ${cooling} turn(s) left`);
      }

      if (talent.cost.resource > 0) {
        const resource = talents.resourceOf(actor);
        const have = resource?.current ?? 0;
        if (have < talent.cost.resource) {
          return refuseTalent(
            ErrorCode.NoResource,
            `${talent.name}: costs ${talent.cost.resource}, have ${have}`,
          );
        }
      }

      if (talent.shape === TalentShape.Self) {
        // A self talent has no target. A frame that aims one somewhere else is
        // refused rather than quietly ignored: silently dropping a field is how
        // a client and a server start disagreeing about what was cast.
        if (target !== undefined && (target.x !== actor.x || target.y !== actor.y)) {
          return refuseTalent(ErrorCode.IllegalMove, `${talent.name} cannot be aimed`);
        }
        return queue(actorId, talentIntent(talent, undefined));
      }

      if (target === undefined) {
        return refuseTalent(ErrorCode.BadMessage, `${talent.name} needs a target tile`);
      }
      if (!inBounds(target.x, target.y, world.level.w, world.level.h)) {
        return refuseTalent(ErrorCode.IllegalMove, 'that tile is not on the map');
      }

      const distance = combatDistance(actor, target);
      // ═══════════════════════════════════════════════════════════════════
      // `talent.range` IS THE CASTER'S OWN RANGE, NOT A CLASS CONSTANT.
      // ═══════════════════════════════════════════════════════════════════
      //
      // This line is the catalogue-only fallback and it reads `range` /
      // `minRange` straight off the `LoadoutTalent` view, which is CORRECT
      // AUTOMATICALLY — but only because the view is built per-actor:
      // `createTalentBook.loadoutOf` resolves
      // `effectiveTalentRange(targeting, getTalentLevelRaw(sheet, id))` for this
      // body's own rank, which is the identical call `canUseTalent` makes on the
      // authoritative path above.
      //
      // WHY IT IS CALLED OUT HERE RATHER THAN LEFT TO BE OBVIOUS: this is
      // exactly where a class-constant range would sneak back in. A `TalentBook`
      // that built its views from a `ClassDef` — the shape this file's own tests
      // hand it, and the shape any hand-written two-talent book naturally takes
      // — would refuse a rank-5 Inspector the 7-tile Fog Step her hotbar drew,
      // and the bug would present as the server cheating. The rule is: whatever
      // supplies `loadoutOf` must resolve the range at the actor's level, and
      // nothing in this file may re-derive it from a talent definition.
      if (distance > talent.range) {
        return refuseTalent(
          ErrorCode.OutOfRange,
          `${talent.name}: range ${talent.range}, target ${distance.toFixed(1)} away`,
        );
      }
      // THE DEAD ZONE. `<` not `<=`, so min_range 3 makes 3 the closest LEGAL
      // tile — and because the metric is Euclidean the hole is a CIRCLE: the
      // diagonal at (3,3) is 2.83 away and sits inside it, exactly as
      // test/server/combat.test.ts pins for a weapon.
      if (talent.minRange > 0 && distance < talent.minRange) {
        return refuseTalent(
          ErrorCode.TooClose,
          `${talent.name}: needs ${talent.minRange}, target ${distance.toFixed(1)} away`,
        );
      }
      // Melee needs no sight check — you are standing on them. The guard mirrors
      // `canAttack`; Bresenham excludes both endpoints, so an adjacent tile is
      // always in sight anyway and the two agree by construction.
      if (distance > 1 && !hasLineOfSight(world.level, actor, target)) {
        return refuseTalent(ErrorCode.NoLos, `${talent.name}: no line of sight to that tile`);
      }

      return queue(actorId, talentIntent(talent, target));
    },

    commit(actorId: string): IntentResult {
      const actor = requireLiveActor(actorId);
      if (actor === undefined) return refuse('no_actor');
      // Committing with nothing queued means "I am done" — which is a hold.
      // Committing with a move queued just marks the existing intent final.
      if (actor.pendingIntent === undefined || actor.pendingIntent === null) {
        const accepted = submitIntent(world, barrier, actorId, HOLD_INTENT);
        return accepted ? OK : refuse('no_actor');
      }
      barrier.noteCommand(actor);
      return OK;
    },

    hold(actorId: string): IntentResult {
      if (requireLiveActor(actorId) === undefined) return refuse('no_actor');
      const accepted = submitIntent(world, barrier, actorId, HOLD_INTENT);
      return accepted ? OK : refuse('no_actor');
    },

    /**
     * `TurnEngine.notePresence` — the barrier's "somebody is at the keyboard",
     * reachable from a verb that does not pump.
     *
     * `requireLiveActor` rather than a bare lookup, so a body that is DOWNED is
     * not credited with presence it may not have: the flag it clears only
     * matters for a body that can take a turn. It is the same gate `commit`
     * above uses before its own `noteCommand`.
     */
    notePresence(actorId: string): void {
      const actor = requireLiveActor(actorId);
      if (actor === undefined) return;
      barrier.noteCommand(actor);
    },

    /**
     * ═════════════════════════════════════════════════════════════════════════
     * GET TO THEM. The adapter between a DIRECTION on the wire and an ID in the
     * engine — and the two are different on purpose.
     * ═════════════════════════════════════════════════════════════════════════
     *
     * THE WIRE SAYS A DIRECTION because identity never travels client -> server
     * (protocol.ts's missing-field note): a `revive` naming an ally id would be
     * the first frame in the protocol that names somebody else's body, and the
     * tile beside you is the only place a revive can happen anyway.
     *
     * THE ENGINE SAYS AN ID because of the refund rule. An intent submitted now
     * resolves later, and between the two the party moves: a direction re-read at
     * resolution would pick up whoever has since STEPPED INTO that tile, which is
     * how you spend 4 AP standing up the wrong person — or the person who was
     * never down. The subject of a revive has to be fixed at the moment the
     * player pointed at it, and an id is what fixes it.
     *
     * So this function is where one becomes the other, and it is the ONLY place
     * that conversion happens.
     *
     * IT CHECKS EXACTLY ONE THING: that there is a body on that tile. Everything
     * else — is that body Downed, is it in reach, can the rescuer afford the 4 AP
     * (game-design.md § 9) — belongs to `revive` in engine/downed.ts, which the
     * scheduler calls at RESOLUTION, and the scheduler's own comment says why:
     * one definition of "reaching you", so the rule and the log line cannot
     * drift. A refusal there costs zero and re-prompts, which is what makes the
     * button safe to press in the one moment a player must not hesitate.
     *
     * ═══ IT CANNOT USE `world.actorAt`, AND THAT IS THE WHOLE TRAP ═══
     * `goDown` (engine/downed.ts) sets `alive = false` on the body it puts on
     * the floor — deliberately, because that flag is what stops the scheduler
     * ticking them and what stops them blocking the tile an ally has to step
     * onto. `world.actorAt` skips exactly that, "corpses do not block". So the
     * one lookup that reads as obviously correct here returns undefined for
     * every body this verb exists to reach, and the symptom is a revive key that
     * says "nobody is lying there" while somebody is lying there.
     *
     * Hence the scan over ALL actors, and hence the preference for a body that
     * is NOT alive: a corpse does not block, so an ally may be standing on the
     * same tile, and the one you are reaching for is the one on the floor.
     */
    submitRevive(actorId: string, dir: Dir): IntentResult {
      const actor = requireLiveActor(actorId);
      if (actor === undefined) return refuse('no_actor');

      /**
       * ═══════════════════════════════════════════════════════════════════════
       * THE TILE YOU NAMED — OR THE ONE YOU ARE STANDING ON.
       * ═══════════════════════════════════════════════════════════════════════
       *
       * A DOWNED BODY DOES NOT BLOCK. `actorAt` skips anything not alive
       * ("corpses do not block", world.ts) and a Downed body is `alive === false`
       * by design, so a rescuer running to a friend does not stop beside them —
       * they walk ONTO them. That is the natural last step of the run, and it is
       * where the whole mechanic was quietly failing:
       *
       *   - `revive` names a DIRECTION, and there is no direction to your own
       *     tile, so nothing you can press picks them up.
       *   - the client's `adjacentDowned` requires `chebyshev === 1`, so the
       *     gold prompt VANISHES at the exact moment you arrive.
       *
       * Measured, driving two players into a grim site: the rescuer reached the
       * body and the driver reported "adjacent but no direction: gap 0" while a
       * five-turn countdown ran out. game-design.md § 9 calls Downed the
       * mechanic that "does more for co-op tension than anything else" because
       * it turns "I died" into GET TO ME — and getting to them was the one thing
       * that did not work.
       *
       * OWN TILE FIRST, because standing on somebody is unambiguous: there is
       * exactly one body under you and it is the one you ran to. The named
       * direction still works for every other case, which is all of them.
       */
      const here = world.allActors().filter((a) => a.x === actor.x && a.y === actor.y);
      const underfoot = here.find((a) => a.kind === 'player' && !a.alive && a.id !== actor.id);
      const tile = underfoot === undefined ? step(actor, dir) : { x: actor.x, y: actor.y };
      const bodies =
        underfoot === undefined
          ? world.allActors().filter((a) => a.x === tile.x && a.y === tile.y)
          : here.filter((a) => a.id !== actor.id);
      if (bodies.length === 0) return refuse('nobody is lying there');

      // A monster is not somebody to pick up. Refused here rather than at
      // resolution because it is a fact about the CATEGORY of the thing, which
      // cannot change between the packet and the tick.
      const target =
        bodies.find((a) => a.kind === 'player' && !a.alive) ??
        bodies.find((a) => a.kind === 'player');
      if (target === undefined) return refuse('nobody there to pick up');

      /**
       * ═══════════════════════════════════════════════════════════════════════
       * ERASED IS NOT DOWNED, AND THE PLAYER HAS TO BE TOLD WHICH.
       * ═══════════════════════════════════════════════════════════════════════
       *
       * `revive` refuses an erased body by design — the clock ran out and the
       * way back is a floor reset, not a hand. That refusal was landing at
       * RESOLUTION as `Refusal.NotDowned`, which the gateway forwards with
       * `illegal_move`, so a player kneeling beside a friend who had just run
       * out of turns read *"you cannot go that way"*. Measured over a socket.
       *
       * REFUSED HERE, for the reason the check directly above gives about
       * monsters: *"it is a fact about the CATEGORY of the thing, which cannot
       * change between the packet and the tick."* An erased body stays erased
       * until a wipe or a respawn puts it back on its feet — no tick makes it
       * revivable — so the answer is knowable now, and answering now is what
       * lets it be a sentence instead of a tag.
       *
       * THE RULE IS UNCHANGED. `revive` in engine/downed.ts still decides, and
       * still refuses; this refuses the same case earlier and says why.
       */
      if (opts.downed !== undefined && isErased(opts.downed, target.id)) {
        return refuse('they are gone — only a fresh start brings them back');
      }

      const accepted = submitIntent(world, barrier, actorId, {
        kind: IntentKind.Revive,
        targetId: target.id,
      });
      return accepted ? OK : refuse('no_actor');
    },

    /**
     * ═════════════════════════════════════════════════════════════════════════
     * GET YOURSELF BACK ON YOUR FEET. The way out of Erased, and only out of it.
     * ═════════════════════════════════════════════════════════════════════════
     *
     * ═══ IT IS NOT AN INTENT, AND IT CANNOT BE ═══
     * Every other verb here queues an intent for the scheduler to resolve on the
     * actor's next turn. An ERASED body never gets one: `pump`'s `isActive` gate
     * drops an erased player out of `tickLevel` entirely — that is exactly what
     * makes the erased state cheap — so an intent queued on one would sit there
     * until the heat death of the session. So the restoration is applied HERE,
     * synchronously, in the same class of write as a GM command, and the pump
     * that follows sees a body that is simply up again. `enrolCasualties` is the
     * scheduler's own note that this class of between-pump change is expected.
     *
     * ═══ THE RULE LIVES IN ONE PLACE ═══
     * Which stages may respawn is `respawn`'s decision in engine/downed.ts, not
     * this file's: a copy of "Erased only, never Downed" written here is a copy
     * that will one day disagree with the one the log prints. This function maps
     * the typed refusal to a sentence and does nothing else with it — the same
     * division `submitRevive` above keeps with `ReviveRefusal`.
     *
     * ═══ THE REFUSAL IS FREE, AND THE MOVE HAPPENS SECOND ═══
     * `respawn` refuses an Up or Downed body without touching a single field, so
     * asking it first costs a refused sender nothing — no teleport, no clock
     * re-zeroed, no hp written. Only once it has said yes is the body walked to
     * a spawn tile, and `world.placeAtSpawn` is what guarantees that tile has no
     * living body already standing on it: an erased body does not block, so
     * something may well be parked on the one it fell on.
     */
    submitRespawn(actorId: string): IntentResult {
      const state = opts.downed;
      // No survival system wired in means nobody is ever Erased, so there is
      // nothing to come back from. Answered honestly rather than pretending.
      if (state === undefined) return refuse('this server has no survival system');

      const actor = world.getActor(actorId);
      if (actor === undefined) return refuse('no_actor');

      const result = respawn(state, actor);
      if (!result.ok) return refuse(respawnRefusalText(result.reason));

      // WHERE, not whether — and the answer is deliberately ignored. A level
      // with no free tile at all (which takes more than 761 players) leaves them
      // standing exactly where they fell: a worse spot, and still an enormous
      // improvement on being stranded. Turning that into a failure would refuse
      // the one verb a stuck player has, over the one detail they care least
      // about.
      world.placeAtSpawn(actorId);

      // The barrier is told a human is present, exactly as `submitIntent` would
      // have: somebody who just pressed a key is not Standing By, and a body
      // that came back excluded from the quorum is a body nobody ever waits for.
      barrier.noteCommand(actor);
      return OK;
    },

    /**
     * ═════════════════════════════════════════════════════════════════════════
     * WHO YOU ARE PLAYING WITH. The five party verbs, and the world check.
     * ═════════════════════════════════════════════════════════════════════════
     *
     * ═══ THE ONLY THING THIS FUNCTION DECIDES IS WHETHER THE TARGET IS REAL ═══
     * Every rule about parties — sizes, leadership, which offers are live, who
     * lands where afterwards — belongs to engine/party.ts, which is pure and
     * synchronous and has no idea what an actor is. What it cannot answer, and
     * what has to be answered before it is called, is whether `targetId` names a
     * living player rather than a husk, a corpse or sixty-four characters typed
     * into a devtools console. That is a question about the WORLD, so it is
     * answered here, once, and it is the whole of this function's authority.
     *
     * ═══ IT IS NOT AN INTENT, AND IT MUST NOT BE ═══
     * Party membership is not a turn action. It costs no energy, it cannot be
     * refused for being out of turn, and — the part that matters — it works
     * while you are Downed and while you are Erased, exactly as `say` does. A
     * player on the floor asking a friend to come and get them is precisely the
     * moment this verb exists for, and routing it through the barrier would let
     * the Bell time out a request for help.
     *
     * So it is applied SYNCHRONOUSLY between pumps, like `submitRespawn`, and
     * the pump that follows simply sees a barrier with a different membership.
     *
     * ═══ A REFUSAL COSTS ZERO ═══
     * Nothing is half-applied: no partial membership, no invite half-sent, no
     * leader badge left on somebody who was not removed. The atomicity is
     * engine/party.ts's (every operation checks before it writes), and this
     * function adds nothing that could break it.
     */
    submitParty(actorId: string, action: PartyAction, targetId?: string): PartyCommandResult {
      const parties = opts.parties;
      // No party table wired in means everybody is already exactly where they
      // would be — solo — so there is nothing here to change. Answered honestly
      // rather than pretending the command worked.
      if (parties === undefined) return refuseParty('this server has no party system');

      const actor = world.getActor(actorId);
      if (actor === undefined) return refuseParty('no_actor');

      // THE ONE WORLD CHECK. A target is required for invite and kick, refused
      // for leave (you can only leave your own party), and optional for accept
      // and decline — where it names WHICH offer, and its absence means the
      // oldest one, which is what a bare command has to mean.
      let target: Actor | undefined;
      if (targetId !== undefined) {
        const named = world.getActor(targetId);
        // A monster is not somebody to play with, and a body that is not in the
        // world at all is a forged id or a very stale click. Both are refused
        // in the same words: there is nobody there.
        if (named === undefined || named.kind !== 'player') {
          return refuseParty('there is nobody by that name here');
        }
        target = named;
      }

      const nowMs = now();
      const result = ((): PartyResult => {
        switch (action) {
          case PartyAction.Invite:
            return target === undefined
              ? { ok: false, reason: PartyRefusal.NotAMember }
              : inviteToParty(parties, actorId, target.id, nowMs);
          case PartyAction.Accept:
            return acceptInvite(parties, actorId, target?.id, nowMs);
          case PartyAction.Decline:
            return declineInvite(parties, actorId, target?.id, nowMs);
          case PartyAction.Leave:
            return leaveParty(parties, actorId);
          case PartyAction.Kick:
            return target === undefined
              ? { ok: false, reason: PartyRefusal.NotAMember }
              : kickFromParty(parties, actorId, target.id);
        }
      })();

      if (!result.ok) {
        return { ok: false, reason: partyRefusalText(result.reason, action) };
      }

      // ANY COMMAND CLEARS STANDING BY, exactly as `submitIntent` does: somebody
      // who just organised a party is at the keyboard, and a body that stayed
      // excluded from the quorum after joining one is a body nobody waits for.
      barrier.noteCommand(actor);

      return {
        ok: true,
        // Straight through from the engine. It is the union of BOTH parties,
        // captured before the change, because after an accept one of them no
        // longer exists to be asked about — which is exactly why the gateway
        // cannot work this out for itself.
        affected: result.affected,
        notice: partyNotice(action, actor, target),
      };
    },

    /**
     * THIS PLAYER'S PARTY, WITH THE WALL CLOCK ALREADY APPLIED.
     *
     * The subtraction to `expiresInMs` happens HERE because this file owns the
     * clock and neither engine/ nor view/ may read one — the same split
     * `bellMs` travels through. Undefined for a server with no party table,
     * which is what tells the gateway to send no pane at all rather than one
     * with an invented party of one in it.
     */
    partySnapshot(actorId: string): PartySnapshot | undefined {
      const parties = opts.parties;
      if (parties === undefined) return undefined;

      const party = partyOf(parties, actorId);
      const nowMs = now();

      return {
        leaderId: party.leaderId,
        members: [...party.members],
        invites: invitesFor(parties, actorId, nowMs).map((offer) => ({
          fromId: offer.fromId,
          expiresInMs: Math.max(0, offer.expiresAtMs - nowMs),
          // The size of the party being OFFERED, read from the invite's own
          // `partyId` rather than from the inviter's current one: the two are
          // the same thing today and would silently stop being so the moment an
          // inviter could leave between asking and being answered.
          size: parties.byId.get(offer.partyId)?.members.length ?? 0,
        })),
      };
    },

    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE TIDE — one game turn passes here because time passed, not because
     * somebody pressed a key.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * Takes no arguments and returns nothing, exactly like `bellExpired()` above
     * and for the identical reason: the socket layer fires it from a real timer
     * and must not have to thread time through. This adapter owns the clock; the
     * engine below stays a pure state transition.
     *
     * ═══ IT MARKS A DEBT AND THE NEXT PUMP PAYS IT ═══
     * `bellExpired` sets `pendingIntent` and lets the pump that follows resolve
     * and broadcast; this sets one flag and does the same. The alternative — a
     * second path that runs the base pass itself — would be a second copy of
     * "what happens when a turn passes", and the scheduler's own note is blunt
     * about what that costs: regen, effects, cooldowns and the downed countdown
     * must fire EXACTLY ONCE PER GAME TURN AT ANY SPEED, and "on the act clock a
     * hasted body would refill more often, which is a haste that shortens
     * cooldowns by another name."
     *
     * So there is one base pass, and this only decides that a turn is owed.
     *
     * ═══ WHY A FLAG AND NOT A STANDING PROPERTY OF THE LEVEL ═══
     * A level that free-ran on every pump would advance on player keystrokes
     * again — everyone's, this time — which is the exact thing the tide exists
     * to stop. The debt is cleared by the pump that pays it, so two tides
     * arriving before a pump still buy one turn rather than two.
     */
    tide(): void {
      owedTurn = true;
    },

    /**
     * ═══════════════════════════════════════════════════════════════════════
     * REST — ported from Player.lua:971-1075, with the heal taken out of the
     * check.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * ═══ IT IS THE TIDE'S MECHANISM WITH A DIFFERENT REASON ═══
     * A tide advances one game turn because TIME PASSED. A rest advances one
     * because the player ASKED. Both want exactly the same thing from the
     * engine — a base turn that happens without anybody spending energy — so
     * this drives `owedTurn` in a loop rather than inventing a second way to
     * make a turn go by. Regen, cooldowns, status durations and the downed
     * countdown all follow from that, once each, at any speed.
     *
     * ═══ BOUNDED, BECAUSE TURN RESOLUTION IS SYNCHRONOUS ═══
     * Upstream's rest can be interrupted by a keypress inside a Lua game loop.
     * Nothing here can: this call holds the realm until it returns. So
     * `REST_MAX_TURNS` is a liveness bound, and hitting it is reported rather
     * than hidden — a rest that ran two hundred turns without reaching Done has
     * found a state the rule does not describe, and saying so is the only honest
     * answer.
     */
    rest(actorId: string): RestResult {
      const self = world.getActor(actorId);
      if (self === undefined || !self.alive) return { turns: 0, stop: RestStop.Done };

      let turns = 0;
      for (;;) {
        const answer = restCheck(buildRestView(world, self, talents, opts.effects));
        if (!answer.rest) {
          return {
            turns,
            stop: answer.stop,
            ...(answer.threat == null ? {} : { threat: answer.threat }),
          };
        }
        if (turns >= REST_MAX_TURNS) return { turns, stop: RestStop.Budget };

        /**
         * THE BONUS IS PAID BEFORE THE TURN, not after, and it uses the count
         * SO FAR — so the first turn of a rest is worth exactly an ordinary
         * turn (`restBonus(0)` is 0) and the acceleration is something the rest
         * earns rather than something it starts with. Upstream does the same:
         * `cnt` is incremented after the check that reads it.
         */
        /**
         * ═══════════════════════════════════════════════════════════════════
         * THE WHOLE PARTY HEALS, NOT ONLY THE BODY THAT PRESSED THE KEY.
         * ═══════════════════════════════════════════════════════════════════
         *
         * `Player.lua:983-993` pays the bonus inside `restCheck` and pays it to
         * every member:
         *
         * ```lua
         * for act, def in pairs(game.party.members) do
         *   if game.level:hasEntity(act) and not act.dead then
         *     local perc = math.min(self.resting.cnt / 10, 8)
         *     act:heal(act.life_regen * perc)
         * ```
         *
         * OURS PAID ONLY `self`, and in a game built for three to six friends
         * that is the wrong half of the mechanic. The others were not frozen —
         * a rest pumps real turns, so `actBase` gave them their ordinary
         * trickle — they simply got 1x while the rester got up to the cap. Two
         * detectives sitting in the same room recovered at different rates for
         * no reason either of them could see.
         *
         * ═══ EACH MEMBER'S OWN REGEN AND OWN CONSTITUTION ═══
         * Upstream reads `act.life_regen` and calls `act:heal`, which applies
         * the RECEIVER's `healing_factor` (Actor.lua:2089) — so the shared thing
         * is the rest's ACCELERATION, not the amount. `healing-factor.test.ts`
         * already pins that a bandage is worth more on somebody built to
         * survive; this is the same rule at the rest's rate.
         *
         * ═══ THE GUARD IS UPSTREAM'S ═══
         * `hasEntity(act) and not act.dead` — same level, still up.
         * `world.allActors()` is this realm's actors, so the level half is
         * structural here; `alive` is the rest of it. A downed detective heals
         * nothing, which is what makes standing them up urgent.
         */
        const bonus = restBonus(turns);
        if (bonus > 0) {
          for (const member of world.allActors()) {
            if (member.kind !== ActorKind.Player || !member.alive) continue;
            // AND THE HEALING FACTOR, on `actBase`'s terms: this is the SAME
            // `life_regen` upstream multiplies by `healing_factor` at
            // Actor.lua:2055, just paid at the rest's accelerated rate. Without
            // it a rest and an ordinary turn would disagree about what
            // Constitution is worth, which is the kind of split nobody notices.
            /**
             * THE FULL-HEALTH GUARD COVERS THE HEAL ONLY, and putting it a line
             * higher was a real bug that a test caught: the pool payment below
             * sat inside it, so a body at full health got no acceleration at all
             * — which is the COMMON case, since a player who has healed up and
             * is still resting is resting for the pool.
             */
            if (member.hp < member.maxHp) {
              const factor = bound(
                healingFactor(member.combat ?? {}),
                HEAL_FACTOR_MIN,
                HEAL_FACTOR_MAX,
              );
              member.hp = Math.min(member.maxHp, member.hp + member.hpRegen * bonus * factor);
            }

            /**
             * ═══════════════════════════════════════════════════════════════
             * AND THE POOL, WHICH UPSTREAM ACCELERATES IN THE SAME BREATH.
             * ═══════════════════════════════════════════════════════════════
             *
             * `Player.lua:983-993` pays `incStamina`, `incMana` and `incPsi` at
             * the same `perc` as the heal, on the same members. Ours accelerated
             * hit points and nothing else — for anybody, including the rester.
             *
             * IT IS NOT A SMALL DIFFERENCE. `restCheck` keeps resting while a
             * pool can still rise, and Focus trickles at 0.4 a turn: filling
             * sixty points took a hundred and fifty turns of real game clock
             * against a `REST_MAX_TURNS` of two hundred, where upstream's cap
             * would take about nineteen. A rest for Focus was a rest that
             * nearly ran out of budget.
             *
             * ═══ AND IT IS A PORT, NOT A BALANCE CHANGE ═══
             * DECISIONS.md refuses WIL→pool at length, and the argument there is
             * about pool SIZE — *"ours is EARNED so a bigger pool is only more
             * banking"*. This is the TRICKLE, which three of our four pools
             * already have and which already runs every turn; resting only pays
             * it faster, exactly as it already does for hit points.
             */
            const trickle = talents.poolRegenOf?.(member) ?? 0;
            if (trickle > 0) talents.gainPool?.(member, trickle * bonus);
          }
        }

        /**
         * ═══════════════════════════════════════════════════════════════════
         * A REST IS N HOLDS. It is not a special way to make time pass.
         * ═══════════════════════════════════════════════════════════════════
         *
         * THIS WAS `owedTurn = true` — the tide's mechanism — AND THAT WAS
         * WRONG IN A WAY A TEST CAUGHT. `freeRuns` advances the clocks without
         * anybody deciding anything, so the resting body PARKED every turn; and
         * a parked actor stops the sweep for everything the world drives
         * (energy.ts: *"Someone ahead of us is parked, so the world is frozen
         * for everything the world drives"*). Thirty-nine turns of rest went by
         * with a husk fourteen tiles away NEVER TAKING A STEP.
         *
         * That is a rest that heals you in a frozen world, which is a cheat and
         * not a port. Upstream's rest passes REAL turns — that is the entire
         * reason `restCheck` re-scans for hostiles on each one.
         *
         * `HOLD_INTENT` directly, exactly as `bellExpired` hands it to a
         * straggler, rather than through `hold()`: the barrier has already been
         * consulted (`handleRest` refuses in combat) and a refusal here would
         * leave the loop with a turn it asked for and did not get.
         */
        const beforeTurn = world.turn.clock.gameTurn;
        self.pendingIntent = HOLD_INTENT;
        const outcome = api.pump();

        /**
         * ═══════════════════════════════════════════════════════════════════
         * ANYTHING LANDED A HIT — Player.lua:722-724, `onTakeHit`.
         * ═══════════════════════════════════════════════════════════════════
         *
         * READ OFF THE EVENTS RATHER THAN OFF THE HIT POINTS. A body being
         * chewed on is also regenerating, and at the rest's accelerated rate
         * the regen usually WINS — so `hp` after the pump is often higher than
         * before it and a net comparison would miss the blow entirely. The
         * events say what happened; the hit points say who is winning.
         *
         * `healed` MARKS THE OTHER DIRECTION. A heal rides the same
         * `DamageEvent` (see its docblock: one frame kind for "an actor's hp
         * changed"), so a teammate mending the rester mid-rest would otherwise
         * read as a hit and end the rest that was doing them good.
         */
        const hurt = (event: TurnEvent): boolean =>
          event.k === 'damage' && event.id === actorId && event.healed === undefined;
        if (outcome.playerEvents.some(hurt) || outcome.sweep.some(hurt)) {
          turns += 1;
          return { turns, stop: RestStop.Hurt };
        }

        /**
         * THE CLOCK IS THE PROOF THE TURN HAPPENED, and checking it is what
         * makes this loop safe. Anything that leaves the body unable to act —
         * a stun, a barrier that closed, a state nothing here anticipated —
         * would otherwise spin two hundred times doing nothing. It is reported
         * as `Budget` because that is what it is: the loop stopped because it
         * could not make progress, and the player is told so.
         */
        if (world.turn.clock.gameTurn === beforeTurn) return { turns, stop: RestStop.Budget };
        turns += 1;

        // A REST THE WORLD ENDED. Dying mid-rest, or being reaped, must not keep
        // asking a body that is no longer there whether it feels better.
        const still = world.getActor(actorId);
        if (still === undefined || !still.alive) return { turns, stop: RestStop.Bleeding };
      }
    },

    bellExpired(): void {
      const level = levelOf(world);
      const nowMs = now();
      // ONE TIMER, EVERY PARTY. The gateway holds a single wall-clock timer for
      // the soonest deadline and re-enters here when it fires; each party's
      // `expire` checks its own deadline and answers with nothing when that
      // party still has time. So a party whose Bell has not run out is never
      // rung early, and one whose Bell rang while another party's was still
      // counting is not forgotten — the pump that follows reports the next
      // deadline and the timer is re-armed for it.
      for (const scope of allScopes()) {
        const passes = barrier.expire(playersOf(world), level, nowMs, scope);
        // The barrier decides WHO was too slow; installing the hold is the
        // caller's job, because the barrier does not know what an intent is and
        // deliberately must not learn.
        //
        // A forced pass is ALWAYS a hold — never a random attack. A stray attack
        // on a timeout gets somebody killed and ends friendships.
        for (const pass of passes) {
          const actor = world.getActor(pass.id);
          if (actor !== undefined && actor.alive) actor.pendingIntent = HOLD_INTENT;
        }
      }
    },

    pump(): ReapingPumpResult {
      /**
       * ═══════════════════════════════════════════════════════════════════════
       * THE CLOSURE `PumpCtx.onLevelUp` HAS BEEN WAITING FOR.
       * ═══════════════════════════════════════════════════════════════════════
       *
       * Built HERE, per pump, rather than once at construction, because the list
       * is the pump's own answer and a shared array would leak one pump's levels
       * into the next one's frame. Same shape as `wipes` and `refusals` below:
       * the scheduler states the fact, this file collects it, the gateway says it
       * in words.
       *
       * THE SCHEDULER CALLS THIS FROM THE BASE-CLOCK PASS, once per level
       * crossed, in order — so pushing is the whole implementation and the order
       * is already the order a player lived it.
       */
      const levelUps: LevelUpNote[] = [];

      /**
       * WHAT THE STATUS SYSTEM WANTED TO SAY THIS PUMP. See `drainStatusLog`
       * below — declared here, out here with `levelUps`, because both are
       * buffers the ctx writes into and the pump reads back out.
       */
      const statusNotes: EffectLogLine[] = [];
      // WHAT A STATUS DID TO A BODY THIS PUMP — the damage, and whether it
      // finished them. The same buffer shape and lifetime as `statusNotes`
      // beside it — written by the `EffectCtx`, spliced empty by the pump —
      // because it is the same problem: the effect system knows something the
      // scheduler has to act on and must not reach into the world to act on it
      // itself. See `PumpCtx.drainHits`.
      const statusHits: StatusHit[] = [];

      /**
       * ═══════════════════════════════════════════════════════════════════════
       * ONE `EffectCtx`, SHARED BY THE CLOCK AND THE DOOR.
       * ═══════════════════════════════════════════════════════════════════════
       *
       * `PumpCtx.statusPass`'s docblock names this adapter as the only thing
       * that holds all three of the effect state, the world rng and the talent
       * book. It holds them for the door as well, and both closures must be cut
       * from the same context — a second `EffectCtx` would have a second `log`,
       * and a note written into a buffer nobody drains is a status that happens
       * silently.
       *
       * `undefined` when there is no table, which is what keeps every fixture
       * built before M4 on the M3 path exactly.
       */
      const statusCtx =
        opts.effects === undefined
          ? undefined
          : {
              state: opts.effects,
              ctx: {
                getActor: (id: string) => world.getActor(id),
                /**
                 * IDS, AND THE BOOK WANTS THE BODY. `TalentBook.loadoutOf`
                 * takes an actor and returns `LoadoutTalent` rows; STUNNED's
                 * three-talent lockout wants ids. Both conversions happen here
                 * rather than either side widening its contract for the other.
                 */
                activatableTalents: (id: string): readonly string[] => {
                  const body = world.getActor(id);
                  if (body === undefined) return [];
                  return (opts.talents?.loadoutOf(body) ?? []).map((talent) => talent.id);
                },
                log: (line: EffectLogLine): void => {
                  statusNotes.push(line);
                },
                // A CONTRIBUTING EFFECT LANDED OR LEFT, so this body needs its
                // sheet rebuilt from base. See EffectCtx.sheetDirty: only the
                // layer holding the item catalogue can do that, and it is not
                // this one either — main.ts passes the capability in.
                sheetDirty: opts.onSheetDirty,
                /**
                 * WHAT A BLEED DID. The return from `applyDamage` used to be
                 * discarded, which cost two things: the damage LINE (ours is
                 * derived from an action outcome, and a bleed produces none) and
                 * the BURIAL (`alive` false, still on its tile forever, unpaid).
                 * `resolveStatusHits` is the far end of this.
                 */
                noteDamage: (hit: StatusHit): void => {
                  statusHits.push(hit);
                },
              },
            };

      // `downed` is threaded in rather than created here because a five-turn
      // countdown has to survive the pump that ticks it — see the option's note.
      // Undefined switches every survival branch in the scheduler off, which is
      // the M3 behaviour exactly.
      const result = pump(world, {
        onLevelUp: (actorId: string, level: number): void => {
          levelUps.push({ id: actorId, level });
        },
        nowMs: now(),
        barrier,
        // See `tide()`. Read here and cleared below, so the debt is paid by
        // exactly one pump however many tides arrived before it.
        freeRuns: owedTurn,
        downed: opts.downed,
        // Threaded in for the same reason `downed` is: party membership lives
        // across pumps, and it is what makes the barrier and the wipe per-party
        // inside the tick loop rather than only at the frames around it.
        parties: opts.parties,
        // ...and the talent seam, for the third time and the same reason: the
        // sheets live across pumps. Absent switches every talent branch in the
        // scheduler off, which is the M3 behaviour exactly.
        talents: opts.talentRuntime,
        // ═══ THE LOOT SEAM. UNCONDITIONAL, UNLIKE THE THREE ABOVE. ═══
        // The other seams are threaded from `opts` because each owns state that
        // must outlive a pump — a countdown, a party table, a talent sheet. This
        // one owns nothing: `spillOrderOf` is a pure function of the body it is
        // handed, so there is no instance to keep and nothing for a caller to
        // supply. Every `createTurnEngine` gets it, which is what makes a drop
        // reach the floor on the production path rather than only in a test that
        // remembered to wire it up.
        loot: { spillOrder: spillOrderOf },
        /**
         * ═══════════════════════════════════════════════════════════════════
         * THE STATUS SEAM, WHICH HAS NEVER BEEN FILLED ON ANY PATH.
         * ═══════════════════════════════════════════════════════════════════
         * `PumpCtx.statusPass` documents this exact construction and says
         * "the adapter in turn-engine.ts is the only thing that holds all
         * three" — and then no adapter ever built one. Nor did `main.ts`
         * create an `EffectState` to hold. So Stunned, Bleeding and Slowed,
         * their typed saves and their partial-save duration scaling — a core
         * MVP subsystem with 115 test references — were unreachable in the
         * running game.
         *
         * ABSENT STAYS ABSENT: without an `EffectState` this is undefined and
         * `actBase` behaves exactly as it did at M3, which is what every
         * existing fixture expects.
         */
        statusPass:
          statusCtx === undefined
            ? undefined
            : statusPass(statusCtx.state, world.rng, statusCtx.ctx),
        /**
         * THE DOOR, from the same `EffectCtx` as the clock above — which is the
         * whole reason they are built together rather than wherever each is
         * first needed. A monster's rider inflicted through here writes its note
         * into the SAME buffer `drainStatusLog` empties, so "Dalt is Bleeding 2
         * turn(s), not 3" lands on that monster's sweep step, under the blow
         * that caused it. Two contexts would put the note in the wrong turn.
         */
        applyStatus:
          statusCtx === undefined
            ? undefined
            : statusApplier(statusCtx.state, world.rng, statusCtx.ctx),
        /**
         * AND THE HALF THAT REACHES A PLAYER'S EYES.
         *
         * `statusPass` alone makes statuses REAL; this makes them VISIBLE. The
         * partial save — "Dalt saves (phys 38 vs power 31, 68%) — Slowed 1
         * turn, not 3" — is the single line game-design.md § 7 puts in its
         * sample Record to explain the whole subsystem, and without a drain it
         * is computed correctly and then discarded.
         *
         * A DRAIN AND NOT A CALLBACK, for the reason `PumpCtx.drainStatusLog`
         * gives: a push from inside the effect system would close whatever
         * event batch happened to be open and split one sweep into several.
         * The buffer is per-pump — declared beside the call, spliced empty by
         * whoever asks — so a note can never survive into the turn after the
         * one that produced it.
         */
        drainStatusLog: () => statusNotes.splice(0, statusNotes.length),
        // AND THE SAME DRAIN FOR THE BLOWS. Spliced rather than read, so a hit
        // is narrated exactly once and a kill acted on exactly once, and neither
        // can survive into the turn after the one that caused it.
        drainHits: () => statusHits.splice(0, statusHits.length),
        /**
         * ═══════════════════════════════════════════════════════════════════
         * THE SECOND QUESTION `checkStillInCombat` ASKS — see `stillFighting`.
         * ═══════════════════════════════════════════════════════════════════
         *
         * `tome/class/Actor.lua:7658-7662`. A detrimental effect that is still
         * counting down means the fight is not over, and the scheduler could not
         * ask that on its own: `PumpCtx` deliberately hands it closures rather
         * than the effect table, exactly as `applyStatus` above does.
         *
         * READS THE DEFINITION, NOT THE INSTANCE, for `status` and `decrease` —
         * both are properties of the effect rather than of one application, and
         * `effectDef` is the one lookup that turns an id into it.
         */
        stillFighting:
          opts.effects === undefined
            ? undefined
            : (actorId: string): boolean =>
                effectsOn(opts.effects as EffectState, actorId).some((live) => {
                  const def = effectDef(opts.effects as EffectState, live.effectId);
                  return def?.status === EffectStatus.Detrimental && def.decrease > 0;
                }),
      });
      /**
       * THE DEBT IS SPENT, whatever the pump made of it.
       *
       * Cleared HERE rather than inside the ctx literal, because a throw between
       * the two would leave a realm free-running for every later pump — the
       * gateway wraps `pump()` in a try/catch precisely because it can throw, and
       * "the world did not advance" must not also mean "and now it never stops".
       */
      owedTurn = false;

      /**
       * ═══════════════════════════════════════════════════════════════════════
       * WHICH BODY EACH ENROLLED id NAMED, CAPTURED BEFORE THE FLOOR CAN MOVE.
       * ═══════════════════════════════════════════════════════════════════════
       *
       * ═══ THE BUG THIS EXISTS TO CLOSE — VERIFIED BY RUNNING IT ═══
       * The caller drains `reaped` by BARE ID after this method returns. On a
       * pump where a monster died AND the party wiped, `resetFloor` below has
       * already buried every monster and `reseedFloor` has already re-minted the
       * encounter with STABLE IDS (`mon_<template.id>`, content/encounter.ts).
       * So by the time the gateway calls `reap('mon_index_husk')` the id names a
       * BRAND NEW, FULL-HEALTH husk — and `reap` finds it, passes its
       * `kind === 'monster'` guard, and deletes it. The gateway's own comment
       * asserted the opposite ("False means the body was already gone"); `reap`
       * answered TRUE. The resync immediately after then faithfully shipped a
       * reset floor that was permanently one monster short, and every later
       * wipe-with-a-kill drained one more. From inside the game: "the husk just
       * didn't come back."
       *
       * ═══ IDENTITY, NOT PRESENCE ═══
       * `world.getActor(id) === body` is the whole test, and it has to be the
       * OBJECT and not merely "is something there", because the re-seeded body
       * answers to the same string. An id that resolves to `undefined` after the
       * reset is kept: `resetFloor` buried it, `reap` will answer false, and the
       * `left` frame is still true of the body that died.
       *
       * ═══ WHY HERE AND NOT INSIDE `resetFloor` ═══
       * `resetFloor` runs once per wiping PARTY and reaps every monster on the
       * floor — it cannot tell which of those ids the scheduler enrolled, and
       * clearing the whole list there would also drop the bodies a surviving
       * party legitimately killed in the same pump. The identity check answers
       * both cases with one rule.
       */
      const enrolled = result.reaped.map((id) => [id, world.getActor(id)] as const);

      // ═════════════════════════════════════════════════════════════════════
      // THE OTHER HALF OF A FLOOR RESET, AND IT HAPPENS HERE — FIRST.
      // ═════════════════════════════════════════════════════════════════════
      //
      // BEFORE the events are translated, before a frame goes out, before the
      // state resync, before the save. `resetFloorParty` has already stood the
      // party up IN PLACE, which means that at this instant they are alive, at
      // full hp, and standing exactly where the thing that killed them is still
      // standing. Nothing may act in between — and nothing can, because turn
      // resolution is synchronous all the way up: there is no suspension point
      // between `pump` returning and this line for another socket's frame, a
      // Bell timer or another party's command to interleave at.
      //
      // Do this after the broadcast and the loop simply comes back with more
      // steps: the clients would be told the floor reset, and the next pump
      // would find the party still in the fight. Read `resetFloor`'s header.
      const wipes: { readonly partyId: string; readonly restored: readonly string[] }[] = [];
      for (const event of result.events) {
        if (event.t !== 'party_wipe') continue;
        wipes.push({ partyId: event.partyId, restored: event.restored });
      }

      /**
       * ═════════════════════════════════════════════════════════════════════
       * A RESET MOVED THEM, SO THE RESULT HAS TO SAY IT MOVED THEM.
       * ═════════════════════════════════════════════════════════════════════
       *
       * `PumpResult.displaced` means "who was moved without asking to be", and
       * `net/` uses it for exactly one thing: a body it names, standing on a
       * spawn tile, has its session's `exitArmed` cleared — "SOMEBODY ELSE PUT
       * THEM ON THE DOORSTEP. THAT IS NOT A DECISION TO LEAVE."
       *
       * A floor reset is the purest case of that and never populated the field,
       * which was filled only by `swapped`. So `placeAtSpawn` put every restored
       * body on the delve's spawn cluster — the same tiles `leaveRealm` reads as
       * the way out — with the exit still armed, and the tail of `handleMove`
       * walked whoever's command resolved the wipe straight out of the delve.
       *
       * MEASURED: nine two-player runs, 9/9 identical — one player ends on the
       * moor, the rest are left inside, and nobody pressed anything. The control
       * that isolates it: replay the same wipe with `hold` as the closing
       * command and 0/2 are ejected, because it is the tail of `handleMove` that
       * runs `leaveRealm`.
       */
      const resetMoved = new Set<string>();

      for (const wipe of wipes) {
        resetFloor(world, wipe.restored, reseedFloor, log, reap, opts.effects);
        for (const id of wipe.restored) resetMoved.add(id);

        // THE CHURN ALARM. See `lastWipeTurn` and `WIPE_CHURN_TURNS`: a party
        // that wipes again this close to its last wipe never got out of the
        // fight, so the reset above is not doing its job and somebody has to be
        // told in words rather than left to read a Case Log that looks tidy.
        const previous = lastWipeTurn.get(wipe.partyId);
        if (previous !== undefined && result.gameTurn - previous <= WIPE_CHURN_TURNS) {
          log.error(
            { partyId: wipe.partyId, gameTurn: result.gameTurn, previousWipeTurn: previous },
            'party wiped again within two turns — the floor reset is not separating them from what killed them',
          );
        }
        lastWipeTurn.set(wipe.partyId, result.gameTurn);
      }

      // Split the one event list into the two lanes the gateway broadcasts.
      // `sweep` events carry the whole monster turn as a single batch — that is
      // why the client can render one settling pass instead of N pop-ins.
      //
      // ═══ A WIPE GOES IN THE LANE IT HAPPENED IN ═══
      // The player lane is broadcast and narrated FIRST, so an event that landed
      // during the monster turn must not be filed under it. A wipe caused by a
      // monster's blow used to be, and the Case Log read:
      //
      //     Ren is erased — the party is down. The floor resets.
      //     Index Wraith hits Ren.  3 damage.
      //     Ren is DOWN — 5 turns to reach them.
      //
      // The reset announced two lines before the blow that caused it. A log that
      // misreports causality costs an evening of debugging the wrong thing, so
      // the engine stamps the lane on the event (`duringSweep`) and this is
      // where it is honoured. Everything else keeps the old rule exactly.
      const sweepEvents: GameEvent[] = [];
      const playerEvents: GameEvent[] = [];
      for (const event of result.events) {
        const swept = event.t === 'sweep' || (event.t === 'party_wipe' && event.duringSweep);
        if (swept) sweepEvents.push(event);
        else playerEvents.push(event);
      }

      // ═══ THE ONE BOOKKEEPING EVENT THAT HAS TO ESCAPE THIS FILE ═══
      // `toWireEvents` drops `refunded` and should keep dropping it: a refund
      // has nothing to draw and it is nobody's business but the owner's. But it
      // is also the ONLY record that a submitted intent did not happen, and the
      // refund path spends no energy — so no clock moves, `turnKey` is unchanged
      // and the gateway's turn frame is suppressed as a duplicate. Drop it here
      // as well and the actor that owes the turn is told literally nothing.
      // See `PumpResult.refusals`; the gateway unicasts these to their owners.
      const refusals: { readonly id: string; readonly reason: string }[] = [];
      for (const event of result.events) {
        if (event.t === 'refunded') refusals.push({ id: event.id, reason: event.reason });
      }

      /**
       * ═══════════════════════════════════════════════════════════════════════
       * THE SAVES, AS SENTENCES. Assembled here for `refusals`' exact reason.
       * ═══════════════════════════════════════════════════════════════════════
       *
       * `toWireEvents` maps `negated`, `resisted` and `immune` to NOTHING, and
       * it is right to: they mean nothing landed, so there is no badge to pop
       * and no duration to time. But they are the only evidence a save ever
       * works, and four docblocks in this codebase — `EffectView`,
       * `statusToWire`, `PumpCtx.statusPass` and `docs/game-design.md` § 11 —
       * promise they reach the Record lane in words. None of them did.
       *
       * BUILT HERE BECAUSE THIS IS WHERE THE NAMES ARE. The sentence needs the
       * body's name (`world`) and the effect's display name (`opts.effects`),
       * and the gateway has neither — it may not import the effect registry at
       * all. It receives finished text and broadcasts it, exactly as it does
       * with the refusals below.
       */
      const saves = saveLines(world, opts.effects, result.events);

      return {
        status: result.status,
        turn: turnState(),
        playerEvents: toWireEvents(world, playerEvents, 'player'),
        sweep: toWireEvents(world, sweepEvents, 'sweep'),
        refusals,
        ...(saves.length === 0 ? {} : { saves }),
        // ═══ AND WHO WAS MOVED WITHOUT ASKING TO BE ═══
        // Straight through, for the same reason `refusals` is assembled just
        // above: the wire cannot carry it. Two `moved` events say where both
        // bodies ended up and look identical whoever caused them, and net/ keeps
        // one rule that turns on HOW a body arrived somewhere rather than where
        // it is. See `PumpResult.displaced` in engine/scheduler.ts.
        // ═══ PLUS ANYONE A FLOOR RESET PICKED UP AND PUT DOWN ═══
        // `result.displaced` is the scheduler's own list and carries swaps only.
        // A reset is displacement by the same definition, and net/ cannot tell
        // the two apart from `moved` events — see the note on the wipe loop.
        displaced:
          resetMoved.size === 0
            ? result.displaced
            : [...new Set([...(result.displaced ?? []), ...resetMoved])],
        // ═══ STRAIGHT THROUGH, AND STILL IN THE WORLD — EXCEPT THE ONES A
        // FLOOR RESET ALREADY REPLACED ═══
        // The bodies are named, not buried. The caller reaps them AFTER it has
        // broadcast the record and BEFORE the resync — see `reap`, and
        // `PumpResult.reaped` in engine/scheduler.ts for what breaks if the
        // deletion happens any earlier.
        //
        // The filter is the identity check taken above: an id whose body was
        // replaced by `reseedFloor` in this same pump names a LIVING monster
        // now, and forwarding it would have the caller delete the fresh one.
        // Read `enrolled`'s note — this was reproduced end to end.
        reaped: enrolled
          .filter(([id, body]) => body === undefined || world.getActor(id) === body)
          .map(([id]) => id),
        // NOT FILTERED AGAINST THE WORLD, unlike `reaped` directly above. A level
        // was reached; that stays true of a body that has since been erased by a
        // wipe on this same pump, and the Record lane re-resolves the name
        // through `world.getActor` with `reapedNames` behind it anyway.
        levelUps,
      };
    },

    reap,

    turnState,
  };
  return api;
}
