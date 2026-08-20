import { describe, expect, it } from 'vitest';

import {
  DownedStatus,
  ErrorCode,
  ItemTier,
  LogLane,
  ResourceKind,
  SAY_MAX_CHARS,
  SLOT_ORDER,
  Slot,
  TalentShape,
  VoiceState,
  parseClientMsg,
} from '../../src/shared/protocol.ts';
import { TALENT_MAX_LEVEL } from '../../src/shared/progression.ts';
import { PROTOCOL_VERSION } from '../../src/shared/version.ts';
import type {
  BroadcastMsg,
  CarriedItemView,
  ClassOptionsMsg,
  CooldownsMsg,
  GroundMsg,
  InventoryMsg,
  LoadoutMsg,
  LoadoutTalent,
  ProgressMsg,
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
      'projectiles',
      'party',
      'pinged',
      // `ground` JOINED THE BROADCASTABLE SET AT v10 and `inventory` did not.
      // A floor item is a POSITION, which is world state and identical for
      // everybody under shared party FOV; an inventory is a holding, and
      // `CarriedItemView.compare` is a delta against the RECIPIENT'S OWN doll,
      // so one shared copy would be arithmetically wrong for everybody but its
      // author. See the v10 suites at the bottom of this file.
      'ground',
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
      { t: 'spend_point', talentId: 'talent:fog_step' },
      // v10's four. `pickup` is the emptiest frame in the protocol; the other
      // three name an OBJECT (an item, a slot) and never a subject.
      { t: 'pickup' },
      { t: 'equip', itemId: 'item_watchmans_coat' },
      { t: 'unequip', slot: 'body' },
      { t: 'drop', itemId: 'item_watchmans_coat' },
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
      'projectiles',
      'party',
      'pinged',
      // `ground` JOINED THE BROADCASTABLE SET AT v10 and `inventory` did not.
      // A floor item is a POSITION, which is world state and identical for
      // everybody under shared party FOV; an inventory is a holding, and
      // `CarriedItemView.compare` is a delta against the RECIPIENT'S OWN doll,
      // so one shared copy would be arithmetically wrong for everybody but its
      // author. See the v10 suites at the bottom of this file.
      'ground',
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

/**
 * v9's PAIR — `spend_point` inbound, `progress` outbound.
 *
 * The inbound verb is one bounded string, like `choose_class` before it, and it
 * is tested the same way: almost entirely by what it REFUSES. The reason to be
 * strict here is that a SPEND IS IRREVERSIBLE — there is no refund verb and no
 * unlearn — so a frame that got through carrying somebody else's actor id would
 * permanently spend a stranger's scarce point on a talent they did not pick.
 */
describe('the spend_point frame at the trust boundary', () => {
  /** The schema's own cap, deliberately restated rather than exported. */
  const TALENT_ID_MAX_CHARS = 64;

  it('accepts a well-formed spend and narrows it', () => {
    const parsed = parseClientMsg({ v: V, t: 'spend_point', talentId: 'talent:fog_step' });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.msg.t).toBe('spend_point');
    // The narrowing is the assertion: `talentId` is only reachable once `t` has
    // discriminated the union, which is what makes the handler's signature safe.
    if (parsed.msg.t !== 'spend_point') return;
    expect(parsed.msg.talentId).toBe('talent:fog_step');
  });

  it('REFUSES a smuggled actorId rather than stripping it', () => {
    // THE SECURITY PROPERTY, NOT A FORMALITY, AND THE REFUSAL IS THE ASSERTION.
    // `strictObject` means an unknown key is a REJECTED frame, never a quietly
    // sanitised one — so this is asserted as `ok === false` and never as "the
    // parsed message has no actorId", which would pass just as happily under a
    // permissive `z.object` that had thrown the key away. Identity never travels
    // on this wire; whose sheet gains the level is the socket's session. A frame
    // naming another actor is a client asking to spend somebody else's point,
    // permanently, and it must fail loudly in the log.
    for (const key of ['actorId', 'userId', 'playerId', 'charId', 'targetId']) {
      const forged = parseClientMsg({
        v: V,
        t: 'spend_point',
        talentId: 'talent:fog_step',
        [key]: 'actor_someone_else',
      });
      expect(forged.ok, `${key} must be rejected`).toBe(false);
    }
  });

  it('REFUSES a missing or non-string talentId', () => {
    expect(parseClientMsg({ v: V, t: 'spend_point' }).ok).toBe(false);
    // Not nullable either. An absent field and a null one would be two spellings
    // of "I did not name a talent", and the second always turns up in a
    // hand-rolled client — where the handler would have to invent a meaning for
    // it, and the only meaning available is "spend it on something".
    expect(parseClientMsg({ v: V, t: 'spend_point', talentId: null }).ok).toBe(false);
    expect(parseClientMsg({ v: V, t: 'spend_point', talentId: 3 }).ok).toBe(false);
    expect(parseClientMsg({ v: V, t: 'spend_point', talentId: ['talent:fog_step'] }).ok).toBe(
      false,
    );
    // A talent SLOT index would be a second addressing scheme for the same
    // thing, and the two would disagree the first time a loadout was reordered.
    expect(parseClientMsg({ v: V, t: 'spend_point', slot: 1 }).ok).toBe(false);
  });

  it('REFUSES an empty or oversized talentId', () => {
    expect(parseClientMsg({ v: V, t: 'spend_point', talentId: '' }).ok).toBe(false);
    // 64 is the boundary and it is inclusive; 65 is a place to park a payload.
    const atLimit = 'a'.repeat(TALENT_ID_MAX_CHARS);
    expect(parseClientMsg({ v: V, t: 'spend_point', talentId: atLimit }).ok).toBe(true);
    const overLimit = 'a'.repeat(TALENT_ID_MAX_CHARS + 1);
    expect(parseClientMsg({ v: V, t: 'spend_point', talentId: overLimit }).ok).toBe(false);
  });

  it('accepts an id this build has never heard of — the LOOKUP refuses it, not zod', () => {
    // `talentId` is a bounded string rather than a `z.enum` of the twelve ids,
    // following `TalentSchema`'s stated precedent: baking the catalogue into the
    // wire schema makes every content edit a protocol change. So a frame naming
    // a talent that does not exist — or one the sender has not learned, or one
    // already at its cap — is SHAPE-VALID here and is refused one step later
    // with `bad_message`. This test pins the seam: swap the string for an enum
    // and the coupling comes back, and this line is where you find out.
    expect(parseClientMsg({ v: V, t: 'spend_point', talentId: 'talent:not_a_talent' }).ok).toBe(
      true,
    );
  });

  it('REFUSES a frame with no `v` at all', () => {
    // `parseClientMsg`'s version check is guarded by `'v' in candidate`, so a
    // frame that simply omits the field slips past it entirely — the `z.literal`
    // in the schema is the only thing making the envelope mandatory. Drop it
    // from this one schema and a client from any deploy ever shipped could spend
    // a point against a talent whose levels it cannot even draw.
    expect(parseClientMsg({ t: 'spend_point', talentId: 'talent:fog_step' }).ok).toBe(false);
    const stale = parseClientMsg({ v: V - 1, t: 'spend_point', talentId: 'talent:fog_step' });
    expect(stale.ok).toBe(false);
    if (stale.ok) return;
    expect(stale.error).toContain('protocol version mismatch');
  });

  it('adds NO ErrorCode member for a refused spend', () => {
    // v9 KEPT ITS BUMP ARGUMENT TO ONE REASON, exactly as v8 did. An unknown,
    // unlearned or already-capped talent is `bad_message`; a spend with no
    // points in hand is `bad_message`; where the existing turn gate applies it
    // is `not_your_turn`. src/shared/version.ts records at 2 -> 3 that a new
    // `ErrorCode` independently forces a bump, so a `no_points` member would
    // have forced this one a second time over for a refusal the panel already
    // prevents by greying the `+`.
    expect(Object.values(ErrorCode)).not.toContain('no_points');
    expect(Object.values(ErrorCode)).not.toContain('talent_maxed');
    expect(Object.values(ErrorCode)).toContain('bad_message');
    expect(Object.values(ErrorCode)).toContain('not_your_turn');
  });
});

