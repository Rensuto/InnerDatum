import { describe, expect, it } from 'vitest';

import {
  ENERGY_PER_TICK,
  ENERGY_TO_ACT,
  PROTOCOL_VERSION,
  SCHEMA_VERSION,
  TILE_PX,
} from '../../src/shared/version.ts';

/**
 * These are not "does the constant equal itself" tests. Each one pins an
 * invariant that something else silently depends on, so that changing the
 * number fails here rather than three systems downstream.
 */
describe('shared constants', () => {
  it('grants energy in whole ticks per action, with no remainder', () => {
    // The scheduler advances the world in fixed ticks. If ENERGY_TO_ACT is not
    // an exact multiple of ENERGY_PER_TICK, an actor accrues a fractional
    // surplus that carries across turns and slowly desynchronises the party —
    // precisely the drift the flat-turn energy model exists to prevent.
    expect(ENERGY_TO_ACT % ENERGY_PER_TICK).toBe(0);
    expect(ENERGY_TO_ACT / ENERGY_PER_TICK).toBe(10);
  });

  it('keeps the tile size a power of two', () => {
    // The atlas packer addresses by pure arithmetic (px = index * TILE_PX) and
    // the client upscales by integer factors. A non-power-of-two tile makes
    // both of those produce half-pixel seams.
    expect(TILE_PX).toBe(32);
    expect(Math.log2(TILE_PX) % 1).toBe(0);
  });

  it('pins PROTOCOL_VERSION at 7 — the travelling projectile', () => {
    // AN EXPLICIT PIN, so the bump cannot be silently reverted by a merge.
    // Everything above only asserts the constants are positive integers, which
    // a revert would pass. v7 added the `projectiles` frame; a v6 client cannot
    // name it, draws no orb, and takes the damage three turns later from an
    // invisible source — the counterplay does not exist on that client, which is
    // the CONFIDENTLY WRONG UI this constant exists to refuse. The bump log in
    // src/shared/version.ts is the long version.
    expect(PROTOCOL_VERSION).toBe(7);
  });

  it('exposes versions as positive integers', () => {
    // A float or a zero here would serialise into a save file and make the
    // migration comparison (`saved < SCHEMA_VERSION`) behave unpredictably.
    for (const v of [PROTOCOL_VERSION, SCHEMA_VERSION]) {
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThan(0);
    }
  });
});
