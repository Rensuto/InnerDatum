/**
 * WHAT A RIGHT-CLICK OFFERS, DECIDED AS A PURE FUNCTION OF A SNAPSHOT.
 *
 * ===========================================================================
 * WHY THIS IS NOT A CLOSURE INSIDE main.ts
 * ===========================================================================
 * It was: `menuItemsFor` lived in boot() and read four other closures for its
 * answers. That was fine while the only question was "are they in my party" and
 * the only rows were three party verbs. Generalising the menu to the whole map
 * multiplies the cases — four kinds of thing under the cursor, two of which have
 * rows that are conditionally greyed — and a decision table that big buried in a
 * 2000-line file is a decision table nobody can test.
 *
 * So the whole thing is one total function over a plain struct. No canvas, no
 * DOM, no socket, no clock. vitest.config.ts is explicit that the environment is
 * `node` with deliberately no jsdom, and test/client/turncards.test.ts and
 * partypanel.test.ts are the house precedent: test the client's DECISIONS with
 * nothing drawn. Every row below is asserted in test/client/verbs.test.ts by
 * action AND by enabled flag, which is the pair that actually breaks.
 *
 * ===========================================================================
 * ZERO ROWS IS A RESULT, NOT A FAILURE — AND IT IS LOAD-BEARING
 * ===========================================================================
 * `openTokenMenu` (main.ts) returns FALSE on an empty list, and that false is
 * what preserves right-click's older meaning: cancelling an aim. A generalised
 * menu that always found something to offer would permanently disable
 * right-click-to-cancel, and the bug would present as a targeting ring that
 * cannot be dismissed — miles from anything anyone would think to look at.
 *
 * Two cases here return nothing on purpose, and both must stay that way:
 *   - YOURSELF, ALONE. There is nothing to do to yourself but leave, and you
 *     cannot leave a party of one. (Preserved verbatim from the party menu.)
 *   - A WALL, OR OFF THE GRID. Nothing to travel to, nothing to point at.
 *
 * ===========================================================================
 * THE CALLER CLASSIFIES; THIS FILE ONLY DECIDES
 * ===========================================================================
 * `hostile` versus `player` versus `body` is not re-derived here, because the
 * client already has one implementation of each of those questions and a second
 * would drift: `isHostileBody` and `liveActorAt` in input/travel.ts mirror
 * engine/actor.ts and world.ts respectively. Likewise `walkable` on a tile
 * target is exactly the result of `travelTargetAllowed(level, tile)` — the ONE
 * named predicate decision (f) put the future "has this tile been seen" clause
 * behind. Passing the answer in rather than the level is what keeps the fog-of-war
 * seam in a single place when M6 lands.
 */

import { MapVerb } from './contextmenu.ts';
import { PartyAction } from '../../shared/protocol.ts';
import type { MenuItem } from './contextmenu.ts';
import type { TileXY } from '../../shared/coords.ts';
import type { ActorView } from '../../shared/protocol.ts';

/**
 * What is under the cursor, already classified.
 *
 * `body` covers BOTH a corpse and a downed detective: they read differently on
 * the map and identically here, because the only thing you can do to either is
 * look at it. Note that `inspectActor` answers `null` for a dead MONSTER and a
 * full view for a downed PLAYER — that difference is the server's business and
 * the menu must not try to anticipate it, or it starts leaking which is which.
 */
export type VerbTarget =
  | { readonly kind: 'player'; readonly actor: ActorView }
  | { readonly kind: 'hostile'; readonly actor: ActorView }
  | { readonly kind: 'body'; readonly actor: ActorView }
  | {
      readonly kind: 'tile';
      readonly tile: TileXY;
      /** `travelTargetAllowed(level, tile)`. False for a wall AND for off-grid. */
      readonly walkable: boolean;
    };

/**
 * A SNAPSHOT, not a set of accessors.
 *
 * The menu is opened by one event and its rows are fixed at that instant; taking
 * live getters would mean a row could disagree with the label above it if a
 * frame landed mid-decision. Everything here is read once by the caller.
 */
export type VerbContext = {
  readonly target: VerbTarget;
  /** The viewer's own actor id, from the session — never from a wire field. */
  readonly selfId: string;
  /** Everyone in the viewer's party, self included. */
  readonly partyIds: ReadonlySet<string>;
  /** Whether the viewer leads that party. Decides only whether Kick is greyed. */
  readonly selfLeads: boolean;
  /** chebyshev(self, target) === 1. Decides only whether Attack is greyed. */
  readonly adjacent: boolean;
};

