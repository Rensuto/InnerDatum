/**
 * Inner Datum — server entry point.
 *
 * M1 scope: one Fastify process serving the client bundle, the art, and a
 * WebSocket that two people can move tokens over. Bound to loopback; Caddy
 * terminates TLS in front of it and Discord's activity proxy sits in front of
 * that.
 *
 * Runs directly under Node's native type stripping — there is no build step for
 * server code. That is why this file may not use `enum`, `namespace` with
 * runtime code, parameter properties or decorators, and why relative imports
 * carry an explicit `.ts` extension.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { argv, env, exit, hrtime } from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';

import { PROTOCOL_VERSION } from '../shared/version.ts';
import { seedTestEncounter } from './content/encounter.ts';
import { createDownedState } from './engine/downed.ts';
import { createPartyState } from './engine/party.ts';
import { authRoutes, readAuthConfig } from './http/auth.ts';
import { createSessionStore } from './http/session.ts';
import { wsGateway } from './net/gateway.ts';
import { createCharacterBridge, createSaveStore } from './persist/saves.ts';
import { createTurnEngine } from './turn-engine.ts';
import { createWorld } from './world/world.ts';

/** Bound to loopback on purpose: Caddy is the only thing that should reach it. */
const HOST = env['HOST'] ?? '127.0.0.1';
const PORT = Number(env['PORT'] ?? 3000);

/**
 * Read once at boot. Kept off the hot path and, more importantly, kept out of
 * `/healthz`'s response shape — see below.
 */
const APP_VERSION = env['npm_package_version'] ?? '0.0.0';

/**
 * Names this world's random stream. Set it in .env to reproduce a session's
 * spawn placements exactly; the default is stable, so a plain restart already
 * does.
 */
const WORLD_SEED = env['WORLD_SEED'] ?? 'inner-datum-m1';

/**
 * ESM has no `__dirname`, and @fastify/static refuses a relative root — a
 * cwd-relative path would work under `npm start` and break under the Windows
 * service that actually runs this. Resolved from `import.meta.url`, which is
 * correct wherever the process was launched from.
 *
 * This file is src/server/main.ts, so '../../' is the repo root.
 */
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/**
 * Where character files live. `data/` at the repo root unless .env says
 * otherwise, resolved from `import.meta.url` for the same reason the asset roots
 * are — a cwd-relative path works under `npm start` and quietly writes saves
 * into `C:\Windows\System32` under the service that actually runs this.
 *
 * NOT CREATED AT BOOT. The directory appears on the first write, so a server
 * nobody has played on leaves no trace, and CLAUDE.md non-negotiable 7 ("never
 * commit `data/`") has nothing to catch out.
 */
const DATA_ROOT = env['DATA_DIR'] ?? join(REPO_ROOT, 'data');

const CLIENT_DIST = join(REPO_ROOT, 'client', 'dist');
const CLIENT_DIST_ASSETS = join(CLIENT_DIST, 'assets');
const PUBLIC_ASSETS = join(REPO_ROOT, 'client', 'public', 'assets');

const startedAt = hrtime.bigint();

