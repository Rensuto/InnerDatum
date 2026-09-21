// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// The zone under test is t-engine4 game/modules/tome/data/zones/infinite-dungeon/zone.lua.
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE INFINITY TOWER, WIRED — the decisions, driven through the real doors.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `test/shared/mapgen/tower.test.ts` is the chain and the ground. This is the
 * half that only exists once the generator has a caller: the depth the gateway
 * refuses at, the level the bodies are born at, the count the floor's own
 * layout asks for, what the case file counts, and what a party is told.
 *
 * Every one of these drives the shipped object — `SITES`, `Realms.open`,
 * `floorsOfSite`, `isFileable` — rather than a copy of its rule. The bug this
 * file exists to prevent is a correct generator with a door that never opens on
 * it, which is exactly the state `mapgen/infinite.ts` was in for a week.
 */

import { describe, expect, it } from 'vitest';

import { createDownedState } from '../../src/server/engine/downed.ts';
import { createPartyState } from '../../src/server/engine/party.ts';
import { IntentKind } from '../../src/server/engine/actor.ts';
import { submitIntent } from '../../src/server/engine/scheduler.ts';
import { createTurnEngine } from '../../src/server/turn-engine.ts';
import { PLACE_BLURBS } from '../../src/server/content/places.ts';
import {
  MAX_CHARACTER_LEVEL,
  RANK_WORTH,
  RANK_WORTH_INFINITE,
  XP_WORTH_MULT,
  expChart,
  worthExp,
} from '../../src/shared/progression.ts';
import {
  actorAdjustLevel,
  delveLevel,
  eligibleOn,
  floorsOf,
  floorsToWalk,
  nbNpcFor,
  populateDelve,
  specFor,
} from '../../src/server/content/delve.ts';
import type { DelveSpec } from '../../src/server/content/delve.ts';
import { createWorld } from '../../src/server/world/world.ts';
import type { AuthoredMap } from '../../src/shared/level.ts';
import { fileableCount, isFileable } from '../../src/server/world/casefile.ts';
import {
  INFINITY_TOWER_SITE_ID,
  RealmKind,
  SITES,
  STAIRS_DOWN_SITE_ID,
  createRealms,
  stairDownName,
  floorsOfSite,
  zoneOf,
} from '../../src/server/world/realms.ts';
import type { Realms, SiteDef } from '../../src/server/world/realms.ts';
import { RANK_VALUE, rankLevelAdjust } from '../../src/shared/leveling.ts';
import { makeOverworld } from '../../src/shared/level.ts';
import { towerEnemyCountPerArea } from '../../src/shared/mapgen/infinite.ts';
import { TOWER_DEPTH_SCALE, TOWER_MAX_FLOOR, towerFloorAt } from '../../src/shared/mapgen/tower.ts';
import { ActorKind, ActorRank, TileCode } from '../../src/shared/protocol.ts';
import { createRng } from '../../src/shared/rng.ts';
import type { Rng } from '../../src/shared/rng.ts';

const TOWER: SiteDef = (() => {
  const site = SITES.get(INFINITY_TOWER_SITE_ID);
  if (site === undefined) throw new Error('the Tower is not in SITES');
  return site;
})();

function makeRealms(seed = 'tower-test'): Realms {
  const downed = createDownedState();
  const parties = createPartyState();
  return createRealms({
    seed,
    engineFor: (world) => createTurnEngine({ world, downed, parties }),
  });
}

/** A generator whose `rng.int` is a fixed number, so a jitter can be pinned. */
function fixedInt(n: number): Rng {
  const base = createRng('fixed');
  return { ...base, int: () => n };
}

/** The first floor of the prefix whose table has this layout. */
function floorWithLayout(layout: string, within = 40): number {
  for (let floor = 1; floor <= within; floor += 1) {
    if (towerFloorAt(floor).layoutName === layout) return floor;
  }
  throw new Error(`no ${layout} floor in the first ${String(within)}`);
}

describe('the door on the moor', () => {
  it('is a cell on the overworld, in the snow, and nobody is keeping it secret', () => {
    const moor = makeOverworld();
    const cells = [...moor.sites.entries()].filter(([, id]) => id === INFINITY_TOWER_SITE_ID);
    expect(cells).toHaveLength(1);
    const [cell] = cells;
    if (cell === undefined) throw new Error('unreachable');
    const [x, y] = cell[0].split(',').map(Number);
    if (x === undefined || y === undefined) throw new Error('a cell with no coordinates');
    expect(moor.view.tiles[y * moor.view.w + x]).toBe(TileCode.SNOWFIELD);
    // See `SiteDef.hidden`: the three hidden places reward looking, and the one
    // place with no bottom is not one of them.
    expect(TOWER.hidden).toBeUndefined();
    expect(TOWER.kind).toBe(RealmKind.Inner);
  });

  /**
   * `shared/redaction.ts` skips this glyph. Without the skip, `REDACTED_SITES`
   * looks the twin's original up in `AUTHORED_SITES` — where the Tower is not,
   * because it is hand-written beside the Undermost — and throws at module load.
   */
  it('has no twin on the dark moor', () => {
    const twins = [...SITES.keys()].filter((id) => id.includes('infinity_tower'));
    expect(twins).toEqual([INFINITY_TOWER_SITE_ID]);
  });
});

