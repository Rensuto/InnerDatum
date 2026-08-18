import { describe, expect, it } from 'vitest';

import { DOWNED_TURNS, createDownedState, goDown } from '../../src/server/engine/downed.ts';
import { createEffectState, setEffect } from '../../src/server/engine/effects.ts';
import { BLEEDING, STUNNED } from '../../src/server/content/effects.ts';
import { DamageType } from '../../src/server/engine/damage.ts';
import { stepProjectile } from '../../src/server/engine/projectile.ts';
import {
  projectClassOptions,
  projectEffects,
  projectGroundItems,
  projectInventory,
  projectParty,
  projectPartyState,
  projectProjectiles,
  projectTurn,
  toActorView,
} from '../../src/server/view/projector.ts';
import { CLASSES, INSPECTOR, WATCHMAN } from '../../src/server/content/classes.ts';
import { RESOURCE_RULES } from '../../src/server/engine/talents.ts';
import { createWorld } from '../../src/server/world/world.ts';
import { AiProfile } from '../../src/server/engine/actor.ts';
import { ActorRank, MONSTERS_TURN_ID } from '../../src/shared/protocol.ts';
import { PROTOCOL_VERSION } from '../../src/shared/version.ts';
import { TICKS_PER_GAME_TURN, energyGainPerTick, grantEnergy } from '../../src/shared/energy.ts';
import { createRng } from '../../src/shared/rng.ts';
import type { Projectile } from '../../src/server/engine/projectile.ts';
import type { AwayMember, TurnState } from '../../src/server/view/projector.ts';
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
      // The pool a new detective STARTS with — Reagents full because you walked
      // in carrying eight vials, Resolve and Focus empty because a fresh sheet
      // has earned nothing yet. It is a starting line, not a ceiling: all three
      // pools trickle from the first base turn, which is why this asserts
      // `rule.start` rather than anything about the rates.
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

// ---------------------------------------------------------------------------
// v10 — projectGroundItems and projectInventory
// ---------------------------------------------------------------------------

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * TWO FRAMES THAT ARRIVED IN ONE RELEASE AND LANDED IN DIFFERENT UNIONS.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A FLOOR ITEM IS A POSITION — world state, true for everybody, broadcast. AN
 * INVENTORY IS A HOLDING — true for one person, and `CarriedItemView.compare` is
 * a delta against THAT person's own paper doll, so a shared copy would not
 * merely leak, it would be arithmetically wrong for everybody but its author.
 *
 * The three properties below are the ones a projection can get wrong silently.
 *
 *   COMPLETE AND ABSOLUTE. An emptied floor emits `[]`, never an omitted frame.
 *   A patch stream would leave a coat drawn on a tile forever, and somebody
 *   would walk the length of the map to pick up a thing that is not there.
 *
 *   ONE VIEWER'S BAG IS ONE VIEWER'S. There is no shape in `projectInventory`
 *   that can carry a second player's row, which is the same structural guarantee
 *   the three hotbar frames have.
 *
 *   `toActorView` GAINED NOTHING. Equipment stays off the broadcast actor row —
 *   protocol.ts requires every new `ActorView` field to be re-argued against
 *   "would this leak?", and buying a paper doll for other people is not worth
 *   reopening that audit.
 */

/** A Watchman body with a real class sheet, so the fold has a baseline to fold onto. */
function watchman(world: World, id = 'actor_a', name = 'Dalt') {
  return world.addPlayer(id, name, {
    sprite: WATCHMAN.sprite,
    maxHp: WATCHMAN.maxHp,
    hpRegen: WATCHMAN.hpRegen,
    combat: WATCHMAN.combat,
    classId: WATCHMAN.id,
  });
}

