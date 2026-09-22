// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// The rule under test ports t-engine4 game/engines/default/engine/interface/ActorProject.lua:118-135
// (a projected ball), game/engines/default/engine/Target.lua:518-565 (`block_radius`),
// game/engines/default/engine/utils.lua:2178-2199 (`core.fov.circle_grids`), and
// game/engines/default/engine/interface/ActorProject.lua:66-114 with
// game/engines/default/engine/Target.lua:458-468 (where a ball aimed at a wall goes off).
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

import { describe, expect, it } from 'vitest';

import { ballCentre, ballTiles, blocksMove, blocksProjection } from '../../src/shared/ball.ts';
import { discTiles } from '../../src/shared/distance.ts';
import { hasLineOfSight } from '../../src/shared/sight.ts';
import { TileCode } from '../../src/shared/protocol.ts';
import type { TileXY } from '../../src/shared/coords.ts';
import type { LevelView } from '../../src/shared/protocol.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A BALL IS `discTiles` LESS WHAT THE WALLS HIDE, IN `discTiles`'s ORDER.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Three things are pinned, and the order is the one that is easy to lose:
 *
 *   1. On open ground the ball IS the disc, clipped to the map.
 *   2. A wall hides what libfov's shadowcaster hides (fixture C from
 *      test/shared/mapgen/fovcircle.test.ts, which is checked against the
 *      compiled C), and radius 1 is never cut.
 *   3. The list is `discTiles`'s row-major walk with tiles taken out — never
 *      the C's visit order. Anything applied to the list draws in its order.
 *
 * And the two block functions part exactly at lava: a projected ball crosses
 * it, a ground cloud does not.
 */

const W = 15;
const C = { x: 7, y: 7 } as const;
const key = (t: TileXY): string => `${String(t.x)},${String(t.y)}`;
const off = (t: TileXY): string => `${String(t.x - C.x)},${String(t.y - C.y)}`;

function level(code: number = TileCode.FLOOR): LevelView {
  return { w: W, h: W, tiles: new Array<number>(W * W).fill(code) };
}

/** A floor level with `code` at each offset from `C`. */
function withAt(code: number, offsets: readonly (readonly [number, number])[]): LevelView {
  const lv = level();
  for (const [dx, dy] of offsets) lv.tiles[(C.y + dy) * W + (C.x + dx)] = code;
  return lv;
}

const inside = (lv: LevelView) => (t: TileXY) => t.x >= 0 && t.y >= 0 && t.x < lv.w && t.y < lv.h;

