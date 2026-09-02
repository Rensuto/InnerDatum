/**
 * ═══════════════════════════════════════════════════════════════════════════
 *                      DOWNED → REVIVE → ERASED → THE WIPE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * game-design.md § 9 calls this "the mechanic that does more for co-op tension
 * than anything else", and the reason is one sentence: it turns *"I died"* into
 * *"GET TO ME"*. A player at 0 HP is not removed and is not dead. They are
 * **Unfiled** — prone on the tile they fell on, out of the quorum, unable to
 * act, wearing a five-turn countdown that everybody can see. Any ally who
 * reaches them picks them up. Nobody sits watching for 25 minutes.
 *
 * Three stages, and the words matter because they are what the log prints:
 *
 *   UP        conscious. `alive === true` and no record in this table.
 *   DOWNED    0 HP, five game turns on the clock, revivable.
 *   ERASED    the countdown ran out. Still on the map, no longer revivable.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * M4 SHIPS NO PERMADEATH. A PARTY WIPE RESETS THE FLOOR. DO NOT ADD ONE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * When every player is Downed or Erased the party is wiped, and a wipe **puts
 * the party back on their feet and restarts the floor** (game-design.md § 9:
 * *"MVP: the floor resets and the party restarts it. No permadeath, no loss."*).
 * `resetFloorParty` below is that restoration and it is deliberately total: full
 * HP, alive, both clocks re-zeroed.
 *
 * Sworn/Unsworn permadeath is **M7 and opt-in per character**, and § 9 is
 * explicit about the ordering: *"nobody is offered Sworn until session three, so
 * the first permadeath is a choice someone makes after understanding the game
 * rather than a rule imposed before"*, and *"before any Sworn character exists,
 * the GM `restore <charId> <snapshotTs>` drill must be written and tested once
 * with a throwaway"*. So: no `erasePermanently`, no `world.removePlayer` on a
 * wipe, no flag that skips the restoration. If you are here to add one, the
 * restore drill does not exist yet and you will lose somebody's character.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * `alive === false` IS WHAT MAKES A DOWNED BODY BEHAVE, AND IT IS FREE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `EngineActor.alive` already means *"is this body taking turns?"* rather than
 * *"is this body a corpse"* — engine/actor.ts says so: *"THE BODY IS NOT
 * REMOVED: it stops being ticked, stops blocking movement, but stays in the
 * actor table"*. Downed reuses it, and every rule that has to hold falls out of
 * one field with no second predicate to keep in sync:
 *
 *   barrier.ts `inQuorum`   → `actor.alive` ⇒ out of the quorum, and out of the
 *                             DENOMINATOR, so the Bell fires for the survivors
 *                             at their real party size instead of waiting on a
 *                             body. **This is why the Bell suddenly matters.**
 *   scheduler `submitIntent` → refuses ⇒ cannot act.
 *   scheduler `anyContact` / `visibleEnemies` → skips ⇒ monsters stop targeting
 *                             a body and go for whoever is still standing.
 *   world.ts `actorAt`       → skips ⇒ prone, does not block the tile, so a
 *                             rescuer can stand on top of you in a doorway.
 *   damage.ts `applyDamage`  → returns 0 ⇒ a downed body cannot be corpse-camped
 *                             to death, which would make the countdown a lie.
 *                             THE GUARD IS damage.ts:589, `if (!target.alive ||
 *                             resolved.amount <= 0) return empty;`. This row read
 *                             `actor.ts applyDamage` until the scheduler moved
 *                             onto the real pipeline and that function was
 *                             deleted; a reader who greps actor.ts for it now
 *                             finds only a tombstone.
 *   actor.ts `actBase`       → returns early ⇒ no regeneration, no status ticks
 *                             and NO COOLDOWN TICKS while down. The wound you
 *                             fell with is the wound you get up with, and a
 *                             talent that was cooling is still cooling — being
 *                             on the floor costs you progress, which is exactly
 *                             the argument tome/class/Actor.lua:606 makes for a stun.
 *
 * The one thing that does NOT fall out is the countdown itself, because
 * `tickLevel`'s `isActive` gate skips a non-alive actor entirely. The scheduler
 * therefore widens `isActive` to *"alive, or a player who has not been Erased"*
 * — see the note there. That phrasing rather than *"has a record"* is what makes
 * the system self-healing: a body taken to 0 by a path that never reported it is
 * still ticked, and the base pass ENROLS it. An ERASED body drops out and stops
 * being ticked at all, which is what makes the erased state cheap.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * A BODY NOBODY IS DRIVING IS NOT A SURVIVOR
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Reported from real co-op play, and it stranded somebody: a friend closed the
 * activity, their body stayed in the world (M2, deliberately — a dropped socket
 * must not yank someone out of a fight), and `surveyParty` counted that body as
 * `Up`. So `up.length !== 0`, THE WIPE NEVER FIRED, and the player who actually
 * went down sat Downed, then Erased, forever: no floor reset, no way back, and
 * nothing failing anywhere.
 *
 * The fix is one word in the predicate — the wipe asks *"is anyone left who can
 * save the party"*, and a disconnected or Standing-By body cannot revive anyone,
 * cannot act, and cannot answer. `surveyParty` therefore takes an `isPresent`
 * PREDICATE and reports `survivors` separately from `up`.
 *
 * TWO THINGS THAT MUST NOT DRIFT WHILE READING THAT:
 *
 *   A GHOST IS NOT DOWNED. A disconnected body is conscious, at whatever hp it
 *   was on, and its owner may walk back in ten minutes to find it exactly there.
 *   It stays in `up`; it is only missing from `survivors`. Filing it under
 *   `downed` would put a countdown on a healthy body and make `resetFloorParty`
 *   rewrite hp its owner never lost.
 *
 *   AN EMPTY LEVEL IS STILL NOT A WIPE. The `downed + erased > 0` clause is what
 *   keeps a freshly booted server from resetting a floor nobody is standing on,
 *   and it is untouched by any of this.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * TURNS, NOT MILLISECONDS. THERE IS NO TIMER IN THIS FILE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The countdown is decremented exactly once per game turn per body, from the
 * scheduler's `actBase` pass on the BASE clock (tome/class/Actor.lua:476-609,
 * GameEnergyBased.lua:114-121). Nothing here reads `globalSpeed`, `speedFactor`
 * or a wall clock — a hasted monster must not be able to run out your friend's
 * five turns, and `setTimeout` does not exist in src/server/engine/** at all.
 *
 * SYNCHRONOUS AND DETERMINISTIC. No I/O, no clock, no randomness: the five turns
 * are five turns, and a revive is arithmetic. `src/server/engine/**` carries the
 * six anti-async AST selectors plus the `Date.now`/`Math.random` bans.
 *
 * SIDE TABLE, KEYED BY ID — the same argument engine/talents.ts and
 * engine/effects.ts make for theirs. Nothing here is duplicated state: `alive`,
 * `hp` and `sprite` live on the actor and are written THROUGH this module, and
 * `forgetActor` is called from the one place actors leave the world.
 */

