// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/engines/default/engine/generator/map/Hexacle.lua:27-280
//   and game/engines/default/engine/Generator.lua:31-47 (the room_map it paints)
//   and game/modules/tome/data/zones/infinite-dungeon/zone.lua:171-179, :232-235 (HEXACLE_INFINITE_DUNGEON);
//   and the C core, which the reference tree does not ship: lj_tab_new, rehashtab,
//   countint, countarray, counthash, bestasize, resizetab, lj_tab_newkey,
//   lj_tab_setinth, lj_tab_len, unbound_search and lj_tab_next in
//   src/luajit2/src/lj_tab.c, hashrot and hsize2hbits in src/luajit2/src/lj_tab.h,
//   and expr_table's table sizing in src/luajit2/src/lj_parse.c — LuaJIT 2.0.2,
//   as T-Engine4 vendors it (T-Engine4 tag tome-1.6.0, commit 0d95bc38)
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * HEXACLE: CONCENTRIC RINGS OF BROKEN POLYGONS, JOINED BY SPOKES
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The Infinite Dungeon's "geometrically ordered area", and no other ToME zone's.
 * The whole algorithm:
 *
 *   1. fill the map with `'#'`
 *   2. `nb_layers` concentric polygons of `nb_segments` sides round the map's
 *      centre. Each side is kept or dropped on a percent roll, in a random
 *      order, and the chance to DROP doubles after every side kept
 *   3. each ring's kept sides fall into runs of consecutive sides — its GROUPS
 *   4. each side's cells are marked in the room map (not yet dug)
 *   5. each group digs one spoke, from the middle of one of its sides to the
 *      same side on the next ring inward that has it
 *   6. each group still unjoined digs a spoke to a joined group on ANY ring
 *      sharing a side number, or is marked dead
 *   7. if the groups are not one network, start again from step 1
 *   8. every marked cell whose group is not dead is dug, and each of its four
 *      neighbours dug on a 70% roll — so rings are one to three cells thick
 *   9. both stairs on random cells that are open and not special
 *
 * ═══ THE SPOKES ARE `core.fov.line`, THROUGH THE MAP AS IT STANDS ═══
 * Step 4 and every spoke trace libfov's line of sight (`mapgen/fovline.ts`),
 * not Bresenham. The rings trace it across solid rock. A spoke traces it
 * across the map WITH EVERY EARLIER SPOKE ALREADY DUG, so a later spoke bends
 * along an earlier one's open cells. Tracing each against an all-wall map would
 * move cells.
 *
 * ═══ A RESTART DOES NOT FORGET THE ROOM MAP (critic A4) ═══
 * Steps 2 and 7 restart with `return self:generate(lev, old_lev)`
 * (`engine/generator/map/Hexacle.lua:140`, `:234`). The restart refills the
 * terrain with `'#'` but never clears the `segment` and `segment_group` marks
 * step 4 wrote. So step 8 also digs every side a FAILED pass marked, unless
 * this pass marked the same cell or the failed pass's group was marked dead:
 * fragments of abandoned rings, joined to nothing, each with its own four
 * rolls. Kept. It is part of what a Hexacle level looks like, and the level's
 * connectivity check (`mapgen/level.ts`) is what refuses a stair stranded on one.
 *
 * ═══ WHEN EACH RESTART HAPPENS ═══
 * - "BIG WHOOPS" (`:140`) fires exactly when a ring kept EVERY side: with no
 *   gap the grouping never closes a run, so no side is in any group. The rings
 *   before it have already been marked. With the Infinite Dungeon's 8 sides and
 *   10% it cannot happen: the drop chance reaches 160% on the fifth side in a
 *   row, so a ring keeps at most seven. A ring of 4 sides keeps all four 8.6%
 *   of the time (90% x 80% x 60% x 20%).
 * - "UNCONNECTED" (`:231-235`) fires whenever any group is dead or the spokes
 *   left two networks. A dead group always forces it: nothing ever removes a
 *   group that has no spoke from the set being checked. So the pass that
 *   succeeds has no dead group of its own, and `dead` only ever matters for
 *   the stale marks of a failed pass.
 *
 * ═══ WHAT IS NOT UPSTREAM'S, EACH NOTED WHERE IT HAPPENS ═══
 * - The restarts are a loop capped at `HEXACLE_MAX_REBUILDS`, and a stair
 *   search is capped; upstream recurses and loops without limit.
 * - Three states where upstream raises a Lua error — a ring side off the map,
 *   ring 1 with no group to start the check from, a non-positive side or ring
 *   count — set `force_recreate` instead, or throw for the counts.
 * - The orphan search drops one clause of the Lua that can never be false (the
 *   group it would link to is always already joined); see `rescueOrphans`.
 * - `math.cos` and `math.sin` are the C library's upstream and V8's here. Two
 *   libraries may disagree in the last bit, which moves a vertex only if
 *   `rad * cos(angle)` lands within that bit of a whole number.
 *
 * NOTHING HERE IS LIT, NO DOOR IS HUNG, AND NO ROOM IS PLACED.
 */

import type { TileXY } from '../coords.ts';
import { TileCode } from '../protocol.ts';
import type { Rng } from '../rng.ts';
import { blockSight, eachStep, fovLine } from './fovline.ts';
import type { GenMap, GridKeys, Spot } from './genmap.ts';
import type { LevelSpec } from './level.ts';
import { mod, percent, range, table, tableSampleIterator, truthy } from './lua.ts';

