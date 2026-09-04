import { describe, expect, it } from 'vitest';

import { EffectId, createMvpEffectState } from '../../src/server/content/effects.ts';
import { createPlayerActor } from '../../src/server/engine/actor.ts';
import { setEffect, timedEffects } from '../../src/server/engine/effects.ts';
import type { EffectActor, EffectCtx, StatusHit } from '../../src/server/engine/effects.ts';
import { createRng } from '../../src/shared/rng.ts';
import { scriptedRng } from '../helpers/scripted-rng.ts';
import { regenerationInfusion } from '../../src/server/talents/regeneration_infusion.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE REGENERATION INFUSION — inscriptions.lua:66-80, human.lua:53.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * TWO LAYERS AND THE JOIN BETWEEN THEM, because that join is where this kind of
 * feature actually breaks. The talent divides a total across a duration and the
 * effect multiplies it back out over the turns; either half can be individually
 * correct while the product is wrong, and only pressing the button and counting
 * the hit points catches that.
 */

function body(over: Partial<EffectActor> = {}): EffectActor {
  const base = createPlayerActor('p1', { name: 'Dalt', sprite: 'pc_detective_s', x: 1, y: 1 });
  return Object.assign(base, over);
}

/** The talent's `onUse`, with only the seam it actually touches. */
function pressIt(): { readonly turns: number; readonly power: number } {
  let turns = 0;
  let power = 0;
  const ctx = {
    talentLevel: 1,
    status: (_t: unknown, id: string, dur: number, params: { power?: number }) => {
      expect(id).toBe(EffectId.Regeneration);
      turns = dur;
      power = Number(params.power ?? 0);
      return { outcome: 'applied' };
    },
  } as unknown as Parameters<NonNullable<typeof regenerationInfusion.onUse>>[0];
  const self = { id: 'p1', name: 'Dalt' } as unknown as Parameters<
    NonNullable<typeof regenerationInfusion.onUse>
  >[1];
  regenerationInfusion.onUse?.(ctx, self, { x: 0, y: 0 });
  return { turns, power };
}

describe('the regeneration infusion asks for sixty life, spread', () => {
  /**
   * ═══ THE TOTAL IS THE TUNED NUMBER, THE PER-TURN IS DERIVED ═══
   * `power = (heal + inc_stat) / dur` (inscriptions.lua:74) with `heal = 60`
   * (human.lua:53). This multiplies the division back out, so it fails if the
   * talent ever authors the per-turn number directly and lets the two drift —
   * which is the whole reason that file derives it.
   */
  it('divides the sixty across the duration it asks for', () => {
    const { turns, power } = pressIt();
    expect(power * turns).toBe(60);
  });

  /**
   * FIVE ToME ACTIONS ARE THREE OF OUR TURNS — `ceil(5 / 2)`, through the one
   * converter. Pinned separately from the product above because "60 total" and
   * "over three turns" are two different claims and a single assertion on their
   * product would pass for 30 over two.
   */
  it('runs for three turns, which is five upstream actions converted', () => {
    expect(pressIt().turns).toBe(3);
  });

  /**
   * ═══ IT COSTS AN ACTION, AND THAT IS THE POINT OF IT ═══
   * Upstream gives `no_energy = true` to Healing and Wild and withholds it here
   * (inscriptions.lua:104, :137, and its absence at :66-80). A 0 would make this
   * strictly better than the healing infusion in every situation.
   */
  it('costs an action, unlike the other two infusions', () => {
    expect(regenerationInfusion.cost.ap).toBe(3);
  });
});

describe('the regeneration effect puts the hit points back', () => {
  it('restores the whole sixty, and not a point more', () => {
    const state = createMvpEffectState();
    const target = body({ hp: 20, maxHp: 200 });
    const { turns, power } = pressIt();
    setEffect(state, target, EffectId.Regeneration, turns, { power }, scriptedRng([]));

    const rng = createRng('regen-total');
    for (let i = 0; i < turns; i += 1) timedEffects(state, target, rng);
    expect(target.hp).toBe(80);

    // …and it is SPENT. Two more turns of ticking add nothing, which is what
    // `decrease: 1` buys and what a `decrease: 0` typo would silently lose.
    for (let i = 0; i < 2; i += 1) timedEffects(state, target, rng);
    expect(target.hp).toBe(80);
  });

  /**
   * ═══ CLAMPED AT THE CEILING, THROUGH `healActor` ═══
   * The pool tops out and the overflow is discarded rather than banked. Worth
   * pinning because the tick adds to `hp` every turn and an unclamped version
   * would read as working right up until somebody regenerated past full.
   */
  it('stops at full and does not overfill', () => {
    const state = createMvpEffectState();
    const target = body({ hp: 95, maxHp: 100 });
    const { turns, power } = pressIt();
    setEffect(state, target, EffectId.Regeneration, turns, { power }, scriptedRng([]));

    const rng = createRng('regen-cap');
    for (let i = 0; i < turns; i += 1) timedEffects(state, target, rng);
    expect(target.hp).toBe(100);
  });
});

describe('the tick says what it did', () => {
  function hitsFrom(target: EffectActor, turns: number, power: number): readonly StatusHit[] {
    const state = createMvpEffectState();
    setEffect(state, target, EffectId.Regeneration, turns, { power }, scriptedRng([]));
    const seen: StatusHit[] = [];
    const ctx: EffectCtx = {
      noteDamage: (hit: StatusHit): void => {
        seen.push(hit);
      },
    };
    const rng = createRng('regen-report');
    for (let i = 0; i < turns; i += 1) timedEffects(state, target, rng, ctx);
    return seen;
  }

  /**
   * ═══ AS A HEAL, NOT AS DAMAGE ═══
   * `DamageEvent.healed` states the contract — "when it is set, `amount` is 0" —
   * and its docblock records what happened the last time a mapper dropped it:
   * the Case Log printed "Ren hits Ren. / 0 damage." for the party's only heal
   * and the struck-tile marker was stamped on every healed ally. This is the
   * assertion that stops that arriving a second time from the status pump.
   */
  it('reports every point as healed, with no damage claimed', () => {
    const { turns, power } = pressIt();
    const hits = hitsFrom(body({ hp: 20, maxHp: 200 }), turns, power);

    expect(hits).toHaveLength(turns);
    expect(hits.map((hit) => hit.healed)).toEqual([power, power, power]);
    expect(hits.every((hit) => hit.amount === 0)).toBe(true);
    expect(hits.every((hit) => !hit.killed)).toBe(true);
  });

  /**
   * NOTHING RESTORED IS NOTHING TO SAY. A body at full health takes the effect
   * (nothing refuses a beneficial one) and the tick simply stays quiet, rather
   * than filing "+0" three times into a transcript people read.
   */
  it('says nothing at all when there was nothing to heal', () => {
    const { turns, power } = pressIt();
    expect(hitsFrom(body({ hp: 100, maxHp: 100 }), turns, power)).toEqual([]);
  });
});
