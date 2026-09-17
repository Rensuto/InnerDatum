// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// The rules under test are t-engine4 game/modules/tome/data/general/grids/*.lua and
// game/modules/tome/data/zones/infinite-dungeon/grids.lua, cited per row below.
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

import { describe, expect, it } from 'vitest';

import { DamageType } from '../../src/shared/damagetype.ts';
import {
  TileCode,
  alwaysRemembered,
  blocksSight,
  isHaunt,
  isSafeGround,
  isWalkable,
} from '../../src/shared/protocol.ts';
import {
  AIR_LEVEL,
  ON_STAND,
  airOf,
  breathes,
  isClosedDoorCode,
  isHazardFor,
  openedFormOf,
  passesProjectile,
} from '../../src/shared/terrain.ts';
import type { Breather } from '../../src/shared/terrain.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * EVERY THEMED CODE, AGAINST THE GRID IT NAMES.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * One row per code, each answer read off the Lua at the cited line:
 * `does_block_move` is walk, `block_sight` is sight, `always_remember` is
 * memory. A row is the grid, not our opinion of it.
 *
 * ═══ WHY `blocks` IS ONLY HALF A TEST ═══
 * `blocksSight` fails CLOSED, so an opaque answer is also what a code in no set
 * gets by default. The rows that guard something are the CLEAR ones on a solid
 * code (MOLTEN_LAVA, OUTERSPACE) and the walkable ones: drop either from its
 * set and the row goes red. `test/shared/doors.test.ts` measured the same
 * asymmetry for DOOR.
 */
type Row = {
  readonly name: keyof typeof TileCode;
  readonly walk: boolean;
  readonly clear: boolean;
  readonly remember: boolean;
  readonly grid: string;
};

const ROWS: readonly Row[] = [
  {
    name: 'POND_WATER',
    walk: true,
    clear: true,
    remember: true,
    grid: 'water.lua:136-140, AR via WATER_BASE :127',
  },
  { name: 'WATER_FLOOR', walk: true, clear: true, remember: false, grid: 'water.lua:24-31' },
  {
    name: 'WATER_FLOOR_FAKE',
    walk: true,
    clear: true,
    remember: false,
    grid: 'infinite-dungeon/grids.lua:262-268',
  },
  {
    name: 'WATER_FLOOR_BUBBLE',
    walk: true,
    clear: true,
    remember: false,
    grid: 'water.lua:98-116',
  },
  { name: 'WATER_WALL', walk: false, clear: false, remember: true, grid: 'water.lua:34-52' },
  { name: 'LAVA_FLOOR', walk: true, clear: true, remember: false, grid: 'lava.lua:24-43' },
  {
    name: 'LAVA_FLOOR_FAKE',
    walk: true,
    clear: true,
    remember: false,
    grid: 'infinite-dungeon/grids.lua:345-353',
  },
  { name: 'LAVA_WALL', walk: false, clear: false, remember: true, grid: 'lava.lua:45-56' },
  { name: 'MOLTEN_LAVA', walk: false, clear: true, remember: false, grid: 'lava.lua:59-70' },
  { name: 'OUTERSPACE', walk: false, clear: true, remember: true, grid: 'void.lua:30-42' },
  { name: 'FLOATING_ROCKS', walk: true, clear: true, remember: false, grid: 'void.lua:59-79' },
  { name: 'VOID', walk: true, clear: true, remember: false, grid: 'void.lua:22-28' },
  {
    name: 'SPACETIME_RIFT',
    walk: false,
    clear: false,
    remember: true,
    grid: 'infinite-dungeon/grids.lua:245-256',
  },
  { name: 'CRYSTAL_FLOOR', walk: true, clear: true, remember: false, grid: 'crystal.lua:36-43' },
  { name: 'CRYSTAL_WALL', walk: false, clear: false, remember: true, grid: 'crystal.lua:20-34' },
  { name: 'SLIME_FLOOR', walk: true, clear: true, remember: false, grid: 'slime.lua:23-30' },
  { name: 'SLIME_WALL', walk: false, clear: false, remember: true, grid: 'slime.lua:33-46' },
  { name: 'SANDWALL', walk: false, clear: false, remember: true, grid: 'sand.lua:42-95' },
  { name: 'BURNT_TREE', walk: false, clear: false, remember: true, grid: 'burntland.lua:20-32' },
  {
    name: 'UNDERGROUND_FLOOR',
    walk: true,
    clear: true,
    remember: false,
    grid: 'underground_gloomy.lua:20-27',
  },
  {
    name: 'UNDERGROUND_TREE',
    walk: false,
    clear: false,
    remember: true,
    grid: 'underground_gloomy.lua:62-74',
  },
  {
    name: 'ROCK_DOOR',
    walk: false,
    clear: false,
    remember: true,
    grid: 'infinite-dungeon/grids.lua:36-48',
  },
];