// ═══════════════════════════════════════════════════════════════════════════
// LUA'S `#` AND `pairs` ON A SPARSE TABLE: LuaJIT'S ANSWER
// ═══════════════════════════════════════════════════════════════════════════

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE BORDER RULE: WHAT `#s` IS, DECIDED BY HOW LuaJIT LAID THE TABLE OUT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A ring's kept sides live in `segments[i]`, a table written only as
 * `segments[i][a.id] = a`, in the random order the sides were sampled, with
 * gaps. The grouping reads `#s` (`engine/generator/map/Hexacle.lua:115`), and
 * the Lua manual lets `#` return ANY border of a table with holes. Which one
 * decides where the scan starts, so the order of the groups and of the sides
 * in each — and so the order of the spoke rolls and which spoke each draws.
 *
 * THE RULE HERE IS THE INTERPRETER'S: ToME runs LuaJIT 2.0.2, and `#` is
 * `lj_tab_len`, which answers from the table's split between its ARRAY part
 * and its HASH part. That split is a pure function of the keys and the order
 * they were written in, so this emulates it:
 *
 * - `{}` starts with no array part and no hash part (`expr_table` sizes an
 *   empty constructor at 0 and 0).
 * - A new key that fits neither rehashes (`rehashtab`): every integer key,
 *   the new one included, is counted into bins `1..2`, `3..4`, `5..8` and so
 *   on, and the array part becomes keys `0..n` for the largest power of two `n`
 *   whose keys `1..n` are more than half present (`bestasize`). The rest go to
 *   a hash part of the next power of two, at least two nodes.
 * - A hash part fills node by node — main position by `hashrot` of the key's
 *   IEEE bits, collisions into free nodes taken from the top down, the
 *   displaced key moved when it was not in its own main position — and
 *   rehashes only when every node is taken.
 * - `#` binary-searches the array part when its last slot is nil, and
 *   otherwise continues into the hash part (`lj_tab_len`, `unbound_search`).
 *
 * The node layout is emulated too, because `pairs` walks the array part in
 * index order and then the hash part in NODE order (`lj_tab_next`), and step 4
 * marks the sides in that order.
 *
 * VERIFIED AGAINST THE C: `lj_tab.c` and `lj_tab.h`, unmodified, compiled with
 * minimal stand-ins for the object headers, gave the same `#`, the same
 * `next` order and the same part sizes as this on all 109,601 insertion orders
 * of distinct keys from 1..8 and 100,000 random ones up to 64 — a third of them
 * with a hash part.
 *
 * WHAT IT MEANS FOR A RING: every border LuaJIT returns makes the scan start
 * on a gap, so every kept side lands in exactly one group unless the ring kept
 * them all. The rule moves which gap the scan starts on, and nothing else.
 */

/** One hash node: its key, and the next node in its collision chain (-1 for none). */
type LuaNode = { key: number | null; next: number };

/**
 * A Lua table with non-negative integer keys and no nil values, as LuaJIT 2.0.2
 * stores it. Only what `Hexacle` does to one is supported: write a new key,
 * read one, `#`, and `pairs`.
 */
export type LuaIntTable<V> = {
  /** `t->asize`: array slots, slot 0 included. */
  asize: number;
  /** Which array slots are non-nil. */
  array: boolean[];
  /** Hash nodes, `t->hmask + 1` of them; 0 for the shared empty node. */
  hsize: number;
  nodes: LuaNode[];
  /** `node->freetop`: the free-node search starts below this index. */
  freetop: number;
  readonly values: Map<number, V>;
};

/** `LJ_MAX_ABITS`: the bins a rehash counts keys into. */
const LJ_MAX_ABITS = 28;

/** `LJ_MAX_ASIZE`: an integer key at or above this is never an array key. */
const LJ_MAX_ASIZE = 2 ** (LJ_MAX_ABITS - 1) + 1;

/** `HASH_ROT1..3` (`src/luajit2/src/lj_tab.h`). */
const HASH_ROT1 = 14;
const HASH_ROT2 = 5;
const HASH_ROT3 = 13;

/** `lj_fls`: the index of the highest set bit. */
function fls(x: number): number {
  return 31 - Math.clz32(x);
}

/** `lj_rol` on a `uint32_t`. */
function rol(x: number, n: number): number {
  return ((x << n) | (x >>> (32 - n))) >>> 0;
}

/**
 * `hashnum(t, key)`'s node index: `hashrot(lo, hi << 1) & hmask` over the two
 * halves of the key's IEEE double, the x86 and x64 variant of `hashrot`. The
 * bits of a whole number are built arithmetically, so no byte order enters.
 */
function mainPosition(t: LuaIntTable<unknown>, k: number): number {
  let lo = 0;
  let hi = 0;
  if (k > 0) {
    const e = fls(k);
    const mantissa = (k - 2 ** e) * 2 ** (52 - e);
    const top = Math.floor(mantissa / 2 ** 32);
    lo = mantissa - top * 2 ** 32;
    hi = ((1023 + e) * 2 ** 20 + top) >>> 0;
  }
  hi = (hi << 1) >>> 0;
  lo = (lo ^ hi) >>> 0;
  hi = rol(hi, HASH_ROT1);
  lo = (lo - hi) >>> 0;
  hi = rol(hi, HASH_ROT2);
  hi = (hi ^ lo) >>> 0;
  hi = (hi - rol(lo, HASH_ROT3)) >>> 0;
  return hi & (t.hsize - 1);
}

/** `{}`: no array part, no hash part. */
export function luaTable<V>(): LuaIntTable<V> {
  return { asize: 0, array: [], hsize: 0, nodes: [], freetop: 0, values: new Map() };
}

/** `countint`: bin one integer key. */
function countInt(k: number, bins: number[]): number {
  if (k >= LJ_MAX_ASIZE) return 0;
  const b = k > 2 ? fls(k - 1) : 0;
  bins[b] = (bins[b] ?? 0) + 1;
  return 1;
}

/** `hsize2hbits`: the hash part holding `s` keys, in bits, at least 2 nodes. */
function hsize2hbits(s: number): number {
  if (s === 0) return 0;
  return s === 1 ? 1 : 1 + fls(s - 1);
}

function inHash(t: LuaIntTable<unknown>, k: number): boolean {
  if (t.hsize === 0) return false;
  for (let n = mainPosition(t, k); n !== -1; n = t.nodes[n]?.next ?? -1) {
    if (t.nodes[n]?.key === k) return true;
  }
  return false;
}

/** `lj_tab_setint`: the array slot, or the hash part. */
function setKey(t: LuaIntTable<unknown>, k: number): void {
  if (k < t.asize) t.array[k] = true;
  else if (!inHash(t, k)) newKey(t, k);
}

