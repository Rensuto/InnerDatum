/**
 * The WebSocket gateway: the process's only trust boundary, and the only place
 * in the server that is allowed to look at a clock.
 *
 * Everything that arrives here is attacker-controlled — including frames from a
 * friend with the devtools console open — so every frame goes through
 * `parseClientMsg` and nothing downstream ever sees an unvalidated message. Two
 * rules follow from that and they are not negotiable:
 *
 *   1. IDENTITY IS NEVER READ FROM THE WIRE. The socket remembers which actor it
 *      owns (`Session.actorId`, set once at `hello`). `move` says which
 *      DIRECTION; `commit` and `hold` say nothing at all. None of them can name
 *      an actor, because the schemas in protocol.ts are `strictObject` and would
 *      reject the extra key anyway.
 *
 *      M5 DOES NOT WEAKEN THIS, and it is worth being precise about why. `hello`
 *      may now carry an opaque `sessionId`, which is 32 CSPRNG bytes this
 *      process minted in `POST /api/token` AFTER a server-side
 *      `GET /users/@me` told it who the holder was. The handle carries no
 *      payload and no signature; the mapping from handle to Discord user lives
 *      in one Map in this process (src/server/http/session.ts). So a client
 *      still cannot SAY who it is — there is no field for that and there never
 *      will be. It can only present something the server already issued, and the
 *      server does the looking up. A forged handle resolves to nobody.
 *   2. THE MOVER LEARNS ITS OWN POSITION FROM THE BROADCAST, exactly like every
 *      other client. There is no optimistic path and no special case for the
 *      sender. One code path means one truth; a private reply to the mover is
 *      how a client and a server quietly stop agreeing.
 *
 * THE SHAPE OF M2, IN ONE PARAGRAPH. Every state-changing frame does the same
 * three things: hand the intent to the scheduler, call `pump()`, broadcast what
 * comes back. `pump` is fully synchronous — that synchronicity IS the mutex, and
 * it is why two WebSocket frames cannot interleave inside a turn. Nothing here
 * ever waits for the engine, and the engine never waits for anything.
 *
 * THIS FILE OWNS THE WALL CLOCK; THE ENGINE DOES NOT. The Bell is a `setTimeout`
 * and it lives here, because `src/server/engine/**` and `src/server/view/**`
 * carry a lint block that makes `setTimeout`, `Date.now()` and `await` errors.
 * The engine decides how LONG a Bell should run (null out of combat, 20 s
 * normal, 12 s on a boss floor, 120 s when quorum is 1 — never a 20-second clock
 * on the last person standing) and this file counts it down. The same split
 * covers the ten-minute reconnect grace.
 *
 * ASYNC IS ALLOWED HERE and nowhere below. This file is src/server/net/, outside
 * the no-await lint block that covers engine/, world/ and view/. Note that
 * everything reached from the `message` handler is synchronous.
 *
 * NOTHING IN A HANDLER MAY THROW. An exception escaping a `ws` event handler is
 * an uncaught exception, and an uncaught exception kills the PROCESS, not the
 * connection. One malformed frame must cost one `error` reply, not everyone's
 * session — hence the try/catch around the whole message body, and the second
 * one around `pump()`.
 */

import { createHash, randomUUID } from 'node:crypto';

import websocket from '@fastify/websocket';

import { DIR_ORDER, dirVector, inBounds } from '../../shared/coords.ts';
import { ErasedReason, ErrorCode, LogLane, parseClientMsg } from '../../shared/protocol.ts';
import { PROTOCOL_VERSION } from '../../shared/version.ts';
/**
 * THE ONE CONTENT IMPORT IN THIS FILE, AND IT IS DATA ONLY.
 *
 * `classForJoin` decides which of the three classes a joining body gets and
 * `classById` says whether a saved id still names one. Nothing else about a
 * class is read here — the SHEET (the loadout, the resource pool, the AP/MP
 * budget) is attached through `TurnEngine.attachClass`, injected exactly like
 * every other engine capability, because `engine/talents.ts` is on the far side
 * of a boundary this file may not reach across.
 */
import { classById, classForJoin } from '../content/classes.ts';
/**
 * THE ONE ENGINE VALUE THIS FILE IMPORTS, AND IT IS A VOCABULARY WORD.
 *
 * `TurnEngine` is stated structurally and injected precisely so that net/ never
 * calls into the scheduler — that rule is untouched. `StandingOrder` is not a
 * capability, it is the name of a FIELD ALREADY ON THE BODY, and the body is
 * something this file already writes (see `applyRestore`). Spelling it `'hold'`
 * as a literal would typecheck identically and would be the one place in the
 * process where the barrier's vocabulary was copied instead of shared.
 *
 * WHY THIS FILE NEEDS IT AT ALL: `parkForClassChoice` below. A player staring
 * at the chooser owes no decision anybody may wait for, and `standingOrder` is
 * the field engine/barrier.ts:302-303 already reads to mean exactly that.
 */
import { StandingOrder } from '../engine/actor.ts';
// The sentinel a character file carries before it has ever been told what class
// it is. Imported rather than re-typed as a literal — see `classFor`, where the
// difference between "this file predates classes" and "this file names a class
// that was deleted" decides whether a warn-level line is a false alarm.
// saves.ts's only reference back to this file is `import type`, so this arrow
// adds no runtime cycle.
import { UNASSIGNED_CLASS } from '../persist/saves.ts';
import { attackBlockedReason, inspectActor } from '../view/inspect.ts';
import {
  projectActors,
  projectClassOptions,
  projectCooldowns,
  projectEffects,
  projectLoadout,
  projectParty,
  projectPartyState,
  projectProjectiles,
  projectResource,
  projectTurn,
  projectWorld,
  toActorView,
} from '../view/projector.ts';
import type { FastifyPluginAsync } from 'fastify';
import type { DownedState } from '../engine/downed.ts';
import type { EffectState } from '../engine/effects.ts';
import type { Dir, TileXY } from '../../shared/coords.ts';
import type {
  BroadcastMsg,
  ClientChooseClass,
  ClientHello,
  ClientInspect,
  ClientMove,
  ClientParty,
  ClientPoint,
  ClientRevive,
  ClientSay,
  ClientTalent,
  LoadoutTalent,
  LogLine,
  PartyAction,
  ResourceView,
  ServerMsg,
  TurnEvent,
} from '../../shared/protocol.ts';
import type { ClassDef } from '../content/classes.ts';
import type { PartyOffer, TurnState } from '../view/projector.ts';
import type { Actor, PlayerOverlay, World } from '../world/world.ts';

/**
 * Frames larger than this are refused. A `move` is about sixty bytes and the
 * largest thing a client may legally say is a 256-character resume token, so
 * 16 KB is already three orders of magnitude of headroom; the number exists to
 * stop a socket from making the server allocate a megabyte per frame.
 *
 * Enforced TWICE, deliberately: `ws` drops an oversized frame at the protocol
 * level via `maxPayload` (the connection never sees it), and the handler checks
 * again in case that option is ever changed or a future transport does not have
 * one. The cheap check is the one that runs on every frame.
 */
const MAX_FRAME_BYTES = 16 * 1024;

/**
 * THE COMMAND RATE LIMIT — game-design.md § 4, under Griefing: "command spam is
 * rate-limited (20/s) plus the one-pending-intent rule".
 *
 * TWENTY A SECOND IS NOT A HUMAN LIMIT, IT IS A LOOP LIMIT. Nobody types twenty
 * frames a second; a `for (;;) ws.send(...)` does. The one-pending-intent rule
 * already stops a spammed `move` from doing anything to the WORLD — the second
 * one replaces the first — but M4 adds two frames that rule does not cover:
 * `say` and `point` change no state at all, which means nothing else brakes
 * them. A frame that costs the sender nothing must not be a way to make the
 * server broadcast to everyone.
 *
 * A TOKEN BUCKET rather than a fixed window, because a window lets somebody send
 * forty frames across a boundary in 2 ms and stay "within 20/s". The burst is
 * the same as the rate: a client may spend a second's worth at once — which is
 * exactly what a reconnect replay does — and then refills at 20/s.
 */
const COMMAND_RATE_PER_SEC = 20;
const COMMAND_BURST = 20;

/**
 * How often a throttled socket is TOLD it is throttled.
 *
 * Replying to every dropped frame would turn a client-side loop into an
 * amplifier: the server would send one error per rejected frame, which is more
 * traffic than the flood it is defending against. One notice a second is enough
 * for a human to see the message and for a developer to find it in the log.
 */
const RATE_NOTICE_INTERVAL_MS = 1_000;

/**
 * How long the speaking dot stays lit after somebody puts a line in the Margin.
 *
 * SIX SECONDS, which is a guess, and honestly labelled as one: it is long enough
 * that a burst of typing reads as one continuous "they are here" and short
 * enough that the dot is not still lit when the person has walked away from the
 * keyboard. It is the SERVER's half of the indicator — Discord's own
 * `SPEAKING_START`/`SPEAKING_STOP` arrive in the client over `rpc.voice.read`,
 * which docs/discord-activity.md:204 records as available-but-unproven, so this
 * is the half that always works.
 */
const SPEAKING_WINDOW_MS = 6_000;

/**
 * Server-side heartbeat. TCP will not tell us about a laptop that closed its
 * lid — the socket sits half-open for minutes and the player appears frozen in
 * place to everyone else. A ping every 30 s with no pong before the next one
 * means the connection is gone, and `terminate()` gets us to the `close` handler
 * where the body is put on Standing By so the rest of the party can carry on.
 */
const PING_INTERVAL_MS = 30_000;

/**
 * How long a disconnected player's body stays on the map before it is recalled.
 *
 * Ten minutes, from game-design.md § 4. The body stays in the world for the
 * whole of it — this is a MUD, and yanking someone out of a fight the instant
 * their wifi hiccups is both bad fiction and a free escape from a bad position.
 * They are on Standing By throughout, so nobody is ever waiting on them.
 *
 * Overridable per-registration so a test can prove the recall path in a second
 * rather than in ten minutes.
 *
 * DUPLICATED, KNOWINGLY: `RECONNECT_GRACE_MS` in src/server/engine/barrier.ts is
 * the same number, declared there because that is where the Standing By policy
 * lives. It is enforced HERE because the grace is a wall-clock span and the
 * engine may not read a clock. Collapse the two by importing the engine's — the
 * `net -> engine` direction is allowed — the moment either one moves.
 */
const DEFAULT_DISCONNECT_GRACE_MS = 10 * 60_000;

/** `WebSocket.OPEN`. Spelled out because `ws` ships no types (see below). */
const WS_OPEN = 1;

/** RFC 6455 §7.4.1: the peer broke the protocol. Used for a version mismatch. */
const CLOSE_PROTOCOL_ERROR = 1002;

/**
 * 4000-4999 is the application-private range. Sent to the OLDER socket when a
 * resume token is redeemed on a new one, so a reconnecting player does not end
 * up with two live connections fighting over one actor.
 */
const CLOSE_SUPERSEDED = 4001;

/**
 * What `ws` hands a `message` listener: one Buffer, a chunk list, or an
 * ArrayBuffer, depending on how the frame arrived.
 */
type WsFrame = Buffer | ArrayBuffer | Buffer[];

/**
 * The parts of the `ws` socket this gateway touches.
 *
 * `ws@8.21` ships no type declarations and `@types/ws` is not a dependency
 * (adding one is adding a dependency). So the `import * as WebSocket from 'ws'`
 * inside @fastify/websocket's own .d.ts does not resolve, `skipLibCheck` hides
 * the error, and the handler's `socket` parameter arrives as `any` — which would
 * silently switch off type checking for every line of this file and trip
 * no-unsafe-call besides.
 *
 * Annotating the parameter with this structural type puts the compiler back in
 * the loop. It is a narrow, honest description of the four methods and four
 * events used below; if @types/ws is ever added, delete this and import the real
 * one.
 */
type GatewaySocket = {
  readonly readyState: number;
  send(data: string): void;
  ping(): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  on(event: 'message', listener: (data: WsFrame, isBinary: boolean) => void): void;
  on(event: 'pong', listener: () => void): void;
  on(event: 'close', listener: (code: number, reason: Buffer) => void): void;
  on(event: 'error', listener: (err: Error) => void): void;
};

/**
 * Per-connection state. A connection is NOT an actor: it may have none (before
 * `hello`), and — new in M2 — an actor routinely outlives its connection by up
 * to ten minutes.
 */
type Session = {
  readonly connId: string;
  readonly socket: GatewaySocket;
  /** Set once, at `hello`. The only place an identity is ever established. */
  actorId: string | null;
  helloDone: boolean;
  /**
   * `hello` is in flight. It is the one handler that awaits (it reads a
   * character file before it touches the world), so a second `hello` arriving
   * during that await would start a second load and end with two bodies for one
   * socket. `helloDone` cannot cover the gap because it is only set at the end.
   */
  helloPending: boolean;
  /**
   * The opaque auth handle this socket presented, or null for anonymous play.
   *
   * KEPT ONLY TO SLIDE THE SESSION'S IDLE EXPIRY on each heartbeat —
   * src/server/http/session.ts is written around "a live WebSocket keeps its
   * session alive", and this is the half of that sentence that lives here. It is
   * a BEARER CREDENTIAL: it must never be logged, never broadcast, never written
   * to a save file, and never put in an error body.
   */
  sessionId: string | null;
  /**
   * The VERIFIED Discord user this socket belongs to, or null for anonymous
   * play. Server-side only: it keys the character file and nothing else, and it
   * never reaches `projectActors`, a log line or another client. See
   * `actorIdForUser` for the id that does travel.
   */
  ownerId: string | null;
  /** Heartbeat liveness: set by `pong`, cleared by each outgoing `ping`. */
  alive: boolean;
  /**
   * The last hotbar state sent to THIS socket, as a comparison key, so the two
   * viewer-private frames go out only when they changed. Same trick as
   * `turnKey`, and per-session rather than per-actor because a resumed
   * connection has seen nothing and must be told everything.
   */
  viewerKey: string | null;
  /**
   * The last `party_state` sent to THIS socket, as a comparison key.
   *
   * SEPARATE FROM `viewerKey` because the two change on completely different
   * schedules: the hotbar moves every time a cooldown ticks, and the party pane
   * moves when somebody joins, leaves, drops or is invited — which is a handful
   * of times an evening. Folding them into one key would resend the pane on
   * every game turn for the sake of one fewer field.
   */
  partyKey: string | null;
  /**
   * THE RATE LIMITER, per SOCKET rather than per actor.
   *
   * Per socket because the thing being limited is a sender, not a character: a
   * reconnect gets a fresh bucket (it has a second's worth of replay to do), and
   * a body with nobody attached sends nothing at all. `tokens` is fractional —
   * it refills continuously from `tokensAtMs` rather than in whole units, so a
   * client sending nineteen frames spread over a second is never refused.
   */
  tokens: number;
  tokensAtMs: number;
  /** When this socket was last TOLD it is throttled. See RATE_NOTICE_INTERVAL_MS. */
  rateNoticeAtMs: number;
};

/**
 * The outcome of a `hello`. `resumed` matters because a reattached actor is
 * already on everyone's screen: announcing it again would duplicate the token.
 */
type ResolvedActor = {
  readonly actor: Actor;
  readonly resumed: boolean;
  /**
   * The name on the body changed under a reattachment — somebody edited their
   * Discord global name between sessions. Only meaningful when `resumed`, and it
   * is what makes the gateway resend the actor list: `name` travels on
   * `ActorView`, so without a resync everyone else keeps drawing the old one.
   */
  readonly renamed: boolean;
};

/**
 * A verified person, as this file uses them. Everything here came out of
 * `SessionStore.get`, which can only hold what `auth.ts` put there after a
 * server-side `GET /users/@me`.
 */
type VerifiedPlayer = {
  /** The raw Discord snowflake. NEVER leaves this process. Keys the save file. */
  readonly ownerId: string;
  /** Their Discord global name, already scrubbed by `safeDisplayName`. */
  readonly displayName: string;
  /** The derived, stable, snowflake-free actor id. See `actorIdForUser`. */
  readonly actorId: string;
};

// ---------------------------------------------------------------------------
// IDENTITY — the one place a Discord user becomes an actor id
// ---------------------------------------------------------------------------

/**
 * Domain separation. Prefixed so this digest can never equal a hash of the same
 * snowflake computed for some other purpose (an avatar cache key, a log tag),
 * which is how two unrelated systems accidentally become a correlation handle.
 */
const ACTOR_ID_DOMAIN = 'inner-datum/actor-id/v1:';

/**
 * 16 hex characters — 64 bits. With under ten players a collision needs a
 * birthday event around 2^32 accounts, so the id is unique by construction and
 * short enough to read in a log line.
 */
const ACTOR_ID_HEX = 16;

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE ACTOR ID FOR A VERIFIED DISCORD USER. STABLE, AND NOT A SNOWFLAKE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * STABLE is the feature: the same account gets the same actor id on every
 * connection, every reconnect and every server restart, so a returning player
 * finds their own character rather than a fresh `Player 3`. It is a pure
 * function of the snowflake — no counter, no table, nothing to lose.
 *
 * NOT THE SNOWFLAKE ITSELF, and that is the point. `ActorView.id` is
 * BROADCAST: it is on every `moved`, every `joined`, every `party` row, in
 * every client's memory and in the Case Log. CLAUDE.md non-negotiable 7 says
 * `data/` holds real people's Discord ids and that a log excerpt with a raw
 * snowflake in it must never be committed — the only way to be sure of that is
 * for the snowflake never to enter the wire, the log or a client at all. The
 * hash is where that is enforced, once, for everything downstream.
 *
 * WHAT THIS IS NOT: a secrecy claim. A snowflake has structure and is not
 * high-entropy, so somebody holding a candidate id can confirm a guess by
 * hashing it. That is fine and it is the honest framing — this is CONTAINMENT
 * ("no snowflake is ever spelled out anywhere it could be pasted"), not
 * encryption. Everyone in the party is in the same voice channel and already
 * knows who everyone is; what they must not receive is a machine-readable
 * identifier for a friend, sitting in a JSON frame, forever.
 *
 * `actor_u_` rather than `actor_` so a stored id says at a glance whether it
 * belongs to a verified account or to an anonymous `randomUUID` body. Both
 * shapes satisfy `sanitiseId` in persist/saves.ts, which is what lets either
 * appear in a path component without a second rule.
 */
export function actorIdForUser(discordUserId: string): string {
  const digest = createHash('sha256')
    .update(ACTOR_ID_DOMAIN)
    .update(discordUserId, 'utf8')
    .digest('hex');
  return `actor_u_${digest.slice(0, ACTOR_ID_HEX)}`;
}

/**
 * The session table, as the gateway needs it — ONE METHOD.
 *
 * INJECTED AND DECLARED STRUCTURALLY, exactly like `TurnEngine` below. The real
 * implementation is `SessionStore` in src/server/http/session.ts and it
 * satisfies this without either file importing the other: main.ts creates one
 * store and hands the same instance to the auth routes (which write to it) and
 * to this plugin (which reads from it). Two stores would be two answers to "who
 * is this", and the socket would always get the empty one.
 *
 * Narrow on purpose. The gateway has no business revoking a session, sweeping
 * the table or reading its size, and a port that cannot express those is a port
 * that cannot grow a reason to.
 */
export type IdentityPort = {
  /**
   * Resolve an opaque handle, sliding its idle expiry. `undefined` for a handle
   * that is unknown, expired or simply absent — all three mean the same thing
   * here, which is anonymous play.
   */
  get(
    id: string | undefined,
  ): { readonly user: { readonly id: string }; readonly displayName: string } | undefined;
};

// ---------------------------------------------------------------------------
// THE ENGINE PORT
// ---------------------------------------------------------------------------

/**
 * Whether the scheduler accepted an intent AT SUBMISSION.
 *
 * Deliberately thin, because most legality is NOT decided here. Legality is
 * checked at RESOLUTION (game-design.md § 4) so that an intent which went
 * illegal in between — the target died, you were knocked out of range — costs
 * zero energy and re-prompts. That refund is what removes hesitation, and
 * hesitation is the disease being cured.
 *
 * What a submission CAN refuse is what cannot change between now and
 * resolution: terrain (a wall does not move), and standing (you are not parked,
 * you already committed, you are on Standing By).
 *
 * What it must NOT refuse is an occupied tile. A step into a hostile body is a
 * BUMP-ATTACK, and whether the body is still there — or still hostile, or still
 * alive — is a resolution-time question.
 */
export type IntentResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/**
 * The codes a talent submission may be refused with.
 *
 * `Extract` from `ErrorCode` rather than a parallel union, so the engine speaks
 * the client's vocabulary directly and there is NO translation table in the
 * middle. A mapping switch here would be one more place for `too_close` to be
 * quietly turned into `out_of_range` — which is the single mislabelling this
 * whole design is trying to prevent, because the two carry opposite
 * instructions to the player.
 *
 * The extraction is not decoration either: it is what stops the engine from
 * answering `internal` or `version_mismatch`, both of which mean something the
 * turn layer has no standing to claim.
 */
export type TalentRefusal = Extract<
  ErrorCode,
  | 'bad_message'
  | 'not_your_turn'
  | 'illegal_move'
  | 'out_of_range'
  | 'too_close'
  | 'on_cooldown'
  | 'no_resource'
  | 'no_los'
>;

/**
 * Whether a talent may be SUBMITTED.
 *
 * Thicker than `IntentResult` on purpose, and the asymmetry is honest: a `move`
 * has one way to fail that a client can act on, whereas a talent has seven, and
 * a targeting UI that cannot tell them apart teaches the player nothing. `code`
 * is what the client branches on to flash the right control; `reason` is the
 * sentence for the log and the error line.
 */
export type TalentResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: TalentRefusal; readonly reason: string };

/**
 * What a `party` frame produced.
 *
 * `affected` IS THE WHOLE REASON THIS IS NOT AN `IntentResult`. `party_state`
 * goes to the affected members ONLY, and the gateway cannot work out who they
 * are: an accept changes the frame for two whole parties, and by the time the
 * gateway could ask, one of them has ceased to exist. So the engine — which
 * captured both member lists before it touched either — says.
 */
export type PartyCommandResult =
  | {
      readonly ok: true;
      /** Every actor whose `party_state` is now different. Deduplicated. */
      readonly affected: readonly string[];
      /** One Record line for the Case Log. Already prose, already name-filtered. */
      readonly notice: string;
    }
  | { readonly ok: false; readonly reason: string };

/**
 * ONE PLAYER'S PARTY, with every wall-clock question already answered.
 *
 * `expiresInMs` rather than an absolute deadline because this crosses into
 * src/server/view/**, where `Date.now` is an ESLint error — the same shape
 * `bellMs` travels in, and for the same reason.
 */
export type PartySnapshot = {
  /** Always one of `members`. A leaderless party is not representable. */
  readonly leaderId: string;
  /** Join order, stable. Never empty — a solo player is a party of one. */
  readonly members: readonly string[];
  /** Offers waiting on THIS player, oldest first. Never ones they sent. */
  readonly invites: readonly PartyOffer[];
};

