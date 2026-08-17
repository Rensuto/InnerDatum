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
import { createWorld } from './world.ts';
import type { AuthoredMap } from '../../shared/level.ts';
import type { ReapingTurnEngine } from '../turn-engine.ts';
import type { World } from './world.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * SHARED OR INSTANCED IS DECIDED BY ONE THING: IS THERE COMBAT HERE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Not by size, not by whether it is indoors, not by how it is authored. The
 * rule is mechanical and it falls out of the barrier:
 *
 *   NO COMBAT → nothing to coordinate → engagement stays 0 → nobody ever blocks
 *   (barrier.ts:143-148, :304, :351) → any number of unrelated people can walk
 *   around each other at their own pace. So the space can be OPEN.
 *
 *   COMBAT → every player present is dragged into lockstep by engagement, which
 *   is a fact about the WORLD and not about a party. Open the space and N
 *   unrelated parties share one barrier — which is exactly the bug parties were
 *   introduced to fix: "a solo player waited on a stranger, and then on a
 *   stranger who had closed the tab" (barrier.ts:171-174). So the space MUST be
 *   instanced.
 *
 * That is why `assertNoCombatInSharedSpace` below is an assertion rather than a
 * comment. A shared space that acquires a monster does not degrade gracefully;
 * it silently recreates the worst multiplayer bug this project has had.
 */
export const RealmKind = {
  /** Alderbrook. One, shared by everybody, no hostiles, free-running. */
  Overworld: 'overworld',
  /**
   * A town: an interior or district you walk INTO from the overworld and which
   * stays open to everyone. The office, a market row. One realm per site,
   * shared by every party in it, and no hostiles — see the essay above.
   */
  Common: 'common',
  /** An instanced inner-world. One party, alone, with the monsters. */
  Inner: 'inner',
} as const;
export type RealmKind = (typeof RealmKind)[keyof typeof RealmKind];

/** Is this realm open to everybody, or private to one party? */
export function isShared(kind: RealmKind): boolean {
  return kind === RealmKind.Overworld || kind === RealmKind.Common;
}

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
 * Authored rather than generated, for the same reason the city is. For an
 * INSTANCED site the `map` factory is called once per instance, so two parties
 * in the Underworks get two independent copies of the same authored floor
 * rather than one shared one. For a COMMON site it is called exactly once, at
 * boot, because there is only ever one of that place.
 */
