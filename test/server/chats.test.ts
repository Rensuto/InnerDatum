import { describe, expect, it } from 'vitest';

import {
  ChatNodeId,
  ChatOptionId,
  chatFor,
  nodeOf,
  scopeOf,
  topicNodeId,
  visibleOptions,
} from '../../src/server/content/chats.ts';
import {
  STANDING_LEVEL,
  TOWNSFOLK,
  answerFor,
  portraitKeyFor,
} from '../../src/server/content/townsfolk.ts';
import { BriefState } from '../../src/server/world/brief.ts';
import { ActorRank, DialogueScope, TOPIC_LABEL, TopicId } from '../../src/shared/protocol.ts';
import type { BriefSnapshot } from '../../src/server/world/brief.ts';
import type { ChatCtx, ChatOption } from '../../src/server/content/chats.ts';
import type { TownsfolkSpec } from '../../src/server/content/townsfolk.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE GRAPH ITSELF — PURE, NO SOCKET, NO WORLD.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `dialogue.test.ts` drives the wire. This file is about the shape a
 * conversation has before anybody is having it, and it exists because three of
 * the ways a dialogue system fails are invisible over a socket until somebody
 * happens to click the wrong row:
 *
 *   A `jump` that names a node nobody wrote — a dead end that only appears for
 *     the one person who takes that branch.
 *   A node whose every option can be filtered away — upstream grows a whole
 *     second `fallback` pass to stop it (`engine/dialogs/Chat.lua:145-153`).
 *   An option with no `scope`, which the wire cannot tell from one that declared
 *     `personal` unless the DEFAULT is the strict one.
 *
 * EVERY PERSON IN THE TABLE IS WALKED, not a sample. Sixteen graphs is sixteen
 * loops and the whole point of deriving them from `townsfolk.ts` is that adding
 * a seventeenth person must not need a test edit.
 */

/** A context that answers nothing and reveals nothing. Enough for the shape. */
function ctxFor(overrides: Partial<ChatCtx> = {}): ChatCtx {
  return {
    speakerId: 'realm:town:whoever',
    speakerName: 'Whoever',
    askerLevel: 1,
    greeting: 'A greeting.',
    revealToSelf: () => false,
    revealToParty: () => 0,
    openShop: () => undefined,
    // NOBODY IS OFFERING ANYTHING, which is the answer for every person in
    // `TOWNSFOLK` and therefore the right default here: the four brief rows are
    // conditional on this, so the derived graph under this context is exactly
    // the graph a shopkeeper in a town has.
    brief: () => undefined,
    acceptBrief: () => false,
    declineBrief: () => false,
    ...overrides,
  };
}

/**
 * The objective as the offerer describes it, with every field filled, so that
 * every one of the four rows passes its condition at once.
 *
 * `state` IS THE LITERAL THE CHAT GRAPH COMPARES AGAINST, and pinning it
 * against `BriefState.Offered` is the whole of what stops `content/chats.ts`'s
 * one string drifting from the server's union — see the note on `BRIEF_OFFERED`
 * there for why the value is not imported.
 */
const OFFERED_BRIEF: BriefSnapshot = {
  title: 'It kept its name',
  detail: 'Something down there still answers to what it was called.',
  state: BriefState.Offered,
  reward: { level: 3, rank: ActorRank.Elite, item: 'item_alchemists_lamp' },
  name: 'Sallow Cordage',
  band: 'close',
  bearing: 'north-east',
};

const EVERYBODY: readonly TownsfolkSpec[] = [...TOWNSFOLK.values()].flat();

