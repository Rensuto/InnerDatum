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

  it('pins PROTOCOL_VERSION at 9 — levels, and the panel that spends them', () => {
    // AN EXPLICIT PIN, so the bump cannot be silently reverted by a merge.
    // Everything above only asserts the constants are positive integers, which
    // a revert would pass. THE JUSTIFICATION MOVES WITH THE NUMBER — a pin whose
    // comment still argues the previous version is worse than no pin, because it
    // reads as deliberate and is not.
    //
    // v9 added `spend_point` inbound, `progress` outbound, and four fields on
    // `LoadoutTalent` (`level`, `maxLevel`, `desc`, `descNext`). NONE of those
    // forces a bump by this file's usual rule: an inbound verb an old client
    // never sends costs it nothing, an outbound frame it cannot name is one it
    // ignores, and `loadout` becoming re-sendable is behaviour every shipped
    // client already implements (its docblock always specified wholesale
    // replacement).
    //
    // WHAT FORCES IT IS THAT `LoadoutTalent.range` NARROWED — the same shape as
    // 1 -> 2's `left`, 4 -> 5's `alive` and 5 -> 6's TurnMsg roster. It was a
    // constant of the class, safe to read once at `welcome`; it is now
    // per-actor, because Fog Step's only number IS its range and it scales
    // 3/4/5/6/7 across its ranks. A v8 client draws a three-tile ring around a
    // talent that reaches six and its targeting mode refuses the tiles the
    // player paid three points for — a stale bundle in which spending does
    // visibly nothing, which is the exact trap this milestone exists to avoid.
    // The bump log in src/shared/version.ts is the long version, including the
    // two shapes deliberately avoided: no new `TurnEvent` variant (a level-up
    // narrates as a Record `log` line) and no new `ErrorCode` (a refused spend
    // is `bad_message`).
    expect(PROTOCOL_VERSION).toBe(9);
  });

  it('leaves SCHEMA_VERSION at 1 — the two were considered separately', () => {
    // ASSERTED IN THE SAME FILE AS THE BUMP ABOVE, ON PURPOSE. v9 is the first
    // release where a protocol change and a save-file change land together, and
    // the reflex is to move both numbers. They answer different questions.
    //
    // The persisted character gains OPTIONAL fields only — level, xp and the RAW
    // per-talent points — and docs/data-schemas.md:48-49 reads verbatim: "Adding
    // an *optional* field needs no bump; the bump is for renames, semantic
    // changes, and new required fields." `migrateDoc` compares nothing but this
    // integer, so an optional field cannot make a v1 file fail to load.
    //
    // AND THE ROLLBACK TRADE IS THE REASON TO BE SURE. Not bumping means an
    // older build loads a new file and drops the fields it does not understand,
    // costing a level. Bumping means an older build REFUSES the file and
    // quarantines it, costing a friend an evening they cannot play at all. For a
    // game whose game-design.md § 9 is "no permadeath, no loss", the first is
    // strictly better — and the migration machinery stays a drill for the first
    // genuinely breaking change instead of being spent on this one.
    expect(SCHEMA_VERSION).toBe(1);
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
