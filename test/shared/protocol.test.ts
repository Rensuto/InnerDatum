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
  CooldownsMsg,
  LoadoutMsg,
  ResourceMsg,
  ServerMsg,
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
