// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/modules/tome/class/Actor.lua:3757-3760 (the grant)
// and data/birth/classes/warrior.lua:134-148 (`talents_types`, open and locked).
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" — https://te4.org/license

import { describe, expect, it } from 'vitest';

import {
  ALL_LOCKED_TALENTS,
  ALCHEMIST,
  INSPECTOR,
  WATCHMAN,
  createContentTalentEngine,
  createTalentBook,
  sheetForClass,
} from '../../src/server/content/classes.ts';
import { TALENT_TREES, treeById } from '../../src/server/content/talent-trees.ts';
import { createWorld } from '../../src/server/world/world.ts';
import {
  CATEGORY_POINT_LEVELS,
  MAX_CHARACTER_LEVEL,
  categoryPointsForLevel,
  totalCategoryPointsAtLevel,
} from '../../src/shared/progression.ts';

const CLASSES = [WATCHMAN, INSPECTOR, ALCHEMIST];

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *   A THIRD CURRENCY, AND IT BUYS A WHOLE DISCIPLINE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Three category points in a fifty-level career, at 10, 20 and 36
 * (Actor.lua:3757-3760). Nothing refunds one, so every seam that spends one has
 * to refuse BEFORE it deducts — and the scarcity is the mechanic rather than a
 * balance lever: which discipline is a decision a build is made of.
 */

describe('the grant', () => {
  it('lands on exactly the three levels upstream names', () => {
    for (let level = 1; level <= MAX_CHARACTER_LEVEL; level += 1) {
      const expected = CATEGORY_POINT_LEVELS.includes(level) ? 1 : 0;
      expect(categoryPointsForLevel(level), `level ${String(level)}`).toBe(expected);
    }
  });

  it('totals three across a whole career, and never more', () => {
    // THE NUMBER THE WHOLE MECHANIC RESTS ON. A fourth point would make the
    // locked trees a shopping list; a second would make the choice trivial.
    expect(totalCategoryPointsAtLevel(MAX_CHARACTER_LEVEL)).toBe(3);
    expect(totalCategoryPointsAtLevel(1)).toBe(0);
    expect(totalCategoryPointsAtLevel(9)).toBe(0);
    expect(totalCategoryPointsAtLevel(10)).toBe(1);
    expect(totalCategoryPointsAtLevel(35)).toBe(2);
  });

  it('is monotonic, so no level ever takes one back', () => {
    let last = 0;
    for (let level = 1; level <= MAX_CHARACTER_LEVEL; level += 1) {
      const now = totalCategoryPointsAtLevel(level);
      expect(now, `level ${String(level)}`).toBeGreaterThanOrEqual(last);
      last = now;
    }
  });
});

describe('what a point buys', () => {
  const locked = TALENT_TREES.filter((tree) => tree.locked === true);

  it('there is something to buy at all', () => {
    /**
     * ═══ THE ASSERTION THAT STOPS THIS BEING A DEAD CURRENCY ═══
     * A grant with nothing to spend it on is the failure this codebase has
     * shipped four times — a system built, correct, and reachable by no content.
     * Three points and zero locked trees is that failure wearing a new hat.
     */
    expect(locked.length, 'nothing in the game is locked').toBeGreaterThan(0);

    /**
     * ═══ AND MORE OF THEM THAN POINTS, WHICH IS THE OPPOSITE OF WHAT THIS
     *     LINE USED TO ASSERT ═══
     * It read `toBeLessThanOrEqual(3)` — locked trees may not outnumber the
     * points — with the message "more locked trees than points to buy them".
     * That is a bare assertion with no argument beside it, and it contradicts
     * the one that IS argued, four lines from where the points are defined:
     *
     *   "A category point buys a WHOLE DISCIPLINE — six talents nobody starts
     *    with. Three across fifty levels is what makes which one a build
     *    decision rather than a shopping list, and it is why upstream spends
     *    them so rarely."
     *
     * With three points and three trees there is no decision: a character buys
     * all three and the scarcity that docblock calls the mechanic does not
     * exist. The fourth tree is the first one that makes the sentence true.
     *
     * So the floor is what matters — something to spend it on — and the
     * CEILING is now the thing worth asserting in the other direction.
     */
    expect(
      locked.length,
      'a category point is not a choice while every locked tree can be bought',
    ).toBeGreaterThan(totalCategoryPointsAtLevel(MAX_CHARACTER_LEVEL));
  });

  it('locks only trees no class owns', () => {
    /**
     * A LOCKED CLASS TREE WOULD TAKE SOMETHING AWAY. Every class tree is part of
     * a class's identity and is carried from level 1; locking one would mean a
     * character waiting until level 10 for a third of their own discipline.
     * Locked means EXTRA, and this is the line that keeps it meaning that.
     */
    for (const tree of locked) {
      expect(tree.classId, `${tree.id} is a class tree and locked`).toBeNull();
    }
  });

  it('costs no hotbar slots, which is why it fits', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE ARITHMETIC THAT CHOSE THIS DESIGN OVER UPSTREAM'S.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * ToME's category points buy another CLASS's discipline. Measured here it
     * does not fit: classes carry nine or ten actives, every class tree needs
     * three or four bar slots, and the bar addresses twelve — so the Watchman
     * fits exactly one cross-class unlock and the Inspector, at ten, fits none.
     * Three points with nowhere to spend two of them is a currency that reads
     * as broken.
     *
     * An all-passive tree needs no slots, so the ceiling never binds. If a
     * locked tree ever gains an active, this fails and the arithmetic above is
     * why it should.
     */
    for (const talent of ALL_LOCKED_TALENTS) {
      expect(talent.kind, `${talent.id} needs a bar slot`).toBe('passive');
    }
  });

  it('is not carried by anybody who has not bought it', () => {
    for (const definition of CLASSES) {
      const fresh = sheetForClass(definition);
      for (const talent of ALL_LOCKED_TALENTS) {
        expect(fresh.passives, `${definition.id} starts with ${talent.id}`).not.toContain(
          talent.id,
        );
      }
    }
  });

  it('is carried in full once it is bought, at rank 0', () => {
    for (const definition of CLASSES) {
      for (const tree of locked) {
        const bought = sheetForClass(definition, [tree.id]);
        const inTree = ALL_LOCKED_TALENTS.filter((talent) => talent.tree === tree.id);
        expect(inTree.length, `${tree.id} is empty`).toBeGreaterThan(0);
        for (const talent of inTree) {
          expect(bought.passives, `${definition.id} bought ${tree.id}`).toContain(talent.id);
          // AT RANK 0 — bought the DISCIPLINE, not the talents. Each one still
          // costs an ordinary point, exactly as if the class had always owned
          // the tree. A category point that also granted six ranks would be
          // worth more than the six talent points it saves.
          expect(bought.points.get(talent.id), talent.id).toBe(0);
        }
      }
    }
  });

  it('buys exactly the discipline named and nothing else', () => {
    /**
     * Naming one tree must not open the others. With a single locked tree the
     * cross-tree half is vacuous today, so the assertion is written as a SET
     * EQUALITY rather than as a loop over the others: it says what it means
     * whether there is one locked tree or five, and it starts catching the
     * real failure the moment a second one is authored.
     *
     * The failure it is waiting for would be invisible at level 10 — the
     * player gets what they asked for — and obvious at 20, when the second
     * point has nothing left to buy.
     */
    for (const tree of locked) {
      const bought = sheetForClass(WATCHMAN, [tree.id]);
      const held = ALL_LOCKED_TALENTS.filter((talent) => bought.passives.includes(talent.id));
      const wanted = ALL_LOCKED_TALENTS.filter((talent) => talent.tree === tree.id);
      expect(held.map((t) => t.id).sort(), tree.id).toEqual(wanted.map((t) => t.id).sort());
    }
  });

  it('shrugs off a tree id nothing answers to', () => {
    // A save from a branch with a tree we do not have, or one this build
    // deleted. Repair-never-reject: the character loads and the discipline is
    // simply absent until the day the tree comes back.
    const sheet = sheetForClass(WATCHMAN, ['generic/does-not-exist']);
    expect(sheet.passives.length).toBe(sheetForClass(WATCHMAN).passives.length);
  });
});

