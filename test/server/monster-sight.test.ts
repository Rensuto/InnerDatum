// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// The rule under test is ported from t-engine4 game/modules/tome/class/NPC.lua:99-105
// and game/engines/default/engine/interface/ActorFOV.lua:49-130.
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

import { describe, expect, it } from 'vitest';

import { DELVES } from '../../src/server/content/delve.ts';
import { AiProfile, HOLD_INTENT, isMonster } from '../../src/server/engine/actor.ts';
import { createBarrier } from '../../src/server/engine/barrier.ts';
import { rangeRefusal } from '../../src/server/engine/combat.ts';
import {
  anyContact,
  pump,
  submitIntent,
  visibleEnemies,
} from '../../src/server/engine/scheduler.ts';
import { createTurnEngine } from '../../src/server/turn-engine.ts';
import { SITES, createRealms } from '../../src/server/world/realms.ts';
import { createWorld } from '../../src/server/world/world.ts';
import { chebyshev } from '../../src/shared/coords.ts';
import { tileDistance } from '../../src/shared/distance.ts';
import { blocksSightAt, canWalk } from '../../src/shared/level.ts';
import { circleCells } from '../../src/shared/mapgen/fovcircle.ts';
import { ActorKind, TileCode } from '../../src/shared/protocol.ts';
import { hasLineOfSight } from '../../src/shared/sight.ts';
import type { EngineActor, MonsterActor } from '../../src/server/engine/actor.ts';
import type { SweepStep } from '../../src/server/engine/scheduler.ts';
import type { World } from '../../src/server/world/world.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A MONSTER SEES WHAT ToME's FIELD OF VIEW REACHES, AND NOTHING ELSE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `NPC:doFOV` is `computeFOV(self.sight or 10, "block_sight", nil, nil, nil,
 * true)`, whose cached branch is `core.fov.calc_default_fov`: the same
 * `fov_circle` as `core.fov.calc_circle`, from the monster's tile. The rounded
 * disc, shadowcast from the whole tile (`calcCircle`,
 * shared/mapgen/fovcircle.ts). Ours was a Chebyshev square of `aggroRange`
 * plus one Bresenham line from centre to centre, and the two disagree three
 * ways, each pinned below with the old rule asked alongside so the fixture is
 * shown to tell them apart:
 *
 *   - THE CORNERS. (8,8) is inside a Chebyshev 8 and rounds to 11.
 *   - PAST A PILLAR BESIDE IT. The line from its centre hits the pillar; the
 *     shadowcast from the whole tile clears it.
 *   - THREADED BETWEEN TWO WALLS. The line slips through a diagonal gap the
 *     shadowcast calls closed.
 *
 * `visibleEnemies`, `anyContact` and `raiseAlarm` must answer the same
 * question (the L4 lockstep), so the first is asked of generated floors
 * against the second; alarm.test.ts holds the third.
 */

const HUSK_SPRITE = 'enemy_index_husk_s';

/** The 30x30 test level, all floor, with the walls a case names. */
function room(seed: string, walls: readonly (readonly [number, number])[] = []): World {
  const world = createWorld(seed);
  const level = world.level;
  level.tiles.fill(TileCode.FLOOR);
  for (const [x, y] of walls) level.tiles[y * level.w + x] = TileCode.WALL;
  return world;
}

function monster(
  world: World,
  id: string,
  at: { readonly x: number; readonly y: number },
  profile: AiProfile = AiProfile.MeleeChaser,
  aggroRange = 8,
): MonsterActor {
  const body = world.addMonster(id, {
    name: `Index ${id}`,
    sprite: HUSK_SPRITE,
    x: at.x,
    y: at.y,
    profile,
    aggroRange,
  });
  // `addMonster` shuffles to a free tile; the case is about exactly this one.
  body.x = at.x;
  body.y = at.y;
  if (!isMonster(body)) throw new Error('test fixture: addMonster did not make a monster');
  return body;
}

function player(world: World, id: string, at: { readonly x: number; readonly y: number }) {
  const body = world.addPlayer(id, id);
  body.maxHp = 100_000;
  body.hp = 100_000;
  body.x = at.x;
  body.y = at.y;
  return body;
}

/** What `visibleEnemies` returns, by id. */
function seenBy(world: World, self: MonsterActor): readonly string[] {
  return visibleEnemies(self, world, world.allActors()).map((a) => a.id);
}

