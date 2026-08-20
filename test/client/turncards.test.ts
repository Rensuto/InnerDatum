/// <reference lib="dom" />

import { describe, expect, it } from 'vitest';

import { AiProfile } from '../../src/server/engine/actor.ts';
import { createDownedState, goDown } from '../../src/server/engine/downed.ts';
import { projectTurn } from '../../src/server/view/projector.ts';
import { createWorld } from '../../src/server/world/world.ts';
import { TURN_BAR_H, bannerFor, isYourTurn, turnHudHeight } from '../../src/client/ui/turnbar.ts';
import {
  TURN_CARDS_H,
  bellSeconds,
  owedCount,
  selfCard,
  turnCardsHeight,
} from '../../src/client/ui/turncards.ts';
import { MONSTERS_TURN_ID, TurnActorKind, TurnActorState } from '../../src/shared/protocol.ts';
import type { DownedState } from '../../src/server/engine/downed.ts';
import type { TurnState } from '../../src/server/view/projector.ts';
import type { Actor, World } from '../../src/server/world/world.ts';
import type { TurnMsg } from '../../src/shared/protocol.ts';
import type { TurnView } from '../../src/client/ui/turncards.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE TURN TRACKER, READ THE WAY THE HUD READS IT. NO PIXELS ARE ASSERTED.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * vitest.config.ts is explicit that there is deliberately no canvas test and no
 * jsdom here, and nothing below draws anything. What it tests is the layer
 * between the wire and the paint: the four pure readers every painter in
 * ui/turncards.ts and ui/turnbar.ts consults before it puts a pixel down —
 * `selfCard`, `owedCount`, `bellSeconds`, `turnCardsHeight` — plus the two
 * sentences `isYourTurn` and `bannerFor` produce, which are also the copy the
 * status line mirrors for a screen reader. A regression in any of them is a HUD
 * that is confidently wrong, which is worse than one that is missing.
 *
 * THE FRAMES ARE BUILT BY THE REAL PROJECTOR, and that is the point of putting
 * this file here rather than hand-rolling `TurnMsg` literals. The claim under
 * test is not "the client can read a struct" — it is that the barrier's
 * precedence rules survive the trip: a player who still owes a decision arrives
 * as `waiting`, a player who has submitted arrives as `committed`, a body on the
 * floor arrives flagged, and the browser adds NOTHING to that. Hand-built
 * literals would test the test's idea of the server.
 *
 * (A test may import both halves; src/client may not — eslint bans
 * `client/** -> server/**` outright, and `TurnActor.state` exists precisely so
 * the browser never re-derives the barrier's precedence for itself. This file
 * stands on the outside of both and checks that they meet.)
 *
 * THE `reference lib="dom"` AT THE TOP IS DELIBERATE AND HAS A COST. Tests are
 * compiled by tsconfig.server.json, whose `lib` is ES2024 with no DOM — so
 * importing anything from src/client/, which is typed against
 * `CanvasRenderingContext2D`, does not compile without it. The cost is that the
 * DOM lib is then in that whole program, so a stray `document` in src/server/
 * would no longer be a compile error. That trade is worth making for the one
 * UI whose absence was a bug reported from real play; the alternative is that
 * the most-looked-at surface in the game has no test at all. If it ever stops
 * being worth it, the fix is to move these six functions into a DOM-free module
 * and delete this line.
 *
 * IT IS NOT AN INITIATIVE ORDER (DECISIONS.md D1). Inner Datum is phase-locked:
 * every player action costs one full turn, so the whole party decides in the
 * same window and anyone reading `waiting` can act RIGHT NOW. `owedCount` is
 * therefore a CHECKLIST length — how many people have not decided — and never a
 * queue position, which is why the tests below check that it excludes the
 * hostile side and that the banner never tells anybody to wait their turn.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Three detectives and a husk, so the strip has a hostile side to put last. */
function room(): { readonly world: World; readonly cast: readonly Actor[] } {
  const world = createWorld('turncards');
  const cast = [
    world.addPlayer('actor_a', 'Dalt'),
    world.addPlayer('actor_b', 'Sam'),
    world.addPlayer('actor_c', 'Mo'),
  ];
  world.addMonster('mon_a', {
    name: 'Index Husk',
    sprite: 'enemy_index_husk_s',
    x: 8,
    y: 2,
    profile: AiProfile.MeleeChaser,
  });
  return { world, cast };
}

