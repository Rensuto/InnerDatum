// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/engines/default/engine/utils.lua:1957-1961 (util.bound)
//   and game/engines/default/engine/utils.lua:1979-1984 (util.getval)
//   and game/engines/default/engine/utils.lua:33-38 (math.round);
//   and the C core, which the reference tree does not ship: rng_range, rng_percent,
//   rng_chance, rng_float, rng_normal, rng_normal_float and randnor_table in
//   src/core_lua.c, rand_div and genrand_real in src/SFMT.c and src/SFMT.h, and
//   rng.mbonus, rng.table, rng.tableRemove and rng.tableSampleIterator in game/loader/pre-init.lua
//   (all at T-Engine4 tag tome-1.6.0, commit 0d95bc38; unchanged through tome-1.7.6);
//   and math_random in src/luajit2/src/lib_math.c, LuaJIT's own generator, which
//   game/loader/pre-init.lua seeds from the clock (T-Engine4 tag tome-1.6.0)
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * LUA AND ITS C CORE, AS THE LEVEL GENERATORS SEE THEM
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Every generator under `engine/generator/map/` draws through `rng.range`,
 * `rng.percent`, `rng.table` and friends, and tests Lua truthiness on the flags
 * it writes. Both need one explicit answer each, written down ONCE, because a
 * port that answers them differently in two files produces two different
 * dungeons from one seed and no error anywhere.
 *
 * ═══ THE RNG FUNCTIONS ARE C, AND THIS IS THAT C ═══
 * `rng.range`, `rng.percent`, `rng.chance`, `rng.normal` and `rng.float` are
 * native functions in the engine's `src/core_lua.c`; `rng.table` and its
 * siblings are Lua in `game/loader/pre-init.lua`. Neither file is in
 * `reference/t-engine4`, so the citations here name the C FUNCTION and the tag
 * rather than a line the citation checker could resolve.
 *
 * WHAT IS KEPT is every rule that decides a value or a draw: which arguments C
 * truncates to `int`, which calls draw nothing, which swap reversed bounds. The
 * numbers themselves are not upstream's — its generator is SFMT19937 behind
 * `rand_div`'s mask-and-reject, ours is `shared/rng.ts` (PCG32) — so what this
 * keeps is the draw STRUCTURE: what is rolled, in what order, how many times.
 *
 * ═══ ONE UPSTREAM DRAW IS ONE `rng.int` HERE ═══
 * `rand_div(m)` rejects and redraws until a masked 32-bit value lands below
 * `m`, so it spends one OR MORE raw numbers; `rng.int` spends one or more for
 * its own rejection. The count of raw numbers is not comparable across the two
 * generators and nothing depends on it. What is comparable, and kept exactly,
 * is WHETHER a call draws at all: `rand_div(m)` with `m <= 1` returns 0 before
 * touching the generator, and that single clause is why `range(5, 5)`, a
 * one-element `table` and `normal(x, 0)` draw nothing.
 *
 * ═══ C's `int` IS TRUNCATION TOWARD ZERO ═══
 * `int x = luaL_checknumber(L, 1)` converts a double by truncation, so
 * `range(-1.5, 2)` is `range(-1, 2)`, not `range(-2, 2)`. LuaJIT numbers are
 * doubles. A value outside int32 is undefined behaviour in C and no generator
 * passes one; `cInt` does not pretend to reproduce it.
 *
 * ═══ LUA TRUTHINESS IS NOT JAVASCRIPT'S ═══
 * Only `nil` and `false` are false in Lua. `0` and `""` are true, which is why
 * `truthy` exists at all: a room id of 0 or a `border` of 0 would silently flip
 * a branch under `if (x)`.
 */

import type { Rng } from '../rng.ts';

/**
 * Lua's truthiness: everything but `nil` and `false` is true.
 *
 * `undefined` counts as `nil` so an absent optional field reads as upstream's
 * missing table key.
 */
