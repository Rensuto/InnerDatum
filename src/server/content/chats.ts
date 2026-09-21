// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * CONVERSATIONS. WHAT SOMEBODY SAYS, AND WHAT YOU MAY SAY BACK.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Ported from `engine/Chat.lua` and `engine/dialogs/Chat.lua`. The shape is
 * upstream's, verbatim where it survives the translation:
 *
 *   - `engine/Chat.lua:81-98` `addChat(c)` asserts `c.id`, `c.text or c.template` and
 *     `c.answers`: a NODE is a line plus a flat list of answers, and nodes are a
 *     map keyed by id. `ChatNode` below is that, with `options` for `answers`.
 *   - `engine/Chat.lua:54` a chat file RETURNS the id of its entry node. `Chat.entry`.
 *   - `engine/dialogs/Chat.lua:139` an answer is listed only if
 *     `not a.fallback and (not a.cond or a.cond(npc, player))` — **and that
 *     filter is the security model**, which is the single most important thing
 *     this port keeps. The server filters; the client never evaluates a
 *     condition and cannot pick a row it was not sent. See `visibleOptions`.
 *   - `engine/dialogs/Chat.lua:96-103` an answer's `action` may RETURN a node id, and a
 *     returned id overrides `jump`. `:104-110` an answer with no `jump` ENDS the
 *     conversation. Both kept exactly.
 *   - `engine/Chat.lua:118-133` a node's text is rendered — a template through `slt2`,
 *     then `@playername@`/`@npcname@` through `replace`. We have no templating
 *     dependency and will not grow one (CLAUDE.md: do not add a dependency), so
 *     a node's `text` is a FUNCTION of the context. That is the same fact —
 *     what a person says depends on who is listening — expressed in the one
 *     language this project allows itself.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT IS NOT PORTED, AND WHY
 * ═══════════════════════════════════════════════════════════════════════════
 *   - `on_select` (`engine/dialogs/Chat.lua:81-88`) fires on HIGHLIGHT. Over a socket
 *     that is a round trip per arrow key.
 *   - `switch_npc` (`:95`) and `quick_reply` sugar (`engine/Chat.lua:91-97`) — neither
 *     has a caller here yet, and an unused branch is a branch nothing tests.
 *   - `fallback` (`:145-153`), upstream's second pass when every answer was
 *     filtered out, is not a field here. The same guarantee is met a stronger
 *     way: `chatFor` appends an UNCONDITIONAL leave option to every node, so a
 *     node with no passing answer is not representable. See `LEAVE`.
 *   - The dialog freezing the world (`engine/Game.lua:375-384`). Six players, one
 *     clock. See `net/gateway.ts`'s dialogue block: the talker's body is parked
 *     and everybody else keeps playing.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE GRAPH IS DERIVED FROM `townsfolk.ts`, NOT AUTHORED A SECOND TIME
 * ═══════════════════════════════════════════════════════════════════════════
 * Sixteen people already have a greeting, four answers each and a level-gated
 * second answer, and every one of those lines was written, measured and tested.
 * Authoring sixteen chat files would be a second copy of all of it, and the two
 * would disagree the first time somebody edited one — which is the exact failure
 * `TOPIC_ROWS` in `client/ui/verbs.ts` records, where 30 of 51 authored answers
 * were unreachable because a hand-typed list had drifted from the table.
 *
 * So `chatFor(spec)` PROJECTS a person into a conversation. A bespoke chat for
 * one named person is a later addition to this file and does not change that:
 * the registry would answer with the authored graph and fall through to the
 * projection for everybody else.
 */

