// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/modules/tome/class/Actor.lua:3749-3752.
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" — https://te4.org/license

import { describe, expect, it } from 'vitest';

import {
  GENERIC_TREE_PREFIX,
  MAX_CHARACTER_LEVEL,
  genericPointsForLevel,
  isGenericTree,
  pointsForLevel,
  totalGenericPointsAtLevel,
  totalPointsAtLevel,
} from '../../src/shared/progression.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *   TWO CURRENCIES, ONE GRANT.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Upstream hands out both on every level-up (Actor.lua:3749-3752):
 *
 *     unused_talents  += 1
 *     unused_generics += 1
 *     if level % 5 == 0 then unused_talents  += 1 end
 *     if level % 5 == 0 then unused_generics -= 1 end
 *
 * This game shipped only the first. The second is not a bonus pool — it is the
 * thing that makes a deliberately boring generic tree acceptable, because a flat
 * +1 armour is a fine thing to own and a terrible thing to weigh against a
 * signature ability. Copying the tree without the economics is how this project
 * ended up with 57% of its talents being a number going up.
 */

describe('the grant', () => {
  it('is always exactly two points, at every level', () => {
    /**
     * ═══ THE PROPERTY THE SWAP IS FOR ═══
     * The total never changes. What changes is WHICH pool they land in, so a
     * fifth level is a moment where a character gets deeper in their profession
     * instead of broader as a person — and it costs the budget nothing.
     */
    /**
     * ═══ EVERY LEVEL BUT THE LAST, AND THE EXCEPTION IS DELIBERATE ═══
     * The cap pays a bonus on top (Actor.lua:3767-3774) — 3 class and 3 generic
     * beyond the ordinary grant — so it is the one level that does not hand out
     * two. That is upstream's design and it has its own test; excluding it here
     * keeps this assertion about the SWAP, which is what it is for.
     */
    for (let level = 2; level < MAX_CHARACTER_LEVEL; level += 1) {
      expect(
        pointsForLevel(level) + genericPointsForLevel(level),
        `level ${String(level)} does not grant two`,
      ).toBe(2);
    }
  });

  it('pays the fifth-level bonus OUT OF the generic pool', () => {
    // Not from nowhere. Actor.lua:3751 gives, :3752 takes.
    expect(pointsForLevel(5)).toBe(2);
    expect(genericPointsForLevel(5)).toBe(0);
    expect(pointsForLevel(4)).toBe(1);
    expect(genericPointsForLevel(4)).toBe(1);
  });

  it('grants nothing at all for level 1', () => {
    // Level 1 is where a character starts, not a level-up.
    expect(pointsForLevel(1)).toBe(0);
    expect(genericPointsForLevel(1)).toBe(0);
  });

  it('makes the generic pool the scarcer one over a career', () => {
    /**
     * ═══ SCARCER, AND THAT IS THE WHOLE POINT ═══
     * If the two pools were equal there would be no pressure on the generic
     * tree at all and every talent in it would eventually be bought. The fifth
     * levels are what make a player choose inside the dull tree too.
     */
    const classPoints = totalPointsAtLevel(MAX_CHARACTER_LEVEL);
    const generics = totalGenericPointsAtLevel(MAX_CHARACTER_LEVEL);
    expect(generics).toBeLessThan(classPoints);
    // ...and the gap is exactly twice the number of fifth levels: one point
    // moved across, counted once on each side.
    const fifths = Math.floor(MAX_CHARACTER_LEVEL / 5);
    expect(classPoints - generics).toBe(fifths * 2);
  });
});

describe('which purse a tree draws from', () => {
  it('sends generic trees to the generic pool and everything else to the class one', () => {
    expect(isGenericTree('generic/groundwork')).toBe(true);
    expect(isGenericTree('watch/the-line')).toBe(false);
    expect(isGenericTree('index/marksmanship')).toBe(false);
    expect(isGenericTree('ashwick/reagents')).toBe(false);
  });

  it('reads the namespace rather than keeping a second table', () => {
    /**
     * Upstream keys this off `newTalentType`'s `generic = true` flag. Ours is
     * the tree id's namespace, which is the same information already written
     * down — one prefix, and no second list to fall out of step with the first.
     * That is [M-002], and it is why this is a function and not a Set.
     */
    expect(GENERIC_TREE_PREFIX).toBe('generic/');
    expect(isGenericTree(`${GENERIC_TREE_PREFIX}anything-at-all`)).toBe(true);
  });

  it('treats an unknown tree as a class tree, which is the safe default', () => {
    /**
     * A tree nobody namespaced is a CLASS tree, so a mistake costs a player the
     * scarcer currency rather than handing them the cheaper one. Failing toward
     * the stricter purse is the right direction for a mistake to fall.
     */
    expect(isGenericTree('')).toBe(false);
    expect(isGenericTree('something/unnamespaced')).toBe(false);
  });
});
