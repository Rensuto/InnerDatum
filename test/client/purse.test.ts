/// <reference lib="dom" />

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { PURSE_GAP, drawPurse, purseGeometry } from '../../src/client/ui/purse.ts';
import { PIP_PX } from '../../src/client/ui/resource.ts';
import { xpBarGeometry } from '../../src/client/ui/xpbar.ts';
import { PROTOCOL_VERSION } from '../../src/shared/version.ts';
import { MAX_CHARACTER_LEVEL } from '../../src/shared/progression.ts';
import type { ProgressMsg } from '../../src/shared/protocol.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE PURSE ON PERMANENT FURNITURE. PROPERTIES, NOT PIXELS.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `Minimalist.lua:1532-1540` blits `player.money` every pass. Ours had it only
 * in the bag's title bar. This file pins the handful of ways two pixels of
 * always-on furniture can be WRONG rather than ugly:
 *
 *   THE NULL FRAME   `money` rides the `inventory` frame, which `forgetTheWorld`
 *                    clears on every welcome — so there is a real window with no
 *                    purse to state, and it is exactly when the player is
 *                    staring at the screen.
 *   THE NEIGHBOURS   it shares the 18-pixel strip with the pip row on its left
 *                    and the experience widget on its right, and it is the only
 *                    one of the three with a neighbour on BOTH sides.
 *   THE SPELLING     the bag already prints this number. Two formats for one
 *                    fact makes a player check whether they are the same number.
 *
 * The `reference lib="dom"` on line 1 is required; its cost is documented at
 * test/client/turncards.test.ts:51-60.
 */

// ---------------------------------------------------------------------------
// Fixtures — the same transcriptions test/client/xpbar.test.ts makes, and for
// the same stated reason: main.ts is not importable from a test.
// ---------------------------------------------------------------------------

const STRIP_X = 4;
function stripWidth(viewport: number): number {
  return viewport - 8;
}
const MIN_VIEWPORT = 640;
const STRIP_Y = 100;

function progressFrame(over: Partial<ProgressMsg> = {}): ProgressMsg {
  return {
    v: PROTOCOL_VERSION,
    t: 'progress',
    level: 3,
    xp: 30,
    xpToNext: 120,
    unspent: 0,
    unspentGenerics: 0,
    ...over,
  };
}

type Op = { readonly kind: string; readonly args: readonly unknown[] };

function recorder(ops: Op[]): CanvasRenderingContext2D {
  return new Proxy(
    {},
    {
      get: (_target, prop: string) => {
        if (prop === 'measureText') return (text: string) => ({ width: text.length * 6 });
        return (...args: unknown[]) => {
          ops.push({ kind: prop, args });
        };
      },
      set: () => true,
    },
  ) as unknown as CanvasRenderingContext2D;
}

/**
 * THE BOX main.ts HANDS DOWN. Restated here, and guarded against drift by
 * `the call site derives its box` below — a test that computed the box its own
 * way would prove the widget correct against a rule the game does not use.
 */
function purseBox(progress: ProgressMsg | null, viewport: number): number {
  const width = stripWidth(viewport);
  const xp = xpBarGeometry(progress, STRIP_X, STRIP_Y, width);
  const xpLeft = xp === null ? STRIP_X + width : (xp.caption ?? xp.track).x;
  return Math.max(0, xpLeft - PURSE_GAP - STRIP_X);
}

// ---------------------------------------------------------------------------
// Saying nothing rather than something wrong
// ---------------------------------------------------------------------------

describe('before the first inventory frame', () => {
  it('draws nothing at all rather than a confident zero', () => {
    // ═══ THE WINDOW IS REAL AND IT IS THE WORST ONE ═══
    // `forgetTheWorld` sets `inventory = null` on every welcome, and the server
    // sends the frame after. A purse reading `0 GOLD` there tells a player they
    // are broke at the exact moment they arrive somewhere new.
    expect(purseGeometry(null, STRIP_X, STRIP_Y, 400)).toBeNull();

    const ops: Op[] = [];
    drawPurse({ ctx: recorder(ops), money: null, x: STRIP_X, y: STRIP_Y, width: 400 });
    expect(ops).toEqual([]);
  });

  it('refuses a value it cannot print, rather than printing NaN GOLD', () => {
    // The wire is validated on the way IN to the server, never on the way out
    // to the browser — so a malformed frame reaches this function unchecked.
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(purseGeometry(bad, STRIP_X, STRIP_Y, 400)).toBeNull();
    }
  });

  it('clamps a negative purse to zero instead of printing a debt', () => {
    // `InventoryMsg.money` is documented "a whole number, never negative", so
    // this is a malformed frame too — but zero is a number this game has a
    // meaning for and `-40 GOLD` is not.
    expect(purseGeometry(-40, STRIP_X, STRIP_Y, 400)?.label).toBe('0 GOLD');
  });
});

// ---------------------------------------------------------------------------
// The spelling
// ---------------------------------------------------------------------------

