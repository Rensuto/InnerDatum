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

  it('pins PROTOCOL_VERSION at 8 — the class chooser', () => {
    // AN EXPLICIT PIN, so the bump cannot be silently reverted by a merge.
    // Everything above only asserts the constants are positive integers, which
    // a revert would pass. v8 added `choose_class` inbound and `class_options`
    // outbound. Neither half forces a bump by this file's usual rule — an
    // inbound verb an old client never sends costs it nothing, and an optional
    // `InspectView.className` is an addition it can ignore. What forces it is
    // that THE FALLBACK IS A WRITE: a v7 client draws no picker, is assigned a
    // class by rotation, and `saveNow('join')` persists it — after which the
    // chooser never appears again, on any client, forever. A single connection
    // on a stale bundle is a one-way door, and the version gate turns it into an
    // honest refusal. The bump log in src/shared/version.ts is the long version.
    expect(PROTOCOL_VERSION).toBe(8);
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
