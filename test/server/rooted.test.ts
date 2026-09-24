// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ROOTED — `never_move = 1` (crystal.lua:39), THROUGH THE TURN ENGINE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `MonsterActor.neverMove` is read in three places: `kite` never proposes a
 * step, `knockback` resists it in full, and the scheduler's move gate refuses
 * the step whatever proposed it. This file is the gate. It drives a MELEE
 * CHASER, whose AI proposes a step every turn it is not adjacent — so the only
 * thing that can keep it where it spawned is the gate. The ai.test sweep
 * covers `kite`; talents.test covers the shove.
 */

import { describe, expect, it } from 'vitest';

import { AiProfile } from '../../src/server/engine/actor.ts';
import { createTurnEngine } from '../../src/server/turn-engine.ts';
import { createWorld } from '../../src/server/world/world.ts';
import { TileCode } from '../../src/shared/protocol.ts';

function stage(seed: string, rooted: boolean, at: { x: number; y: number }) {
  const world = createWorld(seed);
  world.level.tiles.fill(TileCode.FLOOR);
  const ren = world.addPlayer('p1', 'Ren', { maxHp: 500 });
  ren.x = 2;
  ren.y = 5;
  ren.hpRegen = 0;
  const husk = world.addMonster('m1', {
    name: 'Index Husk',
    sprite: 'enemy_index_husk_s',
    x: at.x,
    y: at.y,
    profile: AiProfile.MeleeChaser,
    maxHp: 500,
    ...(rooted ? { neverMove: true as const } : {}),
  });
  const engine = createTurnEngine({ world, now: () => 0 });
  engine.join('p1');
  const wait = (turns: number): void => {
    for (let i = 0; i < turns; i += 1) {
      engine.hold('p1');
      engine.pump();
    }
  };
  return { ren, husk, wait };
}

describe('a rooted body never takes a step', () => {
  it('stays where it spawned while its AI chases, where the same body unrooted closes', () => {
    const control = stage('rooted-control', false, { x: 7, y: 5 });
    control.wait(4);
    expect(control.husk.x, 'the fixture body could not walk to begin with').toBeLessThan(7);

    const rooted = stage('rooted', true, { x: 7, y: 5 });
    rooted.wait(4);
    expect({ x: rooted.husk.x, y: rooted.husk.y }).toEqual({ x: 7, y: 5 });
  });

  it('still swings at what stands beside it — tome/class/Actor.lua:1338', () => {
    // "Never move but tries to attack ? ok": the gate sits below the bump.
    const t = stage('rooted-swing', true, { x: 3, y: 5 });
    t.wait(8);
    expect(t.husk.x).toBe(3);
    expect(t.ren.hp, 'a rooted body lost its blow along with its step').toBeLessThan(500);
  });
});
