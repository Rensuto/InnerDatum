import { describe, expect, it } from 'vitest';

import { AiProfile, HOLD_INTENT } from '../../src/server/engine/actor.ts';
import { createBarrier } from '../../src/server/engine/barrier.ts';
import { DamageType } from '../../src/server/engine/damage.ts';
import {
  ProjectileStop,
  createProjectile,
  currentTile,
  stepProjectile,
  turnsToImpact,
} from '../../src/server/engine/projectile.ts';
import { pump, submitIntent } from '../../src/server/engine/scheduler.ts';
import { createWorld } from '../../src/server/world/world.ts';
import { TileCode } from '../../src/shared/protocol.ts';
import {
  ActResult,
  ENERGY_TO_ACT,
  TICKS_PER_GAME_TURN,
  createTurnClock,
  energyGainPerTick,
  grantEnergy,
  tickLevel,
} from '../../src/shared/energy.ts';
import { createRng } from '../../src/shared/rng.ts';
import type { Intent } from '../../src/server/engine/actor.ts';
import type { Barrier } from '../../src/server/engine/barrier.ts';
import type {
  Projectile,
  ProjectileOutcome,
  ProjectileWorld,
} from '../../src/server/engine/projectile.ts';
import type { GameEvent, PumpResult, SweepStep } from '../../src/server/engine/scheduler.ts';
import type { World } from '../../src/server/world/world.ts';
import type { TileXY } from '../../src/shared/coords.ts';
import type { LevelView } from '../../src/shared/protocol.ts';
import type { RngState } from '../../src/shared/rng.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE TRAVELLING PROJECTILE — the arithmetic, the five stops, and the proof
 * that the number of orbs in the air cannot perturb a replay.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The feature exists for one sentence of play: *the orb flies to the tile you
 * were standing on when it was fired, so stepping SIDEWAYS off that tile — or
 * putting a wall on the line — makes it miss, and at the wraith's stand-off
 * distance you get one decision in which to do it.* Every test below defends
 * some clause of it.
 *
 * WALKING AT THE SHOOTER IS NOT ONE OF THE DODGES. The orb tests its own tile
 * on every act (Projectile.lua:250-267's `on_move`, moved into the flight loop —
 * DEVIATION 3 in engine/projectile.ts), so a body that walks onto it eats it.
 * Without that test the orb and a charging body swap tiles with no collision
 * check in either direction and the most obvious anti-ranged move in the game is
 * a guaranteed clean dodge.
 *
 * The two properties that are not about play at all, and are the load-bearing
 * ones:
 *
 *   ZERO DRAWS. Flight and impact consume nothing from the world's generator, so
 *   three orbs in the air and none produce byte-identical streams.
 *
 *   IT NEVER BLOCKS THE BARRIER. An orb is skipped while a human owes a
 *   decision, freezes in place for as long as they take, and can never return
 *   `Park` — energy.ts returns the moment `parked` is non-empty, so an orb that
 *   parked would be a permanent member of a quorum nobody can satisfy.
 */

// ---------------------------------------------------------------------------
// An arena: a hand-drawn level, some bodies, and nothing else
// ---------------------------------------------------------------------------

/**
 * A level from ASCII rows, exactly as src/shared/level.ts parses the test map.
 * Written out here rather than reusing `makeTestLevel` because these tests need
 * to put a wall on a specific tile and to fly an orb off the edge of the world,
 * and the shipped map has a solid border that makes the second unreachable.
 */
function arenaLevel(rows: readonly string[]): LevelView {
  const h = rows.length;
  const w = rows[0]?.length ?? 0;
  const tiles: number[] = [];
  for (const row of rows) {
    if (row.length !== w) throw new Error(`arena: ragged row ${JSON.stringify(row)}`);
    for (let x = 0; x < w; x += 1) {
      tiles.push(row.charAt(x) === '#' ? TileCode.WALL : TileCode.FLOOR);
    }
  }
  return { w, h, tiles };
}

/**
 * A body an orb can land on. Satisfies `ProjectileVictim` — which declares
 * `x`/`y` READONLY, because nothing in a flight may move a body — while leaving
 * them writable HERE, since half of these tests are about somebody stepping out
 * of the line.
 */
type Body = {
  readonly id: string;
  x: number;
  y: number;
  hp: number;
  alive: boolean;
  pendingIntent: Intent | null;
};

function body(id: string, x: number, y: number, hp = 100): Body {
  return { id, x, y, hp, alive: true, pendingIntent: null };
}

type Arena = {
  readonly world: ProjectileWorld;
  readonly bodies: readonly Body[];
  readonly rngState: () => RngState;
};

