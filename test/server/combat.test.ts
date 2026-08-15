import { describe, expect, it } from 'vitest';

import {
  AttackRefusal,
  attackTarget,
  canAttack,
  combatDistance,
} from '../../src/server/engine/combat.ts';
import { DamageType } from '../../src/server/engine/damage.ts';
import { TileCode } from '../../src/shared/protocol.ts';
import { createRng } from '../../src/shared/rng.ts';
import { drawCount, scriptedRng } from '../helpers/scripted-rng.ts';
import type {
  AttackResult,
  CombatActor,
  CombatSheet,
  CombatWorld,
} from '../../src/server/engine/combat.ts';
import type { LevelView } from '../../src/shared/protocol.ts';

/**
 * ===========================================================================
 * TWO THINGS ARE PINNED HERE AND THE REST IS ARITHMETIC.
 * ===========================================================================
 *
 *   1. THE DEAD ZONE. game-design.md § 2 calls the Inspector's `min_range 3`
 *      "the single most important number here" — the class cannot shoot an
 *      adjacent enemy, which is the whole reason the Watchman holding a choke is
 *      worth anything. Being inside it is a REFUSAL, never a miss, so the log
 *      can say "too close" instead of silently eating the turn.
 *
 *   2. RNG DISCIPLINE. A miss costs exactly ONE draw, because ToME's damage-range
 *      roll lives inside the `if checkHit` branch at Combat.lua:511. If a miss
 *      ever consumed two, every replay would diverge the first time anybody
 *      whiffed.
 *
 * The default combatant is a level-1 ToME character: accuracy 4 (the bare
 * constant at Combat.lua:1343), defence 0, so the to-hit chance is
 * ceil(50 + 2.5 * 4) = 60% and every number below is hand-traceable.
 */

const W = 12;

function openLevel(walls: readonly (readonly [number, number])[] = []): LevelView {
  const tiles = new Array<number>(W * W).fill(TileCode.FLOOR);
  for (const [x, y] of walls) tiles[y * W + x] = TileCode.WALL;
  return { w: W, h: W, tiles };
}

function world(walls: readonly (readonly [number, number])[] = []): CombatWorld {
  return { level: openLevel(walls) };
}

function actor(
  id: string,
  x: number,
  y: number,
  extra: { hp?: number; combat?: CombatSheet; attackRange?: number } = {},
): CombatActor {
  return {
    id,
    name: id,
    x,
    y,
    hp: extra.hp ?? 20,
    alive: true,
    attackRange: extra.attackRange,
    combat: extra.combat,
  };
}

/** The Inspector: reach 7, and a three-tile hole in the middle of it. */
const INSPECTOR: CombatSheet = { range: 7, minRange: 3 };

describe('combatDistance — EUCLIDEAN, matching core.fov.distance', () => {
  it('measures diagonals as longer than orthogonals', () => {
    // ToME uses two metrics on purpose: Chebyshev for A* step cost, Euclidean
    // for every range, radius and targeting ring (docs/tome-mechanics.md § 10).
    // A Chebyshev range 5 is a SQUARE that reaches 7.07 tiles into the corners.
    expect(combatDistance({ x: 0, y: 0 }, { x: 3, y: 0 })).toBe(3);
    expect(combatDistance({ x: 0, y: 0 }, { x: 3, y: 3 })).toBeCloseTo(4.2426, 4);
  });
});

describe('the dead zone — min_range, game-design.md § 2', () => {
  it('REFUSES a shot from inside it rather than missing', () => {
    const w = world();
    const inspector = actor('insp', 1, 1, { combat: INSPECTOR });

    expect(canAttack(inspector, actor('t', 2, 1), w)).toBe(AttackRefusal.MinRange);
    expect(canAttack(inspector, actor('t', 3, 1), w)).toBe(AttackRefusal.MinRange);
    // min_range 3 means 3 is the closest LEGAL tile — `<`, not `<=`.
    expect(canAttack(inspector, actor('t', 4, 1), w)).toBeNull();
  });

  it('cuts a CIRCULAR hole, not a square one', () => {
    const w = world();
    const inspector = actor('insp', 1, 1, { combat: INSPECTOR });
    // (3,3) is Chebyshev 2 and Euclidean 2.83 — inside either way.
    expect(canAttack(inspector, actor('t', 3, 3), w)).toBe(AttackRefusal.MinRange);
    // (4,3) is Euclidean 3.61: outside the hole, though a naive ring drawn at
    // Chebyshev 3 would put it right on the boundary.
    expect(canAttack(inspector, actor('t', 4, 3), w)).toBeNull();
  });

  it('costs zero RNG draws — a refusal is not a roll', () => {
    // The refund rule (game-design.md § 4) depends on this: an intent that went
    // illegal must cost nothing, and consuming a draw is a cost.
    const rng = scriptedRng([]);
    const result = attackTarget(
      actor('insp', 1, 1, { combat: INSPECTOR }),
      actor('t', 2, 1),
      world(),
      rng,
    );
    expect(result).toEqual({ ok: false, reason: AttackRefusal.MinRange });
    expect(drawCount(rng)).toBe(0);
  });

  it('does not apply to a melee actor, which has no hole at all', () => {
    expect(canAttack(actor('w', 1, 1), actor('t', 2, 1), world())).toBeNull();
  });
});

