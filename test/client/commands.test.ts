import { describe, expect, it } from 'vitest';

import { parseCommand, PARTY_USAGE, resolveName } from '../../src/client/input/commands.ts';
import { PartyAction } from '../../src/shared/protocol.ts';
import type { CommandContext, RosterEntry } from '../../src/client/input/commands.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE COMMAND LINE. THE HALF THAT DECIDES WHO GETS INVITED.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `/party invite Sam` becomes a frame carrying an ACTOR ID, and the translation
 * from a typed nickname to that id happens in the browser (protocol.ts explains
 * why the server must not match strings). So the thing under test here is not
 * "can it split a string" — it is the promise the module's header makes:
 *
 *   AMBIGUOUS OR UNKNOWN IS ANSWERED, NEVER SENT.
 *
 * Inviting the wrong person is not something the player can undo: they have to
 * notice, and then ask the other one to decline. Every case below that returns a
 * `notice` instead of a `party` is that promise being kept.
 *
 * No DOM lib reference is needed here, unlike test/client/turncards.test.ts:
 * input/commands.ts is deliberately pure — text in, a typed outcome out, no
 * canvas, no socket and no clock — which is exactly what makes the whole surface
 * testable at all.
 */

const ROSTER: readonly RosterEntry[] = [
  { id: 'actor_me', name: 'Dalt', isSelf: true },
  { id: 'actor_sam', name: 'Sam', isSelf: false },
  { id: 'actor_sammy', name: 'Sammy', isSelf: false },
  { id: 'actor_mo', name: 'Mo', isSelf: false },
];

function context(over: Partial<CommandContext> = {}): CommandContext {
  return {
    selfId: 'actor_me',
    roster: ROSTER,
    invites: [],
    inParty: false,
    ...over,
  };
}

describe('speech is the default and a slash is the only thing that changes it', () => {
  it('says anything that does not start with a slash', () => {
    expect(parseCommand('get to me, I am at the door', context())).toEqual({
      kind: 'say',
      text: 'get to me, I am at the door',
    });
  });

  it('trims, and treats blank as nothing at all rather than as an empty say', () => {
    expect(parseCommand('   ', context())).toEqual({ kind: 'none' });
  });

  it('lets /say send a line that itself begins with a slash', () => {
    expect(parseCommand('/say /shrug', context())).toEqual({ kind: 'say', text: '/shrug' });
  });

  it('answers an unknown command instead of broadcasting the typo', () => {
    const outcome = parseCommand('/pary invite sam', context());
    expect(outcome).toEqual({ kind: 'notice', text: `no command "/pary" — ${PARTY_USAGE}` });
  });
});

