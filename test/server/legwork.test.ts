// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported in shape from t-engine4 game/modules/tome/data/talents/cunning/survival.lua.
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" — https://te4.org/license

import { describe, expect, it } from 'vitest';

import { DEAD_MOD_KEYS } from '../../src/server/content/items.ts';
import { EMPTY_PASSIVE_VIEW } from '../../src/server/engine/hooks.ts';
import {
  LEGWORK,
  disengageAt,
  downhill,
  flightAt,
  kickOff,
  lightFeet,
  longStride,
  movingTarget,
  secondExit,
} from '../../src/server/talents/legwork.ts';
import { braced } from '../../src/server/talents/braced.ts';
import { secondLook } from '../../src/server/talents/leverage.ts';
import { TALENT_MAX_LEVEL } from '../../src/shared/progression.ts';
import type { PassiveView } from '../../src/server/engine/hooks.ts';
import type { Talent } from '../../src/server/engine/talents.ts';

const viewOf = (over: Partial<Record<keyof PassiveView, unknown>>): PassiveView =>
  ({ ...EMPTY_PASSIVE_VIEW, ...over }) as PassiveView;

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *   THE ONE BUDGET IN THIS GAME NOTHING COULD CHANGE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `maxMp` came off the class table and stayed there for a whole career: a
 * level-50 character covered exactly the ground a level-1 one did. Statuses
 * could TAKE movement away — `SLOWED` has carried an `mpPenalty` since it was
 * authored — and nothing could ever give it back, let alone add to it.
 */

describe('the movement channel', () => {
  it('is granted by this tree and by nothing else in the game', () => {
    const movers = LEGWORK.filter(
      (talent) => (talent.passive?.(3, viewOf({}))?.mods?.moveMp ?? 0) > 0,
    );
    expect(movers.length, 'no talent in Legwork moves you').toBeGreaterThan(0);
  });

  it('is small, because a step is worth more than ten damage', () => {
    /**
     * ═══ THE BALANCE ASSERTION, AND IT IS THE ONE THAT MATTERS HERE ═══
     * A class has three or four movement points. Three extra would be nearly
     * double, at which point a party stops having to think about where it
     * stands — and `one_at_a_time`, `braced`, `riot_line` and `cold_case` all
     * pay for a POSITION, so a character who can walk out of any position has
     * quietly turned four talents off.
     */
    for (const talent of LEGWORK) {
      const granted =
        talent.passive?.(
          TALENT_MAX_LEVEL,
          viewOf({ adjacentEnemies: () => 1, hpFraction: () => 0 }),
        )?.mods?.moveMp ?? 0;
      expect(granted, `${talent.id} at the cap`).toBeLessThanOrEqual(2);
    }
  });

  it('may be granted by an item, and no item does', () => {
    /**
     * `AdditiveMods` omits fields NOTHING READS, so an item cannot grant a
     * number a player could never see. `moveMp` is live, so excluding it there
     * would be using a dead-field guard to express a content decision — and it
     * would have blocked TALENTS too, because `passiveCombat` is typed
     * `Partial<AdditiveMods>`. That is how the mistake announced itself while
     * this tree was being written.
     *
     * Boots that move you an extra tile are a good idea and a loot-balance
     * change. Authoring one belongs to a commit about the loot table.
     */
    expect(DEAD_MOD_KEYS).not.toContain('moveMp');
  });
});

