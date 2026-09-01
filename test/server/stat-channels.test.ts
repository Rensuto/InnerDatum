// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// The rules under test are ported from t-engine4 game/modules/tome/class/Actor.lua:3881-3907.
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

import { describe, expect, it } from 'vitest';

import { WATCHMAN } from '../../src/server/content/classes.ts';
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
