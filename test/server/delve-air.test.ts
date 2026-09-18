// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/modules/tome/class/Grid.lua:102-109 (a body is never put where it cannot breathe)
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" — https://te4.org/license

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A DELVE NEVER PUTS A BODY WHERE IT WOULD DROWN.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `Grid:block_move`'s "huge hack": a body not yet on the map treats every grid
 * with an `air_level` as a wall, unless it has `no_breath` or breathes that air.
 *
 * Each floor below is half dry ground and half something else, so the rule is
 * the only thing that decides where a body lands. The same seed with a roster
 * that does not breathe is the precondition every time: it draws the very same
 * numbers (`delve.count`, `delve.offset`) and shows where the placer would have
 * put a body that the ground does not refuse.
 */

import { describe, expect, it } from 'vitest';

import { floorsOf, nbNpcFor, populateDelve, specFor } from '../../src/server/content/delve.ts';
import type { DelveSpec } from '../../src/server/content/delve.ts';
import {
  INDEX_HUSK,
  INDEX_HUSK_ELITE,
  INDEX_WATCHER,
  INDEX_WRAITH,
} from '../../src/server/content/monsters.ts';
import type { MonsterTemplate } from '../../src/server/content/monsters.ts';
import { createWorld } from '../../src/server/world/world.ts';
import type { World } from '../../src/server/world/world.ts';
import { tileIndex } from '../../src/shared/coords.ts';
import type { AuthoredMap } from '../../src/shared/level.ts';
import { ActorKind, TileCode } from '../../src/shared/protocol.ts';

const W = 40;
const H = 20;

/** Floor inside a wall ring, with everything from column 20 rightward painted `right`. */
function halfAndHalf(right: TileCode, vaults?: AuthoredMap['vaults']): AuthoredMap {
  const tiles: number[] = [];
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const inside = x > 0 && y > 0 && x < W - 1 && y < H - 1;
      tiles.push(!inside ? TileCode.WALL : x >= 20 ? right : TileCode.FLOOR);
    }
  }
  return {
    view: { w: W, h: H, tiles },
    spawns: [{ x: 2, y: 2 }],
    sites: new Map(),
    ...(vaults === undefined ? {} : { vaults }),
  };
}

/** A room drawn wholly inside the right half. */
const WET_ROOM = { id: 'vault:wet', at: { x: 26, y: 6 }, turn: 'none', w: 6, h: 6 } as const;

function underworks(): DelveSpec {
  const spec = specFor('site:underworks');
  if (spec === undefined) throw new Error('no spec for the Underworks');
  return spec;
}

function rosterOf(roster: readonly MonsterTemplate[]): DelveSpec {
  return { ...underworks(), nbNpc: [10, 10], roster, traps: undefined, boss: undefined };
}

function codesUnder(world: World): number[] {
  return world
    .allActors()
    .filter((actor) => actor.kind === ActorKind.Monster)
    .map((actor) => world.level.tiles[tileIndex(actor.x, actor.y, world.level.w)] ?? -1);
}

function populate(seed: string, map: AuthoredMap, spec: DelveSpec, floor = 1) {
  const world = createWorld(seed, map);
  const placed = populateDelve(world, map, spec, undefined, floor);
  return { world, placed, under: codesUnder(world) };
}

