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

import { creditForLanding, recomposeCombat } from './engine/effects.ts';
import { maxLifeOf, maxMoveOf } from './engine/pools.ts';
import { resolveItem } from './content/resolve.ts';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { argv, env, exit, hrtime } from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { startOps } from './ops/routes.ts';

import { MASTERY_DEEPEN_LIMIT, TALENT_MAX_LEVEL } from '../shared/progression.ts';
import { checkTier, tierRefusalText } from '../shared/tiers.ts';
import { treeById } from './content/talent-trees.ts';
import type { ClassDef } from './content/classes.ts';
import { PLAYER_RANK } from '../shared/leveling.ts';
import { PROTOCOL_VERSION } from '../shared/version.ts';
import {
  classById,
  createContentTalentEngine,
  createTalentBook,
  sheetForBody,
  spendByPurse,
  treesForClass,
} from './content/classes.ts';
import { seedTestEncounter } from './content/encounter.ts';
import { createDownedState } from './engine/downed.ts';
import { createPartyState } from './engine/party.ts';
import {
  budgetPenalty,
  EffectStatus,
  createEffectState,
  effectsOn,
  registerEffect,
  statusApplier,
  statusCurer,
  statusExtender,
} from './engine/effects.ts';
import type { StatusApply, StatusCure, StatusExtend } from './engine/effects.ts';
import type { BudgetPenalty } from './engine/talents.ts';
import { MVP_EFFECTS, effectById } from './content/effects.ts';
import {
  MOVE_MP_COST,
  ResourceKind,
  TargetShape,
  canUseTalent,
  createTalentSheet,
  RESOURCE_RULES,
  effectiveResourceMax,
  hasAffordableAction,
  markMultiplier,
  resolveGuardCounter,
  sustainAnswer,
  talentLevelOf,
  toggleSustain,
  useTalent,
} from './engine/talents.ts';
import { authRoutes, isConfigured, readAuthConfig } from './http/auth.ts';
import { createSessionStore } from './http/session.ts';
import { wsGateway } from './net/gateway.ts';
import { createCharacterBridge, createSaveStore } from './persist/saves.ts';
import type { BoundHooks, PassiveView } from './engine/hooks.ts';
import { createTurnEngine } from './turn-engine.ts';
import { createRealms } from './world/realms.ts';
import { createWorld } from './world/world.ts';
import { isPlayer } from './engine/actor.ts';
import type { EngineActor } from './engine/actor.ts';
import { breakDamageSensitive } from './engine/effects.ts';
import type { TalentResolutionResult } from './engine/scheduler.ts';
import type { GuardCounter, TalentEngine, TalentSheet } from './engine/talents.ts';
import type { MonsterCast } from './ai/npc.ts';
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
 * ═══════════════════════════════════════════════════════════════════════════
 * HOW OFTEN A SHARED REALM'S CLOCK TURNS OVER, OR 0 TO STOP IT.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Absent → `TIDE_MS`, which is the number the game runs on and which
 * world/realms.ts argues. Set to `0` by integration tests that SCRIPT a walk:
 * a live world clock drifts the roamers under a 106-tile path, which is the
 * feature working and is exactly what makes such a walk non-deterministic.
 *
 * An env var rather than an argument, because these tests spawn `main.ts` as a
 * child process and `PORT`, `HOST` and `WORLD_SEED` already arrive the same way.
 */
