/**
 * ═══════════════════════════════════════════════════════════════════════════
 * REALMS — MORE THAN ONE PLACE TO BE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Until now the process held exactly one `World`, and every map-shaped fact in
 * the server was an unqualified fact about it: `world.turn.engagement` was "is
 * there a fight", `world.actorAt(x, y)` was "who is standing there",
 * `resetFloor` was "wipe the floor". None of those questions have a single
 * answer once Alderbrook and an instanced inner-world both exist.
 *
 * A realm is one map and everything that happens on it: a `World`, its own turn
 * engine, its own barrier, its own clock, its own actors, projectiles and floor
 * items. Two kinds:
 *
 *   OVERWORLD — Alderbrook. Exactly one, created at boot, never closed.
 *               Everybody starts here and returns here. NO HOSTILES, EVER.
 *   INNER     — what is behind a place. One per party per site, created when a
 *               party walks into a site and closed when the last body leaves.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY SEPARATE WORLDS RATHER THAN A LEVEL KEY ON EVERY ACTOR
 * ═══════════════════════════════════════════════════════════════════════════
 * The obvious alternative is one World holding N levels, with a `levelId` on
 * each actor and a filter at every read. That design has to get roughly a dozen
 * filters right and stays wrong if it misses one, and the failure mode of each
 * miss is silent and cross-map:
 *
 *   `actorAt(12, 7)` — a body on the overworld blocks a step inside an instance
 *   `visibleEnemies` — a monster in an instance targets an overworld player
 *   `engagement`     — one scan over all actors, so one fight arms the barrier
 *                      for the entire process (scheduler.ts:3046-3076)
 *   `resetFloor`     — one party wiping reaps every monster everywhere
 *   `itemsAt`        — two players on (12,8) on two maps share one pile
 *
 * Separate `World` closures make every one of those correct by construction
 * rather than by vigilance: the overworld's `actorAt` cannot see an instance's
 * bodies because it is closed over a different Map. That is why this file is
 * small — it is a registry, not a filtering layer.
 *
 * The World is genuinely self-contained and that was checked rather than
 * assumed: `createWorld` returns a closure over its own `actors`, `projectiles`
 * and `ground` tables, and the entire `src/server/**` tree contains exactly one
 * module-level mutable binding. Nothing two worlds could share and corrupt.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT THIS FILE DELIBERATELY DOES NOT KNOW
 * ═══════════════════════════════════════════════════════════════════════════
 * It does not know about sockets, sessions, broadcast, parties, invites or
 * saves. It maps realm ids to worlds and nothing else. The gateway routes
 * frames; `engine/party.ts` owns who is playing with whom. Same split
 * `barrier.ts` makes with `PartyScope` and for the same reason: the layer that
 * arbitrates turns must not learn what an invite is.
 */

import { makeOverworld, makeTestMap } from '../../shared/level.ts';
import { ActorKind } from '../../shared/protocol.ts';
import { createTurnEngine } from '../turn-engine.ts';
import { createWorld } from './world.ts';
import type { AuthoredMap } from '../../shared/level.ts';
import type { ReapingTurnEngine, TurnEngineOptions } from '../turn-engine.ts';
import type { World } from './world.ts';

export const RealmKind = {
  /** Alderbrook. Shared by everybody, no hostiles, free-running movement. */
  Overworld: 'overworld',
  /** An instanced inner-world. One party, alone, with the monsters. */
  Inner: 'inner',
} as const;
export type RealmKind = (typeof RealmKind)[keyof typeof RealmKind];

/** The one realm id that is a constant, because there is only ever one. */
export const OVERWORLD_ID = 'realm:overworld';

export type Realm = {
  readonly id: string;
  readonly kind: RealmKind;
  /** What a player calls this place. Reaches the client; keep it prose. */
  readonly name: string;
  readonly world: World;
  readonly engine: ReapingTurnEngine;
  /**
   * Cells that open an inner-world, keyed `"x,y"` -> site id. Empty inside an
   * inner-world today: nesting a site inside an instance is a real design
   * question (does the party's instance stay open behind them?) and answering
   * it by accident is how a party ends up unable to get home.
   */
  readonly sites: ReadonlyMap<string, string>;
  /**
   * The party this instance belongs to, for `Inner` realms. Undefined on the
   * overworld, which belongs to everybody.
   *
   * THE ACCESS RULE LIVES HERE because it is the whole point of instancing:
   * you may only enter an inner-world whose `partyId` is yours.
   */
  readonly partyId?: string;
  /** Which site opened this realm. Undefined on the overworld. */
  readonly siteId?: string;
};

