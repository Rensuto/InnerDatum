import { describe, expect, it } from 'vitest';

import { ITEMS, itemById } from '../../src/server/content/items.ts';
import {
  EGO_CODE_LENGTH,
  EGO_DELIMITER,
  EGO_SEPARATOR,
  MAX_EGOS,
  MAX_EGO_POWER,
  WORST_CASE_ID_LENGTH,
  assertIdGrammarFits,
  formatItemId,
  parseItemId,
  resolveItem,
  worstCaseIdLength,
} from '../../src/server/content/resolve.ts';
import { ITEM_ID_MAX_CHARS } from '../../src/shared/protocol.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *      THE ID GRAMMAR. IT IS SHIPPED UNUSED AND IT IS TESTED ANYWAY.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Every id this parses comes off a wire or out of a file on disk, so the two
 * failure modes are asymmetric and only one of them is survivable:
 *
 *   REJECTING something that should have parsed costs a player one item, is
 *   recorded in `problems`, and the character still loads.
 *
 *   ACCEPTING something that should not have costs a player a DIFFERENT item
 *   than the one they earned, silently, with nothing written down.
 *
 * So the bulk of this file is the second kind — malformed ids that must not
 * half-parse into something plausible.
 */

const PLAIN = 'item_watchmans_coat';

describe('the item id grammar', () => {
  it('leaves a plain id exactly as it found it', () => {
    // MATERIAL 1 IS WHAT A PLAIN ID MEANS. The field is new; the VALUE for every
    // id that existed before it is the one those items already had, which is the
    // whole reason this needed no save migration.
    expect(parseItemId(PLAIN)).toEqual({ base: PLAIN, material: 1, egos: [] });
  });

  it('splits a base from its egos, in id order', () => {
    expect(parseItemId(`${PLAIN}~ba2`)).toEqual({
      base: PLAIN,
      material: 1,
      egos: [{ code: 'ba', power: 2 }],
    });
    expect(parseItemId(`${PLAIN}~ba2${EGO_DELIMITER}wd1`)).toEqual({
      base: PLAIN,
      material: 1,
      egos: [
        { code: 'ba', power: 2 },
        { code: 'wd', power: 1 },
      ],
    });
  });

  it('round-trips through format and back for every power a roll can produce', () => {
    for (let power = 0; power <= MAX_EGO_POWER; power += 1) {
      const id = formatItemId(PLAIN, [{ code: 'ba', power }]);
      expect(parseItemId(id)).toEqual({ base: PLAIN, material: 1, egos: [{ code: 'ba', power }] });
    }
  });

  it('formats a plain item as its bare id — no separator on an item with no egos', () => {
    // Otherwise a plain item would have TWO spellings, and the bag's "an item is
    // its id" de-duplication would stop seeing two of them as the same thing.
    expect(formatItemId(PLAIN, [])).toBe(PLAIN);
    expect(formatItemId(PLAIN, []).includes(EGO_SEPARATOR)).toBe(false);
  });

  /**
   * Each of these is a string that could plausibly arrive, and each one has to
   * come back `undefined` rather than half-parse into a neighbouring item.
   */
  it.each([
    ['', 'the empty string'],
    ['~ba2', 'no base at all'],
    [`${PLAIN}~`, 'a separator with nothing after it'],
    [`${PLAIN}~ba2~wd1`, 'two separators — one item, one boundary'],
    [`${PLAIN}~b2`, 'a one-character code'],
    [`${PLAIN}~bad2`, 'a three-character code'],
    [`${PLAIN}~ba`, 'a code with no power digit'],
    [`${PLAIN}~ba4`, 'a power above the ceiling'],
    [`${PLAIN}~ba9`, 'a power well above the ceiling'],
    [
      `${PLAIN}~BA2`,
      'upper case — ids are lower case, and case-folding here would make two ids one',
    ],
    [`${PLAIN}~b-2`, 'punctuation in the code'],
    [`${PLAIN}~ba2${EGO_DELIMITER}ba1`, 'the same ego twice'],
    [`${PLAIN}~ba2${EGO_DELIMITER}wd1${EGO_DELIMITER}cr0`, 'more egos than an item can carry'],
    [`${PLAIN}~ba2${EGO_DELIMITER}`, 'a trailing delimiter'],
    [`${'x'.repeat(ITEM_ID_MAX_CHARS + 1)}`, 'longer than the wire allows'],
  ])('refuses %s (%s)', (id) => {
    expect(parseItemId(id)).toBeUndefined();
  });

  it('never parses an id the wire would have rejected', () => {
    // The parser's own length check and `z.string().max()` must agree, or an id
    // exists that survives one gate and dies at the other — which presents as an
    // item a player can hold and cannot equip.
    const overlong = `${PLAIN}${'x'.repeat(ITEM_ID_MAX_CHARS)}`;
    expect(overlong.length).toBeGreaterThan(ITEM_ID_MAX_CHARS);
    expect(parseItemId(overlong)).toBeUndefined();
  });
});