import { chebyshev } from '../../shared/coords.ts';
import { ActorKind } from '../../shared/protocol.ts';
import type { EngineActor } from './actor.ts';

// ---------------------------------------------------------------------------
// The three stages
// ---------------------------------------------------------------------------

/**
 * Which stage a body is in. Object + union rather than an `enum`, because
 * `erasableSyntaxOnly` is on and Node type-strips this file to run it.
 */
export const Survival = {
  /** Conscious. No record in the table at all — the common case is free. */
  Up: 'up',
  /** 0 HP, counting down, revivable. game-design.md § 9 calls this *Unfiled*. */
  Downed: 'downed',
  /** The countdown ran out. Still on the map; only a floor reset brings them back. */
  Erased: 'erased',
} as const;
export type Survival = (typeof Survival)[keyof typeof Survival];

// ---------------------------------------------------------------------------
// The numbers, and where each one comes from
// ---------------------------------------------------------------------------

/**
 * game-design.md § 9: *"Downed at 0 HP — not dead, Unfiled. Prone, **5-turn
 * timer**."*
 *
 * Five is long enough to cross a 30×30 room under fire and short enough that
 * ignoring it is a decision rather than an oversight. It is denominated in GAME
 * TURNS on the base clock, so haste cannot shorten it and a slow cannot extend
 * it — the same invariant cooldowns and status durations carry.
 */