describe('the twenty-two themed codes', () => {
  it('are 34 to 55, appended, with a row here for every one', () => {
    // A code added after these without a row would carry no pinned answer.
    const themed = Object.entries(TileCode)
      .filter(([, code]) => code >= TileCode.POND_WATER)
      .map(([name]) => name);
    expect(themed.sort()).toEqual(ROWS.map((row) => row.name).sort());
    expect(ROWS.map((row) => TileCode[row.name])).toEqual(
      Array.from({ length: 22 }, (_, i) => 34 + i),
    );
  });

  it.each(ROWS)('$name walks, sees and remembers as its grid does ($grid)', (row) => {
    const code = TileCode[row.name];
    expect(isWalkable(code), 'walk').toBe(row.walk);
    expect(blocksSight(code), 'sight').toBe(!row.clear);
    expect(alwaysRemembered(code), 'always_remember').toBe(row.remember);
  });

  it('keeps every themed floor off the safe network (D5-5)', () => {
    // Walkable and not a haunt is `isSafeGround`, which the minimap paints in
    // road colour. Dungeon water and lava are not a road.
    for (const row of ROWS.filter((r) => r.walk)) {
      const code = TileCode[row.name];
      expect(isHaunt(code), `${row.name} is not a haunt`).toBe(true);
      expect(isSafeGround(code), `${row.name} reads as safe road`).toBe(false);
    }
  });
});

describe('AIR_LEVEL — `air_level` under your feet', () => {
  it('is exactly the three floors upstream gives one', () => {
    expect(AIR_LEVEL).toEqual({
      // data/general/grids/water.lua:139
      [TileCode.POND_WATER]: { level: -5, condition: 'water' },
      // data/general/grids/water.lua:29
      [TileCode.WATER_FLOOR]: { level: -5, condition: 'water' },
      // data/general/grids/water.lua:104, and no `air_condition`
      [TileCode.WATER_FLOOR_BUBBLE]: { level: 15 },
    });
  });

  it('has nothing on a FAKE floor, and nothing on a wall (D5-3)', () => {
    expect(airOf(TileCode.WATER_FLOOR_FAKE)).toBeUndefined();
    expect(airOf(TileCode.WATER_WALL)).toBeUndefined();
    expect(airOf(TileCode.OUTERSPACE)).toBeUndefined();
    expect(airOf(TileCode.FLOOR)).toBeUndefined();
    expect(airOf(999)).toBeUndefined();
  });
});

describe('ON_STAND — what standing there does', () => {
  it('burns on real lava for mbonus(5,15)..mbonus(10,30) fire, and bubbles 4..7 charges', () => {
    expect(ON_STAND).toEqual({
      // data/general/grids/lava.lua:30-32
      [TileCode.LAVA_FLOOR]: {
        kind: 'burn',
        type: DamageType.Fire,
        mindam: [5, 15],
        maxdam: [10, 30],
      },
      // data/general/grids/water.lua:104, :111
      [TileCode.WATER_FLOOR_BUBBLE]: {
        kind: 'bubble',
        charges: [4, 7],
        depletesTo: TileCode.WATER_FLOOR,
      },
    });
  });
});

describe('passesProjectile — engine/Target.lua:458-468', () => {
  it('lets a bolt over molten lava and the void, which a body cannot cross', () => {
    for (const code of [TileCode.MOLTEN_LAVA, TileCode.OUTERSPACE]) {
      expect(isWalkable(code), `${String(code)} is walkable`).toBe(false);
      expect(passesProjectile(code), `${String(code)} stopped a bolt`).toBe(true);
    }
  });

  it('stops one on every other solid code, the canal and a shut door included', () => {
    for (const code of [
      TileCode.WALL,
      TileCode.LAVA_WALL,
      TileCode.SPACETIME_RIFT,
      TileCode.WATER_WALL,
      TileCode.WATER,
      TileCode.DEEPWATER,
      TileCode.FROZEN_WATER,
      TileCode.DOOR,
      TileCode.ROCK_DOOR,
    ]) {
      expect(passesProjectile(code), `${String(code)} let a bolt through`).toBe(false);
    }
    expect(passesProjectile(999), 'an unknown code let a bolt through').toBe(false);
  });

  it('passes every walkable code', () => {
    for (const code of Object.values(TileCode)) {
      if (isWalkable(code)) expect(passesProjectile(code), String(code)).toBe(true);
    }
  });
});

