// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

/**
 * Authored settlements: streets that lead somewhere, buildings with rooms in
 * them, and landmarks that make the five shared spaces different places.
 *
 * The former town generator opened one 48x48 plaza and stamped solid rectangles
 * into it. Those rectangles looked like buildings from above, but they were
 * walls all the way through: there was no inside to enter, no door to find, and
 * no reason to leave the arrival tile. A town is learned by walking it, so the
 * shared settlements are authored instead of rolled.
 *
 * The plans take three broad lessons from ToME's mature town layouts without
 * copying a map: keep the main route wide, make shops visible from that route,
 * and use water/green space as orientation landmarks. Inner Datum adds the part
 * the project explicitly needs: every rectangular building below is a wall
 * perimeter around a walkable interior, with a real door in the perimeter.
 */

import { tileIndex } from '../../shared/coords.ts';
import { TileCode } from '../../shared/protocol.ts';
import type { TileXY } from '../../shared/coords.ts';
import type { AuthoredMap, TileRect } from '../../shared/level.ts';
import type { World } from '../world/world.ts';

const W = 50;
const H = 50;

type Rect = TileRect;

export type TownBuilding = {
  readonly id: string;
  readonly shell: Rect;
  readonly door: TileXY;
};

export type TownPropPlacement = TileXY & {
  /** Asset key. Art never crosses into source control; see art-pipeline. */
  readonly propId: string;
};

type BuildingPlan = TownBuilding & {
  readonly wall: number;
  readonly floor: number;
  readonly dividers: readonly {
    readonly wall: Rect;
    readonly door: TileXY;
  }[];
};

type TownPlan = {
  readonly base: number;
  readonly boundary: number;
  /** Secondary soil/planting fields laid below roads, water and architecture. */
  readonly grounds: readonly (Rect & { readonly tile: number })[];
  readonly streets: readonly (Rect & { readonly tile: number })[];
  readonly waters: readonly Rect[];
  readonly bridges: readonly Rect[];
  readonly trees: readonly TileXY[];
  readonly buildings: readonly BuildingPlan[];
  readonly spawns: readonly TileXY[];
  readonly residents: Readonly<Record<string, TileXY>>;
  readonly props: readonly TownPropPlacement[];
};

const r = (x0: number, y0: number, x1: number, y1: number): Rect => ({ x0, y0, x1, y1 });
const p = (x: number, y: number, propId: string): TownPropPlacement => ({ x, y, propId });
const b = (
  id: string,
  shell: Rect,
  door: TileXY,
  wall: number,
  floor: number,
  dividers: BuildingPlan['dividers'] = [],
): BuildingPlan => ({ id, shell, door, wall, floor, dividers });
const d = (wall: Rect, door: TileXY): BuildingPlan['dividers'][number] => ({ wall, door });

/** Six bodies arrive together, clear of every resident and furnishing. */
const SOUTH_SPAWNS: readonly TileXY[] = [
  { x: 24, y: 46 },
  { x: 25, y: 46 },
  { x: 26, y: 46 },
  { x: 24, y: 47 },
  { x: 25, y: 47 },
  { x: 26, y: 47 },
];

