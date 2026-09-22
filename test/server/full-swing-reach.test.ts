// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

import { describe, expect, it } from 'vitest';

import {
  WATCHMAN,
  createContentTalentEngine,
  createTalentBook,
  sheetForClass,
} from '../../src/server/content/classes.ts';
import { AiProfile } from '../../src/server/engine/actor.ts';
import { TargetShape, talentId } from '../../src/server/engine/talents.ts';
import { fullSwing } from '../../src/server/talents/leverage.ts';
import { createWorld } from '../../src/server/world/world.ts';
import { ErrorCode, TileCode } from '../../src/shared/protocol.ts';
import { trained } from '../helpers/trained.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * FULL SWING REACHES WHAT UPSTREAM'S TWIST THE KNIFE REACHES: THE 3x3.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Upstream is `range = 1` (cunning/dirty.lua:162), refused when
 * `core.fov.distance > range` (engine/Target.lua:447-448), and that distance
 * rounds half-up. So, derived rather than assumed:
 *
 *     (1,0) -> 1          in reach
 *     (1,1) -> 1.41 + 0.5 = 1.91 -> 1   in reach
 *     (2,0) -> 2          out
 *     (2,1) -> 2.24 + 0.5 = 2.74 -> 2   out
 *     (2,2) -> 2.83 + 0.5 = 3.33 -> 3   out
 *
 * Every tile at one step is in, every tile at two steps is out. The pins below
 * are the whole 5x5 around the caster, so the fix cannot be "reach further".
 *
 * THROUGH THE TALENT BOOK'S `check`, the gate a press from the client meets at
 * submission (`createTalentBook`, content/classes.ts), which resolves the body
 * on the tile and asks `canUseTalent`. A red here is what a player saw: the
 * press refused with `out_of_range`.
 */

function scene() {
  const world = createWorld('full-swing-reach');
  world.level.tiles.fill(TileCode.FLOOR);
  const talents = createContentTalentEngine();
  const book = createTalentBook(talents, world);
  const body = world.addPlayer('p1', 'Ren', {
    maxHp: 900,
    combat: WATCHMAN.combat,
    classId: WATCHMAN.id,
  });
  body.x = 10;
  body.y = 10;
  // THE CATEGORY POINT, SPENT: Leverage is a locked tree, so Full Swing is not
  // on a Watchman's sheet until it is bought. `trained` puts the point in it.
  talents.attach('p1', trained(sheetForClass(WATCHMAN, ['generic/leverage'])));

  // A FOE ON EVERY TILE OF THE 5x5, so each check below names a real body and
  // the only thing that differs between them is the distance.
  for (let dy = -2; dy <= 2; dy += 1) {
    for (let dx = -2; dx <= 2; dx += 1) {
      if (dx === 0 && dy === 0) continue;
      world.addMonster(`foe_${String(dx)}_${String(dy)}`, {
        name: 'Index Husk',
        sprite: 'enemy_index_husk_s',
        x: body.x + dx,
        y: body.y + dy,
        profile: AiProfile.MeleeChaser,
        maxHp: 9999,
      });
    }
  }

  const press = (dx: number, dy: number) =>
    book.check(body, talentId('full_swing'), { x: body.x + dx, y: body.y + dy });
  return { press };
}

describe('Full Swing — upstream range 1 under upstream’s rounded distance', () => {
  it('is the talent under test, a single-target hostile press', () => {
    // So a refusal below is about the TILE and not about a talent that
    // quietly became a self-cast.
    expect(fullSwing.targeting.shape).toBe(TargetShape.Single);
    expect(fullSwing.targeting.minRange).toBe(0);
  });

  it('accepts a foe standing diagonally next to you', () => {
    const { press } = scene();
    for (const [dx, dy] of [
      [1, 1],
      [-1, 1],
      [1, -1],
      [-1, -1],
    ] as const) {
      expect(press(dx, dy), `refused the diagonal at (${String(dx)},${String(dy)})`).toBeNull();
    }
  });

  it('accepts the four orthogonal neighbours, as it always did', () => {
    const { press } = scene();
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      expect(press(dx, dy), `refused (${String(dx)},${String(dy)})`).toBeNull();
    }
  });

  it('refuses every tile two steps away, which upstream refuses too', () => {
    const { press } = scene();
    for (let dy = -2; dy <= 2; dy += 1) {
      for (let dx = -2; dx <= 2; dx += 1) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== 2) continue;
        expect(press(dx, dy), `reached (${String(dx)},${String(dy)})`).toBe(ErrorCode.OutOfRange);
      }
    }
  });
});