describe('the descent has no bottom', () => {
  /**
   * `max_level = 1000000000` (`zone.lua:27`). Three readers depend on it:
   * `withStairsDown` draws a stair on every floor, `goDown` refuses at
   * `floor >= floorsOfSite(siteId)` and never reaches it, and the case file
   * asks the same question to decide what can be closed.
   */
  it('is upstream`s billion floors deep, where every other delve is three or four', () => {
    expect(floorsOfSite(INFINITY_TOWER_SITE_ID)).toBe(TOWER_MAX_FLOOR);
    for (const [id, site] of SITES) {
      if (site.kind !== RealmKind.Inner || id === INFINITY_TOWER_SITE_ID) continue;
      expect(floorsOfSite(id), id).toBeLessThanOrEqual(4);
    }
  });

  it('draws a way down on a floor that would be the last of any other delve', () => {
    const realms = makeRealms('deep-stair');
    for (const floor of [1, 4, 17]) {
      const realm = realms.open(
        TOWER,
        `party-${String(floor)}`,
        { level: 5, size: 2 },
        undefined,
        undefined,
        floor,
      );
      const stairs = [...realm.sites.values()].filter((id) => id === STAIRS_DOWN_SITE_ID);
      expect(stairs, `floor ${String(floor)}`).toHaveLength(1);
    }
  });

  it('keeps the floors of one party`s Tower apart, and hands the same one back', () => {
    const realms = makeRealms('idempotent');
    const a = realms.open(TOWER, 'party', { level: 3, size: 3 }, undefined, undefined, 5);
    const again = realms.open(TOWER, 'party', { level: 3, size: 3 }, undefined, undefined, 5);
    const below = realms.open(TOWER, 'party', { level: 3, size: 3 }, undefined, undefined, 6);
    expect(again.id).toBe(a.id);
    expect(below.id).not.toBe(a.id);
    expect(below.floor).toBe(6);
  });

  /**
   * DECISION: a floor's KIND persists and its GROUND does not. The realm id
   * carries a monotonic instance number and the seed is derived from it, so a
   * reaped floor is re-rolled — which is what every delve here has always done.
   * What the Tower adds is that the floor comes back as the SAME KIND of place,
   * because the chain is derived rather than remembered.
   */
  it('re-opens a reaped floor as a new map of the same kind of place', () => {
    const realms = makeRealms('reaped');
    const first = realms.open(TOWER, 'party', { level: 3, size: 3 }, undefined, undefined, 9);
    const wasName = first.name;
    const wasTiles = [...first.world.level.tiles];
    for (const body of first.world.allActors()) first.world.removeActor(body.id);
    expect(realms.close(first.id)).toBe(true);
    const again = realms.open(TOWER, 'party', { level: 3, size: 3 }, undefined, undefined, 9);
    expect(again.id).not.toBe(first.id);
    // The same floor of the same Tower...
    expect(again.name).toBe(wasName);
    expect([again.world.level.w, again.world.level.h]).toEqual([
      first.world.level.w,
      first.world.level.h,
    ]);
    // ...and not the same room.
    expect([...again.world.level.tiles]).not.toEqual(wasTiles);
  });
});

describe('how deep you are, said out loud', () => {
  /**
   * DECISION: the realm's name carries the floor. Nothing in this game has ever
   * told a player how deep they are — `announceArrival` sends `realm.name`,
   * which is `site.name` on every floor of every site — and depth is the
   * Tower's only progress.
   */
  it('names the floor in the realm name, which is what the arrival line says', () => {
    const realms = makeRealms('named');
    for (const floor of [1, 12]) {
      const realm = realms.open(
        TOWER,
        `p${String(floor)}`,
        { level: 1, size: 1 },
        undefined,
        undefined,
        floor,
      );
      expect(realm.name).toContain(TOWER.name);
      expect(realm.name).toContain(String(floor));
    }
    // And nothing else changed: a delve is still called what it is called.
    const underworks = SITES.get('site:underworks');
    if (underworks === undefined) throw new Error('no Underworks');
    const other = makeRealms('named-2').open(
      underworks,
      'p',
      { level: 3, size: 1 },
      undefined,
      undefined,
      2,
    );
    expect(other.name).toBe(underworks.name);
  });

  /**
   * DECISION: the stair says where it goes. Upstream writes the destination's
   * own words on the way on — `"Encroaching terrain: "..grids.desc..layout.desc`
   * (`zone.lua:312`) — and draws the stair in the destination's floor code
   * (`:246`), so a label reading *"Next level"* was contradicting the tile it
   * stood on. See `stairDownName`.
   */
  it('names the stair after the terrain it leads into, and only in the Tower', () => {
    const realms = makeRealms('stair-name');
    for (const floor of [1, 5, 23]) {
      const realm = realms.open(
        TOWER,
        `p${String(floor)}`,
        { level: 1, size: 1 },
        undefined,
        undefined,
        floor,
      );
      const name = stairDownName(realm);
      expect(name, `floor ${String(floor)}`).not.toBe('Next level');
      expect(name, `floor ${String(floor)}`).toContain(towerFloorAt(floor).exits[0].desc);
      // AND IT IS THE FIRST EXIT, which is the one the stair leads to.
      const other = towerFloorAt(floor).exits[1].desc;
      if (other !== towerFloorAt(floor).exits[0].desc) expect(name).not.toContain(other);
    }
    // EVERY OTHER PLACE KEEPS UPSTREAM'S OWN WORD FOR ITS DOWN GRID.
    const underworks = SITES.get('site:underworks');
    if (underworks === undefined) throw new Error('no Underworks');
    const delve = makeRealms('stair-name-2').open(
      underworks,
      'p',
      { level: 3, size: 1 },
      undefined,
      undefined,
      1,
    );
    expect(stairDownName(delve)).toBe('Next level');
  });
});

