// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/modules/tome/class/Actor.lua:7648-7669 (`checkStillInCombat`)
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

import { describe, expect, it } from 'vitest';

import { BLEEDING, EffectId } from '../../src/server/content/effects.ts';
import { createDownedState } from '../../src/server/engine/downed.ts';
import {
  EffectStatus,
  SaveChannel,
  StackMode,
  createEffectState,
  setEffect,
} from '../../src/server/engine/effects.ts';
import type { EffectDef } from '../../src/server/engine/effects.ts';
import { createPartyState } from '../../src/server/engine/party.ts';
import { createTurnEngine } from '../../src/server/turn-engine.ts';
import { AiProfile } from '../../src/server/engine/actor.ts';
import { createWorld } from '../../src/server/world/world.ts';
import { TileCode } from '../../src/shared/protocol.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE FIGHT IS NOT OVER WHILE SOMEBODY IS STILL BLEEDING FROM IT.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `checkStillInCombat` asks TWICE whether combat has lapsed, and this engine
 * only ever asked once:
 *
 * ```lua
 * if game.turn - self.in_combat < 50 then return end  -- contact, recently
 *
 * -- Status effects need rechecking
 * for eff_id, p in pairs(self.tmp) do
 *   local e = self:getEffectFromId(eff_id)
 *   if e.status == "detrimental" and e.decrease > 0 then self:enterCombatStatus() break end
 * end
 * ```
 *
 * Ours asked `anyContact` — is a hostile in view — and stopped there. So the
 * last husk dying ended combat for the whole level while the person it had
 * opened up was still losing hit points every turn, and `engagement` is what
 * arms the barrier and what keeps a wounded body's multi-action round open.
 */

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A DETRIMENTAL EFFECT THAT NEVER COUNTS DOWN — `decrease = 0`.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * NOTHING IN THE GAME HAS ONE, which is exactly why it is built here. Every
 * authored effect carries `decrease: 1`, so a fixture drawn from the roster
 * cannot tell `status === Detrimental && decrease > 0` apart from
 * `status === Detrimental` — and it did not: deleting the `decrease` half of
 * upstream's guard passed all three tests below before this def existed.
 *
 * The guard is upstream's (`tome/class/Actor.lua:7660`) and it is the difference
 * between a wound holding the floor for as long as it bleeds and a PERMANENT
 * debuff holding it for the rest of the session.
 */
const AFFLICTED: EffectDef = Object.freeze({
  id: 'effect:test_permanent',
  badge: 'Xx',
  displayName: 'Afflicted',
  description: 'A test-only detrimental effect that never counts down.',
  type: SaveChannel.Physical,
  status: EffectStatus.Detrimental,
  stackMode: StackMode.Refresh,
  subtypes: ['test'],
  // THE FIELD UNDER TEST.
  decrease: 0,
  icon: 'icon_status_bleeding',
  parameters: {},
} satisfies EffectDef);

function floor(name: string) {
  const world = createWorld(name);
  world.level.tiles.fill(TileCode.FLOOR);
  const effects = createEffectState([BLEEDING, AFFLICTED]);
  const engine = createTurnEngine({
    world,
    downed: createDownedState(),
    parties: createPartyState(),
    effects,
  });
  // ENOUGH HIT POINTS TO OUTLAST THE BLEED, so this measures engagement rather
  // than how long somebody survives a wound.
  const body = world.addPlayer('p1', 'Detective', { maxHp: 5000 });
  body.x = 4;
  body.y = 4;
  engine.join('p1');
  engine.setConnected('p1', true);
  engine.pump();

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE FIGHT HAS TO HAVE STARTED, AND THE FIRST DRAFT OF THIS FILE FORGOT.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Upstream's clause lives inside `checkStillInCombat`, which opens
   * `if not self.in_combat then return end` — it can only stop combat LAPSING,
   * never begin it. These tests originally staged a bleeding body in an empty
   * room and watched engagement rise, which passed against an implementation
   * that could START combat from a wound. That version would have put every
   * unrelated person in a town into a barrier the first time somebody walked out
   * of a delve still bleeding.
   *
   * So a husk stands next to the body until the fight is real, and is then
   * REAPED — which is the situation the clause is actually about: the last
   * hostile is dead and somebody is still losing hit points from it.
   */
  const husk = world.addMonster('foe', {
    name: 'Index Husk',
    sprite: 'enemy_index_husk_s',
    x: 5,
    y: 4,
    profile: AiProfile.MeleeChaser,
    maxHp: 9999,
  });
  engine.pump();

  const clearTheRoom = (): void => {
    husk.hp = 0;
    husk.alive = false;
    world.removeActor(husk.id);
  };
  return { world, engine, body, effects, clearTheRoom };
}

/** Pass `turns` turns, and report the engagement clock after each one. */
function pass(scene: ReturnType<typeof floor>, turns: number): number[] {
  const seen: number[] = [];
  for (let i = 0; i < turns; i += 1) {
    scene.engine.hold('p1');
    scene.engine.commit('p1');
    scene.engine.pump();
    seen.push(scene.world.turn.engagement);
  }
  return seen;
}

