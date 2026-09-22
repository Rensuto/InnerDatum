// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

import { describe, expect, it } from 'vitest';

import { createTargeting } from '../../../src/client/input/targeting.ts';
import { MarkerKind } from '../../../src/client/render/canvas.ts';
import { TalentShape, TileCode } from '../../../src/shared/protocol.ts';
import type { LevelView, LoadoutTalent } from '../../../src/shared/protocol.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE BALL PREVIEW IS THE BALL THE SERVER RESOLVES — ToME's DISC.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `stampTiles` drew its Ball from a private exact-Euclid loop, so radius 1
 * previewed the five-tile plus and radius 2 thirteen tiles. The server's
 * `ballTiles` is `shared/distance.ts`'s `discTiles` now — `dx^2 + dy^2 <=
 * r^2 + r`, the whole 3x3 at radius 1 and the 5x5 less its corners at radius 2
 * — and the preview calls the same function on the same `radius`.
 *
 * HAND-LISTED, NOT RECOMPUTED. A test that built its expectation with
 * `discTiles` would pass whatever `discTiles` did; these lists are the shapes
 * written out, so the function and the picture are checked against a third
 * thing.
 *
 * Read through `createTargeting` on an open level, the way the renderer reads
 * it: the `Aoe` cells of `cells()`, as offsets from the aimed tile.
 */

const W = 21;
const H = 21;
const ORIGIN = { x: 10, y: 10 } as const;
const AIM = { x: 13, y: 10 } as const;

function openLevel(): LevelView {
  return { w: W, h: H, tiles: new Array<number>(W * H).fill(TileCode.PLAINS) };
}

function ball(radius: number): LoadoutTalent {
  return {
    id: 'test_ball',
    name: 'Test Ball',
    icon: 'icon_talent_revolver_shot',
    shape: TalentShape.Ball,
    range: 5,
    minRange: 0,
    radius,
    apCost: 1,
    mpCost: 0,
    cooldownTurns: 0,
    ready: true,
    known: true,
  } as unknown as LoadoutTalent;
}

/** Aim a ball at `AIM` and read back the stamp, in the order it was drawn. */
function stamp(radius: number): string[] {
  const targeting = createTargeting({ onChange: () => {}, onCommit: () => {} });
  expect(targeting.begin(ball(radius), { level: openLevel(), origin: ORIGIN })).toBe(true);
  targeting.hover(AIM);
  return targeting
    .cells()
    .filter((cell) => cell.marker === MarkerKind.Aoe)
    .map((cell) => `${String(cell.x - AIM.x)},${String(cell.y - AIM.y)}`);
}

describe('the Ball stamp', () => {
  it('covers all nine tiles at radius 1, diagonals included', () => {
    // prettier-ignore
    const nine = [
      '-1,-1', '0,-1', '1,-1',
      '-1,0',  '0,0',  '1,0',
      '-1,1',  '0,1',  '1,1',
    ];
    expect(stamp(1)).toEqual(nine);
  });

  it('covers twenty-one at radius 2: the 5x5 less its four corners', () => {
    // prettier-ignore
    const twentyOne = [
               '-1,-2', '0,-2', '1,-2',
      '-2,-1', '-1,-1', '0,-1', '1,-1', '2,-1',
      '-2,0',  '-1,0',  '0,0',  '1,0',  '2,0',
      '-2,1',  '-1,1',  '0,1',  '1,1',  '2,1',
               '-1,2',  '0,2',  '1,2',
    ];
    expect(stamp(2)).toEqual(twentyOne);
  });

  it('is the aimed tile alone at radius 0', () => {
    expect(stamp(0)).toEqual(['0,0']);
  });
});
