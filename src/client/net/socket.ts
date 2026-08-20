/**
 * The client end of the WebSocket. One socket, reconnecting, typed both ways.
 *
 * THE URL IS BUILT, NEVER WRITTEN DOWN. No host, no port, no scheme literal
 * appears in this file. A Discord Activity is served through Discord's proxy,
 * which rewrites the origin (and may mount the app under a path prefix), so any
 * hardcoded 'ws://localhost:3000' works on the author's machine and nowhere
 * else. `new URL('ws', location.href)` with the scheme swapped follows the page
 * wherever it is served: http -> ws in dev, https -> wss in production, through
 * the proxy in Discord, with no build-time switch.
 *
 * WHAT THIS MODULE KNOWS ABOUT THE GAME: exactly one thing. It reads
 * `resumeToken` out of `welcome` so a reconnect can reattach to the same actor
 * instead of spawning a duplicate. Everything else is forwarded untouched.
 *
 * THE TOKEN LIVES IN MEMORY ONLY. Not localStorage, not sessionStorage: an
 * Activity iframe is third-party context, storage there is partitioned or
 * blocked depending on the client and the browser, and a resume token surviving
 * a page reload buys nothing — a reload re-runs the Discord OAuth handshake
 * anyway. In memory it cannot be read by anything else in the frame and it
 * cannot outlive the session that minted it.
 *
 * TWO OPAQUE HANDLES GO OUT IN `hello`, AND NEITHER ONE IS AN IDENTITY.
 *
 *   `sessionId`   — minted by `POST /api/token` after the server asked Discord
 *                   `GET /users/@me`. It says "you already know who I am"; the
 *                   mapping back to a person exists only in the server's memory.
 *   `resumeToken` — handed out in `welcome`. It says "I am the socket that
 *                   dropped a moment ago" and dies with the actor.
 *
 * There is no `actorId`, no `userId` and no `name` on this socket, in any frame,
 * ever — CLAUDE.md non-negotiable #5, and `z.strictObject` in
 * src/shared/protocol.ts rejects the attempt rather than stripping it. A client
 * cannot say who it is here because there is no field in which to say it. The
 * session id is not an exception to that rule: forging one gets you anonymous
 * play, which is what an absent one gets you too.
 *
 * THE SESSION ID IS RESENT ON EVERY RECONNECT, deliberately. The server's
 * session table has a sliding expiry, so a socket that keeps talking keeps its
 * seat; one that has been gone long enough for the session to lapse comes back
 * anonymous rather than as somebody else, and a page reload re-runs the OAuth
 * handshake and mints a new one.
 *
 * ===========================================================================
 * CLOSING THE ACTIVITY HANGS UP. TABBING AWAY DOES NOT. THEY ARE NOT THE SAME.
 * ===========================================================================
 *
 * Reported from real co-op play: somebody closed the Activity and their body
 * went on standing in the world for everyone else. Nothing here said goodbye, so
 * the server only found out when its 30-second heartbeat missed a pong — and the
 * ten-minute reconnect grace started from THERE, not from the moment the window
 * shut. Meanwhile the party is waiting on a socket that no longer exists.
 *
 * The two page events look interchangeable and mean opposite things:
 *
 *   `pagehide`          THE DOCUMENT IS GOING AWAY. The tab closed, the iframe
 *                       was torn down, the player navigated off. This is the
 *                       teardown, and it is the ONLY one that closes the socket.
 *                       A clean close frame reaches the server in milliseconds,
 *                       its `close` handler runs, and the body leaves the quorum
 *                       at once instead of thirty seconds later.
 *
 *   `visibilitychange`  THE PAGE IS MERELY HIDDEN. Another tab has focus, the
 *                       window is minimised, the phone locked — or somebody
 *                       alt-tabbed to Discord mid-fight to read the channel.
 *                       IT MUST NEVER DISCONNECT ANYBODY. Hidden is
 *                       presence-unknown at most: a player who tabs away for
 *                       four seconds during a boss fight and comes back to find
 *                       themselves Standing By would be a far worse bug than the
 *                       one being fixed. So the `hidden` half does nothing at
 *                       all, and only the `visible` half acts — it retries a
 *                       reconnect immediately rather than sitting out the rest
 *                       of a backoff, which is what a laptop that just woke up
 *                       needs.
 *
 * THE DISCORD SDK HAS NO TEARDOWN EVENT TO USE INSTEAD. Its `Events` enum
 * (READY, VOICE_STATE_UPDATE, ACTIVITY_LAYOUT_MODE_UPDATE, ORIENTATION_UPDATE,
 * ACTIVITY_INSTANCE_PARTICIPANTS_UPDATE, ...) has nothing for "this activity is
 * closing", and `sdk.close()` is an outbound command — the app asking Discord to
 * shut it, not Discord telling the app it is being shut. So the page lifecycle
 * IS the lifecycle, which is also why this lives in the socket module rather
 * than behind net/discord.ts: it has to work identically in a browser tab.
 */

