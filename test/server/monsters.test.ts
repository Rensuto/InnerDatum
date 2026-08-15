import { describe, expect, it } from 'vitest';

import { decideNpcAction } from '../../src/server/ai/npc.ts';
import {
  INDEX_HUSK,
  INDEX_HUSK_ELITE,
  INDEX_WRAITH,
  MONSTER_TEMPLATES,
  monsterById,
  monsterInit,
  validateTemplate,
} from '../../src/server/content/monsters.ts';
import {
  IntentKind,
  createMonsterActor,
  createPlayerActor,
} from '../../src/server/engine/actor.ts';
import { AttackRefusal, canAttack, combatDistance } from '../../src/server/engine/combat.ts';
import { DamageType, applyResists, combatGetResist } from '../../src/server/engine/damage.ts';
import {
  combatArmor,
  combatArmorHardiness,
  combatAttack,
  combatCrit,
  combatDamage,
  combatDamageRange,
  combatDefense,
} from '../../src/server/engine/derived.ts';
import { toActorView } from '../../src/server/view/projector.ts';
import { chebyshev } from '../../src/shared/coords.ts';
import { hitChance } from '../../src/shared/checkhit.ts';
import { ActorRank } from '../../src/shared/protocol.ts';
import { createRng } from '../../src/shared/rng.ts';
import type { MonsterTemplate } from '../../src/server/content/monsters.ts';
import type { AiCtx } from '../../src/server/ai/npc.ts';
import type { EngineActor, Intent, MonsterActor } from '../../src/server/engine/actor.ts';
import type { TileXY } from '../../src/shared/coords.ts';
import type { LevelView } from '../../src/shared/protocol.ts';
import type { Rng } from '../../src/shared/rng.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE M3 ROSTER: THREE STAT BLOCKS AND THE TWO BEHAVIOURS THAT EARN A RING
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Every derived number below sits next to the citation it came from, because
 * that is the only way a stat block stays honest: the authored source says
 * `attack_power: 8`, the ToME curve turns that into 6.3637 damage a swing, and
 * the day someone "tidies" a Strength the diff shows a number moving rather than
 * a comment moving.
 *
 * The AI half is here rather than in ai.test.ts on purpose. `huntsIsolated` and
 * `shoulderAfter` are ROSTER facts — they are what `index_husk_elite` is — and
 * testing them against the real template rather than a fixture is what proves
 * the elite in the encounter table is the elite that was designed.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A rectangular room with a solid border. Everything inside is floor. */
function openRoom(w: number, h: number): LevelView {
  const tiles: number[] = [];
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const edge = x === 0 || y === 0 || x === w - 1 || y === h - 1;
      tiles.push(edge ? 1 : 0);
    }
  }
  return { w, h, tiles };
}

function rowsToLevel(rows: readonly string[]): LevelView {
  const h = rows.length;
  const w = rows[0]?.length ?? 0;
  const tiles: number[] = [];
  for (const row of rows) {
    for (let x = 0; x < w; x += 1) tiles.push(row.charAt(x) === '.' ? 0 : 1);
  }
  return { w, h, tiles };
}

function passableIn(rows: readonly string[]): (x: number, y: number) => boolean {
  return (x, y) => {
    const row = rows[y];
    if (row === undefined || x < 0 || x >= row.length) return false;
    return row.charAt(x) === '.';
  };
}

function spawn(template: MonsterTemplate, id: string, at: TileXY): MonsterActor {
  const actor = createMonsterActor(id, monsterInit(template, at));
  if (actor.kind !== 'monster') throw new Error('createMonsterActor returned a player');
  return actor;
}

function detective(id: string, at: TileXY) {
  return createPlayerActor(id, { name: id, sprite: 'chr_player_watchman_s', x: at.x, y: at.y });
}

/**
 * The AI's whole view of the world, hand-built — the same shape the scheduler
 * assembles, with `visibleEnemies` NEAREST FIRST and ties broken by id.
 */
function aiCtx(
  isPassable: (x: number, y: number) => boolean,
  actors: readonly EngineActor[],
  rng: Rng,
): AiCtx {
  return {
    isPassable,
    actorAt: (x, y) => actors.find((actor) => actor.alive && actor.x === x && actor.y === y),
    visibleEnemies: (self) => {
      const seen = actors
        .filter((actor) => actor.alive && actor.kind !== self.kind)
        .map((actor) => ({ actor, distance: chebyshev(self, actor) }))
        .filter((entry) => entry.distance <= self.ai.aggroRange);
      seen.sort((a, b) => {
        if (a.distance !== b.distance) return a.distance - b.distance;
        return a.actor.id < b.actor.id ? -1 : 1;
      });
      return seen.map((entry) => entry.actor);
    },
    rng,
  };
}

/** Apply a move intent the way the world would. Anything else leaves the tile alone. */
function applyMove(actor: { x: number; y: number }, intent: Intent): void {
  if (intent.kind !== IntentKind.Move) return;
  const vectors: Record<string, TileXY> = {
    n: { x: 0, y: -1 },
    ne: { x: 1, y: -1 },
    e: { x: 1, y: 0 },
    se: { x: 1, y: 1 },
    s: { x: 0, y: 1 },
    sw: { x: -1, y: 1 },
    w: { x: -1, y: 0 },
    nw: { x: -1, y: -1 },
  };
  const v = vectors[intent.dir];
  if (v === undefined) throw new Error(`unknown dir ${intent.dir}`);
  actor.x += v.x;
  actor.y += v.y;
}

