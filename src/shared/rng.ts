/**
 * The seeded PRNG. PCG32 (PCG-XSH-RR, 64-bit state, 32-bit output).
 *
 * This is the ONLY source of randomness in the project. `Math.random` is banned
 * by ESLint across src/shared/ and the engine, and `crypto.getRandomValues` does
 * not exist here at all (tsconfig.shared.json ships no host types). The reason
 * is replay: given a run seed and an action log, the engine must reproduce a
 * world state exactly, on any machine, months later. One unlabelled
 * `Math.random()` anywhere in the call graph silently ends that guarantee, and
 * the failure only surfaces when a save loads into a different dungeon.
 *
 * WHY PCG32
 *   - The entire generator state is two 64-bit integers, so a save file carries
 *     the cursor rather than a re-derivation recipe. Reload continues the exact
 *     stream instead of restarting it.
 *   - It has real stream separation (the `inc` odd increment), so `fork` yields
 *     an independent sequence rather than a shifted copy of the parent's.
 *   - It is a dozen lines and easy to verify against the reference C.
 *
 * WHY BigInt
 *   JavaScript has no uint64: `2 ** 53` is where Number stops being exact, and
 *   PCG's multiply-accumulate needs the full 64 bits of wraparound. BigInt gives
 *   exact 64-bit arithmetic at a cost of roughly an order of magnitude versus
 *   Number math. That cost is irrelevant here — this is a turn-based game with
 *   under ten players where a busy turn draws a few hundred numbers, not a
 *   particle system. The alternative (a 32-bit LCG/xorshift in Number) would be
 *   faster and measurably worse: shorter period, no stream separation, and a
 *   low-bit correlation that shows up as suspiciously streaky crit rolls.
 *
 * WHY EVERY DRAW TAKES A LABEL
 *   `int('level.width', 1, 10)` rather than `int(1, 10)`. The label does NOT
 *   affect the numbers — the stream depends only on the state and the sequence
 *   of calls — it is a tracing tag. When a replay diverges, the two runs are
 *   compared by draw ordinal, and `{ count: 482, lastLabel: 'combat.crit' }`
 *   turns "the RNG went out of sync somewhere" into a call site. Both fields are
 *   part of the serialised state so this survives a save/load boundary.
 *
 *   Corollary: labels are free at runtime but not free to change. Renaming one
 *   never alters a replay; adding or removing a DRAW always does.
 */

const MASK64 = 0xffff_ffff_ffff_ffffn;
const MASK32 = 0xffff_ffffn;

/** The PCG / Knuth MMIX 64-bit LCG multiplier, verbatim from the reference C. */
const PCG_MULT = 6364136223846793005n;

/** 2^32 as an exact Number — the modulus for the unbiased bounded draw below. */
const TWO_POW_32 = 4294967296;

const FNV_OFFSET_BASIS = 0xcbf2_9ce4_8422_2325n;
const FNV_PRIME = 0x0000_0100_0000_01b3n;

/** SplitMix64 constants (Steele/Lea/Flood), used only to condition seeds. */
const SPLITMIX_GAMMA = 0x9e37_79b9_7f4a_7c15n;
const SPLITMIX_MIX_A = 0xbf58_476d_1ce4_e5b9n;
const SPLITMIX_MIX_B = 0x94d0_49bb_1331_11ebn;

/** Arbitrary distinct odd constants that keep derived values from colliding. */
const STREAM_SALT = 0xda3e_39cb_94b9_5bdbn;
const FORK_SALT = 0x5851_f42d_4c95_7f2dn;

/**
 * A generator's complete, serialisable cursor.
 *
 * `state` and `inc` are DECIMAL STRINGS, not numbers: they are 64-bit values and
 * `JSON.stringify` throws outright on a BigInt. Strings round-trip through a
 * save file, a WebSocket frame and a test fixture unchanged.
 */
export type RngState = {
  /** 64-bit LCG state as a decimal string. */
  readonly state: string;
  /** 64-bit stream increment as a decimal string. Always odd. */
  readonly inc: string;
  /** How many 32-bit draws this generator has produced. Diagnostics only. */
  readonly count: number;
  /** Label of the most recent draw; empty before the first. Diagnostics only. */
  readonly lastLabel: string;
};

