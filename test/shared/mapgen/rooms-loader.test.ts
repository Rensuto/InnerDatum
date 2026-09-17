// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// The rules under test are ported from t-engine4 game/engines/default/engine/generator/map/RoomsLoader.lua:560-929
//   and game/modules/tome/data/rooms/{simple,money_vault,pit,lesser_vault,random_room}.lua.
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

import { describe, expect, it } from 'vitest';

import { createGenMap } from '../../../src/shared/mapgen/genmap.ts';
import type { GenMap, GridKeys } from '../../../src/shared/mapgen/genmap.ts';
import { createRoomer } from '../../../src/shared/mapgen/roomer.ts';
import {
  canDoor,
  loadRoom,
  markTunnel,
  placeDoors,
  roomAlloc,
  roomPlace,
  roomsLoaderInit,
  tunnel,
  tunnelDir,
} from '../../../src/shared/mapgen/rooms-loader.ts';
import type {
  GeneratedRoom,
  Room,
  RoomerData,
  RoomFn,
  RoomsGen,
} from '../../../src/shared/mapgen/rooms-loader.ts';
import { TileCode } from '../../../src/shared/protocol.ts';
import { createRng } from '../../../src/shared/rng.ts';
import { turnVault } from '../../../src/shared/vault.ts';
import type { VaultTurn } from '../../../src/shared/vault.ts';
import { ALL_VAULTS } from '../../../src/shared/vaults.ts';

const KEYS: GridKeys = {
  '.': TileCode.FLOOR,
  '#': TileCode.WALL,
  '+': TileCode.DOOR,
  door: TileCode.DOOR,
  up: TileCode.FLOOR,
  down: TileCode.FLOOR,
};

/** `#` wall, `.` floor, `+` door, `~` nil terrain; anything else is left nil too. */
const CODE: Readonly<Record<string, TileCode>> = {
  '#': TileCode.WALL,
  '.': TileCode.FLOOR,
  '+': TileCode.DOOR,
};

function setup(
  rows: readonly string[],
  data: Partial<RoomerData> = {},
  seed = 'rooms-loader',
): { gen: RoomsGen; map: GenMap } {
  const rng = createRng(seed);
  const grid = data.grid ?? KEYS;
  const map = createGenMap(rows[0]?.length ?? 0, rows.length, grid, rng);
  rows.forEach((row, y) => {
    [...row].forEach((c, x) => map.set(x, y, CODE[c] ?? null));
  });
  const gen = createRoomer(map, { ...data, grid }, rng, { maxLevel: 3 }, { forceRecreate: null });
  return { gen, map };
}

function walls(w: number, h: number): string[] {
  return Array.from({ length: h }, () => '#'.repeat(w));
}

function row(map: GenMap, y: number): string {
  let out = '';
  for (let x = 0; x < map.w; x += 1) {
    const c = map.get(x, y);
    out += c === TileCode.FLOOR ? '.' : c === TileCode.DOOR ? '+' : c === null ? '~' : '#';
  }
  return out;
}

describe('canDoor — will a door here lead anywhere', () => {
  const at = (rows: readonly string[]): boolean => canDoor(setup(rows).gen, 2, 2);

  it('takes a one-wide corridor through a wall', () => {
    expect(at(['#####', '##.##', '##.##', '##.##', '#####'])).toBe(true);
  });

  it('takes a corridor meeting a room, where only ONE side`s diagonals are walled', () => {
    // N-S open, W-E walled, NW+NE walled, SW+SE open: the room is south.
    expect(at(['#####', '##.##', '##.##', '#...#', '#####'])).toBe(true);
    // The same turned a quarter: W-E open, room to the east.
    expect(at(['#####', '###..', '#....', '###..', '#####'])).toBe(true);
  });

  it('refuses when each side has an open diagonal (RL:798-802)', () => {
    // NW open and SE open: neither dirSides set is wholly blocked.
    expect(at(['#####', '#..##', '##.##', '##..#', '#####'])).toBe(false);
    // Both diagonals on ONE flank open, on each side: every one of the four
    // cells in a side set counts, not three of them.
    expect(at(['#####', '#..##', '##.##', '#..##', '#####'])).toBe(false);
    expect(at(['#####', '##..#', '##.##', '##..#', '#####'])).toBe(false);
  });

  it('refuses an opening two wide', () => {
    expect(at(['#####', '##.##', '#..##', '##.##', '#####'])).toBe(false);
  });

  it('counts off the map as open, since checkEntity returns nil there', () => {
    // The door candidate at (1,0): north is off the map, south is floor.
    expect(canDoor(setup(['#.#', '#.#', '###']).gen, 1, 0)).toBe(true);
  });

  it('counts a shut door as blocked and nil terrain as open', () => {
    expect(at(['#####', '##.##', '#+.##', '##.##', '#####'])).toBe(true);
    expect(at(['#####', '##.##', '#~.##', '##.##', '#####'])).toBe(false);
  });
});

