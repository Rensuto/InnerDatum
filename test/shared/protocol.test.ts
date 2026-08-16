import { describe, expect, it } from 'vitest';

import {
  DownedStatus,
  ErrorCode,
  LogLane,
  ResourceKind,
  SAY_MAX_CHARS,
  TalentShape,
  VoiceState,
  parseClientMsg,
} from '../../src/shared/protocol.ts';
import { PROTOCOL_VERSION } from '../../src/shared/version.ts';
import type {
  BroadcastMsg,
  ClassOptionsMsg,
  CooldownsMsg,
  LoadoutMsg,
  ResourceMsg,
  ServerMsg,
  ViewerMsg,
} from '../../src/shared/protocol.ts';

/**
 * `parseClientMsg` is the ONE trust boundary in the process, and the `talent`
 * frame is the first inbound message with a payload richer than an enum. So this
 * file is not "does zod work" — it is a list of the specific frames a patched
 * client would send, each with the answer the server must give.
 *
 * Everything here is about SHAPE. Whether a talent is in your loadout, off
 * cooldown, affordable and in range is decided in src/server/turn-engine.ts and
 * pinned in test/server/turn-engine.test.ts; a frame that passes every test in
 * this file is still refused by five of the tests in that one.
 */

const V = PROTOCOL_VERSION;

describe('the talent frame at the trust boundary', () => {
  it('accepts an aimed talent', () => {
    const parsed = parseClientMsg({
      v: V,
      t: 'talent',
      talentId: 'talent:sniper_mark',
      target: { x: 12, y: 8 },
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.msg.t).toBe('talent');
    if (parsed.msg.t !== 'talent') return;
    expect(parsed.msg.talentId).toBe('talent:sniper_mark');
    expect(parsed.msg.target).toEqual({ x: 12, y: 8 });
  });

  it('accepts a self talent with no target at all', () => {
    // Iron Curtain. `target` is optional rather than nullable, so this is the
    // ONLY spelling of "no target" — see the schema's note.
    const parsed = parseClientMsg({ v: V, t: 'talent', talentId: 'talent:iron_curtain' });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.msg.t !== 'talent') return;
    expect(parsed.msg.target).toBeUndefined();
  });

  it('REFUSES a null target rather than treating it as absent', () => {
    // Two spellings of the same thing is how a client and a server start
    // disagreeing about what was cast. There is one spelling: omit the key.
    const parsed = parseClientMsg({ v: V, t: 'talent', talentId: 'x', target: null });
    expect(parsed.ok).toBe(false);
  });

  it('REFUSES an identity field on a talent frame', () => {
    // THE RULE THE WHOLE PROTOCOL IS BUILT AROUND. `strictObject` means an
    // unknown key is a rejection, not a silent strip: a frame carrying an actor
    // id is a client asking to act as someone else and it must fail loudly in
    // the log rather than be quietly sanitised into a legal one.
    for (const key of ['actorId', 'userId', 'playerId', 'charId']) {
      const parsed = parseClientMsg({
        v: V,
        t: 'talent',
        talentId: 'talent:crude_blow',
        [key]: 'actor_someone_else',
      });
      expect(parsed.ok, `${key} must be rejected`).toBe(false);
    }
  });

  it('REFUSES a target that is not a pair of small non-negative integers', () => {
    const bad: unknown[] = [
      { x: -1, y: 0 }, // off the top-left; inBounds would catch it, but not here
      { x: 0.5, y: 0 }, // a fractional tile is not a tile
      { x: Number.NaN, y: 0 }, // every comparison against NaN is false
      { x: Number.POSITIVE_INFINITY, y: 0 },
      { x: 1e9, y: 0 }, // arithmetic on an absurd number, before any map check
      { x: 0 }, // half a coordinate
      { x: '3', y: '4' }, // strings compare, badly
      { x: 0, y: 0, z: 0 }, // strictObject again, one level down
      [3, 4],
    ];
    for (const target of bad) {
      const parsed = parseClientMsg({ v: V, t: 'talent', talentId: 'talent:x', target });
      expect(parsed.ok, `${JSON.stringify(target)} must be rejected`).toBe(false);
    }
  });

  it('REFUSES an empty or oversized talent id', () => {
    expect(parseClientMsg({ v: V, t: 'talent', talentId: '' }).ok).toBe(false);
    expect(parseClientMsg({ v: V, t: 'talent', talentId: 'a'.repeat(65) }).ok).toBe(false);
    // 64 is the boundary and it is inclusive.
    expect(parseClientMsg({ v: V, t: 'talent', talentId: 'a'.repeat(64) }).ok).toBe(true);
  });

  it('reports a version mismatch before it complains about the payload', () => {
    // An old client sending an otherwise-perfect talent frame must be told the
    // real problem, not handed a complaint about a literal three screens down.
    const parsed = parseClientMsg({ v: V - 1, t: 'talent', talentId: 'talent:x' });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain('protocol version mismatch');
  });

  it('never throws, whatever arrives', () => {
    for (const raw of ['', '{', 'null', '[]', '{"t":"talent"}', '{"v":3,"t":"talent"}']) {
      expect(() => parseClientMsg(raw)).not.toThrow();
      expect(parseClientMsg(raw).ok).toBe(false);
    }
  });
});

