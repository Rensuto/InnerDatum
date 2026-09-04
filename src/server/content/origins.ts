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
import { higherHeal } from '../talents/higher_heal.ts';
import { highbornsBloom } from '../talents/highborns_bloom.ts';
import { resilienceOfTheArchived } from '../talents/resilience_of_the_archived.ts';
import { unshackled } from '../talents/unshackled.ts';
import { wrathOfTheWoods } from '../talents/wrath_of_the_woods.ts';
import { luckOfTheFootnoted } from '../talents/luck_of_the_footnoted.ts';
import { overseerOfNations } from '../talents/overseer_of_nations.ts';
import type { Talent } from '../engine/talents.ts';
import type { PointBonus } from '../../shared/progression.ts';
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
   * ═══ WHAT THIS ORIGIN IS HANDED AT BIRTH — `copy_add` (human.lua:128-132) ═══
   *
   *     copy_add = { unused_talents_types = 1, unused_talents = 1, unused_generics = 1 }
   *
   * Keyed by OUR purse names rather than upstream's so the grant is a 1:1 read
   * with no translation table in between: `points` is `unspentPoints`,
   * `generics` is `unspentGenerics`, `categories` is `unspentCategories`.
   */
  readonly birthPoints?: {
    readonly points?: number;
    readonly generics?: number;
    readonly categories?: number;
  };
  /**
   * ═══ AND ONE MORE OF EACH EVERY N LEVELS — Actor.lua:3485-3486 ═══
   * `extra_talent_point_every` / `extra_generic_point_every`, which Cornac sets
   * to 10 (`human.lua:142-143`).
   *
   * A PERIOD RATHER THAN A FLAG, because that is what upstream stores. This
   * field replaced a boolean called `adaptable` that nothing ever read: the
   * boolean could only ever express Cornac, and the number expresses the
   * mechanism. See `PointBonus`.
   *
   * IT DRIVES BOTH PURSES TOGETHER, because upstream's two fields are set
   * together everywhere they are set at all, and the description sells them as
   * one thing: *"both a class and a generic talent point at birth and every 10
   * levels"*.
   */
  readonly extraPointEvery?: number;
  /**
   * ═══ WHAT THIS ORIGIN CAN DO THAT NO CLASS TEACHES — `talents = { … }` ═══
   *
   *     talents = { [ActorTalents.T_HIGHER_HEAL] = 1 },   -- human.lua:99-101
   *
   * GRANTED AT RANK 1, exactly as an inscription is, and by the same route: the
   * sheet joins these onto `loadout` AND onto `birth`, so the button arrives
   * pressable rather than merely present. `membership-is-not-a-rank` was learned
   * the hard way on the inscriptions and this list is wired the same way from
   * the start.
   *
   * SEPARATE FROM THE TREE upstream grants alongside it (`talents_types`), which
   * is four more talents and is not ported — `higher_heal.ts` says why.
   */
  readonly talents?: readonly Talent[];
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
  // `copy_add` (human.lua:128-132) and `extra_*_point_every` (human.lua:142-143).
  // THE WHOLE IDENTITY OF THIS ORIGIN: no modifiers, no penalty, and a third
  // more points than anybody else to spend on whatever the work turns out to
  // need. The category point is the loudest of the three — a whole discipline,
  // when everyone else waits until level 10 for their first.
  birthPoints: { points: 1, generics: 1, categories: 1 },
  extraPointEvery: 10,
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
  // Higher declares no `copy_add` and no `extra_*_every`: it pays for its stats
  // in experience, not in points. Both fields absent rather than zeroed, which
  // is the same choice `statMods: {}` makes one origin up.
  //
  // WHAT IT HAS INSTEAD: `talents = { [T_HIGHER_HEAL] = 1 }` (human.lua:99-101).
  talents: [higherHeal, overseerOfNations, highbornsBloom],
});

/**
 * DWARF. The sturdiest body in the game, the slowest to learn anything, and the
 * only one that can make itself harder on demand.
 */
