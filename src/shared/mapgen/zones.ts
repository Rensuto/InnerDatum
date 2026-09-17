// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/engines/default/engine/Zone.lua:833-843 (getLevelData: levels[n] merged)
//   and game/modules/tome/data/zones/halfling-ruins/zone.lua:20-96 (site:drowned_chapel),
//   game/modules/tome/data/zones/orc-breeding-pit/zone.lua:20-84 (site:underworks),
//   game/modules/tome/data/zones/old-forest/zone.lua:23-86 (site:barrow_end),
//   game/modules/tome/data/zones/heart-gloom/zone.lua:23-96 (site:cairnfoot),
//   game/modules/tome/data/zones/lake-nur/zone.lua:23-118 (site:the_weir),
//   game/modules/tome/data/zones/rhaloren-camp/zone.lua:20-172 (site:watchers_altar),
//   game/modules/tome/data/zones/ardhungol/zone.lua:20-71 (site:hollow_mine),
//   game/modules/tome/data/zones/maze/zone.lua:133-189 (site:outer_index),
//   game/modules/tome/data/zones/scintillating-caves/zone.lua:20-73 (site:glass_archive),
//   game/modules/tome/data/zones/infinite-dungeon/zone.lua:23-259 (site:gearford_ward),
//   game/modules/tome/data/zones/trollmire/zone.lua:151-242 (site:blackwood_outskirts),
//   with the grids they name: game/modules/tome/data/general/grids/underground_gloomy.lua:20-74,
//   game/modules/tome/data/general/grids/crystal.lua:20-44,
//   game/modules/tome/data/general/grids/water.lua:24-116 and :136-140
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * EVERY DELVE IS A ZONE: WHICH TOME ZONE EACH SITE IS BUILT AS, FLOOR BY FLOOR
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A ToME zone is a table (`data/zones/<name>/zone.lua`) whose `generator.map`
 * names a generator class and its parameters, whose `levels[n]` overrides that
 * table for one level (`engine/Zone.lua:833-843` deep-merges it), and whose
 * `all_lited` says whether the level is lit before anybody brings a light. Each
 * site here is one such zone, and each of its floors one of the zone's levels:
 *
 *   site                    zone                               generator
 *   The Drowned Chapel      Ruined halfling complex            Town, then Roomer
 *   The Underworks          Orc breeding pits                  Cavern
 *   Barrow End              Old Forest                         Roomer of clearings
 *   Cairnfoot               Heart of the Gloom                 Octopus
 *   The Weir                Lake of Nur, level 2               Roomer
 *   The Watcher's Altar     Rhaloren Camp, over then under     Town, then Roomer
 *   The Hollow Mine         Ardhungol                          Cavern, 60x60 then 40x40
 *   The Outer Index         The Maze                           Maze, 60x60
 *   The Glass Archive       Scintillating Caves, twisted       Roomer, 30x30
 *   Gearford Industrial     Infinite Dungeon, "building"       Building, rolled per floor
 *   Blackwood Outskirts     Trollmire                          Forest, 65x40
 *
 * The Undermost is not here: its two cave floors are `shared/sitemap.ts`'s
 * cave and its third is drawn by hand (`server/world/realms.ts`).
 *
 * ═══ A FLOOR IS A LEVEL, AND A LEVEL THIS PORT CANNOT BUILD IS SKIPPED ═══
 * Floor n is `floors[n - 1]`; a floor past the end is the last entry, which is
 * how a Redaction twin a floor deeper than its original gets one. What is NOT
 * an entry, each named where it is skipped:
 * - A STATIC level (a `map = "zones/..."` file): those are authored maps, and
 *   none is ported.
 * - A level SMALLER THAN 30x30: `populateDelve` keeps every body eight cells
 *   from the arrival (`DOOR_CLEARANCE`), which a 15x15 or 20x20 floor cannot
 *   hold. The zone's nearest larger level stands in.
 *
 * ═══ THE GRIDS ARE THE SITE'S PALETTE ═══
 * Every key a zone names is here, as the code the site draws it in: its floor
 * grids are the palette's floor, its wall grids the palette's wall, a door is
 * DOOR and a stair is the floor a stair marker stands on. Where the zone's own
 * floor and wall have codes, the palette IS those codes — Cairnfoot's is
 * UNDERGROUND_FLOOR and UNDERGROUND_TREE, the Glass Archive's CRYSTAL_FLOOR and
 * CRYSTAL_WALL, the Weir's WATER_FLOOR and WATER_WALL — and the site's row
 * names the same two (`server/world/realms.ts` refuses one that does not). A
 * grid that is neither the floor nor the wall and has a code of its own is that
 * code in any palette: TREE is TREES, WATER_FLOOR_BUBBLE the bubble, DEEP_WATER
 * POND_WATER. ToME's own terrain that has no code yet stands in as:
 *
 *   GRASS, FLOWER, UNDERGROUND_CREEP, WORMHOLE, OLD_FLOOR,
 *   CAVEFLOOR, UNDERGROUND_FLOOR (breeding pits)         -> palette floor
 *   OLD_WALL, CAVEWALL, UNDERGROUND_TREE (breeding pits) -> palette wall
 *   WATER_DOOR                                          -> DOOR
 *   GRASS_ROAD_DIRT                                     -> palette floor
 *
 * A KEY STAYS THE SHAPE UPSTREAM GAVE IT, because the shape is the draw. A
 * table of eleven grids draws once every resolve whatever the eleven are, and a
 * function that rolls a chance rolls it whichever grid it returns
 * (`engine/Generator.lua:59-77`). So Heart of the Gloom's wall is still twelve
 * entries and the Trollmire's floor still rolls `rng.chance(20)` for a flower
 * it no longer draws: a substitution changes what a cell looks like, never how
 * many numbers building it spent.
 *
 * ═══ REAL WATER WHERE UPSTREAM'S IS REAL ═══
 * A water grid is the code that carries its air (`shared/terrain.ts`), never
 * its harmless `_FAKE` twin, wherever the zone draws the real grid: the Lake of
 * Nur's second level is WATER_FLOOR a body drowns in, with a bubble in every
 * eleven resolves and the underwater aura on everybody (`ZoneLevel.effects`),
 * and the Trollmire digs its ponds of POND_WATER again. The water door is the
 * one grid that loses its air: see the Weir.
 *
 * ═══ `forceLastStair` ON EVERY TABLE ═══
 * Upstream's `max_level` decides which level has no way down. Here the realm
 * decides whether a floor has one (`server/world/realms.ts`), so every table
 * places a down stair and the realm uses it or not — as `ROOMER_RUINS_KOR_PUL`
 * does (`mapgen/level.ts`).
 *
 * ═══ A LEVEL IS ONLY ITS CERTIFIED GROUND ═══
 * `zoneLevel` builds through `keepTrying`, so no floor ships whose stairs or
 * vault entrances upstream's check would refuse, and then makes rock of every
 * cell the up stair cannot reach (`sealUnreachable`, `mapgen/connectivity.ts`).
 * A level that seal would cut to less than half of itself is refused first,
 * which upstream never does (`MAX_SEALED_SHARE`).
 */