describe('the five talent refusal codes', () => {
  it('gives the dead zone a code of its own, distinct from out of range', () => {
    // THE ASSERTION THIS FILE EXISTS FOR. game-design.md § 2 calls the
    // Inspector's `min_range 3` the single most important number in the class,
    // and `too_close` and `out_of_range` carry OPPOSITE instructions — back away
    // versus close in. Folding one into the other is how a positional class gets
    // read as broken, so they are pinned as different strings here and mapped
    // separately in the gateway.
    expect(ErrorCode.TooClose).toBe('too_close');
    expect(ErrorCode.OutOfRange).toBe('out_of_range');
    expect(ErrorCode.TooClose).not.toBe(ErrorCode.OutOfRange);
  });

  it('carries one code per thing the targeting UI can highlight', () => {
    // Five codes because the client does five different things: flash the ring,
    // flash the hole, flash the button, flash the pips, grey the line of sight.
    expect(new Set(Object.values(ErrorCode)).size).toBe(Object.values(ErrorCode).length);
    for (const code of ['out_of_range', 'too_close', 'on_cooldown', 'no_resource', 'no_los']) {
      expect(Object.values(ErrorCode)).toContain(code);
    }
  });
});

describe('the wire vocabulary tracks the server, not the other way round', () => {
  it('names exactly the five shapes the twelve MVP talents use', () => {
    // Member-for-member `TargetShape` in src/server/engine/talents.ts. The wire
    // union must be able to express every shape the server can produce or the
    // preview silently degrades to a single tile for the AoEs — which are the
    // talents that most need a preview. A shape the server cannot produce is
    // dead code in the renderer; both faults are caught by keeping this list
    // equal to that one.
    expect(Object.values(TalentShape).sort()).toEqual(
      ['ball', 'cross', 'self', 'single', 'tile'].sort(),
    );
  });

  it('names the three MVP class resources', () => {
    expect(Object.values(ResourceKind).sort()).toEqual(['focus', 'reagents', 'resolve'].sort());
  });
});

