/**
 * The Warrant Clock — co-op turn arbitration (docs/game-design.md § 4).
 *
 * The hardest problem in co-op turn-based, and the one most likely to make the
 * game unfun. Everything below — combat, exploration, AFK, splitting up, a
 * laptop lid closing mid-fight — falls out of ONE PREDICATE and a countdown.
 *
 * ===========================================================================
 * THIS MODULE OWNS POLICY. THE CALLER OWNS THE WALL CLOCK.
 * ===========================================================================
 *
 * Every function that cares about time takes `nowMs` AS A PARAMETER. Nothing
 * here calls `Date.now()` (ESLint bans it across the engine) and `setTimeout`
 * does not exist in this block at all. The caller — the net layer — reads the
 * clock, sets the real timer for `bell().deadlineMs`, and re-enters the engine
 * when it fires.
 *
 * That split is not ceremony, it is what makes the Bell UNIT-TESTABLE. A timer
 * living in here would mean the only way to test "twenty seconds elapse and the
 * straggler is auto-passed" is to wait twenty seconds, so it would be tested
 * once by hand and never again. With time passed in, the whole of the Bell,
 * Standing By and the ten-minute reconnect grace is exercised by calling the
 * same function twice with two numbers. It is also what keeps turn resolution
 * synchronous, and that synchronicity IS the mutex against interleaved frames.
 *
 * ===========================================================================
 * THE BARRIER IS ALMOST ENTIRELY STATELESS, ON PURPOSE
 * ===========================================================================
 *
 * `isBlocking` and `surveyQuorum` are pure functions of the actors and the
 * level. There is no "committed" set to keep in sync with reality, because
 * COMMITTED IS DERIVED: a quorum member is committed exactly when it is not
 * blocking. A separate set would be a second source of truth about whose turn
 * it is, and the first thing to desync would be the Bell firing on somebody who
 * had already acted.
 *
 * The only state the `Barrier` object holds is the three things that genuinely
 * cannot be derived from a snapshot:
 *   1. WHEN the current countdown started;
 *   2. how many CONSECUTIVE auto-passes each player has taken (Standing By);
 *   3. WHEN each disconnected player dropped (the ten-minute grace).
 *
 * SYNCHRONOUS AND DETERMINISTIC — src/server/engine/** carries the six
 * anti-async AST selectors plus the bans on `Date.now` and `Math.random`.
 */

import { ENERGY_TO_ACT } from '../../shared/energy.ts';
import { ActorKind } from '../../shared/protocol.ts';

// ---------------------------------------------------------------------------
// The numbers, and why each one is what it is
// ---------------------------------------------------------------------------

/**
 * How long a straggler has once the Bell starts, in milliseconds.
 *
 * There is NO TIMER AT ALL until `committed >= quorum - 1`. Starting one
 * earlier is the failure mode the design rejected strict initiative to avoid:
 * a clock on somebody while two other people are still thinking is pressure
 * with nothing to do about it.
 */
export const BELL_MS = {
  /** The ordinary case. Long enough to read the board, short enough to matter. */
  Normal: 20_000,
  /** Boss floors. Shorter because the party is already fully engaged and talking. */
  Boss: 12_000,
  /**
   * QUORUM OF ONE — the lone survivor, or the last person not Standing By.
   *
   * Two minutes, and it is the most important number in this file. The Bell
   * exists to stop three people waiting on one; when there is nobody waiting it
   * has no job, and a 20-second clock on the last person standing is the game
   * hurrying somebody through the tensest moment it has. Never rush someone
   * playing alone.
   */
  Solo: 120_000,
} as const;

/**
 * Two consecutive auto-passes and a player leaves the quorum entirely.
 *
 * From then on they auto-hold IMMEDIATELY with no Bell delay, so the party runs
 * at full speed instead of eating a 20-second pause every single turn for
 * somebody who walked away. Any command clears it. This happens in every
 * session that lasts more than an hour; it is built on day one for that reason.
 */
export const STANDING_BY_AFTER_AUTO_PASSES = 2;