import type { Rng } from '../rng.ts';
import { createRng } from '../rng.ts';
import type { SiteLighting } from '../light.ts';
import type { AuthoredMap } from '../level.ts';
import { TileCode } from '../protocol.ts';
import type { SitePalette } from '../sitemap.ts';
import { VAULTS_BY_SHAPE } from '../vaults.ts';
import {
  BUILDING_INFINITE_DUNGEON,
  infiniteDungeonBuilding,
  infiniteDungeonSize,
} from './building.ts';
import { sealUnreachable, sealedShare } from './connectivity.ts';
import { ROOMER_OLD_FOREST, FOREST_TROLLMIRE } from './forest.ts';
import { CAVERN_ORC_BREEDING_PIT, keepTrying } from './level.ts';
import type { BuildingMapSpec, CavernMapSpec, LevelSpec, RoomerMapSpec } from './level.ts';
import { chance, percent } from './lua.ts';
import { MAZE_THE_MAZE } from './maze.ts';
import { OCTOPUS_HEART_GLOOM } from './octopus.ts';
import { TOWN_HALFLING_RUINS, TOWN_RHALOREN_CAMP } from './town.ts';

/**
 * How a level is lit before anybody brings a light.
 *
 * - `'all_lited'`: every grid (`engine/Zone.lua:1034`).
 * - `{ litRoomChance }`: each room the generator places is lit whole on that
 *   percent — the table's `lite_room_chance`, or the generator's default as it
 *   reads one. A generator that places no room lights nothing whatever the
 *   number; one that never reads the chance (Maze) carries none.
 * - `'rolled'`: the chance is rolled with the rest of the level's table, and
 *   read back off it (`ZoneLevel.alter`).
 */
export type ZoneLighting = 'all_lited' | { readonly litRoomChance?: number } | 'rolled';

/** One level of an upstream zone, as a floor builds it. */
export type ZoneLevel = {
  /** The zone's directory, and its layout where `alternateZone` picks one. */
  readonly zone: string;
  /** Which of the zone's levels this is: upstream's `lev`. */
  readonly level: number;
  /** The zone's `max_level`. */
  readonly maxLevel: number;
  readonly lighting: ZoneLighting;
  /** `getLevelData(lev)`'s `width`, `height` and `generator.map`, in a palette. */
  readonly table: (palette: SitePalette) => LevelSpec;
  /**
   * `alter_level_data(zone, lev, data)`, for a zone that rolls its table each
   * level change: the rolled table, which replaces `table`. Called once a
   * `keepTrying` round, with a stream of that round's own.
   */
  readonly alter?: (palette: SitePalette, rng: Rng, lev: number) => LevelSpec;
  /**
   * `levels[n].effects`: the zone-wide auras the level lays on every body in it,
   * as the server's effect ids (`AuthoredMap.zoneEffects`). Absent is none.
   */
  readonly effects?: readonly string[];
};

/** A site's zone. */
export type ZoneDef = {
  /** The zone's own `name`. */
  readonly name: string;
  /**
   * The site's floor and wall (`server/world/realms.ts`), which every floor and
   * wall key is drawn in: the zone's own primary floor and wall where those have
   * codes, and the site's stand-ins where they do not.
   */
  readonly palette: SitePalette;
  /** Floor n is entry n - 1; past the end, the last entry. */
  readonly floors: readonly ZoneLevel[];
};

/** `n` copies of `code`: an upstream grid table's length, kept for its draws. */
function repeat(code: TileCode, n: number): readonly TileCode[] {
  return Array.from({ length: n }, () => code);
}

/** The drawn rooms a ruin's zone rolls its lesser vaults from (`shared/vaults.ts`). */
const RUIN_VAULTS: readonly string[] = (VAULTS_BY_SHAPE['ruin'] ?? []).map((v) => v.id);