/**
 * What one synchronous turn of the world produced.
 *
 * TWO EVENT LANES, AND THE SPLIT IS THE POINT.
 *
 *   `playerEvents` is what a HUMAN just did. It resolved the instant the frame
 *   arrived and must animate at once — pacing your own attack behind a queue is
 *   how a turn-based game starts to feel laggy on the one input you care about.
 *   The gateway fans these out as individual `moved` / `attacked` / `damaged` /
 *   `died` frames.
 *
 *   `sweep` is what the WORLD did: every monster that acted between two player
 *   parks. It goes out as exactly ONE `sweep` message however many monsters
 *   moved, and the client paces the playback. Four players watching eight
 *   monsters each take an individually-timed turn is the second-most-common way
 *   co-op turn-based dies, and the structural cure is that the server has no way
 *   to send them one at a time.
 *
 * Splitting them in the RETURN TYPE rather than sorting them in the gateway is
 * what makes that a compile-time fact instead of a rule someone remembers.
 */
export type PumpResult = {
  /**
   * `parked` — at least one player owes a decision; `turn` says who.
   * `idle`   — fixed point. Nothing gained energy, nothing spent any. No clock
   *            advanced on the way out, so pumping an idle level is free and
   *            cannot be farmed for regeneration by a client spamming frames.
   * `budget` — the tick budget ran out. State is consistent; pump again.
   */
  readonly status: 'parked' | 'idle' | 'budget';
  readonly turn: TurnState;
  readonly playerEvents: readonly TurnEvent[];
  readonly sweep: readonly TurnEvent[];
  /**
   * INTENTS THE SCHEDULER TOOK BACK. Not events — the OWNER'S OWN BAD NEWS.
   *
   * A third list rather than a third kind of `TurnEvent`, because a refund has
   * nothing to draw and nobody else's business: `toWireEvents` drops `refunded`
   * on purpose (turn-engine.ts) and must go on doing so.
   *
   * ═══ WITHOUT THIS THE OWNER IS TOLD NOTHING AT ALL ═══
   * A move accepted by `submitMove` and refused at RESOLUTION — the tile was
   * clear when the packet left and somebody stepped onto it in flight — takes
   * scheduler.ts's refund path: zero energy spent, `Park` returned,
   * `pendingIntent` back to null. So no clock advances, the actor goes straight
   * back into the blocking set it was already in, and EVERY term of `turnKey`
   * (gameTurn, engagement, whoseTurn, committed, standingBy, bellArmed) is
   * byte-identical — `broadcastTurnIfChanged` sends nothing, and there is no
   * `moved` and no `error` either. The client learns of the refusal by absence,
   * which is not a signal: "no frame yet" and "no frame ever" look identical.
   *
   * That is not a cosmetic gap. A travelling client (src/client/input/travel.ts)
   * waits on a `moved` that will never come, and because the party is
   * phase-locked the whole floor then waits on it until the Bell rings.
   */
  readonly refusals: readonly RefundedIntent[];
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * MONSTERS THAT DIED IN THIS PUMP AND ARE STILL IN THE WORLD.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * THE ENGINE ENROLS; THIS FILE BURIES. `pumpAndBroadcast` drains this list
   * through `TurnEngine.reap` in the one window where it is safe — after the
   * Record lane has narrated the kill and before the resync ships the actor
   * list. Reap any earlier and two readers degrade silently: `hitToWire` ships
   * `maxHp: 0` and `nameOf` narrates "someone is unfiled".
   *
   * IT DOES NOT SAVE AN ORB IN FLIGHT, whatever this note used to say. The
   * window is one pump wide and the wraith's shot arrives two or three game
   * turns later; `reapedNames` below is what keeps that impact attributable.
   *
   * ═══ AND THE LIST IS PRE-FILTERED AGAINST A FLOOR RESET ═══
   * `createTurnEngine.pump` drops any id whose body was replaced by
   * `reseedFloor` inside the same pump — see `enrolled` in turn-engine.ts.
   * Without that, a wipe that happened on the same turn as a kill had the
   * gateway delete the FRESHLY re-seeded monster wearing the dead one's id.
   *
   * OPTIONAL, LIKE `submitRevive` AND `submitRespawn` ABOVE, and it travels with
   * `TurnEngine.reap`: an engine that supplies neither is the pre-reaping
   * engine, where a corpse stays on the map. That was the shipped behaviour
   * until this milestone, so it has to remain expressible — and a required
   * field here would be a field every hand-written test scheduler has to carry
   * for one branch's benefit.
   */
  readonly reaped?: readonly string[];
};

/**
 * One refunded intent, addressed to the actor that owed it.
 *
 * `reason` is a `string` for the same reason `IntentResult.reason` is: the
 * gateway only ever puts it in a message, and widening the engine's `Refusal`
 * union into net/ would be a second place to keep it in step.
 */
export type RefundedIntent = { readonly id: string; readonly reason: string };

/**
 * Everything the gateway needs from `src/server/engine/scheduler.ts`.
 *
 * INJECTED, NOT IMPORTED. The dependency rule is one-way — eslint bans
 * `engine/** -> net/**` — and stating the contract structurally here means the
 * engine satisfies it without importing this file, the gateway compiles without
 * importing the engine, and a test can register this plugin against a fake
 * scheduler to drive the barrier without a world.
 *
 * EVERY METHOD IS SYNCHRONOUS. None of them may return a promise, and that is
 * not a style preference: the moment resolution goes async, a second frame can
 * interleave mid-turn and produce a desync that depends on network timing and
 * cannot be reproduced locally.
 */
export type TurnEngine = {
  /** Enrol a newly-created actor in the scheduler. Idempotent. */
  join(actorId: string): void;
  /**
   * ═════════════════════════════════════════════════════════════════════════
   * GIVE THIS BODY A CLASS — the loadout, the resource pool, the AP/MP budget.
   * ═════════════════════════════════════════════════════════════════════════
   *
   * INJECTED, NOT IMPORTED, and this one is worth stating plainly because the
   * alternative looks so easy: attaching a sheet is two lines
   * (`talents.attach(id, sheetForClass(def))`) and writing them HERE would put
   * `engine/talents.ts` into net/'s import graph. This file's whole contract
   * with the engine is structural for that reason — see the note above.
   *
   * The gateway already knows the class: it picked it, it is on the body as
   * `PlayerActor.classId`, and it is in the save file. What it does not know,
   * and must not learn, is what a class DOES.
   *
   * OPTIONAL. An engine with no talent book has no sheets to attach, and a
   * method that was always present and did nothing would leave this file unable
   * to tell "this build has no classes" from "the attach silently failed".
   *
   * IDEMPOTENT AND CALLED ONCE — beside `engine.join`, on a FRESH body only. A
   * resumed body still has its sheet, with the cooldowns and the resource it
   * left with; re-attaching would hand a returning player a full Resolve bar.
   */
  attachClass?(actorId: string, classId: string): void;
  /**
   * BURY ONE MONSTER — the full cleanup contract, ending with the world.
   *
   * Drain `PumpResult.reaped` through this and broadcast one `left` per body.
   * Answers false for a player, for an unknown id and for anything already
   * reaped, so calling it twice is free.
   *
   * OPTIONAL, and it travels with `PumpResult.reaped` — see that field.
   */
  reap?(actorId: string): boolean;
  /** Remove an actor entirely — the body is gone, not merely unattended. */
  leave(actorId: string): void;
  /**
   * Presence. `false` puts the actor on Standing By immediately, with no Bell
   * delay, so the party runs at full speed while their body stands there.
   */
  setConnected(actorId: string, connected: boolean): void;
  /** One step. Replaces any unresolved intent — you changed your mind. */
  submitMove(actorId: string, dir: Dir): IntentResult;
  /**
   * USE A TALENT, AND VALIDATE IT PROPERLY. The whole M3 feature lives behind
   * this one method.
   *
   * Range, the `min_range` dead zone, line of sight, the cooldown, the resource
   * and whether the talent is in this actor's loadout at all are ALL decided
   * server-side, from the server's own world. The client's targeting overlay is
   * a convenience that draws the same rules; it is never consulted and never
   * trusted. A hand-crafted frame from a devtools console is the normal case
   * this method is written for.
   *
   * `target` is a TILE, never an actor id — that is what an AoE needs, it is
   * what the player actually clicked, and which body is standing there at
   * resolution is a resolution-time question. Absent for a `self` shape.
   */
  submitTalent(actorId: string, talentId: string, target?: TileXY): TalentResult;
  /**
   * This actor's own hotbar, in slot order. Empty for an actor without one.
   *
   * Here rather than on the world because a loadout is authored content and the
   * gateway must not learn to read the content tree — the engine already holds
   * the book in order to validate against it, so it is also the one thing that
   * cannot answer this question inconsistently with `submitTalent`.
   */
  loadoutOf(actorId: string): readonly LoadoutTalent[];
  /** This actor's own class resource, or undefined for an actor without one. */
  resourceOf(actorId: string): ResourceView | undefined;
  /** "I have finished my turn." */
  commit(actorId: string): IntentResult;
  /** "Pass this turn." */
  hold(actorId: string): IntentResult;
  /**
   * PICK UP THE DOWNED ALLY IN `dir` (game-design.md § 9).
   *
   * OPTIONAL, AND THAT IS A SEAM RATHER THAN A SHRUG. Revive is meaningless
   * until the engine has a Downed state to revive FROM — a 5-turn timer, a body
   * at 0 hp that is *Unfiled* rather than dead, and the AP to spend on standing
   * it back up. Until that lands, an engine simply does not offer the method and
   * the gateway answers the frame with a sentence that says exactly that.
   *
   * The alternative — a method that is always present and always refuses — would
   * be a stub that lies: the client cannot tell "nobody is down beside you" from
   * "this server cannot do revives", and the player is left pressing a key that
   * does nothing. The honest failure is the one that names itself.
   *
   * A DIRECTION, never an ally id. Identity never travels on the wire, and the
   * tile beside you is the only place a revive can happen.
   */
  submitRevive?(actorId: string, dir: Dir): IntentResult;
  /**
   * STAND YOUR OWN ERASED BODY BACK UP (game-design.md § 9 — no permadeath).
   *
   * NO PARAMETERS BEYOND THE SENDER, and that is the whole security surface:
   * there is no id to name and no direction to aim, so this verb cannot reach
   * another player's body even by accident. The frame carries nothing at all.
   *
   * OPTIONAL FOR THE SAME REASON `submitRevive` IS: an engine with no survival
   * table has nobody Erased to restore, and a method that was always present and
   * always refused would leave the client unable to tell "you are not erased"
   * from "this build cannot do this". The honest failure names itself.
   *
   * WHY IT EXISTS: real play stranded somebody. A player whose five turns ran
   * out is Erased, `revive` refuses an erased body by design, and the party wipe
   * that would have reset the floor could not fire while a disconnected friend's
   * body still counted as a survivor. Both halves are fixed — this is the half a
   * player can reach for themselves.
   */
  submitRespawn?(actorId: string): IntentResult;
  /**
   * ═════════════════════════════════════════════════════════════════════════
   * WHO YOU ARE PLAYING WITH — invite / accept / decline / leave / kick.
   * ═════════════════════════════════════════════════════════════════════════
   *
   * THE FEATURE THIS METHOD IS: the barrier used to be LEVEL-WIDE, so every
   * player on the floor blocked every other one. That is right for people
   * playing together and wrong for two groups who are not, and real play found
   * the wrong half — a solo player waited on a stranger, and then on a stranger
   * who had closed the tab. An explicit party is the set the barrier scopes to.
   *
   * IT DOES NOT PUMP AND IT DOES NOT COST A TURN. Party commands are like `say`
   * rather than like `move`: no energy, no barrier check, and they work while
   * the sender is Downed or Erased — which is exactly the moment somebody most
   * needs to ask a friend to come and get them.
   *
   * OPTIONAL FOR THE SAME REASON `submitRevive` AND `submitRespawn` ARE: an
   * engine with no party table has nothing to change, and a method that was
   * always present and always refused would leave the client unable to tell
   * "you cannot do that" from "this build cannot do that".
   *
   * `targetId` IS AN ACTOR ID AND IT IS THE OBJECT OF THE VERB, NEVER ITS
   * SUBJECT. Who is asking is still resolved from the session, exactly as with
   * `move`; this names who is being invited or removed, which is a body the
   * sender was already sent in `ActorView`. protocol.ts's `PartySchema` carries
   * the full argument. The engine refuses any target that is not a live player.
   */
  submitParty?(actorId: string, action: PartyAction, targetId?: string): PartyCommandResult;
  /**
   * This player's party, with wall-clock invite expiry already applied.
   *
   * Undefined for an engine with no party system, which is what tells this file
   * to send no pane at all rather than one describing an invented party of one.
   */
  partySnapshot?(actorId: string): PartySnapshot | undefined;
  /**
   * The Bell rang. Every straggler holds — NEVER a random attack, which gets
   * someone killed and ends friendships. Called by this file's timer and by
   * nothing else.
   *
   * ONE TIMER, EVERY PARTY. With per-party barriers there is one countdown per
   * party and still one wall clock; the timer is armed for the SOONEST deadline
   * and this method sweeps them all, each against its own. A party that still
   * has time returns nothing, so a single wake-up is safe for any number.
   */
  bellExpired(): void;
  /** Advance the world as far as it will go. SYNCHRONOUS. */
  pump(): PumpResult;
  /**
   * The barrier right now, without advancing anything.
   *
   * @param viewerId whose PARTY to describe. Omitted means the whole level,
   *   which is what this file's "has the barrier changed?" key is built from —
   *   the level-wide blocking set is the exact union of every party's, so one
   *   cheap comparison cannot miss a per-party change, and the per-recipient
   *   frames are then built from per-recipient snapshots.
   */
  turnState(viewerId?: string): TurnState;
};

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE PERSISTENCE SEAM. THE ONLY ASYNC THING THE TURN PIPELINE MAY TOUCH.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `src/server/engine/**` cannot reach persistence at all — eslint.config.js bans
 * `engine -> persist|net|ops|http` outright, with the message "Persistence is
 * queued by the CALLER after pump returns." THIS is that caller, and this port
 * is where the queueing happens.
 *
 * IT RETURNS VOID, AND THAT IS THE LOAD-BEARING PART. A method that returned a
 * promise would invite an `await` in the frame handler, and the first `await`
 * inside a turn lets a second WebSocket frame interleave mid-resolution — a
 * desync that depends on network timing and cannot be reproduced locally.
 * Synchronicity IS the mutex (CLAUDE.md non-negotiable 2). So the gateway hands
 * over a list of ids and forgets; the persist layer owns the debounce, the
 * batching, and the atomic write.
 *
 * RISK R9 LIVES ON THE OTHER SIDE OF THIS LINE. On Windows `fs.rename` throws
 * EPERM/EBUSY while Defender or the search indexer holds the destination open,
 * `write-file-atomic` has no retry, and `graceful-fs`'s retry only fires when
 * the destination is ABSENT — i.e. never, for an overwrite. The mitigation is a
 * hand-rolled atomic write with a same-directory temp file, `fh.sync()`, rename
 * with exponential backoff and NO parent-directory fsync on win32. None of that
 * belongs here; all of it belongs behind this one method.
 */
/**
 * A character on its way to a file: PLAIN DATA, never a live `Actor`.
 *
 * WHY THE GATEWAY BUILDS THIS RATHER THAN HANDING OVER IDS. The persist layer
 * would otherwise need a reference to the world in order to answer "what is this
 * character's hp", which would put a second reader of live actor objects behind
 * an async boundary — the one place a half-written turn could be observed. A
 * snapshot is taken synchronously, immediately after `pump` returned, and is
 * frozen in time from that instant; what the disk eventually writes is a state
 * the world really was in.
 *
 * It also keeps `src/server/persist/**` free of engine types, which is why
 * `createCharacterFile` in saves.ts already insists on plain data.
 *
 * NO OWNER FIELD. Which Discord account a body belongs to was established at
 * `hello` and is remembered by the persist layer; putting it on every snapshot
 * would mean a snowflake travelling through one more function, several times a
 * second, for no gain.
 */
export type CharacterSnapshot = {
  readonly actorId: string;
  readonly name: string;
  readonly hp: number;
  /** Talent id -> GAME TURNS remaining. Absent means ready. */
  readonly cooldowns: Readonly<Record<string, number>>;
  readonly x: number;
  readonly y: number;
  /**
   * WHICH CLASS THIS BODY IS, as the label the file is filed under.
   *
   * OPTIONAL, AND THE OPTIONALITY IS THE HONEST SHAPE rather than a
   * convenience. `PlayerActor.classId` is itself optional — a classless body is
   * a real thing (a fixture, the e2e harness, a build with no content wired in)
   * — so a required field here would force every producer to invent a class for
   * a body that has none. The bridge answers the absence with the binding's own
   * value, which is `unassigned` until a class is genuinely assigned.
   *
   * A PLAIN STRING, never `ClassId`: it is a SOFT reference all the way to the
   * disk (persist/saves.ts), so a save written by a build with a fourth class
   * still round-trips through this one.
   */
  readonly classId?: string;
};

/**
 * What a character file has to say to a body that has just been created.
 *
 * DELIBERATELY SMALL, and each absence has a reason:
 *
 *   NO NAME. The display name is whatever Discord says it is today, not what it
 *   was the last time this character was saved. A player who renames themselves
 *   expects to see the new name.
 *
 *   NO POSITION. `SavedPosition` is per-zone and the world is rebuilt from its
 *   seed at boot, so a saved tile is a coordinate in a level that no longer
 *   exists in the same state. Restoring it would also mean writing to `actor.x`
 *   outside `tryMove`, which world.ts calls its whole point. The party regroups
 *   at the spawn cluster, which is both safe and the right fiction for a session
 *   that ended. It is still SAVED — see `CharacterSnapshot` — because the file
 *   is read by humans and because zones are what make it restorable later.
 *
 *   NO EFFECTS. Statuses are a fight's state measured in single-figure turns,
 *   and a save happens at a session boundary. saves.ts's own header says the
 *   same thing about the two energy clocks, for the same reason.
 */
export type CharacterRestore = {
  /** Null when the file had no usable figure; the class default then stands. */
  readonly hp: number | null;
  readonly cooldowns: Readonly<Record<string, number>>;
  /**
   * ═══ THE CLASS DOES COME BACK, AND IT IS THE ONE THING THAT MUST ═══
   *
   * The three absences above are all things that are better re-derived than
   * restored. A class is the opposite: there is no chooser yet, so the ONLY
   * record that this account plays the Watchman is this string, and losing it
   * would re-roll somebody's character off a per-process rotation counter every
   * time they reconnected.
   *
   * NULL ON FIRST SIGHT, and null is a real answer rather than a failure: an
   * account with no file, an anonymous socket, a file this build refused to
   * bind. All of them mean "pick one" — see `classForJoin`.
   *
   * A DANGLING id IS NOT AN ERROR EITHER. It is carried through verbatim, and
   * the caller substitutes and logs; `classById` answering undefined is the
   * whole of the check. A file naming a class this build no longer has must
   * still let its owner play.
   */
  readonly classId: string | null;
};

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * PERSISTENCE, AND WHO IS ALLOWED TO BE PERSISTED
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ONLY VERIFIED PLAYERS HAVE FILES. `openCharacter` is the only thing that ever
 * binds an actor to an owner, and it is called only for somebody a server-side
 * `GET /users/@me` has named. An anonymous body — plain-browser development,
 * tools/e2e-m1.mjs, a friend whose auth round-trip failed — is never bound, so
 * every later save silently skips it. That is the correct answer rather than a
 * limitation: there is nothing to key the file on, and minting an id for the
 * purpose would scatter `data/characters/` with orphan directories that nobody
 * can ever reclaim, because nobody can prove they own one.
 */
export type PersistPort = {
  /**
   * "These characters changed. Save them when you can."
   *
   * MAY BE CALLED SEVERAL TIMES A SECOND and must be cheap — it is invoked after
   * every pump that did anything. Coalescing is the implementation's job, not
   * the caller's: a debounce here would be a second timer in the file that
   * already owns the Bell, and it would have to be cancelled on shutdown by
   * somebody who does not know what a save is.
   *
   * MUST NOT THROW. It is called from inside `guard` anyway, because an
   * exception escaping this into a `ws` handler kills the PROCESS and with it
   * everyone's session — but a save layer that throws on a locked file rather
   * than retrying is R9 happening in production.
   */
  savePlayers(snapshots: readonly CharacterSnapshot[]): void;
  /**
   * A CRITICAL EVENT: write now, do not wait for the debounce (saves.ts's
   * `SaveReason` — death, disconnect, level change, shutdown).
   *
   * Still void, still fire-and-forget, for exactly the reason `savePlayers` is:
   * the frame the player is waiting for must not queue behind a disk.
   *
   * Optional so an implementation that only ever autosaves stays valid; absent
   * means the critical events fall back to the debounce, which loses at most the
   * last few seconds.
   */
  savePlayersNow?(snapshots: readonly CharacterSnapshot[], reason: string): void;
  /**
   * A VERIFIED PLAYER IS JOINING. Bind this actor to this Discord account and
   * hand back whatever their character file says, or null on first sight.
   *
   * THE ONE ASYNC CALL IN THE FRAME PATH, and the whole reason it is safe is
   * WHERE it is awaited: `hello`, before a single line of the world has been
   * touched, with no pump in flight and no intent submitted. Nothing can
   * interleave with a turn because there is no turn. See `handleHello`.
   *
   * MUST NOT REJECT. A missing, corrupt or newer-than-us file is `null` plus a
   * log line — a character nobody can load is a bad evening, and a crash here is
   * everybody's evening.
   */
  openCharacter?(ownerId: string, actorId: string): Promise<CharacterRestore | null>;
  /** The body is gone for good (the grace expired). Drop the binding. */
  closeCharacter?(actorId: string): void;
};

export type WsGatewayOptions = {
  readonly world: World;
  readonly engine: TurnEngine;
  /** Defaults to ten minutes. Shorten it in tests, never in production. */
  readonly disconnectGraceMs?: number;
  /**
   * The badge source (engine/effects.ts). Absent → no `effects` frame is ever
   * sent, which is exactly right for a server with no statuses wired in: an
   * empty frame every pump would be noise that says nothing.
   *
   * The SAME instance the turn engine ticks. Two would be two answers to "is
   * that one still stunned?".
   */
  readonly effects?: EffectState;
  /**
   * The survival table (engine/downed.ts). Absent → nobody is ever Downed, and
   * the party panel says so honestly rather than inventing a timer.
   *
   * Again the SAME instance `createTurnEngine` was given — src/server/main.ts
   * creates it once and hands it to both.
   */
  readonly downed?: DownedState;
  /**
   * Where character files go. Absent → nothing is persisted, which is the M3
   * behaviour and still the right default for a test that boots a world in
   * memory. See `PersistPort`.
   */
  readonly persist?: PersistPort;
  /**
   * THE SESSION TABLE — how an opaque `sessionId` on a `hello` becomes a person.
   *
   * The SAME instance src/server/main.ts hands to `authRoutes`. Absent → nobody
   * is ever verified and every player is anonymous, which is precisely the
   * plain-browser development path and what tools/e2e-m1.mjs runs against.
   *
   * NOT TO BE CONFUSED with the `sessions` map inside this plugin, which holds
   * CONNECTIONS. This one holds people. They are always reached as
   * `opts.sessions` and `sessions` respectively, and their types have nothing in
   * common, so the compiler catches any confusion between them.
   */
  readonly sessions?: IdentityPort;
};

function frameBytes(raw: WsFrame): number {
  if (Buffer.isBuffer(raw)) return raw.byteLength;
  if (Array.isArray(raw)) return raw.reduce((total, chunk) => total + chunk.byteLength, 0);
  return raw.byteLength;
}