describe('the closed-door family', () => {
  it('is DOOR and ROCK_DOOR, and nothing else', () => {
    const closed = Object.values(TileCode).filter((code) => isClosedDoorCode(code));
    expect(closed.sort((a, b) => a - b)).toEqual([TileCode.DOOR, TileCode.ROCK_DOOR]);
    expect(isClosedDoorCode(999)).toBe(false);
  });

  it('opens a door into DOOR_OPEN, whatever the floor', () => {
    expect(openedFormOf(TileCode.DOOR, TileCode.SOOT)).toBe(TileCode.DOOR_OPEN);
  });

  it('opens a rock door into the floor it is given', () => {
    // GRASS_ROCK into GRASS, CAVE_ROCK into CAVEFLOOR:
    // data/zones/infinite-dungeon/grids.lua:45, :111.
    expect(openedFormOf(TileCode.ROCK_DOOR, TileCode.GREEN)).toBe(TileCode.GREEN);
    expect(openedFormOf(TileCode.ROCK_DOOR, TileCode.SOOT)).toBe(TileCode.SOOT);
  });
});

describe('breathes — tome/class/Actor.lua:586, negated', () => {
  const water = { level: -5, condition: 'water' } as const;
  const bubble = { level: 15 } as const;

  it('needs a positive can_breath for the condition', () => {
    expect(breathes({ canBreath: { water: 1 } }, water)).toBe(true);
    expect(breathes({ canBreath: { water: 0 } }, water), '`<= 0` is no breath').toBe(false);
    expect(breathes({ canBreath: { water: -1 } }, water)).toBe(false);
    expect(breathes({ canBreath: {} }, water)).toBe(false);
    expect(breathes({}, water)).toBe(false);
  });

  it('is false for air with no condition, however the body breathes', () => {
    expect(breathes({ canBreath: { water: 5 } }, bubble)).toBe(false);
  });

  it('does not read no_breath, which stops `suffocate` instead (tome/class/Actor.lua:6726)', () => {
    expect(breathes({ noBreath: true }, water)).toBe(false);
  });
});

describe('isHazardFor', () => {
  const plain: Breather = {};
  const gills: Breather = { canBreath: { water: 1 } };
  const undead: Breather = { noBreath: true };

  it('is deep water and the seabed for a body that cannot breathe water', () => {
    for (const code of [TileCode.POND_WATER, TileCode.WATER_FLOOR]) {
      expect(isHazardFor(code, plain), `${String(code)} plain`).toBe(true);
      expect(isHazardFor(code, gills), `${String(code)} gills`).toBe(false);
      expect(isHazardFor(code, undead), `${String(code)} no_breath`).toBe(false);
    }
  });

  it('is never the bubble, which gives air rather than taking it', () => {
    expect(isHazardFor(TileCode.WATER_FLOOR_BUBBLE, plain)).toBe(false);
  });

  it('is real lava for everybody, breathing or not', () => {
    for (const body of [plain, gills, undead]) {
      expect(isHazardFor(TileCode.LAVA_FLOOR, body)).toBe(true);
    }
  });

  it('is never a FAKE floor, which is the reason those codes exist (D5-1)', () => {
    for (const code of [TileCode.WATER_FLOOR_FAKE, TileCode.LAVA_FLOOR_FAKE]) {
      expect(isHazardFor(code, plain), String(code)).toBe(false);
    }
  });

  it('is nothing else in the vocabulary', () => {
    const hazards = Object.values(TileCode).filter((code) => isHazardFor(code, plain));
    expect(hazards.sort((a, b) => a - b)).toEqual([
      TileCode.POND_WATER,
      TileCode.WATER_FLOOR,
      TileCode.LAVA_FLOOR,
    ]);
  });
});
