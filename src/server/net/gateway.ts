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

import { bearingWord, inBounds, step } from '../../shared/coords.ts';
import {
  ActorKind,
  ErasedReason,
  ErrorCode,
  LogLane,
  parseClientMsg,
} from '../../shared/protocol.ts';
/**
 * THE PROGRESSION LEDGER, AND IT IS ARITHMETIC ONLY.
 *
 * src/shared/progression.ts imports nothing but protocol.ts — deliberately, not
 * src/shared/scale.ts — so pulling it in here brings the exp curve and the point
 * grant and NO combat maths. Three things are needed and all three are facts the
 * gateway has to state rather than compute a second time: the level ceiling
 * (`applyRestore` clamps a hand-edited file to it), the xp bar's denominator
 * (`expChart`), and the ledger `unspentPoints` is reconciled against.
 */
import {
  MAX_CHARACTER_LEVEL,
  expChart,
  pointsForLevel,
  totalPointsAtLevel,
} from '../../shared/progression.ts';
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
 * THE SECOND CONTENT IMPORT, AND IT IS DATA ONLY — THE SAME TERMS AS THE FIRST.
 *
 * `resolveItem` says whether an id off the wire or out of a save file still
 * names an item this build can produce, `SLOT_ORDER` is what narrows a `string`
 * key from a character file into a `Slot`, and `resolveItem` is ALSO handed
 * STRAIGHT THROUGH to `recomposeCombat` without this file reading a row out of
 * the catalogue. What an item DOES — its `wielder` table, what it is worth, what
 * it costs — is never read here, exactly as no class's sheet is.
 *
 * It used to be `itemById` and `ITEM_CATALOGUE`, one of which asked a Map and
 * the other of which WAS the Map. Both became one function when an id stopped
 * being guaranteed to be a key in a table of 22 — see content/resolve.ts.
 *
 * persist/saves.ts already took the same edge and argued it at its import site:
 * an item id carries NOTHING on its own (slot, icon and wielder all live in the
 * catalogue), so a layer that has to validate one has to be able to ask.
 */
import { SLOT_ORDER } from '../content/items.ts';
import { moneyAmountOf, moneyName } from '../content/money.ts';
import { partyMaxLevel } from '../content/loot.ts';
import { blurbFor } from '../content/places.ts';
import { shouldAnnounceCleared } from '../world/cleared.ts';
// `DELVES` IS DELIBERATELY NOT IMPORTED HERE ANY MORE. Both of this file's
// lookups — the danger grade on the world map and the one in the bearing list —
// asked the raw table, and the raw table answers `undefined` for the Redaction's
// derived doors, which is the TOWN case. `specFor` is the lookup that knows
// about both maps; the import going away is the proof there is no third caller
// still asking the old question.
import { specFor, dangerWord, partyHint } from '../content/delve.ts';
import { monsterById } from '../content/monsters.ts';
import type { MonsterTemplate } from '../content/monsters.ts';
import { STANDING_LEVEL, specForActorId } from '../content/townsfolk.ts';
import { healActor } from '../engine/talents.ts';
import type { TalentEffect } from '../engine/talents.ts';
import type { ClientUse, TopicId } from '../../shared/protocol.ts';
import { buyPrice, sellPrice, stockLevelFor } from '../content/shops.ts';
import { addSoldItem, catchUpShop, takeFromShelf } from '../world/shopstate.ts';
import { resolveItem } from '../content/resolve.ts';
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
import { Faction, StandingOrder, incMoney, isMonster } from '../engine/actor.ts';
/**
 * THE SINGLE WRITER OF `actor.combat`, IMPORTED RATHER THAN INJECTED, AND THE
 * ASYMMETRY WITH `attachClass` IS DELIBERATE.
 *
 * `TurnEngine.attachClass` is a seam because attaching a sheet means reaching
 * `engine/talents.ts` — a talent book, a resource pool, four closures — and this
 * file must not learn what a class DOES. `recomposeCombat` is the opposite kind
 * of thing: it is a PURE RE-DERIVATION of one field from three inputs that are
 * all already on the body (`baseCombat`, `equipped`, and the `EffectState` this
 * plugin is handed in its own options), it returns void, it draws no RNG and it
 * queues nothing. world/world.ts imports it directly for exactly the same
 * reason at `reclothePlayer`, with the ownership split written out at both
 * sites.
 *
 * IT MUST BE CALLED AFTER EVERY WRITE TO `equipped` IN THIS FILE. That is the
 * whole of the equipment contract here: `equipped` is owned by the equipment
 * VERBS (which is this file, now), `combat` is owned by `recomposeCombat` and by
 * nothing else, and a verb that moved an id without recomposing would leave a
 * player wearing a coat that changes no number — Trap 1, arriving through the
 * one door the type system cannot close.
 */
import { recomposeCombat } from '../engine/effects.ts';
/**
 * WHICH PARTY A BODY BELONGS TO — asked in exactly one place, at exactly one
 * moment: the step that walks onto a site cell.
 *
 * `Realms.open` is idempotent on (partyId, siteId) (world/realms.ts:386-394),
 * and that is the whole reason a party id has to be reachable from here: it is
 * what makes the second person through the door join the first rather than open
 * a private second copy of the floor beside them. Nothing else in this file
 * reads the party table — membership, invites and the barrier's scope are all
 * `engine/party.ts`'s, reached through `TurnEngine.submitParty` exactly as
 * before.
 *
 * A VALUE IMPORT INTO net/, AND IT IS ONE-WAY. eslint bans `engine/** ->
 * net/**` (the `NO_IO_LAYER_PATTERNS` group in eslint.config.js) and this arrow
 * points the other way, like `recomposeCombat` directly above and for the same
 * stated reason: `partyIdOf` is a two-line lookup over a table this process
 * already owns, it returns a string, it draws no RNG and it queues nothing.
 */
import { membersOf, partyIdOf, sameParty } from '../engine/party.ts';
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
  projectGroundItems,
  projectInventory,
  projectLoadout,
  projectParty,
  projectPartyState,
  projectShop,
  projectProjectiles,
  projectResource,
  projectTurn,
  projectWorld,
  toActorView,
} from '../view/projector.ts';
/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE AUTHORED SITE TABLE, AND THE CYCLE THIS USED TO FEAR IS GONE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The `import type { Realms }` below carried a note saying a value import here
 * "would close the loop", because realms.ts imported `createTurnEngine` and
 * turn-engine.ts imports `TurnEngine` back out of THIS file. That is no longer
 * true of realms.ts: it takes an `EngineFor` factory instead of building engines
 * (world/realms.ts:224 and the essay above it), and its only runtime imports are
 * `shared/level.ts`, `shared/protocol.ts` and `world/world.ts`. So the arrow
 * gateway -> realms is a leaf edge with nothing pointing back.
 *
 * `SITES` is DATA — the map from a site cell's id to the place behind it, on the
 * same terms as the two content imports above. The registry's BEHAVIOUR is still
 * injected as `opts.realms`, so a build with no registry is still a build with
 * one world, and `crossIntoSite` returns on its first line.
 */
import { ENCOUNTER_SITE, OVERWORLD_ID, RealmKind, SITES, isShared } from '../world/realms.ts';
import { roamerAt, tickRoamers } from '../world/roamers.ts';
import { ALDERBROOK_REGIONS, groundAt, regionAt } from '../../shared/level.ts';
import type { Ground } from '../../shared/level.ts';
import { createFog, fogFromBase64, fogHas, fogToBase64, revealDisc } from '../../shared/fog.ts';
import type { FastifyPluginAsync } from 'fastify';
import { isDowned } from '../engine/downed.ts';
import type { DownedState } from '../engine/downed.ts';
import type { EffectState } from '../engine/effects.ts';
import type { Dir, TileXY } from '../../shared/coords.ts';
import type {
  BroadcastMsg,
  ClientChooseClass,
  ClientDrop,
  ClientFollow,
  ClientShopBuy,
  ClientShopSell,
  ShopMsg,
  ClientEquip,
  ClientHello,
  ClientInspect,
  ClientMove,
  ClientParty,
  ClientPoint,
  ClientTalk,
  ClientRevive,
  ClientSay,
  ClientSetKeybinds,
  ClientSpendPoint,
  ClientTalent,
  ClientUnequip,
  LoadoutTalent,
  LogLine,
  PartyAction,
  ResourceView,
  ServerMsg,
  SiteView,
  TurnEvent,
} from '../../shared/protocol.ts';
import type { ClassDef } from '../content/classes.ts';
import type { Slot } from '../content/items.ts';
import type { EngineActor, PlayerActor } from '../engine/actor.ts';
import type { PartyState } from '../engine/party.ts';
import type { AwayMember, PartyOffer, TurnState } from '../view/projector.ts';
import type { Realm, Realms, SiteDef } from '../world/realms.ts';
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
  /**
   * WHICH PLACE THIS SOCKET'S BODY IS IN, or null for "the default one".
   *
   * NULL IS A REAL ANSWER AND NOT AN UNINITIALISED ONE. It means `opts.world` /
   * `opts.engine` — the single world this gateway was built around — and it is
   * what a socket carries from the moment it opens until something places its
   * body in a named realm. A build with no `opts.realms` never leaves that
   * state, which is why every pre-realms construction still describes the game it
   * always did: see `realmFor` and `fallbackRealm`.
   *
   * IT IS WRITTEN IN EXACTLY TWO PLACES and both are the server deciding where a
   * body IS, never a client saying where it wants to be: `handleHello` reads it
   * back off the registry after the body is placed, and `crossIntoSite` moves it
   * after the body has actually been moved. Nothing else may assign it.
   *
   * PER CONNECTION RATHER THAN PER ACTOR, like `viewerKey` and the three memo
   * keys beside it, and for a different reason: a resumed socket has to be told
   * where its body is, and the body is the thing that knows. `hello` reads it
   * back off the registry rather than trusting anything a client sent — there is
   * no realm field on the wire and there never will be, for CLAUDE.md
   * non-negotiable 5's reason.
   */
  realmId: string | null;
  /**
   * The overworld cell this body stepped off when it crossed into a site, and
   * where `leaveRealm` puts it back.
   *
   * On the SESSION rather than on the actor, because it is a fact about a
   * journey and not about a body: it means nothing to anyone else, it must not
   * reach a client, and it must not be persisted — a save that remembered a
   * doorstep from three weeks ago would put a returning player somewhere they
   * have no memory of standing.
   *
   * Null on the overworld, and null again the moment it is spent.
   */
  enteredFrom: TileXY | null;
  /**
   * WHICH overworld that tile is on. Null when they have not come in from one.
   *
   * ═══════════════════════════════════════════════════════════════════════════
   * TODAY THIS IS ALWAYS `realm:overworld` AND THAT IS THE POINT.
   * ═══════════════════════════════════════════════════════════════════════════
   * `leaveRealm` used to read `realms.overworld` unconditionally, which is
   * correct while there is exactly one — and is a silent teleport the moment
   * there are two: walking out of a delve on a second landmass would put the
   * body on the FIRST one, at the second one's coordinates, wherever those
   * numbers happen to land.
   *
   * The design has a standing intention to add that second landmass (the dark
   * territory), and `test/server/realms.test.ts` lists this as one of the four
   * things that would break silently. This is the cheapest of the four to close
   * and the only one that can be exercised today: with one overworld the
   * behaviour is identical, and the test that proves you come back to the realm
   * you left from goes on passing when there are two.
   */
  enteredFromRealm: string | null;
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * HAS THIS BODY STEPPED OFF THE THRESHOLD YET? THE EXIT IS NOT LIVE UNTIL IT
   * HAS, AND SHIPPING WITHOUT THIS COST AN ENTIRE PLAYTEST.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `leaveRealm` treats a site's spawn tiles as its door, and the argument for
   * why that is safe was: "arrival is not a MOVE, so being placed on the
   * threshold cannot eject you." True, and not enough — the M1 map's spawn is a
   * 3x2 CLUSTER OF SIX ADJACENT TILES, so the first step after arriving lands on
   * ANOTHER spawn tile and leaves immediately.
   *
   * The observed effect was an ambush that fired, moved the body into the
   * encounter, and threw it back to the overworld on the very next step —
   * reported as "encounters start but there are no enemies" and "I can click out
   * of the encounter and carry on walking". Both are this one bug: nobody was
   * ever in there long enough to see a monster, and the breach was sealed and
   * closed behind them on the way out.
   *
   * So the door ARMS. False on arrival, set true the moment the body stands on
   * a non-threshold tile, and only then can stepping back on leave. Leaving
   * deliberately therefore costs two steps — off the doorstep and back onto it —
   * which is exactly what a door should cost and what a stray keystroke should
   * not.
   */
  exitArmed: boolean;
  /**
   * WHICH PART OF THE MOOR THIS BODY WAS LAST IN, or null before it has taken a
   * step. Compared against the region of the tile a step LANDED on, so crossing
   * a boundary says so once and walking about inside one says nothing.
   *
   * ON THE SESSION AND NOT THE ACTOR, because it is a fact about what this
   * screen has been TOLD rather than about where the body is — the body's own
   * answer is its coordinates, and `regionAt` derives the rest. It resets with
   * the socket, which is right: somebody who reconnects should be told where
   * they are.
   */
  region: string | null;
  /**
   * How many hidden markers this socket has been shown. Compared after a reveal
   * so the `sites` frame is re-sent at the MOMENT one is uncovered rather than
   * whenever a roamer next happens to move. See `SiteDef.hidden`.
   */
  hiddenSeen: number;
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
   * The last `progress` frame sent to THIS socket, as a comparison key.
   *
   * A THIRD KEY RATHER THAN A TERM IN `viewerKey`, for the same reason
   * `partyKey` is separate: the three move on completely different schedules.
   * The hotbar changes whenever a cooldown ticks — every game turn — and
   * progress changes on a KILL, which is a handful of times a fight. Folding
   * them together would resend the level readout on every turn of the game.
   */
  progressKey: string | null;
  /**
   * The last `inventory` frame sent to THIS socket, as a comparison key.
   *
   * A FOURTH KEY, for the reason `partyKey` and `progressKey` are the second and
   * third: the four move on completely different schedules. The hotbar changes
   * every game turn, the party pane a handful of times an evening, progress on a
   * kill — and a bag changes only when its owner deliberately does something to
   * it, which is a handful of times a delve. Folding it into `viewerKey` would
   * resend the whole paper doll, comparison rows and all, on every turn of the
   * game.
   *
   * SEEDED WITH THE EMPTY STATE rather than with null, unlike the three above.
   * See `EMPTY_INVENTORY_KEY`: a player carrying nothing must never be sent a
   * frame saying so, and a player who drops their last thing MUST be.
   */
  inventoryKey: string;
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
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * WHO REACHED A NEW LEVEL IN THIS PUMP. ONE ENTRY PER LEVEL CROSSED.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `broadcastRecord` turns each into one Record-lane line and nothing else.
   * That is the ONLY SHARED signal in the game that anybody levelled: `progress`
   * is viewer-private on purpose (points in hand are intent, and intent is not
   * the party's business), so without this line four of five friends never learn
   * that the fifth can spend a point, and the fifth only learns it by opening a
   * panel nothing invited them to open.
   *
   * OPTIONAL, like `reaped` above and for the same reason: a hand-written test
   * scheduler must not have to carry a field for one narration branch's benefit.
   * Absent means "this engine does not report levels", which is a true statement
   * about an engine with no progression in it.
   */
  readonly levelUps?: readonly LevelUpNote[];
};

/**
 * One level crossed, addressed to nobody — it goes in the shared Record lane.
 *
 * Structural rather than imported, for the same reason `RefundedIntent` is: the
 * dependency rule is one-way and this type states the contract without either
 * side importing the other.
 */
export type LevelUpNote = { readonly id: string; readonly level: number };

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
   * ═════════════════════════════════════════════════════════════════════════
   * PUT ONE POINT INTO ONE TALENT. The only writer of a raw talent level.
   * ═════════════════════════════════════════════════════════════════════════
   *
   * INJECTED FOR THE SAME REASON `attachClass` IS, and the precedent is that
   * method exactly: raising a rank is `sheet.points.set(id, n + 1)`, and
   * writing those five words HERE would put `engine/talents.ts` into net/'s
   * import graph. This file knows WHICH talent a socket asked to raise; it must
   * not learn what a talent sheet is.
   *
   * IT IS NOT THE AUTHORISATION. `handleSpendPoint` has already checked, from
   * the per-actor `loadoutOf` view, that this talent is in this body's loadout
   * and is below `maxLevel`, and that the body has a point to spend. This
   * method is the WRITE — but it re-derives the level it returns from the sheet
   * rather than echoing an argument, so a caller cannot make a rank up.
   *
   * @returns the NEW raw level, or null when there is no sheet or the talent is
   *   not on it. Null must cost the caller nothing — the point is decremented
   *   only after this has answered.
   */
  raiseTalentPoint?(actorId: string, talentId: string): number | null;
  /**
   * THIS BODY'S RAW TALENT SPREAD, for the save snapshot.
   *
   * `Record`, not `Map`: it goes straight into `CharacterSnapshot` and on to
   * JSON, and a Map serialises as `{}` — silently, which would write every
   * character back at rank 1 and look like nothing had happened.
   *
   * Undefined for a body with no sheet, which is the honest answer and is what
   * keeps the field ABSENT from the snapshot rather than present and empty.
   */
  talentPointsOf?(actorId: string): Readonly<Record<string, number>> | undefined;
  /**
   * ═════════════════════════════════════════════════════════════════════════
   * WRITE A SAVED SPREAD ONTO A FRESHLY-ATTACHED SHEET. THE RESTORE HALF.
   * ═════════════════════════════════════════════════════════════════════════
   *
   * CALLED AFTER `attachClass`, NEVER BEFORE. `attachClass` ends in an
   * unconditional `sheets.set` (engine/talents.ts), so a restore that ran first
   * would be thrown away without a word.
   *
   * @returns the ids that could NOT be applied — a talent this build no longer
   *   has, or one belonging to a class this character is no longer. Undefined
   *   for a body with no sheet.
   *
   * ═══ THE DROPPED IDS ARE THE `refundPool` docs/data-schemas.md § 1 REQUIRES
   * ═══ ("If a talent id disappears, the load path moves its points to a
   * `refundPool` and logs it rather than throwing. Friends' saves must outlive
   * your content edits.") The refund needs no arithmetic here and no pool
   * object: `applyRestore` derives points-in-hand as `totalPointsAtLevel(level)`
   * minus what is ACTUALLY on the sheet, so points that failed to land are
   * never counted as spent and come straight back as unspent. This return value
   * is what makes the event LOGGABLE rather than silent.
   */
  applyTalentPoints?(
    actorId: string,
    points: Readonly<Record<string, number>>,
  ): readonly string[] | undefined;
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
   * ═════════════════════════════════════════════════════════════════════════
   * "THIS PLAYER IS AT THE KEYBOARD." CLEARS STANDING BY AND NOTHING ELSE.
   * ═════════════════════════════════════════════════════════════════════════
   *
   * `barrier.noteCommand` behind a seam. Every TURN verb already carries it
   * implicitly — `submitIntent`, `commit`, `respawn` and every `party` verb all
   * call it on the way through — but a non-pumping verb has no way to reach it,
   * and `spend_point` is one.
   *
   * ═══ WHAT IT MUST NOT DO, AND WHY THAT MAKES IT SAFE TO CALL FREELY ═══
   * IT DOES NOT PUMP, IT QUEUES NO INTENT, IT DRAWS NO RNG AND IT DOES NOT
   * RESTART THE BELL. The Bell's key is the BLOCKING SET, and a spend does not
   * change who owes a turn — so a straggler who spends a point buys themselves
   * no extra time and the party is not made to wait a second longer. What they
   * get back is the QUORUM: `expire` sets `standingBy` after two silent Bells
   * and that flag removes a body from the barrier entirely, so a player who
   * spent 45 seconds reading a current->next diff was auto-holding with no Bell
   * delay for the rest of the fight while the server held two `spend_point`
   * frames from them — each of which took a deliberate press on a `+` button.
   *
   * ═══ IT IS NOT A PARK AND IT IS NOT AN UNPARK ═══
   * Two separate mechanisms that this file has confused once already. The park
   * (`parkForClassChoice` / `unparkOnCommand`) is about a MODAL holding up the
   * quorum; Standing By is about SILENCE. A spend has nothing to say about the
   * first and is strong evidence about the second.
   *
   * OPTIONAL, like the seams above it: an engine that has no barrier answers
   * nothing, and a hand-written test scheduler must not have to carry it.
   */
  notePresence?(actorId: string): void;
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
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * PROGRESSION — LEVEL, XP, POINTS IN HAND, AND THE RAW SPREAD.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * ALL FOUR OPTIONAL, FOR THE SAME REASON `classId` IS: a body without a class
   * — a fixture, the e2e harness, a build with no content wired in — has no
   * progression to report, and a required field would force every producer to
   * invent one. `snapshotPlayers` writes them only for a `player` body, which
   * is the only kind that carries them (`PlayerActor`, engine/actor.ts).
   *
   * ═══ AND A PROVISIONAL VALUE IS NOT A VALUE. THE `classChoiceOwed` RULE ═══
   * The class sentinel a few lines above exists because writing a rotation's
   * guess to disk answers a question nobody has been asked. Progression obeys
   * the same rule and it is enforced in the same place: a body whose owner has
   * not chosen a class is wearing a sheet it may be about to throw away, so its
   * raw talent points are the PROVISIONAL class's four ids. `snapshotPlayers`
   * omits `talentPoints` entirely for anybody in that set rather than filing a
   * spread against a class they never picked.
   *
   * ═══ WHAT THE PERSIST LAYER DOES WITH THEM — THE LOOP IS CLOSED ═══
   * `createCharacterBridge.fileFor` (persist/saves.ts) reads these four as
   * `snapshot.x ?? binding.x` and writes them to the character file, and
   * `openCharacter` hands all four back on `CharacterRestore`. This paragraph
   * used to say the opposite — that `fileFor` wrote `binding.level` and ignored
   * the snapshot — and while that was true the `level` on disk could never
   * become anything but 1, because the binding echoed back what it read and
   * nothing else ever wrote the field. Levels gained tonight now reach the disk
   * and come back; test/server/persist.test.ts:1303 walks the real bridge end to
   * end and would fail if either half were reverted.
   *
   * THAT PATH IS A CORRECTION. This line used to cite
   * `test/server/persist-progression.test.ts`, which has never existed in this
   * repository — `ls` returns nothing for it. A docblock that claims coverage
   * must name a file somebody can open, or the claim is unfalsifiable and the
   * next reader assumes a suite is watching a seam that nothing is watching.
   */
  readonly level?: number;
  /** PER-LEVEL xp, never a running total. See `PlayerActor.xp`. */
  readonly xp?: number;
  /**
   * Points in hand. A CACHE of `totalPointsAtLevel(level)` minus every raw
   * point spent — `applyRestore` recomputes it rather than trusting it, and the
   * save layer does the same on the way in (`parseCharacterFile`). It is
   * written down anyway because a save file is read by humans.
   */
  readonly unspentPoints?: number;
  /**
   * Gold. Straight off `PlayerActor.money`, and NOT a cache of anything — there
   * is no ledger to recompute a purse from, so unlike `unspentPoints` the value
   * that arrives here is the value that is kept.
   *
   * `?` for the same reason every field around it carries one: a producer that
   * cannot say must leave the disk as it found it. A fixture-shaped snapshot
   * that filled this unconditionally would write the birth purse over an
   * evening's takings — the one-way valve progression and items each shipped
   * once already.
   */
  readonly money?: number;
  /**
   * Namespaced talent id -> RAW points, 1..`TALENT_MAX_LEVEL`. THE ONLY THING
   * HERE THAT IS GENUINELY THE TRUTH; everything else about progression is
   * derivable from it and `level`. docs/data-schemas.md § 1: never persist a
   * derived value.
   */
  readonly talentPoints?: Readonly<Record<string, number>>;
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE BAG AND THE PAPER DOLL. IDS ONLY, AND ABSENT IS NOT EMPTY.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `carried` is item ids in pickup order; `equipped` is slot name -> item id,
   * at most one per slot. Both come straight off `PlayerActor.carried` /
   * `.equipped`, which is why those fields live on the ACTOR at all: the save
   * layer cannot reach the equipment engine, exactly as it cannot reach the
   * talent engine, so anything a file must write down has to be readable from
   * the body (engine/actor.ts says so at both fields).
   *
   * ═══ THE SHAPE IS THE ONE persist/saves.ts ALREADY DECLARED ═══
   * `SavedLoadout` there is `{ carried?: readonly string[]; equipped?:
   * Readonly<Record<string, string>> }` and `fileFor` takes
   * `CharacterSnapshot & SavedLoadout`. These two declarations are that
   * intersection's other half and are kept IDENTICAL by hand: a divergence is
   * now a compile error at `fileFor`'s parameter rather than a silent
   * disagreement about a field name. `Record<string, string>` and not
   * `Partial<Record<Slot, string>>`, deliberately — a save file's slot key is a
   * STRING until somebody checks it, and the checking happens on the way onto
   * the body (`restoreProgression`), not in a type.
   *
   * ═══ ABSENT IS NOT EMPTY, AND THE `??` CHAIN READS THEM DIFFERENTLY ═══
   * The identical discipline `progressionPoints` states for `talentPoints`:
   * `[]`/`{}` is a CLAIM ("this character owns nothing"), `undefined` is "this
   * build cannot say", and `fileFor`'s `snapshot.carried ?? binding.carried`
   * turns the second into "leave the disk exactly as you found it". A producer
   * that filled these unconditionally would empty a returning player's bag the
   * first time a fixture snapshot was written.
   */
  readonly carried?: readonly string[];
  /** Slot name -> item id. See `carried` above; the two travel together. */
  readonly equipped?: Readonly<Record<string, string>>;
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE PLAYER'S KEYS. THE ONE FIELD HERE THAT THE WORLD NEVER TOUCHES.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Action id -> key strings, in slot order — ToME's `binds_remap[virtual] =
   * {k1, k2}` (engines/default/engine/KeyBind.lua:78, :88-103), read straight off
   * `PlayerActor.keybinds`, which is why that field lives on the actor at all:
   * this pass cannot reach a preferences store any more than it can reach the
   * talent engine (engine/actor.ts says so at the field).
   *
   * ═══ THE SHAPE IS `SavedPrefs`'S, KEPT IDENTICAL BY HAND ═══
   * persist/saves.ts declares `SavedPrefs = { keybinds?: Readonly<Record<string,
   * readonly string[]>> }` and `fileFor` takes `CharacterSnapshot & SavedLoadout
   * & SavedPrefs`. This declaration is that intersection's other half and is the
   * arrangement `carried` documents twenty lines up: a divergence is a COMPILE
   * ERROR at `fileFor`'s parameter rather than a silent disagreement about a
   * field name. `Record<string, readonly string[]>` and not a union of action ids,
   * deliberately — a save file's action key is a STRING, the action table is
   * client-side, and this layer has nothing to check membership against.
   *
   * ═══ OPTIONAL, NEVER NULLABLE, AND ABSENT IS NOT EMPTY ═══
   * `?` means "this port cannot say" and `{}` means "the player pressed RESET
   * ALL". `fileFor`'s `snapshot.keybinds ?? binding.keybinds` turns the first
   * into "leave the disk exactly as you found it" and writes the second. A
   * producer that filled this unconditionally would wipe a returning player's
   * rebinds the first time a fixture-shaped snapshot was taken — which is the
   * one-way valve progression and items each shipped once.
   *
   * ═══ AND IT IS NOT UNDER THE `classChoiceOwed` RULE, UNLIKE `talentPoints` ═══
   * See `snapshotPlayers`. A keymap is not a claim about a class.
   */
  readonly keybinds?: Readonly<Record<string, readonly string[]>>;
  /** base64 bitset of the overworld this character had explored. */
  readonly explored?: string;
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
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * PROGRESSION COMING BACK. THE OTHER HALF OF WHAT MUST NOT BE RE-DERIVED.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * The three absences at the head of this type — name, position, effects — are
   * all things better re-derived than restored. Level, xp and the raw talent
   * spread are the opposite, and more so than the class: a class can be picked
   * again in four seconds, whereas an evening's kills cannot be re-earned.
   *
   * OPTIONAL, NOT NULLABLE, and the difference is deliberate. `hp` and
   * `classId` are `| null` because the file always HAS those columns and null
   * is a real answer in them. These four are `?` because an implementation of
   * this port may predate them entirely, and because a character file may
   * genuinely not carry them: every file written before progression shipped has
   * no `level` key at all, and `parseCharacterFile` leaves the four absent
   * rather than inventing them. Absent therefore means "this port cannot say",
   * which is why a restore cannot silently downgrade a level-8 character to 1.
   *
   * THE SHIPPED BRIDGE DOES SAY. `createCharacterBridge.openCharacter` returns
   * all four off the parsed file. This paragraph used to name it as the example
   * of a port that returns `{hp, cooldowns, classId}` and nothing else; that was
   * true, and it meant progression was never restored on any path.
   *
   * `applyRestore` treats `unspentPoints` as a CACHE and recomputes it from
   * `level` and the raw spread wherever it can — see there.
   */
  readonly level?: number;
  /** PER-LEVEL xp, never a running total. */
  readonly xp?: number;
  /** Points in hand, as the file claims. Reconciled, never trusted. */
  readonly unspentPoints?: number;
  /** Namespaced talent id -> RAW points. The only non-derived one of the four. */
  readonly talentPoints?: Readonly<Record<string, number>>;
  /**
   * Gold, as the file holds it. NOT reconciled against anything, because there
   * is nothing to reconcile it against — see `CharacterSnapshot.money`. Absent
   * means "this port cannot say" and the birth purse stands.
   */
  readonly money?: number;
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE BAG AND THE PAPER DOLL, COMING BACK. THE OTHER HALF OF THE LOOP.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * OPTIONAL, NOT NULLABLE, for the reason the four progression fields above
   * are: a character file written before items existed has neither key,
   * `parseCharacterFile` leaves both absent rather than inventing them, and
   * absent therefore means "this port cannot say" — which is what stops a
   * restore silently stripping a geared character down to nothing.
   *
   * ALREADY REPAIRED BY THE TIME THEY ARRIVE. `parseCarried` drops an id the
   * catalogue does not know and drops later duplicates (`carried` IS A SET, not
   * a bag — which is why `handlePickup` refuses an id the actor already owns);
   * `parseEquipped` drops an entry whose id is not valid for its slot outright
   * rather than re-filing or re-slotting it, and persist/saves.ts argues both
   * repairs and both rejections in full. `restoreProgression` re-checks anyway,
   * cheaply, because a `CharacterRestore` may come from any implementation of
   * `PersistPort` and not only from the shipped bridge.
   *
   * THE SHAPE IS `SavedLoadout`'S, kept identical by hand — see
   * `CharacterSnapshot.carried` for why that is a compile-time guarantee rather
   * than a convention.
   */
  readonly carried?: readonly string[];
  /** Slot name -> item id, as the file holds it. Validated on the way onto the body. */
  readonly equipped?: Readonly<Record<string, string>>;
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE KEYS, COMING BACK. THE HALF THAT IS THE ENTIRE REQUEST.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * "No one likes to reconfigure keybinds" is the whole of the feature, and this
   * is the field that answers it. `fileFor` writes the live map to disk; a
   * restore that did not read it back would be the identical one-way valve
   * progression and items each shipped and each had to have fixed — keys to the
   * file, nothing returned, and the Keys screen showing defaults forever over a
   * file that states the player's choices perfectly clearly.
   *
   * OPTIONAL, NOT NULLABLE, for the reason `carried` above is: a character file
   * written before this shipped has no `keybinds` key at all, `parseCharacterFile`
   * leaves it absent rather than inventing one, and absent therefore means "this
   * port cannot say" — which is what stops a restore silently clearing the binds
   * of somebody who spent a session getting them right.
   *
   * ALREADY REPAIRED BY THE TIME IT ARRIVES, and repaired rather than REFUSED:
   * `parseKeybinds` drops a non-array value, an empty or over-long key string and
   * anything past the caps, records each in `problems` under a per-action budget,
   * and keeps an action whose keys all dropped as `[]` rather than deleting it.
   * It deliberately does NOT check membership — this build's action table lives
   * in src/client/input/keys.ts and neither persist/ nor net/ may import it — so
   * an id this build no longer binds comes through verbatim and the CLIENT owns
   * the drop.
   *
   * THE SHAPE IS `SavedPrefs`'S, kept identical by hand — see
   * `CharacterSnapshot.keybinds` for why that is a compile-time guarantee.
   */
  readonly keybinds?: Readonly<Record<string, readonly string[]>>;
  /**
   * base64 bitset of the overworld this character had explored, straight off
   * the disk. Decoded against the CURRENT region's size, so a save written
   * before the map grew loads the country it knew and treats the rest as
   * unexplored — see `applyRestore`.
   */
  readonly explored?: string;
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
  /**
   * IS ANYTHING THIS ACTOR DOES TONIGHT ACTUALLY GOING TO REACH A FILE?
   *
   * ═══ ONE BOOLEAN, ONE SCREEN, AND IT IS NOT A SECOND SOURCE OF TRUTH ═══
   * The gateway holds no copy of the binding table and must not grow one — a
   * second answer to "who may be persisted" is how one player's save ends up in
   * another's directory. This is the opposite shape: the port that OWNS the
   * bindings answers the question, and the gateway only relays it.
   *
   * IT EXISTS BECAUSE `persisted: session.ownerId !== null && persist !== undefined`
   * OVERSTATES. A verified player whose file came back `too_new` or `corrupt` is
   * deliberately NOT bound (persist/saves.ts refuses so the bytes stay where a
   * human can look at them), `owned()` then drops every snapshot they generate,
   * and nothing they do all evening reaches disk — while the Keys screen's
   * `persisted: true` told them the opposite and suppressed the one warning whose
   * whole job is to say otherwise. Ten minutes of rebinding, silently discarded,
   * with no signal but a line in the host's log.
   *
   * SYNCHRONOUS AND OPTIONAL. It is a map lookup; a port with no binding table
   * omits it and the old, wider answer stands, which is right for a recording
   * double in a test that has no notion of ownership at all.
   */
  isBound?(actorId: string): boolean;
};

