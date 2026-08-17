import { describe, expect, it } from 'vitest';

import {
  LootQuality,
  QUALITY_BANDS,
  bandFor,
  egoCountFor,
  partyMaxLevel,
  rollEgos,
  rollQuality,
} from '../../src/server/content/loot.ts';
import { resolveItem } from '../../src/server/content/resolve.ts';
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
  it('is `bound(ceil(level / 10), 1, 5)` — GameState.lua:1324', () => {
    expect(bandFor(1)).toBe(1);
    expect(bandFor(10)).toBe(1);
    expect(bandFor(11)).toBe(2);
    expect(bandFor(20)).toBe(2);
    expect(bandFor(21)).toBe(3);
    expect(bandFor(41)).toBe(5);
    // Clamped at both ends. A level-500 party is still band 5; a level-0 one is
    // band 1 rather than band 0, which would index nothing.
    expect(bandFor(500)).toBe(5);
    expect(bandFor(0)).toBe(1);
    expect(bandFor(-4)).toBe(1);
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
    // Money is not an item with egos on it. It becomes currency in its own step;
    // until then it produces the plain base, so the WEIGHTS never have to move.
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

describe('rollEgos', () => {
  it('returns an id that always resolves', () => {
    // The failure that would hurt: an id nothing can turn back into an item is
    // an item that vanishes on the next save/load, silently.
    const rng = createRng('ego-resolvable');
    for (let i = 0; i < 400; i += 1) {
      const id = rollEgos(rng, BASE, 1);
      expect(resolveItem(id), `${id} did not resolve`).not.toBeUndefined();
    }
  });

  it('returns the base unchanged for an id this build does not know', () => {
    // And takes no draws doing it: a content edit that deletes an item must not
    // shift the stream for everything rolled after it.
    const rng = createRng('ego-unknown');
    const before = rng.getState().count;
    expect(rollEgos(rng, 'item_cut_before_ship', 1)).toBe('item_cut_before_ship');
    expect(rng.getState().count).toBe(before);
  });

  it('never puts an ego on a slot it is barred from', () => {
    // `wt` (Weighted) is offhand/trinket only. `computeRarities` filters it out
    // for a body item, so it can never appear on the coat however many times
    // this rolls.
    const rng = createRng('ego-slots');
    for (let i = 0; i < 400; i += 1) {
      expect(rollEgos(rng, BASE, 1)).not.toContain('wt');
    }
    // ...and it is genuinely reachable where it IS allowed, so the assertion
    // above is not passing because the ego is unreachable everywhere.
    const buckler = createRng('ego-slots-offhand');
    let sawWeighted = false;
    for (let i = 0; i < 600 && !sawWeighted; i += 1) {
      if (rollEgos(buckler, 'item_watchmans_buckler', 1).includes('wt')) sawWeighted = true;
    }
    expect(sawWeighted).toBe(true);
  });

  it('puts the prefix before the suffix, always', () => {
    // Canonical order is what makes an item have exactly one id — see
    // resolveItem's refusal of the other spellings.
    const rng = createRng('ego-order');
    for (let i = 0; i < 400; i += 1) {
      const id = rollEgos(rng, BASE, 1);
      if (!id.includes('.')) continue;
      const [first, second] = id.slice(id.indexOf('~') + 1).split('.');
      expect(['rf', 'ol', 'wt', 'wd']).toContain(first?.slice(0, 2));
      expect(['lg', 'lw', 'qh', 'cr']).toContain(second?.slice(0, 2));
    }
  });

  it('is reproducible from a seed', () => {
    const draw = (): string[] => {
      const rng = createRng('ego-replay');
      return Array.from({ length: 25 }, () => rollEgos(rng, BASE, 1));
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
      if (rollEgos(shallow, BASE, 1).includes('cr')) earlyCoroner += 1;
    }

    const deep = createRng('ego-depth-2');
    let lateCoroner = 0;
    for (let i = 0; i < 500; i += 1) {
      if (rollEgos(deep, BASE, 20).includes('cr')) lateCoroner += 1;
    }

    expect(lateCoroner).toBeGreaterThan(earlyCoroner);
  });
});
