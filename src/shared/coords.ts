/**
 * Tile geometry: the eight directions, the two distance metrics, bounds checks,
 * flat-array indexing and a Bresenham line walk.
 *
 * PURE (src/shared/). Nothing here reads a clock, an entropy source or a host
 * global — every function is a total function of its arguments, which is what
 * lets the same code run in the browser, in the server's turn loop and in a
 * replay harness and agree to the bit.
 *
 * AXES: +x is east, +y is SOUTH. This is screen order, not maths order, because
 * the canvas, the flat `tiles` array and every sprite sheet in the project are
 * all row-major top-down. Picking maths order here would mean flipping the sign
 * of y at three different boundaries, and one of them would eventually be
 * missed.
 */

/** A tile position. Integral by convention; nothing here rounds for you. */
export type TileXY = { readonly x: number; readonly y: number };

/**
 * A displacement, not a position — hence `dx`/`dy` rather than `x`/`y`. The
 * distinct field names mean a vector cannot be passed where a tile is wanted
 * (and vice versa) without the compiler noticing.
 */
export type Vec2 = { readonly dx: number; readonly dy: number };

/**
 * The eight compass directions.
 *
 * An object + type union rather than an `enum`: `erasableSyntaxOnly` is on
 * because Node type-strips this file directly, and an enum emits runtime code.
 */
export const Dir = {
  N: 'n',
  NE: 'ne',
  E: 'e',
  SE: 'se',
  S: 's',
  SW: 'sw',
  W: 'w',
  NW: 'nw',
} as const;
export type Dir = (typeof Dir)[keyof typeof Dir];

/**
 * THE canonical direction order: n, ne, e, se, s, sw, w, nw — clockwise from
 * north.
 *
 * This is not an arbitrary listing. It is the row order of every directional
 * sprite sheet in client/public/assets/, so `sheetRow = DIR_ORDER.indexOf(dir)`
 * is the whole facing lookup. It is also the source of the wire enum in
 * protocol.ts, so the sheet, the protocol and this module cannot drift apart.
 */
export const DIR_ORDER = [
  'n',
  'ne',
  'e',
  'se',
  's',
  'sw',
  'w',
  'nw',
] as const satisfies readonly Dir[];

/**
 * Compile-time proof that DIR_ORDER lists every direction. If a ninth direction
 * is ever added to `Dir` and not to DIR_ORDER, this alias fails to satisfy
 * `never` and names the missing member in the error. Zero runtime cost.
 */
type _Exhaustive<T extends never> = T;
type _MissingFromDirOrder = _Exhaustive<Exclude<Dir, (typeof DIR_ORDER)[number]>>;

/**
 * Unit displacement per direction.
 *
 * Typed `Record<Dir, Vec2>` on purpose: a Record over a finite literal union is
 * a mapped type, not an index signature, so `noUncheckedIndexedAccess` does NOT
 * add `| undefined` to `DIR_VECTORS[someDir]`. Callers get a definite Vec2 with
 * no guard and no `!`. Adding a direction to `Dir` makes this object fail to
 * compile until the vector is supplied.
 */
export const DIR_VECTORS: Readonly<Record<Dir, Vec2>> = {
  n: { dx: 0, dy: -1 },
  ne: { dx: 1, dy: -1 },
  e: { dx: 1, dy: 0 },
  se: { dx: 1, dy: 1 },
  s: { dx: 0, dy: 1 },
  sw: { dx: -1, dy: 1 },
  w: { dx: -1, dy: 0 },
  nw: { dx: -1, dy: -1 },
};

/** The unit displacement for a direction. Always defined — see DIR_VECTORS. */
export function dirVector(dir: Dir): Vec2 {
  return DIR_VECTORS[dir];
}

/**
 * The direction a unit displacement names, or undefined for (0, 0).
 *
 * THE INVERSE OF `dirVector`, and it exists because one caller needs to turn a
 * pair of random offsets back into a `Dir`: `Actor.lua:1319` scrambles a
 * confused body's step as `self.x + rng.range(-1,1), self.y + rng.range(-1,1)`,
 * which is nine outcomes over two axes rather than a choice among eight names.
 *
 * UNDEFINED FOR (0, 0) RATHER THAN A DEFAULT, because that ninth outcome is a
 * real one — a body that stumbles and goes nowhere — and silently answering
 * north would delete it. The caller decides what standing still means.
 *
 * Offsets outside [-1, 1] are undefined too: this maps a STEP, not a vector.
 */
export function dirFromVector(dx: number, dy: number): Dir | undefined {
  for (const dir of DIR_ORDER) {
    const v = DIR_VECTORS[dir];
    if (v.dx === dx && v.dy === dy) return dir;
  }
  return undefined;
}

/** The tile one step from `from` in `dir`. Does not bounds-check; callers do. */
export function step(from: TileXY, dir: Dir): TileXY {
  const v = DIR_VECTORS[dir];
  return { x: from.x + v.dx, y: from.y + v.dy };
}

export function sameTile(a: TileXY, b: TileXY): boolean {
  return a.x === b.x && a.y === b.y;
}

/** Four-way distance. Used for costs that forbid diagonals, not for range. */
export function manhattan(a: TileXY, b: TileXY): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