/**
 * Decode a frame to text. Handles all three shapes `ws` can deliver — note that
 * `raw.toString('utf8')` is WRONG for the chunk-list case: Array's toString
 * ignores the argument and joins with commas, which produces plausible-looking
 * garbage rather than an error.
 */
function frameText(raw: WsFrame): string {
  if (Buffer.isBuffer(raw)) return raw.toString('utf8');
  if (Array.isArray(raw)) return Buffer.concat(raw).toString('utf8');
  return Buffer.from(raw).toString('utf8');
}

/**
 * The envelope version, if the frame carries a numeric one.
 *
 * `parseClientMsg` also reports a version mismatch, as prose in its error
 * string. This checks structurally instead of matching that text, because a
 * mismatch is the one failure that CLOSES the connection: an old client that
 * keeps talking gets progressively more confusing errors, and rewording a
 * message in protocol.ts must not silently downgrade a close to a warning.
 */
function wireVersion(payload: unknown): number | undefined {
  if (typeof payload !== 'object' || payload === null || !('v' in payload)) return undefined;
  const version: unknown = payload.v;
  return typeof version === 'number' ? version : undefined;
}

/**
 * The frame for one player-lane event.
 *
 * A total mapping over `TurnEvent`, with no `default:` — `switch-exhaustiveness-
 * check` runs with `considerDefaultExhaustiveForUnions: false`, so adding an
 * event kind breaks this function at lint time rather than silently dropping
 * that event on the floor for the rest of the milestone.
 *
 * `move` becomes the M1-shaped flat `moved` rather than an event wrapper. That
 * is deliberate: it is by far the commonest frame in the game, every client
 * already handles it, and the sweep's `MoveEvent` carries the extra `fromX`/
 * `fromY` that only a paced replay needs.
 *
 * The return type is `BroadcastMsg`, not `ServerMsg`: everything in the player
 * lane goes to the whole room, so a viewer-private frame must not be
 * constructible here even by accident.
 *
 * ═══ NULL IS A REAL ANSWER, AND M4 IS WHY ═══
 * The five M4 event kinds — effect_applied, effect_expired, downed, revived,
 * erased — have NO immediate-lane wrapper, on purpose. Every one of them is a
 * CONSEQUENCE of an action that already produced a frame, and every one of them
 * is also carried by a COMPLETE snapshot sent in the same pump: `effects` says
 * who has what on them, `party` says who is down and for how many more turns.
 * Minting `afflicted`/`cleared`/`downed`/`revived`/`erased` messages as well
 * would be five more members of `ServerMsg`, five more cases in every client
 * switch, and two sources of truth for a badge — which is the bug `cooldowns`
 * documents at length: a patch stream and a snapshot that disagree leave a Stun
 * icon on a monster forever.
 *
 * Inside a `sweep` they need no wrapper at all: that frame carries a whole
 * `TurnEvent[]`, so the client's paced playback pops the badge on the right
 * beat. This function only covers the immediate lane.
 *
 * Returning null rather than omitting the cases keeps the switch TOTAL, so the
 * next event kind still breaks this function at lint time and its author still
 * has to decide, in writing, which lane carries it.
 */
function messageForEvent(event: TurnEvent): BroadcastMsg | null {
  switch (event.k) {
    case 'move':
      return { v: PROTOCOL_VERSION, t: 'moved', id: event.id, x: event.x, y: event.y };
    case 'attack':
      return { v: PROTOCOL_VERSION, t: 'attacked', ev: event };
    case 'damage':
      return { v: PROTOCOL_VERSION, t: 'damaged', ev: event };
    case 'death':
      return { v: PROTOCOL_VERSION, t: 'died', ev: event };
    // The FX stamp is public — everyone watching should see the Alchemist throw
    // the vial. What stays private is the hotbar it came off.
    case 'talent':
      return { v: PROTOCOL_VERSION, t: 'used', ev: event };
    // M4. Delivered by `effects` / `party` in the same pump, and by the batch
    // inside a `sweep`. See the note above.
    case 'effect_applied':
    case 'effect_expired':
    case 'downed':
    case 'revived':
    case 'erased':
      return null;
  }
}

/**
 * Did this pump change something no incremental frame can express?
 *
 * THREE EVENTS REWRITE A BODY IN A WAY THE DELTAS DO NOT CARRY, and all three
 * are survival (engine/downed.ts, game-design.md § 9):
 *
 *   `downed`  — `goDown` sets hp 0, `alive` FALSE and SWAPS THE SPRITE to the
 *               `_downed_s` variant. `sprite` travels only on `ActorView`, so
 *               without a resync every client keeps drawing a detective standing
 *               up at 0 hp — which is the one thing the whole mechanic must not
 *               look like.
 *   `revived` — the same swap in reverse, back to `upSprite`.
 *   `erased`  — the marker changes and, when it is a party wipe,
 *               `resetFloorParty` has already rewritten every body's hp and both
 *               its clocks at once.
 *
 * So the answer is the deliberately dumb one protocol.ts keeps for exactly this:
 * resend the whole actor list. A few KB, a handful of times per floor, and it
 * cannot drift. The alternative is a `sprite` field on three more events plus a
 * client that has to apply them in the right order.
 *
 * READ OFF THE WIRE EVENTS rather than from a flag on `PumpResult`, because that
 * type is the gateway's contract with ANY engine, and a boolean there would be a
 * field every implementation has to carry for one branch's benefit. Both lanes
 * are searched: a body usually goes down mid-sweep, under the last monster's
 * blow, but a friendly-fire AoE or a bleed ticking on a player's own turn puts
 * it in the player lane instead.
 */
function needsFullResync(result: PumpResult): boolean {
  const rewrites = (event: TurnEvent): boolean =>
    event.k === 'downed' || event.k === 'revived' || event.k === 'erased';
  return result.playerEvents.some(rewrites) || result.sweep.some(rewrites);
}

/**
 * Did somebody just fall over? THE SAVE POINT.
 *
 * saves.ts names `SaveReason.Death` for exactly this and says why it does not
 * wait for the debounce: the five seconds between a body hitting the floor and
 * the autosave firing are the five seconds a player is most likely to close the
 * window in disgust, and the state they must not lose is the one that just
 * changed. `death` is included alongside the two survival events because a
 * monster's kill is the same moment from the file's point of view.
 */
function isSaveWorthy(result: PumpResult): boolean {
  const fell = (event: TurnEvent): boolean =>
    event.k === 'downed' || event.k === 'revived' || event.k === 'erased' || event.k === 'death';
  return result.playerEvents.some(fell) || result.sweep.some(fell);
}

/** A party wipe specifically — every body restored at once. Worth a log line. */
function isPartyWipe(result: PumpResult): boolean {
  const wiped = (event: TurnEvent): boolean =>
    event.k === 'erased' && event.reason === ErasedReason.Wipe;
  return result.playerEvents.some(wiped) || result.sweep.some(wiped);
}

/**
 * A comparison key for "has the barrier changed?".
 *
 * A string rather than a field-by-field compare because the alternative is four
 * array comparisons that have to be kept in step with `TurnState`, and because a
 * key cannot accidentally alias the scheduler's own arrays — which mutate in
 * place, so a memo that held references to them would compare equal forever and
 * freeze the turn indicator on turn one.
 *
 * The Bell contributes only ARMED-OR-NOT. Its remaining milliseconds change
 * continuously and would make every key different, turning "broadcast on change"
 * into "broadcast on every pump".
 */
function turnKey(state: TurnState, bellArmed: boolean): string {
  return [
    state.gameTurn,
    // ═══ THE ZERO CROSSING. THE WHOLE REASON THIS TERM EXISTS ═══
    //
    // Engagement going 0 -> n IS THE MOMENT COMBAT STARTS, and n -> 0 is the
    // moment it ends. Those are the two instants the party has to be told about
    // — a client cannot announce a transition it was never sent — and NEITHER OF
    // THEM NECESSARILY MOVES THE QUORUM. A fight can open on a turn where the
    // blocking set is unchanged (everyone was already parked, or nobody is yet),
    // and it always ends on one, because engagement decays several turns after
    // the last contact while the party is already walking freely. Without this
    // term the frame carrying `inCombat: true` would be suppressed as a
    // duplicate of the frame before it, which is exactly the bug this field was
    // added to fix.
    //
    // The RAW COUNT rather than a boolean, and it costs nothing: engagement only
    // ever moves on a game-turn boundary (the scheduler's `updateEngagement`
    // hook), where `gameTurn` above has already changed the key. So including
    // the whole number sends no extra frames and keeps the countdown a client
    // draws from it honest.
    state.engagement,
    state.whoseTurn.join(','),
    state.committed.join(','),
    state.standingBy.join(','),
    bellArmed ? 'bell' : '-',
  ].join('|');
}

/**
 * THE SKY IS CLEAR, as the `projectiles` memo spells it.
 *
 * `JSON.stringify([])`, written out as the literal it produces so that the
 * seeded memo below reads as a statement rather than as a call whose result you
 * have to work out. See `lastProjectilesKey` for why it is seeded at all.
 */
const NO_PROJECTILES_KEY = '[]';

