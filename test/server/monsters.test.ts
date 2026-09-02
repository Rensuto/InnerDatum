import { describe, expect, it } from 'vitest';

import { BLEED_POWER, EffectId, createMvpEffectState } from '../../src/server/content/effects.ts';
import { combatMindpower, combatPhysicalpower } from '../../src/server/engine/derived.ts';
import { setEffect } from '../../src/server/engine/effects.ts';

import { decideNpcAction } from '../../src/server/ai/npc.ts';
import { ALCHEMIST, INSPECTOR, WATCHMAN } from '../../src/server/content/classes.ts';
import {
  INDEX_HUSK,
  INDEX_EIDOLON,
  INDEX_HUSK_ELITE,
  INDEX_WRAITH,
  MONSTER_TEMPLATES,
  monsterById,
  monsterInit,
  validateTemplate,
  INDEX_GLUT,
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
import { createBarrier } from '../../src/server/engine/barrier.ts';
import { AttackRefusal, canAttack, combatDistance } from '../../src/server/engine/combat.ts';
import {
  DamageType,
  applyArmour,
  applyResists,
  combatGetDamageIncrease,
  combatGetResist,
} from '../../src/server/engine/damage.ts';
import {
  combatAPR,
  combatArmor,
  combatArmorHardiness,
  combatAttack,
  combatCrit,
  combatCritPower,
  combatDamage,
  combatDamageRange,
  combatDefense,
  combatSpellpower,
} from '../../src/server/engine/derived.ts';
import { pump, submitIntent } from '../../src/server/engine/scheduler.ts';
import { MONSTER_TALENT_LEVEL, combatTalentSpellDamage } from '../../src/server/engine/talents.ts';
import { toActorView } from '../../src/server/view/projector.ts';
import { createWorld } from '../../src/server/world/world.ts';
import { drawCount, scriptedRng } from '../helpers/scripted-rng.ts';
import { chebyshev } from '../../src/shared/coords.ts';
import { hitChance } from '../../src/shared/checkhit.ts';
import { ActorKind, ActorRank } from '../../src/shared/protocol.ts';
import { createRng } from '../../src/shared/rng.ts';
import type { MonsterTemplate } from '../../src/server/content/monsters.ts';
import type { AiCtx } from '../../src/server/ai/npc.ts';
import type { EngineActor, Intent, MonsterActor } from '../../src/server/engine/actor.ts';
import type { CombatSheet } from '../../src/server/engine/combat.ts';
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

/**
 * THE WRAITH'S AUTHORED ORB BAND, NARROWED ONCE.
 *
 * `damageMin` / `damageMax` are OPTIONAL on `MonsterTemplate` because a melee
 * creature must not carry them — it can never reach `scheduler.ts#fire`, so a
 * pair on a husk would be a number with no reader. That optionality is correct
 * content design and a nuisance in a balance test, where every read would
 * otherwise be `number | undefined` and every assertion would be half about
 * optionality.
 *
 * So it is narrowed here, exactly once, and the throw IS an assertion rather
 * than a convenience: the roster's one ranged creature must author a band, and
 * if it stops doing so this file should fail loudly at import rather than
 * quietly compare `undefined` to a target.
 */
const ORB = ((): { readonly min: number; readonly max: number; readonly mean: number } => {
  const { damageMin, damageMax } = INDEX_WRAITH;
  if (damageMin === undefined || damageMax === undefined) {
    throw new Error('index_wraith must author damageMin and damageMax — see monsters.ts');
  }
  return { min: damageMin, max: damageMax, mean: (damageMin + damageMax) / 2 };
})();

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
  it('is the three M3 asked for, plus one per ground that needed one', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THIS SAID "EXACTLY THE THREE TYPES M3 ASKS FOR", AND THAT CAP HAS DONE
     * ITS JOB AND EXPIRED.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * PLAN.md § M3: *"three enemy types (melee chaser, ranged kiter, one
     * elite)"*, and this test read *"four would be scope creep and two would be
     * an unmet definition of done."* It was right, and it was right for a long
     * time — a fourth creature added while the world was one grey room would
     * have been content nobody could tell apart from the other three.
     *
     * THE WORLD IS NOT THAT ANY MORE. Sixteen destinations have their own
     * ground and `makeArena` builds six different rooms — and three templates
     * became the ceiling on all of it, because six shapes with one roster is one
     * bestiary wearing six hats. Every judging panel that reviewed the world
     * design independently named the bestiary rather than the cartography as the
     * real problem.
     *
     * SO THE RULE THAT REPLACES THE CAP IS NOT A NUMBER: it is that a creature
     * has to BELONG TO SOMETHING THE PLAYER CHOSE. The eidolon is lethal where
     * sightlines are four tiles and target practice on the open moor; the cairn
     * is deadly across water and irrelevant the moment you find the ford. One
     * that was merely a bigger husk would still be scope creep, and this comment
     * is the argument against it.
     *
     * THE GLUT EXTENDS THE RULE RATHER THAN BREAKING IT, and the extension is
     * worth stating because it is not obvious: it belongs to a MARKER instead of
     * to a ground. `world/roamers.ts` draws four kinds on the overworld and one
     * of them was *Something Redacted*, wearing `enemy_index_glut_s` — a choice
     * the player was offered, with nothing behind it. A ground and a marker are
     * the same kind of thing here: both are something a player looked at and
     * decided about, and a creature that answers one of them is content rather
     * than escalation.
     *
     * THE OLD ASSERTION THAT `index_cairn` DID NOT EXIST WAS LEFT IN THE HISTORY
     * ON PURPOSE — *"whoever wrote it named the creature four commits early"* —
     * and then this file did it AGAIN, one line down, with
     * `expect(monsterById('index_glut')).toBeUndefined()`. Twice is a pattern:
     * an assertion that a thing does not exist is a note about what the roster
     * is missing, written by somebody who could already see the hole.
     */
    expect(MONSTER_TEMPLATES.map((t) => `${t.id}/${t.profile}/${t.rank}`)).toEqual([
      'index_husk/melee_chaser/normal',
      'index_wraith/ranged_kiter/normal',
      'index_husk_elite/melee_chaser/elite',
      'index_eidolon/melee_chaser/normal',
      'index_cairn/ranged_kiter/normal',
      'index_glut/melee_chaser/normal',
      'index_inspector/melee_chaser/elite',
      'index_inquisitor/ranged_kiter/elite',
      // AND THE ONE AUTHORED BODY. Every other row is a roster entry rolled into
      // a generated floor; this is placed. See `DelveSpec.boss`.
      'index_watcher/ranged_kiter/boss',
    ]);
    expect(monsterById('index_wraith')).toBe(INDEX_WRAITH);
    expect(monsterById('index_glut')).toBe(INDEX_GLUT);
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
    // ...and the LIFE IS NOW A PORT rather than the third deviation. This used
    // to assert 22 with the line below sitting under it as the declined
    // upstream value; the swing is live, the creature's damage is authored from
    // its own talent, and `resolvers.rngavg(40,60)` = 50 is simply what
    // losgoroth.lua:63 says. The two assertions stayed in this order on purpose:
    // the citation is one line below the number it produced.
    /**
     * ═══ 80, AND THE PORT SAYS 50 — A DEVIATION, RE-OPENED DELIBERATELY ═══
     * `resolvers.rngavg(40,60)` = 50 is still exactly what losgoroth.lua:63
     * says, and the assertion below still proves this file can read it. What
     * changed is the denominator: the intra-turn budget lets a party chain two
     * at-will talents a round, so party damage went from ~25.7 to ~51.4 and at
     * 50 life this creature died in 0.97 rounds — before the orb it exists to
     * fire could cross its own stand-off. See the sizing test below, which is
     * where the argument lives.
     */
    expect(INDEX_WRAITH.maxHp).toBe(80);
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
      ['index_eidolon', 'Index Eidolon', 'enemy_index_eidolon_s'],
      ['index_cairn', 'Index Cairn', 'enemy_index_cairn_s'],
      ['index_glut', 'Index Glut', 'enemy_index_glut_s'],
      ['index_inspector', 'A Disgraced Inspector', 'enemy_disgraced_inspector_s'],
      ['index_inquisitor', 'A High Inquisitor', 'enemy_high_inquisitor_s'],
      ['index_watcher', 'The Watcher', 'enemy_index_cairn_s'],
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
    // `wolf`, `crystal` and `wisp` join the list with the two creatures ported
    // from canine.lua and crystal.lua. The numbers and the behaviour come
    // across; the identity stays ours, and that is a licence obligation as much
    // as a taste one.
    for (const upstream of [
      'ant',
      'ants',
      'losgoroth',
      'ghoul',
      'ghast',
      'ghoulking',
      'wolf',
      'wolves',
      'warg',
      'crystal',
      'wisp',
    ]) {
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
    // AND IT IS NOW LIVE — `scheduler.ts#strike` resolves through
    // `combat.ts#attackTarget`, so this accuracy is what a husk actually rolls.
    // It used to be inert; see the note on DEFAULT_MONSTER_DAMAGE_MIN in
    // engine/actor.ts for what that cost and when it was fixed.
    expect(hitChance(combatAttack(sheet), 0)).toBe(98);
    // 4 is ToME's BARE unarmed accuracy (Combat.lua:1343) — a sheet-less actor,
    // which since the swing moved onto `attackTarget` means a test fixture and
    // nothing else. A classless detective carries `DEFAULT_PLAYER_COMBAT` and
    // rolls 19 against this defence, for 95%.
    expect(hitChance(4, combatDefense(sheet))).toBe(58);
    expect(hitChance(19, combatDefense(sheet))).toBe(95);
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
    // A sheet-less fixture (ToME's bare accuracy 4) against 19 defence is a
    // coin flip well below even, and a classless detective's placeholder 19 is
    // an exact coin flip — which is what a kiter's dodge is supposed to buy.
    expect(hitChance(4, combatDefense(sheet))).toBe(13);
    expect(hitChance(19, combatDefense(sheet))).toBe(50);
  });

  it('swings its MELEE weapon with Magic alone, which its own dammod says', () => {
    // losgoroth.lua:30 `dammod={mag=0.8}` → totstat = 6 × 0.8 = 4.8, over a
    // weapon rating of 15 (`resolvers.mbonus(40,15)` at level 1) and Str 10.
    // The old { dex: 0.5, cun: 0.4 } was invented "in the shape of ToME's own
    // ranged dammod"; this IS ToME's own dammod, for this creature.
    //
    // THIS BLOCK'S COMMENT USED TO END "The orb hits for a flat 5" AND THAT WAS
    // FALSE. losgoroth.lua:30's `combat` is the creature's MELEE weapon — it
    // carries `atk`, `apr` and a `dammod` — and the orb is a talent
    // (T_VOID_BLAST, misc/npcs.lua:739) whose damage lives on `damageMin` /
    // `damageMax` and is pinned in the next test. The three assertions below
    // were always true and stay verbatim; only what they are ABOUT changed.
    //
    // Nothing routes this creature into `attackTarget` today — `resolveIntent`
    // forks to `fire` first — so these three describe the weapon it would swing,
    // and the `apr` on it, which the orb's impact really does read.
    expect(combatDamage(sheet)).toBeCloseTo(5.055, 4);
    expect(Math.trunc(combatDamage(sheet))).toBe(5);
    // 5.055 × 1.1 = 5.56, which truncates back to 5 — the low-damage collapse
    // ToME's `rng.range` has by construction. A melee swing would be a flat 5,
    // and `damage.ts` would take NO range draw for it (both endpoints agree),
    // which is precisely why `fire` was NOT rewritten to compute the orb this
    // way: it would delete a draw from the middle of every wraith turn.
    expect(Math.trunc(combatDamage(sheet) * combatDamageRange(sheet))).toBe(5);
  });

  it('throws an orb derived from T_VOID_BLAST, not from that melee block', () => {
    // ═══ THE PORTING ERROR THIS TEST EXISTS TO PIN ═══
    // The orb is NOT losgoroth.lua:30's `combat`. It is the one talent the
    // creature is granted (losgoroth.lua:67-69):
    //
    //   -- game/modules/tome/data/talents/misc/npcs.lua:739 (T_VOID_BLAST)
    //   self:projectile(tg, x, y, DamageType.VOID_BLAST,
    //       self:spellCrit(self:combatTalentSpellDamage(t, 15, 240)), …)
    //
    // `base` 15 and `max` 240 are npcs.lua:739's own two arguments; the talent
    // level is MONSTER_TALENT_LEVEL = 1 (players carry real points now; a
    // monster has no sheet, so this is the one name still true); the power is the creature's own spellpower.
    const power = combatSpellpower(sheet);
    expect(power).toBe(6); // Magic 6 (losgoroth.lua:44), no spellPower mod.
    const upstream = combatTalentSpellDamage(power, MONSTER_TALENT_LEVEL, 15, 240);
    expect(upstream).toBeCloseTo(24.9376, 4);

    // ═══ THE BODY-SCALE CORRECTION, SPELLED OUT ═══
    // ToME's level-1 life bar, MEASURED rather than assumed: the 22 `max_life`
    // entries in data/birth/classes/*.lua mean 100.455, plus Constitution's
    // 4 life per point over the engine base of 10 (Actor.lua:3884) at the
    // class-granted mean of 0.714 points = +2.86. Anchor 103.31, which EXCLUDES
    // race Con and the free birth points and is therefore the low end.
    const UPSTREAM_LEVEL_1_BAR = 103.31;
    // Ours: Watchman 72, Inspector 60, Alchemist 54 — median 60.
    const ourBars = [WATCHMAN.maxHp, INSPECTOR.maxHp, ALCHEMIST.maxHp].sort((a, b) => a - b);
    expect(ourBars).toEqual([54, 60, 72]);
    const OUR_MEDIAN_BAR = ourBars[1] ?? 0;
    const scaled = (upstream / UPSTREAM_LEVEL_1_BAR) * OUR_MEDIAN_BAR;
    expect(scaled).toBeCloseTo(14.48, 2);

    // Shipped: the derived integer, with a ±2 spread that is OURS — upstream's
    // orb is one number wrapped in `spellCrit`, and our `fire` path never rolls
    // a crit at all, so the band stands in for that variance. Symmetric, so the
    // mean is exactly the derived number.
    expect({ min: ORB.min, max: ORB.max, mean: ORB.mean }).toEqual({
      min: 12,
      max: 16,
      mean: 14,
    });
    expect(Math.round(scaled)).toBe(ORB.mean);
    // ...and it is nowhere near the melee block it was mistakenly taken from.
    expect(ORB.mean).toBeGreaterThan(combatDamage(sheet) * 2);
  });

  it('is the ONLY creature in the roster that authors orb damage', () => {
    // A melee template must leave both absent: it never reaches `fire`
    // (scheduler.ts forks on `projSpeed`), so authoring a pair would be a number
    // with no reader — and a reader who found it would reasonably assume the
    // creature had a ranged attack somewhere.
    for (const template of MONSTER_TEMPLATES) {
      const authored = template.damageMin !== undefined;
      expect({ id: template.id, authored }).toEqual({
        id: template.id,
        authored: template.projSpeed !== undefined,
      });
    }
  });

  it('refuses a damage band rng.int would throw on, or would half-inherit', () => {
    // `rng.int` throws a RangeError when max < min (src/shared/rng.ts), and it
    // would throw SYNCHRONOUSLY inside a pump — so a content typo would take a
    // turn down mid-resolution. Caught here instead.
    const inverted: MonsterTemplate = { ...INDEX_WRAITH, damageMin: 16, damageMax: 12 };
    expect(validateTemplate(inverted)).toEqual(['index_wraith: damageMax 12 < damageMin 16']);

    // Half-authored is the subtler bug: the missing half falls through to
    // `DEFAULT_MONSTER_DAMAGE_*` in engine/actor.ts — a number in another file
    // chosen for another purpose — and the result reads as a tuning decision.
    const halfA: MonsterTemplate = { ...INDEX_WRAITH, damageMax: undefined };
    const halfB: MonsterTemplate = { ...INDEX_WRAITH, damageMin: undefined };
    for (const half of [halfA, halfB]) {
      expect(validateTemplate(half)).toEqual([
        'index_wraith: damageMin and damageMax must be authored together',
      ]);
    }

    // A fraction cannot be a bound of an integer draw, and a negative minimum is
    // an orb that heals.
    expect(validateTemplate({ ...INDEX_WRAITH, damageMin: 12.5 })).toEqual([
      'index_wraith: damage bounds must be integers — rng.int refuses a fraction',
    ]);
    expect(validateTemplate({ ...INDEX_WRAITH, damageMin: -1 })).toEqual([
      'index_wraith: damageMin -1 must not be negative',
    ]);
    // Equal endpoints are legal: `rng.int` still takes its one draw, so a flat
    // orb costs the stream exactly what a banded one does.
    expect(validateTemplate({ ...INDEX_WRAITH, damageMin: 14, damageMax: 14 })).toEqual([]);
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
    // argue with, and RE-MEASURED now that the swing runs the real pipeline.
    // A classless detective carries `DEFAULT_PLAYER_COMBAT` (engine/actor.ts):
    // accuracy 19 against this creature's defence 4 is 88%, and a [6, 7] roll
    // through armour 2 at hardiness 30 lands as [4.2, 5.0] — call it 4.6. Four
    // of them put about 16 a round out, so 60 life is a little under four
    // rounds, which is what "a party, not a solo detective" is meant to mean.
    //
    // DEVIATION, WRITTEN DOWN. A faithful port would put this at 95: ToME's own
    // three-tier ghoul ladder holds `max_life = resolvers.rngavg(90,100)` across
    // ALL THREE tiers (ghoul.lua:54, :71, :92) and buys the top tier's threat
    // entirely with dam/atk/apr/def/armour/cadence. Those levers ARE live now —
    // the swing moved onto `attackTarget` — so this deviation is due a re-argue
    // the next time the elite is tuned; it is left alone here because retuning
    // is a separate job with its own measurements.
    /**
     * ═══ THE DEVIATION IS CLOSED. 95 IS THE PORT. ═══
     * This assertion read 60 under a note saying the deviation was *"due a
     * re-argue the next time the elite is tuned"*. This is that retune: the
     * intra-turn budget doubled party throughput, 60 became 1.17 rounds, and the
     * value that fixes it is the one ToME already authors across all three ghoul
     * tiers. The two lines below are now the same number, which is the whole
     * point of them being adjacent.
     */
    expect(INDEX_HUSK_ELITE.maxHp).toBe(95);
    expect(resolveRngAvg(90, 100)).toBe(95);
    // ...and it is genuinely a step up from the creature it upgrades, which is
    // the property the deviation exists to preserve.
    expect(INDEX_HUSK_ELITE.maxHp).toBeGreaterThan(INDEX_HUSK.maxHp);
    expect(INDEX_HUSK_ELITE.maxHp).toBeLessThan(110);
  });
});