describe('the conversation graph', () => {
  it('has somebody to build a conversation for', () => {
    // THE GUARD ON EVERY LOOP BELOW. `[...map.values()].flat()` of an empty map
    // is an empty array, and a `for` over it passes every assertion in this file
    // without executing one of them — the failure mode that makes a green suite
    // meaningless. Sixteen is the table's own count; see `TOWNSFOLK`.
    expect(EVERYBODY).toHaveLength(16);
  });

  it('never jumps to a node nobody wrote', () => {
    for (const spec of EVERYBODY) {
      const chat = chatFor(spec);
      expect(nodeOf(chat, chat.entry), `${spec.id}: no entry node`).toBeDefined();
      for (const node of chat.nodes) {
        for (const option of node.options) {
          if (option.jump === undefined) continue;
          expect(nodeOf(chat, option.jump), `${spec.id}/${node.id}/${option.id}`).toBeDefined();
        }
      }
    }
  });

  it('can reach every node it wrote, from the entry', () => {
    /**
     * REACHABILITY IGNORING CONDITIONS, deliberately. A node reachable only
     * through a `cond` that is false today is still reachable — `route:self`
     * is exactly that, and gating it is the feature. What this refuses is a node
     * NOTHING points at, which is content that has been orphaned by an edit and
     * will never be seen by anybody.
     */
    for (const spec of EVERYBODY) {
      const chat = chatFor(spec);
      const seen = new Set<string>([chat.entry]);
      const queue = [chat.entry];
      while (queue.length > 0) {
        const at = queue.pop();
        if (at === undefined) continue;
        const node = nodeOf(chat, at);
        if (node === undefined) continue;
        for (const option of node.options) {
          // `action`s that return an id are the other half of `jump`
          // (`engine/dialogs/Chat.lua:96-103`) and the derived graph's two of them
          // return node ids named in `ChatNodeId`; both are listed here so the
          // sweep does not have to run a closure to find an edge.
          for (const to of [option.jump, ...edgesFromAction(option)]) {
            if (to === undefined || seen.has(to)) continue;
            seen.add(to);
            queue.push(to);
          }
        }
      }
      for (const node of chat.nodes) {
        expect([...seen], `${spec.id}: ${node.id} is orphaned`).toContain(node.id);
      }
    }
  });

  it('always leaves a way out, even when every condition fails', () => {
    /**
     * UPSTREAM'S `fallback` GUARANTEE, met without a second pass. A context in
     * which nothing at all passes — level 0, no shop, no country named — must
     * still produce at least one option on every node, or the player is stuck in
     * a window with no answer and no exit.
     *
     * IT MUST BE AN EXIT, not merely an option. A node offering only "ask
     * something else" would satisfy a `length > 0` assertion and still trap
     * somebody in a two-node loop.
     */
    const ctx = ctxFor({ askerLevel: 0 });
    for (const spec of EVERYBODY) {
      for (const node of chatFor(spec).nodes) {
        const open = visibleOptions(node, ctx);
        expect(open.length, `${spec.id}/${node.id} is a dead end`).toBeGreaterThan(0);
        expect(
          open.map((o) => o.id),
          `${spec.id}/${node.id} has no way out`,
        ).toContain(ChatOptionId.Leave);
        /**
         * AND IT IS AN EXIT, NOT A ROW NAMED `leave`.
         *
         * The paragraph above says the assertion must be about EXITING and then
         * asserted membership, which is this project's `membership-is-not-a-rank`
         * failure exactly: giving `LEAVE` a `jump` turned every node into a
         * closed loop with no way out and left this file and the socket suite
         * green. `engine/dialogs/Chat.lua:104-110` is the rule — no jump, and no
         * action to return one, ENDS the conversation.
         */
        const out = open.find((o) => o.id === ChatOptionId.Leave);
        expect(out?.jump, `${spec.id}/${node.id}: leaving jumps somewhere`).toBeUndefined();
        expect(out?.action, `${spec.id}/${node.id}: leaving runs something`).toBeUndefined();
      }
    }
  });

  it('gives every node and every option within it a distinct id', () => {
    // THE WIRE NAMES AN ID, never a row number (`dialogue_choose`). Two options
    // sharing one id inside a node makes the lookup on the pick path ambiguous,
    // and `find` would silently answer with whichever was authored first.
    for (const spec of EVERYBODY) {
      const chat = chatFor(spec);
      const nodeIds = chat.nodes.map((n) => n.id);
      expect(new Set(nodeIds).size, `${spec.id}: duplicate node id`).toBe(nodeIds.length);
      for (const node of chat.nodes) {
        const ids = node.options.map((o) => o.id);
        expect(new Set(ids).size, `${spec.id}/${node.id}: duplicate option id`).toBe(ids.length);
      }
    }
  });
});

