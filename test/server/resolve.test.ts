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
    expect(parseItemId(PLAIN)).toEqual({ base: PLAIN, egos: [] });
  });

  it('splits a base from its egos, in id order', () => {
    expect(parseItemId(`${PLAIN}~ba2`)).toEqual({
      base: PLAIN,
      egos: [{ code: 'ba', power: 2 }],
    });
    expect(parseItemId(`${PLAIN}~ba2${EGO_DELIMITER}wd1`)).toEqual({
      base: PLAIN,
      egos: [
        { code: 'ba', power: 2 },
        { code: 'wd', power: 1 },
      ],
    });
  });

  it('round-trips through format and back for every power a roll can produce', () => {
    for (let power = 0; power <= MAX_EGO_POWER; power += 1) {
      const id = formatItemId(PLAIN, [{ code: 'ba', power }]);
      expect(parseItemId(id)).toEqual({ base: PLAIN, egos: [{ code: 'ba', power }] });
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

  /**
   * THE STEP-1 BEHAVIOUR, PINNED DELIBERATELY.
   *
   * No egos are authored, so every ego'd id names an item this build cannot
   * produce, and `undefined` is the honest answer — the same answer every caller
   * already handles for an item deleted from content.
   *
   * This test is expected to CHANGE when the roster lands, and that is the
   * point: it is the line that makes "the grammar ships unused" a fact rather
   * than a claim in a commit message.
   */
  it('does not resolve an ego id, because this build has no egos', () => {
    expect(resolveItem(`${PLAIN}~ba2`)).toBeUndefined();
    expect(resolveItem(`${PLAIN}~ba2${EGO_DELIMITER}wd1`)).toBeUndefined();
  });

  it('is pure — the same id resolves the same way however many times it is asked', () => {
    // The projector, the save loader and the pickup path all call this, and one
    // of them runs on every frame. A draw or a cache in here would mean that
    // rendering an inventory mutates the world.
    const first = resolveItem(PLAIN);
    for (let i = 0; i < 50; i += 1) expect(resolveItem(PLAIN)).toBe(first);
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
