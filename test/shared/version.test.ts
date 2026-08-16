import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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

  it('pins PROTOCOL_VERSION at 10 — loot, equipment, and the floor it lies on', () => {
    // AN EXPLICIT PIN, so the bump cannot be silently reverted by a merge.
    // Everything above only asserts the constants are positive integers, which
    // a revert would pass. THE JUSTIFICATION MOVES WITH THE NUMBER — a pin whose
    // comment still argues the previous version is worse than no pin, because it
    // reads as deliberate and is not.
    //
    // v10 added four inbound verbs (`pickup`, `equip`, `unequip`, `drop`) and
    // two outbound frames: `ground` broadcast, `inventory` per-recipient. NONE
    // of the inbound four forces a bump — `respawn` set that precedent at v5 and
    // it has held at every bump since — and `inventory` alone would not either,
    // because an outbound frame an old client cannot name is one it ignores. No
    // `TurnEvent` variant and no `ErrorCode` member were added, both
    // deliberately, so neither of the two shapes this file records as
    // INDEPENDENTLY forcing a bump applies.
    //
    // WHAT FORCES IT IS THE PERMANENTLY-STUCK SHAPE, 5 -> 6's and 6 -> 7's. A v9
    // client cannot name `ground`, so it draws no floor item — and it has no
    // verb with which to take one. Both halves fail at once, which is worse than
    // the orb at 6 -> 7: the orb announced itself by landing on you, and a coat
    // on the floor announces itself to nobody. The drop arrives as a `log` line
    // the client renders as prose it cannot act on, while the party divides loot
    // around it in a voice channel. Every item that drops for that party is gone
    // for the evening, silently, with the screen looking entirely normal.
    //
    // AND INDEPENDENTLY, `ActorView.maxHp` and `InspectView.rows` NARROWED from
    // class facts to class-plus-gear facts once worn items fold onto the combat
    // sheet — the same shape as 8 -> 9's `LoadoutTalent.range`, in the frames
    // every player looks at rather than in one talent's ring. The bump log in
    // src/shared/version.ts is the long version.
    expect(PROTOCOL_VERSION).toBe(10);
  });

  it('keeps the 9 -> 10 changelog entry beside the constant, and non-empty', () => {
    // THE PROSE IS THE DELIVERABLE HERE, NOT DECORATION. Every bump in this file
    // is argued above the constant, and the argument is the only thing that
    // tells the next person whether their change forces a bump or is an addition
    // an old client can ignore. A number that moved with no entry beside it is
    // how that discipline stops — quietly, in one merge.
    //
    // READ FROM DISK RATHER THAN ASSERTED ABOUT AN EXPORT, because the entry is
    // a COMMENT: Node type-strips this project and there is nothing at runtime
    // to inspect. The read happens HERE and never in the module, so src/shared/
    // purity is untouched — CLAUDE.md § 3 bans `fs` from src/shared/, not from
    // the tests that check it. `import.meta.dirname` keeps it working from any
    // cwd, which matters because vitest and the pre-push hook run from
    // different ones.
    const source = readFileSync(
      join(import.meta.dirname, '..', '..', 'src', 'shared', 'version.ts'),
      'utf8',
    );

    const afterHeading = source.split('9 -> 10')[1] ?? '';
    // The entry ends where the constant it explains begins.
    const entry = afterHeading.split('export const PROTOCOL_VERSION')[0] ?? '';

    expect(afterHeading).not.toBe('');
    expect(entry.trim().length).toBeGreaterThan(200);
    // It must name the frame that FORCES the bump, not merely list what was
    // added — an entry that only enumerates additions is an entry arguing for
    // NOT bumping.
    expect(entry).toContain('ground');
    // And it must say what it deliberately did NOT do to the save file, because
    // the reflex when a protocol moves is to move both numbers.
    expect(entry).toContain('SCHEMA_VERSION');
  });

  it('leaves SCHEMA_VERSION at 1 — the two are still considered separately', () => {
    // ASSERTED IN THE SAME FILE AS THE BUMP ABOVE, ON PURPOSE. v9 was the first
    // release where a protocol change and a save-file change landed together and
    // the reflex was to move both numbers; v10 is the second, and the answer is
    // the same because the two constants answer different questions.
    //
    // The persisted character gains OPTIONAL fields only — at v9 level, xp and
    // the raw per-talent points, at v10 `carried` and `equipped` — and
    // docs/data-schemas.md:48-49 reads verbatim: "Adding an *optional* field
    // needs no bump; the bump is for renames, semantic changes, and new required
    // fields." `migrateDoc` compares nothing but this integer, so an optional
    // field cannot make a v1 file fail to load.
    //
    // AND THE ROLLBACK TRADE IS THE REASON TO BE SURE, more lopsidedly at v10
    // than at v9. Not bumping means an older build loads a new file and drops
    // the fields it does not understand, costing an evening's loot. Bumping
    // means an older build REFUSES the file and quarantines it, costing a friend
    // an evening they cannot play at all. For a game whose game-design.md § 9 is
    // "no permadeath, no loss", the first is strictly better — and the migration
    // machinery stays a drill for the first genuinely breaking change instead of
    // being spent on this one.
    //
    // GROUND ITEMS ARE NOT PERSISTED AT ALL, so there is no second save kind, no
    // second version integer and no second migration chain hiding behind this
    // assertion.
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
