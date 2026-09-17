// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// The shims under test port t-engine4's C rng_* functions (src/core_lua.c, tag tome-1.6.0),
// game/loader/pre-init.lua's rng.table helpers, and engine/utils.lua:1957-1984.
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

import { describe, expect, it } from 'vitest';

import {
  bound,
  chance,
  float,
  genrandReal,
  getval,
  mathRandom,
  mathRound,
  mbonus,
  mod,
  normal,
  normalFloat,
  percent,
  range,
  table,
  tableRemove,
  tableSampleIterator,
  truthy,
} from '../../../src/shared/mapgen/lua.ts';
import { createRng } from '../../../src/shared/rng.ts';
import type { Rng } from '../../../src/shared/rng.ts';

/** How many raw numbers a generator has spent. */
const count = (rng: Rng): number => rng.getState().count;

/** A generator whose raw 32-bit draws are scripted, to reach both ends of a real range. */
function scriptedU32(values: readonly number[]): Rng {
  const queue = [...values];
  return {
    ...createRng('scripted'),
    nextU32: () => {
      const v = queue.shift();
      if (v === undefined) throw new Error('script ran out');
      return v;
    },
  };
}

/** A generator whose `int` draws are scripted, to walk `rng.normal`'s table by hand. */
function scriptedInts(values: readonly number[]): Rng {
  const queue = [...values];
  return {
    ...createRng('scripted'),
    int: (_label, lo, hi) => {
      const v = queue.shift();
      if (v === undefined) throw new Error('script ran out');
      if (v < lo || v > hi)
        throw new Error(`scripted ${String(v)} outside ${String(lo)}..${String(hi)}`);
      return v;
    },
  };
}

describe('Lua truthiness', () => {
  it('is false only for nil and false, so 0 and "" are true', () => {
    expect([0, '', 'x', true, {}, -1].map(truthy)).toEqual([true, true, true, true, true, true]);
    expect([null, undefined, false].map(truthy)).toEqual([false, false, false]);
  });
});

describe('rng.range (C rng_range)', () => {
  it('truncates both bounds toward zero and swaps reversed ones', () => {
    const rng = createRng('range');
    const twin = createRng('range');
    for (let n = 0; n < 200; n += 1) {
      // 5.9 -> 5 and 2.2 -> 2, then swapped: the twin's int(2, 5).
      expect(range(rng, 'r', 5.9, 2.2)).toBe(twin.int('t', 2, 5));
    }
    // TOWARD ZERO, not down: -2.9..-1.5 is -2..-1, where floor would make it -3..-2.
    const seen = new Set<number>();
    for (let n = 0; n < 100; n += 1) seen.add(range(rng, 'r', -2.9, -1.5));
    expect([...seen].sort()).toEqual([-1, -2]);
  });

  it('draws NOTHING when the truncated bounds are equal, because rand_div(1) returns 0 unrolled', () => {
    const rng = createRng('equal');
    const before = count(rng);
    expect(range(rng, 'r', 5, 5)).toBe(5);
    expect(range(rng, 'r', 3.2, 3.9)).toBe(3);
    // -0.5 and 0.9 are both int 0, and a C int has no negative zero.
    expect(Object.is(range(rng, 'r', -0.5, 0.9), 0)).toBe(true);
    expect(count(rng)).toBe(before);
  });

  it('draws for range(1, 0) — an empty table`s #t — as range(0, 1)', () => {
    const rng = createRng('empty-range');
    const twin = createRng('empty-range');
    for (let n = 0; n < 50; n += 1) expect(range(rng, 'r', 1, 0)).toBe(twin.int('t', 0, 1));
    expect(rng.getState().state).toBe(twin.getState().state);
  });

  it('covers both ends inclusive', () => {
    const rng = createRng('ends');
    const seen = new Set<number>();
    for (let n = 0; n < 300; n += 1) seen.add(range(rng, 'r', 1, 4));
    expect([...seen].sort()).toEqual([1, 2, 3, 4]);
  });
});

