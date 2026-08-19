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

import { CLASSES } from '../../src/server/content/classes.ts';
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
    const talents = CLASSES.flatMap((definition) => definition.loadout);
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
