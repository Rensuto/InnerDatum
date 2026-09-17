// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from the T-Engine4 C core, which the reference tree does not ship: auxsort and
//   table_sort in src/luajit2/src/lib_table.c (LuaJIT as T-Engine4 vendors it, T-Engine4 tag
//   tome-1.6.0, commit 0d95bc38; byte-identical through tome-1.7.6)
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

/*
 * The C this file translates carries these notices, retained as their licences
 * require:
 *
 * LuaJIT -- a Just-In-Time Compiler for Lua. http://luajit.org/
 * Copyright (C) 2005-2013 Mike Pall. All rights reserved.
 *
 * Major portions taken verbatim or adapted from the Lua interpreter.
 * Copyright (C) 1994-2008 Lua.org, PUC-Rio. All rights reserved.
 *
 * Permission is hereby granted, free of charge, to any person obtaining
 * a copy of this software and associated documentation files (the
 * "Software"), to deal in the Software without restriction, including
 * without limitation the rights to use, copy, modify, merge, publish,
 * distribute, sublicense, and/or sell copies of the Software, and to
 * permit persons to whom the Software is furnished to do so, subject to
 * the following conditions:
 *
 * The above copyright notice and this permission notice shall be
 * included in all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
 * EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
 * MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
 * IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
 * CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
 * TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
 * SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 */

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * LUA'S `table.sort`, SWAP FOR SWAP, BECAUSE IT IS NOT STABLE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Three level generators sort and then act on the ORDER of equal elements:
 *
 *   - `Cavern` sorts its flood-fill regions by size, keeps the LAST, and walls
 *     in the others in the order the sort left them, which draws when the wall
 *     key is a table (`engine/generator/map/Cavern.lua:98-107`).
 *   - `forest_clearing` sorts its flood-fill groups by size and keeps the LAST,
 *     so when two groups tie for largest, the sort decides which one is the
 *     clearing (`rooms/forest_clearing.lua:84-85`).
 *   - `Forest`'s road sorts thirty random waypoints along one axis and accepts
 *     them in that order, each judged against the last one accepted, so two
 *     waypoints in the same column change the road (`engine/generator/map/Forest.lua:325-366`).
 *
 * JavaScript's `Array.prototype.sort` is stable; LuaJIT's is Lua 5.1's
 * quicksort, which is not. Equal elements come out in whatever order its
 * swaps leave them, so the only way to get upstream's order is its swaps.
 *
 * WHAT IS KEPT: the median-of-three on `l`, `(l+u)/2` and `u` with its exact
 * comparisons and swaps, the pivot parked at `u-1`, the scan order, and
 * recursion on the smaller half. WHAT IS NOT: the Lua stack, and the
 * `__lt`/string-key forms of the comparator, which no generator uses.
 */

/**
 * `table.sort(t, comp)` (C core: `table_sort` over `auxsort`,
 * src/luajit2/src/lib_table.c): sorts `arr` IN PLACE, `lt(a, b)` meaning
 * "a comes before b". Upstream's `#t` is the whole array here, because every
 * caller sorts a table it built densely.
 *
 * An order function that is not a strict weak order can walk off either end;
 * the C raises "invalid order function for sorting", and so does this.
 */
export function tableSort<T>(arr: T[], lt: (a: T, b: T) => boolean): void {
  auxsort(arr, lt, 1, arr.length);
}

/** `a[k]`, 1-based. Every index `auxsort` reads is inside `l..u`, so outside is a bug. */
function at<T>(arr: readonly T[], k: number): T {
  if (k < 1 || k > arr.length) throw new RangeError(`tableSort: no element ${String(k)}`);
  return arr[k - 1] as T;
}

/** `set2`'s effect: swap `a[i]` and `a[j]`, 1-based. */
function swap<T>(arr: T[], i: number, j: number): void {
  const tmp = at(arr, i);
  arr[i - 1] = at(arr, j);
  arr[j - 1] = tmp;
}

function invalidOrder(): never {
  throw new Error('invalid order function for sorting');
}

/** `auxsort(L, l, u)`: the loop is the C's tail recursion on the larger half. */
function auxsort<T>(arr: T[], lt: (a: T, b: T) => boolean, lo: number, hi: number): void {
  let l = lo;
  let u = hi;
  while (l < u) {
    // Sort a[l], a[(l+u)/2] and a[u].
    if (lt(at(arr, u), at(arr, l))) swap(arr, l, u);
    if (u - l === 1) break;
    let i = Math.trunc((l + u) / 2);
    if (lt(at(arr, i), at(arr, l))) {
      swap(arr, i, l);
    } else if (lt(at(arr, u), at(arr, i))) {
      swap(arr, i, u);
    }
    if (u - l === 2) break;
    const pivot = at(arr, i);
    swap(arr, i, u - 1);
    // a[l] <= P == a[u-1] <= a[u]; only l+1..u-2 remain.
    i = l;
    let j = u - 1;
    for (;;) {
      // repeat ++i until a[i] >= P
      for (i += 1; lt(at(arr, i), pivot); i += 1) {
        if (i >= u) invalidOrder();
      }
      // repeat --j until a[j] <= P
      for (j -= 1; lt(pivot, at(arr, j)); j -= 1) {
        if (j <= l) invalidOrder();
      }
      if (j < i) break;
      swap(arr, i, j);
    }
    swap(arr, u - 1, i);
    // Recurse on the smaller half, loop on the larger.
    if (i - l < u - i) {
      j = l;
      i -= 1;
      l = i + 2;
    } else {
      j = i + 1;
      i = u;
      u = j - 2;
    }
    auxsort(arr, lt, j, i);
  }
}
