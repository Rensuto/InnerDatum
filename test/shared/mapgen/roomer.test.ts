// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// The generator under test is ported from t-engine4 game/engines/default/engine/generator/map/Roomer.lua:28-253.
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

import { describe, expect, it } from 'vitest';

import { createGenMap } from '../../../src/shared/mapgen/genmap.ts';
import type { GenMap } from '../../../src/shared/mapgen/genmap.ts';
import { ROOMER_RUINS_KOR_PUL } from '../../../src/shared/mapgen/level.ts';
import { createRoomer, generate } from '../../../src/shared/mapgen/roomer.ts';
import type { RoomerResult } from '../../../src/shared/mapgen/roomer.ts';
import type { RoomerData, RoomsGen } from '../../../src/shared/mapgen/rooms-loader.ts';
import { TileCode } from '../../../src/shared/protocol.ts';
import { createRng } from '../../../src/shared/rng.ts';

const SEEDS = 40;
const KOR_PUL = ROOMER_RUINS_KOR_PUL.map;

function run(
  seed: string,
  data: RoomerData = KOR_PUL,
  opts: { w?: number; h?: number; level?: number; maxLevel?: number } = {},
): { gen: RoomsGen; map: GenMap; result: RoomerResult | null; forceRecreate: string | null } {
  const rng = createRng(seed);
  const map = createGenMap(opts.w ?? 50, opts.h ?? 50, data.grid, rng);
  const level = { forceRecreate: null as string | null };
  const gen = createRoomer(map, data, rng, { maxLevel: opts.maxLevel ?? 3 }, level);
  const result = generate(gen, opts.level ?? 1, 0);
  return { gen, map, result, forceRecreate: level.forceRecreate };
}

describe('Roomer:generate on the Kor`Pul table', () => {
  const runs = Array.from({ length: SEEDS }, (_, i) => run(`roomer:${String(i)}`));

  it('places no more rooms than nb_rooms, each clear of the map`s edge', () => {
    for (const { map } of runs) {
      expect(map.rooms.length).toBeGreaterThan(0);
      expect(map.rooms.length).toBeLessThanOrEqual(10);
      for (const r of map.rooms) {
        const edge = Math.max(1, r.room.border ?? 0);
        expect(r.x).toBeGreaterThanOrEqual(edge);
        expect(r.x + r.room.w).toBeLessThanOrEqual(50 - edge);
        expect(r.y + r.room.h).toBeLessThanOrEqual(50 - edge);
      }
    }
  });

  it('never carves an ASCII room`s inner walls or a vault`s drawing', () => {
    // Tunnels cross rooms constantly on their way to a centre, so a tunnel that
    // carved the cells it walks through would open these on most levels.
    let innerWalls = 0;
    for (const { map } of runs) {
      for (const placed of map.rooms) {
        const room = placed.room;
        if ('rows' in room) {
          for (let j = 1; j < room.h - 1; j += 1) {
            for (let i = 1; i < room.w - 1; i += 1) {
              if (room.rows[j]?.charAt(i) !== '#') continue;
              innerWalls += 1;
              expect(map.get(placed.x + i, placed.y + j)).toBe(TileCode.WALL);
            }
          }
        }
      }
    }
    expect(innerWalls).toBeGreaterThan(100);
  });

  it('puts both stairs on open floor that belongs to no vault, marked as exits', () => {
    for (const { map, result } of runs) {
      expect(result).not.toBeNull();
      for (const stair of [result?.up, result?.down]) {
        if (stair === null || stair === undefined) throw new Error('a stair is missing');
        expect(map.get(stair.x, stair.y)).toBe(TileCode.FLOOR);
        expect(map.cell(stair.x, stair.y).special).toBe('exit');
        for (const r of map.rooms) {
          if (r.room.vault === undefined || r.room.vault.id.startsWith('room:')) continue;
          const inside =
            stair.x >= r.x &&
            stair.x < r.x + r.room.w &&
            stair.y >= r.y &&
            stair.y < r.y + r.room.h;
          expect(inside).toBe(false);
        }
      }
    }
  });

  it('hangs every door outside a vault where a tunnel broke a wall', () => {
    let doors = 0;
    for (const { map } of runs) {
      const candidates = new Set(map.possibleDoors.map((d) => `${String(d.x)},${String(d.y)}`));
      for (let y = 0; y < 50; y += 1) {
        for (let x = 0; x < 50; x += 1) {
          if (map.get(x, y) !== TileCode.DOOR || map.cell(x, y).special === true) continue;
          doors += 1;
          expect(candidates.has(`${String(x)},${String(y)}`)).toBe(true);
        }
      }
    }
    expect(doors).toBeGreaterThan(SEEDS);
  });

  it('spots every room at the cell tunnels aim for, after any vault`s own spot', () => {
    for (const { map, result } of runs) {
      const rooms = result?.spots.filter((s) => s.type === 'room') ?? [];
      expect(rooms).toEqual(
        map.rooms.map((r) => ({ x: r.cx, y: r.cy, type: 'room', subtype: r.room.name })),
      );
      const vaults = result?.spots.filter((s) => s.type === 'vault') ?? [];
      expect(result?.spots.slice(0, vaults.length)).toEqual(vaults);
    }
  });

  it('is the same level for the same seed and a different one for another', () => {
    const again = run('roomer:0');
    expect(Array.from(again.map.tiles)).toEqual(Array.from(runs[0]?.map.tiles ?? []));
    expect(Array.from(runs[1]?.map.tiles ?? [])).not.toEqual(Array.from(runs[0]?.map.tiles ?? []));
  });
});