export function truthy(v: unknown): boolean {
  return v !== null && v !== undefined && v !== false;
}

/**
 * C's conversion of a Lua number to `int`: truncation toward zero. An `int`
 * has no negative zero, so neither does this — `range(-0.5, 0.9)` is `0`, and a
 * test comparing with `Object.is` would otherwise see `-0`. Every C function
 * that declares `int x = luaL_checknumber(...)` goes through here, the
 * Bresenham line's coordinates included (`mapgen/geom.ts`).
 */
export function cInt(v: number): number {
  const t = Math.trunc(v);
  return t === 0 ? 0 : t;
}

/** `4294967295.0`, the divisor SFMT's real-number helpers use (`src/SFMT.h`). */
const U32_MAX = 4294967295;

/**
 * `genrand_real(min, max)` (C core: src/SFMT.h, T-Engine4 tag tome-1.6.0):
 * `gen_rand32() * ((max - min) / 4294967295.0) + min`.
 *
 * ONE DRAW, INCLUSIVE OF BOTH ENDS: a raw 0 gives `min` and a raw 2^32-1 gives
 * `max`. No swap and no narrowing — those belong to `rng_float`, not to this.
 * libtcod's noise gradients come straight from here (`shared/noise.ts`).
 */
export function genrandReal(rng: Rng, label: string, min: number, max: number): number {
  return rng.nextU32(label) * ((max - min) / U32_MAX) + min;
}

/**
 * `rng.range(a, b)` (C core: `rng_range`, src/core_lua.c, T-Engine4 tag
 * tome-1.6.0): a uniform integer, both ends inclusive.
 *
 * - BOTH BOUNDS TRUNCATE TOWARD ZERO, C's `int`. ToME passes floats routinely
 *   (`rng.range(4, size/6)` in the infinite dungeon).
 * - `b < a` IS THE SAME CALL SWAPPED: the C computes `y + rand_div(1 + x - y)`.
 *   `rng.range(1, #t)` on an empty table is therefore `range(0, 1)`, and draws.
 * - `a == b` RETURNS `a` WITH NO DRAW: `rand_div(1)` returns 0 before touching
 *   the generator. The comparison is on the truncated values, as in the C, so
 *   `range(3.2, 3.9)` draws nothing either.
 */
export function range(rng: Rng, label: string, a: number, b: number): number {
  const x = cInt(a);
  const y = cInt(b);
  const lo = x < y ? x : y;
  const hi = x < y ? y : x;
  if (lo === hi) return lo;
  return rng.int(label, lo, hi);
}

/**
 * `rng.percent(p)` (C core: `rng_percent`, src/core_lua.c, T-Engine4 tag
 * tome-1.6.0): `rand_div(100) < (int)p`.
 *
 * ALWAYS ONE DRAW — at 0, at 100 and beyond, because the roll is made before
 * `p` is looked at. `placeDoors` rolls it before `canDoor`
 * (`engine/generator/map/RoomsLoader.lua:925`), and a percent that skipped its
 * draw at 100 would move every later number on every level with a 100% door
 * chance.
 *
 * `p` TRUNCATES: `percent(49.9)` is `percent(49)` and `percent(0.9)` is never
 * true. `Forest.lua` passes `math.sqrt(v)` and gets the truncated root.
 */
export function percent(rng: Rng, label: string, p: number): boolean {
  return rng.int(label, 0, 99) < cInt(p);
}

/**
 * `rng.chance(n)` (C core: `rng_chance`, src/core_lua.c, T-Engine4 tag
 * tome-1.6.0): `rand_div((int)n) == 0`, true one time in `n`.
 *
 * `(int)n` of 0 or 1 is TRUE WITH NO DRAW — `rand_div` returns 0 for `m <= 1`
 * — so `chance(1.9)` always hits and spends nothing.
 *
 * A NEGATIVE `n` is not "always": `rand_div` takes a `uint32_t`, so `-1`
 * arrives as 4294967295, draws, and is true about once in four billion. Kept,
 * because it is what the C does and no generator relies on the difference.
 */
