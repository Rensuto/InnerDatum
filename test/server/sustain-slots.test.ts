// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

import { describe, expect, it } from 'vitest';

import { createContentTalentEngine } from '../../src/server/content/classes.ts';
import {
  SustainRefusal,
  TalentKind,
  TargetShape,
  Affinity,
  sustainReserve,
  talentDone,
  talentId,
  sustainReserveOf,
  toggleSustain,
} from '../../src/server/engine/talents.ts';
import { DamageType } from '../../src/server/engine/damage.ts';
import type { Talent, TalentSheet } from '../../src/server/engine/talents.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *   A RESERVATION MAKES A STANCE A COST. A SLOT MAKES IT A CHOICE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The reservation half already worked and was already argued: turning a stance
 * on takes its cost off the CEILING for as long as it is up, which is
 * `sustain_positive = 20` on a Chant (celestial/chants.lua:31) and not a drain.
 *
 * What was missing is exclusivity. Upstream has exactly five slots in the whole
 * game and four of them ARE a class's identity — `alchemy_infusion` is why an
 * Alchemist's flask is a mode rather than a modifier, and why `computeDamage`
 * in explosives.lua:44-51 is a five-branch if-chain on which infusion is up.
 * Nine lines upstream (Actor.lua:5922-5931).
 *
 * These tests are mostly about ORDERING, because the two obvious orderings are
 * each wrong in a way that is invisible until a player hits it mid-fight.
 */

const base = {
  classId: null,
  tree: 'test/stances',
  kind: TalentKind.Sustained,
  iconId: 'icon_passive_test',
  cost: { ap: 0 },
  cooldownTurns: 0,
  targeting: {
    shape: TargetShape.Self,
    range: 0,
    minRange: 0,
    radius: 0,
    requiresLos: false,
    affinity: Affinity.Ally,
  },
  damageType: DamageType.Physical,
  describe: (): string => 'a stance',
} as const;

function stance(id: string, reserve: number, slot?: string): Talent {
  return {
    ...base,
    id,
    name: id,
    sustain: { reserve },
    ...(slot === undefined ? {} : { sustainSlot: slot }),
  };
}

function bench(talents: readonly Talent[], max: number) {
  const engine = createContentTalentEngine();
  for (const t of talents) engine.registry.register(t);
  const sheet = {
    classId: 'watchman',
    loadout: [],
    passives: [],
    sustained: new Set<string>(),
    points: new Map(talents.map((t) => [t.id, 1])),
    resource: { kind: 'resolve', value: max, max, min: 0 },
    ap: 6,
    maxAp: 6,
    mp: 6,
    maxMp: 6,
    movedThisTurn: false,
    turnProcs: { once: () => true, seen: () => false, clear: () => undefined },
  } as unknown as TalentSheet;
  return { engine, sheet };
}

