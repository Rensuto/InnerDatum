import { readFileSync } from 'node:fs';

import { beforeAll, describe, expect, it } from 'vitest';

import Fastify from 'fastify';

import {
  AuthFailure,
  authRoutes,
  createDiscordAuth,
  isAllowed,
  parseUserIdList,
  readAuthConfig,
  safeDisplayName,
} from '../../src/server/http/auth.ts';
import { createSessionStore } from '../../src/server/http/session.ts';
import type { AuthConfig, AuthDeps, DiscordIdentity } from '../../src/server/http/auth.ts';
import type { SessionStore } from '../../src/server/http/session.ts';

// ---------------------------------------------------------------------------
// THE TRUST BOUNDARY, TESTED FROM OUTSIDE IT.
//
// Everything here runs the real `authRoutes` plugin through `app.inject()`,
// with Discord replaced by a stub that RECORDS WHAT WAS SENT TO IT. That is the
// only honest place to stand: every question this file has to answer is about
// what crosses a boundary — what reaches the browser, what reaches Discord,
// what reaches the log — and none of them can be answered by calling an
// internal function and looking at its return value.
//
// FOUR SECRETS, EACH WITH AN UNMISTAKABLE LITERAL. Every negative assertion
// below is a substring search, and a search for 'token' would fire on the word
// 'token' in a log message. A search for `ACCESS-TOKEN-d4e5f6-never-log-me`
// fires on exactly one thing.
//
// EVERY NEGATIVE IS PAIRED WITH A POSITIVE. "The client secret is not in the
// response" also passes when the flow never ran, so each absence is stated
// next to the proof that the value really was in play — the secret WAS sent to
// Discord's token endpoint, the log DID record this request, Discord DID answer
// with a refresh token.
// ---------------------------------------------------------------------------

const CLIENT_ID = '111111111111111111';
const CLIENT_SECRET = 'CLIENT-SECRET-hunter2-never-log-me';
const OAUTH_CODE = 'OAUTH-CODE-a1b2c3-never-log-me';
const ACCESS_TOKEN = 'ACCESS-TOKEN-d4e5f6-never-log-me';
const REFRESH_TOKEN = 'REFRESH-TOKEN-g7h8i9-never-leaves-the-process';
const SESSION_ID = 'SESSION-ID-j0k1l2-never-log-me';

/** Ren, who is allowed to play. Snowflake-SHAPED, and nobody's real id. */
const REN_ID = '222222222222222222';
/** Somebody else, for the allowlist tests. Also not a real id. */
const STRANGER_ID = '333333333333333333';

/**
 * Never `discord.com`. If a bug ever routed one of these calls at the real
 * endpoint, it fails to resolve instead of quietly reaching Discord from a test
 * runner on somebody's laptop.
 */
const API_BASE = 'https://discord.invalid/api';

const TOKEN_URL = `${API_BASE}/oauth2/token`;
const REVOKE_URL = `${API_BASE}/oauth2/token/revoke`;
const USER_URL = `${API_BASE}/users/@me`;

/**
 * Ren's VERIFIED identity, minted in `beforeAll` the only way one can be: by
 * calling `verifyIdentity`, which calls `/users/@me`.
 *
 * There is no `as DiscordUserId` anywhere in this file and there must not be.
 * The brand exists so that holding one is proof somebody asked Discord; a test
 * that casts its way past that is testing a different program.
 */
let REN: DiscordIdentity;

// ---------------------------------------------------------------------------
// The Discord stub
// ---------------------------------------------------------------------------

/** One outbound call, recorded whole, so a test can say what left the process. */
type OutboundCall = {
  readonly url: string;
  readonly method: string;
  /** The form body, verbatim — where the client secret would be if it leaked. */
  readonly body: string;
  /** The bearer header, verbatim — where the access token travels. */
  readonly authorization: string | null;
};

