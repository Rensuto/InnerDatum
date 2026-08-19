import { describe, expect, it } from 'vitest';

import {
  CHECKED_EGOS,
  EGOS,
  EGO_CATALOGUE,
  EGO_FORBIDDEN_MOD_KEYS,
  EgoSlotTag,
  MIN_STAT_FLOOR,
  egoByCode,
  egoWielder,
  egosForTag,
  grantValue,
  tierWeight,
  validateEgos,
} from '../../src/server/content/egos.ts';
import { ITEMS, SLOT_ORDER } from '../../src/server/content/items.ts';
import { EGO_CODE_LENGTH } from '../../src/server/content/resolve.ts';
import type { Ego } from '../../src/server/content/egos.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *       THE EGO ROSTER, AND THE ONE FIELD THAT CAN NEVER BE RENAMED
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * An ego's `code` is written into an item id, which is written into a save file
 * on a machine in somebody's house. Renaming one does not break a build — it
 * silently re-points every item in every save at a different ego, or at none.
 * So the codes are pinned here by literal, and changing one is meant to be a
 * conversation rather than a rename.
 */

/** A valid row to mutate one field of at a time. */
const SOUND: Ego = {
  code: 'aa',
  name: 'Sound ',
  tag: EgoSlotTag.Prefix,
  rarity: 5,
  levelRange: [1, 50],
  grants: { mods: { armour: { floor: 1, step: 1 } } },
  cost: 10,
};

describe('the ego roster', () => {
  it('runs its check at import, and the result is EGOS by identity', () => {
    expect(CHECKED_EGOS).toBe(EGOS);
    expect(EGO_CATALOGUE.size).toBe(EGOS.length);
  });

  it('pins every code that exists — these are save-file keys, not names', () => {
    expect(EGOS.map((ego) => ego.code)).toEqual(['rf', 'ol', 'wt', 'wd', 'lg', 'lw', 'qh', 'cr']);
  });

  it('has both tags populated, because an item has two slots to fill', () => {
    // A roster with no suffixes would make `double_ego` unreachable and the
    // quality table would silently degrade to "one ego or none".
    expect(egosForTag(EgoSlotTag.Prefix).length).toBeGreaterThan(0);
    expect(egosForTag(EgoSlotTag.Suffix).length).toBeGreaterThan(0);
    expect(egosForTag(EgoSlotTag.Prefix).length + egosForTag(EgoSlotTag.Suffix).length).toBe(
      EGOS.length,
    );
  });

  it('names only slots that exist', () => {
    // A typo here is an ego that can roll and can never land, which presents as
    // loot that is quietly plainer than the tables say it should be.
    const known = new Set(SLOT_ORDER);
    for (const ego of EGOS) {
      for (const slot of ego.slots ?? []) expect(known.has(slot)).toBe(true);
    }
  });

  it('restricts no ego to a slot no item can fill', () => {
    // The other half of the same failure: `slots: [Slot.Legs]` on a roster with
    // no legs item would be an ego that exists and never appears.
    for (const ego of EGOS) {
      if (ego.slots === undefined) continue;
      // `item.slot !== undefined` because the catalogue holds draughts now, and
      // a thing with no slot is not evidence that an ego has nowhere to go.
      const wearable = ITEMS.some(
        (item) => item.slot !== undefined && ego.slots?.includes(item.slot) === true,
      );
      expect(wearable).toBe(true);
    }
  });

  it('looks up by code and misses cleanly', () => {
    expect(egoByCode('rf')?.name).toBe('Reinforced ');
    expect(egoByCode('zz')).toBeUndefined();
    for (const ego of EGOS) expect(ego.code.length).toBe(EGO_CODE_LENGTH);
  });
});

describe('grant magnitude', () => {
  it('is the tier, and the tier is 1..3', () => {
    expect(tierWeight('common')).toBe(1);
    expect(tierWeight('uncommon')).toBe(2);
    expect(tierWeight('rare')).toBe(3);
  });

  it('is floor + step × power × tierWeight, and floor is the guaranteed part', () => {
    const grant = { floor: 2, step: 3 };
    expect(grantValue(grant, 0, 'common')).toBe(2);
    expect(grantValue(grant, 0, 'rare')).toBe(2);
    expect(grantValue(grant, 1, 'common')).toBe(5);
    expect(grantValue(grant, 3, 'rare')).toBe(2 + 3 * 3 * 3);
  });

  it('produces a wielder with no empty keys on it', () => {
    // `composeSheet` distinguishes an absent `stats` from an empty one, and a
    // round-trip test compares the two — see equipment.ts's note on why.
    const ego = egoByCode('rf');
    if (ego === undefined) throw new Error('unreachable');
    const wielder = egoWielder(ego, 2, 'rare');
    expect(wielder.stats).toBeUndefined();
    expect(wielder.mods).toEqual({ armour: 1 + 1 * 2 * 3, armourHardiness: 2 + 1 * 2 * 3 });
  });
});

/**
 * The import-time check, aimed at fixtures. Each of these is a content mistake
 * somebody actually makes, and each one is silent without the throw.
 */
