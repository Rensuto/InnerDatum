// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

import { describe, expect, it } from 'vitest';

import { drawResource } from '../../src/client/ui/resource.ts';
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

function paint(width: number, resource: ResourceView = ALCHEMIST): Painted {
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

  drawResource({ ctx, sprites: { sprite: () => undefined }, resource, x: 0, y: 0, width });
  return { texts, rects };
}

/** The budget blocks are the only 4-pixel-wide rects the painter draws. */
function blocks(painted: Painted): number {
  return painted.rects.filter((r) => r.w === 4).length;
}

describe('the resource row in a narrow column', () => {
  /**
   * ═══ NO AP OR MP BLOCKS — THERE IS NO OPEN ROUND TO FUEL ═══
   * The budget rows were the open round's fuel gauge: "an empty row means the
   * turn is about to end". Every action ends the turn now, as ToME's does
   * (`actPlayer`), the AP/MP budget is retired and no frame carries it, and
   * the strip draws the class pool alone.
   *
   * (The pane drew a second, `stacked` shape for those rows; it and its test
   * that the stacked box was taller went with them.)
   */
  it('draws no budget blocks, wide or narrow', () => {
    expect(blocks(paint(BAR_W)), 'the wide strip drew budget blocks').toBe(0);
    expect(blocks(paint(PANE_W)), 'the narrow strip drew budget blocks').toBe(0);
  });

  it('names the pool and no budget', () => {
    const { texts } = paint(PANE_W);
    expect(texts, 'the pool lost its name').toContain('Reagents');
    expect(texts, 'an AP label is still drawn').not.toContain('AP');
    expect(texts, 'an MP label is still drawn').not.toContain('MP');
  });
});
