import { describe, expect, it } from 'vitest';

import { checkHit, checkHitOld, hitChance } from '../../src/shared/checkhit.ts';
import { createRng } from '../../src/shared/rng.ts';
import { drawCount, scriptedRng } from '../helpers/scripted-rng.ts';
import type { HitCheck } from '../../src/shared/checkhit.ts';

/**
 * ===========================================================================
 * TWO FUNCTIONS, TWO CURVES, AND ONE LINE THE DOCS DROPPED.
 * ===========================================================================
 *
 * `checkHit` (Combat.lua:337) resolves attacks. `checkHitOld` (Combat.lua:277)
 * resolves SAVES and is still live — Actor.lua:7003 calls it for every status in
 * the game. Deleting it because of its name is the obvious mistake.
 *
 * The vector that matters most here is `checkHitOld(0, 0)`. docs/tome-mechanics.md
 * § 3 quotes the function without line 281's `if atk == 0 then atk = 1 end`, and
 * that one line is worth FIFTY PERCENTAGE POINTS of save chance on exactly the
 * actor a not-yet-tuned monster hands you.
 */
describe('hitChance — Combat.lua:338-347, the arithmetic without the roll', () => {
  it('reproduces the numbers printed in the design doc combat log', () => {
    // game-design.md § 11: "Hits Bent Watchman (acc 41 vs def 33, 70%)"
    expect(hitChance(41, 33)).toBe(70);
    // and: "Miss (acc 28 vs def 44, 10%)"
    expect(hitChance(28, 44)).toBe(10);
  });

  it('is 50% at parity and 2.5 points per rescaled point either side', () => {
    expect(hitChance(0, 0)).toBe(50);
    expect(hitChance(30, 30)).toBe(50);
    expect(hitChance(34, 30)).toBe(60);
    expect(hitChance(26, 30)).toBe(40);
  });

  it('CEILS rather than rounds — Combat.lua:346', () => {
    // 50 + 2.5 = 52.5. Rounding gives 52; ceil gives 53, and the half-point
    // always favours the attacker.
    expect(hitChance(41, 40)).toBe(53);
    expect(hitChance(40, 41)).toBe(48);
  });

  it('clamps negative inputs to zero — Combat.lua:338-339', () => {
    expect(hitChance(-50, -50)).toBe(50);
    expect(hitChance(-50, 0)).toBe(50);
  });

  it('bounds to [0, 100] by default and to whatever a status talent passes', () => {
    expect(hitChance(100, 0)).toBe(100);
    expect(hitChance(0, 100)).toBe(0);
    // Status talents pass (0,95) or (5,95) so nothing is ever a certainty.
    expect(hitChance(100, 0, { min: 5, max: 95 })).toBe(95);
    expect(hitChance(0, 100, { min: 5, max: 95 })).toBe(5);
  });

  it('spans the whole 0-100 range across 40 points — which is why rescale exists', () => {
    // Feed it RAW stats and the accuracy game disappears: a raw 80 against a raw
    // 20 is a guaranteed hit with 100 points of headroom thrown away.
    expect(hitChance(20, 0)).toBe(100);
    expect(hitChance(0, 20)).toBe(0);
  });
});

