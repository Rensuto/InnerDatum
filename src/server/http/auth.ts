// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *   IDENTITY. THE ONE PLACE IN THE PROCESS THAT DECIDES WHO SOMEBODY IS.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * CLAUDE.md non-negotiable #5, verbatim: "Identity comes from a server-side
 * `GET /users/@me`, never from a field on the wire — the protocol has no
 * `actorId`/`userId` key at all." This file is the `GET /users/@me`. Nothing
 * else in the server may establish a Discord user id, and `DiscordUserId` is a
 * branded type precisely so the compiler enforces that: there is exactly one
 * cast to it in the codebase and it is forty lines below, guarded by a lint
 * directive that ESLint fails the build over if it ever goes stale.
 *
 * Discord's own rule says the same thing and is worth reading in full at
 * docs/discord-activity.md § 5: "assume any data coming from the Discord Client
 * could be falsified. That includes data about the current user… If you need
 * this information in a trusted manner, contact Discord API directly from your
 * application's server."
 *
 * ───────────────────────────────────────────────────────────────────────────
 * THE FLOW, AND WHAT EACH STEP PROVES
 * ───────────────────────────────────────────────────────────────────────────
 *
 *   1. The client asks Discord for an OAuth `code` (`commands.authorize`).
 *      A code proves NOTHING on its own and is worthless to anyone else: it is
 *      single-use, short-lived, and only redeemable by whoever holds this app's
 *      client secret.
 *   2. `POST /api/token { code }` — we exchange it at Discord's token endpoint
 *      using DISCORD_CLIENT_ID + DISCORD_CLIENT_SECRET. The secret never leaves
 *      this process; the client never sees it, and nothing here ever logs it.
 *   3. `GET /users/@me` with the resulting bearer token. THIS is the trusted
 *      answer to "who is this", and it is the only one the server will accept.
 *   4. ALLOWED_USER_IDS, when non-empty, decides whether that person may play.
 *   5. A session id is minted (session.ts) and mapped to the Discord id
 *      SERVER-SIDE. The browser receives an opaque handle and nothing about
 *      itself that it could have made up.
 *
 * A client that says "I am Ren" is not disbelieved — it is unable to say it.
 * There is no field for it in the request body (`z.strictObject`, one key), and
 * there is no field for it in the WebSocket protocol at all.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * FAIL CLOSED. EVERY PATH.
 * ───────────────────────────────────────────────────────────────────────────
 * A malformed body, a rejected code, a timeout, a 500 from Discord, a response
 * that does not parse, a snowflake that is not on the allowlist — every one of
 * them ends in a refusal with a reason. NONE of them falls back to an anonymous
 * actor, a guest id, or a "development mode" bypass. The failure mode of an
 * identity system that degrades gracefully is that everybody is somebody else.
 *
 * The one deliberately soft edge is BOOT: an unconfigured server (no client
 * secret in .env) still starts, still serves /healthz, and refuses every token
 * request with 503. That is what keeps `npm run smoke` — which boots with no
 * .env at all — honest, and refusing to boot would trade a clear 503 for an
 * outage.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHAT NEVER GETS LOGGED
 * ───────────────────────────────────────────────────────────────────────────
 * The client secret, the OAuth code, the access token, the refresh token, the
 * session id, and any Discord response object. `main.ts` configures pino
 * `redact` for the common paths; this file does not rely on it, because
 * redaction only catches the shapes somebody thought of. Nothing secret is
 * passed to the logger in the first place.
 *
 * Snowflakes are not secrets, but the repo is public and CLAUDE.md #7 warns
 * specifically about "a log excerpt with a raw snowflake in it". So the log
 * carries `user: 'u_<8 hex>'` — a truncated SHA-256 of the id, stable within a
 * process, enough to follow one person through a session, and reversible only
 * by someone who already knows the snowflake.
 */

import { createHash } from 'node:crypto';
import { env } from 'node:process';

import { z } from 'zod';

import type { FastifyPluginCallback } from 'fastify';
import type { SessionStore } from './session.ts';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Discord's API root. Overridable ONLY through `AuthDeps.apiBase`, which exists
 * so a test can point the two calls at a local stub — never so that a
 * deployment can be redirected at a different identity provider by an
 * environment variable, which is the shape this constant would take if it read
 * `env` and is the reason it does not.
 */
const DEFAULT_API_BASE = 'https://discord.com/api';

