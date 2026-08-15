import { describe, expect, it } from 'vitest';

import { DOWNED_TURNS, createDownedState, goDown } from '../../src/server/engine/downed.ts';
import { createEffectState, setEffect } from '../../src/server/engine/effects.ts';
import { BLEEDING, STUNNED } from '../../src/server/content/effects.ts';
import { projectEffects, projectParty, projectTurn } from '../../src/server/view/projector.ts';
import { createWorld } from '../../src/server/world/world.ts';
import { AiProfile } from '../../src/server/engine/actor.ts';
import { ActorRank, MONSTERS_TURN_ID } from '../../src/shared/protocol.ts';
import { createRng } from '../../src/shared/rng.ts';
import type { TurnState } from '../../src/server/view/projector.ts';
import type { World } from '../../src/server/world/world.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE PROJECTION LAYER IS WHERE A LEAK WOULD HAPPEN, SO IT IS WHERE THE TESTS
 * ARE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Two frames land in M4 and both are SNAPSHOTS rather than patch streams:
 * `effects` (every badge in the world) and `party` (every detective's survival
 * state). The property that makes a snapshot safe is that it is COMPLETE — an
 * actor absent from `effects` is clean, and a client that drops a frame is
 * corrected by the next one rather than holding a Stun icon on a monster
 * forever. Every test below is about that completeness, or about the one thing
 * a projection must never do: put something on the wire that the server did not
 * decide to say.
 */

const RNG = () => createRng('projector');

/** An open floor with one detective, so a test says only what it is about. */
function room(): World {
  const world = createWorld('projector');
  return world;
}

function monster(world: World, id: string, x: number, y: number) {
  return world.addMonster(id, {
    name: 'Index Husk',
    sprite: 'enemy_index_husk_s',
    x,
    y,
    profile: AiProfile.MeleeChaser,
  });
}

/**
 * A barrier snapshot with the fields a test does not care about filled in.
 *
 * `engagement: 0` is the DEFAULT because it is the state a fresh floor is in —
 * nothing is hunting you, nobody blocks, and a test has to say so explicitly to
 * be about combat.
 */
