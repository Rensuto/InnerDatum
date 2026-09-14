// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/engines/default/engine/Zone.lua:1034 (`all_lited`)
//                       game/engines/default/engine/generator/map/RoomsLoader.lua:625, :652 (lit rooms)
//                       game/engines/default/engine/generator/map/Roomer.lua:34 (`lite_room_chance`)
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *               WHICH TILES A LEVEL LIGHTS ON ITS OWN.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Upstream keeps one lit flag per grid on the map (`self.lites`,
 * engine/Map.lua:216), and sight only sees and remembers a grid that is lit
 * (:652). A carried light is a separate pass. This is the level's half: set once
 * when a level is made, and never by play.
 *
 *   `all_lited` lights every grid at creation (engine/Zone.lua:1034).
 *   A room generator rolls `lite_room_chance` per room, 25 unless the zone says
 *   otherwise (engine/generator/map/Roomer.lua:34), and on a hit lights the whole
 *   room, walls and all (engine/generator/map/RoomsLoader.lua:625, :652).
 *   Nothing else a generator digs is lit this way.
 *
 * ═══ UNSET IS ALL LIT ═══
 * A site that says nothing about its light is lit everywhere, which is how every
 * level in this game has been drawn until now. Darkness is turned on per site.
 *
 * ═══ ITS OWN STREAM ═══
 * The room roll draws from a stream forked for it, never from the generator's:
 * one more draw on the map's stream would move every wall of every existing seed.
 */
import type { TileRect } from './level.ts';
import type { Rng } from './rng.ts';

/** How a site is lit. See the header. */
export type SiteLighting = {
  /** Every tile lit, whatever else is set: upstream's `all_lited`. */
  readonly allLit?: boolean;
  /** The percentage chance each carved room is lit whole. Absent lights no room. */
  readonly litRoomChance?: number;
};

/** 1 where a tile is lit and 0 where it is dark, row by row. */
export function lightLevel(
  size: { readonly w: number; readonly h: number },
  rooms: readonly TileRect[],
  lighting: SiteLighting | undefined,
  rng: Rng,
): Uint8Array {
  const lit = new Uint8Array(size.w * size.h);
  if (lighting === undefined || lighting.allLit === true) {
    lit.fill(1);
    return lit;
  }
  const chance = lighting.litRoomChance ?? 0;
  for (const room of rooms) {
    // A roll of 1 to 100 at or under the chance, as upstream's `rng.percent` is.
    if (rng.int('site.light.room', 1, 100) > chance) continue;
    for (let y = Math.max(0, room.y0); y <= Math.min(size.h - 1, room.y1); y += 1) {
      for (let x = Math.max(0, room.x0); x <= Math.min(size.w - 1, room.x1); x += 1) {
        lit[y * size.w + x] = 1;
      }
    }
  }
  return lit;
}
