/// <reference lib="dom" />

import { describe, expect, it } from 'vitest';

import { drawXpBar, XP_TRACK_H, xpBarGeometry } from '../../src/client/ui/xpbar.ts';
import { PIP_PX, RESOURCE_H } from '../../src/client/ui/resource.ts';
import { PROTOCOL_VERSION } from '../../src/shared/version.ts';
import { MAX_CHARACTER_LEVEL, worthExp } from '../../src/shared/progression.ts';
import { ActorRank } from '../../src/shared/protocol.ts';
import type { ProgressMsg } from '../../src/shared/protocol.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE LEVEL BADGE AND THE XP TRACK. NO PIXELS ARE ASSERTED — PROPERTIES ARE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * vitest.config.ts is explicit that there is deliberately no jsdom and no canvas
 * here, and nothing below paints to anything real. What is tested is the handful
 * of ways two pixels of permanent furniture can be WRONG rather than ugly:
 *
 *   THE NULL FRAME    `progress` arrives in the `hello` block, so there is a
 *                     real window on connect with no level to state. Furniture
 *                     is worse there than a panel is, because that window is
 *                     exactly when the player is staring at the screen.
 *   THE CAP SENTINEL  `xpToNext === 0` is a FACT, never a denominator. A
 *                     division there is `Infinity` or `NaN`, and a `NaN` width
 *                     handed to `fillRect` draws nothing while reporting no
 *                     error at all — the widget silently vanishing for the one
 *                     player who reached level 10.
 *   THE FRACTION      `worthExp` pays 3.2 for a normal husk at level 1
 *                     (progression.ts:313-315), so `xp` is routinely fractional
 *                     and the filled width must still be a whole number.
 *   THE NEIGHBOURS    it shares an 18-pixel strip with the resource pips, and
 *                     the whole reason it is a separate file rather than a
 *                     function in ui/resource.ts is that it must not be read as
 *                     a second pip row. Right-aligned, one quarter the height,
 *                     and clear of the widest pip row at the narrowest viewport.
 *
 * THE `reference lib="dom"` ON LINE 1 IS REQUIRED and its cost is documented at
 * test/client/turncards.test.ts:51-60.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function progressFrame(over: Partial<ProgressMsg> = {}): ProgressMsg {
  return {
    v: PROTOCOL_VERSION,
    t: 'progress',
    level: 3,
    xp: 30,
    xpToNext: 120,
    unspent: 0,
    ...over,
  };
}

/**
 * The strip as main.ts hands it to `drawResource`: `x: 4`, `width: width - 8`,
 * and a `y` that is the top of the PIP ROW rather than of the 18-pixel band.
 * Transcribed rather than imported, because main.ts is not importable from a
 * test — and because the numbers being transcribed are the point of two of the
 * assertions below.
 */
const STRIP_X = 4;
function stripWidth(viewport: number): number {
  return viewport - 8;
}

/** The narrowest backbuffer this game supports — render/canvas.ts's default. */
const MIN_VIEWPORT = 640;

type Op = { readonly kind: string; readonly args: readonly unknown[] };

/**
 * The Proxy recorder every ui/ test here uses, with `fillRect`'s COORDINATES
 * kept — the whole widget is two `fillRect`s and two `fillText`s, so the
 * coordinates ARE the drawing.
 *
 * `measureText` answers six pixels a character, the advance of the 10px
 * monospace, so `fitText` does not ellipsise the strings under test.
 */
function recorder(ops: Op[]): CanvasRenderingContext2D {
  return new Proxy(
    {},
    {
      get: (_target, prop: string) => {
        if (prop === 'measureText') return (text: string) => ({ width: text.length * 6 });
        if (prop === 'canvas') return undefined;
        return (...args: unknown[]) => {
          ops.push({ kind: prop, args });
        };
      },
      set: () => true,
    },
  ) as unknown as CanvasRenderingContext2D;
}

