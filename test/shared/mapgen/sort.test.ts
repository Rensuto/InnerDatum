// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// The sort under test is ported from auxsort in LuaJIT's src/lib_table.c, as T-Engine4
//   vendors it (tag tome-1.6.0). LuaJIT (C) 2005-2013 Mike Pall; Lua (C) 1994-2008
//   Lua.org, PUC-Rio; both MIT.
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

import { describe, expect, it } from 'vitest';

import { tableSort } from '../../../src/shared/mapgen/sort.ts';
import { createRng } from '../../../src/shared/rng.ts';

type Item = { readonly key: number; readonly tag: number };

/**
 * The C again, as a Lua stack machine: `lua_rawgeti` pushes, `set2` pops into
 * two slots, `sort_comp(a, b)` reads relative stack indices. Written from
 * lib_table.c line by line, so a port that reordered a comparison or a swap
 * disagrees with it on some input with ties.
 */
function literalAuxsort(t: Item[], lt: (a: Item, b: Item) => boolean): void {
  const a = (k: number): Item => t[k - 1] as Item;
  const stack: Item[] = [];
  const rawgeti = (k: number): void => {
    stack.push(a(k));
  };
  const top = (rel: number): Item => stack[stack.length + rel] as Item;
  const pop = (n: number): void => {
    stack.length -= n;
  };
  const rawseti = (k: number): void => {
    t[k - 1] = stack.pop() as Item;
  };
  const set2 = (i: number, j: number): void => {
    rawseti(i);
    rawseti(j);
  };
  const sortComp = (x: number, y: number): boolean => lt(top(x), top(y));

  const auxsort = (lo: number, hi: number): void => {
    let l = lo;
    let u = hi;
    while (l < u) {
      rawgeti(l);
      rawgeti(u);
      if (sortComp(-1, -2)) set2(l, u);
      else pop(2);
      if (u - l === 1) break;
      let i = Math.trunc((l + u) / 2);
      rawgeti(i);
      rawgeti(l);
      if (sortComp(-2, -1)) {
        set2(i, l);
      } else {
        pop(1);
        rawgeti(u);
        if (sortComp(-1, -2)) set2(i, u);
        else pop(2);
      }
      if (u - l === 2) break;
      rawgeti(i);
      stack.push(top(-1));
      rawgeti(u - 1);
      set2(i, u - 1);
      i = l;
      let j = u - 1;
      for (;;) {
        for (;;) {
          i += 1;
          rawgeti(i);
          if (!sortComp(-1, -2)) break;
          if (i >= u) throw new Error('invalid order function for sorting');
          pop(1);
        }
        for (;;) {
          j -= 1;
          rawgeti(j);
          if (!sortComp(-3, -1)) break;
          if (j <= l) throw new Error('invalid order function for sorting');
          pop(1);
        }
        if (j < i) {
          pop(3);
          break;
        }
        set2(i, j);
      }
      rawgeti(u - 1);
      rawgeti(i);
      set2(u - 1, i);
      if (i - l < u - i) {
        j = l;
        i -= 1;
        l = i + 2;
      } else {
        j = i + 1;
        i = u;
        u = j - 2;
      }
      auxsort(j, i);
    }
  };
  auxsort(1, t.length);
  expect(stack).toEqual([]);
}

const byKey = (x: Item, y: Item): boolean => x.key < y.key;

function items(seed: string, n: number, keys: number): Item[] {
  const rng = createRng(seed);
  return Array.from({ length: n }, (_, tag) => ({ key: rng.int('key', 0, keys - 1), tag }));
}

describe('tableSort — Lua 5.1`s quicksort, swap for swap', () => {
  it('sorts', () => {
    for (let s = 0; s < 50; s += 1) {
      const arr = items(`sorts:${String(s)}`, 1 + (s % 40), 1000);
      const sorted = [...arr].sort((x, y) => x.key - y.key).map((x) => x.key);
      tableSort(arr, byKey);
      expect(arr.map((x) => x.key)).toEqual(sorted);
    }
  });

  it('leaves equal elements exactly where the C`s swaps leave them', () => {
    let unstable = 0;
    for (let s = 0; s < 300; s += 1) {
      // Few distinct keys, so most of the array ties.
      const arr = items(`ties:${String(s)}`, s % 60, 1 + (s % 7));
      const literal = [...arr];
      const stable = [...arr].sort((x, y) => x.key - y.key);
      literalAuxsort(literal, byKey);
      tableSort(arr, byKey);
      expect(arr).toEqual(literal);
      if (literal.some((x, i) => x.tag !== stable[i]?.tag)) unstable += 1;
    }
    // A stable sort would pass the test above only if these were zero.
    expect(unstable).toBeGreaterThan(100);
  });

  it('orders three equal-sized keys as the median-of-three leaves them', () => {
    // a[3] < a[1] swaps first; the middle is then compared with neither swapped
    // end again. A stable sort gives tags 2, 0, 1.
    const arr: Item[] = [
      { key: 1, tag: 0 },
      { key: 1, tag: 1 },
      { key: 0, tag: 2 },
    ];
    tableSort(arr, byKey);
    expect(arr.map((x) => x.tag)).toEqual([2, 1, 0]);
  });

  it('refuses an order function that is not one, as the C does', () => {
    const arr = items('invalid', 20, 3);
    expect(() => {
      tableSort(arr, () => true);
    }).toThrow('invalid order function for sorting');
  });
});