/**
 * A site: somewhere on the overworld you can walk into.
 *
 * Authored rather than generated, for the same reason the city is. The `map`
 * factory is called ONCE PER INSTANCE, so two parties in Threadneedle Row get
 * two independent copies of the same authored floor rather than one shared one.
 */
export type SiteDef = {
  readonly id: string;
  readonly name: string;
  /** Builds a fresh map for one instance. */
  readonly map: () => AuthoredMap;
  /** Seeds the population. Called once, after the world exists. */
  readonly populate?: (world: World) => void;
};

export type Realms = {
  /** Alderbrook. Always present, never closed. */
  readonly overworld: Realm;
  get(realmId: string): Realm | undefined;
  all(): readonly Realm[];
  /** Which realm holds this body, or undefined if it holds no body anywhere. */
  realmOf(actorId: string): Realm | undefined;
  /**
   * The instance this party has open at this site, creating it if there is
   * none. Idempotent on (partyId, siteId), which is what makes "walk in after
   * declining the prompt" join your friends rather than open a second copy.
   */
  open(site: SiteDef, partyId: string): Realm;
  /**
   * Close an instance and forget it. Refuses to close the overworld and refuses
   * to close a realm that still holds a body — a realm reaped out from under a
   * player would leave a socket rendering a map the server no longer has.
   */
  close(realmId: string): boolean;
  /** Every inner realm with no bodies left in it. The reaper's input. */
  empty(): readonly Realm[];
};

/**
 * Everything a realm's turn engine needs that is NOT the world.
 *
 * These are process-wide on purpose and each one is a considered decision
 * rather than an oversight:
 *
 *   `downed`   — a five-turn countdown must follow a body across a boundary.
 *                Two tables would be two answers to "how long has Sam got".
 *   `parties`  — a party is a social fact, not a map fact. It survives everyone
 *                walking into an instance, and it is what gates who may follow.
 *   `talents`  — the authored book. Immutable content.
 *   `barrier`  — DELIBERATELY NOT HERE. See below.
 */
export type RealmDeps = Omit<TurnEngineOptions, 'world' | 'barrier'>;

export type RealmsOptions = {
  /** Qualified per realm. See `seedFor`. */
  readonly seed: string;
  readonly deps: RealmDeps;
};

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ONE BARRIER PER REALM, AND IT IS NOT AN OVERSIGHT
 * ═══════════════════════════════════════════════════════════════════════════
 * `createTurnEngine` builds its own `Barrier` when none is passed, so every
 * realm here gets a fresh one. That is correct and the alternative is not:
 * a barrier keyed its level-wide countdown on `LEVEL_SCOPE = ''`
 * (barrier.ts:216), so two realms sharing one barrier would collide on that
 * key and each realm's Bell would restart the other's.
 *
 * THE COST, STATED HONESTLY: a barrier also holds per-actor bookkeeping —
 * consecutive auto-passes and the ten-minute reconnect grace (barrier.ts:406,
 * 424). Those are keyed by bare actor id and do NOT follow a body across a
 * realm boundary, so a player who has auto-passed twice on the overworld walks
 * into an instance with a clean record.
 *
 * That is the right trade and arguably the right behaviour outright: Standing
 * By means "this person has stopped answering on this floor", and walking
 * through a door is the loudest possible evidence that they have started again.
 * The reconnect grace is the one that could bite — a player who drops inside an
 * instance and reconnects gets a fresh record — but the recall path is driven
 * by the gateway's own `graceTimers`, not by the barrier's, so the ten minutes
 * are unaffected.
 */
function seedFor(root: string, realmId: string): string {
  // The seed string is the ONLY thing that distinguishes two worlds: the three
  // fork labels inside createWorld are hard-coded, so two realms built from the
  // same string roll identical dice in lockstep. See createWorld's header.
  return `${root}:${realmId}`;
}

