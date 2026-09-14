// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT THIS VIEWER SEES AND REMEMBERS — AS THE SERVER SENT IT, NOT WORKED OUT.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The client used to decide both for itself: a sight sweep at the DEFAULT
 * radius, blind to the talents and gear that widen a viewer's sight, and a
 * disc revealed around the body that saw through walls. The server holds the
 * real answers and sends them as `VisionMsg`: a window around the viewer of
 * what they see now and what they remember. This module reads those windows;
 * nothing in it decides what is visible.
 *
 * ═══ MEMORY OUTLIVES THE WINDOW ═══
 * A window covers only the ground around the body. What was remembered further
 * away arrived on the `realm` frame, and every window's `remembered` bits are
 * added to the same set, so memory only ever grows.
 */

import { fogBytes, fogFromBase64, fogHas } from '../shared/fog.ts';
import type { VisionMsg } from '../shared/protocol.ts';

/** The latest window of sight, decoded. */
export type VisionWindow = {
  readonly realmId: string;
  readonly x0: number;
  readonly y0: number;
  readonly w: number;
  readonly h: number;
  /** One bit per tile of the window, row-major from (x0, y0). */
  readonly seen: Uint8Array;
  /** The viewer's sight radius, off the frame. */
  readonly sight: number;
};

/** What the renderer asks of a tile, in level coordinates. */
export type VisionView = {
  readonly seen: (x: number, y: number) => boolean;
  readonly remembered: (x: number, y: number) => boolean;
  /** How far this viewer's sight reaches, for a line toward what they cannot see. */
  readonly sight: number;
};

/**
 * Decode a window, and add everything it says is remembered to `memory`, keyed
 * `"x,y"` in level coordinates.
 */
export function readVisionFrame(msg: VisionMsg, memory: Set<string>): VisionWindow {
  const bytes = fogBytes(msg.w, msg.h);
  const remembered = fogFromBase64(msg.remembered, bytes);
  for (let y = 0; y < msg.h; y += 1) {
    for (let x = 0; x < msg.w; x += 1) {
      if (fogHas(remembered, msg.w, x, y)) {
        memory.add(`${String(msg.x0 + x)},${String(msg.y0 + y)}`);
      }
    }
  }
  return {
    realmId: msg.realmId,
    x0: msg.x0,
    y0: msg.y0,
    w: msg.w,
    h: msg.h,
    seen: fogFromBase64(msg.seen, bytes),
    sight: msg.sight,
  };
}

/**
 * The view the renderer draws from, or null when there is nothing to draw from:
 * no window yet, or a window for a map other than the one on screen.
 *
 * SEEN IS ONLY EVER INSIDE THE WINDOW. Everything a viewer can see from where
 * they stand is inside it, so a tile outside it is not in sight.
 */
export function visionViewOf(
  window: VisionWindow | null,
  realmId: string | null,
  memory: ReadonlySet<string> | undefined,
): VisionView | null {
  if (window === null || window.realmId !== realmId) return null;
  return {
    sight: window.sight,
    seen: (x, y) =>
      x >= window.x0 &&
      y >= window.y0 &&
      x < window.x0 + window.w &&
      y < window.y0 + window.h &&
      fogHas(window.seen, window.w, x - window.x0, y - window.y0),
    remembered: (x, y) => memory?.has(`${String(x)},${String(y)}`) === true,
  };
}
