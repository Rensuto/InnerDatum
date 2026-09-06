// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

import { describe, expect, it } from 'vitest';

import { RESOURCE_H, drawResource, resourceStripH } from '../../src/client/ui/resource.ts';
import { ResourceKind } from '../../src/shared/protocol.ts';
import type { ResourceView } from '../../src/shared/protocol.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *   THE ROW HAS TO FIT THE COLUMN IT IS GIVEN, NOT THE ONE IT WAS WRITTEN FOR.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `drawResource` was written for the full-width strip along the bottom of the
 * screen, where its pips, two budget rows and a label are nothing. Then the
 * viewer's pools moved into the party pane, which is 208 wide and hands it 187.
 *
 * Reported with a screenshot: *"it looks like the MP is cut off in the player
 * hud"* — the `MP` label drawn and no blocks after it, because every element
 * shares one cursor and the ones at the end run out of row.
 *
 * ═══ THIS FILE DID NOT EXIST ═══
 * The strip's output was pinned only by source-text greps in `hudwiring.test.ts`
 * — which is to say the drawing was not pinned at all. It is a recorder context
 * here: vitest runs in `node` with no jsdom, so the only honest test is what
 * calls the painter makes.
 */

const ALCHEMIST: ResourceView = {
  kind: ResourceKind.Reagents,
  current: 3,
  max: 8,
  discrete: true,
  ap: 4,
  maxAp: 6,
  mp: 2,
  maxMp: 3,
};

/** What the party pane actually hands it: 208 wide, less the insets and token. */
const PANE_W = 187;
/** The bottom strip, which has never been short of room. */
const BAR_W = 600;

type Painted = {
  readonly texts: readonly string[];
  /** Every `fillRect`, so the budget BLOCKS can be counted apart from the pips. */
  readonly rects: readonly { x: number; y: number; w: number; h: number }[];
};

function paint(width: number, stacked: boolean, resource: ResourceView = ALCHEMIST): Painted {
  const texts: string[] = [];
  const rects: { x: number; y: number; w: number; h: number }[] = [];
  const ctx = new Proxy(
    {},
    {
      get: (_target, prop: string) => {
        if (prop === 'measureText') return (t: string) => ({ width: t.length * 6 });
        if (prop === 'fillText')
          return (t: string) => {
            texts.push(t);
          };
        if (prop === 'fillRect')
          return (x: number, y: number, w: number, h: number) => {
            rects.push({ x, y, w, h });
          };
        if (prop === 'canvas') return undefined;
        return () => {};
      },
      set: () => true,
    },
  ) as unknown as CanvasRenderingContext2D;

  drawResource({ ctx, sprites: { sprite: () => undefined }, resource, x: 0, y: 0, width, stacked });
  return { texts, rects };
}

/** The budget blocks are the only 4-pixel-wide rects the painter draws. */
function blocks(painted: Painted): number {
  return painted.rects.filter((r) => r.w === 4).length;
}

describe('the resource row in a narrow column', () => {
  /**
   * THE BUG, STATED AS A MEASUREMENT. Nine blocks are authored — six AP and
   * three MP — and on one line in 187 pixels the row does not reach them all.
   */
  it('cannot draw both budgets on one line at pane width', () => {
    expect(blocks(paint(BAR_W, false)), 'the wide strip should draw all nine').toBe(9);
    expect(
      blocks(paint(PANE_W, false)),
      'a flat row at pane width somehow fitted every block — the bug is unreproducible',
    ).toBeLessThan(9);
  });

  /** AND THE FIX: the same nine, in the same width, on two lines. */
  it('draws every block at pane width once it is stacked', () => {
    expect(blocks(paint(PANE_W, true)), 'MP is still being cut off').toBe(9);
  });

  it('still names both budgets and the pool', () => {
    const { texts } = paint(PANE_W, true);
    expect(texts, 'the AP label went missing').toContain('AP');
    expect(texts, 'the MP label went missing').toContain('MP');
    expect(texts, 'the pool lost its name').toContain('Reagents');
  });

  /**
   * THE SECOND LINE IS BELOW THE FIRST, which is the whole of "stacked" and is
   * worth an assertion because drawing it at the same `y` would look like the
   * budgets had simply vanished under the pips.
   */
  it('puts the budgets on a line of their own', () => {
    const flat = paint(BAR_W, false).rects.filter((r) => r.w === 4);
    const two = paint(PANE_W, true).rects.filter((r) => r.w === 4);
    const flatY = Math.min(...flat.map((r) => r.y));
    const stackedY = Math.min(...two.map((r) => r.y));
    expect(stackedY, 'the budgets are still on the first line').toBeGreaterThan(flatY);
  });

  it('reserves the taller box for the stacked shape', () => {
    expect(resourceStripH(false)).toBe(RESOURCE_H);
    expect(
      resourceStripH(true),
      'the stacked strip claims the same height as the flat one, so it will clip',
    ).toBeGreaterThan(resourceStripH(false));
  });

  /**
   * A POOL WITH NO BUDGETS ON THE WIRE IS AN OLDER SERVER, not a budget of
   * zero — `ResourceView.ap` is optional so adding it forced no version bump.
   * The stacked shape must not draw an empty second line for it.
   */
  it('draws no blocks at all when the server sends no budgets', () => {
    const old: ResourceView = { kind: ResourceKind.Reagents, current: 3, max: 8, discrete: true };
    expect(blocks(paint(PANE_W, true))).toBeGreaterThan(0);
    expect(blocks(paint(PANE_W, true, old)), 'blocks were invented for an old server').toBe(0);
  });
});
