// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/modules/tome/data/birth/descriptors.lua:63 (resists_cap {all=70})
//                       game/modules/tome/class/Actor.lua:211 (the engine default of 100)
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { CLASSES, PLAYER_RESIST_CAP, playerCombat } from '../../src/server/content/classes.ts';
import { DEFAULT_RESIST_CAP, combatGetResist } from '../../src/server/engine/damage.ts';
import { composeWielders } from '../../src/server/engine/equipment.ts';
import { DamageType } from '../../src/shared/damagetype.ts';
import type { ClassDef } from '../../src/server/content/classes.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A PLAYER CAPS AT 70 AND A MONSTER AT 100, AND WE CAPPED EVERYTHING AT 100.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `Actor.lua:211` gives every body `resists_cap = { all = 100 }`; the PLAYER
 * birth descriptor overrides it to 70 (descriptors.lua:63).
 *
 * `DEFAULT_RESIST_CAP`'s docblock has recorded that distinction since it was
 * written — *"a monster authored with 100 fire resist is genuinely immune and a
 * player with the same number is not"* — and nothing applied the player half.
 *
 * IT ONLY STARTED MATTERING RECENTLY. Until gear could move a resistance there
 * was nothing to cap; four resistance egos and a `Wielder.resists` channel
 * shipped this session, and typed resists ADD across worn items.
 */

const anyClass = (): ClassDef => {
  const definition = CLASSES[0];
  if (definition === undefined) throw new Error('no classes are authored');
  return definition;
};

/** A sheet resisting `pct` of fire, before any cap is applied. */
const resisting = (pct: number) => ({ profile: { resists: { [DamageType.Fire]: pct } } });

describe('the two caps are different numbers', () => {
  it('names upstream`s two values', () => {
    expect(PLAYER_RESIST_CAP).toBe(70);
    expect(DEFAULT_RESIST_CAP).toBe(100);
  });

  it('a monster keeps the engine default', () => {
    // Nothing routes a monster sheet through `playerCombat`, which is the whole
    // distinction: a monster authored at 95% fire really does resist 95%.
    expect(combatGetResist(resisting(95).profile, DamageType.Fire)).toBe(95);
  });

  it('a player is held to 70 however high the number goes', () => {
    const capped = playerCombat(resisting(95));
    expect(combatGetResist(capped.profile ?? {}, DamageType.Fire)).toBe(PLAYER_RESIST_CAP);
  });

  it('and is unaffected below the cap — the common case', () => {
    // The safety property. Every character in the game today is well under 70,
    // so this change must be invisible to all of them.
    const capped = playerCombat(resisting(25));
    expect(combatGetResist(capped.profile ?? {}, DamageType.Fire)).toBe(25);
  });
});

describe('what the cap is and is not applied to', () => {
  it('merges rather than replacing, so a class`s own typed cap survives', () => {
    // `combatGetResist` SUMS `all` with the typed row (Combat.lua:2229), so a
    // class authoring a typed cap is making a statement this must not erase.
    const withTyped = playerCombat({
      profile: { resists: { [DamageType.Fire]: 200 }, resistsCap: { [DamageType.Fire]: 10 } },
    });
    expect(withTyped.profile?.resistsCap?.[DamageType.Fire]).toBe(10);
    expect(combatGetResist(withTyped.profile ?? {}, DamageType.Fire)).toBe(PLAYER_RESIST_CAP + 10);
  });

  it('GEAR CANNOT RAISE IT — the fold carries the cap across untouched', () => {
    /**
     * `composeWielders` says why: *"a cap is what stops the resist formula
     * inverting above 100% (Combat.lua:2227-2228), and letting gear raise its
     * own ceiling would be an item that grants immunity in two affixes rather
     * than one."* This is that promise, asserted from the player's side.
     */
    const worn = composeWielders(playerCombat(resisting(60)), [
      { resists: { [DamageType.Fire]: 15 } },
      { resists: { [DamageType.Fire]: 15 } },
    ]);
    // 60 + 15 + 15 = 90 of raw resistance, held to 70.
    expect(combatGetResist(worn.profile ?? {}, DamageType.Fire)).toBe(PLAYER_RESIST_CAP);
    expect(worn.profile?.resistsCap?.all).toBe(PLAYER_RESIST_CAP);
  });

  it('leaves every other field of the sheet alone', () => {
    const definition = anyClass();
    const before = definition.combat;
    const after = playerCombat(before);
    expect(after.stats).toEqual(before.stats);
    expect(after.mods).toEqual(before.mods);
    // AND DOES NOT MUTATE THE CLASS SHEET, which every body of that class shares
    // — the contamination `composeWielders` exists to prevent.
    expect(before.profile?.resistsCap?.all).toBeUndefined();
  });
});

describe('the wiring', () => {
  it('every player body goes through the one door', () => {
    /**
     * A SOURCE GUARD. `overlayFor` is a closure inside the gateway and every
     * gateway test injects its own engine, so no test can drive the real one —
     * the same reason `sheetForBody` and `spendByPurse` needed extracting.
     *
     * `overlayFor` is upstream's birth descriptor: the single point a class
     * sheet becomes a PLAYER's, whatever class they picked. Authoring the cap on
     * four `ClassDef`s instead would be four copies of one rule and a fifth
     * class that forgets it.
     */
    const gateway = readFileSync(
      new URL('../../src/server/net/gateway.ts', import.meta.url),
      'utf8',
    );
    /**
     * AND THE CAP IS THE OUTERMOST CALL, which now says something it did not
     * have to before origins existed. `combatWithOrigin` adds the origin's
     * `inc_stats` on top of the class sheet, so the argument here is the body
     * that will actually exist; capping first and adding after would cap a body
     * nobody plays and let the additions land outside the cap.
     */
    expect(gateway).toContain('combat: playerCombat(combatWithOrigin(definition.combat, origin))');
  });
});