describe('reach and sight', () => {
  it('measures reach with the Euclidean metric', () => {
    const w = world();
    const archer = actor('a', 1, 1, { combat: { range: 5 } });
    // (5,5) is Chebyshev 4 — inside a square range 5 — but Euclidean 5.66.
    expect(canAttack(archer, actor('t', 5, 5), w)).toBe(AttackRefusal.OutOfRange);
    expect(canAttack(archer, actor('t', 5, 4), w)).toBeNull(); // 5.0 exactly
  });

  it('refuses to shoot through a wall', () => {
    const w = world([[4, 1]]);
    const inspector = actor('insp', 1, 1, { combat: INSPECTOR });
    expect(canAttack(inspector, actor('t', 6, 1), w)).toBe(AttackRefusal.NoLineOfSight);
    // Clear the wall and the same shot is legal.
    expect(canAttack(inspector, actor('t', 6, 1), world())).toBeNull();
  });

  it('refuses the degenerate targets', () => {
    const w = world();
    const me = actor('me', 1, 1);
    expect(canAttack(me, me, w)).toBe(AttackRefusal.Self);
    expect(canAttack(me, { ...actor('t', 2, 1), alive: false }, w)).toBe(AttackRefusal.TargetDead);
    expect(canAttack({ ...me, alive: false }, actor('t', 2, 1), w)).toBe(AttackRefusal.Dead);
  });
});