type StubResponses = {
  /** What `POST /oauth2/token` answers. Default: a full, realistic success. */
  readonly token?: () => Response;
  /** What `GET /users/@me` answers. Default: Ren. */
  readonly user?: () => Response;
  /** Throw instead of answering — DNS failure, refused connection, timeout. */
  readonly offline?: boolean;
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * A REALISTIC token response. Discord returns five fields beside the access
 * token and not one of them may reach the browser; they are here so the tests
 * can prove they do not travel.
 */
function tokenSuccess(): Response {
  return json({
    access_token: ACCESS_TOKEN,
    refresh_token: REFRESH_TOKEN,
    token_type: 'Bearer',
    expires_in: 604800,
    scope: 'identify guilds guilds.members.read',
  });
}

function userSuccess(id: string = REN_ID): Response {
  return json({ id, username: 'ren', global_name: 'Ren', avatar: 'a1b2c3' });
}

/** The form body as it went out, without stringifying something unprintable. */
function bodyText(body: RequestInit['body']): string {
  if (body instanceof URLSearchParams) return body.toString();
  return typeof body === 'string' ? body : '';
}

function discordStub(responses: StubResponses = {}): {
  readonly calls: OutboundCall[];
  readonly fetch: typeof fetch;
} {
  const calls: OutboundCall[] = [];

  const doFetch: typeof fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({
      url,
      method: init?.method ?? 'GET',
      body: bodyText(init?.body),
      authorization: new Headers(init?.headers).get('authorization'),
    });

    if (responses.offline === true) {
      // Exactly what `fetch` does when DNS fails, the connection is refused, or
      // the eight-second AbortSignal fires — see gotcha 13 in
      // docs/discord-activity.md, which is the realistic cause of all three.
      return Promise.reject(new TypeError('fetch failed'));
    }
    if (url === TOKEN_URL) return Promise.resolve((responses.token ?? tokenSuccess)());
    if (url === USER_URL)
      return Promise.resolve((responses.user ?? ((): Response => userSuccess()))());
    if (url === REVOKE_URL) return Promise.resolve(new Response(null, { status: 200 }));
    return Promise.reject(new Error(`the stub was asked for an unexpected URL: ${url}`));
  };

  return { calls, fetch: doFetch };
}

// ---------------------------------------------------------------------------
// The harness
// ---------------------------------------------------------------------------

/**
 * Built through `readAuthConfig` rather than by hand, so these tests also pin
 * the .env wiring: ALLOWED_USER_IDS and SESSION_TTL_SECONDS really do reach the
 * config the route reads.
 */
function configFrom(env: Record<string, string | undefined>): AuthConfig {
  return readAuthConfig({
    DISCORD_CLIENT_ID: CLIENT_ID,
    DISCORD_CLIENT_SECRET: CLIENT_SECRET,
    ...env,
  });
}

type Harness = {
  readonly sessions: SessionStore;
  readonly calls: readonly OutboundCall[];
  /** Every line pino emitted, raw and UNREDACTED. See the log tests. */
  readonly logLines: readonly string[];
  post(body: unknown): Promise<{ readonly status: number; readonly payload: string }>;
};

type HarnessOptions = {
  readonly env?: Record<string, string | undefined>;
  readonly responses?: StubResponses;
  readonly now?: () => number;
};

function harness(options: HarnessOptions = {}): Harness {
  const config = configFrom(options.env ?? {});
  const stub = discordStub(options.responses);
  const logLines: string[] = [];

  // A REAL PINO WITH NO REDACTION, deliberately. main.ts configures `redact`
  // for the common paths; this harness does not, because the claim under test
  // is that auth.ts never hands a secret to the logger in the FIRST place. With
  // redaction on, a genuine leak would be caught by the censor and this test
  // would pass while the code was wrong.
  const app = Fastify({
    logger: {
      level: 'trace',
      stream: {
        write(line: string): void {
          logLines.push(line);
        },
      },
    },
  });

  const sessions = createSessionStore({
    ttlMs: config.sessionTtlMs,
    now: options.now,
    mintId: (): string => SESSION_ID,
  });

  const deps: AuthDeps = { fetch: stub.fetch, apiBase: API_BASE, now: options.now };
  app.register(authRoutes, { config, sessions, deps });

  return {
    sessions,
    calls: stub.calls,
    logLines,
    async post(body: unknown) {
      // Serialised by hand rather than handed to `inject` as an object, so that
      // a body which is deliberately not an object (an array, a bare string)
      // reaches the route exactly as a browser would have sent it.
      const res = await app.inject({
        method: 'POST',
        url: '/api/token',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify(body),
      });
      return { status: res.statusCode, payload: res.payload };
    },
  };
}

