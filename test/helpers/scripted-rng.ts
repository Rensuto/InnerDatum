import type { Rng, RngState } from '../../src/shared/rng.ts';

/**
 * An `Rng` that hands back a written-down list of numbers, in order, and throws
 * the moment anything asks for one more than the script provides.
 *
 * The combat pipeline's correctness is entirely about WHICH stage draws and in
 * WHAT ORDER — a miss must cost exactly one draw, the damage range must be
 * rolled before armour, and a crit must be rolled after it. Seeding the real
 * PCG32 would produce reproducible numbers but would not let a test say "and
 * then nothing else drew", which is half of what needs pinning. Running out of
 * script is therefore a FAILURE, not a wrap-around.
 *
 * Not a mock of the RNG's maths — it is a probe on the call sequence.
 */
export function scriptedRng(rolls: readonly number[]): Rng {
  let cursor = 0;
  const labels: string[] = [];

  const next = (label: string): number => {
    const value = rolls[cursor];
    if (value === undefined) {
      throw new Error(
        `scriptedRng: draw #${cursor + 1} ('${label}') was requested but the script has ` +
          `${rolls.length}. Either a stage drew that should not have, or the script is short.`,
      );
    }
    cursor += 1;
    labels.push(label);
    return value;
  };

  const rng: Rng = {
    nextU32: (label: string): number => next(label),
    nextFloat: (label: string): number => next(label),
    int: (label: string): number => next(label),
    pick: <T>(_label: string, arr: readonly T[]): T | undefined => arr[0],
    shuffle: <T>(_label: string, arr: readonly T[]): T[] => arr.slice(),
    fork: (): Rng => rng,
    getState: (): RngState => ({
      state: '0',
      inc: '1',
      count: cursor,
      lastLabel: labels[cursor - 1] ?? '',
    }),
    setState: (): void => undefined,
  };

  return rng;
}

/** How many draws a scripted generator has served. `count` on its state. */
export function drawCount(rng: Rng): number {
  return rng.getState().count;
}
