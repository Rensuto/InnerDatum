/// <reference lib="dom" />

// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createRenderer } from '../../src/client/render/canvas.ts';
import { installDom, removeDom, stubCanvas } from './canvasstub.ts';
import type { StubCanvas } from './canvasstub.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE MAP WENT BLACK, AND NOTHING IN THE RENDERER WAS WRONG.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The interface moved off the map's backbuffer onto its own, which is blitted
 * OVER the presented world. That buffer was created through the same helper as
 * the other two, and the helper hard-coded `{ alpha: false }` — right for a
 * background that repaints every pixel, catastrophic for an overlay: an opaque
 * canvas has no transparent state to clear TO, so `clearRect` leaves opaque
 * black and the blit covered the entire world.
 *
 * Reported as "black screen in game", with the whole interface drawing
 * perfectly on top of it. That is what makes it worth a test rather than a
 * fixed line: the symptom looks like the renderer has stopped drawing the map,
 * so the first guesses were all about the camera, the scale and the letterbox.
 * The map was being drawn every frame and then painted over.
 *
 * ═══ THE INVARIANT, STATED SO IT SURVIVES THE NEXT LAYER ═══
 * Anything blitted onto the visible canvas AFTER the map must be transparent.
 * This drives a real `createRenderer` over a stub `document` — the only test
 * here that constructs one — and asserts it of whatever the renderer actually
 * composites, rather than of a canvas named in advance.
 */

beforeEach(() => {
  installDom(1);
});

afterEach(() => {
  removeDom();
});

function render() {
  const visible = stubCanvas(1248, 860);
  const renderer = createRenderer({
    canvas: visible as unknown as HTMLCanvasElement,
    sprites: { sprite: () => undefined },
  });
  renderer.resize();
  return { renderer, visible };
}

describe('the interface is an overlay', () => {
  it('lets the world through everywhere it does not paint', () => {
    const { renderer, visible } = render();
    let handed: { w: number; h: number } | null = null;
    renderer.draw({
      level: null,
      actors: [],
      selfId: null,
      realmKind: null,
      hud: (_ctx, w, h) => {
        handed = { w, h };
      },
    });

    // The HUD really ran, or everything below is vacuous.
    expect(handed).not.toBeNull();

    const composited = visible.ctx?.blits.map((b) => b.source) ?? [];
    expect(composited.length, 'the map and the interface are both blitted').toBe(2);

    // Whatever went down LAST is on top of the world, and it must be
    // transparent. Asserted of the canvas the renderer actually chose rather
    // than of one named here.
    const onTop = composited[composited.length - 1] as StubCanvas | undefined;
    expect(onTop?.alpha, 'the layer over the map is opaque — it will black it out').toBe(true);
  });

  it('and the map buffer under it is still opaque', () => {
    /**
     * The other half, so the fix cannot be "make everything transparent". The
     * map and the visible canvas repaint every pixel every frame, and telling
     * the browser there is nothing behind them is free speed worth keeping.
     */
    const { renderer, visible } = render();
    renderer.draw({ level: null, actors: [], selfId: null, realmKind: null, hud: () => undefined });

    const composited = visible.ctx?.blits.map((b) => b.source) ?? [];
    const under = composited[0] as StubCanvas | undefined;
    expect(under?.alpha, 'the map backbuffer should be opaque').toBe(false);
    expect(visible.alpha, 'the visible canvas should be opaque').toBe(false);
  });

  it('hands the HUD its own box, not the map buffer', () => {
    const { renderer } = render();
    let handed = { w: 0, h: 0 };
    renderer.draw({
      level: null,
      actors: [],
      selfId: null,
      realmKind: null,
      hud: (_ctx, w, h) => {
        handed = { w, h };
      },
    });
    const m = renderer.metrics();
    expect(handed).toEqual({ w: m.hudW, h: m.hudH });
    // And on this window those are NOT the map's numbers, so a painter handed
    // the wrong pair would lay out against the wrong box.
    expect(m.hudW).not.toBe(m.logicalW);
  });
});
