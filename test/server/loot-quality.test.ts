import { MAX_CHARACTER_LEVEL } from '../../src/shared/progression.ts';
import { describe, expect, it } from 'vitest';

import {
  LootQuality,
  QUALITY_BANDS,
  bandFor,
  egoCountFor,
  partyMaxLevel,
  rollLoot,
  rollQuality,
  LEVELS_PER_BAND,
} from '../../src/server/content/loot.ts';
import {
  MAX_MONEY_PILE,
  MIN_MONEY_PILE,
  isMoneyId,
  moneyAmountOf,
} from '../../src/server/content/money.ts';
import { resolveItem } from '../../src/server/content/resolve.ts';
import { ITEM_ID_MAX_CHARS } from '../../src/shared/protocol.ts';
import { createRng } from '../../src/shared/rng.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *   THE ITEM DOES NOT DECIDE HOW MANY EGOS IT GETS. THE BAND DOES.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * That is the load-bearing finding from GameState.lua:1345-1436, and it is what
 * makes loot feel like it belongs to a place rather than to a sword. These
 * tests are mostly about the TABLE being read correctly, because a weights
 * table that is silently ignored looks exactly like one that is working.
 */

const BASE = 'item_watchmans_coat';

describe('the depth bands', () => {
  it('is GameState.lua:1324 with this game’s own ceiling, not ToME’s', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THIS PINNED `bandFor(10) === 1` AND THAT WAS THE BUG, NOT THE CONTRACT.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `bound(ceil(level / 10), 1, 5)` is upstream's formula and it was ported
     * verbatim, divisor and all. ToME's characters go to level 50.
     * `MAX_CHARACTER_LEVEL` here is 10 — so `ceil(10 / 10)` is 1 and EVERY
     * CHARACTER AT EVERY LEVEL, from the first husk to the last closed case,
     * was band 1. Four of the five authored bands were unreachable, and the
     * test asserting `bandFor(10) === 1` was faithfully pinning that.
     *
     * A formula copied past the point where its assumptions hold is not
     * fidelity, it is the appearance of it. The SHAPE is what ports — five
     * bands across a character's whole life — so the divisor becomes this
     * game's own: 1..10 in steps of two.
     */
    expect(LEVELS_PER_BAND).toBe(2);
    expect(bandFor(1)).toBe(1);
    expect(bandFor(2)).toBe(1);
    expect(bandFor(3)).toBe(2);
    expect(bandFor(9)).toBe(5);
    expect(bandFor(10)).toBe(5);
    // Clamped at both ends. A level-500 party is still band 5; a level-0 one is
    // band 1 rather than band 0, which would index nothing.
    expect(bandFor(500)).toBe(5);
    expect(bandFor(0)).toBe(1);
    expect(bandFor(-4)).toBe(1);
  });

  it('makes every band reachable inside the level cap', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE GUARD THAT WOULD HAVE CAUGHT IT, AND THE ONE WORTH KEEPING.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * An authored table whose rows nobody can reach is content that does not
     * exist, and it is invisible from every angle: the table is correct, the
     * roll is correct, the citation is correct, and four fifths of it is dead.
     *
     * Stated against `MAX_CHARACTER_LEVEL` rather than against a literal, so
     * moving the cap or the divisor either keeps the property or fails here.
     */
    const reachable = new Set<number>();
    for (let level = 1; level <= MAX_CHARACTER_LEVEL; level += 1) {
      reachable.add(bandFor(level));
    }
    expect([...reachable].sort((a, b) => a - b)).toEqual(
      QUALITY_BANDS.map((_row, index) => index + 1),
    );
  });

  it('gets better as a character grows, which is the point of having bands', () => {
    /**
     * The curve, asserted as a DIRECTION rather than as percentages: a higher
     * band must never be worse at producing egos than a lower one. Measured
     * odds today run 18% double-ego at level 1 to 82% at level 10, but pinning
     * those numbers would make every future weight edit look like a regression.
     */
    const doubleWeight = (band: number): number => {
      const row = QUALITY_BANDS[band - 1];
      if (row === undefined) return 0;
      const total = row.reduce((sum, entry) => sum + entry.weight, 0);
      const two = row.find((entry) => entry.quality === LootQuality.DoubleEgo)?.weight ?? 0;
      return two / total;
    };
    for (let band = 2; band <= QUALITY_BANDS.length; band += 1) {
      expect(doubleWeight(band), `band ${String(band)}`).toBeGreaterThan(doubleWeight(band - 1));
    }
  });

  it('has five bands, all four categories in each, all weights positive', () => {
    expect(QUALITY_BANDS).toHaveLength(5);
    for (const row of QUALITY_BANDS) {
      expect(row.map((entry) => entry.quality)).toEqual([
        LootQuality.Plain,
        LootQuality.Ego,
        LootQuality.DoubleEgo,
        LootQuality.Money,
      ]);
      for (const entry of row) expect(entry.weight).toBeGreaterThan(0);
    }
  });

  it('gets steadily better with depth, which is the only thing the table is for', () => {
    // Plain falls monotonically and double_ego rises monotonically. If a future
    // edit inverts a row, THIS is what catches it — the numbers themselves look
    // plausible in any order.
    const plain = QUALITY_BANDS.map((row) => row[0]?.weight ?? 0);
    const double = QUALITY_BANDS.map((row) => row[2]?.weight ?? 0);
    for (let i = 1; i < QUALITY_BANDS.length; i += 1) {
      expect(plain[i]).toBeLessThan(plain[i - 1] ?? 0);
      expect(double[i]).toBeGreaterThan(double[i - 1] ?? 0);
    }
  });

  it('leaves the weights UNNORMALISED, exactly as upstream does', () => {
    // GameState.lua's own band 1 totals 112.5. The roll is over the running
    // total, so a designer edits one number without rebalancing the row —
    // normalising would turn every tuning edit into four.
    const totals = QUALITY_BANDS.map((row) => row.reduce((sum, e) => sum + e.weight, 0));
    expect(totals.some((total) => total !== 100)).toBe(true);
  });
});