const PLANS: Readonly<Record<string, TownPlan>> = {
  'site:alderbrook': {
    base: TileCode.GREEN,
    boundary: TileCode.TOWN_WALL,
    grounds: [
      { ...r(3, 1, 5, 48), tile: TileCode.PLAINS },
      { ...r(9, 17, 17, 22), tile: TileCode.HEATH },
      { ...r(33, 17, 45, 22), tile: TileCode.HEATH },
      { ...r(9, 29, 17, 32), tile: TileCode.PLAINS },
      { ...r(33, 29, 45, 32), tile: TileCode.PLAINS },
    ],
    streets: [
      { ...r(23, 1, 27, 48), tile: TileCode.PAVING },
      { ...r(8, 24, 43, 28), tile: TileCode.PAVING },
      { ...r(8, 10, 23, 12), tile: TileCode.PAVING },
      { ...r(27, 10, 44, 12), tile: TileCode.PAVING },
      { ...r(8, 37, 23, 39), tile: TileCode.PAVING },
      { ...r(27, 37, 44, 39), tile: TileCode.PAVING },
      { ...r(18, 20, 32, 32), tile: TileCode.COBBLE },
    ],
    // The Alder run is a narrow civic canal, crossed wherever a street meets it.
    waters: [r(6, 1, 8, 48)],
    bridges: [r(6, 10, 8, 12), r(6, 24, 8, 28), r(6, 37, 8, 39)],
    trees: [
      { x: 11, y: 19 },
      { x: 14, y: 20 },
      { x: 35, y: 21 },
      { x: 39, y: 20 },
      { x: 11, y: 30 },
      { x: 15, y: 31 },
      { x: 37, y: 30 },
      { x: 42, y: 31 },
      { x: 3, y: 7 },
      { x: 3, y: 43 },
      { x: 4, y: 15 },
      { x: 4, y: 34 },
      { x: 10, y: 5 },
      { x: 10, y: 17 },
      { x: 10, y: 32 },
      { x: 10, y: 46 },
      { x: 46, y: 5 },
      { x: 46, y: 17 },
      { x: 46, y: 33 },
      { x: 46, y: 45 },
      { x: 17, y: 18 },
      { x: 33, y: 18 },
      { x: 17, y: 31 },
      { x: 33, y: 31 },
    ],
    buildings: [
      b('civic-hall', r(11, 3, 21, 15), { x: 21, y: 11 }, TileCode.CIVIC, TileCode.PAVING, [
        d(r(12, 8, 20, 8), { x: 16, y: 8 }),
      ]),
      b('alder-inn', r(30, 3, 44, 16), { x: 30, y: 11 }, TileCode.TERRACE, TileCode.COBBLE, [
        d(r(37, 4, 37, 15), { x: 37, y: 11 }),
      ]),
      b('registry', r(11, 33, 21, 45), { x: 21, y: 38 }, TileCode.CIVIC, TileCode.PAVING, [
        d(r(12, 37, 20, 37), { x: 16, y: 37 }),
      ]),
      b('common-house', r(30, 33, 44, 45), { x: 30, y: 38 }, TileCode.TERRACE, TileCode.COBBLE, [
        d(r(37, 34, 37, 44), { x: 37, y: 38 }),
      ]),
    ],
    spawns: SOUTH_SPAWNS,
    residents: {
      reeve: { x: 19, y: 11 },
      bell: { x: 25, y: 42 },
      tamsin: { x: 19, y: 38 },
      nell: { x: 40, y: 38 },
    },
    props: [
      p(19, 11, 'prop_office_desk'),
      p(19, 38, 'prop_typewriter_desk'),
      p(32, 38, 'prop_hearth'),
      p(40, 38, 'prop_shop_counter'),
      p(20, 25, 'prop_well'),
      p(16, 25, 'prop_noticeboard'),
      p(21, 21, 'prop_market_stall'),
      p(29, 21, 'prop_market_stall'),
      p(18, 30, 'prop_street_bench'),
      p(32, 30, 'prop_street_bench'),
      p(22, 17, 'prop_lamp_post'),
      p(28, 17, 'prop_lamp_post'),
      p(22, 34, 'prop_lamp_post'),
      p(28, 34, 'prop_lamp_post'),
      p(10, 26, 'prop_handcart'),
      p(42, 26, 'prop_barrel'),
      p(13, 5, 'prop_archive_shelf'),
      p(13, 13, 'prop_filing_cabinet'),
      p(17, 5, 'prop_glass_case'),
      p(20, 5, 'prop_coat_stand'),
      p(42, 5, 'prop_hearth'),
      p(33, 5, 'prop_street_bench'),
      p(42, 14, 'prop_barrel'),
      p(33, 14, 'prop_bedroll'),
      p(12, 35, 'prop_card_catalogue'),
      p(12, 43, 'prop_filing_cabinet'),
      p(19, 44, 'prop_archive_shelf'),
      p(42, 43, 'prop_iron_safe'),
      p(36, 35, 'prop_glass_case'),
      p(32, 43, 'prop_crate'),
      p(43, 35, 'prop_bookshelf'),
      p(19, 19, 'prop_civic_planter'),
      p(31, 19, 'prop_civic_planter'),
      p(19, 31, 'prop_civic_planter'),
      p(31, 31, 'prop_civic_planter'),
      p(14, 19, 'prop_flowering_shrub'),
      p(36, 19, 'prop_flowering_shrub'),
      p(14, 30, 'prop_flowering_shrub'),
      p(36, 30, 'prop_flowering_shrub'),
      p(7, 5, 'prop_wetland_reeds'),
      p(7, 18, 'prop_wetland_reeds'),
      p(7, 33, 'prop_wetland_reeds'),
      p(7, 45, 'prop_wetland_reeds'),
    ],
  },

  'site:threadneedle_row': {
    base: TileCode.PLAINS,
    boundary: TileCode.TOWN_WALL,
    grounds: [
      { ...r(1, 1, 21, 6), tile: TileCode.GREEN },
      { ...r(28, 1, 48, 6), tile: TileCode.GREEN },
      { ...r(1, 11, 21, 12), tile: TileCode.HEATH },
      { ...r(28, 11, 48, 12), tile: TileCode.HEATH },
      { ...r(1, 23, 18, 25), tile: TileCode.GREEN },
      { ...r(31, 23, 48, 25), tile: TileCode.GREEN },
      { ...r(1, 36, 21, 37), tile: TileCode.HEATH },
      { ...r(28, 36, 48, 37), tile: TileCode.HEATH },
    ],
    streets: [
      { ...r(22, 1, 27, 48), tile: TileCode.COBBLE },
      { ...r(19, 17, 30, 19), tile: TileCode.PAVING },
      { ...r(19, 29, 31, 31), tile: TileCode.COBBLE },
      { ...r(20, 42, 30, 44), tile: TileCode.COBBLE },
      { ...r(19, 23, 31, 25), tile: TileCode.PAVING },
    ],
    waters: [r(1, 7, 48, 9)],
    bridges: [r(22, 7, 27, 9), r(10, 7, 12, 9), r(37, 7, 39, 9)],
    trees: [
      { x: 3, y: 3 },
      { x: 8, y: 4 },
      { x: 16, y: 3 },
      { x: 33, y: 3 },
      { x: 42, y: 4 },
      { x: 47, y: 3 },
      { x: 3, y: 11 },
      { x: 14, y: 11 },
      { x: 36, y: 11 },
      { x: 47, y: 11 },
      { x: 2, y: 24 },
      { x: 47, y: 24 },
      { x: 2, y: 36 },
      { x: 47, y: 36 },
      { x: 3, y: 46 },
      { x: 46, y: 46 },
    ],
    buildings: [
      b('stitch-outfitter', r(4, 13, 19, 22), { x: 19, y: 18 }, TileCode.TERRACE, TileCode.COBBLE, [
        d(r(11, 14, 11, 21), { x: 11, y: 18 }),
      ]),
      b('cloth-warehouse', r(5, 26, 19, 35), { x: 19, y: 30 }, TileCode.TERRACE, TileCode.YARD, [
        d(r(12, 27, 12, 34), { x: 12, y: 30 }),
      ]),
      b('bindery', r(30, 13, 45, 22), { x: 30, y: 18 }, TileCode.TERRACE, TileCode.COBBLE, [
        d(r(38, 14, 38, 21), { x: 38, y: 18 }),
      ]),
      b('dyers-hall', r(31, 26, 45, 35), { x: 31, y: 30 }, TileCode.TERRACE, TileCode.MIRE, [
        d(r(38, 27, 38, 34), { x: 38, y: 30 }),
      ]),
      b('weavers-court', r(7, 38, 20, 47), { x: 20, y: 43 }, TileCode.TERRACE, TileCode.YARD, [
        d(r(8, 42, 19, 42), { x: 14, y: 42 }),
      ]),
      b('tailors-house', r(30, 38, 43, 47), { x: 30, y: 43 }, TileCode.TERRACE, TileCode.COBBLE, [
        d(r(31, 42, 42, 42), { x: 36, y: 42 }),
      ]),
    ],
    spawns: SOUTH_SPAWNS,
    residents: {
      merrow: { x: 17, y: 18 },
      vane: { x: 25, y: 39 },
      elia: { x: 32, y: 18 },
    },
    props: [
      p(17, 18, 'prop_shop_counter'),
      p(7, 15, 'prop_dress_form'),
      p(7, 20, 'prop_cloth_bolts'),
      p(13, 15, 'prop_glass_case'),
      p(17, 15, 'prop_coat_stand'),
      p(14, 20, 'prop_loom'),
      p(17, 30, 'prop_crate'),
      p(7, 28, 'prop_cloth_bolts'),
      p(7, 33, 'prop_barrel'),
      p(15, 33, 'prop_grain_sack'),
      p(32, 18, 'prop_reading_desk'),
      p(44, 15, 'prop_bookshelf'),
      p(40, 20, 'prop_archive_shelf'),
      p(44, 20, 'prop_card_catalogue'),
      p(33, 28, 'prop_cauldron'),
      p(36, 33, 'prop_jar_shelf'),
      p(43, 28, 'prop_barrel'),
      p(43, 33, 'prop_cloth_bolts'),
      p(9, 40, 'prop_loom'),
      p(18, 40, 'prop_cloth_bolts'),
      p(9, 45, 'prop_crate'),
      p(18, 45, 'prop_barrel'),
      p(32, 40, 'prop_dress_form'),
      p(41, 40, 'prop_coat_stand'),
      p(32, 45, 'prop_cloth_bolts'),
      p(41, 45, 'prop_glass_case'),
      p(21, 24, 'prop_market_stall'),
      p(25, 24, 'prop_market_stall'),
      p(29, 24, 'prop_market_stall'),
      p(20, 35, 'prop_street_bench'),
      p(29, 35, 'prop_street_bench'),
      p(21, 20, 'prop_lamp_post'),
      p(29, 20, 'prop_lamp_post'),
      p(20, 12, 'prop_civic_planter'),
      p(29, 12, 'prop_civic_planter'),
      p(3, 24, 'prop_flowering_shrub'),
      p(46, 24, 'prop_flowering_shrub'),
      p(6, 8, 'prop_wetland_reeds'),
      p(17, 8, 'prop_wetland_reeds'),
      p(32, 8, 'prop_wetland_reeds'),
      p(45, 8, 'prop_wetland_reeds'),
    ],
  },

  'site:ashwick_row': {
    base: TileCode.GREEN,
    boundary: TileCode.TOWN_WALL,
    grounds: [
      { ...r(1, 25, 18, 28), tile: TileCode.HEATH },
      { ...r(1, 45, 22, 48), tile: TileCode.HEATH },
      { ...r(25, 21, 39, 25), tile: TileCode.SOOT },
      { ...r(43, 1, 48, 48), tile: TileCode.MIRE },
      { ...r(25, 45, 39, 48), tile: TileCode.PLAINS },
    ],
    streets: [
      { ...r(20, 1, 24, 48), tile: TileCode.COBBLE },
      { ...r(1, 20, 42, 24), tile: TileCode.COBBLE },
      { ...r(10, 15, 20, 17), tile: TileCode.COBBLE },
      { ...r(24, 13, 25, 17), tile: TileCode.SOOT },
      { ...r(13, 27, 24, 30), tile: TileCode.YARD },
      { ...r(24, 32, 29, 36), tile: TileCode.SOOT },
      { ...r(24, 40, 42, 42), tile: TileCode.SOOT },
    ],
    waters: [r(40, 1, 42, 48)],
    bridges: [r(40, 20, 42, 24), r(40, 40, 42, 42)],
    trees: [
      { x: 2, y: 3 },
      { x: 7, y: 2 },
      { x: 15, y: 2 },
      { x: 28, y: 2 },
      { x: 36, y: 2 },
      { x: 46, y: 4 },
      { x: 2, y: 18 },
      { x: 17, y: 19 },
      { x: 28, y: 22 },
      { x: 37, y: 22 },
      { x: 46, y: 18 },
      { x: 2, y: 27 },
      { x: 18, y: 27 },
      { x: 27, y: 28 },
      { x: 46, y: 29 },
      { x: 2, y: 46 },
      { x: 18, y: 47 },
      { x: 29, y: 47 },
      { x: 37, y: 47 },
      { x: 46, y: 46 },
    ],
    buildings: [
      b('vaunt-apothecary', r(3, 4, 18, 17), { x: 11, y: 17 }, TileCode.WORKS, TileCode.COBBLE, [
        d(r(4, 11, 17, 11), { x: 11, y: 11 }),
      ]),
      b('glass-laboratory', r(25, 3, 38, 19), { x: 25, y: 15 }, TileCode.WORKS, TileCode.SOOT, [
        d(r(32, 4, 32, 18), { x: 32, y: 15 }),
      ]),
      b('herb-house', r(4, 29, 22, 44), { x: 13, y: 29 }, TileCode.TERRACE, TileCode.YARD, [
        d(r(5, 37, 21, 37), { x: 13, y: 37 }),
      ]),
      b('mixer-house', r(29, 27, 39, 44), { x: 29, y: 34 }, TileCode.WORKS, TileCode.SOOT, [
        d(r(30, 37, 38, 37), { x: 34, y: 37 }),
      ]),
    ],
    spawns: SOUTH_SPAWNS,
    residents: {
      thessaly: { x: 11, y: 15 },
      quill: { x: 27, y: 15 },
      mara: { x: 23, y: 43 },
    },
    props: [
      p(11, 15, 'prop_shop_counter'),
      p(5, 6, 'prop_jar_shelf'),
      p(10, 6, 'prop_herb_rack'),
      p(16, 6, 'prop_bookshelf'),
      p(5, 14, 'prop_glass_case'),
      p(16, 14, 'prop_herb_rack'),
      p(27, 15, 'prop_alembic'),
      p(27, 5, 'prop_furnace'),
      p(30, 18, 'prop_gear_pile'),
      p(35, 5, 'prop_jar_shelf'),
      p(36, 17, 'prop_barrel'),
      p(6, 31, 'prop_herb_rack'),
      p(13, 31, 'prop_grain_sack'),
      p(20, 31, 'prop_jar_shelf'),
      p(6, 42, 'prop_cauldron'),
      p(13, 42, 'prop_barrel'),
      p(20, 42, 'prop_crate'),
      p(31, 34, 'prop_herb_rack'),
      p(31, 29, 'prop_jar_shelf'),
      p(37, 29, 'prop_alembic'),
      p(31, 42, 'prop_crate'),
      p(37, 42, 'prop_furnace'),
      p(17, 26, 'prop_market_stall'),
      p(25, 26, 'prop_market_stall'),
      p(27, 38, 'prop_street_bench'),
      p(26, 18, 'prop_lamp_post'),
      p(18, 25, 'prop_civic_planter'),
      p(31, 25, 'prop_civic_planter'),
      p(7, 26, 'prop_flowering_shrub'),
      p(14, 26, 'prop_flowering_shrub'),
      p(43, 40, 'prop_sluice_gate'),
      p(41, 7, 'prop_wetland_reeds'),
      p(41, 17, 'prop_wetland_reeds'),
      p(41, 31, 'prop_wetland_reeds'),
      p(41, 46, 'prop_wetland_reeds'),
    ],
  },

  'site:saints_rest': {
    base: TileCode.PLAINS,
    boundary: TileCode.TOWN_WALL,
    grounds: [
      { ...r(1, 1, 18, 34), tile: TileCode.GREEN },
      { ...r(32, 1, 48, 34), tile: TileCode.GREEN },
      { ...r(1, 35, 18, 48), tile: TileCode.HEATH },
      { ...r(32, 35, 48, 48), tile: TileCode.HEATH },
      { ...r(15, 22, 34, 32), tile: TileCode.GREEN },
    ],
    streets: [
      { ...r(23, 34, 27, 48), tile: TileCode.YARD },
      { ...r(23, 18, 27, 38), tile: TileCode.COBBLE },
      { ...r(18, 17, 35, 21), tile: TileCode.COBBLE },
      { ...r(15, 24, 23, 28), tile: TileCode.YARD },
      { ...r(27, 27, 35, 31), tile: TileCode.YARD },
      { ...r(14, 33, 36, 37), tile: TileCode.YARD },
    ],
    waters: [r(1, 11, 17, 13), r(35, 11, 48, 13), r(14, 8, 17, 18), r(35, 8, 38, 18)],
    bridges: [r(7, 11, 9, 13), r(14, 15, 17, 17), r(35, 15, 38, 17), r(42, 11, 44, 13)],
    trees: [
      { x: 3, y: 4 },
      { x: 8, y: 6 },
      { x: 12, y: 3 },
      { x: 39, y: 3 },
      { x: 45, y: 6 },
      { x: 3, y: 17 },
      { x: 10, y: 17 },
      { x: 42, y: 18 },
      { x: 47, y: 17 },
      { x: 2, y: 33 },
      { x: 10, y: 34 },
      { x: 41, y: 37 },
      { x: 47, y: 34 },
      { x: 3, y: 46 },
      { x: 13, y: 46 },
      { x: 36, y: 46 },
      { x: 46, y: 46 },
    ],
    buildings: [
      b('chapel', r(19, 4, 34, 18), { x: 26, y: 18 }, TileCode.TERRACE, TileCode.COBBLE, [
        d(r(20, 13, 33, 13), { x: 26, y: 13 }),
      ]),
      b('register-house', r(4, 20, 15, 31), { x: 15, y: 26 }, TileCode.TERRACE, TileCode.COBBLE, [
        d(r(9, 21, 9, 30), { x: 9, y: 26 }),
      ]),
      b('sextons-house', r(35, 24, 46, 35), { x: 35, y: 29 }, TileCode.TERRACE, TileCode.YARD, [
        d(r(40, 25, 40, 34), { x: 40, y: 29 }),
      ]),
      b('mausoleum', r(19, 35, 31, 44), { x: 25, y: 44 }, TileCode.CIVIC, TileCode.COBBLE, [
        d(r(20, 39, 30, 39), { x: 25, y: 39 }),
      ]),
    ],
    spawns: SOUTH_SPAWNS,
    residents: {
      sexton: { x: 37, y: 29 },
      colley: { x: 13, y: 26 },
      mercy: { x: 18, y: 45 },
    },
    props: [
      p(26, 16, 'prop_font'),
      p(21, 7, 'prop_chapel_pew'),
      p(26, 7, 'prop_chapel_pew'),
      p(31, 7, 'prop_chapel_pew'),
      p(21, 11, 'prop_chapel_pew'),
      p(31, 11, 'prop_chapel_pew'),
      p(13, 26, 'prop_shop_counter'),
      p(6, 22, 'prop_archive_shelf'),
      p(6, 29, 'prop_card_catalogue'),
      p(12, 22, 'prop_filing_cabinet'),
      p(12, 29, 'prop_glass_case'),
      p(37, 29, 'prop_open_grave'),
      p(37, 26, 'prop_coat_stand'),
      p(44, 26, 'prop_hearth'),
      p(44, 33, 'prop_bedroll'),
      p(37, 33, 'prop_crate'),
      p(21, 37, 'prop_gravestone_a'),
      p(29, 37, 'prop_gravestone_b'),
      p(21, 42, 'prop_broken_altar'),
      p(29, 42, 'prop_eldritch_offering_bowl_01'),
      p(7, 34, 'prop_gravestone_a'),
      p(12, 37, 'prop_gravestone_b'),
      p(38, 39, 'prop_gravestone_a'),
      p(45, 41, 'prop_gravestone_b'),
      p(17, 31, 'prop_street_bench'),
      p(33, 33, 'prop_street_bench'),
      p(20, 22, 'prop_lamp_post'),
      p(32, 22, 'prop_lamp_post'),
      p(11, 18, 'prop_flowering_shrub'),
      p(41, 20, 'prop_flowering_shrub'),
      p(17, 23, 'prop_civic_planter'),
      p(34, 22, 'prop_civic_planter'),
      p(6, 12, 'prop_wetland_reeds'),
      p(12, 12, 'prop_wetland_reeds'),
      p(40, 12, 'prop_wetland_reeds'),
      p(46, 12, 'prop_wetland_reeds'),
    ],
  },

  'site:wayfarers_camp': {
    base: TileCode.PLAINS,
    boundary: TileCode.TREES,
    grounds: [
      { ...r(1, 1, 15, 48), tile: TileCode.GREEN },
      { ...r(34, 1, 48, 48), tile: TileCode.GREEN },
      { ...r(16, 1, 33, 18), tile: TileCode.HEATH },
      { ...r(16, 32, 33, 48), tile: TileCode.HEATH },
      { ...r(13, 19, 36, 31), tile: TileCode.GREEN },
    ],
    streets: [
      { ...r(17, 19, 33, 31), tile: TileCode.YARD },
      { ...r(23, 29, 27, 48), tile: TileCode.YARD },
      { ...r(16, 15, 20, 22), tile: TileCode.YARD },
      { ...r(30, 13, 34, 22), tile: TileCode.YARD },
      { ...r(16, 34, 23, 38), tile: TileCode.YARD },
      { ...r(27, 34, 34, 38), tile: TileCode.YARD },
      { ...r(4, 23, 17, 27), tile: TileCode.YARD },
    ],
    waters: [r(1, 6, 6, 8), r(4, 8, 6, 41), r(4, 41, 13, 43)],
    bridges: [r(4, 23, 6, 27), r(9, 41, 11, 43)],
    trees: [
      { x: 9, y: 5 },
      { x: 14, y: 7 },
      { x: 35, y: 5 },
      { x: 42, y: 8 },
      { x: 11, y: 31 },
      { x: 39, y: 31 },
      { x: 15, y: 45 },
      { x: 37, y: 44 },
      { x: 2, y: 4 },
      { x: 7, y: 3 },
      { x: 17, y: 4 },
      { x: 32, y: 4 },
      { x: 44, y: 4 },
      { x: 47, y: 12 },
      { x: 46, y: 23 },
      { x: 46, y: 35 },
      { x: 45, y: 46 },
      { x: 31, y: 46 },
      { x: 19, y: 46 },
      { x: 8, y: 46 },
      { x: 9, y: 29 },
      { x: 41, y: 28 },
      { x: 19, y: 8 },
      { x: 25, y: 11 },
      { x: 29, y: 6 },
      { x: 20, y: 40 },
      { x: 30, y: 43 },
    ],
    buildings: [
      b('west-lodge', r(8, 10, 16, 20), { x: 16, y: 16 }, TileCode.TERRACE, TileCode.YARD, [
        d(r(12, 11, 12, 19), { x: 12, y: 16 }),
      ]),
      b('cookhouse', r(34, 9, 43, 20), { x: 34, y: 15 }, TileCode.TERRACE, TileCode.YARD, [
        d(r(35, 14, 42, 14), { x: 38, y: 14 }),
      ]),
      b('drovers-hut', r(8, 32, 16, 44), { x: 16, y: 36 }, TileCode.TERRACE, TileCode.YARD, [
        d(r(9, 38, 15, 38), { x: 12, y: 38 }),
      ]),
      b('east-lodge', r(34, 32, 43, 44), { x: 34, y: 36 }, TileCode.TERRACE, TileCode.YARD, [
        d(r(35, 38, 42, 38), { x: 38, y: 38 }),
      ]),
    ],
    spawns: SOUTH_SPAWNS,
    residents: {
      carrow: { x: 25, y: 24 },
      ash: { x: 25, y: 45 },
      fen: { x: 36, y: 15 },
    },
    props: [
      p(25, 25, 'prop_campfire'),
      p(21, 23, 'prop_bedroll'),
      p(29, 23, 'prop_bedroll'),
      p(20, 28, 'prop_tent'),
      p(30, 28, 'prop_tent'),
      p(36, 15, 'prop_shop_counter'),
      p(40, 12, 'prop_cauldron'),
      p(14, 36, 'prop_crate'),
      p(37, 36, 'prop_barrel'),
      p(18, 25, 'prop_wagon'),
      p(32, 25, 'prop_handcart'),
      p(9, 24, 'prop_fishing_net'),
      p(5, 36, 'prop_eel_trap'),
      p(12, 29, 'prop_tree_stump'),
      p(39, 29, 'prop_fallen_log'),
      p(9, 12, 'prop_bedroll'),
      p(14, 12, 'prop_hearth'),
      p(9, 18, 'prop_crate'),
      p(15, 18, 'prop_barrel'),
      p(42, 11, 'prop_grain_sack'),
      p(36, 11, 'prop_barrel'),
      p(42, 18, 'prop_hearth'),
      p(9, 34, 'prop_bedroll'),
      p(15, 42, 'prop_crate'),
      p(9, 42, 'prop_grain_sack'),
      p(42, 34, 'prop_bedroll'),
      p(42, 42, 'prop_barrel'),
      p(36, 42, 'prop_crate'),
      p(14, 30, 'prop_flowering_shrub'),
      p(37, 30, 'prop_flowering_shrub'),
      p(19, 20, 'prop_toadstools'),
      p(31, 20, 'prop_toadstools'),
      p(5, 13, 'prop_wetland_reeds'),
      p(5, 20, 'prop_wetland_reeds'),
      p(5, 33, 'prop_wetland_reeds'),
      p(5, 39, 'prop_wetland_reeds'),
    ],
  },
};

