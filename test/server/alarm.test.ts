// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// The rule under test is ported from t-engine4 game/modules/tome/class/NPC.lua:342-367.
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

import { describe, expect, it } from 'vitest';

import { WATCHMAN } from '../../src/server/content/classes.ts';
import { DELVES } from '../../src/server/content/delve.ts';
import { PURSUIT_TURNS, raiseAlarm } from '../../src/server/ai/alarm.ts';
import { AiProfile, isHostile, isMonster } from '../../src/server/engine/actor.ts';
import { createTurnEngine } from '../../src/server/turn-engine.ts';
import { SITES, createRealms } from '../../src/server/world/realms.ts';
import { createWorld } from '../../src/server/world/world.ts';
import { chebyshev } from '../../src/shared/coords.ts';
import { blocksSightAt, canWalk } from '../../src/shared/level.ts';
import { circleCells } from '../../src/shared/mapgen/fovcircle.ts';
import { TileCode } from '../../src/shared/protocol.ts';
import { hasLineOfSight } from '../../src/shared/sight.ts';
import type { EngineActor, MonsterActor } from '../../src/server/engine/actor.ts';
import type { World } from '../../src/server/world/world.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * HURT ONE OF THEM AND THE ONES THAT SAW IT COME FOR YOU.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Upstream walks the VICTIM's field of view — `self.fov.actors_dist` in
 * NPC.lua:342-367 — so the friends who react are the ones who can see the body
 * that got hit, not the ones who can see the attacker. That distinction is the
 * entire mechanic: a monster round a corner with no line to the shooter is
 * exactly the monster that used to stand still while its friend burned.
 *
 * ═══ A REAL WORLD, NOT A HAND-BUILT CTX ═══
 * `raiseAlarm` reads `world.allActors()` and each watcher's `fieldOfView`
 * against real tiles (it was `hasLineOfSight` and a Chebyshev square). A fixture
 * that stubbed either would be testing the stub — and sight is half the rule,
 * so it is the half that must be real.
 */

/** A room with a wall down the middle at x = 5, and a doorway at y = 1. */
function splitRoom(): World {
  const world = createWorld('alarm');
  const level = world.level;
  level.tiles.fill(TileCode.FLOOR);
  for (let y = 0; y < level.h; y += 1) {
    if (y === 1) continue; // the doorway
    level.tiles[y * level.w + 5] = TileCode.WALL;
  }
  return world;
}

function husk(world: World, id: string, x: number, y: number): MonsterActor {
  const monster = world.addMonster(id, {
    name: `Husk ${id}`,
    sprite: 'enemy_index_husk_s',
    x,
    y,
    profile: AiProfile.MeleeChaser,
  });
  // `addMonster` shuffles to the nearest free tile, which is right for authored
  // encounters and wrong for a test whose whole subject is who can see whom.
  monster.x = x;
  monster.y = y;
  // NARROWED RATHER THAN CAST. `addMonster` is typed to the union, and every
  // assertion below reads `ai`, which only a monster has.
  if (!isMonster(monster)) throw new Error('test fixture: addMonster did not make a monster');
  return monster;
}

function detective(world: World, id: string, x: number, y: number) {
  const body = world.addPlayer(id, 'Dalt', {
    sprite: WATCHMAN.sprite,
    maxHp: WATCHMAN.maxHp,
    hpRegen: WATCHMAN.hpRegen,
    combat: WATCHMAN.combat,
    classId: WATCHMAN.id,
  });
  body.x = x;
  body.y = y;
  return body;
}