function arena(rows: readonly string[], bodies: readonly Body[] = []): Arena {
  const level = arenaLevel(rows);
  const rng = createRng('arena');
  return {
    bodies,
    rngState: () => rng.getState(),
    world: {
      level,
      rng,
      // The world's own rule, copied: a corpse is scenery.
      actorAt: (x, y) => bodies.find((b) => b.alive && b.x === x && b.y === y),
    },
  };
}

type OrbInit = {
  readonly from: TileXY;
  readonly to: TileXY;
  readonly projSpeed?: number;
  readonly range?: number;
  readonly dam?: number;
  readonly sourceId?: string;
};

function orb(init: OrbInit): Projectile {
  return createProjectile('proj_1', {
    sourceId: init.sourceId ?? 'shooter',
    origin: init.from,
    to: init.to,
    projSpeed: init.projSpeed ?? 2,
    range: init.range ?? 6,
    damage: { dam: init.dam ?? 10, type: DamageType.Physical, apr: 0 },
  });
}

type Flight = {
  /** The engine tick each `act` call happened on, and where it left the orb. */
  readonly steps: readonly { readonly tick: number; readonly at: TileXY }[];
  /** The tick the orb detonated on, or -1 if it never did. */
  readonly landedAtTick: number;
  readonly outcome: ProjectileOutcome | null;
};

/**
 * Fly an orb on the REAL scheduler loop rather than a hand-rolled one, so the
 * tick arithmetic these tests pin is the arithmetic the game runs: the same
 * `grantEnergy` anti-stockpiling guard, the same ten-ticks-to-a-turn, the same
 * order of grant-then-act within a tick.
 */
function fly(proj: Projectile, world: ProjectileWorld): Flight {
  const steps: { tick: number; at: TileXY }[] = [];
  const outcomes: ProjectileOutcome[] = [];
  let landedAtTick = -1;

  tickLevel([proj], {
    clock: createTurnClock(),
    actBase: () => undefined,
    isActive: () => !proj.landed,
    act: (_actor, clock) => {
      const outcome = stepProjectile(proj, world);
      outcomes.push(outcome);
      steps.push({ tick: clock.tick, at: outcome.at });
      if (outcome.landed) landedAtTick = clock.tick;
      return ActResult.Done;
    },
    maxTicks: 500,
  });

  return { steps, landedAtTick, outcome: outcomes[outcomes.length - 1] ?? null };
}

// ---------------------------------------------------------------------------
// THE ARITHMETIC
// ---------------------------------------------------------------------------

/** A nine-wide corridor with a solid border. Origin (1,1), open to x=7. */
const CORRIDOR = ['#########', '#.......#', '#########'] as const;