describe('a stance priced as a SHARE of the pool', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * A FLAT RESERVE CANNOT BE WRITTEN FOR A TREE ANY CLASS MAY BUY.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * The generic trees cost a category point and land on four classes with four
   * resources, and the pools are NOT comparable: Resolve, Focus and Ink cap at
   * 100 and Reagents caps at EIGHT.
   *
   * So `careful_method`'s twenty is a fifth of an Inspector's Focus and more
   * than an Alchemist owns outright — `raiseSustain` would answer `NoRoom`
   * forever, and the failure is silent in the worst way: a talent bought with a
   * category point that one class in four can see, put on a key, and never
   * switch on.
   */
  function fractional(id: string, fraction: number, slot?: string): Talent {
    return {
      ...base,
      id,
      name: id,
      sustain: { reserveFraction: fraction },
      ...(slot === undefined ? {} : { sustainSlot: slot }),
    };
  }

  it('is raisable on the SMALL pool, which a flat reserve would not be', () => {
    const generic = fractional('talent:generic', 0.1);
    // Eight is `ResourceKind.Reagents` — the Alchemist's whole bag.
    const { engine, sheet } = bench([generic], 8);
    expect(sustainReserveOf(generic, 8)).toBe(1);
    expect(toggleSustain(engine, sheet, generic.id).ok).toBe(true);

    // …and the flat price a class stance uses is impossible on the same pool,
    // which is the whole reason the fraction exists.
    const flat = stance('talent:flat', 20);
    const bad = bench([flat], 8);
    expect(toggleSustain(bad.engine, bad.sheet, flat.id).ok).toBe(false);
  });

  it('reproduces both hand-tuned numbers from one fraction', () => {
    /**
     * A tenth is not a number anybody picked. `loads.ts` reserves ONE Reagent
     * and argues it in writing — "an eighth of the bag ... two would mean a
     * quarter of the class's ammunition". Upstream's Trained Reactions reserves
     * `sustain_stamina = 10` (mobility.lua:289) against a pool of about a
     * hundred. One expression gives both, which is why it is a tenth.
     */
    const generic = fractional('talent:tenth', 0.1);
    expect(sustainReserveOf(generic, 8)).toBe(1);
    expect(sustainReserveOf(generic, 100)).toBe(10);
  });

  it('is REFUSED when its share does not fit, which is what prices it at all', () => {
    /**
     * ═══ THE ASSERTION THAT MAKES THE OTHER TWO MEAN ANYTHING ═══
     * "It can be raised" passes just as well for a stance that costs NOTHING. I
     * wrote this suite without this case first, then reintroduced the bug — the
     * room test reading `sustain.reserve` directly, which is `undefined` for a
     * fractional stance and falls to zero — and every test still passed. A free
     * stance is raisable on any pool.
     *
     * Two whole-pool stances: the first fits exactly, the second cannot.
     */
    const first = fractional('talent:whole_a', 1);
    const second = fractional('talent:whole_b', 1);
    const { engine, sheet } = bench([first, second], 8);
    expect(sustainReserveOf(first, 8)).toBe(8);
    expect(toggleSustain(engine, sheet, first.id).ok).toBe(true);
    expect(toggleSustain(engine, sheet, second.id).ok).toBe(false);
  });

  it('gives its share back when it is DISPLACED, not just when lowered', () => {
    /**
     * THE LEAK THIS CATCHES. `raiseSustain` computed the freed reservation by
     * reading `sustain.reserve` directly, which is `undefined` for a fractional
     * stance — so displacing one would have freed NOTHING, and the swap would be
     * refused for lack of room the outgoing stance was about to release.
     *
     * IT NEEDS A SLOT TO REACH THAT PATH. Displacement is what runs the `freed`
     * loop, and a slotless stance displaces nobody — which is why the first
     * version of this test, written without a slot, passed with the bug in
     * place. Both readers go through `sustainReserveOf` now.
     */
    for (const max of [8, 100]) {
      const cold = fractional('talent:cold_share', 1, 'share');
      const heat = fractional('talent:heat_share', 1, 'share');
      const { engine, sheet } = bench([cold, heat], max);
      expect(toggleSustain(engine, sheet, cold.id).ok, `cold @${String(max)}`).toBe(true);
      // Each takes the WHOLE pool, so this swap is only possible if the outgoing
      // stance's share is counted as freed before the room test runs.
      expect(toggleSustain(engine, sheet, heat.id).ok, `swap @${String(max)}`).toBe(true);
      expect([...sheet.sustained]).toEqual([heat.id]);
      expect(sustainReserve(engine, sheet), `after swap @${String(max)}`).toBe(max);
    }
  });
});