export function createRealms(opts: RealmsOptions): Realms {
  const realms = new Map<string, Realm>();

  /**
   * Monotonic, never reused. Two parties can hold two instances of the same
   * site at once and their realm ids must differ — and an id must never be
   * recycled, because everything above this file (the save bindings, the
   * gateway's per-socket routing) keys on it and a reused id would silently
   * attach a new instance to an old socket's expectations.
   */
  let instanceSeq = 0;

  const build = (
    id: string,
    kind: RealmKind,
    name: string,
    map: AuthoredMap,
    extra: { readonly partyId?: string; readonly siteId?: string },
  ): Realm => {
    const world = createWorld(seedFor(opts.seed, id), map);
    const engine = createTurnEngine({ ...opts.deps, world });
    const realm: Realm = {
      id,
      kind,
      name,
      world,
      engine,
      sites: map.sites,
      ...extra,
    };
    realms.set(id, realm);
    return realm;
  };

  const overworldMap = makeOverworld();
  const overworld = build(OVERWORLD_ID, RealmKind.Overworld, 'Alderbrook', overworldMap, {});

  const realmOf = (actorId: string): Realm | undefined => {
    for (const realm of realms.values()) {
      if (realm.world.getActor(actorId) !== undefined) return realm;
    }
    return undefined;
  };

  const open = (site: SiteDef, partyId: string): Realm => {
    // IDEMPOTENT ON (partyId, siteId). This is what makes a declined follow
    // prompt recoverable: walking onto the site yourself later joins the
    // instance your party is already in rather than opening a second copy of
    // the same floor beside them.
    for (const realm of realms.values()) {
      if (realm.partyId === partyId && realm.siteId === site.id) return realm;
    }

    instanceSeq += 1;
    const id = `realm:${site.id}:${String(instanceSeq)}`;
    const realm = build(id, RealmKind.Inner, site.name, site.map(), {
      partyId,
      siteId: site.id,
    });
    site.populate?.(realm.world);
    return realm;
  };

  const close = (realmId: string): boolean => {
    if (realmId === OVERWORLD_ID) return false;
    const realm = realms.get(realmId);
    if (realm === undefined) return false;
    // A realm reaped out from under a body would leave that socket rendering a
    // map the server no longer holds, and every subsequent frame about it would
    // be silently dropped. Refuse, and let the caller notice.
    if (realm.world.allActors().some((a) => a.kind === ActorKind.Player)) return false;
    realms.delete(realmId);
    return true;
  };

  const empty = (): readonly Realm[] =>
    [...realms.values()].filter(
      (r) =>
        r.kind === RealmKind.Inner && !r.world.allActors().some((a) => a.kind === ActorKind.Player),
    );

  return {
    overworld,
    get: (realmId) => realms.get(realmId),
    all: () => [...realms.values()],
    realmOf,
    open,
    close,
    empty,
  };
}

/**
 * The sites Alderbrook opens onto.
 *
 * ALL EIGHT LEAD TO THE M1 TEST LEVEL TODAY, and that is deliberate rather than
 * unfinished. The floor behind a door is content; the door itself is plumbing,
 * and shipping the plumbing against one known-good floor is what makes a bad
 * transition debuggable — "the party ended up in the canal" cannot also be a
 * generation bug when there is no generator. Authored floors and the zone
 * generator both land on top of this table without changing it.
 */
export const SITES: ReadonlyMap<string, SiteDef> = new Map(
  (
    [
      ['site:office', "The Detective's Office"],
      ['site:threadneedle_row', 'Threadneedle Row'],
      ['site:ashwick_row', 'Ashwick Alchemy Row'],
      ['site:blackwood_outskirts', 'Blackwood Outskirts'],
      ['site:gearford_ward', 'Gearford Industrial Ward'],
      ['site:underworks', 'The Underworks'],
      ['site:glass_archive', 'The Glass Archive'],
      ['site:watchers_altar', "The Watcher's Altar"],
    ] as const
  ).map(([id, name]) => [id, { id, name, map: makeTestMap }]),
);
