/// <reference lib="dom" />

// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  LOCAL_TILE_SPRITES,
  createRenderer,
  isLoneTree,
  loneTreeGroundCode,
} from '../../src/client/render/canvas.ts';
import { makeSettlementMap } from '../../src/server/content/towns.ts';
import { SITES } from '../../src/server/world/realms.ts';
import { TileCode, isWalkable } from '../../src/shared/protocol.ts';
import type { LevelView } from '../../src/shared/protocol.ts';
import { TILE_PX } from '../../src/shared/version.ts';
import { installDom, removeDom, stubCanvas, stubSprites } from './canvasstub.ts';
import type { Blit, Rect } from './canvasstub.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A TREE ON ITS OWN IS A TREE. A WOOD IS STILL A WOOD.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Reported with a screenshot: the ornamental trees in Alderbrook read as DARK
 * SQUARES. They were one cell of the canopy texture — a picture of the inside
 * of a wood, correct for a mass and meaningless alone — inside a four-sided INK
 * rim from `paintBarrierEdge`, because TREES is not walkable.
 *
 * `paintLoneTree` composites instead: the ground the neighbours stand on, then
 * a hard-alpha single tree over it, and no rim. Four things decide what that
 * looks like and each has its own way to be wrong:
 *
 *   WHICH CELLS ARE LONE. At most one TREES neighbour, i.e. none on three of
 *   the four sides. Two is the end of a line of wood and keeps the canopy — a
 *   hedge drawn as separate trees has gaps a player would read as a way
 *   through, and it is not one.
 *
 *   WHAT IT STANDS ON. The commonest ground among the neighbours, then the
 *   commonest neighbour of any kind. The second term is what puts the
 *   breeding-pit tree in its thicket instead of on a lawn.
 *
 *   THAT THE MAP EDGE IS NOT A WALL. `tileAt` fails closed to WALL off-grid,
 *   which is right for a sight question and would hand a corner tree a wall to
 *   stand on.
 *
 *   THAT IT IS A LOCAL ANSWER. At world scale a TREES cell IS a wood on a map,
 *   and must keep both its canopy and its rim.
 */

function levelOf(width: number, height: number, fill: number): LevelView & { tiles: number[] } {
  return { w: width, h: height, tiles: new Array<number>(width * height).fill(fill) };
}

function setTile(level: LevelView & { tiles: number[] }, x: number, y: number, code: number): void {
  level.tiles[y * level.w + x] = code;
}

/** Everything the renderer put on the map backbuffer, in draw order. */
function drawnOn(
  level: LevelView,
  realmKind: string,
  /**
   * Ids this fixture pretends are NOT on disk. The art tree is gitignored, so a
   * bare clone has none of it, and `stubSprites` answering every id is what made
   * that path unreachable by any test in this file or in `door-paint.test.ts`.
   */
  missing?: (id: string) => boolean,
): { blits: Blit[]; rects: Rect[] } {
  const visible = stubCanvas(1248, 860);
  const renderer = createRenderer({
    canvas: visible as unknown as HTMLCanvasElement,
    sprites: stubSprites(64, 64, missing),
  });
  renderer.resize();
  renderer.draw({ level, realmKind, actors: [], selfId: null });
  const map = visible.ctx?.blits[0]?.source;
  if (map === null || map === undefined || !('ctx' in map)) return { blits: [], rects: [] };
  return { blits: map.ctx?.blits ?? [], rects: map.ctx?.rects ?? [] };
}

function idOf(blit: Blit): string {
  return blit.source !== null && 'id' in blit.source ? blit.source.id : '';
}

/**
 * The ids and the flat rectangles that landed in ONE cell.
 *
 * Found by where the blits land, not by id: every cell of these fixtures paints
 * something, so the smallest destination is tile (0,0) and the rest is
 * arithmetic. Levels here stay inside the 16x8 viewport so the whole of each
 * one is drawn.
 */