/** Parse a JSON object without reaching for `any`. */
function bodyOf(payload: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(payload);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`expected a JSON object, got: ${payload.slice(0, 80)}`);
  }
  return { ...parsed };
}

/** A clock a test can move. `Date.now` appears nowhere in this file. */
function clock(startMs = 1_700_000_000_000): {
  now: () => number;
  advance: (ms: number) => void;
} {
  let t = startMs;
  return {
    now: (): number => t,
    advance: (ms: number): void => {
      t += ms;
    },
  };
}

beforeAll(async () => {
  const stub = discordStub();
  const auth = createDiscordAuth(configFrom({}), { fetch: stub.fetch, apiBase: API_BASE });
  const result = await auth.verifyIdentity(ACCESS_TOKEN);
  if (!result.ok) throw new Error(`could not mint a test identity: ${result.reason}`);
  REN = result.identity;
});

// ===========================================================================
// WHAT CROSSES BACK TO THE BROWSER
// ===========================================================================

describe('POST /api/token — what the browser is given', () => {
  it('answers with exactly three fields: the access token, the handle, its lifetime', async () => {
    const h = harness({ env: { SESSION_TTL_SECONDS: '900' } });

    const res = await h.post({ code: OAUTH_CODE });

    expect(res.status).toBe(200);
    const body = bodyOf(res.payload);
    expect(Object.keys(body).sort()).toEqual(['access_token', 'session_expires_in', 'session_id']);
    expect(body['access_token']).toBe(ACCESS_TOKEN);
    expect(body['session_id']).toBe(SESSION_ID);
    expect(body['session_expires_in']).toBe(900);
  });

  it('does not pass on the refresh token — Discord sent one, the browser never sees it', async () => {
    const h = harness();

    const res = await h.post({ code: OAUTH_CODE });

    // POSITIVE FIRST, so the negatives cannot pass on an empty flow: Discord
    // really did answer this exchange with a refresh token.
    expect(bodyOf(await tokenSuccess().text())['refresh_token']).toBe(REFRESH_TOKEN);

    expect(res.status).toBe(200);
    expect(res.payload).not.toContain(REFRESH_TOKEN);
    expect(res.payload).not.toContain('refresh_token');
    // Nor anything else from that response. One field travels; five do not.
    expect(res.payload).not.toContain('token_type');
    expect(res.payload).not.toContain('scope');
  });

  it('does not pass on the client secret — it goes to Discord and nowhere else', async () => {
    const h = harness();

    const res = await h.post({ code: OAUTH_CODE });

    // POSITIVE: the secret really was used, so searching for it means something.
    const exchange = h.calls.find((call) => call.url === TOKEN_URL);
    expect(exchange?.method).toBe('POST');
    expect(exchange?.body).toContain(encodeURIComponent(CLIENT_SECRET));
    expect(exchange?.body).toContain('grant_type=authorization_code');

    // NEGATIVE: and none of it came back out.
    expect(res.payload).not.toContain(CLIENT_SECRET);
    expect(res.payload).not.toContain('client_secret');

    // The only hosts this flow may talk to are Discord's own endpoints.
    for (const call of h.calls) expect([TOKEN_URL, USER_URL, REVOKE_URL]).toContain(call.url);
  });

  it('establishes identity with a server-side GET /users/@me bearing the token it just minted', async () => {
    const h = harness();

    await h.post({ code: OAUTH_CODE });

    // CLAUDE.md non-negotiable 5, as a sequence assertion: the exchange happens
    // first, and "who is this" is answered by a SECOND, server-side call to
    // Discord — never by anything the browser said.
    expect(h.calls.map((call) => call.url)).toEqual([TOKEN_URL, USER_URL]);
    expect(h.calls[1]?.method).toBe('GET');
    expect(h.calls[1]?.authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
    // The code went TO Discord and was never echoed back to the caller.
    expect(h.calls[0]?.body).toContain(encodeURIComponent(OAUTH_CODE));
  });

  it('binds the session to the id Discord named, not to anything in the request', async () => {
    const h = harness();

    await h.post({ code: OAUTH_CODE });

    const session = h.sessions.peek(SESSION_ID);
    expect(session?.user.id).toBe(REN_ID);
    expect(session?.displayName).toBe('Ren');
  });
});

// ===========================================================================
// FAIL CLOSED
// ===========================================================================

describe('every failure path ends without an identity', () => {
  it('a refused code yields no identity and no session — and /users/@me is never reached', async () => {
    const h = harness({
      responses: { token: (): Response => json({ error: 'invalid_grant' }, 400) },
    });

    const res = await h.post({ code: OAUTH_CODE });

    expect(res.status).toBe(401);
    const body = bodyOf(res.payload);
    expect(body['error']).toBe(AuthFailure.InvalidCode);
    // NO ANONYMOUS FALLBACK DRESSED UP AS SUCCESS.
    expect(body).not.toHaveProperty('access_token');
    expect(body).not.toHaveProperty('session_id');
    expect(h.sessions.size).toBe(0);
    expect(h.calls.map((call) => call.url)).toEqual([TOKEN_URL]);
  });

  it('a refused /users/@me yields no identity even though the exchange succeeded', async () => {
    const h = harness({
      responses: { user: (): Response => json({ message: '401: Unauthorized', code: 0 }, 401) },
    });

    const res = await h.post({ code: OAUTH_CODE });

    expect(res.status).toBe(401);
    expect(bodyOf(res.payload)['error']).toBe(AuthFailure.InvalidCode);
    // THE ONE THAT MATTERS: a working access token existed inside this process
    // and is still not handed out, because nobody could say whose it was.
    expect(res.payload).not.toContain(ACCESS_TOKEN);
    expect(h.sessions.size).toBe(0);
  });

  it('a malformed /users/@me is a refusal, not a guess', async () => {
    const h = harness({
      // No `id` at all. A tolerant parse here is an identity system that
      // invents people.
      responses: { user: (): Response => json({ username: 'ren', global_name: 'Ren' }) },
    });

    const res = await h.post({ code: OAUTH_CODE });

    expect(res.status).toBe(502);
    expect(bodyOf(res.payload)['error']).toBe(AuthFailure.DiscordMalformed);
    expect(h.sessions.size).toBe(0);
  });

  it('an id that is not a snowflake is refused — a brand that can hold "../x" is no brand', async () => {
    const h = harness({
      responses: { user: (): Response => json({ id: '../../etc/passwd', username: 'ren' }) },
    });

    const res = await h.post({ code: OAUTH_CODE });

    expect(res.status).toBe(502);
    expect(bodyOf(res.payload)['error']).toBe(AuthFailure.DiscordMalformed);
    expect(h.sessions.size).toBe(0);
  });

  it('an unreachable Discord is a 502, never a local decision about who somebody is', async () => {
    const h = harness({ responses: { offline: true } });

    const res = await h.post({ code: OAUTH_CODE });

    expect(res.status).toBe(502);
    expect(bodyOf(res.payload)['error']).toBe(AuthFailure.DiscordUnavailable);
    expect(h.sessions.size).toBe(0);
  });

  it('an unconfigured server refuses with 503 and never calls Discord at all', async () => {
    const h = harness({ env: { DISCORD_CLIENT_SECRET: '' } });

    const res = await h.post({ code: OAUTH_CODE });

    expect(res.status).toBe(503);
    expect(bodyOf(res.payload)['error']).toBe(AuthFailure.Unconfigured);
    expect(h.calls).toHaveLength(0);
    expect(h.sessions.size).toBe(0);
  });

  it('a body that tries to name a user is rejected outright, not sanitised', async () => {
    const h = harness();

    // `z.strictObject`, one key. This is the HTTP half of "there is no field in
    // which to say I am Ren"; identity.test.ts is the socket half.
    const res = await h.post({ code: OAUTH_CODE, userId: REN_ID, actorId: 'actor_u_deadbeef' });

    expect(res.status).toBe(400);
    expect(bodyOf(res.payload)['error']).toBe(AuthFailure.BadRequest);
    expect(h.calls).toHaveLength(0);
    expect(h.sessions.size).toBe(0);
  });

  it('a missing, empty or non-object body is a 400', async () => {
    const h = harness();

    expect(bodyOf((await h.post({})).payload)['error']).toBe(AuthFailure.BadRequest);
    expect(bodyOf((await h.post({ code: '' })).payload)['error']).toBe(AuthFailure.BadRequest);
    expect(bodyOf((await h.post([OAUTH_CODE])).payload)['error']).toBe(AuthFailure.BadRequest);
    expect(h.sessions.size).toBe(0);
  });

  it('rate limiting refuses rather than admits — a 429 is still not an identity', async () => {
    const h = harness({
      responses: { token: (): Response => json({ error: 'invalid_grant' }, 400) },
    });

    const statuses: number[] = [];
    for (let attempt = 0; attempt < 12; attempt += 1) {
      statuses.push((await h.post({ code: OAUTH_CODE })).status);
    }

    expect(statuses.filter((status) => status === 429).length).toBeGreaterThan(0);
    expect(statuses.every((status) => status >= 400)).toBe(true);
    expect(h.sessions.size).toBe(0);
  });
});

// ===========================================================================
// ALLOWED_USER_IDS
// ===========================================================================

describe('ALLOWED_USER_IDS', () => {
  it('admits an id inside the list', async () => {
    const h = harness({ env: { ALLOWED_USER_IDS: `${REN_ID},${STRANGER_ID}` } });

    const res = await h.post({ code: OAUTH_CODE });

    expect(res.status).toBe(200);
    expect(h.sessions.peek(SESSION_ID)?.user.id).toBe(REN_ID);
  });

  it('refuses an id outside it, mints no session, and revokes the token it just made', async () => {
    const h = harness({
      env: { ALLOWED_USER_IDS: REN_ID },
      responses: { user: (): Response => userSuccess(STRANGER_ID) },
    });

    const res = await h.post({ code: OAUTH_CODE });

    expect(res.status).toBe(403);
    expect(bodyOf(res.payload)['error']).toBe(AuthFailure.NotAllowed);
    expect(res.payload).not.toContain(ACCESS_TOKEN);
    expect(h.sessions.size).toBe(0);

    // A refused player must not be left holding a working credential that this
    // server's own client secret minted for them.
    const revoke = h.calls.find((call) => call.url === REVOKE_URL);
    expect(revoke?.body).toContain(encodeURIComponent(ACCESS_TOKEN));
  });

  it('is checked against the VERIFIED id, never against anything the caller supplied', async () => {
    const h = harness({
      env: { ALLOWED_USER_IDS: REN_ID },
      // The caller dresses the code up as Ren's; Discord says otherwise.
      responses: { user: (): Response => userSuccess(STRANGER_ID) },
    });

    const res = await h.post({ code: `${OAUTH_CODE}-${REN_ID}` });

    expect(res.status).toBe(403);
    expect(h.sessions.size).toBe(0);
  });

  it('an empty list admits anybody who can complete the handshake', async () => {
    const h = harness({
      env: { ALLOWED_USER_IDS: '' },
      responses: { user: (): Response => userSuccess(STRANGER_ID) },
    });

    const res = await h.post({ code: OAUTH_CODE });

    expect(res.status).toBe(200);
    expect(h.sessions.peek(SESSION_ID)?.user.id).toBe(STRANGER_ID);
    expect(h.calls.some((call) => call.url === REVOKE_URL)).toBe(false);
  });

  it('drops entries that are not snowflakes rather than admitting them', () => {
    // A typo'd entry that silently became a valid one is an allowlist with a
    // hole in it that nothing ever reports.
    const parsed = parseUserIdList(` ${REN_ID} , ren#1234 , , 12 , ${STRANGER_ID}`);

    expect([...parsed.ids].sort()).toEqual([REN_ID, STRANGER_ID].sort());
    expect(parsed.rejected).toBe(2);

    // Every entry rejected leaves the list EMPTY, which means "everyone" — the
    // documented behaviour, and worth pinning because the opposite reading
    // would lock the owner out of their own server.
    expect(configFrom({ ALLOWED_USER_IDS: 'ren#1234' }).allowedUserIds.size).toBe(0);
  });

  it('takes a verified id, which is the only kind there is', () => {
    expect(isAllowed(configFrom({ ALLOWED_USER_IDS: REN_ID }), REN.id)).toBe(true);
    expect(isAllowed(configFrom({ ALLOWED_USER_IDS: STRANGER_ID }), REN.id)).toBe(false);
    expect(isAllowed(configFrom({ ALLOWED_USER_IDS: '' }), REN.id)).toBe(true);
  });
});

// ===========================================================================
// SESSION LIFETIME
// ===========================================================================

describe('sessions expire after SESSION_TTL_SECONDS', () => {
  it('is alive one millisecond before the TTL and gone at it', async () => {
    const time = clock();
    const h = harness({ env: { SESSION_TTL_SECONDS: '60' }, now: time.now });

    const res = await h.post({ code: OAUTH_CODE });
    expect(bodyOf(res.payload)['session_expires_in']).toBe(60);

    // `peek`, not `get`: reading must not be the thing keeping it alive here.
    // The sliding half is asserted below, on its own terms.
    time.advance(59_999);
    expect(h.sessions.peek(SESSION_ID)?.user.id).toBe(REN_ID);

    time.advance(1);
    expect(h.sessions.peek(SESSION_ID)).toBeUndefined();
    // Gone for good. An expired handle is indistinguishable from one that was
    // never real, which is exactly the answer the gateway wants.
    expect(h.sessions.get(SESSION_ID)).toBeUndefined();
  });

  it('slides forward while somebody is actually using it', async () => {
    const time = clock();
    const h = harness({ env: { SESSION_TTL_SECONDS: '60' }, now: time.now });
    await h.post({ code: OAUTH_CODE });

    // What the gateway's 30-second heartbeat does: a live WebSocket keeps a
    // session alive indefinitely, and an idle one dies on schedule.
    for (let tick = 0; tick < 10; tick += 1) {
      time.advance(30_000);
      expect(h.sessions.get(SESSION_ID)?.user.id).toBe(REN_ID);
    }

    time.advance(60_000);
    expect(h.sessions.peek(SESSION_ID)).toBeUndefined();
  });

  it('clamps an absurd SESSION_TTL_SECONDS instead of honouring it', () => {
    expect(configFrom({ SESSION_TTL_SECONDS: '0' }).sessionTtlMs).toBe(60_000);
    expect(configFrom({ SESSION_TTL_SECONDS: '99999999' }).sessionTtlMs).toBe(86_400_000);
    expect(configFrom({ SESSION_TTL_SECONDS: 'soon' }).sessionTtlMs).toBe(900_000);
  });

  it('one account, one seat: re-authenticating retires the previous handle', () => {
    const time = clock();
    const sessions = createSessionStore({ ttlMs: 60_000, now: time.now });

    const first = sessions.create(REN, 'Ren');
    const second = sessions.create(REN, 'Ren');

    expect(second.id).not.toBe(first.id);
    expect(sessions.peek(first.id)).toBeUndefined();
    expect(sessions.peek(second.id)?.displayName).toBe('Ren');
    expect(sessions.size).toBe(1);
  });

  it('a handle nobody minted resolves to nobody, whatever it looks like', () => {
    const sessions = createSessionStore({ ttlMs: 60_000, now: clock().now });
    const real = sessions.create(REN, 'Ren');

    for (const forged of [real.id.slice(0, -1), `${real.id}x`, '', 'undefined', 'null']) {
      expect(sessions.get(forged)).toBeUndefined();
    }
    expect(sessions.get(undefined)).toBeUndefined();
    // …and the real one still works, so the loop above proved a distinction.
    expect(sessions.get(real.id)?.user.id).toBe(REN_ID);
  });
});

// ===========================================================================
// THE LOG
// ===========================================================================

describe('nothing secret is ever handed to the logger', () => {
  it('no emitted line contains the secret, the code, either token, or the handle', async () => {
    const h = harness({ env: { ALLOWED_USER_IDS: REN_ID } });

    // Three flows through one app — success, malformed body, missing body — so
    // the sweep covers all three shapes of log line at once. Kept well under
    // the ten-per-window per-IP limit.
    await h.post({ code: OAUTH_CODE });
    await h.post({ code: OAUTH_CODE, userId: REN_ID });
    await h.post({ nothing: true });

    const log = h.logLines.join('\n');

    // POSITIVE FIRST: the log is not empty and really did record this flow.
    // Without these, the four negatives below would pass on silence.
    expect(h.logLines.length).toBeGreaterThan(0);
    expect(log).toContain('auth: identity verified, session minted');
    expect(log).toContain('auth: malformed /api/token body');

    expect(log).not.toContain(CLIENT_SECRET);
    expect(log).not.toContain(OAUTH_CODE);
    expect(log).not.toContain(ACCESS_TOKEN);
    expect(log).not.toContain(REFRESH_TOKEN);
    expect(log).not.toContain(SESSION_ID);
  });

  it('a player appears as a truncated hash, never as a raw snowflake', async () => {
    const h = harness();

    await h.post({ code: OAUTH_CODE });

    const log = h.logLines.join('\n');
    // CLAUDE.md non-negotiable 7: the repo is public, and a log excerpt has to
    // be safe to paste into an issue.
    expect(log).not.toContain(REN_ID);
    expect(log).toMatch(/"user":"u_[0-9a-f]{8}"/);
  });

  it('logs a refusal loudly, and still without the credential that caused it', async () => {
    const h = harness({
      env: { ALLOWED_USER_IDS: REN_ID },
      responses: { user: (): Response => userSuccess(STRANGER_ID) },
    });

    await h.post({ code: OAUTH_CODE });

    const log = h.logLines.join('\n');
    expect(log).toContain('auth: refused');
    expect(log).not.toContain(STRANGER_ID);
    expect(log).not.toContain(ACCESS_TOKEN);
  });

  it("keeps Discord's own error slug, which is the only way to tell two failures apart", async () => {
    const h = harness({
      responses: { token: (): Response => json({ error: 'invalid_grant' }, 400) },
    });

    await h.post({ code: OAUTH_CODE });

    const log = h.logLines.join('\n');
    // An expired code (a player who left the tab open) and the Cloudflare block
    // of gotcha 13 are otherwise indistinguishable in production.
    expect(log).toContain('400 invalid_grant');
    expect(log).not.toContain(OAUTH_CODE);
  });
});

// ===========================================================================
// NAMES — hostile input, made safe once
// ===========================================================================

describe('display names', () => {
  it('keeps the name Discord gave and removes the characters that let one lie', async () => {
    const h = harness({
      responses: {
        user: (): Response =>
          json({
            id: REN_ID,
            username: 'ren',
            // A bidi override, a zero-width space and a newline: the three ways
            // a party-panel row pretends to be somebody else's.
            global_name: 'Ren‮​\nsomebody else',
          }),
      },
    });

    await h.post({ code: OAUTH_CODE });

    const name = h.sessions.peek(SESSION_ID)?.displayName ?? '';
    expect(name).not.toContain('‮');
    expect(name).not.toContain('​');
    expect(name).not.toContain('\n');
    expect(name.startsWith('Ren')).toBe(true);
  });

  it('never produces a nameless row in the party panel', () => {
    expect(safeDisplayName({ ...REN, globalName: '​', username: ' ' })).toBe('Detective');
    expect(safeDisplayName({ ...REN, globalName: null })).toBe('ren');
  });
});

// ---------------------------------------------------------------------------
// THE FRONT DOOR IS WIRED — main.ts, not just the gateway
// ---------------------------------------------------------------------------

describe('the deployed server requires a Discord identity', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE GATE EXISTS IN `gateway.ts` AND IS USELESS UNLESS `main.ts` PASSES IT.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `WsGatewayOptions.requireIdentity` defaults to FALSE so every fixture keeps
   * the behaviour it was written against — which means the one place that turns
   * it on is production wiring, and nothing that constructs its own gateway can
   * notice if that line is deleted. Verified by mutation: replacing it with
   * `false` fails no test in `identity.test.ts`, because those build their own.
   *
   * This is the shape that put anonymous strangers in the town in the first
   * place: a refusal that was correct everywhere except where it had to run.
   */
  const SOURCE = readFileSync('src/server/main.ts', 'utf8');

  it('turns the gate on whenever Discord credentials are configured', () => {
    expect(SOURCE, 'main.ts no longer requires an identity').toMatch(
      /requireIdentity:\s*isConfigured\(authConfig\)/,
    );
  });

  it('decides it from the credentials, not from a hard-coded answer', () => {
    /**
     * `isConfigured` is both halves of the OAuth credential being present, and
     * it is the whole reason a dev build with an empty `.env` still plays. A
     * literal here — either literal — would break one of the two situations:
     * `true` locks every developer out of their own build, `false` reopens the
     * public door.
     */
    expect(SOURCE, 'the gate was hard-coded instead of read from the config').not.toMatch(
      /requireIdentity:\s*(true|false)\b/,
    );
  });
});