export type Rng = {
  /** A raw 32-bit draw, 0 .. 4294967295. Every other method is built on this. */
  nextU32(label: string): number;
  /** A float in [0, 1). One draw, so it carries 32 bits of resolution. */
  nextFloat(label: string): number;
  /** Uniform integer in [minInclusive, maxInclusive]. BOTH ends inclusive. */
  int(label: string, minInclusive: number, maxInclusive: number): number;
  /** A uniform element, or undefined for an empty array (no draw is consumed). */
  pick<T>(label: string, arr: readonly T[]): T | undefined;
  /** A shuffled COPY. The input is never mutated. */
  shuffle<T>(label: string, arr: readonly T[]): T[];
  /** An independent named sub-stream. Does NOT advance this generator. */
  fork(label: string): Rng;
  getState(): RngState;
  setState(next: RngState): void;
};

function splitmix64(input: bigint): bigint {
  let z = (input + SPLITMIX_GAMMA) & MASK64;
  z = ((z ^ (z >> 30n)) * SPLITMIX_MIX_A) & MASK64;
  z = ((z ^ (z >> 27n)) * SPLITMIX_MIX_B) & MASK64;
  return (z ^ (z >> 31n)) & MASK64;
}

/**
 * FNV-1a over the string's UTF-16 code units, low byte first.
 *
 * Hand-rolled because `TextEncoder` does not exist in src/shared/ and a hash
 * from a dependency would be a dependency. Code units rather than UTF-8 bytes
 * keeps it independent of any encoder: the same JS string hashes identically on
 * every engine.
 */
function fnv1a64(text: string): bigint {
  let hash = FNV_OFFSET_BASIS;
  for (let i = 0; i < text.length; i += 1) {
    const unit = text.charCodeAt(i);
    hash = ((hash ^ BigInt(unit & 0xff)) * FNV_PRIME) & MASK64;
    hash = ((hash ^ BigInt((unit >> 8) & 0xff)) * FNV_PRIME) & MASK64;
  }
  return hash;
}

/**
 * Any seed the caller can express, reduced to 64 bits, deterministically.
 *
 * Safe integers map straight through (negatives wrap into u64, which is what
 * `asUintN` is for). Everything else — a float, a huge magnitude, NaN, Infinity
 * — is hashed via its string form rather than silently rounded, so two distinct
 * seeds cannot quietly become the same run.
 */
function hashSeed(seed: number | string): bigint {
  if (typeof seed === 'string') return fnv1a64(seed);
  if (Number.isSafeInteger(seed)) return BigInt.asUintN(64, BigInt(seed));
  return fnv1a64(String(seed));
}

function advance(state: bigint, inc: bigint): bigint {
  return (state * PCG_MULT + inc) & MASK64;
}

/**
 * PCG's XSH-RR output permutation: xorshift down to 32 bits, then rotate by the
 * top 5 bits of the state. The rotate amount coming from the state itself is the
 * thing that kills the low-bit lattice a bare LCG has.
 */
function outputU32(state: bigint): number {
  const xorshifted = Number((((state >> 18n) ^ state) >> 27n) & MASK32);
  const rot = Number(state >> 59n);
  return ((xorshifted >>> rot) | (xorshifted << ((32 - rot) & 31))) >>> 0;
}

/**
 * The one seeding path — `createRng` and `fork` both come through here, so a
 * forked generator is seeded exactly as carefully as a top-level one.
 *
 * Mirrors `pcg32_srandom_r`: zero the state, set an odd increment, step, add the
 * seed, step again. The two SplitMix passes exist because low-entropy seeds (0,
 * 1, 2 — exactly what a test writes) would otherwise start in correlated
 * neighbourhoods of the same stream.
 */
function seedStream(entropy: bigint): { state: bigint; inc: bigint } {
  const initState = splitmix64(entropy);
  const initSeq = splitmix64((entropy ^ STREAM_SALT) & MASK64);
  const inc = ((initSeq << 1n) | 1n) & MASK64;
  let state = advance(0n, inc);
  state = (state + initState) & MASK64;
  state = advance(state, inc);
  return { state, inc };
}

const DECIMAL_U64 = /^\d+$/;

function parseU64(text: string, field: string): bigint {
  if (!DECIMAL_U64.test(text)) {
    throw new Error(`rng.setState: ${field} must be a decimal string, got ${JSON.stringify(text)}`);
  }
  return BigInt(text) & MASK64;
}

