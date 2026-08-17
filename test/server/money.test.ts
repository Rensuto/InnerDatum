import { describe, expect, it } from 'vitest';

import {
  MAX_MONEY_PILE,
  MIN_MONEY_PILE,
  MONEY_BASE_ID,
  isMoneyId,
  moneyAmountOf,
  moneyIdFor,
  moneyName,
  rollMoney,
} from '../../src/server/content/money.ts';
import { STARTING_MONEY, createPlayerActor, incMoney } from '../../src/server/engine/actor.ts';
import { resolveItem } from '../../src/server/content/resolve.ts';
import { parseItemId } from '../../src/server/content/resolve.ts';
import { createRng } from '../../src/shared/rng.ts';
import { ITEM_ID_MAX_CHARS } from '../../src/shared/protocol.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *      A COIN PILE IS AN ITEM ID THAT IS NOT AN ITEM
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * It travels every path an item id travels, because those paths all take a
 * string. It is refused by every path that turns a string into an `Item`,
 * because it has no slot and inventing one would put a lie in the catalogue
 * that four separate places would then have to be taught to ignore.
 *
 * Both halves are asserted here. The second is the one that would rot: it is
 * easy to "fix" `resolveItem` to answer for money and hard to notice that the
 * paper doll grew a coin slot.
 */

describe('the money id grammar', () => {
  it('round-trips an amount', () => {
    for (const amount of [MIN_MONEY_PILE, 3, 14, 99, MAX_MONEY_PILE]) {
      const id = moneyIdFor(amount);
      expect(moneyAmountOf(id)).toBe(amount);
      expect(isMoneyId(id)).toBe(true);
    }
  });

  it('clamps an out-of-range amount rather than minting an unreadable id', () => {
    // `moneyIdFor` is the ONE writer, so a caller that computes a silly number
    // gets a legible pile instead of an id that `moneyAmountOf` would then
    // refuse — which would be gold that exists on the floor and cannot be
    // picked up.
    expect(moneyAmountOf(moneyIdFor(0))).toBe(MIN_MONEY_PILE);
    expect(moneyAmountOf(moneyIdFor(-40))).toBe(MIN_MONEY_PILE);
    expect(moneyAmountOf(moneyIdFor(10_000))).toBe(MAX_MONEY_PILE);
    expect(moneyAmountOf(moneyIdFor(7.9))).toBe(7);
  });

  it('fits the wire at its largest, which is what the cap is for', () => {
    // An unbounded amount would make the id length a function of the economy,
    // and the first symptom would be a frame refused by `z.string().max()` for
    // a reason nobody could see.
    expect(moneyIdFor(MAX_MONEY_PILE).length).toBeLessThanOrEqual(ITEM_ID_MAX_CHARS);
  });

  it.each([
    ['item_iron_ingot', 'the bare base with no amount'],
    ['item_iron_ingot@', 'a separator with nothing after it'],
    ['item_iron_ingot@0', 'zero'],
    ['item_iron_ingot@1', 'below the floor'],
    ['item_iron_ingot@07', 'a leading zero — two spellings of seven'],
    ['item_iron_ingot@-4', 'a negative'],
    ['item_iron_ingot@1.5', 'a decimal'],
    ['item_iron_ingot@1000', 'over the cap'],
    ['item_iron_ingot@ 4', 'whitespace'],
    ['item_watchmans_coat@5', 'the wrong base'],
    ['item_iron_ingot@4@5', 'two amounts'],
  ])('refuses %s (%s)', (id) => {
    expect(moneyAmountOf(id)).toBeUndefined();
    expect(isMoneyId(id)).toBe(false);
  });

  it('is NOT an item, and that is deliberate', () => {
    // If this ever starts passing, somebody has taught `resolveItem` to answer
    // for money — at which point a coin pile has a `slot` and the equip path,
    // the paper doll and `wornOf` each need a special case they do not have.
    expect(resolveItem(moneyIdFor(14))).toBeUndefined();
    expect(resolveItem(MONEY_BASE_ID)).toBeUndefined();
  });

  it('does not collide with the ego grammar', () => {
    // Two grammars on one string is how an id ends up meaning two things. `@`
    // and `~` never appear together, and the ego parser must not half-read a
    // coin pile as a base with no egos and then resolve the wrong item.
    expect(parseItemId(moneyIdFor(14))?.egos).toEqual([]);
    expect(resolveItem(`${MONEY_BASE_ID}@14~rf2`)).toBeUndefined();
    expect(moneyAmountOf(`${MONEY_BASE_ID}@14~rf2`)).toBeUndefined();
  });

  it('reads as plain English in the log', () => {
    expect(moneyName(14)).toBe('14 gold');
  });
});

describe('rollMoney', () => {
  it('costs exactly one labelled draw', () => {
    const rng = createRng('money-draw');
    const before = rng.getState().count;
    rollMoney(rng, 1);
    expect(rng.getState().count).toBe(before + 1);
    expect(rng.getState().lastLabel).toBe('ego.money');
  });

  it('stays inside the pile bounds at every band', () => {
    for (let band = 1; band <= 5; band += 1) {
      const rng = createRng(`money-band-${String(band)}`);
      for (let i = 0; i < 200; i += 1) {
        const amount = rollMoney(rng, band);
        expect(amount).toBeGreaterThanOrEqual(MIN_MONEY_PILE);
        expect(amount).toBeLessThanOrEqual(MAX_MONEY_PILE);
        expect(Number.isInteger(amount)).toBe(true);
      }
    }
  });
});

describe('incMoney', () => {
  const body = (): ReturnType<typeof createPlayerActor> =>
    createPlayerActor('p1', { name: 'Ren', sprite: 'player_watchman_s', x: 1, y: 1 });

  it('starts a character with the birth purse', () => {
    // descriptors.lua:74. Enough to matter, not enough to skip the first sale.
    expect(body().money).toBe(STARTING_MONEY);
    expect(STARTING_MONEY).toBe(15);
  });

  it('adds and subtracts', () => {
    const actor = body();
    expect(incMoney(actor, 10)).toBe(STARTING_MONEY + 10);
    expect(incMoney(actor, -5)).toBe(STARTING_MONEY + 5);
    expect(actor.money).toBe(STARTING_MONEY + 5);
  });

  it('CLAMPS AT ZERO — Actor.lua:1688-1689', () => {
    // A debit larger than the purse empties it. Going negative would make every
    // later subtraction worse and would show a player a purse they cannot ever
    // spend out of.
    const actor = body();
    expect(incMoney(actor, -10_000)).toBe(0);
    expect(actor.money).toBe(0);
  });

  it('floors its input, so no fraction can ever enter a purse', () => {
    // Every caller passes an integer today. This is the guard for the first one
    // that does not — a shop price — because 0.30000000000000004 is a number a
    // player would eventually be shown.
    const actor = body();
    incMoney(actor, 2.9);
    expect(actor.money).toBe(STARTING_MONEY + 2);
    expect(Number.isInteger(actor.money)).toBe(true);
  });

  it('ignores a non-finite delta rather than poisoning the purse', () => {
    // A NaN would propagate through every later addition and the first visible
    // symptom would be a purse that renders as "NaN GOLD".
    const actor = body();
    incMoney(actor, Number.NaN);
    expect(actor.money).toBe(STARTING_MONEY);
    incMoney(actor, Number.POSITIVE_INFINITY);
    expect(Number.isFinite(actor.money)).toBe(true);
  });
});