describe('attackTarget — the resolution order, Combat.lua:505-546', () => {
  it('reports the accuracy, defence and chance the combat log prints', () => {
    // game-design.md § 11: "Hits Bent Watchman (acc 41 vs def 33, 70%)".
    const result = attackTarget(actor('a', 1, 1), actor('t', 2, 1), world(), scriptedRng([1, 100]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // combatAttack({}) = 4 (Combat.lua:1343's bare constant), combatDefense({}) = 0
    expect(result.atk).toBe(4);
    expect(result.def).toBe(0);
    expect(result.chance).toBe(60);
  });

  it('resolves a plain hit end to end', () => {
    const target = actor('t', 2, 1);
    // Roll 1 -> hit. combatDamage({}) = 4.408, damrange 1.1 -> both endpoints
    // truncate to 4 so no range draw happens. Armour 0 at hardiness 30 -> 4.
    // Crit chance is 1 (the weaponless +1 at Combat.lua:1424); roll 100 misses it.
    const rng = scriptedRng([1, 100]);
    const result = attackTarget(actor('a', 1, 1), target, world(), rng);

    expect(result).toEqual({
      ok: true,
      targetId: 't',
      hit: true,
      atk: 4,
      def: 0,
      chance: 60,
      damage: 4,
      crit: false,
      killed: false,
      type: DamageType.Physical,
    });
    expect(target.hp).toBe(16);
    expect(drawCount(rng)).toBe(2);
  });

  it('MISSES for exactly one draw — Combat.lua:511 is inside the hit branch', () => {
    const target = actor('t', 2, 1);
    const rng = scriptedRng([61]); // 61 > 60
    const result = attackTarget(actor('a', 1, 1), target, world(), rng);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.hit).toBe(false);
    expect(result.damage).toBe(0);
    expect(target.hp).toBe(20);
    // If this ever becomes 2, every replay diverges the first time anybody whiffs.
    expect(drawCount(rng)).toBe(1);
  });

  it('crits AFTER armour, at the base x1.5 — Combat.lua:544, :1951', () => {
    const target = actor('t', 2, 1);
    const result = attackTarget(actor('a', 1, 1), target, world(), scriptedRng([1, 1]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.crit).toBe(true);
    expect(result.damage).toBe(6); // 4 x 1.5
  });

  it('…and the ORDER is visible in the HP, against a target that has armour', () => {
    // The test above only proves the multiplier; with 0 armour both orderings
    // give the same answer. THIS one separates them, end to end through
    // attackTarget rather than through resolveDamage directly:
    //
    //   dam 4 (combatDamage({}) = 4.408, both range endpoints truncate to 4)
    //   armour 2, hardiness 30 + 70 = 100 -> the whole blow is eligible
    //     CORRECT (armour then crit): (4 - 2) * 1.5 = 3
    //     WRONG   (crit then armour): (4 * 1.5) - 2 = 4
    //
    // Crit before armour makes armour a rounding error on any critical hit,
    // which quietly turns crit chance into the only defensive stat that matters.
    const armoured = actor('t', 2, 1, {
      combat: { mods: { armour: 2, armourHardiness: 70 } },
    });
    const rng = scriptedRng([1, 1]); // hit, then crit
    const result = attackTarget(actor('a', 1, 1), armoured, world(), rng);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.crit).toBe(true);
    expect(result.damage).toBe(3);
    expect(result.damage).not.toBe(4);
    expect(armoured.hp).toBe(17); // 20 - 3, the pipeline's answer and nothing else
    expect(drawCount(rng)).toBe(2);
  });

  it('applies the talent multiplier last — Combat.lua:546', () => {
    const result = attackTarget(
      actor('a', 1, 1),
      actor('t', 2, 1),
      world(),
      scriptedRng([1, 100]),
      {
        mult: 2,
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.damage).toBe(8);
  });

  it('honours the attacker’s declared damage type and lets a talent override it', () => {
    const alchemist = actor('a', 1, 1, { combat: { damageType: DamageType.Fire } });
    const plain = attackTarget(alchemist, actor('t', 2, 1), world(), scriptedRng([1, 100]));
    expect(plain.ok).toBe(true);
    if (plain.ok) expect(plain.type).toBe(DamageType.Fire);

    const overridden = attackTarget(alchemist, actor('t', 2, 1), world(), scriptedRng([1, 100]), {
      damtype: DamageType.Cold,
    });
    expect(overridden.ok).toBe(true);
    if (overridden.ok) expect(overridden.type).toBe(DamageType.Cold);
  });

  it('runs the target’s resistances through the same pipeline', () => {
    const resistant = actor('t', 2, 1, { combat: { profile: { resists: { physical: 50 } } } });
    const result = attackTarget(actor('a', 1, 1), resistant, world(), scriptedRng([1, 100]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.damage).toBe(2);
  });

  it('reports the kill exactly once and leaves the body in the world', () => {
    const dying = actor('t', 2, 1, { hp: 3 });
    const result = attackTarget(actor('a', 1, 1), dying, world(), scriptedRng([1, 100]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.killed).toBe(true);
    expect(result.damage).toBe(3); // clamped to remaining HP, so the log is honest
    expect(dying.alive).toBe(false);
    expect(dying.hp).toBe(0);
  });

  it('reports the kill ONCE — a second swing is refused, not a second death', () => {
    // The double-report is what a co-op turn makes easy: two players resolve in
    // the same sweep and both target the same body. The first swing kills it;
    // the second must come back as a REFUSAL (which the refund rule then makes
    // free) rather than as a hit with `killed: true` for a corpse.
    const dying = actor('t', 2, 1, { hp: 3 });
    const first = attackTarget(actor('a', 1, 1), dying, world(), scriptedRng([1, 100]));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.killed).toBe(true);
    expect(dying.alive).toBe(false);

    const rng = scriptedRng([]);
    const second = attackTarget(actor('b', 1, 2), dying, world(), rng);
    expect(second).toEqual({ ok: false, reason: AttackRefusal.TargetDead });
    // A refusal costs nothing — not a draw, not an HP point, not a second death.
    expect(drawCount(rng)).toBe(0);
    expect(dying.hp).toBe(0);
  });

  it('is DETERMINISTIC given a seed — same inputs, same swing, every time', () => {
    // The replay contract, end to end through checkHit, the range roll and the
    // crit. Two runs from one seed must agree on every field AND leave the two
    // bodies on identical HP; the seed is the only input either run has.
    const swing = (
      seed: string,
    ): { readonly log: readonly AttackResult[]; readonly hp: number } => {
      const rng = createRng(seed);
      const attacker = actor('a', 1, 1, { combat: { stats: { str: 24, dex: 16 } } });
      const target = actor('t', 2, 1, { hp: 500 });
      const w = world();
      const log: AttackResult[] = [];
      for (let i = 0; i < 40; i += 1) log.push(attackTarget(attacker, target, w, rng));
      return { log, hp: target.hp };
    };

    const first = swing('combat-determinism');
    const second = swing('combat-determinism');
    expect(second.log).toEqual(first.log);
    expect(second.hp).toBe(first.hp);

    // Not a degenerate sequence: the seed produced both outcomes, so the
    // equality above is a real claim about the stream rather than about a
    // constant.
    expect(first.log.some((r) => r.ok && r.hit)).toBe(true);
    expect(first.log.some((r) => r.ok && !r.hit)).toBe(true);

    // …and a different seed genuinely diverges, or the seed is being ignored.
    expect(swing('combat-determinism-2').log).not.toEqual(first.log);
  });

  it('applies the attacker’s accuracy bonus before the roll — Combat.lua:423', () => {
    const result = attackTarget(
      actor('a', 1, 1),
      actor('t', 2, 1),
      world(),
      scriptedRng([80, 100]),
      {
        atkBonus: 8,
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 4 + 8 = 12 accuracy vs 0 defence -> ceil(50 + 30) = 80, and an 80 lands.
    expect(result.chance).toBe(80);
    expect(result.hit).toBe(true);
  });

  it('lets a caller that already validated skip the legality checks', () => {
    // The scheduler needs the refusal as a REFUND REASON before it commits, so
    // it asks once and then resolves. This is not a way through a wall.
    const result = attackTarget(
      actor('insp', 1, 1, { combat: INSPECTOR }),
      actor('t', 2, 1),
      world(),
      scriptedRng([1, 100]),
      { skipLegality: true },
    );
    expect(result.ok).toBe(true);
  });
});