describe('stance slots', () => {
  it('lets two slotless stances stack, which is the common case', () => {
    const a = stance('talent:a', 10);
    const b = stance('talent:b', 10);
    const { engine, sheet } = bench([a, b], 50);

    expect(toggleSustain(engine, sheet, a.id).ok).toBe(true);
    expect(toggleSustain(engine, sheet, b.id).ok).toBe(true);
    expect([...sheet.sustained].sort()).toEqual([a.id, b.id]);
    expect(sustainReserve(engine, sheet)).toBe(20);
  });

  it('displaces the stance holding the same slot rather than refusing', () => {
    const cold = stance('talent:cold', 10, 'infusion');
    const heat = stance('talent:heat', 10, 'infusion');
    const { engine, sheet } = bench([cold, heat], 50);

    expect(toggleSustain(engine, sheet, cold.id).ok).toBe(true);
    const swap = toggleSustain(engine, sheet, heat.id);

    // ═══ NOT A REFUSAL ═══
    // Answering "no" would make changing stance a two-press chore mid-fight for
    // no gain. Upstream displaces; so does this.
    expect(swap.ok, 'the swap was refused instead of displacing').toBe(true);
    expect([...sheet.sustained]).toEqual([heat.id]);
    expect(sustainReserve(engine, sheet), 'the old stance kept its reservation').toBe(10);
  });

  it('swaps two equal stances in a pool that is exactly full', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE FIRST WRONG ORDERING: test for room, THEN displace.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * The displaced stance gives its reservation back, so a swap between two
     * stances of equal weight always fits — even here, where the pool has
     * exactly no headroom left. Testing first refuses the swap that costs
     * nothing, which is the commonest swap there is.
     */
    const cold = stance('talent:cold', 20, 'infusion');
    const heat = stance('talent:heat', 20, 'infusion');
    const { engine, sheet } = bench([cold, heat], 20);

    expect(toggleSustain(engine, sheet, cold.id).ok).toBe(true);
    expect(sheet.resource.max - sustainReserve(engine, sheet), 'the setup left headroom').toBe(0);

    const swap = toggleSustain(engine, sheet, heat.id);
    expect(swap.ok, 'a free swap was refused for want of room').toBe(true);
    expect([...sheet.sustained]).toEqual([heat.id]);
  });

  it('leaves the old stance UP when the new one does not fit', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE SECOND WRONG ORDERING: displace, THEN test for room.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * If the test then fails, the old stance is already down and the new one
     * never went up — a refused press leaves the player with NEITHER, and the
     * only symptom is that their stance quietly vanished. A refusal must change
     * nothing at all.
     */
    const light = stance('talent:light', 5, 'infusion');
    const heavy = stance('talent:heavy', 40, 'infusion');
    const { engine, sheet } = bench([light, heavy], 20);

    expect(toggleSustain(engine, sheet, light.id).ok).toBe(true);
    const refused = toggleSustain(engine, sheet, heavy.id);

    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toBe(SustainRefusal.NoRoom);
    // ═══ THE ASSERTION THAT WAS FAILING ═══
    expect([...sheet.sustained], 'a refused swap put the old stance down').toEqual([light.id]);
    expect(sustainReserve(engine, sheet)).toBe(5);
  });

  it('does not displace a stance in a different slot', () => {
    const infusion = stance('talent:infusion', 10, 'infusion');
    const footing = stance('talent:footing', 10, 'footing');
    const { engine, sheet } = bench([infusion, footing], 50);

    expect(toggleSustain(engine, sheet, infusion.id).ok).toBe(true);
    expect(toggleSustain(engine, sheet, footing.id).ok).toBe(true);
    expect([...sheet.sustained].sort()).toEqual([footing.id, infusion.id]);
  });

  it('still lets a stance be put down, always', () => {
    // Off is never refused — a sustain that could get stuck on would be a
    // reservation the player cannot undo.
    const cold = stance('talent:cold', 10, 'infusion');
    const { engine, sheet } = bench([cold], 10);
    expect(toggleSustain(engine, sheet, cold.id).ok).toBe(true);
    const off = toggleSustain(engine, sheet, cold.id);
    expect(off).toEqual({ ok: true, on: false });
    expect(sustainReserve(engine, sheet)).toBe(0);
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *   "NOT A STANCE" IS NOT A REFUSAL, AND CONFLATING THEM BROKE THE GAME.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The gateway asks `toggleSustain` about EVERY talent frame before it reaches
 * `submitTalent`, because a stance and a cast arrive on the same key. Its
 * contract is `undefined` for "not mine, carry on" and `null` for "mine, and
 * no".
 *
 * `SustainRefusal.Unknown` used to cover BOTH "this is not a stance" and "you
 * have not learned this stance", so the adapter in main.ts mapped every
 * non-stance to `null`. Pressing Crude Blow was answered by the STANCE seam
 * with *"that stance cannot go up — there is not enough room in the pool"*,
 * which the client renders as *"not your turn yet — the clock has not asked
 * you"*. NO ACTIVE TALENT IN THE GAME COULD BE USED.
 *
 * Nothing failed anywhere. Every test passed, the gate was green, the deploy
 * was healthy, and the hotbar was inert — reported from a live session with a
 * screenshot.
 */
describe('a cast is not a stance', () => {
  it('says NotASustain for a talent that is not one, not Unknown', () => {
    const active: Talent = {
      id: talentId('plain_active'),
      name: 'Plain Active',
      classId: null,
      tree: 'watch/discipline',
      kind: TalentKind.Active,
      iconId: 'icon_active_plain',
      cost: { ap: 1 },
      cooldownTurns: 0,
      targeting: {
        shape: TargetShape.Single,
        range: 1.5,
        minRange: 0,
        radius: 0,
        requiresLos: true,
        affinity: Affinity.Hostile,
      },
      damageType: DamageType.Physical,
      onUse: () => talentDone([]),
      describe: () => 'a plain active',
    };
    const { engine, sheet } = bench([active], 50);

    const answer = toggleSustain(engine, sheet, active.id);
    expect(answer.ok).toBe(false);
    if (answer.ok) return;
    /**
     * THE ASSERTION THE OUTAGE TURNS ON. `Unknown` here and the adapter answers
     * the gateway `null`, which means "it is a stance and it cannot go up" —
     * and the cast never happens.
     */
    expect(answer.reason).toBe(SustainRefusal.NotASustain);
  });

  it('still says Unknown for a stance nobody has learned', () => {
    const unlearned = stance('talent:unlearned', 10);
    const { engine, sheet } = bench([unlearned], 50);
    // Owned but never bought: rank 0, which is what `birthTalents` made possible.
    sheet.points.set(unlearned.id, 0);

    const answer = toggleSustain(engine, sheet, unlearned.id);
    expect(answer.ok).toBe(false);
    if (answer.ok) return;
    // A RULE SAYING NO, and the player should be told — so NOT `NotASustain`.
    expect(answer.reason).toBe(SustainRefusal.Unknown);
  });

  it('still toggles a stance the body has learned', () => {
    const learned = stance('talent:learned', 10);
    const { engine, sheet } = bench([learned], 50);
    expect(toggleSustain(engine, sheet, learned.id)).toEqual({ ok: true, on: true });
  });
});
