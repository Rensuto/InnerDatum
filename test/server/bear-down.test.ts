// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/modules/tome/data/talents/misc/npcs.lua:191-217 (Stun)

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * BEAR DOWN STUNS ONLY WHAT IT HITS — upstream's `if hit then` (:210).
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The talent's own comment said a miss cannot stun, and the guard under it read
 * `!victim.alive` alone, so every missed swing still reached the status door.
 * Nothing tested the talent directly. `grab.test.ts` is the same shape for the
 * same upstream arrangement, and these two cases are its hit and its miss.
 */

import { describe, expect, it } from 'vitest';

import { createContentTalentEngine } from '../../src/server/content/classes.ts';
import { EffectId, createMvpEffectState } from '../../src/server/content/effects.ts';
import { INDEX_HUSK_ELITE, monsterInit } from '../../src/server/content/monsters.ts';
import { effectsOn, statusApplier } from '../../src/server/engine/effects.ts';
import type { StatusApply } from '../../src/server/engine/effects.ts';
import type { TalentCtx } from '../../src/server/engine/talents.ts';
import { bearDown } from '../../src/server/talents/bear_down.ts';
import { createWorld } from '../../src/server/world/world.ts';
import { TileCode } from '../../src/shared/protocol.ts';

/** The elite beside a detective on open floor, and a status door that writes down what it is asked. */
function beside(seed: string, defence: number) {
  const world = createWorld(seed);
  world.level.tiles.fill(TileCode.FLOOR);
  const dalt = world.addPlayer('p1', 'Dalt', { maxHp: 1000 });
  dalt.x = 5;
  dalt.y = 5;
  dalt.combat = { ...dalt.combat, mods: { ...dalt.combat?.mods, def: defence } };
  const elite = world.addMonster('m1', monsterInit(INDEX_HUSK_ELITE, { x: 6, y: 5 }, 1));
  const effects = createMvpEffectState();
  const real = statusApplier(effects, world.rng);
  const asked: string[] = [];
  const status: StatusApply = (target, effectId, turns, params = {}) => {
    asked.push(`${target.id}:${effectId}`);
    return real(target, effectId, turns, params);
  };
  const ctx: TalentCtx = {
    engine: createContentTalentEngine(),
    world,
    rng: world.rng,
    status,
    talentLevel: 1,
  };
  const onUse = bearDown.onUse;
  if (onUse === undefined) throw new Error('Bear Down has no onUse');
  const use = () => onUse(ctx, elite, { x: dalt.x, y: dalt.y, actorId: 'p1' });
  return { effects, asked, use };
}

describe('Bear Down, npcs.lua:191-217 — the stun rides the hit', () => {
  it('on a hit, asks for STUNNED on the body it struck', () => {
    // Defence 0: the elite's accuracy is past `hitChance`'s ceiling.
    const { asked, use } = beside('bear-down-hit', 0);
    const outcome = use();
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.hits.map((h) => h.hit)).toEqual([true]);
    expect(asked).toEqual([`p1:${EffectId.Stunned}`]);
    expect(outcome.notes).toHaveLength(1);
  });

  it('on a miss, stuns nobody and says nothing of a stun', () => {
    // A defence no accuracy reaches: `hitChance` floors at 0.
    const { asked, effects, use } = beside('bear-down-miss', 10_000);
    const outcome = use();
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.hits.map((h) => h.hit)).toEqual([false]);
    expect(asked).toEqual([]);
    expect(outcome.notes).toEqual([]);
    expect(effectsOn(effects, 'p1').map((e) => e.effectId)).not.toContain(EffectId.Stunned);
  });
});
