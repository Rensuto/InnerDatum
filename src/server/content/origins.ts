// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from
//   t-engine4 game/modules/tome/data/birth/races/human.lua:85-140 (the two human subraces —
//              "Higher" `inc_stats = {str=1, mag=1, dex=1, wil=1}`, `experience = 1.15`,
//              `life_rating = 11`; "Cornac" no stat modifiers, `experience = 1.0`,
//              `life_rating = 10`, `copy_add = {unused_talents_types=1, unused_talents=1,
//              unused_generics=1}`)
//   t-engine4 game/modules/tome/data/birth/classes/warrior.lua:116-182 (Bulwark `life_rating = 6`)
//   t-engine4 game/modules/tome/data/birth/classes/mage.lua:59-130 (Alchemist `life_rating = -1`)
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" — https://te4.org/license

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ORIGINS — what you were before the Inner realm, and ToME's `race` descriptor.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ToME's birther asks two questions and we have only ever asked one.
 * `Birther.lua` puts a RACE list beside the class list, and every number a
 * character starts with is the sum of the two answers. This is the other half.
 *
 * ═══ WHY THESE TWO AND NOT A BESTIARY OF FANTASY RACES ═══
 * Upstream ships nine races, and halflings in a city of clerks and evidence
 * lockers would be somebody else's game. What ports is the SYSTEM and the
 * TUNING, exactly as it did for the classes: ours are the Watchman and the
 * Inspector rather than the Bulwark and the Archer, and their numbers are
 * upstream's matched by role.
 *
 * So these two are `human.lua`'s two subraces — the only pair upstream offers to
 * a first-time player, and the choice it has spent fifteen years balancing:
 *
 *   CORNAC  — no stat modifiers, no experience penalty, and a THIRD more points
 *             to spend. The adaptable one. → `Cityborn`.
 *   HIGHER  — better raw stats and a tougher body, learning 15% slower for it.
 *             The touched one. → `The Indexed`.
 *
 * A third origin is a data entry in this file and nothing else. The system does
 * not care how many there are.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE TEN THAT WAS ALREADY HERE. Read this before touching `lifeRating`.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * In ToME `life_rating` is a RACE number that the class adjusts, and our
 * `ClassDef.lifeRating` has been carrying the sum of both since the day it was
 * written. Measured, not assumed:
 *
 *   Watchman  16  =  Bulwark    6  + Cornac 10
 *   Inspector 10  =  Archer     0  + Cornac 10   (archer declares none)
 *   Alchemist  9  =  Alchemist -1  + Cornac 10
 *
 * Three classes, three exact matches. `ClassDef.lifeRating`'s own docblock says
 * *"OURS ARE UPSTREAM'S, matched by role rather than invented"* — and whoever
 * matched them took the whole number off a Cornac character sheet, which is
 * where those numbers are printed. The race's contribution has been in this
 * codebase all along as a constant 10 nobody had a name for.
 *
 * SO THIS IS A SPLIT, NOT AN ADDITION. `ClassDef.lifeRating` now means what it
 * says — the class's own contribution — and the ten moved here where it came
 * from. A Cityborn Watchman's total is 6 + 10 = 16, the number it has always
 * been, so no existing character's hit points move by a point.
 */

/** ToME's `life_rating` for a Cornac (`human.lua:137`). See the header. */
export const BASELINE_LIFE_RATING = 10;

import { STAT_BASE } from '../engine/derived.ts';
import type { PrimaryStats } from '../engine/derived.ts';
import type { CombatSheet } from '../engine/combat.ts';

export type OriginDef = {
  /** The authored id. What a `choose_class` frame names and a save holds. */
  readonly id: string;
  /** "Cityborn". Display name, as the fiction spells it. */
  readonly name: string;
  /** Two or three sentences of identity, in `ClassDef.description`'s voice. */
  readonly description: string;
  /**
   * ToME's `inc_stats` — added to the class's own starting stats, never
   * replacing them. Absent keys are zero, which is what Cornac's whole table is.
   */
  readonly statMods: PrimaryStats;
  /**
   * The ORIGIN's half of the life rating, summed with `ClassDef.lifeRating`.
   * See the header for why this is a split rather than a new number.
   */
  readonly lifeRating: number;
  /**
   * ToME's `experience` multiplier: 1.15 means every level costs 15% more.
   * THE COUNTERWEIGHT, and the only thing that stops better stats being a free
   * lunch — upstream prices raw power in time, not in a drawback you can build
   * around.
   */
  readonly experienceMult: number;
  /**
   * Cornac's `copy_add` (`human.lua:128-132`): one extra category point, one
   * class point and one generic point AT BIRTH — and, per its own description,
   * again every ten levels.
   *
   * ALL THREE OR NONE, because upstream grants them as one block and the block
   * IS the identity: *"Humans are an inherently very adaptable race and as such
   * they gain a talent category point (others only gain one at levels 10, 20 and
   * 36) and both a class and a generic talent point at birth and every 10
   * levels."* `CATEGORY_POINT_LEVELS` already holds that 10/20/36, ported before
   * anything read it against a race.
   */
  readonly adaptable: boolean;
};

/**
 * CORNAC. The one with nothing special about it, which is the point of it: no
 * modifiers, no penalty, and a third more points than anyone else to spend on
 * whatever you turn out to want.
 */
