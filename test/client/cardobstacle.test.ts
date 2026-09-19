/// <reference lib="dom" />

// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { clearOfObstacle, hoverCardRect } from '../../src/client/ui/panel.ts';
import { lootTipRect, tooltipRect } from '../../src/client/ui/tooltip.ts';
import type { HoverCard, PanelRect } from '../../src/client/ui/panel.ts';
import type { InspectView } from '../../src/shared/protocol.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A CARD IS NEVER DRAWN UNDER THE ONE THING THE CANVAS CANNOT PAINT OVER.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Reported from play: *"tooltip when hovering on the bar gets covered by the log
 * window box"*.
 *
 * ═══ AND THE FIX IS TWO THINGS, BECAUSE THE BUG WAS ═══
 * Paint order was wrong: four card paints sat at four depths inside `paintHud`,
 * and the hotbar's was cut by the opaque prose strip drawn immediately above the
 * bar and covered by the world map and the conversation window. That half is
 * pinned in test/client/hudwiring.test.ts, which is where paint order lives.
 *
 * REORDERING WAS NOT ENOUGH. The Case Log's composer strip is a real `<input>`
 * — `#cmdrow` in index.html, with an opaque VOID background, positioned over the
 * box the canvas drew. DOM beats canvas at every paint order there is, so the
 * card has to step around it. ui/caselog.ts records the same fact from the other
 * side and stops the transcript above the strip for it.
 *
 * ═══ THE THREE PLACERS, NOT ONE ═══
 * `hoverCardRect` (the hotbar, the bag, the party pane, the sheet, the minimap),
 * `tooltipRect` (a body on the board) and `lootTipRect` (a pile on the floor).
 * All three open into the band above the hotbar, which is where the composer
 * lives, so a fix in one of them would be the same bug in the other two — and
 * "fix one site" is exactly what this report asked not to happen.
 */

// A 10px monospace context is what the cards measure against; the rect functions
// that need one only ever call `measureText` and assign `font`.
const ctx = new Proxy(
  {},
  {
    get: (_t, prop: string) => (prop === 'measureText' ? () => ({ width: 60 }) : () => undefined),
    set: () => true,
  },
) as unknown as CanvasRenderingContext2D;

const VIEW_W = 800;
const VIEW_H = 480;

/**
 * THE COMPOSER, WHERE IT ACTUALLY IS. The Case Log is bottom-left and its band
 * reaches down to the hotbar (`logBand` in main.ts), so the strip is a thin row
 * across the lower-left of the screen, directly above the action bar.
 */
const COMPOSER: PanelRect = { x: 8, y: VIEW_H - 92, w: 392, h: 18 };

/** A pointer resting on a hotbar slot: bottom of the screen, left of centre. */
const ON_THE_BAR = { x: 220, y: VIEW_H - 40 };

function card(lines: number): HoverCard {
  return {
    title: 'Ward Rush',
    meta: '2 reagents · 4 turns',
    lines: Array.from({ length: lines }, (_, n) => `line ${String(n)}`),
  };
}

function inspect(): InspectView {
  return {
    id: 'm_husk_1',
    name: 'a husk',
    kind: 'monster',
    hp: 17,
    maxHp: 17,
    rows: [
      { label: 'to hit', value: '62%', emphasis: true },
      { label: 'armour', value: '3' },
    ],
    effects: [],
  };
}

const PILE = [{ name: 'a soot-stained coat', tier: 'common' }];

