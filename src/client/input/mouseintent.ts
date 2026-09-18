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
import { canRoute } from '../../shared/level.ts';
import { isHostileBody, isTownsfolkBody, liveActorAt } from './travel.ts';
import type { Dir, TileXY } from '../../shared/coords.ts';
import type { ActorView, LevelView } from '../../shared/protocol.ts';

/**
 * The four things a left-click can mean. An object plus a derived type rather
 * than an `enum`: `erasableSyntaxOnly` is on because Node type-strips this
 * project directly, and an enum emits runtime code.
 */
export const MouseIntentKind = {
  /** Attack by walking into them. One `move`, and nothing else. */
  Bump: 'bump',
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * OPEN A CONVERSATION. One `talk`, and it names a PERSON rather than a tile.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Asked for as *"if you are adjacent to a friendly npc, you should be able to
   * click them to open the dialogue box. the right click option to talk should
   * still exist."* Both halves are kept: this is the left-click door, and
   * ui/verbs.ts's `Talk to` row is untouched.
   *
   * IT IS `Bump`'s TWIN AND IT DELIBERATELY SITS ABOVE IT. Adjacency plus a live
   * body is the same test; which of the two it means is decided by who the body
   * is, and it is decided HERE rather than in the event handler for this file's
   * standing reason — "clicking an ally must not offer an attack" is a test, not
   * a click-through.
   */
  Talk: 'talk',
  /** Start the travel state machine. */
  Travel: 'travel',
  /** Nothing to do, and a sentence saying why. */
  None: 'none',
} as const;
export type MouseIntentKind = (typeof MouseIntentKind)[keyof typeof MouseIntentKind];

export type MouseIntent =
  | { readonly kind: typeof MouseIntentKind.Bump; readonly dir: Dir }
  | {
      readonly kind: typeof MouseIntentKind.Talk;
      /**
       * THE PERSON, NEVER THE TILE — `TalkSchema` in shared/protocol.ts takes an
       * actor id for the reason main.ts's `MapVerb.Talk` states: if she steps
       * aside between the click and the frame, the honest answer is "there is
       * nobody there" rather than a conversation with whoever moved in.
       */
      readonly targetId: string;
    }
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
  /**
   * The tiles this viewer has seen on this map, keyed `"x,y"` — every tile the
   * server's windows showed, and all it remembers, as `client/vision.ts` keeps
   * them. Travel may only end on one.
   */
  readonly hasSeen: ReadonlySet<string>;
};

/**
 * MAY TRAVEL END HERE? On ground this viewer has seen, that `canRoute` admits.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * IT WAS `canWalk`, AND A DOOR IS WHY IT IS NOT ANY MORE
 * ═══════════════════════════════════════════════════════════════════════════
 * A shut door fails `canWalk` — you cannot stand in one — and on that reading
 * every door on the map was a wall to this predicate: the verb menu greyed its
 * Travel row over one, a minimap click on one answered *"you cannot walk
 * there"*, and auto-explore, which floods on this same function, treated the ten
 * doorways of a works floor as ten walls and called the building finished with
 * half its rooms unentered.
 *
 * None of that was true of the walk. `scheduler.ts`'s Move case swings a door
 * the moment a body walks into it, for no energy, and the step is then taken on
 * the next ask — so a route that ends on a door ends with the player standing in
 * an OPEN doorway. "May travel end here" is therefore yes, and was only ever
 * answered no because the tile's code at the moment of asking said so.
 *
 * `canRoute` is upstream's `couldpass` (`tome/class/Grid.lua:89-92`) and it is
 * the whole change: one predicate, one edit, and the four call sites that share
 * it — click, minimap click, verb menu, auto-explore — all corrected together,
 * which is precisely the property this function exists to have.
 *
 * ===========================================================================
 * AND THE "HAS THIS TILE BEEN SEEN" CLAUSE HAS LANDED HERE, AS IT WAS MEANT TO
 * ===========================================================================
 * This note said the clause would land in this one predicate, and then found it
 * could not: the client kept two memories — a disc for the map, a sight sweep
 * for the playfield — and a click gated on either would disagree with a surface
 * drawn from the other. There is one memory now, the server's, and every
 * surface draws it: the playfield, the minimap and the region map.
 *
 * So travel may end only on a tile this viewer has seen, as this port ruled.
 *
 * ═══ SEEN, NOT REMEMBERED — AND A DARK CAVE IS WHERE THE TWO PART ═══
 * This read "remembers", and while every level was lit that was the same set.
 * It is not in the dark: a lantern SHOWS the floor round the body and memory
 * keeps only the lit or `alwaysRemembered` part of it (`shared/vision.ts`, after
 * upstream's `applyLite`), which in a cave is the walls. So every click on the
 * floor a player could see, the tile beside them included, was "you have not
 * seen that ground", and a player on the mouse could not move in a delve at
 * all. Upstream's `use_has_seen` asks `has_seens`, which every light sets, and
 * `hasSeen` is that set. What is DRAWN is still memory.
 *
 * ═══ UPSTREAM DOES NOT REFUSE; IT ASSUMES ═══
 * ToME's click-to-move paths with `use_has_seen` (PlayerMouse.lua:71), and its
 * A* counts a grid the player has not seen as open (engine/Astar.lua:128-134).
 * That is safe there because its client never holds terrain it has not shown.
 * This client is sent the whole map, so a route that found or failed to find a
 * way through the dark would say what is in it. Refusing the destination keeps
 * the dark dark.
 * Every caller shares it: the click, the minimap click and hover, the verb menu
 * and auto-explore. Explore is not starved by it: its flood walks seen ground
 * and heads for the edge of it, which is a seen tile beside an unseen one.
 */
