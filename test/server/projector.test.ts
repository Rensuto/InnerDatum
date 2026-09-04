import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { projectLoadout, projectResource } from '../../src/server/view/projector.ts';
import { ResourceKind } from '../../src/shared/protocol.ts';
import type { LoadoutTalent } from '../../src/shared/protocol.ts';

import { DOWNED_TURNS, createDownedState, goDown } from '../../src/server/engine/downed.ts';
import { createEffectState, setEffect } from '../../src/server/engine/effects.ts';
import { BLEEDING, STUNNED } from '../../src/server/content/effects.ts';
import { moneyIdFor } from '../../src/server/content/money.ts';
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
  projectShop,
  projectTurn,
  toActorView,
} from '../../src/server/view/projector.ts';
import { CLASSES, INSPECTOR, WATCHMAN } from '../../src/server/content/classes.ts';
import { recomposeCombat } from '../../src/server/engine/effects.ts';
import { composeWielders } from '../../src/server/engine/equipment.ts';
import { combatPhysicalpower } from '../../src/server/engine/derived.ts';
import { statGainLines } from '../../src/server/view/projector.ts';
import { combatAttack } from '../../src/server/engine/derived.ts';
import { resolveItem } from '../../src/server/content/resolve.ts';
import type { EngineActor } from '../../src/server/engine/actor.ts';
import type { Combatant } from '../../src/server/engine/derived.ts';
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
        // THE FALLBACK GLYPH, drawn when that PNG is not on disk. It rides on the
        // frame because only the SERVER sees every effect in the game and can
        // promise the letters are distinct -- the client receives only the ones
        // on the bodies in front of it, and 'Stunned' and 'Slowed' share an
        // initial. See EffectView.badge.
        badge: 'St',
        // WHAT IT DOES, authored on the definition. It was dead data until
        // `EffectView.desc` existed — the sentence was written, specific and
        // good, and no screen in the game could reach it. See the field.
        desc: STUNNED.description,
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
      ['badge', 'desc', 'harmful', 'icon', 'id', 'name', 'turns'].sort(),
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

  it('shows exactly the six hotbar buttons, in hotbar order', () => {
    // Slot 1 is `talents[0]` for the whole session, and the card must advertise
    // the same four in the same order the hotbar will draw them — the icons on
    // the card are the icons on the buttons because both come from
    // `loadoutViewFor`.
    for (const option of projectClassOptions().options) {
      const definition = CLASSES.find((c) => c.id === option.id);
      // AS MANY AS THE CLASS OWNS, which is the property — the card advertises
      // the class's actives, whatever there are of them. This read `6` and the
      // Watchman's third tree failed it at 9 with nothing wrong; the next line
      // already asserts the exact list, so the count was only ever restating it.
      expect(option.talents).toHaveLength(definition?.loadout.length ?? 0);
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
    /**
     * ═══ `name` IS ON THIS LIST AND `wielder` NEVER WILL BE ═══
     *
     * The distinction this guard is really drawing is not "few fields" but
     * "nothing the client could COMPUTE WITH". A display string is the former:
     * it is what the shop shelf and the bag already show for the same item, from
     * the same `resolveItem(...).name`, and knowing a coat is called a coat
     * tells a player nothing about what wearing it would do.
     *
     * The `wielder` table is the latter, and is the field this test was written
     * for: it is the arithmetic `CarriedItemView.compare` exists to have already
     * done on the server against the recipient's own doll.
     *
     * The name was added so the floor can be READ without walking onto it —
     * a pickup costs a turn, so "walk over and find out" is a real price for a
     * question the frame can answer for free.
     *
     * ═══ `desc` AND `slot` JOIN `name` ON THE FORMER SIDE ═══
     * Both are display strings the bag and the shelf already show for the same
     * item, out of the same `resolveItem`. Neither is something to compute with:
     * knowing a coat is worn on the body, and reading the sentence written about
     * it, tells a player exactly as much as knowing it is called a coat.
     *
     * ═══ AND `compare` IS THE ANSWER, WHICH IS WHY IT IS NOT THE ARITHMETIC ═══
     * It is absent here because this call passes no viewer — a comparison is a
     * fact about a BODY. When one is passed, the rows are the SAME finished rows
     * `CarriedItemView.compare` carries, reduced by `compareRows` on the server
     * against that viewer's own doll. That is not a relaxation of this guard, it
     * is the thing the paragraph above says compare "exists to have already
     * done". `wielder` is still the forbidden field and still never sent — the
     * test below the next one asserts exactly that.
     */
    expect(Object.keys(row ?? {}).sort()).toEqual(
      ['cell', 'fromCatalogue', 'id', 'itemId', 'name', 'slot', 'tier'].sort(),
    );
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

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * WHAT A WORN ITEM IS GIVING YOU, FOR AN ITEM THAT CAME OUT OF THE LOOT ROLL.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * The doll asks `compareRows(base, worn WITHOUT this item, this item)` so the
   * swap it computes is the item against nothing. Removing "this item" from the
   * worn set was written as `other !== item` — REFERENCE equality — and
   * `resolveItem` only returns a shared frozen object for a PLAIN id: an ego or
   * a raised material builds a fresh object per call (resolve.ts:406). So for
   * every rolled item the filter removed nothing, `before` still contained it,
   * every delta measured zero and the doll sent an EMPTY row list.
   *
   * ═══ WHICH IS WHY NOBODY SAW IT ═══
   * Every fixture in this file wears catalogue items — `item_watchmans_boots`,
   * `item_watchmans_coat` — and those DO come back as the same frozen object, so
   * the identity check held and the stats appeared. The bug was invisible to
   * every test and visible on every rare item a player actually finds.
   *
   * The two cases are asserted TOGETHER on purpose: the plain one is the control
   * that was always passing, and without it a future regression that emptied
   * both would still fail this test for the wrong reason.
   */
  it('tells a worn EGO item what it is giving you, not only a plain one', () => {
    const world = room();
    const body = watchman(world);
    body.equipped = { body: 'item_leather_chest~rf1' };

    const rolled = projectInventory(body).equipped['body'];
    expect(rolled?.name, 'the fixture really is a rolled item').toContain('Reinforced');
    expect(
      rolled?.compare.length,
      'a worn rolled item reported no stats at all — resolve.ts:406 hands back a NEW object',
    ).toBeGreaterThan(0);

    body.equipped = { body: 'item_leather_chest' };
    const plain = projectInventory(body).equipped['body'];
    expect(plain?.compare.length, 'the control that was always passing').toBeGreaterThan(0);
  });

  /**
   * AND IT IS THE ITEM'S OWN CONTRIBUTION, not a comparison against itself.
   * Asserted by SIGN rather than by a pinned number: armour from a chestpiece is
   * a gain, and a body wearing it compared against itself would measure zero —
   * which is precisely the state this pair of tests exists to refuse.
   */
  it('measures a worn item against an empty slot, so the numbers are positive', () => {
    const world = room();
    const body = watchman(world);
    body.equipped = { body: 'item_leather_chest~rf1' };

    const rows = projectInventory(body).equipped['body']?.compare ?? [];
    // NOT VACUOUS: `[].every()` is true, so the length assertion is what stops
    // this passing against the very emptiness the test above is about.
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.value !== '' && row.value !== '0')).toBe(true);
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
    // `compare` IS ON BOTH SIDES NOW and `slot` is still on one — which is the
    // claim this test is making. A worn item's key IS its slot; what it is
    // GIVING you is a fact neither side can read off a key.
    expect(Object.keys(msg.equipped['feet'] ?? {}).sort()).toEqual(
      ['compare', 'icon', 'itemId', 'name', 'tier'].sort(),
    );
    expect(Object.keys(msg.carried[0] ?? {}).sort()).toEqual(
      ['compare', 'icon', 'itemId', 'name', 'slot', 'tier'].sort(),
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

    /**
     * ═══════════════════════════════════════════════════════════════════════
     * BOTH NUMBERS NOW — "+3 (-1)" — AND THE FIRST ONE IS WHY.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `compareFields` (Object.lua:648-670) prints the ITEM'S OWN value first and
     * only then the difference. This row used to be `-1` alone, and a lone
     * difference is ambiguous in exactly the case that matters: a coat giving 20
     * fire resist over one giving 15 reads `+5%`, which is the same line a coat
     * giving 5 over an empty slot draws.
     *
     * So the Leather Chestpiece says `+3` — what it is worth — and `(-1)` — what
     * swapping costs. It is still a downgrade and the panel still says so; the
     * player can now also see that it is a real coat rather than a bad one.
     */
    const rows = projectInventory(body).carried[0]?.compare ?? [];
    expect(rows).toContainEqual({ label: 'Armour', value: '+3 (-1)' });
    // HARDINESS IS ON THE COMPARISON TABLE AND NOT ON THE INSPECT SHEET, and
    // this is why: it is the Watchman's coat's headline contribution, and an
    // item whose headline had no row would read as an item that does nothing.
    // `0% (-10%)` — the Chestpiece grants no hardiness at all, and taking the
    // coat off costs ten. `signed(0)` is "0" rather than "+0", which is right:
    // there is nothing to sign.
    expect(rows).toContainEqual({ label: 'Hardiness', value: '0% (-10%)' });
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

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE HAND-WRITTEN COPY DROPS OPTIONAL FIELDS, SILENTLY, AND DID
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `toLoadoutTalent` rebuilds a `LoadoutTalent` field by field rather than
 * spreading it, and its own comment explains why that is safe: *"the compiler
 * catches the omission because every one of these is REQUIRED on the wire
 * type"*.
 *
 * That is true, and it is exactly why three fields got through. `tree`,
 * `treeName` and `kind` were added as OPTIONAL — additive, so no protocol bump —
 * which made omitting them legal. Measured from a socket afterwards: the server
 * set them, the client grouped on them, and every frame arrived with
 * `tree: undefined`. The feature was correct at both ends and deleted in the
 * middle, and nothing failed.
 *
 * A KEY-SET COMPARISON IS THE ONLY GUARD THAT WORKS for a field the type system
 * has agreed to treat as skippable. It is deliberately not a list of field names
 * — that would be a third copy to keep in step with the other two.
 */
describe('the loadout projection loses no field', () => {
  it('carries every key it was given, optional ones included', () => {
    /**
     * ═══ `Required<...>`, AND THAT IS THE WHOLE GUARD ═══
     * This fixture was a plain `LoadoutTalent`, so every OPTIONAL field was
     * optional here too — and `locked` and `lockedReason` were added to the wire
     * type, set by the server, dropped by the projector, and never added to this
     * object. The key-set comparison below then compared a short list against a
     * short list and passed for months while the tier gate never reached a
     * client.
     *
     * `Required` makes omitting a field a COMPILE error, which is the only kind
     * of reminder that survives someone who has never read this file. The
     * docblock above says a list of field names would be "a third copy to keep
     * in step"; this object WAS that copy. Now the compiler keeps it.
     */
    const full: Required<LoadoutTalent> = {
      id: 'talent:standing_orders',
      name: 'Standing Orders',
      icon: 'icon_passive_standing_orders',
      cost: { ap: 0, mp: 0, resource: 0 },
      cooldownTurns: 0,
      range: 0,
      minRange: 0,
      shape: 'self',
      radius: 0,
      level: 1,
      maxLevel: 5,
      // The respec window's answer. Server-computed, absent means no — see
      // `LoadoutTalent.unlearnable`.
      unlearnable: false,
      desc: 'Always on.',
      descNext: null,
      tree: 'watch/the-line',
      treeName: 'The Line',
      // FALSE, NOT OMITTED, and the `Required` above is why: this fixture's job
      // is to carry every key the wire type has, so the key-set comparison
      // below can prove the projector drops none of them. `watch/the-line` is a
      // drawn category — a hidden one would be `true` and would still have to
      // survive the trip. See `TalentTree.hidden`.
      hidden: false,
      kind: 'passive',
      mastery: 1.3,
      sustained: false,
      locked: true,
      lockedReason: 'Learn 2 more of this discipline first.',
      // EVERY REQUIREMENT OF THE NEXT RANK, met or not — `LoadoutTalent.requires`.
      // It is here because this fixture is the compile-time reminder that a field
      // added to the wire has to survive the projector; `locked` was added, dropped
      // and unnoticed for months before that was made a compile error.
      scales: 'damage from your weapon (Strength); lands on Mindpower (Willpower, Cunning)',
      requires: [{ text: 'level 4', met: true }],
    };

    const projected = projectLoadout({ id: 'a' } as never, [full]).talents[0];
    expect(projected).toBeDefined();
    if (projected === undefined) return;

    expect(Object.keys(projected).sort()).toEqual(Object.keys(full).sort());
    // …and the VALUES survive, not just the keys — a copy that named the field
    // and then wrote a default would pass the check above.
    expect(projected.tree).toBe(full.tree);
    expect(projected.treeName).toBe(full.treeName);
    expect(projected.kind).toBe(full.kind);
    expect(projected.mastery).toBe(full.mastery);
    // THE TIER GATE, which is the pair that was actually missing. A panel that
    // never receives these draws a live `+` on a tier-4 capstone for a level-1
    // character and lets the server do the refusing.
    expect(projected.locked).toBe(full.locked);
    expect(projected.lockedReason).toBe(full.lockedReason);
    expect(projected.sustained).toBe(full.sustained);
  });

  it('emits no passives array for a class that has none', () => {
    // `LoadoutMsg.passives` is optional, so a class without any must produce the
    // frame it always produced rather than one carrying a new empty field.
    const frame = projectLoadout({ id: 'a' } as never, []);
    expect(Object.keys(frame)).not.toContain('passives');
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *   THE SEAM THAT HAS NOW DROPPED A FIELD TWICE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `projectResource` rebuilds its payload FIELD BY FIELD, deliberately — its own
 * comment argues the explicit copy is what makes it "the ONE place that decides
 * what a viewer is told about their own budgets", and that a spread "would
 * forward whatever a future `ResourceView` happens to gain, which is how a
 * server-only field ends up on a wire nobody audited". That reasoning is right
 * and the copy should stay.
 *
 * It also states the cost in advance: *"a new field is two edits, and the second
 * one is easy to forget. A live probe is what catches it."*
 *
 * IT HAS NOW BEEN FORGOTTEN TWICE. `ap` was added to `ResourceView` and to
 * `toResourceView` and reached no socket at all. Then `mp` was added the same
 * way, and a live probe printed `{"ap":6,"maxAp":6}` with no MP in it — for a
 * HUD whose whole job is to say whether the round can continue.
 *
 * So this is the audit the comment asks for, done by a test instead of by hand:
 * every optional budget field a `ResourceView` carries must come out the other
 * side. It does not forbid the explicit copy — it just refuses to let one be
 * silently dropped a third time.
 */
describe('the viewer gets every budget the server knows about', () => {
  const VIEWER = { id: 'actor_a' } as unknown as Parameters<typeof projectResource>[0];

  it('forwards ap, maxAp, mp and maxMp', () => {
    const frame = projectResource(VIEWER, {
      kind: ResourceKind.Resolve,
      current: 40,
      max: 100,
      discrete: false,
      ap: 4,
      maxAp: 6,
      mp: 2,
      maxMp: 3,
    });
    expect(frame).not.toBeNull();
    // ═══ THE ASSERTION THAT WAS FAILING ═══
    // Before the second edit: mp and maxMp were simply absent from the frame.
    expect(frame?.resource.ap).toBe(4);
    expect(frame?.resource.maxAp).toBe(6);
    expect(frame?.resource.mp).toBe(2);
    expect(frame?.resource.maxMp).toBe(3);
  });

  it('drops every budget key when the server has nothing to say', () => {
    /**
     * THE HALF THAT MUST NOT MOVE. The fields are optional so that adding them
     * forced no protocol bump, which means a client can outlive a server that
     * never sends them — and `ResourceView.ap` says absent must mean "an older
     * server", never "a budget of zero". Emitting `ap: 0` would tell a player
     * their round is spent when nobody has said anything about it.
     */
    const frame = projectResource(VIEWER, {
      kind: ResourceKind.Resolve,
      current: 40,
      max: 100,
      discrete: false,
    });
    const keys = Object.keys(frame?.resource ?? {});
    expect(keys).not.toContain('ap');
    expect(keys).not.toContain('maxAp');
    expect(keys).not.toContain('mp');
    expect(keys).not.toContain('maxMp');
  });

  it('carries the whole of ResourceView, so a third field cannot be dropped', () => {
    /**
     * THE GUARD THAT GENERALISES. The two tests above name four fields; this one
     * names none. It builds a view with every optional budget key set to a
     * distinguishable value and asserts each one survives — so the next field
     * added to `ResourceView` fails here rather than on somebody's screen.
     */
    const view = {
      kind: ResourceKind.Resolve,
      current: 40,
      max: 100,
      discrete: false,
      ap: 4,
      maxAp: 6,
      mp: 2,
      maxMp: 3,
    };
    const out = projectResource(VIEWER, view)?.resource ?? {};
    for (const [key, value] of Object.entries(view)) {
      expect(out[key as keyof typeof out], `projectResource dropped ${key}`).toBe(value);
    }
  });
});

describe('what an item is worth, wherever it appears', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * `compare` LIVED ON `CarriedItemView` ALONE, SO THE DOLL COULD NOT ANSWER
   * THE QUESTION THE PANEL OPENS ON.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * A worn item reached the client as a name, a tier and one line of flavour.
   * `ShowEquipment.lua:89` renders the full description for the selected worn
   * item; ours rendered a sentence. It is on `ItemView` now, filled by the same
   * `compareRows` the bag uses with the candidate on the other side of the swap.
   */
  it('tells a worn item what it is giving this body', () => {
    const world = room();
    const body = watchman(world);
    // BOOTS ARE THE RIGHT FIXTURE: `wielder.mods.def = 2`, and the catalogue
    // says why — "+2 armour would be exactly zero against all three of them",
    // so a piece chosen for armour could measure as no change and pass a weaker
    // version of this test.
    body.equipped = { feet: 'item_watchmans_boots' };

    const worn = projectInventory(body).equipped['feet'];
    expect(worn).toBeDefined();
    expect(worn?.compare.length, 'the doll used to be handed an empty list').toBeGreaterThan(0);
    expect(worn?.compare.some((row) => row.label.toLowerCase().includes('def'))).toBe(true);
  });

  it('shows the four PER-TYPE channels a swap moves, which no scalar row can', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * `COMPARE_ROWS` HOLDS `(c) => number`, AND FOUR CHANNELS ARE NOT NUMBERS.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * Its Crit. power entry says *"Every other channel gear can move has been
     * on this table since it was written"*, and that was true on the day it was
     * written. `resists`, `immunities`, `increase` and `penetration` have landed
     * since, with eight egos between them, and every one is a number PER DAMAGE
     * TYPE — so none could be a row and none appeared. A coat that made you
     * proof against fire compared identically to one that did not.
     *
     * ROLLED THROUGH THE REAL RESOLVER rather than hand-built, so this measures
     * what a player would actually pick up.
     */
    const world = room();
    const body = watchman(world);
    const fireproof = resolveItem('item_watchmans_coat~kl3');
    expect(fireproof?.wielder?.resists, 'the ego stopped granting fire resist').toBeDefined();

    const bag = projectInventory(
      Object.assign(body, { carried: ['item_watchmans_coat~kl3'] }),
    ).carried;
    expect(bag.length, 'the coat never reached the bag view').toBe(1);
    const rows = bag[0]?.compare;
    expect(rows, 'the bag row carries no comparison').toBeDefined();
    expect(
      rows?.some((row) => row.label === 'Fire resist'),
      `no fire-resist row: ${JSON.stringify(rows)}`,
    ).toBe(true);
  });

  it('names those channels EXACTLY as the character card names them', () => {
    /**
     * Two surfaces describing one quantity must use one label. The Crit. power
     * note makes this argument about units — *"the getter carries a 1.5
     * multiplier and the two surfaces must not disagree"* — and a name is the
     * same hazard with a wider blast radius: "Fire resist" here and "Fire res."
     * on the card reads as two different numbers that happen to move together.
     *
     * ASSERTED AGAINST THE SOURCE of `inspect.ts`, because the card builds its
     * label from a template and there is no constant to import.
     */
    const inspect = readFileSync(
      new URL('../../src/server/view/inspect.ts', import.meta.url),
      'utf8',
    );
    for (const template of [
      '`${damageTypeName(type)} resist`',
      '`${damageTypeName(type)} ${suffix}`',
      '`${key.charAt(0).toUpperCase()}${key.slice(1)} immunity`',
    ]) {
      expect(inspect, `inspect.ts stopped using ${template}`).toContain(template);
    }
    const projector = readFileSync(
      new URL('../../src/server/view/projector.ts', import.meta.url),
      'utf8',
    );
    expect(projector).toContain('`${damageTypeName(type)} ${suffix}`');
    expect(projector).toContain('`${key.charAt(0).toUpperCase()}${key.slice(1)} immunity`');
  });

  it('a first pickup reads as ONE number, not a number and its echo', () => {
    /**
     * `both()` omits the parenthesis when the two halves agree, and an EMPTY
     * slot makes them agree by construction: the item's own worth IS the swap.
     * Without that, the commonest case in the game — picking up the first thing
     * that fits — would read "+3 (+3)" on every row.
     */
    const world = room();
    const body = watchman(world);
    body.equipped = {};
    body.carried = ['item_leather_chest'];
    const rows = projectInventory(body).carried[0]?.compare ?? [];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.value, `${row.label} echoed itself`).not.toContain('(');
    }
  });

  it('measures it against NOT having it, not against having it twice', () => {
    /**
     * THE ARITHMETIC THAT WOULD BE WRONG. `compareRows(base, worn, candidate)`
     * swaps the candidate for whatever occupies its slot — so handing it the
     * FULL worn set with the item already in it compares the boots against the
     * boots and answers "no change", which is the failure this fixture catches.
     * The worn set must exclude the item being described.
     */
    const world = room();
    const body = watchman(world);
    body.equipped = { feet: 'item_watchmans_boots' };
    const worn = projectInventory(body).equipped['feet'];
    expect(worn?.compare).not.toEqual([]);
  });
});

describe('the compare panel measures from where the character actually stands', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE ONE SCREEN THAT EXISTS TO ANSWER "WHAT DOES THIS DO FOR ME" WAS
   * ANSWERING IT FOR SOMEBODY ELSE.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `projectInventory` took `viewer.baseCombat` as the "before" side. That is
   * the CLASS SHEET — it does not include the attribute points the player has
   * bought, and it does not include their passive talents. `recomposeCombat`
   * folds class -> bought -> gear -> passives -> effects, so `baseCombat` is
   * the bottom of a five-layer stack being used to price a swap that happens at
   * the top of it.
   *
   * It matters because `rescaleCombatStats` is CONCAVE: the same +3 Dexterity is
   * worth progressively less the higher you already are. Pricing the swap at the
   * bottom of the curve therefore OVERSTATES it, and the panel promised numbers
   * the character sheet then refused to deliver — up to about three times the
   * real gain on a heavily-invested character.
   *
   * ═══ MEASURED AGAINST GROUND TRUTH, NOT AGAINST A NUMBER I WORKED OUT ═══
   * The assertion does not hard-code what the row should say. It equips the item
   * for real, recomposes, and reads what the CHARACTER SHEET actually moved by.
   * That is the only definition of correct here, and it means the test survives
   * any retune of the curve, the class or the item.
   */
  // The only Dexterity piece in the catalogue, and Dexterity is what Accuracy
  // is rescaled from — a mods-only item would show no curve effect at all,
  // which is how the first draft of this test passed against the bug.
  const SIGNET = 'item_inspectors_oxfords';

  /** What the sheet really does when this item goes on. The ground truth. */
  function actualDelta(body: EngineActor, itemId: string, read: (c: Combatant) => number): number {
    const item = resolveItem(itemId);
    if (item?.slot === undefined) throw new Error('fixture: unwearable item');
    const before = Math.round(read(body.combat ?? {}));
    const wasEquipped = body.equipped;
    body.equipped = { ...body.equipped, [item.slot]: itemId };
    recomposeCombat(body, null, resolveItem);
    const after = Math.round(read(body.combat ?? {}));
    body.equipped = wasEquipped;
    recomposeCombat(body, null, resolveItem);
    return after - before;
  }

  it('prices a ring against the attribute points the player has bought', () => {
    const world = room();
    const body = watchman(world);

    // ═══ THE FIXTURE IS THE BOUGHT POINTS. Without them `baseCombat` and the
    // real sheet are the same object and the bug cannot be expressed — which is
    // exactly why every existing test in this file passes against it.
    body.spentStats = { dex: 30 };
    body.carried = [SIGNET];
    recomposeCombat(body, null, resolveItem);

    const rows = projectInventory(body).carried[0]?.compare ?? [];
    const claimed = Number(rows.find((r) => r.label === 'Accuracy')?.value ?? '0');
    const actual = actualDelta(body, SIGNET, combatAttack);

    expect(claimed, 'the panel promised a number the sheet does not deliver').toBe(actual);
  });

  it('prices it against the passive talents the player has, too', () => {
    // The other layer `baseCombat` is missing. A passive contributes exactly
    // what a worn item does — `equipment.ts` makes that the same combine — so a
    // panel that ignores one would ignore the other.
    const world = room();
    const body = watchman(world);

    body.passiveCombat = { stats: { dex: 25 } };
    body.carried = [SIGNET];
    recomposeCombat(body, null, resolveItem);

    const rows = projectInventory(body).carried[0]?.compare ?? [];
    const claimed = Number(rows.find((r) => r.label === 'Accuracy')?.value ?? '0');
    const actual = actualDelta(body, SIGNET, combatAttack);

    expect(claimed).toBe(actual);
  });

  it('still agrees with the sheet for a character who has bought nothing', () => {
    // THE SAFETY PROPERTY. A level-1 body has no bought points and no passives,
    // so the old baseline and the new one are the same sheet and every number
    // the panel has ever printed is unchanged.
    const world = room();
    const body = watchman(world);
    body.carried = [SIGNET];
    recomposeCombat(body, null, resolveItem);

    const rows = projectInventory(body).carried[0]?.compare ?? [];
    const claimed = Number(rows.find((r) => r.label === 'Accuracy')?.value ?? '0');
    expect(claimed).toBe(actualDelta(body, SIGNET, combatAttack));
  });
});

describe('a consumable says what it does, in this body’s own number', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * `Item.use` NEVER CROSSED THE WIRE.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * The Draught of Mending is the third way a fight can end and the client was
   * told only its flavour line — *"Ashwick work. Whatever is written on you,
   * this argues with it."* — so a player could buy one, hover it, read it on a
   * shelf, and never learn it restored anything.
   *
   * ═══ AND THE AUTHORED NUMBER IS THE ONE NOBODY GETS ═══
   * `healActor` multiplies every heal by the RECEIVER's healing factor, so the
   * authored 40 is wrong for every character in the game — and wrong in the
   * direction that reads as the item under-delivering. The sentence is rendered
   * per viewer for exactly `LoadoutTalent.range`'s reason.
   */
  const DRAUGHT = 'item_draught_mending';

  function cardFor(con: number) {
    const world = room();
    const body = watchman(world);
    body.combat = { ...(body.combat ?? {}), stats: { ...(body.combat?.stats ?? {}), con } };
    body.carried = [DRAUGHT];
    return projectInventory(body).carried[0];
  }

  it('carries a sentence at all', () => {
    expect(cardFor(10)?.use).toBe('Restores 40 health.');
  });

  it('scales it by the drinker’s Constitution, not the author’s', () => {
    /**
     * THE DISCRIMINATING ASSERTION. A version printing `use.amount` verbatim
     * passes the test above and fails this one — and it is the version that
     * looks obviously correct, because 40 is the number written in the file.
     */
    const tough = cardFor(100)?.use;
    expect(tough).toBe('Restores 60 health.');
    expect(tough).not.toBe(cardFor(10)?.use);
  });

  it('says nothing at all about an item you cannot drink', () => {
    // Absent on everything else, so all twenty-one wearable items produce the
    // frame they produced before this field existed.
    const world = room();
    const body = watchman(world);
    body.carried = ['item_watchmans_cap'];
    expect(projectInventory(body).carried[0]?.use).toBeUndefined();
  });
});

describe('what an attribute point is actually buying', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * A STAT POINT HERE IS PERMANENT, AND THE COLUMN WAS SIX LETTERS AND A `+`.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `LevelupDialog.lua:850-909` puts this under the pointer before the press,
   * and upstream can afford to hardcode its coefficients because its dialog can
   * be cancelled. Ours cannot: `unspend_stat` is a documented deliberate
   * omission and the take-back window covers talent points only.
   */
  it('names every channel a stat actually feeds', () => {
    // Measured off the shipped Watchman, so a retune of any coefficient shows up
    // here rather than silently changing what a player is told.
    const con = statGainLines(WATCHMAN.combat, 'con');
    expect(con.some((l) => l.startsWith('Max life'))).toBe(true);
    expect(con.some((l) => l.startsWith('Physical save'))).toBe(true);
    expect(con.some((l) => l.startsWith('Healing mod.'))).toBe(true);

    const dex = statGainLines(WATCHMAN.combat, 'dex');
    expect(dex.some((l) => l.startsWith('Accuracy'))).toBe(true);
    expect(dex.some((l) => l.startsWith('Defence'))).toBe(true);
    expect(dex.some((l) => l.startsWith('Crit. shrug off'))).toBe(true);
  });

  it('measures across ten points, because the rescale FLOORS', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE TRAP, AND THE FIRST VERSION FELL STRAIGHT INTO IT.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * The obvious implementation bumps the stat by ONE and reports the
     * difference. It is honest and useless: `rescaleCombatStats` floors, so a
     * Watchman at Strength 24 gaining a point moves his Physical power by
     * exactly nothing — and the panel would have told him Strength does nothing
     * for him. `content/items.ts` states the same fact as a design rule, which
     * is why no item in the game grants fewer than three points of a primary.
     *
     * This pins the consequence rather than the sample size: Strength must be
     * seen to buy Physical power on a body where a single point does not move it.
     */
    const before = combatPhysicalpower(WATCHMAN.combat);
    const onePoint = combatPhysicalpower(composeWielders(WATCHMAN.combat, [{ stats: { str: 1 } }]));
    expect(onePoint, 'the fixture no longer demonstrates the flooring').toBe(before);

    expect(statGainLines(WATCHMAN.combat, 'str').some((l) => l.startsWith('Phys. power'))).toBe(
      true,
    );
  });

  it('bends with what the body already has, because the curve is concave', () => {
    /**
     * THE REASON THIS IS MEASURED RATHER THAN TABULATED. A fixed coefficient
     * would print the same "+1.0 Accuracy" to a Dexterity 14 body and a
     * Dexterity 54 one, and only the first would be true — the same class of lie
     * the item comparison was telling before it was fixed to measure from where
     * the character actually stands.
     */
    const shallow = statGainLines(WATCHMAN.combat, 'dex');
    const deep = statGainLines(composeWielders(WATCHMAN.combat, [{ stats: { dex: 40 } }]), 'dex');
    const accuracy = (lines: readonly string[]): string =>
      lines.find((l) => l.startsWith('Accuracy')) ?? '';
    expect(accuracy(shallow)).not.toBe('');
    expect(accuracy(deep)).not.toBe('');
    expect(accuracy(deep), 'the rate did not fall on the concave part').not.toBe(accuracy(shallow));
  });

  it('says nothing about a channel a stat does not feed', () => {
    // Magic feeds spellpower and the spell save and nothing else in this game.
    // A list that named everything would be a list nobody reads.
    const mag = statGainLines(WATCHMAN.combat, 'mag');
    expect(mag.some((l) => l.startsWith('Max life'))).toBe(false);
    expect(mag.some((l) => l.startsWith('Accuracy'))).toBe(false);
    expect(mag.length).toBeGreaterThan(0);
  });
});