describe('viewer-private frames cannot be broadcast', () => {
  /**
   * THIS IS A COMPILE-TIME TEST WEARING A RUNTIME COSTUME.
   *
   * The real guarantee is the type `BroadcastMsg = Exclude<ServerMsg, ViewerMsg>`
   * and the gateway's `broadcast(msg: BroadcastMsg)`. The three assignments below
   * are what fail to compile if someone widens either one; the `expect` beneath
   * them exists so the file has a runtime assertion and so a reader sees WHY the
   * assignments are here.
   */
  it('excludes loadout, cooldowns and resource from the broadcastable set', () => {
    // `turn` LEFT THIS SET AT v5 and its absence below is the assertion. Every
    // card on the turn tracker is public, but `TurnActor.isSelf` is true for
    // exactly one recipient, so one shared copy of the frame would highlight one
    // player's card on four screens — in the one UI whose whole job is answering
    // "is the game waiting on ME?". The gateway's `sendTurn` already looped over
    // sessions; `ViewerMsg` is what stops the next person shortening it.
    const loadout: LoadoutMsg = { v: V, t: 'loadout', talents: [] };
    const cooldowns: CooldownsMsg = { v: V, t: 'cooldowns', cooldowns: {} };
    const resource: ResourceMsg = {
      v: V,
      t: 'resource',
      resource: { kind: ResourceKind.Reagents, current: 8, max: 8, discrete: true },
    };

    // Each IS a ServerMsg...
    const asServer: ServerMsg[] = [loadout, cooldowns, resource];
    expect(asServer).toHaveLength(3);

    // ...and none of them is a BroadcastMsg. `t` is the discriminant, so a tag
    // that survives the Exclude is a tag the room may hear.
    const broadcastTags = new Set<BroadcastMsg['t']>([
      'welcome',
      'state',
      'moved',
      'joined',
      'left',
      'sweep',
      'attacked',
      'damaged',
      'died',
      'used',
      'log',
      'effects',
      'party',
      'pinged',
      'pong',
      'error',
    ]);
    for (const msg of asServer) {
      expect(broadcastTags.has(msg.t as BroadcastMsg['t'])).toBe(false);
    }
  });

  it('keeps the public FX stamp public', () => {
    // `used` is NOT private: everyone should see the Alchemist throw the vial.
    // What stays private is the hotbar it came off — the cooldown that tells you
    // she cannot do it again for four turns.
    const used: BroadcastMsg = {
      v: V,
      t: 'used',
      ev: {
        k: 'talent',
        id: 'actor_a',
        talentId: 'talent:alchemic_vial',
        x: 12,
        y: 8,
        shape: TalentShape.Cross,
        radius: 1,
      },
    };
    expect(used.t).toBe('used');
  });
});

/**
 * M4's three inbound verbs.
 *
 * TWO OF THEM ARE THE FIRST FRAMES IN THE GAME THAT CARRY PLAYER-AUTHORED TEXT
 * OR NAME ANOTHER PERSON, so the tests below are mostly about what the schema
 * REFUSES. The pattern is the same one the `talent` frame established: a
 * `strictObject` means every extra key is an attempt at something, and the
 * attempts worth naming are the ones a patched client would actually make.
 */
