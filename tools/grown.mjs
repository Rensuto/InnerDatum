// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
//
// ═══════════════════════════════════════════════════════════════════════════
// A PROBE BODY THAT SOMEBODY COULD ACTUALLY BE.
// ═══════════════════════════════════════════════════════════════════════════
//
// Every difficulty probe in this directory builds its character the same way —
// `addPlayer`, `p.combat = cls.combat`, `sheetForClass(cls)` — and that body is
// LEVEL 1, WEARING NOTHING, with four birth talents at rank 1. For the opening
// ambush that is exactly right: the gateway's own note records that "A NEW
// CHARACTER WEARS NOTHING ... the classes have no starting kit at all", so a
// naked level-1 body is the honest measurement of the first fight.
//
// It is the WRONG body for everything after it. `delve-run.mjs` sends that
// character into all sixteen delves and reports 0 of 8 on every row — including
// the deepest, which a real party reaches after twenty levels and a lot of
// gear. A number measured against a character nobody has ever played is not a
// difficulty measurement; it is a measurement of the probe.
//
// ═══ WHAT IT DOES AND WHAT IT DELIBERATELY DOES NOT ═══
//
// It grows the two things the server would have grown by the time a player got
// there — STATS and HIT POINTS — and spends the talent points that came with
// them. It does NOT invent a levelling path: `spreadStatPoints` is the same
// round-robin `monsters.ts` uses for `autoStats`, so the character is the
// straightforward build rather than an optimised one, and that is the honest
// baseline for "is this room fair".
//
// GEAR IS ROLLED FROM THE GAME'S OWN TABLE, never authored here. `rollLoot` is
// what the floor uses, so a grown body wears what the floor would have given it
// by that level — which is the whole point, and is why this takes an `Rng`
// rather than picking the best of everything.

import {
  spreadStatPoints,
  statPointsGainedTo,
  maxLifeFor,
  PLAYER_RANK,
} from '../src/shared/leveling.ts';
import { pointsForLevel } from '../src/shared/progression.ts';
import { rollLoot, bandFor } from '../src/server/content/loot.ts';
import { ITEMS } from '../src/server/content/items.ts';
import { resolveItem } from '../src/server/content/resolve.ts';
import { SLOT_ORDER } from '../src/shared/protocol.ts';

/**
 * WHICH STATS A CLASS GROWS INTO, in the order it grows them.
 *
 * DERIVED FROM THE CLASS RATHER THAN LISTED, so a fourth class needs no edit
 * here and a rebalance of an existing one cannot leave this table stale: the
 * order is simply the class's own sheet, biggest first. A Watchman built around
 * Strength grows Strength; an Alchemist grows Magic. That is what a player does
 * without thinking about it, and a hand-written table would be a second opinion
 * about what each class is for.
 */
function growthOrder(cls) {
  const stats = cls.combat?.stats ?? {};
  return Object.keys(stats)
    .filter((key) => (stats[key] ?? 0) > 0)
    .sort((a, b) => (stats[b] ?? 0) - (stats[a] ?? 0));
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * GROW A BODY TO `level`, the way the server would have.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * THE ORDER IS LOAD-BEARING AND IS `monsters.ts`'s: stats FIRST, then the pool,
 * because `maxLifeFor` pays for Constitution ABOVE the class's own and a pool
 * sized before the stats exist cannot include it. That file records the same
 * thing as a bug it once had — *"THIS USED TO COME AFTER `maxHp`, AND THE ORDER
 * WAS THE BUG"*.
 *
 * Returns the body, so a caller can chain.
 */
export function growTo(body, cls, level) {
  if (level <= 1) return body;
  body.level = level;

  const base = cls.combat?.stats ?? {};
  const grown = spreadStatPoints(base, growthOrder(cls), statPointsGainedTo(level, PLAYER_RANK));
  // BOTH SHEETS, because they are two different questions and the engine reads
  // both: `baseCombat` is what a swap comparison measures against and what
  // `recomposeCombat` folds gear onto; `combat` is the live sheet.
  body.baseCombat = { ...cls.combat, stats: grown };
  body.combat = { ...cls.combat, stats: grown };

  // AND THE POOL THE STATS JUST EARNED. `conAbove` is exactly what
  // `engine/pools.ts#maxLifeOf` passes — the Constitution over the class's own.
  const conAbove = (grown['con'] ?? 0) - (base['con'] ?? 0);
  body.maxHp = maxLifeFor(cls.maxHp, cls.lifeRating, level, PLAYER_RANK, conAbove);
  body.hp = body.maxHp;
  return body;
}

/**
 * THE TALENT POINTS THAT CAME WITH THOSE LEVELS, spent down the loadout.
 *
 * ROUND-ROBIN ACROSS THE CLASS'S OWN TALENTS, capped at `TALENT_MAX_LEVEL` by
 * the sheet itself. Like the stat spread this is the straightforward build
 * rather than a good one — a probe that measured an optimised character would
 * be answering a question no first-time player is asking.
 *
 * `points` is a Map on the sheet and rank 1 is what `NotLearned` tests, so this
 * writes the same field `spend_point` does.
 */
export function spendPointsTo(sheet, cls, level, maxRank = 5) {
  let budget = 0;
  for (let l = 2; l <= level; l += 1) budget += pointsForLevel(l);
  const ids = (cls.loadout ?? []).map((t) => t.id);
  if (ids.length === 0 || budget <= 0) return sheet;

  let i = 0;
  let guard = 0;
  while (budget > 0 && guard < budget + ids.length * maxRank + 1) {
    const id = ids[i % ids.length];
    i += 1;
    guard += 1;
    if (id === undefined) continue;
    const at = sheet.points.get(id) ?? 0;
    if (at >= maxRank) continue;
    sheet.points.set(id, at + 1);
    budget -= 1;
  }
  return sheet;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * DRESS A BODY IN WHAT THE FLOOR WOULD HAVE GIVEN IT BY NOW.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ONE ROLL PER SLOT, through `rollLoot` — the same function the delve litter and
 * a monster's drop both use — at the band this level actually sees. So the
 * character wears the game's own idea of level-`n` gear, egos and all, rather
 * than a hand-picked set that would flatter the numbers.
 *
 * SEEDED, and the caller supplies the rng: two runs of one seed must dress the
 * same character, or the difficulty table stops being comparable with itself.
 *
 * A SLOT WITH NO BASE IN THE CATALOGUE IS LEFT EMPTY rather than filled with
 * something from another slot — `validateItems` guarantees every slot has at
 * least one item today, and if that ever stops being true a bare shoulder is a
 * better answer than a coat worn on the head.
 */
export function dressFor(body, level, rng) {
  const worn = {};
  for (const slot of SLOT_ORDER) {
    const bases = ITEMS.filter((item) => item.slot === slot);
    if (bases.length === 0) continue;
    const base = bases[rng.int(`grown.dress.${slot}`, 0, bases.length - 1)];
    if (base === undefined) continue;
    // THE BASE'S ID, NOT THE ROW: `rollLoot` takes a catalogue id and returns
    // one with any ego folded in, exactly as `delve.ts`'s litter does.
    const rolled = rollLoot(rng.fork(`grown.dress.roll.${slot}`), base.id, level);
    // RESOLVED BEFORE IT IS WORN, so an id the catalogue cannot answer for never
    // reaches the doll — the same check `handleEquip` makes.
    if (resolveItem(rolled) === undefined) continue;
    worn[slot] = rolled;
  }
  body.equipped = worn;
  return body;
}

/** The loot band this level sees, exported so a probe can print what it dressed at. */
export function bandAt(level) {
  return bandFor(level);
}
