// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// The circle under test ports t-engine4's core.fov.calc_circle with a block function: libfov's
// fov_circle under FOV_ALGO_LARGE_ASS (src/fov/fov.c) and lua_fov_calc_circle (src/fov.c).
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT THESE TESTS WERE CHECKED AGAINST
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * THE COMPILED C. libfov's own src/fov/fov.c (reference HEAD 304327e0) was
 * built with MSVC 19.44 for x64 (`/O2`, SSE2 scalar floats) under a harness
 * that reproduces `lua_fov_calc_circle`, `map_seen` and `map_opaque` without
 * Lua, with ToME's settings set the way `lua_fov_set_permissiveness` and
 * `lua_fov_set_actor_vision_size` set them. Before this file was written the
 * port matched it TRACE FOR TRACE — every call to `block` in order, every
 * `apply` with its `sqdist`, and the ring's final index and length — on 46,000
 * random maps: fresh rings, rings started at 0, 1000, 2040 and at random, one
 * ring carried across 10,000 calls as the C's is, and 3,000 radii up to 60 on
 * maps up to 120 wide. The digests at the bottom of this file are that C's
 * output on this file's own random maps.
 *
 * WHAT THE C DOES NOT SETTLE: an x87 build. fovline.ts records that an x87
 * build of the LOS line disagrees with an SSE one; which the shipped binary is
 * was not determined there and is not here. (A fully double copy of the
 * circle agreed with the float port on all 43,120 random maps it was first run
 * on, but floats DO decide cells: fovcircle-oracle.test.ts pins a map where
 * (12,7) is seen in doubles and hidden in the C's floats. A copy that dropped
 * only fovcircle.ts's own `fround` also changed the wide digests below.)
 *
 * ═══ MUTANTS THAT SURVIVE, AND WHY THAT IS DATA ═══
 * (`:NNN` is a line of src/fov/fov.c.) Each of these was run against the
 * compiled C's traces on 3,120 maps and against the port on 40,000 more
 * (radius up to 20), and changed nothing, block calls included:
 *
 *   - `do_command` always true in the opaque-after-opaque call. EQUIVALENT BY
 *     READING: nothing reads what it skips before the next true call.
 *   - The `:777` skip and the `:802` return as no-ops. This note used to call
 *     them unreachable: neither fired in 70,000 maps. They are reachable, only
 *     past radius ~140 (three corners collinear in exact arithmetic), and
 *     fixtures I and J below kill both. They are listed here because no
 *     RANDOM corpus in this file reaches them.
 *   - The `:796` return as a no-op, or as `continue`. It fires tens of
 *     thousands of times, and every time the `:802` return right after it
 *     would end the column too. Both at once changes 9,362 of the 40,000.
 *   - The `:770` skip as a no-op. It fires over a hundred thousand times, and
 *     no cell it skips was ever applied without it: nothing else in the
 *     column's state changes.
 *   - GET_NEXT's final slope clamp removed, in either variant. The upper
 *     variant's never fired; the lower variant's fired about 627,000 times
 *     and never changed a line that mattered.
 *
 * A fixture cannot kill an equivalent mutant, so none here claims to. The
 * killable ones (the `:750` skip, the recursion below a blocker, the tail
 * recursion, the lower-constraint update, the column extents and clamps, the
 * `_ZERO` probe, the convex-list keep and walk, the `y_min` clamp, the row
 * height, the octant order, the origin, the off-map guard and `sqdist`) each
 * fail at least one test below. Moving `dy0` to the column centre and
 * unclamping `dy1` fail only the random-map tests: 300,000 small maps (radius
 * 2 to 5, up to ten walls) turned up none that tells either from the port.
 */

import { describe, expect, it } from 'vitest';

import type { TileXY } from '../../../src/shared/coords.ts';
import { discTiles } from '../../../src/shared/distance.ts';
import {
  calcCircle,
  circleCells,
  circleHeight,
  freshRing,
  largeAssFovCircle,
} from '../../../src/shared/mapgen/fovcircle.ts';
import type { Ring } from '../../../src/shared/mapgen/fovline.ts';
import { FOV_BUFFER_SIZE, tomeFovSettings } from '../../../src/shared/mapgen/fovline.ts';
import { createRng } from '../../../src/shared/rng.ts';

const open = (): boolean => false;
const key = (x: number, y: number): string => `${String(x)},${String(y)}`;

// ═══════════════════════════════════════════════════════════════════════════
// THE FIXTURES, DRAWN AS THEIR ANSWERS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * A fixture is drawn as its answer, one character per cell:
 *
 *   `@`  the source, always in the set
 *   `.`  floor the circle reaches        `-`  floor it does not
 *   `#`  a wall the circle reaches       `=`  a wall it does not
 *
 * The map is the drawing with the answer taken out (`.`/`-` floor, `#`/`=`
 * wall), the drawing is the whole map, and the test is that `circleCells`,
 * drawn the same way, IS the drawing. "Does not reach" covers both a cell
 * hidden behind a wall and one outside the radius.
 */
function drawCircle(drawing: readonly string[], r: number): string[] {
  const rows = drawing.map((row) => row.split(' '));
  const h = rows.length;
  const w = rows[0]?.length ?? 0;
  const at = (x: number, y: number): string => rows[y]?.[x] ?? '?';
  let sx = -1;
  let sy = -1;
  rows.forEach((row, y) => {
    row.forEach((ch, x) => {
      if (ch === '@') {
        sx = x;
        sy = y;
      }
    });
  });
  const wall = (x: number, y: number): boolean => at(x, y) === '#' || at(x, y) === '=';
  const reached = new Set(circleCells({ w, h }, sx, sy, r, wall).map((c) => key(c.x, c.y)));
  return rows.map((row, y) =>
    row
      .map((_, x) => {
        if (x === sx && y === sy) return '@';
        const hit = reached.has(key(x, y));
        return wall(x, y) ? (hit ? '#' : '=') : hit ? '.' : '-';
      })
      .join(' '),
  );
}

/** How many cells a drawing says the circle reaches. */
const reachedIn = (drawing: readonly string[]): number =>
  drawing
    .join(' ')
    .split(' ')
    .filter((ch) => ch === '@' || ch === '.' || ch === '#').length;

describe('calc_circle — the fixtures, hand-derived and drawn', () => {
  it('A: an open map reaches the whole disc, 9 / 21 / 37 tiles at radius 1 / 2 / 3', () => {
    const a1 = [
      '- - - - -', //
      '- . . . -',
      '- . @ . -',
      '- . . . -',
      '- - - - -',
    ];
    const a2 = [
      '- - - - - - -',
      '- - . . . - -',
      '- . . . . . -',
      '- . . @ . . -',
      '- . . . . . -',
      '- - . . . - -',
      '- - - - - - -',
    ];
    const a3 = [
      '- - - - - - - - -',
      '- - - . . . - - -',
      '- - . . . . . - -',
      '- . . . . . . . -',
      '- . . . @ . . . -',
      '- . . . . . . . -',
      '- - . . . . . - -',
      '- - - . . . - - -',
      '- - - - - - - - -',
    ];
    expect(drawCircle(a1, 1)).toEqual(a1);
    expect(drawCircle(a2, 2)).toEqual(a2);
    expect(drawCircle(a3, 3)).toEqual(a3);
    expect([reachedIn(a1), reachedIn(a2), reachedIn(a3)]).toEqual([9, 21, 37]);
  });

  it('B: at radius 1 every neighbour is reached, walls and all', () => {
    const b = [
      '= = = = =', //
      '= # # # =',
      '= # @ # =',
      '= # # # =',
      '= = = = =',
    ];
    expect(drawCircle(b, 1)).toEqual(b);
    expect(reachedIn(b)).toBe(9);
  });

  it('B2: boxed in by eight walls, radius 2 reaches the box and nothing past it', () => {
    // The `:795` return ends each octant's first column at the open cell past
    // the corner: 2 - 0.01 - 0.505*2 = 0.98 above the upper line.
    const b2 = [
      '- - - - - - -',
      '- - - - - - -',
      '- - # # # - -',
      '- - # @ # - -',
      '- - # # # - -',
      '- - - - - - -',
      '- - - - - - -',
    ];
    expect(drawCircle(b2, 2)).toEqual(b2);
    expect(reachedIn(b2)).toBe(9);
  });

  it('C: one wall at (1,0) hides (2,0) at radius 2 and nothing else', () => {
    // ppn: the wall is applied first in its column; the open (1,1) above it
    // sets the lower line flat at y = 1 (:804-807), so column 2 starts at dy 1.
    const c = [
      '- - - - - - -',
      '- - . . . - -',
      '- . . . . . -',
      '- . . @ # - -',
      '- . . . . . -',
      '- - . . . - -',
      '- - - - - - -',
    ];
    expect(drawCircle(c, 2)).toEqual(c);
    expect(reachedIn(c)).toBe(20);
  });

  it('C3: the same wall at radius 3 hides (2,0) and (3,0); (3,1) is still seen', () => {
    const c3 = [
      '- - - - - - - - -',
      '- - - . . . - - -',
      '- - . . . . . - -',
      '- . . . . . . . -',
      '- . . . @ # - - -',
      '- . . . . . . . -',
      '- - . . . . . - -',
      '- - - . . . - - -',
      '- - - - - - - - -',
    ];
    expect(drawCircle(c3, 3)).toEqual(c3);
    expect(reachedIn(c3)).toBe(35);
  });

  it('C4: a wall two away at (2,0) hides only (3,0) at radius 3', () => {
    const c4 = [
      '- - - - - - - - -',
      '- - - . . . - - -',
      '- - . . . . . - -',
      '- . . . . . . . -',
      '- . . . @ . # - -',
      '- . . . . . . . -',
      '- - . . . . . - -',
      '- - - . . . - - -',
      '- - - - - - - - -',
    ];
    expect(drawCircle(c4, 3)).toEqual(c4);
    expect(reachedIn(c4)).toBe(36);
  });

  it('D: an east-west corridor shows its floor and both side walls; the rock behind is hidden', () => {
    // ppn probes (0,1), a wall: the upper line starts at 1 - 2*pms. The side
    // wall (1,1) met after open floor is applied, and the region below it is
    // recursed into at once (:755) with a tightened upper line.
    const d = [
      '= = = = = = =',
      '= = = = = = =',
      '= # # # # # =',
      '- . . @ . . -',
      '= # # # # # =',
      '= = = = = = =',
      '= = = = = = =',
    ];
    expect(drawCircle(d, 2)).toEqual(d);
    expect(reachedIn(d)).toBe(15);
  });

  it('E: in a room`s corner the two walls are seen and the rock beyond them is not', () => {
    const e = [
      '= = = = = = =',
      '= = = = = = =',
      '= = # # # # =',
      '= = # @ . . -',
      '= = # . . . -',
      '= = # . . - -',
      '= = = - - - -',
    ];
    expect(drawCircle(e, 2)).toEqual(e);
    expect(reachedIn(e)).toBe(15);
  });

  it('F: a diagonal pillar at (1,1) hides nothing at radius 2', () => {
    const f = [
      '- - - - - - -',
      '- - . . . - -',
      '- . . . . . -',
      '- . . @ . . -',
      '- . . . # . -',
      '- - . . . - -',
      '- - - - - - -',
    ];
    expect(drawCircle(f, 2)).toEqual(f);
    expect(reachedIn(f)).toBe(21);
  });

  it('F2: walls at (1,0) and (1,1) hide (2,0) and (2,1); (1,2) is seen', () => {
    // (1,1) is an opaque cell after an opaque one (:762-785). The open (1,2)
    // above it clears the :801 return by 2 - 1.9802 = 0.0198, the tightest
    // margin in these fixtures, and then sets a lower line too steep for
    // column 2 to hold a single row.
    const f2 = [
      '- - - - - - -',
      '- - . . . - -',
      '- . . . . . -',
      '- . . @ # - -',
      '- . . . # - -',
      '- - . . . - -',
      '- - - - - - -',
    ];
    expect(drawCircle(f2, 2)).toEqual(f2);
    expect(reachedIn(f2)).toBe(19);
  });

  it('G: at the map`s corner the circle is clipped, and block is never asked about a cell off it', () => {
    const g = [
      '@ . . -', //
      '. . . -',
      '. . - -',
      '- - - -',
    ];
    expect(drawCircle(g, 2)).toEqual(g);
    expect(reachedIn(g)).toBe(8);

    const asked: string[] = [];
    calcCircle(
      { w: 4, h: 4 },
      0,
      0,
      2,
      (x, y) => {
        asked.push(key(x, y));
        return false;
      },
      () => undefined,
    );
    expect(asked.length).toBeGreaterThan(0);
    expect(
      asked.filter((k) => {
        const [x = 0, y = 0] = k.split(',').map(Number);
        return x < 0 || y < 0 || x >= 4 || y >= 4;
      }),
    ).toEqual([]);
  });

  it('H: a wall already under the lower line opens no region below it (the :749 skip)', () => {
    // pmy (primary +y, secondary -x). Column 2: the wall (-1,2) after open
    // floor shades the region below it, which keeps (-2,4) (straight behind
    // it) hidden and still sees (-2,5); the open (-2,2) above it sets the lower
    // line 1 + 0.6645x. Column 3: the wall (-3,3) is met after open floor, but
    // its corner (3.495, 3) is under that line (3 - 1 - 3.495*0.6645 < 0), so
    // there is nothing below it to shadowcast and no recursion. Without the
    // skip, the recursion's upper line (from the corner of (-1,2) to the corner
    // of (-3,3)) and the old lower line leave row 3 of column 4 open, and
    // (-3,4) is wrongly seen.
    const h = [
      '- - - . . . . . - - -',
      '- - . . . . . . . - -',
      '- . . . . . . . . . -',
      '. . . . . . . . . . .',
      '. . . . . . . . . . .',
      '. . . . . @ . . . . .',
      '. . . . . . . . . . .',
      '. . . . # . . . . . .',
      '- . # . . . . . . . -',
      '- - - - . . . . . - -',
      '- - - . . . . . - - -',
    ];
    expect(drawCircle(h, 5)).toEqual(h);
    expect(reachedIn(h)).toBe(95);
  });

  /**
   * THE `:777` SKIP AND THE `:802` RETURN, which every random corpus called
   * unreachable. They are not: each needs three block corners COLLINEAR in exact
   * arithmetic, and with 2·pms = 0.99 that takes a row span that is a multiple
   * of 100 — a radius of roughly 140 or more, past every corpus here (45). These
   * maps were built for it and checked against the compiled C, which hides both
   * cells below; each mutant applies them.
   */
  it('I: at radius 153 a far wall behind two near ones hides what the :802 return protects', () => {
    const walls = new Set([key(1, 0), key(10, 10), key(112, 100)]);
    const wall = (x: number, y: number): boolean => walls.has(key(x, y));
    const hidden = [
      { x: 112, y: 101 },
      { x: 113, y: 102 },
    ];
    // THE SETUP: both are on the map and inside the disc, so only the walls
    // can be keeping them out.
    const open153 = new Set(
      circleCells({ w: 115, h: 115 }, 0, 0, 153, open).map((c) => key(c.x, c.y)),
    );
    for (const c of hidden) expect(open153.has(key(c.x, c.y)), key(c.x, c.y)).toBe(true);
    const seen = new Set(
      circleCells({ w: 115, h: 115 }, 0, 0, 153, wall).map((c) => key(c.x, c.y)),
    );
    for (const c of hidden) expect(seen.has(key(c.x, c.y)), key(c.x, c.y)).toBe(false);
  });

  it('J: the same map with (112,101) walled keeps that wall hidden — the :777 skip', () => {
    const walls = new Set([key(1, 0), key(10, 10), key(112, 100), key(112, 101)]);
    const wall = (x: number, y: number): boolean => walls.has(key(x, y));
    const seen = new Set(
      circleCells({ w: 115, h: 115 }, 0, 0, 153, wall).map((c) => key(c.x, c.y)),
    );
    expect(seen.has(key(112, 100)), 'the near face is not seen at all').toBe(true);
    expect(seen.has(key(112, 101)), '(112,101) was reached past the wall in front of it').toBe(
      false,
    );
  });

  it('B, exhaustively: radius 1 is the in-bounds 3x3 for all 256 walls-around patterns', () => {
    for (let pattern = 0; pattern < 256; pattern += 1) {
      for (const outer of [false, true]) {
        const ring = [
          [1, 0],
          [1, 1],
          [0, 1],
          [-1, 1],
          [-1, 0],
          [-1, -1],
          [0, -1],
          [1, -1],
        ];
        const walls = new Set(
          ring
            .filter((_, i) => (pattern & (1 << i)) !== 0)
            .map(([x = 0, y = 0]) => key(5 + x, 5 + y)),
        );
        const block = (x: number, y: number): boolean =>
          walls.has(key(x, y)) || (outer && Math.max(Math.abs(x - 5), Math.abs(y - 5)) >= 2);
        expect(circleCells({ w: 11, h: 11 }, 5, 5, 1, block)).toEqual(discTiles({ x: 5, y: 5 }, 1));
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// THE C'S ORDER, AND WHAT IT ASKS
// ═══════════════════════════════════════════════════════════════════════════

/** Every `apply` of `calcCircle`, as `dx,dy:sqdist`. */
function stream(bounds: { w: number; h: number }, x: number, y: number, r: number): string[] {
  const out: string[] = [];
  calcCircle(bounds, x, y, r, open, (_x, _y, dx, dy, sq) => {
    out.push(`${key(dx, dy)}:${String(sq)}`);
  });
  return out;
}

describe('calc_circle — the raw visit stream', () => {
  it('radius 1 on an open map: ppn ppy pmy mpn mmn mmy mpy pmn, then the origin', () => {
    expect(stream({ w: 9, h: 9 }, 4, 4, 1)).toEqual([
      '1,0:1', // ppn: the edge and the diagonal
      '1,1:1',
      '0,1:1', // ppy: the edge; its diagonal is ppn's
      '-1,1:1', // pmy: the diagonal
      '-1,0:1', // mpn: the edge
      '-1,-1:1', // mmn: the diagonal
      '0,-1:1', // mmy: the edge
      '1,-1:1', // mpy: the diagonal
      // pmn owns neither, and has nothing at radius 1
      '0,0:0', // the origin, last, from lua_fov_calc_circle itself
    ]);
  });

  it('radius 2 on an open map: column by column inside each octant', () => {
    // sqdist is core.fov.distance SQUARED: (1,1) rounds to 1, (2,1) to 2.
    expect(stream({ w: 9, h: 9 }, 4, 4, 2)).toEqual([
      ...['1,0:1', '1,1:1', '2,0:4', '2,1:4'], // ppn
      ...['0,1:1', '0,2:4', '1,2:4'], // ppy
      ...['-1,1:1', '-1,2:4'], // pmy
      ...['-1,0:1', '-2,0:4', '-2,1:4'], // mpn
      ...['-1,-1:1', '-2,-1:4'], // mmn
      ...['0,-1:1', '0,-2:4', '-1,-2:4'], // mmy
      ...['1,-1:1', '1,-2:4'], // mpy
      ...['2,-1:4'], // pmn
      '0,0:0',
    ]);
  });

  it('runs the region below a blocker before its column goes on: same set, another order', () => {
    // ppn at radius 3. Open, column 2 is (2,0) (2,1) (2,2), then column 3.
    // With a wall at (2,1), met after the open (2,0), the wall is applied and
    // the region below it recursed into AT ONCE (:755): column 3 under the
    // line from the source's foot to the wall's corner (slope 1/2.495), which
    // holds (3,0) and (3,1). Only then does column 2 go on to (2,2). Past
    // (2,2) the new lower line (slope 1/1.505 from the source's head) starts
    // column 3 at row 2, above the row height of 1: nothing more.
    const ppn = (block: (x: number, y: number) => boolean): string[] => {
      const out: string[] = [];
      calcCircle({ w: 9, h: 9 }, 4, 4, 3, block, (_x, _y, dx, dy) => out.push(key(dx, dy)));
      return out.slice(0, 7);
    };
    expect(ppn(open)).toEqual(['1,0', '1,1', '2,0', '2,1', '2,2', '3,0', '3,1']);
    expect(ppn((x, y) => x === 6 && y === 5)).toEqual([
      '1,0',
      '1,1',
      '2,0',
      '2,1',
      '3,0',
      '3,1',
      '2,2',
    ]);
  });

  it('asks block about the four orthogonal neighbours twice each at radius 0, and applies only the origin', () => {
    const asked: string[] = [];
    const applied: string[] = [];
    calcCircle(
      { w: 9, h: 9 },
      4,
      4,
      0,
      (x, y) => {
        asked.push(key(x - 4, y - 4));
        return false;
      },
      (x, y) => applied.push(key(x, y)),
    );
    // Each octant's _ZERO probes the cell beside the source on its secondary
    // axis before the radius cut: ppn (0,1), ppy (1,0), pmy (-1,0), mpn (0,1),
    // mmn (0,-1), mmy (-1,0), mpy (1,0), pmn (0,-1).
    expect(asked).toEqual(['0,1', '1,0', '-1,0', '0,1', '0,-1', '-1,0', '1,0', '0,-1']);
    expect(applied).toEqual(['4,4']);
  });

  it('truncates every number as the C`s ints do: source, map size and radius', () => {
    const a: string[] = [];
    const b: string[] = [];
    const wall = (x: number, y: number): boolean => (x * 7 + y * 3) % 5 === 0;
    calcCircle({ w: 12.9, h: 11.2 }, 5.8, 6.3, 3.99, wall, (x, y) => a.push(key(x, y)));
    calcCircle({ w: 12, h: 11 }, 5, 6, 3, wall, (x, y) => b.push(key(x, y)));
    expect(a).toEqual(b);
    // -0.5 is 0, not -1.
    expect(stream({ w: 9, h: 9 }, -0.5, -0.5, 1)).toEqual(stream({ w: 9, h: 9 }, 0, 0, 1));
  });

  it('never applies an off-map cell, the origin included; circleCells still adds the origin', () => {
    const applied: string[] = [];
    calcCircle({ w: 5, h: 5 }, -1, 2, 2, open, (x, y) => applied.push(key(x, y)));
    expect(applied.every((k) => !k.startsWith('-'))).toBe(true);
    expect(applied).not.toContain('-1,2');
    expect(applied.sort()).toEqual(['0,1', '0,2', '0,3', '1,1', '1,2', '1,3', '0,0', '0,4'].sort());
    const cells = circleCells({ w: 5, h: 5 }, -1, 2, 2, open);
    expect(cells).toContainEqual({ x: -1, y: 2 });
    expect(cells).toHaveLength(applied.length + 1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PROPERTIES, MEASURED
// ═══════════════════════════════════════════════════════════════════════════

type RandomCase = {
  w: number;
  h: number;
  sx: number;
  sy: number;
  r: number;
  grid: boolean[];
};

/**
 * Random maps: sizes from 1, sources up to four cells off the map, and one
 * map in four at any density, the rest at 30% or less, where the convex
 * boundary lists grow past one point. DO NOT CHANGE THIS FUNCTION: the C's
 * digests below were computed on exactly the maps it makes.
 */
function randomCases(label: string, n: number, maxSide: number, maxR: number): RandomCase[] {
  const rng = createRng(label);
  const out: RandomCase[] = [];
  for (let i = 0; i < n; i += 1) {
    const w = rng.int('w', 1, maxSide);
    const h = rng.int('h', 1, maxSide);
    const density =
      rng.int('density', 0, 3) === 0 ? rng.int('dense', 0, 100) : rng.int('sparse', 0, 30);
    const grid = Array.from({ length: w * h }, () => rng.int('cell', 0, 99) < density);
    const sx = rng.int('sx', -4, w + 3);
    const sy = rng.int('sy', -4, h + 3);
    const r = rng.int('r', 0, maxR);
    out.push({ w, h, sx, sy, r, grid });
  }
  return out;
}

const blockOf =
  (c: RandomCase) =>
  (x: number, y: number): boolean =>
    c.grid[y * c.w + x] === true;

describe('calc_circle — measured properties', () => {
  it('applies no cell twice (raw-stream uniqueness, reported as data)', () => {
    // MEASURED, NOT ASSUMED: the compiled C applied no cell twice on 46,000
    // random maps either. A non-zero count here means the port has left the C,
    // not that the C has duplicates. circleCells deduplicates regardless.
    let applied = 0;
    let duplicates = 0;
    let casesWithDuplicates = 0;
    for (const c of randomCases('fovcircle.against-c', 3000, 40, 10)) {
      const seen = new Set<string>();
      let dup = 0;
      calcCircle({ w: c.w, h: c.h }, c.sx, c.sy, c.r, blockOf(c), (x, y) => {
        applied += 1;
        if (seen.has(key(x, y))) dup += 1;
        seen.add(key(x, y));
      });
      duplicates += dup;
      if (dup > 0) casesWithDuplicates += 1;
    }
    expect({ applied, duplicates, casesWithDuplicates }).toEqual({
      applied: 78_294,
      duplicates: 0,
      casesWithDuplicates: 0,
    });
  });

  it('is symmetric between open cells: b is in a`s circle exactly when a is in b`s', () => {
    // engine/utils.lua:2301 and :2311 claim it for large_ass with an actor
    // vision size of 1. A smoke test, not a proof: 0 asymmetric pairs of
    // 476,722 on 200 maps when this was written; these 60 are its first 60.
    const rng = createRng('fovcircle.symmetry');
    let pairs = 0;
    const asymmetric: string[] = [];
    for (let m = 0; m < 60; m += 1) {
      const w = rng.int('w', 3, 16);
      const h = rng.int('h', 3, 16);
      const density = rng.int('density', 0, 35);
      const grid = Array.from({ length: w * h }, () => rng.int('cell', 0, 99) < density);
      const r = rng.int('r', 1, 8);
      const block = (x: number, y: number): boolean => grid[y * w + x] === true;
      const sets = new Map<number, Set<number>>();
      for (let y = 0; y < h; y += 1) {
        for (let x = 0; x < w; x += 1) {
          if (block(x, y)) continue;
          const cells = circleCells({ w, h }, x, y, r, block);
          sets.set(y * w + x, new Set(cells.map((c) => c.y * w + c.x)));
        }
      }
      for (const [a, reach] of sets) {
        for (const b of reach) {
          const back = sets.get(b);
          if (b === a || back === undefined) continue;
          pairs += 1;
          if (!back.has(a)) asymmetric.push(`map ${String(m)}: ${String(a)} sees ${String(b)}`);
        }
      }
    }
    expect({ pairs, asymmetric }).toEqual({ pairs: 159_396, asymmetric: [] });
  });

  it('gives the same answer whether the ring starts at 0, 1000 or 2040, or is carried across calls', () => {
    const run = (c: RandomCase, ring: Ring): string => {
      const out: string[] = [];
      const block = blockOf(c);
      const settings = tomeFovSettings(
        (x, y) => x < 0 || y < 0 || x >= c.w || y >= c.h || block(x, y),
      );
      largeAssFovCircle(settings, c.sx, c.sy, c.r, (x, y) => out.push(key(x, y)), ring);
      return out.join(' ');
    };
    const carried = freshRing(0);
    let wrapped = 0;
    for (const c of randomCases('fovcircle.against-c', 400, 40, 10)) {
      const at0 = run(c, freshRing(0));
      const late = freshRing(2040);
      expect(run(c, freshRing(1000))).toBe(at0);
      expect(run(c, late)).toBe(at0);
      expect(run(c, carried)).toBe(at0);
      if (late.index < 2040) wrapped += 1;
    }
    // Starting at 2040 really does make GET_BUFFER wrap to 0 mid-circle.
    expect(wrapped).toBeGreaterThan(100);
    expect(FOV_BUFFER_SIZE).toBe(2048);
  });

  it('circleCells on an open map is discTiles, order and all, for every radius to 10', () => {
    for (let r = 0; r <= 10; r += 1) {
      expect(circleCells({ w: 25, h: 25 }, 12, 12, r, open)).toEqual(
        discTiles({ x: 12, y: 12 }, r),
      );
    }
    // Against an edge, or in a corner, it is discTiles clipped to the map: the
    // opaque off-map cells shade nothing inside it.
    for (const [sx, sy] of [
      [2, 23],
      [0, 24],
      [12, 0],
    ] as const) {
      for (let r = 0; r <= 10; r += 1) {
        const clipped = discTiles({ x: sx, y: sy }, r).filter(
          (t: TileXY) => t.x >= 0 && t.y >= 0 && t.x < 25 && t.y < 25,
        );
        expect(circleCells({ w: 25, h: 25 }, sx, sy, r, open)).toEqual(clipped);
      }
    }
  });

  it('circleCells is row-major and has no duplicates on walled maps', () => {
    for (const c of randomCases('fovcircle.against-c', 300, 40, 10)) {
      const cells = circleCells({ w: c.w, h: c.h }, c.sx, c.sy, c.r, blockOf(c));
      const sorted = [...cells].sort((p, q) => p.y - q.y || p.x - q.x);
      expect(cells).toEqual(sorted);
      expect(new Set(cells.map((t) => key(t.x, t.y))).size).toBe(cells.length);
      expect(cells).toContainEqual({ x: c.sx, y: c.sy });
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// THE ROW HEIGHT, AGAINST THE C'S TABLE
// ═══════════════════════════════════════════════════════════════════════════

/**
 * `heights_tables[FOV_SHAPE_CIRCLE_ROUND]` (src/fov/fov.c, lines 93-128), row
 * r, entry dx-1: `fov_circle` points `heights` at `table + r*(r-1)/2 - 1` and
 * GET_HEIGHT reads `heights[dx]`.
 */
const CIRCLE_ROUND_HEIGHTS = [
  '1',
  '2, 1',
  '3, 2, 1',
  '4, 4, 3, 2',
  '5, 5, 4, 3, 2',
  '6, 6, 5, 5, 4, 2',
  '7, 7, 6, 6, 5, 4, 2',
  '8, 8, 7, 7, 6, 6, 4, 2',
  '9, 9, 9, 8, 8, 7, 6, 5, 3',
  '10, 10, 10, 9, 9, 8, 7, 6, 5, 3',
  '11, 11, 11, 10, 10, 9, 9, 8, 7, 5, 3',
  '12, 12, 12, 11, 11, 10, 10, 9, 8, 7, 5, 3',
  '13, 13, 13, 12, 12, 12, 11, 10, 10, 9, 7, 6, 3',
  '14, 14, 14, 13, 13, 13, 12, 12, 11, 10, 9, 8, 6, 3',
  '15, 15, 15, 14, 14, 14, 13, 13, 12, 11, 10, 9, 8, 6, 3',
  '16, 16, 16, 16, 15, 15, 14, 14, 13, 13, 12, 11, 10, 8, 6, 4',
  '17, 17, 17, 17, 16, 16, 16, 15, 15, 14, 13, 12, 11, 10, 9, 7, 4',
  '18, 18, 18, 18, 17, 17, 17, 16, 16, 15, 14, 14, 13, 12, 10, 9, 7, 4',
  '19, 19, 19, 19, 18, 18, 18, 17, 17, 16, 16, 15, 14, 13, 12, 11, 9, 7, 4',
  '20, 20, 20, 20, 19, 19, 19, 18, 18, 17, 17, 16, 15, 14, 13, 12, 11, 9, 7, 4',
  '21, 21, 21, 21, 20, 20, 20, 19, 19, 19, 18, 17, 17, 16, 15, 14, 13, 11, 10, 7, 4',
  '22, 22, 22, 22, 21, 21, 21, 21, 20, 20, 19, 19, 18, 17, 16, 15, 14, 13, 12, 10, 8, 4',
  '23, 23, 23, 23, 22, 22, 22, 22, 21, 21, 20, 20, 19, 18, 18, 17, 16, 15, 13, 12, 10, 8, 4',
  '24, 24, 24, 24, 23, 23, 23, 23, 22, 22, 21, 21, 20, 20, 19, 18, 17, 16, 15, 14, 12, 10, 8, 4',
  '25, 25, 25, 25, 25, 24, 24, 24, 23, 23, 23, 22, 21, 21, 20, 19, 19, 18, 17, 15, 14, 12, 11, 8, 5',
  '26, 26, 26, 26, 26, 25, 25, 25, 24, 24, 24, 23, 23, 22, 21, 21, 20, 19, 18, 17, 16, 14, 13, 11, 8, 5',
  '27, 27, 27, 27, 27, 26, 26, 26, 25, 25, 25, 24, 24, 23, 23, 22, 21, 20, 19, 18, 17, 16, 15, 13, 11, 8, 5',
  '28, 28, 28, 28, 28, 27, 27, 27, 27, 26, 26, 25, 25, 24, 24, 23, 22, 22, 21, 20, 19, 18, 16, 15, 13, 11, 9, 5',
  '29, 29, 29, 29, 29, 28, 28, 28, 28, 27, 27, 26, 26, 25, 25, 24, 24, 23, 22, 21, 20, 19, 18, 17, 15, 13, 11, 9, 5',
  '30, 30, 30, 30, 30, 29, 29, 29, 29, 28, 28, 28, 27, 27, 26, 25, 25, 24, 23, 23, 22, 21, 20, 18, 17, 15, 14, 12, 9, 5',
  '31, 31, 31, 31, 31, 30, 30, 30, 30, 29, 29, 29, 28, 28, 27, 27, 26, 25, 25, 24, 23, 22, 21, 20, 19, 17, 16, 14, 12, 9, 5',
  '32, 32, 32, 32, 32, 31, 31, 31, 31, 30, 30, 30, 29, 29, 28, 28, 27, 27, 26, 25, 24, 23, 22, 21, 20, 19, 18, 16, 14, 12, 9, 5',
];

describe('GET_HEIGHT — the formula is the table', () => {
  it('matches all 528 entries the C reads below radius 33', () => {
    let entries = 0;
    CIRCLE_ROUND_HEIGHTS.forEach((row, i) => {
      const r = i + 1;
      const table = row.split(', ').map(Number);
      expect(table).toHaveLength(r);
      expect(table.map((_, j) => circleHeight(r, j + 1))).toEqual(table);
      entries += table.length;
    });
    expect(entries).toBe(528);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AGAINST THE COMPILED C
// ═══════════════════════════════════════════════════════════════════════════

/** FNV-1a, 32 bits, over UTF-16 code units (every trace here is ASCII). */
function fnv(s: string, from = 0x811c9dc5): number {
  let h = from;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Every `block` call as `?x,y` and every `apply` as `x,y,dx,dy,sqdist`, in order. */
function trace(c: RandomCase): string {
  const t: string[] = [];
  const block = blockOf(c);
  calcCircle(
    { w: c.w, h: c.h },
    c.sx,
    c.sy,
    c.r,
    (x, y) => {
      t.push(`?${key(x, y)}`);
      return block(x, y);
    },
    (x, y, dx, dy, sq) => t.push(`${key(x, y)},${key(dx, dy)},${String(sq)}`),
  );
  return t.join(' ');
}

function digests(cases: readonly RandomCase[], per: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < cases.length; i += per) {
    let h = 0x811c9dc5;
    for (const c of cases.slice(i, i + per)) h = fnv(`${trace(c)}\n`, h);
    out.push(h.toString(16).padStart(8, '0'));
  }
  return out;
}

describe('calc_circle — against the compiled C', () => {
  it('traces 3,000 random maps (radius 0-10) exactly as libfov does', () => {
    // Each digest covers 100 maps: every block call and every apply, sqdist
    // included, in the C's order. Produced by the build described at the top.
    expect(digests(randomCases('fovcircle.against-c', 3000, 40, 10), 100)).toEqual([
      '1b689d5c',
      '274db166',
      'c573637c',
      '1c645a17',
      'c3b814db',
      '4de4a20a',
      '439990a3',
      '87439cb4',
      '7c0fccab',
      'de1ac895',
      'c6d45719',
      'ac47c519',
      'b701b286',
      'beed36d3',
      'a9b05831',
      'b0345ecc',
      'a0e49f54',
      '1c7123c9',
      'df8e418b',
      '4b5c0a91',
      'da5d6472',
      '110f8750',
      '104120e6',
      'e5cce6e7',
      '5f40c8ef',
      'e058be5b',
      'fff38d0b',
      '71ffd7c3',
      '2fbde226',
      'fb452a69',
    ]);
  });

  it('traces 120 wide maps (radius 0-45, past the C`s 32-row table) exactly as libfov does', () => {
    // Each digest covers 20 maps. The convex-list walk (GET_NEXT's lower
    // loop) is only reached often enough to be pinned out here.
    expect(digests(randomCases('fovcircle.against-c.wide', 120, 100, 45), 20)).toEqual([
      'fcaa7c59',
      'c52ef5ff',
      'b4d7adb6',
      '1124f922',
      '9ebbf987',
      '78f1dec3',
    ]);
  });
});