describe('rollQuality', () => {
  it('costs exactly one draw', () => {
    const rng = createRng('quality-draws');
    const before = rng.getState().count;
    rollQuality(rng, 1);
    expect(rng.getState().count).toBe(before + 1);
    expect(rng.getState().lastLabel).toBe('ego.category');
  });

  it('reaches every category in band 1 over enough seeds', () => {
    // A category that is in the table and can never be rolled is a weight being
    // ignored, which is invisible from the table itself.
    const seen = new Set<string>();
    const rng = createRng('quality-coverage');
    for (let i = 0; i < 500; i += 1) seen.add(rollQuality(rng, 1));
    expect([...seen].sort()).toEqual(['double_ego', 'ego', 'money', 'plain']);
  });

  it('produces more named items at depth than at the surface', () => {
    // The property the whole table exists to deliver, measured rather than
    // assumed. Band 1 is 38 plain against band 5's 5.
    const count = (band: number): number => {
      const rng = createRng(`quality-band-${String(band)}`);
      let plain = 0;
      for (let i = 0; i < 600; i += 1) {
        if (rollQuality(rng, band) === LootQuality.Plain) plain += 1;
      }
      return plain;
    };
    expect(count(5)).toBeLessThan(count(1));
  });

  it('maps a category to a fixed ego count — the category forces it', () => {
    expect(egoCountFor(LootQuality.Plain)).toBe(0);
    expect(egoCountFor(LootQuality.Ego)).toBe(1);
    expect(egoCountFor(LootQuality.DoubleEgo)).toBe(2);
    // Money is not an item with egos on it at all — it replaces the item. The
    // weights did not move when currency landed, which was the point of keeping
    // the column in the table while it still produced a plain base.
    expect(egoCountFor(LootQuality.Money)).toBe(0);
  });
});

describe('partyMaxLevel', () => {
  it('is the maximum, so benching a high-level character cannot game it', () => {
    expect(partyMaxLevel([1, 8, 3])).toBe(8);
    expect(partyMaxLevel([2])).toBe(2);
  });

  it('is 1 for an empty party, which is band 1', () => {
    // Pre-M6 every character is level 1 and the whole table degenerates to band
    // 1 — correct, and the reason this can ship before progression matters.
    expect(partyMaxLevel([])).toBe(1);
    expect(bandFor(partyMaxLevel([]))).toBe(1);
  });

  it('ignores a non-finite level rather than propagating a NaN into the band', () => {
    expect(partyMaxLevel([Number.NaN, 4])).toBe(4);
    expect(partyMaxLevel([Number.POSITIVE_INFINITY])).toBe(1);
  });
});

