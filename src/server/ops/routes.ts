// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE OPS LISTENER — 127.0.0.1:3001, NEVER MOUNTED ON THE GAME APP.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `docs/control-panel.md` § 1 specifies this surface and its one hard rule:
 *
 *     Ops    :3001  ->  127.0.0.1, behind nothing, never public
 *
 * A SEPARATE FASTIFY INSTANCE, not a route prefix on the game app, and the
 * distinction is the whole security model. The game app is reachable from the
 * internet through the tunnel that serves the Discord Activity; anything
 * mounted on it is reachable by anyone who can load the game. This one binds to
 * the loopback interface, so the only thing that can reach it is a process
 * already executing on the host — which is a strictly higher bar than any token
 * this file could check, and unlike a token it cannot be leaked into a log, a
 * screenshot or a repository.
 *
 * There is therefore NO AUTHENTICATION HERE ON PURPOSE. Adding one would imply
 * the bind is not the boundary, and the day somebody believes that is the day
 * someone binds it to 0.0.0.0 "because it is authenticated anyway".
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY IT EXISTS NOW: EVERY DEPLOY WAS THROWING AWAY SAVES
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `main.ts` registers an `onClose` hook that flushes every pending autosave,
 * and the five-second write debounce is only defensible because that hook
 * exists — its own docblock says "a deliberate restart costs nothing".
 *
 * Nothing called `app.close()`. Signal handlers were added and they close the
 * dev case, but the production deploy stops the host with `Stop-Process
 * -Force`, which is `TerminateProcess` on Windows: no signal is delivered, no
 * handler runs, and nothing inside the process can intervene. The deploy script
 * was then taught to WAIT for a clean exit before using the hammer — and the
 * first deploy after that reported, correctly, `stopped (forced -- pending
 * autosaves may not have flushed)`. The wait had nothing to wait for.
 *
 * `POST /shutdown` is the thing it was waiting for. The script asks over
 * loopback, the hook runs, the process leaves, and the hammer is never reached.
 * A project that deploys after every commit while friends are playing cannot
 * keep discarding the last few seconds of everyone's evening.
 */

import type { FastifyInstance, FastifyPluginAsync } from 'fastify';

/** The port `docs/control-panel.md` names. Overridable for tests only. */
export const OPS_PORT = 3001;

/**
 * LOOPBACK, AND THE DEFAULT IS THE POLICY.
 *
 * `docs/control-panel.md`: *"If you ever want it from your phone on the LAN, set
 * `OPS_BIND=192.168.1.50` — never `0.0.0.0`, and never add a port forward for
 * it. There is no scenario where 3001 belongs in your router."*
 */
export const OPS_BIND = '127.0.0.1';

export type OpsOptions = {
  /**
   * What to shut down. The GAME app, not this one — `POST /shutdown` exists to
   * run the game app's `onClose` hook, and closing this listener instead would
   * flush nothing and leave the thing holding :3000 alive.
   *
   * A FUNCTION rather than the instance, so this module never imports the
   * gateway or the save store and cannot grow a second opinion about what
   * shutting down means.
   */
  readonly closeGame: () => Promise<void>;
  /** Wall clock, injected so a test does not need one. */
  readonly now?: () => number;
};

/**
 * The listener's routes.
 *
 * Deliberately two. `docs/control-panel.md` describes a whole panel — chore
 * tracking, a reachability light, the no-ip confirmation button — and none of
 * that is here, because none of it is what was losing players' progress. This
 * is the ops surface's first two lines, not a down payment on a UI nobody has
 * asked for yet. PLAN.md § working rules: do not write documents, or servers,
 * for systems that do not exist.
 *
 * `async` WITH NOTHING AWAITED, and the disable below says so rather than
 * hiding it: `FastifyPluginAsync` is an async signature by contract, both routes
 * register synchronously, and there is nothing honest to await. Writing a
 * callback plugin to dodge one lint rule would trade a one-line exemption for a
 * `done()` nobody can forget to call safely.
 */
