// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// The code under test walks t-engine4 game/modules/tome/data/zones/infinite-dungeon/zone.lua:207-249.
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE TOWER'S CHAIN, AND ONE LINK OF IT AS GROUND SOMEBODY CAN WALK ON.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `alterLevelData` has been tested since it landed — the draws, their order,
 * the eight layouts in the seventeen sets. What was untested is the thing that
 * makes it a dungeon rather than a table: that floor `n+1` IS THE FLOOR FLOOR
 * `n` NAMED. `zone.lua:219-225` rolls two ways on and `:246` draws the down
 * stair in the FIRST one's grids, so a stair that leads somewhere else is not a
 * cosmetic mismatch, it is the chain not being walked at all.
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import type { TileXY } from '../../../src/shared/coords.ts';
import type { AuthoredMap } from '../../../src/shared/level.ts';
import { MAX_SEALED_SHARE } from '../../../src/shared/mapgen/zones.ts';
import { reachable, sealedShare } from '../../../src/shared/mapgen/connectivity.ts';
import { ID_GRID_SETS } from '../../../src/shared/mapgen/gridsets.ts';
import {
  TOWER_ENEMY_COUNT_AREA,
  TOWER_LAYOUTS,
  alterLevelData,
} from '../../../src/shared/mapgen/infinite.ts';
import {
  TOWER_DEPTH_SCALE,
  TOWER_FIRST_ENTRY,
  TOWER_MAX_FLOOR,
  towerFloorAt,
  towerGridSet,
  towerLevel,
} from '../../../src/shared/mapgen/tower.ts';
import { TileCode } from '../../../src/shared/protocol.ts';
import { createRng } from '../../../src/shared/rng.ts';

/** How deep the chain tests walk. Every layout appears inside 20 floors. */
const DEEP = 40;

/** How deep the coverage test walks. All seventeen sets appear inside 60. */
const EVERY_SET_BY = 60;

/**
 * Can a body get from `from` to `to`, through closed doors, as upstream asks.
 *
 * ═══ THE ENGINE'S OWN FUNCTION, NOT A COPY OF ITS RULE ═══
 * This was an eight-way BFS gated on `isWalkable(code) || isClosedDoorCode(code)`
 * written out here — behaviourally identical to `reachable`/`passable` on the
 * day it was written, and identical by coincidence rather than by construction.
 * The run that added it ALSO fixed `zone-floors.test.ts`, whose copy of the
 * same rule said `code !== TileCode.DOOR` and had been quietly wrong since it
 * was written, because `DOOR` is the only closed door any shipped zone draws
 * and twelve of the Tower's seventeen grid sets draw `ROCK_DOOR`. Writing a
 * second copy in the same change is how that happens again.
 *
 * `canRoute`, `openDoor` and `connectivity.passable` all agree that a shut door
 * is passable; this now agrees with them because it IS them.
 */
function reaches(map: AuthoredMap, from: TileXY, to: TileXY): boolean {
  return reachable(map.view, from, to);
}