export function chance(rng: Rng, label: string, n: number): boolean {
  const m = cInt(n) >>> 0;
  if (m <= 1) return true;
  return rng.int(label, 0, m - 1) === 0;
}

/**
 * `rng.float(a, b)` (C core: `rng_float`, src/core_lua.c, T-Engine4 tag
 * tome-1.6.0): a real number in `[min, max]`, ONE DRAW, both ends reachable.
 *
 * - BOTH BOUNDS ARE NARROWED TO A C `float` first (`float min =
 *   luaL_checknumber(...)`), which is `Math.fround`. So `float(0.1, 0.1)` is
 *   `fround(0.1)`, 0.10000000149011612, and not 0.1.
 * - Reversed bounds swap. Equal bounds still draw once and return that bound.
 * - The arithmetic after the narrowing is `genrand_real`'s, in double.
 */
export function float(rng: Rng, label: string, a: number, b: number): number {
  const min = Math.fround(a);
  const max = Math.fround(b);
  return min < max ? genrandReal(rng, label, min, max) : genrandReal(rng, label, max, min);
}

/**
 * `randnor_table` (C core: src/core_lua.c, T-Engine4 tag tome-1.6.0), Angband's.
 *
 * "Entry 64*N in the table above represents the number of times out of 32767
 * that a random variable with normal distribution will fall within N standard
 * deviations of the mean." The last entry is faked to 32767 so every value is
 * "strictly less than four standard deviations away from the mean".
 */
const RANDNOR_TABLE: readonly number[] = Object.freeze([
  206, 613, 1022, 1430, 1838, 2245, 2652, 3058, 3463, 3867, 4271, 4673, 5075, 5475, 5874, 6271,
  6667, 7061, 7454, 7845, 8234, 8621, 9006, 9389, 9770, 10148, 10524, 10898, 11269, 11638, 12004,
  12367, 12727, 13085, 13440, 13792, 14140, 14486, 14828, 15168, 15504, 15836, 16166, 16492, 16814,
  17133, 17449, 17761, 18069, 18374, 18675, 18972, 19266, 19556, 19842, 20124, 20403, 20678, 20949,
  21216, 21479, 21738, 21994, 22245,

  22493, 22737, 22977, 23213, 23446, 23674, 23899, 24120, 24336, 24550, 24759, 24965, 25166, 25365,
  25559, 25750, 25937, 26120, 26300, 26476, 26649, 26818, 26983, 27146, 27304, 27460, 27612, 27760,
  27906, 28048, 28187, 28323, 28455, 28585, 28711, 28835, 28955, 29073, 29188, 29299, 29409, 29515,
  29619, 29720, 29818, 29914, 30007, 30098, 30186, 30272, 30356, 30437, 30516, 30593, 30668, 30740,
  30810, 30879, 30945, 31010, 31072, 31133, 31192, 31249,

  31304, 31358, 31410, 31460, 31509, 31556, 31601, 31646, 31688, 31730, 31770, 31808, 31846, 31882,
  31917, 31950, 31983, 32014, 32044, 32074, 32102, 32129, 32155, 32180, 32205, 32228, 32251, 32273,
  32294, 32314, 32333, 32352, 32370, 32387, 32404, 32420, 32435, 32450, 32464, 32477, 32490, 32503,
  32515, 32526, 32537, 32548, 32558, 32568, 32577, 32586, 32595, 32603, 32611, 32618, 32625, 32632,
  32639, 32645, 32651, 32657, 32662, 32667, 32672, 32677,

  32682, 32686, 32690, 32694, 32698, 32702, 32705, 32708, 32711, 32714, 32717, 32720, 32722, 32725,
  32727, 32729, 32731, 32733, 32735, 32737, 32739, 32740, 32742, 32743, 32745, 32746, 32747, 32748,
  32749, 32750, 32751, 32752, 32753, 32754, 32755, 32756, 32757, 32757, 32758, 32758, 32759, 32760,
  32760, 32761, 32761, 32761, 32762, 32762, 32763, 32763, 32763, 32764, 32764, 32764, 32764, 32765,
  32765, 32765, 32765, 32766, 32766, 32766, 32766, 32767,
]);