import { DialogueScope, TOPIC_LABEL, TopicId } from '../../shared/protocol.ts';
import { answerFor, isShopkeeperSpec } from './townsfolk.ts';
import { regionNamedIn } from '../../shared/level.ts';
import type { BriefSnapshot } from '../world/brief.ts';
import type { TownsfolkSpec } from './townsfolk.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE SEAMS AN ACTION MAY REACH. NOTHING ELSE, AND THAT IS THE POINT.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `content/` may not import `net/`, `persist/` or `ops/` — ESLint enforces the
 * direction — so a chat cannot reach into the gateway and the gateway hands it
 * exactly the operations a conversation is allowed to perform. Adding a seam is
 * therefore a deliberate act with a diff, rather than something a content edit
 * can quietly do.
 *
 * It is also what makes the content testable without a socket: `chats.test.ts`
 * builds one of these out of counters.
 */
export type ChatCtx = {
  readonly speakerId: string;
  readonly speakerName: string;
  /**
   * The LISTENER's character level. `answerFor`'s gate and the only thing any
   * condition reads today — and it can change mid-conversation, which is why
   * conditions are re-evaluated on every send AND on the pick rather than
   * trusted from the frame that offered them.
   */
  readonly askerLevel: number;
  /**
   * Today's greeting for this pairing, already chosen by the bump counter the
   * gateway shares with `greetOnBump`. Chosen ONCE when the window opens and
   * held for its lifetime: re-sending the entry node — which a lead change does
   * — must not walk somebody through "we have met" three times.
   */
  readonly greeting: string;
  /** Put this country on the LISTENER's own overworld map. Newly revealed? */
  readonly revealToSelf: (x: number, y: number) => boolean;
  /**
   * Put it on every party member's. How many of them newly learned it.
   *
   * ═══════════════════════════════════════════════════════════════════════════
   * A PARTY-WIDE SEAM MAY ONLY BE REACHED FROM A `story` OPTION. THE RULE IS
   * HERE BECAUSE THIS IS THE FIELD IT IS ABOUT.
   * ═══════════════════════════════════════════════════════════════════════════
   * `scopeOf`'s fail-closed default protects the option that FORGETS a scope.
   * Nothing in the type system protects the option that declares the WRONG one:
   * the gateway builds one `ChatCtx` and hands it to whichever action fires, so
   * a `personal` row calling this would write onto five other characters off a
   * non-lead's click — the author's ruling inverted, through content rather than
   * through the guard. `chats.test.ts` asserts it of every shipped option by
   * running each action against a recording context, so the day somebody writes
   * that row it fails in the suite rather than in somebody's playthrough.
   *
   * `revealToSelf` is the personal half and carries no such rule: it writes onto
   * the listener's own fog, which is what asking a question has always done.
   */
  readonly revealToParty: (x: number, y: number) => number;
  /** Expose the realm's shop shelf to the listener — today's `sendShopIfAny`. */
  readonly openShop: () => void;
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE FLOOR'S OBJECTIVE, AS THIS SPEAKER OFFERS IT — OR NOTHING.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * A READ-ONLY SNAPSHOT and never the live `Brief`. An action here could
   * otherwise write to the realm's own object from inside a `text` closure,
   * which runs on EVERY frame of every window — and the rule this file exists
   * to keep is that the gateway hands a conversation exactly the operations it
   * is allowed to perform, rather than a handle it can do anything with.
   *
   * `undefined` FOR EVERY OTHER PERSON IN THE GAME, which is what keeps the
   * three rows below out of sixteen shopkeepers' conversations without a
   * second registry of who offers what: the chat graph is projected from a
   * person's spec, the rows are conditional on this answer, and the gateway
   * answers only for the body the brief was armed around.
   *
   * It is also computed PER ASKER — see `BriefSnapshot`, whose `band` and
   * `bearing` are facts about where the listener is standing.
   */
  readonly brief: () => BriefSnapshot | undefined;
  /**
   * Take it, for the party. `false` when there was nothing to take — two frames
   * crossed, or somebody else already answered.
   *
   * THE LEAD GATE IS UPSTREAM OF HERE and is not this seam's to enforce:
   * `handleDialogueChoose` refuses a `story` option from a non-lead before any
   * action runs. See `revealToParty` directly above for why the row's SCOPE is
   * the thing that has to be right.
   */
  readonly acceptBrief: () => boolean;
  /**
   * Refuse it, AND DELETE THE CONTENT — `tome/class/GameState.lua:2974-2976`,
   * `for _, m in ipairs(mlist) do m:disappear() m:removed() end`. Refusing
   * removes the encounter rather than leaving it standing to be asked again,
   * which is what stops a declined offer being a thing a party farms for
   * sentences.
   */
  readonly declineBrief: () => boolean;
};