/** A barrier snapshot. `engagement: 0` is a fresh floor — say so to be about combat. */
function barrier(over: Partial<TurnState> = {}): TurnState {
  return {
    gameTurn: 7,
    engagement: 0,
    whoseTurn: [],
    committed: [],
    standingBy: [],
    bellDurationMs: null,
    ...over,
  };
}

/**
 * One frame, as the socket would deliver it to `viewer`.
 *
 * @param bellMs milliseconds LEFT on the Bell at the instant the server sent
 *   the frame. Note that the CLIENT does not draw from this: main.ts holds the
 *   deadline and ticks it locally, which is why `TurnView` carries its own
 *   `bellMs` — a countdown that only moved when a packet arrived would not be a
 *   countdown. Both are supplied below so the two cannot silently diverge.
 */
function frameFor(
  world: World,
  viewer: Actor,
  state: TurnState,
  bellMs: number | null = null,
  downed?: DownedState,
): TurnMsg {
  return projectTurn(viewer, world, state, bellMs, downed);
}

function view(
  turn: TurnMsg | null,
  bellMs: number | null = null,
  budget: TurnView['budget'] = null,
): TurnView {
  return { turn, bellMs, budget };
}

/** Card state by actor id, which is how every assertion below is phrased. */
function states(frame: TurnMsg): Record<string, string> {
  const out: Record<string, string> = {};
  for (const card of frame.actors) out[card.id] = card.state;
  return out;
}

// ---------------------------------------------------------------------------
// The mapping — the barrier's precedence, arriving intact
// ---------------------------------------------------------------------------

describe('a card wears the barrier state its owner is actually in', () => {
  it('reads waiting for the ones who still owe a decision, and committed for the rest', () => {
    // Sam still owes; Dalt and Mo are in no array at all, which under this
    // barrier is what "already submitted" looks like — `whoseTurn` is the
    // BLOCKING set, so leaving it is the commit.
    const { world, cast } = room();
    const dalt = cast[0];
    expect(dalt).toBeDefined();
    if (dalt === undefined) return;

    const frame = frameFor(world, dalt, barrier({ engagement: 3, whoseTurn: ['actor_b'] }));

    expect(states(frame)).toEqual({
      actor_a: TurnActorState.Committed,
      actor_b: TurnActorState.Waiting,
      actor_c: TurnActorState.Committed,
      // The sweep is queued behind the party while a human still owes a move.
      [MONSTERS_TURN_ID]: TurnActorState.Waiting,
    });

    // ONE PERSON, and the hostile side is not one of them. Counting the
    // aggregate would tell three people they are waiting on four.
    expect(owedCount(frame)).toBe(1);
  });

  it('still reads committed for an id the server put in `committed`', () => {
    // `TurnMsg.committed` is documented as "the subset of `whoseTurn` that has
    // already committed", and it is EMPTY BY CONSTRUCTION because `whoseTurn`
    // only ever holds the actors that still owe — the two cannot overlap. So a
    // card must never be derived from that array, and this pins that: naming
    // Dalt in `committed` changes nothing, because not blocking is the fact.
    const { world, cast } = room();
    const dalt = cast[0];
    expect(dalt).toBeDefined();
    if (dalt === undefined) return;

    const frame = frameFor(
      world,
      dalt,
      barrier({ engagement: 3, whoseTurn: ['actor_b'], committed: ['actor_a'] }),
    );

    expect(states(frame).actor_a).toBe(TurnActorState.Committed);
    expect(selfCard(frame)?.state).toBe(TurnActorState.Committed);
    // Committed with somebody still deciding is a different sentence from
    // committed with nobody left, and both are true statements about the party
    // rather than about you.
    // "TURN OVER" AND NOT "committed" — the engine's word is not the player's, and
    // a player who has finished has to KNOW they have finished or they go on
    // pressing keys at a game that is waiting for somebody else.
    expect(bannerFor(view(frame))).toBe('TURN OVER — waiting on 1');
    expect(isYourTurn(view(frame))).toBe(false);
  });

  it('reads standing_by for the ones the barrier has stopped waiting on', () => {
    // Two silent turns, or a dropped socket. Their token is still on the map and
    // still gets hit; they are simply not being waited for.
    const { world, cast } = room();
    const mo = cast[2];
    expect(mo).toBeDefined();
    if (mo === undefined) return;

    const frame = frameFor(
      world,
      mo,
      barrier({ engagement: 3, whoseTurn: ['actor_b'], standingBy: ['actor_c'] }),
    );

    expect(states(frame).actor_c).toBe(TurnActorState.StandingBy);
    expect(owedCount(frame)).toBe(1);
    expect(bannerFor(view(frame))).toBe(
      'STANDING BY — any command puts you back in the turn order',
    );
  });

  it('says the monsters are ACTING once the party has stopped deciding', () => {
    const { world, cast } = room();
    const dalt = cast[0];
    expect(dalt).toBeDefined();
    if (dalt === undefined) return;

    const frame = frameFor(world, dalt, barrier({ engagement: 3, whoseTurn: [] }));
    expect(states(frame)[MONSTERS_TURN_ID]).toBe(TurnActorState.Acting);
    expect(owedCount(frame)).toBe(0);
    expect(bannerFor(view(frame))).toBe('TURN OVER — resolving');
  });
});

