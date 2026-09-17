/// <reference lib="dom" />

// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  LOCAL_TILE_SPRITES,
  createRenderer,
  localDoorSpriteId,
} from '../../src/client/render/canvas.ts';
import { makeSettlementMap } from '../../src/server/content/towns.ts';
import { SITES } from '../../src/server/world/realms.ts';
import { TileCode, isWalkable } from '../../src/shared/protocol.ts';
import type { LevelView } from '../../src/shared/protocol.ts';
import { TILE_PX } from '../../src/shared/version.ts';
import { installDom, removeDom, stubCanvas, stubSprites } from './canvasstub.ts';
import type { Blit } from './canvasstub.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A DOOR IS GROUND, THEN A DOOR, TURNED TO THE WALL IT STANDS IN.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `paintLocalDoor` continues the ground on the two passage sides under the
 * door cell (two half-cell blits) and lays the transparent directional door over
 * it. Three things decide what that looks like, and each has a way to go wrong
 * that no other test reaches:
 *
 *   WHICH WAY IT FACES. Ported from tome/class/NicerTiles.lua:641-657: walls
 *   north and south first (DOOR_VERT, our `_ew`), then walls west and east
 *   (DOOR_HORIZ, our `_ns`), else the front view. The count of walkable
 *   neighbours this replaced sent a boxed-in door the other way, and turned a
 *   door round when the door beside it opened.
 *
 *   WHAT IT STANDS ON. Never another door. An open door is walkable and its
 *   picture is a doorway, so a rule that asked only "walkable?" would paint half
 *   of one door's frame as the floor of the next.
 *
 *   THAT IT STAYS PUT. Upstream turns a door once, when the level is tiled, and
 *   a neighbouring door counts as wall whether open or shut; so opening one door
 *   must not turn the door beside it round.
 */

function levelOf(width: number, height: number, fill: number): LevelView & { tiles: number[] } {
  return { w: width, h: height, tiles: new Array<number>(width * height).fill(fill) };
}

function blitsOf(level: LevelView): Blit[] {
  const visible = stubCanvas(1248, 860);
  const renderer = createRenderer({
    canvas: visible as unknown as HTMLCanvasElement,
    sprites: stubSprites(64, 64),
  });
  renderer.resize();
  renderer.draw({ level, realmKind: 'common', actors: [], selfId: null });
  const map = visible.ctx?.blits[0]?.source;
  if (map === null || map === undefined || !('ctx' in map)) return [];
  return map.ctx?.blits ?? [];
}

function idOf(blit: Blit): string {
  return blit.source !== null && 'id' in blit.source ? blit.source.id : '';
}

/**
 * What the renderer put in the MIDDLE cell of a 3x3 level: its two ground halves
 * and its door. The neighbours may be doors too, so the cell is found by where
 * the blits land (one cell in from the top-left of the drawn map), not by id.
 */
function doorLayers(level: LevelView): { halves: string[]; doors: string[] } {
  const blits = blitsOf(level);
  const half = TILE_PX / 2;
  const x0 = Math.min(...blits.map((b) => b.dx)) + TILE_PX;
  const y0 = Math.min(...blits.map((b) => b.dy)) + TILE_PX;
  const inCell = (b: Blit): boolean =>
    b.dx >= x0 && b.dx < x0 + TILE_PX && b.dy >= y0 && b.dy < y0 + TILE_PX;
  const cell = blits.filter(inCell);
  return {
    halves: cell
      .filter((b) => (b.dw === half && b.dh === TILE_PX) || (b.dw === TILE_PX && b.dh === half))
      .map(idOf),
    doors: cell.map(idOf).filter((id) => /^tile_local_door_(?:closed|open)_(?:ns|ew)$/.test(id)),
  };
}

/** A 3x3 level: the door in the middle, `[north, south, west, east]` around it. */
function doorAmong(door: number, around: readonly [number, number, number, number]) {
  const level = levelOf(3, 3, TileCode.WALL);
  const [north, south, west, east] = around;
  level.tiles[1] = north;
  level.tiles[7] = south;
  level.tiles[3] = west;
  level.tiles[5] = east;
  level.tiles[4] = door;
  return level;
}