import { PROTOCOL_VERSION } from '../../shared/version.ts';
import type { ClientHello, ClientMsg, ServerMsg } from '../../shared/protocol.ts';

export const SocketStatus = {
  Connecting: 'connecting',
  Open: 'open',
  Reconnecting: 'reconnecting',
  Closed: 'closed',
} as const;
export type SocketStatus = (typeof SocketStatus)[keyof typeof SocketStatus];

export type SocketOptions = {
  /** Every decoded server frame, in arrival order. */
  readonly onMessage: (msg: ServerMsg) => void;
  /** Connection state for the status line. Never called during `close()`. */
  readonly onStatus?: (status: SocketStatus, detail: string) => void;
  /**
   * The opaque session id from net/discord.ts, or null when there is none (a
   * plain browser tab, tools/e2e-m1.mjs, or a handshake that failed). Optional
   * rather than required so that a caller with nothing to present writes
   * nothing, instead of inventing a placeholder that would then be on the wire.
   */
  readonly sessionId?: string | null;
  /**
   * WHICH CHARACTER TO ASK FOR, READ FRESH ON EVERY `hello`.
   *
   * A CALLBACK AND NOT A VALUE, because this is asked again on every reconnect
   * and the answer changes: it is null while the player is at the select screen,
   * `{ newCharacter: true }` for the one hello that creates somebody, and a
   * concrete id from the moment `welcome` says which id that was. A value
   * captured at construction would still be saying "make me a new character" an
   * hour later, and a dropped socket would quietly create one.
   *
   * ABSENT MEANS "WHATEVER THE SERVER GIVES ME", which is what every build
   * before the select screen did and what an anonymous player still does.
   */
  readonly characterChoice?: () => { characterId?: string; newCharacter?: boolean } | null;
};

export type GameSocket = {
  /** Returns false if the frame could not be sent — the socket is not open. */
  readonly send: (msg: ClientMsg) => boolean;
  readonly status: () => SocketStatus;
  /** Deliberate shutdown. Cancels the reconnect loop. */
  readonly close: () => void;
  /**
   * "Say hello again, with whatever I would say now."
   *
   * THE SELECT SCREEN'S ONLY VERB. Choosing a character is not a game action —
   * there is no body to act with — so it cannot be a frame on a live socket. It
   * is a new handshake, and this drops the socket so the reconnect loop runs one
   * with the answer `characterChoice` gives now.
   *
   * A SECOND ROUND TRIP RATHER THAN A NEW VERB, deliberately: entering the world
   * is four hundred lines of frame ordering in `handleHello` that already exist
   * and are already correct, and a second entry path would be a second place for
   * them to drift.
   */
  readonly rehandshake: () => void;
};

/** First retry lands fast enough that a server restart is barely noticed. */
const RECONNECT_BASE_MS = 500;
/** ...and the ceiling keeps a dead server from being hammered every half second. */
const RECONNECT_MAX_MS = 15_000;

/**
 * The server pings every 30 s at the WebSocket protocol level, and the browser
 * answers those pongs in C++ WITHOUT telling JavaScript — a protocol ping is
 * invisible from a page, so it cannot drive a client-side liveness check. Hence
 * an application-level ping on the same cadence: the `pong` that comes back IS
 * a frame this code sees, and it is what resets the watchdog.
 */
const PING_INTERVAL_MS = 30_000;
/** Three missed round trips. A half-open TCP connection looks exactly like this. */
const SILENCE_LIMIT_MS = 90_000;
const WATCHDOG_TICK_MS = 15_000;

/**
 * Same origin, same path prefix, http->ws / https->wss.
 *
 * `location.href` rather than a constant: it already contains whatever origin
 * and prefix the page was actually served from, which is the only thing that is
 * correct in all three environments (dev server, self-hosted, Discord proxy).
 */
