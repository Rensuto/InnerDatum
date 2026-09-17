// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/modules/tome/data/rooms/ (the 74 ASCII room files, each cited below)
//             t-engine4 game/modules/tome/data/rooms/random_room.lua:20-25 (the random room list)
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" — https://te4.org/license

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *          THE ROOM LIBRARY — every ASCII room ToME's Roomer can draw.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A room file under `data/rooms/` either returns a generator function or a
 * table of row strings. This is every one of the second kind: the data
 * `engine/generator/map/RoomsLoader.lua:377-424` (`loadRoom`) reads, sizes as
 * `w = ret[1]:len()`, `h = #ret` and caches, so one table serves every
 * placement. The function rooms (`simple`, `pit`, `money_vault`, the vaults and
 * the rest) are code and live with the loader, not here.
 *
 * ═══ THREE CHARACTERS, AND THE WALLS ARE NOT ALL THE SAME WALL ═══
 * `roomPlace` (`engine/generator/map/RoomsLoader.lua:636-651`) reads each cell:
 *
 *   `!`  a wall a tunnel MAY open: `room = nil`, `can_open = true`. Only ever on
 *        the ring, and the only place a corridor can cross it.
 *   `#`  on the room's edge, a wall a tunnel may NOT open: `room = nil`,
 *        `can_open = false` — "forces tunnelling around edge walls". All 74
 *        rooms put one on each corner, so no corridor enters diagonally; 36
 *        also run it along the edge where an inner wall meets the ring.
 *   `#`  inside, a wall that keeps `room = id`. A tunnel that reaches one walks
 *        through it without carving (`engine/generator/map/RoomsLoader.lua:860-866`).
 *   `.`  floor, `room = id`. Never on the ring.
 *
 * So the character is only half the meaning; where it sits is the other half,
 * which is why the rows must not be tidied.
 *
 * ═══ ROWS ARE COPIED BYTE FOR BYTE ═══
 * Nothing here is redrawn, trimmed, mirrored or de-duplicated. `rows[j]` is
 * upstream's `ret[j + 1]` and character `i` of it is `t[i + 1][j + 1]`: the
 * 1-based column-major table becomes 0-based row strings and nothing else
 * changes. `oval` is byte-identical to `cross` upstream and stays so here, which
 * gives that shape twice the weight of any other ASCII room in `random_room`.
 *
 * None of the 74 files sets a top-level `unique`, `border`, `no_tunnels`,
 * `roomcheck`, `prefer_location`, `onplace` or `map_data` — between the licence
 * header and `return {` there is only a blank line — so a room here is a name
 * and its rows, and `loadRoom`'s optional fields are all nil for these.
 *
 * Listed in the directory's alphabetical order; `RANDOM_ROOM_LIST` below keeps
 * upstream's own order, which is the one a draw depends on.
 */

export type AsciiRoomDef = { readonly name: string; readonly rows: readonly string[] };