// ---------------------------------------------------------------------------
// The balance table — the claim in content/monsters.ts, asserted
// ---------------------------------------------------------------------------

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS SECTION EXISTS AT ALL
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The wraith's header in content/monsters.ts carries a table of hp per player
 * turn for all three creatures against all three classes, and the whole argument
 * for `maxHp: 50` and for a 12-16 orb rests on it. A table in a comment rots the
 * first time somebody moves a Strength.
 *
 * So the table is recomputed here FROM THE REAL MODULES — `hitChance` out of
 * src/shared/checkhit.ts, `applyArmour` and `applyResists` out of
 * engine/damage.ts, the derived stats out of engine/derived.ts — and asserted
 * against the numbers written in the comment. It is an EXPECTATION rather than a
 * simulation: an expectation is exact, and a simulation of a 1% crit needs a
 * hundred thousand samples to be worth reading.
 */

/** Every stage of one LANDED melee blow, expected over the damage-range roll. */
function meanBlow(attacker: CombatSheet, defender: CombatSheet): number {
  const base = combatDamage(attacker);
  // damage.ts:273-277 — BOTH endpoints truncate, and the roll is a uniform
  // integer between them. Enumerated rather than sampled.
  const low = Math.trunc(base);
  const high = Math.trunc(base * combatDamageRange(attacker));
  const lo = Math.min(low, high);
  const hi = Math.max(low, high);

  const armour = combatArmor(defender);
  const hardiness = combatArmorHardiness(defender);
  const apr = combatAPR(attacker);
  // rollCrit clamps the chance itself (damage.ts:332-340), which is why the
  // clamp is here rather than inside `combatCrit`.
  const critChance = Math.min(Math.max(combatCrit(attacker), 0), 100) / 100;
  const critPower = combatCritPower(attacker);
  const type = attacker.damageType ?? DamageType.Physical;

  let total = 0;
  for (let rolled = lo; rolled <= hi; rolled += 1) {
    // Step 2, then step 3 — armour BEFORE crit, which is the ordering that IS
    // the balance (damage.ts's numbered pipeline).
    const afterArmour = applyArmour(rolled, armour, apr, hardiness);
    let dam = afterArmour * (1 - critChance) + afterArmour * critPower * critChance;
    const inc = combatGetDamageIncrease(attacker.increase, type);
    if (inc !== 0) dam = dam + (dam * inc) / 100;
    dam = applyResists(dam, combatGetResist(defender.profile ?? {}, type), 0);
    total += dam;
  }
  return total / (hi - lo + 1);
}

