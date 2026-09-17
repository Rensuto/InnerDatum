// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// The shims under test stand in for t-engine4's rng.* C functions and engine/utils.lua:1957-1984.
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

import { describe, expect, it } from 'vitest';

import {
  bound,
  float,
  getval,
  mod,
  normal,
  percent,
  range,
  table,
  tableRemove,
  truthy,
} from '../../../src/shared/mapgen/lua.ts';
import { createRng } from '../../../src/shared/rng.ts';

describe('Lua truthiness', () => {
  it('is false only for nil and false, so 0 and "" are true', () => {
    expect([0, '', 'x', true, {}, -1].map(truthy)).toEqual([true, true, true, true, true, true]);
    expect([null, undefined, false].map(truthy)).toEqual([false, false, false]);
  });
});

describe('rng.percent', () => {
  it('spends exactly one draw at every chance, and hits on a 0..99 roll under it', () => {
    // Twin streams: whatever `percent` does, the twin does as a single `int`,
    // and the two must stay in lockstep draw for draw. A percent that skipped
    // its roll at 0 or 100 would put them out of step on the next call.
    const rng = createRng('percent');
    const twin = createRng('percent');
    for (const p of [0, 100, 150, -5, 50, 1, 99, 0, 100]) {
      for (let n = 0; n < 50; n += 1) {
        const roll = twin.int('twin', 0, 99);
        expect(percent(rng, 'p', p)).toBe(roll < p);
      }
    }
    expect(rng.getState().state).toBe(twin.getState().state);
  });

  it('truncates a fractional chance before comparing', () => {
    const rng = createRng('frac');
    const twin = createRng('frac');
    for (let n = 0; n < 400; n += 1) {
      expect(percent(rng, 'p', 50.9)).toBe(percent(twin, 'p', 50));
    }
  });
});

describe('rng.range', () => {
  it('truncates float bounds toward zero and swaps reversed bounds', () => {
    const rng = createRng('range');
    const twin = createRng('range');
    for (let n = 0; n < 200; n += 1) {
      // 5.9 -> 5 and 2.2 -> 2, then swapped: the twin's int(2, 5).
      expect(range(rng, 'r', 5.9, 2.2)).toBe(twin.int('t', 2, 5));
    }
    // TOWARD ZERO, not down: -0.5 is 0 and 0.9 is 0, so this can only be 0...
    const seen = new Set<number>();
    for (let n = 0; n < 100; n += 1) seen.add(range(rng, 'r', -0.5, 0.9));
    expect([...seen]).toEqual([0]);
    // ...and -2.9..-1.5 is -2..-1, where floor would make it -3..-2.
    seen.clear();
    for (let n = 0; n < 100; n += 1) seen.add(range(rng, 'r', -2.9, -1.5));
    expect([...seen].sort()).toEqual([-1, -2]);
    expect(range(rng, 'r', 3, 3)).toBe(3);
  });

  it('covers both ends inclusive', () => {
    const rng = createRng('ends');
    const seen = new Set<number>();
    for (let n = 0; n < 300; n += 1) seen.add(range(rng, 'r', 1, 4));
    expect([...seen].sort()).toEqual([1, 2, 3, 4]);
  });
});

describe('rng.table and rng.tableRemove', () => {
  it('returns nothing for an empty table WITHOUT spending a draw', () => {
    const rng = createRng('empty');
    const before = rng.getState();
    expect(table(rng, 't', [])).toBeNull();
    expect(tableRemove(rng, 't', [])).toBeUndefined();
    expect(rng.getState()).toEqual(before);
  });

  it('returns the element at the index it reports, one draw each', () => {
    const rng = createRng('pick');
    const twin = createRng('pick');
    const list = ['a', 'b', 'c', 'd', 'e'];
    for (let n = 0; n < 100; n += 1) {
      const picked = table(rng, 't', list);
      const index = twin.int('t', 0, list.length - 1);
      expect(picked).toEqual({ value: list[index], index });
    }
  });

  it('removes exactly the element it returns', () => {
    const rng = createRng('remove');
    const list = [10, 20, 30, 40];
    const taken = tableRemove(rng, 't', list);
    expect(taken).toBeDefined();
    expect(list).toHaveLength(3);
    expect(list).not.toContain(taken);
  });
});

describe('util.getval and util.bound', () => {
  it('passes a value through with no draw, draws once from a table, calls a function', () => {
    const rng = createRng('getval');
    const before = rng.getState();
    expect(getval(rng, 'g', 7)).toBe(7);
    expect(rng.getState()).toEqual(before);

    const twin = createRng('getval');
    const table4 = [11, 12, 13, 14];
    for (let n = 0; n < 50; n += 1) {
      expect(getval(rng, 'g', table4)).toBe(table4[twin.int('t', 1, 4) - 1]);
    }
    expect(getval(rng, 'g', () => 99)).toBe(99);
  });

  it('clamps without rounding', () => {
    expect(bound(2.5, 1, 4)).toBe(2.5);
    expect(bound(-3, 1, 4)).toBe(1);
    expect(bound(9, 1, 4)).toBe(4);
  });
});

describe('the rest of the C shims', () => {
  it('floors `%` the way Lua does', () => {
    expect(mod(-1, 5)).toBe(4);
    expect(mod(5, 5)).toBe(0);
    expect(mod(7, 5)).toBe(2);
  });

  it('keeps rng.float inside its range', () => {
    const rng = createRng('float');
    for (let n = 0; n < 200; n += 1) {
      const v = float(rng, 'f', 2, 3);
      expect(v).toBeGreaterThanOrEqual(2);
      expect(v).toBeLessThan(3);
    }
  });

  it('makes rng.normal an integer centred on the mean, exact at sd 0', () => {
    const rng = createRng('normal');
    let sum = 0;
    for (let n = 0; n < 2000; n += 1) {
      const v = normal(rng, 'n', 20, 5);
      expect(Number.isInteger(v)).toBe(true);
      sum += v;
    }
    expect(Math.abs(sum / 2000 - 20)).toBeLessThan(0.5);
    expect(normal(rng, 'n', 13, 0)).toBe(13);
  });
});