/**
 * How long we wait for Discord.
 *
 * Eight seconds, chosen against gotcha 13 in docs/discord-activity.md: a
 * residential IP can inherit a Cloudflare block, at which point these calls
 * hang or 403 for up to an hour. A player is far better served by a clear
 * "Discord did not answer" after eight seconds than by a spinner that never
 * resolves, and the Fastify worker is better served by not holding the socket.
 */
const DISCORD_TIMEOUT_MS = 8_000;

/**
 * An OAuth code is ~30 characters. 512 is three orders of magnitude of headroom
 * and exists so that the string we are about to put in a form body and send to
 * Discord has a bound before anything touches it.
 */
const MAX_CODE_CHARS = 512;

/** Discord snowflakes are 17-20 decimal digits. Nothing else is an id. */
const SNOWFLAKE = /^\d{17,20}$/;

/**
 * THE PER-IP LIMIT, AND AN HONEST NOTE ABOUT WHAT IT IS WORTH.
 *
 * `trustProxy` is on (Discord's proxy sits in front of Caddy, which sits in
 * front of us), so `request.ip` is whatever `X-Forwarded-For` said. Anyone
 * reaching the origin directly can therefore pick their own. This limit is an
 * ACCIDENT LIMITER — a client stuck in a retry loop, a friend refreshing
 * frantically — and is not a security control.
 *
 * The PROCESS limit below is the one that cannot be spoofed, and it is the one
 * that matters: every exchange is an outbound call to Discord from a
 * residential IP, and hammering that egress is exactly how the Cloudflare block
 * in gotcha 13 gets earned. Sixty a minute is roughly ten times the busiest
 * plausible session (six players, each reloading).
 */
const IP_ATTEMPTS_PER_WINDOW = 10;
const PROCESS_ATTEMPTS_PER_WINDOW = 60;
const RATE_WINDOW_MS = 60_000;

/** Bounds the limiter's own memory. Beyond this the window is simply reset. */
const MAX_TRACKED_IPS = 256;

/**
 * The verified-identity cache, keyed by a hash of the access token.
 *
 * KEYED BY TOKEN, NEVER BY USER ID. A cache keyed by id would answer "who is
 * this token" with "whoever last used this account", which is an identity
 * system that can be poisoned by anyone who can guess a snowflake. The key is
 * the credential; the value is what that credential proved.
 *
 * Capped at the session TTL and never longer than fifteen minutes, so a token
 * revoked in Discord's UI stops working here within that window rather than
 * whenever someone remembers. Sized at 64 for the same reason the session table
 * is: under ten players.
 */
const MAX_IDENTITY_CACHE_MS = 15 * 60_000;
const MAX_CACHED_IDENTITIES = 64;

/** Longest display name kept. Discord's own cap is 32; this matches it. */
const MAX_NAME_CHARS = 32;

/** Longest error slug echoed from Discord into our log. `invalid_grant` is 13. */
const MAX_SLUG_CHARS = 40;

/** Session lifetime bounds. Below a minute is useless; a day is not a session. */
const DEFAULT_SESSION_TTL_SECONDS = 900;
const MIN_SESSION_TTL_SECONDS = 60;
const MAX_SESSION_TTL_SECONDS = 86_400;

// ---------------------------------------------------------------------------
// The branded id — one producer, enforced by ESLint
// ---------------------------------------------------------------------------

/**
 * A Discord snowflake THAT THIS FILE VERIFIED WITH DISCORD.
 *
 * The brand is not decoration. `eslint.config.js` bans every `as DiscordUserId`
 * in `src/server/**` and `src/client/**` and names this file as the sole
 * producer, so the only way to obtain one is to have called `/users/@me`. A
 * function that takes a `DiscordUserId` is therefore documenting, in a way the
 * compiler checks, that it will not accept a string somebody sent us.
 */
export type DiscordUserId = string & { readonly __brand: 'DiscordUserId' };

/**
 * What Discord says about the person holding an access token.
 *
 * `globalName` is the display name people actually recognise; `username` is the
 * lowercase handle and is the fallback. `avatar` is a HASH, not a URL — the URL
 * that uses it embeds the snowflake, so composing one is a decision about what
 * goes on the wire to other players and belongs to whoever writes the projector,
 * not here.
 *
 * ALL THREE STRINGS ARE HOSTILE INPUT. docs/discord-activity.md § 5: "data
 * coming from the Discord client is not sanitized beforehand". A friend can set
 * their global name to anything at all. `safeDisplayName` below is what makes
 * one safe to put in the party panel; the client's ban on `innerHTML` is the
 * second layer.
 */