export const ARCHIVED: OriginDef = Object.freeze({
  id: 'origin_archived',
  name: 'The Archived',
  description:
    'You were filed, sealed and left somewhere deep, and you kept. ' +
    'Whatever the record wanted you for, it did not want you changed — ' +
    'so you came out of storage thicker in the arm and harder to amend than anything ' +
    'that stayed in circulation. Nothing down there taught you anything, and it shows.',
  // `inc_stats = { str=4, con=3, wil=3, mag=-2, dex=-2 }` (dwarf.lua:71).
  // VERBATIM, INCLUDING THE TWO NEGATIVES, which are the whole shape of the
  // origin: this is the first origin in the game that takes a stat AWAY, and a
  // build that wanted Dexterity or Magic should feel that it chose wrong.
  statMods: { str: 4, dex: -2, con: 3, mag: -2, wil: 3 },
  // `life_rating = 12` (dwarf.lua:80), two over the baseline — the largest life
  // delta of any origin, and it compounds every level.
  lifeRating: BASELINE_LIFE_RATING + 2,
  // `experience = 1.25` (dwarf.lua:87). THE STEEPEST PENALTY SO FAR: a quarter
  // more experience for every level, against the Indexed's fifteen per cent.
  // That is the counterweight for +10 raw stat points and the life rating.
  experienceMult: 1.25,
  // No `copy_add`, no `extra_*_every` — same as the Indexed, and see the note
  // there. What it has instead: `talents = { [T_DWARF_RESILIENCE] = 1 }`
  // (dwarf.lua:74-76).
  //
  // ONE TALENT WHERE THE INDEXED HAVE THREE, and that is not an oversight or a
  // half-finished tree. `race/dwarf` has four upstream and the other three each
  // need machinery this game does not have: Stoneskin wants an on-melee-hit
  // trigger that can cancel the blow outright, Power is Money scales saves off
  // carried gold, and Stone Walking phases through a wall. Each is a system, not
  // a number, so the origin ships with the one that is a pure content port and
  // the rest are named here rather than silently missing.
  talents: [resilienceOfTheArchived],
});

/**
 * THALORE. Quick and hard to pin down, hopeless with anything written, and the
 * slowest learner in the game by a long way.
 */
export const UNFILED: OriginDef = Object.freeze({
  id: 'origin_unfiled',
  name: 'The Unfiled',
  description:
    'Nobody ever took your details. You grew up outside the index, in the parts of the ' +
    'moor where the record thins out and then stops, and you learned what those places ' +
    'teach — to move first and to be very hard to hold. What you did not learn is ' +
    'anything the record could have told you, and every lesson since has cost you double.',
  // `inc_stats = { str=2, mag=-2, wil=1, cun=0, dex=3, con=1 }` (elf.lua). THE
  // LUA TABLE, NOT THE BLURB BESIDE IT: upstream's own description lists only
  // "+2 Strength, +3 Dexterity, +1 Constitution" and omits both the Willpower
  // and the Magic penalty. CLAUDE.md's rule — when the docs and the Lua
  // disagree, the Lua wins — applies to ToME's own docs too.
  //
  // `cun = 0` is dropped rather than written: upstream states it to be explicit
  // in a table where absence and zero are the same thing, and ours would put a
  // zero on the character sheet that means nothing.
  statMods: { str: 2, dex: 3, con: 1, mag: -2, wil: 1 },
  // `life_rating = 11` (elf.lua), one over the baseline — the same body as the
  // Indexed, reached from the other direction.
  lifeRating: BASELINE_LIFE_RATING + 1,
  // `experience = 1.35` (elf.lua). THE STEEPEST PENALTY IN THE GAME: a third
  // again for every level, against the Archived's quarter and the Indexed's
  // fifteen per cent. Upstream charges it for the speed.
  experienceMult: 1.35,
  // No `copy_add`, no `extra_*_every` — see the note on the Indexed.
  // `talents = { [T_THALOREN_WRATH] = 1 }` (elf.lua).
  //
  // TWO TALENTS, the most of any origin but the Indexed, and the tree entry
  // names the two that are missing with the system each would need.
  talents: [wrathOfTheWoods, unshackled],
});