/** `RANDNOR_STD`: the table's standard deviation, in index steps. */
const RANDNOR_STD = 64;

/** `rand_div(32768)`'s bound: the roll is 0..32767. */
const RANDNOR_ROLL_MAX = 32767;

/**
 * `rng.normal(mean, std)` (C core: `rng_normal`, src/core_lua.c, T-Engine4 tag
 * tome-1.6.0): Angband's table-driven `Rand_normal`, an INTEGER.
 *
 * - `mean` and `std` truncate to `int` first. `roomAlloc`'s
 *   `rng.normal(px, sig*w*2)` passes floats for both.
 * - `(int)std < 1` RETURNS `(int)mean` WITH NO DRAW ("Paranoia").
 * - Otherwise TWO DRAWS: a roll of 0..32767, binary-searched for the first
 *   table entry not below it (index 0..255), turned into
 *   `offset = std * index / 64` by integer division; then a 0..99 roll, under
 *   50 for `mean - offset`, else `mean + offset`.
 * So the spread is capped just under four standard deviations, and the
 * distribution is symmetric by the sign roll rather than by the table.
 */
export function normal(rng: Rng, label: string, mean: number, sd: number): number {
  const m = cInt(mean);
  const stand = cInt(sd);
  if (stand < 1) return m;
  const tmp = rng.int(label, 0, RANDNOR_ROLL_MAX);
  let low = 0;
  let high = RANDNOR_TABLE.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if ((RANDNOR_TABLE[mid] ?? RANDNOR_ROLL_MAX) < tmp) low = mid + 1;
    else high = mid;
  }
  const offset = Math.trunc((stand * low) / RANDNOR_STD);
  return rng.int(label, 0, 99) < 50 ? m - offset : m + offset;
}

/**
 * `rng.mbonus(max, level, max_level)` (`game/loader/pre-init.lua`, T-Engine4 tag
 * tome-1.6.0): a bonus in `[0, max]` that grows with the level, Angband's
 * `m_bonus`. Lua, not C, so every step below is a line of it:
 *
 * ```lua
 * if level > max_level - 1 then level = max_level - 1 end
 * local bonus = (max * level) / max_level
 * local extra = (max * level) % max_level
 * if rng.range(0, max_level - 1) < extra then bonus = bonus + 1 end
 * local stand = max / 4
 * extra = max % 4
 * if rng.range(0, 3) < extra then stand = stand + 1 end
 * local val = rng.normal(bonus, stand)
 * if val < 0 then val = 0 end
 * if val > max then val = max end
 * return val
 * ```
 *
 * - `/` IS FLOAT DIVISION and `%` is Lua's floored one (`mod`). Neither result
 *   is rounded here: `rng.normal` truncates `bonus` and `stand` when it reads
 *   them, and the `extra` comparisons read a possibly fractional `extra`.
 * - THE ROUNDING IS PROBABILISTIC, and that is the point of both rolls: a
 *   remainder of `extra` out of `max_level` adds one to the mean `extra` times
 *   in `max_level`, and a remainder of `max % 4` does the same to the spread.
 * - DRAWS: `range(0, max_level - 1)` (none when `max_level` is 1), then
 *   `range(0, 3)`, then `normal`'s two — or none, when the truncated spread is
 *   under 1, which a `max` of 3 or less can roll.
 * - Clamped to `[0, max]` AFTER the normal, so half the spread at a low level
 *   piles up on 0.
 */