/** The rule this increment replaced, asked alongside to show a case tells them apart. */
function oldRuleSees(world: World, self: MonsterActor, other: EngineActor): boolean {
  return chebyshev(self, other) <= self.ai.aggroRange && hasLineOfSight(world.level, self, other);
}

describe('a monster sees through ToME`s shadowcast, not a square and a line', () => {
  it('does not see a player behind a wall, which the old line did not either', () => {
    const wall = Array.from({ length: 11 }, (_u, i) => [13, 3 + i] as const);
    const world = room('sight-wall', wall);
    const husk = monster(world, 'm1', { x: 10, y: 8 });
    const hidden = player(world, 'p1', { x: 16, y: 8 });

    expect(chebyshev(husk, hidden), 'fixture: inside the old square').toBeLessThanOrEqual(8);
    expect(hasLineOfSight(world.level, husk, hidden), 'fixture: the old line was blocked').toBe(
      false,
    );
    expect(seenBy(world, husk)).toEqual([]);
    expect(anyContact(world, world.allActors())).toBe(false);
  });

  it('sees past a pillar beside it, where the line from its centre was blocked', () => {
    // The pillar is on the monster's east side; the player is a knight's move
    // and one beyond it. The line from the centre runs (1,0) first.
    const world = room('sight-pillar', [[11, 8]]);
    const husk = monster(world, 'm1', { x: 10, y: 8 });
    const past = player(world, 'p1', { x: 13, y: 7 });

    expect(oldRuleSees(world, husk, past), 'fixture: the old rule saw it').toBe(false);
    expect(seenBy(world, husk)).toEqual(['p1']);
    expect(anyContact(world, world.allActors())).toBe(true);
  });

  it('does not see through a diagonal gap its old line threaded', () => {
    // Walls at (1,-2) and (1,0) from the monster: the line to (3,-4) steps
    // through (1,-1) between them. The shadowcast calls that gap closed.
    const world = room('sight-gap', [
      [11, 6],
      [11, 8],
    ]);
    const husk = monster(world, 'm1', { x: 10, y: 8 });
    const threaded = player(world, 'p1', { x: 13, y: 4 });

    expect(oldRuleSees(world, husk, threaded), 'fixture: the old rule saw it').toBe(true);
    expect(seenBy(world, husk)).toEqual([]);
    expect(anyContact(world, world.allActors())).toBe(false);
  });

  it('sees the rounded disc, not the corners of the old square', () => {
    // Open ground, aggroRange 8. All three stood inside the old square on a
    // clear line. (8,2) rounds to 8; (8,3) to 9; (8,8) to 11.
    const world = room('sight-disc');
    const husk = monster(world, 'm1', { x: 10, y: 10 });
    const rim = player(world, 'p_rim', { x: 18, y: 12 });
    const past = player(world, 'p_past', { x: 18, y: 13 });
    const corner = player(world, 'p_corner', { x: 18, y: 18 });
    for (const body of [rim, past, corner]) {
      expect(oldRuleSees(world, husk, body), `fixture: the old rule saw ${body.id}`).toBe(true);
    }
    expect([rim, past, corner].map((b) => tileDistance(husk, b))).toEqual([8, 9, 11]);

    expect(seenBy(world, husk)).toEqual(['p_rim']);

    // And the clock: the corner alone arms nothing now.
    rim.alive = false;
    past.alive = false;
    expect(anyContact(world, world.allActors())).toBe(false);
  });

  it('does not see one tile past its radius along a row, where the grid wraps', () => {
    // `fieldOfView` keeps a (2r+1)-square grid flattened row by row, so the
    // offset (r+1, 0) indexes the cell (-r, +1) on the next row. In open
    // ground that cell is seen. The disc pre-check is what refuses the first
    // before the index is ever taken (the note on `fieldOfView`).
    const world = room('sight-wrap');
    const husk = monster(world, 'm1', { x: 10, y: 10 });
    const r = husk.ai.aggroRange;
    const past = player(world, 'p_past', { x: 10 + r + 1, y: 10 });
    const wrapped = player(world, 'p_wrapped', { x: 10 - r, y: 11 });

    expect(tileDistance(husk, past), 'fixture: not one past the radius').toBe(r + 1);
    expect(tileDistance(husk, wrapped), 'fixture: the wrapped cell is not in the disc').toBe(r);
    // The wrapped cell is seen, so an index that reached it would see p_past too.
    expect(seenBy(world, husk)).toEqual(['p_wrapped']);
  });

  it('puts the nearest first by ToME`s rounded distance, then by id', () => {
    /**
     * `fov.actors_dist` is sorted on `__sqdist`, the ROUNDED distance squared
     * (`map_default_seen`, src/fov.c). (2,1) and (2,0) both round to 2, (4,0)
     * and (3,3) both to 4, so each pair is a tie and the id decides.
     *
     * Sorting on the straight line puts p2 (2.0) before p1 (2.24). Sorting on
     * Chebyshev puts p4 (3) before p3 (4). The order below is neither.
     */
    const world = room('sight-order');
    const husk = monster(world, 'm1', { x: 10, y: 10 });
    player(world, 'p4', { x: 13, y: 13 });
    player(world, 'p3', { x: 14, y: 10 });
    player(world, 'p2', { x: 12, y: 10 });
    player(world, 'p1', { x: 12, y: 11 });

    expect(seenBy(world, husk)).toEqual(['p1', 'p2', 'p3', 'p4']);
  });
});

