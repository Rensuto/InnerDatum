/**
 * THE COMMAND LINE: `/party invite Sam`, and everything else is speech.
 *
 * ===========================================================================
 * THIS IS A MUD AND TYPING HAS TO WORK
 * ===========================================================================
 * The right-click menu (ui/contextmenu.ts) is the discoverable path; this is the
 * fast one, and for half the table it will be the only one they ever use. They
 * are the SAME feature — both produce the same `party` frame, and neither knows
 * the other exists.
 *
 * ===========================================================================
 * A NAME BECOMES AN ID HERE, ON THE CLIENT, AND IT NEVER GUESSES
 * ===========================================================================
 * The wire carries an actor id (`ClientParty.targetId`), not a nickname, for the
 * reason protocol.ts gives at length: a name is a Discord nickname, it is
 * hostile input, two people can share one, and a server matching strings would
 * be a server deciding who somebody meant. So the resolution happens against the
 * actors ALREADY ON THIS SCREEN — which is also the only set the player can have
 * meant — and it obeys one rule:
 *
 *   AMBIGUOUS OR UNKNOWN IS ANSWERED, NEVER SENT.
 *
 * "did you mean Sam or Sammy?" is a useful sentence. Picking one of them and
 * inviting the wrong person is not recoverable by the player: they have to
 * notice, and then get the other one to decline. That asymmetry is why this file
 * refuses to be clever — exact match first, then a unique prefix, then a
 * question.
 *
 * ===========================================================================
 * IT PARSES AND RESOLVES. IT DOES NOT SEND, AND IT KNOWS NO RULES
 * ===========================================================================
 * Everything here is pure: text in, a typed outcome out, no socket, no DOM, no
 * clock. main.ts turns an outcome into a frame. That is what makes the whole
 * surface testable without a canvas or a server — and it is why the two local
 * answers this file DOES give ("nobody has invited you", "you are already on
 * your own") are strictly limited to facts that arrived in the last
 * `party_state` frame. Who may kick whom is the server's rule and stays there.
 *
 * A BARE `/accept` SENDS NO TARGET, on purpose. protocol.ts defines an accept
 * with no `targetId` as answering the OLDEST outstanding invite, precisely
 * because that is what a bare `/accept` has to mean; re-implementing "oldest"
 * here from a snapshot that may be a frame behind would be a second copy of the
 * rule that could pick a different offer than the server does.
 */

import { PartyAction } from '../../shared/protocol.ts';

/** One player the command line can name: an actor on screen, or an inviter. */
export type RosterEntry = {
  readonly id: string;
  readonly name: string;
  readonly isSelf: boolean;
};

/** An offer waiting on the viewer, from the last `party_state`. Oldest first. */
export type PendingInvite = {
  readonly fromId: string;
  readonly fromName: string;
};

export type CommandContext = {
  readonly selfId: string | null;
  /**
   * Every PLAYER the viewer can currently see, self included.
   *
   * Built from the actor map rather than from the party frame, on purpose: you
   * invite people who are NOT in your party, so a roster taken from the party
   * would be able to name only the people you can already reach.
   */
  readonly roster: readonly RosterEntry[];
  readonly invites: readonly PendingInvite[];
  /**
   * True when the viewer is grouped with at least one other person.
   *
   * A PARTY OF ONE IS NOT "IN A PARTY" as far as `/leave` is concerned: everyone
   * is always in a party (engine/party.ts), so leaving a party of one is a no-op
   * and the sentence below is better than the round trip that would say so.
   */
  readonly inParty: boolean;
};

/**
 * What the caller should do about a line of typed text.
 *
 * `notice` is the one that matters most: a command that is refused LOCALLY still
 * produces a sentence, because a command line that swallows input is
 * indistinguishable from one that is broken — the same rule main.ts's header
 * states about keys.
 */
export type CommandOutcome =
  | { readonly kind: 'say'; readonly text: string }
  | {
      readonly kind: 'party';
      /**
       * THE WIRE'S OWN VERB. `PartyAction` (protocol.ts) rather than a
       * command-line enum that would have to be mapped onto it: the five strings
       * are the frame's, so main.ts sends `outcome.verb` straight through and
       * there is no table here to fall out of step with either end.
       */
      readonly verb: PartyAction;
      /** Null for `leave`, and for a bare `accept`/`decline`. See the header. */
      readonly targetId: string | null;
      /** For a local sentence only. The id is what goes on the wire. */
      readonly targetName: string | null;
    }
  | { readonly kind: 'notice'; readonly text: string }
  | { readonly kind: 'none' };

/** Printed by `/party` on its own and by anything this file does not recognise. */
export const PARTY_USAGE =
  '/party invite <name> · /accept · /decline · /leave · /kick <name> — or right-click a token';

/** What a name lookup came back with. Three outcomes, and two of them are answers. */
type Resolution =
  | { readonly ok: true; readonly entry: RosterEntry }
  | { readonly ok: false; readonly text: string };

function lower(text: string): string {
  return text.toLocaleLowerCase();
}