export const DOWNED_TURNS = 5;

/** game-design.md § 9: *"restore you at **25% HP**"*. Enough to matter, not enough to tank. */
export const REVIVE_HP_FRACTION = 0.25;

/**
 * game-design.md § 9: *"Any ally reaching you **spends 4 AP** to restore you"*.
 *
 * CARRIED AS DATA, NOT SPENT HERE. The AP budget lives on the talent sheet
 * (engine/talents.ts `TalentSheet.ap`) and this module has no access to it by
 * design — the engine-level cost of a revive is the whole TURN, which the
 * scheduler charges through `spendTurn` exactly as it charges a move or a blow.
 * The day revive becomes an AP-priced action rather than a turn-priced one, this
 * is the number it reads.
 */
export const REVIVE_AP = 4;

/**
 * CHEBYSHEV reach — the Moore neighbourhood, and 0 (standing on the body) counts.
 *
 * The same metric `attackRange` and bump-attack use, deliberately: *"any ally
 * **reaching** you"* has to mean the same thing as "any monster reaching you",
 * or a rescuer ends up in a tile from which they can be hit but cannot help.
 * Euclidean is the metric for RANGE (combat.ts's two-metrics note); adjacency is
 * Chebyshev, and a diagonal genuinely is adjacent.
 */
export const REVIVE_REACH = 1;

/**
 * The art on disk is `chr_player_<class>_downed_s.png` (32×24), against
 * `chr_player_<class>_s.png` for a body on its feet. `ClassDef.downedSprite`
 * (content/classes.ts) names all three; this derives the same key from the
 * standing one so that the ENGINE never has to import the content layer.
 *
 * test/server/downed.test.ts proves the derivation against all three authored
 * `downedSprite` values, so the convention cannot silently drift apart from the
 * files that actually exist.
 */
export const DOWNED_SPRITE_INFIX = '_downed';
const SPRITE_FACING_SUFFIX = '_s';

/**
 * The 32×32 overlays drawn over the body. Two keys, because the stages have to
 * be told apart at a glance across a room: one says *run*, the other says
 * *it is over, regroup*.
 */
export const DownedMarker = {
  Downed: 'ui_marker_downed',
  Erased: 'ui_marker_erased',
} as const;
export type DownedMarker = (typeof DownedMarker)[keyof typeof DownedMarker];

/** `chr_player_watchman_s` → `chr_player_watchman_downed_s`. Idempotent. */
export function downedSpriteFor(sprite: string): string {
  if (sprite.includes(DOWNED_SPRITE_INFIX)) return sprite;
  if (sprite.endsWith(SPRITE_FACING_SUFFIX)) {
    const stem = sprite.slice(0, sprite.length - SPRITE_FACING_SUFFIX.length);
    return `${stem}${DOWNED_SPRITE_INFIX}${SPRITE_FACING_SUFFIX}`;
  }
  return `${sprite}${DOWNED_SPRITE_INFIX}`;
}

// ---------------------------------------------------------------------------
// The actor, as the survival system sees it
// ---------------------------------------------------------------------------

/**
 * STRUCTURAL, exactly like combat.ts's `CombatActor`, talents.ts's
 * `TalentActor` and effects.ts's `EffectActor`, and for the same reason: a live
 * `EngineActor` and a six-line test fixture must both be valid inputs.
 *
 * Mutable exactly where this module writes: `alive`, `hp`, `sprite`, the two
 * clocks and `pendingIntent`. Those six fields ARE the down/revive transition;
 * everything else about the actor is somebody else's business.
 *
 * `pendingIntent` is `object | null` rather than `Intent | null` — the same
 * trick barrier.ts plays. This module must be able to CLEAR a decision (a body
 * on the floor holds none) without learning what an intent looks like.
 */
export type DownedActor = {
  readonly id: string;
  readonly kind: ActorKind;
  readonly x: number;
  readonly y: number;
  hp: number;
  readonly maxHp: number;
  alive: boolean;
  /** An asset key, never a path. Swapped for the `_downed_s` variant and back. */
  sprite: string;
  pendingIntent: object | null;
  /** THE ACT CLOCK. Re-zeroed by a floor reset so the party lands phase-locked. */
  energy: number;
  /** THE BASE CLOCK. Same. */
  energyBase: number;
};

