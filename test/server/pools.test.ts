// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// The rule under test is ported from t-engine4 game/modules/tome/class/Actor.lua:3884-3885.
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

import { describe, expect, it } from 'vitest';

import { ALCHEMIST, INSPECTOR, WATCHMAN } from '../../src/server/content/classes.ts';
import { EGOS, egoWielder } from '../../src/server/content/egos.ts';
import { composeWielders } from '../../src/server/engine/equipment.ts';
import { maxLifeOf, maxMoveOf } from '../../src/server/engine/pools.ts';
import { LIFE_PER_CON, PLAYER_RANK } from '../../src/shared/leveling.ts';
import type { CombatSheet } from '../../src/server/engine/combat.ts';
import type { PooledClass } from '../../src/server/engine/pools.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * CONSTITUTION PAYS FOR HIT POINTS NO MATTER WHERE THE CONSTITUTION CAME FROM.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Reported from the live game: *"I equip gear with CON and it doesn't properly
 * raise my HP."* It did not, and nothing in this tree noticed, because the
 * computation read `actor.spentStats.con` — the ledger of points the PLAYER
 * BOUGHT — while every other consumer of Constitution read the composed sheet.
 *
 * ═══ WHY THE OBVIOUS TEST WOULD HAVE PASSED ON THE BROKEN CODE ═══
 * A test that spends attribute points and checks the hit points went up is TRUE
 * OF ITS FIXTURE AND NOT OF ITS RULE — the one thing this codebase gets wrong
 * most often. `recomposeCombat` folds `spentStats` into `combat.stats.con` too,
 * so for a body with no gear the two readings AGREE, and such a test passes
 * identically before and after the fix.
 *
 * The discriminating case is Constitution from somewhere the ledger cannot see:
 * an ego, a passive, a timed effect. Every test below that matters builds its
 * Constitution that way and leaves `spentStats` empty — which is exactly the
 * situation the player was in.
 */

/** A body as `maxLifeOf` needs it. `spentStats` is deliberately never set. */
function body(
  level: number,
  combat: CombatSheet | undefined,
): {
  readonly level: number;
  readonly combat?: CombatSheet;
} {
  return combat === undefined ? { level } : { level, combat };
}

/** The class sheet, worn as-is — a character who has picked a class and no gear. */
function bare(definition: PooledClass, level = 1): number {
  return maxLifeOf(body(level, definition.combat), definition, PLAYER_RANK);
}

/**
 * The same body with a `wielder` block folded on, through the REAL combine that
 * `recomposeCombat` uses for gear. Not a hand-written sheet: if `composeWielders`
 * ever stopped carrying `con`, this fixture would stop expressing the case and
 * the test would go quietly green.
 */
function wearing(definition: PooledClass, block: { stats?: { con?: number } }, level = 1): number {
  const composed = composeWielders(definition.combat, [block]);
  return maxLifeOf(body(level, composed), definition, PLAYER_RANK);
}

describe('hit points follow the Constitution a body is standing at', () => {
  it('pays for Constitution that no attribute point was ever spent on', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE TEST THE BUG WOULD HAVE FAILED. Everything else here is a guard rail.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `spentStats` is absent from the body entirely, so the old implementation
     * had nothing to read and returned the class base unchanged — a player in a
     * +6 Constitution coat with exactly the hit points they had without it.
     */
    expect(wearing(WATCHMAN, { stats: { con: 6 } })).toBe(bare(WATCHMAN) + 6 * LIFE_PER_CON);
  });

  it('pays the same four points a level-up does, from every source', () => {
    // ONE ANSWER, NOT TWO. `equipment.ts` argues the same thing about the fold:
    // two combines would be two answers to "do a passive and a pauldron stack".
    for (const con of [1, 3, 7, 25]) {
      expect(wearing(WATCHMAN, { stats: { con } }), `con +${String(con)}`).toBe(
        bare(WATCHMAN) + con * LIFE_PER_CON,
      );
    }
  });

  it('gives the points back when the coat comes off', () => {
    /**
     * The property `equipment.ts` exists to guarantee, followed one layer up:
     * *"UNEQUIP IS NOT A SUBTRACTION"* — the fold is re-run over the smaller set,
     * so the pool has to land exactly where it started rather than near it.
     */
    const before = bare(WATCHMAN);
    const on = wearing(WATCHMAN, { stats: { con: 6 } });
    const off = maxLifeOf(body(1, composeWielders(WATCHMAN.combat, [])), WATCHMAN, PLAYER_RANK);
    expect(on).toBeGreaterThan(before);
    expect(off).toBe(before);
  });

  it('leaves a fresh character on exactly its authored base', () => {
    /**
     * THE SAFETY PROPERTY. Everyone playing today has a body sized by the old
     * rule; if this moved, the change would silently re-tune every live
     * character on the next reconnect. `leveling.test.ts` pins the same
     * property one layer down, against `maxLifeFor` directly.
     */
    for (const c of [WATCHMAN, INSPECTOR, ALCHEMIST]) {
      expect(bare(c), c.name).toBe(c.maxHp);
    }
  });

  it('does not pay a class for the Constitution it was authored with', () => {
    /**
     * A Watchman stands at Constitution 20 on the day he is made, and his 72 is
     * seventy-two AT that Constitution. Handing the raw stat to `maxLifeFor`
     * would hand him eighty hit points for existing — which is the mistake this
     * subtraction exists to prevent, and it is invisible without a class whose
     * Constitution is far from `STAT_BASE`.
     */
    expect(WATCHMAN.combat.stats?.con).toBe(20);
    expect(bare(WATCHMAN)).toBe(72);
    expect(bare(WATCHMAN)).toBeLessThan(72 + 10 * LIFE_PER_CON);
  });

  it('treats a class with no authored stats as standing at the base ten', () => {
    // `composeWielders`: "An absent `stats.*` is TEN, not zero ... the naive
    // version hands a Watchman a ring and takes seven points of Strength off
    // him." Both reads in `maxLifeOf` default the same way, so this nets to
    // nought rather than to minus forty hit points.
    const plain: PooledClass = { maxHp: 50, lifeRating: 10, maxMp: 3, combat: {} };
    expect(maxLifeOf(body(1, {}), plain, PLAYER_RANK)).toBe(50);
    expect(maxLifeOf(body(1, { stats: { con: 12 } }), plain, PLAYER_RANK)).toBe(
      50 + 2 * LIFE_PER_CON,
    );
  });

  it('shrinks a body dragged below its class Constitution', () => {
    // Nothing rolls a negative stat today. This is the behaviour waiting
    // correctly for the first curse that does — upstream runs the same
    // `+ 4 * v` with a negative `v` (Actor.lua:3884-3885).
    expect(wearing(WATCHMAN, { stats: { con: -5 } })).toBe(bare(WATCHMAN) - 5 * LIFE_PER_CON);
  });

  it('still widens the pool as a character levels, on top of all of it', () => {
    // The two contributions are independent: gear must not stop paying because
    // a level arrived, and vice versa.
    const worn = { stats: { con: 6 } };
    for (const level of [1, 10, 25]) {
      expect(wearing(WATCHMAN, worn, level), `level ${String(level)}`).toBe(
        bare(WATCHMAN, level) + 6 * LIFE_PER_CON,
      );
    }
    expect(bare(WATCHMAN, 25)).toBeGreaterThan(bare(WATCHMAN, 1));
  });
});