describe('the locked tree is a real tree', () => {
  it('is registered, named and blurbed like every other', () => {
    for (const talent of ALL_LOCKED_TALENTS) {
      const tree = treeById(talent.tree);
      expect(tree, `${talent.id} is in tree ${talent.tree}`).toBeDefined();
      expect(tree?.locked, `${talent.tree} is not marked locked`).toBe(true);
      expect((tree?.name ?? '').length, `${talent.tree} has no name`).toBeGreaterThan(0);
    }
  });
});

describe('a locked discipline is browsable before it is bought', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * A CATEGORY POINT IS SPENDABLE WITHOUT THIS AND NOT BROWSABLE WITHOUT IT.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `unlock_tree` names a tree id and the server knows them all, so the verb
   * works with nothing on screen. Asking a player to spend the scarcest currency
   * in the game on a NAME they have never seen the inside of is the same failure
   * as a talent with no description.
   */
  const engine = createContentTalentEngine();
  const talents = createTalentBook(engine, createWorld('browsable'));
  const body = { id: 'p1', classId: WATCHMAN.id, unlockedTrees: [] };

  it('offers the locked disciplines to somebody who owns none', () => {
    const offered = talents.unlockableOf(body as never);
    expect(offered.length, 'nothing is offered').toBeGreaterThan(0);
    for (const tree of offered) {
      expect(treeById(tree.id)?.locked, `${tree.id} is offered and not locked`).toBe(true);
    }
  });

  it('comes with its talents rendered, not just a name and a price', () => {
    for (const tree of talents.unlockableOf(body as never)) {
      expect(tree.talents.length, `${tree.id} came with no talents`).toBeGreaterThan(0);
      for (const talent of tree.talents) {
        // THE SAME RENDERING AN OWNED TALENT GETS — same `describe`, same
        // numbers. A preview that said less than the real thing would be a
        // player buying on faith.
        expect(talent.desc.length, `${talent.id} has no description`).toBeGreaterThan(0);
        expect(talent.name.length, `${talent.id} has no name`).toBeGreaterThan(0);
        // AT RANK 0, which is not a placeholder: it is exactly what they would
        // hold on the day they bought it.
        expect(talent.level, talent.id).toBe(0);
      }
    }
  });

  it('stops offering one that has been bought', () => {
    /**
     * THE FAILURE THIS CATCHES IS SILENT AND EXPENSIVE. A list that did not
     * shrink would go on showing a discipline the character owns, and the
     * second category point would be spent on it — refused by the server, but
     * only after the player had decided.
     */
    const bought = { id: 'p1', classId: WATCHMAN.id, unlockedTrees: ['generic/leverage'] };
    const offered = talents.unlockableOf(bought as never);
    expect(offered.map((tree) => tree.id)).not.toContain('generic/leverage');
  });

  it('offers nothing to a body with no class', () => {
    // The class picker is still owed. A discipline offered before a class is
    // chosen is one bought against a sheet that is about to be replaced.
    expect(talents.unlockableOf({ id: 'p1' } as never)).toEqual([]);
  });
});