// prettier-ignore
const ROOMS: readonly AsciiRoomDef[] = [
  // Ported from modules/tome/data/rooms/basic_cell.lua:20-30
  { name: 'basic_cell', rows: [
    '#!!!!!!!#',
    '!.......!',
    '!.##.##.!',
    '!.#...#.!',
    '!.#...#.!',
    '!.#...#.!',
    '!.#####.!',
    '!.......!',
    '#!!!!!!!#',
  ] },
  // Ported from modules/tome/data/rooms/big_cells.lua:20-30
  { name: 'big_cells', rows: [
    '#!!!!!!#',
    '!......!',
    '###..###',
    '!.#..#.!',
    '!......!',
    '!.#..#.!',
    '###..###',
    '!......!',
    '#!!!!!!#',
  ] },
  // Ported from modules/tome/data/rooms/big_cross.lua:20-32
  { name: 'big_cross', rows: [
    '#!!!!!#!!!!!#',
    '!.....#.....!',
    '!.....#.....!',
    '!.....#.....!',
    '!.....#.....!',
    '######.######',
    '!.....#.....!',
    '!.....#.....!',
    '!.....#.....!',
    '!.....#.....!',
    '#!!!!!#!!!!!#',
  ] },
  // Ported from modules/tome/data/rooms/big_inner_circle.lua:20-32
  { name: 'big_inner_circle', rows: [
    '#!!!!!!!!!#',
    '!.........!',
    '!..##.##..!',
    '!.#.#.#.#.!',
    '!.##...##.!',
    '!.........!',
    '!.##...##.!',
    '!.#.#.#.#.!',
    '!..##.##..!',
    '!.........!',
    '#!!!!!!!!!#',
  ] },
  // Ported from modules/tome/data/rooms/broken_infinity.lua:20-30
  { name: 'broken_infinity', rows: [
    '#!#!!!#!#',
    '!.#...#.!',
    '!..#.#..!',
    '!.#...#.!',
    '!..#.#..!',
    '!.#...#.!',
    '!..#.#..!',
    '!.#...#.!',
    '#!#!!!#!#',
  ] },
  // Ported from modules/tome/data/rooms/broken_room.lua:20-30
  { name: 'broken_room', rows: [
    '#!!#!!#!!#',
    '!..#..#..!',
    '!..#..#..!',
    '!..###...!',
    '!........!',
    '!...###..!',
    '!..#..#..!',
    '!..#..#..!',
    '#!!#!!#!!#',
  ] },
  // Ported from modules/tome/data/rooms/broken_x.lua:20-30
  { name: 'broken_x', rows: [
    '#!!!!!!!#',
    '!.......!',
    '!.#...#.!',
    '!.##.##.!',
    '!.......!',
    '!.##.##.!',
    '!.#...#.!',
    '!.......!',
    '#!!!!!!!#',
  ] },
  // Ported from modules/tome/data/rooms/cells.lua:20-34
  { name: 'cells', rows: [
    '#!!!!!!!!!!!#',
    '!...........!',
    '!...........!',
    '!.#########.!',
    '!.#...#...#.!',
    '!.##.###.##.!',
    '!...........!',
    '!.##.###.##.!',
    '!.#...#...#.!',
    '!.#########.!',
    '!...........!',
    '!...........!',
    '#!!!!!!!!!!!#',
  ] },
  // Ported from modules/tome/data/rooms/cells10.lua:20-28
  { name: 'cells10', rows: [
    '#!#!!#!!#!#',
    '!.#..#..#.!',
    '!.........!',
    '!.#..#..#.!',
    '!.........!',
    '!.#..#..#.!',
    '#!#!!#!!#!#',
  ] },
  // Ported from modules/tome/data/rooms/cells2.lua:20-32
  { name: 'cells2', rows: [
    '#!!!!!!!!!!#',
    '!..........!',
    '!.#.#..#.#.!',
    '!.#.#..#.#.!',
    '!.###..###.!',
    '!..........!',
    '!.###..###.!',
    '!.#.#..#.#.!',
    '!.#.#..#.#.!',
    '!..........!',
    '#!!!!!!!!!!#',
  ] },
  // Ported from modules/tome/data/rooms/cells3.lua:20-29
  { name: 'cells3', rows: [
    '#!#!!!!#!#',
    '!.#....#.!',
    '!........!',
    '####..####',
    '####..####',
    '!........!',
    '!.#....#.!',
    '#!#!!!!#!#',
  ] },
  // Ported from modules/tome/data/rooms/cells4.lua:20-31
  { name: 'cells4', rows: [
    '#!#!#!#!#',
    '!.#.#.#.!',
    '!.#.#.#.!',
    '!.......!',
    '###...###',
    '###...###',
    '!.......!',
    '!.#.#.#.!',
    '!.#.#.#.!',
    '#!#!#!#!#',
  ] },
  // Ported from modules/tome/data/rooms/cells5.lua:20-34
  { name: 'cells5', rows: [
    '#!!!!#',
    '##..##',
    '!....!',
    '##..##',
    '!....!',
    '##..##',
    '!....!',
    '##..##',
    '!....!',
    '##..##',
    '!....!',
    '##..##',
    '#!!!!#',
  ] },
  // Ported from modules/tome/data/rooms/cells6.lua:20-31
  { name: 'cells6', rows: [
    '#!!!!!#',
    '!.....!',
    '##.#.##',
    '!.#.#.!',
    '!.....!',
    '!.....!',
    '!.#.#.!',
    '##.#.##',
    '!.....!',
    '#!!!!!#',
  ] },
  // Ported from modules/tome/data/rooms/cells7.lua:20-30
  { name: 'cells7', rows: [
    '#!!!!!#',
    '!.....!',
    '!.###.!',
    '!.#.#.!',
    '!.....!',
    '!.#.#.!',
    '!.###.!',
    '!.....!',
    '#!!!!!#',
  ] },
  // Ported from modules/tome/data/rooms/cells8.lua:20-28
  { name: 'cells8', rows: [
    '#!!#!!#',
    '!..#..!',
    '##...##',
    '!.....!',
    '##...##',
    '!..#..!',
    '#!!#!!#',
  ] },
  // Ported from modules/tome/data/rooms/cells9.lua:20-26
  { name: 'cells9', rows: [
    '#!!#!!!!##!!!!#!!#',
    '!..#....##....#..!',
    '!.#.#..#..#..#.#.!',
    '!..#....##....#..!',
    '#!!#!!!!##!!!!#!!#',
  ] },
  // Ported from modules/tome/data/rooms/center_arrows.lua:20-36
  { name: 'center_arrows', rows: [
    '#!!!!!!!!!#',
    '!.........!',
    '!.........!',
    '!..##.##..!',
    '!...###...!',
    '!.#.....#.!',
    '!.##...##.!',
    '!..#...#..!',
    '!.##...##.!',
    '!.#.....#.!',
    '!...###...!',
    '!..##.##..!',
    '!.........!',
    '!.........!',
    '#!!!!!!!!!#',
  ] },
  // Ported from modules/tome/data/rooms/circle_cross.lua:20-30
  { name: 'circle_cross', rows: [
    '#!!!!!!!!!!!#',
    '!.#.......#.!',
    '!..#.###.#..!',
    '!...#...#...!',
    '!..#.###.#..!',
    '!...#...#...!',
    '!..#.###.#..!',
    '!.#.......#.!',
    '#!!!!!!!!!!!#',
  ] },
  // Ported from modules/tome/data/rooms/circular.lua:20-32
  { name: 'circular', rows: [
    '#####!!!!!#####',
    '#####.....#####',
    '###.........###',
    '##...........##',
    '!.............!',
    '!.............!',
    '!.............!',
    '##...........##',
    '###.........###',
    '#####.....#####',
    '#####!!!!!#####',
  ] },
  // Ported from modules/tome/data/rooms/cross.lua:20-35
  { name: 'cross', rows: [
    '###!!!!###',
    '###....###',
    '###....###',
    '###....###',
    '###....###',
    '!........!',
    '!........!',
    '!........!',
    '!........!',
    '###....###',
    '###....###',
    '###....###',
    '###....###',
    '###!!!!###',
  ] },
  // Ported from modules/tome/data/rooms/cross_circled.lua:20-30
  { name: 'cross_circled', rows: [
    '##!!!!!##',
    '##.....##',
    '!..###..!',
    '!.#.#.#.!',
    '!.##.##.!',
    '!.#.#.#.!',
    '!..###..!',
    '##.....##',
    '##!!!!!##',
  ] },
  // Ported from modules/tome/data/rooms/cross_quartet.lua:20-32
  { name: 'cross_quartet', rows: [
    '#!!!!!!!!!!!#',
    '!...........!',
    '!...#...#...!',
    '!..###.###..!',
    '!...#...#...!',
    '!...........!',
    '!...#...#...!',
    '!..###.###..!',
    '!...#...#...!',
    '!...........!',
    '#!!!!!!!!!!!#',
  ] },
  // Ported from modules/tome/data/rooms/double_helix.lua:20-27
  { name: 'double_helix', rows: [
    '#!!#!!!!#!!#',
    '!..#....#..!',
    '!.#.#..#.#.!',
    '!.#.#..#.#.!',
    '!..#....#..!',
    '#!!#!!!!#!!#',
  ] },
  // Ported from modules/tome/data/rooms/double_t.lua:20-32
  { name: 'double_t', rows: [
    '#!!!!!!!!!#',
    '!.........!',
    '!....#....!',
    '!....#....!',
    '!..#####..!',
    '!.........!',
    '!..#####..!',
    '!....#....!',
    '!....#....!',
    '!.........!',
    '#!!!!!!!!!#',
  ] },
  // Ported from modules/tome/data/rooms/double_y.lua:20-28
  { name: 'double_y', rows: [
    '#!!#####!!#',
    '!..#####..!',
    '!...###...!',
    '!.........!',
    '!...###...!',
    '!..#####..!',
    '#!!#####!!#',
  ] },
  // Ported from modules/tome/data/rooms/equal.lua:20-28
  { name: 'equal', rows: [
    '#!!!!!!!#',
    '!.......!',
    '!.#####.!',
    '!.......!',
    '!.#####.!',
    '!.......!',
    '#!!!!!!!#',
  ] },
  // Ported from modules/tome/data/rooms/equal2.lua:20-31
  { name: 'equal2', rows: [
    '#!!!!!!!#',
    '!.......!',
    '!.......!',
    '###...###',
    '!.......!',
    '!.......!',
    '###...###',
    '!.......!',
    '!.......!',
    '#!!!!!!!#',
  ] },
  // Ported from modules/tome/data/rooms/five_blocks.lua:20-30
  { name: 'five_blocks', rows: [
    '#!!##!!!!!!##!!#',
    '!..##......##..!',
    '!..##......##..!',
    '!......##......!',
    '!......##......!',
    '!......##......!',
    '!..##......##..!',
    '!..##......##..!',
    '#!!##!!!!!!##!!#',
  ] },
  // Ported from modules/tome/data/rooms/five_pillars.lua:20-31
  { name: 'five_pillars', rows: [
    '#!!!!!!!!#',
    '!........!',
    '!.#....#.!',
    '!........!',
    '!...##...!',
    '!...##...!',
    '!........!',
    '!.#....#.!',
    '!........!',
    '#!!!!!!!!#',
  ] },
  // Ported from modules/tome/data/rooms/five_walls.lua:20-28
  { name: 'five_walls', rows: [
    '#!!!!!!!!!!!!!!!!#',
    '!................!',
    '!.#..#..##..#..#.!',
    '!.#..#..##..#..#.!',
    '!.#..#..##..#..#.!',
    '!................!',
    '#!!!!!!!!!!!!!!!!#',
  ] },
  // Ported from modules/tome/data/rooms/four_blocks.lua:20-31
  { name: 'four_blocks', rows: [
    '#!!!##!!!#',
    '!...##...!',
    '!...##...!',
    '!........!',
    '###....###',
    '###....###',
    '!........!',
    '!...##...!',
    '!...##...!',
    '#!!!##!!!#',
  ] },
  // Ported from modules/tome/data/rooms/four_chambers.lua:20-32
  { name: 'four_chambers', rows: [
    '#!!#!!!#!!#',
    '!..#...#..!',
    '!..#...#..!',
    '!.........!',
    '!..#...#..!',
    '#####.#####',
    '!.........!',
    '!.........!',
    '!.........!',
    '!.........!',
    '#!!!!!!!!!#',
  ] },
  // Ported from modules/tome/data/rooms/h.lua:20-28
  { name: 'h', rows: [
    '#!!!!!!!!!#',
    '!.........!',
    '!.#######.!',
    '!....#....!',
    '!.#######.!',
    '!.........!',
    '#!!!!!!!!!#',
  ] },
  // Ported from modules/tome/data/rooms/hollow_cross.lua:20-34
  { name: 'hollow_cross', rows: [
    '#!!!!!!!!!!!#',
    '!...........!',
    '!....###....!',
    '!....#.#....!',
    '!....#.#....!',
    '!..##...##..!',
    '!..#..#..#..!',
    '!..##...##..!',
    '!....#.#....!',
    '!....#.#....!',
    '!....###....!',
    '!...........!',
    '#!!!!!!!!!!!#',
  ] },
  // Ported from modules/tome/data/rooms/inner.lua:20-32
  { name: 'inner', rows: [
    '#!!!!!!!!!#',
    '!.........!',
    '!.........!',
    '!..##.##..!',
    '!..#...#..!',
    '!..#...#..!',
    '!..#...#..!',
    '!..##.##..!',
    '!.........!',
    '!.........!',
    '#!!!!!!!!!#',
  ] },
  // Ported from modules/tome/data/rooms/inner_checkerboard.lua:20-30
  { name: 'inner_checkerboard', rows: [
    '#!!!!!!!#',
    '!.......!',
    '!.#####.!',
    '!..#.#..!',
    '!.#.#.#.!',
    '!..#.#..!',
    '!.#####.!',
    '!.......!',
    '#!!!!!!!#',
  ] },
  // Ported from modules/tome/data/rooms/inner_circle.lua:20-29
  { name: 'inner_circle', rows: [
    '#!!!!!!#',
    '!......!',
    '!..##..!',
    '!.#..#.!',
    '!.#..#.!',
    '!..##..!',
    '!......!',
    '#!!!!!!#',
  ] },
  // Ported from modules/tome/data/rooms/inner_circle2.lua:20-29
  { name: 'inner_circle2', rows: [
    '#!!!!!!!#',
    '!.......!',
    '!...###.!',
    '!..#..#.!',
    '!.#..#..!',
    '!.###...!',
    '!.......!',
    '#!!!!!!!#',
  ] },
  // Ported from modules/tome/data/rooms/inner_cross.lua:20-31
  { name: 'inner_cross', rows: [
    '#!!!!!!!!#',
    '!........!',
    '!...##...!',
    '!...##...!',
    '!.######.!',
    '!.######.!',
    '!...##...!',
    '!...##...!',
    '!........!',
    '#!!!!!!!!#',
  ] },
  // Ported from modules/tome/data/rooms/inner_fort.lua:20-30
  { name: 'inner_fort', rows: [
    '#!!!!#!!!!#',
    '!....#....!',
    '!..#####..!',
    '!.###.###.!',
    '!.........!',
    '!.###.###.!',
    '!..#####..!',
    '!....#....!',
    '#!!!!#!!!!#',
  ] },
  // Ported from modules/tome/data/rooms/inner_pillar.lua:20-28
  { name: 'inner_pillar', rows: [
    '#!!!!!!!#',
    '!.......!',
    '!..###..!',
    '!.#####.!',
    '!..###..!',
    '!.......!',
    '#!!!!!!!#',
  ] },
  // Ported from modules/tome/data/rooms/interstice.lua:20-34
  { name: 'interstice', rows: [
    '#!!!!!!!!!!!#',
    '!...........!',
    '!...........!',
    '!.####.####.!',
    '!....#.#..#.!',
    '!.#..###..#.!',
    '###.......###',
    '!.#..###..#.!',
    '!.#..#.#....!',
    '!.####.####.!',
    '!...........!',
    '!...........!',
    '#!!!!!!!!!!!#',
  ] },
  // Ported from modules/tome/data/rooms/long_hall.lua:20-35
  { name: 'long_hall', rows: [
    '#!!!!!!!#',
    '!.......!',
    '!.......!',
    '##.###.##',
    '!.......!',
    '!.......!',
    '###...###',
    '###...###',
    '!.......!',
    '!.......!',
    '##.###.##',
    '!.......!',
    '!.......!',
    '#!!!!!!!#',
  ] },
  // Ported from modules/tome/data/rooms/long_hall2.lua:20-35
  { name: 'long_hall2', rows: [
    '#!!!!!!#',
    '!......!',
    '!......!',
    '###..###',
    '!......!',
    '!......!',
    '!..##..!',
    '!..##..!',
    '!......!',
    '!......!',
    '###..###',
    '!......!',
    '!......!',
    '#!!!!!!#',
  ] },
  // Ported from modules/tome/data/rooms/micro_pillar.lua:20-29
  { name: 'micro_pillar', rows: [
    '#!!!!!!!!!!#',
    '!..........!',
    '!..........!',
    '!.##.##.##.!',
    '!.##.##.##.!',
    '!..........!',
    '!..........!',
    '#!!!!!!!!!!#',
  ] },
  // Ported from modules/tome/data/rooms/multi_pillar.lua:20-30
  { name: 'multi_pillar', rows: [
    '#!!!!!!!!!!#',
    '!..........!',
    '!.##.##.##.!',
    '!..........!',
    '!.##.##.##.!',
    '!..........!',
    '!.##.##.##.!',
    '!..........!',
    '#!!!!!!!!!!#',
  ] },
  // Ported from modules/tome/data/rooms/narrow_spiral.lua:20-29
  { name: 'narrow_spiral', rows: [
    '#!!!!!!!!!!!!!#',
    '!.............!',
    '!.#.#########.!',
    '!.#.........#.!',
    '!.#.........#.!',
    '!.#########.#.!',
    '!.............!',
    '#!!!!!!!!!!!!!#',
  ] },
  // Ported from modules/tome/data/rooms/nine_chambers.lua:20-34
  { name: 'nine_chambers', rows: [
    '#!!!#!!!#!!!#',
    '!...#...#...!',
    '!...........!',
    '!...#...#...!',
    '######.######',
    '!...#...#...!',
    '!...........!',
    '!...#...#...!',
    '######.######',
    '!...#...#...!',
    '!...........!',
    '!...#...#...!',
    '#!!!#!!!#!!!#',
  ] },
  // Ported from modules/tome/data/rooms/oval.lua:20-35
  { name: 'oval', rows: [
    '###!!!!###',
    '###....###',
    '###....###',
    '###....###',
    '###....###',
    '!........!',
    '!........!',
    '!........!',
    '!........!',
    '###....###',
    '###....###',
    '###....###',
    '###....###',
    '###!!!!###',
  ] },
  // Ported from modules/tome/data/rooms/pilar.lua:20-26
  { name: 'pilar', rows: [
    '#!!!!!!!!#',
    '!........!',
    '!...##...!',
    '!........!',
    '#!!!!!!!!#',
  ] },
  // Ported from modules/tome/data/rooms/pilar2.lua:20-28
  { name: 'pilar2', rows: [
    '#!!!!!!!!#',
    '!........!',
    '!.#....#.!',
    '!........!',
    '!.#....#.!',
    '!........!',
    '#!!!!!!!!#',
  ] },
  // Ported from modules/tome/data/rooms/pilar_big.lua:20-31
  { name: 'pilar_big', rows: [
    '#!!!!!!!!#',
    '!........!',
    '!.##..##.!',
    '!.##..##.!',
    '!........!',
    '!........!',
    '!.##..##.!',
    '!.##..##.!',
    '!........!',
    '#!!!!!!!!#',
  ] },
  // Ported from modules/tome/data/rooms/s.lua:20-31
  { name: 's', rows: [
    '#!!!!!!!!#',
    '!........!',
    '!..#####.!',
    '!.##.....!',
    '!.#...##.!',
    '!.##...#.!',
    '!.....##.!',
    '!.#####..!',
    '!........!',
    '#!!!!!!!!#',
  ] },
  // Ported from modules/tome/data/rooms/side_passages_2.lua:20-33
  { name: 'side_passages_2', rows: [
    '#!!!!!!!!!!#',
    '!..........!',
    '###......#.!',
    '!.#......#.!',
    '!.#......#.!',
    '!.#......#.!',
    '!.#......#.!',
    '!.#......#.!',
    '!.#......#.!',
    '!.#......###',
    '!..........!',
    '#!!!!!!!!!!#',
  ] },
  // Ported from modules/tome/data/rooms/side_passages_4.lua:20-30
  { name: 'side_passages_4', rows: [
    '#!!!!!!!!#',
    '!......#.!',
    '!##.####.!',
    '!.#......!',
    '!.#....#.!',
    '!......#.!',
    '!.####.##!',
    '!.#......!',
    '#!!!!!!!!#',
  ] },
  // Ported from modules/tome/data/rooms/sideways_s.lua:20-31
  { name: 'sideways_s', rows: [
    '#!!!!!!!!!#',
    '!.........!',
    '!.#..####.!',
    '!.#..#..#.!',
    '!.#..#..#.!',
    '!.#..#..#.!',
    '!.#..#..#.!',
    '!.####..#.!',
    '!.........!',
    '#!!!!!!!!!#',
  ] },
  // Ported from modules/tome/data/rooms/small_cross.lua:20-30
  { name: 'small_cross', rows: [
    '##!!!!!##',
    '##.....##',
    '##.....##',
    '!.......!',
    '!.......!',
    '!.......!',
    '##.....##',
    '##.....##',
    '##!!!!!##',
  ] },
  // Ported from modules/tome/data/rooms/small_inner_cross.lua:20-28
  { name: 'small_inner_cross', rows: [
    '#!!!!!#',
    '!.....!',
    '!..#..!',
    '!.###.!',
    '!..#..!',
    '!.....!',
    '#!!!!!#',
  ] },
  // Ported from modules/tome/data/rooms/small_x.lua:20-26
  { name: 'small_x', rows: [
    '#!!!#',
    '!#.#!',
    '!.#.!',
    '!#.#!',
    '#!!!#',
  ] },
  // Ported from modules/tome/data/rooms/spiral_cell.lua:20-30
  { name: 'spiral_cell', rows: [
    '#!!!!!!!#',
    '!.......!',
    '!.#.###.!',
    '!.#...#.!',
    '!.#.#.#.!',
    '!.#...#.!',
    '!.###.#.!',
    '!.......!',
    '#!!!!!!!#',
  ] },
  // Ported from modules/tome/data/rooms/split1.lua:20-28
  { name: 'split1', rows: [
    '#!##!!!!!!!!!!!!#',
    '!..##...........!',
    '!...##..........!',
    '!....##.#.##....!',
    '!..........##...!',
    '!...........##..!',
    '#!!!!!!!!!!!!##!#',
  ] },
  // Ported from modules/tome/data/rooms/split2.lua:20-26
  { name: 'split2', rows: [
    '#!!!!!!!!!!!!!#',
    '!.............!',
    '###.#.#.#.#.###',
    '!.............!',
    '#!!!!!!!!!!!!!#',
  ] },
  // Ported from modules/tome/data/rooms/thick_n.lua:20-35
  { name: 'thick_n', rows: [
    '#!!!!!!!!!!!!#',
    '!............!',
    '!............!',
    '!............!',
    '!...######...!',
    '!...######...!',
    '!...##..##...!',
    '!...##..##...!',
    '!...##..##...!',
    '!...##..##...!',
    '!............!',
    '!............!',
    '!............!',
    '#!!!!!!!!!!!!#',
  ] },
  // Ported from modules/tome/data/rooms/thick_wall.lua:20-34
  { name: 'thick_wall', rows: [
    '##!!!!##',
    '##....##',
    '##....##',
    '!..##..!',
    '!..##..!',
    '!..##..!',
    '!..##..!',
    '!..##..!',
    '!..##..!',
    '!..##..!',
    '##....##',
    '##....##',
    '##!!!!##',
  ] },
  // Ported from modules/tome/data/rooms/tiny_pillars.lua:20-32
  { name: 'tiny_pillars', rows: [
    '#!!!!!!!!!#',
    '!.........!',
    '!.#..#..#.!',
    '!.........!',
    '!.........!',
    '!.#..#..#.!',
    '!.........!',
    '!.........!',
    '!.#..#..#.!',
    '!.........!',
    '#!!!!!!!!!#',
  ] },
  // Ported from modules/tome/data/rooms/two_domes.lua:20-32
  { name: 'two_domes', rows: [
    '#!!!!!!!!!!!!!!!#',
    '!...............!',
    '!..####...####..!',
    '!.######.######.!',
    '!.#....#.#....#.!',
    '!...............!',
    '!.#....#.#....#.!',
    '!.######.######.!',
    '!..####...####..!',
    '!...............!',
    '#!!!!!!!!!!!!!!!#',
  ] },
  // Ported from modules/tome/data/rooms/two_passages.lua:20-36
  { name: 'two_passages', rows: [
    '#!!!!#!!!!#',
    '!....#....!',
    '!..#####..!',
    '!.........!',
    '!.........!',
    '!..#####..!',
    '!....#....!',
    '!....#....!',
    '!....#....!',
    '!..#####..!',
    '!.........!',
    '!.........!',
    '!..#####..!',
    '!....#....!',
    '#!!!!#!!!!#',
  ] },
  // Ported from modules/tome/data/rooms/weird1.lua:20-30
  { name: 'weird1', rows: [
    '#!!!!!!!#',
    '!.......!',
    '!.#.#.#.!',
    '!...#...!',
    '!.#####.!',
    '!...#...!',
    '!.#.#.#.!',
    '!.......!',
    '#!!!!!!!#',
  ] },
  // Ported from modules/tome/data/rooms/weird2.lua:20-30
  { name: 'weird2', rows: [
    '#!!!!!!!#',
    '!.......!',
    '!.###.#.!',
    '!.....#.!',
    '!.#...#.!',
    '!.#.....!',
    '!.#.###.!',
    '!.......!',
    '#!!!!!!!#',
  ] },
  // Ported from modules/tome/data/rooms/womb.lua:20-27
  { name: 'womb', rows: [
    '#!#!!!#!#',
    '!.#...#.!',
    '!.#...#.!',
    '!..#.#..!',
    '!..#.#..!',
    '#!!#!#!!#',
  ] },
  // Ported from modules/tome/data/rooms/xroads.lua:20-28
  { name: 'xroads', rows: [
    '#!#!#!#',
    '!.#.#.!',
    '##...##',
    '!.....!',
    '##...##',
    '!.#.#.!',
    '#!#!#!#',
  ] },
  // Ported from modules/tome/data/rooms/y.lua:20-30
  { name: 'y', rows: [
    '#!#########!#',
    '!.#########.!',
    '!...#####...!',
    '!....###....!',
    '!.....#.....!',
    '!.....#.....!',
    '!.....#.....!',
    '!...........!',
    '#!!!!!!!!!!!#',
  ] },
  // Ported from modules/tome/data/rooms/zigzag.lua:20-40
  { name: 'zigzag', rows: [
    '#!!!#',
    '!...!',
    '!.#.!',
    '###.!',
    '!.#.!',
    '!...!',
    '!.#.!',
    '!.###',
    '!.#.!',
    '!...!',
    '!.#.!',
    '###.!',
    '!.#.!',
    '!...!',
    '!.#.!',
    '!.###',
    '!.#.!',
    '!...!',
    '#!!!#',
  ] },
];

