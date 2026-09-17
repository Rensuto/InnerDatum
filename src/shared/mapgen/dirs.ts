// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/engines/default/engine/utils.lua:1592-1644 (the square-grid tables)
//   and game/engines/default/engine/utils.lua:1869-1944 (their accessors)
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * UPSTREAM'S DIRECTIONS: THE NUMERIC KEYPAD
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * T-Engine4 names a direction by the keypad digit that points that way: 8 is
 * up, 2 is down, 5 is "here". The level generators index tables by those digits
 * (`dirSides(dir).left`, `opposedDir(dir)`), so the port keeps the digits rather
 * than translating them to `shared/coords.ts`'s compass strings — a translation
 * layer between two tables is exactly where a left becomes a right.
 *
 * SQUARE GRID ONLY. Upstream carries hex variants behind `util.isHex()`, which
 * no ToME zone turns on.
 *
 * +y is SOUTH, as in `shared/coords.ts` and upstream alike, so 2 is `(0, 1)`.
 */

/** A keypad direction. 5 is the centre, which upstream keeps "to avoid problems". */
export type KeypadDir = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

/** `dir_to_coord` (`engine/utils.lua:1592-1602`). */
const DIR_TO_COORD: Readonly<Record<KeypadDir, readonly [number, number]>> = {
  1: [-1, 1],
  2: [0, 1],
  3: [1, 1],
  4: [-1, 0],
  5: [0, 0],
  6: [1, 0],
  7: [-1, -1],
  8: [0, -1],
  9: [1, -1],
};

/** The four quarters of a heading, as upstream names them. */
export type DirSides = {
  readonly hardLeft: KeypadDir;
  readonly left: KeypadDir;
  readonly right: KeypadDir;
  readonly hardRight: KeypadDir;
};

/**
 * `dir_sides` (`engine/utils.lua:1622-1632`), verbatim. `left`/`right` are the
 * two diagonals either side of the heading and `hard_left`/`hard_right` the two
 * perpendiculars. Facing 2 (south, screen down) the left hand points east.
 */
const DIR_SIDES: Readonly<Record<KeypadDir, DirSides>> = {
  1: { hardLeft: 3, left: 2, right: 4, hardRight: 7 },
  2: { hardLeft: 6, left: 3, right: 1, hardRight: 4 },
  3: { hardLeft: 9, left: 6, right: 2, hardRight: 1 },
  4: { hardLeft: 2, left: 1, right: 7, hardRight: 8 },
  5: { hardLeft: 4, left: 7, right: 9, hardRight: 6 },
  6: { hardLeft: 8, left: 9, right: 3, hardRight: 2 },
  7: { hardLeft: 1, left: 4, right: 8, hardRight: 9 },
  8: { hardLeft: 4, left: 7, right: 9, hardRight: 6 },
  9: { hardLeft: 7, left: 8, right: 6, hardRight: 3 },
};

/** `opposed_dir` (`engine/utils.lua:1634-1644`). */
const OPPOSED_DIR: Readonly<Record<KeypadDir, KeypadDir>> = {
  1: 9,
  2: 8,
  3: 7,
  4: 6,
  5: 5,
  6: 4,
  7: 3,
  8: 2,
  9: 1,
};

/** `util.primaryDirs()` (`engine/utils.lua:1908-1910`), in its order. */
export const PRIMARY_DIRS: readonly KeypadDir[] = [2, 4, 6, 8];

/** `util.dirToCoord(dir)` (`engine/utils.lua:1869-1871`). */
export function dirToCoord(dir: KeypadDir): readonly [number, number] {
  return DIR_TO_COORD[dir];
}

/**
 * `util.coordToDir(dx, dy)` (`engine/utils.lua:1873-1875`) over `coord_to_dir`
 * (`engine/utils.lua:1604-1620`). Upstream indexes a table and a unit step
 * outside -1..1 is nil there; here it throws, because every caller passes a
 * step `tunnelDir` or `randDir` built.
 */
export function coordToDir(dx: number, dy: number): KeypadDir {
  if (dx < -1 || dx > 1 || dy < -1 || dy > 1 || !Number.isInteger(dx) || !Number.isInteger(dy)) {
    throw new RangeError(`coordToDir: (${String(dx)}, ${String(dy)}) is not a unit step`);
  }
  // Row by dy, column by dx: 7 8 9 / 4 5 6 / 1 2 3.
  return (5 + dx - 3 * dy) as KeypadDir;
}

/** `util.dirSides(dir)` (`engine/utils.lua:1877-1879`). */
export function dirSides(dir: KeypadDir): DirSides {
  return DIR_SIDES[dir];
}

/** `util.opposedDir(dir)` (`engine/utils.lua:1897-1899`). */
export function opposedDir(dir: KeypadDir): KeypadDir {
  return OPPOSED_DIR[dir];
}

/**
 * `util.adjacentCoords(x, y)` (`engine/utils.lua:1922-1944`): all eight
 * neighbours, keyed by direction, with NO bounds check and no centre.
 *
 * Returned in upstream's assignment order (6, 4, 2, 8, then 3, 9, 1, 7).
 * Upstream walks the table with `pairs`, whose order LuaJIT does not promise,
 * and no caller here depends on it: `canDoor` only fills a lookup and `tunnel`
 * only clears a flag on each.
 */
export function adjacentCoords(
  x: number,
  y: number,
): readonly { readonly dir: KeypadDir; readonly x: number; readonly y: number }[] {
  return [
    { dir: 6, x: x + 1, y },
    { dir: 4, x: x - 1, y },
    { dir: 2, x, y: y + 1 },
    { dir: 8, x, y: y - 1 },
    { dir: 3, x: x + 1, y: y + 1 },
    { dir: 9, x: x + 1, y: y - 1 },
    { dir: 1, x: x - 1, y: y + 1 },
    { dir: 7, x: x - 1, y: y - 1 },
  ];
}
