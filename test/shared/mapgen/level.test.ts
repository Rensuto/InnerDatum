// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// The loop under test is ported from t-engine4 game/engines/default/engine/Zone.lua:1020-1166.
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

import { describe, expect, it } from 'vitest';

import type { TileXY } from '../../../src/shared/coords.ts';
import type { AuthoredMap } from '../../../src/shared/level.ts';
import { createGenMap } from '../../../src/shared/mapgen/genmap.ts';
import {
  KEEP_TRYING_ROUNDS,
  MAX_LEVEL_GENERATION_COUNT,
  ROOMER_RUINS_KOR_PUL,
  keepTrying,
  newLevel,
  toAuthoredMap,
} from '../../../src/shared/mapgen/level.ts';
import type { LevelSpec, RoomerMapSpec } from '../../../src/shared/mapgen/level.ts';
import { createRoomer, generate } from '../../../src/shared/mapgen/roomer.ts';
import {
  BUILDING_INFINITE_DUNGEON,
  createBuilding,
  generate as generateBuilding,
} from '../../../src/shared/mapgen/building.ts';
import { TileCode, isWalkable } from '../../../src/shared/protocol.ts';
import { createRng } from '../../../src/shared/rng.ts';

const SEEDS = 40;
const OPTS = { level: 1, maxLevel: 3 } as const;

/**
 * Two plain rooms and no tunnels on a small map: the stairs land in the same
 * room about half the time and in two unjoined rooms otherwise, so the
 * up-to-down check has something to refuse on nearly every seed.
 */
const ISLANDS: LevelSpec<RoomerMapSpec> = {
  width: 30,
  height: 30,
  map: { ...ROOMER_RUINS_KOR_PUL.map, nbRooms: 2, rooms: ['simple'], noTunnels: true },
};

/**
 * The connectivity rule, written again here rather than imported, so a mistake
 * in `mapgen/connectivity.ts` cannot certify itself: 8 neighbours, a shut door
 * is passable, anything else must be walkable.
 */
function reach(map: AuthoredMap, from: TileXY): Set<string> {
  const { w, h, tiles } = map.view;
  const key = (x: number, y: number): string => `${String(x)},${String(y)}`;
  const seen = new Set([key(from.x, from.y)]);
  const queue: TileXY[] = [from];
  while (queue.length > 0) {
    const at = queue.pop();
    if (at === undefined) break;
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        const x = at.x + dx;
        const y = at.y + dy;
        if (x < 0 || y < 0 || x >= w || y >= h || seen.has(key(x, y))) continue;
        const code = tiles[y * w + x] ?? TileCode.WALL;
        if (code !== TileCode.DOOR && !isWalkable(code)) continue;
        seen.add(key(x, y));
        queue.push({ x, y });
      }
    }
  }
  return seen;
}

function up(map: AuthoredMap): TileXY {
  const spawn = map.spawns[0];
  if (spawn === undefined) throw new Error('no up stair');
  return spawn;
}

