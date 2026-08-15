import { describe, expect, it } from 'vitest';

import { createRng, rngFromState } from '../../src/shared/rng.ts';
import type { Rng, RngState } from '../../src/shared/rng.ts';

/**
 * The RNG is the load-bearing assumption under save/load and replay: given a
 * seed and an action log, the engine must rebuild a world state exactly. Every
 * failure in this file is silent at the time it is introduced and only surfaces
 * as "my save loaded into a different dungeon" weeks later, so these tests pin
 * the CONTRACT (determinism, resumability, stream independence, bounds) rather
 * than any particular sequence of numbers. No expected value is hard-coded: the
 * generator's output is compared against itself, so a deliberate change to the
 * algorithm shows up as a coherent failure instead of a wall of magic numbers.
 */

const POOL = ['watchman', 'inspector', 'alchemist', 'enforcer'] as const;

/** N raw draws, labelled distinctly so a divergence names its own call site. */
function draws(rng: Rng, count: number, label: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < count; i += 1) {
    out.push(rng.nextU32(`${label}.${i}`));
  }
  return out;
}

/**
 * One pass through every method, in a fixed order. Array literals evaluate
 * left to right, so this is a stable call sequence — which is exactly the thing
 * the determinism guarantee is stated over.
 */
function transcript(rng: Rng): unknown[] {
  return [
    rng.nextU32('transcript.u32'),
    rng.nextFloat('transcript.float'),
    rng.int('transcript.int', -5, 5),
    rng.pick('transcript.pick', POOL),
    rng.shuffle('transcript.shuffle', POOL),
    rng.nextU32('transcript.tail'),
  ];
}

describe('rng determinism', () => {
  it('reproduces an identical stream from the same seed', () => {
    // The whole contract in one assertion: two generators built from the same
    // seed, driven through the same calls, agree on every method's result.
    expect(transcript(createRng('crypt:3'))).toEqual(transcript(createRng('crypt:3')));
    expect(draws(createRng(20260814), 64, 'a')).toEqual(draws(createRng(20260814), 64, 'a'));
  });

  it('treats labels as tracing tags that cannot change the numbers', () => {
    // Labels exist to name a divergence, not to seed one. If a label ever leaked
    // into the state, renaming `combat.crit` would silently rewrite every save —
    // a rename would become a breaking content change with no error anywhere.
    const named = createRng('label-invariance');
    const renamed = createRng('label-invariance');

    const a = [named.nextU32('a'), named.int('b', 0, 100), named.nextFloat('c')];
    const b = [renamed.nextU32('zzz'), renamed.int('yyy', 0, 100), renamed.nextFloat('xxx')];

    expect(a).toEqual(b);
  });

  it('sends different seeds down visibly different streams, from the first draw', () => {
    // Divergence at draw 0, not merely somewhere in the tail: low-entropy seeds
    // (1, 2, 3 — what a test writes) must not start in correlated neighbourhoods
    // of the same stream. That is what the SplitMix conditioning is for.
    const one = draws(createRng(1), 16, 'x');
    const two = draws(createRng(2), 16, 'x');
    expect(one[0]).not.toBe(two[0]);
    expect(one).not.toEqual(two);

    const alpha = draws(createRng('alpha'), 16, 'x');
    const beta = draws(createRng('beta'), 16, 'x');
    expect(alpha[0]).not.toBe(beta[0]);
    expect(alpha).not.toEqual(beta);
  });

  it('does not conflate a numeric seed with its string form', () => {
    // A seed that arrives from an env var is a string; the same seed written in
    // a test is a number. They are different runs, and quietly collapsing them
    // would make a "reproduction" reproduce the wrong world.
    expect(draws(createRng(1), 8, 'x')).not.toEqual(draws(createRng('1'), 8, 'x'));
  });

  it('keeps nextFloat inside [0, 1)', () => {
    // A float that can reach exactly 1 turns `arr[floor(f * arr.length)]` into an
    // out-of-bounds read that noUncheckedIndexedAccess cannot warn about, because
    // it only ever happens on one draw in four billion.
    const rng = createRng('float-range');
    let lowest = 1;
    let highest = 0;
    let outside = 0;
    for (let i = 0; i < 5000; i += 1) {
      const value = rng.nextFloat('roll');
      if (!(value >= 0 && value < 1)) outside += 1;
      lowest = Math.min(lowest, value);
      highest = Math.max(highest, value);
    }
    expect(outside).toBe(0);
    expect(lowest).toBeLessThan(0.01);
    expect(highest).toBeGreaterThan(0.99);
  });
});

