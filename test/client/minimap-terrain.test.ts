// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported against t-engine4 game/modules/tome/class/Grid.lua:128-134 (setupMinimapInfo)
//             t-engine4 game/engines/default/engine/Grid.lua:42-46 (block_move is wall)
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" — https://te4.org/license

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE THEMED CODES ON THE MINIMAP: WHAT UPSTREAM PAINTS, IN OUR BANDS.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `special_minimap` first, then wall for `block_move` and floor for the rest.
 * Only deep water (water.lua:128, through WATER_BASE) and molten lava
 * (lava.lua:64) carry a colour of their own. So on the Weir — seabed, coral wall,
 * bubble and doors — the minimap must show a floor plan, not one blue sheet.
 */

import { describe, expect, it } from 'vitest';

import { paintMap } from '../../src/client/ui/mapview.ts';
import { TileCode } from '../../src/shared/protocol.ts';

/** The fill each tile of a one-row level is drawn in, left to right. */
function fills(tiles: readonly number[]): string[] {
  const out: string[] = [];
  let style = '';
  const ctx = new Proxy(
    {},
    {
      get: (_target, prop: string) => {
        if (prop === 'measureText') return () => ({ width: 10 });
        if (prop === 'fillRect') return () => out.push(style);
        return () => undefined;
      },
      set: (_target, prop: string, value: unknown) => {
        if (prop === 'fillStyle') style = String(value);
        return true;
      },
    },
  ) as unknown as CanvasRenderingContext2D;
  paintMap({
    ctx,
    level: { w: tiles.length, h: 1, tiles: [...tiles] },
    rect: { x: 0, y: 0, w: tiles.length * 4, h: 4 },
    sites: [],
    framed: false,
    labelled: false,
    regions: [],
    party: [],
    actors: [],
  });
  return out.slice(0, tiles.length);
}

/** One code's fill. */
function fill(code: TileCode): string {
  const [only] = fills([code]);
  if (only === undefined) throw new Error('nothing was drawn');
  return only;
}

describe('minimap bands for the themed codes', () => {
  it('deep water is the water band; the seabed, its bubble and its fake are floor', () => {
    const water = fill(TileCode.WATER);
    expect(fill(TileCode.DEEPWATER)).toBe(water);
    expect(fill(TileCode.POND_WATER)).toBe(water);
    const wild = fill(TileCode.MIRE);
    expect(wild).not.toBe(water);
    for (const code of [
      TileCode.WATER_FLOOR,
      TileCode.WATER_FLOOR_FAKE,
      TileCode.WATER_FLOOR_BUBBLE,
      TileCode.LAVA_FLOOR,
      TileCode.LAVA_FLOOR_FAKE,
      TileCode.VOID,
    ]) {
      expect(fill(code), String(code)).toBe(wild);
    }
  });

  it('coral, lava walls and outer space are wall; molten lava is its own band', () => {
    const wall = fill(TileCode.WALL);
    for (const code of [TileCode.WATER_WALL, TileCode.LAVA_WALL, TileCode.OUTERSPACE]) {
      expect(fill(code), String(code)).toBe(wall);
    }
    const lava = fill(TileCode.MOLTEN_LAVA);
    expect(lava).not.toBe(wall);
    expect(lava).not.toBe(fill(TileCode.WATER));
    expect(lava).not.toBe(fill(TileCode.MIRE));
    expect(fill(TileCode.ERASED)).not.toBe(wall);
  });

  it('a rock door is a shut door (`is_door`, tome/class/Grid.lua:130-131)', () => {
    expect(fill(TileCode.ROCK_DOOR)).toBe(fill(TileCode.DOOR));
    expect(fill(TileCode.ROCK_DOOR)).not.toBe(fill(TileCode.WALL));
  });

  it('draws the Weir as a floor plan: seabed and coral are two colours', () => {
    const row = fills([
      TileCode.WATER_WALL,
      TileCode.WATER_FLOOR,
      TileCode.WATER_FLOOR_BUBBLE,
      TileCode.DOOR,
      TileCode.WATER_FLOOR,
      TileCode.WATER_WALL,
    ]);
    expect(new Set(row).size).toBe(3);
    expect(row[0]).not.toBe(row[1]);
  });
});
