import { describe, expect, it } from 'vitest';

import { lightLevel } from '../../src/shared/light.ts';
import { createRng } from '../../src/shared/rng.ts';
import { makeSiteMap, SiteShape } from '../../src/shared/sitemap.ts';

describe('the light a level makes on its own', () => {
  const works = makeSiteMap('light-works', SiteShape.Works);
  const size = { w: works.view.w, h: works.view.h };
  const rooms = works.rooms ?? [];
  const inRoom = (x: number, y: number): boolean =>
    rooms.some((r) => x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1);

  it('is lit everywhere when the site says nothing, as every level has been', () => {
    const lit = lightLevel(size, rooms, undefined, createRng('a'));
    expect(lit.length).toBe(size.w * size.h);
    expect(lit.every((bit) => bit === 1)).toBe(true);
  });

  it('is lit everywhere when the site is all lit, whatever the rooms roll', () => {
    // engine/Zone.lua:1034: `all_lited` lights the whole map.
    const lit = lightLevel(size, rooms, { allLit: true, litRoomChance: 0 }, createRng('a'));
    expect(lit.every((bit) => bit === 1)).toBe(true);
  });

  it('lights every room whole, walls and all, and nothing outside a room', () => {
    // engine/generator/map/RoomsLoader.lua:652 lights every cell of the room.
    expect(rooms.length).toBeGreaterThan(1);
    const lit = lightLevel(size, rooms, { litRoomChance: 100 }, createRng('a'));
    let outside = 0;
    for (let y = 0; y < size.h; y += 1) {
      for (let x = 0; x < size.w; x += 1) {
        const at = `${String(x)},${String(y)}`;
        if (inRoom(x, y)) {
          expect(lit[y * size.w + x], at).toBe(1);
        } else {
          outside += 1;
          expect(lit[y * size.w + x], at).toBe(0);
        }
      }
    }
    expect(outside, 'no tile outside every room to check').toBeGreaterThan(0);
  });

  it('lights nothing when no room can win its roll', () => {
    const lit = lightLevel(size, rooms, { litRoomChance: 0 }, createRng('a'));
    expect(lit.every((bit) => bit === 0)).toBe(true);
  });

  it('rolls each room: at an even chance some rooms are lit and some are not', () => {
    let litRooms = 0;
    let darkRooms = 0;
    for (let seed = 0; seed < 10; seed += 1) {
      const lit = lightLevel(size, rooms, { litRoomChance: 50 }, createRng(`roll-${String(seed)}`));
      for (const r of rooms) {
        if (lit[r.y0 * size.w + r.x0] === 1) litRooms += 1;
        else darkRooms += 1;
      }
    }
    expect(litRooms).toBeGreaterThan(0);
    expect(darkRooms).toBeGreaterThan(0);
  });

  it('lights the same rooms for the same stream', () => {
    const once = lightLevel(size, rooms, { litRoomChance: 50 }, createRng('same'));
    const twice = lightLevel(size, rooms, { litRoomChance: 50 }, createRng('same'));
    expect([...once]).toEqual([...twice]);
  });

  it('records each room with its walls, so the rooms leave no gap between them', () => {
    // A room carved by the works is its floor and the wall ring around it, and the
    // rings of neighbours meet. So every tile inside the rooms' bounding box is in
    // some room; a list that dropped the walls would leave two-tile bands between.
    const x0 = Math.min(...rooms.map((r) => r.x0));
    const y0 = Math.min(...rooms.map((r) => r.y0));
    const x1 = Math.max(...rooms.map((r) => r.x1));
    const y1 = Math.max(...rooms.map((r) => r.y1));
    for (let y = y0; y <= y1; y += 1) {
      for (let x = x0; x <= x1; x += 1) {
        expect(inRoom(x, y), `${String(x)},${String(y)} is between rooms`).toBe(true);
      }
    }
  });

  it('records the rooms only a room generator carves', () => {
    expect(rooms.length).toBeGreaterThan(1);
    for (const r of rooms) {
      expect(r.x1).toBeGreaterThan(r.x0);
      expect(r.y1).toBeGreaterThan(r.y0);
    }
    expect(makeSiteMap('light-cave', SiteShape.Cave).rooms ?? []).toEqual([]);
  });
});
