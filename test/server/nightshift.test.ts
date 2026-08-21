// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported in shape from t-engine4 game/modules/tome/data/talents/techniques/conditioning.lua.
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" — https://te4.org/license

import { describe, expect, it } from 'vitest';

import { EMPTY_PASSIVE_VIEW, createTurnProcs } from '../../src/server/engine/hooks.ts';
import { DamageType } from '../../src/server/engine/damage.ts';
import { braced } from '../../src/server/talents/braced.ts';
import { deadOnYourFeet, thresholdAt } from '../../src/server/talents/dead_on_your_feet.ts';
import { longNights } from '../../src/server/talents/long_nights.ts';
import { oneAtATime } from '../../src/server/talents/one_at_a_time.ts';
import { secondWind } from '../../src/server/talents/second_wind.ts';
import { regenAt, walkItOff } from '../../src/server/talents/walk_it_off.ts';
import { TALENT_MAX_LEVEL } from '../../src/shared/progression.ts';
import type { HookCtx, IncomingDamage, PassiveView } from '../../src/server/engine/hooks.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *   THE FIRST SHARED TREE THAT IS NOT SIX FLAT NUMBERS.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `generic/groundwork` grants armour, defence, accuracy, two saves and a
 * Constitution — six unconditional increments, none of which needs a test
 * beyond "the number goes up with the rank". Every talent here is worth a
 * different amount depending on the board, and the CONDITION is the talent: a
 * Braced that pays while walking is not a weaker Braced, it is a different and
 * much worse one, and nothing in the type system would notice.
 */

/** A view that answers whatever this test wants and nothing else. */
function viewOf(over: Partial<Record<keyof PassiveView, unknown>>): PassiveView {
  return { ...EMPTY_PASSIVE_VIEW, ...over } as PassiveView;
}

/** A body a hook can be pointed at, with a latch of its own. */
function ctxOf(hp: number, maxHp: number, level: number, alive = true): HookCtx {
  return {
    self: { id: 'p1', name: 'Ren', hp, maxHp, alive, x: 0, y: 0 },
    level,
    procs: createTurnProcs(),
  };
}

describe('Second Wind — worth nothing until it is worth everything', () => {
  it('grants nothing at full health', () => {
    const block = secondWind.passive?.(TALENT_MAX_LEVEL, viewOf({ hpFraction: () => 1 }));
    expect(block?.mods?.physResist ?? 0).toBe(0);
    expect(block?.mods?.mentalResist ?? 0).toBe(0);
  });

  it('grants more the worse it gets', () => {
    const half = secondWind.passive?.(3, viewOf({ hpFraction: () => 0.5 }))?.mods?.physResist ?? 0;
    const dying = secondWind.passive?.(3, viewOf({ hpFraction: () => 0.1 }))?.mods?.physResist ?? 0;
    expect(half).toBeGreaterThan(0);
    expect(dying).toBeGreaterThan(half);
  });

  it('moves BOTH saves, which is what stops it being Unflinching with a condition', () => {
    const block = secondWind.passive?.(3, viewOf({ hpFraction: () => 0 }));
    expect(block?.mods?.physResist).toBe(block?.mods?.mentalResist);
    expect(block?.mods?.physResist ?? 0).toBeGreaterThan(0);
  });
});

describe('Braced — armour you only have while standing still', () => {
  it('grants nothing on a turn the body moved', () => {
    const block = braced.passive?.(TALENT_MAX_LEVEL, viewOf({ movedThisTurn: () => true }));
    expect(block?.mods?.armour ?? 0).toBe(0);
  });

  it('grants armour AND hardiness while standing', () => {
    // Armour without hardiness is a number that stops mattering against anything
    // that hits hard — the talent would read twice as good as it played.
    const block = braced.passive?.(3, viewOf({ movedThisTurn: () => false }));
    expect(block?.mods?.armour ?? 0).toBeGreaterThan(0);
    expect(block?.mods?.armourHardiness ?? 0).toBeGreaterThan(0);
  });
});

describe('One at a Time — the talent that pays for a doorway', () => {
  it('pays for exactly one adjacent enemy', () => {
    const block = oneAtATime.passive?.(3, viewOf({ adjacentEnemies: () => 1 }));
    expect(block?.mods?.atk ?? 0).toBeGreaterThan(0);
    expect(block?.mods?.physCrit ?? 0).toBeGreaterThan(0);
  });

  it('pays nothing for none, which is the half that is easy to get backwards', () => {
    /**
     * "The fewer the better" is the obvious formula and it hands a character
     * standing alone across the room the full bonus for doing nothing. This
     * pays for FIGHTING one thing.
     */
    expect(oneAtATime.passive?.(3, viewOf({ adjacentEnemies: () => 0 }))?.mods?.atk ?? 0).toBe(0);
  });

  it('pays nothing once a second one arrives', () => {
    expect(oneAtATime.passive?.(3, viewOf({ adjacentEnemies: () => 2 }))?.mods?.atk ?? 0).toBe(0);
  });
});

