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
 *
 * `loot` (v10) joins them on the same terms and is the reason this paragraph is
 * worth re-reading: the `ground` frame is a flat list of items with tiles on
 * them, and grouping it by tile is main.ts's job because main.ts is where the
 * frame lands. A menu that walked that list itself would be the second place in
 * the client that knows what a pile is, and the two would disagree the first
 * time one of them started filtering by what the viewer can see.
 */

import { MapVerb } from './contextmenu.ts';
import { TOPIC_LABEL, TopicId } from '../../shared/protocol.ts';
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
  | {
      readonly kind: 'player';
      readonly actor: ActorView;
      /**
       * ═══════════════════════════════════════════════════════════════════════
       * THE OBJECT LAYER, READ INDEPENDENTLY OF THE ACTOR LAYER.
       * ═══════════════════════════════════════════════════════════════════════
       *
       * ═══ WITHOUT THIS THE PICK UP ROW COULD NEVER RENDER ENABLED ═══
       * `loot` used to live only on the `tile` variant, which `targetAt` returns
       * ONLY when no actor stands there — and `lootAt` answers `Underfoot` ONLY
       * on the tile you are standing on, where the actor is YOU. So the two
       * conditions were mutually exclusive by construction: the row was built,
       * dispatched correctly, and unreachable on every tile in the game. Solo,
       * standing on a pile, the menu did not even open.
       *
       * ═══ ToME COMPOSES LAYERS RATHER THAN CLASSIFYING A TILE ═══
       * MapMenu.lua:128-133 asks the five map layers separately — TERRAIN, TRAP,
       * OBJECT, ACTOR, PROJECTILE — and MapMenu.lua:138's "Pickup item" row sits
       * beside MapMenu.lua:140's actor row on one tile. A tile is never
       * collapsed to a single kind upstream, and that collapse was the bug.
       *
       * SET FOR THE VIEWER'S OWN BODY AND NOBODY ELSE'S, because `pickup`
       * carries no coordinate: the server takes what is under the SENDER. A row
       * offered on a teammate's tile would be a row that lies.
       */
      readonly loot?: TileLoot;
    }
  | { readonly kind: 'hostile'; readonly actor: ActorView }
  | { readonly kind: 'body'; readonly actor: ActorView }
  | {
      readonly kind: 'tile';
      readonly tile: TileXY;
      /** `travelTargetAllowed(level, tile)`. False for a wall AND for off-grid. */
      readonly walkable: boolean;
      /**
       * WHAT THIS TILE'S LOOT MEANS TO THE VIEWER (v10). `walkable`'s sibling:
       * one classified answer, decided by the caller, never re-derived here.
       *
       * IT IS ONE FIELD AND NOT TWO because the two facts it carries — is there
       * anything here, and am I standing on it — are only ever read together.
       * `pickup` takes NO COORDINATE (the server reads the sender's own live x/y
       * and takes index 0 of that tile), so "there is loot on that tile over
       * there" and "there is loot under my feet" are different rows, not the same
       * row with a different argument.
       *
       * OPTIONAL, AND ABSENT MEANS "THIS CALLER CANNOT SAY" rather than "there is
       * nothing here" — the same distinction `CharacterSnapshot`'s optional
       * fields draw on the save path. It is optional because the only caller is
       * main.ts, which does not yet hold the `ground` frame; both readings drop
       * the row, so a caller that has not been wired up yet offers nothing rather
       * than promising something it cannot deliver. THE DAY main.ts HANDLES
       * `ground` IT MUST PASS THIS, or the verb is reachable only from `,`.
       */
      readonly loot?: TileLoot;
    };

/**
 * The three answers to "is there something on this tile for me".
 *
 * A const object plus a derived type rather than an `enum`: `erasableSyntaxOnly`
 * is on and an enum emits runtime code the type-stripping loader refuses.
 */
export const TileLoot = {
  /** The `ground` frame lists nothing on this tile. */
  None: 'none',
  /** Something is here AND the viewer is standing on it. The row is live. */
  Underfoot: 'underfoot',
  /** Something is here and the viewer is somewhere else. The row is greyed. */
  OutOfReach: 'out_of_reach',
} as const;
export type TileLoot = (typeof TileLoot)[keyof typeof TileLoot];

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
const TALK_TO = 'Talk to';
/**
 * The questions, in menu order.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * DERIVED FROM `TopicId`, WHICH THIS COMMENT USED TO CLAIM AND THE CODE DID NOT
 * DO.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * It said "The ids and labels are content/townsfolk.ts's — imported rather than
 * retyped, so a topic added there appears here and cannot drift". Only the
 * LABELS were imported. The row list was two hand-typed entries against a
 * `TopicId` of four, so `Roads` and `Rumour` — added later — never grew a
 * button and could not be asked for by any client.
 *
 * ═══ WHAT THAT COST ═══
 * 51 authored answers across ten townsfolk, of which 30 were unreachable. Both
 * level-gated `later` rumours. And, because `handleTalk` is the only caller of
 * `regionNamedIn`, the entire rumour-marks-your-map mechanic — which had
 * therefore never once fired for a player.
 *
 * The server half stayed green throughout: its test writes
 * `{t:'talk', topic:'rumour'}` straight onto the socket, which no client could
 * produce. A probe that speaks the protocol cannot see a missing button, and
 * neither can a server test.
 *
 * `Object.values` over the const object, so a fifth topic appears here the day
 * it is authored and the claim above is finally true.
 */