export function mbonus(
  rng: Rng,
  label: string,
  max: number,
  level: number,
  maxLevel: number,
): number {
  const lvl = level > maxLevel - 1 ? maxLevel - 1 : level;
  let bonus = (max * lvl) / maxLevel;
  const extraBonus = mod(max * lvl, maxLevel);
  if (range(rng, label, 0, maxLevel - 1) < extraBonus) bonus += 1;
  let stand = max / 4;
  const extraStand = mod(max, 4);
  if (range(rng, label, 0, 3) < extraStand) stand += 1;
  const val = normal(rng, label, bonus, stand);
  if (val < 0) return 0;
  if (val > max) return max;
  return val;
}

/** `TWOPI` in `rng_normal_float`, a literal that is this double to the last bit. */
const TWO_PI = 2 * Math.PI;

/**
 * THE SECOND BOX-MULLER VALUE, CACHED PER GENERATOR.
 *
 * Upstream's cache is a C `static` shared by every call in the process,
 * because upstream has exactly one generator. Here a level draws from its own
 * `Rng`, so the cache is keyed by that object: calls on one stream alternate
 * between drawing and reading back exactly as upstream's global does, and two
 * streams never read each other's value. A `WeakMap` so a finished level's
 * generator is not kept alive by it.
 *
 * NOT IN `getState()`, AND SO FOR LEVEL GENERATION ONLY. `shared/rng.ts`
 * promises that a generator's state is its whole cursor, and this breaks that
 * promise between an odd call and the even one after it: a stream saved there
 * and restored draws two numbers where the unbroken stream draws none. A level
 * is built in one synchronous call and never saved half-made, so nothing here
 * can see it. A caller whose stream IS saved mid-flight — the server's world
 * stream, which the save roll in `tome/class/Actor.lua:7007` would draw from — needs the
 * cached value carried in its serialised state before it may use this.
 */
const NORMAL_FLOAT_CACHE = new WeakMap<Rng, number>();

/**
 * `rng.normalFloat(mean, std)` (C core: `rng_normal_float`, src/core_lua.c,
 * T-Engine4 tag tome-1.6.0): Box-Muller, a REAL number, no rounding.
 *
 * ODD CALLS DRAW TWO (`genrand_real1`, inclusive `[0, 1]`) and return `z0`;
 * EVEN CALLS DRAW NOTHING and return the cached `z1` scaled by THEIR OWN mean
 * and std. A raw 0 gives `log(0)`, and the result is infinite, as in the C.
 */
export function normalFloat(rng: Rng, label: string, mean: number, std: number): number {
  const stored = NORMAL_FLOAT_CACHE.get(rng);
  if (stored !== undefined) {
    NORMAL_FLOAT_CACHE.delete(rng);
    return stored * std + mean;
  }
  const u1 = genrandReal(rng, label, 0, 1);
  const u2 = genrandReal(rng, label, 0, 1);
  const r = Math.sqrt(-2 * Math.log(u1));
  NORMAL_FLOAT_CACHE.set(rng, r * Math.sin(TWO_PI * u2));
  return r * Math.cos(TWO_PI * u2) * std + mean;
}

/**
 * `rng.table(t)` (`game/loader/pre-init.lua`, T-Engine4 tag tome-1.6.0):
 * `local id = rng.range(1, #t); return t[id], id`. Everything follows from
 * `range`:
 *
 * - A ONE-ELEMENT TABLE DRAWS NOTHING (`range(1, 1)`).
 * - AN EMPTY TABLE DRAWS and returns nil: `range(1, 0)` swaps to `range(0, 1)`,
 *   and both `t[0]` and `t[1]` are nil. Here that is `null`, after the draw.
 *
 * Upstream returns the 1-based index; this returns the JavaScript one, because
 * every caller uses it only to remove that element.
 */
