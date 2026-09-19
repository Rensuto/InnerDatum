/// <reference lib="dom" />

// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { cameraAxis, createRenderer } from '../../src/client/render/canvas.ts';
import { ActorRank } from '../../src/shared/protocol.ts';
import { TILE_PX } from '../../src/shared/version.ts';
import type { SpriteSource } from '../../src/client/render/assets.ts';
import type { ActorView, LevelView } from '../../src/shared/protocol.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE PLAYER IS IN THE MIDDLE OF THE SCREEN. ALWAYS, INCLUDING IN A CORNER.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Reported with a screenshot: *"the player character should always be centered
 * on the screen … the player is off center while exploring"*, and from the other
 * side in the same report, *"centering causes the chat box to cover the player
 * so player should be dead centered"*.
 *
 * `cameraAxis` used to clamp at the level's edge. Near a boundary that trades
 * "the player is in the middle" for "no void is on screen", and it can only ever
 * keep one of the two. The clamp is gone; out-of-bounds is drawn as the ink the
 * renderer already fills the backbuffer with.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * IT IS DRIVEN, NOT READ — WHICH IS THE POINT OF THE SECOND HALF
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The camera is a private local inside `draw`, written into `lastCamX`/
 * `lastCamY` at the end of a frame, and `tileAtClient` is the only thing that
 * reads them. So the honest way to ask "is the player in the middle?" is to draw
 * a frame and then ask the renderer which TILE is under the middle pixel of the
 * playfield — which asserts the centring and the pixel -> tile inverse AT THE
 * SAME TIME, with the real entry point in between.
 *
 * That is what the clamp's removal actually risks. `render/canvas.ts` states it:
 * the camera is signed now at every map edge, not merely on a map smaller than
 * the viewport, so anything that assumed a non-negative camera is wrong on every
 * frame a player spends near a boundary rather than in a rare fixture.
 */

// ---------------------------------------------------------------------------
// A canvas that records nothing. Only `tileAtClient` and `metrics` are asked.
// ---------------------------------------------------------------------------

type StubCanvas = {
  width: number;
  height: number;
  getContext: (kind: string) => unknown;
  getBoundingClientRect: () => { width: number; height: number; left: number; top: number };
};

function stubCanvas(cssW: number, cssH: number): StubCanvas {
  const state: Record<string, unknown> = { fillStyle: '#000', globalAlpha: 1, font: '10px sans' };
  let ctx: unknown = null;
  const canvas: StubCanvas = {
    width: 0,
    height: 0,
    getContext(kind) {
      if (kind !== '2d') return null;
      ctx ??= new Proxy(state, {
        get(target, prop) {
          if (prop === 'canvas') return canvas;
          if (prop === 'measureText') return () => ({ width: 0 });
          if (prop === 'createLinearGradient' || prop === 'createRadialGradient') {
            return () => ({ addColorStop: () => undefined });
          }
          if (typeof prop === 'string' && prop in target) return target[prop];
          return () => undefined;
        },
        set(target, prop, value) {
          if (typeof prop === 'string') target[prop] = value;
          return true;
        },
      });
      return ctx;
    },
    getBoundingClientRect: () => ({ width: cssW, height: cssH, left: 0, top: 0 }),
  };
  return canvas;
}

beforeEach(() => {
  (globalThis as Record<string, unknown>).document = {
    createElement: (tag: string) => {
      if (tag !== 'canvas') throw new Error(`unexpected createElement(${tag})`);
      return stubCanvas(0, 0);
    },
  };
  // dpr 1, so one CSS pixel is one device pixel and a client coordinate can be
  // built from a backbuffer one with the letterbox and the integer scale alone.
  (globalThis as Record<string, unknown>).window = { devicePixelRatio: 1 };
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>).document;
  delete (globalThis as Record<string, unknown>).window;
});

const NO_ART: SpriteSource = { sprite: () => undefined };

function level(w: number, h: number): LevelView {
  return { w, h, tiles: new Array<number>(w * h).fill(1) };
}

function body(x: number, y: number): ActorView {
  return {
    id: 'me',
    name: 'Ren',
    sprite: 'chr_player_watchman_s',
    x,
    y,
    kind: 'player',
    rank: ActorRank.Normal,
    hp: 10,
    maxHp: 10,
    alive: true,
  };
}