describe('the chain: floor n+1 is the floor floor n named', () => {
  /**
   * `zone.layoutN = alternate_exit[1].layoutN` on the way down — the first of
   * the two ways on (`zone.lua:219-225`, `:246`). This is the ONE rule that
   * makes the Tower ToME's Infinite Dungeon rather than a delve that re-rolls
   * its terrain: break it and every floor is an unrelated draw.
   */
  it('enters each floor by the previous floor`s FIRST exit, not its second', () => {
    let previous = towerFloorAt(1);
    for (let floor = 2; floor <= DEEP; floor += 1) {
      const here = towerFloorAt(floor);
      const took = previous.exits[0];
      const layout = TOWER_LAYOUTS[took.layoutN - 1];
      const set = ID_GRID_SETS[took.vgridN - 1];
      expect(here.layoutName, `floor ${String(floor)} layout`).toBe(layout?.id);
      expect(here.gridsName, `floor ${String(floor)} grids`).toBe(set?.id);
      // AND IT IS NOT THE OTHER ONE. Without this the assertion above passes on
      // any floor where the two exits happen to agree, which they sometimes do.
      const other = previous.exits[1];
      if (other.layoutN !== took.layoutN || other.vgridN !== took.vgridN) {
        const wrong = `${String(ID_GRID_SETS[other.vgridN - 1]?.id)}/${String(
          TOWER_LAYOUTS[other.layoutN - 1]?.id,
        )}`;
        expect(`${here.gridsName}/${here.layoutName}`, `floor ${String(floor)}`).not.toBe(wrong);
      }
      previous = here;
    }
  });

  it('starts at layout 1 in grid set 1, which is upstream`s `zone.layoutN or 1` (zone.lua:207-208)', () => {
    expect(TOWER_FIRST_ENTRY).toEqual({ layoutN: 1, vgridN: 1 });
    const first = towerFloorAt(1);
    expect([first.layoutName, first.gridsName]).toEqual([
      TOWER_LAYOUTS[0]?.id,
      ID_GRID_SETS[0]?.id,
    ]);
  });

  it('is the same Tower every time it is asked — the floor number is the whole input', () => {
    for (const floor of [1, 7, 19, DEEP]) {
      const a = towerFloorAt(floor);
      const b = towerFloorAt(floor);
      expect([a.layoutName, a.gridsName, a.width, a.height, a.enemyCount]).toEqual([
        b.layoutName,
        b.gridsName,
        b.width,
        b.height,
        b.enemyCount,
      ]);
      expect(a.exits).toEqual(b.exits);
    }
  });

  it('refuses a floor that is not a floor, and one past the bottom that is not there', () => {
    expect(() => towerFloorAt(0)).toThrow(/not a floor/);
    expect(() => towerFloorAt(1.5)).toThrow(/not a floor/);
    expect(() => towerFloorAt(TOWER_MAX_FLOOR + 1)).toThrow(/floors deep/);
  });

  /**
   * NOTHING IN THE PORTED TABLE IS DEAD. Eight layouts and seventeen grid sets
   * were ported and the chain is the only thing that picks them; a wrapped
   * index or a mis-signed `%` could quietly reach four of them forever.
   */
  it('reaches all eight layouts and all seventeen grid sets by walking down', () => {
    const layouts = new Set<string>();
    const sets = new Set<string>();
    for (let floor = 1; floor <= EVERY_SET_BY; floor += 1) {
      const table = towerFloorAt(floor);
      layouts.add(table.layoutName);
      sets.add(table.gridsName);
    }
    expect([...layouts].sort()).toEqual([...TOWER_LAYOUTS.map((l) => l.id)].sort());
    expect([...sets].sort()).toEqual([...ID_GRID_SETS.map((s) => s.id)].sort());
  });
});