function makeRng(seeded: { state: bigint; inc: bigint }): Rng {
  let state = seeded.state;
  let inc = seeded.inc;
  let count = 0;
  let lastLabel = '';

  const nextU32 = (label: string): number => {
    // Output is derived from the CURRENT state and the state is advanced after,
    // exactly as in pcg32_random_r. Swapping the order produces a different
    // (still valid) stream that no reference vector will match.
    const current = state;
    state = advance(current, inc);
    count += 1;
    lastLabel = label;
    return outputU32(current);
  };

  /**
   * Unbiased draw in [0, bound). `bound` must be 1 .. 2^32.
   *
   * `r % bound` alone is biased whenever bound does not divide 2^32 — with a
   * d20 that is a ~0.0000005% skew and irrelevant, but the same helper backs
   * loot tables and shuffles, and rejection sampling costs one comparison in the
   * overwhelmingly common case. Rejecting the first `2^32 mod bound` values
   * leaves an exactly uniform remainder.
   */
  const bounded = (label: string, bound: number): number => {
    const threshold = (TWO_POW_32 - bound) % bound;
    let r = nextU32(label);
    while (r < threshold) {
      r = nextU32(label);
    }
    return r % bound;
  };

  const int = (label: string, minInclusive: number, maxInclusive: number): number => {
    if (!Number.isInteger(minInclusive) || !Number.isInteger(maxInclusive)) {
      throw new RangeError(`rng.int(${label}): bounds must be integers`);
    }
    if (maxInclusive < minInclusive) {
      throw new RangeError(`rng.int(${label}): max ${maxInclusive} < min ${minInclusive}`);
    }
    const span = maxInclusive - minInclusive + 1;
    if (span > TWO_POW_32) {
      // A 32-bit generator cannot cover a wider span in one draw, and silently
      // returning a biased value would be worse than refusing.
      throw new RangeError(`rng.int(${label}): span ${span} exceeds 2^32`);
    }
    return minInclusive + bounded(label, span);
  };

  const rng: Rng = {
    nextU32,
    nextFloat: (label: string): number => nextU32(label) / TWO_POW_32,
    int,

    pick: <T>(label: string, arr: readonly T[]): T | undefined => {
      if (arr.length === 0) return undefined;
      return arr[bounded(label, arr.length)];
    },

    shuffle: <T>(label: string, arr: readonly T[]): T[] => {
      // Fisher-Yates, back to front, on a copy: generation code passes frozen
      // content arrays in here and a mutating shuffle would corrupt the loaded
      // registry for the rest of the process.
      const out = arr.slice();
      for (let i = out.length - 1; i > 0; i -= 1) {
        const j = bounded(label, i + 1);
        const a = out[i];
        const b = out[j];
        // Both indices are in range by construction. The guard exists only
        // because noUncheckedIndexedAccess cannot prove that, and a `!` here
        // would be the kind of shortcut this project bans on purpose.
        if (a !== undefined && b !== undefined) {
          out[i] = b;
          out[j] = a;
        }
      }
      return out;
    },

    /**
     * A named sub-stream, derived purely from (current state, inc, label).
     *
     * fork does NOT advance this generator, and forking the same label at the
     * same point twice yields the same child. That is the property the named
     * streams in docs/data-schemas.md need: 'layout:<zone>:<depth>' must rebuild
     * an identical floor no matter how many combat rolls happened in between.
     *
     * Therefore the label must be UNIQUE PER STREAM. `fork('monster')` inside a
     * loop hands every monster the same sequence; `fork(`monster:${id}`)` is what
     * you meant.
     */
    fork: (label: string): Rng =>
      makeRng(seedStream(splitmix64((state ^ inc ^ fnv1a64(label) ^ FORK_SALT) & MASK64))),

    getState: (): RngState => ({
      state: state.toString(),
      inc: inc.toString(),
      count,
      lastLabel,
    }),

    setState: (next: RngState): void => {
      const parsedState = parseU64(next.state, 'state');
      const parsedInc = parseU64(next.inc, 'inc');
      if (!Number.isSafeInteger(next.count) || next.count < 0) {
        throw new RangeError('rng.setState: count must be a non-negative safe integer');
      }
      state = parsedState;
      // Forced odd: PCG's period argument depends on it, and an even increment
      // from a hand-edited save would quietly halve the stream's quality rather
      // than fail.
      inc = parsedInc | 1n;
      count = next.count;
      lastLabel = next.lastLabel;
    },
  };

  return rng;
}

/**
 * Create a generator from a seed.
 *
 * Strings are the intended form for run seeds ('layout:crypt:3') because they
 * are self-documenting in a save file and in a bug report; numbers are there for
 * tests. Same seed plus same call sequence gives the same numbers on every
 * machine, forever — that is the whole contract of this module.
 */
export function createRng(seed: number | string): Rng {
  return makeRng(seedStream(hashSeed(seed)));
}

/**
 * Restore a generator from a serialised cursor — the save-file path.
 *
 * Separate from `createRng` because a restored generator has no seed: the seed
 * produced the cursor once and is not recoverable from it.
 */
export function rngFromState(state: RngState): Rng {
  const rng = createRng(0);
  rng.setState(state);
  return rng;
}