describe('progress is told to one player, never to the room', () => {
  const progress: ProgressMsg = {
    v: V,
    t: 'progress',
    level: 4,
    // PER-LEVEL, never cumulative: `gainExp` subtracts the threshold on the way
    // past (ActorLevel.lua:104), so this is already the bar's numerator.
    xp: 61,
    // `expChart(5)` — the denominator, on the wire so the client never needs its
    // own copy of MAX_CHARACTER_LEVEL to decide whether the bar is full.
    xpToNext: 174,
    unspent: 2,
    unspentGenerics: 0,
  };

  it('is a ViewerMsg and is NOT assignable to BroadcastMsg', () => {
    // THIS IS THE ENFORCEMENT, NOT A COMMENT ABOUT IT. The gateway's `broadcast`
    // takes a `BroadcastMsg`, so the `@ts-expect-error` below is what fails to
    // compile — in the direction that matters — if somebody removes `progress`
    // from `ViewerMsg`.
    //
    // `unspent` IS INTENT. A banked talent point is a decision somebody has
    // deliberately not made yet, and this union has withheld that class of fact
    // since M3: it is the same argument that made `cooldowns` private, where
    // "Mend Wounds is ready" tells you what an ally is saving for the boss.
    // Broadcast it and every player's pending judgement becomes a queue of
    // people telling each other what to buy.
    const asViewer: ViewerMsg = progress;
    const asServer: ServerMsg = progress;
    expect(asViewer.t).toBe('progress');
    expect(asServer.t).toBe('progress');

    // @ts-expect-error `progress` is viewer-private: `BroadcastMsg` is
    // `Exclude<ServerMsg, ViewerMsg>`, so this assignment must not compile. The
    // suppression IS the assertion — delete it and the file stops building the
    // day the frame becomes broadcastable.
    const notBroadcastable: BroadcastMsg = progress;
    expect(notBroadcastable).toBe(progress);
  });

  it('carries no pendingLevels and no cumulative total', () => {
    // `pendingLevels` is internal scheduler bookkeeping: between a kill and the
    // next base-clock pass it is briefly non-zero, and a panel drawing it would
    // flicker a point that does not exist yet and cannot be spent. A cumulative
    // xp total is absent for the opposite reason — it is not a second fact, it
    // is the same one computed wrongly, and a client holding it would level a
    // player every kill once they were past the sum of the chart.
    expect(Object.keys(progress).sort()).toEqual(
      // `unspentGenerics` joins the required set: two purses cannot be
      // recovered from one total, so the panel needs both or it cannot explain a
      // refused `+`. See ProgressMsg.
      ['level', 't', 'unspent', 'unspentGenerics', 'v', 'xp', 'xpToNext'].sort(),
    );
  });
});

