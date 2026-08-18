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

import { makeArena } from '../../shared/arena.ts';
import { SiteShape, makeSiteMap } from '../../shared/sitemap.ts';
import { makeOverworld } from '../../shared/level.ts';
import { ActorKind } from '../../shared/protocol.ts';
import { DELVES, populateDelve } from '../content/delve.ts';
import { seedAmbush } from '../content/encounter.ts';
import { createWorld } from './world.ts';
import type { TileXY } from '../../shared/coords.ts';
import type { AuthoredMap } from '../../shared/level.ts';
import type { ReapingTurnEngine } from '../turn-engine.ts';
import type { World } from './world.ts';
import type { PartyStrength } from './strength.ts';

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

/**
 * One roaming danger on the overworld. Deliberately tiny: a position, a name to
 * show, and nothing that could make it a combatant.
 */
export type Roamer = {
  readonly id: string;
  x: number;
  y: number;
  /** What a player is told they walked into. */
  readonly name: string;
  /**
   * WHAT IT LOOKS LIKE, and it is a CREATURE, not a marker.
   *
   * The first version drew roamers with `tile_ow_site_breach` — a site marker,
   * "a tear in the air" — because they ride on the same list as the towns. It
   * reads as a door, which is what it was drawn to be, and reported from play
   * as "the enemies do not seem to have enemy assets".
   *
   * A thing you are meant to recognise as dangerous and decide about should
   * look like the thing it will turn into. So a roamer wears one of the ambush
   * roster's own sprites and is drawn as a token with a hostile ring, exactly
   * as the creature itself will be one screen later.
   */
  readonly sprite: string;
};

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ONE SHELF ENTRY. NOT A BARE ID, AND THE DIFFERENCE IS LOAD-BEARING.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `restock` states the rule its own way: "NOT A SET BY ID. Two Reinforced
 * coats at different powers are different strings already; two at the SAME
 * power are genuinely the same item, and a shelf holding two of them is a shop,
 * not a bug." Stock is therefore a LIST WITH LEGAL DUPLICATES.
 *
 * Which is why `playerSold` is a flag on the SLOT and not membership of a
 * `Set<string>` of sold ids. A set cannot tell a coat the player sold in from
 * an identical coat the shop rolled itself — so clearing sold goods at restock
 * would silently delete the shop's own copy, and the symptom would be stock
 * quietly thinning over an evening for no reason anybody could reconstruct.
 */
export type ShopSlot = {
  readonly id: string;
  /**
   * Sold to the shop by a player, rather than generated by it.
   *
   * `Store.lua:171-178` flags exactly this at sale time, and `loadup` removes
   * only what carries the flag (`__force_store_forget`) while
   * `empty_before_restock = false` lets everything else accumulate. Two lines
   * that stop the shop becoming a free storage chest and stop a sell-then-rebuy
   * loop persisting junk, while letting a player who skipped something at level
   * 9 still find it at 40.
   */
  readonly playerSold: boolean;
};

/** A shop's whole mutable state. Two integers' worth of meaning and a list. */
export type ShopState = {
  /**
   * The last restock batch this shop has caught up to. STARTS AT -1 so that
   * epoch 0 is a real batch that has not happened yet — `epochFor` returns 0
   * for every party below level 5, and a shop that began at 0 would have empty
   * shelves until somebody hit level 5.
   */
  epoch: number;
  stock: ShopSlot[];
};

/**
 * WHICH TOWNS HAVE A SHOP. One, for now.
 *
 * A `Set` READ IN `build` rather than a sixth column on the thirteen `SITES`
 * rows: that would be thirteen rows of churn, twelve of them `false`, to carry
 * one boolean about one place. When a second shop lands it is one string here.
 *
 * Threadneedle Row rather than Alderbrook, because Alderbrook is the hub
 * everybody passes through and a merchant row is somewhere you go ON PURPOSE —
 * which is the difference between a shop being a destination and a shop being
 * a tollbooth.
 */