describe('validateEgos', () => {
  it('accepts a sound row', () => {
    expect(() => validateEgos([SOUND])).not.toThrow();
  });

  it('refuses a code that is not two characters of [a-z0-9]', () => {
    expect(() => validateEgos([{ ...SOUND, code: 'a' }])).toThrow(/two characters/);
    expect(() => validateEgos([{ ...SOUND, code: 'abc' }])).toThrow(/two characters/);
    expect(() => validateEgos([{ ...SOUND, code: 'A1' }])).toThrow(/two characters/);
    expect(() => validateEgos([{ ...SOUND, code: 'a-' }])).toThrow(/two characters/);
  });

  it('refuses a duplicate code', () => {
    // The loser shadows in the catalogue and becomes an ego that can roll and
    // can never resolve — every item carrying it turns into "not an item this
    // build knows" on the next load.
    expect(() => validateEgos([SOUND, { ...SOUND, name: 'Other ' }])).toThrow(/duplicate code/);
  });

  it('refuses a prefix with no trailing space and a suffix with no leading one', () => {
    // The failure is `ReinforcedWatchman's Coat` and NOTHING ELSE GOES WRONG,
    // which is exactly why it needs a throw rather than a review.
    expect(() => validateEgos([{ ...SOUND, name: 'Sound' }])).toThrow(/trailing space/);
    expect(() => validateEgos([{ ...SOUND, tag: EgoSlotTag.Suffix, name: 'of Sound' }])).toThrow(
      /leading space/,
    );
  });

  it('refuses a primary-stat grant whose floor can be rescaled away', () => {
    // `rescaleCombatStats` floors, so a +1 or +2 primary can rescale to the same
    // integer and move nothing a player can see — an ego that lies.
    expect(() =>
      validateEgos([
        { ...SOUND, grants: { stats: { str: { floor: MIN_STAT_FLOOR - 1, step: 1 } } } },
      ]),
    ).toThrow(/floor/);
    expect(() =>
      validateEgos([{ ...SOUND, grants: { stats: { str: { floor: MIN_STAT_FLOOR, step: 1 } } } }]),
    ).not.toThrow();
  });

  it('refuses a fractional magnitude at any power or tier', () => {
    // A step of 0.5 is exact at even powers and fractional at odd ones, so
    // checking the terms rather than the corners would let it through — and one
    // fractional value turns equipment.ts's 5040-permutation commutativity
    // proof into a proof about one ordering.
    expect(() =>
      validateEgos([{ ...SOUND, grants: { mods: { armour: { floor: 1, step: 0.5 } } } }]),
    ).toThrow(/INTEGER/);
    expect(() =>
      validateEgos([{ ...SOUND, grants: { mods: { armour: { floor: 0.5, step: 1 } } } }]),
    ).toThrow(/INTEGER/);
  });

  it('refuses a floor of zero — a guarantee of nothing is not a guarantee', () => {
    // `resolveItem` writes every key the ego names, so a floor of 0 puts
    // `armour: 0` on the item at power 0: a line on the character sheet, a term
    // in the fold, and no change to any number a player can see. Found by
    // printing sample loot rather than by reading the table.
    expect(() =>
      validateEgos([{ ...SOUND, grants: { mods: { armour: { floor: 0, step: 1 } } } }]),
    ).toThrow(/must be at least 1/);
  });

  it('refuses `damRange`, whose natural unit is a tenth', () => {
    // ALIVE, LEGAL ON AN ITEM, AND STILL WRONG ON AN EGO. It is ADDED to a
    // weapon range that defaults to 1.1 (derived.ts:442-445), so the smallest
    // integer grant this file can express turns a 1.1x damage spread into 2.1x
    // and a power-3 roll into 4.1x. A unit mismatch, not a strong ego — and the
    // fix is not a fractional step, because §1.4 refuses those for the
    // commutativity proof.
    expect(() =>
      validateEgos([{ ...SOUND, grants: { mods: { damRange: { floor: 1, step: 1 } } } }]),
    ).toThrow(/unit mismatch/);
    expect(EGO_FORBIDDEN_MOD_KEYS).toContain('damRange');
  });

  it('refuses a negative or non-finite magnitude', () => {
    expect(() =>
      validateEgos([{ ...SOUND, grants: { mods: { armour: { floor: -1, step: 0 } } } }]),
    ).toThrow(/INTEGER/);
    expect(() =>
      validateEgos([{ ...SOUND, grants: { mods: { armour: { floor: 1, step: Number.NaN } } } }]),
    ).toThrow(/INTEGER/);
  });

  it('refuses an ego that grants one of the three dead mods', () => {
    // Zero call sites in src/. It would type check, persist, appear in the
    // inventory, print a tooltip, and change no number anywhere.
    const dead = { ...SOUND, grants: { mods: { physSpeed: { floor: 1, step: 1 } } } };
    expect(() => validateEgos([dead as unknown as Ego])).toThrow(/ZERO call sites/);
  });

  it('refuses an ego that grants nothing at all', () => {
    expect(() => validateEgos([{ ...SOUND, grants: {} }])).toThrow(/grants nothing/);
  });

  it('refuses a rarity of zero — genprob divides by it', () => {
    expect(() => validateEgos([{ ...SOUND, rarity: 0 }])).toThrow(/positive integer/);
    expect(() => validateEgos([{ ...SOUND, rarity: 2.5 }])).toThrow(/positive integer/);
  });

  it('refuses an inverted or zero-based level range', () => {
    expect(() => validateEgos([{ ...SOUND, levelRange: [10, 2] }])).toThrow(/levelRange/);
    expect(() => validateEgos([{ ...SOUND, levelRange: [0, 10] }])).toThrow(/levelRange/);
  });
});