/** One drawn frame, and the two things a test can ask about it afterwards. */
function drawAt(cssW: number, cssH: number, map: LevelView, at: { x: number; y: number }) {
  const canvas = stubCanvas(cssW, cssH);
  const renderer = createRenderer({
    canvas: canvas as unknown as HTMLCanvasElement,
    sprites: NO_ART,
  });
  renderer.resize();
  renderer.draw({ level: map, realmKind: null, actors: [body(at.x, at.y)], selfId: 'me' });
  const m = renderer.metrics();
  /** A LOGICAL backbuffer pixel -> the client coordinate that lands on it. */
  const client = (bx: number, by: number) => ({
    clientX: m.offsetX + bx * m.scale,
    clientY: m.offsetY + by * m.scale,
  });
  const middle = client(Math.floor(m.logicalW / 2), Math.floor(m.logicalH / 2));
  return {
    metrics: m,
    tileAt: (bx: number, by: number) => {
      const c = client(bx, by);
      return renderer.tileAtClient(c.clientX, c.clientY);
    },
    tileInTheMiddle: renderer.tileAtClient(middle.clientX, middle.clientY),
  };
}

/**
 * Windows worth asking at. The first two are the ones this game is actually
 * played in; the last is deliberately smaller than several of the maps below is
 * larger than, so both directions of the old special case are covered.
 */
const WINDOWS: readonly { readonly w: number; readonly h: number; readonly name: string }[] = [
  { w: 1262, h: 428, name: 'the window this game is played in' },
  { w: 1248, h: 860, name: 'the Discord activity iframe' },
  { w: 1920, h: 1080, name: '1080p' },
  { w: 800, h: 600, name: 'a small window' },
];

describe('cameraAxis — the focus is the middle of the viewport', () => {
  it('puts the focus within half a pixel of the centre, at every viewport', () => {
    // FLOORED, so the answer is the centre or one pixel short of it and never
    // anything else. A camera at x = 12.5 offsets every sprite in the frame by
    // half a pixel, which is the fractional sampling the backbuffer exists to
    // prevent — that is why this is a floor and not an exact equality.
    for (const view of [428, 480, 640, 860, 1080, 1262, 1920]) {
      for (const focus of [0, 32, 100, 512, 4096, 10_000]) {
        const offset = focus - cameraAxis(view, focus);
        expect(offset, `${String(view)}px viewport, focus at ${String(focus)}`).toBeGreaterThan(
          view / 2 - 1,
        );
        expect(offset).toBeLessThanOrEqual(view / 2);
      }
    }
  });

  it('does not ask how big the map is', () => {
    // THE PROOF THE CLAMP IS GONE, as an arity rather than as a value: the old
    // form was `cameraAxis(worldPx, viewPx, focusPx)` and both of its extra
    // behaviours — the edge clamp and the centre-a-small-map arm — needed
    // `worldPx`. A two-argument camera cannot consult the level's bounds.
    expect(cameraAxis).toHaveLength(2);
  });

  it('answers a whole pixel, which is the only thing the floor is there for', () => {
    /**
     * ═══ AND `Math.trunc` WOULD PASS EVERY CASE IN THIS FILE, DELIBERATELY ═══
     * Measured rather than guessed, which is what a surviving mutant is for:
     * `viewLayout` only ever produces a backbuffer that is a whole number of
     * `TILE_PX` cells, and `TILE_PX` is even, so `viewPx / 2` is an integer; a
     * focus is `(tile + 0.5) * TILE_PX`, also an integer. The subtraction is
     * therefore never fractional at either call site, and floor and trunc are
     * the same function over the whole reachable input space. The invariant that
     * IS load-bearing is this one — `render/canvas.ts` states it: a camera at
     * x = 12.5 offsets every sprite in the frame by half a pixel, which is
     * precisely the fractional sampling the backbuffer exists to prevent.
     */
    for (const view of [428, 480, 640, 860, 1080, 1262, 1920]) {
      for (const focus of [0, 32, 100, 512, 4096, 10_000]) {
        expect(Number.isInteger(cameraAxis(view, focus))).toBe(true);
      }
    }
  });

  it('answers a negative camera near the origin, and that is the void', () => {
    // A tile at 0 with a 640-pixel viewport wants 320 pixels of nothing to its
    // left. The old clamp answered 0 here, which is exactly the frame in which
    // the player was drawn hard against the screen's edge.
    expect(cameraAxis(640, TILE_PX / 2)).toBeLessThan(0);
  });
});

describe('the drawn frame puts the body in the middle', () => {
  for (const window of WINDOWS) {
    /**
     * FOUR PLACES ON EVERY WINDOW, and three of them are cases the old clamp
     * treated specially. The middle of a big map is the only one it got right.
     */
    const PLACES = [
      { map: level(80, 60), at: { x: 40, y: 30 }, where: 'the middle of a large map' },
      { map: level(80, 60), at: { x: 0, y: 0 }, where: 'the top-left CORNER' },
      { map: level(80, 60), at: { x: 79, y: 59 }, where: 'the bottom-right CORNER' },
      { map: level(4, 3), at: { x: 0, y: 0 }, where: 'a map smaller than the viewport' },
    ] as const;

    for (const place of PLACES) {
      it(`${window.name}: ${place.where}`, () => {
        const frame = drawAt(window.w, window.h, place.map, place.at);
        expect(frame.tileInTheMiddle, 'the middle pixel is not the body').toEqual(place.at);
      });
    }
  }
});

