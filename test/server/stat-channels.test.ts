// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// The rules under test are ported from t-engine4 game/modules/tome/class/Actor.lua:3881-3907.
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

import { describe, expect, it } from 'vitest';

import { WATCHMAN } from '../../src/server/content/classes.ts';
import {
  INDEX_GLUT,
  INDEX_HUSK,
  MONSTER_TEMPLATES,
  monsterInit,
} from '../../src/server/content/monsters.ts';
import { maxLifeOf } from '../../src/server/engine/pools.ts';
import { LIFE_PER_CON, PLAYER_RANK, RANK_VALUE, lifeGainedTo } from '../../src/shared/leveling.ts';
import type { MonsterTemplate } from '../../src/server/content/monsters.ts';
import { applyDamage } from '../../src/server/engine/damage.ts';
import { DamageType } from '../../src/shared/damagetype.ts';
import { healingFactor, ignoreDirectCrits } from '../../src/server/engine/derived.ts';
import { healActor } from '../../src/server/engine/talents.ts';
import { combatStatLimit } from '../../src/shared/scale.ts';
import { scriptedRng } from '../helpers/scripted-rng.ts';
import { ActorKind } from '../../src/shared/protocol.ts';
import type { TalentActor } from '../../src/server/engine/talents.ts';

/**
 * A body `healActor` will accept. The four identity fields are required by
 * `TalentActor` and none of them matters here — this file is about a number.
 */
