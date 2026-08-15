/**
 * ═══════════════════════════════════════════════════════════════════════════
 *                    EXPLICIT PARTIES — WHO YOU ARE PLAYING WITH
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * THE PROBLEM THIS SOLVES, STATED HONESTLY SO THE SCOPE STAYS HONEST.
 *
 * The Warrant Clock (engine/barrier.ts) is LEVEL-WIDE. Above `engagement > 0`
 * every player on the level blocks every other player on the level, and
 * barrier.ts argues for that at length: *"otherwise somebody walks fifty free
 * tiles while a friend tanks"*. That argument is exactly right for people who
 * are playing TOGETHER and exactly wrong for two groups who are not — and real
 * multiplayer found the wrong half first. A solo player was made to wait on a
 * stranger's turn, and on a stranger who had walked away from the keyboard.
 *
 * A PARTY IS THE SET OF PEOPLE WHO AGREED TO PLAY TOGETHER, and it is the set
 * the barrier scopes to. Nothing else changes: the reason engagement is
 * level-wide survives untouched (a fight IS happening here, and the level is
 * what knows it), and the reason every member of a party blocks every other
 * member survives untouched too — somebody thirty tiles away still blocks their
 * OWN party, because the "get over here" pressure is the whole point of playing
 * together. What is removed is the one thing that was never argued for: a
 * barrier between two people who never agreed to share one.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * EVERY PLAYER IS ALWAYS IN A PARTY. THERE IS NO "NO PARTY" STATE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A solo player is a PARTY OF ONE, minted lazily the first time anything asks.
 * That is the single most load-bearing decision in this file and it is worth
 * being explicit about why, because "null means solo" looks cheaper and is not:
 *
 *   THE BARRIER ASKS "WHO IS IN THIS PLAYER'S PARTY?" IN FIVE PLACES — the
 *   quorum, the commit count, the blocking set, the Bell's countdown key and
 *   the wipe. A nullable answer means five `?? everyoneOnTheLevel` fallbacks,
 *   five chances to write the fallback wrong, and the failure mode of getting
 *   one wrong is that a solo player silently starts waiting on a stranger
 *   again — the exact bug this file exists to fix, reintroduced somewhere
 *   nobody is looking.
 *
 * So `partyOf` NEVER returns undefined for a player id. It mints on demand and
 * is idempotent, which makes it safe to call from a loop over the actor table.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * LEAVING AND BEING KICKED LAND YOU IN A FRESH PARTY OF ONE, NEVER IN LIMBO
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Same argument, one step further along: a player who is momentarily in no
 * party is a player the barrier cannot answer a question about, and the moment
 * that state exists somebody will observe it — a kick lands mid-fight, the pump
 * runs on the next frame, and the quorum is computed for a body with no party.
 * `leave` and `kick` therefore do the removal and the re-minting as ONE
 * synchronous step; there is no window between them.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * NO CLOCK, NO I/O, NO RANDOMNESS — AND YET INVITES EXPIRE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `src/server/engine/**` may not read a wall clock (`Date.now` is an ESLint
 * error here) and may not contain `await`. Invites still have to lapse, so
 * `nowMs` is PASSED IN at every call that cares — the same split
 * engine/barrier.ts makes for the Bell, and for the same reason: the whole of
 * expiry is then exercised by calling one function twice with two numbers
 * instead of by waiting a minute.
 *
 * WALL-CLOCK MILLISECONDS RATHER THAN GAME TURNS, and that is a deliberate
 * departure from engine/downed.ts's five-turn countdown. A downed countdown is
 * a fact about a FIGHT, so turns are the honest unit. An invite is a fact about
 * two PEOPLE, and out of combat the level reaches its idle fixed point and
 * produces no game turns at all (scheduler.ts's `ActResult.Done` note) — an
 * invite denominated in turns would sit on screen forever on a quiet floor,
 * which is precisely when most invites are sent.
 *
 * PARTY IDS ARE MINTED FROM A COUNTER, never from `randomUUID` or a hash: this
 * file has no entropy source and must not grow one. They are process-local
 * bookkeeping and never travel on the wire — `party_state` names MEMBERS, and
 * a party's identity to a player is who is in it.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * IT KNOWS NOTHING ABOUT ACTORS. IDS ONLY.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * There is no `PartyActor` type here and there deliberately is not one. Whether
 * a target id names a living player rather than a husk, a corpse or a string
 * somebody typed into a devtools console is a question about the WORLD, and it
 * is answered once, in `submitParty` in src/server/turn-engine.ts, before any
 * of these functions is called. Duplicating it here would be a second copy of a
 * rule that has to agree with the world's actor table — the same argument
 * downed.ts makes for taking `isPresent` as a predicate rather than importing
 * the barrier.
 */