/** A small deterministic stream for the random maps; tests may not use `Math.random`. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

describe('on open ground a ball is the disc, clipped to the map', () => {
  it('equals `discTiles` in the middle of the map, in the same order, r = 0..6', () => {
    const lv = level();
    for (let r = 0; r <= 6; r += 1) {
      expect(ballTiles(lv, C, r, blocksProjection(lv)), `radius ${String(r)}`).toEqual(
        discTiles(C, r),
      );
    }
  });

  it('drops what is off the map and keeps the centre, at a corner', () => {
    const lv = level();
    const corner = { x: 0, y: 0 };
    expect(ballTiles(lv, corner, 2, blocksProjection(lv))).toEqual(
      discTiles(corner, 2).filter(inside(lv)),
    );
    // prettier-ignore
    expect(ballTiles(lv, corner, 1, blocksMove(lv)).map(key)).toEqual([
      '0,0', '1,0',
      '0,1', '1,1',
    ]);
  });
});

describe('a wall hides what libfov hides, and only that', () => {
  it('fixture C: a wall at (1,0) hides (2,0) at radius 2 — listed row-major', () => {
    const lv = withAt(TileCode.WALL, [[1, 0]]);
    // prettier-ignore
    expect(ballTiles(lv, C, 2, blocksProjection(lv)).map(off)).toEqual([
                '-1,-2', '0,-2', '1,-2',
      '-2,-1',  '-1,-1', '0,-1', '1,-1', '2,-1',
      '-2,0',   '-1,0',  '0,0',  '1,0',
      '-2,1',   '-1,1',  '0,1',  '1,1',  '2,1',
                '-1,2',  '0,2',  '1,2',
    ]);
  });

  it('radius 1 is the whole in-bounds 3x3 whatever blocks — all 256 neighbour walls', () => {
    /**
     * libfov's octants scan rows 0 and 1 of their first column before any exit
     * can fire, so a radius-1 ball never loses a tile to a wall. This is why
     * only a ball of radius 2 or more changes when balls learn about walls.
     */
    const ring = [
      [-1, -1],
      [0, -1],
      [1, -1],
      [-1, 0],
      [1, 0],
      [-1, 1],
      [0, 1],
      [1, 1],
    ] as const;
    const whole = discTiles(C, 1);
    for (let mask = 0; mask < 256; mask += 1) {
      const lv = withAt(
        TileCode.WALL,
        ring.filter((_, i) => (mask & (1 << i)) !== 0),
      );
      expect(ballTiles(lv, C, 1, blocksProjection(lv)), `mask ${String(mask)}`).toEqual(whole);
    }
  });

  it('is `discTiles` with tiles removed, never reordered — on random maps, r = 1..6', () => {
    /**
     * THE SEED ARGUMENT, AS A PROPERTY. The list is a subsequence of the open
     * disc; at radius 1 it is all of it (in bounds); and some radius-2 map
     * really does lose a tile, so the subsequence claim is not vacuous.
     */
    const rand = lcg(20260922);
    let cut = 0;
    for (let n = 0; n < 400; n += 1) {
      const lv = level();
      for (let i = 0; i < lv.tiles.length; i += 1) {
        if (rand() < 0.3) lv.tiles[i] = TileCode.WALL;
      }
      const centre = { x: 1 + Math.floor(rand() * (W - 2)), y: 1 + Math.floor(rand() * (W - 2)) };
      lv.tiles[centre.y * W + centre.x] = TileCode.FLOOR;
      for (let r = 1; r <= 6; r += 1) {
        const open = discTiles(centre, r).map(key);
        const got = ballTiles(lv, centre, r, blocksProjection(lv)).map(key);
        // A subsequence of the open disc, in its order.
        let j = 0;
        for (const k of open) if (got[j] === k) j += 1;
        expect(j, `radius ${String(r)} reordered or invented a tile`).toBe(got.length);
        if (r === 1) {
          expect(got, 'radius 1 lost a tile').toEqual(
            discTiles(centre, 1).filter(inside(lv)).map(key),
          );
        }
        if (r === 2 && got.length < open.length) cut += 1;
      }
    }
    expect(cut, 'no radius-2 ball on 400 walled maps lost a tile').toBeGreaterThan(0);
  });
});

