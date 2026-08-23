import { describe, expect, it } from 'vitest';

import { ActorRank } from '../../src/shared/protocol.ts';
import {
  CAP_BONUS_CLASS_POINTS,
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
  STAT_MAX,
  canRaiseStat,
  statCeilingForLevel,
  NO_STAIRS_GAME_TURNS,
  stairsLockedFor,
  reentryHealFraction,
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

  it('rises monotonically to the cap, on the verbatim chart', () => {
    /**
     * THIS ASSERTED 2,700 — the whole-career total at a cap of 10, chosen as a
     * DESIGN TARGET ("an evening, about 145 kills"). The cap is 50 now and that
     * target is gone, so pinning its arithmetic would be pinning a decision
     * nobody is making any more.
     *
     * What survives is the property the chart is FOR: every level costs more
     * than the one before it, all the way up, with no plateau and no dip. That
     * is true of upstream at 50 and was true of us at 10.
     */
    let previous = 0;
    for (let level = 2; level <= MAX_CHARACTER_LEVEL; level += 1) {
      const cost = expChart(level);
      expect(
        cost,
        `level ${String(level)} costs no more than level ${String(level - 1)}`,
      ).toBeGreaterThan(previous);
      previous = cost;
    }
    // And the last one is the biggest, which is the same claim seen from the end.
    expect(expChart(MAX_CHARACTER_LEVEL)).toBe(previous);
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
    /**
     * DERIVED, NOT REMEMBERED. This was `1_000_000 - 2700`, where 2,700 was the
     * whole-career cost at a cap of 10. The cap is 50 now and the leftover is
     * whatever the verbatim chart consumed — asking the chart is the only form
     * of this assertion that survives the next cap change too.
     */
    let spent = 0;
    for (let level = 2; level <= MAX_CHARACTER_LEVEL; level += 1) spent += expChart(level);
    expect(wholeCareer.xp).toBe(1_000_000 - spent);
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

  it('grants a point every level, and a second every fifth', () => {
    /**
     * THIS ASSERTED 11 — the total at a cap of 10. The shape is what was
     * ported (Actor.lua:3749-3752), not the total, so the shape is what is
     * pinned: one point a level, and a second on every fifth.
     */
    // EVERY LEVEL BUT THE LAST. The cap pays 3 more on top (Actor.lua:3768) and
    // has its own test — see test/shared/cap-bonus.test.ts.
    for (let level = 2; level < MAX_CHARACTER_LEVEL; level += 1) {
      const expected = level % 5 === 0 ? 2 : 1;
      expect(pointsForLevel(level), `level ${String(level)}`).toBe(expected);
    }
    // Level 1 grants nothing — it is where a character starts, not a level-up.
    expect(pointsForLevel(1)).toBe(0);

    // The total is then arithmetic rather than a remembered number: one a level,
    // one more per fifth, and the cap bonus once.
    const fifths = Math.floor(MAX_CHARACTER_LEVEL / 5);
    expect(totalPointsAtLevel(MAX_CHARACTER_LEVEL)).toBe(
      MAX_CHARACTER_LEVEL - 1 + fifths + CAP_BONUS_CLASS_POINTS,
    );
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
  it('gives a budget the current content cannot absorb, which is the point', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THIS TEST USED TO ASSERT THE OPPOSITE, AND BOTH WERE RIGHT IN TURN.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * At a cap of 10 it asserted 11 points against 16 purchasable steps — a
     * player left about five unbought and HAD to choose, which was the whole
     * argument for a small cap.
     *
     * The cap is 50 now, for 1:1 with upstream, and the budget is far larger
     * than the twelve talents currently shipped can absorb. That is not a bug
     * to tune away — it is the gap the port exists to fill, and it is worth a
     * failing-loud number rather than a comment: when the content lands, this
     * assertion flips back on its own.
     */
    const budget = totalPointsAtLevel(MAX_CHARACTER_LEVEL);
    const shippedSteps = 12 * (TALENT_MAX_LEVEL - 1);
    expect(
      budget,
      'the budget no longer outruns the content — check whether the trees grew',
    ).toBeGreaterThan(shippedSteps);
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
  it('keeps ToME per-level pacing shape: each level costs more kills than the last', () => {
    /**
     * The companion test — "reaches level 10 in an evening, 130-160 kills" —
     * is GONE rather than renumbered. It pinned a session length, and a
     * fifty-level game is deliberately not one evening. Keeping it with new
     * bounds would be inventing a target nobody set.
     *
     * THIS one survives untouched in intent: whatever the cap, a level must
     * cost more than the one before it, or the curve has a plateau a player
     * will feel as the game stalling.
     */
    let previous = 0;
    for (let level = 2; level <= MAX_CHARACTER_LEVEL; level += 1) {
      const kills = expChart(level) / worthExp(level, ActorRank.Normal);
      expect(kills, `level ${String(level)} is cheaper than the one before`).toBeGreaterThan(
        previous,
      );
      previous = kills;
    }
  });

  it('a Boss is worth about thirty-one normals, as upstream priced it', () => {
    const boss = worthExp(5, ActorRank.Boss);
    const normal = worthExp(5, ActorRank.Normal);
    expect(boss / normal).toBeCloseTo(25 / 0.8, 10);
  });
});

describe('how high one attribute may go at this level', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * SPREAD EARLY, SPECIALISE LATE — LevelupDialog.lua:255-260.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Three points arrive every level. Without a ceiling all three go into one
   * attribute and a level-2 character is as strong in one direction as a level-6
   * one — which throws away the tuning this port exists to inherit.
   *
   * THIS FILE USED TO ARGUE THE OPPOSITE, and the note is worth keeping: it read
   * *"Both belong to the AUTO-LEVELLER … neither binds a human spending their
   * own points"*, written from `Actor.lua:755-756`, which IS the auto-leveller.
   * The same two clauses are also in `LevelupDialog:incStat` — the `+` a human
   * presses — with player-facing refusals. The Lua wins over our own document.
   */
  it('is the per-level pace below level 50', () => {
    // `level * 1.4 + 20`, unfloored — see `statCeilingForLevel`.
    expect(statCeilingForLevel(1)).toBeCloseTo(21.4);
    expect(statCeilingForLevel(10)).toBeCloseTo(34);
    expect(statCeilingForLevel(28)).toBeCloseTo(59.2);
  });

  it('becomes the lifetime bound where the two cross', () => {
    /**
     * `60 + max(0, level - 50)` overtakes the pace at level 29 (60.6 vs 60), and
     * from there it is the one that binds — which is why upstream tests both and
     * `AdvanceActor.lua:291` composes them with `min`.
     */
    expect(statCeilingForLevel(29)).toBe(60);
    expect(statCeilingForLevel(49)).toBe(60);
    // ...and only past 50 does it move again, one a level.
    expect(statCeilingForLevel(51)).toBe(61);
    expect(statCeilingForLevel(60)).toBe(70);
  });

  it('refuses at the ceiling and allows just under it', () => {
    // `>=` in the Lua, and the fraction is why the boundary is where it is: at
    // level 1 the ceiling is 21.4, so 21 may still be raised and 22 may not.
    expect(canRaiseStat(21, 1)).toBe(true);
    expect(canRaiseStat(22, 1)).toBe(false);
  });

  it('locks a class primary until the level catches up, exactly as upstream does', () => {
    /**
     * THE CASE A PLAYER MEETS FIRST, and it is not a bug. Our classes open at
     * 22-24 in their primary (`classes.ts` — Watchman str 24, Inspector dex 24),
     * which is already ABOVE the level-1 ceiling of 21.4 — and ToME's level-1
     * warriors are in the same position for the same reason. So the first few
     * points go into the other five, which is the whole shape of the rule.
     */
    expect(canRaiseStat(24, 2), 'level 2 ceiling is 22.8').toBe(false);
    expect(canRaiseStat(24, 3), 'level 3 ceiling is 24.2').toBe(true);
  });

  it('still refuses at the absolute maximum, whatever the level', () => {
    // The outer bound is its own fact — `STAT_MAX` would be right if every other
    // rule went away.
    expect(canRaiseStat(STAT_MAX, 999)).toBe(false);
  });
});

describe('the stairs shut for a moment after a kill', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * ANTI-STAIRSCUM — `changeLevelCheck`, Game.lua:879-884.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Walk in, kill the first thing, walk straight back out to a freshly generated
   * floor. It turns a delve into a slot machine — every easy fight taken, no
   * hard ones paid for — and it is the oldest exploit in the genre.
   */
  it('locks for upstream’s Normal-difficulty span', () => {
    // `noStairsTime` returns `nb * 10` engine turns with `nb = 2` on Normal, and
    // ten engine turns is one game turn — the same `TICKS_PER_GAME_TURN` this
    // engine runs on. So: two.
    expect(NO_STAIRS_GAME_TURNS).toBe(2);
  });

  it('counts the turn of the kill as one of the two', () => {
    // Upstream's comparison is `last_kill_turn >= turn - noStairsTime`, so the
    // kill's own turn is inside the window.
    expect(stairsLockedFor(10, 10)).toBe(2);
    expect(stairsLockedFor(10, 11)).toBe(1);
    expect(stairsLockedFor(10, 12)).toBe(0);
  });

  it('never locks a body that has not killed anything', () => {
    // Which is most bodies most of the time — and the field is ABSENT rather
    // than 0, because turn 0 is a real turn.
    expect(stairsLockedFor(undefined, 0)).toBe(0);
    expect(stairsLockedFor(undefined, 9999)).toBe(0);
  });

  it('does not lock on a stale kill from long ago', () => {
    expect(stairsLockedFor(3, 400)).toBe(0);
  });

  it('answers a count rather than a boolean, so the refusal can say it', () => {
    /**
     * "Not yet" with no number is a rule a player cannot plan around, and this
     * one lasts two turns — short enough that a number turns a refusal into a
     * wait. Upstream computes its own remaining count for the same reason
     * (Game.lua:881).
     */
    expect(stairsLockedFor(10, 10)).toBeGreaterThan(0);
    expect(typeof stairsLockedFor(10, 10)).toBe('number');
  });
});

describe('a floor recovers while nobody is standing on it', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE OTHER HALF OF ANTI-STAIRSCUM — Game.lua:1369-1388.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `NO_STAIRS_GAME_TURNS` stops you leaving immediately. This stops you gaining
   * by leaving at all: soften a room, walk out, rest to full outside, walk back
   * in to the same half-dead monsters. `Realm.sealed` already names that failure
   * — "'run away' and 'pause the fight' would be the same verb" — and closes it
   * for roaming encounters alone, by sealing them.
   */
  it('heals a tenth of maximum per game turn away', () => {
    // Upstream: `perc = bound(floor((turn - last_turn) / 10), 0, 10)` then
    // `max_life * perc / 10`. Its turn is engine ticks and ten of those are one
    // game turn, so `perc` IS game turns away.
    expect(reentryHealFraction(0)).toBe(0);
    expect(reentryHealFraction(1)).toBeCloseTo(0.1);
    expect(reentryHealFraction(5)).toBeCloseTo(0.5);
  });

  it('caps at whole, because ten turns away is a monster that is simply better', () => {
    expect(reentryHealFraction(10)).toBe(1);
    expect(reentryHealFraction(11)).toBe(1);
    expect(reentryHealFraction(10_000)).toBe(1);
  });

  it('floors a fraction rather than healing by part of a turn', () => {
    // `math.floor` upstream. Half a turn away is no turns away.
    expect(reentryHealFraction(0.9)).toBe(0);
    expect(reentryHealFraction(3.7)).toBeCloseTo(0.3);
  });

  it('never heals by a negative amount, whatever the clock says', () => {
    /**
     * `util.bound(..., 0, 10)` upstream, and the reason it matters HERE rather
     * than there: our absence is measured against the overworld's clock across a
     * realm boundary, so a reconnect or a rebuild could hand this a difference
     * that went backwards. Healing a monster by a negative fraction would DAMAGE
     * it, which is the exploit inverted.
     */
    expect(reentryHealFraction(-1)).toBe(0);
    expect(reentryHealFraction(-9999)).toBe(0);
  });

  it('answers zero for a clock that is not a number at all', () => {
    // Absent state arrives as NaN through arithmetic on `undefined`, and NaN
    // would propagate into `hp` and make a monster unkillable.
    expect(reentryHealFraction(Number.NaN)).toBe(0);
    expect(reentryHealFraction(Number.POSITIVE_INFINITY)).toBe(0);
  });
});