// ---------------------------------------------------------------------------
// The numbers, and why each one is what it is
// ---------------------------------------------------------------------------

/**
 * How many people may share one barrier.
 *
 * FOUR, from game-design.md § 4's own framing of the failure it is designed
 * around — *"player 1 deliberates 40 s, players 2–4 tab out"* — so four is the
 * size the Bell, the quorum arithmetic and the turn-card strip were all written
 * against. It is a cap on a SHARED CLOCK rather than on a friend group: a fifth
 * person is not refused entry to the game, they are simply in their own party,
 * which after this file is a perfectly good way to play on the same floor.
 */
export const MAX_PARTY_SIZE = 4;

/**
 * How long an unanswered invite stands, in milliseconds.
 *
 * ONE MINUTE. Long enough to notice a prompt, read a name and decide; short
 * enough that an invite nobody answered is gone before it can be accepted by
 * accident twenty minutes later, from a room the inviter has since left. The
 * expiry is checked lazily on every read (see `livingInvites`) rather than
 * swept by a timer, because there is no timer in this directory and a stale row
 * that nobody has looked at has harmed nobody.
 */
export const INVITE_TTL_MS = 60_000;

/**
 * Separates the two halves of an invite's map key.
 *
 * A UNIT SEPARATOR (U+001F) rather than a colon or a dash, because actor ids
 * are attacker-adjacent: `actor_u_<hex>` and `actor_<uuid>` are server-minted,
 * but the anonymous `Player N` path and every test fixture mint their own, and
 * a key built with a character that can appear inside an id lets `a:b` + `c`
 * collide with `a` + `b:c`. Nothing anywhere in this process puts a control
 * character in an id.
 */
const KEY_SEP = '\u001f';

// ---------------------------------------------------------------------------
// The shapes
// ---------------------------------------------------------------------------

/**
 * ONE PARTY. Never empty — an empty party is deleted the instant it empties,
 * because a party with nobody in it is a row that can only ever be a bug.
 */
export type Party = {
  /** Process-local bookkeeping. Never on the wire; see the header. */
  readonly id: string;
  /**
   * ALWAYS A MEMBER. The badge is handed on when the leader leaves or is
   * removed from the world, so "leader" and "member" can never disagree.
   */
  leaderId: string;
  /**
   * JOIN ORDER, and stable — the same property `TurnMsg.actors` insists on and
   * for the same reason: a row that moves under a cursor between two frames is
   * a row somebody misclicks. `members[0]` is the heir, not necessarily the
   * leader.
   */
  readonly members: string[];
};

/** One outstanding offer. Nothing about it is a claim until it is accepted. */
export type PartyInvite = {
  /** Who asked. Resolved server-side from their socket, never from the wire. */
  readonly fromId: string;
  /** Who was asked. */
  readonly toId: string;
  /**
   * The party they were asked INTO, fixed at the moment of asking.
   *
   * Carried rather than re-derived from `fromId` at accept time, because
   * between the two the inviter may have left and landed in a fresh party of
   * one — and an invite that silently retargets is an invite that puts somebody
   * somewhere they did not agree to go. If the named party no longer exists,
   * the invite is simply dead (`PartyRefusal.NoInvite`).
   */
  readonly partyId: string;
  /** Wall clock, PASSED IN. Nothing here reads one. */
  readonly expiresAtMs: number;
};

/**
 * The table. One per world, owned by the caller (src/server/main.ts) exactly as
 * the barrier and the survival table are, because party membership outlives
 * every pump.
 *
 * THREE MAPS AND A COUNTER, and `partyOf` is the only one that could ever drift
 * out of step with `byId`. It is written in exactly two private helpers
 * (`mintParty` and `detach`); nothing else in this file touches it.
 */