// eslint-disable-next-line @typescript-eslint/require-await
export const opsRoutes: FastifyPluginAsync<OpsOptions> = async (app, options) => {
  const startedAt = (options.now ?? Date.now)();

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * A BODYLESS POST IS THE NORMAL THING AN OPS TOOL SENDS. ACCEPT IT.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Fastify answers **415 Unsupported Media Type** to a POST carrying no
   * `Content-Type`, and that is exactly what `Invoke-RestMethod -Method Post`
   * sends with no `-Body`. So the deploy script's shutdown call was refused
   * before it reached the handler, every time, and the script correctly went on
   * to report `stopped (forced -- pending autosaves may not have flushed)`.
   *
   * The instrumentation did its job: the line was true, the feature was inert,
   * and nothing pretended otherwise. But a shutdown route that only works if the
   * caller remembers to send `{}` with a JSON header is a trap, and the next
   * caller — curl, a browser, a person — will fall into it too.
   *
   * `POST /shutdown` TAKES NO ARGUMENTS AND NEVER WILL. There is nothing to
   * parse, so parse nothing and hand the handler `undefined`. This is scoped to
   * this listener alone — a plugin's content-type parsers do not escape it — and
   * this listener has two routes, neither of which reads a body.
   */
  app.addContentTypeParser('*', (_request, _payload, done) => {
    done(null, undefined);
  });

  /**
   * Is the ops surface itself up? Distinct from the GAME's `/healthz`, which
   * says whether players can connect. A deploy script needs both answers and
   * they are not the same question — the game app can be wedged while this one
   * still answers, which is exactly when you most want to ask it to shut down.
   */
  app.get('/healthz', () => ({
    ok: true,
    surface: 'ops',
    uptime: Math.round(((options.now ?? Date.now)() - startedAt) / 1000),
  }));

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * ASK THE GAME TO STOP, AND REPLY BEFORE IT DOES.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * THE REPLY IS SENT FIRST, ON PURPOSE. `closeGame()` drains every in-flight
   * autosave and can take a moment; awaiting it before replying would race the
   * caller's own timeout, and a deploy script that times out reaches for
   * `Stop-Process -Force` — killing the flush this route exists to run. So the
   * contract is "accepted, now watch the process leave", and the script watches
   * for the process rather than for a response body.
   *
   * `void` and a `.catch` rather than `await`: a shutdown that throws must still
   * exit, or a failed flush becomes a server that cannot be stopped politely and
   * the hammer comes back permanently.
   */
  app.post('/shutdown', (_request, reply) => {
    app.log.info('ops: shutdown requested over loopback');
    void reply.send({ ok: true, shuttingDown: true });
    setImmediate(() => {
      void options
        .closeGame()
        .then(() => {
          process.exit(0);
        })
        .catch((err: unknown) => {
          app.log.error({ err }, 'ops: shutdown failed; exiting anyway');
          process.exit(1);
        });
    });
  });
};

/**
 * Start the ops listener beside the game.
 *
 * FAIL-SOFT, AND THAT IS NOT LAZINESS. If :3001 is already taken — a stale
 * process, somebody else's tool — the GAME MUST STILL BOOT. An ops surface that
 * can prevent the game from starting is a strictly worse trade than one that is
 * occasionally missing, and the deploy script already handles its absence: it
 * falls back to waiting, then to the hammer, and says which happened.
 */
export async function startOps(
  /**
   * A FACTORY, NOT AN INSTANCE — and this signature is a scar.
   *
   * It took the built app, so the caller had to construct one BEFORE the guard
   * below could protect anything. `Fastify({ logger: app.log })` then threw
   * `FST_ERR_LOG_INVALID_LOGGER_CONFIG` (v5 wants a config object; the instance
   * goes in `loggerInstance`) and took down a game server that had already bound
   * its port and seeded its realms — the exact outcome the note above swears
   * cannot happen. A guard that does not cover construction is not a guard.
   */
  build: () => FastifyInstance,
  options: OpsOptions & { readonly port?: number; readonly bind?: string },
): Promise<{ readonly port: number } | null> {
  try {
    const app = build();
    await app.register(opsRoutes, options);
    await app.listen({ host: options.bind ?? OPS_BIND, port: options.port ?? OPS_PORT });
    return { port: options.port ?? OPS_PORT };
  } catch {
    return null;
  }
}