describe('the shipped content that this was silently ignoring', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE BUG WAS REACHABLE FROM THE CATALOGUE, NOT ONLY IN PRINCIPLE.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Two suffixes in `EGOS` roll Constitution, so the player's report is
   * reproducible from shipped loot. Anchoring the test to the real table means
   * that if the last Constitution ego is ever deleted, THIS test fails and says
   * so, rather than the coverage evaporating without a sound.
   */
  const conEgos = EGOS.filter((ego) => ego.grants.stats?.con !== undefined);

  it('has Constitution egos in the drop table at all', () => {
    expect(conEgos.map((e) => e.code).sort()).toEqual(['ln', 'lw']);
  });

  it('turns every one of them into hit points a player can feel', () => {
    for (const ego of conEgos) {
      const wielder = egoWielder(ego, 0, 'common');
      const granted = wielder.stats?.con ?? 0;
      expect(granted, `${ego.code} granted no con`).toBeGreaterThan(0);
      expect(wearing(WATCHMAN, { stats: { con: granted } }), ego.name).toBe(
        bare(WATCHMAN) + granted * LIFE_PER_CON,
      );
    }
  });
});

describe('how far a body gets in a turn', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE LAST POOL THAT READ PAST THE FOLD, AND IT WAS UNTESTED.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `main.ts` computed this as `definition.maxMp + passiveCombat?.mods?.moveMp`
   * — the passive layer alone, reaching past `recomposeCombat` to one of the
   * layers underneath it. The same shape as max hit points off the points
   * ledger, the compare panel off `baseCombat`, and two clamps off a level-1
   * ceiling.
   *
   * ═══ HOW IT WAS FOUND ═══
   * Deleting `moveMp` from `WIELDER_MOD_KEYS` — which silently removes the whole
   * effect of the `legwork` discipline — failed NOTHING in four thousand tests.
   * Unreachable where it lived, inside the `buildServer` closure.
   */
  const cls: PooledClass = { maxHp: 50, lifeRating: 10, maxMp: 3, combat: {} };

  it('is the class figure for a body carrying nothing', () => {
    expect(maxMoveOf(body(1, {}), cls)).toBe(3);
    expect(maxMoveOf({ level: 1 }, cls)).toBe(3);
  });

  it('counts a moveMp from ANY layer, because it reads the composed sheet', () => {
    /**
     * A passive, a worn item and a timed effect all land in `combat.mods` by the
     * time this runs — `recomposeCombat` folds all three through the same
     * additive combine. That is the entire point of reading the composed sheet
     * rather than one layer of it: this function cannot tell them apart, and
     * must not.
     */
    expect(maxMoveOf(body(1, composeWielders({}, [{ mods: { moveMp: 2 } }])), cls)).toBe(5);
    expect(
      maxMoveOf(
        body(1, composeWielders({}, [{ mods: { moveMp: 1 } }, { mods: { moveMp: 2 } }])),
        cls,
      ),
      'two sources did not add',
    ).toBe(6);
  });

  it('survives the fold — which is the coupling that had no test at all', () => {
    // THE DISCRIMINATING ONE. `composeWielders` only carries keys named in
    // `WIELDER_MOD_KEYS`, so this fails the moment `moveMp` leaves that list —
    // taking the `legwork` discipline's whole effect with it, silently, as it
    // would have before.
    expect(composeWielders({}, [{ mods: { moveMp: 2 } }]).mods?.moveMp).toBe(2);
  });

  it('never leaves a body unable to move', () => {
    // A pool of zero is a state the turn system has no answer for. `mpPenalty`
    // is how a status takes movement away and it is applied elsewhere.
    expect(maxMoveOf(body(1, composeWielders({}, [{ mods: { moveMp: -99 } }])), cls)).toBe(1);
  });
});