// ═══════════════════════════════════════════════════════════════════════════
// THE DROWNED CHAPEL — the Ruined halfling complex
// ═══════════════════════════════════════════════════════════════════════════

/**
 * `data/zones/halfling-ruins/zone.lua:34-47`, the zone's own Roomer: 50x50, ten
 * rooms of `random_room` with a 5-weighted money vault and an 8-weighted lesser
 * vault, every room lit, and the default door, stair and wall grids. Levels 2
 * and 3 have no override, so this is both.
 */
function halflingRuinsRoomer(p: SitePalette): LevelSpec {
  return {
    width: 50,
    height: 50,
    map: {
      class: 'Roomer',
      nbRooms: 10,
      rooms: ['random_room', ['money_vault', 5], ['lesser_vault', 8]],
      lesserVaultsList: RUIN_VAULTS,
      liteRoomChance: 100,
      forceLastStair: true,
      grid: { '.': p.floor, '#': p.wall, up: p.floor, down: p.floor, door: TileCode.DOOR },
    },
  };
}

/**
 * `data/zones/halfling-ruins/zone.lua:63-79`, level 1: a Town merged over the
 * Roomer (`TOWN_HALFLING_RUINS`, `mapgen/town.ts`). FLOOR inside and out, so a
 * building is only its walls and its door.
 */
function halflingRuinsTown(p: SitePalette): LevelSpec {
  return {
    ...TOWN_HALFLING_RUINS,
    map: {
      ...TOWN_HALFLING_RUINS.map,
      grid: {
        floor: p.floor,
        external_floor: p.floor,
        up: p.floor,
        wall: p.wall,
        down: p.floor,
        door: TileCode.DOOR,
        '.': p.floor,
        '#': p.wall,
      },
    },
  };
}

/**
 * Level 1 the Town, levels 2 and 3 the Roomer, all lit (`:30`). Level 4 is a
 * static map (`:81-95`) and not ported; `max_level` is 4 (`:24`).
 */
const DROWNED_CHAPEL: ZoneDef = {
  name: 'Ruined halfling complex',
  palette: { floor: TileCode.SHORE, wall: TileCode.TERRACE },
  floors: [
    {
      zone: 'halfling-ruins',
      level: 1,
      maxLevel: 4,
      lighting: 'all_lited',
      table: halflingRuinsTown,
    },
    {
      zone: 'halfling-ruins',
      level: 2,
      maxLevel: 4,
      lighting: 'all_lited',
      table: halflingRuinsRoomer,
    },
    {
      zone: 'halfling-ruins',
      level: 3,
      maxLevel: 4,
      lighting: 'all_lited',
      table: halflingRuinsRoomer,
    },
  ],
};

// ═══════════════════════════════════════════════════════════════════════════
// THE UNDERWORKS — the Orc breeding pits
// ═══════════════════════════════════════════════════════════════════════════

/**
 * `data/zones/orc-breeding-pit/zone.lua:34-44`: `CAVERN_ORC_BREEDING_PIT`
 * (`mapgen/level.ts`). UNDERGROUND_FLOOR and its door are the palette's floor,
 * UNDERGROUND_TREE its wall.
 */
function orcBreedingPit(p: SitePalette): LevelSpec {
  return {
    ...CAVERN_ORC_BREEDING_PIT,
    map: {
      ...CAVERN_ORC_BREEDING_PIT.map,
      grid: { floor: p.floor, wall: p.wall, up: p.floor, down: p.floor, door: p.floor },
    },
  };
}

/**
 * Not lit (`:30` is commented out), and Cavern places no room, so nothing is:
 * the chance is `RoomsLoader`'s default (`engine/generator/map/RoomsLoader.lua:625`),
 * read by no room. Level 1 is a static map (`:75-82`) and level 3 a 15x15 den
 * (`:83`), so every floor is level 2.
 */
const UNDERWORKS: ZoneDef = {
  name: 'Orc breeding pits',
  palette: { floor: TileCode.SOOT, wall: TileCode.CRAG },
  floors: [
    {
      zone: 'orc-breeding-pit',
      level: 2,
      maxLevel: 3,
      lighting: { litRoomChance: 100 },
      table: orcBreedingPit,
    },
  ],
};

// ═══════════════════════════════════════════════════════════════════════════
// BARROW END — the Old Forest
// ═══════════════════════════════════════════════════════════════════════════

/**
 * `data/zones/old-forest/zone.lua:42-55`: `ROOMER_OLD_FOREST` (`mapgen/forest.ts`),
 * eleven clearings and lesser vaults in solid trees, stairs on the left and
 * right edges. GRASS is the palette's floor, TREE is TREES.
 */
function oldForest(p: SitePalette): LevelSpec<RoomerMapSpec> {
  return {
    ...ROOMER_OLD_FOREST,
    map: {
      ...ROOMER_OLD_FOREST.map,
      grid: { '.': p.floor, '#': TileCode.TREES, up: p.floor, down: p.floor, door: p.floor },
    },
  };
}

/**
 * `levels[4]` (`data/zones/old-forest/zone.lua:79-85`): the stairs leave by the
 * BOTTOM edge instead, down to the lake. The lake is a stair marker here.
 */
function oldForestLast(p: SitePalette): LevelSpec {
  const table = oldForest(p);
  return { ...table, map: { ...table.map, edgeEntrances: [4, 2] } };
}

/**
 * All lit (`:32`). Levels 1 to 3 differ only in level 1's up stair grid, a
 * marker here; level 4, the zone's last (`:27`), is the only floor a Redaction
 * twin reaches that its original does not.
 */