describe('projectGroundItems', () => {
  it('says the floor is clear rather than saying nothing at all', () => {
    // AN EMPTY ARRAY IS A STATEMENT, and it is the one that takes the last
    // marker off a client's map. The gateway's memo is seeded with this exact
    // value so a server on which nothing has been dropped never SENDS it — but a
    // floor that EMPTIES must, and it cannot if the frame is not well formed
    // when there is nothing to say.
    const world = room();
    watchman(world);

    const msg = projectGroundItems(world);
    expect(msg.t).toBe('ground');
    expect(msg.items).toEqual([]);
  });

  it('carries every item on the floor, in the world own insertion order', () => {
    // INSERTION ORDER IS THE PICKUP ORDER. `itemsAt` filters this same table and
    // world.ts:516-522 states the contract: PICKUP TAKES INDEX 0. Sorting here
    // would make the top of the pile mean one thing to the client's prompt and
    // another to the server's handler.
    const world = room();
    const first = world.addGroundItem({ x: 4, y: 4 }, 'item_watchmans_cap');
    const second = world.addGroundItem({ x: 4, y: 4 }, 'item_watchmans_coat');
    const elsewhere = world.addGroundItem({ x: 9, y: 2 }, 'item_watchmans_boots');

    const items = projectGroundItems(world).items;
    expect(items.map((row) => row.id)).toEqual([first, second, elsewhere]);
    // THE WORLD'S id AND THE CATALOGUE'S id ARE NOT THE SAME KIND OF THING. Two
    // identical caps on one tile are two rows with two `id`s and one `itemId`; a
    // client that keyed on `itemId` would draw one marker and be one short
    // forever.
    expect(items[0]?.itemId).toBe('item_watchmans_cap');
    expect(items[0]?.cell).toEqual([4, 4]);
    // TIER COMES OFF THE CATALOGUE, never inferred by the client — it is what
    // colours the floor marker, and a browser guessing at rarity would be a
    // second copy of authored content.
    expect(items[0]?.tier).toBe('uncommon');
    expect(items[1]?.tier).toBe('rare');
  });

  it('is COMPLETE AND ABSOLUTE: an emptied floor emits [], not an omitted frame', () => {
    // THE PROPERTY THAT MAKES THE FRAME SAFE TO DROP. The client replaces rather
    // than merges, so the only way an item can leave a screen is a frame that
    // does not list it. There is deliberately no "taken" message and there must
    // never be one — see `projectGroundItems`, and `ProjectilesMsg`'s
    // phantom-orb argument, of which this is the longer-lived version.
    const world = room();
    const dropped = world.addGroundItem({ x: 4, y: 4 }, 'item_watchmans_cap');
    expect(projectGroundItems(world).items).toHaveLength(1);

    world.removeGroundItem(dropped);
    const after = projectGroundItems(world);
    expect(after.t).toBe('ground');
    expect(after.items).toEqual([]);
  });

  it('skips an id the catalogue no longer knows rather than drawing a violet box', () => {
    // A content reload that deleted an authored item out from under a live
    // floor. `tier` comes off the catalogue and there is nothing honest to
    // colour a marker with, so the row is dropped — and the OTHER items on the
    // floor are unaffected, which is the half that matters: one bad id must not
    // cost the party the rest of the pile.
    const world = room();
    world.addGroundItem({ x: 4, y: 4 }, 'item_that_was_deleted');
    world.addGroundItem({ x: 4, y: 4 }, 'item_watchmans_cap');

    const items = projectGroundItems(world).items;
    expect(items.map((row) => row.itemId)).toEqual(['item_watchmans_cap']);
  });

  it('puts nothing in the view that the client is not allowed to know', () => {
    // THE `wielder` TABLE IS THE FIELD THIS KEY CHECK EXISTS FOR. An item's
    // contribution is engine data, and a client holding it could work out what
    // equipping the thing would do — which is precisely the arithmetic
    // `CarriedItemView.compare` exists to have already done, on the server,
    // against the recipient's own doll.
    const world = room();
    world.addGroundItem({ x: 4, y: 4 }, 'item_watchmans_cap');

    const [row] = projectGroundItems(world).items;
    expect(Object.keys(row ?? {}).sort()).toEqual(['cell', 'id', 'itemId', 'tier'].sort());
  });
});