describe('the two block functions — a projectile and a cloud', () => {
  it('agree on floor, masonry, a shut door, solid water and off the map', () => {
    const lv = withAt(TileCode.WALL, [[1, 0]]);
    lv.tiles[C.y * W + C.x + 2] = TileCode.DOOR;
    lv.tiles[C.y * W + C.x + 3] = TileCode.WATER;
    const proj = blocksProjection(lv);
    const move = blocksMove(lv);
    const cases: readonly [string, number, number, boolean][] = [
      ['floor', C.x, C.y, false],
      ['wall', C.x + 1, C.y, true],
      ['shut door', C.x + 2, C.y, true],
      ['solid water', C.x + 3, C.y, true],
      ['off the map', -1, 0, true],
      ['off the far edge', W, W, true],
    ];
    for (const [what, x, y, blocked] of cases) {
      expect(proj(x, y), `projection: ${what}`).toBe(blocked);
      expect(move(x, y), `movement: ${what}`).toBe(blocked);
    }
  });

  it('part at lava and the void: a projectile crosses them, a cloud does not', () => {
    const lv = withAt(TileCode.MOLTEN_LAVA, [[1, 0]]);
    lv.tiles[C.y * W + C.x - 1] = TileCode.OUTERSPACE;
    expect(blocksProjection(lv)(C.x + 1, C.y)).toBe(false);
    expect(blocksMove(lv)(C.x + 1, C.y)).toBe(true);
    expect(blocksProjection(lv)(C.x - 1, C.y)).toBe(false);
    expect(blocksMove(lv)(C.x - 1, C.y)).toBe(true);

    // And as balls: fixture C's shadow falls behind lava for a cloud only.
    const thrown = ballTiles(lv, C, 2, blocksProjection(lv)).map(off);
    const cloud = ballTiles(lv, C, 2, blocksMove(lv)).map(off);
    expect(thrown, 'a thrown ball stopped at lava').toContain('2,0');
    expect(thrown, 'a thrown ball stopped at the void').toContain('-2,0');
    expect(cloud, 'a cloud crossed lava').not.toContain('2,0');
    expect(cloud, 'a cloud crossed the void').not.toContain('-2,0');
    expect(cloud, 'the cloud`s shadow was wider than one tile').toContain('2,1');
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A BALL AIMED AT A TILE GOES OFF WHERE IT STOPPED — `stop_radius`.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `engine/interface/ActorProject.lua:66-114`: `block_path` answers `true, true,
 * false` for terrain that stops a projectile (`engine/Target.lua:458-468`), so
 * the walk ends with `stop_radius` on the last tile before the wall, or on the
 * caster when the wall is the first step. The ball is laid from there.
 *
 * HAND-LISTED CENTRES, along row `C.y` unless a case says otherwise. Each wall
 * case would read the aim back if `ballCentre` returned `to` unchanged.
 */
describe('ballCentre: the last open tile before a wall, on our line of sight`s line', () => {
  const east = (dx: number, dy = 0): TileXY => ({ x: C.x + dx, y: C.y + dy });

  it('is the aim when a projectile can enter it — floor, and lava', () => {
    expect(ballCentre(level(), C, east(3))).toEqual(east(3));
    // Lava carries `pass_projectile`: a ball aimed at it goes off on it.
    expect(ballCentre(withAt(TileCode.MOLTEN_LAVA, [[3, 0]]), C, east(3))).toEqual(east(3));
  });

  it('is the tile before a wall that is aimed at, either way along the row', () => {
    const lv = withAt(TileCode.WALL, [
      [3, 0],
      [-3, 0],
    ]);
    // THE AIM IS ONE THE SERVER ACCEPTS: line of sight leaves out the end.
    expect(hasLineOfSight(lv, C, east(3))).toBe(true);
    expect(ballCentre(lv, C, east(3))).toEqual(east(2));
    // `bresenham` walks a canonical way and reverses, so the line still runs
    // from the caster whichever way it points.
    expect(ballCentre(lv, C, east(-3))).toEqual(east(-2));
  });

  it('goes back past every course of a thick wall, and a shut door stops it too', () => {
    const thick = withAt(TileCode.WALL, [
      [3, 0],
      [4, 0],
    ]);
    expect(ballCentre(thick, C, east(4))).toEqual(east(2));
    expect(ballCentre(withAt(TileCode.DOOR, [[3, 0]]), C, east(3))).toEqual(east(2));
  });

  it('is the caster`s own tile when the wall is the first step, straight or diagonal', () => {
    expect(ballCentre(withAt(TileCode.WALL, [[1, 0]]), C, east(1))).toEqual(C);
    expect(ballCentre(withAt(TileCode.WALL, [[1, 1]]), C, east(1, 1))).toEqual(C);
  });

  it('steps back along the Bresenham line, not along the axis', () => {
    // C to (4,2): (0,0) (1,1) (2,1) (3,2) (4,2). The tile before the aim is
    // (3,2); a step back by sign would say (3,1).
    const lv = withAt(TileCode.WALL, [[4, 2]]);
    expect(ballCentre(lv, C, east(4, 2))).toEqual(east(3, 2));
  });

  it('walks forward from the caster, so water stops a ball at the near bank', () => {
    // Solid water stops a projectile and not an eye. Aimed at a wall across it,
    // or at the water itself, the ball goes off on the near bank — upstream's
    // walk, and the one our orbs make (`blockPath`). A walk back from the aim
    // would put the first of these on the far bank.
    const lv = withAt(TileCode.WATER, [[2, 0]]);
    lv.tiles[C.y * W + C.x + 4] = TileCode.WALL;
    expect(hasLineOfSight(lv, C, east(4)), 'the water blocks sight here').toBe(true);
    expect(ballCentre(lv, C, east(4))).toEqual(east(1));
    expect(ballCentre(withAt(TileCode.WATER, [[2, 0]]), C, east(2))).toEqual(east(1));
    // AND WATER RIGHT BESIDE THE WALL IT HIDES: caster, floor, water, wall.
    const bank = withAt(TileCode.WATER, [[2, 0]]);
    bank.tiles[C.y * W + C.x + 3] = TileCode.WALL;
    expect(ballCentre(bank, C, east(3))).toEqual(east(1));
  });
});