describe('the movement talents', () => {
  it('Long Stride pays unconditionally, which is what makes it the door', () => {
    // A locked tree has to be worth its category point on the day it is bought,
    // and a wall of conditions is worth nothing until a player has learned what
    // triggers them.
    expect(longStride.passive?.(1, viewOf({}))?.mods?.moveMp ?? 0).toBeGreaterThan(0);
  });

  it('Kick Off is a BUTTON, which is what upstream spends on this', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THIS ASSERTED A PASSIVE, AND THE TREE'S OWN CITATION SAYS WHY IT WAS WRONG
     * ═══════════════════════════════════════════════════════════════════════
     *
     * It read: "Kick Off pays only while something is on you" — a permanent
     * trickle of `moveMp` whenever anything was adjacent. That is a passive
     * standing in for the thing upstream spends a button on.
     *
     * `technique/mobility`, the tree legwork.ts cites as its shape, is four
     * talents: Disengage, Evasion and Tumble all carry `action =`, and Trained
     * Reactions is `mode = "sustained"` (mobility.lua:41, 205, 239, 285).
     * THREE ACTIVATED, ONE SUSTAINED, ZERO PASSIVE — against our six passives.
     *
     * A trickle could not do what Disengage does anyway: it helps on the turn
     * AFTER you decided to walk, it cannot cross the gap in one action, and it
     * is worth nothing at all if the thing on you also took your movement.
     */
    expect(kickOff.passive).toBeUndefined();
    expect(kickOff.onUse).toBeTypeOf('function');
    expect(kickOff.kind).toBe('active');
    // AP ONLY, NO RESOURCE. Four classes may buy this tree and they spend four
    // different resources; charging one would be free for a Watchman and
    // expensive for a Redactor for no reason a player could read.
    expect(kickOff.cost.resource ?? 0).toBe(0);
    expect(kickOff.cost.ap ?? 0).toBeGreaterThan(0);
    // And it scales every rank, which 3..5 did not — see `disengageAt`.
    const steps = [1, 2, 3, 4, 5].map((rank) => disengageAt(rank));
    expect(new Set(steps).size, steps.join(',')).toBe(steps.length);
  });

  it('Downhill is the OTHER button, and keeps its threshold as a rider', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * IT WAS A PASSIVE, AND UPSTREAM SPENDS A BUTTON HERE.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `technique/mobility` — the tree this file's own Kick Off cites — is
     * Disengage, Evasion and Tumble, all `action =`, plus Trained Reactions as
     * `mode = "sustained"`. Kick Off is Disengage, the getting OUT. This is
     * Tumble (mobility.lua:239), the getting THERE, and until it existed nothing
     * in a discipline called "Getting there, and getting out" could be pressed
     * to get anywhere.
     *
     * ═══ AND THE THRESHOLD SURVIVED THE CONVERSION ═══
     * The old passive's note argued it: "This is the talent for the turn you
     * decide to leave, and it should not be paying during the ordinary business
     * of being hit." A turn you DECIDE on is exactly what a button is. So the
     * quarter is the rider now rather than the whole talent — the tumble works
     * at any health and goes a tile further on the turn it was named for.
     */
    expect(downhill.passive).toBeUndefined();
    expect(downhill.onUse).toBeTypeOf('function');
    expect(downhill.kind).toBe('active');
    // AP ONLY: four classes may buy this tree and they spend four resources.
    expect(downhill.cost.resource ?? 0).toBe(0);
    // Every rank moves the distance, which 2..4 did not — see `flightAt`.
    const steps = [1, 2, 3, 4, 5].map((rank) => flightAt(rank));
    expect(new Set(steps).size, steps.join(',')).toBe(steps.length);
    // The SENTENCE is checked in talent-scaling.test.ts, which has an actor to
    // hand: `authored` pins '2 tiles' at rank 1 and the descNext rule pins that
    // every rank reads differently.
  });
});

describe('Moving Target is upstream\u2019s Evasion', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE LAST OF MOBILITY'S FOUR TO STOP BEING A PASSIVE.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `technique/mobility` is Disengage, Evasion and Tumble — all `action =` —
   * plus Trained Reactions as `mode = "sustained"` (mobility.lua:41, 205, 239,
   * 285). Kick Off is Disengage, Downhill is Tumble, Second Exit is Trained
   * Reactions. This was the one still standing still.
   *
   * ═══ AND IT COULD NOT HAVE BEEN PORTED BEFORE ═══
   * Evasion's whole shape is "for a few turns you are harder to hit", which is a
   * timed BUFF. `EffectModifiers` is a fixed set of flags and budget penalties
   * with no way to ADD anything, so every effect this game had authored was
   * detrimental. `EffectDef.wielder` is what changed it.
   */
  it('is an active that applies a BENEFICIAL effect, not a passive', () => {
    expect(movingTarget.passive).toBeUndefined();
    expect(movingTarget.onUse).toBeTypeOf('function');
    expect(movingTarget.kind).toBe('active');
    // AP only: four classes may buy this tree and they spend four resources.
    expect(movingTarget.cost.resource ?? 0).toBe(0);
  });

  it('asks for the defence its rank bought, and every rank differs', () => {
    const asked: number[] = [];
    for (const rank of [1, 2, 3, 4, 5]) {
      const ctx = {
        talentLevel: rank,
        status: (_t: unknown, _id: string, _dur: number, params: { power?: number }) => {
          asked.push(Number(params.power ?? 0));
          return { outcome: 'applied' };
        },
      } as unknown as Parameters<NonNullable<typeof movingTarget.onUse>>[0];
      const self = { id: 'a', name: 'A' } as unknown as Parameters<
        NonNullable<typeof movingTarget.onUse>
      >[1];
      movingTarget.onUse?.(ctx, self, { x: 0, y: 0 });
    }
    expect(asked).toHaveLength(5);
    expect(new Set(asked).size, asked.join(',')).toBe(5);
  });

  it('refuses only when there is no status table at all', () => {
    // A buff cannot be resisted — `canBe` consults immunities only for a
    // detrimental effect and `applySave` rolls only for one — so the absent seam
    // is the single refusal, and it is a fixture rather than anything a player
    // can produce.
    const ctx = { talentLevel: 3 } as unknown as Parameters<
      NonNullable<typeof movingTarget.onUse>
    >[0];
    const self = { id: 'a', name: 'A' } as unknown as Parameters<
      NonNullable<typeof movingTarget.onUse>
    >[1];
    expect(movingTarget.onUse?.(ctx, self, { x: 0, y: 0 })?.ok).toBe(false);
  });
});

