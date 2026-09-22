// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// The rule under test ports t-engine4 game/engines/default/engine/generator/actor/OnSpots.lua:52
// (`util.findFreeGrid(spot.x, spot.y, spot_radius, "block_move", ...)`) and
// game/engines/default/engine/utils.lua:2370-2401 (`util.findFreeGrid`, over `circle_grids`).
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

import { describe, expect, it } from 'vitest';

import { nearSpot, populateDelve, specFor } from '../../src/server/content/delve.ts';
import { ballTiles, blocksMove } from '../../src/shared/ball.ts';
import { tileDistance } from '../../src/shared/distance.ts';
import { ActorKind, TileCode } from '../../src/shared/protocol.ts';
import { createWorld } from '../../src/server/world/world.ts';
import type { TileXY } from '../../src/shared/coords.ts';
import type { AuthoredMap } from '../../src/shared/level.ts';
import type { LevelView } from '../../src/shared/protocol.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * "NEAR A SPOT" IS `findFreeGrid`'S CIRCLE: ROUNDED, AND CUT BY WALLS.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * OnSpots asks `util.findFreeGrid(spot, spot_radius, "block_move", ...)`, whose
 * grids are `circle_grids` with terrain `block_move` as the wall. The placer
 * used a Chebyshev box: 121 tiles at radius 5 against the disc's 97, and it
 * reached through walls. Both halves are pinned on `nearSpot`, and the join is
 * driven through `populateDelve` with every body sent to one spot.
 */

const W = 21;
const S = { x: 10, y: 10 } as const;
const key = (t: TileXY): string => `${String(t.x)},${String(t.y)}`;

/** Every floor tile of `level`, row-major — a body's whole share. */
function floorOf(level: LevelView): TileXY[] {
  const out: TileXY[] = [];
  for (let y = 0; y < level.h; y += 1) {
    for (let x = 0; x < level.w; x += 1) {
      if (level.tiles[y * level.w + x] === TileCode.FLOOR) out.push({ x, y });
    }
  }
  return out;
}

function floorWith(code: number, at: readonly TileXY[] = []): LevelView {
  const tiles = new Array<number>(W * W).fill(TileCode.FLOOR);
  for (const t of at) tiles[t.y * W + t.x] = code;
  return { w: W, h: W, tiles };
}

describe('nearSpot — the circle OnSpots draws a body from', () => {
  it('is the rounded disc on open ground: 97 tiles at radius 5, the box corners out', () => {
    const level = floorWith(TileCode.FLOOR);
    const near = nearSpot(level, floorOf(level), S, 5).map(key);
    expect(near).toHaveLength(97);
    // (5,2) is 5.39 away and rounds to 5; (4,4) is 5.66 and rounds to 6.
    expect(near).toContain(key({ x: S.x + 5, y: S.y + 2 }));
    expect(near).not.toContain(key({ x: S.x + 4, y: S.y + 4 }));
    expect(near, 'the Chebyshev corner is near').not.toContain(key({ x: S.x + 5, y: S.y + 5 }));
  });

  it('stops at a wall: the row behind it is not near, the row beside it is', () => {
    const level = floorWith(TileCode.WALL, [{ x: S.x + 1, y: S.y }]);
    const near = nearSpot(level, floorOf(level), S, 5).map(key);
    for (let dx = 2; dx <= 5; dx += 1) {
      expect(near, `(${String(dx)},0) behind the wall is near`).not.toContain(
        key({ x: S.x + dx, y: S.y }),
      );
    }
    expect(near, '(2,1) beside the shadow is lost').toContain(key({ x: S.x + 2, y: S.y + 1 }));
    // Four hidden, and the wall itself was never in the share.
    expect(near).toHaveLength(97 - 1 - 4);
  });

  it('stops at lava too — it blocks movement, and a spawn circle asks block_move', () => {
    const level = floorWith(TileCode.MOLTEN_LAVA, [{ x: S.x + 1, y: S.y }]);
    const near = nearSpot(level, floorOf(level), S, 5).map(key);
    expect(near).not.toContain(key({ x: S.x + 2, y: S.y }));
    expect(near).toContain(key({ x: S.x + 2, y: S.y + 1 }));
  });

  it('keeps the share`s own order', () => {
    const level = floorWith(TileCode.FLOOR);
    const share = floorOf(level).reverse();
    const near = nearSpot(level, share, S, 2);
    expect(near.map(key)).toEqual(share.filter((t) => tileDistance(t, S) <= 2).map(key));
  });
});

