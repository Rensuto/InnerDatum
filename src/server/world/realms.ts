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

import { arenaGround, makeArena } from '../../shared/arena.ts';
import { ShopShelf } from '../content/shops.ts';
import { applyZoneEffectsIn } from './zone-effects.ts';
import type { EffectState } from '../engine/effects.ts';
import { SiteShape, makeSiteMap } from '../../shared/sitemap.ts';
import type { SitePalette } from '../../shared/sitemap.ts';
import { ZONES, siteLighting, zoneFloor, zoneLevel } from '../../shared/mapgen/zones.ts';
import type { SiteLighting } from '../../shared/light.ts';
import type { Ground } from '../../shared/level.ts';
import { TileCode } from '../../shared/protocol.ts';
import {
  BIRTHPLACE_SITE_ID,
  INFINITY_TOWER_SITE_ID,
  REDACTION_SITE_ID,
  makeOverworld,
  parseMap,
} from '../../shared/level.ts';
// THE TOWER'S FLOORS. `shared/mapgen/tower.ts` walks `alter_level_data`'s chain
// and builds one link of it; this file is the door onto it, as it is for a zone.
import { towerFloorAt, towerLevel } from '../../shared/mapgen/tower.ts';
import { towerEnemyCountPerArea } from '../../shared/mapgen/infinite.ts';
import type { Glyph } from '../../shared/level.ts';
import { UNDERMOST_LAST_FLOOR, populateUndermostHall } from '../content/undermost.ts';
import { makeRedaction } from '../../shared/redaction.ts';
import { ActorKind } from '../../shared/protocol.ts';
// `DELVES` IS GONE FROM THIS IMPORT, as it went from gateway.ts one commit
// earlier. The authored table's ids are all Alderbrook's, so the raw lookup was
// correct here — but `specFor` is the one that knows about both maps, and the
// import disappearing is the proof there is no reader left asking the narrower
// question.
import {
  DEEPER_FLOORS,
  PopulationScope,
  delveLevel,
  floorsOf,
  forArea,
  populateDelve,
  redactedSpec,
  specFor,
  stairsDownCell,
} from '../content/delve.ts';
import type { MonsterTemplate } from '../content/monsters.ts';
import { seedAmbush } from '../content/encounter.ts';
import { createWorld } from './world.ts';
import { briefsForSite } from '../content/briefs.ts';
// A LEAF, AND DELIBERATELY SO — `world/stairs.ts` states the cycle it breaks.
// Re-exported below, so no caller of this module had to change.
import { STAIRS_DOWN_SITE_ID } from './stairs.ts';
import { placeTownsfolk, townsfolkFor } from '../content/townsfolk.ts';
import { makeSettlementMap, placeTownProps } from '../content/towns.ts';
import type { TileXY } from '../../shared/coords.ts';
import type { AuthoredMap, Region } from '../../shared/level.ts';
import type { ReapingTurnEngine } from '../turn-engine.ts';
import type { World } from './world.ts';
import type { PartyStrength } from './strength.ts';
// TYPE-ONLY, AND THAT IS WHAT KEEPS THE TWO FILES ACYCLIC: `world/brief.ts`
// imports `stairsDownOf` from here at runtime, and this import erases.
import type { Brief, BriefSpec } from './brief.ts';

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

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * HOW OFTEN A SHARED REALM'S CLOCK TURNS OVER, IN WALL-CLOCK MILLISECONDS.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The one number behind the tide (net/gateway.ts). Every SHARED realm gets one
 * — `isShared` above is the gate — because the argument is about the realm being
 * open to people who are not in your party, not about the overworld in
 * particular: a town where one person is shopping and another is idle has the
 * same problem the moor did.
 *
 * ═══ IT IS PRICED AGAINST REGENERATION, WHICH IS WHAT IT DRIVES ═══
 * A tide advances exactly one GAME TURN, and a game turn is what pays out
 * `actBase`. So this number is really "how long is a turn when nobody is
 * acting", and the honest way to choose it is to read what a turn is worth:
 *
 *     hpRegen              0.5 / turn      ->  15 hp per minute
 *     RESOLVE_PER_TURN     0.6 / turn      ->  18 per minute
 *     INK_PER_TURN         0.6 / turn      ->  18 per minute
 *     FOCUS_PER_TURN       0.4 / turn      ->  12 per minute
 *     REAGENT_REGEN_EVERY_TURNS  1 per 12  ->  2.5 vials per minute
 *
 * At two seconds a turn that is a full hundred-point pool in five to eight
 * minutes of standing about, a full eight-vial bag in three, and a sixty-point
 * body healed in four. Long enough that resting is a decision and not a reflex;
 * short enough that a party regrouping in town is not reading a progress bar.
 *
 * ═══ AND AGAINST THE MOOR, WHICH IS THE OTHER READER ═══
 * `MOVE_EVERY_TURNS` is 3 (world/roamers.ts), so a roamer takes a step every six
 * seconds — the drift its own note asks for ("so they drift rather than chase")
 * and, critically, a rate that no longer depends on how many people are walking
 * or how fast they type.
 *
 * ═══ THE COST OF THE NUMBER BEING WRONG IS SMALL IN ONE DIRECTION ═══
 * Too slow is a town that feels dead and a bag that never refills. Too fast is a
 * server pumping realms nobody is looking at — bounded, because the tide does
 * not re-arm for an EMPTY realm, but real. Two seconds is the slow end of what
 * still feels alive, which is the side to err on.
 */
export const TIDE_MS = 2000;

/** The one realm id that is a constant, because there is only ever one. */
export const OVERWORLD_ID = 'realm:overworld';

/**
 * THE SITE ID A STAIR DOWN IS FILED UNDER, and the reader that finds it.
 *
 * DECLARED IN `world/stairs.ts` and re-exported here, so that every caller in
 * the tree keeps the import it has always had. The two of them moved out
 * because `world/brief.ts` needs the reader and this module reaches
 * `content/briefs.ts` for a site's authored objectives — see that file's header
 * for the cycle, and for what an ES module cycle does instead of failing.
 */
export { STAIRS_DOWN_SITE_ID, stairDownName, stairsDownOf } from './stairs.ts';

/**
 * A way out of a whole zone, to the map the party came in from. Upstream's
 * Escape from Reknor ends at a grid on its last level that leaves the zone
 * (data/maps/zones/reknor-escape-last.lua: `endx`, `endy`), rather than at a
 * stair back up through every level.
 */
export const EXIT_SITE_ID = 'exit:out';

/**
 * Where a new character wakes, and a cell on the overworld — see
 * `UNDERMOST_SITE`.
 *
 * THE SPELLING IS `shared/level.ts`'s, re-exported here rather than written
 * twice. Two `src/shared/` modules need it (the overworld legend, which puts
 * its mouth on the map, and `shared/redaction.ts`, which refuses to copy it)
 * and neither may import from `src/server/`, so the constant lives there and
 * the server's name for it points at the same string. This is exactly what
 * `redaction.ts` does with `REDACTION_SITE_ID`.
 */
export const UNDERMOST_SITE_ID = BIRTHPLACE_SITE_ID;

/**
 * The Infinity Tower's mouth, and a cell in the northern snow — see
 * `TOWER_SITE`. Re-exported from `shared/level.ts` for the reason
 * `UNDERMOST_SITE_ID` above is: the spelling has to live in `src/shared/`
 * because the overworld legend and `shared/redaction.ts` both need it, and this
 * is where the server looks.
 */
export { INFINITY_TOWER_SITE_ID };

/** How many floors a site has: a delve's own depth, and one for anything else. */
export function floorsOfSite(siteId: string): number {
  const spec = specFor(siteId);
  return spec === undefined ? 1 : floorsOf(spec);
}

/**
 * `map` with a stair down: where its generator put one (`AuthoredMap.down`, as
 * upstream's generators choose `default_down`), else on the furthest tile from
 * its door, when it has one.
 */