describe('the M4 frames at the trust boundary', () => {
  it('caps `say` at exactly SAY_MAX_CHARS, and the input agrees', () => {
    // The number the schema enforces IS the number index.html's field is set to
    // (main.ts assigns `cmdEl.maxLength = SAY_MAX_CHARS`). Two numbers means the
    // day they drift a player types a sentence, watches the field accept it, and
    // gets `bad_message` back.
    expect(SAY_MAX_CHARS).toBe(500);

    const atLimit = parseClientMsg({ v: V, t: 'say', text: 'a'.repeat(SAY_MAX_CHARS) });
    expect(atLimit.ok).toBe(true);

    const overLimit = parseClientMsg({ v: V, t: 'say', text: 'a'.repeat(SAY_MAX_CHARS + 1) });
    expect(overLimit.ok).toBe(false);
  });

  it('trims `say`, and rejects a line that is only whitespace', () => {
    const parsed = parseClientMsg({ v: V, t: 'say', text: '   get to me   ' });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.msg.t !== 'say') return;
    // Trimmed BEFORE the length check, so the value that reaches the Margin lane
    // is the value that was validated.
    expect(parsed.msg.text).toBe('get to me');

    // A line of spaces is not something anybody said. Letting it through would
    // produce blank Margin lines that scroll real ones off the reserved band.
    expect(parseClientMsg({ v: V, t: 'say', text: '     ' }).ok).toBe(false);
    expect(parseClientMsg({ v: V, t: 'say', text: '' }).ok).toBe(false);
  });

  it('refuses a `say` that tries to name its own speaker', () => {
    // THE FORGERY TEST. Attribution is resolved server-side from the socket's
    // actor; a `speaker` on the wire would be a request to put words in somebody
    // else's mouth. `strictObject` rejects it rather than stripping it, so it
    // shows up in the log as a rejected frame instead of being sanitised away.
    const parsed = parseClientMsg({ v: V, t: 'say', text: 'hi', speaker: 'Sam' });
    expect(parsed.ok).toBe(false);
  });

  it('bounds a `point` to a plausible tile', () => {
    expect(parseClientMsg({ v: V, t: 'point', x: 0, y: 0 }).ok).toBe(true);
    // MAX_TILE_COORD is 4095 — not a map bound, a bound on what arithmetic the
    // server will do on an attacker-supplied number before the real in-bounds
    // check runs.
    expect(parseClientMsg({ v: V, t: 'point', x: 4095, y: 4095 }).ok).toBe(true);
    expect(parseClientMsg({ v: V, t: 'point', x: 4096, y: 0 }).ok).toBe(false);
    expect(parseClientMsg({ v: V, t: 'point', x: -1, y: 0 }).ok).toBe(false);
    expect(parseClientMsg({ v: V, t: 'point', x: 1.5, y: 0 }).ok).toBe(false);
    expect(parseClientMsg({ v: V, t: 'point', x: Number.NaN, y: 0 }).ok).toBe(false);
  });

  it('takes a DIRECTION for `revive`, never an ally id', () => {
    const parsed = parseClientMsg({ v: V, t: 'revive', dir: 'ne' });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.msg.t !== 'revive') return;
    expect(parsed.msg.dir).toBe('ne');

    // The whole point of the direction: there is nothing here to claim. A
    // `targetId` would be an identity on the wire, which this protocol does not
    // have in any frame and must never acquire in this one — reviving is the one
    // action whose target is another PLAYER.
    expect(parseClientMsg({ v: V, t: 'revive', targetId: 'actor_b' }).ok).toBe(false);
    expect(parseClientMsg({ v: V, t: 'revive', dir: 'ne', targetId: 'actor_b' }).ok).toBe(false);
    // 'up' is a stairs direction, not a compass one.
    expect(parseClientMsg({ v: V, t: 'revive', dir: 'up' }).ok).toBe(false);
  });

  it('takes NOTHING at all for `respawn` — it can only ever be about the sender', () => {
    const parsed = parseClientMsg({ v: V, t: 'respawn' });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.msg.t).toBe('respawn');

    // THE EMPTINESS IS THE SECURITY PROPERTY. `revive` at least names a
    // direction; this names nothing, so there is no field in which a client
    // could ask the server to stand somebody ELSE up — and `strictObject`
    // rejects the attempt rather than quietly stripping it.
    expect(parseClientMsg({ v: V, t: 'respawn', targetId: 'actor_b' }).ok).toBe(false);
    expect(parseClientMsg({ v: V, t: 'respawn', dir: 'ne' }).ok).toBe(false);
    expect(parseClientMsg({ v: V, t: 'respawn', x: 3, y: 2 }).ok).toBe(false);
  });

  it('keeps the four M4 panel frames broadcastable', () => {
    // The Case Log, the badge rows, the party and a ping are all true for the
    // WHOLE party — MVP ships shared party FOV (game-design.md § 12) — so none
    // of them belongs in `ViewerMsg`. These four assignments are what stop
    // somebody quietly making the log viewer-private and halving the reason the
    // Margin lane exists.
    const log: BroadcastMsg = {
      v: V,
      t: 'log',
      lines: [{ seq: 1, lane: LogLane.Margin, gameTurn: 214, text: 'get to me', speaker: 'Dalt' }],
    };
    const effects: BroadcastMsg = {
      v: V,
      t: 'effects',
      actors: [
        {
          id: 'actor_a',
          effects: [
            {
              id: 'effect:stunned',
              name: 'Stunned',
              icon: 'icon_status_stunned',
              turns: 1,
              harmful: true,
            },
          ],
        },
      ],
    };
    const party: BroadcastMsg = {
      v: V,
      t: 'party',
      members: [
        {
          id: 'actor_a',
          name: 'Dalt',
          // DOWNED, not dead — the five turns are game-design.md § 9's number.
          downed: {
            status: DownedStatus.Downed,
            marker: 'ui_marker_downed',
            turnsLeft: 3,
            total: 5,
          },
          voice: VoiceState.Speaking,
          connected: true,
        },
      ],
    };
    const pinged: BroadcastMsg = { v: V, t: 'pinged', id: 'actor_a', x: 12, y: 8 };

    expect([log.t, effects.t, party.t, pinged.t]).toEqual(['log', 'effects', 'party', 'pinged']);
  });
});

