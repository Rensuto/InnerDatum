// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/modules/tome/class/Player.lua:1200-1217 (the mouse walk refuses what you cannot breathe)
//             t-engine4 game/engines/default/engine/interface/PlayerMouse.lua:70-72 (and rechecks without it)
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" — https://te4.org/license

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A CLICKED WALK GOES AROUND THE POND, UNLESS THE POND IS THE POINT.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Upstream's mouse walk runs A* refusing every tile the player cannot breathe
 * on, and runs it again without that refusal when the first found nothing. So:
 * around when there is a way around; straight in when the clicked tile is
 * itself water (the refusal fails the goal); and through when the far shore
 * can only be reached by wading.
 */

import { describe, expect, it } from 'vitest';

import {
  TravelStart,
  createTravel,
  exploreSlowAt,
  mouseWalkRefusesAt,
} from '../../src/client/input/travel.ts';
import { findPath } from '../../src/shared/path.ts';
import { TileCode, isWalkable } from '../../src/shared/protocol.ts';
import type { TileXY } from '../../src/shared/coords.ts';
import type { LevelView } from '../../src/shared/protocol.ts';

const LEGEND: Readonly<Record<string, TileCode>> = {
  '.': TileCode.FLOOR,
  '~': TileCode.POND_WATER,
  f: TileCode.WATER_FLOOR_FAKE,
  o: TileCode.WATER_FLOOR_BUBBLE,
  L: TileCode.LAVA_FLOOR,
};

function mapOf(rows: readonly string[]): LevelView {
  const w = rows[0]?.length ?? 0;
  const tiles: number[] = [];
  for (const row of rows) {
    for (let x = 0; x < w; x += 1) tiles.push(LEGEND[row.charAt(x)] ?? TileCode.WALL);
  }
  return { w, h: rows.length, tiles };
}

const codeAt = (level: LevelView, tile: TileXY): number =>
  level.tiles[tile.y * level.w + tile.x] ?? TileCode.WALL;

/** Start a walk and hand back the route it planned. */
function plan(level: LevelView, from: TileXY, to: TileXY, stopShort = false) {
  const travel = createTravel();
  const start = travel.begin({ from, to, level, stopShort });
  return { start, route: travel.preview() };
}

const POND = mapOf([
  '#########',
  '#.......#',
  '#.~~~~~.#',
  '#.~~~~~.#',
  '#.~~~~~.#',
  '#.......#',
  '#########',
]);

describe('what the walker goes around — it breathes air and nothing else', () => {
  it('a clicked walk refuses any air it cannot breathe, the bubble too, and not lava (Player.lua:1206-1213)', () => {
    const row = mapOf(['~Lfo.']);
    expect([0, 1, 2, 3, 4].map((x) => mouseWalkRefusesAt(row, x, 0))).toEqual([
      true,
      false,
      false,
      true,
      false,
    ]);
  });

  it('auto-explore slows for water, a burn and any on_stand (PlayerExplore.lua:1958-1966)', () => {
    const row = mapOf(['~Lfo.']);
    expect([0, 1, 2, 3, 4].map((x) => exploreSlowAt(row, x, 0))).toEqual([
      true,
      true,
      false,
      true,
      false,
    ]);
  });
});

describe('travel.begin routes around a hazard — Player.lua:1206-1214', () => {
  it('goes around the pond when there is a way around', () => {
    const plainly = findPath({ x: 1, y: 3 }, { x: 7, y: 3 }, (x, y) =>
      isWalkable(codeAt(POND, { x, y })),
    );
    expect(
      plainly?.some((tile) => codeAt(POND, tile) === TileCode.POND_WATER),
      'precondition: the plain route wades',
    ).toBe(true);

    const { start, route } = plan(POND, { x: 1, y: 3 }, { x: 7, y: 3 });
    expect(start).toBe(TravelStart.Started);
    expect(route.at(-1)).toEqual({ x: 7, y: 3 });
    expect(route.map((tile) => codeAt(POND, tile))).not.toContain(TileCode.POND_WATER);
  });

  it('walks straight in when the clicked tile is the water: the refusal fails the goal itself', () => {
    // The far edge of the pond, one step from dry ground on its own side.
    // Exempting the goal would walk round the top and step in; upstream's
    // `add_check` refuses the goal too, so the second, plain search wades across.
    const to = { x: 6, y: 3 };
    const plainly = findPath({ x: 1, y: 3 }, to, (x, y) => isWalkable(codeAt(POND, { x, y })));
    expect(
      plainly?.slice(0, -1).some((tile) => codeAt(POND, tile) === TileCode.POND_WATER),
      'precondition: the plain route wades before it arrives',
    ).toBe(true);
    const { start, route } = plan(POND, { x: 1, y: 3 }, to);
    expect(start).toBe(TravelStart.Started);
    expect(route).toEqual(plainly);
  });

  it('wades when the only way to the far shore is through the water (`recheck`)', () => {
    const moat = mapOf(['#######', '#..~..#', '#..~..#', '#######']);
    const { start, route } = plan(moat, { x: 1, y: 1 }, { x: 5, y: 1 });
    expect(start).toBe(TravelStart.Started);
    expect(route.at(-1)).toEqual({ x: 5, y: 1 });
    expect(route.map((tile) => codeAt(moat, tile))).toContain(TileCode.POND_WATER);
  });

  it('goes around an air bubble, whose charges the way back may need', () => {
    const bubbles = mapOf(['#######', '#.....#', '#.ooo.#', '#.....#', '#######']);
    const { start, route } = plan(bubbles, { x: 1, y: 2 }, { x: 5, y: 2 });
    expect(start).toBe(TravelStart.Started);
    expect(route.at(-1)).toEqual({ x: 5, y: 2 });
    expect(route.map((tile) => codeAt(bubbles, tile))).not.toContain(TileCode.WATER_FLOOR_BUBBLE);
  });

  it('does not go around lava: the mouse walk asks about breath, not about burns', () => {
    const lava = mapOf(['#######', '#.....#', '#.LLL.#', '#.....#', '#######']);
    const { route } = plan(lava, { x: 1, y: 2 }, { x: 5, y: 2 });
    expect(route.map((tile) => codeAt(lava, tile))).toContain(TileCode.LAVA_FLOOR);
  });

  it('walking up to a body in the water, stops on the dry side', () => {
    // `stopShort` exempts the goal, so the route along the shore still refuses
    // the pond and only the dropped last tile is wet.
    const { start, route } = plan(POND, { x: 1, y: 3 }, { x: 6, y: 3 }, true);
    expect(start).toBe(TravelStart.Started);
    expect(route.map((tile) => codeAt(POND, tile))).not.toContain(TileCode.POND_WATER);
  });
});