/**
 * HALFLING. Quick, sharp, physically slight, and briefly luckier than anyone
 * has any right to be.
 */
export const FOOTNOTED: OriginDef = Object.freeze({
  id: 'origin_footnoted',
  name: 'The Footnoted',
  description:
    'You are in the record, at the bottom, in the smaller type. ' +
    'Nobody reads down that far and you have made a life out of it — quick hands, ' +
    'quicker eyes, and a habit of being where the entry above is not looking. ' +
    'You are not built to take a hit. You are built to have already moved.',
  // `inc_stats = { str=-3, dex=3, con=1, cun=3, lck=5 }` (halfling.lua).
  //
  // ═══ `lck = 5` IS DROPPED, AND IT IS A REAL LOSS RATHER THAN A ROUNDING ═══
  // There is no Luck stat in this game. Upstream's halfling is the luckiest
  // thing in it and spends that on crit, on defence and on its own tier-2
  // talent; ours gets none of it and still pays the twenty per cent. Said out
  // loud rather than quietly compensated for — inventing a substitute bonus
  // would be a balance decision wearing a port's citation.
  statMods: { str: -3, dex: 3, con: 1, cun: 3 },
  // `life_rating = 12` (halfling.lua), two over the baseline — tied with the
  // Archived for the sturdiest, which reads oddly for the smallest people in
  // the game and is upstream's number.
  lifeRating: BASELINE_LIFE_RATING + 2,
  // `experience = 1.20` (halfling.lua). Between the Indexed's fifteen and the
  // Archived's twenty-five.
  experienceMult: 1.2,
  // No `copy_add`, no `extra_*_every` — see the note on the Indexed.
  // `talents = { [T_HALFLING_LUCK] = 1 }` (halfling.lua).
  talents: [luckOfTheFootnoted],
});

/**
 * AUTHORED ORDER, and the picker never re-sorts it — the same promise
 * `ClassOptionsMsg.options` makes and for the same reason: this choice is
 * written to a file and the chooser does not come back.
 */
export const ORIGINS: readonly OriginDef[] = Object.freeze([
  CITYBORN,
  INDEXED,
  ARCHIVED,
  UNFILED,
  FOOTNOTED,
]);

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

/**
 * THE ORIGIN'S CLASS-POINT BONUS, in the shape `src/shared/progression.ts` takes.
 *
 * THREE TINY FUNCTIONS RATHER THAN ONE THAT RETURNS THREE, because every caller
 * wants exactly one purse and a caller that reached for the wrong field of a
 * combined object would be spending the wrong currency — which is a bug no test
 * catches, because both numbers are 1.
 */
export function classPointBonus(origin: OriginDef): PointBonus {
  return { every: origin.extraPointEvery, atBirth: origin.birthPoints?.points };
}

/** The generic-point bonus. Upstream drives both purses off the same period. */
export function genericPointBonus(origin: OriginDef): PointBonus {
  return { every: origin.extraPointEvery, atBirth: origin.birthPoints?.generics };
}

/**
 * The category points granted at birth. A BARE NUMBER, not a `PointBonus`, and
 * the asymmetry is upstream's: there is no `extra_category_point_every`.
 */
export function birthCategoryPoints(origin: OriginDef): number {
  return origin.birthPoints?.categories ?? 0;
}

/**
 * THE TALENTS AN ORIGIN GRANTS, or an empty list.
 *
 * A FUNCTION RATHER THAN A FIELD READ, so every caller goes through one place
 * and the absent case is answered once. `talentsFor` in `content/inscriptions.ts`
 * is the same shape for the same reason.
 */
export function originTalents(origin: OriginDef): readonly Talent[] {
  return origin.talents ?? [];
}

/** Every talent any origin can grant — what the registry must know about. */
export const ORIGIN_TALENTS: readonly Talent[] = Object.freeze(
  ORIGINS.flatMap((origin) => origin.talents ?? []),
);
