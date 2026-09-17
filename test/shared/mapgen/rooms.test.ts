// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// The data under test is ported from t-engine4 game/modules/tome/data/rooms/.
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

import { existsSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { ASCII_ROOMS, RANDOM_ROOM_LIST } from '../../../src/shared/mapgen/rooms.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE ROOM LIBRARY — upstream's 74 ASCII rooms, and `random_room`'s pool.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `shared/mapgen/rooms.ts` is data copied byte for byte, so the failure worth
 * guarding is a row that stops being upstream's: a dropped character, a tidied
 * edge, a room redrawn from memory. The sizes below are NOT read back from the
 * data. They were measured from `modules/tome/data/rooms/*.lua` (`w = #row1`,
 * `h = #rows`, as `engine/generator/map/RoomsLoader.lua:409` sizes a room), so a
 * row that loses or gains a cell fails here even though it is still rectangular
 * and still only `#`, `.` and `!`.
 */

/** `[w, h]` of every ASCII room file upstream. */
const SIZES: Readonly<Record<string, readonly [number, number]>> = {
  basic_cell: [9, 9],
  big_cells: [8, 9],
  big_cross: [13, 11],
  big_inner_circle: [11, 11],
  broken_infinity: [9, 9],
  broken_room: [10, 9],
  broken_x: [9, 9],
  cells: [13, 13],
  cells10: [11, 7],
  cells2: [12, 11],
  cells3: [10, 8],
  cells4: [9, 10],
  cells5: [6, 13],
  cells6: [7, 10],
  cells7: [7, 9],
  cells8: [7, 7],
  cells9: [18, 5],
  center_arrows: [11, 15],
  circle_cross: [13, 9],
  circular: [15, 11],
  cross: [10, 14],
  cross_circled: [9, 9],
  cross_quartet: [13, 11],
  double_helix: [12, 6],
  double_t: [11, 11],
  double_y: [11, 7],
  equal: [9, 7],
  equal2: [9, 10],
  five_blocks: [16, 9],
  five_pillars: [10, 10],
  five_walls: [18, 7],
  four_blocks: [10, 10],
  four_chambers: [11, 11],
  h: [11, 7],
  hollow_cross: [13, 13],
  inner: [11, 11],
  inner_checkerboard: [9, 9],
  inner_circle: [8, 8],
  inner_circle2: [9, 8],
  inner_cross: [10, 10],
  inner_fort: [11, 9],
  inner_pillar: [9, 7],
  interstice: [13, 13],
  long_hall: [9, 14],
  long_hall2: [8, 14],
  micro_pillar: [12, 8],
  multi_pillar: [12, 9],
  narrow_spiral: [15, 8],
  nine_chambers: [13, 13],
  oval: [10, 14],
  pilar: [10, 5],
  pilar2: [10, 7],
  pilar_big: [10, 10],
  s: [10, 10],
  side_passages_2: [12, 12],
  side_passages_4: [10, 9],
  sideways_s: [11, 10],
  small_cross: [9, 9],
  small_inner_cross: [7, 7],
  small_x: [5, 5],
  spiral_cell: [9, 9],
  split1: [17, 7],
  split2: [15, 5],
  thick_n: [14, 14],
  thick_wall: [8, 13],
  tiny_pillars: [11, 11],
  two_domes: [17, 11],
  two_passages: [11, 15],
  weird1: [9, 9],
  weird2: [9, 9],
  womb: [9, 6],
  xroads: [7, 7],
  y: [13, 9],
  zigzag: [5, 19],
};

/**
 * FNV-1a (32-bit) of every room's rows joined by `\n`, computed from the upstream
 * files' `[[...]]` rows. A size and a legal alphabet let a cell change; this does
 * not. Regenerate from the Lua, never from `rooms.ts`, or the data certifies itself.
 */
const ROWS_FNV1A: Readonly<Record<string, string>> = {
  basic_cell: '10d6826e',
  big_cells: 'f3b8d95b',
  big_cross: 'cff5ef25',
  big_inner_circle: 'daf344b5',
  broken_infinity: '70c47165',
  broken_room: '55fc7d29',
  broken_x: '7613d299',
  cells: '211cc059',
  cells10: '736c6d1c',
  cells2: 'df4c48c7',
  cells3: '91c088ad',
  cells4: 'a5db0669',
  cells5: 'ebd06db3',
  cells6: '74393ce5',
  cells7: '3ffbbe25',
  cells8: 'e72b848d',
  cells9: '058966e1',
  center_arrows: 'e9455f15',
  circle_cross: 'cc3b215e',
  circular: 'bc77c6b5',
  cross: '1e47d0c9',
  cross_circled: '79408985',
  cross_quartet: '34f6bef9',
  double_helix: '4e2e3659',
  double_t: 'b663ee75',
  double_y: 'af2f1505',
  equal: 'c6f95fb1',
  equal2: 'fc32de59',
  five_blocks: '2ed9ffe1',
  five_pillars: '2dfc0111',
  five_walls: '50ff1fd9',
  four_blocks: '521ddb99',
  four_chambers: 'a558cc85',
  h: '7ad1d4a4',
  hollow_cross: 'da9253d6',
  inner: '728aced5',
  inner_checkerboard: '7bf7330a',
  inner_circle: '3933a211',
  inner_circle2: 'ad721f75',
  inner_cross: 'ce7975ad',
  inner_fort: '5c0b6c75',
  inner_pillar: '7cfa5ec6',
  interstice: '1427226d',
  long_hall: '01eaee45',
  long_hall2: '71e35679',
  micro_pillar: '3bae0ad5',
  multi_pillar: '37d321dd',
  narrow_spiral: '86521a45',
  nine_chambers: '2975e7e1',
  oval: '1e47d0c9',
  pilar: '619b28f5',
  pilar2: '4ece61ef',
  pilar_big: '364c7e01',
  s: 'bf4656e5',
  side_passages_2: '0039d549',
  side_passages_4: '57834195',
  sideways_s: '45a48d81',
  small_cross: 'e2581a01',
  small_inner_cross: 'ab66c818',
  small_x: '05e0e176',
  spiral_cell: '23706222',
  split1: 'bfdfe53a',
  split2: '978b4f91',
  thick_n: 'd1d558cd',
  thick_wall: 'e45589a1',
  tiny_pillars: 'b62b59ac',
  two_domes: 'd6291a61',
  two_passages: 'fdc71d5c',
  weird1: 'c3b7468a',
  weird2: 'cc6f1fb5',
  womb: 'de23418d',
  xroads: 'bc7f2855',
  y: '20ed902b',
  zigzag: '3d3afd81',
};

/** FNV-1a, 32-bit, over UTF-16 code units — every row here is ASCII. */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * The upstream room files, when this clone has them. `reference/` is gitignored
 * third-party source, so a fresh clone does not, and the tests that read it say
 * so by skipping rather than passing.
 */
const REFERENCE_ROOMS = new URL(
  '../../../reference/t-engine4/game/modules/tome/data/rooms/',
  import.meta.url,
);
const HAVE_REFERENCE = existsSync(new URL('random_room.lua', REFERENCE_ROOMS));

/** `random_room.lua:21-24`, name for name. */
// prettier-ignore
const UPSTREAM_RANDOM_ROOM_LIST: readonly string[] = [
  'simple', 'simple', 'simple', 'simple', 'simple', 'simple', 'simple', 'simple', 'simple',
  'simple', 'simple', 'simple', 'simple', 'simple', 'simple', 'simple',
  'pilar', 'oval', 's', 'cells', 'inner_checkerboard', 'y', 'inner', 'small_inner_cross',
  'small_cross', 'big_cells', 'cells2', 'inner_cross', 'cells3', 'cells4', 'cells5', 'cells6',
  'cross', 'equal2', 'pilar2', 'cells7', 'cells8', 'double_y', 'equal', 'center_arrows', 'h',
  'pilar_big',
  'big_cross', 'broken_room', 'cells9', 'double_helix', 'inner_fort', 'multi_pillar', 'split2',
  'womb', 'big_inner_circle', 'broken_x', 'circle_cross', 'inner_circle2', 'inner_pillar',
  'small_x', 'weird1', 'xroads', 'broken_infinity', 'cells10', 'cross_circled', 'inner_circle',
  'micro_pillar', 'split1', 'weird2',
  'basic_cell', 'circular', 'cross_quartet', 'double_t', 'five_blocks', 'five_pillars',
  'five_walls', 'four_blocks', 'four_chambers', 'hollow_cross', 'interstice', 'long_hall',
  'long_hall2', 'narrow_spiral', 'nine_chambers', 'sideways_s', 'side_passages_2',
  'side_passages_4', 'spiral_cell', 'thick_n', 'thick_wall', 'tiny_pillars', 'two_domes',
  'two_passages', 'zigzag',
];

const ROOMS = [...ASCII_ROOMS.values()];

describe('the ASCII room library', () => {
  it('holds all 74 of upstream ASCII rooms, each under its own file name', () => {
    expect(ASCII_ROOMS.size).toBe(74);
    expect([...ASCII_ROOMS.keys()].sort()).toEqual(Object.keys(SIZES).sort());
    for (const [key, room] of ASCII_ROOMS) expect(room.name).toBe(key);
  });

  it('keeps every room rectangular, because loadRoom sizes it by its first row', () => {
    // `w = ret[1]:len()`: a shorter later row would leave `t[i][j]` nil on the
    // right, a longer one would be cut off. Upstream has no ragged room.
    for (const room of ROOMS) {
      const w = room.rows[0]?.length;
      expect(
        room.rows.map((row) => row.length),
        room.name,
      ).toEqual(room.rows.map(() => w));
    }
  });

  it('uses only wall, floor and the tunnel-openable wall', () => {
    for (const room of ROOMS) {
      for (const row of room.rows) expect(row, room.name).toMatch(/^[#.!]+$/);
    }
  });

  it('matches upstream w x h for every room', () => {
    for (const room of ROOMS) {
      const [w, h] = SIZES[room.name] ?? [0, 0];
      expect(room.rows.length, `${room.name} h`).toBe(h);
      expect(
        room.rows.map((row) => row.length),
        `${room.name} w`,
      ).toEqual(Array.from({ length: h }, () => w));
    }
  });

  it('closes every ring: # corners, ! only on the edge, no floor on it', () => {
    // `engine/generator/map/RoomsLoader.lua:636-651`: a ring `!` opens to a
    // tunnel and a ring `#` refuses one. A `.` on the ring or a `!` inside would
    // each change where corridors can enter, so both are pinned as upstream has
    // them.
    for (const room of ROOMS) {
      const h = room.rows.length;
      room.rows.forEach((row, y) => {
        const w = row.length;
        [...row].forEach((c, x) => {
          const edge = x === 0 || y === 0 || x === w - 1 || y === h - 1;
          const corner = (x === 0 || x === w - 1) && (y === 0 || y === h - 1);
          const at = `${room.name} (${String(x)},${String(y)})`;
          if (corner) expect(c, at).toBe('#');
          if (edge) expect(c, at).not.toBe('.');
          else expect(c, at).not.toBe('!');
        });
      });
    }
  });

  it('keeps oval byte-identical to cross, as upstream ships it', () => {
    expect(ASCII_ROOMS.get('oval')?.rows).toEqual(ASCII_ROOMS.get('cross')?.rows);
  });

  it('keeps every row upstream`s, cell for cell', () => {
    // One changed cell anywhere changes the fingerprint; the tests above only
    // see a cell that leaves the alphabet or moves a ring.
    expect(Object.keys(ROWS_FNV1A).sort()).toEqual([...ASCII_ROOMS.keys()].sort());
    for (const room of ROOMS) {
      expect(fnv1a(room.rows.join('\n')), room.name).toBe(ROWS_FNV1A[room.name]);
    }
  });

  it.skipIf(!HAVE_REFERENCE)(
    'matches the room files in reference/, where the clone has them',
    () => {
      for (const room of ROOMS) {
        const lua = readFileSync(new URL(`${room.name}.lua`, REFERENCE_ROOMS), 'utf8');
        const rows = [...lua.slice(lua.indexOf('return {')).matchAll(/\[\[([^\]]*)\]\]/g)].map(
          (m) => m[1],
        );
        expect(room.rows, room.name).toEqual(rows);
      }
    },
  );
});

describe('RANDOM_ROOM_LIST', () => {
  it('is simple sixteen times, then each ASCII room once (random_room.lua:20-25)', () => {
    expect(RANDOM_ROOM_LIST).toHaveLength(90);
    expect(RANDOM_ROOM_LIST.slice(0, 16)).toEqual(Array.from({ length: 16 }, () => 'simple'));
    const rest = RANDOM_ROOM_LIST.slice(16);
    for (const name of rest) expect(ASCII_ROOMS.has(name), name).toBe(true);
    expect([...rest].sort()).toEqual([...ASCII_ROOMS.keys()].sort());
  });

  it('keeps upstream order, name for name', () => {
    // `rng.table` picks by index, so the order is which room a draw lays: two
    // names swapped is a different distribution of rooms per seed.
    expect(RANDOM_ROOM_LIST).toEqual(UPSTREAM_RANDOM_ROOM_LIST);
  });

  it.skipIf(!HAVE_REFERENCE)('matches `local list` in reference/, where the clone has it', () => {
    const lua = readFileSync(new URL('random_room.lua', REFERENCE_ROOMS), 'utf8');
    const start = lua.indexOf('local list = {');
    const names = [...lua.slice(start, lua.indexOf('}', start)).matchAll(/"([^"]+)"/g)].map(
      (m) => m[1],
    );
    expect(RANDOM_ROOM_LIST).toEqual(names);
  });
});
