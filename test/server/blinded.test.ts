import { describe, expect, it } from 'vitest';

import { BLINDED, EffectId } from '../../src/server/content/effects.ts';
import { INDEX_INQUISITOR, MONSTER_TEMPLATES } from '../../src/server/content/monsters.ts';
import { EGOS } from '../../src/server/content/egos.ts';
import { sightRadiusOf } from '../../src/server/engine/derived.ts';
import { IMMUNITY_KEYS } from '../../src/shared/immunity.ts';
import { DEFAULT_SIGHT_RADIUS } from '../../src/shared/sight.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * BLINDED — `physical.lua:640-663`, and it is one attribute with no logic.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ```lua
 * activate = function(self, eff) eff.tmpid = self:addTemporaryValue("blind", 1) end,
 * ```
 *
 * Everything frightening about it is at the READER — `Actor.lua:6771-6773` is a
 * flat `if self:attr("blind") then return false, 0` inside `canSeeNoCache`.
 * Ours has no `attr` table, so the status spends `mods.sight`, which is the
 * channel `sightRadiusOf` already reads for a talent and an ego. The tests below
 * are about that substitution holding.
 */

/**
 * A sheet with the status folded on, built from the DEFINITION rather than from
 * a literal — so a def that stopped declaring the flag fails here rather than
 * quietly testing a hand-written `{ blind: true }`.
 */
const blindSheet = (
  sight = 0,
): { readonly mods: { readonly sight: number }; readonly flags: { readonly blind: boolean } } => ({
  mods: { sight },
  flags: { blind: BLINDED.modifiers?.blind === true },
});

describe('the status takes sight to the floor and no further', () => {
  it('leaves a blinded body groping at its own feet, not standing in nothing', () => {
    /**
     * ═══ UPSTREAM RETURNS FALSE FOR EVERYTHING AND WE CANNOT ═══
     * `canSeeNoCache` refuses your own tile too, and gets away with it because
     * `game.player` is drawn unconditionally. `projectActors` has no such
     * exemption — a viewer who cannot see themselves loses their own body off
     * their own screen.
     *
     * `sightRadiusOf`'s `Math.max(1, ...)` is the floor, and its docblock called
     * this exact case before the status existed: *"A blinding effect that drove
     * this negative should leave you groping at your own feet, not erase the
     * floor."*
     */
    expect(sightRadiusOf({ combat: blindSheet() })).toBe(1);
  });

  it('is the WHOLE default, so no bonus survives it', () => {
    // A Keen-Sighted ego is +1 and Overseer of Nations more. A penalty that only
    // matched the base would leave a kitted body seeing past its own blindness,
    // which is the shape of bug that never shows up in a fixture with no gear.
    expect(sightRadiusOf({ combat: blindSheet(1) })).toBe(1);
    expect(sightRadiusOf({ combat: blindSheet(5) })).toBe(1);
    // AND THE BONUS IS REAL WITHOUT THE FLAG, or the two assertions above are
    // satisfied by a `sight` mod that never did anything.
    expect(sightRadiusOf({ combat: { mods: { sight: 5 } } })).toBe(DEFAULT_SIGHT_RADIUS + 5);
  });

  it('and an unblinded body is untouched', () => {
    // The control. Without it every assertion above is satisfied by a
    // `sightRadiusOf` that returns 1 for everybody.
    expect(sightRadiusOf({ combat: { mods: {} } })).toBe(DEFAULT_SIGHT_RADIUS);
  });
});

describe('something in the game can actually do it', () => {
  it('the High Inquisitor blinds, at upstream’s quarter and three turns', () => {
    /**
     * `cursed/darkness.lua:399-401` — `rng.percent(25)` then `canBe("blind")`
     * then `setEffect(EFF_BLINDED, 3, ...)`. A status with no source is the
     * dead-guard failure this project keeps finding; this is the source.
     */
    expect(INDEX_INQUISITOR.onHit?.effectId).toBe(EffectId.Blinded);
    expect(INDEX_INQUISITOR.onHit?.chance).toBe(25);
    expect(INDEX_INQUISITOR.onHit?.turns).toBe(3);
  });

  it('and exactly one creature has it, so the roster still means something', () => {
    const blinders = MONSTER_TEMPLATES.filter((t) => t.onHit?.effectId === EffectId.Blinded);
    expect(blinders.map((t) => t.id)).toEqual(['index_inquisitor']);
  });
});

describe('and something can be worn against it', () => {
  it('the ninth immunity key has an ego granting it', () => {
    /**
     * `immunity.ts`' own rule, stated when the EIGHTH landed: a subtype with no
     * ego pointed at it is a channel with nothing in it, which is the failure
     * the whole list was written to end. The key and the affix ship together.
     */
    expect(IMMUNITY_KEYS).toContain('blind');
    const granting = EGOS.filter((ego) => ego.grants.immunities?.blind !== undefined);
    expect(granting.map((ego) => ego.code)).toEqual(['cg']);
  });

  it('buys one thing, unlike its neighbour', () => {
    // `confusion` also scales the landed instance (mental.lua:78). Blindness has
    // no power to scale — upstream's whole effect is a flag — so this is the
    // ordinary shape and confusion is the exception. Said here because the two
    // sit on the identical grid and would otherwise look identically priced.
    expect(BLINDED.parameters?.power).toBeUndefined();
    expect(BLINDED.subtypes).toEqual(['blind']);
  });
});