export type DiscordIdentity = {
  readonly id: DiscordUserId;
  readonly username: string;
  readonly globalName: string | null;
  readonly avatar: string | null;
};

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

/**
 * Every way this can say no. A const object rather than an `enum` — the server
 * runs under Node's type stripping, so `erasableSyntaxOnly` forbids enums
 * (CLAUDE.md #1).
 *
 * The slugs are stable and safe to show a player. None of them distinguishes
 * "you are not on the allowlist" from "your account does not exist", because
 * that difference is not the player's business and telling an unknown caller
 * which snowflakes are known is free reconnaissance.
 */
export const AuthFailure = {
  /** No client id or secret configured. The server cannot authenticate anyone. */
  Unconfigured: 'auth_unconfigured',
  /** The request body was not `{ code: string }`. */
  BadRequest: 'bad_request',
  /** Discord refused the code, or the token it returned did not work. */
  InvalidCode: 'invalid_code',
  /** Verified, and not on ALLOWED_USER_IDS. */
  NotAllowed: 'not_allowed',
  /** Our own limiter, or Discord's 429 passed through. */
  RateLimited: 'rate_limited',
  /** Timed out, DNS failed, connection refused — see gotcha 13. */
  DiscordUnavailable: 'discord_unavailable',
  /** Discord answered with something that is not the shape it documents. */
  DiscordMalformed: 'discord_malformed',
} as const;
export type AuthFailure = (typeof AuthFailure)[keyof typeof AuthFailure];

/** HTTP status per failure. Explicit keys, so a new failure breaks the build. */
const STATUS_BY_FAILURE: Readonly<Record<AuthFailure, number>> = {
  auth_unconfigured: 503,
  bad_request: 400,
  invalid_code: 401,
  not_allowed: 403,
  rate_limited: 429,
  discord_unavailable: 502,
  discord_malformed: 502,
};

/**
 * What the player is told. One sentence, no internals, no paths, no ids.
 *
 * `not_allowed` names the fix ("ask to be added") because the person reading it
 * is a friend who was invited to a game and is staring at a locked door.
 */
const MESSAGE_BY_FAILURE: Readonly<Record<AuthFailure, string>> = {
  auth_unconfigured: 'this server is not configured for Discord sign-in yet',
  bad_request: 'expected a body of { code: string }',
  invalid_code: 'Discord would not accept that sign-in — try launching again',
  not_allowed: 'this Discord account is not on the allowlist — ask to be added',
  rate_limited: 'too many sign-in attempts — wait a minute and try again',
  discord_unavailable: 'could not reach Discord — try again shortly',
  discord_malformed: 'Discord answered with something unexpected',
};

/**
 * One short, non-secret diagnostic string for the log — `'403 invalid_grant'`.
 *
 * It exists because the two failures that will actually happen in production
 * are indistinguishable without it: an expired code (`400 invalid_grant`, a
 * player who left the tab open) and the Cloudflare block described in
 * docs/discord-activity.md gotcha 13 (`403`, and nothing anyone can do for an
 * hour). Never shown to the player, never derived from the response BODY beyond
 * Discord's own `error` slug, and capped at MAX_SLUG_CHARS.
 */
type FailureDetail = { readonly detail?: string };

export type IdentityResult =
  | { readonly ok: true; readonly identity: DiscordIdentity }
  | ({ readonly ok: false; readonly reason: AuthFailure } & FailureDetail);

export type ExchangeResult =
  | { readonly ok: true; readonly accessToken: string }
  | ({ readonly ok: false; readonly reason: AuthFailure } & FailureDetail);

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export type AuthConfig = {
  /** Public by construction — it is in every client URL. Empty when unset. */
  readonly clientId: string;
  /** SECRET. Empty when unset, which makes `isConfigured` false. */
  readonly clientSecret: string;
  /**
   * Who may play. EMPTY MEANS EVERYONE WHO CAN LAUNCH THE ACTIVITY, which is
   * already a closed set: an unverified Activity is visible only to the
   * developer and to App Testers, in servers under 25 members
   * (docs/discord-activity.md §§ 2, 7). Discord is the outer gate; this is the
   * inner one, for when the outer one is opened wider than intended.
   */
  readonly allowedUserIds: ReadonlySet<string>;
  readonly sessionTtlMs: number;
};

export type AuthDeps = {
  /** Injected in tests. Default: the global `fetch`. */
  readonly fetch?: typeof fetch;
  /** Injected in tests. Default: `Date.now`. */
  readonly now?: () => number;
  /** Injected in tests. Default: `https://discord.com/api`. */
  readonly apiBase?: string;
};