/**
 * How long a disconnected body waits before it may be recalled.
 *
 * The body STAYS IN THE WORLD for the whole of it — this is a MUD, you do not
 * yank someone out of a fight because their wifi blinked. Recall happens at the
 * next safe moment after the grace expires, never mid-fight, because a
 * mid-fight recall would be a free escape.
 */
export const RECONNECT_GRACE_MS = 10 * 60_000;

// ---------------------------------------------------------------------------
// The shapes the barrier reads
// ---------------------------------------------------------------------------

/**
 * The MINIMAL actor the barrier needs. `EngineActor` is a structural superset,
 * so the real world's array passes straight in with no adapter — while every
 * test in test/server/engine/barrier.test.ts can be written with six-line
 * object literals and no world at all.
 *
 * Mutable exactly where the barrier writes: `standingBy` and `connected`. It is
 * the ONLY writer of `standingBy` in the process (see actor.ts).
 */
export type BarrierActor = {
  readonly id: string;
  readonly kind: ActorKind;
  /** The act clock. At or above ENERGY_TO_ACT the actor owes a decision. */
  readonly energy: number;
  readonly alive: boolean;
  /**
   * Non-null once a decision has been submitted. The barrier deliberately does
   * not know the shape of an intent — commit-on-submit means the mere PRESENCE
   * of one is the commitment.
   */
  readonly pendingIntent: object | null;
  /** Non-null means an order supplies this actor's action, so it never blocks. */
  readonly standingOrder: string | null;
  connected: boolean;
  standingBy: boolean;
};

/**
 * The level-wide facts the barrier consults. Structurally satisfied by the
 * world's `TurnState`.
 */
export type BarrierLevel = {
  /**
   * ENGAGEMENT IS LEVEL-WIDE, NOT PER-PLAYER — > 0 while any hostile has a
   * player in view or vice versa, decaying over a few turns after the last
   * contact (ToME's `checkStillInCombat`, Actor.lua:7648-7669).
   *
   * Level-wide is the only co-op-specific clause in `isBlocking` and it is
   * load-bearing in both directions:
   *
   *   AT ZERO, NOBODY EVER BLOCKS. The loop runs until every player sits at
   *   ENERGY_TO_ACT, where accrual stops, so the pump goes idle and the CPU
   *   goes to zero. Movement drains the bank the instant it arrives, so
   *   exploration FEELS like free grid movement while remaining the same energy
   *   engine underneath. That is "kill turns outside combat" achieved with LESS
   *   machinery, not more.
   *
   *   ABOVE ZERO, EVERY PLAYER ON THE LEVEL BLOCKS — including one thirty tiles
   *   away. Otherwise somebody walks fifty free tiles while a friend tanks. It
   *   also matches the fiction (you can hear the fight) and it is what creates
   *   the "get over here" pressure that makes co-op work.
   */
  readonly engagement: number;
  /** Boss floors run the shorter Bell. */
  readonly bossFloor: boolean;
};

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHO SHARES A BARRIER WITH THE ASKING PLAYER — THE PARTY, NOT THE LEVEL.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The level-wide clause on `BarrierLevel.engagement` above is still exactly
 * right and is UNCHANGED: engagement is a fact about the world (a fight is
 * happening here), and above zero every player IN A PARTY blocks every other
 * member of that party, including one thirty tiles away. That is the argument
 * the essay makes and it survives intact — WITHIN a party.
 *
 * What it never argued for, because until src/server/engine/party.ts there was
 * no vocabulary in which to say it, is a barrier between two people who never
 * agreed to share one. Real multiplayer found that half first: a solo player
 * waited on a stranger, and then on a stranger who had closed the tab.
 *
 * So the quorum, the commit count, the blocking set and the Bell all take an
 * OPTIONAL scope. Absent means the whole level, which is byte-for-byte the
 * behaviour every one of these functions had before parties existed — a server
 * with no party table wired in is the same game it was, and every test written
 * against the level-wide barrier still describes the truth.
 *
 * A PARAMETER RATHER THAN AN IMPORT, and the direction of that arrow is the
 * reason it is one. Party membership is a social fact that engine/party.ts owns
 * and net/gateway.ts drives; this module is turn arbitration and it must not
 * learn what an invite is in order to count a quorum. It is the same split
 * downed.ts makes with `PresenceCheck` and the same one this file already makes
 * with `nowMs`: the caller knows, so the caller says.
 */