describe('newLevel on the Kor`Pul table', () => {
  const levels = Array.from({ length: SEEDS }, (_, i) =>
    newLevel(ROOMER_RUINS_KOR_PUL, `level:${String(i)}`, OPTS),
  );
  const more = Array.from({ length: SEEDS * 2 }, (_, i) =>
    newLevel(ROOMER_RUINS_KOR_PUL, `level:${String(SEEDS + i)}`, OPTS),
  );

  it('succeeds on every seed, in few attempts', () => {
    expect(levels.filter((l) => l.failed)).toHaveLength(0);
    const mean = levels.reduce((sum, l) => sum + l.attempts, 0) / SEEDS;
    // Measured 1.002 over 500 seeds. It was 1.27 before the drawn vaults had
    // their apron, when a vault whose walls a tunnel ran into was most of it.
    expect(mean).toBeLessThan(1.2);
  });

  it('joins the up stair to the down stair, 8-way with doors passable', () => {
    for (const { map } of levels) {
      const { down } = map;
      if (down === undefined) throw new Error('no down stair');
      expect(reach(map, up(map)).has(`${String(down.x)},${String(down.y)}`)).toBe(true);
    }
  });

  it('reaches every drawn vault`s door from the up stair', () => {
    // A vault's entrance is its door, and upstream refuses a level whose vault
    // entrance the stairs cannot reach. `newLevel refusing a level` below is
    // where the refusal itself is pinned; this is the property on real levels,
    // over enough of them to hold dozens of vault doors (17 in the first 40).
    let doors = 0;
    for (const { map } of [...levels, ...more]) {
      const reached = reach(map, up(map));
      for (const vault of map.vaults ?? []) {
        if (vault.id.startsWith('room:')) continue;
        for (let y = vault.at.y; y < vault.at.y + vault.h; y += 1) {
          for (let x = vault.at.x; x < vault.at.x + vault.w; x += 1) {
            if (map.view.tiles[y * map.view.w + x] !== TileCode.DOOR) continue;
            doors += 1;
            expect(reached.has(`${String(x)},${String(y)}`)).toBe(true);
          }
        }
      }
    }
    expect(doors).toBeGreaterThan(30);
  });

  it('records a room rectangle per placed room, and never more than nb_rooms', () => {
    for (const { map } of levels) {
      const rooms = map.rooms ?? [];
      expect(rooms.length).toBeGreaterThan(0);
      expect(rooms.length).toBeLessThanOrEqual(10);
      for (const r of rooms) {
        expect(r.x1).toBeGreaterThan(r.x0);
        expect(r.y1).toBeGreaterThan(r.y0);
      }
    }
  });

  it('is the same level for the same seed, and a different level for another', () => {
    const again = newLevel(ROOMER_RUINS_KOR_PUL, 'level:0', OPTS);
    const first = levels[0];
    expect(again.attempts).toBe(first?.attempts);
    expect(again.map.view.tiles).toEqual(first?.map.view.tiles);
    expect([again.map.spawns, again.map.down, again.map.rooms, again.map.vaults]).toEqual([
      first?.map.spawns,
      first?.map.down,
      first?.map.rooms,
      first?.map.vaults,
    ]);
    expect(levels[1]?.map.view.tiles).not.toEqual(first?.map.view.tiles);
  });

  it('draws attempt n from its own seed, `${seed}#${n}`', () => {
    // A Kor'Pul level almost never needs a second attempt, so the islands do.
    const seeds = Array.from({ length: 20 }, (_, s) => `islands:${String(s)}`);
    const seed = seeds.find((s) => newLevel(ISLANDS, s, OPTS).attempts >= 2);
    if (seed === undefined) throw new Error('no seed needed a second attempt');
    const level = newLevel(ISLANDS, seed, OPTS);
    const rng = createRng(`${seed}#${String(level.attempts)}`);
    const map = createGenMap(ISLANDS.width, ISLANDS.height, ISLANDS.map.grid, rng);
    const gen = createRoomer(map, ISLANDS.map, rng, { maxLevel: 3 }, { forceRecreate: null });
    generate(gen, 1, 0);
    expect(toAuthoredMap(map, null, null, ISLANDS.map.grid).view.tiles).toEqual(
      level.map.view.tiles,
    );
  });
});

describe('newLevel refusing a level', () => {
  it('never reports success for stairs that cannot reach each other', () => {
    let retried = 0;
    let succeeded = 0;
    for (let s = 0; s < 20; s += 1) {
      const level = newLevel(ISLANDS, `islands:${String(s)}`, OPTS);
      if (level.attempts > 1) retried += 1;
      if (level.failed) continue;
      succeeded += 1;
      const { down } = level.map;
      if (down === undefined) throw new Error('no down stair');
      expect(reach(level.map, up(level.map)).has(`${String(down.x)},${String(down.y)}`)).toBe(true);
    }
    expect(retried).toBeGreaterThan(3);
    expect(succeeded).toBeGreaterThan(10);
  });

  it('skips that check under no_level_connectivity', () => {
    const attempts = Array.from(
      { length: 20 },
      (_, s) =>
        newLevel({ ...ISLANDS, noLevelConnectivity: true }, `islands:${String(s)}`, OPTS).attempts,
    );
    expect(attempts.every((a) => a === 1)).toBe(true);
  });

  it('refuses a level whose vault entrance the up stair cannot reach', () => {
    // A vault and two rooms, no tunnels, and the stairs' own check switched off:
    // the up stair is never on a vault cell (they are all special), so only the
    // vault's spot can refuse, and without tunnels it refuses every attempt.
    const walledIn: LevelSpec = {
      ...ISLANDS,
      noLevelConnectivity: true,
      map: { ...ISLANDS.map, requiredRooms: ['lesser_vault'] },
    };
    for (let s = 0; s < 3; s += 1) {
      const level = newLevel(walledIn, `walled-in:${String(s)}`, OPTS);
      expect(level.map.vaults, 'no vault was placed').toHaveLength(1);
      expect(level).toMatchObject({ failed: true, attempts: MAX_LEVEL_GENERATION_COUNT });
    }
  });

  it('recreates a level the generator asked to have recreated', () => {
    // No rooms is no floor, so `makeStairsInside` finds no cell for a stair and
    // sets `force_recreate` while still returning a result. Only that flag
    // stands between this and a level with no stairs reported as a success.
    const solid: LevelSpec = {
      width: 6,
      height: 6,
      map: { ...ROOMER_RUINS_KOR_PUL.map, nbRooms: 0 },
    };
    const level = newLevel(solid, 'solid', OPTS);
    expect(level).toMatchObject({ failed: true, attempts: MAX_LEVEL_GENERATION_COUNT });
  });

  it('gives up after fifty attempts and hands back the last one, marked failed', () => {
    const never: LevelSpec = {
      ...ROOMER_RUINS_KOR_PUL,
      map: { ...ROOMER_RUINS_KOR_PUL.map, requiredRooms: ['lesser_vault'], lesserVaultsList: [] },
    };
    const level = newLevel(never, 'never', OPTS);
    expect(MAX_LEVEL_GENERATION_COUNT).toBe(50);
    expect(level).toMatchObject({ failed: true, attempts: MAX_LEVEL_GENERATION_COUNT });
    expect(level.map.spawns).toEqual([]);
    expect(level.map.view.tiles.every((c) => c === TileCode.WALL)).toBe(true);
  });
});