describe('Grid.lua:102-109 — nobody is born under water', () => {
  it('a body that breathes air is never put on deep water, in the room or out of it', () => {
    for (let n = 0; n < 6; n += 1) {
      const seed = `delve-air-${String(n)}`;
      const map = halfAndHalf(TileCode.POND_WATER, [WET_ROOM]);
      const wraiths = populate(seed, map, rosterOf([INDEX_WRAITH]));
      expect(wraiths.under, 'precondition: the placer reaches the water').toContain(
        TileCode.POND_WATER,
      );

      const husks = populate(
        seed,
        halfAndHalf(TileCode.POND_WATER, [WET_ROOM]),
        rosterOf([INDEX_HUSK]),
      );
      // THE BAND THE PLACER USES, not the one the fixture states: `nbNpcFor`
      // applies `NB_NPC_SCALE` to it (see `DelveSpec.nbNpc`).
      expect(husks.placed).toBe(nbNpcFor(rosterOf([INDEX_HUSK]), 1)[1]);
      expect(husks.under).not.toContain(TileCode.POND_WATER);
    }
  });

  it('refuses a bubble too: any `air_level`, and a grid naming no condition is breathed by nobody', () => {
    const seed = 'delve-air-bubble';
    const wraiths = populate(
      seed,
      halfAndHalf(TileCode.WATER_FLOOR_BUBBLE),
      rosterOf([INDEX_WRAITH]),
    );
    expect(wraiths.under, 'precondition').toContain(TileCode.WATER_FLOOR_BUBBLE);
    const husks = populate(seed, halfAndHalf(TileCode.WATER_FLOOR_BUBBLE), rosterOf([INDEX_HUSK]));
    expect(husks.under).not.toContain(TileCode.WATER_FLOOR_BUBBLE);
  });

  it('puts a body that breathes water in the water (`can_breath.water > 0`)', () => {
    const gilled: MonsterTemplate = { ...INDEX_HUSK, canBreath: { water: 1 } };
    const seed = 'delve-air-gills';
    const husks = populate(seed, halfAndHalf(TileCode.POND_WATER), rosterOf([gilled]));
    expect(husks.under).toContain(TileCode.POND_WATER);
    const dry = populate(
      seed,
      halfAndHalf(TileCode.POND_WATER),
      rosterOf([{ ...gilled, canBreath: { water: 0 } }]),
    );
    expect(dry.under, 'a count of zero is no breath at all').not.toContain(TileCode.POND_WATER);
  });

  it('does not refuse the fake seabed, which carries no air rule', () => {
    const husks = populate(
      'delve-air-fake',
      halfAndHalf(TileCode.WATER_FLOOR_FAKE),
      rosterOf([INDEX_HUSK]),
    );
    expect(husks.under).toContain(TileCode.WATER_FLOOR_FAKE);
  });

  it('places nobody at all where there is no ground the body can breathe on', () => {
    const map = halfAndHalf(TileCode.POND_WATER);
    // Drown the dry half too, all but the arrival's clearance ring.
    for (let y = 1; y < H - 1; y += 1) {
      for (let x = 1; x < 20; x += 1) {
        if (Math.max(Math.abs(x - 2), Math.abs(y - 2)) >= 6) {
          map.view.tiles[tileIndex(x, y, W)] = TileCode.POND_WATER;
        }
      }
    }
    const husks = populate('delve-air-drowned', map, rosterOf([INDEX_HUSK]));
    expect(husks.placed).toBe(0);
    expect(husks.under).toEqual([]);
  });

  it('the boss stands at the far end of the ground it can breathe on', () => {
    // The far corner is under water. A boss that breathes stops at the shore.
    const spec = (boss: MonsterTemplate): DelveSpec => ({ ...rosterOf([INDEX_WRAITH]), boss });
    const floor = floorsOf(spec(INDEX_WATCHER));
    const bossOf = (world: World) =>
      world.allActors().find((actor) => actor.id.endsWith('delve_boss'));

    const watcher = populate(
      'delve-air-boss',
      halfAndHalf(TileCode.POND_WATER),
      spec(INDEX_WATCHER),
      floor,
    );
    const far = bossOf(watcher.world);
    expect(far?.x, 'precondition: the far end is in the water').toBeGreaterThanOrEqual(20);

    const elite = populate(
      'delve-air-boss',
      halfAndHalf(TileCode.POND_WATER),
      spec(INDEX_HUSK_ELITE),
      floor,
    );
    const shore = bossOf(elite.world);
    expect(shore).toBeDefined();
    expect(shore?.x).toBeLessThan(20);
  });
});

describe('every body lands where the placer aimed it', () => {
  it('no body is handed to the ring search, which does not know what it may breathe', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * TWO AIMS COULD NAME ONE TILE, AND THE SECOND BODY WENT WHEREVER WAS NEAR.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * The guard is aimed into the drawn room and every body after it into the
     * whole of its share, and the two indexings can land on one tile. The
     * later body then reached `world.addMonster`'s search for the nearest free
     * tile, which asks nothing about air: over 4,800 Weir floors 151 bodies
     * were moved that way and 13 were born on a bubble. The placer now steps
     * on through the body's own share instead.
     *
     * Measured before the fix, on this file's two floors at the sizes below:
     * 52 of 1,800 floors moved a body.
     */
    const DRY_ROOM = { id: 'vault:dry', at: { x: 10, y: 6 }, turn: 'none', w: 6, h: 6 } as const;
    const cases = [
      [TileCode.FLOOR, INDEX_WRAITH],
      [TileCode.POND_WATER, INDEX_HUSK],
    ] as const;
    let floors = 0;
    for (const [right, template] of cases) {
      for (const n of [6, 10, 14]) {
        for (let s = 0; s < 100; s += 1) {
          const map = halfAndHalf(right, [DRY_ROOM]);
          const world = createWorld(`delve-aim-${String(n)}-${String(s)}`, map);
          const place = world.addMonster.bind(world);
          const moved: string[] = [];
          world.addMonster = (id, init) => {
            const body = place(id, init);
            if (body.x !== init.x || body.y !== init.y) {
              moved.push(
                `${id} aimed ${String(init.x)},${String(init.y)} put ${String(body.x)},${String(body.y)}`,
              );
            }
            return body;
          };
          const spec = { ...rosterOf([template]), nbNpc: [n, n] as const };
          const placed = populateDelve(world, map, spec, undefined, 1);
          expect(placed, 'precondition: the whole band was placed').toBe(nbNpcFor(spec, 1)[1]);
          expect(
            moved,
            `${template.id} on ${String(right)}, ${String(n)} bodies, seed ${String(s)}`,
          ).toEqual([]);
          floors += 1;
        }
      }
    }
    expect(floors).toBe(600);
  });
});