describe('rollLoot', () => {
  it('returns an id that is either a real item or a real coin pile — never neither', () => {
    // The failure that would hurt: an id nothing downstream can interpret is a
    // drop that vanishes on the next save/load, silently.
    //
    // TWO KINDS OF VALID, because money is deliberately NOT an `Item` — it has
    // no slot, and content/money.ts argues at length why inventing one would be
    // worse. So the invariant is a disjunction, and asserting only the first
    // half is what made this test fail the moment coins landed.
    const rng = createRng('ego-resolvable');
    let coins = 0;
    for (let i = 0; i < 400; i += 1) {
      const id = rollLoot(rng, BASE, 1);
      if (isMoneyId(id)) {
        coins += 1;
        continue;
      }
      expect(resolveItem(id), `${id} is neither an item nor money`).not.toBeUndefined();
    }
    // And money really is reachable, so the branch above is not passing because
    // it is never taken.
    expect(coins).toBeGreaterThan(0);
  });

  it('makes a coin pile that is worth something and fits the wire', () => {
    const rng = createRng('coins');
    let seen = 0;
    for (let i = 0; i < 600; i += 1) {
      const id = rollLoot(rng, BASE, 1);
      const amount = moneyAmountOf(id);
      if (amount === undefined) continue;
      seen += 1;
      expect(amount).toBeGreaterThanOrEqual(MIN_MONEY_PILE);
      expect(amount).toBeLessThanOrEqual(MAX_MONEY_PILE);
      expect(Number.isInteger(amount)).toBe(true);
      expect(id.length).toBeLessThanOrEqual(ITEM_ID_MAX_CHARS);
    }
    expect(seen).toBeGreaterThan(0);
  });

  it('pays more at depth, because the pile scales with the band', () => {
    // ToME's own pile has ZERO depth scaling (money.lua:38-45) because its gold
    // comes from selling. Ours scales, so a coin pile stays a real but small
    // fraction of a sale rather than becoming rounding by level 20.
    const purse = (level: number): number => {
      const rng = createRng(`purse-${String(level)}`);
      let total = 0;
      for (let i = 0; i < 800; i += 1) {
        total += moneyAmountOf(rollLoot(rng, BASE, level)) ?? 0;
      }
      return total;
    };
    expect(purse(25)).toBeGreaterThan(purse(1));
  });

  it('returns the base unchanged for an id this build does not know', () => {
    // And takes no draws doing it: a content edit that deletes an item must not
    // shift the stream for everything rolled after it.
    const rng = createRng('ego-unknown');
    const before = rng.getState().count;
    expect(rollLoot(rng, 'item_cut_before_ship', 1)).toBe('item_cut_before_ship');
    expect(rng.getState().count).toBe(before);
  });

  it('never puts an ego on a slot it is barred from', () => {
    // `wt` (Weighted) is offhand/trinket only. `computeRarities` filters it out
    // for a body item, so it can never appear on the coat however many times
    // this rolls.
    const rng = createRng('ego-slots');
    for (let i = 0; i < 400; i += 1) {
      expect(rollLoot(rng, BASE, 1)).not.toContain('wt');
    }
    // ...and it is genuinely reachable where it IS allowed, so the assertion
    // above is not passing because the ego is unreachable everywhere.
    const buckler = createRng('ego-slots-offhand');
    let sawWeighted = false;
    for (let i = 0; i < 600 && !sawWeighted; i += 1) {
      if (rollLoot(buckler, 'item_watchmans_buckler', 1).includes('wt')) sawWeighted = true;
    }
    expect(sawWeighted).toBe(true);
  });

  it('puts the prefix before the suffix, always', () => {
    // Canonical order is what makes an item have exactly one id — see
    // resolveItem's refusal of the other spellings.
    const rng = createRng('ego-order');
    for (let i = 0; i < 400; i += 1) {
      const id = rollLoot(rng, BASE, 1);
      if (!id.includes('.')) continue;
      const [first, second] = id.slice(id.indexOf('~') + 1).split('.');
      expect(['rf', 'ol', 'wt', 'wd']).toContain(first?.slice(0, 2));
      expect(['lg', 'lw', 'qh', 'cr']).toContain(second?.slice(0, 2));
    }
  });

  it('is reproducible from a seed', () => {
    const draw = (): string[] => {
      const rng = createRng('ego-replay');
      return Array.from({ length: 25 }, () => rollLoot(rng, BASE, 1));
    };
    expect(draw()).toEqual(draw());
  });

  it('gates a late ego out of a level-1 roll and lets it in at depth', () => {
    // `cr` (of the Coroner) is levelRange [5,50] rarity 14. At party level 1 it
    // is four levels under-depth: 10000/(3*4)/14 = 59 against `lg`'s 2000 — a
    // long tail rather than a wall, which is the asymmetry doing its job.
    const shallow = createRng('ego-depth-1');
    let earlyCoroner = 0;
    for (let i = 0; i < 500; i += 1) {
      if (rollLoot(shallow, BASE, 1).includes('cr')) earlyCoroner += 1;
    }

    const deep = createRng('ego-depth-2');
    let lateCoroner = 0;
    for (let i = 0; i < 500; i += 1) {
      if (rollLoot(deep, BASE, 20).includes('cr')) lateCoroner += 1;
    }

    expect(lateCoroner).toBeGreaterThan(earlyCoroner);
  });
});