// ---------------------------------------------------------------------------
// The Bell — one countdown, on the people it is counting
// ---------------------------------------------------------------------------

describe('the Bell decorates the straggler and nobody else', () => {
  it('marks only the cards that still owe a decision', () => {
    // The Bell exists because one person deliberating is how this genre dies. It
    // is a courtesy extended to PEOPLE: it never rings for a player who has
    // already submitted, never for one outside the quorum, and never for the
    // hostile side.
    const { world, cast } = room();
    const sam = cast[1];
    expect(sam).toBeDefined();
    if (sam === undefined) return;

    const state = barrier({
      engagement: 3,
      whoseTurn: ['actor_b'],
      standingBy: ['actor_c'],
      bellDurationMs: 20_000,
    });

    const silent = frameFor(world, sam, state, null);
    expect(states(silent)).toEqual({
      actor_a: TurnActorState.Committed,
      actor_b: TurnActorState.Waiting,
      actor_c: TurnActorState.StandingBy,
      [MONSTERS_TURN_ID]: TurnActorState.Waiting,
    });

    const ringing = frameFor(world, sam, state, 12_000);
    expect(ringing.actors.filter((c) => c.state === TurnActorState.Bell).map((c) => c.id)).toEqual([
      'actor_b',
    ]);
    // Everyone else is untouched by it — the Bell changes exactly one card.
    expect(states(ringing).actor_a).toBe(TurnActorState.Committed);
    expect(states(ringing).actor_c).toBe(TurnActorState.StandingBy);
    expect(states(ringing)[MONSTERS_TURN_ID]).toBe(TurnActorState.Waiting);

    // A Bell card is still a card that owes a decision, so the checklist count
    // does not change when the countdown starts.
    expect(owedCount(ringing)).toBe(owedCount(silent));
  });

  it('puts the digits in the straggler’s sentence and in nobody else’s', () => {
    const { world, cast } = room();
    const dalt = cast[0];
    const sam = cast[1];
    expect(dalt).toBeDefined();
    expect(sam).toBeDefined();
    if (dalt === undefined || sam === undefined) return;

    const state = barrier({ engagement: 3, whoseTurn: ['actor_b'], bellDurationMs: 20_000 });

    expect(bannerFor(view(frameFor(world, sam, state, 12_000), 12_000))).toBe(
      'YOUR MOVE — BELL 12s — SPACE ends your turn',
    );
    // Dalt is watching the same Bell run down on somebody else and is told about
    // the person, not about the clock.
    expect(bannerFor(view(frameFor(world, dalt, state, 12_000), 12_000))).toBe(
      'TURN OVER — waiting on 1',
    );
  });

  it('rounds up, so a running Bell never displays 0', () => {
    // A countdown that reads 0 for the last 999 ms is a countdown that has
    // already lied about the deadline once per turn.
    expect(bellSeconds(null)).toBeNull();
    expect(bellSeconds(12_000)).toBe(12);
    expect(bellSeconds(11_001)).toBe(12);
    expect(bellSeconds(1)).toBe(1);
    expect(bellSeconds(0)).toBe(0);
    // Never negative: the local tick can overshoot the server's deadline.
    expect(bellSeconds(-500)).toBe(0);
  });

  it('never tells a waiting player to wait for their go', () => {
    // The phase-locked rule, as copy. Everyone reading `waiting` may act now,
    // and a sentence implying a queue would produce exactly the spinner D1
    // exists to prevent.
    const { world, cast } = room();
    const sam = cast[1];
    expect(sam).toBeDefined();
    if (sam === undefined) return;

    const frame = frameFor(
      world,
      sam,
      barrier({ engagement: 3, whoseTurn: ['actor_b', 'actor_c'] }),
    );
    const line = bannerFor(view(frame));

    // THE READER IS NOT ONE OF THE "OTHERS". `owedCount` counts them too, and
    // the old copy said "2 still deciding" to somebody who was one of the two.
    expect(line).toBe('YOUR MOVE — SPACE ends your turn — 1 other deciding');
    expect(isYourTurn(view(frame))).toBe(true);
    expect(line.toLowerCase()).not.toContain('wait your turn');
    expect(line.toLowerCase()).not.toContain('next up');
  });
});

