// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *   THE SESSION TABLE. One Map, in RAM, and that is the correct answer here.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A session is the ONLY thing a browser is ever given that means "I am Ren".
 * It is an opaque 256-bit handle with no structure, no signature and no payload
 * — the mapping from handle to Discord user lives here, on the server, and a
 * client cannot read it, edit it, or forge one. `auth.ts` is the only thing
 * that may create one, and it only does so after a server-side
 * `GET /users/@me` has said who the holder is.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHY IN-MEMORY IS RIGHT, SAID PLAINLY SO NOBODY "FIXES" IT LATER
 * ───────────────────────────────────────────────────────────────────────────
 * Under ten players, rarely more than four at once, one Node process
 * (CLAUDE.md). At that size the entire table is a few kilobytes and a Map
 * lookup is the fastest, simplest, least-surprising thing available. Redis, a
 * signed cookie or a JWT would each add a dependency, a failure mode, and a
 * second place where a live credential sits — for a table that never exceeds
 * six rows.
 *
 * SURVIVES A WEBSOCKET RECONNECT. NOT A SERVER RESTART. That split is
 * deliberate, and it is the whole design:
 *
 *   * A dropped socket is the common case — wifi hiccups, a laptop lid, a
 *     Discord client update. The player's body stays in the world for a
 *     ten-minute grace (gateway.ts) and the same session id reattaches to it,
 *     so the resume-token flow keeps working unchanged.
 *   * A restart is rare, deliberate, and the cheapest possible moment to
 *     re-authenticate: `commands.authorize({ prompt: 'none' })` costs the
 *     player one silent round-trip they will not see. Persisting sessions
 *     across a restart would buy that back at the price of live credentials on
 *     disk, in a `data/` directory the repo already forbids committing.
 *
 * Nothing here is persisted. Nothing here is logged. A session id must never
 * reach a log line, an error body, or a save file — it is a bearer credential,
 * exactly as much as the access token it was minted from.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * NO BACKGROUND TIMER
 * ───────────────────────────────────────────────────────────────────────────
 * Expiry is checked on read and swept on write. A `setInterval` sweeper would
 * be a handle the process has to remember to `unref`, a thing tests have to
 * shut down, and a source of work while nobody is playing — to reclaim a few
 * hundred bytes. An expired session is unusable the instant it is looked up,
 * which is the only property that matters for security; reclaiming its memory
 * a few minutes later is housekeeping.
 */

import { randomBytes } from 'node:crypto';

import type { DiscordIdentity } from './auth.ts';

/**
 * 32 bytes of CSPRNG, base64url — 43 characters, 256 bits of entropy.
 *
 * Unguessable by construction, which is why there is no HMAC anywhere in this
 * file. A signed token (the `SESSION_SECRET` shape sketched in .env.example)
 * proves integrity of a payload the client carries; a random handle into a
 * server-side table carries no payload at all, so there is nothing to forge.
 * It is also revocable in O(1), which a signed token is not.
 */
const SESSION_ID_BYTES = 32;

/**
 * A ceiling on the table, not a fit.
 *
 * `create` already replaces a user's previous session, so the live row count is
 * the number of distinct Discord accounts playing — six, at the documented
 * maximum. Sixty-four exists so that a client stuck in a re-authentication loop
 * (or an allowlist that has been emptied by mistake) cannot grow this Map
 * without bound; when it is hit, the session closest to expiring is evicted.
 */
const DEFAULT_MAX_SESSIONS = 64;

/** Opaque to everyone. Never parsed, never split, never rendered. */
export type SessionId = string;

/**
 * What the server knows about a connected person.
 *
 * `user.id` is a `DiscordUserId`, which can only have come out of `auth.ts`'s
 * one server-side `/users/@me` call — the type makes "this snowflake was
 * verified" a compile-time fact rather than a convention.
 */
export type AuthSession = {
  readonly id: SessionId;
  readonly user: DiscordIdentity;
  /** Sanitised, length-capped, safe to put in the party panel. See auth.ts. */
  readonly displayName: string;
  readonly createdAtMs: number;
  /** Slides forward on every successful `get`. See the note there. */
  readonly expiresAtMs: number;
};

/**
 * The stored row. Identical to `AuthSession` except that `expiresAtMs` is
 * writable — the public type is the read-only view of the same object, which is
 * why `get` can hand out the record itself without copying.
 */
type SessionRecord = {
  readonly id: SessionId;
  readonly user: DiscordIdentity;
  readonly displayName: string;
  readonly createdAtMs: number;
  expiresAtMs: number;
};

export type SessionStoreOptions = {
  /** Idle lifetime. Each successful lookup buys another `ttlMs`. */
  readonly ttlMs: number;
  /**
   * Injected so a test can prove expiry without spending fifteen real minutes.
   * Default `Date.now`. This file is src/server/http/, outside the no-clock
   * lint block that covers engine/, world/ and view/.
   */
  readonly now?: () => number;
  /** Injected so a test can assert on a stable id. Default: 32 CSPRNG bytes. */
  readonly mintId?: () => SessionId;
  /** Default 64. See DEFAULT_MAX_SESSIONS. */
  readonly maxSessions?: number;
};