const BARROW_END: ZoneDef = {
  name: 'Old Forest',
  palette: { floor: TileCode.GREEN, wall: TileCode.TREES },
  floors: [
    { zone: 'old-forest', level: 1, maxLevel: 4, lighting: 'all_lited', table: oldForest },
    { zone: 'old-forest', level: 2, maxLevel: 4, lighting: 'all_lited', table: oldForest },
    { zone: 'old-forest', level: 3, maxLevel: 4, lighting: 'all_lited', table: oldForest },
    { zone: 'old-forest', level: 4, maxLevel: 4, lighting: 'all_lited', table: oldForestLast },
  ],
};

// ═══════════════════════════════════════════════════════════════════════════
// CAIRNFOOT — the Heart of the Gloom
// ═══════════════════════════════════════════════════════════════════════════

/**
 * `data/zones/heart-gloom/zone.lua:39-73`: `OCTOPUS_HEART_GLOOM`
 * (`mapgen/octopus.ts`). `'#'` stays twelve entries — one TREE, which is TREES,
 * and eleven UNDERGROUND_TREE, the palette's wall — and `'.'` eight: seven
 * UNDERGROUND_FLOOR, the palette's floor, and an UNDERGROUND_CREEP, which is the
 * floor too (`data/general/grids/underground_gloomy.lua:35-44`). The creep is a
 * picture and a `grow = "TREE"`, and nothing here grows. The ladders stand on
 * the floor, and `door` IS the floor (`:72`), so no door is ever hung.
 */
function heartGloom(p: SitePalette): LevelSpec {
  return {
    ...OCTOPUS_HEART_GLOOM,
    map: {
      ...OCTOPUS_HEART_GLOOM.map,
      grid: {
        '#': [TileCode.TREES, ...repeat(p.wall, 11)],
        '.': repeat(p.floor, 8),
        up: p.floor,
        down: p.floor,
        door: p.floor,
      },
    },
  };
}

/**
 * All lit (`:34`); `max_level` 3 (`:27`); level 1 changes only the up ladder's
 * grid. Drawn in the gloom's own codes (`data/general/grids/underground_gloomy.lua:20-74`),
 * which carry no air and no `on_stand`: identity, not mechanics.
 */
const CAIRNFOOT: ZoneDef = {
  name: 'Heart of the Gloom',
  palette: { floor: TileCode.UNDERGROUND_FLOOR, wall: TileCode.UNDERGROUND_TREE },
  floors: [
    { zone: 'heart-gloom', level: 1, maxLevel: 3, lighting: 'all_lited', table: heartGloom },
    { zone: 'heart-gloom', level: 2, maxLevel: 3, lighting: 'all_lited', table: heartGloom },
    { zone: 'heart-gloom', level: 3, maxLevel: 3, lighting: 'all_lited', table: heartGloom },
  ],
};

// ═══════════════════════════════════════════════════════════════════════════
// THE WEIR — the Lake of Nur, its first submerged level
// ═══════════════════════════════════════════════════════════════════════════

/**
 * `data/zones/lake-nur/zone.lua:40-51`: 50x50, ten `random_room`s and nothing
 * else, NO room lit, and a floor that is a table of eleven — ten WATER_FLOOR, the
 * palette's floor, and a WATER_FLOOR_BUBBLE — so every floor resolve draws, and
 * one in eleven lands on the bubble.
 *
 * WET. WATER_FLOOR takes 5 air a turn from anybody who does not breathe water,
 * the bubble gives 15 until its charges run out, and the up and down stairs
 * (WATER_UP and WATER_DOWN, `data/general/grids/water.lua:198-220`, both
 * `air_level -5`) are markers on the water floor, so the arrival is underwater
 * too. See `shared/terrain.ts` and `server/engine/onstand.ts`.
 *
 * ONE GRID LOSES ITS AIR: WATER_DOOR, and the open door it becomes, carry
 * `air_level -5` (`data/general/grids/water.lua:68-91`), and both are DOOR and
 * DOOR_OPEN here, which carry none. A body standing in an open doorway breathes.
 * WATER_WALL's air is a wall's, and not ported (`shared/terrain.ts`).
 *
 * AND THAT DOORWAY IS THE ONLY CURE ON THE LEVEL. Upstream every walkable grid
 * here has an `air_level`, the bubble's included, so once SUFFOCATING starts it
 * cannot end on this floor (D5-6: `is_suffocating` holds on any air level,
 * tome/class/Actor.lua:584-590). Here an open doorway ends it on the first base
 * turn stood in, and refills the lungs 3 a turn, which makes the Weir easier to
 * survive than the Lake of Nur is. Known and kept until the Weir gets a water
 * door of its own.
 */
function lakeNur(p: SitePalette): LevelSpec {
  return {
    width: 50,
    height: 50,
    map: {
      class: 'Roomer',
      nbRooms: 10,
      rooms: ['random_room'],
      liteRoomChance: 0,
      forceLastStair: true,
      grid: {
        '.': [...repeat(p.floor, 10), TileCode.WATER_FLOOR_BUBBLE],
        '#': p.wall,
        up: p.floor,
        down: p.floor,
        door: TileCode.DOOR,
      },
    },
  };
}

/**
 * `EFF_ZONE_AURA_UNDERWATER` (`data/timed_effects/other.lua:2899-2916`) as the
 * server names it (`EffectId.ZoneAuraUnderwater`, `server/content/effects.ts`),
 * which `shared/` may not import.
 */