describe('a shelf you can actually read', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE COMPARISON ONLY EVER WORKED FOR A COAT YOU ALREADY OWNED.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * The shop tab resolved a shelf row's comparison out of the player's OWN BAG,
   * so the strip was empty for everything you had not already bought — which is
   * every item worth looking at. `ShopItemView.desc` carries a note about the
   * identical bug one field along, fixed for the description and still live for
   * the delta.
   *
   * That note also names the obstacle and the fix: *"a comparison is a fact
   * about a VIEWER and would have to become a viewer frame first. Still
   * missing, and named here rather than left to be re-found."*
   */
  const COAT = 'item_watchmans_coat';
  const DRAUGHT = 'item_draught_mending';

  function shopper() {
    const world = room();
    const body = watchman(world);
    body.equipped = { body: 'item_leather_chest' };
    recomposeCombat(body, null, resolveItem);
    return body;
  }

  it('prices a coat the player does NOT own', () => {
    // THE DISCRIMINATING CASE. The old path returned rows only for an item in
    // the bag, so a test using a carried item would pass against the bug.
    const body = shopper();
    expect(body.carried ?? [], 'the fixture must not already own it').not.toContain(COAT);

    const rows = projectInventory(body, undefined, [COAT]).shelf?.[COAT] ?? [];
    expect(rows.length, 'the shelf carried no comparison at all').toBeGreaterThan(0);
    expect(rows.some((r) => r.label === 'Armour')).toBe(true);
  });

  it('gives the same answer the bag would, so the two cannot disagree', () => {
    /**
     * A shop row and a bag row must report the identical delta for the identical
     * coat. Two answers to "what would this do for me" would drift the first
     * time either was touched, and the shop is the one where being wrong costs
     * gold.
     */
    const body = shopper();
    const onShelf = projectInventory(body, undefined, [COAT]).shelf?.[COAT] ?? [];

    body.carried = [COAT];
    const inBag = projectInventory(body, undefined, []).carried[0]?.compare ?? [];
    expect(onShelf).toEqual(inBag);
  });

  it('prices no swap for a consumable, which covers no slot', () => {
    // A comparison table of nothing reads as an item that does nothing. The
    // draught's `use` sentence is what its row has to say.
    const body = shopper();
    const msg = projectInventory(body, undefined, [COAT, DRAUGHT]);
    expect(msg.shelf?.[DRAUGHT]).toBeUndefined();
    expect(msg.shelf?.[COAT]).toBeDefined();
  });

  it('says nothing at all when there is no counter in the room', () => {
    // Absent rather than empty, so the panel knows there is nothing to draw
    // rather than drawing an empty table.
    expect(projectInventory(shopper(), undefined, []).shelf).toBeUndefined();
    expect(projectInventory(shopper()).shelf).toBeUndefined();
  });

  it('says which kind of thing each shelf row is, and what a drink does', () => {
    // Standing at the counter you could not tell whether the thing you were
    // about to pay for was a ring, a coat or a drink.
    const stock = projectShop('Threadneedle Row', [COAT, DRAUGHT], 5).stock;
    expect(stock.find((r) => r.itemId === COAT)?.slot).toBe('body');
    expect(stock.find((r) => r.itemId === DRAUGHT)?.slot).toBeUndefined();
    expect(stock.find((r) => r.itemId === DRAUGHT)?.use).toContain('Restores');
    // THE AUTHORED FIGURE ON A SHELF, not a per-viewer one: the frame is a
    // broadcast and the heal depends on who drinks it.
    expect(stock.find((r) => r.itemId === DRAUGHT)?.use).toBe('Restores 40 health.');
  });
});