export function table<T>(
  rng: Rng,
  label: string,
  arr: readonly T[],
): { readonly value: T; readonly index: number } | null {
  const id = range(rng, label, 1, arr.length);
  if (id < 1 || id > arr.length) return null;
  const value = arr[id - 1];
  return value === undefined ? null : { value, index: id - 1 };
}

/**
 * `rng.tableRemove(t)` (`game/loader/pre-init.lua`, T-Engine4 tag tome-1.6.0):
 * `table.remove(t, rng.range(1, #t))`. Removes and returns a uniform element.
 * MUTATES `arr`, as upstream does.
 *
 * Same draws as `table`: none for one element, one for an EMPTY table, which
 * then returns `undefined` — LuaJIT's `table.remove` at index 0 or 1 of an empty
 * table returns nothing.
 */
export function tableRemove<T>(rng: Rng, label: string, arr: T[]): T | undefined {
  const picked = table(rng, label, arr);
  if (picked === null) return undefined;
  arr.splice(picked.index, 1);
  return picked.value;
}

/**
 * `rng.tableSampleIterator(t, k)` (`game/loader/pre-init.lua`, T-Engine4 tag
 * tome-1.6.0): up to `k` distinct elements in random order, drawn LAZILY — a
 * partial Fisher-Yates whose step `i` swaps with `j = rng.range(i, #t)`.
 *
 * - `k` absent, or above `#t`, is `#t`. `k = 0` yields nothing (0 is truthy).
 * - Each step draws when it is taken, so a loop that breaks early stops
 *   drawing, and THE LAST STEP OF A FULL SAMPLE DRAWS NOTHING (`range(n, n)`).
 * - `arr` is not modified; the swaps live in the iterator, as upstream's
 *   `sample` table does.
 *
 * Elements must not be `undefined`: upstream reads `sample[j] or t[j]`, and a
 * nil element would end the Lua `for` loop. Nor `false`, for a quieter reason:
 * `or` falls through on `false` too, so upstream would yield the ORIGINAL slot's
 * element where `??` here yields the swapped-in `false`. No generator samples a
 * list of booleans.
 */
export function* tableSampleIterator<T>(
  rng: Rng,
  label: string,
  arr: readonly T[],
  k?: number,
): Generator<T, void, undefined> {
  const n = arr.length;
  const count = k === undefined || k > n ? n : k;
  const sample = new Map<number, T>();
  for (let i = 1; i <= count; i += 1) {
    const j = range(rng, label, i, n);
    const res = sample.get(j) ?? arr[j - 1];
    const here = sample.get(i) ?? arr[i - 1];
    if (here !== undefined) sample.set(j, here);
    if (res === undefined) return;
    yield res;
  }
}

/**
 * `util.getval(v)` (`engine/utils.lua:1979-1984`): a function is called, a
 * table yields `v[rng.range(1, #v)]`, anything else is itself.
 *
 * The table's draws are `range`'s: none for one element. An EMPTY table draws
 * and upstream returns nil; no caller passes one, and a nil `nb_rooms` would
 * fail upstream's arithmetic on the next line anyway, so this throws — after
 * the draw, where upstream's failure would be.
 */
export function getval<T>(rng: Rng, label: string, v: T | readonly T[] | ((rng: Rng) => T)): T {
  if (typeof v === 'function') return (v as (rng: Rng) => T)(rng);
  if (Array.isArray(v)) {
    const list = v as readonly T[];
    const picked = list[range(rng, label, 1, list.length) - 1];
    if (picked === undefined) throw new RangeError(`getval(${label}): empty table`);
    return picked;
  }
  return v as T;
}

/**
 * `util.bound(i, min, max)` (`engine/utils.lua:1957-1961`): a clamp and NOTHING
 * ELSE. It does not round, so `roomAlloc`'s `util.bound(rng.normal(...))` is an
 * integer only because `rng.normal` returns one.
 */
export function bound(v: number, min: number, max: number): number {
  return Math.min(Math.max(v, min), max);
}