/** `lj_tab_newkey`: Brent's variation, and a rehash when no node is free. */
function newKey(t: LuaIntTable<unknown>, k: number): void {
  if (t.hsize === 0) {
    rehash(t, k);
    setKey(t, k);
    return;
  }
  let n = mainPosition(t, k);
  const main = t.nodes[n] as LuaNode;
  if (main.key !== null) {
    let free = t.freetop;
    for (;;) {
      if (free === 0) {
        rehash(t, k);
        setKey(t, k);
        return;
      }
      free -= 1;
      if (t.nodes[free]?.key === null) break;
    }
    t.freetop = free;
    let collide = mainPosition(t, main.key);
    if (collide !== n) {
      // The occupant is not in its own main position: move it to the free node.
      while (t.nodes[collide]?.next !== n) collide = t.nodes[collide]?.next ?? -1;
      (t.nodes[collide] as LuaNode).next = free;
      t.nodes[free] = { key: main.key, next: main.next };
      t.nodes[n] = { key: null, next: -1 };
    } else {
      (t.nodes[free] as LuaNode).next = main.next;
      main.next = free;
      n = free;
    }
  }
  (t.nodes[n] as LuaNode).key = k;
}

/** `rehashtab` then `resizetab`: count, pick the array size, rebuild. */
function rehash(t: LuaIntTable<unknown>, extraKey: number): void {
  const bins = new Array<number>(LJ_MAX_ABITS).fill(0);
  // countarray
  let na = 0;
  if (t.asize !== 0) {
    let i = 0;
    for (let b = 0; b < LJ_MAX_ABITS; b += 1) {
      let top = 2 ** (b + 1);
      if (top >= t.asize) {
        top = t.asize - 1;
        if (i > top) break;
      }
      let n = 0;
      for (; i <= top; i += 1) if (t.array[i] === true) n += 1;
      bins[b] = (bins[b] ?? 0) + n;
      na += n;
    }
  }
  let total = 1 + na;
  // counthash
  let narray = na;
  for (const node of t.nodes) {
    if (node.key === null) continue;
    narray += countInt(node.key, bins);
    total += 1;
  }
  narray += countInt(extraKey, bins);
  // bestasize
  let sum = 0;
  let best = 0;
  let size = 0;
  for (let b = 0; 2 * narray > 2 ** b && sum !== narray; b += 1) {
    const inBin = bins[b] ?? 0;
    if (inBin > 0) {
      sum += inBin;
      if (2 * sum > 2 ** b) {
        size = 2 ** (b + 1) + 1;
        best = sum;
      }
    }
  }
  total -= best;
  // resizetab
  const oldAsize = t.asize;
  const oldNodes = t.nodes;
  if (size > oldAsize) {
    for (let i = oldAsize; i < size; i += 1) t.array[i] = false;
    t.asize = size;
  }
  const hbits = hsize2hbits(total);
  t.hsize = hbits === 0 ? 0 : 2 ** hbits;
  t.nodes = Array.from({ length: t.hsize }, () => ({ key: null, next: -1 }));
  t.freetop = t.hsize;
  if (size < oldAsize) {
    const old = t.array;
    t.asize = size;
    t.array = old.slice(0, size);
    for (let i = size; i < oldAsize; i += 1) if (old[i] === true && !inHash(t, i)) newKey(t, i);
  }
  for (const node of oldNodes) if (node.key !== null) setKey(t, node.key);
}

/** `t[k] = v` for a key not yet in the table. `v` must not be nil. */
export function luaSet<V>(t: LuaIntTable<V>, k: number, v: V): void {
  if (!Number.isInteger(k) || k < 0 || k > 0x7fffffff) {
    throw new RangeError(`luaSet: ${String(k)} is not a key this emulation lays out`);
  }
  if (!t.values.has(k)) setKey(t, k);
  t.values.set(k, v);
}

/** `t[k]`, `undefined` for nil. */
export function luaGet<V>(t: LuaIntTable<V>, k: number): V | undefined {
  return t.values.get(k);
}

/** `#t` (`lj_tab_len`, then `unbound_search` when the array part ends full). */
export function luaLength(t: LuaIntTable<unknown>): number {
  let j = t.asize;
  if (j > 1 && t.array[j - 1] !== true) {
    let i = 1;
    while (j - i > 1) {
      const m = Math.floor((i + j) / 2);
      if (t.array[m - 1] !== true) j = m;
      else i = m;
    }
    return i - 1;
  }
  if (j > 0) j -= 1;
  if (t.hsize === 0) return j;
  const has = (k: number): boolean => (k < t.asize ? t.array[k] === true : inHash(t, k));
  let i = j;
  j += 1;
  while (has(j)) {
    i = j;
    j *= 2;
  }
  while (j - i > 1) {
    const m = Math.floor((i + j) / 2);
    if (has(m)) i = m;
    else j = m;
  }
  return i;
}

/** `pairs(t)`, in `lj_tab_next`'s order: array slots ascending, then hash nodes. */
export function luaPairs<V>(t: LuaIntTable<V>): [number, V][] {
  const keys: number[] = [];
  for (let i = 0; i < t.asize; i += 1) if (t.array[i] === true) keys.push(i);
  for (const node of t.nodes) if (node.key !== null) keys.push(node.key);
  return keys.map((k) => [k, t.values.get(k) as V]);
}

// ═══════════════════════════════════════════════════════════════════════════
// THE GENERATOR
// ═══════════════════════════════════════════════════════════════════════════

/**
 * A zone's `generator.map` table for Hexacle, field for field. Absent values
 * take the defaults `Hexacle:init` writes (`engine/generator/map/Hexacle.lua:29-43`).
 * Grid keys are `'#'`, `'.'`, `up` and `down`.
 */
