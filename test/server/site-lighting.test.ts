// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

import { describe, expect, it } from 'vitest';

import { createDownedState } from '../../src/server/engine/downed.ts';
import { createPartyState } from '../../src/server/engine/party.ts';
import { createTurnEngine } from '../../src/server/turn-engine.ts';
import {
  ENCOUNTER_SITE,
  INFINITY_TOWER_SITE_ID,
  SITES,
  UNDERMOST_SITE_ID,
  createRealms,
  floorsOfSite,
} from '../../src/server/world/realms.ts';
import { towerFloorAt } from '../../src/shared/mapgen/tower.ts';
import type { TowerFloor } from '../../src/shared/mapgen/infinite.ts';
import { createWorld } from '../../src/server/world/world.ts';
import type { AuthoredMap } from '../../src/shared/level.ts';
import { REDACTION_SITE_ID } from '../../src/shared/level.ts';

/** A site's floor, built and lit the way `realms.open` builds and lights one. */
function built(
  id: string,
  floor = 1,
  seed = `lighting:${id}:${String(floor)}`,
): { readonly map: AuthoredMap; readonly lit: Uint8Array } {
  const def = SITES.get(id);
  if (def === undefined) throw new Error(`no site ${id}`);
  const map = def.map(seed, undefined, floor);
  const world = createWorld(seed, map, id, map.lighting ?? def.lighting);
  return { map, lit: world.lit };
}

function count(lit: Uint8Array): number {
  let n = 0;
  for (const tile of lit) n += tile;
  return n;
}

/** 1 where a tile is inside one of `map.rooms`. */
function inRooms(map: AuthoredMap): Uint8Array {
  const { w, h } = map.view;
  const mask = new Uint8Array(w * h);
  for (const r of map.rooms ?? []) {
    for (let y = Math.max(0, r.y0); y <= Math.min(h - 1, r.y1); y += 1) {
      for (let x = Math.max(0, r.x0); x <= Math.min(w - 1, r.x1); x += 1) mask[y * w + x] = 1;
    }
  }
  return mask;
}

const TOWNS = [
  'site:alderbrook',
  'site:threadneedle_row',
  'site:ashwick_row',
  'site:saints_rest',
  'site:wayfarers_camp',
];

/**
 * Each zone's floors, as its zone.lua lights them — written out here from the
 * Lua, not read back from `shared/mapgen/zones.ts`, so the table cannot
 * certify itself.
 *
 *   all      `all_lited = true`
 *   dark     not lit, and nothing lights a room: a Cavern or a Maze places
 *            none, and the Lake of Nur rolls `lite_room_chance = 0`
 *   rooms    not lit; every room at `lite_room_chance = 100`
 *   rolled   not lit; rooms and buildings at the chance the floor rolled
 */
const BY_FLOOR: Readonly<Record<string, readonly ('all' | 'dark' | 'rooms' | 'rolled')[]>> = {
  // halfling-ruins/zone.lua:30
  'site:drowned_chapel': ['all', 'all', 'all'],
  // orc-breeding-pit/zone.lua:30, commented out
  'site:underworks': ['dark', 'dark', 'dark'],
  // old-forest/zone.lua:32
  'site:barrow_end': ['all', 'all', 'all'],
  // heart-gloom/zone.lua:34
  'site:cairnfoot': ['all', 'all', 'all', 'all'],
  // lake-nur/zone.lua:32 commented out, :45 lite_room_chance = 0
  'site:the_weir': ['dark', 'dark', 'dark', 'dark'],
  // rhaloren-camp/zone.lua:104 overground; :34 commented out and :44 at 100 underground
  'site:watchers_altar': ['all', 'all', 'rooms', 'rooms'],
  // ardhungol/zone.lua:29, commented out
  'site:hollow_mine': ['dark', 'dark', 'dark', 'dark'],
  // maze/zone.lua:144, commented out
  'site:outer_index': ['dark', 'dark', 'dark', 'dark'],
  // scintillating-caves/zone.lua:34
  'site:glass_archive': ['all', 'all', 'all', 'all'],
  // infinite-dungeon/zone.lua:31 commented out, :158 rng.range(0, 100)
  'site:gearford_ward': ['rolled', 'rolled', 'rolled', 'rolled'],
  // trollmire/zone.lua:162
  'site:blackwood_outskirts': ['all', 'all', 'all', 'all'],
};

