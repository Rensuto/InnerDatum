/**
 * The shared panel furniture: the rules every panel in this client draws by.
 *
 * `fitText` is the only one here so far, and it is here because a one-character
 * label found a hole in it that no panel's own test could have seen — the fault
 * is in the helper, and the helper had no file of its own.
 */

import { describe, expect, it } from 'vitest';

import { FONT_BUTTON, fitText } from '../../src/client/ui/panel.ts';

/**
 * A context that measures the way the real one does: a fixed advance per
 * character for the monospace face, and a WIDER one for the two triangles,
 * because neither `◀` nor `▶` is in `ui-monospace` and the browser falls back
 * to whatever proportional face has them. Measured in a live page at
 * `bold 10px ui-monospace, Consolas, monospace`: `◀` is 8.61 pixels where an
 * ordinary character is 6.
 */
function measuring(): CanvasRenderingContext2D {
  return {
    font: FONT_BUTTON,
    measureText: (text: string) => ({
      width: [...text].reduce((sum, ch) => sum + (ch === '◀' || ch === '▶' ? 8.61 : 6), 0),
    }),
  } as unknown as CanvasRenderingContext2D;
}

describe('fitText', () => {
  it('leaves a string that already fits exactly as it is', () => {
    expect(fitText(measuring(), 'RESUME', 100)).toBe('RESUME');
  });

  it('trims a long string and marks it, so the reader knows there is more', () => {
    const cut = fitText(measuring(), 'KEY BINDINGS', 30);
    expect(cut.endsWith('…')).toBe(true);
    expect(cut.length).toBeLessThan('KEY BINDINGS'.length);
    expect(measuring().measureText(cut).width).toBeLessThanOrEqual(30);
  });

  it('answers nothing at all for a box with no width', () => {
    expect(fitText(measuring(), 'RESUME', 0)).toBe('');
    expect(fitText(measuring(), 'RESUME', -4)).toBe('');
  });

  /**
   * ══════════════════════════════════════════════════════════════════════════
   * THE ELLIPSIS USED TO MAKE A ONE-GLYPH LABEL *WIDER* THAN THE BOX IT MISSED.
   * ══════════════════════════════════════════════════════════════════════════
   *
   * The loop cannot shorten a string of length one, so it fell out and returned
   * that character PLUS the mark. Found on the interface-size arrows, where
   * `drawButton` fits its label to `rect.w - 6` — six pixels on a 12-wide plate:
   * `◀` measured 8.61 and did not fit, and what was drawn was `◀…` at 14.11,
   * centred in a 12px box, with the triangle hanging outside the border and the
   * ellipsis sitting inside it. A function whose job is "make this fit" was the
   * reason it did not.
   *
   * AN ELLIPSIS IS A PROMISE THAT SOMETHING WAS CUT. Nothing was, so the glyph
   * comes back whole and the caller clips.
   */
  it('returns a single character whole rather than widening it', () => {
    const ctx = measuring();
    const budget = 6;
    expect(ctx.measureText('◀').width).toBeGreaterThan(budget);
    const drawn = fitText(ctx, '◀', budget);
    expect(drawn, 'the mark was added to a label it could not shorten').toBe('◀');
    expect(ctx.measureText(drawn).width).toBeLessThan(ctx.measureText('◀…').width);
  });

  it('still marks a two-character label, because that one really was cut', () => {
    // The boundary either side of the rule above: at length two there IS
    // something to drop, so the promise is kept.
    const ctx = measuring();
    expect(fitText(ctx, 'AB', 7)).toBe('A…');
  });
});
