// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/engines/default/engine/interface/PlayerMouse.lua:70-72 (`recheck`)
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" — https://te4.org/license

/**
 * `findPathAvoiding`: A* that refuses what hurts, then the plain A* only when
 * that found nothing. The mouse walk's two searches, and the monster's.
 */

import { describe, expect, it } from 'vitest';

import { findPath, findPathAvoiding } from '../../src/shared/path.ts';
import type { PassableFn } from '../../src/shared/path.ts';
import type { TileXY } from '../../src/shared/coords.ts';

/** '.' open, '~' open but avoided, anything else solid. */
function grid(rows: readonly string[]): { passable: PassableFn; avoid: PassableFn } {
  const at = (x: number, y: number): string => rows[y]?.charAt(x) ?? '#';
  return {
    passable: (x, y) => at(x, y) === '.' || at(x, y) === '~',
    avoid: (x, y) => at(x, y) === '~',
  };
}

const onAvoided = (rows: readonly string[], path: readonly TileXY[]): boolean =>
  path.some((tile) => rows[tile.y]?.charAt(tile.x) === '~');

const POND = ['#########', '#.......#', '#.~~~~~.#', '#.~~~~~.#', '#.......#', '#########'];

describe('findPathAvoiding — PlayerMouse.lua:70-72', () => {
  it('goes around when there is a way around, where plain A* goes through', () => {
    const { passable, avoid } = grid(POND);
    const plain = findPath({ x: 1, y: 2 }, { x: 7, y: 2 }, passable);
    const around = findPathAvoiding({ x: 1, y: 2 }, { x: 7, y: 2 }, passable, avoid);
    expect(plain !== null && onAvoided(POND, plain), 'precondition: plain wades').toBe(true);
    expect(around).not.toBeNull();
    expect(onAvoided(POND, around ?? [])).toBe(false);
    expect(around?.at(-1)).toEqual({ x: 7, y: 2 });
  });

  it('takes the plain route when there is no other', () => {
    const moat = ['#######', '#..~..#', '#..~..#', '#######'];
    const { passable, avoid } = grid(moat);
    const plain = findPath({ x: 1, y: 1 }, { x: 5, y: 1 }, passable);
    expect(findPathAvoiding({ x: 1, y: 1 }, { x: 5, y: 1 }, passable, avoid)).toEqual(plain);
  });

  it('an avoided goal fails the first search, as `add_check` refuses it upstream, and walks plain', () => {
    const { passable, avoid } = grid(POND);
    const to = { x: 4, y: 3 };
    const plain = findPath({ x: 1, y: 1 }, to, passable);
    expect(findPathAvoiding({ x: 1, y: 1 }, to, passable, avoid)).toEqual(plain);
  });

  it('with `allowBlockedTarget` the goal is exempt, and the route to it still goes around', () => {
    // Along the bottom row and in at the end, rather than across the pond.
    const { passable, avoid } = grid(POND);
    const to = { x: 6, y: 3 };
    expect(avoid(to.x, to.y), 'precondition: the goal is in the pond').toBe(true);
    const route = findPathAvoiding({ x: 1, y: 3 }, to, passable, avoid, {
      allowBlockedTarget: true,
    });
    expect(route?.at(-1)).toEqual(to);
    expect(onAvoided(POND, route?.slice(0, -1) ?? [])).toBe(false);
  });

  it('asks `avoid` only about tiles `isPassable` allows', () => {
    const { passable } = grid(POND);
    const asked: string[] = [];
    const avoid: PassableFn = (x, y) => {
      asked.push(`${String(x)},${String(y)}`);
      return POND[y]?.charAt(x) === '~';
    };
    findPathAvoiding({ x: 1, y: 1 }, { x: 7, y: 4 }, passable, avoid);
    expect(asked.length).toBeGreaterThan(0);
    for (const key of asked) {
      const [x = -1, y = -1] = key.split(',').map(Number);
      expect(passable(x, y), key).toBe(true);
    }
  });

  it('runs one search, not two, when nothing was avoided — an unreachable goal costs what it did', () => {
    const sealed = ['#######', '#..#..#', '#..#..#', '#######'];
    const { passable } = grid(sealed);
    let plainCalls = 0;
    expect(
      findPath({ x: 1, y: 1 }, { x: 5, y: 1 }, (x, y) => {
        plainCalls += 1;
        return passable(x, y);
      }),
    ).toBeNull();
    let calls = 0;
    const counted: PassableFn = (x, y) => {
      calls += 1;
      return passable(x, y);
    };
    expect(findPathAvoiding({ x: 1, y: 1 }, { x: 5, y: 1 }, counted, () => false)).toBeNull();
    expect(calls).toBe(plainCalls);
  });
});
