// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/modules/tome/class/Player.lua:872-882 (the projectile arm of spotHostiles)
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

import type { TileXY } from './coords.ts';
import type { ProjectileView } from './protocol.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * IS THIS SHOT COMING AT ME? THE RULE A REST AND A WALK BOTH STOP FOR.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `spotHostiles` takes an `actors_only` flag, and both rest (Player.lua:973) and
 * run (:1131) pass it FALSE — so upstream stops BOTH for an inbound orb, by one
 * rule. Ours stopped a rest for it (server-side, `0dd03d8`) and let a walk carry
 * on, because the client could not reach the server's copy.
 *
 * It lives in `shared/` for the reason `hasLineOfSight` does: it is pure
 * geometry over two tiles, both sides need it, and `client -> server` is banned.
 *
 * ═══ TWO TERMS, AND NEITHER IS "IS THERE AN ORB NEARBY" ═══
 *
 *   dist_to_line  the PERPENDICULAR distance from the body to the line of
 *                 flight, `< 1.0`. An orb crossing the far side of the room on
 *                 its way somewhere else stops nobody. Upstream's own comment
 *                 says why it is a line and not a tile test: *"Bresenham is too
 *                 so check if we're anywhere near the mathematical line of
 *                 flight"* — the drawn path is a staircase, the trajectory is
 *                 not.
 *
 *   our_way       a DOT PRODUCT from the orb's CURRENT tile: is the body on the
 *                 same side as the target? An orb that has already gone past
 *                 cannot arrive, and without this term every shot that ever flew
 *                 down your corridor would keep you standing.
 *
 * ═══ `lineFrom` IS ANY POINT ON THE FLIGHT LINE, AND THE TWO CALLERS DIFFER ═══
 * Upstream divides by `core.fov.distance(sx, sy, tx, ty)` — start to target. The
 * SERVER has the origin and passes it, matching the Lua literally. The CLIENT
 * does not: `ProjectileView` carries the orb's current tile and its aim and no
 * origin at all. That costs nothing, because an orb flies a straight line and
 * its current tile is ON that line — so `at -> aim` names the same line as
 * `origin -> aim`, and the perpendicular distance to it is the same number.
 *
 * Adding an origin to the wire to make the two calls look identical would put a
 * field on every frame to serve a formula that does not need it.
 */
export function onFlightPath(lineFrom: TileXY, aim: TileXY, at: TileXY, self: TileXY): boolean {
  const flight = Math.sqrt((aim.x - lineFrom.x) ** 2 + (aim.y - lineFrom.y) ** 2);
  // A shot with nowhere left to go has no line to be near, and cannot be inbound.
  if (flight === 0) return false;

  const distToLine =
    Math.abs(
      (self.x - lineFrom.x) * (aim.y - lineFrom.y) - (self.y - lineFrom.y) * (aim.x - lineFrom.x),
    ) / flight;
  const ourWay = (self.x - at.x) * (aim.x - at.x) + (self.y - at.y) * (aim.y - at.y) > 0;
  return ourWay && distToLine < 1;
}

/**
 * How many shots in the sky are on this tile's line and still inbound.
 *
 * ═══ IT LIVES HERE AND NOT IN `client/state/projectiles.ts` ═══
 * That module is asserted by `projectiles.test.ts` to import ONLY types, so it
 * has no runtime edge at all and stays loadable from a bare node test. Putting a
 * value import into it to reach this rule would have traded that guarantee for
 * convenience, and the guard caught the attempt.
 *
 * Which is the right place anyway: the counter is one line of iteration over the
 * rule beneath it, and the rule is what has two callers.
 *
 * `orbsAimedAt` over there answers the NARROWER question — committed to the exact
 * tile you stand on — and that one is right for the counterplay sentence, whose
 * whole answer is "step off this square".
 */
export function orbsOnMyLine(projectiles: readonly ProjectileView[], tile: TileXY | null): number {
  if (tile === null) return 0;
  let count = 0;
  for (const orb of projectiles) {
    const at = { x: orb.x, y: orb.y };
    if (onFlightPath(at, { x: orb.targetX, y: orb.targetY }, at, tile)) count += 1;
  }
  return count;
}