describe('how each place is lit', () => {
  it('lights every tile of a town', () => {
    for (const id of TOWNS) {
      const { lit } = built(id);
      expect(count(lit), id).toBe(lit.length);
    }
  });

  it('lists every delve on the moor, and every floor of each', () => {
    const delves = [...SITES.values()]
      .filter(
        (s) => s.populate !== undefined && s.id.startsWith('site:') && !s.id.includes(':redaction'),
      )
      .map((s) => s.id)
      .filter((id) => id !== UNDERMOST_SITE_ID)
      /**
       * ═══════════════════════════════════════════════════════════════════════
       * EXCEPT THE ONE WITH A BILLION FLOORS AND NO PER-FLOOR TABLE.
       * ═══════════════════════════════════════════════════════════════════════
       *
       * `BY_FLOOR` is one row per delve and one entry per FLOOR, read off the
       * zone file that builds that level. The Infinity Tower has no per-floor
       * table to read: its light is a fact about the LAYOUT a floor rolled —
       * 50 for the hewn rooms (`zone.lua:116`), `RoomsLoader`'s 100 for a
       * forest, a town or a cavern, the building's own roll (`:158`), and
       * nothing at all for a maze, an octopus or a hexacle — and there are a
       * billion floors to list.
       *
       * It gets its own case below, driven through the same `built()` so this
       * file still measures the real `lit` bitmap rather than the field.
       */
      .filter((id) => id !== INFINITY_TOWER_SITE_ID);
    expect(Object.keys(BY_FLOOR).toSorted()).toEqual(delves.toSorted());
    for (const [id, floors] of Object.entries(BY_FLOOR)) {
      expect(floors.length, id).toBe(floorsOfSite(id));
    }
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * AND THE TOWER, WHOSE LIGHT IS ITS LAYOUT'S RATHER THAN ITS FLOOR'S.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `all_lited` is COMMENTED OUT on this zone (`zone.lua:31`), so nothing is lit
   * except what a layout lights — and an ABSENT `SiteLighting` means LIT
   * EVERYWHERE (`shared/light.ts`), which is the failure this guards. Measured
   * through the same `built()` as every row above: the real bitmap, not the
   * field, so this catches a `lighting` that never reaches `createWorld`.
   */
  it('lights a Tower floor the way its layout lights a room, and a maze not at all', () => {
    const table = (floor: number): TowerFloor => towerFloorAt(floor);
    const find = (layout: string): number => {
      for (let floor = 1; floor <= 40; floor += 1)
        if (table(floor).layoutName === layout) return floor;
      throw new Error(`no ${layout} floor in the first forty`);
    };
    // A MAZE ROLLS NO LIGHT FOR ANYTHING, so the whole floor is dark.
    const maze = built(INFINITY_TOWER_SITE_ID, find('maze'));
    expect(count(maze.lit), 'a Tower maze is lit').toBe(0);
    // AND THE HEWN ROOMS ROLL FIFTY (`zone.lua:116`), so a floor of eleven
    // rooms has some lit and some not. THIS IS THE CASE THAT CATCHES A LIGHT
    // THAT NEVER LEFT THE TABLE: a maze has no room at all, so it reads as dark
    // whatever chance it is given, and a town at 100 reads the same at 100.
    const hewn = built(INFINITY_TOWER_SITE_ID, find('default'));
    const hewnRooms = inRooms(hewn.map);
    expect(count(hewnRooms), 'a hewn Tower floor placed no room').toBeGreaterThan(0);
    expect(count(hewn.lit), 'a hewn Tower floor lit nothing at 50').toBeGreaterThan(0);
    expect(
      count(hewn.lit),
      'a hewn Tower floor lit every room, so the roll is not 50',
    ).toBeLessThan(count(hewnRooms));
    for (let t = 0; t < hewn.lit.length; t += 1) {
      if (hewn.lit[t] === 1) expect(hewnRooms[t], 'lit outside every room').toBe(1);
    }
    // A TOWN LIGHTS EVERY ROOM IT PLACES (`RoomsLoader.lua:625`, no table sets
    // one), and nothing outside them.
    const town = built(INFINITY_TOWER_SITE_ID, find('town'));
    const rooms = inRooms(town.map);
    expect(count(rooms), 'a Tower town placed no room to light').toBeGreaterThan(0);
    expect(count(town.lit), 'a Tower town is dark').toBeGreaterThan(0);
    expect(count(town.lit), 'a Tower town is lit everywhere').toBeLessThan(town.lit.length);
    for (let t = 0; t < town.lit.length; t += 1) {
      if (town.lit[t] === 1) expect(rooms[t], 'lit outside every room').toBe(1);
    }
  });

  it('lights each floor of each delve as its zone lights that level', () => {
    for (const [id, floors] of Object.entries(BY_FLOOR)) {
      floors.forEach((how, i) => {
        const floor = i + 1;
        const at = `${id} floor ${String(floor)}`;
        const { map, lit } = built(id, floor);
        const rooms = inRooms(map);
        switch (how) {
          case 'all':
            expect(count(lit), at).toBe(lit.length);
            break;
          case 'dark':
            expect(count(lit), at).toBe(0);
            break;
          case 'rooms':
            // Exactly the rooms: every tile of one, and nothing outside them.
            expect(count(rooms), `${at}: no room to light`).toBeGreaterThan(0);
            expect(Array.from(lit), at).toEqual(Array.from(rooms));
            expect(count(lit), `${at}: nothing was left dark`).toBeLessThan(lit.length);
            break;
          case 'rolled':
            for (let t = 0; t < lit.length; t += 1) {
              if (lit[t] === 1) expect(rooms[t], `${at}: lit outside every room`).toBe(1);
            }
            break;
        }
      });
    }
  });

  it('rolls a Gearford floor`s light, so some floors are brighter than others', () => {
    // `lite_room_chance = rng.range(0, 100)` per level (infinite-dungeon/zone.lua:158):
    // over twenty floors the lit share of the buildings cannot all be one value.
    const shares = Array.from({ length: 20 }, (_, n) => {
      const { map, lit } = built('site:gearford_ward', 1 + (n % 4), `lighting:rolled:${String(n)}`);
      return count(lit) / Math.max(1, count(inRooms(map)));
    });
    expect(Math.min(...shares)).toBeLessThan(0.35);
    expect(Math.max(...shares)).toBeGreaterThan(0.65);
  });

  it('lights nothing on the Undermost`s cave floors, where every character wakes', () => {
    for (const floor of [1, 2]) {
      expect(count(built(UNDERMOST_SITE_ID, floor).lit), `floor ${String(floor)}`).toBe(0);
    }
  });

  it('gives each of the Redaction’s twins its original’s light', () => {
    const twins = [...SITES.keys()].filter((id) => id.startsWith(`${REDACTION_SITE_ID}:`));
    expect(twins.length, 'no twins to check').toBeGreaterThan(0);
    const darkTwins = twins.filter((twin) => {
      const original = twin.replace(`${REDACTION_SITE_ID}:`, 'site:');
      expect(SITES.get(twin)?.lighting, twin).toEqual(SITES.get(original)?.lighting);
      const how = BY_FLOOR[original];
      if (how === undefined) return false;
      // Floor by floor, a twin's floor is its original's level — the floors a
      // twin has beyond its original's are that zone's last.
      for (let floor = 1; floor <= floorsOfSite(twin); floor += 1) {
        const want = how[Math.min(floor, how.length) - 1];
        const { lit } = built(twin, floor);
        if (want === 'all') expect(count(lit), `${twin} floor ${String(floor)}`).toBe(lit.length);
        if (want === 'dark') expect(count(lit), `${twin} floor ${String(floor)}`).toBe(0);
      }
      return how[0] === 'dark';
    });
    expect(
      darkTwins.length,
      'no twin of a dark zone, so the dark case is unchecked',
    ).toBeGreaterThan(0);
  });

  it('says, for the site as a whole, what its first floor says', () => {
    // A site's own `lighting` is what a map that carries none is lit by. Every
    // zone floor carries its own, so this is the site's first floor — and a
    // floor that rolls its chance has none a site could state (`{}`).
    for (const [id, floors] of Object.entries(BY_FLOOR)) {
      const own = SITES.get(id)?.lighting;
      if (floors[0] === 'rolled') {
        expect(own, id).toEqual({});
        continue;
      }
      expect(own, id).toEqual(built(id, 1).map.lighting);
    }
  });

  it('keeps the Redaction’s moor and the breach arena lit', () => {
    expect(SITES.get(REDACTION_SITE_ID)?.lighting).toBeUndefined();
    expect(ENCOUNTER_SITE.lighting).toBeUndefined();
  });

  it('lights a realm by its floor`s own light, not only its site`s', () => {
    // THE JOIN: `realms.open` hands `createWorld` the level's lighting. The
    // Watcher's Altar is lit everywhere on floor 1 and only in its rooms on
    // floor 3, and the site carries one answer.
    const downed = createDownedState();
    const parties = createPartyState();
    const realms = createRealms({
      seed: 'lighting-join',
      engineFor: (world) => createTurnEngine({ world, downed, parties }),
    });
    const site = SITES.get('site:watchers_altar');
    if (site === undefined) throw new Error('no altar');
    const above = realms.open(site, 'party-light', undefined, undefined, undefined, 1);
    const below = realms.open(site, 'party-light', undefined, undefined, undefined, 3);
    expect(count(above.world.lit)).toBe(above.world.lit.length);
    expect(count(below.world.lit)).toBeGreaterThan(0);
    expect(count(below.world.lit)).toBeLessThan(below.world.lit.length);
  });
});