describe('the level the bodies are born at', () => {
  const spec = specFor(INFINITY_TOWER_SITE_ID);
  if (spec === undefined) throw new Error('the Tower has no DelveSpec');

  /**
   * `level_range = {1, 1}` with `level_scheme = "player"` (`zone.lua:25-26`),
   * and `Zone:updateBaseLevel` is `util.bound(plev, 1, 1)`
   * (`engine/Zone.lua:141-148`) — so the scheme is INERT and `base_level` is 1
   * for everybody. The word "player" promises otherwise, which is why it is
   * asserted rather than assumed.
   */
  it('stands at base level 1 for a level-1 Watchman and a level-40 Inspector alike', () => {
    for (const level of [1, 5, 20, 40]) {
      expect(delveLevel(spec, { level, size: 4 })).toBe(1);
    }
  });

  /**
   * `math.floor((zone.base_level + level.level-1) * 1.2)` (`zone.lua:28`),
   * written out here rather than imported so the port cannot certify itself.
   * Every other zone in the game is the same line without the multiply.
   */
  it('multiplies depth by 1.2, at floor 1, 10, 100 and a floor nobody will reach', () => {
    const upstream = (floor: number): number => Math.floor((1 + floor - 1) * 1.2);
    for (const floor of [1, 10, 100, 1000, 1000000, TOWER_MAX_FLOOR]) {
      expect(
        actorAdjustLevel(fixedInt(0), 'x', 1, ActorRank.Normal, floor, spec.depthScale),
        `floor ${String(floor)}`,
      ).toBe(upstream(floor));
    }
    // The gap is the whole point: a straight line puts floor 100 at 100.
    expect(actorAdjustLevel(fixedInt(0), 'x', 1, ActorRank.Normal, 100, spec.depthScale)).toBe(120);
    expect(actorAdjustLevel(fixedInt(0), 'x', 1, ActorRank.Normal, 100)).toBe(100);
    expect(spec.depthScale).toBe(TOWER_DEPTH_SCALE);
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * AND THE ROOM IS NEVER EMPTY, HOWEVER DEEP — which a place with no bottom is
   * the only place in this game that can get wrong.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `Zone:makeEntity` weights each candidate by its `level_range` against the
   * floor's `resolvers.current_level`, and a candidate far enough out of depth
   * DROPS OUT: `genprob = math.floor(max / rarity)` with `genprob > 0`
   * (`engine/Zone.lua:218-221`, `:243`). `INDEX_HUSK` is `levelRange [1, 15]`,
   * so it thins with depth and eventually goes — which is right, and which is
   * also how a roster of three could become a roster of none at floor 500 and
   * leave `populateDelve` placing nobody on a floor with a count of forty.
   *
   * THE FILTER LEVEL IS NOT SCALED, and that is upstream too: `current_level`
   * is `base_level + level.level - 1` (`engine/Zone.lua:1031`), while the ×1.2
   * is in `actor_adjust_level`, which runs later and only decides what level
   * the chosen body is BORN at.
   */
  it('always has somebody eligible to stand on the floor, at any depth', () => {
    for (const floor of [1, 10, 100, 1000, 1000000, TOWER_MAX_FLOOR]) {
      const list = eligibleOn(spec, floor);
      expect(list.entries.length, `floor ${String(floor)}`).toBeGreaterThan(0);
      expect(list.total, `floor ${String(floor)}`).toBeGreaterThan(0);
    }
  });

  it('leaves every other delve on the straight line it has always been on', () => {
    for (const [id, site] of SITES) {
      if (site.kind !== RealmKind.Inner || id === INFINITY_TOWER_SITE_ID) continue;
      expect(specFor(id)?.depthScale, id).toBeUndefined();
    }
  });

  /**
   * AND THE PLACER ACTUALLY USES IT. The two assertions above are about the
   * function; this one is about the wire between the spec and the bodies, which
   * is where a `depthScale` that never reaches `actorAdjustLevel` would hide.
   * At floor 60 the two formulas cannot overlap: a straight line tops out at
   * 60 + 3 + 2 = 65, and 1.2 starts at 72 - 1 = 71.
   */
  it('puts the multiplier on the bodies a real floor is populated with', () => {
    const realms = makeRealms('deep-bodies');
    const floor = 60;
    const realm = realms.open(TOWER, 'party', { level: 10, size: 3 }, undefined, undefined, floor);
    const bodies = realm.world.allActors().filter((a) => a.kind === ActorKind.Monster);
    expect(bodies.length).toBeGreaterThan(0);
    const depth = Math.floor(floor * TOWER_DEPTH_SCALE);
    const topRank = rankLevelAdjust(RANK_VALUE[ActorRank.Boss]);
    for (const body of bodies) {
      expect(body.level, body.id).toBeGreaterThanOrEqual(depth - 1);
      expect(body.level, body.id).toBeLessThanOrEqual(depth + 2 + topRank);
    }
    // The straight line would have put every one of them at or under this.
    expect(Math.min(...bodies.map((b) => b.level))).toBeGreaterThan(floor + 2 + topRank);
  });
});

describe('how many, and how much of it', () => {
  const spec = specFor(INFINITY_TOWER_SITE_ID);
  if (spec === undefined) throw new Error('the Tower has no DelveSpec');

  /**
   * `enemy_count = layout.enemy_count or math.ceil(vx * vy * 34/4900)`
   * (`zone.lua:255`) and `nb_npc = {enemy_count-5, enemy_count+5}` (`:256`).
   * Two of the eight layouts override the numerator — forest 40 (`:129`),
   * building 60 (`:161`) — so a Tower that used the zone's 34 everywhere would
   * under-fill exactly the two layouts upstream fills hardest.
   */
  it('reads the numerator off the FLOOR`s layout table, not off the zone`s default', () => {
    expect(towerEnemyCountPerArea('forest')).toBe(40);
    expect(towerEnemyCountPerArea('building')).toBe(60);
    for (const other of ['default', 'cavern', 'maze', 'town', 'octopus', 'hexa'] as const) {
      expect(towerEnemyCountPerArea(other), other).toBe(34);
    }
    for (const layout of ['default', 'forest', 'building'] as const) {
      const floor = floorWithLayout(layout);
      const table = towerFloorAt(floor);
      const band = nbNpcFor(
        { ...spec, nbNpcPerArea: towerEnemyCountPerArea(table.layoutName) },
        floor,
        table.width * table.height,
      );
      expect(band, `floor ${String(floor)} (${layout})`).toEqual([
        Math.max(0, table.enemyCount - 5),
        table.enemyCount + 5,
      ]);
      // And the zone's own default would have been a different answer on the
      // two layouts that override it.
      const flat = nbNpcFor({ ...spec }, floor, table.width * table.height);
      if (layout === 'default') expect(flat).toEqual(band);
      else expect(flat, layout).not.toEqual(band);
    }
  });

  /**
   * AND THIS IS THE JOIN — the case above is about `towerEnemyCountPerArea` and
   * `nbNpcFor`, both of which can be right while nothing wires them together.
   * This opens the real realm and counts the bodies `TOWER_SITE.populate` put
   * on it, so a `populate` that forgot to pass the floor's numerator fails HERE
   * and only here.
   */
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * AND THE TWO AUTHORED ROWS THAT BORROW A TOWER LAYOUT BORROW ITS NUMBER.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Gearford Ward is the Infinite Dungeon's BUILDING layout on an authored site
   * and the redacted town is its TOWN layout, so each takes that layout's own
   * `enemy_count` numerator — 60 (`zone.lua:161`) and the zone default 34
   * (`:255`). Both were spelled as bare literals on their rows under a comment
   * in `mapgen/infinite.ts` promising "one place to change and one place to be
   * wrong", and NOTHING ANYWHERE ASSERTED EITHER VALUE: a mutation swapping
   * Gearford's 60 for 34 passed every file that mentions `nbNpcPerArea`,
   * because each of them recomputes the band FROM the field and so can never
   * pin the field.
   */
  it('lends its layouts` numerators to the two authored rows that use them', () => {
    const gearford = specFor('site:gearford_ward');
    const town = specFor('site:redaction:alderbrook');
    expect(gearford?.nbNpcPerArea, 'Gearford is the building layout').toBe(60);
    expect(gearford?.nbNpcPerArea).toBe(towerEnemyCountPerArea('building'));
    expect(town?.nbNpcPerArea, 'the redacted town is the town layout').toBe(34);
    expect(town?.nbNpcPerArea).toBe(towerEnemyCountPerArea('town'));
  });

  it('fills a forest floor and a building floor to the band the floor asks for', () => {
    const realms = makeRealms('counts');
    for (const layout of ['forest', 'building'] as const) {
      const floor = floorWithLayout(layout);
      const table = towerFloorAt(floor);
      const realm = realms.open(
        TOWER,
        `p-${layout}`,
        { level: 5, size: 1 },
        undefined,
        undefined,
        floor,
      );
      const bodies = realm.world.allActors().filter((a) => a.kind === ActorKind.Monster).length;
      expect(bodies, `${layout} floor ${String(floor)}`).toBeGreaterThanOrEqual(
        Math.max(0, table.enemyCount - 5),
      );
      expect(bodies, `${layout} floor ${String(floor)}`).toBeLessThanOrEqual(table.enemyCount + 5);
    }
  });

  /**
   * `nb_object = {6, 9}` (`zone.lua:93`), FLAT, over a level whose size this
   * zone rolls per floor. `forArea` scales every other delve's litter off a
   * 34x30 baseline because those bands were measured here; scaling upstream's
   * would multiply six-to-nine by five on a 90x90 floor.
   */
  it('scatters upstream`s six to nine pieces, whatever size the floor rolled', () => {
    expect(spec.litter).toEqual([6, 9]);
    const realms = makeRealms('litter');
    // The biggest floor in the prefix, where an area scale would be loudest.
    let widest = 1;
    for (let floor = 1; floor <= 40; floor += 1) {
      const table = towerFloorAt(floor);
      const best = towerFloorAt(widest);
      if (table.width * table.height > best.width * best.height) widest = floor;
    }
    const realm = realms.open(TOWER, 'p', { level: 5, size: 1 }, undefined, undefined, widest);
    const onTheFloor = realm.world.groundItems().length;
    expect(onTheFloor).toBeGreaterThanOrEqual(6);
    expect(onTheFloor).toBeLessThanOrEqual(9);
  });

  /** `nb_trap = {0, 0}` (`zone.lua:97`). The Tower lays none. */
  it('lays no traps at all', () => {
    expect(spec.traps).toBeUndefined();
    const realms = makeRealms('traps');
    const realm = realms.open(TOWER, 'p', { level: 5, size: 1 }, undefined, undefined, 3);
    expect(realm.world.traps()).toEqual([]);
  });
});

describe('the rules a door has to carry', () => {
  /**
   * DECISION, AND A DELIBERATE DIVERGENCE: `no_worldport = true`
   * (`zone.lua:32`) and the Knot still works in here. Upstream's Infinite
   * Dungeon has no way out AT ALL — it also never draws a stair up (`:244`) —
   * because it is a separate game mode played until the character dies. This is
   * one door on a moor that four friends walk into on a Tuesday. See
   * `TOWER_SITE` for the whole argument and for the faithful version, written
   * down rather than argued against.
   *
   * THE TITLE IS WHAT THIS ASSERTS AND NOTHING MORE — two flags, on the site
   * and on the realm built from it. It does NOT pull a Knot; the Knot's own
   * behaviour is `test/server/elsewhere.test.ts`, over a socket, including the
   * case that proves a wind-up burnt by WALKING comes out onto the moor rather
   * than back through the door.
   */
  it('refuses nothing to the Knot: neither the site nor a deep realm sets noRecall', () => {
    expect(TOWER.noRecall).toBeUndefined();
    const realms = makeRealms('recall');
    const realm = realms.open(TOWER, 'p', { level: 5, size: 1 }, undefined, undefined, 30);
    expect(realm.noRecall).toBe(false);
  });

  /** And the way back up is a threshold like any other: this is not Reknor. */
  it('is not one-way', () => {
    expect(TOWER.noWayBack).toBeUndefined();
  });

  /**
   * DECISION: no briefs, so no temporary companion either. `content/briefs.ts`
   * carries the reason — every brief is authored against a floor somebody
   * measured, and no Tower floor has been measured.
   */
  it('offers no objectives, deliberately', () => {
    expect(TOWER.briefs).toBeUndefined();
    const realms = makeRealms('briefs');
    const realm = realms.open(TOWER, 'p', { level: 5, size: 1 }, undefined, undefined, 3);
    expect(realm.briefs).toEqual([]);
  });

  /**
   * A case closes on the last floor and this place has none, so counting it
   * would put an entry in every file that nobody could ever close — on the one
   * screen a player reads to feel they are getting somewhere.
   */
  it('is not a case, and does not move the number every file is counted against', () => {
    expect(isFileable(TOWER)).toBe(false);
    const withoutIt = new Map(SITES);
    withoutIt.delete(INFINITY_TOWER_SITE_ID);
    expect(fileableCount(SITES)).toBe(fileableCount(withoutIt));
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * AND THE ONE THING AN ENDLESS PLACE BREAKS IN A CODEBASE THAT HAD NONE.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `floorsOf` is asked as a BOUND everywhere in `src/` — `goDown` refuses at
   * it, `withStairsDown` withholds a stair at it, the case file closes at it —
   * and none of those enumerate. Tests and probes DO: four of them walked
   * `for (floor = 1; floor <= floorsOf(spec))` and a billion is not a slow loop,
   * it is a hang. `floorsToWalk` is the bound for a caller that walks, and for
   * every place with a bottom it must be the same number, or it would quietly
   * stop testing the last floor of every delve in the game.
   */
  it('bounds a walk over the floors, and changes nothing for a place with a bottom', () => {
    const tower = specFor(INFINITY_TOWER_SITE_ID);
    if (tower === undefined) throw new Error('the Tower has no DelveSpec');
    expect(floorsToWalk(tower)).toBeLessThan(floorsOf(tower));
    expect(floorsToWalk(tower)).toBeGreaterThan(0);
    let withBottoms = 0;
    for (const [id, site] of SITES) {
      if (site.kind !== RealmKind.Inner || id === INFINITY_TOWER_SITE_ID) continue;
      const spec = specFor(id);
      if (spec === undefined) continue;
      withBottoms += 1;
      expect(floorsToWalk(spec), id).toBe(floorsOf(spec));
    }
    expect(withBottoms, 'no delve with a bottom was checked').toBeGreaterThan(10);
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * AND THE MOOR HAS A LINE FOR IT — keyed by a bare literal, on purpose.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `content/places.ts` writes every key as a string so that the table imports
   * nothing and cannot fail at module-eval time, and the one coverage it had
   * (`rumour.test.ts`) skips every site that is not hidden — which the Tower
   * deliberately is not. So a typo in that one literal would ship a marker on
   * the moor with nothing to say and nothing anywhere would go red.
   */
  it('has something to say on the moor, under the id the rest of the game uses', () => {
    expect(PLACE_BLURBS.get(INFINITY_TOWER_SITE_ID)).toBeDefined();
    expect(PLACE_BLURBS.get(INFINITY_TOWER_SITE_ID)).not.toBe('');
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * AND HOW MUCH OF IT THE PARTY HOLDS AT ONCE — the second thing an endless
   * place breaks in a codebase that had only ever had places with a bottom.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `zoneOf` is read only by the reap (`reapIfEmpty` arms every floor it
   * returns, and the fire-time check refuses to close one while anybody of the
   * party is on another), so what it returns IS what stays in memory. Upstream's
   * `persistent = "zone"` keeps every level of a zone while the party is in it,
   * which is right for three or four floors and means KEEP EVERYTHING, FOREVER
   * for a billion.
   *
   * Measured over a socket before the window: 30 floors descended, 30 realms
   * live, 138,295 tiles, nothing reaped. After: 5 live, 25,053 tiles, and the
   * rest closed on the ordinary linger they started when they emptied.
   */
  it('holds a window of floors open, not every floor the party has walked', () => {
    const realms = makeRealms('zone-window');
    const deepest = 9;
    let deep = realms.open(TOWER, 'party', { level: 5, size: 1 }, undefined, undefined, 1);
    for (let floor = 2; floor <= deepest; floor += 1) {
      deep = realms.open(TOWER, 'party', { level: 5, size: 1 }, undefined, undefined, floor);
    }
    const held = zoneOf(realms, deep)
      .map((r) => r.floor)
      .sort((a, b) => (a ?? 0) - (b ?? 0));
    expect(held.length).toBeLessThan(deepest);
    expect(held).toContain(deepest);
    // Contiguous, ending at the floor being asked about: the window is around
    // the floor, not the first N floors of the site.
    expect(held[0]).toBeGreaterThan(1);
  });

  /**
   * AND A PLACE WITH A BOTTOM KEEPS ITS WHOLE ZONE, which is upstream's rule
   * untouched. The window only exists because one site is deeper than any zone
   * the rule was written for; if it ever narrowed a real delve it would be a
   * regression in the opposite direction.
   */
  it('changes nothing for a delve that has a bottom', () => {
    const realms = makeRealms('zone-bounded');
    const site = SITES.get('site:underworks');
    if (site === undefined) throw new Error('the Underworks is not in SITES');
    const floors = floorsOfSite('site:underworks');
    expect(floors, 'a one-floor delve cannot test this').toBeGreaterThan(1);
    let last = realms.open(site, 'party', { level: 5, size: 1 }, undefined, undefined, 1);
    for (let floor = 2; floor <= floors; floor += 1) {
      last = realms.open(site, 'party', { level: 5, size: 1 }, undefined, undefined, floor);
    }
    expect(zoneOf(realms, last)).toHaveLength(floors);
  });

  it('is the one row in DELVES that states its own depth', () => {
    for (const [id, site] of SITES) {
      if (site.kind !== RealmKind.Inner) continue;
      const spec = specFor(id);
      if (spec === undefined) continue;
      if (id === INFINITY_TOWER_SITE_ID) expect(floorsOf(spec)).toBe(TOWER_MAX_FLOOR);
      else expect(spec.maxFloors, id).toBeUndefined();
    }
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT A BODY IN HERE IS WORTH — Actor.lua:6519, the branch we ported past.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `worthExp` is ONE upstream function with TWO rank ladders and
 * `if not game.zone.infinite_dungeon then` choosing between them. The Tower
 * shipped `zone.lua:28`'s multiplier on the body levels without `:33`'s flag on
 * the payout — the difficulty half of upstream's bargain with the reward half
 * left behind. Measured on the built floors before the fix: clearing one paid
 * 0.5 to 0.7 character levels from floor 35 down against the 1.2 a floor the
 * bodies gain, so a descending party fell behind and never caught up.
 */
describe('the other ladder', () => {
  it('is the one place in the game that takes it', () => {
    expect(specFor(INFINITY_TOWER_SITE_ID)?.infiniteDungeon).toBe(true);
    for (const [id, site] of SITES) {
      if (site.kind !== RealmKind.Inner || id === INFINITY_TOWER_SITE_ID) continue;
      expect(specFor(id)?.infiniteDungeon, id).toBeUndefined();
    }
  });

  /** Actor.lua:6533-6539 against :6521-6527, on the three ranks that exist. */
  it('pays a normal 2, an elite 3.5 and a boss 6', () => {
    expect(RANK_WORTH_INFINITE[ActorRank.Normal]).toBe(2);
    expect(RANK_WORTH_INFINITE[ActorRank.Elite]).toBe(3.5);
    expect(RANK_WORTH_INFINITE[ActorRank.Boss]).toBe(6);
    // THE SHAPE, not just the digits: rank and file pay MORE and set pieces pay
    // much LESS, which is what a place with no set pieces in it needs.
    expect(RANK_WORTH_INFINITE[ActorRank.Normal]).toBeGreaterThan(RANK_WORTH[ActorRank.Normal]);
    expect(RANK_WORTH_INFINITE[ActorRank.Boss]).toBeLessThan(RANK_WORTH[ActorRank.Boss]);
  });

  /**
   * THE BODIES CARRY IT, which is the wire between the row and the corpse.
   * `populateDelve` passes `spec.infiniteDungeon` to `monsterInit`, which puts
   * it on the actor, which is where the payout reads it — see
   * `MonsterActor.infiniteDungeon` for why the corpse rather than the zone.
   */
  it('marks every body a Tower floor is populated with', () => {
    const realms = makeRealms('ladder-bodies');
    const realm = realms.open(TOWER, 'p', { level: 10, size: 2 }, undefined, undefined, 12);
    const bodies = realm.world.allActors().filter((a) => a.kind === ActorKind.Monster);
    expect(bodies.length).toBeGreaterThan(10);
    for (const body of bodies) expect(body.infiniteDungeon, body.id).toBe(true);
  });

  it('marks nothing anywhere else', () => {
    const realms = makeRealms('ladder-elsewhere');
    const other = SITES.get('site:underworks');
    if (other === undefined) throw new Error('the Underworks is not in SITES');
    const realm = realms.open(other, 'p', { level: 10, size: 2 }, undefined, undefined, 1);
    const bodies = realm.world.allActors().filter((a) => a.kind === ActorKind.Monster);
    expect(bodies.length).toBeGreaterThan(0);
    for (const body of bodies) expect(body.infiniteDungeon, body.id).toBeUndefined();
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * DOES THE DESCENT PAY FOR ITSELF? — the endless place's version of
   * `levelling-curve.test.ts`'s "two levels before the boss".
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * That rule is a TOTAL over a delve with a bottom, and this place has none,
   * so the equivalent is a RATE. Upstream sets the bar itself: a floor's own
   * level rises by `depthScale` per floor (`zone.lua:28`), so a floor that pays
   * less than one character level is a floor the party finishes further behind
   * than they started it, forever, with no last floor to stop on.
   *
   * ═══ WHAT IS MEASURED, AND WHAT IS ASSUMED ═══
   * Every body on a real floor, killed — the CEILING of what the floor can pay,
   * so a failure here is unarguable. The detective stands at the level the floor
   * demands (`depthScale * floor`, capped by `MAX_CHARACTER_LEVEL`), because
   * that is the party that is keeping up, and because `worthExp`'s anti-farming
   * floor makes any other reading a measurement of the wrong thing.
   *
   * This reads the flag off each body and pays it as `payParty` does. The WIRE
   * is not what this case is for — the kill below is — so the one copied line
   * is deliberate and the two cannot drift, because the kill drives the real
   * scheduler over the same population.
   *
   * ═══ THE NUMBERS, at this file's fixed seed, three parties per floor ═══
   *
   *     floor  char   what one floor pays, in character levels
   *                   on `RANK_WORTH`    on `RANK_WORTH_INFINITE`
   *       25    30      0.93               1.68
   *       35    42      0.59               1.19
   *       40    48      0.70               1.28
   *
   * THREE PARTIES AND NOT ONE, because a single floor's roll is noisy enough to
   * move either side of a threshold: floor 25 alone came out at 0.81 and 1.02
   * on two different instances of the same seed. Three instances is still
   * deterministic — same seed, same sequence, same answer every run — and it is
   * measuring the zone rather than one draw.
   *
   * So on the ordinary ladder the deep Tower pays well under the 1.2 levels its
   * own bodies gain per floor: the party falls behind about half a level a
   * floor and never catches up, which is exactly what shipping `depthScale`
   * without `infiniteDungeon` did. On upstream's own ladder every one of them
   * clears a whole level. THIS CASE IS WHY THE FLAG IS ON THE ROW.
   */
  it('pays at least a character level on the deep floors, which the ordinary ladder does not', () => {
    const realms = makeRealms('tower-economy');
    for (const floor of [25, 35, 40]) {
      const char = Math.min(MAX_CHARACTER_LEVEL, Math.floor(TOWER_DEPTH_SCALE * floor));
      const costOfALevel = expChart(char);
      const where = `floor ${String(floor)} at character level ${String(char)}`;

      let paid = 0;
      let ordinary = 0;
      let seen = 0;
      for (const party of ['a', 'b', 'c']) {
        const realm = realms.open(
          TOWER,
          party,
          { level: char, size: 1 },
          undefined,
          undefined,
          floor,
        );
        for (const body of realm.world.allActors()) {
          if (body.kind !== ActorKind.Monster) continue;
          seen += 1;
          paid += worthExp(body.level, body.rank, char, body.infiniteDungeon === true);
          ordinary += worthExp(body.level, body.rank, char, false);
        }
      }
      expect(seen, `${where} was empty`).toBeGreaterThan(30);
      paid /= 3;
      ordinary /= 3;

      expect(paid / costOfALevel, `${where} does not pay for itself`).toBeGreaterThan(1);
      /**
       * AND THE LADDER IS WHY, from both sides.
       *
       * The bar is `TOWER_DEPTH_SCALE` and not 1: the bodies on floor n+1 are
       * 1.2 levels above the bodies on floor n (`zone.lua:28`), so a floor that
       * pays less than that leaves the party further behind than it found them,
       * with no last floor to stop on. The ordinary ladder misses it on every
       * deep floor; upstream's clears a whole level on every one.
       */
      expect(
        ordinary / costOfALevel,
        `${where}: the ordinary ladder keeps pace after all`,
      ).toBeLessThan(TOWER_DEPTH_SCALE);
      expect(paid, `${where}: the two ladders agree`).toBeGreaterThan(ordinary * 1.5);
    }
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * AND A SET PIECE IS BUILT ON THE SAME TWO LINES AS THE RANK AND FILE.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `populateDelve` places a floor's population at one call site and its
   * `spec.boss` at another, and both hand `actorAdjustLevel` the spec's
   * `depthScale` and `monsterInit` the spec's `infiniteDungeon`. The second
   * call site had NO COVERAGE AT ALL and could not have: the only spec carrying
   * either field is the Tower, and the Tower has no boss, so dropping both
   * arguments from the boss branch was a mutant that survived the whole suite.
   *
   * IT IS EQUIVALENT TODAY AND IT IS NOT EQUIVALENT FOREVER — the moment any
   * endless place is given a set piece, or the Tower's deferred stair guard
   * lands (`RandomStairGuard`, `zone.lua:76-90`, a rank-3.5 boss on nearly
   * every floor), a boss built on the unscaled line is levels below the room it
   * is standing in and pays the wrong ladder.
   *
   * SO THE SPEC IS SYNTHETIC, DELIBERATELY. It is the one case in this file
   * that does not drive a shipped row, because the shipped rows cannot reach
   * this branch. Everything else about it is production: `populateDelve` itself,
   * on a real world, with a real template off the Tower's own roster.
   */
  it('builds a set piece on the deep line too, not only the rank and file', () => {
    const tower = specFor(INFINITY_TOWER_SITE_ID);
    if (tower === undefined) throw new Error('the Tower has no DelveSpec');
    const bossTemplate = eligibleOn(tower, 1).entries[0]?.e;
    if (bossTemplate === undefined) throw new Error('the Tower roster is empty');

    const floor = 20;
    const withABoss: DelveSpec = { ...tower, boss: bossTemplate, maxFloors: floor };
    const world = createWorld('tower-boss');
    world.level.tiles.fill(TileCode.FLOOR);
    const map: AuthoredMap = {
      view: world.level,
      spawns: [{ x: 4, y: 4 }],
      sites: new Map<string, string>(),
    };
    populateDelve(world, map, withABoss, { level: 5, size: 1 }, floor);

    const boss = world
      .allActors()
      .find((a) => a.kind === ActorKind.Monster && a.id.includes('boss'));
    if (boss === undefined || boss.kind !== ActorKind.Monster) {
      throw new Error('no set piece was placed on the last floor');
    }

    // THE MULTIPLIER. A straight line puts a floor-20 boss at 20 + rank + jitter;
    // `depthScale` puts it at floor(1.2 * 20) = 24 + rank + jitter, and the two
    // ranges cannot overlap at this depth.
    const scaled = Math.floor(floor * TOWER_DEPTH_SCALE);
    const rank = rankLevelAdjust(RANK_VALUE[boss.rank]);
    expect(boss.level, 'the boss was built on the unscaled line').toBeGreaterThan(floor + 2 + rank);
    expect(boss.level).toBeGreaterThanOrEqual(scaled - 1);
    expect(boss.level).toBeLessThanOrEqual(scaled + 2 + rank);

    // AND THE LADDER ITS CORPSE PAYS ON.
    expect(boss.infiniteDungeon, 'the set piece pays the ordinary ladder').toBe(true);
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * AND THE JOIN: A REAL KILL, ON A REAL FLOOR, THROUGH THE REAL SCHEDULER.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Everything above this is a half — the table, the row, the field on the
   * body. This is the only case that fails if any ONE of the six links between
   * `DELVES` and the xp bar is missing: the row's flag, `populateDelve`'s
   * argument, `monsterInit`'s parameter, `createMonsterActor`'s field, the
   * scheduler's read off the corpse, and `payParty`'s argument to `worthExp`.
   * The four cases above each still pass with the last two links cut.
   *
   * THE DETECTIVE STANDS AT THE FLOOR'S OWN LEVEL, and that is not decoration.
   * `worthExp`'s anti-farming floor (Actor.lua:6514) pays NOTHING for a body
   * more than seven levels beneath you, and it is above the ladder branch, so a
   * rig that parks a level-30 detective on floor 12 measures zero on both
   * ladders and passes for the wrong reason. It did, once, while this case was
   * being written.
   */
  it('pays 2 per level of the corpse rather than 0.8, for a body killed in here', () => {
    const realms = makeRealms('ladder-kill');
    const realm = realms.open(TOWER, 'p', { level: 14, size: 1 }, undefined, undefined, 12);

    const victim = realm.world
      .allActors()
      .find((a) => a.kind === ActorKind.Monster && a.rank === ActorRank.Normal);
    if (victim === undefined || victim.kind !== ActorKind.Monster) {
      throw new Error('no ordinary body on the floor');
    }
    expect(victim.infiniteDungeon, 'precondition: the corpse carries the zone flag').toBe(true);

    const beside = [
      { x: victim.x - 1, y: victim.y },
      { x: victim.x + 1, y: victim.y },
      { x: victim.x, y: victim.y - 1 },
      { x: victim.x, y: victim.y + 1 },
    ].find((at) => realm.world.actorAt(at.x, at.y) === undefined);
    if (beside === undefined) throw new Error('nowhere to stand beside the body');

    const hero = realm.world.addPlayer('p1', 'Ren');
    // NARROWED, because `xp` and `level` live on `PlayerActor` and not on the
    // union — the split `engine/actor.ts` argues in prose: a husk has no
    // experience and asking it for some is a compile error.
    if (hero.kind !== ActorKind.Player) throw new Error('addPlayer did not add a player');
    hero.x = beside.x;
    hero.y = beside.y;
    // AT THE CORPSE'S OWN LEVEL — see the note above: seven levels further up
    // and the award is zero whichever ladder it is read off.
    hero.level = victim.level;
    hero.xp = 0;
    hero.maxHp = 100_000;
    hero.hp = 100_000;
    hero.hpRegen = 0;
    // Never misses, always the same number, and more than the body has — the
    // rig `progression-award.test.ts` uses, for its reason: a kill arranged by
    // a lucky seed stops being a kill the next time anything upstream draws.
    hero.combat = { weapon: { dam: 400, atk: 1000, damRange: 1.0 }, minRange: 0 };
    victim.hp = 1;

    const victimLevel = victim.level;
    for (let turn = 0; turn < 8 && victim.alive; turn += 1) {
      submitIntent(realm.world, realm.engine.barrier, 'p1', {
        kind: IntentKind.Attack,
        targetId: victim.id,
      });
      realm.engine.pump();
    }
    expect(victim.alive, 'the body never died, so nothing was paid').toBe(false);
    expect(hero.level, 'one ordinary body crossed a level — the rig is wrong, not the rule').toBe(
      victimLevel,
    );
    expect(hero.xp, 'the anti-farming floor ate the award — see the note above').toBeGreaterThan(0);

    expect(hero.xp).toBeCloseTo(
      victimLevel * RANK_WORTH_INFINITE[ActorRank.Normal] * XP_WORTH_MULT,
      6,
    );
    // AND IT IS NOT THE ORDINARY LADDER, which is the whole point: same corpse,
    // same level, two and a half times the award.
    expect(hero.xp).not.toBeCloseTo(victimLevel * RANK_WORTH[ActorRank.Normal] * XP_WORTH_MULT, 6);
  });
});