/** hp per PLAYER turn: what a monster takes off a body that is standing still. */
function damagePerPlayerTurn(template: MonsterTemplate, victim: CombatSheet): number {
  // THE ORB. No to-hit roll at fire or at impact, no damage-range roll, no crit
  // — see `fire` in engine/scheduler.ts. Armour with the SHOOTER's apr, and the
  // 1-in-N cadence gate on top.
  if (template.projSpeed !== undefined) {
    const min = template.damageMin ?? 0;
    const max = template.damageMax ?? 0;
    const apr = combatAPR(template.combat);
    const type = template.combat.damageType ?? DamageType.Physical;
    let total = 0;
    for (let rolled = min; rolled <= max; rolled += 1) {
      const afterArmour = applyArmour(
        rolled,
        combatArmor(victim),
        apr,
        combatArmorHardiness(victim),
      );
      total += applyResists(afterArmour, combatGetResist(victim.profile ?? {}, type), 0);
    }
    const perShot = total / (max - min + 1);
    return perShot * template.globalSpeed * (1 / (template.talentIn ?? 1));
  }

  // THE SWING. One `checkHit`, then the pipeline on a hit.
  const chance = hitChance(combatAttack(template.combat), combatDefense(victim)) / 100;
  return chance * meanBlow(template.combat, victim) * template.globalSpeed;
}