describe('rng.percent (C rng_percent)', () => {
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

  it('truncates the chance first: percent(49.9) is percent(49), and percent(0.9) never hits', () => {
    const rng = createRng('frac');
    const twin = createRng('frac');
    let rolled49 = 0;
    for (let n = 0; n < 3000; n += 1) {
      const roll = twin.int('t', 0, 99);
      if (roll === 49) rolled49 += 1;
      expect(percent(rng, 'p', 49.9)).toBe(roll < 49);
    }
    // The one roll that tells 49.9 from 49 came up, so the pin had teeth.
    expect(rolled49).toBeGreaterThan(0);
    for (let n = 0; n < 500; n += 1) expect(percent(rng, 'p', 0.9)).toBe(false);
  });
});

describe('rng.chance (C rng_chance)', () => {
  it('is true with NO draw when the truncated n is 0 or 1', () => {
    const rng = createRng('chance-free');
    const before = count(rng);
    for (const n of [1, 1.9, 0, 0.5, -0.5]) expect(chance(rng, 'c', n)).toBe(true);
    expect(count(rng)).toBe(before);
  });

  it('is one draw of 0..n-1 hitting on 0 otherwise, with n truncated', () => {
    const rng = createRng('chance');
    const twin = createRng('chance');
    let hits = 0;
    for (let n = 0; n < 400; n += 1) {
      const hit = chance(rng, 'c', 4.8);
      expect(hit).toBe(twin.int('t', 0, 3) === 0);
      if (hit) hits += 1;
    }
    expect(rng.getState().state).toBe(twin.getState().state);
    expect(hits).toBeGreaterThan(60);
    expect(hits).toBeLessThan(140);
  });

  it('reads a negative n as the huge unsigned number C converts it to: it draws, and almost never hits', () => {
    const rng = createRng('chance-negative');
    const twin = createRng('chance-negative');
    for (let n = 0; n < 50; n += 1) {
      expect(chance(rng, 'c', -1)).toBe(twin.int('t', 0, 4294967294) === 0);
    }
    expect(rng.getState().state).toBe(twin.getState().state);
  });
});

describe('rng.float (C rng_float over genrand_real)', () => {
  it('reaches BOTH ends: a raw 0 is the minimum and a raw 2^32-1 the maximum', () => {
    expect(float(scriptedU32([0]), 'f', 2, 3)).toBe(2);
    expect(float(scriptedU32([4294967295]), 'f', 2, 3)).toBe(3);
    expect(genrandReal(scriptedU32([4294967295]), 'g', -0.5, 0.5)).toBe(0.5);
  });

  it('swaps reversed bounds', () => {
    expect(float(scriptedU32([0]), 'f', 3, 2)).toBe(2);
    expect(float(scriptedU32([4294967295]), 'f', 3, 2)).toBe(3);
  });

  it('narrows both bounds to a C float before anything else', () => {
    expect(float(scriptedU32([4294967295]), 'f', 0.1, 0.2)).toBe(Math.fround(0.2));
    expect(float(scriptedU32([0]), 'f', 0.1, 0.2)).toBe(Math.fround(0.1));
  });

  it('spends one draw every call, equal bounds included', () => {
    const rng = createRng('float');
    const before = count(rng);
    expect(float(rng, 'f', 0.1, 0.1)).toBe(Math.fround(0.1));
    for (let n = 0; n < 99; n += 1) {
      const v = float(rng, 'f', 2, 3);
      expect(v).toBeGreaterThanOrEqual(2);
      expect(v).toBeLessThanOrEqual(3);
    }
    expect(count(rng)).toBe(before + 100);
  });
});