function fill(tiles: number[], rect: Rect, code: number): void {
  for (let y = rect.y0; y <= rect.y1; y += 1) {
    for (let x = rect.x0; x <= rect.x1; x += 1) {
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      tiles[tileIndex(x, y, W)] = code;
    }
  }
}

function drawBuilding(tiles: number[], plan: BuildingPlan): void {
  const { shell } = plan;
  fill(tiles, shell, plan.wall);
  fill(tiles, r(shell.x0 + 1, shell.y0 + 1, shell.x1 - 1, shell.y1 - 1), plan.floor);
  for (const divider of plan.dividers) {
    fill(tiles, divider.wall, plan.wall);
    tiles[tileIndex(divider.door.x, divider.door.y, W)] = TileCode.DOOR;
  }
  tiles[tileIndex(plan.door.x, plan.door.y, W)] = TileCode.DOOR;
}

function build(plan: TownPlan): AuthoredMap {
  const tiles = new Array<number>(W * H).fill(plan.base);

  // A visible edge makes the settlement a place rather than an infinite rug.
  fill(tiles, r(0, 0, W - 1, 0), plan.boundary);
  fill(tiles, r(0, H - 1, W - 1, H - 1), plan.boundary);
  fill(tiles, r(0, 0, 0, H - 1), plan.boundary);
  fill(tiles, r(W - 1, 0, W - 1, H - 1), plan.boundary);

  // Planting fields first, then streets, water and explicit bridges. That ordering makes a
  // canal continuous until somebody deliberately authors a crossing.
  for (const ground of plan.grounds) fill(tiles, ground, ground.tile);
  for (const street of plan.streets) fill(tiles, street, street.tile);
  for (const water of plan.waters) fill(tiles, water, TileCode.WATER);
  for (const bridge of plan.bridges) fill(tiles, bridge, TileCode.BRIDGE);
  for (const tree of plan.trees) tiles[tileIndex(tree.x, tree.y, W)] = TileCode.TREES;
  for (const building of plan.buildings) drawBuilding(tiles, building);

  // Arrival is a fact, not scenery. Reassert it after all drawing so a future
  // street or building edit cannot quietly put a body in water or a wall.
  for (const spawn of plan.spawns)
    tiles[tileIndex(spawn.x, spawn.y, W)] = plan.streets[0]?.tile ?? plan.base;

  return {
    view: { w: W, h: H, tiles },
    spawns: plan.spawns,
    sites: new Map<string, string>(),
    rooms: plan.buildings.map((building) => building.shell),
  };
}

/** Authored map for one of the five settlements, or undefined for a delve. */
export function makeSettlementMap(siteId: string): AuthoredMap | undefined {
  const plan = PLANS[siteId];
  return plan === undefined ? undefined : build(plan);
}

/** Building metadata for reachability and visual QA. */
export function townBuildingsFor(siteId: string): readonly TownBuilding[] {
  return PLANS[siteId]?.buildings ?? [];
}

/** A resident's authored workplace or gathering spot. */
export function townResidentAt(siteId: string | undefined, residentId: string): TileXY | undefined {
  if (siteId === undefined) return undefined;
  return PLANS[siteId]?.residents[residentId];
}

/** Every piece of furnishing in a settlement, in painter order. */
export function townPropsFor(siteId: string | undefined): readonly TownPropPlacement[] {
  if (siteId === undefined) return [];
  return PLANS[siteId]?.props ?? [];
}

/** Put the already-commissioned civic/interior art into the actual world. */
export function placeTownProps(world: World, siteId: string | undefined): number {
  const props = townPropsFor(siteId);
  for (const prop of props) world.addProp(prop, prop.propId);
  return props.length;
}
