// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/modules/tome/class/Player.lua:646-663 (sight, own light, other lights)
//                       game/engines/default/engine/Map.lua:649-687 (seen and remembered)
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *          WHAT ONE BODY SEES ON THE SERVER, BY THE LIGHT THERE IS.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Upstream answers every question a player's screen asks from one map of seen
 * grids, written by that player's own vision passes (class/Player.lua:646-663):
 * which monsters are drawn, which shots, which ground. This is that map for one
 * body. Every player-facing sight question on the server reads it: the board
 * (`visibleActorIds`), shots and zones, the ground frame (`knownTile`), memory
 * and the vision frame, inspect, roamer markers and the rest interrupt. So no
 * two of them can disagree about a tile.
 *
 * THE LIGHTS ARE EVERY OTHER BODY CARRYING ONE. The eye's own light is its
 * `liteRadiusOf`, not an entry in the list. An eye that is not a body (a
 * fixture's bare tile) excludes nobody.
 */
import { liteRadiusOf, sightRadiusOf } from '../engine/derived.ts';
import { computeVision } from '../../shared/vision.ts';
import type { CombatMods } from '../engine/derived.ts';
import type { World } from '../world/world.ts';
import type { TileXY } from '../../shared/coords.ts';
import type { LightSource, Vision } from '../../shared/vision.ts';

/** A tile that sees and, when it is a body, the sheet its sight and light come from. */
export type Eye = TileXY & { readonly combat?: { readonly mods?: CombatMods } };

/** What `eye` sees in `world`, and how far from it any of that can be. */
export function visionOf(world: World, eye: Eye): Vision & { readonly reach: number } {
  const sight = sightRadiusOf(eye);
  const lite = liteRadiusOf(eye);
  const lights: LightSource[] = [];
  for (const actor of world.allActors()) {
    if (actor === eye) continue;
    const radius = liteRadiusOf(actor);
    if (radius > 0) lights.push({ x: actor.x, y: actor.y, lite: radius });
  }
  const vision = computeVision(world.level, eye, { sight, lite }, world.lit, lights);
  // THE SQUARE A FRAME MUST CUT: a carried light reaches past sight, and other
  // lights only show what sight already reaches (`computeVision`).
  return { ...vision, reach: Math.max(sight, lite) };
}
