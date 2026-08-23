// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/modules/tome/class/uiset/Minimalist.lua:762-830.
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * YOUR OWN LIFE, ON PERMANENT FURNITURE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ═══ THE GAP THIS CLOSES, AND HOW LARGE IT WAS ═══
 * This is a combat roguelike, and until this file there was NO SELF HP ON ANY
 * SURFACE THAT IS ALWAYS ON SCREEN. There were three copies of the number and
 * every one of them could be absent at the moment it mattered:
 *
 *   the party pane — toggled off with `p`, and it degrades to a three-pixel
 *     colour sliver with no digits once the clear map falls under 320px, then
 *     disappears entirely under 256;
 *   the turn cards — drawn ONLY in combat, so out of a fight there is nothing;
 *   the character sheet — behind a keypress.
 *
 * So a player who pressed `p`, or who is on a narrow Discord Activity window,
 * was fighting with no health readout at all. ToME makes the opposite choice
 * and makes it loudly: life is the LARGEST always-present slab in the left
 * column (Minimalist.lua:762-830), digits and all.
 *
 * ═══ WHY IT IS A STRIP WIDGET AND NOT A SLAB ═══
 * Upstream has a 1280-wide frame and spends a 158x60 plate on this. Our logical
 * floor is 640x320 and the vitals row is eighteen pixels tall — so the port is
 * the DECISION (life is permanent, and it carries digits), not the pixels. It
 * joins the row the pips and the XP track already share, at the left where the
 * eye starts.
 *
 * ═══ DIGITS ARE NOT OPTIONAL ═══
 * `24/40` is drawn always, at every width, beside the bar. A bar alone answers
 * "roughly how full" and this game is played on numbers a player can add up —
 * "can I survive another hit from that" is arithmetic, and a fill fraction
 * cannot be arithmetic'd. It is also the same rule ui/resource.ts states for
 * the pips: shape and number first, colour second.
 *
 * ═══ AND THE COLOUR IS THE PARTY PANE'S, EXACTLY ═══
 * GOLD, turning ORANGE under a third — `partypanel.ts`'s own `HP_LOW` rule.
 * Two health readouts that disagreed about when a body is in trouble would be
 * worse than one. CRIMSON is deliberately not used: `PALETTE` reserves it for
 * "hostiles are engaged" and nothing else, so that the ring around the
 * playfield answers that question from peripheral vision.
 */

import { PALETTE } from '../render/canvas.ts';

/**
 * Below this fraction the bar turns. THE PARTY PANE'S NUMBER — see the header.
 * Kept as its own constant rather than imported so that neither file's layout
 * has to reach into the other's; the pairing is stated in both headers and
 * pinned by a test.
 */
const HP_LOW = 1 / 3;

const BAR_W = 34;
const BAR_H = 10;
/** Between the bar and its digits. */
const GAP = 4;
const FONT = 'bold 10px ui-monospace, Consolas, monospace';
/** `999/999` at this font. The widest reading the widget ever has to hold. */
const DIGITS_W = 42;

/**
 * THE WHOLE WIDGET'S WIDTH, INCLUDING THE GAP AFTER IT.
 *
 * A CONSTANT AND NOT A MEASUREMENT, so the caller can offset the pips by it
 * without measuring text or calling this module first — the same arrangement
 * ui/xpbar.ts has with `drawResource`, where neither widget knows the other's
 * width. It is fixed at the widest digits rather than fitted to the current
 * ones, because a widget that narrowed as you healed would shuffle the pips
 * sideways every time you took a hit.
 */
export const LIFE_W = BAR_W + GAP + DIGITS_W + 8;

export type LifeOptions = {
  readonly ctx: CanvasRenderingContext2D;
  /** Null until the client knows which body is its own; nothing is drawn. */
  readonly hp: number | null;
  readonly maxHp: number;
  /** Top-left of the widget, in LOGICAL backbuffer pixels. */
  readonly x: number;
  readonly y: number;
};

/**
 * Draw it. Nothing at all when the client does not yet know its own body.
 *
 * THAT REFUSAL IS NOT AN EDGE CASE, and ui/xpbar.ts makes the same one for the
 * same reason: there is a real window on connect before the first `actors`
 * frame, and it is exactly when the player is staring at the screen. `0/0` in
 * that window is a wrong number stated confidently — and the wrongest one this
 * widget could pick, because it reads as dead.
 */
export function drawLife(options: LifeOptions): void {
  const { ctx, hp, maxHp, x, y } = options;
  if (hp === null || maxHp <= 0) return;

  const shown = Math.max(0, Math.ceil(hp));
  const fraction = Math.min(1, Math.max(0, hp / maxHp));
  const low = fraction <= HP_LOW;

  ctx.save();
  ctx.imageSmoothingEnabled = false;

  // The trough, then the fill inside a one-pixel inset — the party pane's own
  // bar construction, so the two read as the same instrument.
  ctx.fillStyle = PALETTE.SLATE;
  ctx.fillRect(x, y, BAR_W, BAR_H);
  const fill = Math.floor((BAR_W - 2) * fraction);
  if (fill > 0) {
    ctx.fillStyle = low ? PALETTE.ORANGE : PALETTE.GOLD;
    ctx.fillRect(x + 1, y + 1, fill, BAR_H - 2);
  }

  ctx.font = FONT;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  // THE DIGITS TAKE THE BAR'S COLOUR TOO. A player reading the number rather
  // than the bar — which is most of them, most of the time — must not have to
  // look at a second thing to learn they are in trouble.
  ctx.fillStyle = low ? PALETTE.ORANGE : PALETTE.BONE;
  ctx.fillText(`${String(shown)}/${String(maxHp)}`, x + BAR_W + GAP, y + BAR_H / 2);

  ctx.restore();
}
