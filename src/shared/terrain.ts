// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/modules/tome/data/general/grids/water.lua:24-31, :98-116, :136-150 (air_level, the bubble)
//              t-engine4 game/modules/tome/data/general/grids/lava.lua:24-43, :59-70 (the burn, pass_projectile)
//              t-engine4 game/modules/tome/data/general/grids/void.lua:30-42 (pass_projectile)
//              t-engine4 game/modules/tome/data/zones/infinite-dungeon/grids.lua:36-166 (door_opened is the floor)
//              t-engine4 game/modules/tome/class/Actor.lua:584-590 (who breathes what)
//              t-engine4 game/engines/default/engine/Target.lua:458-468 (terrain stops a projection)
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT A TILE DOES, BEYOND WHETHER YOU CAN WALK ON IT OR SEE THROUGH IT.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `shared/protocol.ts` answers walk, sight, memory and haunt. This file answers
 * the four terrain fields that are not those: `air_level`, `on_stand`,
 * `pass_projectile`, and which door opens into what. Every answer is a pure
 * function of the tile code, which is why a grid that hurts and its harmless
 * `_FAKE` twin are two codes rather than one code and a per-realm flag.
 *
 * Pure, like the rest of `shared/`: tables and predicates, no world. The
 * engine reads them; nothing here reads the engine.
 *
 * ═══ NOT PORTED, EACH ON PURPOSE ═══
 * A WALL'S AIR. WATER_WALL (`air_level` -20), LAVA_WALL (-20), SLIME_WALL (-20),
 * SANDWALL (-10) and OUTERSPACE (-40) all carry one. Upstream only reads air
 * under a body's feet (tome/class/Actor.lua:584), and the only bodies that
 * stand in a wall have `pass_wall` or `pass_void` (tome/class/Grid.lua:96-100).
 * Nothing here has either, so no wall is in `AIR_LEVEL`.
 *
 * `can_pass`, digging, growing, and SANDWALL's collapsing tunnel
 * (data/general/grids/sand.lua:53-92). No verb in this game digs.
 *
 * WATER_DOOR's air (data/general/grids/water.lua:68-91). The generators draw it
 * as DOOR, and DOOR has no air.
 *
 * ═══ STANDING IN FOR A GRID WITH AN EXISTING CODE ═══
 * JUNGLE draws as MIRE and TREES, AUTUMN as PLAINS and TREES, PALMTREE as
 * TREES. ICY_FLOOR (data/general/grids/ice.lua:22-32) is only reached through
 * the icy-ground event. POISON_DEEP_WATER (data/general/grids/water.lua:156-178)
 * needs the NATURE and POISON damage types, which `shared/damagetype.ts` does
 * not have. The BONE grids have no zone here to use them.
 */

import { DamageType } from './damagetype.ts';
import { TileCode, isWalkable } from './protocol.ts';

/** The only `air_condition` upstream's grids name. */
export type AirCondition = 'water';

/** A grid's `air_level` and `air_condition`. */
export type AirGrid = { readonly level: number; readonly condition?: AirCondition };

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE AIR UNDER YOUR FEET — `air_level`, per floor code.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Absent means no air rule at all, which upstream spells as a nil
 * `air_level` (tome/class/Actor.lua:585). The FAKE seabed is absent for that
 * reason: it is the same picture with the field left off
 * (data/zones/infinite-dungeon/grids.lua:262-268).
 *
 * THE BUBBLE IS POSITIVE AND NAMES NO CONDITION, so nobody breathes it in the
 * sense of `breathes` below. A body that cannot breathe there "suffocates" by
 * -15, which GIVES it air: that is how a bubble refills you.
 */
