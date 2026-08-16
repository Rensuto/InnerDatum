/// <reference lib="dom" />

import { describe, expect, it } from 'vitest';

import { tooltipRect } from '../../src/client/ui/tooltip.ts';
import type { InspectRow, InspectView } from '../../src/shared/protocol.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHERE THE HOVER CARD LANDS. NOTHING IS DRAWN
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The `/// <reference lib="dom" />` above is the same line test/client/
 * turncards.test.ts carries and for the same reason: tests compile under
 * tsconfig.server.json, whose `lib` is ES2024 with no DOM, and ui/tooltip.ts
 * names `CanvasRenderingContext2D` in its draw signature. Referencing the lib
 * lets the module's TYPES resolve. It does not conjure a canvas, and vitest.
 * config.ts is explicit that the environment is `node` with deliberately no
 * jsdom — so nothing below paints, and nothing below could.
 *
 * That is exactly why `tooltipRect` is exported at all. The card is never
 * clicked, so the box has no hit test to keep honest; what it does have is four
 * ways to be wrong that a human would only catch by noticing a card half off the
 * screen at the moment they most wanted to read it. Those four are below.
 */

/** Mirrors the module-private ROW_H in ui/tooltip.ts. One 10px line of text. */
const ROW_H = 12;

const VIEW_W = 320;
const VIEW_H = 240;

function view(rows: readonly InspectRow[], blockedReason?: string): InspectView {
  const base: InspectView = {
    id: 'actor_m_01',
    name: 'index husk',
    kind: 'monster',
    hp: 11,
    maxHp: 17,
    effects: [],
    rows,
  };
  return blockedReason === undefined ? base : { ...base, blockedReason };
}

const HIT: InspectRow = { label: 'Chance to hit', value: '68%', emphasis: true };
const DISTANCE: InspectRow = { label: 'Distance', value: '3 tiles' };
const ARMOUR: InspectRow = { label: 'Armour', value: '4' };

describe('tooltipRect — it stays on screen', () => {
  it('fits inside the viewport from any of the four corners', () => {
    const v = view([HIT, DISTANCE]);
    const corners = [
      { px: 0, py: 0 },
      { px: VIEW_W - 1, py: 0 },
      { px: 0, py: VIEW_H - 1 },
      { px: VIEW_W - 1, py: VIEW_H - 1 },
    ];

    for (const corner of corners) {
      const rect = tooltipRect(v, corner.px, corner.py, VIEW_W, VIEW_H);
      expect(rect.x).toBeGreaterThanOrEqual(0);
      expect(rect.y).toBeGreaterThanOrEqual(0);
      expect(rect.x + rect.w).toBeLessThanOrEqual(VIEW_W);
      expect(rect.y + rect.h).toBeLessThanOrEqual(VIEW_H);
    }
  });

  it('never returns a negative origin, even for a pointer off the top-left', () => {
    // The pointer can sit outside the backbuffer: the canvas is magnified by an
    // integer factor and the CSS-pixel-to-logical conversion is allowed to land
    // just outside during a drag off the element.
    const rect = tooltipRect(view([]), -40, -40, VIEW_W, VIEW_H);
    expect(rect.x).toBe(0);
    expect(rect.y).toBe(0);
  });

  it('FLIPS rather than slides at the right and bottom edges', () => {
    const v = view([HIT, DISTANCE, ARMOUR]);
    const size = tooltipRect(v, 0, 0, VIEW_W, VIEW_H);
    const px = VIEW_W - 4;
    const py = VIEW_H - 4;
    const rect = tooltipRect(v, px, py, VIEW_W, VIEW_H);

    // Flipping puts the card's far corner ON the pointer; sliding would park it
    // against the screen edge instead, which is a different tile every time and
    // drifts away from the token being described.
    expect(rect.x).toBe(px - size.w);
    expect(rect.y).toBe(py - size.h);
    expect(rect.x).not.toBe(VIEW_W - size.w);
    expect(rect.y).not.toBe(VIEW_H - size.h);
  });
});

describe('tooltipRect — its height is one row per line', () => {
  it('grows by exactly one row per InspectRow', () => {
    const none = tooltipRect(view([]), 0, 0, VIEW_W, VIEW_H);
    const one = tooltipRect(view([HIT]), 0, 0, VIEW_W, VIEW_H);
    const two = tooltipRect(view([HIT, DISTANCE]), 0, 0, VIEW_W, VIEW_H);
    const three = tooltipRect(view([HIT, DISTANCE, ARMOUR]), 0, 0, VIEW_W, VIEW_H);

    expect(one.h - none.h).toBe(ROW_H);
    expect(two.h - one.h).toBe(ROW_H);
    expect(three.h - two.h).toBe(ROW_H);
  });

  it('grows by one more row when a refusal has to be shown', () => {
    const plain = tooltipRect(view([HIT, DISTANCE]), 0, 0, VIEW_W, VIEW_H);
    const refused = tooltipRect(
      view([HIT, DISTANCE], 'too close: needs 3 tiles'),
      0,
      0,
      VIEW_W,
      VIEW_H,
    );

    // PRESENT MEANS REFUSED, and absent means the attack lands — the gateway
    // omits the key entirely rather than sending null, so this is the only
    // signal there is and the card must make room for it when it arrives.
    expect(refused.h - plain.h).toBe(ROW_H);
  });

  it('does not change height for a row that only differs in emphasis', () => {
    const plain = tooltipRect(view([{ label: 'Armour', value: '4' }]), 0, 0, VIEW_W, VIEW_H);
    const bold = tooltipRect(
      view([{ label: 'Armour', value: '4', emphasis: true }]),
      0,
      0,
      VIEW_W,
      VIEW_H,
    );

    // Bold is the same 10px face at the same leading. If this ever diverges the
    // card would jitter as the server started or stopped emphasising a number.
    expect(bold.h).toBe(plain.h);
  });
});
