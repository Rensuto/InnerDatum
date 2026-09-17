import { describe, expect, it } from 'vitest';

import { Dir, tileIndex } from '../../src/shared/coords.ts';
import { makeTestMap } from '../../src/shared/level.ts';
import { TileCode, isWalkable } from '../../src/shared/protocol.ts';
import {
  makeSettlementMap,
  townBuildingsFor,
  townPropsFor,
  townResidentAt,
} from '../../src/server/content/towns.ts';
import { ShopShelf } from '../../src/server/content/shops.ts';
import { TOWNSFOLK } from '../../src/server/content/townsfolk.ts';
import { createTurnEngine } from '../../src/server/turn-engine.ts';
import { projectActors } from '../../src/server/view/projector.ts';
import { createRealms } from '../../src/server/world/realms.ts';
import { createWorld } from '../../src/server/world/world.ts';

const SETTLEMENTS = [
  'site:alderbrook',
  'site:threadneedle_row',
  'site:ashwick_row',
  'site:saints_rest',
  'site:wayfarers_camp',
] as const;

function reachable(map: NonNullable<ReturnType<typeof makeSettlementMap>>): ReadonlySet<number> {
  const start = map.spawns[0];
  if (start === undefined) return new Set<number>();
  const seen = new Set<number>([tileIndex(start.x, start.y, map.view.w)]);
  const queue = [start];
  for (let at = 0; at < queue.length; at += 1) {
    const here = queue[at];
    if (here === undefined) continue;
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const x = here.x + dx;
      const y = here.y + dy;
      if (x < 0 || y < 0 || x >= map.view.w || y >= map.view.h) continue;
      const index = tileIndex(x, y, map.view.w);
      const code = map.view.tiles[index];
      if (seen.has(index) || (code !== TileCode.DOOR && !isWalkable(code ?? TileCode.WALL))) {
        continue;
      }
      seen.add(index);
      queue.push({ x, y });
    }
  }
  return seen;
}

