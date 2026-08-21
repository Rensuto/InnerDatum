// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/modules/tome/data/talents/techniques/techniques.lua:99
// and game/engines/default/engine/interface/ActorTalents.lua:729-734.
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" — https://te4.org/license

import { isMonsterTalent } from '../../src/server/talents/monster.ts';
import { describe, expect, it } from 'vitest';

import { createContentTalentEngine } from '../../src/server/content/classes.ts';
import { TALENT_TREES, treeById } from '../../src/server/content/talent-trees.ts';
import { MAX_TIER, MIN_TIER, checkTier, levelRequiredFor } from '../../src/shared/tiers.ts';
import { MAX_CHARACTER_LEVEL, TALENT_MAX_LEVEL } from '../../src/shared/progression.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *   THE GATE THAT SAID YES TO EVERYTHING.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `Talent.tier` and `Talent.statGate` were both authored, both documented, and
 * set by NONE of the 42 talent files. `checkTier` therefore read `tier ?? 1`
 * and `stat === undefined` for every talent in the game — a level-1 character
 * could put their first point into the deepest thing in it, and seven trees
 * were seven captions.
 *
 * These tests are about the TABLE, not about one talent: an assignment that is
 * wrong in a way a human reading one file would not notice — a tree with no
 * entry talent, a tier nobody can reach at the level cap — is exactly the shape
 * that survives review and is found in play at level 20.
 */

/**
 * EVERY TALENT THE GAME SHIPS, off the registry the server actually builds.
 *
 * NOT AN AUTHORED LIST. A hand-kept array in a test file is a second copy of
 * the content table, and the failure mode is silent in exactly the direction
 * that matters: a talent added and forgotten here is a talent no assertion in
 * this file ever sees.
 */
const ALL_TALENTS = createContentTalentEngine()
  .registry.all()
  /**
   * ═══ PLAYER TALENTS ONLY, AND THE FILTER IS THE POINT ═══
   * `registry.all()` meant "every talent a player can reach" until the bestiary
   * got talents of its own. A creature's talent has no tier because nobody
   * ranks it up, no entry in `TALENT_TREES` because no panel draws it, and no
   * place on any loadout because no player can learn it. Every assertion in
   * this file is about the LADDER, which is a player-facing structure.
   */
  .filter((talent) => !isMonsterTalent(talent));

const CLASS_TREES = TALENT_TREES.filter((tree) => tree.classId !== null);

describe('every talent declares where it sits', () => {
  it('names a tier, and one inside the ladder', () => {
    for (const talent of ALL_TALENTS) {
      expect(talent.tier, `${talent.id} declares no tier`).toBeDefined();
      expect(talent.tier ?? 0, talent.id).toBeGreaterThanOrEqual(MIN_TIER);
      expect(talent.tier ?? 0, talent.id).toBeLessThanOrEqual(MAX_TIER);
    }
  });

  it('names a tree that exists', () => {
    for (const talent of ALL_TALENTS) {
      expect(treeById(talent.tree), `${talent.id} is in tree ${talent.tree}`).toBeDefined();
    }
  });
});

