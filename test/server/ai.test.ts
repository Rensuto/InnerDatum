import { describe, expect, it } from 'vitest';

import { decideNpcAction } from '../../src/server/ai/npc.ts';
import {
  AiProfile,
  IntentKind,
  createMonsterActor,
  createPlayerActor,
} from '../../src/server/engine/actor.ts';
import { DIR_VECTORS, chebyshev } from '../../src/shared/coords.ts';
import { createRng } from '../../src/shared/rng.ts';
import { drawCount, scriptedRng } from '../helpers/scripted-rng.ts';
import type { AiCtx } from '../../src/server/ai/npc.ts';
import type { EngineActor, Intent, MonsterActor } from '../../src/server/engine/actor.ts';
import type { TileXY } from '../../src/shared/coords.ts';
import type { Rng } from '../../src/shared/rng.ts';

/**
 * `decideNpcAction` answers ONE question — "what would this monster like to do"
 * — and touches nothing. The scheduler then resolves that intent through the
 * SAME legality checks a player's goes through, which is why a monster cannot
 * walk through a wall via a code path no player takes.
 *
 * PATHING IS TERRAIN-ONLY, AND THAT IS WHAT MAKES BUMP-ATTACK WORK. ToME's A*
 * tests the terrain layer and never looks at actors (Astar.lua:150, :156), so a
 * monster paths straight THROUGH the tile its target stands on, walks the path,
 * finds a body in the way, and attacks it. Hand `findPath` an actor-aware
 * predicate instead and monsters politely route around their victims and never
 * land a blow. `ctx.isPassable` below is terrain-only for exactly that reason.
 */

/** A room with a three-tile wall down the middle: a detour exists, a shortcut does not. */
const DIVIDED_ROOM = [
  '#########',
  '#.......#',
  '#...#...#',
  '#...#...#',
  '#...#...#',
  '#.......#',
  '#########',
] as const;

/** The same room with the wall run all the way through: the halves are sealed. */
const SEALED_ROOM = [
  '#########',
  '#...#...#',
  '#...#...#',
  '#...#...#',
  '#...#...#',
  '#...#...#',
  '#########',
] as const;

function passableIn(rows: readonly string[]): (x: number, y: number) => boolean {
  return (x, y) => {
    const row = rows[y];
    if (row === undefined || x < 0 || x >= row.length) return false;
    return row.charAt(x) === '.';
  };
}

/**
 * The AI's whole view of the world, hand-built.
 *
 * `visibleEnemies` mirrors the scheduler's real one — NEAREST FIRST, ties broken
 * by id — because that total order is what stops a monster standing between two
 * players from re-picking a different target every turn depending on iteration
 * order. It is aggro-range only here; line of sight is the caller's to define
 * and becomes a real FOV lookup at M3, which is exactly why this seam exists.
 */
function aiCtx(rows: readonly string[], actors: readonly EngineActor[], rng: Rng): AiCtx {
  const isPassable = passableIn(rows);
  return {
    isPassable,
    actorAt: (x, y) => actors.find((actor) => actor.alive && actor.x === x && actor.y === y),
    visibleEnemies: (self) => {
      const seen = actors
        .filter((actor) => actor.alive && actor.kind !== self.kind)
        .map((actor) => ({ actor, distance: chebyshev(self, actor) }))
        .filter((entry) => entry.distance <= self.ai.aggroRange);
      seen.sort((a, b) => {
        if (a.distance !== b.distance) return a.distance - b.distance;
        return a.actor.id < b.actor.id ? -1 : 1;
      });
      return seen.map((entry) => entry.actor);
    },
    rng,
  };
}

/**
 * A bare melee monster on `createMonsterActor`'s OWN defaults — aggro 8,
 * preferred 1, min 0 (`PROFILE_RANGES` in engine/actor.ts).
 *
 * DELIBERATELY NOT `INDEX_HUSK`. The content template now carries the giant
 * brown ant's `infravision = 10` (ant.lua:38) and its `global_speed_base = 0.9`
 * (ant.lua:58); this file is testing the PROFILE, not the creature, and pinning
 * it to a template would make every board here move whenever content is retuned.
 * test/server/monsters.test.ts is where the real roster's ranges are asserted.
 * The two numbers differing is fine; confusing them is not.
 */