/**
 * Parse a comma-separated snowflake list.
 *
 * Anything that is not a snowflake is DROPPED, not tolerated: a typo'd id in
 * ALLOWED_USER_IDS that silently became a valid entry would be an allowlist
 * with a hole in it that nothing ever reports. The count of rejects is returned
 * so the caller can say so out loud without printing anyone's id.
 *
 * Exported because GM_USER_IDS is the same shape and must be parsed the same
 * way — two spellings of "is this a snowflake" is one spelling too many.
 */
export function parseUserIdList(raw: string | undefined): {
  readonly ids: ReadonlySet<string>;
  readonly rejected: number;
} {
  const ids = new Set<string>();
  let rejected = 0;
  for (const part of (raw ?? '').split(',')) {
    const trimmed = part.trim();
    if (trimmed === '') continue;
    if (SNOWFLAKE.test(trimmed)) ids.add(trimmed);
    else rejected += 1;
  }
  return { ids, rejected };
}

/** Clamped so a typo in .env cannot mint a session that outlives the year. */
function readTtlSeconds(raw: string | undefined): number {
  const parsed = Number(raw ?? DEFAULT_SESSION_TTL_SECONDS);
  if (!Number.isFinite(parsed)) return DEFAULT_SESSION_TTL_SECONDS;
  return Math.min(MAX_SESSION_TTL_SECONDS, Math.max(MIN_SESSION_TTL_SECONDS, Math.trunc(parsed)));
}

/**
 * Read .env once, at boot.
 *
 * Missing values produce an UNCONFIGURED config rather than a throw — see the
 * header's note about boot. The rejected-id count is deliberately not logged
 * from here; `main.ts` has the logger and this function must stay usable from a
 * test with no server around it.
 */
export function readAuthConfig(source: Record<string, string | undefined> = env): AuthConfig {
  const allowed = parseUserIdList(source['ALLOWED_USER_IDS']);
  return {
    clientId: (source['DISCORD_CLIENT_ID'] ?? '').trim(),
    clientSecret: (source['DISCORD_CLIENT_SECRET'] ?? '').trim(),
    allowedUserIds: allowed.ids,
    sessionTtlMs: readTtlSeconds(source['SESSION_TTL_SECONDS']) * 1000,
  };
}

/** Both halves of the OAuth credential present. Neither alone is usable. */
export function isConfigured(config: AuthConfig): boolean {
  return config.clientId !== '' && config.clientSecret !== '';
}

/**
 * Is this verified snowflake allowed to play?
 *
 * Takes a `DiscordUserId`, so it is impossible to call with a string off the
 * wire — which is the entire point of the brand. An empty allowlist means yes;
 * see `AuthConfig.allowedUserIds`.
 */
export function isAllowed(config: AuthConfig, userId: DiscordUserId): boolean {
  return config.allowedUserIds.size === 0 || config.allowedUserIds.has(userId);
}

// ---------------------------------------------------------------------------
// Names — hostile input, made safe once, here
// ---------------------------------------------------------------------------

/**
 * Strip the characters that let a name lie about what it is.
 *
 * Not an XSS defence — the client already cannot write HTML (`no-restricted-
 * properties` bans `innerHTML` outright). This is about the OTHER half:
 * control characters that break a log line into two, zero-width characters that
 * make two different players render identically in the party panel, and bidi
 * overrides that reverse the text after them and can make "Ren" appear to be
 * somebody else entirely.
 *
 * Written as a code-point walk rather than a regex because a control-character
 * class trips `no-control-regex`, and because the intent reads better as a list
 * of ranges with reasons than as an escape sequence.
 */
function stripDeceptiveChars(raw: string): string {
  let out = '';
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 0;
    // C0 controls, DEL, and C1 controls: newlines and escape sequences.
    if (code < 0x20) continue;
    if (code >= 0x7f && code <= 0x9f) continue;
    // Zero-width space / non-joiner / joiner, and the BOM used as one.
    if (code === 0x200b || code === 0x200c || code === 0x200d || code === 0xfeff) continue;
    // Bidi embedding and override controls.
    if (code >= 0x202a && code <= 0x202e) continue;
    // Bidi isolates.
    if (code >= 0x2066 && code <= 0x2069) continue;
    out += ch;
  }
  return out;
}