describe('the elite’s claw — the roster’s one melee rider', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * WHY THIS EXISTS: A TEMPLATE IS DATA, AND ITS `power` IS A DERIVED NUMBER.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `INDEX_HUSK_ELITE.onHit.power` is the creature's own `combatPhysicalpower`,
   * written into the frozen literal as a plain integer. It has to be a literal:
   * `combat` is defined further down the same object, so calling the getter from
   * inside it would make the roster's numbers depend on module initialisation
   * order — the exact class of bug this codebase's frozen-numbers doctrine is
   * about.
   *
   * The cost of a literal is drift. Retune the elite's Strength and the claw
   * quietly keeps applying at the old power, with nothing failing anywhere. This
   * test is the thing that fails.
   */
  it('applies at the elite’s real physical power, not a number that drifted', () => {
    expect(INDEX_HUSK_ELITE.onHit?.power).toBe(combatPhysicalpower(INDEX_HUSK_ELITE.combat));
  });

  it('four riders on the roster, and the husk has none', () => {
    /**
     * ═════════════════════════════════════════════════════════════════════════
     * TWO, AND THE ONE THAT MATTERS IS THE ONE WITHOUT.
     * ═════════════════════════════════════════════════════════════════════════
     *
     * A status every monster inflicts is a damage formula written twice. More
     * to the point, the INDEX HUSK must never have one: it is the first thing a
     * level-1 character fights, and that fight has a single job — teach that
     * walking into a marker starts one. An unexplained badge on a portrait in
     * the thirty seconds where somebody is still working out which token is
     * theirs teaches the opposite.
     *
     * The other two each got a rider for a reason written in their template
     * headers, and each rider answers something specific about that creature:
     * the elite's claw makes disengaging cost something, the wraith's orb makes
     * closing cost something. Adding a third is a real design decision, so it
     * should have to come here and change this line.
     */
    /**
     * THREE NOW, AND THE THIRD IS THE ONE THAT IS NOT A TAX.
     *
     * The wraith slows and the elite bleeds: both make a fight harder without
     * taking it away. `INDEX_WATCHER` STUNS, which is different in kind — it
     * removes turns — and it is the only creature in the game that does. Before
     * it, `EffectId.Stunned` was applied by exactly one call site in the whole
     * codebase, the Watchman's own `lockdown`; being stunned was something this
     * game did TO monsters.
     *
     * That asymmetry is why the boss is a boss rather than a bigger cairn, and
     * why `boss.test.ts` guards the stun's duration against its own cadence: an
     * unavoidable ranged stun that outlasts the gap between shots is not a hard
     * fight, it is a player who never acts again.
     */
    /**
     * FOUR NOW, AND THE FOURTH IS THE FIRST MENTAL ONE.
     *
     * The three above are all `type: physical`, so the whole bestiary rolled
     * against one save and a party's Willpower bought it nothing but mindpower.
     * `INDEX_EIDOLON` confuses (mental.lua:67-87), which is the first thing in
     * the game a mental save has ever been asked about.
     *
     * It goes on THAT creature because its own description was already the
     * mechanic — *"it moves the way a misremembered thing moves"* — and on a
     * MELEE one because contact is the counterplay: the answer to the eidolon
     * stays "do not let it reach you". Not on the Inquisitor, which is already
     * the roster's pure-debuff creature.
     */
    const withRiders = MONSTER_TEMPLATES.filter((t) => t.onHit !== undefined).map((t) => t.id);
    expect(withRiders.toSorted()).toEqual([
      'index_eidolon',
      'index_husk_elite',
      'index_watcher',
      'index_wraith',
    ]);
    expect(INDEX_HUSK.onHit).toBeUndefined();

    // AND EACH ONE IS THE STATUS ITS HEADER ARGUES FOR. Bleeding ignores armour,
    // so it punishes the body that stands still; Slowed costs a third of a
    // player's legs, so it punishes the body trying to close; Confused takes
    // away the one thing melee range was supposed to guarantee you, which is
    // knowing which way you are stepping.
    expect(INDEX_HUSK_ELITE.onHit?.effectId).toBe(EffectId.Bleeding);
    expect(INDEX_WRAITH.onHit?.effectId).toBe(EffectId.Slowed);
    expect(INDEX_EIDOLON.onHit?.effectId).toBe(EffectId.Confused);
  });

  it('the eidolon’s touch applies at its MINDPOWER, not its physical power', () => {
    /**
     * THE ONE ROW WHERE READING THE WRONG GETTER WOULD LOOK RIGHT.
     *
     * `combatMindpower` is 11 here and `combatPhysicalpower` is 10 — one apart,
     * so a test written against either passes and a fixture proves nothing. The
     * claim is not the number, it is WHICH DERIVATION: the effect is
     * `type: mental` (mental.lua:71) and `Actor.lua:6981-6986` keys the save off
     * the EFFECT rather than off the attack that delivered it, so what this
     * creature does to you is not a matter of how hard it hits.
     */
    expect(INDEX_EIDOLON.onHit?.power).toBe(combatMindpower(INDEX_EIDOLON.combat));
    expect(combatMindpower(INDEX_EIDOLON.combat)).not.toBe(
      combatPhysicalpower(INDEX_EIDOLON.combat),
    );
  });

  it('the wraith’s orb applies at the wraith’s real physical power', () => {
    // Same drift guard as the elite's, for the same literal-in-frozen-data
    // reason. See the note above.
    expect(INDEX_WRAITH.onHit?.power).toBe(combatPhysicalpower(INDEX_WRAITH.combat));
  });

  it('survives `monsterInit` onto the actor — the field that never got copied', () => {
    // `monsterInit` is the ONE mapper from template to actor, and it is a hand
    // written field list rather than a spread. That is the right shape (an
    // unmapped field is a compile error at `MonsterInit`, not a silent
    // `undefined`) and it is also exactly how a new field gets forgotten.
    const actor = createMonsterActor('m1', monsterInit(INDEX_HUSK_ELITE, { x: 4, y: 4 }));
    expect(actor.onHit).toEqual(INDEX_HUSK_ELITE.onHit);
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE GRADIENT IS THE WHOLE POINT — ARMOUR DOES NOT ANSWER A BLEED.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * game-design.md § 7: "Bleeding (damage per turn, ignores armour)". So the
   * claw cannot be shrugged off by the class wearing the most of it — which
   * would be a rider that only ever hurt the people who were already fragile.
   *
   * What DOES answer it is the physical save, and the Watchman has the highest
   * one on the roster (15, against the Inspector's 8 and the Alchemist's 7).
   * That is the correct incentive and it needed no separate rule: the body you
   * want standing in front of the elite is the body that shrugs its claw off
   * most often, and it still takes real damage for doing so.
   *
   * MEASURED OVER MANY APPLICATIONS, not one, because a single roll is a coin
   * and the claim is about the distribution. The assertion is the ORDERING —
   * pinning the percentages would make this a test of the seed.
   */
  it('costs the armoured body less than the fragile ones, through the save', () => {
    const claw = INDEX_HUSK_ELITE.onHit;
    expect(claw).toBeDefined();
    if (claw === undefined) return;

    const RUNS = 400;
    const bleedFor = (sheet: CombatSheet): number => {
      const state = createMvpEffectState();
      const rng = createRng('monsters.test:claw');
      let turns = 0;
      for (let i = 0; i < RUNS; i += 1) {
        const body = {
          id: 'b',
          name: 'b',
          kind: ActorKind.Player,
          hp: 9999,
          maxHp: 9999,
          alive: true,
          combat: sheet,
          cooldowns: new Map<string, number>(),
        };
        const landed = setEffect(
          state,
          body,
          claw.effectId,
          claw.turns,
          {
            ...(claw.power === undefined ? {} : { applyPower: claw.power }),
            ...(claw.magnitude === undefined ? {} : { power: claw.magnitude }),
          },
          rng,
        );
        turns += landed.dur;
        state.byActor.delete('b');
      }
      return (turns * BLEED_POWER) / RUNS;
    };

    const watchman = bleedFor(WATCHMAN.combat);
    const inspector = bleedFor(INSPECTOR.combat);
    const alchemist = bleedFor(ALCHEMIST.combat);

    // The Watchman takes the least, and by a margin worth feeling rather than a
    // rounding difference — under two thirds of what the Alchemist takes.
    expect(watchman).toBeLessThan(inspector);
    expect(watchman).toBeLessThan(alchemist * 0.66);

    // AND IT IS NEVER FREE. A save that reduced the claw to nothing for the
    // tank would make the elite a fight the Watchman solos by standing still.
    expect(watchman).toBeGreaterThan(0);
  });
});

describe('the balance table the wraith’s retune rests on', () => {
  const SHEETS = [
    ['Watchman', WATCHMAN.combat],
    ['Inspector', INSPECTOR.combat],
    ['Alchemist', ALCHEMIST.combat],
  ] as const;

  it('reproduces the hp-per-player-turn table written into content/monsters.ts', () => {
    const table = MONSTER_TEMPLATES.map((template) => [
      template.id,
      ...SHEETS.map(([, sheet]) => Number(damagePerPlayerTurn(template, sheet).toFixed(3))),
    ]);

    // Copied out of the comment block on INDEX_WRAITH, deliberately by hand: if
    // this test ever generated the expectation it would assert nothing.
    // In `MONSTER_TEMPLATES` order, which is roster order, not alphabetical.
    //                       Watchman  Inspector  Alchemist
    /**
     * THE GLUT'S ROW IS THE ONE WORTH READING TWICE: 5.527 / 5.527 / 6.633, the
     * second-lowest output in the game behind the husk, and below the wraith,
     * the elite, the eidolon and the cairn.
     *
     * That is the whole design confirmed rather than assumed. `damagePerPlayerTurn`
     * runs a real `hitChance(combatAttack, combatDefense)`, so `atk = 2` — the
     * lowest in the game by a factor of four — is already priced into these
     * numbers, and STR 20 through a 0.8 dammod is what pulls them back to
     * mid-pack. It misses, and misses, and then lands for a great deal.
     *
     * So a creature with sixty hit points, four armour and the only regeneration
     * in the game is NOT a difficulty spike. What it is dangerous to is a party
     * that will not commit, which is a different thing and is the fight.
     */
    expect(table).toEqual([
      ['index_husk', 4.378, 4.378, 4.875],
      ['index_wraith', 5.88, 5.88, 5.88],
      ['index_husk_elite', 5.888, 5.888, 6.332],
      // THE TWO NEW ROWS, AND THEY SAY THE DESIGN OUT LOUD.
      //
      // The eidolon takes the MOST damage of anything in the roster — armour 1
      // and defence 1 (canine.lua:43) against the wraith's defence 20 — so at 55
      // life it dies in five to nine player turns. It is not durable; it is
      // FAST, and the wood is what makes that matter.
      ['index_eidolon', 6.169, 9.533, 10.251],
      // The cairn's row is FLAT across all three classes, for the reason the
      // test below gives about the wraith: `apr` exceeds every class's armour,
      // so `applyArmour` removes nothing. At 23 life that is three player turns.
      // It survives by being unreachable, never by being tough.
      ['index_cairn', 7, 7, 7],
      ['index_glut', 5.527, 5.527, 6.633],
      /**
       * THE INQUISITOR'S 7/7/7 WAS PREDICTED BEFORE IT WAS MEASURED, and the
       * prediction is the reason to trust the creature rather than the number:
       * the orb is INDEX_WRAITH's 12-16 (mean 14) at `globalSpeed` 1.0 over
       * `talentIn` 2, and the model is `perShot * globalSpeed * (1/talentIn)`.
       * 14 x 1.0 / 2 = 7.0, which is exactly INDEX_CAIRN's.
       *
       * THAT WAS THE POINT. A second elite must not raise the sustained-damage
       * ceiling — it ties the existing top rather than beating it, and what
       * makes it elite is that unlike the cairn it MOVES, at the player's own
       * speed, with the longest reach in the game. You cannot walk away from it
       * and you cannot walk up to it.
       *
       * THE INSPECTOR IS EIDOLON-TIER AND FLAT ACROSS THE THREE CLASSES, which
       * is `apr = 15` doing exactly what the eidolon's `apr = 3` does not:
       * whatever the party is wearing, it punches through. The eidolon swings
       * between 6.169 and 10.251 depending on who it is hitting; this one does
       * not care. It is also the most fragile thing on either map at sixty hit
       * points with no armour — see `bestiary`.
       */
      ['index_inspector', 9.233, 9.233, 9.422],
      ['index_inquisitor', 7, 7, 7],
      /**
       * AND THE BOSS IS BELOW BOTH KITERS, WHICH IS THE POINT. 5.95 against the
       * cairn's 7.00: a boss is the LONGEST fight in the game, not the sharpest.
       * Its threat is two hundred and twenty hit points — more than double
       * anything else — and the turns it takes away, never the number per shot.
       * A boss that also topped this table would be a damage race with a health
       * bar attached.
       */
      ['index_watcher', 5.95, 5.95, 5.95],
    ]);
  });

  it('is one number for the orb and three for a swing, and apr is why', () => {
    // The wraith's row is flat across all three classes and the husks' rows are
    // not. That is not a rounding accident: `fire` passes `combatAPR(sheet)` —
    // losgoroth.lua:30's `apr = 15` — into the impact's armour stage, and 15
    // exceeds every class's armour, so `applyArmour` removes exactly nothing.
    expect(combatAPR(INDEX_WRAITH.combat)).toBe(15);
    for (const [, sheet] of SHEETS) {
      expect(combatArmor(sheet)).toBeLessThan(combatAPR(INDEX_WRAITH.combat));
      expect(applyArmour(14, combatArmor(sheet), 15, combatArmorHardiness(sheet))).toBe(14);
    }
    // ...and no class carries a Darkness resist to take the rest off.
    for (const [, sheet] of SHEETS) {
      expect(combatGetResist(sheet.profile ?? {}, DamageType.Darkness)).toBe(0);
    }
  });

  it('turns the ranged threat from half the husk into a third more than it', () => {
    // THE FINDING THAT STARTED THIS WORK ITEM, pinned as a ratio so it cannot
    // regress quietly. The wraith used to deal 1.890 against the husk's 4.050 —
    // the designated ranged threat was less than half as dangerous as the
    // baseline mob, because its orb was frozen at the 3-6 placeholder.
    const husk = damagePerPlayerTurn(INDEX_HUSK, WATCHMAN.combat);
    const wraith = damagePerPlayerTurn(INDEX_WRAITH, WATCHMAN.combat);
    expect(wraith / husk).toBeCloseTo(1.343, 3);

    // BEFORE, recomputed rather than quoted: 3-6 through the placeholder path
    // was a flat mean of 4.5 with no roll, no armour and no resists.
    const PLACEHOLDER_MEAN = (3 + 6) / 2;
    const before = PLACEHOLDER_MEAN * INDEX_WRAITH.globalSpeed * 0.5;
    expect(before).toBeCloseTo(1.89, 3);
    expect(before / (PLACEHOLDER_MEAN * INDEX_HUSK.globalSpeed)).toBeCloseTo(0.467, 3);

    // The band the retune was aimed at, stated so a future pass can argue with a
    // number instead of a feeling.
    expect(wraith).toBeGreaterThanOrEqual(5.5);
    expect(wraith).toBeLessThanOrEqual(7);

    // It sits one hair UNDER the elite, which is the top of the roster and is
    // meant to stay the top of the roster: the elite's damage is unavoidable
    // once it has reached you, and every point of the wraith's can be dodged.
    expect(wraith).toBeLessThan(damagePerPlayerTurn(INDEX_HUSK_ELITE, WATCHMAN.combat));
  });

  it('costs one to two orbs of a bar, never a bar', () => {
    // "Memorable, never lethal from full." One orb against 72 / 60 / 54.
    const bars = [WATCHMAN.maxHp, INSPECTOR.maxHp, ALCHEMIST.maxHp];
    for (const bar of bars) {
      expect(ORB.max / bar).toBeLessThan(0.32);
      expect(ORB.min / bar).toBeGreaterThan(0.16);
    }
    // ...and the squishiest body still needs four average orbs to go down, so no
    // single unlucky moment removes a player from the fight.
    expect(Math.ceil(ALCHEMIST.maxHp / ORB.mean)).toBe(4);
  });

  it('justifies 50 life in the party frame, and reports the solo frame honestly', () => {
    // THE FRAME, STATED: three detectives, one of each class, each spending
    // their turn on their slot-1 reliable talent — which is what the live game
    // is now that content/classes.ts is wired into the running server.
    //
    //   crude_blow      mult 1.0 through `attackTarget` (talents/crude_blow.ts)
    //   revolver_shot   mult 0.9 through `attackTarget` (talents/revolver_shot.ts)
    //   ashwick_flare   mult 1.3, NO to-hit and NO armour stage — a ToME spell
    //                   never touches `attackTargetWith` — plus the Alchemist's
    //                   `increase: { fire: 10 }` (talents/ashwick_flare.ts)
    const wraith = INDEX_WRAITH.combat;
    const swing = (sheet: CombatSheet, mult: number): number =>
      (hitChance(combatAttack(sheet), combatDefense(wraith)) / 100) *
      meanBlow(sheet, wraith) *
      mult;

    const crudeBlowDpt = swing(WATCHMAN.combat, 1);
    const revolverDpt = swing(INSPECTOR.combat, 0.9);
    let flareDpt = combatDamage(ALCHEMIST.combat) * 1.3;
    flareDpt =
      flareDpt +
      (flareDpt * combatGetDamageIncrease(ALCHEMIST.combat.increase, DamageType.Fire)) / 100;
    flareDpt = applyResists(flareDpt, combatGetResist(wraith.profile ?? {}, DamageType.Fire), 0);

    expect(crudeBlowDpt).toBeCloseTo(3.786, 3);
    expect(revolverDpt).toBeCloseTo(8.108, 3);
    expect(flareDpt).toBeCloseTo(13.814, 3);

    /**
     * ═══════════════════════════════════════════════════════════════════════
     * A ROUND, NOT A USE — and this line measured a use until the budget landed.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `DECISIONS.md` D1's intra-turn budget is real now: 6 AP a round, and the
     * three figures above are 3-AP talents, so each class casts TWICE. Crude
     * Blow and Revolver Shot are both `cooldownTurns: 0`, so the second cast is
     * genuinely available rather than theoretical; Ashwick Flare is gated by
     * reagents (1 of a stock of 8) rather than by cooldown, which is four rounds
     * of doubles before she is dry.
     *
     * Summing one use each modelled a party that no longer exists, and it is
     * exactly why the throughput change could ship without a single test
     * failing: nothing in this file knew how many actions a round allows.
     */
    const CASTS_PER_ROUND = 2;
    const party = (crudeBlowDpt + revolverDpt + flareDpt) * CASTS_PER_ROUND;
    // At 22 the creature died in under one party turn, while its orb needs 1.5
    // GAME turns to cross the stand-off — so it usually died before its first
    // orb ever landed. That is the argument for 50, and it is about time to
    // kill, not about how hard players hit.
    // THE INVARIANT IS THE POINT, AND THE FIGURE IS DERIVED FROM IT.
    // `> 1.5` is the rule: the orb needs 1.5 game turns to cross the stand-off,
    // so anything at or under that dies without ever firing. The ported 50 now
    // fails it outright against a chaining party, which is why the life moved.
    expect(50 / party).toBeLessThan(1.5);
    expect(INDEX_WRAITH.maxHp / party).toBeGreaterThan(1.5);
    expect(INDEX_WRAITH.maxHp / party).toBeCloseTo(1.556, 3);

    // OUT OF FRAME, REPORTED ANYWAY. A solo Watchman needs 13.206 player turns,
    // during which a wraith standing off at four tiles deals more than his whole
    // bar. A lone Watchman trading shots at range LOSES; his answer is to close,
    // because the creature cannot fire inside two tiles at all.
    // PER USE, not per round: this is the SOLO frame, and a lone Watchman
    // chaining Crude Blow twice still spends the same two casts on the same
    // creature. 21.1 swings at 80 life, up from 13.2 at 50 — the point of the
    // line is unchanged and gets stronger, which is that trading shots at range
    // with a kiter loses.
    expect(INDEX_WRAITH.maxHp / crudeBlowDpt).toBeCloseTo(21.13, 2);
    const takenSolo =
      (INDEX_WRAITH.maxHp / crudeBlowDpt) * damagePerPlayerTurn(INDEX_WRAITH, WATCHMAN.combat);
    expect(takenSolo).toBeGreaterThan(WATCHMAN.maxHp);

    // ...and the refuted premise, kept as an assertion so nobody restores the
    // old note. It claimed player damage rises "from 4-7 to the sheet's 10-12"
    // and that 50 life would therefore be a ten-hit kill. Both classes that can
    // swing at this creature land BELOW the old flat 5.5 against defence 19.
    const OLD_FLAT_PLAYER_DAMAGE = 5.5;
    expect(crudeBlowDpt).toBeLessThan(OLD_FLAT_PLAYER_DAMAGE);
    expect(swing(ALCHEMIST.combat, 1)).toBeLessThan(OLD_FLAT_PLAYER_DAMAGE);
    // The Inspector cannot swing at it at all: her sheet's dead zone refuses a
    // bump, which is why her row of the party frame is the revolver and not a
    // basic attack.
    expect(INSPECTOR.combat.minRange).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// The orb, fired for real
// ---------------------------------------------------------------------------

describe('a fired orb carries the authored damage and costs one draw', () => {
  /**
   * A live world, a detective who holds, and a wraith already standing at its
   * stand-off distance. Driven through the REAL scheduler rather than through a
   * hand-rolled `fire`, because the property being pinned is about where in the
   * seeded stream the draw happens, and only the real pump can be wrong about
   * that.
   */
  function encounter(seed: string) {
    const world = createWorld(seed);
    const player = world.addPlayer('p1', 'Detective');
    // Big enough that nothing dies mid-measurement — scheduler.test.ts's rule.
    player.maxHp = 10_000;
    player.hp = 10_000;
    player.x = 5;
    player.y = 2;
    const wraith = world.addMonster('m1', monsterInit(INDEX_WRAITH, { x: 9, y: 2 }));
    const barrier = createBarrier();
    // First pump parks on the human; the wraith has not acted yet.
    pump(world, { nowMs: 0, barrier });
    const before = world.rng.getState();
    expect(submitIntent(world, barrier, 'p1', { kind: IntentKind.Hold })).toBe(true);
    pump(world, { nowMs: 1, barrier });
    const after = world.rng.getState();
    return { world, wraith, draws: after.count - before.count, lastLabel: after.lastLabel };
  }

  // Two real seeds, chosen because the 1-in-2 coin lands each way on the first
  // act. Neither number is tuned for an outcome — the pair IS the measurement.
  const FIRES = 'b';
  const HOLDS = 'a';

  it('freezes 12-16 onto the orb, not the 3-6 placeholder', () => {
    const shot = encounter(FIRES);
    const orbs = shot.world.projectilesInFlight();
    expect(orbs.length).toBe(1);
    const orb = orbs[0];
    if (orb === undefined) throw new Error('the wraith did not fire');

    // The whole point of the field. Before it was authored, `monsterInit` passed
    // nothing and every orb this creature ever threw carried
    // `DEFAULT_MONSTER_DAMAGE_MIN..MAX` = 3-6 from engine/actor.ts.
    expect(orb.damage.dam).toBeGreaterThanOrEqual(ORB.min);
    expect(orb.damage.dam).toBeLessThanOrEqual(ORB.max);
    expect(orb.damage.dam).toBeGreaterThan(6);
    // Darkness is ours (upstream's void blast is Arcane), and the apr rides
    // along off the MELEE block, which is the one thing the orb still takes
    // from it.
    expect(orb.damage.type).toBe(DamageType.Darkness);
    expect(orb.damage.apr).toBe(combatAPR(INDEX_WRAITH.combat));
    expect(orb.sourceId).toBe('m1');
  });

  it('takes EXACTLY ONE `combat.bump.damage` draw, at the same stream position', () => {
    // THE DETERMINISM PROPERTY, ISOLATED BY SUBTRACTION rather than asserted by
    // reading the source. A wraith that holds its aim spends one draw — the
    // `ai.fire.chance` coin. A wraith that fires spends that same coin and then
    // exactly one more, and the last label in the stream is the damage roll.
    //
    // This is what forbids rewriting `fire` to call `rollDamageRange`:
    // `combatDamage` 5.055 × `damRange` 1.1 truncates to [5, 5], where
    // damage.ts:276 returns EARLY and takes no draw at all — which would delete
    // a draw from the middle of every wraith turn and shift every replay after.
    const held = encounter(HOLDS);
    expect(held.world.projectilesInFlight().length).toBe(0);
    expect(held.draws).toBe(1);
    expect(held.lastLabel).toBe('ai.fire.chance');

    const fired = encounter(FIRES);
    expect(fired.world.projectilesInFlight().length).toBe(1);
    expect(fired.draws).toBe(2);
    expect(fired.lastLabel).toBe('combat.bump.damage');

    expect(fired.draws - held.draws).toBe(1);
  });

  it('replays byte for byte from the same seed', () => {
    // The property the draw-count assertion above exists to protect.
    const a = encounter(FIRES);
    const b = encounter(FIRES);
    expect(JSON.stringify(a.world.projectilesInFlight())).toEqual(
      JSON.stringify(b.world.projectilesInFlight()),
    );
    expect(a.world.rng.getState()).toEqual(b.world.rng.getState());
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
      // 95 — the ported `resolvers.rngavg(90,100)`; see the sizing test.
      hp: 95,
      maxHp: 95,
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