describe('keepTrying — the level change ToME makes again', () => {
  it('is newLevel`s own level when that certifies', () => {
    for (let s = 0; s < 5; s += 1) {
      const seed = `keep:${String(s)}`;
      expect(keepTrying(ROOMER_RUINS_KOR_PUL, seed, OPTS)).toEqual(
        newLevel(ROOMER_RUINS_KOR_PUL, seed, OPTS),
      );
    }
  });

  it('never hands back a failed level: it tries fresh seeds, then throws', () => {
    const never: LevelSpec = {
      ...ROOMER_RUINS_KOR_PUL,
      map: { ...ROOMER_RUINS_KOR_PUL.map, requiredRooms: ['lesser_vault'], lesserVaultsList: [] },
    };
    expect(KEEP_TRYING_ROUNDS).toBe(10);
    expect(() => keepTrying(never, 'never', OPTS)).toThrow(/500 attempts at 'never' made no level/);
  });

  it('takes the first round that certifies, round k seeded `${seed}~${k}`', () => {
    // Twelve small rooms and no tunnels: a level certifies only when both
    // stairs land in one room, so now and then all fifty attempts miss.
    const scattered: LevelSpec = {
      width: 40,
      height: 40,
      map: { ...ROOMER_RUINS_KOR_PUL.map, nbRooms: 12, rooms: ['small_x'], noTunnels: true },
    };
    for (let s = 0; s < 120; s += 1) {
      const seed = `rounds:${String(s)}`;
      if (!newLevel(scattered, seed, OPTS).failed) continue;
      const round = Array.from({ length: KEEP_TRYING_ROUNDS }, (_, k) => k).find(
        (k) => k > 0 && !newLevel(scattered, `${seed}~${String(k)}`, OPTS).failed,
      );
      expect(round).toBeDefined();
      const kept = keepTrying(scattered, seed, OPTS);
      expect(kept.failed).toBe(false);
      expect(kept).toEqual(newLevel(scattered, `${seed}~${String(round)}`, OPTS));
      return;
    }
    throw new Error('no seed failed a whole round');
  });
});