// ---------------------------------------------------------------------------
// Out of combat — the strip is not drawn at all
// ---------------------------------------------------------------------------

describe('out of combat the strip renders nothing', () => {
  it('costs the map zero pixels when engagement is 0', () => {
    // Free movement needs no turn tracker: nobody blocks and nothing is owed. A
    // permanently visible strip of eight ticks trains people to stop looking at
    // the one surface that has to be believed the moment it does mean something.
    const { world, cast } = room();
    const dalt = cast[0];
    expect(dalt).toBeDefined();
    if (dalt === undefined) return;

    const free = frameFor(world, dalt, barrier({ engagement: 0 }));
    const engaged = frameFor(world, dalt, barrier({ engagement: 3, whoseTurn: ['actor_a'] }));

    expect(free.inCombat).toBe(false);
    expect(turnCardsHeight(free)).toBe(0);
    expect(turnHudHeight(view(free))).toBe(TURN_BAR_H);

    expect(engaged.inCombat).toBe(true);
    expect(turnCardsHeight(engaged)).toBe(TURN_CARDS_H);
    expect(turnHudHeight(view(engaged))).toBe(TURN_BAR_H + TURN_CARDS_H);
  });

  it('draws nothing before the first frame arrives, either', () => {
    expect(turnCardsHeight(null)).toBe(0);
    expect(selfCard(null)).toBeNull();
    expect(owedCount(null)).toBe(0);
    expect(isYourTurn(view(null))).toBe(false);
    expect(bannerFor(view(null))).toBe('waiting for the server');
  });

  it('reads free movement as YOUR MOVE, not as a party that has all committed', () => {
    // Out of combat the projector marks every card `committed` — a true
    // statement about the BARRIER and the opposite of the truth about the
    // PLAYER, who may act freely. `inCombat` is the flag that keeps the two
    // apart, and it is the reason the strip is not merely hidden by an empty
    // `whoseTurn`.
    const { world, cast } = room();
    const dalt = cast[0];
    expect(dalt).toBeDefined();
    if (dalt === undefined) return;

    const free = frameFor(world, dalt, barrier({ engagement: 0 }));

    expect(owedCount(free)).toBe(0);
    expect(isYourTurn(view(free))).toBe(true);
    expect(bannerFor(view(free))).toBe('YOUR MOVE — free movement, nothing is hunting you');
    // And no hostile side out of combat: a card for it would say the party is
    // waiting on something.
    expect(free.actors.some((c) => c.kind === TurnActorKind.Monsters)).toBe(false);
  });

  it('highlights nobody for a socket with no card of its own', () => {
    // A spectator, or a body still being assigned. `isSelf` is the server's
    // answer to "which card is you"; "nobody" has to be stated, not inferred
    // from a comparison that happens to fail.
    const { world } = room();
    const ghost = world.addMonster('mon_ghost', {
      name: 'Index Husk',
      sprite: 'enemy_index_husk_s',
      x: 9,
      y: 2,
      profile: AiProfile.MeleeChaser,
    });

    const frame = frameFor(world, ghost, barrier({ engagement: 3, whoseTurn: ['actor_a'] }));
    expect(selfCard(frame)).toBeNull();
    expect(isYourTurn(view(frame))).toBe(false);
    expect(bannerFor(view(frame))).toBe('IN COMBAT — turn 7 — waiting on 1');
  });
});

// ---------------------------------------------------------------------------
// Downed — the one card the party most needs, whatever the barrier says
// ---------------------------------------------------------------------------

