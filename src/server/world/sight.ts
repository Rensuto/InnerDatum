// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/engines/default/engine/Actor.lua:47 (`self.sight = t.sight or 20`)
//                       game/engines/default/engine/Actor.lua:520 (canSee: distance AND line)
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *                    HOW FAR A BODY CAN SEE, AND PAST WHAT.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `Actor.lua:520`:
 *
 * ```lua
 * local sees_target = (self.sight and core.fov.distance(sx, sy, tx, ty) <= self.sight
 *                      or not self.sight) and ...
 * ```
 *
 * TWO TERMS, AND BOTH ARE NECESSARY. Range alone sees through walls; line alone
 * sees to the horizon. Ours had the second and not the first: `hasLineOfSight`
 * has gated combat, talents and monster AI since M2, and nothing anywhere
 * bounded how FAR a body could see.
 *
 * ═══ THE RADIUS IS UPSTREAM'S, NOT A NUMBER SOMEBODY PICKED ═══
 * `engine/Actor.lua:47` — `self.sight = t.sight or 20`. An earlier note in
 * PLAN.md called choosing it a design decision that needed deciding; it is not,
 * it is a port, and the game's whole premise is inheriting these numbers.
 *
 * On a 30x30 overworld twenty tiles is not decorative: from a corner the far
 * corner is ~42 away, so the far third of the map is out of sight before a
 * single wall is counted.
 *
 * ═══ EUCLIDEAN, BECAUSE `core.fov.distance` IS ═══
 * Not `chebyshev`, which this codebase uses for REACH — a weapon's range is a
 * king-move count and sight is a circle. Using the movement metric would make
 * the diagonal corners of a square visible at 20 while the cardinal edge at 21
 * was not, which is the wrong shape for a torch.
 */
export const SIGHT_RADIUS = 20;

import { hasLineOfSight } from './world.ts';
import type { LevelView } from '../../shared/protocol.ts';
import type { TileXY } from '../../shared/coords.ts';

/** `core.fov.distance` — the straight line between two tiles, in tiles. */
export function sightDistance(from: TileXY, to: TileXY): number {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * CAN `from` SEE `to`? Range first, then the wall test.
 *
 * RANGE FIRST BECAUSE IT IS CHEAP. `hasLineOfSight` walks a bresenham line and
 * is the expensive half; a body across the map fails on arithmetic and never
 * pays for it. `projectActors` runs this once per actor per viewer per frame.
 *
 * A BODY ON ITS OWN TILE SEES ITSELF — distance 0, and `hasLineOfSight` returns
 * true for a line of length one. Stated because the viewer is always in the set
 * this filters, and a rule that hid you from yourself would be very confusing.
 */
export function canSee(
  level: LevelView,
  from: TileXY,
  to: TileXY,
  radius: number = SIGHT_RADIUS,
): boolean {
  if (sightDistance(from, to) > radius) return false;
  return hasLineOfSight(level, from, to);
}