describe('tunnel', () => {
  // `tunnelChange` 0 never reconsiders the heading, so a tunnel along one row
  // goes straight and every refusal is visible as the row stopping.
  const straight = { tunnelChange: 0, tunnelRandom: 0 };

  it('walks through room and special cells without carving them, and never carves its start', () => {
    const { gen, map } = setup(walls(25, 7), straight);
    for (let y = 0; y < 7; y += 1) {
      for (let x = 8; x <= 10; x += 1) map.cell(x, y).room = 99;
    }
    map.cell(14, 3).special = true;
    map.cell(14, 3).canOpen = true;
    tunnel(gen, 1, 3, 20, 3, 1);
    expect(row(map, 3)).toBe('##......###...#......####');
    for (const y of [0, 1, 2, 4, 5, 6]) expect(row(map, y)).toBe('#'.repeat(25));
  });

  it('records a door candidate only where it breaks a can_open wall, and shuts that wall`s neighbours', () => {
    const { gen, map } = setup(walls(25, 7), straight);
    map.cell(5, 3).canOpen = true;
    map.cell(5, 2).canOpen = true;
    map.cell(6, 4).canOpen = true;
    map.cell(9, 3).room = 99;
    map.cell(9, 3).canOpen = true;
    map.cell(12, 3).canOpen = true;
    tunnel(gen, 1, 3, 20, 3, 1);

    expect(map.possibleDoors).toEqual([
      { x: 5, y: 3 },
      { x: 12, y: 3 },
    ]);
    // Carved at the crossings, not inside the room.
    expect(row(map, 3)).toBe('##.......#...........####');
    expect(map.get(9, 3)).toBe(TileCode.WALL);
    expect([map.cell(5, 2).canOpen, map.cell(6, 4).canOpen]).toEqual([false, false]);
    // Only a TRUTHY can_open is shut; nil stays nil, and the crossed cell keeps its own.
    expect(map.cell(4, 4).canOpen).toBeNull();
    expect(map.cell(5, 3).canOpen).toBe(true);
  });

  it('records no door candidate when the zone has no door key', () => {
    const { gen, map } = setup(walls(25, 7), {
      ...straight,
      grid: { '.': TileCode.FLOOR, '#': TileCode.WALL },
    });
    map.cell(5, 3).canOpen = true;
    tunnel(gen, 1, 3, 20, 3, 1);
    expect(map.possibleDoors).toEqual([]);
    expect(map.get(5, 3)).toBe(TileCode.FLOOR);
  });

  it('refuses a can_open = false wall, a room wall marked so, and a special cell', () => {
    for (const mark of [
      (map: GenMap) => {
        map.cell(6, 3).canOpen = false;
      },
      (map: GenMap) => {
        map.cell(6, 3).room = 99;
        map.cell(6, 3).canOpen = false;
      },
      (map: GenMap) => {
        map.cell(6, 3).special = true;
      },
    ]) {
      const { gen, map } = setup(walls(25, 7), straight);
      mark(map);
      tunnel(gen, 1, 3, 20, 3, 1);
      expect(row(map, 3)).toBe(`##....${'#'.repeat(19)}`);
    }
  });

  it('steps onto a special TARGET without carving it, and stops there', () => {
    const { gen, map } = setup(walls(25, 7), straight);
    map.cell(20, 3).special = true;
    tunnel(gen, 1, 3, 20, 3, 1);
    expect(row(map, 3)).toBe(`##${'.'.repeat(18)}#####`);
    // Nineteen steps, one heading roll each. A tunnel refused at its target
    // would spend all 2000 tries.
    expect(gen.rng.getState().count).toBeLessThan(40);
  });

  it('picks one axis on a diagonal target with one draw, and draws nothing on a straight one', () => {
    const { gen } = setup(walls(3, 3));
    const before = gen.rng.getState().count;
    expect(tunnelDir(gen, 0, 0, 0, 5)).toEqual([0, 1]);
    expect(tunnelDir(gen, 5, 0, 0, 0)).toEqual([-1, 0]);
    expect(gen.rng.getState().count).toBe(before);
    const step = tunnelDir(gen, 0, 0, 4, -4);
    expect(gen.rng.getState().count).toBe(before + 1);
    expect([
      [1, 0],
      [0, -1],
    ]).toContainEqual(step);
  });
});