/**
 * A typed name -> exactly one player, or a sentence saying why not.
 *
 * EXACT (case-insensitively) BEATS PREFIX, always. Otherwise a party containing
 * both "Sam" and "Sammy" would make the shorter name unusable, which is the
 * common case in a group of friends whose nicknames rhyme on purpose.
 *
 * Exported for the tests: this is the half of the command line that decides
 * whether the wrong person gets invited.
 */
export function resolveName(query: string, roster: readonly RosterEntry[]): Resolution {
  const needle = lower(query);
  if (needle === '') return { ok: false, text: 'name somebody: /party invite <name>' };

  const exact = roster.filter((entry) => lower(entry.name) === needle);
  const pool =
    exact.length > 0 ? exact : roster.filter((entry) => lower(entry.name).startsWith(needle));

  const only = pool[0];
  if (only === undefined) {
    const names = roster.map((entry) => entry.name).join(', ');
    return {
      ok: false,
      text:
        names === '' ? `nobody here is called "${query}"` : `no "${query}" here — try: ${names}`,
    };
  }
  if (pool.length > 1) {
    // NEVER PICK ONE. Two people, one prefix; the player is the only one who
    // knows which they meant, and right-clicking the token is the way to say so.
    return {
      ok: false,
      text: `"${query}" could be ${pool
        .map((entry) => entry.name)
        .join(' or ')} — type more, or right-click them`,
    };
  }
  return { ok: true, entry: only };
}

function party(verb: PartyAction, entry: RosterEntry | null): CommandOutcome {
  return {
    kind: 'party',
    verb,
    targetId: entry?.id ?? null,
    targetName: entry?.name ?? null,
  };
}

function notice(text: string): CommandOutcome {
  return { kind: 'notice', text };
}

/** `invite`/`kick`: resolve against everybody but yourself. */
function targetVerb(action: PartyAction, rest: string, context: CommandContext): CommandOutcome {
  const others = context.roster.filter((entry) => !entry.isSelf && entry.id !== context.selfId);
  if (rest === '') {
    return notice(
      action === PartyAction.Invite ? 'invite who? /party invite <name>' : 'kick who? /kick <name>',
    );
  }
  const found = resolveName(rest, others);
  return found.ok ? party(action, found.entry) : notice(found.text);
}

/**
 * `accept`/`decline`, with or without a name.
 *
 * With no name it sends no target and lets the server answer the oldest — see
 * the header. With a name it resolves against the people who actually asked,
 * which is a much smaller list than the roster and therefore much harder to get
 * wrong.
 */
function answerVerb(action: PartyAction, rest: string, context: CommandContext): CommandOutcome {
  const inviters = context.invites.map((invite) => ({
    id: invite.fromId,
    name: invite.fromName,
    isSelf: false,
  }));
  if (inviters.length === 0) return notice('nobody has invited you');
  if (rest === '') return party(action, null);
  const found = resolveName(rest, inviters);
  return found.ok ? party(action, found.entry) : notice(found.text);
}

/**
 * One line of typed text -> one outcome.
 *
 * ANYTHING NOT STARTING WITH '/' IS SPEECH, which is the important default: this
 * is a chat box first (the whole social half of the MVP lives in the Margin
 * lane) and a command line second. A leading slash is the only thing that
 * changes that, and an unrecognised slash command is answered rather than said
 * out loud — nobody wants "/pary invite sam" broadcast to the room.
 */
export function parseCommand(raw: string, context: CommandContext): CommandOutcome {
  const text = raw.trim();
  if (text === '') return { kind: 'none' };
  if (!text.startsWith('/')) return { kind: 'say', text };

  const [head = '', ...tail] = text.slice(1).split(/\s+/);
  const rest = tail.join(' ').trim();
  const verb = lower(head);

  switch (verb) {
    // An explicit escape hatch, so a line that genuinely starts with a slash can
    // still be said: `/say /shrug`.
    case 'say':
      return rest === '' ? { kind: 'none' } : { kind: 'say', text: rest };

    case 'party': {
      const [sub = '', ...subTail] = rest.split(/\s+/);
      const subRest = subTail.join(' ').trim();
      const known = lower(sub);
      if (known === '') return notice(PARTY_USAGE);
      // `/party invite Sam` and `/invite Sam` are ONE code path, so the two
      // spellings can never drift apart.
      return parseCommand(`/${known} ${subRest}`.trim(), context);
    }

    case 'invite':
      return targetVerb(PartyAction.Invite, rest, context);
    case 'kick':
      return targetVerb(PartyAction.Kick, rest, context);

    case 'accept':
      return answerVerb(PartyAction.Accept, rest, context);
    case 'decline':
      return answerVerb(PartyAction.Decline, rest, context);

    case 'leave':
      // ANSWERED LOCALLY, and only because the answer is in the snapshot this
      // client was just sent. Everybody is always in a party — a solo player is
      // a party of one — so "leave" while alone is a no-op the server would
      // refuse, and this sentence is better than that round trip.
      if (!context.inParty) return notice('you are already on your own — nobody to leave');
      return party(PartyAction.Leave, null);

    case 'help':
    case '?':
      return notice(PARTY_USAGE);

    default:
      return notice(`no command "/${head}" — ${PARTY_USAGE}`);
  }
}