export type PartyState = {
  readonly byId: Map<string, Party>;
  /** Actor id -> party id. The reverse index; see the note above. */
  readonly partyOf: Map<string, string>;
  /** `fromId` + `KEY_SEP` + `toId` -> the offer. Insertion order is offer order. */
  readonly invites: Map<string, PartyInvite>;
  /** The id counter. See the header: no entropy source in this directory. */
  minted: number;
};

export function createPartyState(): PartyState {
  return {
    byId: new Map<string, Party>(),
    partyOf: new Map<string, string>(),
    invites: new Map<string, PartyInvite>(),
    minted: 0,
  };
}

// ---------------------------------------------------------------------------
// Refusals — typed, so the prose lives in the adapter and the rule lives here
// ---------------------------------------------------------------------------

/**
 * Why a party command did not happen. EVERY REFUSAL COSTS ZERO — no partial
 * membership, no half-sent invite, no leader badge left on somebody who was not
 * removed. The same atomicity rule `revive` keeps in engine/downed.ts.
 */
export const PartyRefusal = {
  /** You named yourself. Inviting or kicking yourself is not a thing. */
  Self: 'self',
  /** You are already in the same party. The commonest refusal, and it is free. */
  AlreadyTogether: 'already_together',
  /** That offer is already outstanding. Re-sending does not refresh the clock. */
  AlreadyInvited: 'already_invited',
  /** `MAX_PARTY_SIZE`. Checked at BOTH ends — see `invite` and `accept`. */
  PartyFull: 'party_full',
  /** Nothing to accept or decline: never sent, already answered, or lapsed. */
  NoInvite: 'no_invite',
  /** Only the leader may remove somebody else. */
  NotLeader: 'not_leader',
  /** You tried to kick somebody who is not in your party. */
  NotAMember: 'not_a_member',
  /**
   * YOU ARE ALREADY A PARTY OF ONE, so there is nothing to leave.
   *
   * A refusal rather than a silent success, because the two are visibly
   * different to the player: a silent success would mint a fresh party id, the
   * `party_state` frame would change for no reason a human can see, and the one
   * thing the command was supposed to tell them — *you are on your own now* —
   * would be indistinguishable from *you already were*.
   */
  Solo: 'solo',
} as const;
export type PartyRefusal = (typeof PartyRefusal)[keyof typeof PartyRefusal];

export type PartyResult =
  | {
      readonly ok: true;
      /** The party the ASKING player is in once the command has been applied. */
      readonly party: Party;
      /**
       * EVERY ACTOR WHOSE `party_state` FRAME IS NOW DIFFERENT, deduplicated
       * and in a deterministic order.
       *
       * It is returned rather than left for the caller to work out because the
       * caller cannot: an accept changes the frame for two whole parties, one
       * of which no longer exists by the time it could be asked about. The
       * gateway broadcasts to exactly this list, which is what makes
       * "party_state goes to the affected members only" a fact rather than a
       * rule someone has to remember.
       */
      readonly affected: readonly string[];
    }
  | { readonly ok: false; readonly reason: PartyRefusal };

// ---------------------------------------------------------------------------
// Reading the table
// ---------------------------------------------------------------------------

function mintParty(state: PartyState, leaderId: string): Party {
  state.minted += 1;
  const party: Party = { id: `party_${state.minted}`, leaderId, members: [leaderId] };
  state.byId.set(party.id, party);
  state.partyOf.set(leaderId, party.id);
  return party;
}

/**
 * THIS PLAYER'S PARTY, MINTED IF THEY DID NOT HAVE ONE. Never undefined.
 *
 * IT MUTATES, AND THAT IS THE CONTRACT rather than an accident to be tidied
 * away later. See the header: "every player is always in a party" is only true
 * if somebody makes it true, and doing it lazily here means no join path, no
 * save-load path and no test fixture can forget to. It is idempotent, so
 * calling it in a loop over the whole actor table costs one Map lookup each
 * after the first.
 */
export function partyOf(state: PartyState, actorId: string): Party {
  const partyId = state.partyOf.get(actorId);
  const existing = partyId === undefined ? undefined : state.byId.get(partyId);
  if (existing !== undefined) return existing;
  return mintParty(state, actorId);
}

/** This player's party id. The Bell keys its countdown on it. */
export function partyIdOf(state: PartyState, actorId: string): string {
  return partyOf(state, actorId).id;
}

