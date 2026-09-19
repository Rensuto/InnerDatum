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
import { areEnemies } from '../engine/actor.ts';
import { ActorKind } from '../../shared/protocol.ts';
import type { Sided } from '../engine/actor.ts';

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

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *   HOW MANY BODIES ARE STILL A PROBLEM — `standing`, and it counted friends.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The gateway wrote this inline as
 * `a.kind === Monster && a.alive`, which was every monster there was until
 * `Faction.Bound` existed. A Redactor holding her own birth stance is standing
 * next to a Monster that is alive and on her side, so a floor she has emptied
 * reports `standing = 1`, `shouldAnnounceCleared` returns false at its first
 * line, and `filedFor` — whose only write in the whole process sits behind
 * that call — never records the site. The case never closes, silently and
 * permanently. Driven: zero hostiles, one shadow, `standing` 1 and the answer
 * false; the identical facts with `standing: 0` answer true.
 *
 * ═══ THE WITNESS IS THE SECOND ARGUMENT, AND IT IS NOT DECORATION ═══
 * "Hostile" is not a property of a body, it is a relation — `areEnemies`
 * (engine/actor.ts) is the engine's one answer and it takes two sides. Passing
 * a living player makes this the same question every other surface asks, and it
 * covers `Townsfolk` for free: a shopkeeper has never reached the gateway's
 * count only because Inner realms hold none, which is a fact about content and
 * not a rule anybody wrote down.
 *
 * NO WITNESS MEANS COUNT EVERYTHING, which is the reading this had before and
 * cannot announce anything anyway — `standingPlayers` is zero in that case and
 * the last line of `shouldAnnounceCleared` refuses.
 *
 * HERE RATHER THAN IN THE GATEWAY because it is the same rule as the function
 * below and for the same reason: three wrong versions of `standing` would be
 * three wrong versions nobody could put under a test. `Sided` is structural, so
 * this file imports a predicate and not a module graph.
 */
export function standingThreats(
  bodies: readonly (Sided & { readonly alive: boolean })[],
  witness: Sided | undefined,
): number {
  return bodies.filter(
    (body) =>
      body.kind === ActorKind.Monster &&
      body.alive &&
      (witness === undefined || areEnemies(witness, body)),
  ).length;
}

export function shouldAnnounceCleared(facts: ClearedFacts): boolean {
  if (facts.already) return false;
  if (facts.standing > 0) return false;
  if (facts.previous === 0) return false;
  if (!facts.sawMonsterKill) return false;
  return facts.standingPlayers > 0;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *        AND THE OTHER HALF: DID SOMEBODY JUST SET OFF? THREE FACTS.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `shouldAnnounceCleared` says an expedition ENDED, and for a long time it was
 * the only thing the shared overworld ever heard about anybody. Measured with
 * two sockets on the moor: a friend walks off, their token vanishes with no
 * explanation, and the next word about them arrives minutes later as a result.
 *
 * That is backwards for the one feature that makes this a shared world rather
 * than several single-player games in one window. `follow` crosses realms and
 * every row of the party pane carries a Follow button, so the moment worth
 * hearing is the one you can still ACT on. Afterwards it is news; now it is an
 * invitation.
 *
 * It is pure and it is here, next to its twin, because both answer the same
 * question — WHAT DOES THE MOOR GET TOLD — and the failure mode of the first
 * one was a rule that read as obvious and was wrong three times.
 */
export type DepartureFacts = {
  /** They were standing on the shared overworld. Descending a floor is not news. */
  readonly fromOverworld: boolean;
  /**
   * They walked into a DELVE. A town is entered constantly and for shopping,
   * and announcing that is how a channel of real news becomes one nobody reads.
   */
  readonly toDelve: boolean;
  /**
   * Players already inside, counted BEFORE this body is placed.
   *
   * THE WHOLE REASON THIS TAKES A COUNT AND NOT A BOOLEAN. A party of four
   * crosses one body at a time, so the naive version announces four departures
   * for one expedition — and the three who follow their leader in are exactly
   * the case that turns a useful line into noise. First in speaks for the trip.
   */
  readonly alreadyInside: number;
};

export function shouldAnnounceDeparture(facts: DepartureFacts): boolean {
  if (!facts.fromOverworld) return false;
  if (!facts.toDelve) return false;
  return facts.alreadyInside === 0;
}
