import { describe, expect, it } from 'vitest';

import { lightLevel } from '../../src/shared/light.ts';
import { TileCode, isWalkable } from '../../src/shared/protocol.ts';
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

  it('lights only a room`s cells when it names them, on the same one roll', () => {
    // engine/generator/map/Building.lua:114-116: a building lights the floor it
    // wrote, not its whole rectangle.
    const small = { w: 6, h: 5 };
    const room = { x0: 1, y0: 1, x1: 4, y1: 3, cells: [7, 9, 14] };
    const lit = lightLevel(small, [room], { litRoomChance: 100 }, createRng('cells'));
    expect([...lit].flatMap((bit, i) => (bit === 1 ? [i] : []))).toEqual([7, 9, 14]);
    // One draw for the room, however many cells it names.
    const a = createRng('draws');
    lightLevel(small, [room], { litRoomChance: 50 }, a);
    const b = createRng('draws');
    lightLevel(small, [{ x0: 1, y0: 1, x1: 4, y1: 3 }], { litRoomChance: 50 }, b);
    expect(a.nextU32('probe')).toBe(b.nextU32('probe'));
    const dark = lightLevel(small, [room], { litRoomChance: 0 }, createRng('cells'));
    expect(dark.every((bit) => bit === 0)).toBe(true);
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

  it('records each room with its walls, as a lit room is lit wall and all', () => {
    // engine/generator/map/RoomsLoader.lua:652 (and rooms/simple.lua:33 for a
    // room function) lights every cell of the room's w by h, and every room the
    // works lays is walled on its edge: a function room draws a ring of '#', and
    // an ASCII room's edge is only '#' and '!'. So a recorded rectangle's EDGE is
    // wall but for the few tiles a tunnel opened, where a list that dropped the
    // walls would have an edge of floor. Measured over 200 works: no room's edge
    // is more than 38% walkable, and the same rectangles inset by one average 90%.
    //
    // A drawn room is not in the list to check: a lesser vault's generator never
    // reads its lit roll (rooms/lesser_vault.lua:90), so it is not a room the
    // light lights.
    let checked = 0;
    for (const r of rooms) {
      checked += 1;
      let edge = 0;
      let open = 0;
      for (let y = r.y0; y <= r.y1; y += 1) {
        for (let x = r.x0; x <= r.x1; x += 1) {
          if (x !== r.x0 && x !== r.x1 && y !== r.y0 && y !== r.y1) continue;
          edge += 1;
          if (isWalkable(works.view.tiles[y * size.w + x] ?? TileCode.WALL)) open += 1;
        }
      }
      expect(
        open / edge,
        `${String(r.x0)},${String(r.y0)} was recorded without its walls`,
      ).toBeLessThan(0.5);
    }
    expect(checked, 'no room to check').toBeGreaterThan(1);
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