// ---------------------------------------------------------------------------
// The templates themselves
// ---------------------------------------------------------------------------

describe('the roster is well formed', () => {
  it('is exactly the three types M3 asks for', () => {
    // PLAN.md § M3: "three enemy types (melee chaser, ranged kiter, one elite)".
    // Four would be scope creep and two would be an unmet definition of done.
    expect(MONSTER_TEMPLATES.map((t) => `${t.id}/${t.profile}/${t.rank}`)).toEqual([
      'index_husk/melee_chaser/normal',
      'index_wraith/ranged_kiter/normal',
      'index_husk_elite/melee_chaser/elite',
    ]);
    expect(monsterById('index_wraith')).toBe(INDEX_WRAITH);
    expect(monsterById('index_cairn')).toBeUndefined();
  });

  it('passes every invariant the type system cannot state', () => {
    for (const template of MONSTER_TEMPLATES) {
      expect({ id: template.id, problems: validateTemplate(template) }).toEqual({
        id: template.id,
        problems: [],
      });
    }
  });

  it('gives every creature ONE dead zone, read by two different systems', () => {
    // `ai.minRange` makes a kiter give ground; `combat.minRange` makes
    // `canAttack` refuse the shot. If they ever differ, the monster walks to a
    // tile it then refuses to fire from — every turn, forever — and it reads as
    // the server being broken rather than as the creature having a weakness.
    for (const template of MONSTER_TEMPLATES) {
      expect({ id: template.id, ai: template.minRange, combat: template.combat.minRange }).toEqual({
        id: template.id,
        ai: template.minRange,
        combat: template.minRange,
      });
    }
  });

  it('rejects a template whose behaviour and ring disagree', () => {
    // A creature that hunts the isolated detective and walks around a chokepoint
    // while wearing a trash ring is a bug report, not a monster. The ring is the
    // only warning the player gets.
    const liar: MonsterTemplate = { ...INDEX_HUSK_ELITE, rank: ActorRank.Normal };
    expect(validateTemplate(liar)).toEqual([
      'index_husk_elite: carries elite behaviour but rank is normal',
    ]);
  });

  it('rejects a melee reach that would refuse its own diagonals', () => {
    // combat.range 1 is the trap: the four diagonal neighbours sit at √2 =
    // 1.4142, so a Euclidean reach of exactly 1 refuses every diagonal melee
    // attack in the game while the scheduler's Chebyshev check happily accepts
    // it. 1.5 is the radius that makes the circle equal the Moore neighbourhood.
    const tight: MonsterTemplate = {
      ...INDEX_HUSK,
      combat: { ...INDEX_HUSK.combat, range: 1 },
    };
    expect(validateTemplate(tight)).toEqual([
      `index_husk: melee combat.range 1 excludes the diagonal ${Math.SQRT2}`,
    ]);
  });
});

// ---------------------------------------------------------------------------
// The mapping: authored identity in, ToME curve out
// ---------------------------------------------------------------------------