/**
 * The name the rest of the game may use.
 *
 * `globalName` first because that is what a friend recognises, `username` as
 * the fallback, and a neutral placeholder if a player has managed to make both
 * of them empty once the deceptive characters are gone — which is the case that
 * would otherwise put a nameless row in the party panel.
 *
 * Capped by CODE POINT, not by UTF-16 length: slicing a string at 32 units can
 * cut an emoji in half and produce a lone surrogate, which then travels all the
 * way to a save file as invalid UTF-8.
 */
export function safeDisplayName(identity: DiscordIdentity): string {
  for (const candidate of [identity.globalName, identity.username]) {
    if (candidate === null) continue;
    const cleaned = stripDeceptiveChars(candidate).replace(/\s+/g, ' ').trim();
    if (cleaned === '') continue;
    return Array.from(cleaned).slice(0, MAX_NAME_CHARS).join('');
  }
  return 'Detective';
}

// ---------------------------------------------------------------------------
// Discord's wire shapes. Parsed, never trusted, never passed on whole.
// ---------------------------------------------------------------------------

/**
 * `z.object`, not `z.strictObject`: Discord adds fields to this response and a
 * strict schema would turn a Discord changelog entry into an outage. Zod strips
 * what it does not name, which is ALSO the mechanism that keeps `refresh_token`
 * out of everything downstream — after this parse, that field does not exist in
 * this process. The one field we return to the browser is picked out by hand
 * below regardless; this is defence in depth, not the defence.
 */
const TokenResponseSchema = z.object({
  access_token: z.string().min(1).max(2048),
});

/**
 * `/users/@me`. `id` is validated as a snowflake before it is allowed to become
 * a `DiscordUserId` — the brand promises "Discord said this", and a brand that
 * can hold `"../../etc"` is a brand that gets concatenated into a path in
 * `saves.ts` six months from now.
 */
const UserResponseSchema = z.object({
  id: z.string().regex(SNOWFLAKE),
  username: z.string().min(1).max(128),
  global_name: z.string().max(128).nullish(),
  avatar: z.string().max(128).nullish(),
});

/** The request body. One key, and `strictObject` rejects any other. */
const TokenRequestSchema = z.strictObject({
  code: z.string().min(1).max(MAX_CODE_CHARS),
});

// ---------------------------------------------------------------------------
// Hashing — for cache keys and log tags, never for storage
// ---------------------------------------------------------------------------

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * A stable, non-reversible label for a secret, safe to put in a log.
 *
 * Eight hex characters is 32 bits: enough to follow one person or one token
 * through a session's logs, useless to anyone trying to recover the input, and
 * short enough that a collision would be visible as two people behaving as one
 * rather than as a security hole (the tag is never used to make a decision —
 * only to read).
 */
function logTag(prefix: string, secret: string): string {
  return `${prefix}_${sha256(secret).slice(0, 8)}`;
}

// ---------------------------------------------------------------------------
// The Discord client
// ---------------------------------------------------------------------------

type CachedIdentity = {
  readonly identity: DiscordIdentity;
  readonly expiresAtMs: number;
};

export type DiscordAuth = {
  /** Step 2: `code` -> access token. Needs the client secret. */
  exchangeCode(code: string): Promise<ExchangeResult>;
  /**
   * Step 3: access token -> WHO. The only place a Discord user id is
   * established. Cached by token hash for the session TTL.
   */
  verifyIdentity(accessToken: string): Promise<IdentityResult>;
  /**
   * Best effort. Called when a verified user turns out not to be allowed, so
   * that a token minted with our client secret is not left live for somebody we
   * just refused.
   */
  revokeToken(accessToken: string): Promise<void>;
};

/**
 * Build the Discord-facing half.
 *
 * Separate from the routes so that it can be exercised without a Fastify
 * instance, and so that `verifyIdentity` is callable from anywhere in
 * `src/server/http/` that later needs it.
 */