describe('Long Nights — the only talent that reads the class resource', () => {
  it('grants nothing on a full bar', () => {
    const block = longNights.passive?.(TALENT_MAX_LEVEL, viewOf({ resourceFraction: () => 1 }));
    expect(block?.mods?.mentalResist ?? 0).toBe(0);
  });

  it('grants more the more has been spent', () => {
    const some = longNights.passive?.(3, viewOf({ resourceFraction: () => 0.6 }));
    const empty = longNights.passive?.(3, viewOf({ resourceFraction: () => 0 }));
    expect(empty?.mods?.mentalResist ?? 0).toBeGreaterThan(some?.mods?.mentalResist ?? 0);
  });

  it('stays out of the physical channel, which is already crowded', () => {
    // Unflinching, Second Wind and armour all live there. A fourth would be a
    // bigger number in the channel a party already covers.
    const block = longNights.passive?.(3, viewOf({ resourceFraction: () => 0 }));
    expect(block?.mods?.physResist).toBeUndefined();
  });
});

describe('Dead on Your Feet — a floor, not a heal', () => {
  /**
   * A WHOLE `IncomingDamage`, not the two fields this talent happens to read.
   * The type carries `sourceId` and `lethal` as well, and a partial literal
   * would compile under vitest (which strips types) and fail the typecheck —
   * which is exactly how this file first reached a commit.
   */
  const blow = (dam: number): IncomingDamage => ({
    dam,
    type: DamageType.Physical,
    sourceId: 'husk_1',
    // THE ENGINE'S PRE-HANDLER SNAPSHOT, and the talent deliberately does not
    // read it — see the note on `onTakeDamage` for why the LIVE figure is the
    // right one. Set honestly anyway so the fixture is not lying to a future
    // handler that does read it.
    lethal: dam >= 40,
  });

  it('leaves a killing blow one short', () => {
    const ctx = ctxOf(40, 200, 3);
    const edit = deadOnYourFeet.hooks?.onTakeDamage?.(ctx, blow(9999));
    expect(edit?.dam).toBe(39);
  });

  it('does not spend its latch on a blow that was never going to kill', () => {
    /**
     * ═══ THE ONE A HUSK WOULD HAVE EXPLOITED ═══
     * If a scratch spent the latch, anything could disarm this by hitting for 1
     * first — and the talent would look like it simply did not work.
     */
    const ctx = ctxOf(40, 200, 3);
    expect(deadOnYourFeet.hooks?.onTakeDamage?.(ctx, blow(1))).toBeUndefined();
    expect(deadOnYourFeet.hooks?.onTakeDamage?.(ctx, blow(9999))?.dam).toBe(39);
  });

  it('fires only once a turn', () => {
    const ctx = ctxOf(40, 200, 3);
    expect(deadOnYourFeet.hooks?.onTakeDamage?.(ctx, blow(9999))?.dam).toBe(39);
    // The second killing blow of the same turn kills. Against one heavy
    // attacker this is a reprieve; against four husks it buys one of the four.
    expect(deadOnYourFeet.hooks?.onTakeDamage?.(ctx, blow(9999))).toBeUndefined();
  });

  it('will not save a body that was already gone', () => {
    // Below the rank-scaled threshold it does not fire at all — otherwise the
    // last quarter of a health bar stops meaning anything.
    const ctx = ctxOf(1, 200, 3);
    expect(deadOnYourFeet.hooks?.onTakeDamage?.(ctx, blow(9999))).toBeUndefined();
  });

  it('reaches further down at a higher rank', () => {
    expect(thresholdAt(TALENT_MAX_LEVEL)).toBeLessThan(thresholdAt(1));
  });
});

describe('Walk It Off — the only healing that is not a class’s job', () => {
  it('mends a little each turn', () => {
    const ctx = ctxOf(100, 200, 3);
    walkItOff.hooks?.onTurnStart?.(ctx);
    expect(ctx.self.hp).toBe(100 + regenAt(3));
  });

  it('never overfills', () => {
    // A body reading 80/72 is a number no other part of this game can display.
    const ctx = ctxOf(199, 200, TALENT_MAX_LEVEL);
    walkItOff.hooks?.onTurnStart?.(ctx);
    expect(ctx.self.hp).toBe(200);
  });

  it('does not mend a corpse', () => {
    /**
     * ═══ THE ONE THAT WOULD HAVE PUT A SECOND DOOR IN THE RESCUE RULES ═══
     * Downed keeps a body on the board at 0. Without the guard a downed
     * character would quietly heal themselves off the floor, and the whole
     * rescue system would have an invisible exit nobody designed.
     */
    const ctx = ctxOf(0, 200, TALENT_MAX_LEVEL, false);
    walkItOff.hooks?.onTurnStart?.(ctx);
    expect(ctx.self.hp).toBe(0);
  });

  it('stays flat, so it does not grow with the life curve', () => {
    /**
     * A FRACTION OF MAXIMUM HEALTH would make a level-50 character unkillable
     * out of combat — and, worse, uninteresting. A flat figure matters most
     * early and is a rounding error at the cap, which is what a safety net
     * should be.
     */
    const small = ctxOf(10, 72, TALENT_MAX_LEVEL);
    const large = ctxOf(10, 1444, TALENT_MAX_LEVEL);
    walkItOff.hooks?.onTurnStart?.(small);
    walkItOff.hooks?.onTurnStart?.(large);
    expect(small.self.hp - 10).toBe(large.self.hp - 10);
  });
});
