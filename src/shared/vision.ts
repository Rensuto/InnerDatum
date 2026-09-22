// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/engines/default/engine/Map.lua:649-687 (apply, applyLite: seen and remembered)
//                       game/modules/tome/class/Actor.lua:178 (sight radius default)
//                       game/modules/tome/class/Player.lua:646-663 (sight, own light, other lights)
//                       game/modules/tome/class/Player.lua:636-644 (heightened senses / infravision)
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
 * seen. `forEachInSight` (shared/sight.ts) remains the rule; this only changes
 * the shape of its answer.
 *
 * ═══ AND WITH LIGHT: `computeVision` ═══
 * Upstream's sight sees a grid only where the level lights it. A carried light
 * sees its own radius whether lit or not, and another body's light shows grids
 * already in the eye's field of view (class/Player.lua:646-663). A seen grid is
 * remembered when it is lit or its terrain is `alwaysRemembered`. So light
 * narrows both what is seen and what is kept. `computeSeen` is the all-lit case;
 * the server asks `computeVision`.
 *
 * ═══ EVERY PASS IS A SHADOWCAST AT ITS OWN RADIUS ═══
 * Each pass upstream is its own `computeFOV` (tome/class/Player.lua:636-663),
 * and `computeFOV` is libfov's `calc_circle` (engine/interface/ActorFOV.lua:49-130):
 * the rounded disc, less what `block_sight` shadows, from the pass's own
 * centre. So each is `forEachInSight` at that pass's radius from that pass's
 * centre, and none is cut out of another. They WERE the exact disc and a
 * Bresenham line per tile (`tilesInSight` said how); which tiles a pass counts
 * as lit, kept or in view did not move with the geometry.
 */

import { createFog, fogHas, fogSet } from './fog.ts';
import { TileCode, alwaysRemembered } from './protocol.ts';
import { forEachInSight, tilesInSight } from './sight.ts';
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
 * `radii.senses` is `heightened_senses` (tome/class/Player.lua:636-644) and is
 * upstream's FIRST pass, before sight and before light. Infravision shares that
 * pass upstream and has no source in this game; when one exists it is a second
 * `Math.max` argument in `sensesRadiusOf` and nothing here moves.
 *
 * @param occupied does a tile hold an actor? Upstream's senses callback is
 *   `if game.level.map(x, y, ACTOR)` and nothing else, so without this the pass
 *   cannot be written at all. Absent — a fixture, a tile that is not a body —
 *   the senses pass finds nobody, which is the right answer for an eye that is
 *   not in a world.
 */
export function computeVision(
  level: LevelView,
  eye: TileXY,
  radii: { readonly sight: number; readonly lite: number; readonly senses?: number },
  lit: Uint8Array,
  lights: readonly LightSource[],
  occupied?: (x: number, y: number) => boolean,
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

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * 0. HEIGHTENED SENSES — tome/class/Player.lua:636-644, both passes.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   *     if self:attr("infravision") or self:attr("heightened_senses") then
   *       local radius = math.max((self.heightened_senses or 0), (self.infravision or 0))
   *       radius = math.min(radius, self.sight)
   *       local rad2 = math.max(1, math.floor(radius / 4))
   *       self:computeFOV(radius, "block_sight", function(x, y, ...) if game.level.map(x, y, game.level.map.ACTOR) then game.level.map.seens(x, y, ...) end end, ...)
   *       self:computeFOV(rad2, "block_sight", function(x, y, ...) game.level.map:applyLite(x, y, ...) end, ...)
   *
   * WHAT IT IS AND WHAT IT IS NOT. The talent's own text is the specification:
   * *"allowing you to 'see' creatures in a %d radius even outside of light
   * radius. This is not telepathy, however, and it is still limited to line of
   * sight."* (cunning/survival.lua:43-44.) So:
   *
   *   IT IS BLOCKED BY WALLS. `block_sight` is the same blocker the ordinary
   *   sight pass uses, which is `forEachInSight` here. A note in
   *   `talents/overseer_of_nations.ts` used to call a second kind of sight "a
   *   system rather than a number" and deferred it on that basis; it is neither,
   *   it is this clause, and the note is corrected in that file.
   *
   *   IT SHOWS THE BODY, NOT THE ROOM. The callback fires only where an ACTOR
   *   is standing. The floor between you and it stays black, which is what makes
   *   this different from carrying a bigger lantern.
   *
   *   IT DOES NOT ENTER `inFov`. Upstream's callback is `map.seens`, not
   *   `map:apply`, so a sensed tile does not become a grid another body's light
   *   may then reveal. Clause 3 below is unaffected by it.
   *
   * REMEMBERED ON THE ORDINARY RULE (`kept`): lit or always-remembered. A body
   * sensed on unlit floor is not written into terrain memory, which is exactly
   * `darkness.test.ts`'s rule that nothing keeps dark ground.
   *
   * THE SECOND PASS IS LITE, and at `senses = 5` it is radius 1 — smaller than
   * the brass lantern every character is born with, so today it adds nothing.
   * Ported anyway because it is upstream's and it stops mattering the moment a
   * body carries darkness (`CombatMods.lite` goes negative; stealth.lua:91
   * takes a thousand off it).
   */
  const senses = radii.senses ?? 0;
  if (senses > 0 && occupied !== undefined) {
    forEachInSight(level, eye, senses, (x, y) => {
      if (occupied(x, y)) see(x, y, kept(x, y));
    });
    const rad2 = Math.max(1, Math.floor(senses / 4));
    forEachInSight(level, eye, rad2, (x, y) => {
      see(x, y, kept(x, y));
    });
  }

  // 1. SIGHT. Every grid in view is in the field of view, but sight alone sees
  // and keeps only a lit one (engine/Map.lua:649).
  forEachInSight(level, eye, radii.sight, (x, y) => {
    fogSet(inFov, level.w, x, y);
    if (litAt(x, y)) see(x, y, true);
  });

  // 2. THE EYE'S OWN LIGHT, lit or not, kept when lit or always remembered
  // (engine/Map.lua:677). Its radius is not capped by sight. No light at all
  // still shows the eye its own tile: upstream tests `lite <= 0`
  // (class/Player.lua:653), and stealth drives it far below zero.
  if (radii.lite <= 0) {
    see(eye.x, eye.y, kept(eye.x, eye.y));
  } else {
    forEachInSight(level, eye, radii.lite, (x, y) => {
      see(x, y, kept(x, y));
    });
  }

  // 3. EVERY OTHER LIGHT, and only on grids the eye already has in view
  // (engine/Map.lua:663, class/Player.lua:656-663).
  // The shadowcast is the LIGHT's own, from its tile: upstream runs
  // `e:computeFOV` (class/Player.lua:660), so a lantern round a corner lights
  // what IT reaches, and the eye's view decides only which of those it shows.
  for (const light of lights) {
    if (light.lite <= 0) continue;
    forEachInSight(level, light, light.lite, (x, y) => {
      if (fogHas(inFov, level.w, x, y)) see(x, y, kept(x, y));
    });
  }
  return { seen, remember };
}