function husk(id: string, at: TileXY, profile: AiProfile = AiProfile.MeleeChaser): MonsterActor {
  return createMonsterActor(id, {
    name: id,
    sprite: 'enemy_index_husk_s',
    x: at.x,
    y: at.y,
    profile,
  });
}

/**
 * A bare ranged kiter, likewise on the profile defaults: aggro 9, preferred 5,
 * min 3, and therefore `attackRange` 5 (`createMonsterActor` derives reach from
 * the stand-off distance so a kiter never walks to a tile it refuses to fire
 * from). `talentIn` is passed straight through when given.
 */
function kiter(id: string, at: TileXY, talentIn?: number): MonsterActor {
  return createMonsterActor(id, {
    name: id,
    sprite: 'enemy_index_wraith_s',
    x: at.x,
    y: at.y,
    profile: AiProfile.RangedKiter,
    talentIn,
  });
}

function detective(id: string, at: TileXY) {
  return createPlayerActor(id, { name: id, sprite: 'chr_player_watchman_s', x: at.x, y: at.y });
}

/** Apply a move intent the way the world would. Anything else leaves the tile alone. */
function applyMove(actor: MonsterActor, intent: Intent): void {
  if (intent.kind !== IntentKind.Move) return;
  const vector = DIR_VECTORS[intent.dir];
  actor.x += vector.dx;
  actor.y += vector.dy;
}

type ChaseStep = {
  readonly at: string;
  readonly distance: number;
  readonly intent: string;
};

/**
 * Walk a chaser toward its target for up to `turns` turns, recording where it
 * stood, how far away it was, and what it decided. Stops the moment it attacks.
 */
function chase(rows: readonly string[], seed: string, turns: number): ChaseStep[] {
  const player = detective('p1', { x: 7, y: 3 });
  const monster = husk('m1', { x: 1, y: 3 });
  const actors: EngineActor[] = [player, monster];
  const ctx = aiCtx(rows, actors, createRng(seed));

  const log: ChaseStep[] = [];
  for (let turn = 0; turn < turns; turn += 1) {
    const intent = decideNpcAction(monster, ctx);
    log.push({
      at: `${monster.x},${monster.y}`,
      distance: chebyshev(monster, player),
      intent: JSON.stringify(intent),
    });
    if (intent.kind === IntentKind.Attack) break;
    applyMove(monster, intent);
  }
  return log;
}

describe('melee_chaser closes the distance', () => {
  it('gets strictly nearer its target every turn until it is in reach', () => {
    // Distance must fall MONOTONICALLY. A chaser that oscillates — the classic
    // symptom of re-targeting every turn, or of a heuristic that prefers the
    // tile it just left — reads as a broken monster long before anybody works
    // out why.
    const log = chase(DIVIDED_ROOM, 'chase', 16);
    const distances = log.map((entry) => entry.distance);

    expect(distances[0]).toBe(6);
    for (let i = 1; i < distances.length; i += 1) {
      const previous = distances[i - 1];
      const current = distances[i];
      if (previous === undefined || current === undefined) throw new Error('ragged chase log');
      expect({ turn: i, closer: current < previous }).toEqual({ turn: i, closer: true });
    }

    // ...and it arrives, rather than shuffling forever one tile short.
    const final = log[log.length - 1];
    if (final === undefined) throw new Error('empty chase log');
    expect(final.distance).toBe(1);
    expect(final.intent).toContain(IntentKind.Attack);
    expect(log).toHaveLength(6);
  });

  it('remembers who it is chasing instead of re-deciding from scratch', () => {
    // ToME keeps its target 90% of the time (ai/simple.lua:253). That hysteresis
    // is what stops a monster standing between two players from committing to
    // neither. The draw is what makes this module consume the seeded stream at
    // all, so it is also what the determinism test below is measuring.
    const alpha = detective('alpha', { x: 1, y: 1 });
    const beta = detective('beta', { x: 7, y: 5 });
    const monster = husk('m1', { x: 4, y: 3 });
    const actors: EngineActor[] = [alpha, beta, monster];
    const rng = createRng('hysteresis');
    const ctx = aiCtx(DIVIDED_ROOM, actors, rng);

    expect(monster.ai.targetId).toBeNull();
    decideNpcAction(monster, ctx);
    const firstTarget = monster.ai.targetId;
    expect(firstTarget).not.toBeNull();

    for (let turn = 0; turn < 6; turn += 1) decideNpcAction(monster, ctx);
    expect(monster.ai.targetId).toBe(firstTarget);

    // Proof the seeded generator is genuinely in the loop: the keep-roll drew
    // from it, under its own label.
    const state = rng.getState();
    expect(state.count).toBeGreaterThan(0);
    expect(state.lastLabel).toBe('ai.target.keep');
  });
});

