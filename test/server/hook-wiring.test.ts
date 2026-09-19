import { describe, expect, it } from 'vitest';

import {
  REDACTOR,
  WATCHMAN,
  createContentTalentEngine,
  sheetForClass,
} from '../../src/server/content/classes.ts';
import { healPerKillAt, indelible } from '../../src/server/talents/indelible.ts';
import { regenAt, walkItOff } from '../../src/server/talents/walk_it_off.ts';
import { talentLevelOf } from '../../src/server/engine/talents.ts';
import { createWorld } from '../../src/server/world/world.ts';
import { trained } from '../helpers/trained.ts';
import { bloodPrice, returnedAt } from '../../src/server/talents/leverage.ts';
import { reliefAt, stillStanding } from '../../src/server/talents/nerve.ts';
import { applyDamage, DamageType } from '../../src/server/engine/damage.ts';
import { createTurnProcs } from '../../src/server/engine/hooks.ts';
import { createRng } from '../../src/shared/rng.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * DOES ANYTHING ACTUALLY CALL THE HOOKS? — the question nothing was asking.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `fireTurnStart` was written, exported, given a context type and a dispatch
 * loop, and called by NOTHING — not the engine, not the scheduler, not a test,
 * not a tool. `walk_it_off.ts` sits in `GENERIC_PASSIVES`, the list every
 * character in this game carries, and promises *"you recover N hit points at
 * the start of each turn"*. Nobody ever recovered one.
 *
 * ═══ AND THERE WERE TESTS. THAT IS THE PART WORTH READING TWICE ═══
 * `nightshift.test.ts` covers this talent three times over — and each one calls
 *
 *     walkItOff.hooks?.onTurnStart?.(ctx)
 *
 * reaching into the module and invoking the hook by hand. Every one passes, and
 * every one would still pass if `fireTurnStart` were deleted outright. They
 * prove the hook BODY is correct, which it always was, and can say nothing at
 * all about whether the game runs it.
 *
 * `tools/status-live.mjs` names this exact trap in its own header: *"a test that
 * imports the module under test is exactly the thing that missed it."* It was
 * written after the status system shipped connected to nothing. This file is
 * that lesson applied one system along, and it goes through `engine.actBase` —
 * the real per-turn entry point — so it fails if the wiring is removed.
 *
 * See also the note in `engine/talents.ts` about `budgetPenalty`, which had zero
 * production callers and left SLOWED as a badge with no effect. Three instances
 * of one shape, in one engine.
 */
