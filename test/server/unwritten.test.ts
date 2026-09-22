// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/modules/tome/data/talents/cursed/shadows.lua:178-463
//                       game/modules/tome/data/talents/cursed/gestures.lua:20-186
//                       game/modules/tome/class/interface/Combat.lua:164-173
//                       game/modules/tome/class/Actor.lua:1664-1667
//                       game/modules/tome/data/birth/classes/warrior.lua:175-179, :241-245
//                       game/modules/tome/data/birth/classes/mage.lua:104-107
//                       game/modules/tome/data/birth/classes/afflicted.lua:143-147, :155-159
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *   `ledger/unwritten` — DRIVEN, NOT READ OFF THE TABLE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Every case here presses the real button on a real body and then pumps the
 * real scheduler. `damage-shield.test.ts` states the rule this follows: a
 * mechanic is a JOIN across layers, each of which can be correct while the wire
 * between two of them is cold. This one has more layers than most —
 *
 *   the sustain              `toggleSustain` on the sheet
 *   the base pass            `TalentResolution.summonPass`, from `pump`
 *   the world                `addMonster`, and `reaped` on the way out
 *   the faction              `areEnemies` through `reactsAs`
 *   the AI                   `visibleEnemies`, which is what makes a shadow
 *                            worth summoning at all
 *   the swing                `strike`'s `meleeReplacement`
 *
 * — and asserting `maxShadowsAt(1) === 1` would have told us nothing about any
 * of them.
 */

import { describe, expect, it } from 'vitest';

import {
  CLASSES,
  classById,
  createContentTalentEngine,
  migrateLegacyBirthGrants,
  sheetForClass,
  spendByPurse,
} from '../../src/server/content/classes.ts';
import { BIRTH_KIT, ITEM_CATALOGUE, Slot, birthKitFor } from '../../src/server/content/items.ts';
import { EffectId, createMvpEffectState } from '../../src/server/content/effects.ts';
import { BOUND_SHADOW, INDEX_HUSK, monsterInit } from '../../src/server/content/monsters.ts';
import { TALENT_TREES } from '../../src/server/content/talent-trees.ts';
import { effectsOn, recomposeCombat, statusApplier } from '../../src/server/engine/effects.ts';
import {
  Faction,
  IntentKind,
  areEnemies,
  isHostile,
  isMonster,
} from '../../src/server/engine/actor.ts';
import { createBarrier } from '../../src/server/engine/barrier.ts';
import { combatMentalResist, combatMindpower } from '../../src/server/engine/derived.ts';
import { hitChance } from '../../src/shared/checkhit.ts';
import { resolveItem } from '../../src/server/content/resolve.ts';
import { shouldAnnounceCleared, standingThreats } from '../../src/server/world/cleared.ts';
import { DamageType } from '../../src/server/engine/damage.ts';
import { ClassId, toggleSustain } from '../../src/server/engine/talents.ts';
import { checkTier } from '../../src/shared/tiers.ts';
import { pump, submitIntent } from '../../src/server/engine/scheduler.ts';
import { RESOURCE_RULES, ResourceKind } from '../../src/server/engine/talents.ts';
import { talentRuntimeFor } from '../../src/server/main.ts';
import { createWorld } from '../../src/server/world/world.ts';
import { playerCombat } from '../../src/server/content/classes.ts';
import { ActorKind } from '../../src/shared/protocol.ts';
import { chebyshev } from '../../src/shared/coords.ts';
import { tileDistance } from '../../src/shared/distance.ts';
import {
  CALL_SHADOWS_ID,
  SHADOW_SUMMONER_RANGE,
  maxShadowsAt,
  shadowMaxHpAt,
  shadowsOf,
  summonEveryAt,
} from '../../src/server/talents/call_shadows.ts';
import { GESTURE_OF_PAIN_ID, stunChanceAt } from '../../src/server/talents/gesture_of_pain.ts';
import {
  SHADOW_WARRIORS_ID,
  shadowWarriorAccuracyAt,
  shadowWarriorDamageAt,
} from '../../src/server/talents/shadow_warriors.ts';
import { trained } from '../helpers/trained.ts';
import type { EngineActor, MonsterActor } from '../../src/server/engine/actor.ts';
import type { PumpResult } from '../../src/server/engine/scheduler.ts';
import type { World } from '../../src/server/world/world.ts';

/** What the base pass puts back before anything spends. Derived, never typed. */
const INK_PER_TURN = RESOURCE_RULES[ResourceKind.Ink].regenPerTurn;

/**
 * The character level a tier-2 talent opens at — `levelRequiredFor(2, 1)`,
 * shared/tiers.ts. Written out so the case below asserts a NUMBER rather than
 * the function it is testing against.
 */
const REDACTOR_TIER_TWO_LEVEL = 4;

const REDACTOR = (() => {
  const definition = classById(ClassId.Redactor);
  if (definition === undefined) throw new Error('no redactor');
  return definition;
})();

/**
 * A Redactor on an empty floor with the production runtime behind her.
 *
 * `trained` puts a rank in everything she owns — this file measures what the
 * talents DO, not what it costs to reach them, which is exactly the split that
 * helper's own note draws.
 */
function arena(seed: string) {
  const world = createWorld(seed);
  const ren = world.addPlayer('p1', 'Ren');
  ren.x = 20;
  ren.y = 20;
  ren.maxHp = 500;
  ren.hp = 500;
  /**
   * THE CLASS'S OWN SHEET, THROUGH THE ONE DOOR A PLAYER'S GOES THROUGH.
   * `playerCombat` is what `overlayFor` hands `reclothePlayer` in production —
   * the class table plus the birth descriptor's resist cap. Without it this
   * body has no stats, `combatMindpower` is the base 10s and the gesture
   * measures a Redactor nobody would recognise.
   */
  ren.combat = playerCombat(REDACTOR.combat);

  const effects = createMvpEffectState();
  const engine = createContentTalentEngine();
  const sheet = trained(sheetForClass(REDACTOR));
  engine.attach('p1', sheet);
  const runtime = talentRuntimeFor(engine, world, statusApplier(effects, world.rng));
  const barrier = createBarrier();

  /**
   * THE RIDER DOOR — `PumpCtx.applyStatus`, and it was absent.
   *
   * `talentRuntimeFor` is handed a `StatusApply` and that is what a TALENT
   * uses; `strike`'s melee-rider loop reads `run.ctx.applyStatus` instead, a
   * different field on a different object (`turn-engine.ts:3401` wires it in
   * production). A harness that omits it cannot observe a rider at all — which
   * is why "a replaced blow carries no rider" was unfalsifiable here twice
   * over: no rider on the body AND no door for one to come through.
   */
  const status = statusApplier(effects, world.rng);

  let now = 0;
  /**
   * ONE GAME TURN, AND THE CALLER BURIES WHAT THE PUMP ENROLLED.
   *
   * `PumpResult.reaped` is a LIST, not a removal: `noteMonsterDeath` says why —
   * the Record lane still has to name the body after the pump returns. Production
   * drains it through `TurnEngine.reap`; this harness does the same thing in two
   * lines, because a leash that answers correctly and a body that is still on the
   * tile is exactly the half-wired failure these cases exist to catch.
   */
  const advance = (): PumpResult => {
    now += 1;
    submitIntent(world, barrier, 'p1', { kind: IntentKind.Hold });
    const result = pump(world, { nowMs: now, barrier, talents: runtime, applyStatus: status });
    for (const id of result.reaped) world.removeActor(id);
    return result;
  };

  return { world, ren, engine, sheet, runtime, effects, barrier, status, advance };
}

/** Turn the stance on through the same seam a talent frame goes through. */
function raise(table: ReturnType<typeof arena>, id: string): void {
  const answer = toggleSustain(table.engine, table.sheet, id);
  expect(answer.ok && answer.on, `the stance refused: ${answer.ok ? 'off' : answer.reason}`).toBe(
    true,
  );
}

/** Pump until a shadow is standing, or give up. Returns how many turns it took. */
function pumpUntilShadow(table: ReturnType<typeof arena>, limit = 40): number {
  for (let turn = 1; turn <= limit; turn += 1) {
    table.advance();
    if (shadowsOf(table.world, 'p1').length > 0) return turn;
  }
  return -1;
}

function husk(world: World, id: string, x: number, y: number): MonsterActor {
  const body = world.addMonster(id, monsterInit(INDEX_HUSK, { x, y }));
  if (body.kind !== ActorKind.Monster) throw new Error('fixture: not a monster');
  return body;
}

// ---------------------------------------------------------------------------
// CALL SHADOWS — a body on the map
// ---------------------------------------------------------------------------

