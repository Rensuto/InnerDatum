import { describe, expect, it } from 'vitest';

import {
  DAMAGE_TYPES,
  DEFAULT_RESIST_CAP,
  DamageType,
  applyArmour,
  applyDamage,
  applyResists,
  combatGetDamageIncrease,
  combatGetFlatResist,
  combatGetResist,
  combatGetResistPen,
  resolveDamage,
  rollCrit,
  rollDamageRange,
} from '../../src/server/engine/damage.ts';
import { createRng } from '../../src/shared/rng.ts';
import { drawCount, scriptedRng } from '../helpers/scripted-rng.ts';
import type { DamageProfile, DamageTarget } from '../../src/server/engine/damage.ts';

/**
 * ===========================================================================
 * THE ORDER IS THE BALANCE, AND EVERY STAGE LOOKS COMMUTATIVE.
 * ===========================================================================
 *
 * Three things in this file are the reason it exists:
 *
 *   1. THE RESIST CLAMPS (Combat.lua:2227-2228). Without them the composition
 *      formula INVERTS above 100 and a heavily-resistant target takes MORE
 *      damage. docs/tome-mechanics.md § 8 quotes the formula without them.
 *   2. CRIT COMES AFTER ARMOUR (Combat.lua:541 then :544). Reversed, armour
 *      becomes a rounding error on any critical hit.
 *   3. THE RANGE ROLL COMES FIRST (Combat.lua:511). Rolled after armour, a
 *      high-armour target turns variance into a threshold.
 *
 * None of the three produces a crash, a type error or a failing plumbing test.
 */

const OPEN: DamageProfile = {};

describe('the damage-type registry', () => {
  it('ships six types and is an as-const object, not an enum', () => {
    // `erasableSyntaxOnly` is on because Node type-strips these files and runs
    // them directly — an enum would not survive to runtime.
    expect(DAMAGE_TYPES).toHaveLength(6);
    expect(DAMAGE_TYPES).toContain(DamageType.Physical);
    expect(DAMAGE_TYPES).toContain(DamageType.Fire);
    expect(DAMAGE_TYPES).toContain(DamageType.Mind);
  });
});

describe('combatGetResist — Combat.lua:2220-2231', () => {
  it('composes `all` and the typed row MULTIPLICATIVELY', () => {
    // 50% all and 50% fire is 75%, not 100%. This is what stops stacked
    // resistance sources from reaching immunity by simple addition.
    expect(combatGetResist({ resists: { all: 50, fire: 50 } }, DamageType.Fire)).toBe(75);
    // toBeCloseTo, not toBe: `1 - (1 - 0) * (1 - 0.3)` is 0.30000000000000004 in
    // binary floating point, exactly as it is in Lua. Rounding it here would be
    // a deviation from upstream for no gain.
    expect(combatGetResist({ resists: { fire: 30 } }, DamageType.Fire)).toBeCloseTo(30, 10);
    // ...and the fire rows must not touch cold.
    expect(combatGetResist({ resists: { fire: 30 } }, DamageType.Cold)).toBe(0);
  });

  it('CLAMPS EACH ROW AT 100 — Combat.lua:2227-2228, the inversion guard', () => {
    // ═══ THE TEST THIS FILE EXISTS FOR ═══
    // resists { all: 200, fire: 200 } against the engine default cap of 100:
    //   WITH the clamps:  a = 1, b = 1 -> 100*(1 - 0*0)     = 100  -> immune
    //   WITHOUT:          a = 2, b = 2 -> 100*(1 - (-1*-1)) = 0    -> full damage
    // Two negative factors multiply to a positive one and the resistance falls
    // straight back through zero. Upstream's own comment at :2227 says exactly
    // this: "Prevent large numbers from inverting the resist formulas".
    const overResistant: DamageProfile = { resists: { all: 200, fire: 200 } };
    expect(combatGetResist(overResistant, DamageType.Fire)).toBe(100);
    expect(applyResists(100, combatGetResist(overResistant, DamageType.Fire), 0)).toBe(0);
  });

  it('never inverts at ANY pair of values, which is the general form of the bug', () => {
    let previous = Number.NEGATIVE_INFINITY;
    for (let pct = 0; pct <= 400; pct += 10) {
      const res = combatGetResist({ resists: { all: pct, fire: pct } }, DamageType.Fire);
      expect(res).toBeGreaterThanOrEqual(previous);
      previous = res;
    }
    expect(previous).toBe(100);
  });

  it('caps at `resists_cap.all + resists_cap[type]` — Combat.lua:2229', () => {
    // 70 is a PLAYER birth descriptor (data/birth/descriptors.lua:63), not an
    // engine constant. Actor.lua:211 defaults monsters to { all = 100 }.
    expect(DEFAULT_RESIST_CAP).toBe(100);
    expect(
      combatGetResist({ resists: { fire: 90 }, resistsCap: { all: 70 } }, DamageType.Fire),
    ).toBe(70);
    // The two cap rows SUM, unlike the resist rows, which compose.
    expect(
      combatGetResist(
        { resists: { fire: 95 }, resistsCap: { all: 70, fire: 20 } },
        DamageType.Fire,
      ),
    ).toBe(90);
  });

  it('floors vulnerability at -100 so it cannot run away', () => {
    expect(combatGetResist({ resists: { fire: -50 } }, DamageType.Fire)).toBe(-50);
    expect(combatGetResist({ resists: { fire: -500 } }, DamageType.Fire)).toBe(-100);
  });
});

