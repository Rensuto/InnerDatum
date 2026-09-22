// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

import { describe, expect, it } from 'vitest';

import { createTargeting } from '../../../src/client/input/targeting.ts';
import { MarkerKind } from '../../../src/client/render/canvas.ts';
import { aimedBallTiles } from '../../../src/server/engine/talents.ts';
import { blocksSightAt } from '../../../src/shared/level.ts';
import { TalentShape, TileCode } from '../../../src/shared/protocol.ts';
import type { LevelView, LoadoutTalent } from '../../../src/shared/protocol.ts';
import type { TileXY } from '../../../src/shared/coords.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE BALL PREVIEW IS THE BALL THE SERVER RESOLVES — ToME's DISC.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `stampTiles` drew its Ball from a private exact-Euclid loop, so radius 1
 * previewed the five-tile plus and radius 2 thirteen tiles. The server's
 * `ballTiles` is `shared/ball.ts`'s now — `discTiles`'s `dx^2 + dy^2 <= r^2 +
 * r` (the whole 3x3 at radius 1, the 5x5 less its corners at radius 2) cut by
 * the walls libfov's `calc_circle` stops at, laid from where the ball stops
 * (`ballCentre`) — and the preview calls the same functions on the same map.
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

/** The open level with `code` laid at each offset from `AIM`. */
function levelWith(code: TileCode, offsets: readonly (readonly [number, number])[]): LevelView {
  const level = openLevel();
  for (const [dx, dy] of offsets) level.tiles[(AIM.y + dy) * W + (AIM.x + dx)] = code;
  return level;
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
function stamp(radius: number, level: LevelView = openLevel()): string[] {
  return stampFrom(radius, level, ORIGIN);
}

/** The same, cast from `origin`. Offsets are still from `AIM`. */
function stampFrom(radius: number, level: LevelView, origin: TileXY): string[] {
  const targeting = createTargeting({ onChange: () => {}, onCommit: () => {} });
  expect(targeting.begin(ball(radius), { level, origin })).toBe(true);
  targeting.hover(AIM);
  return targeting
    .cells()
    .filter((cell) => cell.marker === MarkerKind.Aoe)
    .map((cell) => `${String(cell.x - AIM.x)},${String(cell.y - AIM.y)}`);
}

/**
 * The server's list for the same cast, `aimedBallTiles` (the call Expunge,
 * Scattershot and Clear the Altar make), less what `cells()` declines to
 * paint: a tile that blocks sight.
 */
function serverTiles(radius: number, level: LevelView, origin: TileXY): string[] {
  return aimedBallTiles({ level }, origin, AIM, radius)
    .filter((t) => !blocksSightAt(level, t.x, t.y))
    .map((t) => `${String(t.x - AIM.x)},${String(t.y - AIM.y)}`);
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

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * AND IT STOPS AT A WALL, AS THE SERVER'S DOES — `block_radius`.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The server's ball shadowcasts over the level with `blocksProjection`
 * (`shared/ball.ts`, `engine/Target.lua:518-565`), and the preview calls the
 * same function on the map the client holds. It was the bare disc, which drew
 * a radius-2 ball straight through a wall the server's stops at: the one place
 * a preview can lie is the tile a player aims past a pillar at.
 *
 * libfov's fixture C (test/shared/mapgen/fovcircle.test.ts): a wall at (1,0)
 * hides (2,0) at radius 2 and nothing else. The wall's own face is reached and
 * is not painted — `cells()` skips a wall inside a stamp — so the stamp is 19.
 */
describe('the Ball stamp on a walled level', () => {
  it('leaves out the tile behind a wall, and only that tile', () => {
    // prettier-ignore
    const nineteen = [
               '-1,-2', '0,-2', '1,-2',
      '-2,-1', '-1,-1', '0,-1', '1,-1', '2,-1',
      '-2,0',  '-1,0',  '0,0',
      '-2,1',  '-1,1',  '0,1',  '1,1',  '2,1',
               '-1,2',  '0,2',  '1,2',
    ];
    expect(stamp(2, levelWith(TileCode.WALL, [[1, 0]]))).toEqual(nineteen);
  });

  it('crosses lava, which stops a cloud but not a thrown ball', () => {
    // Lava blocks movement and carries `pass_projectile` (terrain.ts), so a
    // projected ball's `block_radius` lets it through; the whole disc is drawn,
    // the lava tile included, since nothing about it hides it from the eye.
    const whole = stamp(2);
    expect(stamp(2, levelWith(TileCode.MOLTEN_LAVA, [[1, 0]]))).toEqual(whole);
  });

  it('is the tile list the server resolves, on the same map', () => {
    /**
     * THE JOIN (L2): the client's stamp and the server's `aimedBallTiles` on
     * one level, minus only what `cells()` declines to paint (a wall face).
     * Radius 3, libfov's fixture C3, so the shadow is two tiles deep.
     *
     * AND LAVA BELOW THE AIM, because a wall cannot tell the two block
     * functions apart: masonry stops a projectile and a body alike. Lava stops
     * only the body (terrain.ts `PASS_PROJECTILE`), so a talent's ball crosses
     * it and a cloud's does not. Asked with `blocksMove`, either side would
     * lose (0,2) and (0,3) behind it — the client side breaks the join, and
     * the server side breaks the join and the two names below.
     */
    const level = levelWith(TileCode.WALL, [[1, 0]]);
    level.tiles[(AIM.y + 1) * W + AIM.x] = TileCode.MOLTEN_LAVA;
    const server = serverTiles(3, level, ORIGIN);
    expect(stamp(3, level)).toEqual(server);
    // And the shadow is really there, by name: the open disc is 37, less the
    // wall's face and the two tiles behind it.
    expect(server).not.toContain('2,0');
    expect(server).not.toContain('3,0');
    expect(server).toContain('3,1');
    // The lava hides nothing from a thrown ball, and is painted itself.
    expect(server).toContain('0,1');
    expect(server).toContain('0,2');
    expect(server).toContain('0,3');
    expect(server).toHaveLength(34);
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * AIMED AT A WALL, THE STAMP IS CENTRED WHERE THE SERVER'S BALL GOES OFF.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The server lays a ball aimed at a wall from the last open tile before it on
 * the line from the caster, or from the caster when the wall is the first step
 * (`ballCentre`, shared/ball.ts; `engine/interface/ActorProject.lua:66-114`).
 * The stamp was centred on the cursor and drew the ball reaching through the
 * wall, so the one case where the preview matters most — a foe behind cover —
 * showed him caught. Radius 1, Expunge's and Scattershot's.
 *
 * A wall down the aim's column. Offsets are from the aim, so the far side is
 * `1,*` and the near side `-1,*` and `-2,*`.
 */
describe('the Ball stamp aimed at a wall', () => {
  const column = (): LevelView =>
    levelWith(
      TileCode.WALL,
      [-3, -2, -1, 0, 1, 2, 3].map((dy) => [0, dy] as const),
    );

  it('from three tiles, is the server`s ball on the tile before the wall', () => {
    const level = column();
    const server = serverTiles(1, level, ORIGIN);
    expect(stampFrom(1, level, ORIGIN)).toEqual(server);
    // prettier-ignore
    expect(server).toEqual([
      '-2,-1', '-1,-1',
      '-2,0',  '-1,0',
      '-2,1',  '-1,1',
    ]);
  });

  it('from beside it, is the server`s ball on the caster', () => {
    // On the aim's diagonal, so the ball on the caster is a row higher than
    // the one above and cannot be mistaken for it.
    const level = column();
    const beside = { x: AIM.x - 1, y: AIM.y - 1 };
    const server = serverTiles(1, level, beside);
    expect(stampFrom(1, level, beside)).toEqual(server);
    // prettier-ignore
    expect(server).toEqual([
      '-2,-2', '-1,-2',
      '-2,-1', '-1,-1',
      '-2,0',  '-1,0',
    ]);
  });
});
