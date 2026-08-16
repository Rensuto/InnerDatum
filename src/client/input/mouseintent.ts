/**
 * WHAT DOES A PLAIN LEFT-CLICK ON THIS TILE MEAN RIGHT NOW?
 *
 * One pure function over a plain data snapshot. No renderer, no socket, no
 * camera, no DOM: main.ts turns a pointer event into a tile and a tile into an
 * intent HERE, then decides what to send. Keeping the decision separate from the
 * event is what lets "clicking an ally must not offer an attack" be a test
 * instead of a click-through.
 *
 * ===========================================================================
 * EVERY CHECK IN THIS FILE IS ADVISORY. THE SERVER RE-VALIDATES ALL OF IT.
 * ===========================================================================
 * input/targeting.ts's contract, again. Nothing below gates a frame on its own
 * arithmetic — the worst a wrong answer costs is one refused move and a sentence
 * from the server. What it buys is that the player is not told something FALSE
 * before they spend a turn on it.
 *
 * ---------------------------------------------------------------------------
 * THERE IS NO ATTACK INTENT, AND THAT IS WHY `bump` IS A DIRECTION
 * ---------------------------------------------------------------------------
 * Attacking is walking into somebody. `resolveIntent` (scheduler.ts:1118-1121)
 * checks the destination tile for a HOSTILE occupant and strikes it BEFORE it
 * consults terrain, so `{t:'move',dir}` into a husk is the attack input and no
 * protocol addition is needed for a click-to-attack.
 *
 * The corollary is the one rule this file exists to get right: THAT BRANCH IS
 * `isHostile` ONLY. An ally on the destination tile falls through to `tryMove`
 * and is refused as `Occupied`, and a corpse does not block at all. So offering
 * "attack" over a friend would teach the player a rule the game does not have,
 * and they would learn it by wasting a turn.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT DOES NOT ANSWER
 * ---------------------------------------------------------------------------
 * Right-click. The verb menu is a different question with a different answer per
 * target kind, and it lives with the menu. This is the plain left-click only.
 */

import { DIR_ORDER, chebyshev, inBounds, sameTile, step } from '../../shared/coords.ts';
import { canWalk } from '../../shared/level.ts';
import { isHostileBody, liveActorAt } from './travel.ts';
import type { Dir, TileXY } from '../../shared/coords.ts';
import type { ActorView, LevelView } from '../../shared/protocol.ts';

/**
 * The three things a left-click can mean. An object plus a derived type rather
 * than an `enum`: `erasableSyntaxOnly` is on because Node type-strips this
 * project directly, and an enum emits runtime code.
 */
export const MouseIntentKind = {
  /** Attack by walking into them. One `move`, and nothing else. */
  Bump: 'bump',
  /** Start the travel state machine. */
  Travel: 'travel',
  /** Nothing to do, and a sentence saying why. */
  None: 'none',
} as const;
export type MouseIntentKind = (typeof MouseIntentKind)[keyof typeof MouseIntentKind];

export type MouseIntent =
  | { readonly kind: typeof MouseIntentKind.Bump; readonly dir: Dir }
  | {
      readonly kind: typeof MouseIntentKind.Travel;
      readonly to: TileXY;
      /** Stop one tile short — see `mouseIntentAt`. */
      readonly stopShort: boolean;
    }
  | {
      readonly kind: typeof MouseIntentKind.None;
      /**
       * THE SENTENCE main.ts PASSES TO `showNotice`. Always non-empty, always a
       * reason rather than a refusal ("that is a wall", not "invalid target") —
       * a click that silently does nothing is indistinguishable from a click
       * that was not registered, which is the bug report this field prevents.
       */
      readonly reason: string;
    };

/** Everything the answer depends on. Nulls mean "before `welcome`". */
export type MouseSnapshot = {
  /** The viewer's own tile. */
  readonly self: TileXY | null;
  /** The clicked tile, already converted from the pointer by main.ts. */
  readonly tile: TileXY;
  /** Every body the client knows about, corpses included. */
  readonly actors: readonly ActorView[];
  readonly level: LevelView | null;
};

/**
 * MAY TRAVEL END HERE? Today: exactly `canWalk`.
 *
 * ===========================================================================
 * THIS IS THE SINGLE PLACE AN M6 "HAS THIS TILE BEEN SEEN" CLAUSE LANDS
 * ===========================================================================
 * There is no fog of war on the wire yet — `projectLevel` sends the whole map
 * and `projectActors` returns every actor, both labelled FOV SEAM in
 * src/server/view/projector.ts — so "can I click into the dark" is currently a
 * vacuous question. It will not stay vacuous, and the cost of that landing must
 * be one clause in one predicate.
 *
 * SO NOTHING ELSE IN THIS FEATURE MAY ASK THE QUESTION DIRECTLY. Not the click
 * handler, not the path preview, not the verb menu: they call this. A second
 * site that tests `canWalk` for the same purpose is a site that will still allow
 * travel into unexplored dark on the day this one stops.
 */
export function travelTargetAllowed(level: LevelView, tile: TileXY): boolean {
  return canWalk(level, tile.x, tile.y);
}

function none(reason: string): MouseIntent {
  return { kind: MouseIntentKind.None, reason };
}

/**
 * The whole decision, in the order the player needs it answered.
 *
 * `stopShort` is true whenever a LIVE body stands on the clicked tile, hostile
 * or friendly, because in neither case may the walk end there: stepping onto a
 * hostile is an ATTACK (a turn the player did not ask for by clicking three
 * tiles away — the "walk up to" verb is deliberately not an auto-attack), and
 * stepping onto an ally is refused as `Occupied`. A corpse is neither: it does
 * not block, so travel walks over it.
 */
export function mouseIntentAt(snapshot: MouseSnapshot): MouseIntent {
  const { self, tile, actors, level } = snapshot;
  if (level === null || self === null) return none('the floor has not arrived yet');
  if (!inBounds(tile.x, tile.y, level.w, level.h)) return none('that is off the map');
  // main.ts may choose to swallow this one — a click on your own token does
  // nothing at all — but the sentence exists so a caller that wants to say
  // something is not left inventing it.
  if (sameTile(self, tile)) return none('you are already standing there');

  const occupant = liveActorAt(actors, tile);

  // ADJACENT AND HOSTILE: the bump. Chebyshev because a diagonal step costs the
  // same as an orthogonal one everywhere in this game, and `step` reaches all
  // eight neighbours.
  if (chebyshev(self, tile) === 1 && occupant !== undefined && isHostileBody(occupant)) {
    // The sanctioned idiom (main.ts:669-672), never a hand-rolled dx/dy table.
    const dir = DIR_ORDER.find((candidate) => sameTile(step(self, candidate), tile));
    if (dir !== undefined) return { kind: MouseIntentKind.Bump, dir };
  }

  if (!travelTargetAllowed(level, tile)) return none('that is a wall');
  return { kind: MouseIntentKind.Travel, to: tile, stopShort: occupant !== undefined };
}
