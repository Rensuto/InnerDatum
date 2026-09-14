// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/engines/default/engine/Map.lua:649-687 (apply, applyLite: seen and remembered)
//                       game/modules/tome/class/Actor.lua:178 (sight radius default)
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT ONE EYE SEES, AND WHAT IT REMEMBERS — one viewer's vision, as bitsets.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Upstream keeps a per-viewer map of grids SEEN this turn and grids REMEMBERED
 * across turns, and its map writes both as the eye's FOV sweep reaches each
 * grid: `apply` marks a lit grid seen and remembered, `applyLite` marks it seen
 * and remembers it when it is lit or always remembered (Map.lua:649-687).
 * Per-player sight needs the same two sets per viewer, so they are built here,
 * once, in shared code both the server and a test can reach.
 *
 * ═══ ONE VISIBILITY RULE, NOT A SECOND ═══
 * `computeSeen` is `tilesInSight` written into a bitset. It does not decide what
 * is visible itself: a viewer whose memory used a different test than the one
 * that filters actors would be shown a monster standing on ground it had never
 * seen. `canSee` remains the rule; this only changes the shape of its answer.
 *
 * ═══ EVERY TILE COUNTS AS LIT, FOR NOW ═══
 * Until light arrives, seen implies remembered, which is upstream's rule for a
 * fully lit zone. Light will narrow what is remembered, not what is seen.
 */

import { createFog, fogHas, fogSet } from './fog.ts';
import { tilesInSight } from './sight.ts';
import type { TileXY } from './coords.ts';
import type { LevelView } from './protocol.ts';

/** The tiles `eye` sees at `sightRadius`, as a fog bitset sized to `level`. */
export function computeSeen(level: LevelView, eye: TileXY, sightRadius: number): Uint8Array {
  const seen = createFog(level.w, level.h);
  for (const tile of tilesInSight(level, eye, sightRadius)) {
    fogSet(seen, level.w, tile.x, tile.y);
  }
  return seen;
}

/**
 * Fold a seen bitset into a remembered one, in place.
 *
 * RETURNS WHETHER ANYTHING WAS NEWLY REMEMBERED, so a caller can skip work: a
 * viewer standing still must not mark a save dirty on every pump, which is the
 * same contract `revealDisc` keeps.
 *
 * THE TWO MUST DESCRIBE THE SAME LEVEL. Bitsets of different lengths are two
 * different maps, and folding one into the other would remember the wrong
 * tiles, so it throws rather than guessing.
 */
export function rememberSeen(remembered: Uint8Array, seen: Uint8Array): boolean {
  if (remembered.length !== seen.length) {
    throw new Error(
      `rememberSeen: bitsets of ${String(remembered.length)} and ${String(seen.length)} bytes describe different levels`,
    );
  }
  let changed = false;
  for (let i = 0; i < seen.length; i += 1) {
    const before = remembered[i] ?? 0;
    const after = before | (seen[i] ?? 0);
    if (after !== before) {
      remembered[i] = after;
      changed = true;
    }
  }
  return changed;
}

/** A window cut out of a level-sized bitset: where it sits, and its own bits. */
export type BitWindow = {
  readonly x0: number;
  readonly y0: number;
  readonly w: number;
  readonly h: number;
  /** One bit per tile of the window, row-major from (x0, y0). */
  readonly bits: Uint8Array;
};

/**
 * The square of `bits` within `radius` of (cx, cy), clipped to the level.
 *
 * THE VIEWER'S SIGHT NEVER REACHES PAST ITS RADIUS, so a window that size holds
 * every tile a viewer can see from where they stand, and every tile of memory
 * that standing there could have changed. The rest of a level's memory is sent
 * once, whole, when the viewer arrives (`RealmMsg.explored`).
 */
export function cutWindow(
  bits: Uint8Array,
  levelW: number,
  levelH: number,
  cx: number,
  cy: number,
  radius: number,
): BitWindow {
  const x0 = Math.max(0, cx - radius);
  const y0 = Math.max(0, cy - radius);
  const x1 = Math.min(levelW - 1, cx + radius);
  const y1 = Math.min(levelH - 1, cy + radius);
  const w = Math.max(0, x1 - x0 + 1);
  const h = Math.max(0, y1 - y0 + 1);
  const out = createFog(w, h);
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      if (fogHas(bits, levelW, x, y)) fogSet(out, w, x - x0, y - y0);
    }
  }
  return { x0, y0, w, h, bits: out };
}
