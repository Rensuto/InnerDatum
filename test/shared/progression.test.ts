import { describe, expect, it } from 'vitest';

import { ActorRank } from '../../src/shared/protocol.ts';
import {
  MAX_CHARACTER_LEVEL,
  RANK_WORTH,
  TALENT_MAX_LEVEL,
  XP_WORTH_MULT,
  expChart,
  gainExp,
  pointsForLevel,
  rankWorth,
  totalPointsAtLevel,
  worthExp,
} from '../../src/shared/progression.ts';

/**
 * ===========================================================================
 * THE CURVE IS A GOLDEN TABLE, NOT A SHAPE ASSERTION.
 * ===========================================================================
 *
 * `expChart` is nine lines of Lua ported verbatim from load.lua:193-206, and
 * the one thing about it that every reader wants to "tidy" is the accumulator:
 * it multiplies by `level` (the TARGET level, a loop invariant), not by the
 * loop variable `i`. That tidy compiles, lints, reads better, and re-tunes the
 * entire game — level 10 falls from 703 to 425 and the evening halves.
 *
 * So the nine integers below are pinned individually. A failing row names the
 * exact level that moved, and no refactor of the loop can change the game's
 * pacing without turning this file red first.
 */
describe('expChart — load.lua:193-206', () => {
  /**
   * Evaluated from the Lua directly. Each row is the xp needed to advance FROM
   * `level - 1` TO `level` — never a cumulative total.
   */
  const CHART: readonly (readonly [level: number, needed: number])[] = [
    [2, 27],
    [3, 61],
    [4, 110],
    [5, 174],
    [6, 254],
    [7, 346],
    [8, 453],
    [9, 572],
    [10, 703],
  ];

  it.each(CHART)('expChart(%i) === %i — pinned against the Lua', (level, needed) => {
    expect(expChart(level)).toBe(needed);
  });

  it('sums to 2700 over the whole career, which is the only cumulative number', () => {
    const total = CHART.reduce((acc, [, needed]) => acc + needed, 0);
    expect(total).toBe(2700);

    // And the same sum computed through the function, so the table above cannot
    // drift away from the implementation while still agreeing with itself.
    let walked = 0;
    for (let level = 2; level <= MAX_CHARACTER_LEVEL; level++) walked += expChart(level);
    expect(walked).toBe(2700);
  });

  it('is strictly increasing over 2..10 — a later level is never cheaper', () => {
    for (let level = 3; level <= MAX_CHARACTER_LEVEL; level++) {
      expect(expChart(level)).toBeGreaterThan(expChart(level - 1));
    }
  });

  it('runs zero iterations at level 1 and returns the seed, 10', () => {
    // `for i = 2, 1` does not execute in Lua either. gainExp never asks for it —
    // it only ever calls expChart(level + 1) with level >= 1 — but a port that
    // silently threw here would be wrong in a way nothing else would show.
    expect(expChart(1)).toBe(10);
  });

  it('is integral: math.ceil at load.lua:205 is not decoration', () => {
    // Level 3 is 60.4 before the ceil. Drop it and every threshold in the game
    // sits a hair low, which fails nothing and quietly shortens the campaign.
    for (let level = 2; level <= MAX_CHARACTER_LEVEL; level++) {
      expect(Number.isInteger(expChart(level))).toBe(true);
    }
  });
});

describe('worthExp — Actor.lua:6513-6531, with the killer-level substitution', () => {
  it('pays killerLevel * 0.8 * 4 for a Normal', () => {
    expect(worthExp(1, ActorRank.Normal)).toBeCloseTo(1 * 0.8 * XP_WORTH_MULT, 10);
    expect(worthExp(7, ActorRank.Normal)).toBeCloseTo(7 * 0.8 * XP_WORTH_MULT, 10);
  });

  it('pays killerLevel * 3 * 4 for an Elite', () => {
    expect(worthExp(1, ActorRank.Elite)).toBeCloseTo(1 * 3 * XP_WORTH_MULT, 10);
    expect(worthExp(7, ActorRank.Elite)).toBeCloseTo(7 * 3 * XP_WORTH_MULT, 10);
  });

  it('pays killerLevel * 25 * 4 for a Boss', () => {
    expect(worthExp(1, ActorRank.Boss)).toBeCloseTo(1 * 25 * XP_WORTH_MULT, 10);
    expect(worthExp(7, ActorRank.Boss)).toBeCloseTo(7 * 25 * XP_WORTH_MULT, 10);
  });

  it('keeps the upstream rank ratios exactly — 0.8 / 3 / 25', () => {
    // These three are Actor.lua:6522, :6523 and :6526 to the digit. The other
    // four rows upstream (critter, rare, unique, elite boss) are absent because
    // the RANKS are absent from protocol.ts, not because the numbers changed.
    expect(rankWorth(ActorRank.Normal)).toBe(0.8);
    expect(rankWorth(ActorRank.Elite)).toBe(3);
    expect(rankWorth(ActorRank.Boss)).toBe(25);
    expect(Object.keys(RANK_WORTH)).toHaveLength(3);
  });

  it('is linear in the KILLER level, which is the deviation, stated', () => {
    // Upstream this coefficient is the VICTIM's level. Ours is the killer's,
    // because every husk on our single hand-authored map is level 1 forever.
    // If this ever stops being linear in the first argument, the pacing test
    // below is measuring something else than it claims to.
    expect(worthExp(4, ActorRank.Normal)).toBeCloseTo(4 * worthExp(1, ActorRank.Normal), 10);
  });
});