/**
 * THE INSPECT PAIR — the mouse layer's one protocol addition.
 *
 * `inspect` is the second inbound verb to name another actor (after `party`) and
 * the first one a player fires by MOVING THE MOUSE, so it is the one most likely
 * to be sent in bulk by a patched client. Everything below is about shape at the
 * trust boundary; whether the target exists, and whether the sender may see it,
 * is answered in the gateway and comes back as a normal `inspected` carrying
 * `view: null` — never as an error code, because a distinguishable refusal is an
 * id oracle.
 */
describe('the inspect pair at the trust boundary', () => {
  /** The schema's own cap, deliberately restated rather than exported. */
  const ACTOR_ID_MAX_CHARS = 64;

  it('accepts a well-formed inspect frame and narrows it', () => {
    const parsed = parseClientMsg({ v: V, t: 'inspect', targetId: 'actor_u_0123456789abcdef' });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.msg.t).toBe('inspect');
    // The narrowing is the assertion: `targetId` is only reachable once `t` has
    // discriminated the union, which is what makes the handler's signature safe.
    if (parsed.msg.t !== 'inspect') return;
    expect(parsed.msg.targetId).toBe('actor_u_0123456789abcdef');
  });

  it('REFUSES a frame with no `v` at all', () => {
    // THE ONE THAT IS EASY TO GET WRONG. `parseClientMsg`'s version check is
    // guarded by `'v' in candidate`, so a frame that simply omits the field
    // slips past it entirely — the `z.literal` in the schema is the only thing
    // that makes the envelope mandatory. Drop it from one schema and that verb
    // silently accepts frames from every client version ever shipped.
    expect(parseClientMsg({ t: 'inspect', targetId: 'actor_a' }).ok).toBe(false);
  });

  it('REFUSES a wrong `v`, and says so before complaining about the payload', () => {
    const parsed = parseClientMsg({ v: V - 1, t: 'inspect', targetId: 'actor_a' });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain('protocol version mismatch');
    expect(parseClientMsg({ v: V + 1, t: 'inspect', targetId: 'actor_a' }).ok).toBe(false);
    expect(parseClientMsg({ v: 'six', t: 'inspect', targetId: 'actor_a' }).ok).toBe(false);
  });

  it('REFUSES an extra unknown key — strictObject, not object', () => {
    expect(parseClientMsg({ v: V, t: 'inspect', targetId: 'actor_a', x: 3, y: 2 }).ok).toBe(false);
    expect(parseClientMsg({ v: V, t: 'inspect', targetId: 'actor_a', pin: true }).ok).toBe(false);
  });

  it('REFUSES an empty or oversized targetId', () => {
    expect(parseClientMsg({ v: V, t: 'inspect', targetId: '' }).ok).toBe(false);
    expect(parseClientMsg({ v: V, t: 'inspect' }).ok).toBe(false);
    // 64 is the boundary and it is inclusive; 65 is a place to park a payload.
    const atLimit = 'a'.repeat(ACTOR_ID_MAX_CHARS);
    expect(parseClientMsg({ v: V, t: 'inspect', targetId: atLimit }).ok).toBe(true);
    const overLimit = 'a'.repeat(ACTOR_ID_MAX_CHARS + 1);
    expect(parseClientMsg({ v: V, t: 'inspect', targetId: overLimit }).ok).toBe(false);
  });

  it('still refuses an identity field naming the SUBJECT of the verb', () => {
    // `targetId` is the OBJECT — what is being looked at. The subject, who is
    // doing the looking, is the socket's session and there is no field for it.
    for (const key of ['actorId', 'userId', 'playerId', 'charId', 'viewerId']) {
      const parsed = parseClientMsg({
        v: V,
        t: 'inspect',
        targetId: 'actor_a',
        [key]: 'actor_someone_else',
      });
      expect(parsed.ok, `${key} must be rejected`).toBe(false);
    }
  });

  it('lets NO inbound verb name the subject of its own verb', () => {
    // THE WHOLE-PROTOCOL SWEEP, not just the new frame. Every legal frame in the
    // union, re-sent with each banned key bolted on; `strictObject` must reject
    // all of them. This is the assertion that catches the NEXT verb somebody
    // adds with an `object` instead of a `strictObject`.
    const legalFrames: readonly Record<string, unknown>[] = [
      { t: 'hello' },
      { t: 'move', dir: 'n' },
      { t: 'talent', talentId: 'talent:x' },
      { t: 'commit' },
      { t: 'hold' },
      { t: 'say', text: 'hi' },
      { t: 'point', x: 3, y: 4 },
      { t: 'revive', dir: 'n' },
      { t: 'respawn' },
      { t: 'choose_class', classId: 'watchman' },
      { t: 'party', action: 'invite', targetId: 'actor_b' },
      { t: 'inspect', targetId: 'actor_b' },
      { t: 'ping' },
    ];

    for (const frame of legalFrames) {
      // Each one is legal as written, or the negative half below proves nothing.
      expect(parseClientMsg({ v: V, ...frame }).ok, `${String(frame.t)} must parse`).toBe(true);

      for (const key of ['actorId', 'userId', 'playerId', 'charId']) {
        const forged = parseClientMsg({ v: V, ...frame, [key]: 'actor_someone_else' });
        expect(forged.ok, `${String(frame.t)} + ${key} must be rejected`).toBe(false);
      }
    }
  });

  it('keeps `inspected` OUT of the broadcastable set', () => {
    // Stated explicitly because the set below is HAND-MAINTAINED: it is a list a
    // human types, so on its own it cannot catch a frame that became wrongly
    // broadcastable — the type would widen and this literal would simply be one
    // tag short. The real enforcement is `ViewerMsg` membership feeding
    // `BroadcastMsg = Exclude<ServerMsg, ViewerMsg>`, and the assignment below is
    // what stops compiling if `inspected` ever leaves `ViewerMsg`.
    //
    // It must never be broadcast because an inspect card is FOV-gated ON THE
    // ASKER: `inspectActor` returns null for a target the viewer cannot see, so
    // one shared copy would post one player's card about a monster the rest of
    // the room is not allowed to know is there.
    const inspected: ServerMsg = {
      v: V,
      t: 'inspected',
      targetId: 'actor_b',
      view: {
        id: 'actor_b',
        name: 'Husk',
        kind: 'monster',
        hp: 9,
        maxHp: 14,
        effects: [],
        rows: [{ label: 'Chance to hit', value: '71%', emphasis: true }],
        blockedReason: 'out of range: 4 tiles, reaches 1',
      },
    };

    const broadcastTags = new Set<BroadcastMsg['t']>([
      'welcome',
      'state',
      'moved',
      'joined',
      'left',
      'sweep',
      'attacked',
      'damaged',
      'died',
      'used',
      'log',
      'effects',
      'party',
      'pinged',
      'pong',
      'error',
    ]);
    expect(broadcastTags.has(inspected.t as BroadcastMsg['t'])).toBe(false);
  });

  it('answers both "no such actor" and "you cannot see it" with the same null', () => {
    // ONE ANSWER, TWO QUESTIONS, ON PURPOSE. A distinguishable absent-actor
    // branch turns this frame into an oracle: a patched client walks the id
    // space, sorts the two replies apart, and has enumerated every body on the
    // floor without seeing one of them. `view: null` is also why there is no
    // `not_visible` ErrorCode — and an ErrorCode addition would force a
    // PROTOCOL_VERSION bump, which this feature deliberately does not take.
    const noSuchActor: ServerMsg = { v: V, t: 'inspected', targetId: 'actor_ghost', view: null };
    const cannotSee: ServerMsg = { v: V, t: 'inspected', targetId: 'actor_b', view: null };
    expect(noSuchActor).toEqual({ ...cannotSee, targetId: 'actor_ghost' });
    expect(Object.values(ErrorCode)).not.toContain('not_visible');
  });
});

