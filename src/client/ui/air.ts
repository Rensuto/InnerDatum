// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/modules/tome/class/Player.lua:771-781 (`suffocate` stops a run)
//             t-engine4 game/modules/tome/data/resources.lua:45-64 (the Air resource)
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" — https://te4.org/license

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * YOUR BREATH: A SLIVER UNDER YOUR HEALTH, AND THE RULE THAT STOPS A WALK.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Air is a pool every body has (`data/resources.lua:45`), and it only ever moves
 * on ground that takes it — deep water, the seabed. `ResourceMsg.air` is absent
 * while a body is full, so everything here starts from "nothing to show".
 *
 * ═══ A SLIVER, NOT A ROW ═══
 * The self row's height is paid for band by band (`rowHeightFor` in
 * `ui/partypanel.ts`), and a band that appears only while you are wading would
 * push every row below it down and back up again as you step in and out. The
 * hp bar ends eight pixels above the pools band, so the air fits in that gap
 * and costs no layout at all.
 *
 * ═══ THE CLIENT DECIDES NOTHING HERE ═══
 * Stopping a walk is a convenience, like stopping for a hostile: the server
 * still moves the body one tile per step it is sent, and a player who walks on
 * by hand is walked on.
 */

import { PALETTE } from '../render/canvas.ts';
import type { AirView } from '../../shared/protocol.ts';

/** `0.75 * self.max_air` — Player.lua:775. Below this share of a full breath, a walk stops. */
const BREATH_STOP_SHARE = 0.75;

/** The sliver's height, in pixels. Two reads as a bar and still clears the pools band. */
export const AIR_BAR_H = 2;

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * SHOULD THIS FRAME STOP A WALK? — Player.lua:771-781.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ```lua
 * local dead, affected = mod.class.Actor.suffocate(self, value, src, death_msg)
 * if affected and value > 0 and self.runStop then
 *   if self.air < 0.75 * self.max_air and self.air < 100 then
 *     self:runStop("suffocating")
 * ```
 *
 * `affected and value > 0` is "this turn took air". The client is not told the
 * turn's terrain, so it reads the same fact off two frames: the pool went DOWN.
 * Absent before means full, so stepping into water from dry ground is a fall
 * from the ceiling. Regaining air on the way out never stops anything, which is
 * upstream's too — `value > 0` is only true while the ground is taking it.
 */
export function losingBreath(before: AirView | null, after: AirView | null): boolean {
  if (after === null) return false;
  const was = before === null ? after.max : before.cur;
  if (!(after.cur < was)) return false;
  return after.cur < BREATH_STOP_SHARE * after.max && after.cur < 100;
}

/**
 * Draw the sliver: an ink track the width of the hp bar and a silver fill for
 * what is left. Nothing at all when `air` is null — a full body.
 *
 * SILVER, NOT UPSTREAM'S `#LIGHT_STEEL_BLUE#` (data/resources.lua:46): the fact the
 * colour carries is "not health and not a class pool", and the palette's cool
 * neutral says that without a blue this HUD does not otherwise use.
 */
export function drawAirBar(
  ctx: CanvasRenderingContext2D,
  air: AirView | null,
  x: number,
  y: number,
  w: number,
): void {
  if (air === null || w <= 0) return;
  ctx.fillStyle = PALETTE.INK;
  ctx.fillRect(x, y, w, AIR_BAR_H);
  const fraction = Math.min(1, Math.max(0, air.cur / Math.max(1, air.max)));
  const fill = Math.floor(w * fraction);
  if (fill <= 0) return;
  ctx.fillStyle = PALETTE.SILVER;
  ctx.fillRect(x, y, fill, AIR_BAR_H);
}
