import { describe, expect, it } from 'vitest';

import { DOWNED_TURNS, createDownedState, goDown } from '../../src/server/engine/downed.ts';
import { createEffectState, setEffect } from '../../src/server/engine/effects.ts';
import { BLEEDING, STUNNED } from '../../src/server/content/effects.ts';
import { DamageType } from '../../src/server/engine/damage.ts';
import { stepProjectile } from '../../src/server/engine/projectile.ts';
import {
  projectClassOptions,
  projectEffects,
  projectParty,
  projectProjectiles,
  projectTurn,
} from '../../src/server/view/projector.ts';
import { CLASSES } from '../../src/server/content/classes.ts';
import { RESOURCE_RULES } from '../../src/server/engine/talents.ts';
import { createWorld } from '../../src/server/world/world.ts';
import { AiProfile } from '../../src/server/engine/actor.ts';
import { ActorRank, MONSTERS_TURN_ID } from '../../src/shared/protocol.ts';
import { PROTOCOL_VERSION } from '../../src/shared/version.ts';
import { TICKS_PER_GAME_TURN, energyGainPerTick, grantEnergy } from '../../src/shared/energy.ts';
import { createRng } from '../../src/shared/rng.ts';
import type { Projectile } from '../../src/server/engine/projectile.ts';
import type { TurnState } from '../../src/server/view/projector.ts';
import type { World } from '../../src/server/world/world.ts';
import type { TileXY } from '../../src/shared/coords.ts';

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
// projectProjectiles — the orb the player is supposed to be able to see coming
// ---------------------------------------------------------------------------

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * IF THE PLAYER CANNOT SEE THE ORB, THE COUNTERPLAY DOES NOT EXIST.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The whole feature is one sentence of play — *the orb flies to the tile you
 * were standing on when it was fired, so stepping off it makes it miss, and you
 * have two full turns to do it* — and this function is the only thing that puts
 * that sentence on a screen. So the tests are about the three properties that
 * decide whether it can be acted on:
 *
 *   COMPLETE. Every orb in the air appears and nothing else does, because the
 *   frame REPLACES the client's list. One missing orb is an unseen shot; one
 *   extra is a phantom that teaches the wrong lesson.
 *
 *   TURNS, NOT MILLISECONDS. `turnsToImpact` is how many decisions the player
 *   has left. src/server/view/** may not call `Date.now` at all (eslint groups
 *   2+3), so there is no deadline in the frame and could not be one.
 *
 *   NOTHING ELSE. The orb knows the frozen damage roll, the armour penetration
 *   and every tile it is going to cross. None of it is the client's business.
 */

/** Row 17 of the test map is open floor from x=1 to x=28 — nothing to block a shot. */
const LANE_Y = 17;

/**
 * One orb in the air, fired east along the open lane.
 *
 * Straight down a clear row on purpose: these tests are about the PROJECTION,
 * and a wall or a body in the line would make them quietly about `blockPath`
 * instead. Those five stops are pinned in test/server/projectile.test.ts.
 */
function fire(world: World, from: TileXY, to: TileXY, projSpeed = 2): Projectile {
  return world.addProjectile({
    sourceId: 'mon_a',
    origin: from,
    to,
    projSpeed,
    range: 10,
    damage: { dam: 5, type: DamageType.Physical, apr: 0 },
  });
}

/**
 * ONE GAME TURN of the energy clock, for one orb — ten ticks of grant-then-act,
 * which is `tickLevel`'s loop with everything that is not an orb removed.
 *
 * Written out rather than driven through the scheduler because the claim under
 * test is arithmetic about the WIRE FIELD, not about scheduling: a real pump
 * would also need a barrier, a party and an engagement clock, and the tick
 * counts it produces are already pinned in test/server/projectile.test.ts. Ten
 * ticks is `TICKS_PER_GAME_TURN` (energy.ts — ENERGY_TO_ACT / ENERGY_PER_TICK),
 * and it is imported rather than written as `10` so this cannot drift.
 */
function flyOneGameTurn(proj: Projectile, world: World): void {
  for (let tick = 0; tick < TICKS_PER_GAME_TURN; tick += 1) {
    grantEnergy(proj, energyGainPerTick(proj));
    stepProjectile(proj, world);
  }
}

