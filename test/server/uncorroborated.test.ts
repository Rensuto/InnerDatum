// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *   STANDING NEXT TO SOMEBODY ACTUALLY HELPS.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `monster-casts.test.ts` proves the Disgraced Inspector presses this talent.
 * That is not the same as proving the talent DOES anything — a multiplier that
 * always returns 1 casts perfectly well and this codebase has now found nine
 * capabilities that were correct, connected, and reached by nothing.
 *
 * So this file asks the two questions that version could not:
 *   - does `countAdjacentKin` see a real world correctly, and
 *   - does the number it returns change the blow.
 */

import { describe, expect, it } from 'vitest';

import { countAdjacentKin } from '../../src/server/engine/actor.ts';
import { createWorld } from '../../src/server/world/world.ts';
import {
  isolationMultFor,
  uncorroborated,
  uncorroboratedMult,
} from '../../src/server/talents/uncorroborated.ts';

const LEVEL = 1;

describe('counting who is standing next to you', () => {
  /**
   * AGAINST A REAL WORLD, not a stub lookup.
   *
   * The talent calls `world.actorAt`, and a test that passed its own function
   * would prove the arithmetic and nothing about whether the talent can see the
   * board — which is the half that has broken before.
   */
  it('finds an adjacent ally through the world', () => {
    const world = createWorld('pair');
    const first = world.addPlayer('p1', 'Ren');
    const second = world.addPlayer('p2', 'Mab');
    second.x = first.x + 1;
    second.y = first.y;

    expect(countAdjacentKin(first, (x, y) => world.actorAt(x, y))).toBe(1);
    expect(countAdjacentKin(second, (x, y) => world.actorAt(x, y))).toBe(1);
  });

  it('counts nobody when there is nobody', () => {
    const world = createWorld('alone');
    const only = world.addPlayer('p1', 'Ren');
    expect(countAdjacentKin(only, (x, y) => world.actorAt(x, y))).toBe(0);
  });

  /** A monster beside you is not company. */
  it('does not count the other kind as support', () => {
    const world = createWorld('company');
    const player = world.addPlayer('p1', 'Ren');
    world.addMonster('m1', {
      name: 'Index Husk',
      sprite: 'sprite_husk',
      x: player.x + 1,
      y: player.y,
      profile: 'melee_chaser',
    });
    expect(countAdjacentKin(player, (x, y) => world.actorAt(x, y))).toBe(0);
  });
});

describe('the isolation multiplier', () => {
  /**
   * THE ORDERING IS THE WHOLE DESIGN. If these three were equal the talent
   * would still cast, still hit, still log, and mean nothing.
   */
  it('falls as company arrives', () => {
    expect(isolationMultFor(0)).toBeGreaterThan(isolationMultFor(1));
    expect(isolationMultFor(1)).toBeGreaterThan(isolationMultFor(2));
  });

  /** One witness is enough. A crowd is not better than a pair. */
  it('stops improving past the second body', () => {
    expect(isolationMultFor(3)).toBe(isolationMultFor(2));
    expect(isolationMultFor(8)).toBe(isolationMultFor(2));
  });

  it('carries all the way through to the blow', () => {
    expect(uncorroboratedMult(LEVEL, 0)).toBeGreaterThan(uncorroboratedMult(LEVEL, 2));
  });

  /**
   * AND THE PLAYER IS TOLD BOTH NUMBERS.
   *
   * A hidden three-times multiplier is a fight nobody learns from. The counter
   * to this talent is a decision the party makes standing on the tiles, so the
   * description has to state what it costs to get it wrong.
   */
  it('says both numbers in its own description', () => {
    // A REAL BODY, even though `describe` ignores it here. A cast literal would
    // compile today and hide the day this description starts reading the caster.
    const reader = createWorld('describe').addPlayer('p1', 'Ren');
    const text = uncorroborated.describe?.(reader, LEVEL) ?? '';
    expect(text).toContain(String(Math.round(uncorroboratedMult(LEVEL, 2) * 100)));
    expect(text).toContain(String(Math.round(uncorroboratedMult(LEVEL, 0) * 100)));
  });
});