export const CITYBORN: OriginDef = Object.freeze({
  id: 'origin_cityborn',
  name: 'Cityborn',
  description:
    'Raised in the Common realm, on a street with a name and a number. ' +
    'Nothing marked you out and nothing was decided for you. ' +
    'You learn fast, and you learn whatever the work turns out to need.',
  // `human.lua:122-123` — "+0 Strength, +0 Dexterity, +0 Constitution, +0 Magic,
  // +0 Willpower, +0 Cunning". Written as an empty table rather than six zeroes,
  // which is what upstream does too: Cornac declares no `inc_stats` at all.
  statMods: {},
  lifeRating: BASELINE_LIFE_RATING,
  // `experience = 1.0` (human.lua:127). No penalty, and the only origin so far
  // that pays nothing for what it gets.
  experienceMult: 1.0,
  adaptable: true,
});

/**
 * HIGHER. Better raw material, slower to learn, and a body that takes one more
 * point of punishment per level.
 */
export const INDEXED: OriginDef = Object.freeze({
  id: 'origin_indexed',
  name: 'The Indexed',
  description:
    'Someone wrote you down before you ever went looking. ' +
    'You are already in the record, cross-referenced and cited, and it shows — ' +
    'in the hands, in the reach, in what you can make the air do. ' +
    'It also means a part of you is not yours, and that part learns nothing.',
  // `inc_stats = { str=1, mag=1, dex=1, wil=1 }` (human.lua:96). VERBATIM,
  // including the two it leaves out: Constitution and Cunning are NOT raised,
  // which is why this is not simply a better body.
  statMods: { str: 1, dex: 1, mag: 1, wil: 1 },
  // `life_rating = 11` (human.lua:106), one over the baseline — and
  // one per level, compounding, which is what a life rating is.
  lifeRating: BASELINE_LIFE_RATING + 1,
  // `experience = 1.15` (human.lua:97). Fifteen per cent, and it is the whole
  // counterweight — see `OriginDef.experienceMult`.
  experienceMult: 1.15,
  adaptable: false,
});

/**
 * AUTHORED ORDER, and the picker never re-sorts it — the same promise
 * `ClassOptionsMsg.options` makes and for the same reason: this choice is
 * written to a file and the chooser does not come back.
 */
export const ORIGINS: readonly OriginDef[] = Object.freeze([CITYBORN, INDEXED]);

const BY_ID = new Map<string, OriginDef>(ORIGINS.map((origin) => [origin.id, origin]));

export function originById(id: string): OriginDef | undefined {
  return BY_ID.get(id);
}

/**
 * WHAT A BODY WITH NO ORIGIN RECORDED IS.
 *
 * Every character made before origins existed was built against a life rating
 * that already had Cornac's ten inside it (see the header), so `Cityborn` is not
 * a default chosen for tidiness — it is the origin those characters have always
 * actually had. Reading it back is what keeps their hit points identical.
 */
export const DEFAULT_ORIGIN: OriginDef = CITYBORN;

/** The origin a body holds, or the baseline when it holds none. */
export function originOf(id: string | undefined): OriginDef {
  return id === undefined ? DEFAULT_ORIGIN : (originById(id) ?? DEFAULT_ORIGIN);
}

/**
 * THE ORIGIN'S CONTRIBUTION TO THE LIFE RATING, AS A DELTA.
 *
 * `ClassDef.lifeRating` already carries the baseline ten (see the header), so an
 * origin adds only its DIFFERENCE from that baseline: Cityborn 0, Indexed +1.
 *
 * WRITTEN AS A DELTA RATHER THAN SPLITTING EVERY `ClassDef`, and that is a
 * judgement rather than laziness. The split would move four authored numbers,
 * the four comments citing them ("Bulwark 16 — he is the one standing in the
 * doorway") and every test pinning a hit-point total — to arrive at arithmetic
 * identical to this line. The header records what those numbers are actually
 * made of, which is the part that was worth discovering.
 */
export function originLifeDelta(origin: OriginDef): number {
  return origin.lifeRating - BASELINE_LIFE_RATING;
}

/**
 * THE CLASS SHEET WITH THE ORIGIN'S `inc_stats` ADDED.
 *
 * ADDED, NEVER REPLACING — upstream applies `inc_stats` on top of whatever the
 * class starts with, because a body is the sum of the two answers the birther
 * asked for.
 *
 * IT RETURNS THE SHEET BY IDENTITY WHEN THERE IS NOTHING TO ADD, which is not an
 * optimisation. `world.ts` records that a body wearing nothing "gets the
 * overlay's sheet by identity, not a copy, which is what keeps 'the class was
 * applied WHOLESALE, never blended' assertable with `toBe`". Cityborn declares
 * no modifiers at all, so that assertion goes on holding for the origin every
 * existing character has.
 */
export function combatWithOrigin(base: CombatSheet, origin: OriginDef): CombatSheet {
  const mods = Object.entries(origin.statMods).filter(([, value]) => value !== 0);
  if (mods.length === 0) return base;

  const stats: Record<string, number> = { ...(base.stats ?? {}) };
  for (const [key, value] of mods) {
    // STAT_BASE IS TEN, NOT ZERO, and `composeWielders` states what forgetting
    // it costs: "the naive version hands a Watchman a ring and takes seven
    // points of Strength off him". A class that authored no table starts every
    // stat at the base rather than at nothing.
    stats[key] = (stats[key] ?? STAT_BASE) + value;
  }
  return { ...base, stats };
}