describe('a floor of the Tower, built', () => {
  /** Every floor of the prefix, built once and shared by the cases below. */
  const built = Array.from({ length: DEEP }, (_, i) => ({
    floor: i + 1,
    table: towerFloorAt(i + 1),
    map: towerLevel(i + 1, `tower-test:${String(i + 1)}`),
  }));

  it('is walkable ground with an arrival that reaches the way down', () => {
    for (const { floor, table, map } of built) {
      const up = map.spawns[0];
      const { down } = map;
      const where = `floor ${String(floor)} (${table.gridsName}/${table.layoutName})`;
      if (up === undefined || down === undefined) throw new Error(`${where}: a stair is missing`);
      expect([map.view.w, map.view.h], where).toEqual([table.width, table.height]);
      expect(reaches(map, up, down), where).toBe(true);
    }
  });

  /**
   * `data.generator.map.up = vgrid.floor` (`zone.lua:244`) and
   * `down = data.alternate_exit[1].grids.down` (`:246`): a stair here is a
   * marker standing on a floor code, so the way
   * down is drawn in the GROUND OF THE FLOOR IT LEADS TO. The map is telling
   * the player where the stair goes before they take it.
   */
  it('stands its arrival on this floor`s ground and its way down on the next floor`s', () => {
    for (const { floor, table, map } of built) {
      const up = map.spawns[0];
      const { down } = map;
      if (up === undefined || down === undefined) throw new Error('a stair is missing');
      const here = towerGridSet(table);
      const next = ID_GRID_SETS[table.exits[0].vgridN - 1];
      const where = `floor ${String(floor)}`;
      expect(map.view.tiles[up.y * map.view.w + up.x], where).toBe(here.floor);
      expect(map.view.tiles[down.y * map.view.w + down.x], where).toBe(next?.floor);
    }
  });

  /**
   * ═════════════════════════════════════════════════════════════════════════
   * FOUR CODES AND NO MORE — the palette contract `sitemap.test.ts` defers to.
   * ═════════════════════════════════════════════════════════════════════════
   *
   * Every other site in the game is one ground behind one wall, and
   * `test/shared/sitemap.test.ts` asserts exactly that over `SITES`. A Tower
   * floor cannot satisfy it, and the reason is upstream's own: `:237-249` writes
   * the floor's set into the generator table — floor, wall, door — and then
   * writes `down` from the set of the floor it LEADS TO (`:246`), so there is a
   * patch of the next floor's ground under the stair. That is the whole point:
   * *"the exit is a patch of the ground it leads to"*.
   *
   * SO THE CLAIM IS THE EXACT ONE INSTEAD OF THE GENERAL ONE, and it is
   * stricter: every code on the floor is one of those four, and nothing else
   * has crept in.
   */
  it('paints a floor in four codes: its floor, wall and door, and the next floor`s ground', () => {
    for (const { floor, table, map } of built) {
      const set = towerGridSet(table);
      const next = ID_GRID_SETS[table.exits[0].vgridN - 1];
      if (next === undefined) throw new Error('an exit names no grid set');
      const allowed = new Set<number>([
        ...[set.floor].flat(),
        ...[set.wall].flat(),
        ...[set.door].flat(),
        next.floor,
      ]);
      const stray = [...new Set(map.view.tiles)].filter((code) => !allowed.has(code));
      expect(stray, `floor ${String(floor)} (${table.gridsName}/${table.layoutName})`).toEqual([]);
    }
  });

  /**
   * `openedFormOf` turns a `ROCK_DOOR` into the MAP's floor rather than into
   * `DOOR_OPEN` (`shared/terrain.ts`, `data/zones/infinite-dungeon/grids.lua:45`).
   * Twelve of the seventeen sets shut their rooms with one, and no generated
   * floor in this game had ever set `rockFloor` — so every rock door in the
   * Tower would have opened onto a patch of grey `FLOOR` in the grass.
   */
  it('says what a rock door opens into, and it is this floor`s own ground', () => {
    let rockDoored = 0;
    for (const { floor, table, map } of built) {
      const set = towerGridSet(table);
      expect(map.rockFloor, `floor ${String(floor)}`).toBe(set.floor);
      if (set.door === TileCode.ROCK_DOOR) rockDoored += 1;
    }
    // The rule would be untested on a prefix that happened to draw no rock
    // door at all, and `rockFloor: TileCode.FLOOR` would pass every line above
    // on a default-set floor, whose floor IS `FLOOR`.
    expect(rockDoored).toBeGreaterThan(0);
    const rocky = built.find(
      ({ table }) =>
        towerGridSet(table).door === TileCode.ROCK_DOOR &&
        towerGridSet(table).floor !== TileCode.FLOOR,
    );
    // THROWN RATHER THAN OPTIONAL-CHAINED. `expect(rocky?.x).not.toBe(y)` is
    // green when `rocky` is undefined, and the search above is NARROWER than
    // the `rockDoored` count two lines up — it also needs a set whose floor is
    // not `FLOOR`. The two happen to coincide today because no `ROCK_DOOR` set
    // draws a grey floor; the day one does, this would have passed by finding
    // nothing at all.
    if (rocky === undefined) throw new Error('no rock-doored floor in a set with its own ground');
    expect(rocky.map.rockFloor).not.toBe(TileCode.FLOOR);
  });

  /**
   * `all_lited` is COMMENTED OUT upstream (`zone.lua:31`), so the Tower is not
   * lit — and an ABSENT `SiteLighting` means lit everywhere (`shared/light.ts`).
   * Dropping this field would floodlight a maze.
   */
  it('carries its layout`s own light, and a maze carries none', () => {
    for (const { floor, map } of built) {
      expect(map.lighting, `floor ${String(floor)}`).toBeDefined();
    }
    const maze = built.find(({ table }) => table.layoutName === 'maze');
    const town = built.find(({ table }) => table.layoutName === 'town');
    expect(maze?.map.lighting).toEqual({});
    expect(town?.map.lighting).toEqual({ litRoomChance: 100 });
  });

  /**
   * ═════════════════════════════════════════════════════════════════════════
   * WHAT THE ARRIVAL CANNOT REACH IS WALLED OFF — and this is the assertion
   * that is actually live, which is worth saying because the neighbouring one
   * is not.
   * ═════════════════════════════════════════════════════════════════════════
   *
   * `towerLevel` seals, so `sealedShare` of what it returns is 0 by
   * construction and the seal is what this measures: drop `sealUnreachable`
   * and every floor comes back with ground nobody can stand on.
   *
   * IT ALSO PASSES `refuse: refuseMostlySealed`, THE SAME RULE EVERY OTHER
   * GENERATED FLOOR HERE OBEYS, AND THAT RULE HAS NEVER FIRED ON A TOWER
   * FLOOR. Measured before this was written: 120 builds over the first forty
   * floors, three seeds each, and the worst pre-seal sealed share was 0.184
   * against a `MAX_SEALED_SHARE` of 0.5 — the Tower's floors are 60 to 90 a
   * side, where the refusal was written for a 30x30 Glass Archive. So NO test
   * here claims to exercise it; it is kept because a generated floor obeying a
   * different connectivity rule from every other generated floor would be a
   * special case nobody would remember, and because the day a layout does
   * produce one, the party gets another map instead of a corridor.
   */
  it('walls off every cell the arrival cannot reach', () => {
    for (const { floor, map } of built) {
      expect(sealedShare(map), `floor ${String(floor)} sealed`).toBe(0);
      expect(sealedShare(map), `floor ${String(floor)}`).toBeLessThanOrEqual(MAX_SEALED_SHARE);
    }
  });

  it('is a different floor for a different realm, and the same KIND of floor', () => {
    const a = towerLevel(9, 'realm:a');
    const b = towerLevel(9, 'realm:b');
    const table = towerFloorAt(9);
    expect([a.view.w, a.view.h]).toEqual([table.width, table.height]);
    expect([b.view.w, b.view.h]).toEqual([table.width, table.height]);
    expect(a.rockFloor).toBe(b.rockFloor);
    expect(a.lighting).toEqual(b.lighting);
    expect(a.view.tiles).not.toEqual(b.view.tiles);
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE CHAIN IS KEPT, AND KEEPING IT MUST NOT CHANGE A SINGLE ANSWER.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `towerFloorAt` memoises its prefix (`CHAIN`) because `stairDownName` asks it
 * for the current floor once per pump PER VIEWER, and that read was O(depth):
 * measured warm before the memo, 3.2 ms at floor 100 and 37.7 ms at floor 1600
 * against a whole pump costing about 11 ms. The risk a memo introduces is not
 * slowness, it is a WRONG answer that only appears on the second call — so
 * these cases recompute the fold from scratch, with no cache anywhere near
 * them, and compare.
 */
describe('the memo', () => {
  /**
   * EVERY VALUE THE TABLE CARRIES, INCLUDING THE ONES THAT ARE CODE.
   *
   * A floor's `spec` holds a closure — `clearingConfig`'s `rank <= 3` room
   * filter, a predicate `alterLevelData` builds afresh on every call — so two
   * tables that agree on every number still fail `toEqual`, which compares
   * functions by IDENTITY. Plain `JSON.stringify` would drop the closure
   * instead and quietly stop checking it. This keeps it, as its source, so a
   * memo that handed back a table with a DIFFERENT predicate in it would still
   * be caught.
   */
  function shape(table: unknown): string {
    return JSON.stringify(table, (_key, value: unknown) =>
      typeof value === 'function' ? `fn:${String(value)}` : value,
    );
  }

  /** `alterLevelData`'s own chain, walked here with nothing kept between asks. */
  function foldFresh(floor: number): ReturnType<typeof towerFloorAt> {
    let entry = TOWER_FIRST_ENTRY;
    let table = alterLevelData(1, entry, createRng('tower:floor:1'));
    for (let lev = 2; lev <= floor; lev += 1) {
      entry = table.exits[0];
      table = alterLevelData(lev, entry, createRng(`tower:floor:${String(lev)}`));
    }
    return table;
  }

  /**
   * ASKED OUT OF ORDER ON PURPOSE. A prefix cache is at its most wrong when a
   * shallow ask follows a deep one (does it read the right slot?) and when a
   * deep ask follows a shallow one (does it resume from the right place, or
   * silently restart the chain from floor 1 with the wrong entry?). Ascending
   * order alone exercises neither.
   */
  it('answers exactly what the plain fold answers, asked in any order', () => {
    for (const floor of [17, 3, 18, 1, 40, 39, 2, 41]) {
      expect(shape(towerFloorAt(floor)), `floor ${String(floor)}`).toBe(shape(foldFresh(floor)));
    }
  });

  /** And the same object every time, which is what makes the read free. */
  it('hands back one table per floor rather than rebuilding it', () => {
    expect(towerFloorAt(12)).toBe(towerFloorAt(12));
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE REFUSAL HAS NEVER FIRED HERE, AND A SCRAPE IS WHY IT STILL SHIPS.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `towerLevel` passes `refuse: refuseMostlySealed`, the same rule every other
 * generated floor in this game obeys. Measured before it was written down: 120
 * builds over the first forty floors, three seeds each, worst pre-seal sealed
 * share 0.184 against a `MAX_SEALED_SHARE` of 0.5 — the rule was written for a
 * 30x30 Glass Archive and these floors are 60 to 90 a side.
 *
 * So there is no seam to inject a refusal through and NO BEHAVIOURAL TEST CAN
 * CATCH ITS REMOVAL: a mutation audit confirmed it as a surviving mutant. This
 * is the same shape `fov.test.ts` uses for rules that are load-bearing and
 * unreachable — read the source and require the line. It is a weaker test than
 * a behavioural one and it is the strongest one available here, which is worth
 * stating rather than leaving the survivor unexplained.
 */
describe('the connectivity rule it shares with every other generated floor', () => {
  it('hands `keepTrying` the same refusal the zones do', () => {
    const src = readFileSync(
      new URL('../../../src/shared/mapgen/tower.ts', import.meta.url),
      'utf8',
    );
    const body = src.slice(src.indexOf('export function towerLevel'));
    expect(body, '`towerLevel` no longer refuses a mostly-sealed map').toContain(
      'refuse: refuseMostlySealed',
    );
  });
});

describe('the zone`s own three numbers', () => {
  it('is a billion floors deep — `max_level` (zone.lua:27)', () => {
    expect(TOWER_MAX_FLOOR).toBe(1000000000);
  });

  it('turns depth into levels at 1.2 — the `* 1.2` in `actor_adjust_level` (zone.lua:28)', () => {
    expect(TOWER_DEPTH_SCALE).toBe(1.2);
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * AND THE AREA `enemy_count` IS A SHARE OF — `math.ceil(vx * vy * 34/4900)`.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * A PIN, NOT A DERIVATION, and it earns its place the same way the two above
   * do. 4900 was spelled out four times — in the generator, in `nbNpcFor`, and
   * on two rows of `DELVES` — and unifying them removed the only mutant that
   * could catch it moving: every reader now divides by the same symbol, so
   * changing it changes both sides of every comparison in the suite and nothing
   * goes red. That is the right shape for the CODE and it leaves the VALUE
   * unguarded, which is what this line is for. 70x70 is the zone's own stated
   * level size (`zone.lua:29`), and `:255`'s comment prices it: "avg: 25 @
   * 60x60, 34 @ 70x70, 57 @ 90x90".
   */
  it('prices a floor against a 70x70 level — `34/4900` (zone.lua:255)', () => {
    expect(TOWER_ENEMY_COUNT_AREA).toBe(4900);
    expect(TOWER_ENEMY_COUNT_AREA, 'upstream`s own `width = 70, height = 70` (:29)').toBe(70 * 70);
  });
});