describe('resolveItem', () => {
  it('returns the catalogue object BY IDENTITY for a plain id', () => {
    // Identity, not equality. Everything that held an `Item` before this file
    // existed — the projector's views, the equipment fold — must be handed the
    // same object, or a `===` somewhere quietly becomes false.
    for (const item of ITEMS) {
      expect(resolveItem(item.id)).toBe(itemById(item.id));
      expect(resolveItem(item.id)).toBe(item);
    }
  });

  it('does not know an id whose base does not exist', () => {
    expect(resolveItem('item_cut_before_ship')).toBeUndefined();
    expect(resolveItem('item_cut_before_ship~ba2')).toBeUndefined();
  });

  it('does not know an ego code this build has never authored', () => {
    // `zz` is not a code. The whole item is unknown rather than resolving to a
    // bare coat with a shortened name — a silent downgrade is the one outcome
    // worse than a dropped item, because nothing records it.
    expect(resolveItem(`${PLAIN}~zz2`)).toBeUndefined();
    expect(resolveItem(`${PLAIN}~rf2${EGO_DELIMITER}zz1`)).toBeUndefined();
  });

  it('is pure — the same id resolves the same way however many times it is asked', () => {
    // The projector, the save loader and the pickup path all call this, and one
    // of them runs on every frame. A draw or a cache in here would mean that
    // rendering an inventory mutates the world.
    const first = resolveItem(PLAIN);
    for (let i = 0; i < 50; i += 1) expect(resolveItem(PLAIN)).toBe(first);

    // And an ego'd id is stable in VALUE across calls even though it allocates.
    const a = resolveItem(`${PLAIN}~rf2`);
    const b = resolveItem(`${PLAIN}~rf2`);
    expect(a).toEqual(b);
    expect(a).not.toBeUndefined();
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *                            THE FOLD
 * ═══════════════════════════════════════════════════════════════════════════
 * Two bases, chosen for their tiers, and every expected number written out as a
 * LITERAL. A test that recomputes `floor + step × power × tierWeight` proves
 * only that the formula equals itself; these are the numbers a player's
 * character sheet will show.
 *
 *   `item_watchmans_coat`   body, RARE     (tierWeight 3)  armour 4, hardiness 10
 *   `item_leather_chest`    body, COMMON   (tierWeight 1)  armour 3, def 1
 *
 *   `rf` Reinforced   armour {floor 1, step 1}   hardiness {floor 2, step 1}
 *   `lg` of the Ledger   cun {floor 3, step 1}
 */
describe('resolveItem folds egos onto a base', () => {
  const COAT = itemById(PLAIN);

  it('starts from the numbers the bases actually ship with', () => {
    // If this fails, every literal below is measuring the wrong thing — so it
    // fails FIRST and says so, rather than six assertions failing mysteriously.
    expect(COAT?.tier).toBe('rare');
    expect(COAT?.wielder.mods?.armour).toBe(4);
    expect(COAT?.wielder.mods?.armourHardiness).toBe(10);
    expect(itemById('item_leather_chest')?.tier).toBe('common');
    expect(itemById('item_leather_chest')?.wielder.mods?.armour).toBe(3);
  });

  it('adds the ego to what the base already granted', () => {
    // armour     4 + (1 + 1×2×3) = 11
    // hardiness 10 + (2 + 1×2×3) = 18
    const ego = resolveItem(`${PLAIN}~rf2`);
    expect(ego?.wielder.mods?.armour).toBe(11);
    expect(ego?.wielder.mods?.armourHardiness).toBe(18);
  });

  it('gives a power-0 ego its floor and nothing more, which is still not nothing', () => {
    // The reason `floor` exists: an ego that rolled badly is weaker, never inert.
    const ego = resolveItem(`${PLAIN}~rf0`);
    expect(ego?.wielder.mods?.armour).toBe(5);
    expect(ego?.wielder.mods?.armourHardiness).toBe(12);
  });

  it('scales with the BASE ITEM TIER, not with anything else', () => {
    // The same ego at the same power on a common base and on a rare one. This is
    // `material_level` doing all the work of a tier system without a tier system
    // existing (resolvers.lua:594-596), expressed in the field that already
    // means it.
    //
    //   common (weight 1):  3 + (1 + 1×3×1) = 7    — a gain of 4
    //   rare   (weight 3):  4 + (1 + 1×3×3) = 14   — a gain of 10
    expect(resolveItem('item_leather_chest~rf3')?.wielder.mods?.armour).toBe(7);
    expect(resolveItem(`${PLAIN}~rf3`)?.wielder.mods?.armour).toBe(14);
  });

  it('builds the name by concatenation, with the whitespace living in the ego', () => {
    expect(resolveItem(`${PLAIN}~rf1`)?.name).toBe("Reinforced Watchman's Coat");
    expect(resolveItem(`${PLAIN}~lg1`)?.name).toBe("Watchman's Coat of the Ledger");
    expect(resolveItem(`${PLAIN}~rf1${EGO_DELIMITER}lg1`)?.name).toBe(
      "Reinforced Watchman's Coat of the Ledger",
    );
  });

  it('keeps the base icon — there is no ego art', () => {
    const ego = resolveItem(`${PLAIN}~rf2${EGO_DELIMITER}lg2`);
    if (ego === undefined || COAT === undefined) throw new Error('unreachable');
    expect(ego.icon).toBe(COAT.icon);
    expect(ego.slot).toBe(COAT.slot);
    // And the id it reports is the INSTANCE id, not the base's — otherwise an
    // equip intent built from a view would name the wrong item.
    expect(ego.id).toBe(`${PLAIN}~rf2${EGO_DELIMITER}lg2`);
  });

  it('climbs one tier per ego and stops at rare', () => {
    // Object.lua:517-527 colours by ego count; we say it in the field that
    // already exists, so the floor marker gets brighter for a better drop.
    expect(resolveItem('item_leather_chest~rf1')?.tier).toBe('uncommon');
    expect(resolveItem(`item_leather_chest~rf1${EGO_DELIMITER}lg1`)?.tier).toBe('rare');
    // Already rare plus two egos would be five; there is no fifth tier, and a
    // clamp is better than a new one nothing else in the game understands.
    expect(resolveItem(`${PLAIN}~rf1${EGO_DELIMITER}lg1`)?.tier).toBe('rare');
  });

  it('carries both egos, and every resolved number is an integer', () => {
    // Two egos onto one base — the property engine/equipment.ts rests on, one
    // layer earlier. Integers make the downstream fold EXACTLY commutative;
    // one fractional magnitude would quietly turn that proof into a proof about
    // a single ordering.
    //
    //   armour  4 + (1 + 1×3×3) = 14      cun  0 + (3 + 1×3×3) = 12
    const a = resolveItem(`${PLAIN}~rf3${EGO_DELIMITER}lg3`);
    expect(a?.wielder.mods?.armour).toBe(14);
    expect(a?.wielder.stats?.cun).toBe(12);
    for (const value of [
      ...Object.values(a?.wielder.stats ?? {}),
      ...Object.values(a?.wielder.mods ?? {}),
    ]) {
      expect(Number.isInteger(value)).toBe(true);
    }
  });

  /**
   * ONE SLOT, ONCE, IN ORDER — the ids that are not items.
   *
   * Each of these parses cleanly. They are refused at resolve time because they
   * would be a SECOND SPELLING of an item that already has one, and two
   * spellings of one item is exactly what breaks the bag's de-duplication.
   */
  it('refuses two prefixes, two suffixes, or a suffix before a prefix', () => {
    expect(resolveItem(`${PLAIN}~rf1${EGO_DELIMITER}ol1`)).toBeUndefined();
    expect(resolveItem(`${PLAIN}~lg1${EGO_DELIMITER}lw1`)).toBeUndefined();
    expect(resolveItem(`${PLAIN}~lg1${EGO_DELIMITER}rf1`)).toBeUndefined();
    // ...and the canonical spelling of that last one is fine.
    expect(resolveItem(`${PLAIN}~rf1${EGO_DELIMITER}lg1`)).not.toBeUndefined();
  });

  it('refuses an ego on a slot it is not allowed on', () => {
    // `wt` (Weighted) is offhand/trinket only. A hand-edited save is the way one
    // of these arrives; the roll already respects the restriction.
    expect(resolveItem(`${PLAIN}~wt2`)).toBeUndefined();
    expect(resolveItem('item_watchmans_buckler~wt2')).not.toBeUndefined();
  });
});

describe('the import-time grammar check', () => {
  it('computes the worst case from the constants, not from a number in a comment', () => {
    // base + '~' + MAX_EGOS tokens of (code + power) + the delimiters between.
    const longest = Math.max(...ITEMS.map((item) => item.id.length));
    expect(worstCaseIdLength(longest)).toBe(
      longest + 1 + MAX_EGOS * (EGO_CODE_LENGTH + 1) + (MAX_EGOS - 1),
    );
    expect(WORST_CASE_ID_LENGTH).toBe(worstCaseIdLength(longest));
  });

  it('leaves real headroom against the wire cap', () => {
    expect(WORST_CASE_ID_LENGTH).toBeLessThanOrEqual(ITEM_ID_MAX_CHARS);
    // And the longest id the grammar can build really does parse, rather than
    // fitting the cap in arithmetic and failing in the parser.
    const longest = ITEMS.reduce((a, b) => (a.id.length >= b.id.length ? a : b));
    const worst = formatItemId(longest.id, [
      { code: 'zz', power: MAX_EGO_POWER },
      { code: 'yy', power: MAX_EGO_POWER },
    ]);
    expect(worst.length).toBe(WORST_CASE_ID_LENGTH);
    expect(parseItemId(worst)).not.toBeUndefined();
  });

  it('throws on an authored id containing a grammar character', () => {
    // A base id with a `~` in it would parse as some OTHER item plus an ego —
    // a silent misresolve, which is the one failure this whole file is arranged
    // to make impossible.
    const stray = { ...(ITEMS[0] as (typeof ITEMS)[number]), id: 'item_bad~name' };
    expect(() => assertIdGrammarFits([stray])).toThrow(/grammar character/);
    const dotted = { ...(ITEMS[0] as (typeof ITEMS)[number]), id: 'item.bad' };
    expect(() => assertIdGrammarFits([dotted])).toThrow(/grammar character/);
  });

  it('throws on a base id long enough to push the worst case over the wire cap', () => {
    // The check that matters. An item authored with a 60-character id would type
    // check, load, drop, and become unequippable the day it rolled an ego.
    const huge = {
      ...(ITEMS[0] as (typeof ITEMS)[number]),
      id: `item_${'x'.repeat(ITEM_ID_MAX_CHARS)}`,
    };
    expect(() => assertIdGrammarFits([huge])).toThrow(/over the .* wire cap/);
  });
});
