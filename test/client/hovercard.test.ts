import { describe, expect, it } from 'vitest';

import { drawHoverCard, hoverCardRect } from '../../src/client/ui/panel.ts';
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
