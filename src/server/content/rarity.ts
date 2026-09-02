// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/engines/default/engine/Zone.lua:205-262 (`computeRarities`)
//             t-engine4 game/engines/default/engine/Zone.lua:318-330 (`pickEntity`)
//             t-engine4 game/engines/default/engine/Zone.lua:65 (`ood_factor = 3`)
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" — https://te4.org/license

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *     HOW LIKELY A THING IS TO APPEAR, GIVEN HOW DEEP YOU ARE. 25 LINES.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * This is the single highest-value import from the whole item subsystem, and it
 * is five lines of arithmetic:
 *
 * ```lua
 * -- Zone.lua:217-221
 * local max = 10000
 * if lev < e.level_range[1] then max = 10000 / (self.ood_factor * (e.level_range[1] - lev))
 * elseif e.level_range[2] and lev > e.level_range[2] then max = 10000 / (lev - e.level_range[2])
 * end
 * local genprob = math.floor(max / e[rarity_field])
 * ```
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE ASYMMETRY IS THE WHOLE FEEL, AND IT IS EASY TO MISS
 * ═══════════════════════════════════════════════════════════════════════════
 * An item BELOW your level has its weight divided by `3 × levelsBelow`. An item
 * ABOVE your level is divided by `levelsAbove` alone. **Upward is three times
 * gentler.** So you find something a little beyond you now and then, and you
 * stop finding the starting gear almost immediately — which is what makes loot
 * feel like it is tracking you rather than being rolled at you.
 *
 * `ood_factor` defaults to 3 (engine/Zone.lua:65) and ToME never overrides it.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ONE FUNCTION FOR BOTH BASE ITEMS AND EGOS, WHICH IS WHY THERE ARE NO TIERS
 * ═══════════════════════════════════════════════════════════════════════════
 * Upstream calls `computeRarities` for objects, for actors and for ego lists
 * (Zone.lua:333-341's `generateEgoEntities` is the third). Level gating, tier
 * gating and per-row hand tuning all fall out of `rarity` + `levelRange`, with
 * no tier table anywhere — which is the reason §5 of the port plan could cut
 * `greater_ego` without losing the gating it appeared to provide.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * IN content/ AND NOT IN shared/
 * ═══════════════════════════════════════════════════════════════════════════
 * It takes an `Rng` and is called only from content. `shared/` would be right
 * only if the client needed it, and the client must never roll anything —
 * non-negotiable #4. The functions here take no clock, no `Math.random` and no
 * module-level state: the only mutation is the array `computeRarities` builds
 * and returns.
 *
 * Names kept verbatim per CLAUDE.md's grep rule: `computeRarities`, `pickEntity`,
 * `genprob`, `ood_factor`.
 */

import type { Rng } from '../../shared/rng.ts';

/**
 * Zone.lua:65. Never overridden anywhere in the tree, so it is a constant here
 * rather than a field on something.
 */
export const OOD_FACTOR = 3;

/**
 * Zone.lua:217. The numerator every weight is a fraction of. Arbitrary in
 * itself; load-bearing only in that `genprob` is FLOORED against it, so a
 * candidate whose weight falls below 1 drops out of the list entirely.
 */
export const RARITY_SCALE = 10000;

/** What `computeRarities` needs to know about a candidate, and nothing more. */
export type RarityCandidate = {
  /** Lower is commoner. `genprob = floor(max / rarity)`. */
  readonly rarity: number;
  /** `[low, high]`. Outside it, the weight is divided — see the header. */
  readonly levelRange: readonly [number, number];
};

/** One row of the computed list: a candidate and its CUMULATIVE weight. */
export type RarityEntry<T> = {
  readonly e: T;
  /**
   * THE RUNNING TOTAL, NOT THIS ENTRY'S OWN WEIGHT. Zone.lua:245 stores
   * `r.total` after adding, so the list is ascending and `pickEntity` is one
   * linear walk with no second pass.
   */
  readonly genprob: number;
};

/** The computed list. `total` is the last entry's `genprob`. */
export type RarityList<T> = {
  readonly entries: readonly RarityEntry<T>[];
  readonly total: number;
};

/**
 * Weight every candidate for a party at `level`, dropping the ones that cannot
 * appear at all.
 *
 * @param list the candidates, in a FIXED order. Order is seed contract: the
 *   cumulative array is walked by `pickEntity`, so reordering the roster changes
 *   what a given seed produces. Content arrays here are all `Object.freeze`d
 *   declaration-order lists for exactly that reason.
 * @param level the depth to weight against. Inner Datum has no zone level, so
 *   callers pass PARTY MAX LEVEL — see the note in `rollLoot`.
 * @param filter an optional `checkFilter` equivalent (Zone.lua:214's `filter`).
 *   Applied BEFORE the weight is computed, as upstream does, so a rejected
 *   candidate costs nothing.
 *
 * NO DRAWS. It is pure over its arguments; `pickEntity` is where the one draw
 * lives, which is what lets a caller compute a list once and pick from it twice.
 */
export function computeRarities<T extends RarityCandidate>(
  list: readonly T[],
  level: number,
  filter?: (candidate: T) => boolean,
): RarityList<T> {
  const entries: RarityEntry<T>[] = [];
  let total = 0;

  for (const e of list) {
    if (filter !== undefined && !filter(e)) continue;

    const [low, high] = e.levelRange;
    let max = RARITY_SCALE;
    if (level < low) {
      // UNDER-DEPTH: divided by 3 × the gap. Zone.lua:218.
      max = RARITY_SCALE / (OOD_FACTOR * (low - level));
    } else if (level > high) {
      // OVER-DEPTH: divided by the gap alone — three times gentler. Zone.lua:219.
      max = RARITY_SCALE / (level - high);
    }

    // FLOOR, not round. Zone.lua:221. This is what makes a candidate far enough
    // out of depth drop out of the list rather than lingering at a vanishing
    // probability, and `genprob > 0` at :243 is the same rule stated twice.
    const genprob = Math.floor(max / e.rarity);
    if (genprob <= 0) continue;

    total += genprob;
    entries.push({ e, genprob: total });
  }

  return { entries, total };
}

/**
 * One candidate out of a computed list, or `undefined` for an empty one.
 *
 * Zone.lua:318-330. `rng.range(1, list.total)` and then the first entry whose
 * cumulative weight reaches it. ONE DRAW, whatever the list length, which is
 * why the label matters more than the count: adding a candidate changes the
 * result for a seed but not the number of draws taken.
 *
 * An empty list consumes NO DRAW — the early return is before `rng.int`. That
 * is deliberate and it is the one place this function could silently desync a
 * replay if it were written the other way round, because "no ego was eligible"
 * is a content-dependent condition.
 */
export function pickEntity<T>(rng: Rng, label: string, list: RarityList<T>): T | undefined {
  if (list.entries.length === 0 || list.total <= 0) return undefined;
  const roll = rng.int(label, 1, list.total);
  for (const entry of list.entries) {
    if (roll <= entry.genprob) return entry.e;
  }
  // Unreachable: `roll <= total` and the last entry's cumulative IS `total`.
  // Returned rather than thrown because a content edit is not worth a crash on
  // a live floor, and the caller's "nothing was eligible" path already exists.
  return undefined;
}

/**
 * What share of the list one candidate holds, as a percentage. Zone.lua:250-256
 * prints exactly this and it is the only readable way to check a roster by eye.
 *
 * DIAGNOSTICS AND TESTS ONLY. Never on a drop path — it allocates and it is not
 * what `pickEntity` walks.
 */
export function rarityShare<T>(list: RarityList<T>): readonly { e: T; percent: number }[] {
  let prev = 0;
  const out: { e: T; percent: number }[] = [];
  for (const entry of list.entries) {
    out.push({ e: entry.e, percent: (100 * (entry.genprob - prev)) / list.total });
    prev = entry.genprob;
  }
  return out;
}