describe('markTunnel', () => {
  it('marks the cell entered, its two flanks and the cell left, but never overwrites a mark', () => {
    const { gen, map } = setup(walls(5, 5));
    map.cell(3, 2).tunnel = 7;
    // Moved north from (2,3) into (2,2).
    markTunnel(gen, 2, 2, 0, -1, 4);
    const ids: (number | null)[][] = [];
    for (let y = 0; y < 5; y += 1) {
      ids.push([0, 1, 2, 3, 4].map((x) => map.cell(x, y).tunnel));
    }
    expect(ids).toEqual([
      [null, null, null, null, null],
      [null, null, null, null, null],
      [null, 4, 4, 7, null],
      [null, null, 4, null, null],
      [null, null, null, null, null],
    ]);
    expect(map.cell(2, 3).realTunnel).toBe(4);
  });

  it('marks nothing for a tunnel with no id, but still records the real tunnel', () => {
    const { gen, map } = setup(walls(5, 5));
    markTunnel(gen, 2, 2, 0, -1, null);
    expect(map.cells.every((c) => c.tunnel === null)).toBe(true);
    expect(map.cell(2, 3).realTunnel).toBe(true);
  });
});

describe('placeDoors', () => {
  const corridor = ['#####', '##.##', '##.##', '##.##', '#####'];

  it('hangs a door on a candidate that rolls under the chance and passes canDoor', () => {
    const { gen, map } = setup(corridor);
    map.possibleDoors.push({ x: 2, y: 2 });
    placeDoors(gen, 100);
    expect(map.get(2, 2)).toBe(TileCode.DOOR);
  });

  it('refuses a candidate canDoor refuses, even at 100', () => {
    // A crossroads: every side has an open neighbour.
    const { gen, map } = setup(['#####', '##.##', '#...#', '##.##', '#####']);
    map.possibleDoors.push({ x: 2, y: 2 });
    placeDoors(gen, 100);
    expect(map.get(2, 2)).toBe(TileCode.FLOOR);
  });

  it('rolls for every candidate, at chance 0 too, and asks canDoor only on a hit', () => {
    // One draw per candidate whatever happens, so a level's later numbers never
    // depend on which walls happened to be door-shaped.
    const { gen, map } = setup(corridor);
    map.possibleDoors.push({ x: 2, y: 2 }, { x: 0, y: 0 }, { x: 2, y: 2 });
    placeDoors(gen, 0);
    expect(map.get(2, 2)).toBe(TileCode.FLOOR);
    expect(gen.rng.getState().count).toBe(3);
  });
});