describe('gainExp — ActorLevel.lua:95-107', () => {
  it('accumulates below the threshold without levelling', () => {
    const out = gainExp(1, 0, 20);
    expect(out).toEqual({ level: 1, xp: 20, levelsGained: 0 });
  });

  it('levels exactly at the threshold and resets xp to the remainder', () => {
    // expChart(2) is 27; 27 in, level 2 out, nothing left over.
    expect(gainExp(1, 0, 27)).toEqual({ level: 2, xp: 0, levelsGained: 1 });
    expect(gainExp(1, 0, 30)).toEqual({ level: 2, xp: 3, levelsGained: 1 });
  });

  /**
   * THE SUBTRACT-NOT-ACCUMULATE RULE, and the multi-level crossing, in one.
   *
   * A cumulative implementation passes every single-level test above and then
   * levels a character on every kill once they pass 2,700. This is the test
   * that tells the two apart.
   */
  it('crosses several levels in ONE award and carries the correct remainder', () => {
    // 200 xp at level 1, walked by hand against the chart:
    //   200 - 27 (expChart 2) = 173 -> level 2
    //   173 - 61 (expChart 3) = 112 -> level 3
    //   112 - 110 (expChart 4) = 2  -> level 4
    //   2 < 174 (expChart 5), stop.
    const out = gainExp(1, 0, 200);
    expect(out.level).toBe(4);
    expect(out.levelsGained).toBe(3);
    expect(out.xp).toBe(200 - 27 - 61 - 110);
    expect(out.xp).toBe(2);
  });

  it('clamps a negative award at zero and never un-levels', () => {
    // damage_types.lua:2417 drains xp; ActorLevel.lua:97's math.max(0, ...) is
    // what stops a drain from going negative or rolling a level back.
    expect(gainExp(3, 10, -50)).toEqual({ level: 3, xp: 0, levelsGained: 0 });
    expect(gainExp(3, 100, -40)).toEqual({ level: 3, xp: 60, levelsGained: 0 });
  });

  it('stops at MAX_CHARACTER_LEVEL and KEEPS the overflow xp', () => {
    // The loop guard is `level < MAX_CHARACTER_LEVEL`, so a capped character
    // banks xp forever. That figure is what the panel draws as a full bar;
    // zeroing it would make a level-10 bar flicker empty after every kill.
    const capped = gainExp(MAX_CHARACTER_LEVEL, 0, 100_000);
    expect(capped.level).toBe(MAX_CHARACTER_LEVEL);
    expect(capped.levelsGained).toBe(0);
    expect(capped.xp).toBe(100_000);

    // And a single award big enough to run the whole career still stops at 10
    // rather than sailing past it.
    const wholeCareer = gainExp(1, 0, 1_000_000);
    expect(wholeCareer.level).toBe(MAX_CHARACTER_LEVEL);
    expect(wholeCareer.levelsGained).toBe(MAX_CHARACTER_LEVEL - 1);
    expect(wholeCareer.xp).toBe(1_000_000 - 2700);
  });
});

