// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/modules/tome/class/Grid.lua:52-92 (block_move, the door arms)
//              t-engine4 game/modules/tome/class/Player.lua:62 (the player opens doors by default)
//              t-engine4 game/modules/tome/class/Actor.lua:1346 (the energy charge a door-open misses)
//              t-engine4 game/modules/tome/class/NPC.lua:87-92 (the fallback that charges one anyway)
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" — https://te4.org/license

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *          A DOOR OPENS, AND THE STEP THAT OPENED IT DOES NOT HAPPEN.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ```lua
 * -- Open doors
 * if self.door_opened and e.open_door and act then
 *   ...
 *   game.level.map(x, y, engine.Map.TERRAIN, door_g)
 *   game.level.map:checkAllEntities(x, y, "on_door_opened", e)
 *   return true                                   -- <- STILL BLOCKED
 * elseif self.door_opened and not couldpass then return true
 * elseif self.door_opened and couldpass and not e.open_door then return true
 * end
 * ```
 *
 * `return true` from `block_move` means BLOCKED. So the canonical door-open is
 * not a move that succeeds: it is a move that FAILS, having changed the world on
 * its way out. You swing the door, you stay where you are, and you walk through
 * on your next step.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * IT COSTS THE PLAYER NOTHING AND IT COSTS A MONSTER ITS TURN. BOTH ARE PORTED.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * This asymmetry looks like a bug and is upstream's exact behaviour, arrived at
 * from two different directions, and it is worth the space because getting it
 * backwards would be invisible in every unit test and obvious in play.
 *
 *   THE PLAYER PAYS NOTHING. `tome/class/Actor.lua:1346` gates the energy
 *   charge on the body having actually moved:
 *
 *       if not force and moved and (self.x ~= ox or self.y ~= oy) and ...
 *
 *   A door-open returns blocked, `x`/`y` never change, and the whole
 *   `useEnergy` block is skipped. Upstream says so in its own words at
 *   `interface/PlayerExplore.lua:2563`: *"we can open it, which takes a
 *   movement action but no energy to do."*
 *
 *   A MONSTER PAYS A FULL TURN, and NOT as a special case for doors.
 *   `NPC.lua:87-92` is a blanket fallback — *"If AI did nothing, perform
 *   resting actions and then use energy anyway"* — which calls `waitTurn`
 *   (`Actor.lua:1459 self:useEnergy()`). A monster that spent its action
 *   opening a door spent no energy doing it, so it lands in that fallback and
 *   is charged. There is no equivalent on the player's side; a player is simply
 *   asked again.
 *
 * OURS FALLS OUT OF THE TWO LANES WITHOUT BEING WRITTEN DOWN ANYWHERE, which is
 * why the rule is written down HERE. A door-open is returned as a REFUSAL, and
 * `scheduler.ts` already treats a refusal differently in each lane: `actPlayer`
 * refunds and re-prompts (the refund rule), `actMonster` charges the turn and
 * emits a `blocked` step. Plugging the door into the refusal path reproduces
 * both halves of upstream at once. Returning `ok: true` would NOT: `wasStep` is
 * a negative test (`effect.kind !== 'attack'`), so a successful non-move would
 * be charged a movement point and would hold the round open in combat and spend
 * a whole turn out of it — free when it should cost, costly when it should not.
 *
 * ═══ WHAT IS NOT PORTED, AND IS NOT AN OVERSIGHT ═══
 *
 *   NO `couldpass` TRI-STATE. Upstream's second and third arms exist to serve
 *   the per-path-string FOV caches registered at `Map.lua:301-302`, which let a
 *   route probe treat a closed door as passable for an actor that can open one.
 *   We have no such cache and one predicate (`canWalk`) answers for every
 *   pathfinder on both sides of the wire, so a closed door is a wall to all of
 *   them. The consequence is real and small: a monster will not currently plan
 *   a route THROUGH a shut door, only open one it is already walking into. A
 *   shut door also blocks sight, so it rarely has a reason to want to.
 *
 *   NO `door_player_check` / `door_player_stop`. Those are the vault
 *   confirmation dialogs (`Grid.lua:66-80`), and a modal yes/no popup in a
 *   six-player co-op game is a different design problem than a door.
 *
 *   NO CLOSING. Upstream carries `door_closed` on the open half and nothing in
 *   the base game ever reads it for an ordinary door — there is no close verb.
 *   The field is ported as the `DOOR_OPEN` -> `DOOR` relationship existing in
 *   the tile pair and nothing calls it.
 */