describe('every tree is a path', () => {
  const byTree = new Map<string, typeof ALL_TALENTS>();
  for (const talent of ALL_TALENTS) {
    byTree.set(talent.tree, [...(byTree.get(talent.tree) ?? []), talent]);
  }

  it('opens with something', () => {
    /**
     * ═══ THE ONE THAT WOULD BREAK CHARACTER CREATION ═══
     * A tree whose shallowest talent is tier 2 is a tree a new character cannot
     * put a point into at all — and, because the depth gate wants N-1 others of
     * the same tree known, one they can NEVER open by their own effort. It is a
     * dead tree, and it would look completely normal in the file.
     */
    for (const [tree, talents] of byTree) {
      const shallowest = Math.min(...talents.map((t) => t.tier ?? MIN_TIER));
      expect(shallowest, `${tree} has no entry talent`).toBe(MIN_TIER);
    }
  });

  it('has enough below each tier to satisfy its own depth gate', () => {
    /**
     * ActorTalents.lua:729-734 — a tier-N talent wants N-1 OTHERS of its tree
     * known. A tree with one tier-1 and four tier-4s satisfies nothing: the
     * four are permanently unreachable and nothing in the type system says so.
     */
    for (const [tree, talents] of byTree) {
      for (const talent of talents) {
        const tier = talent.tier ?? MIN_TIER;
        const others = talents.length - 1;
        expect(
          others,
          `${talent.id} in ${tree} can never meet its depth gate`,
        ).toBeGreaterThanOrEqual(tier - 1);
      }
    }
  });

  it('reaches its deepest rank inside the level cap', () => {
    // A talent whose last rank opens past level 50 is a rank nobody buys, which
    // is the bug the cap-of-10 era shipped four times over. See tiers.ts.
    for (const talent of ALL_TALENTS) {
      const deepest = levelRequiredFor(talent.tier ?? MIN_TIER, TALENT_MAX_LEVEL);
      expect(deepest, `${talent.id} masters at level ${String(deepest)}`).toBeLessThanOrEqual(
        MAX_CHARACTER_LEVEL,
      );
    }
  });

  it('gates a class tree on a stat and leaves the generic one alone', () => {
    /**
     * `Talent.statGate`'s own doctrine, asserted rather than trusted: upstream's
     * generic tree is things true of a BODY rather than of a discipline, and
     * nothing about your Cunning should gate whether you have been shouted at
     * before. A generic tree that quietly acquired a stat gate would make the
     * shared tree a third class tree, which is the whole thing it is not.
     */
    for (const talent of ALL_TALENTS) {
      const tree = treeById(talent.tree);
      if (tree === undefined) continue;
      if (tree.classId === null) {
        expect(talent.statGate, `${talent.id} is generic and gated on a stat`).toBeUndefined();
      } else {
        expect(talent.statGate, `${talent.id} is a class talent with no stat gate`).toBeDefined();
      }
    }
  });

  it('gates one class tree on exactly one stat', () => {
    // Two stats inside one tree would mean a player raising the tree's own
    // attribute still being refused halfway up it, for a reason the panel would
    // report correctly and the player would experience as arbitrary.
    for (const tree of CLASS_TREES) {
      const stats = new Set(
        ALL_TALENTS.filter((t) => t.tree === tree.id).map((t) => t.statGate ?? '—'),
      );
      expect([...stats], `${tree.id} is gated on more than one stat`).toHaveLength(1);
    }
  });

  it('gives each class two different stats to raise', () => {
    /**
     * THE REASON THE GATE IS PER-TREE AND NOT PER-CLASS. One stat per class
     * makes every attribute point after the first obvious, which is not a
     * decision. Upstream's own pattern is two — a Bulwark wants Strength and
     * Constitution, an Archer Dexterity and Cunning — and it is what makes the
     * three-points-a-level grant something a player thinks about.
     */
    const byClass = new Map<string, Set<string>>();
    for (const tree of CLASS_TREES) {
      const stat = ALL_TALENTS.find((t) => t.tree === tree.id)?.statGate;
      if (stat === undefined || tree.classId === null) continue;
      byClass.set(tree.classId, (byClass.get(tree.classId) ?? new Set()).add(stat));
    }
    expect(byClass.size, 'not every class has gated trees').toBeGreaterThan(0);
    for (const [classId, stats] of byClass) {
      /**
       * ═══ AT LEAST TWO, AND THIS READ `toBe(2)` ═══
       * The property worth pinning is that no class leans on ONE attribute —
       * that is what makes an attribute point a formality. Exactly two was the
       * number the game happened to have when this was written, and the
       * Watchman's third tree (`watch/authority`, Willpower) failed it at three
       * with nothing wrong. A guard that fails on content being added in the
       * direction it wanted teaches its readers to widen it without thinking.
       */
      expect(stats.size, `${classId} leans on one stat only`).toBeGreaterThanOrEqual(2);
    }
  });
});

describe('the gate now refuses somebody', () => {
  it('will not sell a level-1 character the deepest thing in a tree', () => {
    /**
     * ═══ THE ASSERTION THIS WHOLE COMMIT EXISTS FOR ═══
     * Before the tiers were assigned this passed as `ok: true`, for every
     * talent in the game, at level 1, with the very first point earned.
     */
    const deepest = ALL_TALENTS.find((t) => (t.tier ?? 1) === MAX_TIER);
    expect(deepest, 'nothing in the game is tier 4').toBeDefined();
    const verdict = checkTier({
      tier: deepest?.tier,
      rank: 2,
      stat: deepest?.statGate,
      statValue: 999,
      characterLevel: 1,
      treeKnown: 99,
    });
    expect(verdict.ok).toBe(false);
  });

  it('still sells an entry talent to a level-1 character', () => {
    // The other half, and the one that would make the game unplayable if the
    // ladder were shifted by one: a fresh character must be able to spend their
    // first point on the discipline they just chose.
    const entry = ALL_TALENTS.find((t) => (t.tier ?? 1) === MIN_TIER);
    expect(entry).toBeDefined();
    expect(
      checkTier({
        tier: entry?.tier,
        rank: 2,
        stat: entry?.statGate,
        statValue: 99,
        characterLevel: 1,
        treeKnown: 5,
      }).ok,
    ).toBe(true);
  });
});