describe('rng.normal (C rng_normal, Angband`s randnor_table)', () => {
  it('returns the truncated mean with NO draw when the truncated std is under 1', () => {
    const rng = createRng('normal-flat');
    const before = count(rng);
    expect(normal(rng, 'n', 10, 0)).toBe(10);
    expect(normal(rng, 'n', 10.7, 0.9)).toBe(10);
    expect(normal(rng, 'n', -3.9, -5)).toBe(-3);
    expect(Object.is(normal(rng, 'n', -0.5, 0), 0)).toBe(true);
    expect(count(rng)).toBe(before);
  });

  it('turns the roll into a table index, the index into std*index/64 by integer division, and a second roll into the sign', () => {
    // Roll 0 is under entry 0 (206): index 0, no offset at all.
    expect(normal(scriptedInts([0, 0]), 'n', 100, 64)).toBe(100);
    // 207 passes entry 0 and not entry 1 (613): index 1. A sign roll under 50 subtracts.
    expect(normal(scriptedInts([207, 49]), 'n', 100, 64)).toBe(99);
    // The search stops at the first entry NOT BELOW the roll, so 613 itself is index 1.
    expect(normal(scriptedInts([613, 99]), 'n', 0, 64)).toBe(1);
    expect(normal(scriptedInts([207, 50]), 'n', 100, 64)).toBe(101);
    // ...and std 10 at index 1 is 10/64, which INTEGER division makes 0.
    expect(normal(scriptedInts([207, 99]), 'n', 100, 10)).toBe(100);
    // Entry 64 (22493) is one standard deviation: exactly `std` away.
    expect(normal(scriptedInts([22493, 99]), 'n', 50, 7)).toBe(57);
    // One past it is index 65: 7 * 65 / 64 = 7.1, truncated.
    expect(normal(scriptedInts([22494, 0]), 'n', 50, 7)).toBe(43);
    // The top roll lands on the faked last entry, index 255: under four std.
    expect(normal(scriptedInts([32767, 99]), 'n', 0, 64)).toBe(255);
    // Both arguments truncate: 10.9 and 64.9 are 10 and 64.
    expect(normal(scriptedInts([207, 50]), 'n', 10.9, 64.9)).toBe(11);
    // STD 1 IS NOT UNDER 1: it rolls, and the top roll is 1 * 255 / 64 = 3.
    expect(normal(scriptedInts([32767, 99]), 'n', 0, 1)).toBe(3);
    expect(normal(scriptedInts([32767, 0]), 'n', 0, 1.9)).toBe(-3);
  });

  it('spends exactly two draws, a 0..32767 roll then a 0..99 roll', () => {
    const rng = createRng('normal-draws');
    const twin = createRng('normal-draws');
    for (let n = 0; n < 50; n += 1) {
      normal(rng, 'n', 20, 5);
      twin.int('t', 0, 32767);
      twin.int('t', 0, 99);
    }
    expect(rng.getState().state).toBe(twin.getState().state);
  });

  it('keeps about 68% of values strictly inside one std and none at four', () => {
    // Offset < std exactly when the index is under 64, a roll of at most
    // entry 63 (22245): 22246 / 32768 = 67.9%.
    const rng = createRng('normal-spread');
    let inside = 0;
    let sum = 0;
    const draws = 20000;
    for (let n = 0; n < draws; n += 1) {
      const v = normal(rng, 'n', 1000, 64);
      expect(Number.isInteger(v)).toBe(true);
      expect(Math.abs(v - 1000)).toBeLessThan(4 * 64);
      if (Math.abs(v - 1000) < 64) inside += 1;
      sum += v;
    }
    expect(inside / draws).toBeGreaterThan(0.665);
    expect(inside / draws).toBeLessThan(0.693);
    expect(Math.abs(sum / draws - 1000)).toBeLessThan(2);
  });
});

