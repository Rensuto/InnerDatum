// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// SHAPE: t-engine4 game/modules/tome/data/talents.lua — `newTalentType{ type =
//        "technique/weapon-shield", name = "weapon and shield", ... }`
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" — https://te4.org/license

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * TALENT TREES — WHAT ToME CALLS A TALENT TYPE, AND WE HAD NONE OF.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * PLAN.md § 5 caps the MVP at *3 classes / 12 talents / 0 trees* and names the
 * v1.0 ceiling in the same line: *4 / 32 / 8 / per-level*. Twelve talents in one
 * flat list per class is exactly what shipped, and the zero is the part a player
 * feels — `classes.ts` says it outright: *"Below ~15 talents per class the
 * build-crafting evaporates"*. This file is the first half of closing that,
 * asked for directly: a tree structure like Tales of Maj'Eyal's.
 *
 * ═══ A TREE IS A GROUPING, NOT A GATE — YET ═══
 * ToME's talent type carries a mastery multiplier and a `points` requirement
 * that unlocks the tree itself. Neither is here, deliberately: the grouping is
 * what makes a panel readable and a build legible, and it is worth having on its
 * own before any of the arithmetic hangs off it. Adding mastery later changes
 * this table and `combatTalentScale`'s caller, and nothing else — which is the
 * property that makes shipping the grouping first safe rather than lazy.
 *
 * ═══ TWO TREES A CLASS, NOT ONE ═══
 * One tree per class would be the flat list with a heading over it. Two is the
 * smallest number that makes the panel say something a player can act on: these
 * two talents are the same idea and those two are a different one, so a point
 * spent is a point spent on a DIRECTION. The v1.0 ceiling of eight leaves room
 * for a third per class and a shared one.
 */

import { ClassId } from '../engine/talents.ts';

export { TalentKind } from '../engine/talents.ts';
export type { TalentKind as TalentKindType } from '../engine/talents.ts';

export type TalentTree = {
  /** `watch/discipline`. ToME's `type` string, and the shape is deliberate. */
  readonly id: string;
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * CATEGORY MASTERY — the "(x1.30)" a ToME player reads in the header.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * It is not decoration. `ActorTalents.lua:834` is the whole of it:
   *
   *     getTalentLevel(id) = getTalentLevelRaw(id) * (mastery)
   *
   * so a point spent in a x1.30 category is worth thirty percent more than the
   * same point in a x1.00 one, everywhere `combatTalentScale` is used. It is how
   * ToME says "this class is BETTER at this than that class is" without
   * authoring two copies of a talent.
   *
   * STORED AS THE MULTIPLIER ITSELF. Upstream keeps `value - 1` (:861 writes it,
   * :849 reads it back with `+ 1`) so that an absent entry means 1.0 — a save
   * compatibility trick we have no version of, and an offset nobody needs is a
   * subtraction somebody eventually forgets.
   *
   * EVERY TREE SHIPS AT 1.0 TODAY, deliberately: the field goes in live and
   * changes nothing, so the commit that tunes a category is a commit about
   * tuning rather than one that also introduces the machinery.
   */
  readonly mastery: number;
  /** What the panel's header says. Two words at most; it is a heading. */
  readonly name: string;
  readonly classId: ClassId;
  /** One line under the header, for why these belong together. */
  readonly blurb: string;
};

/**
 * THE SIX. Ordered per class, and the order is the panel's order — the tree a
 * player is expected to open with comes first.
 */
export const TALENT_TREES: readonly TalentTree[] = Object.freeze([
  {
    id: 'watch/discipline',
    mastery: 1,
    name: 'Discipline',
    classId: ClassId.Watchman,
    blurb: 'Hitting the thing in front of you, correctly.',
  },
  {
    id: 'watch/the-line',
    mastery: 1,
    name: 'The Line',
    classId: ClassId.Watchman,
    blurb: 'Standing where somebody else would have been hit.',
  },
  {
    id: 'index/marksmanship',
    mastery: 1,
    name: 'Marksmanship',
    classId: ClassId.Inspector,
    blurb: 'Reaching what has not reached you yet.',
  },
  {
    id: 'index/fieldcraft',
    mastery: 1,
    name: 'Fieldcraft',
    classId: ClassId.Inspector,
    blurb: 'Being somewhere else by the time it looks.',
  },
  {
    id: 'ashwick/reagents',
    mastery: 1,
    name: 'Reagents',
    classId: ClassId.Alchemist,
    blurb: 'What comes out of the bag and what it does to a room.',
  },
  {
    id: 'ashwick/ministration',
    mastery: 1,
    name: 'Ministration',
    classId: ClassId.Alchemist,
    blurb: 'Keeping the people around you upright.',
  },
]);

const BY_ID = new Map(TALENT_TREES.map((tree) => [tree.id, tree]));

/** The tree, or undefined for an id nothing authored. */
export function treeById(id: string): TalentTree | undefined {
  return BY_ID.get(id);
}

/** Every tree a class owns, in panel order. */
export function treesFor(classId: ClassId): readonly TalentTree[] {
  return TALENT_TREES.filter((tree) => tree.classId === classId);
}
