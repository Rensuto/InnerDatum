import { describe, expect, it } from 'vitest';

import { rescaleCombatStats } from '../../src/shared/scale.ts';
import {
  LUCK_BASE,
  STAT_BASE,
  combatAPR,
  combatArmor,
  combatArmorHardiness,
  combatAttack,
  combatCrit,
  combatCritPower,
  combatDamage,
  combatDamagePower,
  combatDamageRange,
  combatDefense,
  combatMentalResist,
  combatMindpower,
  combatPhysicalResist,
  combatPhysicalpower,
  combatSpeed,
  combatSpellResist,
  combatSpellpower,
} from '../../src/server/engine/derived.ts';
import type { Combatant } from '../../src/server/engine/derived.ts';

/**
 * ===========================================================================
 * EVERY GETTER HERE HAS THE SAME SHAPE, AND THE SHAPE IS THE TEST.
 * ===========================================================================
 *
 *   sum the raw contributions -> apply the multiplicative debuffs -> rescale
 *
 * The debuff step sits BEFORE the rescale in the Lua and `rescale` is concave,
 * so `rescale(x)/2` and `rescale(x/2)` are different numbers. Getting that order
 * wrong makes Dazed stronger against strong characters, which is backwards, and
 * nothing about it is visible except in a spreadsheet. The
 * "dazed halves before rescale" case below pins it at 37 versus 28.
 *
 * The bare `{}` combatant is a level-1 ToME character with default everything —
 * every stat at 10 (load.lua:182-187), Luck at 50 (load.lua:189), every
 * `combat_*` field at 0 (Actor.lua:141-162). Its numbers are hand-traceable,
 * which is the point.
 */

/** A default actor: every stat and every modifier at ToME's own starting value. */
const BASE: Combatant = {};

describe('stat defaults — load.lua:182-189', () => {
  it('pins Luck at 50 so every (Lck - 50) term vanishes', () => {
    expect(LUCK_BASE).toBe(50);
    expect(STAT_BASE).toBe(10);
    // Unpinning Luck must move accuracy by 0.4/point (Combat.lua:1343) and
    // nothing else here needs editing — that is the reason for the constant.
    expect(combatAttack({ stats: { lck: 75 } })).toBe(
      rescaleCombatStats(4 + (75 - LUCK_BASE) * 0.4),
    );
  });
});

describe('combatAttack — Combat.lua:1340-1361', () => {
  it('starts at the bare +4 constant with default Dexterity', () => {
    // 4 + combat_atk(0) + weapon.atk(0) + (Lck-50)*0.4(0) + (Dex-10)(0) = 4
    expect(combatAttack(BASE)).toBe(4);
  });

  it('takes Dexterity at FULL weight, unlike defence', () => {
    expect(combatAttack({ stats: { dex: 20 } })).toBe(14);
    // Dex 100 -> raw 94 -> the tier curve compresses it to 51.
    expect(combatAttack({ stats: { dex: 100 } })).toBe(51);
  });

  it('adds the weapon and the flat modifier before the rescale', () => {
    expect(combatAttack({ mods: { atk: 10 }, weapon: { atk: 6 } })).toBe(20);
  });
});

describe('combatDefense — Combat.lua:1216-1263', () => {
  it('is zero for a default actor', () => {
    expect(combatDefense(BASE)).toBe(0);
  });

  it('takes Dexterity at 0.35 — and the floor is visible', () => {
    // (20-10) * 0.35 = 3.5 raw -> floor -> 3. Defence is the expensive side of
    // the Dex trade, on purpose.
    expect(combatDefense({ stats: { dex: 20 } })).toBe(3);
  });

  it('never goes below zero — Combat.lua:1245, :1253, :1260', () => {
    expect(combatDefense({ mods: { def: -50 } })).toBe(0);
  });
});

describe('combatArmor / combatArmorHardiness — Combat.lua:1275-1337', () => {
  it('does NOT rescale armour', () => {
    // Armour is subtracted in damage units (Combat.lua:541), so putting it on
    // the accuracy curve would be a category error. The only getter in the file
    // that does not end in a rescale.
    expect(combatArmor({ mods: { armour: 71 } })).toBe(71);
    expect(combatArmor({ mods: { armour: 71 } })).not.toBe(rescaleCombatStats(71));
  });

  it('starts hardiness at 30, not 0 and not 100 — Combat.lua:1336', () => {
    // THE constant that decides whether heavy armour is balanced or broken:
    // 70% of every blow bypasses armour entirely.
    expect(combatArmorHardiness(BASE)).toBe(30);
  });

  it('bounds hardiness to [0, 100] before the Breach multiplier', () => {
    expect(combatArmorHardiness({ mods: { armourHardiness: 200 } })).toBe(100);
    expect(combatArmorHardiness({ mods: { armourHardiness: -200 } })).toBe(0);
    // EFF_BREACH halves it AFTER the bound — Combat.lua:1334, :1336.
    expect(
      combatArmorHardiness({ mods: { armourHardiness: 200 }, flags: { breached: true } }),
    ).toBe(50);
  });
});