describe('checkHit — Combat.lua:337-350', () => {
  it('hits when the roll is at or under the chance, and reports the margin', () => {
    const hit = checkHit(41, 33, scriptedRng([70]), 'test');
    expect(hit).toEqual({ hit: true, chance: 70, roll: 70, margin: 0 });

    const miss = checkHit(41, 33, scriptedRng([71]), 'test');
    expect(miss).toEqual({ hit: false, chance: 70, roll: 71, margin: -1 });
  });

  it('draws exactly once, even when the outcome is already decided', () => {
    // A short-circuit at 0% or 100% would skip a draw and desynchronise every
    // subsequent roll in the turn against a replay.
    const certain = scriptedRng([50]);
    expect(checkHit(100, 0, certain, 'test').hit).toBe(true);
    expect(drawCount(certain)).toBe(1);

    const impossible = scriptedRng([1]);
    expect(checkHit(0, 100, impossible, 'test').hit).toBe(false);
    expect(drawCount(impossible)).toBe(1);
  });

  it('rolls a d100 with both ends inclusive', () => {
    const rng = createRng('checkhit-distribution');
    let low = Number.POSITIVE_INFINITY;
    let high = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < 5000; i += 1) {
      const { roll } = checkHit(20, 20, rng, 'test');
      low = Math.min(low, roll);
      high = Math.max(high, roll);
    }
    expect(low).toBe(1);
    expect(high).toBe(100);
  });

  it('returns a margin whose SIGN says hit or miss, and whose size says by how much', () => {
    // Actor.lua:7006 turns this into a DURATION at M4: `mean_pct =
    // (100 - savechance) * 1.1`, so failing narrowly must be distinguishable
    // from failing badly. Retrofitting a second return value later would mean
    // touching every call site in the engine at the exact moment the status
    // system is the thing being debugged — hence it is here at M3.
    const landed = checkHit(41, 33, scriptedRng([12]), 'test');
    expect(landed.hit).toBe(true);
    expect(landed.margin).toBe(58); // chance 70 - roll 12, POSITIVE on a hit
    expect(landed.margin).toBe(landed.chance - landed.roll);

    const whiffed = checkHit(41, 33, scriptedRng([95]), 'test');
    expect(whiffed.hit).toBe(false);
    expect(whiffed.margin).toBe(-25); // NEGATIVE, and by 25 rather than by 1
    expect(whiffed.margin).toBe(whiffed.chance - whiffed.roll);

    // The boundary: a roll exactly equal to the chance is a HIT with margin 0,
    // because ToME's rng.percent is `rand_range(1,100) <= v`.
    const exact = checkHit(41, 33, scriptedRng([70]), 'test');
    expect(exact).toEqual({ hit: true, chance: 70, roll: 70, margin: 0 });
  });

  it('is MONOTONIC in accuracy — more power never lowers the chance', () => {
    // The property that makes a ToME character sheet readable: "+4 accuracy"
    // means "+10% to hit" against everything, forever. A curve that dipped
    // anywhere would make a strictly better item read as a downgrade.
    for (let def = 0; def <= 60; def += 5) {
      let previous = -1;
      for (let atk = 0; atk <= 120; atk += 1) {
        const chance = hitChance(atk, def);
        expect(chance).toBeGreaterThanOrEqual(previous);
        previous = chance;
      }
    }

    // …and the same roll can never turn a hit into a miss as accuracy rises.
    // Swept with a FIXED roll, which is what isolates the curve from the die.
    for (const roll of [1, 25, 50, 75, 100]) {
      let everHit = false;
      for (let atk = 0; atk <= 80; atk += 1) {
        const { hit } = checkHit(atk, 20, scriptedRng([roll]), 'test');
        if (hit) everHit = true;
        // Once it starts landing at this roll it must keep landing.
        expect(everHit && !hit).toBe(false);
      }
    }
  });

  it('is DETERMINISTIC: one seed, one sequence of results, on any machine', () => {
    // The replay contract. Given a run seed and an action log the engine must
    // reproduce a world exactly, months later — so two generators built from
    // the same seed and fed the same calls must agree draw for draw.
    const runOnce = (): readonly HitCheck[] => {
      const rng = createRng('checkhit-determinism');
      const out: HitCheck[] = [];
      for (let i = 0; i < 200; i += 1) {
        out.push(checkHit(30 + (i % 7), 28, rng, 'combat.checkhit'));
      }
      return out;
    };

    const first = runOnce();
    const second = runOnce();
    expect(second).toEqual(first);
    // Not a degenerate stream: it really did produce both outcomes.
    expect(first.some((check) => check.hit)).toBe(true);
    expect(first.some((check) => !check.hit)).toBe(true);

    // A DIFFERENT seed must not reproduce it, or the seed is being ignored.
    const other = createRng('checkhit-determinism-2');
    const rolls = Array.from({ length: 200 }, (_, i) =>
      checkHit(30 + (i % 7), 28, other, 'combat.checkhit'),
    );
    expect(rolls).not.toEqual(first);

    // Saves round-trip too: restoring a cursor continues the same stream
    // rather than restarting it, which is what makes a reload replayable.
    const source = createRng('checkhit-resume');
    checkHit(20, 20, source, 'combat.checkhit');
    const saved = source.getState();
    const after = checkHit(20, 20, source, 'combat.checkhit');
    const restored = createRng('unrelated-seed');
    restored.setState(saved);
    expect(checkHit(20, 20, restored, 'combat.checkhit')).toEqual(after);
  });

  it('lands near the stated chance over many rolls', () => {
    const rng = createRng('checkhit-rate');
    let hits = 0;
    const trials = 20000;
    for (let i = 0; i < trials; i += 1) {
      if (checkHit(30, 30, rng, 'test').hit) hits += 1;
    }
    // 50% at parity. Wide band on purpose — this is a smoke test on the
    // comparison direction, not a statistics exam.
    expect(hits / trials).toBeGreaterThan(0.47);
    expect(hits / trials).toBeLessThan(0.53);
  });
});