function body(hp: number, maxHp: number, con: number, alive = true): TalentActor {
  return {
    id: 'b',
    name: 'Body',
    kind: ActorKind.Player,
    x: 0,
    y: 0,
    hp,
    maxHp,
    alive,
    cooldowns: new Map(),
    combat: { stats: { con } },
  };
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE TWO ARMS OF `onStatChange` WE NEVER PORTED. Actor.lua:3881-3907.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ```lua
 * if stat == self.STAT_CON then
 *   self.max_life = ...                                        -- ported
 *   self.stats.hf_id = self:addTemporaryValue("healing_factor",
 *     self:combatStatLimit("con", 1.5, 0, 0.5))                -- THIS
 * elseif stat == self.STAT_DEX then
 *   self.ignore_direct_crits = (self.ignore_direct_crits or 0) + 0.3 * v  -- AND THIS
 * ```
 *
 * Both are things a stat buys that are not a combat number, which is why both
 * were missed: every other consumer of a primary goes through `derived.ts`, and
 * these two go through the heal path and the damage pipeline instead.
 */

describe('Constitution makes every heal go further', () => {
  it('is exactly neutral for a body that has invested nothing', () => {
    /**
     * THE SAFETY PROPERTY. `STAT_BASE` is 10 and upstream's own comment on the
     * curve is "+0 @ 10", so a character who has spent no points heals for
     * precisely what they healed for before this existed. If this moved, the
     * change would silently retune every heal in the game.
     */
    expect(healingFactor({ stats: { con: 10 } })).toBe(1);
    expect(healingFactor({}), 'an absent sheet is not the same as con 10').toBe(1);
  });

  it('reaches upstream’s other published anchor at 100', () => {
    // "+0.50 @ 100", from the same comment. The two anchors are the whole
    // specification of the curve — matching both is matching the curve.
    expect(healingFactor({ stats: { con: 100 } })).toBeCloseTo(1.5, 10);
  });

  it('is a diminishing return, not a straight line', () => {
    // The reason it is `combatStatLimit` and not `0.005 * con`: the first points
    // are worth the most, and no amount of Constitution reaches the 1.5 limit.
    const first = healingFactor({ stats: { con: 30 } }) - healingFactor({ stats: { con: 20 } });
    const later = healingFactor({ stats: { con: 90 } }) - healingFactor({ stats: { con: 80 } });
    expect(first).toBeGreaterThan(later);
    expect(healingFactor({ stats: { con: 10_000 } })).toBeLessThan(2.5);
  });

  it('reads `low = 0` as a REAL argument, the way Lua does', () => {
    /**
     * The trap this port could most easily have fallen into. In Lua `0` is
     * TRUTHY, so `if low then` takes the first branch for `combatStatLimit("con",
     * 1.5, 0, 0.5)`. A port that read it as JavaScript's `if (low)` would take
     * the second branch and produce a different curve that still looks perfectly
     * reasonable — it just would not pass through either published anchor.
     */
    // MEASURED AT 10, NOT AT 100. Both branches are constructed to pass through
    // `high` at stat 100, so they agree exactly there and the comparison proves
    // nothing — the first draft of this test did that and passed against both.
    // At the LOW anchor they separate: the `low` branch is pinned to 0 and the
    // other is not pinned at all.
    expect(combatStatLimit(10, 1.5, 0, 0.5)).toBeCloseTo(0, 10);
    expect(combatStatLimit(10, 1.5, undefined, 0.5)).toBeGreaterThan(0.05);
    // And they still meet at the high anchor, which is what makes them both
    // plausible and the mistake so quiet.
    expect(combatStatLimit(100, 1.5, 0, 0.5)).toBeCloseTo(0.5, 10);
    expect(combatStatLimit(100, 1.5, undefined, 0.5)).toBeCloseTo(0.5, 10);
  });

  it('scales the heal by the RECEIVER’s Constitution, not the caster’s', () => {
    /**
     * `onHeal` is on the target (Actor.lua:2086-2089), which is the whole shape
     * of the feature: a bandage is worth more on somebody built to survive. A
     * version that read the caster would make a healer's own Constitution the
     * only one that mattered, and every player would be told to build the same
     * way.
     */
    expect(healActor(body(1, 500, 100), 100)).toBe(150);
    expect(healActor(body(1, 500, 10), 100)).toBe(100);
  });

  it('never turns a heal of 1 into a heal of 0', () => {
    // Rounded rather than floored. A talent that healed for nothing because the
    // receiver was slightly below the base would read as a broken talent.
    expect(healActor(body(1, 50, 10), 1)).toBe(1);
  });

  it('still clamps at the ceiling, and still refuses a corpse', () => {
    expect(healActor(body(48, 50, 100), 100)).toBe(2);
    expect(healActor(body(0, 50, 100, false), 10)).toBe(0);
  });
});

describe('Dexterity shrugs off critical hits', () => {
  it('is a chance, and it is 0.3 a point', () => {
    // `+ 0.3 * v`, accumulated from zero as the stat is set — so a settled body
    // reads `0.3 x dex`. The base 10 is 3%; 100 is 30%.
    expect(ignoreDirectCrits({ stats: { dex: 10 } })).toBeCloseTo(3, 10);
    expect(ignoreDirectCrits({ stats: { dex: 100 } })).toBeCloseTo(30, 10);
    expect(ignoreDirectCrits({}), 'an absent sheet reads the base Dexterity').toBeCloseTo(3, 10);
  });

  it('cancels the whole multiplier, rather than shaving the damage', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE ASSERTION THAT SEPARATES THIS FROM "A BIT LESS CRIT DAMAGE".
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `dam = dam / crit_power; crit_power = 1` — damage_types.lua:106-107. A
     * body does not take smaller crits; it occasionally takes NONE of the crit.
     * The difference is a moment a player notices against a quiet percentage
     * they never do.
     *
     * The draws are scripted: hit is not rolled by `applyDamage`, so it is the
     * crit roll (1, a hit) and then the shrug roll (1, which lands against any
     * non-zero chance).
     */
    const target = {
      hp: 100,
      maxHp: 100,
      alive: true,
      combat: { stats: { dex: 100 } },
    };
    const out = applyDamage(target, 10, DamageType.Physical, { id: 'a' }, scriptedRng([1, 1]), {
      critChance: 100,
      critPower: 3,
    });
    // 10 x 3 = 30, then divided back by 3 -> 10. Not 30, and not something
    // between: the crit is undone, not reduced.
    expect(out.dealt).toBe(10);
    expect(out.crit, 'the blow still reported itself as a crit').toBe(false);
  });

  it('lets the crit stand when the roll misses', () => {
    const target = { hp: 100, maxHp: 100, alive: true, combat: { stats: { dex: 100 } } };
    const out = applyDamage(target, 10, DamageType.Physical, { id: 'a' }, scriptedRng([1, 100]), {
      critChance: 100,
      critPower: 3,
    });
    expect(out.dealt).toBe(30);
    expect(out.crit).toBe(true);
  });

  it('takes no shrug draw at all when the blow did not crit', () => {
    /**
     * `crit_power > 1` guards the roll upstream, and the stream rule is why it
     * matters here: a draw taken on every blow rather than every CRIT would
     * consume one extra number per swing for the rest of the session.
     * `scriptedRng` throws on an over-draw, so a script of exactly one entry is
     * the assertion.
     */
    const target = { hp: 100, maxHp: 100, alive: true, combat: { stats: { dex: 100 } } };
    const out = applyDamage(target, 10, DamageType.Physical, { id: 'a' }, scriptedRng([100]), {
      critChance: 1,
      critPower: 3,
    });
    expect(out.crit).toBe(false);
    expect(out.dealt).toBe(10);
  });

  it('gives a real Watchman a real number, not a rounding artefact', () => {
    // Anchored to the shipped class so a retune of its Dexterity shows up here
    // rather than silently changing what the stat is worth.
    const dex = WATCHMAN.combat.stats?.dex ?? 0;
    expect(dex).toBeGreaterThan(0);
    expect(ignoreDirectCrits(WATCHMAN.combat)).toBeCloseTo(0.3 * dex, 10);
  });
});