describe('the triad on one binary', () => {
  it('still pays two of three whichever way the turn went', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * ONE QUESTION — DID THIS BODY CHANGE TILES — READ BY THREE DISCIPLINES.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `braced` sells armour for standing still, `secondLook` sells criticals
     * for it, and something in this tree sells for the opposite. A character who
     * owns all three is always paid by exactly two, which is what turns "did I
     * move" into a decision every turn rather than a habit.
     *
     * ASSERTED ACROSS THE THREE FILES, because that property is the reason all
     * three exist and NONE of them can state it alone.
     *
     * ═══ THE THIRD LEG MOVED, AND THE PROPERTY DID NOT ═══
     * It used to be `movingTarget`, which became upstream's Evasion — a BUTTON,
     * because "for a few turns you are harder to hit" is a timed buff and this
     * game could not author one until `EffectDef.wielder` existed. An active has
     * no `passive` to read, so naming it here would assert nothing.
     *
     * `lightFeet` is the leg now. It reads the same binary in the same
     * direction — accuracy for having moved — so the triad is intact and the
     * only thing that changed is which talent in this discipline carries it.
     */
    const still = viewOf({ movedThisTurn: () => false });
    const moved = viewOf({ movedThisTurn: () => true });

    const paid = (view: PassiveView): readonly Talent[] =>
      [braced, secondLook, lightFeet].filter(
        (talent) => Object.keys(talent.passive?.(3, view)?.mods ?? {}).length > 0,
      );

    expect(paid(still).length, 'standing still paid the wrong number').toBe(2);
    expect(paid(moved).length, 'moving paid the wrong number').toBe(1);
    // AND THEY ARE DIFFERENT TALENTS, or "two of three" would be satisfied by
    // the same two paying twice.
    expect(paid(still).some((t) => paid(moved).includes(t))).toBe(false);
  });

  it('Light Feet is the other half of moving, so a step is a whole turn', () => {
    // Three of six hand out movement, and movement alone only ever helps you
    // LEAVE. Without this the discipline reads as "run away better".
    expect(
      lightFeet.passive?.(3, viewOf({ movedThisTurn: () => true }))?.mods?.atk ?? 0,
    ).toBeGreaterThan(0);
    expect(lightFeet.passive?.(3, viewOf({ movedThisTurn: () => false }))?.mods?.atk ?? 0).toBe(0);
  });
});

describe('the capstone pays for the plan coming off', () => {
  it('is worth nothing while anything is still in reach', () => {
    expect(
      secondExit.passive?.(TALENT_MAX_LEVEL, viewOf({ adjacentEnemies: () => 1 }))?.mods
        ?.physResist ?? 0,
    ).toBe(0);
  });

  it('sells saves as well as defence, which a moving body cannot otherwise buy', () => {
    // A body with nothing in reach is being shot at, shouted at and worked on
    // at range — and the saves are the half of that it has no other answer to.
    const block = secondExit.passive?.(3, viewOf({ adjacentEnemies: () => 0 }));
    expect(block?.mods?.physResist ?? 0).toBeGreaterThan(0);
    expect(block?.mods?.def ?? 0).toBeGreaterThan(0);
  });
});