export type VerbMenu = {
  /** Drawn as the menu's heading, never as a row. Hostile input; never clickable. */
  readonly title: string;
  readonly items: readonly MenuItem[];
};

/**
 * LABELS ARE SIZED IN CHARACTERS, because the menu box is.
 *
 * contextmenu.ts computes its width without measuring: `MAX_W` 184 minus one
 * border and one gutter each side leaves 172 pixels, and at `CHAR_W` 6 that is
 * 28 glyphs. A longer label is not wrong — it is clamped and drawn past the
 * border — so the rule is kept here, at the only place labels are written, and
 * the test asserts it rather than trusting anybody to re-do the arithmetic.
 */
const LEAVE = 'Leave party';
const KICK = 'Remove from party';
const INVITE = 'Invite to party';
const ATTACK = 'Attack';
const WALK_UP_TO = 'Walk up to';
const INSPECT = 'Inspect';
const TRAVEL_HERE = 'Travel here';
const POINT_HERE = 'Point here';

/** No rows. Shared so every "nothing to offer" branch is visibly the same one. */
const NO_ITEMS: readonly MenuItem[] = [];

/**
 * The rows a right-click on `ctx.target` offers, plus the heading above them.
 *
 * An EMPTY `items` means "leave the click alone" — see the header. The caller
 * must not open a menu for it.
 */
export function verbsFor(ctx: VerbContext): VerbMenu {
  const { target } = ctx;

  switch (target.kind) {
    case 'player': {
      // PRESERVED FROM THE PARTY MENU, DECISION FOR DECISION. One row, always,
      // and which one is decided by two questions the frames already answer: are
      // they in my party, and do I lead it.
      const title = target.actor.name;
      if (target.actor.id === ctx.selfId) {
        // Leaving is the only thing you can do to yourself, and only when there
        // is somebody to leave. Alone, the menu has nothing to say — and that
        // silence is what keeps right-click-to-cancel-aim alive.
        return ctx.partyIds.size > 1
          ? { title, items: [{ action: PartyAction.Leave, label: LEAVE, enabled: true }] }
          : { title, items: NO_ITEMS };
      }
      if (ctx.partyIds.has(target.actor.id)) {
        // A disabled Kick is still SHOWN to somebody who is not the leader — see
        // `MenuItem.enabled`: a row that vanishes teaches nothing about why.
        return {
          title,
          items: [{ action: PartyAction.Kick, label: KICK, enabled: ctx.selfLeads }],
        };
      }
      return { title, items: [{ action: PartyAction.Invite, label: INVITE, enabled: true }] };
    }

    case 'hostile': {
      // ATTACK IS A MOVE. There is no attack intent on the wire: walking into an
      // adjacent hostile's tile IS the attack, and the scheduler strikes the
      // occupant before it consults terrain. So this row is greyed rather than
      // dropped at range for the usual reason — the player learns that the thing
      // they want exists and needs one more step — and the caller turns it into
      // exactly one `{t:'move',dir}`.
      //
      // WALK UP TO STOPS ONE TILE SHORT AND DOES NOT SWING. An auto-attack on
      // arrival would spend a turn nobody asked for, and it would fire straight
      // through the "a hostile became visible" interrupt that travel exists to
      // honour.
      return {
        title: target.actor.name,
        items: [
          { action: MapVerb.Attack, label: ATTACK, enabled: ctx.adjacent },
          { action: MapVerb.Travel, label: WALK_UP_TO, enabled: true },
          { action: MapVerb.Inspect, label: INSPECT, enabled: true },
        ],
      };
    }

    case 'body': {
      // A corpse blocks nothing, answers nothing and can be walked over. Looking
      // at it is the entire list.
      return {
        title: target.actor.name,
        items: [{ action: MapVerb.Inspect, label: INSPECT, enabled: true }],
      };
    }

    case 'tile': {
      const title = `ground ${target.tile.x},${target.tile.y}`;
      // A WALL IS NOT A DEGRADED FLOOR. No rows at all, so right-click keeps its
      // older meaning over the two thirds of the map that is not walkable.
      if (!target.walkable) return { title, items: NO_ITEMS };
      return {
        title,
        items: [
          { action: MapVerb.Travel, label: TRAVEL_HERE, enabled: true },
          { action: MapVerb.Point, label: POINT_HERE, enabled: true },
        ],
      };
    }
  }
}