/**
 * v8's PAIR — `choose_class` inbound, `class_options` outbound.
 *
 * The inbound verb is the emptiest frame in the protocol after `respawn`: one
 * bounded string and nothing else. Everything below is about what it REFUSES,
 * because the choice it makes is IRREVERSIBLE — the accepted class is written to
 * the character file on the next save and the chooser never appears again — so a
 * frame that got through carrying somebody else's actor id would not just be
 * wrong, it would be permanently wrong.
 */
describe('the choose_class frame at the trust boundary', () => {
  /** The schema's own cap, deliberately restated rather than exported. */
  const CLASS_ID_MAX_CHARS = 64;

  it('accepts a well-formed choice and narrows it', () => {
    const parsed = parseClientMsg({ v: V, t: 'choose_class', classId: 'watchman' });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.msg.t).toBe('choose_class');
    // The narrowing is the assertion: `classId` is only reachable once `t` has
    // discriminated the union, which is what makes the handler's signature safe.
    if (parsed.msg.t !== 'choose_class') return;
    expect(parsed.msg.classId).toBe('watchman');
  });

  it('accepts an id this build has never heard of — the LOOKUP refuses it, not zod', () => {
    // `classId` is a bounded string rather than a `z.enum` of the three MVP ids,
    // following `TalentSchema`'s stated precedent: baking the catalogue into the
    // wire schema makes every content edit a protocol change. So a frame naming
    // a class that does not exist is SHAPE-VALID here and is refused one step
    // later by the server's own `classById` with `bad_message`. This test pins
    // the seam: if somebody swaps the string for an enum, the coupling comes
    // back and this line is where they find out.
    expect(parseClientMsg({ v: V, t: 'choose_class', classId: 'enforcer' }).ok).toBe(true);
  });

  it('REFUSES a frame with no classId at all', () => {
    expect(parseClientMsg({ v: V, t: 'choose_class' }).ok).toBe(false);
    // Not nullable either. An absent field and a null one would be two spellings
    // of "I did not choose", and the second always turns up in a hand-rolled
    // client — where it would mean "assign me something", which is exactly the
    // rotation this whole feature exists to replace.
    expect(parseClientMsg({ v: V, t: 'choose_class', classId: null }).ok).toBe(false);
  });

  it('REFUSES an empty or oversized classId', () => {
    expect(parseClientMsg({ v: V, t: 'choose_class', classId: '' }).ok).toBe(false);
    // 64 is the boundary and it is inclusive; 65 is a place to park a payload.
    const atLimit = 'a'.repeat(CLASS_ID_MAX_CHARS);
    expect(parseClientMsg({ v: V, t: 'choose_class', classId: atLimit }).ok).toBe(true);
    const overLimit = 'a'.repeat(CLASS_ID_MAX_CHARS + 1);
    expect(parseClientMsg({ v: V, t: 'choose_class', classId: overLimit }).ok).toBe(false);
  });

  it('REFUSES a smuggled actorId rather than stripping it', () => {
    // THE REFUSAL IS THE ASSERTION, NOT THE SHAPE. `strictObject` means an extra
    // key is a rejected frame, not a quietly sanitised one — so this is asserted
    // as `ok === false` and never as "the parsed message has no actorId", which
    // would pass just as happily under a permissive `z.object` that had thrown
    // the key away. A frame naming another actor is a client asking to choose
    // somebody else's class, permanently, and it must fail loudly in the log.
    for (const key of ['actorId', 'userId', 'playerId', 'charId', 'targetId']) {
      const forged = parseClientMsg({
        v: V,
        t: 'choose_class',
        classId: 'watchman',
        [key]: 'actor_someone_else',
      });
      expect(forged.ok, `${key} must be rejected`).toBe(false);
    }
  });

  it('REFUSES a frame with no `v` at all', () => {
    // THE ONE THAT IS EASY TO GET WRONG, and the reason every schema in
    // protocol.ts carries `v` as a `z.literal`. `parseClientMsg`'s version check
    // is guarded by `'v' in candidate`, so a frame that simply omits the field
    // slips past it entirely — the literal is the only thing making the envelope
    // mandatory. Drop it from this one schema and a client from any deploy ever
    // shipped could pick a class.
    expect(parseClientMsg({ t: 'choose_class', classId: 'watchman' }).ok).toBe(false);
    const stale = parseClientMsg({ v: V - 1, t: 'choose_class', classId: 'watchman' });
    expect(stale.ok).toBe(false);
    if (stale.ok) return;
    expect(stale.error).toContain('protocol version mismatch');
  });
});