/**
 * One answer.
 *
 * `scope` IS OPTIONAL IN THE TYPE AND REQUIRED IN EFFECT. An option that omits
 * it is a `story` option — see `scopeOf` and `shared/protocol.ts#DialogueScope`.
 * Authored options here all declare one; the default exists so that the next
 * one written, by somebody who has not read this file, fails CLOSED.
 */
export type ChatOption = {
  /** Stable and authored. The wire names this, never a row number. */
  readonly id: string;
  readonly label: string;
  /** Absent means `story`. Fail closed — `scopeOf` is the only reader. */
  readonly scope?: DialogueScope;
  /** `engine/dialogs/Chat.lua:139`. Absent means always offered. */
  readonly cond?: (ctx: ChatCtx) => boolean;
  /** `engine/dialogs/Chat.lua:96-103`. A returned node id overrides `jump`. */
  readonly action?: (ctx: ChatCtx) => string | undefined;
  /**
   * `engine/dialogs/Chat.lua:104-110`. Absent ENDS the conversation.
   *
   * ═══════════════════════════════════════════════════════════════════════════
   * AN OPTION THAT COMES BACK TO ITS OWN NODE IS PRESSABLE FOR EVER. WRITE IT
   * ACCORDINGLY.
   * ═══════════════════════════════════════════════════════════════════════════
   * The gateway refuses an answer whose `nodeId` is not the node that is open,
   * which stops a crossed frame and nothing else: when `jump` — or the id the
   * `action` returns — IS the node the option sits on, the conversation never
   * moves, the same list is rebuilt, and a client may fire it twenty times a
   * second. `shop` does exactly that on purpose, and it is safe because opening
   * a shelf twice is opening a shelf.
   *
   * SO: an option that returns to its own node is `personal` AND idempotent, or
   * it carries a `cond` that stops passing once it has fired. A payment, a
   * recruit or a one-time world offer written as a self-return would be a story
   * answer the lead could take repeatedly. `chats.test.ts` asserts the first
   * half of that; the second is a thing to remember when writing the option.
   */
  readonly jump?: string;
};

/** One thing somebody says, and everything you could say to it. */
export type ChatNode = {
  readonly id: string;
  /** A function, for `engine/Chat.lua:118-133`'s reason. See the header. */
  readonly text: (ctx: ChatCtx) => string;
  readonly options: readonly ChatOption[];
};

export type Chat = {
  readonly id: string;
  /** `engine/Chat.lua:54` — the file returns the id of its entry node. */
  readonly entry: string;
  readonly nodes: readonly ChatNode[];
};

/**
 * An option with its scope RESOLVED, which is the only form anything outside
 * this file ever sees.
 *
 * ═══ THE GATEWAY CANNOT READ AN UNRESOLVED SCOPE, BY CONSTRUCTION ═══
 * `visibleOptions` is the only way to get options out of a node, and what it
 * returns carries a non-optional `scope`. So "absent means story" is not a rule
 * the gateway has to remember and cannot accidentally re-implement as
 * `option.scope === 'story'` — which would read `undefined` as personal and hand
 * every socket in the realm the run-committing answers. Fail closed in ONE
 * function or fail open in every caller; there is no third option.
 */
export type OfferedOption = Omit<ChatOption, 'scope'> & { readonly scope: DialogueScope };

/** Absent means `story`. The whole fail-closed rule, in one expression. */
export function scopeOf(option: ChatOption): DialogueScope {
  return option.scope ?? DialogueScope.Story;
}