describe('bump-attack', () => {
  it('attacks a target it is already touching instead of moving onto its tile', () => {
    // Contact is decided BEFORE any pathing happens, so there is no route to
    // take and no occupied tile to step into.
    for (const offset of [
      { dx: 1, dy: 0 },
      { dx: -1, dy: 0 },
      { dx: 0, dy: 1 },
      { dx: 1, dy: 1 },
    ]) {
      const player = detective('p1', { x: 3, y: 3 });
      const monster = husk('m1', { x: 3 + offset.dx, y: 3 + offset.dy });
      const actors: EngineActor[] = [player, monster];
      const intent = decideNpcAction(monster, aiCtx(DIVIDED_ROOM, actors, createRng('bump')));

      expect(intent).toEqual({ kind: IntentKind.Attack, targetId: 'p1' });
    }
  });

  it('bumps the body the terrain-only route walked it into', () => {
    // Two tiles apart with the player standing on the routed tile: A* runs
    // straight through the occupant (that is what terrain-only means), and the
    // step onto it becomes an attack rather than a refused move. Path planning
    // and collision are separate questions asked at separate times.
    const player = detective('p1', { x: 3, y: 1 });
    const monster = husk('m1', { x: 1, y: 1 });
    monster.attackRange = 1;
    const actors: EngineActor[] = [player, monster];
    const ctx = aiCtx(DIVIDED_ROOM, actors, createRng('bump-route'));

    // Step one: not in reach yet, so it moves — and moves ONTO an empty tile.
    const approach = decideNpcAction(monster, ctx);
    expect(approach).toEqual({ kind: IntentKind.Move, dir: 'e' });
    applyMove(monster, approach);
    expect({ x: monster.x, y: monster.y }).toEqual({ x: 2, y: 1 });

    // Step two: now adjacent, so it swings.
    expect(decideNpcAction(monster, ctx)).toEqual({ kind: IntentKind.Attack, targetId: 'p1' });
  });

  it('does not shove an ally aside to get there', () => {
    // A second husk in the doorway is a chokepoint working as intended: the
    // blocked monster braces rather than attacking its friend or teleporting
    // past it. `intentForStep` refuses the step when the occupant is on its own
    // side, and there is no straight-step fallback available either.
    const player = detective('p1', { x: 3, y: 1 });
    const blocker = husk('m2', { x: 2, y: 1 });
    const monster = husk('m1', { x: 1, y: 1 });
    const actors: EngineActor[] = [player, blocker, monster];

    const intent = decideNpcAction(monster, aiCtx(SEALED_ROOM, actors, createRng('ally')));
    expect(intent).toEqual({ kind: IntentKind.Hold });
  });
});