describe('applyResists — damage_types.lua:345-352', () => {
  it('makes PENETRATION MULTIPLICATIVE, not subtractive', () => {
    // 10 penetration against 30 resistance leaves 27, not 20. Implementers
    // reflexively write subtraction, and the result is penetration gear that
    // feels dead at low resistance and broken at high.
    expect(applyResists(100, 30, 10)).toBeCloseTo(73, 10);
    expect(applyResists(100, 30, 10)).not.toBeCloseTo(80, 10);
    expect(applyResists(100, 30, 100)).toBeCloseTo(100, 10);
  });

  it('never lets penetration deepen a vulnerability — `if res > 0`', () => {
    expect(applyResists(100, -50, 50)).toBeCloseTo(150, 10);
  });

  it('zeroes at 100 and doubles at -100', () => {
    expect(applyResists(100, 100, 0)).toBe(0);
    expect(applyResists(100, -100, 0)).toBe(200);
  });

  it('bounds penetration to [0, 100] before applying it', () => {
    expect(applyResists(100, 30, -50)).toBeCloseTo(70, 10);
    expect(applyResists(100, 30, 500)).toBeCloseTo(100, 10);
  });
});

describe('combatGetFlatResist — Combat.lua:2213-2217', () => {
  it('rescales on the interval-40 curve, NOT the default 20', () => {
    // flat.all + flat[type] = 50 raw. On the 40 curve that is 45; on the default
    // 20 curve it would be 35, and a flat-armour actor would quietly lose ten
    // points of reduction against every hit in the game.
    expect(combatGetFlatResist({ flatDamageArmour: { all: 20, fire: 30 } }, DamageType.Fire)).toBe(
      45,
    );
  });

  it('is zero when the actor has no flat armour at all', () => {
    expect(combatGetFlatResist(OPEN, DamageType.Fire)).toBe(0);
  });
});

describe('the additive tables', () => {
  it('sums penetration across `all` and the typed row — Combat.lua:2234-2238', () => {
    expect(combatGetResistPen({ all: 10, fire: 15 }, DamageType.Fire)).toBe(25);
    expect(combatGetResistPen(undefined, DamageType.Fire)).toBe(0);
  });

  it('sums damage increase the same way — Combat.lua:2252-2256', () => {
    expect(combatGetDamageIncrease({ all: 20, fire: 30 }, DamageType.Fire)).toBe(50);
  });
});