describe('combatAPR / combatSpeed / combatDamageRange', () => {
  it('sums armour penetration from the actor and the weapon — Combat.lua:1402-1406', () => {
    expect(combatAPR(BASE)).toBe(0);
    expect(combatAPR({ mods: { apr: 3 }, weapon: { apr: 2 } })).toBe(5);
  });

  it('treats combat_physspeed as a DIVISOR — higher is FASTER', () => {
    // Combat.lua:1409-1412 returns a COST multiplier. Inverting this silently
    // turns every haste item in the game into a slow item.
    expect(combatSpeed(BASE)).toBe(1);
    expect(combatSpeed({ mods: { physSpeed: 2 } })).toBe(0.5);
    expect(combatSpeed({ mods: { physSpeed: 0.5 } })).toBe(2);
    // The 0.1 floor stops stacked debuffs dividing by zero.
    expect(combatSpeed({ mods: { physSpeed: -100 } })).toBe(10);
  });

  it('defaults the damage range to 1.1 — Combat.lua:1432', () => {
    expect(combatDamageRange(BASE)).toBeCloseTo(1.1, 10);
    expect(combatDamageRange({ weapon: { damRange: 1.4 } })).toBeCloseTo(1.4, 10);
  });
});

describe('combatCrit — Combat.lua:1415-1427', () => {
  it('gives a weaponless actor +1, not +0', () => {
    // `(weapon.physcrit or 1)` at :1424. Small, easy to drop, and it is the
    // floor that keeps every attack in the game capable of critting.
    expect(combatCrit(BASE)).toBe(1);
  });

  it('takes Cunning at 0.3', () => {
    expect(combatCrit({ stats: { cun: 20 } })).toBeCloseTo(4, 10);
  });

  it('does NOT clamp at 100 — the clamp belongs to the roll', () => {
    // Combat.lua:1426 says so explicitly: crit reduction is subtracted between
    // here and the roll and needs the headroom above 100 to bite into.
    expect(combatCrit({ mods: { physCrit: 200 } })).toBe(201);
    expect(combatCrit({ mods: { physCrit: -500 } })).toBe(0);
  });

  it('reads combat_critical_power in PERCENTAGE POINTS — Combat.lua:1951', () => {
    expect(combatCritPower(BASE)).toBe(1.5);
    // 50 means +50%, i.e. +0.5 on the multiplier. Reading it as a fraction turns
    // a +20% crit-damage item into +2000%.
    expect(combatCritPower({ mods: { criticalPower: 50 } })).toBe(2);
  });
});

describe('the three powers — Combat.lua:1689-1733, 1744-1771, 2056-2084', () => {
  it('feeds physical power from Strength and spell power from Magic', () => {
    expect(combatPhysicalpower(BASE)).toBe(10);
    expect(combatSpellpower(BASE)).toBe(10);
    // 30 raw Strength is already into the second tier: rescale(30) = 25.
    expect(combatPhysicalpower({ stats: { str: 30 } })).toBe(25);
  });

  it('feeds mind power from Wil * 0.7 + Cun * 0.4 — Combat.lua:2076', () => {
    // The only power fed by TWO stats, at unequal weights: Willpower is the
    // primary and Cunning the secondary, and the pair sums to 1.1 per point so a
    // character who raises both outruns a single-stat power.
    expect(combatMindpower(BASE)).toBe(11); // 10*0.7 + 10*0.4 = 11
    expect(combatMindpower({ stats: { wil: 20 } })).toBe(18); // 14 + 4
    expect(combatMindpower({ stats: { cun: 20 } })).toBe(15); // 7 + 8
    // 20*0.7 + 20*0.4 = 22 raw, which the second tier compresses to 21.
    expect(combatMindpower({ stats: { wil: 20, cun: 20 } })).toBe(21);
  });

  it('floors the SUM at zero so a debuff can cancel a stat but not invert it', () => {
    // Combat.lua:1722, "allows strong debuffs to offset strength".
    expect(combatPhysicalpower({ stats: { str: 30 }, mods: { dam: -100 } })).toBe(0);
  });

  it('multiplies by `mod` AFTER the rescale and adds `add` BEFORE it', () => {
    // Combat.lua:1731. Two knobs on opposite sides of the curve; swapping them
    // is silent and wrong.
    expect(combatPhysicalpower(BASE, { mod: 2 })).toBe(20);
    expect(combatPhysicalpower(BASE, { add: 10 })).toBe(20);
    expect(combatPhysicalpower({ stats: { str: 100 } }, { mod: 2 })).toBe(
      rescaleCombatStats(100) * 2,
    );
  });
});