describe('ai_state.talent_in gates the shot', () => {
  /**
   * Ported from ai/talented.lua:117-132, and the whole gate is one condition:
   *
   * ```lua
   * -- One in "talent_in" chance of using a talent            -- :115 (the comment)
   * if ... rng.chance(self.ai_state.talent_in or 6) ... then  -- :122
   * ```
   *
   * A 1-IN-N CHANCE PER TURN, not a cadence of one shot every N turns. Anyone
   * who reads it as a cadence mis-predicts DPS by a factor of two in the tail
   * and gets the feel completely wrong: a cadence is a metronome the player can
   * count, and a coin is not.
   *
   * The board below puts the kiter at exactly its stand-off distance on the open
   * top row of the divided room — Euclidean 5, which is `preferredRange` and
   * `attackRange` at once — so the three-way test in `kite` lands squarely on
   * the fire branch with nothing else to decide.
   */
  function lanedUp(talentIn?: number): { player: EngineActor; monster: MonsterActor } {
    return {
      player: detective('p1', { x: 1, y: 1 }),
      monster: kiter('m1', { x: 6, y: 1 }, talentIn),
    };
  }

  /** One turn's decision for a lane-holding kiter, against a written-down script. */
  function fireTurn(talentIn: number | undefined, script: readonly number[]) {
    const { player, monster } = lanedUp(talentIn);
    const rng = scriptedRng(script);
    const intent = decideNpcAction(monster, aiCtx(DIVIDED_ROOM, [player, monster], rng));
    return { intent, draws: drawCount(rng), monster };
  }

  it('fires on a 1 and holds its aim on anything else', () => {
    // FIRST CALL, so `ai.target.keep` short-circuits — simple.lua:253 only rolls
    // when there is already a remembered target. One number in the script is
    // therefore the entire turn, and it is the fire roll.
    const hot = fireTurn(2, [1]);
    expect(hot.intent).toEqual({ kind: IntentKind.Attack, targetId: 'p1' });
    expect(hot.draws).toBe(1);

    const cold = fireTurn(2, [2]);
    expect(cold.intent).toEqual({ kind: IntentKind.Hold });
    expect(cold.draws).toBe(1);

    // A held shot is NOT a blocked turn. The monster is standing exactly where
    // it wants to stand, so nothing may accumulate toward the elite shoulder
    // escalation — which a kiter must never run anyway, since shouldering
    // forward is the one thing a pinned kiter must not do.
    expect(cold.monster.ai.blockedTurns).toBe(0);
  });

  it('holds every turn a 1 never comes up, without ever stepping forward', () => {
    // The failure mode this gate could have introduced: upstream falls through
    // to `move_simple` when the roll fails (talented.lua:126-128), and copying
    // that would walk a kiter out of the lane it spent three turns reaching.
    // Three failed rolls in a row must leave it on exactly the tile it started
    // on, and must never produce a Move.
    const { player, monster } = lanedUp(6);
    // The first turn draws ONCE (no remembered target yet, so simple.lua:253
    // short-circuits); every turn after it draws the keep-roll first. So the
    // script is fire, then keep/fire, then keep/fire — five numbers for three
    // turns, and running out is a test failure rather than a wrap-around.
    const rng = scriptedRng([2, 3, 4, 5, 6]);
    const ctx = aiCtx(DIVIDED_ROOM, [player, monster], rng);

    for (let turn = 0; turn < 3; turn += 1) {
      const intent = decideNpcAction(monster, ctx);
      expect({ turn, intent }).toEqual({ turn, intent: { kind: IntentKind.Hold } });
      applyMove(monster, intent);
    }
    expect({ x: monster.x, y: monster.y }).toEqual({ x: 6, y: 1 });
    expect(drawCount(rng)).toBe(5);
  });

  it('takes NO fire draw at all when the creature declares no talentIn', () => {
    // THE STREAM-POSITION GUARANTEE, and the reason the gate is written as
    // `self.talentIn !== undefined` rather than as a `?? 1` default. Absent
    // means "every turn", which is exactly what `rng.chance(1)` means upstream
    // (BASE_NPC_ANT authors `talent_in = 1`, ant.lua:33) — so a creature without
    // the field must consume the seeded stream EXACTLY as it did before the gate
    // existed, or every replay from an older seed diverges.
    //
    // An empty script is the strongest possible statement of that: `scriptedRng`
    // THROWS on any draw rather than wrapping around, so the cursor is provably
    // unmoved.
    const plain = fireTurn(undefined, []);
    expect(plain.intent).toEqual({ kind: IntentKind.Attack, targetId: 'p1' });
    expect(plain.draws).toBe(0);
  });

  it('does not take the fire draw on a turn it has no shot lined up', () => {
    // Out of its band: Euclidean 7.21 against `preferredRange` 5 (and inside
    // `aggroRange` 9, so it can see and therefore target), which routes through
    // `advance` and never reaches the fire branch. The draw must be taken INSIDE
    // that branch only, or the number of turns a kiter spends walking changes
    // what every other actor in the level rolls.
    const player = detective('p1', { x: 1, y: 1 });
    const monster = kiter('m1', { x: 7, y: 5 }, 2);
    const rng = scriptedRng([]);
    const intent = decideNpcAction(monster, aiCtx(DIVIDED_ROOM, [player, monster], rng));

    expect(intent.kind).toBe(IntentKind.Move);
    expect(drawCount(rng)).toBe(0);
  });
});