/**
 * Compile-time proof that the real actor is a valid input. If a field is renamed
 * on either side this fails HERE, naming both types, rather than at a call site
 * in the scheduler with an error pointing at the wrong module.
 */
const _actorShapeCheck = (actor: EngineActor): DownedActor => actor;

// ---------------------------------------------------------------------------
// The record and the table
// ---------------------------------------------------------------------------

export type DownedRecord = {
  /** Never `Up` — an `Up` body has no record. */
  status: typeof Survival.Downed | typeof Survival.Erased;
  /** GAME TURNS left before Erased. Decremented by `tickDowned`, never by a timer. */
  turnsLeft: number;
  /** What it started at. The UI's countdown ring divides by this. */
  readonly total: number;
  /**
   * The sprite this body wore on its feet, so `revive` and `resetFloorParty`
   * restore exactly what was there rather than re-deriving it. A body that was
   * wearing something unusual when it fell gets that back.
   */
  readonly upSprite: string;
  /** The completed-game-turn count when it happened. For the log and the UI. */
  readonly sinceTurn: number;
};

/**
 * The side table. One per world.
 *
 * A `Map`, so iteration is insertion order and therefore reproducible — the
 * same reason engine/effects.ts gives for its own table. Two players going down
 * on the same turn must produce the same event order on every machine.
 */
export type DownedState = {
  readonly byActor: Map<string, DownedRecord>;
};

export function createDownedState(): DownedState {
  return { byActor: new Map<string, DownedRecord>() };
}

/**
 * Drop everything about an actor. The one place `world.removeActor` must call,
 * alongside `effects.forgetActor` and `talentEngine.forget`.
 *
 * NOT the death path and NOT the wipe path — both of those keep the record,
 * because a body that has left the world is a different thing from a body lying
 * on the floor of it.
 */
export function forgetActor(state: DownedState, actorId: string): void {
  state.byActor.delete(actorId);
}

/** The stage this body is in. `Up` when there is no record, which is the common case. */
export function survivalOf(state: DownedState, actorId: string): Survival {
  return state.byActor.get(actorId)?.status ?? Survival.Up;
}

export function isDowned(state: DownedState, actorId: string): boolean {
  return survivalOf(state, actorId) === Survival.Downed;
}

export function isErased(state: DownedState, actorId: string): boolean {
  return survivalOf(state, actorId) === Survival.Erased;
}

/** The live record, or undefined. Read-only in spirit; `tickDowned` owns the writes. */
export function downedRecord(state: DownedState, actorId: string): DownedRecord | undefined {
  return state.byActor.get(actorId);
}

/** What the client draws over the body: the marker key, the timer and its denominator. */
export type DownedView = {
  readonly status: typeof Survival.Downed | typeof Survival.Erased;
  readonly marker: DownedMarker;
  readonly turnsLeft: number;
  readonly total: number;
};

/**
 * The projector's view of a body, or undefined for anyone on their feet.
 *
 * It is a QUERY rather than a field on `ActorView` so that the FOV filter in
 * view/projector.ts stays the only thing deciding who sees it — a downed ally
 * across a wall is a position, and the event log leaks visibility more often
 * than the tile grid does.
 */
export function downedView(state: DownedState, actorId: string): DownedView | undefined {
  const record = state.byActor.get(actorId);
  if (record === undefined) return undefined;
  return {
    status: record.status,
    marker: record.status === Survival.Downed ? DownedMarker.Downed : DownedMarker.Erased,
    turnsLeft: record.turnsLeft,
    total: record.total,
  };
}

// ---------------------------------------------------------------------------
// Going down
// ---------------------------------------------------------------------------

/**
 * PUT A PLAYER ON THE FLOOR. Idempotent, and returns null when nothing changed.
 *
 * Call it immediately after any damage that took a player to 0 — the scheduler
 * does, from both the player lane and the batched monster sweep — and again,
 * belt-and-braces, from the `actBase` pass, which is what catches a body that
 * bled out inside `timedEffects` rather than under a blow.
 *
 * MONSTERS ARE NOT DOWNED, THEY DIE. Returning null for a non-player is not a
 * guard clause to be relaxed later: the whole mechanic exists so that a HUMAN
 * keeps playing, and a downed husk would be a five-turn window in which the
 * party has to decide whether to hit a corpse again.
 *
 * It FORCES the state rather than asserting it — hp to 0, `alive` false, the
 * decision cleared, the sprite swapped. So `goDown` on a player who is somehow
 * still standing is a legal way to say "put them down", and there is exactly one
 * function in the process that knows what being down looks like.
 *
 * @returns the fresh record, or null when this body was already Downed, already
 * Erased, or is not a player.
 */