describe('projectProjectiles', () => {
  it('says the sky is clear rather than saying nothing at all', () => {
    // AN EMPTY ARRAY IS A STATEMENT, and it is the one that clears a client's
    // list. `projectEffects` is silent about a world with no statuses because an
    // absent ROW means "clean"; here the absent thing is the whole list, so the
    // frame still has to be well formed when the gateway does choose to send it.
    const world = room();
    world.addPlayer('actor_a', 'Dalt');
    monster(world, 'mon_a', 5, 5);

    const msg = projectProjectiles(world);
    expect(msg.t).toBe('projectiles');
    expect(msg.projectiles).toEqual([]);
  });

  it('carries EVERY orb in the air, in the order they were fired, and nothing else', () => {
    // COMPLETENESS IS THE PROPERTY THAT MAKES THE FRAME SAFE TO DROP. A list
    // that omitted one orb would be a shot with no warning; the client replaces
    // rather than merges, so anything missing here is invisible until impact.
    const world = room();
    world.addPlayer('actor_a', 'Dalt');
    monster(world, 'mon_a', 5, 5);

    const first = fire(world, { x: 2, y: LANE_Y }, { x: 8, y: LANE_Y });
    const second = fire(world, { x: 3, y: LANE_Y - 1 }, { x: 9, y: LANE_Y - 1 });

    // INSERTION ORDER, which is `projectilesInFlight`'s guarantee and what makes
    // two replays of one seed agree about which orb is which.
    expect(projectProjectiles(world).projectiles.map((p) => p.id)).toEqual([first.id, second.id]);

    // AND NOTHING ELSE IS IN THE LIST. The world here holds a player and a
    // monster, and neither is an orb — the split that keeps `ringIdFor` from
    // ever being handed a third `ActorKind`.
    expect(projectProjectiles(world).projectiles).toHaveLength(2);

    // A DETONATED ORB IS NOT IN THE AIR. `actProjectile` drops it from the world
    // in the same step it lands, so both spellings of "gone" are tested: the
    // flag, and the removal.
    second.landed = true;
    expect(projectProjectiles(world).projectiles.map((p) => p.id)).toEqual([first.id]);

    world.removeProjectile(first.id);
    expect(projectProjectiles(world).projectiles).toEqual([]);
  });

  it('counts GAME TURNS to impact, and spends exactly projSpeed tiles a turn', () => {
    // THE NUMBER IS HOW MANY DECISIONS THE PLAYER HAS LEFT. `proj_speed` is
    // tiles per game turn exactly (Projectile.lua:304-305 into
    // GameEnergyBased.lua:125), so a six-tile shot at speed 2 opens on 3 and
    // must fall by one per turn — never by a fraction, and never in ticks.
    const world = room();
    const proj = fire(world, { x: 2, y: LANE_Y }, { x: 8, y: LANE_Y }, 2);

    const seen: { x: number; y: number; turnsToImpact: number }[] = [];
    const look = (): void => {
      const view = projectProjectiles(world).projectiles[0];
      expect(view).toBeDefined();
      if (view === undefined) return;
      expect(Number.isInteger(view.turnsToImpact)).toBe(true);
      seen.push({ x: view.x, y: view.y, turnsToImpact: view.turnsToImpact });
    };

    look();
    for (let turn = 0; turn < 3; turn += 1) {
      flyOneGameTurn(proj, world);
      look();
    }

    expect(seen).toEqual([
      // Sitting on the muzzle with six tiles to cross: ceil(6 / 2).
      { x: 2, y: LANE_Y, turnsToImpact: 3 },
      { x: 4, y: LANE_Y, turnsToImpact: 2 },
      { x: 6, y: LANE_Y, turnsToImpact: 1 },
      // On the aim tile with nothing left to cross. It takes one further act to
      // detonate — upstream's shape, and the reason 0 is a real value here.
      { x: 8, y: LANE_Y, turnsToImpact: 0 },
    ]);
  });

  it('is slower on the wire when the orb is slower in the world', () => {
    // The same six tiles at speed 1 is six turns rather than three. Pinned
    // because `turnsToImpact` reading `energyMod` (and not a constant, and not
    // the path length) is the whole reason the field can be trusted.
    const world = room();
    fire(world, { x: 2, y: LANE_Y }, { x: 8, y: LANE_Y }, 1);
    expect(projectProjectiles(world).projectiles[0]?.turnsToImpact).toBe(6);
  });

  it('aims at the tile the shot was fired at, never at the target now', () => {
    // THE COUNTERPLAY, ON THE WIRE. The line is frozen at fire
    // (ActorProject.lua:343-347 builds it once) and the orb does not re-aim, so
    // the destination a client draws must keep pointing at the tile the player
    // was standing on — including after they have stepped off it, which is the
    // exact moment the drawing matters.
    const world = room();
    const proj = fire(world, { x: 2, y: LANE_Y }, { x: 8, y: LANE_Y });

    const dodger = monster(world, 'mon_target', 8, LANE_Y);
    dodger.x = 8;
    dodger.y = LANE_Y;

    const before = projectProjectiles(world).projectiles[0];
    expect(before?.targetX).toBe(8);
    expect(before?.targetY).toBe(LANE_Y);

    // They step out of the line. The orb keeps flying at the tile they left.
    dodger.x = 8;
    dodger.y = LANE_Y - 3;
    flyOneGameTurn(proj, world);

    const after = projectProjectiles(world).projectiles[0];
    expect(after?.targetX).toBe(8);
    expect(after?.targetY).toBe(LANE_Y);
    expect(after?.x).toBe(4);
  });

  it('names the shooter, and goes on naming them after the body has fallen', () => {
    // An orb outlives its shooter — upstream holds a hard `src` reference with
    // no liveness check and still attributes the kill. `sourceId` is a STRING
    // for that reason, so nothing at impact or on the wire has to touch a body
    // that may be a corpse.
    const world = room();
    const shooter = monster(world, 'mon_a', 5, 5);
    fire(world, { x: 2, y: LANE_Y }, { x: 8, y: LANE_Y });

    expect(projectProjectiles(world).projectiles[0]?.sourceId).toBe('mon_a');
    shooter.alive = false;
    expect(projectProjectiles(world).projectiles[0]?.sourceId).toBe('mon_a');
  });

  it('puts nothing in the view that the client is not allowed to know', () => {
    // Spelled out as a key check because the failure mode is additive, exactly
    // as it is for `toActorView` and the turn card. The orb carries the FROZEN
    // DAMAGE ROLL, the armour penetration, the whole `path` it will cross and
    // four energy fields; a spread would put the shot's exact number and its
    // exact tick of arrival on the wire, and a client that knew both would never
    // need to guess whether a dodge was worth a turn.
    const world = room();
    fire(world, { x: 2, y: LANE_Y }, { x: 8, y: LANE_Y });

    const [view] = projectProjectiles(world).projectiles;
    expect(Object.keys(view ?? {}).sort()).toEqual(
      ['id', 'sourceId', 'targetX', 'targetY', 'turnsToImpact', 'x', 'y'].sort(),
    );
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
    // ═══ THE THREE REAL CLASSES HAVE FACES; NOTHING ELSE IS PROMISED ONE ═══
    //
    // `PORTRAIT_BY_CLASS` is keyed off the three sprite families in
    // content/classes.ts, which is every class `classForJoin` can hand out. A
    // body can still arrive with a sprite outside that set: `world.ts`'s
    // classless fallback rotation is six wide (three of them are art for classes
    // that do not exist), a GM command can dress a body as anything, and M6's
    // fourth class will exist as a sprite before it exists as a portrait.
    //
    // The answer must be a REAL asset key. `icon_character_the_detective` is a
    // cut portrait rather than a placeholder, and "a detective" is what the
    // fiction calls all of them anyway. A key for art that is not on disk draws
    // a violet fallback box in the middle of the most-looked-at UI in the game.
    //
    // THE SPRITE IS NAMED EXPLICITLY rather than reached by counting joins: what
    // is under test is the LOOKUP, and a test that depended on the join
    // rotation would be measuring `world.ts` instead — and would start passing
    // for the wrong reason the day that rotation changed width.
    const world = room();
    const ann = world.addPlayer('actor_a', 'Ann', { sprite: 'chr_player_watchman_s' });
    world.addPlayer('actor_b', 'Bo', { sprite: 'chr_player_inspector_s' });
    world.addPlayer('actor_c', 'Cy', { sprite: 'chr_player_alchemist_s' });
    world.addPlayer('actor_d', 'Dee', { sprite: 'chr_player_enforcer_s' });

    const msg = projectTurn(ann, world, barrier(), null);
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

// ---------------------------------------------------------------------------
// projectClassOptions — the picker
// ---------------------------------------------------------------------------

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE FIRST SCREEN A NEW PLAYER EVER SEES, AND THE ONE THAT CANNOT BE UNDONE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Two properties are load-bearing and neither is cosmetic.
 *
 *   THE ORDER IS THE AUTHORED ORDER. `ClassOptionsMsg` says on the wire that the
 *   client must not sort, so the server has to be the thing that is stable. A
 *   card that moves between two frames is a card somebody misclicks, and this
 *   choice is irreversible.
 *
 *   EVERY ASSET KEY IS ONE THAT EXISTS. client/public/assets/ is gitignored
 *   wholesale and an unresolved sprite id renders as the LOUD violet
 *   missing-asset box. ToME derives its birther icons by mangling the class name
 *   and survives a miss because it ships `unknown_32_bg.png`; this project has
 *   no such asset and cannot add one. So the prefixes below are asserted as
 *   LITERALS — a key derived from `definition.name` would fail here rather than
 *   on somebody's first evening.
 */
describe('projectClassOptions', () => {
  it('offers exactly the three authored classes, in the authored order', () => {
    const msg = projectClassOptions();

    expect(msg.t).toBe('class_options');
    expect(msg.v).toBe(PROTOCOL_VERSION);
    expect(msg.options).toHaveLength(CLASSES.length);
    // Compared against `CLASSES` rather than against three string literals: the
    // claim is "the picker's order IS the authored order", and a literal list
    // would keep passing while the two silently drifted apart.
    expect(msg.options.map((option) => option.id)).toEqual(CLASSES.map((c) => c.id));
    expect(msg.options.map((option) => option.name)).toEqual(CLASSES.map((c) => c.name));
    expect(msg.options.map((option) => option.maxHp)).toEqual(CLASSES.map((c) => c.maxHp));
    // The prose is the `ClassDef`'s, verbatim — a picker that paraphrased would
    // be a second copy of the fiction that nobody remembers to update.
    expect(msg.options.map((option) => option.description)).toEqual(
      CLASSES.map((c) => c.description),
    );
  });

  it('carries only asset keys that already exist, never a derived one', () => {
    for (const option of projectClassOptions().options) {
      // LITERAL PREFIXES. `chr_player_` and `icon_character_` are both in
      // src/client/main.ts's NEEDED_ASSET_PREFIXES; anything else is a request
      // for a file nobody cut.
      expect(option.sprite.startsWith('chr_player_')).toBe(true);
      expect(option.portrait.startsWith('icon_character_')).toBe(true);
      // ...and the sprite is the `ClassDef`'s own, not a rebuild of it.
      const definition = CLASSES.find((c) => c.id === option.id);
      expect(option.sprite).toBe(definition?.sprite);
    }
  });

  it('shows every class its own face, never the generic detective', () => {
    // `PORTRAIT_BY_CLASS` has a row per class and the projector falls back to
    // `icon_character_the_detective` for anything missing. That fallback is
    // correct for a body wearing a sprite no class authored — and WRONG on this
    // screen, where it would mean a real class shipped without a portrait.
    const portraits = projectClassOptions().options.map((option) => option.portrait);
    expect(portraits).not.toContain('icon_character_the_detective');
    expect(new Set(portraits).size).toBe(CLASSES.length);
  });

  it('shows exactly the four hotbar buttons, in hotbar order', () => {
    // Slot 1 is `talents[0]` for the whole session, and the card must advertise
    // the same four in the same order the hotbar will draw them — the icons on
    // the card are the icons on the buttons because both come from
    // `loadoutViewFor`.
    for (const option of projectClassOptions().options) {
      const definition = CLASSES.find((c) => c.id === option.id);
      expect(option.talents).toHaveLength(4);
      expect(option.talents.map((t) => t.id)).toEqual(definition?.loadout.map((t) => t.id));
      expect(option.talents.map((t) => t.name)).toEqual(definition?.loadout.map((t) => t.name));
      expect(option.talents.map((t) => t.icon)).toEqual(definition?.loadout.map((t) => t.iconId));
    }
  });

  it('reads `discrete` from RESOURCE_RULES, so a pool cannot be pips here and a bar there', () => {
    // game-design.md § 2 is emphatic that Reagents are a countable stock of 0-8
    // rather than a bar: a bar makes 3-of-8 look like 37% of something
    // continuous. If the picker decided `discrete` for itself, the Alchemist
    // would be offered pips and then handed a bar — or the reverse.
    for (const option of projectClassOptions().options) {
      const definition = CLASSES.find((c) => c.id === option.id);
      if (definition === undefined) throw new Error(`no ClassDef for ${option.id}`);
      const rule = RESOURCE_RULES[definition.resource];

      expect(option.resource.kind).toBe(definition.resource);
      expect(option.resource.discrete).toBe(rule.discrete);
      expect(option.resource.max).toBe(rule.max);
      // The pool as it will read on the first turn — Reagents full because you
      // walked in carrying eight vials, Resolve and Focus empty because nothing
      // in this game gives you a resource for existing.
      expect(option.resource.current).toBe(rule.start);
    }
  });

  it('puts nothing on a card that the picker did not ask for', () => {
    // The same key check `projectTurn` carries, and for the same reason: a
    // `ClassDef` holds the combat sheet, the AP/MP budget, the downed sprite and
    // twelve talent CLOSURES, and a spread would put the lot on the wire the day
    // somebody stops copying field by field.
    const [option] = projectClassOptions().options;
    expect(Object.keys(option ?? {}).sort()).toEqual(
      ['description', 'id', 'maxHp', 'name', 'portrait', 'resource', 'sprite', 'talents'].sort(),
    );
  });
});