describe('rng.mbonus (pre-init.lua)', () => {
  it('clamps the level to max_level - 1 before anything else', () => {
    // Level 200 is 89: bonus 90*89/90 = 89, remainder 0, and a zero offset.
    // Unclamped it would be 200, and the final clamp would make it 90.
    expect(mbonus(scriptedInts([0, 3, 0, 99]), 'm', 90, 200, 90)).toBe(89);
  });

  it('adds one to the mean when the first roll is under the remainder', () => {
    // max 40 at level 1: bonus 40/90, remainder 40 out of 90.
    expect(mbonus(scriptedInts([39, 0, 0, 99]), 'm', 40, 1, 90)).toBe(1);
    expect(mbonus(scriptedInts([40, 0, 0, 99]), 'm', 40, 1, 90)).toBe(0);
  });

  it('compares that roll against a FRACTIONAL remainder, untruncated', () => {
    // 10 * 4.55 is 45.5: a roll of 45 is under it. Truncated to 45 it would not be.
    expect(mbonus(scriptedInts([45, 0, 0, 99]), 'm', 10, 4.55, 90)).toBe(1);
  });

  it('widens the spread by one when the second roll is under max % 4', () => {
    // max 5: spread 1.25, remainder 1. Roll 0 makes it 2.25; a table roll of
    // 22493 is index 64, one standard deviation, so the offset IS the spread.
    expect(mbonus(scriptedInts([89, 0, 22493, 99]), 'm', 5, 1, 90)).toBe(2);
    expect(mbonus(scriptedInts([89, 1, 22493, 99]), 'm', 5, 1, 90)).toBe(1);
  });

  it('clamps the normal`s answer to 0..max, after it', () => {
    expect(mbonus(scriptedInts([89, 1, 22493, 0]), 'm', 5, 1, 90)).toBe(0);
    // Index 255: 2 * 255 / 64 is 7, over the ceiling of 5.
    expect(mbonus(scriptedInts([89, 0, 32767, 99]), 'm', 5, 1, 90)).toBe(5);
  });

  it('draws nothing for the normal when the truncated spread is under 1', () => {
    // max 3: spread 0.75, and a second roll of 3 is not under 3. Two rolls,
    // and the script would throw on a third.
    expect(mbonus(scriptedInts([0, 3]), 'm', 3, 1, 90)).toBe(1);
  });

  it('asks for exactly those ranges, in that order', () => {
    const asked: [number, number][] = [];
    const inner = createRng('mbonus-asked');
    const rng: Rng = {
      ...inner,
      int: (label, lo, hi) => {
        asked.push([lo, hi]);
        return inner.int(label, lo, hi);
      },
    };
    mbonus(rng, 'm', 10, 30, 90);
    expect(asked).toEqual([
      [0, 89],
      [0, 3],
      [0, 32767],
      [0, 99],
    ]);
  });

  it('spends range(0, max_level - 1), range(0, 3), then the normal`s two, for lava`s 5 and 10', () => {
    const rng = createRng('mbonus-draws');
    const twin = createRng('mbonus-draws');
    for (const max of [5, 10]) {
      for (let level = 1; level <= 50; level += 1) {
        mbonus(rng, 'm', max, level, 90);
        twin.int('t', 0, 89);
        twin.int('t', 0, 3);
        twin.int('t', 0, 32767);
        twin.int('t', 0, 99);
      }
    }
    expect(rng.getState().state).toBe(twin.getState().state);
  });

  it('is an integer in 0..max, and at level 1 of 90 half of a 40 lands on 0 and the rest average about 4', () => {
    const rng = createRng('mbonus-spread');
    for (const max of [3, 5, 10, 40]) {
      for (let level = 1; level <= 100; level += 7) {
        for (let n = 0; n < 50; n += 1) {
          const v = mbonus(rng, 'm', max, level, 90);
          expect(Number.isInteger(v)).toBe(true);
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThanOrEqual(max);
        }
      }
    }
    // The figures content/resolvers.ts quotes for `resolvers.mbonus(40, 15)`.
    let zero = 0;
    let sum = 0;
    const draws = 40000;
    for (let n = 0; n < draws; n += 1) {
      const v = mbonus(rng, 'm', 40, 1, 90);
      if (v === 0) zero += 1;
      sum += v;
    }
    expect(zero / draws).toBeGreaterThan(0.45);
    expect(zero / draws).toBeLessThan(0.55);
    expect(sum / draws).toBeGreaterThan(3.6);
    expect(sum / draws).toBeLessThan(4.4);
  });
});

describe('rng.normalFloat (C rng_normal_float)', () => {
  it('draws two on odd calls and none on even ones, which read back the cached z1 at their own scale', () => {
    const rng = createRng('box-muller');
    const twin = createRng('box-muller');
    const u1 = twin.nextU32('t') / 4294967295;
    const u2 = twin.nextU32('t') / 4294967295;
    const r = Math.sqrt(-2 * Math.log(u1));
    expect(normalFloat(rng, 'nf', 10, 2)).toBeCloseTo(r * Math.cos(2 * Math.PI * u2) * 2 + 10, 12);
    expect(count(rng)).toBe(2);
    expect(normalFloat(rng, 'nf', -5, 3)).toBeCloseTo(r * Math.sin(2 * Math.PI * u2) * 3 - 5, 12);
    expect(count(rng)).toBe(2);
    normalFloat(rng, 'nf', 0, 1);
    expect(count(rng)).toBe(4);
  });

  it('keeps one cache per generator, so two levels never read each other`s value', () => {
    const a = createRng('cache-a');
    const b = createRng('cache-b');
    normalFloat(a, 'nf', 0, 1);
    normalFloat(b, 'nf', 0, 1);
    expect([count(a), count(b)]).toEqual([2, 2]);
    normalFloat(b, 'nf', 0, 1);
    expect(count(b)).toBe(2);
  });
});