describe('projectInventory', () => {
  it('carries an empty bag and an empty doll for a body that owns nothing', () => {
    const world = room();
    const msg = projectInventory(watchman(world));
    expect(msg.t).toBe('inventory');
    expect(msg.carried).toEqual([]);
    expect(msg.equipped).toEqual({});
  });

  it('walks the doll in SLOT_ORDER, never in the order things were equipped', () => {
    // A JSON object preserves insertion order, so without this the same two
    // items would serialise differently for two players who put them on in
    // different orders — and `equipped` is a `Partial<Record<Slot, string>>`
    // built by a player pressing buttons. SLOT_ORDER is the gear FOLD's order
    // (content/items.ts), reused so the panel and the fold cannot disagree.
    const world = room();
    const body = watchman(world);
    // Deliberately the reverse of SLOT_ORDER's head/body/legs/feet.
    body.equipped = { feet: 'item_watchmans_boots', body: 'item_watchmans_coat' };

    expect(Object.keys(projectInventory(body).equipped)).toEqual(['body', 'feet']);
  });

  it('skips an unknown id and a wrong-slot entry, exactly as the fold does', () => {
    // REPAIR, NEVER REJECT — and the same repairs `wornOf` makes, so the panel
    // and the combat sheet cannot disagree about what is being worn. Both are
    // reachable from a save written by a build that authored an item this one
    // does not.
    const world = room();
    const body = watchman(world);
    body.equipped = {
      head: 'item_that_was_deleted',
      // A body item filed under the legs slot.
      legs: 'item_watchmans_coat',
      feet: 'item_watchmans_boots',
    };
    body.carried = ['item_watchmans_cap', 'item_that_was_deleted'];

    const msg = projectInventory(body);
    expect(Object.keys(msg.equipped)).toEqual(['feet']);
    expect(msg.carried.map((row) => row.itemId)).toEqual(['item_watchmans_cap']);
  });

  it('names the slot on a carried row and NOT on a worn one', () => {
    // In `equipped` the map KEY is the slot, so a `slot` field in the value
    // would be a second copy of the same fact that can disagree with the first.
    // A bag has no key to read it off, so `CarriedItemView` names it.
    const world = room();
    const body = watchman(world);
    body.equipped = { feet: 'item_watchmans_boots' };
    body.carried = ['item_watchmans_cap'];

    const msg = projectInventory(body);
    expect(Object.keys(msg.equipped['feet'] ?? {}).sort()).toEqual(
      ['desc', 'icon', 'itemId', 'name', 'tier'].sort(),
    );
    expect(Object.keys(msg.carried[0] ?? {}).sort()).toEqual(
      ['compare', 'desc', 'icon', 'itemId', 'name', 'slot', 'tier'].sort(),
    );
    expect(msg.carried[0]?.slot).toBe('head');
  });

  it('compares against an EMPTY slot as the item full contribution', () => {
    // The Watchman's cap is `{ mods: { armour: 3 } }` and the Watchman's base
    // armour is 6, so a bare body reads +3 — the threshold piece that clears the
    // husk's apr 7. The row is the delta between the two numbers the CHARACTER
    // SHEET prints, which is why it is rounded before subtracting.
    const world = room();
    const body = watchman(world);
    body.carried = ['item_watchmans_cap'];

    const rows = projectInventory(body).carried[0]?.compare ?? [];
    expect(rows).toContainEqual({ label: 'Armour', value: '+3' });
  });

  it('compares against an OCCUPIED slot as the DIFFERENCE, and it may be negative', () => {
    // ═══════════════════════════════════════════════════════════════════════
    // THIS IS THE WHOLE REASON `compare` IS COMPUTED ON THE SERVER.
    // ═══════════════════════════════════════════════════════════════════════
    // Ported in spirit from ShowEquipInven.lua:54's `compare_with`, which
    // forwards to `compare_fields(..., "combat_armor", "%+d", "Armour: ")` at
    // Object.lua:1285-1287 — a label and a signed number.
    //
    // A SWAP, NOT AN ADDITION: the Leather Chestpiece (+3 armour, +1 defence) is
    // a DOWNGRADE for somebody already wearing the Watchman's Coat (+4 armour,
    // +10 hardiness), and the panel has to say so rather than advertising the
    // item's own contribution as if the slot were free.
    const world = room();
    const body = watchman(world);
    body.equipped = { body: 'item_watchmans_coat' };
    body.carried = ['item_leather_chest'];

    const rows = projectInventory(body).carried[0]?.compare ?? [];
    expect(rows).toContainEqual({ label: 'Armour', value: '-1' });
    // HARDINESS IS ON THE COMPARISON TABLE AND NOT ON THE INSPECT SHEET, and
    // this is why: it is the Watchman's coat's headline contribution, and an
    // item whose headline had no row would read as an item that does nothing.
    expect(rows).toContainEqual({ label: 'Hardiness', value: '-10%' });
  });

  it('measures the Damage row as the SHEET measures it — a truncated band, not a rounded scalar', () => {
    // ═══════════════════════════════════════════════════════════════════════
    // THE REGRESSION THIS PINS: THE BIGGEST OFFENSIVE ITEM IN THE GAME READ AS
    // INERT.
    // ═══════════════════════════════════════════════════════════════════════
    // The Inspector's Dossier is `{ mods: { dam: 4 } }` — her own class offhand
    // and her ONLY offensive piece. It takes her damage 11.542 -> 12.430, which
    // the character sheet prints as the band 11–13 -> 12–14: a full point on
    // BOTH ends. Measured with `Math.round` on the scalar (as the other nine
    // rows are, and as this row used to be) it is `12 - 12 = 0`, no row is
    // emitted, and `compare` comes back EMPTY — which
    // `CarriedItemView.compare` defines as "this changes nothing you can see"
    // and ui/inventory.ts draws as a blank strip. The screen whose entire job
    // is "should I put this on?" reported it as doing nothing.
    const world = room();
    const body = world.addPlayer('actor_i', 'Ren', {
      sprite: INSPECTOR.sprite,
      maxHp: INSPECTOR.maxHp,
      hpRegen: INSPECTOR.hpRegen,
      combat: INSPECTOR.combat,
      classId: INSPECTOR.id,
    });
    body.carried = ['item_inspectors_dossier'];

    const rows = projectInventory(body).carried[0]?.compare ?? [];
    expect(rows).toContainEqual({ label: 'Damage', value: '+1' });
    // AND IT STAYS IN SHEET ORDER. The special case is applied in place in
    // `COMPARE_ROWS`, not appended, so Damage cannot drift to the bottom.
    expect(rows.map((row) => row.label)).toEqual(['Damage']);
  });

  it('says NOTHING at all when the swap moves no number a player can see', () => {
    // AN EMPTY LIST IS A REAL ANSWER — two items that do the same thing compare
    // to nothing. Drawing that as a blank row is the correct rendering;
    // inventing a "no change" line is not the projection's job.
    const world = room();
    const body = watchman(world);
    body.equipped = { head: 'item_watchmans_cap' };
    body.carried = ['item_watchmans_cap'];
    // The same item in the slot and in the bag: the fold either way is identical.
    expect(projectInventory(body).carried[0]?.compare).toEqual([]);
  });

  it('describes ONE viewer and has no shape that could carry a second', () => {
    // The structural half of the privacy guarantee, and it is the same one the
    // three hotbar frames have: the function takes an ACTOR, so there is nowhere
    // in the returned frame for somebody else's row to go even if a caller
    // wanted to put one there. `InventoryMsg` being a `ViewerMsg` is the other
    // half — `broadcast(projectInventory(...))` does not compile.
    const world = room();
    const dalt = watchman(world, 'actor_a', 'Dalt');
    const ren = watchman(world, 'actor_b', 'Ren');
    dalt.carried = ['item_watchmans_cap'];

    expect(projectInventory(dalt).carried).toHaveLength(1);
    expect(projectInventory(ren).carried).toEqual([]);
    expect(projectInventory(ren).equipped).toEqual({});
  });

  it('compares against nothing at all for a body with no combat sheet', () => {
    // An M2-era fixture or a classless e2e body. An invented baseline would be a
    // promise about numbers that body does not have, so the honest answer is an
    // empty comparison — the item is still listed, still named, still drawable.
    const world = room();
    const bare = world.addPlayer('actor_bare', 'Nobody');
    bare.baseCombat = undefined;
    bare.combat = undefined;
    bare.carried = ['item_watchmans_cap'];

    const row = projectInventory(bare).carried[0];
    expect(row?.itemId).toBe('item_watchmans_cap');
    expect(row?.compare).toEqual([]);
  });
});