/** Every ASCII room, keyed by the file name `loadRoom` is called with. */
export const ASCII_ROOMS: ReadonlyMap<string, AsciiRoomDef> = new Map(
  ROOMS.map((room) => [room.name, room]),
);

/**
 * `random_room`'s pool, in upstream's order: `simple` sixteen times, then the 74
 * ASCII rooms once each. The room function draws one entry with
 * `rng.table(gen.data.random_rooms_list or list)`
 * (`modules/tome/data/rooms/random_room.lua:29`), so the order is what a draw
 * index lands on, and the repeats are the weights: `simple` 16 in 90, every
 * other room 1 in 90 (the cross shape 2 in 90, as `oval` and `cross`).
 */
// prettier-ignore
export const RANDOM_ROOM_LIST: readonly string[] = [
  // modules/tome/data/rooms/random_room.lua:21 (16 names)
  'simple', 'simple', 'simple', 'simple', 'simple', 'simple', 'simple', 'simple', 'simple',
  'simple', 'simple', 'simple', 'simple', 'simple', 'simple', 'simple',
  // modules/tome/data/rooms/random_room.lua:22 (26 names)
  'pilar', 'oval', 's', 'cells', 'inner_checkerboard', 'y', 'inner', 'small_inner_cross',
  'small_cross', 'big_cells', 'cells2', 'inner_cross', 'cells3', 'cells4', 'cells5', 'cells6',
  'cross', 'equal2', 'pilar2', 'cells7', 'cells8', 'double_y', 'equal', 'center_arrows', 'h',
  'pilar_big',
  // modules/tome/data/rooms/random_room.lua:23 (23 names)
  'big_cross', 'broken_room', 'cells9', 'double_helix', 'inner_fort', 'multi_pillar', 'split2',
  'womb', 'big_inner_circle', 'broken_x', 'circle_cross', 'inner_circle2', 'inner_pillar',
  'small_x', 'weird1', 'xroads', 'broken_infinity', 'cells10', 'cross_circled', 'inner_circle',
  'micro_pillar', 'split1', 'weird2',
  // modules/tome/data/rooms/random_room.lua:24 (25 names)
  'basic_cell', 'circular', 'cross_quartet', 'double_t', 'five_blocks', 'five_pillars',
  'five_walls', 'four_blocks', 'four_chambers', 'hollow_cross', 'interstice', 'long_hall',
  'long_hall2', 'narrow_spiral', 'nine_chambers', 'sideways_s', 'side_passages_2',
  'side_passages_4', 'spiral_cell', 'thick_n', 'thick_wall', 'tiny_pillars', 'two_domes',
  'two_passages', 'zigzag',
];