export const AIR_LEVEL: Readonly<Partial<Record<TileCode, AirGrid>>> = Object.freeze({
  // DEEP_WATER, data/general/grids/water.lua:139.
  [TileCode.POND_WATER]: Object.freeze({ level: -5, condition: 'water' }),
  // WATER_FLOOR, data/general/grids/water.lua:29.
  [TileCode.WATER_FLOOR]: Object.freeze({ level: -5, condition: 'water' }),
  // WATER_FLOOR_BUBBLE, data/general/grids/water.lua:104.
  [TileCode.WATER_FLOOR_BUBBLE]: Object.freeze({ level: 15 }),
} satisfies Partial<Record<TileCode, AirGrid>>);

/** The air rule of a code, or undefined for ground with none. Takes a wire number. */
export function airOf(code: number): AirGrid | undefined {
  return AIR_LEVEL[code as TileCode];
}

/** `resolvers.mbonus(max, add)` as written on the grid, unresolved. */
export type MBonus = readonly [max: number, add: number];

/**
 * What standing on a tile does, as data. The engine fires it; this only says
 * what it is.
 */
export type OnStand =
  | {
      readonly kind: 'burn';
      readonly type: DamageType;
      readonly mindam: MBonus;
      readonly maxdam: MBonus;
    }
  | {
      readonly kind: 'bubble';
      /** `resolvers.rngrange(4, 7)`, rolled per grid (`force_clone`). */
      readonly charges: readonly [min: number, max: number];
      /** The grid a spent bubble becomes. */
      readonly depletesTo: TileCode;
    };

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * `on_stand`, PER CODE — DATA ONLY. NOTHING FIRES IT YET.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * LAVA_FLOOR (data/general/grids/lava.lua:30-39): a FIRE projector for
 * `rng.range(mindam, maxdam)`, with `mindam = mbonus(5, 15)` and
 * `maxdam = mbonus(10, 30)`. Its faction check skips friends of the grid, and a
 * plain grid has no faction, so it burns everyone.
 *
 * WATER_FLOOR_BUBBLE (data/general/grids/water.lua:104-115): a body that cannot
 * breathe water and lacks `no_breath` spends a charge, and at zero the tile
 * becomes WATER_FLOOR. The +15 air is `AIR_LEVEL`'s, not this.
 *
 * The FAKE lava is absent because it has no `on_stand`
 * (data/zones/infinite-dungeon/grids.lua:345-353), and so is every lava upstream
 * strips it from (data/zones/charred-scar/grids.lua:21).
 */
const ON_STAND_TABLE: Partial<Record<TileCode, OnStand>> = {
  [TileCode.LAVA_FLOOR]: {
    kind: 'burn',
    type: DamageType.Fire,
    mindam: [5, 15],
    maxdam: [10, 30],
  },
  [TileCode.WATER_FLOOR_BUBBLE]: {
    kind: 'bubble',
    charges: [4, 7],
    depletesTo: TileCode.WATER_FLOOR,
  },
};
export const ON_STAND: Readonly<Partial<Record<TileCode, OnStand>>> = Object.freeze(ON_STAND_TABLE);

/**
 * `does_block_move` with `pass_projectile`: solid to a body, open to a bolt.
 * data/general/grids/lava.lua:65-66 and data/general/grids/void.lua:37-38.
 */
const PASS_PROJECTILE: ReadonlySet<number> = new Set<number>([
  TileCode.MOLTEN_LAVA,
  TileCode.OUTERSPACE,
]);

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * DOES A PROJECTION CROSS THIS TILE — engine/Target.lua:458-468.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ```lua
 * trn_block = map:checkEntity(lx, ly, engine.Map.TERRAIN, "block_move") or false
 * if trn_block then
 *   trn_pass = map:checkEntity(lx, ly, engine.Map.TERRAIN, "pass_projectile") or false
 *   if not trn_pass then -- blocked by terrain
 * ```
 *
 * Terrain stops a projection only when it blocks movement AND lacks
 * `pass_projectile`. Everything walkable passes; of the solid codes, only
 * molten lava and the void do.
 *
 * A SHUT DOOR STOPS ONE. That probe passes no `couldpass`, so the door arm of
 * `Grid:block_move` answers blocked (tome/class/Grid.lua:89). The canal and the
 * frozen sea stop one too: they are solid here and carry no `pass_projectile`.
 *
 * Fails closed: an unknown code stops a projection, as `isWalkable` would.
 */