describe('populateDelve draws on-spot bodies from that circle', () => {
  /**
   * THE JOIN. Blackwood's own spec, with every body sent to ONE spot: then
   * every monster on the floor must fit inside one radius-5 circle — the
   * spot's. Found by trying every tile as the centre, because the spot is a
   * draw this test does not see. The Chebyshev box put bodies in its corners,
   * 5.66 to 7.07 away, where no single circle of radius 5 holds them all.
   */
  const blackwood = specFor('site:blackwood_outskirts');
  if (blackwood === undefined) throw new Error('no Blackwood');
  const oneSpot = { ...blackwood, spots: { nbSpots: 1, spotRadius: 5, onSpotChance: 100 } };

  function floor(seed: string, walls: (x: number, y: number) => boolean) {
    const world = createWorld(seed, {
      view: { w: 40, h: 30, tiles: new Array<number>(40 * 30).fill(TileCode.FLOOR) },
      spawns: [{ x: 3, y: 3 }],
      sites: new Map<string, string>(),
    });
    world.level.tiles.fill(TileCode.FLOOR);
    for (let y = 0; y < world.level.h; y += 1) {
      for (let x = 0; x < world.level.w; x += 1) {
        const edge = x === 0 || y === 0 || x === world.level.w - 1 || y === world.level.h - 1;
        if (edge || walls(x, y)) world.level.tiles[y * world.level.w + x] = TileCode.WALL;
      }
    }
    const map: AuthoredMap = { view: world.level, spawns: [{ x: 3, y: 3 }], sites: new Map() };
    populateDelve(world, map, oneSpot, { level: 1, size: 1 });
    const bodies = world.allActors().filter((a) => a.kind === ActorKind.Monster);
    return { level: world.level, bodies };
  }

  /** Is there one tile whose ball of `r` (blocked by movement) holds every body? */
  function oneCircleHolds(level: LevelView, bodies: readonly TileXY[], r: number): boolean {
    const want = bodies.map(key);
    for (let y = 0; y < level.h; y += 1) {
      for (let x = 0; x < level.w; x += 1) {
        if (!bodies.every((b) => tileDistance(b, { x, y }) <= r)) continue;
        const ball = new Set(ballTiles(level, { x, y }, r, blocksMove(level)).map(key));
        if (want.every((k) => ball.has(k))) return true;
      }
    }
    return false;
  }

  it('on open ground, every body stands inside the spot`s rounded circle', () => {
    for (let n = 0; n < 4; n += 1) {
      const { level, bodies } = floor(`spots-open:${String(n)}`, () => false);
      expect(bodies.length, 'too few bodies to tell a disc from a box').toBeGreaterThan(8);
      expect(oneCircleHolds(level, bodies, 5), `seed ${String(n)}`).toBe(true);
    }
  });

  it('among pillars, every body stands where the spot can reach', () => {
    const pillar = (x: number, y: number): boolean => x % 3 === 0 && y % 3 === 0;
    for (let n = 0; n < 4; n += 1) {
      const { level, bodies } = floor(`spots-pillars:${String(n)}`, pillar);
      expect(bodies.length).toBeGreaterThan(8);
      expect(oneCircleHolds(level, bodies, 5), `seed ${String(n)}`).toBe(true);
    }
  });
});