describe('the number it prints', () => {
  it('is the bag’s own spelling, so one fact has one format', () => {
    // ui/inventory.ts:646 composes `  ${Math.floor(money)} GOLD` for the panel
    // title. A player who reads `412 GOLD` here and `412 GOLD` there does not
    // have to work out that they are the same number.
    expect(purseGeometry(412, STRIP_X, STRIP_Y, 400)?.label).toBe('412 GOLD');
  });

  it('floors a fractional purse, as the bag title does', () => {
    expect(purseGeometry(99.87, STRIP_X, STRIP_Y, 400)?.label).toBe('99 GOLD');
  });
});

// ---------------------------------------------------------------------------
// THE NEIGHBOURS — the assertion this file exists for
// ---------------------------------------------------------------------------

describe('the widget inside the resource strip', () => {
  /**
   * ═══ IT HAS A NEIGHBOUR ON BOTH SIDES, WHICH THE OTHER TWO DO NOT ═══
   * The pips are left-aligned and the experience widget is right-aligned, so
   * each has one free edge. This sits between them and can collide either way.
   */
  it('clears the widest pip row on its left and the xp widget on its right', () => {
    // Transcribed, not imported, for test/client/xpbar.test.ts's stated reason:
    // `PIP_GAP` and `CONTINUOUS_PIPS` are private to ui/resource.ts and
    // importing them would make this test a second authority on its layout.
    const PIP_GAP = 2;
    const WIDEST_PIP_ROW = 10;
    const pipsEnd = STRIP_X + WIDEST_PIP_ROW * (PIP_PX + PIP_GAP);

    for (const viewport of [MIN_VIEWPORT, 768, 800, 1248, 1280]) {
      for (const progress of [
        progressFrame(),
        // THE CAP WIDENS THE NEIGHBOUR. `TOP` appears at MAX_CHARACTER_LEVEL, so
        // the xp widget's left edge MOVES for the one player who got there —
        // which is why main.ts asks for that edge instead of assuming one.
        progressFrame({ level: MAX_CHARACTER_LEVEL, xp: 900, xpToNext: 0 }),
      ]) {
        const width = purseBox(progress, viewport);
        const geometry = purseGeometry(999_999, STRIP_X, STRIP_Y, width);
        if (geometry === null) throw new Error(`no purse at ${String(viewport)}`);

        const xp = xpBarGeometry(progress, STRIP_X, STRIP_Y, stripWidth(viewport));
        const xpLeft = (xp?.caption ?? xp?.track)?.x ?? Number.POSITIVE_INFINITY;

        expect(geometry.box.x, `purse over the pips at ${String(viewport)}`).toBeGreaterThanOrEqual(
          pipsEnd,
        );
        expect(
          geometry.box.x + geometry.box.w,
          `purse over the xp widget at ${String(viewport)}`,
        ).toBeLessThanOrEqual(xpLeft - PURSE_GAP);
      }
    }
  });

  it('is right-aligned inside the box it is given', () => {
    const geometry = purseGeometry(7, STRIP_X, STRIP_Y, 400);
    expect(geometry?.box.x).toBe(STRIP_X + 400 - (geometry?.box.w ?? 0));
  });

  it('sits on the pip row rather than below it', () => {
    const geometry = purseGeometry(7, STRIP_X, STRIP_Y, 400);
    expect(geometry?.box.y).toBe(STRIP_Y);
    expect(geometry?.box.h).toBe(PIP_PX);
  });

  it('draws nothing rather than overlapping when the strip cannot hold it', () => {
    // ui/resource.ts gives the same answer when its own row runs out of width,
    // and ui/xpbar.ts returns null for it. Three widgets, one rule.
    const ops: Op[] = [];
    drawPurse({ ctx: recorder(ops), money: 412, x: STRIP_X, y: STRIP_Y, width: 4 });
    expect(ops).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The join — the half a unit test cannot reach
// ---------------------------------------------------------------------------

describe('the call site', () => {
  /**
   * ═══ THE BOX ABOVE IS RESTATED, SO SOMETHING HAS TO PIN THE REAL ONE ═══
   * `purseBox` here computes what main.ts computes. That makes every assertion
   * above true of THIS file's arithmetic, and main.ts is not importable from a
   * test — so the one thing that would silently invalidate them all is main.ts
   * quietly replacing the derived edge with a literal. This scrapes the source
   * to say it has not, the way test/client/assets.test.ts guards the painters.
   */
  const source = readFileSync(new URL('../../src/client/main.ts', import.meta.url), 'utf8');

  it('derives the purse’s box from xpBarGeometry, never from a literal', () => {
    const call = source.slice(source.indexOf('drawPurse({'));
    expect(call).not.toBe('');

    // The edge is ASKED FOR, not assumed.
    expect(source).toContain('xpBarGeometry(progress, stripX, stripY, stripW)');
    // ...and it is the caption-or-track edge, because `TOP` widens the widget
    // at the level cap and the badge alone would be the wrong edge.
    expect(source).toContain('(xpGeometry.caption ?? xpGeometry.track).x');
    // ...and the purse is placed against it, minus this file's own gap.
    expect(call.slice(0, call.indexOf('})'))).toContain('xpLeft - PURSE_GAP - stripX');
  });

  it('passes null rather than zero when no inventory frame has arrived', () => {
    const call = source.slice(source.indexOf('drawPurse({'));
    expect(call.slice(0, call.indexOf('})'))).toContain('inventory?.money ?? null');
  });
});