export function goDown(
  state: DownedState,
  actor: DownedActor,
  gameTurn: number,
): DownedRecord | null {
  if (actor.kind !== ActorKind.Player) return null;
  if (state.byActor.has(actor.id)) return null;

  const record: DownedRecord = {
    status: Survival.Downed,
    turnsLeft: DOWNED_TURNS,
    total: DOWNED_TURNS,
    upSprite: actor.sprite,
    sinceTurn: gameTurn,
  };
  state.byActor.set(actor.id, record);

  actor.hp = 0;
  actor.alive = false;
  // A body on the floor holds no decisions. Leaving one pending would let it
  // resolve the instant somebody picked them up, three turns after they chose it.
  actor.pendingIntent = null;
  actor.sprite = downedSpriteFor(actor.sprite);

  return record;
}

/** What one turn of the countdown did. */
export const DownedTick = {
  /** Nothing to count: the body is up, or already Erased. */
  None: 'none',
  /** One turn gone, turns still on the clock. */
  Counting: 'counting',
  /** The clock reached zero on THIS pass. */
  Erased: 'erased',
} as const;
export type DownedTick = (typeof DownedTick)[keyof typeof DownedTick];

/**
 * ONE GAME TURN OF THE COUNTDOWN — called from the scheduler's `actBase` pass,
 * once per game turn per body, at any speed.
 *
 * ═══ THE ORDER IN THAT PASS IS EFFECTS FIRST, THEN THIS ═══
 * `timedEffects` (tome/class/Actor.lua:597) runs first because **bleeding can down you**:
 * physical.lua:149-151's `on_timeout` projects its damage inside that call, so a
 * body that bled out is already at 0 HP by the time the survival pass looks at
 * it — and the scheduler enrols it THERE, on the turn it fell, instead of a turn
 * late. Run the countdown first and a bleed death is invisible for a whole turn.
 *
 * ═══ A BODY DOWNED THIS TURN DOES NOT TICK THIS TURN ═══
 * The scheduler enrols and returns; the first decrement is the NEXT base pass.
 * So five turns is five turns you can actually run across the room in, which is
 * the same reason ActorTemporaryEffects.lua:91 decrements AFTER `on_timeout`.
 *
 * @returns whether anything moved, and whether this pass erased them.
 */
export function tickDowned(state: DownedState, actor: DownedActor): DownedTick {
  const record = state.byActor.get(actor.id);
  if (record === undefined || record.status === Survival.Erased) return DownedTick.None;

  record.turnsLeft -= 1;
  if (record.turnsLeft > 0) return DownedTick.Counting;

  record.turnsLeft = 0;
  record.status = Survival.Erased;
  // The body stays exactly where it is, still wearing the downed sprite; only
  // the overlay changes (`ui_marker_downed` → `ui_marker_erased`). Nothing is
  // deleted, because M4 has no permadeath and the floor reset needs something
  // to put back on its feet.
  return DownedTick.Erased;
}

// ---------------------------------------------------------------------------
// Getting back up
// ---------------------------------------------------------------------------

/** Why a revive did not happen. NEVER a partial success — a pickup is atomic. */
export const ReviveRefusal = {
  /** Nobody is down there. The commonest refusal, and it is free. */
  NotDowned: 'not_downed',
  /** The countdown ran out. Only a floor reset brings an Erased body back. */
  Erased: 'erased',
  /** Not adjacent. `REVIVE_REACH` is Chebyshev, so a diagonal counts. */
  OutOfReach: 'out_of_reach',
  /** The would-be rescuer is themselves down. */
  RescuerDown: 'rescuer_down',
  /** A monster does not pick up a detective. Factions, M4 edition. */
  NotAnAlly: 'not_an_ally',
} as const;
export type ReviveRefusal = (typeof ReviveRefusal)[keyof typeof ReviveRefusal];