export function passesProjectile(code: number): boolean {
  return isWalkable(code) || PASS_PROJECTILE.has(code);
}

/** The codes that are a door with an open form: upstream's `door_opened`. */
export type ClosedDoorCode = typeof TileCode.DOOR | typeof TileCode.ROCK_DOOR;

/**
 * Is this code a shut door, of either kind? Upstream asks `door_opened`
 * (tome/class/Grid.lua:60), and both DOOR and every `*_ROCK` grid carry one.
 */
export function isClosedDoorCode(code: number): code is ClosedDoorCode {
  return code === TileCode.DOOR || code === TileCode.ROCK_DOOR;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT A DOOR BECOMES WHEN IT OPENS — its `door_opened`.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * DOOR opens into DOOR_OPEN (data/general/grids/basic.lua:217-238). A rock
 * door opens into the FLOOR of the zone it stands in: GRASS_ROCK into GRASS,
 * CAVE_ROCK into CAVEFLOOR, LAVA_ROCK into LAVA_FLOOR_FAKE
 * (data/zones/infinite-dungeon/grids.lua:45, :111, :151). Which floor that is
 * belongs to the map, not the code, so the caller passes it
 * (`AuthoredMap.rockFloor`).
 *
 * Typed to take only a closed door, so there is no "not a door" answer to
 * forget to handle: ask `isClosedDoorCode` first.
 */
export function openedFormOf(code: ClosedDoorCode, rockFloor: TileCode): TileCode {
  return code === TileCode.ROCK_DOOR ? rockFloor : TileCode.DOOR_OPEN;
}

/** The two body fields upstream's breathing reads: `can_breath` and `no_breath`. */
export type Breather = {
  readonly canBreath?: { readonly water?: number };
  readonly noBreath?: boolean;
};

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * CAN THIS BODY BREATHE THIS AIR — tome/class/Actor.lua:586, negated.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ```lua
 * if not air_condition or not self.can_breath[air_condition] or self.can_breath[air_condition] <= 0 then
 *   self.is_suffocating = true
 *   self:suffocate(-air_level, ...)
 * ```
 *
 * No condition means nobody breathes it, and a count of zero is no breath.
 *
 * `no_breath` IS NOT READ HERE, and neither is it upstream at this line: it
 * stops `suffocate` itself (tome/class/Actor.lua:6726). A body with `no_breath`
 * still fails this test and still loses nothing, which is `isHazardFor`'s
 * business below.
 */
export function breathes(b: Breather, air: AirGrid): boolean {
  if (air.condition === undefined) return false;
  const can = b.canBreath?.[air.condition];
  return can !== undefined && can > 0;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * IS THIS TILE A DANGER TO THIS BODY?
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Two ways, and each is upstream's own:
 *
 * 1. It takes air the body cannot breathe, as `aiGridDamage` counts air
 *    (tome/class/interface/ActorAI.lua:675-679): only NEGATIVE air, so a bubble
 *    is not one. `no_breath` bodies lose none.
 * 2. It burns whoever stands on it (`ON_STAND` kind `burn`), whatever they
 *    breathe (:683-686).
 *
 * A MONSTER'S question. The player's clicked walk and auto-explore each ask
 * upstream's own, which differ from this and from each other: breath alone,
 * the bubble included (tome/class/Player.lua:1206-1213), and burns, any
 * `on_stand` and water (tome/class/interface/PlayerExplore.lua:1958-1966).
 *
 * A FAKE code is never a hazard. That is the reason it is a code.
 */
export function isHazardFor(code: number, b: Breather): boolean {
  const air = airOf(code);
  if (air !== undefined && air.level < 0 && b.noBreath !== true && !breathes(b, air)) {
    return true;
  }
  return ON_STAND[code as TileCode]?.kind === 'burn';
}
