// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

import { describe, expect, it } from 'vitest';

import { createFog, fogCount, fogHas } from '../../src/shared/fog.ts';
import { TileCode } from '../../src/shared/protocol.ts';
import { canSee } from '../../src/shared/sight.ts';
import { computeSeen, rememberSeen } from '../../src/shared/vision.ts';
import type { LevelView } from '../../src/shared/protocol.ts';

/**
 * A 21x21 floor with a short wall and a strip of water, both near the eye.
 * WALL blocks sight; WATER does not. So the property test below exercises both
 * halves of `canSee`: range, and a line that walls break and water does not.
 */
function fixture(): LevelView {
  const w = 21;
  const h = 21;
  const tiles = new Array<number>(w * h).fill(TileCode.FLOOR);
  const put = (x: number, y: number, code: number): void => {
    tiles[y * w + x] = code;
  };
  for (let y = 8; y <= 12; y += 1) put(13, y, TileCode.WALL);
  for (let y = 8; y <= 12; y += 1) put(7, y, TileCode.WATER);
  return { w, h, tiles };
}

const EYE = { x: 10, y: 10 };
const RADIUS = 6;

describe('computeSeen', () => {
  it('marks exactly the tiles canSee answers yes for, over the whole level', () => {
    // THE PROPERTY: one visibility rule. Any tile where the bitset and `canSee`
    // disagree is a second rule, which is the thing this module exists to avoid.
    const level = fixture();
    const seen = computeSeen(level, EYE, RADIUS);
    for (let y = 0; y < level.h; y += 1) {
      for (let x = 0; x < level.w; x += 1) {
        expect(fogHas(seen, level.w, x, y), `tile ${String(x)},${String(y)}`).toBe(
          canSee(level, EYE, { x, y }, RADIUS),
        );
      }
    }
  });

  it('uses straight-line distance, so the radius is a circle and not a square', () => {
    // THE PROPERTY CANNOT CATCH THIS ONE: it compares against `canSee`, which
    // would move with any change to the distance. So it is pinned by value.
    // Straight out at the radius is in sight; the diagonal corner at the same
    // radius is about 8.5 tiles away and is not.
    const level = fixture();
    const seen = computeSeen(level, EYE, RADIUS);
    expect(fogHas(seen, level.w, EYE.x, EYE.y - RADIUS)).toBe(true);
    expect(fogHas(seen, level.w, EYE.x - RADIUS, EYE.y - RADIUS)).toBe(false);
    expect(fogHas(seen, level.w, EYE.x, EYE.y - RADIUS - 1), 'one past the radius').toBe(false);
  });

  it('hides what is behind a wall and shows what is across water', () => {
    const level = fixture();
    const seen = computeSeen(level, EYE, RADIUS);
    // The wall itself is seen, as upstream sees the grid that blocks the sweep.
    expect(fogHas(seen, level.w, 13, 10)).toBe(true);
    expect(fogHas(seen, level.w, 15, 10), 'behind the wall').toBe(false);
    expect(fogHas(seen, level.w, 5, 10), 'across the water').toBe(true);
  });

  it('always sees its own tile, even at radius 1', () => {
    const level = fixture();
    const seen = computeSeen(level, EYE, 1);
    expect(fogHas(seen, level.w, EYE.x, EYE.y)).toBe(true);
    expect(fogHas(seen, level.w, EYE.x + 1, EYE.y)).toBe(true);
    expect(fogHas(seen, level.w, EYE.x + 2, EYE.y)).toBe(false);
  });
});

describe('rememberSeen', () => {
  it('keeps everything seen so far, and says whether this sight added anything', () => {
    const level = fixture();
    const remembered = createFog(level.w, level.h);
    const here = computeSeen(level, EYE, RADIUS);

    expect(rememberSeen(remembered, here), 'the first sight remembered nothing').toBe(true);
    expect(fogCount(remembered)).toBe(fogCount(here));

    // STANDING STILL ADDS NOTHING, which is what lets a caller skip a save.
    expect(rememberSeen(remembered, computeSeen(level, EYE, RADIUS))).toBe(false);

    // A STEP AWAY ADDS THE NEW GROUND AND FORGETS NOTHING.
    const there = computeSeen(level, { x: 4, y: 4 }, RADIUS);
    expect(rememberSeen(remembered, there)).toBe(true);
    for (let y = 0; y < level.h; y += 1) {
      for (let x = 0; x < level.w; x += 1) {
        const either = fogHas(here, level.w, x, y) || fogHas(there, level.w, x, y);
        expect(fogHas(remembered, level.w, x, y), `tile ${String(x)},${String(y)}`).toBe(either);
      }
    }
  });

  it('refuses to fold a bitset from a different-sized level', () => {
    expect(() => rememberSeen(createFog(21, 21), createFog(20, 20))).toThrow(/different levels/);
  });
});