/** Everyone who shares a barrier with this player, INCLUDING them. */
export function membersOf(state: PartyState, actorId: string): readonly string[] {
  return partyOf(state, actorId).members;
}

/**
 * DO THESE TWO BLOCK EACH OTHER? The one question the barrier actually asks.
 *
 * True for `a === b`, which is not a special case: you are in your own party,
 * and a player always owes their own party a decision.
 */
export function sameParty(state: PartyState, a: string, b: string): boolean {
  return partyIdOf(state, a) === partyIdOf(state, b);
}

export function isLeader(state: PartyState, actorId: string): boolean {
  return partyOf(state, actorId).leaderId === actorId;
}

// ---------------------------------------------------------------------------
// Invites
// ---------------------------------------------------------------------------

function inviteKey(fromId: string, toId: string): string {
  return `${fromId}${KEY_SEP}${toId}`;
}

/**
 * EVERY OFFER STILL STANDING ON THIS FLOOR, oldest first. Lapsed ones are
 * dropped on the way past.
 *
 * PRUNING ON READ rather than on a timer, because there is no timer in this
 * directory and there must not be one. Every entry point that can observe an
 * invite calls this first, so a lapsed invite is never visible to anything —
 * the table is allowed to hold a dead row, but nothing is allowed to see one.
 *
 * Exported because the projection of the FLOOR needs all of them at once (see
 * `projectParty`), while every command path wants only the ones addressed to
 * one player — which is `invitesFor` below, built on this so that the two can
 * never disagree about what "still standing" means.
 */
export function liveInvites(state: PartyState, nowMs: number): readonly PartyInvite[] {
  const living: PartyInvite[] = [];
  for (const [key, invite] of state.invites) {
    if (invite.expiresAtMs <= nowMs) {
      state.invites.delete(key);
      continue;
    }
    living.push(invite);
  }
  return living;
}

/**
 * Outstanding offers TO one player, oldest first.
 *
 * "To one player" and never "from" — `party_state` carries the invites somebody
 * has to answer, and an outgoing-invite list would be a list of other people's
 * pending decisions, which is theirs to make and nobody else's to watch.
 */
export function invitesFor(state: PartyState, toId: string, nowMs: number): readonly PartyInvite[] {
  return liveInvites(state, nowMs).filter((invite) => invite.toId === toId);
}

/**
 * ASK SOMEBODY TO JOIN YOUR PARTY.
 *
 * IT CHANGES NOTHING ABOUT EITHER PARTY. An invite is an offer, and the whole
 * of its effect is a row in a table plus a prompt on one person's screen —
 * which is why it is safe for the inviter's own client to fire it off a
 * right-click without a confirmation step, and why re-sending one is refused
 * (`AlreadyInvited`) rather than silently refreshing the clock. A refresh on
 * re-send would let somebody keep a prompt on a stranger's screen forever.
 *
 * THE FULL CHECK HAPPENS AGAIN AT ACCEPT. Party size is checked here so that
 * the inviter is told immediately, and re-checked in `accept` because between
 * the two somebody else may have accepted first. The second check is the real
 * one; this one is a courtesy.
 */
export function invite(
  state: PartyState,
  fromId: string,
  toId: string,
  nowMs: number,
): PartyResult {
  if (fromId === toId) return { ok: false, reason: PartyRefusal.Self };

  const party = partyOf(state, fromId);
  if (partyIdOf(state, toId) === party.id) {
    return { ok: false, reason: PartyRefusal.AlreadyTogether };
  }
  if (party.members.length >= MAX_PARTY_SIZE) {
    return { ok: false, reason: PartyRefusal.PartyFull };
  }

  const key = inviteKey(fromId, toId);
  const outstanding = liveInvites(state, nowMs).some(
    (live) => live.fromId === fromId && live.toId === toId,
  );
  if (outstanding) return { ok: false, reason: PartyRefusal.AlreadyInvited };

  state.invites.set(key, {
    fromId,
    toId,
    partyId: party.id,
    expiresAtMs: nowMs + INVITE_TTL_MS,
  });

  // The invitee's pending list changed; the inviter's did not, and is included
  // so their own client can reflect that the offer went out. A recipient whose
  // frame is unchanged is suppressed by the gateway's per-socket memo, so the
  // generous list costs nothing.
  return { ok: true, party, affected: dedupe([fromId, toId]) };
}

