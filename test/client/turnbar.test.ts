/// <reference lib="dom" />

import { describe, expect, it } from 'vitest';

import { AiProfile } from '../../src/server/engine/actor.ts';
import { createDownedState, goDown } from '../../src/server/engine/downed.ts';
import { projectTurn } from '../../src/server/view/projector.ts';
import { createWorld } from '../../src/server/world/world.ts';
import {
  TURN_BAR_H,
  bannerFor,
  bellSeconds,
  isYourTurn,
  owedCount,
  selfCard,
} from '../../src/client/ui/turnbar.ts';
import { MONSTERS_TURN_ID, TurnActorKind, TurnActorState } from '../../src/shared/protocol.ts';
import type { DownedState } from '../../src/server/engine/downed.ts';
import type { TurnState } from '../../src/server/view/projector.ts';
import type { Actor, World } from '../../src/server/world/world.ts';
import type { TurnMsg } from '../../src/shared/protocol.ts';
import type { TurnView } from '../../src/client/ui/turnbar.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE WARRANT CLOCK, READ THE WAY THE HUD READS IT. NO PIXELS ARE ASSERTED.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * THIS FILE WAS THE CARD STRIP'S TEST AND HALF OF IT WENT WITH THE CARDS. The
 * strip of portrait cards across the top of the screen is deleted — the author
 * ruled on 2026-09-18 that there is to be no card and no turn order indicator at
 * all, and that the party pane carries the turn instead. What survived is
 * everything that was never about a card: the barrier's precedence arriving
 * intact on the wire, and the one line of prose ui/turnbar.ts still draws. The
 * per-member half now lives in test/client/partypanel.test.ts, and the band the
 * cards used to spend is measured in test/client/turnband.test.ts.
 *
 * vitest.config.ts is explicit that there is deliberately no canvas test and no
 * jsdom here, and nothing below draws anything. What it tests is the layer
 * between the wire and the paint: the three pure readers every painter consults
 * before it puts a pixel down — `selfCard`, `owedCount`, `bellSeconds` — plus
 * the two sentences `isYourTurn` and `bannerFor` produce, which are also the
 * copy the status line mirrors for a screen reader. A regression in any of them
 * is a HUD that is confidently wrong, which is worse than one that is missing.
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
 * being worth it, the fix is to move these five functions into a DOM-free
 * module and delete this line.
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

const HUSK = { name: 'Index Husk', sprite: 'enemy_index_husk_s' } as const;