export type PartyScope = {
  /**
   * A STABLE IDENTITY FOR THIS PARTY, and the Bell keys its countdown on it.
   *
   * It has to be stable across pumps for the same reason `bellKey` below has to
   * be: a countdown whose identity changed every frame would restart every
   * frame and never ring. It never reaches a client — see engine/party.ts.
   */
  readonly id: string;
  /**
   * Every member's actor id, INCLUDING the asking player.
   *
   * Not `readonly Set` because a party is at most `MAX_PARTY_SIZE` and the
   * surveys below walk the actor array once, testing membership per actor — a
   * linear scan of four beats allocating a Set per pump per party.
   */
  readonly members: readonly string[];
};

/**
 * The countdown key for the level itself.
 *
 * Empty string because no party id can be one (`party_<n>`), so the un-scoped
 * caller's countdown can never collide with a real party's — and the un-scoped
 * caller is exactly the pre-party behaviour, which is why it deserves a slot in
 * the same table rather than a second field.
 */
const LEVEL_SCOPE = '';

function inScope(actorId: string, scope: PartyScope | undefined): boolean {
  return scope === undefined || scope.members.includes(actorId);
}

/** What the Bell and the turn indicator need, computed fresh from the actors. */
export type QuorumSnapshot = {
  /** Quorum size: conscious, connected, non-Standing-By players. */
  readonly total: number;
  /** `total - blocking.length`. Derived, never stored — see the header. */
  readonly committed: number;
  /** Everyone who still owes a decision, in turn order. */
  readonly blocking: readonly string[];
  /** Quorum-excluded players. Reported so the UI can say WHY the count is short. */
  readonly standingBy: readonly string[];
};

export type BellState = {
  /** True while a countdown is actually running. */
  readonly running: boolean;
  /** Absolute wall-clock deadline. The caller sets its real timer for this. */
  readonly deadlineMs: number | null;
  readonly remainingMs: number | null;
  /** What the countdown WOULD be, even when it is not running. null = never. */
  readonly durationMs: number | null;
  /** Who the countdown is on. */
  readonly stragglers: readonly string[];
  readonly quorum: number;
  readonly committed: number;
};

/** One forced pass, reported so the caller can install the hold and log it. */
export type AutoPass = {
  readonly id: string;
  /** How many consecutive auto-passes this player has now taken. */
  readonly consecutive: number;
  /** True when this pass tipped them into Standing By. */
  readonly standingBy: boolean;
};

// ---------------------------------------------------------------------------
// The predicate. Everything else in this file is bookkeeping around it.
// ---------------------------------------------------------------------------

/**
 * Is this actor part of the quorum? — conscious, connected, not Standing By.
 *
 * Standing By removes a player from the DENOMINATOR, not just from the
 * countdown. That is the whole point: with three of four players active, the
 * Bell fires as soon as two have committed, exactly as it would in a party of
 * three.
 */
export function inQuorum(actor: BarrierActor): boolean {
  return actor.kind === ActorKind.Player && actor.alive && actor.connected && !actor.standingBy;
}

/**
 * DOES THIS ACTOR OWE A DECISION NOBODY HAS MADE YET?
 *
 * Ported verbatim from game-design.md § 4's `isBlocking`, which is itself the
 * co-op generalisation of ToME's `game.paused` (Player.lua:409 +
 * GameEnergyBased.lua:133-137): one global flag bound to one `game.player`
 * becomes a per-actor predicate, so the pause condition is a SET rather than a
 * singleton.
 *
 * MUST STAY SIDE-EFFECT FREE. `tickLevel` calls it to discover the WHOLE
 * blocking set within a single tick without taking anybody's turn. Put a
 * mutation in here and the barrier degrades into round-robin — park on player
 * 1, wait, park on player 2, wait — which is the "player 1 deliberates for 40
 * seconds and players 2-4 tab out" failure the design rejected strict
 * initiative to avoid, arrived at by accident.
 *
 * The `energy` clause is redundant when called from `tickLevel` (which only
 * asks about actors already at the threshold) and is kept anyway, because this
 * predicate is also called standalone to build the UI state.
 */