describe('talent points — Actor.lua:3749-3752', () => {
  it('grants nothing at level 1: that is where a character starts', () => {
    expect(pointsForLevel(1)).toBe(0);
    expect(totalPointsAtLevel(1)).toBe(0);
  });

  it('grants 2 on every fifth level and 1 otherwise', () => {
    expect(pointsForLevel(5)).toBe(2);
    expect(pointsForLevel(6)).toBe(1);
    expect(pointsForLevel(10)).toBe(2);
    expect(pointsForLevel(2)).toBe(1);
    expect(pointsForLevel(4)).toBe(1);
  });

  it('totals 11 at the cap: 9 from levels 2-10, plus 1 each at level 5 and level 10', () => {
    expect(totalPointsAtLevel(MAX_CHARACTER_LEVEL)).toBe(11);
  });

  /**
   * THE BUDGET IS THE DESIGN, so it is a test rather than a comment.
   *
   * 11 points against 4 loadout talents x 4 upgrade steps each = 16 steps, or
   * 69%. Every player finishes an evening with about five steps unbought and
   * had to choose which — which is the only thing that makes the panel worth
   * opening. Restoring ToME's birth grant of 2 (Actor.lua:171) puts it at 81%
   * and the panel becomes a checklist.
   */
  it('leaves the talent budget short of the full tree — 11 of 16 steps', () => {
    const LOADOUT_SIZE = 4;
    const stepsPerTalent = TALENT_MAX_LEVEL - 1;
    const purchasable = LOADOUT_SIZE * stepsPerTalent;

    expect(purchasable).toBe(16);
    expect(totalPointsAtLevel(MAX_CHARACTER_LEVEL)).toBeLessThan(purchasable);
    expect(totalPointsAtLevel(MAX_CHARACTER_LEVEL) / purchasable).toBeLessThan(0.75);
  });

  it('is monotone: a level never takes a point away', () => {
    for (let level = 2; level <= MAX_CHARACTER_LEVEL; level++) {
      expect(pointsForLevel(level)).toBeGreaterThan(0);
      expect(totalPointsAtLevel(level)).toBeGreaterThan(totalPointsAtLevel(level - 1));
    }
  });
});

/**
 * ===========================================================================
 * PACING. THIS TEST IS THE GAME DESIGN, EXPRESSED AS AN ASSERTION.
 * ===========================================================================
 *
 * The audience is 3-6 friends playing ONE EVENING. The curve is ToME's,
 * untouched; the award side deviates (killer level instead of victim level,
 * times ToME's own `exp_worth_mult` at 4) precisely so that the number below
 * lands where an evening lands.
 *
 * Ported verbatim against our flat level-1 roster it would be 3,375 kills.
 * Change either `expChart` or `XP_WORTH_MULT` and this fails LOUDLY, here, in
 * a second — rather than being discovered by four people three hours into a
 * session that is not going to finish.
 */
describe('PACING — kills from level 1 to the cap', () => {
  it('reaches level 10 in an evening: between 130 and 160 normal kills', () => {
    let level = 1;
    let xp = 0;
    let kills = 0;

    // The real loop: award what a kill actually pays, then run the real
    // gainExp. No shortcut arithmetic, because a shortcut would not notice a
    // change to the subtract-not-accumulate rule.
    while (level < MAX_CHARACTER_LEVEL && kills < 100_000) {
      const gain = gainExp(level, xp, worthExp(level, ActorRank.Normal));
      level = gain.level;
      xp = gain.xp;
      kills += 1;
    }

    expect(level).toBe(MAX_CHARACTER_LEVEL);
    // 145 as measured; the band is deliberately wide enough to survive a
    // rounding change and narrow enough to catch a re-tune.
    expect(kills).toBeGreaterThanOrEqual(130);
    expect(kills).toBeLessThanOrEqual(160);
  });

  it('keeps ToME per-level pacing shape: each level costs more kills than the last', () => {
    // Kills-to-next-level runs 8.4, 9.5, 11.5, 13.6, 15.9, 18.0, 20.2, 22.3,
    // 24.4. The RATIOS are upstream's, because only a scalar changed; a rescaled
    // curve would have flattened them.
    let previous = 0;
    for (let level = 1; level < MAX_CHARACTER_LEVEL; level++) {
      const killsForLevel = expChart(level + 1) / worthExp(level, ActorRank.Normal);
      expect(killsForLevel).toBeGreaterThan(previous);
      previous = killsForLevel;
    }
    expect(previous).toBeGreaterThan(20);
    expect(previous).toBeLessThan(30);
  });

  it('a Boss is worth about thirty-one normals, as upstream priced it', () => {
    const boss = worthExp(5, ActorRank.Boss);
    const normal = worthExp(5, ActorRank.Normal);
    expect(boss / normal).toBeCloseTo(25 / 0.8, 10);
  });
});