function withStairsDown(map: AuthoredMap): AuthoredMap {
  const at = map.down ?? stairsDownCell(map);
  if (at === undefined) return map;
  return {
    ...map,
    sites: new Map([...map.sites, [`${String(at.x)},${String(at.y)}`, STAIRS_DOWN_SITE_ID]]),
  };
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * HOW MANY FLOORS THE PARTY HOLDS AT ONCE IN A PLACE WITH NO BOTTOM.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `DEEPER_FLOORS` and not a number of its own: it is the depth of the deepest
 * zone in this game that HAS a bottom, which is the size of zone the hold below
 * was written for. An endless site therefore holds exactly as much as the
 * biggest place that could ever have exercised the rule, and no more.
 */
const ZONE_FLOORS_HELD = DEEPER_FLOORS;

/**
 * A delve floor and every other floor its party holds open at the same site:
 * upstream's zone, whose levels are kept together while the party is in it
 * (engine/Zone.lua:855-858).
 *
 * ONLY A SITE WITH FLOORS. Anything else is a zone of one, and that matters for
 * the ambush: a party can hold two breaches at once, and a breach left empty must
 * close whether or not the other one is occupied.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * AND IT IS A WINDOW, NOT THE WHOLE SITE, ONCE THE SITE HAS NO BOTTOM.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Both callers are the reap (`reapIfEmpty` arms every floor of the zone, and
 * the fire-time check refuses to close one while anybody of the party is on
 * another), so what this function returns IS how much is kept in memory.
 *
 * "Keep every floor while the party is in the zone" is upstream's
 * `persistent = "zone"` and it is right for a place three or four floors deep.
 * The Infinity Tower is a billion, and the rule read literally means KEEP
 * EVERYTHING, FOREVER — measured over a socket: 30 floors descended, 30 realms
 * live, 138,295 tiles held, nothing reaped, and the count rises for as long as
 * the party keeps going down. Every floor's five-minute linger was also pushed
 * out to five minutes after the LAST descent, so nothing would have closed even
 * on its own deadline.
 *
 * Past the window a floor keeps the ordinary linger it started when it emptied,
 * so it closes on its own five minutes rather than being held by a party forty
 * floors below. What that costs is the thing `TOWER_SITE`'s decision 2 already
 * states and accepts: climbing back up past the window rebuilds the floor —
 * the same KIND of place, a different room. Inside the window (a party split
 * across floors, a step back up for something dropped) nothing changes at all.
 *
 * EVERY SITE WITH A BOTTOM IS UNAFFECTED, and that falls out rather than being
 * granted: the deepest is `DEEPER_FLOORS` floors, so its whole zone is inside
 * a window of `DEEPER_FLOORS`.
 *
 * ═══ THE DEPTH GUARD IS A BELT AND IT SURVIVES MUTATION, DELIBERATELY ═══
 * Deleting `floorsOfSite(siteId) <= ZONE_FLOORS_HELD` changes no test, and it
 * is an EQUIVALENT mutant rather than a hole — measured over the whole input
 * space rather than argued: 28 Inner sites have a bottom, their depths are 3
 * and 4 and nothing else, so the widest gap between two floors of one is 3
 * against a window of 4. It is kept because it makes a bounded delve correct
 * INDEPENDENTLY of how wide the window is: narrow `ZONE_FLOORS_HELD` to 2 and
 * this line is the only thing standing between a four-floor delve and a party
 * on floor 4 losing floor 1 while they are still in it. The invariant it
 * protects is pinned by behaviour instead — `test/server/tower.test.ts` opens
 * every floor of the deepest delve that has a bottom and asserts the whole zone
 * comes back.
 */
export function zoneOf(realms: Realms, realm: Realm): readonly Realm[] {
  const { siteId, partyId } = realm;
  if (realm.kind !== RealmKind.Inner || siteId === undefined || partyId === undefined) {
    return [realm];
  }
  if (floorsOfSite(siteId) <= 1) return [realm];
  const zone = realms
    .all()
    .filter((r) => r.kind === RealmKind.Inner && r.partyId === partyId && r.siteId === siteId);
  if (floorsOfSite(siteId) <= ZONE_FLOORS_HELD) return zone;
  const here = realm.floor ?? 1;
  return zone.filter((r) => Math.abs((r.floor ?? 1) - here) <= ZONE_FLOORS_HELD);
}

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
   * ═══════════════════════════════════════════════════════════════════════════
   * AND WHAT IT ACTUALLY IS, WHICH IS THE FIELD THAT MAKES THE REST HONEST.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * The `name` and `sprite` below were chosen from a table that had no creature
   * behind it, so a marker showing a wrong shadow opened onto a room of husks.
   * The roamer now carries the template it depicts, `open()` forwards it, and
   * `ambushRoster` puts it in the room. See the essay on `ambushRoster`'s
   * `lead` parameter for what was broken and why it mattered.
   *
   * AN ID RATHER THAN THE TEMPLATE, because a `Realm` is state and a template
   * is content: roamers are rebuilt from a save, and a live object reference in
   * a persisted structure is the one shape that cannot survive one.
   */
  readonly templateId: string;
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
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * WHERE IT LIVES. The anchor a leash is measured from.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Ported from `Party.lua:68-69` — `ai_state.tactic_leash_anchor` and
   * `tactic_leash = 10`, described upstream as *"the maximum distance this
   * creature can go from the party master"*. A roamer has no master, so the
   * anchor is the tile it appeared on, and everything it does — the wander, the
   * chase, the walk back — is bounded by ten tiles of it.
   *
   * ═══ WHY AN ANCHOR AT ALL, WHEN THE OLD WALK WAS FREE ═══
   * An unbounded random walk over seventeen thousand cells has no memory, so the
   * moor had no PLACES in it: the danger you routed around yesterday is
   * somewhere else today, and there is nothing to learn. Ten tiles is small
   * enough that a roamer belongs to a piece of ground and large enough that
   * where it will be is a guess rather than a fact.
   */
  readonly homeX: number;
  readonly homeY: number;
  /**
   * Who it is following, and where it last had them.
   *
   * `ai_target.actor` and `ai_state.target_last_seen` (`ai/simple.lua:28-35`),
   * which is why the chase walks to a REMEMBERED tile rather than to a live
   * position: a roamer that loses sight of you keeps going to where you were,
   * which is both what upstream does and the only version a player can read.
   */
  targetId?: string;
  seenX?: number;
  seenY?: number;
  /**
   * Steps since the target was last actually in sight. `ai/simple.lua:209-211`
   * gives up after ten and falls back to `move_wander`.
   */
  unseen: number;
  /**
   * The leash has snapped: walk home and look at nothing on the way.
   *
   * NOT DERIVABLE FROM POSITION, which is why it is stored. Without a latch a
   * roamer at exactly ten tiles turns for home, immediately sees the player
   * again on the next step, and oscillates on the boundary forever — the
   * player's screen shows a creature vibrating, and the leash reads as a bug
   * rather than as the thing that lets them escape.
   */
  goingHome: boolean;
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
   * `tome/class/Store.lua:171-178` flags exactly this at sale time, and `loadup` removes
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
   * WHICH SHELF THIS SHOP KEEPS — what you wear, or what you drink.
   *
   * On the STATE rather than looked up from the site id at every restock,
   * because `catchUpShop` already has the realm and asking a second table for a
   * fact the realm could carry is how two answers to one question start.
   */
  readonly shelf: ShopShelf;
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
 * WHICH TOWNS HAVE A SHOP. Every authored settlement has one physical keeper.
 *
 * A map read in `build` rather than shop columns on every `SITES` row: only the
 * five shared settlements carry shelves, and the value names their local stock.
 */
const SHOP_SITES: ReadonlyMap<string, ShopShelf> = new Map<string, ShopShelf>([
  ['site:alderbrook', ShopShelf.General],
  ['site:threadneedle_row', ShopShelf.Outfitter],
  /**
   * ASHWICK ALCHEMY ROW, AND ITS NAME HAS BEEN PROMISING THIS THE WHOLE TIME.
   *
   * The note above argued for one shop and said *"when a second shop lands it is
   * one string here"*. This is that string, and it took a second SHELF to be
   * worth writing: a shop stocking the same catalogue is not a second
   * destination, it is the same shop further away. Ashwick sells what you drink,
   * Threadneedle sells what you wear, and now the two are worth different walks.
   *
   * Thessaly Vaunt has stood here since the towns were populated saying *"I mix
   * what the Index has not read yet"* over an empty counter.
   */
  ['site:ashwick_row', ShopShelf.Apothecary],
  ['site:saints_rest', ShopShelf.Reliquary],
  ['site:wayfarers_camp', ShopShelf.Caravan],
]);

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
  /** The named country on this map, empty for anything that has none. */
  readonly regions: readonly Region[];
  /**
   * `level.data.effects` — the auras every body here wears, off the map
   * (`AuthoredMap.zoneEffects`). Empty for anywhere that has none, which is
   * everywhere a zone table has not named one. See `world/zone-effects.ts`.
   */
  readonly zoneEffects: readonly string[];
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
   * Copied from the site, the same way `lingerMs` is. See `SiteDef.noRecall`.
   *
   * ═══ ON THE INSTANCE AND NOT LOOKED UP FROM `SITES`, WHICH IS THE ONE
   *     PLACE THIS DIFFERS FROM `hasNoWayBack` ═══
   * That predicate resolves `SITES.get(realm.siteId)` at the point of use, which
   * is fine for a rule about the AUTHORED site. This one is asked of a realm the
   * gateway is already holding — the floor a body is standing on — and a field
   * copied at `open` makes "does this place let go" a property of the instance,
   * which is what a caller has, what a test can build, and what an instance
   * created from a site definition the global table does not hold can still
   * answer honestly.
   *
   * Always present, never optional: absent would be a third state between yes
   * and no, and the answer to "may I leave here" must never be "no idea".
   */
  readonly noRecall: boolean;
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
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * WHEN THIS REALM LAST BECAME EMPTY — `level.last_turn`, Game.lua:1370.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Anti-stairscum's second half: on re-entry the hostiles heal by how long
   * nobody was here, their cooldowns clear and the party's debuffs come off
   * (`restoreOnReentry`). Undefined while anybody is still standing in it.
   *
   * ═══ EMPTY, NOT "SOMEBODY LEFT" — AND THE DIFFERENCE IS A GRIEFING BUG ═══
   * The first version of this stamped on every departure. A party of four in a
   * delve, one of whom steps out to sell loot and walks back in, would have had
   * the boss the other three were fighting HEALED TO FULL with its cooldowns
   * back and their debuffs stripped. The rule exists to stop a fight being
   * paused; stamping a realm somebody is still standing in hands the player a
   * way to reset one.
   *
   * Upstream never meets this because it is single-player: leaving IS emptying.
   *
   * ═══ MILLISECONDS, NOT GAME TURNS, AND THAT IS FORCED ═══
   * Upstream has one global `turn`. Every realm here keeps its OWN clock and the
   * tide only advances an occupied one (`realmOccupied`), so there is no shared
   * turn count that keeps running: the overworld freezes the moment everybody is
   * indoors, and a solo player who leaves a delve, walks to a town and rests
   * three hundred turns would measure as two turns away. The wall clock is the
   * only monotonic reference the process has, and `TIDE_MS` is exactly the
   * conversion — one game turn per tide on an occupied realm.
   *
   * SET BY THE GATEWAY, which is the only layer allowed a clock at all.
   */
  leftAtMs?: number;

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * WHAT LEVEL THE THINGS IN HERE WERE BUILT AT — `Zone.base_level`.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * RECORDED WHERE IT IS DECIDED, and not re-derived later. `delveLevel(spec,
   * party)` is deterministic, so a reader could call it again — and would get a
   * DIFFERENT number for any site on the `player` scheme, because the party that
   * opened the room is not always the party asking. A room populated for a
   * level-3 body does not become harder because a level-12 friend walks in
   * afterwards, and a second answer to "how dangerous is this" is exactly the
   * shape that has bitten this codebase before.
   *
   * ABSENT FOR EVERY REALM WITH NO POPULATION — the overworld, a town, an office.
   * There is nothing in them whose level could be compared to anybody's, and
   * `undefined` says that rather than a 1 that reads like an answer.
   *
   * WRITTEN EXACTLY ONCE, immediately after `populate`, and never again. It is
   * mutable for the reason `leftAtMs` beside it is: `build` REGISTERS the realm
   * before this is known, so a `{...realm, baseLevel}` copy would hand the
   * caller a realm the registry does not hold — the field would be correct in
   * the returned object and absent in every later lookup.
   */
  baseLevel?: number;
  /** Which floor of its site this is, from 1: upstream's `level.level`. */
  readonly floor: number;
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE FLOOR'S OBJECTIVE, AND UNDEFINED ON EVERY FLOOR THAT HAS NONE.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Mutable behind a `readonly` binding, the same shape as `roamers` and `shop`
   * above and for the same stated reason: the realm's identity never changes and
   * its contents do.
   *
   * ═══ AND `shop`'s HEADER MAKES THIS FIELD'S ARGUMENT FOR IT ═══
   * A shop may not live on an Inner realm because `realms.delete` would destroy
   * its shelves the moment the last body left. A brief MUST live on an Inner
   * realm for exactly that reason: it is SUPPOSED to die there — upstream's
   * `check_level = nil` (tome/class/GameState.lua:2634) is the same statement
   * about the same moment. `partyId` below then makes it party-scoped by
   * construction, with no access control to write.
   *
   * ONE OPTIONAL FIELD, AND THAT IS THE MECHANISM RATHER THAN THE NOTATION. A
   * second concurrent objective on one floor is a quest log wearing a different
   * word, and a single optional field cannot represent one.
   */
  brief?: Brief;
  /**
   * WHAT THIS FLOOR COULD BE ASKED TO DO — copied from the site at `open`, and
   * empty everywhere else.
   *
   * COPIED, FOR `noRecall`'s REASON VERBATIM: this is asked of a realm the
   * gateway is already holding, and *"a field copied at `open` makes [it] a
   * property of the instance, which is what a caller has, what a test can build,
   * and what an instance created from a site definition the global table does
   * not hold can still answer honestly"*. `armBrief` takes a realm and nothing
   * else because of this line.
   */
  readonly briefs: readonly BriefSpec[];
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * WHICH OBJECTIVE IDS THIS INSTANCE HAS ALREADY HANDED OUT — `hasQuest`.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `engine/interface/ActorQuest.lua:50` is `if self:hasQuest(quest.id) then
   * return end`, and `Brief.id` carries the floor precisely so that check is a
   * string lookup. Ours had the id and not the ledger, so `armBrief`'s guard
   * held only while the brief was still ON the realm — and the floor's edge
   * clears that field. Walking out of the delve mouth and back in through the
   * same door therefore minted the same id again, with a second quarry, a
   * second payout and a second reward item on one floor.
   *
   * ON THE INSTANCE, WHICH IS THE WHOLE LIFETIME IT SHOULD HAVE. `realms.close`
   * takes the instance and this ledger with it, so a party who let the linger
   * run out and came back to a fresh floor is asked again — which is the same
   * lifetime upstream's `check_level` has, and the reason the field is here
   * rather than on a character.
   *
   * A WIPE TAKES AN ID BACK OUT (`rearmBrief`), because a reset means the fight
   * did not happen.
   */
  readonly granted: Set<string>;
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
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * SHARED, PRIVATE TO A PARTY, OR A WHOLE OTHER MAP.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * The first two are the essay on `RealmKind`. The third is new and is the
   * blocker that made the other two second-landmass fixes untestable:
   * `SiteDef.kind` was `Common | Inner`, so there was NO CODE PATH that put a
   * body into a second Overworld realm — and building one as `Common` would have
   * typechecked, booted, been walkable, and silently disabled six subsystems
   * that gate on `kind === Overworld` (the roamer tick, the fog reveal, the
   * `explored` frame, the exit rule, the nearest-site bearings and
   * `leaveRealm`'s refusal).
   *
   * AN OVERWORLD SITE IS A DOOR BETWEEN MAPS. It behaves like a Common one — one
   * shared copy, built once, never reaped, everybody who walks in is in it —
   * and differs only in the kind it carries, which is what those six subsystems
   * read. `Common` requires that nothing ever spawns; an overworld is the one
   * shared space where roamers are the whole point, so the no-combat assertion
   * deliberately does not apply to it.
   */
  readonly kind: typeof RealmKind.Common | typeof RealmKind.Inner | typeof RealmKind.Overworld;
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
  /**
   * `ground` IS WHERE THE PARTY WAS STANDING when whatever this is caught them.
   *
   * Optional, and every authored site ignores it: a town is the same town
   * whether you walked in off the heath or off the road, and a delve is a place
   * with an address. The ambush is the one site that is not a PLACE at all — it
   * is a fight that happens where you were — so it is the one that reads this.
   */
  readonly map: (seed: string, ground?: Ground, floor?: number) => AuthoredMap;
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * WHAT THIS FLOOR IS CALLED, when the site's own name is not enough.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `Realm.name` is `site.name` on every floor of every site, so a party four
   * floors into the Underworks is told *"The Underworks"* exactly as they were
   * on the first — and the stair marker's label is the hard-coded string
   * *"Next level"*. NOTHING IN THE GAME HAS EVER SAID HOW DEEP YOU ARE.
   *
   * That is survivable in a place with three floors and it is not survivable in
   * one with a billion: depth IS the Tower's only progress, and a party that
   * cannot say how far down they are has no way to agree to stop.
   *
   * ABSENT ON EVERY SITE THAT SHIPPED BEFORE, so nothing a player has been
   * reading changes. `RealmMsg.name` and `SiteView.name` are prose on the wire
   * already, so this costs no protocol change and no `PROTOCOL_VERSION` bump.
   */
  readonly nameFor?: (floor: number) => string;
  /**
   * THE FIRST FLOOR'S THRESHOLD IS NOT A WAY OUT. Upstream's first level of the
   * Escape from Reknor replaces its up stair with floor
   * (data/zones/reknor-escape/zone.lua:67-69): the only way out is forward.
   */
  readonly noWayBack?: boolean;
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * NOTHING HERE LETS GO — a place the Knot of Elsewhere will not pull you out
   * of. Upstream's `no_worldport` on the LEVEL's data.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `Actor.lua:6918` is `worldport = function(self) return game.level.data.no_worldport
   * and 100 or 0 end`, read through `canBe("worldport")` at
   * quest-artifacts.lua:335 — so upstream asks the PLACE, not the item. Thirteen
   * zones set it, among them the Infinite Dungeon
   * (data/zones/infinite-dungeon/zone.lua:32) and Escape from Reknor
   * (data/zones/reknor-escape/zone.lua:31), which the Undermost is our port of.
   *
   * ═══ NOTHING SETS IT TODAY, AND THAT IS A RULING RATHER THAN AN OVERSIGHT ═══
   * The author ruled on 2026-09-17 that the Knot DOES work inside the Undermost
   * — a deliberate divergence from upstream, which flags reknor-escape
   * `no_worldport` AND denies its tutorial the rod outright
   * (data/birth/descriptors.lua:129, data/zones/tutorial/npcs.lua:58). Our
   * warden stands beside the exit; a party that has beaten it has earned the
   * door, and the alternative is *"you won, then died walking ten tiles"*.
   *
   * It exists from day one anyway, because the endless content this game is
   * heading for is exactly upstream's own case: the Infinity Tower ships
   * `noRecall: true` and that is a one-line answer rather than a later data
   * migration. `Realm.noRecall` is where the gateway reads it.
   */
  readonly noRecall?: boolean;
  /**
   * WHERE A NEW CHARACTER IS PUT, rather than a place anybody walks to. Upstream
   * sends a new character straight to its starting zone (class/Game.lua:287).
   * Read by the gateway when a new character chooses its class.
   */
  readonly birthplace?: boolean;
  /**
   * HOW THE SITE IS LIT. Absent is lit everywhere, which is how every site has
   * been drawn so far. See `shared/light.ts`.
   */
  readonly lighting?: SiteLighting;
  /**
   * Seeds the population. Called once, after the world exists — and again with
   * `PopulationScope.Hostiles` every time a party wipes on the floor, through
   * `World.reseedFloor`, which is how a floor comes back as itself.
   *
   * MUST BE ABSENT ON A `Common` SITE. Enforced at construction rather than
   * documented, because the failure is silent: a town with one monster in it
   * arms engagement for every unrelated person standing in it, and they all
   * start waiting on each other's turns with no way to discover why.
   */
  readonly populate?: (
    world: World,
    map: AuthoredMap,
    party: PartyStrength,
    lead?: MonsterTemplate,
    floor?: number,
    /** A whole floor, or only what a party wipe puts back. */
    scope?: PopulationScope,
  ) => void;

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * NOT ON YOUR MAP UNTIL YOU HAVE PERSONALLY STOOD NEAR IT.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Thirteen markers arrive with the first frame, so the overworld has never
   * once rewarded looking: everything worth walking to was handed over before
   * the player took a step.
   *
   * The gate is the character's OWN fog bitset — already computed, already
   * persisted (`CharacterFile.explored`), already on the wire — so a hidden site
   * costs no new state and no new save field. It is also per PLAYER and not per
   * party, which is the correct reading: finding something is yours, and telling
   * the others is the good part.
   *
   * ABSENT ON EVERY SITE THAT SHIPPED BEFORE. Nothing a player has been reading
   * for weeks is ever taken away — a feature that makes the map smaller is not
   * the feature, and the whole point is to add somewhere to find.
   */
  readonly hidden?: boolean;
  /**
   * THE OBJECTIVES THIS PLACE MAY OFFER, and absent on every site that offers
   * none — which is every site today. Beside `populate` because it is the same
   * kind of thing: what this floor has on it beyond its tiles.
   *
   * MUST BE ABSENT ON A `Common` SITE, enforced beside the same rule for
   * `populate` and for a sharper version of its reason: a delve floor holds one
   * party (`Realm.partyId`, `MAX_PARTY_SIZE`), so a brief is offered to people
   * who chose to play together. A town is shared by every party in it, and an
   * objective offered into a room of six strangers has no party to belong to.
   */
  readonly briefs?: readonly BriefSpec[];
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
  open(
    site: SiteDef,
    partyId: string,
    party?: PartyStrength,
    ground?: Ground,
    lead?: MonsterTemplate,
    /** Which floor, from 1. Each floor is its own instance. */
    floor?: number,
  ): Realm;
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
  /**
   * THE STATUS TABLE, so a floor's population wears the floor's auras
   * (`Realm.zoneEffects`) from the moment it stands up, and again after a wipe
   * re-seeds it. Absent is a registry with no status system, and no auras.
   */
  readonly effects?: EffectState;
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
  // ═══ AND FOR THE SAME REASON, IN THE SAME PLACE, WITH THE SAME LOUDNESS ═══
  // A brief belongs to the party that took it, and a Common realm has no party
  // (`Realm.partyId` is undefined there). An objective offered in a town would
  // be offered to whoever happened to be standing in it.
  if (site.kind === RealmKind.Common && site.briefs !== undefined) {
    throw new Error(
      `realms: site '${site.id}' is Common but carries briefs — an objective ` +
        `belongs to the party that took it, and a shared space has no party. ` +
        `Make it Inner, or drop the briefs.`,
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
    extra: {
      readonly partyId?: string;
      readonly siteId?: string;
      readonly lingerMs?: number;
      /** See `SiteDef.noRecall`. Absent is a place that lets go. */
      readonly noRecall?: boolean;
      readonly lighting?: SiteLighting;
      readonly floor?: number;
      /** How the floor is put back after a party wipe. See `World.reseedFloor`. */
      readonly reseedFloor?: (world: World) => void;
      /** What this floor may be asked to do. See `Realm.briefs`. */
      readonly briefs?: readonly BriefSpec[];
    },
  ): Realm => {
    // THE REALM'S OWN ID, THREADED IN. Everything minted inside this world
    // prefixes with it, so two parties in the same delve stop sharing
    // monster ids — and therefore stop sharing the process-wide status,
    // Downed and talent tables that key off them. See `World.id`.
    const world = createWorld(seedFor(opts.seed, id), map, id, extra.lighting, extra.reseedFloor);
    const engine = opts.engineFor(world);
    const realm: Realm = {
      id,
      kind,
      name,
      world,
      engine,
      sites: map.sites,
      spawns: map.spawns,
      // ALONGSIDE `sites` AND `spawns`, and for the same reason: they are facts
      // about the authored map, and a realm is where the rest of the server
      // reaches them. See `AuthoredMap.regions`.
      regions: map.regions ?? [],
      zoneEffects: map.zoneEffects ?? [],
      roamers: new Map<string, Roamer>(),
      // IN `build` AND NOT IN THE BOOT LOOP. There are TWO call sites — the
      // eager pass that opens every shared realm at startup, and `open`, which
      // builds a Common realm lazily if it was never opened. A shop wired into
      // only the first would leave a town with no shelves on the second path,
      // and the only thing that would notice is a test supplying its own sites.
      shop: SHOP_SITES.has(extra.siteId ?? '')
        ? {
            epoch: -1,
            stock: [] as ShopSlot[],
            shelf: SHOP_SITES.get(extra.siteId ?? '') ?? ShopShelf.Outfitter,
          }
        : undefined,
      // A shared space is never reaped, so its linger is meaningless; 0 is the
      // honest value rather than a large number pretending to be a policy.
      lingerMs: extra.lingerMs ?? 0,
      // THE DEFAULT IS "YOU MAY LEAVE". Every place in the game lets go unless
      // its site says otherwise, which is upstream's shape too: `no_worldport`
      // is an opt-in on thirteen zones out of the whole campaign.
      noRecall: extra.noRecall ?? false,
      sealed: false,
      floor: extra.floor ?? 1,
      ...extra,
      // ═══ AFTER THE SPREAD, DELIBERATELY, AND IT IS NOT STYLE ═══
      // `open` passes `site.briefs` straight through, and that is `undefined`
      // on every site that offers none — a spread copies a key whose VALUE is
      // undefined over a default just as happily as it copies a real one. The
      // same three words written ABOVE `...extra` would be `undefined` at
      // runtime on every floor in the game, with the type still claiming an
      // array and `armBrief` reading a field that cannot be there. The list is
      // always a list, so nothing downstream has to ask twice.
      briefs: extra.briefs ?? [],
      // AFTER THE SPREAD FOR THE SAME REASON, and a fresh Set per instance: it
      // is the instance's memory of what it has already offered. See
      // `Realm.granted`.
      granted: new Set<string>(),
    };
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * AND THE PEOPLE WHO LIVE HERE — IN `build`, FOR THE `shop` FIELD'S REASON.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * The note on `shop` above is the whole argument and it applies verbatim:
     * there are TWO call sites — the eager pass that opens every shared realm at
     * startup, and `open`, which builds a Common realm lazily if it was never
     * opened. Wire townsfolk into only the first and a town has nobody in it on
     * the second path, and *"the only thing that would notice is a test supplying
     * its own sites"*. This repo has shipped that exact bug once and written it
     * up; putting the call here is what makes both paths the same path.
     *
     * AFTER `realms.set`, so a failure to place somebody cannot leave a
     * half-registered realm — and before anything can walk in, because nothing
     * can reach a realm the registry has not returned yet.
     *
     * `map` NOT `builtMap`: `build` is the function that HAS the authored map,
     * which is the other half of why this belongs here rather than beside
     * `site.populate` — that seam runs only for sites carrying a populate hook,
     * and a town does not have one.
     */
    const folk = townsfolkFor(extra.siteId);
    if (folk.length > 0) placeTownsfolk(world, map, folk, extra.siteId);
    placeTownProps(world, extra.siteId);

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
    if (site.kind === RealmKind.Inner) continue;
    // A SECOND MAP IS NOT A ROOM, so the no-combat rule that guards a town does
    // not apply to it: roamers on an overworld are the entire point of one.
    if (site.kind === RealmKind.Common) assertNoCombatInSharedSpace(site);
    const realm = build(`realm:${site.id}`, site.kind, site.name, site.map(`realm:${site.id}`), {
      siteId: site.id,
      ...(site.lighting === undefined ? {} : { lighting: site.lighting }),
    });
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
    /**
     * WHAT COUNTRY THEY WERE STANDING IN. Absent for a door — a town is the
     * same town whichever direction you walked in from — and read by exactly
     * one site, the ambush, which is the only one that is a FIGHT rather than a
     * place. See `SiteDef.map`.
     */
    ground?: Ground,
    /**
     * AND WHAT THEY WALKED INTO, for the one site that is a fight.
     *
     * Threaded exactly like `ground` and for the same reason: it decides what
     * this room is at the moment it is built and has nothing to say afterwards.
     * Absent for a door — a town does not change because of what was standing
     * outside it.
     */
    lead?: MonsterTemplate,
    /** Which floor of the site, from 1. Each floor is its own instance. */
    floor = 1,
  ): Realm => {
    /**
     * A COMMON SITE IGNORES THE PARTY ENTIRELY. There is one office, and
     * everybody who walks through the door is in it — which is the whole point
     * of a common space and the reason `partyId` is accepted and dropped here
     * rather than being absent from the signature: the caller should not have
     * to know which kind of place it is asking about in order to ask.
     */
    // BOTH SHARED KINDS TAKE THIS BRANCH. A town and a second landmass are the
    // same statement about ownership — there is one of it, and everybody who
    // walks through the door is in the same one — and they differ only in the
    // kind they carry. See `SiteDef.kind`.
    if (site.kind !== RealmKind.Inner) {
      const shared = commonBySite.get(site.id);
      if (shared !== undefined) return shared;
      // A common site that was not built at boot means the SITES table and this
      // registry disagree, which is a wiring bug rather than a runtime state.
      assertNoCombatInSharedSpace(site);
      const built = build(
        `realm:${site.id}`,
        // `site.kind`, NOT `RealmKind.Common`, WHICH IS WHAT THIS SAID. The
        // branch above reads "not Inner" and there are now two kinds that
        // satisfy it, so hard-coding one of them meant a second landmass
        // reaching this path would be built as a town — walkable, boots, and
        // with the roamer tick, the fog, the region names and the way home all
        // silently off. Unreachable today (the boot loop builds every shared
        // site eagerly) and one refactor away from not being.
        site.kind,
        site.name,
        site.map(`realm:${site.id}`),
        {
          siteId: site.id,
          ...(site.lighting === undefined ? {} : { lighting: site.lighting }),
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
      if (realm.partyId === partyId && realm.siteId === site.id && realm.floor === floor) {
        return realm;
      }
    }

    instanceSeq += 1;
    const id = `realm:${site.id}:${String(instanceSeq)}`;
    // THE GROUND IS PASSED, NEVER STORED. It decides what this room is made of
    // at the moment it is built and has nothing to say afterwards — a realm that
    // remembered it would be a second answer to "what does this floor look
    // like", and the tiles are already the first.
    // EVERY FLOOR BUT THE LAST HAS A STAIR DOWN.
    const drawn = site.map(seedFor(opts.seed, id), ground, floor);
    const builtMap = floor < floorsOfSite(site.id) ? withStairsDown(drawn) : drawn;
    // A LEVEL THAT SAYS HOW IT IS LIT IS LIT THAT WAY, whatever its site says:
    // upstream's light is per level (`AuthoredMap.lighting`).
    const lighting = drawn.lighting ?? site.lighting;
    // AND WHAT THIS FLOOR IS CALLED. See `SiteDef.nameFor`: a site that does not
    // answer is the site's own name, which is every site but one.
    const realm = build(id, RealmKind.Inner, site.nameFor?.(floor) ?? site.name, builtMap, {
      partyId,
      siteId: site.id,
      floor,
      lingerMs: site.lingerMs,
      // See `SiteDef.noRecall`. Carried onto the instance for the reason
      // `Realm.noRecall` gives.
      noRecall: site.noRecall === true,
      // AND WHAT THIS FLOOR MAY BE ASKED TO DO, copied for that same reason.
      // The whole site's list: `armBrief` asks which of them this FLOOR carries,
      // because that question has an answer only once the floor is built.
      //
      // PASSED PLAINLY, `undefined` AND ALL, rather than through the conditional
      // spread the `lighting` line above uses. Two defences against the same
      // mistake is one defence and one line nothing can test: `build` defaults
      // this AFTER its spread, so an absent list becomes `[]` there, and hiding
      // the undefined here would make that the unreachable half instead.
      briefs: site.briefs,
      ...(lighting === undefined ? {} : { lighting }),
      // THE SAME CALL AS THE LINE BELOW, SCOPED TO HOSTILES: the same site, map,
      // party, lead and floor, so a wipe puts back this floor's own population
      // rather than the engine's default test encounter. See `World.reseedFloor`.
      reseedFloor: (world: World): void => {
        site.populate?.(world, builtMap, party, lead, floor, PopulationScope.Hostiles);
        // A RE-MINTED BODY IS A BODY ADDED TO THE LEVEL (tome/class/Actor.lua:7263-7267).
        applyZoneEffectsIn(world, builtMap.zoneEffects ?? [], opts.effects);
      },
    });
    site.populate?.(realm.world, builtMap, party, lead, floor);
    // AND THE LEVEL'S AURAS ON ALL OF IT, before anybody can walk in and meet it
    // bare (tome/class/Game.lua:1329-1335).
    applyZoneEffectsIn(realm.world, realm.zoneEffects, opts.effects);
    /**
     * AND WHAT LEVEL THAT POPULATION WAS BUILT AT, for whoever has to SAY it —
     * the level feeling on arrival (shared/zone.ts) is the only reader today.
     * Taken from the same `spec` and the same `party` the population just used,
     * one line above, so the two cannot disagree.
     */
    const spec = specFor(site.id);
    if (spec !== undefined) {
      realm.baseLevel = delveLevel(spec, party) + floor - 1;
      // AND THE TERRAIN RESOLVES AT IT: lava's `mindam`/`maxdam` read
      // `resolvers.current_level`, which is this same `base_level + lev - 1`
      // (engine/Zone.lua:1031). See `World.setTerrainLevel`.
      realm.world.setTerrainLevel(realm.baseLevel);
    }
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
    /**
     * ═══ AND THE FLOOR'S OBJECTIVE GOES WITH THE FLOOR ═══
     * Upstream's `check_level = nil` (tome/class/GameState.lua:2614, :2618,
     * :2624, :2634), and the registry drop below is not a substitute for it.
     * A caller holding the realm object — the gateway, mid-crossing, or a test —
     * still holds every field on it after the registry has forgotten the id, and
     * a brief reachable through one of those is a brief that outlived the floor
     * it was true of. `closeFloorBriefs` is the ordinary path and this is the
     * backstop for the realm that is reaped without anybody walking out of it.
     */
    realm.brief = undefined;
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
/**
 * ═══════════════════════════════════════════════════════════════════════════
 * SIX COLUMNS, AND THE LAST TWO ARE WHAT THE PLACE IS MADE OF.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `SiteShape` already stopped thirteen destinations being one destination with
 * thirteen doors — a mine of winding galleries reads as a different PLACE from a
 * market that is an open plaza. But all four shapes were built out of the same
 * two tile codes, so every one of them was the same grey box in a different
 * outline, and those two codes are what the player has been looking at since M1.
 *
 * The floor/wall pair is a POST-PASS over the finished grid (`makeSiteMap`), or
 * for a works the Roomer's own `'.'` and `'#'` grid keys, which draw nothing, so
 * the generator is untouched and the walkable cells are identical bit for bit —
 * `test/shared/sitemap.test.ts` is the proof, and it asserts the rule both
 * halves carry: the floor must be `isWalkable`, the wall must not be.
 *
 * ═══ THE OUTER INDEX'S WALLS ARE `ERASED`, AND THAT IS THE FICTION IN A CELL ═══
 * The building at the end of the road is not built OUT of anything. It is built
 * out of the absence — the same code that eats the edges of the moor.
 *
 * ═══ AND IT COST NO ART ═══
 * Every code here already had a PNG on disk and a `tileFill` colour. Six of them
 * — GREEN, SOOT, RAIL, WORKS, TERRACE, CIVIC — were finished tiles that drew
 * NOTHING anywhere in the game, because their codes appeared on no overworld row
 * and in no interior. This table spends them.
 */
/**
 * The sites a player has to FIND. See `SiteDef.hidden`, and the note in
 * shared/level.ts on how the three cells were measured.
 */
const HIDDEN_SITES: ReadonlySet<string> = new Set([
  'site:cairnfoot',
  'site:barrow_end',
  'site:the_weir',
]);

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * HOW EACH KIND OF PLACE IS LIT — upstream's zone settings, by shape.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * WORKS are rooms and corridors, upstream's `Roomer` levels, and every early
 * Roomer zone lights its rooms: ruins-kor-pul at 100
 * (data/zones/ruins-kor-pul/zone.lua:46), blighted-ruins at 100
 * (data/zones/blighted-ruins/zone.lua:43), murgol-lair at 100
 * (data/zones/murgol-lair/zone.lua:46), ritch-tunnels at 90
 * (data/zones/ritch-tunnels/zone.lua:41). 100 is taken.
 *
 * CAVES are dark: upstream's Cavern generator (engine/generator/map/Cavern.lua)
 * lights nothing, so a cave is seen by the light its visitors carry.
 *
 * TOWNS are lit everywhere, as upstream's towns are
 * (data/zones/town-derth/zone.lua:31, data/zones/town-last-hope/zone.lua:31).
 * RUINS are open ground under the sky, with no upstream analogue, and are lit.
 *
 * The Redaction's twins copy their original's definition, lighting included.
 * The world maps and the breach arena set nothing and stay lit; upstream's
 * ambush zone is `all_lited` (class/GameState.lua:828).
 *
 * A SITE BUILT AS A TOME ZONE IS LIT AS ITS ZONE SAYS INSTEAD, floor by floor
 * (`zoneSite`). By shape it is only the towns, their Redaction twins and the
 * Undermost now: no site reads the Works row, which stays because the `Record`
 * answers every shape.
 *
 * A `Record` over every shape, so a new shape cannot arrive without an answer.
 */
const SHAPE_LIGHTING: Readonly<Record<SiteShape, SiteLighting | undefined>> = {
  [SiteShape.Town]: undefined,
  [SiteShape.Ruin]: undefined,
  [SiteShape.Cave]: { litRoomChance: 0 },
  [SiteShape.Works]: { litRoomChance: 100 },
};

/** `{ lighting }` for a shape that sets one, and nothing for one lit everywhere. */
function lightingFor(shape: SiteShape): { readonly lighting?: SiteLighting } {
  const lighting = SHAPE_LIGHTING[shape];
  return lighting === undefined ? {} : { lighting };
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A SITE THAT IS A TOME ZONE IS BUILT AS THAT ZONE — `shared/mapgen/zones.ts`.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Its `map` and its `lighting`, for a site the zone table names, and nothing for
 * one it does not. Spread AFTER the shape's, so it replaces them: the shape
 * built every works as Kor'Pul and every cave as the breeding pits, and a zone
 * builds each floor as the level of its own zone that floor is.
 *
 * `map` takes the FLOOR, which the shape's closure ignored: a Drowned Chapel's
 * first floor is a ruined town and its second a dungeon of rooms. The palette is
 * the row's floor and wall, and it must be the zone's own (`ZoneDef.palette`):
 * the zone's tests build every level in that one, so a row whose colours drifted
 * from it would ship floors no test built, and is refused when this table loads.
 *
 * `lighting` is floor 1's, and a floor's own map carries its own (`open` reads
 * that first): the Watcher's Altar is lit everywhere above ground and by the
 * room below it, and a Gearford floor lights on the chance it rolled — which
 * no site-wide value can say, so a rolled zone's says only that it is not lit
 * everywhere.
 */
function zoneSite(
  id: string,
  palette: SitePalette,
): { readonly map?: SiteDef['map']; readonly lighting?: SiteLighting } {
  const zone = ZONES.get(id);
  if (zone === undefined) return {};
  if (zone.palette.floor !== palette.floor || zone.palette.wall !== palette.wall) {
    throw new Error(`${id}: its row's floor and wall are not its zone's (shared/mapgen/zones.ts)`);
  }
  return {
    map: (seed: string, _ground?: Ground, floor = 1): AuthoredMap =>
      zoneLevel(id, seed, floor, palette),
    lighting: siteLighting(zoneFloor(zone, 1).lighting),
  };
}

const AUTHORED_SITES: readonly (readonly [string, SiteDef])[] = (
  [
    // ─── open to everybody: no combat, so nothing to coordinate. These are
    // the SETTLEMENTS, and with the overworld now being open country they are
    // where the game is social — the road between them is meant to feel empty.
    //
    [
      'site:alderbrook',
      'Alderbrook',
      RealmKind.Common,
      'city',
      SiteShape.Town,
      TileCode.PAVING,
      TileCode.CIVIC,
    ],
    [
      'site:threadneedle_row',
      'Threadneedle Row',
      RealmKind.Common,
      'town',
      SiteShape.Town,
      TileCode.COBBLE,
      TileCode.TERRACE,
    ],
    [
      'site:ashwick_row',
      'Ashwick Alchemy Row',
      RealmKind.Common,
      'town',
      SiteShape.Town,
      TileCode.COBBLE,
      TileCode.WORKS,
    ],
    [
      'site:wayfarers_camp',
      "A Wayfarers' Camp",
      RealmKind.Common,
      'village',
      SiteShape.Ruin,
      TileCode.YARD,
      TileCode.TREES,
    ],
    [
      'site:saints_rest',
      "Saint's Rest",
      RealmKind.Common,
      'town',
      SiteShape.Town,
      TileCode.YARD,
      TileCode.TERRACE,
    ],
    // ─── one party at a time: combat, so a shared barrier would be wrong ───
    [
      'site:blackwood_outskirts',
      'Blackwood Outskirts',
      RealmKind.Inner,
      'gate',
      SiteShape.Cave,
      TileCode.HEATH,
      TileCode.TREES,
    ],
    [
      'site:gearford_ward',
      'Gearford Industrial Ward',
      RealmKind.Inner,
      'gate',
      SiteShape.Works,
      TileCode.SOOT,
      TileCode.WORKS,
    ],
    [
      'site:underworks',
      'The Underworks',
      RealmKind.Inner,
      'mine',
      SiteShape.Cave,
      TileCode.SOOT,
      TileCode.CRAG,
    ],
    [
      'site:glass_archive',
      'The Glass Archive',
      RealmKind.Inner,
      'city',
      SiteShape.Works,
      TileCode.CRYSTAL_FLOOR,
      TileCode.CRYSTAL_WALL,
    ],
    [
      'site:watchers_altar',
      "The Watcher's Altar",
      RealmKind.Inner,
      'ruin',
      SiteShape.Ruin,
      TileCode.PLAINS,
      TileCode.CRAG,
    ],
    /**
     * ═════════════════════════════════════════════════════════════════════════
     * MOUNTAIN, NOT CRAG — BECAUSE THIS ONE IS DUG INTO A MOUNTAIN.
     * ═════════════════════════════════════════════════════════════════════════
     *
     * The Hollow Mine and The Underworks were byte-identical in every authored
     * field but their ids: same `mine` marker, same `SiteShape.Cave`, same SOOT
     * floor, same CRAG wall — and content/delve.ts gives them the same
     * `RANK_AND_FILE` roster. The only difference in the whole game was two more
     * monsters. So one of the eleven delves on the moor was the other one with a
     * different name, and a player who cleared The Underworks had already seen
     * The Hollow Mine.
     *
     * MEASURED, AND THAT IS WHY IT IS THIS CODE. The eleven-by-eleven of
     * overworld around each marker is not remotely alike:
     *
     *     The Hollow Mine   MOUNTAIN 61  HILLS 28  CRAG 17   <- cut into a range
     *     The Underworks    HEATH 70  HILLS 21  PLAINS 15    <- under moorland
     *
     * A mine looks like the rock it goes through, and these two go through
     * different rock. The Underworks keeps its crag under the moor.
     *
     * A REPAINT, NOT A RE-DESIGN: `MOUNTAIN` and `CRAG` are both unwalkable and
     * both sight-blocking, so not one route, sightline or fight changes — only
     * which of two already-installed tilesets the walls are drawn from.
     */
    [
      'site:hollow_mine',
      'The Hollow Mine',
      RealmKind.Inner,
      'mine',
      SiteShape.Cave,
      TileCode.SOOT,
      TileCode.MOUNTAIN,
    ],
    [
      'site:drowned_chapel',
      'The Drowned Chapel',
      RealmKind.Inner,
      'ruin',
      SiteShape.Ruin,
      TileCode.SHORE,
      TileCode.TERRACE,
    ],
    [
      'site:outer_index',
      'The Outer Index',
      RealmKind.Inner,
      'city',
      SiteShape.Works,
      TileCode.PAVING,
      TileCode.ERASED,
    ],
    // ─── and three nobody is told about ─────────────────────────────────
    //     See `SiteDef.hidden`. Each sits on ground measured to be as far
    //     from any existing marker as this map allows, and each rewards a
    //     different instinct: climb the downs, go into the trees, follow the
    //     coast past where anything is drawn.
    [
      'site:cairnfoot',
      'Cairnfoot',
      RealmKind.Inner,
      'stair',
      SiteShape.Cave,
      TileCode.UNDERGROUND_FLOOR,
      TileCode.UNDERGROUND_TREE,
    ],
    [
      'site:barrow_end',
      'Barrow End',
      RealmKind.Inner,
      'altar',
      SiteShape.Ruin,
      TileCode.GREEN,
      TileCode.TREES,
    ],
    [
      'site:the_weir',
      'The Weir',
      RealmKind.Inner,
      'archive',
      SiteShape.Works,
      TileCode.WATER_FLOOR,
      TileCode.WATER_WALL,
    ],
  ] as const
).map(([id, name, kind, marker, shape, floor, wall]): [string, SiteDef] => [
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
    /**
     * ═════════════════════════════════════════════════════════════════════
     * A TOWN GETS A THIRD CODE: STREET, BUILDING, BOUNDARY.
     * ═════════════════════════════════════════════════════════════════════
     *
     * Measured on Alderbrook's interior: 1,020 cells and exactly two codes —
     * PAVING 732, CIVIC 288 — with the ring around the town drawn in the SAME
     * code as the blocks inside it. The streets and blocks are really there,
     * and a player standing in the middle of them cannot tell a building from
     * the edge of the world.
     *
     * THE AUTHORED CODE STAYS ON THE BUILDINGS, and that ordering is the whole
     * of it. `wall` is what makes Alderbrook's civic stone different from
     * Threadneedle's terraces — four settlements a player walks between in one
     * session, which `sitemap.test.ts` pins so a new site has to make a choice
     * rather than inherit a default. A first version of this handed the tier
     * roof to the blocks and the shared `TOWN_WALL` to the ring, which made
     * three of the four towns identical inside; the test caught it.
     *
     * So the NEW code goes on the boundary, where sharing is correct: the wall
     * around a place is the same idea in every town, and what is inside it is
     * not.
     *
     * ONLY FOR A TOWN SHAPE. A cave's rim and a cave's pillars are the same
     * rock, and `SitePalette.roof` is optional for exactly that reason.
     */
    map: (seed) =>
      makeSettlementMap(id) ??
      makeSiteMap(
        seed,
        shape,
        shape === SiteShape.Town
          ? { floor, wall: TileCode.TOWN_WALL, roof: wall }
          : { floor, wall },
      ),
    // A delve is a place you can go back to. A town never empties in the sense
    // that matters — `close` refuses a shared realm outright — so the number
    // is inert there and stated once rather than branched on.
    lingerMs: INSTANCE_LINGER_MS,
    /**
     * ═══════════════════════════════════════════════════════════════════
     * AND SOMETHING IS IN THERE. FOR THE FIRST TIME.
     * ═══════════════════════════════════════════════════════════════════
     * Every one of the eight delves generated EMPTY — a player walked
     * thirty tiles to "The Hollow Mine", read a line about tunnels that went
     * deeper than anyone dug, and found nothing at all. content/delve.ts
     * carries the eight specs and argues the shape; this is only the wiring.
     *
     * ABSENT ON A COMMON SITE, which `createRealms` enforces at
     * construction rather than trusting: one monster in a town arms
     * engagement for every unrelated person standing in it, and they all
     * start waiting on each other with nothing on screen to explain why.
     * `DELVES` has no entry for a town, so the lookup returns undefined
     * and the field stays absent — the rule is expressed as data.
     */
    // HOW IT IS LIT, by its shape. See `SHAPE_LIGHTING`.
    ...lightingFor(shape),
    // THE THREE THAT ARE NOT ON YOUR MAP YET. Data, so a reviewer can see
    // the whole set at a glance rather than reading a predicate.
    ...(HIDDEN_SITES.has(id) ? { hidden: true } : {}),
    // `specFor`, NOT `DELVES.has`. Identical for an Alderbrook id — which is
    // all this authored table holds — so this changes nothing today, and that
    // was measured. It is here because `specFor` is the lookup that knows about
    // both maps, and a raw table read sitting beside it is exactly how
    // `markersFor` came to grade the Redaction's six doors as if they were towns.
    ...(specFor(id) !== undefined
      ? {
          /**
           * ═══════════════════════════════════════════════════════════════
           * THE THIRD ARGUMENT, WHICH WAS BEING SILENTLY DROPPED.
           * ═══════════════════════════════════════════════════════════════
           *
           * `SiteDef.populate` is typed `(world, map, party) => void` and the
           * registry has always CALLED it with all three (`site.populate?.(
           * realm.world, builtMap, party)`). This lambda declared two, so
           * TypeScript accepted it — a function of fewer parameters is
           * assignable to one of more, which is correct and is exactly why
           * nothing ever complained — and the party was dropped on the floor.
           *
           * SO NO DELVE HAS EVER SCALED TO ANYBODY. A lone level-1 detective
           * and a party of four walked into the identical room, which is
           * backwards twice over: the ambush DOES scale (`ambushRoster`), so
           * the fight you stumble into answered the party while the dungeon
           * you deliberately brought three friends to did not — and D12 pays
           * every member a FULL experience share, so four people clearing a
           * solo-sized room earn four times the experience for a quarter of
           * the work.
           */
          populate: (
            world: World,
            built: AuthoredMap,
            party: PartyStrength,
            _lead?: MonsterTemplate,
            floor = 1,
            scope?: PopulationScope,
          ): void => {
            const spec = specFor(id);
            if (spec !== undefined) {
              populateDelve(world, built, forArea(spec, built), party, floor, scope);
            }
          },
        }
      : {}),
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * AND WHAT THIS PLACE MAY ASK OF A PARTY THAT WALKS INTO IT.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * A LOOKUP, LIKE `populate` ABOVE AND `SHOP_SITES` BESIDE IT, so the rule
     * is expressed as data: `content/briefs.ts` has no entry for a town, so the
     * lookup returns an empty list, the conditional spread leaves the field
     * absent, and `assertNoCombatInSharedSpace`'s refusal never has to fire.
     *
     * ABSENT RATHER THAN EMPTY on a site that offers none, because `SiteDef`'s
     * field is optional and `build` defaults it after its own spread — writing
     * `briefs: []` here would make that default the unreachable half.
     */
    ...(briefsForSite(id).length > 0 ? { briefs: briefsForSite(id) } : {}),
    // AND IF THE SITE IS A TOME ZONE, THE ZONE BUILDS AND LIGHTS IT. See `zoneSite`.
    ...zoneSite(id, { floor, wall }),
  },
]);

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE SECOND MOOR, AND THE DOORS THAT SURVIVED ON IT.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `shared/redaction.ts` is the argument for the place; this is the wiring, and
 * there are only two pieces of it.
 *
 * ═══ THE MAP ITSELF IS A SITE LIKE ANY OTHER ═══
 * A `SiteDef` with `kind: Overworld`, which the boot loop builds exactly the
 * way it builds a town — one copy, made at startup, never reaped, everybody who
 * steps through the glyph is in the same one. The kind is doing real work: six
 * subsystems ask `realm.kind === RealmKind.Overworld` and every one of them is
 * a thing this place needs — the roamer tick, the fog reveal, the `explored`
 * frame, the region names, the exit marker and `leaveRealm`'s refusal. Building
 * it as `Common` would have typechecked, booted, been walkable, and silently
 * turned all six off. See the essay on `SiteDef.kind`.
 *
 * ═══ AND ITS DOORS ARE DERIVED, NOT AUTHORED ═══
 * Which of Alderbrook's sites came through the erasure is decided by the
 * erasure — `makeRedaction` keeps a site only if its cell survived AND is in
 * the one big walkable piece, so nothing over there can be marooned behind a
 * hole. Writing the survivors out by hand would be a second answer to that
 * question and would drift the moment the threshold moved.
 *
 * Each twin SPREADS its original, so it inherits the shape, the palette and —
 * the part that matters — the `populate` hook that puts monsters in it. Six
 * hand-written rows would have inherited none of that, and an empty delve is a
 * bug this repo has already shipped once.
 *
 * WHAT IT DELIBERATELY DOES NOT INHERIT IS ITS ID, and therefore: no shop
 * (`SHOP_SITES` is keyed by id), no townsfolk (`townsfolkFor` likewise), and a
 * generation seed of its own so the floor is not the same floor. Nothing sells
 * you anything in the Redaction and nobody lives there, which is not an
 * omission — it is what the place is.
 */
const REDACTION: SiteDef = {
  id: REDACTION_SITE_ID,
  name: 'The Redaction',
  kind: RealmKind.Overworld,
  // A DOOR, drawn with the same art as every other door. The thing on the far
  // side is unlike anything else in the game; the marker promising it should
  // look exactly like the ones that promise a mine, or the surprise is spent
  // before the player has walked anywhere.
  marker: 'gate',
  // THE SEED IS IGNORED, and that is the one difference from every other row.
  // A delve is rebuilt per instance and a town is built once from a seeded
  // generator; this map is a deterministic transformation of an authored one,
  // so there is nothing for a seed to vary. See `makeRedaction`.
  map: () => makeRedaction(),
  lingerMs: 0,
};

/**
 * The surviving doors, read off the map rather than listed.
 *
 * Built from its own `makeRedaction()` call and not from the realm's: this runs
 * at module load, before any realm exists, and the two agree because the
 * transform is pure — which is the property that lets a `shared/` module be the
 * single authority on what is over there.
 */
const REDACTED_SITES: readonly (readonly [string, SiteDef])[] = [
  ...makeRedaction().sites.values(),
].flatMap((twinId) => {
  const original = AUTHORED_SITES.find(
    ([id]) => id === twinId.replace(`${REDACTION_SITE_ID}:`, 'site:'),
  );
  // A twin with no original is a wiring bug rather than a runtime state, and
  // dropping it silently would leave a marker on the map that opens nothing.
  if (original === undefined) throw new Error(`no site behind ${twinId}`);
  const [originalId, def] = original;
  return [
    [
      twinId,
      {
        ...def,
        id: twinId,
        /**
         * ═════════════════════════════════════════════════════════════════════
         * `Inner` FOR ALL OF THEM, INCLUDING THE ONE THAT IS A TOWN.
         * ═════════════════════════════════════════════════════════════════════
         *
         * Threadneedle Row came through the erasure with its streets intact,
         * and inheriting `Common` would have built it on the far map as a
         * shared space: no shop (the shelves are keyed by site id), no
         * townsfolk (likewise), no monsters at all (a shared space asserts
         * there are none) and never reaped. Thirty tiles of empty street with
         * nothing to do — which reads as broken rather than as haunted.
         *
         * THERE ARE NO TOWNS IN THE REDACTION. That is not a limitation of the
         * wiring, it is the single clearest statement the place makes: the
         * Index took the country and everybody who lived in it, and what is
         * left standing is somewhere you go INTO rather than somewhere you
         * rest. See `redactedSpec` for what is in there instead.
         */
        kind: RealmKind.Inner,
        lingerMs: INSTANCE_LINGER_MS,
        /**
         * ═════════════════════════════════════════════════════════════════════
         * AND NOBODY IS STANDING IN IT TO ASK YOU FOR ANYTHING.
         * ═════════════════════════════════════════════════════════════════════
         *
         * The spread would have carried the original's `briefs`, and it must
         * not, for exactly the reason the note above gives about the shop and
         * the townsfolk: *"Nothing sells you anything in the Redaction and
         * nobody lives there, which is not an omission — it is what the place
         * is."* A brief is offered by a PERSON, in words, and there are no
         * people over there.
         *
         * WRITTEN OUT rather than left to the id lookup, because the twin
         * spreads a `SiteDef` that already resolved it. A lookup by twin id
         * would answer "none" today and would silently start answering
         * otherwise the moment somebody authored a brief against a twin.
         */
        briefs: undefined,
        /**
         * AND ITS OWN CONTENTS — the one thing deliberately not inherited.
         *
         * The spread would have carried the original's `populate`, which
         * closes over the ORIGINAL's spec, so every twin would have been its
         * Alderbrook counterpart with a different seed. `redactedSpec` keeps
         * the roster (The Underworks is husks on both maps) and raises the
         * counts, and it answers a town with a fight rather than with
         * `undefined`.
         */
        populate: (
          world: World,
          built: AuthoredMap,
          party: PartyStrength,
          _lead?: MonsterTemplate,
          floor = 1,
          scope?: PopulationScope,
        ): void => {
          const spec = redactedSpec(originalId);
          if (spec !== undefined) {
            populateDelve(world, built, forArea(spec, built), party, floor, scope);
          }
        },
      },
    ] as const,
  ];
});

/**
 * What the Undermost's last floor is made of: the cave's own two codes.
 *
 * `W` AND `p` ARE ORDINARY GROUND, and that is upstream's shape rather than a
 * shortcut: `defineTile(char, grid, obj, actor)`
 * (engine/generator/map/Static.lua:103-108) names a GRID and, separately, an
 * actor to stand on it, so a guardian's tile is floor with something on it. The
 * something is `UNDERMOST_GARRISON` in `content/undermost.ts`, and
 * `undermost.test.ts` walks the drawn rows against both tables so a glyph can
 * never reach one without the other.
 */
const UNDERMOST_LEGEND: Readonly<Record<string, Glyph>> = {
  '#': { tile: TileCode.CRAG },
  '.': { tile: TileCode.SOOT },
  '@': { tile: TileCode.SOOT, spawn: true },
  '>': { tile: TileCode.SOOT, site: EXIT_SITE_ID },
  W: { tile: TileCode.SOOT },
  p: { tile: TileCode.SOOT },
};

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE UNDERMOST — WHERE A NEW CHARACTER WAKES.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Upstream's Escape from Reknor (data/zones/reknor-escape/zone.lua): three
 * levels (:24), the first with no way back up (:67-69), the last drawn by hand
 * with the way out at its far end (:72-79) and no random population (:79). Here
 * the first two are caves and the last is `UNDERMOST_LAST_FLOOR`.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * AND IT IS ON THE MAP NOW. It said "ON NO MAP. Nothing leads here".
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `site:undermost` is a cell on the overworld — glyph `J` at (109,62), the
 * fields six tiles off Alderbrook's gate. See `ALDERBROOK_LEGEND` in
 * `shared/level.ts` for why it is that close and not, like the other three
 * additions, as far from everything as the map allows.
 *
 * The one place every character in this game has ever been was the only place
 * that was not a place: you woke in it, you climbed out of it, and then it
 * stopped existing. It is somewhere you can walk back to now, and it fills up
 * again while you are away like every other delve does — `lingerMs` is the
 * ordinary five minutes, so a party that leaves and comes back tomorrow finds a
 * cave generated afresh with a new warden holding the last door.
 *
 * ═══ AND IT IS STILL A ONE-WAY CLIMB — `noWayBack` STAYS ═══
 * Upstream replaces the first level's up stair with floor
 * (data/zones/reknor-escape/zone.lua:67-69) and that is the whole premise: the
 * only way out is forward, past whatever is holding the last door. Dropping the
 * flag to make the new overworld cell a two-way door would have put a SKIP
 * button on the intro — a character four minutes old could step off the tile it
 * woke on and be in the city with no levels, no gear and no idea — and would
 * have cost the tutorial the one thing it is for. A party that walks back in
 * later is walking into the same climb on purpose, and the way out is drawn on
 * the last floor where it always was.
 *
 * ═══ STILL THE BIRTHPLACE, AND STILL NOT IN THE CASE FILE ═══
 * `birthplace` is unchanged, so a new character is still put here rather than
 * walking here, and `world/casefile.ts` still excludes it: being a place on the
 * map does not make the room you woke up in a case you closed.
 */
const UNDERMOST_SITE: SiteDef = {
  id: UNDERMOST_SITE_ID,
  name: 'The Undermost',
  kind: RealmKind.Inner,
  marker: 'stair',
  noWayBack: true,
  birthplace: true,
  lingerMs: INSTANCE_LINGER_MS,
  ...lightingFor(SiteShape.Cave),
  map: (seed, _ground, floor = 1) => ({
    ...(floor >= floorsOfSite(UNDERMOST_SITE_ID)
      ? parseMap(UNDERMOST_LAST_FLOOR, UNDERMOST_LEGEND)
      : makeSiteMap(seed, SiteShape.Cave, { floor: TileCode.SOOT, wall: TileCode.CRAG })),
    /**
     * ═════════════════════════════════════════════════════════════════════════
     * AND THE CLIMB LEVELS YOU — data/zones/reknor-escape/zone.lua:83-95.
     * ═════════════════════════════════════════════════════════════════════════
     *
     * `if lev == 2 then game.player:forceLevelup(2) end` and the same for 3.
     * It is the escape's own staging and the reason ToME can put fifty bodies
     * in front of a four-minute-old character: the zone does not get harder as
     * you climb, YOU DO, one level per floor, on arrival, before the first turn.
     * See `AuthoredMap.forceLevel` and `forceLevelup`.
     *
     * `floor` IS THE NUMBER, and that is upstream's line rather than a
     * coincidence worth hiding: its `lev` is the level number and so is ours.
     * Floor 1 is absent because upstream's `on_enter` says nothing about level 1
     * — a character wakes there at whatever level it was born.
     *
     * ═══ WHAT THIS DOES NOT DO: BRING BACK 50-60 ═══
     * `DELVES` holds `site:undermost` at `{20, 30}` on floors 1-2 rather than
     * reknor-escape's own 50-60, and its note names the two things that pay for
     * that band: this, and NORGAN, who walks with the player and is levelled
     * beside them (`zone.lua:86-87`, :92-93). Half of the pair has landed. The
     * escort has not, so the row stays where the density pass measured it.
     */
    ...(floor >= 2 ? { forceLevel: floor } : {}),
  }),
  populate: (
    world: World,
    built: AuthoredMap,
    party: PartyStrength,
    _lead?: MonsterTemplate,
    floor = 1,
    scope?: PopulationScope,
  ): void => {
    /**
     * ═════════════════════════════════════════════════════════════════════════
     * AND THE LAST FLOOR IS POPULATED, WHICH IT WAS NOT.
     * ═════════════════════════════════════════════════════════════════════════
     *
     * This read `if (spec === undefined || floor >= floorsOf(spec)) return;`, so
     * the Undermost's third floor was never handed to `populateDelve` AT ALL —
     * no monsters, no litter, no lore note, and no boss on the one floor in the
     * game where upstream puts its set piece. Measured: 0.0 foes, 0 turns, 100%
     * hp, cleared 3/3 by all four classes. The intro was four bodies and an
     * empty hall.
     *
     * ═══ THE GUARD WAS THE RIGHT FACT IN THE WRONG PLACE ═══
     * Upstream's last level of the escape from Reknor genuinely places nothing
     * random: `levels[3].generator.actor.nb_npc = {0, 0}`
     * (`data/zones/reknor-escape/zone.lua:79`) because it is a STATIC map with
     * Brotoq and his guard drawn onto it. That is a statement about the COUNT,
     * and it lives in the spec's `nbNpcByFloor` now, where `populateDelve` can
     * see it. Returning early instead skipped the floor's litter and its note as
     * well, and — the part that mattered — skipped the `spec.boss` branch, which
     * `populateDelve` only ever runs on the last floor.
     *
     * SO FLOOR 3 STILL ROLLS NO ORDINARY BODIES, faithfully, and it now gets
     * everything else — including the fight the floor is drawn around.
     */
    const spec = specFor(UNDERMOST_SITE_ID);
    if (spec === undefined) return;
    populateDelve(world, built, forArea(spec, built), party, floor, scope);
    /**
     * ═════════════════════════════════════════════════════════════════════════
     * AND THE WAY OUT IS HELD. Upstream's last level, in one line.
     * ═════════════════════════════════════════════════════════════════════════
     *
     * `nb_npc = {0, 0}` on that level (data/zones/reknor-escape/zone.lua:79) is
     * not "the level is empty" — it is "nothing here is ROLLED", because the
     * bodies are drawn onto the map (data/maps/zones/reknor-escape-last.lua:34-35).
     * The line above rolls the nothing; this line places the drawn ones.
     *
     * NOT BEHIND `spec.boss`, deliberately. `populateDelve`'s boss branch puts
     * ONE body on the cell furthest from the door and that is right for a room
     * whose generator chose its own shape; this floor was drawn by hand so that
     * the fight could be composed — a warden, a picket at the hall's mouth and
     * two more beside him — and a spec field cannot say where four bodies
     * stand. See `DelveSpec.boss`, whose own note says a second boss must be
     * argued for: this is the argument, and it is that the set piece belongs to
     * the map rather than to the room.
     *
     * ═══ UNCONDITIONAL IN `scope`, WHICH IS WHAT A WIPE NEEDS ═══
     * `PopulationScope.Hostiles` is the re-seed after a party wipes, and
     * everything here IS hostiles. `resetFloor` has already reaped the old ones,
     * so this is the pass that puts the warden back — without it a party could
     * clear the hall by dying in it.
     */
    if (floor >= floorsOf(spec)) {
      populateUndermostHall(world, UNDERMOST_LAST_FLOOR, party, delveLevel(spec, party), floor);
    }
  },
};

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE INFINITY TOWER — the one door on this map with nothing behind it but more
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ToME's Infinite Dungeon (`data/zones/infinite-dungeon/zone.lua`), as a place
 * you walk to from the moor. `shared/mapgen/tower.ts` is the floors and the
 * chain between them and carries the argument for how they are derived; this is
 * the door, and the decisions a door has to make.
 *
 * ═══ WHY IT IS HAND-WRITTEN HERE AND NOT A ROW IN `AUTHORED_SITES` ═══
 * The same reason `UNDERMOST_SITE` is. That table's `.map` closure builds one
 * shape in one palette, and `zoneSite` refuses any site whose row's
 * `{floor, wall}` is not its zone's `palette` — the Tower's palette is a
 * different one of seventeen on every floor. It is also the reason
 * `shared/redaction.ts` skips its glyph: a twin would look this id up in
 * `AUTHORED_SITES` and find nothing.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE SIX DECISIONS, EACH WHERE ITS RULE LIVES
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ─── 1. WHERE IT IS ENTERED FROM ───
 * One authored cell in the northern snowfield, glyph `Y` at (57,4), NOT hidden.
 * The measurement and the argument are in `ALDERBROOK_LEGEND`.
 *
 * ─── 2. WHETHER A FLOOR PERSISTS ───
 * ITS KIND DOES, ITS GROUND DOES NOT, and that is a sharper answer than any
 * other delve can give. Floor 7 is a sylvan cavern for everybody forever
 * (`shared/mapgen/tower.ts` argues why the chain is derived rather than
 * rolled); the cavern itself is built from the realm's instance seed, so it
 * lives while the instance lives — `lingerMs` is the ordinary five minutes, and
 * `INSTANCE_LINGER_MS`'s own note is the argument — and is a different cavern
 * after that. Climbing back up from floor 40 therefore walks up through the
 * floors you came down, re-rolled: the same species of place, not the same
 * room, and nothing was ever left on the floor of one that survived the reap.
 * THIS IS NOT NEW BEHAVIOUR. It is what every delve here has always done; it is
 * merely the first one deep enough for anybody to notice.
 *
 * ─── 3. WHAT HAPPENS TO PROGRESS WHEN THEY LEAVE ───
 * NOTHING IS KEPT, AND THE NEXT ENTRY IS FLOOR 1. No character remembers a
 * floor of anything (`SavedPosition` is a stub), so this is the behaviour the
 * game already has rather than a rule invented for the Tower — but it is worth
 * stating, because a Tower you re-enter at floor 40 is a different game and
 * would be a save-format change rather than a content one. What a party keeps
 * is what a party always keeps: their levels, their bag and what they learnt.
 *
 * ─── 4. HOW DEEP THE SCALING STAYS SANE ───
 * `base_level` is pinned at 1 (`zone.lua:25-26`, and `DelveSpec` for why
 * `level_scheme = "player"` is inert on this zone), so every level of danger
 * comes from the floor number through `DelveSpec.depthScale` — upstream's
 * `math.floor((base_level + level.level-1) * 1.2)` (`:28`). Nothing clamps it
 * and nothing needs to: `actorAdjustLevel` floors at 1 and the life curve is
 * monotonic. The ceiling in this game is `MAX_CHARACTER_LEVEL`, which bounds
 * the PLAYER; a floor has no ceiling, which is the point of the place.
 *
 * ─── 5. WHETHER BRIEFS ARM HERE ───
 * NO, DELIBERATELY, AND THE MACHINERY WOULD WORK UNCHANGED. `content/briefs.ts`
 * carries the argument at the only place it can be read beside the briefs
 * themselves. In one line: every brief in this game is authored against a floor
 * somebody measured, and no Tower floor has been measured. No briefs also means
 * no temporary companion, since a companion arrives with one.
 *
 * ─── 6. WHAT THE PLAYER IS TOLD ABOUT HOW DEEP THEY ARE ───
 * `nameFor` puts the floor in the realm's name, so the arrival line and the
 * frame's title both carry it, and `markersFor` names the stair after the
 * terrain it leads into rather than *"Next level"* — upstream's own
 * *"Encroaching terrain: …"* tooltip (`zone.lua:312`), which is the whole
 * reason the exits carry a `desc`.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT OF `post_process` IS NOT HERE — so the next reader of the Lua does not
 * have to rediscover it by diffing.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The zone's `post_process` (`zone.lua:280-360`) does five things. Two of them
 * are argued at length where their machinery lives — the second way on and its
 * stair guard (`shared/mapgen/tower.ts`, `DELVES`) and the challenge roll
 * (`content/briefs.ts`). These three are not, and silence is what makes a
 * dropped clause look like one nobody noticed:
 *
 *   `special_level_faction = "enemies"` (`:35`, applied `:334` — *"Everything
 *   hates you in the infinite dungeon!"*, which rewrites the faction of every
 *   entity on the level). INERT TODAY and not for long: nothing friendly can be
 *   placed on a Tower floor, because briefs are off so no companion arrives and
 *   townsfolk are `Common`. It becomes wrong in silence the day the first Tower
 *   brief lands, which is a deferral this site already proposes.
 *
 *   `ID_HISTORY` lore (`:337-347`, `objects.lua:23-33`) — five notes, on floors
 *   1, 10, 20, 30 and 40, placed on a free tile adjacent to the UP stair.
 *   `content/lore.ts` and `populateDelve`'s note placement both exist, so this
 *   is content rather than machinery: five pieces of writing and a floor test.
 *
 *   `events_by_level = true` (`:34`) and `events.lua`'s twenty event types.
 *   There is no event system in this game at all, so this one is out of scope
 *   rather than deferred, and it is named here only because this row claims to
 *   be ported line for line and a reader counting fields would come up short.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * AND THE SEVENTH DECISION, A DELIBERATE DIVERGENCE: THE KNOT WORKS IN HERE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `no_worldport = true` (`data/zones/infinite-dungeon/zone.lua:32`), and
 * `SiteDef.noRecall` exists because of this zone — its own note says so. It is
 * still absent here, and that is argued rather than forgotten.
 *
 * UPSTREAM'S INFINITE DUNGEON HAS NO WAY OUT AT ALL. `no_worldport` refuses the
 * Rod of Recall (`Actor.lua:6918`, read at `quest-artifacts.lua:335`) and
 * `data.generator.map.up = vgrid.floor` (`:244`) draws the up grid as plain
 * floor, so no stair up is ever placed either. That is coherent because it is a
 * separate GAME MODE in ToME, played until the character dies.
 *
 * It is not coherent here. This is one door on a moor that four friends walk
 * into on a Tuesday evening and one of them has to go at nine. With recall
 * refused, the only way out of floor 40 is thirty-nine thresholds, each of
 * which rebuilds a floor that was reaped while they were below it — an hour of
 * walking through rooms nobody wanted, to leave.
 *
 * THE PRECEDENT IS ALREADY RULED. The Undermost diverges from the identical
 * upstream flag on reknor-escape (`SiteDef.noRecall`, the author on
 * 2026-09-17), on the grounds that *"you won, then died walking ten tiles"* is
 * not a game. The Tower's version is worse, because there is no "won".
 *
 * THE FAITHFUL VERSION, IF IT IS EVER WANTED, IS WRITTEN DOWN RATHER THAN
 * ARGUED AGAINST: `noRecall: true` AND a change to `leaveRealm`'s `above`
 * branch so that a Tower threshold returns to the moor from any floor. Then the
 * way out is the door you came in by rather than a magic word, the cost is the
 * walk back to the arrival tile, and nobody is stranded. That is closer to
 * upstream's Reknor exit than to a stair chain, and it is a gateway change
 * rather than a one-line flag, which is why it is not the first ship.
 */
const TOWER_SITE: SiteDef = {
  id: INFINITY_TOWER_SITE_ID,
  name: 'The Infinity Tower',
  kind: RealmKind.Inner,
  // THE `stair` FAMILY, as the Undermost and Cairnfoot use. A way down drawn as
  // a way down. Its own 32x32 is commissioned (ASSETS-REQUIRED.md) and until it
  // lands the family marker is what the client draws — see `landmarkIdFor`.
  marker: 'stair',
  lingerMs: INSTANCE_LINGER_MS,
  // See decision 6. The floor is the only progress this place has.
  nameFor: (floor: number): string => `The Infinity Tower, floor ${String(floor)}`,
  /**
   * NO `lighting` ON THE SITE, and that is not an omission: an absent
   * `SiteLighting` means LIT EVERYWHERE (`shared/light.ts`), which would be
   * wrong for most of the Tower. Every floor `towerLevel` builds carries its
   * own — the layout's `lite_room_chance`, which is 50 for the hewn rooms, 100
   * for a forest or a town, the building's own roll for a building, and nothing
   * at all for a maze, an octopus or a hexacle — and `open` reads the map's
   * before the site's.
   */
  map: (seed: string, _ground?: Ground, floor = 1): AuthoredMap => towerLevel(floor, seed),
  populate: (
    world: World,
    built: AuthoredMap,
    party: PartyStrength,
    _lead?: MonsterTemplate,
    floor = 1,
    scope?: PopulationScope,
  ): void => {
    const spec = specFor(INFINITY_TOWER_SITE_ID);
    if (spec === undefined) return;
    /**
     * ═════════════════════════════════════════════════════════════════════════
     * THE COUNT IS THE FLOOR'S LAYOUT'S, NOT THE ZONE'S — `zone.lua:255`.
     * ═════════════════════════════════════════════════════════════════════════
     *
     * `enemy_count = layout.enemy_count or math.ceil(vx * vy * 34/4900)`, and
     * two of the eight layouts state their own numerator: the forest at 40
     * (`:129`) and the building at 60 (`:161`). `nbNpcFor` multiplies the
     * floor's area by `nbNpcPerArea` and takes ±5 (`:256`), so handing it this
     * floor's own numerator reproduces `enemy_count` exactly — the area it
     * reads IS `vx * vy`, after the maze's rounding and the hexacle's squaring,
     * because the map was built at the table's own width and height.
     *
     * THE FOLD IS CHEAP AND THE MAP IS NOT. `towerFloorAt` re-walks the chain
     * rather than being handed the table `map()` rolled: it is a few dozen
     * draws per floor with no map in it, it is the same pure function `map()`
     * called, and the alternative is a field on `AuthoredMap` that exists for
     * one site.
     */
    const table = towerFloorAt(floor);
    /**
     * AND `forArea` IS NOT APPLIED, WHICH IS THE ONE PLACE THIS SITE DIFFERS
     * FROM EVERY OTHER `populate` IN THIS FILE.
     *
     * `forArea` scales a spec's LITTER and TRAPS off a 34x30 baseline, because
     * every band in `DELVES` was measured on a site of that size. This row's
     * bands are not ours and were not measured here: `nb_object = {6, 9}`
     * (`:93`) is upstream's own, stated flat over a level whose size this zone
     * ROLLS per floor (60 to 90 a side). Scaling it would multiply upstream's
     * six-to-nine by five and bury every floor in loot. The traps are absent
     * because `nb_trap = {0, 0}` (`:97`): this place lays none.
     */
    populateDelve(
      world,
      built,
      { ...spec, nbNpcPerArea: towerEnemyCountPerArea(table.layoutName) },
      party,
      floor,
      scope,
    );
  },
};

export const SITES: ReadonlyMap<string, SiteDef> = new Map([
  ...AUTHORED_SITES,
  [REDACTION_SITE_ID, REDACTION] as const,
  ...REDACTED_SITES,
  [UNDERMOST_SITE_ID, UNDERMOST_SITE] as const,
  [INFINITY_TOWER_SITE_ID, TOWER_SITE] as const,
]);

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
  /**
   * THE ONE SITE THAT IS NOT A PLACE. Every other row in `SITES` is somewhere
   * with an address, built the same way whichever direction you arrived from;
   * an ambush is a fight that happens WHERE YOU WERE, so it is the only map in
   * the game that asks what you were standing on. See `Ground` in shared/level.
   */
  map: (seed, ground) => makeArena(seed, ground),
  // ZERO, AND THIS IS THE FIELD THAT MAKES FLEEING MEAN SOMETHING. See
  // `SiteDef.lingerMs`: a breach you ran out of must not still be there.
  lingerMs: 0,
  populate: (world, map, party, lead) => {
    // AROUND THE ARRIVAL TILE, not at the authored coordinates. seedAmbush
    // explains why: the authored encounter is placed for a floor you EXPLORE,
    // and reusing it for an ambush drops the player in a corner with the
    // nearest monster nineteen tiles away -- off screen at this game's
    // viewport, which read in play as "the encounter has no enemies".
    const arrival = map.spawns[0] ?? {
      x: Math.floor(map.view.w / 2),
      y: Math.floor(map.view.h / 2),
    };
    // THE GROUND, READ BACK OFF THE ROOM THIS SITE JUST BUILT. `populate` is
    // handed the map and not the ground, and it does not need to be:
    // every ground paints a different floor, so the room is its own
    // record of what made it. See `arenaGround`.
    // AND THE ROAMER ITSELF, so the creature on the map is the creature in the
    // room. `ambushRoster` carries the argument for why this was worth fixing.
    seedAmbush(world, arrival, party, arenaGround(map), lead);
  },
};