describe('a wounded monster tells whoever watched it happen', () => {
  it('takes the attacker as its target even with no line to them', () => {
    /**
     * Upstream's `setTarget(src)` carries NO visibility test — this is the half
     * that answers damage from somewhere a body cannot see, which is a shot from
     * beyond its `aggroRange` or a bleed ticking after the shooter has gone.
     */
    const world = splitRoom();
    const victim = husk(world, 'm_a', 2, 5);
    const shooter = detective(world, 'actor_p', 8, 5);
    expect(victim.ai.targetId, 'the fixture starts with a target').toBeNull();

    const roused = raiseAlarm(world, victim, shooter);

    expect(roused).toEqual([victim.id]);
    expect(victim.ai.targetId).toBe(shooter.id);
    // AND WHERE TO GO. A target with no remembered tile is worth almost nothing
    // — that is why this could not have been built before pursuit memory.
    expect(victim.ai.lastSeen).toEqual({ x: 8, y: 5 });
    expect(victim.ai.unseenTurns).toBe(0);
  });

  it('rouses a friend who can see the VICTIM but not the attacker', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE HEADLINE, AND THE ONE THAT WOULD HAVE BEEN EASY TO FAKE.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * The witness is on the victim's side of the wall, so it has a clear line to
     * the victim and NONE to the shooter. A version that walked the attacker's
     * field of view instead of the victim's would leave this husk asleep, and it
     * is the only arrangement that tells the two implementations apart. A test
     * with everybody in one open room passes against both.
     */
    const world = splitRoom();
    const victim = husk(world, 'm_a', 2, 5);
    const witness = husk(world, 'm_b', 3, 6);
    const shooter = detective(world, 'actor_p', 8, 5);

    const roused = raiseAlarm(world, victim, shooter);

    expect(roused).toContain(witness.id);
    expect(witness.ai.targetId).toBe(shooter.id);
    expect(witness.ai.lastSeen).toEqual({ x: 8, y: 5 });
  });

  it('leaves a friend who could not see it happen alone', () => {
    // Behind the wall, on the shooter's side, with no line to the victim. It
    // heard nothing, so it knows nothing — the counterplay to the whole
    // mechanic, and what stops one shot waking a floor.
    const world = splitRoom();
    const victim = husk(world, 'm_a', 2, 5);
    const deaf = husk(world, 'm_c', 8, 8);
    const shooter = detective(world, 'actor_p', 8, 5);

    const roused = raiseAlarm(world, victim, shooter);

    expect(roused).not.toContain(deaf.id);
    expect(deaf.ai.targetId).toBeNull();
    expect(deaf.ai.lastSeen).toBeNull();
  });

  it('does not peel a monster off the target it already has', () => {
    /**
     * Upstream guards its own acquisition with `not self.ai_target.actor` and
     * this keeps it for every body it touches. Without the guard, one player
     * hitting a pack would pull the whole pack off whoever they were already
     * engaged with — which is the opposite of the pressure this adds, and it
     * would make a second player's contribution to a fight actively harmful.
     */
    const world = splitRoom();
    const victim = husk(world, 'm_a', 2, 5);
    const busy = husk(world, 'm_b', 3, 6);
    const shooter = detective(world, 'actor_p', 8, 5);
    const friend = detective(world, 'actor_q', 1, 7);
    busy.ai.targetId = friend.id;

    const roused = raiseAlarm(world, victim, shooter);

    expect(roused).not.toContain(busy.id);
    expect(busy.ai.targetId, 'a wounded friend pulled it off its own fight').toBe(friend.id);
  });

  it('does not rouse a friend standing further off than it notices things', () => {
    // Bounded by the WATCHER's own `aggroRange`, because that is this game's
    // answer to "how far does this creature notice things" and a second radius
    // would be a second answer to it.
    const world = splitRoom();
    const victim = husk(world, 'm_a', 2, 5);
    const distant = husk(world, 'm_b', 2, 6);
    const shooter = detective(world, 'actor_p', 8, 5);
    distant.ai.aggroRange = 0;

    expect(raiseAlarm(world, victim, shooter)).not.toContain(distant.id);
    expect(distant.ai.targetId).toBeNull();
  });

  it('says nothing on behalf of a corpse, or against one', () => {
    const world = splitRoom();
    const victim = husk(world, 'm_a', 2, 5);
    const witness = husk(world, 'm_b', 3, 6);
    const shooter = detective(world, 'actor_p', 8, 5);

    // A DEAD ATTACKER. An orb is two or three game turns in the air and its
    // shooter can be a corpse by the time it lands; sending a pack after a body
    // that is no longer standing is worse than sending them nowhere.
    shooter.alive = false;
    expect(raiseAlarm(world, victim, shooter)).toEqual([]);
    expect(witness.ai.targetId).toBeNull();

    // A DEAD VICTIM raises nothing either — `die`'s call for help is upstream's
    // separate path (NPC.lua:372-391) and is not what this function is.
    shooter.alive = true;
    victim.alive = false;
    expect(raiseAlarm(world, victim, shooter)).toEqual([]);
  });

  it('ignores a body hurting itself', () => {
    // Upstream's `src ~= self`. Reflected damage and a self-inflicted blast both
    // reach here, and a monster that made itself its own target would stand
    // still forever chasing its own tile.
    const world = splitRoom();
    const victim = husk(world, 'm_a', 2, 5);
    expect(raiseAlarm(world, victim, victim)).toEqual([]);
    expect(victim.ai.targetId).toBeNull();
  });

  it('never rouses one monster against another', () => {
    // `isHostile` on both halves: a friend of the victim AND an enemy of
    // whoever did it. A husk clipped by another husk's blast must not start a
    // civil war, which is what a single-sided check would produce.
    const world = splitRoom();
    const victim = husk(world, 'm_a', 2, 5);
    const witness = husk(world, 'm_b', 3, 6);
    const clumsy = husk(world, 'm_d', 2, 4);

    expect(raiseAlarm(world, victim, clumsy)).toEqual([]);
    expect(victim.ai.targetId).toBeNull();
    expect(witness.ai.targetId).toBeNull();
  });

  it('is bounded by the same counter a sighting is', () => {
    /**
     * `scheduler.ts` documents an idle fixed point: a monster that spends energy
     * forever means `pump` never returns idle. The hunt this starts ends the
     * same way every other one does — `unseenTurns` past `PURSUIT_TURNS` — and
     * this pins that it starts the counter at zero rather than at some second
     * budget of its own.
     */
    const world = splitRoom();
    const victim = husk(world, 'm_a', 2, 5);
    const shooter = detective(world, 'actor_p', 8, 5);
    raiseAlarm(world, victim, shooter);
    expect(victim.ai.unseenTurns).toBe(0);
    expect(PURSUIT_TURNS).toBeGreaterThan(0);
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHO SAW IT IS WHOSE SHADOWCAST REACHES THE VICTIM — exactly those friends.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The watcher's own field of view, the `fov_circle` shadowcast with
 * `block_sight` out to its `aggroRange` (`calc_default_fov`, the geometry of
 * `calc_circle`): the same eyes `visibleEnemies` looks through. The oracle here
 * is `circleCells` with `blocksSightAt`, asked directly, and the old rule (a
 * Chebyshev square and a Bresenham line) is asked beside it so each fixture is
 * shown to tell the two apart.
 */
describe('the friends an alarm rouses are the ones whose shadowcast reaches the victim', () => {
  function oldRuleSees(world: World, watcher: MonsterActor, at: EngineActor): boolean {
    return (
      chebyshev(watcher, at) <= watcher.ai.aggroRange && hasLineOfSight(world.level, watcher, at)
    );
  }

  function shadowReaches(world: World, watcher: MonsterActor, at: EngineActor): boolean {
    const level = world.level;
    return circleCells(level, watcher.x, watcher.y, watcher.ai.aggroRange, (x, y) =>
      blocksSightAt(level, x, y),
    ).some((cell) => cell.x === at.x && cell.y === at.y);
  }

  it('rouses the one past a pillar and not the corner or the threaded gap', () => {
    const world = createWorld('alarm-shadowcast');
    const level = world.level;
    level.tiles.fill(TileCode.FLOOR);
    // A pillar beside the first watcher; two walls either side of the second
    // watcher's diagonal step.
    for (const [x, y] of [
      [13, 16],
      [13, 17],
      [13, 19],
    ] as const) {
      level.tiles[y * level.w + x] = TileCode.WALL;
    }
    const victim = husk(world, 'm_v', 15, 15);
    const pillar = husk(world, 'm_pillar', 12, 16); // victim at (3,-1), pillar at (1,0)
    const gap = husk(world, 'm_gap', 12, 19); // victim at (3,-4), walls at (1,-2) and (1,0)
    const corner = husk(world, 'm_corner', 7, 7); // victim at (8,8): Chebyshev 8, rounds to 11
    const near = husk(world, 'm_near', 17, 15);
    const shooter = detective(world, 'actor_p', 25, 25);

    expect(oldRuleSees(world, pillar, victim), 'fixture: the old rule saw past the pillar').toBe(
      false,
    );
    expect(oldRuleSees(world, gap, victim), 'fixture: the old rule missed the gap').toBe(true);
    expect(oldRuleSees(world, corner, victim), 'fixture: the old rule missed the corner').toBe(
      true,
    );
    expect(oldRuleSees(world, near, victim)).toBe(true);

    const roused = raiseAlarm(world, victim, shooter).filter((id) => id !== victim.id);

    expect([...roused].sort()).toEqual(['m_near', 'm_pillar']);
    expect(gap.ai.targetId).toBeNull();
    expect(corner.ai.targetId).toBeNull();
  });

  it('matches the oracle for every friend of every victim on generated floors', () => {
    const sites = [...DELVES.keys()].filter((id) => SITES.get(id) !== undefined).slice(0, 4);
    expect(sites.length, 'fixture: fewer than four delves').toBe(4);
    let asked = 0;
    let roused = 0;
    let parted = 0;

    for (const id of sites) {
      const site = SITES.get(id);
      if (site === undefined) continue;
      const seed = `alarm-shadowcast:${id}`;
      const realms = createRealms({ seed, engineFor: (world) => createTurnEngine({ world }) });
      const world = realms.open(site, 'party').world;
      const level = world.level;
      const monsters = world.allActors().filter(isMonster);
      // The shooter's tile never matters to who saw the victim; it only has to
      // be a body the whole floor is hostile to. The first free floor tile.
      let at = { x: 0, y: 0 };
      for (let i = 0; i < level.w * level.h; i += 1) {
        const x = i % level.w;
        const y = Math.floor(i / level.w);
        if (canWalk(level, x, y) && world.actorAt(x, y) === undefined) {
          at = { x, y };
          break;
        }
      }
      const shooter = detective(world, 'actor_p', at.x, at.y);

      for (const victim of monsters.slice(0, 12)) {
        for (const m of monsters) {
          m.ai.targetId = null;
          m.ai.lastSeen = null;
        }
        const expected = monsters
          .filter(
            (o) =>
              o.alive &&
              o.id !== victim.id &&
              !isHostile(o, victim) &&
              isHostile(o, shooter) &&
              shadowReaches(world, o, victim),
          )
          .map((o) => o.id)
          .sort();
        for (const o of monsters) {
          if (o.id === victim.id || !o.alive) continue;
          asked += 1;
          if (oldRuleSees(world, o, victim) !== shadowReaches(world, o, victim)) parted += 1;
        }

        const got = raiseAlarm(world, victim, shooter)
          .filter((rid) => rid !== victim.id)
          .sort();
        expect(got, `${id}: victim ${victim.id}`).toEqual(expected);
        roused += got.length;
      }
    }

    expect(asked, 'fixture: nobody was asked').toBeGreaterThan(100);
    expect(roused, 'fixture: nobody was ever roused').toBeGreaterThan(0);
    expect(parted, 'fixture: the old and new rules never disagreed').toBeGreaterThan(0);
  });
});