/**
 * Find the one invite a command is about.
 *
 * `fromId` is OPTIONAL and absent means "the oldest one outstanding", which is
 * what a bare `/accept` typed into the command line has to mean. Map iteration
 * is insertion order, so "oldest" is deterministic and does not depend on a
 * clock comparison between two invites that arrived in the same millisecond.
 */
function findInvite(
  state: PartyState,
  toId: string,
  fromId: string | undefined,
  nowMs: number,
): PartyInvite | undefined {
  const pending = invitesFor(state, toId, nowMs);
  if (fromId === undefined) return pending[0];
  return pending.find((live) => live.fromId === fromId);
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * JOIN THEM. The one command in this file that changes two parties at once.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The accepter leaves whatever party they were in — which for the overwhelmingly
 * common case is their own party of one, and it is DELETED rather than left
 * empty — and lands at the end of the target's member list, in join order.
 *
 * EVERY OTHER OFFER TO THEM IS DROPPED. Somebody who has just joined a party is
 * not still deciding about three others, and leaving those rows live would put
 * stale prompts on their screen that now say "leave your friends and join me"
 * without saying so.
 *
 * THE SIZE CHECK HERE IS THE REAL ONE. Two people can hold invites to the same
 * three-person party and both accept; the second is refused with `PartyFull`,
 * having changed nothing, and their own party of one is untouched.
 */
export function accept(
  state: PartyState,
  toId: string,
  fromId: string | undefined,
  nowMs: number,
): PartyResult {
  const offer = findInvite(state, toId, fromId, nowMs);
  if (offer === undefined) return { ok: false, reason: PartyRefusal.NoInvite };

  const target = state.byId.get(offer.partyId);
  // The party dissolved while the offer stood — the inviter left, or their body
  // was recalled. A dead offer is indistinguishable from no offer at all, which
  // is the honest answer: there is nothing there to join.
  if (target === undefined) {
    state.invites.delete(inviteKey(offer.fromId, offer.toId));
    return { ok: false, reason: PartyRefusal.NoInvite };
  }

  const current = partyOf(state, toId);
  if (current.id === target.id) {
    state.invites.delete(inviteKey(offer.fromId, offer.toId));
    return { ok: false, reason: PartyRefusal.AlreadyTogether };
  }
  if (target.members.length >= MAX_PARTY_SIZE) {
    return { ok: false, reason: PartyRefusal.PartyFull };
  }

  // Everyone who was standing beside them a moment ago still needs a frame,
  // captured BEFORE the detach because the old party may not survive it.
  const leftBehind = [...current.members];

  detach(state, toId);
  target.members.push(toId);
  state.partyOf.set(toId, target.id);
  dropInvitesTo(state, toId);

  return { ok: true, party: target, affected: dedupe([...leftBehind, ...target.members]) };
}

/** Turn one offer down. It changes nothing except that the prompt goes away. */
export function decline(
  state: PartyState,
  toId: string,
  fromId: string | undefined,
  nowMs: number,
): PartyResult {
  const offer = findInvite(state, toId, fromId, nowMs);
  if (offer === undefined) return { ok: false, reason: PartyRefusal.NoInvite };
  state.invites.delete(inviteKey(offer.fromId, offer.toId));
  return {
    ok: true,
    party: partyOf(state, toId),
    affected: dedupe([toId, offer.fromId]),
  };
}

function dropInvitesTo(state: PartyState, toId: string): void {
  for (const [key, invite] of state.invites) {
    if (invite.toId === toId) state.invites.delete(key);
  }
}

// ---------------------------------------------------------------------------
// Leaving, and being removed
// ---------------------------------------------------------------------------

/**
 * Take one player out of whatever party they are in. NOT a public command.
 *
 * It leaves them with NO party on purpose, because every caller re-mints one in
 * the same synchronous step (see the header: there is no window in which a
 * player is partyless). It is private for exactly that reason — a public
 * `detach` would be the one way to create the state this file says cannot
 * exist.
 *
 * THE LEADER BADGE IS HANDED ON, never dropped: `members[0]` is the longest-
 * standing remaining member, so leadership passes the way it would at a table.
 */
function detach(state: PartyState, actorId: string): void {
  const partyId = state.partyOf.get(actorId);
  state.partyOf.delete(actorId);
  if (partyId === undefined) return;

  const party = state.byId.get(partyId);
  if (party === undefined) return;

  const at = party.members.indexOf(actorId);
  if (at >= 0) party.members.splice(at, 1);

  if (party.members.length === 0) {
    // An empty party is deleted rather than kept for reuse. Keeping it would
    // leave a row that a still-standing invite could resolve to, and somebody
    // would accept their way into a party with nobody in it.
    state.byId.delete(party.id);
    return;
  }

  if (party.leaderId === actorId) {
    const heir = party.members[0];
    if (heir !== undefined) party.leaderId = heir;
  }
}

/**
 * WALK OUT. You land in a fresh party of one, immediately.
 *
 * Refused for somebody who is already alone (`PartyRefusal.Solo`) — see the
 * refusal's own note. A leader walking out hands the badge on rather than
 * dissolving the party: the people still standing together did not ask to be
 * scattered because one person left.
 */
export function leave(state: PartyState, actorId: string): PartyResult {
  const current = partyOf(state, actorId);
  if (current.members.length <= 1) return { ok: false, reason: PartyRefusal.Solo };

  const leftBehind = [...current.members];
  detach(state, actorId);
  // Offers made in the old party's name are still valid — the party still
  // exists and still has room. Offers made TO this player are not dropped
  // either: they are decisions this player has not made yet and walking out of
  // one party is not an answer to them.
  const fresh = mintParty(state, actorId);

  return { ok: true, party: fresh, affected: dedupe(leftBehind) };
}

/**
 * REMOVE SOMEBODY ELSE. Leader only, and never yourself.
 *
 * Kicking yourself is `PartyRefusal.Self` rather than a synonym for `leave`,
 * because the two commands mean different things to the four other people
 * looking at the panel — one is *I am going*, the other is *you are going* —
 * and a leader who typed the wrong one should be told, not quietly obeyed.
 *
 * The removed player lands in their own party of one and keeps playing on the
 * same floor. There is no ejection from the game here and there must not be:
 * this is a barrier boundary, not a ban.
 */
export function kick(state: PartyState, leaderId: string, targetId: string): PartyResult {
  if (leaderId === targetId) return { ok: false, reason: PartyRefusal.Self };

  const party = partyOf(state, leaderId);
  if (party.leaderId !== leaderId) return { ok: false, reason: PartyRefusal.NotLeader };
  if (!party.members.includes(targetId)) return { ok: false, reason: PartyRefusal.NotAMember };

  const before = [...party.members];
  detach(state, targetId);
  mintParty(state, targetId);
  dropInvitesTo(state, targetId);

  return { ok: true, party, affected: dedupe(before) };
}

/**
 * THE BODY HAS LEFT THE WORLD FOR GOOD — the reconnect grace expired, or the
 * player genuinely quit.
 *
 * NOT THE DISCONNECT PATH. A dropped socket leaves the body standing in the
 * world for ten minutes (game-design.md § 4) and it stays in its party for all
 * of them: the party panel shows them greyed out with `online: false`, and they
 * find their friends still there when they come back. Removing somebody from a
 * party because their wifi blinked is the same class of mistake as removing
 * their body from the level.
 *
 * @returns the members who are still standing and therefore need a fresh frame.
 */
export function forgetActor(state: PartyState, actorId: string): readonly string[] {
  const party = state.byId.get(state.partyOf.get(actorId) ?? '');
  const survivors = party === undefined ? [] : party.members.filter((id) => id !== actorId);

  detach(state, actorId);
  dropInvitesTo(state, actorId);
  for (const [key, invite] of state.invites) {
    if (invite.fromId === actorId) state.invites.delete(key);
  }

  return survivors;
}

/**
 * Stable, order-preserving de-duplication.
 *
 * `affected` lists are built by concatenating two member arrays that routinely
 * overlap, and the order has to be reproducible: the gateway sends one frame
 * per id, and two servers replaying the same session must produce the same
 * frame order or a recorded transcript stops comparing equal.
 */
function dedupe(ids: readonly string[]): readonly string[] {
  return [...new Set(ids)];
}
