// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/modules/tome/data/timed_effects/physical.lua:650 (BLINDED, `blind`)
//             t-engine4 game/modules/tome/data/timed_effects/physical.lua:993 (PINNED, `never_move`)
//             t-engine4 game/modules/tome/data/timed_effects/other.lua:1582 (HIGHBORN_S_BLOOM)
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" — https://te4.org/license

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * EVERY FLAG A STATUS DECLARES REACHES THE SHEET THE ENGINE READS.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `effectModifiers` composes the live effects and `recomputeAttributes` writes
 * the answer onto `combat.flags`. The composer never collected `blind`, `pinned`
 * or `freeResources`, so Blinded, Pinned and Highborn's Bloom landed on bodies
 * and did nothing, and every test of the three set the flag by hand.
 *
 * So this is a SWEEP over the catalogue rather than three cases: every boolean
 * modifier on every registered status is applied through `setEffect`, the
 * door the game uses, and read back off the body. A fourth flag added to a
 * definition and not to the composer fails here without anyone remembering to
 * write its test.
 */

import { describe, expect, it } from 'vitest';

import { EffectId, MVP_EFFECTS, createMvpEffectState } from '../../src/server/content/effects.ts';
import { AiProfile, createMonsterActor } from '../../src/server/engine/actor.ts';
import { sightRadiusOf } from '../../src/server/engine/derived.ts';
import type { StatusFlags } from '../../src/server/engine/derived.ts';
import {
  effectModifiers,
  noTalentsCooldown,
  removeEffect,
  setEffect,
} from '../../src/server/engine/effects.ts';
import type { EffectModifiers } from '../../src/server/engine/effects.ts';
import { DEFAULT_SIGHT_RADIUS } from '../../src/shared/sight.ts';
import { scriptedRng } from '../helpers/scripted-rng.ts';

/**
 * WHERE EACH BOOLEAN MODIFIER IS READ. All but one land on `StatusFlags` under
 * their own name; `noTalentsCooldown` is asked of the state directly
 * (`noTalentsCooldown`, `tome/class/Actor.lua:606`) and has no flag.
 */
const FLAG_OF: Readonly<Record<string, keyof StatusFlags | null>> = {
  stunned: 'stunned',
  blind: 'blind',
  pinned: 'pinned',
  dazed: 'dazed',
  scoured: 'scoured',
  breached: 'breached',
  freeResources: 'freeResources',
  noTalentsCooldown: null,
};

function body(id: string) {
  return createMonsterActor(id, {
    name: 'Index Husk',
    sprite: 'enemy_index_husk_s',
    x: 5,
    y: 5,
    profile: AiProfile.MeleeChaser,
  });
}

/** Every `true` modifier in the catalogue, as `[effect id, modifier key]`. */
const DECLARED: readonly (readonly [string, keyof EffectModifiers])[] = MVP_EFFECTS.flatMap((def) =>
  Object.entries(def.modifiers ?? {})
    .filter(([, value]) => value === true)
    .map(([key]) => [def.id, key as keyof EffectModifiers] as const),
);

describe('a status flag reaches the body it lands on', () => {
  it('the sweep reaches the three that were inert, and the stun it was built beside', () => {
    // Precondition: a catalogue in which none of these declared a flag would
    // pass every case below by having nothing to check.
    const pairs = DECLARED.map(([id, key]) => `${id}/${key}`);
    expect(pairs).toEqual(
      expect.arrayContaining([
        `${EffectId.Blinded}/blind`,
        `${EffectId.Pinned}/pinned`,
        `${EffectId.HighbornsBloom}/freeResources`,
        `${EffectId.Stunned}/stunned`,
        `${EffectId.Stunned}/noTalentsCooldown`,
      ]),
    );
  });

  it.each(DECLARED.map(([id, key]) => [`${id}/${key}`, id, key] as const))(
    '%s: on while the status is, off once it is gone',
    (_label, effectId, key) => {
      const flag = FLAG_OF[key];
      if (flag === undefined)
        throw new Error(`${key} has no reader in FLAG_OF — say where it lands`);
      const state = createMvpEffectState();
      const target = body(`flag-${effectId}-${key}`);
      // No `applyPower`, so no save is rolled and an empty script is enough.
      const landed = setEffect(state, target, effectId, 3, {}, scriptedRng([]));
      expect(landed.dur, 'the status did not land').toBeGreaterThan(0);

      expect(effectModifiers(state, target.id)[key], 'the composer dropped it').toBe(true);
      if (flag === null) {
        expect(noTalentsCooldown(state, target.id)).toBe(true);
      } else {
        expect(target.combat?.flags?.[flag], `combat.flags.${flag} after ${effectId}`).toBe(true);
      }

      removeEffect(state, target, effectId, scriptedRng([]));
      if (flag === null) {
        expect(noTalentsCooldown(state, target.id)).toBe(false);
      } else {
        expect(target.combat?.flags?.[flag], `combat.flags.${flag} outlived ${effectId}`).toBe(
          false,
        );
      }
    },
  );

  it('BLINDED, through the door and into the reader: sight drops to the floor and comes back', () => {
    /**
     * THE JOIN `blinded.test.ts` does not make. That file builds the sheet from
     * the definition by hand, which is exactly the half that was right.
     */
    const state = createMvpEffectState();
    const target = body('blind-reader');
    expect(sightRadiusOf(target)).toBe(DEFAULT_SIGHT_RADIUS);
    setEffect(state, target, EffectId.Blinded, 3, {}, scriptedRng([]));
    expect(sightRadiusOf(target)).toBe(1);
    removeEffect(state, target, EffectId.Blinded, scriptedRng([]));
    expect(sightRadiusOf(target)).toBe(DEFAULT_SIGHT_RADIUS);
  });
});