function overlaps(a: PanelRect, b: PanelRect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

describe('clearOfObstacle — the rule, once, for all three cards', () => {
  const box: PanelRect = { x: 100, y: 100, w: 80, h: 40 };

  it('leaves a card that does not touch the row exactly where it was', () => {
    // A rule that moved every card would be a worse bug than the one it fixes:
    // the card would drift away from the thing it describes on most of the
    // screen, all the time.
    const clear: PanelRect = { x: 400, y: 20, w: 120, h: 60 };
    expect(clearOfObstacle(clear, box, VIEW_H)).toEqual(clear);
  });

  it('is a no-op when there is no row on screen', () => {
    // The class picker, the world map and an index.html that predates M4 all
    // hide the row; main.ts passes undefined and the card places itself exactly
    // as it always did.
    const under: PanelRect = { x: 100, y: 110, w: 120, h: 60 };
    expect(clearOfObstacle(under, undefined, VIEW_H)).toEqual(under);
  });

  it('lifts a card clear of a row it overlaps, above by preference', () => {
    const under: PanelRect = { x: 100, y: 110, w: 120, h: 60 };
    const moved = clearOfObstacle(under, box, VIEW_H);
    expect(overlaps(moved, box)).toBe(false);
    expect(moved.y + moved.h, 'it went below rather than above').toBeLessThanOrEqual(box.y);
    // The card does not change SIZE or COLUMN. It is the same card, moved.
    expect({ x: moved.x, w: moved.w, h: moved.h }).toEqual({ x: under.x, w: under.w, h: under.h });
  });

  it('drops a card below the row when there is no room above it', () => {
    const high: PanelRect = { x: 0, y: 0, w: 80, h: 40 };
    const tall: PanelRect = { x: 0, y: 10, w: 120, h: 300 };
    const moved = clearOfObstacle(tall, high, VIEW_H);
    expect(overlaps(moved, high)).toBe(false);
    expect(moved.y).toBeGreaterThanOrEqual(high.y + high.h);
  });

  it('leaves the card alone rather than pushing it off the screen', () => {
    // THE CURE MUST NOT BE WORSE. A card taller than the space either side of the
    // row has nowhere to go, and a card shoved off the top to dodge a chat row is
    // a card the player cannot read at all.
    const huge: PanelRect = { x: 0, y: 0, w: 120, h: VIEW_H - 4 };
    const middle: PanelRect = { x: 0, y: VIEW_H / 2, w: 200, h: 20 };
    expect(clearOfObstacle(huge, middle, VIEW_H)).toEqual(huge);
  });
});

describe('every card the pointer opens clears the command row', () => {
  /**
   * DRIVEN AT THE POINTER POSITION THE REPORT NAMES. Hovering a hotbar slot
   * opens a card UPWARD, so its bottom edge lands in the composer's band — the
   * band the Case Log's box reaches down into. Each case first checks that the
   * card WOULD have overlapped without the rule, or it would be asserting
   * nothing.
   */
  it('the hover card — the hotbar, the bag, the pane, the sheet and the map', () => {
    const subject = card(6);
    const without = hoverCardRect(ctx, subject, ON_THE_BAR.x, ON_THE_BAR.y, VIEW_W, VIEW_H);
    expect(overlaps(without, COMPOSER), 'the fixture no longer reproduces the report').toBe(true);
    const with_ = hoverCardRect(ctx, subject, ON_THE_BAR.x, ON_THE_BAR.y, VIEW_W, VIEW_H, COMPOSER);
    expect(overlaps(with_, COMPOSER)).toBe(false);
  });

  it('the actor card — a body standing in the bottom-left of the board', () => {
    const view = inspect();
    const without = tooltipRect(view, 120, VIEW_H - 96, VIEW_W, VIEW_H);
    expect(overlaps(without, COMPOSER), 'the fixture no longer reproduces the report').toBe(true);
    expect(overlaps(tooltipRect(view, 120, VIEW_H - 96, VIEW_W, VIEW_H, COMPOSER), COMPOSER)).toBe(
      false,
    );
  });

  it('the floor card — a pile in the bottom-left of the board', () => {
    const without = lootTipRect(PILE, false, 120, VIEW_H - 96, VIEW_W, VIEW_H);
    expect(overlaps(without, COMPOSER), 'the fixture no longer reproduces the report').toBe(true);
    expect(
      overlaps(lootTipRect(PILE, false, 120, VIEW_H - 96, VIEW_W, VIEW_H, COMPOSER), COMPOSER),
    ).toBe(false);
  });

  it('holds all the way along the row, at every card height', () => {
    // WALKED, NOT SAMPLED. The card flips sides and clamps at the screen edges,
    // so the interesting failures are at the ends of the strip and at the height
    // where the card stops fitting above it.
    for (let px = 0; px <= VIEW_W; px += 40) {
      for (const height of [1, 3, 6, 12, 20]) {
        const rect = hoverCardRect(ctx, card(height), px, VIEW_H - 40, VIEW_W, VIEW_H, COMPOSER);
        // Either clear of the row, or genuinely unable to be — and the second
        // case must not happen for any card the hotbar can produce.
        expect(
          overlaps(rect, COMPOSER),
          `a ${String(height)}-line card at x=${String(px)} sits under the command row`,
        ).toBe(false);
      }
    }
  });

  it('still opens beside its anchor when the row is nowhere near it', () => {
    // An inventory cell's card is ANCHORED beside the cell rather than centred on
    // the pointer (`HoverCard.anchor`), and the row must not silently undo that.
    const anchored: HoverCard = { ...card(4), anchor: { x: 500, y: 60, w: 72, h: 72 } };
    const rect = hoverCardRect(ctx, anchored, 520, 90, VIEW_W, VIEW_H, COMPOSER);
    expect(rect.y, 'the anchored card lost its row').toBe(60);
    expect(rect.x).toBeGreaterThan(500);
  });
});

describe('main.ts hands the row to all four cards, and reads it from one place', () => {
  const CODE = readFileSync(new URL('../../src/client/main.ts', import.meta.url), 'utf8')
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      return !(trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*'));
    })
    .join('\n');

  it('reads the row once per frame and passes it to every card', () => {
    const start = CODE.indexOf('function paintPointerCards(');
    expect(start, 'paintPointerCards is gone — this guard is now blind').toBeGreaterThan(-1);
    const body = CODE.slice(start, CODE.indexOf('\n}\n', start));
    expect(body).toContain('const obstacle = domCommandRow() ?? undefined;');
    // Two `drawHoverCard` calls, one `drawTooltip`, one `drawLootTip` — four.
    expect(body.split('obstacle').length - 1, 'a card places itself without the row').toBe(5);
  });

  it('takes the rect from the same place the DOM row is placed from', () => {
    // TWO ANSWERS TO WHERE THAT ROW IS would put the card beside where the input
    // is not, which is the failure `hudLayout` and `slotRect` both exist to
    // prevent. `placeCommandLine` positions the element from
    // `caseLog.composerBox()`; so does this.
    const start = CODE.indexOf('function domCommandRow(');
    expect(start).toBeGreaterThan(-1);
    const body = CODE.slice(start, CODE.indexOf('\n}', start));
    expect(body).toContain('caseLog?.composerBox()');
    // AND IT READS THE ATTRIBUTE the two hiding mechanisms both write, rather
    // than re-deriving their disjunction and going stale when either moves.
    expect(body).toContain("cmdRowEl.hasAttribute('hidden')");
  });
});