export function travelTargetAllowed(
  level: LevelView,
  tile: TileXY,
  hasSeen: ReadonlySet<string>,
): boolean {
  return canRoute(level, tile.x, tile.y) && hasSeen.has(`${String(tile.x)},${String(tile.y)}`);
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
  const adjacent = chebyshev(self, tile) === 1;

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * ADJACENT AND SOMEBODY WHO LIVES HERE: the conversation, and it is FIRST.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * ABOVE THE BUMP BECAUSE THE BUMP WOULD OTHERWISE TAKE IT. `isHostileBody` is
   * `kind !== Player` and a townsfolk is a `Monster` on the server, so she has
   * always fallen into the branch below — and what that produced was a
   * `{t:'move'}` into her tile, which `resolveIntent` hands to `tryMove` because
   * `areEnemies` refuses a townsfolk, which comes back `Occupied`. So the click
   * this replaces was a REFUSAL with a sentence, on the one body in the game a
   * player most wants to click. Nothing anybody relies on is taken: the ally
   * case, the corpse case, the wall case and every travel case below are
   * untouched, and this branch cannot be reached by any body without a faction
   * on the wire.
   *
   * OUT OF REACH IS UNCHANGED. Two tiles away she is still a `Travel` that stops
   * short — the same walk-up-to that clicking any occupied tile has always
   * meant, and the same thing ui/verbs.ts's greyed `Talk to` row teaches: one
   * more step really does make it work. Nothing new is greyed and nothing new
   * refuses.
   */
  if (adjacent && occupant !== undefined && isTownsfolkBody(occupant)) {
    return { kind: MouseIntentKind.Talk, targetId: occupant.id };
  }

  // ADJACENT AND HOSTILE: the bump. Chebyshev because a diagonal step costs the
  // same as an orthogonal one everywhere in this game, and `step` reaches all
  // eight neighbours.
  if (adjacent && occupant !== undefined && isHostileBody(occupant)) {
    // The sanctioned idiom (main.ts:1758-1762), never a hand-rolled dx/dy table.
    const dir = DIR_ORDER.find((candidate) => sameTile(step(self, candidate), tile));
    if (dir !== undefined) return { kind: MouseIntentKind.Bump, dir };
  }

  if (!canRoute(level, tile.x, tile.y)) return none('that is a wall');
  // A DIFFERENT SENTENCE, because it is a different reason: the ground may be
  // open, and nothing on this client says so.
  if (!travelTargetAllowed(level, tile, snapshot.hasSeen)) {
    return none('you have not seen that ground');
  }
  return { kind: MouseIntentKind.Travel, to: tile, stopShort: occupant !== undefined };
}