describe('a local door draws over ground, facing its wall', () => {
  beforeEach(() => installDom(1));
  afterEach(removeDom);

  it('boxed in on every side, takes the north-south wall door over a real floor', () => {
    const { WALL, DOOR } = TileCode;
    const layers = doorLayers(doorAmong(DOOR, [WALL, WALL, WALL, WALL]));
    expect(layers.doors).toEqual(['tile_local_door_closed_ew']);
    expect(layers.halves).toHaveLength(2);
    for (const id of layers.halves) expect(id).toMatch(/^tile_local_floor(?:_[b-h])?$/);
  });

  it('never stands on another door, open or shut', () => {
    const { DOOR, DOOR_OPEN, PAVING, COBBLE } = TileCode;
    for (const door of [DOOR, DOOR_OPEN]) {
      const layers = doorLayers(doorAmong(door, [DOOR_OPEN, DOOR, PAVING, COBBLE]));
      expect(layers.doors).toEqual([
        door === DOOR ? 'tile_local_door_closed_ew' : 'tile_local_door_open_ew',
      ]);
      expect(layers.halves.map((id) => id.replace(/_[b-h]$/, ''))).toEqual([
        'tile_local_paving',
        'tile_local_cobble',
      ]);
    }
    // And along the passage itself: an open door to the north is walkable, and
    // the ground there is the paving to the south, twice.
    const { WALL } = TileCode;
    const along = doorLayers(doorAmong(DOOR, [DOOR_OPEN, PAVING, WALL, WALL]));
    expect(along.doors).toEqual(['tile_local_door_closed_ns']);
    expect(along.halves.map((id) => id.replace(/_[b-h]$/, ''))).toEqual([
      'tile_local_paving',
      'tile_local_paving',
    ]);
  });

  it('does not turn round when the door beside it opens', () => {
    const { WALL, DOOR, DOOR_OPEN, FLOOR } = TileCode;
    for (const neighbour of [DOOR, DOOR_OPEN]) {
      const layers = doorLayers(doorAmong(DOOR, [neighbour, WALL, FLOOR, WALL]));
      expect(layers.doors, `beside ${String(neighbour)}`).toEqual(['tile_local_door_closed_ew']);
      expect(layers.halves.map((id) => id.replace(/_[b-h]$/, ''))).toEqual([
        'tile_local_floor',
        'tile_local_floor',
      ]);
    }
  });
});

describe('every door in an authored settlement', () => {
  const settlements = [...SITES.keys()].filter((id) => makeSettlementMap(id) !== undefined);

  it('stands in a wall line, faces it, and has local ground on both passage sides', () => {
    let doors = 0;
    const faults: string[] = [];
    for (const siteId of settlements) {
      const map = makeSettlementMap(siteId);
      if (map === undefined) continue;
      const { view } = map;
      const at = (x: number, y: number): number =>
        x < 0 || y < 0 || x >= view.w || y >= view.h
          ? TileCode.WALL
          : (view.tiles[y * view.w + x] ?? TileCode.WALL);
      for (let y = 0; y < view.h; y += 1) {
        for (let x = 0; x < view.w; x += 1) {
          const code = at(x, y);
          if (code !== TileCode.DOOR) continue;
          doors += 1;
          const where = `${siteId} (${String(x)},${String(y)})`;
          const northSouthWall = !isWalkable(at(x, y - 1)) && !isWalkable(at(x, y + 1));
          const westEastWall = !isWalkable(at(x - 1, y)) && !isWalkable(at(x + 1, y));
          if (northSouthWall === westEastWall) {
            faults.push(`${where} is not in a single wall line`);
            continue;
          }
          const passage = northSouthWall
            ? [at(x - 1, y), at(x + 1, y)]
            : [at(x, y - 1), at(x, y + 1)];
          const want = northSouthWall ? 'tile_local_door_closed_ew' : 'tile_local_door_closed_ns';
          const got = localDoorSpriteId(view, TileCode.DOOR, x, y);
          if (got !== want) faults.push(`${where} faces ${String(got)}, not ${want}`);
          for (const side of passage) {
            if (!isWalkable(side) || LOCAL_TILE_SPRITES[side as TileCode] === undefined) {
              faults.push(`${where} opens onto code ${String(side)}, which has no local ground`);
            }
          }
        }
      }
    }
    // THE CONTROL: a scan that found no door passes the fault list forever.
    expect(settlements.length).toBeGreaterThanOrEqual(5);
    expect(doors).toBeGreaterThan(20);
    expect(faults).toEqual([]);
  });
});