/**
 * Lua's `%`: FLOORED, so the result takes the sign of the divisor. JavaScript's
 * `%` truncates, and `-1 % 5` is `-1` there and `4` in Lua.
 */
export function mod(a: number, b: number): number {
  return a - Math.floor(a / b) * b;
}

/**
 * `math.random(m, n)` (C core: `math_random` in src/luajit2/src/lib_math.c,
 * T-Engine4 tag tome-1.6.0) — NOT the engine's `rng`. The Infinite Dungeon's
 * layout tables mix the two (`data/zones/infinite-dungeon/zone.lua:156`, `:146`,
 * `:134`), and they are different machines:
 *
 * - LuaJIT'S OWN GENERATOR, a Tausworthe TW223 stream separate from the SFMT
 *   behind `rng.*`, which game/loader/pre-init.lua seeds with
 *   `math.randomseed(os.time())`. Upstream's numbers therefore depend on the
 *   wall clock at launch, and no seed reproduces them.
 * - ONE DRAW EVERY CALL, `math.random(3, 3)` included: the step runs before
 *   the arguments are read, unlike `rand_div`'s early return.
 * - `floor(d * (n - m + 1)) + m` for a `d` in `[0, 1)`, and NOTHING ELSE: the
 *   bounds are doubles, never truncated and never swapped. `math.random(0, 2.5)`
 *   is 0..3, and reversed bounds run through the same formula.
 *
 * THE RULE HERE: the draw comes from the level's labelled `Rng` — the only
 * generator `src/shared/` has — as one `nextFloat`, which is in `[0, 1)` like
 * `d`, so the count and the formula are LuaJIT's and the stream is ours. Only
 * the two-argument form is ported; no ported table calls the other two.
 */
export function mathRandom(rng: Rng, label: string, m: number, n: number): number {
  return Math.floor(rng.nextFloat(label) * (n - m + 1)) + m;
}

/** `num`'s default in `math.round`: six decimal digits of fixed point. */
const MATH_ROUND_FIXED_POINT = 1000000;

/**
 * `math.round(v, mult)` (`engine/utils.lua:33-38`), T-Engine4's own addition to
 * Lua's `math`: `v` to the NEAREST MULTIPLE of `mult`, default 1.
 *
 * ```lua
 * mult = mult or 1
 * num = num or 1000000
 * v, mult = v*num, mult*num
 * return v >= 0 and math.floor((v + mult/2)/mult) * mult/num or math.ceil((v - mult/2)/mult) * mult/num
 * ```
 *
 * - HALVES ROUND AWAY FROM ZERO: `mathRound(45, 2)` is 46 and
 *   `mathRound(-45, 2)` is -46, the upstream comment's `math.round(4.65, 0.1)`
 *   is 4.7 and `math.round(-4.475, 0.01)` is -4.48.
 * - BOTH SIDES ARE SCALED BY 1e6 FIRST, so a decimal `mult` that doubles cannot
 *   hold exactly still lands on its multiple: without it, -4.475 would round
 *   to -4.47. The arithmetic is double, in upstream's order.
 * - `a and b or c` is a plain choice here: `b` is a number, which Lua never
 *   reads as false.
 *
 * The third argument, `num`, is not ported; no caller in the ported tables
 * passes one. The Infinite Dungeon rounds a maze to its corridor width with it
 * (`data/zones/infinite-dungeon/zone.lua:228-231`).
 */
export function mathRound(v: number, mult = 1): number {
  const scaled = v * MATH_ROUND_FIXED_POINT;
  const step = mult * MATH_ROUND_FIXED_POINT;
  return scaled >= 0
    ? (Math.floor((scaled + step / 2) / step) * step) / MATH_ROUND_FIXED_POINT
    : (Math.ceil((scaled - step / 2) / step) * step) / MATH_ROUND_FIXED_POINT;
}