describe('the engagement clock and the AI look through the same eyes (L4)', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════
   * `anyContact` IS TRUE EXACTLY WHEN SOME MONSTER'S `visibleEnemies` HOLDS
   * A PLAYER — on real generated floors, one player at a time.
   * ═══════════════════════════════════════════════════════════════════════
   *
   * The player is stood on every open tile round a few monsters on each floor,
   * which is where the old and new rules part company. A monster that sees you
   * and a clock that does not is a monster acting in a world whose engagement
   * lapsed; the reverse is a floor held in combat by nobody.
   *
   * THE FIXTURE MUST DISCRIMINATE. The count of placements where the old rule's
   * answer to "does anything see this player" differs from the new rule's is
   * asserted above zero, so a `visibleEnemies` left on the old geometry cannot
   * pass this: on those placements it and `anyContact` would disagree.
   */
  it('agrees on every placement over four generated floors', () => {
    const sites = [...DELVES.keys()].filter((id) => SITES.get(id) !== undefined).slice(0, 4);
    expect(sites.length, 'fixture: fewer than four delves').toBe(4);

    let placements = 0;
    let seen = 0;
    let parted = 0;

    for (const id of sites) {
      const site = SITES.get(id);
      if (site === undefined) continue;
      const seed = `sight-lockstep:${id}`;
      const realms = createRealms({ seed, engineFor: (world) => createTurnEngine({ world }) });
      const world = realms.open(site, 'party').world;
      const level = world.level;
      const monsters = world.allActors().filter(isMonster);
      const body = player(world, 'p1', { x: 0, y: 0 });

      const tried = new Set<number>();
      for (const near of monsters.slice(0, 3)) {
        const r = near.ai.aggroRange + 1;
        for (let dy = -r; dy <= r; dy += 1) {
          for (let dx = -r; dx <= r; dx += 1) {
            const x = near.x + dx;
            const y = near.y + dy;
            if (!canWalk(level, x, y) || tried.has(y * level.w + x)) continue;
            if (monsters.some((m) => m.alive && m.x === x && m.y === y)) continue;
            tried.add(y * level.w + x);
            body.x = x;
            body.y = y;

            const actors = world.allActors();
            const contact = anyContact(world, actors);
            let anySees = false;
            for (const m of monsters) {
              if (!m.alive) continue;
              const list = visibleEnemies(m, world, actors);
              // Only players are hostile on a delve floor, so non-empty and
              // "holds a player" are the same question here.
              for (const other of list) expect(other.kind).toBe(ActorKind.Player);
              if (list.length > 0) anySees = true;
            }
            expect(contact, `${id}: (${String(x)},${String(y)})`).toBe(anySees);

            const oldSees = monsters.some((m) => m.alive && oldRuleSees(world, m, body));
            placements += 1;
            if (contact) seen += 1;
            if (oldSees !== contact) parted += 1;
          }
        }
      }
    }

    expect(placements, 'fixture: no placements').toBeGreaterThan(500);
    expect(seen, 'fixture: nothing ever saw the player').toBeGreaterThan(0);
    expect(seen, 'fixture: everything always saw the player').toBeLessThan(placements);
    expect(parted, 'fixture: the old and new rules never disagreed').toBeGreaterThan(0);
  });

  it('matches libfov`s circle cell for cell, not a copy of it', () => {
    // `fieldOfView` is asked through `visibleEnemies`; the oracle is
    // `circleCells` with `blocksSightAt`, which is what `calc_circle` with
    // `block_sight` returns. A player on each reached tile is seen and on no
    // other tile in the square.
    const site = SITES.get([...DELVES.keys()][0] ?? '');
    expect(site, 'fixture: no delve').toBeDefined();
    if (site === undefined) return;
    const realms = createRealms({
      seed: 'sight-oracle',
      engineFor: (world) => createTurnEngine({ world }),
    });
    const world = realms.open(site, 'party').world;
    const level = world.level;
    const husk = world.allActors().filter(isMonster)[0];
    expect(husk, 'fixture: an empty floor').toBeDefined();
    if (husk === undefined) return;
    // Alone with the player, so nothing else is in the list.
    for (const other of world.allActors()) if (other !== husk) other.alive = false;
    const body = player(world, 'p1', { x: 0, y: 0 });

    const r = husk.ai.aggroRange;
    const reached = new Set(
      circleCells(level, husk.x, husk.y, r, (x, y) => blocksSightAt(level, x, y)).map(
        (c) => c.y * level.w + c.x,
      ),
    );
    let inside = 0;
    for (let dy = -r - 1; dy <= r + 1; dy += 1) {
      for (let dx = -r - 1; dx <= r + 1; dx += 1) {
        const x = husk.x + dx;
        const y = husk.y + dy;
        if (x < 0 || y < 0 || x >= level.w || y >= level.h || (dx === 0 && dy === 0)) continue;
        body.x = x;
        body.y = y;
        const expected = reached.has(y * level.w + x);
        if (expected) inside += 1;
        expect(seenBy(world, husk).length === 1, `(${String(dx)},${String(dy)})`).toBe(expected);
      }
    }
    expect(inside, 'fixture: the circle reached nothing').toBeGreaterThan(20);
  });
});

