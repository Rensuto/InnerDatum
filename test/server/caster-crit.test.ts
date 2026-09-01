// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/modules/tome/data/talents/spells/fire.lua:46 (`self:spellCrit`)
//                       game/modules/tome/class/interface/Combat.lua:1834 (combatSpellCrit)
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

import { describe, expect, it } from 'vitest';

import { DamageType } from '../../src/server/engine/damage.ts';
import { talentProject } from '../../src/server/engine/talents.ts';
import { AiProfile, createMonsterActor, createPlayerActor } from '../../src/server/engine/actor.ts';
import { createRng } from '../../src/shared/rng.ts';
import type { CombatSheet } from '../../src/server/engine/combat.ts';
import type { TalentCallCtx } from '../../src/server/engine/talents.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * TEN CASTER TALENTS COULD NOT CRIT, AND SIXTEEN WEAPON ONES COULD.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `talentProject` is the caster path — its own docblock says so, and the
 * Alchemist's and Redactor's whole kits go through it. It called `applyDamage`
 * with `mult`, `increase` and `penetration` and NO `critChance`, and
 * `applyDamage` takes no crit roll without one (deliberately: a bleed tick must
 * not crit). So a player buying crit chance bought nothing at all for half the
 * classes in the game, while `talentAttack` beside it passed `critChance` and
 * even took a `critBonus`.
 *
 * Upstream writes every direct-damage talent as
 * `projector(..., self:spellCrit(dam))` — fire.lua:46.
 *
 * ═══ HOW THIS WAS MISSED TWICE ═══
 * An audit reported it under the name `talentDamage`, which does not exist.
 * Grepping that name found nothing, and "no callers" was read as "no talent
 * uses the non-critting path" — the opposite of the truth. The name in the
 * finding was wrong; the finding was right.
 */

const caster = (mods: CombatSheet['mods']) => {
  const actor = createPlayerActor('p1', { name: 'Dalt', sprite: 'pc_detective_s', x: 1, y: 1 });
  actor.combat = { stats: { str: 10, dex: 10, con: 10, wil: 10, cun: 10 }, mods };
  return actor;
};

function victim() {
  const actor = createMonsterActor('m1', {
    name: 'Index Husk',
    sprite: 'enemy_index_husk_s',
    x: 2,
    y: 1,
    profile: AiProfile.MeleeChaser,
  });
  actor.hp = 100000;
  actor.maxHp = 100000;
  return actor;
}

/** Everything `talentProject` reads off the context, and nothing else. */
const ctx = (seed: string): TalentCallCtx =>
  ({
    // `markMultiplier` asks the engine whether the victim is marked; an
    // unmarked one multiplies by 1, which is what this fixture wants.
    engine: { effectOn: () => undefined, marksOn: () => [] },
    world: {},
    rng: createRng(seed),
  }) as unknown as TalentCallCtx;

/** Damage dealt by one projected hit from a caster with these mods. */
function dealt(mods: CombatSheet['mods'], seed = 'caster-crit'): number {
  return talentProject(ctx(seed), caster(mods), victim(), 100, DamageType.Fire, 1).damage;
}

describe('a projected talent rolls a crit', () => {
  it('a caster who cannot crit deals the base figure', () => {
    // `physCrit: -100` drives `combatCrit` below zero, where it floors at 0 —
    // so this is "no crit is possible", not "no crit happened to be rolled".
    expect(dealt({ physCrit: -100 })).toBeCloseTo(100, 10);
  });

  it('a caster who ALWAYS crits deals the crit multiple', () => {
    /**
     * THE ASSERTION THE WHOLE COMMIT IS FOR. With `critChance` absent this was
     * 100 for every caster in the game, at every Cunning, with every ring.
     *
     * `CRIT_BASE_POWER` is 1.5 (Combat.lua:1950), so a certain crit on 100 is
     * 150. Asserted as a RATIO rather than a literal so a future
     * `criticalPower` default cannot silently make this test about nothing.
     */
    const plain = dealt({ physCrit: -100 });
    const critter = dealt({ physCrit: 200 });
    expect(critter).toBeGreaterThan(plain);
    expect(critter / plain).toBeCloseTo(1.5, 6);
  });

  it('and `criticalPower` from gear raises the multiple', () => {
    // `criticalPower` is a `WIELDER_MOD_KEY` an ego grants (egos.ts `{floor: 6,
    // step: 4}`), and it reached the swing path and not this one. Same stat,
    // same body, two answers.
    const base = dealt({ physCrit: 200 });
    const powered = dealt({ physCrit: 200, criticalPower: 50 });
    expect(powered).toBeGreaterThan(base);
  });

  it('is deterministic for a seed, which is what the crit roll must not break', () => {
    /**
     * `shared/rng.ts`: every draw is labelled and a replay must reproduce a run
     * exactly. Adding a crit roll adds a draw, and a draw that is not seeded the
     * same way each time would make the same seed produce two different fights.
     *
     * A REAL PROPERTY rather than a count. The first version of this test
     * asserted that the results were finite, which is true of any number and
     * proves nothing — an honest weak test is still a test that measures
     * nothing.
     */
    for (const seed of ['a', 'b', 'c']) {
      expect(dealt({ physCrit: 200 }, seed)).toBe(dealt({ physCrit: 200 }, seed));
    }
    // AND DIFFERENT SEEDS DIVERGE, or the line above would hold for a constant.
    const seeds = new Set(['a', 'b', 'c', 'd', 'e'].map((s2) => dealt({ physCrit: 40 }, s2)));
    expect(seeds.size, 'every seed produced the same damage').toBeGreaterThan(1);
  });
});