export const wsGateway: FastifyPluginAsync<WsGatewayOptions> = async (app, opts) => {
  const { world, engine } = opts;
  const disconnectGraceMs = opts.disconnectGraceMs ?? DEFAULT_DISCONNECT_GRACE_MS;

  /** Every live connection, keyed by connection id. The broadcast list. */
  const sessions = new Map<string, Session>();

  /** Resume token -> actor id. Server-minted, rotated on every `welcome`. */
  const actorByToken = new Map<string, string>();

  /** Actor id -> its current token, so rotation can retire the old one. */
  const tokenByActor = new Map<string, string>();

  /**
   * Actor id -> the connection that currently owns it.
   *
   * This is what makes resume safe. When a token is redeemed on a new socket the
   * ownership moves first and the old socket is closed second, so the old
   * socket's `close` handler sees that it is no longer the owner and does NOT
   * put the new connection's actor on Standing By.
   */
  const connByActor = new Map<string, string>();

  /** Actor id -> the timer that will recall its unattended body. */
  const graceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /**
   * The Bell, or null when none is running.
   *
   * `gameTurn` identifies WHICH park this Bell belongs to. Players are
   * phase-locked (DECISIONS.md § D1) so the barrier parks exactly once per game
   * turn, which makes the turn number a sufficient identity and stops a second
   * commit arriving mid-countdown from restarting the clock — a Bell that
   * restarts every time someone else commits never rings.
   */
  let bell: {
    readonly gameTurn: number;
    readonly durationMs: number;
    readonly deadline: number;
    readonly timer: ReturnType<typeof setTimeout>;
  } | null = null;

  /** The last barrier state broadcast, as a key. See `turnKey`. */
  let lastTurnKey: string | null = null;

  /**
   * Names ANONYMOUS players — the ones with no verified Discord identity behind
   * them. A verified player is named by Discord; see `resolveActor`.
   */
  let joinCount = 0;

  /**
   * The Case Log's line counter. Monotonic for the lifetime of the process and
   * never reused, which is what lets a client de-duplicate a resent tail and
   * anchor its scroll to a line rather than to an index that shifts.
   *
   * Starts at 1 so that 0 is unambiguously "no line yet" on the client side.
   */
  let logSeq = 0;

  /** The last `party` frame broadcast, as a key. Same trick as `turnKey`. */
  let lastPartyKey: string | null = null;

  /** The last `effects` frame broadcast, as a key. */
  let lastEffectsKey: string | null = null;

  /**
   * The last `projectiles` frame broadcast, as a key — and SEEDED WITH THE
   * EMPTY LIST rather than with null, which the other two memos use.
   *
   * That difference is deliberate and it is the whole reason a server that never
   * fires an orb sends byte-for-byte the frame set it sent before this feature
   * existed. `null` would make the very first pump of every session compare
   * `'[]' !== null` and broadcast an empty `projectiles` frame to say nothing at
   * all. An empty sky is not news: it is what a client already believes before
   * it is told anything, and `welcome` carries no orb list precisely because
   * absence is the default rather than a fact that has to be transmitted.
   */
  let lastProjectilesKey = NO_PROJECTILES_KEY;

  /**
   * Actor id -> when that player last put a line in the Margin.
   *
   * WALL CLOCK, WHICH IS WHY IT IS HERE. This file owns the only clock in the
   * turn pipeline (the Bell and the reconnect grace are the others);
   * src/server/view/** may not call `Date.now` at all, so `projectParty` takes
   * the ANSWER — a set of ids — rather than the timestamps.
   *
   * Keyed by actor rather than by connection so the dot survives a reconnect:
   * somebody whose wifi hiccups mid-sentence is still the person who just spoke.
   */
  const spokeAtMs = new Map<string, number>();

  /** One pending refresh that puts the speaking dot out again. See `noteSpoke`. */
  let speakingTimer: ReturnType<typeof setTimeout> | null = null;

  await app.register(websocket, {
    options: { maxPayload: MAX_FRAME_BYTES },
  });

  /**
   * Run something entered from a TIMER, where there is no caller to catch a
   * throw and an escaping exception is an uncaught exception — which kills the
   * PROCESS, not the timer. The `message` handler has its own try/catch for the
   * same reason; the Bell and the reconnect grace need one because they are
   * entered from the event loop with nothing above them.
   */
  const guard = (label: string, fn: () => void): void => {
    try {
      fn();
    } catch (err) {
      app.log.error({ err }, label);
    }
  };

  // -------------------------------------------------------------------------
  // THE RATE LIMIT — game-design.md § 4
  // -------------------------------------------------------------------------

  /**
   * Spend one token, refilling first. False means "drop this frame".
   *
   * CHARGED FOR EVERY FRAME EXCEPT `hello`, which is once per connection and is
   * the one frame a socket cannot be throttled out of without losing the session
   * entirely. Everything else is charged, including `ping`: a frame that makes
   * the server reply is a frame worth a token, and app-level pings are the
   * cheapest possible flood.
   *
   * It does NOT close the socket. A throttled client is usually a bug or a
   * reconnect storm, not an attack, and hanging up on it turns one runaway loop
   * into a reconnect loop. The frames are dropped, the sender is told once a
   * second, and everyone else's game carries on.
   */
  const takeToken = (session: Session, nowMs: number): boolean => {
    const elapsedMs = Math.max(0, nowMs - session.tokensAtMs);
    session.tokens = Math.min(
      COMMAND_BURST,
      session.tokens + (elapsedMs * COMMAND_RATE_PER_SEC) / 1000,
    );
    session.tokensAtMs = nowMs;
    if (session.tokens < 1) return false;
    session.tokens -= 1;
    return true;
  };

  /** Tell a throttled socket, at most once a second. See RATE_NOTICE_INTERVAL_MS. */
  const noteThrottled = (session: Session, nowMs: number): void => {
    if (nowMs - session.rateNoticeAtMs < RATE_NOTICE_INTERVAL_MS) return;
    session.rateNoticeAtMs = nowMs;
    sendError(
      session.socket,
      ErrorCode.RateLimited,
      `too many commands — the limit is ${COMMAND_RATE_PER_SEC} a second`,
    );
    app.log.warn({ conn: session.connId, actorId: session.actorId }, 'ws socket is rate limited');
  };

  // -------------------------------------------------------------------------
  // The party panel and the badge row — two SNAPSHOTS, not two patch streams
  // -------------------------------------------------------------------------

  /** Who has spoken recently enough for the dot to be lit. */
  const speakingNow = (nowMs: number): ReadonlySet<string> => {
    const speaking = new Set<string>();
    for (const [actorId, at] of spokeAtMs) {
      if (nowMs - at < SPEAKING_WINDOW_MS) speaking.add(actorId);
    }
    return speaking;
  };

  /**
   * THE PARTY, when it changed.
   *
   * The key is the members array as JSON rather than a hand-written compare,
   * because the row is six small fields and this runs once per pump for at most
   * six people — the honest cost is a few hundred bytes of string, and the
   * alternative is a field-by-field comparison that has to be kept in step with
   * `PartyMember` and will not be.
   *
   * "On change" matters more here than it does for `turn`: the panel is
   * low-frequency BY DESIGN (protocol.ts — it changes when somebody goes down,
   * gets up, drops or speaks, not when they take a hit), and a frame every pump
   * would quietly turn it into a second hp stream.
   */
  const broadcastPartyIfChanged = (nowMs: number): void => {
    const msg = projectParty(world, opts.downed, speakingNow(nowMs));
    const key = JSON.stringify(msg.members);
    if (key === lastPartyKey) return;
    lastPartyKey = key;
    broadcast(msg);
  };

  /**
   * EVERY BADGE IN THE WORLD, when they changed.
   *
   * Silent when no effect state is wired in: a server with no statuses sends no
   * `effects` frames at all rather than an empty one every pump, which keeps the
   * M3 frame set byte-for-byte unchanged on that path.
   */
  const broadcastEffectsIfChanged = (): void => {
    const effects = opts.effects;
    if (effects === undefined) return;
    const msg = projectEffects(world, effects);
    const key = JSON.stringify(msg.actors);
    if (key === lastEffectsKey) return;
    lastEffectsKey = key;
    broadcast(msg);
  };

  /**
   * EVERYTHING IN THE AIR, when it changed. The same memo shape as the two
   * above, and for the same three reasons.
   *
   * ═══ AN IDLE PUMP COSTS ONE STRING COMPARE AND SENDS NOTHING ═══
   * This runs on every pump, including the ones where nobody did anything, and
   * the overwhelmingly common state of the sky is EMPTY — no monster in the
   * roster but the wraith has a `projSpeed` at all. So the hot path is
   * `projectProjectiles` over an empty table, `JSON.stringify([])`, one compare
   * against the seeded key, and a return.
   *
   * ═══ THE FRAME IS ABSOLUTE, WHICH IS WHY "ON CHANGE" IS SAFE ═══
   * Suppressing a duplicate is only ever legal for a snapshot: the frame that
   * does go out replaces the client's whole list, so a suppressed one would have
   * said exactly what the client already believes. An orb LANDING is a change
   * like any other — the list is shorter — so impact broadcasts an absence
   * rather than a "removed" patch, and a client that missed the landing frame is
   * corrected by the next one instead of holding a phantom orb forever.
   *
   * NO WALL CLOCK AND NO GAME STATE. It projects what the world already decided
   * during the pump that just returned; it may not step, age or reap an orb.
   * Flight happens on the energy clock inside `engine.pump`, and putting one
   * line of it here would be a second scheduler in the file that owns the only
   * `setTimeout` in the turn path.
   */
  const broadcastProjectilesIfChanged = (): void => {
    const msg = projectProjectiles(world);
    const key = JSON.stringify(msg.projectiles);
    if (key === lastProjectilesKey) return;
    lastProjectilesKey = key;
    broadcast(msg);
  };

  /**
   * THE SKY, TO SOMEBODY WHO HAS SEEN NOTHING — `welcome`, a resume, and the
   * full board resync.
   *
   * ═══ WHY THE `state` FRAME CANNOT COVER THIS ═══
   * `state` carries `ActorView` and only `ActorView` (protocol.ts), and an orb
   * is deliberately NOT an actor — no `ActorKind` member, no hp bar, no rank
   * ring. So the frame the gateway resends when a body has been rewritten says
   * nothing whatever about what is in the air, and a player reconnecting
   * mid-flight would see an empty sky until the next pump happened to change
   * the list. Out of combat, with a party standing still deciding what to do,
   * that can be minutes — and the orb they cannot see is the one they were
   * given two turns to dodge.
   *
   * ═══ SILENT WHEN NOTHING IS IN THE AIR ═══
   * Absence is the client's default, so an empty frame here would be a frame
   * that says what its recipient already believes — on every join and every
   * survival event, on a server whose roster has one creature that can fire.
   * See `lastProjectilesKey`.
   *
   * @param socket the one recipient, or absent to tell the room. The broadcast
   *   form also updates the memo, so the `broadcastProjectilesIfChanged` a few
   *   lines later in the same pump correctly sends nothing.
   */
  const sendProjectilesIfAny = (socket?: GatewaySocket): void => {
    const msg = projectProjectiles(world);
    if (msg.projectiles.length === 0) return;
    if (socket !== undefined) {
      send(socket, msg);
      return;
    }
    lastProjectilesKey = JSON.stringify(msg.projectiles);
    broadcast(msg);
  };

  /**
   * A LINE JUST WENT INTO THE MARGIN: light this player's dot and arrange for it
   * to go out again.
   *
   * The timer is the reason this is not a bare map write. `speaking` is computed
   * from a wall clock, so nothing else would ever recompute it — the dot would
   * stay lit until the next pump, and out of combat there may not be one for
   * minutes. ONE pending timer, replaced rather than stacked, so a player typing
   * ten lines arms one refresh and not ten.
   */
  const noteSpoke = (actorId: string): void => {
    const nowMs = Date.now();
    spokeAtMs.set(actorId, nowMs);
    broadcastPartyIfChanged(nowMs);

    if (speakingTimer !== null) clearTimeout(speakingTimer);
    speakingTimer = setTimeout(() => {
      speakingTimer = null;
      guard('speaking sweep threw', () => {
        broadcastPartyIfChanged(Date.now());
      });
    }, SPEAKING_WINDOW_MS);
    speakingTimer.unref();
  };

  // -------------------------------------------------------------------------
  // Persistence — QUEUED AFTER THE PUMP, NEVER INSIDE IT
  // -------------------------------------------------------------------------

  /**
   * Hand the persist layer the list of characters that may have changed.
   *
   * EVERY PLAYER, NOT A DIFF. Working out precisely who moved would mean walking
   * the event list and keeping a shadow copy of the last saved position — a
   * second model of the world in the one file that must not have one — to save a
   * handful of small JSON writes for at most six people. The persist layer
   * already has to coalesce (it is debounced and it batches), so the cheap,
   * correct answer is "these are the characters; you decide what is dirty".
   *
   * INSIDE `guard`, because this is the one call in the pipeline that reaches a
   * filesystem, and on Windows a filesystem call is exactly where R9 lives: an
   * EPERM from a virus scanner holding the destination open must cost one log
   * line, not the process.
   */
  /**
   * Every player body, as plain data, taken in one synchronous pass.
   *
   * One pass over at most six actors, and the copy is the point: the objects in
   * the world keep moving, the disk does not, and a snapshot is what makes the
   * file a state the world really was in rather than whatever it happened to be
   * when a write finally landed.
   */
  const snapshotPlayers = (): CharacterSnapshot[] => {
    const snapshots: CharacterSnapshot[] = [];
    for (const actor of world.allActors()) {
      if (actor.kind !== 'player') continue;
      const cooldowns: Record<string, number> = {};
      for (const [talentId, turns] of actor.cooldowns) {
        if (turns > 0) cooldowns[talentId] = turns;
      }
      snapshots.push({
        actorId: actor.id,
        name: actor.name,
        hp: actor.hp,
        cooldowns,
        x: actor.x,
        y: actor.y,
        // ═══ THE CLASS, OR THE FIELD IS ABSENT — NEVER AN INVENTED ONE ═══
        // `classId` is optional on both sides precisely so that a classless
        // body writes nothing here and the bridge keeps whatever the file
        // already said. Spreading `classId: actor.classId` unconditionally
        // would put `undefined` on the snapshot, and `snapshot.classId ??
        // binding.classId` in saves.ts would then do the right thing by
        // accident rather than by contract.
        //
        // ═══ AND A PROVISIONAL CLASS IS NOT A CLASS. THE SENTINEL WINS ═══
        // A body whose owner is still in `classChoiceOwed` is wearing whatever
        // the rotation handed it four seconds ago, and `handleHello` flushes
        // `saveNow('join')` immediately after building it. Writing that id would
        // put an ANSWER on disk to a question nobody has been asked: the next
        // `owes` read (`restore.classId === UNASSIGNED_CLASS`) would come back
        // false, the chooser would never be offered again, and there is no other
        // route to it in the whole protocol. So the file keeps saying "nobody
        // has chosen" — which is the truth — until `handleChooseClass` lands a
        // real one and deletes the id from the set.
        //
        // THE SENTINEL RATHER THAN OMITTING THE FIELD, because omitting falls
        // back to `binding.classId`, and the binding is only `unassigned` by
        // DEFAULT (saves.ts:1248). Saying it outright cannot be undone by a
        // future change to that default.
        ...(actor.classId === undefined
          ? {}
          : { classId: classChoiceOwed.has(actor.id) ? UNASSIGNED_CLASS : actor.classId }),
      });
    }
    return snapshots;
  };

  const queueSave = (reason: string): void => {
    const persist = opts.persist;
    if (persist === undefined) return;
    guard('persist queue threw', () => {
      const snapshots = snapshotPlayers();
      if (snapshots.length === 0) return;
      // EVERY PLAYER, including the anonymous ones. Working out here which
      // bodies have an owner would be a second copy of the binding the persist
      // layer already holds, and the two would eventually disagree about who is
      // saveable. The port drops what it has no file for — see `PersistPort`.
      persist.savePlayers(snapshots);
      app.log.debug({ reason, count: snapshots.length }, 'queued a character save');
    });
  };

  /**
   * A CRITICAL EVENT — write now (game-design.md's save points, saves.ts's
   * `SaveReason`). Falls back to the debounce when the port has no immediate
   * path, because losing the last few seconds beats losing the frame.
   */
  const saveNow = (reason: string): void => {
    const persist = opts.persist;
    if (persist === undefined) return;
    if (persist.savePlayersNow === undefined) {
      queueSave(reason);
      return;
    }
    guard('persist flush threw', () => {
      const snapshots = snapshotPlayers();
      if (snapshots.length === 0) return;
      persist.savePlayersNow?.(snapshots, reason);
      app.log.info({ reason, count: snapshots.length }, 'saved characters on a critical event');
    });
  };

  /**
   * The single choke point for every outbound frame, and therefore the single
   * place `JSON.stringify` runs.
   *
   * It is wrapped because a payload is no longer just strings and numbers: a
   * `sweep` carries whatever the engine put in its events, and one accidental
   * reference to a live actor object makes stringify throw on a cycle. From a
   * timer that would be fatal, and it would be fatal for everyone rather than
   * for the one client whose frame was malformed. A try/catch that never fires
   * costs nothing on V8's fast path.
   */
  const send = (socket: GatewaySocket, msg: ServerMsg): void => {
    if (socket.readyState !== WS_OPEN) return;
    try {
      socket.send(JSON.stringify(msg));
    } catch (err) {
      app.log.error({ err, t: msg.t }, 'ws send failed');
    }
  };

  const sendError = (socket: GatewaySocket, code: ErrorCode, message: string): void => {
    send(socket, { v: PROTOCOL_VERSION, t: 'error', code, message });
  };

  /**
   * To every client that has completed `hello`, optionally skipping one.
   *
   * Pre-`hello` sockets are skipped because they have no baseline: a `moved` for
   * an actor whose existence was never announced is unusable, and the `welcome`
   * they are about to get carries the full snapshot anyway.
   *
   * IT TAKES `BroadcastMsg`, NOT `ServerMsg`, and that one word is the whole
   * enforcement of the M3 privacy rule. `BroadcastMsg` is `ServerMsg` minus
   * `loadout`/`cooldowns`/`resource`, so `broadcast(cooldownsMsg)` does not
   * compile. Another player's cooldowns are intent — what they are saving for
   * the boss, what they can no longer escape with — and leaking them is a build
   * failure here rather than a rule someone has to remember while adding a fifth
   * viewer frame at one in the morning.
   */
  const broadcast = (msg: BroadcastMsg, exceptConnId?: string): void => {
    for (const session of sessions.values()) {
      if (!session.helloDone) continue;
      if (session.connId === exceptConnId) continue;
      send(session.socket, msg);
    }
  };

  // -------------------------------------------------------------------------
  // The Bell — the one piece of wall clock in the turn pipeline
  // -------------------------------------------------------------------------

  const bellRemainingMs = (): number | null =>
    bell === null ? null : Math.max(0, bell.deadline - Date.now());

  const clearBell = (): void => {
    if (bell === null) return;
    clearTimeout(bell.timer);
    bell = null;
  };

  /**
   * Bring the timer into line with what the scheduler is asking for.
   *
   * Three cases, and the middle one is the whole reason this is not just
   * "restart the timer every pump":
   *
   *   no Bell wanted        -> disarm.
   *   a Bell for a NEW park -> arm it.
   *   a Bell already running for THIS park -> leave the deadline alone, so the
   *     countdown the stragglers can see keeps counting down.
   *
   * The one exception is a request for a LONGER Bell mid-park, which is honoured
   * — that happens when the quorum shrinks to one (someone drops, someone goes
   * Standing By) and the 20-second clock becomes the 120-second one. A Bell may
   * become more generous while it runs; it may never become harsher, because
   * shortening a visible countdown out from under someone is indistinguishable
   * from the server cheating.
   */
  const syncBell = (state: TurnState): void => {
    const wanted = state.bellDurationMs;
    if (wanted === null) {
      clearBell();
      return;
    }
    if (bell !== null && bell.gameTurn === state.gameTurn && wanted <= bell.durationMs) return;

    clearBell();
    const timer = setTimeout(() => {
      guard('bell timer threw', onBellExpired);
    }, wanted);
    // Never let a pending Bell hold the process open at shutdown.
    timer.unref();
    bell = { gameTurn: state.gameTurn, durationMs: wanted, deadline: Date.now() + wanted, timer };
    app.log.info({ gameTurn: state.gameTurn, ms: wanted }, 'bell armed');
  };

  const onBellExpired = (): void => {
    const rang = bell;
    bell = null;
    app.log.info({ gameTurn: rang?.gameTurn }, 'bell rang — stragglers hold');
    try {
      engine.bellExpired();
    } catch (err) {
      app.log.error({ err }, 'engine.bellExpired threw');
      return;
    }
    pumpAndBroadcast();
  };

  // -------------------------------------------------------------------------
  // Turn state, out to the clients
  // -------------------------------------------------------------------------

  /**
   * One `turn` frame, projected for one viewer. Silent for a bodiless socket.
   *
   * UNICAST, NOT BROADCAST, AND NOW STRUCTURALLY SO. Every card in the frame is
   * public — the party is meant to see the whole strip — but `TurnActor.isSelf`
   * is true for exactly one recipient, so `TurnMsg` joined `ViewerMsg` at v5 and
   * `broadcast(turnMsg)` no longer compiles. One shared copy of this frame would
   * highlight one player's card on four screens, in the one UI whose entire job
   * is answering "is the game waiting on ME?".
   */
  const sendTurn = (session: Session, state: TurnState, bellMs: number | null): void => {
    const actorId = session.actorId;
    if (actorId === null) return;
    const viewer = world.getActor(actorId);
    if (viewer === undefined) return;
    // ═══ THE BARRIER IS THIS VIEWER'S PARTY, NOT THE FLOOR (v6) ═══
    // `state` is the LEVEL-WIDE snapshot: it is what the change key is built
    // from and what the Bell timer is armed against, and it is deliberately not
    // what anybody is shown. The frame is rebuilt against the recipient's own
    // party so the strip answers "is the game waiting on ME?" without listing
    // people this player never agreed to wait for. `turnState` falls back to
    // the level-wide answer for an engine with no party system, so a build
    // without one sends byte-for-byte what it always did.
    const scoped = engine.turnState(actorId);
    // `opts.downed` is the SAME survival table the engine mutates (main.ts
    // creates one and hands it to both), so the card's `downed` flag and the
    // countdown on the party panel can never disagree about who is on the floor.
    send(session.socket, projectTurn(viewer, world, scoped, bellMs, opts.downed));
  };

  /**
   * THE PARTY PANE, when it changed, to one socket.
   *
   * ═══ IT IS PER-RECIPIENT AND STRUCTURALLY SO ═══
   * `PartyStateMsg` is a `ViewerMsg`, so `broadcast(partyState)` does not
   * compile — two independent fields make it one frame per person:
   * `members[].isSelf` is true for exactly one recipient, and `invites` is a
   * list of decisions that belong to that recipient alone. Neither has a
   * correct shared form.
   *
   * ═══ WHY THE MEMO IS ENOUGH TO GET "AFFECTED MEMBERS ONLY" RIGHT ═══
   * `PartyResult.affected` names who to push to the moment a command lands, and
   * `handleParty` uses it. This function is the OTHER half: it runs for every
   * socket on every pump and sends only when that socket's own pane changed, so
   * hp, presence and an invite lapsing all propagate without anybody having to
   * work out who cares. The common turn — somebody walked — costs one
   * `JSON.stringify` over a handful of small objects and sends nothing.
   *
   * Silent for an engine with no party system: no pane at all is the honest
   * answer, and better than one describing an invented party of one.
   */
  const sendPartyStateIfChanged = (session: Session): void => {
    const actorId = session.actorId;
    if (actorId === null) return;
    if (engine.partySnapshot === undefined) return;
    const viewer = world.getActor(actorId);
    if (viewer === undefined) return;
    const snapshot = engine.partySnapshot(actorId);
    if (snapshot === undefined) return;

    const msg = projectPartyState(
      viewer,
      world,
      snapshot,
      engine.turnState(actorId),
      bellRemainingMs(),
      snapshot.invites,
    );

    // `expiresInMs` is deliberately EXCLUDED from the key: it changes on every
    // call by however many milliseconds have passed, so including it would turn
    // "send on change" into "send on every pump" for anybody holding an invite.
    // The client counts its own copy down and drops the row itself.
    const key = JSON.stringify([
      msg.leaderId,
      msg.members,
      msg.invites.map((invite) => `${invite.fromId}:${String(invite.size)}`),
    ]);
    if (key === session.partyKey) return;
    session.partyKey = key;
    send(session.socket, msg);
  };

  /**
   * Tell everyone whose turn it is — but only when the answer changed.
   *
   * "Only when it changed" is a bandwidth nicety; the BROADCAST is not. A player
   * who cannot tell whether the game is waiting on them is the documented way
   * this genre dies (game-design.md § 4), so every commit, every hold, every
   * disconnect and every Bell arming is visible to the whole party, not only to
   * the person it happened to.
   */
  const broadcastTurnIfChanged = (state: TurnState): void => {
    const key = turnKey(state, bell !== null);
    if (key === lastTurnKey) return;
    lastTurnKey = key;

    const bellMs = bellRemainingMs();
    for (const session of sessions.values()) {
      if (!session.helloDone) continue;
      sendTurn(session, state, bellMs);
    }
  };

  // -------------------------------------------------------------------------
  // The hotbar — THREE FRAMES THAT ARE NEVER BROADCAST
  // -------------------------------------------------------------------------

  /**
   * The viewer's own loadout, unicast. Sent once, at `welcome`.
   *
   * Once, because M3 loadouts are FIXED (PLAN.md § M3: twelve talents, zero
   * trees, zero talent points). When M6 lets a loadout change mid-session this
   * is called again and the client replaces its hotbar wholesale — the frame is
   * already shaped for that, which is why it carries the whole list rather than
   * a slot delta.
   */
  const sendLoadout = (session: Session): void => {
    const actorId = session.actorId;
    if (actorId === null) return;
    const viewer = world.getActor(actorId);
    if (viewer === undefined) return;
    const talents = engine.loadoutOf(actorId);
    // An actor with no talents gets no hotbar rather than an empty one. A row of
    // four blank buttons is a bug report; the absence of a row is not.
    if (talents.length === 0) return;
    send(session.socket, projectLoadout(viewer, talents));
  };

  /**
   * The viewer's own cooldowns and resource, unicast, ON CHANGE.
   *
   * "On change" is a bandwidth nicety; UNICAST IS NOT. See `broadcast` above —
   * the type system refuses to let these go to the room, and this is the only
   * function in the file that sends them at all.
   *
   * The two travel together because they change together: almost everything that
   * spends a resource also starts a cooldown, and splitting them would double
   * the memo bookkeeping to save one small frame per turn.
   */
  const sendHotbarIfChanged = (session: Session): void => {
    const actorId = session.actorId;
    if (actorId === null) return;
    const viewer = world.getActor(actorId);
    if (viewer === undefined) return;
    // No hotbar, nothing to keep in step. This also keeps a server with no
    // talents wired in — `EMPTY_TALENT_BOOK`, which is still the default —
    // sending byte-for-byte the M2 frame set, so the protocol bump is the only
    // observable change on that path.
    if (engine.loadoutOf(actorId).length === 0) return;

    const cooldowns = projectCooldowns(viewer);
    const resource = projectResource(viewer, engine.resourceOf(actorId));

    // Cooldown keys are sorted so that a Map whose insertion order changed —
    // which happens every time one entry expires and another is added — does not
    // read as a change and resend an identical frame every turn.
    const key = [
      Object.entries(cooldowns.cooldowns)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([id, turns]) => `${id}:${turns}`)
        .join(','),
      resource === null
        ? '-'
        : `${resource.resource.kind}:${resource.resource.current}/${resource.resource.max}`,
    ].join('|');
    if (key === session.viewerKey) return;
    session.viewerKey = key;

    send(session.socket, cooldowns);
    if (resource !== null) send(session.socket, resource);
  };

  /**
   * Every attended body's own viewer-private frames, one socket at a time.
   *
   * The hotbar and the party pane travel together because both are memoised
   * per socket and both are cheap when nothing moved — and because the one
   * thing that must never happen is a loop that walks the session list twice
   * and gets a different answer the second time, which is what two separate
   * passes over a mutating actor table would eventually produce.
   */
  const refreshViewers = (): void => {
    for (const session of sessions.values()) {
      if (!session.helloDone) continue;
      sendHotbarIfChanged(session);
      sendPartyStateIfChanged(session);
    }
  };

  // -------------------------------------------------------------------------
  // The pump
  // -------------------------------------------------------------------------

  /**
   * Advance the world and say what happened. THE ONLY WAY THE WORLD MOVES.
   *
   * Called after every state-changing frame and after every timer, never
   * speculatively — an `idle` pump is cheap but it is still a JSON pass over the
   * session list if anything came back.
   *
   * ORDER MATTERS. The player lane goes out first because it is what the sender
   * is waiting to see; the sweep follows, as one frame; the Bell is synchronised
   * before the turn frame so that `bellMs` is not one broadcast stale.
   *
   * A throwing `pump` is caught and logged rather than allowed to escape. It
   * would otherwise unwind through a `ws` event handler and kill the process,
   * taking the other three players' session with it — and an engine invariant
   * failing is precisely the moment everyone most wants the server to stay up.
   */
  const pumpAndBroadcast = (): void => {
    let result: PumpResult;
    try {
      result = engine.pump();
    } catch (err) {
      app.log.error({ err }, 'turn pump threw — the world did not advance');
      return;
    }

    if (result.status === 'budget') {
      app.log.warn({ gameTurn: result.turn.gameTurn }, 'pump exhausted its tick budget');
    }

    for (const event of result.playerEvents) {
      // Null means "this kind has no immediate-lane wrapper" — see
      // `messageForEvent`. It is delivered by the `effects`/`party` snapshots
      // below, in this same pump.
      const msg = messageForEvent(event);
      if (msg !== null) broadcast(msg);
    }

    // ═══ A REFUND IS UNICAST, BECAUSE NOTHING ELSE WILL EVER MENTION IT ═══
    // See `PumpResult.refusals` for why the turn frame below cannot carry this:
    // a refund spends no energy, so `turnKey` does not move and
    // `broadcastTurnIfChanged` suppresses the frame as a duplicate. Absence is
    // not a signal, and a client left inferring one waits forever.
    //
    // ONLY THE OWNER HEARS IT, with the same code `handleMove` already uses for
    // a refusal caught at SUBMISSION — a wall nobody walked into is not an
    // event, and telling the room would leak where people are trying to go. It
    // rides here, in the player lane, because that is the lane the sender is
    // waiting on.
    //
    // `illegal_move` FOR EVERY REFUSAL, and deliberately no `Refusal`->ErrorCode
    // table: the engine's refusal vocabulary is about resolution bookkeeping and
    // most of it (`no_actor`, `no_talent_effect`) has no player-facing meaning at
    // all. The wording says "at resolution" rather than "move blocked" because a
    // refunded talent takes this path too, and a log line that named the wrong
    // verb would be the kind of small lie that costs an evening.
    for (const refusal of result.refusals) {
      const conn = connByActor.get(refusal.id);
      const owner = conn === undefined ? undefined : sessions.get(conn);
      if (owner === undefined || !owner.helloDone) continue;
      sendError(owner.socket, ErrorCode.IllegalMove, `refused at resolution: ${refusal.reason}`);
    }

    // ONE frame for the whole monster turn. Never one per monster.
    if (result.sweep.length > 0) {
      broadcast({
        v: PROTOCOL_VERSION,
        t: 'sweep',
        gameTurn: result.turn.gameTurn,
        events: [...result.sweep],
      });
    }

    // THE RECORD LANE, after the events it narrates and before the snapshots.
    // One batch for the whole pump — see `broadcastRecord`. It is silent on an
    // idle pump, so a client spamming frames cannot farm log traffic either.
    broadcastRecord(result);

    // ═════════════════════════════════════════════════════════════════════
    // THE REAP WINDOW. DEAD MONSTERS LEAVE THE MAP, AND THIS IS THE ONE
    // PLACE THEY MAY — AFTER THE NARRATION, BEFORE THE RESYNC.
    // ═════════════════════════════════════════════════════════════════════
    //
    // Ported from engines/default/engine/interface/ActorLife.lua:86-94, called
    // from tome/class/Actor.lua:2975 — `if game.level:hasEntity(self) then
    // game.level:removeEntity(self) end`. Upstream removes BEFORE its log line
    // because it still holds the object reference; we re-resolve every id
    // through `world.getActor` after the pump has returned, so we remove AFTER.
    //
    // THE ORDER IS A CONTRACT WITH THE TWO NEIGHBOURS, exactly as the
    // sweep/snapshot rules below are:
    //
    //   `broadcastRecord` MUST HAVE RUN. `nameOf` reads the name off the live
    //   body and `hitToWire` read its `maxHp` — reap first and the Case Log
    //   says "5 damage. someone 0/0." above "someone is unfiled.", which is a
    //   log that has lost the only two facts the line was for. Nothing throws;
    //   it simply starts lying.
    //
    //   `projectActors` MUST NOT HAVE RUN. The resync below ships the whole
    //   actor list, and a corpse still in it is a husk drawn with its LIVE
    //   sprite, indistinguishable from a living one. That is the bug a player
    //   reported and the reason this window exists at all.
    //
    // `left` IS THE FRAME, AND IT IS PRESENCE-REMOVAL STATED. client/main.ts's
    // `case 'death'` forbids inferring death FROM ABSENCE — deleting a body on
    // absence would make a kill look identical to an actor walking out of view,
    // and would delete a Downed player. An explicit frame is the exception that
    // comment allows, and `case 'left'` is one already-written line.
    //
    // NOT ROUTED THROUGH `needsFullResync`. That path also runs the client's
    // `state` collateral — `cancelTravel`, `forgetInspections`,
    // `clearProjectiles` (client/main.ts) — so somebody else's kill would
    // silently stop your auto-walk halfway down a corridor.
    //
    // BROADCAST EVEN WHEN `reap` ANSWERS FALSE. False means the body was
    // already gone — a party wipe in this same pump, where `resetFloor` buried
    // every monster before this loop could. The `left` is still true of the body
    // that died, and the resync immediately below (a wipe always triggers one)
    // re-creates the floor on every client.
    //
    // ═══ AND THE LIST HAS ALREADY BEEN FILTERED FOR US ═══
    // This comment used to say the id "may now belong to a freshly-placed husk"
    // and treat that as harmless. IT WAS NOT: `reseedFloor` re-mints the
    // encounter with STABLE IDS, so `reap` answered TRUE and deleted the brand
    // new body, and the resync below then shipped a reset floor permanently one
    // monster short. `createTurnEngine.pump` now identity-checks every enrolled
    // id against the body it named BEFORE the wipe loop ran and drops the ones a
    // reset replaced — read `enrolled` in turn-engine.ts. Nothing here may
    // assume an id is still the body that died.
    for (const id of result.reaped ?? []) {
      // ═══ TAKE THE NAME BEFORE TAKING THE BODY ═══
      // The last instant it is readable. See `reapedNames`: an orb this creature
      // fired can land two or three GAME TURNS from now, and its impact is
      // attributed to this id — without this the Case Log narrates the biggest
      // hit in the game as "someone hits Wren."
      const name = world.getActor(id)?.name;
      if (name !== undefined) reapedNames.set(id, name);

      engine.reap?.(id);
      broadcast({ v: PROTOCOL_VERSION, t: 'left', id });
    }

    // ...and the memo lives exactly as long as the sky does. Its only reader is
    // a projectile impact, so an empty sky means nothing can reference a buried
    // id and the Map may go back to nothing. This is the bound; there is no cap
    // and no eviction policy to get wrong.
    if (reapedNames.size > 0 && world.projectilesInFlight().length === 0) reapedNames.clear();

    // ═══ SURVIVAL REWRITES BODIES, SO THE BOARD IS RESENT ═══
    // Down, up or erased: each of the three swaps a SPRITE, and `sprite` travels
    // only on `ActorView`. See `needsFullResync` — without this a detective on
    // the floor is still drawn standing up.
    if (needsFullResync(result)) {
      if (isPartyWipe(result)) {
        app.log.warn({ gameTurn: result.turn.gameTurn }, 'party wipe — the floor resets');
      }
      broadcast({ v: PROTOCOL_VERSION, t: 'state', actors: projectActors(world) });
      // ═══ AND THE SKY WITH IT — `state` CARRIES NO ORB ═══
      // The resync above is the "the client's board may be out of step" hammer,
      // and it swings over `ActorView` alone. An orb is not an actor, so a
      // player being restored to their feet beside a shot that is still in the
      // air would be handed a corrected board and an uncorrected sky. It rides
      // the same event for the same few-KB-once reason, it is silent when
      // nothing is flying, and it updates the memo so the snapshot band below
      // does not say the same thing twice in one pump.
      sendProjectilesIfAny();
    }

    syncBell(result.turn);
    broadcastTurnIfChanged(result.turn);

    // THE TWO SNAPSHOTS, AFTER the events that caused them and BEFORE the
    // hotbars. Order is not cosmetic: a client that saw `downed` in a sweep and
    // then the party row is told the same thing twice in the right sequence,
    // whereas the reverse order shows a countdown for a body the playback has
    // not knocked over yet.
    //
    // Both are complete and both are memoised, so the common turn — somebody
    // walked, nothing landed on anybody — costs two `JSON.stringify` calls over
    // a handful of small objects and sends nothing.
    broadcastEffectsIfChanged();
    broadcastPartyIfChanged(Date.now());
    // THE THIRD SNAPSHOT, and the only one whose subject moved during the pump
    // rather than because of it. It goes out AFTER the `sweep` above for the
    // same reason the other two do: the frame that says an orb is gone must
    // follow the `attack` step that says what it hit, or a client draws the
    // impact against a sky that has already been cleared.
    broadcastProjectilesIfChanged();

    // Unicast, and each socket learns only about its own. This is deliberately
    // unconditional rather than gated on "did a talent happen": `actBase` ticks
    // cooldowns once per game turn whatever anyone did, so the hotbar goes stale
    // on a turn in which the viewer only walked. The per-session memo makes the
    // common case — nothing changed — cost one string compare.
    //
    // THE PARTY PANE RIDES THE SAME LOOP, for a different reason: a member's hp
    // and their presence change under a pump that had nothing to do with the
    // party at all, and `handleParty`'s targeted push cannot see those.
    refreshViewers();

    // ═══ LAST, AND THE ONLY LINE IN THIS FILE THAT TOUCHES A DISK ═══
    // AFTER the pump has returned and after every frame is out. Never inside the
    // engine, which eslint.config.js forbids from even importing persist/, and
    // never before the broadcast: a save that blocked would delay the frame the
    // player is waiting for, and the whole point of `PersistPort` returning void
    // is that this cannot become an `await`.
    //
    // Gated on "did anything happen": an idle pump is a fixed point — nothing
    // gained energy and nothing spent any — so there is nothing new to write and
    // a client spamming frames must not be able to farm disk writes.
    //
    // A body hitting the floor jumps the debounce; everything else rides it.
    // See `isSaveWorthy`. Note that a client cannot farm the immediate path
    // either: it takes somebody actually going down, which the engine decides.
    if (isSaveWorthy(result)) {
      saveNow('death');
    } else if (result.playerEvents.length > 0 || result.sweep.length > 0) {
      queueSave('pump');
    }
  };

  // -------------------------------------------------------------------------
  // Resume tokens and the reconnect grace
  // -------------------------------------------------------------------------

  /** Retire an actor's previous token and mint a fresh one. */
  const mintResumeToken = (actorId: string): string => {
    const previous = tokenByActor.get(actorId);
    if (previous !== undefined) actorByToken.delete(previous);
    const token = randomUUID();
    actorByToken.set(token, actorId);
    tokenByActor.set(actorId, token);
    return token;
  };

  const dropResumeToken = (actorId: string): void => {
    const token = tokenByActor.get(actorId);
    if (token !== undefined) actorByToken.delete(token);
    tokenByActor.delete(actorId);
  };

  const cancelGrace = (actorId: string): void => {
    const timer = graceTimers.get(actorId);
    if (timer === undefined) return;
    clearTimeout(timer);
    graceTimers.delete(actorId);
  };

  /**
   * The body is gone: the grace expired, so retire the actor for real.
   *
   * This is now the ONLY producer of `left`. In M1 a dropped socket sent one
   * immediately; M2 reserves it for an actual removal, which is why the protocol
   * version had to move.
   *
   * SIMPLIFICATION, HONESTLY LABELLED: game-design.md says the recall happens
   * "at the next safe moment", because pulling a body out mid-fight is a free
   * escape from a bad position. M2 recalls on the timer regardless. Gating it on
   * `engagement === 0` needs a level-wide engagement flag on the wire between
   * the engine and here, which is M4's business; ten minutes of a monster
   * chewing on an unattended body is a self-correcting problem in the meantime.
   */
  const recallBody = (actorId: string): void => {
    graceTimers.delete(actorId);
    dropResumeToken(actorId);
    connByActor.delete(actorId);
    // The body is gone, so the dot has nobody to be over. Left out and this map
    // is the one thing in the file that grows for the lifetime of the process.
    spokeAtMs.delete(actorId);
    // LAST WRITE BEFORE THE BODY LEAVES THE WORLD, and it has to happen while it
    // is still IN the world — `snapshotPlayers` reads the actor table, so a save
    // queued after `removePlayer` would write nothing and the ten minutes this
    // character spent unattended would be the ten minutes that were lost.
    //
    // ═══ AND IT HAS TO HAPPEN BEFORE THE `classChoiceOwed` DELETE BELOW ═══
    // NOT COSMETIC ORDERING. `snapshotPlayers` substitutes `UNASSIGNED_CLASS`
    // for anybody still in that set, so this flush is what writes "nobody has
    // chosen" for a player who never answered the screen. Delete first and the
    // substitution does not fire, this save stamps the ROTATION'S class onto
    // their file, and the choice they never made becomes permanent — which is
    // precisely the bug the two lines below used to describe as correct.
    saveNow('recall');
    // ═══ AND ONLY NOW DOES THE UNANSWERED CHOOSER GO ═══
    // The body is gone for good, so the set entry has nothing left to be about,
    // and without this it is the OTHER thing in the file that grows for the
    // lifetime of the process (`spokeAtMs` above is the first).
    //
    // ═══ THE CHOICE IS NOT LOST WITH IT ═══
    // This used to claim the opposite and call it correct: "by then
    // `saveNow('join')` has written the PROVISIONAL class to their file, so
    // `handleHello` correctly computes that they no longer owe a choice". That
    // was the bug wearing a justification. `actorIdForUser` is a stable hash, so
    // the same account gets this exact id back tomorrow — and a file naming a
    // class the player never picked would close the screen forever, because
    // `handleChooseClass` refuses anybody not in this set and nothing else in
    // the protocol re-opens it. With the flush above writing the sentinel, the
    // next `hello` re-offers the screen off the disk alone.
    //
    // A MERE DISCONNECT DOES NOT DO THIS, and the difference is the point: while
    // the grace runs the body is still in the world, a reconnect RESUMES it, and
    // somebody who dropped mid-chooser must find the screen where they left it.
    classChoiceOwed.delete(actorId);
    opts.persist?.closeCharacter?.(actorId);
    try {
      engine.leave(actorId);
    } catch (err) {
      app.log.error({ err, actorId }, 'engine.leave threw during recall');
    }
    world.removePlayer(actorId);
    broadcast({ v: PROTOCOL_VERSION, t: 'left', id: actorId });
    app.log.info({ actorId }, 'reconnect grace expired — body recalled');
    pumpAndBroadcast();
  };

  const startGrace = (actorId: string): void => {
    cancelGrace(actorId);
    const timer = setTimeout(() => {
      guard('reconnect-grace recall threw', () => {
        recallBody(actorId);
      });
    }, disconnectGraceMs);
    timer.unref();
    graceTimers.set(actorId, timer);
  };

  /**
   * ═════════════════════════════════════════════════════════════════════════
   * WHO IS ON THE FAR END OF THIS SOCKET? The whole of identity, in one lookup.
   * ═════════════════════════════════════════════════════════════════════════
   *
   * The client presents the opaque handle it got from `POST /api/token`. This
   * function asks the session table what that handle means. It does not parse
   * it, does not verify a signature, and could not be fooled by a forged one:
   * there is nothing in the handle to forge, only a row to find or not find.
   *
   * ABSENT, UNKNOWN OR EXPIRED ALL MEAN THE SAME THING — null, which is
   * anonymous play. That is a DESIGN CHOICE and not laziness, and it is worth
   * saying plainly because "fail closed" is usually the right instinct and here
   * it is not:
   *
   *   * It keeps tools/e2e-m1.mjs working. That harness is the only end-to-end
   *     proof the protocol still behaves, it sends a bare `hello`, and it must
   *     stay able to — including the assertion that extra identity fields on
   *     the wire cannot move another actor.
   *   * It keeps PLAIN-BROWSER DEVELOPMENT working. docs/discord-activity.md § 7
   *     is explicit that a browser dev loop is worth building at M1 and keeping:
   *     it is 95% of client work — renderer, fog, targeting, layout, log — with
   *     no Discord client running and no OAuth round-trip.
   *   * NOTHING IS AT RISK. An anonymous player gets a throwaway body and no
   *     file. They cannot reach anyone else's character, because the only route
   *     to one is a handle this server minted for that account. The refusal
   *     that matters — who may play at all — is ALLOWED_USER_IDS, and it is
   *     enforced in auth.ts before a handle exists.
   */
  const verify = (sessionId: string | undefined): VerifiedPlayer | null => {
    const store = opts.sessions;
    if (store === undefined || sessionId === undefined) return null;
    let found: ReturnType<IdentityPort['get']>;
    try {
      found = store.get(sessionId);
    } catch (err) {
      // A session table that throws must not cost somebody their evening. They
      // fall through to anonymous play and the reason is in the log.
      app.log.error({ err }, 'session lookup threw — treating this socket as anonymous');
      return null;
    }
    if (found === undefined) return null;
    return {
      ownerId: found.user.id,
      displayName: found.displayName,
      actorId: actorIdForUser(found.user.id),
    };
  };

  /**
   * Take an existing body over for this connection, closing whoever held it.
   *
   * THE ORDER IS THE WHOLE CORRECTNESS ARGUMENT. Ownership moves FIRST, so when
   * the old socket's `close` handler runs it sees that it is no longer the owner
   * and leaves the freshly-attached body alone — otherwise a reconnect would
   * immediately put the body it just picked up back on Standing By and arm a
   * ten-minute recall on it.
   *
   * TWO TABS ARE ONE PLAYER. This is the path a second tab takes: the same
   * account resolves to the same actor id, the same body, and the older socket
   * is hung up on. One person drives one detective — a party panel with two
   * identical names on it, splitting one character's turns between two windows,
   * is the failure the barrier cannot recover from.
   */
  const claimActor = (session: Session, actorId: string, why: string): void => {
    const previousConn = connByActor.get(actorId);
    connByActor.set(actorId, session.connId);
    if (previousConn === undefined || previousConn === session.connId) return;
    const stale = sessions.get(previousConn);
    if (stale === undefined) return;
    app.log.info(
      { actorId, stale: previousConn, conn: session.connId, why },
      'ws hello superseded an older connection',
    );
    stale.socket.close(CLOSE_SUPERSEDED, 'resumed elsewhere');
  };

  /**
   * Put a character file's contents onto a body that has just been created.
   *
   * ONLY EVER ON A FRESH BODY. A resumed actor is still standing in the world
   * with a live hp figure and live cooldowns; the file is by definition older
   * than that, so applying it would roll the session back to the last save.
   *
   * HP IS CLAMPED TO AT LEAST 1. A file can honestly hold 0 — the session ended
   * with that detective on the floor — and restoring it literally would produce
   * a body that is `alive` and standing at 0 hp, which no part of the engine
   * expects and which the party panel would draw as healthy. game-design.md § 9
   * has no permadeath: you come back on your feet, and one hit point is the most
   * grudging honest way to say so.
   */
  const applyRestore = (actor: Actor, restore: CharacterRestore | null): void => {
    if (restore === null) return;
    if (restore.hp !== null) {
      actor.hp = Math.max(1, Math.min(actor.maxHp, Math.floor(restore.hp)));
    }
    actor.cooldowns.clear();
    for (const [talentId, turns] of Object.entries(restore.cooldowns)) {
      if (turns > 0) actor.cooldowns.set(talentId, Math.floor(turns));
    }
    app.log.info(
      { actorId: actor.id, hp: actor.hp, cooldowns: actor.cooldowns.size },
      'restored a character from its file',
    );
  };

  /**
   * ═════════════════════════════════════════════════════════════════════════
   * WHICH CLASS A BODY IS BUILT AS. THE FILE WINS; THE ROTATION IS THE
   * FALLBACK; A DANGLING id SUBSTITUTES AND SAYS SO.
   * ═════════════════════════════════════════════════════════════════════════
   *
   * The RULE is `classForJoin`'s in content/classes.ts and this function
   * re-decides none of it — the same division `respawnRefusalText` keeps with
   * `RespawnRefusal`. What lives here is the two things content cannot know:
   * where the rotation counter is (per-process, per-gateway) and where a log
   * line goes.
   *
   * ═══ THE COUNTER ADVANCES ONLY ON A FRESH ASSIGNMENT ═══
   * A returning Watchman must not consume the Inspector's turn in the rotation,
   * or three friends who each reconnect once end up as three Watchmen. So the
   * increment is inside the branch that actually rolled for one.
   *
   * ═══ THERE IS A CHOOSER NOW, AND THIS IS STILL NOT IT ═══
   * `handleChooseClass` RE-CLOTHES a body this function already dressed; it
   * never replaces this function and it never runs before it. THE BODY IS NEVER
   * CLASSLESS — a token appears on four other screens the instant `addPlayer`
   * returns, so it has to arrive wearing something, and "provisionally a
   * Watchman for the four seconds it takes to pick" is a far smaller lie than a
   * body with no sprite, no maxHp and no combat sheet.
   *
   * ═══ AND A CHOICE DOES NOT ADVANCE THE COUNTER ═══
   * `handleChooseClass` deliberately leaves `classRotation` exactly where the
   * fresh assignment above left it. The counter's own rule is two paragraphs up:
   * it advances only on a fresh ASSIGNMENT, because it exists to spread the
   * FALLBACK across joiners. A chosen class is not a rolled one, so advancing it
   * would skew the fallback the next joiner gets — three friends who all pick
   * Watchman would push the rotation to the Alchemist for a fourth who chose
   * nothing at all, which is the opposite of what the counter is for.
   */
  let classRotation = 0;

  /**
   * ═════════════════════════════════════════════════════════════════════════
   * WHO STILL OWES US A CHOICE. Actor ids, and nothing else in the process
   * holds this.
   * ═════════════════════════════════════════════════════════════════════════
   *
   * Written once per body, in `handleHello`, and read in exactly two places:
   * the unicast that offers the picker, and `handleChooseClass`, which uses
   * membership as the whole of its authorisation check. Deleting the id IS the
   * once-per-body guarantee — there is no flag on the actor and no field in the
   * save file, because "has this socket been offered the screen yet" is a fact
   * about a session and not about a character.
   *
   * PER-GATEWAY, LIKE `classRotation`. A restart clears it, and that is correct
   * — but ONLY BECAUSE `snapshotPlayers` REFUSES TO WRITE THE PROVISIONAL CLASS
   * WHILE AN ID IS IN HERE. That is not a detail, it is the whole reason this
   * paragraph is true, and it used to be false in exactly the way that matters:
   * `handleHello` flushes `saveNow('join')` for every genuinely new character,
   * `fileFor` persists `snapshot.classId ?? binding.classId` (persist/saves.ts),
   * and the body at that instant is already wearing the ROTATION'S class. The
   * file therefore named a class seconds before the player had seen a single
   * card, the next `owes` read came back false, and there is no other frame or
   * command in the protocol that offers this screen — so a restart, or a recall,
   * or a lid closing for eleven minutes, permanently assigned somebody's class
   * for them. `snapshotPlayers` now writes `UNASSIGNED_CLASS` for anybody in
   * this set, so the file keeps saying "nobody has chosen" until they have.
   *
   * A MERE DISCONNECT DOES NOT CLEAR IT. A player who closes the tab mid-chooser
   * and comes back within the grace resumes the same body — `resolveActor`
   * answers `{ resumed: true }` and the `hello` block that writes this set never
   * runs — so if the id were dropped on the socket closing they would reconnect
   * to a provisional class they never picked and no way to change it. Leaving it
   * in is what makes the screen come back.
   *
   * THE RECALL DOES clear it, and that is a different event: the body is gone
   * for good, and by then their file names the provisional class. See
   * `recallBody`, where the reason is written out in full.
   */
  const classChoiceOwed = new Set<string>();

  /**
   * ═════════════════════════════════════════════════════════════════════════
   * A PLAYER READING THREE CLASS DESCRIPTIONS MUST NOT FREEZE THE FLOOR.
   * ═════════════════════════════════════════════════════════════════════════
   *
   * THE BUG THIS EXISTS TO PREVENT, IN FULL, BECAUSE IT IS NOT OBVIOUS AND IT IS
   * NOT PARTY-LOCAL. Parties scope the BARRIER — `surveyQuorum`, `bell` and
   * `expire` all take a `PartyScope` — so it is tempting to argue that a joiner
   * is a party of one and therefore nobody is waiting on them. The quorum half
   * of that is true. The conclusion is false, because parties do not scope the
   * WORLD CLOCK:
   *
   *   `isBlocking` (engine/barrier.ts:293-306) needs only `inQuorum` + energy at
   *   the threshold + no pending intent + no standing order + `engagement > 0`,
   *   and engagement is a LEVEL scalar — it does not care that the joiner is
   *   thirty tiles from the fight. `tickLevel` then pushes them into `parked`,
   *   and shared/energy.ts:647 makes every monster on the level `continue`
   *   ("Nothing else gets to act after the first park … the world is just as
   *   frozen as ToME's", :527-529). The party mid-fight next door can still move
   *   and swing — `actsWhileBlocked` is true for players — so they spend the
   *   whole of the joiner's Bell punching statues that never swing back. And the
   *   party-of-one framing makes that WORSE rather than better: `bellDurationMs`
   *   gives a lone straggler `BELL_MS.Solo` = two minutes, twice over before
   *   Standing By finally lifts it.
   *
   * SO THE BODY IS PARKED ON A STANDING HOLD INSTEAD. `standingOrder` is the
   * field the barrier already reads to mean "an order supplies this actor's
   * action, so it never blocks" (engine/actor.ts:149-159, and `actPlayer` at
   * engine/scheduler.ts:1316 auto-holds it). That is precisely the truth about
   * somebody who has not started playing yet: present, in the world, bracing,
   * and owing nobody a decision.
   *
   * NOT `standingBy`, and not `setConnected(false)`. The barrier is the ONLY
   * writer of `standingBy` in the process (engine/barrier.ts:109-110) and this
   * file must not become a second one; `setConnected(false)` would reach the
   * same result by TELLING EVERY OTHER PLAYER THAT THIS ONE IS OFFLINE
   * (`projectParty` sends `actor.connected` straight through), which is a lie
   * about somebody who is sitting right there reading.
   *
   * IT DOES NOT MAKE THEM SAFE, and it is not meant to. Monsters still act on an
   * unattended body — that is the same deliberate rule `recallBody` documents
   * for a dropped socket. What it removes is the ability of one unanswered modal
   * to stop the clock for everybody else.
   *
   * AND IT LASTS EXACTLY AS LONG AS THE SILENCE DOES. See `unparkOnCommand`: the
   * FIRST turn verb off this socket takes it straight back off, because the park
   * is a statement about somebody who has not started playing, not about
   * somebody who has not finished the paperwork.
   */
  const parkForClassChoice = (actor: Actor): void => {
    if (actor.kind !== 'player') return;
    actor.standingOrder = StandingOrder.Hold;
  };

  /**
   * They answered. Hand the body back to its owner.
   *
   * UNCONDITIONAL RATHER THAN PAIRED WITH A "DID WE PARK IT" FLAG: `hold` is the
   * only standing order this build can issue and `parkForClassChoice` is its
   * only writer, so clearing it here cannot cancel an order somebody else set.
   * The day `travel`/`rest` become standing orders, this becomes a compare — and
   * `StandingOrder` being a shared const rather than a literal is what will make
   * that edit findable.
   */
  const releaseFromClassChoice = (actor: Actor): void => {
    if (actor.kind !== 'player') return;
    actor.standingOrder = null;
  };

  /**
   * ═════════════════════════════════════════════════════════════════════════
   * A TURN VERB PROVES A HUMAN IS PLAYING. THE PARK COMES OFF, CHOICE OR NO.
   * ═════════════════════════════════════════════════════════════════════════
   *
   * THE SAME DOCTRINE `barrier.noteCommand` ALREADY STATES, and deliberately the
   * same wording: *"Any command clears it. Deliberately not 'any command that
   * resolves legally' — someone who is at the keyboard trying things is present,
   * and that is the only thing Standing By is measuring."* It is called BEFORE
   * the engine rules on the frame, so a move into a wall counts.
   *
   * ═══ WHY THE PARK CANNOT SIMPLY LAST UNTIL THE CHOICE LANDS ═══
   * "Owes a choice" and "is not playing" are not the same population. An
   * ANONYMOUS socket owes one — `openCharacter` returns null with no verified
   * identity, so `restore` is null and `owes` is true — and anonymous play is
   * not a curiosity here: it is plain-browser development (docs/discord-activity
   * .md § 7) and it is tools/e2e-m1.mjs, which sends a bare `hello` and then
   * starts walking. Leaving those bodies parked would mean the barrier never
   * waits for them, the world runs on past every command, and a shot fired at
   * somebody standing still would land in the same pump that killed the shooter.
   * That is not a hypothetical: it is what test/server/reap-broadcast.test.ts
   * measures, and it caught this exact overreach.
   *
   * THE CHOICE IS STILL OWED. This clears the standing order and NOTHING else —
   * the id stays in `classChoiceOwed`, the picker is still the only way out of
   * it, and the file still keeps the sentinel. What it gives back is the
   * barrier: from their first keypress on, the party waits for them like anybody
   * else, which is the correct answer for somebody who is demonstrably there.
   */
  const unparkOnCommand = (session: Session): void => {
    const actorId = session.actorId;
    if (actorId === null || !classChoiceOwed.has(actorId)) return;
    const body = world.getActor(actorId);
    if (body !== undefined) releaseFromClassChoice(body);
  };

  /**
   * THE PICKER, unicast, to the one player who owes a choice.
   *
   * ═══ IT IS A `ViewerMsg`, AND STRUCTURALLY SO ═══
   * `broadcast(projectClassOptions())` does not compile. What is per-viewer is
   * not the CONTENT — the frame is byte-identical for everybody, which is why
   * `projectClassOptions` takes no arguments — but whether it arrives at all.
   * Handed to the room, it would put a modal chooser in front of three people
   * who are mid-fight and have had a class for a week.
   *
   * ═══ AN ANONYMOUS SOCKET IS OFFERED IT TOO, AND NOTHING IT PICKS PERSISTS ═══
   * `openCharacter` returns null for a socket with no verified identity, so
   * `restore` is null, so it owes a choice — and there is no file for the accept
   * path to write to. That is deliberate and it is consistent with everything
   * else an anonymous session gets: its hp does not persist, its cooldowns do
   * not persist, its body is recalled when the grace expires. It is also the
   * ONLY way the screen is reachable in plain-browser development and from
   * tools/e2e-m1.mjs, where there is no Discord round trip to be verified by.
   * The alternative — refusing the picker to anonymous play — would make the
   * feature untestable by hand on the machine it is developed on.
   */
  const sendClassOptions = (session: Session): void => {
    const actorId = session.actorId;
    if (actorId === null) return;
    // MEMBERSHIP IS THE WHOLE GUARD, here and in `handleChooseClass`. One
    // predicate, asked in both places, so the screen can never be offered to
    // somebody whose choice would then be refused.
    if (!classChoiceOwed.has(actorId)) return;
    send(session.socket, projectClassOptions());
  };

  const classFor = (restore: CharacterRestore | null, who: string): ClassDef => {
    const saved = restore?.classId ?? null;
    const definition = classForJoin(saved, classRotation);

    if (saved !== null && saved !== UNASSIGNED_CLASS && classById(saved) === undefined) {
      // A SOFT REFERENCE THAT NO LONGER RESOLVES — a save from a build that had
      // a class this one does not. Substituted rather than refused: a character
      // file must never be the reason somebody cannot play tonight. Logged
      // because it is also the only evidence that a class was renamed.
      //
      // ═══ THE SENTINEL IS EXEMPT, AND THAT IS THE ORDINARY CASE ═══
      // `UNASSIGNED_CLASS` is what `fileFor` wrote unconditionally before this
      // milestone, so EVERY character file already on disk holds it and
      // `classById` answers `undefined` to it exactly as it does to a deleted
      // class. Without this clause the first evening after deploy logs a
      // warn-level "your save names a class this build does not have" for every
      // returning player — N false alarms, indistinguishable from the one
      // genuine dangling id this line exists to surface. The BEHAVIOUR was
      // always right (the rotation assigns one and the first save writes it);
      // only the diagnosis was wrong.
      app.log.warn(
        { actorId: who, savedClassId: saved, substituted: definition.id },
        'character file names a class this build does not have — substituting',
      );
    }
    if (saved === null || classById(saved) === undefined) {
      classRotation += 1;
    }
    return definition;
  };

  /** A `ClassDef` as `world.addPlayer` takes it. See `PlayerOverlay`. */
  const overlayFor = (definition: ClassDef): PlayerOverlay => ({
    sprite: definition.sprite,
    maxHp: definition.maxHp,
    hpRegen: definition.hpRegen,
    combat: definition.combat,
    classId: definition.id,
  });

  /**
   * Resolve which actor a `hello` belongs to.
   *
   * THREE PATHS, IN THIS ORDER, AND THE ORDER IS THE POINT:
   *
   *   1. A VERIFIED IDENTITY WINS OUTRIGHT. Their actor id is derived from their
   *      Discord id (`actorIdForUser`), so the body they get is the one they had
   *      last time — whether "last time" was four seconds or four days ago. The
   *      resume token is not even consulted on this path: a token is a claim
   *      about a SOCKET, identity is a claim about a PERSON, and if the two ever
   *      disagreed, honouring the token would hand somebody another player's
   *      character. Identity is the stronger fact and it decides.
   *   2. THE RESUME TOKEN, for an anonymous socket that dropped a moment ago. An
   *      unknown or expired one is NOT an error — protocol.ts says so — it just
   *      means a fresh session, which is honest given the token proves nothing
   *      about who is holding it.
   *   3. A NEW ANONYMOUS BODY, named `Player N`.
   *
   * `restore` is whatever the character file said, already read — see
   * `handleHello`, which is where the one await lives.
   */
  const resolveActor = (
    session: Session,
    token: string | undefined,
    verified: VerifiedPlayer | null,
    restore: CharacterRestore | null,
  ): ResolvedActor => {
    if (verified !== null) {
      const existing = world.getActor(verified.actorId);
      if (existing !== undefined) {
        claimActor(session, existing.id, 'identity');
        // Their Discord global name is authoritative every time they connect —
        // somebody who renamed themselves between sessions must not still be
        // showing the old name on four other screens.
        const renamed = existing.name !== verified.displayName;
        existing.name = verified.displayName;
        // ═══ NOTHING ELSE IS RE-ATTACHED HERE, AND THAT IS THE RESUME RULE ═══
        // This body never left the world. It is standing on its tile with its
        // live hp, its live cooldowns and its talent sheet — the class was
        // attached when it was created. Re-applying either the file or the
        // ClassDef would roll the session back to the last save, which is what
        // `applyRestore`'s own header calls out for hp and is just as true for
        // a resource pool.
        return { actor: existing, resumed: true, renamed };
      }
      const definition = classFor(restore, verified.actorId);
      const actor = world.addPlayer(verified.actorId, verified.displayName, overlayFor(definition));
      connByActor.set(actor.id, session.connId);
      // AFTER the class, never before: `applyRestore` clamps the saved hp to
      // `actor.maxHp`, so a Watchman restored at 70 would be filed down to 60
      // if the body were still classless when the file landed on it.
      applyRestore(actor, restore);
      return { actor, resumed: false, renamed: false };
    }

    if (token !== undefined) {
      const actorId = actorByToken.get(token);
      const existing = actorId === undefined ? undefined : world.getActor(actorId);
      if (existing !== undefined) {
        claimActor(session, existing.id, 'resume');
        // Same as the identity re-attach above: the body kept its class.
        return { actor: existing, resumed: true, renamed: false };
      }
    }

    joinCount += 1;
    // AN ANONYMOUS BODY IS STILL SOMEBODY'S EVENING. There is no file to read a
    // class out of and there never will be for this socket, so it takes the
    // rotation — plain-browser development and tools/e2e-m1.mjs get a real
    // hotbar rather than the four blank buttons a classless body would produce.
    const definition = classFor(null, `actor_${String(joinCount)}`);
    const actor = world.addPlayer(
      `actor_${randomUUID()}`,
      `Player ${joinCount}`,
      overlayFor(definition),
    );
    connByActor.set(actor.id, session.connId);
    return { actor, resumed: false, renamed: false };
  };

  /**
   * Read this player's character file, if they are somebody and there is one.
   *
   * NULL FOR EVERY OTHER CASE, deliberately flattened: an anonymous socket, a
   * server with no persistence wired in, a first-ever join, a corrupt file, a
   * file from a newer build. The caller's answer is the same in all of them —
   * build a fresh body — and distinguishing them here would only invite a branch
   * that refuses to let somebody play because their file did not parse. saves.ts
   * has already logged the diagnosis loudly.
   */
  const openCharacter = async (
    verified: VerifiedPlayer | null,
  ): Promise<CharacterRestore | null> => {
    const persist = opts.persist;
    if (verified === null || persist?.openCharacter === undefined) return null;
    try {
      return await persist.openCharacter(verified.ownerId, verified.actorId);
    } catch (err) {
      // The port promises not to reject. This is the belt to that braces: a
      // rejection here would escape into a `ws` event handler and kill the
      // process, taking everyone else's session with it.
      app.log.error({ err, actorId: verified.actorId }, 'opening a character file threw');
      return null;
    }
  };

  /**
   * ═════════════════════════════════════════════════════════════════════════
   * `hello` — THE ONE HANDLER THAT AWAITS, AND WHY THAT IS SAFE
   * ═════════════════════════════════════════════════════════════════════════
   *
   * CLAUDE.md non-negotiable 2 is that TURN RESOLUTION is fully synchronous:
   * the absence of an await inside a turn IS the mutex, which is why two
   * WebSocket frames cannot interleave mid-resolution. That rule is intact. The
   * await here happens BEFORE the world is touched — no intent is queued, no
   * pump is in flight, `session.actorId` is still null, and every frame this
   * socket could send in the meantime is refused with `send hello first`. There
   * is no turn to split.
   *
   * What the await buys is the thing this milestone exists for: the character
   * file is READ BEFORE THE BODY IS BUILT, so a returning player's hp and
   * cooldowns are right in the `welcome` frame rather than snapping into place a
   * moment later. The alternative — create, broadcast, then patch — puts a
   * visibly wrong figure on four screens and then corrects it.
   *
   * IT NEVER REJECTS. It is entered as `void handleHello(...)` from a `ws`
   * event handler, where a rejection after the first await is an unhandled
   * rejection and therefore a dead process, so the whole body is wrapped.
   */
  const handleHello = async (session: Session, msg: ClientHello): Promise<void> => {
    if (session.helloDone || session.helloPending) {
      sendError(session.socket, ErrorCode.BadMessage, 'hello has already been completed');
      return;
    }
    session.helloPending = true;

    const verified = verify(msg.sessionId);
    // Kept for the heartbeat, which slides the session's idle expiry. Stored
    // only when it actually resolved to somebody, so a junk handle is not
    // retained and re-looked-up every thirty seconds.
    session.sessionId = verified === null ? null : (msg.sessionId ?? null);
    session.ownerId = verified?.ownerId ?? null;

    const restore = await openCharacter(verified);

    // THE SOCKET MAY HAVE DIED DURING THE READ. Building a body for a connection
    // that is already gone would leave an actor nobody owns, with no close
    // handler left to put it on Standing By or arm its recall.
    if (!sessions.has(session.connId)) {
      app.log.info({ conn: session.connId }, 'ws closed while hello was resolving');
      return;
    }

    let resolved: ResolvedActor;
    try {
      resolved = resolveActor(session, msg.resumeToken, verified, restore);
    } catch (err) {
      // The only way out of addPlayer is "no free tile", which would take more
      // than 761 players. Answer honestly and close rather than leaving a socket
      // in a state where nothing works.
      app.log.error({ err, conn: session.connId }, 'ws hello could not place a player');
      sendError(session.socket, ErrorCode.Internal, 'could not place a player on the map');
      session.socket.close();
      return;
    }

    const actor = resolved.actor;
    session.actorId = actor.id;
    session.helloDone = true;

    // The body is attended again: cancel the recall and clear Standing By. Order
    // matters — an actor that is back in the quorum must not still have a timer
    // pointing at `recallBody`.
    cancelGrace(actor.id);
    if (!resolved.resumed) {
      engine.join(actor.id);
      // ═══ THE SHEET, AND IT HAS TO HAPPEN HERE — NOT A LINE LATER ═══
      // `sendLoadout` and `sendHotbarIfChanged` are ~25 lines below and both
      // return early on an empty loadout. Attach the class after them and the
      // welcome frame set carries no hotbar at all, and NOTHING RESENDS IT:
      // `sendHotbarIfChanged` is memoised per socket and the loadout frame is
      // sent exactly once per connection by design (M3 loadouts are fixed). The
      // player would sit there with four buttons' worth of talents and no bar
      // until they reconnected.
      //
      // FRESH BODIES ONLY. A resumed body still holds the sheet it was given —
      // with its spent Resolve and its running cooldowns — and re-attaching
      // would hand a returning player a full resource pool for free.
      //
      // READ OFF THE BODY rather than threaded down from `resolveActor`,
      // because the body is where it will still be tomorrow: `snapshotPlayers`
      // writes the same field to the save file, so the sheet and the file can
      // never be attached from two different answers to "what class is this".
      if (actor.kind === 'player' && actor.classId !== undefined) {
        engine.attachClass?.(actor.id, actor.classId);
      }

      // ═══ AND DOES THIS BODY OWE US A CHOICE? A THREE-VALUED READ ═══
      // Three states of the character file mean "nobody has ever picked": there
      // is no file at all (a first-ever join, or an anonymous socket), the file
      // has no class field, or the file holds `UNASSIGNED_CLASS` — the sentinel
      // `fileFor` wrote unconditionally before classes were wired in, which
      // every character file already on disk therefore holds.
      //
      // ═══ `classById(saved) === undefined` IS THE WRONG PREDICATE, AND THIS
      //     EXACT CONFUSION HAS ALREADY CAUSED ONE REAL INCIDENT ═══
      // It answers `undefined` for BOTH `'unassigned'` AND a class this build
      // deleted or renamed. persist/saves.ts:1110-1124 records what that cost
      // the first time: the dangling-class warning — whose stated purpose is to
      // be the ONLY evidence a class was renamed — fired for every returning
      // player on the first evening after deploy, N false alarms drowning the
      // one genuine case. Reusing it HERE would be the same mistake with far
      // sharper teeth: the day a class id is renamed, every returning player
      // would be shown the chooser, and the accept path would then OVERWRITE
      // their file with whatever they picked. A save is not recoverable from a
      // screen somebody was never supposed to see.
      //
      // So a DANGLING id does not owe a choice. It keeps `classFor`'s
      // substitute-and-log path — its owner plays on tonight, wearing a
      // stand-in, and the warn line is the evidence for whoever renamed the
      // class. That is a decision for a deploy, not for the player.
      const owes =
        restore === null || restore.classId === null || restore.classId === UNASSIGNED_CLASS;
      if (owes) {
        classChoiceOwed.add(actor.id);
        // AND THE BODY IS PARKED IN THE SAME BREATH. See `parkForClassChoice`:
        // without this line one player reading three class descriptions stops
        // every monster on the level for two minutes at a time, for everybody.
        // The two writes belong together and are never made apart — the set says
        // "we still owe them a screen" and the standing order says "so do not
        // wait on them", and either one alone is a bug.
        parkForClassChoice(actor);
      }
    }
    engine.setConnected(actor.id, true);

    const view = projectWorld(world);
    send(session.socket, {
      v: PROTOCOL_VERSION,
      t: 'welcome',
      selfId: actor.id,
      resumeToken: mintResumeToken(actor.id),
      level: view.level,
      actors: view.actors,
    });

    // Unicast, unconditionally, before anything else can change: a client that
    // has just connected must not have to wait for someone else to commit
    // before it learns whether the party is parked on it. `broadcastTurnIfChanged`
    // deliberately will not do this — the state has not changed, only the
    // audience has.
    sendTurn(session, engine.turnState(), bellRemainingMs());

    // The hotbar, for the same reason and with the same exception to the
    // on-change rule: this socket has seen nothing yet. A RESUMED session gets
    // it too — the body kept cooling down and spending while nobody was driving
    // it, and `session.viewerKey` is null on a fresh connection regardless of
    // whether the actor behind it is new.
    sendLoadout(session);
    sendHotbarIfChanged(session);

    // THE PICKER, for the one player who owes a choice, and outside the
    // on-change rule for the same stated reason as everything around it: this
    // socket has seen nothing yet. Silent for everybody else — see
    // `sendClassOptions`, where the set membership is checked.
    sendClassOptions(session);

    // THE TWO SNAPSHOTS, unicast, and again outside the on-change rule for the
    // same reason: this socket has seen nothing. The memo compares against the
    // last thing BROADCAST, so a client that joined after the Watchman went down
    // would otherwise not learn about it until somebody else's state changed —
    // which, with a party standing still deciding what to do, could be a long
    // time. A reconnecting player must see the Downed timer immediately; it is
    // the thing they came back for.
    if (opts.effects !== undefined) {
      send(session.socket, projectEffects(world, opts.effects));
    }
    send(session.socket, projectParty(world, opts.downed, speakingNow(Date.now())));

    // THE THIRD SNAPSHOT, unicast, and this one is not merely "outside the
    // on-change rule" — the memo would actively suppress it. A player who
    // reconnects mid-flight compares against the last thing BROADCAST, which
    // already carried this exact orb to everybody else, so the pump at the end
    // of this function would send them nothing at all and they would rejoin to
    // a clear sky with a shot still coming at them. `welcome` cannot carry it
    // either: that frame is the level and the actors, and an orb is neither.
    // Silent when nothing is in the air — see `sendProjectilesIfAny`.
    sendProjectilesIfAny(session.socket);

    // THE PARTY PANE, unicast, outside the on-change rule for the same reason
    // as everything above it: this socket has seen nothing. A reconnecting
    // player must find their party still standing where they left it — and a
    // brand-new one must be told, immediately, that they are a party of one,
    // because "you are on your own until you invite somebody" is a rule the
    // pane is the only place to learn.
    sendPartyStateIfChanged(session);

    // A resume reattaches to an actor everyone can already see, so it announces
    // nothing; only a genuinely new player is a `joined`.
    if (!resolved.resumed) {
      broadcast({ v: PROTOCOL_VERSION, t: 'joined', actor: toActorView(actor) }, session.connId);
      // A NEW CHARACTER EXISTS. Nothing has happened to it yet, so the pump
      // below may produce no events at all and never reach `queueSave` — but the
      // file has to exist before the first thing that changes it does. Immediate
      // rather than debounced, because "first sight" is precisely the five
      // seconds in which a brand-new character has no file at all.
      saveNow('join');
    } else if (resolved.renamed) {
      // They changed their Discord global name since they were last here, and
      // `name` travels only on `ActorView`. No delta can express it, so the board
      // is resent — the same deliberately dumb answer `needsFullResync` gives,
      // for the same reason, and at the same cost of a few KB once.
      broadcast({ v: PROTOCOL_VERSION, t: 'state', actors: projectActors(world) }, session.connId);
      // ═══ AND THE SKY WITH IT — THE CLIENT CLEARS ITS ORBS ON `state` ═══
      // src/client/main.ts's `case 'state'` runs `clearProjectiles()`, so this
      // broadcast wipes every orb from every OTHER player's screen. The memo
      // would then actively suppress the correction: `broadcastProjectilesIfChanged`
      // compares against the last thing BROADCAST and the list has not changed,
      // so the pump at the foot of `hello` sends nothing. The whole party would
      // be dodging a shot they can no longer see, because somebody else changed
      // their Discord name.
      //
      // The `state` above excludes `session.connId` while this does not, and
      // that is harmless: the frame is ABSOLUTE, and the rejoining socket
      // already got its own unicast copy a few lines up.
      sendProjectilesIfAny();
    }

    app.log.info(
      {
        conn: session.connId,
        actorId: actor.id,
        resumed: resolved.resumed,
        // WHETHER they are verified, never WHO. `ownerId` is a real person's
        // snowflake and CLAUDE.md non-negotiable 7 keeps it out of every log
        // line; the actor id above is already the hashed, pasteable form.
        verified: verified !== null,
      },
      'ws hello completed',
    );

    // Rejoining changes the quorum, so the barrier may be able to move.
    pumpAndBroadcast();
  };

  const handleMove = (session: Session, msg: ClientMove): void => {
    const actorId = session.actorId;
    if (actorId === null) {
      sendError(session.socket, ErrorCode.NotAuthenticated, 'send hello before moving');
      return;
    }
    // A KEY WAS PRESSED, SO THE BARRIER IS THEIRS AGAIN. See `unparkOnCommand`
    // — and it goes above `submitMove` on purpose, because trying to walk into a
    // wall is still somebody at the keyboard.
    unparkOnCommand(session);

    const result = engine.submitMove(actorId, msg.dir);
    if (!result.ok) {
      // Only the sender hears about a refusal: a wall nobody walked into is not
      // an event, and telling the room would leak where people are trying to go.
      sendError(session.socket, ErrorCode.IllegalMove, `move blocked: ${result.reason}`);
      return;
    }

    // The step itself comes back out of the pump as a `moved` to EVERYONE, the
    // mover included. See the header note: there is no optimistic path.
    pumpAndBroadcast();
  };

  /**
   * `talent` — the frame the whole of M3 hangs off, and the one with a real
   * attack surface.
   *
   * NOTHING HERE DECIDES ANYTHING. The gateway's job on this frame is exactly
   * three things: know who the socket is, hand the request to the engine, and
   * translate a refusal into the specific `ErrorCode` the client can act on. It
   * does NOT check range, and it must never learn how: a distance test written
   * here would be a second copy of the rule in `submitTalent`, the two would
   * eventually disagree about one tile, and the bug would present as the server
   * cheating on the Inspector's dead zone.
   *
   * `result.code` is forwarded verbatim rather than mapped, because a mapping
   * table is precisely where `too_close` would one day be folded into
   * `out_of_range` — opposite instructions to the player, and the documented way
   * a positional class reads as broken.
   *
   * A refusal is UNICAST, like a blocked move: the room does not need to know
   * that someone tried to shoot through a wall, and telling them leaks where
   * people are aiming.
   */
  const handleTalent = (session: Session, msg: ClientTalent): void => {
    const actorId = session.actorId;
    if (actorId === null) {
      sendError(session.socket, ErrorCode.NotAuthenticated, 'send hello before using a talent');
      return;
    }
    // See `handleMove`: a talent that is out of range still proves somebody is
    // driving this body, so the class-choice park comes off before the ruling.
    unparkOnCommand(session);

    const result = engine.submitTalent(actorId, msg.talentId, msg.target);
    if (!result.ok) {
      sendError(session.socket, result.code, result.reason);
      return;
    }

    pumpAndBroadcast();
  };

  /**
   * `commit` and `hold` — the two frames that drive the barrier.
   *
   * One function because the failure handling is identical and the difference is
   * one method call; splitting them would duplicate the not-authenticated check
   * and the error path, which is where a divergence would eventually hide.
   */
  const handleTurnVerb = (session: Session, verb: 'commit' | 'hold'): void => {
    const actorId = session.actorId;
    if (actorId === null) {
      sendError(session.socket, ErrorCode.NotAuthenticated, `send hello before ${verb}`);
      return;
    }
    // See `handleMove`. `commit` and `hold` are the two frames that exist ONLY
    // to say "I am here and I have decided", so if any verb releases the
    // class-choice park these two must.
    unparkOnCommand(session);

    const result = verb === 'commit' ? engine.commit(actorId) : engine.hold(actorId);
    if (!result.ok) {
      // NotYourTurn, not IllegalMove: "not now" and "not there" mean opposite
      // things to a client, and a mislabelled one tells a player their input was
      // wrong when the truth is that the server has not asked them yet.
      sendError(session.socket, ErrorCode.NotYourTurn, `${verb} refused: ${result.reason}`);
      return;
    }

    pumpAndBroadcast();
  };

  // -------------------------------------------------------------------------
  // THE CASE LOG'S RECORD LANE — turn events, in prose
  //
  // WHY THE SENTENCE IS BUILT HERE AND NOT IN THE BROWSER. The alternative is
  // sending the event and letting the client format it, and that puts a second
  // copy of the game's vocabulary in a place that cannot be tested against the
  // engine: the first time a talent grew a field, the log would print
  // `undefined` at the one moment somebody was reading it to work out what had
  // killed them. The server already has every number. It writes the line.
  //
  // WHY IT IS IN net/ AND NOT IN view/. It needs `engine.loadoutOf` to turn a
  // talent id into the name a player recognises, and view/ may not reach the
  // engine adapter. It is also prose, not a projection — nothing downstream
  // parses it, so there is no shape to keep in step with anything.
  //
  // WHAT IS DELIBERATELY NOT LOGGED: every monster's step. game-design.md § 11's
  // sample logs the party's moves and then jumps straight to "── Bent Watchman
  // acts", because eight husks shuffling produces eight lines that bury the one
  // line that mattered — and the map is already showing every one of those steps
  // twice as clearly as a sentence could.
  // -------------------------------------------------------------------------

  /** `talent:ward_rush` -> `Ward Rush`. The fallback when no loadout names it. */
  const prettyId = (namespaced: string): string => {
    const bare = namespaced.slice(namespaced.indexOf(':') + 1);
    return bare
      .split('_')
      .filter((word) => word !== '')
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  };

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE NAMES OF BODIES THAT HAVE BEEN BURIED WHILE A SHOT OF THEIRS IS STILL
   * IN THE AIR.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `reap` deliberately does NOT clear projectiles — engine/projectile.ts is
   * explicit that the shooter may be a corpse three turns later and the orb
   * carries everything it needs to resolve. It carries everything except the one
   * thing THIS lane needs: a name. `actProjectile` emits the impact as
   * `{t:'attack', id: proj.sourceId}`, `nameOf` resolves that through
   * `world.getActor`, and once the body is gone the Case Log prints
   * "someone hits Wren." for the single biggest hit in the game.
   *
   * That was invisible before this milestone because a dead monster was never
   * removed at all. The reap window's ordering (narrate, THEN bury) only
   * protects the pump the shooter died IN — and the wraith authors
   * `projSpeed 2` over `attackRange 6`, so an orb takes two to three GAME TURNS
   * to arrive. The cross-pump case is the normal one.
   *
   * ═══ IT IS BOUNDED BY THE SKY, NOT BY A MAGIC NUMBER ═══
   * The only reader is a projectile impact, so the memo is emptied the moment
   * nothing is in flight — see the reap window. A session that never fires
   * carries an empty Map forever.
   */
  const reapedNames = new Map<string, string>();

  /**
   * A body's display name. The world first, then the memo above.
   *
   * `'someone'` remains the last resort and it is still reachable — an id from
   * before a restart, a fixture with no body — but it is no longer what a dead
   * wraith's orb narrates as.
   */
  const nameOf = (id: string): string =>
    world.getActor(id)?.name ?? reapedNames.get(id) ?? 'someone';

  /**
   * A talent's display name, from the CASTER'S OWN BOOK where there is one.
   *
   * `TalentEvent` carries the id and not the name — protocol.ts says so, because
   * a spectator gets the event for a talent that is not in their loadout — so
   * the authoritative name has to come from the engine. A monster has no
   * loadout, and `prettyId` covers it rather than printing `talent:gutting_strike`
   * at somebody.
   */
  const talentName = (casterId: string, talentId: string): string =>
    engine.loadoutOf(casterId).find((talent) => talent.id === talentId)?.name ?? prettyId(talentId);

  /** Which compass word a step took, or '' when the two tiles are not adjacent. */
  const stepWord = (fromX: number, fromY: number, x: number, y: number): string => {
    const dir = DIR_ORDER.find((candidate) => {
      const vec = dirVector(candidate);
      return fromX + vec.dx === x && fromY + vec.dy === y;
    });
    return dir === undefined ? '' : dir.toUpperCase();
  };

  /**
   * One turn event -> zero or more Record lines.
   *
   * TWO DEPTHS, exactly as the sample log is written: a headline for the thing
   * that happened, and indented consequences hanging off it. `attack` is the
   * headline and its `damage` and `death` are the consequences, which is why a
   * landed blow does not repeat the victim's name at depth 0.
   */
  const recordFor = (event: TurnEvent, isSweep: boolean): { text: string; depth: number }[] => {
    switch (event.k) {
      case 'move': {
        // PLAYERS ONLY. See the block comment above.
        if (isSweep) return [];
        const word = stepWord(event.fromX, event.fromY, event.x, event.y);
        return [
          {
            text: word === '' ? `${nameOf(event.id)} moves.` : `${nameOf(event.id)} moves ${word}.`,
            depth: 0,
          },
        ];
      }
      case 'attack':
        return [
          {
            text: event.hit
              ? `${nameOf(event.id)} hits ${nameOf(event.targetId)}.`
              : `${nameOf(event.id)} misses ${nameOf(event.targetId)}.`,
            depth: 0,
          },
        ];
      case 'damage': {
        // ═══ THE SAME FRAME, THE OPPOSITE VERB ═══
        // A heal rides the `damage` frame (see `DamageEvent.healed`: one
        // implementation of "an actor's hp changed"), and this is where the two
        // part company in words. Without it the party's only heal narrated as
        // "0 damage. Ren 41.5/54." under a line saying the Alchemist hit herself.
        const healed = event.healed ?? 0;
        if (healed > 0) {
          return [
            {
              text: `${nameOf(event.id)} is patched up. ${Math.round(healed)} healed, now ${Math.max(0, Math.ceil(event.hp))}/${event.maxHp}.`,
              depth: 1,
            },
          ];
        }
        return [
          {
            /**
             * ═══════════════════════════════════════════════════════════════
             * ROUNDED HERE, AT THE DISPLAY, AND NOWHERE NEAR THE ENGINE.
             * ═══════════════════════════════════════════════════════════════
             *
             * Moving the scheduler onto `combat.ts#attackTarget` replaced the
             * old integer `rng.int` with ToME's real pipeline, which is
             * fractional and float-noisy by construction — `dam * pres -
             * armour + dam * (1 - pres)` (damage.ts) does not land on integers.
             * MEASURED over 20k landed blows per matchup: 39-100% of a player's
             * blows and about half of a husk's are non-integers, so this line
             * was printing things like "10.999999999999998 damage. Index Husk
             * 14.000000000000002/25." in the game's most-read UI. Every number
             * a player saw before this milestone was an integer.
             *
             * THE ENGINE KEEPS FULL PRECISION. Rounding in damage.ts would
             * change the armour arithmetic and every replay-from-seed after it;
             * this is a string, and a string is the right place to lie.
             *
             * `ceil` FOR HP, `round` FOR THE BLOW, matching partypanel.ts and
             * turncards.ts — a body on 14.2 reads 15 everywhere or the party
             * panel and the Case Log disagree about the same creature. `maxHp`
             * is authored and integral, so it is left alone.
             *
             * No damage TYPE on the wire yet (`DamageEvent` carries the amount
             * and the absolute vitals). When it lands, "19 physical" goes here
             * and nothing else in this function changes.
             */
            text:
              `${Math.round(event.amount)} damage. ` +
              `${nameOf(event.id)} ${Math.max(0, Math.ceil(event.hp))}/${event.maxHp}.`,
            depth: 1,
          },
        ];
      }
      case 'death':
        // "Unfiled" is the game's own word for it — game-design.md § 11's sample
        // log reads "Index Wraith is unfiled", and using the fiction's noun in
        // the mechanical lane is most of what gives the Record its voice.
        return [{ text: `${nameOf(event.id)} is unfiled.`, depth: 1 }];
      case 'talent':
        return [
          { text: `${nameOf(event.id)} uses ${talentName(event.id, event.talentId)}.`, depth: 0 },
        ];
      case 'effect_applied': {
        const effect = prettyId(event.effectId);
        // ═══ THE PARTIAL SAVE, IN WORDS ═══
        // Actor.lua:6993-7043 scales a duration by how well the save went rather
        // than negating outright, and game-design.md § 11 calls out its own log
        // line for exactly this: "Dalt saves — Slowed 1 turn, not 3." Without the
        // "not 3" the mechanic is invisible: a player sees a short stun and
        // concludes the enemy was weak, rather than that their save worked.
        const scaled = event.turns < event.maximum;
        return [
          {
            text: scaled
              ? `${nameOf(event.id)} is ${effect} ${event.turns} turn(s), not ${event.maximum}.`
              : `${nameOf(event.id)} is ${effect} ${event.turns} turn(s).`,
            depth: 1,
          },
        ];
      }
      case 'effect_expired':
        return [{ text: `${prettyId(event.effectId)} leaves ${nameOf(event.id)}.`, depth: 1 }];
      case 'downed':
        // DEPTH 0 AND ITS OWN LINE. This is the loudest thing that happens in a
        // fight and it starts a five-turn clock; burying it under the blow that
        // caused it would be the log editorialising in the wrong direction.
        return [
          { text: `${nameOf(event.id)} is DOWN — ${event.turns} turns to reach them.`, depth: 0 },
        ];
      case 'revived':
        return [
          {
            text: `${nameOf(event.byId)} gets ${nameOf(event.id)} back on their feet. ${event.hp}/${event.maxHp}.`,
            depth: 0,
          },
        ];
      case 'erased':
        return [
          {
            text:
              event.reason === ErasedReason.Wipe
                ? `${nameOf(event.id)} is erased — the party is down. The floor resets.`
                : `${nameOf(event.id)} is erased. Nobody reached them in time.`,
            depth: 0,
          },
        ];
    }
  };

  /**
   * Narrate one pump into the Record lane, as ONE batch.
   *
   * One frame rather than one per line, for the same reason the sweep is one
   * frame: a batch of twenty lines is one `JSON.stringify` and one draw, and the
   * client appends them in order. Silence when nothing happened — an idle pump
   * must not cost a frame.
   */
  const broadcastRecord = (result: PumpResult): void => {
    const lines: LogLine[] = [];
    const gameTurn = result.turn.gameTurn;

    const emit = (event: TurnEvent, isSweep: boolean): void => {
      for (const line of recordFor(event, isSweep)) {
        logSeq += 1;
        lines.push({
          seq: logSeq,
          lane: LogLane.Record,
          gameTurn,
          text: line.text,
          depth: line.depth,
        });
      }
    };

    for (const event of result.playerEvents) emit(event, false);
    for (const event of result.sweep) emit(event, true);

    if (lines.length === 0) return;
    broadcast({ v: PROTOCOL_VERSION, t: 'log', lines });
  };

  // -------------------------------------------------------------------------
  // The Case Log's Margin lane — `say` and `point`
  //
  // NEITHER OF THESE PUMPS, and that is the design rather than an omission.
  // Talking costs no energy, cannot be refused for being out of turn, and works
  // while you are Downed (game-design.md § 9: "you can still talk in the log").
  // Making speech go through the barrier would mean the Bell could time out a
  // sentence, which is the exact opposite of what the Bell is for.
  // -------------------------------------------------------------------------

  /**
   * Broadcast one Margin line.
   *
   * ONE FUNCTION FOR BOTH VERBS so `seq` can only ever be minted in one place.
   * Two counters, or two increments, and a client's de-duplication quietly stops
   * working the day the second one is added.
   */
  const broadcastMargin = (line: Omit<LogLine, 'seq' | 'lane' | 'gameTurn'>): void => {
    logSeq += 1;
    const full: LogLine = {
      seq: logSeq,
      lane: LogLane.Margin,
      gameTurn: world.turn.clock.gameTurn,
      ...line,
    };
    broadcast({ v: PROTOCOL_VERSION, t: 'log', lines: [full] });
  };

  /**
   * ONE RECORD LINE for something that happened OUTSIDE a pump.
   *
   * `broadcastRecord` above narrates turn EVENTS, which is every ordinary thing
   * the game does. A self-respawn is the one state change a player can cause
   * that the engine's event list cannot carry: an Erased body is not ticked at
   * all (that is what makes the erased state cheap), so the restoration is
   * applied between pumps and there is no `GameEvent` to translate.
   *
   * It shares `logSeq` with the Margin and the Record batch, and it must: two
   * counters is how a client's de-duplication quietly stops working.
   */
  const broadcastRecordLine = (text: string): void => {
    logSeq += 1;
    broadcast({
      v: PROTOCOL_VERSION,
      t: 'log',
      lines: [
        {
          seq: logSeq,
          lane: LogLane.Record,
          gameTurn: world.turn.clock.gameTurn,
          text,
          depth: 0,
        },
      ],
    });
  };

  /**
   * `say` — one line in the Margin, attributed by the SERVER.
   *
   * The speaker's name comes from the actor this socket owns, never from the
   * frame: `SaySchema` is a `strictObject` with a single `text` field precisely
   * so there is nothing to forge. A player whose nickname is "Sam: " still shows
   * up as themselves, because the name travels in `speaker` and the client draws
   * the two separately rather than concatenating and re-splitting.
   *
   * The text reaches the wire as the player typed it (trimmed and length-capped
   * by zod, which is a shape check, not sanitisation) — it is drawn with
   * `fillText` and mirrored with `textContent`, so there is no markup context to
   * escape into. eslint.config.js § group 6 is the other half of that guarantee.
   */
  const handleSay = (session: Session, msg: ClientSay): void => {
    const actorId = session.actorId;
    if (actorId === null) {
      sendError(session.socket, ErrorCode.NotAuthenticated, 'send hello before speaking');
      return;
    }
    const speaker = world.getActor(actorId);
    if (speaker === undefined) {
      sendError(session.socket, ErrorCode.Internal, 'your body is not in the world');
      return;
    }
    broadcastMargin({ text: msg.text, speaker: speaker.name });
    // THE SPEAKING DOT, server-side half. A line in the Margin is the one piece
    // of "this person is here" the server can know on its own — Discord's voice
    // events never reach it. See `noteSpoke` and `PartyMember.voice`.
    noteSpoke(actorId);
  };

  /**
   * `point` — a marker on a tile, plus its transcript line.
   *
   * TWO FRAMES FOR ONE GESTURE, on purpose. `pinged` is the MARKER: it expires
   * on the client after a few seconds and is meaningless to anyone who looks up
   * later. The Margin line is the TRANSCRIPT: it survives, it is readable by
   * somebody who was scrolled up, and it is what makes "which arch?" answerable
   * thirty seconds after the fact.
   *
   * The tile is bounds-checked here rather than trusted: `TileSchema` only
   * proves the number is a small non-negative integer, and a marker at (4000,
   * 4000) is a marker nobody can see attached to a log line that lies.
   */
  const handlePoint = (session: Session, msg: ClientPoint): void => {
    const actorId = session.actorId;
    if (actorId === null) {
      sendError(session.socket, ErrorCode.NotAuthenticated, 'send hello before pointing');
      return;
    }
    const pointer = world.getActor(actorId);
    if (pointer === undefined) {
      sendError(session.socket, ErrorCode.Internal, 'your body is not in the world');
      return;
    }
    if (!inBounds(msg.x, msg.y, world.level.w, world.level.h)) {
      sendError(session.socket, ErrorCode.IllegalMove, 'that tile is not on the map');
      return;
    }

    broadcast({ v: PROTOCOL_VERSION, t: 'pinged', id: actorId, x: msg.x, y: msg.y });
    broadcastMargin({ text: `points at ${msg.x},${msg.y}`, speaker: pointer.name });
  };

  /**
   * ═════════════════════════════════════════════════════════════════════════
   * `inspect` — "WHAT IS THAT, AND CAN I HIT IT?", answered to ONE socket.
   * ═════════════════════════════════════════════════════════════════════════
   *
   * src/server/view/inspect.ts does the knowing; this does the COMPOSING. That
   * split is deliberate — the two questions ("what may this viewer know about
   * that body" and "would an attack be refused") have different gates, and the
   * order in which they are asked is a security property. All three notes below
   * are about that order.
   *
   * ═══ 1. THE TWO NULLS ARE THE SAME NULL, DELIBERATELY ═══
   * An id that names nobody and a body the viewer cannot see produce a
   * BYTE-IDENTICAL frame: `{ t: 'inspected', targetId, view: null }`. Nothing
   * distinguishes them — not an `ErrorCode`, not a `reason`, not a differently
   * shaped answer, not the ORDER they arrive in.
   *
   * inspect.ts:32-36 makes this argument about the RECORD shape: a redacted
   * card still confirms something is there. The id-not-found branch is not
   * covered by that file, because it does not live there — it lives HERE, and
   * so the same argument has to be re-made and honoured at this site. A client
   * that could sort the two replies apart would not need to see anybody: it
   * would walk the id space, keep every id that answered "cannot see it", and
   * have enumerated the whole floor. Every one of the distinguishers listed
   * above rebuilds that oracle, which is why they are listed.
   *
   * ═══ 2. `attackBlockedReason` IS ASKED ONLY AFTER `inspectActor` SAID YES ═══
   * Never before it, and never on its own. It has NO VISIBILITY GATE — it is
   * the resolution-time refusal list, not a knowledge check — and for a target
   * behind a wall it returns the literal string 'no line of sight'
   * (inspect.ts:179). That sentence confirms two things at once: the actor
   * exists, and it is somewhere with a wall in between. Which is exactly the
   * leak note 1 forbids, arriving through the other door. So it is composed
   * strictly downstream of a non-null view, and its answer rides INSIDE that
   * view rather than beside it.
   *
   * ═══ 3. NO `opts`, SO THE REACH IS THE VIEWER'S OWN ═══
   * With nothing passed, `minRange` and `maxRange` come off the VIEWER's sheet
   * (`viewer.combat?.minRange ?? 0`, `viewer.combat?.range ?? 1`) — which is
   * bump-attack reach, and bump-attack is the only attack this protocol has:
   * there is no `attack` frame, a `move` into an occupied tile IS the attack
   * (scheduler.ts strikes the occupant before terrain is consulted). So
   * `blockedReason` answers the question the tooltip is actually being asked —
   * "if I walk into it right now, do I hit it?" — rather than some abstract
   * reachability. An `opts` here would silently answer about a talent nobody
   * selected.
   */
  const handleInspect = (session: Session, msg: ClientInspect): void => {
    const actorId = session.actorId;
    if (actorId === null) {
      sendError(session.socket, ErrorCode.NotAuthenticated, 'send hello before inspecting');
      return;
    }
    const viewer = world.getActor(actorId);
    if (viewer === undefined) {
      sendError(session.socket, ErrorCode.Internal, 'your body is not in the world');
      return;
    }

    const target = world.getActor(msg.targetId);
    const view = target === undefined ? null : inspectActor(world, viewer, target);
    // `target === undefined` is re-tested rather than asserted away with `!`:
    // it is what NARROWS `target` for the call, and `view !== null` already
    // implies it. A non-null assertion would be telling the compiler to stop
    // checking the one invariant note 2 exists to maintain.
    const answer =
      target === undefined || view === null
        ? null
        : { ...view, blockedReason: attackBlockedReason(world, viewer, target) };

    send(session.socket, {
      v: PROTOCOL_VERSION,
      t: 'inspected',
      targetId: msg.targetId,
      view: answer,
    });
  };

  /**
   * ═════════════════════════════════════════════════════════════════════════
   * `choose_class` — "I will be the Watchman." ONCE PER BODY, AND THE SERVER
   * DECIDES.
   * ═════════════════════════════════════════════════════════════════════════
   *
   * IT READS NOTHING FROM THE FRAME BUT `classId`. There is nothing else on it
   * to read: `ChooseClassSchema` is a `strictObject` of `{v, t, classId}`, so a
   * smuggled `actorId` is REJECTED rather than stripped. Identity is
   * `session.actorId`, exactly as with `move` and `respawn`.
   *
   * ═══ THE ORDER OF THE THREE CHECKS, AND WHY EACH CODE IS THE ONE IT IS ═══
   *   1. `classById(msg.classId)` undefined -> `bad_message`. zod deliberately
   *      accepts a well-formed frame naming a class this build has never heard
   *      of (protocol.ts states the reason: baking the catalogue into the wire
   *      schema would make every content edit a protocol change), so this lookup
   *      is the ONLY thing refusing it. `bad_message` rather than a game-rule
   *      code because nobody's picker can produce it — the ids came off the
   *      `class_options` frame this same server sent.
   *   2. Not in `classChoiceOwed` -> `not_your_turn`, with the server's own
   *      sentence, in the shape `handleRespawn` uses. It means what that one
   *      means: *not now*. You already have a class — either you picked one
   *      moments ago or you walked in with one on file.
   *   3. NOT ON YOUR FEET -> `not_your_turn`, AND THE OFFER STANDS. New, and it
   *      is a correctness check rather than a nicety. A body that has not
   *      answered the chooser is parked on a standing hold, NOT protected: a
   *      monster can put it on the floor while the modal is up (see
   *      `parkForClassChoice`). Re-clothing a Downed body would write the CHOSEN
   *      class's sprite over one whose `DownedRecord.upSprite` still remembers
   *      the PROVISIONAL one (engine/downed.ts:396), and `revive`/`standUp`
   *      (:528, :690) would then put the wrong class back on its feet — for the
   *      rest of the session, with `projectTurn`'s portrait derived from
   *      `actor.sprite` and `inspect`'s `className` derived from `actor.classId`
   *      disagreeing permanently. It would also broadcast a full green bar under
   *      a Downed marker. The id STAYS in `classChoiceOwed`, so the screen is
   *      still owed and still answerable the moment they are up again.
   *   4. No fourth check. `helloDone` and the rate-limit bucket already gate
   *      every non-hello branch above the dispatch switch, so an unauthenticated
   *      socket never reaches this function at all.
   *
   * NO NEW `ErrorCode` MEMBER, deliberately. version.ts's 7 -> 8 entry now
   * states in writing that reusing the two existing codes is what keeps the bump
   * argument down to a single reason; adding a third would contradict a comment
   * that is in the file.
   *
   * ═══ REFUSING THE SECOND CHOICE IS A GAME RULE, NOT TIDINESS ═══
   * `engine.attachClass` ends in an unconditional `sheets.set`
   * (engine/talents.ts:872-875) and `world.reclothePlayer` used to set
   * `hp = maxHp` outright. Reachable a second time those are a FULL resource
   * pool and a FULL health bar on demand: a free second wind, available to
   * anyone with a devtools console, in the middle of a fight. The wire cannot
   * express that rule (the frame is legal, the id is real), so this membership
   * test is the whole of it.
   *
   * ═══ AND THE MEMBERSHIP TEST IS NO LONGER THE ONLY THING HOLDING IT ═══
   * It used to be, and the argument underneath it — "the body is undamaged by
   * construction, so the fill can only ever compute maxHp from maxHp" — was
   * false in two ways this handler never checked. A RETURNING player is restored
   * from their file (`applyRestore`) and THEN offered the chooser, because every
   * character file written before classes existed holds `UNASSIGNED_CLASS`; and
   * a body whose owner is reading the modal is still in the world, where things
   * can hit it. Both halves are now closed where the value is actually minted
   * rather than here: `reclothePlayer` fills only a body that was already at its
   * ceiling and otherwise clamps, and the `attachClass` seam (src/server/main.ts)
   * carries the spent share of the old pool into the new one. THE FIRST choice
   * on a battered body is therefore not a heal either.
   *
   * NON-PUMPING, like `inspect` and `party`'s refusal path: choosing a class
   * costs no energy, queues no intent and draws no RNG. A frame that costs the
   * sender nothing must not be a way to make the server advance the world.
   */
  const handleChooseClass = (session: Session, msg: ClientChooseClass): void => {
    // A NARROWING, NOT A GATE. The dispatch switch sits below the `helloDone`
    // check, so this branch is unreachable without an actor; the compiler still
    // needs the null gone, and answering honestly beats a non-null assertion.
    const actorId = session.actorId;
    if (actorId === null) {
      sendError(session.socket, ErrorCode.NotAuthenticated, 'send hello before choosing a class');
      return;
    }

    const definition = classById(msg.classId);
    if (definition === undefined) {
      sendError(session.socket, ErrorCode.BadMessage, 'no such class');
      return;
    }

    if (!classChoiceOwed.has(actorId)) {
      sendError(
        session.socket,
        ErrorCode.NotYourTurn,
        'class refused: this character already has a class',
      );
      return;
    }

    // ═══ ON YOUR FEET FIRST. THE OFFER SURVIVES THE REFUSAL ═══
    // `!alive` is Downed AND Erased, both: `goDown` sets `alive = false` beside
    // `hp = 0` (engine/downed.ts:401-402) and an erased body is not alive
    // either, so one read covers both without net/ learning the survival table's
    // shape. THE ID IS DELIBERATELY LEFT IN `classChoiceOwed` — this is "not
    // now", not "never", and a player who is picked up or presses `f` out of
    // Erased must find the screen still waiting. See check 3 in the doc block
    // for why re-clothing a body on the floor corrupts its class permanently.
    const body = world.getActor(actorId);
    if (body !== undefined && !body.alive) {
      sendError(
        session.socket,
        ErrorCode.NotYourTurn,
        'class refused: you are on the floor — get back on your feet first',
      );
      return;
    }

    // THE BODY. `reclothePlayer` is the one narrow exception to `addPlayer`'s
    // "reattach, never re-clothe" rule and its doc block says why.
    //
    // THE ANSWER IS CHECKED RATHER THAN DISCARDED, and the ORDER is the point:
    // nothing below this line is undoable. If the body is not in the world (it
    // was recalled between the frame being sent and being read), attaching a
    // sheet would leave one keyed to a dead id, deleting the set entry would
    // burn the one choice, and `saveNow` would write a class onto a body that no
    // longer exists. Answering `internal` and changing NOTHING is the honest
    // outcome — the same shape `handleInspect` uses for the same cause.
    if (!world.reclothePlayer(actorId, overlayFor(definition))) {
      sendError(session.socket, ErrorCode.Internal, 'your body is not in the world');
      return;
    }
    // THE SHEET, through the injected seam (`TurnEngine.attachClass`) and never
    // by importing engine/talents.ts into net/. Same reason `hello` attaches it
    // this way: this file knows WHICH class a body is and must not learn what a
    // class DOES.
    engine.attachClass?.(actorId, definition.id);
    // ONCE PER BODY. Deleting the id is the whole of that guarantee; from here
    // on this socket gets the `not_your_turn` above.
    classChoiceOwed.delete(actorId);
    // AND THE BODY IS HANDED BACK TO ITS OWNER, in the same breath the set entry
    // goes — the two writes are made together in `hello` and undone together
    // here. Left in, the standing hold would auto-hold this player every turn
    // for the rest of the session (engine/scheduler.ts:1316): they would never
    // block, the party would never wait for them, and every key they pressed
    // would land on a body that had already braced.
    if (body !== undefined) releaseFromClassChoice(body);

    // THE HOTBAR IS DIFFERENT NOW, and both frames have to be resent. The
    // loadout is normally sent exactly once per connection because M3 loadouts
    // are fixed — but that is a property of the CALL SITE in `hello`, not of the
    // function: `sendLoadout` carries no once-guard, so calling it again simply
    // replaces the client's bar wholesale, which is exactly what the frame is
    // shaped for. `sendHotbarIfChanged` follows because the resource pool the
    // new sheet brought is a different pool with a different maximum, and its
    // memo compares against what this socket was last sent.
    sendLoadout(session);
    sendHotbarIfChanged(session);

    // ═══ THE BOARD, BECAUSE `sprite` AND `maxHp` TRAVEL ONLY ON `ActorView` ═══
    // No delta carries either one. This is the same deliberately dumb answer
    // `needsFullResync` gives and the same one the rename path in `hello` gives
    // at :2669-2677 — resend the actor list and let it cost a few KB once.
    broadcast({ v: PROTOCOL_VERSION, t: 'state', actors: projectActors(world) });
    // ═══ AND THE SKY WITH IT — THE CLIENT CLEARS ITS ORBS ON `state` ═══
    // src/client/main.ts's `case 'state'` runs `clearProjectiles()`, so the
    // broadcast above wipes every orb from every screen that receives it, and
    // the memo would then ACTIVELY SUPPRESS the correction:
    // `broadcastProjectilesIfChanged` compares against the last thing broadcast
    // and the orb list has not changed. The party would be dodging a shot they
    // can no longer see because somebody in the next room finished character
    // creation. This is not rediscovered reasoning — it is copied from the
    // rename path, and every `state` broadcast in this file carries the sky.
    sendProjectilesIfAny();

    // ═══ AND THE TURN STRIP, FOR THE SAME REASON THE BOARD WENT ═══
    // `TurnActor` carries its OWN hp, maxHp and portrait — protocol.ts justifies
    // that redundancy with "this frame goes out on every barrier change, which is
    // when those numbers change anyway, so the card cannot sit stale next to a
    // fresher bar". `choose_class` is the one event that falsifies it: it is
    // deliberately non-pumping, and even a later pump would not help, because
    // `turnKey`'s six terms (gameTurn, engagement, whoseTurn, committed,
    // standingBy, bellArmed) contain none of the three. `projectTurn` builds the
    // portrait from `actor.sprite`, which the re-clothe just rewrote.
    //
    // WITHOUT THIS: a player who picks the Alchemist on a quiet floor sees an
    // Alchemist hp bar and an Alchemist character sheet beside a turn card still
    // reading the provisional Watchman's 34/34 and their portrait — until their
    // first step, which out of combat can be minutes.
    //
    // THE MEMO IS CLEARED RATHER THAN BYPASSED, so the frame goes to EVERYBODY.
    // Every other player's strip carries this card too, and a unicast would fix
    // it for the one person who cannot see their own portrait anyway.
    lastTurnKey = null;
    broadcastTurnIfChanged(engine.turnState());

    // ═══ IMMEDIATE, NOT THE 5s DEBOUNCE, AND THE LABEL IS `join` ═══
    // For the reason `hello` flushes at :2656-2662: the file has to exist before
    // the first thing that changes it does, and the five seconds a debounce
    // would cost are precisely the window in which a brand-new character has no
    // record of what it chose to be. The label is reused rather than added to
    // `REASON_BY_LABEL` in persist/saves.ts because CHARACTER CREATION IS THE
    // JOIN — it is the same event finishing, a few seconds later, and a second
    // label would be two names for one moment.
    saveNow('join');

    // `classRotation` IS DELIBERATELY NOT ADVANCED HERE. See its own note: it
    // spreads the FALLBACK across joiners, and a chosen class is not a rolled
    // one.
  };

  /**
   * `revive` — stand the ally in `dir` back up.
   *
   * The gateway decides NOTHING here, exactly as with `talent`: adjacency,
   * whether that body is Downed, and what it costs are all the engine's, because
   * a copy of those rules written in the net layer is a copy that will one day
   * disagree with the one that actually resolves.
   *
   * When the engine has no revive to offer (`submitRevive` absent — see the seam
   * note on `TurnEngine`), the refusal says so in words rather than pretending
   * the ally was not there. `Internal` is the honest code: it is not a game rule
   * that was broken, it is a capability this build does not have, and the client
   * prints the server's own sentence for exactly that class of failure.
   */
  const handleRevive = (session: Session, msg: ClientRevive): void => {
    const actorId = session.actorId;
    if (actorId === null) {
      sendError(session.socket, ErrorCode.NotAuthenticated, 'send hello before reviving');
      return;
    }
    // See `handleMove`: reaching for a friend on the floor is the least
    // ambiguous "I am here" in the game, so the class-choice park comes off.
    unparkOnCommand(session);

    // Narrowed rather than lifted into a local: `const submit = engine.submitRevive`
    // detaches the method from its object, which is `@typescript-eslint/unbound-method`
    // and a real hazard for any implementation that closes over `this`.
    if (engine.submitRevive === undefined) {
      sendError(
        session.socket,
        ErrorCode.Internal,
        'revive is not wired into this server build yet',
      );
      return;
    }

    const result = engine.submitRevive(actorId, msg.dir);
    if (!result.ok) {
      sendError(session.socket, ErrorCode.IllegalMove, `revive refused: ${result.reason}`);
      return;
    }
    pumpAndBroadcast();
  };

  /**
   * ═════════════════════════════════════════════════════════════════════════
   * `respawn` — THE WAY OUT OF ERASED, AND THE ONLY VERB THAT IS SELF-ONLY.
   * ═════════════════════════════════════════════════════════════════════════
   *
   * The frame carries NOTHING (`RespawnSchema` is `{v, t}` and `strictObject`),
   * so unlike `revive` — which at least names a direction — there is not even a
   * tile here that could belong to somebody else. The actor is the one this
   * socket owns, resolved from the session exactly as with `move`.
   *
   * IT IS REFUSED WITH `not_your_turn`, deliberately, and both refusals mean the
   * same thing to a client: *not now*. You are on your feet (a wipe or an ally
   * got there first), or you are Downed and still have a countdown and a rescuer
   * — which is a mechanic, not a fault, and the engine's sentence says so.
   *
   * ═══ THREE THINGS FOLLOW A SUCCESS, AND THE PUMP CANNOT DO ANY OF THEM ═══
   * A respawn happens BETWEEN pumps (an erased body is never ticked), so it
   * produces no turn event at all: `needsFullResync` cannot see it, the Record
   * batch cannot narrate it, and `isSaveWorthy` cannot notice it. All three are
   * done here, in the order the pump would have done them.
   */
  const handleRespawn = (session: Session): void => {
    const actorId = session.actorId;
    if (actorId === null) {
      sendError(session.socket, ErrorCode.NotAuthenticated, 'send hello before respawning');
      return;
    }

    // Narrowed rather than lifted into a local, exactly as in `handleRevive`:
    // `const submit = engine.submitRespawn` detaches the method from its object.
    if (engine.submitRespawn === undefined) {
      sendError(
        session.socket,
        ErrorCode.Internal,
        'respawn is not wired into this server build yet',
      );
      return;
    }

    const result = engine.submitRespawn(actorId);
    if (!result.ok) {
      sendError(session.socket, ErrorCode.NotYourTurn, `respawn refused: ${result.reason}`);
      return;
    }

    // The line first, then the board — the same order `pumpAndBroadcast` uses,
    // so a client reads what happened before it is shown the result of it.
    broadcastRecordLine(`${nameOf(actorId)} is refiled — back on their feet.`);
    // ═══ THE BOARD IS RESENT, AND ONLY THIS LINE CAN DO IT ═══
    // A respawn rewrites three things no delta carries: the SPRITE (back from
    // the `_downed_s` variant), the POSITION (a spawn tile — an erased body does
    // not block, so it may have been lying under somebody) and the hp. The same
    // deliberately dumb answer `needsFullResync` gives, for the same reason.
    broadcast({ v: PROTOCOL_VERSION, t: 'state', actors: projectActors(world) });
    // ═══ AND THE SKY WITH IT, FOR THE THIRD AND LAST TIME IN THIS FILE ═══
    // Every `state` broadcast clears the client's orb list (src/client/main.ts's
    // `case 'state'`), and the memo suppresses the restate because the list
    // itself did not change. Three sites broadcast `state`: the full resync in
    // `pumpAndBroadcast`, the rename in `hello`, and this one. All three carry
    // the sky. If a fourth is ever added it must too — an orb the party cannot
    // see has no counterplay, which is the whole point of the feature.
    sendProjectilesIfAny();
    // A CRITICAL EVENT, like a death and a disconnect: the state worth keeping
    // is the one that just changed, and it changed because somebody was stuck.
    saveNow('respawn');

    // The quorum just grew by one. The party may have been idling on nobody.
    pumpAndBroadcast();
  };

  /**
   * ═════════════════════════════════════════════════════════════════════════
   * `party` — WHO YOU ARE PLAYING WITH. The verb the barrier scopes to.
   * ═════════════════════════════════════════════════════════════════════════
   *
   * The gateway decides NOTHING here, exactly as with `talent` and `revive`.
   * Party size, leadership, which offers are live and where a removed player
   * lands are all engine/party.ts's; whether the named target is a living
   * player is `submitParty`'s, because that is a question about the world.
   *
   * ═══ IT DOES NOT PUMP FIRST, IT PUMPS LAST, AND IT ALWAYS PUMPS ═══
   * A party command is not a turn action — it costs no energy and works while
   * the sender is on the floor, exactly like `say`. But unlike `say` it CHANGES
   * THE BARRIER: the quorum a player is standing at has just gained or lost
   * people, and the party that was waiting on somebody who has now left may be
   * able to move immediately. So the pump at the end is not bookkeeping, it is
   * the thing that unblocks whoever was stuck.
   *
   * ═══ `party_state` GOES TO THE AFFECTED MEMBERS ONLY ═══
   * And they are named by the ENGINE rather than worked out here: an accept
   * changes the frame for two whole parties, one of which no longer exists by
   * the time this function could ask about it. `sendPartyStateIfChanged` is
   * memoised per socket, so pushing to a member whose pane did not actually
   * change costs one string compare and sends nothing.
   */
  const handleParty = (session: Session, msg: ClientParty): void => {
    const actorId = session.actorId;
    if (actorId === null) {
      sendError(session.socket, ErrorCode.NotAuthenticated, 'send hello before forming a party');
      return;
    }

    // Narrowed rather than lifted into a local, exactly as in `handleRevive`:
    // `const submit = engine.submitParty` detaches the method from its object.
    if (engine.submitParty === undefined) {
      sendError(session.socket, ErrorCode.Internal, 'parties are not wired into this server build');
      return;
    }

    const result = engine.submitParty(actorId, msg.action, msg.targetId);
    if (!result.ok) {
      // NotYourTurn — "not now", which is what every one of these refusals
      // means: the offer lapsed, they are already with you, the party filled up
      // while you were deciding. None of them is "that tile, no", so none of
      // them is `illegal_move`.
      sendError(session.socket, ErrorCode.NotYourTurn, `party refused: ${result.reason}`);
      return;
    }

    // The transcript first, then the panes — the same order `pumpAndBroadcast`
    // uses, so a client reads what happened before it is shown the result. It
    // is broadcast rather than sent to the party, because a party forming is
    // the reason the floor's barrier just changed shape and everybody on it is
    // entitled to know why the person beside them stopped being waited for.
    broadcastRecordLine(result.notice);

    for (const memberId of result.affected) {
      const conn = connByActor.get(memberId);
      const member = conn === undefined ? undefined : sessions.get(conn);
      if (member !== undefined && member.helloDone) sendPartyStateIfChanged(member);
    }

    // THE QUORUM JUST CHANGED SHAPE. Somebody may have been waiting on a person
    // who is no longer in their party, and the pump is what lets them move.
    pumpAndBroadcast();
  };

  const handleFrame = (session: Session, raw: WsFrame): void => {
    if (frameBytes(raw) > MAX_FRAME_BYTES) {
      sendError(session.socket, ErrorCode.BadMessage, `frame exceeds ${MAX_FRAME_BYTES} bytes`);
      return;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(frameText(raw));
    } catch {
      sendError(session.socket, ErrorCode.BadMessage, 'frame is not valid JSON');
      return;
    }

    const version = wireVersion(payload);
    if (version !== undefined && version !== PROTOCOL_VERSION) {
      sendError(
        session.socket,
        ErrorCode.VersionMismatch,
        `protocol version mismatch: client v=${version}, server v=${PROTOCOL_VERSION}`,
      );
      session.socket.close(CLOSE_PROTOCOL_ERROR, 'protocol version mismatch');
      return;
    }

    // Already-parsed value, so this does not JSON.parse a second time.
    const parsed = parseClientMsg(payload);
    if (!parsed.ok) {
      sendError(session.socket, ErrorCode.BadMessage, parsed.error);
      return;
    }

    const msg = parsed.msg;

    // THE RATE LIMIT, AFTER validation and BEFORE anything is done about the
    // frame. After, because a malformed frame should still be named as malformed
    // rather than silently swallowed — a client with a serialisation bug needs
    // the real diagnosis. Before, because past this point every branch either
    // advances the world or broadcasts to the room, and `say`/`point` do the
    // latter with nothing else braking them (game-design.md § 4).
    //
    // `hello` is exempt: it happens once per connection and throttling it out
    // costs the session rather than the frame.
    if (msg.t !== 'hello') {
      const nowMs = Date.now();
      if (!takeToken(session, nowMs)) {
        noteThrottled(session, nowMs);
        return;
      }
    }

    // Nothing but `hello` is honoured before the handshake completes.
    if (msg.t !== 'hello' && !session.helloDone) {
      sendError(session.socket, ErrorCode.NotAuthenticated, 'send hello first');
      return;
    }

    switch (msg.t) {
      case 'hello':
        // `void`, not `await`: `handleFrame` is synchronous and stays that way,
        // and `handleHello` is documented never to reject. Awaiting here would
        // make every frame handler async for the benefit of one branch, which is
        // exactly the change CLAUDE.md non-negotiable 2 exists to prevent.
        void handleHello(session, msg);
        return;
      case 'move':
        handleMove(session, msg);
        return;
      case 'talent':
        handleTalent(session, msg);
        return;
      case 'commit':
        handleTurnVerb(session, 'commit');
        return;
      case 'hold':
        handleTurnVerb(session, 'hold');
        return;
      // The Margin lane. Neither pumps — see the block comment above
      // `broadcastMargin`: speech is not a turn action and must never be one.
      case 'say':
        handleSay(session, msg);
        return;
      case 'point':
        handlePoint(session, msg);
        return;
      // ALSO NON-PUMPING, and for the reason the `ping` case gives below: an
      // inspect changes nothing — no energy, no intent, no RNG draw — so a
      // frame that costs the sender nothing must not be a way to make the
      // server advance the world. It is answered to the ASKER alone
      // (`send`, never `broadcast`): what `inspectActor` returns depends on the
      // viewer's line of sight, so the same target inspected by two people is
      // legitimately two different answers.
      case 'inspect':
        handleInspect(session, msg);
        return;
      // ALSO NON-PUMPING, and self-only: the frame names a class and nothing
      // else, and the body it dresses is the one this socket owns. It is refused
      // outright for anybody who already has a class — see `handleChooseClass`.
      case 'choose_class':
        handleChooseClass(session, msg);
        return;
      case 'revive':
        handleRevive(session, msg);
        return;
      // SELF-SERVICE ONLY, and it carries no fields — see `handleRespawn`.
      case 'respawn':
        handleRespawn(session);
        return;
      // WHO YOU ARE PLAYING WITH. Not a turn action — it costs no energy and
      // works while you are on the floor — but it DOES change the barrier, so
      // `handleParty` pumps at the end.
      case 'party':
        handleParty(session, msg);
        return;
      // Deliberately does NOT pump. A ping changes nothing, and a frame that
      // costs nothing must not be a way to make the server do work.
      case 'ping':
        send(session.socket, { v: PROTOCOL_VERSION, t: 'pong' });
        return;
    }
  };

  // Timers outlive sockets here — the Bell and up to one grace timer per
  // disconnected body — so shutting the app down has to cancel them or a test
  // process hangs waiting on a ten-minute recall.
  app.addHook('onClose', (_instance, done) => {
    clearBell();
    for (const timer of graceTimers.values()) clearTimeout(timer);
    graceTimers.clear();
    // The speaking sweep is the fourth timer that outlives a socket. Unref'd, so
    // it cannot hold the process open — cleared anyway, because a test that
    // shuts the app down and asserts on frames must not get one more.
    if (speakingTimer !== null) {
      clearTimeout(speakingTimer);
      speakingTimer = null;
    }
    done();
  });

  app.get('/ws', { websocket: true }, (socket: GatewaySocket, request) => {
    const session: Session = {
      connId: randomUUID(),
      socket,
      actorId: null,
      helloDone: false,
      // Set true for the whole of `hello`, attempted or completed, and never
      // cleared: one hello per connection. A socket whose hello failed hard
      // enough to matter has already been closed.
      helloPending: false,
      sessionId: null,
      ownerId: null,
      alive: true,
      viewerKey: null,
      partyKey: null,
      // A FULL BUCKET on connect, deliberately: the first thing a reconnecting
      // client does is replay a second's worth of frames, and starting it empty
      // would throttle exactly the case the resume path exists to make smooth.
      tokens: COMMAND_BURST,
      tokensAtMs: Date.now(),
      rateNoticeAtMs: 0,
    };
    sessions.set(session.connId, session);
    request.log.info({ conn: session.connId }, 'ws connected');

    const heartbeat = setInterval(() => {
      if (!session.alive) {
        // No pong since the last ping: the peer is gone even if TCP has not
        // noticed. terminate() fires `close`, which does the cleanup.
        request.log.info({ conn: session.connId }, 'ws heartbeat timed out');
        socket.terminate();
        return;
      }
      session.alive = false;
      socket.ping();

      // THE SESSION'S IDLE EXPIRY, SLID. src/server/http/session.ts is built
      // around "a live WebSocket keeps its session alive indefinitely while an
      // idle one dies at SESSION_TTL_SECONDS", and every successful `get` buys
      // another TTL. This is the half of that sentence that lives on this side:
      // without it, somebody who plays for twenty minutes without reloading
      // would find their session expired the moment their wifi hiccupped.
      const store = opts.sessions;
      if (store !== undefined && session.sessionId !== null) store.get(session.sessionId);
    }, PING_INTERVAL_MS);

    socket.on('pong', () => {
      session.alive = true;
    });

    socket.on('message', (raw) => {
      try {
        handleFrame(session, raw);
      } catch (err) {
        // Belt and braces: see the header. A throw here would take the process
        // down and with it everyone else's session.
        request.log.error({ err, conn: session.connId }, 'ws frame handler threw');
        sendError(socket, ErrorCode.Internal, 'internal error handling that message');
      }
    });

    // @fastify/websocket already attaches a bare `error` listener at upgrade
    // time, so an ECONNRESET cannot become a process-killing unhandled 'error'
    // event. That listener logs the error alone, with no connection id, which
    // is not enough to work out whose socket died — this one adds the context,
    // and means the no-crash guarantee does not rest on a library internal.
    socket.on('error', (err) => {
      request.log.warn({ err, conn: session.connId }, 'ws socket error');
    });

    /**
     * THE BODY STAYS. This is the M1 behaviour that M2 deliberately changes.
     *
     * M1 removed the actor and broadcast `left`. game-design.md § 4 is explicit
     * that a disconnect must not do that: it is a MUD, you do not yank someone
     * out of a fight, and a body that vanishes when its owner's wifi hiccups is
     * both bad fiction and a free escape from a losing position. So the token
     * stays exactly where it fell, keeps its resume token for the grace window,
     * and goes on Standing By immediately — which removes it from quorum, so
     * the remaining players never wait on it and the Bell never counts it.
     *
     * The observable event is therefore a `turn` frame listing them under
     * `standingBy`. `left` now means only that the grace expired.
     *
     * ═══════════════════════════════════════════════════════════════════════
     * PRESENCE ENDS HERE. THE BODY'S TEN MINUTES DO NOT.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * Those are two different clocks and conflating them is what stranded a
     * player in real co-op play. `setConnected(false)` below is IMMEDIATE and it
     * is what the quorum, the Bell and — since the fix — the party-wipe check all
     * read: engine/scheduler.ts's `checkWipe` asks `connected && !standingBy`
     * before counting anybody as a survivor, so from this line onwards this body
     * cannot hold a wipe off for the people still playing. `startGrace` is the
     * other clock: the BODY stays in the world for ten minutes so its owner can
     * come back to it, which is a MUD rule about a character, not a claim that
     * somebody is at the keyboard.
     *
     * HOW SOON THIS RUNS IS THE CLIENT'S HALF. A browser that vanishes without
     * closing its socket is only noticed by the 30-second heartbeat, which is
     * exactly what was reported — so src/client/net/socket.ts now hangs up on
     * `pagehide`. The heartbeat remains the backstop for a laptop lid, a killed
     * process and a dead router, none of which get to send anything.
     */
    socket.on('close', (code) => {
      // These two run OUTSIDE the guard: a dead socket must leave the broadcast
      // list and stop being pinged even if everything after them fails.
      clearInterval(heartbeat);
      sessions.delete(session.connId);

      guard('ws close handler threw', () => {
        const actorId = session.actorId;
        if (actorId === null) {
          request.log.info({ conn: session.connId, code }, 'ws closed before hello');
          return;
        }

        // Only the CURRENT owner may act on the actor. A superseded socket
        // closing after a successful resume must leave the new connection's
        // actor alone — otherwise a reconnect would immediately put the
        // freshly-attached body back on Standing By and arm a recall on it.
        if (connByActor.get(actorId) !== session.connId) {
          request.log.info({ conn: session.connId, actorId, code }, 'ws superseded socket closed');
          return;
        }

        connByActor.delete(actorId);
        engine.setConnected(actorId, false);
        startGrace(actorId);
        // A CRITICAL SAVE (saves.ts's `SaveReason.Disconnect`): the body stays in
        // the world for ten minutes, but the person is gone NOW and the process
        // may not be here in ten minutes. Written while the actor is still in the
        // actor table — `snapshotPlayers` reads it — and before the pump below,
        // because what is worth keeping is the state they left, not whatever the
        // barrier does about their absence.
        saveNow('disconnect');
        request.log.info(
          { conn: session.connId, actorId, code, graceMs: disconnectGraceMs },
          'ws closed — body left standing by',
        );

        // The party may have been parked on this player. Now it is not.
        pumpAndBroadcast();
      });
    });
  });
};
