// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/modules/tome/class/uiset/Minimalist.lua:1888-1897.
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A POINTER ROUTE INTO THE ESCAPE MENU.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ═══ THERE WAS NONE, AND THE MENU'S OWN CHARTER ASSUMED THERE WAS ═══
 * The escape menu opened on the Escape key and on nothing else. Its file says
 * of the RESUME row that *"a surface that changed what Escape means owes the
 * player a visible, clickable way OUT"* — and that is true and was implemented,
 * while there was no clickable way IN. A player on a touch device inside a
 * Discord Activity could reach the character sheet, the talents, the inventory
 * and the key bindings by no route at all.
 *
 * Upstream has exactly this button: `tb_mainmenu` on the Minimalist toolbar,
 * with a tooltip reading *"Left mouse to show main menu"* and a click that fires
 * `game.key:triggerVirtual("EXIT")` — the same virtual key Escape sends
 * (Minimalist.lua:1888-1897). One verb, two ways in.
 *
 * ═══ THE TOP-LEFT, WHICH IS THE ONE CORNER NOTHING ELSE CLAIMS ═══
 * The minimap owns the top right (and, being drawn later, covers the turn bar's
 * right end). The party pane is down the left edge but starts below the top HUD.
 * The hotbar and the vitals strip own the bottom. So the turn bar's left end is
 * the only always-visible chrome with room, and it is where a menu belongs in
 * more or less every interface anybody has used.
 *
 * ═══ IT IS DRAWN SEPARATELY FROM THE BAR, ON PURPOSE ═══
 * `drawTurnBar` returns early when there is no `turn` frame — a real window on
 * connect — and a way into the menu that came and went with a frame would be
 * worse than none. This draws unconditionally; the bar insets its banner by
 * `MENU_BUTTON_W` so the two share the strip the way `drawResource` and
 * `drawXpBar` share theirs, neither measuring the other.
 */

import { PALETTE } from '../render/canvas.ts';
import { TURN_BAR_H } from './turnbar.ts';
import type { PanelRect } from './panel.ts';

/** Enough for the word at `FONT`, plus a gutter each side. */
export const MENU_BUTTON_W = 40;

const FONT = 'bold 10px ui-monospace, Consolas, monospace';
const LABEL = 'MENU';

/**
 * Where it sits. A constant rect rather than a computed one: it is anchored to
 * the origin and its height IS the bar's, so nothing about the viewport can move
 * it — which is what lets the hit test and the painter agree without either
 * being handed a layout.
 */
export function menuButtonRect(): PanelRect {
  return { x: 0, y: 0, w: MENU_BUTTON_W, h: TURN_BAR_H };
}

export function menuButtonHit(px: number, py: number): boolean {
  const r = menuButtonRect();
  return px >= r.x && px < r.x + r.w && py >= r.y && py < r.y + r.h;
}

/**
 * Draw it.
 *
 * HOVER BRIGHTENS AND NOTHING ELSE MOVES. Upstream dims its button to 0.6 when
 * the pointer leaves and lifts it to 1 when it enters (:1892), which is the same
 * signal in the other direction; a control that changed SIZE on hover would move
 * the banner beside it.
 */
export function drawMenuButton(
  ctx: CanvasRenderingContext2D,
  hovered: boolean,
  /** Absent for a bar that is not drawn — the button still is. See the header. */
  barDrawn: boolean,
): void {
  const r = menuButtonRect();

  ctx.save();
  ctx.imageSmoothingEnabled = false;

  // ITS OWN GROUND WHEN THE BAR HAS NONE. With a `turn` frame the bar has
  // already filled this strip and painting it twice would be wasted; without one
  // the map is drawn right up to the top edge and the word would sit on terrain.
  if (!barDrawn) {
    ctx.fillStyle = PALETTE.INK;
    ctx.fillRect(r.x, r.y, r.w, r.h);
  }

  // A HAIRLINE ON THE INSIDE EDGE, so the button reads as a separate control
  // rather than as the first word of the banner beside it.
  ctx.fillStyle = PALETTE.SLATE;
  ctx.fillRect(r.x + r.w - 1, r.y + 2, 1, r.h - 4);

  ctx.font = FONT;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = hovered ? PALETTE.GOLD : PALETTE.GREY_HI;
  ctx.fillText(LABEL, r.x + r.w / 2, r.y + r.h / 2);

  ctx.restore();
}