describe('applyArmour — Combat.lua:540-541', () => {
  it('bites only into the HARDINESS fraction of the blow', () => {
    // dam 20, armour 10, hardiness 30 -> max(6 - 10, 0) + 14 = 14.
    // Ten armour against a 20-point blow removes SIX, not ten, and the other 70%
    // of the blow was never eligible to be blocked.
    expect(applyArmour(20, 10, 0, 30)).toBeCloseTo(14, 10);
    expect(applyArmour(20, 3, 0, 30)).toBeCloseTo(17, 10);
  });

  it('is NOT plain `dam - armour`', () => {
    // Plain subtraction makes a 6-armour level-3 tank unkillable.
    expect(applyArmour(20, 10, 0, 30)).not.toBeCloseTo(10, 10);
  });

  it('leaves the non-hardy fraction intact no matter how much armour there is', () => {
    // 100 armour against a 20-point blow still lets 70% through.
    expect(applyArmour(20, 100, 0, 30)).toBeCloseTo(14, 10);
    // ...unless hardiness is 100, which is what makes hardiness the real stat.
    expect(applyArmour(20, 100, 0, 100)).toBe(0);
  });

  it('subtracts penetration from ARMOUR — subtractive here, unlike resist pen', () => {
    // Two penetration stats, two different algebras. Combat.lua:540 vs :347.
    expect(applyArmour(20, 10, 5, 30)).toBeCloseTo(15, 10);
    // Over-penetration cannot make armour negative.
    expect(applyArmour(20, 10, 999, 30)).toBeCloseTo(20, 10);
  });

  it('clamps hardiness into [0, 1] — Combat.lua:506', () => {
    expect(applyArmour(20, 5, 0, 500)).toBe(15);
    expect(applyArmour(20, 5, 0, -500)).toBe(20);
  });
});

describe('rollDamageRange — Combat.lua:511', () => {
  it('TRUNCATES both endpoints, because rng.range takes ints', () => {
    // ToME's rng.range is native C; luaL_checknumber -> int truncates toward
    // zero at both ends. 12.7 .. 20.3 is a uniform integer in [12, 20], and the
    // roll is where float damage first becomes an integer.
    const low = scriptedRng([12]);
    expect(rollDamageRange(12.7, 20.3 / 12.7, low, 'test')).toBe(12);

    const rng = createRng('damage-range');
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < 2000; i += 1) {
      const v = rollDamageRange(12.7, 1.6, rng, 'test');
      min = Math.min(min, v);
      max = Math.max(max, v);
    }
    expect(min).toBe(12);
    expect(max).toBe(Math.trunc(12.7 * 1.6)); // 20
  });

  it('does not draw at all when the two endpoints collapse — the C does the same', () => {
    const rng = scriptedRng([]);
    expect(rollDamageRange(4, 1.1, rng, 'test')).toBe(4);
    expect(drawCount(rng)).toBe(0);
  });
});

describe('rollCrit — Combat.lua:1935-1952', () => {
  it('clamps the chance HERE, not in combatCrit', () => {
    // Combat.lua:1426 leaves headroom above 100 on purpose so crit reduction has
    // something to bite into; :1935 is where it is finally bounded.
    expect(rollCrit(10, 500, 1.5, scriptedRng([100]), 'test')).toEqual({ dam: 15, crit: true });
    expect(rollCrit(10, -500, 1.5, scriptedRng([1]), 'test')).toEqual({ dam: 10, crit: false });
  });

  it('draws unconditionally, even at 0% and 100%', () => {
    const certain = scriptedRng([100]);
    rollCrit(10, 100, 1.5, certain, 'test');
    expect(drawCount(certain)).toBe(1);

    const never = scriptedRng([1]);
    rollCrit(10, 0, 1.5, never, 'test');
    expect(drawCount(never)).toBe(1);
  });
});

