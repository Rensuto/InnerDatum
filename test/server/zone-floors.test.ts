// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

import { describe, expect, it } from 'vitest';

import { createDownedState } from '../../src/server/engine/downed.ts';
import { createPartyState } from '../../src/server/engine/party.ts';
import { createTurnEngine } from '../../src/server/turn-engine.ts';
import {
  RealmKind,
  SITES,
  UNDERMOST_SITE_ID,
  createRealms,
  floorsOfSite,
  stairsDownOf,
} from '../../src/server/world/realms.ts';
import type { Realm } from '../../src/server/world/realms.ts';
import type { TileXY } from '../../src/shared/coords.ts';
import type { Ground } from '../../src/shared/level.ts';
import { REDACTION_SITE_ID } from '../../src/shared/level.ts';
import type { LevelView } from '../../src/shared/protocol.ts';
import { DOOR_CLEARANCE } from '../../src/shared/sitemap.ts';
import { zoneLevel } from '../../src/shared/mapgen/zones.ts';
import { ActorKind, TileCode, isWalkable } from '../../src/shared/protocol.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * EVERY FLOOR OF EVERY DELVE, BUILT AND FILLED THE WAY A PARTY WALKS INTO IT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `shared/mapgen/zones.ts` builds each site as a ToME zone, level by level, and
 * its own tests hold the table to the Lua. What only a realm can show is the
 * rest: the floor the realm actually opens, the stair it stands on it, and what
 * `populateDelve` puts there — on every Inner site, the Redaction's twins and
 * the Undermost included, and on every floor each has.
 */

const SEEDS = 3;

/**
 * The size of each floor, as each zone.lua gives it: `width, height` at the top
 * of the table unless a level overrides it. A floor past a zone's last is its
 * last.
 */
const SIZES: Readonly<Record<string, readonly (readonly [number, number])[]>> = {
  'site:drowned_chapel': [[50, 50]], // halfling-ruins/zone.lua:27
  'site:underworks': [[50, 50]], // orc-breeding-pit/zone.lua:27
  'site:barrow_end': [[50, 50]], // old-forest/zone.lua:30
  'site:cairnfoot': [[50, 50]], // heart-gloom/zone.lua:30
  'site:the_weir': [[50, 50]], // lake-nur/zone.lua:30
  'site:watchers_altar': [[50, 50]], // rhaloren-camp/zone.lua:31, :101
  'site:hollow_mine': [
    [60, 60], // ardhungol/zone.lua:27
    [40, 40], // ardhungol/zone.lua:69
  ],
  'site:outer_index': [[60, 60]], // maze/zone.lua:142
  'site:glass_archive': [[30, 30]], // scintillating-caves/zone.lua:30
  // Upstream's is 60 to 90 a side and reshaped each level (infinite-dungeon/zone.lua:103-105);
  // `BUILDING_INFINITE_DUNGEON` builds the delves' 50x50.
  'site:gearford_ward': [[50, 50]],
  'site:blackwood_outskirts': [[65, 40]], // trollmire/zone.lua:160
};

/** The site a Redaction twin was spread from, or the site itself. */
function originalOf(id: string): string {
  return id.startsWith(`${REDACTION_SITE_ID}:`) ? id.replace(`${REDACTION_SITE_ID}:`, 'site:') : id;
}

/** Every cell reachable from `from`: eight ways, a shut door passable. Written out, not imported. */
function reach(level: LevelView, from: TileXY): Uint8Array {
  const seen = new Uint8Array(level.w * level.h);
  seen[from.y * level.w + from.x] = 1;
  const queue = [from.y * level.w + from.x];
  for (let head = 0; head < queue.length; head += 1) {
    const at = queue[head] ?? 0;
    const x = at % level.w;
    const y = (at - x) / level.w;
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= level.w || ny >= level.h) continue;
        if (seen[ny * level.w + nx] === 1) continue;
        const code = level.tiles[ny * level.w + nx] ?? TileCode.WALL;
        if (code !== TileCode.DOOR && !isWalkable(code)) continue;
        seen[ny * level.w + nx] = 1;
        queue.push(ny * level.w + nx);
      }
    }
  }
  return seen;
}

const INNER = [...SITES.values()].filter((s) => s.kind === RealmKind.Inner);