const ZONE_AURA_UNDERWATER = 'effect:zone_aura_underwater';

/**
 * Level 2 for every floor, as the design chose it: `underwater`, with the
 * underwater aura on every body (`levels[2]`, `:86-94`). `underwater = true`
 * itself only picks a shader (`tome/class/Player.lua:488`) and is not carried. The
 * level's actor filter, `special_rarity = "water_rarity"` (`:91`), is the
 * population's business: `server/content/delve.ts` gives the Weir a roster of
 * three of the creatures that filter admits (`WEIR`), since a delve names its
 * roster rather than filtering one.
 *
 * Level 1 is a static map (`:67-85`). Level 3 (`:95-118`) is the same Roomer with
 * its grids swapped by layout and a Sher'Tul fortress for its way down — which
 * could be a stair marker, as Barrow End's lake is — and is not built here only
 * because it was not chosen. Not lit: `all_lited` is commented out (`:32`) and
 * only level 1 sets it (`:68`). `max_level` 3 (`:27`).
 */
const THE_WEIR: ZoneDef = {
  name: 'Lake of Nur',
  palette: { floor: TileCode.WATER_FLOOR, wall: TileCode.WATER_WALL },
  floors: [
    {
      zone: 'lake-nur',
      level: 2,
      maxLevel: 3,
      lighting: { litRoomChance: 0 },
      table: lakeNur,
      effects: [ZONE_AURA_UNDERWATER],
    },
  ],
};

// ═══════════════════════════════════════════════════════════════════════════
// THE WATCHER'S ALTAR — the Rhaloren Camp, above ground and then below it
// ═══════════════════════════════════════════════════════════════════════════

/**
 * `data/zones/rhaloren-camp/zone.lua:111-131`, the OVERGROUND layout:
 * `TOWN_RHALOREN_CAMP` (`mapgen/town.ts`), stone buildings on grass where one
 * cell in sixteen is a tree. FLOOR and GRASS are the palette's floor, WALL its
 * wall, TREE is TREES.
 */
function rhalorenCampOverground(p: SitePalette): LevelSpec {
  return {
    ...TOWN_RHALOREN_CAMP,
    map: {
      ...TOWN_RHALOREN_CAMP.map,
      lesserVaultsList: RUIN_VAULTS,
      grid: {
        floor: p.floor,
        external_floor: [...repeat(p.floor, 15), TileCode.TREES],
        wall: p.wall,
        up: p.floor,
        down: p.floor,
        door: TileCode.DOOR,
        '#': p.wall,
        '.': p.floor,
        '+': TileCode.DOOR,
      },
    },
  };
}

/**
 * `data/zones/rhaloren-camp/zone.lua:38-50`, the DEFAULT layout underground: the
 * Kor'Pul table's shape — ten rooms, a 5-weighted money vault, an 8-weighted
 * lesser vault, every room lit — with the default grids.
 */
function rhalorenCampUnderground(p: SitePalette): LevelSpec {
  return {
    width: 50,
    height: 50,
    map: {
      class: 'Roomer',
      nbRooms: 10,
      rooms: ['random_room', ['money_vault', 5], ['lesser_vault', 8]],
      lesserVaultsList: RUIN_VAULTS,
      liteRoomChance: 100,
      forceLastStair: true,
      grid: { '.': p.floor, '#': p.wall, up: p.floor, down: p.floor, door: TileCode.DOOR },
    },
  };
}

/**
 * ToME rolls ONE layout per game (`alternateZoneTier1`, `:20`); a player here
 * walks both. Floors 1 and 2 are the overground's levels 1 and 2, lit
 * everywhere (`:104`). Its level 3 is a static map (`:153-163`), so the floors
 * below are the underground's: its level 2, the one its table builds with no
 * override (level 1 changes only the up stair's grid, `:67-71`, and level 3 is
 * the same static map, `:72-82`). Underground is NOT lit everywhere (`:34` is
 * commented out): only its rooms, at 100. Both layouts have `max_level` 3.
 */
const WATCHERS_ALTAR: ZoneDef = {
  name: 'Rhaloren Camp',
  palette: { floor: TileCode.PLAINS, wall: TileCode.CRAG },
  floors: [
    {
      zone: 'rhaloren-camp OVERGROUND',
      level: 1,
      maxLevel: 3,
      lighting: 'all_lited',
      table: rhalorenCampOverground,
    },
    {
      zone: 'rhaloren-camp OVERGROUND',
      level: 2,
      maxLevel: 3,
      lighting: 'all_lited',
      table: rhalorenCampOverground,
    },
    {
      zone: 'rhaloren-camp DEFAULT',
      level: 2,
      maxLevel: 3,
      lighting: { litRoomChance: 100 },
      table: rhalorenCampUnderground,
    },
  ],
};

// ═══════════════════════════════════════════════════════════════════════════
// THE HOLLOW MINE — Ardhungol
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Ardhungol's `floor` (`data/zones/ardhungol/zone.lua:42`): `rng.percent(96)`
 * CAVEFLOOR, else a WORMHOLE, a draw on every resolve. A wormhole teleports; it
 * is not ported, and both answers are the palette's floor.
 */
function ardhungolFloor(p: SitePalette): (rng: Rng) => TileCode {
  return (rng) => {
    percent(rng, 'mapgen.resolve.floor', 96);
    return p.floor;
  };
}

/**
 * `data/zones/ardhungol/zone.lua:27`, `:37-47`: 60x60, Cavern at zoom 16 with
 * `min_floor` 1100. CAVEWALL is the palette's wall.
 */