describe('a body on the floor is flagged whatever else is true of it', () => {
  it('is downed in every barrier state the arrays could put it in', () => {
    // `surveyQuorum` skips a body that is not standing BEFORE it decides
    // anything, so a Downed detective is normally in NEITHER `whoseTurn` NOR
    // `standingBy` — which is exactly the case three id arrays cannot express,
    // and the reason a client-side derivation used to call them "committed" and
    // tell the party that the person bleeding out had taken their turn. All
    // three arrangements are checked because none of them may change the answer.
    const arrangements: readonly (readonly [string, Partial<TurnState>])[] = [
      ['in neither array', {}],
      ['named as still owing', { whoseTurn: ['actor_b'] }],
      ['named as standing by', { standingBy: ['actor_b'] }],
    ];

    for (const [label, over] of arrangements) {
      const { world, cast } = room();
      const dalt = cast[0];
      const sam = cast[1];
      expect(dalt, label).toBeDefined();
      expect(sam, label).toBeDefined();
      if (dalt === undefined || sam === undefined) return;

      const downed = createDownedState();
      goDown(downed, sam, 7);

      const frame = frameFor(world, dalt, barrier({ engagement: 3, ...over }), null, downed);
      const card = frame.actors.find((c) => c.id === 'actor_b');

      expect(card?.downed, label).toBe(true);
      // Out of the quorum entirely — the barrier is genuinely not waiting on
      // them — and `downed` is the half that says WHY, which is the half that
      // means *get to them*.
      expect(card?.state, label).toBe(TurnActorState.StandingBy);
      // So they are never on the checklist of people still deciding.
      expect(owedCount(frame), label).toBe(0);
    }
  });

  it('tells the fallen player they can still talk, and never that they are dead', () => {
    // game-design.md § 9: at 0 hp a detective is *Unfiled*, not dead — prone,
    // still able to speak in the Margin, and revivable by any ally who reaches
    // them. "You can still talk" is what stops it being a spectator seat.
    const { world, cast } = room();
    const sam = cast[1];
    expect(sam).toBeDefined();
    if (sam === undefined) return;

    const downed = createDownedState();
    goDown(downed, sam, 7);

    const frame = frameFor(world, sam, barrier({ engagement: 3 }), null, downed);

    expect(selfCard(frame)?.downed).toBe(true);
    expect(isYourTurn(view(frame))).toBe(false);
    expect(bannerFor(view(frame))).toBe(
      'DOWN — you can still talk, and an ally can still reach you',
    );
  });

  it('keeps the fallen ally on the strip, in place, wearing the same face', () => {
    // A card that vanished when somebody went down would delete the person the
    // party most needs to be looking at; a portrait that changed would be the
    // one card they are trying to recognise. `goDown` swaps the map sprite to
    // the `_downed_s` variant and the projector strips the suffix for that
    // reason alone.
    const { world, cast } = room();
    const dalt = cast[0];
    const sam = cast[1];
    expect(dalt).toBeDefined();
    expect(sam).toBeDefined();
    if (dalt === undefined || sam === undefined) return;

    const state = barrier({ engagement: 3, whoseTurn: ['actor_a'] });
    const standing = frameFor(world, dalt, state);
    const portraits = standing.actors.map((c) => c.portrait);

    const downed = createDownedState();
    goDown(downed, sam, 7);
    const fallen = frameFor(world, dalt, state, null, downed);

    expect(fallen.actors.map((c) => c.id)).toEqual(standing.actors.map((c) => c.id));
    expect(fallen.actors.map((c) => c.portrait)).toEqual(portraits);
    // And the strip is still drawn, at the same height — the map must not resize
    // because somebody fell over.
    expect(turnCardsHeight(fallen)).toBe(turnCardsHeight(standing));
  });

  it('is never down without a survival table to say so', () => {
    // A corpse and a Downed detective are the same two fields on an actor
    // (`alive: false`, `hp: 0`) and only the survival table knows the
    // difference. Absent, the honest answer is "nobody is on the floor" rather
    // than a fabricated five-turn timer over a body that will never get up.
    const { world, cast } = room();
    const dalt = cast[0];
    const sam = cast[1];
    expect(dalt).toBeDefined();
    expect(sam).toBeDefined();
    if (dalt === undefined || sam === undefined) return;

    goDown(createDownedState(), sam, 7);
    const frame = frameFor(world, dalt, barrier({ engagement: 3, whoseTurn: ['actor_a'] }));
    const card = frame.actors.find((c) => c.id === 'actor_b');

    expect(card?.downed).toBe(false);
    expect(card?.state).toBe(TurnActorState.StandingBy);
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *    "IS IT MY TURN, AND AM I SUPPOSED TO PASS?" — THE BANNER HAS TO ANSWER.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * REPORTED BY A PLAYER, in those words: *"I can move once and use an ability,
 * but the turn doesn't end until I pass."*
 *
 * THE ENGINE WAS ALREADY RIGHT. `hasAffordableAction` closes the round the
 * moment nothing is off cooldown and affordable on BOTH budgets, so a player who
 * genuinely has nothing left is passed automatically and the world moves. What
 * they hit is the case where something IS still affordable: a talent costs its
 * AP out of six, a step costs 1 MP out of three, so after a move and an ability
 * there is usually a whole action left in the round. The engine correctly asks
 * again. The player, seeing the same sentence they saw before they acted, reads
 * that as the game ignoring them.
 *
 * So this is a COPY fix and a WIRE fix, not an engine one: the numbers the
 * engine decides on were never on screen. `ResourceView` carried `ap` and not
 * `mp`, and the banner carried neither.
 */
describe('the banner answers whether you are done', () => {
  const BUDGET = { ap: 3, maxAp: 6, mp: 2, maxMp: 3 };

  it('says what is left in the round while it is your move', () => {
    const { world, cast } = room();
    const sam = cast[1];
    if (sam === undefined) throw new Error('no cast');
    const frame = frameFor(world, sam, barrier({ engagement: 3, whoseTurn: ['actor_b'] }));

    // ═══ THE ASSERTION THAT WAS FAILING ═══
    // Before: "IN COMBAT — YOUR TURN — space: commit · . : hold" — whose turn,
    // then a list of keys, and nothing about whether there was anything left.
    expect(bannerFor(view(frame, null, BUDGET))).toBe(
      'YOUR MOVE — 3/6 AP · 2/3 MP left — SPACE ends your turn',
    );
  });

  it('shows BOTH budgets, because a round can end on either', () => {
    /**
     * A step costs 1 MP of 3 and a talent costs its AP of 6, so a Watchman
     * holding four AP and no MP is full of swings and out of moves. A HUD
     * showing only AP would leave him wondering why he could not walk — which
     * is the same confusion this whole change is about, one budget over.
     */
    const { world, cast } = room();
    const sam = cast[1];
    if (sam === undefined) throw new Error('no cast');
    const frame = frameFor(world, sam, barrier({ engagement: 3, whoseTurn: ['actor_b'] }));

    const line = bannerFor(view(frame, null, { ap: 4, maxAp: 6, mp: 0, maxMp: 3 }));
    expect(line).toContain('4/6 AP');
    expect(line).toContain('0/3 MP');
  });

  it('says nothing about a budget it has not been given', () => {
    // ═══ THE HALF THAT MUST NOT MOVE ═══
    // A client can outlive a server that never sends the MP fields, and there is
    // no budget at all before the first `resource` frame lands. Half a budget on
    // screen is worse than none: "3/6 AP" with no MP beside it cannot tell a
    // player whether the round ended because the legs ran out.
    const { world, cast } = room();
    const sam = cast[1];
    if (sam === undefined) throw new Error('no cast');
    const frame = frameFor(world, sam, barrier({ engagement: 3, whoseTurn: ['actor_b'] }));

    const line = bannerFor(view(frame, null, null));
    expect(line).toBe('YOUR MOVE — SPACE ends your turn');
    expect(line).not.toContain('AP');
  });

  it('leads with the clock when the Bell is counting, and still says the budget', () => {
    // The one state where the clock outranks the arithmetic: a player being
    // counted down needs the seconds first.
    const { world, cast } = room();
    const sam = cast[1];
    if (sam === undefined) throw new Error('no cast');
    // `bellDurationMs` IS WHAT ARMS IT, and `frameFor`'s fourth argument is the
    // milliseconds left at the instant the server sent the frame — the same
    // shape the existing straggler test uses.
    const frame = frameFor(
      world,
      sam,
      barrier({ engagement: 3, whoseTurn: ['actor_b'], bellDurationMs: 20_000 }),
      12_000,
    );
    const line = bannerFor(view(frame, 12_000, BUDGET));
    expect(line.startsWith('YOUR MOVE — BELL 12s')).toBe(true);
    expect(line).toContain('3/6 AP');
  });
});