/** Three detectives and a husk, so the frame has a hostile side to put last. */
function room(hostile: { readonly name: string; readonly sprite: string } = HUSK): {
  readonly world: World;
  readonly cast: readonly Actor[];
} {
  const world = createWorld('turnbar');
  const cast = [
    world.addPlayer('actor_a', 'Dalt'),
    world.addPlayer('actor_b', 'Sam'),
    world.addPlayer('actor_c', 'Mo'),
  ];
  world.addMonster('mon_a', {
    name: hostile.name,
    sprite: hostile.sprite,
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
    // The engine's own rule (`turnState`): the first still owed is whose turn.
    current: over.whoseTurn?.[0] ?? null,
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

function view(turn: TurnMsg | null, bellMs: number | null = null): TurnView {
  return { turn, bellMs };
}

/** Actor state by actor id, which is how every assertion below is phrased. */
function states(frame: TurnMsg): Record<string, string> {
  const out: Record<string, string> = {};
  for (const card of frame.actors) out[card.id] = card.state;
  return out;
}

// ---------------------------------------------------------------------------
// The mapping — the barrier's precedence, arriving intact
// ---------------------------------------------------------------------------

describe('a turn record wears the barrier state its owner is actually in', () => {
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
    // AND IT SAYS WHO: the turns go one at a time, so there is one person the
    // table is waiting on, and a name is more use than a count.
    expect(bannerFor(view(frame))).toBe('TURN OVER — waiting on Sam');
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
      'YOUR TURN — BELL 12s',
    );
    // Dalt is watching the same Bell run down on somebody else and is told about
    // the person, not about the clock.
    expect(bannerFor(view(frameFor(world, dalt, state, 12_000), 12_000))).toBe(
      'TURN OVER — waiting on Sam',
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

  it('tells the first in line it is their turn, and the rest whose turn it is', () => {
    // THE TURNS GO ONE AT A TIME (2026-09-23). This used to be "never tells a
    // waiting player to wait for their go", when everyone reading `waiting`
    // could act at once; now only the first in line can, and a player behind
    // them needs to know they are in line rather than that it is their move.
    const { world, cast } = room();
    const sam = cast[1];
    const third = cast[2];
    if (sam === undefined || third === undefined) throw new Error('no cast');
    const state = barrier({ engagement: 3, whoseTurn: ['actor_b', 'actor_c'] });

    // THE READER IS NOT ONE OF THE "OTHERS". `owedCount` counts them too.
    const first = frameFor(world, sam, state);
    expect(bannerFor(view(first))).toBe('YOUR TURN — 1 after you');
    expect(isYourTurn(view(first))).toBe(true);

    const behind = frameFor(world, third, state);
    expect(bannerFor(view(behind))).toBe("IN LINE — Sam's turn");
    expect(isYourTurn(view(behind))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Out of combat — one line of prose and nothing else
// ---------------------------------------------------------------------------

describe('out of combat the top HUD still costs one line and no more', () => {
  it('is the same height whether or not there is a fight on', () => {
    /**
     * ═══ THE CARD STRIP IS WHY THIS EXISTS AND WHY IT IS NOW ONE NUMBER ═══
     * `turnHudHeight(view)` was `TURN_BAR_H + turnCardsHeight(turn)`, and the
     * strip was ZERO out of combat and 46 in it, so this was the place that
     * pinned the 46 to `inCombat`. With the cards deleted the top HUD is
     * `TURN_BAR_H` in both states — a claim worth keeping, because every band in
     * main.ts stacks against it and the ratchet that cost the Case Log its size
     * on every fight came from it moving. test/client/turnband.test.ts measures
     * what the map got back.
     */
    const { world, cast } = room();
    const dalt = cast[0];
    expect(dalt).toBeDefined();
    if (dalt === undefined) return;

    const free = frameFor(world, dalt, barrier({ engagement: 0 }));
    const engaged = frameFor(world, dalt, barrier({ engagement: 3, whoseTurn: ['actor_a'] }));

    expect(free.inCombat).toBe(false);
    expect(engaged.inCombat).toBe(true);
    expect(TURN_BAR_H).toBe(14);
  });

  it('says nothing before the first frame arrives, either', () => {
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
    expect(bannerFor(view(frame))).toBe("IN COMBAT — Dalt's turn");
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

  it('keeps the fallen ally in the frame, in place, wearing the same face', () => {
    // A record that vanished when somebody went down would delete the person the
    // party most needs to be looking at; a portrait that changed would be the
    // one face they are trying to recognise. `goDown` swaps the map sprite to
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
 * THE BANNER NEVER NAMES A KEY TO END THE TURN — EVERY ACTION ENDS IT.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * It read "YOUR MOVE — 3/6 AP · 2/3 MP left — SPACE ends your turn", because a
 * step or a talent left the round open and the player had to pass. Testers
 * asked "is it my turn, do I pass?" twice, and the author ruled the open round
 * out: one action is one turn, as ToME's is (`actPlayer`). A banner that still
 * named Space would teach the habit that now burns a turn, and a budget readout
 * would describe a round that no longer exists.
 */
describe('the banner names no key to end the turn', () => {
  it('says whose move it is and nothing about passing', () => {
    const { world, cast } = room();
    const sam = cast[1];
    if (sam === undefined) throw new Error('no cast');
    const frame = frameFor(world, sam, barrier({ engagement: 3, whoseTurn: ['actor_b'] }));

    const line = bannerFor(view(frame));
    expect(line).toBe('YOUR TURN');
    expect(line).not.toContain('SPACE');
    expect(line).not.toContain('AP');
    expect(line).not.toContain('MP');
  });

  it('says only the clock when the Bell is counting', () => {
    // `bellDurationMs` IS WHAT ARMS IT, and `frameFor`'s fourth argument is the
    // milliseconds left at the instant the server sent the frame.
    const { world, cast } = room();
    const sam = cast[1];
    if (sam === undefined) throw new Error('no cast');
    const frame = frameFor(
      world,
      sam,
      barrier({ engagement: 3, whoseTurn: ['actor_b'], bellDurationMs: 20_000 }),
      12_000,
    );
    expect(bannerFor(view(frame, 12_000))).toBe('YOUR TURN — BELL 12s');
  });
});