describe('toActorView', () => {
  it('gained NO field when equipment landed — the paper doll stays off the wire', () => {
    // ═══════════════════════════════════════════════════════════════════════
    // `ActorView` IS BROADCAST. EVERY FIELD ON IT IS A FACT ABOUT SOMEBODY THAT
    // EVERYONE ELSE IS TOLD, FOREVER.
    // ═══════════════════════════════════════════════════════════════════════
    // protocol.ts requires every new `ActorView` field to be re-argued against
    // "would this leak?", and buying a paper-doll-for-other-people is not worth
    // reopening that audit: the party already sees what somebody's gear DOES,
    // through the hp bar and through `inspect`. This key check is what makes the
    // decision hold — an `equipped` field added here would fail on this line
    // rather than on somebody's first evening.
    const world = room();
    const body = watchman(world);
    body.equipped = { body: 'item_watchmans_coat' };
    body.carried = ['item_watchmans_cap'];

    expect(Object.keys(toActorView(body)).sort()).toEqual(
      ['alive', 'hp', 'id', 'kind', 'maxHp', 'name', 'rank', 'sprite', 'x', 'y'].sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// projectPartyState — the bug reported from play
// ---------------------------------------------------------------------------

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * "IT SEEMS TO REMOVE THEM FROM PARTY WHEN THE COMBAT STARTS."
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * It never did. `projectPartyState` walked ONE WORLD and skipped any roster
 * member whose body it could not find there — so the instant somebody crossed
 * into an instance, their row vanished from everyone else's pane. From the
 * chair that is indistinguishable from being thrown out of the party, and it
 * was reported as exactly that.
 *
 * The distinction this file has to keep is the one the old code collapsed:
 *
 *   NO BODY ANYWHERE      → drop the row. They have left the game, and a party
 *                           row naming somebody who is not playing is the
 *                           opposite mistake. This case was always right.
 *   A BODY IN ANOTHER     → KEEP the row, name the place, and offer the door.
 *   REALM                   This is the case that reached play.
 */
describe('projectPartyState keeps a member who is somewhere else', () => {
  const roster = { leaderId: 'p1', members: ['p1', 'p2'] };

  function scene(): {
    here: ReturnType<typeof createWorld>;
    there: ReturnType<typeof createWorld>;
  } {
    const here = createWorld('pane-here');
    const there = createWorld('pane-there');
    here.addPlayer('p1', 'Ren');
    there.addPlayer('p2', 'Vell');
    return { here, there };
  }

  it('DROPS a member with no body anywhere — that case was always right', () => {
    const { here } = scene();
    const viewer = here.getActor('p1');
    if (viewer === undefined) throw new Error('unreachable');

    const msg = projectPartyState(viewer, here, roster, barrier(), null);
    expect(msg.members.map((m) => m.id)).toEqual(['p1']);
  });

  it('KEEPS a member who is in another realm, and names the place', () => {
    // THE REGRESSION. Before the fix this returned ['p1'] and the second row
    // was simply gone.
    const { here, there } = scene();
    const viewer = here.getActor('p1');
    const body = there.getActor('p2');
    if (viewer === undefined || body === undefined) throw new Error('unreachable');

    const away = new Map<string, AwayMember>([
      ['p2', { actor: body, place: 'An Index Breach', canFollow: true }],
    ]);
    const msg = projectPartyState(viewer, here, roster, barrier(), null, [], away);

    expect(msg.members.map((m) => m.id)).toEqual(['p1', 'p2']);
    const them = msg.members.find((m) => m.id === 'p2');
    expect(them?.away).toEqual({ place: 'An Index Breach', canFollow: true });
    expect(them?.name).toBe('Vell');
    // AND THEIR HP IS LIVE, off their real body in the realm they are actually
    // in — not a stale copy and not a zero. The pane's whole job during a fight
    // you cannot see is to say how it is going.
    expect(them?.hp).toBe(body.hp);
    expect(them?.maxHp).toBe(body.maxHp);
  });

  it('says a member on your own floor is not away', () => {
    const here = createWorld('pane-together');
    here.addPlayer('p1', 'Ren');
    here.addPlayer('p2', 'Vell');
    const viewer = here.getActor('p1');
    if (viewer === undefined) throw new Error('unreachable');

    const msg = projectPartyState(viewer, here, roster, barrier(), null);
    expect(msg.members.map((m) => m.away)).toEqual([null, null]);
  });

  it('offers no door to a viewer who cannot walk through one', () => {
    // `canFollow` is per VIEWER and the gateway decides it — a body on the
    // floor is being carried, not walking. Drawing a control whose only
    // possible outcome is a refusal is worse than drawing none.
    const { here, there } = scene();
    const viewer = here.getActor('p1');
    const body = there.getActor('p2');
    if (viewer === undefined || body === undefined) throw new Error('unreachable');

    const away = new Map<string, AwayMember>([
      ['p2', { actor: body, place: 'An Index Breach', canFollow: false }],
    ]);
    const msg = projectPartyState(viewer, here, roster, barrier(), null, [], away);
    expect(msg.members.find((m) => m.id === 'p2')?.away?.canFollow).toBe(false);
  });
});