export type HexacleData = {
  /** Percent, per neighbour of a dug ring cell, that the neighbour is dug too. Default 70. */
  readonly segmentWideChance?: number;
  /** Sides per ring, a positive integer. Default 8. */
  readonly nbSegments?: number;
  /** Rings, a positive integer. Default 4. */
  readonly nbLayers?: number;
  /** The drop chance a ring starts at, and returns to after each drop. Default 10. */
  readonly segmentMissPercent?: number;
  /** Each ring's radius, outermost first. Default: see `createHexacle`. */
  readonly layers?: readonly { readonly rad: number }[];
  /** Place a down stair on the zone's last level too. */
  readonly forceLastStair?: boolean;
  /**
   * The Infinite Dungeon's own flag: `alter_level_data` squares the map when a
   * layout sets it (`data/zones/infinite-dungeon/zone.lua:232-235`). The
   * generator never reads it; it rides along so the table is upstream's.
   */
  readonly forceSquareSize?: boolean;
  readonly grid: GridKeys;
};

/** A `generator.map` table naming `engine.generator.map.Hexacle`. */
export type HexacleMapSpec = { readonly class: 'Hexacle' } & HexacleData;

/** The part of a zone table a Hexacle level is built from. */
export type HexacleLevelSpec = Omit<LevelSpec, 'map'> & { readonly map: HexacleMapSpec };

/** `data.layers[i]` once `init` has numbered it. */
export type HexacleLayer = { readonly rad: number; readonly id: number };

/** `HexacleData` once `Hexacle:init` has written its defaults in. */
export type HexacleSettings = {
  readonly segmentWideChance: number;
  readonly nbSegments: number;
  /** `a_step`: `360 / nb_segments`, always recomputed. */
  readonly aStep: number;
  readonly nbLayers: number;
  readonly segmentMissPercent: number;
  readonly layers: readonly HexacleLayer[];
  readonly forceLastStair: boolean;
};

/**
 * One side of one ring: `{a=a, pa=pa, layer=layer, id=id}`
 * (`engine/generator/map/Hexacle.lua:90`). It runs from the vertex at angle `a`
 * back to the vertex at `pa`; side `id` is centred on `(id - 1) * a_step`.
 */
export type HexacleSegment = {
  readonly a: number;
  readonly pa: number;
  readonly layer: HexacleLayer;
  readonly id: number;
  /** Written when the side is marked (`:145-146`); where spokes start and end. */
  centerX: number | null;
  centerY: number | null;
};

/**
 * A group: upstream's `cur_group`, a list of side ids in scan order, plus the
 * two fields the Lua hangs on that same table.
 */
export type HexacleGroup = {
  readonly ids: readonly number[];
  /** `group.connected[layer_id][group2] = true`: every group a spoke joined it to, by ring. */
  connected: Map<number, Set<HexacleGroup>> | null;
  /** `group.dead`: no spoke could be dug to it. */
  dead: boolean;
  /** Which pass of `generate` made it, 0 first. NOT upstream's: diagnostics, and the A4 tests. */
  readonly pass: number;
};

/** Why a pass started over. */
export type HexacleRestart = 'whoops' | 'unconnected';

/** The generator instance: `Generator`'s `self`, Hexacle's `data`, and its share of `room_map`. */
export type HexacleGen = {
  readonly map: GenMap;
  readonly rng: Rng;
  readonly data: HexacleSettings;
  readonly zone: { readonly maxLevel: number };
  readonly level: { forceRecreate: string | null };
  /**
   * `room_map[x][y].segment`, row-major. `RoomCell` has no such field, so it is
   * kept beside the map, on the generator — which, like the map, is made
   * afresh for every `newLevel` attempt — and like every room-map flag it is
   * never cleared.
   */
  readonly segment: (string | null)[];
  /** `room_map[x][y].segment_group`, row-major. */
  readonly segmentGroup: (HexacleGroup | null)[];
  /** `self.ids_to_groups[layer_id][side_id]`, replaced at the start of each pass. */
  idsToGroups: Map<number, Map<number, HexacleGroup>>;
  /** How many times this attempt started over, and why. Diagnostics. */
  readonly restarts: HexacleRestart[];
};

/** What `generate` returns: upstream's `ux, uy, dx, dy, spots`. */
export type HexacleResult = {
  readonly up: TileXY | null;
  readonly down: TileXY | null;
  readonly spots: readonly Spot[];
};

/**
 * How many times one attempt may start over before it gives up.
 *
 * UPSTREAM RECURSES WITHOUT LIMIT (`engine/generator/map/Hexacle.lua:140`,
 * `:234`), and a table that keeps every side — `segment_miss_percent = 0` —
 * turns that into a stack overflow. Past this many restarts the attempt sets
 * `force_recreate` and `newLevel` moves on, as for `CAVERN_MAX_REBUILDS`.
 */
export const HEXACLE_MAX_REBUILDS = 200;

/**
 * How many random cells a stair search tries, per map cell, before it gives up.
 * Upstream loops forever (`engine/generator/map/Hexacle.lua:258-265`); see the
 * same cap in `mapgen/roomer.ts`.
 */
const STAIR_TRIES_PER_CELL = 20;

/** Lua's `math.rad(x)` is `x` times this: LuaJIT pushes 0.017453292519943295, the double nearest pi/180. */
const RADIANS_PER_DEGREE = Math.PI / 180;

/**
 * `Hexacle:init(zone, map, level, data)` (`engine/generator/map/Hexacle.lua:27-44`).
 * Nothing draws.
 *
 * - THE RADII COME FROM THE WIDTH ALONE: ring `i` of `L` is
 *   `floor(w / (L + 0.5)) * (L - i + 1) / 2`, not floored again, so it may be
 *   a half. On a map taller than it is wide that is harmless; on one shorter,
 *   a ring can leave the map (see `markSegments`).
 * - Upstream writes the defaults INTO the zone's table, so a table reused for
 *   another level keeps the first level's radii. `Zone:newLevel` passes the same
 *   table to every attempt at one level (`engine/Zone.lua:1053`), whose width
 *   does not change; the Infinite Dungeon builds a fresh table per level. So
 *   nothing observable follows, and this leaves the caller's table alone.
 */
