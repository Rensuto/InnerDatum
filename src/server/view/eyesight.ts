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
import { liteRadiusOf, sensesRadiusOf, sightRadiusOf } from '../engine/derived.ts';
import { fogHas } from '../../shared/fog.ts';
import { ActorKind } from '../../shared/protocol.ts';
import { hasLineOfSight, playerLineClear } from '../../shared/sight.ts';
import { computeVision } from '../../shared/vision.ts';
import type { CombatMods } from '../engine/derived.ts';
import type { World } from '../world/world.ts';
import type { TileXY } from '../../shared/coords.ts';
import type { LightSource, Vision } from '../../shared/vision.ts';

/** A tile that sees and, when it is a body, the sheet its sight and light come from. */
export type Eye = TileXY & { readonly combat?: { readonly mods?: CombatMods } };

/** What `eye` sees in `world`, and how far from it any of that can be. */
export function visionOf(
  world: World,
  eye: Eye,
): Vision & { readonly sight: number; readonly reach: number } {
  const sight = sightRadiusOf(eye);
  const lite = liteRadiusOf(eye);
  const senses = sensesRadiusOf(eye);
  const lights: LightSource[] = [];
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * WHERE A BODY IS STANDING — the senses pass needs it, and only it.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Upstream's `heightened_senses` callback is `if game.level.map(x, y, ACTOR)`
   * (tome/class/Player.lua:642): the map itself is asked what occupies the grid.
   * Ours is a set of indices built from the same walk that collects the lights,
   * so a sensing eye costs one pass over the actors rather than two.
   *
   * BUILT ONLY WHEN SOMETHING SENSES. Nothing in the game has `senses` unless a
   * talent granted it, and an allocation per viewer per pump for a feature
   * almost nobody has is the shape of a frame budget disappearing.
   *
   * DEAD BODIES ARE NOT OCCUPANTS. Upstream's `map(x, y, ACTOR)` returns the
   * actor registered on that grid and a corpse is removed from the map; ours
   * keeps a reaped body in `allActors` briefly, and sensing one would draw a
   * monster that is not there.
   */
  const bodies = senses > 0 ? new Set<number>() : undefined;
  for (const actor of world.allActors()) {
    if (bodies !== undefined && actor.alive) bodies.add(actor.y * world.level.w + actor.x);
    if (actor === eye) continue;
    const radius = liteRadiusOf(actor);
    if (radius > 0) lights.push({ x: actor.x, y: actor.y, lite: radius });
  }
  const vision = computeVision(
    world.level,
    eye,
    { sight, lite, senses },
    world.lit,
    lights,
    bodies === undefined ? undefined : (x, y) => bodies.has(y * world.level.w + x),
  );
  // THE SQUARE A FRAME MUST CUT: a carried light reaches past sight, and other
  // lights only show what sight already reaches (`computeVision`). `senses` is
  // capped at `sight` by `sensesRadiusOf` (tome/class/Player.lua:640), so it can
  // never widen this square and is deliberately not a third term.
  return { ...vision, sight, reach: Math.max(sight, lite) };
}

/** A body that may be drawing a line. Its `kind` decides which rule it gets. */
export type LineActor = Eye & { readonly id: string; readonly kind?: ActorKind };

/**
 * IS THE LINE FROM THIS BODY TO THIS TILE CLEAR for a shot or a talent?
 *
 * A player's is upstream's player line (`playerLineClear`): what they see now,
 * and what this level remembers for them (`World.memoryOf`). Anybody else's is
 * plain line of sight.
 */
export function lineOfSightFor(world: World, actor: LineActor, to: TileXY): boolean {
  if (actor.kind !== ActorKind.Player) return hasLineOfSight(world.level, actor, to);
  const vision = visionOf(world, actor);
  const memory = world.memoryOf(actor.id);
  const w = world.level.w;
  return playerLineClear(
    world.level,
    actor,
    to,
    vision.sight,
    (x, y) => fogHas(vision.seen, w, x, y),
    (x, y) => fogHas(memory, w, x, y),
  );
}
