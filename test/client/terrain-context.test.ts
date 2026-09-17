/// <reference lib="dom" />

// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createRenderer,
  localDoorSpriteId,
  settlementRoofSpriteId,
} from '../../src/client/render/canvas.ts';
import { TileCode } from '../../src/shared/protocol.ts';
import type { LevelView } from '../../src/shared/protocol.ts';
import { TILE_PX } from '../../src/shared/version.ts';
import { installDom, removeDom, stubCanvas, stubSprites } from './canvasstub.ts';
import type { Blit } from './canvasstub.ts';

function level(code: number, width = 1, height = 1) {
  return { w: width, h: height, tiles: new Array<number>(width * height).fill(code) };
}

function levelBlits(levelView: LevelView, realmKind: string | null): Blit[] {
  const visible = stubCanvas(1248, 860);
  const renderer = createRenderer({
    canvas: visible as unknown as HTMLCanvasElement,
    // Deliberately wrong natural dimensions: terrain must still fill 64x64.
    sprites: stubSprites(31, 27),
  });
  renderer.resize();
  renderer.draw({
    level: levelView,
    realmKind,
    actors: [],
    selfId: null,
  });

  const map = visible.ctx?.blits[0]?.source;
  if (map === null || map === undefined || !('ctx' in map)) return [];
  return map.ctx?.blits ?? [];
}

function mapBlits(code: number, realmKind: string | null, width = 1, height = 1): Blit[] {
  return levelBlits(level(code, width, height), realmKind);
}

function ids(blits: readonly Blit[]): string[] {
  return blits.flatMap((blit) => {
    const source = blit.source;
    return source !== null && 'id' in source ? [source.id] : [];
  });
}

describe('terrain art follows realm scale', () => {
  beforeEach(() => installDom(1));
  afterEach(removeDom);

  it('draws the same civic TileCode as a world symbol or a local material', () => {
    expect(ids(mapBlits(TileCode.CIVIC, 'overworld'))).toContain('tile_ow_civic');
    expect(ids(mapBlits(TileCode.CIVIC, 'common'))).toContain('tile_local_civic');
    expect(ids(mapBlits(TileCode.CIVIC, 'inner'))).toContain('tile_local_civic');
  });

  it('does not reuse the world-scale town wall after entering a town', () => {
    expect(ids(mapBlits(TileCode.TOWN_WALL, 'overworld'))).toContain('tile_ow_wall');
    const local = ids(mapBlits(TileCode.TOWN_WALL, 'common'));
    expect(local).toContain('tile_local_town_wall');
    expect(local).not.toContain('tile_ow_wall');
  });

  it('fails an unknown realm to the flat palette instead of guessing a scale', () => {
    expect(ids(mapBlits(TileCode.CIVIC, null))).toEqual([]);
    expect(ids(mapBlits(TileCode.CIVIC, 'future-kind'))).toEqual([]);
  });

  it('never lays overworld road topology over local paving', () => {
    const local = ids(mapBlits(TileCode.PAVING, 'common', 3, 3));
    expect(local).toContain('tile_local_paving');
    expect(local.some((id) => id.startsWith('tile_ow_road_'))).toBe(false);
  });

  it('reconstructs a connected world roof from coordinate phases, not house stamps', () => {
    const world = ids(mapBlits(TileCode.CITY_ROOF, 'overworld', 2, 2));
    expect(world).toEqual(
      expect.arrayContaining([
        'tile_ow_city_roof_p00',
        'tile_ow_city_roof_p01',
        'tile_ow_city_roof_p10',
        'tile_ow_city_roof_p11',
      ]),
    );
    expect(world).not.toContain('tile_ow_city_roof');
  });

  it('wraps the phase surface every four world cells, including negative coordinates', () => {
    expect(settlementRoofSpriteId(TileCode.TOWN_ROOF, 0, 0)).toBe('tile_ow_town_roof_p00');
    expect(settlementRoofSpriteId(TileCode.TOWN_ROOF, 4, 4)).toBe('tile_ow_town_roof_p00');
    expect(settlementRoofSpriteId(TileCode.TOWN_ROOF, -1, -1)).toBe('tile_ow_town_roof_p33');
    expect(settlementRoofSpriteId(TileCode.PAVING, 0, 0)).toBeNull();
  });

  it('orients same-level doors along the passage through their wall', () => {
    const horizontalWall = level(TileCode.FLOOR, 3, 3);
    horizontalWall.tiles[3] = TileCode.WALL;
    horizontalWall.tiles[4] = TileCode.DOOR;
    horizontalWall.tiles[5] = TileCode.WALL;
    expect(localDoorSpriteId(horizontalWall, TileCode.DOOR, 1, 1)).toBe(
      'tile_local_door_closed_ns',
    );
    horizontalWall.tiles[4] = TileCode.DOOR_OPEN;
    expect(localDoorSpriteId(horizontalWall, TileCode.DOOR_OPEN, 1, 1)).toBe(
      'tile_local_door_open_ns',
    );

    const verticalWall = level(TileCode.FLOOR, 3, 3);
    verticalWall.tiles[1] = TileCode.WALL;
    verticalWall.tiles[4] = TileCode.DOOR;
    verticalWall.tiles[7] = TileCode.WALL;
    expect(localDoorSpriteId(verticalWall, TileCode.DOOR, 1, 1)).toBe('tile_local_door_closed_ew');
    verticalWall.tiles[4] = TileCode.DOOR_OPEN;
    expect(localDoorSpriteId(verticalWall, TileCode.DOOR_OPEN, 1, 1)).toBe(
      'tile_local_door_open_ew',
    );
  });

  it('continues both neighboring ground materials beneath directional door overlays', () => {
    const northSouth = level(TileCode.FLOOR, 3, 3);
    northSouth.tiles[1] = TileCode.PAVING;
    northSouth.tiles[3] = TileCode.WALL;
    northSouth.tiles[4] = TileCode.DOOR_OPEN;
    northSouth.tiles[5] = TileCode.WALL;
    northSouth.tiles[7] = TileCode.COBBLE;
    const nsIds = ids(levelBlits(northSouth, 'common'));
    expect(nsIds.filter((id) => id.startsWith('tile_local_paving'))).toHaveLength(2);
    expect(nsIds.filter((id) => id.startsWith('tile_local_cobble'))).toHaveLength(2);
    expect(nsIds).toContain('tile_local_door_open_ns');

    const eastWest = level(TileCode.FLOOR, 3, 3);
    eastWest.tiles[1] = TileCode.WALL;
    eastWest.tiles[3] = TileCode.GREEN;
    eastWest.tiles[4] = TileCode.DOOR;
    eastWest.tiles[5] = TileCode.YARD;
    eastWest.tiles[7] = TileCode.WALL;
    const ewIds = ids(levelBlits(eastWest, 'common'));
    expect(ewIds.filter((id) => id.startsWith('tile_local_green'))).toHaveLength(2);
    expect(ewIds.filter((id) => id.startsWith('tile_local_yard'))).toHaveLength(2);
    expect(ewIds).toContain('tile_local_door_closed_ew');
  });

  it('fills a cell regardless of the source image dimensions', () => {
    const terrain = mapBlits(TileCode.CIVIC, 'common').find(
      (blit) =>
        blit.source !== null && 'id' in blit.source && blit.source.id === 'tile_local_civic',
    );
    expect(terrain?.dw).toBe(TILE_PX);
    expect(terrain?.dh).toBe(TILE_PX);
  });
});