export function createHexacle(
  map: GenMap,
  data: HexacleData,
  rng: Rng,
  zone: { readonly maxLevel: number },
  level: { forceRecreate: string | null },
): HexacleGen {
  const nbSegments = data.nbSegments ?? 8;
  const nbLayers = data.nbLayers ?? 4;
  if (!Number.isInteger(nbSegments) || nbSegments < 1) {
    throw new RangeError(
      `Hexacle: nb_segments must be a positive integer, not ${String(nbSegments)}`,
    );
  }
  if (!Number.isInteger(nbLayers) || nbLayers < 1) {
    throw new RangeError(`Hexacle: nb_layers must be a positive integer, not ${String(nbLayers)}`);
  }
  const radii =
    data.layers ??
    Array.from({ length: nbLayers }, (_, k) => ({
      rad: (Math.floor(map.w / (nbLayers + 0.5)) * (nbLayers - (k + 1) + 1)) / 2,
    }));
  const layers = Array.from({ length: nbLayers }, (_, k) => {
    const given = radii[k];
    if (given === undefined)
      throw new RangeError(`Hexacle: data.layers has no layer ${String(k + 1)}`);
    return { rad: given.rad, id: k + 1 };
  });
  return {
    map,
    rng,
    data: {
      segmentWideChance: data.segmentWideChance ?? 70,
      nbSegments,
      aStep: 360 / nbSegments,
      nbLayers,
      segmentMissPercent: data.segmentMissPercent ?? 10,
      layers,
      forceLastStair: data.forceLastStair === true,
    },
    zone,
    level,
    segment: new Array<string | null>(map.w * map.h).fill(null),
    segmentGroup: new Array<HexacleGroup | null>(map.w * map.h).fill(null),
    idsToGroups: new Map(),
    restarts: [],
  };
}

/**
 * One ring's sides, rolled (`engine/generator/map/Hexacle.lua:79-103`).
 *
 * - THE ANGLES: side `id` runs from `a = rad((id - 0.5) * a_step)` back to
 *   `pa`, the previous side's `a`; side 1's `pa` is `-rad(a_step / 2)`. The
 *   loop is `for ad = a_step / 2, 360, a_step`, whose index LuaJIT advances by
 *   adding the step, and which makes exactly `nb_segments` sides.
 * - THE ROLLS: the sides in `rng.tableSampleIterator` order, one percent roll
 *   each. A side is KEPT when the roll MISSES `segment_miss_percent`, and each
 *   kept side DOUBLES that chance; a dropped side puts it back to the zone's
 *   value. The chance truncates, so 10 keeps at most four in a row (the fifth
 *   roll is at 160).
 */
export function rollSegments(gen: HexacleGen, layer: HexacleLayer): LuaIntTable<HexacleSegment> {
  const { rng, data } = gen;
  let segmentMissPercent = data.segmentMissPercent;
  const s = luaTable<HexacleSegment>();
  const angles: HexacleSegment[] = [];
  let pa = -((data.aStep / 2) * RADIANS_PER_DEGREE);
  let id = 1;
  for (let ad = data.aStep / 2; ad <= 360; ad += data.aStep) {
    const a = ad * RADIANS_PER_DEGREE;
    angles.push({ a, pa, layer, id, centerX: null, centerY: null });
    pa = a;
    id += 1;
  }
  for (const a of tableSampleIterator(rng, 'mapgen.hexacle.segments.order', angles)) {
    if (!percent(rng, 'mapgen.hexacle.segments.miss', segmentMissPercent)) {
      luaSet(s, a.id, a);
      segmentMissPercent *= 2;
    } else {
      segmentMissPercent = data.segmentMissPercent;
    }
  }
  return s;
}

/**
 * One ring's groups (`engine/generator/map/Hexacle.lua:110-135`): its kept
 * sides cut into runs of consecutive ids, wrapping from the last side to the
 * first. Each group is added to `allGroups` and to `gen.idsToGroups`.
 *
 * THE SCAN STARTS AT `first_hole = #s % nb_segments`, then walks
 * `nb_segments + 1` positions, ids `first_hole + 1` round to `first_hole + 1`
 * again. A run is closed only by a gap, so a scan that starts on a gap closes
 * every run, and one that starts inside a run would leave that run's head in
 * no group. `#s` is LuaJIT's border (see the file's second section): an `n`
 * with `s[n + 1]` nil, so side `n + 1` is a gap and the scan starts on it — or,
 * when `n` is `N` and side 1 is kept, the special case moves the start to the
 * first gap after side 1. A ring with no gap at all makes no group.
 */
export function groupSegments(
  gen: HexacleGen,
  layerId: number,
  s: LuaIntTable<HexacleSegment>,
  allGroups: Set<HexacleGroup>,
  pass: number,
): HexacleGroup[] {
  const n = gen.data.nbSegments;
  let curGroup: number[] = [];
  const groups: HexacleGroup[] = [];
  let firstHole = mod(luaLength(s), n);
  if (firstHole === 0 && luaGet(s, 1) !== undefined) {
    let test = 2;
    while (luaGet(s, test) !== undefined && test <= n) test += 1;
    firstHole = test - 1;
  }
  for (let z = firstHole; z <= firstHole + n; z += 1) {
    const id = mod(z, n) + 1;
    if (luaGet(s, id) === undefined) {
      if (curGroup.length > 0) {
        const group: HexacleGroup = { ids: curGroup, connected: null, dead: false, pass };
        groups.push(group);
        allGroups.add(group);
        let byId = gen.idsToGroups.get(layerId);
        if (byId === undefined) {
          byId = new Map();
          gen.idsToGroups.set(layerId, byId);
        }
        for (const gid of curGroup) byId.set(gid, group);
      }
      curGroup = [];
    } else {
      curGroup.push(id);
    }
  }
  return groups;
}

/**
 * Every kept side's cells, marked in the room map
 * (`engine/generator/map/Hexacle.lua:138-154`). Rings in order, and each ring's
 * sides in `pairs` order — which decides only whose group a cell two sides
 * share ends up with.
 *
 * - A SIDE IS A `core.fov.line` from its `a` vertex to its `pa` vertex, each
 *   `centre + floor(rad * cos)` and `centre + floor(rad * sin)`. The terrain is
 *   solid rock throughout (nothing is dug before the spokes), so every side of
 *   two cells or more is a blocked line — still yielded to its end, from the
 *   cell after the `a` vertex to the `pa` vertex itself.
 * - The side's middle, `floor((sx + ex) / 2)` and the same for y, is stored
 *   for the spokes. It need not be one of the side's cells.
 *
 * Returns `'whoops'` at the first side in no group, where upstream starts over,
 * leaving every earlier side marked; `'offmap'` at a cell off the map, where
 * upstream indexes a nil row of the room map and raises an error.
 */
