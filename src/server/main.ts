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

import { recomposeCombat } from './engine/effects.ts';
import { resolveItem } from './content/resolve.ts';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { argv, env, exit, hrtime } from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { startOps } from './ops/routes.ts';

import { TALENT_MAX_LEVEL } from '../shared/progression.ts';
import { checkTier } from '../shared/tiers.ts';
import { PLAYER_RANK, maxLifeFor } from '../shared/leveling.ts';
import { PROTOCOL_VERSION } from '../shared/version.ts';
import {
  classById,
  createContentTalentEngine,
  createTalentBook,
  sheetForClass,
} from './content/classes.ts';
import { seedTestEncounter } from './content/encounter.ts';
import { createDownedState } from './engine/downed.ts';
import { createPartyState } from './engine/party.ts';
import {
  budgetPenalty,
  createEffectState,
  registerEffect,
  statusApplier,
  statusCurer,
} from './engine/effects.ts';
import type { StatusApply, StatusCure } from './engine/effects.ts';
import type { BudgetPenalty } from './engine/talents.ts';
import { BLEEDING, SLOWED, STUNNED } from './content/effects.ts';
import {
  MOVE_MP_COST,
  RESOURCE_RULES,
  effectiveResourceMax,
  hasAffordableAction,
  markMultiplier,
  resolveGuardCounter,
  talentLevelOf,
  toggleSustain,
  useTalent,
} from './engine/talents.ts';
import { authRoutes, readAuthConfig } from './http/auth.ts';
import { createSessionStore } from './http/session.ts';
import { wsGateway } from './net/gateway.ts';
import { createCharacterBridge, createSaveStore } from './persist/saves.ts';
import type { BoundHooks, PassiveView } from './engine/hooks.ts';
import { createTurnEngine } from './turn-engine.ts';
import { createRealms } from './world/realms.ts';
import { createWorld } from './world/world.ts';
import { isPlayer } from './engine/actor.ts';
import type { EngineActor } from './engine/actor.ts';
import type { TalentResolutionResult } from './engine/scheduler.ts';
import type { GuardCounter, TalentEngine } from './engine/talents.ts';
import type { ReapingTurnEngine, TalentRuntime } from './turn-engine.ts';
import type { World } from './world/world.ts';
import type { TileXY } from '../shared/coords.ts';

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

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE TALENT RESOLUTION ADAPTER — FOUR LINES, AND THE ONLY PLACE THEY FIT.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `TalentResolution` (engine/scheduler.ts) is three narrow callbacks rather
 * than the `TalentEngine` itself for a dependency reason, not a taste one:
 * resolving a talent needs the REGISTRY, the registry is built from
 * `content/classes.ts`, and eslint bans `engine/** -> content/**`. So the layer
 * that can see both writes these. That used to be nowhere, which is why every
 * `talent` intent took `Refusal.NoTalentEffect` — the refund path — and twelve
 * finished talents were unreachable in play.
 *
 * `forget` is the fourth callback and belongs to `TalentRuntime` rather than to
 * the scheduler, because its two callers are a player genuinely leaving and a
 * reaped monster — both in turn-engine.ts.
 *
 * WHAT IS DELIBERATELY NOT HERE: nothing spends energy (D1 — the scheduler's
 * `spendTurn` is the only spender) and nothing emits an event (only the
 * scheduler knows whether this was a player's action or part of a batched
 * monster sweep).
 *
 * EXPORTED FOR ONE REASON: so that test/server/class-wiring.test.ts asserts the
 * AP/MP refill and the Inspector's Focus rule against THE ADAPTER THAT SHIPS,
 * rather than against a copy of it written in a test file. A copy would keep
 * passing on the day this one stopped calling `actBase`.
 */
