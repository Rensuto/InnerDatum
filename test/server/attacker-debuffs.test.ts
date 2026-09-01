// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/modules/tome/data/damage_types.lua:48 (setDefaultProjector)
//                       and its :146-160 block (dazed, stunned, numbed)
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

import { describe, expect, it } from 'vitest';

import { DamageType, applyDamage } from '../../src/server/engine/damage.ts';
import { OFF_BALANCE_NUMBED } from '../../src/server/content/effects.ts';
import { scriptedRng } from '../helpers/scripted-rng.ts';
import type { DamageSource, DamageTarget } from '../../src/server/engine/damage.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A STUNNED CASTER'S TALENT DEALT FULL DAMAGE. A STUNNED SWING DEALT 40%.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Upstream applies the attacker's Dazed (×0.5), Stunned (×0.4) and `numbed`
 * (−n%) inside `setDefaultProjector` — the ONE function every damage type
 * routes through, so a bolt, a bleed, a talent and a swing are penalised
 * identically without any of them knowing about it.
 *
 * Ours made it a per-caller responsibility, and the four callers had drifted
 * into four different subsets:
 *
 *   engine/combat.ts      swing      dazed + stunned + numbed
 *   content/effects.ts    bleed      dazed + stunned
 *   engine/talents.ts     talent     none
 *   engine/projectile.ts  bolt       none, and a source with no sheet at all
 *
 * So the same stunned body dealt 40% with a truncheon and 100% with a talent,
 * in the same turn. Off-balance — shipped hours earlier — reached exactly one
 * of the four.
 *
 * `applyDamage` is our `setDefaultProjector`: all four paths call it and
 * nothing else calls `resolveDamage`. The rule lives there now.
 */

const target = (): DamageTarget => ({ hp: 1000, alive: true });

/** A source whose sheet says it is impaired. */
function impaired(over: { dazed?: boolean; stunned?: boolean; numbed?: number }): DamageSource {
  return {
    id: 'attacker',
    combat: {
      flags: { dazed: over.dazed, stunned: over.stunned },
      mods: { numbed: over.numbed },
    },
  };
}

const dealt = (source: DamageSource): number =>
  applyDamage(target(), 100, DamageType.Physical, source, scriptedRng([]), {}).raw;

describe('the attacker`s own state reaches the blow, whatever kind of blow it is', () => {
  it('a clear attacker deals full damage', () => {
    expect(dealt({ id: 'attacker' })).toBeCloseTo(100, 10);
    expect(dealt(impaired({}))).toBeCloseTo(100, 10);
  });

  it('Stunned is ×0.4 — damage_types.lua:150-153', () => {
    expect(dealt(impaired({ stunned: true }))).toBeCloseTo(40, 10);
  });

  it('Dazed is ×0.5 — damage_types.lua:146-148', () => {
    expect(dealt(impaired({ dazed: true }))).toBeCloseTo(50, 10);
  });

  it('`numbed` takes its percentage off — damage_types.lua:158-160', () => {
    expect(dealt(impaired({ numbed: OFF_BALANCE_NUMBED }))).toBeCloseTo(85, 10);
  });

  it('and all three COMPOUND, in upstream`s order', () => {
    // Each is applied in turn to the running total: 100 × 0.5 × 0.4 × 0.85.
    // Additive stacking would floor at zero and make an off-balance stun a
    // total silence rather than a heavy penalty.
    expect(dealt(impaired({ dazed: true, stunned: true, numbed: OFF_BALANCE_NUMBED }))).toBeCloseTo(
      17,
      10,
    );
  });

  it('reads them off the SOURCE and never off the target', () => {
    /**
     * The direction is the whole rule and it is easy to invert: these weaken
     * what you DEAL, not what you take. A version reading the target's sheet
     * would make stunning something a way of protecting it.
     */
    const stunnedVictim: DamageTarget = {
      hp: 1000,
      alive: true,
      combat: { profile: {}, stats: {} },
    };
    const out = applyDamage(
      stunnedVictim,
      100,
      DamageType.Physical,
      { id: 'clear' },
      scriptedRng([]),
      {},
    );
    expect(out.raw).toBeCloseTo(100, 10);
  });

  it('a source with no sheet at all behaves exactly as it always did', () => {
    // Every fixture in the suite passes `{ id }`, and the projectile path still
    // does — `DamageSource.combat` is optional for that reason.
    expect(dealt({ id: 'bare' })).toBeCloseTo(100, 10);
  });

  it('an EXPLICIT spec value still wins over the sheet', () => {
    /**
     * The projectile carries its shooter's state frozen at launch, because
     * `ProjectileWorld` is narrowed to `level`/`actorAt`/`rng` and the flight
     * cannot reach back to the body. So a caller that knows better must be able
     * to say so, and `applyDamage` defers to it.
     */
    const out = applyDamage(
      target(),
      100,
      DamageType.Physical,
      { id: 'clear-sheet', combat: { flags: {}, mods: {} } },
      scriptedRng([]),
      { sourceStunned: true },
    );
    expect(out.raw).toBeCloseTo(40, 10);
  });
});

describe('every damage path goes through the one door', () => {
  it('nothing but applyDamage calls resolveDamage', async () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE PROPERTY THAT MAKES THE RULE UNIVERSAL RATHER THAN FOURFOLD.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * Putting the debuffs inside `applyDamage` only fixes every path for as
     * long as every path calls it. A fifth damage site that reached for
     * `resolveDamage` instead would silently be unpenalised — which is exactly
     * how the four drifted apart in the first place, each remembering a
     * different subset.
     *
     * A SOURCE GUARD, because there is no runtime seam to assert on: both
     * functions are plain exports and the call sites are spread across four
     * modules.
     */
    const { readFileSync, readdirSync } = await import('node:fs');
    const dir = new URL('../../src/server/engine/', import.meta.url);
    const offenders: string[] = [];
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.ts') || name === 'damage.ts') continue;
      const text = readFileSync(new URL(name, dir), 'utf8');
      if (text.includes('resolveDamage(')) offenders.push(name);
    }
    expect(
      offenders,
      'a damage path bypassed applyDamage — it will not be penalised by the attacker`s state',
    ).toEqual([]);
  });
});