export function markSegments(
  gen: HexacleGen,
  segments: LuaIntTable<LuaIntTable<HexacleSegment>>,
): true | 'whoops' | 'offmap' {
  const { map } = gen;
  const cx = Math.floor(map.w / 2);
  const cy = Math.floor(map.h / 2);
  const block = blockSight(map);
  for (const [, layerSegments] of luaPairs(segments)) {
    for (const [, a] of luaPairs(layerSegments)) {
      const group = gen.idsToGroups.get(a.layer.id)?.get(a.id);
      // "big whoops"
      if (group === undefined) return 'whoops';
      const rad = a.layer.rad;
      const sx = cx + Math.floor(rad * Math.cos(a.a));
      const sy = cy + Math.floor(rad * Math.sin(a.a));
      const ex = cx + Math.floor(rad * Math.cos(a.pa));
      const ey = cy + Math.floor(rad * Math.sin(a.pa));
      a.centerX = Math.floor((sx + ex) / 2);
      a.centerY = Math.floor((sy + ey) / 2);
      const l = fovLine(map, sx, sy, ex, ey, block);
      for (let st = l.step(); st !== null; st = l.step()) {
        if (!map.isBound(st.x, st.y)) return 'offmap';
        gen.segment[st.y * map.w + st.x] = '.';
        gen.segmentGroup[st.y * map.w + st.x] = group;
      }
    }
  }
  return true;
}

/**
 * `Hexacle:connectGroups(group, group2, a, a2)` (`engine/generator/map/Hexacle.lua:46-65`):
 * dig a spoke from the middle of side `a` to the middle of side `a2`, then join
 * the two groups both ways, filed under the OTHER group's ring.
 *
 * - THE SPOKE IS A `core.fov.line` MADE AGAINST THE MAP AS IT IS NOW: every
 *   spoke dug before this one is open floor to it, and bends it. Its cells are
 *   dug as they are stepped, which cannot move this spoke — its ray was fixed
 *   when it was made — only the next one.
 * - THE START CELL IS NOT DUG; the end cell is. Each cell resolves `'.'`
 *   before it is written, so a table grid draws once per cell.
 * - The second argument is upstream's `group2`, which every caller passes as an
 *   undeclared global and the function immediately shadows with the group that
 *   owns `a2`. It is dropped here.
 */
export function connectGroups(
  gen: HexacleGen,
  group: HexacleGroup,
  a: HexacleSegment,
  a2: HexacleSegment,
): void {
  const { map } = gen;
  if (a.centerX === null || a.centerY === null || a2.centerX === null || a2.centerY === null) {
    throw new Error(`connectGroups: side ${String(a.id)} or ${String(a2.id)} was never marked`);
  }
  const l = fovLine(map, a.centerX, a.centerY, a2.centerX, a2.centerY, blockSight(map));
  eachStep(l, (x, y) => map.set(x, y, map.resolve('.')));

  const group2 = gen.idsToGroups.get(a2.layer.id)?.get(a2.id);
  if (group2 === undefined) {
    throw new Error(
      `connectGroups: side ${String(a2.id)} of ring ${String(a2.layer.id)} is in no group`,
    );
  }
  join(group, a2.layer.id, group2);
  join(group2, a.layer.id, group);
}

/** `group.connected[layer] = group.connected[layer] or {}; ...[other] = true`. */
function join(group: HexacleGroup, layerId: number, other: HexacleGroup): void {
  group.connected ??= new Map();
  let set = group.connected.get(layerId);
  if (set === undefined) {
    set = new Set();
    group.connected.set(layerId, set);
  }
  set.add(other);
}

/** `not group.connected or not next(group.connected)`: joined to nothing. */
function unjoined(group: HexacleGroup): boolean {
  return group.connected === null || group.connected.size === 0;
}

/** `segments[layer_id][id]`, nil for a side not kept. */
function sideOf(
  segments: LuaIntTable<LuaIntTable<HexacleSegment>>,
  layerId: number,
  id: number,
): HexacleSegment | undefined {
  const s = luaGet(segments, layerId);
  return s === undefined ? undefined : luaGet(s, id);
}

/**
 * "Link groups with tunnels" (`engine/generator/map/Hexacle.lua:157-180`): ring
 * by ring, group by group, one candidate per side — the nearest ring INWARD
 * that kept a side of the same number — and one spoke to a candidate picked
 * with `rng.table`. A group with no side on any inner ring digs nothing here.
 *
 * WHAT THIS GUARANTEES, and `rescueOrphans` relies on: every group with a side
 * number that some inner ring also kept has a candidate, so it digs, and is
 * joined when this returns.
 */
export function digTunnels(
  gen: HexacleGen,
  segments: LuaIntTable<LuaIntTable<HexacleSegment>>,
  layerGroups: readonly (readonly HexacleGroup[])[],
): void {
  const { rng, data } = gen;
  for (let i = 1; i <= data.nbLayers; i += 1) {
    for (const group of layerGroups[i - 1] ?? []) {
      const possibleTunnels: { a: HexacleSegment; a2: HexacleSegment }[] = [];
      for (const id of group.ids) {
        const a = sideOf(segments, i, id) as HexacleSegment;
        for (let j = i + 1; j <= data.nbLayers; j += 1) {
          const a2 = sideOf(segments, j, id);
          if (a2 !== undefined) {
            possibleTunnels.push({ a, a2 });
            break;
          }
        }
      }
      if (possibleTunnels.length > 0) {
        const t = table(rng, 'mapgen.hexacle.tunnel', possibleTunnels);
        if (t !== null) connectGroups(gen, group, t.value.a, t.value.a2);
      }
    }
  }
}