function ardhungol(p: SitePalette): LevelSpec<CavernMapSpec> {
  return {
    width: 60,
    height: 60,
    map: {
      class: 'Cavern',
      zoom: 16,
      minFloor: 1100,
      forceLastStair: true,
      grid: {
        floor: ardhungolFloor(p),
        wall: p.wall,
        up: p.floor,
        down: p.floor,
        door: p.floor,
      },
    },
  };
}

/** `levels[2]` (`data/zones/ardhungol/zone.lua:69`): 40x40, `min_floor` 600. */
function ardhungolLevel2(p: SitePalette): LevelSpec {
  const table = ardhungol(p);
  return { width: 40, height: 40, map: { ...table.map, minFloor: 600 } };
}

/**
 * Floor 1 is level 1; every floor after it level 2, because level 3 is 20x20
 * (`:70`). Not lit (`:29`), and Cavern places no room.
 */
const HOLLOW_MINE: ZoneDef = {
  name: 'Ardhungol',
  palette: { floor: TileCode.SOOT, wall: TileCode.MOUNTAIN },
  floors: [
    {
      zone: 'ardhungol',
      level: 1,
      maxLevel: 3,
      lighting: { litRoomChance: 100 },
      table: ardhungol,
    },
    {
      zone: 'ardhungol',
      level: 2,
      maxLevel: 3,
      lighting: { litRoomChance: 100 },
      table: ardhungolLevel2,
    },
  ],
};

// ═══════════════════════════════════════════════════════════════════════════
// THE OUTER INDEX — the Maze
// ═══════════════════════════════════════════════════════════════════════════

/**
 * `data/zones/maze/zone.lua:149-157`: `MAZE_THE_MAZE` (`mapgen/maze.ts`), 60x60
 * corridors two cells wide. OLD_FLOOR and OLD_WALL are the palette's.
 */
function theMaze(p: SitePalette): LevelSpec {
  return {
    ...MAZE_THE_MAZE,
    map: {
      ...MAZE_THE_MAZE.map,
      grid: { floor: p.floor, wall: p.wall, up: p.floor, down: p.floor },
    },
  };
}

/**
 * The DEFAULT layout's level 1 for every floor: level 2 is 20x20 (`:180-188`).
 * Not lit (`:144`), and a maze has no rooms to roll a light for. `max_level` 2
 * (`:139`).
 */
const OUTER_INDEX: ZoneDef = {
  name: 'The Maze',
  palette: { floor: TileCode.PAVING, wall: TileCode.ERASED },
  floors: [{ zone: 'maze DEFAULT', level: 1, maxLevel: 2, lighting: {}, table: theMaze }],
};

// ═══════════════════════════════════════════════════════════════════════════
// THE GLASS ARCHIVE — the Scintillating Caves, twisted
// ═══════════════════════════════════════════════════════════════════════════

/**
 * `data/zones/scintillating-caves/zone.lua:30`, `:39-50`, the TWISTED layout:
 * 30x30, five rooms of `random_room` with a 5-weighted money vault, a fifth of
 * them lit. `'.'` is CRYSTAL_FLOOR, the palette's floor. `'#'` is a table of
 * twenty crystal walls, CRYSTAL_WALL to CRYSTAL_WALL20 (`data/general/grids/crystal.lua:20-34`),
 * all the palette's wall and still twenty entries for the draw, and `door` is
 * the crystal FLOOR — a door the tunnels hang is floor.
 */
function scintillatingCavesTwisted(p: SitePalette): LevelSpec {
  return {
    width: 30,
    height: 30,
    map: {
      class: 'Roomer',
      nbRooms: 5,
      rooms: ['random_room', ['money_vault', 5]],
      liteRoomChance: 20,
      forceLastStair: true,
      grid: { '.': p.floor, '#': repeat(p.wall, 20), up: p.floor, down: p.floor, door: p.floor },
    },
  };
}

/**
 * All lit (`:34`); `max_level` 5 (`:27`); level 1 changes only the up ladder's
 * grid (`:66-73`), so every floor is the same table. Drawn in the crystal codes,
 * which carry no air and no `on_stand` (`data/general/grids/crystal.lua:20-44`):
 * identity, not mechanics.
 */
const GLASS_ARCHIVE: ZoneDef = {
  name: 'Scintillating Caves',
  palette: { floor: TileCode.CRYSTAL_FLOOR, wall: TileCode.CRYSTAL_WALL },
  floors: [1, 2, 3, 4].map((level) => ({
    zone: 'scintillating-caves TWISTED',
    level,
    maxLevel: 5,
    lighting: 'all_lited' as const,
    table: scintillatingCavesTwisted,
  })),
};

// ═══════════════════════════════════════════════════════════════════════════
// GEARFORD INDUSTRIAL WARD — the Infinite Dungeon's constructed area
// ═══════════════════════════════════════════════════════════════════════════

/**
 * `BUILDING_INFINITE_DUNGEON` (`mapgen/building.ts`) in the site's grids: the
 * default grid set (`data/zones/infinite-dungeon/zone.lua:186`, written in at
 * `:237-249`) — FLOOR for the floor, `'.'`, both outside floors and the up
 * stair, WALL for the wall and `'#'`, DOOR for the door.
 */