function cell(
  level: LevelView,
  tx: number,
  ty: number,
  realmKind = 'common',
  missing?: (id: string) => boolean,
): { ids: string[]; rects: Rect[] } {
  const { blits, rects } = drawnOn(level, realmKind, missing);
  const x0 = Math.min(...blits.map((b) => b.dx)) + tx * TILE_PX;
  const y0 = Math.min(...blits.map((b) => b.dy)) + ty * TILE_PX;
  const inside = (x: number, y: number): boolean =>
    x >= x0 && x < x0 + TILE_PX && y >= y0 && y < y0 + TILE_PX;
  return {
    ids: blits.filter((b) => inside(b.dx, b.dy)).map(idOf),
    rects: rects.filter((r) => inside(r.x, r.y)),
  };
}

const SINGLE = /^tile_local_tree_single(?:_[b-h])?$/;
const CANOPY = /^tile_local_trees(?:_[b-h])?$/;

describe('a tree standing alone', () => {
  beforeEach(() => installDom(1));
  afterEach(removeDom);

  it('is drawn on the ground around it, and the wood beside it is not', () => {
    // A lone tree at (1,1); a 2x2 stand at (3,1)-(4,2). Every cell of the stand
    // has two TREES neighbours, so the whole mass keeps the canopy.
    const level = levelOf(6, 5, TileCode.GREEN);
    setTile(level, 1, 1, TileCode.TREES);
    for (const [x, y] of [
      [3, 1],
      [4, 1],
      [3, 2],
      [4, 2],
    ]) {
      setTile(level, x ?? 0, y ?? 0, TileCode.TREES);
    }

    const alone = cell(level, 1, 1).ids;
    expect(alone).toHaveLength(2);
    expect(alone[0]).toMatch(/^tile_local_green(?:_[b-h])?$/);
    expect(alone[1]).toMatch(SINGLE);

    for (const [x, y] of [
      [3, 1],
      [4, 1],
      [3, 2],
      [4, 2],
    ]) {
      const mass = cell(level, x ?? 0, y ?? 0).ids;
      expect(mass, `the stand at ${String(x)},${String(y)}`).toHaveLength(1);
      expect(mass[0]).toMatch(CANOPY);
    }
  });

  it('is one tree at the end of a line and canopy in the middle of it', () => {
    // THE BOUNDARY OF THE RULE, both sides of it in one fixture. The middle of
    // a three-cell hedge has two TREES neighbours and stays a wood; each end
    // has one and becomes a tree.
    const level = levelOf(6, 5, TileCode.GREEN);
    for (const x of [1, 2, 3]) setTile(level, x, 2, TileCode.TREES);

    expect(isLoneTree(level, 2, 2)).toBe(false);
    expect(cell(level, 2, 2).ids[0]).toMatch(CANOPY);
    for (const x of [1, 3]) {
      expect(isLoneTree(level, x, 2), `the end at ${String(x)}`).toBe(true);
      expect(cell(level, x, 2).ids[1]).toMatch(SINGLE);
    }
  });

  it('stands in the thicket when nothing around it is ground', () => {
    // The breeding pits deal one TREES among eleven UNDERGROUND_TREE
    // (`shared/mapgen/zones.ts`, upstream's own table). Nothing beside it is
    // walkable, so the second term answers and the tree stands in the thicket
    // rather than on a lawn it is nowhere near.
    const level = levelOf(5, 5, TileCode.UNDERGROUND_TREE);
    setTile(level, 2, 2, TileCode.TREES);
    expect(loneTreeGroundCode(level, 2, 2)).toBe(TileCode.UNDERGROUND_TREE);
    const ids = cell(level, 2, 2).ids;
    expect(ids[0]).toMatch(/^tile_local_underground_tree(?:_[b-h])?$/);
    expect(ids[1]).toMatch(SINGLE);
  });

  it('never stands on the wall the map edge reads as', () => {
    // `tileAt` answers WALL off-grid. In the corner of a thicket that is TWO
    // WALLs against two neighbours, and a rule that counted them would put this
    // tree on masonry: WALL loses the ground test and then wins the fallback on
    // the N,E,S,W tie-break.
    const thicket = levelOf(5, 5, TileCode.UNDERGROUND_TREE);
    setTile(thicket, 0, 0, TileCode.TREES);
    expect(isLoneTree(thicket, 0, 0)).toBe(true);
    expect(loneTreeGroundCode(thicket, 0, 0)).toBe(TileCode.UNDERGROUND_TREE);

    // And in the open, the corner tree stands on the grass beside it.
    const field = levelOf(5, 5, TileCode.GREEN);
    setTile(field, 0, 0, TileCode.TREES);
    expect(loneTreeGroundCode(field, 0, 0)).toBe(TileCode.GREEN);
  });

  it('never stands on a doorway', () => {
    // `isDoorGround`, not `isWalkable`: an open door is walkable and its picture
    // is a doorway, never a floor. Two open doors against one paving cell, and
    // the paving is what the tree stands on.
    const level = levelOf(5, 5, TileCode.WALL);
    setTile(level, 2, 2, TileCode.TREES);
    setTile(level, 2, 1, TileCode.DOOR_OPEN);
    setTile(level, 1, 2, TileCode.DOOR_OPEN);
    setTile(level, 3, 2, TileCode.PAVING);
    expect(loneTreeGroundCode(level, 2, 2)).toBe(TileCode.PAVING);
  });

  it('loses the barrier rim the wood beside it keeps', () => {
    // The rim outlines a MASS. Four sides of INK around one tree is the dark
    // square in the screenshot, and the drawn tree says "not through here"
    // better than a border does.
    const level = levelOf(6, 5, TileCode.GREEN);
    setTile(level, 1, 1, TileCode.TREES);
    for (const x of [2, 3, 4]) setTile(level, x, 3, TileCode.TREES);

    expect(cell(level, 1, 1).rects).toEqual([]);
    // The hedge below it keeps its own: the middle of the line is still a mass,
    // and its north and south sides face ground a player can walk on.
    expect(cell(level, 3, 3).rects).toHaveLength(2);
  });

  it('breaks a tie between two grounds by the N, E, S, W scan order', () => {
    /**
     * `commonest`'s own docblock promises the order and nothing measured it:
     * turning `count > bestCount` into `>=` makes the LAST maximum win, so a
     * tree with grass to the north and paving to the east silently swaps which
     * one it stands on. No fixture in this file made a 1-1 tie between two
     * different walkable codes, so every case was decided by a clear majority.
     *
     * ONE EACH, AND THE FIRST IN THE SCAN ORDER IS THE ANSWER.
     */
    const level = levelOf(5, 5, TileCode.WALL);
    setTile(level, 2, 2, TileCode.TREES);
    setTile(level, 2, 1, TileCode.GREEN); // north
    setTile(level, 3, 2, TileCode.PAVING); // east
    expect(loneTreeGroundCode(level, 2, 2)).toBe(TileCode.GREEN);

    // AND THE ORDER IS THE SCAN, NOT THE CODE'S NUMBER: the same pair the other
    // way round answers the other way round.
    const swapped = levelOf(5, 5, TileCode.WALL);
    setTile(swapped, 2, 2, TileCode.TREES);
    setTile(swapped, 2, 1, TileCode.PAVING); // north
    setTile(swapped, 3, 2, TileCode.GREEN); // east
    expect(loneTreeGroundCode(swapped, 2, 2)).toBe(TileCode.PAVING);
  });

  it('falls back to the canopy on a clone that has no single-tree art', () => {
    /**
     * `paintLoneTree`'s docblock promises this outright — *"FALSE IF EITHER HALF
     * IS MISSING"* — and no test could reach it, because `stubSprites` answered
     * every id. The art tree is gitignored: a bare clone has neither the overlay
     * nor the ground under it, and a tree floating over nothing is worse than
     * the wood it replaces. Both halves, one at a time.
     */
    const level = levelOf(6, 5, TileCode.GREEN);
    setTile(level, 1, 1, TileCode.TREES);

    const noTree = cell(level, 1, 1, 'common', (id) => SINGLE.test(id));
    expect(noTree.ids, 'a missing overlay left the cell blank').not.toHaveLength(0);
    expect(
      noTree.ids.some((id) => CANOPY.test(id)),
      'it did not fall back to the wood',
    ).toBe(true);
    // AND THE RIM COMES BACK WITH THE CANOPY. The exemption is gated on the
    // painter having DRAWN, never on the predicate — a wood with no outline is
    // the barrier that stopped reading as one.
    expect(noTree.rects.length, 'a clone`s wood lost its barrier rim').toBeGreaterThan(0);

    // THE GROUND HALF, on a map where only the ground UNDER THIS TREE is
    // missing: taking the whole field's art away would leave the fixture with
    // nothing to measure the cell's position from.
    const paved = levelOf(6, 5, TileCode.GREEN);
    setTile(paved, 1, 1, TileCode.TREES);
    for (const [x, y] of [
      [1, 0],
      [2, 1],
      [1, 2],
      [0, 1],
    ] as const) {
      setTile(paved, x, y, TileCode.PAVING);
    }
    expect(loneTreeGroundCode(paved, 1, 1), 'the fixture did not pave the tree in').toBe(
      TileCode.PAVING,
    );
    const noGround = cell(paved, 1, 1, 'common', (id) => /^tile_local_paving/.test(id));
    expect(
      noGround.ids.some((id) => CANOPY.test(id)),
      'the tree was stood on nothing at all',
    ).toBe(true);
    expect(
      noGround.ids.some((id) => SINGLE.test(id)),
      'the overlay was drawn anyway',
    ).toBe(false);
  });

  it('is a local answer only — a world map still draws a wood', () => {
    // At world scale a TREES cell IS a wood, `TILE_SPRITES` draws it that way,
    // and the rim that outlines the range and the coast outlines it too.
    const level = levelOf(6, 5, TileCode.GREEN);
    setTile(level, 1, 1, TileCode.TREES);
    const overworld = cell(level, 1, 1, 'overworld');
    expect(overworld.ids).toHaveLength(1);
    expect(overworld.ids[0]).toMatch(/^tile_ow_trees(?:_[b-h])?$/);
    expect(overworld.rects.length).toBeGreaterThan(0);
  });
});