describe('pixel -> tile still agrees with the painter once the clamp is gone', () => {
  /**
   * ONE INVERSE, AND EVERY CONVERSION IN THE CLIENT GOES THROUGH IT.
   * `renderer.tileAtClient` is what the targeting cursor, the verb menu, the
   * travel route, the ping and the hover card all call — `render/canvas.ts` says
   * why in as many words, and main.ts repeats it at each call site. So driving
   * this function IS driving all of them, and the failure the codebase keeps
   * hitting (two copies of a transform disagreeing at an edge) cannot hide in
   * one of the callers.
   */
  it('walks a row of tiles across a corner and lands on each of them', () => {
    const frame = drawAt(1248, 860, level(80, 60), { x: 0, y: 0 });
    const { logicalW, logicalH } = frame.metrics;
    const midX = Math.floor(logicalW / 2);
    const midY = Math.floor(logicalH / 2);
    // Eastwards from the body, one tile at a time. Each step must land on the
    // next column and never skip or repeat one.
    for (let step = 0; step * TILE_PX + midX < logicalW; step += 1) {
      expect(frame.tileAt(midX + step * TILE_PX, midY), `${String(step)} tiles east`).toEqual({
        x: step,
        y: 0,
      });
    }
  });

  it('answers null for the void west and north of the map, not column zero', () => {
    // ═══ THE BUG THIS CASE IS FOR, AND IT IS ONE CHARACTER ═══
    // `Math.floor` of a negative quotient rounds DOWN — `floor(-1/64)` is -1 —
    // so a pixel west of the map resolves to tile -1 and is refused. A
    // `Math.trunc` or a `| 0` folds that whole half-tile band onto column 0, and
    // the pointer picks up the map's west edge while hovering the void beside
    // it. Unreachable before the clamp went, because there was never any void.
    const frame = drawAt(1248, 860, level(80, 60), { x: 0, y: 0 });
    const { logicalW, logicalH } = frame.metrics;
    const midX = Math.floor(logicalW / 2);
    const midY = Math.floor(logicalH / 2);
    expect(frame.tileAt(midX - 1, midY), 'one pixel west of the body is still the body').toEqual({
      x: 0,
      y: 0,
    });
    for (const west of [TILE_PX, TILE_PX * 2, TILE_PX * 3]) {
      expect(frame.tileAt(midX - west, midY), `${String(west)}px west`).toBeNull();
    }
    for (const north of [TILE_PX, TILE_PX * 2]) {
      expect(frame.tileAt(midX, midY - north), `${String(north)}px north`).toBeNull();
    }
  });

  it('answers null for the void east and south of a map smaller than the screen', () => {
    const frame = drawAt(1248, 860, level(4, 3), { x: 3, y: 2 });
    const { logicalW, logicalH } = frame.metrics;
    const midX = Math.floor(logicalW / 2);
    const midY = Math.floor(logicalH / 2);
    expect(frame.tileAt(midX, midY)).toEqual({ x: 3, y: 2 });
    expect(frame.tileAt(midX + TILE_PX, midY), 'one tile past the east edge').toBeNull();
    expect(frame.tileAt(midX, midY + TILE_PX), 'one tile past the south edge').toBeNull();
    // ...and the far corners of a viewport many times the map's size.
    expect(frame.tileAt(0, 0)).toBeNull();
    expect(frame.tileAt(logicalW - 1, logicalH - 1)).toBeNull();
  });

  it('refuses the letterbox rather than snapping it to the nearest tile', () => {
    // Unchanged by any of this, and asserted here because the branch that does
    // it sits one line above the signed arithmetic that DID change.
    const canvas = stubCanvas(1248, 860);
    const renderer = createRenderer({
      canvas: canvas as unknown as HTMLCanvasElement,
      sprites: NO_ART,
    });
    renderer.resize();
    renderer.draw({
      level: level(80, 60),
      realmKind: null,
      actors: [body(40, 30)],
      selfId: 'me',
    });
    const m = renderer.metrics();
    if (m.offsetY > 0) expect(renderer.tileAtClient(m.offsetX, m.offsetY - 1)).toBeNull();
    if (m.offsetX > 0) expect(renderer.tileAtClient(m.offsetX - 1, m.offsetY)).toBeNull();
    expect(renderer.tileAtClient(m.offsetX + m.logicalW * m.scale + 1, m.offsetY)).toBeNull();
  });
});