function infiniteDungeonBuildingTable(p: SitePalette): LevelSpec<BuildingMapSpec> {
  return {
    ...BUILDING_INFINITE_DUNGEON,
    map: {
      ...BUILDING_INFINITE_DUNGEON.map,
      lesserVaultsList: (VAULTS_BY_SHAPE['works'] ?? []).map((v) => v.id),
      grid: {
        floor: p.floor,
        '.': p.floor,
        external_floor: p.floor,
        outside_floor: p.floor,
        wall: p.wall,
        '#': p.wall,
        door: TileCode.DOOR,
        up: p.floor,
        down: p.floor,
      },
    },
  };
}

/**
 * `alter_level_data` for the building layout (`:153-162`, `:216`): the level's
 * rooms, light, block and building sizes rolled over the table
 * (`infiniteDungeonBuilding`) — the building sizes at the level's own `size`
 * (`:103`, `infiniteDungeonSize`), on the map this table builds.
 */
function alterInfiniteDungeonBuilding(p: SitePalette, rng: Rng, lev: number): LevelSpec {
  const table = infiniteDungeonBuildingTable(p);
  return {
    ...table,
    map: {
      ...table.map,
      ...infiniteDungeonBuilding(rng, infiniteDungeonSize(lev), table.width, table.height, lev),
    },
  };
}

/**
 * Floor n is the Infinite Dungeon's level n with its layout forced to
 * "building", the only Building table a player meets outside an event. Not lit
 * everywhere (`:31`); each floor's buildings and rooms light on the chance that
 * floor rolled. `max_level` is a billion (`:27`).
 */
const GEARFORD_WARD: ZoneDef = {
  name: 'Infinite Dungeon',
  palette: { floor: TileCode.SOOT, wall: TileCode.WORKS },
  floors: [1, 2, 3, 4].map((level) => ({
    zone: 'infinite-dungeon building',
    level,
    maxLevel: 1000000000,
    lighting: 'rolled' as const,
    table: infiniteDungeonBuildingTable,
    alter: alterInfiniteDungeonBuilding,
  })),
};

// ═══════════════════════════════════════════════════════════════════════════
// BLACKWOOD OUTSKIRTS — the Trollmire
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The Trollmire's `floor` (`data/zones/trollmire/zone.lua:177`):
 * `rng.chance(20)` FLOWER, else GRASS — a draw on every resolve, and both the
 * palette's floor.
 */
function trollmireFloor(p: SitePalette): (rng: Rng) => TileCode {
  return (rng) => {
    chance(rng, 'mapgen.resolve.floor', 20);
    return p.floor;
  };
}

/**
 * `data/zones/trollmire/zone.lua:160`, `:171-193`, the DEFAULT layout:
 * `FOREST_TROLLMIRE` (`mapgen/forest.ts`) — 65x40, left edge to right, zoom 4,
 * a road from stair to stair, a lit lesser vault on a quarter of levels.
 *
 * THE PONDS ARE DUG, AND ARE DEEP. `do_ponds` (`:184-188`) cuts up to two
 * ponds of DEEP_WATER, which a ToME body wades and drowns in
 * (`data/general/grids/water.lua:136-140`): POND_WATER, in every palette. Each
 * pond entry keeps its own fraction, so the ponds spend upstream's draws.
 * `FOREST_TROLLMIRE`'s own DEEPWATER is the overworld's solid sea, the stand-in
 * it was written with before walkable water existed, and is not what this
 * zone draws.
 *
 * THE ROAD GOES ROUND THEM. Upstream's road refuses any cell whose terrain has
 * an `air_level` (`engine/generator/map/Forest.lua:395`), so `airLevel` is left
 * off and `makeRoad` refuses every code `shared/terrain.ts` gives air —
 * `FOREST_TROLLMIRE`'s `[DEEPWATER]` would refuse the sea and walk the road
 * through the pond.
 *
 * THE ROAD IS LAID AND NOT DRAWN: GRASS_ROAD_DIRT has no code here, so the
 * route it cuts through the trees is the palette's floor.
 */
function trollmire(p: SitePalette): LevelSpec {
  const { doPonds, airLevel: _air, ...map } = FOREST_TROLLMIRE.map;
  const floor = trollmireFloor(p);
  return {
    ...FOREST_TROLLMIRE,
    map: {
      ...map,
      ...(doPonds === undefined
        ? {}
        : {
            doPonds: {
              ...doPonds,
              pond: doPonds.pond.map(([frac]) => [frac, TileCode.POND_WATER] as const),
            },
          }),
      grid: {
        floor,
        wall: TileCode.TREES,
        up: p.floor,
        down: p.floor,
        door: p.floor,
        road: p.floor,
        '.': floor,
        '#': TileCode.TREES,
      },
    },
  };
}

/**
 * All lit (`:162`); `max_level` 3 (`:157`). Levels 1 and 2 differ only in level
 * 1's up grid. Level 3 ends its road at Prox's own room (`:220-228`,
 * `rooms/zones/prox.lua`), which is not ported, and level 4 is a static map
 * (`:230-241`); so floors 3 and 4 are level 2.
 */
const BLACKWOOD_OUTSKIRTS: ZoneDef = {
  name: 'Trollmire',
  palette: { floor: TileCode.HEATH, wall: TileCode.TREES },
  floors: [
    { zone: 'trollmire DEFAULT', level: 1, maxLevel: 3, lighting: 'all_lited', table: trollmire },
    { zone: 'trollmire DEFAULT', level: 2, maxLevel: 3, lighting: 'all_lited', table: trollmire },
  ],
};