const TOPIC_ROWS = Object.values(TopicId).map((topic) => ({
  topic,
  label: TOPIC_LABEL[topic],
}));
const TRAVEL_HERE = 'Travel here';
const POINT_HERE = 'Point here';
const PICK_UP = 'Pick up';

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
        /**
         * ═══ WHAT IS UNDER YOUR OWN FEET, ABOVE WHATEVER ELSE THIS MENU SAYS ═══
         *
         * First because it is the only row here that acts on the WORLD; Leave
         * acts on the party. It is offered only when something is actually
         * there, so the "alone, the menu has nothing to say" silence below —
         * which is what keeps right-click-to-cancel-aim alive — survives intact
         * on every tile that has no pile on it.
         */
        const mine: MenuItem[] =
          (target.loot ?? TileLoot.None) === TileLoot.Underfoot
            ? [{ action: MapVerb.Pickup, label: PICK_UP, enabled: true }]
            : [];
        if (ctx.partyIds.size > 1) {
          return {
            title,
            items: [...mine, { action: PartyAction.Leave, label: LEAVE, enabled: true }],
          };
        }
        return mine.length > 0 ? { title, items: mine } : { title, items: NO_ITEMS };
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
      /**
       * ═══════════════════════════════════════════════════════════════════════
       * SOMEBODY WHO LIVES HERE GETS A DIFFERENT LIST, AND NO `Attack` ROW.
       * ═══════════════════════════════════════════════════════════════════════
       *
       * A townsfolk is a `Monster` on the server — deliberately, so she is drawn
       * by the same painter and seen by the same FOV — so without this branch she
       * arrives in this case and is offered `Attack`.
       *
       * THE ROW IS ABSENT, NOT GREYED, and that is the opposite of what this file
       * does everywhere else. A greyed row exists to teach that the thing is
       * possible and needs one more step: `Attack` greys out of reach because
       * walking closer makes it work. Greying it here would promise that standing
       * next to Merrow lets you hit her, which is false in a way no number of
       * steps fixes — `areEnemies` refuses it at three separate sites. A row that
       * can never become enabled is a lie with a tooltip.
       *
       * `Talk to` GREYS OUT OF REACH, because that one really is a step away.
       */
      if (target.actor.faction === 'townsfolk') {
        /**
         * ═══════════════════════════════════════════════════════════════════
         * ONE ROW PER QUESTION — the menu IS the dialogue.
         * ═══════════════════════════════════════════════════════════════════
         *
         * No new panel. The context menu already renders rows, closes on a
         * click and greys what is out of reach, and a dialogue box would be a
         * whole surface to lay out, theme and dismiss for something this does.
         *
         * THE ROWS ARE THE SAME FOR EVERY TOWNSFOLK, and that is deliberate: the
         * client does not hold the content table, so it cannot know which
         * questions a given person answers. The server does, and it falls back
         * to a greeting for a topic somebody has nothing to say about — which
         * is also what a person does when asked something they cannot help with.
         * A menu that changed shape per NPC would need the whole table on the
         * wire to save one wasted click.
         */
        return {
          title: target.actor.name,
          items: [
            { action: MapVerb.Talk, label: TALK_TO, enabled: ctx.adjacent },
            ...TOPIC_ROWS.map((row) => ({
              action: MapVerb.Ask,
              label: row.label,
              enabled: ctx.adjacent,
              topic: row.topic,
            })),
            { action: MapVerb.Travel, label: WALK_UP_TO, enabled: true },
            { action: MapVerb.Inspect, label: INSPECT, enabled: true },
          ],
        };
      }

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

      const items: MenuItem[] = [
        { action: MapVerb.Travel, label: TRAVEL_HERE, enabled: true },
        { action: MapVerb.Point, label: POINT_HERE, enabled: true },
      ];

      // ═══ PICK UP: FIRST WHEN IT IS LIVE, GREYED WHEN IT IS NOT, ABSENT WHEN
      //     THERE IS NOTHING TO TAKE ═══
      // GREYED RATHER THAN DROPPED on a pile you are not standing on, which is
      // exactly the Attack-at-range case above and the same argument
      // `MenuItem.enabled` makes: a row that vanishes teaches nothing about why,
      // and "there is something there, walk onto it" is the whole lesson. It
      // cannot be enabled at range because `pickup` carries no coordinate — the
      // server reads the sender's own live tile — so an enabled row would be a
      // row that lies about what the click will do.
      //
      // ABSENT ON A TILE WITH NOTHING ON IT, and that is not the same decision
      // inverted: a permanently greyed Pick up on every square of the map would
      // be furniture on the surface a player right-clicks most, and it would say
      // nothing at all about loot because it would never change.
      //
      // FIRST IN THE LIST because it is the only row here that is about the
      // world rather than about the pointer, and because on the tile you are
      // standing on "Travel here" is a no-op that would otherwise be the default
      // thing under the cursor.
      const loot = target.loot ?? TileLoot.None;
      if (loot !== TileLoot.None) {
        items.unshift({
          action: MapVerb.Pickup,
          label: PICK_UP,
          enabled: loot === TileLoot.Underfoot,
        });
      }

      return { title, items };
    }
  }
}