export function createDiscordAuth(config: AuthConfig, deps: AuthDeps = {}): DiscordAuth {
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? ((): number => Date.now());
  const apiBase = deps.apiBase ?? DEFAULT_API_BASE;
  const tokenUrl = `${apiBase}/oauth2/token`;
  const revokeUrl = `${apiBase}/oauth2/token/revoke`;
  const userUrl = `${apiBase}/users/@me`;
  const cacheTtlMs = Math.min(config.sessionTtlMs, MAX_IDENTITY_CACHE_MS);

  /** token hash -> what that token proved. Never keyed by user id. */
  const identityCache = new Map<string, CachedIdentity>();

  const pruneCache = (nowMs: number): void => {
    for (const [key, entry] of identityCache) {
      if (entry.expiresAtMs <= nowMs) identityCache.delete(key);
    }
    while (identityCache.size >= MAX_CACHED_IDENTITIES) {
      const oldest = identityCache.keys().next();
      if (oldest.done === true) break;
      identityCache.delete(oldest.value);
    }
  };

  /**
   * The status, plus Discord's own error slug (`invalid_grant`) when it sent
   * one.
   *
   * THE BODY IS NEVER LOGGED AND NEVER RETURNED. Only this one short, known,
   * non-secret field is lifted out of it — which is the difference between a
   * log line that helps and one that quietly records whatever Discord decided
   * to echo back, including, on some error paths, a copy of the request that
   * produced it.
   */
  const failureDetail = async (res: Response): Promise<string> => {
    try {
      const body: unknown = await res.json();
      if (typeof body === 'object' && body !== null && 'error' in body) {
        const slug = body.error;
        if (typeof slug === 'string' && slug !== '') {
          return `${res.status} ${slug.slice(0, MAX_SLUG_CHARS)}`;
        }
      }
    } catch {
      // Not JSON, or the connection died mid-body. The status still helps.
    }
    return String(res.status);
  };

  const exchangeCode = async (code: string): Promise<ExchangeResult> => {
    if (!isConfigured(config)) return { ok: false, reason: AuthFailure.Unconfigured };

    const form = new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      grant_type: 'authorization_code',
      code,
    });

    let res: Response;
    try {
      res = await doFetch(tokenUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: form,
        signal: AbortSignal.timeout(DISCORD_TIMEOUT_MS),
      });
    } catch {
      // The thrown value can carry the request — including the form body, and
      // therefore the client secret. It is caught and DROPPED, never logged,
      // never wrapped, never re-thrown.
      return { ok: false, reason: AuthFailure.DiscordUnavailable };
    }

    if (!res.ok) {
      const detail = await failureDetail(res);
      if (res.status === 429) return { ok: false, reason: AuthFailure.RateLimited, detail };
      // 4xx is a bad or already-redeemed code; 5xx is Discord's problem.
      if (res.status >= 500) return { ok: false, reason: AuthFailure.DiscordUnavailable, detail };
      return { ok: false, reason: AuthFailure.InvalidCode, detail };
    }

    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return { ok: false, reason: AuthFailure.DiscordMalformed };
    }

    const parsed = TokenResponseSchema.safeParse(body);
    if (!parsed.success) return { ok: false, reason: AuthFailure.DiscordMalformed };
    return { ok: true, accessToken: parsed.data.access_token };
  };

  const verifyIdentity = async (accessToken: string): Promise<IdentityResult> => {
    const nowMs = now();
    const key = sha256(accessToken);

    const cached = identityCache.get(key);
    if (cached !== undefined && cached.expiresAtMs > nowMs) {
      return { ok: true, identity: cached.identity };
    }
    identityCache.delete(key);

    let res: Response;
    try {
      res = await doFetch(userUrl, {
        method: 'GET',
        headers: {
          authorization: `Bearer ${accessToken}`,
          accept: 'application/json',
        },
        signal: AbortSignal.timeout(DISCORD_TIMEOUT_MS),
      });
    } catch {
      return { ok: false, reason: AuthFailure.DiscordUnavailable };
    }

    if (!res.ok) {
      const detail = await failureDetail(res);
      if (res.status === 429) return { ok: false, reason: AuthFailure.RateLimited, detail };
      if (res.status >= 500) return { ok: false, reason: AuthFailure.DiscordUnavailable, detail };
      // 401 is an expired, revoked or simply wrong token. Same answer either
      // way: this token does not identify anybody.
      return { ok: false, reason: AuthFailure.InvalidCode, detail };
    }

    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return { ok: false, reason: AuthFailure.DiscordMalformed };
    }

    const parsed = UserResponseSchema.safeParse(body);
    if (!parsed.success) return { ok: false, reason: AuthFailure.DiscordMalformed };

    // ═══════════════════════════════════════════════════════════════════════
    // THE ONE CAST. THIS IS WHERE A DISCORD USER ID COMES FROM, AND THE ONLY
    // PLACE ONE CAN. Everything above it is a server-side HTTPS call to
    // discord.com with a bearer token this process obtained itself using the
    // client secret, and a zod schema that has just proved the value is a
    // snowflake. There is no path to this line from anything a client sent.
    // ═══════════════════════════════════════════════════════════════════════
    // eslint-disable-next-line no-restricted-syntax -- the sanctioned producer of DiscordUserId: this value came from a server-side GET /users/@me, never from the wire (CLAUDE.md #5)
    const id = parsed.data.id as DiscordUserId;

    const identity: DiscordIdentity = {
      id,
      username: parsed.data.username,
      globalName: parsed.data.global_name ?? null,
      avatar: parsed.data.avatar ?? null,
    };

    pruneCache(nowMs);
    identityCache.set(key, { identity, expiresAtMs: nowMs + cacheTtlMs });
    return { ok: true, identity };
  };

  const revokeToken = async (accessToken: string): Promise<void> => {
    if (!isConfigured(config)) return;
    // The cache is dropped first and unconditionally: whatever Discord does
    // with the revoke, this process must stop answering questions about a token
    // it has decided is finished.
    identityCache.delete(sha256(accessToken));
    try {
      await doFetch(revokeUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: new URLSearchParams({
          client_id: config.clientId,
          client_secret: config.clientSecret,
          token: accessToken,
          token_type_hint: 'access_token',
        }),
        signal: AbortSignal.timeout(DISCORD_TIMEOUT_MS),
      });
    } catch {
      // Best effort by definition. The token expires on Discord's own schedule
      // regardless, and a failed revoke must never turn a clean refusal into a
      // 500.
    }
  };

  return { exchangeCode, verifyIdentity, revokeToken };
}