describe('checkHitOld — Combat.lua:277-293, the SAVE curve', () => {
  it('promotes atk 0 to 1 — Combat.lua:281, THE LINE docs/tome-mechanics.md § 3 drops', () => {
    const { chance } = checkHitOld(0, 0, scriptedRng([50]), 'test');
    expect(chance).toBeCloseTo(76.7827, 4);
    // Without the promotion the `two` term collapses to atk/(atk+def) = 0 and
    // the guard on the next line hides it, giving 50 * (0.5 + 0) = 25.
    expect(chance).not.toBeCloseTo(25, 1);
  });

  it('is exactly 50% at parity', () => {
    // one = 1/(1+e^0) = 0.5, two = atk/(atk+def) = 0.5.
    const { chance } = checkHitOld(50, 50, scriptedRng([50]), 'test');
    expect(chance).toBeCloseTo(50, 10);
  });

  it('saturates far more slowly than checkHit', () => {
    // This is the whole reason both curves exist. At a 20-point gap the linear
    // curve is already at 100%; the logistic one is nowhere near its ceiling.
    expect(hitChance(30, 10)).toBe(100);
    expect(checkHitOld(30, 10, scriptedRng([50]), 'test').chance).toBeLessThan(90);
  });

  it('bounds to [5, 95] by default, so no save is ever certain either way', () => {
    expect(checkHitOld(100, 0, scriptedRng([50]), 'test').chance).toBe(95);
    expect(checkHitOld(0, 100, scriptedRng([50]), 'test').chance).toBe(5);
  });

  it('guards the 0/0 division — Combat.lua:287', () => {
    // Reachable only through the min/max bounds, since :281 makes atk >= 1.
    const { chance } = checkHitOld(0, 0, scriptedRng([50]), 'test', { min: 0, max: 100 });
    expect(Number.isFinite(chance)).toBe(true);
  });

  it('carries the margin M4 needs for partial-save duration scaling', () => {
    // Actor.lua:7006: mean_pct = (100 - savechance) * 1.1. Called as
    // checkHitOld(save, apply_power), so `hit: true` means the effect was
    // RESISTED and `chance` is the save chance the duration divides into 100.
    const resisted = checkHitOld(50, 50, scriptedRng([10]), 'test');
    expect(resisted.hit).toBe(true);
    expect(resisted.margin).toBeCloseTo(40, 10);

    const failed = checkHitOld(50, 50, scriptedRng([90]), 'test');
    expect(failed.hit).toBe(false);
    // Failed by 40 points -> a much shorter surviving duration than failing by 1.
    expect(failed.margin).toBeCloseTo(-40, 10);
  });

  it('matches the hand-computed logistic values', () => {
    expect(checkHitOld(0, 10, scriptedRng([50]), 'test').chance).toBeCloseTo(15.3744, 4);
    expect(checkHitOld(20, 10, scriptedRng([50]), 'test').chance).toBeCloseTo(73.6673, 4);
  });
});