/**
 * `BriefState.Offered` as a string, and the import that is deliberately not
 * here.
 *
 * `content/` already reaches `world/brief.ts` for the `BriefSnapshot` TYPE, and
 * a type import erases; a VALUE import would make a chat graph depend on the
 * realm registry's module at run time, which is the direction this file's header
 * spends its length keeping shut. `BriefSnapshot.state` is the union's member
 * verbatim — the same way `ActorView.faction` carries its own union on the wire
 * — so one literal is the whole of the coupling, and `chats.test.ts` pins it
 * against the real value.
 */
const BRIEF_OFFERED = 'offered';

/** Stable ids, exported so a test names the same string the content does. */
export const ChatNodeId = {
  Greet: 'greet',
  /** Where a rumour that named a country leads once it is on your own map. */
  RouteSelf: 'route:self',
  /** ...and on the party's. */
  RouteParty: 'route:party',
  /** What the objective is, and what it pays. The question anybody may ask. */
  BriefAsk: 'brief:ask',
  /** How far, and which way. Computed for whoever asked. */
  BriefWhere: 'brief:where',
} as const;

export const ChatOptionId = {
  Leave: 'leave',
  Back: 'back',
  Shop: 'shop',
  RouteSelf: 'route:self',
  RouteParty: 'route:party',
  /** Tell me about it. Anybody, any number of times. */
  BriefAsk: 'brief:ask',
  /** How far is it? Anybody, and free — see `BriefSnapshot`. */
  BriefWhere: 'brief:where',
  /** Take it. THE LEAD ALONE. */
  BriefTake: 'brief:take',
  /** Not this time. THE LEAD ALONE, and it deletes the content. */
  BriefDecline: 'brief:decline',
} as const;

/** The node a topic's answer lives on, and the option that reaches it. */
export function topicNodeId(topic: TopicId): string {
  return `topic:${topic}`;
}

/**
 * EVERY NODE ENDS SOMEWHERE. Upstream's `fallback` pass (`engine/dialogs/Chat.lua:145-153`) exists because a node whose every answer was filtered out is a
 * conversation with no exit; this is the same guarantee with no second pass,
 * because an UNCONDITIONAL option cannot be filtered out.
 *
 * No `jump`, so it ends the conversation — `engine/dialogs/Chat.lua:104-110`.
 */
const LEAVE: ChatOption = {
  id: ChatOptionId.Leave,
  label: 'Nothing for now.',
  scope: DialogueScope.Personal,
};

const BACK: ChatOption = {
  id: ChatOptionId.Back,
  label: 'Ask something else.',
  scope: DialogueScope.Personal,
  jump: ChatNodeId.Greet,
};

/**
 * The country this person's rumour names, at this listener's level, or nothing.
 *
 * TWO DIFFERENT ANSWERS AT TWO LEVELS, and that is deliberate: below
 * `STANDING_LEVEL` Merrow Stitch's rumour names no country at all and above it
 * she names the Sedge. So this is a condition that genuinely CHANGES under a
 * conversation — a level-up between the frame going out and the answer coming
 * back — which is why conditions are re-evaluated on the pick.
 */
function routeIn(spec: TownsfolkSpec, ctx: ChatCtx): ReturnType<typeof regionNamedIn> {
  const said = answerFor(spec, ctx.askerLevel, TopicId.Rumour);
  return said === undefined ? undefined : regionNamedIn(said);
}

const chats = new Map<string, Chat>();

/**
 * This person's conversation. Built once per spec and cached — the graph is
 * static; everything that varies is a closure over `ChatCtx`.
 */