/**
 * Eight-way distance — THE roguelike distance metric.
 *
 * A diagonal step costs the same as an orthogonal one here, so this is what
 * talent range, aggro radius and "adjacent" all mean. Reach for this by default;
 * reach for `manhattan` only when something genuinely forbids diagonals.
 */
export function chebyshev(a: TileXY, b: TileXY): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

/**
 * Range check for a w x h grid. Deliberately does not test integrality: FOV,
 * A* and the camera all probe coordinates that are merely off-grid, and that is
 * a normal, non-exceptional answer. Reading a tile is `tileAt`, which fails
 * closed to WALL.
 */
export function inBounds(x: number, y: number, w: number, h: number): boolean {
  return x >= 0 && y >= 0 && x < w && y < h;
}

/**
 * Row-major index into a flat `tiles` array of width `w`.
 *
 * Flat, not nested: `tiles[y * w + x]` is one bounds-unchecked read of a packed
 * array instead of two, it serialises to JSON as a single list, and it dodges
 * the `grid[y]?.[x]` double-undefined dance that `noUncheckedIndexedAccess`
 * forces on an array of arrays.
 *
 * NOT bounds-checked — pair it with `inBounds`, or use `tileAt` from level.ts.
 */
export function tileIndex(x: number, y: number, w: number): number {
  return y * w + x;
}

/**
 * Integer Bresenham line walk, inclusive of BOTH endpoints, ordered from `from`
 * to `to`.
 *
 * Needed for line of sight, bolt paths and targeting previews later; it lives
 * here now because it is pure integer arithmetic and the whole point of this
 * module is that both sides of the wire compute the same tiles.
 *
 * The single-accumulator variant is used because it handles all eight octants
 * plus the pure horizontal, vertical and single-tile cases without
 * special-casing any of them.
 *
 * SYMMETRY IS FORCED, and that is the one non-textbook thing here. Raw
 * Bresenham breaks error ties in favour of whichever end it started from, so
 * (10,10)->(4,5) and (4,5)->(10,10) can pass through different tiles. Left
 * alone that becomes the oldest roguelike bug report there is: the archer can
 * shoot you through a corner you cannot shoot back through. Walking the line
 * from a canonical endpoint and reversing makes `bresenham(a, b)` exactly the
 * reverse of `bresenham(b, a)`, so visibility and bolt paths are mutual by
 * construction rather than by remembering to check both ways.
 *
 * The loop is COUNTED rather than `while (true) { ...break }` on purpose: this
 * runs inside a fully synchronous turn resolution, where one non-terminating
 * loop is not a slow frame but a wedged server process. A NaN endpoint returns
 * an empty path for the same reason.
 */
export function bresenham(from: TileXY, to: TileXY): TileXY[] {
  const fx = Math.trunc(from.x);
  const fy = Math.trunc(from.y);
  const tx = Math.trunc(to.x);
  const ty = Math.trunc(to.y);
  if (
    !Number.isFinite(fx) ||
    !Number.isFinite(fy) ||
    !Number.isFinite(tx) ||
    !Number.isFinite(ty)
  ) {
    return [];
  }

  // Lexicographic (x, then y) canonical order — any total order works, this one
  // is just the cheapest to read.
  const flipped = fx > tx || (fx === tx && fy > ty);
  const x0 = flipped ? tx : fx;
  const y0 = flipped ? ty : fy;
  const x1 = flipped ? fx : tx;
  const y1 = flipped ? fy : ty;

  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  const steps = Math.max(dx, -dy);

  const path: TileXY[] = [];
  let x = x0;
  let y = y0;
  let err = dx + dy;

  for (let i = 0; i <= steps; i += 1) {
    path.push({ x, y });
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y += sy;
    }
  }

  return flipped ? path.reverse() : path;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A COARSE COMPASS BEARING, FOR A SENTENCE SOMEBODY READS ONCE AND WALKS.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Eight points, never degrees. This is used to tell a player which way a town
 * is — "Ashwick Alchemy Row — east, 27 tiles" — and "east-north-east" is a
 * number pretending to be a direction.
 *
 * ═══ A CARDINAL WHEN ONE AXIS DOMINATES, AND THAT IS THE WHOLE SUBTLETY ═══
 * The naive version returns a diagonal whenever both offsets are non-zero, so
 * a place forty tiles east and four north reads as "north-east" — and somebody
 * who walks north-east from there is wrong for almost the entire journey. When
 * one axis is more than twice the other, the smaller one is noise and the
 * honest answer is the cardinal.
 *
 * `dy` IS SCREEN-DOWN, as everywhere else in this file, so north is negative.
 */
export function bearingWord(dx: number, dy: number): string {
  const ns = dy < 0 ? 'north' : dy > 0 ? 'south' : '';
  const ew = dx > 0 ? 'east' : dx < 0 ? 'west' : '';
  if (ns === '' && ew === '') return 'here';
  if (ns !== '' && ew !== '') {
    if (Math.abs(dx) > Math.abs(dy) * 2) return ew;
    if (Math.abs(dy) > Math.abs(dx) * 2) return ns;
    return `${ns}-${ew}`;
  }
  return ns === '' ? ew : ns;
}