describe('a kiter that sees you round a pillar steps, rather than shooting the pillar', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════
   * SEEN IS NOT SHOOTABLE, AND THE AI HAS TO KNOW IT (`AiCtx.lineClear`).
   * ═══════════════════════════════════════════════════════════════════════
   *
   * The shadowcast sees past a pillar beside the kiter; `canAttack` still
   * refuses a shot whose Bresenham line hits the pillar. Without the guard the
   * kiter fired that shot, the scheduler refused it `no_los`, and the turn was
   * spent standing there, every turn the player stood still. Driven through
   * the real pump, so the context under test is the scheduler's own.
   */
  it('moves on its turn, and no shot is refused', () => {
    const world = room('kite-pillar', [[11, 8]]);
    const kiter = monster(world, 'm1', { x: 10, y: 8 }, AiProfile.RangedKiter, 9);
    const target = player(world, 'p1', { x: 15, y: 6 });

    // THE PRECONDITIONS, each one the state the guard exists for.
    expect(seenBy(world, kiter), 'fixture: the kiter does not see the player').toEqual(['p1']);
    expect(hasLineOfSight(world.level, kiter, target), 'fixture: the line is clear').toBe(false);
    expect(rangeRefusal(kiter, target), 'fixture: out of the kiter`s band').toBeNull();
    expect(tileDistance(kiter, target)).toBeGreaterThanOrEqual(kiter.ai.minRange);
    expect(tileDistance(kiter, target)).toBeLessThanOrEqual(kiter.ai.preferredRange);

    const barrier = createBarrier();
    const steps: SweepStep[] = [];
    for (let turn = 0; turn < 3 && !steps.some((s) => s.id === kiter.id); turn += 1) {
      submitIntent(world, barrier, target.id, HOLD_INTENT);
      for (const event of pump(world, { nowMs: turn, barrier }).events) {
        if (event.t === 'sweep') steps.push(...event.steps);
      }
    }
    const first = steps.find((s) => s.id === kiter.id);
    expect(first, 'the kiter never acted').toBeDefined();
    expect(first?.t, `the kiter's first act was ${JSON.stringify(first)}`).toBe('move');
    expect(steps.filter((s) => s.t === 'blocked')).toEqual([]);
  });

  /**
   * The kiter's own sweep steps, one per act, through the real pump while the
   * player holds. Stops after `acts` of them or `turns` player turns.
   */
  function kiterActs(
    world: World,
    kiter: MonsterActor,
    playerId: string,
    acts: number,
    turns = 12,
  ): SweepStep[] {
    const barrier = createBarrier();
    const mine: SweepStep[] = [];
    for (let turn = 0; turn < turns && mine.length < acts; turn += 1) {
      submitIntent(world, barrier, playerId, HOLD_INTENT);
      for (const event of pump(world, { nowMs: turn, barrier }).events) {
        if (event.t !== 'sweep') continue;
        for (const s of event.steps) {
          if (s.t === 'blocked') throw new Error(`refused: ${JSON.stringify(s)}`);
          if (s.id === kiter.id) mine.push(s);
        }
      }
    }
    return mine.slice(0, acts);
  }

  /**
   * THE EDGE THE GUARD USED TO HOLD ON: the player at EXACTLY `minRange`, seen
   * past the pillar, the line from the kiter's centre on the pillar. Every step
   * toward the player lands inside the dead zone, so `advance` alone held here
   * for as long as the player stood still.
   *
   * The neighbours, in `util.adjacentDirs` order (sw s se w e nw n ne), with
   * the rounded distance to the player and the line from there:
   *
   *   sw (9,9)   4, blocked      e  (11,8)  the pillar
   *   s  (10,9)  4, blocked      nw (9,7)   4, clear
   *   se (11,9)  3, clear        n  (10,7)  3, clear
   *   w  (9,8)   4, clear        ne (11,7)  2, the dead zone
   *
   * The rule takes the clear in-band tile nearest `preferredRange` (5), the
   * earlier direction on a tie: 4 beats 3, and w comes before nw. So (9,8).
   */
  it('at exactly minRange it sidesteps to the clear tile nearest preferredRange, then shoots', () => {
    const world = room('kite-edge', [[11, 8]]);
    const kiter = monster(world, 'm1', { x: 10, y: 8 }, AiProfile.RangedKiter, 9);
    const target = player(world, 'p1', { x: 13, y: 7 });

    expect(seenBy(world, kiter), 'fixture: the kiter does not see the player').toEqual(['p1']);
    expect(hasLineOfSight(world.level, kiter, target), 'fixture: the line is clear').toBe(false);
    expect(tileDistance(kiter, target), 'fixture: not at minRange').toBe(kiter.ai.minRange);
    expect(kiter.talentIn, 'fixture: a talentIn kiter may hold on its roll').toBeUndefined();

    const [step, shot] = kiterActs(world, kiter, target.id, 2);

    expect(step).toEqual({ t: 'move', id: 'm1', from: { x: 10, y: 8 }, to: { x: 9, y: 8 } });
    expect(tileDistance(kiter, target)).toBe(4);
    expect(hasLineOfSight(world.level, kiter, target)).toBe(true);
    expect(shot?.t, `the kiter's next act was ${JSON.stringify(shot)}`).toBe('attack');
    expect(shot?.t === 'attack' ? shot.targetId : undefined).toBe('p1');
  });

  /**
   * NEVER A SIDESTEP OUT OF SIGHT, or it paces (`AiCtx.seesFrom`). The review's
   * room: walls at (10,9) and (9,11), the kiter at (10,10), the player holding
   * at (7,12). The sidestep's first version asked only for a clear line from
   * the new tile; (11,9) has one and loses the player to the wall at (10,9),
   * so the kiter stepped there, lost its target, walked back to `lastSeen` — the
   * tile it had left — and repeated that for all twelve acts without a shot.
   */
  it('never sidesteps to a tile it cannot see its target from, so it does not pace', () => {
    const world = room('kite-pace', [
      [10, 9],
      [9, 11],
    ]);
    const kiter = monster(world, 'm1', { x: 10, y: 10 }, AiProfile.RangedKiter, 9);
    const target = player(world, 'p1', { x: 7, y: 12 });
    expect(seenBy(world, kiter), 'fixture: the kiter does not see the player').toEqual(['p1']);
    expect(kiter.talentIn, 'fixture: a talentIn kiter may hold on its roll').toBeUndefined();

    const acts = kiterActs(world, kiter, target.id, 12);
    expect(acts.length, 'the kiter stopped acting').toBe(12);
    expect(
      acts.some((s) => s.t === 'attack'),
      `twelve acts and no shot: ${acts.map((s) => (s.t === 'move' ? `${String(s.to.x)},${String(s.to.y)}` : s.t)).join(' ')}`,
    ).toBe(true);
  });

  /**
   * THE DEAD ZONE IS KEPT WHEN THERE IS NO SIDESTEP. The kiter is walled in on
   * four sides; of the tiles left, sw and s have no line and ne is inside
   * `minRange`. Still seen: the shadowcast reaches the player through the ne
   * gap. So the sidestep finds nothing, `advance` has only ne to offer, and
   * the kiter HOLDS rather than stepping to 2 from a body it may not shoot at 2.
   */
  it('boxed in at minRange, it holds rather than step into its own dead zone', () => {
    const world = room('kite-boxed', [
      [11, 8],
      [11, 9],
      [9, 8],
      [9, 7],
      [10, 7],
    ]);
    const kiter = monster(world, 'm1', { x: 10, y: 8 }, AiProfile.RangedKiter, 9);
    const target = player(world, 'p1', { x: 13, y: 7 });

    expect(seenBy(world, kiter), 'fixture: the kiter does not see the player').toEqual(['p1']);
    expect(hasLineOfSight(world.level, kiter, target), 'fixture: the line is clear').toBe(false);
    expect(tileDistance(kiter, target), 'fixture: not at minRange').toBe(kiter.ai.minRange);
    expect(canWalk(world.level, 11, 7), 'fixture: the dead-zone step is walled').toBe(true);
    expect(tileDistance({ x: 11, y: 7 }, target), 'fixture: ne is not in the dead zone').toBe(2);

    const acts = kiterActs(world, kiter, target.id, 3);

    expect(acts.map((s) => s.t)).toEqual(['hold', 'hold', 'hold']);
    expect({ x: kiter.x, y: kiter.y }).toEqual({ x: 10, y: 8 });
  });

  /**
   * ═══ THE ROLL COMES FIRST, AND THE LINE IS ASKED ONLY ON A WIN ═══
   * `dumb_talented_simple` rolls `talent_in` (engine/ai/talented.lua:122)
   * before `dumb_talented` asks `canProject` (:46-52). A talentIn kiter with a
   * blocked line therefore takes `ai.fire.chance` whether or not it can shoot.
   * On a lost roll it holds and never asks the line; on a won roll it asks,
   * finds it blocked, and sidesteps.
   *
   * The draw is forced by wrapping the world's own generator: every other
   * label passes through to it. The log interleaves draws with the kiter's
   * line questions, so the order is read, not inferred.
   */
  it('takes the talentIn draw before it asks the line, and holds on a lost roll', () => {
    const run = (roll: number) => {
      const world = room('kite-roll', [[11, 8]]);
      const kiter = monster(world, 'm1', { x: 10, y: 8 }, AiProfile.RangedKiter, 9);
      kiter.talentIn = 2;
      const target = player(world, 'p1', { x: 13, y: 7 });

      const log: string[] = [];
      const draw = world.rng.int.bind(world.rng);
      world.rng.int = (label, lo, hi) => {
        log.push(`draw ${label}`);
        return label === 'ai.fire.chance' ? roll : draw(label, lo, hi);
      };
      const line = world.lineClearFor.bind(world);
      world.lineClearFor = (actor, to) => {
        if (actor.id === kiter.id) log.push(`line from ${String(actor.x)},${String(actor.y)}`);
        return line(actor, to);
      };

      const [act] = kiterActs(world, kiter, target.id, 1);
      return { act, log };
    };

    const lost = run(2);
    expect(lost.log).toContain('draw ai.fire.chance');
    expect(lost.log.filter((entry) => entry.startsWith('line'))).toEqual([]);
    expect(lost.act).toEqual({ t: 'hold', id: 'm1' });

    const won = run(1);
    const drawn = won.log.indexOf('draw ai.fire.chance');
    const asked = won.log.indexOf('line from 10,8');
    expect(drawn, 'the roll was never taken').toBeGreaterThanOrEqual(0);
    expect(asked, 'the line was never asked').toBeGreaterThan(drawn);
    expect(won.act).toEqual({ t: 'move', id: 'm1', from: { x: 10, y: 8 }, to: { x: 9, y: 8 } });
  });

  /**
   * ON REAL FLOORS, every placement where a kiter sees a player in its band
   * past something its line hits. Each gets a fresh floor from the same seed
   * with the kiter alone, and the pump runs to the kiter's first guard fire
   * (its line asked from its own tile and refused, from inside `kite`). That
   * decision must not leave it inside `minRange`, and must rarely be a hold:
   * before the sidestep, on THIS test's metric — the first fire per placement —
   * advance alone held 90 of 628 on the wide census and 9 of 42 on the two
   * floors this census used before the crystals were rooted. (The review's 231 of 247 counts every fire while the party stands
   * still, a different metric.)
   */
  it('on generated floors it never steps inside minRange, and seldom holds', () => {
    // THE FIRST TWO DELVES A MOBILE KITER CAN ROLL IN. Since the crystals were
    // rooted (2026-09-23) the first two delves in the table hold only cairns,
    // and a census of them fired nothing.
    const sites = [...DELVES.entries()]
      .filter(
        ([id, spec]) =>
          SITES.get(id) !== undefined &&
          spec.roster.some((t) => t.profile === AiProfile.RangedKiter && t.neverMove !== true),
      )
      .map(([id]) => id)
      .slice(0, 2);
    expect(sites.length, 'fixture: fewer than two delves').toBe(2);
    const open = (seed: string, siteId: string): World => {
      const site = SITES.get(siteId);
      if (site === undefined) throw new Error(`no site ${siteId}`);
      const realms = createRealms({ seed, engineFor: (w) => createTurnEngine({ world: w }) });
      return realms.open(site, 'party').world;
    };

    let fired = 0;
    let held = 0;
    let inside = 0;
    for (const siteId of sites) {
      const seed = `kite-guard:${siteId}`;
      const probe = open(seed, siteId);
      const kiters = probe
        .allActors()
        .filter(isMonster)
        .filter((m) => m.alive && m.ai.profile === AiProfile.RangedKiter)
        // A ROOTED kiter has no sidestep to take: its guard fire is a hold by
        // design (`MonsterActor.neverMove`), and ai.test sweeps it separately.
        .filter((m) => m.neverMove !== true);

      for (const k of kiters) {
        const level = probe.level;
        const r = k.ai.preferredRange;
        const seen = new Set(
          circleCells(level, k.x, k.y, k.ai.aggroRange, (x, y) => blocksSightAt(level, x, y)).map(
            (c) => c.y * level.w + c.x,
          ),
        );
        const tiles: { x: number; y: number }[] = [];
        for (let dy = -r; dy <= r && tiles.length < 3; dy += 1) {
          for (let dx = -r; dx <= r && tiles.length < 3; dx += 1) {
            const t = { x: k.x + dx, y: k.y + dy };
            if (!canWalk(level, t.x, t.y) || probe.actorAt(t.x, t.y) !== undefined) continue;
            if (!seen.has(t.y * level.w + t.x) || hasLineOfSight(level, k, t)) continue;
            const d = tileDistance(k, t);
            if (d >= k.ai.minRange && d <= r) tiles.push(t);
          }
        }

        for (const t of tiles) {
          const world = open(seed, siteId);
          const kiter = world.getActor(k.id);
          if (kiter === undefined || !isMonster(kiter)) throw new Error('fixture: no kiter');
          for (const m of world.allActors()) if (m !== kiter && isMonster(m)) m.alive = false;
          const body = player(world, 'p1', t);

          let firedAt: { x: number; y: number } | undefined;
          const line = world.lineClearFor.bind(world);
          world.lineClearFor = (actor, to) => {
            const clear = line(actor, to);
            // The guard's own question: the kiter itself, from its own tile.
            if (actor === kiter && !clear && firedAt === undefined) {
              firedAt = { x: kiter.x, y: kiter.y };
            }
            return clear;
          };
          const barrier = createBarrier();
          for (let turn = 0; turn < 6 && firedAt === undefined; turn += 1) {
            submitIntent(world, barrier, body.id, HOLD_INTENT);
            pump(world, { nowMs: turn, barrier });
          }
          if (firedAt === undefined) continue;
          fired += 1;
          if (kiter.x === firedAt.x && kiter.y === firedAt.y) held += 1;
          if (tileDistance(kiter, body) < kiter.ai.minRange) inside += 1;
        }
      }
    }

    expect(fired, 'fixture: the guard never fired').toBeGreaterThan(20);
    expect(inside).toBe(0);
    expect(held, `${String(held)} of ${String(fired)} guard fires held`).toBeLessThan(fired / 10);
  });
});