/**
 * "Find orphans and try to connect or remove them"
 * (`engine/generator/map/Hexacle.lua:187-217`): every group still joined to
 * nothing looks, side by side, for the same side number on ANY other ring, in
 * ring order, takes the first, and digs one spoke to a candidate picked with
 * `rng.table` — "Connect or die!": with no candidate it is marked dead.
 *
 * ═══ ONE CLAUSE OF THE LUA IS NOT HERE, BECAUSE IT CANNOT BE FALSE ═══
 * Upstream only takes a side whose group is already joined — "Only link to
 * things that are part of the global network", `group2.connected and
 * next(group2.connected)` (`:199-204`). It always is. An orphan on ring `i`
 * has no side number that an inner ring kept, or `digTunnels` would have
 * joined it; so any ring `j` sharing its side is OUTER, and that ring's group
 * holds a side number ring `i` kept, so `digTunnels` joined it. Measured, not
 * only argued: 401,696 passes over 3 to 12 sides, 1 to 7 rings and drop
 * chances 0 to 70 reached the clause 37,518 times and found it false none.
 * `hexacle.test.ts` pins the premise on `digTunnels`, and the Lua transcription
 * there keeps the clause and still matches.
 */
export function rescueOrphans(
  gen: HexacleGen,
  segments: LuaIntTable<LuaIntTable<HexacleSegment>>,
  layerGroups: readonly (readonly HexacleGroup[])[],
): void {
  const { rng, data } = gen;
  for (let i = 1; i <= data.nbLayers; i += 1) {
    for (const group of layerGroups[i - 1] ?? []) {
      if (!unjoined(group)) continue;
      const possibleTunnels: { a: HexacleSegment; a2: HexacleSegment }[] = [];
      for (const id of group.ids) {
        const a = sideOf(segments, i, id) as HexacleSegment;
        for (let j = 1; j <= data.nbLayers; j += 1) {
          if (i === j) continue;
          const a2 = sideOf(segments, j, id);
          if (a2 !== undefined) {
            possibleTunnels.push({ a, a2 });
            break;
          }
        }
      }
      if (possibleTunnels.length > 0) {
        const t = table(rng, 'mapgen.hexacle.orphan', possibleTunnels);
        if (t !== null) connectGroups(gen, group, t.value.a, t.value.a2);
      } else {
        group.dead = true;
      }
    }
  }
}

/**
 * "Flood fill to make SURE we only have one big cavern"
 * (`engine/generator/map/Hexacle.lua:220-235`): from ring 1's first group,
 * through every spoke, taking each group reached out of `allGroups`. `true`
 * when none is left; `'unconnected'` where upstream starts over.
 *
 * A GROUP JOINED TO NOTHING IS NEVER TAKEN OUT — not even the first one, which
 * stops the walk before it starts — so one dead group is always a restart, and
 * so is a ring alone: its groups have no ring to dig to.
 *
 * GUARD: ring 1 with no group at all is `check_all(nil)`, a Lua error
 * upstream; here it is `'no-first-group'`.
 */
export function checkNetwork(
  layerGroups: readonly (readonly HexacleGroup[])[],
  allGroups: Set<HexacleGroup>,
): true | 'unconnected' | 'no-first-group' {
  const first = layerGroups[0]?.[0];
  if (first === undefined) return 'no-first-group';
  const stack: HexacleGroup[] = [first];
  while (stack.length > 0) {
    const group = stack.pop() as HexacleGroup;
    if (unjoined(group) || !allGroups.has(group)) continue;
    allGroups.delete(group);
    for (const joined of group.connected?.values() ?? []) stack.push(...joined);
  }
  return allGroups.size > 0 ? 'unconnected' : true;
}

/** One pass of `generate`, up to the paint. `true` where upstream carries on to paint. */
function generatePass(
  gen: HexacleGen,
  pass: number,
): true | HexacleRestart | 'offmap' | 'no-first-group' {
  const { map, data } = gen;

  for (let i = 0; i <= map.w - 1; i += 1) {
    for (let j = 0; j <= map.h - 1; j += 1) map.set(i, j, map.resolve('#'));
  }

  // `segments[i] = {}` for i = 1..L, in order: LuaJIT keeps them in the array
  // part, so `pairs(segments)` walks the rings in order.
  const segments = luaTable<LuaIntTable<HexacleSegment>>();
  for (const layer of data.layers) luaSet(segments, layer.id, rollSegments(gen, layer));

  const layerGroups: HexacleGroup[][] = [];
  gen.idsToGroups = new Map();
  const allGroups = new Set<HexacleGroup>();
  for (let i = 1; i <= data.nbLayers; i += 1) {
    const s = luaGet(segments, i) ?? luaTable<HexacleSegment>();
    layerGroups.push(groupSegments(gen, i, s, allGroups, pass));
  }

  const marked = markSegments(gen, segments);
  if (marked !== true) return marked;
  digTunnels(gen, segments, layerGroups);
  rescueOrphans(gen, segments, layerGroups);
  return checkNetwork(layerGroups, allGroups);
}

/**
 * The paint (`engine/generator/map/Hexacle.lua:238-247`): every marked cell whose
 * group is not dead, column by column, becomes its mark's terrain, then each
 * neighbour in the order east, west, south, north on its own
 * `segment_wide_chance` roll. The roll comes first and the resolve only on a
 * hit; a neighbour off the map still resolves, and the write is dropped.
 *
 * Marks from failed passes are painted too — see the file note.
 */
export function paintSegments(gen: HexacleGen): void {
  const { map, rng, data } = gen;
  const wide = data.segmentWideChance;
  for (let i = 0; i <= map.w - 1; i += 1) {
    for (let j = 0; j <= map.h - 1; j += 1) {
      const segment = gen.segment[j * map.w + i] ?? null;
      const group = gen.segmentGroup[j * map.w + i] ?? null;
      if (segment === null || group === null || truthy(group.dead)) continue;
      map.set(i, j, map.resolve(segment));
      if (percent(rng, 'mapgen.hexacle.wide', wide)) map.set(i + 1, j, map.resolve(segment));
      if (percent(rng, 'mapgen.hexacle.wide', wide)) map.set(i - 1, j, map.resolve(segment));
      if (percent(rng, 'mapgen.hexacle.wide', wide)) map.set(i, j + 1, map.resolve(segment));
      if (percent(rng, 'mapgen.hexacle.wide', wide)) map.set(i, j - 1, map.resolve(segment));
    }
  }
}