const SHOP_SITES: ReadonlySet<string> = new Set<string>(['site:threadneedle_row']);

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
   * ═══════════════════════════════════════════════════════════════════════════
   * ROAMERS — VISIBLE DANGER ON THE OVERWORLD, WITHOUT PUTTING A HOSTILE ON IT
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Reported from play, repeatedly: "we still do not see enemies in the
   * overworld". The honest answer was that ToME does not have any either — and
   * the honest answer was not the useful one. Danger you cannot see is danger
   * you cannot make a decision about, so the overworld had no gameplay in it:
   * you walked, and sometimes a fight happened at you.
   *
   * A ROAMER IS NOT AN ACTOR, and that is the whole trick. It has no hp, no
   * turn, no AI and no place in `world.actors`, so `engagement` on the shared
   * overworld stays exactly zero and the barrier stays disarmed — which is the
   * invariant every other decision in this file was arranged around
   * (`assertNoCombatInSharedSpace`, `RealmKind`). It is a MARKER that moves.
   *
   * Walk onto one and it pulls you into an ambush arena and is consumed. So the
   * player gets what a visible enemy is FOR: see it, judge it, go around it or
   * go at it. The fight still happens somewhere private, which is what keeps six
   * unrelated people able to share a map.
   *
   * Keyed by id rather than by cell because it moves and because two must never
   * silently merge. Mutable, and only ever on the overworld.
   */
  readonly roamers: Map<string, Roamer>;
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE SHOP, ON THE FIVE REALMS THAT HAVE ONE. `undefined` EVERYWHERE ELSE.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * A SHARED REALM AND NOTHING ELSE, and that is a correctness argument rather
   * than a design one: `close` refuses a shared realm outright and `empty()`
   * only ever returns Inner ones, so a Common realm is built once at boot and
   * lives for the process. A shop on an Inner realm would have its shelves
   * destroyed with the realm the moment the last body left it — `realms.delete`
   * drops the whole object — and the next party through that door would find a
   * different shop wearing the same name.
   *
   * Mutable container behind a `readonly` binding, the same shape as `roamers`
   * above and for the same reason: the realm's identity never changes, its
   * contents do.
   */
  readonly shop: ShopState | undefined;
  /**
   * Where a body is placed on arrival — AND, inside a site, the way out.
   *
   * The tile you came in on is the door you leave by, which needs no new art,
   * no new glyph and no second authored map. It works because arrival is not a
   * MOVE: `crossIntoSite` runs from `handleMove` only, so being placed here
   * cannot immediately eject you, and stepping back on later can.
   */
  readonly spawns: readonly TileXY[];
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
  /** Copied from the site. See `SiteDef.lingerMs`. */
  readonly lingerMs: number;
  /**
   * ONE-WAY. Set when a body leaves a realm that must not be re-entered, which
   * today means exactly the roaming encounter.
   *
   * `open` skips a sealed realm, so a party that flees a breach and is ambushed
   * again gets a NEW breach rather than walking back into the one they ran from
   * — with its hp, its cooldowns and its half-killed monsters exactly as they
   * left them. Without this, "run away" and "pause the fight" would be the same
   * verb.
   *
   * Mutable, deliberately: it is the one fact about a realm that changes after
   * construction, and hiding that behind a rebuild would mean re-keying every
   * side table that points at the realm's id.
   */
  sealed: boolean;
};

/**
 * How long a delve's instance outlives its last occupant.
 *
 * Five minutes is long enough to cover the reason people actually leave — a
 * quick trip back to town, somebody answering their door — and short enough
 * that a server left running overnight is not holding a dozen abandoned floors.
 * It is a wall-clock number and therefore lives with the gateway's other one
 * (the Bell); this constant only says what the policy is.
 */