// ---------------------------------------------------------------------------
// The route
// ---------------------------------------------------------------------------

export type AuthRoutesOptions = {
  readonly config: AuthConfig;
  /**
   * THE SAME INSTANCE THE GATEWAY READS. Passed in rather than created here
   * because it is a lifetime `main.ts` owns — two stores would be two answers
   * to "who is this", and the WebSocket would always get the empty one.
   */
  readonly sessions: SessionStore;
  readonly deps?: AuthDeps;
};

/**
 * What the browser gets back. Three fields, and every one of them is either
 * ours or has to be.
 *
 *   `access_token`  — required by `commands.authenticate({ access_token })`,
 *                     which is the SDK call that tells the Discord client the
 *                     Activity is signed in. It is the token's only use in the
 *                     browser. NOTHING else from Discord's token response
 *                     travels: no refresh token, no scope list, no expiry.
 *   `session_id`    — our opaque handle. Means nothing without this process's
 *                     memory, and is presented on the WebSocket to say "the
 *                     server already knows who I am".
 *   `session_expires_in` — seconds, so a client knows when to re-authenticate
 *                     instead of discovering it at the worst moment. It is a
 *                     lifetime, not an identity; it says nothing about who the
 *                     holder is.
 *
 * DELIBERATELY ABSENT: the user's own id, name and avatar. Those reach the
 * client the same way everyone else's do — in `welcome`, `joined` and `party`
 * frames the server composes. One source of truth for names means a client
 * cannot end up drawing itself with a name the server does not agree with.
 */
type TokenResponseBody = {
  readonly access_token: string;
  readonly session_id: string;
  readonly session_expires_in: number;
};

type ErrorBody = {
  readonly error: AuthFailure;
  readonly message: string;
};

function refusal(reason: AuthFailure): ErrorBody {
  return { error: reason, message: MESSAGE_BY_FAILURE[reason] };
}

/**
 * `POST /api/token` — the whole handshake, in one request.
 *
 * A FastifyPluginCallback rather than an async plugin: there is nothing to
 * await at registration time, and `@typescript-eslint/require-await` correctly
 * objects to an `async` function that never does.
 *
 * NO CORS HEADERS, ON PURPOSE. The Activity is served from this same origin
 * through Discord's proxy (docs/discord-activity.md § 4 — one mapping row, bare
 * relative paths), so the browser considers this same-origin and asks for no
 * permission. Adding `Access-Control-Allow-Origin` would only ever grant access
 * to a page that is NOT the Activity.
 */