/**
 * `Hexacle:generate(lev, old_lev)` (`engine/generator/map/Hexacle.lua:67-251`).
 *
 * ═══ THE DRAWS, IN ORDER ═══
 * One `'#'` resolve per cell, x outer. Per ring: the sample order and one
 * percent per side, interleaved. Per group, ring by ring: one spoke pick, then a
 * `'.'` resolve per spoke cell; the same for each orphan. On a restart, all of
 * that again. Then four percents per painted cell, a resolve for each hit, and
 * the stairs.
 *
 * ═══ THE RESTART IS A LOOP, ON THE SAME RNG AND THE SAME ROOM MAP ═══
 * Upstream's `return self:generate(lev, old_lev)` continues the level's one
 * number stream, and so does this. It returns `null`, with `force_recreate`
 * set, past `HEXACLE_MAX_REBUILDS` restarts and in the two states upstream
 * raises an error in.
 */
export function generate(gen: HexacleGen, lev: number, oldLev: number): HexacleResult | null {
  for (let pass = 0; ; pass += 1) {
    const outcome = generatePass(gen, pass);
    if (outcome === true) break;
    if (outcome === 'offmap') {
      gen.level.forceRecreate = 'Hexacle: a ring runs off the map';
      return null;
    }
    if (outcome === 'no-first-group') {
      gen.level.forceRecreate = 'Hexacle: ring 1 kept no side';
      return null;
    }
    gen.restarts.push(outcome);
    if (gen.restarts.length > HEXACLE_MAX_REBUILDS) {
      gen.level.forceRecreate = `Hexacle: ${String(HEXACLE_MAX_REBUILDS + 1)} passes and no single network`;
      return null;
    }
  }
  paintSegments(gen);
  // `local spots = {}`: nothing is ever added to it.
  return makeStairsInside(gen, lev, oldLev, []);
}

/**
 * One stair inside the level: random cells in `1..w-1` by `1..h-1`, x drawn
 * first, until one neither blocks movement nor is `special`. It becomes the
 * key's terrain and `special = "exit"`. The capped form of upstream's
 * `while true`.
 */
function placeStairInside(gen: HexacleGen, key: 'up' | 'down'): TileXY | null {
  const { map, rng } = gen;
  const limit = map.w * map.h * STAIR_TRIES_PER_CELL;
  for (let tries = 0; tries < limit; tries += 1) {
    const x = range(rng, `mapgen.hexacle.stairs.${key}.x`, 1, map.w - 1);
    const y = range(rng, `mapgen.hexacle.stairs.${key}.y`, 1, map.h - 1);
    if (!map.blockMove(x, y) && !truthy(map.cell(x, y).special)) {
      map.set(x, y, map.resolve(key));
      map.cell(x, y).special = 'exit';
      return { x, y };
    }
  }
  gen.level.forceRecreate = `makeStairsInside: no cell for the ${key} stair`;
  return null;
}

/**
 * `Hexacle:makeStairsInside(lev, old_lev, spots)` (`engine/generator/map/Hexacle.lua:254-280`),
 * the same helper Cavern and Octopus carry: the down stair first — only below
 * the zone's last level, unless `force_last_stair` — then the up stair, each on
 * a random cell of `1..w-1` by `1..h-1` that is open and not `special`. No
 * forced stair positions.
 */
export function makeStairsInside(
  gen: HexacleGen,
  lev: number,
  _oldLev: number,
  spots: readonly Spot[],
): HexacleResult {
  let down: TileXY | null = null;
  if (lev < gen.zone.maxLevel || gen.data.forceLastStair) {
    down = placeStairInside(gen, 'down');
    if (down === null) return { up: null, down: null, spots };
  }
  return { up: placeStairInside(gen, 'up'), down, spots };
}

// ═══════════════════════════════════════════════════════════════════════════
// ZONES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE INFINITE DUNGEON'S "HEXA" LAYOUT — the only Hexacle table in ToME
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `data/zones/infinite-dungeon/zone.lua:171-179`: six rings of eight sides, a
 * 10% drop chance, 70% widening, and `force_square_size`, which
 * `alter_level_data` answers by squaring the map to its larger side (`:232-235`).
 *
 * THE SIZE: `alter_level_data` rolls it, `size = 60 + floor(30*lev/(lev+50))`
 * and a random aspect (`:103-105`), then squares it. 60x60 is the smallest
 * square it can make, on level 1; the rings scale with the width. With a width
 * of 60 the radii are 27, 22.5, 18, 13.5, 9 and 4.5.
 *
 * THE GRIDS: the dungeon draws a floor and wall set per level (`:185-203`); here
 * `'.'` and `'#'` are the default codes, and the stairs are the floor a stair
 * marker stands on, as for the orc breeding pits.
 *
 * ONE CHANGE, ABOUT WHERE THIS RUNS: `forceLastStair`. The dungeon has no last
 * level; here the realm decides whether a floor has a way down, so the
 * generator always places one (as `ROOMER_RUINS_KOR_PUL` does).
 *
 * ═══ MEASURED ═══
 * 3,000 levels through `newLevel`'s loop: an attempt started over 0.88 times on
 * average and 11 at most, every time because a group died; 7 first attempts
 * stood a stair where the other could not reach it — on a stale fragment, or a
 * ring whose spoke started beside its side rather than on it — and all 7
 * certified on the second. About 1,080 open cells of the 3,600. About 1.3 ms a
 * level, p95 2.5 ms; with the reachability check, 1.5 ms.
 */
export const HEXACLE_INFINITE_DUNGEON: HexacleLevelSpec = {
  width: 60,
  height: 60,
  map: {
    class: 'Hexacle',
    segmentWideChance: 70,
    nbSegments: 8,
    nbLayers: 6,
    segmentMissPercent: 10,
    forceSquareSize: true,
    forceLastStair: true,
    grid: {
      '.': TileCode.FLOOR,
      '#': TileCode.WALL,
      up: TileCode.FLOOR,
      down: TileCode.FLOOR,
    },
  },
};