describe('toAuthoredMap', () => {
  it('ships nil terrain as the zone`s wall, and the stairs, rooms and vaults the generator made', () => {
    const rng = createRng('authored');
    const keys = { '.': TileCode.FLOOR, '#': TileCode.CRAG };
    const map = createGenMap(8, 6, keys, rng);
    map.set(1, 1, TileCode.FLOOR);
    map.rooms.push(
      { id: 1, x: 1, y: 1, cx: 2, cy: 2, room: { name: 'a', w: 3, h: 2, generator: () => null } },
      {
        id: 2,
        x: 4,
        y: 2,
        cx: 5,
        cy: 3,
        room: {
          name: 'v',
          w: 3,
          h: 3,
          vault: { id: 'room:x', turn: 'half', w: 3, h: 3 },
          generator: () => null,
        },
      },
      {
        id: 3,
        x: 1,
        y: 3,
        cx: 2,
        cy: 4,
        room: {
          name: 'lesser',
          w: 3,
          h: 3,
          vault: { id: 'vault:y', turn: 'none', w: 1, h: 1, inset: 1 },
          ignoresLite: true,
          generator: () => null,
        },
      },
    );
    const out = toAuthoredMap(map, { x: 1, y: 1 }, { x: 5, y: 4 }, keys);
    expect(out.view.tiles.filter((c) => c === TileCode.CRAG)).toHaveLength(47);
    expect(out.view.tiles[9]).toBe(TileCode.FLOOR);
    expect(out.spawns).toEqual([{ x: 1, y: 1 }]);
    expect(out.down).toEqual({ x: 5, y: 4 });
    // A lesser vault is not lit by its roll (rooms/lesser_vault.lua:90), so it is
    // not a room the light may light.
    expect(out.rooms).toEqual([
      { x0: 1, y0: 1, x1: 3, y1: 2 },
      { x0: 4, y0: 2, x1: 6, y1: 4 },
    ]);
    // And its record is the drawing, inside its apron.
    expect(out.vaults).toEqual([
      { id: 'room:x', at: { x: 4, y: 2 }, turn: 'half', w: 3, h: 3 },
      { id: 'vault:y', at: { x: 2, y: 4 }, turn: 'none', w: 1, h: 1 },
    ]);
    expect(out.sites.size).toBe(0);
    expect('down' in toAuthoredMap(map, null, null, keys)).toBe(false);
    // `lit` rectangles follow the rooms, whatever they are.
    const lit = [{ x0: 2, y0: 2, x1: 3, y1: 3 }];
    expect(toAuthoredMap(map, null, null, keys, lit).rooms).toEqual([
      { x0: 1, y0: 1, x1: 3, y1: 2 },
      { x0: 4, y0: 2, x1: 6, y1: 4 },
      ...lit,
    ]);
  });
});

describe('newLevel on a Building table', () => {
  it('hands the level`s light the floor every building wrote, after the rooms, and no vault cell', () => {
    // `Building:building` lights the floor it writes inside a building's walls on
    // `lite_room_chance` (engine/generator/map/Building.lua:104, :114-116): inside
    // the rectangle one cell in from the leaf's edge, never a `special` cell.
    // Rebuilt here from the attempt that certified, straight from the generator.
    const table: LevelSpec = {
      ...BUILDING_INFINITE_DUNGEON,
      map: {
        ...BUILDING_INFINITE_DUNGEON.map,
        nbRooms: 1,
        rooms: ['lesser_vault'],
        maxBlockW: 12,
        maxBlockH: 12,
      },
    };
    let buildings = 0;
    let vaultInside = 0;
    for (let s = 0; s < 6; s += 1) {
      const seed = `building-light:${String(s)}`;
      const level = newLevel(table, seed, OPTS);
      expect(level.failed, seed).toBe(false);
      const rng = createRng(`${seed}#${String(level.attempts)}`);
      const map = createGenMap(table.width, table.height, table.map.grid, rng);
      if (table.map.class !== 'Building') throw new Error('not a Building table');
      const gen = createBuilding(
        map,
        table.map,
        rng,
        { maxLevel: OPTS.maxLevel },
        { forceRecreate: null },
      );
      generateBuilding(gen, OPTS.level, OPTS.level - 1);
      const rooms = map.rooms.flatMap((r) =>
        r.room.ignoresLite === true
          ? []
          : [{ x0: r.x, y0: r.y, x1: r.x + r.room.w - 1, y1: r.y + r.room.h - 1 }],
      );
      const insides = gen.buildings.map((b) => ({
        x0: b.x1 + 1,
        y0: b.y1 + 1,
        x1: b.x2 - 1,
        y1: b.y2 - 1,
        cells: b.floored,
      }));
      buildings += insides.length;
      expect(level.map.rooms, seed).toEqual([...rooms, ...insides]);
      // A vault the BSP cut buildings over keeps its cells out of every one.
      const vaultCells = new Set<number>();
      for (const r of map.rooms) {
        for (let y = r.y; y < r.y + r.room.h; y += 1) {
          for (let x = r.x; x < r.x + r.room.w; x += 1) {
            if (map.cell(x, y).special === true) vaultCells.add(y * map.w + x);
          }
        }
      }
      for (const inside of insides) {
        const inRect = (at: number): boolean => {
          const x = at % map.w;
          const y = (at - x) / map.w;
          return x >= inside.x0 && x <= inside.x1 && y >= inside.y0 && y <= inside.y1;
        };
        for (const at of vaultCells) if (inRect(at)) vaultInside += 1;
        for (const at of inside.cells) {
          expect(inRect(at), seed).toBe(true);
          expect(vaultCells.has(at), `${seed}: a vault cell lit with its building`).toBe(false);
        }
      }
    }
    expect(buildings).toBeGreaterThan(20);
    // The vaults must stand inside buildings for the last check to mean anything.
    expect(vaultInside).toBeGreaterThan(0);
  });
});
