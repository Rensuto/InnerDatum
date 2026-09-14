// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/engines/default/engine/Map.lua:649-687 (apply, applyLite: seen and remembered)
//                       game/modules/tome/class/Actor.lua:178 (sight radius default)
//                       game/modules/tome/class/Player.lua:646-663 (sight, own light, other lights)
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
 * ═══ AND WITH LIGHT: `computeVision` ═══
 * Upstream's sight sees a grid only where the level lights it. A carried light
 * sees its own radius whether lit or not, and another body's light shows grids
 * already in the eye's field of view (class/Player.lua:646-663). A seen grid is
 * remembered when it is lit or its terrain is `alwaysRemembered`. So light
 * narrows both what is seen and what is kept. `computeSeen` is the all-lit case,
 * and stays the server's rule until the server switches to `computeVision`.
 */

import { createFog, fogHas, fogSet } from './fog.ts';
import { TileCode, alwaysRemembered } from './protocol.ts';
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

/** A body carrying light: where it stands and how far its light reaches. */
export type LightSource = { readonly x: number; readonly y: number; readonly lite: number };

/** What one eye sees this turn, and which of those tiles its memory keeps. */
export type Vision = {
  readonly seen: Uint8Array;
  /** The seen tiles that are lit, or whose terrain is `alwaysRemembered`. */
  readonly remember: Uint8Array;
};

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT ONE EYE SEES BY THE LIGHT THERE IS — upstream's three passes, in order.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `lit` is the level's own light, one byte a tile (`World.lit`). `radii.lite` is
 * the eye's carried light (`liteRadiusOf`). `lights` is every OTHER body carrying
 * one; the eye's own is `radii.lite`, not an entry here.
 *
 * Infravision, upstream's first pass, is not here: no character in this game
 * has a source of it yet.
 */
export function computeVision(
  level: LevelView,
  eye: TileXY,
  radii: { readonly sight: number; readonly lite: number },
  lit: Uint8Array,
  lights: readonly LightSource[],
): Vision {
  const inFov = createFog(level.w, level.h);
  const seen = createFog(level.w, level.h);
  const remember = createFog(level.w, level.h);
  const litAt = (x: number, y: number): boolean => lit[y * level.w + x] === 1;
  const kept = (x: number, y: number): boolean =>
    litAt(x, y) || alwaysRemembered(level.tiles[y * level.w + x] ?? TileCode.WALL);
  const see = (x: number, y: number, keep: boolean): void => {
    fogSet(seen, level.w, x, y);
    if (keep) fogSet(remember, level.w, x, y);
  };

  // 1. SIGHT. Every grid in view is in the field of view, but sight alone sees
  // and keeps only a lit one (engine/Map.lua:649).
  for (const tile of tilesInSight(level, eye, radii.sight)) {
    fogSet(inFov, level.w, tile.x, tile.y);
    if (litAt(tile.x, tile.y)) see(tile.x, tile.y, true);
  }

  // 2. THE EYE'S OWN LIGHT, lit or not, kept when lit or always remembered
  // (engine/Map.lua:677). Its radius is not capped by sight. No light at all
  // still shows the eye its own tile: upstream tests `lite <= 0`
  // (class/Player.lua:653), and stealth drives it far below zero.
  if (radii.lite <= 0) {
    see(eye.x, eye.y, kept(eye.x, eye.y));
  } else {
    for (const mine of tilesInSight(level, eye, radii.lite)) {
      see(mine.x, mine.y, kept(mine.x, mine.y));
    }
  }

  // 3. EVERY OTHER LIGHT, and only on grids the eye already has in view
  // (engine/Map.lua:663, class/Player.lua:656-663).
  for (const light of lights) {
    if (light.lite <= 0) continue;
    for (const theirs of tilesInSight(level, light, light.lite)) {
      if (!fogHas(inFov, level.w, theirs.x, theirs.y)) continue;
      see(theirs.x, theirs.y, kept(theirs.x, theirs.y));
    }
  }
  return { seen, remember };
}
