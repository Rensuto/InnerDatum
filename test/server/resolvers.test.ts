import { describe, expect, it } from 'vitest';

import {
  resolveLevelup,
  resolveMBonus,
  resolveRngAvg,
} from '../../src/server/content/resolvers.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE THREE LEVEL-1 RESOLVERS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A ToME NPC entry is a table of numbers AND RESOLVERS — deferred computations
 * that `Entity:resolve()` runs at creation. `ant.lua:37` says
 *
 *     combat = { dam=resolvers.levelup(resolvers.rngavg(5,5), 1, 1), ... }
 *
 * and there is no reading that cold. These three functions exist so
 * content/monsters.ts can write the upstream expression verbatim next to its
 * citation instead of a magic number, and this file pins what each one answers.
 *
 * ALL THREE ARE PURE AND TAKE NO RNG. That is the decision recorded in the
 * header of src/server/content/resolvers.ts: `rng.avg` and `rng.mbonus` are C
 * functions and the reference clone HAS NO `src/` DIRECTORY, so their
 * distributions are not readable and any variance form would be an invention
 * wearing a port's citation. Because they take no generator, there is nothing to
 * script — the purity assertions below call each function twice with identical
 * arguments and compare, which is the whole of what "pure function of its
 * arguments" can mean for a function with no other inputs.
 */

describe('resolveRngAvg — engine/resolvers.lua:49-55', () => {
  it('collapses to the constant when x === y, which is the real call site', () => {
    // ant.lua:37 `resolvers.rngavg(5,5)`. x === y, so the distribution is a
    // point mass and the mean is EXACT — there is no approximation here at all.
    expect(resolveRngAvg(5, 5)).toBe(5);
  });

  it('takes the midpoint of a genuine range', () => {
    // ant.lua:59 `max_life = resolvers.rngavg(15,30)` — the giant brown ant's
    // life band, whose mean of 22.5 is what puts our held 25 inside it.
    expect(resolveRngAvg(15, 30)).toBe(22.5);
    // losgoroth.lua:63 `max_life = resolvers.rngavg(40,60)` — the number
    // content/monsters.ts records as "adopt on the day the damage sheet is
    // wired" rather than porting today.
    expect(resolveRngAvg(40, 60)).toBe(50);
  });

  it('is a pure function of its arguments', () => {
    expect(resolveRngAvg(15, 30)).toBe(resolveRngAvg(15, 30));
    expect(resolveRngAvg(5, 5)).toBe(resolveRngAvg(5, 5));
  });
});

describe('resolveMBonus — engine/resolvers.lua:84-92 + tome/resolvers.lua:586-587', () => {
  it('collapses to its `add` term at level 1', () => {
    // losgoroth.lua:30 `resolvers.mbonus(40, 15)`. ToME raises the engine's
    // `mbonus_max_level` from 50 to 90 (tome/resolvers.lua:587), so the
    // level-scaled term at level 1 is on the order of 40/90 ≈ 0.44 and the flat
    // `add` is the whole value.
    expect(resolveMBonus(40, 15)).toBe(15);
    // The `max` argument is deliberately unconsumed — same `add`, any ceiling.
    expect(resolveMBonus(9999, 15)).toBe(15);
  });

  it('is honest about the half-point it drops, rather than rounding it away', () => {
    // The port is exact to within about 0.4 of a point of weapon damage RATING,
    // which then goes under the square root at Combat.lua:1682-1687. Stated as
    // an inequality rather than as prose so that a future variance form has a
    // band to land inside: the true level-1 value is in [15, 15 + 40/90].
    const ported = resolveMBonus(40, 15);
    const upperBound = 15 + 40 / 90;
    expect(ported).toBeGreaterThanOrEqual(15);
    expect(upperBound - ported).toBeLessThan(0.45);
  });

  it('is a pure function of its arguments', () => {
    expect(resolveMBonus(40, 15)).toBe(resolveMBonus(40, 15));
    expect(resolveMBonus(20, 10)).toBe(resolveMBonus(20, 10));
  });
});

describe('resolveLevelup — engine/resolvers.lua:150-159', () => {
  it('returns its base, which is the whole of what upstream returns', () => {
    // `resolvers.calc.levelup` returns `t[1]` and does exactly one other thing:
    // append a record to `e._levelup_info` describing how the field should grow
    // LATER. Growth happens in `Actor:levelup()`, driven by `autolevel`, which
    // is out of scope. This identity IS the scope fence.
    expect(resolveLevelup(10)).toBe(10);
    expect(resolveLevelup(0)).toBe(0);
    expect(resolveLevelup(30)).toBe(30);
  });

  it('composes with the other two exactly as the Lua nests them', () => {
    // ant.lua:37      dam = resolvers.levelup(resolvers.rngavg(5,5), 1, 1)
    expect(resolveLevelup(resolveRngAvg(5, 5))).toBe(5);
    // losgoroth.lua:30 dam = resolvers.levelup(resolvers.mbonus(40, 15), 1, 1.2)
    expect(resolveLevelup(resolveMBonus(40, 15))).toBe(15);
  });

  it('is a pure function of its arguments', () => {
    expect(resolveLevelup(10)).toBe(resolveLevelup(10));
    expect(resolveLevelup(resolveMBonus(40, 15))).toBe(resolveLevelup(resolveMBonus(40, 15)));
  });
});
