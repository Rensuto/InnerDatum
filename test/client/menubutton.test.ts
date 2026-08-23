// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/modules/tome/class/uiset/Minimalist.lua:1888-1897.
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

/// <reference lib="dom" />
import { describe, expect, it } from 'vitest';

import { PALETTE } from '../../src/client/render/canvas.ts';
import {
  MENU_BUTTON_W,
  drawMenuButton,
  menuButtonHit,
  menuButtonRect,
} from '../../src/client/ui/menubutton.ts';
import { TURN_BAR_H } from '../../src/client/ui/turnbar.ts';

type Op = { kind: string; args: unknown[] };

function recorder(ops: Op[]): CanvasRenderingContext2D {
  return new Proxy(
    {},
    {
      get: (_t, prop: string) => {
        if (prop === 'measureText') return (text: string) => ({ width: text.length * 6 });
        return (...args: unknown[]) => {
          ops.push({ kind: prop, args });
        };
      },
      set: (_t, prop: string, value: unknown) => {
        ops.push({ kind: `set:${prop}`, args: [value] });
        return true;
      },
    },
  ) as unknown as CanvasRenderingContext2D;
}

const paint = (hovered: boolean, barDrawn: boolean): Op[] => {
  const ops: Op[] = [];
  drawMenuButton(recorder(ops), hovered, barDrawn);
  return ops;
};
const texts = (ops: Op[]) => ops.filter((o) => o.kind === 'fillText').map((o) => String(o.args[0]));
const inks = (ops: Op[]) =>
  ops.filter((o) => o.kind === 'set:fillStyle').map((o) => String(o.args[0]));

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE ESCAPE MENU HAD NO POINTER ROUTE IN.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * It opened on the Escape key and on nothing else. The menu's own file says of
 * its RESUME row that "a surface that changed what Escape means owes the player
 * a visible, clickable way OUT" — true, and implemented — while there was no
 * clickable way IN, so a pointer-only player inside a Discord Activity could
 * reach the sheet, the talents, the inventory and the key bindings by no route
 * at all.
 *
 * Upstream has exactly this button (`tb_mainmenu`), and its click fires the same
 * virtual key Escape sends.
 */
describe('the menu button', () => {
  it('sits in the top-left corner, on the bar’s own strip', () => {
    // ANCHORED TO THE ORIGIN, not to a layout: nothing about the viewport can
    // move it, which is what lets the painter and the hit test agree without
    // either being handed a rect.
    expect(menuButtonRect()).toEqual({ x: 0, y: 0, w: MENU_BUTTON_W, h: TURN_BAR_H });
  });

  it('answers the corner and nothing past it', () => {
    expect(menuButtonHit(0, 0)).toBe(true);
    expect(menuButtonHit(MENU_BUTTON_W - 1, TURN_BAR_H - 1)).toBe(true);
    expect(menuButtonHit(MENU_BUTTON_W, 0), 'one past the right edge').toBe(false);
    expect(menuButtonHit(0, TURN_BAR_H), 'one past the bottom edge').toBe(false);
    expect(menuButtonHit(-1, 0)).toBe(false);
  });

  it('says what it is, in a word', () => {
    // A CONTROL NOBODY CAN READ IS NOT ONE. Upstream leans on a tooltip because
    // its button is an icon; ours is fourteen pixels tall and a word fits.
    expect(texts(paint(false, true))).toEqual(['MENU']);
  });

  it('brightens on hover and moves nothing', () => {
    /**
     * Upstream dims to 0.6 on leave and lifts to 1 on enter (:1892) — the same
     * signal in the other direction. A control that changed SIZE on hover would
     * shove the banner beside it.
     */
    expect(inks(paint(true, true))).toContain(PALETTE.GOLD);
    expect(inks(paint(false, true))).not.toContain(PALETTE.GOLD);
    const rects = (ops: Op[]) => ops.filter((o) => o.kind === 'fillRect').length;
    expect(rects(paint(true, true))).toBe(rects(paint(false, true)));
  });

  it('paints its own ground when the bar is not drawn', () => {
    /**
     * `drawTurnBar` returns early with no `turn` frame — a real window on
     * connect — and the map is drawn right up to the top edge there, so the word
     * would sit on terrain. A route into the menu that came and went with a
     * frame would be worse than none.
     */
    const alone = paint(false, false).filter((o) => o.kind === 'fillRect');
    const withBar = paint(false, true).filter((o) => o.kind === 'fillRect');
    expect(alone.length).toBe(withBar.length + 1);
    expect(inks(paint(false, false))).toContain(PALETTE.INK);
  });
});
