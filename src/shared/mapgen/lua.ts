// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/engines/default/engine/utils.lua:1957-1961 (util.bound)
//   and game/engines/default/engine/utils.lua:1979-1984 (util.getval); the rng.* shims
//   stand in for the C core, which the reference tree does not ship.
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
 * ═══ THE RNG FUNCTIONS ARE C, AND THE C IS NOT HERE ═══
 * `rng.range`, `rng.percent`, `rng.table`, `rng.normal` and `rng.float` live in
 * the engine's C core, which `reference/t-engine4` does not contain. So these
 * are not ports of code anybody can read. They are RULES, each marked
 * UNVERIFIABLE where it is one, chosen to match the only evidence the Lua
 * offers: how the call sites use the values. The seeds are not upstream's
 * either (`shared/rng.ts` is PCG32), so what this keeps is the draw STRUCTURE —
 * what is rolled, in what order, how many times — which is what makes the
 * distribution of rooms and tunnels ToME's.
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
 * `rng.range(a, b)`: an integer, both ends inclusive, ONE logical draw.
 *
 * UNVERIFIABLE (C), two rules:
 * - FLOAT BOUNDS TRUNCATE TOWARD ZERO, the C `int` conversion. ToME passes
 *   floats routinely (`rng.range(4, size/6)` in the infinite dungeon), and
 *   `shared/rng.ts` throws on a non-integer bound, so the coercion has to be
 *   somewhere and it is here.
 * - `b < a` SWAPS rather than failing. `Roomer:makeStairsSides` reaches
 *   `rng.range(1, #rooms)` with an empty list, and a throw there would turn a
 *   quirk into a crash.
 */
export function range(rng: Rng, label: string, a: number, b: number): number {
  const lo = Math.trunc(a);
  const hi = Math.trunc(b);
  return hi < lo ? rng.int(label, hi, lo) : rng.int(label, lo, hi);
}

/**
 * `rng.percent(p)`: true on a roll of 0..99 under `p`, and ALWAYS one draw —
 * at 0, at 100 and beyond. `placeDoors` rolls it before `canDoor`
 * (`engine/generator/map/RoomsLoader.lua:925`), and a percent that skipped its
 * draw at 100 would move every later number on every level with a 100% door
 * chance.
 *
 * UNVERIFIABLE (C): `p` is truncated to an integer before the compare, the C
 * `int` conversion of the argument.
 */
export function percent(rng: Rng, label: string, p: number): boolean {
  return rng.int(label, 0, 99) < Math.trunc(p);
}

/**
 * `rng.table(t)`: a uniform element and its index, or `null` for an empty
 * table WITHOUT a draw. Upstream returns the 1-based index; this returns the
 * JavaScript one, because every caller uses it only to remove that element.
 *
 * UNVERIFIABLE (C): that the empty case consumes no draw.
 */
export function table<T>(
  rng: Rng,
  label: string,
  arr: readonly T[],
): { readonly value: T; readonly index: number } | null {
  if (arr.length === 0) return null;
  const index = rng.int(label, 0, arr.length - 1);
  const value = arr[index];
  return value === undefined ? null : { value, index };
}

/**
 * `rng.tableRemove(t)`: removes and returns a uniform element, or `undefined`
 * for an empty table without a draw. MUTATES `arr`, as upstream does.
 */
export function tableRemove<T>(rng: Rng, label: string, arr: T[]): T | undefined {
  const picked = table(rng, label, arr);
  if (picked === null) return undefined;
  arr.splice(picked.index, 1);
  return picked.value;
}

/**
 * `rng.float(a, b)`: a float in `[a, b)`, one draw.
 *
 * UNVERIFIABLE (C): whether `b` itself is reachable. At 32 bits of resolution
 * the difference is one value in four billion.
 */
export function float(rng: Rng, label: string, a: number, b: number): number {
  return a + (b - a) * rng.nextFloat(label);
}

/**
 * `rng.normal(mean, sd)`: an INTEGER near `mean`.
 *
 * The integer part is the one fact the Lua supports:
 * `data/zones/infinite-dungeon/zone.lua:221` indexes a table with
 * `rng.normal(...) % #layouts + 1`, and `rng.normalFloat` exists separately.
 *
 * UNVERIFIABLE (C): the method. This is Box-Muller from two draws, rounded to
 * the nearest integer; upstream's is Angband's table-driven `Rand_normal`.
 */
export function normal(rng: Rng, label: string, mean: number, sd: number): number {
  // 1 - u keeps the logarithm's argument in (0, 1].
  const u1 = 1 - rng.nextFloat(label);
  const u2 = rng.nextFloat(label);
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return Math.round(mean + z * sd);
}

/**
 * `util.getval(v)` (`engine/utils.lua:1979-1984`): a function is called, a
 * table yields `v[rng.range(1, #v)]` (one draw), anything else is itself.
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
