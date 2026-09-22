// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/engines/default/engine/interface/ActorProject.lua:118-135 (a projected ball)
//              t-engine4 game/engines/default/engine/interface/ActorProject.lua:66-114 (where it stops)
//              t-engine4 game/engines/default/engine/Target.lua:458-468 (`block_path`'s terrain clause)
//              t-engine4 game/engines/default/engine/Target.lua:518-565 (`block_radius`, its default)
//              t-engine4 game/engines/default/engine/utils.lua:2178-2199 (`core.fov.circle_grids`)
//              t-engine4 game/engines/default/engine/Map.lua:1103-1104 (a ground effect's ball)
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A BALL IS THE PART OF A DISC ITS CENTRE CAN REACH.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ToME never lists a ball as arithmetic. Every ball it lays goes through
 * `core.fov.calc_circle` WITH A BLOCK FUNCTION, which shadowcasts
 * (`shared/mapgen/fovcircle.ts`): a heal, a shove or a cloud reaches the tiles
 * of the disc the centre has a clear view of, and a wall's face, and nothing
 * the wall hides. Two callers, two block functions:
 *
 *   - A PROJECTED BALL — every talent `type="ball"` — is
 *     `engine/interface/ActorProject.lua:118-135`: `calc_circle` with
 *     `typ:block_radius(px, py)` as the block. `blocksProjection`.
 *   - A GROUND EFFECT'S BALL — a cloud, a death burst — is
 *     `engine/Map.lua:1103-1104`, `core.fov.circle_grids(x, y, radius, true)`,
 *     whose `true` makes the block terrain `block_move`
 *     (`engine/utils.lua:2183-2186`). `blocksMove`. So is `util.findFreeGrid`
 *     with the string `"block_move"`, which is truthy and not a function, so it
 *     takes the same branch.
 *
 * The two differ exactly where terrain blocks movement but lets a projectile
 * through: molten lava and the void (terrain.ts `PASS_PROJECTILE`). A thrown
 * ball crosses lava; a cloud stops at it.
 *
 * ═══ THE LIST IS `discTiles`'s, FILTERED, AND THE ORDER IS LOAD-BEARING ═══
 * `ballTiles` walks `discTiles(centre, radius)` — row-major, dy outer — and
 * keeps the tiles `circleCells` reached. It never takes the C's visit order
 * (octant by octant, recursion first), and it never takes `circleCells`'s own
 * list either, although that is row-major too: the filter is what makes "a
 * wall only REMOVES tiles from the list the talent always walked" true by
 * construction, and that is the argument that a wall moves a draw only when a
 * BODY stood on a tile it removed (`server/engine/zones.ts` `visibleFrom` has
 * it in full). Anything applied to this list draws in its order.
 *
 * ═══ RADIUS 1 NEVER MOVES ═══
 * Every octant's first column scans rows 0 and 1 before any exit can fire, so
 * radius 1 is the whole in-bounds 3x3 whatever blocks (fovcircle.ts, "WHAT IT
 * REACHES"). Only a ball of radius 2 or more can lose a tile to a wall.
 *
 * ═══ OFF THE MAP IS GONE, EXCEPT THE CENTRE ═══
 * `calc_circle` applies no off-map cell (`map_seen`), and both upstream callers
 * add the centre again themselves (`addGrid(stop_x, stop_y)`, and
 * `circle_grids`'s "point of origin"; a projection stopped by a wall adds the
 * wall there instead, see `ballCentre`). `discTiles` has no bounds, so a ball at
 * the edge of the map used to list tiles off it; nothing stands there, so no
 * outcome changes.
 *
 * PURE (src/shared/): the client's aim preview and the server's resolution call
 * this one function with the same block, so the stamp is the ball.
 */

import { bresenham } from './coords.ts';
import type { TileXY } from './coords.ts';
import { discTiles } from './distance.ts';
import { canWalk, tileAt } from './level.ts';
import { circleCells } from './mapgen/fovcircle.ts';
import type { Opaque } from './mapgen/fovline.ts';
import type { LevelView } from './protocol.ts';
import { passesProjectile } from './terrain.ts';

/**
 * The tiles a ball of `radius` round `centre` covers on `level`, with `block`
 * as the shadowcaster's wall: `discTiles(centre, radius)` less every tile
 * `circleCells` did not reach. Row-major, a fresh object per tile.
 *
 * - A RADIUS UNDER 1 IS THE CENTRE ALONE, as `discTiles` says and as
 *   `circle_grids` returns at radius 0 (`engine/utils.lua:2180`).
 * - A REACHED WALL IS LISTED: a heal cast in a corridor lists the corridor's
 *   walls. Nothing stands in them; a caller that draws or burns the list
 *   filters for itself (`visibleFrom` keeps `canWalk`).
 */
export function ballTiles(
  level: LevelView,
  centre: TileXY,
  radius: number,
  block: Opaque,
): TileXY[] {
  const reached = new Set<string>();
  for (const cell of circleCells(level, centre.x, centre.y, radius, block)) {
    reached.add(`${String(cell.x)},${String(cell.y)}`);
  }
  return discTiles(centre, radius).filter((tile) =>
    reached.has(`${String(tile.x)},${String(tile.y)}`),
  );
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT STOPS A PROJECTED BALL — `engine/Target.lua:518-565`, the default
 * `block_radius` every targeting table gets (`Target:getType`).
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ```lua
 * trn_block = map:checkEntity(lx, ly, engine.Map.TERRAIN, "block_move") or false
 * if trn_block then
 *   trn_pass = map:checkEntity(lx, ly, engine.Map.TERRAIN, "pass_projectile") or false
 *   if not trn_pass then blocked = true end -- blocked by terrain
 * ```
 *
 * Terrain that blocks movement AND lacks `pass_projectile`, which is
 * `passesProjectile` (terrain.ts) turned round. THE CLAUSES, ONE BY ONE:
 *   - `isBound` (:520): APPLIES, and `calc_circle` never asks about an off-map
 *     cell anyway (`map_opaque` answers it). `tileAt` calls off-map a wall, so
 *     a direct caller gets the same answer.
 *   - `no_restrict` (:521), `pass_terrain` (:525): a talent opts in. None of
 *     the balls in this game does.
 *   - `requires_knowledge` (:522): a talent opts in, and `Target:setActive`'s
 *     line that would set it for the player is commented out
 *     (`engine/Target.lua:658`). None here.
 *   - `stop_block` (:532-562): set only by the "bolt" type
 *     (`engine/Target.lua:583`). A ball is not a bolt, so bodies never stop one.
 *   - `for_highlights` (:563-564): the aim preview's call passes it, and then an
 *     UNKNOWN blocking grid does not block — the preview spills past a wall the
 *     player has never seen. NOT PORTED: the client holds the whole map and
 *     previews with this, so its stamp is the ball the server resolves, and it
 *     stops at a wall the player has not seen yet.
 *
 * A SHUT DOOR STOPS A BALL: `Grid:block_move` with no mover and no
 * `couldpass` answers blocked for a door (`tome/class/Grid.lua:89`), and
 * `isWalkable` already says so.
 */
export function blocksProjection(level: LevelView): Opaque {
  return (x, y) => !passesProjectile(tileAt(level, x, y));
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHERE A BALL AIMED AT A TILE GOES OFF: THE LAST OPEN TILE BEFORE A WALL.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A thrown ball goes off where it stopped, which is not always where it was
 * aimed. `engine/interface/ActorProject.lua:66-114` walks the line from the
 * caster toward the aim keeping two points, `stop` and `stop_radius`, and both
 * start on the caster's own tile. At each step `block_path` answers three
 * things, and for terrain that stops a projectile it answers `true, true,
 * false` (`engine/Target.lua:458-468`): blocked, hit, and NOT `hit_radius`. So
 * the walk ends there, `stop` moves onto the wall, and `stop_radius` stays on
 * the last tile before it. The ball is laid from `stop_radius` (:118-134).
 * Upstream says why in `canProject`'s note (:236-237): "a projection should hit
 * the wall, but explosions should start one tile back to avoid 'leaking'
 * through a one tile thick wall."
 *
 * ═══ WITHOUT THIS A BALL AIMED AT A WALL WENT OFF INSIDE IT ═══
 * `checkTargeting` (server/engine/talents.ts) accepts a wall as the aim: line
 * of sight leaves out both ends of the line (`hasLineOfSight`, shared/sight.ts),
 * so nothing asks about the wall. The talents laid the ball on the aim, so a
 * radius-1 Expunge aimed at a one-thick wall reached the three tiles behind it
 * (radius 1 is the whole 3x3 whatever blocks) and caught whoever stood there.
 *
 * ═══ A WALL AS THE FIRST STEP: THE CASTER'S OWN TILE ═══
 * Nothing moves `stop_radius` off the caster, so upstream sets off a ball aimed
 * at an adjacent wall on the caster. So does this: the walk stops on its first
 * step and returns `from`. Who the ball then hurts is the talent's affinity
 * (`actorsInShape`; upstream's `selffire` and `friendlyfire`, :214-215), not
 * this function's business.
 *
 * ═══ THE LINE IS THE ONE OUR LINE OF SIGHT WALKS, NOT libfov's ═══
 * Upstream walks `core.fov.line`, through `lineFOV` when the caster has one
 * (:69-73) and with a corner rule (:74-87), and the line stops at the aim
 * (`lua_fov_line_step` in src/fov.c goes no further than `dest_t` unless it is
 * asked to). This walks `bresenham`, the line `hasLineOfSight` and
 * `playerLineClear` walk, and that is the consistent choice here because the
 * aim was ACCEPTED on that line. Our line of sight has already judged its
 * interior, so the one tile on it that nothing has asked about is the end. A
 * second line could meet a wall on a tile the accepted one never crossed and
 * stop a ball whose aim the game drew as clear, and the client's preview would
 * then need that second line as well. libfov's line and its corner rule are not
 * ported, and our sight has neither.
 *
 * ═══ FORWARD FROM THE CASTER, AS UPSTREAM WALKS ═══
 * The centre is the last tile on the line before the first one a projectile
 * cannot enter, or the aim if there is none. That matters where the line
 * crosses a tile that stops a projectile and not an eye — the canal, the frozen
 * sea: our sight lets the aim across, and the ball stops at the NEAR bank, as
 * upstream's does and as our own orbs do (`blockPath`, engine/projectile.ts,
 * walks forward and stops at water). The first version walked BACK from the
 * aim and set a ball aimed over water off on the far bank — one rule for balls
 * and another for orbs. (Instant single-target talents still reach across
 * water on line of sight alone, where upstream's `hit` projection would stop at
 * the bank too; that is a separate, older divergence and not this function's.)
 *
 * NOT PORTED: `addGrid(stop_x, stop_y)` (:134) also puts the wall itself into
 * upstream's ball. Nothing stands in a wall, and the `ballTiles` list laid from
 * this centre already carries any wall face it reaches.
 *
 * PURE (src/shared/): the server's balls aimed at a tile and the client's aim
 * preview call this on the same level, so the preview is centred where the
 * ball goes off.
 */
export function ballCentre(level: LevelView, from: TileXY, to: TileXY): TileXY {
  const blocked = blocksProjection(level);
  const line = bresenham(from, to);
  let centre: TileXY = { x: from.x, y: from.y };
  for (let i = 1; i < line.length; i += 1) {
    const tile = line[i];
    if (tile === undefined) continue;
    if (blocked(tile.x, tile.y)) return centre;
    centre = { x: tile.x, y: tile.y };
  }
  return centre;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT STOPS A GROUND EFFECT'S BALL — `circle_grids(x, y, radius, true)`.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ```lua
 * -- engine/utils.lua:2183-2186
 * if type(block) == "function" then return block(_, lx, ly)
 * elseif block and game.level.map:checkEntity(lx, ly, engine.Map.TERRAIN, "block_move") then return true end
 * ```
 *
 * Terrain `block_move`, asked with no mover: `canWalk` turned round. Lava and
 * the void block this and not `blocksProjection`; that is the whole difference
 * between the two, and it is why a cloud stops at the lava a fireball crosses.
 * Sight is NOT the question: lava and solid water block movement and not the
 * eye (`SOLID_BUT_CLEAR`, protocol.ts), and a cloud stops at both.
 */
export function blocksMove(level: LevelView): Opaque {
  return (x, y) => !canWalk(level, x, y);
}