describe('rng state round-trip', () => {
  it('resumes the exact stream a saved cursor was taken from', () => {
    // This IS save/load. A generator restored from a serialised cursor must
    // continue the sequence, not restart it — restarting is the bug that gives a
    // reloaded run the same "random" crits it just had.
    const live = createRng('resume');
    draws(live, 5, 'warmup');

    const snapshot = live.getState();
    const continued = draws(live, 8, 'after');

    const restored = rngFromState(snapshot);
    expect(draws(restored, 8, 'after')).toEqual(continued);
    expect(restored.getState()).toEqual(live.getState());
  });

  it('serialises through JSON, which is what a save file and a wire frame are', () => {
    // state and inc are decimal STRINGS specifically because JSON.stringify
    // throws outright on a BigInt. If they ever become bigints, the save path
    // dies at the moment of writing and this test names why.
    const rng = createRng('json-cursor');
    draws(rng, 3, 'warmup');
    const snapshot = rng.getState();

    expect(typeof snapshot.state).toBe('string');
    expect(typeof snapshot.inc).toBe('string');
    expect(() => JSON.stringify(snapshot)).not.toThrow();

    const revived: RngState = JSON.parse(JSON.stringify(snapshot)) as RngState;
    expect(rngFromState(revived).getState()).toEqual(snapshot);
    expect(draws(rngFromState(revived), 6, 'x')).toEqual(draws(rngFromState(snapshot), 6, 'x'));
  });

  it('rewinds a live generator with setState', () => {
    const rng = createRng('rewind');
    const mark = rng.getState();
    const first = draws(rng, 6, 'x');

    rng.setState(mark);
    expect(draws(rng, 6, 'x')).toEqual(first);
  });

  it('carries the diagnostic count and label that name a replay divergence', () => {
    // count + lastLabel are how "the RNG went out of sync somewhere" becomes a
    // call site. They are useless if they do not survive the save boundary.
    const rng = createRng('diagnostics');
    rng.nextU32('world.spawn');
    rng.nextU32('combat.crit');

    const snapshot = rng.getState();
    expect(snapshot.count).toBe(2);
    expect(snapshot.lastLabel).toBe('combat.crit');
    expect(rngFromState(snapshot).getState()).toEqual(snapshot);
  });

  it('rejects a hand-edited cursor rather than silently drifting', () => {
    const rng = createRng('guarded');
    expect(() => rng.setState({ state: 'nope', inc: '1', count: 0, lastLabel: '' })).toThrow();
    expect(() => rng.setState({ state: '1', inc: '1', count: -1, lastLabel: '' })).toThrow(
      RangeError,
    );
    expect(() => rng.setState({ state: '1', inc: '1', count: 1.5, lastLabel: '' })).toThrow(
      RangeError,
    );
  });
});

describe('rng.fork', () => {
  it('does not advance the parent, however hard the child is driven', () => {
    // Named sub-streams exist so that draws made on network timing (a player
    // connecting) cannot shift the numbers combat and generation will draw. If
    // fork advanced the parent, a replay would depend on when somebody's laptop
    // woke up.
    const parent = createRng('fork-parent');
    draws(parent, 3, 'before');
    const beforeFork = parent.getState();

    const child = parent.fork('world.spawn');
    expect(parent.getState()).toEqual(beforeFork);

    draws(child, 100, 'child');
    expect(parent.getState()).toEqual(beforeFork);

    const control = createRng('fork-parent');
    draws(control, 3, 'before');
    expect(draws(parent, 8, 'after')).toEqual(draws(control, 8, 'after'));
  });

  it('gives the same label the same sub-stream and different labels different ones', () => {
    // Reproducibility of a named stream is the point: 'layout:crypt:3' must
    // rebuild the same floor no matter how many combat rolls happened in
    // between. The flip side is the trap the module documents — fork('monster')
    // in a loop hands every monster the identical sequence — so the labels here
    // are deliberately unique per stream.
    const parent = createRng('fork-labels');

    const a1 = draws(parent.fork('monster:7'), 8, 'x');
    const a2 = draws(parent.fork('monster:7'), 8, 'x');
    const b1 = draws(parent.fork('monster:8'), 8, 'x');

    expect(a1).toEqual(a2);
    expect(a1).not.toEqual(b1);
  });

  it('gives a child a stream of its own, not a shifted copy of the parent', () => {
    const parent = createRng('fork-independence');
    const child = parent.fork('layout:crypt:3');
    expect(draws(child, 12, 'x')).not.toEqual(draws(parent, 12, 'x'));
  });
});