export function chatFor(spec: TownsfolkSpec): Chat {
  const had = chats.get(spec.id);
  if (had !== undefined) return had;

  const topics = Object.values(TopicId).filter((t) => spec.topics[t] !== undefined);

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE FOUR QUESTIONS, WHICH USED TO BE FOUR ROWS OF THE RIGHT-CLICK MENU.
   * ═══════════════════════════════════════════════════════════════════════════
   * Ruled by the author, 2026-09-17: *"the ones from right click menu should be
   * in the dialogue box instead of in the right click menu. right click should
   * instead give generic option to talk to npc instead which opens dialogue
   * interaction window"*. Same labels — `TOPIC_LABEL` is the wire vocabulary and
   * neither side retypes it — in their new home.
   *
   * PERSONAL, every one. Asking where the chapel is commits nobody to anything.
   */
  const topicOptions: readonly ChatOption[] = topics.map((topic) => ({
    id: topicNodeId(topic),
    label: TOPIC_LABEL[topic],
    scope: DialogueScope.Personal,
    jump: topicNodeId(topic),
  }));

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * AND THE COUNTER, WHICH IS PERSONAL EVEN THOUGH THE SHELF IS SHARED.
   * ═══════════════════════════════════════════════════════════════════════════
   * The author, same ruling: *"shop options and other interactions will still
   * occur through the dialogue interaction box"*. The stock belongs to the realm
   * and everybody standing there sees the same four coats, but BUYING is not a
   * decision about the party's story and each buyer spends their own purse — so
   * a non-lead may open the shelf and buy from it exactly as the lead may.
   *
   * IT RETURNS TO THE GREETING rather than ending, because opening a shelf is
   * not leaving a conversation: `sendShopIfAny` puts the shop panel on screen
   * beside the window, and the window is still where the rest of the
   * conversation lives.
   */
  const shopOption: ChatOption = {
    id: ChatOptionId.Shop,
    label: 'Let me see your wares.',
    scope: DialogueScope.Personal,
    cond: () => isShopkeeperSpec(spec),
    action: (ctx) => {
      ctx.openShop();
      return ChatNodeId.Greet;
    },
  };

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE ONE STORY ANSWER THIS BUILD HAS, AND IT IS A REAL ONE.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * A rumour that names a country can be put on a map. Doing it for YOURSELF is
   * what `handleTalk` has always done and it is personal — your fog, your
   * evening. Doing it FOR THE PARTY writes state onto five other people's
   * characters off one person's click, which is precisely the class of decision
   * the author reserved to the host: *"story driving conversations should only
   * be applicable to the host to protect their playthrough"*.
   *
   * It is also not a hypothetical piece of world state invented to have
   * something to gate. `markCountry` is shipped, the Redaction being unfindable
   * is the documented defect it was built for (`townsfolk.ts#later`), and
   * pointing a whole party west is exactly the decision a lead makes out loud in
   * a voice channel.
   *
   * BOTH ROWS ARE CONDITIONAL on the rumour naming somewhere — see `routeIn`.
   */
  const routeSelf: ChatOption = {
    id: ChatOptionId.RouteSelf,
    label: 'Put that country on my map.',
    scope: DialogueScope.Personal,
    cond: (ctx) => routeIn(spec, ctx) !== undefined,
    action: (ctx) => {
      const where = routeIn(spec, ctx);
      if (where === undefined) return undefined;
      ctx.revealToSelf(where.x, where.y);
      return ChatNodeId.RouteSelf;
    },
  };

  const routeParty: ChatOption = {
    id: ChatOptionId.RouteParty,
    label: "Put it on the whole party's map.",
    scope: DialogueScope.Story,
    cond: (ctx) => routeIn(spec, ctx) !== undefined,
    action: (ctx) => {
      const where = routeIn(spec, ctx);
      if (where === undefined) return undefined;
      ctx.revealToParty(where.x, where.y);
      return ChatNodeId.RouteParty;
    },
  };

  /**
   * ═════════════════════════════════════════════════════════════════════════
   * AND THE OBJECTIVE, WHICH IS THE OTHER STORY ANSWER THIS BUILD HAS.
   * ═════════════════════════════════════════════════════════════════════════
   *
   * FOUR ROWS ON EVERY PERSON'S GRAPH AND VISIBLE ON EXACTLY ONE, because
   * `ctx.brief()` answers `undefined` for anybody who is not offering one. That
   * is the same shape `shopOption` already uses (`cond: () => isShopkeeperSpec`)
   * and it is why this file needs no registry of who offers what: the gateway
   * knows which body the floor's objective was armed around, and the condition
   * asks it.
   *
   * ═══ WHY `take` AND `decline` ARE `story` AND THE OTHER TWO ARE NOT ═══
   * The author's ruling: *"story driving conversations should only be
   * applicable to the host to protect their playthrough"*. Taking an objective
   * commits four people's floor and pays four people's experience; declining
   * DELETES THE CONTENT for all of them. Asking what it is, and how far away it
   * is, commits nobody to anything, is computed for the asker's own body and
   * goes only to the asker's log — which is the only thing stopping a party
   * that asks every third step from burying the Case Log.
   *
   * ═══ AND `decline` IS NOT THE SAME ROW AS `leave` ═══
   * `LEAVE` is the unconditional personal exit every node carries. If declining
   * were the only way to end this conversation, A JOINING PLAYER WHO WALKED
   * AWAY WOULD HAVE DECLINED ON BEHALF OF THE PARTY — precisely the bug the
   * scope rule exists to prevent. Two rows, and they say two different things.
   *
   * ═══ NEITHER STORY ROW CARRIES A `jump`, AND NEITHER ACTION RETURNS ONE ═══
   * `engine/dialogs/Chat.lua:104-110`: an answer with no jump ENDS the
   * conversation, and `handleDialogueChoose` implements exactly that — it
   * records the exchange and closes WITHOUT re-standing the window. Both of
   * these change the world under the window: the accept names a body on the
   * floor, the decline takes the speaker off it. Re-sending a window against a
   * floor that has moved is how a player ends up being told there is nobody
   * there to talk to about somebody standing in front of them.
   *
   * IT IS ALSO A GUARD ON THE LANE THAT COMES NEXT. The day accepting flips the
   * offerer's faction, a `jump` here would make `dialogueStanding` fail on the
   * very next frame; the socket test that asserts the window is closed after an
   * accept is what fails the moment somebody adds one.
   *
   * The two ASK rows return to their own node instead, which is legal for
   * exactly the reason `shop` is: personal, and idempotent.
   */
  const briefAsk: ChatOption = {
    id: ChatOptionId.BriefAsk,
    label: 'What is down there?',
    scope: DialogueScope.Personal,
    cond: (ctx) => ctx.brief() !== undefined,
    jump: ChatNodeId.BriefAsk,
  };

  const briefWhere: ChatOption = {
    id: ChatOptionId.BriefWhere,
    label: 'How far?',
    scope: DialogueScope.Personal,
    // ONLY ONCE THERE IS SOMEWHERE TO POINT AT. A quarry has no tile until the
    // accept names a body, which is what makes finding it a search — so before
    // the accept this row is not offered at all, rather than being offered and
    // then answering nothing.
    cond: (ctx) => ctx.brief()?.bearing !== undefined,
    jump: ChatNodeId.BriefWhere,
  };

  const briefTake: ChatOption = {
    id: ChatOptionId.BriefTake,
    label: 'We will take it.',
    scope: DialogueScope.Story,
    cond: (ctx) => ctx.brief()?.state === BRIEF_OFFERED,
    action: (ctx) => {
      ctx.acceptBrief();
      return undefined;
    },
  };

  const briefDecline: ChatOption = {
    id: ChatOptionId.BriefDecline,
    label: 'Not this time.',
    scope: DialogueScope.Story,
    cond: (ctx) => ctx.brief()?.state === BRIEF_OFFERED,
    action: (ctx) => {
      ctx.declineBrief();
      return undefined;
    },
  };

  const briefOptions: readonly ChatOption[] = [briefTake, briefAsk, briefWhere, briefDecline];

  /**
   * WHAT IT PAYS, INSIDE THE QUESTION. `tome/class/GameState.lua:2928` puts the
   * reward in the offer, and refusing must be a PRICED decision: four people in
   * a voice channel cannot weigh a thing whose payout is a surprise.
   *
   * IN THE OFFERER'S OWN REGISTER and never in numbers. The strip, the Journal
   * and the Case Log all carry the objective's own words; a line reading
   * "Elite, level 3" would be the character sheet talking, and the sheet is on
   * the card.
   */
  const briefAskText = (ctx: ChatCtx): string => {
    const said = ctx.brief();
    if (said === undefined) return ctx.greeting;
    const paid =
      said.reward.item === undefined
        ? 'I have nothing to give you but the quiet.'
        : 'It is carrying something of mine. Keep it.';
    return `${said.detail} ${paid}`;
  };

  const nodes: ChatNode[] = [
    {
      id: ChatNodeId.Greet,
      text: (ctx) => ctx.greeting,
      options: [...briefOptions, ...topicOptions, shopOption, LEAVE],
    },
    {
      id: ChatNodeId.BriefAsk,
      text: briefAskText,
      options: [...briefOptions, BACK, LEAVE],
    },
    {
      id: ChatNodeId.BriefWhere,
      /**
       * `tome/class/Party.lua:410-418` — the escortee answers IN WORDS, a band
       * and a compass direction, and it is never drawn on the map. Four people
       * standing in four places get four different answers and all four are
       * true; asking is free (`TalkSchema` spends no turn and pumps nothing),
       * so this is a warm-and-cold game a party may play as often as it likes.
       */
      text: (ctx) => {
        const said = ctx.brief();
        if (said?.bearing === undefined || said.band === undefined) {
          return 'I could not tell you. Not any more.';
        }
        return `${said.name ?? 'It'} is ${said.band}, to the ${said.bearing}.`;
      },
      options: [...briefOptions, BACK, LEAVE],
    },
    ...topics.map((topic): ChatNode => ({
      id: topicNodeId(topic),
      // `spec.topics[topic]` is proved present by `assertLinesFit` at module
      // load, and `answerFor` only ever upgrades it — so the fallback is a
      // type narrowing rather than a behaviour.
      text: (ctx) => answerFor(spec, ctx.askerLevel, topic) ?? spec.topics[topic] ?? '',
      options: topic === TopicId.Rumour ? [routeSelf, routeParty, BACK, LEAVE] : [BACK, LEAVE],
    })),
    {
      id: ChatNodeId.RouteSelf,
      text: (ctx) => {
        const where = routeIn(spec, ctx);
        return where === undefined
          ? 'Mind how you go.'
          : `${where.name} is on your map now. Mind how you go.`;
      },
      options: [BACK, LEAVE],
    },
    {
      id: ChatNodeId.RouteParty,
      text: (ctx) => {
        const where = routeIn(spec, ctx);
        return where === undefined
          ? 'Mind how you all go.'
          : `${where.name} is on the whole party's map now.`;
      },
      options: [BACK, LEAVE],
    },
  ];

  const chat: Chat = { id: spec.id, entry: ChatNodeId.Greet, nodes };
  chats.set(spec.id, chat);
  return chat;
}

/** One node of a chat, by id, or nothing. */
export function nodeOf(chat: Chat, nodeId: string): ChatNode | undefined {
  return chat.nodes.find((n) => n.id === nodeId);
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE OPTIONS THIS LISTENER IS ACTUALLY OFFERED. `engine/dialogs/Chat.lua:132-163`.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * THIS FUNCTION IS THE SECURITY MODEL, and it is the reason it has exactly one
 * implementation rather than one for the frame and one for the pick. Upstream
 * can afford to build its list once, because there is one player and nothing
 * moves between the draw and the click. Six people move. So the gateway calls
 * this to BUILD the frame and calls it again to VALIDATE the answer, with a
 * context built from the world as it is at that moment — and an option whose
 * condition has since stopped passing is not in the second list and is refused.
 *
 * Every returned option carries a resolved `scope`. See `OfferedOption`.
 */
export function visibleOptions(node: ChatNode, ctx: ChatCtx): readonly OfferedOption[] {
  return node.options
    .filter((option) => option.cond === undefined || option.cond(ctx))
    .map((option) => ({ ...option, scope: scopeOf(option) }));
}
