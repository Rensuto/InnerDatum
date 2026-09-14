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

import { createFog, fogSet } from './fog.ts';
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