describe('Call Shadows puts a body on the map', () => {
  it('summons one on the first base turn the stance is up, for five ink', () => {
    /**
     * `callbackOnActBase` (shadows.lua:438-453) starts its counter at ZERO, so
     * the first decrement is below zero and a shadow arrives immediately. That
     * is what makes this a stance rather than a cast: you turn it on and
     * something is there.
     */
    const table = arena('shadows-first');
    expect(shadowsOf(table.world, 'p1'), 'a shadow before the stance').toHaveLength(0);

    const before = table.sheet.resource.value;
    raise(table, CALL_SHADOWS_ID);
    expect(pumpUntilShadow(table, 2), 'no shadow on the first base turn').toBeGreaterThan(0);

    const standing = shadowsOf(table.world, 'p1');
    expect(standing).toHaveLength(1);
    /**
     * `self:incHate(-5)` — shadows.lua:410, one for one into Ink.
     *
     * THE TURN'S OWN REGENERATION IS ADDED BACK BEFORE THE COMPARISON, because
     * `regenResource` runs FIRST in the same base pass — `TalentResolution`'s
     * seam order, and the reason the summon reads the pool the refill just
     * topped up. Measuring the raw delta would be measuring `INK_PER_TURN`.
     */
    expect(before + INK_PER_TURN - table.sheet.resource.value).toBeCloseTo(5, 6);
    // AND IT IS THE PORTED BODY, not a husk with a new name.
    const shadow = standing[0];
    expect(shadow?.sprite).toBe(BOUND_SHADOW.sprite);
    expect(shadow?.faction).toBe(Faction.Bound);
    expect(shadow?.summonerId).toBe('p1');
  });

  it('is on your side and on the husk’s list — Actor.lua:1664-1667', () => {
    /**
     * ═══ THE WHOLE POINT, AND IT IS THREE ANSWERS FROM ONE PREDICATE ═══
     * `reactsAs` walks the summoner link before any reaction is computed, so a
     * shadow is an ally of its summoner, an ally of another shadow, and an enemy
     * of everything Redacted. The third is the first monster-on-monster
     * hostility this engine has ever had.
     *
     * DRIVEN THROUGH THE AI'S OWN QUESTION as well as the predicate: a husk that
     * does not SEE the shadow as a target would leave it standing in a doorway
     * being ignored, which is the failure that makes a summon decorative.
     */
    const table = arena('shadows-sides');
    const monster = husk(table.world, 'm1', 22, 20);
    raise(table, CALL_SHADOWS_ID);
    expect(pumpUntilShadow(table)).toBeGreaterThan(0);
    const shadow = shadowsOf(table.world, 'p1')[0];
    if (shadow === undefined) throw new Error('no shadow');

    expect(isHostile(shadow, table.ren), 'the shadow turned on its summoner').toBe(false);
    expect(isHostile(table.ren, shadow), 'the summoner may swing at her own shadow').toBe(false);
    expect(isHostile(shadow, monster), 'the shadow does not fight the Index').toBe(true);
    expect(isHostile(monster, shadow), 'the husk does not fight the shadow').toBe(true);
    // Two shadows are allies of each other — `summons shouldn't hate each other`.
    expect(areEnemies({ kind: ActorKind.Monster, faction: Faction.Bound }, shadow)).toBe(false);
  });

  it('is what the husk walks at — through the AI, not through the predicate', () => {
    /**
     * The husk is put NEARER the shadow than the player and then given turns.
     * `acquireTarget` takes the nearest hostile it can see; if `areEnemies` had
     * not changed, the shadow would be invisible to it and the husk would walk
     * past a body standing in its way to reach Ren.
     */
    const table = arena('shadows-target');
    raise(table, CALL_SHADOWS_ID);
    expect(pumpUntilShadow(table)).toBeGreaterThan(0);
    const shadow = shadowsOf(table.world, 'p1')[0];
    if (shadow === undefined) throw new Error('no shadow');

    /**
     * ON THE FAR SIDE OF THE SHADOW, which is the whole discriminator — and it
     * has to be STRICTLY nearer. `visibleEnemies` sorts nearest-first and breaks
     * a TIE BY ID, and `'p1' < 'shadow:p1:0'`, so a husk placed equidistant from
     * both takes the player and the case proves nothing. One step further along
     * the line away from Ren puts the shadow at 1 and Ren at 2.
     */
    const away = (a: number, b: number): number => Math.sign(a - b);
    const monster = husk(
      table.world,
      'm1',
      shadow.x + away(shadow.x, table.ren.x),
      shadow.y + away(shadow.y, table.ren.y),
    );
    /**
     * UNTIL IT HAS ONE, AND NO FURTHER. A shadow is eight hit points
     * (`max_life = resolvers.rngavg(3,12)`, shadows.lua:216) and a husk kills it
     * in two swings — so a loop that ran four turns would find the husk back on
     * Ren, having done exactly what this case is about, and read as a failure.
     */
    let acquired: string | null = null;
    for (let turn = 0; turn < 4 && acquired === null; turn += 1) {
      table.advance();
      acquired = monster.ai.targetId;
    }
    expect(acquired, 'the husk never noticed the shadow').toBe(shadow.id);

    /**
     * ═══ AND THE BLOWS LANDED ON IT INSTEAD OF ON HER, WHICH IS THE POINT ═══
     * `content/classes.ts` says what this talent is for in as many words: *"a
     * body between you and them"*. The husk is adjacent to the shadow and two
     * tiles from Ren; if the faction had not changed it would have walked
     * straight past a body standing in its way.
     */
    const hp = table.ren.hp;
    table.advance();
    expect(shadow.hp < shadow.maxHp || !shadow.alive, 'the shadow was never touched').toBe(true);
    // ONE TURN, NOT THREE. The shadow is eight hit points and dies in two
    // swings; past that the husk is legitimately back on Ren, and a longer loop
    // would be asserting that a summon is immortal rather than that it is a body.
    expect(table.ren.hp, 'the husk got past the shadow to Ren').toBe(hp);
  });

  it('goes when the stance goes — deactivate, shadows.lua:370-379', () => {
    const table = arena('shadows-drop');
    raise(table, CALL_SHADOWS_ID);
    expect(pumpUntilShadow(table)).toBeGreaterThan(0);
    const shadow = shadowsOf(table.world, 'p1')[0];
    if (shadow === undefined) throw new Error('no shadow');

    // Down through the same seam it went up through.
    const answer = toggleSustain(table.engine, table.sheet, CALL_SHADOWS_ID);
    expect(answer.ok && !answer.on).toBe(true);

    table.advance();
    expect(table.world.getActor(shadow.id), 'the shadow outlived the stance').toBeUndefined();
    expect(shadowsOf(table.world, 'p1')).toHaveLength(0);
  });

  it('goes when it is left behind — the leash upstream keeps in its AI', () => {
    /**
     * `ai_state.summoner_range = 10` (shadows.lua:248). Upstream's shadow AI
     * hovers inside it; ours enforces it as a LEASH on the base clock, because
     * a REALM's world goes on ticking a body whose summoner walked through a
     * door and upstream's levels simply stop existing.
     */
    const table = arena('shadows-leash');
    raise(table, CALL_SHADOWS_ID);
    expect(pumpUntilShadow(table)).toBeGreaterThan(0);
    const shadow = shadowsOf(table.world, 'p1')[0];
    if (shadow === undefined) throw new Error('no shadow');

    // Placed, not walked: this is the crossing case, and a body that arrives
    // eleven tiles away has not taken eleven steps.
    table.ren.x = shadow.x + 11;
    table.advance();
    expect(table.world.getActor(shadow.id), 'the shadow followed nobody home').toBeUndefined();
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE LEASH IS ToME'S ROUNDED CIRCLE, NOT A SQUARE AND NOT THE EXACT LINE.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Upstream's shadow AI (`ai/shadow.lua`, git-only in the reference, at
   * `-- out of summoner range?`) asks `core.fov.distance(...) > summoner_range`,
   * and `core.fov.distance` rounds half-up. So, R across and `dy` down:
   *
   *   the LAST row kept is the largest `dy` with R² + dy² <= R² + R, which
   *     rounds to R — (10,3) at R = 10, 10.44 long;
   *   the FIRST row reaped is one further — (10,4), 10.77, which rounds to 11
   *     and is still R in Chebyshev.
   *
   * Derived from `SHADOW_SUMMONER_RANGE`, not typed, so a retuned leash moves
   * the boundary with it. The case above is axis-aligned, where every metric
   * agrees, and could not tell any of them apart.
   *
   * MUTANTS: the Chebyshev square keeps the reaped one; the exact
   * `Math.hypot` reaps the kept one.
   */
  function leashedAt(seed: string, offset: { x: number; y: number }) {
    const table = arena(seed);
    raise(table, CALL_SHADOWS_ID);
    expect(pumpUntilShadow(table)).toBeGreaterThan(0);
    const shadow = shadowsOf(table.world, 'p1')[0];
    if (shadow === undefined) throw new Error('no shadow');
    // Ren stands at (20, 20). Up and to the left keeps both offsets on the
    // test level's open floor, and `placeAt` refuses anything that is not.
    const tile = { x: table.ren.x - offset.x, y: table.ren.y - offset.y };
    expect(table.world.placeAt(shadow.id, tile), 'the shadow could not stand there').toBe(true);
    expect({ x: shadow.x, y: shadow.y }).toEqual(tile);
    return { table, shadow };
  }

  const R = SHADOW_SUMMONER_RANGE;
  const KEEP_DY = Math.floor(Math.sqrt(R));
  const kept = { x: R, y: KEEP_DY };
  const reaped = { x: R, y: KEEP_DY + 1 };

  it('keeps a shadow whose distance ROUNDS to the leash', () => {
    expect(Math.hypot(kept.x, kept.y), 'the fixture is not past R exactly').toBeGreaterThan(R);
    expect(tileDistance({ x: 0, y: 0 }, kept), 'the fixture does not round to R').toBe(R);

    const { table, shadow } = leashedAt('shadows-leash-kept', kept);
    table.advance();
    expect(
      table.world.getActor(shadow.id),
      'a shadow inside ToME`s circle was reaped',
    ).toBeDefined();
  });

  it('reaps a shadow that rounds past the leash while still inside its square', () => {
    expect(chebyshev({ x: 0, y: 0 }, reaped), 'the fixture left the square').toBe(R);
    expect(tileDistance({ x: 0, y: 0 }, reaped), 'the fixture does not round past R').toBe(R + 1);

    const { table, shadow } = leashedAt('shadows-leash-reaped', reaped);
    table.advance();
    expect(
      table.world.getActor(shadow.id),
      'the square kept a shadow ToME recalls',
    ).toBeUndefined();
  });

  it('keeps to its ceiling and its cadence, and neither is a coincidence', () => {
    /**
     * `getMaxShadows` is `min(4, max(1, floor(level * 0.55)))` (shadows.lua:348)
     * — ONE at the ranks a fresh character can reach — and the counter resets to
     * `summonEveryAt` after each arrival. Pumped well past both.
     */
    const table = arena('shadows-cap');
    raise(table, CALL_SHADOWS_ID);
    const first = pumpUntilShadow(table);
    expect(first).toBeGreaterThan(0);

    for (let turn = 0; turn < summonEveryAt(1) * 3; turn += 1) table.advance();
    expect(shadowsOf(table.world, 'p1')).toHaveLength(maxShadowsAt(1));
    expect(maxShadowsAt(1), 'the cap stopped being one at rank 1').toBe(1);
  });

  it('makes the SECOND one wait the cadence, which the cap alone would hide', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * A SURVIVING MUTANT IS WHY THIS CASE EXISTS, AND IT WAS EQUIVALENT AT
     * RANK 1.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * Breaking the cadence — `shadowCooldown = 0` instead of `summonEveryAt` —
     * left the case above GREEN, and the reason is arithmetic rather than a gap
     * in the assertion: `getMaxShadows` is ONE at rank 1 (shadows.lua:348), so
     * the CEILING refuses every attempt after the first and the counter is
     * never the thing doing the holding. The rule is unobservable until a
     * Redactor can have two.
     *
     * RANK 4 IS THE FIRST THAT CAN. `floor(4 * 0.55)` is 2. So the second
     * shadow's arrival is the only place the cadence is visible at all, and
     * this is the case that watches for it.
     */
    const table = arena('shadows-cadence');
    const rank = 4;
    expect(maxShadowsAt(rank), 'rank 4 stopped allowing a second shadow').toBe(2);
    table.sheet.points.set(CALL_SHADOWS_ID, rank);
    // DEEP POCKETS. Five ink a shadow, and a refusal for want of ink would look
    // exactly like the cadence holding one back.
    table.sheet.resource.value = table.sheet.resource.max;
    /**
     * ONE PUMP BEFORE THE STANCE, AND IT IS THE FIXTURE AND NOT THE RULE.
     * The FIRST pump of a session carries the world through TWO game turns —
     * measured, pump 1 lands on turn 2 — so an arrival recorded during it is a
     * turn later than the base pass that produced it, and the gap below came
     * back one short. Every pump after the first advances exactly one.
     */
    table.advance();
    raise(table, CALL_SHADOWS_ID);

    /**
     * MEASURED IN GAME TURNS, NOT IN PUMPS. The cadence is a base-clock counter
     * and a single `pump` can carry the world through more than one game turn —
     * counting calls made the first reading of this four where the counter had
     * said five, which looked like an off-by-one in the rule and was an
     * off-by-one in the fixture. `world.turn.clock.gameTurn` is what
     * `callbackOnActBase` is actually paced by.
     */
    const arrivals: number[] = [];
    for (let turn = 1; turn <= summonEveryAt(rank) * 4; turn += 1) {
      table.sheet.resource.value = table.sheet.resource.max;
      table.advance();
      const standing = shadowsOf(table.world, 'p1').length;
      while (arrivals.length < standing) arrivals.push(table.world.turn.clock.gameTurn);
    }

    expect(arrivals.length, 'the second shadow never came').toBe(2);
    const first = arrivals[0] ?? 0;
    const second = arrivals[1] ?? 0;
    expect(second - first, 'the second shadow did not wait its turn').toBe(summonEveryAt(rank));
  });

  it('refuses when the ink is not there, and says so — shadows.lua:405-408', () => {
    const table = arena('shadows-broke');
    table.sheet.resource.value = 1;
    raise(table, CALL_SHADOWS_ID);
    const result = table.advance();
    expect(shadowsOf(table.world, 'p1'), 'a shadow was called on an empty pot').toHaveLength(0);
    // NOTHING WAS TAKEN. The pool is whatever the turn's own regeneration left,
    // which is strictly ABOVE where it started — a refusal that still charged
    // would leave it below.
    expect(table.sheet.resource.value, 'the ink went anyway').toBeGreaterThanOrEqual(1);
    // `PumpResult.records` is the Case Log lane, not a `GameEvent` — see
    // `run.records`, which the trap and burn passes already write into.
    expect(
      result.records.some((line) => line.toLowerCase().includes('ink')),
      `nothing said why: ${result.records.join(' | ')}`,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// GESTURE OF PAIN — the swing that is not a swing
// ---------------------------------------------------------------------------

/** Swing at a body through the scheduler and hand back the `attacked` event. */
function swing(table: ReturnType<typeof arena>, targetId: string, nowMs: number) {
  submitIntent(table.world, table.barrier, 'p1', { kind: IntentKind.Attack, targetId });
  const result = pump(table.world, {
    nowMs,
    barrier: table.barrier,
    talents: table.runtime,
    applyStatus: table.status,
  });
  for (const id of result.reaped) table.world.removeActor(id);
  const blow = result.events.find((event) => event.t === 'attacked' && event.id === 'p1');
  return blow?.t === 'attacked' ? blow : undefined;
}

describe('Gesture of Pain replaces the swing', () => {
  it('lands MIND damage where the stylus lands Darkness — Combat.lua:164-173', () => {
    const table = arena('gesture-type');
    const monster = husk(table.world, 'm1', 21, 20);
    monster.hp = 5000;
    monster.maxHp = 5000;

    // THE ORDINARY SWING FIRST, so the difference is measured rather than
    // assumed: the Redactor's own weapon table is Darkness (`REDACTOR.combat`).
    const plain = swing(table, 'm1', 1);
    expect(plain?.type).toBe(DamageType.Darkness);

    raise(table, GESTURE_OF_PAIN_ID);
    const gesture = swing(table, 'm1', 2);
    expect(gesture?.type, 'the stance changed nothing about the blow').toBe(DamageType.Mind);
  });

  it('rolls mindpower against the mental save, not accuracy against defence', () => {
    /**
     * gestures.lua:121 — `self:checkHit(mindpower, target:combatMentalResist())`,
     * and :198-200 says so to the player: *"is thus not affected by your
     * Accuracy or the enemy's Defense"*. `AttackResult.atk`/`def` are what the
     * Case Log prints, so the two numbers ARE the assertion.
     */
    const table = arena('gesture-roll');
    const monster = husk(table.world, 'm1', 21, 20);
    monster.hp = 5000;
    monster.maxHp = 5000;

    const plain = swing(table, 'm1', 1);
    raise(table, GESTURE_OF_PAIN_ID);
    const gesture = swing(table, 'm1', 2);

    expect(plain?.atk).toBeGreaterThan(0);
    expect(gesture?.atk, 'the gesture used the same accuracy').not.toBe(plain?.atk);
    expect(gesture?.def, 'the gesture rolled against defence').not.toBe(plain?.def);
  });

  it('falls through to the weapon the moment a hand is full — canUseGestures', () => {
    /**
     * `canUseGestures` (gestures.lua:20-38) wants two free or mindstar-equipped
     * hands, and this game has no mindstar — so a Service Baton in the mainhand
     * is the whole of the refusal. THE TURN IS NOT REFUSED: `preAttack` returns
     * false upstream, ours falls through, and the divergence is stated in
     * `handsFreeForGestures`.
     */
    const table = arena('gesture-hands');
    const monster = husk(table.world, 'm1', 21, 20);
    monster.hp = 5000;
    monster.maxHp = 5000;
    raise(table, GESTURE_OF_PAIN_ID);

    expect(swing(table, 'm1', 1)?.type).toBe(DamageType.Mind);
    table.ren.equipped = { ...table.ren.equipped, [Slot.Mainhand]: 'item_service_baton' };
    const armed = swing(table, 'm1', 2);
    expect(armed?.type, 'a full hand still gestured').toBe(DamageType.Darkness);
    expect(armed?.hit !== undefined, 'the turn was refused instead of swung').toBe(true);
  });

  it('stuns what it hits, at the chance the rank says — gestures.lua:147-150', () => {
    /**
     * PUMPED UNTIL IT LANDS rather than scripted: the stun is one roll behind a
     * to-hit roll behind a crit roll, and pinning a draw stream three deep is a
     * fixture that breaks the next time anything reorders a draw. What is
     * asserted is that the effect reaches the body AT ALL — the chance itself is
     * `stunChanceAt`, which is `combatTalentLimit(t, 50, 12, 20)` verbatim.
     */
    const table = arena('gesture-stun');
    const monster = husk(table.world, 'm1', 21, 20);
    monster.hp = 500_000;
    monster.maxHp = 500_000;
    raise(table, GESTURE_OF_PAIN_ID);

    let stunned = false;
    for (let turn = 1; turn <= 200 && !stunned; turn += 1) {
      swing(table, 'm1', turn);
      stunned = effectsOn(table.effects, 'm1').some((eff) => eff.effectId === EffectId.Stunned);
    }
    expect(stunned, 'two hundred gestures and nothing was stunned').toBe(true);
    expect(stunChanceAt(1), 'the rank-1 chance left upstream’s band').toBeCloseTo(12, 5);
  });
});

// ---------------------------------------------------------------------------
// SHADOW WARRIORS — a passive about somebody else's body
// ---------------------------------------------------------------------------

describe('Shadow Warriors lands on the shadow, not on the Redactor', () => {
  it('adds its accuracy and its damage to the summoned body', () => {
    const table = arena('warriors');
    raise(table, CALL_SHADOWS_ID);
    expect(pumpUntilShadow(table)).toBeGreaterThan(0);
    const shadow = shadowsOf(table.world, 'p1')[0];
    if (shadow === undefined) throw new Error('no shadow');

    // `trained` gave Shadow Warriors rank 1, so both terms are its rank-1 value.
    expect(shadowWarriorAccuracyAt(1)).toBeGreaterThan(0);
    expect(shadow.combat?.weapon?.atk).toBe(
      // `atk = 10 + level` (shadows.lua:230) plus `combat_atk` (:317).
      10 + table.ren.level + shadowWarriorAccuracyAt(1),
    );
    expect(shadow.combat?.increase?.all).toBe(shadowWarriorDamageAt(1));
  });

  it('gives the summoner nothing at all, which is why it has no `passive`', () => {
    const table = arena('warriors-self');
    const before = { ...(table.ren.combat?.mods ?? {}) };
    raise(table, CALL_SHADOWS_ID);
    expect(pumpUntilShadow(table)).toBeGreaterThan(0);
    expect({ ...(table.ren.combat?.mods ?? {}) }).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// THE BIRTH KIT — `resolvers.equipbirth`, per class
// ---------------------------------------------------------------------------

describe('what each class is born wearing', () => {
  it('gives every class the lantern and nobody two of anything', () => {
    for (const definition of CLASSES) {
      const kit = birthKitFor(definition.id);
      expect(kit[0], `${definition.id} lost the lantern`).toBe(BIRTH_KIT[0]);
      expect(new Set(kit).size, `${definition.id} names a piece twice`).toBe(kit.length);
      for (const id of kit) {
        expect(
          ITEM_CATALOGUE.get(id),
          `${definition.id} names ${id}, which is not an item`,
        ).toBeDefined();
      }
      // NO TWO PIECES MAY WANT THE SAME SLOT: `grantBirthKit` would bag the
      // second and the player would start with a coat in their pocket.
      const slots = kit.map((id) => ITEM_CATALOGUE.get(id)?.slot).filter((s) => s !== undefined);
      expect(new Set(slots).size, `${definition.id} fills a slot twice`).toBe(slots.length);
    }
  });

  it('dresses the two front classes in armour and the two casters in nothing', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THIS IS THE SHAPE, AND IT IS WHY THE KIT COULD NOT BE ONE LIST.
     * ═══════════════════════════════════════════════════════════════════════
     *
     *   BULWARK    iron mail, `combat_armor = 4`       warrior.lua:175-179
     *   ARCHER     rough leather, `combat_armor = 2`   warrior.lua:241-245
     *   ALCHEMIST  linen robe, NO `wielder` AT ALL     mage.lua:104-107
     *   DOOMED     linen robe, NO `wielder` AT ALL     afflicted.lua:155-159
     *
     * `cloth-armors.lua:34-39` authors the linen robe with no wielder table, so
     * upstream's casters are not "given less armour" — they are given a garment
     * that is mechanically zero. A kit that handed all four a chestpiece would
     * be three classes wearing armour their archetype is denied.
     */
    const armourOf = (classId: string): number =>
      birthKitFor(classId).reduce(
        (sum, id) => sum + Number(ITEM_CATALOGUE.get(id)?.wielder?.mods?.armour ?? 0),
        0,
      );
    expect(armourOf(ClassId.Watchman), 'the Bulwark is unarmoured').toBeGreaterThan(0);
    expect(armourOf(ClassId.Inspector), 'the Archer lost her leather').toBeGreaterThan(0);
    expect(armourOf(ClassId.Alchemist), 'the Alchemist was handed armour').toBe(0);
    expect(armourOf(ClassId.Redactor), 'the Redactor was handed armour').toBe(0);
    // AND THE FRONT CLASS IS AHEAD OF THE RANGED ONE, which is mail against
    // leather and the only ordering upstream's four actually state.
    expect(armourOf(ClassId.Watchman)).toBeGreaterThan(armourOf(ClassId.Inspector));
  });

  it('answers a class this build no longer has with the universal half', () => {
    // The same substitute-and-carry-on rule `classById` follows for a save that
    // names a deleted class.
    expect(birthKitFor('a_class_that_never_was')).toEqual(BIRTH_KIT);
    expect(birthKitFor(null)).toEqual(BIRTH_KIT);
  });
});

// ---------------------------------------------------------------------------
// REACHABILITY — every talent has a slot that exists
// ---------------------------------------------------------------------------

describe('the fourth tree is reachable', () => {
  it('declares its own length and holds exactly that', () => {
    const tree = TALENT_TREES.find((candidate) => candidate.id === 'ledger/unwritten');
    expect(tree, 'the tree is not registered').toBeDefined();
    const held = [...REDACTOR.loadout, ...REDACTOR.passives].filter(
      (talent) => talent.tree === 'ledger/unwritten',
    );
    expect(held).toHaveLength(tree?.size ?? 0);
  });

  it('puts every one of its talents somewhere a player can reach', () => {
    /**
     * A SUSTAIN NEEDS A BAR SLOT to be toggled at all, so it belongs on the
     * LOADOUT and not among the passives — `ledger_stances.ts` says the same
     * thing about the two ledger stances. A passive needs neither.
     */
    const owned = new Map(
      [...REDACTOR.loadout, ...REDACTOR.passives].map((talent) => [talent.id, talent]),
    );
    for (const id of [CALL_SHADOWS_ID, GESTURE_OF_PAIN_ID]) {
      expect(
        REDACTOR.loadout.map((talent) => talent.id),
        `${id} has no bar slot`,
      ).toContain(id);
    }
    /**
     * ═══ A RANK, NOT A MEMBERSHIP — the fault this repo has shipped most ═══
     * This was `expect(owned.has('talent:shadow_warriors')).toBe(true)` under a
     * title that says "somewhere a player can REACH". Membership is true at
     * rank 0, which is exactly the state the three infusions shipped in.
     *
     * So the assertion is the SPEND: a Redactor with a point in hand raises it,
     * through `raiseTalentPoint`, and the rank comes out at one. That also
     * covers the tier-2 gate (`treeKnown`), which her two born stances satisfy.
     */
    expect(owned.has(SHADOW_WARRIORS_ID), 'the passive is on neither list').toBe(true);
    const engine = createContentTalentEngine();
    const sheet = sheetForClass(REDACTOR);
    engine.attach('p1', sheet);
    /**
     * IT IS BORN UNLEARNED, which is what makes the rest of this a real
     * question rather than a restatement of the line above.
     */
    expect(sheet.points.get(SHADOW_WARRIORS_ID), 'it is granted rather than bought').toBe(0);

    /**
     * AND `main.ts#raiseTalentPoint`'S TWO REFUSALS, ASKED THE WAY IT ASKS
     * THEM. That function is a closure inside `buildServer` and cannot be
     * imported, but both of its gates are shared functions and this calls the
     * same two with the same arguments: the key must be in `points` (*"seeding
     * a new key here would let a spend teach a body a talent it never
     * learned"*), and `checkTier` must pass at the rank being BOUGHT.
     *
     * `treeKnown` COUNTS THE OTHER TALENTS OF THE TREE AT RANK >= 1, which for
     * `ledger/unwritten` is the two stances she is born in — so the tier-2
     * depth gate is satisfied by the birth grant and by nothing else. That is
     * the join the old `points.has` assertion could not see.
     */
    const talent = engine.registry.get(SHADOW_WARRIORS_ID);
    if (talent === undefined) throw new Error('not registered');
    const treeKnown = [...sheet.points.entries()].filter(
      ([id, rank]) =>
        id !== SHADOW_WARRIORS_ID && rank >= 1 && engine.registry.get(id)?.tree === talent.tree,
    ).length;
    const gateAt = (characterLevel: number) =>
      checkTier({
        tier: talent.tier,
        rank: 1,
        stat: talent.statGate,
        statValue: REDACTOR.combat.stats?.[talent.statGate ?? 'cun'] ?? 0,
        characterLevel,
        treeKnown,
      });
    /**
     * AND THE ANSWER IS "AT LEVEL FOUR", WHICH IS THE POINT OF ASKING.
     * `treeKnown` is 2 — her two born stances — so the tier-2 DEPTH gate is
     * already satisfied at birth, and her Cunning of 20 is exactly the tier-2
     * requirement. The only thing between a new Redactor and this passive is
     * her character level, and it is reachable rather than stranded.
     */
    const early = gateAt(1);
    expect(early.ok, 'a tier-2 talent is buyable at level 1').toBe(false);
    expect(!early.ok && early.reason, 'it is refused for the wrong reason').toBe('level');
    expect(gateAt(REDACTOR_TIER_TWO_LEVEL).ok, 'it is not reachable at all').toBe(true);
  });

  it('is born knowing the two stances, which is the Doomed’s own list', () => {
    // afflicted.lua:143-147 grants UNNATURAL_BODY, FEED, GESTURE_OF_PAIN,
    // WILLFUL_STRIKE and CALL_SHADOWS. Ours is four of those five; see
    // `REDACTOR.birthTalents` for which one is learnable instead and why.
    const born = REDACTOR.birthTalents.map((talent) => talent.id);
    expect(born).toContain(CALL_SHADOWS_ID);
    expect(born).toContain(GESTURE_OF_PAIN_ID);
    // AND THE SHEET AGREES, which is the join a list on its own cannot prove.
    const sheet = sheetForClass(REDACTOR);
    expect(sheet.points.get(CALL_SHADOWS_ID)).toBe(1);
    expect(sheet.points.get(GESTURE_OF_PAIN_ID)).toBe(1);
  });

  it('lets a born Redactor raise both stances with no point spent', () => {
    // THE PRESS, not the table: `toggleSustain` refuses a talent at rank 0, and
    // that refusal is what a birth grant exists to clear.
    const engine = createContentTalentEngine();
    const sheet = sheetForClass(REDACTOR);
    engine.attach('p1', sheet);
    for (const id of [CALL_SHADOWS_ID, GESTURE_OF_PAIN_ID]) {
      const answer = toggleSustain(engine, sheet, id);
      expect(answer.ok && answer.on, `${id} could not be raised at birth`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// The one thing a summon must never become
// ---------------------------------------------------------------------------

describe('a shadow is not content', () => {
  it('is kept out of the bestiary, so no floor can roll one', () => {
    // `Zone.lua:214` skips an entity with no `rarity`/`level_range`, and
    // `crystal.lua:73` says `rarity = false` out loud on a creature that exists
    // only to be summoned. Both fields absent is that, and `SUMMON_TEMPLATES`
    // keeps it out of the list `populateDelve` walks.
    expect(BOUND_SHADOW.rarity).toBeUndefined();
    expect(BOUND_SHADOW.levelRange).toBeUndefined();
    expect(BOUND_SHADOW.drops, 'a summon that drops loot is a coat printer').toBeUndefined();
  });

  it('never leaves a body behind when the stance is dropped twice over', () => {
    // The leash runs on the SHADOW's base turn, so a second drop must not
    // resurrect anything or double-reap.
    const table = arena('shadows-idempotent');
    raise(table, CALL_SHADOWS_ID);
    expect(pumpUntilShadow(table)).toBeGreaterThan(0);
    toggleSustain(table.engine, table.sheet, CALL_SHADOWS_ID);
    table.advance();
    table.advance();
    expect(
      table.world.allActors().filter((actor: EngineActor) => actor.kind === ActorKind.Monster),
    ).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// THE POOL — `forceLevelup(level)`, the clause that was dropped once
// ---------------------------------------------------------------------------

describe('a shadow is summoned at its master’s level, pool and all', () => {
  it('pins the curve against the Lua rather than against itself', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE NUMBERS, NOT THE EXPRESSION. `shadowMaxHpAt` USED TO BE A CONSTANT.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `summonShadow` calls `shadow:forceLevelup(level)` (shadows.lua:420), and
     * `forceLevelup` (engine/interface/ActorLevel.lua:138-146) runs `levelup()`
     * once per level, each of which is
     * `max_life = max_life + max(getRankLifeAdjust(rating), 1)`
     * (tome/class/Actor.lua:3818-3822). For `rank == 2` that is
     * `rating * (1 + level/40 - 0.1)` (:1740-1752).
     *
     * So at `life_rating = 5` the gain reaching level 2 is `5 * 0.95 = 4.75`,
     * and the sum to level 10 is `5 * (9 * 0.9 + 54/40) = 47.25`. With the
     * table's own 8 that is 55.
     *
     * WRITTEN OUT BECAUSE `expect(shadowMaxHpAt(10)).toBe(8 + lifeGainedTo(...))`
     * IS THE PRODUCTION EXPRESSION ON BOTH SIDES — the shape the port's own
     * Shadow Warriors case was caught with below.
     */
    expect(shadowMaxHpAt(1), 'a level-1 shadow is the table').toBe(BOUND_SHADOW.maxHp);
    expect(shadowMaxHpAt(2)).toBe(12);
    expect(shadowMaxHpAt(10)).toBe(55);
    expect(shadowMaxHpAt(20)).toBe(119);
    expect(shadowMaxHpAt(30)).toBe(196);
  });

  it('gives a deep Redactor a shadow that is not eight hit points', () => {
    /**
     * THE DEFECT THIS CASE EXISTS FOR: `shadowInitAt` passed
     * `maxHp: BOUND_SHADOW.maxHp` flat, so the body was EIGHT at every summoner
     * level — against an `INDEX_HUSK` of 25 at level 1 and 119 at level 10.
     * Past roughly level three the shadow died to the first blow and the whole
     * talent held a doorway for zero turns.
     *
     * DRIVEN, not read off `shadowInitAt`: what matters is the body that
     * actually arrives on the tile.
     */
    const table = arena('shadows-grown');
    table.ren.level = 10;
    raise(table, CALL_SHADOWS_ID);
    expect(pumpUntilShadow(table)).toBeGreaterThan(0);
    const shadow = shadowsOf(table.world, 'p1')[0];
    if (shadow === undefined) throw new Error('no shadow');
    expect(shadow.level, 'the shadow was not born at her level').toBe(10);
    expect(shadow.maxHp).toBe(shadowMaxHpAt(10));
    expect(shadow.maxHp, 'the shadow is still the table’s eight').toBeGreaterThan(
      BOUND_SHADOW.maxHp,
    );
    expect(shadow.hp, 'it arrived already hurt').toBe(shadow.maxHp);
  });

  it('pins the body’s own ported figures, which nothing else reads', () => {
    /**
     * `maxHp: 8 -> 200` and an empty `immunities` both survived the whole suite
     * once, and the template's own note calls the immunities *"what makes the
     * body worth summoning"*. These are the transcriptions, against the Lua.
     */
    expect(BOUND_SHADOW.maxHp, 'rngavg(3,12) is a mean of 7.5 — shadows.lua:200').toBe(8);
    expect(BOUND_SHADOW.lifeRating, 'life_rating = 5 — shadows.lua:200').toBe(5);
    expect(BOUND_SHADOW.combat.mods?.armour, 'combat_armor = 0 — :209').toBe(0);
    expect(BOUND_SHADOW.combat.mods?.def, 'combat_def = 3 — :209').toBe(3);
    expect(BOUND_SHADOW.combat.weapon?.apr, 'apr = 8 — :213').toBe(8);
    expect(BOUND_SHADOW.combat.penetration?.all, 'resists_pen = { all=25 } — :242').toBe(25);
    expect(
      BOUND_SHADOW.combat.profile?.resists?.[DamageType.Darkness],
      'DARKNESS = 100 — :241',
    ).toBe(100);
    // FOUR OF UPSTREAM'S EIGHT `*_immune` flags, at 100. The other four name
    // effects this game does not have — see the template.
    expect(BOUND_SHADOW.combat.immunities).toEqual({
      stun: 100,
      confusion: 100,
      blind: 100,
      teleport: 100,
    });
  });
});

// ---------------------------------------------------------------------------
// THE REFRESH — `feed()` must not be a second writer of `combat`
// ---------------------------------------------------------------------------

describe('the per-turn refresh leaves the rest of the body alone', () => {
  it('does not wipe a live status flag off the shadow', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * `recomposeCombat` OWNS `combat`, AND `shadowPass` WAS WRITING IT RAW.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `engine/effects.ts` states the rule: *"any writer that skips a stage
     * produces a body whose sheet cannot be reproduced from its own fields"*.
     * `shadowCombatAt` returns a sheet with no `flags` key, so the whole
     * `StatusFlags` block went every base turn — the shadow kept a live
     * `effect:pinned` and stopped being pinned, because `recomputeAttributes`
     * only runs when an effect LANDS or EXPIRES.
     *
     * PIN IS THE LIVE CASE: the shadow's four immunities cover stun, confusion,
     * blind and teleport, so `pinned` is the flag a real fight can actually put
     * on it. Applied through the production `statusApplier`, not by hand.
     */
    const table = arena('shadows-flags');
    raise(table, CALL_SHADOWS_ID);
    expect(pumpUntilShadow(table)).toBeGreaterThan(0);
    const shadow = shadowsOf(table.world, 'p1')[0];
    if (shadow === undefined) throw new Error('no shadow');

    table.status(shadow, EffectId.Pinned, 20, {});
    expect(shadow.combat?.flags?.pinned, 'the pin never landed').toBe(true);

    table.advance();
    expect(
      effectsOn(table.effects, shadow.id).some((eff) => eff.effectId === EffectId.Pinned),
      'the pin expired before the case could measure it',
    ).toBe(true);
    expect(shadow.combat?.flags?.pinned, 'one base turn unpinned it').toBe(true);
  });

  it('keeps `baseCombat` in step, so a full recompose cannot undo the feed', () => {
    /**
     * `createMonsterActor` sets `baseCombat: init.combat`, so the summon-time
     * sheet was frozen there while `combat` was being rewritten every turn —
     * two writers over one field, and any `recomposeCombat` on the shadow would
     * have discarded the Shadow Warriors terms and put it back to its birth
     * sheet. Upstream has no such problem: `feed` is an
     * `addTemporaryValue`/`removeTemporaryValue` pair on two keys
     * (shadows.lua:300-311).
     */
    const table = arena('shadows-base');
    raise(table, CALL_SHADOWS_ID);
    expect(pumpUntilShadow(table)).toBeGreaterThan(0);
    const shadow = shadowsOf(table.world, 'p1')[0];
    if (shadow === undefined) throw new Error('no shadow');
    /**
     * ═══ AND A RANK BOUGHT MID-FIGHT IS WHAT MAKES THE TWO DIFFER AT ALL ═══
     * Deleting the `baseCombat` write SURVIVED a first pass, and it was an
     * EQUIVALENT mutant rather than a gap: `shadowCombatAt` is a pure function
     * of the level and the Shadow Warriors rank, and `createMonsterActor`
     * already set `baseCombat: init.combat` from the same call at summon time.
     * So the two agree by construction until one of those two numbers MOVES.
     *
     * That is exactly the case the refresh exists for — upstream re-feeds every
     * standing shadow from `on_learn` (shadows.lua:490-511) so a rank bought
     * mid-fight reaches a body that is already on the tile. Raising the rank
     * here is the only input in the whole space where the two writers can
     * disagree, and it is also the talent's own headline behaviour.
     */
    const before = shadow.combat?.weapon?.atk ?? 0;
    table.sheet.points.set(SHADOW_WARRIORS_ID, 4);
    table.advance();
    expect(shadow.combat?.weapon?.atk, 'the rank never reached the standing body').toBeGreaterThan(
      before,
    );
    expect(shadow.baseCombat?.weapon?.atk).toBe(shadow.combat?.weapon?.atk);
    expect(shadow.baseCombat?.increase?.all).toBe(shadow.combat?.increase?.all);
  });
});

// ---------------------------------------------------------------------------
// THE SLOT — a summon that spends and places nothing
// ---------------------------------------------------------------------------

describe('the summon never pays for a body it does not place', () => {
  it('takes a fresh id when the dead one is still in the world', () => {
    /**
     * `world.addMonster` is IDEMPOTENT ON ID (world.ts:1361-1362) and a corpse
     * stays in `allActors` for the rest of the pump it died in. `shadowsOf`
     * filters on `alive` — correctly, because a corpse must not hold a slot
     * against the CEILING — and the free-slot search used to read that same
     * list. Driven before the fix: five Ink spent, "A shadow steps out of the
     * dark beside Ren." in the Case Log, and NO LIVING SHADOW ANYWHERE.
     *
     * THE CORPSE IS LEFT IN PLACE HERE ON PURPOSE. The harness's `advance`
     * drains `reaped` the way production's `TurnEngine.reap` does; this case is
     * about the window before that, so it kills the shadow by hand and asks for
     * the next one without burying it.
     */
    const table = arena('shadows-slot');
    table.sheet.points.set(CALL_SHADOWS_ID, 4);
    expect(maxShadowsAt(4), 'rank 4 stopped allowing a second shadow').toBe(2);
    raise(table, CALL_SHADOWS_ID);
    expect(pumpUntilShadow(table)).toBeGreaterThan(0);
    const first = shadowsOf(table.world, 'p1')[0];
    if (first === undefined) throw new Error('no shadow');

    // Dead, and still on the tile — exactly the state a kill mid-pump leaves.
    first.alive = false;
    first.hp = 0;
    expect(
      table.world.getActor(first.id),
      'the corpse left before it could be measured',
    ).toBeDefined();

    let arrived = false;
    for (let turn = 0; turn < summonEveryAt(4) * 3 && !arrived; turn += 1) {
      table.sheet.resource.value = table.sheet.resource.max;
      table.advance();
      arrived = shadowsOf(table.world, 'p1').length > 0;
    }
    expect(arrived, 'ink was spent and no body arrived').toBe(true);
    const living = shadowsOf(table.world, 'p1');
    expect(living[0]?.id, 'the new shadow took the corpse’s id').not.toBe(first.id);
  });

  it('does not let a corpse hold a place against the ceiling', () => {
    // The other half of the same split: `shadowsOf`'s `alive` filter is what
    // stops a body killed this pump counting towards `maxShadowsAt`. Removing
    // it survived the suite once.
    const table = arena('shadows-ceiling');
    raise(table, CALL_SHADOWS_ID);
    expect(pumpUntilShadow(table)).toBeGreaterThan(0);
    const shadow = shadowsOf(table.world, 'p1')[0];
    if (shadow === undefined) throw new Error('no shadow');
    shadow.alive = false;
    expect(shadowsOf(table.world, 'p1'), 'a corpse counted as standing').toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// THE TILE — your own summon is not a wall
// ---------------------------------------------------------------------------

describe('a Redactor can walk through her own shadow', () => {
  it('trades places with it, the way she would with a teammate', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * 30.2% OF ORDERED STEPS, AND THE WHOLE OF THE REDACTOR'S REGRESSION.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `tryMove`'s swap branch asked `occupant.kind === ActorKind.Player`. A
     * Bound shadow is a Monster and `areEnemies` is false, so the bump-attack
     * branch above returned nothing and the step answered `Occupied` — an
     * absolute wall, to its own summoner and to her teammates.
     *
     * MEASURED over the twelve moor delves, four runs each, with the stance
     * genuinely raised: 4159 of 13765 ordered steps refused — 30.2% — wins
     * halved, six new stalls, turns-per-win up 17%; with the swap emulated
     * every one of those numbers came back. Upstream has no such case because
     * `shadows.lua:431-434` puts the shadow in `game.party`.
     */
    const table = arena('shadows-swap');
    raise(table, CALL_SHADOWS_ID);
    expect(pumpUntilShadow(table)).toBeGreaterThan(0);
    const shadow = shadowsOf(table.world, 'p1')[0];
    if (shadow === undefined) throw new Error('no shadow');

    // Put her beside it and walk into it, through the real intent path.
    table.ren.x = shadow.x + 1;
    table.ren.y = shadow.y;
    const mine = { x: table.ren.x, y: table.ren.y };
    const theirs = { x: shadow.x, y: shadow.y };
    submitIntent(table.world, table.barrier, 'p1', { kind: IntentKind.Move, dir: 'w' });
    const result = pump(table.world, {
      nowMs: 9_000,
      barrier: table.barrier,
      talents: table.runtime,
      applyStatus: table.status,
    });
    for (const id of result.reaped) table.world.removeActor(id);

    expect({ x: table.ren.x, y: table.ren.y }, 'her own shadow was a wall').toEqual(theirs);
    expect({ x: shadow.x, y: shadow.y }, 'the shadow did not move out of the way').toEqual(mine);
  });

  it('lets a TEAMMATE through it too, which is what party membership means', () => {
    /**
     * The first version of the gate asked `occupant.summonerId === actor.id`,
     * which let the Redactor past her own shadow and left it an absolute wall
     * to everybody else in the party. Upstream has no such case: the shadow is
     * a `game.party` member (`shadows.lua:431-434`) and `move_others`
     * (`Party.lua:271-272`) is a property of the PARTY, not of who summoned
     * what. In a corridor that is the difference between a doorway a party can
     * hold and one it has to queue at.
     */
    const table = arena('shadows-swap-mate');
    raise(table, CALL_SHADOWS_ID);
    expect(pumpUntilShadow(table)).toBeGreaterThan(0);
    const shadow = shadowsOf(table.world, 'p1')[0];
    if (shadow === undefined) throw new Error('no shadow');

    const mate = table.world.addPlayer('p2', 'Alex');
    mate.x = shadow.x + 1;
    mate.y = shadow.y;
    table.ren.x = shadow.x;
    table.ren.y = shadow.y + 5;
    const mine = { x: mate.x, y: mate.y };
    const theirs = { x: shadow.x, y: shadow.y };
    submitIntent(table.world, table.barrier, 'p2', { kind: IntentKind.Move, dir: 'w' });
    const result = pump(table.world, {
      nowMs: 9_200,
      barrier: table.barrier,
      talents: table.runtime,
      applyStatus: table.status,
    });
    for (const id of result.reaped) table.world.removeActor(id);

    expect({ x: mate.x, y: mate.y }, 'somebody else’s shadow was a wall').toEqual(theirs);
    expect({ x: shadow.x, y: shadow.y }).toEqual(mine);
  });

  it('still refuses to trade places with something hostile', () => {
    // The swap is player-to-player and player-to-own-summon. A husk is neither,
    // and walking into one is an ATTACK — which is the branch above the swap.
    const table = arena('shadows-swap-foe');
    const monster = husk(table.world, 'm1', 19, 20);
    const theirs = { x: monster.x, y: monster.y };
    submitIntent(table.world, table.barrier, 'p1', { kind: IntentKind.Move, dir: 'w' });
    const result = pump(table.world, {
      nowMs: 9_100,
      barrier: table.barrier,
      talents: table.runtime,
      applyStatus: table.status,
    });
    for (const id of result.reaped) table.world.removeActor(id);
    expect({ x: monster.x, y: monster.y }, 'a husk was shoved aside').toEqual(theirs);
    expect(table.ren.x, 'she walked through a husk').toBe(20);
  });
});

// ---------------------------------------------------------------------------
// THE ROOM — a friendly body is not something left to fight
// ---------------------------------------------------------------------------

describe('a standing shadow does not keep a floor open', () => {
  it('is not counted by `standingThreats`, and a husk is', () => {
    /**
     * `world/cleared.ts` refuses the announcement while `standing > 0`, and the
     * gateway's count was `kind === Monster && alive`. A Redactor holding her
     * own birth stance could kill the last body on the last floor of a fileable
     * delve and never close the case — `mine.add(siteId)` is the only write to
     * `filedFor` in the process and it sits behind that predicate.
     */
    const table = arena('shadows-cleared');
    raise(table, CALL_SHADOWS_ID);
    expect(pumpUntilShadow(table)).toBeGreaterThan(0);
    const bodies = table.world.allActors();
    expect(
      bodies.some((a: EngineActor) => isMonster(a) && a.faction === Faction.Bound),
      'no shadow to count',
    ).toBe(true);

    expect(standingThreats(bodies, table.ren), 'her own shadow held the floor open').toBe(0);
    expect(
      shouldAnnounceCleared({
        previous: 3,
        standing: standingThreats(bodies, table.ren),
        sawMonsterKill: true,
        standingPlayers: 1,
        already: false,
      }),
      'the room never went quiet',
    ).toBe(true);

    // AND THE DISCRIMINATOR: a real body still holds it open.
    husk(table.world, 'm1', 24, 24);
    expect(standingThreats(table.world.allActors(), table.ren)).toBe(1);
  });

  it('counts everything when there is nobody to be hostile to', () => {
    // No witness means the reading this line has always had. It cannot announce
    // anything in that state anyway — `standingPlayers` is zero.
    const table = arena('shadows-cleared-nobody');
    husk(table.world, 'm1', 24, 24);
    expect(standingThreats(table.world.allActors(), undefined)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// THE REACH — a gesture is a melee replacement, not a new ranged attack
// ---------------------------------------------------------------------------

describe('the gesture replaces a MELEE blow and only a melee blow', () => {
  it('leaves the stylus alone at range and takes over at contact', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * SIX TILES, AND UPSTREAM'S HOOK IS INSIDE `Combat:attackTarget`.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `Combat.lua:164-173` sits above the mainhand loop, the offhand loop and
     * the barehand fall-through — every one of them a worn weapon, with a bow
     * skipped by name (`if combat and not o.archery`, :181 and :204). Upstream
     * reaches the hook by BUMPING, and its own tooltip says so: *"This strike
     * replaces your melee physical"* (gestures.lua:202).
     *
     * OURS IS NOT ONLY A MELEE SEAM. `strike` also serves `IntentKind.Attack`,
     * and `REDACTOR.combat.range` is SIX — her marking stylus. Driven at three
     * tiles before the gate: `type mind, atk 21, def 7, chance 85` where the
     * plain swing was `darkness, atk 6, def 1, chance 63`. A blow that ignores
     * accuracy and defence, rolls the mental save and carries a three-turn
     * stun, from outside anything's reach.
     */
    const table = arena('gesture-reach');
    const far = husk(table.world, 'm1', 23, 20);
    far.hp = 5000;
    far.maxHp = 5000;
    raise(table, GESTURE_OF_PAIN_ID);

    const shot = swing(table, 'm1', 1);
    expect(shot?.hit !== undefined, 'the shot at three tiles was refused').toBe(true);
    expect(shot?.type, 'the gesture reached three tiles').toBe(DamageType.Darkness);

    // ONE TILE, AND THE SAME BODY AND THE SAME STANCE: the only thing that
    // changed is the distance.
    far.x = 21;
    far.y = 20;
    const touch = swing(table, 'm1', 2);
    expect(touch?.type, 'the gesture did not take over at contact').toBe(DamageType.Mind);
  });

  it('rolls the exact two numbers upstream rolls, not merely different ones', () => {
    /**
     * `atk`/`def` on the returned `AttackResult` are assigned from the same
     * locals the roll uses, so `checkHit(mindPower * 4, save / 4)` — sixteen
     * times the intended odds — left the old `not.toBe(plain?.atk)` assertions
     * green. "A different number" is not "the right number".
     *
     * gestures.lua:125 is `self:checkHit(mindpower, target:combatMentalResist())`
     * and :114 is `local mindpower = self:combatMindpower()`.
     */
    const table = arena('gesture-values');
    const monster = husk(table.world, 'm1', 21, 20);
    monster.hp = 5000;
    monster.maxHp = 5000;

    const plain = swing(table, 'm1', 1);
    raise(table, GESTURE_OF_PAIN_ID);
    const gesture = swing(table, 'm1', 2);

    const mind = combatMindpower(table.ren.combat ?? {});
    const save = combatMentalResist(monster.combat ?? {});
    expect(mind, 'a birth Redactor lost her mindpower').toBeGreaterThan(0);
    expect(gesture?.atk, 'the gesture did not roll mindpower').toBe(mind);
    expect(gesture?.def, 'the gesture did not roll the mental save').toBe(save);
    // AND THE ODDS THAT CAME OUT OF THOSE TWO. `chance` is the only field that
    // carries what was actually rolled.
    expect(gesture?.chance).toBeCloseTo(hitChance(mind, save), 6);
    expect(gesture?.chance, 'the gesture rolled the weapon’s odds').not.toBeCloseTo(
      plain?.chance ?? 0,
      6,
    );
  });

  it('wants BOTH hands, and the offhand is the half nothing tested', () => {
    // `canUseGestures` counts two usable hands (gestures.lua:20-40). Reducing
    // `handsFreeForGestures` to the mainhand clause alone survived the suite:
    // every case filled `Slot.Mainhand` and none filled `Slot.Offhand`, so a
    // Redactor in a buckler would have gestured.
    const table = arena('gesture-offhand');
    const monster = husk(table.world, 'm1', 21, 20);
    monster.hp = 5000;
    monster.maxHp = 5000;
    raise(table, GESTURE_OF_PAIN_ID);
    expect(swing(table, 'm1', 1)?.type).toBe(DamageType.Mind);

    table.ren.equipped = { ...table.ren.equipped, [Slot.Offhand]: 'item_watchmans_buckler' };
    expect(swing(table, 'm1', 2)?.type, 'a full offhand still gestured').toBe(DamageType.Darkness);
  });

  it('carries no weapon rider, because it swings no weapon', () => {
    /**
     * `wielder.melee_project` and `MonsterActor.onHit` are properties of a
     * WEAPON THAT WAS SWUNG. Upstream's replacement path never reaches
     * `attackTargetWith`, which is the only thing in ToME that runs a melee
     * rider, and its own proc pass (gestures.lua:158-180) fires the MINDSTARS'
     * procs and nothing else.
     *
     * THE FIXTURE IS THE WHOLE CASE. `scheduler.ts`'s `replaced !== null ? []`
     * was unexercised for one reason: the arena Redactor wears nothing and
     * `REDACTOR.combat` declares no `onHit`, so there was no rider to suppress
     * and the branch could not fail. The Brass Constable Ring is a real shipped
     * item with a real `wielder.onHit`, so this puts one on her.
     */
    const table = arena('gesture-rider');
    const monster = husk(table.world, 'm1', 21, 20);
    monster.hp = 500_000;
    monster.maxHp = 500_000;
    table.ren.equipped = { ...table.ren.equipped, [Slot.Ring]: 'item_watchmans_brass_ring' };
    recomposeCombat(table.ren, table.effects, resolveItem);
    expect(
      table.ren.combat?.onHit?.length ?? 0,
      'the ring’s rider never reached the sheet',
    ).toBeGreaterThan(0);

    // THE WEAPON FIRST: the bleed must be reachable at all, or the second half
    // of this case would pass for the wrong reason.
    let bled = false;
    for (let turn = 1; turn <= 60 && !bled; turn += 1) {
      swing(table, 'm1', turn);
      bled = effectsOn(table.effects, 'm1').some((eff) => eff.effectId === EffectId.Bleeding);
    }
    expect(bled, 'sixty swings and the ring never opened a cut').toBe(true);

    // AND NOW THE GESTURE, on a clean body.
    const second = arena('gesture-rider-2');
    const other = husk(second.world, 'm1', 21, 20);
    other.hp = 500_000;
    other.maxHp = 500_000;
    second.ren.equipped = { ...second.ren.equipped, [Slot.Ring]: 'item_watchmans_brass_ring' };
    recomposeCombat(second.ren, second.effects, resolveItem);
    raise(second, GESTURE_OF_PAIN_ID);
    for (let turn = 1; turn <= 60; turn += 1) swing(second, 'm1', turn);
    expect(
      effectsOn(second.effects, 'm1').some((eff) => eff.effectId === EffectId.Bleeding),
      'a gesture ran the ring’s melee rider',
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// THE TWO NUMBERS NOTHING PINNED
// ---------------------------------------------------------------------------

describe('the ported constants are written down, not re-derived', () => {
  it('holds Shadow Warriors at upstream’s 35 and 23', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * `shadowWarriorAccuracyAt(1)` ON BOTH SIDES OF AN ASSERTION IS NOT A TEST.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * The case below asserts the shadow's `atk` as
     * `10 + level + shadowWarriorAccuracyAt(1)` — the production expression,
     * fed by the production function. `ACCURACY_PER_ROOT 23 -> 40` and
     * `DAMAGE_PER_ROOT 35 -> 70` each left the whole suite green, and
     * `check:constants`, `check:citations` and `check:citation-names` green as
     * well, because upstream's two numbers live only in prose.
     *
     * `math.floor((math.sqrt(getTalentLevel(t)) - 0.5) * 35)` — shadows.lua:472
     * `math.floor((math.sqrt(getTalentLevel(t)) - 0.5) * 23)` — shadows.lua:475
     *
     * At rank 1: `floor(0.5 * 35) = 17` and `floor(0.5 * 23) = 11`.
     */
    expect(shadowWarriorDamageAt(1), 'floor((sqrt(1) - 0.5) * 35)').toBe(17);
    expect(shadowWarriorAccuracyAt(1), 'floor((sqrt(1) - 0.5) * 23)').toBe(11);
    // AND AT RANK 4, where the root actually moves: sqrt(4) = 2.
    expect(shadowWarriorDamageAt(4), 'floor((sqrt(4) - 0.5) * 35)').toBe(52);
    expect(shadowWarriorAccuracyAt(4), 'floor((sqrt(4) - 0.5) * 23)').toBe(34);
    /**
     * THE FLOOR AT ZERO IS LOAD-BEARING, not tidy. The `- 0.5` means a talent
     * level below 0.25 pays NEGATIVE, and a Redactor who has not bought this
     * must not make her own shadows worse than `createShadow` builds them.
     */
    expect(shadowWarriorDamageAt(0)).toBe(0);
    expect(shadowWarriorAccuracyAt(0)).toBe(0);
  });

  it('holds the cadence at upstream’s flat ten', () => {
    /**
     * `self.shadows.remainingCooldown = 10` — shadows.lua:449, fixed at every
     * rank upstream. Ours moves it with the rank for a stated reason
     * (`summonEveryAt`), and the one figure that IS upstream's was asserted
     * only as `second - first === summonEveryAt(rank)` — the constant against
     * itself. `SUMMON_EVERY_LOW 10 -> 25` survived.
     */
    expect(summonEveryAt(1), 'upstream is a flat ten at rank 1').toBe(10);
    // AND THE DIVERGENCE ITSELF, so that a rank buying nothing is visible as a
    // change rather than as a silent equality.
    expect(summonEveryAt(5), 'the rank stopped buying anything').toBeLessThan(summonEveryAt(1));
  });
});

// ---------------------------------------------------------------------------
// THE MIGRATION — a birth grant that stops being one
// ---------------------------------------------------------------------------

describe('a Redactor who saved before the swap keeps her purse', () => {
  it('charges her nothing for the two talents she used to be given', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * DRIVEN THROUGH `sheetForBody` -> `applyTalentPoints` -> `spendByPurse`.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `REDACTOR.birthTalents` displaced `open_ledger` and `issued_kit` for
     * `gesture_of_pain` and `call_shadows`. `sheet.birth` is rebuilt from the
     * CURRENT definition on every load, and `createTalentSheet`'s `at()` seeds
     * an id the file does not mention at rank 1 — so an old file came back with
     * NINE rank-1 entries against SEVEN free grants, and `spendByPurse`
     * charged the difference. `gateway.ts` derives all three purses as
     * `earned - spent` floored at zero, so that is one class point and one
     * generic point gone for ever, silently.
     *
     * `migrateLegacyBirthGrants` takes the free rank back instead — the talent
     * is no longer granted, so the rank that was granted goes with it, and the
     * player may buy it with the point that is now genuinely theirs.
     */
    const old: Record<string, number> = {};
    for (const id of sheetForClass(REDACTOR).points.keys()) old[id] = 0;
    // The file HEAD would have written: seven free grants at 1, nothing bought,
    // and no mention of the two ids that did not exist yet.
    for (const id of ['talent:strike_out', 'talent:indelible', 'talent:open_ledger']) old[id] = 1;
    old['talent:issued_kit'] = 1;
    delete old[CALL_SHADOWS_ID];
    delete old[GESTURE_OF_PAIN_ID];

    const migrated = migrateLegacyBirthGrants(REDACTOR, old);
    expect(migrated['talent:open_ledger'], 'the free stance rank was charged for').toBe(0);
    expect(migrated['talent:issued_kit'], 'the free generic rank was charged for').toBe(0);

    // AND THE LEDGER THAT COMES OUT OF IT — through the real seams.
    const spendOf = (spread: Record<string, number>): { class: number; generic: number } => {
      const engine = createContentTalentEngine();
      const sheet = sheetForClass(REDACTOR);
      engine.attach('p1', sheet);
      for (const [id, rank] of Object.entries(spread)) {
        if (sheet.points.has(id)) sheet.points.set(id, rank);
      }
      return spendByPurse(sheet, REDACTOR, (id) => engine.registry.get(id)?.tree);
    };
    const fresh = spendByPurse(
      sheetForClass(REDACTOR),
      REDACTOR,
      (id) => createContentTalentEngine().registry.get(id)?.tree,
    );
    expect(fresh, 'a fresh Redactor owes something').toEqual({ class: 0, generic: 0 });
    expect(spendOf(old), 'the unmigrated file is the defect').not.toEqual(fresh);
    expect(spendOf(migrated), 'the migration did not settle the ledger').toEqual(fresh);
  });

  it('keeps every rank the player actually bought', () => {
    // `open_ledger: 3` is one free rank and TWO paid ones. Taking the free one
    // back leaves 2, which is exactly what was paid for.
    const spread = { 'talent:open_ledger': 3, 'talent:issued_kit': 1, 'talent:strike_out': 1 };
    const migrated = migrateLegacyBirthGrants(REDACTOR, spread);
    expect(migrated['talent:open_ledger']).toBe(2);
    expect(migrated['talent:strike_out'], 'a current birth grant was touched').toBe(1);
  });

  it('leaves a file written by THIS build completely alone', () => {
    /**
     * THE PREDICATE IS "does the spread name every CURRENT birth grant". A file
     * saved by this build always does — `createTalentSheet` seeds all four into
     * `points` and `talentPointsOf` writes the whole map — so the migration
     * cannot fire twice and cannot fire on a character who genuinely bought
     * `open_ledger` with a point of her own.
     */
    const current: Record<string, number> = {};
    for (const [id, rank] of sheetForClass(REDACTOR).points) current[id] = rank;
    current['talent:open_ledger'] = 1;
    expect(migrateLegacyBirthGrants(REDACTOR, current)).toEqual(current);
    expect(migrateLegacyBirthGrants(REDACTOR, current)['talent:open_ledger']).toBe(1);
  });

  it('does nothing to a class whose four never changed', () => {
    const watchman = classById(ClassId.Watchman);
    if (watchman === undefined) throw new Error('no watchman');
    const spread = { 'talent:open_ledger': 1, 'talent:issued_kit': 1 };
    expect(migrateLegacyBirthGrants(watchman, spread)).toEqual(spread);
  });
});