function websocketUrl(): string {
  const url = new URL('ws', location.href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.search = '';
  url.hash = '';
  return url.href;
}

/**
 * Decode one inbound frame.
 *
 * The server is our own and its output is typed at the construction site, so
 * this is a shape check rather than a trust boundary — but it must not THROW:
 * an exception escaping a `message` listener is an unhandled error that takes
 * the whole client down, and a truncated frame is not worth a black screen.
 */
function decode(data: unknown): ServerMsg | null {
  if (typeof data !== 'string') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  if (!('t' in parsed) || typeof parsed.t !== 'string') return null;
  return parsed as ServerMsg;
}

export function connectGameSocket(options: SocketOptions): GameSocket {
  const notify = options.onStatus;
  // An empty string is normalised to "no handle" rather than sent: the schema's
  // `.min(1)` would reject the whole frame, and a `bad_message` on `hello` costs
  // the connection — a much worse outcome than the anonymous play that an absent
  // handle produces.
  const sessionId =
    options.sessionId === undefined || options.sessionId === '' ? null : options.sessionId;

  let socket: WebSocket | null = null;
  let status: SocketStatus = SocketStatus.Connecting;
  let attempt = 0;
  let resumeToken: string | null = null;
  let lastFrameAt = Date.now();
  let stopped = false;

  let reconnectTimer = 0;
  let pingTimer = 0;
  let watchdogTimer = 0;

  function setStatus(next: SocketStatus, detail: string): void {
    status = next;
    notify?.(next, detail);
  }

  function clearTimers(): void {
    window.clearTimeout(reconnectTimer);
    window.clearInterval(pingTimer);
    window.clearInterval(watchdogTimer);
    reconnectTimer = 0;
    pingTimer = 0;
    watchdogTimer = 0;
  }

  /**
   * Exponential backoff with jitter. The jitter half is not decoration: one
   * server restart drops every connected tab at the same millisecond, and
   * without it they all come back at the same millisecond too, repeatedly.
   */
  function backoffDelay(): number {
    const ceiling = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** attempt);
    return Math.round(ceiling / 2 + Math.random() * (ceiling / 2));
  }

  function scheduleReconnect(reason: string): void {
    if (stopped || reconnectTimer !== 0) return;
    const delay = backoffDelay();
    attempt += 1;
    setStatus(SocketStatus.Reconnecting, `${reason}; retrying in ${Math.round(delay / 100) / 10}s`);
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = 0;
      open();
    }, delay);
  }

  function sendRaw(ws: WebSocket, msg: ClientMsg): boolean {
    if (ws.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(JSON.stringify(msg));
      return true;
    } catch {
      // send() throws on a socket that closed between the readyState check and
      // here. The close listener is already on its way; nothing to do.
      return false;
    }
  }

  function open(): void {
    if (stopped) return;
    clearTimers();

    const url = websocketUrl();
    setStatus(attempt === 0 ? SocketStatus.Connecting : SocketStatus.Reconnecting, url);

    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      scheduleReconnect('could not open socket');
      return;
    }
    socket = ws;

    // Every listener checks that it still belongs to the CURRENT socket. A
    // reconnect can leave an old socket's close event in flight, and letting it
    // run would reschedule a reconnect the live socket does not need.
    const isCurrent = (): boolean => socket === ws;

    ws.addEventListener('open', () => {
      if (!isCurrent()) return;
      attempt = 0;
      lastFrameAt = Date.now();
      setStatus(SocketStatus.Open, url);

      // Each handle is SPREAD IN ONLY WHEN IT EXISTS rather than written as a
      // key holding null. `strictObject` would take an explicit `undefined`,
      // and JSON.stringify drops it anyway, but "absent" and "present and
      // empty" are two spellings of one thing — and the schema's `.min(1)`
      // exists precisely so an empty string is never mistaken for a handle.
      const choice = options.characterChoice?.() ?? null;
      const hello: ClientHello = {
        v: PROTOCOL_VERSION,
        t: 'hello',
        ...(sessionId === null ? {} : { sessionId }),
        ...(resumeToken === null ? {} : { resumeToken }),
        // SPREAD ONLY WHEN PRESENT, like the two handles above and for the same
        // reason: `newCharacter: false` and "no opinion" are two spellings of
        // one thing, and only one of them is what the schema means.
        ...(choice?.characterId === undefined ? {} : { characterId: choice.characterId }),
        ...(choice?.newCharacter === true ? { newCharacter: true } : {}),
      };
      sendRaw(ws, hello);

      pingTimer = window.setInterval(() => {
        sendRaw(ws, { v: PROTOCOL_VERSION, t: 'ping' });
      }, PING_INTERVAL_MS);

      watchdogTimer = window.setInterval(() => {
        if (Date.now() - lastFrameAt <= SILENCE_LIMIT_MS) return;
        // Silent for three ping cycles. The socket believes it is open, so
        // nothing will ever fire a close event on its own — this is exactly the
        // half-open connection a laptop lid or a NAT timeout produces. Close it
        // ourselves; the close listener runs the normal reconnect path.
        clearTimers();
        ws.close(4000, 'no server frames');
      }, WATCHDOG_TICK_MS);
    });

    // Typed `MessageEvent<unknown>` rather than the DOM's default
    // `MessageEvent<any>`: `data` is then unknown, and the compiler forces it
    // through `decode` instead of letting `any` spread into the message path.
    ws.addEventListener('message', (event: MessageEvent<unknown>) => {
      if (!isCurrent()) return;
      // ANY frame proves the far end is alive, so the watchdog is reset before
      // the frame is even understood.
      lastFrameAt = Date.now();

      const msg = decode(event.data);
      if (msg === null) {
        console.warn('dropped an undecodable server frame');
        return;
      }
      // The one piece of game knowledge in this module: hold the token so the
      // next hello can reattach instead of spawning a second actor.
      if (msg.t === 'welcome') resumeToken = msg.resumeToken;
      options.onMessage(msg);
    });

    ws.addEventListener('error', () => {
      // A WebSocket error event carries no useful detail by design (it would
      // leak cross-origin information). The close event always follows, and
      // that is where the reconnect is scheduled.
      if (isCurrent()) console.warn('websocket error');
    });

    ws.addEventListener('close', (event: CloseEvent) => {
      if (!isCurrent()) return;
      socket = null;
      clearTimers();
      if (stopped) {
        setStatus(SocketStatus.Closed, 'closed');
        return;
      }
      const why = event.reason === '' ? `code ${event.code}` : event.reason;
      scheduleReconnect(`disconnected (${why})`);
    });
  }

  /**
   * Hang up cleanly, right now.
   *
   * `socket` is cleared BEFORE `close()` so the socket's own close listener sees
   * `isCurrent()` false and does not schedule a reconnect on the way out — the
   * caller decides whether there is anything to come back to.
   *
   * 1000 is RFC 6455's normal closure. It is what turns a teardown into a close
   * FRAME the server receives immediately, rather than a half-open connection it
   * discovers on the next heartbeat.
   */
  function hangUp(why: string): void {
    const ws = socket;
    socket = null;
    clearTimers();
    if (ws === null) return;
    try {
      ws.close(1000, why);
    } catch {
      // close() throws only on a socket that is already gone, which is the
      // outcome being asked for.
    }
  }

  /**
   * THE ACTIVITY IS BEING TORN DOWN. See the header for why this event and not
   * `visibilitychange`.
   *
   * `event.persisted` is the bfcache case: the document is being frozen rather
   * than destroyed and may be restored later, so the socket is dropped (there is
   * no point holding a connection a frozen page cannot read) and a reconnect is
   * scheduled for the moment the page thaws. Everything else is a real teardown:
   * the JavaScript context is about to stop existing, and a reconnect timer set
   * here would never fire anyway — `stopped` says so honestly instead.
   */
  function onPageHide(event: PageTransitionEvent): void {
    hangUp('page hidden');
    if (event.persisted) {
      scheduleReconnect('page was frozen');
      return;
    }
    stopped = true;
    setStatus(SocketStatus.Closed, 'closed');
  }

  /**
   * THE PAGE CAME BACK. NOT a disconnect handler — read the header.
   *
   * Only the `visible` half does anything, and all it does is stop waiting: a
   * laptop that slept through four backoff steps would otherwise sit for up to
   * fifteen seconds after the player is already looking at it. `attempt` is not
   * reset, so a genuinely dead server is still backed off from.
   */
  function onVisibilityChange(): void {
    // HIDDEN IS NOT GONE. A player reading Discord in another tab is still in
    // the fight, and disconnecting them would be a worse bug than the one this
    // block exists to fix. Deliberately nothing.
    if (document.visibilityState !== 'visible') return;
    if (stopped || socket !== null || reconnectTimer === 0) return;
    window.clearTimeout(reconnectTimer);
    reconnectTimer = 0;
    open();
  }

  window.addEventListener('pagehide', onPageHide);
  document.addEventListener('visibilitychange', onVisibilityChange);

  open();

  return {
    send: (msg) => {
      const ws = socket;
      return ws === null ? false : sendRaw(ws, msg);
    },
    status: () => status,
    rehandshake: () => {
      /**
       * ═══ THE RESUME TOKEN IS DROPPED, AND THAT IS THE WHOLE POINT ═══
       * It says "I am the socket that just dropped, give me my body back". This
       * is a player DELIBERATELY changing which body they want, so presenting it
       * would ask the server to resume the character they are leaving — and the
       * server would be right to.
       *
       * `attempt` IS RESET so the new handshake goes out on the fast rung of the
       * backoff. A player who just clicked PLAY should not wait fifteen seconds
       * because the evening had a rough patch earlier.
       */
      resumeToken = null;
      attempt = 0;
      hangUp('choosing a character');
      scheduleReconnect('choosing a character');
    },
    close: () => {
      stopped = true;
      window.removeEventListener('pagehide', onPageHide);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      hangUp('client closed');
      setStatus(SocketStatus.Closed, 'closed');
    },
  };
}
