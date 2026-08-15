import { describe, expect, it } from 'vitest';

import {
  AiProfile,
  HOLD_INTENT,
  IntentKind,
  createPlayerActor,
} from '../../src/server/engine/actor.ts';
import { BELL_MS, createBarrier, surveyQuorum } from '../../src/server/engine/barrier.ts';
import { createDownedState, goDown } from '../../src/server/engine/downed.ts';
import {
  INVITE_TTL_MS,
  MAX_PARTY_SIZE,
  PartyRefusal,
  accept,
  createPartyState,
  decline,
  forgetActor,
  invite,
  invitesFor,
  isLeader,
  kick,
  leave,
  liveInvites,
  membersOf,
  partyIdOf,
  partyOf,
  sameParty,
} from '../../src/server/engine/party.ts';
import { pump, submitIntent } from '../../src/server/engine/scheduler.ts';
import { createTurnEngine } from '../../src/server/turn-engine.ts';
import { createWorld } from '../../src/server/world/world.ts';
import { chebyshev } from '../../src/shared/coords.ts';
import { ENERGY_TO_ACT } from '../../src/shared/energy.ts';
import { PartyAction, parseClientMsg } from '../../src/shared/protocol.ts';
import { PROTOCOL_VERSION } from '../../src/shared/version.ts';
import type { Barrier } from '../../src/server/engine/barrier.ts';
import type { DownedState } from '../../src/server/engine/downed.ts';
import type { PartyState } from '../../src/server/engine/party.ts';
import type { Actor, World } from '../../src/server/world/world.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * EXPLICIT PARTIES — WHO SHARES YOUR BARRIER
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * THE PROPERTY THIS FILE EXISTS TO DEFEND, in one sentence: A SOLO PLAYER MUST
 * NEVER WAIT ON SOMEBODY WHO IS NOT IN THEIR PARTY. That is the reported bug —
 * a friend's body stayed on the floor, engagement was above zero, and the
 * level-wide barrier held a stranger's turn hostage to it — and it is the one
 * thing every test below is ultimately about.
 *
 * THE SECOND PROPERTY IS THE ONE THAT IS EASY TO BREAK WHILE FIXING THE FIRST:
 * within a party, NOTHING CHANGES. engine/barrier.ts argues at length that above
 * `engagement > 0` every player blocks, including one thirty tiles away, because
 * otherwise somebody walks fifty free tiles while a friend tanks. That argument
 * is untouched — it now applies to the party rather than to the level — and
 * `holds a party-mate's turn` below is the test that says so.
 */

const NOW = 1_000_000;

function seat(id: string) {
  return createPlayerActor(id, { name: id, sprite: 'chr_player_watchman_s', x: 0, y: 0 });
}

/** A party table with `ids` already known to it, each in their own party of one. */
function table(...ids: readonly string[]): PartyState {
  const state = createPartyState();
  for (const id of ids) partyOf(state, id);
  return state;
}

/** `a` invites `b` and `b` says yes. The two-line setup most tests start from. */
function group(state: PartyState, a: string, b: string): void {
  expect(invite(state, a, b, NOW).ok).toBe(true);
  expect(accept(state, b, a, NOW).ok).toBe(true);
}

// ---------------------------------------------------------------------------
// The table itself
// ---------------------------------------------------------------------------

describe('every player is always in a party', () => {
  it('mints a party of one on first sight, and it is idempotent', () => {
    const state = createPartyState();

    const first = partyOf(state, 'p1');
    expect(first.members).toEqual(['p1']);
    expect(first.leaderId).toBe('p1');
    // THE WHOLE REASON THERE IS NO NULL. Five call sites ask this question every
    // pump, and an answer that could be undefined is five fallbacks that can
    // each be written wrong — see the header of engine/party.ts.
    expect(partyOf(state, 'p1')).toBe(first);
    expect(state.byId.size).toBe(1);
  });

  it('puts two strangers in different parties', () => {
    const state = table('p1', 'p2');
    expect(sameParty(state, 'p1', 'p2')).toBe(false);
    // You are always in your own party, which is not a special case: a player
    // always owes their own party a decision.
    expect(sameParty(state, 'p1', 'p1')).toBe(true);
  });

  it('is deterministic — no clock, no randomness in an id', () => {
    const a = table('p1', 'p2');
    const b = table('p1', 'p2');
    expect(partyIdOf(a, 'p1')).toBe(partyIdOf(b, 'p1'));
    expect(partyIdOf(a, 'p2')).toBe(partyIdOf(b, 'p2'));
  });
});

