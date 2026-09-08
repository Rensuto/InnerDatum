// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/modules/tome/class/Actor.lua:1025-1043
// (`smallTacticalFrame`, the under-the-model branch).
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
  it('fills from the left, anchored, like every bar in the game', () => {
    /**
     * Upstream's own direction for THIS shape: `drawQuad(x + sx, y + sy,
     * dx * lp, dy, ...)` at Actor.lua:1034 — the width scales and the left edge
     * does not move. The SIDE bar this replaced drained upward instead
     * (`y + sy + dy * (1-lp)`, :948), which is right for a vertical vessel and
     * meaningless for a horizontal one.
     */
    const full = lifeBar(10, 10, 0, 0);
    const half = lifeBar(5, 10, 0, 0);

    expect(full.fillW).toBe(full.w);
    expect(half.fillW).toBe(Math.round(full.w / 2));
    expect(half.x, 'a half bar moved its left edge').toBe(full.x);
    expect(half.y, 'a half bar changed height').toBe(full.y);
    expect(half.h).toBe(full.h);
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
    expect(sliver.fillW).toBe(1);
    expect(Math.round(sliver.w * (1 / 200)), 'the fixture is not exercising the clamp').toBe(0);
  });

  it('draws nothing at all for a body with no life left', () => {
    // Distinct from the sliver above: 0 is empty, and empty is honest.
    expect(lifeBar(0, 200, 0, 0).fillW).toBe(0);
    expect(lifeBar(-5, 200, 0, 0).fillW).toBe(0);
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
      expect(bar.fillW, `${String(hp)}/${String(maxHp)} overflowed`).toBeLessThanOrEqual(bar.w);
      expect(bar.fillW).toBeGreaterThanOrEqual(0);
    }
  });

  it('turns at the same third every other readout turns at', () => {
    /**
     * `shared/vitals.ts` holds the one threshold, and its own header argues why:
     * two health readouts that disagreed about when a body is in trouble would
     * be worse than one. This is the fourth surface to ask.
     */
    expect(lifeBar(34, 100, 0, 0).low).toBe(false);
    expect(lifeBar(33, 100, 0, 0).low).toBe(true);
    expect(lifeBar(1, 3, 0, 0).low, 'exactly a third is trouble').toBe(true);
    expect(HP_LOW).toBe(1 / 3);
  });

  it('sits under the model, along the bottom of its own tile', () => {
    /**
     * The four ratios are upstream's verbatim (Actor.lua:1026-1029), so this
     * asserts what they COME TO on a 64-pixel tile rather than restating them:
     * a 53x3 bar at (+5, +60). A bar that drifted up would be over the sprite's
     * knees, and one that drifted down would be on the tile below.
     */
    const bar = lifeBar(7, 10, 64, 96);
    expect(bar.x, 'the bar left its tile').toBeGreaterThanOrEqual(64);
    expect(bar.x + bar.w, 'the bar overran its tile').toBeLessThanOrEqual(64 + TILE_PX);
    // IN THE BOTTOM EIGHTH, which is the strip a bottom-centred sprite leaves.
    expect(bar.y, 'the bar rode up onto the model').toBeGreaterThanOrEqual(
      96 + TILE_PX - TILE_PX / 8,
    );
    expect(bar.y + bar.h, 'the bar spilled onto the tile below').toBeLessThanOrEqual(96 + TILE_PX);
    // WIDE ENOUGH TO READ. The complaint about the old one was that a
    // two-pixel sliver is findable only if you know it is there.
    expect(bar.w, 'the bar is not wide enough to be seen').toBeGreaterThan(TILE_PX / 2);
  });

  it('has an outline one pixel proud on every side', () => {
    /**
     * NOT UPSTREAM'S. ToME contrasts a 255-alpha fill against a 128-alpha
     * backing in the same hue, which reads because its tileset is uniformly
     * dark. Ours runs from near-black flagstone to pale sand, and a gold bar
     * three pixels tall on sand is a smudge.
     */
    const bar = lifeBar(7, 10, 64, 96);
    expect(bar.outline.x).toBe(bar.x - 1);
    expect(bar.outline.y).toBe(bar.y - 1);
    expect(bar.outline.w).toBe(bar.w + 2);
    expect(bar.outline.h).toBe(bar.h + 2);
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

  it('paints the outline, the backing and the fill — in that order', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE GEOMETRY BEING RIGHT PROVES NOTHING ABOUT THE PIXELS.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `lifeBar` returns an `outline` rect and the tests above check its
     * arithmetic — and DELETING THE FILLRECT THAT DRAWS IT left every one of
     * them green. A pure function cannot see whether anybody paints what it
     * returns, which is the same "computed correctly and dropped by the layer
     * above" this file's other half exists to catch.
     *
     * ORDER MATTERS AS MUCH AS PRESENCE. Outside in: the outline is painted
     * first and the backing over it, so what survives is one dark pixel of
     * border. Reverse them and the outline covers the bar entirely.
     */
    const painter = SOURCE.slice(SOURCE.indexOf('function paintLifeBar('));
    // Up to the NEXT function, which is the painter's whole body and nothing
    // after it. Slicing on a brace would need an escape, and this file has
    // already lost one to a shell heredoc.
    const body = painter.slice(0, painter.indexOf('function paintStatusPips'));

    const outline = body.indexOf('bar.outline.x');
    const backing = body.indexOf('bar.x, bar.y, bar.w, bar.h');
    const fill = body.indexOf('bar.fillW');
    expect(outline, 'nothing paints the outline').toBeGreaterThan(-1);
    expect(backing, 'nothing paints the backing').toBeGreaterThan(-1);
    expect(fill, 'nothing paints the fill').toBeGreaterThan(-1);
    expect(outline, 'the backing is painted before the outline it must sit on').toBeLessThan(
      backing,
    );
    expect(backing, 'the fill is painted before the backing that would cover it').toBeLessThan(
      fill,
    );

    // AND THE TWO DARKS ARE DIFFERENT COLOURS. Same-coloured outline and
    // backing fuse into one block: no edge, and no readable empty portion.
    expect(body).toContain('PALETTE.INK');
    expect(body).toContain('PALETTE.SLATE');
  });
});