export type SiteDef = {
  readonly id: string;
  readonly name: string;
  /**
   * SHARED, or PRIVATE TO A PARTY. The single most consequential field on a
   * site, and it is not a matter of taste — see the essay on `RealmKind`.
   * `Common` requires that nothing ever spawns here.
   */
  readonly kind: typeof RealmKind.Common | typeof RealmKind.Inner;
  /** Builds a fresh map. */
  readonly map: () => AuthoredMap;
  /**
   * Seeds the population. Called once, after the world exists.
   *
   * MUST BE ABSENT ON A `Common` SITE. Enforced at construction rather than
   * documented, because the failure is silent: a town with one monster in it
   * arms engagement for every unrelated person standing in it, and they all
   * start waiting on each other's turns with no way to discover why.
   */
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
/**
 * Builds the turn engine for ONE realm's world.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * A FACTORY RATHER THAN A BAG OF SHARED DEPENDENCIES, AND THE REASON IS REAL
 * ═══════════════════════════════════════════════════════════════════════════
 * This was `deps: Omit<TurnEngineOptions, 'world' | 'barrier'>` — one object,
 * spread into every realm's engine. That cannot work, because two of the
 * dependencies are not shareable: `createTalentBook(talentEngine, world)` and
 * `talentRuntimeFor(talentEngine, world)` are both CLOSED OVER A WORLD. Handing
 * every realm the overworld's talent book would have every talent in every
 * instance resolve line-of-sight, targets and adjacency against Alderbrook —
 * silently, since the calls all succeed and simply answer about the wrong map.
 *
 * main.ts also wraps the engine (`gatewayEngine`) to add `attachClass` and the
 * three talent-point seams, because it is the one file that can see the talent
 * registry, the world and the gateway at once. A factory lets that wrapping
 * happen per realm without this file learning what a talent is.
 *
 * So realms.ts no longer constructs engines at all, and no longer imports
 * `createTurnEngine`. It is a registry; composing an engine is the entry
 * point's job, exactly as composing the gateway's is.
 */
export type EngineFor = (world: World) => ReapingTurnEngine;

export type RealmsOptions = {
  /** Qualified per realm. See `seedFor`. */
  readonly seed: string;
  readonly engineFor: EngineFor;
  /**
   * Everywhere the overworld can lead. Defaults to the authored `SITES`.
   *
   * A parameter so a test can build a two-site world without inheriting the
   * whole city, and so a common site's invariant can be tested by supplying a
   * deliberately broken one.
   */
  readonly sites?: ReadonlyMap<string, SiteDef>;
};

/**
 * A shared space may not spawn anything, and this throws rather than warns.
 *
 * The failure it prevents is silent and it is the worst one in the design. A
 * town with a single monster in it lifts `engagement` above zero; `isBlocking`
 * then returns true for EVERY player standing in that town, related or not
 * (barrier.ts:293-306, and engagement is explicitly a fact about the world
 * rather than about a party); and every one of them starts waiting on people
 * they never agreed to play with, with a Bell counting down and nothing on
 * screen that explains why. That is the exact bug parties were introduced to
 * fix, reintroduced through the back door by one line of content.
 *
 * Throwing at construction means it is caught at boot, by `npm run check`, on
 * the machine of whoever authored the site — not on a Friday night.
 */
function assertNoCombatInSharedSpace(site: SiteDef): void {
  if (site.kind === RealmKind.Common && site.populate !== undefined) {
    throw new Error(
      `realms: site '${site.id}' is Common but carries a populate() — a shared ` +
        `space cannot have hostiles. One monster in an open town puts every ` +
        `unrelated player in it into a single barrier. Make it Inner, or drop ` +
        `the population.`,
    );
  }
}

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
  const sites = opts.sites ?? SITES;

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
    const engine = opts.engineFor(world);
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

  /**
   * COMMON REALMS ARE BUILT AT BOOT, NOT ON FIRST ENTRY.
   *
   * There are a handful of them, they are small, and building them eagerly buys
   * three things a lazy path would have to earn back:
   *
   *   - `all()` is stable, so the pump loop is a fixed set rather than one that
   *     can grow underneath an iteration.
   *   - There is no first-entry race: two people stepping through the office
   *     door in the same millisecond cannot create two offices.
   *   - A town keeps its floor. Close-when-empty would sweep the items somebody
   *     dropped while they were walking back for them.
   */
  const commonBySite = new Map<string, Realm>();
  for (const site of sites.values()) {
    if (site.kind !== RealmKind.Common) continue;
    assertNoCombatInSharedSpace(site);
    const realm = build(`realm:${site.id}`, RealmKind.Common, site.name, site.map(), {
      siteId: site.id,
    });
    commonBySite.set(site.id, realm);
  }

  const realmOf = (actorId: string): Realm | undefined => {
    for (const realm of realms.values()) {
      if (realm.world.getActor(actorId) !== undefined) return realm;
    }
    return undefined;
  };

  const open = (site: SiteDef, partyId: string): Realm => {
    /**
     * A COMMON SITE IGNORES THE PARTY ENTIRELY. There is one office, and
     * everybody who walks through the door is in it — which is the whole point
     * of a common space and the reason `partyId` is accepted and dropped here
     * rather than being absent from the signature: the caller should not have
     * to know which kind of place it is asking about in order to ask.
     */
    if (site.kind === RealmKind.Common) {
      const shared = commonBySite.get(site.id);
      if (shared !== undefined) return shared;
      // A common site that was not built at boot means the SITES table and this
      // registry disagree, which is a wiring bug rather than a runtime state.
      assertNoCombatInSharedSpace(site);
      const built = build(`realm:${site.id}`, RealmKind.Common, site.name, site.map(), {
        siteId: site.id,
      });
      commonBySite.set(site.id, built);
      return built;
    }

    // IDEMPOTENT ON (partyId, siteId), and this is the rule stated plainly:
    // two different parties entering the SAME site get two different instances,
    // and the same party entering twice gets the one it already has. That
    // second half is what makes a declined follow prompt recoverable — walking
    // onto the site yourself later joins your friends rather than opening a
    // private second copy of the floor beside them.
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
    const realm = realms.get(realmId);
    if (realm === undefined) return false;
    // A SHARED SPACE IS NEVER CLOSED, empty or not. It is a place rather than a
    // session: somebody walking back for the coat they dropped in the office
    // must find it there, and an office that is torn down the moment the last
    // person leaves would also be a different office every time two people
    // arrive from opposite directions.
    if (isShared(realm.kind)) return false;
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
 * The sites Alderbrook opens onto, and whether each is a place or a delve.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THREE OPEN, FIVE CLOSED, AND THE SPLIT IS THE CIVILISED / UNCIVILISED LINE
 * ═══════════════════════════════════════════════════════════════════════════
 * The rule from `RealmKind` decides every row mechanically — is there combat
 * here — and the fiction happens to agree with it exactly, which is a good sign
 * rather than a coincidence. The parts of Alderbrook that still work as a city
 * are open: you meet people there. The parts the Index has got into are not.
 *
 * `game-design.md` § 5 already lists the Detective's Office as the hub with a
 * dash in the enemies column; that dash is now load-bearing.
 *
 * EVERY MAP IS THE M1 TEST LEVEL TODAY, and that is deliberate rather than
 * unfinished. The floor behind a door is content; the door itself is plumbing,
 * and shipping the plumbing against one known-good floor is what makes a bad
 * transition debuggable — "the party ended up in the canal" cannot also be a
 * generation bug when there is no generator. Authored floors and the zone
 * generator both land on top of this table without changing its shape.
 *
 * The consequence worth stating out loud: the common maps are the test level
 * MINUS its population, because `populate` is absent, and that is exactly what
 * a town is for now — an empty room you can stand in with other people.
 */
export const SITES: ReadonlyMap<string, SiteDef> = new Map(
  (
    [
      // ─── open to everybody: no combat, so nothing to coordinate ───
      ['site:office', "The Detective's Office", RealmKind.Common],
      ['site:threadneedle_row', 'Threadneedle Row', RealmKind.Common],
      ['site:ashwick_row', 'Ashwick Alchemy Row', RealmKind.Common],
      // ─── one party at a time: combat, so a shared barrier would be wrong ───
      ['site:blackwood_outskirts', 'Blackwood Outskirts', RealmKind.Inner],
      ['site:gearford_ward', 'Gearford Industrial Ward', RealmKind.Inner],
      ['site:underworks', 'The Underworks', RealmKind.Inner],
      ['site:glass_archive', 'The Glass Archive', RealmKind.Inner],
      ['site:watchers_altar', "The Watcher's Altar", RealmKind.Inner],
    ] as const
  ).map(([id, name, kind]) => [id, { id, name, kind, map: makeTestMap }]),
);