export function isBlocking(actor: BarrierActor, level: BarrierLevel): boolean {
  return (
    inQuorum(actor) &&
    actor.energy >= ENERGY_TO_ACT &&
    // Commit-on-submit: a submitted intent IS the commitment, even before it
    // resolves. Resolution can still refund it, and a refund puts the actor
    // straight back here with a fresh Bell.
    actor.pendingIntent === null &&
    // A standing order supplies the action, so its owner is dragged into
    // lockstep by engagement but never has to click (Player.lua:401-406).
    actor.standingOrder === null &&
    level.engagement > 0
  );
}

/**
 * The quorum, the commit count and the blocking set, computed in one pass.
 *
 * @param scope the asking player's party, or undefined for the whole level.
 *   `isBlocking` is deliberately NOT given one: whether an actor owes a
 *   decision is a fact about that actor and nobody else, and the scope decides
 *   only whose decisions are counted into WHOSE quorum. Keeping it that way is
 *   what makes the level-wide survey the exact union of every party's — which
 *   is what lets the gateway keep using one cheap "has anything changed?" key.
 */
export function surveyQuorum(
  actors: readonly BarrierActor[],
  level: BarrierLevel,
  scope?: PartyScope,
): QuorumSnapshot {
  const blocking: string[] = [];
  const standingBy: string[] = [];
  let total = 0;

  for (const actor of actors) {
    if (actor.kind !== ActorKind.Player || !actor.alive) continue;
    if (!inScope(actor.id, scope)) continue;
    if (!inQuorum(actor)) {
      // Disconnected players are Standing By too — reported here so the UI can
      // show "3 of 4, one disconnected" rather than silently shrinking.
      standingBy.push(actor.id);
      continue;
    }
    total += 1;
    if (isBlocking(actor, level)) blocking.push(actor.id);
  }

  return { total, committed: total - blocking.length, blocking, standingBy };
}

/**
 * How long the countdown runs, or null when there must never be one.
 *
 * Out of combat the answer is null and that is belt-and-braces rather than the
 * real defence: at `engagement === 0` nothing blocks, so there is nobody to
 * ring a bell at.
 */
export function bellDurationMs(quorum: number, level: BarrierLevel): number | null {
  if (level.engagement <= 0) return null;
  if (quorum <= 1) return BELL_MS.Solo;
  return level.bossFloor ? BELL_MS.Boss : BELL_MS.Normal;
}

// ---------------------------------------------------------------------------
// The stateful half
// ---------------------------------------------------------------------------

export type Barrier = {
  /** The quorum, the commit count and who is still blocking. Pure. */
  survey(actors: readonly BarrierActor[], level: BarrierLevel, scope?: PartyScope): QuorumSnapshot;
  /**
   * The countdown as of `nowMs`, starting it if this is the first moment the
   * condition holds. Idempotent: calling it twice with the same inputs does not
   * restart anything.
   *
   * ONE COUNTDOWN PER PARTY. Two parties on one floor deliberate independently
   * and neither one's Bell has anything to say about the other, so the start
   * time is kept per `scope.id` — see `countdowns` in `createBarrier`.
   */
  bell(
    actors: readonly BarrierActor[],
    level: BarrierLevel,
    nowMs: number,
    scope?: PartyScope,
  ): BellState;
  /**
   * Apply the countdown if it has run out. Returns who was forced to pass; the
   * CALLER installs the hold, because the barrier does not know what an intent
   * looks like and must not learn.
   *
   * Call it once PER PARTY. Each call reads that party's own deadline, so a
   * caller with one wall-clock timer can wake up and sweep every party: the
   * ones whose deadline has not passed return nothing and cost one survey.
   */
  expire(
    actors: readonly BarrierActor[],
    level: BarrierLevel,
    nowMs: number,
    scope?: PartyScope,
  ): readonly AutoPass[];
  /** Any command from a player clears Standing By and resets the silence count. */
  noteCommand(actor: BarrierActor): void;
  /** Immediate Standing By; the body stays in the world. Records the drop time. */
  disconnect(actor: BarrierActor, nowMs: number): void;
  reconnect(actor: BarrierActor): void;
  /** Ids whose ten-minute grace has run out. The caller recalls them when safe. */
  graceExpired(nowMs: number): readonly string[];
  /** Consecutive auto-passes on record for a player. Diagnostics and tests. */
  autoPassesOf(id: string): number;
  /** Drop all bookkeeping for an actor that has genuinely left the world. */
  forget(id: string): void;
};

