import { describe, expect, it } from 'vitest';

import { shouldAnnounceCleared } from '../../src/server/world/cleared.ts';
import type { ClearedFacts } from '../../src/server/world/cleared.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *   THE FOUR CLAUSES, AND THREE OF THEM WERE LEARNED BY SHIPPING WITHOUT THEM
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Every `it` below except the first names a version that actually ran and put
 * a wrong line into a live log. They are written as the failures rather than as
 * the rules, because the rules read as obvious afterwards and the failures do
 * not.
 *
 * ═══ AND ONE FAILURE THIS FILE STRUCTURALLY CANNOT SEE ═══
 * A fifth wrong line shipped after these four, and every test here passed while
 * it did. The predicate was correct: given a room with nothing standing, it
 * said "announce", which was right. The GATEWAY then broadcast that answer
 * before it flushed the pump's own batched Record lines, so a live log read:
 *
 *     An Index Breach is quiet now.
 *     2 damage. Index Husk 0/25.
 *     Index Husk is unfiled.
 *
 * — the room falling silent above the blow that silenced it, deterministically,
 * every time. A pure function of `ClearedFacts` has no access to the question
 * "when was the frame carrying this sent", so no test in this file could ever
 * fail on it. `tools/status-live.mjs` reads frame ORDER off a real socket and
 * checks exactly that; the fix was moving one call below `broadcastRecord` in
 * net/gateway.ts. Kept here because the next person to extend this file will
 * reasonably assume it covers the whole beat, and it does not.
 */

/** A room somebody has just cleared, honestly. */
const CLEARED: ClearedFacts = {
  previous: 3,
  standing: 0,
  sawMonsterKill: true,
  standingPlayers: 1,
  already: false,
};

describe('shouldAnnounceCleared', () => {
  it('fires when a party kills the last resident and is still standing', () => {
    // THE POSITIVE CASE, pinned — the whole feature is worthless if the guards
    // are so tight that the moment never arrives. A live driver could not prove
    // this: the solo ambush kills it every time.
    expect(shouldAnnounceCleared(CLEARED)).toBe(true);
  });

  it('says nothing while anything is still up', () => {
    expect(shouldAnnounceCleared({ ...CLEARED, standing: 1 })).toBe(false);
  });

  it('WRONG VERSION 1 — a level, not an edge', () => {
    // "No monsters and somebody watching" is equally true of a room that was
    // just RESET, and `resetFloor` reaps every monster when a party wipes. A
    // room that never had anybody in it has not been cleared.
    expect(shouldAnnounceCleared({ ...CLEARED, previous: 0 })).toBe(false);
  });

  it('WRONG VERSION 2 — an edge, but any emptying', () => {
    // A wipe is also many-then-none. Without a kill in the pump that emptied
    // the room, "the room is empty" describes a defeat exactly as well as a
    // victory.
    expect(shouldAnnounceCleared({ ...CLEARED, sawMonsterKill: false })).toBe(false);
  });

  it('WRONG VERSION 3 — a death, but the PLAYER’S death is a death', () => {
    // A solo player killed by the last husk satisfied "something died", the
    // reset emptied the room, and the breach congratulated them over their own
    // corpse. Four runs out of four. The flag means a MONSTER died.
    const playerDiedAndFloorReset: ClearedFacts = {
      previous: 3,
      standing: 0,
      sawMonsterKill: false,
      standingPlayers: 1,
      already: false,
    };
    expect(shouldAnnounceCleared(playerDiedAndFloorReset)).toBe(false);
  });

  it('says nothing to a room where nobody is left on their feet', () => {
    // Telling a downed player their delve is quiet while they bleed out is the
    // worst line in the game.
    expect(shouldAnnounceCleared({ ...CLEARED, standingPlayers: 0 })).toBe(false);
  });

  it('happens once, not once per pump', () => {
    expect(shouldAnnounceCleared({ ...CLEARED, already: true })).toBe(false);
  });
});