describe('every lone tree in an authored settlement', () => {
  const settlements = [...SITES.keys()].filter((id) => makeSettlementMap(id) !== undefined);

  it('stands on ground the town actually has art for', () => {
    let lone = 0;
    const grounds = new Set<TileCode>();
    const faults: string[] = [];
    for (const siteId of settlements) {
      const map = makeSettlementMap(siteId);
      if (map === undefined) continue;
      const { view } = map;
      for (let y = 0; y < view.h; y += 1) {
        for (let x = 0; x < view.w; x += 1) {
          if (!isLoneTree(view, x, y)) continue;
          lone += 1;
          const ground = loneTreeGroundCode(view, x, y);
          grounds.add(ground);
          const where = `${siteId} (${String(x)},${String(y)})`;
          if (!isWalkable(ground))
            faults.push(`${where} stands on blocking code ${String(ground)}`);
          if (LOCAL_TILE_SPRITES[ground] === undefined) {
            faults.push(`${where} stands on code ${String(ground)}, which has no local ground`);
          }
        }
      }
    }
    // THE CONTROL: a scan that found no lone tree passes the fault list forever.
    expect(settlements.length).toBeGreaterThanOrEqual(5);
    expect(lone).toBeGreaterThan(10);
    expect(faults).toEqual([]);
    // And it is the outdoors they stand on. FLOOR here would mean a tree
    // planted inside a building, which is a map fault rather than an art one.
    expect(grounds.has(TileCode.FLOOR)).toBe(false);
    expect(grounds.has(TileCode.GREEN) || grounds.has(TileCode.HEATH)).toBe(true);
  });
});
