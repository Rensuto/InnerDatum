/// <reference lib="dom" />

import { describe, expect, it } from 'vitest';

import { BlitAnchor, blitReduced } from '../../src/client/ui/panel.ts';
import type { SpriteSource } from '../../src/client/render/assets.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE SAME BUG IN THREE PLACES: A FACE CROPPED INTO A BOX TOO SMALL FOR IT.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The party pane kept the bottom 24x32 of a token, the class picker centre-
 * cropped a portrait into a narrow card, and the turn card did the same into
 * 32x32. All three were reported as the character being cut off.
 *
 * `blitReduced` shrinks by a WHOLE FACTOR or refuses. The refusal is the part
 * worth testing: cropping looks almost right, which is how this survived in
 * three surfaces at once, and "almost right" is what a fallback exists to
 * replace with something honestly worse.
 *
 * `reference lib="dom"` on line 1 because tests compile under the server
 * tsconfig, whose `lib` has no DOM — without it `CanvasRenderingContext2D`
 * does not resolve and typecheck, the first link in the gate's && chain, is red.
 */

type Call = readonly unknown[];

function recorder(): { ctx: CanvasRenderingContext2D; calls: Call[] } {
  const calls: Call[] = [];
  const ctx = new Proxy(
    {},
    {
      get: (_t, prop: string) =>
        prop === 'drawImage'
          ? (...args: unknown[]) => {
              calls.push(args);
            }
          : () => undefined,
      set: () => true,
    },
  ) as unknown as CanvasRenderingContext2D;
  return { ctx, calls };
}

/** A library that answers one id at one authored size, and nothing else. */
function library(id: string, w: number, h: number): SpriteSource {
  return {
    sprite: (key: string) =>
      key === id ? { image: {} as unknown as HTMLImageElement, w, h } : undefined,
  } as unknown as SpriteSource;
}

const BOX = (w: number, h: number) => ({ x: 10, y: 20, w, h });

describe('blitReduced', () => {
  it('draws 1:1 when the sprite already fits', () => {
    const { ctx, calls } = recorder();
    expect(blitReduced(ctx, library('tok', 24, 32), 'tok', BOX(24, 32))).toBe(true);
    // FIVE ARGUMENTS. There is no source rectangle, so there is no crop — the
    // call shape itself is the contract.
    expect(calls[0]).toHaveLength(5);
    expect(calls[0]?.slice(3)).toEqual([24, 32]);
  });

  it('halves a 64x64 face into a 32x32 box rather than showing a nose', () => {
    const { ctx, calls } = recorder();
    expect(blitReduced(ctx, library('face', 64, 64), 'face', BOX(32, 32))).toBe(true);
    expect(calls[0]).toHaveLength(5);
    expect(calls[0]?.slice(3)).toEqual([32, 32]);
  });

  it('halves a 48x64 token to 24x32, which is what the party row always wanted', () => {
    const { ctx, calls } = recorder();
    expect(blitReduced(ctx, library('tok', 48, 64), 'tok', BOX(32, 32))).toBe(true);
    expect(calls[0]?.slice(3)).toEqual([24, 32]);
  });

  it('refuses when no whole divisor fits, so the caller can say so in letters', () => {
    // 64x64 into 24x32 needs d = 2.67. A fractional reduction drops rows
    // unevenly with smoothing off, and a crop is the bug this replaced.
    const { ctx, calls } = recorder();
    expect(blitReduced(ctx, library('face', 64, 64), 'face', BOX(24, 32))).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('stops at a half unless the caller asks for more', () => {
    // A 64x64 face at d = 4 is a 16px smudge; a card that small should show
    // letters. The talent chips are the one caller that genuinely wants 4.
    const lib = library('icon', 64, 64);
    expect(blitReduced(recorder().ctx, lib, 'icon', BOX(16, 16))).toBe(false);

    const deep = recorder();
    expect(blitReduced(deep.ctx, lib, 'icon', BOX(16, 16), BlitAnchor.Centre, 4)).toBe(true);
    expect(deep.calls[0]?.slice(3)).toEqual([16, 16]);
  });

  it('sits a short result on the floor of its box when bottom-anchored', () => {
    // A silhouette is read from its feet up. 48x64 halves to 24x32 inside a
    // 32x32 box, so the anchor decides where the 24 sits horizontally and the
    // 32 vertically — here they are flush.
    const bottom = recorder();
    blitReduced(bottom.ctx, library('tok', 48, 48), 'tok', BOX(32, 32), BlitAnchor.Bottom);
    const centre = recorder();
    blitReduced(centre.ctx, library('tok', 48, 48), 'tok', BOX(32, 32), BlitAnchor.Centre);
    // 24 tall in a 32 box: bottom puts it at y+8, centre at y+4.
    expect(bottom.calls[0]?.[2]).toBe(20 + 8);
    expect(centre.calls[0]?.[2]).toBe(20 + 4);
  });

  it('refuses a missing sprite instead of drawing a blank', () => {
    const { ctx, calls } = recorder();
    expect(blitReduced(ctx, library('other', 64, 64), 'absent', BOX(32, 32))).toBe(false);
    expect(calls).toHaveLength(0);
  });
});