describe('the arithmetic — proj_speed is tiles per GAME TURN, exactly', () => {
  it('crosses two tiles per game turn at projSpeed 2, landing a 6-tile shot on tick 25', () => {
    // THE CONVERSION, pinned as a number rather than as prose. A tick grants
    // ENERGY_PER_TICK * energyMod * globalSpeed = 100 * 2 * 1 (GameEnergyBased.
    // lua:125); ten ticks make a game turn; a tile costs ENERGY_TO_ACT = 1000.
    // So 100*2*10/1000 = 2 tiles per turn.
    //
    // The orb is BORN holding a full turn (Projectile.lua:37-39), so tile 1 is
    // free on tick 0 and the remaining five cost five ticks each:
    //   tile 1 @ 0, tile 2 @ 5, tile 3 @ 10, tile 4 @ 15, tile 5 @ 20, tile 6 @ 25.
    // Twenty-five ticks is two and a half game turns — TWO WHOLE DECISIONS for
    // the player between the flash and the impact, which is the feature.
    const scene = arena(CORRIDOR, [body('victim', 7, 1)]);
    const shot = orb({ from: { x: 1, y: 1 }, to: { x: 7, y: 1 }, projSpeed: 2, range: 6 });

    const flight = fly(shot, scene.world);

    expect(flight.steps.map((s) => s.tick)).toEqual([0, 5, 10, 15, 20, 25]);
    expect(flight.landedAtTick).toBe(25);
    expect(flight.landedAtTick).toBe(2.5 * TICKS_PER_GAME_TURN);
    expect(flight.outcome?.stop).toBe(ProjectileStop.Actor);
    expect(flight.outcome?.impact?.targetId).toBe('victim');
  });

  it('lands a 4-tile shot on tick 15 — the wraith stand-off, which is the common case', () => {
    // The wraith's `preferredRange` is 4 while its reach is 6, so the typical
    // flight is FOUR tiles and not six: one and a half game turns, not two and a
    // half. Both numbers are pinned because the six-tile shot only happens on
    // the turn the party closes in from outside the band.
    const scene = arena(CORRIDOR, [body('victim', 5, 1)]);
    const shot = orb({ from: { x: 1, y: 1 }, to: { x: 5, y: 1 }, projSpeed: 2, range: 6 });

    const flight = fly(shot, scene.world);

    expect(flight.landedAtTick).toBe(15);
    expect(flight.landedAtTick).toBe(1.5 * TICKS_PER_GAME_TURN);
    expect(flight.outcome?.impact?.targetId).toBe('victim');
  });

  it('is identical on a second run from the same seed', () => {
    const first = fly(
      orb({ from: { x: 1, y: 1 }, to: { x: 7, y: 1 } }),
      arena(CORRIDOR, [body('victim', 7, 1)]).world,
    );
    const second = fly(
      orb({ from: { x: 1, y: 1 }, to: { x: 7, y: 1 } }),
      arena(CORRIDOR, [body('victim', 7, 1)]).world,
    );

    expect(JSON.stringify(second)).toEqual(JSON.stringify(first));
  });

  it('takes its first tile on its FIRST tick, because it was born holding a full turn', () => {
    // Projectile.lua:37-39 — `self.energy.value = self.energy.value or
    // game.energy_to_act`. `grantEnergy`'s guard (energy.ts:253) then refuses to
    // add anything to an actor already at the threshold, which is exactly why
    // the shot visibly leaves the muzzle instead of hanging on the shooter's
    // tile for half a turn.
    const shot = orb({ from: { x: 1, y: 1 }, to: { x: 7, y: 1 } });
    expect(shot.energy).toBe(ENERGY_TO_ACT);
    expect(currentTile(shot)).toEqual({ x: 1, y: 1 });

    const flight = fly(shot, arena(CORRIDOR).world);
    expect(flight.steps[0]).toEqual({ tick: 0, at: { x: 2, y: 1 } });
  });

  it('REFUSES A projSpeed THAT CANNOT ARRIVE, on the runtime path and not in a test', () => {
    // A zero or non-finite `energyMod` makes `energyGainPerTick` answer 0 while
    // `anyCanGainEnergy` still answers true, so `tickLevel` burns its entire
    // tick budget on this pump AND ON EVERY PUMP AFTERWARDS, and the orb is
    // never removed because `landed` stays false. `validateTemplate` says the
    // same thing about the same field but is only ever called from a test, so it
    // covers the three authored templates and nothing else; the throw is here,
    // where the value actually enters the energy loop.
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        createProjectile('proj_bad', {
          sourceId: 'shooter',
          origin: { x: 1, y: 1 },
          to: { x: 5, y: 1 },
          projSpeed: bad,
          range: 6,
          damage: { dam: 5, type: DamageType.Physical, apr: 0 },
        }),
      ).toThrow(RangeError);
    }
  });

  it('starts its cursor at 1 — our bresenham includes the origin, ToME s line does not', () => {
    // The off-by-one that would make an orb detonate on its own shooter.
    const shot = orb({ from: { x: 1, y: 1 }, to: { x: 5, y: 1 } });
    expect(shot.cursor).toBe(1);
    expect(shot.path[0]).toEqual({ x: 1, y: 1 });
    expect(shot.path).toHaveLength(5);
  });

  it('SPENDS ALL ITS BANKED ENERGY IN ONE act CALL — the while loop, not an if', () => {
    // THE HAZARD THAT FAILS SILENTLY. `grantEnergy` DISCARDS surplus, so an orb
    // granted two turns' worth in a single tick must spend both inside one `act`
    // or its speed quietly halves. Nothing in the roster flies at 20 — ToME's own
    // declared values run 2, 3, 4, 5, 6, 10, 15, 20 — and the test exists anyway,
    // because writing this as a single `if` type-checks and passes everything else.
    const scene = arena(['############', '#..........#', '############']);
    const shot = orb({ from: { x: 1, y: 1 }, to: { x: 10, y: 1 }, projSpeed: 20, range: 10 });

    // Birth energy: the first act takes exactly one tile and empties the bank.
    stepProjectile(shot, scene.world);
    expect(currentTile(shot)).toEqual({ x: 2, y: 1 });
    expect(shot.energy).toBe(0);

    // One tick's grant at projSpeed 20 is 2000 — two tiles' worth.
    const granted = grantEnergy(shot, energyGainPerTick(shot));
    expect(granted).toBe(2000);

    stepProjectile(shot, scene.world);
    expect(currentTile(shot)).toEqual({ x: 4, y: 1 });
    expect(shot.energy).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// THE FIVE STOP CONDITIONS
// ---------------------------------------------------------------------------

describe('the five stop conditions', () => {
  it('WALL — moves ONTO the wall tile, stops there, and nothing past it is touched', () => {
    // Target.lua:459-468 returns `block=true, hit=true`: the orb reaches the
    // tile that stopped it. `hit_radius` is false, which is the anti-leak rule
    // (ActorProject.lua:232-237) — an explosion must not radiate through a
    // one-tile wall — so `radiusAt` anchors on the tile BEFORE the wall.
    const behind = body('behind', 6, 1);
    const scene = arena(['#########', '#..#....#', '#########'], [behind]);
    const shot = orb({ from: { x: 1, y: 1 }, to: { x: 6, y: 1 }, range: 6 });

    const flight = fly(shot, scene.world);

    expect(flight.outcome?.stop).toBe(ProjectileStop.Wall);
    expect(flight.outcome?.at).toEqual({ x: 3, y: 1 });
    expect(flight.outcome?.impact).toBeNull();
    expect(behind.hp).toBe(100);
    expect(shot.radiusAt).toEqual({ x: 2, y: 1 });
  });

  it('ACTOR — moves onto the body s tile and detonates on it', () => {
    // The `bolt` target type sets `stop_block` (Target.lua:583) and any body in
    // the line counts. An ALLY standing in the way eats the orb, which is a rule
    // players can see and use, and is upstream's default for a bolt.
    const inTheWay = body('bystander', 4, 1);
    const aimedAt = body('victim', 7, 1);
    const scene = arena(CORRIDOR, [inTheWay, aimedAt]);
    const shot = orb({ from: { x: 1, y: 1 }, to: { x: 7, y: 1 }, dam: 12 });

    const flight = fly(shot, scene.world);

    expect(flight.outcome?.stop).toBe(ProjectileStop.Actor);
    expect(flight.outcome?.at).toEqual({ x: 4, y: 1 });
    expect(flight.outcome?.impact?.targetId).toBe('bystander');
    expect(inTheWay.hp).toBe(88);
    expect(aimedAt.hp).toBe(100);
  });

  it('RANGE — does NOT move past its reach, and detonates on the last in-range tile', () => {
    // Target.lua:446-452 returns `block=true, hit=FALSE`, which is the opposite
    // of the wall case: no move at all, but stop is still true, so the orb
    // detonates where it is standing.
    const far = body('far', 7, 1);
    const scene = arena(CORRIDOR, [far]);
    const shot = orb({ from: { x: 1, y: 1 }, to: { x: 7, y: 1 }, range: 3 });

    const flight = fly(shot, scene.world);

    expect(flight.outcome?.stop).toBe(ProjectileStop.Range);
    // Reach 3 from x=1 means x=4 is the last legal tile; x=5 is refused.
    expect(flight.outcome?.at).toEqual({ x: 4, y: 1 });
    expect(flight.outcome?.impact).toBeNull();
    expect(far.hp).toBe(100);
  });

  it('MAP EDGE — stops at the last tile on the map rather than flying off it', () => {
    // Target.lua:443-444 plus the redundant bounds check at ActorProject.lua:
    // 395-397. The shipped map has a solid border so this is unreachable there;
    // an arena with no border is the only way to exercise it, and an unreachable
    // branch is exactly the kind that rots.
    const scene = arena(['.....', '.....', '.....']);
    const shot = orb({ from: { x: 2, y: 1 }, to: { x: 6, y: 1 }, range: 6 });

    const flight = fly(shot, scene.world);

    expect(flight.outcome?.stop).toBe(ProjectileStop.Edge);
    expect(flight.outcome?.at).toEqual({ x: 4, y: 1 });
    expect(flight.outcome?.impact).toBeNull();
  });

  it('END OF LINE — an empty aimed tile stops it with nothing to hit', () => {
    // ActorProject.lua:403. The line simply ran out, on open floor.
    const scene = arena(CORRIDOR);
    const shot = orb({ from: { x: 1, y: 1 }, to: { x: 5, y: 1 } });

    const flight = fly(shot, scene.world);

    expect(flight.outcome?.stop).toBe(ProjectileStop.EndOfLine);
    expect(flight.outcome?.at).toEqual({ x: 5, y: 1 });
    expect(flight.outcome?.impact).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// DETERMINISM
// ---------------------------------------------------------------------------

describe('determinism — an orb draws nothing, ever', () => {
  it('consumes ZERO draws from the world generator across a full flight AND impact', () => {
    // THE LOAD-BEARING ONE. `damageRange` and `critChance` are omitted at the
    // impact call, and damage.ts:463 / :475 are the only two draw sites in
    // `resolveDamage`, both guarded on exactly those fields. If either ever
    // appears in `projectDoStop`, this fails — which is the point, because the
    // symptom in production would be a replay that diverges only when somebody
    // happened to be shot at.
    const scene = arena(CORRIDOR, [body('victim', 7, 1)]);
    const before = scene.rngState();

    const flight = fly(orb({ from: { x: 1, y: 1 }, to: { x: 7, y: 1 } }), scene.world);

    expect(flight.outcome?.impact?.damage).toBeGreaterThan(0);
    expect(scene.rngState()).toEqual(before);
    expect(scene.rngState().count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// MID-FLIGHT — the counterplay, and the three ways it can go wrong
// ---------------------------------------------------------------------------

describe('mid-flight', () => {
  it('THE TARGET STEPS OFF THE AIMED TILE AND THE ORB MISSES — this is the counterplay', () => {
    // The named test the whole feature exists for. The line is frozen at fire
    // (ActorProject.lua:343-347 builds it once), so the orb flies to the tile you
    // WERE standing on. Softening this into a re-aim deletes the feature and
    // leaves only the delay.
    const dodger = body('dodger', 7, 1);
    const scene = arena(CORRIDOR, [dodger]);
    const shot = orb({ from: { x: 1, y: 1 }, to: { x: 7, y: 1 } });

    // One act's worth of flight, then they move.
    stepProjectile(shot, scene.world);
    dodger.x = 7;
    dodger.y = 2;

    const flight = fly(shot, scene.world);

    expect(flight.outcome?.stop).toBe(ProjectileStop.EndOfLine);
    expect(flight.outcome?.at).toEqual({ x: 7, y: 1 });
    expect(flight.outcome?.impact).toBeNull();
    expect(dodger.hp).toBe(100);
  });

  it('a third body that walks onto the aimed tile is hit instead', () => {
    // Occupancy is re-tested LIVE on every step (Target.lua reads the map as it
    // is right now), so the frozen line does not mean a frozen board.
    const dodger = body('dodger', 7, 1);
    const unlucky = body('unlucky', 7, 1);
    unlucky.alive = false; // not on the board yet
    const scene = arena(CORRIDOR, [dodger, unlucky]);
    const shot = orb({ from: { x: 1, y: 1 }, to: { x: 7, y: 1 } });

    stepProjectile(shot, scene.world);
    dodger.x = 7;
    dodger.y = 2;
    unlucky.alive = true;

    const flight = fly(shot, scene.world);

    expect(flight.outcome?.impact?.targetId).toBe('unlucky');
    expect(unlucky.hp).toBe(90);
    expect(dodger.hp).toBe(100);
  });

  it('A BODY THAT WALKS ONTO THE ORB EATS IT — no tile-swap, no free charge', () => {
    // ═══ THE TUNNELING HOLE, CLOSED FROM THE FLIGHT SIDE ═══
    // `projectDoMove` only ever inspects the NEXT tile, so a body stepping onto
    // the tile the orb is standing on is invisible to it — the two then exchange
    // tiles with no collision test in either direction and the orb sails on to
    // detonate on empty floor. Upstream cannot have that hole: its orb occupies
    // a grid in `Map.PROJECTILE` and the mover calls `Projectile:on_move`, which
    // for a `stop_block` type runs `projectDoStop` on the orb's own tile
    // (:258-259). Ours is deliberately not in `world.actorAt`, so the same test
    // lives at the top of the flight loop instead.
    //
    // The scenario is the wraith's own standing distance and the single most
    // obvious anti-ranged move there is: walk straight at the shooter.
    const charger = body('charger', 5, 1);
    const scene = arena(CORRIDOR, [charger]);
    const shot = orb({ from: { x: 1, y: 1 }, to: { x: 5, y: 1 }, range: 6 });

    // The orb takes its free first tile and stands on x=2.
    stepProjectile(shot, scene.world);
    expect(currentTile(shot)).toEqual({ x: 2, y: 1 });

    // The charger closes one tile. Still ahead of the orb, so nothing collides.
    charger.x = 4;
    grantEnergy(shot, ENERGY_TO_ACT);
    stepProjectile(shot, scene.world);
    expect(currentTile(shot)).toEqual({ x: 3, y: 1 });
    expect(charger.hp).toBe(100);

    // Now they step ONTO x=3, the tile the orb is standing on. `world.actorAt`
    // cannot see an orb, so nothing stopped them getting there — which is the
    // whole reason the test has to be on this side.
    charger.x = 3;
    grantEnergy(shot, ENERGY_TO_ACT);
    const outcome = stepProjectile(shot, scene.world);

    expect(outcome.landed).toBe(true);
    expect(outcome.stop).toBe(ProjectileStop.Actor);
    expect(outcome.at).toEqual({ x: 3, y: 1 });
    expect(outcome.impact?.targetId).toBe('charger');
    expect(charger.hp).toBe(90);
    // Target.lua:501 — a body-stop radiates from the VICTIM's tile, not the one
    // before it. Only terrain steps the anchor back.
    expect(shot.radiusAt).toEqual({ x: 3, y: 1 });
  });

  it('never detonates on its own shooter, who is standing on path[0]', () => {
    // The `cursor > 1` guard on the in-flight tile test. `path[0]` IS the
    // origin, the orb is born standing on it, and the shooter is right there —
    // so an unguarded check would make every wraith blow itself up on the tick
    // it fired.
    const shooter = body('shooter', 1, 1);
    const victim = body('victim', 5, 1);
    const scene = arena(CORRIDOR, [shooter, victim]);
    const shot = orb({ from: { x: 1, y: 1 }, to: { x: 5, y: 1 }, sourceId: 'shooter' });

    const flight = fly(shot, scene.world);

    expect(flight.outcome?.impact?.targetId).toBe('victim');
    expect(shooter.hp).toBe(100);
  });

  it('a target that DIES mid-flight leaves an empty tile, and the orb resolves for nothing', () => {
    // `actorAt` skips anything not alive — world.ts's own rule, "a dead body is
    // scenery" — so the arrival tile simply reads empty.
    const doomed = body('doomed', 7, 1);
    const scene = arena(CORRIDOR, [doomed]);
    const shot = orb({ from: { x: 1, y: 1 }, to: { x: 7, y: 1 } });

    stepProjectile(shot, scene.world);
    doomed.hp = 0;
    doomed.alive = false;

    const flight = fly(shot, scene.world);

    expect(flight.outcome?.landed).toBe(true);
    expect(flight.outcome?.impact).toBeNull();
    expect(doomed.hp).toBe(0);
  });

  it('a DEAD SHOOTER is never consulted — the orb carries everything it needs', () => {
    // Upstream holds a hard reference to `self.src` and calls back into it three
    // times per step with no liveness check (Projectile.lua:215, :218, :230). We
    // copy the behaviour and not the hazard: this arena contains no shooter at
    // all, and the flight resolves anyway.
    const victim = body('victim', 7, 1);
    const scene = arena(CORRIDOR, [victim]);
    const shot = orb({ from: { x: 1, y: 1 }, to: { x: 7, y: 1 }, sourceId: 'a_corpse', dam: 9 });

    const flight = fly(shot, scene.world);

    expect(flight.outcome?.impact?.targetId).toBe('victim');
    expect(victim.hp).toBe(91);
    expect(shot.sourceId).toBe('a_corpse');
  });

  it('clears a killed body s pending intent, exactly as the melee path does', () => {
    // engine/actor.ts's `applyDamage` does this and damage.ts's does not, because
    // damage.ts knows nothing about intents. A body that went down holding one
    // would resolve it the moment an ally picked them up — a turn nobody took.
    const victim = body('victim', 7, 1, 5);
    victim.pendingIntent = HOLD_INTENT;
    const scene = arena(CORRIDOR, [victim]);

    fly(orb({ from: { x: 1, y: 1 }, to: { x: 7, y: 1 }, dam: 40 }), scene.world);

    expect(victim.alive).toBe(false);
    expect(victim.pendingIntent).toBeNull();
  });
});

describe('turnsToImpact', () => {
  it('counts GAME TURNS, rounded up, never ticks and never milliseconds', () => {
    // protocol.ts's `EffectView.turns` rule. A partial turn is still a turn the
    // player gets to act in, so it rounds UP: telling somebody they have one turn
    // when they have one and a half is safe, the other way round is a lie.
    const shot = orb({ from: { x: 1, y: 1 }, to: { x: 7, y: 1 }, projSpeed: 2 });
    expect(turnsToImpact(shot)).toBe(3);

    const scene = arena(CORRIDOR);
    stepProjectile(shot, scene.world);
    expect(turnsToImpact(shot)).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// THE SCHEDULER — the barrier, the idle fixed point, and the fork
// ---------------------------------------------------------------------------

const HUSK_SPRITE = 'enemy_index_husk_s';
const WRAITH_SPRITE = 'enemy_index_wraith_s';

type Session = {
  readonly world: World;
  readonly barrier: Barrier;
  readonly advance: (nowMs: number) => PumpResult;
  readonly commit: (actorId: string, intent: Intent, nowMs: number) => PumpResult;
};

function session(seed: string, players: number, monsters: number): Session {
  const world = createWorld(seed);
  for (let i = 0; i < players; i += 1) {
    const actor = world.addPlayer(`p${i + 1}`, `Player ${i + 1}`);
    // Big enough that nobody dies mid-test and turns the run into a corpse
    // measurement, exactly as test/server/scheduler.test.ts does.
    actor.maxHp = 10_000;
    actor.hp = 10_000;
  }
  for (let i = 0; i < monsters; i += 1) {
    world.addMonster(`m${i + 1}`, {
      name: `Index Husk ${i + 1}`,
      sprite: HUSK_SPRITE,
      x: 7 + i,
      y: 2,
      profile: AiProfile.MeleeChaser,
    });
  }

  const barrier = createBarrier();
  return {
    world,
    barrier,
    advance: (nowMs) => pump(world, { nowMs, barrier }),
    commit: (actorId, intent, nowMs) => {
      expect(submitIntent(world, barrier, actorId, intent)).toBe(true);
      return pump(world, { nowMs, barrier });
    },
  };
}

/** Put an orb in the air by hand, aimed at nothing, so tests can time it. */
function launch(world: World, from: TileXY, to: TileXY, projSpeed = 2): Projectile {
  return world.addProjectile({
    sourceId: 'm1',
    origin: from,
    to,
    projSpeed,
    range: 12,
    damage: { dam: 5, type: DamageType.Physical, apr: 0 },
  });
}

function sweepSteps(events: readonly GameEvent[]): SweepStep[] {
  const steps: SweepStep[] = [];
  for (const event of events) {
    if (event.t === 'sweep') steps.push(...event.steps);
  }
  return steps;
}

describe('the barrier — an orb freezes while a human decides', () => {
  it('does not appear in the parked set, and does not move on a pump that parks immediately', () => {
    // `actorsInTurnOrder` puts the party first and projectiles are appended
    // last, so by the time the sweep reaches an orb, `parked` is already
    // non-empty and energy.ts:647 skips it. There is no new mechanism here and
    // there must never be one: `inQuorum` opens with `kind === Player`, so there
    // is no field an orb could set to get into the blocking set.
    const table = session('orb-barrier', 1, 1);
    const shot = launch(table.world, { x: 1, y: 16 }, { x: 12, y: 16 });

    const first = table.advance(0);
    expect(first.status).toBe('parked');
    expect(first.parked).toEqual(['p1']);
    expect(first.parked).not.toContain(shot.id);

    // It flew while the player was still accruing energy, and stopped the
    // instant they parked.
    const parkedAt = currentTile(shot);
    expect(parkedAt.x).toBeGreaterThan(1);

    // Now the human deliberates. Three more pumps, no decision, no movement.
    for (let i = 1; i <= 3; i += 1) {
      const again = table.advance(i);
      expect(again.status).toBe('parked');
      expect(again.ticks).toBe(0);
      expect(currentTile(shot)).toEqual(parkedAt);
    }

    // ...and it advances again the moment the turn resolves.
    table.commit('p1', HOLD_INTENT, 10);
    expect(currentTile(shot)).not.toEqual(parkedAt);
  });
});

describe('the idle fixed point', () => {
  it('reaches idle after the orb lands, and never returns budget with one in the air', () => {
    // An orb in flight is something that can still gain energy, so the level
    // keeps ticking while it crosses the room — which is correct, the world IS
    // still moving. What must never happen is the tick ceiling being reached,
    // because that is the valve for a loop that cannot terminate.
    const table = session('orb-idle', 1, 0);
    const shot = launch(table.world, { x: 1, y: 17 }, { x: 9, y: 17 });

    const first = table.advance(0);
    expect(first.status).toBe('idle');
    expect(shot.landed).toBe(true);
    expect(table.world.projectilesInFlight()).toHaveLength(0);

    const second = table.advance(1);
    expect(second.status).toBe('idle');
    expect(second.ticks).toBe(0);
  });
});

describe('the fork — projSpeed turns an attack into a flight', () => {
  it('emits a `fired` step, puts an orb in the world, and lands the blow turns later', () => {
    // The whole feature, end to end, through the real scheduler: the wraith
    // decides to shoot, the sweep reports a launch with no damage attached, and
    // the `attack` step arrives on a later turn attributed to the shooter.
    const table = session('orb-fork', 1, 0);
    const player = table.world.getActor('p1');
    if (player === undefined) throw new Error('fixture: p1 missing');
    player.maxHp = 10_000;
    player.hp = 10_000;
    player.x = 3;
    player.y = 17;
    table.world.addMonster('w1', {
      name: 'Index Wraith',
      sprite: WRAITH_SPRITE,
      x: 8,
      y: 17,
      profile: AiProfile.RangedKiter,
      attackRange: 6,
      preferredRange: 4,
      minRange: 2,
      projSpeed: 2,
    });

    const fired: SweepStep[] = [];
    const attacks: SweepStep[] = [];
    let nowMs = 0;
    let result = table.advance(nowMs);
    for (let turn = 0; turn < 12; turn += 1) {
      for (const step of sweepSteps(result.events)) {
        if (step.t === 'fired') fired.push(step);
        if (step.t === 'attack') attacks.push(step);
      }
      nowMs += 1_000;
      result = table.commit('p1', HOLD_INTENT, nowMs);
    }
    for (const step of sweepSteps(result.events)) {
      if (step.t === 'fired') fired.push(step);
      if (step.t === 'attack') attacks.push(step);
    }

    expect(fired.length).toBeGreaterThan(0);
    const [first] = fired;
    if (first === undefined || first.t !== 'fired') throw new Error('expected a fired step');
    expect(first.id).toBe('w1');

    // The launch carries no damage — nothing has been hit yet.
    expect(Object.keys(first)).toEqual(['t', 'id', 'to']);

    // ...and the blow lands later, from the shooter, on the player.
    expect(attacks.length).toBeGreaterThan(0);
    const [hit] = attacks;
    if (hit === undefined || hit.t !== 'attack') throw new Error('expected an attack step');
    expect(hit.id).toBe('w1');
    expect(hit.targetId).toBe('p1');
    expect(hit.damage).toBeGreaterThan(0);
    expect(player.hp).toBeLessThan(10_000);
  });

  it('attributes the blow to a shooter that died mid-flight', () => {
    // Upstream attributes damage to the corpse too (tome/class/Game.lua:1713).
    // The orb stores an ID rather than a reference precisely so this cannot
    // throw: there is nothing to dereference.
    const table = session('orb-dead-shooter', 1, 1);
    const player = table.world.getActor('p1');
    const shooter = table.world.getActor('m1');
    if (player === undefined || shooter === undefined) throw new Error('fixture');
    player.x = 4;
    player.y = 18;

    table.world.addProjectile({
      sourceId: 'm1',
      origin: { x: 8, y: 18 },
      to: { x: 4, y: 18 },
      projSpeed: 2,
      range: 6,
      damage: { dam: 7, type: DamageType.Physical, apr: 0 },
    });
    shooter.alive = false;

    const attacks: SweepStep[] = [];
    let nowMs = 0;
    let result = table.advance(nowMs);
    for (let turn = 0; turn < 4; turn += 1) {
      for (const step of sweepSteps(result.events)) if (step.t === 'attack') attacks.push(step);
      nowMs += 1_000;
      result = table.commit('p1', HOLD_INTENT, nowMs);
    }
    for (const step of sweepSteps(result.events)) if (step.t === 'attack') attacks.push(step);

    expect(attacks).toHaveLength(1);
    const [hit] = attacks;
    if (hit === undefined || hit.t !== 'attack') throw new Error('expected an attack step');
    expect(hit.id).toBe('m1');
    expect(hit.targetId).toBe('p1');
    expect(hit.damage).toBe(7);
  });
});

describe('replay — the number of orbs in the air cannot perturb the stream', () => {
  /**
   * The same fixed encounter every time: two players holding, three husks
   * closing. `orbs` free-flying shots are launched into an empty corridor far
   * from the fight, so they land on nothing and change no board state.
   */
  function play(orbs: number): { events: GameEvent[]; rng: RngState } {
    const table = session('orb-replay', 2, 3);
    for (let i = 0; i < orbs; i += 1) {
      launch(table.world, { x: 1 + i, y: 27 }, { x: 12 + i, y: 27 });
    }

    const events: GameEvent[] = [];
    for (let turn = 0; turn < 8; turn += 1) {
      events.push(...table.advance(turn * 1_000).events);
      events.push(...table.commit('p1', HOLD_INTENT, turn * 1_000 + 1).events);
      events.push(...table.commit('p2', HOLD_INTENT, turn * 1_000 + 2).events);
    }
    return { events, rng: table.world.rng.getState() };
  }

  it('produces the identical draw sequence with 0, 1 and 3 orbs in flight', () => {
    // THE PROOF. Every draw the feature needs happens at FIRE, inside the
    // shooter's own act, under the same `combat.bump.damage` label an instant
    // attack uses; flight is integer energy arithmetic and impact is guarded out
    // of both draw sites in `resolveDamage`. So the generator cannot tell how
    // many orbs were in the air — and neither can a replay.
    const none = play(0);
    const one = play(1);
    const three = play(3);

    expect(one.rng).toEqual(none.rng);
    expect(three.rng).toEqual(none.rng);
    expect(none.rng.count).toBeGreaterThan(0);

    // ...and the fight itself is identical, event for event.
    expect(JSON.stringify(one.events)).toEqual(JSON.stringify(none.events));
    expect(JSON.stringify(three.events)).toEqual(JSON.stringify(none.events));
  });
});