describe('resolveDamage — THE ORDERED PIPELINE', () => {
  it('applies the crit AFTER armour — Combat.lua:541 then :544', () => {
    // base 20, armour 5, hardiness 100, crit x1.5:
    //   CORRECT (armour then crit): (20 - 5) * 1.5           = 22.5
    //   WRONG   (crit then armour): (20 * 1.5) - 5           = 25
    // The gap is armour * (critPower - 1) and it grows with both.
    const out = resolveDamage(
      {
        base: 20,
        type: DamageType.Physical,
        armour: 5,
        hardiness: 100,
        critChance: 100,
        critPower: 1.5,
      },
      OPEN,
      scriptedRng([1]),
      'test',
    );
    expect(out.crit).toBe(true);
    expect(out.amount).toBeCloseTo(22.5, 10);
    expect(out.amount).not.toBeCloseTo(25, 10);
  });

  it('rolls the damage range BEFORE armour — Combat.lua:508-511', () => {
    // base 20, range 1.5, armour 25, hardiness 100. Rolling first, a high roll
    // of 30 punches 5 through the armour. Rolling AFTER, 20 - 25 clamps to 0 and
    // the roll can only ever produce 0 — the variance has become a threshold,
    // which is precisely what upstream's comment at :509 warns about.
    const out = resolveDamage(
      { base: 20, type: DamageType.Physical, damageRange: 1.5, armour: 25, hardiness: 100 },
      OPEN,
      scriptedRng([30]),
      'test',
    );
    expect(out.amount).toBeCloseTo(5, 10);
  });

  it('skips the stages it was not given, and consumes no draws for them', () => {
    // A talent that deals exact damage omits `damageRange`; a spell omits
    // `armour` — ToME has never reduced a spell by armour, because the armour
    // stage lives in attackTargetWith and not in the projector.
    const rng = scriptedRng([]);
    const out = resolveDamage({ base: 20, type: DamageType.Fire }, OPEN, rng, 'test');
    expect(out.amount).toBe(20);
    expect(drawCount(rng)).toBe(0);
  });

  it('treats inc_damage as ADDITIVE percentages — damage_types.lua:270', () => {
    const out = resolveDamage(
      { base: 100, type: DamageType.Fire, increase: { all: 20, fire: 30 } },
      OPEN,
      scriptedRng([]),
      'test',
    );
    // +20% and +30% is +50%, not +56%.
    expect(out.amount).toBeCloseTo(150, 10);
  });

  it('compounds the source debuffs — damage_types.lua:146-153', () => {
    const out = resolveDamage(
      { base: 100, type: DamageType.Physical, sourceDazed: true, sourceStunned: true },
      OPEN,
      scriptedRng([]),
      'test',
    );
    // Dazed x0.5 then Stunned x0.4.
    expect(out.amount).toBeCloseTo(20, 10);
  });

  it('takes `numbed` off as a percentage — damage_types.lua:158-160', () => {
    // `dam = dam - dam * numbed / 100`. Off-balance, the physical cross-tier
    // debuff, is the only thing that sets it: 15 means you deal 85%.
    const out = resolveDamage(
      { base: 100, type: DamageType.Physical, sourceNumbed: 15 },
      OPEN,
      scriptedRng([]),
      'test',
    );
    expect(out.amount).toBeCloseTo(85, 10);
  });

  it('and `numbed` COMPOUNDS with the two flags, in upstream`s order', () => {
    /**
     * damage_types.lua applies each in turn to the running total — Dazed at
     * :146-148, Stunned at :150-153, `numbed` at :158-160. So a dazed, stunned,
     * off-balance attacker deals `100 × 0.5 × 0.4 × 0.85`, not `100 × (1 − 0.5 −
     * 0.6 − 0.15)`. Additive stacking would floor at zero and would have made an
     * off-balance stun a total silence.
     */
    const out = resolveDamage(
      {
        base: 100,
        type: DamageType.Physical,
        sourceDazed: true,
        sourceStunned: true,
        sourceNumbed: 15,
      },
      OPEN,
      scriptedRng([]),
      'test',
    );
    expect(out.amount).toBeCloseTo(17, 10);
  });

  it('subtracts flat armour AFTER the percentages — damage_types.lua:404-409', () => {
    const out = resolveDamage(
      { base: 100, type: DamageType.Fire },
      { resists: { fire: 50 }, flatDamageArmour: { fire: 50 } },
      scriptedRng([]),
      'test',
    );
    // 100 -> 50% resist -> 50 -> minus rescale(50, 40) = 45 -> 5.
    // Applied before the percentages it would be (100 - 45) * 0.5 = 27.5, and
    // flat armour would be worth five times less against a resisted element.
    expect(out.amount).toBeCloseTo(5, 10);
  });

  it('never drives damage negative through flat armour', () => {
    const out = resolveDamage(
      { base: 3, type: DamageType.Fire },
      { flatDamageArmour: { fire: 500 } },
      scriptedRng([]),
      'test',
    );
    expect(out.amount).toBe(0);
  });

  it('NEVER returns a negative amount, however the stages are stacked', () => {
    // A negative amount would reach `applyDamage` and HEAL the target — the
    // same class of bug as the missing resist clamps, arriving from four other
    // directions at once. Each of the four floors below is a separate `max(…, 0)`
    // in the Lua, so this sweep fails loudly whichever one is dropped:
    //   armour   Combat.lua:541          `math.max(dam * pres - armor, 0)`
    //   resists  damage_types.lua:347    `if res >= 100 then dam = 0`
    //   flat     damage_types.lua:404    `math.min(dam, dec)` before subtracting
    //   clamps   Combat.lua:2227-2228    the inversion guard
    const HOSTILE_PROFILES: readonly DamageProfile[] = [
      OPEN,
      { resists: { all: 100 } },
      { resists: { all: 200, physical: 200 } },
      { resists: { physical: 90 }, flatDamageArmour: { all: 200 } },
      { flatDamageArmour: { all: 500, physical: 500 } },
      { resists: { physical: -100 }, flatDamageArmour: { physical: 60 } },
    ];

    for (const target of HOSTILE_PROFILES) {
      for (const base of [0, 1, 3, 12, 40]) {
        for (const armour of [0, 5, 50, 500]) {
          const out = resolveDamage(
            {
              base,
              type: DamageType.Physical,
              armour,
              hardiness: 100,
              apr: 0,
              mult: 0.5,
              sourceStunned: true,
            },
            target,
            scriptedRng([]),
            'test',
          );
          expect(out.amount).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });

  it('draws in the order range -> crit, so a replay can be diffed by ordinal', () => {
    const rng = scriptedRng([25, 1]);
    const out = resolveDamage(
      {
        base: 20,
        type: DamageType.Physical,
        damageRange: 1.5,
        critChance: 100,
        critPower: 2,
      },
      OPEN,
      rng,
      'test',
    );
    // 25 from the range roll, then the crit doubles it.
    expect(out.amount).toBeCloseTo(50, 10);
    expect(drawCount(rng)).toBe(2);
  });
});

describe('applyDamage — step 9, ActorLife.lua:71-81', () => {
  const victim = (hp: number, profile?: DamageProfile): DamageTarget => ({
    hp,
    alive: true,
    combat: profile === undefined ? undefined : { profile },
  });

  it('removes HP and reports what actually landed', () => {
    const target = victim(50);
    const out = applyDamage(target, 12, DamageType.Physical, { id: 'a' }, scriptedRng([]));
    expect(out.dealt).toBeCloseTo(12, 10);
    expect(out.killed).toBe(false);
    expect(target.hp).toBeCloseTo(38, 10);
    expect(target.alive).toBe(true);
  });

  it('kills at zero and leaves the body in the world', () => {
    const target = victim(10);
    const out = applyDamage(target, 61, DamageType.Physical, { id: 'a' }, scriptedRng([]));
    expect(out.killed).toBe(true);
    expect(target.alive).toBe(false);
    expect(target.hp).toBe(0);
    // `dealt` is clamped to remaining HP so the log's "45 -> 0" is honest;
    // `raw` keeps the uncapped figure. ToME returns the uncapped value only.
    expect(out.dealt).toBe(10);
    expect(out.raw).toBe(61);
  });

  it('reads the target’s resist profile off its combat sheet', () => {
    const target = victim(100, { resists: { fire: 50 } });
    const out = applyDamage(target, 40, DamageType.Fire, { id: 'a' }, scriptedRng([]));
    expect(out.dealt).toBeCloseTo(20, 10);
    // ...and the same profile must not resist a different element.
    const cold = applyDamage(
      victim(100, { resists: { fire: 50 } }),
      40,
      DamageType.Cold,
      { id: 'a' },
      scriptedRng([]),
    );
    expect(cold.dealt).toBeCloseTo(40, 10);
  });

  it('deals nothing to a corpse but still consumes its draws', () => {
    // The stream must not depend on whether the target happened to die first,
    // or a replay diverges the moment two players race the same kill.
    const corpse: DamageTarget = { hp: 0, alive: false };
    const rng = scriptedRng([25, 100]);
    const out = applyDamage(corpse, 20, DamageType.Physical, { id: 'a' }, rng, {
      damageRange: 1.5,
      critChance: 50,
    });
    expect(out.dealt).toBe(0);
    expect(out.killed).toBe(false);
    expect(drawCount(rng)).toBe(2);
  });

  it('fires `killed` exactly once, so the death event cannot double up', () => {
    const target = victim(5);
    const first = applyDamage(target, 10, DamageType.Physical, { id: 'a' }, scriptedRng([]));
    const second = applyDamage(target, 10, DamageType.Physical, { id: 'a' }, scriptedRng([]));
    expect(first.killed).toBe(true);
    expect(second.killed).toBe(false);
    expect(second.dealt).toBe(0);
  });

  it('reports the kill ONCE across a whole party piling onto one body', () => {
    // The real shape of the bug: four players resolve in the same turn and the
    // scheduler emits a `death` event per `killed: true`. Two of them and the
    // client draws two corpses, the log says it died twice, and the Alchemist
    // is paid two Reagents for one kill (engine/talents.ts `noteKill`).
    const target = victim(9);
    const outcomes = [4, 4, 4, 4, 4].map((blow) =>
      applyDamage(target, blow, DamageType.Physical, { id: 'party' }, scriptedRng([])),
    );

    expect(outcomes.filter((out) => out.killed)).toHaveLength(1);
    // …and it is the blow that actually crossed zero: 4 + 4 leaves 1, the third
    // swing takes it.
    expect(outcomes.map((out) => out.killed)).toEqual([false, false, true, false, false]);
    expect(outcomes.map((out) => out.dealt)).toEqual([4, 4, 1, 0, 0]);
    expect(target.hp).toBe(0);
    expect(target.alive).toBe(false);
  });

  it('never drives HP below zero, and never reports more damage than the body had', () => {
    // `dealt` is what the log prints ("Wraith 9 -> 0"), so an uncapped figure
    // would be a lie in the one place a player can check it. `raw` keeps the
    // uncapped number for anything that needs it (ToME returns only that one).
    for (const overkill of [10, 100, 10_000]) {
      const target = victim(9);
      const out = applyDamage(target, overkill, DamageType.Physical, { id: 'a' }, scriptedRng([]));
      expect(target.hp).toBe(0);
      expect(out.dealt).toBe(9);
      expect(out.raw).toBe(overkill);
    }
  });

  it('a heavily-resisted blow deals zero rather than healing the target', () => {
    // The end-to-end form of the Combat.lua:2227-2228 bug: without the clamps
    // this target's 200% resistance composes back down to 0% and it takes FULL
    // damage; with a sign error somewhere it would gain HP instead. Neither.
    const target = victim(40, { resists: { all: 200, fire: 200 } });
    const out = applyDamage(target, 25, DamageType.Fire, { id: 'a' }, scriptedRng([]));
    expect(out.dealt).toBe(0);
    expect(out.killed).toBe(false);
    expect(target.hp).toBe(40);
  });
});
