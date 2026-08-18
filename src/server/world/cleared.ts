// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Authored for this game.

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *        DID THE PARTY JUST CLEAR THIS ROOM? FOUR FACTS, ONE ANSWER.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A PURE FUNCTION BECAUSE I GOT IT WRONG THREE TIMES IN A ROW, and each wrong
 * version shipped a line into a live log before a driven session caught it:
 *
 *   1. A LEVEL, NOT AN EDGE. "No monsters and somebody watching" is true of a
 *      room that was just RESET as well as one that was just cleared, and
 *      `resetFloor` reaps every monster when a party wipes. The breach
 *      announced itself quiet in the middle of a defeat.
 *   2. AN EDGE, BUT ANY EMPTYING. Adding "many, then none" did not help: a
 *      wipe is also many, then none.
 *   3. AN EDGE PLUS A DEATH — but the PLAYER'S death is a death. A solo player
 *      killed by the last husk satisfied "something died", the reset emptied
 *      the room, and the room congratulated them over their own corpse. Four
 *      runs out of four.
 *
 * The version that survives is: the room HAD residents, has none now, a
 * MONSTER died in the pump that emptied it, and somebody is still on their
 * feet to be told. Every one of those clauses is load-bearing and three of them
 * were learned by shipping the version without them.
 *
 * It lives here, exported and pure, so the next person to touch it can see all
 * four cases fail in a test rather than in a log at midnight.
 */
export type ClearedFacts = {
  /** Living residents at the previous pump of this realm. */
  readonly previous: number;
  /** Living residents now. */
  readonly standing: number;
  /**
   * A MONSTER died in the pump just resolved. Not "a death happened" — see the
   * header, case 3.
   */
  readonly sawMonsterKill: boolean;
  /** Players present, alive, and not down. A body being carried is not a witness. */
  readonly standingPlayers: number;
  /** Already announced for this realm. The moment happens once. */
  readonly already: boolean;
};

export function shouldAnnounceCleared(facts: ClearedFacts): boolean {
  if (facts.already) return false;
  if (facts.standing > 0) return false;
  if (facts.previous === 0) return false;
  if (!facts.sawMonsterKill) return false;
  return facts.standingPlayers > 0;
}