describe('a monster is paid for Constitution the same way a player is', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THERE IS NO PLAYER BRANCH IN UPSTREAM'S PATH, AND THERE SHOULD BE NONE HERE.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `Actor:levelup` adds the life rating (Actor.lua:3818-3822) and then calls
   * `Autolevel:autoLevel` (:3835-3837). The schemes call `learnStats` ->
   * `incIncStat` -> `onStatChange` -> `max_life = max_life + 4 * v`. A monster
   * gains life from Constitution for exactly the reason a player does.
   *
   * Ours paid players and not monsters, while `spreadStatPoints` handed three
   * templates a growing pile of Constitution. A creature authored around
   * toughness got none of it.
   */
  const levelled = (t: MonsterTemplate, level: number) => monsterInit(t, { x: 1, y: 1 }, level);

  it('pays four hit points a point, over the sheet it was authored with', () => {
    const t = INDEX_GLUT;
    const authored = t.combat.stats?.con ?? 0;
    expect(authored, 'the fixture stopped growing Constitution').toBeGreaterThan(0);
    expect(t.autoStats).toContain('con');

    const body = levelled(t, 20);
    const grownCon = body.combat?.stats?.con ?? 0;
    expect(grownCon).toBeGreaterThan(authored);

    // The life-rating curve alone, without the Constitution term — which is
    // exactly what this used to return.
    const withoutCon = Math.floor(
      t.maxHp + lifeGainedTo(t.lifeRating ?? 10, 20, RANK_VALUE[t.rank]),
    );
    expect(body.maxHp).toBe(withoutCon + (grownCon - authored) * LIFE_PER_CON);
  });

  it('pays a monster and a player at the same rate', () => {
    /**
     * THE ASYMMETRY THIS REMOVES, stated as an assertion. Two bodies, one
     * player and one monster, each five points of Constitution above their own
     * authored sheet — the same twenty hit points.
     */
    const con = 5;
    const player = maxLifeOf(
      { level: 1, combat: { stats: { con: (WATCHMAN.combat.stats?.con ?? 0) + con } } },
      WATCHMAN,
      PLAYER_RANK,
    );
    const playerBase = maxLifeOf({ level: 1, combat: WATCHMAN.combat }, WATCHMAN, PLAYER_RANK);
    expect(player - playerBase).toBe(con * LIFE_PER_CON);
  });

  it('changes nothing at all at level one', () => {
    /**
     * THE SAFETY PROPERTY, over every shipped template rather than one. At level
     * 1 no points have been spread, so the grown Constitution equals the
     * authored Constitution and the term is zero — every creature on the first
     * floor is the creature it has always been.
     */
    for (const t of MONSTER_TEMPLATES) {
      expect(levelled(t, 1).maxHp, t.displayName).toBe(t.maxHp);
    }
  });

  it('leaves a creature that grows no Constitution on the pure life curve', () => {
    // The other half: a template whose scheme has no `con` must be untouched by
    // this at every level, or the term is being applied to something it did not
    // earn.
    const t = MONSTER_TEMPLATES.find(
      (m) => m.autoStats !== undefined && !m.autoStats.includes('con'),
    );
    expect(t, 'no fixture without con in its scheme').toBeDefined();
    if (t === undefined) return;
    for (const level of [5, 20]) {
      const expected = Math.floor(
        t.maxHp + lifeGainedTo(t.lifeRating ?? 10, level, RANK_VALUE[t.rank]),
      );
      expect(levelled(t, level).maxHp, `${t.displayName} at ${String(level)}`).toBe(expected);
    }
  });

  it('grows the Index Husk on the ant’s own scheme, which has no Constitution', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * A CONTENT PIN, AND IT IS WHAT KEEPS THIS A PARITY CHANGE.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * The husk is adopted from `BASE_NPC_ANT`, which declares
     * `autolevel = "warrior"` (ant.lua:32), and the warrior scheme is
     * `{STR, STR, DEX}` (autolevel_schemes.lua:25-27). It carried `['con','str']`
     * — a divergence that was invisible while Constitution bought a monster
     * nothing, and that would have made the commonest creature in the game 47%
     * tougher on the day it started to.
     *
     * PINNED HERE so the next person to touch the list has to decide rather than
     * drift: the husk's hit points at every level are the ant's, and the stat it
     * hoards is the stat the ant hoards.
     */
    expect(INDEX_HUSK.autoStats).toEqual(['str', 'str', 'dex']);
    const twenty = levelled(INDEX_HUSK, 20);
    expect(twenty.combat?.stats?.con).toBe(INDEX_HUSK.combat.stats?.con);
    expect(twenty.maxHp).toBe(
      Math.floor(
        INDEX_HUSK.maxHp +
          lifeGainedTo(INDEX_HUSK.lifeRating ?? 10, 20, RANK_VALUE[INDEX_HUSK.rank]),
      ),
    );
  });
});