export const authRoutes: FastifyPluginCallback<AuthRoutesOptions> = (app, opts, done) => {
  const { config, sessions } = opts;
  const discord = createDiscordAuth(config, opts.deps);
  const now = opts.deps?.now ?? ((): number => Date.now());
  const sessionTtlSeconds = Math.floor(config.sessionTtlMs / 1000);

  if (!isConfigured(config)) {
    // Loud, once, at boot. A server that cannot authenticate anybody is a
    // server nobody can play on, and the symptom (every launch fails) is
    // otherwise indistinguishable from a proxy or DNS problem.
    app.log.warn(
      'DISCORD_CLIENT_ID / DISCORD_CLIENT_SECRET are not set — /api/token will refuse every request with 503. Fill them in .env.',
    );
  } else if (config.allowedUserIds.size === 0) {
    app.log.info(
      'ALLOWED_USER_IDS is empty — anyone who can launch the Activity may play. Discord already limits that to App Testers on an unverified app.',
    );
  }

  // -------------------------------------------------------------------------
  // Rate limiting. See the constants for what each half is worth.
  // -------------------------------------------------------------------------

  const ipWindows = new Map<string, { count: number; startedAtMs: number }>();
  let processCount = 0;
  let processWindowStartedAtMs = 0;

  const withinLimits = (ip: string, nowMs: number): boolean => {
    if (nowMs - processWindowStartedAtMs >= RATE_WINDOW_MS) {
      processWindowStartedAtMs = nowMs;
      processCount = 0;
      // The per-IP table is only meaningful within a window, so it turns over
      // with the window. That also bounds it without a sweep.
      ipWindows.clear();
    }
    if (processCount >= PROCESS_ATTEMPTS_PER_WINDOW) return false;

    if (ipWindows.size >= MAX_TRACKED_IPS) ipWindows.clear();
    const window = ipWindows.get(ip);
    if (window === undefined || nowMs - window.startedAtMs >= RATE_WINDOW_MS) {
      ipWindows.set(ip, { count: 1, startedAtMs: nowMs });
      processCount += 1;
      return true;
    }
    if (window.count >= IP_ATTEMPTS_PER_WINDOW) return false;
    window.count += 1;
    processCount += 1;
    return true;
  };

  app.post('/api/token', async (request, reply) => {
    const nowMs = now();

    if (!withinLimits(request.ip, nowMs)) {
      reply.code(STATUS_BY_FAILURE[AuthFailure.RateLimited]);
      return refusal(AuthFailure.RateLimited);
    }

    if (!isConfigured(config)) {
      reply.code(STATUS_BY_FAILURE[AuthFailure.Unconfigured]);
      return refusal(AuthFailure.Unconfigured);
    }

    // The one `safeParse` on this route. A body carrying anything besides
    // `code` — an `actorId`, a `userId`, a `name` — is REJECTED rather than
    // stripped, exactly as `parseClientMsg` rejects the same attempt on the
    // socket. There is no field in which to claim an identity, and asking for
    // one is an error worth seeing in the log.
    const parsed = TokenRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      app.log.warn({ ip: request.ip }, 'auth: malformed /api/token body');
      reply.code(STATUS_BY_FAILURE[AuthFailure.BadRequest]);
      return refusal(AuthFailure.BadRequest);
    }

    const exchanged = await discord.exchangeCode(parsed.data.code);
    if (!exchanged.ok) {
      app.log.warn(
        { ip: request.ip, reason: exchanged.reason, detail: exchanged.detail },
        'auth: code exchange failed',
      );
      reply.code(STATUS_BY_FAILURE[exchanged.reason]);
      return refusal(exchanged.reason);
    }

    // THE TRUSTED ANSWER. Everything before this line is plumbing.
    const verified = await discord.verifyIdentity(exchanged.accessToken);
    if (!verified.ok) {
      app.log.warn(
        { ip: request.ip, reason: verified.reason, detail: verified.detail },
        'auth: identity check failed',
      );
      reply.code(STATUS_BY_FAILURE[verified.reason]);
      return refusal(verified.reason);
    }

    const identity = verified.identity;
    const user = logTag('u', identity.id);

    if (!isAllowed(config, identity.id)) {
      // We minted this token with our own client secret moments ago; leaving it
      // live for somebody we have just refused would be handing out a working
      // credential as a consolation prize. Best effort, and a failure here does
      // not change the answer.
      await discord.revokeToken(exchanged.accessToken);
      app.log.warn({ user }, 'auth: refused — not on ALLOWED_USER_IDS');
      reply.code(STATUS_BY_FAILURE[AuthFailure.NotAllowed]);
      return refusal(AuthFailure.NotAllowed);
    }

    const session = sessions.create(identity, safeDisplayName(identity));
    // The session id is a bearer credential and is NOT logged, not even as a
    // tag — there is nothing to correlate it against that `user` does not
    // already answer.
    app.log.info({ user, sessions: sessions.size }, 'auth: identity verified, session minted');

    const body: TokenResponseBody = {
      access_token: exchanged.accessToken,
      session_id: session.id,
      session_expires_in: sessionTtlSeconds,
    };
    return body;
  });

  done();
};