describe('the authored Outer Index numbers survive the port', () => {
  it('carries index_husk.json through field by field', () => {
    // content/enemies/index_husk.json: max_hp 25, attack_power 8, defense 1,
    // melee_range 28 (px, ÷ TILE_PX 32 → one tile), ai_profile "melee_chaser".
    expect({
      maxHp: INDEX_HUSK.maxHp,
      weaponRating: INDEX_HUSK.combat.weapon?.dam,
      armour: INDEX_HUSK.combat.mods?.armour,
      reach: INDEX_HUSK.attackRange,
      profile: INDEX_HUSK.profile,
    }).toEqual({ maxHp: 25, weaponRating: 8, armour: 1, reach: 1, profile: 'melee_chaser' });
  });

  it('carries index_wraith.json, orb and all', () => {
    // content/enemies/index_wraith.json: max_hp 22, defense 1,
    // cast_ability_damage 14 (the orb IS the creature, so it is the weapon
    // rating, not the `attack_power: 8` basic attack), move_speed 64.
    expect({
      maxHp: INDEX_WRAITH.maxHp,
      weaponRating: INDEX_WRAITH.combat.weapon?.dam,
      armour: INDEX_WRAITH.combat.mods?.armour,
      type: INDEX_WRAITH.combat.damageType,
    }).toEqual({ maxHp: 22, weaponRating: 14, armour: 1, type: DamageType.Darkness });

    // move_speed 64 ÷ the husk's reference 76 = 0.842, to 2dp. A kiter SLOWER
    // than the party is the reason cornering one works at all.
    expect(INDEX_WRAITH.globalSpeed).toBe(0.84);
    expect(INDEX_WRAITH.globalSpeed).toBeCloseTo(64 / 76, 2);
    expect(INDEX_HUSK.globalSpeed).toBe(1);
  });

  it('does NOT put `defense` on the flat-damage stage, and that is deliberate', () => {
    // Structurally, Outer Index's `defense` is a flat post-resist subtraction
    // (systems/combat/combat_manager.gd:324, :342-344), which is ToME's
    // `flat_damage_armor` to the letter. It is ported as `combat_armor` anyway,
    // because that Godot line floors at `maxi(1, …)` and ToME's floors at 0: a
    // default detective's 4.408-damage swing (test/server/derived.test.ts)
    // against a flat 3 lands for ZERO. `combat_armor` is hardiness-gated, so 70%
    // of every blow lands no matter what — which is the property `defense` was
    // actually carrying. See the header of content/monsters.ts.
    for (const template of MONSTER_TEMPLATES) {
      expect({
        id: template.id,
        flat: template.combat.profile?.flatDamageArmour,
      }).toEqual({ id: template.id, flat: undefined });
    }
  });

  it('leaves resistsCap unset so monsters cap at 100, not the player 70', () => {
    // Actor.lua:211 — the ENGINE default is `{ all = 100 }`. The familiar 70 is a
    // PLAYER birth descriptor (data/birth/descriptors.lua:63). A monster authored
    // with 100 fire resist is genuinely immune; a player with the same number is
    // not, and that asymmetry is upstream's.
    for (const template of MONSTER_TEMPLATES) {
      expect(template.combat.profile?.resistsCap).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Derived numbers — the whole point of copying the curve
// ---------------------------------------------------------------------------

describe('index_husk, derived', () => {
  const sheet = INDEX_HUSK.combat;

  it('is easy to hit and bad at hitting, which is what makes it the first monster', () => {
    // Dex 8 pays twice: accuracy at 1.0/point (Combat.lua:1343, on top of the
    // bare +4) and dodge at 0.35 (Combat.lua:1245). 4 + (8 − 10) = 2, and
    // max(0, (8 − 10) × 0.35) floors the defence at 0 before the rescale.
    expect(combatAttack(sheet)).toBe(2);
    expect(combatDefense(sheet)).toBe(0);

    // checkHit is linear: ceil(50 + 2.5 × (atk − def)), Combat.lua:337-350.
    expect(hitChance(combatAttack(sheet), 0)).toBe(55);
    expect(hitChance(4, combatDefense(sheet))).toBe(60);
  });

  it('swings for 6-7 from an authored attack_power of 8', () => {
    // 0.3 × rescale(str 12 + totstat 7.2) × damagePower(8 + 7.2)
    // = 0.3 × 19 × 1.15574 (Combat.lua:1661-1687).
    expect(combatDamage(sheet)).toBeCloseTo(6.3637, 4);

    // The range roll TRUNCATES both endpoints (damage.ts `rollDamageRange`), so
    // the swing is a uniform integer in [6, 7].
    //
    // WATCH THIS ONE. The high end is 7.000088 — eighty-eight millionths above
    // the truncation boundary. A tweak to Strength or to the weapon rating that
    // shaves 0.0001 off turns this monster into a flat 6, which is a 7% damage
    // cut nobody will connect to the change that caused it.
    const high = combatDamage(sheet) * combatDamageRange(sheet);
    expect(Math.trunc(combatDamage(sheet))).toBe(6);
    expect(Math.trunc(high)).toBe(7);
    expect(high).toBeGreaterThan(7);
    expect(high).toBeLessThan(7.001);
  });

  it('carries one point of armour and almost no crit', () => {
    expect(combatArmor(sheet)).toBe(1);
    // Base 30 and nothing added — Combat.lua:1336. 70% of every blow bypasses it.
    expect(combatArmorHardiness(sheet)).toBe(30);
    // Cun 8 → (8 − 10) × 0.3 = −0.6, plus the weaponless +1 at Combat.lua:1424.
    expect(combatCrit(sheet)).toBeCloseTo(0.4, 10);
  });

  it('is 25% harder to reach with a mind attack and ordinary to everything else', () => {
    expect(combatGetResist(sheet.profile ?? {}, DamageType.Mind)).toBe(25);
    expect(combatGetResist(sheet.profile ?? {}, DamageType.Fire)).toBe(0);
  });
});

describe('index_wraith, derived', () => {
  const sheet = INDEX_WRAITH.combat;

  it('is the accurate one, because that is what a sniper is', () => {
    // Dex 13 → 4 + 3 = 7 accuracy, and (13 − 10) × 0.35 = 1.05 → rescale floors
    // to 1 defence (Combat.lua:1459, the floor).
    expect(combatAttack(sheet)).toBe(7);
    expect(combatDefense(sheet)).toBe(1);
    expect(hitChance(combatAttack(sheet), 0)).toBe(68);
    // It hits a detective more often than a detective hits it back — which is
    // the whole argument for closing the distance rather than trading shots.
    expect(hitChance(4, combatDefense(sheet))).toBe(58);
  });

  it('throws the orb with Dexterity and Cunning, not with a Strength it lacks', () => {
    // dammod { dex: 0.5, cun: 0.4 } in the shape of ToME's bow (Combat.lua:1625
    // notes the `{ str = 0.6 }` default a bow overrides).
    expect(combatDamage(sheet)).toBeCloseTo(7.3832, 4);
    expect(Math.trunc(combatDamage(sheet))).toBe(7);
    expect(Math.trunc(combatDamage(sheet) * combatDamageRange(sheet))).toBe(8);
  });

  it('shrugs off darkness and is VULNERABLE to a solid hit', () => {
    const profile = sheet.profile ?? {};
    expect(combatGetResist(profile, DamageType.Darkness)).toBe(50);

    // A NEGATIVE resist is a vulnerability, and it is idiomatic upstream
    // (vermin.lua:75 ships `[DamageType.FIRE] = -50`). It multiplies rather than
    // subtracts — damage_types.lua:345-352, `dam * (100 - res) / 100`.
    const physical = combatGetResist(profile, DamageType.Physical);
    expect(physical).toBeCloseTo(-20, 10);
    expect(applyResists(10, physical, 0)).toBeCloseTo(12, 10);

    // The floor is −100, which caps vulnerability at exactly double damage
    // rather than letting it run away.
    expect(applyResists(10, -100, 0)).toBe(20);
  });
});

describe('index_husk_elite, derived', () => {
  const sheet = INDEX_HUSK_ELITE.combat;

  it('hits barely harder than the husk it upgrades, ON PURPOSE', () => {
    // The weapon rating went 8 → 12 (+50%) and the damage went 6.36 → 8.15
    // (+28%), because Combat.lua:1682-1687 puts the rating under a square root.
    // ToME's own rank ladder says the same thing from the other direction:
    // `getRankLifeAdjust` (Actor.lua:1740-1751) gives a rank-3 elite only 1.22×
    // a rank-2 normal's life at level 1. An elite is not a bigger number.
    expect(combatDamage(sheet)).toBeCloseTo(8.15, 4);
    expect(combatDamage(sheet)).toBeLessThan(combatDamage(INDEX_HUSK.combat) * 1.3);

    // 8.15 × 1.1 = 8.965, which truncates back to 8 — the low-damage collapse
    // ToME's `rng.range` has by construction. The elite hits for a flat 8.
    expect(Math.trunc(combatDamage(sheet))).toBe(8);
    expect(Math.trunc(combatDamage(sheet) * combatDamageRange(sheet))).toBe(8);
  });

  it('is the one creature in the roster that teaches armour', () => {
    expect(combatArmor(sheet)).toBe(3);
    // 30 base + 5 authored (Combat.lua:1336). Still under half, so the majority
    // of every blow lands untouched and nothing is ever unkillable.
    expect(combatArmorHardiness(sheet)).toBe(35);
    // Anchored on city_watchman.json's authored `crit_chance: 0.05`, taken in
    // percentage POINTS (Combat.lua:1415-1427), plus the weaponless +1.
    expect(combatCrit(sheet)).toBe(6);
    expect(combatAttack(sheet)).toBe(6);
  });

  it('composes `all` with the typed row MULTIPLICATIVELY: 32.5, not 35', () => {
    // Combat.lua:2220-2231 — `100 × (1 − (1 − a)(1 − b))`, WITH the clamps at
    // :2227-2228. all 10 and mind 25 give 100 × (1 − 0.9 × 0.75) = 32.5.
    // Addition would give 35, and that error is invisible in review and
    // compounds everywhere resistance sources stack.
    const profile = sheet.profile ?? {};
    expect(combatGetResist(profile, DamageType.Mind)).toBeCloseTo(32.5, 10);
    expect(combatGetResist(profile, DamageType.Mind)).not.toBeCloseTo(35, 1);
    // The `all` row alone, for a type with no entry of its own.
    expect(combatGetResist(profile, DamageType.Fire)).toBeCloseTo(10, 10);
  });

  it('costs a party about five rounds rather than a solo detective forty', () => {
    // The sizing argument, written down so a future retune has something to
    // argue with. A detective's 4-damage swing loses 1.4 to hardiness-35 armour
    // 3 and then 10% to `all`; four M3-shaped detectives put roughly 13 a round
    // through that, and 60 life is between four and five rounds.
    expect(INDEX_HUSK_ELITE.maxHp).toBe(60);
    // ToME's elite would have been 25 × 1.22 ≈ 30 and Outer Index's ~110
    // (NEXUS/knowledge/lessons.md:170). 60 is between them, and deliberately so.
    expect(INDEX_HUSK_ELITE.maxHp).toBeGreaterThan(INDEX_HUSK.maxHp * 1.22);
    expect(INDEX_HUSK_ELITE.maxHp).toBeLessThan(110);
  });
});

// ---------------------------------------------------------------------------
// Reach, the dead zone, and the two metrics
// ---------------------------------------------------------------------------

describe('reach', () => {
  const level = openRoom(16, 9);
  const world = { level };

  it('lets a husk hit all eight neighbours and nothing further', () => {
    const husk = spawn(INDEX_HUSK, 'm1', { x: 5, y: 4 });
    for (const [dx, dy] of [
      [1, 0],
      [0, 1],
      [1, 1],
      [-1, -1],
    ] as const) {
      const victim = detective(`p${dx}${dy}`, { x: 5 + dx, y: 4 + dy });
      expect({ dx, dy, refusal: canAttack(husk, victim, world) }).toEqual({
        dx,
        dy,
        refusal: null,
      });
    }

    // The nearest non-neighbour is at Euclidean 2.0, outside the 1.5 circle.
    const far = detective('far', { x: 7, y: 4 });
    expect(canAttack(husk, far, world)).toBe(AttackRefusal.OutOfRange);
  });

  it('gives the wraith a dead zone that is a refusal, never a miss', () => {
    const wraith = spawn(INDEX_WRAITH, 'm1', { x: 5, y: 4 });

    // Adjacent, orthogonally and diagonally: both inside the hole.
    expect(canAttack(wraith, detective('a', { x: 6, y: 4 }), world)).toBe(AttackRefusal.MinRange);
    expect(canAttack(wraith, detective('b', { x: 6, y: 5 }), world)).toBe(AttackRefusal.MinRange);

    // Exactly 2 is the closest LEGAL tile — `<` not `<=` in `canAttack`.
    expect(canAttack(wraith, detective('c', { x: 7, y: 4 }), world)).toBeNull();
    // Its full reach, and one past it.
    expect(canAttack(wraith, detective('d', { x: 11, y: 4 }), world)).toBeNull();
    expect(canAttack(wraith, detective('e', { x: 12, y: 4 }), world)).toBe(
      AttackRefusal.OutOfRange,
    );
  });

  it('does not out-range the Inspector, whose whole identity is range', () => {
    // test/server/combat.test.ts pins the Inspector at range 7 / min_range 3.
    // A monster that outshoots the ranged class deletes that class.
    expect(INDEX_WRAITH.attackRange).toBeLessThan(7);
    expect(INDEX_WRAITH.minRange).toBeLessThan(3);
  });

  it('keeps the Chebyshev band and the Euclidean refusal in agreement up to 3', () => {
    // The AI's kite band is Euclidean and so is `canAttack`, so this is belt and
    // braces — but it is also the number that says the Inspector's authored 3 is
    // the largest dead zone anybody can reason about loosely, and that a 5 is
    // not. Proved by exhaustion over every offset, not by argument.
    const disagreements = (min: number): string[] => {
      const out: string[] = [];
      for (let dx = -8; dx <= 8; dx += 1) {
        for (let dy = -8; dy <= 8; dy += 1) {
          const cheb = chebyshev({ x: 0, y: 0 }, { x: dx, y: dy });
          const euc = combatDistance({ x: 0, y: 0 }, { x: dx, y: dy });
          if (cheb < min !== euc < min) out.push(`${dx},${dy}`);
        }
      }
      return out;
    };

    expect(disagreements(1)).toEqual([]);
    expect(disagreements(2)).toEqual([]);
    expect(disagreements(3)).toEqual([]);
    // At 4 the pure diagonal parts them: (3,3) is Chebyshev 3 (the AI would back
    // off) and Euclidean 4.243 (the shot was legal all along).
    expect(disagreements(4)).toEqual(['-3,-3', '-3,3', '3,-3', '3,3']);
  });
});

// ---------------------------------------------------------------------------
// ranged_kiter
// ---------------------------------------------------------------------------

describe('the wraith holds its lane', () => {
  const ROOM = [
    '################',
    '#..............#',
    '#..............#',
    '#..............#',
    '#..............#',
    '#..............#',
    '#..............#',
    '#..............#',
    '################',
  ] as const;
  const passable = passableIn(ROOM);

  it('closes when it is out of its band and stops the moment it is in', () => {
    // Chebyshev 8 — exactly its `aggroRange`, so it can see the detective — and
    // Euclidean 8, which is past its `preferredRange` of 6.
    const player = detective('p1', { x: 5, y: 4 });
    const wraith = spawn(INDEX_WRAITH, 'm1', { x: 13, y: 4 });
    const ctx = aiCtx(passable, [player, wraith], createRng('band'));

    const first = decideNpcAction(wraith, ctx);
    expect(first.kind).toBe(IntentKind.Move);
    applyMove(wraith, first);

    // Walk it in until it stops moving, then check where it stopped.
    for (let turn = 0; turn < 12; turn += 1) {
      const intent = decideNpcAction(wraith, ctx);
      if (intent.kind !== IntentKind.Move) break;
      applyMove(wraith, intent);
    }
    expect(combatDistance(wraith, player)).toBeLessThanOrEqual(INDEX_WRAITH.preferredRange);
    expect(decideNpcAction(wraith, ctx)).toEqual({ kind: IntentKind.Attack, targetId: 'p1' });
  });

  it('gives ground the moment a detective steps inside the dead zone', () => {
    const player = detective('p1', { x: 6, y: 4 });
    const wraith = spawn(INDEX_WRAITH, 'm1', { x: 7, y: 4 });
    const ctx = aiCtx(passable, [player, wraith], createRng('retreat'));

    const before = combatDistance(wraith, player);
    const intent = decideNpcAction(wraith, ctx);
    expect(intent.kind).toBe(IntentKind.Move);
    applyMove(wraith, intent);
    // `flee_simple` (simple.lua:68-104), plus our own rule that a retreat must
    // actually retreat.
    expect(combatDistance(wraith, player)).toBeGreaterThan(before);
  });

  it('NEVER walks into melee, over a charging detective and twenty turns', () => {
    // The guarantee the whole profile exists for, tested as an invariant rather
    // than as a single board state: whatever the player does, the wraith must
    // never END a step inside its own dead zone and must never ASK for a shot it
    // would be refused.
    const player = detective('p1', { x: 2, y: 4 });
    const wraith = spawn(INDEX_WRAITH, 'm1', { x: 13, y: 4 });
    const ctx = aiCtx(passable, [player, wraith], createRng('charge'));

    for (let turn = 0; turn < 20; turn += 1) {
      const intent = decideNpcAction(wraith, ctx);

      if (intent.kind === IntentKind.Attack) {
        expect({
          turn,
          inside: combatDistance(wraith, player) < INDEX_WRAITH.minRange,
        }).toEqual({ turn, inside: false });
        // ...and the swing the scheduler would actually resolve is legal.
        expect(canAttack(wraith, player, { level: rowsToLevel(ROOM) })).toBeNull();
      }
      applyMove(wraith, intent);

      // The detective charges. Straight line, one tile a turn, right at it.
      const dx = Math.sign(wraith.x - player.x);
      const dy = Math.sign(wraith.y - player.y);
      if (dx !== 0 || dy !== 0) {
        const nx = player.x + dx;
        const ny = player.y + dy;
        if (passable(nx, ny) && !(nx === wraith.x && ny === wraith.y)) {
          player.x = nx;
          player.y = ny;
        }
      }
    }
  });

  it('holds rather than firing point-blank when it is genuinely cornered', () => {
    // THE M2 BUG, PINNED. The old kiter fell through to an attack when its
    // retreat was blocked, on the reasoning that "shooting point-blank beats
    // standing still". It does not: `canAttack` returns MinRange for exactly
    // that shot, so the intent is refused, the turn is spent, and the log says
    // nothing at all. A pinned wraith is the Watchman's payoff, and it has to
    // look like one.
    const player = detective('p1', { x: 2, y: 2 });
    const wraith = spawn(INDEX_WRAITH, 'm1', { x: 1, y: 1 });
    const ctx = aiCtx(passable, [player, wraith], createRng('cornered'));

    const intent = decideNpcAction(wraith, ctx);
    expect(intent).toEqual({ kind: IntentKind.Hold });
    expect(intent.kind).not.toBe(IntentKind.Attack);
    // And the shot it did not take would indeed have been refused.
    expect(canAttack(wraith, player, { level: rowsToLevel(ROOM) })).toBe(AttackRefusal.MinRange);
  });

  it('tries all four flanking directions, each pair order-randomised', () => {
    // simple.lua:78-90 ships TWO coin flips — left/right, then
    // hard_left/hard_right. The M2 port had only the first pair and one draw,
    // which left a kiter cornered roughly twice as often as ToME's would be.
    const player = detective('p1', { x: 2, y: 2 });
    const wraith = spawn(INDEX_WRAITH, 'm1', { x: 1, y: 1 });
    const rng = createRng('ladder');
    const ctx = aiCtx(passable, [player, wraith], rng);

    decideNpcAction(wraith, ctx);
    // Boxed into a corner, so every one of the four is tried and both flips are
    // consumed. The second label proves the hard sides were reached.
    expect(rng.getState().lastLabel).toBe('ai.flee.hardside');
  });
});

// ---------------------------------------------------------------------------
// The elite
// ---------------------------------------------------------------------------

describe('the elite goes for whoever is standing alone', () => {
  const ROOM = [
    '############',
    '#..........#',
    '#..........#',
    '#..........#',
    '#..........#',
    '#..........#',
    '#..........#',
    '############',
  ] as const;
  const passable = passableIn(ROOM);

  /** A pair standing shoulder to shoulder, and one detective who wandered off. */
  function board(monster: MonsterActor) {
    const pairA = detective('a_pair', { x: 5, y: 3 });
    const pairB = detective('b_pair', { x: 5, y: 4 });
    const loner = detective('c_loner', { x: 9, y: 3 });
    return { pairA, pairB, loner, actors: [pairA, pairB, loner, monster] };
  }

  it('a husk takes the nearest, exactly as ToME does', () => {
    // ai/simple.lua:259-267 walks `fov.actors_dist` and takes the first live
    // hostile. Nearest, full stop.
    const husk = spawn(INDEX_HUSK, 'm1', { x: 2, y: 3 });
    const { actors } = board(husk);
    decideNpcAction(husk, aiCtx(passable, actors, createRng('nearest')));
    expect(husk.ai.targetId).toBe('a_pair');
  });

  it('an elite walks past the front line to reach the one who wandered off', () => {
    // NOT a ToME port — ToME is single-player, where "nearest" and "you" are the
    // same actor. This is what manufactures "get over here" in a voice channel,
    // and it is the behaviour the ring is promising.
    const elite = spawn(INDEX_HUSK_ELITE, 'm1', { x: 2, y: 3 });
    const { actors } = board(elite);
    decideNpcAction(elite, aiCtx(passable, actors, createRng('isolated')));
    expect(elite.ai.targetId).toBe('c_loner');
  });

  it('goes back to the nearest once the party closes ranks', () => {
    // The counterplay has to work, or the behaviour is a taunt rather than a
    // pressure. Standing next to somebody is the whole answer.
    const elite = spawn(INDEX_HUSK_ELITE, 'm1', { x: 2, y: 3 });
    const { loner, actors } = board(elite);
    const friend = detective('d_friend', { x: 9, y: 4 });
    loner.x = 9;
    loner.y = 3;

    decideNpcAction(elite, aiCtx(passable, [...actors, friend], createRng('ranks')));
    // Everyone now has support, so isolation no longer separates them and the
    // scan falls back to the incoming nearest-then-id order.
    expect(elite.ai.targetId).toBe('a_pair');
  });

  it('costs the seeded stream exactly what a husk costs it', () => {
    // Swapping an elite for a husk in an encounter must not shift a replay. The
    // isolation scan is a pure re-sort of a list that was already totally
    // ordered, so it draws nothing.
    const counts = [INDEX_HUSK, INDEX_HUSK_ELITE].map((template) => {
      const monster = spawn(template, 'm1', { x: 2, y: 3 });
      const { actors } = board(monster);
      const rng = createRng('draws');
      const ctx = aiCtx(passable, actors, rng);
      decideNpcAction(monster, ctx);
      decideNpcAction(monster, ctx);
      decideNpcAction(monster, ctx);
      return rng.getState().count;
    });
    expect(counts[0]).toBe(counts[1]);
    // Two keep-rolls: the first call has no target yet and short-circuits, which
    // is Lua's own behaviour at simple.lua:253.
    expect(counts[0]).toBe(2);
  });
});

describe('the elite cannot be plugged into a doorway', () => {
  /** Two ways through the middle wall: x=4 is open at y=2 and at y=4. */
  const TWO_DOORS = [
    '############',
    '#...#......#',
    '#..........#',
    '#...#......#',
    '#..........#',
    '#...#......#',
    '############',
  ] as const;
  const passable = passableIn(TWO_DOORS);

  /** Walk `monster` for `turns` turns against a blocker in the near doorway. */
  function run(template: MonsterTemplate, turns: number): Intent[] {
    const player = detective('p1', { x: 8, y: 2 });
    const blocker = spawn(INDEX_HUSK, 'm2', { x: 4, y: 2 });
    const monster = spawn(template, 'm1', { x: 2, y: 2 });
    const ctx = aiCtx(passable, [player, blocker, monster], createRng('door'));

    const log: Intent[] = [];
    for (let turn = 0; turn < turns; turn += 1) {
      const intent = decideNpcAction(monster, ctx);
      log.push(intent);
      applyMove(monster, intent);
    }
    return log;
  }

  it('a husk queues behind its friend, forever, and that is correct', () => {
    // The M2 comment on `intentForStep` calls this "a chokepoint working as
    // intended". Trash must never shove an ally aside; the doorway is the
    // party's strongest and cheapest tactic and it has to keep working.
    const log = run(INDEX_HUSK, 9).map((intent) => intent.kind);
    expect(log).toEqual([
      IntentKind.Move,
      IntentKind.Hold,
      IntentKind.Hold,
      IntentKind.Hold,
      IntentKind.Hold,
      IntentKind.Hold,
      IntentKind.Hold,
      IntentKind.Hold,
      IntentKind.Hold,
    ]);
  });

  it('the elite counts five blocked turns and then takes the other door', () => {
    // ToME's `move_complex` escalation (simple.lua:222-228): five turns of not
    // moving, then re-run A* with `check_all_block_move` (:163-170), under which
    // the target's tile is passable and every other body is a wall. The route
    // that comes back goes around the swarm rather than through it.
    const log = run(INDEX_HUSK_ELITE, 7).map((intent) => intent.kind);
    expect(log).toEqual([
      // One step up to the queue...
      IntentKind.Move,
      // ...then the five blocked turns upstream insists on...
      IntentKind.Hold,
      IntentKind.Hold,
      IntentKind.Hold,
      IntentKind.Hold,
      // ...and it flanks.
      IntentKind.Move,
      IntentKind.Move,
    ]);
    expect(INDEX_HUSK_ELITE.shoulderAfter).toBe(5);
  });

  it('does not shove its own kin aside even when it flanks', () => {
    // The escalation is a REROUTE, not a licence to walk through allies. Every
    // tile the elite stands on must have been empty.
    const player = detective('p1', { x: 8, y: 2 });
    const blocker = spawn(INDEX_HUSK, 'm2', { x: 4, y: 2 });
    const elite = spawn(INDEX_HUSK_ELITE, 'm1', { x: 2, y: 2 });
    const ctx = aiCtx(passable, [player, blocker, elite], createRng('kin'));

    for (let turn = 0; turn < 10; turn += 1) {
      applyMove(elite, decideNpcAction(elite, ctx));
      expect({ turn, at: `${elite.x},${elite.y}`, onKin: elite.x === 4 && elite.y === 2 }).toEqual({
        turn,
        at: `${elite.x},${elite.y}`,
        onKin: false,
      });
      expect(passable(elite.x, elite.y)).toBe(true);
    }
  });

  it('stops re-running A* against a wall it cannot get round', () => {
    // simple.lua:174-177 — a failed escalation drives the counter to −5 rather
    // than leaving it armed, so a boxed-in elite pays for one actor-aware
    // pathfind every six turns instead of one every turn for the rest of the
    // fight. Cheap here; not cheap with eight elites and a 40x40 floor.
    const SEALED = ['##########', '#...#....#', '#...#....#', '#...#....#', '##########'] as const;
    const player = detective('p1', { x: 7, y: 2 });
    const elite = spawn(INDEX_HUSK_ELITE, 'm1', { x: 2, y: 2 });
    const ctx = aiCtx(passableIn(SEALED), [player, elite], createRng('sealed'));

    // The test ctx has no LOS check, so it targets across the wall, walks up to
    // it once on ToME's straight-step fallback (simple.lua:140-142), and then
    // has nowhere at all to go.
    const log: string[] = [];
    for (let turn = 0; turn < 8; turn += 1) {
      const intent = decideNpcAction(elite, ctx);
      log.push(intent.kind);
      applyMove(elite, intent);
    }

    expect(log[0]).toBe(IntentKind.Move);
    expect(log.slice(1)).toEqual(new Array(7).fill(IntentKind.Hold));
    expect({ x: elite.x, y: elite.y }).toEqual({ x: 3, y: 2 });
    // Armed on turn 6, failed, and has been ticking back toward zero since.
    expect(elite.ai.shoulderTurns).toBeLessThan(0);
  });
});

// ---------------------------------------------------------------------------
// Determinism and the wire
// ---------------------------------------------------------------------------

describe('determinism', () => {
  const ROOM = [
    '############',
    '#..........#',
    '#..........#',
    '#..........#',
    '#..........#',
    '############',
  ] as const;

  it('makes identical decisions from an identical seed, elite and kiter alike', () => {
    const replay = (template: MonsterTemplate, seed: string): string[] => {
      const player = detective('p1', { x: 2, y: 2 });
      const monster = spawn(template, 'm1', { x: 9, y: 3 });
      const ctx = aiCtx(passableIn(ROOM), [player, monster], createRng(seed));
      const log: string[] = [];
      for (let turn = 0; turn < 10; turn += 1) {
        const intent = decideNpcAction(monster, ctx);
        log.push(`${monster.x},${monster.y} ${JSON.stringify(intent)}`);
        applyMove(monster, intent);
      }
      return log;
    };

    for (const template of MONSTER_TEMPLATES) {
      expect(replay(template, 'replay')).toEqual(replay(template, 'replay'));
    }
  });
});

describe('the wire carries what the ring needs', () => {
  it('projects rank, so the client can pick ui_token_ring_elite.png', () => {
    // ToME does the same thing with the same field: `boss_rank_circles`
    // (Actor.lua:1198-1204) picks an under-token circle from `self.rank`.
    // The client cannot derive it — a wounded elite has less life than a fresh
    // husk, and docs/art-pipeline.md:362 records that `index_husk_elite`
    // currently ships SMALLER than `index_husk`, so the sprite reads the wrong
    // way round until the art is regenerated.
    const husk = spawn(INDEX_HUSK, 'm1', { x: 2, y: 2 });
    const elite = spawn(INDEX_HUSK_ELITE, 'm2', { x: 3, y: 2 });
    const player = detective('p1', { x: 4, y: 2 });

    expect(toActorView(husk).rank).toBe(ActorRank.Normal);
    expect(toActorView(elite).rank).toBe(ActorRank.Elite);
    expect(toActorView(player).rank).toBe(ActorRank.Normal);
    expect(toActorView(elite).sprite).toBe('enemy_index_husk_elite_s');
  });

  it('does not leak what the elite has decided about you', () => {
    // Rank is a category the fiction insists you can see. Its TARGET is not, and
    // for this creature it is the single most valuable thing on the board.
    const elite = spawn(INDEX_HUSK_ELITE, 'm1', { x: 2, y: 2 });
    elite.ai.targetId = 'p1';
    expect(Object.keys(toActorView(elite))).not.toContain('ai');
    expect(JSON.stringify(toActorView(elite))).not.toContain('p1');
  });

  it('hands the whole template through monsterInit without losing a field', () => {
    const elite = spawn(INDEX_HUSK_ELITE, 'm1', { x: 4, y: 5 });
    expect({
      rank: elite.rank,
      hp: elite.hp,
      maxHp: elite.maxHp,
      reach: elite.attackRange,
      speed: elite.globalSpeed,
      sheet: elite.combat,
      hunts: elite.ai.huntsIsolated,
      shoulder: elite.ai.shoulderAfter,
      blocked: elite.ai.blockedTurns,
      shouldering: elite.ai.shoulderTurns,
      aggro: elite.ai.aggroRange,
    }).toEqual({
      rank: ActorRank.Elite,
      hp: 60,
      maxHp: 60,
      reach: 1,
      speed: 1,
      sheet: INDEX_HUSK_ELITE.combat,
      hunts: true,
      shoulder: 5,
      blocked: 0,
      shouldering: 0,
      aggro: 9,
    });
  });
});