export function buildServer() {
  const app = Fastify({
    logger: {
      level: env['LOG_LEVEL'] ?? 'info',
      // Never log a token. The Discord client secret and bot token both travel
      // through this process; a single unredacted request log on a public
      // machine is the whole compromise.
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.body.access_token',
          'req.body.code',
          '*.client_secret',
          '*.token',
        ],
        censor: '[redacted]',
      },
    },
    // Discord's proxy sits in front of Caddy, which sits in front of us.
    trustProxy: true,
    bodyLimit: 64 * 1024,
  });

  /**
   * The one deliberately public route.
   *
   * Its body is exactly { ok, version, uptime } and must stay that way: the
   * control panel probes it from OUTSIDE the network to prove reachability, and
   * a self-request proves nothing because most consumer routers lack NAT
   * hairpinning. It leaks nothing about players, sessions, paths or the world.
   */
  app.get('/healthz', () => {
    const uptimeMs = Number((hrtime.bigint() - startedAt) / 1_000_000n);
    return { ok: true, version: APP_VERSION, uptime: uptimeMs };
  });

  /** Lets a client fail loudly on a protocol mismatch instead of misparsing. */
  app.get('/api/protocol', () => ({ protocol: PROTOCOL_VERSION }));

  /**
   * IDENTITY — src/server/http/auth.ts, and the trust boundary of the whole
   * game.
   *
   * The config is read ONCE, here, so that a missing client secret is a single
   * warning at boot rather than a surprise on the first launch, and so that
   * nothing further down the tree reaches for `env` on a request path.
   *
   * THE SESSION STORE IS CREATED HERE for exactly the reason the world below
   * is: it is a lifetime the entry point owns. The HTTP route writes to it when
   * somebody signs in and the WebSocket gateway reads from it to learn who is
   * on the far end of a socket — two stores would be two answers to "who is
   * this", and the socket would always get the empty one.
   *
   * THE SEAM IS NOW JOINED: the same `sessions` instance goes to `authRoutes`
   * (which writes to it when somebody signs in) and to `wsGateway` below (which
   * reads from it to learn who is on the far end of a socket). The gateway
   * resolves an opaque session id with `sessions.get(id)` and keeps its own
   * resume-token flow untouched.
   */
  const authConfig = readAuthConfig();
  const sessions = createSessionStore({ ttlMs: authConfig.sessionTtlMs });
  app.register(authRoutes, { config: authConfig, sessions });

  /**
   * ART, at /assets/*.
   *
   * Two roots, tried in order, because the same URL has two legitimate sources:
   * the build output (vite.config.ts copies client/public/ verbatim into
   * client/dist/, so the art lands at client/dist/assets/) and the loose PNGs
   * still sitting in client/public/assets/ — which is all there is before anyone
   * has run `npm run build:client`. @fastify/static walks the array on a miss, so
   * the built tree wins and the authored tree is the fallback: one URL space, and
   * no dev-only special case in the client.
   *
   * The bundle itself does NOT collide with this prefix — `assetsDir: 'bundle'`
   * in vite.config.ts keeps generated JS/CSS out of the art tree on purpose, for
   * licensing reasons documented there. Everything under /assets/ is art.
   */
  const assetRoots = existsSync(CLIENT_DIST_ASSETS)
    ? [CLIENT_DIST_ASSETS, PUBLIC_ASSETS]
    : [PUBLIC_ASSETS];
  app.register(fastifyStatic, {
    root: assetRoots,
    prefix: '/assets/',
    // Only the first registration may add reply.sendFile, and nothing here uses
    // it. Declining it in both keeps the two registrations interchangeable.
    decorateReply: false,
    index: false,
  });

  /**
   * THE CLIENT BUNDLE, at /.
   *
   * Registered only when it exists: @fastify/static merely warns on a missing
   * root, and a `/*` route that answers 404 for everything would mask the real
   * problem ("you have not run `npm run build:client`") behind a plain
   * not-found. The more specific /healthz, /api/* , /ws and /assets/* routes all
   * win against this wildcard in fastify's router.
   */
  if (existsSync(CLIENT_DIST)) {
    app.register(fastifyStatic, {
      root: CLIENT_DIST,
      prefix: '/',
      decorateReply: false,
      index: ['index.html'],
    });
  } else {
    app.log.warn(
      { root: CLIENT_DIST },
      'client bundle not found — run `npm run build:client`; /assets still serves the authored art',
    );
  }

  /**
   * THE WORLD, and the socket that mutates it.
   *
   * One world per process, created here rather than inside the gateway so that
   * it is a lifetime the entry point owns: a test can build its own and register
   * the plugin against it, and M5's persistence has an obvious object to save.
   */
  const world = createWorld(WORLD_SEED);

  /**
   * THE TEST ENCOUNTER.
   *
   * Seeded here, at world construction, rather than by the scheduler: the
   * monsters are part of what the level IS, and a level that spawns its
   * population on first player contact would make the very first turn
   * behave differently from every later one.
   *
   * Logged because a silent zero here — every tile occupied, a wall moved —
   * presents as "the barrier never engages", which reads as a turn-engine bug
   * and is not one.
   */
  const encounter = seedTestEncounter(world);
  if (encounter.length === 0) {
    app.log.warn('test encounter seeded NOTHING — combat will never engage');
  } else {
    app.log.info(
      { monsters: encounter.map((m) => `${m.name}@${m.at.x},${m.at.y}`) },
      `seeded ${encounter.length} monsters`,
    );
  }

  /**
   * THE SURVIVAL TABLE (game-design.md § 9, engine/downed.ts).
   *
   * Created HERE, next to the world, because it is the same kind of thing: state
   * that outlives every pump and belongs to the process rather than to a call.
   * The five-turn Downed countdown would never reach zero if `pump` built its
   * own each time.
   *
   * THE SAME INSTANCE GOES TO BOTH. The turn engine ticks it; the gateway reads
   * it to build the party panel. Two instances would be two answers to "how long
   * has Sam got", shown side by side on the same screen.
   */
  const downed = createDownedState();

  /**
   * WHO IS PLAYING WITH WHOM (engine/party.ts).
   *
   * Created here for the same reason the world and the survival table are: it
   * is a lifetime the entry point owns, and party membership outlives every
   * pump. It is also what makes the barrier PER-PARTY — the whole reason this
   * exists. Real multiplayer reported the level-wide version: a solo player
   * waited on a stranger, and then on a stranger who had closed the tab.
   *
   * NOTHING IS RESTORED INTO IT AT BOOT, and that is deliberate. A party is a
   * fact about who is at the table RIGHT NOW; restoring last night's from a
   * file would put people in a shared barrier before any of them had connected,
   * and the first person in would find themselves waiting on four empty chairs.
   * Everybody starts as a party of one and says so out loud.
   */
  const parties = createPartyState();

  /**
   * CHARACTER FILES, and the one thing that knows whose body is whose.
   *
   * The store owns the disk (atomic writes, the `.bak`, the R9 rename retry);
   * the bridge owns the actor -> Discord-account binding and is therefore the
   * only thing that can decide a character is saveable at all. An anonymous
   * player never gets a binding and is never written — see the bridge's header.
   *
   * Created here, like the world and the survival table, because it is a
   * lifetime the entry point owns: it has to be flushed at shutdown, and the
   * hook that does that belongs next to the thing it flushes.
   */
  const saves = createSaveStore({ root: DATA_ROOT, logger: app.log });
  const persist = createCharacterBridge({ store: saves, logger: app.log });

  /**
   * THE LAST SAVE. `close()` writes every pending autosave and waits for every
   * in-flight one, so a deliberate restart costs nothing — which is the whole
   * reason the debounce is allowed to be five seconds.
   *
   * Fastify awaits an async `onClose` hook, so the process really does wait.
   */
  app.addHook('onClose', async () => {
    await saves.close();
  });

  /**
   * `log` is what makes a floor reset diagnosable. A party wipe restores
   * everybody and then hands the adapter the half the engine may not do — walk
   * the party to a spawn tile, re-seed this encounter, drop engagement — and the
   * two ways that can go wrong (no free tile at all; the same party wiping again
   * two turns later) are both invisible from inside the game. See `resetFloor`.
   */
  const engine = createTurnEngine({ world, downed, parties, log: app.log });
  app.register(wsGateway, { world, engine, downed, sessions, persist });

  return app;
}

/**
 * Only listen when executed directly. Importing this module from a test or the
 * smoke harness must not bind a port as a side effect.
 *
 * Compared via pathToFileURL rather than string concatenation. On Windows
 * `import.meta.url` is `file:///C:/...` with three slashes, so a hand-built
 * `file://${argv[1]}` never matches — the server then exits 0 without ever
 * listening, which looks like a clean run and is the worst possible failure.
 */
const entry = argv[1] === undefined ? undefined : pathToFileURL(argv[1]).href;
if (import.meta.url === entry) {
  const app = buildServer();
  try {
    await app.listen({ host: HOST, port: PORT });
  } catch (err) {
    app.log.error(err);
    exit(1);
  }
}