describe('every floor of every delve', () => {
  it('covers the eleven zones, their twins and the Undermost', () => {
    const zoned = INNER.filter((s) => SIZES[originalOf(s.id)] !== undefined);
    expect(Object.keys(SIZES)).toHaveLength(11);
    expect(zoned.length).toBeGreaterThanOrEqual(11 + 11);
    expect(INNER.some((s) => s.id === UNDERMOST_SITE_ID)).toBe(true);
  });

  for (const site of INNER) {
    it(`${site.id}: builds, joins its stairs and fills only ground a party can reach`, () => {
      const downed = createDownedState();
      const parties = createPartyState();
      const floors = floorsOfSite(site.id);
      const sizes = SIZES[originalOf(site.id)];
      for (let s = 0; s < SEEDS; s += 1) {
        const realms = createRealms({
          seed: `zone-floors:${String(s)}`,
          engineFor: (world) => createTurnEngine({ world, downed, parties }),
        });
        for (let floor = 1; floor <= floors; floor += 1) {
          const at = `${site.id} floor ${String(floor)} seed ${String(s)}`;
          const realm: Realm = realms.open(site, 'party', undefined, undefined, undefined, floor);
          const level = realm.world.level;

          if (sizes !== undefined) {
            const size = sizes[Math.min(floor, sizes.length) - 1];
            expect([level.w, level.h], at).toEqual(size);
          }

          const up = realm.spawns[0];
          if (up === undefined) throw new Error(`${at}: no arrival`);
          expect(isWalkable(level.tiles[up.y * level.w + up.x] ?? -1), `${at}: arrival`).toBe(true);
          const reached = reach(level, up);

          const stair = stairsDownOf(realm);
          if (floor < floors) {
            if (stair === null) throw new Error(`${at}: no stair down`);
            expect(reached[stair.y * level.w + stair.x], `${at}: the stair is cut off`).toBe(1);
          } else {
            expect(stair, `${at}: a stair down on the last floor`).toBeNull();
          }

          const monsters = realm.world.allActors().filter((a) => a.kind === ActorKind.Monster);
          // The Undermost's last floor is drawn empty (`UNDERMOST_SITE.populate`).
          if (!(site.id === UNDERMOST_SITE_ID && floor === floors)) {
            expect(monsters.length, `${at}: nobody lives here`).toBeGreaterThan(0);
          }
          const placed: readonly TileXY[] = [
            ...monsters,
            ...realm.world.groundItems(),
            ...realm.world.traps(),
            ...realm.world.props(),
          ];
          for (const thing of placed) {
            const where = `${at}: something at ${String(thing.x)},${String(thing.y)}`;
            expect(reached[thing.y * level.w + thing.x], `${where} nobody can reach`).toBe(1);
            expect(
              realm.sites.has(`${String(thing.x)},${String(thing.y)}`),
              `${where} on a stair`,
            ).toBe(false);
          }
        }
      }
    });
  }

  it('builds the same floor for the same seed, on every zoned site and floor', () => {
    for (const site of INNER) {
      if (SIZES[originalOf(site.id)] === undefined) continue;
      for (let floor = 1; floor <= floorsOfSite(site.id); floor += 1) {
        const seed = `same:${site.id}:${String(floor)}`;
        expect(site.map(seed, undefined, floor), `${site.id} floor ${String(floor)}`).toEqual(
          site.map(seed, undefined, floor),
        );
      }
    }
  });

  it('builds floor 1 when no floor is given', () => {
    for (const site of INNER) {
      if (SIZES[originalOf(site.id)] === undefined) continue;
      expect(site.map('no-floor'), site.id).toEqual(site.map('no-floor', undefined, 1));
    }
  });

  it('is its zone`s level, floor by floor, in the palette its row names', () => {
    // THE JOIN: the site's `map` is `zoneLevel` for ITS floor — not floor 1
    // every time — in the row's floor and wall, which are the zone's.
    for (const site of INNER) {
      const original = originalOf(site.id);
      if (SIZES[original] === undefined) continue;
      for (let floor = 1; floor <= floorsOfSite(site.id); floor += 1) {
        const seed = `join:${site.id}:${String(floor)}`;
        expect(site.map(seed, undefined, floor), `${site.id} floor ${String(floor)}`).toEqual(
          zoneLevel(original, seed, floor),
        );
      }
    }
  });
});

describe('a floor its seal would all but empty', () => {
  /**
   * Found live on the Redaction's Glass Archive (2026-09-17): both stairs in one
   * room no tunnel joined, which upstream's up-to-down check passes, and the rest
   * sealed away. The first floor shipped 21 cells and no monster; the second 61
   * cells, twelve bodies round the arrival and one on the stair down. Opened here
   * at exactly those floors' seeds, through a realm, for a party of one and of
   * four.
   */
  const PINNED = [
    { seed: 'live-zones:realm:site:redaction:glass_archive:18131', floor: 1 },
    { seed: 'live-zones:realm:site:redaction:glass_archive:18442', floor: 2 },
  ];

  it('is built again, and then has somebody in it, clear of the arrival and off the stair', () => {
    const twin = SITES.get(`${REDACTION_SITE_ID}:glass_archive`);
    if (twin === undefined) throw new Error('no Redaction Glass Archive');
    const downed = createDownedState();
    const parties = createPartyState();
    for (const { seed, floor } of PINNED) {
      const pinned = {
        ...twin,
        map: (_seed: string, ground?: Ground, f?: number) => twin.map(seed, ground, f),
      };
      for (const size of [1, 4]) {
        const at = `${seed} floor ${String(floor)} party of ${String(size)}`;
        const realms = createRealms({
          seed: 'pinned',
          sites: new Map([[twin.id, pinned]]),
          engineFor: (world) => createTurnEngine({ world, downed, parties }),
        });
        const realm = realms.open(pinned, 'party', { level: 1, size }, undefined, undefined, floor);
        const level = realm.world.level;
        const up = realm.spawns[0];
        if (up === undefined) throw new Error(`${at}: no arrival`);
        const ground = level.tiles.filter((c) => c === TileCode.DOOR || isWalkable(c)).length;
        expect(ground, at).toBeGreaterThan(100);
        const monsters = realm.world.allActors().filter((a) => a.kind === ActorKind.Monster);
        expect(monsters.length, `${at}: nobody lives here`).toBeGreaterThan(0);
        for (const m of monsters) {
          const where = `${at}: a body at ${String(m.x)},${String(m.y)}`;
          expect(
            Math.max(Math.abs(m.x - up.x), Math.abs(m.y - up.y)),
            where,
          ).toBeGreaterThanOrEqual(DOOR_CLEARANCE);
          expect(realm.sites.has(`${String(m.x)},${String(m.y)}`), `${where} on a stair`).toBe(
            false,
          );
        }
      }
    }
  });
});