export type ReviveResult =
  | {
      readonly ok: true;
      /** HP they got up with. `ceil(maxHp × 0.25)`, never 0. */
      readonly hp: number;
      /** Turns that were still on their clock. The log prints it; it is the drama. */
      readonly turnsSpared: number;
    }
  | { readonly ok: false; readonly reason: ReviveRefusal };

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * PICK SOMEBODY UP. "GET TO ME" MADE MECHANICAL.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * game-design.md § 9: *"Any ally reaching you spends 4 AP to restore you at 25%
 * HP."* The engine-level price is the RESCUER'S WHOLE TURN — the scheduler
 * charges it through `spendTurn` on the way out, exactly as it charges a move —
 * which is what makes the choice cost something in a fight and what makes the
 * Bell matter while somebody is deciding.
 *
 * EVERY REFUSAL COSTS ZERO. This is the refund rule (docs/architecture.md § 2)
 * and it is why the button is safe to press: the target got picked up by someone
 * else half a second ago, or a knockback opened the gap between the click and
 * the tick, and the answer is a re-prompt rather than a wasted turn. Reviving is
 * exactly the moment a player must not hesitate.
 *
 * THE COUNTDOWN IS CLEARED, NOT PAUSED. The record is deleted outright, so a
 * player who goes down again gets a fresh five turns rather than the remains of
 * their last ones. Anything else would make the second rescue quietly hopeless.
 */
export function revive(
  state: DownedState,
  target: DownedActor,
  rescuer: DownedActor,
): ReviveResult {
  const record = state.byActor.get(target.id);
  if (record === undefined) return { ok: false, reason: ReviveRefusal.NotDowned };
  if (record.status === Survival.Erased) return { ok: false, reason: ReviveRefusal.Erased };
  if (!rescuer.alive) return { ok: false, reason: ReviveRefusal.RescuerDown };
  if (rescuer.kind !== target.kind) return { ok: false, reason: ReviveRefusal.NotAnAlly };
  if (chebyshev(rescuer, target) > REVIVE_REACH) {
    return { ok: false, reason: ReviveRefusal.OutOfReach };
  }

  const turnsSpared = record.turnsLeft;
  state.byActor.delete(target.id);

  // `ceil`, and floored at 1: a body that came back at 0 HP would be downed
  // again by the next `applyDamage`, which is a bug that reads as a taunt.
  const hp = Math.max(1, Math.min(target.maxHp, Math.ceil(target.maxHp * REVIVE_HP_FRACTION)));
  target.hp = hp;
  target.alive = true;
  target.sprite = record.upSprite;

  // The clocks are NOT touched. They kept running while the body was down (the
  // scheduler leaves a downed body active precisely so the countdown ticks), so
  // whoever gets up is already in phase with the party and can act on the turn
  // they are picked up. Zeroing them here would cost the rescue its whole point.
  return { ok: true, hp, turnsSpared };
}

// ---------------------------------------------------------------------------
// The party, and the wipe
// ---------------------------------------------------------------------------

/**
 * IS SOMEBODY ACTUALLY DRIVING THIS BODY RIGHT NOW?
 *
 * A PREDICATE PARAMETER RATHER THAN AN IMPORT, and the direction of that arrow
 * is the whole reason it is one. Presence is a fact about a SOCKET: it lives in
 * `connected` and `standingBy`, which engine/barrier.ts owns and net/gateway.ts
 * drives. This module is pure survival arithmetic and must not learn what a
 * socket is in order to answer a question about hit points — the same argument
 * the barrier makes for taking `nowMs` as a parameter instead of reading a
 * clock. The caller already knows the answer, so it passes it in.
 *
 * REQUIRED, NOT OPTIONAL, and that is deliberate too. An optional predicate
 * defaulting to *"everyone counts"* would reintroduce the exact bug the moment
 * somebody added a second call site and did not think about it; making it a
 * parameter means the compiler asks the question at every one of them.
 */
export type PresenceCheck = (actorId: string) => boolean;