describe('authored settlements', () => {
  for (const siteId of SETTLEMENTS) {
    it(`${siteId} has reachable interiors, green ground, water and bridges`, () => {
      const map = makeSettlementMap(siteId);
      expect(map, `${siteId} has no authored plan`).toBeDefined();
      if (map === undefined) return;

      expect({ w: map.view.w, h: map.view.h }).toEqual({ w: 50, h: 50 });
      const codes = map.view.tiles;
      expect(codes.filter((code) => code === TileCode.GREEN).length).toBeGreaterThan(100);
      expect(codes.filter((code) => code === TileCode.WATER).length).toBeGreaterThan(20);
      expect(codes.filter((code) => code === TileCode.BRIDGE).length).toBeGreaterThan(0);

      const seen = reachable(map);
      const buildings = townBuildingsFor(siteId);
      expect(buildings.length).toBeGreaterThanOrEqual(4);
      for (const building of buildings) {
        const { shell, door } = building;
        expect(map.view.tiles[tileIndex(door.x, door.y, map.view.w)]).toBe(TileCode.DOOR);

        // The shell is a wall perimeter, never a filled roof block.
        let inside = 0;
        let walkableInside = 0;
        for (let y = shell.y0 + 1; y < shell.y1; y += 1) {
          for (let x = shell.x0 + 1; x < shell.x1; x += 1) {
            const index = tileIndex(x, y, map.view.w);
            inside += 1;
            if (!isWalkable(map.view.tiles[index] ?? TileCode.WALL)) continue;
            walkableInside += 1;
            expect(seen.has(index), `${building.id} has a sealed room`).toBe(true);
          }
        }
        expect(walkableInside, `${building.id} has no usable inside`).toBeGreaterThan(inside * 0.6);
      }

      expect(townPropsFor(siteId).length).toBeGreaterThanOrEqual(14);
      for (const prop of townPropsFor(siteId)) {
        const code = map.view.tiles[tileIndex(prop.x, prop.y, map.view.w)] ?? TileCode.WALL;
        if (prop.propId === 'prop_wetland_reeds' || prop.propId === 'prop_eel_trap') {
          expect(code, `${siteId}/${prop.propId} is not in its waterway`).toBe(TileCode.WATER);
        } else {
          expect(isWalkable(code), `${siteId}/${prop.propId} was buried in architecture`).toBe(
            true,
          );
        }
      }
      for (const person of TOWNSFOLK.get(siteId) ?? []) {
        const at = townResidentAt(siteId, person.id);
        expect(at, `${siteId}/${person.id} has no authored place`).toBeDefined();
        if (at !== undefined) {
          expect(
            isWalkable(map.view.tiles[tileIndex(at.x, at.y, map.view.w)] ?? TileCode.WALL),
          ).toBe(true);
        }
      }
    });
  }

  it('gives every settlement a different plan', () => {
    const layouts = SETTLEMENTS.map((siteId) => makeSettlementMap(siteId)?.view.tiles.join(','));
    expect(new Set(layouts).size).toBe(SETTLEMENTS.length);
  });

  it('puts every settlement shop behind a visible counter with a physical keeper', () => {
    const realms = createRealms({
      seed: 'town-shops',
      engineFor: (world) => createTurnEngine({ world }),
    });
    const expected = [
      ['site:alderbrook', 'nell', ShopShelf.General],
      ['site:threadneedle_row', 'merrow', ShopShelf.Outfitter],
      ['site:ashwick_row', 'thessaly', ShopShelf.Apothecary],
      ['site:saints_rest', 'colley', ShopShelf.Reliquary],
      ['site:wayfarers_camp', 'fen', ShopShelf.Caravan],
    ] as const;

    for (const [siteId, keeperId, shelf] of expected) {
      const realm = realms.all().find((candidate) => candidate.siteId === siteId);
      expect(realm, `${siteId} was not built`).toBeDefined();
      if (realm === undefined) continue;
      expect(realm.shop?.shelf).toBe(shelf);
      const keeper = realm.world.getActor(`${realm.world.id}:town:${keeperId}`);
      expect(keeper, `${keeperId} is absent`).toBeDefined();
      expect(
        realm.world
          .props()
          .some(
            (prop) =>
              prop.propId === 'prop_shop_counter' && prop.x === keeper?.x && prop.y === keeper?.y,
          ),
        `${keeperId} is not standing at a counter`,
      ).toBe(true);
    }
  });

  it('puts a resident in sight of every arrival', () => {
    const realms = createRealms({
      seed: 'town-arrivals',
      engineFor: (world) => createTurnEngine({ world }),
    });

    for (const siteId of SETTLEMENTS) {
      const realm = realms.all().find((candidate) => candidate.siteId === siteId);
      const map = makeSettlementMap(siteId);
      expect(realm, `${siteId} was not built`).toBeDefined();
      expect(map, `${siteId} has no authored map`).toBeDefined();
      if (realm === undefined || map === undefined) continue;

      const visitor = realm.world.addPlayer(`${siteId}:arrival-test`, 'Visitor');
      for (const resident of TOWNSFOLK.get(siteId) ?? []) {
        const expected = townResidentAt(siteId, resident.id);
        const actor = realm.world.getActor(`${realm.world.id}:town:${resident.id}`);
        expect(actor, `${siteId}/${resident.id} was not placed`).toBeDefined();
        expect(actor === undefined ? undefined : { x: actor.x, y: actor.y }).toEqual(expected);
      }
      for (const spawn of map.spawns) {
        expect(realm.world.placeAt(visitor.id, spawn)).toBe(true);
        expect(
          projectActors(realm.world, [visitor]).some((actor) => actor.id.includes(':town:')),
          `${siteId} has nobody visible from arrival ${String(spawn.x)},${String(spawn.y)}`,
        ).toBe(true);
      }
    }
  });

  it('populates Alderbrook with rooms, furnishings and four residents', () => {
    const realms = createRealms({
      seed: 'alderbrook-lived-in',
      engineFor: (world) => createTurnEngine({ world }),
    });
    const town = realms.all().find((realm) => realm.siteId === 'site:alderbrook');
    expect(town).toBeDefined();
    expect(town?.world.props().length).toBeGreaterThanOrEqual(15);
    expect(town?.world.allActors().filter((actor) => actor.id.includes(':town:')).length).toBe(4);
  });
});

describe('furnishing collision', () => {
  it('stops a body at a civic prop but not at inert floor dressing', () => {
    const world = createWorld('prop-collision', makeTestMap());
    const player = world.addPlayer('p1', 'Ren');
    expect(world.placeAt(player.id, { x: 3, y: 2 })).toBe(true);

    world.addProp({ x: 4, y: 2 }, 'prop_shop_counter');
    expect(world.tryMove(player.id, Dir.E)).toEqual({ ok: false, reason: 'occupied' });

    world.addProp({ x: 3, y: 3 }, 'prop_eldritch_chalk_sigil_01');
    expect(world.tryMove(player.id, Dir.S)).toEqual({ ok: true, x: 3, y: 3 });
  });
});