describe('rng.table and rng.tableRemove (pre-init.lua)', () => {
  it('draws nothing for a one-element table', () => {
    const rng = createRng('single');
    const before = count(rng);
    expect(table(rng, 't', ['only'])).toEqual({ value: 'only', index: 0 });
    const list = ['only'];
    expect(tableRemove(rng, 't', list)).toBe('only');
    expect(list).toEqual([]);
    expect(count(rng)).toBe(before);
  });

  it('DRAWS for an empty table — range(1, 0) — and returns nothing', () => {
    const rng = createRng('empty');
    const twin = createRng('empty');
    expect(table(rng, 't', [])).toBeNull();
    expect(tableRemove(rng, 't', [])).toBeUndefined();
    twin.int('t', 0, 1);
    twin.int('t', 0, 1);
    expect(rng.getState().state).toBe(twin.getState().state);
  });

  it('returns the element at the index it reports, one draw of 1..#t each', () => {
    const rng = createRng('pick');
    const twin = createRng('pick');
    const list = ['a', 'b', 'c', 'd', 'e'];
    for (let n = 0; n < 100; n += 1) {
      const picked = table(rng, 't', list);
      const index = twin.int('t', 1, list.length) - 1;
      expect(picked).toEqual({ value: list[index], index });
    }
  });

  it('removes exactly the element it returns, from wherever it drew', () => {
    const rng = createRng('remove');
    const twin = createRng('remove');
    const slots = new Set<number>();
    for (let n = 0; n < 40; n += 1) {
      const list = [10, 20, 30, 40];
      const index = twin.int('t', 1, 4) - 1;
      const taken = tableRemove(rng, 't', list);
      expect(taken).toBe([10, 20, 30, 40][index]);
      expect(list).toEqual([10, 20, 30, 40].filter((_, i) => i !== index));
      slots.add(index);
    }
    // Not only the last slot, which `pop` would also get right.
    expect([...slots].sort()).toEqual([0, 1, 2, 3]);
  });
});

describe('rng.tableSampleIterator (pre-init.lua)', () => {
  /** Upstream's swap, written as an array shuffle so the port is not checked against itself. */
  function expected(twin: Rng, t: readonly string[], k: number): string[] {
    const a = [...t];
    const out: string[] = [];
    for (let i = 1; i <= k; i += 1) {
      const j = i === a.length ? i : twin.int('t', i, a.length);
      const at = a[j - 1] ?? '';
      a[j - 1] = a[i - 1] ?? '';
      a[i - 1] = at;
      out.push(at);
    }
    return out;
  }

  it('yields every element once, and the last step of a full sample draws nothing', () => {
    const letters = ['a', 'b', 'c', 'd', 'e', 'f'];
    for (let s = 0; s < 20; s += 1) {
      const rng = createRng(`sample:${String(s)}`);
      const twin = createRng(`sample:${String(s)}`);
      const got = [...tableSampleIterator(rng, 's', letters)];
      expect(got).toEqual(expected(twin, letters, letters.length));
      expect([...got].sort()).toEqual(letters);
      expect(count(rng)).toBe(letters.length - 1);
    }
  });

  it('stops at k, reads k above #t as #t, and yields nothing for k = 0', () => {
    const letters = ['a', 'b', 'c', 'd'];
    const rng = createRng('sample-k');
    const twin = createRng('sample-k');
    expect([...tableSampleIterator(rng, 's', letters, 2)]).toEqual(expected(twin, letters, 2));
    expect(count(rng)).toBe(2);
    expect([...tableSampleIterator(rng, 's', letters, 9)]).toHaveLength(4);
    const before = count(rng);
    expect([...tableSampleIterator(rng, 's', letters, 0)]).toEqual([]);
    expect(count(rng)).toBe(before);
  });

  it('draws lazily: a loop that stops after one element has spent one draw', () => {
    const rng = createRng('sample-lazy');
    for (const first of tableSampleIterator(rng, 's', [1, 2, 3, 4, 5])) {
      expect(first).toBeGreaterThan(0);
      break;
    }
    expect(count(rng)).toBe(1);
  });
});

