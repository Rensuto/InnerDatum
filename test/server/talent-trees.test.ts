// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A TALENT'S TREE IS A SOFT REFERENCE, SO SOMETHING HAS TO CHECK IT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `Talent.tree` is a plain string rather than a union of the authored ids, for
 * the reason `classId` is: adding a tree should be a content edit, not a change
 * to the engine's types. The cost of that choice is that a typo compiles — and a
 * talent pointing at a tree nobody authored would simply stop appearing under
 * any header, which reads to a player as a talent that is missing rather than as
 * a mistake in a table.
 *
 * This is the check that makes the soft reference safe, and it is the same shape
 * as the one `assets.test.ts` runs over sprite ids.
 */

import { describe, expect, it } from 'vitest';

import { CLASSES, allTalents } from '../../src/server/content/classes.ts';
import { TALENT_TREES, treeById, treesFor } from '../../src/server/content/talent-trees.ts';
import { TalentKind } from '../../src/server/engine/talents.ts';

describe('every talent belongs to a tree that exists', () => {
  it('names a real tree', () => {
    const orphans: string[] = [];
    for (const definition of CLASSES) {
      for (const talent of definition.loadout) {
        if (treeById(talent.tree) === undefined) orphans.push(`${talent.id} -> ${talent.tree}`);
      }
    }
    expect(orphans).toEqual([]);
  });

  it('names a tree belonging to its OWN class', () => {
    // A Watchman talent filed under an Inspector tree would draw under a header
    // the player can never see, which is the same disappearance as a typo and
    // harder to spot because the id resolves.
    const wrong: string[] = [];
    for (const definition of CLASSES) {
      for (const talent of definition.loadout) {
        const tree = treeById(talent.tree);
        if (tree !== undefined && tree.classId !== definition.id) {
          wrong.push(`${talent.id}: ${tree.id} is ${tree.classId}, not ${definition.id}`);
        }
      }
    }
    expect(wrong).toEqual([]);
  });

  it('gives every class at least two trees, which is the point of having any', () => {
    // One tree per class is the flat list with a heading over it. Two is the
    // smallest number that makes a spent point a spent DIRECTION.
    for (const definition of CLASSES) {
      expect(treesFor(definition.id).length, definition.id).toBeGreaterThanOrEqual(2);
    }
  });

  it('leaves no tree empty', () => {
    // A header with nothing under it is worse than no header: it reads as
    // content that failed to load.
    // EVERY talent, not every loadout: `generic/groundwork` holds only passives
    // (see the mixed-kind test below for why that is allowed), so reading the
    // loadouts alone reported a full tree as empty.
    const talents = allTalents();
    for (const tree of TALENT_TREES) {
      expect(
        talents.some((talent) => talent.tree === tree.id),
        `${tree.id} has no talents`,
      ).toBe(true);
    }
  });

  it('declares a kind for every talent', () => {
    const kinds = new Set<string>(Object.values(TalentKind));
    for (const definition of CLASSES) {
      for (const talent of definition.loadout) {
        expect(kinds.has(talent.kind), `${talent.id}: ${talent.kind}`).toBe(true);
      }
    }
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * EVERY CATEGORY HOLDS EXACTLY FIVE, BECAUSE THE GRID DRAWS EXACTLY FIVE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `ui/talents.ts` lays a category out as `CELLS_PER_CAT` icons on one row, and
 * it does that by SLICING: `row.talents[n]` for n < 5. A sixth talent in a tree
 * would type-check, register, reach the wire, cost a point to buy — and never
 * appear on screen. There is no error and nothing logs.
 *
 * ToME's own screen is the reason the number is five (LevelupDialog's category
 * blocks, and the screenshot this grid was built from), so the fix for a sixth
 * talent is a second row or a second tree, never a wider one.
 *
 * FIVE EXACTLY, NOT AT MOST FIVE. A tree with four draws a gap in a row of
 * boxes, which reads as a talent that failed to load rather than as a tree with
 * room in it — and three of the six trees looked like that until the second
 * wave of passives filled them.
 */
describe('the tree grid is full', () => {
  // Mirrors `ui/talents.ts`. Raised 5 -> 6 when a sixth active landed in every
  // tree; the grid slices at this number and drops the rest without a word.
  const CELLS_PER_CAT = 6;

  /** Every talent a class ships, actives and passives together, by tree. */
  function byTree(): Map<string, string[]> {
    const out = new Map<string, string[]>();
    // `allTalents()`, NOT `CLASSES.flatMap` — `generic/groundwork` is owned by no
    // class, so walking the class definitions reports it as an empty tree.
    for (const talent of allTalents()) {
      const list = out.get(talent.tree) ?? [];
      list.push(talent.id);
      out.set(talent.tree, list);
    }
    return out;
  }

  it('gives every tree exactly six talents', () => {
    const counts = byTree();
    const wrong: string[] = [];
    for (const tree of TALENT_TREES) {
      const held = counts.get(tree.id) ?? [];
      if (held.length !== CELLS_PER_CAT) {
        wrong.push(`${tree.id}: ${String(held.length)} (${held.join(', ')})`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('leaves no tree empty, which the previous test would also catch', () => {
    // Kept separate because it fails with a far more obvious message when a
    // tree id is renamed on one side of the join only.
    for (const tree of TALENT_TREES) {
      expect(byTree().get(tree.id), tree.id).toBeDefined();
    }
  });

  it('mixes actives and passives in every CLASS tree', () => {
    // A tree of six passives is a stat block and a tree of six actives is a
    // hotbar; ToME's class categories are neither. This is the shape assertion,
    // and it is what stops the next wave of content from being all of one kind.
    //
    // ═══ A GENERIC TREE IS EXEMPT, AND THE EXEMPTION IS EVIDENCE-BACKED ═══
    // `technique/combat-training` is the category every ToME character carries,
    // and all SEVEN of its talents are `mode = "passive"` — zero actives, which
    // is checkable in one grep of combat-training.lua. That is what a training
    // category IS: the things that are true of a body rather than of a
    // profession, and none of them is a button. Applying the class rule to it
    // would force an active into it for the sake of the rule.
    //
    // It also could not have one today: an active needs a hotbar slot, and
    // `HOTBAR_TALENT_SLOTS` is exactly full at six.
    for (const tree of TALENT_TREES.filter((candidate) => candidate.classId !== null)) {
      const held = allTalents().filter((talent) => talent.tree === tree.id);
      const passives = held.filter((talent) => talent.kind === TalentKind.Passive);
      expect(passives.length, `${tree.id} passives`).toBeGreaterThan(0);
      expect(passives.length, `${tree.id} all-passive`).toBeLessThan(held.length);
    }
  });
});