describe('roomAlloc — where a room may go', () => {
  /** A 3x3 room with a one-tile border, stamped as nothing. */
  const probe: Room = { name: 'probe', w: 3, h: 3, border: 1, generator: () => null };

  /**
   * On a 7x7 map a bordered 3x3 room can sit at x and y in 1..3. Accepting only
   * (1,1) makes the overlap test at that one position the whole answer: 101
   * tries hit it (the chance of missing is about seven in a million, and the
   * seed is fixed).
   */
  function allocAt11(flag: (map: GenMap) => void): { x: number; y: number } | null {
    const { gen, map } = setup(walls(7, 7), {}, 'alloc');
    flag(map);
    const placed = roomAlloc(gen, probe, 1, 1, 0, (_room, x, y) => x === 1 && y === 1);
    return placed === null ? null : { x: placed.x, y: placed.y };
  }

  it('places when nothing is in the way', () => {
    expect(allocAt11(() => undefined)).toEqual({ x: 1, y: 1 });
  });

  it('refuses a room cell anywhere in the footprint or its border ring', () => {
    expect(allocAt11((m) => (m.cell(0, 0).room = 5))).toBeNull();
    expect(allocAt11((m) => (m.cell(2, 2).room = 5))).toBeNull();
    expect(allocAt11((m) => (m.cell(4, 4).room = 5))).toBeNull();
  });

  it('lets another room`s border ring overlap this room`s border ring', () => {
    expect(allocAt11((m) => (m.cell(4, 2).border = 5))).toEqual({ x: 1, y: 1 });
    expect(allocAt11((m) => (m.cell(2, 0).border = 5))).toEqual({ x: 1, y: 1 });
    expect(allocAt11((m) => (m.cell(2, 2).border = 5))).toBeNull();
  });

  it('KEEPS upstream`s `j < j+room.h`: a border cell in the row below the footprint blocks', () => {
    // (2,4) is inside the room's columns and one row below its last row. The
    // test meant to ask `j < y+room.h`, which would allow it; as written it
    // blocks (RoomsLoader.lua:722).
    expect(allocAt11((m) => (m.cell(2, 4).border = 5))).toBeNull();
  });

  it('refuses a room too big for the map, border counted twice, before drawing a position', () => {
    // 3 wide plus a border each side leaves 1 of 6 columns, and two are needed.
    // Each axis alone, so neither half of the test can hide behind the other.
    for (const [w, h] of [
      [6, 30],
      [30, 6],
    ] as const) {
      const { gen, map } = setup(walls(w, h), {}, 'too-big');
      const before = gen.rng.getState().count;
      expect(roomAlloc(gen, probe, 1, 1, 0)).toBeNull();
      expect(gen.rng.getState().count).toBe(before);
      expect(map.roomsFailed.map((f) => f.failure)).toEqual(['placement']);
    }
    // One more column and it fits.
    expect(roomAlloc(setup(walls(7, 7), {}, 'fits').gen, probe, 1, 1, 0)).not.toBeNull();
  });

  it('refuses a second room with the same unique tag', () => {
    const { gen, map } = setup(walls(30, 30), {}, 'unique');
    const once: Room = { name: 'once', w: 3, h: 3, unique: 'once', generator: () => null };
    expect(roomAlloc(gen, once, 1, 1, 0)).not.toBeNull();
    expect(roomAlloc(gen, once, 2, 1, 0)).toBeNull();
    expect(map.roomsFailed.map((f) => f.failure)).toEqual(['unique:once']);
  });
});

describe('roomPlace', () => {
  it('reads an ASCII room: `!` opens, an edge `#` refuses, an inner `#` belongs to the room', () => {
    const { gen, map } = setup(walls(12, 12), {}, 'ascii');
    const smallX = loadRoom('small_x');
    if (typeof smallX === 'function') throw new Error('small_x is an ASCII room');
    const before = gen.rng.getState().count;
    const placed = roomPlace(gen, smallX, 3, 2, 2);
    // One draw: the lit roll, made whether or not anything reads it.
    expect(gen.rng.getState().count).toBe(before + 1);
    expect([placed.cx, placed.cy]).toEqual([4, 4]);

    // small_x: #!!!# / !#.#! / !.#.! / !#.#! / #!!!#
    expect(map.cell(2, 2)).toMatchObject({ room: null, canOpen: false });
    expect(map.cell(3, 2)).toMatchObject({ room: null, canOpen: true });
    expect(map.cell(3, 3)).toMatchObject({ room: 3, canOpen: null });
    expect(map.cell(4, 3)).toMatchObject({ room: 3, canOpen: null });
    expect([row(map, 2), row(map, 3), row(map, 4)]).toEqual([
      '############',
      '####.#######',
      '###.#.######',
    ]);
    // No border: nothing around it is marked.
    expect(map.cells.every((c) => c.border === null)).toBe(true);
  });

  it('marks a border ring outside the footprint only', () => {
    const { gen, map } = setup(walls(10, 10), {}, 'border');
    roomPlace(gen, { name: 'b', w: 2, h: 2, border: 1, generator: () => null }, 6, 4, 4);
    const marked: string[] = [];
    for (let y = 0; y < 10; y += 1) {
      for (let x = 0; x < 10; x += 1) if (map.cell(x, y).border === 6) marked.push(`${x},${y}`);
    }
    expect(marked).toHaveLength(12);
    expect(marked).not.toContain('4,4');
    expect(marked).toContain('3,3');
    expect(marked).toContain('6,6');
  });
});