type BarrierRecord = {
  /** Consecutive auto-passes. Reset by any command. */
  autoPasses: number;
  /** When this player dropped, or null while connected. */
  disconnectedAtMs: number | null;
};

const EMPTY_PASSES: readonly AutoPass[] = [];

function requireFiniteTime(nowMs: number, where: string): void {
  // A NaN here would freeze the countdown forever and look exactly like "the
  // Bell is broken" three weekends later, so it fails loudly at the boundary.
  if (!Number.isFinite(nowMs)) {
    throw new RangeError(`barrier.${where}: nowMs must be a finite number`);
  }
}

export function createBarrier(): Barrier {
  const records = new Map<string, BarrierRecord>();

  /**
   * ONE RUNNING COUNTDOWN PER PARTY, keyed by `PartyScope.id`.
   *
   * `key` is the identity of the countdown currently running for that party:
   * the blocking set, joined.
   *
   * Keyed by WHO rather than by turn number so the countdown restarts on its
   * own whenever the answer to "who are we waiting for" changes — a new turn, a
   * different straggler, or a refund putting somebody back on the hook. A
   * refunded player getting a fresh 20 seconds is correct: their first 20 were
   * spent on an intent the world invalidated underneath them.
   *
   * NOTHING ELSE MAY CLEAR THIS, and it is worth saying because the obvious
   * "reset the Bell when the party changes" line in `noteCommand` / `disconnect`
   * is a bug: it hands the straggler a fresh 20 seconds every time SOMEBODY ELSE
   * queues a command, which is a clock that never runs out in a party that is
   * chatting. The key already covers every case that matters. When a committed
   * player drops and the quorum falls to one, the key is unchanged and the
   * countdown carries on from where it was — against the LONGER solo duration,
   * so the last person standing is handed the two minutes measured from when
   * they started thinking. That is exactly right, and it is not a special case.
   *
   * ═══ A MAP RATHER THAN TWO VARIABLES, AND ONLY BECAUSE OF PARTIES ═══
   * Two parties on the same floor are two independent deliberations. Sharing
   * one start time between them would mean the second party's stragglers
   * inherited whatever was left of the first party's twenty seconds — a
   * countdown that is already half spent before anybody was asked anything.
   * A party that dissolves simply stops being asked about; its row is dropped
   * the next time a scope with that id is armed, and an orphan row is a few
   * bytes that never fires because nothing ever passes its id in again.
   */
  const countdowns = new Map<string, { key: string; startedMs: number }>();

  const recordFor = (id: string): BarrierRecord => {
    const existing = records.get(id);
    if (existing !== undefined) return existing;
    const fresh: BarrierRecord = { autoPasses: 0, disconnectedAtMs: null };
    records.set(id, fresh);
    return fresh;
  };

  const bell = (
    actors: readonly BarrierActor[],
    level: BarrierLevel,
    nowMs: number,
    scope?: PartyScope,
  ): BellState => {
    requireFiniteTime(nowMs, 'bell');
    const scopeId = scope?.id ?? LEVEL_SCOPE;
    const snapshot = surveyQuorum(actors, level, scope);
    const durationMs = bellDurationMs(snapshot.total, level);

    // THE START CONDITION, written the way the design states it. Note that
    // `committed >= total - 1` is the same thing as `blocking.length <= 1`:
    // the Bell only ever rings for the LAST straggler, which is why it can be
    // aggressive without ever hurrying somebody who has company.
    const armed =
      durationMs !== null &&
      snapshot.blocking.length > 0 &&
      snapshot.committed >= snapshot.total - 1;

    if (!armed) {
      countdowns.delete(scopeId);
      return {
        running: false,
        deadlineMs: null,
        remainingMs: null,
        durationMs,
        stragglers: snapshot.blocking,
        quorum: snapshot.total,
        committed: snapshot.committed,
      };
    }

    const key = snapshot.blocking.join('|');
    let running = countdowns.get(scopeId);
    if (running === undefined || running.key !== key) {
      running = { key, startedMs: nowMs };
      countdowns.set(scopeId, running);
    }
    const deadlineMs = running.startedMs + durationMs;

    return {
      running: true,
      deadlineMs,
      remainingMs: Math.max(0, deadlineMs - nowMs),
      durationMs,
      stragglers: snapshot.blocking,
      quorum: snapshot.total,
      committed: snapshot.committed,
    };
  };

  const expire = (
    actors: readonly BarrierActor[],
    level: BarrierLevel,
    nowMs: number,
    scope?: PartyScope,
  ): readonly AutoPass[] => {
    requireFiniteTime(nowMs, 'expire');
    const state = bell(actors, level, nowMs, scope);
    if (!state.running || state.deadlineMs === null || nowMs < state.deadlineMs) {
      return EMPTY_PASSES;
    }

    const passes: AutoPass[] = [];
    for (const id of state.stragglers) {
      const record = recordFor(id);
      record.autoPasses += 1;
      const standingBy = record.autoPasses >= STANDING_BY_AFTER_AUTO_PASSES;
      if (standingBy) {
        for (const actor of actors) {
          if (actor.id === id) {
            actor.standingBy = true;
            break;
          }
        }
      }
      passes.push({ id, consecutive: record.autoPasses, standingBy });
    }

    // The countdown is spent. Whoever blocks next IN THIS PARTY gets a fresh
    // one; nobody else's is touched.
    countdowns.delete(scope?.id ?? LEVEL_SCOPE);
    return passes;
  };

  return {
    survey: surveyQuorum,
    bell,
    expire,

    noteCommand: (actor: BarrierActor): void => {
      // "Any command clears it." Deliberately not "any command that resolves
      // legally" — someone who is at the keyboard trying things is present, and
      // that is the only thing Standing By is measuring.
      recordFor(actor.id).autoPasses = 0;
      actor.standingBy = false;
    },

    disconnect: (actor: BarrierActor, nowMs: number): void => {
      requireFiniteTime(nowMs, 'disconnect');
      const record = recordFor(actor.id);
      record.disconnectedAtMs = nowMs;
      // THE BODY STAYS IN THE WORLD. Only these two flags change: it leaves the
      // quorum immediately so nobody waits on a socket that is gone, and it
      // auto-holds (braces) every turn until they come back.
      actor.connected = false;
      actor.standingBy = true;
    },

    reconnect: (actor: BarrierActor): void => {
      const record = recordFor(actor.id);
      record.disconnectedAtMs = null;
      record.autoPasses = 0;
      actor.connected = true;
      actor.standingBy = false;
    },

    graceExpired: (nowMs: number): readonly string[] => {
      requireFiniteTime(nowMs, 'graceExpired');
      const expired: string[] = [];
      for (const [id, record] of records) {
        const droppedAt = record.disconnectedAtMs;
        if (droppedAt !== null && nowMs - droppedAt >= RECONNECT_GRACE_MS) expired.push(id);
      }
      // Sorted so two servers replaying the same log recall in the same order;
      // Map iteration order is insertion order, which depends on who connected
      // first — a network-timing input we do not want leaking into game state.
      expired.sort();
      return expired;
    },

    autoPassesOf: (id: string): number => records.get(id)?.autoPasses ?? 0,

    forget: (id: string): void => {
      records.delete(id);
    },
  };
}
