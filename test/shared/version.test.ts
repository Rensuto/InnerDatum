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

  it('keeps the tile size a power of two, and the default upstream uses', () => {
    // The atlas packer addresses by pure arithmetic (px = index * TILE_PX) and
    // the client upscales by integer factors. A non-power-of-two tile makes
    // both of those produce half-pixel seams.
    //
    // 64 IS NOT A TASTE. `tome/class/Game.lua:565-567` parses the configured
    // tileset size and falls back with `if not tw then tw, th = 64, 64 end`,
    // so it is the cell size the game being ported draws at, and the size the
    // orthographic art for this port is authored at. It was 32, and a 64-pixel
    // sprite in a 32-pixel cell is half the picture thrown away every frame.
    expect(TILE_PX).toBe(64);
    expect(Math.log2(TILE_PX) % 1).toBe(0);
  });

  it('pins PROTOCOL_VERSION at 20 — gear says what it does', () => {
    // AN EXPLICIT PIN, so the bump cannot be silently reverted by a merge.
    // Everything above only asserts the constants are positive integers, which
    // a revert would pass. THE JUSTIFICATION MOVES WITH THE NUMBER — a pin whose
    // comment still argues the previous version is worse than no pin, because it
    // reads as deliberate and is not.
    //
    // v11 adds ONE outbound frame, `realm`, and by the rule this file has
    // applied since v5 that alone would NOT force a bump: an outbound frame an
    // old client cannot name is one it ignores, and ignoring it is usually
    // harmless.
    //
    // IT IS NOT HARMLESS HERE, and that is the entire argument. `realm` is the
    // first frame other than `welcome` ever to carry a `LevelView`. For the
    // whole of v1-v10 a client could assume the map handed to it at `hello` was
    // its map for the lifetime of the connection — and every v10 client is
    // ENTITLED to that assumption, because it was true when it was built.
    //
    // A v10 client dropping the frame keeps rendering Alderbrook while the
    // server moves its body into an instance. It draws its own token standing
    // in a canal, its friends walking through terraces, and every step refused
    // by a server reading a different grid. This is the PERMANENTLY-STUCK shape
    // that forced 6 -> 7 and 9 -> 10, in its worst form yet: at 9 -> 10 a coat
    // on the floor announced itself to nobody, but the screen was at least
    // telling the truth about the room. Here the screen itself is the lie.
    //
    // v16 IS A WEAKER CASE THAN v11 AND BUMPS ANYWAY. `InventoryMsg.money` is
    // REQUIRED, and a v15 client would ignore it and draw an inventory with no
    // gold — nothing on screen would be a lie, so this is not the
    // permanently-stuck shape above. It bumps because a silently goldless purse
    // is indistinguishable from a broken drop table, and that is the class of
    // report that costs an evening to chase.
    //
    // v17 IS THE STRONG FORM AGAIN, and it is a bug fix. `PartyStateMember`
    // gains a REQUIRED `away`. A v16 client would keep drawing the pane it drew
    // before — the pane that DROPS a member the moment they cross into an
    // instance — so it would render a lie about who is in your party. That is
    // the 6 -> 7 / 9 -> 10 / 11 shape, not the 15 -> 16 one.
    //
    // v18 IS THE INBOUND HALF DOING THE FORCING. A new outbound frame alone
    // would not bump — a v17 client cannot name `shop`, drops it, and has no
    // shop, which is what it had yesterday and is not a lie. What bumps is
    // `shop_buy` / `shop_sell`: a v17 client would stand in a room where other
    // people are visibly buying things it cannot see, with its own gold moving
    // for reasons it cannot explain. That is a room behaving differently for
    // two people standing in it.
    //
    // v19 IS THE FIRST BUMP WHERE THE OLD CLIENT'S CORRECT BEHAVIOUR IS WHAT
    // BREAKS IT. `RosterMsg` is a new outbound frame, and by the rule above that
    // alone would not force a bump — a v18 client cannot name `roster`, so it
    // drops it. Dropping it is the right thing to do and it is fatal here: the
    // frame is sent INSTEAD OF THE WORLD. No `welcome`, no `realm`, no `state`,
    // and nothing added to the overworld, because the player is standing in a
    // select screen. A v18 client would ignore the only frame it was sent and
    // then sit on a black screen forever, against a healthy server, waiting for
    // a world that is deliberately not coming.
    //
    // Every earlier bump argued about a client drawing a LIE. This one is about
    // a client drawing NOTHING, which is the same failure the gate exists to
    // convert into an honest "your client is out of date".
    expect(PROTOCOL_VERSION).toBe(20);
  });

  it('keeps the 18 -> 19 changelog entry beside the constant, and non-empty', () => {
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

    // THE FULL HEADING, NOT THE BARE NUMBERS. Entries cite each other — the
    // "considered and not bumped" note below argues against its own case by
    // pointing at "(18 -> 19)" — so splitting on the digits alone lands inside
    // whichever paragraph mentions them first and reads the wrong entry.
    const afterHeading = source.split('18 -> 19 (WHO ARE YOU TONIGHT)')[1] ?? '';
    // The entry ends where the constant it explains begins.
    const entry = afterHeading.split('export const PROTOCOL_VERSION')[0] ?? '';

    expect(afterHeading).not.toBe('');
    expect(entry.trim().length).toBeGreaterThan(200);
    // It must name the frame that FORCES the bump, not merely list what was
    // added — an entry that only enumerates additions is an entry arguing for
    // NOT bumping.
    expect(entry).toContain('shop_buy');
    // And it must say what it deliberately did NOT do to the save file, because
    // the reflex when a protocol moves is to move both numbers.
    expect(entry).toContain('SCHEMA_VERSION');
  });

  it('argues the changes that did NOT bump, beside the ones that did', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE DISCIPLINE IS THE ARGUMENT, NOT THE NUMBER MOVING.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * The test above guards a bump's justification. This guards the other half,
     * which is the easier one to lose: a change that touched the wire and was
     * deliberately NOT bumped leaves no trace in the constant, so a later pass
     * finds two optional fields on `DamageEvent`, no entry, and no way to tell
     * whether the previous author thought about it or forgot.
     *
     * `DamageEvent.type` and `.crit` are that change. By this file's own rule a
     * bump is forced when an old client draws a LIE or draws NOTHING; an older
     * client here ignores two keys it cannot name and prints the line it printed
     * before. Bumping anyway would hard-refuse friends who are mid-delve —
     * clients are served fresh on every launch, so the only ones a bump catches
     * are the ones already playing — because the log gained an adjective.
     */
    const source = readFileSync(
      join(import.meta.dirname, '..', '..', 'src', 'shared', 'version.ts'),
      'utf8',
    );
    const entry = source.split('CONSIDERED AND NOT BUMPED')[1]?.split('18 -> 19 (')[0] ?? '';

    expect(entry.trim().length, 'no argument for the fields that did not bump').toBeGreaterThan(
      200,
    );
    // It must name what it added, and say what makes the addition safe.
    expect(entry).toContain('DamageEvent');
    expect(entry, 'the reason it is safe is that the fields are optional').toContain('OPTIONAL');
    // And it must say what a later pass would have to answer to bump — an entry
    // that only says "no" is one the next author has to re-derive.
    expect(entry).toContain('REQUIRED');
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