function barrier(over: Partial<TurnState> = {}): TurnState {
  return {
    gameTurn: 3,
    engagement: 0,
    whoseTurn: [],
    committed: [],
    standingBy: [],
    bellDurationMs: null,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// projectEffects — the badge row
// ---------------------------------------------------------------------------

describe('projectEffects', () => {
  it('says nothing at all about a world with no statuses in it', () => {
    // NOT an empty row per actor. "Complete and absolute" means absence IS the
    // statement, and a frame carrying six empty arrays every pump is noise that
    // says the same thing at six times the size.
    const world = room();
    world.addPlayer('actor_a', 'Dalt');
    monster(world, 'mon_a', 5, 5);

    const msg = projectEffects(world, createEffectState());
    expect(msg.t).toBe('effects');
    expect(msg.actors).toEqual([]);
  });

  it('carries the badge and nothing behind it', () => {
    const world = room();
    const husk = monster(world, 'mon_a', 5, 5);
    const effects = createEffectState([STUNNED]);

    // No `applyPower`, so no save is rolled and the full duration lands — see
    // the draw-budget note in engine/effects.ts. The number under test here is
    // the projection, not the roll.
    const applied = setEffect(effects, husk, STUNNED.id, 3, {}, RNG());
    expect(applied.dur).toBe(3);

    const [row] = projectEffects(world, effects).actors;
    expect(row?.id).toBe('mon_a');
    expect(row?.effects).toEqual([
      {
        id: STUNNED.id,
        name: 'Stunned',
        // AN ASSET KEY, NEVER A PATH. The client owns the manifest, so recutting
        // the badge art must not be able to invalidate a frame.
        icon: 'icon_status_stunned',
        turns: 3,
        harmful: true,
      },
    ]);

    // THE MECHANICS STAY SERVER-SIDE. A badge answers "what is on me and for how
    // much longer"; the save that was rolled, the power that beat it and the
    // ×0.4 outgoing damage are the Record lane's business and the engine's.
    // Spelled out as a key check because the failure mode is additive: somebody
    // spreads the instance one day and the whole effect table is on the wire.
    expect(Object.keys(row?.effects[0] ?? {}).sort()).toEqual(
      ['harmful', 'icon', 'id', 'name', 'turns'].sort(),
    );
  });

  it('draws no badges on a body that is not standing — a corpse OR a Downed ally', () => {
    // `goDown` sets `alive = false` on a Downed detective, deliberately: that
    // flag is what stops the scheduler ticking them. So their statuses are
    // FROZEN, and a badge counting down from 3 that will never reach 2 is a lie
    // the party would plan around. The countdown they get instead is `party`'s.
    const world = room();
    const dalt = world.addPlayer('actor_a', 'Dalt');
    const husk = monster(world, 'mon_a', 5, 5);
    const effects = createEffectState([BLEEDING]);

    setEffect(effects, dalt, BLEEDING.id, 4, {}, RNG());
    setEffect(effects, husk, BLEEDING.id, 4, {}, RNG());
    expect(projectEffects(world, effects).actors).toHaveLength(2);

    goDown(createDownedState(), dalt, 1);
    husk.alive = false;

    expect(projectEffects(world, effects).actors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// projectParty — the panel that makes "GET TO ME" possible
// ---------------------------------------------------------------------------

describe('projectParty', () => {
  it('is the DETECTIVES, never the monsters', () => {
    const world = room();
    world.addPlayer('actor_a', 'Dalt');
    world.addPlayer('actor_b', 'Sam');
    monster(world, 'mon_a', 5, 5);

    const msg = projectParty(world, undefined);
    expect(msg.members.map((m) => m.id)).toEqual(['actor_a', 'actor_b']);
  });

  it('reports nobody down when no survival system is wired in', () => {
    // FAIL CLOSED. The honest answer for a server without engine/downed.ts is
    // "nobody is on the floor", not a fabricated five-turn timer over a corpse.
    const world = room();
    world.addPlayer('actor_a', 'Dalt');

    expect(projectParty(world, undefined).members[0]?.downed).toBeNull();
  });

  it('carries the five-turn countdown, and the marker with it', () => {
    // game-design.md § 9: five turns, and the number is on the wire rather than
    // assumed by the client because it is what decides whether anybody can get
    // there in time.
    const world = room();
    const dalt = world.addPlayer('actor_a', 'Dalt');
    const downed = createDownedState();

    goDown(downed, dalt, 7);

    const [row] = projectParty(world, downed).members;
    expect(row?.downed).toEqual({
      status: 'downed',
      marker: 'ui_marker_downed',
      turnsLeft: DOWNED_TURNS,
      total: DOWNED_TURNS,
    });
    expect(DOWNED_TURNS).toBe(5);
  });

  it('lights the speaking dot from the set the gateway hands it, not from a clock', () => {
    // src/server/view/** may not call `Date.now` — eslint.config.js groups 2+3
    // ban it outright — so the decision arrives already made, exactly as
    // `bellMs` does. This test is the proof that the seam is a parameter.
    const world = room();
    world.addPlayer('actor_a', 'Dalt');
    world.addPlayer('actor_b', 'Sam');

    const msg = projectParty(world, undefined, new Set(['actor_b']));
    expect(msg.members.map((m) => m.voice)).toEqual(['silent', 'speaking']);
  });

  it('reports presence, which is not the same fact as Standing By', () => {
    // `connected` is "is a socket driving this body"; Standing By is about the
    // QUORUM and lives on `TurnMsg`. A player can be connected and standing by
    // after two silent turns, so the panel must not derive one from the other.
    const world = room();
    const dalt = world.addPlayer('actor_a', 'Dalt');
    dalt.connected = false;

    expect(projectParty(world, undefined).members[0]?.connected).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// projectTurn — the frame that finally says COMBAT HAS STARTED
// ---------------------------------------------------------------------------

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THIS IS THE BUG REPORT FROM REAL PLAY, WRITTEN AS TESTS.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * "The enemy does show up and will initiate combat when too close. The problem
 * is the players do not know when combat starts and there is no indicator that
 * it's turn-based once combat starts."
 *
 * The server always knew — `world.turn.engagement` is the level-wide combat
 * clock and it is what arms the barrier — and it was never projected. So the
 * first two tests are about the fact travelling at all, and the rest are about
 * the card strip built on it saying WHO STILL OWES A DECISION rather than
 * implying a turn order that this game does not have (DECISIONS.md D1).
 */
describe('projectTurn', () => {
  it('says whether the party is in a fight, and does not make the client guess', () => {
    const world = room();
    const dalt = world.addPlayer('actor_a', 'Dalt');

    const quiet = projectTurn(dalt, world, barrier(), null);
    expect(quiet.engagement).toBe(0);
    expect(quiet.inCombat).toBe(false);

    // The crossing. Note that `whoseTurn` is IDENTICAL in both frames here —
    // which is the whole point: under the old shape these two moments were the
    // same message, so there was no transition for a client to announce.
    const engaged = projectTurn(dalt, world, barrier({ engagement: 5 }), null);
    expect(engaged.engagement).toBe(5);
    expect(engaged.inCombat).toBe(true);
    expect(engaged.whoseTurn).toEqual(quiet.whoseTurn);
  });

  it('derives inCombat on the server so two clients cannot disagree', () => {
    const world = room();
    const dalt = world.addPlayer('actor_a', 'Dalt');

    // Engagement decays turn by turn rather than snapping to zero, so the last
    // engaged turn is `1` — the off-by-one a client-side `>= 1` vs `> 0` would
    // get wrong, and the reason the flag is sent rather than inferred.
    expect(projectTurn(dalt, world, barrier({ engagement: 1 }), null).inCombat).toBe(true);
    expect(projectTurn(dalt, world, barrier({ engagement: 0 }), null).inCombat).toBe(false);
  });

  it('orders the strip by JOIN ORDER and never by anything that could read as a queue', () => {
    // Deliberately joined out of alphabetical order. A strip sorted by name — or
    // by state, or by hp — would reorder itself mid-fight and imply an initiative
    // order that does not exist: every player acts in the SAME window.
    const world = room();
    const zed = world.addPlayer('actor_z', 'Zed');
    world.addPlayer('actor_a', 'Ann');
    world.addPlayer('actor_m', 'Mo');

    const msg = projectTurn(zed, world, barrier({ engagement: 4 }), null);
    expect(msg.actors.map((c) => c.id)).toEqual([
      'actor_z',
      'actor_a',
      'actor_m',
      MONSTERS_TURN_ID,
    ]);
  });

  it('gives the whole hostile side ONE card, last, and only while engaged', () => {
    // They resolve together as a batched sweep (`SweepMsg` is one frame for the
    // whole monster turn), so a row of individual monster cards would say eight
    // creatures take eight separately-timed turns.
    const world = room();
    const dalt = world.addPlayer('actor_a', 'Dalt');
    monster(world, 'mon_a', 5, 5);
    monster(world, 'mon_b', 6, 5);
    monster(world, 'mon_c', 7, 5);

    const free = projectTurn(dalt, world, barrier(), null);
    expect(free.actors.map((c) => c.kind)).toEqual(['player']);

    const engaged = projectTurn(dalt, world, barrier({ engagement: 5 }), null);
    const cards = engaged.actors.filter((c) => c.kind === 'monsters');
    expect(cards).toHaveLength(1);
    expect(engaged.actors[engaged.actors.length - 1]?.id).toBe(MONSTERS_TURN_ID);
    expect(cards[0]?.name).toBe('The Filed');
    expect(cards[0]?.isSelf).toBe(false);
  });

  it('sums the living hostiles and wears the most dangerous face', () => {
    const world = room();
    const dalt = world.addPlayer('actor_a', 'Dalt');
    const husk = monster(world, 'mon_a', 5, 5);
    const elite = world.addMonster('mon_elite', {
      name: 'Index Husk',
      sprite: 'enemy_index_husk_elite_s',
      x: 6,
      y: 5,
      profile: AiProfile.MeleeChaser,
      rank: ActorRank.Elite,
    });
    const corpse = monster(world, 'mon_dead', 7, 5);
    corpse.alive = false;

    const [, side] = projectTurn(dalt, world, barrier({ engagement: 5 }), null).actors;
    // The corpse is scenery — counting it would say the fight is going worse
    // than it is.
    expect(side?.hp).toBe(husk.hp + elite.hp);
    expect(side?.maxHp).toBe(husk.maxHp + elite.maxHp);
    // A SPRITE key the client is already drawing on the map, never a path.
    expect(side?.portrait).toBe('enemy_index_husk_elite_s');
  });

  it('marks exactly one card as self, and a different one for each viewer', () => {
    const world = room();
    const dalt = world.addPlayer('actor_a', 'Dalt');
    const sam = world.addPlayer('actor_b', 'Sam');

    const asDalt = projectTurn(dalt, world, barrier({ engagement: 3 }), null);
    const asSam = projectTurn(sam, world, barrier({ engagement: 3 }), null);

    expect(asDalt.actors.filter((c) => c.isSelf).map((c) => c.id)).toEqual(['actor_a']);
    expect(asSam.actors.filter((c) => c.isSelf).map((c) => c.id)).toEqual(['actor_b']);
  });

  it('reads the barrier precedence: standing by, then commit, then the Bell', () => {
    const world = room();
    const dalt = world.addPlayer('actor_a', 'Dalt');
    world.addPlayer('actor_b', 'Sam');
    world.addPlayer('actor_c', 'Mo');

    const state = barrier({
      engagement: 5,
      // Sam still owes a decision; Mo is out of the quorum; Dalt is in neither
      // array, which under this barrier means he has already submitted.
      whoseTurn: ['actor_b'],
      standingBy: ['actor_c'],
    });

    const quiet = projectTurn(dalt, world, state, null);
    expect(quiet.actors.map((c) => c.state)).toEqual([
      'committed',
      'waiting',
      'standing_by',
      // The sweep is queued behind the party while a human still owes a move.
      'waiting',
    ]);

    // A running Bell decorates `waiting` and NOTHING ELSE — it only ever rings
    // for the last straggler, so blocking-while-a-Bell-is-up IS being them.
    const ringing = projectTurn(dalt, world, state, 12_000);
    expect(ringing.actors.map((c) => c.state)).toEqual([
      'committed',
      'bell',
      'standing_by',
      'waiting',
    ]);
  });

  it('says the monsters are ACTING once the party has stopped deciding', () => {
    const world = room();
    const dalt = world.addPlayer('actor_a', 'Dalt');
    monster(world, 'mon_a', 5, 5);

    const msg = projectTurn(dalt, world, barrier({ engagement: 5, whoseTurn: [] }), null);
    expect(msg.actors[1]?.state).toBe('acting');
  });

  it('keeps a body on the floor ON the strip — out of the quorum and flagged', () => {
    // `surveyQuorum` skips a body that is not standing BEFORE it decides
    // anything, so a Downed detective is in neither `whoseTurn` nor
    // `standingBy`. A card built from the arrays alone would call them
    // "committed" and tell the party the person bleeding out has taken a turn.
    const world = room();
    const dalt = world.addPlayer('actor_a', 'Dalt');
    const sam = world.addPlayer('actor_b', 'Sam');
    const downed = createDownedState();
    goDown(downed, sam, 7);

    const state = barrier({ engagement: 5, whoseTurn: ['actor_a'] });
    const [, fallen] = projectTurn(dalt, world, state, null, downed).actors;

    expect(fallen?.state).toBe('standing_by');
    expect(fallen?.downed).toBe(true);
    // THE SAME FACE. `goDown` swapped the sprite to the `_downed_s` variant, and
    // a portrait that changed at that moment would be the one card the party is
    // trying to recognise.
    expect(fallen?.portrait).toBe('icon_character_the_inspector');

    // Nobody is ever down without a survival table — a corpse and a Downed
    // detective are the same two fields on the actor, and only this table knows.
    const blind = projectTurn(dalt, world, state, null).actors[1];
    expect(blind?.downed).toBe(false);
    expect(blind?.state).toBe('standing_by');
  });

  it('falls back to the generic portrait rather than inventing an asset name', () => {
    // `addPlayer` rotates the six class sprites; the fourth is the Enforcer,
    // which has no cut icon. A key for art that is not on disk would draw a
    // missing-asset box in the middle of the most-looked-at UI in the game.
    const world = room();
    world.addPlayer('actor_a', 'Ann');
    world.addPlayer('actor_b', 'Bo');
    world.addPlayer('actor_c', 'Cy');
    const dee = world.addPlayer('actor_d', 'Dee');

    const msg = projectTurn(dee, world, barrier(), null);
    expect(msg.actors.map((c) => c.portrait)).toEqual([
      'icon_character_the_watchman',
      'icon_character_the_inspector',
      'icon_character_the_alchemist',
      'icon_character_the_detective',
    ]);
  });

  it('puts nothing on a card that the viewer is not entitled to', () => {
    // Spelled out as a key check because the failure mode is additive: somebody
    // spreads the actor one day and `energy`, `pendingIntent` and the AI's
    // target are on the wire — and energy alone would let a client compute the
    // turn order in advance.
    const world = room();
    const dalt = world.addPlayer('actor_a', 'Dalt');

    const [card] = projectTurn(dalt, world, barrier(), null).actors;
    expect(Object.keys(card ?? {}).sort()).toEqual(
      ['downed', 'hp', 'id', 'isSelf', 'kind', 'maxHp', 'name', 'portrait', 'state'].sort(),
    );
  });
});