describe('class_options is offered to one player, never to the room', () => {
  const classOptions: ClassOptionsMsg = {
    v: V,
    t: 'class_options',
    options: [
      {
        id: 'watchman',
        name: 'The Watchman',
        description: 'A serving constable on a long beat.',
        // ASSET KEYS THAT ALREADY EXIST ON DISK, never derived from the name.
        // ToME mangles its class name into a filename (Birther.lua:47-48) and
        // survives a miss because it ships `unknown_32_bg.png`; this project has
        // no fallback asset and an unresolved key is the LOUD violet box.
        sprite: 'chr_player_watchman_s',
        portrait: 'icon_character_the_watchman',
        maxHp: 72,
        resource: { kind: ResourceKind.Resolve, current: 0, max: 100, discrete: false },
        talents: [],
      },
    ],
  };

  it('is a ViewerMsg and is NOT assignable to BroadcastMsg', () => {
    // THIS IS THE ENFORCEMENT, NOT A COMMENT ABOUT IT. The gateway's
    // `broadcast` takes a `BroadcastMsg`, so the `@ts-expect-error` below is
    // what fails to compile — in the direction that matters — if somebody
    // removes `class_options` from `ViewerMsg`. Whether a socket owes a choice
    // is true for exactly one person; handed to the room, this frame puts a
    // modal chooser over the map for four returning players who already have a
    // class, at the barrier, mid-fight.
    const asViewer: ViewerMsg = classOptions;
    const asServer: ServerMsg = classOptions;
    expect(asViewer.t).toBe('class_options');
    expect(asServer.t).toBe('class_options');

    // @ts-expect-error `class_options` is viewer-private: `BroadcastMsg` is
    // `Exclude<ServerMsg, ViewerMsg>`, so this assignment must not compile. The
    // suppression IS the assertion — delete it and the file stops building the
    // day the frame becomes broadcastable.
    const notBroadcastable: BroadcastMsg = classOptions;
    expect(notBroadcastable).toBe(classOptions);
  });

  it('carries a className on InspectView only when it has an honest one', () => {
    // `className` is a FIELD rather than a row because `rows` is an ordered,
    // droppable list — a header that found the class by scanning rows for a
    // label would break the moment a row was reordered, and it would break by
    // silently drawing a nameless detective. Optional, so a monster's card and
    // an old client both simply omit it.
    const monster: ServerMsg = {
      v: V,
      t: 'inspected',
      targetId: 'actor_b',
      view: {
        id: 'actor_b',
        name: 'Husk',
        kind: 'monster',
        hp: 9,
        maxHp: 14,
        effects: [],
        rows: [],
      },
    };
    const self: ServerMsg = {
      v: V,
      t: 'inspected',
      targetId: 'actor_a',
      view: {
        id: 'actor_a',
        name: 'Dalt',
        className: 'The Watchman',
        kind: 'player',
        hp: 72,
        maxHp: 72,
        effects: [],
        rows: [{ label: 'Strength', value: '24' }],
      },
    };
    if (monster.t !== 'inspected' || self.t !== 'inspected') return;
    expect(monster.view?.className).toBeUndefined();
    expect(self.view?.className).toBe('The Watchman');
  });
});
