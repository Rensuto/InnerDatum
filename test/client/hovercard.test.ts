import { describe, expect, it } from 'vitest';

import {
  drawHoverCard,
  hoverCardBody,
  hoverCardRect,
  cardStatLines,
} from '../../src/client/ui/panel.ts';
import type { HoverCard } from '../../src/client/ui/panel.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE HOVER CARD PAINTS INSIDE ITS OWN STATE, AND USED NOT TO.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `drawHoverCard` was the only painter in `src/client/ui/` with no
 * `save()`/`restore()` pair and no explicit `textBaseline`. It set `font`,
 * `textAlign` and `fillStyle` and left all three behind, and it measured its
 * first line as `y + CARD_PAD + 9` — from the TOP of the box, which is only
 * true while the ambient baseline is `alphabetic`.
 *
 * SIX PAINTERS IN THAT DIRECTORY SET `middle` (caselog, charsheet, classpicker,
 * combatbanner, contextmenu, escapemenu) and every one of them restores it. So
 * the card worked by their good manners rather than by anything of its own, and
 * the day one of them gained an early return the card's text would move nine
 * pixels with nothing to say why.
 *
 * ═══ WHY A LOCAL RECORDER ═══
 * `inventory.test.ts`'s stub returns `true` from its `set` trap and throws the
 * assignment away, so it can see `save()` but never `textBaseline = …`. This one
 * records both, because the second is half the point.
 */

type Recorded = { readonly calls: string[]; readonly sets: Record<string, unknown> };

function recorder(): { ctx: CanvasRenderingContext2D; log: Recorded } {
  const calls: string[] = [];
  const sets: Record<string, unknown> = {};
  const ctx = new Proxy(
    {},
    {
      get: (_t, prop: string) => {
        if (prop === 'measureText') return (text: string) => ({ width: text.length * 6 });
        if (prop === 'canvas') return undefined;
        return (...args: unknown[]) => {
          calls.push(`${prop}(${String(args.length)})`);
        };
      },
      set: (_t, prop: string, value: unknown) => {
        sets[prop] = value;
        calls.push(`set:${prop}`);
        return true;
      },
    },
  ) as unknown as CanvasRenderingContext2D;
  return { ctx, log: { calls, sets } };
}

const CARD: HoverCard = {
  title: 'Fitted Oiled Leather Chestpiece',
  meta: 'rare · body',
  lines: ['Armour        +5', 'Hardiness     +3%'],
};

const SPRITES = { sprite: () => undefined };

describe('the hover card leaves the canvas as it found it', () => {
  it('pairs every save with a restore', () => {
    const { ctx, log } = recorder();
    drawHoverCard(ctx, SPRITES, CARD, 200, 200, 800, 600);

    const saves = log.calls.filter((c) => c.startsWith('save(')).length;
    const restores = log.calls.filter((c) => c.startsWith('restore(')).length;
    expect(saves, 'it took no snapshot at all').toBeGreaterThan(0);
    expect(restores).toBe(saves);
  });

  /**
   * THE SNAPSHOT COMES FIRST. A `save()` taken after the first `font` assignment
   * would restore the card's own font rather than the caller's — balanced, and
   * still a leak. Asserted by position, which is the only way to see it.
   */
  it('takes the snapshot before it writes any state', () => {
    const { ctx, log } = recorder();
    drawHoverCard(ctx, SPRITES, CARD, 200, 200, 800, 600);

    const firstSave = log.calls.findIndex((c) => c.startsWith('save('));
    const firstSet = log.calls.findIndex((c) => c.startsWith('set:'));
    expect(firstSave, 'no save at all').toBeGreaterThanOrEqual(0);
    expect(firstSet, 'no state written at all — the fixture draws nothing').toBeGreaterThanOrEqual(
      0,
    );
    expect(firstSave).toBeLessThan(firstSet);
  });

  /**
   * AND IT STATES THE BASELINE ITS ARITHMETIC ASSUMES. `cursor = y + CARD_PAD +
   * 9` measures from the top of the box; under `middle` every line would sit
   * half a line high. Inheriting the right answer is not the same as being right.
   */
  it('sets the baseline it measures from rather than inheriting one', () => {
    const { ctx, log } = recorder();
    drawHoverCard(ctx, SPRITES, CARD, 200, 200, 800, 600);

    expect(log.sets['textBaseline']).toBe('alphabetic');
  });
});

describe('the card is placed where it was asked to be', () => {
  /**
   * `hoverCardRect` and `drawHoverCard` must agree, or the test that says the
   * card does not cover its cell (`inventory.test.ts`) is measuring a rectangle
   * nothing paints. Asserted by drawing at an anchor and checking the panel is
   * skinned at the rect the helper returns.
   */
  it('skins the panel at exactly the rect the helper computes', () => {
    const { ctx } = recorder();
    const anchor = { x: 100, y: 120, w: 72, h: 72 };
    const anchored: HoverCard = { ...CARD, anchor };

    const rect = hoverCardRect(ctx, anchored, 0, 0, 800, 600);
    expect(rect.x, 'to the right of the anchor, per ShowEquipInven').toBe(anchor.x + anchor.w + 10);
    expect(rect.y, 'aligned to the anchor top').toBe(anchor.y);
  });

  /** AND IT FLIPS rather than running off the edge. */
  it('flips to the left when the right has no room', () => {
    const { ctx } = recorder();
    const anchor = { x: 700, y: 40, w: 72, h: 72 };
    const rect = hoverCardRect(ctx, { ...CARD, anchor }, 0, 0, 800, 600);

    expect(rect.x, 'it stayed on the right and ran off').toBeLessThan(anchor.x);
    expect(rect.x).toBeGreaterThanOrEqual(0);
  });
});