describe('a name becomes an id, and it never guesses', () => {
  it('resolves an exact name case-insensitively', () => {
    const outcome = parseCommand('/party invite sam', context());
    expect(outcome).toEqual({
      kind: 'party',
      verb: PartyAction.Invite,
      targetId: 'actor_sam',
      targetName: 'Sam',
    });
  });

  it('prefers an EXACT match over a longer name that merely starts the same', () => {
    // "Sam" and "Sammy" in one party is the common case in a group of friends,
    // and it is the case that would make the shorter name unusable.
    const outcome = parseCommand('/invite Sam', context());
    expect(outcome).toMatchObject({ kind: 'party', targetId: 'actor_sam' });
  });

  it('accepts a unique prefix', () => {
    const outcome = parseCommand('/party invite mo', context());
    expect(outcome).toMatchObject({ kind: 'party', targetId: 'actor_mo' });
  });

  it('REFUSES an ambiguous prefix and names both candidates', () => {
    const outcome = parseCommand('/party invite sammy', context());
    // 'sammy' is exact for one of them, so ambiguity has to be provoked with a
    // prefix neither owns outright.
    expect(outcome).toMatchObject({ kind: 'party', targetId: 'actor_sammy' });

    const ambiguous = parseCommand('/party invite sa', context());
    expect(ambiguous.kind).toBe('notice');
    if (ambiguous.kind !== 'notice') throw new Error('unreachable');
    expect(ambiguous.text).toContain('Sam or Sammy');
  });

  it('refuses a name nobody has, and lists who is actually here', () => {
    const outcome = parseCommand('/party invite ren', context());
    expect(outcome.kind).toBe('notice');
    if (outcome.kind !== 'notice') throw new Error('unreachable');
    expect(outcome.text).toContain('Sam');
    expect(outcome.text).toContain('Mo');
    // ...and not the person typing, who cannot be invited.
    expect(outcome.text).not.toContain('Dalt');
  });

  it('never resolves to YOURSELF, however the name is typed', () => {
    const outcome = parseCommand('/party invite Dalt', context());
    expect(outcome.kind).toBe('notice');
  });

  it('asks who, rather than sending a target-less invite', () => {
    expect(parseCommand('/party invite', context())).toMatchObject({ kind: 'notice' });
    expect(parseCommand('/kick', context())).toMatchObject({ kind: 'notice' });
  });

  it('resolves a kick the same way an invite resolves', () => {
    expect(parseCommand('/kick Mo', context())).toEqual({
      kind: 'party',
      verb: PartyAction.Kick,
      targetId: 'actor_mo',
      targetName: 'Mo',
    });
  });
});

describe('/party and the bare verbs are one code path', () => {
  it('spells the same intent two ways with the same result', () => {
    const long = parseCommand('/party kick Sammy', context());
    const short = parseCommand('/kick Sammy', context());
    expect(long).toEqual(short);
  });

  it('prints the usage for a bare /party', () => {
    expect(parseCommand('/party', context())).toEqual({ kind: 'notice', text: PARTY_USAGE });
  });
});

describe('answering an invite', () => {
  const invited = context({
    invites: [
      { fromId: 'actor_sam', fromName: 'Sam' },
      { fromId: 'actor_mo', fromName: 'Mo' },
    ],
  });

  it('sends NO target for a bare /accept, so the server answers the oldest', () => {
    // Re-implementing "oldest" here would be a second copy of a rule that lives
    // in protocol.ts, and a snapshot one frame behind would pick a different
    // offer than the server does.
    expect(parseCommand('/accept', invited)).toEqual({
      kind: 'party',
      verb: PartyAction.Accept,
      targetId: null,
      targetName: null,
    });
  });

  it('names the offer when the player names the inviter', () => {
    expect(parseCommand('/decline Mo', invited)).toEqual({
      kind: 'party',
      verb: PartyAction.Decline,
      targetId: 'actor_mo',
      targetName: 'Mo',
    });
  });

  it('answers locally when nobody has asked, rather than costing a refusal', () => {
    expect(parseCommand('/accept', context())).toEqual({
      kind: 'notice',
      text: 'nobody has invited you',
    });
  });

  it('will not accept from somebody who did not invite you', () => {
    const outcome = parseCommand('/accept Sammy', invited);
    expect(outcome.kind).toBe('notice');
  });
});

describe('/leave', () => {
  it('is answered locally while you are a party of one', () => {
    const outcome = parseCommand('/leave', context({ inParty: false }));
    expect(outcome).toMatchObject({ kind: 'notice' });
  });

  it('sends with no target once there is somebody to leave', () => {
    expect(parseCommand('/leave', context({ inParty: true }))).toEqual({
      kind: 'party',
      verb: PartyAction.Leave,
      targetId: null,
      targetName: null,
    });
  });
});

describe('resolveName', () => {
  it('answers rather than throwing when the roster is empty', () => {
    const found = resolveName('anyone', []);
    expect(found.ok).toBe(false);
  });

  it('refuses an empty query with an instruction', () => {
    const found = resolveName('', ROSTER);
    expect(found.ok).toBe(false);
    if (found.ok) throw new Error('unreachable');
    expect(found.text).toContain('/party invite');
  });
});