describe('the floor says what a thing would do, not just what it is called', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE CARD USED TO BE A NAME AND A COLOURED DOT.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * This function deliberately withheld the comparison, and its comment gave two
   * reasons. The first — never ship the `wielder` table, never make the client do
   * the arithmetic — STILL HOLDS and is still enforced: these are finished rows.
   * The second, that it would be "a preview of a decision the player has not
   * earned yet", was overruled on report from play: the SHELF already prints a
   * full comparison for something you have not bought, and picking a thing up to
   * look at it costs a TURN. See `GroundItemView.compare`.
   */
  it('gives a viewer the swap rows, and gives a caller without one nothing', () => {
    const world = room();
    const body = watchman(world);
    world.addGroundItem({ x: 4, y: 4 }, 'item_watchmans_coat');

    const anonymous = projectGroundItems(world).items[0];
    expect(anonymous, 'the floor row vanished').toBeDefined();
    // NO BODY, NO COMPARISON. An invented baseline would be a promise about
    // numbers no body has — the same rule `projectInventory` keeps.
    expect(anonymous?.compare).toBeUndefined();

    const mine = projectGroundItems(world, undefined, body).items[0];
    expect(mine?.compare, 'a viewer was given no comparison').toBeDefined();
    expect((mine?.compare ?? []).length).toBeGreaterThan(0);
    // AND ENOUGH TO SAY WHAT IT IS. `slot` is where it would go, and
    // `fromCatalogue` is what separates a coat from a coin pile.
    //
    // THIS ASSERTED `desc` UNTIL THE FLAVOUR WENT. That field was doing two jobs:
    // carrying a sentence nobody needed, and — by being required on catalogue
    // items and absent on money and lore notes — telling the floor card which of
    // the three it had. Only the second job was load-bearing, and it is stated
    // outright now rather than inferred from prose happening to be present.
    expect(mine?.fromCatalogue, 'the floor row cannot say what kind of thing it is').toBe(true);
    expect(mine?.slot).toBe('body');
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * AND THE OTHER SIDE OF THE DISCRIMINANT, WHICH IS THE ONE THAT GOES WRONG
   * QUIETLY.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * The floor card stamps a `tier · slot` line on anything it believes is a
   * catalogue item. Money is not an `Item` at all — `resolveItem` refuses it —
   * so a coin pile reading as one would draw "common · consumable" over a heap
   * of gold. Absence is the whole assertion, and absence is what nobody writes a
   * test for: the previous discriminant (`desc`) was never pinned from this
   * side either, which is why deleting it could have gone unnoticed.
   */
  it('does not call a coin pile a catalogue item', () => {
    const world = room();
    world.addGroundItem({ x: 4, y: 4 }, moneyIdFor(47));

    const pile = projectGroundItems(world).items[0];
    expect(pile, 'the pile vanished').toBeDefined();
    expect(pile?.fromCatalogue, 'gold would draw a slot line it does not have').toBeUndefined();
    expect(pile?.slot, 'and it has no slot to name').toBeUndefined();
  });

  /**
   * THE `wielder` TABLE IS STILL NOT ON THE WIRE, and that is the half of the
   * old omission that was never up for debate. A row carries rows; it does not
   * carry the item's fold table for the browser to add up.
   */
  it('never ships the wielder table', () => {
    const world = room();
    const body = watchman(world);
    world.addGroundItem({ x: 4, y: 4 }, 'item_watchmans_coat');
    const row = projectGroundItems(world, undefined, body).items[0];
    expect(row).toBeDefined();
    expect(Object.keys(row ?? {})).not.toContain('wielder');
  });
});
