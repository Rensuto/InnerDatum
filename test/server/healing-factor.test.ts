// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/modules/tome/class/Actor.lua:2053-2056 (regenLife)
//                       game/modules/tome/class/Actor.lua:2087-2089 (onHeal)
//                       game/modules/tome/class/Actor.lua:3889 (con -> healing_factor)
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

import { readFileSync, readdirSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  HEAL_FACTOR_MAX,
  HEAL_FACTOR_MIN,
  healingFactor,
} from '../../src/server/engine/derived.ts';
import { actBase, createMonsterActor, AiProfile } from '../../src/server/engine/actor.ts';
import { healActor } from '../../src/server/engine/talents.ts';
import type { HealTarget } from '../../src/server/engine/talents.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * CONSTITUTION BOUGHT A HEALING BONUS THAT ALMOST NOTHING SPENT.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Upstream applies `healing_factor` in exactly two places, and between them they
 * cover every way a body gains life:
 *
 *   Actor.lua:2055  regenLife  `life_regen * util.bound(healing_factor, 0, 2.5)`
 *   Actor.lua:2089  onHeal     `value * util.bound(healing_factor, 0, 2.5)`
 *
 * Ours had `healActor`, whose docblock states the design exactly — *"it belongs
 * HERE rather than in each of the four talents that heal … so a fifth heal added
 * later cannot forget it"* — and then EIGHT places raised hit points and only
 * that one applied the factor. Four talents wrote `hp = min(maxHp, hp + n)` by
 * hand (one of them in a file that imports `healActor` and uses it correctly
 * twelve lines away), regeneration did not scale, and neither did resting.
 *
 * So the Constitution scale shipped earlier reached a single consumable.
 */

const CON_10 = { stats: { str: 10, dex: 10, con: 10, wil: 10, cun: 10 } };
const CON_100 = { stats: { str: 10, dex: 10, con: 100, wil: 10, cun: 10 } };

const body = (combat: HealTarget['combat'], hp = 10): HealTarget => ({
  hp,
  maxHp: 1000,
  alive: true,
  combat,
});

describe('the factor itself', () => {
  it('is 1.0 at the base Constitution and 1.5 at the cap', () => {
    // Actor.lua:3889 — `combatStatLimit("con", 1.5, 0, 0.5)`: +0 at 10, +0.50 at
    // 100. A body of ordinary sturdiness is unchanged, which is what makes this
    // safe to apply everywhere at once.
    expect(healingFactor(CON_10)).toBeCloseTo(1, 10);
    expect(healingFactor(CON_100)).toBeCloseTo(1.5, 10);
  });

  it('is bounded 0..2.5 where it is spent, exactly as `util.bound` bounds it', () => {
    expect(HEAL_FACTOR_MIN).toBe(0);
    expect(HEAL_FACTOR_MAX).toBe(2.5);
  });
});

describe('an explicit heal — Actor.lua:2087-2089 `onHeal`', () => {
  it('pays the RECEIVER`s Constitution, not the caster`s', () => {
    // A bandage is worth more on somebody built to survive.
    expect(healActor(body(CON_10), 100)).toBe(100);
    expect(healActor(body(CON_100), 100)).toBe(150);
  });

  it('never turns a heal of 1 into a heal of 0', () => {
    // Rounded rather than floored: a talent that healed nothing would read as
    // broken, and the factor is never below 1 for any authored body.
    expect(healActor(body(CON_10), 1)).toBe(1);
  });
});

describe('regeneration — Actor.lua:2053-2056 `regenLife`', () => {
  function ticking(combat: HealTarget['combat'], regen: number) {
    const actor = createMonsterActor('m1', {
      name: 'Index Husk',
      sprite: 'enemy_index_husk_s',
      x: 1,
      y: 1,
      profile: AiProfile.MeleeChaser,
    });
    actor.combat = combat;
    actor.maxHp = 1000;
    actor.hp = 100;
    actor.hpRegen = regen;
    return actor;
  }

  it('scales the tick by the same factor a heal gets', () => {
    /**
     * THE HALF THAT WAS MISSING ENTIRELY. `actBase` added `hpRegen` flat, so a
     * body with 100 Constitution regenerated at exactly the rate of one with 10
     * — while its character sheet printed "Healing mod. 150%".
     */
    const plain = ticking(CON_10, 4);
    const sturdy = ticking(CON_100, 4);
    actBase(plain);
    actBase(sturdy);
    expect(plain.hp).toBeCloseTo(104, 10);
    expect(sturdy.hp).toBeCloseTo(106, 10);
  });

  it('still stops at maximum rather than banking overheal', () => {
    const sturdy = ticking(CON_100, 4);
    sturdy.hp = 999;
    actBase(sturdy);
    expect(sturdy.hp).toBe(1000);
  });

  it('does nothing at all to a body with no regeneration', () => {
    // Every pre-existing fixture. `hpRegen: 0` must produce the byte-identical
    // turn it always did, factor or no factor.
    const idle = ticking(CON_100, 0);
    actBase(idle);
    expect(idle.hp).toBe(100);
  });
});

describe('the one door, so a fifth heal cannot forget', () => {
  it('no talent raises hit points by hand', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE ASSERTION `healActor`'s DOCBLOCK ASKED FOR AND NOBODY WROTE.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * It says the factor lives in `healActor` *"rather than in each of the four
     * talents that heal … so a fifth heal added later cannot forget it"*. All
     * four forgot it, because nothing stopped them: `hp = Math.min(maxHp, hp +
     * n)` type-checks perfectly and silently skips the whole rule.
     *
     * A SOURCE GUARD, on `save-lines.test.ts`' terms — the weakest kind of
     * test, chosen because the alternative is none. There is no runtime seam
     * that can see a talent doing its own arithmetic.
     *
     * `healActor` was widened to a structural `HealTarget` in the same commit,
     * because requiring the full `TalentActor` is WHY they wrote it by hand: a
     * passive hook is handed a `HookSelf`, which has no `kind` and no
     * `cooldowns`, so the correct call did not compile.
     */
    const dir = new URL('../../src/server/talents/', import.meta.url);
    const offenders: string[] = [];
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.ts')) continue;
      const text = readFileSync(new URL(name, dir), 'utf8');
      // `hp + <anything>` assigned back, in any of the shapes a talent uses.
      if (/\.hp\s*=\s*Math\.min\([^)]*\.maxHp[^)]*\.hp\s*\+/.test(text)) offenders.push(name);
    }
    expect(
      offenders,
      'a talent healed by hand — it will not pay the receiver`s Constitution',
    ).toEqual([]);
  });

  it('and the two regeneration sites both apply it', () => {
    // `actBase` is the ordinary turn and `turn-engine.ts` is the rest, which
    // pays the same `hpRegen` at an accelerated rate. A factor on one and not
    // the other would make resting and waiting disagree about Constitution.
    const engine = readFileSync(
      new URL('../../src/server/turn-engine.ts', import.meta.url),
      'utf8',
    );
    // `member`, not `self`, since the rest bonus went party-wide — upstream
    // pays it to every member (Player.lua:983-993) and each one's own
    // Constitution decides what it is worth.
    expect(engine).toContain('member.hpRegen * bonus * factor');
    const actor = readFileSync(
      new URL('../../src/server/engine/actor.ts', import.meta.url),
      'utf8',
    );
    expect(actor).toContain('actor.hpRegen * factor');
  });
});