const TIDE_MS_OVERRIDE = env['TIDE_MS'] === undefined ? undefined : Number(env['TIDE_MS']);

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
  /**
   * SOMETHING HIT THIS BODY — SHED WHATEVER CANNOT SURVIVE THAT.
   *
   * Passed in for the same reason `status`, `penaltyFor` and `cure` above are:
   * it needs the effect catalogue, which this adapter cannot reach.
   *
   * OPTIONAL, and absent is every fixture that builds a runtime by hand — which
   * is most of the suite. Absent means no effect ever breaks on damage, which is
   * exactly the game those fixtures were written against.
   */
  breakOnDamage?: (actorId: string) => void,
  /**
   * THE THIRD STATUS DOOR — `statusExtender`, beside `status` and `cure`.
   *
   * LAST IN THE LIST rather than beside its twins, because every parameter here
   * is positional and every one of the fixtures that builds a runtime by hand
   * passes them that way; inserting after `cure` would have shifted five
   * arguments at every call site and made a compile error out of a change that
   * has nothing to do with them.
   *
   * Optional for the same reason all of these are: absent is a fixture with no
   * status table, and a talent that wants to lengthen an affliction gets the
   * same empty list it would get from a body that had none.
   */
  extend?: StatusExtend,
): TalentRuntime {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * GIVE A CREATURE ITS SHEET, THE FIRST TIME ANYTHING ASKS WHAT IT CAN DO.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * There is no other moment to do this in. `engine.attach` is called from the
   * class path, which is players only, and a delve builds its monsters when the
   * REALM OPENS — before anybody has walked in and before this engine has heard
   * of them. Threading an attach through every spawn site would mean handing
   * `content/` the talent engine, which is the import arrow eslint refuses.
   *
   * ON DEMAND IS THEREFORE THE DESIGN RATHER THAN A SHORTCUT, and it is cheap:
   * a creature with no `talents` list never gets here at all, and one that does
   * pays a `Map` lookup per turn after the first.
   *
   * ═══ THE SHEET IS BUILT FROM THE BODY, AND EVERY TALENT IS BORN LEARNED ═══
   * A monster does not level, does not spend points and has no class. Its list
   * IS its loadout, at rank 1, which is what `createTalentSheet` does with no
   * `birth` argument — the same default every fixture in the tree relies on.
   *
   * NO RESOURCE POOL WORTH THE NAME. A creature is given the Watchman's budget
   * because `TalentSheetInit` requires one and a monster talent must not cost a
   * resource: there is nothing in the game that refills a monster's pool, so a
   * talent priced in one would fire once per creature per lifetime and then
   * look broken. Monster talents are priced in COOLDOWN, which the sheet ticks
   * for everybody.
   */
  /**
   * WHAT A CREATURE'S SHEET IS GIVEN TO SPEND.
   *
   * ═══ THE SAME SIX AP A PLAYER HAS, ON PURPOSE ═══
   * A monster talent has to cost something a player can reason about, and "two
   * of its six" is a sentence that means the same thing on both sides of a
   * fight. Giving creatures their own budget would make every monster talent's
   * AP cost a number with no referent.
   *
   * MOVEMENT IS ZERO AND THAT IS NOT AN OVERSIGHT. The AI moves through
   * `IntentKind.Move`, which spends the ACTOR's budget and never the sheet's —
   * a creature's sheet exists to gate talents. An `maxMp` here would be a pool
   * nothing draws from.
   */
  const MONSTER_AP = 6;
  const MONSTER_MP = 0;

  const ensureMonsterSheet = (actor: EngineActor): TalentSheet | undefined => {
    const known = 'talents' in actor ? actor.talents : undefined;
    if (known === undefined || known.length === 0) return undefined;
    const existing = talents.sheetOf(actor.id);
    if (existing !== undefined) return existing;
    return talents.attach(
      actor.id,
      createTalentSheet({
        loadout: [...known],
        resource: ResourceKind.Resolve,
        maxAp: MONSTER_AP,
        maxMp: MONSTER_MP,
      }),
    );
  };

  return {
    /**
     * WHAT THIS CREATURE COULD CAST AT THAT BODY THIS TURN.
     *
     * ═══ EVERY OPTION HAS ALREADY PASSED `canUseTalent` ═══
     * Known, off cooldown, affordable, in range, in line of sight, against a
     * legal affinity. So the AI decides WHETHER rather than whether it can, and
     * a refusal can never reach the scheduler and cost the creature its turn —
     * which would read to a player as a monster that occasionally just stands
     * there.
     *
     * IN TEMPLATE ORDER, because that order is the creature's own preference.
     * The AI takes the first; an author reorders the list to change what a
     * creature reaches for, rather than tuning against a scoring function.
     */
    castable: (self: EngineActor, target: EngineActor): readonly MonsterCast[] => {
      const sheet = ensureMonsterSheet(self);
      if (sheet === undefined) return [];
      const out: MonsterCast[] = [];
      for (const id of sheet.loadout) {
        const talent = talents.registry.get(id);
        if (talent === undefined) continue;
        const at = { x: target.x, y: target.y };
        // THE TARGET TILE IS THE VICTIM'S, EXCEPT FOR A SELF SHAPE, which aims
        // at the caster's own — the same rule `use` above applies when a client
        // sends no tile.
        const aim = talent.targeting.shape === TargetShape.Self ? { x: self.x, y: self.y } : at;
        if (canUseTalent(talents, self, talent, { ...aim, actorId: target.id }, world) !== null) {
          continue;
        }
        out.push({ talentId: id, target: aim });
      }
      return out;
    },

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
          ...(extend === undefined ? {} : { extend }),
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
      /**
       * ═══ AND THE OTHER THING A BLOW DOES: IT WAKES YOU UP ═══
       * `EFF_DAZED` upstream is *"any damage will remove the daze"*, which is
       * how ToME can hand out a debuff that halves eight rolls without the game
       * becoming a stunlock. This hook already fires on exactly the right
       * event — a blow that hit and dealt more than zero — so the condition
       * never had to be defined twice.
       */
      breakOnDamage?.(actorId);
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
  /**
   * ═══ THE ROSTER, NEVER A LIST WRITTEN OUT HERE ═══
   *
   * This read `[STUNNED, BLEEDING, SLOWED]`, which was every effect in the game
   * on the day it was written and stopped being so the moment a fourth was
   * added. `setEffect` on an id this state does not know answers
   * `SetEffectOutcome.Unknown` and does nothing — no throw, no log, no badge —
   * so Effaced, Breached and Dazed were registered in `MVP_EFFECTS`, exercised
   * by their own passing tests, applied by four talents, and INERT in the
   * running game.
   *
   * The literal was the bug. `MVP_EFFECTS` is the one list that already has to
   * be right — `EFFECT_IDS`, `effectById` and `createMvpEffectState` are all
   * built from it — and iterating it here means a seventh effect is registered
   * by existing, with nothing for anyone to remember.
   */
  const effects = createEffectState();
  for (const def of MVP_EFFECTS) registerEffect(effects, def);

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
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * APPLY A STATUS — AND TELL THE PERSON WHO CAUSED IT THAT IT LANDED.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `statusApplier` is the engine's half and knows nothing about resources.
   * `talentEngine` owns the bars and cannot see an effect land. This wrapper is
   * the only place both are in scope, which is the same reason `status`,
   * `cure` and `breakOnDamage` are all assembled here.
   *
   * ═══ ON LANDING, NOT ON APPLYING ═══
   * A save the target MADE pays nothing. Paying on the attempt would make Ink a
   * flat tax on pressing buttons and would reward a Redactor for spraying marks
   * at things that shrug them off, which is the opposite of the class.
   *
   * ═══ AND ONCE, NOT EVERY TURN THE EFFECT RUNS ═══
   * Per-tick income would make DURATION the only stat worth having and would
   * pay a long slow twice over. One mark, one payment.
   *
   * DETRIMENTAL ONLY, and the caster must not be the victim: a Redactor who
   * bandages an ally is not writing anything down, and one who is bleeding does
   * not get paid for it.
   */
  const statusFor = (forWorld: World): StatusApply => {
    const apply = statusApplier(effects, forWorld.rng);
    return (target, effectId, duration, params = {}) => {
      const landed = apply(target, effectId, duration, params);
      /**
       * THE RULE IS `creditForLanding`'S; THE WIRING IS THIS FILE'S.
       *
       * It used to be four conditions written out here, which meant the only
       * path by which `ResourceKind.Ink` could ever be earned had no test of its
       * own — nothing can reach a closure in `main.ts` without booting a server.
       * See engine/effects.ts for the four conditions and why each one is a real
       * decision rather than a guard.
       */
      const credit = creditForLanding(
        target.id,
        landed,
        params.srcId,
        effectById(effectId)?.status,
      );
      if (credit !== null) talentEngine.noteAfflicted(credit);
      return landed;
    };
  };
  /** The same per-realm rng, for the same reason. See `statusFor` above. */
  const cureFor = (forWorld: World): StatusCure => statusCurer(effects, forWorld.rng);
  /**
   * NO RNG, UNLIKE ITS TWO NEIGHBOURS. `statusFor` and `cureFor` both take the
   * per-realm stream because applying rolls a save and removing runs the
   * effect's own `onRemove`. Lengthening rolls nothing — upstream does not make
   * a body save twice for one affliction, the save was made and lost when it
   * landed — so there is no draw to keep deterministic and no realm to key on.
   */
  const extendFor = (): StatusExtend => statusExtender(effects);

  const engineFor = (forWorld: World): ReapingTurnEngine =>
    createTurnEngine({
      world: forWorld,
      // AN EFFECT THAT GRANTS STATS LANDED OR LEFT. See EffectCtx.sheetDirty:
      // rebuilding a sheet needs the item catalogue, which only this closure
      // holds, so the engine is handed the capability rather than the catalogue.
      onSheetDirty: (actorId: string): void => {
        refreshPassives(actorId);
      },
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
        // See `breakOnDamage` on the signature. `effects` is in scope here and
        // in no layer below, which is the whole reason these are seams.
        (id: string) => {
          const body = forWorld.getActor(id);
          if (body !== undefined) breakDamageSensitive(effects, body, forWorld.rng);
        },
        extendFor(),
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
      /**
       * ═════════════════════════════════════════════════════════════════════
       * HOW MUCH IS WRONG WITH THIS BODY — the status table, read at last.
       * ═════════════════════════════════════════════════════════════════════
       *
       * Twelve talents apply a stun, a slow or a bleed and not one has ever
       * ASKED whether it is standing in one, so being afflicted could only be
       * a cost. `generic/nerve` is the discipline that reads it.
       *
       * DETRIMENTAL ONLY, off the effect's own `status` field — a body carrying
       * something helpful is not having a hard time, and paying for a buff
       * would be paying for its own party.
       *
       * COUNTED FRESH EACH FOLD rather than cached: the fold already runs once
       * per base turn and on every input that can change a number, and a
       * remembered count would be a second answer to what the table plainly
       * holds. It is a walk over one actor's own effects, which is a handful.
       */
      afflicted: () =>
        effectsOn(effects, actor.id).filter(
          // THROUGH THE REGISTRY, because an instance carries an id and not its
          // definition — `status` is a fact about the EFFECT rather than about
          // this particular application of it. An id the table does not know is
          // not counted: an unregistered effect is a content bug, and guessing
          // that it is detrimental would pay a talent for it.
          (instance) => effects.defs.get(instance.effectId)?.status === EffectStatus.Detrimental,
        ).length,
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
        /**
         * ═══════════════════════════════════════════════════════════════════
         *   THE CONSTITUTION THIS BODY IS STANDING AT — NOT THE ONE IT BOUGHT.
         * ═══════════════════════════════════════════════════════════════════
         *
         * This was `maxLifeFor(..., actor.spentStats?.con ?? 0)` and that was a
         * live bug: `spentStats` is the ledger of points the PLAYER PURCHASED,
         * so gear, passives and timed effects paid nothing into the pool. The
         * whole argument, and the reason it is now a named function with a test
         * rather than an expression nothing could reach, is in `engine/pools.ts`.
         *
         * IT READS `actor.combat`, which the `recomposeCombat` a few lines above
         * has just rebuilt from the class sheet, the bought points, the worn
         * gear, the passives and the live effects. That ordering is the entire
         * contract of this block: the resize must follow the refold, or it sizes
         * the body the player had a moment ago.
         */
        actor.maxHp = maxLifeOf(actor, definition, PLAYER_RANK);
        actor.hp = Math.min(actor.hp, actor.maxHp);

        /**
         * ═══════════════════════════════════════════════════════════════════
         *   AND HOW FAR IT GETS IN A TURN. The other pool nothing could move.
         * ═══════════════════════════════════════════════════════════════════
         *
         * `maxMp` came off the class table and stayed there for a whole career:
         * a level-50 character covered exactly the ground a level-1 one did.
         * Statuses could take movement away (`mpPenalty`) and nothing in the
         * game could ever give it back.
         *
         * DERIVED HERE FOR `maxHp`'s REASONS, ALL OF THEM. This function runs on
         * every occasion the inputs can move — class chosen, point spent,
         * discipline bought, character restored, once per base turn — and a
         * second site would be a second answer to "how far does this body go".
         *
         * ═══ THE CEILING MOVES; THE POOL IS LEFT WHERE IT IS ═══
         * `sheet.mp` is refilled against `maxMp` once per turn (engine/talents.ts)
         * and that refill is the only thing that should hand a player movement.
         * Raising the current pool here would give a step back mid-turn to
         * anybody who spent a point, which is a free move the turn system never
         * agreed to. Clamped downward only, for the reason the hit points above
         * are: a pool reading 4/3 is a number nothing else in this game can
         * draw.
         */
        const sheet = talentEngine.sheetOf(actorId);
        if (sheet !== undefined) {
          /**
           * ═══════════════════════════════════════════════════════════════════
           * FROM THE COMPOSED SHEET, NOT FROM `passiveCombat`.
           * ═══════════════════════════════════════════════════════════════════
           *
           * This read `actor.passiveCombat?.mods?.moveMp` — the passive layer
           * alone — which is the same shape as the bug that started this whole
           * pass: a derived pool reaching past `recomposeCombat` to one of the
           * layers underneath it. A `moveMp` from gear or from a timed effect
           * paid nothing, and `equipment.ts` was dropping the gear one anyway.
           *
           * BOTH HALVES HAD TO LAND TOGETHER. Adding `moveMp` to
           * `WIELDER_MOD_KEYS` without this line changes nothing; changing this
           * line without the allow-list would have made the `legwork` passive
           * vanish, because the fold would not have carried it into `combat`.
           */
          sheet.maxMp = maxMoveOf(actor, definition);
          sheet.mp = Math.min(sheet.mp, sheet.maxMp);
        }
      }
    }
  };

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * REBUILD THIS BODY'S TALENT SHEET FROM ITS TWO PURCHASE LISTS.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Both things a category point buys end here: unlocking a discipline changes
   * `opened`, deepening one changes `deepened`, and either way the sheet is
   * built from scratch and everything the character had is carried across.
   *
   * ═══ IT IS ONE FUNCTION BECAUSE THE CARRY IS THE DANGEROUS PART ═══
   * `unlockTree` did this inline, and its docblock spends a paragraph on why:
   * *"THE POINTS SURVIVE THE REBUILD … the ranks are read off the OLD sheet and
   * written onto the new one before it is attached"*, plus the stances, plus the
   * three pools. Every one of those is a silent, unrecoverable loss if the
   * second caller forgets it — a player would spend the scarcest currency in the
   * game and have their ranks reset. Copying thirty lines to add a second spend
   * is how that happens, so there is one copy and two callers.
   *
   * THE LISTS ARE PASSED, NOT READ OFF THE BODY, so a caller cannot rebuild
   * against a list it has not written yet. Both callers write first.
   */
  const rebuildTalentSheet = (
    actorId: string,
    definition: ClassDef,
    opened: readonly string[],
    deepened: readonly string[],
  ): void => {
    const previous = talentEngine.sheetOf(actorId);
    const sheet = sheetForBody(definition, {
      unlockedTrees: opened,
      deepenedTrees: deepened,
    });
    if (previous !== undefined) {
      // EVERY RANK THE CHARACTER HAD, CARRIED ACROSS.
      for (const [id, rank] of previous.points) {
        if (sheet.points.has(id)) sheet.points.set(id, rank);
      }
      // AND THE STANCES THEY WERE HOLDING, for the same reason: a discipline
      // bought mid-fight must not put a player's methods down.
      for (const id of previous.sustained) {
        if (sheet.points.has(id)) sheet.sustained.add(id);
      }
      sheet.resource.value = previous.resource.value;
      sheet.ap = previous.ap;
      sheet.mp = previous.mp;
    }
    talentEngine.attach(actorId, sheet);
    refreshPassives(actorId);
  };

  const wrapForGateway = (base: ReapingTurnEngine): ReapingTurnEngine => ({
    ...base,
    attachClass: (actorId: string, classId: string): void => {
      const definition = classById(classId);
      if (definition === undefined) {
        app.log.warn({ actorId, classId }, 'no such class — this body gets no hotbar');
        return;
      }
      /**
       * ═══════════════════════════════════════════════════════════════════════
       * THE TWO PURCHASE LISTS, WHICH THIS BUILT WITHOUT AND SHOULD NOT HAVE.
       * ═══════════════════════════════════════════════════════════════════════
       *
       * This read `sheetForClass(definition)` — no unlocked trees, no deepened
       * ones. `CharacterFile.unlockedTrees` promises the opposite in as many
       * words: *"THE SHEET IS DERIVED FROM IT AND NEVER THE OTHER WAY ROUND …
       * a reconnect rebuilds that sheet from scratch — so if this list were not
       * the authority, a returning player would lose the discipline they paid
       * for."* The list was the authority and nothing consulted it.
       *
       * `attachClass` is the ONLY sheet builder on the reconnect path
       * (gateway.ts fires it, then `restoreProgression`), so a character who had
       * bought a discipline came back without it: measured at 36 talents before
       * and 30 after, one whole tree, and the ranks inside it dropped with it
       * because `applyTalentPoints` skips an id the sheet does not have.
       *
       * A CLASS CHANGE CARRIES THEM TOO, deliberately. Every locked tree is a
       * `generic/` one — bought with a currency that has nothing to do with the
       * class — so taking them away on a class change would be confiscating a
       * point the player spent on something the new class can use just as well.
       */
      const body = realms.realmOf(actorId)?.world.getActor(actorId) ?? world.getActor(actorId);
      const owned = body !== undefined && isPlayer(body) ? body : undefined;
      const previous = talentEngine.sheetOf(actorId);
      const sheet = sheetForBody(definition, owned);
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
    raiseTalentPoint: (
      actorId: string,
      talentId: string,
    ): number | { readonly refused: string } | null => {
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
      /**
       * REFUSED CARRIES ITS OWN SENTENCE.
       *
       * This returned `null` under a comment claiming "the gateway turns it
       * into a sentence". It did not: `null` also means "no talent engine" and
       * "not on this sheet", so the gateway answered `ErrorCode.Internal` and
       * told a player who was two points of Willpower short that talent points
       * were not wired into the build.
       *
       * `tierRefusalText` is the same function the PANEL uses, which is the
       * whole point — shared/tiers.ts keeps them one sentence so the greyed `+`
       * and the refusal cannot disagree.
       */
      // `?? ` NEVER FIRES: `tierRefusalText` answers null only for a PASSING
      // check, and this branch is the failing one. The fallback is here because
      // the compiler cannot see that and a thrown assertion would be a worse
      // answer to a player than a plain sentence.
      if (!gate.ok) return { refused: tierRefusalText(gate) ?? 'Not yet.' };
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
     * AND THE SAME POINT BACK OUT — `Actor:unlearnTalent`, ONE RANK.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * The mirror of `raiseTalentPoint`, and deliberately a much shorter
     * function, because THE LADDER IS NOT RE-CHECKED ON THE WAY DOWN. A tier
     * gate answers "may this body reach rank N"; a body going from 3 to 2 is
     * not reaching for anything, and asking would refuse a refund to exactly
     * the player who most needs one — somebody who bought a rank and then took
     * off the coat whose Willpower qualified them for it. Upstream does not ask
     * either: `LevelupDialog.lua:399` calls `unlearnTalent` outright and only
     * re-checks `canLearnTalent` afterwards to decide whether to put it BACK.
     *
     * ═══ IT WILL NOT TAKE A RANK BELOW ONE ═══
     * A talent at rank 0 is one the class owns and has not bought; rank 1 is
     * the cheapest thing a player can hold. Refusing at the floor is what keeps
     * "known" a real predicate — `treeKnown` above counts `rank >= 1`, so a
     * talent refunded to 0 correctly stops satisfying anybody's depth
     * requirement, and stepping below 0 would make that count nonsense.
     *
     * BIRTH TALENTS ARE NOT PROTECTED HERE, and they do not need to be: they
     * were never SPENT, so they are not in the ledger the gateway checks
     * against, and the gateway refuses anything the ledger does not name.
     *
     * @returns the NEW raw level, or null when there is no sheet, no such
     *   talent on it, or nothing left to take back. Re-derived from the sheet
     *   rather than echoing an argument, exactly as the raise half is.
     */
    lowerTalentPoint: (actorId: string, talentId: string): number | null => {
      const sheet = talentEngine.sheetOf(actorId);
      if (sheet === undefined) return null;
      const current = sheet.points.get(talentId);
      if (current === undefined || current < 1) return null;
      const next = current - 1;
      sheet.points.set(talentId, next);
      // AND IF THAT WAS A PASSIVE, IT IS NOW WORTH LESS. The same unconditional
      // call the raise half makes, for the same reason — and this direction is
      // the one that would leave a player permanently holding the benefit of a
      // refunded rank if it were forgotten.
      refreshPassives(actorId);
      return next;
    },

    /**
     * THE PUBLIC NAME FOR `refreshPassives`, and the only reason it is a seam:
     * spending Constitution changes a hit-point ceiling that net/** cannot
     * compute for itself. See `TurnEngine.refreshBody` for the whole argument.
     *
     * A ONE-LINE FORWARD ON PURPOSE. The instant this grows a second statement
     * there are two answers to "how big is this body" and they will disagree.
     */
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * BUY A LOCKED DISCIPLINE — the write half. See `TurnEngine.unlockTree`.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * THE BODY'S LIST IS THE AUTHORITY AND THE SHEET IS DERIVED FROM IT. The
     * sheet is rebuilt from scratch on reconnect and on class change, so a
     * discipline recorded only on the sheet would be lost the first time
     * somebody closed the tab — three levels of progress, silently.
     *
     * SO BOTH ARE WRITTEN, IN THAT ORDER: the list first, because
     * `sheetForClass` reads it, and then a fresh sheet built from it. Appending
     * to the live sheet instead would work today and diverge the first time
     * `sheetForClass` learned to do anything else with the list.
     *
     * THE POINTS SURVIVE THE REBUILD. `applyTalentPoints` is what puts a saved
     * spread back, and a rebuild here without it would reset every rank the
     * character had bought — so the ranks are read off the OLD sheet and written
     * onto the new one before it is attached.
     */
    unlockTree: (actorId: string, treeId: string): boolean => {
      const body = realms.realmOf(actorId)?.world.getActor(actorId) ?? world.getActor(actorId);
      if (body === undefined || !isPlayer(body) || body.classId === undefined) return false;
      const definition = classById(body.classId);
      if (definition === undefined) return false;

      const tree = treeById(treeId);
      // NOT A TREE, NOT LOCKED, OR ALREADY BOUGHT — three different mistakes
      // with one answer, because the caller's job in every case is to refuse
      // without charging. The SENTENCE is the gateway's; this is the write.
      if (tree === undefined || tree.locked !== true) return false;
      const already = body.unlockedTrees ?? [];
      if (already.includes(treeId)) return false;

      const opened = [...already, treeId];
      body.unlockedTrees = opened;
      rebuildTalentSheet(actorId, definition, opened, body.deepenedTrees ?? []);
      return true;
    },

    /**
     * ═══════════════════════════════════════════════════════════════════════
     * SPEND A CATEGORY POINT ON A TREE YOU ALREADY KNOW — the other half of
     * LevelupDialog.lua:433-437.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * ```lua
     * self.actor.__increased_talent_types[tt] = (... or 0) + 1
     * self.actor:setTalentTypeMastery(tt, self.actor:getTalentTypeMastery(tt) + 0.2)
     * ```
     *
     * `unlockTree` above is the `if not knowTalentType` branch and this is the
     * `else`. They were one action upstream and are two methods here only
     * because the engine interface is a list of verbs; the GATEWAY still routes
     * one message to whichever applies, as the dialog does.
     *
     * ═══ WHAT COUNTS AS "KNOWN" ═══
     * A tree the class was born with, or a locked one already bought. Both are
     * exactly "appears in the sheet's own tree list", which is what
     * `sheetForClass` built — so the check is against the live sheet and not
     * against `unlockedTrees`, which knows only about the second kind.
     *
     * REFUSES A SECOND BUMP (`MASTERY_DEEPEN_LIMIT`), which is upstream's
     * *"You can only improve a category mastery once!"*, and refuses a tree the
     * body does not know, which upstream's dialog cannot even render.
     */
    deepenTree: (actorId: string, treeId: string): boolean => {
      const body = realms.realmOf(actorId)?.world.getActor(actorId) ?? world.getActor(actorId);
      if (body === undefined || !isPlayer(body) || body.classId === undefined) return false;
      const definition = classById(body.classId);
      if (definition === undefined) return false;
      if (treeById(treeId) === undefined) return false;

      // KNOWN, which is not the same question as UNLOCKED. A class's own trees
      // were never bought and are the commonest thing to want to deepen.
      if (!treesForClass(definition, body.unlockedTrees ?? []).has(treeId)) return false;

      const deepened = body.deepenedTrees ?? [];
      // :422 — "You can only improve a category mastery once!"
      if (deepened.filter((id) => id === treeId).length >= MASTERY_DEEPEN_LIMIT) return false;

      const next = [...deepened, treeId];
      body.deepenedTrees = next;
      rebuildTalentSheet(actorId, definition, body.unlockedTrees ?? [], next);
      return true;
    },

    refreshBody: (actorId: string): void => {
      refreshPassives(actorId);
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
     * ═══ THREE ANSWERS, AND THE THIRD ONE IS THE WHOLE POINT ═══
     *
     *   true / false  the stance went up or came down
     *   null          it IS a stance and it cannot go up — tell the player
     *   undefined     NOT A STANCE. The gateway must carry on to `submitTalent`.
     *
     * This used to return `null` for every refusal, and `toggleSustain` used one
     * reason for both "not a stance" and "not learned" — so every ACTIVE talent
     * in the game was answered by the stance seam with *"that stance cannot go
     * up"*, which the client renders as *"not your turn yet"*. Nothing could be
     * cast from the hotbar. See `SustainRefusal.NotASustain`.
     */
    toggleSustain: (actorId: string, talentId: string): boolean | null | undefined => {
      const sheet = talentEngine.sheetOf(actorId);
      if (sheet === undefined) return undefined;
      // ONE IMPLEMENTATION OF THE THREE ANSWERS, shared with the tests. See
      // `sustainAnswer` — writing this mapping inline is what broke every
      // active talent in the game.
      const result = toggleSustain(talentEngine, sheet, talentId);
      const answer = sustainAnswer(result);
      if (answer === undefined || answer === null) return answer;
      // THE CONTRIBUTION IS THE POINT OF THE TOGGLE. Without this the stance is
      // a flag in a set and nothing on the body changes.
      refreshPassives(actorId);
      return answer;
    },

    /**
     * ═══════════════════════════════════════════════════════════════════════
     * WHAT THIS BODY HAS SPENT, SPLIT BY PURSE — the accurate ledger.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `spend_point` draws from `unspentGenerics` for a `generic/` tree and from
     * `unspentPoints` for everything else, and the restore path summed the WHOLE
     * spread against the class budget — so every rank bought with a generic
     * point was charged to the class purse on the next load, and the generic
     * purse itself was never reconstructed at all.
     *
     * ═══ HERE, BECAUSE THIS IS WHERE ALL THREE INPUTS MEET ═══
     * The partition needs the talent registry (for each id's tree), the class
     * definition (for which ids were granted at birth) and `isGenericTree`.
     * `persist/saves.ts` has none of them and says so — *"this layer cannot
     * import the talent registry … Giving the points back is the restore path's
     * job, and it has the registry to do it with"* — and the gateway has only
     * the seam. This file has all three.
     *
     * ═══ THE BIRTH GRANT DOES NOT SPLIT FOUR-AND-NOTHING ═══
     * One of the four (`talent:issued_kit`) sits in a generic tree, so the
     * class partition is owed three free ranks and the generic partition one.
     * Counted from the class definition rather than assumed, so a content
     * change that moves a birth talent between trees stays correct.
     */
    talentSpendOf: (actorId: string): { class: number; generic: number } | undefined => {
      const sheet = talentEngine.sheetOf(actorId);
      if (sheet === undefined) return undefined;
      // THE SHEET'S OWN `classId`, not the body's: `createTalentSheet` stamps it,
      // so the class is reachable from the one object already in hand.
      return spendByPurse(
        sheet,
        classById(sheet.classId),
        (id) => talentEngine.registry.get(id)?.tree,
      );
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
        /**
         * CLAMPED RATHER THAN REFUSED. A hand-edited `"crude_blow": 9999` is a
         * file problem, not a reason somebody cannot play tonight — the same
         * repair-never-reject doctrine `parseCharacterFile` applies upstream.
         *
         * ═══ THE FLOOR IS 0, AND IT WAS 1 FOR ONE COMMIT TOO LONG ═══
         * 1 was correct while a class was born knowing all eighteen of its
         * talents: rank 0 could not occur, so a 0 in a save file could only be
         * corruption and rounding it up was the repair. Birth grants made 0 the
         * ordinary state of most of a sheet — and this line, unchanged, would
         * have re-granted every unlearned talent at rank 1 on the next
         * reconnect. Silently, to everyone, undoing the entire change for
         * anybody who had ever saved and come back.
         *
         * A constant whose domain moved under it, which is [M-010] exactly.
         */
        sheet.points.set(talentId, Math.max(0, Math.min(TALENT_MAX_LEVEL, Math.floor(raw))));
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
    tideMs: TIDE_MS_OVERRIDE,
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
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE DEPLOYED SERVER IS NOT A DEV BUILD, AND NOW IT KNOWS.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `handleHello` admits an unverified socket as an anonymous player so a
     * build with no Discord app stays playable. Publicly reachable, that handed
     * a body to anyone who typed the URL — the allowlist never saw them, because
     * it gates who may obtain a SESSION and they never asked for one.
     *
     * `isConfigured` is both halves of the OAuth credential being present, which
     * is exactly the line between the two situations: a dev `.env` without them
     * behaves as it always has, and the deployed one refuses.
     */
    requireIdentity: isConfigured(authConfig),
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