export const INSTANCE_LINGER_MS = 5 * 60_000;

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
   * Which marker art draws this place on the overworld — `town`, `gate`,
   * `stair`, `altar`, `archive`. An ART FAMILY rather than a per-site sprite:
   * five settlements sharing one town marker is correct, and a new site needs
   * no new asset.
   */
  readonly marker: string;
  /**
   * SHARED, or PRIVATE TO A PARTY. The single most consequential field on a
   * site, and it is not a matter of taste — see the essay on `RealmKind`.
   * `Common` requires that nothing ever spawns here.
   */
  readonly kind: typeof RealmKind.Common | typeof RealmKind.Inner;
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * HOW LONG AN EMPTIED INSTANCE WAITS BEFORE IT IS REAPED. 0 = immediately.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * The distinction this field exists to draw: an ENCOUNTER is an event you can
   * flee, and a DELVE is a place you can go back to.
   *
   * A delve lingers, because the ordinary reason a floor empties is that
   * somebody stepped out for a moment — to sell, to regroup, to answer the door
   * — and coming back to a re-rolled floor with your loot swept off it would
   * make leaving something you never dare do. `INSTANCE_LINGER_MS`.
   *
   * An ambush does not, because fleeing has to MEAN something. If the breach
   * you ran out of were still there thirty seconds later, running would be a
   * way to save-scum a fight rather than a decision with a cost. 0.
   *
   * THE TIMER RESTARTS FROM ZERO ON RE-ENTRY, never from when it was armed:
   * walking back in cancels the reap outright, and the countdown only begins
   * again when the last body leaves again. So a party that keeps returning keeps
   * its floor indefinitely, which is the correct reading of "in case someone
   * wants to come back".
   */
  readonly lingerMs: number;
  /**
   * Builds a fresh map.
   *
   * TAKES THE REALM'S SEED so a site may GENERATE rather than merely copy. An
   * authored site ignores it and hands back the same floor every time; the
   * ambush arena uses it, which is what makes two parties ambushed at the same
   * moment get two different rooms, and the same party re-entering its own
   * realm get the same room back.
   */
  readonly map: (seed: string) => AuthoredMap;
  /**
   * Seeds the population. Called once, after the world exists.
   *
   * MUST BE ABSENT ON A `Common` SITE. Enforced at construction rather than
   * documented, because the failure is silent: a town with one monster in it
   * arms engagement for every unrelated person standing in it, and they all
   * start waiting on each other's turns with no way to discover why.
   */
  readonly populate?: (world: World, map: AuthoredMap, party: PartyStrength) => void;
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
  open(site: SiteDef, partyId: string, party?: PartyStrength): Realm;
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
    extra: { readonly partyId?: string; readonly siteId?: string; readonly lingerMs?: number },
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
      spawns: map.spawns,
      roamers: new Map<string, Roamer>(),
      // IN `build` AND NOT IN THE BOOT LOOP. There are TWO call sites — the
      // eager pass that opens every shared realm at startup, and `open`, which
      // builds a Common realm lazily if it was never opened. A shop wired into
      // only the first would leave a town with no shelves on the second path,
      // and the only thing that would notice is a test supplying its own sites.
      shop: SHOP_SITES.has(extra.siteId ?? '') ? { epoch: -1, stock: [] as ShopSlot[] } : undefined,
      // A shared space is never reaped, so its linger is meaningless; 0 is the
      // honest value rather than a large number pretending to be a policy.
      lingerMs: extra.lingerMs ?? 0,
      sealed: false,
      ...extra,
    };
    realms.set(id, realm);
    return realm;
  };

  const overworldMap = makeOverworld();
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE REGION IS NOT THE CITY, AND IT USED TO SHARE ITS NAME.
   * ═══════════════════════════════════════════════════════════════════════════
   * Both were called Alderbrook. Driving a first session is what made that
   * indefensible: a player spawns at the CITY's gate and is told, by the
   * arrival line, that they are in "Alderbrook" — while the marker under their
   * feet, the one they can walk into, is also "Alderbrook". Two different
   * places, one word, three seconds into a first session.
   *
   * ToME keeps them apart for the same reason: the world map is Maj'Eyal and
   * the town you are standing outside is Derth.
   */
  const overworld = build(
    OVERWORLD_ID,
    RealmKind.Overworld,
    'The Alderbrook Moor',
    overworldMap,
    {},
  );

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
    const realm = build(
      `realm:${site.id}`,
      RealmKind.Common,
      site.name,
      site.map(`realm:${site.id}`),
      {
        siteId: site.id,
      },
    );
    commonBySite.set(site.id, realm);
  }

  const realmOf = (actorId: string): Realm | undefined => {
    for (const realm of realms.values()) {
      if (realm.world.getActor(actorId) !== undefined) return realm;
    }
    return undefined;
  };

  const open = (
    site: SiteDef,
    partyId: string,
    /**
     * HOW STRONG THE PARTY WALKING IN IS, so a room can be built for them.
     *
     * DEFAULTED, and the default is the weakest possible party: a caller that
     * does not know — a test, a fixture, a build with no party table — gets the
     * gentlest room rather than the whole bestiary. Getting this wrong in the
     * other direction is what killed a stranger twenty seconds into their first
     * session.
     */
    party: PartyStrength = { level: 1, size: 1 },
  ): Realm => {
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
      const built = build(
        `realm:${site.id}`,
        RealmKind.Common,
        site.name,
        site.map(`realm:${site.id}`),
        {
          siteId: site.id,
        },
      );
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
      // A SEALED REALM IS NOT A CANDIDATE. Without this, a party that fled a
      // breach and was ambushed again would be handed the breach they ran from,
      // monsters and all, which makes running away and pausing the fight the
      // same verb. See `Realm.sealed`.
      if (realm.sealed) continue;
      if (realm.partyId === partyId && realm.siteId === site.id) return realm;
    }

    instanceSeq += 1;
    const id = `realm:${site.id}:${String(instanceSeq)}`;
    const builtMap = site.map(seedFor(opts.seed, id));
    const realm = build(id, RealmKind.Inner, site.name, builtMap, {
      partyId,
      siteId: site.id,
      lingerMs: site.lingerMs,
    });
    site.populate?.(realm.world, builtMap, party);
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
 * The sites the region opens onto, and whether each is a place or a delve.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * FOUR OPEN, FIVE CLOSED, AND THE SPLIT IS THE CIVILISED / UNCIVILISED LINE
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
      // ─── open to everybody: no combat, so nothing to coordinate. These are
      // the SETTLEMENTS, and with the overworld now being open country they are
      // where the game is social — the road between them is meant to feel empty.
      //
      ['site:alderbrook', 'Alderbrook', RealmKind.Common, 'city', SiteShape.Town],
      ['site:threadneedle_row', 'Threadneedle Row', RealmKind.Common, 'town', SiteShape.Town],
      ['site:ashwick_row', 'Ashwick Alchemy Row', RealmKind.Common, 'town', SiteShape.Town],
      ['site:wayfarers_camp', "A Wayfarers' Camp", RealmKind.Common, 'village', SiteShape.Ruin],
      ['site:saints_rest', "Saint's Rest", RealmKind.Common, 'town', SiteShape.Town],
      // ─── one party at a time: combat, so a shared barrier would be wrong ───
      ['site:blackwood_outskirts', 'Blackwood Outskirts', RealmKind.Inner, 'gate', SiteShape.Cave],
      ['site:gearford_ward', 'Gearford Industrial Ward', RealmKind.Inner, 'gate', SiteShape.Works],
      ['site:underworks', 'The Underworks', RealmKind.Inner, 'mine', SiteShape.Cave],
      ['site:glass_archive', 'The Glass Archive', RealmKind.Inner, 'city', SiteShape.Works],
      ['site:watchers_altar', "The Watcher's Altar", RealmKind.Inner, 'ruin', SiteShape.Ruin],
      ['site:hollow_mine', 'The Hollow Mine', RealmKind.Inner, 'mine', SiteShape.Cave],
      ['site:drowned_chapel', 'The Drowned Chapel', RealmKind.Inner, 'ruin', SiteShape.Ruin],
      ['site:outer_index', 'The Outer Index', RealmKind.Inner, 'city', SiteShape.Works],
    ] as const
  ).map(([id, name, kind, marker, shape]): [string, SiteDef] => [
    id,
    {
      id,
      name,
      kind,
      marker,
      /**
       * THE SHAPE IS THE IDENTITY at this scale. Every site used to open onto
       * the same authored 30x30 room, which made thirteen destinations one
       * destination with thirteen doors. A mine of winding galleries and a
       * market that is an open plaza read as different PLACES before a single
       * sprite is drawn. See shared/sitemap.ts.
       *
       * STATIC FOR A TOWN, FRESH FOR A DELVE, and the seed is what decides
       * which: a Common realm is built once with an id derived from the SITE,
       * so its streets are the same every time and a player can learn them. An
       * Inner realm's id carries a monotonic instance number, so every opening
       * is a different floor — and after the five-minute linger reaps it, the
       * next party through the door gets somewhere new.
       */
      map: (seed) => makeSiteMap(seed, shape),
      // A delve is a place you can go back to. A town never empties in the sense
      // that matters — `close` refuses a shared realm outright — so the number
      // is inert there and stated once rather than branched on.
      lingerMs: INSTANCE_LINGER_MS,
      /**
       * ═══════════════════════════════════════════════════════════════════
       * AND SOMETHING IS IN THERE. FOR THE FIRST TIME.
       * ═══════════════════════════════════════════════════════════════════
       * Every one of the eight delves generated EMPTY — a player walked
       * thirty tiles to "The Hollow Mine", read a line about paperwork, and
       * found nothing at all. content/delve.ts carries the eight specs and
       * argues the shape; this is only the wiring.
       *
       * ABSENT ON A COMMON SITE, which `createRealms` enforces at
       * construction rather than trusting: one monster in a town arms
       * engagement for every unrelated person standing in it, and they all
       * start waiting on each other with nothing on screen to explain why.
       * `DELVES` has no entry for a town, so the lookup returns undefined
       * and the field stays absent — the rule is expressed as data.
       */
      ...(DELVES.has(id)
        ? {
            populate: (world: World, built: AuthoredMap): void => {
              const spec = DELVES.get(id);
              if (spec !== undefined) populateDelve(world, built, spec);
            },
          }
        : {}),
    },
  ]),
);

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE ROAMING ENCOUNTER — Alderbrook's danger, which is never ON Alderbrook
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ToME's world map has no monsters standing on it. Crossing the wilderness is
 * dangerous because a step can PULL YOU INTO a zone, not because something is
 * walking toward your token. This is that, and copying it is not deference —
 * it is the only shape that fits the rest of this design.
 *
 * A hostile standing on the overworld would lift `engagement` above zero, and
 * `isBlocking` would then return true for every player in the city, related or
 * not (barrier.ts:293-306; engagement is a fact about the WORLD, not a party).
 * Six friends walking to three different districts would start waiting on each
 * other, with a Bell running and nothing on screen explaining why. So the
 * overworld's no-hostiles rule is not a simplification that encounters have to
 * work around — encounters are what let the rule survive contact with danger.
 *
 * It is a `SiteDef` like any other and it is deliberately NOT in `SITES`: every
 * entry there is a cell somebody authored on the map, and this one is a roll.
 * Sharing the type means it crosses through exactly the same code path as a
 * doorway — same instancing, same party keying, same idempotence — so an
 * encounter cannot drift from a delve in how it behaves.
 */
