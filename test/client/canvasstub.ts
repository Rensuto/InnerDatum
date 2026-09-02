/// <reference lib="dom" />

// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ENOUGH OF A CANVAS TO DRIVE `createRenderer`, AND NOT ONE THING MORE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `vitest.config.ts` sets the environment to `node` with deliberately no jsdom,
 * so for most of this suite the claim under test is a DECISION a painter makes
 * and never a pixel it puts down. Two things are not like that — what the
 * renderer COMPOSITES, and what SIZE it draws a cell mark at — and both are
 * invisible to every other kind of test. This is what makes them reachable.
 *
 * ═══ A PROXY, BECAUSE NAMING THE METHODS IS THE PART THAT ROTS ═══
 * The renderer calls something like thirty context methods and assigns as many
 * style fields. A stub that had to list them would fail the day a painter grew
 * a gradient, which teaches the next person to delete the test rather than fix
 * it. So: `drawImage` is recorded in full, a handful of methods that must
 * return a value do, and everything else answers with a no-op.
 *
 * NOT A RENDERING TEST. Nothing here can tell you a frame looks right. It can
 * tell you a sprite was drawn at the wrong SIZE or onto the wrong LAYER, which
 * is exactly the pair of mistakes that have shipped from this file.
 */

/** One `drawImage`, as it was called. `dw`/`dh` are absent for the 3-arg form. */
export type Blit = {
  readonly source: StubCanvas | StubImage | null;
  readonly dx: number;
  readonly dy: number;
  readonly dw: number | null;
  readonly dh: number | null;
};

export type StubImage = { readonly id: string; readonly w: number; readonly h: number };

export type StubCtx = {
  readonly canvas: StubCanvas;
  readonly blits: Blit[];
};

export type StubCanvas = {
  width: number;
  height: number;
  /** The `alpha` this canvas's context was requested with; null if never asked. */
  alpha: boolean | null;
  ctx: StubCtx | null;
  getContext: (kind: string, opts?: { alpha?: boolean }) => unknown;
  getBoundingClientRect: () => { width: number; height: number; left: number; top: number };
};

function isSource(v: unknown): v is StubCanvas | StubImage {
  return typeof v === 'object' && v !== null && ('alpha' in v || 'id' in v);
}

function stubContext(canvas: StubCanvas): StubCtx {
  const blits: Blit[] = [];
  const real: Record<string, unknown> = { canvas, blits };
  return new Proxy(real, {
    get(target, prop) {
      if (prop === 'canvas') return canvas;
      if (prop === 'blits') return blits;
      if (prop === 'drawImage') {
        return (source: unknown, ...rest: number[]) => {
          // Three arities: (src, dx, dy), (src, dx, dy, dw, dh) and the
          // nine-argument sub-rectangle form. Only the destination matters here,
          // and it is the last four numbers in every form that has four.
          const nums = rest;
          const dest =
            nums.length >= 8
              ? { dx: nums[4] ?? 0, dy: nums[5] ?? 0, dw: nums[6] ?? null, dh: nums[7] ?? null }
              : { dx: nums[0] ?? 0, dy: nums[1] ?? 0, dw: nums[2] ?? null, dh: nums[3] ?? null };
          blits.push({ source: isSource(source) ? source : null, ...dest });
        };
      }
      if (prop === 'measureText') return () => ({ width: 0 });
      if (prop === 'createLinearGradient' || prop === 'createRadialGradient') {
        return () => ({ addColorStop: () => undefined });
      }
      if (typeof prop === 'string' && prop in target) return target[prop];
      return () => undefined;
    },
    set() {
      return true;
    },
  }) as unknown as StubCtx;
}

export function stubCanvas(cssW = 0, cssH = 0): StubCanvas {
  const canvas: StubCanvas = {
    width: 0,
    height: 0,
    alpha: null,
    ctx: null,
    getContext(kind, opts) {
      if (kind !== '2d') return null;
      canvas.alpha = opts?.alpha ?? true;
      canvas.ctx ??= stubContext(canvas);
      return canvas.ctx;
    },
    getBoundingClientRect: () => ({ width: cssW, height: cssH, left: 0, top: 0 }),
  };
  return canvas;
}

/** Install a `document` that makes canvases and a `window` with a device ratio. */
export function installDom(dpr = 1): void {
  (globalThis as Record<string, unknown>).document = {
    createElement: (tag: string) => {
      if (tag !== 'canvas') throw new Error(`unexpected createElement(${tag})`);
      return stubCanvas();
    },
  };
  (globalThis as Record<string, unknown>).window = { devicePixelRatio: dpr };
}

export function removeDom(): void {
  delete (globalThis as Record<string, unknown>).document;
  delete (globalThis as Record<string, unknown>).window;
}

/**
 * A sprite source that answers EVERY id, at a size you choose.
 *
 * Deliberately able to lie: a test that wants to prove the renderer binds a
 * cell mark to the CELL rather than to the art hands it 32x32 art and asserts a
 * 64-pixel blit. That is the whole point — the invariant has to hold for art
 * that is the wrong size, because art that was the wrong size is what broke it.
 */
export function stubSprites(w: number, h: number) {
  return {
    sprite: (id: string) => ({ id, image: { id, w, h } as unknown as HTMLImageElement, w, h }),
  };
}