import { tileIndex } from '../../shared/coords.ts';
import { ActorKind, TileCode } from '../../shared/protocol.ts';
import type { LevelView } from '../../shared/protocol.ts';
import type { EngineActor } from './actor.ts';

/**
 * One tile of terrain that is no longer what the generator made it.
 *
 * `code` rather than a boolean, even though the only mutation in the game today
 * is `DOOR -> DOOR_OPEN`. The client applies these by assignment into its own
 * tile array, and a boolean would make the frame a door frame — after which the
 * second kind of terrain change (a dug wall, a collapsed floor) needs a second
 * frame rather than a second value.
 */
export type TerrainChange = {
  readonly x: number;
  readonly y: number;
  readonly code: TileCode;
  /**
   * What the generator put here, so the change can be UNDONE.
   *
   * `resetFloor` exists to make a party wipe cost something and pay nothing —
   * *"the loot is wiped because a wipe must not pay"* — and an open door is
   * exactly a thing that would be kept: access bought with a turn, over a room
   * that is about to be re-stocked with monsters. Restoring it needs the code
   * that was here, and the wire's `code` field is the code that is here NOW, so
   * the two are different questions and this is the second one.
   */
  readonly was: TileCode;
};

/** Is this tile a door that is currently shut? Off-grid answers false. */
export function isClosedDoor(level: LevelView, x: number, y: number): boolean {
  return tileAtRaw(level, x, y) === TileCode.DOOR;
}

/**
 * Read a tile WITHOUT `tileAt`'s fail-closed collapse to `WALL`.
 *
 * `tileAt` is the right reader for everything that draws or walks, because an
 * unrecognised code must behave as solid. It is the WRONG reader here: this
 * function's whole job is to distinguish a door from a wall, and `tileAt` would
 * hand back `WALL` for a corrupt code and get a door opened on it.
 */
function tileAtRaw(level: LevelView, x: number, y: number): number | undefined {
  if (!Number.isInteger(x) || !Number.isInteger(y)) return undefined;
  if (x < 0 || y < 0 || x >= level.w || y >= level.h) return undefined;
  return level.tiles[tileIndex(x, y, level.w)];
}

/**
 * DOES THIS BODY KNOW HOW — `Player.lua:62` and the bestiary, in one place.
 *
 * ```lua
 * if type(t.open_door) == "nil" then t.open_door = true end
 * ```
 *
 * That line is in `Player:init`, so it is a property of BEING THE PLAYER and
 * not of any class, race or birth choice — which is why the player half here is
 * a constant and not a field. Giving `PlayerActor` an `opensDoors` flag would
 * invite somebody to author `false` on one, and there is no such detective
 * upstream and no design here that wants one.
 *
 * A monster answers from its own template, defaulting false. See
 * `MonsterActor.opensDoors` for why that default is upstream's.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THIS IS TWO OF `Grid.lua:60`'S THREE CONJUNCTS. THE THIRD IS `act`.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ```lua
 * if self.door_opened and e.open_door and act then
 * ```
 *
 *   `self.door_opened`  the tile is a door with an open form  -> `isClosedDoor`
 *   `e.open_door`       this body knows how                   -> here
 *   `act`               this is a real move, not a route probe
 *
 * THE THIRD IS THE EASIEST TO LOSE AND THE WORST TO LOSE. `act` is false when
 * the engine is merely ASKING whether a tile is passable, and a pathfinder that
 * opened every door it considered would unseal a floor by thinking about it.
 *
 * Ours is safe by CONSTRUCTION rather than by a flag, and the construction is
 * the sentence that has to stay true: the only caller of `World.openDoor` is
 * the resolution of a Move intent that has already been committed. Route probes
 * ask `aiCtxFor`'s predicate instead, which answers the same question —
 * `canOpenDoors(actor) && isClosedDoor(...)` — WITHOUT the side effect. Those
 * two being separate functions IS the `act` argument.
 */
export function canOpenDoors(actor: EngineActor): boolean {
  return actor.kind === ActorKind.Player || actor.opensDoors === true;
}