export const ENCOUNTER_SITE: SiteDef = {
  id: 'site:encounter',
  name: 'An Index Breach',
  kind: RealmKind.Inner,
  marker: 'breach',
  /**
   * GENERATED PER AMBUSH, not one shared floor. See shared/arena.ts: an ambush
   * is somewhere you have never been and will never return to, so the same room
   * every time — entered at the same corner, with the exit two steps behind you
   * — was the wrong shape for it in every way.
   */
  map: (seed) => makeArena(seed),
  // ZERO, AND THIS IS THE FIELD THAT MAKES FLEEING MEAN SOMETHING. See
  // `SiteDef.lingerMs`: a breach you ran out of must not still be there.
  lingerMs: 0,
  populate: (world, map, party) => {
    // AROUND THE ARRIVAL TILE, not at the authored coordinates. seedAmbush
    // explains why: the authored encounter is placed for a floor you EXPLORE,
    // and reusing it for an ambush drops the player in a corner with the
    // nearest monster nineteen tiles away -- off screen at this game's
    // viewport, which read in play as "the encounter has no enemies".
    const arrival = map.spawns[0] ?? {
      x: Math.floor(map.view.w / 2),
      y: Math.floor(map.view.h / 2),
    };
    seedAmbush(world, arrival, party);
  },
};