describe('the room functions', () => {
  const fn = (name: string): RoomFn => {
    const def = loadRoom(name);
    if (typeof def !== 'function') throw new Error(`${name} is not a room function`);
    return def;
  };
  const made = (name: string, gen: RoomsGen, id = 4): GeneratedRoom => {
    const room = fn(name)(gen, id, 1, 0);
    if (room === null || 'failure' in room || !('generator' in room)) {
      throw new Error(`${name} made no generated room`);
    }
    return room;
  };

  it('simple: 5..12 each way, a ring a tunnel may open around floor the room owns', () => {
    const sizes = new Set<number>();
    for (let s = 0; s < 80; s += 1) {
      const { gen } = setup(walls(20, 20), {}, `simple:${String(s)}`);
      const room = made('simple', gen);
      sizes.add(room.w).add(room.h);
    }
    expect(Math.min(...sizes)).toBe(5);
    expect(Math.max(...sizes)).toBe(12);

    const { gen, map } = setup(walls(20, 20), {}, 'simple-stamp');
    const room = made('simple', gen, 9);
    roomPlace(gen, room, 9, 2, 2);
    for (let x = 2; x < 2 + room.w; x += 1) {
      for (let y = 2; y < 2 + room.h; y += 1) {
        const edge = x === 2 || y === 2 || x === 1 + room.w || y === 1 + room.h;
        expect(map.cell(x, y)).toMatchObject(edge ? { room: null, canOpen: true } : { room: 9 });
        expect(map.get(x, y)).toBe(edge ? TileCode.WALL : TileCode.FLOOR);
      }
    }
  });

  it('money_vault: a 5x5 simple room recorded as a vault, with none of the per-cell rolls', () => {
    const { gen, map } = setup(walls(12, 12), {}, 'money');
    const before = gen.rng.getState().count;
    const room = made('money_vault', gen);
    expect(gen.rng.getState().count).toBe(before);
    expect(room.vault).toEqual({ id: 'room:money_vault', turn: 'none', w: 5, h: 5 });
    roomPlace(gen, room, 4, 3, 3);
    // Only roomPlace's lit roll.
    expect(gen.rng.getState().count).toBe(before + 1);
    expect(row(map, 5)).toBe('####...#####');
    expect(map.cell(3, 5).canOpen).toBe(true);
  });

  it('pit: one door on the inner ring, and tunnels aim at it', () => {
    for (let s = 0; s < 30; s += 1) {
      const { gen, map } = setup(walls(20, 20), {}, `pit:${String(s)}`);
      const room = made('pit', gen);
      const placed = roomPlace(gen, room, 4, 2, 2);
      const door = { x: placed.cx, y: placed.cy };
      expect(map.get(door.x, door.y)).toBe(TileCode.DOOR);
      expect(map.cell(door.x, door.y).canOpen).toBe(true);
      // The inner ring is i = 3..w-2 in the room's 1-based coordinates.
      const x0 = 2 + 2;
      const y0 = 2 + 2;
      const x1 = 2 + room.w - 3;
      const y1 = 2 + room.h - 3;
      expect(door.x === x0 || door.x === x1 || door.y === y0 || door.y === y1).toBe(true);
      let doors = 0;
      for (let x = x0; x <= x1; x += 1) {
        for (let y = y0; y <= y1; y += 1) {
          const ring = x === x0 || x === x1 || y === y0 || y === y1;
          if (!ring) expect(map.cell(x, y).special).toBe(true);
          else if (map.get(x, y) === TileCode.DOOR) doors += 1;
          else expect(map.cell(x, y).canOpen).toBe(false);
        }
      }
      expect(doors).toBe(1);
      expect(room.vault?.id).toBe('room:pit');
    }
  });

  it('pit: a zone with no `+` key leaves the pit sealed, as a nil resolve does', () => {
    // A `door` key, but no `'+'`: the pit resolves the latter.
    const grid = { '.': TileCode.FLOOR, '#': TileCode.WALL, door: TileCode.DOOR };
    const { gen, map } = setup(walls(20, 20), { grid });
    const placed = roomPlace(gen, made('pit', gen), 4, 2, 2);
    expect(map.get(placed.cx, placed.cy)).toBe(TileCode.WALL);
  });

  it('lesser_vault: replaces the room map under it, and aims tunnels at the turned door', () => {
    const filing = ALL_VAULTS.find((v) => v.id === 'vault:filing_chamber');
    if (filing === undefined) throw new Error('filing_chamber is gone');
    const turns = new Set<string>();
    for (let s = 0; s < 60; s += 1) {
      const seed = `vault:${String(s)}`;
      const { gen, map } = setup(walls(30, 30), { lesserVaultsList: [filing.id] }, seed);
      for (const c of map.cells) Object.assign(c, { border: 3, tunnel: 2, canOpen: false });
      const room = made('lesser_vault', gen, 7);
      const placed = roomPlace(gen, room, 7, 5, 6);
      const turn = room.vault?.turn ?? 'none';
      turns.add(turn);
      const shape = turnVault(filing, turn as VaultTurn);
      // The record is the drawing, one tile in from the room's apron.
      expect(room.vault).toEqual({ id: filing.id, turn, w: shape.w, h: shape.h, inset: 1 });
      expect([room.w, room.h, room.border, room.ignoresLite]).toEqual([
        shape.w + 2,
        shape.h + 2,
        0,
        true,
      ]);

      // The aim is the door, whatever the turn.
      expect(map.get(placed.cx, placed.cy)).toBe(TileCode.DOOR);
      expect(map.spots).toEqual([
        {
          x: placed.cx,
          y: placed.cy,
          checkConnectivity: 'entrance',
          type: 'vault',
          subtype: 'lesser',
        },
      ]);
      // Every cell of the room, apron and all, is the vault's.
      for (let y = 0; y < room.h; y += 1) {
        for (let x = 0; x < room.w; x += 1) {
          const apron = x === 0 || y === 0 || x === room.w - 1 || y === room.h - 1;
          expect(map.get(5 + x, 6 + y)).toBe(
            apron ? TileCode.FLOOR : shape.tiles[(y - 1) * shape.w + (x - 1)],
          );
          expect(map.cell(5 + x, 6 + y)).toEqual({
            room: 7,
            canOpen: true,
            special: true,
            border: null,
            tunnel: null,
            realTunnel: null,
          });
        }
      }
    }
    expect(turns.size).toBe(6);
  });

  it('lesser_vault: lays the drawing in a ring of floor, so a tunnel through it comes out on floor', () => {
    // All four of Kor'Pul's vaults draw that ring themselves and set border 0
    // (maps/vaults/auto/lesser/circle.lua:21). A tunnel walks through a vault
    // without carving, so without the ring a corridor ends against its wall.
    const filing = ALL_VAULTS.find((v) => v.id === 'vault:filing_chamber');
    if (filing === undefined) throw new Error('filing_chamber is gone');
    for (let s = 0; s < 12; s += 1) {
      const { gen, map } = setup(
        walls(30, 30),
        { tunnelChange: 0, lesserVaultsList: [filing.id] },
        `apron:${String(s)}`,
      );
      const room = made('lesser_vault', gen, 3);
      roomPlace(gen, room, 3, 10, 10);
      // The drawing's second row is walled at both ends in every turn: the only
      // gap in its edge is the door, in the middle of one side.
      const y = 12;
      tunnel(gen, 2, y, 27, y, 9);
      const east = 10 + room.w - 1;
      expect(row(map, y).slice(9, 11), `west, turn ${room.vault?.turn ?? ''}`).toBe('..');
      expect(row(map, y).slice(east, east + 2), `east, turn ${room.vault?.turn ?? ''}`).toBe('..');
    }
  });

  it('lesser_vault: a blank in the drawing becomes floor', () => {
    const shelving = ALL_VAULTS.find((v) => v.id === 'vault:shelving_run');
    if (shelving === undefined) throw new Error('shelving_run is gone');
    const { gen, map } = setup(walls(30, 30), { lesserVaultsList: [shelving.id] }, 'blank');
    const room = made('lesser_vault', gen);
    roomPlace(gen, room, 4, 5, 5);
    const shape = turnVault(shelving, (room.vault?.turn ?? 'none') as VaultTurn);
    for (let i = 0; i < shape.tiles.length; i += 1) {
      const x = 6 + (i % shape.w);
      const y = 6 + Math.floor(i / shape.w);
      expect(map.get(x, y)).toBe(shape.tiles[i] ?? TileCode.FLOOR);
    }
    expect(shape.tiles).toContain(null);
  });

  it('lesser_vault: builds the drawing in the zone`s own wall, floor and door', () => {
    // Upstream's vault legend is looked up in the zone's grid list
    // (engine/generator/map/Static.lua:33), so a vault is made of the level
    // around it. Every code of the drawing, turned, comes out as its key's.
    const clerks = ALL_VAULTS.find((v) => v.id === 'vault:clerks_box');
    if (clerks === undefined) throw new Error('clerks_box is gone');
    const grid: GridKeys = {
      ...KEYS,
      '.': TileCode.SOOT,
      '#': TileCode.WORKS,
      door: TileCode.DOOR_OPEN,
    };
    const { gen, map } = setup(walls(30, 30), { lesserVaultsList: [clerks.id], grid }, 'keys');
    const room = made('lesser_vault', gen);
    roomPlace(gen, room, 4, 5, 5);
    const shape = turnVault(clerks, (room.vault?.turn ?? 'none') as VaultTurn);
    const want: Readonly<Record<number, TileCode>> = {
      [TileCode.FLOOR]: TileCode.SOOT,
      [TileCode.WALL]: TileCode.WORKS,
      [TileCode.DOOR]: TileCode.DOOR_OPEN,
    };
    const seen = new Set<number>();
    shape.tiles.forEach((drawn, i) => {
      const code = drawn ?? TileCode.FLOOR;
      seen.add(code);
      expect(map.get(6 + (i % shape.w), 6 + Math.floor(i / shape.w))).toBe(want[code]);
    });
    expect(seen).toEqual(new Set([TileCode.FLOOR, TileCode.WALL, TileCode.DOOR]));
    // And the apron is the zone's floor too.
    expect(map.get(5, 5)).toBe(TileCode.SOOT);
  });

  it('lesser_vault: fails with upstream`s reason when no listed vault exists', () => {
    const { gen } = setup(walls(30, 30), { lesserVaultsList: ['vault:nope', 'vault:nor_this'] });
    expect(fn('lesser_vault')(gen, 1, 1, 0)).toEqual({
      failure: 'lesser_vault: no appropriate vaults found',
    });
  });

  it('random_room: a named ASCII room comes back as itself, `simple` is run', () => {
    const ascii = setup(walls(20, 20), { randomRoomsList: ['small_x'] });
    expect(fn('random_room')(ascii.gen, 1, 1, 0)).toBe(loadRoom('small_x'));
    const simple = setup(walls(20, 20), { randomRoomsList: ['simple'] });
    expect(made('random_room', simple.gen).name).toMatch(/^simple\d+x\d+$/);
  });
});

describe('loading', () => {
  it('throws for a file that does not exist, including Object.prototype names', () => {
    expect(() => loadRoom('no_such_room')).toThrow(/no room file/);
    expect(() => loadRoom('toString')).toThrow(/no room file/);
  });

  it('sizes an ASCII room from its first row and row count, and caches it', () => {
    const room = loadRoom('zigzag');
    expect(room).toMatchObject({ name: 'zigzag', w: 5, h: 19 });
    expect(loadRoom('zigzag')).toBe(room);
  });

  it('refuses a room list that could never pick anything', () => {
    expect(() =>
      roomsLoaderInit({
        grid: KEYS,
        rooms: [
          ['simple', 0],
          ['pit', 0],
        ],
      }),
    ).toThrow(/chance 0/);
  });
});