export type WsGatewayOptions = {
  /**
   * THE DEFAULT REALM — the world a session is in until it is told otherwise.
   *
   * KEPT BESIDE `realms` RATHER THAN REPLACED BY IT, and not as a transitional
   * courtesy. A session's realm is `null` until something places its body
   * somewhere else (see `Session.realmId`), and `null` resolves to exactly this
   * pair. So every construction that predates realms — `{ world, engine }` and
   * nothing more, which is what tools/e2e-m1.mjs and every gateway test build —
   * keeps describing the whole game, with no branch anywhere below behaving
   * differently than it did.
   */
  readonly world: World;
  readonly engine: TurnEngine;
  /**
   * EVERYWHERE ELSE THERE IS TO BE. Absent → there is one world and it is the
   * pair above, which is the M1-M10 shape of this server and still the right
   * shape for a test that boots a floor in memory.
   *
   * OPTIONAL FOR THAT REASON AND NOT MERELY FOR CONVENIENCE. Supplying it is the
   * ONE thing that changes where a frame lands: with it, `hello` places a body in
   * Alderbrook, a step onto a site cell crosses into that site, the pump ticks
   * every realm, and every broadcast is narrowed to the floor it is about.
   * Without it, `realmFor` and `homeOf` both answer `fallbackRealm`, whose id is
   * `''`, and every one of those paths collapses back into the single-world game
   * — which is what test/server/**, tools/e2e-m1.mjs and any fixture that builds
   * `{ world, engine }` are still describing, unchanged.
   *
   * The SAME instance src/server/main.ts builds. Two would be two answers to
   * "which floor is Sam standing on".
   */
  readonly realms?: Realms;
  /**
   * WHO IS PLAYING WITH WHOM (engine/party.ts), READ FOR ONE QUESTION ONLY:
   * whose instance is this, when somebody steps onto a site cell.
   *
   * The SAME instance src/server/main.ts hands to every realm's engine. Two
   * would be two answers to "is Ren in my party", and the second one would open
   * a private copy of the floor beside her.
   *
   * OPTIONAL, AND ABSENT MEANS EVERY PLAYER IS A PARTY OF ONE for the purpose of
   * opening an instance — the id falls back to the actor's own, which is exactly
   * what `partyOf` would have minted for a player nobody has invited
   * (engine/party.ts:276-290). A gateway built without a party table is the
   * pre-party game and must go on describing it.
   */
  readonly parties?: PartyState;
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
   * ═══════════════════════════════════════════════════════════════════════════
   * THE TALENT LAYER'S EFFECT TABLE, so Marked and Guarded reach a screen.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * There are two effect systems and only one was ever drawn. Sigil marks a
   * husk and Iron Curtain covers an ally, and neither was visible to any
   * client — so `docs/game-design.md` § 10's *"it's sigiled, hit it"* was a
   * conversation about a mechanic nobody could see.
   *
   * NARROWED TO ONE METHOD (`effectOn`) rather than taking the whole engine:
   * the projector needs to read one table and must not be handed something it
   * could cast a talent with.
   *
   * Absent → the badge row is byte-for-byte what it was.
   */
  readonly talentEffects?: {
    effectOn(actorId: string, kind: TalentEffect): { readonly turns: number } | undefined;
  };
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
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * ...AND A LEVEL GAINED, which rode the five-second debounce until now.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Losing a level to a restart is the one debounced loss a player genuinely
   * resents. Hit points and explored tiles come back by playing; a level is the
   * reward for the last twenty minutes, it arrives with a fanfare line in the
   * Record and an unspent talent point on the panel, and re-earning it is not
   * "re-click", it is the twenty minutes again.
   *
   * ═══ AND IT IS SAFE TO FLUSH, BY THIS FILE'S OWN ARGUMENT ═══
   * The long note on the save cadence below explains why `equip`/`drop` were
   * MOVED OFF the immediate path: they are reversible pairs, so a client can
   * alternate them forever and the write chain — which coalesces nothing — grows
   * without bound. It exempts `spend_point` from that reasoning in one sentence:
   * its total is FINITE, because "a player has as many spends as they have
   * earned levels."
   *
   * A LEVEL IS THE THING THAT SENTENCE IS COUNTING. It is strictly more finite
   * than the spends it grants, it is not reversible, and no client frame can
   * cause one — it takes the engine paying experience for a body that actually
   * died. So this cannot be farmed, and it is bounded by the same quantity the
   * existing exemption is already comfortable with.
   */
  // `?? []` because the gateway states its engine contract STRUCTURALLY and the
  // stub engines in test/ predate this field. An engine that reports no levels
  // is answering "none", which is the same branch as none.
  if ((result.levelUps ?? []).length > 0) return true;
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
    /**
     * ═════════════════════════════════════════════════════════════════════════
     * THE SEVENTH TERM, AND WITHOUT IT THE FIELD IS NEVER SENT.
     * ═════════════════════════════════════════════════════════════════════════
     *
     * The note on `PumpResult.refusals` spells out this exact failure for the
     * refund path: an actor parks again, "EVERY term of `turnKey` (gameTurn,
     * engagement, whoseTurn, committed, standingBy, bellArmed) is byte-identical
     * — `broadcastTurnIfChanged` sends nothing".
     *
     * A MID-ROUND ACTION IS THE SAME SHAPE. The player acts, keeps their energy,
     * and goes straight back into the blocking set they were already in: the
     * clock has not moved, engagement has not moved, and the three arrays are
     * unchanged. So the frame that would say "he is halfway through a plan"
     * would be suppressed as a duplicate of the one before it, and `acting`
     * would be a field the client was never once told about.
     */
    (state.acting ?? []).join(','),
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

/**
 * THE FLOOR IS CLEAR. `JSON.stringify([])` written out as the literal it
 * produces, for the reason `NO_PROJECTILES_KEY` gives directly above: the memo
 * is SEEDED with it rather than with null, so a server on which nothing has been
 * dropped sends byte-for-byte the frame set it sent before loot existed. An
 * empty floor is what a client already believes before it is told anything, and
 * `welcome` carries no item list precisely because absence is the default.
 *
 * A floor that EMPTIES still broadcasts, and that is the difference between
 * seeding and gating: the key moves from a populated list to `'[]'`, which is a
 * change, so `[]` goes out and the last marker comes off every screen. The frame
 * is complete and absolute — see `projectGroundItems`.
 */
const NO_GROUND_KEY = '[]';

/**
 * AN EMPTY BAG AND AN EMPTY PAPER DOLL, as the per-session memo key spells them.
 *
 * Same seeding argument as `NO_PROJECTILES_KEY`, one level down: the key is
 * per-SOCKET (like `viewerKey` and `progressKey`) because a resumed connection
 * has seen nothing, and it is seeded with the empty state so that the
 * overwhelmingly common player — carrying nothing, wearing nothing, for the
 * whole first fight of a delve — is never sent an `inventory` frame saying so.
 *
 * The moment they pick something up the key moves and the frame goes; the moment
 * they drop their last thing it moves BACK and an empty frame goes, which is
 * what takes the row off their panel. Gating on "has items" instead of seeding
 * would have been the bug: the last item would never be removed from the screen.
 */
const EMPTY_INVENTORY_KEY = '[[],{}]';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * HOW MANY THINGS A DETECTIVE MAY CARRY. TWELVE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A DEVIATION, AND IT IS LABELLED AS ONE. ToME's backpack is `INVEN = 1000`
 * (data/birth/descriptors.lua:56) — a limit nobody meets in a four-hour session,
 * which engine/actor.ts's own note on `carried` calls "a rule that only exists
 * to be got wrong". Upstream can afford that because it has a vendor, a home
 * chest and a hundred-hour campaign to fill a bag over. We have one floor, three
 * monsters on it, at most three drops per delve and no shop.
 *
 * TWELVE IS CHOSEN, NOT PORTED. It is the smallest number that cannot bind in
 * ordinary play — seven worn slots plus five in reserve is more than a full kit —
 * so a player who hits it has been hoarding rather than playing, and the refusal
 * they get is a nudge to leave something for a friend. The point of a cap that
 * cannot bind is not the cap: it is that `pickup` has a bounded answer at all,
 * so `carried` cannot grow without limit under a client in a loop.
 */
const INVENTORY_CAP = 12;

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ONE PLACE TO PUMP AND BROADCAST ABOUT. STRUCTURAL, NOT `Realm`, ON PURPOSE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A `Realm` (world/realms.ts:108) satisfies this by identity — id, world,
 * engine — so `Realms.all()` is a list of these with no conversion anywhere.
 * What this type buys is the OTHER member of the list: the synthetic fallback
 * that wraps `opts.world`/`opts.engine` for a gateway built with no registry.
 *
 * That one cannot be a `Realm`, and not for a stylistic reason. `Realm.engine`
 * is a `ReapingTurnEngine` — the ADAPTER's type, from turn-engine.ts — while
 * this file's whole contract with the scheduler is the structural `TurnEngine`
 * it declares itself, precisely so net/ never imports the engine. Every test in
 * test/server/ registers this plugin against a hand-written object that is a
 * `TurnEngine` and is emphatically not a `ReapingTurnEngine`. Widening the pump
 * loop's element type is what lets those two live in one array without a cast
 * — and a cast here would be a lie the compiler had agreed to.
 *
 * THE ID IS `''` FOR THE FALLBACK, and that empty string is load-bearing rather
 * than decorative: `broadcast`'s third argument means "only this realm", and
 * `''` is never a realm id, so the pump maps it back to `undefined` — "tell
 * everybody", which is what every frame in this file did before realms existed.
 * See `audienceFor`.
 */
type PumpTarget = {
  readonly id: string;
  readonly world: World;
  readonly engine: TurnEngine;
};

/**
 * WHERE THE "WHICH GROUND IS DANGEROUS" TABLE WENT.
 *
 * There was an `ENCOUNTER_CHANCE` map here, a percentage per terrain, read by a
 * per-step d100. Both are gone: danger on the overworld is a thing you can see
 * and walk into, not a roll you cannot.
 *
 * The knowledge itself survives and is now in exactly one place — `HAUNTS` in
 * world/roamers.ts, which decides where a roamer may stand and wander. It keeps
 * the same rule for the same reason: never the road, a settlement approach or a
 * bridge, because "the road is safe" is a promise a player learns to rely on.
 * A visible marker parked on the road would break that promise far more
 * plainly than an invisible roll ever did.
 */
export const wsGateway: FastifyPluginAsync<WsGatewayOptions> = async (app, opts) => {
  const { world, engine } = opts;
  const disconnectGraceMs = opts.disconnectGraceMs ?? DEFAULT_DISCONNECT_GRACE_MS;

  /**
   * THE ONE WORLD, WEARING A REALM'S SHAPE. See `PumpTarget`.
   *
   * It is what `realmFor` answers for a socket that has not been placed, what
   * `homeOf` answers for a body the registry does not hold, and — when there is
   * no registry at all — the entire contents of `pumpTargets()`. Its `id` is
   * `''`, so every frame sent on its behalf goes to the whole room exactly as it
   * always did.
   */
  const fallbackRealm: PumpTarget = { id: '', world, engine };

  /**
   * EVERYWHERE THE WORLD HAS TO BE ADVANCED THIS TICK.
   *
   * A live read rather than a cached array, because the set GROWS: `Realms.open`
   * mints an instance the moment a party walks into a site, and a pump that was
   * iterating a snapshot taken at boot would never tick the floor those players
   * are standing on. Common realms are built eagerly at boot for the related
   * reason realms.ts states — `all()` must not change shape underneath a single
   * iteration — and this function is called once per pump, before the loop.
   */
  const pumpTargets = (): readonly PumpTarget[] => opts.realms?.all() ?? [fallbackRealm];

  /**
   * WHO A FRAME ABOUT THIS REALM IS FOR, in `broadcast`'s third-argument terms.
   *
   * A named realm narrows the audience to the sockets standing in it. The
   * fallback realm's `''` widens back to `undefined`, which `broadcast`
   * documents as "every session that has completed hello" — the pre-realms
   * behaviour, and the reason a gateway with no registry sends byte-for-byte
   * what it always sent.
   */
  const audienceFor = (realmId: string): string | undefined =>
    realmId === '' ? undefined : realmId;

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * WHICH WORLD IS THIS FRAME ABOUT? — the one lookup every handler starts with.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Each handler destructures this into locals named `world` and `engine`, which
   * SHADOW the two bindings above for the length of that function. That is the
   * whole mechanism: the body of `handleMove` still reads `engine.submitMove`,
   * `handlePickup` still reads `world.itemsAt`, and neither had to learn that
   * more than one of either exists. A handler that referenced a realm through
   * some third name would be a handler somebody could forget to convert, and the
   * compiler would not say a word.
   *
   * ═══ THE TWO FALLBACKS ARE WHAT MAKE THIS COMMIT A NO-OP ═══
   *
   *   NO REGISTRY — `opts.realms` is undefined, which is every construction that
   *   predates realms: tools/e2e-m1.mjs, every test under test/server/, and
   *   src/server/main.ts until the commit that wires it. There is one world and
   *   this returns it, unconditionally.
   *
   *   NO REALM ON THE SESSION — `session.realmId` is null, which is every socket
   *   from the instant it opens until a body of its is placed in a named realm.
   *   Same answer.
   *
   * ═══ AND A THIRD, WHICH IS ABOUT A REALM THAT WENT AWAY UNDERNEATH SOMEBODY
   * ═══
   * `Realms.close` refuses to close a realm that still holds a player body
   * (realms.ts:396) precisely so this cannot happen in the ordinary course. It is
   * still answered rather than asserted, because the consequence of being wrong
   * is not a wrong frame but a dead process: a `get` returning undefined would
   * throw inside a `ws` message handler, and this file's header is explicit that
   * an escaping exception costs every player their session rather than one player
   * their frame. Falling back to the overworld-shaped default leaves that socket
   * rendering a place it is not in — visibly wrong, recoverable by reconnecting,
   * and logged by whatever closed the realm. Wrong beats gone.
   */
  const realmFor = (session: Session): PumpTarget => {
    if (opts.realms === undefined || session.realmId === null) return fallbackRealm;
    return opts.realms.get(session.realmId) ?? fallbackRealm;
  };

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * WHICH WORLD IS THIS *BODY* IN? — the same question asked without a socket.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `realmFor` answers for a CONNECTION and is what every handler starts with.
   * A dozen things in this file are about an ACTOR ID with no session in hand:
   * the Case Log naming a monster somebody's orb just hit, the reconnect grace
   * expiring on a body whose socket closed ten minutes ago, a loot verb charging
   * a turn. Those cannot ask a socket, so they ask the registry.
   *
   * A LINEAR SCAN, AND IT IS THE RIGHT SHAPE HERE. `Realms.realmOf` walks the
   * realms and asks each world for the id (world/realms.ts:358-363) — a handful
   * of Map lookups against a registry that holds the overworld, three towns and
   * whatever instances are open. The alternative is an actor -> realm index in
   * this file, which is a SECOND answer to "where is Sam" beside the one the
   * worlds already hold, and the two would drift the first time a body moved by
   * a path that forgot to update it. See the realms.ts header: the whole design
   * is "correct by construction rather than by vigilance".
   *
   * WITH NO REGISTRY IT IS NOT RUN AT ALL and the answer is the default pair,
   * which is what keeps every pre-realms construction byte-identical.
   */
  const homeOf = (actorId: string): PumpTarget => opts.realms?.realmOf(actorId) ?? fallbackRealm;

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
   * ═══════════════════════════════════════════════════════════════════════════
   * THE BELL — ONE PER REALM, AND THE TIMERS MUST NOT SHARE A VARIABLE.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `gameTurn` identifies WHICH park this Bell belongs to. Players are
   * phase-locked (DECISIONS.md § D1) so the barrier parks exactly once per game
   * turn, which makes the turn number a sufficient identity and stops a second
   * commit arriving mid-countdown from restarting the clock — a Bell that
   * restarts every time someone else commits never rings.
   *
   * ═══ WHY A MAP, AND WHAT THE SINGLE VARIABLE ACTUALLY BROKE ═══
   * This was one `bell | null`, which is correct for one floor and silently
   * wrong for N. Each realm has its OWN barrier (world/realms.ts:266-289 — two
   * realms sharing one would collide on the level-wide countdown key), so each
   * realm parks on its own schedule and asks for its own countdown. With one
   * variable, the second realm to arm in a tick called `clearBell` on the first
   * realm's `setTimeout` and overwrote it: the party in the Underworks would
   * have their 20 seconds cancelled by three people in the office standing still
   * — no ring, no straggler hold, and the floor waits forever on somebody who
   * has gone to make tea. Keyed by realm id, `clearBell(a)` cannot reach b's
   * timer, because it does not have it.
   *
   * `gameTurn` STAYS THE PARK IDENTITY WITHIN a realm. Two realms genuinely can
   * be on the same game turn; they are simply different rows.
   */
  type Bell = {
    readonly gameTurn: number;
    readonly durationMs: number;
    readonly deadline: number;
    readonly timer: ReturnType<typeof setTimeout>;
  };
  const bells = new Map<string, Bell>();

  /**
   * The last barrier state broadcast PER REALM, as a key. See `turnKey`.
   *
   * ═══ WHY EVERY MEMO IN THIS FILE HAD TO BECOME A MAP ═══
   * A change-detector answers "did this frame's content move since I last sent
   * it". With one variable and N realms it answers a different question — "did
   * it move since the last realm I looked at" — and the failure is SUPPRESSION,
   * which is invisible: realm A's key overwrites realm B's, B's genuinely
   * changed frame compares equal to A's, and B is never told. On the turn frame
   * that means a party is not shown that the barrier is now waiting on them,
   * which game-design.md § 4 names as the way this genre dies.
   */
  const lastTurnKeys = new Map<string, string>();

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

  /** The last `party` frame broadcast per realm, as a key. Same trick as `turnKey`. */
  const lastPartyKeys = new Map<string, string>();

  /** The last `effects` frame broadcast per realm, as a key. */
  const lastEffectsKeys = new Map<string, string>();

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
   *
   * ═══ A MISSING ROW IS THE SEED, WHICH IS WHY THE READS SAY `?? …` ═══
   * Per realm the seeding argument gets STRONGER, not weaker: a realm that was
   * created four seconds ago has never broadcast anything, and its first pump
   * must not open with an empty `projectiles` frame telling a client something
   * it already believes. Absent and `'[]'` therefore mean the same thing, and
   * every read spells that out rather than defaulting the Map.
   */
  const lastProjectilesKeys = new Map<string, string>();

  /**
   * The last `ground` frame broadcast per realm, as a key — SEEDED WITH THE
   * EMPTY FLOOR for exactly the reason `lastProjectilesKeys` is seeded with the
   * empty sky, missing row and all. See `NO_GROUND_KEY`.
   */
  const lastGroundKeys = new Map<string, string>();
  /** Per realm, like the floor. A shelf is shared, so this is not per socket. */
  const lastShopKeys = new Map<string, string>();
  /**
   * Delves whose last resident has fallen, so the moment is announced ONCE.
   *
   * Per realm and not per socket: clearing a room is a thing that happened to
   * the room, and somebody who follows their party in afterwards should not be
   * told it happened again.
   */
  const clearedRealms = new Set<string>();
  /**
   * How many residents this realm had at the last pump.
   *
   * ═══ THE ANNOUNCE HAS TO BE AN EDGE, AND MY FIRST VERSION WAS A LEVEL ═══
   * It announced whenever the count was zero and somebody was watching, which
   * fires for any reason the room is momentarily empty — including
   * `resetFloor`, which REAPS every monster before re-seeding. A party wiping
   * therefore got "An Index Breach is quiet now." in the middle of losing,
   * which is the exact opposite of the moment the line exists for. Observed in
   * a driven session: the line landed between a wraith's hit and the killing
   * blow, with three enemies still standing.
   *
   * So it is a TRANSITION: many, then none, seen by this process, in this
   * realm's lifetime.
   */
  const residentCounts = new Map<string, number>();

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
   *
   * THE PANEL IS THE PEOPLE ON THIS FLOOR. `projectParty` walks one world, so a
   * realm's panel lists that realm's bodies and the frame goes to that realm's
   * sockets — which is the only reading that is not a lie in both directions: a
   * player who walked into an instance is not standing next to you any more, and
   * their hp bar on your screen would be a bar you cannot do anything about.
   */
  const broadcastPartyIfChanged = (realm: PumpTarget, nowMs: number): void => {
    const msg = projectParty(realm.world, opts.downed, speakingNow(nowMs));
    const key = JSON.stringify(msg.members);
    if (key === lastPartyKeys.get(realm.id)) return;
    lastPartyKeys.set(realm.id, key);
    broadcast(msg, undefined, audienceFor(realm.id));
  };

  /**
   * EVERY BADGE IN THE WORLD, when they changed.
   *
   * Silent when no effect state is wired in: a server with no statuses sends no
   * `effects` frames at all rather than an empty one every pump, which keeps the
   * M3 frame set byte-for-byte unchanged on that path.
   */
  const broadcastEffectsIfChanged = (realm: PumpTarget): void => {
    const effects = opts.effects;
    if (effects === undefined) return;
    // ONE SHARED `EffectState`, PROJECTED PER WORLD. The table is keyed by actor
    // id and is deliberately process-wide (a stun follows a body through a door,
    // exactly as the Downed countdown does — world/realms.ts:188-199), and
    // `projectEffects` filters it against the actors it can see. So each realm's
    // frame lists that realm's badges and nobody else's.
    const msg = projectEffects(realm.world, effects, opts.talentEffects);
    const key = JSON.stringify(msg.actors);
    if (key === lastEffectsKeys.get(realm.id)) return;
    lastEffectsKeys.set(realm.id, key);
    broadcast(msg, undefined, audienceFor(realm.id));
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
  const broadcastProjectilesIfChanged = (realm: PumpTarget): void => {
    const msg = projectProjectiles(realm.world);
    const key = JSON.stringify(msg.projectiles);
    if (key === (lastProjectilesKeys.get(realm.id) ?? NO_PROJECTILES_KEY)) return;
    lastProjectilesKeys.set(realm.id, key);
    broadcast(msg, undefined, audienceFor(realm.id));
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
  const sendProjectilesIfAny = (realm: PumpTarget, socket?: GatewaySocket): void => {
    const msg = projectProjectiles(realm.world);
    if (msg.projectiles.length === 0) return;
    if (socket !== undefined) {
      send(socket, msg);
      return;
    }
    lastProjectilesKeys.set(realm.id, JSON.stringify(msg.projectiles));
    broadcast(msg, undefined, audienceFor(realm.id));
  };

  /**
   * EVERYTHING ON THE FLOOR, when it changed. The fourth memo of this shape.
   *
   * ═══ WHY IT IS A MEMO IN THE PUMP RATHER THAN A PUSH IN EACH VERB ═══
   * The floor changes from FOUR directions and only two of them are a loot verb:
   * a `pickup` takes one off, a `drop` puts one on, a MONSTER DYING spills its
   * kit (scheduler.ts's `spill` step, which runs inside the pump), and a floor
   * RESET clears the table wholesale (turn-engine.ts:536, on a party wipe). A
   * push wired into the two verbs would be silently wrong for the other two, and
   * the symptom would be a corpse's drop that nobody can see until somebody
   * happens to pick something else up.
   *
   * BROADCAST, NOT UNICAST, and honestly so: the pile is unowned and shared, and
   * it is not FOV-gated. `projectGroundItems` carries that argument in full and
   * names it as an accepted leak riding `ProjectilesMsg`'s existing one.
   *
   * ═══ "ON CHANGE" IS SAFE BECAUSE THE FRAME IS ABSOLUTE ═══
   * Suppressing a duplicate is only ever legal for a snapshot. A frame that DOES
   * go out replaces the client's whole floor, so a suppressed one would have said
   * precisely what the client already believes — and an item being TAKEN is a
   * change like any other, so the pile shrinking broadcasts an absence rather
   * than a "removed" patch.
   */
  const broadcastGroundIfChanged = (realm: PumpTarget): void => {
    const msg = projectGroundItems(realm.world);
    const key = JSON.stringify(msg.items);
    if (key === (lastGroundKeys.get(realm.id) ?? NO_GROUND_KEY)) return;
    lastGroundKeys.set(realm.id, key);
    broadcast(msg, undefined, audienceFor(realm.id));
  };

  /**
   * Build this realm's shop frame, or null when the realm has no shop.
   *
   * THE LEVEL IS THE PARTY'S, and it is read off the bodies standing here
   * rather than off a party table: a shop prices for the room it is in, which
   * is also the level its shelves were stocked for.
   */
  const shopFrameFor = (realm: PumpTarget): ShopMsg | null => {
    const full = opts.realms?.get(realm.id);
    if (full?.shop === undefined) return null;
    const level = partyMaxLevel(
      full.world.allActors().flatMap((a) => (a.kind === ActorKind.Player ? [a.level] : [])),
    );

    /**
     * ═════════════════════════════════════════════════════════════════════════
     * THE SHELF CATCHES UP HERE, AND WITHOUT THIS EVERY SHOP IS EMPTY.
     * ═════════════════════════════════════════════════════════════════════════
     *
     * `catchUpShop` had exactly one caller — `handleShopBuy` — and its comment
     * there says *"the shelf catches up on the door"*. It does not: this
     * function is the door. A shop is born at `epoch: -1` with `stock: []`
     * (world/realms.ts, and shopstate.ts explains why -1 rather than 0), so the
     * FIRST frame a player ever receives on walking in was built from an empty
     * array — and the only thing that would have filled it was a purchase they
     * had no way to make, because the client can only buy what it was shown.
     *
     * A shop that is empty until you buy from it, and cannot be bought from
     * while it is empty. Threadneedle Row has been in the game for weeks and has
     * been doing this the whole time; the draught's shelf is simply the first
     * one anybody drove a socket at.
     *
     * BEFORE THE LOOKUP, for the same reason `handleShopBuy` does it before its
     * own: a party that levelled since arriving should see the batch the
     * restock just put out, not the one from when they opened the door.
     */
    catchUpShop(full, level);
    return projectShop(
      full.name,
      full.shop.stock.map((slot) => slot.id),
      stockLevelFor(level),
    );
  };

  /**
   * THE SHELVES, ON CHANGE, TO THE ROOM.
   *
   * A BROADCAST AND NOT A VIEWER FRAME, unlike the inventory: two players
   * looking at one shop see the same four coats at the same prices, and one of
   * them buying one is a fact the other needs immediately — otherwise the
   * second player clicks a coat that is not there any more and gets a refusal
   * for a reason their screen cannot explain.
   */
  const broadcastShopIfChanged = (realm: PumpTarget): void => {
    const msg = shopFrameFor(realm);
    if (msg === null) return;
    const key = JSON.stringify(msg.stock);
    if (key === lastShopKeys.get(realm.id)) return;
    lastShopKeys.set(realm.id, key);
    broadcast(msg, undefined, audienceFor(realm.id));
  };

  /**
   * The shelves, to somebody who has just arrived — `welcome`, a resume, or a
   * body that walked through the door. Unconditional, because a memo shared
   * with the room says nothing about what THIS socket has seen.
   */
  const sendShopIfAny = (session: Session): void => {
    const msg = shopFrameFor(realmFor(session));
    if (msg !== null) send(session.socket, msg);
  };

  /**
   * THE FLOOR, TO SOMEBODY WHO HAS SEEN NOTHING — `welcome` and a resume.
   *
   * The same shape and the same argument as `sendProjectilesIfAny` directly
   * above, with one difference in the timescale that makes it matter MORE rather
   * than less: an orb is a three-turn object, and a coat on the floor lasts for
   * the rest of the delve. A player who reconnects after a fight would otherwise
   * see a bare floor until the next time somebody dropped or took something,
   * which out of combat can be the whole evening — and the thing they cannot see
   * is the drop the party is standing around discussing.
   *
   * SILENT ON AN EMPTY FLOOR, because absence is the client's default and
   * `welcome` deliberately carries no item list.
   *
   * @param socket the one recipient, or absent to tell the room. The broadcast
   *   form updates the memo, so a `broadcastGroundIfChanged` later in the same
   *   pump correctly sends nothing.
   */
  const sendGroundIfAny = (realm: PumpTarget, socket?: GatewaySocket): void => {
    const msg = projectGroundItems(realm.world);
    if (msg.items.length === 0) return;
    if (socket !== undefined) {
      send(socket, msg);
      return;
    }
    lastGroundKeys.set(realm.id, JSON.stringify(msg.items));
    broadcast(msg, undefined, audienceFor(realm.id));
  };

  /**
   * A comparison key for "has this viewer's bag, doll or purse changed?".
   *
   * The two ID LISTS AND THE PURSE, and nothing derived from any of them.
   * `compare` rows are a pure function of (`baseCombat`, `equipped`, the item) —
   * so any change that could move a row moves one of the two lists FIRST, with
   * the single exception of a class being chosen under a full bag, which
   * `handleChooseClass` pushes explicitly for that reason.
   *
   * ═══ THE PURSE IS HERE BECAUSE GOLD MOVES WITHOUT EITHER LIST MOVING ═══
   * A coin pile is not a bag entry — `handlePickup` credits `money` and puts
   * nothing in `carried` (content/money.ts says why). So picking one up changed
   * NEITHER list, this key did not move, and `sendInventoryIfChanged` sent
   * nothing: the gold on the panel stayed where it was until the player
   * happened to pick up or equip an item, at which point it jumped.
   *
   * That shipped. It is exactly the failure a memo key is for — a frame
   * suppressed because the thing that changed was not in the key — and it is
   * why anything `InventoryMsg` carries has to be in here, not merely anything
   * the BAG carries.
   *
   * A string rather than a field-by-field compare, for `turnKey`'s stated
   * reason: `carried` is replaced rather than spliced (engine/actor.ts says so),
   * but `equipped` is a live object this file mutates, and a memo holding a
   * reference to it would compare equal to itself forever.
   */
  const inventoryKeyOf = (actor: Actor): string =>
    JSON.stringify([
      actor.carried ?? [],
      actor.equipped ?? {},
      actor.kind === ActorKind.Player ? actor.money : 0,
    ]);

  /**
   * THIS VIEWER'S BAG AND DOLL, unconditionally, updating the memo.
   *
   * Silent for a socket with no body and for a monster, which cannot open a
   * panel. Used where the CONTENT of a frame can change without either id list
   * moving — see `handleChooseClass`.
   */
  const sendInventory = (session: Session): void => {
    const { world } = realmFor(session);
    const actorId = session.actorId;
    if (actorId === null) return;
    const viewer = world.getActor(actorId);
    if (viewer === undefined || viewer.kind !== 'player') return;
    // THE SELL PRICE ONLY WHERE THERE IS A COUNTER. `sellPrice` is a pure
    // function of the id, so this is not a lookup the projector could not do —
    // it is a fact about the ROOM, and view/ has no business knowing what a shop
    // is. See `CarriedItemView.sell`.
    const counter = opts.realms?.get(session.realmId ?? '')?.shop;
    send(session.socket, projectInventory(viewer, counter === undefined ? undefined : sellPrice));
    session.inventoryKey = inventoryKeyOf(viewer);
  };

  /**
   * The same frame, ON CHANGE, for the pump loop and for `hello`.
   *
   * VIEWER-PRIVATE AND STRUCTURALLY SO: `InventoryMsg` is a `ViewerMsg`, so
   * `broadcast(projectInventory(...))` does not compile. That is not only
   * privacy — `CarriedItemView.compare` is a delta against the RECIPIENT'S own
   * doll, so one shared copy would be arithmetically wrong for everybody but its
   * author.
   *
   * It rides `refreshViewers` rather than being pushed from the four loot verbs,
   * for the reason `broadcastGroundIfChanged` gives: a bag can also change under
   * a pump the viewer had nothing to do with — a restore at join, and one day a
   * monster that steals.
   */
  const sendInventoryIfChanged = (session: Session): void => {
    const { world } = realmFor(session);
    const actorId = session.actorId;
    if (actorId === null) return;
    const viewer = world.getActor(actorId);
    if (viewer === undefined || viewer.kind !== 'player') return;
    if (inventoryKeyOf(viewer) === session.inventoryKey) return;
    sendInventory(session);
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
  const noteSpoke = (realm: PumpTarget, actorId: string): void => {
    const nowMs = Date.now();
    spokeAtMs.set(actorId, nowMs);
    broadcastPartyIfChanged(realm, nowMs);

    if (speakingTimer !== null) clearTimeout(speakingTimer);
    speakingTimer = setTimeout(() => {
      speakingTimer = null;
      guard('speaking sweep threw', () => {
        // EVERY REALM, not the one the speaker was in. The dot goes out on a wall
        // clock, so this is the only thing that ever recomputes it — and the
        // panel it lights is per realm. Sweeping just the speaker's realm would
        // leave a dot burning on any other floor whose last talker fell silent
        // without a pump to notice. It is one memo compare per realm.
        for (const target of pumpTargets()) broadcastPartyIfChanged(target, Date.now());
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
  /**
   * `{ talentPoints }` when there is a spread, `{}` when there is not.
   *
   * A body with no sheet must leave the field ABSENT rather than present and
   * empty: `{}` is a claim ("this character has no ranks in anything") and
   * absent is the truth ("this build cannot say"). The save layer's `??`
   * chain reads the two completely differently.
   */
  const progressionPoints = (
    points: Readonly<Record<string, number>> | undefined,
  ): { talentPoints?: Readonly<Record<string, number>> } =>
    points === undefined ? {} : { talentPoints: points };

  /**
   * The paper doll as plain data, IN `SLOT_ORDER`, with the empty slots gone.
   *
   * COPIED, NOT ALIASED, and that is not defensive habit:
   * `SaveStore.scheduleCharacter` holds its snapshot BY REFERENCE
   * (persist/saves.ts), and `actor.equipped` is a live object the loot verbs in
   * this file mutate in place. Handing over the live map would let a queued save
   * file whatever the doll looked like when the disk got round to it rather than
   * what it looked like when the snapshot was taken — which is the entire reason
   * `CharacterSnapshot` is plain data at all.
   *
   * `SLOT_ORDER` RATHER THAN THE MAP'S OWN ITERATION, so two saves of the same
   * character produce identical bytes. A `Partial<Record<Slot, string>>` built
   * by a player pressing buttons has whatever key order that produced, and a
   * JSON object preserves insertion order — so without this, equipping a coat
   * then a cap and equipping a cap then a coat would write two different files
   * for one identical character. saves.ts sorts on the way out for the same
   * reason; doing it here as well costs nothing and means the snapshot a test
   * inspects is already stable.
   *
   * The `| undefined` is dropped rather than emitted: `Partial<Record<Slot, …>>`
   * makes every value optional, and a key present with `undefined` would survive
   * into `JSON.stringify` as a missing key on disk but as a PRESENT key in the
   * memo comparison — two spellings of empty, which is exactly what
   * `InventoryMsg.equipped` refuses on the wire.
   */
  const wornRecord = (equipped: Partial<Record<Slot, string>>): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const slot of SLOT_ORDER) {
      const id = equipped[slot];
      if (id !== undefined) out[slot] = id;
    }
    return out;
  };

  /**
   * `{ carried }` and `{ equipped }` when the body has something to say, and
   * NOTHING AT ALL when it does not.
   *
   * THE SAME ABSENT-IS-NOT-EMPTY DISCIPLINE `progressionPoints` states, applied
   * to the two fields where it bites hardest. `[]`/`{}` is a CLAIM — "this
   * character owns nothing" — and `undefined` is "this build cannot say". The
   * save layer reads them completely differently: `fileFor` writes
   * `snapshot.carried ?? binding.carried`, so an absence leaves the disk exactly
   * as it found it while an empty array OVERWRITES a returning player's bag with
   * nothing.
   *
   * AN ABSENT FIELD IS THE ANSWER FOR AN M2-ERA BODY, not for an empty one. A
   * player who genuinely dropped everything has `carried: []` on the actor — the
   * loot verbs always write an array, never delete the field — so the claim is
   * made and the disk is emptied, which is correct. The undefined case is a
   * fixture, the e2e harness, and any body that has never touched an item.
   *
   * TWO SEPARATE SPREADS RATHER THAN ONE OBJECT, because the two are
   * independently absent: a character can be wearing a coat and carrying nothing.
   */
  const loadoutFields = (
    actor: Actor,
  ): { carried?: readonly string[]; equipped?: Readonly<Record<string, string>> } => ({
    ...(actor.carried === undefined ? {} : { carried: [...actor.carried] }),
    ...(actor.equipped === undefined ? {} : { equipped: wornRecord(actor.equipped) }),
  });

  /**
   * The keymap as plain data, KEYS SORTED and every slot array copied.
   *
   * COPIED, NOT ALIASED, for `wornRecord`'s stated reason:
   * `SaveStore.scheduleCharacter` holds its snapshot BY REFERENCE, so handing
   * over the live object would let a queued save file whatever the map looked
   * like when the disk got round to it rather than what it looked like when the
   * snapshot was taken. `handleSetKeybinds` replaces the map wholesale rather
   * than mutating it, so today the alias would be harmless — which is exactly the
   * kind of "harmless today" that stops being true the first time somebody adds
   * a per-action write.
   *
   * SORTED for `wornRecord`'s other reason: two saves of the same character must
   * produce identical bytes, and a map built by a player pressing buttons has
   * whatever key order that produced. persist/saves.ts sorts again on the way
   * out; doing it here as well costs nothing and means the snapshot a test
   * inspects is already stable.
   */
  const keybindsRecord = (
    binds: Readonly<Record<string, readonly string[]>>,
  ): Record<string, readonly string[]> => {
    const out: Record<string, readonly string[]> = {};
    for (const action of Object.keys(binds).sort()) {
      const keys = binds[action];
      if (keys !== undefined) out[action] = [...keys];
    }
    return out;
  };

  /**
   * `{ keybinds }` when the player has ever opened the Keys screen, and NOTHING
   * AT ALL when they have not.
   *
   * THE SAME ABSENT-IS-NOT-EMPTY DISCIPLINE `progressionPoints` and
   * `loadoutFields` state, and it bites harder here than in either of them
   * because the field is the whole of a feature whose one promise is that the
   * player never has to do this twice. `undefined` is "this build cannot say" and
   * leaves the disk exactly as it found it; `{}` is "the player pressed RESET
   * ALL" and is a claim worth writing down. A `?? {}` anywhere on this path hands
   * somebody their old keymap back every session.
   *
   * A SEPARATE SPREAD FROM `loadoutFields` RATHER THAN A FIELD IN IT, mirroring
   * `SavedPrefs` being a sibling of `SavedLoadout` rather than a member: a
   * loadout is state the WORLD gave the character, and this is a setting the
   * PLAYER chose. Folding them together would mean a future producer that fills
   * "the loadout" reasonably believing it had said something about the keymap.
   */
  const prefsFields = (
    actor: Actor,
  ): { keybinds?: Readonly<Record<string, readonly string[]>>; explored?: string } => ({
    ...(actor.keybinds === undefined ? {} : { keybinds: keybindsRecord(actor.keybinds) }),
    // WHAT THEY HAVE WALKED. Absent when this process has never revealed
    // anything for them, which `saveCharacter` reads as "cannot say" and leaves
    // the disk alone — the same carry-forward rule the keymap gets, and the
    // same reason: a producer that does not know must not erase.
    /**
     * ONE OVERWORLD, ONE STRING — and the shape does not change until there are
     * two. `CharacterFile.explored` is a base64 bitset and stays one, because a
     * record keyed by realm is a save migration that buys nothing while there is
     * a single map to key it by, and an optional field nobody writes is the
     * thing this session has spent its time deleting.
     *
     * WHAT DID CHANGE is that the string is now read out of a bitset that KNOWS
     * which map it is about, so the day a second overworld exists this line
     * widens to a record and the in-memory side is already correct.
     */
    ...(fogSeen(actor.id, OVERWORLD_ID)
      ? { explored: fogToBase64(fogFor(actor.id, opts.realms?.overworld)) }
      : {}),
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * WHAT EACH CHARACTER HAS EXPLORED OF THE OVERWORLD.
   * ═══════════════════════════════════════════════════════════════════════════
   * PER CHARACTER, NOT PER PROCESS, which is the whole request: six people can
   * walk the same region and each has their own map of it, because exploring is
   * a thing you did rather than a fact about the world.
   *
   * Kept beside the sessions rather than on the actor, because a body is
   * rebuilt every time it crosses a realm (`crossInto` makes a new one) and the
   * map must not be rebuilt with it. Keyed by actor id, which is what survives.
   *
   * ONLY THE OVERWORLD. Instanced realms mint an id per opening, so their fog
   * could never be matched again, and a 24x24 arena is not somewhere anybody
   * explores. See `CharacterFile.explored`.
   */
  /**
   * ═════════════════════════════════════════════════════════════════════════
   * KEYED BY ACTOR **AND REALM**, AND THE SECOND KEY IS THE WHOLE POINT.
   * ═════════════════════════════════════════════════════════════════════════
   *
   * This was `Map<actorId, Uint8Array>`. One bitset per player, sized from
   * `realms.overworld`, written by `revealFor` for ANY realm whose kind is
   * Overworld — and there is one of those today, so it was correct and would
   * have gone on being correct right up until the day it was not.
   *
   * THE FAILURE IT WOULD HAVE HAD IS THE WORST SHAPE AVAILABLE. Two overworlds
   * do not misalign; they **MERGE**. Walking the second map would reveal the
   * first and the other way round, into one bitset that `prefsFields` then
   * persists as one `explored` string — and the client MERGES rather than
   * replaces (deliberately: *"a frame that arrived after some walking must not
   * un-see ground the player just crossed"*), so it would never self-correct.
   * A player would simply find their map filling itself in.
   *
   * AND IDENTICAL DIMENSIONS HIDE IT RATHER THAN PREVENT IT. With different
   * sizes the bits scramble and somebody notices in a minute; at the same size
   * it is a clean, silent, persisted lie. Every argument for building a second
   * landmass at 170x100 was therefore an argument for the bug being invisible.
   *
   * SIZED PER REALM rather than from the overworld, so the second key carries
   * its own dimensions and a map of another size is simply another entry.
   */
  const fog = new Map<string, Map<string, Uint8Array>>();

  const fogFor = (actorId: string, realm?: Realm): Uint8Array => {
    const byRealm = fog.get(actorId) ?? new Map<string, Uint8Array>();
    fog.set(actorId, byRealm);
    // ABSENT REALM MEANS THE ONE OVERWORLD, which is what every caller that
    // predates the second key meant and is the only thing it could have meant.
    const home = realm ?? opts.realms?.overworld;
    const key = home?.id ?? OVERWORLD_ID;
    const existing = byRealm.get(key);
    if (existing !== undefined) return existing;
    const level = home?.world.level;
    const made = createFog(level?.w ?? 1, level?.h ?? 1);
    byRealm.set(key, made);
    return made;
  };

  /** Has this character walked anywhere on this map? Drives the `explored` field. */
  const fogSeen = (actorId: string, realmId: string): boolean =>
    fog.get(actorId)?.has(realmId) === true;

  /**
   * Reveal around a body, and answer whether anything was newly seen.
   *
   * The caller uses that to decide whether to mark the save dirty: a party
   * standing still in a town must not write a file on every pump, and standing
   * still is what a party does most.
   */
  const revealFor = (realm: Realm, actorId: string, x: number, y: number): boolean => {
    if (realm.kind !== RealmKind.Overworld) return false;
    const level = realm.world.level;
    return revealDisc(fogFor(actorId, realm), level.w, level.h, x, y);
  };

  /**
   * EVERY PLAYER IN THE PROCESS, NOT EVERY PLAYER ON ONE FLOOR.
   *
   * The loop over realms is not tidiness. `saveNow`/`queueSave` are called from
   * one pump, from a socket closing and from a body being recalled, and each of
   * those hands the persist layer THE list of characters — the port then decides
   * what is dirty. Snapshot one world and the four people who walked into the
   * Underworks stop being written the moment they step through the door, with
   * nothing failing anywhere: their evening reaches disk exactly as far as the
   * last save taken while they were still in Alderbrook.
   *
   * With no registry `pumpTargets()` is the single fallback realm, so this is
   * the same one pass over the same one world it always was.
   */
  const snapshotPlayers = (): CharacterSnapshot[] => {
    const snapshots: CharacterSnapshot[] = [];
    for (const realm of pumpTargets()) {
      snapshots.push(...snapshotRealm(realm));
    }
    return snapshots;
  };

  const snapshotRealm = (realm: PumpTarget): CharacterSnapshot[] => {
    const { world, engine } = realm;
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
        // ═══ PROGRESSION, STRAIGHT OFF THE BODY ═══
        // `level`, `xp` and `unspentPoints` are plain fields on `PlayerActor`
        // precisely so that this pass can read them without asking the talent
        // engine — the save layer knows about actors and not about sheets, and
        // that is the reason those three live on the actor at all.
        //
        // `pendingLevels` is DELIBERATELY NOT HERE. It is scheduler bookkeeping:
        // between a kill and the next base-clock pass it is briefly non-zero,
        // and a save taken in that window would file a point that does not
        // exist yet — which the next load would then reconcile away, silently,
        // as a ledger mismatch.
        level: actor.level,
        xp: actor.xp,
        unspentPoints: actor.unspentPoints,
        // NOT under the `classChoiceOwed` rule below: a purse is not a claim
        // about a class, exactly as a keymap is not.
        money: actor.money,
        // ═══ AND THE RAW SPREAD — BUT NOT WHILE THE CLASS IS PROVISIONAL ═══
        // Same discipline as the class sentinel above, for the same reason and
        // in the same breath. A body whose owner has not answered the chooser
        // is wearing the ROTATION'S four talents; filing their ranks would
        // write a spread against a class nobody picked, and the class field
        // three lines up is simultaneously saying `unassigned`. A file that
        // named no class and four Watchman talents would be internally
        // inconsistent — so the field is omitted and the load path falls back
        // to birth ranks, which is the truth about somebody who has not started.
        ...(classChoiceOwed.has(actor.id)
          ? {}
          : progressionPoints(engine.talentPointsOf?.(actor.id))),
        // ═══ AND THE BAG AND THE DOLL, UNDER THE SAME PROVISIONAL-CLASS RULE ═══
        // Read straight off the body, for the reason engine/actor.ts gives at
        // both fields: this pass cannot reach an equipment engine any more than
        // it can reach the talent one, which is why `carried` and `equipped`
        // live on `PlayerActor` at all.
        //
        // OMITTED ENTIRELY WHILE THE CLASS IS PROVISIONAL, exactly as
        // `talentPoints` is three lines up and for a version of the same reason.
        // A body in `classChoiceOwed` is filed with `classId: UNASSIGNED_CLASS`
        // — the file is saying "nobody has chosen yet" — and a file that named
        // no class and a full seven-piece kit would be internally inconsistent
        // in the one direction that matters: `handleChooseClass` RECOMPOSES the
        // sheet when the answer lands, so gear filed against a character who
        // does not exist yet is gear whose contribution nothing has agreed to.
        //
        // WHAT THAT COSTS, PLAINLY: a verified player who picks something up
        // BEFORE answering the chooser loses it if they reconnect before
        // answering. The window is small by construction — the shipped client's
        // input gates all return early while the picker is up — and the
        // alternative is worse, because the absence is read as `?? binding` and
        // therefore leaves the disk exactly as it found it rather than writing a
        // claim. An ANONYMOUS body is in this set for its whole session and
        // loses nothing at all: it has no binding and no file.
        ...(classChoiceOwed.has(actor.id) ? {} : loadoutFields(actor)),
        // ═══ AND THE KEYS — DELIBERATELY OUTSIDE THE PROVISIONAL-CLASS RULE ═══
        // Every other optional field above is omitted while the owner still owes
        // a class choice, and this one is NOT. That is a decision, not an
        // oversight, and it is worth the four lines.
        //
        // THE RULE THOSE THREE OBEY IS ABOUT INTERNAL CONSISTENCY: a file saying
        // `classId: unassigned` alongside a Watchman's talent spread and a
        // Watchman's kit would be claiming things about a character nobody has
        // agreed to be yet, and `handleChooseClass` RECOMPOSES the sheet when the
        // answer lands. A KEYMAP MAKES NO CLAIM ABOUT A CLASS. It is a fact about
        // a keyboard; it is true before the chooser, during it and after it, and
        // no answer to "which class" can make it inconsistent with anything.
        //
        // AND THE COST OF GETTING IT WRONG RUNS THE OTHER WAY. `loadoutFields`
        // names what its omission costs — a pickup made before answering is lost
        // on a reconnect — and the equivalent here would be worse, because the
        // player most likely to rebind before choosing a class is a NEW player
        // sitting on the very first screen the game shows them. Losing the keys
        // they just set, at that exact moment, is the feature failing on its
        // first use.
        ...prefsFields(actor),
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
   *
   * ═══════════════════════════════════════════════════════════════════════════
   * `realmId` IS LAST AND OPTIONAL, AND OMITTING IT IS THE PRE-REALM BEHAVIOUR
   * ═══════════════════════════════════════════════════════════════════════════
   * Omitted, this goes to EVERY session that has completed `hello` — exactly what
   * it did before realms existed.
   *
   * Passed, it skips every session whose `realmId` differs, INCLUDING the
   * null-vs-named case: a socket still on the default world is not in
   * `realm:underworks:3`, and a frame about a floor you are not standing on is
   * either noise or a leak.
   *
   * ═══ AND NOW EVERY CALL SITE PASSES ONE, THROUGH `audienceFor` ═══
   * That is the narrowing this parameter was added for, and it is on. Nothing
   * calls `broadcast` with a bare `undefined` third argument by accident any
   * more: the pump uses its local `say`, the out-of-pump sites pass
   * `audienceFor(realm.id)`, and `audienceFor` is the ONE place that maps the
   * fallback realm's `''` back to "everybody". So a gateway built with no
   * registry — every test under test/server/ and tools/e2e-m1.mjs — sends
   * byte-for-byte the frames it always sent, through one function rather than
   * through nineteen omitted arguments.
   */
  const broadcast = (msg: BroadcastMsg, exceptConnId?: string, realmId?: string): void => {
    for (const session of sessions.values()) {
      if (!session.helloDone) continue;
      if (session.connId === exceptConnId) continue;
      if (realmId !== undefined && session.realmId !== realmId) continue;
      send(session.socket, msg);
    }
  };

  // -------------------------------------------------------------------------
  // The Bell — the one piece of wall clock in the turn pipeline
  // -------------------------------------------------------------------------

  /**
   * How long THIS realm's stragglers have left, or null if nothing is counting.
   *
   * Every caller names the realm it is asking about, and there is no argument-
   * less form on purpose: "how long has the Bell got" has no answer once there
   * is more than one floor, and a default would silently pick the wrong one.
   */
  const bellRemainingMs = (realmId: string): number | null => {
    const bell = bells.get(realmId);
    return bell === undefined ? null : Math.max(0, bell.deadline - Date.now());
  };

  /**
   * Disarm one realm's Bell. IT CANNOT REACH ANOTHER'S, which is the entire
   * point of the Map — see the block on `bells`.
   */
  const clearBell = (realmId: string): void => {
    const bell = bells.get(realmId);
    if (bell === undefined) return;
    clearTimeout(bell.timer);
    bells.delete(realmId);
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
  const syncBell = (realm: PumpTarget, state: TurnState): void => {
    const wanted = state.bellDurationMs;
    if (wanted === null) {
      clearBell(realm.id);
      return;
    }
    const bell = bells.get(realm.id);
    if (bell !== undefined && bell.gameTurn === state.gameTurn && wanted <= bell.durationMs) return;

    clearBell(realm.id);
    const timer = setTimeout(() => {
      guard('bell timer threw', () => {
        onBellExpired(realm);
      });
    }, wanted);
    // Never let a pending Bell hold the process open at shutdown.
    timer.unref();
    bells.set(realm.id, {
      gameTurn: state.gameTurn,
      durationMs: wanted,
      deadline: Date.now() + wanted,
      timer,
    });
    app.log.info({ realmId: realm.id, gameTurn: state.gameTurn, ms: wanted }, 'bell armed');
  };

  /**
   * ONE REALM'S BELL RANG. Only that realm's stragglers hold.
   *
   * The timer closes over the realm it was armed for, so this can never ring the
   * wrong floor's barrier — which matters because `bellExpired` is the one call
   * that FORCES a decision on somebody who has not made one, and forcing it on a
   * party three rooms away would be the server playing for them.
   */
  const onBellExpired = (realm: PumpTarget): void => {
    const rang = bells.get(realm.id);
    bells.delete(realm.id);
    app.log.info({ realmId: realm.id, gameTurn: rang?.gameTurn }, 'bell rang — stragglers hold');
    try {
      realm.engine.bellExpired();
    } catch (err) {
      app.log.error({ err }, 'engine.bellExpired threw');
      return;
    }
    // ONE REALM'S BELL RANG, so one realm moves. The timer closed over the
    // realm it was armed for precisely so this cannot reach another floor's
    // barrier — pumping all of them would have thrown that away at the last
    // step.
    pumpAndBroadcast(realm);
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
    const { world, engine } = realmFor(session);
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
    const realm = realmFor(session);
    const { world, engine } = realm;
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
      // THIS SOCKET'S OWN FLOOR. The pane draws the countdown the recipient is
      // standing under, and a member who has walked into an instance is counting
      // down under a different Bell entirely.
      bellRemainingMs(realm.id),
      snapshot.invites,
      awayMembers(viewer, realm, snapshot.members),
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
   * ═════════════════════════════════════════════════════════════════════════
   * WHICH OF YOUR PARTY ARE SOMEWHERE ELSE, AND CAN YOU GET TO THEM.
   * ═════════════════════════════════════════════════════════════════════════
   *
   * THE BUG THIS EXISTS TO FIX, stated plainly: `projectPartyState` walked one
   * world and skipped any member it could not find, so the instant somebody
   * walked into a breach their row vanished from everyone else's party pane.
   * From the chair that is indistinguishable from being thrown out of the party
   * when a fight starts, and it was reported as exactly that. The party table
   * was never touched — two projections were simply per-realm.
   *
   * ONLY THE GATEWAY CAN ANSWER THIS. src/server/view/** may not reach the
   * realm registry, exactly as it may not read a clock, so the answer arrives
   * already made — the same shape as `bellMs` and `speaking`.
   *
   * `canFollow` IS PER VIEWER, which is why this takes one. A body that is
   * Downed cannot walk through a door, and offering a control whose only
   * possible outcome is a refusal is worse than not offering it.
   */
  const awayMembers = (
    viewer: Actor,
    // STRUCTURAL, not `Realm`: the caller holds a `PumpTarget`, and the only
    // two things this needs are which realm it is and whose bodies are in it.
    here: { readonly id: string; readonly world: World },
    members: readonly string[],
  ): ReadonlyMap<string, AwayMember> => {
    const realms = opts.realms;
    const out = new Map<string, AwayMember>();
    if (realms === undefined) return out;

    // Can the VIEWER travel at all? Asked once rather than per member.
    // A body that is Downed or dead cannot walk through a door. `opts.downed`
    // is the same survival table the engine mutates, so this is the live answer
    // rather than a copy that can lag a pump behind it.
    const able = viewer.alive && (opts.downed === undefined || !isDowned(opts.downed, viewer.id));

    for (const id of members) {
      if (id === viewer.id) continue;
      if (here.world.getActor(id) !== undefined) continue;
      const theirs = realms.realmOf(id);
      // No realm at all is somebody who has genuinely left the game. Their row
      // SHOULD disappear — a party row naming a person who is not playing is
      // the opposite mistake, and the old code was right about that case.
      if (theirs === undefined || theirs.id === here.id) continue;
      const body = theirs.world.getActor(id);
      if (body === undefined) continue;
      out.set(id, { actor: body, place: theirs.name, canFollow: able });
    }
    return out;
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
  const broadcastTurnIfChanged = (realm: PumpTarget, state: TurnState): void => {
    const key = turnKey(state, bells.has(realm.id));
    if (key === lastTurnKeys.get(realm.id)) return;
    lastTurnKeys.set(realm.id, key);

    const bellMs = bellRemainingMs(realm.id);
    for (const session of sessions.values()) {
      if (!session.helloDone) continue;
      // THE PEOPLE ON THIS FLOOR. `sendTurn` rebuilds the frame against the
      // recipient's own body and party, and a socket standing somewhere else has
      // neither in this world — it would be sent nothing, silently, on every
      // pump. Skipping explicitly says so, and costs one comparison.
      if (realmFor(session).id !== realm.id) continue;
      sendTurn(session, state, bellMs);
    }
  };

  // -------------------------------------------------------------------------
  // The hotbar — THREE FRAMES THAT ARE NEVER BROADCAST
  // -------------------------------------------------------------------------

  /**
   * The viewer's own loadout, unicast. RE-SENDABLE, AND RE-SENT.
   *
   * This used to read "sent once, at `welcome`, because M3 loadouts are FIXED
   * (zero trees, zero talent points)". The talent points landed and that is no
   * longer true of the CALL SITES, though it was never true of the function:
   * `sendLoadout` has never carried a once-guard, which is exactly what
   * `LoadoutMsg`'s own doc anticipated ("re-sendable at the milestone that
   * brings talent points"). It is now called from three places — `welcome`,
   * `handleChooseClass` and `handleSpendPoint` — and each time the client
   * replaces its hotbar wholesale, which is why the frame carries the whole
   * list rather than a slot delta.
   *
   * WHAT MAKES THE RESEND MANDATORY rather than tidy: three of the fields are
   * PER-ACTOR AND PER-RANK. `range` is resolved at the caster's own talent level
   * from v9 (Fog Step is 3 tiles at rank 1 and 7 at rank 5), and `desc` /
   * `descNext` are the current->next diff. All three are stale the instant a
   * point is spent, and a stale `range` is the one that misleads a player into
   * clicking a tile the server would have accepted.
   */
  const sendLoadout = (session: Session): void => {
    const { world, engine } = realmFor(session);
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
    const { world, engine } = realmFor(session);
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
      // ═══ THE POOL IS QUANTISED TO WHAT A CLIENT CAN DRAW ═══
      // `Math.floor`, not the raw float, and without it this whole memo is dead
      // for two of the three classes. Resolve and Focus now trickle 0.6 and 0.4
      // per BASE TURN (engine/talents.ts's `RESOURCE_RULES`), so a Watchman
      // standing still in an empty corridor changes `current` on every single
      // turn — the key never matched, and both frames went out every turn with a
      // cooldown block that was byte-identical and a pool difference no surface
      // can show. The key string carried the float in full, e.g.
      // `resolve:24.599999999999998/100`.
      //
      // FLOORING IS SAFE FOR THE GATE AS WELL AS FOR THE DISPLAY. The pip strip
      // floors, the character sheet floors, and every talent cost is an integer —
      // so `floor(current) >= cost` and `current >= cost` answer the same thing,
      // and a client is never left thinking it can pay for something the server
      // will refuse. What it stops being told about is the fraction, which is
      // exactly the part nothing can render.
      resource === null
        ? '-'
        : `${resource.resource.kind}:${Math.floor(resource.resource.current)}/${resource.resource.max}` +
          // ═══ AP IS PART OF THE KEY OR THE ROW NEVER MOVES ═══
          // This memo is what suppresses a duplicate `resource` frame, so a
          // field that is not in the key is a field the client is never told
          // changed. AP is spent and refilled every single turn; leaving it out
          // would ship the pip row and leave it frozen at whatever it happened
          // to hold the first time somebody's class resource moved.
          `|ap:${String(resource.resource.ap ?? -1)}/${String(resource.resource.maxAp ?? -1)}`,
    ].join('|');
    if (key === session.viewerKey) return;
    session.viewerKey = key;

    send(session.socket, cooldowns);
    if (resource !== null) send(session.socket, resource);
  };

  /**
   * ═════════════════════════════════════════════════════════════════════════
   * THE VIEWER'S OWN LEVEL, XP AND POINTS IN HAND. UNICAST, NEVER BROADCAST.
   * ═════════════════════════════════════════════════════════════════════════
   *
   * UNICAST IS STRUCTURAL, not etiquette: `ProgressMsg` is a `ViewerMsg`, so
   * `broadcast(progress)` does not compile — `BroadcastMsg` is `Exclude`-derived
   * from `ServerMsg`. protocol.ts argues the reason at length and it is the same
   * one that made cooldowns private: an UNSPENT POINT IS INTENT. "Ren is holding
   * a point back" is a decision she has not made yet, and a HUD that showed it
   * to the party would turn a private judgement into four people telling her
   * what to buy.
   *
   * ═══ WHY IT IS BUILT HERE AND NOT IN view/projector.ts ═══
   * Every other viewer-private frame is projected. This one is three fields off
   * `PlayerActor` plus one call to `expChart`, and the projector may not read a
   * clock or a curve — it is the layer that decides what a viewer may KNOW, and
   * there is nothing to decide here: all four numbers are the viewer's own.
   *
   * ═══ `pendingLevels` IS DELIBERATELY NOT ON IT ═══
   * Between a kill and the next base-clock pass it is briefly non-zero
   * (engine/actor.ts). A panel drawing it would flicker a `+` for a point that
   * does not exist yet and cannot be spent — and the spend handler would refuse
   * it, which is the worst possible pairing.
   *
   * @returns whether a frame actually went out. Silent for a socket with no
   *   body and for a monster, which cannot be a viewer anyway.
   */
  const sendProgress = (session: Session): boolean => {
    const { world } = realmFor(session);
    const actorId = session.actorId;
    if (actorId === null) return false;
    const viewer = world.getActor(actorId);
    if (viewer === undefined || viewer.kind !== 'player') return false;

    // ═══ THE DENOMINATOR, AND THE CAP IS WHY IT TRAVELS AT ALL ═══
    // Below the ceiling it is `expChart(level + 1)` — the very threshold
    // `gainExp` compares against, so the bar fills exactly as the level does.
    // AT THE CEILING THERE IS NO NEXT LEVEL and `xp` goes on accumulating
    // (`gainExp` stops looping and keeps the remainder), so any positive
    // denominator would draw a bar creeping towards a level that is never
    // coming. ZERO IS THE SENTINEL for "there is no next" — the same shape
    // `LoadoutTalent.descNext: null` uses, a fact the renderer must handle
    // rather than a number it can divide by and be quietly wrong.
    const atCap = viewer.level >= MAX_CHARACTER_LEVEL;
    send(session.socket, {
      v: PROTOCOL_VERSION,
      t: 'progress',
      level: viewer.level,
      xp: viewer.xp,
      xpToNext: atCap ? 0 : expChart(viewer.level + 1),
      unspent: viewer.unspentPoints,
    });
    session.progressKey = `${viewer.level}|${viewer.xp}|${viewer.unspentPoints}`;
    return true;
  };

  /**
   * The same frame, ON CHANGE, for the pump loop.
   *
   * "On change" is a bandwidth nicety and nothing more — but it is not nothing:
   * `xp` moves on every kill and `level`/`unspent` a handful of times an
   * evening, so without the memo this would be a frame per socket per pump
   * saying what the client already believes.
   */
  const sendProgressIfChanged = (session: Session): void => {
    const { world } = realmFor(session);
    const actorId = session.actorId;
    if (actorId === null) return;
    const viewer = world.getActor(actorId);
    if (viewer === undefined || viewer.kind !== 'player') return;
    const key = `${viewer.level}|${viewer.xp}|${viewer.unspentPoints}`;
    if (key === session.progressKey) return;
    sendProgress(session);
  };

  /**
   * Every attended body's own viewer-private frames, one socket at a time.
   *
   * The hotbar and the party pane travel together because both are memoised
   * per socket and both are cheap when nothing VISIBLY moved — and because the
   * one thing that must never happen is a loop that walks the session list twice
   * and gets a different answer the second time, which is what two separate
   * passes over a mutating actor table would eventually produce.
   *
   * "VISIBLY" IS DOING REAL WORK IN THAT SENTENCE NOW. Resolve and Focus trickle
   * every base turn, so the underlying float moves constantly for two of the
   * three classes; `sendHotbarIfChanged` quantises the pool into its memo key so
   * the frame goes out when the DISPLAYED number changes rather than when the
   * float does. Without that the suppression is dead and four attended sockets
   * sitting still push eight frames a turn for ever.
   */
  const refreshViewers = (realm: PumpTarget): void => {
    for (const session of sessions.values()) {
      if (!session.helloDone) continue;
      // ONLY THE SOCKETS THIS PUMP WAS ABOUT. Every one of the four frames below
      // is memoised per socket and would send nothing for a viewer whose realm
      // did not move — so this is a cost saving rather than a correctness one,
      // and it is still worth stating: with N realms the unfiltered loop is N
      // passes over every socket in the process on every pump.
      if (realmFor(session).id !== realm.id) continue;
      sendHotbarIfChanged(session);
      sendPartyStateIfChanged(session);
      // THE THIRD MEMOISED VIEWER FRAME, and it rides this loop for the same
      // reason the party pane does: xp and points move under a pump that had
      // nothing to do with the viewer — somebody else landed the killing blow,
      // and `awardExperience` pays the whole party. Without this a level-up
      // reaches nobody's panel until they spend a point, which they cannot,
      // because the panel still says they have none.
      sendProgressIfChanged(session);
      // THE FOURTH MEMOISED VIEWER FRAME, and it rides this loop for the same
      // reason: a bag changes under a pump the viewer did not cause. A restore
      // at join fills one before the first frame goes out, and the day something
      // takes an item off a player it will do so mid-sweep. Cheap when nothing
      // moved — one JSON of two small values and a string compare.
      sendInventoryIfChanged(session);
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
   *
   * ═══════════════════════════════════════════════════════════════════════════
   * ONE REALM'S WORTH OF THAT. `pumpAndBroadcast` DOES ALL OF THEM.
   * ═══════════════════════════════════════════════════════════════════════════
   * The body below is the function this used to be, with two substitutions:
   * `world`/`engine` are the REALM'S (shadowing the plugin-wide pair for the
   * length of this function, exactly as every handler already shadows them via
   * `realmFor`), and every broadcast goes through `say`, which narrows the
   * audience to the sockets standing here.
   *
   * A THROW STILL COSTS ONE REALM ITS TICK AND NOT THE PROCESS. The catch is
   * inside this function rather than around the loop for that reason: an
   * invariant failing in one party's instance must not stop the city.
   */
  /**
   * How many times the overworld has pumped. Drives the roamers' cadence and
   * their ids, so a wanderer's identity does not depend on wall-clock time.
   */
  let roamerSeq = 0;

  /**
   * ═════════════════════════════════════════════════════════════════════════
   * THE ROOM GOES QUIET. THE ONE MOMENT A DELVE HAS TO OFFER AND IT HAD NONE.
   * ═════════════════════════════════════════════════════════════════════════
   *
   * A party walked thirty tiles to the Hollow Mine, fought eight husks, killed
   * the last one — and nothing happened. No line, no mark, nothing to tell them
   * they were finished except counting bodies themselves. Content without a
   * completion beat is a chore with a health bar: the fight ends, and the only
   * way to know is that nothing is hitting you.
   *
   * ═══ IT NAMES WHAT IS STILL ON THE FLOOR, WHICH IS THE USEFUL HALF ═══
   * `populateDelve` scatters litter as well as bodies, so "cleared" and
   * "emptied" are different states and a party that leaves at the first one
   * walks away from the second. The line says how much is left rather than
   * where, because a list of coordinates is a chore list and a number is a
   * reason to look around.
   *
   * ═══ ONCE, AND ONLY IN A DELVE ═══
   * The overworld's engagement drops to zero constantly — every time a roamer
   * loses interest — and announcing that would be the movement-spam bug again
   * in a better costume. A town has nothing to clear. So: Inner realms only,
   * and a `Set` keyed by realm id, cleared with the rest of the realm's memos
   * when it is reaped.
   */
  const announceCleared = (realm: PumpTarget, result: PumpResult): void => {
    /**
     * A MONSTER DIED IN THIS PUMP — not merely "something died".
     *
     * The third wrong version of this guard passed `some(e => e.k === 'death')`,
     * which is true when the PLAYER dies. So a solo player being killed by the
     * last husk standing satisfied "a death happened", the reset emptied the
     * room, and the breach announced itself quiet over their corpse. Four runs
     * out of four.
     *
     * The victim is checked against the bodies in the room rather than a kind
     * flag on the event, because by the time this runs the dead thing may
     * already have been reaped.
     */
    const players = new Set(
      realm.world
        .allActors()
        .filter((a) => a.kind === ActorKind.Player)
        .map((a) => a.id),
    );
    const sawKill = [...result.playerEvents, ...result.sweep].some(
      (event) => event.k === 'death' && !players.has(event.id),
    );
    if (clearedRealms.has(realm.id)) return;
    const full = opts.realms?.get(realm.id);
    if (full === undefined || full.kind !== RealmKind.Inner) return;

    // NOBODY LEFT STANDING. `alive` rather than presence: a corpse is still an
    // actor for the rest of the pump it died in.
    const standing = realm.world
      .allActors()
      .filter((a) => a.kind === ActorKind.Monster && a.alive).length;

    // ═══ AN EDGE, NOT A LEVEL, AND IT MUST HAVE BEEN A KILL ═══
    // Many, then none — and the pump that emptied the room contained a DEATH.
    //
    // Both guards were arrived at the expensive way, and the second only after
    // instrumenting the server:
    //
    //     realmId: realm:site:encounter:1  previous: 3  standing: 0
    //     standingPlayers: 1  actors: ["player:...:alive=true"]
    //
    // A wiped party's floor is RESET: `resetFloor` reaps every monster and the
    // erased player is restored. So "many, then none, with somebody standing"
    // is exactly as true of losing as of winning, and the room announced
    // itself quiet in the middle of a defeat. The only thing that tells the two
    // apart is whether anything actually died.
    const previous = residentCounts.get(realm.id) ?? 0;
    residentCounts.set(realm.id, standing);

    /**
     * AND SOMEBODY IS STILL STANDING, which is the other half of the same
     * mistake. A wipe empties the room too — `resetFloor` reaps every monster
     * before re-seeding — so "many, then none" is ALSO true of a party that
     * just lost. The difference between clearing a room and being carried out
     * of it is whether anybody is on their feet.
     *
     * ALIVE AND NOT DOWNED: a body on the floor is a body being counted on,
     * not a witness, and telling a downed player their delve is quiet while
     * they bleed out is the worst line in the game.
     */
    const standingPlayers = realm.world
      .allActors()
      .filter(
        (a) =>
          a.kind === ActorKind.Player &&
          a.alive &&
          (opts.downed === undefined || !isDowned(opts.downed, a.id)),
      ).length;

    // THE DECISION IS world/cleared.ts's, not this function's — see there for
    // the three wrong versions this replaced.
    if (
      !shouldAnnounceCleared({
        previous,
        standing,
        sawMonsterKill: sawKill,
        standingPlayers,
        already: false,
      })
    ) {
      return;
    }

    clearedRealms.add(realm.id);
    const loot = realm.world.groundItems().length;
    broadcastRecordLine(realm, `${full.name} is quiet now.`);

    /**
     * ═════════════════════════════════════════════════════════════════════
     * AND THE MOOR HEARS ABOUT IT. THE ONLY SIGN THAT ANYBODY ELSE IS
     * PLAYING.
     * ═════════════════════════════════════════════════════════════════════
     *
     * An instance is private by construction — that is the whole point of
     * instancing — so everything interesting that happens in this game
     * happens somewhere nobody else can see. On a shared overworld with five
     * friends spread across it, the result is five people playing five
     * single-player games in the same window.
     *
     * One line, on the overworld, when a party finishes a delve. It is the
     * cheapest possible version of a world that feels inhabited, and it uses
     * the one event that is genuinely worth interrupting somebody for.
     *
     * ═══ WHY THIS CANNOT BECOME SPAM, WHICH IS THE OBVIOUS OBJECTION ═══
     * It fires ONCE PER REALM, on an event that takes a party several minutes
     * of fighting to produce, and `clearedRealms` makes a second one
     * impossible. Compare the movement lines this log used to carry: those
     * fired per STEP, per player. A delve clear is rarer than a level-up and
     * considerably rarer than a death.
     *
     * NAMED BY THE PARTY, not by the room, because "somebody cleared the
     * Underworks" is a fact about people. The first name is enough — a roster
     * of six in a log line is a list, and the pane already answers who is with
     * whom.
     */
    const overworld = opts.realms?.overworld;
    if (overworld !== undefined && overworld.id !== realm.id) {
      const first = realm.world.allActors().find((a) => a.kind === ActorKind.Player);
      const who = first === undefined ? 'Somebody' : nameOf(first.id);
      const others = standingPlayers - 1;
      const party =
        others <= 0
          ? who
          : others === 1
            ? `${who} and one other`
            : `${who} and ${String(others)} others`;
      broadcastRecordLine(overworld, `Word from the moor: ${party} cleared ${full.name}.`);
    }
    if (loot > 0) {
      broadcastRecordLine(
        realm,
        loot === 1
          ? 'Something is still on the floor.'
          : `${String(loot)} things are still on the floor.`,
      );
    }
  };

  const pumpRealm = (realm: PumpTarget): void => {
    const { world, engine } = realm;

    /**
     * THE ROAMERS WANDER HERE, before anything is broadcast, so a frame sent
     * below already describes where they are.
     *
     * Only the overworld has any (see world/roamers.ts), so this is a Map size
     * check on every other realm. When the picture changes, the people standing
     * in that realm get a fresh `realm` frame — which is heavier than a
     * dedicated frame would be, and is the right trade at this size: markers
     * already ride on `realm`, so this costs no new message type, no new
     * renderer path, and no second way for a marker to be wrong. If the level
     * payload ever hurts, the fix is a `sites` frame, not a second marker
     * system.
     */
    const full = opts.realms?.get(realm.id);
    if (full !== undefined && full.kind === RealmKind.Overworld) {
      roamerSeq += 1;
      if (tickRoamers(full, roamerSeq)) {
        for (const session of sessions.values()) {
          if (session.helloDone && session.realmId === full.id) sendSites(session);
        }
      }
    }
    /**
     * TO THE PEOPLE STANDING HERE, and to nobody else.
     *
     * `broadcast`'s realm argument is a filter over sessions; `audienceFor` maps
     * the fallback realm's `''` back to `undefined`, which is "everybody". So a
     * gateway with no registry emits byte-for-byte the frames it always did,
     * and this one line is the whole of the difference between the two.
     */
    const say = (msg: BroadcastMsg, exceptConnId?: string): void => {
      broadcast(msg, exceptConnId, audienceFor(realm.id));
    };

    let result: PumpResult;
    try {
      result = engine.pump();
    } catch (err) {
      app.log.error({ err, realmId: realm.id }, 'turn pump threw — the world did not advance');
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
      if (msg !== null) say(msg);
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
      say({
        v: PROTOCOL_VERSION,
        t: 'sweep',
        gameTurn: result.turn.gameTurn,
        events: [...result.sweep],
      });
    }

    // THE RECORD LANE, after the events it narrates and before the snapshots.
    // One batch for the whole pump — see `broadcastRecord`. It is silent on an
    // idle pump, so a client spamming frames cannot farm log traffic either.
    broadcastRecord(realm, result);

    /**
     * ═════════════════════════════════════════════════════════════════════
     * AND THEN THE ROOM GOES QUIET — AFTER the narration, never before it.
     * ═════════════════════════════════════════════════════════════════════
     *
     * This used to sit immediately after `engine.pump()`, reasoning that the
     * body which just fell was already dead by then and the count was therefore
     * the right one. THAT PART WAS TRUE AND IT WAS NOT THE WHOLE QUESTION.
     * `announceCleared` broadcasts a Record line of its own, at once; the pump's
     * own lines are batched and go out at `broadcastRecord` above. So the
     * completion beat overtook the blow that caused it, every single time:
     *
     *     12 damage. Index Husk 3/25.
     *     Index Husk hits Player 1.
     *     An Index Breach is quiet now.        <- the conclusion...
     *     2 damage. Index Husk 0/25.
     *     Index Husk is unfiled.               <- ...above its own cause
     *
     * Read in order, that says the room fell silent while something was still
     * hitting you, and it is deterministic — it reproduced identically on three
     * consecutive runs. No test caught it because no test reads FRAME ORDER over
     * a socket; `tools/status-live.mjs` does, and this is what it was for.
     *
     * THE COUNT IS UNCHANGED BY THE MOVE. Nothing between the pump and here
     * kills, revives or reaps anything — the reap window is deliberately BELOW
     * this line, and its own contract note says why (`broadcastRecord` must have
     * run first). So the guard sees exactly what it saw before; only the frame
     * that carries the answer has stopped arriving early.
     */
    announceCleared(realm, result);

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
      say({ v: PROTOCOL_VERSION, t: 'left', id });
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
      say({ v: PROTOCOL_VERSION, t: 'state', actors: projectActors(world) });
      // ═══ AND THE SKY WITH IT — `state` CARRIES NO ORB ═══
      // The resync above is the "the client's board may be out of step" hammer,
      // and it swings over `ActorView` alone. An orb is not an actor, so a
      // player being restored to their feet beside a shot that is still in the
      // air would be handed a corrected board and an uncorrected sky. It rides
      // the same event for the same few-KB-once reason, it is silent when
      // nothing is flying, and it updates the memo so the snapshot band below
      // does not say the same thing twice in one pump.
      sendProjectilesIfAny(realm);
    }

    syncBell(realm, result.turn);
    broadcastTurnIfChanged(realm, result.turn);

    // THE TWO SNAPSHOTS, AFTER the events that caused them and BEFORE the
    // hotbars. Order is not cosmetic: a client that saw `downed` in a sweep and
    // then the party row is told the same thing twice in the right sequence,
    // whereas the reverse order shows a countdown for a body the playback has
    // not knocked over yet.
    //
    // Both are complete and both are memoised, so the common turn — somebody
    // walked, nothing landed on anybody — costs two `JSON.stringify` calls over
    // a handful of small objects and sends nothing.
    broadcastEffectsIfChanged(realm);
    broadcastPartyIfChanged(realm, Date.now());
    // THE THIRD SNAPSHOT, and the only one whose subject moved during the pump
    // rather than because of it. It goes out AFTER the `sweep` above for the
    // same reason the other two do: the frame that says an orb is gone must
    // follow the `attack` step that says what it hit, or a client draws the
    // impact against a sky that has already been cleared.
    broadcastProjectilesIfChanged(realm);
    // THE FOURTH SNAPSHOT, and it moves for reasons that are not all verbs. A
    // pickup and a drop change it directly, a monster dying SPILLS onto it
    // inside this pump, and a party wipe clears the whole table
    // (turn-engine.ts:536). Only a memo in the pump sees all four; a push wired
    // into the two loot verbs would be silently blind to the other two, and the
    // symptom would be a corpse's drop nobody can see. See
    // `broadcastGroundIfChanged`.
    broadcastGroundIfChanged(realm);

    // Unicast, and each socket learns only about its own. This is deliberately
    // unconditional rather than gated on "did a talent happen": `actBase` ticks
    // cooldowns once per game turn whatever anyone did, so the hotbar goes stale
    // on a turn in which the viewer only walked. The per-session memo makes the
    // common case — nothing changed — cost one string compare.
    //
    // THE PARTY PANE RIDES THE SAME LOOP, for a different reason: a member's hp
    // and their presence change under a pump that had nothing to do with the
    // party at all, and `handleParty`'s targeted push cannot see those.
    refreshViewers(realm);

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
      // `death` is the reason the store names for this path; a level gained
      // rides it rather than inventing a second reason string, because the
      // store's `SaveReason` union is closed and the two mean the same thing to
      // the file — "write this now, do not wait for the window".
      saveNow('death');
    } else if (result.playerEvents.length > 0 || result.sweep.length > 0) {
      queueSave('pump');
    }
  };

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * ADVANCE EVERY PLACE THERE IS. THE ONLY WAY THE WORLD MOVES.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * ZERO ARGUMENTS, AND DELIBERATELY SO. Roughly ten call sites reach this — a
   * move, a talent, a commit, a hold, a party command, a respawn, four loot
   * verbs, a Bell, a recall, a socket closing — and not one of them knows or
   * should know how many floors exist. "The frame I just accepted may have
   * unblocked somebody" is a statement about the process, not about a map.
   *
   * ═══ WHY EVERY REALM AND NOT JUST THE SENDER'S ═══
   * Pumping only the realm the frame arrived on would freeze every other floor
   * between two of its own players' keystrokes, and the barrier is the thing
   * that makes that visible: a party in an instance parked on a Bell needs a
   * pump to notice the Bell rang, and their own timer already provides one — but
   * a monster's turn on a floor whose players are all Standing By would never
   * resolve. An idle pump is a documented fixed point (`PumpResult.status ===
   * 'idle'` — nothing gained energy, nothing spent any, no clock advanced), so
   * the cost of the realms nobody is in is a function call and a comparison.
   *
   * The overwhelmingly common shape today is ONE realm — the fallback — which is
   * exactly the loop this function used to be without one.
   */
  /**
   * ═════════════════════════════════════════════════════════════════════════
   * ONE REALM WHEN THE CALLER KNOWS WHICH, EVERY REALM WHEN IT GENUINELY
   * DOES NOT.
   * ═════════════════════════════════════════════════════════════════════════
   *
   * THE MEASUREMENT THAT FORCED THIS. Every player action used to pump every
   * realm in the process. With 24 players on one map and six realms open, one
   * round of everybody acting cost about 57 ms of pure projection — six times
   * what it needed to, because five of those realms had not changed and their
   * frames were rebuilt, stringified and thrown away. It grows with the number
   * of OPEN INSTANCES, which is exactly the number that grows on a busy
   * evening: five parties in five breaches and the cost is quadratic in the
   * wrong place.
   *
   * WHY ONE REALM IS ENOUGH FOR AN ACTION. This is a turn-based game and a
   * realm advances when somebody standing in it acts. Liveness for a realm
   * nobody is acting in does not come from other people's keystrokes — it comes
   * from that realm's OWN Bell timer, which closes over the realm it was armed
   * for, and from the reap timers. Neither ever needed this loop.
   *
   * THE OPTIONAL ARGUMENT DEGRADES SAFELY, which is why it is optional rather
   * than required: forgetting it pumps everything, which is what the code did
   * for its whole life and is merely slower. A required argument would make the
   * cheap mistake a wrong realm instead of a slow one.
   *
   * THREE CALLERS STILL PASS NOTHING, ON PURPOSE — `handleParty`, `handleRevive`
   * / `handleRespawn`'s quorum changes, and the socket-close handler. A party
   * can now span realms (see `follow`), so changing its shape changes a barrier
   * in every realm holding a member, and none of the three is a per-keystroke
   * verb.
   */
  const pumpAndBroadcast = (only?: PumpTarget): void => {
    if (only !== undefined) {
      pumpRealm(only);
      return;
    }
    for (const realm of pumpTargets()) pumpRealm(realm);
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
    // WHEREVER THE BODY ACTUALLY IS. The socket that owned it closed ten minutes
    // ago, so there is nothing to ask but the registry — and a player who
    // dropped inside an instance must be removed from THAT world, not from the
    // one their session happened to start in. See `homeOf`.
    const home = homeOf(actorId);
    // THE REALM ITSELF, resolved WHILE THE BODY IS STILL IN IT. `homeOf` answers
    // a `PumpTarget`, which is deliberately the three fields a pump needs and
    // not a realm — but the reaper needs `kind` and `lingerMs`, and after
    // `removePlayer` below there is no body left to resolve a realm from.
    const homeRealm = opts.realms?.get(home.id);
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
      home.engine.leave(actorId);
    } catch (err) {
      app.log.error({ err, actorId }, 'engine.leave threw during recall');
    }
    home.world.removePlayer(actorId);
    broadcast({ v: PROTOCOL_VERSION, t: 'left', id: actorId }, undefined, audienceFor(home.id));
    app.log.info({ actorId, realmId: home.id }, 'reconnect grace expired — body recalled');
    /**
     * AND THE INSTANCE THEY DROPPED IN MAY NOW BE EMPTY — see the long note in
     * `crossIntoRealm`, which is the other half of this same gap.
     *
     * THIS PATH IS THE LAST CHANCE THERE IS. The only occupant's session is gone
     * and nothing will ever visit that realm again, so a reap not armed here is
     * never armed at all: the realm, its world, its monsters and its six memo
     * rows live for the lifetime of the process. `forgetRealmMemos` calls that
     * shape *"small, unbounded, and exactly the kind of leak nobody finds
     * because nothing ever breaks"*.
     */
    if (homeRealm !== undefined) reapIfEmpty(homeRealm);
    // GUARDED, because the reap may just have closed it.
    if (opts.realms === undefined || opts.realms.get(home.id) !== undefined) {
      pumpAndBroadcast(home);
    }
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
   *
   * ═══════════════════════════════════════════════════════════════════════════
   * PROGRESSION IS NOT RESTORED HERE, AND THE SPLIT IS THE WHOLE REASON.
   * ═══════════════════════════════════════════════════════════════════════════
   * This function runs inside `resolveActor`, i.e. BEFORE the class sheet is
   * attached — which is right for hp (a classless body's `maxHp` of 60 would
   * file a restored Watchman's 70 down) and for cooldowns (they live on the
   * body). It is WRONG for the raw talent spread: `attachClass` ends in an
   * unconditional `sheets.set` (engine/talents.ts:872-875), so points written
   * onto a sheet before the class lands are replaced by four birth ranks without
   * a word — nothing throws, nothing logs, and the loss is invisible until
   * somebody notices their Fog Step is three tiles again.
   *
   * So level, xp, points-in-hand and the spread are `restoreProgression`, called
   * from `handleHello` immediately AFTER `engine.attachClass`. See there.
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
   * LEVEL, XP AND THE RAW TALENT SPREAD, ONTO THE BODY AND ONTO THE SHEET.
   * ═════════════════════════════════════════════════════════════════════════
   *
   * CALLED FROM `handleHello`, IMMEDIATELY AFTER `engine.attachClass`, AND
   * NOWHERE ELSE. Not from `applyRestore`, which runs a beat too early — see
   * the split argued there.
   *
   * ONE STEP RATHER THAN TWO, and that is not tidiness: a half-restore — the
   * level set, the raw points not — is the exact state `unspentPoints` cannot be
   * reconciled from, because the ledger would credit a level-8 character with
   * every point they had already spent. `PlayerInit` deliberately carries no
   * entries for these four for the same reason (engine/actor.ts).
   *
   * ═══ `unspentPoints` IS A CACHE AND IT IS RECOMPUTED, NEVER TRUSTED ═══
   * The ledger is `totalPointsAtLevel(level)` minus every raw point SPENT, and
   * "spent" is `raw - 1` per talent, because the first rank of each of the four
   * is the birth grant and was never paid for. Deriving it rather than believing
   * the file is what makes a future retune of `pointsForLevel` correct every
   * existing character instead of stranding them.
   *
   * ═══ AND IT IS ALSO THE `refundPool` docs/data-schemas.md § 1 REQUIRES ═══
   * *"If a talent id disappears, the load path moves its points to a
   * `refundPool` and logs it rather than throwing. Friends' saves must outlive
   * your content edits."* A vanished id never lands on the sheet, so it is never
   * counted as spent, so the ledger hands its points straight back as unspent —
   * no pool object and no second arithmetic. The log line below is the other
   * half of what that paragraph asks for.
   */
  /**
   * One string off a character file, narrowed to a real slot, or undefined.
   *
   * `CharacterRestore.equipped` is `Record<string, string>` — the file's keys are
   * whatever was written, and a build that renamed a slot leaves a key this one
   * has never heard of. `SLOT_ORDER` is the whole of `Slot`
   * (protocol.ts's `_MissingFromSlotOrder` proves it at compile time on the wire
   * side and content/items.ts is the server's own copy), so membership in it is
   * a sound narrowing rather than a cast.
   */
  const asSlot = (key: string): Slot | undefined =>
    SLOT_ORDER.find((candidate) => candidate === key);

  /**
   * ═════════════════════════════════════════════════════════════════════════
   * THE BAG AND THE PAPER DOLL, ONTO THE BODY, AND THEN THE SHEET RECOMPOSED.
   * ═════════════════════════════════════════════════════════════════════════
   *
   * CALLED FROM `restoreProgression`, WHICH RUNS AFTER `engine.attachClass`, AND
   * THAT ORDERING IS LOAD-BEARING FOR A DIFFERENT REASON THAN THE TALENT ONE.
   * `attachClass` does not touch `baseCombat` — `world.addPlayer(overlay)`
   * already set it — but `handleChooseClass` DOES, through
   * `reclothePlayer`, which writes the baseline and recomposes. Restoring gear
   * before the class is settled would compose a sheet against a baseline that is
   * about to be replaced, and the replacement runs its own recompose, so the
   * result would be right by accident. Doing it after means one composition,
   * from the baseline the body will actually keep.
   *
   * ═══ WATCH `applyRestore`'S HP CLAMP, WHICH RUNS EARLIER AND CANNOT MOVE ═══
   * `applyRestore` does `Math.min(actor.maxHp, …)` while the body is still wearing
   * nothing. NO ITEM IN THIS CATALOGUE CONTRIBUTES `maxHp` — `AdditiveMods` is
   * `CombatMods` and hp is not one of its fields, so an item cannot raise a
   * ceiling even by accident — which is the only reason that clamp is safe where
   * it is. THE DAY ONE DOES, that clamp runs against the BARE-CLASS ceiling and
   * silently shaves hit points off a geared character on every single load, with
   * nothing failing anywhere. The fix would be to move the clamp below this call,
   * not to fix it up afterwards.
   *
   * ═══ REPAIR, NEVER REJECT — AND RE-CHECKED EVEN THOUGH THE BRIDGE CHECKED ═══
   * persist/saves.ts's `parseCarried` and `parseEquipped` already drop unknown
   * ids, wrong-slot entries and duplicates, and record each in `problems`. This
   * re-checks anyway and cheaply, because `PersistPort` is an INTERFACE: a test
   * double, the e2e harness or a future store may hand back anything, and a
   * gateway that trusted it would put an id the catalogue has never heard of
   * onto a live body — where `wornOf` would skip it in the fold while
   * `projectInventory` drew it in the panel, so the two would disagree about what
   * a character is wearing.
   *
   * ═══ THE CAP APPLIES ON THE WAY IN TOO ═══
   * A file written by a build with a larger `INVENTORY_CAP` would otherwise put
   * a body over the limit that `handleUnequip` then tests against, and the player
   * would find they could take a coat off exactly never. The overflow is dropped
   * and logged rather than refused; a character file must never be the reason
   * somebody cannot play tonight.
   */
  const restoreLoadout = (actor: Actor, restore: CharacterRestore): void => {
    // A monster has no file and no inventory. Narrowed rather than asserted, for
    // the same reason `restoreProgression` narrows.
    if (actor.kind !== 'player') return;
    // ABSENT MEANS "THIS PORT CANNOT SAY", so the body keeps whatever it has —
    // which for a fresh body is nothing. It must never be read as "this
    // character owns nothing", because that is what `[]` and `{}` say.
    if (restore.carried === undefined && restore.equipped === undefined) return;

    const dropped: string[] = [];

    // THE DOLL FIRST, so the bag can refuse an id that is already being worn.
    // An id in both lists keeps the EQUIPPED copy — the same precedence
    // persist/saves.ts applies on the way in, restated here rather than assumed.
    const worn: Partial<Record<Slot, string>> = {};
    const wornIds = new Set<string>();
    for (const [key, id] of Object.entries(restore.equipped ?? {})) {
      const slot = asSlot(key);
      const item = resolveItem(id);
      // A WRONG-SLOT ENTRY IS DROPPED, not demoted to the bag and not re-filed
      // into the slot the catalogue names. persist/saves.ts's `parseEquipped`
      // considered and rejected both repairs in writing: re-filing changes a
      // character's stats without saying so, and re-slotting needs to know
      // whether the target slot is free, which is a question about entries still
      // being repaired in the same pass.
      if (slot === undefined || item === undefined || item.slot !== slot) {
        dropped.push(id);
        continue;
      }
      if (worn[slot] !== undefined) {
        dropped.push(id);
        continue;
      }
      worn[slot] = id;
      wornIds.add(id);
    }

    const bag: string[] = [];
    for (const id of restore.carried ?? []) {
      // `carried` IS A SET, not a bag of duplicates — persist/saves.ts keeps the
      // first occurrence because a saved id carries no per-instance handle. The
      // same rule is enforced here and in `handlePickup`, so a party that finds
      // two identical pairs of trousers keeps one and learns that immediately
      // rather than at the next reload.
      if (resolveItem(id) === undefined || wornIds.has(id) || bag.includes(id)) {
        dropped.push(id);
        continue;
      }
      if (bag.length >= INVENTORY_CAP) {
        dropped.push(id);
        continue;
      }
      bag.push(id);
    }

    if (restore.carried !== undefined) actor.carried = bag;
    if (restore.equipped !== undefined) actor.equipped = worn;

    // ═══ AND THE SHEET, OR THE GEAR IS DECORATION ═══
    // `equipped` is owned by the equipment verbs and `combat` by
    // `recomposeCombat` — this is a write to the first, so the second has to
    // run. Without it a restored Watchman wears a full kit on the panel and
    // fights with the bare class sheet, which is Trap 1 arriving through the
    // load path rather than through the catalogue.
    //
    // `opts.effects ?? null` because a server with no status system wired in
    // genuinely cannot speak for stage three, and `null` carries the live flags
    // across unchanged — which is exactly right, since nothing in stages one and
    // two can alter a flag. Same argument world.ts makes at `reclothePlayer`.
    recomposeCombat(actor, opts.effects ?? null, resolveItem);

    if (dropped.length > 0) {
      // LOGGED RATHER THAN SILENT, on the shape `applyTalentPoints`'s refund
      // warning uses: an id that did not survive the load is the only evidence
      // that an item was renamed or deleted between two builds.
      app.log.warn(
        { actorId: actor.id, itemIds: dropped },
        'character file names items this build cannot place — they are dropped',
      );
    }
    app.log.info(
      { actorId: actor.id, carried: bag.length, equipped: Object.keys(worn).length },
      'restored a character’s inventory and equipment',
    );
  };

  /**
   * ═════════════════════════════════════════════════════════════════════════
   * THE PLAYER'S KEYS, ONTO THE BODY. THE SHORTEST RESTORE IN THIS FILE, AND
   * THE ONE WHOSE ABSENCE THE PLAYER WOULD NOTICE FIRST.
   * ═════════════════════════════════════════════════════════════════════════
   *
   * `restoreLoadout` has to validate ids, de-duplicate a bag, re-slot a doll and
   * recompose a combat sheet. This one assigns a field, because nothing in the
   * world reads it (engine/actor.ts:`keybinds` — "inert data") and because the
   * shape has already been repaired by `parseKeybinds` on the way in.
   *
   * ═══ ABSENT MEANS "THIS PORT CANNOT SAY", SO THE BODY KEEPS WHAT IT HAS ═══
   * Which for a fresh body is nothing at all, i.e. the compiled defaults. It must
   * never be read as "this player has no overrides", because that is what `{}`
   * says — and `{}` IS assigned, deliberately, because RESET ALL is a real thing
   * a player did and a restore that ignored it would hand back the map they just
   * cleared.
   *
   * ═══ NO MEMBERSHIP CHECK, AND NO PER-ACTION WARNING. BOTH ARE DECISIONS ═══
   * `restoreLoadout` re-checks every item id against the catalogue even though
   * the bridge already did, because a `PersistPort` is an INTERFACE and a bad id
   * on a live body would make `wornOf` and `projectInventory` disagree. There is
   * no equivalent check available here and there must not be one invented: THE
   * ACTION TABLE IS `src/client/input/keys.ts` AND net/ MAY NOT IMPORT THE
   * CLIENT. This layer genuinely cannot tell a deleted action from one that ships
   * next week, so the map is carried verbatim and the CLIENT owns the drop —
   * exactly as `createTalentSheet` drops a talent id the class no longer has.
   *
   * SO THE LOG LINE IS A COUNT, ONCE PER LOAD, AND NEVER ONE PER ACTION. That is
   * `classFor`'s lesson banked rather than re-learned: `classById(saved) ===
   * undefined` answered undefined for both a genuinely deleted class AND the
   * `unassigned` sentinel every file already held, and the resulting false-alarm
   * storm drowned the one real signal on the first evening after deploy. A
   * warning that fired per unknown action per player per join would be that
   * incident with more rows — and it would fire on a state files are legitimately
   * in. One info line with a number is what a human actually wants at 1 a.m.
   */
  const restoreKeybinds = (actor: Actor, restore: CharacterRestore): void => {
    /**
     * THE MAP THEY HAD WALKED, BACK INTO THE PROCESS.
     *
     * Sized against the CURRENT overworld rather than against whatever the file
     * was written from: `fogFromBase64` fills what it can and zeroes the rest,
     * so a save made before the region grew loads the country it knew and
     * treats the new ground as unexplored. That is the right answer and it is
     * why this decodes with an explicit length instead of trusting the string.
     */
    if (restore.explored !== undefined && opts.realms !== undefined) {
      const home = opts.realms.overworld;
      const level = home.world.level;
      const byRealm = fog.get(actor.id) ?? new Map<string, Uint8Array>();
      // INTO THE OVERWORLD'S SLOT, because a v1 file's single string can only
      // ever have been about the one map that existed when it was written.
      byRealm.set(home.id, fogFromBase64(restore.explored, Math.ceil((level.w * level.h) / 8)));
      fog.set(actor.id, byRealm);
    }
    if (restore.keybinds === undefined) return;
    actor.keybinds = keybindsRecord(restore.keybinds);
    app.log.info(
      { actorId: actor.id, actions: Object.keys(actor.keybinds).length },
      'restored a character’s key bindings',
    );
  };

  /**
   * @param engine the engine of the realm this body was placed in. Passed rather
   *   than closed over because the talent seams below are the WRAPPED engine's,
   *   and `handleHello` has already resolved which realm that is — one answer,
   *   threaded, instead of two lookups that could disagree.
   */
  const restoreProgression = (
    actor: Actor,
    restore: CharacterRestore,
    engine: TurnEngine,
  ): void => {
    // A monster has no progression. Narrowed rather than asserted: `level`,
    // `xp` and `unspentPoints` live on `PlayerActor` alone.
    if (actor.kind !== 'player') return;

    // ABSENT MEANS "THIS PORT CANNOT SAY", so the birth defaults stand, and it
    // must never be read as "this character is level 1". The shipped bridge DOES
    // say now — see `CharacterRestore` — so this branch is reached by a file
    // written before progression existed, or by a port that has no opinion.
    if (restore.level !== undefined && Number.isFinite(restore.level)) {
      actor.level = Math.max(1, Math.min(MAX_CHARACTER_LEVEL, Math.floor(restore.level)));
    }
    if (restore.xp !== undefined && Number.isFinite(restore.xp)) {
      actor.xp = Math.max(0, restore.xp);
    }
    // ═══ AND THE PURSE, WHICH IS RECONCILED AGAINST NOTHING ═══
    // `unspentPoints` below is recomputed from the ledger because it is a cache
    // of a derived quantity. A purse has no ledger — the file's number is the
    // number — so this trusts it, and the only defence is the same clamp
    // `parseMoney` already applied on the way in. Restated rather than assumed,
    // because a restore can be handed a `CharacterRestore` by a port that never
    // went through `parseCharacterFile` at all.
    if (restore.money !== undefined && Number.isFinite(restore.money)) {
      actor.money = Math.max(0, Math.floor(restore.money));
    }

    // ═══ THE BAG AND THE DOLL, AND IT IS ABOVE THE TALENT LEDGER ON PURPOSE ═══
    // Nothing about equipment depends on a talent sheet, and the branch below
    // that handles "no sheet at all" RETURNS EARLY — so a build with no talent
    // engine (the e2e harness, a fixture) would silently restore no gear if this
    // sat under it. Level and xp are written first only because `restoreLoadout`
    // logs against them.
    restoreLoadout(actor, restore);

    // ═══ AND THE KEYS, WHICH DEPEND ON NOTHING AND ARE THEREFORE SAFE HERE ═══
    // Above the talent ledger for `restoreLoadout`'s reason and a stronger
    // version of it: the branch below that handles "no sheet at all" RETURNS
    // EARLY, so anything under it is silently skipped on a build with no talent
    // engine — the e2e harness, a fixture — and a player's keys must survive
    // both. Nothing about a keymap depends on a class, a sheet or a level.
    restoreKeybinds(actor, restore);

    // THE SHEET, through the injected seam and never by importing the talent
    // engine. An absent method and an absent sheet both answer undefined, which
    // is what tells the ledger below that it cannot be run.
    const dropped = engine.applyTalentPoints?.(actor.id, restore.talentPoints ?? {});
    if (dropped !== undefined && dropped.length > 0) {
      app.log.warn(
        { actorId: actor.id, talentIds: dropped },
        'character file names talents this body no longer has — their points are refunded',
      );
    }

    const spread = engine.talentPointsOf?.(actor.id);
    if (spread === undefined) {
      // NO SHEET, SO NO LEDGER. Nothing here can work out what has been spent,
      // and running `totalPointsAtLevel(level)` against an empty spread would
      // hand a body with no hotbar eleven points to spend on nothing. The
      // file's cached number is the only statement anybody has made, so it
      // stands — which is also exactly the pre-progression behaviour.
      actor.unspentPoints = Math.max(0, Math.floor(restore.unspentPoints ?? 0));
      return;
    }

    let spent = 0;
    for (const raw of Object.values(spread)) {
      // `raw - 1`, never `raw`. Written in the same form as
      // `spentTalentPoints` in persist/saves.ts so the two cannot disagree
      // about how many points are in hand; the shorthand
      // `totalPointsAtLevel(level) - sum(points)` that appears in two docblocks
      // elsewhere hands a fresh level-1 character MINUS FOUR.
      spent += Math.max(0, raw - 1);
    }
    const ledger = Math.max(0, totalPointsAtLevel(actor.level) - spent);
    const claimed = restore.unspentPoints;
    if (claimed !== undefined && Math.floor(claimed) !== ledger) {
      // LOGGED RATHER THAN SILENTLY PREFERRED. A file that disagrees with its
      // own raw spread is either hand-edited or evidence of a bug in whatever
      // wrote it, and a repair nobody can see is a repair that happens every
      // session forever.
      app.log.warn(
        { actorId: actor.id, claimed, ledger, level: actor.level },
        'character file disagrees with the talent-point ledger — the ledger wins',
      );
    }
    actor.unspentPoints = ledger;
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
    const { world } = realmFor(session);
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

  /**
   * ═════════════════════════════════════════════════════════════════════════
   * "YOU ARE HERE." The map, who is on it, and which one of them is you.
   * ═════════════════════════════════════════════════════════════════════════
   *
   * TWO CALLERS AND THEY ARE THE ONLY TWO MOMENTS A PLAYER'S MAP CHANGES: the
   * `hello` block (you have arrived) and a site crossing (you have walked
   * through a door). There is no on-change memo because there is no stream to
   * memoise — a realm change is an EVENT, not a state that drifts.
   *
   * UNICAST AND STRUCTURALLY SO. `RealmMsg` is a `ViewerMsg`, so
   * `broadcast(realmMsg)` does not compile: the map in it is the map THIS person
   * is now looking at, and handed to the room it would redraw everybody else's
   * floor as somewhere they are not. protocol.ts argues it at the type.
   *
   * SILENT WITH NO REGISTRY, which is the fallback rule this whole change rests
   * on: one world has no name to send and no id to send it under.
   */
  /**
   * Every marker on the realm this session is in: authored sites, the way out,
   * and whatever is currently wandering.
   *
   * ONE BUILDER FOR TWO FRAMES. `realm` carries this list on arrival and
   * `sites` carries it whenever the roamers move, and the two must never
   * disagree about what a marker is — a settlement that changed shape depending
   * on which frame last described it would be indistinguishable from a bug.
   */
  /**
   * ═════════════════════════════════════════════════════════════════════════
   * THE MARKERS THIS PLAYER HAS EARNED THE RIGHT TO SEE.
   * ═════════════════════════════════════════════════════════════════════════
   *
   * Thirteen markers arrived with the first frame, so the overworld had never
   * once rewarded LOOKING: everything worth walking to was handed over before
   * the player took a step, and a map with no unknown on it is a list of
   * destinations rather than a place.
   *
   * `SiteDef.hidden` sites are filtered out until this character's OWN fog holds
   * their cell. The gate costs no new state and no new save field — the bitset
   * is already computed by `revealFor`, already persisted as
   * `CharacterFile.explored`, and already sent on the `realm` frame.
   *
   * PER PLAYER, NOT PER PARTY, and that is the correct reading rather than the
   * cheap one: finding something is yours, and telling the others about it is
   * the good part. Four people in a voice channel discovering a marker at four
   * different moments is the mechanic working.
   *
   * `actorId` OPTIONAL, and absent means show everything. Every caller that
   * predates the flag takes that path, and no site was hidden before today — so
   * the fallback is not a hole, it is the behaviour the whole map used to have.
   */
  /** How many hidden markers this character can currently see in this realm. */
  const hiddenVisible = (realm: Realm, actorId: string): number => {
    let seen = 0;
    for (const [cell, siteId] of realm.sites) {
      if (SITES.get(siteId)?.hidden !== true) continue;
      const parts = cell.split(',');
      const level = realm.world.level;
      if (fogHas(fogFor(actorId), level.w, Number(parts[0]), Number(parts[1]))) seen += 1;
    }
    return seen;
  };

  /**
   * Which overworld this character walked in from, or null. Resolved through the
   * connection table because `markersFor` is handed an actor id and the record
   * lives on the SESSION — see `Session.enteredFromRealm`.
   */
  const enteredFromRealmOf = (actorId: string): string | null => {
    const conn = connByActor.get(actorId);
    const owner = conn === undefined ? undefined : sessions.get(conn);
    return owner?.enteredFromRealm ?? null;
  };

  const markersFor = (realm: Realm, actorId?: string): SiteView[] => {
    const authored = [...realm.sites.entries()].flatMap(([cell, siteId]) => {
      const def = SITES.get(siteId);
      if (def === undefined) return [];
      const parts = cell.split(',');
      if (def.hidden === true && actorId !== undefined) {
        const level = realm.world.level;
        const seen = fogHas(fogFor(actorId), level.w, Number(parts[0]), Number(parts[1]));
        if (!seen) return [];
      }
      // THE GRADE, when the place has one. `delveFor` answers undefined for a
      // town, and an absent field is how the map knows not to draw a
      // scale that does not apply. Same source as the arrival line, so
      // the two can never disagree about how bad a room is.
      /**
       * ═══════════════════════════════════════════════════════════════════════
       * `specFor`, AND THIS IS THE CALL SITE THAT WAS MISSED.
       * ═══════════════════════════════════════════════════════════════════════
       *
       * `specFor` was introduced to fix exactly this — the Redaction's six doors
       * are DERIVED from their Alderbrook originals and are therefore absent
       * from `DELVES`, so a raw table lookup answers `undefined`, which is the
       * TOWN case: no grade at all. The fix went into `nearestSites`, the
       * bearing list, along with a note claiming *"the danger grade on the map,
       * the party hint beside it, and the monsters actually placed in the room
       * all have to agree"*.
       *
       * THE GRADE ON THE MAP IS THIS FUNCTION AND IT KEPT ASKING `DELVES`. So
       * the bearing list named the twins correctly while the world map — the
       * thing a player actually plans a trip on — drew all six of them in the
       * ink it uses for settlements. One of two call sites is not a fix; it is a
       * fix and a matching bug, which is worse than neither because the two
       * surfaces now disagreed.
       */
      const spec = specFor(siteId);
      return [
        {
          x: Number(parts[0]),
          y: Number(parts[1]),
          marker: def.marker,
          name: def.name,
          ...(spec === undefined ? {} : { danger: dangerWord(spec) }),
          // AND A DOOR OFF THIS MAP SAYS SO. See `SiteView.crossing`: an
          // Overworld-kind site is the one thing that is neither a room nor a
          // settlement, and without this it drew as the second.
          ...(def.kind === RealmKind.Overworld ? { crossing: true } : {}),
        },
      ];
    });

    /**
     * THE WAY OUT — from a site, and from a second landmass you walked into.
     *
     * This was "inside a site only", on the reasoning that *"the overworld's
     * edge is the edge of the world"*. True of the map you wake up on. A player
     * standing on a second overworld needs the door drawn or the ground they
     * arrived on is indistinguishable from the seven thousand cells around it —
     * and `leaveRealm` requires them to stand on that exact tile.
     *
     * THE SAME CONDITION AS `leaveRealm`'s, deliberately: a marker offering a
     * door the server would refuse is worse than no marker, so both ask whether
     * there is anywhere to go back to rather than what kind of place this is.
     */
    const canLeave =
      realm.kind !== RealmKind.Overworld ||
      (actorId !== undefined && enteredFromRealmOf(actorId) !== null);
    const exits = canLeave
      ? realm.spawns.map((t) => ({ x: t.x, y: t.y, marker: 'gate', name: 'The way out' }))
      : [];

    // A ROAMER IS DRAWN AS A CREATURE, not as a place. `marker` stays only as
    // the fallback for a client with no creature art; `sprite` is what it
    // actually wears. See `SiteView.sprite`.
    const wandering = [...realm.roamers.values()].map((r) => ({
      x: r.x,
      y: r.y,
      marker: 'breach',
      name: r.name,
      sprite: r.sprite,
    }));

    return [...authored, ...exits, ...wandering];
  };

  /**
   * The markers, without the map.
   *
   * Sent when the roamers move. `realm` would say the same thing and carry
   * 17,000 tiles to do it — affordable at 96x64, and not at ToME's 170x100.
   */
  const sendSites = (session: Session): void => {
    const realms = opts.realms;
    if (realms === undefined || session.realmId === null) return;
    const realm = realms.get(session.realmId);
    if (realm === undefined) return;
    send(session.socket, {
      v: PROTOCOL_VERSION,
      t: 'sites',
      realmId: realm.id,
      sites: markersFor(realm, session.actorId ?? undefined),
    });
  };

  const sendRealm = (session: Session): void => {
    const realms = opts.realms;
    const actorId = session.actorId;
    if (realms === undefined || actorId === null || session.realmId === null) return;
    const realm = realms.get(session.realmId);
    // A realm that went away underneath somebody. `realmFor` argues the same
    // case at length: answer rather than throw, because an exception here costs
    // every player their session and a missing HUD label costs one their label.
    if (realm === undefined) return;
    const view = projectWorld(realm.world);
    /**
     * THE LANDMARKS, and they are the reason the first overworld had none.
     * `Realm.sites` is `"x,y" -> site id`; the client needs a POSITION, an art
     * family and a name, and must never see an id. A site whose def has gone
     * missing is skipped rather than sent with a guessed marker — an
     * unexplained icon on a world map is worse than an absent one.
     */
    // ONE BUILDER, shared with the `sites` frame — see `markersFor`.
    /**
     * THE FOG, ONLY WITH THE MAP IT BELONGS TO. 2,836 characters for the whole
     * region, sent once on arrival — after which the client keeps revealing
     * locally at the same radius, so neither has to send anything per step.
     * The server's copy is the one that persists.
     */
    const explored =
      realm.kind === RealmKind.Overworld && fogSeen(actorId, realm.id)
        ? fogToBase64(fogFor(actorId, realm))
        : undefined;

    send(session.socket, {
      v: PROTOCOL_VERSION,
      t: 'realm',
      realmId: realm.id,
      kind: realm.kind,
      name: realm.name,
      level: view.level,
      actors: view.actors,
      sites: markersFor(realm, actorId),
      // THE NAMES OF THE COUNTRY, on an overworld only — see `RealmMsg.regions`.
      // One frame per entry and never again; the client holds it for the map.
      ...(realm.kind === RealmKind.Overworld ? { regions: ALDERBROOK_REGIONS } : {}),
      explored,
      selfId: actorId,
    });
  };

  /**
   * ═════════════════════════════════════════════════════════════════════════
   * THE KEYMAP, UNICAST, READ OFF THE BODY AND NEVER OFF THE FRAME THAT SET IT.
   * ═════════════════════════════════════════════════════════════════════════
   *
   * Called from two places and no others: the `hello` block, unconditionally,
   * beside `progress` / `class_options` / `party_state` / `inventory` and for the
   * same stated reason — THIS SOCKET HAS SEEN NOTHING YET — and again as the echo
   * at the end of `handleSetKeybinds`.
   *
   * ═══ IT READS `body.keybinds`, WHICH IS THE WHOLE VALUE OF THE ECHO ═══
   * Answering with `msg.binds` would be the server agreeing with the client about
   * something only the server knows. The Keys screen renders THIS frame, so a map
   * that was trimmed, refused or never arrived shows up on the screen that set it
   * rather than on a reconnect three hours later.
   *
   * ═══ IT IS A `ViewerMsg`, SO `send` IS THE ONLY THING THAT COMPILES ═══
   * `broadcast` takes a `BroadcastMsg` and `BroadcastMsg` is `Exclude<ServerMsg,
   * ViewerMsg>`, so `broadcast(keybindsMsg)` is a build failure. A keymap is true
   * for exactly one person — see the frame's own docblock in protocol.ts.
   *
   * ═══ `persisted` IS ASKED OF THE LAYER THAT ACTUALLY DECIDES ═══
   * It used to be `session.ownerId !== null && opts.persist !== undefined` — "is
   * there an owner and is there a save layer" — and that OVERSTATED in a way the
   * screen could not survive. A verified player whose file came back `too_new` or
   * `corrupt` is deliberately NOT bound (persist/saves.ts refuses so the bytes
   * stay where a human can look at them); `owned()` then drops every snapshot
   * they produce, so nothing they do all evening reaches disk. The Keys screen
   * shows its NOT SAVED warning only when `!persisted`, so the one line whose
   * whole job is to say "this will not be kept" said nothing, and then made way
   * for the quiet hint. Ten minutes of rebinding, discarded, with no signal
   * anywhere the player was looking.
   *
   * SO THE PORT IS ASKED — `isBound`, which the bridge answers off the very map
   * `owned()` reads. That is NOT a second source of truth about ownership; it is
   * the one source, queried instead of guessed at. The gateway still holds no
   * binding table of its own, which is the rule that mattered.
   *
   * AND THE OLD ANSWER IS STILL THE FALLBACK, for a port that does not implement
   * it: `?? opts.persist !== undefined`. A recording double in a test has no
   * notion of ownership and the wider answer is right for it.
   */
  const sendKeybinds = (session: Session): void => {
    const { world } = realmFor(session);
    const actorId = session.actorId;
    const body = actorId === null ? undefined : world.getActor(actorId);
    send(session.socket, {
      v: PROTOCOL_VERSION,
      t: 'keybinds',
      // `{}` FOR A BODY WITH NO OVERRIDES, and that is the honest wire value: the
      // frame is complete and absolute, so an empty map means "every action on
      // its default" rather than "the server declined to say".
      binds: body?.keybinds ?? {},
      persisted:
        session.ownerId !== null &&
        opts.persist !== undefined &&
        (actorId === null ? false : (opts.persist.isBound?.(actorId) ?? true)),
    });
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
  /**
   * @param place where a NEW body goes: Alderbrook when there is a registry, the
   *   one world when there is not. See `handleHello`.
   *
   * ═══ FINDING A BODY AND PLACING ONE ARE NOW DIFFERENT QUESTIONS ═══
   * A returning player's body may be standing anywhere — they closed the tab
   * inside an instance and the grace has not expired — and looking for it only
   * in `place` would find nothing and build a SECOND body for the same id, in
   * the city, while the first one stands in the Underworks with their kit on it.
   * So the lookups go through `homeOf`, which asks the registry where that id
   * actually is, and only the `addPlayer` calls use `place`.
   *
   * With no registry `homeOf` answers the fallback realm, whose world IS
   * `place`, and the two questions collapse back into the one this used to ask.
   */
  const resolveActor = (
    session: Session,
    token: string | undefined,
    verified: VerifiedPlayer | null,
    restore: CharacterRestore | null,
    place: World,
  ): ResolvedActor => {
    const findBody = (id: string): Actor | undefined => homeOf(id).world.getActor(id);

    if (verified !== null) {
      const existing = findBody(verified.actorId);
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
      const actor = place.addPlayer(verified.actorId, verified.displayName, overlayFor(definition));
      connByActor.set(actor.id, session.connId);
      // AFTER the class, never before: `applyRestore` clamps the saved hp to
      // `actor.maxHp`, so a Watchman restored at 70 would be filed down to 60
      // if the body were still classless when the file landed on it.
      applyRestore(actor, restore);
      return { actor, resumed: false, renamed: false };
    }

    if (token !== undefined) {
      const actorId = actorByToken.get(token);
      const existing = actorId === undefined ? undefined : findBody(actorId);
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
    const actor = place.addPlayer(
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

    /**
     * ═══════════════════════════════════════════════════════════════════════
     * EVERYBODY ARRIVES IN ALDERBROOK. THE CITY IS THE FRONT DOOR.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `Realms.overworld` is the one realm that is created at boot and never
     * closed (world/realms.ts:332-333), it has no hostiles by construction, and
     * it is the only place with site cells on it — so it is the only realm a
     * player can arrive in and still be able to get anywhere. Dropping somebody
     * into an instance on connect would also require answering "whose?", which
     * is a question a socket that has not said hello yet cannot be asked.
     *
     * ONLY A NEW BODY IS PLACED. `resolveActor` finds an existing one wherever
     * it is standing and reattaches to it — a reconnect inside an instance is
     * exactly the case the ten-minute grace exists for, and teleporting that
     * body to the city on reconnect would be the server undoing the walk.
     *
     * `opts.world` RATHER THAN THE `world` BINDING because there is no `world`
     * in scope here yet: the realm-scoped pair is destructured a few lines
     * below, once `session.realmId` says which realm to destructure.
     */
    const entryWorld = opts.realms?.overworld.world ?? opts.world;

    let resolved: ResolvedActor;
    try {
      resolved = resolveActor(session, msg.resumeToken, verified, restore, entryWorld);
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
    // ═══ AND WHERE THAT BODY IS, READ BACK OFF THE REGISTRY ═══
    // `resolveActor` placed it in `entryWorld`, or found it already placed
    // somewhere else entirely, so this is a READ of the fact rather than a second
    // decision about it — which is what keeps the routing and the placement from
    // ever being two different answers, and is why a reconnect into an instance
    // routes to that instance without this function knowing instances exist.
    // `realmOf` is a scan over realms, run once per `hello`; with no registry it
    // is not run at all and the field stays null, which is the pre-realm state.
    session.realmId = opts.realms?.realmOf(actor.id)?.id ?? null;
    session.helloDone = true;

    // AND ONLY NOW THE PAIR EVERYTHING BELOW READS. It has to be after the line
    // above: `realmFor` resolves `session.realmId`, so destructuring any earlier
    // would hand the whole hello block the fallback world and every frame in it
    // would describe a map this player is not standing on.
    const { world, engine } = realmFor(session);

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

      // ═══ AND ONLY NOW THE PROGRESSION — THE SHEET HAS TO EXIST FIRST ═══
      // `applyRestore` (inside `resolveActor`, several lines above) deliberately
      // does NOT do this. `attachClass` immediately above ends in an
      // unconditional `sheets.set`, so a saved talent spread written before it
      // is silently replaced by four birth ranks; and `unspentPoints` is
      // recomputed from that spread, so restoring the level without it would
      // hand the player back every point they had already spent. The two halves
      // are done together, here, after the sheet exists.
      if (restore !== null) restoreProgression(actor, restore, engine);

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

    // ═════════════════════════════════════════════════════════════════════════
    // AND WHICH PLACE THAT WAS. `welcome` CARRIES A MAP BUT NOT ITS NAME.
    // ═════════════════════════════════════════════════════════════════════════
    //
    // `WelcomeMsg` has a `level` and an actor list and nothing that says WHERE —
    // no realm id, no kind, no prose name — because until there was more than
    // one place, there was nothing to say. The client's HUD reads all three off
    // `realm` (protocol.ts's `RealmMsg`), so without this frame a player who
    // connects is standing in Alderbrook on a screen that will not name it, and
    // the first `realm` frame they ever see is the one that arrives when they
    // walk through a door — at which point the label CHANGES from nothing to
    // something and reads as a bug.
    //
    // SENT ONLY WHEN THERE IS A REGISTRY, which is the whole fallback rule of
    // this commit: a gateway built with `{world, engine}` alone has exactly one
    // unnamed place, sends no `realm` frame, and is byte-for-byte the game it
    // was — including every test under test/server/ and tools/e2e-m1.mjs.
    //
    // AFTER `welcome`, because the client's `case 'welcome'` clears the board it
    // is about to be handed and `case 'realm'` does not.
    sendRealm(session);

    // Unicast, unconditionally, before anything else can change: a client that
    // has just connected must not have to wait for someone else to commit
    // before it learns whether the party is parked on it. `broadcastTurnIfChanged`
    // deliberately will not do this — the state has not changed, only the
    // audience has.
    sendTurn(session, engine.turnState(), bellRemainingMs(realmFor(session).id));

    // The hotbar, for the same reason and with the same exception to the
    // on-change rule: this socket has seen nothing yet. A RESUMED session gets
    // it too — the body kept cooling down and spending while nobody was driving
    // it, and `session.viewerKey` is null on a fresh connection regardless of
    // whether the actor behind it is new.
    sendLoadout(session);
    sendHotbarIfChanged(session);

    // PROGRESS, unconditionally, for the same reason the two above are
    // unconditional: this socket has seen nothing. `sendProgressIfChanged` in
    // the pump would suppress it for a returning player whose level has not
    // moved since the last frame THIS SESSION was sent — which is every
    // reconnect — and the panel would then draw an empty bar over a level-8
    // detective until their next kill.
    sendProgress(session);

    // THE PICKER, for the one player who owes a choice, and outside the
    // on-change rule for the same stated reason as everything around it: this
    // socket has seen nothing yet. Silent for everybody else — see
    // `sendClassOptions`, where the set membership is checked.
    sendClassOptions(session);

    // THEIR KEYS, unicast and UNCONDITIONAL, for the same reason as everything
    // around it: this socket has seen nothing yet. There is no on-change memo to
    // sit outside of — the frame is sent exactly twice, here and as the echo
    // after a rebind — because a keymap changes when a player changes it and at
    // no other moment.
    //
    // AND IT IS SENT EVEN WHEN THE MAP IS EMPTY, unlike `sendProjectilesIfAny`
    // and `sendGroundIfAny` above. `{}` is a real answer here: it tells a
    // returning player's Keys screen that the server holds no overrides, which is
    // exactly what a client that drew its defaults and waited would never learn.
    // The `persisted` flag rides along, and for an anonymous socket it is the
    // only place the truth ("this session is not signed in") appears at all.
    sendKeybinds(session);

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
    sendProjectilesIfAny(realmFor(session), session.socket);

    // THE FLOOR, unicast, and for a longer-lived version of the reason directly
    // above: an orb is a three-turn object and a coat on the floor lasts the
    // rest of the delve. A player who reconnects after a fight would otherwise
    // see a bare floor until the next time somebody dropped or took something,
    // which out of combat can be the whole evening. `welcome` cannot carry it —
    // that frame is the level and the actors, and a ground item is neither.
    // Silent on an empty floor; see `sendGroundIfAny`.
    sendGroundIfAny(realmFor(session), session.socket);
    // AND THE SHELVES, if this room has any. Silent everywhere else, which is
    // how a client knows not to offer the tab: no `shop` frame, no shop.
    sendShopIfAny(session);
    // AND THE ROOM NAMES ITSELF. Last of the join frames on purpose: it is the
    // first thing the player will READ, and it should be sitting under a board
    // that is already drawn rather than above one that is not.
    // THE NAME COMES OFF THE REGISTRY, not off `PumpTarget` — a gateway booted
    // with no realms has one nameless fallback world, and "you are in ''" is
    // worse than saying nothing. That build gets the blurb-free path.
    announceArrival(session, realmFor(session), opts.realms?.get(realmFor(session).id)?.name ?? '');

    // THEIR OWN BAG AND DOLL, on the memo, which is seeded EMPTY. So a
    // brand-new character gets nothing (they own nothing, and the client already
    // believes that) while a returning one whose file carried a kit gets the
    // frame here — after `restoreProgression` has put the gear on the body and
    // recomposed the sheet, which is the only order in which the comparison rows
    // are computed against the sheet the player is actually wearing.
    sendInventoryIfChanged(session);

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
      broadcast(
        { v: PROTOCOL_VERSION, t: 'joined', actor: toActorView(actor) },
        session.connId,
        audienceFor(realmFor(session).id),
      );
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
      broadcast(
        { v: PROTOCOL_VERSION, t: 'state', actors: projectActors(world) },
        session.connId,
        audienceFor(realmFor(session).id),
      );
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
      sendProjectilesIfAny(realmFor(session));
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
    pumpAndBroadcast(realmFor(session));
  };

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * WALKING INTO SOMEBODY WHO LIVES HERE IS A CONVERSATION, NOT A REFUSAL.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * A townsfolk blocks her tile like any other body, so without this the answer
   * to walking into Merrow is `move blocked: occupied` — a red error line, the
   * same one a wall gives, about a person standing in front of you. That reads
   * as a bug and it is the first thing anybody will do.
   *
   * ═══ AND IT IS THE ANSWER TO THE OTHER THING ANYBODY WILL DO ═══
   * Six friends in a voice channel will try to kill the shopkeeper for a laugh.
   * `areEnemies` means they cannot — the swing never resolves — so SOMETHING has
   * to happen or the tile just refuses over and over. She talks back, and the
   * third line escalates, which is funnier than a refusal and is the only thing
   * a group actually wants from that interaction.
   *
   * ═══ THE COUNTER IS PER PLAYER, PER PERSON ═══
   * So the greeting is a greeting: the first time YOU walk into her you get her
   * name, and the room hears it once. Keyed by both ids because a town is shared
   * by every party in it — one shared counter would mean the second player ever
   * to meet her is told "still here", about somebody they have never seen.
   */
  const bumpCounts = new Map<string, number>();

  const greetOnBump = (
    session: Session,
    realm: PumpTarget,
    walker: EngineActor,
    dir: Dir,
  ): boolean => {
    const to = step(walker, dir);
    const standing = realm.world.actorAt(to.x, to.y);
    if (standing === undefined || !isMonster(standing)) return false;
    if (standing.faction !== Faction.Townsfolk) return false;

    const spec = specForActorId(standing.id);
    if (spec === undefined) return false;

    const key = `${walker.id}|${standing.id}`;
    const seen = bumpCounts.get(key) ?? 0;
    bumpCounts.set(key, seen + 1);

    // 0 -> her name. 1 -> she is still there. 2+ -> the deflections, cycled, so
    // a player who keeps shoving gets an escalation rather than a loop.
    const text =
      seen === 0
        ? spec.greetFirst
        : seen === 1
          ? spec.greetAgain
          : (spec.deflect[(seen - 2) % spec.deflect.length] ?? spec.greetAgain);

    broadcastMargin(realm, { text, speaker: standing.name });
    return true;
  };

  const handleMove = (session: Session, msg: ClientMove): void => {
    const { engine } = realmFor(session);
    const actorId = session.actorId;
    if (actorId === null) {
      sendError(session.socket, ErrorCode.NotAuthenticated, 'send hello before moving');
      return;
    }
    // A KEY WAS PRESSED, SO THE BARRIER IS THEIRS AGAIN. See `unparkOnCommand`
    // — and it goes above `submitMove` on purpose, because trying to walk into a
    // wall is still somebody at the keyboard.
    unparkOnCommand(session);

    /**
     * BEFORE `submitMove`, AND THAT IS THE ONLY PLACE IT WORKS.
     *
     * The player has not moved yet, so `step()` from their current tile is
     * exactly the tile they tried to enter. After the submit it would be either
     * where they now stand or nowhere, and the refusal would already have been
     * sent. Returning here also means the move is never submitted, so no turn is
     * spent — bumping into a shopkeeper is not an action, in the same way `say`
     * and `point` are not.
     */
    const here = realmFor(session);
    const body = here.world.getActor(actorId);
    if (body !== undefined && greetOnBump(session, here, body, msg.dir)) return;

    const result = engine.submitMove(actorId, msg.dir);
    if (!result.ok) {
      // Only the sender hears about a refusal: a wall nobody walked into is not
      // an event, and telling the room would leak where people are trying to go.
      sendError(session.socket, ErrorCode.IllegalMove, `move blocked: ${result.reason}`);
      return;
    }

    // The step itself comes back out of the pump as a `moved` to EVERYONE, the
    // mover included. See the header note: there is no optimistic path.
    pumpAndBroadcast(realmFor(session));

    // ═══ AND WAS THAT STEP ONTO A DOOR? ═══
    // AFTER the pump, never before it: the tile the body is standing on is only
    // decided when the intent RESOLVES (a move accepted by `submitMove` can
    // still be refunded — see `PumpResult.refusals`), so asking any earlier
    // would open an instance for somebody who never took the step. And the
    // `moved` frame has to reach the client first, or the map it is about is
    // already gone.
    /**
     * REVEAL FIRST, and after the pump rather than before it — the tile a body
     * is standing on is only decided when the intent RESOLVES, and revealing
     * around a move that was refunded would give away country nobody walked.
     */
    const walker = session.actorId;
    if (walker !== null && session.realmId !== null) {
      const here = opts.realms?.get(session.realmId);
      const body = here?.world.getActor(walker);
      if (here !== undefined && body !== undefined) {
        // Only queue a save when something was NEWLY seen. A party pacing the
        // same street would otherwise ask for a write on every step, and the
        // debounce would coalesce them into a file that says nothing new.
        if (revealFor(here, walker, body.x, body.y)) {
          queueSave('explored');
          /**
           * ═══════════════════════════════════════════════════════════════════
           * AND DID THAT STEP UNCOVER SOMETHING NOBODY TOLD THEM ABOUT?
           * ═══════════════════════════════════════════════════════════════════
           *
           * `sendSites` is otherwise only re-sent when a roamer moves, which is
           * every few pumps — so a hidden marker would appear a handful of turns
           * after the step that found it, attached to nothing the player did.
           * The whole feeling of the feature is in the timing: you walk over a
           * rise and something you have never seen is on your map.
           *
           * COUNTED RATHER THAN DIFFED. Recomputing the visible-hidden count is
           * three comparisons on a sixteen-row table, and it answers exactly the
           * question — "is there more to show than last time" — without a second
           * copy of what was already sent.
           */
          const shown = hiddenVisible(here, walker);
          if (shown !== session.hiddenSeen) {
            session.hiddenSeen = shown;
            sendSites(session);
          }
        }
        noteRegion(session, here, body.x, body.y);
      }
    }

    if (leaveRealm(session)) return;
    /**
     * WHAT IS NOT HERE ANY MORE: a per-step encounter roll.
     *
     * There was one, and when the roamers arrived they were added ALONGSIDE it
     * rather than INSTEAD of it. So the overworld had visible danger you could
     * choose to take on AND an invisible d100 that pulled you into a fight for
     * standing on grass. Reported from play as "the fight just starts
     * randomly" — which is precisely what it did, three times, while I kept
     * fixing everything except the thing doing it.
     *
     * Every fight on the overworld now starts by walking onto something you can
     * see; `crossIntoSite` checks the roamers first. That is the whole point of
     * making danger visible — a hazard you cannot see is not a decision, it is
     * weather.
     */
    crossIntoSite(session);
  };

  /**
   * ═════════════════════════════════════════════════════════════════════════
   * A BODY, CARRIED FROM ONE WORLD TO ANOTHER. Everything that IS the character
   * and nothing that is about a floor.
   * ═════════════════════════════════════════════════════════════════════════
   *
   * Two `World`s are two closures over two actor tables (world/realms.ts's
   * header: that separation is the whole design), so there is no way to hand one
   * the other's object — the body is REBUILT by `addPlayer` through the ordinary
   * `PlayerOverlay` path, exactly as `hello` builds one, and then everything the
   * overlay cannot say is copied onto it here.
   *
   * ═══ WHAT IS CARRIED IS PRECISELY WHAT `snapshotPlayers` WRITES DOWN ═══
   * That list is already this file's answer to "what makes this character this
   * character" — it is what survives a server restart — so reusing it means the
   * crossing cannot lose something a save would have kept. Read `snapshotRealm`
   * beside this: hp, cooldowns, class, level/xp/points, bag, doll, keys.
   *
   * The TALENT SHEET is not in that list and does not need to be: it is held by
   * `engine/talents.ts` keyed by ACTOR ID, and main.ts shares one talent engine
   * across every realm (`talentEngine` — "it holds per-ACTOR sheets, and a
   * character keeps its talents when it walks somewhere"). Calling `attachClass`
   * here would be the bug rather than the fix — it ends in an unconditional
   * `sheets.set` and would hand the crosser a full resource pool for free.
   *
   * ═══ WHAT IS DELIBERATELY NOT CARRIED, AND IT IS THE SAME LIST TWICE ═══
   * `pendingIntent`, `standingOrder`, `standingBy`, energy: every one of them is
   * a fact about a BARRIER, and world/realms.ts:266-289 already ruled on this in
   * writing — per-actor barrier bookkeeping does not follow a body across a
   * boundary, because "Standing By means this person has stopped answering on
   * this floor, and walking through a door is the loudest possible evidence that
   * they have started again". The old realm's barrier keeps a row for an id that
   * is no longer in its world; the quorum is surveyed from the actor table, so
   * that row can never block anybody again.
   */
  const carryAcross = (from: PlayerActor, to: Actor): void => {
    if (to.kind !== 'player') return;
    // CLAMPED, not copied raw, on `applyRestore`'s terms: the two bodies are the
    // same class so the ceiling is the same number, and the clamp costs nothing
    // and cannot be wrong.
    to.hp = Math.max(1, Math.min(to.maxHp, from.hp));
    to.cooldowns.clear();
    for (const [talentId, turns] of from.cooldowns) {
      if (turns > 0) to.cooldowns.set(talentId, turns);
    }
    to.level = from.level;
    to.xp = from.xp;
    to.unspentPoints = from.unspentPoints;
    if (from.keybinds !== undefined) to.keybinds = from.keybinds;
    // THE BAG AND THE DOLL, THEN THE SHEET. `equipped` is owned by the equipment
    // verbs and `combat` by `recomposeCombat` and nothing else — a write to the
    // first without the second leaves a detective wearing a coat that changes no
    // number, which is Trap 1 arriving through a door. See `restoreLoadout`,
    // which states the same contract for the load path.
    if (from.carried !== undefined) to.carried = [...from.carried];
    if (from.equipped !== undefined) to.equipped = { ...from.equipped };
    recomposeCombat(to, opts.effects ?? null, resolveItem);
  };

  /**
   * ═════════════════════════════════════════════════════════════════════════
   * THE CROSSING. A STEP ONTO A SITE CELL IS A STEP THROUGH A DOOR.
   * ═════════════════════════════════════════════════════════════════════════
   *
   * `Realm.sites` is the authored `"x,y" -> site id` table the map was parsed
   * with (shared/level.ts:44-49), so "is this a door" is a Map lookup on the
   * tile the body is ALREADY standing on. No range check, no adjacency rule, and
   * nothing off the wire: `handleMove` carries a direction and the server decided
   * where that put them.
   *
   * ═══ THE PARTY IS THE KEY, AND `open` IS IDEMPOTENT ON IT ═══
   * `Realms.open(site, partyId)` returns the instance that party already has at
   * that site, or mints one (world/realms.ts:386-394). So the second person
   * through the door joins the first; a stranger walking onto the same tile gets
   * their own floor; and a COMMON site ignores the party entirely, because there
   * is one office and everybody who walks in is in it.
   *
   * ═══ THIS IS ENTRY ONLY. THERE IS NO WAY BACK YET, AND THAT IS DELIBERATE ═══
   * A player who crosses into a site stays there for the rest of the session.
   * The exit is a separate decision with real design in it — whether the party's
   * instance stays open behind them, what happens to the last body out, whether
   * a Common realm and an Inner one leave the same way — and inventing an answer
   * here by accident is exactly how a party ends up unable to get home
   * (world/realms.ts:114-120 raises the nesting half of the same question).
   * `Realms.close` and `Realms.empty` already exist for the reaper that will do
   * it. Until that commit lands, the way out is to reconnect: `hello` places a
   * NEW body in Alderbrook, and a body left in an instance is reaped by the
   * ten-minute grace.
   */
  /**
   * ═════════════════════════════════════════════════════════════════════════
   * WHEN THE LAST BODY LEAVES. Two policies, and the difference is the point.
   * ═════════════════════════════════════════════════════════════════════════
   *
   * A DELVE LINGERS (`INSTANCE_LINGER_MS`). The ordinary reason a floor empties
   * is that somebody stepped out for a moment; coming back to a re-rolled floor
   * with the loot swept off it would make leaving something you never dare do.
   * The countdown is CANCELLED on re-entry rather than paused, so returning and
   * leaving again buys another full five minutes.
   *
   * AN AMBUSH DOES NOT (`lingerMs === 0`). It is closed on the spot, and
   * `leaveRealm` has already sealed it besides. Fleeing has to mean something.
   *
   * A SHARED SPACE IS NEVER REAPED at all — `Realms.close` refuses one outright,
   * so a town keeps the coat you dropped in it.
   *
   * THE TIMER IS `unref`'d: an abandoned instance must never be the reason a
   * process refuses to exit, and a shutdown that reaps nothing has lost nothing
   * — the whole registry goes with the process.
   */
  /**
   * Drop a reaped realm's rows from every per-realm side table.
   *
   * Not tidiness. The memo maps and the Bell map are keyed by realm id, and ids
   * are never recycled (world/realms.ts) — so a stale row can never be READ by a
   * later realm. What it would do is grow: one row per instance per evening, for
   * the life of the process, in six maps. Small, unbounded, and exactly the kind
   * of leak nobody finds because nothing ever breaks.
   */
  const forgetRealmMemos = (realmId: string): void => {
    clearBell(realmId);
    lastTurnKeys.delete(realmId);
    lastPartyKeys.delete(realmId);
    lastEffectsKeys.delete(realmId);
    lastProjectilesKeys.delete(realmId);
    lastGroundKeys.delete(realmId);
    lastShopKeys.delete(realmId);
    clearedRealms.delete(realmId);
    residentCounts.delete(realmId);
  };

  const reaps = new Map<string, NodeJS.Timeout>();

  const cancelReap = (realmId: string): void => {
    const t = reaps.get(realmId);
    if (t === undefined) return;
    clearTimeout(t);
    reaps.delete(realmId);
  };

  const reapIfEmpty = (realm: Realm): void => {
    const realms = opts.realms;
    if (realms === undefined || isShared(realm.kind)) return;
    if (realm.world.allActors().some((a: Actor) => a.kind === ActorKind.Player)) return;

    if (realm.lingerMs <= 0) {
      cancelReap(realm.id);
      if (realms.close(realm.id)) {
        forgetRealmMemos(realm.id);
        app.log.info({ realmId: realm.id }, 'instance closed on the last body out');
      }
      return;
    }

    cancelReap(realm.id);
    const timer = setTimeout(() => {
      reaps.delete(realm.id);
      const still = realms.get(realm.id);
      // Re-checked at FIRE TIME, not trusted from arm time. `cancelReap` covers
      // the ordinary return, but a body can also arrive by a path that never
      // touches it (a reconnect resolving into this realm), and reaping a floor
      // out from under somebody would leave their socket rendering a map the
      // server no longer holds.
      if (still === undefined) return;
      if (still.world.allActors().some((a: Actor) => a.kind === ActorKind.Player)) return;
      if (realms.close(realm.id)) {
        forgetRealmMemos(realm.id);
        app.log.info({ realmId: realm.id }, 'instance reaped after its linger');
      }
    }, realm.lingerMs);
    timer.unref?.();
    reaps.set(realm.id, timer);
  };

  /**
   * ═════════════════════════════════════════════════════════════════════════
   * THE WAY OUT. The tile you came in on is the door you leave by.
   * ═════════════════════════════════════════════════════════════════════════
   *
   * No new art, no new glyph, no second authored map: a site's spawn tiles are
   * its threshold. This works only because ARRIVAL IS NOT A MOVE — `crossIntoSite`
   * and this run from `handleMove` alone, so being placed on the threshold cannot
   * eject you on the instant you arrive, and stepping back onto it later can.
   *
   * ═══ WHERE YOU COME BACK OUT ═══
   * The overworld cell you were standing on when you crossed in, remembered on
   * the session. Returning to the city's single spawn instead would teleport a
   * party from Gearford to the office doorstep, which is a fast-travel system
   * nobody asked for and a long walk silently deleted.
   *
   * ═══ AN ENCOUNTER IS SEALED ON THE WAY OUT ═══
   * Fleeing has to cost something. A breach left standing would let a party step
   * out, heal, and step back into a fight frozen exactly as they left it —
   * making "run away" and "pause the fight" the same verb. See `Realm.sealed`.
   */
  const leaveRealm = (session: Session): boolean => {
    const realms = opts.realms;
    const actorId = session.actorId;
    if (realms === undefined || actorId === null || session.realmId === null) return false;

    const from = realms.get(session.realmId);
    /**
     * ═════════════════════════════════════════════════════════════════════════
     * YOU MAY LEAVE ANY MAP YOU WALKED INTO. YOU MAY NOT LEAVE THE ONE YOU WOKE
     * UP ON.
     * ═════════════════════════════════════════════════════════════════════════
     *
     * THIS READ `from.kind === RealmKind.Overworld` AND IT WOULD HAVE STRANDED
     * SOMEBODY PERMANENTLY. The rule it encoded — *"the overworld's edge is the
     * edge of the world"* — is true of Alderbrook and is a statement about the
     * ONE map that existed when it was written. A second landmass is an
     * overworld too, so the first player to cross into the dark territory would
     * have found the door refusing to open from the far side, with no verb in
     * the protocol that could have brought them home. It is the fifth of the
     * four second-landmass blockers, and the only one that ends somebody's
     * character.
     *
     * The honest test is not what KIND of place this is, it is whether there is
     * anywhere to go back TO. `Session.enteredFromRealm` is set only by
     * `crossIntoRealm` when leaving an overworld, so:
     *
     *   Alderbrook — you woke up there, nothing recorded, refused. Unchanged.
     *   The Redaction — you walked in from Alderbrook, so the way back is the
     *     way you came, which is what `leaveRealm` already computes below.
     *
     * A body that arrives by reconnect rather than by walking has no record and
     * is refused, which is the same conservative answer as before and the reason
     * this is a `null` check rather than a kind check.
     */
    if (from === undefined) return false;
    if (from.kind === RealmKind.Overworld && session.enteredFromRealm === null) return false;

    const body = from.world.getActor(actorId);
    if (body === undefined || body.kind !== ActorKind.Player || !body.alive) return false;

    const onThreshold = from.spawns.some((t) => t.x === body.x && t.y === body.y);
    if (!onThreshold) {
      // Stepped off the doorstep. From here, standing on it again means leaving.
      session.exitArmed = true;
      return false;
    }
    // On the threshold, but they have not left it since arriving — this is the
    // shuffle across a six-tile spawn cluster, not a decision to go. See
    // `Session.exitArmed`.
    if (!session.exitArmed) return false;

    /**
     * BACK THE WAY YOU CAME IN, and `realms.overworld` only as the fallback.
     *
     * The fallback is not dead code: a body can be standing in a delve without
     * this session having recorded an entry — a reconnect resolves into whatever
     * realm holds the body, and `hello` does not replay the walk that put it
     * there. Sending that player to the one overworld is the same answer this
     * line has always given, and it is the right one while there is one map.
     */
    const cameFrom =
      session.enteredFromRealm === null ? undefined : realms.get(session.enteredFromRealm);
    const to =
      cameFrom !== undefined && cameFrom.kind === RealmKind.Overworld ? cameFrom : realms.overworld;
    // ONE-WAY, AND ONLY FOR AN AMBUSH. A delve stays open behind you.
    if (from.lingerMs === 0) from.sealed = true;

    from.world.removePlayer(actorId);
    broadcast(
      { v: PROTOCOL_VERSION, t: 'left', id: actorId },
      session.connId,
      audienceFor(from.id),
    );

    const definition = body.classId === undefined ? undefined : classById(body.classId);
    const placed = to.world.addPlayer(
      actorId,
      body.name,
      definition === undefined ? undefined : overlayFor(definition),
    );
    carryAcross(body, placed);
    // BACK WHERE THEY WENT IN, when the tile is still free. `placeAtSpawn` has
    // already put a body somewhere legal, so a taken doorstep costs a step of
    // accuracy rather than an error.
    const back = session.enteredFrom;
    if (back !== null && to.world.actorAt(back.x, back.y) === undefined) {
      const moved = to.world.placeAt(actorId, back);
      if (!moved) app.log.warn({ actorId, back }, 'could not restore the entry tile');
    }
    session.enteredFrom = null;
    // CLEARED WITH THE TILE IT DESCRIBES. Two halves of one fact, and a stale
    // realm id under a null coordinate would be a doorway to nowhere.
    session.enteredFromRealm = null;
    // Back in the open. The next door they walk into arms from scratch.
    session.exitArmed = false;

    to.engine.join(actorId);
    to.engine.setConnected(actorId, true);
    session.realmId = to.id;
    sendRealm(session);
    // WALKING OUT OF A SHOP IS ALSO A SHOP EVENT. Sent after the routing moves,
    // so this resolves to the room they arrived in — and silent when that room
    // has no shelves, which is what takes the tab away again.
    sendShopIfAny(session);
    announceArrival(session, to, to.name);
    broadcast(
      {
        v: PROTOCOL_VERSION,
        t: 'joined',
        actor: toActorView(to.world.getActor(actorId) ?? placed),
      },
      session.connId,
      audienceFor(to.id),
    );

    app.log.info({ actorId, from: from.id, sealed: from.sealed, to: to.id }, 'a body left a realm');
    reapIfEmpty(from);
    // BOTH ENDS OF THE DOOR, and `from` may already have been reaped — pumping
    // a realm that no longer exists is why this names them rather than looking
    // them up again.
    pumpAndBroadcast(to);
    if (opts.realms?.get(from.id) !== undefined) pumpAndBroadcast(from);
    return true;
  };

  const crossIntoSite = (session: Session): void => {
    const realms = opts.realms;
    const actorId = session.actorId;
    if (realms === undefined || actorId === null || session.realmId === null) return;

    const from = realms.get(session.realmId);
    if (from === undefined) return;
    const body = from.world.getActor(actorId);
    if (body === undefined || body.kind !== 'player' || !body.alive) return;

    /**
     * A ROAMER FIRST. It is standing on the tile, so it is the more specific
     * answer, and it is CONSUMED — walking into the thing you could see is the
     * decision the overworld exists to offer, and it must not still be there
     * when you come back out.
     */
    const roamer = roamerAt(from, body.x, body.y);
    if (roamer !== undefined) {
      from.roamers.delete(roamer.id);
      /**
       * ═══════════════════════════════════════════════════════════════════════
       * WHERE THEY WERE STANDING DECIDES WHAT THE FIGHT IS.
       * ═══════════════════════════════════════════════════════════════════════
       *
       * The moor has a forest, a range, a fen and a coast, and until now every
       * one of them was scenery: whatever ground a roamer caught you on, the room
       * you woke up in was the same 24x24 walk through the same two tile codes.
       * So the map was a picture you crossed rather than country you got caught
       * in, and the trees existed only as a shape to route around.
       *
       * READ HERE AND NOWHERE ELSE, from the tile the body is ACTUALLY on — this
       * runs after the pump, so the step has resolved and `body.x/y` is the cell
       * they finished on rather than the one they aimed at. One call, no state,
       * and `groundAt` is pure, so the same tile is the same fight for everybody.
       */
      const ground = groundAt(from.world.level, body.x, body.y);
      /**
       * AND THE CREATURE THEY WERE LOOKING AT.
       *
       * `roamer.name` has been in this log line since roamers landed — the
       * player was always TOLD what they walked into, and then fought whatever
       * the roster produced regardless. The identity was right here and simply
       * never went any further. `ambushRoster` carries the full argument.
       *
       * `monsterById` rather than the roamer holding a template: a realm is
       * state and a template is content, so the roamer stores an id. An id this
       * build does not know resolves to `undefined` and the ambush is the one
       * it always was, which is the correct answer for a save written by a
       * build that had a creature this one does not.
       */
      crossInto(
        session,
        ENCOUNTER_SITE,
        `walked into ${roamer.name}`,
        ground,
        monsterById(roamer.templateId),
      );
      return;
    }

    const siteId = from.sites.get(`${body.x},${body.y}`);
    if (siteId === undefined) return;

    const site = SITES.get(siteId);
    if (site === undefined) {
      // The map names a door this build has no room behind. A content bug, not a
      // player one: logged, and the step is an ordinary step.
      app.log.warn(
        { siteId, realmId: from.id },
        'a site cell names a site this build does not have',
      );
      return;
    }

    crossInto(session, site, 'walked in');
  };

  /**
   * Move a body into a site's realm, whatever decided it should go.
   *
   * SPLIT FROM `crossIntoSite` SO AN AMBUSH AND A DOORWAY CROSS IDENTICALLY.
   * They differ only in what asked — a Map lookup on the tile, or a d100 on the
   * ground you are standing on — and everything after that must not differ at
   * all: the same party keying, the same idempotent `open`, the same carry-across
   * of hp and bag and doll, the same frame order. Two crossing paths would be two
   * places for a body to arrive without its coat.
   *
   * `why` reaches only the log. It is what makes "I was suddenly somewhere else"
   * answerable after the fact.
   */
  const crossInto = (
    session: Session,
    site: SiteDef,
    why: string,
    ground?: Ground,
    lead?: MonsterTemplate,
  ): void => {
    const realms = opts.realms;
    const actorId = session.actorId;
    if (realms === undefined || actorId === null) return;

    // A SOLO PLAYER IS A PARTY OF ONE, which is what `partyOf` mints on demand
    // rather than something invented here (engine/party.ts:276-290). With no
    // party table the actor's own id is the same statement.
    const partyId = opts.parties === undefined ? actorId : partyIdOf(opts.parties, actorId);
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE ROOM IS BUILT FOR THE PEOPLE WALKING INTO IT.
     * ═══════════════════════════════════════════════════════════════════════
     * Until this was threaded through, every ambush contained the whole
     * bestiary — a husk, a wraith AND the sixty-hit-point elite — including
     * the first one a level-1 stranger ever met. Walking a full first session
     * is what surfaced it: dead in twenty seconds, level 1, empty bag, and
     * that was the entire game they saw.
     *
     * MEASURED FROM THE PARTY, NOT THE CROSSER. One person opening a door for
     * a party of four is opening it for four, and the room should know.
     */
    const members = opts.parties === undefined ? [actorId] : membersOf(opts.parties, actorId);
    const levels = members.flatMap((id) => {
      const body = opts.realms?.realmOf(id)?.world.getActor(id);
      return body !== undefined && body.kind === ActorKind.Player ? [body.level] : [];
    });
    crossIntoRealm(
      session,
      realms.open(
        site,
        partyId,
        {
          level: partyMaxLevel(levels),
          size: Math.max(1, levels.length),
        },
        // ABSENT FOR A DOOR, which is every site but one: a town is the same town
        // whichever direction you walked in from. See `SiteDef.map`.
        ground,
        // AND SO IS THIS, for the same reason and the same one site.
        lead,
      ),
      why,
      site.id,
    );
  };

  /**
   * Move a body into a realm that ALREADY EXISTS.
   *
   * SPLIT OUT OF `crossInto` SO FOLLOWING A FRIEND CROSSES IDENTICALLY TO
   * WALKING THROUGH A DOOR. `crossInto` decides WHICH room by opening a site
   * keyed to the party; `follow` decides which room by asking where somebody
   * already is. Everything after that decision must not differ at all — the same
   * carry-across of hp and bag and doll, the same removal from the old floor,
   * the same frame order — or a followed body arrives without its coat and the
   * bug is reported as "following loses your gear".
   */
  const crossIntoRealm = (session: Session, to: Realm, why: string, label: string): void => {
    const realms = opts.realms;
    const actorId = session.actorId;
    if (realms === undefined || actorId === null || session.realmId === null) return;
    const from = realms.get(session.realmId);
    if (from === undefined) return;
    const body = from.world.getActor(actorId);
    if (body === undefined || body.kind !== ActorKind.Player || !body.alive) return;

    // Already there. `open` is idempotent and `realmOf` answers the realm they
    // are in, so both callers can produce this and both mean "nothing to do".
    if (to.id === from.id) return;

    // WHERE TO PUT THEM BACK. Recorded only when leaving the overworld, so a
    // delve reached from a town would return to the town's doorstep rather than
    // to a city cell nobody was standing on.
    if (from.kind === RealmKind.Overworld) {
      session.enteredFrom = { x: body.x, y: body.y };
      // AND WHICH MAP THOSE COORDINATES BELONG TO. See `Session.enteredFromRealm`.
      session.enteredFromRealm = from.id;
    }

    // ═══ REMOVE, THEN PLACE, AND THE ORDER MATTERS FOR THE OLD FLOOR ═══
    // `left` is what takes the token off everybody else's screen in the realm
    // being left; without it a body would stand in the doorway on four other
    // maps forever, because client/main.ts forbids inferring removal from
    // absence. The old world drops the body first so nothing can act on it
    // between the two worlds.
    from.world.removePlayer(actorId);
    // EXCEPT THE PERSON LEAVING. Their own client is about to be handed a whole
    // new board by the `realm` frame below, and `case 'left'` deletes an actor
    // from the map it is currently drawing — harmless in that order, and one
    // fewer frame whose correctness depends on an ordering.
    broadcast(
      { v: PROTOCOL_VERSION, t: 'left', id: actorId },
      session.connId,
      audienceFor(from.id),
    );

    const definition = body.classId === undefined ? undefined : classById(body.classId);
    const placed = to.world.addPlayer(
      actorId,
      body.name,
      definition === undefined ? undefined : overlayFor(definition),
    );
    carryAcross(body, placed);

    // THE NEW FLOOR'S SCHEDULER LEARNS ABOUT THEM. `join` clears any stale
    // Standing By in that realm's barrier and `setConnected` puts them in its
    // quorum — both idempotent, and both are what `hello` does for a fresh body.
    // ARRIVING DISARMS THE DOOR. Whatever this body did on the last floor, it
    // has not yet stepped off THIS threshold, so the tile it is about to be
    // placed on must not also be the tile that ejects it.
    session.exitArmed = false;

    // SOMEBODY CAME BACK. The countdown is cancelled outright rather than
    // paused, so the five minutes restart from zero when they leave again —
    // which is what "the timer does not start until the player leaves again"
    // means, and it is why a party that keeps returning keeps its floor.
    cancelReap(to.id);

    to.engine.join(actorId);
    to.engine.setConnected(actorId, true);

    // AND THE ROUTING MOVES, BEFORE ANY FRAME GOES OUT. Every helper below
    // resolves through `realmFor`, so a frame sent while this still said the old
    // realm would be addressed to the room they just left.
    session.realmId = to.id;

    // THE MAP, TO THEM. Unicast, and the one frame in the protocol that carries
    // a new level mid-session — `welcome` cannot, because the client's handler
    // for it clears the case log, the bag and the party panel, and walking
    // through a door is not a new session. See `RealmMsg`.
    sendRealm(session);
    // AND THE SHELVES OF THE ROOM THEY WALKED INTO, or silence if it has none.
    // A town is the common destination, so this is the frame that makes the
    // shop tab appear at the moment somebody steps through the door.
    sendShopIfAny(session);
    // AND THE ROOM SAYS WHAT IT IS. The one movement worth narrating — see
    // `announceArrival`, and `recordFor`'s `move` case for why a step is not.
    announceArrival(session, to, to.name);

    // AND THE TOKEN, TO EVERYONE ALREADY IN THERE. `joined` is how a body
    // appears on a client that has a board already; the crosser's own copy came
    // in the `realm` frame's actor list a line ago, so they are excluded.
    broadcast(
      { v: PROTOCOL_VERSION, t: 'joined', actor: toActorView(placed) },
      session.connId,
      audienceFor(to.id),
    );

    app.log.info(
      { actorId, site: label, why, from: from.id, to: to.id, kind: to.kind },
      'a body crossed into a site',
    );

    /**
     * ═════════════════════════════════════════════════════════════════════════
     * AND THE ROOM THEY LEFT MAY NOW BE EMPTY. `leaveRealm` HAS ALWAYS DONE THIS.
     * ═════════════════════════════════════════════════════════════════════════
     *
     * There are three ways the last body leaves an instance — walking back out
     * of the door (`leaveRealm`), FOLLOWING somebody into another realm (here),
     * and the reconnect grace expiring where they stood (`recallBody`) — and
     * only the first armed the reaper. So `INSTANCE_LINGER_MS`, which says a
     * delve waits five minutes for you and is then thrown away, waited FOREVER
     * through this path: `Realms.open` hands a party back its existing
     * non-sealed instance, so a party that cleared the Underworks in the
     * morning, followed a friend out and came back that evening got their
     * morning floor — every monster dead, every chest open, no loot and no
     * fight.
     *
     * IT IS WORSE FOR AN AMBUSH, whose `lingerMs` is 0 for a reason of its own:
     * *"fleeing has to MEAN something. If the breach you ran out of were still
     * there thirty seconds later, running would be a way to save-scum a fight."*
     * Following a party member out of a breach left the breach standing.
     *
     * The overworld and the towns are refused twice over — `reapIfEmpty` returns
     * on `isShared` before it asks anything, and `Realms.close` refuses a shared
     * realm outright — which matters because this is the path a body takes out
     * of Alderbrook, and Alderbrook is routinely empty at four in the morning.
     */
    reapIfEmpty(from);

    // BOTH BARRIERS JUST CHANGED SHAPE — one lost a member, one gained one — so
    // BOTH are named. This used to rely on `pumpAndBroadcast` ticking every
    // realm in the process; naming them is the same settlement at a fraction of
    // the cost, and it says which two realms this act was actually about.
    //
    // GUARDED, because the line above may just have closed `from` — pumping a
    // realm that no longer exists is the same trap `leaveRealm` names.
    if (realms.get(from.id) !== undefined) pumpAndBroadcast(from);
    pumpAndBroadcast(to);
  };

  /**
   * ═════════════════════════════════════════════════════════════════════════
   * `shop_buy` / `shop_sell` — VALIDATE, DEBIT, MOVE, LOG.
   * ═════════════════════════════════════════════════════════════════════════
   *
   * FOUR STEPS AND NOT FIVE FUNCTIONS. ToME's transaction is `tryBuy` ->
   * `doBuy` -> `onBuy(before)` -> `transfer` -> `onBuy(after)`, and `doBuy`
   * re-finds the object and re-checks `who.money` a SECOND time inside the
   * confirm — because a modal dialog fires its callbacks across frames and the
   * world can move in between. Non-negotiable #2 says turn resolution here is
   * fully synchronous: there is no interleaving window, so there is nothing to
   * re-check.
   *
   * ═══ NEITHER COSTS A TURN, AND THAT IS OURS RATHER THAN A PORT ═══
   * `spendLootTurn` charges for reaching into the world, and upstream charges
   * for a pickup on exactly that argument (Player.lua:1313-1315). A shop is not
   * in the world: it is a menu you stand in front of, in a town, where
   * `assertNoCombatInSharedSpace` guarantees nothing is hunting you. Charging a
   * turn per purchase would make outfitting a character cost a dozen turns of a
   * clock with no reason to be running.
   *
   * ═══ THE SHELF IS THE REALM'S, SO THE DOOR IS THE PERMISSION ═══
   * There is no "are you next to the shopkeeper" check because there is no
   * shopkeeper: the shop belongs to the realm, and being in the realm is being
   * at it. A player in a breach naming a coat on Threadneedle Row is refused
   * because THEIR realm has no shelf, not because a distance test failed.
   */
  /**
   * WHAT A PLAYER CALLS THE PART OF THEM A SLOT IS. `Slot` is a wire token —
   * `offhand`, `trinket` — and reading one back to somebody is the interface
   * talking about itself. "Nothing on your shield arm yet" is a sentence.
   */
  const SLOT_WORDS: Readonly<Record<Slot, string>> = {
    head: 'head',
    body: 'back',
    legs: 'legs',
    feet: 'feet',
    offhand: 'shield arm',
    ring: 'hands',
    trinket: 'pockets',
  };

  const handleShopBuy = (session: Session, msg: ClientShopBuy): void => {
    const realm = realmFor(session);
    const actorId = session.actorId;
    if (actorId === null) {
      sendError(session.socket, ErrorCode.NotAuthenticated, 'send hello before shopping');
      return;
    }
    unparkOnCommand(session);

    const full = opts.realms?.get(realm.id);
    const shop = full?.shop;
    if (full === undefined || shop === undefined) {
      sendError(session.socket, ErrorCode.IllegalMove, 'there is no shop here');
      return;
    }
    const body = realm.world.getActor(actorId);
    if (body === undefined || body.kind !== ActorKind.Player || !body.alive) {
      sendError(session.socket, ErrorCode.IllegalMove, 'you cannot shop right now');
      return;
    }

    // THE SHELF CATCHES UP ON THE DOOR, not on a timer — see world/shopstate.ts.
    // Before the lookup, so a player who levelled since arriving can buy the
    // thing the restock just put out.
    catchUpShop(full, partyLevelIn(full));

    /**
     * BY INDEX, and the first match. Two identical coats are two slots (see
     * `ShopSlot`), so "the one with this id" is ambiguous about WHICH — and the
     * first is the only answer that matches what the player clicked, because
     * the client draws them in this order.
     */
    const index = shop.stock.findIndex((slot) => slot.id === msg.itemId);
    if (index < 0) {
      // Somebody in the room bought it between the frame and the click. The
      // shelf frame is already on its way; this says why the click did nothing.
      sendError(session.socket, ErrorCode.IllegalMove, 'somebody got there first');
      return;
    }

    const price = buyPrice(msg.itemId, stockLevelFor(partyLevelIn(full)));
    /**
     * THE AFFORDABILITY TEST IS EXPLICIT, AND IT HAS TO BE. `incMoney` CLAMPS
     * AT ZERO, so debiting first and checking afterwards would hand the item
     * over and quietly set the purse to nothing. The clamp is right for a purse
     * and exactly wrong as a test.
     */
    if (body.money < price) {
      sendError(session.socket, ErrorCode.IllegalMove, `that costs ${String(price)} gold`);
      return;
    }

    const bag = bagOf(body);
    if (alreadyOwns(body, msg.itemId)) {
      sendError(session.socket, ErrorCode.BadMessage, 'you already have one of those');
      return;
    }
    if (bag.length >= INVENTORY_CAP) {
      sendError(session.socket, ErrorCode.IllegalMove, 'your evidence bag is full');
      noteBagFull(body);
      return;
    }

    // ═══ ONE STEP, NO AWAIT, NOTHING BETWEEN THEM ═══
    const taken = takeFromShelf(full, index);
    if (taken === undefined) {
      sendError(session.socket, ErrorCode.IllegalMove, 'somebody got there first');
      return;
    }
    incMoney(body, -price);
    body.carried = [...bag, taken.id];

    const item = resolveItem(taken.id);
    broadcastRecordLine(
      realm,
      `${nameOf(actorId)} buys the ${item?.name ?? 'item'} for ${String(price)} gold.`,
    );
    saveLoot('buy');
    // BOTH FRAMES, UNCONDITIONALLY. The purse rides `inventory` and the shelf
    // rides `shop`, and a buy moves both — sending one would draw a tab whose
    // prices no longer match the gold beside them.
    sendInventory(session);
    broadcastShopIfChanged(realm);
    pumpAndBroadcast(realm);
  };

  const handleShopSell = (session: Session, msg: ClientShopSell): void => {
    const realm = realmFor(session);
    const actorId = session.actorId;
    if (actorId === null) {
      sendError(session.socket, ErrorCode.NotAuthenticated, 'send hello before shopping');
      return;
    }
    unparkOnCommand(session);

    const full = opts.realms?.get(realm.id);
    if (full === undefined || full.shop === undefined) {
      sendError(session.socket, ErrorCode.IllegalMove, 'there is no shop here');
      return;
    }
    const body = realm.world.getActor(actorId);
    if (body === undefined || body.kind !== ActorKind.Player || !body.alive) {
      sendError(session.socket, ErrorCode.IllegalMove, 'you cannot shop right now');
      return;
    }

    // AGAINST THE SENDER'S OWN BAG AND NOTHING ELSE — the same resolution
    // `equip` and `drop` use, and the reason a forged id buys nothing.
    const bag = bagOf(body);
    if (!bag.includes(msg.itemId)) {
      sendError(session.socket, ErrorCode.BadMessage, 'you are not carrying that');
      return;
    }
    const price = sellPrice(msg.itemId);
    if (price <= 0) {
      // Money, or an id this build cannot price. Refused rather than taken for
      // nothing: a shop that accepts a thing and pays no gold for it is a bug
      // that reads as theft.
      sendError(session.socket, ErrorCode.BadMessage, 'the shop will not take that');
      return;
    }

    // ONE COPY, NOT EVERY MATCH. `carried` is a set of ids today so the two are
    // the same thing — written as "the first match" so that the day a bag holds
    // two of something, selling one sells one.
    const at = bag.indexOf(msg.itemId);
    body.carried = [...bag.slice(0, at), ...bag.slice(at + 1)];
    incMoney(body, price);
    // FLAGGED, so the next restock clears it — the two lines upstream that stop
    // a shop becoming free storage and stop a sell-then-rebuy loop persisting
    // junk.
    addSoldItem(full, msg.itemId);

    const item = resolveItem(msg.itemId);
    broadcastRecordLine(
      realm,
      `${nameOf(actorId)} sells the ${item?.name ?? 'item'} for ${String(price)} gold.`,
    );
    saveLoot('sell');
    sendInventory(session);
    broadcastShopIfChanged(realm);
    pumpAndBroadcast(realm);
  };

  /** Party level as the room sees it — see `shopFrameFor`. */
  const partyLevelIn = (realm: Realm): number =>
    partyMaxLevel(
      realm.world.allActors().flatMap((a) => (a.kind === ActorKind.Player ? [a.level] : [])),
    );

  /**
   * ═════════════════════════════════════════════════════════════════════════
   * `follow` — GO TO A PARTY MEMBER WHO IS SOMEWHERE ELSE.
   * ═════════════════════════════════════════════════════════════════════════
   *
   * THE HOLE THIS FILLS. An instance is opened keyed by PARTY, so when one
   * member walks into a breach the room belongs to the whole party — but the
   * roamer that pulled them in is consumed by the crossing, so the tile that
   * was the door is gone. The second player stood on the overworld watching a
   * fight they were entitled to join and had no way to reach. Reported from
   * play as "there is no way to enter the encounter space".
   *
   * ═══ THE PERMISSION IS STRUCTURAL, NOT A LOOKUP THE CLIENT CAN AIM ═══
   * The check is `sameParty(sender, target)` — a question about two ids, only
   * one of which the sender controls. Naming somebody you are not in a party
   * with is refused; naming somebody you ARE in a party with takes you to a
   * room that was already yours. So a forged `targetId` buys nothing, which is
   * a stronger property than an ownership check because there is no query here
   * that could be written to span two parties.
   *
   * ═══ IT COSTS NO TURN, DELIBERATELY ═══
   * `spendLootTurn` charges for reaching into the world (Player.lua:1313-1315).
   * This is not that: it is the client half of a social act that already
   * happened when your friend walked through a door. Charging for it would mean
   * a party member who followed arrived a turn behind the fight they were
   * invited into, which is the opposite of the point.
   */
  const handleFollow = (session: Session, msg: ClientFollow): void => {
    const realms = opts.realms;
    const actorId = session.actorId;
    if (actorId === null) {
      sendError(session.socket, ErrorCode.NotAuthenticated, 'send hello before following');
      return;
    }
    if (realms === undefined) {
      sendError(session.socket, ErrorCode.Internal, 'this server has no realms to follow into');
      return;
    }
    // Somebody is at the keyboard, so the class-choice park comes off — the
    // same rule `handleMove` and `handleTalent` apply before their rulings.
    unparkOnCommand(session);

    const { world } = realmFor(session);
    const body = world.getActor(actorId);
    if (body === undefined || !body.alive) {
      sendError(session.socket, ErrorCode.IllegalMove, 'you cannot follow anyone right now');
      return;
    }
    // A body on the floor is being carried, not walking. The party pane already
    // greys the control for this case (`canFollow`); this is the ruling behind
    // it, because a control the client draws is never the rule.
    if (opts.downed !== undefined && isDowned(opts.downed, actorId)) {
      sendError(session.socket, ErrorCode.IllegalMove, 'you are down — somebody has to reach you');
      return;
    }

    // THE ONE PERMISSION. Not "is this id in a party" but "is it in MINE".
    if (opts.parties !== undefined && !sameParty(opts.parties, actorId, msg.targetId)) {
      sendError(session.socket, ErrorCode.BadMessage, 'they are not in your party');
      return;
    }
    if (opts.parties === undefined && msg.targetId !== actorId) {
      sendError(session.socket, ErrorCode.BadMessage, 'they are not in your party');
      return;
    }

    const theirs = realms.realmOf(msg.targetId);
    if (theirs === undefined) {
      // Their body is nowhere — they left the game between the frame being
      // drawn and the click. Answered rather than swallowed: the pane is about
      // to correct itself, and a silent no-op reads as a dead button.
      sendError(session.socket, ErrorCode.IllegalMove, 'they are not anywhere you can reach');
      return;
    }
    if (theirs.id === session.realmId) {
      sendError(session.socket, ErrorCode.IllegalMove, 'they are already here with you');
      return;
    }

    crossIntoRealm(session, theirs, `followed ${nameOf(msg.targetId)}`, theirs.id);
    // THE ROOM THEY ARRIVED IN, and after the crossing so the arriving player's
    // own socket is already addressed to it. `homeOf` is how every other
    // player-visible act finds its audience; a follow is one.
    broadcastRecordLine(homeOf(actorId), `${nameOf(actorId)} catches up.`);
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
    const { engine } = realmFor(session);
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

    pumpAndBroadcast(realmFor(session));
  };

  /**
   * `commit` and `hold` — the two frames that drive the barrier.
   *
   * One function because the failure handling is identical and the difference is
   * one method call; splitting them would duplicate the not-authenticated check
   * and the error path, which is where a divergence would eventually hide.
   */
  const handleTurnVerb = (session: Session, verb: 'commit' | 'hold'): void => {
    const { engine } = realmFor(session);
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

    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THIS REALM, NOT EVERY REALM — and SPACE is the most-pressed key there is.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `pumpAndBroadcast()` with no argument walks `pumpTargets()` and pumps the
     * WHOLE PROCESS: the overworld, five towns, and every open delve instance.
     * `handleMove` and `handleTalent` both pass `realmFor(session)` and always
     * have; these two did not, so committing cost six to nine times the work a
     * step did — and `refreshViewers` and `broadcastTurnIfChanged` each walk
     * every session in the process once per realm, so the cost scales with
     * players times realms.
     *
     * ═══ THE OPEN ROUND MADE IT WORSE, WHICH IS WHY IT IS FIXED NOW ═══
     * SPACE used to be one keypress per player per turn. With the round staying
     * open it is one per ROUND — pressed whenever somebody finishes early rather
     * than spending their whole budget — so the frequency went up at the same
     * moment the per-press cost mattered most.
     *
     * A commit changes THIS party's quorum and nothing else. No other realm's
     * barrier can move because somebody in a different world pressed a key.
     */
    pumpAndBroadcast(realmFor(session));
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
    // WHEREVER THAT BODY IS. The Case Log narrates one realm at a time, but a
    // name is a fact about an actor and not about a floor, and threading a world
    // through `recordFor`'s twelve call sites would put a parameter on every
    // sentence in the game to answer a question `homeOf` answers in one lookup.
    homeOf(id).world.getActor(id)?.name ?? reapedNames.get(id) ?? 'someone';

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
    // THE CASTER'S OWN REALM'S ENGINE, for `nameOf`'s reason. Every realm's
    // engine is built over the same shared talent registry (main.ts's
    // `engineFor`), so this is the same answer wherever it is asked — asking the
    // right one costs nothing and cannot go stale the day that stops being true.
    homeOf(casterId)
      .engine.loadoutOf(casterId)
      .find((talent) => talent.id === talentId)?.name ?? prettyId(talentId);

  /**
   * One turn event -> zero or more Record lines.
   *
   * TWO DEPTHS, exactly as the sample log is written: a headline for the thing
   * that happened, and indented consequences hanging off it. `attack` is the
   * headline and its `damage` and `death` are the consequences, which is why a
   * landed blow does not repeat the victim's name at depth 0.
   */
  /**
   * ═════════════════════════════════════════════════════════════════════════
   * IT NO LONGER NEEDS TO KNOW WHETHER THIS WAS A SWEEP.
   * ═════════════════════════════════════════════════════════════════════════
   * The `isSweep` parameter existed for exactly one case: monster movement,
   * suppressed so a room full of husks did not narrate every step. Now that no
   * movement is narrated at all, the distinction has nothing left to decide —
   * and a parameter nothing reads is a lie about what a function depends on.
   */
  const recordFor = (event: TurnEvent): { text: string; depth: number }[] => {
    switch (event.k) {
      case 'move': {
        /**
         * ═══════════════════════════════════════════════════════════════════
         * A STEP IS NOT NEWS. THE LOG IS FOR THINGS YOU CANNOT SEE.
         * ═══════════════════════════════════════════════════════════════════
         *
         * This used to emit `Ren moves E.` for every step by every player, and
         * driving a real first session is what showed the cost: after a minute
         * of walking, the Case Log's ENTIRE contents were seven identical
         * movement lines. Not "mostly" — the log had nothing else in it at all.
         *
         * The panel is the most valuable strip of text on the screen and it was
         * spending all of it narrating the one thing a player can already see:
         * their own token, moving, on the map they are looking at. Every line
         * that matters — a hit, a drop, a level, "Vell catches up", "Ren buys
         * the coat" — was going to be pushed off the top by footsteps, and with
         * six people walking around a shared overworld it would have scrolled
         * faster than anybody could read.
         *
         * ToME's log agrees and always has: it narrates combat, pickups, level
         * ups and effects. Walking is not in it.
         *
         * ARRIVALS ARE THE EXCEPTION AND THEY ARE SAID ELSEWHERE — see
         * `announceArrival`. Crossing a threshold IS news, because the map
         * changes under you and the people you left cannot see where you went.
         */
        return [];
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
          /**
           * ═══════════════════════════════════════════════════════════════════
           * ...AND WHAT IT DID, WHICH THE DAMAGE LINES CANNOT SAY.
           * ═══════════════════════════════════════════════════════════════════
           *
           * `TalentEvent.notes` — sentences the talent composed about itself.
           * They were authored by all twelve talents, carried the whole way
           * here, and rendered by nobody: "is pinned against the wall",
           * "raises the curtain over Sam for 3 turns", "Cross, radius 1.",
           * "turns on Dalt.", "Nothing was hunting Sam." A Ward Rush that shoved
           * somebody into a wall used to log its damage and stop.
           *
           * DEPTH 1, under the "uses" line, which is exactly where
           * game-design.md § 11's sample Record puts them — indented beneath
           * the verb they belong to, in the same band as the damage they sit
           * beside.
           *
           * ALREADY FINISHED SENTENCES. Nothing is composed here: the talent
           * knows its own numbers and this function does not, which is the same
           * division that keeps every displayed number server-side.
           */
          ...(event.notes ?? []).map((text) => ({ text, depth: 1 })),
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
      case 'downed': {
        // DEPTH 0 AND ITS OWN LINE. This is the loudest thing that happens in a
        // fight and it starts a five-turn clock; burying it under the blow that
        // caused it would be the log editorialising in the wrong direction.
        //
        /**
         * ═══════════════════════════════════════════════════════════════════
         * "TURNS TO REACH THEM" IS ADDRESSED TO SOMEBODY. ALONE, THERE IS
         * NOBODY.
         * ═══════════════════════════════════════════════════════════════════
         * game-design.md § 9 calls Downed the mechanic that "does more for
         * co-op tension than anything else: it turns 'I died' into GET TO ME".
         * That is exactly right with a party — and read by a solo player it is
         * an instruction addressed to nobody, about help that is not coming.
         *
         * The countdown is the same countdown either way. What changes is what
         * it MEANS: with somebody else on the floor it is a rescue window, and
         * alone it is how long the run has left. Saying the second thing as
         * though it were the first is the game misreading the room at the one
         * moment a player is paying complete attention.
         */
        const others = homeOf(event.id)
          .world.allActors()
          .filter((a) => a.kind === ActorKind.Player && a.id !== event.id && a.alive).length;
        return [
          {
            text:
              others > 0
                ? `${nameOf(event.id)} is DOWN — ${String(event.turns)} turns to reach them.`
                : `${nameOf(event.id)} is DOWN — ${String(event.turns)} turns, and nobody is coming.`,
            depth: 0,
          },
        ];
      }
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
  const broadcastRecord = (realm: PumpTarget, result: PumpResult): void => {
    const lines: LogLine[] = [];
    const gameTurn = result.turn.gameTurn;

    const emit = (event: TurnEvent): void => {
      for (const line of recordFor(event)) {
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

    for (const event of result.playerEvents) emit(event);
    for (const event of result.sweep) emit(event);

    /**
     * ═════════════════════════════════════════════════════════════════════════
     * AND WHO LEVELLED — THE ONE SHARED SIGNAL THAT A TALENT POINT EXISTS.
     * ═════════════════════════════════════════════════════════════════════════
     *
     * AFTER BOTH LANES, because a level is caused by the last kill in the pump
     * and must narrate after it. "Ren reaches level 5." above the blow that
     * earned it is the same misreported causality `duringSweep` exists to
     * prevent.
     *
     * ═══ WHY THIS IS IN THE RECORD LANE AND NOT ONLY ON THE PANEL ═══
     * `ProgressMsg` is VIEWER-PRIVATE by design — points in hand are intent, and
     * intent is nobody else's business. That is correct and it leaves a hole:
     * before this line the Case Log, which reports every blow, every status and
     * every death, said NOTHING when somebody levelled, so a party could cross
     * three levels in its first fight and finish the evening with every talent
     * at rank 1 because nothing ever suggested opening the panel. The level
     * itself is not private — it is a fact about a body other people are
     * standing next to — so it goes where the party can see it.
     *
     * ═══ AND IT IS FREE TEXT ON A FRAME THAT ALREADY EXISTS ═══
     * No new `TurnEvent` variant, which src/shared/version.ts records would force
     * a protocol bump on its own. A `LogLine` is text.
     */
    for (const note of result.levelUps ?? []) {
      logSeq += 1;
      lines.push({
        seq: logSeq,
        lane: LogLane.Record,
        gameTurn,
        text: `${nameOf(note.id)} reaches level ${String(note.level)}.`,
        depth: 0,
      });
      /**
       * ═════════════════════════════════════════════════════════════════════
       * AND WHAT TO DO ABOUT IT, WHICH THE LEVEL LINE ALONE NEVER SAID.
       * ═════════════════════════════════════════════════════════════════════
       * The line above exists because `ProgressMsg` is viewer-private and a
       * party could otherwise cross three levels without anybody learning a
       * point had been granted. It half-solved that: it announced the LEVEL and
       * still never mentioned the POINT, so the reader is told something
       * happened and not what it bought them.
       *
       * The count comes from `pointsForLevel`, which is the same function that
       * granted it — a literal "1" here would be wrong on every fifth level,
       * silently, and only for the players who got the better one.
       */
      const granted = pointsForLevel(note.level);
      if (granted > 0) {
        logSeq += 1;
        lines.push({
          seq: logSeq,
          lane: LogLane.Record,
          gameTurn,
          text:
            granted === 1
              ? 'A talent point to spend.'
              : `${String(granted)} talent points to spend.`,
          depth: 1,
        });
      }
    }

    if (lines.length === 0) return;
    // TO THIS FLOOR. The Case Log is a transcript of what happened where you are
    // standing; a party in an instance reading somebody else's fight in the city
    // would be reading about people they cannot see, in a log whose whole value
    // is that every line is about the room.
    broadcast({ v: PROTOCOL_VERSION, t: 'log', lines }, undefined, audienceFor(realm.id));
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
  /**
   * ONE MARGIN LINE, TO ONE PERSON.
   *
   * `broadcastMargin`'s twin, and it exists because a reply that travels only in
   * a broadcast cannot be suppressed for the room without also being suppressed
   * for the person who asked. See `handleTalk` for the failure that shape
   * produces in a town where the game clock does not run.
   *
   * It takes the same `seq` counter, so the asker's copy and the room's copy sort
   * into one conversation rather than two.
   */
  const sendMargin = (
    session: Session,
    realm: PumpTarget,
    line: Omit<LogLine, 'seq' | 'lane' | 'gameTurn'>,
  ): void => {
    logSeq += 1;
    const full: LogLine = {
      seq: logSeq,
      lane: LogLane.Margin,
      gameTurn: realm.world.turn.clock.gameTurn,
      ...line,
    };
    send(session.socket, { v: PROTOCOL_VERSION, t: 'log', lines: [full] });
  };

  const broadcastMargin = (
    realm: PumpTarget,
    line: Omit<LogLine, 'seq' | 'lane' | 'gameTurn'>,
    /**
     * WHO ALREADY HAS THIS LINE.
     *
     * `handleTalk` unicasts the answer to the asker first — see the note there —
     * so without this the asker is in the room's audience too and hears every
     * reply twice. Verified over a socket: one click produced two identical
     * Margin lines.
     */
    exceptConnId?: string,
  ): void => {
    logSeq += 1;
    const full: LogLine = {
      seq: logSeq,
      lane: LogLane.Margin,
      gameTurn: realm.world.turn.clock.gameTurn,
      ...line,
    };
    // TO THE ROOM THE SPEAKER IS IN. Talking across a realm boundary would be a
    // voice from nowhere — the Margin's `speaker` names somebody the recipient
    // has no token for, and `point` puts its marker on a tile of a map they are
    // not looking at. The voice channel is where the party talks across floors.
    broadcast(
      { v: PROTOCOL_VERSION, t: 'log', lines: [full] },
      exceptConnId,
      audienceFor(realm.id),
    );
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
  /**
   * ═════════════════════════════════════════════════════════════════════════
   * THE MOOR TELLS YOU WHAT IT IS CALLED, ONCE, WHEN YOU WALK INTO IT.
   * ═════════════════════════════════════════════════════════════════════════
   *
   * Thirteen markers had names. The 9,327 tiles between them had one, and it was
   * "the overworld" — so everything that happened out there was reported the
   * same way, and six friends in a voice channel had no way to say WHERE
   * anything happened except by reading coordinates at each other.
   *
   * *"I got jumped in the Bracken Waste"* is a sentence. *"I got jumped at
   * 94, 41"* is a bug report. This game is played by people talking to each
   * other and the evening's story IS the product; ground nobody can name is
   * ground nobody can talk about.
   *
   * ═══ UNICAST, AND ON PURPOSE ═══
   * Where you are is your fact. Broadcasting it would put a line on five other
   * screens every time anybody crossed a boundary, which on a six-person server
   * is the Record lane turned into a movement ticker — and the lane exists for
   * the handful of things worth reading. The player says it out loud; that is
   * the mechanism, and it is better than the one the server could provide.
   *
   * ═══ THE OVERWORLD ONLY ═══
   * `regionAt` names Alderbrook's ground. A town interior is one room with a
   * name already on the door, and an ambush arena is not anywhere.
   *
   * ═══ SILENT ON THE FIRST STEP, WHICH IS THE DETAIL THAT MAKES IT PLEASANT ═══
   * A null `region` is filled in without announcing, so arriving in a realm does
   * not immediately tell you the name of the ground you are standing on —
   * `announceArrival` has already said where you are, and two lines about the
   * same act read as a stutter.
   */
  const noteRegion = (session: Session, realm: Realm, x: number, y: number): void => {
    if (realm.kind !== RealmKind.Overworld) return;
    const name = regionAt(x, y);
    const was = session.region;
    session.region = name;
    if (was === null || was === name) return;

    logSeq += 1;
    send(session.socket, {
      v: PROTOCOL_VERSION,
      t: 'log',
      lines: [
        {
          seq: logSeq,
          lane: LogLane.Record,
          gameTurn: realm.world.turn.clock.gameTurn,
          text: `You come to ${name}.`,
          depth: 0,
        },
      ],
    });
  };

  const broadcastRecordLine = (realm: PumpTarget, text: string): void => {
    logSeq += 1;
    broadcast(
      {
        v: PROTOCOL_VERSION,
        t: 'log',
        lines: [
          {
            seq: logSeq,
            lane: LogLane.Record,
            gameTurn: realm.world.turn.clock.gameTurn,
            text,
            depth: 0,
          },
        ],
      },
      undefined,
      audienceFor(realm.id),
    );
  };

  /**
   * ═════════════════════════════════════════════════════════════════════════
   * ARRIVING SOMEWHERE IS THE ONE MOVEMENT WORTH SAYING OUT LOUD.
   * ═════════════════════════════════════════════════════════════════════════
   *
   * A step is not news (`recordFor`'s `move` case says why). Crossing a
   * threshold is: the map changes under you, and the people you just left
   * cannot see where you went.
   *
   * TWO LINES, NOT ONE, and they say different things because the two audiences
   * know different things. The arriver is told WHERE THEY ARE — they are
   * looking at a board that changed a frame ago and nothing else on screen
   * names it. The room is told WHO WALKED IN, which is the half they cannot
   * see coming.
   *
   * A REALM WITH A DESCRIPTION SAYS IT ONCE, on arrival, to the person who
   * arrived. That is the whole of this game's environmental writing today and
   * it is deliberately one sentence: a paragraph nobody asked for, printed
   * every time somebody re-enters a town, becomes something players learn to
   * scroll past — and the log is where the things they must not scroll past
   * live.
   */
  /**
   * The nearest named places, with a compass bearing and a distance.
   *
   * CHEBYSHEV DISTANCE, because movement is eight-way — a diagonal step covers
   * the same ground as an orthogonal one, so a Euclidean number would tell a
   * player something their legs disagree with.
   *
   * THE BEARING IS COARSE ON PURPOSE. Eight compass points, not degrees: this
   * is a sentence somebody reads once and then walks, and "east-north-east" is
   * a number pretending to be a direction.
   */
  const nearestSites = (
    realm: PumpTarget,
    fromX: number,
    fromY: number,
    take: number,
  ): { name: string; bearing: string; distance: number; danger: string | null }[] => {
    const full = opts.realms?.get(realm.id);
    if (full === undefined) return [];

    const out: { name: string; bearing: string; distance: number; danger: string | null }[] = [];
    for (const [cell, siteId] of full.sites) {
      const [sx, sy] = cell.split(',').map(Number);
      if (sx === undefined || sy === undefined || Number.isNaN(sx) || Number.isNaN(sy)) continue;
      const distance = Math.max(Math.abs(sx - fromX), Math.abs(sy - fromY));
      // NOT THE ONE YOU ARE STANDING ON. "Alderbrook — here, 0 tiles" is a line
      // that costs a slot and says nothing; the place's own name is already the
      // headline above it.
      if (distance === 0) continue;
      const def = SITES.get(siteId);
      if (def === undefined) continue;
      /**
       * AND HOW BAD IT IS IN THERE, for a delve.
       *
       * The eight have a real difficulty gradient and it was entirely
       * invisible: the map showed thirteen markers and the only way to tell
       * Blackwood from the Outer Index was to walk into one and find out. A map
       * whose destinations cannot be told apart is a list, and a list is not a
       * decision.
       *
       * TOWNS SAY NOTHING, because there is nothing to warn about — and a
       * "quiet" beside every settlement would train a player to stop reading
       * the word exactly where it matters.
       */
      /**
       * `specFor` AND NOT `DELVES.get`, WHICH IS WHAT THIS SAID.
       *
       * The Redaction's six doors are not rows in `DELVES` — they are derived
       * from their Alderbrook originals — so this lookup answered `undefined`
       * for every one of them, and `undefined` is the TOWN case: no grade, no
       * party hint, nothing. The six hardest rooms in the game would have been
       * the only markers on any map wearing the same blank label as a shop.
       *
       * That is worse than an unrated map. A player who has learned that a
       * missing grade means "somewhere safe" is being told, by a system they
       * have every reason to trust, to walk into the worst floor in the game
       * alone. See `redactedSpec`.
       */
      const spec = specFor(siteId);
      const hint = spec === undefined ? null : partyHint(spec);
      out.push({
        name: def.name,
        bearing: bearingWord(sx - fromX, sy - fromY),
        distance,
        // THE GRADE, AND WHAT IT IMPLIES. `partyHint` says why the second half
        // exists: the co-op incentive here is enormous and invisible, and a
        // player's prior from every other co-op game is that partying costs
        // them.
        danger:
          spec === undefined
            ? null
            : hint === null
              ? dangerWord(spec)
              : `${dangerWord(spec)} · ${hint}`,
      });
    }
    out.sort((a, b) => a.distance - b.distance);
    return out.slice(0, take);
  };

  const announceArrival = (session: Session, realm: PumpTarget, name: string): void => {
    const actorId = session.actorId;
    if (actorId === null) return;

    logSeq += 1;
    const line = (text: string): LogLine => ({
      seq: logSeq,
      lane: LogLane.Record,
      gameTurn: realm.world.turn.clock.gameTurn,
      text,
      depth: 0,
    });

    // TO THEM: where they are, and what it is.
    const full = opts.realms?.get(realm.id);
    const blurb = blurbFor(realm.id, full?.siteId);
    // A NAMELESS REALM SAYS NOTHING AT ALL. A gateway booted with no registry
    // has one fallback world with no name, and "you are in ''" is worse than
    // silence — that build behaves exactly as it did before this existed.
    if (name !== '') {
      send(session.socket, {
        v: PROTOCOL_VERSION,
        t: 'log',
        lines: blurb === undefined ? [line(name)] : [line(name), { ...line(blurb), depth: 1 }],
      });
    }

    /**
     * ═════════════════════════════════════════════════════════════════════
     * AND ON THE OPEN COUNTRY, WHICH WAY THE NEAREST PLACES ARE.
     * ═════════════════════════════════════════════════════════════════════
     * The second thing a first session showed: a stranger stands at
     * Alderbrook's gate looking at a 170x100 moor with thirteen markers on
     * it and NOTHING telling them that any of them is worth walking to, or
     * which way. The map answers "where am I" and nothing answers "where do
     * I go", which for a thirty-minute session is the more important
     * question by a wide margin.
     *
     * THREE, NOT THIRTEEN. A list of every destination is a table, and a
     * table is something a player reads once and never again. Three is a
     * choice — near, a little further, and one that is clearly a trek — and
     * it is short enough to sit under the place's own line without pushing
     * anything off the top.
     *
     * ONLY ON THE OVERWORLD. Inside a room, "what is near" is the room.
     */
    if (full?.kind === RealmKind.Overworld) {
      const body = realm.world.getActor(actorId);
      const near = body === undefined ? [] : nearestSites(realm, body.x, body.y, 3);
      if (near.length > 0) {
        logSeq += 1;
        send(session.socket, {
          v: PROTOCOL_VERSION,
          t: 'log',
          lines: near.map((entry, index) => ({
            seq: logSeq + index,
            lane: LogLane.Record,
            gameTurn: realm.world.turn.clock.gameTurn,
            text:
              entry.danger === null
                ? `${entry.name} — ${entry.bearing}, ${String(entry.distance)} tiles`
                : `${entry.name} — ${entry.bearing}, ${String(entry.distance)} tiles · ${entry.danger}`,
            depth: 1,
          })),
        });
        logSeq += near.length;
      }
    }

    // TO EVERYBODY ELSE IN THE ROOM: who just walked in. Excluded from the
    // arriver's own socket, which has the better version of this line above.
    logSeq += 1;
    broadcast(
      {
        v: PROTOCOL_VERSION,
        t: 'log',
        lines: [{ ...line(`${nameOf(actorId)} arrives.`), seq: logSeq }],
      },
      session.connId,
      audienceFor(realm.id),
    );
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
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * TALKING TO SOMEBODY WHO LIVES HERE.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * ═══ THE ASKER ALWAYS HEARS THE ANSWER. THE ROOM HEARS IT ONCE. ═══
   * This is the shape a design review forced, and it is worth stating why the
   * obvious version is broken.
   *
   * The obvious version broadcasts the reply and suppresses repeats so six
   * people cannot flood the Margin lane. But if the reply travels ONLY in the
   * broadcast, suppressing the broadcast suppresses it for the person who asked
   * — so players two through six click and see nothing at all. No answer, no
   * refusal, no error.
   *
   * And it never recovers, because the natural key for "recently" is the game
   * turn and A TOWN'S CLOCK IS FROZEN. `shared/energy.ts` only advances
   * `gameTurn` while something can gain energy, and six people standing around a
   * shopkeeper clicking rows are by definition not moving. So the window never
   * expires. The one act that WOULD advance the clock is walking — which means
   * the only reliable way to get a reaction out of her would be to body-slam
   * her, in a game where five of six players had just concluded she was broken.
   *
   * Hence: `sendLog` to the asker, unconditionally, every time. `broadcastMargin`
   * to the room only when nobody has heard that line lately. And "lately" is
   * `Date.now()`, which runs whether or not anybody is moving.
   */
  const lastHeard = new Map<string, number>();
  /** How long the room is spared a repeat. Wall clock — see `handleTalk`. */
  const ROOM_REPEAT_MS = 12_000;

  const handleTalk = (session: Session, msg: ClientTalk): void => {
    const actorId = session.actorId;
    if (actorId === null) {
      sendError(session.socket, ErrorCode.NotAuthenticated, 'send hello before talking');
      return;
    }
    const realm = realmFor(session);
    const me = realm.world.getActor(actorId);
    if (me === undefined) return;

    const them = realm.world.getActor(msg.targetId);
    // NOT AN ERROR WORTH A CODE. She stepped away, or the id was stale, or a
    // client invented one — all three are "there is nobody there", and the
    // player's own answer to that is to look. `BadMessage` is reused rather than
    // growing the `ErrorCode` union, which `version.ts` counts as a forced bump.
    if (them === undefined || !isMonster(them) || them.faction !== Faction.Townsfolk) {
      sendError(session.socket, ErrorCode.BadMessage, 'there is nobody there to talk to');
      return;
    }

    // ═══ ADJACENT, AND CHECKED HERE BECAUSE THE CLIENT'S GREY IS ADVISORY ═══
    // The verb menu greys `Talk to` out of reach, exactly as it greys `Attack`.
    // That is a courtesy; this is the rule.
    if (Math.max(Math.abs(me.x - them.x), Math.abs(me.y - them.y)) > 1) {
      sendError(session.socket, ErrorCode.OutOfRange, 'step closer to talk');
      return;
    }

    const spec = specForActorId(them.id);
    if (spec === undefined) return;

    // WHAT SHE SAYS TO A CLICK is her greeting, and the bump counter is shared
    // with `greetOnBump` on purpose: talking to her and walking into her are the
    // same conversation, so the second one does not start over with her name.
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * A NAMED QUESTION GETS ITS ANSWER; ANYTHING ELSE GETS A GREETING.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `topic` is validated as a bounded string on the wire and looked up in a
     * table here — so an id nobody authored, or one this particular person has
     * nothing to say about, falls through to the greeting rather than erroring.
     * That is deliberately not a refusal: being asked something you cannot help
     * with is a conversation, not a fault, and an error frame for it would put a
     * red line on screen for asking a shopkeeper about the weather.
     *
     * THE GREETING COUNTER IS SHARED with `greetOnBump` and is NOT advanced by a
     * topic. Asking Merrow about parties is not "meeting her again", so the next
     * time somebody walks into her she still says her name if they have not
     * heard it.
     */
    /**
     * ═════════════════════════════════════════════════════════════════════════
     * WHAT SHE TELLS A STRANGER, AND WHAT SHE TELLS SOMEBODY WHO HAS BEEN HERE.
     * ═════════════════════════════════════════════════════════════════════════
     *
     * `spec.later` is the second answer and `STANDING_LEVEL` is the line. See
     * the essay on the field: the Redaction was UNFINDABLE — every channel that
     * could have led a player to a whole second landmass was shut, and this is
     * the one that opens. It is gated because directions to that map handed to a
     * level-1 character are directions into a fight they cannot win.
     *
     * THE ASKER'S LEVEL, NOT THE PARTY'S. `me` is the body that clicked, and
     * standing is a fact about a character rather than about who they are
     * walking with — a level-8 friend should not be able to have the door
     * pointed out to somebody on their first evening by standing next to them.
     *
     * FALLS THROUGH RATHER THAN BRANCHING TWICE: a topic absent from `later` is
     * one she has nothing more to say about, which is most of them, so the
     * ordinary answer is the default and the deeper one is the exception.
     */
    // `!isMonster` NARROWS TO THE PLAYER BODY, which is the only thing that can
    // reach this handler anyway — `level` lives on `PlayerActor` and the union
    // does not carry it. A monster asking would fail closed to the ordinary
    // answer rather than throwing, which is the right shape for a fact about
    // standing.
    const deeper = !isMonster(me) && me.level >= STANDING_LEVEL ? spec.later : undefined;
    const answer =
      msg.topic === undefined
        ? undefined
        : (deeper?.[msg.topic as TopicId] ?? spec.topics[msg.topic as TopicId]);
    const key = `${me.id}|${them.id}`;
    let text: string;
    if (answer !== undefined) {
      text = answer;
    } else {
      const seen = bumpCounts.get(key) ?? 0;
      bumpCounts.set(key, seen + 1);
      text = seen === 0 ? spec.greetFirst : spec.greetAgain;
    }

    const line = { text, speaker: them.name };

    // THE ASKER, ALWAYS.
    sendMargin(session, realm, line);

    // THE ROOM, IF IT HAS NOT JUST HEARD IT. Wall clock, because the game clock
    // does not run in a town — see the header.
    const roomKey = `${realm.id}|${them.id}|${text}`;
    const now = Date.now();
    const heard = lastHeard.get(roomKey) ?? 0;
    if (now - heard >= ROOM_REPEAT_MS) {
      lastHeard.set(roomKey, now);
      broadcastMargin(realm, line, session.connId);
    }
  };

  const handleSay = (session: Session, msg: ClientSay): void => {
    const realm = realmFor(session);
    const { world } = realm;
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
    broadcastMargin(realm, { text: msg.text, speaker: speaker.name });
    // THE SPEAKING DOT, server-side half. A line in the Margin is the one piece
    // of "this person is here" the server can know on its own — Discord's voice
    // events never reach it. See `noteSpoke` and `PartyMember.voice`.
    noteSpoke(realm, actorId);
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
    const realm = realmFor(session);
    const { world } = realm;
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

    // A MARKER IS A TILE ON *THIS* MAP. Sent to the room at large it would land
    // on the same coordinate of somebody else's floor, which is a pointer at a
    // wall in a building they are not in.
    broadcast(
      { v: PROTOCOL_VERSION, t: 'pinged', id: actorId, x: msg.x, y: msg.y },
      undefined,
      audienceFor(realm.id),
    );
    broadcastMargin(realm, { text: `points at ${msg.x},${msg.y}`, speaker: pointer.name });
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
    const { world } = realmFor(session);
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
    const realm = realmFor(session);
    const { world, engine } = realm;
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

    /**
     * ═════════════════════════════════════════════════════════════════════════
     * AND THE GAME ACKNOWLEDGES THE ONE PERMANENT DECISION IT ASKED FOR.
     * ═════════════════════════════════════════════════════════════════════════
     *
     * The picker says "this choice is permanent", takes it, and until now said
     * NOTHING back. Walking a full first session is what made that land: the
     * transcript went straight from the moor's description to a fight, with no
     * record that a class had been chosen at all — so the single most
     * consequential input in the game left no trace in the log that narrates
     * every blow and every step onto a threshold.
     *
     * BROADCAST, NOT UNICAST. Who somebody is playing is the first thing the
     * rest of the room wants to know, and on a shared overworld it is how a
     * party works out what it is short of. It is also, for a new player, the
     * first time the log says their name.
     */
    broadcastRecordLine(realm, `${nameOf(actorId)} takes up as ${definition.name}.`);
    // THE HOOK, at depth 1: the class's own sentence, which is the writing that
    // sold them on it a second ago and is worth reading once more now that it
    // is theirs.
    logSeq += 1;
    broadcast(
      {
        v: PROTOCOL_VERSION,
        t: 'log',
        lines: [
          {
            seq: logSeq,
            lane: LogLane.Record,
            gameTurn: realm.world.turn.clock.gameTurn,
            text: definition.description,
            depth: 1,
          },
        ],
      },
      undefined,
      audienceFor(realm.id),
    );

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

    // ═══ AND THE INVENTORY PANEL, WHICH IS THE ONE FRAME THE MEMO CANNOT SEE
    // ═══
    // `sendInventoryIfChanged` keys on the two ID LISTS, and a class choice
    // moves NEITHER — the bag and the doll are exactly what they were a
    // millisecond ago. What changed is `baseCombat`: `reclothePlayer` above
    // wrote the chosen class's sheet and recomposed, so every
    // `CarriedItemView.compare` row is now a delta against a different baseline.
    // A Watchman's coat is +4 Armour on a Watchman and +4 Armour on an Alchemist
    // too, but the six primaries and the three saves it moves are rescaled
    // against different totals, and `rescaleCombatStats` FLOORS — so the numbers
    // genuinely differ.
    //
    // GUARDED ON HAVING SOMETHING, so the common case — somebody finishing
    // character creation with an empty bag — sends no frame at all and the
    // pre-loot frame set for that path is byte-identical.
    if ((body?.carried?.length ?? 0) > 0 || Object.keys(body?.equipped ?? {}).length > 0) {
      sendInventory(session);
    }

    // ═══ THE BOARD, BECAUSE `sprite` AND `maxHp` TRAVEL ONLY ON `ActorView` ═══
    // No delta carries either one. This is the same deliberately dumb answer
    // `needsFullResync` gives and the same one the rename path in `hello` gives
    // at :2669-2677 — resend the actor list and let it cost a few KB once.
    broadcast(
      { v: PROTOCOL_VERSION, t: 'state', actors: projectActors(world) },
      undefined,
      audienceFor(realm.id),
    );
    // ═══ AND THE SKY WITH IT — THE CLIENT CLEARS ITS ORBS ON `state` ═══
    // src/client/main.ts's `case 'state'` runs `clearProjectiles()`, so the
    // broadcast above wipes every orb from every screen that receives it, and
    // the memo would then ACTIVELY SUPPRESS the correction:
    // `broadcastProjectilesIfChanged` compares against the last thing broadcast
    // and the orb list has not changed. The party would be dodging a shot they
    // can no longer see because somebody in the next room finished character
    // creation. This is not rediscovered reasoning — it is copied from the
    // rename path, and every `state` broadcast in this file carries the sky.
    sendProjectilesIfAny(realm);

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
    lastTurnKeys.delete(realm.id);
    broadcastTurnIfChanged(realm, engine.turnState());

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
   * ═════════════════════════════════════════════════════════════════════════
   * `spend_point` — "PUT MY NEXT POINT INTO THIS TALENT." IRREVERSIBLE, SO
   * EVERY CHECK HAPPENS BEFORE THE FIRST WRITE.
   * ═════════════════════════════════════════════════════════════════════════
   *
   * Modelled step for step on `handleChooseClass`, which is this file's house
   * pattern for an authenticated non-turn frame, and the resemblance is the
   * point: both are one-way doors. There is no unlearn verb and no refund, so a
   * point spent on the wrong talent is spent for the evening.
   *
   * IT READS NOTHING FROM THE FRAME BUT `talentId`. `SpendPointSchema` is a
   * `strictObject` of `{v, t, talentId}`, so a smuggled `actorId` is REJECTED
   * rather than stripped into a legal frame — which matters more here than
   * almost anywhere, because a sanitised frame would permanently spend a
   * stranger's point. Identity is `session.actorId`, exactly as with `move`.
   *
   * ═══ THE ORDER OF THE CHECKS, AND WHY EACH CODE IS THE ONE IT IS ═══
   *   1. NO BODY IN THE WORLD -> `internal`, AND NOTHING IS TOUCHED. First,
   *      not last, and that ordering is the same argument `handleChooseClass`
   *      makes at its `reclothePlayer` call: nothing below this line is
   *      undoable, so the one failure that means "your body was recalled
   *      between the click and the frame" has to be answered before any state
   *      is read, let alone written.
   *   2. NOT ON YOUR FEET -> `not_your_turn`. `!alive` is Downed AND Erased
   *      both (`goDown` sets `alive = false` beside `hp = 0`,
   *      engine/downed.ts:401-402), so one read covers both without net/
   *      learning the survival table's shape. It is a "not now" and not a
   *      "never": the point is still in hand the moment somebody picks them up.
   *      It is a CORRECTNESS check as well as a courtesy — a downed body
   *      carries a `DownedRecord` that `revive`/`standUp` reads back, and
   *      quietly rewriting what that body can do while it is on the floor is
   *      the exact class of corruption check 3 of `handleChooseClass` exists
   *      for.
   *   3. A MONSTER -> `internal`. Unreachable (a socket owns a player body),
   *      and it is what NARROWS the actor so `unspentPoints` is reachable at
   *      all rather than being asserted away.
   *   4. NOT IN YOUR LOADOUT -> `bad_message`. THE TALENT ID IS RESOLVED
   *      SERVER-SIDE, against `engine.loadoutOf(actorId)` — which is built from
   *      the REGISTRY through this body's own sheet (`createTalentBook`) — and
   *      never against the string on the wire. That one lookup refuses three
   *      different attacks at once: a talent no registry has ever heard of, a
   *      talent belonging to somebody else's class (an Alchemist cannot buy the
   *      Watchman's Iron Curtain), and a talent this body has not learned.
   *      `bad_message` because no picker can produce any of them.
   *   5. ALREADY AT `maxLevel` -> `bad_message`. Read off the SAME per-actor
   *      view, so the cap the server enforces and the "3/5" the client drew are
   *      the same two numbers. Nothing in engine/ enforces this — `scale.ts`
   *      deliberately does not clamp the curve at 5 and `applyPendingLevels`
   *      only ever grants — so the 1..5 cap is entirely this handler's.
   *   6. NO POINT IN HAND -> `bad_message`.
   *
   * No new `ErrorCode` for any of them. version.ts records that a new code
   * independently forces a protocol bump, and v9's argument is kept to one
   * reason (`LoadoutTalent.range` narrowing) exactly as v8's was.
   *
   * ═══ NON-PUMPING, AND NOTHING IS PARKED. BOTH HALVES OF THE BARRIER ANSWER
   * ═══
   * It joins `inspect` and `choose_class` in the dispatch switch's non-pumping
   * group: spending a point costs no energy, queues no intent and draws no RNG,
   * and a frame that costs the sender nothing must not be a way to make the
   * server advance the world.
   *
   * AND THERE IS DELIBERATELY NO `unparkOnCommand` HERE AND NO PARK ANYWHERE.
   * Written down because the next reader will look for one: `parkForClassChoice`
   * exists because the class picker is a MODAL and a player sitting in it
   * stalled every other player at the barrier until the Bell. The talent panel
   * is not a modal — it is a dock panel on the character sheet's pattern
   * (src/client/ui/charsheet.ts), it swallows no keys and no turn verbs, and the
   * server is never told it is open. So there is no quorum problem to solve:
   * reading never stalls the world because the world does not know you are
   * reading, and spending never stalls it because spending does not advance it.
   * Parking a mid-session reader would be strictly WORSE than doing nothing —
   * `parkForClassChoice`'s own note says the park "DOES NOT MAKE THEM SAFE", so
   * a level-8 player would have monsters chewing on an unattended body while
   * they chose a rank.
   *
   * And `unparkOnCommand` is absent for a matching reason, which is about the
   * PARK and only the park: it exists to lift a standing Hold installed for the
   * class picker, and there is no picker here to lift one for.
   *
   * ═══ STANDING BY IS A DIFFERENT MECHANISM, AND A SPEND DOES SPEAK TO IT ═══
   * This paragraph used to run the two together and conclude that "a spend is
   * not evidence about the barrier at all — a player who has not yet chosen a
   * class has nothing to spend". Both halves were wrong. The premise is false:
   * an anonymous socket in `classChoiceOwed` is handed a rotation class with a
   * real loadout and a real sheet by `classFor(null, …)`, is a full party member
   * for `awardExperience`, and can therefore bank points and spend them. And the
   * conclusion is about `parkForClassChoice` while the question is about
   * `barrier.noteCommand` — whose own doctrine is *"someone who is at the
   * keyboard trying things is present, and that is the only thing Standing By is
   * measuring"*, and which `submitIntent`, `commit`, `respawn` and every `party`
   * verb all call.
   *
   * SO `notePresence` IS CALLED, ON A SUCCESSFUL SPEND. Consider the straggler:
   * Ren levels mid-fight, opens the panel and reads four current->next diffs to
   * decide where the point goes — call it 45 seconds. The 20s Bell rings and
   * auto-passes her; a turn later it rings again and `expire` sets
   * `standingBy = true`, which takes her out of the quorum entirely and
   * auto-holds her with NO Bell delay for the rest of the fight. Meanwhile the
   * server has received two `spend_point` frames from her, each requiring a
   * deliberate press on a `+` button — the strongest presence evidence in the
   * protocol short of a turn verb. (Contrast `inspect`, which the client fires
   * automatically on pointer settle and genuinely is not evidence of a human;
   * that is why it does not carry this call.)
   *
   * IT DOES NOT RESTART THE BELL, and that is correct rather than a compromise:
   * the Bell's key is the blocking set, and a spend does not change who owes a
   * turn. Ren rejoins the quorum without buying herself a second of extra time.
   *
   * AFTER THE SPEND SUCCEEDS, not before. A refused frame is somebody's client
   * misbehaving or a stale button, and the six guards below are the definition
   * of "this was a real press".
   */
  const handleSpendPoint = (session: Session, msg: ClientSpendPoint): void => {
    const { world, engine } = realmFor(session);
    // A NARROWING, NOT A GATE — the dispatch switch sits below the `helloDone`
    // check, so this branch is unreachable without an actor. The compiler still
    // needs the null gone, and answering honestly beats a non-null assertion.
    const actorId = session.actorId;
    if (actorId === null) {
      sendError(session.socket, ErrorCode.NotAuthenticated, 'send hello before spending a point');
      return;
    }

    const body = world.getActor(actorId);
    if (body === undefined) {
      sendError(session.socket, ErrorCode.Internal, 'your body is not in the world');
      return;
    }
    if (!body.alive) {
      sendError(
        session.socket,
        ErrorCode.NotYourTurn,
        'spend refused: you are on the floor — get back on your feet first',
      );
      return;
    }
    if (body.kind !== 'player') {
      sendError(session.socket, ErrorCode.Internal, 'that body cannot hold talent points');
      return;
    }

    /**
     * ═══════════════════════════════════════════════════════════════════════
     * NOT WHILE A CLASS CHOICE IS OUTSTANDING. THE POINT WOULD BE DESTROYED.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `handleChooseClass` ends in `engine.attachClass`, whose seam finishes with
     * an unconditional `sheets.set` of a FRESH sheet — every talent back to rank
     * 1 — and it credits nothing back to `unspentPoints`. So a point spent while
     * the picker is still owed is spent twice over: the rank it bought is
     * overwritten, and the point was already deducted.
     *
     * THIS IS REACHABLE FOR THE WHOLE SESSION, NOT JUST AT THE PICKER.
     * `classChoiceOwed` is cleared only by answering, and `unparkOnCommand`
     * deliberately releases the park while LEAVING the id in the set precisely so
     * a player can start playing before finishing the paperwork. Such a body has
     * a real rotation class, a real loadout, a real sheet, and is a full party
     * member for `awardExperience` — so it genuinely banks points.
     *
     * A SERVER GATE, NOT A CLIENT ONE. The shipped client cannot send this — its
     * input gates all return early while `classOptions !== null` — but
     * CLAUDE.md's non-negotiable is "never trust the client", and this handler's
     * own docblock assumed the state was unreachable for a reason that is false.
     * One line makes the client's gate structural instead of incidental.
     *
     * `NotYourTurn`, WITH THE SERVER'S OWN SENTENCE, on the "not now, and the
     * offer stands" shape the `!alive` branch above already uses. It is not a
     * malformed frame and it is not a permanent no.
     */
    if (classChoiceOwed.has(actorId)) {
      sendError(
        session.socket,
        ErrorCode.NotYourTurn,
        'spend refused: choose a class before spending points',
      );
      return;
    }

    // THE REGISTRY'S ANSWER, THROUGH THIS BODY'S OWN SHEET. Never the string.
    const talent = engine.loadoutOf(actorId).find((entry) => entry.id === msg.talentId);
    if (talent === undefined) {
      sendError(session.socket, ErrorCode.BadMessage, 'no such talent in this loadout');
      return;
    }
    if (talent.level >= talent.maxLevel) {
      sendError(
        session.socket,
        ErrorCode.BadMessage,
        `${talent.name} is already at ${talent.maxLevel}`,
      );
      return;
    }
    if (body.unspentPoints <= 0) {
      sendError(session.socket, ErrorCode.BadMessage, 'no talent points in hand');
      return;
    }

    // ═══ THE WRITE, AND THE FALLIBLE HALF GOES FIRST ═══
    // `raiseTalentPoint` is the injected seam (src/server/main.ts) because the
    // sheet lives behind a boundary this file may not cross. It answers null
    // for a build with no talent engine and for a sheet that does not have this
    // talent — and because it is called BEFORE the point is deducted, that
    // answer costs the player nothing. Doing it the other way round would spend
    // a point on a rank that never happened.
    const raised = engine.raiseTalentPoint?.(actorId, talent.id);
    if (raised === undefined || raised === null) {
      sendError(session.socket, ErrorCode.Internal, 'talent points are not wired into this build');
      return;
    }
    body.unspentPoints -= 1;

    // ═══ AND THE BARRIER IS TOLD SOMEBODY IS THERE ═══
    // See this handler's docblock. Clears Standing By without restarting the
    // Bell, so a player who spent forty-five seconds reading a current->next
    // diff rejoins the quorum instead of being auto-held out of the fight —
    // while the party waits not one second longer than it already was.
    engine.notePresence?.(actorId);

    // ═══ BOTH FRAMES, AND BOTH ARE STALE WITHOUT THE OTHER ═══
    // `sendLoadout` carries no once-guard — it is sent once per connection only
    // because that is a property of the CALL SITE in `hello` — so calling it
    // again replaces the client's bar wholesale, which is exactly what the frame
    // is shaped for. It has to be resent: `range` is per-actor from v9 and
    // `desc`/`descNext` are the current->next diff, so all three are wrong the
    // instant a rank changes.
    sendLoadout(session);
    // And the readout, because the point that was in hand is not any more.
    sendProgress(session);

    app.log.info(
      { actorId, talentId: talent.id, level: raised, unspent: body.unspentPoints },
      'talent point spent',
    );

    // ═══ IMMEDIATE, NOT THE 5s DEBOUNCE ═══
    // The same argument `handleChooseClass` makes: a spend is irreversible and
    // there is no way to re-derive it, so it must be on disk before the next
    // thing that changes it is. The debounced path is worse than merely late
    // here — `SaveStore.scheduleCharacter` holds its snapshot BY REFERENCE
    // (persist/saves.ts), so a queued save is a promise about an object that is
    // still moving, and `snapshotPlayers` builds a fresh `CharacterFile` on
    // every call precisely so that neither path can file a half-written state.
    saveNow('spend');
  };

  // -------------------------------------------------------------------------
  // v10 — THE FOUR LOOT VERBS
  //
  // ═══════════════════════════════════════════════════════════════════════════
  // ALL FOUR SPEND THE TURN, AND *THEN* PUMP. THE ORDER IS ToME'S.
  // ═══════════════════════════════════════════════════════════════════════════
  //
  // `inspect`, `choose_class` and `spend_point` are deliberately non-pumping,
  // and test/server/gateway-progression.test.ts states the reason: *"If it
  // pumped, a player could bank a levelled talent AND a free monster turn from
  // one click."* Loot is the case that line was drawing against. A FREE pickup
  // lets a player loot a whole room mid-fight while every monster stands still —
  // and unlike a talent point, which is at least bounded by levels earned, the
  // floor can hold as many things as have died on it.
  //
  // ═══ PUMPING IS NOT CHARGING, AND CONFUSING THE TWO SHIPPED THE EXPLOIT ═══
  // THIS COMMENT USED TO SAY "a pickup costs a turn" AND THE CODE DID NOT DO IT.
  // Calling `engine.pump()` does not charge the caller: `actPlayer`
  // (engine/scheduler.ts) only reaches `spendTurn` when `actor.pendingIntent`
  // is non-null, and a verb that queues no intent queues nothing to resolve.
  // Worse, mid-fight the pump did not even advance anything — a sender holding
  // full energy with a null intent IS the blocking set (engine/barrier.ts
  // `isBlocking`), so `tickLevel` returned `parked` at once and the verb cost
  // nothing AND moved nothing. A player at 5 hp could put on a seven-piece kit
  // between two swings of a wraith that never got to swing.
  //
  // `spendLootTurn` below is the fix, and it is four lines because the engine
  // already had the seam: a loot action IS a turn spent, `TurnEngine.hold` is
  // the engine's existing word for "spend this turn on something that is not a
  // move and not an attack", and the resulting `held` event maps to NOTHING on
  // the wire (turn-engine.ts's event bridge drops it), so the world advances,
  // the barrier releases and no client learns a new vocabulary.
  //
  // Pumping also means each verb runs `unparkOnCommand` for free, on
  // `handleMove`'s stated terms: somebody reaching for a coat is somebody at the
  // keyboard, so the class-choice park comes off before the ruling rather than
  // after it.
  //
  // ═══ THE PANEL IS NOT A MODAL AND NOTHING HERE IS PARKED ═══
  // Written down because the next reader will look for a barrier interaction and
  // there is none. src/client/ui/charsheet.ts:5-27 settled this shape twice
  // already — *"IT IS A DOCK PANEL, NOT A MODAL, AND THAT IS THE WHOLE
  // DESIGN… Five other people are at the barrier"* — and the talent panel
  // followed it. The server is never told the inventory panel is open, so
  // reading it cannot stall the world; the four verbs spend a turn and advance
  // the world exactly as a move does (see `spendLootTurn`), so using it cannot
  // be farmed — and a player who loots while the party waits RELEASES the
  // barrier by doing so, rather than holding it. Both halves of the barrier
  // question are answered without a single line of barrier code.
  //
  // ═══ THE REFUSAL PATH IS CHEAP, AND DELIBERATELY QUIET ═══
  // The 20/s token bucket is per-SOCKET and does not distinguish a `pickup` from
  // a `ping`, so spam-clicking a contested item is entirely inside budget. Every
  // refusal below is therefore one `sendError` and a return: no `app.log.info`,
  // no broadcast, no allocation beyond the message. The ONE exception is the
  // full-bag notice, which is deliberately loud and is rate-limited by the game
  // turn rather than by the socket — see `noteBagFull`.
  // -------------------------------------------------------------------------

  /**
   * ═════════════════════════════════════════════════════════════════════════
   * "WHOSE BODY IS THIS, AND MAY IT TOUCH AN ITEM AT ALL?" — the guard all four
   * verbs share, in the order `handleSpendPoint` established.
   * ═════════════════════════════════════════════════════════════════════════
   *
   * THE SENDER IS RESOLVED FROM THE SESSION AND NEVER FROM THE FRAME. None of
   * the four schemas has a field that could name a person — `strictObject`
   * REJECTS a smuggled `actorId` rather than sanitising it into a legal frame,
   * which matters more here than almost anywhere: a sanitised `drop` would put
   * somebody else's coat on the floor for the room to take.
   *
   * THE ORDER IS `handleSpendPoint`'S AND FOR ITS REASONS:
   *   1. NO BODY -> `internal`, first, because nothing below it is undoable.
   *   2. NOT ON YOUR FEET -> `not_your_turn`. `!alive` is Downed AND Erased both
   *      (`goDown` sets `alive = false` beside `hp = 0`, engine/downed.ts), so
   *      one read covers the pair without net/ learning the survival table's
   *      shape. gateway.ts's class-chooser records the analogous ruling: a body
   *      on the floor is not merely inconvenienced, it is carrying a
   *      `DownedRecord` that `revive`/`standUp` will read back, and rewriting
   *      what it is wearing while it lies there is the same class of corruption.
   *      It is a "not now" and not a "never" — the coat is still on the tile the
   *      moment somebody picks them up.
   *   3. A MONSTER -> `internal`. Unreachable (a socket owns a player body), and
   *      it is what NARROWS the union so `carried` is reachable as a player's
   *      rather than being asserted away.
   *
   * @returns the body, or undefined when an error has ALREADY been sent.
   */
  const lootActor = (session: Session, verb: string): PlayerActor | undefined => {
    const { world } = realmFor(session);
    const actorId = session.actorId;
    if (actorId === null) {
      sendError(session.socket, ErrorCode.NotAuthenticated, `send hello before ${verb}`);
      return undefined;
    }
    // See `handleMove`: reaching for a coat is somebody at the keyboard, so the
    // class-choice park comes off BEFORE the ruling — a refused pickup is still
    // presence.
    unparkOnCommand(session);

    const body = world.getActor(actorId);
    if (body === undefined) {
      sendError(session.socket, ErrorCode.Internal, 'your body is not in the world');
      return undefined;
    }
    if (!body.alive) {
      sendError(
        session.socket,
        ErrorCode.NotYourTurn,
        `${verb} refused: you are on the floor — get back on your feet first`,
      );
      return undefined;
    }
    if (body.kind !== 'player') {
      sendError(session.socket, ErrorCode.Internal, 'that body cannot carry anything');
      return undefined;
    }
    return body;
  };

  /** This body's bag as a plain array. Absent and empty are the same to a reader. */
  const bagOf = (body: PlayerActor): readonly string[] => body.carried ?? [];

  /** Is this id already on the body, worn or carried? `carried` IS A SET. */
  const alreadyOwns = (body: PlayerActor, itemId: string): boolean =>
    bagOf(body).includes(itemId) || SLOT_ORDER.some((slot) => body.equipped?.[slot] === itemId);

  /**
   * Which GAME TURN each player was last told their bag is full.
   *
   * ═══ THE ONE REFUSAL THAT IS DELIBERATELY LOUD, AND THEREFORE THE ONE THAT
   *     NEEDS A BRAKE ═══
   * A full bag is announced in the Case Log rather than answered privately,
   * because the party is standing on the pile and the useful information is
   * "somebody else take this" — the same social plumbing the pickup line itself
   * is. But `broadcastRecordLine` goes to EVERYONE, and the token bucket is
   * per-socket at 20/s, so a client in a loop would turn one refusal into twenty
   * broadcasts a second: an amplifier, which is precisely what
   * `RATE_NOTICE_INTERVAL_MS` exists to prevent one directory over.
   *
   * KEYED ON THE GAME TURN AND NOT ON A WALL CLOCK, and that is the better brake
   * here: a refused pickup does not pump, so the turn cannot advance until the
   * player does something that moves the world. One notice per full bag per
   * turn is therefore exactly "tell them once, and again if the situation has
   * genuinely changed".
   */
  const bagFullNoticeTurn = new Map<string, number>();

  /**
   * ═════════════════════════════════════════════════════════════════════════
   * A LOOT VERB IS A SAVE POINT — AND ONLY ONE OF THE FOUR IS A ONE-WAY DOOR.
   * ═════════════════════════════════════════════════════════════════════════
   *
   * `pickup` IS THE FORCING CASE AND IT IS THE ONLY IMMEDIATE FLUSH. GROUND
   * ITEMS ARE DELIBERATELY NOT PERSISTED — decision (e) and gateway.ts's own
   * `CharacterRestore` note rule the floor unrestorable, because the world is
   * rebuilt from its seed at boot and a saved tile is a coordinate in a level
   * that no longer exists in the same state. So an unsaved pickup does not put
   * the coat back on the floor; it DESTROYS it. The item left a place that
   * survives nothing and entered a place that survives only if the flush runs.
   *
   * ═══ THE OTHER THREE RIDE THE DEBOUNCE, AND THAT IS A CORRECTION ═══
   * THIS USED TO FLUSH ALL FOUR, on the stated grounds that "the exposure is
   * identical to `spend_point`'s … bounded by the same 20/s token bucket". That
   * argument was wrong in its second half and the difference is the whole
   * problem: the bucket bounds the RATE, not the TOTAL, and `spend_point`'s
   * total is FINITE — a player has as many spends as they have earned levels.
   * `equip`/`unequip` and `drop`/`pickup` are reversible pairs and can be
   * alternated forever. `saveNow` snapshots EVERY player in the world and hands
   * the array to `savePlayersNow`, which writes one file per bound player
   * through `runExclusive` (persist/saves.ts) — a per-path promise chain that
   * COALESCES NOTHING. Six bound players alternating equip/unequip is 120
   * atomic write-plus-rename cycles a second, each also copying the previous
   * file to `.bak`; on Windows with a scanner in the path a single rename can
   * take the retry backoff into the hundreds of milliseconds, the chain grows
   * without bound, and `flush()` then burns its pass budget at shutdown and logs
   * *"flush: gave up draining"* — the last writes of an evening dropped by the
   * very mechanism added to make loot durable.
   *
   * `scheduleCharacter` (the debounced path) REPLACES its pending snapshot per
   * path, so the same loop collapses to one write per debounce window.
   *
   * ═══ WHY THE THREE ARE SAFE TO DEBOUNCE, ONE AT A TIME ═══
   *   `equip` / `unequip` — an id moves between two PERSISTED places on the same
   *     body. A crash inside the window restores the id where it was; the player
   *     re-clicks.
   *   `drop` — the id leaves a persisted place for an UNPERSISTED one. A crash
   *     inside the window therefore leaves the character file still claiming the
   *     item, which is a RECOVERY and not a loss: the ground copy dies with the
   *     process either way (see the note below), so the un-flushed file is the
   *     kinder of the two outcomes. Flushing immediately is what makes the loss
   *     permanent, which is the opposite of what a flush is for.
   *
   * ═══ WHAT A DROPPED ITEM ACTUALLY COSTS, STATED PLAINLY ═══
   * `World.addGroundItem` state is never persisted, and `resetFloor`
   * (turn-engine.ts) re-rolls the ENCOUNTER's drops off `world.lootRng` — it
   * does not restore anything a player put down. SO A DROPPED ITEM IS DESTROYED
   * OUTRIGHT BY A SERVER RESTART AND BY A FLOOR RESET, and no flush on this path
   * can prevent it. (An earlier draft of this docblock said `drop` "moves one
   * into a place that regenerates"; it does not.) If that loss ever stops being
   * acceptable, the smallest honest mitigation is to return ground items to
   * their last owner's `carried` during shutdown, before `store.close()` —
   * bounded, no new SchemaKind, and it still does not make the floor restorable.
   *
   * THE LABEL IS NOT IN `REASON_BY_LABEL` (persist/saves.ts) AND FALLS BACK TO
   * `SaveReason.Manual`, which is honest: a player deliberately did something.
   * Adding a member is an edit to saves.ts, which is outside this change's
   * reach, and `join` set the precedent that a label is reused rather than
   * multiplied.
   */
  const saveLoot = (
    verb: 'pickup' | 'equip' | 'unequip' | 'drop' | 'buy' | 'sell' | 'use',
  ): void => {
    if (verb === 'pickup') saveNow('loot');
    else queueSave('loot');
  };

  /**
   * ═════════════════════════════════════════════════════════════════════════
   * THE TURN THE VERB COSTS. ALL FOUR, AFTER THE CHANGE AND BEFORE THE PUMP.
   * ═════════════════════════════════════════════════════════════════════════
   *
   * ═══ WHY IT IS `engine.hold` AND NOT A NEW INTENT KIND ═══
   * D1 (DECISIONS.md) makes `spendTurn` in the scheduler the ONE spender of
   * energy, so net/ cannot charge anybody directly and must not try. What it can
   * do is what every other acting verb does: put an intent on the body and let
   * the pump resolve it. `TurnEngine.hold` is exactly that seam — it submits the
   * shared `HOLD_INTENT`, `actPlayer` resolves it, `spendTurn` charges
   * ENERGY_TO_ACT, and the monsters get their turn. It is already required on
   * the port, already implemented by every engine in the tree and already
   * exercised by the `hold` verb, so this adds no new surface to get wrong.
   *
   * AND THE `held` EVENT IT PRODUCES IS INVISIBLE. turn-engine.ts's event bridge
   * maps `held` to nothing at all (it sits in the same `break` arm as `spilled`
   * and `refunded`), so nothing is narrated and no client learns a new word. The
   * only observable consequence is the correct one: the world moved on.
   *
   * ═══ AFTER THE MUTATION, WHICH IS UPSTREAM'S OWN ORDER ═══
   *   `Actor:doWear`    — `wearObject` then `useEnergy` (Actor.lua:7346-7352)
   *   `Actor:doTakeoff` — `takeoffObject` then `useEnergy` (Actor.lua:7415-7420)
   *   `Actor:doDrop`    — `dropFloor` then `useEnergy` (Actor.lua:7316-7323)
   *   `Player:playerPickup` — `pickupFloor` then `useEnergy` (Player.lua:1313-1315)
   * All four charge only on the SUCCESS path, and so does this: every refusal
   * above returns before reaching here, so a refused pickup is free — which is
   * the refund rule stated for a verb that never became an intent.
   *
   * ToME's ONE exemption is `quick_wear_takeoff` (Actor.lua:7352, :7420), an
   * attribute that buys wear/takeoff back as free actions and costs a 1-turn
   * `SWIFT_HANDS_CD` effect for it. We have no such attribute and no talent that
   * grants one; when something wants it, this is the line it turns off, and it
   * must be a property of the BODY (a talent, an item) rather than of the verb.
   * Note that `doDrop` is NOT exempted even there — upstream charges for putting
   * something down, and so do we.
   *
   * ═══ WHAT IT DOES NOT CLOSE, MEASURED AND WRITTEN DOWN ═══
   * The charge lands on the SUBMIT and the resolution follows the barrier, so a
   * player whose PARTY is parked on somebody else gets a narrow discount. Two
   * players, engagement up, Alex still owing a decision: Ren equips, pays in
   * full (energy 1000 -> 0) and the clock does not move (tick 20, gameTurn 2,
   * identical before and after) because `tickLevel` returns `parked` while
   * anybody blocks. Ren's SECOND and later swaps in that window then queue one
   * shared pending hold — `pendingIntent` is a single slot — so N swaps behind a
   * thinking teammate cost 2 turns rather than N. The world is frozen for the
   * monsters too, so nothing is gained against them; what is gained is swaps per
   * turn, and only while a friend is deliberating. Closing it means refusing a
   * loot verb from a body that has already committed this turn, which is a
   * game rule and therefore an ENGINE seam (`TurnEngine` has no "can this actor
   * act now?" method today) rather than four `body.pendingIntent` reads in net/.
   * Left open deliberately, stated rather than discovered.
   *
   * ═══ THE REFUSAL IS UNREACHABLE BY CONSTRUCTION, AND STILL NOT SWALLOWED ═══
   * `hold` refuses only `no_actor`, and `lootActor` proved the body exists and is
   * on its feet a few lines earlier. Nothing between the two can change that:
   * non-negotiable 2 means there is no await anywhere in this path. It is logged
   * rather than ignored because the day that stops being true, the symptom is a
   * verb that has quietly gone free again — the exact bug this function exists
   * to close, and the one that got shipped once already by being invisible.
   */
  const spendLootTurn = (body: PlayerActor, verb: string): void => {
    // THE SCHEDULER OF THE FLOOR THE BODY IS ON. A turn is charged against one
    // barrier, and charging the wrong one would spend a turn nobody was waiting
    // for while the one they ARE waiting for goes on waiting. See `homeOf`.
    const charged = homeOf(body.id).engine.hold(body.id);
    if (!charged.ok) {
      app.log.warn({ actorId: body.id, verb, reason: charged.reason }, 'loot: turn not charged');
    }
  };

  /** Say it once a turn, to the room. See `bagFullNoticeTurn`. */
  const noteBagFull = (body: PlayerActor): void => {
    const home = homeOf(body.id);
    const turn = home.world.turn.clock.gameTurn;
    if (bagFullNoticeTurn.get(body.id) === turn) return;
    bagFullNoticeTurn.set(body.id, turn);
    broadcastRecordLine(home, `${nameOf(body.id)}'s evidence bag is full — nothing more will fit.`);
  };

  /**
   * ═════════════════════════════════════════════════════════════════════════
   * `pickup` — THE FRAME WITH NO FIELDS AT ALL, AND THAT IS ITS WHOLE SECURITY
   * MODEL.
   * ═════════════════════════════════════════════════════════════════════════
   *
   * `PickupSchema` is `{ v, t }` and `strictObject`. THERE IS NO COORDINATE ON
   * THE WIRE, so there is no adjacency check to get wrong: the server reads the
   * sender's OWN live x/y off the body it resolved from the session and takes
   * index 0 of that tile's pile. protocol.ts:63-69 says a hand-crafted frame
   * from a devtools console is the normal case to design for; here there is
   * nothing to craft.
   *
   * A `groundId` WOULD HAVE BEEN THE SAME MISTAKE IN A NEW COSTUME. Every
   * `GroundItemView.id` arrives in the `ground` BROADCAST, which is the whole
   * floor, so it would read as safe by the same tests `party`'s `targetId`
   * passes — and it would still let a patched client name a pile it is nowhere
   * near. The floor frame is broadcast; the taking is not.
   *
   * ═══ INDEX 0, BECAUSE THE TOP OF THE PILE MUST MEAN ONE THING ═══
   * `World.itemsAt` returns insertion order and world.ts:516-522 states the
   * contract in its own words: PICKUP TAKES INDEX 0. `spillOrderOf`
   * (turn-engine.ts) is the one implementation of "what order is a pile in", and
   * the whole reason it exists is that a hash-ordered spill gives two replays of
   * one seed the same items in a different floor order — and therefore a
   * different item under the same keypress.
   *
   * ═══ THE TAKE IS ONE INDIVISIBLE SYNCHRONOUS STEP ═══
   * Read the tile, remove from the floor, add to the bag — no await between any
   * of them, which is what CLAUDE.md non-negotiable 2 buys and why DOUBLE-TAKE
   * IS IMPOSSIBLE BY CONSTRUCTION rather than by a lock. Two players on one tile
   * both sending `pickup` are two separate synchronous handler invocations: the
   * second one finds the id gone and gets a cheap refusal. `removeGroundItem`'s
   * boolean answer is checked rather than discarded precisely so that the day
   * anything DOES interleave, the failure is a refusal and not a duplicated item.
   *
   * ═══ AND IT REFUSES AN ID THE BODY ALREADY OWNS ═══
   * `carried` IS A SET. persist/saves.ts keeps the first occurrence of an id and
   * drops later ones, because a saved id carries no per-instance handle — so
   * without this check a party that finds two identical pairs of trousers would
   * appear to keep both until the next reload, and the loss would present as "my
   * second cap vanished when I relogged" with the bug looking like it is in
   * persistence when it is here.
   */
  const handlePickup = (session: Session): void => {
    const { world } = realmFor(session);
    const body = lootActor(session, 'pickup');
    if (body === undefined) return;

    // THE SENDER'S OWN TILE. Not a tile from the frame — there is none.
    const pile = world.itemsAt(body.x, body.y);
    const top = pile[0];
    if (top === undefined) {
      sendError(session.socket, ErrorCode.IllegalMove, 'there is nothing to pick up here');
      return;
    }

    /**
     * ═══════════════════════════════════════════════════════════════════════
     * MONEY NEVER ENTERS THE BAG. money.lua:29-36's `on_prepickup`, exactly.
     * ═══════════════════════════════════════════════════════════════════════
     * Upstream's coin pile is an object whose `on_prepickup` adds to
     * `who.money` and returns true, which is its way of saying "I handled it,
     * do not put me in an inventory". Ours is the same shape and the same
     * order: remove from the floor FIRST, credit second, so a race that loses
     * the removal cannot credit anybody.
     *
     * IT SKIPS EVERY RULE BELOW IT, and each skip is deliberate. Not
     * `alreadyOwns` — a purse is not a set, and "you already have 14 gold"
     * would be nonsense. Not `INVENTORY_CAP` — a full bag must never stop you
     * picking up gold, or the cap becomes an economic penalty nobody designed.
     */
    const coins = moneyAmountOf(top.itemId);
    if (coins !== undefined) {
      if (!world.removeGroundItem(top.id)) {
        sendError(session.socket, ErrorCode.IllegalMove, 'somebody got there first');
        return;
      }
      incMoney(body, coins);
      broadcastRecordLine(homeOf(body.id), `${nameOf(body.id)} picks up ${moneyName(coins)}.`);
      // THE SAME THREE THINGS THE ITEM PATH DOES, and for the same reasons.
      // It costs the turn (Player.lua:1313-1315), and it saves IMMEDIATELY
      // rather than riding the debounce — the floor is not persisted, so an
      // unsaved take does not put the gold back, it destroys it.
      spendLootTurn(body, 'pickup');
      saveLoot('pickup');
      pumpAndBroadcast(realmFor(session));
      return;
    }

    const item = resolveItem(top.itemId);
    if (item === undefined) {
      // A content reload deleted an authored item out from under a live floor.
      // Answered rather than swallowed, and the item is LEFT WHERE IT IS: a
      // silent removal would delete somebody's drop to tidy up after a deploy.
      sendError(session.socket, ErrorCode.Internal, 'that item is not in this build');
      return;
    }

    if (alreadyOwns(body, top.itemId)) {
      sendError(session.socket, ErrorCode.BadMessage, `you already have a ${item.name}`);
      return;
    }

    const bag = bagOf(body);
    if (bag.length >= INVENTORY_CAP) {
      sendError(session.socket, ErrorCode.IllegalMove, 'your evidence bag is full');
      // THE LOUD HALF, once a game turn — see `noteBagFull`. Somebody else on
      // this tile can take it, and the only way they learn that is if the
      // transcript says so.
      noteBagFull(body);
      return;
    }

    // ═══ ONE STEP, NO AWAIT, NOTHING BETWEEN THEM ═══
    if (!world.removeGroundItem(top.id)) {
      sendError(session.socket, ErrorCode.IllegalMove, 'somebody got there first');
      return;
    }
    // REPLACED, NEVER SPLICED. engine/actor.ts states the rule at the field: a
    // live array somebody mutated is how two players end up sharing a coat.
    body.carried = [...bag, top.itemId];

    // ═══ THE TRANSCRIPT IS THE WHOLE OF THE OWNERSHIP RULE ═══
    // The pile is unowned and the first pickup wins — a DEVIATION with no
    // upstream citation, because ToME is single-player and `Actor:die` calls
    // `game.level.map:addObject` with no owner and no party concept. What that
    // rule costs is that an item can be sniped by the fastest clicker, and the
    // answer is social rather than mechanical: a line naming who took what, so
    // the transcript settles the argument afterwards. Without this line the rule
    // is just a race nobody can audit.
    broadcastRecordLine(homeOf(body.id), `${nameOf(body.id)} picks up the ${item.name}.`);

    /**
     * ═════════════════════════════════════════════════════════════════════════
     * AND IF THEY ARE STANDING THERE WITH NOTHING ON THAT PART OF THEM, SAY SO.
     * ═════════════════════════════════════════════════════════════════════════
     *
     * A NEW CHARACTER WEARS NOTHING. Measured: `projectInventory` on a fresh
     * body answers `equipped: {}` and `carried: []` — the classes have no
     * starting kit at all, so the first thing that drops is the first gear that
     * player has ever owned, and putting it on is their first real upgrade.
     *
     * Nothing told them. The transcript said *"picks up the Reinforced
     * Watchman's Trousers"* and stopped, and a player who never opens the bag
     * never equips anything and quietly finds the game harder than it should be
     * — which reads as difficulty rather than as a missed step.
     *
     * ═══ THE SAME VOICE AS `Something is still on the floor.` ═══
     * That line is already this game's way of nudging: a short observation that
     * implies an action, rather than a tutorial telling somebody which key to
     * press. This is its twin, and it is deliberately about the BODY rather than
     * the item — "nothing on your legs" is a fact about you, and the thing you
     * just picked up is the obvious answer to it.
     *
     * ONCE PER EMPTY SLOT, BY CONSTRUCTION. It fires only when that slot is bare
     * at the moment of the pickup, so it cannot repeat for a slot already filled
     * — at most seven of these in a career, each at the first moment it means
     * anything. UNICAST, because what somebody is wearing is their own business
     * and this is advice rather than an event; `broadcastRecordLine` above is
     * the ownership record and belongs to the room.
     */
    if (item.slot !== undefined && body.equipped?.[item.slot] === undefined) {
      sendMargin(session, realmFor(session), {
        text: `Nothing on your ${SLOT_WORDS[item.slot]} yet.`,
        depth: 0,
      });
    }

    // AND IT COSTS THE TURN — Player.lua:1313-1315 charges for exactly this, on
    // exactly this path. See `spendLootTurn`.
    spendLootTurn(body, 'pickup');
    // IMMEDIATE, AND THIS IS THE ONE VERB THAT FORCES IT — see `saveLoot`: the
    // floor is not persisted, so an unsaved take destroys the item rather than
    // putting it back. The other three ride the debounce, for the reasons argued
    // there. Before the pump, because what is worth keeping is the state the
    // player just created and not whatever the barrier does about it.
    saveLoot('pickup');
    // The floor frame and the bag frame both ride the pump's memos — see
    // `broadcastGroundIfChanged` and `refreshViewers`.
    pumpAndBroadcast(realmFor(session));
  };

  /**
   * ═════════════════════════════════════════════════════════════════════════
   * `equip` — "PUT THIS ON." IT NAMES AN OBJECT, NEVER A SUBJECT, NEVER A SLOT.
   * ═════════════════════════════════════════════════════════════════════════
   *
   * THE ITEM IS RESOLVED AGAINST THIS ACTOR'S OWN `carried` AND NOTHING ELSE, so
   * there is no cross-inventory lookup table for a forged id to reach into: an
   * id the sender does not hold is simply not found in their own list, and the
   * worst a made-up one achieves is a refusal. That is a stronger property than
   * an ownership CHECK, because there is no query here that could be written to
   * span two players.
   *
   * THE DESTINATION SLOT IS NOT ON THE WIRE. `Item.slot` is authored in
   * content/items.ts — a coat goes on the body and there is nowhere else it
   * could go — so a `slot` field would be a client asserting authored content
   * and the only thing the server could do with a disagreement is ignore it.
   * Upstream reaches the same place by another road: `Object:wornInven()`
   * (engines/default/engine/Object.lua:104-107) derives the destination
   * inventory FROM THE OBJECT, and the dialog never asks.
   *
   * ═══ A SWAP, NOT AN INSERT, AND THE OLD ITEM GOES BACK IN THE BAG ═══
   * Ported from `Actor:wearObject` -> `ActorInventory:wearObject`, which takes
   * off whatever occupies the slot and returns it to the inventory rather than
   * refusing (ActorInventory.lua:563-572). The bag cannot overflow on this path
   * by construction: one id leaves it and at most one enters, so the count never
   * rises. That is worth stating because it is why there is no cap check here
   * and there IS one in `handleUnequip`.
   *
   * ═══ AND THE SHEET IS RECOMPOSED, WHICH IS THE ONLY REASON ANY OF THIS
   *     MATTERS ═══
   * `equipped` is owned by these verbs; `combat` is owned by `recomposeCombat`
   * and by nothing else. The recompose is not a subtraction and never can be —
   * it is the same additive fold re-run over a different set, which is what
   * makes equip/unequip exactly reversible by construction rather than by
   * careful arithmetic. ToME's own removal path un-applies `mult` by division
   * and `perc_inv` by `1-(1-b)/(1-v)` (Entity.lua:985-996), float round trips
   * that drift; tome/class/Actor.lua:105-108 is upstream retrofitting four speed
   * properties back to plain `add`, the second of them commented *"Prevent
   * excessive attack speed compounding"*. We import the lesson instead of learning it twice.
   */
  /**
   * ═════════════════════════════════════════════════════════════════════════
   * `use` — THE THIRD WAY A FIGHT CAN END.
   * ═════════════════════════════════════════════════════════════════════════
   *
   * A party at a fifth of its health could retreat or it could die. This is the
   * option that was missing, and its absence is why money in this game was one
   * decision long: you bought the best coat you could afford and then the number
   * only went up.
   *
   * ═══ IT COSTS THE TURN, FOR `handleEquip`'S REASON AND MORE SO ═══
   * *"Getting dressed mid-fight is the single most valuable free action this
   * game could have handed out"* — and drinking forty hit points is worth more
   * than getting dressed. A free heal is not a decision, it is a button you
   * press whenever the number is low, and the whole value of a consumable is
   * that using it costs you the thing you would otherwise have done with that
   * turn.
   *
   * ═══ NO OVERHEAL, AND `healActor` ALREADY OWNS THAT RULE ═══
   * It clamps to `maxHp` and answers how much it actually restored, which is the
   * number the log line says — so a player at full health who drinks one is told
   * plainly that they wasted it rather than watching a bar not move.
   */
  const handleUse = (session: Session, msg: ClientUse): void => {
    const body = lootActor(session, 'use');
    if (body === undefined) return;

    const bag = bagOf(body);
    if (!bag.includes(msg.itemId)) {
      // The same one refusal `handleEquip` gives, for the same reason: "no such
      // item" and "somebody else's item" are the same question.
      sendError(session.socket, ErrorCode.BadMessage, 'you are not carrying that');
      return;
    }

    const item = resolveItem(msg.itemId);
    if (item === undefined) {
      sendError(session.socket, ErrorCode.BadMessage, 'that item is not in this build');
      return;
    }
    if (item.use === undefined) {
      // A COAT IS NOT A DRINK. Authored content decides, never the wire.
      sendError(session.socket, ErrorCode.BadMessage, 'that is not something you can use');
      return;
    }

    const healed = healActor(body, item.use.amount);

    // SPENT WHETHER OR NOT IT HELPED. A draught drunk at full health is gone —
    // the alternative is a free "am I hurt?" probe, and worse, an item that
    // sometimes silently declines to be used is an item a player stops trusting
    // in the one moment they need to trust it.
    body.carried = bag.filter((id) => id !== msg.itemId);

    /**
     * A CASE LOG LINE, WHERE `equip` DELIBERATELY HAS NONE. The asymmetry is the
     * one `handleEquip` argues: what you are WEARING changes only your own
     * numbers, but a heal in a fight changes what the party should do next —
     * whether to press, whether to pull the wounded one back — and that is
     * exactly the kind of fact the transcript exists to settle afterwards.
     */
    broadcastRecordLine(
      realmFor(session),
      healed > 0
        ? `${nameOf(body.id)} drinks ${item.name}. (+${String(healed)})`
        : `${nameOf(body.id)} drinks ${item.name}, and did not need it.`,
    );

    spendLootTurn(body, 'use');
    saveLoot('use');
    pumpAndBroadcast(realmFor(session));
  };

  const handleEquip = (session: Session, msg: ClientEquip): void => {
    const body = lootActor(session, 'equip');
    if (body === undefined) return;

    const bag = bagOf(body);
    if (!bag.includes(msg.itemId)) {
      // ONE REFUSAL FOR "no such item" AND FOR "somebody else's item", and they
      // are the same refusal because they are the same question: is this id in
      // YOUR list? A separate "that belongs to Ren" would be an oracle over
      // other people's bags, which is exactly what `InventoryMsg` being a
      // `ViewerMsg` exists to prevent.
      sendError(session.socket, ErrorCode.BadMessage, 'you are not carrying that');
      return;
    }
    const item = resolveItem(msg.itemId);
    if (item === undefined) {
      sendError(session.socket, ErrorCode.BadMessage, 'that item is not in this build');
      return;
    }

    /**
     * ═════════════════════════════════════════════════════════════════════════
     * A THING WITH NO SLOT CANNOT BE WORN, AND THIS IS THE ONE PLACE THAT HAD TO
     * BE TOLD.
     * ═════════════════════════════════════════════════════════════════════════
     *
     * Nearly every reader of `Item.slot` COMPARES it and therefore fails closed
     * on a draught for free. This one indexes with it — `body.equipped[item.slot]`
     * — off an id that came in over the wire, so without this a player could
     * equip a draught into a slot literally named "undefined", wear it forever,
     * and have `recomposeCombat` fold a `{}` wielder over their sheet every time.
     * Not a crash; a permanent junk entry in a persisted record.
     */
    if (item.slot === undefined) {
      sendError(session.socket, ErrorCode.BadMessage, 'that is not something you can wear');
      return;
    }

    const previous = body.equipped?.[item.slot];
    // The bag, with the incoming item out and the outgoing one in. Built as one
    // new array rather than two splices — see engine/actor.ts on `carried`.
    const bagAfter = bag.filter((id) => id !== msg.itemId);
    if (previous !== undefined) bagAfter.push(previous);

    body.equipped = { ...body.equipped, [item.slot]: msg.itemId };
    body.carried = bagAfter;
    recomposeCombat(body, opts.effects ?? null, resolveItem);

    // NO CASE LOG LINE, and the asymmetry with `pickup`/`drop` is deliberate:
    // those two change the SHARED floor, which is the thing the party is
    // arguing about and the thing a transcript has to settle. What somebody is
    // wearing changes only their own numbers, and a line per equip would be a
    // stream of noise on the one surface the party reads to work out what killed
    // them. The party sees the effect where it belongs — on the hp bar and
    // through `inspect`.

    // AND IT COSTS THE TURN — Actor.lua:7352. Getting dressed mid-fight is the
    // single most valuable free action this game could have handed out: a full
    // kit is armour 6 -> 16 and hardiness 40% -> 50% (test/server/equipment.test.ts),
    // and without this line a player at 5 hp bought all of it between two swings.
    spendLootTurn(body, 'equip');
    saveLoot('equip');
    pumpAndBroadcast(realmFor(session));
  };

  /**
   * ═════════════════════════════════════════════════════════════════════════
   * `unequip` — "TAKE THIS OFF." A SLOT, and the only closed enum of the four.
   * ═════════════════════════════════════════════════════════════════════════
   *
   * IT NAMES THE SLOT AND NOT THE ITEM, and the direction matters: there is
   * exactly one item in a slot so the slot identifies it, but the reverse is not
   * reliable in the presence of a client a frame behind. A stale
   * `unequip { itemId }` would ask to remove something no longer worn and would
   * have to be refused; a stale `unequip { slot }` empties the slot the player is
   * looking at, which is what they meant.
   *
   * ═══ THIS IS THE ONE VERB THE CAP CAN REFUSE ═══
   * `equip` swaps (count unchanged), `drop` removes, `pickup` checks before it
   * takes. Only this one moves an item INTO the bag without taking one out, so a
   * player wearing a full kit with twelve things in the bag genuinely cannot take
   * their coat off until they drop something — and being told that plainly beats
   * silently discarding a coat, which is the other way this could have gone.
   */
  const handleUnequip = (session: Session, msg: ClientUnequip): void => {
    const body = lootActor(session, 'unequip');
    if (body === undefined) return;

    const worn = body.equipped?.[msg.slot];
    if (worn === undefined) {
      sendError(session.socket, ErrorCode.BadMessage, 'nothing is in that slot');
      return;
    }

    const bag = bagOf(body);
    if (bag.length >= INVENTORY_CAP) {
      sendError(session.socket, ErrorCode.IllegalMove, 'your evidence bag is full');
      noteBagFull(body);
      return;
    }

    // A FRESH OBJECT WITH THE KEY DELETED, never `equipped[slot] = undefined`.
    // A present-but-undefined key is a second spelling of empty: `wornOf` would
    // skip it, `projectInventory` would skip it, and `wornRecord` would drop it
    // — but `inventoryKeyOf` stringifies the raw object, so the memo would see a
    // change that no reader can see and resend the panel forever.
    const next: Partial<Record<Slot, string>> = { ...body.equipped };
    delete next[msg.slot];
    body.equipped = next;
    body.carried = [...bag, worn];
    recomposeCombat(body, opts.effects ?? null, resolveItem);

    // AND IT COSTS THE TURN — Actor.lua:7420, the takeoff half of the same rule.
    spendLootTurn(body, 'unequip');
    saveLoot('unequip');
    pumpAndBroadcast(realmFor(session));
  };

  /**
   * ═════════════════════════════════════════════════════════════════════════
   * `drop` — "LEAVE THIS HERE." The verb that gives something away.
   * ═════════════════════════════════════════════════════════════════════════
   *
   * IT CARRIES NO DESTINATION TILE. The item lands on the SENDER'S OWN tile,
   * read server-side — the same emptiness `pickup` relies on, in the other
   * direction. A `{ x, y }` here would let a patched client post items into a
   * room it cannot see, under a monster, or onto the tile a friend is about to
   * step on, and the only defence would be an adjacency check on an
   * attacker-supplied coordinate. There is no coordinate, so there is no check
   * to get wrong.
   *
   * IT NAMES A CARRIED ITEM, NEVER A WORN ONE, so dropping something you are
   * wearing is two verbs rather than one that quietly does both. That is not
   * fastidiousness: an item leaving a slot RECOMPOSES the combat sheet, and a
   * verb that silently changed a player's armour on the way to putting a coat on
   * the floor is the kind of hidden write this protocol refuses everywhere else.
   * It is also why this handler does NOT recompose — nothing it touches is worn,
   * so `actor.combat` is already correct, and calling the recomposer here would
   * teach the next reader that a bag can change a sheet.
   *
   * ═══ AND IT IS HOW "YOU TAKE IT, I'VE GOT A COAT" ACTUALLY HAPPENS ═══
   * The floor pile is unowned; anything dropped is anybody's. That rule is a
   * DEVIATION with no citation — see `handlePickup` — and this verb is the half
   * of it that makes the social answer possible at all.
   */
  const handleDrop = (session: Session, msg: ClientDrop): void => {
    const { world } = realmFor(session);
    const body = lootActor(session, 'drop');
    if (body === undefined) return;

    const bag = bagOf(body);
    if (!bag.includes(msg.itemId)) {
      sendError(session.socket, ErrorCode.BadMessage, 'you are not carrying that');
      return;
    }
    const item = resolveItem(msg.itemId);
    if (item === undefined) {
      sendError(session.socket, ErrorCode.BadMessage, 'that item is not in this build');
      return;
    }

    body.carried = bag.filter((id) => id !== msg.itemId);
    // THE SENDER'S OWN TILE, and no terrain check: world.ts's `addGroundItem`
    // states why in its own words — a player drops onto the tile they are
    // standing on, which is somewhere somebody was legally standing.
    world.addGroundItem({ x: body.x, y: body.y }, msg.itemId);

    broadcastRecordLine(homeOf(body.id), `${nameOf(body.id)} puts down the ${item.name}.`);
    // AND IT COSTS THE TURN — Actor.lua:7323. Upstream charges for putting
    // something down and does NOT exempt it under `quick_wear_takeoff`, which is
    // the right call for us too: a free drop is a free handover, and handing a
    // coat to the person the wraith is standing next to is a real tactical act.
    spendLootTurn(body, 'drop');
    saveLoot('drop');
    pumpAndBroadcast(realmFor(session));
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
    const { engine } = realmFor(session);
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
    // THIS REALM. Same argument as `handleTurnVerb`: a player verb changes one
    // party's quorum, and pumping the whole process on every keypress scales with
    // players times realms.
    pumpAndBroadcast(realmFor(session));
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
    const realm = realmFor(session);
    const { world, engine } = realm;
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
    broadcastRecordLine(realm, `${nameOf(actorId)} is refiled — back on their feet.`);
    // ═══ THE BOARD IS RESENT, AND ONLY THIS LINE CAN DO IT ═══
    // A respawn rewrites three things no delta carries: the SPRITE (back from
    // the `_downed_s` variant), the POSITION (a spawn tile — an erased body does
    // not block, so it may have been lying under somebody) and the hp. The same
    // deliberately dumb answer `needsFullResync` gives, for the same reason.
    broadcast(
      { v: PROTOCOL_VERSION, t: 'state', actors: projectActors(world) },
      undefined,
      audienceFor(realm.id),
    );
    // ═══ AND THE SKY WITH IT, FOR THE THIRD AND LAST TIME IN THIS FILE ═══
    // Every `state` broadcast clears the client's orb list (src/client/main.ts's
    // `case 'state'`), and the memo suppresses the restate because the list
    // itself did not change. Three sites broadcast `state`: the full resync in
    // `pumpAndBroadcast`, the rename in `hello`, and this one. All three carry
    // the sky. If a fourth is ever added it must too — an orb the party cannot
    // see has no counterplay, which is the whole point of the feature.
    sendProjectilesIfAny(realm);
    // A CRITICAL EVENT, like a death and a disconnect: the state worth keeping
    // is the one that just changed, and it changed because somebody was stuck.
    saveNow('respawn');

    // The quorum just grew by one. The party may have been idling on nobody.
    // THIS REALM. Same argument as `handleTurnVerb`: a player verb changes one
    // party's quorum, and pumping the whole process on every keypress scales with
    // players times realms.
    pumpAndBroadcast(realmFor(session));
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
    const realm = realmFor(session);
    const { engine } = realm;
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
    broadcastRecordLine(realm, result.notice);

    /**
     * ═════════════════════════════════════════════════════════════════════════
     * AND THE REASON TO HAVE DONE IT, SAID ONCE, AT THE MOMENT IT BECOMES TRUE.
     * ═════════════════════════════════════════════════════════════════════════
     *
     * `awardExperience` pays EVERY party member a FULL share, computed from
     * their own level, with no division by headcount and no proximity check
     * (scheduler.ts states all three as deliberate). So a party of three earns
     * three times the experience of three people standing in the same room not
     * partied — which is the single largest mechanical incentive in the game,
     * and it was completely invisible.
     *
     * A player could reasonably conclude the opposite. Every other co-op game
     * they have played divides a kill, so the safe assumption is that partying
     * COSTS them, and nothing here contradicted it.
     *
     * ONCE, WHEN THE PARTY GROWS, and never on a leave or a kick: the fact is
     * about being in a party, and repeating it every time somebody joins would
     * turn the one line that teaches the game's best decision into furniture.
     */
    if (result.affected.length > 1) {
      broadcastRecordLine(realm, 'Every kill pays the whole party in full — nothing is split.');
    }

    for (const memberId of result.affected) {
      const conn = connByActor.get(memberId);
      const member = conn === undefined ? undefined : sessions.get(conn);
      if (member !== undefined && member.helloDone) sendPartyStateIfChanged(member);
    }

    // THE QUORUM JUST CHANGED SHAPE. Somebody may have been waiting on a person
    // who is no longer in their party, and the pump is what lets them move.
    pumpAndBroadcast();
  };

  /**
   * ═════════════════════════════════════════════════════════════════════════
   * `set_keybinds` — "THESE ARE MY KEYS." STORE THEM, FLUSH THEM, ECHO THEM.
   * ═════════════════════════════════════════════════════════════════════════
   *
   * The fourth member of the non-pumping, self-only group, beside `inspect`,
   * `choose_class` and `spend_point`, and it is in that group for the group's own
   * stated rule: a rebind costs no energy, queues no intent and draws no RNG, so
   * a frame that costs the sender nothing must never be a way to make the server
   * advance the world. Routing it through anything that calls `pumpAndBroadcast`
   * would let a patched client farm monster turns off a free frame.
   *
   * ═══ IT READS NOTHING FROM THE FRAME BUT `binds` ═══
   * `SetKeybindsSchema` is a `strictObject` of `{v, t, binds}`, so a smuggled
   * `actorId` is REJECTED rather than stripped into a legal frame — which here
   * would mean rewriting the SENDER's own keyboard on somebody else's behalf,
   * silently, with the screen showing what they asked for. Identity is
   * `session.actorId`, exactly as with `move`.
   *
   * ═══ WHOLESALE REPLACEMENT, NEVER A MERGE ═══
   * The frame carries the player's complete remap, so `binds: {}` IS the RESET
   * ALL button and needs no second verb. Merging would make "clear this action"
   * unexpressible and would leave a stale override behind every time the client's
   * idea of the map got ahead of the server's.
   *
   * ═══ NO NEW `ErrorCode`, AND NO REFUSAL THIS HANDLER CAN INVENT ═══
   * Shape, size and emptiness are zod's (`bad_message`, before this is entered).
   * MEMBERSHIP is nobody's on this side of the wire — the action table lives in
   * src/client/input/keys.ts and net/ may not import the client — so an id this
   * build no longer binds is stored verbatim, and CONFLICTS are refused at the
   * capture field where the screen can name which action already holds the key. A
   * refusal here would be one with nothing to point at. src/shared/version.ts
   * records that a new code independently forces a protocol bump.
   *
   * ═══ AND IT IS AN IMMEDIATE FLUSH, NOT THE 5s DEBOUNCE ═══
   * `saveNow('keybinds')` for `join`'s reason: the interesting window is exactly
   * the seconds after a player finishes a rebind and closes the tab, which is
   * precisely when somebody who has just spent two minutes on the Keys screen
   * does close it. The label is not in `REASON_BY_LABEL`, so persist/saves.ts
   * files it as `SaveReason.Manual` through its own `??` — which is the honest
   * category: a rebind is a deliberate act by a person, not a world event.
   *
   * ═══ NOTHING IS PARKED AND NO PRESENCE IS NOTED ═══
   * The Keys screen is a PANEL on the character sheet's pattern, not a modal: the
   * server is never told it is open, and the Warrant Clock auto-passes a reader
   * like anybody else. So there is no quorum problem to solve and
   * `parkForClassChoice`'s machinery — whose first version stranded anonymous
   * sockets forever — is deliberately not reached for.
   *
   * ═══ AND THIS PARAGRAPH ONCE CLAIMED MORE THAN THE CLIENT DELIVERED ═══
   * It used to add that "the player can still walk, commit, hold and press 1-4
   * with it up". Three of those four were false against the shipped client: the
   * escape menu's `onMove` and `onCommand` gates swallowed the direction keys,
   * Commit, Hold AND Pickup outright. With two readers the Bell could not even
   * bound it — `bell()` arms only at `committed >= total - 1`, i.e. for at most
   * ONE straggler — so the level parked with no timer that ends it. The CLIENT
   * was fixed (src/client/main.ts's `onCommand` now swallows Enter only when a
   * row is genuinely lit, and never Hold or Pickup), which is where the fix
   * belongs, because a park here "DOES NOT MAKE THEM SAFE" and would leave a body
   * being chewed on while its owner reads. This sentence is now a description of
   * behaviour that exists rather than a premise this file was relying on.
   *
   * `notePresence` is left alone too, unlike
   * `spend_point`: a rebind is not evidence about the barrier the way a `+` press
   * is, because the client sends this frame when a SCREEN closes rather than when
   * a decision is made, and a straggler must not be able to hold the party by
   * leaving a menu open.
   */
  const handleSetKeybinds = (session: Session, msg: ClientSetKeybinds): void => {
    const { world } = realmFor(session);
    // A NARROWING, NOT A GATE — `handleChooseClass`'s shape. The dispatch switch
    // sits below the `helloDone` check so this branch is unreachable without an
    // actor; the compiler still needs the null gone, and answering honestly beats
    // a non-null assertion.
    const actorId = session.actorId;
    if (actorId === null) {
      sendError(
        session.socket,
        ErrorCode.NotAuthenticated,
        'send hello before setting key bindings',
      );
      return;
    }

    // THE BODY, CHECKED RATHER THAN ASSUMED, and answered `internal` when it is
    // gone — `handleChooseClass`'s honest-outcome shape. It was recalled between
    // the frame being sent and being read, so there is nothing to store the map
    // on and nothing to save; changing NOTHING and saying so beats writing a
    // keymap onto a body that no longer exists.
    const body = world.getActor(actorId);
    if (body === undefined) {
      sendError(session.socket, ErrorCode.Internal, 'your body is not in the world');
      return;
    }

    // ON THE BODY, NOT ON THE SESSION. Two tabs are one player — the second
    // claims the same actor and the older socket is closed with 4001 — so one
    // body means one map means no last-writer-wins between windows. Cached per
    // session it would be one file with two writers. Normalised on the way in so
    // what is stored is what a snapshot would have written anyway.
    const next = keybindsRecord(msg.binds);

    // ═════════════════════════════════════════════════════════════════════════
    // AN IDEMPOTENCE CHECK, AND IT IS THE PRECONDITION THIS HANDLER WAS MISSING.
    // ═════════════════════════════════════════════════════════════════════════
    // Every other `saveNow` path in this file is self-limiting. `spend_point`
    // gates on `body.unspentPoints <= 0` AND on `raiseTalentPoint` succeeding
    // before it flushes; `pickup` needs a real ground item and spends the turn;
    // `death`, `recall`, `join` and `disconnect` are world events a client cannot
    // repeat. This one had NO precondition at all — it wrote and flushed on every
    // accepted frame — and `saveNow` -> `savePlayersNow` writes EVERY bound
    // player's character file, not just the sender's, each one a full
    // `writeFileAtomic`: open + write + fsync + `copyFile` for the `.bak` +
    // rename. Nothing downstream could dedupe it either, because `saveCharacter`
    // stamps a fresh `updatedAt` before serialising, so the bytes differ every
    // time.
    //
    // A LOOPING CLIENT SUSTAINS 20 FRAMES A SECOND (`COMMAND_RATE_PER_SEC`) —
    // `set_keybinds` is charged one token like every non-`hello` frame and
    // nothing refused it, because the map is always shape-valid. At a party of
    // five that was 100 fsync'd writes a second driven by one socket, rewriting
    // and rotating the backups of four people who did nothing, with `runExclusive`
    // growing an unbounded per-path promise chain — each queued closure retaining
    // its serialised text — for `flush()` to drain at shutdown.
    //
    // BOTH SIDES ARE ALREADY SORTED AND CANONICAL (`keybindsRecord` sorts the
    // action keys and copies the arrays), so `JSON.stringify` equality is exact
    // rather than approximate. THE ECHO STILL GOES OUT: the frame's contract is
    // that the screen renders what the SERVER holds, and a client that resent an
    // unchanged map is still owed that answer.
    //
    // `saveNow` RATHER THAN `queueSave` SURVIVES THIS, and deliberately — the
    // interesting window really is the seconds between a rebind and a closed tab
    // (see this handler's docblock). What was wrong was that a NO-OP could drive
    // it; a genuine change flushing immediately is the behaviour that was asked
    // for, and a human cannot generate more than a few of those a minute.
    if (JSON.stringify(body.keybinds ?? null) === JSON.stringify(next)) {
      sendKeybinds(session);
      return;
    }

    body.keybinds = next;

    saveNow('keybinds');

    // AND THE ECHO, TO THE SENDER ALONE, READ BACK OFF THE BODY. Never
    // `broadcast` — the type system agrees, since `KeybindsMsg` is a `ViewerMsg`
    // — and never `msg.binds`, because the whole point is that the screen renders
    // what the SERVER stored.
    sendKeybinds(session);
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
      // NON-PUMPING, like `say` and `point` above: talking spends no turn and
      // makes the server do no work, which is why it is safe on the same rate
      // limit as speech.
      case 'talk':
        handleTalk(session, msg);
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
      // ALSO NON-PUMPING, and it is the third member of this group rather than
      // an exception to it: a spend costs no energy, queues no intent and draws
      // no RNG, so — in the group's own words — a frame that costs the sender
      // nothing must not be a way to make the server advance the world.
      //
      // THAT IS ALSO HALF THE BARRIER ANSWER. Reading the panel never reaches
      // the server at all and spending never advances the world, so neither can
      // stall it. Nothing is parked and no `unparkOnCommand` is wired: the panel
      // is not a modal, so there is no quorum problem to solve. See
      // `handleSpendPoint`, where the reason there is no park is written out in
      // full for the next person who goes looking for one.
      case 'spend_point':
        handleSpendPoint(session, msg);
        return;
      // ALSO NON-PUMPING, and the FOURTH member of this group rather than an
      // exception to it — the group's own rule, stated once more because this is
      // the frame most likely to be mistaken for a settings write that could
      // safely go anywhere: a rebind costs no energy, queues no intent and draws
      // no RNG, so a frame that costs the sender nothing must not be a way to
      // make the server advance the world. Routed through anything that pumps, a
      // patched client would farm a monster turn per keystroke off the Keys
      // screen.
      //
      // AND SELF-ONLY, like the three above it: the frame names a keymap and
      // nothing else, and the body it lands on is the one this socket owns. The
      // echo goes back with `send` and never `broadcast` — `KeybindsMsg` is a
      // `ViewerMsg`, so the compiler enforces it. See `handleSetKeybinds`, where
      // the absence of a park is written out for the next person who looks.
      case 'set_keybinds':
        handleSetKeybinds(session, msg);
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
      // ═══ THE FOUR v10 LOOT VERBS, AND ALL FOUR PUMP ═══
      // They are the MIRROR of the non-pumping group three cases up. That
      // group's rule is "a frame that costs the sender nothing must not be a way
      // to make the server advance the world"; loot is the case where a frame
      // that advanced NOTHING would be the exploit — a free pickup lets somebody
      // clear a room's floor mid-fight while every monster stands still. A
      // pickup costs a turn, exactly as a step does.
      //
      // Each therefore also runs `unparkOnCommand` for free, through the shared
      // `lootActor` guard and BEFORE the ruling, on `handleMove`'s terms: a
      // refused reach is still somebody at the keyboard.
      //
      // NONE OF THEM NAMES A SUBJECT. `pickup` carries no fields at all, `equip`
      // and `drop` carry an item id resolved against the SENDER'S OWN bag, and
      // `unequip` carries one of seven slots. See the four handlers.
      case 'pickup':
        handlePickup(session);
        return;
      case 'equip':
        handleEquip(session, msg);
        return;
      case 'use':
        handleUse(session, msg);
        return;
      case 'unequip':
        handleUnequip(session, msg);
        return;
      case 'drop':
        handleDrop(session, msg);
        return;
      // NAMES A TARGET, NOT A SUBJECT — see `handleFollow`. Who is asking comes
      // from the session; what is named is checked with `sameParty`, which the
      // sender only controls one side of.
      case 'follow':
        handleFollow(session, msg);
        return;
      // TWO MORE THAT NAME AN OBJECT AND NEVER A SUBJECT. `shop_buy` resolves
      // against the SHELF OF THE REALM THE SENDER IS STANDING IN; `shop_sell`
      // against the sender's own bag.
      case 'shop_buy':
        handleShopBuy(session, msg);
        return;
      case 'shop_sell':
        handleShopSell(session, msg);
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
    // EVERY REALM'S BELL. One per floor now (see `bells`), and a timer left
    // running is what makes a test process hang after the app is shut down.
    for (const realmId of [...bells.keys()]) clearBell(realmId);
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
      // NULL IS "THE DEFAULT WORLD", not "not yet known" — see `Session.realmId`
      // and `realmFor`. A socket with no body cannot be anywhere, and a build
      // with no `opts.realms` never leaves this value.
      realmId: null,
      enteredFrom: null,
      enteredFromRealm: null,
      exitArmed: false,
      region: null,
      hiddenSeen: 0,
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
      progressKey: null,
      // NOT null — see `EMPTY_INVENTORY_KEY`. A fresh socket believes its bag is
      // empty before it is told anything, so seeding with the empty state is
      // what keeps a bare player's frame set byte-identical to the pre-loot one.
      inventoryKey: EMPTY_INVENTORY_KEY,
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
        realmFor(session).engine.setConnected(actorId, false);
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