export type PartySurvey = {
  /**
   * Conscious players, in turn order — whether or not anybody is driving them.
   *
   * A disconnected body belongs HERE and nowhere else: it is not dead, it is not
   * Downed, and its owner may be back in ten minutes to find it at the hp they
   * left it on.
   */
  readonly up: readonly string[];
  /**
   * The subset of `up` somebody is actually driving. THE WIPE READS THIS ONE.
   *
   * "Is anyone left to save the party" is the only question the wipe asks, and a
   * body with no socket behind it cannot cross a room, cannot spend a turn and
   * cannot pick anybody up. Counting one as a survivor is what left a live
   * player Erased forever with no floor reset — see the header.
   */
  readonly survivors: readonly string[];
  readonly downed: readonly string[];
  readonly erased: readonly string[];
  /**
   * NOBODY IS LEFT WHO COULD HELP, and there is at least one player on the floor.
   *
   * The emptiness clause is not pedantry: a server that has just booted holds
   * zero players, and without it every game turn on an empty level would report
   * a party wipe and reset a floor nobody is standing on. `downed + erased > 0`
   * carries it — an empty level has neither.
   */
  readonly wiped: boolean;
};

/** Who is up, who is driving, who is down, who is gone — computed fresh. */
export function surveyParty(
  actors: readonly DownedActor[],
  state: DownedState,
  isPresent: PresenceCheck,
): PartySurvey {
  const up: string[] = [];
  const survivors: string[] = [];
  const downed: string[] = [];
  const erased: string[] = [];

  for (const actor of actors) {
    if (actor.kind !== ActorKind.Player) continue;
    switch (survivalOf(state, actor.id)) {
      case Survival.Downed:
        downed.push(actor.id);
        break;
      case Survival.Erased:
        erased.push(actor.id);
        break;
      case Survival.Up:
        up.push(actor.id);
        // The one line the whole ghost bug turned on.
        if (isPresent(actor.id)) survivors.push(actor.id);
        break;
    }
  }

  return {
    up,
    survivors,
    downed,
    erased,
    wiped: survivors.length === 0 && downed.length + erased.length > 0,
  };
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE WIPE RESETS THE FLOOR. IT DOES NOT END THE RUN. (game-design.md § 9)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Every player back on their feet at full HP, every countdown cleared, every
 * sprite restored, both clocks re-zeroed so the party lands PHASE-LOCKED and
 * parks together on the next turn instead of trickling in one at a time (D1,
 * engine/actor.ts).
 *
 * ═══ THIS IS HALF THE RESET. THE CALLER OWNS THE OTHER HALF. ═══
 * The engine may not reach into persist/, net/ or the level generator, so the
 * `party_wipe` event `pump` returns is the seam — exactly like the Bell deadline
 * and the save queue. After the pump returns, the CALLER:
 *
 *   1. re-seeds the floor's monsters (`world.removeActor` + `addMonster`),
 *   2. moves the party back to the spawn cluster (`world.placeAtSpawn` owns the
 *      cluster walk; nothing in engine/ knows where a spawn tile is — it is the
 *      same call `submitRespawn` makes for one body),
 *   3. clears statuses and talent cooldowns (`dispel`, `effects.forgetActor`),
 *   4. broadcasts, and only then queues a save.
 *
 * Doing (1) and (2) in here would mean the engine picking spawn tiles and
 * writing to the actor table mid-sweep, and the first thing to break would be
 * two bodies on one tile.
 *
 * A restored player is left `standingBy` exactly as they were: somebody who
 * walked away from the keyboard has not come back just because the floor did.
 *
 * @returns the ids actually put back on their feet, in turn order.
 */
export function resetFloorParty(
  actors: readonly DownedActor[],
  state: DownedState,
): readonly string[] {
  const restored: string[] = [];

  for (const actor of actors) {
    if (actor.kind !== ActorKind.Player) continue;
    const record = state.byActor.get(actor.id);
    if (record === undefined) continue;

    standUp(state, actor, record);
    restored.push(actor.id);
  }

  return restored;
}

/**
 * PUT ONE BODY BACK ON ITS FEET AT FULL HP. What coming back LOOKS like, once.
 *
 * Shared by the wipe above and by self-service `respawn` below, deliberately:
 * two copies of this is how one of them ends up forgetting to re-zero a clock,
 * and the body that skipped it takes its turn inside the very tick it was
 * restored in — before anybody has been told it got up.
 *
 * IT DOES NOT MOVE ANYTHING. Position is the caller's half (see the checklist
 * above): world.ts calls `tryMove` the one legal way to change a position, and
 * nothing in engine/ knows where a spawn tile is.
 */
function standUp(state: DownedState, actor: DownedActor, record: DownedRecord): void {
  state.byActor.delete(actor.id);
  actor.sprite = record.upSprite;
  actor.hp = actor.maxHp;
  actor.alive = true;
  actor.pendingIntent = null;
  // Both clocks to zero. A body that woke up holding a full act bar would take
  // its turn inside the same tick it was restored in, before anyone has been
  // told the floor reset — and the base clock has to move with it or the two
  // drift apart by however long the party spent on the floor.
  actor.energy = 0;
  actor.energyBase = 0;
}

// ---------------------------------------------------------------------------
// The way back — self-service, and only out of Erased
// ---------------------------------------------------------------------------

/** Why a self-respawn did not happen. */
export const RespawnRefusal = {
  /**
   * They are on their feet. Nothing to file, and the commonest refusal there
   * is — a wipe or an ally's rescue beat the keypress by half a second.
   */
  Up: 'up',
  /**
   * STILL DOWNED, AND THIS REFUSAL IS THE MECHANIC. Downed has a five-turn
   * countdown and a rescuer running at it; letting somebody walk out of it on
   * their own would delete the tension the whole system exists to create —
   * *"I died"* would stop meaning *"GET TO ME"*. Wait, or be reached.
   */
  Downed: 'downed',
  /** A monster does not file paperwork. Monsters die; players are Unfiled. */
  NotAPlayer: 'not_a_player',
} as const;
export type RespawnRefusal = (typeof RespawnRefusal)[keyof typeof RespawnRefusal];

export type RespawnResult =
  | {
      readonly ok: true;
      /** HP they got up with: FULL, exactly as the wipe restores. */
      readonly hp: number;
      /** The game turn they FELL on (`DownedRecord.sinceTurn`). For the log. */
      readonly downedSinceTurn: number;
    }
  | { readonly ok: false; readonly reason: RespawnRefusal };

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A WAY BACK. THE ERASED PLAYER PICKS THEMSELVES UP.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Reported from real co-op play: a player was Erased while a disconnected body
 * kept the wipe from ever firing (see the header), and there was no path out at
 * all — Erased is terminal until a floor reset, and the floor reset was exactly
 * what could not happen. Even with that predicate fixed, a party of two where
 * one person is at the keyboard and the other is Erased has no reset coming: the
 * survivor is up, so the party is not wiped, and the erased body waits for a
 * rescue that `revive` explicitly refuses (`ReviveRefusal.Erased`).
 *
 * So Erased grows one exit, and it is the SAME restoration the wipe performs —
 * full hp, sprite back, both clocks re-zeroed, record cleared. M4 STILL HAS NO
 * PERMADEATH AND THIS ADDS NONE: nothing is lost, nothing is deleted, and
 * `standUp` is literally the function the wipe calls.
 *
 * ═══ IT IS SELF-SERVICE, AND IT CANNOT TARGET ANYBODY ELSE ═══
 * There is no `targetId` here and there is none on the wire either
 * (`RespawnSchema` in src/shared/protocol.ts carries no fields at all). The
 * actor is the one the socket owns, resolved server-side like every other verb.
 *
 * ═══ IT REFUSES OUT OF UP AND OUT OF DOWNED ═══
 * See `RespawnRefusal.Downed`: a player who could self-respawn out of Downed
 * would never be worth running to.
 */
export function respawn(state: DownedState, actor: DownedActor): RespawnResult {
  if (actor.kind !== ActorKind.Player) {
    return { ok: false, reason: RespawnRefusal.NotAPlayer };
  }
  const record = state.byActor.get(actor.id);
  if (record === undefined) return { ok: false, reason: RespawnRefusal.Up };
  if (record.status !== Survival.Erased) {
    return { ok: false, reason: RespawnRefusal.Downed };
  }

  const downedSinceTurn = record.sinceTurn;
  standUp(state, actor, record);
  return { ok: true, hp: actor.hp, downedSinceTurn };
}