/** Every site built as a ToME zone, by site id. */
export const ZONES: ReadonlyMap<string, ZoneDef> = new Map([
  ['site:drowned_chapel', DROWNED_CHAPEL],
  ['site:underworks', UNDERWORKS],
  ['site:barrow_end', BARROW_END],
  ['site:cairnfoot', CAIRNFOOT],
  ['site:the_weir', THE_WEIR],
  ['site:watchers_altar', WATCHERS_ALTAR],
  ['site:hollow_mine', HOLLOW_MINE],
  ['site:outer_index', OUTER_INDEX],
  ['site:glass_archive', GLASS_ARCHIVE],
  ['site:gearford_ward', GEARFORD_WARD],
  ['site:blackwood_outskirts', BLACKWOOD_OUTSKIRTS],
]);

/** The zone level floor `floor` of `def` is built as. Past the last entry, the last. */
export function zoneFloor(def: ZoneDef, floor: number): ZoneLevel {
  if (!Number.isInteger(floor) || floor < 1) {
    throw new RangeError(`zoneFloor: floor ${String(floor)} is not a floor`);
  }
  const level = def.floors[Math.min(floor, def.floors.length) - 1];
  if (level === undefined) throw new Error(`zoneFloor: ${def.name} has no levels`);
  return level;
}

/** `lighting` as a site reads it (`shared/light.ts`); a rolled chance read off `table`. */
export function siteLighting(lighting: ZoneLighting, table?: LevelSpec): SiteLighting {
  if (lighting === 'all_lited') return { allLit: true };
  if (lighting !== 'rolled') return lighting;
  const chance =
    table !== undefined && 'liteRoomChance' in table.map ? table.map.liteRoomChance : undefined;
  return chance === undefined ? {} : { litRoomChance: chance };
}

/**
 * What `keepTrying` builds `level` from, in `palette`: its table, or — for a
 * zone that rolls its table each level change — a roll made from each ROUND's
 * own seed, since each round is a level change of its own (see `keepTrying`).
 */
export function zoneTable(
  level: ZoneLevel,
  palette: SitePalette,
): LevelSpec | ((roundSeed: string) => LevelSpec) {
  const { alter } = level;
  return alter === undefined
    ? level.table(palette)
    : (roundSeed) => alter(palette, createRng(`${roundSeed}:alter_level_data`), level.level);
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A SEAL TRIMS A LEVEL, IT DOES NOT REPLACE IT — OUR RULE, NOT UPSTREAM'S
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The most of a level's ground (walkable cells and doors) `sealUnreachable` may
 * take: a map whose up stair cannot reach more than this share of it is
 * refused, and the next attempt builds another.
 *
 * Upstream asks only whether up reaches down (`engine/Zone.lua:1131-1158`), so
 * a level passes when both stairs stand in one room the tunnels never joined to
 * the others. A ToME player walks that room to the stairs, and the level's
 * monsters stand in rooms they never meet. Sealed here, the room IS the floor,
 * and the whole floor's population is placed in it: measured on the Glass
 * Archive's 30x30 Scintillating Caves, 1,500 seeds a floor over both sites,
 * 3 floors had no monster at all, 65 bodies stood inside the arrival's
 * clearance and 2 on the stair — down to 33 cells of ground on the worst.
 *
 * HALF, BECAUSE A PASS IS A TRIM. Refusing only what a seal would cut in two
 * keeps upstream's levels everywhere else: over 1,000 seeds of every floor of
 * every zone here it refused no level outside the Glass Archive but one of the
 * Watcher's Altar's underground floors, and 0.1% to 0.4% of the Glass Archive's.
 * The 12,000 Glass Archive floors above, built again under this rule, had no
 * empty floor, no body in the clearance and none on a stair, and at least 116
 * walkable cells each.
 */
export const MAX_SEALED_SHARE = 0.5;

/** `LevelOptions.refuse` for a zone: see `MAX_SEALED_SHARE`. */
function refuseMostlySealed(map: AuthoredMap): string | null {
  const share = sealedShare(map);
  return share > MAX_SEALED_SHARE
    ? `the up stair reaches ${String(Math.round(100 * (1 - share)))}% of the ground`
    : null;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * FLOOR `floor` OF A SITE, BUILT AS ITS ZONE BUILDS THAT LEVEL
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The level's table in `palette` (the zone's own, when none is given), rolled
 * afresh each round where the zone rolls it, certified by `keepTrying` with a
 * mostly-sealed map refused (`MAX_SEALED_SHARE`), and sealed where its up stair
 * cannot reach. The map carries its own `lighting`:
 * a Watcher's Altar floor underground is not lit the way one above ground is,
 * and a Gearford floor is lit on the chance it rolled. And its level's auras,
 * as `zoneEffects`, where the level names any: the Weir's underwater.
 *
 * THROWS for a site with no zone, and for a floor below 1.
 */
export function zoneLevel(
  siteId: string,
  seed: string,
  floor: number,
  palette?: SitePalette,
): AuthoredMap {
  const def = ZONES.get(siteId);
  if (def === undefined) throw new Error(`zoneLevel: ${siteId} has no zone`);
  const level = zoneFloor(def, floor);
  const p = palette ?? def.palette;
  const built = keepTrying(zoneTable(level, p), seed, {
    level: level.level,
    maxLevel: level.maxLevel,
    refuse: refuseMostlySealed,
  });
  return {
    ...sealUnreachable(built.map, p.wall),
    lighting: siteLighting(level.lighting, built.spec),
    ...(level.effects === undefined ? {} : { zoneEffects: level.effects }),
  };
}