describe('invite, accept, decline', () => {
  it('an invite changes neither party until it is accepted', () => {
    const state = table('p1', 'p2');
    const sent = invite(state, 'p1', 'p2', NOW);

    expect(sent.ok).toBe(true);
    expect(membersOf(state, 'p1')).toEqual(['p1']);
    expect(membersOf(state, 'p2')).toEqual(['p2']);
    expect(invitesFor(state, 'p2', NOW)).toHaveLength(1);
    // Never a list of what you sent — see `PartyInviteView` in protocol.ts.
    expect(invitesFor(state, 'p1', NOW)).toHaveLength(0);
  });

  it('accepting joins the inviter, in join order, under their leader', () => {
    const state = table('p1', 'p2');
    group(state, 'p1', 'p2');

    expect(membersOf(state, 'p1')).toEqual(['p1', 'p2']);
    expect(sameParty(state, 'p1', 'p2')).toBe(true);
    expect(isLeader(state, 'p1')).toBe(true);
    expect(isLeader(state, 'p2')).toBe(false);
    // The accepter's own party of one is DELETED, not left standing empty: an
    // empty row is one a still-live invite could resolve into.
    expect(state.byId.size).toBe(1);
    // And the offer is spent.
    expect(invitesFor(state, 'p2', NOW)).toHaveLength(0);
  });

  it('reports both parties as affected, because one of them ceases to exist', () => {
    const state = table('p1', 'p2', 'p3');
    group(state, 'p1', 'p2');

    const joined = accept(state, 'p3', undefined, NOW + 1);
    expect(joined.ok).toBe(false); // no offer yet

    expect(invite(state, 'p1', 'p3', NOW).ok).toBe(true);
    const result = accept(state, 'p3', 'p1', NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // p3's old party is gone by the time anybody could ask about it, which is
    // exactly why the engine reports this list rather than the gateway deriving
    // it: every one of these needs a fresh `party_state`.
    expect([...result.affected].sort()).toEqual(['p1', 'p2', 'p3']);
  });

  it('answers the OLDEST offer when no inviter is named', () => {
    const state = table('p1', 'p2', 'p3');
    expect(invite(state, 'p1', 'p3', NOW).ok).toBe(true);
    expect(invite(state, 'p2', 'p3', NOW).ok).toBe(true);

    // Insertion order, so "oldest" does not depend on two timestamps that can
    // land in the same millisecond.
    expect(accept(state, 'p3', undefined, NOW).ok).toBe(true);
    expect(sameParty(state, 'p1', 'p3')).toBe(true);
    expect(sameParty(state, 'p2', 'p3')).toBe(false);
    // Joining somebody clears every other prompt on your screen.
    expect(invitesFor(state, 'p3', NOW)).toHaveLength(0);
  });

  it('declining removes the prompt and nothing else', () => {
    const state = table('p1', 'p2');
    expect(invite(state, 'p1', 'p2', NOW).ok).toBe(true);

    expect(decline(state, 'p2', 'p1', NOW).ok).toBe(true);
    expect(invitesFor(state, 'p2', NOW)).toHaveLength(0);
    expect(sameParty(state, 'p1', 'p2')).toBe(false);
    expect(decline(state, 'p2', 'p1', NOW)).toEqual({
      ok: false,
      reason: PartyRefusal.NoInvite,
    });
  });

  it('refuses the invites that cost nothing to refuse', () => {
    const state = table('p1', 'p2');

    expect(invite(state, 'p1', 'p1', NOW)).toEqual({ ok: false, reason: PartyRefusal.Self });
    expect(invite(state, 'p1', 'p2', NOW).ok).toBe(true);
    // Re-sending does NOT refresh the clock — otherwise one player could keep a
    // prompt on a stranger's screen forever.
    expect(invite(state, 'p1', 'p2', NOW + 1)).toEqual({
      ok: false,
      reason: PartyRefusal.AlreadyInvited,
    });
    expect(invitesFor(state, 'p2', NOW)[0]?.expiresAtMs).toBe(NOW + INVITE_TTL_MS);

    expect(accept(state, 'p2', 'p1', NOW).ok).toBe(true);
    expect(invite(state, 'p1', 'p2', NOW)).toEqual({
      ok: false,
      reason: PartyRefusal.AlreadyTogether,
    });
  });

  it('lapses an invite after INVITE_TTL_MS, and answers it as if it never was', () => {
    const state = table('p1', 'p2');
    expect(invite(state, 'p1', 'p2', NOW).ok).toBe(true);

    expect(invitesFor(state, 'p2', NOW + INVITE_TTL_MS - 1)).toHaveLength(1);
    expect(invitesFor(state, 'p2', NOW + INVITE_TTL_MS)).toHaveLength(0);
    expect(accept(state, 'p2', 'p1', NOW + INVITE_TTL_MS)).toEqual({
      ok: false,
      reason: PartyRefusal.NoInvite,
    });
    expect(sameParty(state, 'p1', 'p2')).toBe(false);
    // Pruned on read, because there is no timer in engine/.
    expect(liveInvites(state, NOW + INVITE_TTL_MS)).toHaveLength(0);
    expect(state.invites.size).toBe(0);
  });

  it('caps a party at MAX_PARTY_SIZE, at both ends', () => {
    const ids = Array.from({ length: MAX_PARTY_SIZE + 2 }, (_u, i) => `p${String(i + 1)}`);
    const state = table(...ids);

    for (let i = 1; i < MAX_PARTY_SIZE; i += 1) group(state, 'p1', `p${String(i + 1)}`);
    expect(membersOf(state, 'p1')).toHaveLength(MAX_PARTY_SIZE);

    // The courtesy check, so the inviter is told immediately.
    expect(invite(state, 'p1', `p${String(MAX_PARTY_SIZE + 1)}`, NOW)).toEqual({
      ok: false,
      reason: PartyRefusal.PartyFull,
    });
  });

  it('refuses the SECOND of two people holding invites to the last seat', () => {
    const state = table('a', 'b', 'c', 'd', 'e');
    // A party of MAX - 1, with two offers out for the final seat.
    for (let i = 1; i < MAX_PARTY_SIZE - 1; i += 1) {
      group(state, 'a', ['b', 'c', 'd'][i - 1] ?? 'b');
    }
    expect(invite(state, 'a', 'd', NOW).ok).toBe(true);
    expect(invite(state, 'a', 'e', NOW).ok).toBe(true);

    expect(accept(state, 'd', 'a', NOW).ok).toBe(true);
    // THE REAL CHECK IS HERE, not at invite time: the seat filled while `e` was
    // deciding, and their own party of one must be left exactly as it was.
    expect(accept(state, 'e', 'a', NOW)).toEqual({ ok: false, reason: PartyRefusal.PartyFull });
    expect(membersOf(state, 'e')).toEqual(['e']);
  });
});

describe('leaving and being removed always land in a party of one', () => {
  it('leaves, and is never in limbo', () => {
    const state = table('p1', 'p2');
    group(state, 'p1', 'p2');

    const result = leave(state, 'p2');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(membersOf(state, 'p2')).toEqual(['p2']);
    expect(isLeader(state, 'p2')).toBe(true);
    expect(membersOf(state, 'p1')).toEqual(['p1']);
    expect(sameParty(state, 'p1', 'p2')).toBe(false);
    // The people left behind need a fresh frame; so does the leaver.
    expect([...result.affected].sort()).toEqual(['p1', 'p2']);
  });

  it('hands the leader badge on rather than dissolving the party', () => {
    const state = table('p1', 'p2', 'p3');
    group(state, 'p1', 'p2');
    group(state, 'p1', 'p3');

    expect(leave(state, 'p1').ok).toBe(true);
    // The people still standing together did not ask to be scattered.
    expect(membersOf(state, 'p2')).toEqual(['p2', 'p3']);
    expect(isLeader(state, 'p2')).toBe(true);
    expect(sameParty(state, 'p2', 'p3')).toBe(true);
  });

  it('refuses to leave a party of one, rather than silently re-minting', () => {
    const state = table('p1');
    expect(leave(state, 'p1')).toEqual({ ok: false, reason: PartyRefusal.Solo });
  });

  it('kicks — leader only, never yourself, never a stranger', () => {
    const state = table('p1', 'p2', 'p3');
    group(state, 'p1', 'p2');

    expect(kick(state, 'p2', 'p1')).toEqual({ ok: false, reason: PartyRefusal.NotLeader });
    expect(kick(state, 'p1', 'p1')).toEqual({ ok: false, reason: PartyRefusal.Self });
    expect(kick(state, 'p1', 'p3')).toEqual({ ok: false, reason: PartyRefusal.NotAMember });
    // Not one of those refusals moved anybody.
    expect(membersOf(state, 'p1')).toEqual(['p1', 'p2']);

    const result = kick(state, 'p1', 'p2');
    expect(result.ok).toBe(true);
    expect(membersOf(state, 'p1')).toEqual(['p1']);
    // A KICK IS A BARRIER BOUNDARY, NOT A BAN. They keep playing, alone.
    expect(membersOf(state, 'p2')).toEqual(['p2']);
    expect(isLeader(state, 'p2')).toBe(true);
  });

  it('ONLY THE LEADER may kick — the badge decides, not seniority', () => {
    // Two members who both joined and neither of whom carries the badge. The
    // refusal above is between a member and the leader; this is the case that
    // would let a party remove people out from under the person organising it.
    const state = table('p1', 'p2', 'p3');
    group(state, 'p1', 'p2');
    group(state, 'p1', 'p3');

    expect(kick(state, 'p2', 'p3')).toEqual({ ok: false, reason: PartyRefusal.NotLeader });
    expect(kick(state, 'p3', 'p2')).toEqual({ ok: false, reason: PartyRefusal.NotLeader });
    expect(membersOf(state, 'p1')).toEqual(['p1', 'p2', 'p3']);

    // ...and the badge is genuinely what is being read: when the leader walks
    // out it is handed to `members[0]`, who may then remove somebody.
    expect(leave(state, 'p1').ok).toBe(true);
    expect(isLeader(state, 'p2')).toBe(true);
    expect(kick(state, 'p2', 'p3').ok).toBe(true);
    expect(membersOf(state, 'p2')).toEqual(['p2']);
    expect(membersOf(state, 'p3')).toEqual(['p3']);
  });
});

describe('a body leaving the world', () => {
  it('drops them from the party and reports who is left', () => {
    const state = table('p1', 'p2');
    group(state, 'p1', 'p2');
    expect(invite(state, 'p1', 'p3', NOW).ok).toBe(true);

    expect(forgetActor(state, 'p1')).toEqual(['p2']);
    expect(membersOf(state, 'p2')).toEqual(['p2']);
    expect(isLeader(state, 'p2')).toBe(true);
    // Their outstanding offers go with them: accepting one would join a party
    // whose only member has left the world.
    expect(invitesFor(state, 'p3', NOW)).toHaveLength(0);
  });

  it('is NOT what a disconnect does — a dropped socket keeps its seat', () => {
    // The rule lives in turn-engine's `leave`, which the gateway calls only when
    // the ten-minute grace expires; `setConnected(false)` never touches this
    // table. Removing somebody because their wifi blinked is the same mistake as
    // removing their body from the level, and it is the reported bug.
    const world = createWorld('party-disconnect');
    const parties = createPartyState();
    const a = world.addPlayer('p1', 'A');
    const b = world.addPlayer('p2', 'B');
    const engine = createTurnEngine({ world, parties, now: () => NOW });
    group(parties, a.id, b.id);

    engine.setConnected(b.id, false);

    expect(membersOf(parties, a.id)).toEqual([a.id, b.id]);
    expect(engine.partySnapshot?.(a.id)?.members).toEqual([a.id, b.id]);
  });
});

// ---------------------------------------------------------------------------
// THE BARRIER. The reason any of the above exists.
// ---------------------------------------------------------------------------

describe('the barrier is scoped to a party, not to the level', () => {
  const LEVEL = { engagement: 3, bossFloor: false } as const;

  it('counts only the asking player`s party into the quorum', () => {
    const state = table('p1', 'p2', 'p3');
    group(state, 'p1', 'p2');

    const seats = [seat('p1'), seat('p2'), seat('p3')];
    for (const actor of seats) actor.energy = ENERGY_TO_ACT;

    const level = surveyQuorum(seats, LEVEL);
    expect(level.total).toBe(3);
    expect(level.blocking).toEqual(['p1', 'p2', 'p3']);

    const mine = surveyQuorum(seats, LEVEL, {
      id: partyIdOf(state, 'p1'),
      members: membersOf(state, 'p1'),
    });
    expect(mine.total).toBe(2);
    expect(mine.blocking).toEqual(['p1', 'p2']);

    const solo = surveyQuorum(seats, LEVEL, {
      id: partyIdOf(state, 'p3'),
      members: membersOf(state, 'p3'),
    });
    // THE WHOLE FEATURE, IN ONE ASSERTION. The stranger's quorum is one, and
    // the two people fighting next door are not in it.
    expect(solo.total).toBe(1);
    expect(solo.blocking).toEqual(['p3']);
  });

  it('gives each party its own countdown, from its own start', () => {
    const state = table('p1', 'p2', 'p3');
    group(state, 'p1', 'p2');
    const mine = { id: partyIdOf(state, 'p1'), members: membersOf(state, 'p1') };
    const theirs = { id: partyIdOf(state, 'p3'), members: membersOf(state, 'p3') };

    const seats = [seat('p1'), seat('p2'), seat('p3')];
    for (const actor of seats) actor.energy = ENERGY_TO_ACT;
    const barrier = createBarrier();

    // p2 commits, so p1 is the last straggler and their party's Bell arms.
    seats[1]!.pendingIntent = { kind: 'hold' };
    const armed = barrier.bell(seats, LEVEL, NOW, mine);
    expect(armed.running).toBe(true);

    // The solo player's Bell arms fifteen seconds later, and it is ITS OWN
    // clock: inheriting the other party's start would hand a straggler a
    // countdown that was already half spent before they were asked anything.
    const theirBell = barrier.bell(seats, LEVEL, NOW + 15_000, theirs);
    expect(theirBell.running).toBe(true);
    expect(theirBell.quorum).toBe(1);
    expect(theirBell.remainingMs).toBe(theirBell.durationMs);

    // ...and arming theirs did not move ours.
    expect(barrier.bell(seats, LEVEL, NOW + 15_000, mine).deadlineMs).toBe(armed.deadlineMs);
  });

  it('is unchanged when no party scope is supplied', () => {
    // A build with no party table is the pre-party game, byte for byte. Every
    // test written against the level-wide barrier still describes the truth.
    const seats = [seat('p1'), seat('p2')];
    for (const actor of seats) actor.energy = ENERGY_TO_ACT;
    expect(surveyQuorum(seats, LEVEL).blocking).toEqual(['p1', 'p2']);
  });
});

// ---------------------------------------------------------------------------
// End to end, through the pump
// ---------------------------------------------------------------------------

/** Two players standing on a level with engagement already armed. */
function twoPlayers(seed: string): { world: World; a: Actor; b: Actor } {
  const world = createWorld(seed);
  const a = world.addPlayer('p_a', 'A');
  const b = world.addPlayer('p_b', 'B');
  world.turn.engagement = 3;
  a.energy = ENERGY_TO_ACT;
  b.energy = ENERGY_TO_ACT;
  return { world, a, b };
}

describe('the reported bug: a solo player waiting on a stranger', () => {
  it('does not park a solo player on somebody outside their party', () => {
    const { world, a, b } = twoPlayers('party-solo');
    const parties = createPartyState();
    // Two people who never agreed to play together. B has walked away — no
    // intent, no commit — which under the level-wide barrier froze A completely.
    partyOf(parties, a.id);
    partyOf(parties, b.id);

    const barrier = createBarrier();
    const result = pump(world, { nowMs: NOW, barrier, parties });

    // Both still owe THEIR OWN party a decision, which is right: engagement is
    // level-wide and a fight is happening. What changed is who waits for whom.
    expect(result.parked).toContain(a.id);

    // A's Bell is a SOLO bell — two minutes, never twenty seconds — because
    // A's quorum is one. Under the level-wide barrier it was the 20-second
    // Normal bell measured against a straggler A could not influence.
    const mine = barrier.bell(world.allActors(), world.turn, NOW, {
      id: partyIdOf(parties, a.id),
      members: membersOf(parties, a.id),
    });
    expect(mine.quorum).toBe(1);
    expect(mine.stragglers).toEqual([a.id]);
    expect(mine.durationMs).toBe(120_000);
  });

  it('still holds a party-mate`s turn — the essay in barrier.ts survives', () => {
    const { world, a, b } = twoPlayers('party-together');
    const parties = createPartyState();
    group(parties, a.id, b.id);

    const barrier = createBarrier();
    pump(world, { nowMs: NOW, barrier, parties });

    const scope = { id: partyIdOf(parties, a.id), members: membersOf(parties, a.id) };
    const bell = barrier.bell(world.allActors(), world.turn, NOW, scope);
    // Two in the quorum, both blocking, so no Bell yet: it only ever rings for
    // the LAST straggler. Somebody thirty tiles away still blocks their own
    // party, which is the half of the old rule that had to survive.
    expect(bell.quorum).toBe(2);
    expect(bell.stragglers).toEqual([a.id, b.id]);
    expect(bell.running).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// THE REPORT, STATED AS A PROPERTY: NOTHING A STRANGER DOES REACHES YOU
// ---------------------------------------------------------------------------

/**
 * One thing a player who is not in your party might be doing.
 *
 * A table rather than four copy-pasted tests, because the point is that the
 * barrier NEVER ASKS what state a stranger is in — so the list has to be walked
 * exhaustively, and adding the next state somebody finds (a standing order, a
 * body mid-recall) should be one line here rather than a new test to write.
 */
type StrangerState = {
  readonly name: string;
  readonly apply: (stranger: Actor, ctx: { barrier: Barrier; downed: DownedState }) => void;
};

describe('a solo player is a party of one, and nothing a stranger does reaches them', () => {
  /** The four states from the report: *"him being AFK, not in game, etc"*. */
  const STRANGER_STATES: readonly StrangerState[] = [
    {
      name: 'connected, standing there and deciding nothing',
      // The plain case, and the one that actually stranded somebody: a stranger
      // who is present, owes a decision, and simply has not made it.
      apply: () => undefined,
    },
    {
      name: 'AFK — Standing By after two auto-passes',
      apply: (stranger) => {
        stranger.standingBy = true;
      },
    },
    {
      name: 'gone — the activity closed and the socket dropped',
      // The body STAYS IN THE WORLD for the ten-minute grace (M2), which is the
      // whole reason "his character is still showing" was reported at all.
      apply: (stranger, ctx) => {
        ctx.barrier.disconnect(stranger, NOW);
      },
    },
    {
      name: 'on the floor at 0 hp',
      apply: (stranger, ctx) => {
        stranger.hp = 0;
        stranger.alive = false;
        goDown(ctx.downed, stranger, 0);
      },
    },
  ];

  for (const [index, state] of STRANGER_STATES.entries()) {
    it(`is not touched while the stranger is ${state.name}`, () => {
      const { world, a, b } = twoPlayers(`solo-immunity-${String(index)}`);
      const parties = createPartyState();
      // Two people who never agreed to play together. Both are minted as parties
      // of one, which is what `partyOf` does for anybody it has not seen.
      partyOf(parties, a.id);
      partyOf(parties, b.id);

      const barrier = createBarrier();
      const downed = createDownedState();
      state.apply(b, { barrier, downed });

      const scope = { id: partyIdOf(parties, a.id), members: membersOf(parties, a.id) };
      const quorum = surveyQuorum(world.allActors(), world.turn, scope);

      // ═══ THE WHOLE FEATURE, IN THREE ASSERTIONS ═══
      // A party of one has a quorum of one. The stranger is not in it, and is
      // not even reported as EXCLUDED from it — they are not in this barrier at
      // all, so there is nothing about them for the pane to explain.
      expect(membersOf(parties, a.id)).toEqual([a.id]);
      expect(quorum.total).toBe(1);
      expect(quorum.blocking).toEqual([a.id]);
      expect(quorum.standingBy).toEqual([]);

      // ...and the countdown they are handed is the SOLO one. Two minutes, never
      // the 20-second Normal bell: the Bell exists to stop three people waiting
      // on one, and there is nobody here to wait.
      const bell = barrier.bell(world.allActors(), world.turn, NOW, scope);
      expect(bell.quorum).toBe(1);
      expect(bell.stragglers).toEqual([a.id]);
      expect(bell.durationMs).toBe(BELL_MS.Solo);

      // ...and their turn RESOLVES, with the stranger still owing whatever they
      // owe. This is the sentence the report was written in: a solo player must
      // be able to play while somebody else is AFK, gone, or on the floor.
      const from = { x: a.x, y: a.y };
      expect(submitIntent(world, barrier, a.id, { kind: IntentKind.Move, dir: 's' })).toBe(true);
      pump(world, { nowMs: NOW, barrier, downed, parties });
      expect({ x: a.x, y: a.y }).toEqual({ x: from.x, y: from.y + 1 });
    });
  }
});

describe('inside a party, distance is not a term in the barrier', () => {
  it('a party-mate on the FAR SIDE OF THE MAP still blocks — the essay survives', () => {
    // engine/barrier.ts argues that above `engagement > 0` every player blocks,
    // "including one thirty tiles away... otherwise somebody walks fifty free
    // tiles while a friend tanks". That argument was never about the level; it
    // was about people playing together, and it has to survive being scoped.
    const { world, a, b } = twoPlayers('party-far-apart');
    const parties = createPartyState();
    group(parties, a.id, b.id);

    // As far apart as a 30x29 level allows: opposite corners, no line of sight,
    // nothing either of them can do for the other this turn.
    b.x = 28;
    b.y = 27;
    expect(chebyshev(a, b)).toBeGreaterThanOrEqual(25);

    const barrier = createBarrier();
    const scope = { id: partyIdOf(parties, a.id), members: membersOf(parties, a.id) };
    const quorum = surveyQuorum(world.allActors(), world.turn, scope);
    expect(quorum.total).toBe(2);
    expect(quorum.blocking).toEqual([a.id, b.id]);

    // a commits and the Bell rings for b — a is genuinely waiting on somebody
    // twenty-five tiles away, at the 20-second Normal duration rather than the
    // solo two minutes, because a is not alone.
    expect(submitIntent(world, barrier, a.id, HOLD_INTENT)).toBe(true);
    const bell = barrier.bell(world.allActors(), world.turn, NOW, scope);
    expect(bell.running).toBe(true);
    expect(bell.quorum).toBe(2);
    expect(bell.stragglers).toEqual([b.id]);
    expect(bell.durationMs).toBe(BELL_MS.Normal);
  });

  it('while a stranger on the very next tile does not', () => {
    // The mirror image, and together the two say the whole rule: MEMBERSHIP is
    // the predicate. Proximity is not a term in it either.
    const { world, a, b } = twoPlayers('party-adjacent-stranger');
    const parties = createPartyState();
    partyOf(parties, a.id);
    partyOf(parties, b.id);
    expect(chebyshev(a, b)).toBe(1);

    const barrier = createBarrier();
    const scope = { id: partyIdOf(parties, a.id), members: membersOf(parties, a.id) };
    const quorum = surveyQuorum(world.allActors(), world.turn, scope);
    expect(quorum.total).toBe(1);
    expect(quorum.blocking).toEqual([a.id]);
    expect(barrier.bell(world.allActors(), world.turn, NOW, scope).durationMs).toBe(BELL_MS.Solo);
  });
});

describe('the wipe is per-party', () => {
  it('resets the floor for the party that fell, and only that party', () => {
    const { world, a, b } = twoPlayers('party-wipe');
    const parties = createPartyState();
    partyOf(parties, a.id);
    partyOf(parties, b.id);

    const downed = createDownedState();
    // A is alone in their party and has hit the floor. B is a stranger who is
    // perfectly fine — and under a LEVEL-WIDE wipe check B's health would hold
    // A's floor reset off forever, which is the ghost bug wearing a new hat.
    goDown(downed, a, world.turn.clock.gameTurn);

    const result = pump(world, { nowMs: NOW, barrier: createBarrier(), downed, parties });

    const wipe = result.events.find((event) => event.t === 'party_wipe');
    expect(wipe).toBeDefined();
    expect(wipe?.restored).toEqual([a.id]);
    // Restored at full hp, on their feet.
    expect(a.alive).toBe(true);
    expect(a.hp).toBe(a.maxHp);
    // And B, who was never involved, was not rewritten.
    expect(b.hp).toBe(b.maxHp);
  });

  it('does not reset a party that still has somebody standing', () => {
    const { world, a, b } = twoPlayers('party-no-wipe');
    const parties = createPartyState();
    group(parties, a.id, b.id);

    const downed = createDownedState();
    goDown(downed, a, world.turn.clock.gameTurn);

    const result = pump(world, { nowMs: NOW, barrier: createBarrier(), downed, parties });

    expect(result.events.some((event) => event.t === 'party_wipe')).toBe(false);
    expect(a.alive).toBe(false);
  });

  it('is level-wide again when no party table is wired in', () => {
    const { world, a } = twoPlayers('party-absent');
    const downed = createDownedState();
    goDown(downed, a, world.turn.clock.gameTurn);

    // B is up, so the level-wide survey says the party is not wiped — exactly
    // as it did before parties existed.
    const result = pump(world, { nowMs: NOW, barrier: createBarrier(), downed });
    expect(result.events.some((event) => event.t === 'party_wipe')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The adapter — the one world check, and the refusals in words
// ---------------------------------------------------------------------------

describe('submitParty', () => {
  function server(seed: string) {
    const world = createWorld(seed);
    const parties = createPartyState();
    const a = world.addPlayer('p_a', 'A');
    const b = world.addPlayer('p_b', 'B');
    return { world, parties, a, b, engine: createTurnEngine({ world, parties, now: () => NOW }) };
  }

  it('invites, accepts, and reports both parties as affected', () => {
    const { engine, parties, a, b } = server('submit-invite');

    const sent = engine.submitParty?.(a.id, PartyAction.Invite, b.id);
    expect(sent?.ok).toBe(true);
    expect(sent?.ok === true ? [...sent.affected].sort() : []).toEqual([a.id, b.id]);
    expect(sent?.ok === true ? sent.notice : '').toContain('invites');

    expect(engine.submitParty?.(b.id, PartyAction.Accept)?.ok).toBe(true);
    expect(membersOf(parties, a.id)).toEqual([a.id, b.id]);
  });

  it('refuses a target that is not a living player, in the same words either way', () => {
    const { world, engine, a } = server('submit-target');
    world.addMonster('m1', {
      name: 'Index Husk',
      sprite: 'chr_index_husk_s',
      x: 7,
      y: 2,
      profile: AiProfile.MeleeChaser,
    });

    for (const targetId of ['m1', 'actor_does_not_exist']) {
      const result = engine.submitParty?.(a.id, PartyAction.Invite, targetId);
      expect(result?.ok).toBe(false);
      expect(result?.ok === false ? result.reason : '').toBe('there is nobody by that name here');
    }
  });

  it('turns every typed refusal into a sentence, and none of them moves anybody', () => {
    const { engine, parties, a, b } = server('submit-refusals');

    const solo = engine.submitParty?.(a.id, PartyAction.Leave);
    expect(solo?.ok === false ? solo.reason : '').toBe('you are already on your own');

    const none = engine.submitParty?.(a.id, PartyAction.Accept);
    expect(none?.ok === false ? none.reason : '').toBe('there is no invitation waiting for you');

    group(parties, a.id, b.id);
    const notLeader = engine.submitParty?.(b.id, PartyAction.Kick, a.id);
    expect(notLeader?.ok === false ? notLeader.reason : '').toBe(
      'only the party leader can remove somebody',
    );
    expect(membersOf(parties, a.id)).toEqual([a.id, b.id]);
  });

  it('works while the sender is on the floor — asking for help is not a turn action', () => {
    const { engine, world, parties, a, b } = server('submit-downed');
    const downed = createDownedState();
    goDown(downed, a, world.turn.clock.gameTurn);

    // A is at 0 hp and `alive === false`. `submitMove` refuses that body; this
    // must not, because a player on the floor asking a friend to come and get
    // them is exactly the moment the verb exists for.
    expect(engine.submitMove(a.id, 'n').ok).toBe(false);
    expect(engine.submitParty?.(a.id, PartyAction.Invite, b.id)?.ok).toBe(true);
    expect(invitesFor(parties, b.id, NOW)).toHaveLength(1);
  });

  it('answers honestly on a server with no party system', () => {
    const world = createWorld('submit-no-parties');
    const a = world.addPlayer('p_a', 'A');
    const engine = createTurnEngine({ world });

    const result = engine.submitParty?.(a.id, PartyAction.Leave);
    expect(result?.ok).toBe(false);
    expect(result?.ok === false ? result.reason : '').toBe('this server has no party system');
    // ...and there is no pane to draw either, rather than an invented one.
    expect(engine.partySnapshot?.(a.id)).toBeUndefined();
  });

  it('drops a recalled body out of the party it was in', () => {
    const { engine, parties, a, b } = server('submit-leave-world');
    group(parties, a.id, b.id);

    engine.leave(b.id);

    expect(membersOf(parties, a.id)).toEqual([a.id]);
    expect(engine.partySnapshot?.(a.id)?.members).toEqual([a.id]);
  });

  it('scopes the turn snapshot to the viewer`s party', () => {
    const { engine, world, parties, a, b } = server('submit-turnstate');
    world.turn.engagement = 3;
    for (const actor of world.allActors()) actor.energy = ENERGY_TO_ACT;

    // Strangers: each sees only themselves in their own barrier.
    expect(engine.turnState(a.id).party).toEqual([a.id]);
    expect(engine.turnState(a.id).whoseTurn).toEqual([a.id]);
    // The un-scoped snapshot is the union, which is what the gateway's
    // "has anything changed?" key is built from.
    expect(engine.turnState().whoseTurn).toEqual([a.id, b.id]);
    expect(engine.turnState().party).toBeUndefined();

    group(parties, a.id, b.id);
    expect(engine.turnState(a.id).whoseTurn).toEqual([a.id, b.id]);
  });

  it('hands the pane a snapshot with the clock already applied', () => {
    const { engine, parties, a, b } = server('submit-snapshot');
    expect(invite(parties, b.id, a.id, NOW - 20_000).ok).toBe(true);

    const snapshot = engine.partySnapshot?.(a.id);
    expect(snapshot?.leaderId).toBe(a.id);
    expect(snapshot?.members).toEqual([a.id]);
    // Milliseconds REMAINING, never a deadline: the client's clock is not ours.
    expect(snapshot?.invites).toEqual([
      { fromId: b.id, expiresInMs: INVITE_TTL_MS - 20_000, size: 1 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// The wire
// ---------------------------------------------------------------------------

describe('the `party` frame', () => {
  const frame = (extra: Record<string, unknown>) =>
    parseClientMsg({ v: PROTOCOL_VERSION, t: 'party', ...extra });

  it('accepts the five actions, with and without a target', () => {
    for (const action of Object.values(PartyAction)) {
      expect(frame({ action }).ok).toBe(true);
      expect(frame({ action, targetId: 'actor_u_941c3ee4777234e1' }).ok).toBe(true);
    }
  });

  it('rejects a verb it does not know', () => {
    expect(frame({ action: 'disband' }).ok).toBe(false);
    expect(frame({}).ok).toBe(false);
  });

  it('rejects an identity field, rather than stripping it', () => {
    // `strictObject`, and the missing-field rule at the top of protocol.ts: a
    // client may name the OBJECT of the verb and never its SUBJECT. A frame
    // carrying an actorId is a client asking to act as somebody else.
    expect(frame({ action: PartyAction.Invite, targetId: 'x', actorId: 'y' }).ok).toBe(false);
    expect(frame({ action: PartyAction.Leave, fromId: 'y' }).ok).toBe(false);
  });

  it('bounds the target so no arithmetic is done on an unbounded string', () => {
    expect(frame({ action: PartyAction.Invite, targetId: '' }).ok).toBe(false);
    expect(frame({ action: PartyAction.Invite, targetId: 'x'.repeat(65) }).ok).toBe(false);
    expect(frame({ action: PartyAction.Invite, targetId: 'x'.repeat(64) }).ok).toBe(true);
  });
});