describe('rng.int', () => {
  it('never leaves the requested range and reaches both endpoints', () => {
    // BOTH ends inclusive — an off-by-one here is a talent that can never roll
    // its maximum, which nobody reports as a bug because nobody can see it.
    const rng = createRng('int-bounds');
    const seen = new Set<number>();
    let outside = 0;

    for (let i = 0; i < 5000; i += 1) {
      const value = rng.int('loot.tier', 3, 7);
      if (value < 3 || value > 7 || !Number.isInteger(value)) outside += 1;
      seen.add(value);
    }

    expect(outside).toBe(0);
    expect([...seen].sort((a, b) => a - b)).toEqual([3, 4, 5, 6, 7]);
  });

  it('spans a range that crosses zero, and returns the value of a single-value range', () => {
    const rng = createRng('int-negative');
    const seen = new Set<number>();
    let outside = 0;

    for (let i = 0; i < 3000; i += 1) {
      const value = rng.int('drift', -2, 2);
      if (value < -2 || value > 2) outside += 1;
      seen.add(value);
    }

    expect(outside).toBe(0);
    expect([...seen].sort((a, b) => a - b)).toEqual([-2, -1, 0, 1, 2]);
    expect(createRng('int-degenerate').int('fixed', 9, 9)).toBe(9);
  });

  it('refuses bounds it cannot draw uniformly instead of returning a biased number', () => {
    const rng = createRng('int-guards');
    expect(() => rng.int('inverted', 5, 1)).toThrow(RangeError);
    expect(() => rng.int('fractional', 0.5, 3)).toThrow(RangeError);
    expect(() => rng.int('too-wide', 0, 2 ** 32)).toThrow(RangeError);
  });
});

describe('rng.shuffle and rng.pick', () => {
  it('shuffles into a permutation of the input, leaving the input untouched', () => {
    // Generation code passes frozen content arrays in here. A mutating shuffle
    // would corrupt the loaded registry for the rest of the process, and the
    // symptom would be the SECOND floor being wrong, not this call.
    const source = Object.freeze([1, 2, 3, 4, 5, 6, 7, 8]);
    const shuffled = createRng('deck').shuffle('deal', source);

    expect([...shuffled].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(source).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(shuffled).not.toBe(source);
  });

  it('actually reorders, and reorders differently per seed', () => {
    // Guards the degenerate implementation that satisfies "is a permutation" by
    // returning the input in order.
    const source = [1, 2, 3, 4, 5, 6, 7, 8];
    const orders = new Set(
      ['s1', 's2', 's3', 's4'].map((seed) => createRng(seed).shuffle('deal', source).join(',')),
    );

    expect(orders.size).toBeGreaterThan(1);
    expect(orders.has(source.join(','))).toBe(false);
  });

  it('shuffles the same way for the same seed', () => {
    const source = [1, 2, 3, 4, 5, 6, 7, 8];
    expect(createRng('same-deck').shuffle('deal', source)).toEqual(
      createRng('same-deck').shuffle('deal', source),
    );
    expect(createRng('same-deck').shuffle('deal', [])).toEqual([]);
  });

  it('picks only real members, and spends no draw on an empty array', () => {
    // The empty-array path is the dangerous one: consuming a draw there makes
    // the stream depend on whether a loot table happened to be empty, which is
    // content data — so an unrelated content edit would break every replay.
    const rng = createRng('pick');
    const chosen = new Set<string | undefined>();
    for (let i = 0; i < 200; i += 1) {
      chosen.add(rng.pick('class', POOL));
    }
    expect([...chosen].sort()).toEqual(['alchemist', 'enforcer', 'inspector', 'watchman']);

    const before = rng.getState();
    expect(rng.pick('empty', [])).toBeUndefined();
    expect(rng.getState()).toEqual(before);
  });
});