describe('util.getval and util.bound', () => {
  it('passes a value through with no draw, draws from a table through range, calls a function', () => {
    const rng = createRng('getval');
    const before = count(rng);
    expect(getval(rng, 'g', 7)).toBe(7);
    expect(getval(rng, 'g', [42])).toBe(42);
    expect(count(rng)).toBe(before);

    const twin = createRng('getval');
    const table4 = [11, 12, 13, 14];
    for (let n = 0; n < 50; n += 1) {
      expect(getval(rng, 'g', table4)).toBe(table4[twin.int('t', 1, 4) - 1]);
    }
    expect(getval(rng, 'g', () => 99)).toBe(99);
  });

  it('draws for an empty table as upstream does, then refuses it', () => {
    const rng = createRng('getval-empty');
    expect(() => getval(rng, 'g', [])).toThrow(RangeError);
    expect(count(rng)).toBe(1);
  });

  it('clamps without rounding', () => {
    expect(bound(2.5, 1, 4)).toBe(2.5);
    expect(bound(-3, 1, 4)).toBe(1);
    expect(bound(9, 1, 4)).toBe(4);
  });
});

describe('Lua `%`', () => {
  it('floors, so the result takes the divisor`s sign', () => {
    expect(mod(-1, 5)).toBe(4);
    expect(mod(5, 5)).toBe(0);
    expect(mod(7, 5)).toBe(2);
  });
});

describe('math.round (engine/utils.lua:33-38)', () => {
  it('rounds to the nearest multiple of mult, 1 by default, halves away from zero', () => {
    expect([mathRound(45, 2), mathRound(44, 2), mathRound(43.9, 2)]).toEqual([46, 44, 44]);
    expect([mathRound(-45, 2), mathRound(-44, 2)]).toEqual([-46, -44]);
    // The Infinite Dungeon's case: a map side to a corridor width (zone.lua:228-231).
    expect([mathRound(39, 6), mathRound(38, 6), mathRound(126, 7), mathRound(37, 5)]).toEqual([
      42, 36, 126, 35,
    ]);
    expect([mathRound(2.5), mathRound(-2.5), mathRound(2.4), mathRound(7)]).toEqual([3, -3, 2, 7]);
  });

  it('scales by a million first, so the examples in its own comment hold', () => {
    // `math.round(4.65, 0.1)=4.7, math.round(-4.475, 0.01) = -4.48` (utils.lua:31).
    expect(mathRound(4.65, 0.1)).toBe(4.7);
    expect(mathRound(-4.475, 0.01)).toBe(-4.48);
    // Without the scale both of these land a hundredth short: -4.47 and 2.67.
    expect(mathRound(2.675, 0.01)).toBe(2.68);
  });
});

describe('math.random at the argument forms the Infinite Dungeon passes', () => {
  // zone.lua:126 `(1, ceil(vx*vy/2000))`, :134 `(12, 20)`, :149 `(1, 2)`, :156 `(0, ...)`.
  it.each([
    [1, 3],
    [12, 20],
    [1, 2],
    [0, 4],
  ])('is uniform over every integer of [%i, %i], one raw draw a call', (m, n) => {
    const rng = createRng(`math.random:${String(m)}:${String(n)}`);
    const calls = 4000;
    const seen = new Map<number, number>();
    for (let i = 0; i < calls; i += 1) {
      const before = count(rng);
      const v = mathRandom(rng, 'm', m, n);
      expect(count(rng) - before).toBe(1);
      seen.set(v, (seen.get(v) ?? 0) + 1);
    }
    const values = [...seen.keys()].sort((a, b) => a - b);
    expect(values).toEqual(Array.from({ length: n - m + 1 }, (_, i) => m + i));
    const expected = calls / values.length;
    for (const hits of seen.values()) {
      expect(Math.abs(hits - expected)).toBeLessThan(expected * 0.2);
    }
  });
});