describe('the turn-start hooks are actually fired', () => {
  /** A Watchman with a wound, hooks hung on the body the way main.ts hangs them. */
  function woundedWatchman() {
    const world = createWorld('hook-wiring');
    const engine = createContentTalentEngine();
    const body = world.addPlayer('p1', 'Ren', { maxHp: WATCHMAN.maxHp });
    const sheet = engine.attach('p1', trained(sheetForClass(WATCHMAN)));

    /**
     * BOUND THE WAY `main.ts` BINDS THEM — `{ talentId, level, hooks }` hung on
     * the ACTOR, with the sheet's latch borrowed rather than copied. Building a
     * different shape here would be this file testing its own fixture.
     */
    body.talentHooks = [
      {
        talentId: walkItOff.id,
        level: talentLevelOf(sheet, walkItOff),
        hooks: walkItOff.hooks ?? {},
      },
    ];
    body.turnProcs = sheet.turnProcs;
    return { world, engine, body, sheet };
  }

  it('heals a wounded body through actBase, not through the talent object', () => {
    const { world, engine, body, sheet } = woundedWatchman();
    const level = talentLevelOf(sheet, walkItOff);
    expect(level, 'the fixture does not know Walk It Off').toBeGreaterThan(0);

    body.hp = body.maxHp - 20;
    const before = body.hp;

    // THE REAL PER-TURN ENTRY POINT. Nothing here touches `walkItOff.hooks`.
    engine.actBase('p1', world);

    expect(body.hp, 'the turn-start hook did not fire').toBe(before + regenAt(level));
  });

  /**
   * AND IT STOPS AT FULL. The talent heals to `min(maxHp, hp + n)`; a body one
   * point down must end the turn at exactly full rather than one point over,
   * which is the arithmetic `TalentActor.maxHp` was needed for.
   */
  it('never heals a body past its own ceiling', () => {
    const { world, engine, body } = woundedWatchman();
    body.hp = body.maxHp - 1;
    engine.actBase('p1', world);
    expect(body.hp).toBe(body.maxHp);
  });

  /**
   * AND A CORPSE DOES NOT MEND. The Downed system keeps a body on the board at
   * 0 hp, so a turn-start regen is a second, invisible exit from being down —
   * `walk_it_off.ts` guards it and `actBase` returns before this on a dead
   * actor. Both halves are asserted because either alone would look sufficient.
   */
  it('leaves a downed body on the floor', () => {
    const { world, engine, body } = woundedWatchman();
    body.hp = 0;
    body.alive = false;
    engine.actBase('p1', world);
    expect(body.hp, 'a body healed itself off the floor').toBe(0);
  });

  /**
   * A BODY WITH NO HOOKS IS UNTOUCHED, and byte-identically so. main.ts sets
   * `talentHooks` to `undefined` rather than `[]` precisely so a class with no
   * hooked talents composes as it did before hooks existed; the fire site has to
   * honour that or the guard is decoration.
   */
  it('does nothing at all to a body carrying no hooks', () => {
    const { world, engine, body } = woundedWatchman();
    body.talentHooks = undefined;
    body.hp = body.maxHp - 20;
    engine.actBase('p1', world);
    expect(body.hp).toBe(body.maxHp - 20);
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * AND THE OTHER TWO DISPATCHERS, WHICH HAD NO CALLERS EITHER.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `fireDealDamage` and `fireKill` were unreachable for a structural reason
 * rather than an oversight: `DamageSource` was `{ id }` and its comment said
 * "identity only", so `applyDamage` was handed a name tag and could not reach
 * the attacker's hooks however much it wanted to.
 *
 * `leverage.ts`'s Blood Price ("the first blow you land each turn returns N hit
 * points to you") and `nerve.ts`'s Still Standing ("recover N hit points every
 * time you kill something") therefore never ran.
 *
 * THESE GO THROUGH `applyDamage`. Calling `bloodPrice.hooks.onDealDamage(ctx)`
 * by hand is what the existing tests for these talents do, and it is why nobody
 * noticed — see this file's header.
 */
describe('the attacker’s own hooks are fired by the damage pipeline', () => {
  /** An attacker carrying one hooked talent, and something to hit. */
  function pair(talent: typeof bloodPrice, level = 1) {
    const world = createWorld('deal-hooks');
    const attacker = world.addPlayer('p1', 'Ren', { maxHp: WATCHMAN.maxHp });
    const victim = world.addPlayer('p2', 'Mal', { maxHp: WATCHMAN.maxHp });
    attacker.talentHooks = [{ talentId: talent.id, level, hooks: talent.hooks ?? {} }];
    attacker.turnProcs = createTurnProcs();
    return { world, attacker, victim };
  }

  it('returns hit points to the attacker on the blow it landed', () => {
    const { attacker, victim } = pair(bloodPrice);
    attacker.hp = attacker.maxHp - 20;
    const before = attacker.hp;

    applyDamage(victim, 5, DamageType.Physical, attacker, createRng('deal'));

    expect(attacker.hp, 'the deal-damage hook did not fire').toBe(before + returnedAt(1));
  });

  /**
   * ONCE A TURN, WHICH IS THE TALENT'S OWN LATCH AND NOT THIS FILE'S RULE.
   * `leverage.ts` guards on `procs.once` so an area effect cannot pay per body;
   * the latch lives on the attacker and the fire site borrows it rather than
   * making a fresh one, which is the difference between a guard and a decoration.
   */
  it('pays only once a turn however many blows land', () => {
    const { attacker, victim } = pair(bloodPrice);
    attacker.hp = attacker.maxHp - 20;
    const before = attacker.hp;

    const rng = createRng('deal-twice');
    applyDamage(victim, 5, DamageType.Physical, attacker, rng);
    applyDamage(victim, 5, DamageType.Physical, attacker, rng);

    expect(attacker.hp, 'a second blow paid again').toBe(before + returnedAt(1));
  });

  it('pays the kill hook when the blow finishes the body', () => {
    const { attacker, victim } = pair(stillStanding);
    attacker.hp = attacker.maxHp - 20;
    const before = attacker.hp;
    victim.hp = 1;

    const out = applyDamage(victim, 50, DamageType.Physical, attacker, createRng('kill'));

    expect(out.killed, 'the fixture did not actually kill anything').toBe(true);
    expect(attacker.hp, 'the kill hook did not fire').toBe(before + reliefAt(1));
  });

  /** A blow that does NOT kill pays nothing — the hook is a kill payoff. */
  it('pays the kill hook nothing for a blow that leaves the body up', () => {
    const { attacker, victim } = pair(stillStanding);
    attacker.hp = attacker.maxHp - 20;
    const before = attacker.hp;

    applyDamage(victim, 1, DamageType.Physical, attacker, createRng('graze'));

    expect(attacker.hp).toBe(before);
  });

  /**
   * AND A SOURCE THAT IS ONLY A NAME TAG FIRES NOTHING. A trap, a bleed whose
   * author is gone, a fixture passing `{ id }` — `hasBody` refuses all of them
   * rather than throwing, which is what keeps every existing caller compiling
   * and behaving exactly as it did.
   */
  it('does nothing when the source is an id and no body', () => {
    const { victim } = pair(bloodPrice);
    const before = victim.hp;
    const out = applyDamage(victim, 5, DamageType.Physical, { id: 'trap' }, createRng('trap'));
    expect(out.dealt).toBeGreaterThan(0);
    expect(victim.hp).toBeLessThan(before);
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * UNNATURAL BODY — cursed/cursed-form.lua:24-76, on the Redactor's birth passive.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * THE MEASUREMENT IS THE REASON AND IT IS IN `indelible.ts`'s header: eight runs
 * each on the Drowned Chapel's first floor, a level-1 Redactor alone, one field
 * changed at a time. Armour, accuracy, weapon damage and DOUBLE HIT POINTS each
 * gave 0/8 — hit points made the damage figure worse — and regeneration was the
 * only input that moved anything. The Doomed, the archetype she ports, is born
 * with exactly this (data/birth/classes/afflicted.lua:143).
 *
 * AND BE PRECISE ABOUT WHAT THAT SWEEP LICENSES, which `indelible.ts` now says
 * at length: the row that moved was a per-turn REGENERATION, and this talent
 * pays only on a kill. Toggled on its own it changes no outcome on either
 * level-1 floor. The sweep is evidence that SUSTAIN is the axis; it is not
 * evidence that this sustain is enough, and these cases are about the rule being
 * upstream's and reaching the body, not about it being sufficient.
 *
 * THROUGH `applyDamage`, like every other case in this file, for this file's own
 * reason: calling `indelible.hooks.onKill(ctx)` by hand is what the tests that
 * missed two dead dispatchers did.
 */
describe('the Redactor is paid in life for a kill — cursed-form.lua:59-67', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE RANK COMES OFF THE SHIPPED CLASS, AND THAT IS THE HALF NOBODY DROVE.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * This fixture hard-wrote `level: 1`. Measured with a mutant: swap `indelible`
   * off `REDACTOR.birthTalents` for `marginalia` and the whole suite stays green
   * — 337 files, 6931 tests — because the talent stays in `passives` at rank 0,
   * `main.ts:1521` binds no hook, and no kill ever heals her. `pointsForLevel(1)`
   * is 0, so `birthTalents` IS the level-1 character, and the one line that
   * decides whether this whole talent reaches a Redactor at all was uncovered.
   *
   * So the level is READ from `sheetForClass(REDACTOR)` and asserted positive,
   * which is what `woundedWatchman` twelve lines up already does. Not `trained`:
   * that helper hands every talent a rank and would delete the question.
   */
  function redactorAnd(victimHp: number) {
    const world = createWorld('unnatural-body');
    const her = world.addPlayer('p1', 'Ren', { maxHp: REDACTOR.maxHp });
    const victim = world.addPlayer('p2', 'Mal', { maxHp: 40 });
    const sheet = sheetForClass(REDACTOR);
    const level = talentLevelOf(sheet, indelible);
    her.talentHooks = [{ talentId: indelible.id, level, hooks: indelible.hooks ?? {} }];
    her.turnProcs = createTurnProcs();
    victim.hp = victimHp;
    return { her, victim, level };
  }

  it('is a talent the Redactor is actually born with', () => {
    const { level } = redactorAnd(1);
    expect(level, 'the Redactor is not born with Unnatural Body').toBeGreaterThan(0);
  });

  it('returns hit points when the blow finishes the body', () => {
    const { her, victim, level } = redactorAnd(1);
    her.hp = her.maxHp - 30;
    const before = her.hp;

    const out = applyDamage(victim, 50, DamageType.Physical, her, createRng('unnatural'));

    expect(out.killed, 'the fixture did not actually kill anything').toBe(true);
    expect(her.hp, 'the kill paid nothing').toBe(before + healPerKillAt(level));
    expect(healPerKillAt(1), 'upstream’s figure for a level-1 Redactor').toBe(10);
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * AND A BODY ON THREE HIT POINTS BANKS THREE — cursed-form.lua:63.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `self.unnatural_body_heal = math.min(self.life, pool + heal)`. With the pool
   * collapsed into the kill that is `min(hp, healPerKill)`, and it was dropped
   * here as "a cap on the POOL, and there is none" — it is not: it is keyed on
   * CURRENT LIFE, and the hook has current life two lines above in its own
   * `alive` guard. The old case set `hp = maxHp - 30` (24 against a heal of 10)
   * and could not see it.
   */
  it('banks no more than the body has left to give', () => {
    const { her, victim, level } = redactorAnd(1);
    her.hp = 3;
    expect(healPerKillAt(level), 'the fixture must heal more than she has').toBeGreaterThan(3);

    applyDamage(victim, 50, DamageType.Physical, her, createRng('clamped'));

    expect(her.hp, 'a body on 3 hit points banked the full figure').toBe(6);
  });

  it('pays nothing for a blow that leaves the body up — you live by WINNING', () => {
    const { her, victim } = redactorAnd(40);
    her.hp = her.maxHp - 30;
    const before = her.hp;

    applyDamage(victim, 1, DamageType.Physical, her, createRng('graze'));

    expect(her.hp).toBe(before);
  });

  it('does not heal a body that is already down', () => {
    // `walk_it_off.ts`'s guard, for its reason: the Downed system keeps a body
    // on the board at 0 hp and a kill landing on the turn she goes down must
    // not heal her off the floor behind the rescue rules.
    const { her, victim } = redactorAnd(1);
    her.hp = 0;

    applyDamage(victim, 50, DamageType.Physical, her, createRng('downed'));

    expect(her.hp).toBe(0);
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * AND THE HEALING FACTOR DOES NOT TOUCH IT — cursed-form.lua:51-54.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Upstream applies `healing_factor` to every heal in the game through `onHeal`
   * (tome/class/Actor.lua:2089) and then steps around its own rule for this one:
   *
   * ```lua
   * local temp = self.healing_factor
   * self.healing_factor = 1
   * self:heal(heal, t)
   * self.healing_factor = temp
   * ```
   *
   * and says so to the player at cursed-form.lua:73 — *"it is not affected by
   * your hatred level or other effects."* `HealOpts.ignoreHealingFactor` is that
   * swap, and this is the case that makes it a rule rather than a comment.
   *
   * `healMod` IS THE REAL KEY an ego or a debuff writes (`healingFactor`,
   * engine/derived.ts) — not a fixture invention. It is inert on the shipped
   * Redactor today, which is exactly why this would otherwise ship unnoticed and
   * be discovered by a player the day a healing ego lands.
   */
  it('is not moved by a healing modifier, the way upstream’s is not', () => {
    const { her, victim, level } = redactorAnd(1);
    her.combat = { mods: { healMod: 0.5 } };
    her.hp = her.maxHp - 30;
    const before = her.hp;

    applyDamage(victim, 50, DamageType.Physical, her, createRng('factored'));

    expect(her.hp, 'a healing modifier reached a heal upstream exempts').toBe(
      before + healPerKillAt(level),
    );
  });

  it('grows with the rank, on upstream’s own curve', () => {
    // `combatTalentSpellDamage(t, 15, 50, (level + wil) * 1.2)` — strictly
    // increasing, and pinned at both ends so a rewrite of the curve is visible.
    const band = [1, 2, 3, 4, 5].map((r) => healPerKillAt(r));
    expect(band).toEqual([10, 14, 16, 19, 21]);
  });
});