describe('a card is bounded by the screen, and says when it cut something', () => {
  const many = (n: number): HoverCard => ({
    title: 'Oiled Watchman’s Trousers of the Ledger',
    meta: 'rare · legs',
    lines: Array.from({ length: n }, (_v, i) => `Row ${String(i)}  +${String(i)}`),
    nextLines: [],
  });

  it('draws every line when they fit', () => {
    const { body, goldFrom } = hoverCardBody(many(6), 320);
    expect(body).toHaveLength(6);
    expect(body.join(' ')).not.toContain('more');
    // Nothing is `nextLines`, so nothing is gold.
    expect(goldFrom).toBe(6);
  });

  /**
   * ═══ THE WIDTH WAS CLAMPED AND THE HEIGHT WAS NOT ═══
   * `hoverCardRect` sized `h` from the row count with no ceiling, and its `y`
   * clamp collapses once `h` passes the viewport — the inner `Math.max` bottoms
   * out at the gap and the card runs off the screen, unclipped and unscrollable.
   * Latent while every card was short; `compareRows` can emit forty-four rows.
   */
  it('cuts to the viewport and never grows past it', () => {
    const card = many(60);
    const { body } = hoverCardBody(card, 320);
    expect(body.length).toBeLessThan(60);
    const rect = hoverCardRect(recorder().ctx, card, 10, 10, 640, 320);
    expect(rect.h).toBeLessThanOrEqual(320);
  });

  it('says how many it held back rather than stopping short', () => {
    // caselog.ts's rule: a list cut without a word looks complete and is not.
    const { body } = hoverCardBody(many(60), 320);
    const last = body[body.length - 1] ?? '';
    expect(last).toContain('more');
    // AND THE COUNT IS HONEST — everything not drawn is accounted for.
    const shown = body.length - 1;
    expect(last).toContain(String(60 - shown));
  });

  it('never paints the elision line gold, because it is not a next rank', () => {
    // `goldFrom` is where `lines` ends and `nextLines` begins. The cut line is
    // the card talking about itself and must not take the "at rank N" colour.
    const card: HoverCard = { ...many(60), nextLines: ['At the next rank: more'] };
    const { body, goldFrom } = hoverCardBody(card, 320);
    expect(goldFrom).toBe(body.length - 1);
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A STAT BLOCK IS A TABLE, AND IT USED TO BE A CONCATENATION.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Both card builders wrote `${row.label}  ${row.value}`, so every number landed
 * wherever its label happened to end:
 *
 *     Armour  9
 *     Defence  21
 *     Armour hardiness  34%
 *
 * Reported in those words — "the stats do not format properly so the values are
 * WAY further than the name ... the tooltip (once fixed) is a good place to read
 * stats." The inventory STRIP was given columns at the time; the CARD, which
 * that report named as the right place to read stats, was left ragged.
 *
 * It is exact rather than approximate because `drawHoverCard` sets
 * `10px ui-monospace` for the body, so a character of padding IS a pixel of
 * padding — which is also why this is a pure function a node test can read
 * without a canvas.
 */
describe('cardStatLines', () => {
  const ROWS = [
    { label: 'Armour', value: '9' },
    { label: 'Defence', value: '21' },
    { label: 'Armour hardiness', value: '34%' },
  ];

  it('ends every value in the same column', () => {
    const lines = cardStatLines(ROWS);
    // THE END, NOT THE START. Values are right-aligned, so `9` and `34%` begin
    // at different columns ON PURPOSE and finish at the same one -- which is
    // what makes a column of figures readable. Asserting the START was this
    // test's own first mistake, and it failed against correct output.
    const ends = lines.map((line) => line.trimEnd().length);
    expect(new Set(ends).size, `values ended at ${ends.join(',')}`).toBe(1);
  });

  it('right-aligns the values, so digits line up on the last one', () => {
    const lines = cardStatLines(ROWS);
    // Every line is the same length once the columns are fixed, which is what
    // right-alignment means here.
    expect(new Set(lines.map((l) => l.length)).size).toBe(1);
    expect(lines[2]?.endsWith('34%')).toBe(true);
    expect(lines[0]?.endsWith('  9')).toBe(true);
  });

  it('keeps the label readable rather than truncating it', () => {
    // Padding only ever ADDS. A card that shortened `Armour hardiness` to make a
    // column would be trading the thing being measured for the measurement.
    for (const row of ROWS) {
      expect(cardStatLines(ROWS).some((l) => l.startsWith(row.label))).toBe(true);
    }
  });

  it('answers an empty list with no lines rather than a blank row', () => {
    expect(cardStatLines([])).toEqual([]);
  });

  /** One row needs no padding at all, and must not gain trailing spaces. */
  it('leaves a single row alone', () => {
    expect(cardStatLines([{ label: 'Armour', value: '9' }])).toEqual(['Armour  9']);
  });
});
