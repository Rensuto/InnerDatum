import { describe, expect, it } from 'vitest';

import {
  OOD_FACTOR,
  RARITY_SCALE,
  computeRarities,
  pickEntity,
  rarityShare,
} from '../../src/server/content/rarity.ts';
import { createRng } from '../../src/shared/rng.ts';
import type { RarityCandidate } from '../../src/server/content/rarity.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *        THE OUT-OF-DEPTH ARITHMETIC, WITH THE LUA'S OWN NUMBERS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * CLAUDE.md: "when docs/tome-mechanics.md and the Lua disagree, the Lua wins —
 * read the source, then put the expected numbers in a test next to the
 * citation." So every expectation here is computed by hand from
 * Zone.lua:217-221 and written as a literal.
 */

type Row = RarityCandidate & { readonly name: string };

const row = (name: string, rarity: number, low: number, high: number): Row => ({
  name,
  rarity,
  levelRange: [low, high],
});

describe('computeRarities', () => {
  it('gives an in-band candidate the full scale over its rarity', () => {
    // No division: `max` stays 10000, so genprob = floor(10000 / 5) = 2000.
    const list = computeRarities([row('common', 5, 1, 10)], 5);
    expect(list.total).toBe(2000);
    expect(list.entries[0]?.genprob).toBe(2000);
  });

  it('divides an UNDER-depth candidate by three times the gap', () => {
    // THE WORKED EXAMPLE FROM THE PORT PLAN. A [30,50] rarity-30 candidate seen
    // by a level-1 party: 29 levels below, so
    //   max     = 10000 / (3 * 29) = 114.94
    //   genprob = floor(114.94 / 30) = 3
    const deep = computeRarities([row('deep', 30, 30, 50)], 1);
    expect(deep.total).toBe(3);

    // ...against an in-band rarity-5 candidate's 2000. That single pair proves
    // the divisor, the floor and the asymmetry in one assertion: a level-1
    // party sees the deep item roughly once in seven hundred.
    const shallow = computeRarities([row('shallow', 5, 1, 10)], 1);
    expect(shallow.total).toBe(2000);
  });

  it('divides an OVER-depth candidate by the gap ALONE — three times gentler', () => {
    // The asymmetry, stated as an equation rather than as prose. Same rarity,
    // same distance out of band, opposite directions.
    const gap = 4;
    const rarity = 10;
    const under = computeRarities([row('under', rarity, 20, 30)], 20 - gap);
    const over = computeRarities([row('over', rarity, 20, 30)], 30 + gap);

    expect(under.total).toBe(Math.floor(RARITY_SCALE / (OOD_FACTOR * gap) / rarity));
    expect(over.total).toBe(Math.floor(RARITY_SCALE / gap / rarity));

    // 83 against 250 — the over-depth candidate is exactly OOD_FACTOR times
    // likelier, which is the direction that makes finding something above your
    // level the interesting case.
    expect(under.total).toBe(83);
    expect(over.total).toBe(250);
    expect(over.total / under.total).toBeGreaterThan(2.9);
  });

  it('drops a candidate whose weight floors to zero, rather than keeping it at ~0', () => {
    // A rarity-30 candidate 200 levels below: max = 10000/600 = 16.6,
    // genprob = floor(16.6/30) = 0. Zone.lua:243's `if genprob > 0`.
    const list = computeRarities([row('unreachable', 30, 201, 250)], 1);
    expect(list.entries).toEqual([]);
    expect(list.total).toBe(0);
  });

  it('stores the RUNNING total, so the list is ascending and walkable once', () => {
    const list = computeRarities([row('a', 10, 1, 10), row('b', 5, 1, 10), row('c', 20, 1, 10)], 5);
    // 1000, then 1000+2000, then 3000+500.
    expect(list.entries.map((entry) => entry.genprob)).toEqual([1000, 3000, 3500]);
    expect(list.total).toBe(3500);
  });

  it('applies the filter before weighing, and a filtered row costs nothing', () => {
    const rows = [row('keep', 5, 1, 10), row('drop', 5, 1, 10)];
    const list = computeRarities(rows, 5, (candidate) => candidate.name === 'keep');
    expect(list.entries).toHaveLength(1);
    expect(list.entries[0]?.e.name).toBe('keep');
    expect(list.total).toBe(2000);
  });

  it('reports readable shares, which is the only way to check a roster by eye', () => {
    const list = computeRarities([row('a', 5, 1, 10), row('b', 15, 1, 10)], 5);
    const shares = rarityShare(list);
    expect(shares.map((s) => s.e.name)).toEqual(['a', 'b']);
    // 2000 and 666 out of 2666.
    expect(Math.round(shares[0]?.percent ?? 0)).toBe(75);
    expect(Math.round(shares[1]?.percent ?? 0)).toBe(25);
  });
});

describe('pickEntity', () => {
  it('takes exactly one draw whatever the list length', () => {
    // The reason the label matters more than the count: adding a candidate
    // changes WHAT a seed produces and not HOW MANY draws it takes, so a roster
    // edit cannot shift every later draw on the stream.
    const short = computeRarities([row('a', 5, 1, 10)], 5);
    const long = computeRarities(
      Array.from({ length: 40 }, (_, i) => row(`e${String(i)}`, 5, 1, 10)),
      5,
    );

    const one = createRng('draws');
    pickEntity(one, 'pick', short);
    const afterShort = one.getState().count;

    const two = createRng('draws');
    pickEntity(two, 'pick', long);
    expect(two.getState().count).toBe(afterShort);
  });

  it('consumes NO draw on an empty list', () => {
    // "Nothing was eligible" is a CONTENT-DEPENDENT condition, so a draw here
    // would mean that editing a roster desyncs every later roll on the stream
    // for anyone whose party level made the list empty.
    const rng = createRng('empty');
    const before = rng.getState().count;
    expect(pickEntity(rng, 'pick', { entries: [], total: 0 })).toBeUndefined();
    expect(rng.getState().count).toBe(before);
  });

  it('never returns a candidate that computeRarities dropped', () => {
    const list = computeRarities([row('here', 5, 1, 10), row('nowhere', 30, 201, 250)], 1);
    const rng = createRng('exclusion');
    for (let i = 0; i < 400; i += 1) {
      expect(pickEntity(rng, 'pick', list)?.name).toBe('here');
    }
  });

  it('picks in rough proportion to weight over many draws', () => {
    // Not a distribution proof — a smoke test that the cumulative walk is not
    // off by one at either end, which is the way this function actually breaks.
    const list = computeRarities([row('common', 1, 1, 10), row('rare', 100, 1, 10)], 5);
    const rng = createRng('proportion');
    let rares = 0;
    for (let i = 0; i < 4000; i += 1) {
      if (pickEntity(rng, 'pick', list)?.name === 'rare') rares += 1;
    }
    // Weights are 10000 and 100, so ~1%.
    expect(rares).toBeGreaterThan(5);
    expect(rares).toBeLessThan(120);
  });

  it('is reproducible from a seed', () => {
    const list = computeRarities([row('a', 5, 1, 10), row('b', 7, 1, 10), row('c', 11, 1, 10)], 5);
    const draw = (): string[] => {
      const rng = createRng('replay');
      return Array.from({ length: 20 }, () => pickEntity(rng, 'pick', list)?.name ?? '');
    };
    expect(draw()).toEqual(draw());
  });
});