/**
 * THE FOUR FIELDS THAT MAKE A TALENT LEVEL VISIBLE.
 *
 * `level` and `maxLevel` are the `n/max` under the icon; `desc`/`descNext` are
 * the current -> next diff ported in spirit from LevelupDialog.lua:963-970. A
 * panel with the first pair and not the second shows a number that changes and
 * never says what it bought, which is the one failure this milestone is defined
 * against.
 */
describe('LoadoutTalent carries a rank the client cannot invent', () => {
  const fogStep: LoadoutTalent = {
    id: 'talent:fog_step',
    name: 'Fog Step',
    icon: 'icon_talent_fog_step',
    cost: { ap: 0, mp: 3, resource: 10 },
    cooldownTurns: 6,
    // PER-ACTOR FROM v9, and the narrowing that forced the bump. `combatTalentLimit
    // (t, 10, 3, 7)` (mobility.lua:40-62) floors to 3/4/5/6/7, so a rank-3
    // detective genuinely reaches 5 where a rank-1 reaches 3.
    range: 5,
    minRange: 0,
    shape: TalentShape.Tile,
    radius: 0,
    level: 3,
    maxLevel: TALENT_MAX_LEVEL,
    desc: 'Step to a free tile up to 5 tiles away.',
    descNext: 'Step to a free tile up to 6 tiles away.',
  };

  it('takes its cap from the authored constant, never from a literal', () => {
    // `maxLevel` IS ON THE WIRE FOR THE SAME REASON `radius` IS: the client must
    // never hold a second copy of an authored number. This assertion is what
    // says the value is `TALENT_MAX_LEVEL` (src/shared/progression.ts, which is
    // ToME's `t.points`, ActorTalents.lua:71) rather than a 5 somebody typed —
    // move the cap and a renderer with its own 5 keeps drawing "3/5" and keeps
    // offering a `+` on a talent that has run out.
    expect(fogStep.maxLevel).toBe(TALENT_MAX_LEVEL);
    expect(TALENT_MAX_LEVEL).toBe(5);
  });

  it('holds a RAW level inside the cap, and the type cannot say so on its own', () => {
    // WHAT IS ACTUALLY PINNED HERE, STATED PLAINLY RATHER THAN OVERSOLD.
    // TypeScript has no dependent types: `level: number` and `maxLevel: number`
    // cannot express `level <= maxLevel`, and the only way to make level 6 a
    // COMPILE error would be a literal union `1|2|3|4|5` in this file — which is
    // exactly the second copy of an authored number that `maxLevel` exists on
    // the wire to prevent. Cure worse than the disease, so it is not done.
    //
    // The relation is therefore enforced where the points are handed out, and
    // NOWHERE ELSE: the spend handler is the only thing that raises a raw level,
    // and src/shared/scale.ts:165-170 argues at length that the CURVES must not
    // clamp at 5 (a level above the cap has to extrapolate honestly rather than
    // silently flatten). This assertion is the runtime half of that contract.
    expect(fogStep.level).toBeGreaterThanOrEqual(1);
    expect(fogStep.level).toBeLessThanOrEqual(fogStep.maxLevel);

    // A talent on the hotbar is one this detective has LEARNED, so 0 is not a
    // value this field takes — ToME's `traw == 0` branch (LevelupDialog.lua:956)
    // is the unlearned case, and we have no unlearned talents to draw.
    expect(fogStep.level).not.toBe(0);
  });

  it('makes the four fields REQUIRED — an old-shaped talent no longer compiles', () => {
    // THIS IS THE HALF THE TYPE SYSTEM GENUINELY ENFORCES, and it is the half
    // that matters for the bump: a v8-shaped `LoadoutTalent` is not a v9 one.
    // Optional fields would have let `toLoadoutView` keep compiling while
    // sending a hotbar with no ranks on it, which is a client drawing every
    // talent as unlevelled forever with nothing failing anywhere.
    const v8Shaped = {
      id: 'talent:crude_blow',
      name: 'Crude Blow',
      icon: 'icon_talent_crude_blow',
      cost: { ap: 5, mp: 0, resource: 0 },
      cooldownTurns: 0,
      range: 1,
      minRange: 0,
      shape: TalentShape.Single,
      radius: 0,
    };
    // @ts-expect-error the v8 shape is missing `level`, `maxLevel`, `desc` and
    // `descNext`. Delete this suppression and the file stops building the day
    // somebody makes them optional to keep an old call site quiet.
    const stale: LoadoutTalent = v8Shaped;
    expect(stale.id).toBe('talent:crude_blow');

    // @ts-expect-error `level` is a number, not the string a renderer would
    // format it into. The formatting belongs on the panel, not on the wire.
    const stringly: LoadoutTalent = { ...fogStep, level: '3' };
    expect(stringly.name).toBe('Fog Step');
  });

  it('accepts null for descNext, and only null, at the cap', () => {
    // THE AT-CAP BRANCH, LevelupDialog.lua:971-975: upstream renders the current
    // description ALONE when `traw` has reached `getMaxTPoints(t)`, with no
    // `[-> n+1]` header and no diff. `null` is that branch on the wire.
    const capped: LoadoutTalent = {
      ...fogStep,
      level: TALENT_MAX_LEVEL,
      range: 7,
      desc: 'Step to a free tile up to 7 tiles away.',
      descNext: null,
    };
    expect(capped.descNext).toBeNull();
    expect(capped.level).toBe(capped.maxLevel);

    // NULL RATHER THAN "" OR AN OMITTED KEY. Two spellings of "there is no next
    // level" is how a renderer ends up drawing a blank row where the diff should
    // be, and only one of the two spellings gets a case in the switch.
    // @ts-expect-error `descNext` is required; absent is not a third spelling.
    const omitted: LoadoutTalent = {
      id: fogStep.id,
      name: fogStep.name,
      icon: fogStep.icon,
      cost: fogStep.cost,
      cooldownTurns: fogStep.cooldownTurns,
      range: fogStep.range,
      minRange: fogStep.minRange,
      shape: fogStep.shape,
      radius: fogStep.radius,
      level: fogStep.level,
      maxLevel: fogStep.maxLevel,
      desc: fogStep.desc,
    };
    expect(omitted.desc).toBe(fogStep.desc);
  });

  it('renders both sentences server-side, because the client cannot compute one', () => {
    // eslint's NO_COMBAT_MATH_PATTERNS blocks src/client/** from importing
    // src/shared/scale.ts at all, so the browser cannot evaluate
    // `combatTalentScale(level, low, high)` even if somebody wanted it to.
    // Strings are not a shortcut here — they are the only honest shape, and
    // `toLoadoutView`'s docblock states the same rule for every other number on
    // this frame.
    expect(typeof fogStep.desc).toBe('string');
    expect(typeof fogStep.descNext).toBe('string');
    // The pair is a DIFF: it is worth nothing if both halves say the same thing,
    // which is what a stubbed `describe` that ignored its level would produce.
    expect(fogStep.descNext).not.toBe(fogStep.desc);
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * v10 — THE FOUR LOOT VERBS AT THE TRUST BOUNDARY
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * All four are shaped by ONE rule, restated from the head of protocol.ts: a
 * frame names the OBJECT of its verb and never the SUBJECT. `equip`, `unequip`
 * and `drop` name an item or a slot — a thing, not a person — and `pickup` names
 * nothing at all, which is the strongest form of the rule available: there is no
 * coordinate to forge, so there is no adjacency check that can be got wrong.
 *
 * Everything below is about SHAPE. Whether the tile has anything on it, whether
 * the item is in YOUR bag, whether the slot is occupied and whether the body is
 * on its feet are all questions about the world; they are answered in the
 * gateway and come back as `bad_message` or `illegal_move`, never as a new
 * `ErrorCode` — see the last test in this block.
 */
describe('the four loot verbs at the trust boundary', () => {
  /** The schema's own cap, deliberately restated rather than exported. */
  const ITEM_ID_MAX_CHARS = 64;

  /**
   * EVERY WAY A CLIENT COULD TRY TO NAME A PERSON OR A PLACE, in one list.
   *
   * The first five are the protocol-wide banned set (the note at the head of
   * protocol.ts). The rest are the ones THESE verbs specifically invite: a
   * coordinate for `pickup`/`drop`, a ground id for `pickup`, a destination slot
   * for `equip`, an owner for anything. `strictObject` must refuse all of them,
   * and refuse them as REJECTIONS rather than silent strips — a permissive
   * `z.object` that threw the key away would pass a test written as "the parsed
   * message has no actorId" and fail this one.
   */
  const forbiddenKeys = [
    'actorId',
    'userId',
    'playerId',
    'charId',
    'targetId',
    'ownerId',
    'x',
    'y',
    'cell',
    'tile',
    'groundId',
    'slot',
    'dir',
  ] as const;

  it('accepts `pickup` carrying exactly {t, v} and nothing else', () => {
    const parsed = parseClientMsg({ v: V, t: 'pickup' });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.msg.t).toBe('pickup');
    // THE EMPTINESS IS THE ASSERTION. Two keys, both envelope, no payload — so
    // the parsed frame has nothing in it a handler could mistake for a request.
    expect(Object.keys(parsed.msg).sort()).toEqual(['t', 'v']);
  });

  it('REFUSES every attempt to give `pickup` something to point at', () => {
    // THE SECURITY PROPERTY, STATED AS A LIST. The server reads the sender's own
    // live x/y and takes `world.itemsAt(x, y)[0]` (world.ts:516-522 — "PICKUP
    // TAKES INDEX 0"). A supplied coordinate would need an adjacency check on an
    // attacker-chosen number; a supplied `groundId` would name something the
    // client was legitimately sent in the `ground` BROADCAST — the whole floor —
    // and would therefore let a patched client reach across the map. Neither
    // field exists, so neither failure is available.
    for (const key of forbiddenKeys) {
      const forged = parseClientMsg({ v: V, t: 'pickup', [key]: 'anything' });
      expect(forged.ok, `pickup + ${key} must be rejected`).toBe(false);
    }
    // Including the shapes that look most innocent.
    expect(parseClientMsg({ v: V, t: 'pickup', x: 12, y: 8 }).ok).toBe(false);
    expect(parseClientMsg({ v: V, t: 'pickup', itemId: 'item_watchmans_coat' }).ok).toBe(false);
    expect(parseClientMsg({ v: V, t: 'pickup', all: true }).ok).toBe(false);
  });

  it('accepts `equip` naming one item, and narrows it', () => {
    const parsed = parseClientMsg({ v: V, t: 'equip', itemId: 'item_watchmans_coat' });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.msg.t).toBe('equip');
    // The narrowing is the assertion: `itemId` is only reachable once `t` has
    // discriminated the union, which is what makes the handler's signature safe.
    if (parsed.msg.t !== 'equip') return;
    expect(parsed.msg.itemId).toBe('item_watchmans_coat');
  });

  it('REFUSES a destination slot on `equip` — the catalogue decides that', () => {
    // `Item.slot` is AUTHORED (src/server/content/items.ts): a coat goes on the
    // body and there is nowhere else it could go, so a `slot` here would be a
    // client asserting content and the only thing the server could do with a
    // disagreement is ignore it. Upstream reaches the same place by a different
    // road — `Object:wornInven()` (engines/default/engine/Object.lua:104-107)
    // derives the destination FROM the object and the dialog never asks.
    expect(
      parseClientMsg({ v: V, t: 'equip', itemId: 'item_watchmans_coat', slot: 'body' }).ok,
    ).toBe(false);
    // Nor a second addressing scheme for the same item.
    expect(parseClientMsg({ v: V, t: 'equip', index: 0 }).ok).toBe(false);
    expect(parseClientMsg({ v: V, t: 'equip', groundId: 'ground_1' }).ok).toBe(false);
  });

  it('accepts `drop` naming one item, and refuses a destination tile', () => {
    const parsed = parseClientMsg({ v: V, t: 'drop', itemId: 'item_inspectors_locket' });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.msg.t !== 'drop') return;
    expect(parsed.msg.itemId).toBe('item_inspectors_locket');

    // A drop lands on the SENDER'S OWN tile, read server-side. A `{x, y}` here
    // would let a patched client post items into a room it cannot see, and the
    // only defence would be a range check on an attacker-supplied coordinate.
    expect(
      parseClientMsg({ v: V, t: 'drop', itemId: 'item_inspectors_locket', x: 12, y: 8 }).ok,
    ).toBe(false);
    expect(parseClientMsg({ v: V, t: 'drop', itemId: 'item_inspectors_locket', dir: 'n' }).ok).toBe(
      false,
    );
  });

  it('REFUSES an identity field on any of the four, under any name', () => {
    // THE WHOLE-VERB SWEEP for v10, in addition to the protocol-wide one above.
    // Asserted as `ok === false` and never as "the parsed message has no
    // actorId": a permissive `z.object` that stripped the key would pass the
    // second phrasing and would be exactly the bug this is written against.
    const withPayload: readonly Record<string, unknown>[] = [
      { t: 'pickup' },
      { t: 'equip', itemId: 'item_watchmans_coat' },
      { t: 'unequip', slot: Slot.Body },
      { t: 'drop', itemId: 'item_watchmans_coat' },
    ];
    for (const frame of withPayload) {
      expect(parseClientMsg({ v: V, ...frame }).ok, `${String(frame.t)} must parse`).toBe(true);
      for (const key of ['actorId', 'userId', 'playerId', 'charId', 'ownerId']) {
        const forged = parseClientMsg({ v: V, ...frame, [key]: 'actor_someone_else' });
        expect(forged.ok, `${String(frame.t)} + ${key} must be rejected`).toBe(false);
      }
    }
  });

  it('REFUSES a frame with no `v` at all, on all four', () => {
    // THE ONE THAT IS EASY TO GET WRONG, and the reason every schema in
    // protocol.ts carries `v` as a `z.literal`. `parseClientMsg`'s version check
    // is guarded by `'v' in candidate` (protocol.ts's own note at the head of
    // `InspectSchema`), so a frame that simply OMITS the field skips version
    // enforcement ENTIRELY — the literal is the only thing making the envelope
    // mandatory. Drop it from one of these and a client from any deploy ever
    // shipped could loot a floor it cannot draw.
    expect(parseClientMsg({ t: 'pickup' }).ok).toBe(false);
    expect(parseClientMsg({ t: 'equip', itemId: 'item_watchmans_coat' }).ok).toBe(false);
    expect(parseClientMsg({ t: 'unequip', slot: 'body' }).ok).toBe(false);
    expect(parseClientMsg({ t: 'drop', itemId: 'item_watchmans_coat' }).ok).toBe(false);

    // And a stale `v` reports the real problem rather than a complaint about a
    // literal three screens down.
    const stale = parseClientMsg({ v: V - 1, t: 'pickup' });
    expect(stale.ok).toBe(false);
    if (stale.ok) return;
    expect(stale.error).toContain('protocol version mismatch');
  });

  it('bounds an item id, and refuses the empty and the oversized', () => {
    expect(parseClientMsg({ v: V, t: 'equip', itemId: '' }).ok).toBe(false);
    expect(parseClientMsg({ v: V, t: 'equip' }).ok).toBe(false);
    // Not nullable either — absent and null would be two spellings of "I did not
    // name an item", and the second always turns up in a hand-rolled client.
    expect(parseClientMsg({ v: V, t: 'equip', itemId: null }).ok).toBe(false);
    expect(parseClientMsg({ v: V, t: 'drop', itemId: ['item_watchmans_coat'] }).ok).toBe(false);
    // 64 is the boundary and it is inclusive; 65 is a place to park a payload.
    expect(parseClientMsg({ v: V, t: 'equip', itemId: 'a'.repeat(ITEM_ID_MAX_CHARS) }).ok).toBe(
      true,
    );
    expect(parseClientMsg({ v: V, t: 'drop', itemId: 'a'.repeat(ITEM_ID_MAX_CHARS + 1) }).ok).toBe(
      false,
    );
  });

  it('accepts an item id this build has never heard of — the LOOKUP refuses it', () => {
    // `itemId` is a bounded string rather than a `z.enum` of the 22 authored ids,
    // following `TalentSchema`'s stated precedent and `ChooseClassSchema`'s after
    // it: baking the catalogue into the wire schema makes every content edit a
    // protocol change. So a frame naming an item that does not exist is
    // SHAPE-VALID here and is refused one step later by the server's own
    // `itemById` with `bad_message`. This test pins the seam: swap the string for
    // an enum and the coupling comes back, and this line is where you find out.
    //
    // `item_iron_ingot` is the sharpest case — it is a real icon on disk that is
    // DELIBERATELY not authored as an item (content/items.ts's note on
    // `KNOWN_ICON_IDS`), so it is exactly the id a patched client would try.
    expect(parseClientMsg({ v: V, t: 'equip', itemId: 'item_iron_ingot' }).ok).toBe(true);
    expect(parseClientMsg({ v: V, t: 'drop', itemId: 'item_not_a_thing' }).ok).toBe(true);
  });

  it('accepts ONLY the seven slot literals for `unequip`', () => {
    // A SLOT IS STRUCTURE, NOT CONTENT, which is why this one verb is a closed
    // `z.enum` while `equip` is a bounded string. Content reloads without a
    // protocol bump and must not be baked into the wire; the seven slots cannot
    // change without a bump anyway, so the enum costs no coupling and buys a
    // refusal one layer earlier.
    expect(SLOT_ORDER).toHaveLength(7);
    for (const slot of SLOT_ORDER) {
      expect(parseClientMsg({ v: V, t: 'unequip', slot }).ok, `${slot} must parse`).toBe(true);
    }
    // The enum IS the union — a slot that exists on one side and not the other is
    // a slot no client could ever take an item out of.
    expect([...SLOT_ORDER].sort()).toEqual(Object.values(Slot).sort());

    const bad: unknown[] = [
      'mainhand', // there is no weapon slot; see `Slot`'s note on the missing art
      'finger', // ToME's own name for what we call `ring`
      'BODY', // upstream's casing; ours is lowercased
      'inven',
      '',
      0,
      null,
      ['body'],
    ];
    for (const slot of bad) {
      expect(
        parseClientMsg({ v: V, t: 'unequip', slot }).ok,
        `${JSON.stringify(slot)} must be rejected`,
      ).toBe(false);
    }
    // And a slot is the only thing it takes.
    expect(parseClientMsg({ v: V, t: 'unequip' }).ok).toBe(false);
    expect(parseClientMsg({ v: V, t: 'unequip', slot: 'body', itemId: 'item_x' }).ok).toBe(false);
  });

  it('adds NO ErrorCode member for a refused loot verb', () => {
    // v10 KEPT ITS BUMP ARGUMENT TO ONE REASON, exactly as v8 and v9 did.
    // Nothing on the tile, an item that is not in your bag, an empty slot, an
    // item you already own: `bad_message`. A body that may not act on the world
    // at all: `illegal_move`. Both are already rendered by every shipped client.
    // src/shared/version.ts records at 2 -> 3 that a new `ErrorCode`
    // INDEPENDENTLY forces a bump, so a `no_such_item` member would have forced
    // this one a second time over for a refusal the panel already prevents by
    // only drawing buttons for things the player is holding.
    for (const invented of ['no_such_item', 'inventory_full', 'slot_empty', 'nothing_here']) {
      expect(Object.values(ErrorCode)).not.toContain(invented);
    }
    expect(Object.values(ErrorCode)).toContain('bad_message');
    expect(Object.values(ErrorCode)).toContain('illegal_move');
  });
});

/**
 * v10's TWO OUTBOUND FRAMES, AND THE SPLIT BETWEEN THEM.
 *
 * They landed in the same release and in DIFFERENT unions, which is the whole
 * point: `broadcast(groundMsg)` is the correct call and `broadcast(inventoryMsg)`
 * must be a COMPILE ERROR rather than a rule somebody has to remember at 1 a.m.
 * `BroadcastMsg = Exclude<ServerMsg, ViewerMsg>` is what makes that mechanical.
 */
describe('the floor is broadcast and the bag is not', () => {
  const ground: GroundMsg = {
    v: V,
    t: 'ground',
    items: [
      {
        id: 'ground_1',
        // ONE COMPOUND VALUE, not two loose numbers. A ground item never moves
        // (world.ts:874 freezes the record with that note), so its tile is a
        // key — and it is the key the client groups by to draw ONE pile marker
        // on a tile holding three things.
        cell: [12, 8],
        itemId: 'item_watchmans_coat',
        tier: ItemTier.Rare,
      },
      // TWO ROWS, ONE `itemId`, TWO `id`s — the case that proves why both fields
      // exist. A client keying on `itemId` would draw one marker for two coats
      // and be permanently one short.
      { id: 'ground_2', cell: [12, 8], itemId: 'item_watchmans_coat', tier: ItemTier.Rare },
    ],
  };

  const inventory: InventoryMsg = {
    v: V,
    t: 'inventory',
    carried: [
      {
        itemId: 'item_watchmans_coat',
        name: "Watchman's Coat",
        icon: 'item_watchmans_coat',
        tier: ItemTier.Rare,
        desc: 'Heavy wool over a mail lining.',
        slot: Slot.Body,
        // PRE-FORMATTED, SERVER-SIDE. Ported in spirit from ShowEquipInven.lua:54,
        // which passes the destination inventory into `getDesc` as `compare_with`
        // (Object.lua:2074, forwarded at :2120), where `compare_fields(w,
        // compare_with, field, "combat_armor", "%+d", "Armour: ")` at :1285-1287
        // renders exactly a label and a signed number.
        compare: [
          { label: 'Armour', value: '+4', emphasis: true },
          { label: 'Armour Hardiness', value: '+10%' },
        ],
      },
    ],
    equipped: {
      [Slot.Head]: {
        itemId: 'item_watchmans_cap',
        name: "Watchman's Cap",
        icon: 'item_watchmans_cap',
        tier: ItemTier.Uncommon,
        desc: 'Reinforced felt with a brass band.',
      },
    },
    money: 27,
  };

  it('puts `ground` in ServerMsg and NOT in ViewerMsg', () => {
    // THE ASSERTION IS THE `@ts-expect-error`, NOT THE `expect`. A floor item is
    // a POSITION — world state, identical for everybody under shared party FOV —
    // and `ProjectilesMsg` is the exact precedent, broadcast today with the
    // written caveat that it moves to `ViewerMsg` the day per-player FOV lands.
    // Ground items ride that same caveat and it is written on `GroundMsg`.
    const asServer: ServerMsg = ground;
    const asBroadcast: BroadcastMsg = ground;
    expect(asServer.t).toBe('ground');
    expect(asBroadcast.t).toBe('ground');

    // @ts-expect-error `ground` is NOT viewer-private. Delete this suppression
    // and the file stops building the day somebody moves it into `ViewerMsg`
    // without also moving every `broadcast(groundMsg)` call site — which is the
    // point of the Exclude, and is exactly the migration per-player FOV will one
    // day require.
    const notViewerPrivate: ViewerMsg = ground;
    expect(notViewerPrivate).toBe(ground);
  });

  it('puts `inventory` in BOTH ServerMsg and ViewerMsg', () => {
    // MEMBERSHIP OF `ViewerMsg` IS THE ENFORCEMENT. An inventory is what a player
    // is carrying and holding back, which is the same class of fact as
    // `progress.unspent` at v9 and `cooldowns` at M3 — a decision somebody has
    // not made yet. And independently there is NO SHAPE OF THIS FRAME THAT IS
    // CORRECT FOR TWO PEOPLE: `compare` is a delta against the recipient's own
    // doll, so the same coat is "+4 Armour" for a bare Watchman and nothing at
    // all for one already wearing it. A shared copy would not merely leak, it
    // would be arithmetically wrong for everybody but its author.
    const asViewer: ViewerMsg = inventory;
    const asServer: ServerMsg = inventory;
    expect(asViewer.t).toBe('inventory');
    expect(asServer.t).toBe('inventory');

    // @ts-expect-error `inventory` is viewer-private: `BroadcastMsg` is
    // `Exclude<ServerMsg, ViewerMsg>`, so this assignment must not compile. The
    // suppression IS the assertion — delete it and the file stops building the
    // day the frame becomes broadcastable.
    const notBroadcastable: BroadcastMsg = inventory;
    expect(notBroadcastable).toBe(inventory);
  });

  it('derives the split from BroadcastMsg itself, so widening either union fails here', () => {
    // NOT A HAND-TYPED LIST. The two tag sets earlier in this file are typed by a
    // human and therefore cannot catch a frame that became wrongly broadcastable
    // — the type would widen and the literal would simply be one tag short.
    // These assignments are `Exclude`-derived: `broadcastable` accepts only tags
    // that SURVIVE the Exclude, and `viewerOnly` only tags that do not.
    const broadcastable: BroadcastMsg['t'] = 'ground';
    const viewerOnly: Exclude<ServerMsg['t'], BroadcastMsg['t']> = 'inventory';
    expect(broadcastable).toBe('ground');
    expect(viewerOnly).toBe('inventory');

    // @ts-expect-error `inventory` does not survive the Exclude. This is the
    // assertion that fails at BUILD time if a future edit widens `BroadcastMsg`
    // by dropping `inventory` out of `ViewerMsg`.
    const wrongWay: BroadcastMsg['t'] = 'inventory';
    expect(wrongWay).toBe('inventory');

    // @ts-expect-error and `ground` is not viewer-only, in the other direction.
    const alsoWrong: Exclude<ServerMsg['t'], BroadcastMsg['t']> = 'ground';
    expect(alsoWrong).toBe('ground');
  });

  it('treats an empty `ground` array as a valid frame — the floor is CLEAR', () => {
    // IT IS A CLAIM, NOT AN ABSENCE, and this is the whole contract of the frame.
    // `ProjectilesMsg`'s own note is the wording it is copied from: the snapshot
    // is COMPLETE AND ABSOLUTE, "a client that dropped one patch would otherwise
    // show a phantom orb forever, and a phantom orb teaches the wrong
    // counterplay." A phantom FLOOR ITEM is worse: it sends somebody walking the
    // length of the map, through a fight, to a tile with nothing on it — and
    // because the pile is unowned and first pickup wins, what they conclude is
    // that a friend took it.
    //
    // So the frame is still SENT when the last item is taken, and it is still
    // broadcastable when it says nothing is there.
    const cleared: BroadcastMsg = { v: V, t: 'ground', items: [] };
    expect(cleared.t).toBe('ground');
    if (cleared.t !== 'ground') return;
    expect(cleared.items).toEqual([]);

    // An absent `items` key is NOT a third spelling of "clear" — the field is
    // required, so a producer with nothing to report must say so explicitly.
    // @ts-expect-error `items` is required; omitting it is not "the floor is
    // clear", it is a frame that forgot to answer.
    const omitted: GroundMsg = { v: V, t: 'ground' };
    expect(omitted.t).toBe('ground');
  });

  it('lets an inventory be empty in both halves without being absent', () => {
    // The normal state for most of a delve. `carried: []` and `equipped: {}` are
    // real answers meaning "nothing" — as distinct from the frame never arriving,
    // which means the server has not spoken about this player at all.
    // `money: 0` and not an omission: every character HAS a purse, so unlike the
    // two halves above there is no "absent means nothing was said" case here.
    const bare: InventoryMsg = { v: V, t: 'inventory', carried: [], equipped: {}, money: 0 };
    expect(bare.carried).toEqual([]);
    expect(Object.keys(bare.equipped)).toEqual([]);
  });

  it('makes an empty slot ABSENT rather than present-and-null', () => {
    // Two spellings of "empty" is how a renderer ends up drawing a blank paper
    // doll cell for one of them and a broken one for the other, and only one of
    // the two gets a case in the switch. `Partial<Record<Slot, ItemView>>` gives
    // exactly one spelling.
    expect(inventory.equipped[Slot.Head]?.name).toBe("Watchman's Cap");
    expect(inventory.equipped[Slot.Body]).toBeUndefined();

    // @ts-expect-error `null` is not a second way to say a slot is empty.
    const nulled: InventoryMsg = { v: V, t: 'inventory', carried: [], equipped: { body: null } };
    expect(nulled.t).toBe('inventory');
  });

  it('keeps the `wielder` table off the wire entirely', () => {
    // WHAT AN ITEM DOES IS ENGINE DATA. A client holding
    // `{ mods: { armour: 4 } }` could work out for itself what equipping the
    // thing would do — which is precisely the arithmetic `compare` exists to have
    // already done, and it would get it WRONG, because `rescaleCombatStats`
    // floors (shared/scale.ts:116) so +3 Strength is worth a different number of
    // points of damage depending on where the total already sits.
    const worn = inventory.equipped[Slot.Head];
    expect(worn).toBeDefined();
    if (!worn) return;
    expect(Object.keys(worn).sort()).toEqual(['desc', 'icon', 'itemId', 'name', 'tier'].sort());
    expect('wielder' in worn).toBe(false);
    expect('mods' in worn).toBe(false);
  });

  it('carries the comparison as rows the server already formatted', () => {
    // THE ROWS ARE `InspectRow`s — REUSED, NOT REDECLARED, the same move
    // `PartyStateMember.state` makes with `TurnActorState`: one shape means the
    // inventory panel and the hover card draw a stat line the same way and
    // cannot drift into two house styles on one screen.
    const coat = inventory.carried[0];
    expect(coat).toBeDefined();
    if (!coat) return;
    expect(coat.compare[0]).toEqual({ label: 'Armour', value: '+4', emphasis: true });

    // STRINGS, NOT NUMBERS. eslint's NO_COMBAT_MATH_PATTERNS blocks src/client/**
    // from importing shared/checkhit, shared/scale and shared/energy at all, so
    // the browser could not format a delta correctly even if it wanted to — and
    // src/client/ui/tooltip.ts:6-16 exists to keep the second copy of a combat
    // formula out of it. A number here would be an invitation to do arithmetic.
    for (const row of coat.compare) {
      expect(typeof row.value).toBe('string');
    }

    // @ts-expect-error a raw number is not a formatted comparison row. Delete
    // this suppression and the browser gets an operand instead of an answer.
    const numeric: CarriedItemView = { ...coat, compare: [{ label: 'Armour', value: 4 }] };
    expect(numeric.itemId).toBe('item_watchmans_coat');
  });

  it('names the slot on a carried item and NOT on a worn one', () => {
    // In `equipped` the map KEY is the slot, so a `slot` field in the value would
    // be a second copy of the same fact that can disagree with the first — the
    // argument `PartyMember` makes about hp, in a smaller place. In `carried`
    // there is no key to read it off, so it is named.
    const coat = inventory.carried[0];
    expect(coat?.slot).toBe(Slot.Body);
    expect(Slot.Body).toBe('body');

    const worn = inventory.equipped[Slot.Head];
    expect(worn && 'slot' in worn).toBe(false);
  });

  it("names ToME's slots, lowercased, so a grep against upstream still lands", () => {
    // `body`, `head` and `feet` are verbatim upstream (data/birth/descriptors.lua
    // :56). The two deviations are argued in src/server/content/items.ts:
    // FINGER=2 becomes RING=1, and there is one shared body table rather than one
    // per class — because the floor pile is unowned and a drop only one class can
    // wear is dead on arrival most of the time it appears.
    expect(Object.values(Slot).sort()).toEqual(
      ['body', 'feet', 'head', 'legs', 'offhand', 'ring', 'trinket'].sort(),
    );
    // THERE IS NO WEAPON SLOT, and that is a fact about the art rather than a
    // design preference: no `icon_weapon_*` file exists, and an unresolved key
    // renders as the LOUD violet missing-asset box on a bare clone.
    expect(Object.values(Slot)).not.toContain('mainhand');
    expect(Object.values(Slot)).not.toContain('finger');
  });

  it('names the three tiers the catalogue authors', () => {
    // Member-for-member the server's `ItemTier` (src/server/content/items.ts),
    // where the same three values ARE the drop tables. It is on the wire because
    // it is the only thing that colours a floor marker or an inventory row, and
    // a client inferring it would need a table of "which items are rare" — a
    // second copy of authored content in the one place that must never hold one.
    expect(Object.values(ItemTier).sort()).toEqual(['common', 'rare', 'uncommon'].sort());
  });
});