export function talentRuntimeFor(
  talents: TalentEngine,
  world: World,
  /**
   * THE STATUS DOOR (engine/effects.ts#statusApplier). A talent that lands a
   * stun calls this; see `TalentCallCtx.status` for why it is a closure and not
   * the table. Optional so the four fixtures that build a runtime by hand keep
   * compiling — absent means a talent's status half is skipped, never that it
   * throws.
   */
  status?: StatusApply,
  /**
   * WHAT A STATUS IS TAKING OFF THIS ROUND — `budgetPenalty` from the status
   * table, curried by whoever holds it. Absent is no penalty, which is every
   * fixture that wires no effects.
   *
   * A CLOSURE RATHER THAN THE TABLE, exactly like `status` beside it: this
   * adapter must not decide what an effect means, only forward the answer.
   */
  penaltyFor?: (actorId: string) => BudgetPenalty,
  /**
   * THE CURE DOOR — `statusCurer`, the twin of `status` two parameters up. Field
   * Dressing calls it; the closure argument is identical and is written out over
   * `TalentCallCtx.cure`. Optional for the same reason: the fixtures that build
   * a runtime by hand keep compiling, and a talent that wants a cure gets the
   * same null an unafflicted ally would give it.
   */
  cure?: StatusCure,
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * RUN AFTER EVERY BASE TURN. This is what makes a conditional passive real.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `Talent.passive` can now read the board, and a board-reading passive that
   * is only folded when a point is spent is a passive frozen at the moment
   * somebody levelled up. It would be worse than a constant, because it would
   * LOOK live.
   *
   * The fold lives in `refreshPassives`, which is inside the server closure —
   * the one place that can see the talent registry, the world and the gateway
   * at once. This adapter cannot reach it, so the capability is passed in,
   * exactly as `status`, `penaltyFor` and `cure` above are.
   *
   * OPTIONAL: absent means passives fold only on the three occasions they
   * always did, which is every fixture that builds a runtime by hand.
   */
  onActBase?: (actorId: string) => void,
): TalentRuntime {
  return {
    use: (actor: EngineActor, id: string, target: TileXY | undefined): TalentResolutionResult => {
      const talent = talents.registry.get(id);
      if (talent === undefined) return { ok: false, reason: 'unknown_talent' };

      // A `self` shape carries no target tile; the caster's own is the honest
      // origin for the FX stamp (protocol.ts: never a sentinel — a -1 would be
      // drawn). Who is STANDING there is resolved here rather than sent, because
      // the client aims at a TILE and the affinity check reads the body on it.
      const at = target ?? { x: actor.x, y: actor.y };
      const standing = world.actorAt(at.x, at.y);
      const result = useTalent(
        talents,
        actor,
        id,
        { x: at.x, y: at.y, ...(standing === undefined ? {} : { actorId: standing.id }) },
        {
          engine: talents,
          world,
          rng: world.rng,
          ...(status === undefined ? {} : { status }),
          ...(cure === undefined ? {} : { cure }),
        },
      );
      if (!result.ok) return { ok: false, reason: result.reason };

      return {
        ok: true,
        landing: {
          talentId: result.talentId,
          at,
          shape: talent.targeting.shape,
          radius: talent.targeting.radius ?? 0,
          ...(standing === undefined ? {} : { targetId: standing.id }),
          hits: result.hits,
          // ═══ AND WHAT IT SAID ═══
          // `useTalent` has always returned these and this adapter has always
          // dropped them. See `TalentEvent.notes`: sixteen `talentDone` calls
          // author sentences that reached nobody, including two that
          // game-design.md § 11 prints in its own sample Record.
          ...(result.notes.length === 0 ? {} : { notes: result.notes }),
          // ═══ AND WHO IT MOVED ═══
          // Fog Step, Ward Rush and Backdraft all reposition a body. Straight
          // through: `useTalent` recorded it at the one function that can move
          // anybody, and `emitPlayerEffect` turns each entry into the ordinary
          // `moved` event. Drop it here and the caster is drawn on the tile she
          // left, permanently — see `ActorMove` in engine/talents.ts.
          moved: result.moved,
        },
      };
    },
    actBase: (actorId: string): void => {
      // THE REFILL TAKES THE PENALTY. `budgetPenalty` reads the status table
      // and answers what SLOWED is taking off this round — the caller applies it
      // "immediately after the refill", which is exactly here, because the refill
      // would clobber anything subtracted earlier in the turn.
      talents.actBase(actorId, world, penaltyFor?.(actorId));
      // AFTER the refill and after the latch is cleared, so a passive reading
      // "did I move" or "how much resource is left" sees the turn it is in
      // rather than the one that just ended.
      onActBase?.(actorId);
    },
    noteMoved: (actorId: string): void => {
      const sheet = talents.sheetOf(actorId);
      if (sheet !== undefined) sheet.movedThisTurn = true;
    },
    // The two class-resource hooks, forwarded verbatim. Both are no-ops for a
    // body with no sheet and for the two resources they do not own, so the
    // scheduler may call them on every blow without asking who anybody is.
    // See `TalentResolution.noteKill` / `.noteStruck` for the two dead ends
    // — the Alchemist's permanently empty hotbar and the Watchman's Resolve
    // that never moved off 0 — that the absent wiring produced.
    noteKill: (actorId: string): void => {
      talents.noteKill(actorId);
    },
    noteStruck: (actorId: string): void => {
      talents.noteStruck(actorId);
    },
    /**
     * MAY THIS ROUND STAY OPEN? See `TalentResolution.roundOpen`.
     *
     * `MOVE_AP` is passed rather than imported because eslint forbids
     * `engine/** -> content/**` and the cost of a step is content's to own.
     * ZERO TODAY — a step still costs no budget, so a round stays open only
     * while there is a TALENT left to cast. Movement joins the budget with the
     * rest of C4; until then answering otherwise would hold rounds open for a
     * step nothing charges for.
     */
    roundOpen: (actorId: string): boolean => {
      const actor = world.getActor(actorId);
      if (actor === undefined) return false;
      return hasAffordableAction(talents, actor, MOVE_MP_COST);
    },
    /**
     * CHARGE A STEP — `docs/game-design.md` § 6, "Move = 1 MP".
     *
     * False means the round is over for them: they have walked as far as this
     * round allows. `spendResource` is not used because MP is not the class
     * resource — it is the movement half of the intra-turn budget, and it lives
     * on the sheet beside AP.
     */
    spendMove: (actorId: string): boolean => {
      const sheet = talents.sheetOf(actorId);
      if (sheet === undefined) return true;
      if (sheet.mp < MOVE_MP_COST) return false;
      sheet.mp -= MOVE_MP_COST;
      return true;
    },
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE TWO THAT MAKE A TALENT POINT VISIBLE ON THE BASIC SWING.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * Both are pure forwards, and both existed as exported functions in
     * engine/talents.ts with NO PRODUCTION CALLER for exactly as long as the
     * scheduler had no way to reach them. `markMultiplier` was folded into
     * `talentAttack`/`talentProject` only, so Sigil's scaled number moved
     * nothing on the weapon swing; `resolveGuardCounter` had zero call sites
     * anywhere in `src/` while Iron Curtain's panel advertised its per-rank
     * curve. Both talents' levels were therefore partly cosmetic, which is the
     * one thing a talent tree must never be.
     *
     * THE CTX IS THE SAME ONE `use` BUILDS, field for field. A second shape
     * would be a second answer to "which world is this" — see `useTalent`.
     */
    markMultiplier: (targetId: string): number => markMultiplier(talents, targetId),
    guardCounter: (attackerId: string, victimId: string): GuardCounter | null =>
      resolveGuardCounter({ engine: talents, world, rng: world.rng }, attackerId, victimId),
    forget: (actorId: string): void => {
      talents.forget(actorId);
    },
  };
}

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
   * ═══════════════════════════════════════════════════════════════════════════
   * THE STATUS TABLE — WHICH THIS FILE HAS NEVER BUILT.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Stunned, Bleeding and Slowed exist in content/effects.ts with typed saves
   * and partial-save duration scaling, engine/effects.ts implements the whole
   * machine, the party pane draws a badge row for it, `EffectsMsg` is on the
   * wire, and 115 test references exercise it.
   *
   * NONE OF IT WAS CONNECTED. `wsGateway` was registered without `effects`, so
   * `broadcastEffectsIfChanged` was permanently silent and `recomposeCombat`
   * folded a null status table; `createTurnEngine` was called without it, so
   * `PumpCtx.statusPass` — whose own docblock spells out the exact construction
   * and names this adapter as the only thing that can build it — was undefined
   * on every path. A core MVP subsystem (game-design.md § "In": "Three
   * statuses ... with typed saves and partial-save duration scaling") was
   * unreachable in the running game.
   *
   * ONE INSTANCE, for the reason `downed` states above: two tables are two
   * answers to "is Sam still bleeding", and the second one is drawn on the same
   * screen as the first.
   */
  const effects = createEffectState();
  for (const def of [STUNNED, BLEEDING, SLOWED]) registerEffect(effects, def);

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
   * ═══════════════════════════════════════════════════════════════════════════
   * ...AND SOMETHING HAS TO ASK. THE HOOK ABOVE HAD NO TRIGGER.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * The hook is correct and its docblock says "a deliberate restart costs
   * nothing — which is the whole reason the debounce is allowed to be five
   * seconds". That was only ever true if something called `app.close()`, and
   * NOTHING DID: no signal handler, no shutdown route, no ops listener (the
   * `ops/` directory CLAUDE.md's layout plans does not exist yet). So every
   * pending autosave and every in-flight write was abandoned on every stop.
   *
   * ═══ HONEST ABOUT WHAT THIS FIXES AND WHAT IT DOES NOT ═══
   * This closes the case where a signal is actually delivered: Ctrl+C in a dev
   * terminal, and any supervisor that asks politely. The production deploy on
   * this project stops the host with `Stop-Process -Force`, which is
   * TerminateProcess on Windows and CANNOT be intercepted by anything in this
   * process — so this handler does not save that path, and pretending otherwise
   * would be worse than the bug. `tools/deploy-live.ps1` now waits for the
   * process to exit on its own before it reaches for the hammer, which gives a
   * graceful stop the chance it never had; the durable fix is the ops listener,
   * where a `POST /shutdown` belongs.
   *
   * IDEMPOTENT AND BOUNDED. Two signals must not start two shutdowns, and a
   * flush that hangs must not leave a process that cannot be stopped — so the
   * second signal exits immediately, which is also what a person hammering
   * Ctrl+C is asking for.
   */
  let closing = false;
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      if (closing) {
        app.log.warn({ signal }, 'second signal — exiting without finishing the flush');
        process.exit(1);
      }
      closing = true;
      app.log.info({ signal }, 'shutting down: flushing saves');
      void app
        .close()
        .then(() => {
          process.exit(0);
        })
        .catch((err: unknown) => {
          app.log.error({ err }, 'shutdown failed; exiting anyway');
          process.exit(1);
        });
    });
  }

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE TWELVE TALENTS. THE LINE BELOW IS WHY THIS WHOLE MILESTONE EXISTS.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Every one of the twelve in `src/server/talents/` was written, cited against
   * the Lua and unit-tested — AND NONE OF THEM WAS REACHABLE IN PLAY. This file
   * built the engine as `createTurnEngine({ world, downed, parties, log })` with
   * no `talents` option, so the book defaulted to `EMPTY_TALENT_BOOK`, whose
   * entire body is `loadoutOf: () => [], resourceOf: () => undefined`. Every
   * `talent` frame was refused as "no such talent in this loadout", and
   * `sendLoadout` returned early rather than sending a hotbar, so nobody ever
   * saw a button to press. Three files of finished content, wired to nothing.
   *
   * ═══ THE ORDER THE TWO SEAMS HAD TO LAND IN ═══
   * `talents` is the READ-ONLY SUBMISSION GATE (what is in your hotbar, may this
   * be sent) and `talentRuntime` is RESOLUTION (what actually happens, what it
   * costs). Supplying the book alone would have been worse than supplying
   * neither: the hotbar would have appeared, every button would have passed
   * validation, and every one of them would have taken a turn and done nothing —
   * `resolveIntent` answers `Refusal.NoTalentEffect` with no runtime behind it.
   * That is why the resolution seam is a prerequisite rather than a follow-up.
   *
   * It is a lifetime this file owns, exactly like the world, the survival table,
   * the party table and the save store: the sheets live across pumps (AP refills
   * on the base clock, a resource regenerates, cooldowns tick), and an engine
   * that built its own each time would hand every player a full Resolve bar on
   * every frame.
   */
  const talentEngine = createContentTalentEngine();

  /**
   * `log` is what makes a floor reset diagnosable. A party wipe restores
   * everybody and then hands the adapter the half the engine may not do — walk
   * the party to a spawn tile, re-seed this encounter, drop engagement — and the
   * two ways that can go wrong (no free tile at all; the same party wiping again
   * two turns later) are both invisible from inside the game. See `resetFloor`.
   */
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * ONE ENGINE PER REALM, BUILT BY THIS FACTORY AND NOWHERE ELSE
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `createTalentBook` and `talentRuntimeFor` both CLOSE OVER A WORLD, so they
   * cannot be built once and shared: a talent resolving line-of-sight, targets
   * and adjacency would answer about Alderbrook while its caster stood in an
   * instance. Every call succeeds, every answer is about the wrong map, and
   * nothing anywhere fails — which is why realms.ts takes a factory rather than
   * a bag of dependencies.
   *
   * WHAT IS SHARED AND WHAT IS NOT, deliberately:
   *
   *   `downed`  SHARED. A five-turn countdown has to follow a body through a
   *             door; two tables would be two answers to "how long has Sam got".
   *   `parties` SHARED. A party is a social fact, not a map fact — and it is the
   *             very thing that decides which instance you may stand in.
   *   `talentEngine` SHARED. It holds per-ACTOR sheets, and a character keeps
   *             its talents when it walks somewhere.
   *   the BOOK and the RUNTIME are PER WORLD, for the reason above.
   *   the BARRIER is per realm, built inside `createTurnEngine` — two realms
   *             sharing one would collide on its level-wide countdown key.
   */
  /**
   * ONE APPLIER PER REALM, because the rng is per-realm.
   *
   * The status TABLE is global — one `effects` for the whole process, for the
   * reason `downed` states. The DOOR is not: it folds in the world's seeded
   * stream, and the Overworld's stream is not the Hollow Mine's. Building it
   * here, inside `engineFor`'s neighbourhood, is what keeps a stun rolled in a
   * delve drawing from that delve's stream.
   */
  const statusFor = (forWorld: World): StatusApply => statusApplier(effects, forWorld.rng);
  /** The same per-realm rng, for the same reason. See `statusFor` above. */
  const cureFor = (forWorld: World): StatusCure => statusCurer(effects, forWorld.rng);

  const engineFor = (forWorld: World): ReapingTurnEngine =>
    createTurnEngine({
      world: forWorld,
      downed,
      parties,
      talents: createTalentBook(talentEngine, forWorld),
      talentRuntime: talentRuntimeFor(
        talentEngine,
        forWorld,
        statusFor(forWorld),
        (actorId) => budgetPenalty(effects, actorId),
        cureFor(forWorld),
        /**
         * ONCE PER BASE TURN, THE PASSIVES ARE FOLDED AGAIN.
         *
         * This is what makes a board-reading passive real rather than a number
         * frozen at the moment somebody spent a point. Upstream does NOT do this
         * — ToME refreshes on learn, unlearn and mastery change only, and six of
         * its talents work around that with callbacks — so this is a deliberate
         * divergence, affordable here because the fold is a handful of talents
         * over a handful of players, resolving synchronously.
         *
         * WRAPPED IN A CLOSURE, NOT PASSED BY NAME. `refreshPassives` is a `const`
         * declared a hundred lines below this call, and `engineFor` runs during
         * `buildServer` — so naming it directly is a temporal dead zone and the
         * server refuses to boot with "Cannot access before initialization". The
         * arrow defers the lookup to call time, by which point it exists.
         */
        (id: string) => {
          refreshPassives(id);
        },
      ),
      // THE OTHER HALF OF THE STATUS SEAM. `turn-engine.ts` builds
      // `PumpCtx.statusPass` from this, the world's rng and the talent book —
      // it is the only place that holds all three, which is why the seam sat
      // empty until both ends were wired in the same breath.
      effects,
      log: app.log,
    });

  const engine = engineFor(world);

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * A CLASS ON EVERY BODY — the gateway's half of the same seam.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * The gateway PICKS the class (it owns the rotation counter and it is the only
   * layer that has read the save file) and puts the label on the body. It may
   * not attach the SHEET, because that means calling `engine/talents.ts` and
   * net/ states its engine contract structurally rather than importing one.
   * So the capability is injected here, in the one file that already imports
   * both sides — the same shape `reseedFloor` and `talentRuntime` take.
   *
   * SPREAD RATHER THAN MUTATED. `createTurnEngine` returns a fresh object
   * literal of closures, so a copy of it with one more method is the same engine
   * with one more method; assigning onto the original would mean the type the
   * adapter returns and the value it returns had quietly stopped matching.
   *
   * A DANGLING id LOGS AND ATTACHES NOTHING. It cannot normally happen — the
   * gateway substitutes through `classForJoin` before it ever writes a label —
   * so reaching this branch means the two disagree, which is worth a line.
   *
   * ═══════════════════════════════════════════════════════════════════════════
   * A SECOND ATTACH CARRIES THE SPENT SHARE ACROSS. IT IS NOT A REFILL.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `TalentEngine.attach` ends in an unconditional `sheets.set` — it does not
   * merge and it does not ask whether a sheet is already there — so a second
   * call replaces a spent pool with a freshly minted one at its starting value.
   * That is exactly right for the FIRST attach (a brand-new body has spent
   * nothing) and it is a free resource pool for every attach after it.
   *
   * There are two callers and only the first is a fresh body: `hello` attaches
   * on a genuinely new join, and `handleChooseClass` attaches again when the
   * class chooser is answered. The gateway's own note is blunt about why the
   * first one is guarded — "a resumed body still holds the sheet it was given,
   * with its spent Resolve and its running cooldowns, and re-attaching would
   * hand a returning player a full resource pool for free" — and the chooser
   * does precisely that re-attach. Nothing stops a body being acted on while
   * its owner reads the modal, so "nothing has been spent yet" is an assumption,
   * not a fact.
   *
   * THE DEFICIT IS CARRIED, NOT THE PROPORTION OR THE VALUE, AND IT IS MEASURED
   * AGAINST THE POOL'S OWN AUTHORED START — never against `max`. The old pool
   * and the new one are different RESOURCES with different maxima, so a ratio
   * would invent points out of arithmetic and a raw value would be meaningless
   * across kinds. "You are three below where you began; you still are" is the
   * only reading under which nothing is created.
   *
   * IT IS HONESTLY A NO-OP FOR TWO OF THE THREE, and that is not a weakness in
   * the rule. `RESOURCE_RULES` starts Resolve and Focus at 0 and Reagents at 8,
   * so a Watchman or an Inspector can never be BELOW their start and there is
   * nothing to carry — they were never handed anything to lose. The case this
   * actually closes is the one that exists: an Alchemist who has spent vials and
   * re-clothes, who would otherwise walk away with a full stock of eight.
   */
  /**
   * THE GATEWAY'S EXTRA SEAMS, APPLIED TO EVERY REALM'S ENGINE RATHER THAN ONE.
   *
   * This was a single `gatewayEngine` object wrapping the single engine. With
   * realms it has to be a function, because a body that walks into an instance
   * is served by THAT realm's engine — and an unwrapped one has no
   * `attachClass` and none of the three talent-point seams. The failure would
   * be silent and specific: choosing a class, or spending a point, while
   * standing anywhere but the overworld would succeed on the wire, refuse
   * nothing, and simply never attach a sheet.
   *
   * `net/**` may not import `engine/talents.ts` — it states its whole engine
   * contract structurally so the dependency arrow cannot point the wrong way —
   * and this file is the only one that can see the talent registry, the world
   * and the gateway at once. So the capabilities are declared as optional
   * methods on the gateway's `TurnEngine` port and implemented here, which is
   * unchanged; only the arity moved.
   */
  /**
   * ═════════════════════════════════════════════════════════════════════════
   * RE-DERIVE WHAT THIS BODY'S PASSIVES ARE WORTH, AND FOLD THEM IN.
   * ═════════════════════════════════════════════════════════════════════════
   *
   * `actor.passiveCombat` is a STORED contribution, not a lookup — see the field
   * — so something has to write it, and the something has to be this file: it is
   * the only one that can see the talent registry, the world and the gateway at
   * once, which is the same argument `attachClass` above makes for living here.
   *
   * CALLED WHEREVER A RANK CAN CHANGE and nowhere else: attaching a class, and
   * raising a point. A passive whose contribution is computed once at birth
   * would be a talent that never gets better, which is the one thing a rank is
   * for.
   *
   * `recomposeCombat` IS THE ONLY WRITER OF `combat`, still — this writes the
   * input and then asks it to run. Writing the composed sheet here would make
   * two writers of the field that file spends an essay claiming one.
   */
  const refreshPassives = (actorId: string): void => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * WHEREVER THEY ACTUALLY ARE — THIS READ THE WRONG WORLD, AND EVERY
     * PASSIVE IN THE GAME WAS INERT BECAUSE OF IT.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `world` is the standalone one built above for fixtures and for the M1
     * single-level path. Players are not in it: `gateway.ts` places every body
     * into `opts.realms?.overworld.world ?? opts.world`, and `createRealms`
     * builds its own worlds from a seed — so with realms present, which is
     * production, `world.getActor(playerId)` is ALWAYS undefined.
     *
     * The early return below then skipped the write, `actor.passiveCombat` was
     * never set, and `recomposeCombat` never ran from this path for anybody.
     * Measured through the real protocol against a real server: a Watchman
     * reported Armour 6 — his authored class base — with Standing Orders and
     * Issued Kit granting +1 each, Strength 24 against Parade Ground's +1, and
     * Constitution 20 against Long Service's +1. All twenty-four passives, at
     * every rank, on all three classes.
     *
     * ═══ THE SHAPE, AGAIN ═══
     * This is the third instance tonight of a lookup reading a container that
     * cannot hold the answer — after `embellish` reading a realm's players at
     * realm-OPEN, and litter rolling at a hard-coded level 1. The tell is the
     * same: ask WHICH world/table/moment this call actually sees, not whether
     * the call is correct in the abstract.
     *
     * THE FALLBACK IS KEPT. `realms` is optional in some fixtures, and a body
     * in the standalone world is exactly what those mean.
     */
    const actor = realms.realmOf(actorId)?.world.getActor(actorId) ?? world.getActor(actorId);
    const sheet = talentEngine.sheetOf(actorId);
    if (actor === undefined || sheet === undefined) return;

    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE BOARD, AS THIS BODY IS ALLOWED TO SEE IT.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * Built HERE rather than in engine/hooks.ts because everything it needs is
     * already resolved on the two lines above — the actor and the world that
     * actually holds it. Putting it in the engine would mean handing the engine
     * a realm lookup it has no other use for.
     *
     * ONE SNAPSHOT PER FOLD, and the closures read it lazily. A talent that
     * never asks about adjacency costs nothing; a talent that asks twice pays
     * once, because the fold runs once per turn and the board cannot move
     * inside it — turn resolution is synchronous, which is exactly what makes
     * a lazy read safe here.
     */
    const holder = realms.realmOf(actorId)?.world ?? world;
    const neighbours = (): EngineActor[] =>
      holder
        .allActors()
        .filter(
          (other) =>
            other.id !== actor.id &&
            other.alive &&
            Math.max(Math.abs(other.x - actor.x), Math.abs(other.y - actor.y)) <= 1,
        );

    const view: PassiveView = {
      /**
       * TWO SIDES ONLY. `ActorKind` is Player or Monster and there is no third,
       * so "hostile to me" is "not my kind" — which is also true for a monster,
       * and monsters carry passives too.
       */
      adjacentEnemies: () => neighbours().filter((o) => o.kind !== actor.kind).length,
      adjacentAllies: () => neighbours().filter((o) => o.kind === actor.kind).length,
      /**
       * GUARDED AGAINST A ZERO CEILING. A body mid-construction can have
       * `maxHp` of 0, and a passive reading NaN would poison the whole composed
       * sheet rather than failing where anybody could see it.
       */
      hpFraction: () => (actor.maxHp > 0 ? Math.max(0, Math.min(1, actor.hp / actor.maxHp)) : 1),
      resourceFraction: () => {
        // AGAINST THE EFFECTIVE CEILING, not the printed one: a stance that
        // reserved half the pool has made the pool smaller, and "am I full"
        // has to mean full of what is left.
        const ceiling = effectiveResourceMax(talentEngine, sheet);
        return ceiling > 0 ? Math.max(0, Math.min(1, sheet.resource.value / ceiling)) : 1;
      },
      movedThisTurn: () => sheet.movedThisTurn,
      isSustained: (id: string) => sheet.sustained.has(id),
      nearestEnemyDistance: () => {
        let best = Number.POSITIVE_INFINITY;
        for (const other of holder.allActors()) {
          if (other.id === actor.id || !other.alive || other.kind === actor.kind) continue;
          const d = Math.max(Math.abs(other.x - actor.x), Math.abs(other.y - actor.y));
          if (d < best) best = d;
        }
        return best;
      },
    };

    const stats: Record<string, number> = {};
    const mods: Record<string, number> = {};
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * AND WHERE EACH ONE ATTACHES TO THE RULES — same walk, same list.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `engine/hooks.ts` says why there is no registration step: a registry
     * that has to be kept in step with the sheet is a second list that can
     * disagree with the first, and that shape has cost this codebase six
     * separate bugs. So the bound array is rebuilt from the sheet every time
     * the sheet changes, by the function that already runs on exactly those
     * occasions — learn a class, spend a point, toggle a sustain.
     *
     * A SUSTAIN THAT IS DOWN CONTRIBUTES NO HOOK, for free and with no
     * conditional, because `sheet.sustained` holds only what is on. That is
     * the same property that makes the stat fold below correct.
     */
    const bound: BoundHooks[] = [];
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE PASSIVES, AND THE SUSTAINS THAT ARE UP — ONE FOLD FOR BOTH.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * A sustain IS a passive you can switch off: same `passive(rank)` function,
     * same `PassiveContribution`, same combine. Summing them separately would be
     * two folds producing one field, and the second would drift.
     *
     * `sheet.sustained` HOLDS ONLY WHAT IS ON, so a stance that is down
     * contributes nothing without any conditional here — which is the whole
     * reason the set holds ids rather than the record holding a flag.
     */
    for (const id of [...sheet.passives, ...sheet.sustained]) {
      /**
       * A PASSIVE NOBODY HAS LEARNED CONTRIBUTES NOTHING — not a tenth of
       * itself, which is what `combatTalentScale(0)` would hand this fold.
       * `sheet.passives` lists what the class OWNS, and since a class is no
       * longer born knowing all of it, owning and knowing have come apart.
       */
      if ((sheet.points.get(id) ?? 0) < 1) continue;
      const talent = talentEngine.registry.get(id);
      // NARROWED ONCE, HERE. A talent the registry does not hold contributes
      // nothing and hooks nothing — and narrowing at the top means neither of the
      // two uses below has to re-ask.
      if (talent === undefined) continue;
      /**
       * HOOKS FIRST, AND OUTSIDE THE `passive` GUARD BELOW. A talent may
       * carry a hook and no `passive` block at all — upstream has 67 sustains
       * whose entire body is a proc source — and the guard would skip it
       * silently. Collecting here is what lets a talent be pure behaviour.
       */
      if (talent.hooks !== undefined) {
        bound.push({ talentId: id, level: talentLevelOf(sheet, talent), hooks: talent.hooks });
      }
      const contribute = talent.passive;
      if (contribute === undefined) continue;
      /**
       * THROUGH `talentLevelOf`, NOT OFF THE POINT MAP. This site read raw points
       * directly, which made it the one place where a talent would behave at a
       * different rank than the panel reported the moment mastery existed. Five
       * call sites answering "what rank is this" independently is [M-002]; there
       * is one answer now, and every one of them asks it.
       */
      const block = contribute(talentLevelOf(sheet, talent), view);
      for (const [key, value] of Object.entries(block.stats ?? {})) {
        if (typeof value === 'number') stats[key] = (stats[key] ?? 0) + value;
      }
      for (const [key, value] of Object.entries(block.mods ?? {})) {
        if (typeof value === 'number') mods[key] = (mods[key] ?? 0) + value;
      }
    }

    // ABSENT RATHER THAN EMPTY when a body has no passives, so a class without
    // any composes byte-identically to how it did before passives existed.
    const any = Object.keys(stats).length > 0 || Object.keys(mods).length > 0;
    actor.passiveCombat = any
      ? {
          ...(Object.keys(stats).length > 0 ? { stats } : {}),
          ...(Object.keys(mods).length > 0 ? { mods } : {}),
        }
      : undefined;
    /**
     * ABSENT RATHER THAN EMPTY, on the same argument the passive block above
     * makes: a body with no hooks must be byte-identical to how it was before
     * hooks existed, and `applyDamage` short-circuits on an absent array.
     */
    actor.talentHooks = bound.length > 0 ? bound : undefined;
    /**
     * AND THE LATCH THE HOOKS READ, which lives on the SHEET and is borrowed
     * here rather than copied. Two latches — one on the body, one on the sheet
     * — would be two answers to "has this already fired this turn", and only
     * one of them would be getting cleared by the base-turn tick.
     */
    actor.turnProcs = sheet.turnProcs;
    recomposeCombat(actor, effects, resolveItem);

    /**
     * ═══════════════════════════════════════════════════════════════════════
     *   AND HOW MUCH OF THIS BODY THERE IS. Derived, never stored and mutated.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `maxHp` was an authored class constant written once at creation, so a
     * level-50 Watchman had the seventy-two hit points he started with. It is
     * now `classBase + Σ level gains + 4 × Constitution spent` — see
     * `maxLifeFor` in src/shared/leveling.ts for the curve and for why it is
     * computed rather than accumulated.
     *
     * ═══ HERE, BECAUSE THIS FUNCTION ALREADY RUNS ON EVERY INPUT ═══
     * The three inputs are the class, the level and the Constitution spent, and
     * `refreshPassives` is called on exactly the occasions any of them can move:
     * class chosen, talent point spent, ATTRIBUTE point spent (through the
     * `refreshBody` seam, which exists for that one reason), character restored,
     * and once per base turn — which is what catches a level gained mid-pump.
     * A second trigger somewhere else would be a second answer to "how big is
     * this body", and the first time they disagreed a player would gain or lose
     * hit points on reconnect.
     *
     * ═══ CURRENT HP IS CLAMPED, NOT SCALED ═══
     * A body whose ceiling drops must not keep hit points above it — a pool
     * reading 90/72 is a number no other part of this game can be shown. It is
     * NOT raised to match a rising ceiling: a level-up widens the pool and
     * leaves the blood in it where it was, so 40/72 becomes 40/89 rather than a
     * free heal. That is upstream verbatim — Actor.lua:3823 adds to `max_life`
     * and does not touch `life` — and it is what stops levelling mid-fight from
     * being a panic button worth farming a kill for.
     */
    if (isPlayer(actor) && actor.classId !== undefined) {
      const definition = classById(actor.classId);
      if (definition !== undefined) {
        actor.maxHp = maxLifeFor(
          definition.maxHp,
          definition.lifeRating,
          actor.level,
          PLAYER_RANK,
          actor.spentStats?.con ?? 0,
        );
        actor.hp = Math.min(actor.hp, actor.maxHp);
      }
    }
  };

  const wrapForGateway = (base: ReapingTurnEngine): ReapingTurnEngine => ({
    ...base,
    attachClass: (actorId: string, classId: string): void => {
      const definition = classById(classId);
      if (definition === undefined) {
        app.log.warn({ actorId, classId }, 'no such class — this body gets no hotbar');
        return;
      }
      const previous = talentEngine.sheetOf(actorId);
      const sheet = sheetForClass(definition);
      if (previous !== undefined) {
        const startedAt = RESOURCE_RULES[previous.resource.kind].start;
        const short = Math.max(0, startedAt - previous.resource.value);
        sheet.resource.value = Math.max(0, sheet.resource.value - short);
      }
      talentEngine.attach(actorId, sheet);
      // THE SHEET IS THE INPUT AND THIS IS THE OUTPUT. A class chosen without
      // this line attaches passives that are true on paper and worth nothing.
      refreshPassives(actorId);
    },

    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE THREE TALENT-POINT SEAMS — the same shape and the same reason as
     * `attachClass` above.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * A raw talent level lives in `TalentSheet.points`, and `net/**` may not
     * import `engine/talents.ts` — it states its whole engine contract
     * structurally so that the dependency arrow never points the wrong way
     * through the module graph. This file is the only one that can see the
     * talent registry, the world and the gateway at once, so the capability is
     * declared as an optional method on the gateway's `TurnEngine` port and
     * implemented here, exactly as `attachClass` and `talentRuntime` are.
     *
     * NONE OF THE THREE IS AN AUTHORISATION. `handleSpendPoint` has already
     * decided, from the per-actor `loadoutOf` view, that the talent is in this
     * body's loadout and below its cap and that there is a point to pay with.
     * These are the WRITES and the READ — and `raiseTalentPoint` re-derives the
     * level it reports from the sheet rather than echoing an argument, so a
     * caller cannot invent a rank.
     *
     * THE 1..`TALENT_MAX_LEVEL` CAP IS ENFORCED IN BOTH, and the duplication is
     * deliberate rather than sloppy: the gateway's check is about the PLAYER's
     * request (with an error code the client can act on) and this one is about
     * the SHEET's invariant (silently clamping is the only sane answer to a
     * corrupt file). src/shared/scale.ts:165-170 explains why the curve itself
     * must NOT clamp — a level above 5 has to extrapolate honestly — which is
     * precisely why the cap has to live wherever a level is written.
     */
    raiseTalentPoint: (actorId: string, talentId: string): number | null => {
      const sheet = talentEngine.sheetOf(actorId);
      if (sheet === undefined) return null;
      // NOT IN THE LOADOUT IS NOT A RANK. `points` is keyed by an id that must
      // already be in `loadout` (engine/talents.ts), and seeding a new key here
      // would let a spend teach a body a talent it never learned.
      const current = sheet.points.get(talentId);
      if (current === undefined) return null;
      if (current >= TALENT_MAX_LEVEL) return current;
      const next = current + 1;

      /**
       * ═══════════════════════════════════════════════════════════════════════
       * AND IS THIS CHARACTER ALLOWED TO GO THAT DEEP YET?
       * ═══════════════════════════════════════════════════════════════════════
       *
       * THE GATE IS CHECKED AGAINST `next`, NOT `current`. The ladder is a rule
       * about the rank being BOUGHT — asking about the rank already held would
       * let every talent be raised one step past its own requirement, which is
       * an off-by-one nobody would ever see except as "the cap feels wrong".
       *
       * `treeKnown` COUNTS OTHER TALENTS OF THE SAME TREE, excluding this one:
       * a tier-2 talent wants one OTHER talent of its discipline known, and
       * counting itself would satisfy that requirement with itself.
       */
      const talent = talentEngine.registry.get(talentId);
      if (talent === undefined) return null;

      const body = realms.realmOf(actorId)?.world.getActor(actorId) ?? world.getActor(actorId);
      /**
       * ═════════════════════════════════════════════════════════════════════
       * KNOWN MEANS RANK >= 1, AND THIS IS WHAT FINALLY MAKES DEPTH A GATE.
       * ═════════════════════════════════════════════════════════════════════
       *
       * The point map holds every talent the class owns — that is how the
       * panel knows what there is to buy — so counting its KEYS answered
       * "how many are in this tree", which is a constant, five, for every
       * tree in the game. The depth requirement was therefore satisfied by
       * everybody at all times, and `treeDepthRequiredFor` might as well have
       * returned 0.
       *
       * With a class born knowing four talents rather than eighteen, the
       * count is a real one and `ActorTalents.lua:729-734` says what it
       * always meant: you cannot reach for the deepest thing in a discipline
       * without having studied the rest of it.
       */
      const known = [...sheet.points.entries()].filter(([id, rank]) => {
        if (id === talentId || rank < 1) return false;
        return talentEngine.registry.get(id)?.tree === talent.tree;
      }).length;

      const gate = checkTier({
        tier: talent.tier,
        rank: next,
        stat: talent.statGate,
        // THE COMPOSED SHEET, not the class base: a stat gate has to see the
        // points a player actually spent, plus whatever their gear and passives
        // are worth, or it refuses a talent the character sheet says they qualify
        // for.
        statValue:
          talent.statGate === undefined ? 0 : (body?.combat?.stats?.[talent.statGate] ?? 0),
        // A LEVEL IS A PLAYER FACT. `MonsterActor` has none, and a monster with
        // a talent sheet is a fixture rather than something that spends points.
        characterLevel: body !== undefined && isPlayer(body) ? body.level : 1,
        treeKnown: known,
      });
      // REFUSED IS `null`, which is exactly what this seam already answers for
      // a talent that cannot be raised — the gateway turns it into a sentence.
      if (!gate.ok) return null;
      sheet.points.set(talentId, next);
      // AND IF THAT WAS A PASSIVE, IT IS NOW WORTH MORE. Unconditional rather
      // than guarded on membership: the helper reads the sheet's own passive
      // list, so raising an active re-derives the same numbers and writes them
      // back unchanged, which is cheaper than getting the guard wrong.
      refreshPassives(actorId);
      return next;
    },

    /**
     * ═══════════════════════════════════════════════════════════════════════
     * TURN A STANCE ON OR OFF, AND REFOLD.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * THE SAME SHAPE AS `raiseTalentPoint` ABOVE: the engine owns the sheet, and
     * this file is the only one that can see the registry, the world and the
     * gateway at once — so the refresh belongs here rather than inside the
     * toggle, which must stay a function of the sheet alone.
     *
     * `null` FOR EVERY REFUSAL, which is what the gateway's seam already reads
     * for a talent that cannot be raised. The reasons are for the engine's own
     * tests; a socket is told a sentence, not an enum.
     */
    /**
     * THE PUBLIC NAME FOR `refreshPassives`, and the only reason it is a seam:
     * spending Constitution changes a hit-point ceiling that net/** cannot
     * compute for itself. See `TurnEngine.refreshBody` for the whole argument.
     *
     * A ONE-LINE FORWARD ON PURPOSE. The instant this grows a second statement
     * there are two answers to "how big is this body" and they will disagree.
     */
    refreshBody: (actorId: string): void => {
      refreshPassives(actorId);
    },

    toggleSustain: (actorId: string, talentId: string): boolean | null => {
      const sheet = talentEngine.sheetOf(actorId);
      if (sheet === undefined) return null;
      const result = toggleSustain(talentEngine, sheet, talentId);
      if (!result.ok) return null;
      // THE CONTRIBUTION IS THE POINT OF THE TOGGLE. Without this the stance is
      // a flag in a set and nothing on the body changes.
      refreshPassives(actorId);
      return result.on;
    },

    talentPointsOf: (actorId: string): Readonly<Record<string, number>> | undefined => {
      const sheet = talentEngine.sheetOf(actorId);
      if (sheet === undefined) return undefined;
      // A PLAIN OBJECT, NEVER THE LIVE MAP. Two reasons and both bite: a Map
      // serialises as `{}` through `JSON.stringify` — silently, which would
      // write every character back at rank 1 — and the snapshot must be frozen
      // in time, because the save layer holds it by reference across a debounce
      // while the sheet goes on changing.
      const out: Record<string, number> = {};
      for (const [id, raw] of sheet.points) out[id] = raw;
      return out;
    },

    applyTalentPoints: (
      actorId: string,
      points: Readonly<Record<string, number>>,
    ): readonly string[] | undefined => {
      const sheet = talentEngine.sheetOf(actorId);
      if (sheet === undefined) return undefined;

      const dropped: string[] = [];
      for (const [talentId, raw] of Object.entries(points)) {
        // ═══ AN ID THIS SHEET DOES NOT HAVE IS REPORTED, NEVER SEEDED ═══
        // Two ways to get here and the caller cannot tell them apart, which is
        // fine because the answer is the same: a talent this build DELETED
        // (docs/data-schemas.md § 1's refundPool case — "friends' saves must
        // outlive your content edits"), or a talent belonging to a class this
        // character no longer is. Either way the points did not land, so the
        // gateway's ledger does not count them as spent and hands them back.
        if (!sheet.points.has(talentId)) {
          dropped.push(talentId);
          continue;
        }
        if (!Number.isFinite(raw)) {
          dropped.push(talentId);
          continue;
        }
        // CLAMPED RATHER THAN REFUSED. A hand-edited `"crude_blow": 9999` is a
        // file problem, not a reason somebody cannot play tonight — the same
        // repair-never-reject doctrine `parseCharacterFile` applies upstream.
        sheet.points.set(talentId, Math.max(1, Math.min(TALENT_MAX_LEVEL, Math.floor(raw))));
      }
      return dropped;
    },
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE REALMS. Alderbrook, the towns, and whatever instances get opened.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Built HERE, beside the world it will come to replace, for the same reason
   * the world and the survival table are: it is a lifetime the entry point
   * owns.
   *
   * `world` AND `engine` ARE STILL PASSED, and that is not vestigial. They are
   * the gateway's fallback for a session that has not been placed in a named
   * realm — `realmFor` resolves a null `Session.realmId` to exactly this pair —
   * which is what keeps every existing test, and tools/e2e-m1.mjs, describing
   * the game they always did.
   */
  const realms = createRealms({
    seed: WORLD_SEED,
    engineFor: (forWorld) => wrapForGateway(engineFor(forWorld)),
  });

  app.log.info(
    {
      realms: realms.all().map((r) => `${r.name} [${r.kind}]`),
      overworld: `${realms.overworld.world.level.w}x${realms.overworld.world.level.h}`,
      sites: realms.overworld.sites.size,
    },
    `built ${realms.all().length} realm(s)`,
  );

  const gatewayEngine = wrapForGateway(engine);

  // `parties` IS THE SAME TABLE EVERY REALM'S ENGINE ALREADY HAS. The gateway
  // reads it for exactly one question — whose instance is this, when somebody
  // steps onto a site cell — and `Realms.open` is idempotent on the answer, so a
  // second table would put two friends who walked through the same door into two
  // private copies of the same floor.
  app.register(wsGateway, {
    world,
    engine: gatewayEngine,
    realms,
    parties,
    downed,
    // THE STATUS TABLE, so badges reach the party pane and a status can change
    // a sheet. Without it `broadcastEffectsIfChanged` sends nothing at all.
    effects,
    // THE TALENT LAYER'S TABLE, so Sigil's mark and Iron Curtain's guard reach
    // the badge row. One method, narrowed at the option — see `talentEffects`.
    talentEffects: talentEngine,
    sessions,
    persist,
  });

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

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * AND THE OPS SURFACE BESIDE IT — a SECOND listener, on loopback.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `docs/control-panel.md`: "Ops :3001 -> 127.0.0.1, behind nothing, never
   * public". A separate Fastify instance rather than a route prefix, because the
   * game app is reachable from the internet through the tunnel that serves the
   * Discord Activity and anything mounted on it is reachable by anyone who can
   * load the game. See `ops/routes.ts` for why the bind is the whole boundary.
   *
   * IT CLOSES THE *GAME* APP, not itself: `POST /shutdown` exists to run the
   * game's `onClose` hook, which flushes every pending autosave. Closing this
   * listener instead would flush nothing.
   *
   * FAIL-SOFT. `startOps` answers null if :3001 is taken and the game carries on
   * regardless — an ops surface that can stop the game from booting is a worse
   * trade than one that is occasionally missing, and the deploy script already
   * handles its absence.
   */
  // `loggerInstance`, NOT `logger`. Fastify 5's `logger` field takes a CONFIG
  // OBJECT and throws `FST_ERR_LOG_INVALID_LOGGER_CONFIG` on an instance —
  // which it did, from outside the fail-soft guard below, and killed a game
  // server that had already bound its port. Sharing the instance is what keeps
  // both surfaces on one stream, so a deploy reads one log and not two.
  const started = await startOps(() => Fastify({ loggerInstance: app.log }), {
    closeGame: () => app.close(),
  });
  if (started === null) {
    app.log.warn('ops: :3001 unavailable — a deploy will fall back to forcing the stop');
  } else {
    app.log.info({ port: started.port }, 'ops listening on loopback');
  }
}