describe('engagement and a wound that is still open', () => {
  it('lapses in an empty room when nothing is on anybody', () => {
    /**
     * THE CONTROL, and it is what makes the test below mean anything: with
     * nothing in view and nothing on the body, the clock runs out. An empty room
     * releases the party — which is the deviation `ENGAGEMENT_TURNS` records
     * (three turns rather than upstream's five, because *"five turns of parking
     * at an empty room is five turns of four people pressing space"*).
     */
    const scene = floor('engage-quiet');
    expect(scene.world.turn.engagement, 'the husk never armed it').toBeGreaterThan(0);
    scene.clearTheRoom();
    expect(pass(scene, 8).at(-1)).toBe(0);
  });

  it('does not lapse while a detrimental effect is still counting down', () => {
    const scene = floor('engage-bleeding');
    scene.clearTheRoom();
    const landed = setEffect(
      scene.effects,
      scene.body,
      EffectId.Bleeding,
      12,
      // NO `applyPower`, so no save: this is about what a landed wound DOES to
      // the combat clock, not about whether it lands.
      {},
      scene.world.rng,
    );
    expect(landed.dur, 'the bleed never landed').toBeGreaterThan(0);

    // Longer than `ENGAGEMENT_TURNS` by a wide margin, so a clock that merely
    // decays slowly would still be caught.
    expect(pass(scene, 8).every((turns) => turns > 0)).toBe(true);
  });

  it('and lapses once the wound closes, so it is the EFFECT and not a latch', () => {
    /**
     * The other half. A clause that raised engagement and never let it fall
     * again would pass the test above and lock a floor for the rest of the
     * session — which is exactly what `decrease > 0` is upstream's guard
     * against, and why a PERMANENT debuff must not count.
     */
    const scene = floor('engage-healed');
    scene.clearTheRoom();
    setEffect(scene.effects, scene.body, EffectId.Bleeding, 3, {}, scene.world.rng);

    const clock = pass(scene, 14);
    expect(
      clock.some((turns) => turns > 0),
      'the bleed never held the clock up',
    ).toBe(true);
    expect(clock.at(-1), 'the clock never came back down').toBe(0);
  });
});

describe('a permanent debuff is not a fight', () => {
  it('does not hold the clock up, which is what `decrease > 0` is for', () => {
    /**
     * `tome/class/Actor.lua:7660` — `if e.status == "detrimental" and e.decrease > 0`.
     *
     * Without the second half, anything that does not tick down would keep a
     * level in combat forever: the party would never be released, the barrier
     * would never disarm, and the cause would be a badge nobody can remove.
     * A wound is a fight; a condition is not.
     */
    const scene = floor('engage-permanent');
    scene.clearTheRoom();
    const landed = setEffect(scene.effects, scene.body, AFFLICTED.id, 12, {}, scene.world.rng);
    expect(landed.dur, 'the fixture effect never landed').toBeGreaterThan(0);

    expect(pass(scene, 8).at(-1), 'a permanent debuff held the floor in combat').toBe(0);
  });
});

describe('and it can never START a fight, only keep one going', () => {
  it('leaves a quiet floor quiet, however wounded the body standing on it is', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE ASSERTION THAT PROTECTS EVERY TOWN IN THE GAME.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `engagement` is the last clause of `isBlocking`, and a SHARED realm's must
     * stay at zero: that is what lets six unrelated people stand in Alderbrook
     * without waiting on each other, and it holds today only because a town has
     * no hostiles for `anyContact` to find.
     *
     * A version of this clause that could raise engagement on its own would
     * break that the first time somebody walked out of a delve with a wound
     * still open — a whole town in a single barrier, waiting on a stranger, with
     * a Bell running and nothing on screen to explain it.
     *
     * Upstream cannot do that: `checkStillInCombat` returns immediately when
     * `in_combat` is unset. This is that line.
     */
    const world = createWorld('engage-town');
    world.level.tiles.fill(TileCode.FLOOR);
    const effects = createEffectState([BLEEDING]);
    const engine = createTurnEngine({
      world,
      downed: createDownedState(),
      parties: createPartyState(),
      effects,
    });
    const body = world.addPlayer('p1', 'Detective', { maxHp: 5000 });
    body.x = 4;
    body.y = 4;
    engine.join('p1');
    engine.setConnected('p1', true);
    engine.pump();
    expect(world.turn.engagement, 'the fixture started in combat').toBe(0);

    setEffect(effects, body, EffectId.Bleeding, 12, {}, world.rng);
    for (let i = 0; i < 8; i += 1) {
      engine.hold('p1');
      engine.commit('p1');
      engine.pump();
      expect(world.turn.engagement, 'a wound started a fight in an empty room').toBe(0);
    }
  });
});