describe('Roomer options', () => {
  it('puts edge-entrance stairs on the named sides', () => {
    for (let s = 0; s < 10; s += 1) {
      const { map, result } = run(`edges:${String(s)}`, { ...KOR_PUL, edgeEntrances: [4, 6] });
      expect(result?.up?.x).toBe(0);
      expect(result?.down?.x).toBe(49);
      for (const stair of [result?.up, result?.down]) {
        if (stair === null || stair === undefined) throw new Error('a stair is missing');
        expect(map.get(stair.x, stair.y)).toBe(TileCode.FLOOR);
      }
    }
  });

  it('places no down stair on the last level unless forced', () => {
    const last = run('last', { ...KOR_PUL, forceLastStair: false }, { level: 3, maxLevel: 3 });
    expect(last.result?.down).toBeNull();
    expect(last.result?.up).not.toBeNull();
    const forced = run('last', { ...KOR_PUL, forceLastStair: true }, { level: 3, maxLevel: 3 });
    expect(forced.result?.down).not.toBeNull();
  });

  it('digs no tunnel and hangs no door when no_tunnels is set', () => {
    for (let s = 0; s < 10; s += 1) {
      const { map } = run(`none:${String(s)}`, { ...KOR_PUL, noTunnels: true });
      expect(map.possibleDoors).toEqual([]);
      expect(map.cells.every((c) => c.tunnel === null)).toBe(true);
    }
  });

  it('asks for the level to be recreated when a required room cannot be placed', () => {
    const { result, forceRecreate } = run('required', {
      ...KOR_PUL,
      requiredRooms: ['lesser_vault'],
      lesserVaultsList: [],
    });
    expect(result).toBeNull();
    expect(forceRecreate).toBe('required_room lesser_vault');
  });

  it('spends required rooms out of nb_rooms', () => {
    const { map } = run('required-count', {
      ...KOR_PUL,
      nbRooms: 3,
      rooms: ['simple'],
      requiredRooms: ['money_vault', 'money_vault'],
    });
    expect(map.rooms.map((r) => r.room.name.startsWith('money_vault'))).toEqual([
      true,
      true,
      false,
    ]);
  });
});
