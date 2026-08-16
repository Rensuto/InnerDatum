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
  resolveLevelup,
  resolveMBonus,
  resolveRngAvg,
} from '../../src/server/content/resolvers.ts';
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
import { drawCount, scriptedRng } from '../helpers/scripted-rng.ts';
import { chebyshev } from '../../src/shared/coords.ts';
import { hitChance } from '../../src/shared/checkhit.ts';
import { ActorRank } from '../../src/shared/protocol.ts';
import { createRng } from '../../src/shared/rng.ts';
import type { MonsterTemplate } from '../../src/server/content/monsters.ts';
import type { AiCtx } from '../../src/server/ai/npc.ts';
import type { EngineActor, Intent, MonsterActor } from '../../src/server/engine/actor.ts';
import type { DamageProfile } from '../../src/server/engine/damage.ts';
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
// The mapping: ToME supplies the numbers, we supply the identity
// ---------------------------------------------------------------------------

describe('the adopted ToME entries survive the port', () => {
  it('carries the giant brown ant onto index_husk, field by field', () => {
    // ant.lua:53-60 (giant brown ant) on BASE_NPC_ANT ant.lua:24-43:
    //   :34 stats = { str=12, dex=10, mag=3, con=13 }
    //   :36 combat_armor = 1, combat_def = 1
    //   :37 combat = { dam=resolvers.levelup(resolvers.rngavg(5,5),1,1),
    //                  atk=15, apr=7, dammod={str=0.6} }
    //   :38 infravision = 10
    //   :58 global_speed_base = 0.9
    expect({
      stats: INDEX_HUSK.combat.stats,
      armour: INDEX_HUSK.combat.mods?.armour,
      def: INDEX_HUSK.combat.mods?.def,
      weapon: INDEX_HUSK.combat.weapon,
      sight: INDEX_HUSK.aggroRange,
      speed: INDEX_HUSK.globalSpeed,
      reach: INDEX_HUSK.attackRange,
      profile: INDEX_HUSK.profile,
    }).toEqual({
      stats: { str: 12, dex: 10, con: 13, mag: 3 },
      armour: 1,
      def: 1,
      weapon: { dam: 5, atk: 15, apr: 7, damMod: { str: 0.6 } },
      sight: 10,
      speed: 0.9,
      reach: 1,
      profile: 'melee_chaser',
    });

    // The weapon rating is the resolver nest run at level 1, not a magic 5 —
    // `resolvers.levelup(resolvers.rngavg(5,5), 1, 1)`. Pinned against the
    // functions themselves so that a change to either resolver moves this test
    // rather than silently moving the creature.
    expect(INDEX_HUSK.combat.weapon?.dam).toBe(resolveLevelup(resolveRngAvg(5, 5)));

    // DEVIATION, WRITTEN DOWN. Upstream is ant.lua:59
    // `max_life = resolvers.rngavg(15,30)`, a mean of 22.5 — so the held 25 is
    // inside the giant brown ant's own band and needs no defence beyond that.
    expect(INDEX_HUSK.maxHp).toBe(25);
    expect(INDEX_HUSK.maxHp).toBeGreaterThanOrEqual(15);
    expect(INDEX_HUSK.maxHp).toBeLessThanOrEqual(30);
  });

  it('carries the losgoroth onto index_wraith, orb and all', () => {
    // losgoroth.lua:59-70 on BASE_NPC_LOSGOROTH losgoroth.lua:22-57:
    //   :30 combat = { dam=resolvers.levelup(resolvers.mbonus(40,15),1,1.2),
    //                  atk=15, apr=15, dammod={mag=0.8} }
    //   :43 ai_state = { ..., talent_in = 2 }
    //   :44 stats = { str=10, dex=8, mag=6, con=16 }
    //   :46 resists = { [PHYSICAL] = -30, ... }
    //   :64 combat_armor = 0, combat_def = 20
    // plus misc/npcs.lua:733 `proj_speed = 2` on the T_VOID_BLAST it grants
    // (losgoroth.lua:67-69) — the creature and its orb are one package.
    expect({
      stats: INDEX_WRAITH.combat.stats,
      armour: INDEX_WRAITH.combat.mods?.armour,
      def: INDEX_WRAITH.combat.mods?.def,
      weapon: INDEX_WRAITH.combat.weapon,
      projSpeed: INDEX_WRAITH.projSpeed,
      talentIn: INDEX_WRAITH.talentIn,
    }).toEqual({
      stats: { str: 10, dex: 8, mag: 6, con: 16 },
      armour: 0,
      def: 20,
      weapon: { dam: 15, atk: 15, apr: 15, damMod: { mag: 0.8 } },
      projSpeed: 2,
      talentIn: 2,
    });

    // The weapon rating is the resolver nest at level 1, not a magic 15.
    expect(INDEX_WRAITH.combat.weapon?.dam).toBe(resolveLevelup(resolveMBonus(40, 15)));

    // OURS, KEPT: upstream's own element resist is ARCANE 100, which is neither
    // our damage type nor a number that belongs on floor one.
    expect(INDEX_WRAITH.combat.damageType).toBe(DamageType.Darkness);

    // TWO DELIBERATE DEVIATIONS, both live fields, both pinned so they cannot
    // drift back to "port" silently. Upstream's losgoroth authors no
    // `global_speed_base` (so 1.0) and ToME has no dead zone anywhere.
    expect(INDEX_WRAITH.globalSpeed).toBe(0.84);
    expect(INDEX_WRAITH.minRange).toBe(2);
    // ...and the third: upstream is `max_life = resolvers.rngavg(40,60)` = 50.
    expect(INDEX_WRAITH.maxHp).toBe(22);
    expect(resolveRngAvg(40, 60)).toBe(50);

    // tome/resolvers.lua:901 — the `ranged` tactic preset's `safe_range = 4` is
    // upstream's answer to "how far away does a shooter want to stand". The old
    // 6 sat at the very edge of its own reach, so every step the party took was
    // answered by a step back.
    expect(INDEX_WRAITH.preferredRange).toBe(4);
  });

  it('gives only the wraith a travelling orb and a fire cadence', () => {
    // ActorTalents.lua:987-991 — `if not t.proj_speed then return nil end`.
    // ABSENT IS INSTANTANEOUS, which is exactly what every attack in this game
    // does today, so a melee template must never carry either field: adding one
    // would change behaviour that nobody asked to change, and a `talentIn` on a
    // melee creature would gate its bump-attack on a coin flip.
    expect({ proj: INDEX_HUSK.projSpeed, talent: INDEX_HUSK.talentIn }).toEqual({
      proj: undefined,
      talent: undefined,
    });
    expect({ proj: INDEX_HUSK_ELITE.projSpeed, talent: INDEX_HUSK_ELITE.talentIn }).toEqual({
      proj: undefined,
      talent: undefined,
    });
    expect({ proj: INDEX_WRAITH.projSpeed, talent: INDEX_WRAITH.talentIn }).toEqual({
      proj: 2,
      talent: 2,
    });
  });

  it('rejects an orb that would never arrive', () => {
    // `projSpeed` is TILES PER GAME TURN. 0 hangs in the air forever, a negative
    // flies backwards, and NaN makes every energy comparison false — which on
    // screen reads as the orb silently vanishing, i.e. as damage from nowhere.
    // Absent is the one legal way to say "instantaneous".
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const broken: MonsterTemplate = { ...INDEX_WRAITH, projSpeed: bad };
      expect({ bad, problems: validateTemplate(broken) }).toEqual({
        bad,
        problems: [`index_wraith: projSpeed ${bad} must be a positive finite number`],
      });
    }
    // ...and the absence itself is legal, on the creature that has one today.
    const instant: MonsterTemplate = { ...INDEX_WRAITH, projSpeed: undefined };
    expect(validateTemplate(instant)).toEqual([]);
  });

  it('rejects a talent cadence that is not a whole 1-in-N', () => {
    // `talent_in` is the N in `rng.chance(N)` (talented.lua:122), which draws an
    // integer in [1, N]. 0 makes that range empty; 2.5 makes "1 in 2.5" a
    // sentence nobody can reason about.
    for (const bad of [0, -3, 1.5]) {
      const broken: MonsterTemplate = { ...INDEX_WRAITH, talentIn: bad };
      expect({ bad, problems: validateTemplate(broken) }).toEqual({
        bad,
        problems: [`index_wraith: talentIn ${bad} must be an integer >= 1`],
      });
    }
    // 1 is legal and means "every turn" — BASE_NPC_ANT authors exactly that
    // (ant.lua:33). It is just an expensive way to spell absent.
    expect(validateTemplate({ ...INDEX_WRAITH, talentIn: 1 })).toEqual([]);
  });

  it('leaves the flat-damage stage unexercised by M3 content', () => {
    // NOTHING in this roster sets `flat_damage_armor`, and neither does any of
    // the three upstream entries it is built from. Step 8 of the pipeline in
    // damage.ts is therefore unexercised by content on purpose: it is a gear
    // stat, and gear is M6. Recorded as a test so nobody "fixes" the gap.
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

  it('keeps every identity field byte-identical across the re-base', () => {
    // THE LINE THE RE-BASE MUST NOT CROSS. ToME supplies the numbers; the id,
    // the display name, the description and the sprite are the author's own and
    // none of them moved. Pinned literally rather than by reference, because a
    // reference would still pass if all four were replaced together.
    expect(MONSTER_TEMPLATES.map((t) => [t.id, t.displayName, t.sprite])).toEqual([
      ['index_husk', 'Index Husk', 'enemy_index_husk_s'],
      ['index_wraith', 'Index Wraith', 'enemy_index_wraith_s'],
      ['index_husk_elite', 'Overwritten Husk', 'enemy_index_husk_elite_s'],
    ]);
    expect(INDEX_HUSK.description).toContain('half-erased citizen overwritten by Index pages');
    expect(INDEX_WRAITH.description).toContain('A cited absence given shape');
    expect(INDEX_HUSK_ELITE.description).toContain('A husk the Index kept editing');
    // ...and no upstream creature NAME leaked into anything a player can read.
    // CLAUDE.md's licensing note: take the numbers and the behaviour, the
    // identity stays ours. Whole words only — a substring test would fail the
    // day somebody writes "wants" and would teach nothing when it did.
    const facing = MONSTER_TEMPLATES.map((t) => `${t.displayName} ${t.description}`)
      .join(' ')
      .toLowerCase();
    for (const upstream of ['ant', 'ants', 'losgoroth', 'ghoul', 'ghast', 'ghoulking']) {
      const leaked = new RegExp(`\\b${upstream}\\b`).test(facing);
      expect({ upstream, leaked }).toEqual({ upstream, leaked: false });
    }
  });
});

// ---------------------------------------------------------------------------
// Derived numbers — the whole point of copying the curve
// ---------------------------------------------------------------------------

describe('index_husk, derived', () => {
  const sheet = INDEX_HUSK.combat;

  it('is ACCURATE and hits for almost nothing, which is the ant all over', () => {
    // THE LARGEST SINGLE CORRECTION IN THIS FILE: accuracy 2 → 19 and defence
    // 0 → 1. The hand-authored husk had Dex 8 and an unarmed weapon, giving
    // `4 + 0 + 0 + (8 − 10)` = 2; the ant has Dex 10 and `atk = 15` on its
    // mandibles (ant.lua:37), giving `4 + 15 + (10 − 10)` = 19 before the
    // rescale. ToME gives its floor-one trash real accuracy and then makes it
    // harmless by giving it almost no damage — the authored version had that
    // exactly backwards, and it is why the roster read as "everything misses".
    expect(combatAttack(sheet)).toBe(19);
    // ant.lua:36 `combat_def = 1`, and Dex 10 contributes nothing.
    expect(combatDefense(sheet)).toBe(1);

    // checkHit is linear: ceil(50 + 2.5 × (atk − def)), Combat.lua:337-350.
    // NB none of this is live: `strike` takes no to-hit roll at all — see the
    // note on DEFAULT_MONSTER_DAMAGE_MIN in engine/actor.ts.
    expect(hitChance(combatAttack(sheet), 0)).toBe(98);
    expect(hitChance(4, combatDefense(sheet))).toBe(58);
  });

  it('swings for a flat 5 from a weapon rating of 5', () => {
    // ant.lua:37 `dam=resolvers.levelup(resolvers.rngavg(5,5),1,1)` = 5, with
    // `dammod={str=0.6}` → totstat 7.2, so
    // 0.3 × rescale(str 12 + 7.2) × damagePower(5 + 7.2) (Combat.lua:1661-1687).
    expect(combatDamage(sheet)).toBeCloseTo(5.9979, 4);

    // The range roll TRUNCATES both endpoints (damage.ts `rollDamageRange`), so
    // the swing collapses to a flat 5: 5.9979 × 1.1 = 6.5977, and both ends
    // truncate to 5 and 6 respectively... except the LOW end truncates to 5.
    //
    // WATCH THIS ONE. The low end is 5.9979 — two thousandths BELOW the
    // boundary. A tweak to Strength or the weapon rating that adds 0.003 turns
    // this monster from "5 or 6" into "6", a 20% damage jump nobody will connect
    // to the change that caused it.
    const high = combatDamage(sheet) * combatDamageRange(sheet);
    expect(Math.trunc(combatDamage(sheet))).toBe(5);
    expect(Math.trunc(high)).toBe(6);
    expect(combatDamage(sheet)).toBeLessThan(6);
    expect(combatDamage(sheet)).toBeGreaterThan(5.99);
  });

  it('carries one point of armour and the bare minimum crit', () => {
    expect(combatArmor(sheet)).toBe(1);
    // Base 30 and nothing added — Combat.lua:1336. 70% of every blow bypasses it.
    expect(combatArmorHardiness(sheet)).toBe(30);
    // Cun is absent, so it takes the engine base of 10 → (10 − 10) × 0.3 = 0,
    // leaving only the weaponless +1 at Combat.lua:1424. The old 0.4 came from
    // a hand-authored Cun 8; the ant authors no Cunning at all.
    expect(combatCrit(sheet)).toBeCloseTo(1, 10);
  });

  it('resists nothing whatsoever, because BASE_NPC_ANT resists nothing', () => {
    // The old husk carried `resists { Mind: 25 }` tagged INVENTED, justified as
    // "a husk is already half-erased, so a mind attack finds less to grip". A
    // giant brown ant has no `resists` table at all, so the invention came out
    // with the rest of them — and the roster's first creature now teaches the
    // pipeline's default rather than a made-up exception to it.
    expect(sheet.profile).toBeUndefined();
    expect(combatGetResist(sheet.profile ?? {}, DamageType.Mind)).toBe(0);
    expect(combatGetResist(sheet.profile ?? {}, DamageType.Fire)).toBe(0);
  });
});

describe('index_wraith, derived', () => {
  const sheet = INDEX_WRAITH.combat;

  it('is HARD TO HIT rather than accurate, which inverts the old sheet', () => {
    // losgoroth.lua:64 `combat_armor = 0, combat_def = 20`, and :44 Dex 8.
    // Defence: max(0, 20 + (8 − 10) × 0.35) = 19.3, rescaled to 19. Accuracy:
    // 4 + 15 (weapon atk, :30) + (8 − 10) = 17.
    //
    // Both moved a long way — accuracy 7 → 17 and defence 1 → 19 — and the
    // second is the creature. The hand-authored wraith was a Dex-13 sniper with
    // one point of dodge; the losgoroth is a slow tough floater that is hard to
    // connect with and buys its survival with DODGE, not armour. The "sniper"
    // reading was invented.
    expect(combatAttack(sheet)).toBe(17);
    expect(combatDefense(sheet)).toBe(19);
    expect(combatArmor(sheet)).toBe(0);
    // A default detective (accuracy 4) against 19 defence is a coin flip well
    // below even, which is what a kiter's dodge is supposed to buy.
    expect(hitChance(4, combatDefense(sheet))).toBe(13);
  });

  it('throws the orb with Magic alone, which is what its own dammod says', () => {
    // losgoroth.lua:30 `dammod={mag=0.8}` → totstat = 6 × 0.8 = 4.8, over a
    // weapon rating of 15 (`resolvers.mbonus(40,15)` at level 1) and Str 10.
    // The old { dex: 0.5, cun: 0.4 } was invented "in the shape of ToME's own
    // ranged dammod"; this IS ToME's own ranged dammod, for this creature.
    expect(combatDamage(sheet)).toBeCloseTo(5.055, 4);
    expect(Math.trunc(combatDamage(sheet))).toBe(5);
    // 5.055 × 1.1 = 5.56, which truncates back to 5 — the low-damage collapse
    // ToME's `rng.range` has by construction. The orb hits for a flat 5.
    expect(Math.trunc(combatDamage(sheet) * combatDamageRange(sheet))).toBe(5);
  });

  it('shrugs off darkness and is VULNERABLE to a solid hit', () => {
    const profile = sheet.profile ?? {};
    // OURS: upstream's equivalent is `[DamageType.ARCANE] = 100`, which is
    // neither our damage type nor a number that belongs on floor one.
    expect(combatGetResist(profile, DamageType.Darkness)).toBe(50);

    // losgoroth.lua:46 `[DamageType.PHYSICAL] = -30`, VERBATIM. This field
    // carried an INVENTED tag and a value of −20; the invention was RIGHT and
    // the number was timid. A negative resist multiplies rather than subtracts
    // — damage_types.lua:345-352, `dam * (100 - res) / 100`.
    const physical = combatGetResist(profile, DamageType.Physical);
    expect(physical).toBeCloseTo(-30, 10);
    expect(applyResists(10, physical, 0)).toBeCloseTo(13, 10);

    // The floor is −100, which caps vulnerability at exactly double damage
    // rather than letting it run away.
    expect(applyResists(10, -100, 0)).toBe(20);
  });
});

describe('index_husk_elite, derived', () => {
  const sheet = INDEX_HUSK_ELITE.combat;

  it('is the husk with the ghoul ladder DELTA on it, not a copy of a ghoulking', () => {
    // ghoul.lua:63 → :101 is dam 10 → 30 (×3), atk 5 → 8 (+3), apr 3 → 4 (+1),
    // applied to the ant's `dam=5, atk=15, apr=7` (ant.lua:37). `dam` is the one
    // ratio in the table because 10 → 30 is a clean tripling and 5 → 8 is not a
    // clean anything. Everything the ladder does not move — the stats — the
    // elite inherits from the husk unchanged: it is the SAME CREATURE, edited.
    expect(sheet.weapon).toEqual({ dam: 15, atk: 18, apr: 8, damMod: { str: 0.6 } });
    expect(sheet.stats).toEqual(INDEX_HUSK.combat.stats);
    // armour +1 (:55 → :93) and def +3 (7 → 10) on the ant's 1 / 1 (ant.lua:36).
    expect(sheet.mods).toEqual({ armour: 2, def: 4 });
  });

  it('hits harder than the husk it upgrades, but only by the square root', () => {
    // Tripling the weapon rating (5 → 15) moves the damage 5.9979 → 7.0964,
    // which is +18%, because Combat.lua:1682-1687 puts the rating under a square
    // root. An elite is not a bigger number; see this template's header for the
    // 1.22× rank-life claim that used to sit here and was a mis-read of
    // Actor.lua:1740-1751.
    expect(combatDamage(sheet)).toBeCloseTo(7.0964, 4);
    expect(combatDamage(sheet)).toBeLessThan(combatDamage(INDEX_HUSK.combat) * 1.3);

    // 7.0964 × 1.1 = 7.806, which truncates back to 7 — the low-damage collapse
    // ToME's `rng.range` has by construction. The elite hits for a flat 7.
    expect(Math.trunc(combatDamage(sheet))).toBe(7);
    expect(Math.trunc(combatDamage(sheet) * combatDamageRange(sheet))).toBe(7);
  });

  it('carries two points of armour at the BASE hardiness, and no invented crit', () => {
    expect(combatArmor(sheet)).toBe(2);
    // 30 base and nothing added — Combat.lua:1336. The old block authored
    // `armourHardiness: 5` and `physCrit: 5`, both invented (the crit anchored
    // on a `crit_chance: 0.05` from a different game entirely). The ghoulking
    // authors neither: rank-based resists and crit in ToME come from per-level
    // rng draws inside `levelup()` (Actor.lua:3801-3806), which is autolevel and
    // out of scope.
    expect(combatArmorHardiness(sheet)).toBe(30);
    expect(sheet.mods?.armourHardiness).toBeUndefined();
    expect(sheet.mods?.physCrit).toBeUndefined();
    expect(combatCrit(sheet)).toBeCloseTo(1, 10);
    // 4 + 18 (weapon atk) + (Dex 10 − 10) = 22 raw, rescaled to 21.
    expect(combatAttack(sheet)).toBe(21);
  });

  it('resists nothing, because the ghoulking authors no resists', () => {
    // The old block carried `resists { all: 10, Mind: 25 }`, both invented, the
    // pair chosen purely to exercise the multiplicative composition rule. That
    // rule still has a test — the next one — driven from a synthetic profile,
    // which is where a rule-exerciser belongs. It is not content.
    expect(sheet.profile).toBeUndefined();
    expect(combatGetResist(sheet.profile ?? {}, DamageType.Mind)).toBe(0);
  });

  it('costs a party about five rounds rather than a solo detective forty', () => {
    // The sizing argument, written down so a future retune has something to
    // argue with. Every monster in the roster deals 3-6 through `strike` and
    // every detective deals 4-7 (engine/actor.ts), so four M3-shaped detectives
    // put roughly 13 a round out, and 60 life is between four and five rounds.
    //
    // DEVIATION, WRITTEN DOWN. A faithful port would put this at 25: ToME's own
    // three-tier ghoul ladder holds `max_life = resolvers.rngavg(90,100)` across
    // ALL THREE tiers (ghoul.lua:54, :71, :92) and buys the top tier's threat
    // entirely with dam/atk/apr/def/armour/cadence — none of which we can spend
    // yet, because the damage sheet is not wired to the swing. Life and
    // behaviour are the elite's only live levers today.
    expect(INDEX_HUSK_ELITE.maxHp).toBe(60);
    expect(resolveRngAvg(90, 100)).toBe(95);
    // ...and it is genuinely a step up from the creature it upgrades, which is
    // the property the deviation exists to preserve.
    expect(INDEX_HUSK_ELITE.maxHp).toBeGreaterThan(INDEX_HUSK.maxHp);
    expect(INDEX_HUSK_ELITE.maxHp).toBeLessThan(110);
  });
});

describe('the resist composition rule, on a synthetic profile', () => {
  /**
   * `all: 10` × `Mind: 25` — DECLARED HERE, NOT ON A CREATURE.
   *
   * This pair used to live on `index_husk_elite`, invented for the sole purpose
   * of exercising Combat.lua:2227-2228. The re-base deleted both (the ghoulking
   * authors no resists), and deleting the exerciser with them would have quietly
   * dropped coverage of a real rule that is invisible in review when it is
   * wrong. So the pair moved into the test file, which is where a rule probe
   * belongs: content should describe a creature, not a code path.
   */
  const SYNTHETIC: DamageProfile = {
    resists: { all: 10, [DamageType.Mind]: 25 },
  };

  it('composes `all` with the typed row MULTIPLICATIVELY: 32.5, not 35', () => {
    // Combat.lua:2220-2231 — `100 × (1 − (1 − a)(1 − b))`, WITH the clamps at
    // :2227-2228. all 10 and mind 25 give 100 × (1 − 0.9 × 0.75) = 32.5.
    // Addition would give 35, and that error is invisible in review and
    // compounds everywhere resistance sources stack.
    expect(combatGetResist(SYNTHETIC, DamageType.Mind)).toBeCloseTo(32.5, 10);
    expect(combatGetResist(SYNTHETIC, DamageType.Mind)).not.toBeCloseTo(35, 1);
    // The `all` row alone, for a type with no entry of its own.
    expect(combatGetResist(SYNTHETIC, DamageType.Fire)).toBeCloseTo(10, 10);
  });

  it('is not a fact about any creature in the roster', () => {
    // The counterpart assertion, so nobody re-adds the pair to a template to
    // "make the test more realistic". No M3 creature composes two resist rows.
    for (const template of MONSTER_TEMPLATES) {
      expect({ id: template.id, all: template.combat.profile?.resists?.all }).toEqual({
        id: template.id,
        all: undefined,
      });
    }
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

  it('closes to its stand-off distance and stops there', () => {
    // Chebyshev 8 — exactly its `aggroRange`, so it can see the detective — and
    // Euclidean 8, which is past its `preferredRange` of 4
    // (tome/resolvers.lua:901, `safe_range = 4`).
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
    // ...and it stays there rather than drifting: from inside the band the only
    // two things it will ever decide are "shoot" and "hold my aim", never
    // another step. The `talentIn` gate makes which one a coin flip, so the
    // assertion is over the SET of decisions across many turns.
    const decisions = new Set<string>();
    for (let turn = 0; turn < 20; turn += 1) {
      decisions.add(decideNpcAction(wraith, ctx).kind);
    }
    expect([...decisions].sort()).toEqual([IntentKind.Attack, IntentKind.Hold].sort());
  });

  it('fires on a 1 and holds its aim on anything else — losgoroth.lua:43', () => {
    // `ai_state = { talent_in = 2 }` is a 1-IN-2 CHANCE PER TURN
    // (ai/talented.lua:122, `rng.chance(self.ai_state.talent_in or 6)`), NOT one
    // shot every two turns. This is half the answer to "the wraith kills too
    // fast": the old one fired every single turn from the edge of its reach.
    //
    // The script is [keep-roll, fire-roll]: the target-keep at simple.lua:253
    // draws first and only when there is already a remembered target, so the
    // FIRST call short-circuits it and needs one number, not two.
    const board = (): { player: EngineActor; wraith: MonsterActor } => ({
      player: detective('p1', { x: 5, y: 4 }),
      wraith: spawn(INDEX_WRAITH, 'm1', { x: 9, y: 4 }),
    });

    const hot = board();
    const fires = decideNpcAction(
      hot.wraith,
      aiCtx(passable, [hot.player, hot.wraith], scriptedRng([1])),
    );
    expect(fires).toEqual({ kind: IntentKind.Attack, targetId: 'p1' });

    const cold = board();
    const holds = decideNpcAction(
      cold.wraith,
      aiCtx(passable, [cold.player, cold.wraith], scriptedRng([2])),
    );
    expect(holds).toEqual({ kind: IntentKind.Hold });
    // A held shot is not a blocked turn — it is standing exactly where it wants
    // to stand — so nothing may accumulate toward the shoulder escalation a
    // kiter must never run.
    expect(cold.wraith.ai.blockedTurns).toBe(0);
  });

  it('takes the fire roll ONLY when it actually has a shot lined up', () => {
    // The stream-position guarantee. A wraith that is out of its band,
    // retreating or cornered must consume the seeded stream exactly as it did
    // before the gate existed — otherwise the number of wraiths on a floor
    // changes what every other actor rolls, which is the one thing
    // replay-from-seed cannot survive.
    //
    // Nine tiles away: too far to see (aggroRange 8), so it does not even
    // target. Zero draws of any kind.
    const far = detective('p1', { x: 1, y: 4 });
    const distant = spawn(INDEX_WRAITH, 'm1', { x: 13, y: 4 });
    const noDraws = scriptedRng([]);
    expect(decideNpcAction(distant, aiCtx(passable, [far, distant], noDraws))).toEqual({
      kind: IntentKind.Hold,
    });
    expect(drawCount(noDraws)).toBe(0);

    // Inside the dead zone: it retreats. Straight away from the target is open,
    // so `flee_simple` never even reaches its sidestep coin flips — and it
    // certainly never reaches `ai.fire.chance`. An empty script proves it: the
    // scripted generator THROWS on any draw at all.
    const near = detective('p2', { x: 6, y: 4 });
    const pressed = spawn(INDEX_WRAITH, 'm1', { x: 7, y: 4 });
    const fleeRng = scriptedRng([]);
    const retreat = decideNpcAction(pressed, aiCtx(passable, [near, pressed], fleeRng));
    expect(retreat).toEqual({ kind: IntentKind.Move, dir: 'e' });
    expect(drawCount(fleeRng)).toBe(0);
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
      // Both absent on a melee creature, and `undefined` must arrive as
      // `undefined` rather than being defaulted anywhere along the way: absent
      // `projSpeed` is ToME's "instantaneous" (ActorTalents.lua:988) and absent
      // `talentIn` is "every turn" (talented.lua:122).
      proj: elite.projSpeed,
      talent: elite.talentIn,
    }).toEqual({
      rank: ActorRank.Elite,
      hp: 60,
      maxHp: 60,
      reach: 1,
      // The ghoul ladder moves no speed field, so the delta is zero and the
      // elite inherits the husk's `global_speed_base = 0.9` (ant.lua:58). It
      // used to be 1, i.e. FASTER than its own base creature.
      speed: 0.9,
      sheet: INDEX_HUSK_ELITE.combat,
      hunts: true,
      shoulder: 5,
      blocked: 0,
      shouldering: 0,
      // Also a zero delta: the elite sees exactly as far as the husk
      // (ant.lua:38, `infravision = 10`).
      aggro: 10,
      proj: undefined,
      talent: undefined,
    });
  });

  it('carries the wraith’s orb speed and fire cadence onto the live actor', () => {
    // The two new fields are on the ACTOR, not inside `ai`: `ai` holds what this
    // monster is thinking, and these are facts about the creature. Whatever
    // creates a projectile will read `projSpeed` and has no business reaching
    // into an AI state bag for it.
    const wraith = spawn(INDEX_WRAITH, 'm1', { x: 4, y: 5 });
    expect({ proj: wraith.projSpeed, talent: wraith.talentIn }).toEqual({ proj: 2, talent: 2 });
    expect(Object.keys(wraith.ai)).not.toContain('projSpeed');
    expect(Object.keys(wraith.ai)).not.toContain('talentIn');
  });
});