function paint(progress: ProgressMsg | null, viewport = MIN_VIEWPORT): Op[] {
  const ops: Op[] = [];
  drawXpBar({
    ctx: recorder(ops),
    progress,
    x: STRIP_X,
    y: 100,
    width: stripWidth(viewport),
  });
  return ops;
}

function texts(ops: readonly Op[]): readonly string[] {
  return ops.flatMap((op) => (op.kind === 'fillText' ? [String(op.args[0])] : []));
}

// ---------------------------------------------------------------------------
// THE TWO STATES THAT ARE NOT EDGE CASES
// ---------------------------------------------------------------------------

describe('the null frame', () => {
  it('draws NOTHING at all before the first progress frame', () => {
    // ui/charsheet.ts:344-347 refuses to print "Level: 0" in the same window for
    // the same reason: a wrong number stated confidently is worse than a number
    // that is not there yet. Not one op — not even a save/restore pair.
    expect(paint(null)).toEqual([]);
    expect(xpBarGeometry(null, STRIP_X, 100, stripWidth(MIN_VIEWPORT))).toBeNull();
  });
});

describe('the cap sentinel', () => {
  const capped = progressFrame({ level: MAX_CHARACTER_LEVEL, xp: 900, xpToNext: 0 });

  it('fills the track completely, statically, and NEVER divides by the zero', () => {
    // `xpToNext === 0` is asserted as a sentinel in three other places
    // (shared/protocol.ts, server/net/gateway.ts, ui/charsheet.ts:428-441): at
    // MAX_CHARACTER_LEVEL there is no next level and `xp` keeps climbing.
    const geometry = xpBarGeometry(capped, STRIP_X, 100, stripWidth(MIN_VIEWPORT));
    if (geometry === null) throw new Error('unreachable');
    expect(geometry.atCap).toBe(true);
    expect(geometry.filled).toBe(geometry.track.w);

    // STATIC: more xp at the cap does not move it, because there is nothing for
    // it to move towards.
    const later = xpBarGeometry(
      progressFrame({ level: MAX_CHARACTER_LEVEL, xp: 99999, xpToNext: 0 }),
      STRIP_X,
      100,
      stripWidth(MIN_VIEWPORT),
    );
    expect(later?.filled).toBe(geometry.filled);

    // NO DIVISION. A division by the sentinel is `Infinity` or `NaN`, and either
    // one reaches `fillRect` as a width that draws nothing at all while throwing
    // no error — the widget silently disappearing for the one player who got
    // there. Every number that leaves the geometry is finite and whole.
    for (const value of [geometry.filled, geometry.track.w, geometry.track.x, geometry.badge.x]) {
      expect(Number.isFinite(value)).toBe(true);
      expect(Number.isInteger(value)).toBe(true);
    }
    for (const op of paint(capped)) {
      for (const arg of op.args) {
        if (typeof arg === 'number') expect(Number.isNaN(arg)).toBe(false);
      }
    }
  });

  it('says TOP in a WORD, and says it only at the cap', () => {
    // A full track and a nearly-full track are one pixel apart; the caption is
    // what makes "there is no more" a different KIND of statement from "almost".
    expect(texts(paint(capped))).toContain('TOP');
    expect(texts(paint(capped))).toContain(`Lv ${String(MAX_CHARACTER_LEVEL)}`);

    const nearly = progressFrame({ level: 9, xp: 119, xpToNext: 120 });
    expect(texts(paint(nearly))).not.toContain('TOP');
    expect(xpBarGeometry(nearly, STRIP_X, 100, stripWidth(MIN_VIEWPORT))?.caption).toBeNull();
  });

  it('prints the level with NO denominator, exactly as ToME’s own HUD does', () => {
    // uiset/Minimalist.lua:1552-1560 blits `"Lvl "..player.level` — the level
    // alone, nowhere on the frame a "of 50". That is what lets this widget avoid
    // deciding for itself where the ceiling is, which shared/protocol.ts
    // :3301-3305 argues the browser must not do.
    const drawn = texts(paint(progressFrame({ level: 3 })));
    expect(drawn).toContain('Lv 3');
    expect(drawn.some((t) => t.includes('/'))).toBe(false);
    expect(drawn.some((t) => t.includes('%'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// THE TRACK — monotonic, bounded, and always a whole number of pixels
// ---------------------------------------------------------------------------

describe('the filled width', () => {
  function filledAt(xp: number, xpToNext = 120): number {
    const geometry = xpBarGeometry(
      progressFrame({ xp, xpToNext }),
      STRIP_X,
      100,
      stripWidth(MIN_VIEWPORT),
    );
    if (geometry === null) throw new Error('unreachable');
    return geometry.filled;
  }

  it('rises with xp and never exceeds the track', () => {
    const track = xpBarGeometry(progressFrame(), STRIP_X, 100, stripWidth(MIN_VIEWPORT))?.track.w;
    if (track === undefined) throw new Error('unreachable');

    let previous = -1;
    for (let xp = 0; xp <= 240; xp += 1) {
      const filled = filledAt(xp);
      expect(filled, `xp=${xp}`).toBeGreaterThanOrEqual(previous);
      expect(filled, `xp=${xp}`).toBeLessThanOrEqual(track);
      previous = filled;
    }
    expect(filledAt(0)).toBe(0);
    expect(filledAt(120)).toBe(track);
    // PAST the threshold, which is reachable for the instant between a kill and
    // the base-clock pass that levels the actor. Minimalist.lua:1519 clamps the
    // same way (`math.min(1, math.max(0, cur_exp / max_exp))`).
    expect(filledAt(500)).toBe(track);
    // ...and below zero, which nothing sends and which must still not produce a
    // negative width for `fillRect`.
    expect(filledAt(-40)).toBe(0);
  });

  it('turns a FRACTIONAL xp into a whole number of pixels, never a NaN', () => {
    // One normal husk at level 1 pays exactly 3.2 (progression.ts:313-315), so a
    // fractional numerator is the ORDINARY case here and not an exotic one.
    const oneKill = worthExp(1, ActorRank.Normal);
    expect(Number.isInteger(oneKill)).toBe(false);

    for (const xp of [oneKill, oneKill * 2, oneKill * 3, 0.5, 119.9999]) {
      const filled = filledAt(xp);
      expect(Number.isInteger(filled), `xp=${xp}`).toBe(true);
      expect(Number.isNaN(filled), `xp=${xp}`).toBe(false);
    }

    // And it FLOORS rather than rounding: a pixel that is not earned is not lit,
    // which is ui/resource.ts's own rule for a pip (`Math.floor` at its
    // `pipCount`) applied to the one other progress reading on this strip.
    expect(filledAt(119.9999, 120)).toBeLessThan(filledAt(120, 120));
  });

  it('survives a malformed frame rather than drawing a NaN-wide rect', () => {
    // The wire is validated on the way IN to the server, not on the way out to
    // the browser, so this file defends itself.
    for (const bad of [
      progressFrame({ xp: Number.NaN }),
      progressFrame({ xpToNext: Number.NaN }),
      progressFrame({ xpToNext: -12 }),
    ]) {
      const geometry = xpBarGeometry(bad, STRIP_X, 100, stripWidth(MIN_VIEWPORT));
      if (geometry === null) throw new Error('unreachable');
      expect(Number.isInteger(geometry.filled)).toBe(true);
      expect(geometry.filled).toBeGreaterThanOrEqual(0);
      expect(geometry.filled).toBeLessThanOrEqual(geometry.track.w);
    }
  });
});

// ---------------------------------------------------------------------------
// THE NEIGHBOURS — why this is not a second pip row
// ---------------------------------------------------------------------------

describe('the widget inside the resource strip', () => {
  it('is THREE pixels tall, not RESOURCE_H and not the pips’ twelve', () => {
    // ═══ THE NUMBER THE WHOLE SEPARATE-FILE ARGUMENT RESTS ON ═══
    // ui/resource.ts's header is a sustained case that its row is not a bar and
    // that a partial pip would be "the bar, reintroduced one sixteenth at a
    // time". A gauge as tall as the pips is a second pip row made of one long
    // pip, and item 7 of this pass has just started refilling those pips over
    // time — so this is the moment the two are most easily confused.
    expect(XP_TRACK_H).toBe(3);
    expect(XP_TRACK_H).not.toBe(RESOURCE_H);
    expect(XP_TRACK_H * 4).toBe(PIP_PX);

    const geometry = xpBarGeometry(progressFrame(), STRIP_X, 100, stripWidth(MIN_VIEWPORT));
    expect(geometry?.track.h).toBe(XP_TRACK_H);
    // Centred on the PIP ROW, so it lines up with what the eye compares it to,
    // and never below it.
    expect(geometry?.track.y).toBeGreaterThanOrEqual(100);
    expect((geometry?.track.y ?? 0) + XP_TRACK_H).toBeLessThanOrEqual(100 + PIP_PX);
  });

  it('is right-aligned, and clears the widest possible pip row at 640', () => {
    // ═══ THE ONE PLACEMENT ASSERTION, AND IT IS ABOUT THE OTHER SURFACE ═══
    // The pips are LEFT-aligned (ui/resource.ts walks a cursor from `x`), so the
    // right end of the strip is empty at every viewport. The widest row the
    // strip can draw is ten pips — `CONTINUOUS_PIPS` for Resolve and Focus, and
    // more than the eight a discrete Reagent pool ever shows — laid out at
    // `PIP_PX` with a two-pixel gap. Transcribed rather than imported, because
    // `PIP_GAP` and `CONTINUOUS_PIPS` are private to that file and importing
    // them would make this test a second authority on its layout.
    const PIP_GAP = 2;
    const WIDEST_PIP_ROW = 10;
    const pipsEnd = STRIP_X + WIDEST_PIP_ROW * (PIP_PX + PIP_GAP);

    for (const viewport of [MIN_VIEWPORT, 768, 800, 1248, 1280]) {
      const width = stripWidth(viewport);
      for (const progress of [
        progressFrame(),
        progressFrame({ level: MAX_CHARACTER_LEVEL, xp: 900, xpToNext: 0 }),
      ]) {
        const geometry = xpBarGeometry(progress, STRIP_X, 100, width);
        if (geometry === null) throw new Error(`unreachable at ${viewport}`);
        // RIGHT-ALIGNED: the badge ends exactly at the strip's right edge.
        expect(geometry.badge.x + geometry.badge.w, `${viewport}`).toBe(STRIP_X + width);
        // ...and the LEFT edge of the whole widget — the caption at the cap, the
        // track below it — is clear of the pips.
        const left = geometry.caption?.x ?? geometry.track.x;
        expect(left, `${viewport}`).toBeGreaterThan(pipsEnd);
      }
    }
  });

  it('draws nothing rather than sitting on top of the pips in a strip too narrow', () => {
    // "Draw nothing" is ui/resource.ts's own answer when its row runs out of
    // width, and it is the right one here: a level number the character sheet
    // already carries is not worth making the resource unreadable for.
    expect(paint(progressFrame(), 40)).toEqual([]);
    expect(xpBarGeometry(progressFrame(), 0, 100, 20)).toBeNull();
  });

  it('pairs every save with a restore, so no font or alignment leaks out', () => {
    // An unbalanced restore leaks `textAlign: right` into every painter that
    // runs later in the frame, and it presents as a bug in whichever surface
    // happens to be drawn next (ui/turncards.ts:786-790 records the same trap
    // for `ctx.filter`). This widget sets `textAlign`, so it is a live risk.
    const ops = paint(progressFrame());
    expect(ops.filter((op) => op.kind === 'save')).toHaveLength(
      ops.filter((op) => op.kind === 'restore').length,
    );
    expect(ops.filter((op) => op.kind === 'save').length).toBeGreaterThan(0);
  });
});
