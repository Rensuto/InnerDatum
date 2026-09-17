// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/engines/default/engine/Astar.lua:113-193 (as reachability)
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * CAN YOU GET FROM HERE TO THERE — UPSTREAM'S QUESTION, NOT OURS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `Zone:newLevel` throws a level away when `Astar:calc` finds no way from the
 * up stair to the down stair, or from a vault's entrance to the up stair
 * (`engine/Zone.lua:1131-1158`). The A* is only asked yes or no, so its
 * heuristic and tie-breaking are irrelevant and what is left is reachability:
 *
 * - EIGHT neighbours: `util.adjacentCoords` with `forbid_diagonals` nil
 *   (`engine/Astar.lua:188`). A room joined to a corridor only at a corner is
 *   joined.
 * - A SHUT DOOR IS PASSABLE. The call passes the player with `couldpass = true`
 *   (`engine/Astar.lua:150`), and the player opens doors (`tome/class/Player.lua:62`),
 *   so `Grid:block_move` lets the route through (`tome/class/Grid.lua:89-92`).
 *   `shared/level.ts`'s `canRoute` is the same rule.
 * - THE TARGET MUST ITSELF BE PASSABLE (`engine/Astar.lua:150-153`); THE START
 *   IS NEVER TESTED. A vault entrance on a wall still reaches the stairs.
 *
 * NIL TERRAIN BLOCKS here, where upstream's `checkEntity` would call it open.
 * `toAuthoredMap` ships nil as the `'#'` wall, and a check that disagreed with
 * the map it certifies would certify the wrong map. Roomer fills every cell
 * before it does anything else, so no ported generator leaves one.
 */

import type { TileXY } from '../coords.ts';
import type { AuthoredMap } from '../level.ts';
import { isWalkable } from '../protocol.ts';
import { isClosedDoorCode } from '../terrain.ts';
import { adjacentCoords } from './dirs.ts';

/** Anything with a row-major tile grid: a `GenMap` or a `LevelView`. */
export type TileGrid = {
  readonly w: number;
  readonly h: number;
  readonly tiles: ArrayLike<number>;
};

/**
 * May a door-opening route pass this code? Unknown and nil codes may not. Any
 * shut door may, a rock door included: `Grid:block_move`'s arm keys on
 * `door_opened` (`tome/class/Grid.lua:89-92`), and `shared/terrain.ts` says
 * which codes have one.
 */
export function passable(code: number): boolean {
  return isClosedDoorCode(code) || isWalkable(code);
}

/**
 * Every cell reachable from `from`, as a row-major 0/1 mask. `from` is marked
 * whatever it is, since the start is never tested.
 */
export function reachableSet(grid: TileGrid, from: TileXY): Uint8Array {
  const seen = new Uint8Array(grid.w * grid.h);
  if (from.x < 0 || from.y < 0 || from.x >= grid.w || from.y >= grid.h) return seen;
  const queue: number[] = [from.y * grid.w + from.x];
  seen[from.y * grid.w + from.x] = 1;
  for (let head = 0; head < queue.length; head += 1) {
    const at = queue[head] ?? 0;
    const x = at % grid.w;
    const y = (at - x) / grid.w;
    for (const n of adjacentCoords(x, y)) {
      if (n.x < 0 || n.y < 0 || n.x >= grid.w || n.y >= grid.h) continue;
      const i = n.y * grid.w + n.x;
      if (seen[i] === 1 || !passable(grid.tiles[i] ?? -1)) continue;
      seen[i] = 1;
      queue.push(i);
    }
  }
  return seen;
}

/** `Astar:calc(from, to)` as a yes or no. */
export function reachable(grid: TileGrid, from: TileXY, to: TileXY): boolean {
  if (to.x < 0 || to.y < 0 || to.x >= grid.w || to.y >= grid.h) return false;
  if (!passable(grid.tiles[to.y * grid.w + to.x] ?? -1)) return false;
  return reachableSet(grid, from)[to.y * grid.w + to.x] === 1;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * SOLID ROCK WHERE NOBODY CAN GO — OUR RULE, NOT UPSTREAM'S
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `map` with every walkable cell and door its up stair (`spawns[0]`) cannot
 * reach, by the rule above, made `wall`.
 *
 * A generated level can keep ground its stairs never join: a room its tunnels
 * missed, a building with no door, a clearing ringed by trees. Upstream keeps
 * it, and a ToME player who lands there digs out. Nobody here can dig, and
 * three things put a body somewhere without walking it there: the search for a
 * free tile beside a crowded arrival (`World.findSpawn`), a teleport
 * (`talents.ts` `teleportRandom`), and a teleport trap. Nobody could see into
 * that ground either, so the floor a party walks and sees is unchanged; the
 * level only stops offering places that are not on it.
 */
export function sealUnreachable(map: AuthoredMap, wall: number): AuthoredMap {
  const up = map.spawns[0];
  if (up === undefined) return map;
  const reached = reachableSet(map.view, up);
  const tiles = map.view.tiles.map((code, i) =>
    reached[i] === 1 || !passable(code) ? code : wall,
  );
  return { ...map, view: { ...map.view, tiles } };
}

/**
 * The share of `map`'s walkable cells and doors that `sealUnreachable` would
 * make rock: 0 when its up stair reaches all of them, 1 when it reaches none,
 * and 0 for a map with no up stair or no such cell, which it leaves alone.
 */
export function sealedShare(map: AuthoredMap): number {
  const up = map.spawns[0];
  if (up === undefined) return 0;
  const reached = reachableSet(map.view, up);
  let ground = 0;
  let sealed = 0;
  map.view.tiles.forEach((code, i) => {
    if (!passable(code)) return;
    ground += 1;
    if (reached[i] !== 1) sealed += 1;
  });
  return ground === 0 ? 0 : sealed / ground;
}