describe('walls', () => {
  it('routes around a wall and never stands on one', () => {
    // Every tile the monster occupies must be passable, and it must never cross
    // the barrier column directly. The map gives it a way round, so "it holds
    // still" would fail the monotonic-approach assertion above rather than
    // passing this one by accident.
    const isPassable = passableIn(DIVIDED_ROOM);
    const log = chase(DIVIDED_ROOM, 'walls', 16);

    for (const entry of log) {
      const [rawX, rawY] = entry.at.split(',');
      const x = Number(rawX);
      const y = Number(rawY);
      expect({ at: entry.at, passable: isPassable(x, y) }).toEqual({
        at: entry.at,
        passable: true,
      });
    }

    // It genuinely went round rather than through: the wall column is x=4 at
    // y=2..4, so a route that touched any of those tiles would have been a
    // shortcut through solid rock.
    expect(isPassable(4, 2)).toBe(false);
    expect(isPassable(4, 3)).toBe(false);
    expect(isPassable(4, 4)).toBe(false);
    expect(log.map((entry) => entry.at)).not.toContain('4,3');
    expect(log.some((entry) => entry.at === '4,1' || entry.at === '4,5')).toBe(true);
  });

  it('braces rather than walking into a wall when there is no route at all', () => {
    // The sealed room: A* returns null, ToME's `move_simple` fallback finds the
    // straight step blocked too, and the monster holds. What must NOT happen is
    // a move intent into rock — the scheduler would refuse it, but the monster
    // would have wasted the turn on an impossible plan every turn forever.
    const player = detective('p1', { x: 7, y: 3 });
    const monster = husk('m1', { x: 3, y: 3 });
    const actors: EngineActor[] = [player, monster];
    const ctx = aiCtx(SEALED_ROOM, actors, createRng('sealed'));

    for (let turn = 0; turn < 5; turn += 1) {
      const intent = decideNpcAction(monster, ctx);
      expect(intent).toEqual({ kind: IntentKind.Hold });
      applyMove(monster, intent);
      expect({ x: monster.x, y: monster.y }).toEqual({ x: 3, y: 3 });
    }
  });
});

describe('determinism', () => {
  it('makes identical decisions from an identical seed and board', () => {
    // Same world state plus same RNG state gives the same decisions on any
    // machine, months later — that is what makes a save reload into the same
    // fight. `findPath` is deterministic by construction, `visibleEnemies` is
    // totally ordered, and every draw goes through the seeded PCG32.
    const first = chase(DIVIDED_ROOM, 'replay', 16);
    const second = chase(DIVIDED_ROOM, 'replay', 16);
    const third = chase(DIVIDED_ROOM, 'replay', 16);

    expect(second).toEqual(first);
    expect(third).toEqual(first);
    expect(first.length).toBeGreaterThan(1);
  });

  it('keeps the route stable even when the seed changes', () => {
    // Pathing itself must not depend on the stream at all — a monster whose
    // ROUTE moved with the seed would mean the open set was being iterated
    // somewhere. Only the target-keep roll and the kiter's sidestep flip are
    // allowed to be random, and neither applies to a lone target on open ground.
    const alpha = chase(DIVIDED_ROOM, 'seed-alpha', 16).map((entry) => entry.at);
    const beta = chase(DIVIDED_ROOM, 'seed-beta', 16).map((entry) => entry.at);

    expect(beta).toEqual(alpha);
    expect(alpha.length).toBeGreaterThan(1);
  });
});