describe('who an answer belongs to', () => {
  it('treats an option that declares no scope as the host’s', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * FAIL CLOSED. THIS IS THE ASSERTION THE WHOLE CO-OP RULING RESTS ON.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * The author's ruling makes story answers the host's. An option authored
     * without a `scope` is the case nobody will think about — and the direction
     * of the default decides whether forgetting one word hands every socket in
     * the realm an answer that commits somebody else's playthrough, or costs
     * them a greyed row they can ask the host about.
     *
     * MUTATION: change `scopeOf`'s `?? DialogueScope.Story` to `?? Personal` and
     * this goes red, as does the "refused for a non-lead" case in
     * `dialogue.test.ts` that drives the same rule over a socket.
     */
    const undeclared: ChatOption = { id: 'x', label: 'Something committing.' };
    expect(scopeOf(undeclared)).toBe(DialogueScope.Story);

    // AND IT SURVIVES THE ONLY ROUTE OUT OF THIS FILE. The gateway never sees a
    // `ChatOption`; it sees what `visibleOptions` returns, and that carries a
    // resolved scope. If the resolution were bypassable, this is where it would
    // show.
    const node = { id: 'n', text: () => 'hm', options: [undeclared] };
    expect(visibleOptions(node, ctxFor())[0]?.scope).toBe(DialogueScope.Story);
  });

  it('declares a scope on every option the game actually ships', () => {
    // THE DEFAULT IS A NET, NOT A CRUTCH. Authored content says which it is, so
    // a reader of `chats.ts` never has to hold the default in their head to know
    // who may answer a row.
    for (const spec of EVERYBODY) {
      for (const node of chatFor(spec).nodes) {
        for (const option of node.options) {
          expect(option.scope, `${spec.id}/${node.id}/${option.id} has no scope`).toBeDefined();
        }
      }
    }
  });

  it('keeps the counter personal and the party-wide reveal the host’s', () => {
    /**
     * The ruling, verbatim: *"shop options and other interactions will still
     * occur through the dialogue interaction box"*. Shopping is personal even
     * though the shelf is realm-wide stock — each buyer spends their own purse —
     * and the one answer that writes onto OTHER characters is not.
     *
     * ASSERTED AT `STANDING_LEVEL`, not at 1, because below it Merrow names no
     * country and the route rows do not exist at all (see the gate case below).
     * Asserting at the default would be asserting about an empty list.
     */
    const merrow = EVERYBODY.find((s) => s.id === 'merrow');
    expect(merrow).toBeDefined();
    if (merrow === undefined) return;

    const greet = nodeOf(chatFor(merrow), ChatNodeId.Greet);
    expect(greet).toBeDefined();
    if (greet === undefined) return;
    const shop = visibleOptions(greet, ctxFor()).find((o) => o.id === ChatOptionId.Shop);
    expect(shop?.scope).toBe(DialogueScope.Personal);

    const rumour = nodeOf(chatFor(merrow), topicNodeId(TopicId.Rumour));
    expect(rumour).toBeDefined();
    if (rumour === undefined) return;
    const rows = visibleOptions(rumour, ctxFor({ askerLevel: STANDING_LEVEL }));
    expect(rows.find((o) => o.id === ChatOptionId.RouteSelf)?.scope).toBe(DialogueScope.Personal);
    expect(rows.find((o) => o.id === ChatOptionId.RouteParty)?.scope).toBe(DialogueScope.Story);
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * AN ANSWER THAT COMES BACK TO ITS OWN NODE IS PRESSABLE FOR EVER. SO IT IS
   * PERSONAL.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * MEASURED OVER A SOCKET: five identical `{nodeId:'greet',optionId:'shop'}`
   * frames produced five shop frames and no refusal. The gateway's staleness
   * check compares `nodeId`, so it stops an answer to a question you are NOT
   * being asked and does nothing at all about the same question twenty times a
   * second — when the option returns to the node it sits on, `nodeId` never
   * moves and every repeat validates.
   *
   * That is harmless for the shelf and would not be for a payment, a recruit or
   * a one-time world offer. `guard-the-proposer-never-reaches` is the shape: the
   * rule that would stop it lives in content nobody has written yet, so it is
   * asserted here on everything shipped, before the first one is.
   */
  it('keeps an option that returns to its own node out of the host’s hands', () => {
    const ctx = ctxFor({ askerLevel: STANDING_LEVEL });
    for (const spec of EVERYBODY) {
      for (const node of chatFor(spec).nodes) {
        for (const option of visibleOptions(node, ctx)) {
          const returned = option.action?.(ctx);
          const next = returned ?? option.jump;
          if (next !== node.id) continue;
          expect(
            option.scope,
            `${spec.id}/${node.id}/${option.id} is a story answer that can be repeated`,
          ).toBe(DialogueScope.Personal);
        }
      }
    }
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * AND A PERSONAL ANSWER MAY NOT REACH A PARTY-WIDE SEAM.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `scopeOf`'s fail-closed default protects the option that FORGETS a scope.
   * Nothing protects the option that declares the WRONG one: the gateway builds
   * one `ChatCtx` and every action gets the same one, so a row marked `personal`
   * could call `revealToParty` and write onto five other characters off a
   * non-lead's click — the ruling inverted through content instead of through
   * the guard. The context is a recorder, so this is what the action DID and not
   * what it looks like it does.
   */
  it('lets only a story answer write onto the rest of the party', () => {
    for (const spec of EVERYBODY) {
      for (const node of chatFor(spec).nodes) {
        for (const option of node.options) {
          let reachedParty = false;
          const mark = (): void => {
            reachedParty = true;
          };
          const ctx = ctxFor({
            askerLevel: STANDING_LEVEL,
            // EVERY PARTY-WIDE SEAM, not only the reveal. `ChatCtx` grew two
            // more — taking an objective on for four people and deleting the
            // content they were offered — and a guard that named only the
            // oldest one would have let either of them ship `personal`.
            revealToParty: () => {
              mark();
              return 0;
            },
            brief: () => OFFERED_BRIEF,
            acceptBrief: () => {
              mark();
              return true;
            },
            declineBrief: () => {
              mark();
              return true;
            },
          });
          if (option.cond?.(ctx) === false) continue;
          option.action?.(ctx);
          if (!reachedParty) continue;
          expect(
            scopeOf(option),
            `${spec.id}/${node.id}/${option.id} writes on the party from a personal row`,
          ).toBe(DialogueScope.Story);
        }
      }
    }
  });
});

describe('the objective, as four rows on every graph and none of them free', () => {
  /** The greeting node, as somebody with an objective to offer would show it. */
  function offering(overrides: Partial<ChatCtx> = {}): ChatCtx {
    return ctxFor({ brief: () => OFFERED_BRIEF, ...overrides });
  }

  /**
   * NOBODY OFFERING ANYTHING SEES ANY OF THEM. Sixteen shopkeepers carry the
   * same four rows on their graphs, and `ctx.brief()` is the whole of what keeps
   * them out of sixteen conversations.
   *
   * MUTANT: drop the `cond` from any of the four. Every townsperson in the game
   * offers work that does not exist.
   */
  it('shows none of them to somebody who is offering nothing', () => {
    const ctx = ctxFor();
    for (const spec of EVERYBODY) {
      for (const node of chatFor(spec).nodes) {
        const ids = visibleOptions(node, ctx).map((o) => o.id);
        expect(ids, `${spec.id}/${node.id} offers work with no objective behind it`).not.toContain(
          ChatOptionId.BriefTake,
        );
        expect(ids).not.toContain(ChatOptionId.BriefAsk);
        expect(ids).not.toContain(ChatOptionId.BriefDecline);
      }
    }
  });

  /**
   * ═══ THE TWO THAT COMMIT THE RUN ARE `story`; THE TWO THAT ASK ARE NOT ═══
   * The author's ruling. Taking an objective commits four people's floor and
   * pays four people's experience; declining deletes the content for all of
   * them. Asking what it is and how far away it is commits nobody.
   *
   * MUTANT: scope `brief:take` or `brief:decline` `personal`. A joining player
   * then answers for the party, which is the whole of what the scope rule is
   * for — and `scopeOf`'s fail-closed default cannot catch a WRONG scope, only
   * a missing one.
   */
  it('reserves taking it and refusing it to the host, and no other row', () => {
    const chat = chatFor(EVERYBODY[0] ?? ({ id: 'none' } as TownsfolkSpec));
    const greet = nodeOf(chat, ChatNodeId.Greet);
    expect(greet, 'no greeting node').toBeDefined();
    if (greet === undefined) return;
    const byId = new Map(visibleOptions(greet, offering()).map((o) => [o.id, o]));
    expect(byId.get(ChatOptionId.BriefTake)?.scope).toBe(DialogueScope.Story);
    expect(byId.get(ChatOptionId.BriefDecline)?.scope).toBe(DialogueScope.Story);
    expect(byId.get(ChatOptionId.BriefAsk)?.scope).toBe(DialogueScope.Personal);
    expect(byId.get(ChatOptionId.Leave)?.scope).toBe(DialogueScope.Personal);
  });

  /**
   * ═══ REFUSING AND LEAVING ARE TWO ROWS, AND THEY MUST STAY TWO ═══
   * If declining were the only way to end this conversation, a joining player
   * who walked away would have declined on behalf of the party.
   *
   * MUTANT: collapse them. `leave` is the unconditional exit every node carries,
   * so the collapse either makes the exit a story row — trapping a non-lead in a
   * window — or makes refusing personal, which hands the content's deletion to
   * anybody who stands next to the offerer.
   */
  it('keeps the exit and the refusal apart, and only the exit is unconditional', () => {
    const chat = chatFor(EVERYBODY[0] ?? ({ id: 'none' } as TownsfolkSpec));
    const greet = nodeOf(chat, ChatNodeId.Greet);
    if (greet === undefined) throw new Error('no greeting node');
    expect(ChatOptionId.BriefDecline).not.toBe(ChatOptionId.Leave);
    const decline = greet.options.find((o) => o.id === ChatOptionId.BriefDecline);
    const leave = greet.options.find((o) => o.id === ChatOptionId.Leave);
    expect(decline?.cond, 'refusing is offered with no objective to refuse').toBeDefined();
    expect(leave?.cond, 'the way out of a conversation grew a condition').toBeUndefined();
    // AND NEITHER GOES ANYWHERE: `engine/dialogs/Chat.lua:104-110`, no jump ends
    // the conversation. An accept that jumped would re-stand a window against a
    // floor that has just changed under it.
    expect(leave?.jump).toBeUndefined();
    expect(decline?.jump).toBeUndefined();
    expect(greet.options.find((o) => o.id === ChatOptionId.BriefTake)?.jump).toBeUndefined();
    expect(
      greet.options.find((o) => o.id === ChatOptionId.BriefTake)?.action?.(offering()),
      'the accept returned a node id, which is a jump by another name',
    ).toBeUndefined();
  });

  /**
   * THE BEARING IS NOT FOR SALE UNTIL SOMEBODY HAS AGREED TO HUNT IT, which is
   * what makes finding it a search on a fifty-by-fifty floor.
   *
   * MUTANT: drop `brief:where`'s condition. The row is then offered on an
   * objective with nowhere to point, and answers *"I could not tell you"* —
   * a button that appears to do nothing, which is the failure this repo keeps
   * finding.
   */
  it('offers the direction only once there is somewhere to point', () => {
    const chat = chatFor(EVERYBODY[0] ?? ({ id: 'none' } as TownsfolkSpec));
    const greet = nodeOf(chat, ChatNodeId.Greet);
    if (greet === undefined) throw new Error('no greeting node');
    const withoutBearing = { ...OFFERED_BRIEF, band: undefined, bearing: undefined };
    const ids = (ctx: ChatCtx): string[] => visibleOptions(greet, ctx).map((o) => o.id);
    expect(ids(offering())).toContain(ChatOptionId.BriefWhere);
    expect(ids(ctxFor({ brief: () => withoutBearing }))).not.toContain(ChatOptionId.BriefWhere);
  });

  /**
   * AND THE OFFER STATES WHAT IT PAYS — `tome/class/GameState.lua:2928` puts the
   * reward inside the question. Refusing must be a PRICED decision.
   *
   * MUTANT: drop the reward clause. Four people in a voice channel are asked to
   * weigh a thing whose payout is a surprise.
   */
  it('says what the work is and that it pays, in the offerer`s own words', () => {
    const chat = chatFor(EVERYBODY[0] ?? ({ id: 'none' } as TownsfolkSpec));
    const ask = nodeOf(chat, ChatNodeId.BriefAsk);
    expect(ask, 'nothing answers "what is down there?"').toBeDefined();
    const said = ask?.text(offering()) ?? '';
    expect(said).toContain(OFFERED_BRIEF.detail);
    expect(said).toContain('Keep it');
    const unpaid = { ...OFFERED_BRIEF, reward: { level: 3, rank: ActorRank.Elite } };
    expect(ask?.text(ctxFor({ brief: () => unpaid }))).not.toContain('Keep it');
  });

  /**
   * ═══ AND THE ONE STRING THAT COUPLES THIS FILE TO THE SERVER'S UNION ═══
   * `content/chats.ts` compares `BriefSnapshot.state` against a literal rather
   * than importing `BriefState`, because a value import would put the realm
   * registry's module on a chat graph's runtime path. The literal is pinned
   * here, from the consumer's side.
   *
   * MUTANT: change either spelling. Both story rows stop passing their
   * condition and the objective can never be taken on at all — silently, with
   * the window open and three rows in it.
   */
  it('pins the one state word the graph spells out', () => {
    expect(BriefState.Offered).toBe('offered');
    const chat = chatFor(EVERYBODY[0] ?? ({ id: 'none' } as TownsfolkSpec));
    const greet = nodeOf(chat, ChatNodeId.Greet);
    if (greet === undefined) throw new Error('no greeting node');
    const taken = { ...OFFERED_BRIEF, state: BriefState.Open };
    const ids = visibleOptions(greet, ctxFor({ brief: () => taken })).map((o) => o.id);
    expect(ids, 'an objective already taken can be taken again').not.toContain(
      ChatOptionId.BriefTake,
    );
    expect(ids).not.toContain(ChatOptionId.BriefDecline);
    // AND THE QUESTIONS SURVIVE IT, which is what a party reads after the fact.
    expect(ids).toContain(ChatOptionId.BriefAsk);
    expect(ids).toContain(ChatOptionId.BriefWhere);
  });
});

describe('what a conversation actually says', () => {
  it('asks the same four questions the menu used to, in the same words', () => {
    // RULING, 2026-09-17: the topic rows move out of the right-click menu and
    // into the window. `TOPIC_LABEL` is the wire vocabulary and neither side
    // retypes it — the defect this replaces is `verbs.ts`'s hand-typed list,
    // where 30 of 51 authored answers were unreachable from any client.
    for (const spec of EVERYBODY) {
      const greet = nodeOf(chatFor(spec), ChatNodeId.Greet);
      expect(greet).toBeDefined();
      const labels = (greet?.options ?? []).map((o) => o.label);
      for (const topic of Object.values(TopicId)) {
        expect(labels, `${spec.id} cannot be asked about ${topic}`).toContain(TOPIC_LABEL[topic]);
      }
    }
  });

  it('answers a topic with the table, level gate included', () => {
    /**
     * THE JOIN, NOT THE HALVES. `answerFor` is shared by the Margin path and the
     * window precisely so the two can never answer the same question two ways —
     * and this asserts the window reads it, at the boundary rather than at the
     * obvious case (`rumour-gate.test.ts`'s own rule).
     */
    for (const spec of EVERYBODY) {
      const node = nodeOf(chatFor(spec), topicNodeId(TopicId.Rumour));
      expect(node).toBeDefined();
      if (node === undefined) continue;
      const below = node.text(ctxFor({ askerLevel: STANDING_LEVEL - 1 }));
      const at = node.text(ctxFor({ askerLevel: STANDING_LEVEL }));
      expect(below).toBe(answerFor(spec, STANDING_LEVEL - 1, TopicId.Rumour));
      expect(at).toBe(answerFor(spec, STANDING_LEVEL, TopicId.Rumour));
      // EVERY ONE OF THE SIXTEEN DEEPENS HERE, which is what makes this a gate
      // rather than a fallthrough — see `TownsfolkSpec.later`.
      expect(at, `${spec.id}: the gate says nothing new`).not.toBe(below);
    }
  });

  it('offers the route rows only once the rumour names somewhere', () => {
    /**
     * THE CONDITION, AT THE BOUNDARY. Merrow Stitch's rumour below
     * `STANDING_LEVEL` names no country — "There is more out there than the map
     * admits to" — and above it names the Sedge. So the two route rows appear
     * with the gate and not before, and `dialogue.test.ts` sends the id anyway
     * at level 1 and is refused.
     *
     * MUTATION: drop `cond` from `routeSelf`/`routeParty` and the first half
     * goes red.
     */
    const merrow = EVERYBODY.find((s) => s.id === 'merrow');
    expect(merrow).toBeDefined();
    if (merrow === undefined) return;
    const node = nodeOf(chatFor(merrow), topicNodeId(TopicId.Rumour));
    expect(node).toBeDefined();
    if (node === undefined) return;

    const shut = visibleOptions(node, ctxFor({ askerLevel: STANDING_LEVEL - 1 })).map((o) => o.id);
    expect(shut).not.toContain(ChatOptionId.RouteSelf);
    expect(shut).not.toContain(ChatOptionId.RouteParty);

    const open = visibleOptions(node, ctxFor({ askerLevel: STANDING_LEVEL })).map((o) => o.id);
    expect(open).toContain(ChatOptionId.RouteSelf);
    expect(open).toContain(ChatOptionId.RouteParty);
  });

  it('reaches the shelf through the window and nowhere else in the graph', () => {
    // THE SHOP SEAM, PROVED TO BE WIRED rather than merely declared: taking the
    // row must call the one function the gateway handed in.
    const merrow = EVERYBODY.find((s) => s.id === 'merrow');
    expect(merrow).toBeDefined();
    if (merrow === undefined) return;
    const greet = nodeOf(chatFor(merrow), ChatNodeId.Greet);
    const shop = greet?.options.find((o) => o.id === ChatOptionId.Shop);
    expect(shop).toBeDefined();

    let opened = 0;
    const back = shop?.action?.(ctxFor({ openShop: () => (opened += 1) }));
    expect(opened).toBe(1);
    // AND IT COMES BACK TO THE GREETING rather than ending — the counter is
    // inside the conversation, not instead of it.
    expect(back).toBe(ChatNodeId.Greet);
  });

  it('offers the counter to a shopkeeper and to nobody else', () => {
    for (const spec of EVERYBODY) {
      const greet = nodeOf(chatFor(spec), ChatNodeId.Greet);
      expect(greet).toBeDefined();
      if (greet === undefined) continue;
      const rows = visibleOptions(greet, ctxFor()).map((o) => o.id);
      expect(rows.includes(ChatOptionId.Shop), `${spec.id}`).toBe(spec.shopkeeper === true);
    }
  });
});

describe('the face in the window', () => {
  it('names a portrait per person, off the name and never off the sprite', () => {
    /**
     * SIX OF THE SIXTEEN WEAR A GENERIC TRADE SPRITE — `chr_npc_bookbinder_s`,
     * `chr_npc_pawnbroker_s` and four more — and every one of the seventeen
     * installed portraits is keyed on the PERSON. Deriving the key from the
     * sprite is right ten times out of sixteen, which is exactly the ratio that
     * survives a spot check and ships six ids nobody drew.
     *
     * Two written out by hand: one who wears her own face, one who does not.
     */
    const byId = new Map(EVERYBODY.map((s) => [s.id, s]));
    const merrow = byId.get('merrow');
    // Nell Cask wears `chr_npc_pawnbroker_s` — a TRADE, not a person — and her
    // portrait is `chr_portrait_nell_cask`. She is one of the six the sprite
    // derivation gets wrong.
    const nell = byId.get('nell');
    expect(merrow).toBeDefined();
    expect(nell).toBeDefined();
    if (merrow === undefined || nell === undefined) return;

    expect(portraitKeyFor(merrow)).toBe('chr_portrait_merrow_stitch');
    expect(nell.sprite).toBe('chr_npc_pawnbroker_s');
    expect(portraitKeyFor(nell)).toBe('chr_portrait_nell_cask');

    // AND SIXTEEN DISTINCT ONES, so two people can never share a face by
    // accident of naming.
    const keys = EVERYBODY.map(portraitKeyFor);
    expect(new Set(keys).size).toBe(EVERYBODY.length);
    for (const key of keys) expect(key).toMatch(/^chr_portrait_[a-z0-9_]+$/);
  });
});

/**
 * The node ids an option's `action` can return, without running it.
 *
 * The derived graph has exactly two such edges and both are named constants, so
 * this is a lookup rather than a closure sweep — running an action to find out
 * where it goes would mean reaching the shop and the fog from a pure test.
 */
function edgesFromAction(option: ChatOption): readonly string[] {
  if (option.id === ChatOptionId.Shop) return [ChatNodeId.Greet];
  if (option.id === ChatOptionId.RouteSelf) return [ChatNodeId.RouteSelf];
  if (option.id === ChatOptionId.RouteParty) return [ChatNodeId.RouteParty];
  return [];
}