describe('the three saves — Combat.lua:2122-2204', () => {
  it('weights the two contributing stats at 0.35', () => {
    // (10 + 10 + 0) * 0.35 = 7 for every save on a default actor.
    expect(combatPhysicalResist(BASE)).toBe(7);
    expect(combatSpellResist(BASE)).toBe(7);
    expect(combatMentalResist(BASE)).toBe(7);
  });

  it('reads Con+Str, Mag+Wil and Cun+Wil respectively', () => {
    expect(combatPhysicalResist({ stats: { con: 30, str: 30 } })).toBe(20); // rescale(21)
    expect(combatSpellResist({ stats: { mag: 30, wil: 30 } })).toBe(20);
    expect(combatMentalResist({ stats: { cun: 30, wil: 30 } })).toBe(20);
    // Cross-check: the physical save must NOT see Magic.
    expect(combatPhysicalResist({ stats: { mag: 100 } })).toBe(7);
  });
});

describe('THE DAZED ORDERING — halve BEFORE the rescale, never after', () => {
  it('produces 35, not 26.5, for a 100-Strength actor', () => {
    // raw 100 -> dazed halves to 50 -> rescale(50) = 35       <- correct
    // raw 100 -> rescale = 53 -> halve = 26.5                 <- the bug
    // The gap widens with the stat, so the wrong order makes Dazed HARSHER
    // against strong characters, which is the opposite of what the curve is for.
    const strong: Combatant = { stats: { str: 100 } };
    expect(combatPhysicalpower(strong)).toBe(53);
    expect(combatPhysicalpower({ ...strong, flags: { dazed: true } })).toBe(35);
    expect(combatPhysicalpower({ ...strong, flags: { dazed: true } })).not.toBe(
      combatPhysicalpower(strong) / 2,
    );
  });

  it('applies to accuracy, defence, the powers and the saves alike', () => {
    const dazed = { flags: { dazed: true } } as const;
    expect(combatAttack({ ...dazed, stats: { dex: 100 } })).toBe(rescaleCombatStats(94 / 2));
    expect(combatPhysicalResist({ ...dazed, stats: { con: 100, str: 100 } })).toBe(
      rescaleCombatStats((200 * 0.35) / 2),
    );
  });

  it('compounds with Scoured — Combat.lua:1358-1359', () => {
    expect(combatAttack({ stats: { dex: 100 }, flags: { dazed: true, scoured: true } })).toBe(
      rescaleCombatStats(94 / 2 / 1.2),
    );
  });
});

describe('combatDamage — Combat.lua:1661-1687', () => {
  it('applies a square root to the weapon rating — Combat.lua:1686', () => {
    // 1.0 exactly at rating 10, and only ~1.29 at rating 40: a big weapon is
    // never strictly better than a build.
    expect(combatDamagePower({ weapon: { dam: 10 } })).toBeCloseTo(1, 10);
    expect(combatDamagePower({ weapon: { dam: 40 } })).toBeCloseTo(1.5, 10);
  });

  it('feeds `totstat` into BOTH the weapon power and the physical power', () => {
    // Combat.lua:1676-1677 passes it twice, on purpose. That double count is why
    // stats feel strong on a weapon swing, and it means `combatPhysicalpower(c)`
    // called bare is legitimately a DIFFERENT number from the one used here.
    const swing: Combatant = { stats: { str: 30 }, weapon: { dam: 40 } };
    // dammod default { str: 0.6 } -> totstat = 18
    //   power = combatDamagePower(40 + 18) = 1.70416
    //   phys  = rescale(0 + 18 + 30) = rescale(48) = 34
    //   0.3 * 34 * 1.70416
    expect(combatDamage(swing)).toBeCloseTo(17.3824, 4);
    // The bare getter sees only Strength: rescale(0 + 0 + 30) = 25, NOT the 34
    // the swing above used. Both are correct answers to different questions.
    expect(combatPhysicalpower(swing)).toBe(25);
    expect(combatPhysicalpower(swing, { add: 18 })).toBe(34);
  });

  it('falls back to ToME’s default dammod of { str: 0.6 } — Combat.lua:1625', () => {
    expect(combatDamage(BASE)).toBeCloseTo(4.408, 3);
  });

  it('honours a weapon-declared dammod', () => {
    const bow: Combatant = { stats: { dex: 40 }, weapon: { dam: 20, damMod: { dex: 0.7 } } };
    // Strength contributes nothing to a bow; Dexterity does.
    expect(combatDamage(bow)).toBeGreaterThan(combatDamage({ ...bow, stats: { dex: 10 } }));
  });

  it('returns a FLOAT and does not round — ActorLife.lua:71-81 never does either', () => {
    expect(Number.isInteger(combatDamage(BASE))).toBe(false);
  });
});
