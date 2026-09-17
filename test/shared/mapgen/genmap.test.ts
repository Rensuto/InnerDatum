// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// The map under test is ported from t-engine4 game/engines/default/engine/Generator.lua:31-77
//   and game/engines/default/engine/Map.lua:559-577, :797-806.
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

import { describe, expect, it } from 'vitest';

import { NIL_TERRAIN, createGenMap } from '../../../src/shared/mapgen/genmap.ts';
import { TileCode } from '../../../src/shared/protocol.ts';
import { createRng } from '../../../src/shared/rng.ts';

describe('Generator:resolve', () => {
  it('draws from a table on EVERY resolve, and not at all for one code or a missing key', () => {
    const rng = createRng('resolve');
    const twin = createRng('resolve');
    const map = createGenMap(
      4,
      4,
      { '#': [TileCode.WALL, TileCode.CRAG], '.': TileCode.FLOOR },
      rng,
    );
    for (let n = 0; n < 40; n += 1) {
      const code = map.resolve('#');
      expect(code).toBe([TileCode.WALL, TileCode.CRAG][twin.int('t', 1, 2) - 1]);
    }
    const count = rng.getState().count;
    expect(map.resolve('.')).toBe(TileCode.FLOOR);
    expect(map.resolve('up')).toBeNull();
    expect(rng.getState().count).toBe(count);
  });

  it('calls a function key with the level`s rng', () => {
    const rng = createRng('fn');
    const map = createGenMap(
      2,
      2,
      { '.': (r) => (r.int('x', 0, 1) === 0 ? TileCode.FLOOR : TileCode.SOOT) },
      rng,
    );
    expect([TileCode.FLOOR, TileCode.SOOT]).toContain(map.resolve('.'));
    expect(rng.getState().count).toBe(1);
  });
});

describe('the map call', () => {
  it('writes nothing for a nil entity or off the map, as upstream`s getter form', () => {
    const map = createGenMap(3, 3, {}, createRng(1));
    expect(Array.from(map.tiles).every((c) => c === NIL_TERRAIN)).toBe(true);
    map.set(1, 1, null);
    map.set(-1, 0, TileCode.WALL);
    map.set(3, 0, TileCode.WALL);
    expect(Array.from(map.tiles).every((c) => c === NIL_TERRAIN)).toBe(true);
    map.set(1, 1, TileCode.WALL);
    expect(map.get(1, 1)).toBe(TileCode.WALL);
    expect(map.get(0, 0)).toBeNull();
  });

  it('blocks movement at walls and shut doors, and not at floor, nil terrain or off the map', () => {
    const map = createGenMap(4, 1, {}, createRng(1));
    map.set(0, 0, TileCode.WALL);
    map.set(1, 0, TileCode.DOOR);
    map.set(2, 0, TileCode.FLOOR);
    expect([0, 1, 2, 3, -1].map((x) => map.blockMove(x, 0))).toEqual([
      true,
      true,
      false,
      false,
      false,
    ]);
  });

  it('starts every room-map cell empty, and refuses one off the map', () => {
    const map = createGenMap(2, 2, {}, createRng(1));
    expect(map.cell(1, 1)).toEqual({
      room: null,
      canOpen: null,
      special: null,
      border: null,
      tunnel: null,
      realTunnel: null,
    });
    expect(() => map.cell(2, 0)).toThrow(RangeError);
  });
});
