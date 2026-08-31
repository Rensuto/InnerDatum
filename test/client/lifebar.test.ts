// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/modules/tome/class/Actor.lua:931-961
// (`smallTacticalFrame`).
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { lifeBar } from '../../src/client/render/canvas.ts';
import { TILE_PX } from '../../src/shared/version.ts';
import { HP_LOW } from '../../src/shared/vitals.ts';

describe('the life bar on a creature token', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * WHAT IT COSTS WITHOUT IT.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Standing in a room with six husks, nobody in the voice channel can see which
   * one is a single hit from dying. Focus fire is the decision co-op turn-based
   * combat is actually about, and before this it had to be reconstructed from
   * log text or by hovering each token in turn — which nobody does mid-fight.
   */
  it('fills from the bottom, like a draining vessel', () => {
    // Upstream's own direction: `y + sy + dy * (1 - lp)` (Actor.lua:948).
    const full = lifeBar(10, 10, 0, 0);
    const half = lifeBar(5, 10, 0, 0);

    expect(full.fillH).toBe(full.h);
    expect(full.fillY, 'a full bar starts at the top of its backing').toBe(full.y);

    expect(half.fillH).toBe(Math.round(full.h / 2));
    expect(half.fillY, 'a half bar hangs from the bottom').toBe(half.y + half.h - half.fillH);
    expect(half.fillY + half.fillH, 'both bars share a floor').toBe(full.y + full.h);
  });

  it('keeps a pixel for anything still standing', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE ONE THING IT MUST NEVER SAY WRONGLY.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * A husk on 1 of 200 rounds to zero pixels. An empty bar over something
     * still standing reads as "already dead", which is the difference between
     * walking past it and turning your back on it.
     */
    const sliver = lifeBar(1, 200, 0, 0);
    expect(sliver.fillH).toBe(1);
    expect(Math.round(sliver.h * (1 / 200)), 'the fixture is not exercising the clamp').toBe(0);
  });

  it('draws nothing at all for a body with no life left', () => {
    // Distinct from the sliver above: 0 is empty, and empty is honest.
    expect(lifeBar(0, 200, 0, 0).fillH).toBe(0);
    expect(lifeBar(-5, 200, 0, 0).fillH).toBe(0);
  });

  it('never overflows its backing, however the numbers arrive', () => {
    // A heal past maximum, and a maximum of zero — both reach this from real
    // frames, and a fill taller than its backing paints over the tile above.
    for (const [hp, maxHp] of [
      [120, 100],
      [5, 0],
      [1, 1],
      [Number.NaN, 10],
    ] as const) {
      const bar = lifeBar(hp, maxHp, 0, 0);
      expect(bar.fillH, `${String(hp)}/${String(maxHp)} overflowed`).toBeLessThanOrEqual(bar.h);
      expect(bar.fillH).toBeGreaterThanOrEqual(0);
      expect(bar.fillY).toBeGreaterThanOrEqual(bar.y);
    }
  });

  it('turns at the same third every other readout turns at', () => {
    /**
     * `shared/vitals.ts` holds the one threshold, and `ui/life.ts` argues why:
     * two health readouts that disagreed about when a body is in trouble would
     * be worse than one. This is the fourth surface to ask.
     */
    expect(lifeBar(34, 100, 0, 0).low).toBe(false);
    expect(lifeBar(33, 100, 0, 0).low).toBe(true);
    expect(lifeBar(1, 3, 0, 0).low, 'exactly a third is trouble').toBe(true);
    expect(HP_LOW).toBe(1 / 3);
  });

  it('sits inside its own tile, on the left, clear of the pip column', () => {
    /**
     * Upstream puts the bar on the left for friends and the right for foes
     * (`if friend < 0 then sx = w * .9375`) because the side is its only faction
     * signal. Ours is always LEFT: the token ring already says ally, hostile or
     * elite, and the right edge is the status-pip column.
     */
    const bar = lifeBar(7, 10, 64, 96);
    expect(bar.x, 'the bar left its tile').toBeGreaterThanOrEqual(64);
    expect(bar.x + bar.w, 'the bar reached the pip column').toBeLessThan(64 + TILE_PX / 2);
    expect(bar.y).toBeGreaterThanOrEqual(96);
    expect(bar.y + bar.h, 'the bar spilled onto the tile below').toBeLessThanOrEqual(96 + TILE_PX);
  });
});

describe('the life bar is actually painted', () => {
  /**
   * `lifeBar` is pure and cannot see whether anything calls it — which is how a
   * feature ships dead. This project has done it before: a value computed
   * correctly and dropped by the mapper above it.
   */
  const SOURCE = readFileSync('src/client/render/canvas.ts', 'utf8');

  it('paints one for every actor on screen, in its own pass', () => {
    expect(SOURCE, 'nothing calls the painter').toMatch(
      /if \(visible\(cellX, cellY\)\) paintLifeBar\(/,
    );
    // ITS OWN PASS, not a tail on the sprite loop: interleaved, the bar of an
    // actor standing behind is painted over by the boots of the one in front,
    // and a bar you cannot see reads as "that one is fine".
    const sprites = SOURCE.indexOf('if (visible(cellX, cellY)) blitSprite(');
    const bars = SOURCE.indexOf('if (visible(cellX, cellY)) paintLifeBar(');
    expect(sprites).toBeGreaterThan(-1);
    expect(bars, 'the bars are painted before the sprites that would cover them').toBeGreaterThan(
      sprites,
    );
  });
});