export type SessionStore = {
  /**
   * Mint a session for a verified identity, replacing that user's previous one.
   *
   * ONE ACCOUNT, ONE SEAT. Re-authenticating (a page reload, a second tab)
   * invalidates the older handle rather than accumulating handles. It matches
   * the game's own model — one person drives one body — and it means the table
   * is bounded by the number of players rather than by the number of reloads.
   *
   * It does NOT close an existing WebSocket: the gateway resolves a session
   * once, at `hello`, and remembers the actor on the socket. Superseding a live
   * connection is the gateway's job and it already has one (CLOSE_SUPERSEDED).
   */
  create(user: DiscordIdentity, displayName: string): AuthSession;
  /**
   * Look up a live session, sliding its expiry forward.
   *
   * Takes `string | undefined` on purpose: the caller's session id arrives from
   * the wire and is optional there, and forcing every call site to write the
   * same `if (id === undefined)` is how one of them ends up written as `id!`.
   *
   * SLIDING, NOT ABSOLUTE. `SESSION_TTL_SECONDS` defaults to fifteen minutes,
   * which is a sensible idle window and an absurd cap on a dungeon run. The
   * WebSocket proves liveness continuously, so a session that is being used
   * stays alive and one nobody has touched for fifteen minutes does not. The
   * process lifetime is the real ceiling — see the header.
   */
  get(id: SessionId | undefined): AuthSession | undefined;
  /**
   * Look up WITHOUT sliding the expiry. For diagnostics and the ops panel: a
   * read that changes what it is reading is a trap when the thing you are
   * trying to observe is precisely when a session dies.
   */
  peek(id: SessionId | undefined): AuthSession | undefined;
  /** Invalidate one handle immediately. True if it existed. */
  revoke(id: SessionId | undefined): boolean;
  /** Drop everything expired. Returns how many rows went. */
  sweep(): number;
  /** Live rows, after no sweep. Diagnostics only. */
  readonly size: number;
};

/**
 * Build the table.
 *
 * Created by `main.ts` rather than by the auth plugin, for the same reason the
 * world is: it is a lifetime the entry point owns. ONE STORE PER PROCESS — the
 * HTTP routes write to it and the WebSocket gateway reads from it, and two
 * instances would be two different answers to "who is this", one of which would
 * always say nobody.
 */
export function createSessionStore(options: SessionStoreOptions): SessionStore {
  const ttlMs = options.ttlMs;
  const now = options.now ?? ((): number => Date.now());
  const mintId =
    options.mintId ?? ((): SessionId => randomBytes(SESSION_ID_BYTES).toString('base64url'));
  const maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;

  const byId = new Map<SessionId, SessionRecord>();

  /**
   * A linear scan, and it is the right shape here.
   *
   * A second Map keyed by user id would be a second thing to keep in step with
   * the first, and the classic way that goes wrong is a stale index pointing at
   * a revoked row. With at most six rows the scan is unmeasurable; the moment
   * this table holds thousands, the index is worth its bug surface and not
   * before.
   */
  const findByUser = (userId: string): SessionRecord | undefined => {
    for (const record of byId.values()) {
      if (record.user.id === userId) return record;
    }
    return undefined;
  };

  const sweep = (): number => {
    const nowMs = now();
    let removed = 0;
    for (const [id, record] of byId) {
      if (record.expiresAtMs <= nowMs) {
        byId.delete(id);
        removed += 1;
      }
    }
    return removed;
  };

  /** The row closest to dying, evicted when the ceiling is hit. */
  const evictSoonest = (): void => {
    let victim: SessionRecord | undefined;
    for (const record of byId.values()) {
      if (victim === undefined || record.expiresAtMs < victim.expiresAtMs) victim = record;
    }
    if (victim !== undefined) byId.delete(victim.id);
  };

  const live = (id: SessionId | undefined): SessionRecord | undefined => {
    if (id === undefined || id === '') return undefined;
    const record = byId.get(id);
    if (record === undefined) return undefined;
    if (record.expiresAtMs <= now()) {
      // Reap on read. An expired handle is indistinguishable from a wrong one
      // from the caller's side, which is the answer we want: "no", with no hint
      // about whether the id was ever real.
      byId.delete(id);
      return undefined;
    }
    return record;
  };

  return {
    create(user: DiscordIdentity, displayName: string): AuthSession {
      sweep();

      const previous = findByUser(user.id);
      if (previous !== undefined) byId.delete(previous.id);

      while (byId.size >= maxSessions) evictSoonest();

      const startedAtMs = now();
      const record: SessionRecord = {
        id: mintId(),
        user,
        displayName,
        createdAtMs: startedAtMs,
        expiresAtMs: startedAtMs + ttlMs,
      };
      byId.set(record.id, record);
      return record;
    },

    get(id: SessionId | undefined): AuthSession | undefined {
      const record = live(id);
      if (record === undefined) return undefined;
      record.expiresAtMs = now() + ttlMs;
      return record;
    },

    peek(id: SessionId | undefined): AuthSession | undefined {
      return live(id);
    },

    revoke(id: SessionId | undefined): boolean {
      if (id === undefined || id === '') return false;
      return byId.delete(id);
    },

    sweep,

    get size(): number {
      return byId.size;
    },
  };
}
